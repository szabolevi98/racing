// Teljes, csak olvasható asset-ellenőrzés helyi gépre és deploy előtti futásra.
// A nagy modellek gitignore-osak, ezért ez a parancs olyan munkapéldányban
// értelmes, ahol a teljes autó-, pálya- és környezetkészlet is jelen van.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PIPELINE_VERSION, sourceSignature } from './build-remote-cars.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS_DIR = path.join(ROOT, 'web', 'assets');
const CARS_DIR = path.join(ASSETS_DIR, 'cars');
const COMPRESSED_DIR = path.join(CARS_DIR, 'compressed');
const MASTERS_DIR = path.join(ROOT, 'car-masters');
const MAPS_DIR = path.join(ASSETS_DIR, 'maps');
const SKYBOX_DIR = path.join(ASSETS_DIR, 'skybox');
const IGNORED_DIRS = /^(not_used|[_.].*)$/i;
const COLLISION_MAGIC = 0xc0111505;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const errors = [];
const warnings = [];
const jsonCache = new Map();

const reportError = (scope, message) => errors.push(`${scope}: ${message}`);
const reportWarning = (scope, message) => warnings.push(`${scope}: ${message}`);

async function exists(file) {
  try { await fs.stat(file); return true; } catch { return false; }
}

async function listFiles(dir, extension = null) {
  try {
    return (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && (!extension || entry.name.toLowerCase().endsWith(extension)))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function listActiveDirs(dir) {
  try {
    return (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !IGNORED_DIRS.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function walkJson(dir) {
  const out = [];
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walkJson(file));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) out.push(file);
  }
  return out;
}

async function readJson(file, scope = path.relative(ROOT, file)) {
  if (jsonCache.has(file)) return jsonCache.get(file);
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    jsonCache.set(file, value);
    return value;
  } catch (error) {
    reportError(scope, `hibás JSON (${error.message})`);
    jsonCache.set(file, null);
    return null;
  }
}

function idsFromGlbs(files) {
  return files.filter((file) => file.toLowerCase().endsWith('.glb')).map((file) => file.slice(0, -4));
}

export function setDifference(left, right) {
  const known = new Set(right);
  return left.filter((value) => !known.has(value));
}

function compareIds(actual, expected, scope) {
  for (const id of setDifference(expected, actual)) reportError(scope, `hiányzik: ${id}.glb`);
  for (const id of setDifference(actual, expected)) reportError(scope, `árva fájl: ${id}.glb`);
}

const finite = (value) => Number.isFinite(Number(value));

export function validSpawn(point) {
  return !!point && finite(point.x) && finite(point.z)
    && (point.heading === undefined || finite(point.heading));
}

export function validGate(gate) {
  if (!gate || !['x1', 'z1', 'x2', 'z2'].every((key) => finite(gate[key]))) return false;
  return Number(gate.x1) !== Number(gate.x2) || Number(gate.z1) !== Number(gate.z2);
}

async function verifyGlbHeader(file, scope) {
  let handle;
  try {
    const stat = await fs.stat(file);
    if (stat.size < 12) throw new Error('12 bájtnál rövidebb fájl');
    handle = await fs.open(file, 'r');
    const header = Buffer.alloc(12);
    await handle.read(header, 0, header.length, 0);
    if (header.readUInt32LE(0) !== 0x46546c67) throw new Error('hiányzó glTF magic');
    if (header.readUInt32LE(4) !== 2) throw new Error(`nem támogatott GLB-verzió: ${header.readUInt32LE(4)}`);
    if (header.readUInt32LE(8) !== stat.size) {
      throw new Error(`fejléc szerinti méret ${header.readUInt32LE(8)}, tényleges méret ${stat.size}`);
    }
  } catch (error) {
    reportError(scope, `érvénytelen GLB (${error.message})`);
  } finally {
    await handle?.close();
  }
}

async function readUInt32Pair(handle, offset, size) {
  if (offset + 8 > size) throw new Error(`csonka fejléc a(z) ${offset}. bájtnál`);
  const pair = Buffer.alloc(8);
  await handle.read(pair, 0, pair.length, offset);
  return [pair.readUInt32LE(0), pair.readUInt32LE(4)];
}

export async function validateCollisionFile(file) {
  const stat = await fs.stat(file);
  const handle = await fs.open(file, 'r');
  try {
    if (stat.size < 20) throw new Error('túl rövid fájl');
    const magic = Buffer.alloc(4);
    await handle.read(magic, 0, magic.length, 0);
    if (magic.readUInt32LE(0) !== COLLISION_MAGIC) throw new Error('hibás vagy régi magic fejléc');
    const [floorVerts, floorIndices] = await readUInt32Pair(handle, 4, stat.size);
    if (!floorVerts || !floorIndices || floorIndices % 3) throw new Error('hibás talajháló-darabszám');
    const floorEnd = 12 + floorVerts * 12 + floorIndices * 4;
    const [wallVerts, wallIndices] = await readUInt32Pair(handle, floorEnd, stat.size);
    if (wallIndices % 3) throw new Error('a falháló indexszáma nem osztható hárommal');
    if ((!wallVerts) !== (!wallIndices)) throw new Error('félkész falháló');
    const expected = floorEnd + 8 + wallVerts * 12 + wallIndices * 4;
    if (expected !== stat.size) throw new Error(`méreteltérés: várt ${expected}, kapott ${stat.size} bájt`);
  } finally {
    await handle.close();
  }
}

async function verifyPng(file, scope) {
  try {
    const handle = await fs.open(file, 'r');
    try {
      const signature = Buffer.alloc(8);
      const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
      if (bytesRead !== 8 || !signature.equals(PNG_SIGNATURE)) throw new Error('hibás PNG-fejléc');
    } finally {
      await handle.close();
    }
  } catch (error) {
    reportError(scope, error.message);
  }
}

async function mapLimit(items, limit, task) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) break;
      await task(items[index], index);
    }
  });
  await Promise.all(workers);
}

