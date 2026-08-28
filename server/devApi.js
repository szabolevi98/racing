// Fejlesztői mentő végpontok: a dev módban szerkesztett rajtrács és Hot Lap-
// rajtpont, kapuk, boxutca, zóna-maszk, ütközési háló és sütési beállítások
// kiírása a pálya mappájába.
//
// (A korábbi assets/save_*.php fájlok portja.)
//
// FIGYELEM: ezek mögött nincs jogosultság-ellenőrzés, és a lemezre írnak.
// Éles kiszolgálón kapcsold ki: ALLOW_DEV_WRITES=0 a .env-ben.
import rawFs from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ASSETS_DIR, MAP_MASTERS_DIR } from './paths.js';
import { invalidateManifest } from './assets.js';

const MAP_ID_RE = /^[a-zA-Z0-9_-]+$/;

function validMapId(mapId) {
  if (!MAP_ID_RE.test(mapId || '')) {
    const e = new Error('Érvénytelen mapId.');
    e.status = 400;
    throw e;
  }
  return mapId;
}

async function mapDirOf(mapId) {
  validMapId(mapId);
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

// A master nagy (akár 200 MB), ezért streameljük, nem olvassuk egyben a Node
// memóriájába. A hívó csak a manifestből származó fájlnevet adhatja át; a
// basename-ellenőrzés és a fix masters/maps gyökér kizárja a könyvtárbejárást.
export async function serveMapMaster(req, res, mapId, fileName) {
  validMapId(mapId);
  if (path.basename(fileName || '') !== fileName || !/\.glb$/i.test(fileName)) {
    const e = new Error('Érvénytelen master fájlnév.');
    e.status = 400;
    throw e;
  }
  const file = path.join(MAP_MASTERS_DIR, mapId, fileName);
  let stat;
  try {
    stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error();
  } catch {
    const e = new Error('Ehhez a pályához nincs master modell.');
    e.status = 404;
    throw e;
  }
  res.writeHead(200, {
    'Content-Type': 'model/gltf-binary',
    'Content-Length': stat.size,
    // A kliens a manifestből kap verziózott URL-t. Devben is cache-elhető, de
    // nem immutable: kézi mastercsere után egy újraindítás biztosan ellenőrizze.
    'Cache-Control': 'private, no-cache, must-revalidate',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const stream = rawFs.createReadStream(file);
    stream.on('error', reject);
    res.on('finish', resolve);
    res.on('close', resolve);
    stream.pipe(res);
  });
}

const round2 = (v) => Math.round(Number(v) * 100) / 100;

function cleanSpawnPoint(point) {
  if (!point || point.x === undefined || point.z === undefined) return null;
  const x = Number(point.x);
  const z = Number(point.z);
  const heading = Number(point.heading);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return {
    x: round2(x),
    z: round2(z),
    heading: Number.isFinite(heading) ? Math.round(heading * 1e4) / 1e4 : 0,
  };
}

export async function saveSpawn(body) {
  const dir = await mapDirOf(body?.mapId);
  if (!Array.isArray(body?.spawns)) {
    const e = new Error('Hiányzó spawns.');
    e.status = 400;
    throw e;
  }
  const spawns = body.spawns
    .slice(0, 8)
    .map(cleanSpawnPoint)
    .filter(Boolean);
  await fs.writeFile(path.join(dir, 'spawn.json'), JSON.stringify(spawns, null, 2) + '\n');

  let hotLapSpawn = null;
  if (Object.hasOwn(body, 'hotLapSpawn')) {
    hotLapSpawn = cleanSpawnPoint(body.hotLapSpawn);
    const hotLapFile = path.join(dir, 'hotlap_spawn.json');
    if (hotLapSpawn) {
      await fs.writeFile(hotLapFile, JSON.stringify(hotLapSpawn, null, 2) + '\n');
    } else {
      await fs.unlink(hotLapFile).catch((err) => {
        if (err?.code !== 'ENOENT') throw err;
      });
    }
  }
  invalidateManifest();
  return { ok: true, count: spawns.length, hasHotLapSpawn: !!hotLapSpawn };
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

export async function savePit(body) {
  const dir = await mapDirOf(body?.mapId);
  const gate = (g) =>
    g && ['x1', 'z1', 'x2', 'z2'].every((key) => Number.isFinite(Number(g[key])))
      ? { x1: round2(g.x1), z1: round2(g.z1), x2: round2(g.x2), z2: round2(g.z2) }
      : null;
  const out = {
    entries: Array.isArray(body?.entries) ? body.entries.map(gate).filter(Boolean) : [],
    exits: Array.isArray(body?.exits) ? body.exits.map(gate).filter(Boolean) : [],
    stops: Array.isArray(body?.stops)
      ? body.stops.slice(0, 8).map(cleanSpawnPoint).filter(Boolean)
      : [],
  };
  await fs.writeFile(path.join(dir, 'pit.json'), JSON.stringify(out, null, 2) + '\n');
  invalidateManifest();
  return {
    ok: true,
    entries: out.entries.length,
    exits: out.exits.length,
    stops: out.stops.length,
    complete: out.entries.length > 0 && out.exits.length > 0 && out.stops.length === 8,
  };
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

// A sütés beállításainak megőrzése a pálya mappájában (bake.json).
//
// Miért fájlba: a sütés kapcsolói eddig csak jelölőnégyzetek voltak, az
// állapotuk a sütés után elveszett — egy meglévő collision.bin-ről senki nem
// tudta megmondani, milyen beállításokkal készült, és újrasütéskor fejből
// kellett visszaállítani. Így viszont a döntés a pályával együtt utazik és
// bekerül a gitbe (a collision.bin maga gitignore-olt).
//
// Az aszfalt-simítás ezért pályánként külön kapcsolható: csak néhány modellnél
// hullámos maga az aszfalt, a többit szándékosan érintetlenül hagyjuk.
export async function saveBakeConfig(body) {
  const dir = await mapDirOf(body?.mapId);
  const b = body?.config || {};
  const num = (v, min, max, def) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
  };
  const out = {
    _megjegyzes:
      'Az ütközési háló sütésének beállításai. A dev mód "Ütközés bekészítése" gombja írja, ' +
      'és pálya kiválasztásakor vissza is tölti — így egy újrasütés ugyanazt adja.',
    debrisFilter: b.debrisFilter !== false,
    kerbSmoothing: b.kerbSmoothing !== false,
    canopy: {
      enabled: b.canopy?.enabled !== false,
      minHeight: num(b.canopy?.minHeight, 1, 60, 10),
    },
    asphaltSmoothing: {
      // Alapból KI: csak azokon a pályákon kell, ahol maga az aszfalt hullámos.
      enabled: b.asphaltSmoothing?.enabled === true,
      iterations: num(b.asphaltSmoothing?.iterations, 1, 10, 4),
      // A sugár a legerősebb paraméter — az ennél rövidebb hullámot veszi ki.
      // Mérve (Red Bull Ring, törésszög mediánja): 1.5 m → 0.44°, 3 m → 0.17°,
      // 5 m → 0.16°. Az 5 m már nem javít, viszont többet mozgat, ezért 3 az alap.
      radius: num(b.asphaltSmoothing?.radius, 0.5, 8, 3),
    },
  };
  await fs.writeFile(path.join(dir, 'bake.json'), JSON.stringify(out, null, 2) + '\n');
  return { ok: true, config: out };
}
