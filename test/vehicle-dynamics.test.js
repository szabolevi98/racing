import test from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';

import {
  AERO_DOWNFORCE_COEFFICIENT,
  BRAKE_FRONT,
  BRAKE_REAR,
  FLOOR_COLLIDER_GROUPS,
  FRONT_SIDE_FRICTION_STIFFNESS,
  GRAVITY,
  LOW_SPEED_STEERING_INPUT_RATE,
  REAR_SIDE_FRICTION_STIFFNESS,
  STEERING_INPUT_RATE,
  SUSPENSION_REST_LENGTH,
  WHEEL_RAY_FILTER_GROUPS,
  applyAerodynamics,
  applyControls,
  buildVehicle,
  moveSteeringInput,
} from '../shared/vehicleConfig.js';

await RAPIER.init();

function controlsHarness() {
  const brake = [0, 0, 0, 0];
  let angularWrites = 0;
  return {
    vehicle: {
      setWheelFrictionSlip() {},
      setWheelEngineForce() {},
      setWheelSteering() {},
      setWheelBrake(index, value) { brake[index] = value; },
    },
    body: {
      linvel: () => ({ x: 0, y: 0, z: 0 }),
      setLinvel() {},
      angvel: () => ({ x: 0, y: 1, z: 0 }),
      setAngvel() { angularWrites++; },
    },
    brake,
    get angularWrites() { return angularWrites; },
  };
}

function createFlatCar() {
  const world = new RAPIER.World(GRAVITY);
  world.timestep = 1 / 60;
  const floorBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(1000, 0.1, 1000)
      .setTranslation(0, -0.1, 0)
      .setFriction(1)
      .setCollisionGroups(FLOOR_COLLIDER_GROUPS),
    floorBody
  );
  const car = buildVehicle(RAPIER, world, { x: 0, y: 1, z: 0 });
  for (let i = 0; i < 180; i++) {
    car.vehicle.updateVehicle(world.timestep, undefined, WHEEL_RAY_FILTER_GROUPS);
    world.step();
  }
  const y = car.body.translation().y;
  car.body.setTranslation({ x: 0, y, z: 0 }, true);
  car.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  return { world, car };
}

function yaw(q) {
  return Math.atan2(
    2 * (q.w * q.y + q.x * q.z),
    1 - 2 * (q.y * q.y + q.z * q.z)
  );
}

function normalizeAngle(value) {
  let result = value;
  while (result > Math.PI) result -= Math.PI * 2;
  while (result < -Math.PI) result += Math.PI * 2;
  return result;
}

function runBrakingSteerTap(holdTicks) {
  const { world, car } = createFlatCar();
  try {
    car.body.setLinvel({ x: 0, y: 0, z: 300 / 3.6 }, true);
    let steering = 0;
    let maxSlip = 0;
    let maxYaw = 0;

    for (let i = 0; i < 240; i++) {
      steering = moveSteeringInput(steering, i < holdTicks ? 1 : 0, world.timestep);
      applyControls(car.vehicle, car.body, { steer: steering, brake: true });
      car.vehicle.updateVehicle(world.timestep, undefined, WHEEL_RAY_FILTER_GROUPS);
      applyAerodynamics(car.body, car.vehicle, world.timestep);
      world.step();

      const q = car.body.rotation();
      const v = car.body.linvel();
      const speed = Math.hypot(v.x, v.z);
      if (speed > 10) {
        maxSlip = Math.max(maxSlip, Math.abs(normalizeAngle(Math.atan2(v.x, v.z) - yaw(q))));
      }
      maxYaw = Math.max(maxYaw, Math.abs(yaw(q)));
      if (speed < 0.5) break;
    }

    return { maxSlipDeg: maxSlip * 180 / Math.PI, maxYawDeg: maxYaw * 180 / Math.PI };
  } finally {
    world.free();
  }
}

