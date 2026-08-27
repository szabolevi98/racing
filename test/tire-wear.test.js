import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TIRE_WEAR_PER_LAP,
  advanceTireWearByCheckpoints,
  changeTires,
  createTireWearState,
  encodeTireWearSnapshot,
  syncTireWearSnapshot,
  tireConditionPercent,
  tireGripMultipliers,
  tireWearLevel,
} from '../shared/tireWear.js';

const CHECKPOINTS = 60;
const closeTo = (actual, expected, message = '') => {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${message} (${actual} !== ${expected})`);
};
const advanceLap = (tires, count = CHECKPOINTS) => {
  for (let i = 0; i < count; i++) {
    advanceTireWearByCheckpoints(tires, 1, CHECKPOINTS);
  }
};

test('wear starts at the first checkpoint and one set lasts about three laps', () => {
  const tires = createTireWearState(true);
  advanceTireWearByCheckpoints(tires, 1, CHECKPOINTS);
  assert.ok(tires.wear > 0, 'the first lap is no longer wear-free');

  advanceTireWearByCheckpoints(tires, CHECKPOINTS - 1, CHECKPOINTS);
  closeTo(tires.wear, TIRE_WEAR_PER_LAP, 'one lap must consume one third');
  assert.equal(tireConditionPercent(tires), 67);

  advanceLap(tires);
  closeTo(tires.wear, 2 / 3, 'two laps must consume two thirds');
  assert.equal(tireConditionPercent(tires), 33);

  advanceLap(tires);
  closeTo(tires.wear, 1, 'three laps must reach the wear cap');
  assert.equal(tireConditionPercent(tires), 0);
  advanceLap(tires);
  assert.equal(tires.wear, 1, 'wear is capped instead of causing a puncture');
});

test('every fresh set begins wearing immediately after a tire change', () => {
  const tires = createTireWearState(true);
  advanceLap(tires);
  assert.equal(changeTires(tires), true);
  assert.equal(tires.wear, 0);
  assert.equal(tires.changeCount, 1);

  advanceTireWearByCheckpoints(tires, 1, CHECKPOINTS);
  closeTo(tires.wear, 1 / (3 * CHECKPOINTS));
});

test('missing checkpoints can be charged at the finish without double wear', () => {
  const tires = createTireWearState(true);
  const crossed = 52;
  advanceTireWearByCheckpoints(tires, crossed, CHECKPOINTS);
  advanceTireWearByCheckpoints(tires, CHECKPOINTS - crossed, CHECKPOINTS);
  closeTo(tires.wear, 1 / 3, 'a completed shortcut lap must still cost a full lap');
});

test('the wear curve creates the intended 3, 5 and 10 lap strategy windows', () => {
  const threeLaps = createTireWearState(true);
  for (let lap = 1; lap <= 3; lap++) advanceLap(threeLaps);
  closeTo(threeLaps.wear, 1, 'without a stop the third lap ends at the wear cap');

  const fiveLaps = createTireWearState(true);
  for (let lap = 1; lap <= 5; lap++) {
    advanceLap(fiveLaps);
    if (lap === 2) changeTires(fiveLaps);
  }
  closeTo(fiveLaps.wear, 1, 'one stop completes five laps, a second keeps more grip');

  const tenLaps = createTireWearState(true);
  for (let lap = 1; lap <= 10; lap++) {
    advanceLap(tenLaps);
    if (lap === 3 || lap === 6) changeTires(tenLaps);
  }
  assert.equal(tenLaps.changeCount, 2);
  closeTo(tenLaps.wear, 1, 'two stops finish at the cap, a third avoids it');
});

test('wear alerts use persistent 60, 40 and 20 percent condition thresholds', () => {
  const tires = createTireWearState(true);
  for (const [wear, level] of [
    [0.39, 'fresh'],
    [0.4, 'wearing'],
    [0.59, 'wearing'],
    [0.6, 'recommended'],
    [0.79, 'recommended'],
    [0.8, 'critical'],
  ]) {
    tires.wear = wear;
    assert.equal(tireWearLevel(tires), level);
  }
});

test('grip loss is progressive and bounded', () => {
  const fresh = tireGripMultipliers(0);
  const half = tireGripMultipliers(0.5);
  const worn = tireGripMultipliers(1);
  assert.deepEqual(fresh, { longitudinal: 1, lateral: 1 });
  assert.ok(half.longitudinal < fresh.longitudinal && half.longitudinal > worn.longitudinal);
  assert.ok(half.lateral < fresh.lateral && half.lateral > worn.lateral);
  assert.ok(Math.abs(worn.longitudinal - 0.82) < 1e-12);
  assert.ok(Math.abs(worn.lateral - 0.75) < 1e-12);
});

test('server snapshots correct wear but an old snapshot cannot undo a local tire change', () => {
  const server = createTireWearState(true);
  advanceTireWearByCheckpoints(server, 45, CHECKPOINTS);
  const oldSnapshot = encodeTireWearSnapshot(server);

  const client = createTireWearState(true);
  assert.equal(syncTireWearSnapshot(client, oldSnapshot), true);
  assert.equal(client.wear, 0.25);
  changeTires(client);
  assert.equal(syncTireWearSnapshot(client, oldSnapshot), false);
  assert.equal(client.wear, 0);

  changeTires(server);
  const freshSnapshot = encodeTireWearSnapshot(server);
  assert.deepEqual(freshSnapshot, { w: 0, c: 1 });
  assert.equal(syncTireWearSnapshot(client, freshSnapshot), true);
  assert.equal(client.changeCount, 1);
  assert.equal(client.wear, 0);
});

test('invalid checkpoint counts and disabled wear are harmless', () => {
  const tires = createTireWearState(true);
  advanceTireWearByCheckpoints(tires, 1, 0);
  advanceTireWearByCheckpoints(tires, 0, CHECKPOINTS);
  assert.equal(tires.wear, 0);

  const disabled = createTireWearState(false);
  advanceTireWearByCheckpoints(disabled, 100, CHECKPOINTS);
  assert.equal(changeTires(disabled), false);
  assert.equal(disabled.wear, 0);
  assert.equal(encodeTireWearSnapshot(disabled), null);
});
