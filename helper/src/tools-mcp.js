// Editing Assistant tools for the panel's chat: the only MCP server a panel chat gets.
// - Local tools, safe to allow without asking because each is locked down: Tesseract, ffmpeg and
//   frame grabs write only inside a job folder on C: (never the exFAT E: drive, where Tesseract
//   can't save), footage is only ever read, and copy_out never overwrites a file.
// - Premiere tools, passed through the helper's single long-lived Premiere connection (so a chat
//   never opens and drops its own, which made Premiere ask for safety checks). The helper runs
//   read-only ones straight away and shows a live approval card for anything that changes the project.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';
import { tesseractExe } from './checks.js';
import { APP_DATA } from './paths.js';

export const WORK_DIR = path.join(APP_DATA, 'tesseract');
const HELPER_URL = `ws://127.0.0.1:${process.env.EA_PORT || 7790}/panel`;

// Tesseract commands the chat may run (no telemetry settings).
const ALLOWED = new Set(['project', 'preview', 'filmstrip', 'export', 'help']);
// Tesseract flags whose value is written to: these must stay inside the job folder.
const WRITE_FLAGS = new Set(['-p', '--project', '-o', '--output']);
// Tesseract flags whose value is only read: these must be existing files.
const READ_FLAGS = new Set(['--file', '--actions']);
const MEDIA = new Set(['.mp4', '.mov', '.png', '.jpg', '.jpeg', '.wav', '.mp3', '.m4a', '.aac', '.mxf', '.gif', '.webm']);
const TEXT = new Set(['.json', '.txt', '.md']);

function run(cmd, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// A job folder under WORK_DIR, created on first use. Names are plain so they can't climb out.
function jobDir(job) {
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$/.test(String(job))) throw new Error('Job names use letters, numbers, spaces, - and _ (up to 60).');
  const dir = path.join(WORK_DIR, job);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function inside(dir, p) {
  const full = path.resolve(dir, p);
  const rel = path.relative(dir, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`"${p}" must be a file inside the job folder ${dir}.`);
  return full;
}

// "project create --project 'my clip.tsrct'" -> ['project', 'create', '--project', 'my clip.tsrct']
export function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
const asArgs = (a) => (Array.isArray(a) ? a.map(String) : splitArgs(String(a || '')));

// Checks every Tesseract argument, so the command can't write anywhere but the job folder.
export function checkTesseractArgs(args, dir) {
  if (!args.length || !ALLOWED.has(args[0])) throw new Error(`The first argument must be one of: ${[...ALLOWED].join(', ')}.`);
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    const [flag, inline] = a.startsWith('-') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    if (!WRITE_FLAGS.has(flag) && !READ_FLAGS.has(flag)) continue;
    const value = inline !== null ? inline : args[++i];
    if (value === undefined) throw new Error(`${flag} needs a value.`);
    if (WRITE_FLAGS.has(flag)) inside(dir, value);
    else if (!fs.existsSync(path.resolve(dir, value))) throw new Error(`${flag} ${value}: file not found.`);
  }
}

// ffmpeg: inputs (-i) can be anywhere and must exist; every other file argument is an output
// and must be inside the job folder. Anything that looks like a media file counts as a file.
export function checkFfmpegArgs(args, dir) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-i') {
      const input = args[++i];
      if (input === undefined || !fs.existsSync(path.resolve(dir, input))) throw new Error(`-i ${input}: file not found.`);
      continue;
    }
    if (!a.startsWith('-') && MEDIA.has(path.extname(a).toLowerCase())) inside(dir, a);
  }
  if (!args.includes('-i')) throw new Error('ffmpeg needs at least one -i input.');
}

const ok = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
const str = (description) => ({ type: 'string', description });
const argsSchema = (what) => ({ anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }],
  description: `${what} arguments, without the program name: a list, or one string (quote paths with spaces).` });

