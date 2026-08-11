import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  approachLocalRenderDelay, LOCAL_RENDER_DELAY_MAX_MS, LOCAL_RENDER_DELAY_MIN_MS,
  localRenderDelayTarget, remoteDetailUpdateInterval,
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

test('remote detail throttling always keeps the spectated car at full rate', () => {
  assert.equal(remoteDetailUpdateInterval(20), 1);
  assert.equal(remoteDetailUpdateInterval(100), 2);
  assert.equal(remoteDetailUpdateInterval(220), 4);
  assert.equal(remoteDetailUpdateInterval(500), 8);
  assert.equal(remoteDetailUpdateInterval(500, true), 1);
  assert.match(mp, /const watched = o === watchedEntry/);
  assert.match(mp, /remoteDetailUpdateInterval\(cameraDistance, watched\)/);
  assert.match(mp, /if \(!watched && labelDistSq > REMOTE_RENDER_MAX_RANGE_SQ\)/);
});

test('local render delay grows with timer stress and changes without a timeline jump', () => {
  assert.equal(localRenderDelayTarget(0, 0), LOCAL_RENDER_DELAY_MIN_MS);
  assert.ok(localRenderDelayTarget(15, 8) > LOCAL_RENDER_DELAY_MIN_MS);
  assert.equal(localRenderDelayTarget(500, 500), LOCAL_RENDER_DELAY_MAX_MS);
  const raised = approachLocalRenderDelay(LOCAL_RENDER_DELAY_MIN_MS, LOCAL_RENDER_DELAY_MAX_MS, 16);
  assert.ok(raised > LOCAL_RENDER_DELAY_MIN_MS);
  assert.ok(raised < LOCAL_RENDER_DELAY_MAX_MS);
  const lowered = approachLocalRenderDelay(LOCAL_RENDER_DELAY_MAX_MS, LOCAL_RENDER_DELAY_MIN_MS, 16);
  assert.ok(lowered < LOCAL_RENDER_DELAY_MAX_MS);
  assert.ok(lowered > raised);
  assert.match(mp, /observePhysicsTimer\(now - next\)/);
  assert.match(mp, /get predDelayMs\(\)/);
});

test('Hot Lap ghost uses hashed depth-writing transparency instead of blended overdraw', () => {
  assert.match(mp, /clone\.transparent = false/);
  assert.match(mp, /clone\.alphaHash = true/);
  assert.match(mp, /clone\.depthWrite = true/);
  assert.doesNotMatch(mp, /clone\.depthWrite = false/);
});

test('multiplayer frame keeps elapsed time for remote car smoothing and throttled audio', () => {
  assert.match(mp, /function frame\(dt = 1 \/ 60\)/);
  assert.match(mp, /remoteVisualCorrectionHalfLife\(interpDelayMs, predictionBlend\)/);
  assert.match(mp, /Math\.pow\(0\.5, dt \/ halfLife\)/);
  assert.match(mp, /o\.audioDt = Math\.min\(0\.5, \(o\.audioDt \|\| 0\) \+ dt\)/);
  assert.match(mp, /G\.updateRemoteEngine\([\s\S]*?\}, o\.audioDt\);/);
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
