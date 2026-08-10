import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('leaderboard stays informational while Hot Lap uses a separate ghost picker', async () => {
  const html = await fs.readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const multiplayer = await fs.readFile(new URL('../web/mp.js', import.meta.url), 'utf8');

  assert.match(html, /Leggyorsabb körök/);
  assert.match(html, /Csak a többjátékos mód körei számítanak/);
  assert.match(multiplayer, /hotLapGhostPicker/);
  assert.match(multiplayer, /async function warmGhostCarVisual/);
  assert.match(multiplayer, /renderer\.initTexture\(texture\)/);
  assert.match(multiplayer, /await G\.renderer\.compileAsync\(group, G\.camera, G\.scene\)/);
  assert.match(multiplayer, /await warmGhostCarVisual\(group\)/);
  assert.match(multiplayer, /if \(ghostCar\?\.group\.visible\)/);
  assert.match(multiplayer, /rgba\(117, 215, 255, 0\.62\)/);
  assert.match(multiplayer, /Szellem nélkül/);
});
