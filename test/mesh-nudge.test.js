// Darab előrébb hozása: a tábla-feliratok villogása ellen.
//
// A nyomat külön lap a tábla lapja előtt, hajszálnyi réssel (a Hungaroringen
// mérve 0,101–0,348 mm). A mélységi puffer ezt nem tudja feloldani, ezért a
// felirat darabját fizikailag előrébb toljuk — annyival, amennyit a puffer már
// biztosan megkülönböztet.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nudgeVertices, restoreVertices, parseGlb, patchGlbPositions,
} from '../shared/meshCut.js';

test('a kijelölt csúcsok elmozdulnak, a többi nem, és visszavonható', () => {
  const pos = new Float32Array([
    0, 0, 0,   1, 0, 0,   1, 1, 0,   // ezt mozgatjuk
    5, 5, 5,                          // ehhez nem nyúlunk
  ]);
  const eredetiMasolat = Float32Array.from(pos);
  const mentes = nudgeVertices(pos, new Set([0, 1, 2]), [0, 0, 0.05]);

  // Float32-ben a 0.05 nem ábrázolható pontosan, ezért tűréssel hasonlítunk.
  const kozel = (a, b) => Math.abs(a - b) < 1e-6;
  const vart = [0, 0, 0.05, 1, 0, 0.05, 1, 1, 0.05];
  vart.forEach((v, i) => assert.ok(kozel(pos[i], v), `${i}. elem: ${pos[i]} != ${v}`));
  assert.deepEqual([...pos.slice(9)], [5, 5, 5], 'a kijelölésen kívüli csúcs érintetlen');

  restoreVertices(pos, mentes);
  assert.deepEqual([...pos], [...eredetiMasolat], 'visszavonás után az eredeti');
});

test('az elmozdítás halmozható — ha egyszer kevés volt, mehet még', () => {
  const pos = new Float32Array([0, 0, 0]);
  nudgeVertices(pos, new Set([0]), [0, 0, 0.05]);
  nudgeVertices(pos, new Set([0]), [0, 0, 0.05]);
  assert.ok(Math.abs(pos[2] - 0.1) < 1e-6, `két lépésben 10 cm: ${pos[2]}`);
});

// ---- GLB-oldal ----

function keszitGlb(pontok, { min, max } = {}) {
  const bin = new Uint8Array(pontok.length * 4);
  const dv = new DataView(bin.buffer);
  pontok.forEach((v, i) => dv.setFloat32(i * 4, v, true));
  const acc = { bufferView: 0, componentType: 5126, count: pontok.length / 3, type: 'VEC3' };
  if (min) acc.min = min;
  if (max) acc.max = max;
  const json = {
    accessors: [acc],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.byteLength }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const pad = (n) => (4 - (n % 4)) % 4;
  const jsonPad = pad(jsonBytes.length);
  const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + bin.byteLength;
  const out = new Uint8Array(total);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, 0x46546c67, true); odv.setUint32(4, 2, true); odv.setUint32(8, total, true);
  odv.setUint32(12, jsonBytes.length + jsonPad, true); odv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  for (let i = 0; i < jsonPad; i++) out[20 + jsonBytes.length + i] = 0x20;
  const binChunk = 20 + jsonBytes.length + jsonPad;
  odv.setUint32(binChunk, bin.byteLength, true); odv.setUint32(binChunk + 4, 0x004e4942, true);
  out.set(bin, binChunk + 8);
  return out;
}

test('a GLB csúcsai helyben javíthatók, a fájl mérete változatlan', () => {
  const bytes = keszitGlb([0, 0, 0, 1, 0, 0], { min: [-10, -10, -10], max: [10, 10, 10] });
  const meretElotte = bytes.byteLength;
  const glb = parseGlb(bytes);

  const { db, kilog, olvas } = patchGlbPositions(bytes, glb, 0, [[1, 1, 0, 0.05]]);
  assert.equal(db, 1);
  assert.equal(kilog, 0);
  assert.equal(bytes.byteLength, meretElotte, 'a fájl mérete nem változhat');
  assert.deepEqual([olvas(0, 0), olvas(0, 1), olvas(0, 2)], [0, 0, 0], 'a 0. csúcs érintetlen');
  assert.ok(Math.abs(olvas(1, 2) - 0.05) < 1e-6, 'az 1. csúcs elmozdult');
});

test('a befoglaló dobozból kilépő csúcsot jelezzük, nem hallgatjuk el', () => {
  // A min/max mezőket szándékosan nem írjuk át — az a JSON hosszát változtatná,
  // és elveszne a bájtpontos javítás. Ezért a hívónak tudnia kell róla.
  const bytes = keszitGlb([0, 0, 0], { min: [0, 0, 0], max: [0, 0, 0] });
  const glb = parseGlb(bytes);
  const { db, kilog } = patchGlbPositions(bytes, glb, 0, [[0, 0, 0, 0.05]]);
  assert.equal(db, 1, 'az írás akkor is megtörténik');
  assert.equal(kilog, 1, 'de jelezzük, hogy kilógott');
});

