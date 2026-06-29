const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COLOR_RE = /^(?:rgb|rgba)\([0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?\)$/;
const ANGLE_RE = /^(-?(?:\d+(?:\.\d*)?|\.\d+))deg$/;
const DEPRECATED_KEYS = new Set(["ignore_window"]);
const BIND_OPTIONS = {
  bind: {},
  bindl: { locked: "true" },
  bindr: { release: "true" },
  binde: { repeating: "true" },
  bindm: { mouse: "true" }
};

function assign(key, value, lineNo) {
  return { kind: "assign", key, value, lineNo };
}

function block(name, lineNo, items) {
  return { kind: "block", name, lineNo, items };
}

export function stripComment(line) {
  let inQuote = null;
  let escaped = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inQuote = ch;
      continue;
    }
    if (ch === "#") {
      return line.slice(0, i);
    }
  }

  return line;
}

export function parseHyprlang(text) {
  const root = [];
  const stack = [{ name: "<root>", lineNo: 0, items: root }];
  const unknown = [];

  text.split(/\r?\n/).forEach((raw, index) => {
    const lineNo = index + 1;
    const line = stripComment(raw).trim();
    if (!line) {
      return;
    }

    if (line === "}") {
      if (stack.length === 1) {
        unknown.push(`line ${lineNo}: unmatched closing brace`);
        return;
      }
      const completed = stack.pop();
      stack[stack.length - 1].items.push(block(completed.name, completed.lineNo, completed.items));
      return;
    }

    if (line.endsWith("{")) {
      const name = line.slice(0, -1).trim();
      if (!name) {
        unknown.push(`line ${lineNo}: empty block name`);
        return;
      }
      stack.push({ name, lineNo, items: [] });
      return;
    }

    if (line.includes("=")) {
      const eq = line.indexOf("=");
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      stack[stack.length - 1].items.push(assign(key, value, lineNo));
      return;
    }

    unknown.push(`line ${lineNo}: ${line}`);
  });

  while (stack.length > 1) {
    const unfinished = stack.pop();
    unknown.push(`line ${unfinished.lineNo}: unclosed block '${unfinished.name}'`);
  }

  return { nodes: root, unknown };
}

function luaIdentifier(name) {
  let clean = name.replace(/\W+/g, "_").replace(/^_+|_+$/g, "");
  if (!clean || /^\d/.test(clean)) {
    clean = `var_${clean}`;
  }
  return clean;
}

function normalizeKey(key) {
  return key.trim().replaceAll("-", "_");
}

function shouldSkipKey(key) {
  const parts = normalizeKey(key).split(".");
  return DEPRECATED_KEYS.has(parts[parts.length - 1]);
}

function quoteLuaString(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function colorAtomToLua(value, varNames) {
  if (COLOR_RE.test(value)) {
    return quoteLuaString(value);
  }
  if (value.startsWith("$")) {
    const rawName = value.slice(1).trim();
    if (rawName && IDENT_RE.test(luaIdentifier(rawName))) {
      return varNames.get(rawName) || luaIdentifier(rawName);
    }
  }
  return null;
}

function colorToLua(value, varNames) {
  let parts = value.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return null;
  }

  let angle = null;
  const angleMatch = ANGLE_RE.exec(parts[parts.length - 1]);
  if (angleMatch) {
    angle = angleMatch[1];
    parts = parts.slice(0, -1);
  }

  const colors = parts.map((part) => colorAtomToLua(part, varNames));
  if (colors.length === 0 || colors.some((color) => color === null)) {
    return null;
  }

  if (colors.length === 1 && angle === null) {
    return colors[0];
  }

  const gradient = {};
  gradient.colors = colors;
  if (angle !== null) {
    gradient.angle = angle;
  }
  return gradient;
}

