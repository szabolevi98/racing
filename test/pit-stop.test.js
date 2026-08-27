import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PIT_SPEED_LIMIT_MPS, PIT_STOP_DURATION_MS, createPitState, hasCompletePitConfig,
  normalizePitConfig, pitLimitedVelocity, updatePitState,
} from '../shared/pit.js';

const pit = {
  entries: [{ x1: 0, z1: -5, x2: 0, z2: 5 }],
  exits: [{ x1: 20, z1: -5, x2: 20, z2: 5 }],
  stops: Array.from({ length: 8 }, (_, i) => ({ x: 5 + i, z: 0, heading: 0 })),
};

test('tire service only activates with a complete 8-stall configuration', () => {
  assert.equal(hasCompletePitConfig(pit), true);
  assert.equal(hasCompletePitConfig({ ...pit, exits: [] }), false);
  assert.equal(hasCompletePitConfig({ ...pit, stops: pit.stops.slice(0, 7) }), false);
});

test('multiple pit entry and exit gates stay available after normalization', () => {
  const multiple = normalizePitConfig({
    entries: [pit.entries[0], { x1: 2, z1: -5, x2: 2, z2: 5 }],
    exits: [pit.exits[0], { x1: 22, z1: -5, x2: 22, z2: 5 }],
    stops: pit.stops,
  });
  assert.equal(multiple.entries.length, 2);
  assert.equal(multiple.exits.length, 2);
  assert.equal(hasCompletePitConfig(multiple), true);
});

test('crossing any configured entry and exit controls the pit lane state', () => {
  const multiple = {
    entries: [pit.entries[0], { x1: 2, z1: -5, x2: 2, z2: 5 }],
    exits: [pit.exits[0], { x1: 22, z1: -5, x2: 22, z2: 5 }],
    stops: pit.stops,
  };
  const state = createPitState(true);
  updatePitState(state, multiple, 0, { fromX: 1, fromZ: 0, x: 3, z: 0, speedMps: 20, now: 1000 });
  assert.equal(state.inLane, true, 'the second entry also enables the limiter');
  updatePitState(state, multiple, 0, { fromX: 21, fromZ: 0, x: 23, z: 0, speedMps: 20, now: 2000 });
  assert.equal(state.inLane, false, 'the second exit also disables the limiter');
});

test('pit state changes one set after three continuous stopped seconds in the assigned stall', () => {
  const state = createPitState(true);
  updatePitState(state, pit, 2, { fromX: -1, fromZ: 0, x: 1, z: 0, speedMps: 20, now: 1000 });
  assert.equal(state.inLane, true);
  updatePitState(state, pit, 2, { fromX: 1, fromZ: 0, x: 7, z: 0, speedMps: 0, now: 2000 });
  updatePitState(state, pit, 2, { fromX: 7, fromZ: 0, x: 7, z: 0, speedMps: 0, now: 2000 + PIT_STOP_DURATION_MS - 1 });
  assert.equal(state.changeCount, 0);
  updatePitState(state, pit, 2, { fromX: 7, fromZ: 0, x: 7, z: 0, speedMps: 0, now: 2000 + PIT_STOP_DURATION_MS });
  assert.equal(state.servicedThisVisit, true);
  assert.equal(state.changeCount, 1);

  updatePitState(state, pit, 2, { fromX: 7, fromZ: 0, x: 7, z: 0, speedMps: 0, now: 9000 });
  assert.equal(state.changeCount, 1, 'standing still cannot repeatedly create fresh sets');

  updatePitState(state, pit, 2, { fromX: 7, fromZ: 0, x: 12, z: 0, speedMps: 2, now: 9100 });
  updatePitState(state, pit, 2, { fromX: 12, fromZ: 0, x: 7, z: 0, speedMps: 0, now: 9200 });
  updatePitState(state, pit, 2, { fromX: 7, fromZ: 0, x: 7, z: 0, speedMps: 0, now: 9200 + PIT_STOP_DURATION_MS });
  assert.equal(state.changeCount, 2, 'leaving the stall arms another tire change');
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
