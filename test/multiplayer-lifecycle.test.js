import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const mp = fs.readFileSync(new URL('../web/mp.js', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../web/main.js', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../server/net/wsServer.js', import.meta.url), 'utf8');

test('session resume reconciles an in-flight reset on both sides', () => {
  assert.match(server, /pendingReset: room\?\.sim\?\.pendingResetPose\?\.\(previous\.id\) \|\| null/);
  assert.match(mp, /case S2C\.SESSION_RESUMED:[\s\S]*?resetPending = false;[\s\S]*?m\.pendingReset/);
  assert.match(mp, /G\.resetMultiplayerCar\(m\.pendingReset\)/);
});

test('cancelled race loads abort every large asset path and cannot add a departed car', () => {
  assert.match(mp, /const loadController = new AbortController\(\);\s*raceLoadController = loadController/);
  assert.match(mp, /raceLoadController\?\.abort\(\)/);
  assert.match(mp, /G\.setTrack\([\s\S]*?map\.pit, signal/);
  assert.match(mp, /G\.setCar\([^\n]*onP, signal\)/);
  assert.match(mp, /G\.prepareTrackPhysics\(\{ strict: true, signal \}\)/);
  assert.match(mp, /departedPlayerIds\.has\(p\.id\)/);
  assert.match(main, /fetch\(url, \{ signal \}\)/);
  assert.match(main, /async function setTrack\([\s\S]*?const gltf = await loadGLTF\(trackUrl, onProgress, signal\)/);
  assert.match(main, /async function setCar\([^)]*signal\)[\s\S]*?const gltf = await loadGLTF\(carUrl, onProgress, signal\)/);
});

test('load timeout removes unready cars instead of carrying them into results', () => {
  assert.match(server, /const missing = \[\.\.\.room\.players\.values\(\)\]\.filter\(\(player\) => !player\.ready\)/);
  assert.match(server, /room\.sim\?\.removeCar\(player\.id\)/);
  assert.match(server, /room\.remove\(player\.id\)/);
  assert.match(
    server,
    /room\.remove\(player\.id\);[\s\S]*?S2C\.RACE_EVENT[\s\S]*?kind: 'left'/,
    'a bent maradó kliensek nem kapnak jelzést az árva autó leszedéséhez',
  );
  assert.match(server, /S2C\.ROOM_CLOSED, \{ code: ERR\.RACE_LOAD_TIMEOUT \}/);
});

test('a server-side race start failure cancels the client loader and returns to the lobby', () => {
  assert.match(mp, /m\.code === ERR\.RACE_START_FAILED/);
  assert.match(mp, /ERR\.RACE_START_FAILED[\s\S]*?cancelRaceLoad\(\)[\s\S]*?starting = null[\s\S]*?openLobby\(\)/);
});
