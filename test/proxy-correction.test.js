import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROXY_HARD_RESET_DISTANCE_M, PROXY_MAX_POSITION_STEP_M,
  PROXY_MAX_ROTATION_STEP_RAD, planProxyCorrection,
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