function scalarToLua(value, varNames) {
  const trimmed = value.trim();
  const lowered = trimmed.toLowerCase();

  if (["true", "yes", "on"].includes(lowered)) {
    return "true";
  }
  if (["false", "no", "off"].includes(lowered)) {
    return "false";
  }
  if (/^-?\d+$/.test(trimmed)) {
    return trimmed;
  }
  if (/^-?(?:\d+\.\d*|\d*\.\d+)$/.test(trimmed)) {
    return trimmed;
  }

  const color = colorToLua(trimmed, varNames);
  if (color !== null) {
    return color;
  }

  if (trimmed.startsWith("$")) {
    const rawName = trimmed.slice(1).trim();
    if (rawName && varNames.has(rawName)) {
      return varNames.get(rawName);
    }
  }

  return quoteLuaString(trimmed);
}

function mergeNested(target, parts, value) {
  const [head, ...tail] = parts;
  if (tail.length === 0) {
    target[head] = value;
    return;
  }

  if (!target[head] || Array.isArray(target[head]) || typeof target[head] !== "object") {
    target[head] = {};
  }
  mergeNested(target[head], tail, value);
}

function addAssignToTable(table, item, varNames) {
  if (shouldSkipKey(item.key)) {
    return;
  }
  const parts = item.key.split(".").map((part) => normalizeKey(part));
  mergeNested(table, parts, scalarToLua(item.value, varNames));
}

function blockToTable(item, varNames, unknown) {
  const table = {};
  item.items.forEach((child) => {
    if (child.kind === "assign") {
      addAssignToTable(table, child, varNames);
    } else {
      table[child.name.replaceAll("-", "_")] = blockToTable(child, varNames, unknown);
    }
  });
  return table;
}

function splitCsv(value) {
  return value.split(",").map((part) => part.trim());
}

function combineKey(modifiers, key, varNames) {
  if (!modifiers.trim()) {
    return quoteLuaString(key);
  }
  const modValue = scalarToLua(modifiers, varNames);
  if (String(modValue).startsWith('"')) {
    return quoteLuaString([modifiers, key].filter(Boolean).join(" + "));
  }
  return `${modValue} .. ${quoteLuaString(` + ${key}`)}`;
}

function dispatchToLua(dispatcher, args) {
  const normalized = normalizeKey(dispatcher);
  const value = args.join(", ").trim();

  if (normalized === "exec") {
    return `hl.dsp.exec_cmd(${quoteLuaString(value)})`;
  }
  if (normalized === "workspace") {
    return `hl.dsp.workspace(${quoteLuaString(value)})`;
  }
  if (normalized === "movetoworkspace") {
    return `hl.dsp.move_to_workspace(${quoteLuaString(value)})`;
  }
  if (normalized === "killactive") {
    return "hl.dsp.kill_active()";
  }
  if (normalized === "togglefloating") {
    return `function()
  hl.dispatch(hl.dsp.window.float({ action = "toggle" }))
end`;
  }
  if (value) {
    return `function()
  hl.dispatch(${quoteLuaString(`${dispatcher} ${value}`)})
end`;
  }
  return `function()
  hl.dispatch(${quoteLuaString(dispatcher)})
end`;
}

function parseBind(key, value, lineNo, varNames, unknown) {
  const parts = splitCsv(value);
  if (parts.length < 3) {
    unknown.push(`line ${lineNo}: unsupported ${key} = ${value}`);
    return null;
  }

  const bindKey = normalizeKey(key);
  const options = BIND_OPTIONS[bindKey] || {};
  const spec = {
    key: combineKey(parts[0], parts[1], varNames),
    action: dispatchToLua(parts[2], parts.slice(3))
  };

  if (Object.keys(options).length > 0) {
    spec.options = options;
  }
  if (parts[0].includes("$")) {
    const varName = parts[0].replace(/^\$/, "").trim();
    if (!varNames.has(varName)) {
      unknown.push(`line ${lineNo}: bind modifier ${parts[0]} references an unknown variable`);
    }
  }
  return spec;
}

