// Car pack szétvágása HÁROMSZÖG szinten.
//
// A split-car-pack.mjs a node-hierarchiából dolgozik: az a 2014-es packnál
// működik, ahol minden kocsi külön node. A 2010-es és 2013-as packban viszont
// EGYETLEN node van (bodywithwheels_0), alatta 19 mesh-sel, és mindegyik mesh
// az egész mezőnyt átfogja — ott nincs mit átcsoportosítani.
//
// Ez a script ezért a geometriát vágja: minden háromszöget a súlypontja alapján
// sorol egy kocsihoz, majd kocsinként új puffert épít. A packok szerencsére
// egyszerűek — indexelt háromszögek, POSITION/NORMAL/TEXCOORD, semmi tömörítés
// vagy csontváz —, ezért ez elvégezhető.
//
// Használat:
//   node tools/slice-car-pack.mjs <pack.glb> [--write] [--out <mappa>]
import fs from 'node:fs';
import path from 'node:path';
import { loadGlb, readAccessor } from './glb.mjs';

const MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const FLOAT = 5126;
const UINT32 = 5125;
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

// A kocsik közti határt a legnagyobb hézagoknál húzzuk meg. Ehhez tudni kell,
// hány kocsi van: azt a KOCSINKÉNTI (nem az egészet átfogó) mesh-ek adják meg,
// mert azokból pontosan egy jut mindegyikre.
function carBounds(prims, axis) {
  const total = Math.max(...prims.map((p) => p.max[axis])) - Math.min(...prims.map((p) => p.min[axis]));
  const perCar = prims.filter((p) => (p.max[axis] - p.min[axis]) < total * 0.25);
  if (perCar.length < 2) return null;
  const centres = perCar.map((p) => (p.min[axis] + p.max[axis]) / 2).sort((a, b) => a - b);
  // Az egy kocsihoz tartozó darabok közel esnek egymáshoz; a kocsik közt nagy a
  // hézag. A hézagok mediánjának a fele jó elválasztó küszöb.
  const gaps = [];
  for (let i = 1; i < centres.length; i++) gaps.push(centres[i] - centres[i - 1]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const typical = sorted[sorted.length >> 1];
  const groups = [[centres[0]]];
  for (let i = 1; i < centres.length; i++) {
    if (centres[i] - centres[i - 1] > typical * 0.5) groups.push([]);
    groups.at(-1).push(centres[i]);
  }
  const cars = groups.map((g) => g.reduce((a, b) => a + b, 0) / g.length);
  const bounds = [];
  for (let i = 0; i < cars.length; i++) {
    bounds.push({
      centre: cars[i],
      min: i === 0 ? -Infinity : (cars[i - 1] + cars[i]) / 2,
      max: i === cars.length - 1 ? Infinity : (cars[i] + cars[i + 1]) / 2,
    });
  }
  return bounds;
}

function accessorData(g, bin, index) {
  const a = g.accessors[index];
  return { values: readAccessor(g, bin, index), components: NC[a.type], type: a.type };
}

// Egy primitív háromszögeit szétosztja a kocsik közt, és kocsinként új,
// tömören csomagolt attribútum-tömböket ad vissza.
function slicePrimitive(g, bin, prim, bounds, axis, matrix) {
  const positions = accessorData(g, bin, prim.attributes.POSITION);
  const indices = prim.indices !== undefined
    ? readAccessor(g, bin, prim.indices)
    : Float32Array.from({ length: positions.values.length / 3 }, (_, i) => i);
  const attrs = Object.entries(prim.attributes).map(([name, index]) => [name, accessorData(g, bin, index)]);

  const world = (i) => {
    const x = positions.values[i * 3], y = positions.values[i * 3 + 1], z = positions.values[i * 3 + 2];
    if (!matrix) return [x, y, z];
    return [
      matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
      matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
      matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
    ];
  };

  const perCar = bounds.map(() => ({ remap: new Map(), indices: [] }));
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    const centre = (world(a)[axis] + world(b)[axis] + world(c)[axis]) / 3;
    const car = bounds.findIndex((bnd) => centre >= bnd.min && centre < bnd.max);
    if (car < 0) continue;
    const slot = perCar[car];
    for (const v of [a, b, c]) {
      if (!slot.remap.has(v)) slot.remap.set(v, slot.remap.size);
      slot.indices.push(slot.remap.get(v));
    }
  }

  return perCar.map((slot) => {
    if (!slot.indices.length) return null;
    const order = [...slot.remap.entries()].sort((x, y) => x[1] - y[1]).map(([source]) => source);
    const out = { indices: Uint32Array.from(slot.indices), attributes: {} };
    for (const [name, data] of attrs) {
      const n = data.components;
      const values = new Float32Array(order.length * n);
      order.forEach((source, target) => {
        for (let c = 0; c < n; c++) values[target * n + c] = data.values[source * n + c];
      });
      // A node-lánc transzformációját BE KELL ÉGETNI, mert a kiírt kocsi új,
      // transzformáció nélküli node-ra kerül. Enélkül a Sketchfab-export
      // Y-fel/Z-fel forgatása elveszik, és a kocsi az oldalán fekszik (mérve:
      // 8,7 x 23,9 x 5,2 a helyes 8,7 x 5,2 x 23,9 helyett).
      if (matrix && name === 'POSITION') {
        for (let i = 0; i < order.length; i++) {
          const x = values[i * 3], y = values[i * 3 + 1], z = values[i * 3 + 2];
          values[i * 3] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
          values[i * 3 + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
          values[i * 3 + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
        }
      } else if (matrix && name === 'NORMAL') {
        // A normálisokra csak a forgatás/skálázás hat, az eltolás nem.
        for (let i = 0; i < order.length; i++) {
          const x = values[i * 3], y = values[i * 3 + 1], z = values[i * 3 + 2];
          const nx = matrix[0] * x + matrix[4] * y + matrix[8] * z;
          const ny = matrix[1] * x + matrix[5] * y + matrix[9] * z;
          const nz = matrix[2] * x + matrix[6] * y + matrix[10] * z;
          const len = Math.hypot(nx, ny, nz) || 1;
          values[i * 3] = nx / len; values[i * 3 + 1] = ny / len; values[i * 3 + 2] = nz / len;
        }
      }
      out.attributes[name] = { values, components: n, type: data.type };
    }
    return out;
  });
}

function nodeMatrix(g, index) {
  // A packokban a kocsik egy közös node alatt ülnek; a saját transzformációjuk
  // a hierarchiában van. A háromszögeket viszont világ-koordinátában kell
  // sorolni, ezért az ős-láncot összeszorozzuk.
  const chain = [];
  let current = index;
  for (let depth = 0; depth < 16; depth++) {
    chain.unshift(current);
    const parent = g.nodes.findIndex((n) => (n.children || []).includes(current));
    if (parent < 0) break;
    current = parent;
  }
  const mul = (a, b) => {
    const o = new Float64Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  };
  let m = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  for (const i of chain) {
    const n = g.nodes[i];
    if (n.matrix) { m = mul(m, Float64Array.from(n.matrix)); continue; }
    const [tx, ty, tz] = n.translation || [0, 0, 0];
    const [qx, qy, qz, qw] = n.rotation || [0, 0, 0, 1];
    const [sx, sy, sz] = n.scale || [1, 1, 1];
    const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
    const xx = qx * x2, xy = qx * y2, xz = qx * z2;
    const yy = qy * y2, yz = qy * z2, zz = qz * z2;
    const wx = qw * x2, wy = qw * y2, wz = qw * z2;
    m = mul(m, Float64Array.from([
      (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
      (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
      (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
      tx, ty, tz, 1,
    ]));
  }
  return m;
}

function buildGlb(source, pieces, usedImages, sourceBin) {
  const bufferViews = [], accessors = [], images = [], textures = [], materials = [];
  const chunks = [];
  let offset = 0;
  const push = (buffer, extra = {}) => {
    const pad = (4 - (offset % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; }
    chunks.push(buffer);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buffer.length, ...extra });
    offset += buffer.length;
    return bufferViews.length - 1;
  };
  const addAccessor = (values, componentType, type, components, extra = {}) => {
    const array = componentType === UINT32 ? Uint32Array.from(values) : Float32Array.from(values);
    const view = push(Buffer.from(array.buffer, array.byteOffset, array.byteLength), extra);
    const count = values.length / components;
    const min = new Array(components).fill(Infinity), max = new Array(components).fill(-Infinity);
    for (let i = 0; i < count; i++) for (let c = 0; c < components; c++) {
      const v = values[i * components + c];
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
    }
    accessors.push({ bufferView: view, componentType, count, type, min, max });
    return accessors.length - 1;
  };

  const imageMap = new Map();
  for (const index of usedImages) {
    const image = source.images[index];
    const bv = source.bufferViews[image.bufferView];
    const buffer = Buffer.from(sourceBin.buffer, sourceBin.byteOffset + (bv.byteOffset || 0), bv.byteLength);
    const view = push(Buffer.from(buffer));
    imageMap.set(index, images.length);
    images.push({ bufferView: view, mimeType: image.mimeType, ...(image.name ? { name: image.name } : {}) });
  }
  const textureMap = new Map();
  source.textures?.forEach((texture, index) => {
    if (texture.source === undefined || !imageMap.has(texture.source)) return;
    textureMap.set(index, textures.length);
    textures.push({ ...texture, source: imageMap.get(texture.source) });
  });
  const materialMap = new Map();
  const remapTextures = (value, key) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((v) => remapTextures(v, key)); return; }
    if (/texture/i.test(key || '') && Number.isInteger(value.index)) value.index = textureMap.get(value.index) ?? 0;
    for (const [k, v] of Object.entries(value)) remapTextures(v, k);
  };

  const meshes = [], nodes = [];
  for (const piece of pieces) {
    const primitives = [];
    for (const part of piece.parts) {
      const attributes = {};
      for (const [name, data] of Object.entries(part.attributes)) {
        attributes[name] = addAccessor(data.values, FLOAT, data.type, data.components, { target: 34962 });
      }
      const indices = addAccessor(part.indices, UINT32, 'SCALAR', 1, { target: 34963 });
      let material;
      if (part.material !== undefined) {
        if (!materialMap.has(part.material)) {
          const copy = JSON.parse(JSON.stringify(source.materials[part.material]));
          remapTextures(copy, 'material');
          materialMap.set(part.material, materials.length);
          materials.push(copy);
        }
        material = materialMap.get(part.material);
      }
      primitives.push({ attributes, indices, ...(material !== undefined ? { material } : {}) });
    }
    meshes.push({ primitives, name: piece.name });
    nodes.push({ mesh: meshes.length - 1, name: piece.name });
  }

  const bin = Buffer.concat(chunks);
  const json = {
    asset: { version: '2.0', generator: 'levente-racing slice-car-pack' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials,
    textures,
    images,
    ...(source.samplers ? { samplers: source.samplers } : {}),
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }],
    ...(source.extensionsUsed ? { extensionsUsed: source.extensionsUsed } : {}),
  };
  const text = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = Buffer.alloc((4 - (text.length % 4)) % 4, 0x20);
  const binPad = Buffer.alloc((4 - (bin.length % 4)) % 4, 0);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + text.length + jsonPad.length + 8 + bin.length + binPad.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(text.length + jsonPad.length, 0); jh.writeUInt32LE(JSON_CHUNK, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length + binPad.length, 0); bh.writeUInt32LE(BIN_CHUNK, 4);
  return Buffer.concat([header, jh, text, jsonPad, bh, bin, binPad]);
}

export function slicePack(input, { write = false, outDir = null } = {}) {
  const { json: g, bin } = loadGlb(input);
  // Az elrendezés tengelye a nagyobb kiterjedésű vízszintes irány.
  const boxes = [];
  g.nodes.forEach((node, index) => {
    if (node.mesh === undefined) return;
    const m = nodeMatrix(g, index);
    for (const prim of g.meshes[node.mesh].primitives) {
      const acc = g.accessors[prim.attributes.POSITION];
      if (!acc?.min || !acc?.max) continue;
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < 8; i++) {
        const p = [i & 1 ? acc.max[0] : acc.min[0], i & 2 ? acc.max[1] : acc.min[1], i & 4 ? acc.max[2] : acc.min[2]];
        const w = [
          m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
          m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
          m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
        ];
        for (let k = 0; k < 3; k++) { if (w[k] < min[k]) min[k] = w[k]; if (w[k] > max[k]) max[k] = w[k]; }
      }
      boxes.push({ node: index, prim, min, max, matrix: m });
    }
  });
  if (!boxes.length) return { reason: 'nincs geometria' };
  const spanX = Math.max(...boxes.map((b) => b.max[0])) - Math.min(...boxes.map((b) => b.min[0]));
  const spanZ = Math.max(...boxes.map((b) => b.max[2])) - Math.min(...boxes.map((b) => b.min[2]));
  const axis = spanX >= spanZ ? 0 : 2;
  const bounds = carBounds(boxes, axis);
  if (!bounds) return { reason: 'nem tudtam kocsi-határokat találni' };

  const pieces = bounds.map((b, i) => ({ name: `car_${i}`, centre: b.centre, parts: [] }));
  for (const box of boxes) {
    const slices = slicePrimitive(g, bin, box.prim, bounds, axis, box.matrix);
    slices.forEach((slice, i) => {
      if (!slice) return;
      pieces[i].parts.push({ ...slice, material: box.prim.material });
    });
  }

  const result = { axis, cars: pieces.map((p) => ({
    name: p.name,
    parts: p.parts.length,
    triangles: p.parts.reduce((s, x) => s + x.indices.length / 3, 0),
  })) };

  if (!write) return result;
  const target = outDir || path.join(path.dirname(input), `${path.basename(input, '.glb')}_slices`);
  fs.mkdirSync(target, { recursive: true });
  pieces.forEach((piece, i) => {
    const used = new Set();
    for (const part of piece.parts) {
      if (part.material === undefined) continue;
      const walk = (value, key) => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) { value.forEach((v) => walk(v, key)); return; }
        if (/texture/i.test(key || '') && Number.isInteger(value.index)) {
          const t = g.textures[value.index];
          if (t?.source !== undefined) used.add(t.source);
        }
        for (const [k, v] of Object.entries(value)) walk(v, k);
      };
      walk(g.materials[part.material], 'material');
    }
    const file = path.join(target, `${piece.name}.glb`);
    fs.writeFileSync(file, buildGlb(g, [piece], used, bin));
    result.cars[i].bytes = fs.statSync(file).size;
  });
  result.target = target;
  return result;
}

if (process.argv[1] && process.argv[1].endsWith('slice-car-pack.mjs')) {
  const input = process.argv[2];
  if (!input) { console.error('Használat: node tools/slice-car-pack.mjs <pack.glb> [--write]'); process.exit(1); }
  const outIndex = process.argv.indexOf('--out');
  const r = slicePack(input, {
    write: process.argv.includes('--write'),
    outDir: outIndex > 0 ? process.argv[outIndex + 1] : null,
  });
  if (r.reason) { console.log(r.reason); process.exit(0); }
  console.log(`kocsi: ${r.cars.length}`);
  for (const c of r.cars) {
    console.log(`  ${c.name.padEnd(10)} ${String(c.parts).padStart(3)} darab, ${(c.triangles / 1000).toFixed(0)}e háromszög`
      + (c.bytes ? `, ${(c.bytes / 1048576).toFixed(1)} MB` : ''));
  }
  if (r.target) console.log(`\nkiírva: ${r.target}`);
}
