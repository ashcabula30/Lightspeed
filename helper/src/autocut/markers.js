// Cut preview as sequence markers: one marker per planned cut, coloured by reason, so the editor
// can scrub through them before applying. Deleting a marker in Premiere keeps that bit (Apply skips it).
import { call } from '../premiere.js';

const PREFIX = 'EA cut';
const COLOR = { retake: 1, um: 4, pause: 5 }; // red, yellow, white
const BATCH = 200;

// list_markers' shape isn't documented; accept the field names it is likely to use.
function readMarkers(data) {
  const list = Array.isArray(data) ? data : (data && (data.markers || data.items)) || [];
  return list.map((m) => ({
    name: String(m.name || ''),
    t: Number(m.start ?? m.startSeconds ?? m.start_seconds ?? m.time ?? m.timeSeconds ?? (m.start && m.start.seconds)),
  })).filter((m) => Number.isFinite(m.t));
}

export async function listCutMarkers(sequenceId) {
  await call('set_active_sequence', { sequence_id: sequenceId });
  return readMarkers(await call('list_markers')).filter((m) => m.name.startsWith(PREFIX));
}

export async function clearCutMarkers(sequenceId) {
  const markers = await listCutMarkers(sequenceId);
  // From the end backwards, matching the order everything else in auto-cut works in.
  for (const m of markers.sort((a, b) => b.t - a.t)) await call('delete_marker', { time_seconds: m.t });
  return markers.length;
}

export async function placeCutMarkers(analysis, onProgress = () => {}) {
  const seq = analysis.sequence;
  await clearCutMarkers(seq.id); // replace an earlier preview rather than stacking a second one
  const markers = analysis.cuts.map((c) => ({
    time_seconds: c.start,
    duration_seconds: +(c.end - c.start).toFixed(4),
    name: `${PREFIX}: ${c.why}`,
    color: COLOR[c.why] ?? 5,
    comments: 'Editing Assistant auto-cut preview. Delete this marker to keep this part.',
  }));
  for (let i = 0; i < markers.length; i += BATCH) {
    onProgress({ label: `Placing markers ${i + 1}-${Math.min(markers.length, i + BATCH)} of ${markers.length}`, done: i, total: markers.length });
    await call('add_markers_batch', { sequence_id: seq.id, markers: markers.slice(i, i + BATCH) });
  }
  return markers.length;
}

// Cuts whose preview marker is still on the timeline (within 1.5 frames of the cut start).
export function keepMarked(cuts, markers, fps) {
  const tol = 1.5 / fps;
  return cuts.filter((c) => markers.some((m) => Math.abs(m.t - c.start) <= tol));
}
