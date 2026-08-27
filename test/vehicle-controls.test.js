import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BRAKE_FRONT,
  BRAKE_REAR,
  FRONT_FRICTION_SLIP,
  OFFTRACK_FRICTION_SLIP,
  REAR_FRICTION_SLIP,
  applyControls,
} from '../shared/vehicleConfig.js';

function harness() {
  const slip = [0, 0, 0, 0];
  const side = [0, 0, 0, 0];
  const brake = [0, 0, 0, 0];
  return {
    slip,
    side,
    brake,
    vehicle: {
      setWheelFrictionSlip(index, value) { slip[index] = value; },
      setWheelSideFrictionStiffness(index, value) { side[index] = value; },
      setWheelEngineForce() {},
      setWheelSteering() {},
      setWheelBrake(index, value) { brake[index] = value; },
    },
    body: {
      linvel: () => ({ x: 0, y: 0, z: 0 }),
      setLinvel() {},
    },
  };
}

test('asphalt uses axle grip while each offtrack wheel uses the independent runoff grip', () => {
  const asphalt = harness();
  applyControls(asphalt.vehicle, asphalt.body, {});
  assert.deepEqual(asphalt.slip, [
    FRONT_FRICTION_SLIP,
    FRONT_FRICTION_SLIP,
    REAR_FRICTION_SLIP,
    REAR_FRICTION_SLIP,
  ]);
  assert.deepEqual(asphalt.side, [1, 1, 1, 1]);

  const mixed = harness();
  applyControls(
    mixed.vehicle,
    mixed.body,
    {},
    { offtrackWheels: [true, false, true, false] }
  );
  assert.deepEqual(mixed.slip, [
    OFFTRACK_FRICTION_SLIP,
    FRONT_FRICTION_SLIP,
    OFFTRACK_FRICTION_SLIP,
    REAR_FRICTION_SLIP,
  ]);
  assert.deepEqual(mixed.side, [1, 1, 1, 1]);
});

test('worn tires reduce asphalt grip without changing the runoff profile', () => {
  const worn = harness();
  applyControls(
    worn.vehicle,
    worn.body,
    {},
    { tireWear: 1, offtrackWheels: [false, false, true, true] }
  );
  assert.ok(worn.slip[0] < FRONT_FRICTION_SLIP);
  assert.ok(worn.slip[1] < FRONT_FRICTION_SLIP);
  assert.equal(worn.slip[2], OFFTRACK_FRICTION_SLIP);
  assert.equal(worn.slip[3], OFFTRACK_FRICTION_SLIP);
  assert.ok(worn.side[0] < 1);
  assert.ok(worn.side[1] < 1);
  assert.equal(worn.side[2], 1);
  assert.equal(worn.side[3], 1);
});

test('analog brake scales both axles while boolean brake stays full strength', () => {
  const half = harness();
  applyControls(half.vehicle, half.body, { brake: 0.5 });
  assert.deepEqual(half.brake, [
    BRAKE_FRONT * 0.5,
    BRAKE_FRONT * 0.5,
    BRAKE_REAR * 0.5,
    BRAKE_REAR * 0.5,
  ]);

  const keyboard = harness();
  applyControls(keyboard.vehicle, keyboard.body, { brake: true });
  assert.deepEqual(keyboard.brake, [BRAKE_FRONT, BRAKE_FRONT, BRAKE_REAR, BRAKE_REAR]);
});
