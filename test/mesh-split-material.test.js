// Darab áthelyezése másik anyag alá: új primitív, közös attribútumok.
//
// Ez az egyetlen művelet a vágóban, ami NEM bájtpontos folt — a JSON hossza és
// a fájl mérete változik. Ezért itt a fájl SZERKEZETI épsége a tét: a darabok
// hossza, a párnázás, az eltolások és a megmaradó eredeti tartalom.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGlb, addPrimitiveWithMaterial } from '../shared/meshCut.js';

// Egy kis GLB: egy mesh, egy primitív (POSITION + indexek), két anyag.
function keszitGlb() {
  const pontok = new Float32Array([0,0,0, 1,0,0, 1,1,0, 0,1,0]);
  const indexek = new Uint16Array([0,1,2, 0,2,3]);
  const posBytes = new Uint8Array(pontok.buffer);
  const idxBytes = new Uint8Array(indexek.buffer);
  const idxOffset = posBytes.byteLength;                 // 48, 4-gyel oszthato
  const bin = new Uint8Array(idxOffset + idxBytes.byteLength);
  bin.set(posBytes, 0);
  bin.set(idxBytes, idxOffset);
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes.byteLength },
      { buffer: 0, byteOffset: idxOffset, byteLength: idxBytes.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3',
        min: [0,0,0], max: [1,1,0] },
      { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
    materials: [{ name: 'lomb', alphaMode: 'BLEND' }, { name: 'aszfalt' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const pad = (n) => (4 - (n % 4)) % 4;
  const jp = pad(jsonBytes.byteLength), bp = pad(bin.byteLength);
  const total = 12 + 8 + jsonBytes.byteLength + jp + 8 + bin.byteLength + bp;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.byteLength + jp, true); dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonBytes.byteLength + jp);
  const bc = 20 + jsonBytes.byteLength + jp;
  dv.setUint32(bc, bin.byteLength + bp, true); dv.setUint32(bc + 4, 0x004e4942, true);
  out.set(bin, bc + 8);
  return out;
}

test('az új primitív a megadott anyagot kapja, és OSZTOZIK az attribútumokon', () => {
  const bytes = keszitGlb();
  const glb = parseGlb(bytes);
  const uj = addPrimitiveWithMaterial(bytes, glb, {
    meshIndex: 0, primitiveIndex: 0, triples: [[0, 2, 3]], materialIndex: 1,
  });
  const g2 = parseGlb(uj).json;
  assert.equal(g2.meshes[0].primitives.length, 2);
  const p = g2.meshes[0].primitives[1];
  assert.equal(p.material, 1, 'az aszfalt-anyagot kapja');
  assert.deepEqual(p.attributes, { POSITION: 0 },
    'ugyanarra a POSITION accessorra mutat — egy csúcsot sem duplázunk');
  assert.notEqual(p.indices, g2.meshes[0].primitives[0].indices, 'saját indexei vannak');
});

test('az új indexek tényleg a megadott háromszöget írják le', () => {
  const bytes = keszitGlb();
  const uj = addPrimitiveWithMaterial(bytes, parseGlb(bytes), {
    meshIndex: 0, primitiveIndex: 0, triples: [[0, 2, 3], [1, 2, 3]], materialIndex: 1,
  });
  const glb2 = parseGlb(uj);
  const acc = glb2.json.accessors[glb2.json.meshes[0].primitives[1].indices];
  assert.equal(acc.componentType, 5125, 'uint32');
  assert.equal(acc.count, 6);
  const bv = glb2.json.bufferViews[acc.bufferView];
  const dv = new DataView(uj.buffer, uj.byteOffset, uj.byteLength);
  const olvas = (k) => dv.getUint32(glb2.binStart + bv.byteOffset + k * 4, true);
  assert.deepEqual([olvas(0), olvas(1), olvas(2)], [0, 2, 3]);
  assert.deepEqual([olvas(3), olvas(4), olvas(5)], [1, 2, 3]);
});

test('a fájl szerkezete ép: darabhosszak, párnázás, méret', () => {
  const bytes = keszitGlb();
  const uj = addPrimitiveWithMaterial(bytes, parseGlb(bytes), {
    meshIndex: 0, primitiveIndex: 0, triples: [[0, 2, 3]], materialIndex: 1,
  });
  const dv = new DataView(uj.buffer, uj.byteOffset, uj.byteLength);
  assert.equal(dv.getUint32(0, true), 0x46546c67, 'GLB magic');
  assert.equal(dv.getUint32(8, true), uj.byteLength, 'a fejléc hossza a valódi méret');
  const jsonLen = dv.getUint32(12, true);
  assert.equal(jsonLen % 4, 0, 'a JSON-darab 4-gyel osztható');
  const bc = 20 + jsonLen;
  assert.equal(dv.getUint32(bc + 4, true), 0x004e4942, 'BIN darab a helyén');
  assert.equal(dv.getUint32(bc, true) % 4, 0, 'a BIN-darab 4-gyel osztható');
  assert.equal(12 + 8 + jsonLen + 8 + dv.getUint32(bc, true), uj.byteLength,
    'a darabok pontosan kiadják a fájlt');
  // A JSON párnázása SZÓKÖZ, nem nulla — ezt a glTF előírja.
  const jsonSzoveg = new TextDecoder().decode(uj.subarray(20, 20 + jsonLen));
  assert.doesNotThrow(() => JSON.parse(jsonSzoveg.trim()), 'a JSON értelmezhető marad');
});

