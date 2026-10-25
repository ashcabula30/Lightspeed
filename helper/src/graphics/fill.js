// "Fill from prompt": Claude turns a description, or what is being said at the playhead, into template fields.
import { call } from '../premiere.js';
import { cachedWords } from '../autocut/media.js';
import { askOnce } from '../claude.js';

const SCHEMAS = {
  card: '{"kind":"card","text":"UPPERCASE STATEMENT, max ~70 characters, use \\n for one line break","highlight":"ONE OR TWO WORDS taken exactly from text, or null","look":"dark | light | red","durationSeconds":3.5}',
  keywords: '{"kind":"keywords","words":[{"text":"ONE TO THREE WORDS","red":false}],"durationSeconds":4}  (2 to 6 words; mark at most one as red: the key or warning item)',
  quote: '{"kind":"quote","text":"SHORT LINE THE SPEAKER QUOTES, max ~45 characters, no quote marks","durationSeconds":3}',
};

// What is being said within ±seconds of the playhead, from transcripts Auto-cut already made.
async function speechAroundPlayhead(span = 8) {
  const state = await call('get_premiere_state');
  const seq = state.activeSequence;
  if (!seq) return null;
  const t = state.playheadSeconds || 0;
  const info = await call('get_full_sequence_info', { sequence_id: seq.id, track_type: 'audio', track_index: 0, start_seconds: Math.max(0, t - span), end_seconds: t + span, clip_limit: 50 });
  const track = (info.audioTracks || []).find((tr) => tr.index === 0);
  const words = [];
  for (const c of (track && track.clips) || []) {
    const src = c.sourceMediaPath && cachedWords(c.sourceMediaPath);
    if (!src) continue;
    for (const w of src) {
      const tl = c.startSeconds + (w.t - c.inPointSeconds);
      if (w.t >= c.inPointSeconds && w.t < c.outPointSeconds && tl >= t - span && tl <= t + span) words.push({ tl, text: w.text });
    }
  }
  if (!words.length) return null;
  words.sort((a, b) => a.tl - b.tl);
  return { playhead: t, text: words.map((w) => w.text).join(' ') };
}

function extractJson(text) {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Claude did not return the graphic fields.');
  return JSON.parse(text.slice(start, end + 1));
}

export async function fillSpec(kind, prompt, workdir) {
  if (!SCHEMAS[kind]) throw new Error(`Unknown graphic type: ${kind}`);
  const speech = await speechAroundPlayhead().catch(() => null);
  const lines = [
    'You fill in one on-screen graphic for a video edit. Reply with ONLY a JSON object, no prose, no code fences.',
    `Shape: ${SCHEMAS[kind]}`,
    'House style: short, punchy, all caps, wording close to what the speaker says. Durations 2.5 to 5 seconds.',
  ];
  if (speech) lines.push(`What the speaker says around the playhead (${speech.playhead.toFixed(1)}s): "${speech.text}"`);
  else lines.push('No transcript is available at the playhead; rely on the request.');
  lines.push(`Request: ${prompt && prompt.trim() ? prompt.trim() : 'Make the best graphic for what is being said at the playhead.'}`);
  const spec = extractJson(await askOnce(lines.join('\n'), workdir));
  spec.kind = kind;
  spec.durationSeconds = Math.min(10, Math.max(1.5, Number(spec.durationSeconds) || 3.5));
  return { spec, usedTranscript: !!speech };
}
