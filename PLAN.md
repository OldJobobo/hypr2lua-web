# hypr2lua GitHub Pages Website Plan

## Goal

Build a free static website where people can paste or upload an Omarchy theme
`hyprland.conf` snippet and get generated Hyprland 0.55+ `hyprland.lua` output.

The site should run entirely in the browser so it can be hosted on GitHub Pages
with no backend, no server cost, and no uploaded config data leaving the user's
machine.

## Product Scope

### In Scope

- Paste `hyprland.conf` text into an editor.
- Upload a local `hyprland.conf` file.
- Convert to `hyprland.lua` in the browser.
- Display generated Lua output.
- Display review notes for unsupported or ambiguous lines.
- Copy output to clipboard.
- Download output as `hyprland.lua`.
- Include a small example input button.
- Clearly label the converter as targeting Omarchy theme-scoped Hyprland snippets.

### Out of Scope for Version 1

- Server-side conversion.
- User accounts.
- Saving uploaded configs.
- Full personal Hyprland config migration guarantees.
- Bulk folder conversion.
- Automatic validation by running Hyprland.
- GitHub OAuth or gist publishing.

## Important Product Wording

The current CLI is not a universal Hyprland config converter. The website should
avoid overpromising.

Suggested wording:

> Convert Omarchy theme `hyprland.conf` snippets to Hyprland 0.55+
> `hyprland.lua`.

Suggested caution text:

> This tool handles the common Omarchy theme surface: variables, config blocks,
> nested blur/shadow blocks, animations, window rules, and layer rules. Review
> any notes before using the generated Lua.

## Recommended Architecture

Use a static frontend app:

- HTML/CSS/TypeScript or plain JavaScript.
- No backend.
- No network calls for conversion.
- Deploy with GitHub Pages.

Recommended repo layout:

```text
hypr2lua/
  hypr2lua
  README.md
  web/
    index.html
    src/
      converter.ts
      main.ts
      styles.css
    tests/
      converter.test.ts
    package.json
    vite.config.ts
```

Alternative minimal layout:

```text
hypr2lua/
  docs/
    index.html
    app.js
    styles.css
```

The `docs/` layout is simplest for GitHub Pages. The `web/` + Vite layout is
better if we want TypeScript, tests, and cleaner long-term maintenance.

## Conversion Strategy

### Recommended: Port Python Core to TypeScript

Port the pure conversion logic from the Python script:

- `strip_comment`
- `parse_hyprlang`
- `collect_vars`
- scalar/color conversion
- block conversion
- rule parsing
- animation parsing
- Lua table emission
- `convert_text`

Keep the CLI and web converter behavior aligned by using shared fixtures.

Benefits:

- Fast page load.
- No Python runtime in browser.
- Easier tests.
- Easier future UI integration.

Tradeoff:

- The converter logic exists in two languages unless the CLI is later migrated
  or generated from a shared grammar.

### Alternative: Pyodide

Run the existing Python converter in the browser through Pyodide.

Benefits:

- Reuses more existing Python code.
- Reduces initial porting work.

Tradeoffs:

- Much heavier page load.
- More moving parts.
- Less polished for a simple utility.

Decision: use the TypeScript port unless there is a strong reason to preserve
the Python code as the only implementation.

## UI Plan

The first screen should be the actual converter, not a marketing landing page.

Layout:

- Header with project name and short description.
- Two-column desktop layout:
  - left: input editor
  - right: generated Lua output
- Single-column mobile layout:
  - input
  - actions
  - output
  - review notes

Controls:

- Upload file button.
- Convert button, though conversion can also happen live after input changes.
- Copy output button.
- Download `hyprland.lua` button.
- Clear button.
- Load example button.

States:

- Empty state.
- Converted successfully.
- Converted with review notes.
- Parse/review warnings.
- Clipboard success/failure.
- File upload error.

## Testing Plan

Use fixture tests to keep the web converter honest.

Fixture structure:

```text
web/tests/fixtures/
  simple-theme.conf
  simple-theme.lua
  animations.conf
  animations.lua
  rules.conf
  rules.lua
  review-notes.conf
  review-notes.lua
```

Test cases:

- Variables convert to Lua locals.
- RGB/RGBA colors stay quoted correctly.
- Gradients become Lua color tables.
- `general`, `group`, `decoration`, `blur`, and `shadow` blocks convert.
- `bezier` and `animation` entries convert.
- `windowrule` and `layerrule` lines convert.
- Deprecated keys like `ignore_window` are skipped.
- Unknown top-level assignments produce review notes.
- Bad or unmatched braces produce review notes.

Before release, compare TypeScript output against the current Python CLI for
the same fixtures.

## Deployment Plan

### If Using `docs/`

1. Commit the static site in `docs/`.
2. Push to GitHub.
3. In repository settings, enable GitHub Pages.
4. Set source to the branch and `/docs` folder.

### If Using `web/` + Vite

1. Build with `npm run build`.
2. Deploy generated output with a GitHub Actions Pages workflow.
3. Keep source in `web/`.

Recommended for maintainability: `web/` + Vite.

Recommended for fastest first release: `docs/`.

## Milestones

### Milestone 1: Static Prototype

- Create basic HTML/CSS/JS app.
- Support paste input.
- Show placeholder output area.
- Add copy/download buttons.

### Milestone 2: Converter Port

- Port parser and emitter to TypeScript.
- Add fixture tests.
- Match current Python CLI output for selected examples.

### Milestone 3: Upload and Review Notes

- Add local file upload.
- Render review notes separately from generated Lua.
- Add example input.

### Milestone 4: Polish and Deploy

- Improve responsive layout.
- Add README instructions.
- Enable GitHub Pages.
- Verify the live site URL.

## Risks

- Full personal Hyprland configs may include constructs outside the current
  converter scope.
- Python and TypeScript implementations can drift.
- Users may assume the output is guaranteed valid Lua without review.
- Hyprland Lua config APIs may change after 0.55.

## Open Decisions

- Use `docs/` for a minimal static site or `web/` with Vite and TypeScript.
- Keep the website in the existing `hypr2lua` repo or create a separate repo.
- Name the site `hypr2lua`, `hypr2lua-web`, or `omarchy-hypr2lua`.
- Whether to convert live on every edit or only when the user clicks Convert.

## Recommended Next Step

Start with a `web/` Vite TypeScript app inside the existing `hypr2lua` repo,
port `convert_text()` first, add fixture tests, then wire the UI around that
tested converter.
