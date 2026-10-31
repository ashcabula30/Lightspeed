// Auto-cut orchestration: read the sequence from Premiere, analyse its sources, plan the cuts.
import { call } from '../premiere.js';
import { analyzeSource, checkStop } from './media.js';
import { buildTimeline, planCuts } from './plan.js';

// All clips on one audio track (0 = A1) of a sequence, following pagination.
async function audioClips(sequenceId, trackIndex) {
  const clips = [];
  let offset = 0, info = null;
  for (;;) {
    info = await call('get_full_sequence_info', { sequence_id: sequenceId, track_type: 'audio', track_index: trackIndex, clip_limit: 200, clip_offset: offset });
    const track = (info.audioTracks || []).find((t) => t.index === trackIndex);
    for (const c of (track && track.clips) || []) clips.push(c);
    const next = info.pagination && info.pagination.nextOffset;
    if (next === null || next === undefined) break;
    offset = next;
  }
  return { info, clips };
}

// Loudness frames and transcript words for the dialogue track (0 = A1), mapped onto timeline time.
// Transcripts are cached per source file, so re-running is quick.
export async function readSequenceAudio(sequenceId, onStep = () => {}, signal, trackIndex = 0) {
  onStep('Reading the sequence');
  const state = await call('get_premiere_state');
  const seqId = sequenceId || (state.activeSequence && state.activeSequence.id);
  if (!seqId) throw new Error('No active sequence. Open the sequence you want to work on.');
  const name = `A${trackIndex + 1}`;
  const { info, clips } = await audioClips(seqId, trackIndex);
  if (!clips.length) throw new Error(`Track ${name} has no clips to analyse. Pick the track the dialogue is on.`);
  const reversed = clips.find((c) => (c.speed ?? 1) <= 0);
  if (reversed) throw new Error(`A clip on ${name} plays in reverse. Auto-cut can't follow reversed clips.`);
  const fps = Math.round(1 / info.frameRate.seconds);

  const sources = new Map();
  const paths = [...new Set(clips.map((c) => c.sourceMediaPath).filter(Boolean))];
  for (const [i, p] of paths.entries()) {
    checkStop(signal);
    sources.set(p, await analyzeSource(p, (label) => onStep(`${label} (${i + 1}/${paths.length})`), signal));
  }
  const timeline = buildTimeline(clips.map((c) => ({ start: c.startSeconds, end: c.endSeconds, inPoint: c.inPointSeconds, mediaPath: c.sourceMediaPath, speed: c.speed })),
    sources, info.durationSeconds);
  return { sequence: { id: seqId, name: info.name, fps, duration: info.durationSeconds }, timeline };
}

export async function analyzeSequence(sequenceId, settings, onStep = () => {}, signal) {
  const track = Math.max(0, Math.min(15, Math.round(Number(settings.track) || 0)));
  const { sequence, timeline } = await readSequenceAudio(sequenceId, onStep, signal, track);
  checkStop(signal);
  onStep('Planning cuts');
  const plan = planCuts(timeline, settings, sequence.fps, sequence.duration);
  return { sequence, ...plan };
}
