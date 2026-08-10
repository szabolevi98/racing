import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getManifest } from '../server/assets.js';
import { ASSETS_DIR } from '../server/paths.js';

test('every active track ignores tree collision above 10 metres', async () => {
  const manifest = await getManifest();
  assert.ok(manifest.maps.length > 0);

  for (const map of manifest.maps) {
    const file = path.join(ASSETS_DIR, 'maps', map.id, 'bake.json');
    const config = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(config.canopy?.enabled, true, `${map.id}: canopy.enabled`);
    assert.equal(config.canopy?.minHeight, 10, `${map.id}: canopy.minHeight`);
  }
});

test('new tracks default to enabled tree filtering in the dev editor and API', async () => {
  const [html, dev, api] = await Promise.all([
    fs.readFile(new URL('../web/dev.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../web/dev.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../server/devApi.js', import.meta.url), 'utf8'),
  ]);

  assert.match(html, /id="bakeCanopyCheck"[^>]*checked/);
  assert.match(dev, /cfg \? cfg\.canopy\?\.enabled !== false : true/);
  assert.match(api, /enabled: b\.canopy\?\.enabled !== false/);
});
