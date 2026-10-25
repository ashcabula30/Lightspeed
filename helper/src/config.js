// Per-machine settings in helper/config.json (not committed); config.example.json shows the shape.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(here, '..', 'config.json');

const DEFAULTS = {
  // Folder Claude Code runs in. Its CLAUDE.md and project settings apply to panel chats.
  workdir: os.homedir(),
};

export function loadConfig() {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* no config yet: defaults */ }
  const cfg = { ...DEFAULTS, ...user };
  if (!fs.existsSync(cfg.workdir)) {
    console.warn(`[helper] workdir ${cfg.workdir} does not exist; using ${DEFAULTS.workdir}`);
    cfg.workdir = DEFAULTS.workdir;
  }
  // Client guides and QA notes come from the knowledge base (its clients/ folder).
  if (!cfg.knowledgeBase) cfg.knowledgeBase = path.join(cfg.workdir, 'knowledge-base');
  return cfg;
}
