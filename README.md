# Editing Assistant

A Premiere Pro panel (UXP) plus a local helper app. The panel shows a setup checklist now; chat with Claude Code, auto-cut and Tesseract motion graphics come in later steps.

```
panel/   UXP plugin loaded into Premiere Pro 25.6+ (plain HTML/JS, no build step)
helper/  Node app on ws://127.0.0.1:7790/panel (local only): dependency checks, later Claude Code + tools
```

## Run it (development)

1. Start the helper: `cd helper`, `npm install` (first time), `npm start`.
2. Open Premiere Pro, then the **UXP Developer Tool** (free, from the Creative Cloud app).
3. In the UXP Developer Tool: **Add Plugin** → pick `panel/manifest.json` → **Load**.
4. In Premiere: **Window → UXP Plugins → Editing Assistant** (or Window → Extensions, depending on the build).

`npm run check` in `helper/` prints the checklist without starting the server.

## Build steps

1. Foundation: helper, panel, setup checklist (done)
2. Chat through Claude Code (headless), streaming replies, usage meter (done)
3. Auto-cut: silences and retakes, preview then apply (done)
4. Tesseract tools: cards, keyword pop-ins, motion graphics at the playhead
5. Extras (zoom, music bed, approval settings) and the installer
