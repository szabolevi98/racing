import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { getManifest } from '../server/assets.js';
import { SUPPORTED_LANGUAGES } from '../web/lang.js';

const CODES = SUPPORTED_LANGUAGES.map((l) => l.code);

async function loadLanguages() {
  const entries = await Promise.all(CODES.map(async (code) => [
    code,
    JSON.parse(await fs.readFile(new URL(`../web/lang/${code}.json`, import.meta.url), 'utf8')),
  ]));
  return new Map(entries);
}

test('track alerts are exposed as language keys with a translation everywhere', async () => {
  const maps = (await getManifest()).maps;
  const byId = new Map(maps.map((map) => [map.id, map]));
  const languages = await loadLanguages();

  assert.equal(byId.get('redbull_ring_2025_layout')?.alert?.messageKey, 'trackAlert.visualGlitches');
  assert.equal(byId.get('high_speed_ring')?.alert?.messageKey, 'trackAlert.visualGlitches');
  // Ezeken a pályákon a vizuális hibák javítva lettek, ezért az alert.json-juk
  // törölve — a figyelmeztetés HIÁNYA is ellenőrzött állapot, különben egy
  // véletlenül visszakerülő fájl észrevétlenül maradna a menüben.
  //
  // A Suzukán az "átlátszó aszfalt" oka a Merged_materials lombozat-textúrája
  // volt; a két érintett darab az objektumvágóval saját primitívbe került, egy
  // rendes, átlátszatlan anyag alá.
  assert.equal(byId.get('nurburgring_gp_2016_layout')?.alert, undefined);
  assert.equal(byId.get('suzuka-circuit-2001-layout')?.alert, undefined);
  assert.deepEqual(byId.get('bahrain_international_circuit_2006_layout')?.alert, {
    type: 'danger',
    messageKey: 'trackAlert.brokenAsphalt',
  });

  // A szerver kulcsot ad, a szöveget a kliens teszi hozzá. Egy elgépelt vagy
  // lefordítatlan kulcs a menüben nyers kulcsnévként jelenne meg.
  for (const map of maps) {
    if (!map.alert) continue;
    assert.ok(['success', 'warning', 'danger'].includes(map.alert.type));
    assert.equal(map.alert.message, undefined, `${map.id}: a kész szöveg nem mehet a manifestbe`);
    for (const code of CODES) {
      const text = languages.get(code)[map.alert.messageKey];
      assert.equal(typeof text, 'string', `${map.id}: hiányzó ${code} fordítás (${map.alert.messageKey})`);
      assert.ok(text.trim().length > 0, `${map.id}: üres ${code} fordítás`);
    }
  }
});
