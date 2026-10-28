<p align="center">
  <img src="panel/icons/logo.svg" width="128" alt="Editing Assistant logo">
</p>

# Editing Assistant

![Premiere Pro](https://img.shields.io/badge/PREMIERE_PRO-25.6%2B-9999FF?style=for-the-badge&logo=adobepremierepro&logoColor=white)
![UXP](https://img.shields.io/badge/PLUGIN-UXP_PANEL-4F378B?style=for-the-badge)
![Claude Code](https://img.shields.io/badge/AI-CLAUDE_CODE-D97757?style=for-the-badge&logo=claude&logoColor=white)
![Node](https://img.shields.io/badge/HELPER-NODE_20%2B-5FA04E?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Platform](https://img.shields.io/badge/PLATFORM-WINDOWS-0078D4?style=for-the-badge)

> A Premiere Pro panel for short-form editors. It cuts dead air and retakes, keeps every client's rules one click away, checks an edit before handoff, and puts Claude in a chat window that can read and edit your timeline. It works without approval prompts, so a quick ask gets a quick edit.

---

## ✨ Features Highlight

- ✂️ **Auto-cut:** removes silences, ums and "take again" retakes from the dialogue track you pick (A1 to A8), including sped-up or slowed clips. Preview every cut as a coloured marker first (delete a marker to keep that bit), then apply. A backup sequence is made first; **Stop** halts cleanly between batches and **Undo cuts** swaps the original back in, even after the helper restarts.
- 💬 **Claude chat window:** its own panel you can float or dock. Saved chats you can switch, rename and delete, with replies rendered as clean Markdown. Each message tells Claude the open sequence, the playhead and the selected clips, so "extend this clip" just works. Each chat keeps one Claude Code session running and starts it when you open the chat, so replies begin in about 1-2 seconds.
- ⚡ **No approval prompts:** the chat edits the timeline, runs Tesseract and FFmpeg, and uses the shell without stopping to ask. It's told to duplicate the sequence before big changes.
- 🎞️ **Tesseract and FFmpeg tools:** dedicated tools for motion graphics and for retiming, trimming or converting clips. Work happens in job folders on C: (Tesseract can't save projects on exFAT drives), footage is only read, and finished files are copied out without overwriting anything.
- 🎨 **Scrubless look:** the same Material 3 Expressive style as Scrubless, the footage finder: dark, lavender accent, rounded cards and pill buttons, with a matching logo.
- 📋 **Client guides:** pick a client to see its fonts, on-screen text rules and must-dos, read straight from the team knowledge base.
- 🔍 **Review:** QA checks (gaps on V1/A1, offline media, leftover cut markers, and the sequence size and frame rate against the client's export spec), the client's must-dos as a tick list, and a handoff note to paste into ClickUp or Slack. Nothing is ever posted for you.
- 📊 **Plan usage at a glance:** a "Claude NN%" chip with the 5-hour and weekly limits, plus a warning before you send past 85%.

---

## 🛠️ The Technology Stack

- **Panel:** [Adobe UXP](https://developer.adobe.com/premiere-pro/uxp/) (plain HTML, CSS and JavaScript, no build step), styled after Scrubless (Material 3 Expressive, dark, lavender accent)
- **Helper:** [Node.js](https://nodejs.org/) with [ws](https://github.com/websockets/ws), listening on `127.0.0.1` only
- **AI:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code) run headless on your own Claude plan, with tools served over the [Model Context Protocol](https://modelcontextprotocol.io/)
- **Premiere control:** [premiere-pro-mcp](https://premiere-pro-mcp.com/) through one long-lived connection shared by auto-cut, QA and the chat
- **Speech and audio:** [whisper.cpp](https://github.com/ggerganov/whisper.cpp) (small.en) for word timings, [FFmpeg](https://ffmpeg.org/) for audio and video work
- **Motion graphics:** Tesseract CLI 0.4.0

---

## 🚀 Getting Started

1. **Helper:** double-click `helper/start-helper.cmd` (installs packages the first time). To start it hidden at every login, run `helper/install-autostart.cmd` once; `uninstall-autostart.cmd` undoes it.
2. **Plugin:** open the free **UXP Developer Tool** from Creative Cloud, choose **Add Plugin**, pick `panel/manifest.json`, then **Load**. Premiere needs **Preferences → Plugins → Enable Developer Mode** and a restart first.
3. **Panels:** in Premiere, **Window → UXP Plugins → Editing Assistant** and **Editing Assistant Chat**.
4. Keep the CEP panel **MCP for Adobe Premiere Pro** open; auto-cut, QA and the chat's Premiere tools go through it.

The **Setup** section checks for Claude Code, Tesseract, whisper.cpp and FFmpeg and says what's missing (with the folder it searched). `npm run check` in `helper/` prints the same checklist, and `npm test` runs the logic tests (speed mapping, export spec, tool guards).

**Where things are saved:** `%LOCALAPPDATA%\EditingAssistant\`: `chats.json` (your chats), `usage.json` (last plan usage), `cache\` (audio and transcripts for auto-cut) and `tesseract\` (chat job folders). The helper's own log is `helper/helper.log`.

---

## 🔒 Safety by Design

- The helper only listens on `127.0.0.1`; nothing outside your computer can reach it.
- The panel's Tesseract and FFmpeg tools write only to job folders under `%LOCALAPPDATA%\EditingAssistant\tesseract`, and `copy_out` never overwrites (Claude can still use the shell directly).
- Auto-cut always makes a backup sequence first, and Undo cuts puts it back.
- The chat runs without approval prompts (your choice): use it on project files you have backups of.

---

## 📁 Project Layout

```
panel/    UXP plugin: the main panel and the chat window (two panels, one script)
  icons/  logo.svg and the PNG icons the manifest uses
helper/   Node helper: checks, Claude Code chats, auto-cut, QA, and the chat's tool server
tools/    preview-server.js: serves panel/ at http://127.0.0.1:7791 to check the UI in a browser
```

---

## 🗺️ Roadmap

- [x] Setup checklist, Claude Code chat and usage meter
- [x] Auto-cut with marker preview, Stop and Undo cuts
- [x] Client guides, QA checks and handoff notes
- [x] Chat window with saved chats, Markdown replies and Scrubless styling
- [x] Locked-down Tesseract and FFmpeg tools for the chat
- [x] Prompt-free chat, faster streaming and the Editing Assistant logo
- [x] Undo cuts survives restarts; the chat knows the open sequence and selection
- [x] QA checks the client's export spec; auto-cut on any audio track and sped-up clips
- [ ] One-click installer
- [ ] macOS support
