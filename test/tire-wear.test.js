import test from 'node:test';
import assert from 'node:assert/strict';

import {
  advanceTireWear,
  changeTires,
  completeTireCalibrationLap,
  createTireWearState,
  encodeTireWearSnapshot,
  restartTireCalibrationLap,
  syncTireWearSnapshot,
  tireConditionPercent,
  tireGripMultipliers,
  tireWearLevel,
} from '../shared/tireWear.js';

test('the first reference lap is wear-free and later laps add 50% wear', () => {
  const tires = createTireWearState(true);
  advanceTireWear(tires, 1_000);
  assert.equal(tires.wear, 0);
  assert.equal(completeTireCalibrationLap(tires), true);
  assert.equal(tires.referenceLapDistance, 1_000);

  advanceTireWear(tires, 1_000);
  assert.equal(tires.wear, 0.5);
  assert.equal(tireConditionPercent(tires), 50);
  advanceTireWear(tires, 1_000);
  assert.equal(tires.wear, 1);
  advanceTireWear(tires, 1_000);
  assert.equal(tires.wear, 1, 'wear is capped instead of causing a puncture');
});

test('every fresh set gets one reference lap before it starts wearing', () => {
  const tires = createTireWearState(true);
  advanceTireWear(tires, 1_000);
  completeTireCalibrationLap(tires);
  advanceTireWear(tires, 1_000);
  assert.equal(tires.wear, 0.5);

  assert.equal(changeTires(tires), true);
  assert.equal(tires.wear, 0);
  assert.equal(tires.changeCount, 1);
  advanceTireWear(tires, 1_000);
  assert.equal(tires.wear, 0, 'the first distance-equivalent lap is protected');
  advanceTireWear(tires, 500);
  assert.equal(tires.wear, 0.25);
  advanceTireWear(tires, 500);
  assert.equal(tires.wear, 0.5);
});

test('the wear curve creates the intended 3, 5 and 10 lap strategy windows', () => {
  const freshRace = () => {
    const tires = createTireWearState(true);
    advanceTireWear(tires, 1_000); // first race lap
    completeTireCalibrationLap(tires);
    return tires;
  };

  const threeLaps = freshRace();
  advanceTireWear(threeLaps, 1_000); // lap 2: 50%
  assert.equal(threeLaps.wear, 0.5);
  advanceTireWear(threeLaps, 1_000); // lap 3: 100%
  assert.equal(threeLaps.wear, 1, 'a three-lap race strongly rewards one stop');

  const fiveLaps = freshRace();
  advanceTireWear(fiveLaps, 1_000);
  changeTires(fiveLaps);             // stop after lap 2
  advanceTireWear(fiveLaps, 1_000); // lap 3: protected
  advanceTireWear(fiveLaps, 1_000); // lap 4: 50%
  advanceTireWear(fiveLaps, 1_000); // lap 5: 100%
  assert.equal(fiveLaps.wear, 1, 'one stop finishes, a second stop is faster');

  const tenLaps = freshRace();
  for (let lap = 2; lap <= 10; lap++) {
    advanceTireWear(tenLaps, 1_000);
    if (lap === 3 || lap === 6) changeTires(tenLaps);
  }
  assert.equal(tenLaps.changeCount, 2);
  assert.equal(tenLaps.wear, 1, 'two stops finish at the wear cap, a third avoids it');
});

test('a rejected shortcut cannot calibrate every later tire set to a short lap', () => {
  const tires = createTireWearState(true);
  advanceTireWear(tires, 200);
  assert.equal(restartTireCalibrationLap(tires), true);
  advanceTireWear(tires, 900);
  completeTireCalibrationLap(tires);
  assert.equal(tires.referenceLapDistance, 900);
});

test('wear alerts and grip loss are progressive and bounded', () => {
  const tires = createTireWearState(true);
  for (const [wear, level] of [
    [0.39, 'fresh'], [0.4, 'wearing'], [0.5, 'recommended'], [0.8, 'critical'],
  ]) {
    tires.wear = wear;
    assert.equal(tireWearLevel(tires), level);
  }

  const fresh = tireGripMultipliers(0);
  const half = tireGripMultipliers(0.5);
  const worn = tireGripMultipliers(1);
  assert.deepEqual(fresh, { longitudinal: 1, lateral: 1 });
  assert.ok(half.longitudinal < fresh.longitudinal && half.longitudinal > worn.longitudinal);
  assert.ok(half.lateral < fresh.lateral && half.lateral > worn.lateral);
  assert.ok(Math.abs(worn.longitudinal - 0.82) < 1e-12);
  assert.ok(Math.abs(worn.lateral - 0.75) < 1e-12);
});

test('server snapshots correct prediction but an old snapshot cannot undo a local tire change', () => {
  const server = createTireWearState(true);
  advanceTireWear(server, 1_000);
  completeTireCalibrationLap(server);
  advanceTireWear(server, 800);
  const oldSnapshot = encodeTireWearSnapshot(server);

  const client = createTireWearState(true);
  assert.equal(syncTireWearSnapshot(client, oldSnapshot), true);
  assert.equal(client.wear, 0.4);
  changeTires(client);
  assert.equal(syncTireWearSnapshot(client, oldSnapshot), false);
  assert.equal(client.wear, 0);

  changeTires(server);
  const freshSnapshot = encodeTireWearSnapshot(server);
  assert.equal(syncTireWearSnapshot(client, freshSnapshot), true);
  assert.equal(client.changeCount, 1);
  assert.equal(client.wear, 0);
});

test('disabled tire wear leaves every value untouched', () => {
  const tires = createTireWearState(false);
  advanceTireWear(tires, 50_000);
  assert.equal(changeTires(tires), false);
  assert.equal(completeTireCalibrationLap(tires), false);
  assert.equal(tires.wear, 0);
  assert.equal(encodeTireWearSnapshot(tires), null);
});