function parseMonitor(value, lineNo, unknown) {
  const parts = splitCsv(value);
  if (parts.length < 4) {
    unknown.push(`line ${lineNo}: unsupported monitor = ${value}`);
    return null;
  }

  const spec = {
    output: quoteLuaString(parts[0]),
    mode: quoteLuaString(parts[1]),
    position: quoteLuaString(parts[2]),
    scale: scalarToLua(parts[3], new Map())
  };
  if (parts.length >= 5 && parts[4]) {
    spec.transform = scalarToLua(parts[4], new Map());
  }
  if (parts.length >= 6 && parts[5]) {
    spec.mirror = quoteLuaString(parts[5]);
  }
  if (parts.length > 6) {
    unknown.push(`line ${lineNo}: monitor has extra fields that need review`);
  }
  return spec;
}

function parseEnv(value, lineNo, unknown) {
  const parts = splitCsv(value);
  if (parts.length < 2) {
    unknown.push(`line ${lineNo}: unsupported env = ${value}`);
    return null;
  }
  return [quoteLuaString(parts[0]), quoteLuaString(parts.slice(1).join(", "))];
}

function parseWorkspaceRule(value, varNames) {
  const parts = splitCsv(value);
  const spec = {};
  if (parts.length > 0) {
    spec.workspace = scalarToLua(parts[0], varNames);
  }
  parts.slice(1).forEach((part) => {
    if (!part) {
      return;
    }
    const separator = part.includes(":") ? ":" : part.includes("=") ? "=" : null;
    let key;
    let rawValue;
    if (separator) {
      const index = part.indexOf(separator);
      key = normalizeKey(part.slice(0, index));
      rawValue = part.slice(index + 1).trim() || "true";
    } else {
      const tokens = part.split(/\s+/, 2);
      key = normalizeKey(tokens[0]);
      rawValue = tokens.length > 1 ? part.slice(tokens[0].length).trim() : "true";
    }
    spec[key] = scalarToLua(rawValue, varNames);
  });
  return spec;
}

function emitBind(spec) {
  const lines = [`hl.bind(${spec.key}, ${spec.action}`];
  if (spec.options) {
    const rendered = tableToLua(spec.options, 0);
    if (rendered.length === 1) {
      lines[0] += `, ${rendered[0]})`;
    } else {
      lines[0] += `, ${rendered[0]}`;
      lines.push(...rendered.slice(1, -1), `${rendered[rendered.length - 1]})`);
    }
  } else {
    lines[0] += ")";
  }
  return lines;
}

function emitExecOnce(commands) {
  if (commands.length === 0) {
    return [];
  }
  const lines = ['hl.on("hyprland.start", function()'];
  commands.forEach((command) => {
    lines.push(`  hl.exec_cmd(${quoteLuaString(command)})`);
  });
  lines.push("end)");
  return lines;
}

function animationEnabledToLua(value) {
  const lowered = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(lowered)) {
    return "true";
  }
  if (["0", "false", "no", "off"].includes(lowered)) {
    return "false";
  }
  return scalarToLua(value, new Map());
}

function parseAnimation(value) {
  const parts = splitCsv(value);
  if (parts.length < 3) {
    return null;
  }

  const spec = {};
  spec.leaf = quoteLuaString(parts[0]);
  spec.enabled = animationEnabledToLua(parts[1]);
  spec.speed = scalarToLua(parts[2], new Map());

  if (parts.length >= 4) {
    spec.bezier = quoteLuaString(parts[3]);
  }
  if (parts.length >= 5) {
    spec.style = quoteLuaString(parts.slice(4).join(", "));
  }
  return spec;
}

function parseBezier(value) {
  const parts = splitCsv(value);
  if (parts.length !== 5) {
    return null;
  }
  return { name: parts[0], points: parts.slice(1) };
}

function keyToLua(key) {
  if (IDENT_RE.test(key)) {
    return key;
  }
  return `[${quoteLuaString(key)}]`;
}