// ---------- local tools ----------
const LOCAL = {
  tesseract: {
    description: `Run the Tesseract CLI (tsrct) inside a job folder under ${WORK_DIR}. Use this instead of Bash or PowerShell for Tesseract. `
      + 'e.g. args ["project","create","--project","clip.tsrct"]. Projects, previews, filmstrips and exports must use paths inside the job folder '
      + '(relative paths are fine); footage given with --file can be anywhere and is only read. Commands: project, preview, filmstrip, export, help.',
    inputSchema: { type: 'object', properties: { job: str('Job folder name, e.g. "MG2-extend". Reuse it for every step of one piece of work.'), args: argsSchema('tsrct') }, required: ['job', 'args'] },
    async run({ job, args }) {
      const exe = tesseractExe();
      if (!exe) return fail('Tesseract is not installed (see the panel Setup checklist).');
      const dir = jobDir(job);
      const a = asArgs(args);
      checkTesseractArgs(a, dir);
      const r = await run(exe, a, dir, 30 * 60 * 1000);
      const out = [`job folder: ${dir}`, `exit code: ${r.code}`, r.stdout.trim() && `stdout:\n${r.stdout.trim().slice(-12000)}`, r.stderr.trim() && `stderr:\n${r.stderr.trim().slice(-6000)}`];
      return { ...ok(out.filter(Boolean).join('\n')), isError: r.code !== 0 };
    },
  },
  ffmpeg: {
    description: 'Run ffmpeg in a job folder, e.g. to trim, retime, strip audio or convert a clip. Use this instead of Bash. '
      + 'Inputs (-i) can be anywhere and are only read; output files must be inside the job folder (relative paths are fine). Existing outputs there are overwritten.',
    inputSchema: { type: 'object', properties: { job: str('Job folder name.'), args: argsSchema('ffmpeg') }, required: ['job', 'args'] },
    async run({ job, args }) {
      const dir = jobDir(job);
      const a = asArgs(args).filter((x) => x !== '-y' && x !== '-n' && x !== 'ffmpeg');
      checkFfmpegArgs(a, dir);
      const r = await run('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-y', ...a], dir, 60 * 60 * 1000);
      return { ...ok([`job folder: ${dir}`, `exit code: ${r.code}`, r.stderr.trim() && `stderr:\n${r.stderr.trim().slice(-6000)}`].filter(Boolean).join('\n')), isError: r.code !== 0 };
    },
  },
  write_job_file: {
    description: 'Write a text file (.json, .txt or .md) into a job folder, e.g. an edited Tesseract document for "project commit --file". Overwrites only inside that job folder.',
    inputSchema: { type: 'object', properties: { job: str('Job folder name.'), name: str('File name inside the job folder, e.g. "editable.json".'), content: str('File contents.') }, required: ['job', 'name', 'content'] },
    async run({ job, name, content }) {
      const file = inside(jobDir(job), name);
      if (!TEXT.has(path.extname(file).toLowerCase())) return fail('Only .json, .txt and .md files can be written.');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(content), 'utf8'); // no BOM: Tesseract rejects JSON that starts with one
      return ok(`Wrote ${file} (${Buffer.byteLength(String(content))} bytes).`);
    },
  },
  list_job: {
    description: 'List the files in a job folder (name, size, modified time).',
    inputSchema: { type: 'object', properties: { job: str('Job folder name.') }, required: ['job'] },
    async run({ job }) {
      const dir = jobDir(job);
      const rows = [];
      const walk = (d, prefix) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p, `${prefix}${e.name}/`);
          else { const st = fs.statSync(p); rows.push(`${prefix}${e.name}  ${st.size} bytes  ${st.mtime.toISOString()}`); }
        }
      };
      walk(dir, '');
      return ok(`${dir}\n${rows.join('\n') || '(empty)'}`);
    },
  },
  media_info: {
    description: 'Read a video or audio file\'s duration, streams, resolution and frame rate (ffprobe). Read-only.',
    inputSchema: { type: 'object', properties: { file: str('Absolute path to the media file.') }, required: ['file'] },
    async run({ file }) {
      if (!fs.existsSync(file)) return fail(`Not found: ${file}`);
      const r = await run('ffprobe', ['-v', 'error', '-show_entries',
        'format=duration,size:stream=index,codec_type,codec_name,width,height,r_frame_rate,duration,sample_rate,channels', '-of', 'json', file], os.tmpdir(), 60000);
      return r.code ? fail(r.stderr.trim() || 'ffprobe failed') : ok(r.stdout.trim());
    },
  },
  grab_frame: {
    description: 'Save one frame of a video as a PNG in the job folder, to look at with the Read tool. The source is only read.',
    inputSchema: { type: 'object', properties: { job: str('Job folder name.'), file: str('Absolute path to the video.'), seconds: { type: 'number', minimum: 0, description: 'Time in the video, in seconds.' } }, required: ['job', 'file', 'seconds'] },
    async run({ job, file, seconds }) {
      if (!fs.existsSync(file)) return fail(`Not found: ${file}`);
      const dir = jobDir(job);
      const t = Number(seconds) || 0;
      const out = path.join(dir, 'frames', `${path.parse(file).name}_${t.toFixed(2)}s.png`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const r = await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', out], dir, 120000);
      return r.code ? fail(r.stderr.trim() || 'ffmpeg failed') : ok(out);
    },
  },
  copy_out: {
    description: 'Copy a finished file (video, image or audio) from a job folder to another folder, e.g. next to the project\'s footage. '
      + 'Never overwrites: if the name is taken it adds " (2)", " (3)" and so on. Returns the new path.',
    inputSchema: { type: 'object', properties: { job: str('Job folder name.'), file: str('File inside the job folder.'), destination_folder: str('Existing folder to copy into.') }, required: ['job', 'file', 'destination_folder'] },
    async run({ job, file, destination_folder }) {
      const src = inside(jobDir(job), file);
      if (!fs.existsSync(src)) return fail(`Not found in the job folder: ${file}`);
      const ext = path.extname(src).toLowerCase();
      if (!MEDIA.has(ext)) return fail(`Only media files can be copied out (${[...MEDIA].join(', ')}).`);
      if (!fs.existsSync(destination_folder) || !fs.statSync(destination_folder).isDirectory()) return fail(`Folder not found: ${destination_folder}`);
      const base = path.parse(src).name;
      let dest = path.join(destination_folder, `${base}${ext}`);
      for (let n = 2; fs.existsSync(dest); n++) dest = path.join(destination_folder, `${base} (${n})${ext}`);
      fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
      return ok(dest);
    },
  },
};

