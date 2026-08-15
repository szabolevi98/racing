// Több kocsit tartalmazó GLB szétvágása külön fájlokra.
//
// A "car pack" modellek egymás mellé állítva tartalmazzák a mezőnyt. A
// szétvágás után minden kocsi ugyanazon az úton megy tovább, mint egy kézzel
// letöltött modell: cars:wheels, cars:compress, majd az audit-eszközök.
//
// A trükk, amivel megúszunk egy GLB-írót: nem faragjuk ki a geometriát, hanem
// kocsinként készítünk egy MÁSOLATOT, amiben a jelenet csak az adott kocsi
// node-jaira hivatkozik — a bináris blokk változatlan marad. Utána a gltfpack
// újraépíti a puffert, és eldob mindent, amire nincs hivatkozás. A
// szemétgyűjtést tehát az a szerszám végzi, ami már bent van a repóban.
//
// Használat:
//   node tools/split-car-pack.mjs <pack.glb>            (csak megnézi)
//   node tools/split-car-pack.mjs <pack.glb> --write    (kiírja a darabokat)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadGlb, xf } from './glb.mjs';
import { ensureGltfpack } from './build-remote-cars.mjs';

const MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

// Két kocsi közti hézag ennél nagyobb a saját szélességükhöz képest. Az egy
// kocsin belüli darabok (kerék, szárny) ennél sűrűbben állnak.
const GAP_RATIO = 0.35;

