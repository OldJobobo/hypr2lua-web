# hypr2lua General Converter Plan

## Goal

Maintain a free static website and downloadable CLI that convert common
Hyprland `hyprlang` config files to Hyprland 0.55+ Lua.

Conversion stays local to the browser or local CLI process. The converter aims
for practical migration coverage, not exhaustive guarantees for every
plugin-specific or future Hyprland directive.

## Product Scope

In scope:

- Paste or upload a Hyprlang config.
- Convert common full-config directives to Lua.
- Preserve review notes for unsupported or ambiguous lines.
- Copy or download generated Lua.
- Keep the browser converter and Python CLI behavior aligned.

Out of scope:

- Server-side conversion.
- Automatic validation by running Hyprland.
- Resolving `source = ...` include paths without user review.
- Guaranteeing exact migration for plugin-specific directives.

## Conversion Surface

The converter handles:

- Variables.
- Ordinary config blocks via `hl.config`.
- Monitors, environment variables, exec, exec-once, binds, workspace rules,
  window rules, layer rules, device blocks, gestures, animations, and curves.
- Review notes for parse issues, source directives, unknown top-level
  assignments, and unsupported directive shapes.

## Testing

Use `npm test` for the browser converter. Keep shared examples broad enough to
cover theme snippets and full personal config patterns.
