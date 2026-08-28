import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureGltfpack } from './build-remote-cars.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAPS_DIR = path.join(ROOT, 'web', 'assets', 'maps');
const MASTERS_DIR = path.join(ROOT, 'masters', 'maps');
const METADATA_FILE = path.join(MASTERS_DIR, 'manifest.json');

// A növelése minden pályát újrageneráltat. A forrásmodellhez nem nyúlunk:
// abból készül a webroot alatti, letöltésre szánt változat.
export const MAP_PIPELINE_VERSION = 2;
const IGNORED_DIRS = /^(not_used|[_.].*)$/i;
const PACK_ARGS = Object.freeze([
  // Meshopt tömörítés, de attribútum-kvantálás nélkül: a pálya csúcsai és UV-i
  // bitre ugyanazok maradnak, a collision.bin így nem kerül vizuálisan arrébb.
  '-c', '-noq',
  // A futásidejű anyagfelismerés és az objektumnevek maradjanak stabilak.
  '-kn', '-km', '-ke',
  // Szín/adat textúráknál a kis ETC1S, normálmapnál a jobb minőségű UASTC.
  '-tc', 'color,attrib', '-tu', 'normal',
  '-tq', 'color,attrib', '9', '-tq', 'normal', '10',
]);

function parseArgs(argv) {
  const options = { force: false, ids: [] };
  for (const arg of argv) {
    if (arg === '--force') options.force = true;
    else options.ids.push(arg.replace(/\.glb$/i, ''));
  }
  return options;
}

async function exists(file) {
  try { await fs.stat(file); return true; } catch { return false; }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

export function readGlbJson(buffer) {
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== 0x46546c67) {
    throw new Error('Nem érvényes GLB.');
  }
  if (buffer.readUInt32LE(4) !== 2 || buffer.readUInt32LE(8) !== buffer.length) {
    throw new Error('Hibás GLB verzió vagy fájlhossz.');
  }
  const jsonLength = buffer.readUInt32LE(12);
  if (buffer.readUInt32LE(16) !== 0x4e4f534a || 20 + jsonLength > buffer.length) {
    throw new Error('Hiányzó GLB JSON chunk.');
  }
  return JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
}

export async function readGlbFileJson(file) {
  // A pálya akár 200 MB, a strukturális ellenőrzéshez viszont csak a néhány
  // száz KB-os JSON chunk kell. Ne tartsuk a teljes mastert Node memóriában.
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    const header = Buffer.alloc(20);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || header.readUInt32LE(0) !== 0x46546c67) {
      throw new Error('Nem érvényes GLB.');
    }
    if (header.readUInt32LE(4) !== 2 || header.readUInt32LE(8) !== stat.size
      || header.readUInt32LE(16) !== 0x4e4f534a) {
      throw new Error('Hibás GLB verzió, fájlhossz vagy JSON chunk.');
    }
    const jsonLength = header.readUInt32LE(12);
    if (20 + jsonLength > stat.size) throw new Error('Csonka GLB JSON chunk.');
    const json = Buffer.alloc(jsonLength);
    const jsonRead = await handle.read(json, 0, json.length, 20);
    if (jsonRead.bytesRead !== json.length) throw new Error('Csonka GLB JSON chunk.');
    return JSON.parse(json.toString('utf8'));
  } finally {
    await handle.close();
  }
}

export function triangleCount(gltf) {
  let triangles = 0;
  for (const mesh of gltf.meshes || []) {
    for (const primitive of mesh.primitives || []) {
      const accessorIndex = primitive.indices ?? primitive.attributes?.POSITION;
      const count = gltf.accessors?.[accessorIndex]?.count || 0;
      const mode = primitive.mode ?? 4;
      if (mode === 4) triangles += Math.floor(count / 3);
      else if (mode === 5 || mode === 6) triangles += Math.max(0, count - 2);
    }
  }
  return triangles;
}

function indexReader(componentType) {
  if (componentType === 5121) return { bytes: 1, read: (view, offset) => view.getUint8(offset) };
  if (componentType === 5123) return { bytes: 2, read: (view, offset) => view.getUint16(offset, true) };
  if (componentType === 5125) return { bytes: 4, read: (view, offset) => view.getUint32(offset, true) };
  throw new Error(`Nem támogatott index-komponenstípus: ${componentType}.`);
}

async function readExactly(handle, length, position) {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (!bytesRead) throw new Error('Csonka GLB BIN chunk.');
    offset += bytesRead;
  }
  return buffer;
}