function tableToLua(value, indent = 0) {
  const pad = " ".repeat(indent);
  const inner = " ".repeat(indent + 2);

  if (Array.isArray(value)) {
    return [`{ ${value.join(", ")} }`];
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return ["{}"];
    }

    const lines = ["{"];
    entries.forEach(([key, child]) => {
      const rendered = tableToLua(child, indent + 2);
      if (rendered.length === 1) {
        lines.push(`${inner}${keyToLua(key)} = ${rendered[0]},`);
      } else {
        lines.push(`${inner}${keyToLua(key)} = ${rendered[0]}`);
        lines.push(...rendered.slice(1, -1));
        lines.push(`${rendered[rendered.length - 1]},`);
      }
    });
    lines.push(`${pad}}`);
    return lines;
  }

  return [String(value)];
}

function emitCall(name, table) {
  const rendered = tableToLua(table, 0);
  if (rendered.length === 1) {
    return [`${name}(${rendered[0]})`];
  }
  return [`${name}(${rendered[0]}`, ...rendered.slice(1, -1), `${rendered[rendered.length - 1]})`];
}

function parseRuleParts(value, varNames) {
  const spec = {};
  const match = {};

  splitCsv(value).forEach((rawPart) => {
    if (!rawPart) {
      return;
    }

    let key;
    let rawValue;
    if (rawPart.includes("=")) {
      const eq = rawPart.indexOf("=");
      key = rawPart.slice(0, eq).trim();
      rawValue = rawPart.slice(eq + 1).trim();
    } else {
      const tokens = rawPart.split(/\s+/, 2);
      key = tokens[0];
      rawValue = tokens.length > 1 ? rawPart.slice(key.length).trim() : "true";
    }

    key = normalizeKey(key);
    if (shouldSkipKey(key)) {
      return;
    }
    if (key.startsWith("match:")) {
      const matchKey = key.split(":", 2)[1].replaceAll("-", "_");
      match[matchKey] = scalarToLua(rawValue, varNames);
    } else {
      spec[key] = scalarToLua(rawValue, varNames);
    }
  });

  if (Object.keys(match).length > 0) {
    spec.match = match;
  }
  return spec;
}

function blockRuleToSpec(item, varNames) {
  const spec = {};
  const match = {};

  item.items.forEach((child) => {
    if (child.kind === "block") {
      return;
    }
    const key = normalizeKey(child.key);
    if (shouldSkipKey(key)) {
      return;
    }
    if (key.startsWith("match:")) {
      const matchKey = key.split(":", 2)[1].replaceAll("-", "_");
      match[matchKey] = scalarToLua(child.value, varNames);
    } else {
      spec[key] = scalarToLua(child.value, varNames);
    }
  });

  if (Object.keys(match).length > 0) {
    spec.match = match;
  }
  return spec;
}

function collectVars(nodes) {
  const values = {};
  const names = new Map();

  nodes.forEach((item) => {
    if (item.kind === "assign" && item.key.startsWith("$")) {
      const rawName = item.key.slice(1).trim();
      const luaName = luaIdentifier(rawName);
      values[luaName] = scalarToLua(item.value, new Map());
      names.set(rawName, luaName);
    }
  });

  return { values, names };
}

function emitLocal(name, value) {
  const rendered = tableToLua(value, 0);
  if (rendered.length === 1) {
    return [`local ${name} = ${rendered[0]}`];
  }
  return [`local ${name} = ${rendered[0]}`, ...rendered.slice(1)];
}