function nodeWorldBoxes(g) {
  const boxes = new Map();
  const identity = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const trs = (n) => {
    if (n.matrix) return Float64Array.from(n.matrix);
    const [tx, ty, tz] = n.translation || [0, 0, 0];
    const [qx, qy, qz, qw] = n.rotation || [0, 0, 0, 1];
    const [sx, sy, sz] = n.scale || [1, 1, 1];
    const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
    const xx = qx * x2, xy = qx * y2, xz = qx * z2;
    const yy = qy * y2, yz = qy * z2, zz = qz * z2;
    const wx = qw * x2, wy = qw * y2, wz = qw * z2;
    return Float64Array.from([
      (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
      (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
      (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
      tx, ty, tz, 1,
    ]);
  };
  const mul = (a, b) => {
    const out = new Float64Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return out;
  };

  const walk = (index, parent) => {
    const node = g.nodes[index];
    const m = mul(parent, trs(node));
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    if (node.mesh !== undefined) {
      for (const prim of g.meshes[node.mesh].primitives) {
        const acc = g.accessors[prim.attributes.POSITION];
        if (!acc?.min || !acc?.max) continue;
        for (let i = 0; i < 8; i++) {
          const c = xf(m, [i & 1 ? acc.max[0] : acc.min[0], i & 2 ? acc.max[1] : acc.min[1], i & 4 ? acc.max[2] : acc.min[2]]);
          for (let k = 0; k < 3; k++) { if (c[k] < min[k]) min[k] = c[k]; if (c[k] > max[k]) max[k] = c[k]; }
        }
      }
    }
    for (const child of node.children || []) {
      const cb = walk(child, m);
      for (let k = 0; k < 3; k++) { if (cb.min[k] < min[k]) min[k] = cb.min[k]; if (cb.max[k] > max[k]) max[k] = cb.max[k]; }
    }
    const box = { min, max };
    boxes.set(index, box);
    return box;
  };

  const scene = g.scenes[g.scene || 0];
  (scene.nodes || []).forEach((n) => walk(n, identity));
  return boxes;
}

// A kocsik egymás mellett állnak, tehát a hosszabbik vízszintes tengely mentén
// hézagok választják el őket. Ezt keressük meg, nem a node-neveket — egy pack
// jellemzően Object_47 stílusban nevez.
export function groupByGaps(items) {
  const spanX = Math.max(...items.map((i) => i.max[0])) - Math.min(...items.map((i) => i.min[0]));
  const spanZ = Math.max(...items.map((i) => i.max[2])) - Math.min(...items.map((i) => i.min[2]));
  const axis = spanX >= spanZ ? 0 : 2;
  const sorted = [...items].sort((a, b) => a.min[axis] - b.min[axis]);
  const width = sorted.reduce((sum, i) => sum + (i.max[axis] - i.min[axis]), 0) / sorted.length;
  const groups = [];
  let current = null, reach = -Infinity;
  for (const item of sorted) {
    if (!current || item.min[axis] - reach > width * GAP_RATIO) {
      current = { axis, items: [] };
      groups.push(current);
      reach = -Infinity;
    }
    current.items.push(item);
    reach = Math.max(reach, item.max[axis]);
  }
  return groups;
}

function writeGlb(file, json, bin) {
  const jsonText = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = Buffer.alloc((4 - (jsonText.length % 4)) % 4, 0x20);
  const binPad = Buffer.alloc((4 - (bin.length % 4)) % 4, 0);
  const jsonLen = jsonText.length + jsonPad.length;
  const binLen = bin.length + binPad.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonLen + 8 + binLen, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonLen, 0);
  jsonHeader.writeUInt32LE(JSON_CHUNK, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binLen, 0);
  binHeader.writeUInt32LE(BIN_CHUNK, 4);
  fs.writeFileSync(file, Buffer.concat([header, jsonHeader, jsonText, jsonPad, binHeader, bin, binPad]));
}

export async function splitPack(input, { write = false, outDir = null } = {}) {
  const { json, bin } = loadGlb(input);
  const scene = json.scenes[json.scene || 0];
  const boxes = nodeWorldBoxes(json);
  const roots = (scene.nodes || [])
    .map((index) => ({ index, ...boxes.get(index) }))
    .filter((n) => Number.isFinite(n.min?.[0]));

  // A Sketchfab-exportok egyetlen gyökérrel kezdenek, és a tényleges
  // alkatrészek több szinttel lejjebb vannak (Sketchfab_model -> root ->
  // GLTF_SceneRootNode -> ...). Ezért addig ereszkedünk, amíg a fa el nem
  // ágazik: az első olyan szint kell, ahol több, geometriát hordozó testvér van.
  // Ha elágazásig kell ereszkedni, MEGJEGYEZZÜK az elágazó szülőt. A mély
  // node-okat nem szabad jelenet-gyökérré előléptetni: a glTF-ben egy node-nak
  // legfeljebb egy szülője lehet, és a kiválasztott node a szülője
  // `children` listájában is bent maradna — a gltfpack ezt visszautasítja
  // (kilépési kód 2). Ehelyett a szülő gyereklistáját szűkítjük, így az ősök
  // transzformációi is megmaradnak.
  let branchParent = null;
  if (roots.length < 2) {
    let current = roots[0]?.index ?? (scene.nodes || [])[0];
    for (let depth = 0; depth < 12 && current !== undefined; depth++) {
      const children = (json.nodes[current]?.children || [])
        .map((index) => ({ index, ...boxes.get(index) }))
        .filter((n) => Number.isFinite(n.min?.[0]));
      if (children.length >= 2) {
        branchParent = current;
        roots.length = 0;
        roots.push(...children);
        break;
      }
      current = children[0]?.index;
    }
    if (roots.length < 2) return { groups: [], reason: 'nem találtam több különálló objektumot' };
  }

  const groups = groupByGaps(roots);
  const target = outDir || path.join(path.dirname(input), `${path.basename(input, '.glb')}_split`);
  const result = { groups: [], target };

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const min = [0, 1, 2].map((k) => Math.min(...g.items.map((n) => n.min[k])));
    const max = [0, 1, 2].map((k) => Math.max(...g.items.map((n) => n.max[k])));
    const size = [0, 1, 2].map((k) => +(max[k] - min[k]).toFixed(2));
    result.groups.push({ index: i, nodes: g.items.length, size, min: min.map((v) => +v.toFixed(2)) });
    if (!write) continue;

    fs.mkdirSync(target, { recursive: true });
    const copy = JSON.parse(JSON.stringify(json));
    const keep = g.items.map((n) => n.index);
    if (branchParent === null) {
      copy.scenes = [{ nodes: keep }];
      copy.scene = 0;
    } else {
      copy.nodes[branchParent].children = keep;
    }
    const raw = path.join(target, `.${i}.raw.glb`);
    writeGlb(raw, copy, bin);

    // A gltfpack építi újra a puffert, és dob el mindent, amire nincs
    // hivatkozás — enélkül minden darab a teljes pack bináris blokkját vinné.
    const gltfpack = await ensureGltfpack();
    const out = path.join(target, `${i}.glb`);
    // Lebegőpontos attribútumok: a szétvágás köztes lépés, itt még semmit nem
    // akarunk veszíteni. A kvantálás a végleges konvertálás dolga
    // (cars:compress), és a `-vtf` ott is kell, különben a textúra elcsúszik.
    const run = spawnSync(gltfpack, ['-i', raw, '-o', out, '-kn', '-km', '-vpf', '-vtf', '-vnf'], { windowsHide: true });
    fs.rmSync(raw, { force: true });
    if (run.status !== 0) { result.groups[i].error = `gltfpack kilépési kód ${run.status}`; continue; }
    result.groups[i].bytes = fs.statSync(out).size;
  }
  return result;
}

if (process.argv[1] && process.argv[1].endsWith('split-car-pack.mjs')) {
  const input = process.argv[2];
  if (!input) { console.error('Használat: node tools/split-car-pack.mjs <pack.glb> [--write]'); process.exit(1); }
  const r = await splitPack(input, { write: process.argv.includes('--write') });
  if (r.reason) { console.log(r.reason); process.exit(0); }
  console.log(`talált csoport: ${r.groups.length}`);
  for (const g of r.groups) {
    console.log(`  ${String(g.index).padStart(2)}  node ${String(g.nodes).padStart(3)}  méret ${g.size.join(' x ')}`
      + (g.bytes ? `  -> ${(g.bytes / 1048576).toFixed(1)} MB` : '') + (g.error ? `  HIBA: ${g.error}` : ''));
  }
  if (r.groups.some((g) => g.bytes)) console.log(`\nkiírva ide: ${r.target}`);
}
