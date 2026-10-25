// Captions from the auto-cut transcript: groups the (already cut) timeline's words into short cues,
// writes an SRT and puts it on a new caption track. Reuses the cached whisper transcript.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { call } from './premiere.js';
import { readSequenceAudio } from './autocut/index.js';

const OUT_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.cache'), 'EditingAssistant', 'captions');
const FILLERS = new Set(['um', 'uh', 'umm', 'uhh', 'er', 'ah', 'hmm', 'mm']);

export const DEFAULT_CAPTIONS = {
  wordsPerCue: 4,     // most clients want 3-4 words on screen
  maxCueSeconds: 3,
  uppercase: false,
  stripPunctuation: true,
};

const clean = (t) => t.toLowerCase().replace(/[^a-z']/g, '');

// words: [{ text, t }] on timeline time. Returns [{ start, end, text }].
export function buildCues(words, opts = {}) {
  const o = { ...DEFAULT_CAPTIONS, ...opts };
  const ws = words.filter((w) => w.text && !FILLERS.has(clean(w.text)));
  // Phrases end at a sentence end or a pause; each phrase splits into evenly sized cues so
  // no cue is left with a single stranded word ("apply warm whenever you" / "can").
  const phrases = [];
  let cur = [];
  ws.forEach((w, i) => {
    if (cur.length && w.t - cur[cur.length - 1].t > 0.8) { phrases.push(cur); cur = []; }
    cur.push(w);
    if (/[.?!,]["']?$/.test(w.text) || i === ws.length - 1) { phrases.push(cur); cur = []; }
  });
  const cues = [];
  for (const p of phrases) {
    const n = Math.ceil(p.length / o.wordsPerCue);
    const size = Math.ceil(p.length / n);
    for (let i = 0; i < p.length; i += size) {
      const chunk = p.slice(i, i + size);
      // Very slow speech: split again so a cue never sits on screen too long.
      if (chunk.length > 1 && chunk[chunk.length - 1].t - chunk[0].t > o.maxCueSeconds) {
        const half = Math.ceil(chunk.length / 2);
        cues.push(chunk.slice(0, half), chunk.slice(half));
      } else cues.push(chunk);
    }
  }
  return cues.map((c, i) => {
    const next = cues[i + 1];
    const lastT = c[c.length - 1].t;
    // Words carry start times only: hold until the next cue, but not long into a pause.
    const end = next ? Math.min(next[0].t, lastT + 0.7) : lastT + 0.7;
    let text = c.map((w) => w.text).join(' ');
    if (o.stripPunctuation) text = text.replace(/[.,!?;:"]/g, '').replace(/\s+/g, ' ').trim();
    if (o.uppercase) text = text.toUpperCase();
    return { start: c[0].t, end: Math.max(end, c[0].t + 0.3), text };
  });
}

function srtTime(s) {
  const ms = Math.round(s * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

export function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
}

export async function makeCaptions(opts, onStep = () => {}) {
  const { sequence, timeline } = await readSequenceAudio(null, onStep);
  onStep('Grouping words into captions');
  const cues = buildCues(timeline.words, opts);
  if (!cues.length) throw new Error('No words found on A1 to caption.');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const safe = sequence.name.replace(/[^\w -]+/g, '').trim() || 'sequence';
  const file = path.join(OUT_DIR, `${safe} captions ${stamp}.srt`);
  fs.writeFileSync(file, toSrt(cues), 'utf8');

  onStep('Importing the captions into Premiere');
  await call('import_media', { file_paths: [file], suppress_ui: true });
  await call('set_active_sequence', { sequence_id: sequence.id });
  onStep('Adding the caption track');
  await call('create_caption_track', { action: 'import', item_id: path.basename(file), start_seconds: 0, caption_format: 'subtitle' });
  return { sequence: sequence.name, cues: cues.length, file, preview: cues.slice(0, 3).map((c) => c.text) };
}
