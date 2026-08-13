import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GHOST_SAMPLE_RATE, LEGACY_GHOST_SAMPLE_RATE, MAX_GHOST_FRAMES,
  makeGhostFrame, makeGhostReplay, sanitizeGhostReplay,
} from '../shared/ghost.js';

test('ghost frames use a compact rounded server pose', () => {
  const frame = makeGhostFrame(
    100.4,
    { x: 1.23456, y: 2.34567, z: -3.45678 },
    { x: 0.123456, y: 0, z: -0.2, w: 0.971234 }
  );
  assert.deepEqual(frame, [100, 1.235, 2.346, -3.457, 0.1235, 0, -0.2, 0.9712]);
});

test('ghost replay accepts ordered finite frames and rejects unsafe payloads', () => {
  const frames = [
    [0, 0, 1, 2, 0, 0, 0, 1],
    [100, 0, 1, 3, 0, 0.1, 0, 0.995],
  ];
  const replay = makeGhostReplay(frames);
  assert.equal(replay.sampleRate, GHOST_SAMPLE_RATE);
  assert.deepEqual(sanitizeGhostReplay(replay), replay);

  assert.equal(sanitizeGhostReplay({ ...replay, frames: [...frames].reverse() }), null);
  assert.equal(sanitizeGhostReplay({ ...replay, frames: [[0, NaN, 1, 2, 0, 0, 0, 1], frames[1]] }), null);
  assert.equal(sanitizeGhostReplay({ ...replay, frames: Array(MAX_GHOST_FRAMES + 1).fill(frames[0]) }), null);
});

test('new ghosts use 20 Hz while existing 10 Hz ghosts remain playable', () => {
  assert.equal(GHOST_SAMPLE_RATE, 20);
  const oldReplay = {
    version: 1,
    sampleRate: LEGACY_GHOST_SAMPLE_RATE,
    frames: [
      [0, 0, 1, 2, 0, 0, 0, 1],
      [100, 0, 1, 3, 0, 0.1, 0, 0.995],
    ],
  };

  assert.deepEqual(sanitizeGhostReplay(oldReplay), oldReplay);
  assert.equal(sanitizeGhostReplay({ ...oldReplay, sampleRate: 15 }), null);
});
