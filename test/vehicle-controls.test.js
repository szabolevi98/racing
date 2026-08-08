import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyControls, BRAKE_FRONT, BRAKE_REAR, HANDBRAKE_FORCE,
  BRAKE_TURN_FRONT_FACTOR, BRAKE_TURN_REAR_FACTOR,
} from '../shared/vehicleConfig.js';

function controlsHarness() {
  const brake = [0, 0, 0, 0];
  const vehicle = {
    setWheelFrictionSlip() {},
    setWheelEngineForce() {},
    setWheelSteering() {},
    setWheelBrake(index, value) { brake[index] = value; },
  };
  const body = {
    linvel: () => ({ x: 0, y: 0, z: 0 }),
    setLinvel() {},
  };
  return { vehicle, body, brake };
}

test('normal brake keeps full force straight and yields grip while steering', () => {
  const straight = controlsHarness();
  applyControls(straight.vehicle, straight.body, { steer: 0, brake: true });
  assert.deepEqual(straight.brake, [BRAKE_FRONT, BRAKE_FRONT, BRAKE_REAR, BRAKE_REAR]);

  const turning = controlsHarness();
  applyControls(turning.vehicle, turning.body, { steer: 1, brake: true });
  assert.deepEqual(turning.brake, [
    BRAKE_FRONT * BRAKE_TURN_FRONT_FACTOR,
    BRAKE_FRONT * BRAKE_TURN_FRONT_FACTOR,
    BRAKE_REAR * BRAKE_TURN_REAR_FACTOR,
    BRAKE_REAR * BRAKE_TURN_REAR_FACTOR,
  ]);

  const handbrake = controlsHarness();
  applyControls(handbrake.vehicle, handbrake.body, { steer: 1, brake: true, handbrake: true });
  assert.equal(handbrake.brake[2], HANDBRAKE_FORCE);
  assert.equal(handbrake.brake[3], HANDBRAKE_FORCE);
});
