import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildConfig } from '../tools/build-car-wheels.mjs';

const best = { pat: 'rim|tire', sc: { s: 1.9, track: 1.81, wheelbase: 2.88, parts: 28 } };

// A repóban lévő configok kézzel szerzett tudást hordoznak: konkrét, élőben
// jelentett hibák javításait ("a futófelület egy helyben marad"), és
// figyelmeztetéseket (kormánykerék-anyag, amit a mintának KI kell kerülnie).
// Ha egy újragenerálás ezeket csendben eldobná, a hibák visszatérnének — ezért
// felülíráskor is meg kell maradnia a korábbi megjegyzésnek.
test('overwriting keeps the previous note as reference', () => {
  const previous = { wheelPattern: 'regi', _wheelPattern: "JAVÍTVA: kimaradt a 'TREAD92R' anyag." };
  const config = buildConfig('teszt', best, previous);
  assert.match(config._wheelPattern, /TREAD92R/);
  assert.match(config._wheelPattern, /Korábbi megjegyzés/);
  assert.equal(config.wheelPattern, 'rim|tire');
});

test('a fresh config carries the measurement and no stale reference', () => {
  const config = buildConfig('teszt', best, null);
  assert.match(config._wheelPattern, /nyomtáv 1\.81, tengelytáv 2\.88, 28 darab/);
  assert.doesNotMatch(config._wheelPattern, /Korábbi megjegyzés/);
  assert.equal(config.yawDegrees, 0);
});

// A gyenge pontszám jellemzően szemantika nélküli anyagneveket (mat_13.001)
// jelent, ahol csak a geometria dönt. Ilyenkor a JSON-ban is látszania kell,
// hogy ez tipp, nem mérés — különben évekkel később senki nem tudja, melyik
// configban lehet megbízni.
test('a weak proposal says so in the file itself', () => {
  const weak = { pat: 'mat_13', sc: { s: 0.31, track: 1.4, wheelbase: 2.1, parts: 4 }, alien: ['kipufogó'] };
  const config = buildConfig('teszt', weak, null);
  assert.match(config._wheelPattern, /ALACSONY biztonság/);
  assert.match(config._wheelPattern, /kipufogó/);
});

// A modellek túlnyomó része előre néz, a kivételt úgyis csak élőben lehet
// észrevenni — de amit egyszer kézzel beállítottak, azt nem szabad nullázni.
test('a hand-set yaw survives regeneration', () => {
  assert.equal(buildConfig('teszt', best, { yawDegrees: 180 }).yawDegrees, 180);
  assert.equal(buildConfig('teszt', best, {}).yawDegrees, 0);
});

test('Mercedes AMG GT3 Evo wheel rig excludes its wheelhouse and calipers', () => {
  const config = JSON.parse(fs.readFileSync(
    new URL('../web/assets/cars/2020_mercedes-amg_gt3_evo.json', import.meta.url),
    'utf8'
  ));
  assert.equal(config.wheelPattern, 'tyre|rim|disc');
  assert.doesNotMatch(config.wheelPattern, /wheel|caliper/i);
});

// Az F2004 az alapértelmezett kocsi, ezért a hibái mindenkinek feltűnnek. A
// node-jai f2004_wheel_fl_1 / _fr_2 / _rl_3 / _rr_4 néven futnak, és a puszta
// 'wheel' minta a sarok mind a hat gyerekét megfogta — köztük a fékhűtő
// terelőt és a féknyerget is, amik az álló felfüggesztésre vannak szerelve.
// A felhasználó ezt élőben jelezte: az első kerék belsején lévő karbon terelő
// együtt forgott a kerékkel.
test('the F2004 rotates only the four parts that really spin', () => {
  const config = JSON.parse(fs.readFileSync(
    new URL('../web/assets/cars/2004_ferrari_f2004.json', import.meta.url),
    'utf8'
  ));
  assert.equal(config.wheelPattern, 'disc|side|tread|rim');
  const pattern = new RegExp(config.wheelPattern, 'i');
  // Ami forog: fékkorong, oldalfal, futófelület, felni.
  for (const material of ['Disclf0021Mtl', 'Sidelrside01Mtl', 'Treadlrtread01Mtl', 'Rimlfsub01Mtl']) {
    assert.ok(pattern.test(material), `${material} a kerékkel forog, meg kell fogni`);
  }
  // Ami nem: a fékhűtő terelő (elöl/hátul) és a féknyereg.
  for (const material of ['Airlf1Mtl', 'Airrf1Mtl', 'Cylinder0171Mtl', 'Cylinder0301Mtl', '2krrcala1Mtl']) {
    assert.ok(!pattern.test(material), `${material} az álló felfüggesztésen ül, nem foroghat`);
  }
  // A node-név a hatos csoport miatt tilos.
  assert.ok(!pattern.test('f2004_wheel_fl_1'), 'a node-névre illeszkedve újra mind a hat darab bekerülne');
});