test('a nem float32 POSITION-t nem próbáljuk helyben javítani', () => {
  const bytes = keszitGlb([0, 0, 0]);
  const glb = parseGlb(bytes);
  glb.json.accessors[0].componentType = 5122; // int16, kvantált modell
  assert.throws(() => patchGlbPositions(bytes, glb, 0, [[0, 1, 1, 1]]), /float32/);
});

test('az egymásba fűzött (interleaved) elrendezést a byteStride kezeli', () => {
  // POSITION + valami más attribútum egy pufferben: a csúcsok nem szorosan
  // követik egymást, tehát a lépésköz nem 12 bájt.
  const STRIDE = 20;
  const bin = new Uint8Array(2 * STRIDE);
  const dv = new DataView(bin.buffer);
  dv.setFloat32(0, 1, true); dv.setFloat32(4, 2, true); dv.setFloat32(8, 3, true);
  dv.setFloat32(STRIDE, 4, true); dv.setFloat32(STRIDE + 4, 5, true); dv.setFloat32(STRIDE + 8, 6, true);
  const json = {
    accessors: [{ bufferView: 0, componentType: 5126, count: 2, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.byteLength, byteStride: STRIDE }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + bin.byteLength;
  const out = new Uint8Array(total);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, 0x46546c67, true); odv.setUint32(4, 2, true); odv.setUint32(8, total, true);
  odv.setUint32(12, jsonBytes.length + jsonPad, true); odv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  for (let i = 0; i < jsonPad; i++) out[20 + jsonBytes.length + i] = 0x20;
  const bc = 20 + jsonBytes.length + jsonPad;
  odv.setUint32(bc, bin.byteLength, true); odv.setUint32(bc + 4, 0x004e4942, true);
  out.set(bin, bc + 8);

  const glb = parseGlb(out);
  const { olvas } = patchGlbPositions(out, glb, 0, [[1, 40, 50, 60]]);
  assert.deepEqual([olvas(0, 0), olvas(0, 1), olvas(0, 2)], [1, 2, 3], 'a 0. csúcs érintetlen');
  assert.deepEqual([olvas(1, 0), olvas(1, 1), olvas(1, 2)], [40, 50, 60]);
});

test('a két irány pontosan kioltja egymást', () => {
  // Ugyanaz a villogás megszűnik attól is, ha a feliratot hozzuk előre, és
  // attól is, ha a tábla lapját toljuk hátra. A kettő ugyanaz a művelet
  // ellentétes előjellel, ezért egymás után futtatva vissza kell adnia az
  // eredetit — különben a "hátrébb" nem a "előrébb" fordítottja lenne.
  const pos = new Float32Array([1, 2, 3]);
  nudgeVertices(pos, new Set([0]), [0, 0, 0.05]);
  nudgeVertices(pos, new Set([0]), [0, 0, -0.05]);
  assert.ok(Math.abs(pos[0] - 1) < 1e-6 && Math.abs(pos[1] - 2) < 1e-6
    && Math.abs(pos[2] - 3) < 1e-6, `vissza az eredetire: ${[...pos]}`);
});

test('a dev mód mindkét irányt kínálja, és a csúcssorszámot nem fordítja', async () => {
  const fs = await import('node:fs/promises');
  const dev = await fs.readFile(new URL('../web/dev.js', import.meta.url), 'utf8');
  assert.match(dev, /vilagNormal\.dot\(kameraFele\) >= 0 \? 1 : -1/,
    'az irányt a kattintás oldala dönti el, nem tippelés');
  assert.match(dev, /applyMatrix3\(objInverz\)/,
    'a világtérbeli centiméter objektumtérbe váltva');
  // A lapsorszámot fordítani KELL (a BVH átrendezi), a csúcssorszámot NEM.
  assert.match(dev, /patchGlbPositions\(bytes, glb, prim\.attributes\.POSITION, moves\)/);
  // Két gomb, egy művelet: az irány paraméter, nem külön kódút.
  assert.match(dev, /cutterNudgeSelection\(1\)/);
  assert.match(dev, /cutterNudgeSelection\(-1\)/);
  assert.match(dev, /elojel < 0 \? -cm : cm/);
  const html = await fs.readFile(new URL('../web/dev.html', import.meta.url), 'utf8');
  assert.match(html, /id="cutterNudgeBtn"[^>]*>Előrébb</);
  assert.match(html, /id="cutterPushBtn"[^>]*>Hátrébb</);
});
