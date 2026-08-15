import test from 'node:test';
import assert from 'node:assert/strict';
import { getManifest } from '../server/assets.js';
import { SUPPORTED_LANGUAGES } from '../web/lang.js';

const CODES = SUPPORTED_LANGUAGES.map((l) => l.code);

test('track alerts are exposed only with supported types and non-empty messages', async () => {
  const maps = (await getManifest()).maps;
  const byId = new Map(maps.map((map) => [map.id, map]));

  assert.deepEqual(byId.get('suzuka-circuit-2001-layout')?.alert, {
    type: 'warning',
    message: {
      hu: 'Ezen a pályán vizuális hibák találhatóak.',
      en: 'This track has visual glitches.',
    },
  });
  assert.equal(byId.get('redbull_ring_2025_layout')?.alert?.type, 'warning');
  assert.equal(byId.get('nurburgring_gp_2016_layout')?.alert?.type, 'warning');
  assert.deepEqual(byId.get('bahrain_international_circuit_2006_layout')?.alert, {
    type: 'danger',
    message: {
      hu: 'A pálya aszfaltja hibás. Csak akkor válaszd, ha ennek ellenére szeretnéd kipróbálni.',
      en: 'The track surface is broken. Only pick it if you want to try it anyway.',
    },
  });

  // Minden támogatott nyelvhez kell szöveg: egy hiányzó fordítás a menüben
  // ÜRES figyelmeztetésként jelenne meg, ami rosszabb, mint a semmi.
  for (const map of maps) {
    if (!map.alert) continue;
    assert.ok(['success', 'warning', 'danger'].includes(map.alert.type));
    for (const code of CODES) {
      assert.equal(typeof map.alert.message[code], 'string', `${map.id}: hiányzó ${code} fordítás`);
      assert.ok(map.alert.message[code].trim().length > 0, `${map.id}: üres ${code} fordítás`);
    }
  }
});
