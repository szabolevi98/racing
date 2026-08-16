// Az objektumvágó magja: összefüggő darab keresése egy összeolvasztott hálóban,
// és a darab eltüntetése úgy, hogy a puffer hossza NE változzon — ez utóbbin áll
// vagy bukik, hogy a GLB helyben, bájtra pontosan javítható legyen.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeByPosition, componentAtFace, boundsOfVertices,
  degenerateFaces, restoreFaces, parseGlb, patchGlbFaces, cutBlocker,
} from '../shared/meshCut.js';

// Egy „geometria", ami úgy viselkedik, mint a Three.js BufferAttribute-ja.
function attribute(pontok) {
  return {
    count: pontok.length,
    getX: (i) => pontok[i][0],
    getY: (i) => pontok[i][1],
    getZ: (i) => pontok[i][2],
  };
}

// Két különálló négyzet ugyanabban a hálóban: egy „pálya" az origóban és egy
// „doboz" tíz méterrel odébb. Pont az az eset, amit a Sketchfab-modellek adnak.
function ketDarab() {
  const pontok = [
    [0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1],
    [10, 0, 0], [11, 0, 0], [11, 2, 1], [10, 2, 1],
  ];
  const index = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return { position: attribute(pontok), index };
}

test('a kijelölt háromszög összefüggő darabja elkülönül a többitől', () => {
  const { position, index } = ketDarab();
  const rep = mergeByPosition(position);

  const elso = componentAtFace(index, rep, 0);
  assert.deepEqual(elso.faces, [0, 1], 'a pálya-négyzet két háromszöge');

  const masodik = componentAtFace(index, rep, 2);
  assert.deepEqual(masodik.faces, [2, 3], 'a doboz két háromszöge');
  assert.deepEqual([...masodik.vertices].sort((a, b) => a - b), [4, 5, 6, 7]);
});

test('a varrat mentén duplázott csúcs nem szakítja ketté a darabot', () => {
  // Ugyanaz a pozíció kétszer szerepel (eltérő UV-t utánozva): a két háromszög
  // indexben nem osztozik csúcson, geometriailag viszont egy darab.
  const pontok = [
    [0, 0, 0], [1, 0, 0], [1, 0, 1],
    [0, 0, 0], [1, 0, 1], [0, 0, 1],
  ];
  const index = new Uint32Array([0, 1, 2, 3, 4, 5]);
  const position = attribute(pontok);

  const osszevonasNelkul = componentAtFace(index, Int32Array.from(pontok.map((_, i) => i)), 0);
  assert.deepEqual(osszevonasNelkul.faces, [0], 'összevonás nélkül szétesne');

  const rep = mergeByPosition(position);
  assert.deepEqual(componentAtFace(index, rep, 0).faces, [0, 1], 'pozíció szerint egy darab');
});

test('a befoglaló doboz a kijelölt darab méretét adja', () => {
  const { position, index } = ketDarab();
  const rep = mergeByPosition(position);
  const doboz = componentAtFace(index, rep, 2);
  const b = boundsOfVertices(position, doboz.vertices);
  assert.deepEqual(b.size, [1, 2, 1]);
  assert.deepEqual(b.center, [10.5, 1, 0.5]);
});

test('az eltüntetés elfajulttá tesz, a puffer hossza nem változik, és visszavonható', () => {
  const { position, index } = ketDarab();
  const rep = mergeByPosition(position);
  const hosszElotte = index.length;
  const doboz = componentAtFace(index, rep, 2);

  const mentes = degenerateFaces(index, doboz.faces);
  assert.equal(index.length, hosszElotte, 'a hossz nem változhat');
  for (const t of doboz.faces) {
    assert.equal(index[t * 3 + 1], index[t * 3]);
    assert.equal(index[t * 3 + 2], index[t * 3]);
  }
  // A pálya-négyzet érintetlen
  assert.deepEqual([...index.slice(0, 6)], [0, 1, 2, 0, 2, 3]);

  restoreFaces(index, mentes);
  assert.deepEqual([...index], [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7], 'visszavonás után az eredeti');
});

// ---- GLB-oldal ----

function keszitGlb(indexek) {
  const bin = new Uint8Array(indexek.length * 4);
  new DataView(bin.buffer).constructor; // (csak olvashatóság kedvéért)
  const dv = new DataView(bin.buffer);
  indexek.forEach((v, i) => dv.setUint32(i * 4, v, true));
  const json = {
    accessors: [{ bufferView: 0, componentType: 5125, count: indexek.length, type: 'SCALAR' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.byteLength }],
    meshes: [{ primitives: [{ indices: 0, attributes: { POSITION: 1 } }] }],
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

test('a GLB indexei helyben javíthatók, a fájl mérete változatlan', () => {
  const eredeti = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const bytes = keszitGlb(eredeti);
  const meretElotte = bytes.byteLength;
  const glb = parseGlb(bytes);

  const db = patchGlbFaces(bytes, glb, 0, [1]); // a középső háromszög
  assert.equal(db, 1);
  assert.equal(bytes.byteLength, meretElotte, 'a fájl mérete nem változhat');

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const olvas = (k) => dv.getUint32(glb.binStart + k * 4, true);
  assert.deepEqual([olvas(0), olvas(1), olvas(2)], [0, 1, 2], 'az első háromszög érintetlen');
  assert.deepEqual([olvas(3), olvas(4), olvas(5)], [3, 3, 3], 'a második elfajult');
  assert.deepEqual([olvas(6), olvas(7), olvas(8)], [6, 7, 8], 'a harmadik érintetlen');
});

test('a tömörített geometriát nem vágjuk, hanem megnevezzük az okot', () => {
  assert.equal(cutBlocker({ indices: 0 }), null);
  assert.match(cutBlocker({ indices: 0, extensions: { KHR_draco_mesh_compression: {} } }), /Draco/);
  assert.match(cutBlocker({ indices: 0, extensions: { EXT_meshopt_compression: {} } }), /meshopt/);
  assert.match(cutBlocker({ attributes: {} }), /index nélküli/);
});