async function verifyPipelineManifest({ file, ids, sourceFile, outputFile, targetMb, scope }) {
  const manifest = await readJson(file, scope);
  if (!manifest) return;
  if (manifest.version !== PIPELINE_VERSION) {
    reportError(scope, `pipeline-verzió ${manifest.version}, elvárt ${PIPELINE_VERSION}`);
  }
  if (manifest.targetMb !== targetMb) reportError(scope, `célméret ${manifest.targetMb} MB, elvárt ${targetMb} MB`);
  const manifestIds = Object.keys(manifest.cars || {}).sort();
  compareIds(manifestIds, ids, `${scope} bejegyzései`);
  const targetBytes = Math.floor(targetMb * 1024 * 1024);

  await mapLimit(ids, 4, async (id) => {
    const entry = manifest.cars?.[id];
    if (!entry) return;
    const source = sourceFile(id);
    const output = outputFile(id);
    try {
      const [sourceStat, outputStat] = await Promise.all([fs.stat(source), fs.stat(output)]);
      if (outputStat.size > targetBytes) {
        reportError(scope, `${id}: ${(outputStat.size / 1048576).toFixed(2)} MB, a limit ${targetMb} MB`);
      }
      if (entry.bytes !== outputStat.size) reportError(scope, `${id}: a manifest kimeneti mérete elavult`);
      if (entry.sourceBytes !== sourceStat.size) reportError(scope, `${id}: a manifest forrásmérete elavult`);
      const signature = await sourceSignature(source, sourceStat.size, targetBytes);
      if (entry.signature !== signature) reportError(scope, `${id}: a forrás változott, generáld újra a modellt`);
    } catch (error) {
      reportError(scope, `${id}: ${error.message}`);
    }
  });
}

async function verifyCars() {
  const primaryFiles = await listFiles(CARS_DIR, '.glb');
  const compressedFiles = await listFiles(COMPRESSED_DIR, '.glb');
  const masterFiles = await listFiles(MASTERS_DIR, '.glb');
  const primaryIds = idsFromGlbs(primaryFiles);
  const compressedIds = idsFromGlbs(compressedFiles);
  const masterIds = idsFromGlbs(masterFiles);
  if (!primaryIds.length) reportError('Autók', 'nincs egyetlen játékosmodell sem');
  compareIds(compressedIds, primaryIds, 'Compressed autók');
  for (const id of setDifference(masterIds, primaryIds)) reportError('Master autók', `árva master: ${id}.glb`);

  for (const file of [...primaryFiles.map((name) => path.join(CARS_DIR, name)),
    ...compressedFiles.map((name) => path.join(COMPRESSED_DIR, name)),
    ...masterFiles.map((name) => path.join(MASTERS_DIR, name))]) {
    await verifyGlbHeader(file, path.relative(ROOT, file));
  }

  const configFiles = (await listFiles(CARS_DIR, '.json')).filter((file) => file !== 'manifest.json');
  for (const configFile of configFiles) {
    const id = configFile.slice(0, -5);
    const scope = `Autókonfig ${id}`;
    if (!primaryIds.includes(id)) reportError(scope, 'nincs hozzá azonos nevű GLB');
    const config = await readJson(path.join(CARS_DIR, configFile), scope);
    if (!config) continue;
    if (config.yawDegrees !== undefined && !finite(config.yawDegrees)) reportError(scope, 'a yawDegrees nem véges szám');
    if (config.wheelPattern !== undefined) {
      if (typeof config.wheelPattern !== 'string' || !config.wheelPattern.trim()) {
        reportError(scope, 'a wheelPattern nem üres szöveg legyen');
      } else {
        try { new RegExp(config.wheelPattern, 'i'); } catch (error) {
          reportError(scope, `hibás wheelPattern reguláris kifejezés (${error.message})`);
        }
      }
    }
  }

  await verifyPipelineManifest({
    file: path.join(COMPRESSED_DIR, 'manifest.json'), ids: primaryIds, targetMb: 5,
    sourceFile: (id) => masterIds.includes(id) ? path.join(MASTERS_DIR, `${id}.glb`) : path.join(CARS_DIR, `${id}.glb`),
    outputFile: (id) => path.join(COMPRESSED_DIR, `${id}.glb`), scope: 'Compressed manifest',
  });
  await verifyPipelineManifest({
    file: path.join(MASTERS_DIR, 'manifest.json'), ids: masterIds, targetMb: 15,
    sourceFile: (id) => path.join(MASTERS_DIR, `${id}.glb`),
    outputFile: (id) => path.join(CARS_DIR, `${id}.glb`), scope: 'Master manifest',
  });
  return { primary: primaryIds.length, compressed: compressedIds.length, masters: masterIds.length };
}

