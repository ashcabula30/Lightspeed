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
export function findClaudeExecutable() {
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
// Tools Claude may use without asking: reading, and the whole editing-assistant server. Its local
// tools are locked down, and its Premiere tools ask the editor through a live card for any change
// (the helper does that, mid-reply). Anything else (Bash, PowerShell, Write) needs an approval card.
const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'mcp__editing-assistant'];

// Standing notes for chats started from the panel: facts about this setup Claude can't see.
const WORK_DIR = path.join(APP_DATA, 'tesseract');
const PANEL_NOTES = [
  'You are running inside the Editing Assistant panel in Premiere Pro. The editor approves other tools from approval cards in the chat.',
  'All your tools come from the editing-assistant server. Premiere Pro tools are there under their usual names; ones that change the project',
  'show the editor an approval card and wait for the answer inside the same tool call, so just call them and continue with the result',
  '(if the editor says no, nothing changed: ask what they want instead). Do not try to acknowledge Premiere safety checks yourself unless asked.',
  'For media work use the local tools, which run without approval: tesseract (runs tsrct in a job folder), ffmpeg (trim, retime, strip audio, convert),',
  'write_job_file (e.g. edited document JSON for "project commit --file"), list_job, media_info (ffprobe), grab_frame (a PNG you can Read),',
  'and copy_out (puts a finished file next to the footage without overwriting). Use them instead of Bash or PowerShell, and reuse one job name per piece of work.',
  `Job folders live in ${WORK_DIR} on C:. Never put .tsrct projects on the E: drive: it is exFAT, and Tesseract fails there with "Access is denied" on every save after the first.`,
].join(' ');

export class ClaudeChat {
  constructor({ workdir, onEvent }) {
    this.workdir = workdir;
    this.onEvent = onEvent;
    this.sessionId = null;
    this.proc = null;
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

  get busy() { return !!this.proc; }

  reset() {
    this.stop();
    this.sessionId = null;
  }

  stop() {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }

  // extraTools: tools the editor approved for this reply, on top of the read-only set.
  async send(text, extraTools = []) {
    if (this.proc) throw new Error('Claude is still answering the previous message.');
    const exe = await findClaudeExecutable();
    if (!exe) throw new Error('Claude Code was not found. Install it and sign in, then refresh the setup checklist.');

    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--append-system-prompt', PANEL_NOTES, '--mcp-config', MCP_CONFIG, '--strict-mcp-config',
      '--allowedTools', ...READ_ONLY_TOOLS, ...extraTools];
    if (this.sessionId) args.push('--resume', this.sessionId);

    // A Premiere edit can wait on the editor's approval card, so give tool calls up to 30 minutes.
    const env = { ...process.env, MCP_TOOL_TIMEOUT: String(30 * 60 * 1000) };
    const proc = spawn(exe, args, { cwd: this.workdir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    // The prompt goes in on stdin, never as a command-line argument.
    proc.stdin.end(text);

    let buffer = '';
    let stderr = '';
    // The final result arrives before the process exits (hooks still run), so hold
    // "done" until exit; otherwise the next message could overlap this session.
    let result = null;
    proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'result') result = ev;
        else this.handle(ev);
      }
    });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('close', (code) => {
      if (this.proc === proc) this.proc = null;
      if (result) {
        if (result.session_id) this.sessionId = result.session_id;
        this.onEvent({ type: 'chat-done', isError: !!result.is_error, error: result.is_error ? result.result : null,
          durationMs: result.duration_ms, denied: (result.permission_denials || []).map((d) => d.tool_name),
          deniedDetails: (result.permission_denials || []).map((d) => ({ tool: d.tool_name, input: summarizeInput(d.tool_input) || briefJson(d.tool_input) })) });
      } else {
        this.onEvent({ type: 'chat-error', error: code === null ? 'Stopped.' : (stderr.trim().split('\n').pop() || `Claude Code exited with code ${code}.`) });
      }
    });
    proc.on('error', (err) => {
      if (this.proc === proc) this.proc = null;
      this.onEvent({ type: 'chat-error', error: `Could not start Claude Code: ${err.message}` });
    });
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

function briefJson(input) {
  try { return JSON.stringify(input || {}).slice(0, 160); } catch { return ''; }
}

function summarizeInput(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.file_path || input.path || input.pattern || input.query || input.url || input.command || input.description || '';
  return String(v).slice(0, 120);
}
