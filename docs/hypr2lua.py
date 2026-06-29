#!/usr/bin/env python3
"""Convert Hyprland hyprlang files to Hyprland 0.55 Lua."""

from __future__ import annotations

import argparse
import dataclasses
import os
import pathlib
import re
import shutil
import sys
from collections import OrderedDict
from typing import Iterable


@dataclasses.dataclass
class Assign:
    key: str
    value: str
    line_no: int


@dataclasses.dataclass
class Block:
    name: str
    line_no: int
    items: list["Node"]


Node = Assign | Block


IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
COLOR_RE = re.compile(r"^(?:rgb|rgba)\([0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?\)$")
ANGLE_RE = re.compile(r"^(-?(?:\d+(?:\.\d*)?|\.\d+))deg$")
DEPRECATED_KEYS = {"ignore_window"}
BIND_OPTIONS = {
    "bind": OrderedDict(),
    "bindl": OrderedDict([("locked", "true")]),
    "bindr": OrderedDict([("release", "true")]),
    "binde": OrderedDict([("repeating", "true")]),
    "bindm": OrderedDict([("mouse", "true")]),
}
ANSI_COLORS = {
    "green": "\033[32m",
    "yellow": "\033[33m",
    "red": "\033[31m",
    "cyan": "\033[36m",
    "dim": "\033[2m",
}
ANSI_RESET = "\033[0m"


class ParseError(RuntimeError):
    pass


def use_color(stream: object) -> bool:
    return (
        hasattr(stream, "isatty")
        and stream.isatty()
        and "NO_COLOR" not in os.environ
        and os.environ.get("TERM") != "dumb"
    )


def colorize(text: str, color: str, stream: object = sys.stdout) -> str:
    if not use_color(stream):
        return text
    return f"{ANSI_COLORS[color]}{text}{ANSI_RESET}"


def pluralize(count: int, singular: str, plural: str | None = None) -> str:
    word = singular if count == 1 else plural or f"{singular}s"
    return f"{count} {word}"


def print_status(out_path: pathlib.Path, unknown: list[str], wrote: bool) -> None:
    if unknown:
        dot = colorize("●", "yellow")
        label = colorize("review".ljust(7), "yellow")
        action = "wrote" if wrote else "converted"
        note = pluralize(len(unknown), "review note")
        print(f"{dot} {label} {out_path}  {colorize(f'({action}, {note})', 'dim')}")
        return

    dot = colorize("●", "green")
    label = colorize(("wrote" if wrote else "converted").ljust(7), "green")
    print(f"{dot} {label} {out_path}")


def print_error(path: pathlib.Path, exc: Exception) -> None:
    dot = colorize("●", "red", sys.stderr)
    label = colorize("error".ljust(7), "red", sys.stderr)
    print(f"{dot} {label} {path}", file=sys.stderr)
    print(f"  {colorize(str(exc), 'dim', sys.stderr)}", file=sys.stderr)


def strip_comment(line: str) -> str:
    in_quote: str | None = None
    escaped = False
    for i, ch in enumerate(line):
        if escaped:
            escaped = False
            continue
        if ch == "\\":
            escaped = True
            continue
        if in_quote:
            if ch == in_quote:
                in_quote = None
            continue
        if ch in ("'", '"'):
            in_quote = ch
            continue
        if ch == "#":
            return line[:i]
    return line


def parse_hyprlang(text: str) -> tuple[list[Node], list[str]]:
    root: list[Node] = []
    stack: list[tuple[str, int, list[Node]]] = [("<root>", 0, root)]
    unknown: list[str] = []

    for line_no, raw in enumerate(text.splitlines(), 1):
        line = strip_comment(raw).strip()
        if not line:
            continue

        if line == "}":
            if len(stack) == 1:
                unknown.append(f"line {line_no}: unmatched closing brace")
                continue
            name, start_line, items = stack.pop()
            stack[-1][2].append(Block(name=name, line_no=start_line, items=items))
            continue

        if line.endswith("{"):
            name = line[:-1].strip()
            if not name:
                unknown.append(f"line {line_no}: empty block name")
                continue
            stack.append((name, line_no, []))
            continue

        if "=" in line:
            key, value = line.split("=", 1)
            stack[-1][2].append(Assign(key=key.strip(), value=value.strip(), line_no=line_no))
            continue

        unknown.append(f"line {line_no}: {line}")

    while len(stack) > 1:
        name, start_line, _ = stack.pop()
        unknown.append(f"line {start_line}: unclosed block {name!r}")

    return root, unknown


