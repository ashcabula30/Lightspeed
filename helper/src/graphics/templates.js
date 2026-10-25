// Graphic templates as Tesseract document layers (ported from the Kitsune Module 30 build).
// Each builder returns one top-level Group (id 100) starting at 0 plus its animation entries.
//   card:     full-frame background video + centred text that types on, optional highlight word
//   keywords: words that pop in around the subject, transparent overlay
//   quote:    one lower-centre line in quotes, transparent overlay
const W = 1920, H = 1080;
const WHITE = [1, 1, 1, 1], INK = [0.07, 0.07, 0.08, 1];
const RED = [0.93, 0.08, 0.08, 1], BLUE = [0.12, 0.3, 0.78, 1];
export const LOOKS = {
  dark: { label: 'Dark', ink: WHITE, hi: RED },
  light: { label: 'Light', ink: INK, hi: BLUE },
  red: { label: 'Red', ink: WHITE, hi: INK },
};

const T0 = { anchorPoint: [0, 0], position: [0, 0], scale: [100, 100], rotation: 0, opacity: 100 };
const ease = { type: 'cubicBezier', x1: 0.2, y1: 0, x2: 0.2, y2: 1 };
const lin = { type: 'linear' };

function ctx(font) {
  let item = 900000;
  const dyn = [];
  const textDoc = (text, size, fill, box) => {
    const doc = { text, fontFamily: font.family, fontStyle: font.style, fontSize: size, fillColor: fill, strokeWidth: 0,
      justification: 'center', allCaps: true, tracking: 0 };
    if (box) Object.assign(doc, { boxText: true, boxPosition: [0, 0], boxSize: box, verticalAlign: 'center' });
    return doc;
  };
  const shadow = (id, off, blur, a) => ({ id, style: { type: 'dropShadow', enabled: true, color: [0, 0, 0, a], offset: off, blurRadius: blur, spreadRadius: 0, blendMode: 'normal' } });
  const group = (id, name, dur, layers) => ({ type: 'Group', id, name, blendMode: 'normal', transform: { ...T0 }, layers,
    playback: { type: 'windowed', inputRange: { start: 0, duration: dur },
      mapping: { type: 'linear', input: { start: 0, duration: dur }, output: { start: 0, duration: dur } }, inputOffsetMs: 0 } });
  const kf = (layerId, prop, keys) => dyn.push({ target: { kind: 'layer', layerId, propertyType: prop }, animator: { type: 'keyframes', enabled: true,
    keyframes: keys.map(([t, v, e], i) => ({ id: `${layerId}-${prop}-${i}`, layerTime: Math.round(t), value: { type: 'float', value: v }, easing: e || lin })) } });
  // Characters from `start` onwards stay hidden; start sweeps 0 -> 1 = typewriter in the final layout.
  const typeOn = (t0, dur) => {
    const sel = item++, anim = item++;
    dyn.push({ target: { kind: 'fxItemProperty', itemId: sel, propertyName: 'start' }, animator: { type: 'keyframes', enabled: true,
      keyframes: [{ id: `ty-${sel}-0`, layerTime: t0, value: { type: 'float', value: 0 }, easing: lin },
                  { id: `ty-${sel}-1`, layerTime: t0 + dur, value: { type: 'float', value: 1 }, easing: lin }] } });
    return { id: anim, name: 'Type on', opacity: 0, selectors: [{ id: sel, start: 0, end: 1, offset: 0, units: 'percentage',
      basedOn: 'characters', mode: 'add', amount: 1, shape: 'square' }] };
  };
  const highlight = (text, word, color) => {
    const i0 = text.toUpperCase().indexOf(word.toUpperCase());
    if (i0 < 0) return null;
    return { id: item++, name: 'Highlight', fillColor: color, selectors: [{ id: item++, start: i0, end: i0 + word.length, offset: 0,
      units: 'index', basedOn: 'characters', mode: 'add', amount: 1, shape: 'square' }] };
  };
  return { dyn, textDoc, shadow, group, kf, typeOn, highlight };
}

