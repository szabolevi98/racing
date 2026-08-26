import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAR_CONTACT_MAX_INITIAL_SEPARATION_M,
  CAR_CONTACT_MAX_PUSH_DELTA_V_MPS,
  CAR_CONTACT_MAX_STATE_AGE_MS,
  CAR_CONTACT_RADIUS_M,
  CAR_CONTACT_SEGMENT_HALF_M,
  carCapsuleSeparation,
  carContactRemainsLatched,
  carContactStateIsFresh,
  resolveCarContact,
} from '../shared/carContact.js';
import { CHASSIS_SIZE } from '../shared/vehicleConfig.js';

const pose = ({ x = 0, y = 0.85, z = 0, yaw = 0, vx = 0, vz = 0 } = {}) => ({
  x, y, z, yaw, vx, vz,
});

test('every skin uses a rounded contact footprint derived from the canonical F1 chassis', () => {
  assert.equal(CAR_CONTACT_RADIUS_M, CHASSIS_SIZE.x);
  assert.equal(CAR_CONTACT_SEGMENT_HALF_M + CAR_CONTACT_RADIUS_M, CHASSIS_SIZE.z);
  const touching = carCapsuleSeparation(pose(), pose({ z: CHASSIS_SIZE.z * 2 }));
  assert.ok(Math.abs(touching.separationM) < 1e-9);
});

test('a stale remote state loses contact authority without affecting its visual lifetime', () => {
  assert.equal(carContactStateIsFresh(CAR_CONTACT_MAX_STATE_AGE_MS), true);
  assert.equal(carContactStateIsFresh(CAR_CONTACT_MAX_STATE_AGE_MS + 0.001), false);
  assert.equal(carContactStateIsFresh(Infinity), false);
  assert.equal(carContactStateIsFresh(-1), false);
});

test('cars on vertically separate track levels cannot collide', () => {
  const separation = carCapsuleSeparation(pose({ y: 0 }), pose({ y: 3 }));
  assert.equal(separation.separationM, Infinity);
});

test('the swept solver catches a complete high-speed pass-through', () => {
  const remote = pose();
  const result = resolveCarContact({
    ownPrevious: pose({ x: -2.5, vx: 300 }),
    ownCurrent: pose({ x: 2.5, vx: 300 }),
    remotePrevious: remote,
    remoteCurrent: remote,
    ownVelocity: { x: 300, z: 0 },
  });
  assert.equal(result.collided, true);
  assert.equal(result.swept, true);
  assert.ok(result.timeOfImpact > 0 && result.timeOfImpact < 1);
  assert.ok(result.position.x < -CAR_CONTACT_RADIUS_M * 2 + 0.05,
    'the local car must remain on its entry side instead of tunnelling through');
});

test('a 300 km/h rear impact stops the attacker but never mutates the remote car', () => {
  const remotePrevious = pose({ z: 0 });
  const remoteCurrent = pose({ z: 0 });
  const untouched = structuredClone(remoteCurrent);
  const speed = 300 / 3.6;
  const result = resolveCarContact({
    ownPrevious: pose({ z: -5, vz: speed }),
    ownCurrent: pose({ z: -3.6, vz: speed }),
    remotePrevious,
    remoteCurrent,
    ownVelocity: { x: 0, z: speed },
  });
  assert.equal(result.collided, true);
  assert.ok(result.velocity.z < 0, 'a hard rear impact may rebound slightly but cannot pass through');
  assert.ok(result.position.z < -CHASSIS_SIZE.z * 2);
  assert.deepEqual(remoteCurrent, untouched, 'only the local car may be resolved');
});

test('a remote high-speed hit cannot launch the local car in one tick', () => {
  const speed = 300 / 3.6;
  const result = resolveCarContact({
    ownPrevious: pose({ z: 0 }),
    ownCurrent: pose({ z: 0 }),
    remotePrevious: pose({ z: -5, vz: speed }),
    remoteCurrent: pose({ z: -3.6, vz: speed }),
    ownVelocity: { x: 0, z: 0 },
  });
  assert.equal(result.collided, true);
  assert.ok(result.deltaSpeedMps <= CAR_CONTACT_MAX_PUSH_DELTA_V_MPS + 1e-9);
  assert.ok(Math.hypot(result.velocity.x, result.velocity.z)
    <= CAR_CONTACT_MAX_PUSH_DELTA_V_MPS + 1e-9);
});

test('a network overlap separates gradually instead of teleporting the local car', () => {
  const result = resolveCarContact({
    ownPrevious: pose(),
    ownCurrent: pose(),
    remotePrevious: pose(),
    remoteCurrent: pose(),
    ownVelocity: { x: 0, z: 0 },
  });
  assert.equal(result.collided, true);
  assert.ok(result.correctionM
    <= CAR_CONTACT_MAX_INITIAL_SEPARATION_M + 0.011);
});

test('contact hysteresis prevents repeated impact impulses at the boundary', () => {
  const close = { collided: false, separationM: 0.1 };
  const released = { collided: false, separationM: 0.4 };
  assert.equal(carContactRemainsLatched(true, close), true);
  assert.equal(carContactRemainsLatched(true, released), false);
  assert.equal(carContactRemainsLatched(false, close), false);
  assert.equal(carContactRemainsLatched(false, { collided: true, separationM: 0 }), true);
});