test('az eredeti BIN tartalma bájtra megmarad', () => {
  const bytes = keszitGlb();
  const glb = parseGlb(bytes);
  const regiBin = bytes.slice(glb.binStart, glb.binStart + glb.binLength);
  const uj = addPrimitiveWithMaterial(bytes, glb, {
    meshIndex: 0, primitiveIndex: 0, triples: [[0, 2, 3]], materialIndex: 1,
  });
  const glb2 = parseGlb(uj);
  const ujBin = uj.subarray(glb2.binStart, glb2.binStart + regiBin.byteLength);
  assert.deepEqual([...ujBin], [...regiBin], 'a régi geometria és textúra érintetlen');
  // És az eredeti primitív is a helyén, változatlan anyaggal.
  assert.equal(glb2.json.meshes[0].primitives[0].material, 0);
  assert.equal(glb2.json.meshes[0].primitives[0].indices, 1);
});

test('a buffer deklarált hossza követi a bővítést', () => {
  const bytes = keszitGlb();
  const glb = parseGlb(bytes);
  const regi = glb.json.buffers[0].byteLength;
  const uj = addPrimitiveWithMaterial(bytes, glb, {
    meshIndex: 0, primitiveIndex: 0, triples: [[0, 2, 3]], materialIndex: 1,
  });
  const g2 = parseGlb(uj).json;
  assert.ok(g2.buffers[0].byteLength > regi, 'nőtt');
  const utolso = g2.bufferViews.at(-1);
  assert.equal(utolso.byteOffset % 4, 0, 'az új nézet 4-gyel osztható eltolásnál kezdődik');
  assert.ok(utolso.byteOffset + utolso.byteLength <= g2.buffers[0].byteLength,
    'a nézet belefér a deklarált bufferbe');
});

test('értelmetlen bemenetre nem gyárt csendben hibás fájlt', () => {
  const bytes = keszitGlb();
  const glb = parseGlb(bytes);
  assert.throws(() => addPrimitiveWithMaterial(bytes, glb,
    { meshIndex: 9, primitiveIndex: 0, triples: [[0,1,2]], materialIndex: 1 }), /primitív/);
  assert.throws(() => addPrimitiveWithMaterial(bytes, glb,
    { meshIndex: 0, primitiveIndex: 0, triples: [[0,1,2]], materialIndex: 99 }), /anyag/);
});

test('a dev mód két lépésben dolgozik: anyag másolása, majd ráadása', async () => {
  const fs = await import('node:fs/promises');
  const dev = await fs.readFile(new URL('../web/dev.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../web/dev.html', import.meta.url), 'utf8');
  assert.match(html, /id="cutterCopyMatBtn"/);
  assert.match(html, /id="cutterApplyMatBtn"/);
  // A csúcshármasokat MÉG az elfajulttá tétel előtt kell kiolvasni: utána az
  // indexek már mind ugyanarra a csúcsra mutatnak.
  const fn = dev.slice(dev.indexOf('function cutterApplyMaterial()'));
  const triplesAt = fn.indexOf('const triples = faces.map');
  const degenAt = fn.indexOf('degenerateFaces(idx, faces)');
  assert.ok(triplesAt >= 0 && degenAt >= 0);
  assert.ok(triplesAt < degenAt, 'a hármasok kiolvasása megelőzi az elfajulttá tételt');
  // A geometria NEM tűnik el: az új háló ugyanazokat a csúcsokat használja.
  assert.match(fn, /for \(const nev of Object\.keys\(geo\.attributes\)\)/);
  // Mentéskor a fájl újraépül, ezért a bájttömb újraköthető kell legyen.
  assert.match(dev, /let bytes = new Uint8Array\(await res\.arrayBuffer\(\)\)/);
  assert.match(dev, /bytes = addPrimitiveWithMaterial\(bytes, glb, \{/);
  assert.match(dev, /glb = parseGlb\(bytes\);/, 'az új fájlt újra kell értelmezni');
});

test('az előnézeti háló nem jelölhető ki, és a menthetőség kattintáskor kiderül', async () => {
  const fs = await import('node:fs/promises');
  const dev = await fs.readFile(new URL('../web/dev.js', import.meta.url), 'utf8');
  // Az előnézeti háló nem a GLB-ből származik: rákattintva a mentés elhasalna
  // ("Nem találom a hálót a GLB-ben"), ezért a raycast eleve kihagyja.
  assert.match(dev, /ujMesh\.userData\.cutterPreview = true/);
  assert.match(dev, /!h\.object\.userData\?\.cutterPreview/);
  // És a menthetőséget nem a mentés végén, hanem már kijelöléskor jelezzük.
  assert.match(dev, /api\.currentTrackAssociations\?\.get\(hit\.object\)\?\.meshes !== undefined/);
  assert.match(dev, /cutterCutBtn\.disabled = !mentheto/);
  // A hibaüzenet mondja meg, MELYIK művelet bukott el.
  assert.match(dev, /kivágás', nudge: 'eltolás', material: 'anyagcsere'/);
});
