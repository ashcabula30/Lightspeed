// Dependency checks shown in the panel's setup checklist.
// Each check returns { id, label, state: 'ok' | 'warn' | 'missing', detail, fix }.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const REQUIRED_TESSERACT = '0.4.0';
const isWin = process.platform === 'win32';
const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

function run(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    // shell:true on Windows so .cmd shims such as claude.cmd resolve from PATH.
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, shell: isWin && !/\.exe$/i.test(cmd) },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), err }));
  });
}

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

async function checkFfmpeg() {
  const r = await run('ffmpeg', ['-hide_banner', '-version']);
  if (!r.ok) return { id: 'ffmpeg', label: 'ffmpeg', state: 'missing', detail: 'ffmpeg was not found on PATH.', fix: 'install-ffmpeg' };
  const v = (r.stdout.match(/ffmpeg version (\S+)/) || [])[1] || 'unknown';
  return { id: 'ffmpeg', label: 'ffmpeg', state: 'ok', detail: `Version ${v}` };
}

export function whisperModelPath() {
  return path.join(isWin ? path.join(localAppData, 'whisper.cpp') : path.join(os.homedir(), '.local', 'share', 'whisper.cpp'), 'models', 'ggml-small.en.bin');
}

export function findWhisper() {
  const roots = isWin ? [path.join(localAppData, 'whisper.cpp')] : [path.join(os.homedir(), '.local', 'share', 'whisper.cpp'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const root of roots) {
    if (!exists(root)) continue;
    const direct = path.join(root, isWin ? 'whisper-cli.exe' : 'whisper-cli');
    if (exists(direct)) return direct;
    for (const build of fs.readdirSync(root)) {
      const candidate = path.join(root, build, isWin ? 'Release' : '', isWin ? 'whisper-cli.exe' : 'whisper-cli');
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

async function checkWhisper() {
  const exe = findWhisper();
  const model = whisperModelPath();
  if (!exe) return { id: 'whisper', label: 'Speech engine (whisper.cpp)', state: 'missing', detail: 'whisper-cli was not found.', fix: 'install-whisper' };
  if (!exists(model)) return { id: 'whisper', label: 'Speech engine (whisper.cpp)', state: 'warn', detail: 'whisper-cli found, but the small.en speech model is missing.', fix: 'download-model' };
  return { id: 'whisper', label: 'Speech engine (whisper.cpp)', state: 'ok', detail: `Ready (${path.basename(path.dirname(path.dirname(exe)))}, small.en model)`, paths: { exe, model } };
}

function findTesseract() {
  const candidates = [];
  if (isWin) {
    const pub = path.join(localAppData, 'Tesseract', 'public-cli');
    if (exists(pub)) for (const d of fs.readdirSync(pub)) candidates.push(path.join(pub, d, 'bin', 'tsrct.exe'));
  } else {
    candidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'Tesseract', 'bin', 'tsrct'));
    candidates.push(path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'Tesseract', 'bin', 'tsrct'));
  }
  return candidates.filter(exists);
}

async function checkTesseract() {
  const found = findTesseract();
  const label = 'Tesseract (motion graphics)';
  if (!found.length) return { id: 'tesseract', label, state: 'missing', detail: 'Not installed. Motion-graphics features stay off until it is.', fix: 'install-tesseract' };
  // Prefer the pinned version when several are installed.
  for (const exe of found) {
    const r = await run(exe, ['--version']);
    const v = (r.stdout.match(/tsrct (\S+)/) || [])[1];
    if (v === REQUIRED_TESSERACT) return { id: 'tesseract', label, state: 'ok', detail: `Version ${v}`, paths: { exe } };
  }
  const r = await run(found[0], ['--version']);
  const v = (r.stdout.match(/tsrct (\S+)/) || [])[1] || 'unknown';
  return { id: 'tesseract', label, state: 'warn', detail: `Version ${v} found; this panel needs ${REQUIRED_TESSERACT}.`, fix: 'update-tesseract' };
}

async function checkClaude() {
  const label = 'Claude Code';
  const ver = await run('claude', ['--version']);
  if (!ver.ok) return { id: 'claude', label, state: 'missing', detail: 'Claude Code is not installed.', fix: 'install-claude' };
  const version = (ver.stdout.match(/^(\S+)/) || [])[1] || 'unknown';
  const st = await run('claude', ['auth', 'status', '--json']);
  let auth = null;
  try { auth = JSON.parse(st.stdout); } catch { /* not JSON: treat as signed out */ }
  if (!auth || !auth.loggedIn) return { id: 'claude', label, state: 'warn', detail: `Version ${version}, not signed in.`, fix: 'connect-claude' };
  const plan = auth.subscriptionType ? `${auth.subscriptionType} plan` : (auth.authMethod || 'signed in');
  return { id: 'claude', label, state: 'ok', detail: `Connected as ${auth.email || 'unknown'} (${plan}), v${version}` };
}

export async function runChecks() {
  const results = await Promise.all([checkClaude(), checkTesseract(), checkWhisper(), checkFfmpeg()]);
  return { checkedAt: new Date().toISOString(), platform: process.platform, checks: results };
}

// `npm run check` prints the checklist without starting the server.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runChecks().then((r) => {
    for (const c of r.checks) console.log(`${{ ok: 'OK  ', warn: 'WARN', missing: 'MISS' }[c.state]}  ${c.label}: ${c.detail}`);
  });
}