// Az objektumvágó a törölt lapokat három azonos indexre csukja össze. Ezek
// továbbra is szerepelnek az accessor számlálójában, de képpontot nem rajzolnak.
// A gltfpack ezeket a láthatatlan lapokat automatikusan eldobja; ezt külön
// megmérjük, hogy valódi pályageometriát véletlenül se fogadjunk el hiányosan.
async function collapsedIndexedTriangleStats(file, gltf = null) {
  const document = gltf || await readGlbFileJson(file);
  const handle = await fs.open(file, 'r');
  try {
    const jsonLengthHeader = await readExactly(handle, 4, 12);
    const jsonLength = jsonLengthHeader.readUInt32LE(0);
    const binHeaderOffset = 20 + jsonLength;
    const binHeader = await readExactly(handle, 8, binHeaderOffset);
    if (binHeader.readUInt32LE(4) !== 0x004e4942) {
      throw new Error('Hiányzó GLB BIN chunk.');
    }
    const binLength = binHeader.readUInt32LE(0);
    const binOffset = binHeaderOffset + 8;
    const cache = new Map();
    let collapsed = 0;
    let fullyCollapsedMeshes = 0;

    for (const mesh of document.meshes || []) {
      let meshTriangles = 0;
      let meshCollapsed = 0;
      for (const primitive of mesh.primitives || []) {
        const mode = primitive.mode ?? 4;
        const accessorIndex = primitive.indices ?? primitive.attributes?.POSITION;
        const primitiveTriangles = mode === 4
          ? Math.floor((document.accessors?.[accessorIndex]?.count || 0) / 3)
          : 0;
        meshTriangles += primitiveTriangles;
        if (mode !== 4 || primitive.indices == null) continue;
        if (cache.has(accessorIndex)) {
          const accessorCollapsed = cache.get(accessorIndex);
          collapsed += accessorCollapsed;
          meshCollapsed += accessorCollapsed;
          continue;
        }
        const accessor = document.accessors?.[accessorIndex];
        const bufferView = document.bufferViews?.[accessor?.bufferView];
        if (!accessor || !bufferView || accessor.type !== 'SCALAR' || accessor.sparse) {
          throw new Error(`Nem ellenőrizhető index accessor: ${accessorIndex}.`);
        }
        if (bufferView.buffer !== 0 || bufferView.extensions?.EXT_meshopt_compression
            || bufferView.extensions?.KHR_meshopt_compression) {
          throw new Error(`Nem nyers GLB index bufferView: ${accessor.bufferView}.`);
        }
        const reader = indexReader(accessor.componentType);
        const stride = bufferView.byteStride || reader.bytes;
        const byteLength = accessor.count > 0 ? (accessor.count - 1) * stride + reader.bytes : 0;
        const viewOffset = accessor.byteOffset || 0;
        if (viewOffset + byteLength > bufferView.byteLength) {
          throw new Error(`Az index accessor túllóg a bufferView-n: ${accessorIndex}.`);
        }
        const relativeOffset = (bufferView.byteOffset || 0) + viewOffset;
        if (relativeOffset + byteLength > binLength) {
          throw new Error(`Az index accessor túllóg a BIN chunkon: ${accessorIndex}.`);
        }
        const data = await readExactly(handle, byteLength, binOffset + relativeOffset);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        let accessorCollapsed = 0;
        for (let index = 0; index + 2 < accessor.count; index += 3) {
          const a = reader.read(view, index * stride);
          const b = reader.read(view, (index + 1) * stride);
          const c = reader.read(view, (index + 2) * stride);
          if (a === b || b === c || a === c) accessorCollapsed++;
        }
        cache.set(accessorIndex, accessorCollapsed);
        collapsed += accessorCollapsed;
        meshCollapsed += accessorCollapsed;
      }
      if (meshTriangles > 0 && meshCollapsed === meshTriangles) fullyCollapsedMeshes++;
    }
    return { triangles: collapsed, fullyCollapsedMeshes };
  } finally {
    await handle.close();
  }
}

export async function collapsedIndexedTriangleCount(file, gltf = null) {
  return (await collapsedIndexedTriangleStats(file, gltf)).triangles;
}

function named(items) {
  return new Set((items || []).map((item) => item.name).filter(Boolean));
}

function assertNamesPreserved(kind, sourceItems, outputItems) {
  const outputNames = named(outputItems);
  const missing = [...named(sourceItems)].filter((name) => !outputNames.has(name));
  if (missing.length) {
    throw new Error(`${kind}: ${missing.length} név elveszett (első: ${missing[0]}).`);
  }
}

function hasExtension(gltf, name) {
  return (gltf.extensionsUsed || []).includes(name)
    || (gltf.extensionsRequired || []).includes(name);
}

