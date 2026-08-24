import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROXY_HARD_RESET_DISTANCE_M, PROXY_MAX_POSITION_STEP_M,
  PROXY_MAX_ROTATION_STEP_RAD, PROXY_MAX_TILT_SPEED_RAD_S,
  PROXY_MAX_UPWARD_SPEED_MPS, limitProxyImpactMotion,
  planContactSafeProxyMotion, planProxyCorrection,
} from '../shared/proxyCorrection.js';

const Q0 = { x: 0, y: 0, z: 0, w: 1 };

test('ordinary proxy correction is capped per physics step', () => {
  const correction = planProxyCorrection(
    { x: 0, y: 0, z: 0 }, Q0,
    { x: 2, y: 0, z: 0 }, Q0,
  );
  assert.equal(correction.hardReset, false);
  assert.equal(correction.clamped, true);
  assert.ok(Math.abs(correction.position.x - PROXY_MAX_POSITION_STEP_M) < 1e-9);
});

test('a proxy jump larger than a car length requests a collider-safe reset', () => {
  const correction = planProxyCorrection(
    { x: 0, y: 0, z: 0 }, Q0,
    { x: PROXY_HARD_RESET_DISTANCE_M + 0.1, y: 0, z: 0 }, Q0,
  );
  assert.equal(correction.hardReset, true);
  assert.ok(Math.abs(correction.position.x - PROXY_HARD_RESET_DISTANCE_M - 0.1) < 1e-9);
});

test('proxy rotation cannot snap by more than its angular step', () => {
  const halfTurn = { x: 0, y: 1, z: 0, w: 0 };
  const correction = planProxyCorrection(
    { x: 0, y: 0, z: 0 }, Q0,
    { x: 0, y: 0, z: 0 }, halfTurn,
  );
  const angle = 2 * Math.acos(Math.min(1, Math.abs(correction.rotation.w)));
  assert.ok(angle <= PROXY_MAX_ROTATION_STEP_RAD + 1e-9);
});

test('a proxy in contact keeps its Rapier pose instead of being forced into the car again', () => {
  const motion = planContactSafeProxyMotion(
    { x: 1, y: 2, z: 3 }, Q0,
    { x: 2, y: 2, z: 3 }, Q0,
    3,
  );
  assert.equal(motion.applyNetworkMotion, false);
  assert.equal(motion.contactHeld, true);
  assert.equal(motion.remainingContactHoldSteps, 2);
  assert.deepEqual(motion.position, { x: 1, y: 2, z: 3 });
});

test('the proxy impact limiter only caps newly-created lift and pitch-roll', () => {
  const limited = limitProxyImpactMotion(
    { x: 10, y: 1, z: 20 },
    { x: 12, y: 30, z: 18 },
    { x: 8, y: 5, z: 6 },
  );
  assert.equal(limited.velocity.x, 12);
  assert.equal(limited.velocity.z, 18);
  assert.equal(limited.velocity.y, PROXY_MAX_UPWARD_SPEED_MPS);
  assert.equal(limited.angularVelocity.y, 5, 'yaw must remain physical');
  assert.ok(
    Math.hypot(limited.angularVelocity.x, limited.angularVelocity.z)
      < PROXY_MAX_TILT_SPEED_RAD_S,
  );

  const alreadyAirborne = limitProxyImpactMotion(
    { x: 0, y: 9, z: 0 },
    { x: 0, y: 10, z: 0 },
    { x: 0, y: 0, z: 0 },
  );
  assert.equal(alreadyAirborne.velocity.y, 9, 'contact must not amplify an existing jump');
});
