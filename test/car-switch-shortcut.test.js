import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../web/main.js', import.meta.url), 'utf8');
const dev = fs.readFileSync(new URL('../web/dev.js', import.meta.url), 'utf8');

test('W/S and up/down switch cars only in the dev wheel tester', () => {
  assert.match(main, /if \(appState !== 'cartest' \|\| e\.repeat\) return;/);
  assert.doesNotMatch(main, /appState !== 'cartest' && appState !== 'menu'/);
  assert.match(main, /e\.code === 'ArrowUp' \|\| e\.code === 'KeyW'/);
  assert.match(main, /e\.code === 'ArrowDown' \|\| e\.code === 'KeyS'/);
});

// A tömörített modell az ellenfeleké és a ghosté; vezetni mindig az eredetit
// kell. Két, egymástól független biztosíték tartja bent a tesztelőben: a
// betöltés csak 'cartest' állapotban nézi a pipát, a kilépés pedig visszatölti
// az eredetit. Ha bármelyik elvész, a menüből indított futam csendben a
// gyengébb modellel menne.
test('the compressed model never leaks out of the wheel tester', () => {
  assert.match(main, /carTesterCompressed && appState === 'cartest' && entry\.remoteFile/);
  assert.match(main, /setCarTesterCompressed\(on\) \{ carTesterCompressed = !!on; \}/);
  assert.match(dev, /api\.setCarTesterCompressed\(false\);/);
  assert.match(dev, /if \(wasCompressed && entry\) api\.switchCarTo\(entry\);/);
});

// A pipa a dev keréktesztelő panelján ül, és a main.js-nek szólnia kell róla —
// a getter-alapú devApi felület miatt könnyű a window.__game-be tenni, ahonnan
// a dev.js sosem látná.
test('the tester checkbox reaches main.js through the dev api', () => {
  assert.match(dev, /carTesterCompressedEl\.addEventListener\('change'/);
  // A dev.js az initDevTools(devApi)-t kapja, NEM a window.__game-et. A kettő
  // külön objektum, és a setter a rosszabbikban is működőképesnek látszik —
  // csak épp a dev.js sosem éri el.
  const devApiStart = main.indexOf('const devApi = {');
  const globalStart = main.indexOf('window.__game = {');
  const setter = main.indexOf('setCarTesterCompressed(on)');
  assert.ok(devApiStart >= 0 && globalStart > devApiStart);
  assert.ok(setter > devApiStart && setter < globalStart, 'a setternek a devApi-ban a helye, nem a window.__game-ben');
});
