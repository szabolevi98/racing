import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('the dev editor exposes and persists a dedicated Hot Lap start point', async () => {
  const [html, dev, assets, api, multiplayer, socket] = await Promise.all([
    fs.readFile(new URL('../web/dev.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../web/dev.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../server/assets.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../server/devApi.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../web/mp.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../server/net/wsServer.js', import.meta.url), 'utf8'),
  ]);

  assert.match(html, /value="hotlap-spawn"/);
  assert.match(html, /id="clearHotLapSpawnBtn"/);
  assert.match(dev, /api\.currentHotLapSpawn = point/);
  assert.match(dev, /hotLapSpawn: api\.currentHotLapSpawn/);
  assert.match(assets, /hotlap_spawn\.json/);
  assert.match(api, /fs\.writeFile\(hotLapFile/);
  assert.match(multiplayer, /info\.hotLapSpawn \|\| null/);
  assert.match(socket, /hotLapSpawn: room\.mode === GAME_MODE\.HOT_LAP/);
});

test('returning to the menu restores the first normal grid slot', async () => {
  const main = await fs.readFile(new URL('../web/main.js', import.meta.url), 'utf8');

  assert.match(main, /function restoreMenuStartPose\(\)/);
  assert.match(main, /gridSlotPose\(currentSpawnPoints, 0\)/);
  assert.match(main, /restoreMenuStartPose\(\);\s*resetCarTo\(spawnPoint\);/);
});
