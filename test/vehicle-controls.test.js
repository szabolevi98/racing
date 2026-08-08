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
  const brake = [0, 0, 0, 0];
  return {
    slip,
    brake,
    vehicle: {
      setWheelFrictionSlip(index, value) { slip[index] = value; },
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
