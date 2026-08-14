import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getManifest } from '../server/assets.js';
import { ASSETS_DIR } from '../server/paths.js';

test('every active track has a valid tree-collision cutoff', async () => {
  const manifest = await getManifest();
  assert.ok(manifest.maps.length > 0);

  for (const map of manifest.maps) {
    const file = path.join(ASSETS_DIR, 'maps', map.id, 'bake.json');
    const config = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(config.canopy?.enabled, true, `${map.id}: canopy.enabled`);
    assert.equal(Number.isFinite(config.canopy?.minHeight), true, `${map.id}: canopy.minHeight`);
    assert.ok(config.canopy.minHeight >= 1 && config.canopy.minHeight <= 60,
      `${map.id}: canopy.minHeight must be between 1 and 60 metres`);
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
