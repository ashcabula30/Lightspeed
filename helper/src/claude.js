// Runs Claude Code headless (`claude -p`) on the signed-in user's own plan and turns its
// stream-json output into small events for the panel: text deltas, tool activity,
// usage (5-hour / weekly windows) and a final result. One conversation continues via --resume.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_DATA } from './paths.js';

const isWin = process.platform === 'win32';
// Last known plan usage, kept between helper restarts so the meter has numbers before any chat.
const USAGE_FILE = path.join(APP_DATA, 'usage.json');

function loadUsage() {
  try { return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); } catch { return null; }
}
function saveUsage(usage) {
  try {
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usage));
  } catch { /* the meter still works for this session */ }
}

// Claude Code reports usage in a rate_limit_event alongside each reply.
function parseUsage(ev) {
  const info = ev.rate_limit_info || {};
  const w = info.unifiedWindows || {};
  return {
    status: info.status,
    fiveHour: w.five_hour ? { used: w.five_hour.utilization, resetsAt: w.five_hour.resetsAt } : null,
    sevenDay: w.seven_day ? { used: w.seven_day.utilization, resetsAt: w.seven_day.resetsAt } : null,
    updatedAt: Date.now(),
  };
}

// Find the real claude executable so the user's text never passes through a shell.
// Looked up once per helper run (~100 ms each time otherwise); a miss is retried next call.
let exePromise = null;
export function findClaudeExecutable() {
  if (!exePromise) exePromise = lookupClaude().then((exe) => { if (!exe) exePromise = null; return exe; });
  return exePromise;
}

