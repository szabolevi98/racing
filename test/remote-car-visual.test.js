import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  LOCAL_RENDER_DELAY_MAX_MS, LOCAL_RENDER_DELAY_MIN_MS,
  localRenderDelayTarget, remoteDetailPhase, remoteDetailUpdateInterval,
  REMOTE_DETAIL_BUCKETS,
  remoteVisualCorrectionHalfLife, remoteVisualPredictionBlend,
  updateRemoteQualityBudget,
} from '../shared/remoteVisual.js';
import {
  advanceRenderClock, LOCAL_CLOCK_RATE_MIN, LOCAL_CLOCK_RATE_MAX,
} from '../shared/renderClock.js';

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
  assert.match(mp, /visualSteerAngle: 0/);
  assert.match(mp, /moveRemoteSteerTowards\(o\.visualSteerAngle \?\? 0, targetSteer, dt\)/);
  assert.match(mp, /if \(detailDue\) pivot\.rotation\.x = s\.wr \?\? 0/);
  assert.match(mp, /if \(source\?\.steer\) pivot\.rotation\.y = o\.visualSteerAngle/);
});

test('remote wheel steering is visually smoothed every frame without unthrottling wheel roll', () => {
  assert.match(mp, /shouldBrakeFinishedVelocity, STEER_VISUAL_SPEED/);
  assert.match(mp, /const maxDelta = STEER_VISUAL_SPEED \* dt/);
  assert.match(mp, /const firstRenderedFrame = !o\.renderReady/);
  assert.match(mp, /o\.visualSteerAngle = firstRenderedFrame\s*\? targetSteer\s*:/);
  assert.doesNotMatch(mp, /if \(detailDue\) \{\s*for \(let i = 0; i < o\.wheelRig\.pivots\.length/);
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

test('heavy remote models fall back only after sustained slow frames and recover with hysteresis', () => {
  let state = { degraded: false, slowMs: 0, cleanMs: 0 };
  state = updateRemoteQualityBudget(state, 100);
  assert.equal(state.degraded, false, 'one large frame cannot change car quality');
  for (let i = 0; i < 30; i++) state = updateRemoteQualityBudget(state, 50);
  assert.equal(state.degraded, true, 'sustained 20 FPS enables the lightweight visual');
  for (let i = 0; i < 300; i++) state = updateRemoteQualityBudget(state, 16);
  assert.equal(state.degraded, true, 'short recovery cannot make quality flap');
  for (let i = 0; i < 220; i++) state = updateRemoteQualityBudget(state, 16);
  assert.equal(state.degraded, false, 'long stable rendering restores the detailed skins');
  assert.match(mp, /createRemoteLowDetailVisual/);
  assert.match(mp, /remoteQualityBudget\.degraded && !watched/,
    'the spectated car must stay detailed even during fallback');
});

test('finished remote cars never keep a physical collision proxy', () => {
  assert.match(mp, /for \(const \[id, o\] of others\) \{\s*if \(o\.finished\) \{/);
  assert.match(mp, /entry\.finished = !!c\.fin;[\s\S]*?G\.setRemoteCarProxy\(c\.id, null\)/);
});

test('stale collision disappears before the still-useful remote visual', () => {
  assert.match(mp, /!proxyCollisionStateIsFresh\(stateAgeMs\)/);
  assert.match(mp, /nowServer - latest\.t > REMOTE_VISUAL_MAX_AGE_MS/);
  assert.doesNotMatch(mp, /REMOTE_PROXY_MAX_AGE_MS/);
});

test('local render clock follows timer stress without visible timeline jumps', () => {
  assert.equal(localRenderDelayTarget(0, 0), LOCAL_RENDER_DELAY_MIN_MS);
  assert.ok(localRenderDelayTarget(15, 8) > LOCAL_RENDER_DELAY_MIN_MS);
  assert.equal(localRenderDelayTarget(500, 500), LOCAL_RENDER_DELAY_MAX_MS);

  const local = (renderAtMs, previousNowMs, nowMs, targetDelayMs, playbackRate) =>
    advanceRenderClock({
      renderAtMs, previousNowMs, nowMs, targetDelayMs, playbackRate,
      rateMin: LOCAL_CLOCK_RATE_MIN, rateMax: LOCAL_CLOCK_RATE_MAX,
      minDelayMs: LOCAL_RENDER_DELAY_MIN_MS, maxDelayMs: LOCAL_RENDER_DELAY_MAX_MS,
    });

  let now = 1000;
  let clock = local(NaN, NaN, now, LOCAL_RENDER_DELAY_MIN_MS);
  let previousAt = clock.at;
  for (let frame = 0; frame < 600; frame++) {
    const previousNow = now;
    now += 1000 / 60;
    // Szándékosan pumpáljuk a célpuffert: a renderidő ettől sem állhat meg,
    // nem ugorhat vissza, és nem változtathat észrevehetően sebességet.
    const target = frame % 120 < 60 ? LOCAL_RENDER_DELAY_MAX_MS : LOCAL_RENDER_DELAY_MIN_MS;
    clock = local(clock.at, previousNow, now, target, clock.rate);
    const advancement = clock.at - previousAt;
    assert.ok(advancement > 0, `a renderóra legyen monoton: ${advancement}`);
    assert.ok(advancement >= (1000 / 60) * LOCAL_CLOCK_RATE_MIN - 1e-9);
    assert.ok(advancement <= (1000 / 60) * LOCAL_CLOCK_RATE_MAX + 1e-9);
    assert.ok(clock.rate >= LOCAL_CLOCK_RATE_MIN && clock.rate <= LOCAL_CLOCK_RATE_MAX);
    assert.equal(clock.resynced, false);
    previousAt = clock.at;
  }

  const resumed = local(clock.at, now, now + 1000, LOCAL_RENDER_DELAY_MAX_MS, clock.rate);
  assert.equal(resumed.at, now + 1000 - LOCAL_RENDER_DELAY_MAX_MS);
  assert.equal(resumed.rate, 1);
  assert.equal(resumed.resynced, true);
  assert.match(mp, /observePhysicsTimer\(now - next\)/);
  assert.match(mp, /rateMin: LOCAL_CLOCK_RATE_MIN/);
  assert.match(mp, /get predDelayMs\(\)/);
});

test('Hot Lap ghost uses smooth single-pass transparency with depth writing', () => {
  assert.match(mp, /clone\.transparent = true/);
  assert.match(mp, /clone\.alphaHash = false/);
  assert.match(mp, /clone\.depthWrite = true/);
  assert.match(mp, /clone\.forceSinglePass = true/);
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
  assert.match(mp, /const nearState = o\.proxyPose \? \{/);
  assert.match(mp, /blendRemoteStates\(delayedState, nearState, predictionBlend\)/);
  assert.equal((mp.match(/blendRemoteStates\(delayedState,/g) || []).length, 1,
    'a késleltetett állapot csak egyszer keveredhet a közeli cél felé');
  assert.doesNotMatch(mp, /s\.p\.map\([\s\S]*?o\.proxyPose/,
    'a már kevert állapotot nem szabad még egyszer a proxy felé húzni');
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
