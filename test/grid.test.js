import test from 'node:test';
import assert from 'node:assert/strict';
import { hotLapStartPose } from '../shared/grid.js';

const spawns = Array.from({ length: 8 }, (_, index) => ({
  x: index * 10,
  z: -index,
  heading: index / 10,
}));

test('Hot Lap uses its dedicated start point when one is configured', () => {
  assert.deepEqual(
    hotLapStartPose(spawns, { x: 123.5, z: -45.25, heading: 1.75 }),
    { x: 123.5, z: -45.25, heading: 1.75 }
  );
});

test('Hot Lap falls back to the eighth grid slot without a dedicated point', () => {
  assert.deepEqual(hotLapStartPose(spawns, null), spawns[7]);
  assert.deepEqual(hotLapStartPose(spawns, { x: 'invalid', z: 1 }), spawns[7]);
});