export function alreadyOptimized(gltf) {
  return hasExtension(gltf, 'EXT_meshopt_compression')
    || hasExtension(gltf, 'KHR_meshopt_compression')
    || hasExtension(gltf, 'KHR_texture_basisu');
}

// A gltfpack az általa teljesen fedettnek ítélt BLEND textúrákat OPAQUE-ra
// válthatja. Ezeknél a pályáknál azonban a szerző által megadott BLEND egyben
// a fakártyák szemantikája is: ebből ismeri fel őket a kliens, hogy megkapják a
// korábbi mélységi és megvilágítási javítást. A master beállítása ezért
// szerzői adat, nem eldobható optimalizációs részlet.
export function restoreMaterialAlphaSemantics(source, candidate) {
  const sourceByName = new Map((source.materials || [])
    .filter((material) => material.name)
    .map((material) => [material.name, material]));
  let changes = 0;
  for (const material of candidate.materials || []) {
    const original = sourceByName.get(material.name);
    if (!original) continue;

    const sourceMode = original.alphaMode || 'OPAQUE';
    const candidateMode = material.alphaMode || 'OPAQUE';
    if (sourceMode !== candidateMode) {
      if (sourceMode === 'OPAQUE') delete material.alphaMode;
      else material.alphaMode = sourceMode;
      changes++;
    }

    // Az alphaCutoff csak MASK módban számít; a hiánya a glTF szerint 0.5.
    if (sourceMode === 'MASK') {
      const sourceCutoff = original.alphaCutoff ?? 0.5;
      const candidateCutoff = material.alphaCutoff ?? 0.5;
      if (sourceCutoff !== candidateCutoff) {
        if (original.alphaCutoff == null) delete material.alphaCutoff;
        else material.alphaCutoff = original.alphaCutoff;
        changes++;
      }
    }
  }
  return changes;
}

async function rewriteGlbJson(file, document) {
  const input = await fs.readFile(file);
  // A teljes fájlt itt már csak a legfeljebb ~80 MB-os generált jelöltből
  // olvassuk, nem a 200 MB-os masterből. A BIN chunk tartalma bájtra megmarad.
  readGlbJson(input);
  const oldJsonLength = input.readUInt32LE(12);
  const oldTailOffset = 20 + oldJsonLength;
  const json = Buffer.from(JSON.stringify(document));
  const paddedJsonLength = Math.ceil(json.length / 4) * 4;
  const output = Buffer.allocUnsafe(20 + paddedJsonLength + input.length - oldTailOffset);
  input.copy(output, 0, 0, 12);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(paddedJsonLength, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  output.fill(0x20, 20, 20 + paddedJsonLength);
  json.copy(output, 20);
  input.copy(output, 20 + paddedJsonLength, oldTailOffset);
  await fs.writeFile(file, output);
}

async function restoreCandidateMaterialSemantics(sourceFile, candidateFile) {
  const [source, candidate] = await Promise.all([
    readGlbFileJson(sourceFile), readGlbFileJson(candidateFile),
  ]);
  const changes = restoreMaterialAlphaSemantics(source, candidate);
  if (changes) await rewriteGlbJson(candidateFile, candidate);
  return changes;
}

async function hashFile(file) {
  const hash = createHash('sha256');
  const handle = await fs.open(file, 'r');
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      hash.update(chunk.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

export async function mapSourceSignature(file) {
  return `map-v${MAP_PIPELINE_VERSION}:${await hashFile(file)}`;
}

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`gltfpack kilépési kód: ${code}\n${stderr}`));
    });
  });
}

