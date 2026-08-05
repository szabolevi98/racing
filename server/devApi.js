// Fejlesztői mentő végpontok: a dev módban rajzolt rajtrács, kapuk,
// zóna-maszk és ütközési háló kiírása a pálya mappájába.
//
// (A korábbi assets/save_*.php fájlok portja.)
//
// FIGYELEM: ezek mögött nincs jogosultság-ellenőrzés, és a lemezre írnak.
// Éles kiszolgálón kapcsold ki: ALLOW_DEV_WRITES=0 a .env-ben.
import fs from 'node:fs/promises';
import path from 'node:path';
import { ASSETS_DIR } from './paths.js';
import { invalidateManifest } from './assets.js';

const MAP_ID_RE = /^[a-zA-Z0-9_-]+$/;

async function mapDirOf(mapId) {
  if (!MAP_ID_RE.test(mapId || '')) {
    const e = new Error('Érvénytelen mapId.');
    e.status = 400;
    throw e;
  }
  const dir = path.join(ASSETS_DIR, 'maps', mapId);
  try {
    const st = await fs.stat(dir);
    if (!st.isDirectory()) throw new Error();
  } catch {
    const e = new Error('Nincs ilyen pálya mappa: ' + mapId);
    e.status = 404;
    throw e;
  }
  return dir;
}

const round2 = (v) => Math.round(Number(v) * 100) / 100;

export async function saveSpawn(body) {
  const dir = await mapDirOf(body?.mapId);
  if (!Array.isArray(body?.spawns)) {
    const e = new Error('Hiányzó spawns.');
    e.status = 400;
    throw e;
  }
  const spawns = body.spawns
    .slice(0, 8)
    .filter((p) => p && p.x !== undefined && p.z !== undefined)
    .map((p) => ({
      x: round2(p.x),
      z: round2(p.z),
      heading: Math.round((Number(p.heading) || 0) * 1e4) / 1e4,
    }));
  await fs.writeFile(path.join(dir, 'spawn.json'), JSON.stringify(spawns, null, 2) + '\n');
  invalidateManifest();
  return { ok: true, count: spawns.length };
}

export async function saveGates(body) {
  const dir = await mapDirOf(body?.mapId);
  const gate = (g) =>
    g && ['x1', 'z1', 'x2', 'z2'].every((k) => g[k] !== undefined)
      ? { x1: round2(g.x1), z1: round2(g.z1), x2: round2(g.x2), z2: round2(g.z2) }
      : null;
  const out = {
    start: gate(body?.start),
    checkpoints: Array.isArray(body?.checkpoints) ? body.checkpoints.map(gate).filter(Boolean) : [],
  };
  await fs.writeFile(path.join(dir, 'gates.json'), JSON.stringify(out, null, 2) + '\n');
  invalidateManifest();
  return { ok: true, checkpoints: out.checkpoints.length, hasStart: !!out.start };
}

export async function saveZonemap(body) {
  const dir = await mapDirOf(body?.mapId);
  const m = /^data:image\/png;base64,(.+)$/.exec(body?.pngBase64 || '');
  if (!m) {
    const e = new Error('A pngBase64 nem érvényes PNG data URL.');
    e.status = 400;
    throw e;
  }
  if (!body?.bounds) {
    const e = new Error('Hiányzó bounds.');
    e.status = 400;
    throw e;
  }
  const png = Buffer.from(m[1], 'base64');
  await fs.writeFile(path.join(dir, 'zonemap.png'), png);
  await fs.writeFile(
    path.join(dir, 'zonemap.json'),
    JSON.stringify({ bounds: body.bounds, texW: body.texW ?? null, texH: body.texH ?? null }, null, 2) + '\n'
  );
  invalidateManifest();
  return { ok: true, bytes: png.length };
}

// Az ütközési háló nyers bináris (v2, két háló): [uint32 magic]
// [uint32 floorVertexCount][uint32 floorIndexCount]
// [float32 * 3 * floorVertexCount][uint32 * floorIndexCount]
// [uint32 wallVertexCount][uint32 wallIndexCount]
// [float32 * 3 * wallVertexCount][uint32 * wallIndexCount].
//
// A magic egy olyan érték, ami sosem lehetne valódi (régi formátumú)
// vertexCount — így egy régi, egyhálós fájl feltöltése hangosan elbukik itt,
// nem csendben íródik felül félreértett tartalommal.
const COLLISION_MAGIC = 0xc0111505;

function readMeshHeader(buf, offset) {
  if (buf.length < offset + 8) {
    const e = new Error('Csonka fejléc.');
    e.status = 400;
    throw e;
  }
  const verts = buf.readUInt32LE(offset);
  const indices = buf.readUInt32LE(offset + 4);
  const bodyEnd = offset + 8 + verts * 12 + indices * 4;
  if (bodyEnd > buf.length) {
    const e = new Error(`Méret-eltérés: várt legalább ${bodyEnd} bájt, kapott ${buf.length}.`);
    e.status = 400;
    throw e;
  }
  return { verts, indices, bodyEnd };
}

export async function saveCollision(mapId, buf) {
  const dir = await mapDirOf(mapId);
  if (!buf || buf.length < 4 || buf.readUInt32LE(0) !== COLLISION_MAGIC) {
    const e = new Error(
      'Érvénytelen vagy régi formátumú ütközési fájl (hiányzó magic fejléc) — süsd be újra a Fejlesztői eszközökből.'
    );
    e.status = 400;
    throw e;
  }
  const floor = readMeshHeader(buf, 4);
  const wall = readMeshHeader(buf, floor.bodyEnd);
  if (wall.bodyEnd !== buf.length) {
    const e = new Error(`Méret-eltérés: várt pontosan ${wall.bodyEnd} bájt, kapott ${buf.length}.`);
    e.status = 400;
    throw e;
  }
  await fs.writeFile(path.join(dir, 'collision.bin'), buf);
  invalidateManifest();
  return {
    ok: true,
    floorVerts: floor.verts, floorIndices: floor.indices,
    wallVerts: wall.verts, wallIndices: wall.indices,
    bytes: buf.length,
  };
}
