// Pre-handoff QA: automatic checks on the active sequence plus the client's own must-dos from
// the knowledge base as a manual checklist. Read-only: nothing here changes the project.
import { call } from './premiere.js';
import { listCutMarkers } from './autocut/markers.js';
import { getClient } from './clients.js';

const num = (...vals) => vals.map((v) => (v != null ? Number(v) : NaN)).find(Number.isFinite);

// get_timeline_gaps / check_offline_media shapes aren't documented; read the likely field names.
function gapsFrom(data) {
  const list = Array.isArray(data) ? data : (data && (data.gaps || data.items)) || [];
  return list.map((g) => ({
    t: num(g.startSeconds, g.start_seconds, g.start, g.gapStart),
    seconds: num(g.durationSeconds, g.duration_seconds, g.duration),
    track: `${(g.trackType || g.track_type || g.type || '').startsWith('a') ? 'A' : 'V'}${num(g.trackIndex, g.track_index, 0) + 1}`,
  })); // kept even without a readable time, so a gap is never silently dropped from the count
}

function offlineFrom(data) {
  if (Array.isArray(data)) return data;
  const list = data && (data.offlineItems || data.offline || data.items);
  if (Array.isArray(list)) return list;
  const n = num(data && data.count, data && data.offlineCount);
  return Number.isFinite(n) ? new Array(n).fill({}) : [];
}

async function check(label, fn) {
  try {
    return { label, ...(await fn()) };
  } catch (err) {
    return { label, state: 'warn', detail: `Couldn't check: ${err.message}` };
  }
}

// Bullet points under the guide's "Must-dos" line, plus its pitfalls and the editor's own notes.
export function clientChecklist(markdown) {
  const lines = markdown.split(/\r?\n/);
  const items = [];
  let inMust = false, inNotes = false;
  for (const line of lines) {
    if (/must-dos/i.test(line)) { inMust = true; continue; }
    if (/^##\s+my notes/i.test(line)) { inNotes = true; inMust = false; continue; }
    if (/^##\s/.test(line)) inNotes = false;
    const bullet = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (inMust) {
      if (bullet && bullet[1].length >= 2) { items.push(bullet[2]); continue; }
      if (line.trim()) inMust = false;
    }
    if (bullet && /\*\*(pitfall|exports?)/i.test(bullet[2])) items.push(bullet[2]);
    if (inNotes && bullet) items.push(bullet[2]);
  }
  return items.map((t) => t.replace(/\*\*/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim());
}

// The guide's "**Exports:** 9x16 and 4x5, 30fps, ..." line -> { ratios: [[9,16],[4,5]], fps: 30, text }.
export function exportSpec(markdown) {
  const line = (markdown.match(/\*\*exports?:?\*\*:?\s*(.+)/i) || [])[1];
  if (!line) return null;
  const ratios = [...line.matchAll(/\b(\d{1,2})\s*[x×:]\s*(\d{1,2})\b/g)].map((m) => [Number(m[1]), Number(m[2])])
    .filter(([a, b], i, all) => all.findIndex(([c, d]) => c === a && d === b) === i); // the file-name pattern repeats one
  const fps = Number((line.match(/(\d+(?:\.\d+)?)\s*fps/i) || [])[1]) || null;
  if (!ratios.length && !fps) return null;
  return { ratios, fps, text: line.replace(/[`*]/g, '').trim() };
}

// resolution "1920x1080"; frameSeconds = one frame's length (1/30 for 30fps).
export function compareSpec(spec, resolution, frameSeconds) {
  const issues = [];
  const [w, h] = String(resolution || '').split(/[x×]/).map(Number);
  const shape = w && h ? `${w}x${h}` : 'unknown size';
  if (spec.ratios.length && w && h && !spec.ratios.some(([a, b]) => Math.abs(w / h - a / b) < 0.01)) {
    issues.push(`the sequence is ${shape}, but exports are ${spec.ratios.map(([a, b]) => `${a}x${b}`).join(' / ')}`);
  }
  const fps = frameSeconds ? Math.round((1 / frameSeconds) * 100) / 100 : null;
  // Strict: 29.97 is not 30.
  if (spec.fps && fps && Math.abs(fps - spec.fps) > 0.005) issues.push(`the sequence runs at ${fps}fps, but exports are ${spec.fps}fps`);
  return issues.length
    ? { state: 'warn', detail: `${issues.join('; ')}. Guide: ${spec.text}` }
    : { state: 'ok', detail: `${shape}${fps ? ` at ${fps}fps` : ''} fits: ${spec.text}` };
}

export async function runQa(config, clientId) {
  const state = await call('get_premiere_state');
  const active = state.activeSequence;
  if (!active) throw new Error('No active sequence. Open the sequence you are handing off.');
  const seq = { ...active, ...((state.sequences || []).find((s) => s.id === active.id) || {}) };

  const checks = [];
  checks.push(await check('No gaps on V1 and A1', async () => {
    const gaps = [];
    for (const track_type of ['video', 'audio']) {
      gaps.push(...gapsFrom(await call('get_timeline_gaps', { sequence_id: seq.id, track_type, track_index: 0, min_gap_seconds: 0.04, clip_limit: 50 })));
    }
    return gaps.length
      ? { state: 'missing', detail: `${gaps.length} gap${gaps.length === 1 ? '' : 's'} (black frames or silence).`, times: gaps.filter((g) => Number.isFinite(g.t)).slice(0, 20).map((g) => ({ t: g.t, text: `${g.track} gap${g.seconds ? `, ${g.seconds.toFixed(2)}s` : ''}` })) }
      : { state: 'ok', detail: 'No black frames or dropped audio between clips.' };
  }));
  checks.push(await check('No offline media', async () => {
    const offline = offlineFrom(await call('check_offline_media'));
    return offline.length
      ? { state: 'missing', detail: `${offline.length} offline item${offline.length === 1 ? '' : 's'}: ${offline.slice(0, 5).map((o) => o.name || o.path || '?').join(', ')}` }
      : { state: 'ok', detail: 'All media is linked.' };
  }));
  checks.push(await check('No leftover cut markers', async () => {
    const markers = await listCutMarkers(seq.id);
    return markers.length
      ? { state: 'warn', detail: `${markers.length} auto-cut preview marker${markers.length === 1 ? '' : 's'} still on the timeline. Apply or clear them.` }
      : { state: 'ok', detail: 'No auto-cut preview markers left.' };
  }));

  let client = null, checklist = [];
  if (clientId) {
    client = getClient(config, clientId);
    checklist = clientChecklist(client.markdown);
    const spec = exportSpec(client.markdown);
    if (spec) {
      checks.push(await check(`Matches ${client.name}'s export spec`, async () => {
        const t = await call('get_timeline_summary');
        return compareSpec(spec, t.resolution, t.frameRate && t.frameRate.seconds);
      }));
    }
  }
  return { sequence: { id: seq.id, name: seq.name, duration: seq.duration }, checks, client: client && { id: client.id, name: client.name }, checklist, checkedAt: new Date().toISOString() };
}
