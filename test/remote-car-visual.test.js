import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  remoteVisualCorrectionHalfLife, remoteVisualPredictionBlend,
} from '../shared/remoteVisual.js';

const mp = fs.readFileSync(new URL('../web/mp.js', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../web/main.js', import.meta.url), 'utf8');

test('remote cars use the measured chassis height instead of the old fixed offset', () => {
  assert.match(mp, /model\.position\.y = -box3\.min\.y - G\.getCarGroundOffset\(\)/);
  assert.doesNotMatch(mp, /model\.position\.y = -box3\.min\.y - 0\.85/);
  assert.match(main, /getCarGroundOffset\(\) \{ return groundOffset; \}/);
});

test('remote wheel steering and rolling survive buffering and reach wheel pivots', () => {
  assert.match(mp, /st: c\.st \?\? 0, wr: c\.wr \?\? 0/);
  assert.match(mp, /st: \(a\.st \?\? 0\) \+ /);
  assert.match(mp, /wr: \(a\.wr \?\? 0\) \+ /);
  assert.match(mp, /createRemoteWheelRig\(model, car\.config\?\.wheelPattern, group\)/);
  assert.match(mp, /\.rotation\.set\(s\.wr \?\? 0, source\?\.steer \? \(s\.st \?\? 0\) : 0, 0\)/);
});

test('multiplayer frame keeps the delta time used by remote car smoothing and audio', () => {
  assert.match(mp, /function frame\(dt = 1 \/ 60\)/);
  assert.match(mp, /remoteVisualCorrectionHalfLife\(interpDelayMs, predictionBlend\)/);
  assert.match(mp, /Math\.pow\(0\.5, dt \/ halfLife\)/);
  assert.match(mp, /G\.updateRemoteEngine\([\s\S]*?\}, dt\);/);
  assert.match(main, /function stepMultiplayerFrame\(dt\) \{\s*mpFrameHook\?\.\(dt\);/);
});

test('remote visuals blend gradually toward prediction without changing the 20 Hz snapshot rate', () => {
  assert.equal(remoteVisualPredictionBlend(80), 0);
  assert.equal(remoteVisualPredictionBlend(20), 1);
  assert.ok(remoteVisualPredictionBlend(60) > 0);
  assert.ok(remoteVisualPredictionBlend(60) < remoteVisualPredictionBlend(40));
  assert.match(mp, /blendRemoteStates\(delayedState, currentState, predictionBlend\)/);
  assert.doesNotMatch(mp, /const s = near \? currentState : delayedState/);
  assert.match(fs.readFileSync(new URL('../shared/protocol.js', import.meta.url), 'utf8'), /SNAPSHOT_RATE = 20/);
});

test('remote correction becomes softer as network delay grows', () => {
  const lowPing = remoteVisualCorrectionHalfLife(100, 1);
  const highPing = remoteVisualCorrectionHalfLife(300, 1);
  assert.ok(highPing > lowPing);
  assert.ok(lowPing >= 0.05);
  assert.ok(highPing <= 0.15);
});