function validateSpawnValue(value, scope) {
  if (!validSpawn(value)) reportError(scope, 'x, z és heading mezői véges számok legyenek');
}

function validateGateValue(value, scope) {
  if (!validGate(value)) reportError(scope, 'hibás vagy nulla hosszúságú vonal');
}

async function verifyMap(id) {
  const dir = path.join(MAPS_DIR, id);
  const files = await listFiles(dir);
  const glbs = files.filter((file) => file.toLowerCase().endsWith('.glb'));
  const hasGltf = files.includes('scene.gltf');
  if (!hasGltf && !glbs.length) reportError(`Pálya ${id}`, 'hiányzó scene.gltf vagy GLB');
  if (!hasGltf && glbs.length > 1) reportWarning(`Pálya ${id}`, `több GLB van, a szerver az elsőt választja: ${glbs.join(', ')}`);
  for (const glb of glbs) await verifyGlbHeader(path.join(dir, glb), `Pálya ${id}/${glb}`);

  if (hasGltf) {
    const gltf = await readJson(path.join(dir, 'scene.gltf'), `Pálya ${id}/scene.gltf`);
    for (const buffer of gltf?.buffers || []) {
      if (typeof buffer.uri === 'string' && !/^(data:|https?:)/i.test(buffer.uri)
        && !await exists(path.resolve(dir, buffer.uri))) {
        reportError(`Pálya ${id}`, `hiányzó glTF buffer: ${buffer.uri}`);
      }
    }
  }

  const spawnFile = path.join(dir, 'spawn.json');
  const spawns = await readJson(spawnFile, `Pálya ${id}/spawn.json`);
  if (!Array.isArray(spawns) || spawns.length !== 8) reportError(`Pálya ${id}/spawn.json`, 'pontosan 8 rajtpont szükséges');
  else spawns.forEach((spawn, index) => validateSpawnValue(spawn, `Pálya ${id}/spawn.json #${index + 1}`));

  const gates = await readJson(path.join(dir, 'gates.json'), `Pálya ${id}/gates.json`);
  if (!gates) {
    reportError(`Pálya ${id}`, 'hiányzó gates.json');
  } else {
    validateGateValue(gates.start, `Pálya ${id}/gates.json start`);
    if (!Array.isArray(gates.checkpoints) || !gates.checkpoints.length) {
      reportError(`Pálya ${id}/gates.json`, 'legalább egy checkpoint szükséges');
    } else gates.checkpoints.forEach((gate, index) => validateGateValue(gate, `Pálya ${id}/gates.json checkpoint #${index + 1}`));
  }

  const hotLapFile = path.join(dir, 'hotlap_spawn.json');
  if (await exists(hotLapFile)) validateSpawnValue(await readJson(hotLapFile, `Pálya ${id}/hotlap_spawn.json`), `Pálya ${id}/hotlap_spawn.json`);

  const pitFile = path.join(dir, 'pit.json');
  if (await exists(pitFile)) {
    const pit = await readJson(pitFile, `Pálya ${id}/pit.json`);
    if (pit) {
      for (const key of ['entries', 'exits']) {
        if (!Array.isArray(pit[key])) reportError(`Pálya ${id}/pit.json`, `${key} nem tömb`);
        else pit[key].forEach((gate, index) => validateGateValue(gate, `Pálya ${id}/pit.json ${key} #${index + 1}`));
      }
      if (!Array.isArray(pit.stops)) reportError(`Pálya ${id}/pit.json`, 'stops nem tömb');
      else pit.stops.forEach((stop, index) => validateSpawnValue(stop, `Pálya ${id}/pit.json stop #${index + 1}`));
      const complete = pit.entries?.length > 0 && pit.exits?.length > 0 && pit.stops?.length === 8;
      if (!complete) reportWarning(`Pálya ${id}/pit.json`, 'nem teljes boxkonfiguráció; a kötelező kerékcsere inaktív lesz');
    }
  }

  const zonePng = path.join(dir, 'zonemap.png');
  const zoneJson = path.join(dir, 'zonemap.json');
  const hasZonePng = await exists(zonePng);
  const hasZoneJson = await exists(zoneJson);
  if (hasZonePng !== hasZoneJson) reportError(`Pálya ${id}`, 'a zonemap.png és zonemap.json csak együtt használható');
  if (hasZonePng) await verifyPng(zonePng, `Pálya ${id}/zonemap.png`);
  if (hasZoneJson) {
    const zone = await readJson(zoneJson, `Pálya ${id}/zonemap.json`);
    const b = zone?.bounds;
    if (!b || !['minX', 'maxX', 'minZ', 'maxZ'].every((key) => finite(b[key]))
      || !(Number(b.minX) < Number(b.maxX)) || !(Number(b.minZ) < Number(b.maxZ))) {
      reportError(`Pálya ${id}/zonemap.json`, 'hibás bounds');
    }
    for (const key of ['texW', 'texH']) {
      if (zone?.[key] != null && (!Number.isInteger(Number(zone[key])) || Number(zone[key]) <= 0)) {
        reportError(`Pálya ${id}/zonemap.json`, `${key} pozitív egész legyen`);
      }
    }
  }

  const collisionFile = path.join(dir, 'collision.bin');
  if (!await exists(collisionFile)) reportError(`Pálya ${id}`, 'hiányzó collision.bin; multiplayer nem indulhat');
  else {
    try { await validateCollisionFile(collisionFile); } catch (error) {
      reportError(`Pálya ${id}/collision.bin`, error.message);
    }
  }

  const alertFile = path.join(dir, 'alert.json');
  if (await exists(alertFile)) {
    const alert = await readJson(alertFile, `Pálya ${id}/alert.json`);
    if (alert && (!['success', 'warning', 'danger'].includes(String(alert.type).toLowerCase())
      || typeof alert.message !== 'string' || !alert.message.trim())) {
      reportError(`Pálya ${id}/alert.json`, 'type: success/warning/danger és nem üres message szükséges');
    }
  }
}

