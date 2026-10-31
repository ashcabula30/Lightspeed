// Run with: npm test (node --test). Covers the logic that has no Premiere in the loop.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { autoThreshold, buildTimeline, planCuts } from '../src/autocut/plan.js';
import { FRAME_S } from '../src/autocut/media.js';
import { compareSpec, exportSpec } from '../src/qa.js';
import { checkFfmpegArgs, checkTesseractArgs, WORK_DIR } from '../src/tools-mcp.js';

const source = { db: Float32Array.from({ length: 1000 }, (_, i) => -i / 10), words: [{ text: 'hello', t: 4 }, { text: 'world', t: 8 }] };
const sources = new Map([['a.mp4', source]]);

test('a clip at 100% speed maps source time straight onto the timeline', () => {
  const { frames, words } = buildTimeline([{ start: 10, end: 20, inPoint: 2, mediaPath: 'a.mp4', speed: 1 }], sources, 30);
  assert.deepEqual(words.map((w) => [w.text, w.t]), [['hello', 12], ['world', 16]]);
  assert.equal(frames[Math.round(12 / FRAME_S)], source.db[Math.round(4 / FRAME_S)]);
});

test('a clip at 200% speed plays two seconds of source per timeline second', () => {
  const { frames, words } = buildTimeline([{ start: 10, end: 14, inPoint: 2, mediaPath: 'a.mp4', speed: 2 }], sources, 30);
  // The clip covers source 2s..10s. Source 4s -> timeline 10 + (4 - 2) / 2 = 11; source 8s -> 13.
  assert.deepEqual(words.map((w) => [w.text, w.t]), [['hello', 11], ['world', 13]]);
  assert.equal(frames[Math.round(11 / FRAME_S)], source.db[Math.round(4 / FRAME_S)]);
});

test('export spec reads ratios and fps from a client guide line', () => {
  const spec = exportSpec('- **Exports:** 9x16 and 4x5, 30fps, named `Asset [1 A - (9x16)]`.');
  assert.deepEqual(spec.ratios, [[9, 16], [4, 5]]);
  assert.equal(spec.fps, 30);
  assert.equal(compareSpec(spec, '1080x1920', 1 / 30).state, 'ok');
  assert.equal(compareSpec(spec, '1920x1080', 1 / 30).state, 'warn');
  assert.equal(compareSpec(spec, '1080x1920', 1 / 29.97).state, 'warn');
  assert.equal(exportSpec('# No exports here'), null);
});

test('Tesseract and ffmpeg can only write inside the job folder', () => {
  const dir = path.join(WORK_DIR, 'unit');
  assert.doesNotThrow(() => checkTesseractArgs(['project', 'create', '--project', 'a.tsrct'], dir));
  assert.throws(() => checkTesseractArgs(['export', '-p', 'a.tsrct', '-o', 'E:/x.mp4'], dir));
  assert.throws(() => checkTesseractArgs(['export', '-p', 'a.tsrct', '--output=../../x.mp4'], dir));
  assert.throws(() => checkTesseractArgs(['telemetry', 'enable'], dir));
  assert.throws(() => checkFfmpegArgs(['-i', 'missing.mp4', 'out.mp4'], dir));
});

import { keepMarked } from '../src/autocut/markers.js';

test('autoThreshold calculates 20th percentile + 10dB within [-60, -35] dB', () => {
  // All silent frames
  assert.equal(autoThreshold(new Float32Array(100).fill(-90)), -50);
  // Quiet room tone frames at -65 dBFS
  const quiet = new Float32Array(100).fill(-65);
  assert.equal(autoThreshold(quiet), -55); // -65 + 10 = -55
  // Very loud background
  const loud = new Float32Array(100).fill(-20);
  assert.equal(autoThreshold(loud), -35); // clamped to -35
});

test('planCuts detects pauses, slates, and respects framerate snaps', () => {
  // 5 seconds of audio: 0-1s speech (-20dB), 1-3.5s pause (-70dB), 3.5-5s speech (-20dB)
  const frames = new Float32Array(Math.round(5 / FRAME_S)).fill(-70);
  for (let f = 0; f < Math.round(1 / FRAME_S); f++) frames[f] = -20;
  for (let f = Math.round(3.5 / FRAME_S); f < frames.length; f++) frames[f] = -20;
  const words = [{ text: 'start', t: 0.5 }, { text: 'end', t: 4.0 }];
  const plan = planCuts({ frames, words }, { pauseSeconds: 0.5, thresholdDb: -45 }, 30, 5);
  assert.equal(plan.cuts.length, 1);
  assert.equal(plan.cuts[0].why, 'pause');
  assert(plan.cuts[0].start > 1.0 && plan.cuts[0].end < 3.5);
});

test('keepMarked filters cuts using binary search tolerance', () => {
  const cuts = [{ start: 2.0, end: 3.0 }, { start: 5.0, end: 6.0 }, { start: 8.0, end: 9.0 }];
  const markers = [{ t: 2.01 }, { t: 8.02 }]; // marker at 5.0 was removed by editor
  const kept = keepMarked(cuts, markers, 30);
  assert.equal(kept.length, 2);
  assert.deepEqual(kept.map((c) => c.start), [2.0, 8.0]);
});

test('buildTimeline handles negative clip start without crashing or corrupting frames', () => {
  const { frames } = buildTimeline([{ start: -2, end: 4, inPoint: 0, mediaPath: 'a.mp4', speed: 1 }], sources, 10);
  assert.equal(frames.length, Math.ceil(10 / FRAME_S));
});

test('planCuts detects single word retake directly preceding slate phrase', () => {
  const frames = new Float32Array(Math.round(6 / FRAME_S)).fill(-20);
  const words = [
    { text: 'Start', t: 0.5 },
    { text: 'take', t: 1.5 },
    { text: 'again', t: 1.8 },
    { text: 'Start', t: 2.5 },
    { text: 'fresh', t: 3.0 },
  ];
  const plan = planCuts({ frames, words }, { pauseSeconds: 0.5, slatePhrases: ['take again'] }, 30, 6);
  assert.equal(plan.retakes.length, 1);
  assert.equal(plan.retakes[0].confident, true);
  assert.equal(plan.retakes[0].removedText, 'Start take again');
});
