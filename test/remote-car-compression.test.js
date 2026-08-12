import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { REMOTE_CAR_PROFILES } from '../tools/build-remote-cars.mjs';

const assets = fs.readFileSync(new URL('../server/assets.js', import.meta.url), 'utf8');
const multiplayer = fs.readFileSync(new URL('../web/mp.js', import.meta.url), 'utf8');

test('remote car compression profiles become progressively smaller', () => {
  assert.equal(REMOTE_CAR_PROFILES[0].name, 'lossless');
  assert.equal(REMOTE_CAR_PROFILES.at(-1).name, 'last-resort');
  for (let i = 1; i < REMOTE_CAR_PROFILES.length; i++) {
    assert.ok(REMOTE_CAR_PROFILES[i].ratio <= REMOTE_CAR_PROFILES[i - 1].ratio);
    assert.ok(REMOTE_CAR_PROFILES[i].textureLimit <= REMOTE_CAR_PROFILES[i - 1].textureLimit);
    assert.ok(REMOTE_CAR_PROFILES[i].quality <= REMOTE_CAR_PROFILES[i - 1].quality);
  }
});

test('manifest and multiplayer use compressed visuals with original fallback', () => {
  assert.match(assets, /entry\.remoteFile = `cars\/compressed\/\$\{file\}`/);
  assert.match(assets, /entry\.remoteBytes = remoteStat\.size/);
  assert.match(multiplayer, /car\.remoteFile \|\| car\.file/);
  assert.match(multiplayer, /remoteBytes \?\? otherCar\?\.bytes/);
  assert.match(multiplayer, /remoteBytes \?\? replayCar\?\.bytes/);
  assert.match(multiplayer, /createRemoteWheelRig\(model, car\.config\?\.wheelPattern, group\)/);
});
