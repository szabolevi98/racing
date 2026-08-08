import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FRONT_FRICTION_SLIP,
  OFFTRACK_FRICTION_SLIP,
  REAR_FRICTION_SLIP,
  applyControls,
} from '../shared/vehicleConfig.js';

function harness() {
  const slip = [0, 0, 0, 0];
  return {
    slip,
    vehicle: {
      setWheelFrictionSlip(index, value) { slip[index] = value; },
      setWheelEngineForce() {},
      setWheelSteering() {},
      setWheelBrake() {},
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
