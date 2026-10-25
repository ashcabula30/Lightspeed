// Audio extraction, loudness frames and whisper transcription for one source file, cached on disk.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findWhisper, whisperModelPath } from '../checks.js';

export const FRAME_S = 0.02; // loudness frame: 20 ms
const CACHE_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.cache'), 'EditingAssistant', 'cache');
// Nudges whisper to keep disfluencies; it still drops most "um"s, which the plan finds from the audio.
const WHISPER_PROMPT = 'Um, so, uh, I mean, like, you know, uh, I- I think we, um, we should start.';

// signal: an AbortSignal; Stop kills ffmpeg/whisper mid-run.
function run(cmd, args, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, signal }, (err, stdout, stderr) => {
      if (err && err.name === 'AbortError') return reject(stopped());
      if (err) return reject(new Error(`${path.basename(cmd)} failed: ${String(stderr || err.message).trim().split('\n').pop()}`));
      resolve(stdout);
    });
  });
}

// Thrown when the editor presses Stop; the server reports it as stopped, not as an error.
export function stopped() {
  const e = new Error('Stopped.');
  e.stopped = true;
  return e;
}
export function checkStop(signal) {
  if (signal && signal.aborted) throw stopped();
}

function cacheKey(mediaPath) {
  const st = fs.statSync(mediaPath);
  return crypto.createHash('sha1').update(`${mediaPath}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
}

// 16 kHz mono WAV of the whole source, reused while the file is unchanged.
async function extractWav(mediaPath, key, signal) {
  const wav = path.join(CACHE_DIR, `${key}.wav`);
  if (!fs.existsSync(wav)) {
    await run('ffmpeg', ['-v', 'error', '-y', '-i', mediaPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], 30 * 60 * 1000, signal);
  }
  return wav;
}

// RMS in dBFS per 20 ms frame.
function loudnessFrames(wav) {
  const buf = fs.readFileSync(wav);
  const dataStart = buf.indexOf('data') + 8;
  const n = Math.floor((buf.length - dataStart) / 2);
  const win = Math.round(16000 * FRAME_S);
  const db = new Float32Array(Math.floor(n / win));
  for (let f = 0; f < db.length; f++) {
    let s = 0;
    const base = dataStart + f * win * 2;
    for (let j = 0; j < win; j++) { const v = buf.readInt16LE(base + j * 2) / 32768; s += v * v; }
    db[f] = 10 * Math.log10(s / win + 1e-12);
  }
  return db;
}

// Words with a DTW time (seconds into the source). DTW needs flash attention off (-nfa).
async function transcribe(wav, key, signal) {
  const out = path.join(CACHE_DIR, `${key}.words.json`);
  if (fs.existsSync(out)) return JSON.parse(fs.readFileSync(out, 'utf8'));
  const exe = findWhisper();
  if (!exe) throw new Error('whisper.cpp is not installed (see the setup checklist).');
  const base = path.join(CACHE_DIR, `${key}.whisper`);
  await run(exe, ['-m', whisperModelPath(), '-f', wav, '-t', String(Math.max(2, os.cpus().length - 2)), '-nfa', '--dtw', 'small.en',
    '-ojf', '-of', base, '--prompt', WHISPER_PROMPT], 60 * 60 * 1000, signal);
  const j = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8'));
  const words = [];
  for (const seg of j.transcription) {
    for (const t of seg.tokens) {
      if (/^\[_/.test(t.text)) continue;
      const time = t.t_dtw >= 0 ? t.t_dtw / 100 : t.offsets.from / 1000;
      if (/^\s/.test(t.text) || !words.length) words.push({ text: t.text.trim(), t: time });
      else words[words.length - 1].text += t.text; // subword or punctuation joins the previous word
    }
  }
  fs.writeFileSync(out, JSON.stringify(words));
  fs.rmSync(`${base}.json`, { force: true });
  return words;
}

// Everything the planner needs about one source file. onStep(label) reports progress.
export async function analyzeSource(mediaPath, onStep = () => {}, signal) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const key = cacheKey(mediaPath);
  onStep(`Extracting audio: ${path.basename(mediaPath)}`);
  const wav = await extractWav(mediaPath, key, signal);
  checkStop(signal);
  onStep(`Measuring loudness: ${path.basename(mediaPath)}`);
  const db = loudnessFrames(wav);
  const cached = fs.existsSync(path.join(CACHE_DIR, `${key}.words.json`));
  onStep(cached ? `Using cached transcript: ${path.basename(mediaPath)}` : `Transcribing (about 1 min per 6 min of audio): ${path.basename(mediaPath)}`);
  const words = await transcribe(wav, key, signal);
  return { mediaPath, db, words };
}
