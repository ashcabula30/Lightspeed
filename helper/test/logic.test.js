// Run with: npm test (node --test). Covers the logic that has no Premiere in the loop.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { buildTimeline } from '../src/autocut/plan.js';
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