export function convertNodes(nodes, source = null) {
  const unknown = [];
  const { values: variables, names: varNames } = collectVars(nodes);
  const config = {};
  const curves = [];
  const animations = [];
  const rules = [];
  const sourceLines = [];
  const monitors = [];
  const binds = [];
  const execs = [];
  const execOnce = [];
  const envs = [];
  const workspaceRules = [];
  const devices = [];
  const gestures = [];

  nodes.forEach((item) => {
    if (item.kind === "assign") {
      if (item.key.startsWith("$")) {
        return;
      }

      const key = normalizeKey(item.key);
      if (key === "windowrule") {
        rules.push(["hl.window_rule", parseRuleParts(item.value, varNames)]);
      } else if (key === "windowrulev2") {
        rules.push(["hl.window_rule", parseRuleParts(item.value, varNames)]);
      } else if (key === "layerrule") {
        rules.push(["hl.layer_rule", parseRuleParts(item.value, varNames)]);
      } else if (key === "workspace") {
        workspaceRules.push(parseWorkspaceRule(item.value, varNames));
      } else if (key === "monitor") {
        const parsed = parseMonitor(item.value, item.lineNo, unknown);
        if (parsed) {
          monitors.push(parsed);
        }
      } else if (key === "env") {
        const parsed = parseEnv(item.value, item.lineNo, unknown);
        if (parsed) {
          envs.push(parsed);
        }
      } else if (key === "exec") {
        execs.push(item.value);
      } else if (key === "exec_once") {
        execOnce.push(item.value);
      } else if (key === "source") {
        sourceLines.push(item.value);
        unknown.push(`line ${item.lineNo}: source = ${item.value} needs manual require() path review`);
      } else if (Object.hasOwn(BIND_OPTIONS, key)) {
        const parsed = parseBind(key, item.value, item.lineNo, varNames, unknown);
        if (parsed) {
          binds.push(parsed);
        }
      } else {
        unknown.push(`line ${item.lineNo}: unconverted top-level assignment ${item.key} = ${item.value}`);
      }
      return;
    }

    const blockName = normalizeKey(item.name);
    if (blockName === "animations") {
      const animationCfg = {};
      item.items.forEach((child) => {
        if (child.kind === "block") {
          unknown.push(`line ${child.lineNo}: nested block in animations: ${child.name}`);
          return;
        }

        const key = child.key.trim();
        if (key === "bezier") {
          const parsed = parseBezier(child.value);
          if (parsed) {
            curves.push(parsed);
          } else {
            unknown.push(`line ${child.lineNo}: unsupported bezier = ${child.value}`);
          }
        } else if (key === "animation") {
          const parsed = parseAnimation(child.value);
          if (parsed) {
            animations.push(parsed);
          } else {
            unknown.push(`line ${child.lineNo}: unsupported animation = ${child.value}`);
          }
        } else {
          addAssignToTable(animationCfg, child, varNames);
        }
      });
      if (Object.keys(animationCfg).length > 0) {
        config.animations = animationCfg;
      }
    } else if (blockName === "windowrule") {
      rules.push(["hl.window_rule", blockRuleToSpec(item, varNames)]);
    } else if (blockName === "layerrule") {
      rules.push(["hl.layer_rule", blockRuleToSpec(item, varNames)]);
    } else if (blockName === "workspace") {
      workspaceRules.push(blockRuleToSpec(item, varNames));
    } else if (blockName === "device") {
      devices.push(blockToTable(item, varNames, unknown));
    } else if (blockName === "gesture") {
      gestures.push(blockToTable(item, varNames, unknown));
    } else {
      config[blockName] = blockToTable(item, varNames, unknown);
    }
  });

  const lines = ["-- Generated by hypr2lua-web."];
  if (source) {
    lines.push(`-- Source: ${source}`);
  }
  lines.push("");

  if (Object.keys(variables).length > 0) {
    Object.entries(variables).forEach(([name, value]) => {
      lines.push(...emitLocal(name, value));
    });
    lines.push("");
  }

  sourceLines.forEach((sourceLine) => {
    lines.push(`-- source = ${sourceLine}`);
  });
  if (sourceLines.length > 0) {
    lines.push("");
  }

  if (Object.keys(config).length > 0) {
    lines.push(...emitCall("hl.config", config), "");
  }

  monitors.forEach((monitor) => {
    lines.push(...emitCall("hl.monitor", monitor));
  });
  if (monitors.length > 0) {
    lines.push("");
  }

  envs.forEach(([name, value]) => {
    lines.push(`hl.env(${name}, ${value})`);
  });
  if (envs.length > 0) {
    lines.push("");
  }

  execs.forEach((command) => {
    lines.push(`hl.exec_cmd(${quoteLuaString(command)})`);
  });
  if (execs.length > 0) {
    lines.push("");
  }

  lines.push(...emitExecOnce(execOnce));
  if (execOnce.length > 0) {
    lines.push("");
  }

  curves.forEach(({ name, points }) => {
    lines.push(`hl.curve(${quoteLuaString(name)}, { type = "bezier", points = { { ${points[0]}, ${points[1]} }, { ${points[2]}, ${points[3]} } } })`);
  });
  if (curves.length > 0) {
    lines.push("");
  }

  animations.forEach((animation) => {
    lines.push(...emitCall("hl.animation", animation));
  });
  if (animations.length > 0) {
    lines.push("");
  }

  rules.forEach(([call, spec]) => {
    lines.push(...emitCall(call, spec));
  });
  if (rules.length > 0) {
    lines.push("");
  }

  workspaceRules.forEach((spec) => {
    lines.push(...emitCall("hl.workspace_rule", spec));
  });
  if (workspaceRules.length > 0) {
    lines.push("");
  }

  devices.forEach((spec) => {
    lines.push(...emitCall("hl.device", spec));
  });
  if (devices.length > 0) {
    lines.push("");
  }

  gestures.forEach((spec) => {
    lines.push(...emitCall("hl.gesture", spec));
  });
  if (gestures.length > 0) {
    lines.push("");
  }

  binds.forEach((spec) => {
    lines.push(...emitBind(spec));
  });
  if (binds.length > 0) {
    lines.push("");
  }

  if (unknown.length > 0) {
    lines.push("-- Review required: these lines were not converted automatically.");
    unknown.forEach((message) => lines.push(`-- ${message}`));
    lines.push("");
  }

  return {
    lua: `${lines.join("\n").replace(/\s+$/u, "")}\n`,
    unknown
  };
}

