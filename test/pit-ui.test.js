import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../web/main.js', import.meta.url), 'utf8');
const mp = fs.readFileSync(new URL('../web/mp.js', import.meta.url), 'utf8');
const devHtml = fs.readFileSync(new URL('../web/dev.html', import.meta.url), 'utf8');
const dev = fs.readFileSync(new URL('../web/dev.js', import.meta.url), 'utf8');

test('menu and HUD expose the optional mandatory tire-change rule', () => {
  assert.match(html, /id="mandatoryPitStopCheckbox"/);
  assert.match(html, /id="pitStopAlert"/);
  assert.match(main, /hasCompletePitConfig\(currentPitConfig\)/);
  assert.match(main, /race\.totalLaps > 1/);
  assert.match(main, /mandatoryPitStopCheckbox\.disabled = !available/);
  assert.match(mp, /mandatoryPitStop: laps > 1 && mandatoryPitStopCheckbox\.checked/);
  assert.match(
    main,
    /race\.lap \+ 1 >= race\.totalLaps[\s\S]{0,220}const invalid = race\.lapTainted/,
    'single-player applies the penalty while closing the final lap'
  );
});

test('dev editor exposes and persists pit entry, exit and eight numbered stalls', () => {
  assert.match(devHtml, /value="pit-entry"/);
  assert.match(devHtml, /value="pit-exit"/);
  assert.match(devHtml, /value="pit-stop"/);
  assert.match(dev, /fetch\('\/api\/dev\/pit'/);
  assert.match(dev, /api\.currentPitConfig\.stops\.length >= 8/);
  assert.match(dev, /'P' \+ \(idx \+ 1\)/);
});

test('multiplayer passes pit limiter state into the local physics step', () => {
  assert.match(mp, /localPitState\.required && localPitState\.inLane/);
  assert.match(main, /pitLimitedVelocity\(velocity\.x, velocity\.z, dt\)/);
  assert.match(main, /findPitGroundAt\(currentTrack, currentTrackBox, stop\.x, stop\.z\)/);
  assert.match(main, /state\.completed && !state\.inLane/);
});

test('reset waits for the first start crossing and pauses state packets in flight', () => {
  assert.match(main, /race\.active && !race\.hasCrossedStart/);
  assert.match(mp, /!multiplayerStartCrossed \|\| resetPending/);
  assert.match(mp, /const shouldSend = !raceEnded && !resetPending/);
});

test('driving alerts share one dynamic stacking container', () => {
  const stackStart = html.indexOf('id="alertStack"');
  const stackEnd = html.indexOf('id="fullscreenHint"');
  assert.ok(stackStart >= 0 && stackEnd > stackStart);
  for (const id of [
    'lapInvalidAlert', 'pitStopAlert', 'rolloverAlert',
    'highPingAlert', 'spectateBar', 'finishTimer',
  ]) {
    const position = html.indexOf(`id="${id}"`);
    assert.ok(position > stackStart && position < stackEnd, `${id} must be inside alertStack`);
  }
  assert.ok(html.indexOf('id="splitDeltaAlert"') < stackStart, 'delta must stay above alertStack');
  const css = fs.readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
  assert.match(css, /#alertStack\s*\{[\s\S]*?display:\s*flex;\s*flex-direction:\s*column/);
  assert.match(css, /#alertStack\s*\{[\s\S]*?top:\s*66px/);
  assert.match(css, /#splitDeltaAlert\s*\{[\s\S]*?position:\s*fixed;\s*top:\s*16px/);
  assert.doesNotMatch(css, /#highPingAlert\s*\{\s*top:/);
  assert.doesNotMatch(css, /#lapInvalidAlert\s*\{\s*top:/);
});
