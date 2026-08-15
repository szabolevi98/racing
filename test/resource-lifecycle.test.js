import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../web/main.js', import.meta.url), 'utf8');
const assets = fs.readFileSync(new URL('../server/assets.js', import.meta.url), 'utf8');
const multiplayer = fs.readFileSync(new URL('../web/mp.js', import.meta.url), 'utf8');

test('track texture analysis caches do not retain disposed GLTF textures', () => {
  assert.match(main, /const dilatedTextureCache = new WeakMap\(\)/);
  assert.match(main, /const maskTextureCache = new WeakMap\(\)/);
  assert.doesNotMatch(main, /dilatedTextureCache\.(?:has|get|set)\(tex\.uuid/);
  assert.doesNotMatch(main, /maskTextureCache\.(?:has|get|set)\(tex\.uuid/);
});

test('large model and environment URLs carry manifest content versions', () => {
  assert.match(assets, /entry\.v = fileVersion\(stat\)/);
  assert.match(assets, /entry\.remoteV = fileVersion\(remoteStat\)/);
  assert.match(main, /function assetUrl\(entry, remote = false\)/);
  assert.match(main, /setTrack\(assetUrl\(entry\)/);
  assert.match(main, /setSkybox\(assetUrl\(entry\)/);
  assert.match(multiplayer, /G\.assetUrl\(map\)/);
  assert.match(multiplayer, /G\.assetUrl\(car, true\)/);
});

test('Hot Lap client history is bounded while the displayed lap count stays authoritative', () => {
  assert.match(multiplayer, /myLapTimes\.length > 64/);
  assert.match(multiplayer, /t\('mp\.lapsDone'\)[\s\S]*\$\{myLap\}/);
});
