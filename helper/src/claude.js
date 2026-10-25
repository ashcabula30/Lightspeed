// Runs Claude Code headless (`claude -p`) on the signed-in user's own plan and turns its
// stream-json output into small events for the panel: text deltas, tool activity,
// usage (5-hour / weekly windows) and a final result. One conversation continues via --resume.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const isWin = process.platform === 'win32';

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

// Tools Claude may use without asking while approvals don't exist yet (read-only).
// Premiere tools are allowed by prefix: these only look at the project, never change it.
const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
  ...['get_*', 'list_*', 'verify_*', 'inspect_*', 'find_*', 'search_*', 'read_*', 'check_*', 'is_*', 'has_*', 'ping']
    .map((p) => `mcp__premiere-pro__${p}`)];

export class ClaudeChat {
  constructor({ workdir, onEvent }) {
    this.workdir = workdir;
    this.onEvent = onEvent;
    this.sessionId = null;
    this.proc = null;
    this.lastUsage = null;
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

  async send(text) {
    if (this.proc) throw new Error('Claude is still answering the previous message.');
    const exe = await findClaudeExecutable();
    if (!exe) throw new Error('Claude Code was not found. Install it and sign in, then refresh the setup checklist.');

    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--allowedTools', ...READ_ONLY_TOOLS];
    if (this.sessionId) args.push('--resume', this.sessionId);

    const proc = spawn(exe, args, { cwd: this.workdir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
          durationMs: result.duration_ms, denied: (result.permission_denials || []).map((d) => d.tool_name) });
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
      case 'rate_limit_event': {
        const info = ev.rate_limit_info || {};
        const w = info.unifiedWindows || {};
        this.lastUsage = {
          status: info.status,
          fiveHour: w.five_hour ? { used: w.five_hour.utilization, resetsAt: w.five_hour.resetsAt } : null,
          sevenDay: w.seven_day ? { used: w.seven_day.utilization, resetsAt: w.seven_day.resetsAt } : null,
          updatedAt: Date.now(),
        };
        this.onEvent({ type: 'usage', usage: this.lastUsage });
        break;
      }
      default:
        break;
    }
  }
}

// A single answer with no tools and no conversation, for small structured jobs (e.g. filling a template).
export async function askOnce(prompt, workdir) {
  const exe = await findClaudeExecutable();
  if (!exe) throw new Error('Claude Code was not found. Install it and sign in, then refresh the setup checklist.');
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, ['-p', '--output-format', 'json'], { cwd: workdir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.stderr.on('data', (c) => { err += c; });
    proc.on('error', (e) => reject(new Error(`Could not start Claude Code: ${e.message}`)));
    proc.on('close', () => {
      try {
        const j = JSON.parse(out);
        if (j.is_error) return reject(new Error(j.result || 'Claude reported an error.'));
        resolve(String(j.result || ''));
      } catch {
        reject(new Error(err.trim().split('\n').pop() || 'Claude Code returned no answer.'));
      }
    });
    proc.stdin.end(prompt);
  });
}

function summarizeInput(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.file_path || input.path || input.pattern || input.query || input.url || input.command || input.description || '';
  return String(v).slice(0, 120);
}
