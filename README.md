# Editing Assistant

A Premiere Pro panel (UXP) plus a local helper app: client guides, auto-cut with a marker preview, captions from the transcript, QA checks with a handoff note, and a chat with Claude Code that shows your plan usage.

```
panel/   UXP plugin loaded into Premiere Pro 25.6+ (plain HTML/JS, no build step)
helper/  Node app on ws://127.0.0.1:7790/panel (local only): checks, Claude Code, Premiere jobs
tools/   preview-server.js: serves panel/ at http://127.0.0.1:7791 to check the UI in a browser
```

## Run it (development)

1. Start the helper: double-click `helper/start-helper.cmd` (installs packages the first time), or `cd helper`, `npm install`, `npm start`. Run `helper/install-autostart.cmd` once to have it start hidden at every login (`uninstall-autostart.cmd` undoes it).
2. Open Premiere Pro, then the **UXP Developer Tool** (free, from the Creative Cloud app).
3. In the UXP Developer Tool: **Add Plugin** → pick `panel/manifest.json` → **Load**.
4. In Premiere: **Window → UXP Plugins → Editing Assistant**.

Premiere jobs (auto-cut, captions, QA) need the CEP panel "MCP for Adobe Premiere Pro" open. `npm run check` in `helper/` prints the setup checklist without starting the server.

## What's in the panel

- **Client**: pick a client to read its guide from `knowledge-base/clients/` (fonts, text rules, must-dos). Captions take its words-per-line rule; QA lists its must-dos.
- **Auto-cut**: Analyze, then optionally **Preview as markers** (red retake, yellow um, white pause; delete a marker in Premiere to keep that part), then Apply. A backup sequence is made first and **Open backup** switches to it. Click any time in the lists to move the playhead; times follow the cuts once applied.
- **Captions**: builds an SRT from the cached transcript of the current (cut) timeline and adds it as a caption track. Style it in Premiere.
- **Review**: QA checks (gaps on V1/A1, offline media, leftover cut markers) plus the client's must-dos as a checklist, and a handoff note to copy into ClickUp or Slack. Nothing is posted from the panel.
- **Chat**: Claude Code with read-only Premiere access. Warns before sending past 85% of the 5-hour limit.
- **Setup**: dependency checklist; **Start helper** when the helper isn't running.

## Build steps

1. Foundation: helper, panel, setup checklist (done)
2. Chat through Claude Code (headless), streaming replies, usage meter (done)
3. Auto-cut: silences and retakes, preview then apply (done)
4. Panel redesign, client guides, marker preview, jump to time, backup restore, captions, QA and handoff, helper auto-start, usage warning (built 2026-10-25, testing in Premiere next)
5. Approving Claude's edits from chat, the installer, Mac support
