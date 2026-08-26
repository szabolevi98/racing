import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAngularMotionTracker, createVisualMotionTracker,
  observeAngularMotion, observeVisualMotion,
  resetAngularMotionTracker, resetVisualMotionTracker,
} from '../shared/visualMotion.js';

const yawQuaternion = (angle) => [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];

test('visual motion residual ignores constant velocity at uneven frame times', () => {
  const tracker = createVisualMotionTracker();
  assert.equal(observeVisualMotion(tracker, 0, 0, 0, 0), false);
  assert.equal(observeVisualMotion(tracker, 0.2, 0, 0, 20), false);
  assert.equal(observeVisualMotion(tracker, 0.55, 0, 0, 55), true);
  assert.ok(tracker.residualM < 1e-9);
  assert.ok(Math.abs(tracker.stepM - 0.35) < 1e-9);
});

test('visual motion residual reports a sudden rendered correction in metres', () => {
  const tracker = createVisualMotionTracker();
  observeVisualMotion(tracker, 0, 0, 0, 0);
  observeVisualMotion(tracker, 0.2, 0, 0, 20);
  observeVisualMotion(tracker, 0.4, 0, 0, 40);

  assert.equal(observeVisualMotion(tracker, 1.6, 0, 0, 60), true);
  assert.ok(Math.abs(tracker.residualM - 1) < 1e-9);
});

test('long frames and teleports restart visual tracking without false jitter', () => {
  const tracker = createVisualMotionTracker();
  observeVisualMotion(tracker, 0, 0, 0, 0);
  observeVisualMotion(tracker, 0.2, 0, 0, 20);
  assert.equal(observeVisualMotion(tracker, 3, 0, 0, 250), false);
  assert.equal(tracker.samples, 1);
  assert.equal(observeVisualMotion(tracker, 3.2, 0, 0, 270), false);
  assert.equal(observeVisualMotion(tracker, 40, 0, 0, 290), false);
  assert.equal(tracker.samples, 1);
});

test('invalid input and explicit reset clear visual tracker continuity', () => {
  const tracker = createVisualMotionTracker();
  observeVisualMotion(tracker, 0, 0, 0, 0);
  assert.equal(observeVisualMotion(tracker, Number.NaN, 0, 0, 20), false);
  assert.equal(tracker.samples, 0);
  observeVisualMotion(tracker, 1, 0, 0, 40);
  resetVisualMotionTracker(tracker);
  assert.equal(tracker.samples, 0);
  assert.equal(tracker.residualM, 0);
});

test('angular residual ignores constant camera rotation at uneven frame times', () => {
  const tracker = createAngularMotionTracker();
  assert.equal(observeAngularMotion(tracker, ...yawQuaternion(0), 0), false);
  assert.equal(observeAngularMotion(tracker, ...yawQuaternion(0.02), 20), false);
  assert.equal(observeAngularMotion(tracker, ...yawQuaternion(0.055), 55), true);
  assert.ok(tracker.residualRad < 1e-9);
});

test('angular residual reports a sudden camera direction correction', () => {
  const tracker = createAngularMotionTracker();
  observeAngularMotion(tracker, ...yawQuaternion(0), 0);
  observeAngularMotion(tracker, ...yawQuaternion(0.02), 20);
  observeAngularMotion(tracker, ...yawQuaternion(0.04), 40);
  assert.equal(observeAngularMotion(tracker, ...yawQuaternion(0.16), 60), true);
  assert.ok(Math.abs(tracker.residualRad - 0.1) < 1e-9);
  resetAngularMotionTracker(tracker);
  assert.equal(tracker.samples, 0);
});
