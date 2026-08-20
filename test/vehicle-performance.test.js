import test from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';

import {
  GRAVITY, CHASSIS_MASS, MAX_ENGINE_FORCE, MAX_ENGINE_POWER,
  TARGET_TOP_SPEED_KMH, MAX_SPEED_KMH,
  buildVehicle, applyControls, applyVehicleStepForces, applySpeedCap,
  FLOOR_COLLIDER_GROUPS, WHEEL_RAY_FILTER_GROUPS, TRACK_FRICTION,
} from '../shared/vehicleConfig.js';
import { TICK_RATE } from '../shared/protocol.js';

await RAPIER.init();

const DT = 1 / TICK_RATE;
const ON_TRACK = [false, false, false, false];
const NEUTRAL = Object.freeze({ throttle: 0, steer: 0, brake: 0, handbrake: false });

function makeFlatWorld() {
  const world = new RAPIER.World(GRAVITY);
  world.timestep = DT;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(100_000, 5, 100_000)
      .setTranslation(0, -5, 0)
      .setFriction(TRACK_FRICTION)
      .setCollisionGroups(FLOOR_COLLIDER_GROUPS),
    ground
  );
  return { world, ...buildVehicle(RAPIER, world, { x: 0, y: 2, z: 0 }) };
}

function step(car, input = NEUTRAL, frozen = false) {
  applyControls(car.vehicle, car.body, input, { frozen, offtrackWheels: ON_TRACK });
  applyVehicleStepForces(car.vehicle, car.body, DT);
  car.vehicle.updateVehicle(DT, undefined, WHEEL_RAY_FILTER_GROUPS);
  car.world.step();
  applySpeedCap(car.body);
}

function settle(car) {
  for (let i = 0; i < 300; i++) step(car, NEUTRAL, true);
}

function speedKmh(body) {
  const v = body.linvel();
  return Math.hypot(v.x, v.z) * 3.6;
}

function measureAcceleration() {
  const car = makeFlatWorld();
  try {
    settle(car);
    car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    const reached = { 100: null, 200: null, 300: null };
    for (let tick = 1; tick <= TICK_RATE * 60; tick++) {
      step(car, { throttle: 1 });
      const speed = speedKmh(car.body);
      for (const target of [100, 200, 300]) {
        if (reached[target] === null && speed >= target) reached[target] = tick * DT;
      }
    }
    return { ...reached, top: speedKmh(car.body) };
  } finally {
    car.world.free();
  }
}

function measureBraking(fromKmh) {
  const car = makeFlatWorld();
  try {
    settle(car);
    const y = car.body.translation().y;
    car.body.setTranslation({ x: 0, y, z: 0 }, true);
    car.body.setLinvel({ x: 0, y: 0, z: fromKmh / 3.6 }, true);
    for (let tick = 1; tick <= TICK_RATE * 8; tick++) {
      step(car, { brake: true });
      if (speedKmh(car.body) < 1.26) {
        return { time: tick * DT, distance: car.body.translation().z };
      }
    }
    throw new Error(`the car did not stop from ${fromKmh} km/h`);
  } finally {
    car.world.free();
  }
}

function yaw(rotation) {
  const q = rotation;
  return Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
}

function measureFastCorner() {
  const car = makeFlatWorld();
  try {
    settle(car);
    const y = car.body.translation().y;
    car.body.setTranslation({ x: 0, y, z: 0 }, true);
    car.body.setLinvel({ x: 0, y: 0, z: 330 / 3.6 }, true);
    let previousVelocity = car.body.linvel();
    let previousYaw = yaw(car.body.rotation());
    let turn = 0;
    let maxLateralG = 0;
    let minUpright = 1;
    for (let tick = 0; tick < TICK_RATE * 3; tick++) {
      step(car, { throttle: 1, steer: 0.15 });
      const q = car.body.rotation();
      const currentYaw = yaw(q);
      let delta = currentYaw - previousYaw;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      turn += delta;
      previousYaw = currentYaw;

      const v = car.body.linvel();
      const speed = Math.hypot(v.x, v.z);
      const ax = (v.x - previousVelocity.x) / DT;
      const az = (v.z - previousVelocity.z) / DT;
      maxLateralG = Math.max(maxLateralG, Math.abs((-v.z * ax + v.x * az) / speed) / 9.81);
      minUpright = Math.min(minUpright, 1 - 2 * (q.x * q.x + q.z * q.z));
      previousVelocity = v;
    }
    return { turnDegrees: turn * 180 / Math.PI, maxLateralG, minUpright };
  } finally {
    car.world.free();
  }
}

