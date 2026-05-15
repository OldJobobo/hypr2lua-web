import test from "node:test";
import assert from "node:assert/strict";
import { convertText, parseHyprlang, stripComment } from "../docs/converter.js";

test("stripComment ignores hashes inside quotes", () => {
  assert.equal(stripComment('foo = "bar # baz" # tail'), 'foo = "bar # baz" ');
});

test("parseHyprlang builds nested blocks and reports unmatched braces", () => {
  const parsed = parseHyprlang("decoration {\n  blur {\n    enabled = yes\n  }\n}\n}");
  assert.equal(parsed.nodes.length, 1);
  assert.deepEqual(parsed.unknown, ["line 6: unmatched closing brace"]);
});

test("convertText emits variables, nested blocks, gradients, animations, and rules", () => {
  const input = `$active = rgba(89b4faee)
$inactive = rgb(313244)

general {
  gaps_in = 4
  col.active_border = $active $inactive 45deg
}

decoration {
  rounding = 8
  blur {
    enabled = true
    passes = 2
  }
}

animations {
  bezier = smooth, 0.22, 1, 0.36, 1
  animation = windows, 1, 4, smooth, popin 80%
}

windowrule = opacity 0.92, match:class = Alacritty`;

  const { lua, unknown } = convertText(input, "hyprland.conf");

  assert.deepEqual(unknown, []);
  assert.match(lua, /local active = "rgba\(89b4faee\)"/);
  assert.match(lua, /hl.config\(\{/);
  assert.match(lua, /active_border = \{/);
  assert.match(lua, /colors = \{ active, inactive \}/);
  assert.match(lua, /angle = 45/);
  assert.match(lua, /blur = \{/);
  assert.match(lua, /hl.curve\("smooth"/);
  assert.match(lua, /hl.animation\(\{/);
  assert.match(lua, /hl.window_rule\(\{/);
  assert.match(lua, /match = \{/);
});

test("convertText keeps review notes for unknown top-level assignments and parse issues", () => {
  const { lua, unknown } = convertText("mystery = value\nbroken {\n");

  assert.deepEqual(unknown, [
    "line 2: unclosed block 'broken'",
    "line 1: unconverted top-level assignment mystery = value"
  ]);
  assert.match(lua, /Review required/);
  assert.match(lua, /line 1: unconverted top-level assignment mystery = value/);
  assert.match(lua, /line 2: unclosed block 'broken'/);
});
