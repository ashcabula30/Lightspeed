// Auto-cut orchestration: read the sequence from Premiere, analyse its sources, plan the cuts.
import { call } from '../premiere.js';
import { analyzeSource } from './media.js';
import { buildTimeline, planCuts } from './plan.js';

// All audio clips on track A1 (index 0) of a sequence, following pagination.
async function audioClips(sequenceId) {
  const clips = [];
  let offset = 0, info = null;
  for (;;) {
    info = await call('get_full_sequence_info', { sequence_id: sequenceId, track_type: 'audio', track_index: 0, clip_limit: 200, clip_offset: offset });
    const track = (info.audioTracks || []).find((t) => t.index === 0);
    for (const c of (track && track.clips) || []) clips.push(c);
    const next = info.pagination && info.pagination.nextOffset;
    if (next === null || next === undefined) break;
    offset = next;
  }
  return { info, clips };
}

export async function analyzeSequence(sequenceId, settings, onStep = () => {}) {
  onStep('Reading the sequence');
  const state = await call('get_premiere_state');
  const seqId = sequenceId || (state.activeSequence && state.activeSequence.id);
  if (!seqId) throw new Error('No active sequence. Open the sequence you want to cut.');
  const { info, clips } = await audioClips(seqId);
  if (!clips.length) throw new Error('Track A1 has no clips to analyse.');
  const odd = clips.find((c) => c.speed !== 1);
  if (odd) throw new Error(`A clip on A1 has speed ${odd.speed}. Auto-cut only handles clips at 100% speed for now.`);
  const fps = Math.round(1 / info.frameRate.seconds);

  const sources = new Map();
  const paths = [...new Set(clips.map((c) => c.sourceMediaPath).filter(Boolean))];
  for (const [i, p] of paths.entries()) {
    sources.set(p, await analyzeSource(p, (label) => onStep(`${label} (${i + 1}/${paths.length})`)));
  }

  onStep('Planning cuts');
  const timeline = buildTimeline(clips.map((c) => ({ start: c.startSeconds, end: c.endSeconds, inPoint: c.inPointSeconds, mediaPath: c.sourceMediaPath })),
    sources, info.durationSeconds);
  const plan = planCuts(timeline, settings, fps, info.durationSeconds);
  return { sequence: { id: seqId, name: info.name, fps, duration: info.durationSeconds }, ...plan };
}
