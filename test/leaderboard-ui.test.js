import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('leaderboard stays informational while Hot Lap uses a separate ghost picker', async () => {
  const html = await fs.readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const multiplayer = await fs.readFile(new URL('../web/mp.js', import.meta.url), 'utf8');

  assert.match(html, /Leggyorsabb körök/);
  assert.match(html, /Csak a többjátékos és az időmérős körök számítanak/);
  assert.match(multiplayer, /hotLapGhostPicker/);
  assert.match(multiplayer, /async function warmCarVisuals/);
  assert.match(multiplayer, /renderer\.initTexture\(texture\)/);
  assert.match(multiplayer, /await renderer\.compileAsync\(warmScene, warmCamera\)/);
  assert.match(multiplayer, /new THREE\.WebGLRenderTarget\(256, 256/);
  assert.match(multiplayer, /object\.frustumCulled = false/);
  assert.match(multiplayer, /for \(const z of \[8, -8\]\)/);
  assert.match(multiplayer, /renderer\.render\(warmScene, warmCamera\)/);
  assert.match(multiplayer, /if \(!gl\.isContextLost\(\)\) gl\.finish\(\)/);
  assert.match(
    multiplayer,
    /await G\.runLoadTasks\(tasks\);[\s\S]*await warmCarVisuals\(visualsToWarm\)/,
  );
  assert.doesNotMatch(multiplayer, /for \(const lowDetail of \[false, true\]\)/);
  assert.doesNotMatch(multiplayer, /setRemoteVisualQuality/);
  assert.doesNotMatch(multiplayer, /G\.scene\.add\(group\);\s*await warmCarVisuals\(group\)/);
  assert.match(multiplayer, /clearOtherCars\(\{ preserveGhost: reuseGhost \}\)/);
  assert.match(multiplayer, /if \(ghostReplay && !reuseGhost\)/);
  assert.match(multiplayer, /if \(ghostCar\?\.group\.visible\)/);
  assert.match(multiplayer, /rgba\(117, 215, 255, 0\.62\)/);
  assert.match(multiplayer, /t\('mp\.noGhost'\)/);
  const hu = JSON.parse(await fs.readFile(new URL('../web/lang/hu.json', import.meta.url), 'utf8'));
  assert.equal(hu['mp.noGhost'], 'Szellem nélkül');
});