function background(id, bg, dur) {
  // One pass of the loop, slowed if the card is longer than the source.
  const src = Math.min(dur, bg.durationMs - 40);
  return { type: 'Video', id, name: 'Background', blendMode: 'normal', volume: 0,
    playback: { type: 'windowed', inputRange: { start: 0, duration: dur },
      mapping: { type: 'linear', input: { start: 0, duration: dur }, output: { start: 0, duration: src } }, inputOffsetMs: 0 },
    sourceRange: { start: 0, duration: src }, sourceIntrinsicDuration: bg.durationMs, transform: { ...T0 },
    source: { assetId: bg.assetId, fit: 'cover', sourceRect: { x: 0, y: 0, width: W, height: H } } };
}

// spec: { text, highlight?, look, durationSeconds }. Returns { layer, dyn, typeMs, transparent:false }.
export function card(spec, font, bgs) {
  const c = ctx(font);
  const look = LOOKS[spec.look] ? spec.look : 'dark';
  const bg = bgs[look];
  if (!bg) throw new Error(`No background is set for the "${look}" look (graphics.backgrounds in config.json).`);
  const dur = Math.round(spec.durationSeconds * 1000);
  const text = String(spec.text || '').trim();
  if (!text) throw new Error('The card needs some text.');
  const typeMs = Math.min(1600, Math.max(600, Math.round(text.length / 34 * 1000)));
  const animators = [c.typeOn(150, typeMs)];
  if (spec.highlight) {
    const h = c.highlight(text, spec.highlight, LOOKS[look].hi);
    if (h) animators.push(h);
  }
  const txt = { type: 'Text', id: 102, name: 'Statement', blendMode: 'normal', activeRange: { start: 0, duration: dur },
    transform: { ...T0, position: [260, 390] }, sourceText: c.textDoc(text, 58, LOOKS[look].ink, [1400, 300]), animators };
  return { layer: c.group(100, `${look} card`, dur, [txt, background(101, bg, dur)]), dyn: c.dyn, typeMs, transparent: false };
}

function popWord(c, id, text, size, x, y, fill, appearMs, endMs, box) {
  const t = { type: 'Text', id, name: text, blendMode: 'normal', activeRange: { start: 0, duration: endMs },
    transform: { ...T0, position: [x, y] }, sourceText: c.textDoc(text, size, fill, box),
    layerStyles: [c.shadow(id + 1, [3, 4], 12, 0.55)] };
  if (box) t.transform.anchorPoint = [box[0] / 2, box[1] / 2];
  // Hidden until appearMs (a leading hold key only when it isn't at 0, since keys must be strictly increasing).
  const hold = (v) => (appearMs > 0 ? [[0, v]] : []);
  for (const p of ['scaleX', 'scaleY']) c.kf(id, p, [...hold(85), [appearMs, 85], [appearMs + 260, 100, ease]]);
  c.kf(id, 'opacity', [...hold(0), [appearMs, 0], [appearMs + 180, 100, ease], [Math.max(appearMs + 200, endMs - 220), 100], [Math.max(appearMs + 220, endMs), 0]]);
  return t;
}

// Left and right of a centred speaker; rows go down each side alternately.
const SLOTS = [[330, 300], [1560, 300], [330, 470], [1560, 470], [300, 705], [1560, 640]];

// spec: { words: [{ text, red? }], durationSeconds }. Words appear evenly across the first 60%.
export function keywords(spec, font) {
  const c = ctx(font);
  const dur = Math.round(spec.durationSeconds * 1000);
  const words = (spec.words || []).filter((w) => w && w.text).slice(0, SLOTS.length);
  if (!words.length) throw new Error('Add at least one keyword.');
  const step = words.length > 1 ? (dur * 0.6) / (words.length - 1) : 0;
  const kids = words.map((w, i) => popWord(c, 110 + i * 2, w.text, 58, SLOTS[i][0], SLOTS[i][1], w.red ? RED : WHITE, Math.round(i * step), dur));
  return { layer: c.group(100, 'keywords', dur, kids), dyn: c.dyn, pops: words.map((_, i) => i * step / 1000), transparent: true };
}

// spec: { text, durationSeconds }.
export function quote(spec, font) {
  const c = ctx(font);
  const dur = Math.round(spec.durationSeconds * 1000);
  let text = String(spec.text || '').trim().replace(/^["“]|["”]$/g, '');
  if (!text) throw new Error('The quote needs some text.');
  text = `“${text}”`;
  return { layer: c.group(100, 'quote', dur, [popWord(c, 110, text, 62, 960, 900, WHITE, 0, dur, [1500, 160])]), dyn: c.dyn, pops: [0], transparent: true };
}

export const TEMPLATES = { card, keywords, quote };