async function verifyMaps() {
  const ids = await listActiveDirs(MAPS_DIR);
  if (!ids.length) reportError('Pályák', 'nincs aktív pálya');
  for (const id of ids) await verifyMap(id);
  return ids.length;
}

async function verifySkyboxes() {
  const ids = await listActiveDirs(SKYBOX_DIR);
  if (!ids.length) reportError('Környezetek', 'nincs aktív HDR/EXR környezet');
  for (const id of ids) {
    const dir = path.join(SKYBOX_DIR, id);
    const files = (await listFiles(dir)).filter((file) => /\.(hdr|exr)$/i.test(file));
    if (!files.length) reportError(`Környezet ${id}`, 'hiányzó HDR vagy EXR');
    if (files.length > 1) reportWarning(`Környezet ${id}`, `több fájl van, a szerver az elsőt választja: ${files.join(', ')}`);
    for (const file of files) {
      const stat = await fs.stat(path.join(dir, file));
      if (!stat.size) reportError(`Környezet ${id}/${file}`, 'üres fájl');
    }
  }
  return ids.length;
}

export async function verifyAssets() {
  errors.length = 0;
  warnings.length = 0;
  jsonCache.clear();
  console.log('Assetek ellenőrzése (a manifest-aláírások miatt ez néhány másodperc lehet)...');

  for (const file of await walkJson(ASSETS_DIR)) await readJson(file);
  for (const file of await walkJson(MASTERS_DIR)) await readJson(file);

  const cars = await verifyCars();
  const maps = await verifyMaps();
  const skyboxes = await verifySkyboxes();

  console.log(`\nAutók: ${cars.primary} játékos · ${cars.compressed} compressed · ${cars.masters} master`);
  console.log(`Pályák: ${maps} · Környezetek: ${skyboxes}`);
  if (warnings.length) {
    console.log(`\nFigyelmeztetések (${warnings.length}):`);
    warnings.forEach((message) => console.log(`  ⚠ ${message}`));
  }
  if (errors.length) {
    console.error(`\nHibák (${errors.length}):`);
    errors.forEach((message) => console.error(`  ✗ ${message}`));
    process.exitCode = 1;
  } else {
    console.log('\n✓ Minden kötelező asset és konfiguráció rendben van.');
  }
  return { cars, maps, skyboxes, warnings: [...warnings], errors: [...errors] };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await verifyAssets();
