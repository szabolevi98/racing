// A fordítás nem "elkészül és kész": minden új felirattal el lehet felejteni
// az egyik nyelvet. Ezek a tesztek pont ezt a felejtést fogják meg — a hiányzó
// kulcs a képernyőn nyers kulcsnévként jelenne meg (lásd lang.js t()).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { SUPPORTED_LANGUAGES } from '../web/lang.js';

const read = (relative) => fs.readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

async function loadLanguages() {
  const entries = await Promise.all(SUPPORTED_LANGUAGES.map(async ({ code }) => (
    [code, JSON.parse(await read(`web/lang/${code}.json`))]
  )));
  return new Map(entries);
}

// A kódban `t('kulcs')`, a markupban `data-i18n="kulcs"` /
// `data-i18n-<attribútum>="kulcs"` alakban hivatkozunk a szövegekre.
// A kulcs nem mindig a t() ELSŐ karaktere után áll — lehet ternárius is
// (`t(n === 1 ? 'a' : 'b')`), ezért a hívás egész argumentumlistájából
// összeszedjük a pontozott, idézőjeles szövegeket.
function usedKeys(source) {
  const keys = new Set();
  for (const call of source.matchAll(/\bt\(([^)]*)\)/g)) {
    for (const m of call[1].matchAll(/'([\w]+(?:\.[\w]+)+)'/g)) keys.add(m[1]);
  }
  for (const m of source.matchAll(/data-i18n(?:-[\w-]+)?="([\w.]+)"/g)) keys.add(m[1]);
  return keys;
}

const SOURCES = ['web/index.html', 'web/main.js', 'web/mp.js'];

// A pálya-figyelmeztetések kulcsa nem a forrásban, hanem az alert.json-okban
// szerepel — ezeket külön kell összeszedni, különben "használaton kívülinek"
// látszanának.
async function alertKeys() {
  const mapsDir = new URL('../web/assets/maps/', import.meta.url);
  const dirs = await fs.readdir(mapsDir, { withFileTypes: true });
  const keys = new Set();
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    try {
      const alert = JSON.parse(await fs.readFile(new URL(`${dir.name}/alert.json`, mapsDir), 'utf8'));
      if (alert?.messageKey) keys.add(alert.messageKey);
    } catch { /* nincs alert.json ezen a pályán */ }
  }
  return keys;
}

test('every language file has the same keys', async () => {
  const languages = await loadLanguages();
  const [first, ...rest] = [...languages.keys()];
  const reference = Object.keys(languages.get(first)).sort();

  for (const code of rest) {
    const keys = Object.keys(languages.get(code)).sort();
    const missing = reference.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !reference.includes(k));
    assert.deepEqual(missing, [], `${code}.json: hiányzó kulcsok`);
    assert.deepEqual(extra, [], `${code}.json: fölösleges kulcsok (nincs ${first}.json-ban)`);
  }
});

test('no language file has an empty translation', async () => {
  const languages = await loadLanguages();
  for (const [code, strings] of languages) {
    for (const [key, value] of Object.entries(strings)) {
      assert.equal(typeof value, 'string', `${code}.json: ${key} nem szöveg`);
      assert.ok(value.trim().length > 0, `${code}.json: ${key} üres`);
    }
  }
});

test('every key used in the client exists in every language', async () => {
  const languages = await loadLanguages();
  const sources = await Promise.all(SOURCES.map(read));
  const used = new Set(sources.flatMap((source) => [...usedKeys(source)]));
  for (const key of await alertKeys()) used.add(key);

  for (const [code, strings] of languages) {
    const missing = [...used].filter((key) => !(key in strings)).sort();
    assert.deepEqual(missing, [], `${code}.json: hiányzó kulcsok`);
  }
});

test('the server sends error codes that all have a translation', async () => {
  const languages = await loadLanguages();
  const { ERR } = await import('../shared/errorCodes.js');
  const server = await read('server/net/wsServer.js');

  // A szerver soha ne küldjön kész szöveget: az nem tudná, milyen nyelven
  // játszik a címzett, és egy szobában több nyelv is ülhet.
  assert.doesNotMatch(server, /fail\(socket, '/, 'a fail() kódot vár, nem szöveget');

  for (const code of Object.values(ERR)) {
    for (const [language, strings] of languages) {
      assert.ok(`server.${code}` in strings, `${language}.json: hiányzik a server.${code}`);
    }
  }
});

test('no translation key is left unused', async () => {
  const languages = await loadLanguages();
  const sources = await Promise.all(SOURCES.map(read));
  const used = new Set(sources.flatMap((source) => [...usedKeys(source)]));
  const { ERR } = await import('../shared/errorCodes.js');
  // A szerverhibák kulcsát a kliens `server.${m.code}` alakban állítja össze,
  // tehát szövegesen nem szerepel a forrásban.
  for (const code of Object.values(ERR)) used.add(`server.${code}`);
  for (const key of await alertKeys()) used.add(key);

  const [first] = languages.keys();
  const unused = Object.keys(languages.get(first)).filter((key) => !used.has(key)).sort();
  assert.deepEqual(unused, [], 'használaton kívüli fordítási kulcsok');
});
