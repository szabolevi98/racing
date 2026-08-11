import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PIT_SPEED_LIMIT_MPS, PIT_STOP_DURATION_MS, createPitState, hasCompletePitConfig,
  pitLimitedVelocity, updatePitState,
} from '../shared/pit.js';

const pit = {
  entry: { x1: 0, z1: -5, x2: 0, z2: 5 },
  exit: { x1: 20, z1: -5, x2: 20, z2: 5 },
  stops: Array.from({ length: 8 }, (_, i) => ({ x: 5 + i, z: 0, heading: 0 })),
};

test('mandatory pit stop only activates with a complete 8-stall configuration', () => {
  assert.equal(hasCompletePitConfig(pit), true);
  assert.equal(hasCompletePitConfig({ ...pit, exit: null }), false);
  assert.equal(hasCompletePitConfig({ ...pit, stops: pit.stops.slice(0, 7) }), false);
});

test('pit state requires entry crossing and three continuous stopped seconds in assigned stall', () => {
  const state = createPitState(true);
  updatePitState(state, pit, 2, { fromX: -1, fromZ: 0, x: 1, z: 0, speedMps: 20, now: 1000 });
  assert.equal(state.inLane, true);
  updatePitState(state, pit, 2, { fromX: 1, fromZ: 0, x: 7, z: 0, speedMps: 0, now: 2000 });
  updatePitState(state, pit, 2, { fromX: 7, fromZ: 0, x: 7, z: 0, speedMps: 0, now: 2000 + PIT_STOP_DURATION_MS - 1 });
  assert.equal(state.completed, false);
  updatePitState(state, pit, 2, { fromX: 7, fromZ: 0, x: 7, z: 0, speedMps: 0, now: 2000 + PIT_STOP_DURATION_MS });
  assert.equal(state.completed, true);
});

test('leaving or moving in the assigned stall resets the continuous timer', () => {
  const state = createPitState(true);
  updatePitState(state, pit, 0, { fromX: -1, fromZ: 0, x: 1, z: 0, speedMps: 0, now: 0 });
  updatePitState(state, pit, 0, { fromX: 1, fromZ: 0, x: 5, z: 0, speedMps: 0, now: 100 });
  updatePitState(state, pit, 0, { fromX: 5, fromZ: 0, x: 5, z: 0, speedMps: 2, now: 2000 });
  assert.equal(state.stopElapsedMs, 0);
  assert.equal(state.stopStartedAt, null);
});

test('pit limiter decelerates hard without jumping below 100 km/h', () => {
  const first = pitLimitedVelocity(300 / 3.6, 0, 0.5);
  assert.ok(first.vx < 300 / 3.6);
  assert.ok(first.vx > PIT_SPEED_LIMIT_MPS);
  const settled = pitLimitedVelocity(first.vx, first.vz, 10);
  assert.equal(settled.vx, PIT_SPEED_LIMIT_MPS);
});