test('normal brake remains driver-controlled instead of applying stability assist', () => {
  const straight = controlsHarness();
  applyControls(straight.vehicle, straight.body, { steer: 0, brake: true });
  assert.deepEqual(straight.brake, [BRAKE_FRONT, BRAKE_FRONT, BRAKE_REAR, BRAKE_REAR]);

  const turning = controlsHarness();
  applyControls(turning.vehicle, turning.body, { steer: 1, brake: true });
  assert.deepEqual(turning.brake, [BRAKE_FRONT, BRAKE_FRONT, BRAKE_REAR, BRAKE_REAR]);
  assert.equal(turning.angularWrites, 0, 'normal braking must not rewrite chassis yaw');
});

test('digital steering has finite travel instead of snapping to full lock', () => {
  const oneTick = moveSteeringInput(0, 1, 1 / 60, 300);
  assert.ok(Math.abs(oneTick - STEERING_INPUT_RATE / 60) < 1e-12);
  assert.ok(oneTick > 0 && oneTick < 1);

  const lowSpeedTick = moveSteeringInput(0, 1, 1 / 60, 20);
  assert.ok(Math.abs(lowSpeedTick - LOW_SPEED_STEERING_INPUT_RATE / 60) < 1e-12);
  assert.ok(lowSpeedTick > oneTick, 'low-speed steering should react faster');

  let steering = 0;
  for (let i = 0; i < 60; i++) steering = moveSteeringInput(steering, 1, 1 / 60, 300);
  assert.equal(steering, 1, 'holding the key must still reach full steering');
});

test('vehicle build applies the physical suspension, aero and axle tire setup', () => {
  const { world, car } = createFlatCar();
  try {
    assert.equal(car.vehicle.wheelSuspensionRestLength(0), SUSPENSION_REST_LENGTH);
    assert.ok(Math.abs(car.vehicle.wheelSideFrictionStiffness(0) - FRONT_SIDE_FRICTION_STIFFNESS) < 1e-6);
    assert.ok(Math.abs(car.vehicle.wheelSideFrictionStiffness(2) - REAR_SIDE_FRICTION_STIFFNESS) < 1e-6);
    assert.ok(AERO_DOWNFORCE_COEFFICIENT > 0);
  } finally {
    world.free();
  }
});

test('brief correction under full braking is stable, sustained over-input can still spin', () => {
  const correction = runBrakingSteerTap(10);
  assert.ok(correction.maxSlipDeg < 5, `brief correction slip was ${correction.maxSlipDeg.toFixed(1)}°`);
  assert.ok(correction.maxYawDeg < 30, `brief correction yaw was ${correction.maxYawDeg.toFixed(1)}°`);

  const overInput = runBrakingSteerTap(15);
  assert.ok(overInput.maxSlipDeg > 20, 'sustained full brake and steering must remain capable of losing grip');
});

test('straight 200 km/h braking remains near the measured F1 target', () => {
  const { world, car } = createFlatCar();
  try {
    car.body.setLinvel({ x: 0, y: 0, z: 200 / 3.6 }, true);
    const startZ = car.body.translation().z;
    let ticks = 0;
    for (; ticks < 600; ticks++) {
      applyControls(car.vehicle, car.body, { brake: true });
      car.vehicle.updateVehicle(world.timestep, undefined, WHEEL_RAY_FILTER_GROUPS);
      applyAerodynamics(car.body, car.vehicle, world.timestep);
      world.step();
      if (Math.hypot(car.body.linvel().x, car.body.linvel().z) < 0.5) break;
    }
    const seconds = ticks / 60;
    const distance = car.body.translation().z - startZ;
    assert.ok(seconds > 2 && seconds < 2.4, `stop time was ${seconds.toFixed(2)} s`);
    assert.ok(distance > 55 && distance < 65, `stopping distance was ${distance.toFixed(1)} m`);
  } finally {
    world.free();
  }
});