async function sceneFileFor(mapDir) {
  const files = (await fs.readdir(mapDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.glb'))
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('.'))
    .sort();
  if (files.length !== 1) {
    throw new Error(`Pontosan egy GLB kell a pályamappába, talált: ${files.length}.`);
  }
  return files[0];
}

async function ensureMaster(id, runtimeFile, masterFile) {
  if (await exists(masterFile)) return false;
  const runtimeGltf = await readGlbFileJson(runtimeFile);
  if (alreadyOptimized(runtimeGltf)) {
    throw new Error('A runtime GLB már tömörített, de nincs master — ebből nem készítünk újabb veszteséges generációt.');
  }
  await fs.mkdir(path.dirname(masterFile), { recursive: true });
  await fs.copyFile(runtimeFile, masterFile);
  console.log(`  master mentve: masters/maps/${id}/${path.basename(masterFile)}`);
  return true;
}

async function validateCandidate(sourceFile, candidateFile) {
  const [source, candidate] = await Promise.all([
    readGlbFileJson(sourceFile), readGlbFileJson(candidateFile),
  ]);
  if (!hasExtension(candidate, 'EXT_meshopt_compression')
      && !hasExtension(candidate, 'KHR_meshopt_compression')) {
    throw new Error('A kimenetből hiányzik a Meshopt tömörítés.');
  }
  if (!hasExtension(candidate, 'KHR_texture_basisu')) {
    throw new Error('A kimenetből hiányzik a KTX2/Basis textúra.');
  }
  const sourceTriangles = triangleCount(source);
  const outputTriangles = triangleCount(candidate);
  const collapsedStats = sourceTriangles === outputTriangles
    ? { triangles: 0, fullyCollapsedMeshes: 0 }
    : await collapsedIndexedTriangleStats(sourceFile, source);
  const collapsedTriangles = collapsedStats.triangles;
  if (sourceTriangles - collapsedTriangles !== outputTriangles) {
    throw new Error(`A látható háromszögszám megváltozott: ${sourceTriangles} - ${collapsedTriangles} összecsukott → ${outputTriangles}.`);
  }
  const sourceNodes = source.nodes?.length || 0;
  const outputNodes = candidate.nodes?.length || 0;
  const sourceMeshes = source.meshes?.length || 0;
  const outputMeshes = candidate.meshes?.length || 0;
  const sourceMaterials = source.materials?.length || 0;
  const outputMaterials = candidate.materials?.length || 0;
  if (sourceNodes !== outputNodes || sourceMaterials !== outputMaterials
      || outputMeshes > sourceMeshes
      || outputMeshes < sourceMeshes - collapsedStats.fullyCollapsedMeshes) {
    throw new Error(`A node/mesh/material struktúra váratlanul megváltozott: ${sourceNodes}/${sourceMeshes}/${sourceMaterials} → ${outputNodes}/${outputMeshes}/${outputMaterials} (legfeljebb ${collapsedStats.fullyCollapsedMeshes} üres mesh hagyható el).`);
  }
  assertNamesPreserved('Node', source.nodes, candidate.nodes);
  assertNamesPreserved('Anyag', source.materials, candidate.materials);
  const candidateMaterials = new Map((candidate.materials || [])
    .map((material) => [material.name, material]));
  for (const material of source.materials || []) {
    const output = candidateMaterials.get(material.name);
    if (!output) continue;
    const sourceMode = material.alphaMode || 'OPAQUE';
    const outputMode = output.alphaMode || 'OPAQUE';
    const sourceCutoff = sourceMode === 'MASK' ? material.alphaCutoff ?? 0.5 : null;
    const outputCutoff = outputMode === 'MASK' ? output.alphaCutoff ?? 0.5 : null;
    if (sourceMode !== outputMode || sourceCutoff !== outputCutoff) {
      throw new Error(`Az anyag átlátszósága megváltozott: ${material.name}.`);
    }
  }
  return {
    triangles: outputTriangles,
    // Csak akkor tároljuk a különbséget, ha volt korábbi objektumvágás. Így a
    // manifestből is auditálható, pontosan hány eleve láthatatlan lap maradt ki.
    ...(collapsedTriangles ? { sourceTriangles, collapsedTriangles } : {}),
    nodes: source.nodes?.length || 0,
    meshes: source.meshes?.length || 0,
    materials: source.materials?.length || 0,
    textures: source.images?.length || 0,
  };
}

async function replaceRuntime(candidate, runtimeFile) {
  const backup = `${runtimeFile}.pre-optimize-backup`;
  await fs.rm(backup, { force: true });
  await fs.rename(runtimeFile, backup);
  try {
    await fs.rename(candidate, runtimeFile);
  } catch (error) {
    await fs.rename(backup, runtimeFile);
    throw error;
  }
  await fs.rm(backup, { force: true });
}

async function writeMetadata(metadata) {
  const temporary = `${METADATA_FILE}.tmp`;
  await fs.mkdir(MASTERS_DIR, { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`);
  await fs.rename(temporary, METADATA_FILE);
}

async function buildMap(executable, id, options, previous) {
  const mapDir = path.join(MAPS_DIR, id);
  const sceneFile = await sceneFileFor(mapDir);
  const runtimeFile = path.join(mapDir, sceneFile);
  const masterFile = path.join(MASTERS_DIR, id, sceneFile);
  await ensureMaster(id, runtimeFile, masterFile);

  const sourceStat = await fs.stat(masterFile);
  const sourceSignature = await mapSourceSignature(masterFile);
  if (!options.force && previous?.signature === sourceSignature && await exists(runtimeFile)) {
    const runtime = await readGlbFileJson(runtimeFile);
    if (alreadyOptimized(runtime)) {
      const runtimeStat = await fs.stat(runtimeFile);
      console.log(`↷ ${id}: naprakész (${(runtimeStat.size / 1048576).toFixed(1)} MB)`);
      return { metadata: previous, changed: false };
    }
  }

  const candidate = path.join(mapDir, `.${id}.optimize.tmp.glb`);
  const reportFile = path.join(mapDir, `.${id}.optimize.report.json`);
  await fs.rm(candidate, { force: true });
  await fs.rm(reportFile, { force: true });
  const threads = Math.max(1, Math.min(8, os.availableParallelism?.() || os.cpus().length || 1));
  console.log(`${id}: ${(sourceStat.size / 1048576).toFixed(1)} MB optimalizálása…`);
  try {
    await run(executable, [
      '-i', masterFile, '-o', candidate,
      ...PACK_ARGS, '-tj', String(threads), '-r', reportFile,
    ]);
    const restoredMaterials = await restoreCandidateMaterialSemantics(masterFile, candidate);
    const structure = await validateCandidate(masterFile, candidate);
    const candidateStat = await fs.stat(candidate);
    const report = await readJson(reportFile, {});
    await replaceRuntime(candidate, runtimeFile);
    const materialNote = restoredMaterials ? `, ${restoredMaterials} alpha-beállítás visszaállítva` : '';
    console.log(`  ✓ ${(candidateStat.size / 1048576).toFixed(1)} MB, ${structure.triangles.toLocaleString('hu-HU')} háromszög${materialNote}`);
    return {
      changed: true,
      metadata: {
        signature: sourceSignature,
        sourceBytes: sourceStat.size,
        bytes: candidateStat.size,
        ratio: Math.round(candidateStat.size / sourceStat.size * 10000) / 10000,
        ...structure,
        imageBytes: report.data?.buffers?.image ?? null,
        geometryBytes: (report.data?.buffers?.vertex ?? 0) + (report.data?.buffers?.index ?? 0),
      },
    };
  } finally {
    await fs.rm(candidate, { force: true }).catch(() => {});
    await fs.rm(reportFile, { force: true }).catch(() => {});
  }
}

export async function buildMaps(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const available = (await fs.readdir(MAPS_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !IGNORED_DIRS.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const unknown = options.ids.filter((id) => !available.includes(id));
  if (unknown.length) throw new Error(`Ismeretlen vagy inaktív pálya: ${unknown.join(', ')}`);
  const ids = options.ids.length ? options.ids : available;
  if (!ids.length) throw new Error('Nincs feldolgozható pálya.');

  const executable = await ensureGltfpack();
  const metadataExists = await exists(METADATA_FILE);
  const previous = await readJson(METADATA_FILE, { version: MAP_PIPELINE_VERSION, maps: {} });
  const next = {
    version: MAP_PIPELINE_VERSION,
    generatedAt: previous.generatedAt || null,
    settings: { mesh: 'meshopt-no-quantization', texture: 'ktx2-etc1s-q9-uastc-normal-q10' },
    maps: { ...(previous.maps || {}) },
  };
  const failures = [];
  let metadataChanged = !metadataExists;
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index];
    console.log(`\n[${index + 1}/${ids.length}]`);
    try {
      const result = await buildMap(executable, id, options, previous.maps?.[id]);
      next.maps[id] = result.metadata;
      if (result.changed) {
        metadataChanged = true;
        next.generatedAt = new Date().toISOString();
      }
    } catch (error) {
      failures.push({ id, message: error.message });
      console.error(`  ✗ ${id}: ${error.message}`);
    }
    // Egy valódi konverzió után rögtön mentünk, hogy megszakításkor se vesszen
    // el az addigi munka. Tiszta, naprakész futás viszont ne írja át pusztán az
    // időbélyeget és ne okozzon értelmetlen Git-diffet.
    if (metadataChanged) {
      await writeMetadata(next);
      metadataChanged = false;
    }
  }
  if (failures.length) {
    const details = failures.map((failure) => `${failure.id}: ${failure.message}`).join('\n');
    throw new Error(`${failures.length} pálya optimalizálása sikertelen:\n${details}`);
  }
  const selected = ids.map((id) => next.maps[id]);
  const sourceBytes = selected.reduce((sum, map) => sum + map.sourceBytes, 0);
  const outputBytes = selected.reduce((sum, map) => sum + map.bytes, 0);
  console.log(`\nKész: ${ids.length} pálya, ${(sourceBytes / 1048576).toFixed(1)} → ${(outputBytes / 1048576).toFixed(1)} MB.`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await buildMaps();
