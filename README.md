# hypr2lua-web

Static browser converter for Hyprland `hyprlang` config files.

The app converts common Hyprland config directives into Hyprland 0.55+ Lua
output. Conversion runs entirely in the browser, so pasted or uploaded config
data stays on the user's machine. Unsupported or ambiguous lines are kept as
review notes in the generated output.

The hosted site also includes a copy of the executable CLI script at:

```text
/hypr2lua.py
```

## Run Locally

Serve the repository root and open `docs/index.html`:

```bash
python -m http.server 4173
```

Then visit:

```text
http://localhost:4173/docs/
```

## Test

```bash
npm test
```

## Deploy

Enable GitHub Pages for the repository branch and set the Pages source folder
to `/docs`.
