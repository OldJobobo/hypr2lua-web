# hypr2lua-web

Static browser converter for Omarchy theme `hyprland.conf` snippets.

The app converts common theme-scoped Hyprland config into Hyprland 0.55+
`hyprland.lua` output. Conversion runs entirely in the browser, so pasted or
uploaded config data stays on the user's machine.

The hosted site also includes a copy of the Python CLI script at:

```text
/hypr2lua
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