// ---------- the helper connection (for Premiere tools) ----------
let socket = null;
let nextId = 1;
const waiting = new Map();

function helper() {
  if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(HELPER_URL);
    ws.on('open', () => { socket = ws; resolve(ws); });
    ws.on('error', (err) => reject(new Error(`The Editing Assistant helper isn't reachable (${err.message}).`)));
    ws.on('close', () => {
      if (socket === ws) socket = null;
      for (const [, w] of waiting) w.reject(new Error('Lost the connection to the Editing Assistant helper.'));
      waiting.clear();
    });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      const w = msg.id && waiting.get(msg.id);
      if (w && (msg.type === 'premiere-tools-result' || msg.type === 'premiere-call-result' || msg.type === 'error')) {
        waiting.delete(msg.id);
        if (msg.type === 'error') w.reject(new Error(msg.error));
        else w.resolve(msg);
      }
    });
  });
}

async function ask(type, extra) {
  const ws = await helper();
  const id = `tools-${nextId++}`;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type, id, ...extra }));
  });
}

let premiereTools = null;
async function getPremiereTools() {
  if (premiereTools) return premiereTools;
  const r = await ask('premiere-tools', {});
  premiereTools = new Map(r.tools.map((t) => [t.name, t]));
  return premiereTools;
}

// ---------- MCP server ----------
const server = new Server({ name: 'editing-assistant', version: '0.2.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = Object.entries(LOCAL).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema }));
  try {
    for (const t of (await getPremiereTools()).values()) {
      if (LOCAL[t.name]) continue;
      tools.push({ name: t.name, description: `Premiere Pro: ${t.description || t.name}`, inputSchema: t.inputSchema || { type: 'object' } });
    }
  } catch (err) {
    console.error('[editing-assistant tools] Premiere tools unavailable:', err.message);
  }
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (LOCAL[name]) return await LOCAL[name].run(args);
    const r = await ask('premiere-call', { tool: name, args });
    return { content: r.content || [], isError: !!r.isError };
  } catch (err) {
    return fail(err.message);
  }
});

// Started by Claude Code as a stdio MCP server (see claude.js); importing it only exposes helpers.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  await server.connect(new StdioServerTransport());
}
