// Az eltolt csúcsok után az accessor befoglaló doboza is frissüljön.
//
// A `patchGlbPositions` bájtpontosan írja át a koordinátákat, de a glTF-ben a
// `min`/`max` KÜLÖN mező a JSON-ban. Ha az elavul, a Three.js a valóságosnál
// szűkebb `boundingBox`-szal dolgozik — a látótér-vágás és a sugárvetés is
// abból indul ki.
//
// Ez nem elméleti: a Hungaroring masterében öt eltolt reklámtábla befoglalója
// 3,1 és 10,0 cm közt tért el a tényleges adattól. A kiszolgált modellen nem
// látszott, mert a gltfpack újraszámolja — dev módban viszont a mastert
// töltjük be.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGlb, patchGlbPositions, refreshPositionBounds,
} from '../shared/meshCut.js';

// Egyetlen primitívből álló GLB, három csúccsal, helyes befoglalóval.
function keszitGlb(pontok) {
  const bin = new Uint8Array(pontok.length * 12);
  const dv = new DataView(bin.buffer);
  pontok.forEach((p, i) => p.forEach((x, k) => dv.setFloat32(i * 12 + k * 4, x, true)));
  const min = [0, 1, 2].map((k) => Math.min(...pontok.map((p) => p[k])));
  const max = [0, 1, 2].map((k) => Math.max(...pontok.map((p) => p[k])));
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.byteLength }],
    accessors: [{
      bufferView: 0, componentType: 5126, count: pontok.length, type: 'VEC3', min, max,
    }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const pad = (n) => (4 - (n % 4)) % 4;
  const jp = pad(jsonBytes.byteLength), bp = pad(bin.byteLength);
  const total = 12 + 8 + jsonBytes.byteLength + jp + 8 + bin.byteLength + bp;
  const out = new Uint8Array(total);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, 0x46546c67, true);
  odv.setUint32(4, 2, true);
  odv.setUint32(8, total, true);
  odv.setUint32(12, jsonBytes.byteLength + jp, true);
  odv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonBytes.byteLength + jp);
  const bc = 20 + jsonBytes.byteLength + jp;
  odv.setUint32(bc, bin.byteLength + bp, true);
  odv.setUint32(bc + 4, 0x004e4942, true);
  out.set(bin, bc + 8);
  return out;
}

// A negyedik pont szándékosan BELÜL van: rajta látszik, hogy egy olyan
// eltolás, ami nem éri el a háló szélét, nem is épít újra fájlt.
const PONTOK = [[0, 0, 0], [10, 2, 0], [0, 2, 10], [5, 1, 5]];

test('az eltolás után a befoglaló a tényleges adatot követi', () => {
  const bytes = keszitGlb(PONTOK);
  const glb = parseGlb(bytes);
  assert.deepEqual(glb.json.accessors[0].max, [10, 2, 10]);

  // Az egyik csúcsot kitoljuk a deklarált dobozon KÍVÜLRE.
  const r = patchGlbPositions(bytes, glb, 0, [[1, 10.5, 2, 0]]);
  assert.equal(r.db, 1);
  assert.equal(r.kilog, 1, 'a kilógást a folt jelzi is');
  assert.deepEqual(parseGlb(bytes).json.accessors[0].max, [10, 2, 10],
    'a folt maga nem nyúl a befoglalóhoz');

  const uj = refreshPositionBounds(bytes, glb, [0]);
  assert.ok(uj, 'a frissítés új bájttömböt ad');
  const utana = parseGlb(uj.bytes);
  assert.deepEqual(utana.json.accessors[0].max, [10.5, 2, 10]);
  assert.deepEqual(utana.json.accessors[0].min, [0, 0, 0]);
  assert.equal(uj.frissitve.length, 1);
  assert.ok(Math.abs(uj.frissitve[0].elteres - 0.5) < 1e-6, 'az eltérés mértékét is jelenti');
});

test('a BIN egyetlen bájtja sem mozdul a frissítéstől', () => {
  const bytes = keszitGlb(PONTOK);
  const glb = parseGlb(bytes);
  patchGlbPositions(bytes, glb, 0, [[1, 10.5, 2, 0]]);
  const elotte = bytes.slice(glb.binStart, glb.binStart + glb.binLength);

  const uj = refreshPositionBounds(bytes, glb, [0]);
  const ujGlb = parseGlb(uj.bytes);
  const utana = uj.bytes.slice(ujGlb.binStart, ujGlb.binStart + ujGlb.binLength);
  assert.deepEqual([...utana], [...elotte], 'a geometria bájtazonos marad');
});

test('változatlan befoglalónál nem épít újra fájlt', () => {
  const bytes = keszitGlb(PONTOK);
  const glb = parseGlb(bytes);
  // A BELSŐ pontot mozgatjuk, a doboz széléhez nem érünk hozzá.
  const r = patchGlbPositions(bytes, glb, 0, [[3, 6, 1, 5]]);
  assert.equal(r.db, 1);
  assert.equal(r.kilog, 0, 'a dobozon belül maradt');
  assert.equal(refreshPositionBounds(bytes, glb, [0]), null,
    'ha a szélső érték nem mozdult, nincs mit átírni');
});

test('a szűkülést is követi, nemcsak a tágulást', () => {
  const bytes = keszitGlb(PONTOK);
  const glb = parseGlb(bytes);
  // A legszélső csúcsot BEHÚZZUK: a doboz így kisebb lesz a deklaráltnál.
  // Az x-maximum ezután a belső pont 5-ös értéke lesz.
  patchGlbPositions(bytes, glb, 0, [[1, 4, 2, 0]]);
  const uj = refreshPositionBounds(bytes, glb, [0]);
  assert.ok(uj, 'a szűkülés is elavulttá teszi a deklarált dobozt');
  assert.deepEqual(parseGlb(uj.bytes).json.accessors[0].max, [5, 2, 10]);
});

test('a mentés a mozgatott accessorokra hívja a frissítést', async () => {
  const fs = await import('node:fs/promises');
  const dev = await fs.readFile(new URL('../web/dev.js', import.meta.url), 'utf8');
  assert.match(dev, /mozgatottAccessorok\.add\(prim\.attributes\.POSITION\)/,
    'az eltolás nem jegyzi fel az érintett accessort');
  assert.match(dev, /refreshPositionBounds\(bytes, glb, mozgatottAccessorok\)/,
    'a mentés nem frissíti a befoglalókat');
});
