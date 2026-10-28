// Cut planner (pure functions). Works on the timeline: loudness frames and words are mapped from each
// source clip onto timeline time first, so cuts land where the clips actually sit.
// Rules (proven on Kitsune Module 30): cuts only fall inside real silence; a pause longer than the target
// keeps target/2 of silence on each side; un-transcribed sounds inside pauses (ums, breaths) go;
// "take again" style slates remove the bad attempt through the slate.
import { FRAME_S } from './media.js';

export const DEFAULT_SETTINGS = {
  pauseSeconds: 0.5,
  thresholdDb: 'auto',
  removeRetakes: true,
  removeUms: true,
  slatePhrases: ['take again'],
};

const norm = (t) => t.toLowerCase().replace(/[^a-z0-9']/g, '');

// clips: [{ start, end, inPoint, mediaPath, speed }] from the dialogue track, timeline seconds.
// sources: Map(mediaPath -> {db, words}). A clip at speed 2 plays 2s of source per 1s of timeline.
export function buildTimeline(clips, sources, duration) {
  const frames = new Float32Array(Math.ceil(duration / FRAME_S)).fill(-90);
  const words = [];
  for (const c of clips) {
    const src = sources.get(c.mediaPath);
    if (!src) continue;
    const speed = c.speed || 1;
    const f0 = Math.round(c.start / FRAME_S), f1 = Math.round(c.end / FRAME_S);
    for (let f = f0; f < f1 && f < frames.length; f++) {
      const sf = Math.round((c.inPoint + (f * FRAME_S - c.start) * speed) / FRAME_S);
      if (sf >= 0 && sf < src.db.length) frames[f] = src.db[sf];
    }
    const srcIn = c.inPoint, srcOut = c.inPoint + (c.end - c.start) * speed;
    for (const w of src.words) if (w.t >= srcIn && w.t < srcOut) words.push({ text: w.text, t: c.start + (w.t - srcIn) / speed });
  }
  words.sort((a, b) => a.t - b.t);
  return { frames, words };
}

// Threshold between room tone and speech: 10 dB above the quietest fifth, kept in a sane range.
export function autoThreshold(frames) {
  const real = Array.from(frames).filter((v) => v > -89).sort((a, b) => a - b);
  if (!real.length) return -50;
  const p20 = real[Math.floor(real.length * 0.2)];
  return Math.max(-60, Math.min(-35, Math.round(p20 + 10)));
}

function soundIntervals(frames, threshold) {
  let snd = [], cur = null;
  frames.forEach((v, i) => {
    const t = i * FRAME_S;
    if (v > threshold) {
      if (cur && t - cur.e < 0.12) cur.e = t + FRAME_S; // bridge tiny dips inside a word
      else { cur = { s: t, e: t + FRAME_S, w: [] }; snd.push(cur); }
    }
  });
  return snd.filter((x) => x.e - x.s >= 0.04);
}

function attachWords(words, snd) {
  const nearest = (t) => {
    let best = null, bd = Infinity;
    for (const x of snd) {
      const d = t < x.s ? x.s - t : t > x.e ? t - x.e : 0;
      if (d < bd) { bd = d; best = x; }
      if (x.s > t + 1) break;
    }
    return { best, bd };
  };
  words.forEach((w, i) => {
    const { best, bd } = nearest(w.t);
    if (best && bd <= 0.8) best.w.push(i);
    else { // quiet word below the threshold: protect a small window around it
      const p = { s: Math.max(0, w.t - 0.1), e: w.t + 0.3, w: [i], pseudo: true };
      snd.push(p);
      snd.sort((a, b) => a.s - b.s);
    }
  });
}

function findRetakes(words, slatePhrases) {
  const removed = new Array(words.length).fill(false);
  const retakes = [];
  const slates = slatePhrases.map((p) => p.split(/\s+/).map(norm).filter(Boolean)).filter((s) => s.length);
  for (let k = 0; k < words.length; k++) {
    for (const slate of slates) {
      if (!slate.every((tok, j) => words[k + j] && norm(words[k + j].text) === tok)) continue;
      const r = k + slate.length; // first word of the redo
      if (!words[r]) continue;
      const t0 = norm(words[r].text), t1 = words[r + 1] ? norm(words[r + 1].text) : null;
      let bad = -1;
      for (let i = k - 1; i >= 0 && words[i].t >= words[k].t - 40; i--) {
        if (norm(words[i].text) === t0 && (!t1 || (words[i + 1] && norm(words[i + 1].text) === t1))) { bad = i; break; }
      }
      let confident = true;
      if (bad < 0) { // no matching restart: drop back to the start of the sentence
        confident = false;
        bad = k;
        while (bad > 0 && !/[.?!]$/.test(words[bad - 1].text)) bad--;
      }
      for (let i = bad; i < r; i++) removed[i] = true;
      retakes.push({ at: words[bad].t, removedText: words.slice(bad, r).map((w) => w.text).join(' '),
        keptText: words.slice(r, r + 8).map((w) => w.text).join(' '), confident });
      k = r - 1;
      break;
    }
  }
  return { removed, retakes };
}

// Back-to-back identical sentences with no slate: suggested, never cut automatically.
function findRepeats(words, removed) {
  const sentences = [];
  let cur = [];
  words.forEach((w, i) => {
    if (removed[i]) return;
    cur.push(w);
    if (/[.?!]["']?$/.test(w.text)) { sentences.push(cur); cur = []; }
  });
  const out = [];
  for (let i = 1; i < sentences.length; i++) {
    const a = sentences[i - 1].map((w) => norm(w.text)).join(' '), b = sentences[i].map((w) => norm(w.text)).join(' ');
    const strip = (x) => x.replace(/^(and|so|but) /, '');
    const shorter = strip(a.length < b.length ? a : b), longer = strip(a.length < b.length ? b : a);
    // A redo repeats either the start of the previous sentence or its ending.
    if (shorter.split(' ').length >= 3 && (longer.startsWith(shorter) || longer.endsWith(shorter))) {
      out.push({ at: sentences[i - 1][0].t, text: sentences[i].map((w) => w.text).join(' ') });
    }
  }
  return out;
}

export function planCuts({ frames, words }, settings, fps, duration) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const keep = Math.max(0.1, Number(s.pauseSeconds) || 0.5);
  const threshold = s.thresholdDb === 'auto' ? autoThreshold(frames) : Number(s.thresholdDb);
  const snd = soundIntervals(frames, threshold);
  attachWords(words, snd);
  const { removed, retakes } = s.removeRetakes ? findRetakes(words, s.slatePhrases) : { removed: new Array(words.length).fill(false), retakes: [] };

  for (const x of snd) {
    const kept = x.w.some((i) => !removed[i]), rem = x.w.some((i) => removed[i]);
    // With "remove ums" off, an un-transcribed sound counts as speech and is kept with its pauses.
    x.kind = kept ? 'kept' : rem ? 'removed' : s.removeUms ? 'unworded' : 'kept';
  }
  const keptS = snd.filter((x) => x.kind === 'kept');
  const snapUp = (t) => Math.ceil(t * fps - 1e-6) / fps, snapDn = (t) => Math.floor(t * fps + 1e-6) / fps;
  const gaps = [{ a: { e: 0 }, b: keptS[0] || { s: duration } }]
    .concat(keptS.slice(1).map((b, i) => ({ a: keptS[i], b })))
    .concat(keptS.length ? [{ a: keptS[keptS.length - 1], b: { s: duration } }] : []);

  const cuts = [], longUnworded = [];
  for (const { a, b } of gaps) {
    const junk = snd.filter((x) => x.kind !== 'kept' && x.s >= a.e - 1e-6 && x.e <= b.s + 1e-6);
    const gap = b.s - a.e;
    if (gap <= keep + 1e-6 && !junk.length) continue;
    let L = keep / 2, R = keep / 2;
    if (a.e === 0) { L = 0; R = Math.min(0.3, keep); }
    if (b.s === duration) { R = 0; L = keep; }
    if (junk.length) {
      const js = junk[0].s, je = junk[junk.length - 1].e;
      L = Math.min(L, Math.max(0.04, js - a.e));
      R = Math.min(R, Math.max(0.04, b.s - je));
    }
    const start = snapUp(a.e + L), end = snapDn(b.s - R);
    if (end - start < 2 / fps) continue;
    const uw = junk.filter((x) => x.kind === 'unworded');
    for (const x of uw) if (x.e - x.s >= 0.6) longUnworded.push({ at: x.s, seconds: +(x.e - x.s).toFixed(2) });
    cuts.push({ start: +start.toFixed(4), end: +end.toFixed(4),
      why: junk.some((x) => x.kind === 'removed') ? 'retake' : uw.length ? 'um' : 'pause' });
  }

  const removedSeconds = cuts.reduce((t, c) => t + c.end - c.start, 0);
  return {
    cuts,
    threshold,
    stats: {
      cuts: cuts.length,
      retakes: cuts.filter((c) => c.why === 'retake').length,
      ums: cuts.filter((c) => c.why === 'um').length,
      pauses: cuts.filter((c) => c.why === 'pause').length,
      removedSeconds: +removedSeconds.toFixed(2),
      before: +duration.toFixed(2),
      after: +(duration - removedSeconds).toFixed(2),
    },
    retakes,
    review: {
      unconfidentRetakes: retakes.filter((r) => !r.confident),
      longUnworded,
      repeats: findRepeats(words, removed),
    },
  };
}
