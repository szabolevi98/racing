import test from 'node:test';
import assert from 'node:assert/strict';
import { getManifest } from '../server/assets.js';

test('track alerts are exposed only with supported types and non-empty messages', async () => {
  const maps = (await getManifest()).maps;
  const byId = new Map(maps.map((map) => [map.id, map]));

  assert.deepEqual(byId.get('suzuka-circuit-2001-layout')?.alert, {
    type: 'warning',
    message: 'Ezen a pályán vizuális hibák találhatóak.',
  });
  assert.deepEqual(byId.get('redbull_ring_2025_layout')?.alert, {
    type: 'warning',
    message: 'Ezen a pályán vizuális hibák találhatóak.',
  });
  assert.deepEqual(byId.get('nurburgring_gp_2016_layout')?.alert, {
    type: 'warning',
    message: 'Ezen a pályán vizuális hibák találhatóak.',
  });
  assert.deepEqual(byId.get('bahrain_international_circuit_2006_layout')?.alert, {
    type: 'danger',
    message: 'A pálya aszfaltja hibás. Csak akkor válaszd, ha ennek ellenére szeretnéd kipróbálni.',
  });

  for (const map of maps) {
    if (!map.alert) continue;
    assert.ok(['success', 'warning', 'danger'].includes(map.alert.type));
    assert.ok(map.alert.message.trim().length > 0);
  }
});
