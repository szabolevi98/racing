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

// Az ütközési háló nyers bináris: [uint32 vertexCount][uint32 indexCount]
// [float32 * 3 * vertexCount][uint32 * indexCount]. A fejlécet ellenőrizzük,
// hogy egy csonka feltöltés ne írjon felül egy jó fájlt.
export async function saveCollision(mapId, buf) {
  const dir = await mapDirOf(mapId);
  if (!buf || buf.length < 8) {
    const e = new Error('Üres vagy hibás törzs.');
    e.status = 400;
    throw e;
  }
  const verts = buf.readUInt32LE(0);
  const indices = buf.readUInt32LE(4);
  const expected = 8 + verts * 12 + indices * 4;
  if (expected !== buf.length) {
    const e = new Error(`Méret-eltérés: várt ${expected}, kapott ${buf.length}.`);
    e.status = 400;
    throw e;
  }
  await fs.writeFile(path.join(dir, 'collision.bin'), buf);
  invalidateManifest();
  return { ok: true, verts, indices, bytes: buf.length };
}