def lua_identifier(name: str) -> str:
    clean = re.sub(r"\W+", "_", name).strip("_")
    if not clean or clean[0].isdigit():
        clean = f"var_{clean}"
    return clean


def normalize_key(key: str) -> str:
    return key.strip().replace("-", "_")


def should_skip_key(key: str) -> bool:
    return normalize_key(key).split(".")[-1] in DEPRECATED_KEYS


def quote_lua_string(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def color_atom_to_lua(value: str, var_names: dict[str, str]) -> str | None:
    if COLOR_RE.fullmatch(value):
        return quote_lua_string(value)
    if value.startswith("$"):
        raw_name = value[1:].strip()
        if raw_name and IDENT_RE.match(lua_identifier(raw_name)):
            return var_names.get(raw_name, lua_identifier(raw_name))
    return None


def color_to_lua(value: str, var_names: dict[str, str]) -> str | OrderedDict[str, object] | None:
    parts = value.split()
    if not parts:
        return None

    angle: str | None = None
    last = parts[-1]
    angle_match = ANGLE_RE.fullmatch(last)
    if angle_match:
        angle = angle_match.group(1)
        parts = parts[:-1]

    colors = [color_atom_to_lua(part, var_names) for part in parts]
    if not colors or any(color is None for color in colors):
        return None

    if len(colors) == 1 and angle is None:
        return colors[0] or None

    gradient: OrderedDict[str, object] = OrderedDict()
    gradient["colors"] = colors
    if angle is not None:
        gradient["angle"] = angle
    return gradient


def scalar_to_lua(value: str, var_names: dict[str, str]) -> object:
    value = value.strip()

    lowered = value.lower()
    if lowered in {"true", "yes", "on"}:
        return "true"
    if lowered in {"false", "no", "off"}:
        return "false"
    if re.fullmatch(r"-?\d+", value):
        return value
    if re.fullmatch(r"-?(?:\d+\.\d*|\d*\.\d+)", value):
        return value

    color = color_to_lua(value, var_names)
    if color is not None:
        return color

    if value.startswith("$"):
        raw_name = value[1:].strip()
        if raw_name in var_names:
            return var_names[raw_name]

    return quote_lua_string(value)


def is_table_array(value: object) -> bool:
    return isinstance(value, list)


def merge_nested(target: OrderedDict[str, object], parts: list[str], value: object) -> None:
    head = parts[0]
    if len(parts) == 1:
        target[head] = value
        return
    child = target.get(head)
    if not isinstance(child, OrderedDict):
        child = OrderedDict()
        target[head] = child
    merge_nested(child, parts[1:], value)


def add_assign_to_table(table: OrderedDict[str, object], assign: Assign, var_names: dict[str, str]) -> None:
    if should_skip_key(assign.key):
        return
    parts = [normalize_key(part) for part in assign.key.split(".")]
    merge_nested(table, parts, scalar_to_lua(assign.value, var_names))


def block_to_table(block: Block, var_names: dict[str, str], unknown: list[str]) -> OrderedDict[str, object]:
    table: OrderedDict[str, object] = OrderedDict()
    for item in block.items:
        if isinstance(item, Assign):
            add_assign_to_table(table, item, var_names)
        else:
            table[item.name.replace("-", "_")] = block_to_table(item, var_names, unknown)
    return table


def split_csv(value: str) -> list[str]:
    return [part.strip() for part in value.split(",")]


def combine_key(modifiers: str, key: str, var_names: dict[str, str]) -> str:
    if not modifiers.strip():
        return quote_lua_string(key)
    mod_value = scalar_to_lua(modifiers, var_names)
    if str(mod_value).startswith('"'):
        return quote_lua_string(" + ".join(part for part in [modifiers, key] if part))
    return f"{mod_value} .. {quote_lua_string(f' + {key}')}"


def dispatch_to_lua(dispatcher: str, args: list[str]) -> str:
    normalized = normalize_key(dispatcher)
    value = ", ".join(args).strip()

    if normalized == "exec":
        return f"hl.dsp.exec_cmd({quote_lua_string(value)})"
    if normalized == "workspace":
        return f"hl.dsp.workspace({quote_lua_string(value)})"
    if normalized == "movetoworkspace":
        return f"hl.dsp.move_to_workspace({quote_lua_string(value)})"
    if normalized == "killactive":
        return "hl.dsp.kill_active()"
    if normalized == "togglefloating":
        return 'function()\n  hl.dispatch(hl.dsp.window.float({ action = "toggle" }))\nend'
    if value:
        return f"function()\n  hl.dispatch({quote_lua_string(f'{dispatcher} {value}')})\nend"
    return f"function()\n  hl.dispatch({quote_lua_string(dispatcher)})\nend"


def parse_bind(
    key: str,
    value: str,
    line_no: int,
    var_names: dict[str, str],
    unknown: list[str],
) -> OrderedDict[str, object] | None:
    parts = split_csv(value)
    if len(parts) < 3:
        unknown.append(f"line {line_no}: unsupported {key} = {value}")
        return None

    bind_key = normalize_key(key)
    spec: OrderedDict[str, object] = OrderedDict()
    spec["key"] = combine_key(parts[0], parts[1], var_names)
    spec["action"] = dispatch_to_lua(parts[2], parts[3:])
    options = BIND_OPTIONS.get(bind_key, OrderedDict())
    if options:
        spec["options"] = options
    if "$" in parts[0]:
        var_name = parts[0].lstrip("$").strip()
        if var_name not in var_names:
            unknown.append(f"line {line_no}: bind modifier {parts[0]} references an unknown variable")
    return spec


def parse_monitor(value: str, line_no: int, unknown: list[str]) -> OrderedDict[str, object] | None:
    parts = split_csv(value)
    if len(parts) < 4:
        unknown.append(f"line {line_no}: unsupported monitor = {value}")
        return None

    spec: OrderedDict[str, object] = OrderedDict()
    spec["output"] = quote_lua_string(parts[0])
    spec["mode"] = quote_lua_string(parts[1])
    spec["position"] = quote_lua_string(parts[2])
    spec["scale"] = scalar_to_lua(parts[3], {})
    if len(parts) >= 5 and parts[4]:
        spec["transform"] = scalar_to_lua(parts[4], {})
    if len(parts) >= 6 and parts[5]:
        spec["mirror"] = quote_lua_string(parts[5])
    if len(parts) > 6:
        unknown.append(f"line {line_no}: monitor has extra fields that need review")
    return spec


def parse_env(value: str, line_no: int, unknown: list[str]) -> tuple[str, str] | None:
    parts = split_csv(value)
    if len(parts) < 2:
        unknown.append(f"line {line_no}: unsupported env = {value}")
        return None
    return quote_lua_string(parts[0]), quote_lua_string(", ".join(parts[1:]))


def parse_workspace_rule(value: str, var_names: dict[str, str]) -> OrderedDict[str, object]:
    parts = split_csv(value)
    spec: OrderedDict[str, object] = OrderedDict()
    if parts:
        spec["workspace"] = scalar_to_lua(parts[0], var_names)
    for part in parts[1:]:
        if not part:
            continue
        separator = ":" if ":" in part else "=" if "=" in part else None
        if separator:
            index = part.index(separator)
            key = normalize_key(part[:index])
            raw_value = part[index + 1 :].strip() or "true"
        else:
            tokens = part.split(None, 1)
            key = normalize_key(tokens[0])
            raw_value = tokens[1] if len(tokens) > 1 else "true"
        spec[key] = scalar_to_lua(raw_value, var_names)
    return spec


def emit_bind(spec: OrderedDict[str, object]) -> list[str]:
    lines = [f"hl.bind({spec['key']}, {spec['action']}"]
    options = spec.get("options")
    if isinstance(options, OrderedDict):
        rendered = table_to_lua(options, 0)
        if len(rendered) == 1:
            lines[0] += f", {rendered[0]})"
        else:
            lines[0] += f", {rendered[0]}"
            lines.extend(rendered[1:-1])
            lines.append(f"{rendered[-1]})")
    else:
        lines[0] += ")"
    return lines


def emit_exec_once(commands: list[str]) -> list[str]:
    if not commands:
        return []
    lines = ['hl.on("hyprland.start", function()']
    for command in commands:
        lines.append(f"  hl.exec_cmd({quote_lua_string(command)})")
    lines.append("end)")
    return lines


def parse_animation(value: str) -> OrderedDict[str, object] | None:
    parts = split_csv(value)
    if len(parts) < 3:
        return None

    spec: OrderedDict[str, object] = OrderedDict()
    spec["leaf"] = quote_lua_string(parts[0])
    spec["enabled"] = animation_enabled_to_lua(parts[1])
    spec["speed"] = scalar_to_lua(parts[2], {})

    if len(parts) >= 4:
        curve = parts[3]
        spec["bezier"] = quote_lua_string(curve)
    if len(parts) >= 5:
        spec["style"] = quote_lua_string(", ".join(parts[4:]))

    return spec


def animation_enabled_to_lua(value: str) -> str:
    lowered = value.strip().lower()
    if lowered in {"1", "true", "yes", "on"}:
        return "true"
    if lowered in {"0", "false", "no", "off"}:
        return "false"
    return scalar_to_lua(value, {})


def parse_bezier(value: str) -> tuple[str, list[str]] | None:
    parts = split_csv(value)
    if len(parts) != 5:
        return None
    name = parts[0]
    points = parts[1:]
    return name, points


def key_to_lua(key: str) -> str:
    if IDENT_RE.match(key):
        return key
    return f"[{quote_lua_string(key)}]"


def table_to_lua(value: object, indent: int = 0) -> list[str]:
    pad = " " * indent
    inner = " " * (indent + 2)

    if isinstance(value, OrderedDict):
        if not value:
            return ["{}"]
        lines = ["{"]
        for key, child in value.items():
            rendered = table_to_lua(child, indent + 2)
            if len(rendered) == 1:
                lines.append(f"{inner}{key_to_lua(key)} = {rendered[0]},")
            else:
                lines.append(f"{inner}{key_to_lua(key)} = {rendered[0]}")
                lines.extend(rendered[1:-1])
                lines.append(f"{rendered[-1]},")
        lines.append(f"{pad}}}")
        return lines

    if isinstance(value, list):
        return ["{ " + ", ".join(value) + " }"]

    return [str(value)]


def emit_call(name: str, table: OrderedDict[str, object]) -> list[str]:
    rendered = table_to_lua(table, 0)
    if len(rendered) == 1:
        return [f"{name}({rendered[0]})"]
    return [f"{name}({rendered[0]}", *rendered[1:-1], f"{rendered[-1]})"]


def parse_rule_parts(value: str, var_names: dict[str, str]) -> OrderedDict[str, object]:
    spec: OrderedDict[str, object] = OrderedDict()
    match: OrderedDict[str, object] = OrderedDict()

    for raw_part in split_csv(value):
        if not raw_part:
            continue

        if "=" in raw_part:
            key, raw_value = raw_part.split("=", 1)
            key = key.strip()
            raw_value = raw_value.strip()
        else:
            tokens = raw_part.split(None, 1)
            key = tokens[0]
            raw_value = tokens[1] if len(tokens) > 1 else "true"

        key = normalize_key(key)
        if should_skip_key(key):
            continue
        if key.startswith("match:"):
            match_key = key.split(":", 1)[1].replace("-", "_")
            match[match_key] = scalar_to_lua(raw_value, var_names)
        else:
            spec[key] = scalar_to_lua(raw_value, var_names)

    if match:
        spec["match"] = match
    return spec


def block_rule_to_spec(block: Block, var_names: dict[str, str]) -> OrderedDict[str, object]:
    spec: OrderedDict[str, object] = OrderedDict()
    match: OrderedDict[str, object] = OrderedDict()

    for item in block.items:
        if isinstance(item, Block):
            continue
        key = normalize_key(item.key)
        if should_skip_key(key):
            continue
        if key.startswith("match:"):
            match_key = key.split(":", 1)[1].replace("-", "_")
            match[match_key] = scalar_to_lua(item.value, var_names)
        else:
            spec[key] = scalar_to_lua(item.value, var_names)

    if match:
        spec["match"] = match
    return spec


def collect_vars(nodes: Iterable[Node]) -> tuple[OrderedDict[str, object], dict[str, str]]:
    values: OrderedDict[str, object] = OrderedDict()
    names: dict[str, str] = {}
    for item in nodes:
        if isinstance(item, Assign) and item.key.startswith("$"):
            raw_name = item.key[1:].strip()
            lua_name = lua_identifier(raw_name)
            values[lua_name] = scalar_to_lua(item.value, {})
            names[raw_name] = lua_name
    return values, names


def emit_local(name: str, value: object) -> list[str]:
    rendered = table_to_lua(value, 0)
    if len(rendered) == 1:
        return [f"local {name} = {rendered[0]}"]
    return [f"local {name} = {rendered[0]}", *rendered[1:]]


def convert_nodes(nodes: list[Node], source: pathlib.Path | None = None) -> tuple[str, list[str]]:
    unknown: list[str] = []
    variables, var_names = collect_vars(nodes)
    config: OrderedDict[str, object] = OrderedDict()
    curves: list[tuple[str, list[str]]] = []
    animations: list[OrderedDict[str, object]] = []
    rules: list[tuple[str, OrderedDict[str, object]]] = []
    source_lines: list[str] = []
    monitors: list[OrderedDict[str, object]] = []
    binds: list[OrderedDict[str, object]] = []
    execs: list[str] = []
    exec_once: list[str] = []
    envs: list[tuple[str, str]] = []
    workspace_rules: list[OrderedDict[str, object]] = []
    devices: list[OrderedDict[str, object]] = []
    gestures: list[OrderedDict[str, object]] = []

    for item in nodes:
        if isinstance(item, Assign):
            if item.key.startswith("$"):
                continue
            key = normalize_key(item.key)
            if key == "windowrule":
                rules.append(("hl.window_rule", parse_rule_parts(item.value, var_names)))
            elif key == "windowrulev2":
                rules.append(("hl.window_rule", parse_rule_parts(item.value, var_names)))
            elif key == "layerrule":
                rules.append(("hl.layer_rule", parse_rule_parts(item.value, var_names)))
            elif key == "workspace":
                workspace_rules.append(parse_workspace_rule(item.value, var_names))
            elif key == "monitor":
                parsed_monitor = parse_monitor(item.value, item.line_no, unknown)
                if parsed_monitor:
                    monitors.append(parsed_monitor)
            elif key == "env":
                parsed_env = parse_env(item.value, item.line_no, unknown)
                if parsed_env:
                    envs.append(parsed_env)
            elif key == "exec":
                execs.append(item.value)
            elif key == "exec_once":
                exec_once.append(item.value)
            elif key == "source":
                source_lines.append(item.value)
                unknown.append(f"line {item.line_no}: source = {item.value} needs manual require() path review")
            elif key in BIND_OPTIONS:
                parsed_bind = parse_bind(key, item.value, item.line_no, var_names, unknown)
                if parsed_bind:
                    binds.append(parsed_bind)
            else:
                unknown.append(f"line {item.line_no}: unconverted top-level assignment {item.key} = {item.value}")
            continue

        block_name = normalize_key(item.name)
        if block_name == "animations":
            animation_cfg: OrderedDict[str, object] = OrderedDict()
            for child in item.items:
                if isinstance(child, Block):
                    unknown.append(f"line {child.line_no}: nested block in animations: {child.name}")
                    continue
                key = child.key.strip()
                if key == "bezier":
                    parsed = parse_bezier(child.value)
                    if parsed:
                        curves.append(parsed)
                    else:
                        unknown.append(f"line {child.line_no}: unsupported bezier = {child.value}")
                elif key == "animation":
                    parsed_animation = parse_animation(child.value)
                    if parsed_animation:
                        animations.append(parsed_animation)
                    else:
                        unknown.append(f"line {child.line_no}: unsupported animation = {child.value}")
                else:
                    add_assign_to_table(animation_cfg, child, var_names)
            if animation_cfg:
                config["animations"] = animation_cfg
        elif block_name == "windowrule":
            rules.append(("hl.window_rule", block_rule_to_spec(item, var_names)))
        elif block_name == "layerrule":
            rules.append(("hl.layer_rule", block_rule_to_spec(item, var_names)))
        elif block_name == "workspace":
            workspace_rules.append(block_rule_to_spec(item, var_names))
        elif block_name == "device":
            devices.append(block_to_table(item, var_names, unknown))
        elif block_name == "gesture":
            gestures.append(block_to_table(item, var_names, unknown))
        else:
            config[block_name] = block_to_table(item, var_names, unknown)

    lines: list[str] = []
    lines.append("-- Generated by scripts/hypr2lua.")
    if source:
        lines.append(f"-- Source: {source}")
    lines.append("")

    if variables:
        for name, value in variables.items():
            lines.extend(emit_local(name, value))
        lines.append("")

    for source_line in source_lines:
        lines.append(f"-- source = {source_line}")
    if source_lines:
        lines.append("")

    if config:
        lines.extend(emit_call("hl.config", config))
        lines.append("")

    for monitor in monitors:
        lines.extend(emit_call("hl.monitor", monitor))
    if monitors:
        lines.append("")

    for name, value in envs:
        lines.append(f"hl.env({name}, {value})")
    if envs:
        lines.append("")

    for command in execs:
        lines.append(f"hl.exec_cmd({quote_lua_string(command)})")
    if execs:
        lines.append("")

    lines.extend(emit_exec_once(exec_once))
    if exec_once:
        lines.append("")

    for name, points in curves:
        lines.append(f'hl.curve({quote_lua_string(name)}, {{ type = "bezier", points = {{ {{ {points[0]}, {points[1]} }}, {{ {points[2]}, {points[3]} }} }} }})')
    if curves:
        lines.append("")

    for animation in animations:
        lines.extend(emit_call("hl.animation", animation))
    if animations:
        lines.append("")

    for call, spec in rules:
        lines.extend(emit_call(call, spec))
    if rules:
        lines.append("")

    for spec in workspace_rules:
        lines.extend(emit_call("hl.workspace_rule", spec))
    if workspace_rules:
        lines.append("")

    for spec in devices:
        lines.extend(emit_call("hl.device", spec))
    if devices:
        lines.append("")

    for spec in gestures:
        lines.extend(emit_call("hl.gesture", spec))
    if gestures:
        lines.append("")

    for spec in binds:
        lines.extend(emit_bind(spec))
    if binds:
        lines.append("")

    if unknown:
        lines.append("-- Review required: these lines were not converted automatically.")
        for message in unknown:
            lines.append(f"-- {message}")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n", unknown


def convert_text(text: str, source: pathlib.Path | None = None) -> tuple[str, list[str]]:
    nodes, parse_unknown = parse_hyprlang(text)
    lua, convert_unknown = convert_nodes(nodes, source=source)
    unknown = [*parse_unknown, *convert_unknown]
    if parse_unknown:
        if "-- Review required:" not in lua:
            lua = lua.rstrip() + "\n\n-- Review required: these lines were not converted automatically.\n"
        for message in parse_unknown:
            lua += f"-- {message}\n"
    return lua, unknown


def input_to_output_path(path: pathlib.Path) -> pathlib.Path:
    if path.is_dir():
        return path / "hyprland.lua"
    if path.name == "hyprland.conf":
        return path.with_name("hyprland.lua")
    return path.with_suffix(".lua")


def input_conf_path(path: pathlib.Path) -> pathlib.Path:
    if path.is_dir():
        return path / "hyprland.conf"
    return path


def discover_theme_paths(root: pathlib.Path) -> list[pathlib.Path]:
    return sorted(path for path in root.glob("omarchy-*") if (path / "hyprland.conf").is_file())


def sandbox_path_for(path: pathlib.Path, sandbox_root: pathlib.Path) -> pathlib.Path:
    if path.is_dir():
        return sandbox_root / path.name
    if path.name == "hyprland.conf":
        return sandbox_root / path.parent.name
    return sandbox_root / path.stem


def prepare_sandbox_paths(paths: list[pathlib.Path], sandbox_root: pathlib.Path) -> list[pathlib.Path]:
    sandbox_root.mkdir(parents=True, exist_ok=True)

    sandbox_paths: list[pathlib.Path] = []
    seen: set[pathlib.Path] = set()
    for path in paths:
        conf_path = input_conf_path(path)
        if not conf_path.is_file():
            raise FileNotFoundError(conf_path)

        sandbox_theme = sandbox_path_for(path, sandbox_root)
        sandbox_theme.mkdir(parents=True, exist_ok=True)
        sandbox_conf = sandbox_theme / "hyprland.conf"
        shutil.copy2(conf_path, sandbox_conf)

        if sandbox_theme not in seen:
            sandbox_paths.append(sandbox_theme)
            seen.add(sandbox_theme)

    return sandbox_paths


def convert_path(
    path: pathlib.Path,
    write: bool,
    force: bool,
    emit_output: bool = True,
) -> tuple[pathlib.Path, list[str], bool]:
    conf_path = input_conf_path(path)
    if not conf_path.is_file():
        raise FileNotFoundError(conf_path)

    lua, unknown = convert_text(conf_path.read_text(), source=conf_path)

    out_path = input_to_output_path(path)
    wrote = False
    if write:
        if out_path.exists() and not force:
            raise FileExistsError(f"{out_path} exists; use --force to overwrite")
        out_path.write_text(lua)
        wrote = True
    elif emit_output:
        sys.stdout.write(lua)

    return out_path, unknown, wrote


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Convert Hyprland hyprlang configs to Hyprland 0.55 Lua.",
        epilog=(
            "Common use: pass a hyprland.conf file or run inside a config directory with `hypr2lua -w`. "
            "Bulk use: `hypr2lua -r /path/to/themes -w`."
        ),
    )
    parser.add_argument("paths", nargs="*", type=pathlib.Path, help="Hyprlang files or config directories")
    parser.add_argument(
        "-r",
        "--themes-root",
        type=pathlib.Path,
        help="Convert every omarchy-* theme under this root",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Convert and report status without writing files or printing Lua output",
    )
    parser.add_argument(
        "--sandbox-root",
        type=pathlib.Path,
        help="Copy each input hyprland.conf under this directory and convert the copies",
    )
    parser.add_argument("-w", "--write", action="store_true", help="Write hyprland.lua next to each source")
    parser.add_argument("-f", "--force", action="store_true", help="Overwrite existing hyprland.lua files")
    args = parser.parse_args()

    if args.check and args.write:
        parser.error("--check cannot be combined with --write")

    paths = list(args.paths)
    if args.themes_root:
        paths.extend(discover_theme_paths(args.themes_root))

    if not paths:
        cwd = pathlib.Path.cwd()
        if (cwd / "hyprland.conf").is_file():
            paths.append(cwd)
        else:
            parser.error("run inside a config directory, pass a file/directory, or use -r /path/to/themes")

    if args.sandbox_root:
        paths = prepare_sandbox_paths(paths, args.sandbox_root)
        if args.write:
            print(f"sandbox: {args.sandbox_root}")

    failures = 0
    for index, path in enumerate(paths):
        try:
            if not args.write and not args.check and len(paths) > 1:
                if index:
                    print()
                print(f"-- ===== {path} =====")
            out_path, unknown, wrote = convert_path(path, args.write, args.force, emit_output=not args.check)
            if args.write:
                print_status(out_path, unknown, wrote)
            elif args.check:
                print_status(out_path, unknown, wrote)
        except Exception as exc:  # noqa: BLE001 - CLI should report all paths.
            failures += 1
            print_error(path, exc)

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