function lookupClaude() {
  return new Promise((resolve) => {
    execFile(isWin ? 'where' : 'which', ['claude'], { windowsHide: true }, (err, stdout) => {
      const hits = String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      for (const hit of hits) {
        if (!isWin) return resolve(hit);
        if (/\.exe$/i.test(hit)) return resolve(hit);
        // npm shim (claude / claude.cmd): the binary lives next to it in node_modules.
        const exe = path.join(path.dirname(hit), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
        if (fs.existsSync(exe)) return resolve(exe);
      }
      resolve(null);
    });
  });
}

// The panel's own tool server (tools-mcp.js): Tesseract and media tools locked to job folders on C:.
const TOOLS_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tools-mcp.js');
const MCP_CONFIG = JSON.stringify({ mcpServers: { 'editing-assistant': { command: process.execPath, args: [TOOLS_SERVER] } } });

// Standing notes for chats started from the panel: facts about this setup Claude can't see.
const WORK_DIR = path.join(APP_DATA, 'tesseract');
const PANEL_NOTES = [
  'You are running inside the Editing Assistant panel in Premiere Pro. Tools run without approval prompts, so act carefully:',
  'before a large or risky timeline change, duplicate the sequence as a backup. Premiere Pro tools come from the editing-assistant server under their usual names.',
  'Do not acknowledge Premiere safety checks yourself unless asked. For media work prefer the local tools: tesseract (runs tsrct in a job folder),',
  'ffmpeg (trim, retime, strip audio, convert), write_job_file (e.g. edited document JSON for "project commit --file"), list_job, media_info (ffprobe),',
  'grab_frame (a PNG you can Read) and copy_out (puts a finished file next to the footage without overwriting). Reuse one job name per piece of work.',
  `Job folders live in ${WORK_DIR} on C:. Never put .tsrct projects on the E: drive: it is exFAT, and Tesseract fails there with "Access is denied" on every save after the first.`,
].join(' ');

export class ClaudeChat {
  constructor({ workdir, onEvent }) {
    this.workdir = workdir;
    this.onEvent = onEvent;
    this.sessionId = null;
    this.proc = null;
    this.procSession = null; // the conversation the live process is on
    this.procFor = null;
    this.turnActive = false;
    this.idleTimer = null;
    this.lastUsage = loadUsage();
    this.checking = null;
  }

  setUsage(usage) {
    this.lastUsage = usage;
    saveUsage(usage);
    this.onEvent({ type: 'usage', usage });
  }

  // Fresh usage numbers without a chat message: one tiny request on the cheapest model, with no
  // tools, no MCP servers and no project files, then read the usage that comes back with it.
  checkUsage() {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      const exe = await findClaudeExecutable();
      if (!exe) throw new Error('Claude Code was not found.');
      return await new Promise((resolve, reject) => {
        const proc = spawn(exe, ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--tools', '', '--strict-mcp-config'],
          { cwd: os.tmpdir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        proc.stdin.end('Reply with the single word OK.');
        let buffer = '', got = null, stderr = '';
        const timer = setTimeout(() => proc.kill(), 60000);
        proc.stdout.on('data', (chunk) => {
          buffer += chunk;
          let nl;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            try {
              const ev = JSON.parse(line);
              if (ev.type === 'rate_limit_event') got = parseUsage(ev);
            } catch { /* not JSON */ }
          }
        });
        proc.stderr.on('data', (chunk) => { stderr += chunk; });
        proc.on('error', (err) => { clearTimeout(timer); reject(err); });
        proc.on('close', () => {
          clearTimeout(timer);
          if (got) { this.setUsage(got); resolve(got); }
          else reject(new Error(stderr.trim().split('\n').pop() || 'Claude Code did not report usage.'));
        });
      });
    })().finally(() => { this.checking = null; });
    return this.checking;
  }

  // One Claude Code process stays alive per chat and takes messages over stdin (stream-json), so
  // its ~5 s session setup (hooks, plugins, settings) is paid once per chat, not once per message.
  // It is started when a chat opens (warm), closed after 10 idle minutes, and restarted after Stop.
  get busy() { return this.turnActive; }

  stop() {
    if (this.proc) this.proc.kill(); // the close handler reports "Stopped." for a reply in progress
  }

  // Start the process for this session ahead of the first message (no-op while a reply runs).
  async warm(sessionId) {
    if (this.turnActive) return;
    this.sessionId = sessionId || null;
    try { await this.ensureProc(); } catch (err) { console.error('[helper] could not pre-start Claude Code:', err.message); }
  }

  async ensureProc() {
    // Reuse when it's this conversation, or when it's a fresh warm process and this is a new chat.
    if (this.proc && (this.sessionId === this.procSession || this.sessionId === this.procFor)) return this.proc;
    if (this.proc) { this.proc.kill(); this.proc = null; } // another chat's conversation
    const exe = await findClaudeExecutable();
    if (!exe) throw new Error('Claude Code was not found. Install it and sign in, then refresh the setup checklist.');

    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--append-system-prompt', PANEL_NOTES, '--mcp-config', MCP_CONFIG, '--strict-mcp-config',
      // Ash's call (2026-10-28): no approval prompts in panel chats, Bash and Premiere edits included.
      '--permission-mode', 'bypassPermissions'];
    if (this.sessionId) args.push('--resume', this.sessionId);

    // Tesseract exports and Premiere jobs can be long: give tool calls up to 30 minutes.
    const env = { ...process.env, MCP_TOOL_TIMEOUT: String(30 * 60 * 1000) };
    const proc = spawn(exe, args, { cwd: this.workdir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stdin.on('error', () => {}); // ignore EPIPE if Claude exits before/during write; handled on close
    this.proc = proc;
    this.procSession = this.sessionId;
    this.procFor = this.sessionId; // what it was started for (null = a new chat), until its first reply
    let buffer = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (this.proc !== proc) continue; // output from a process being replaced
        if (ev.session_id) { this.sessionId = ev.session_id; this.procSession = ev.session_id; }
        if (ev.type === 'result') this.finishTurn(ev);
        else this.handle(ev);
      }
    });
    proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    proc.on('close', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      clearTimeout(this.idleTimer);
      if (this.turnActive) {
        this.turnActive = false;
        this.onEvent({ type: 'chat-error', error: code === null ? 'Stopped.' : (stderr.trim().split('\n').pop() || `Claude Code exited with code ${code}.`) });
      }
    });
    proc.on('error', (err) => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.turnActive) {
        this.turnActive = false;
        this.onEvent({ type: 'chat-error', error: `Could not start Claude Code: ${err.message}` });
      }
    });
    return proc;
  }

  finishTurn(result) {
    if (!this.turnActive) return;
    this.turnActive = false;
    this.procFor = this.procSession; // now it belongs to this conversation only
    this.onEvent({ type: 'chat-done', isError: !!result.is_error, error: result.is_error ? result.result : null, durationMs: result.duration_ms });
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.turnActive) this.stop(); }, 10 * 60 * 1000);
  }

  async send(text) {
    if (this.turnActive) throw new Error('Claude is still answering the previous message.');
    this.turnActive = true;
    clearTimeout(this.idleTimer);
    try {
      const proc = await this.ensureProc();
      // The prompt goes in on stdin as one JSON line, never as a command-line argument.
      proc.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);
    } catch (err) {
      this.turnActive = false;
      throw err;
    }
  }

  handle(ev) {
    if (ev.session_id) this.sessionId = ev.session_id;
    switch (ev.type) {
      case 'stream_event': {
        const e = ev.event;
        if (e && e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') {
          this.onEvent({ type: 'chat-delta', text: e.delta.text });
        } else if (e && e.type === 'content_block_start' && e.content_block && e.content_block.type === 'text') {
          this.onEvent({ type: 'chat-block' });
        }
        break;
      }
      case 'assistant': {
        for (const block of (ev.message && ev.message.content) || []) {
          if (block.type === 'tool_use') this.onEvent({ type: 'chat-tool', name: block.name, input: summarizeInput(block.input) });
        }
        break;
      }
      case 'rate_limit_event':
        this.setUsage(parseUsage(ev));
        break;
      default:
        break;
    }
  }
}

function summarizeInput(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.file_path || input.path || input.pattern || input.query || input.url || input.command || input.description || '';
  return String(v).slice(0, 120);
}
