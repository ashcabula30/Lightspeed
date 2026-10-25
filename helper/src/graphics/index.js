// Render a graphic and place it at the playhead of the active sequence without covering existing clips.
import path from 'node:path';
import { call } from '../premiere.js';
import { renderGraphic } from './render.js';

const BIN = 'Editing Assistant';

// Video clips overlapping [t0, t1) per track index, plus the track count.
async function videoOccupancy(seqId, t0, t1) {
  const info = await call('get_full_sequence_info', { sequence_id: seqId, track_type: 'video', start_seconds: t0, end_seconds: t1, clip_limit: 200 });
  const busy = new Map();
  for (const tr of info.videoTracks || []) busy.set(tr.index, (tr.clips || []).length > 0);
  return { busy, trackCount: info.videoTrackCount || (info.videoTracks || []).length, fps: Math.round(1 / info.frameRate.seconds) };
}

async function ensureBin() {
  const items = await call('list_project_items');
  const bin = (Array.isArray(items) ? items : []).find((i) => i.type === 'bin' && i.name === BIN);
  if (bin) return bin.nodeId;
  const made = await call('create_bin', { name: BIN });
  return made.nodeId;
}

export async function makeGraphic(spec, graphicsConfig, onStep = () => {}) {
  onStep('Reading the timeline');
  const state = await call('get_premiere_state');
  const seq = state.activeSequence;
  if (!seq) throw new Error('No active sequence. Open the sequence the graphic should go in.');
  if (!state.project || !state.project.path) throw new Error('Save the Premiere project first, so renders have a folder to live in.');
  const start = Math.max(0, state.playheadSeconds || 0);
  const end = start + spec.durationSeconds;

  const occ = await videoOccupancy(seq.id, start, end);
  const outDir = path.join(path.dirname(state.project.path), 'Editing Assistant Renders');
  const result = await renderGraphic(spec, graphicsConfig, { outDir, fps: occ.fps, onStep });

  // Cards cover the frame: lowest free track above V1. Overlays: above everything showing at that time.
  let track = -1;
  const highestBusy = Math.max(0, ...[...occ.busy].filter(([, b]) => b).map(([i]) => i));
  const from = result.transparent ? Math.max(1, highestBusy + 1) : 1;
  for (let i = from; i < occ.trackCount; i++) if (!occ.busy.get(i)) { track = i; break; }
  if (track < 0) {
    onStep('Adding a video track');
    await call('add_track', { track_type: 'video', count: 1 });
    track = Math.max(from, occ.trackCount);
  }

  onStep(`Placing on V${track + 1} at ${start.toFixed(2)}s`);
  const binId = await ensureBin();
  const imported = await call('import_media', { file_paths: [result.file], target_bin: binId });
  const item = (imported.items || [])[0];
  if (!item) throw new Error('Premiere did not import the render.');
  await call('overwrite_clip', { item_id: item.nodeId, start_seconds: start, track_index: track });
  return { file: result.file, track: track + 1, start, durationSeconds: spec.durationSeconds, sequence: seq.name, kind: spec.kind };
}
