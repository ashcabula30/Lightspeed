// Renders a template with the Tesseract CLI. A base project holding the font and backgrounds is built
// once per graphics config and copied for every render, so backgrounds are imported only once.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findTesseract, REQUIRED_TESSERACT } from '../checks.js';
import { TEMPLATES } from './templates.js';

const WORK_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.cache'), 'EditingAssistant', 'tesseract');

function run(exe, args, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(`Tesseract: ${String(stderr || err.message).trim().split('\n').slice(-3).join(' ')}`)) : resolve(String(stdout)));
  });
}
const lastJson = (out) => JSON.parse(out.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop());

async function tsrctPath() {
  for (const exe of findTesseract()) {
    const v = await run(exe, ['--version'], 20000).catch(() => '');
    if (v.includes(REQUIRED_TESSERACT)) return exe;
  }
  throw new Error(`Tesseract ${REQUIRED_TESSERACT} is not installed (see the setup checklist).`);
}

// Base project with the font and every configured background, rebuilt when the config changes.
async function baseProject(exe, graphics) {
  if (!graphics.fontFile || !fs.existsSync(graphics.fontFile)) throw new Error('graphics.fontFile in config.json is missing or not found.');
  const key = crypto.createHash('sha1').update(JSON.stringify(graphics)).digest('hex').slice(0, 12);
  const proj = path.join(WORK_DIR, `base-${key}.tsrct`);
  const meta = path.join(WORK_DIR, `base-${key}.json`);
  if (fs.existsSync(proj) && fs.existsSync(meta)) return { proj, meta: JSON.parse(fs.readFileSync(meta, 'utf8')) };

  fs.mkdirSync(WORK_DIR, { recursive: true });
  const tmp = `${proj}.building.tsrct`;
  fs.rmSync(tmp, { force: true });
  await run(exe, ['project', 'create', '--project', tmp]);
  const font = lastJson(await run(exe, ['project', 'import-font', '--project', tmp, '--file', graphics.fontFile]));
  const bgs = {};
  for (const [look, file] of Object.entries(graphics.backgrounds || {})) {
    if (!file || !fs.existsSync(file)) continue;
    const r = lastJson(await run(exe, ['project', 'import-video', '--project', tmp, '--file', file, '--asset-id', `bg-${look}`]));
    bgs[look] = { assetId: r.assetId, durationMs: r.durationMs };
  }
  fs.renameSync(tmp, proj);
  const m = { font: { family: font.fontFamily, style: font.fontStyle }, bgs };
  fs.writeFileSync(meta, JSON.stringify(m));
  return { proj, meta: m };
}

// spec.kind: 'card' | 'keywords' | 'quote'. Returns { file, durationSeconds, transparent, info }.
export async function renderGraphic(spec, graphics, { outDir, fps = 30, onStep = () => {} }) {
  const build = TEMPLATES[spec.kind];
  if (!build) throw new Error(`Unknown graphic type: ${spec.kind}`);
  const exe = await tsrctPath();
  onStep('Preparing Tesseract');
  const base = await baseProject(exe, graphics);
  const built = build(spec, base.meta.font, base.meta.bgs);

  const id = `${spec.kind}-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}-${crypto.randomBytes(2).toString('hex')}`;
  const jobDir = path.join(WORK_DIR, 'jobs', id);
  fs.mkdirSync(jobDir, { recursive: true });
  const proj = path.join(jobDir, `${id}.tsrct`);
  fs.copyFileSync(base.proj, proj);
  const editable = path.join(jobDir, 'editable.json');
  await run(exe, ['project', 'checkout', '--project', proj, '--output', editable]);
  const doc = JSON.parse(fs.readFileSync(editable, 'utf8'));
  doc.dimensions = { width: 1920, height: 1080 };
  doc.duration = Math.ceil(spec.durationSeconds) + 1;
  doc.composition.layers = [built.layer];
  doc.composition.dynamics = { entries: built.dyn };
  fs.writeFileSync(editable, JSON.stringify(doc));
  await run(exe, ['project', 'commit', '--project', proj, '--file', editable]);

  onStep(`Rendering ${spec.kind} (${spec.durationSeconds}s)`);
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${id}.${built.transparent ? 'mov' : 'mp4'}`);
  const args = ['export', '--project', proj, '--fx-solo', 'main:100', '--fps', String(Math.round(fps)), '--output', file];
  if (built.transparent) args.splice(1, 0, '--format', 'prores');
  await run(exe, args, 15 * 60 * 1000);
  if (!fs.existsSync(file)) throw new Error('Tesseract finished but no file was written.');
  // Keep the editable project next to the render so it can be opened and tweaked later.
  fs.copyFileSync(proj, file.replace(/\.(mp4|mov)$/, '.tsrct'));
  fs.rmSync(jobDir, { recursive: true, force: true });
  return { file, durationSeconds: spec.durationSeconds, transparent: built.transparent, typeMs: built.typeMs || 0, pops: built.pops || [] };
}
