import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  approachLocalRenderDelay, LOCAL_RENDER_DELAY_MAX_MS, LOCAL_RENDER_DELAY_MIN_MS,
  localRenderDelayTarget, remoteDetailPhase, remoteDetailUpdateInterval,
  REMOTE_DETAIL_BUCKETS,
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

// A ritkításnak csak akkor van értelme, ha a mezőny NEM ugyanabban a
// képkockában végzi el a maradék munkát. A korábbi `Number(id) % 8` ezt némán
// elrontotta: a játékos-azonosító UUID, abból NaN lesz, tehát minden autó a
// nulladik fázisba került, és a nyolcszorosára ritkított munka egyetlen
// képkockára torlódott.
test('remote cars are spread across update phases, not all onto the same frame', () => {
  // Valódi alakú azonosítók, ahogy a szerver adja.
  const azonositok = [
    '795856d5-79f1-4757-b79a-ecffb1dc11cf',
    '4fb63112-1a2b-4c3d-8e9f-000000000001',
    'e8ff4634-aaaa-bbbb-cccc-ddddeeeeffff',
    'c0fedfe7-1111-2222-3333-444455556666',
    '102bc97e-9999-8888-7777-666655554444',
    'b5glje00-0000-0000-0000-000000000000',
    '27zevk11-1111-1111-1111-111111111111',
    '5cdw8t22-2222-2222-2222-222222222222',
  ];
  const fazisok = azonositok.map((id) => remoteDetailPhase(id));

  for (const f of fazisok) {
    assert.ok(Number.isInteger(f) && f >= 0 && f < REMOTE_DETAIL_BUCKETS,
      `a fázis essen 0 és ${REMOTE_DETAIL_BUCKETS} közé, kapott: ${f}`);
  }
  // Ez a sor bukott volna el a régi képlettel: ott mind a nyolc nulla lett.
  assert.ok(new Set(fazisok).size >= 4,
    `egy nyolcfős mezőny osztódjon szét, kapott fázisok: ${fazisok.join(',')}`);
  assert.notDeepEqual(fazisok, new Array(azonositok.length).fill(0));
});

test('a car keeps its update phase across frames', () => {
  const id = '795856d5-79f1-4757-b79a-ecffb1dc11cf';
  assert.equal(remoteDetailPhase(id), remoteDetailPhase(id), 'ugyanaz az azonosító, ugyanaz a fázis');
  // Hiányzó azonosító se dobjon: inkább essen a nulladik fázisba.
  for (const rossz of [undefined, null, '', 0]) {
    const f = remoteDetailPhase(rossz);
    assert.ok(Number.isInteger(f) && f >= 0 && f < REMOTE_DETAIL_BUCKETS, String(f));
  }
});

// A 700 méteren kívülre került autó közben fél pályányit haladhat. Ha a
// `renderReady` igaz marad, visszatéréskor a látható modell a rég elhagyott
// helyéről indulva csúszik az újra — átsuhan a képen. Minden elrejtő útvonal
// ezért ugyanazon a segédfüggvényen megy át, ami nullázza.
test('every path that hides a remote car also clears its render anchor', () => {
  assert.match(mp, /function hideRemoteCar\(o\) \{[^}]*o\.renderReady = false;[^}]*\}/);
  // Pontosan egy helyen tüntetünk el távoli autót: a segédfüggvényben.
  assert.equal((mp.match(/o\.group\.visible = false/g) || []).length, 1,
    'a rejtés maradjon egy helyen, különben újra elfelejtődik a renderReady');
  assert.match(mp, /if \(!currentState\) \{\s*hideRemoteCar\(o\);/);
  assert.match(mp, /if \(!delayedState\) \{\s*hideRemoteCar\(o\);/);
  assert.match(mp, /REMOTE_RENDER_MAX_RANGE_SQ\) \{\s*hideRemoteCar\(o\);/);
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
