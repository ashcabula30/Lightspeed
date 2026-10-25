// Applies a cut plan in Premiere: backup sequence first, then ripple-delete in batches of 50,
// working from the end of the timeline backwards so earlier cut times never shift.
import { call, PremiereError } from '../premiere.js';
import { clearCutMarkers, keepMarked, listCutMarkers } from './markers.js';
import { checkStop } from './media.js';

const BATCH = 50;

async function backupSequence(seq) {
  const dup = await call('duplicate_sequence', { sequence_id: seq.id });
  // duplicate_sequence makes the copy active; renaming needs its project-item node id.
  const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const backupName = `${seq.name} (before auto-cut ${stamp})`;
  const items = await call('list_project_items');
  const copies = (Array.isArray(items) ? items : []).filter((i) => i.type === 'sequence' && i.name === dup.name);
  const node = copies[copies.length - 1];
  if (node) await call('rename_project_item', { item_id: node.nodeId, new_name: backupName });
  await call('set_active_sequence', { sequence_id: seq.id });
  return { id: dup.id, name: node ? backupName : dup.name };
}

// signal: Stop is honoured before the backup and between batches (never halfway through one),
// so the timeline is always in a clean state and Undo cuts can put it back.
export async function applyCuts(analysis, onProgress = () => {}, signal) {
  const seq = analysis.sequence;
  let cuts = analysis.cuts;
  if (!cuts.length) return { applied: 0, skipped: 0, ranges: [] };

  // Refuse if the timeline changed since the analysis (cut times would land in the wrong places).
  const state = await call('get_premiere_state');
  const live = (state.sequences || []).find((s) => s.id === seq.id);
  if (!live) throw new Error(`Sequence "${seq.name}" is no longer in the project.`);
  if (Math.abs(live.duration - seq.duration) > 0.05) throw new Error('The sequence changed since it was analysed. Run Analyze again.');
  await call('set_active_sequence', { sequence_id: seq.id });

  // With a marker preview on the timeline, only cut what still has its marker, then clear the
  // markers (sequence markers don't move with a ripple delete, so they'd end up in the wrong places).
  let skipped = 0;
  if (analysis.markersPlaced) {
    onProgress({ phase: 'markers', label: 'Reading the cut markers', done: 0, total: cuts.length });
    const markers = await listCutMarkers(seq.id);
    const kept = keepMarked(cuts, markers, seq.fps);
    skipped = cuts.length - kept.length;
    cuts = kept;
    await clearCutMarkers(seq.id);
    if (!cuts.length) return { applied: 0, skipped, ranges: [] };
  }

  checkStop(signal);
  onProgress({ phase: 'backup', label: 'Backing up the sequence', done: 0, total: cuts.length });
  const backup = await backupSequence(seq);

  const batches = [];
  for (let end = cuts.length; end > 0; end -= BATCH) batches.push(cuts.slice(Math.max(0, end - BATCH), end));
  let done = 0, stopped = false;
  const made = [];
  for (const [i, batch] of batches.entries()) {
    if (signal && signal.aborted) { stopped = true; break; }
    const ranges = batch.map((c) => ({ start: c.start, end: c.end }));
    const base = { sequence_id: seq.id, scope: 'sync_locked', range_content: 'delete', ranges, allow_large_ripple: true };
    onProgress({ phase: 'cutting', label: `Batch ${i + 1} of ${batches.length}: checking`, done, total: cuts.length });
    const preview = await call('ripple_remove_timeline_ranges', { ...base, dry_run: true });
    if (!preview.confirmationToken) throw new PremiereError('Premiere did not return a confirmation for the cut preview.', preview);
    onProgress({ phase: 'cutting', label: `Batch ${i + 1} of ${batches.length}: cutting`, done, total: cuts.length });
    const result = await call('ripple_remove_timeline_ranges', { ...base, dry_run: false, confirmation_token: preview.confirmationToken });
    if (!result.verified) throw new PremiereError(`Batch ${i + 1} could not be verified. Check the timeline; the backup is "${backup.name}".`, result);
    done += batch.length;
    made.push(...batch);
    onProgress({ phase: 'cutting', label: `Batch ${i + 1} of ${batches.length} done`, done, total: cuts.length });
  }

  const after = await call('get_premiere_state');
  const final = (after.sequences || []).find((s) => s.id === seq.id);
  const removed = made.reduce((t, c) => t + c.end - c.start, 0);
  made.sort((x, y) => x.start - y.start);
  return { applied: done, skipped, stopped, backup, durationBefore: seq.duration, durationAfter: final ? final.duration : null,
    expectedAfter: +(seq.duration - removed).toFixed(2), ranges: made.map((c) => [c.start, c.end]) };
}

// Undo cuts: the backup becomes the working sequence again under the original name, and the cut
// version is renamed and kept (never deleted). No timeline edits, so it can't half-fail on the cuts.
export async function undoCuts(backup) {
  const items = await call('list_project_items');
  const seqs = (Array.isArray(items) ? items : []).filter((i) => i.type === 'sequence');
  const cutItem = seqs.find((i) => i.name === backup.of.name);
  const backupItem = seqs.find((i) => i.name === backup.name);
  if (!backupItem) throw new Error(`The backup "${backup.name}" is no longer in the project.`);
  const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const keptName = `${backup.of.name} (undone cut ${stamp})`;
  if (cutItem) await call('rename_project_item', { item_id: cutItem.nodeId, new_name: keptName });
  await call('rename_project_item', { item_id: backupItem.nodeId, new_name: backup.of.name });
  await call('set_active_sequence', { sequence_id: backup.id });
  return { restored: backup.of.name, keptAs: cutItem ? keptName : null };
}