export function convertText(text, source = null) {
  const { nodes, unknown: parseUnknown } = parseHyprlang(text);
  const { lua: convertedLua, unknown: convertUnknown } = convertNodes(nodes, source);
  const unknown = [...parseUnknown, ...convertUnknown];
  let lua = convertedLua;

  if (parseUnknown.length > 0) {
    if (!lua.includes("-- Review required:")) {
      lua = `${lua.trimEnd()}\n\n-- Review required: these lines were not converted automatically.\n`;
    }
    parseUnknown.forEach((message) => {
      lua += `-- ${message}\n`;
    });
  }

  return { lua, unknown };
}

export const exampleInput = `$border = rgba(89b4faee)
$accent = rgb(a6e3a1)
$mainMod = SUPER

monitor = , preferred, auto, auto
env = XCURSOR_SIZE, 24
exec-once = waybar

general {
  gaps_in = 4
  gaps_out = 8
  border_size = 2
  col.active_border = $border $accent 45deg
  col.inactive_border = rgba(313244aa)
}

decoration {
  rounding = 8
  shadow {
    enabled = yes
    range = 12
    color = rgba(11111bee)
  }
  blur {
    enabled = true
    size = 6
    passes = 2
  }
}

animations {
  enabled = yes
  bezier = smooth, 0.22, 1, 0.36, 1
  animation = windows, 1, 4, smooth, popin 80%
}

windowrule = opacity 0.92, match:class = Alacritty
layerrule = blur, match:namespace = waybar
workspace = 1, monitor:DP-1, default:true
bind = $mainMod, Return, exec, foot`;