test('the shared arcade F1 profile uses the canonical 600 kg mass', () => {
  const car = makeFlatWorld();
  try {
    assert.equal(CHASSIS_MASS, 600);
    assert.equal(car.body.mass(), 600);
  } finally {
    car.world.free();
  }
});

test('engine power and quadratic aero are applied once per fixed physics step', () => {
  const engine = [0, 0, 0, 0];
  const impulses = [];
  const vehicle = {
    setWheelFrictionSlip() {}, setWheelSteering() {}, setWheelBrake() {},
    setWheelEngineForce(index, value) { engine[index] = value; },
  };
  const body = {
    rotation: () => ({ x: 0, y: 0, z: 0, w: 1 }),
    linvel: () => ({ x: 0, y: 0, z: 100 }),
    applyImpulse(value) { impulses.push(value); },
  };
  applyControls(vehicle, body, { throttle: 1 });
  applyVehicleStepForces(vehicle, body, DT);

  const expectedPowerLimitedForce = MAX_ENGINE_POWER / (2 * 100);
  assert.ok(expectedPowerLimitedForce < MAX_ENGINE_FORCE);
  assert.equal(engine[2], expectedPowerLimitedForce);
  assert.equal(engine[3], expectedPowerLimitedForce);
  assert.equal(impulses.length, 1, 'aero must be one non-accumulating impulse per step');
  assert.ok(impulses[0].y < 0, 'downforce must point down');
  assert.ok(impulses[0].z < 0, 'drag must oppose forward motion');
});

test('the arcade F1 acceleration reaches 378 naturally below the emergency cap', () => {
  const result = measureAcceleration();
  assert.ok(result[100] >= 2.3 && result[100] <= 2.8, `0-100: ${result[100]} s`);
  assert.ok(result[200] >= 5.2 && result[200] <= 5.9, `0-200: ${result[200]} s`);
  assert.ok(result[300] >= 9.4 && result[300] <= 10.5, `0-300: ${result[300]} s`);
  assert.ok(Math.abs(result.top - TARGET_TOP_SPEED_KMH) <= 2, `top speed: ${result.top} km/h`);
  assert.ok(result.top < MAX_SPEED_KMH - 20, 'the emergency speed cap must stay inactive');
});

test('the 600 kg brake tune stays strong but controllable', () => {
  const from200 = measureBraking(200);
  const from300 = measureBraking(300);
  assert.ok(from200.time >= 2.0 && from200.time <= 2.4, `200-0: ${from200.time} s`);
  assert.ok(from200.distance >= 55 && from200.distance <= 65, `200-0: ${from200.distance} m`);
  assert.ok(from300.time >= 2.9 && from300.time <= 3.5, `300-0: ${from300.time} s`);
  assert.ok(from300.distance >= 115 && from300.distance <= 135, `300-0: ${from300.distance} m`);
});

test('high-speed downforce gives F1 grip without rolling the arcade chassis', () => {
  const result = measureFastCorner();
  assert.ok(result.turnDegrees >= 75 && result.turnDegrees <= 110, `turn: ${result.turnDegrees}°`);
  assert.ok(result.maxLateralG >= 4.5 && result.maxLateralG <= 6.5, `lateral: ${result.maxLateralG} G`);
  assert.ok(result.minUpright > 0.98, `upright: ${result.minUpright}`);
});
