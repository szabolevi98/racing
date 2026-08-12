import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARS_DIR = path.join(ROOT, 'web', 'assets', 'cars');
const OUTPUT_DIR = path.join(CARS_DIR, 'compressed');
// A gltfpack binárist a repóban tartjuk (tools/vendor/), nem eldobható
// gyorsítótárban: így a konvertálás hálózat nélkül is fut, és nem függ attól,
// hogy a GitHub-kiadás elérhető marad-e. A verzió a mappanévben van, hogy
// verzióváltásnál ne keveredjen a régivel.
const VENDOR_DIR = path.join(ROOT, 'tools', 'vendor', 'gltfpack', 'v1.2');
const METADATA_FILE = path.join(OUTPUT_DIR, 'manifest.json');
const PIPELINE_VERSION = 1;
const DEFAULT_TARGET_MB = 5;

const RELEASES = {
  'win32-x64': {
    archive: 'gltfpack-windows.zip',
    sha256: '52e0c061d8b42f1c6bd8fe1cbc1e26a9da579ad5a4f5dd30a8ee0d599062f6c4',
    executable: 'gltfpack.exe',
  },
  'linux-x64': {
    archive: 'gltfpack-ubuntu.zip',
    sha256: 'ebc236f5f6c08c7e5c5750476a187d24805d44d8c680449c4b7369c333f817b1',
    executable: 'gltfpack',
  },
  'darwin-x64': {
    archive: 'gltfpack-macos-intel.zip',
    sha256: 'bcbd379f212552a84ca19fc986750ce8a4c3fd6c13344df6dbcff7bbf6bc121c',
    executable: 'gltfpack',
  },
  'darwin-arm64': {
    archive: 'gltfpack-macos.zip',
    sha256: '9f5288a6ad585bef3befbc2907c9f9b9fdeeb0b5a29eaa57f0fe15521b82eb28',
    executable: 'gltfpack',
  },
};

// Minőségi sorrend: az első, célméretbe beleférő eredmény győz. Így egy
// eleve kulturált modellhez alig nyúlunk, a túlméretezett Sketchfab-exportoknál
// pedig csak annyira erősítünk, amennyire az 5 MB-os remote limit megkívánja.
export const REMOTE_CAR_PROFILES = Object.freeze([
  { name: 'lossless', ratio: 1, error: 0.001, quality: 10, textureLimit: 4096 },
  { name: 'very-high', ratio: 0.85, error: 0.002, quality: 10, textureLimit: 2048 },
  { name: 'high', ratio: 0.75, error: 0.003, quality: 9, textureLimit: 2048 },
  { name: 'balanced-high', ratio: 0.65, error: 0.006, quality: 9, textureLimit: 1024 },
  { name: 'balanced', ratio: 0.5, error: 0.01, quality: 8, textureLimit: 1024 },
  { name: 'medium', ratio: 0.35, error: 0.015, quality: 8, textureLimit: 1024 },
  { name: 'compact', ratio: 0.25, error: 0.02, quality: 7, textureLimit: 1024 },
  { name: 'very-compact', ratio: 0.18, error: 0.03, quality: 7, textureLimit: 768 },
  { name: 'emergency', ratio: 0.1, error: 0.06, quality: 6, textureLimit: 512, aggressive: true },
  { name: 'last-resort', ratio: 0.06, error: 0.1, quality: 5, textureLimit: 384, aggressive: true },
]);

function run(executable, args, { quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: ROOT,
      windowsHide: true,
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '', stderr = '';
    if (quiet) {
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
    }
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(executable)} kilépési kód: ${code}\n${stderr}`));
    });
  });
}

async function fileExists(file) {
  try { await fs.stat(file); return true; } catch { return false; }
}

async function download(url, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'Levente-Racing-asset-builder' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  throw new Error(`gltfpack letöltési hiba ${attempts} próbálkozás után: ${lastError.message}`);
}

async function ensureGltfpack() {
  const release = RELEASES[`${process.platform}-${process.arch}`];
  if (!release) throw new Error(`Nem támogatott platform: ${process.platform}-${process.arch}`);
  const executable = path.join(VENDOR_DIR, release.executable);
  if (await fileExists(executable)) return executable;

  await fs.mkdir(VENDOR_DIR, { recursive: true });
  const archive = path.join(VENDOR_DIR, release.archive);
  const url = `https://github.com/zeux/meshoptimizer/releases/download/v1.2/${release.archive}`;
  let bytes = await fileExists(archive) ? await fs.readFile(archive) : null;
  let digest = bytes ? createHash('sha256').update(bytes).digest('hex') : null;
  if (digest !== release.sha256) {
    console.log(`gltfpack v1.2 letöltése: ${release.archive}`);
    try {
      bytes = await download(url);
      await fs.writeFile(archive, bytes);
    } catch (error) {
      // A GitHub CDN néha lezárja a Node fetch TLS-kapcsolatát Windows alatt;
      // a rendszer curlje ilyenkor megbízható tartalék, ugyanazzal a hash-ellenőrzéssel.
      await run('curl', ['-L', '--fail', '--retry', '3', '-o', archive, url], { quiet: true });
      bytes = await fs.readFile(archive);
    }
    digest = createHash('sha256').update(bytes).digest('hex');
  }
  if (digest !== release.sha256) throw new Error(`gltfpack SHA-256 eltérés: ${digest}`);

  if (process.platform === 'win32') {
    await run('tar.exe', ['-xf', archive, '-C', VENDOR_DIR], { quiet: true });
  } else {
    await run('unzip', ['-o', archive, '-d', VENDOR_DIR], { quiet: true });
    await fs.chmod(executable, 0o755);
  }
  if (!await fileExists(executable)) throw new Error('A gltfpack kicsomagolása nem sikerült.');
  return executable;
}

function readGlbJson(buffer) {
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== 0x46546c67) {
    throw new Error('Az eredmény nem érvényes GLB.');
  }
  if (buffer.readUInt32LE(4) !== 2 || buffer.readUInt32LE(8) !== buffer.length) {
    throw new Error('Hibás GLB fejléc vagy fájlhossz.');
  }
  const jsonLength = buffer.readUInt32LE(12);
  if (buffer.readUInt32LE(16) !== 0x4e4f534a || 20 + jsonLength > buffer.length) {
    throw new Error('Hiányzó GLB JSON chunk.');
  }
  return JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
}

function namedValues(gltf) {
  return [gltf.nodes, gltf.meshes, gltf.materials]
    .flatMap((items) => (items || []).map((item) => item.name).filter(Boolean));
}

async function validateCandidate(input, output, config, targetBytes) {
  const [sourceBuffer, outputBuffer] = await Promise.all([fs.readFile(input), fs.readFile(output)]);
  if (outputBuffer.length > targetBytes) throw new Error('Az eredmény nagyobb a célméretnél.');
  const source = readGlbJson(sourceBuffer);
  const candidate = readGlbJson(outputBuffer);
  if (!(candidate.scenes?.length && candidate.nodes?.length && candidate.meshes?.length)) {
    throw new Error('Az eredményből hiányzik a renderelhető jelenet.');
  }

  // -kn és -km megőrzi a futásidejű kerékfelismeréshez szükséges neveket. A
  // generikus Object_N mesh-neveket a gltfpack joggal eldobhatja, ezért nem
  // várjuk el az összes forrásnév 1:1 meglétét, csak a wheelPattern találatát.
  if (config?.wheelPattern) {
    const wheelRegex = new RegExp(config.wheelPattern, 'i');
    if (!namedValues(candidate).some((name) => wheelRegex.test(name))) {
      throw new Error('A wheelPattern már nem talál kereket az eredményben.');
    }
  }
  return outputBuffer.length;
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

// Az aláírás dönti el, kell-e újrakonvertálni. A forrás TARTALMÁBÓL képezzük,
// nem a módosítási idejéből.
//
// Az mtime azért volt rossz alap, mert a git nem őrzi meg: friss klón vagy egy
// másik gépről átmásolt GLB mind a checkout idejét kapja, tehát a
// nyilvántartás ott egyetlen konvertálást sem spórolt volna meg. A tartalom
// viszont ugyanaz marad, bárhonnan is jött a fájl — a commitolt manifest így
// tényleg használható más gépen is.
//
// Az ár elenyésző: a teljes, 2,7 GB-os készlet hashelése 6 másodperc, miközben
// egyetlen autó konvertálása is percekben mérhető. A méret ugyan majdnem
// mindig változik szerkesztéskor, de a "majdnem" itt csendes hibát jelentene:
// egy azonos méretű újraexportot nem vennénk észre.
export async function sourceSignature(input, sourceBytes, targetBytes) {
  const hash = createHash('sha256');
  const handle = await fs.open(input, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return `v2:${PIPELINE_VERSION}:${sourceBytes}:${targetBytes}:${hash.digest('hex')}`;
}

// Átmenet a régi, mtime-alapú aláírásról: `<pipeline>:<méret>:<mtime>:<cél>`.
//
// Enélkül a formátumváltás egyszerűen elavulttá tenne minden bejegyzést, és
// mind a 183 autó újrakonvertálódna — pedig a kész fájlok érvényesek. Ha a
// méret és a célméret egyezik, elfogadjuk a meglévő kimenetet, és csak az
// aláírást írjuk át az új formára.
export function legacySignatureMatches(previousSignature, sourceBytes, targetBytes) {
  const parts = String(previousSignature || '').split(':');
  if (parts.length !== 4 || parts[0] === 'v2') return false;
  return Number(parts[1]) === sourceBytes && Number(parts[3]) === targetBytes;
}

function parseArgs(argv) {
  const options = { force: false, targetMb: DEFAULT_TARGET_MB, ids: [] };
  for (const arg of argv) {
    if (arg === '--force') options.force = true;
    else if (arg.startsWith('--target-mb=')) options.targetMb = Number(arg.slice(12));
    else options.ids.push(arg.replace(/\.glb$/i, ''));
  }
  if (!(options.targetMb > 0)) throw new Error('A --target-mb pozitív szám legyen.');
  return options;
}

async function buildCar(executable, file, options, previous) {
  const id = file.replace(/\.glb$/i, '');
  const input = path.join(CARS_DIR, file);
  const output = path.join(OUTPUT_DIR, file);
  const sourceStat = await fs.stat(input);
  const targetBytes = Math.floor(options.targetMb * 1024 * 1024);
  const signature = await sourceSignature(input, sourceStat.size, targetBytes);
  const reusable = previous
    && (previous.signature === signature
      || legacySignatureMatches(previous.signature, sourceStat.size, targetBytes));
  if (!options.force && reusable && await fileExists(output)) {
    const outputStat = await fs.stat(output);
    if (outputStat.size <= targetBytes) {
      console.log(`↷ ${id}: naprakész (${(outputStat.size / 1024 / 1024).toFixed(2)} MB)`);
      // Régi formátumú bejegyzésnél az aláírást frissítjük, konvertálás nélkül:
      // a kimenet érvényes, csak a nyilvántartás formája avult el.
      return previous.signature === signature ? previous : { ...previous, signature };
    }
  }

  const config = await readJson(path.join(CARS_DIR, `${id}.json`));
  console.log(`\n${id}: ${(sourceStat.size / 1024 / 1024).toFixed(2)} MB → legfeljebb ${options.targetMb} MB`);
  if (sourceStat.size <= targetBytes) {
    await fs.copyFile(input, `${output}.tmp`);
    await validateCandidate(input, `${output}.tmp`, config, targetBytes);
    await fs.copyFile(`${output}.tmp`, output);
    await fs.unlink(`${output}.tmp`);
    console.log(`  ✓ eredeti minőség, másolva (${(sourceStat.size / 1024 / 1024).toFixed(2)} MB)`);
    return { signature, profile: 'copy', bytes: sourceStat.size, sourceBytes: sourceStat.size };
  }

  let smallest = null;
  for (const profile of REMOTE_CAR_PROFILES) {
    const candidate = path.join(OUTPUT_DIR, `.${id}.${profile.name}.tmp.glb`);
    const reportFile = path.join(OUTPUT_DIR, `.${id}.${profile.name}.report.json`);
    await fs.rm(candidate, { force: true });
    await fs.rm(reportFile, { force: true });
    const args = [
      '-i', input, '-o', candidate,
      '-kn', '-km', '-sp', '-vt', '16',
      '-si', String(profile.ratio), '-se', String(profile.error),
      '-tw', '-tq', String(profile.quality), '-tl', String(profile.textureLimit),
      '-r', reportFile,
    ];
    if (profile.aggressive) args.push('-sa');
    await run(executable, args, { quiet: true });
    const stat = await fs.stat(candidate);
    const mb = stat.size / 1024 / 1024;
    console.log(`  ${profile.name.padEnd(14)} ${mb.toFixed(2)} MB`);
    if (!smallest || stat.size < smallest.bytes) smallest = { file: candidate, bytes: stat.size };
    if (stat.size <= targetBytes) {
      await validateCandidate(input, candidate, config, targetBytes);
      const report = await readJson(reportFile, {});
      await fs.copyFile(candidate, output);
      for (const item of await fs.readdir(OUTPUT_DIR)) {
        if (item.startsWith(`.${id}.`) && (item.endsWith('.tmp.glb') || item.endsWith('.report.json'))) {
          await fs.rm(path.join(OUTPUT_DIR, item), { force: true });
        }
      }
      console.log(`  ✓ ${profile.name}, ${report.render?.triangleCount?.toLocaleString('hu-HU') || '?'} háromszög`);
      return {
        signature,
        profile: profile.name,
        bytes: stat.size,
        sourceBytes: sourceStat.size,
        triangles: report.render?.triangleCount ?? null,
      };
    }
  }
  throw new Error(`${id}: egyik profil sem fért ${options.targetMb} MB alá (minimum ${(smallest.bytes / 1024 / 1024).toFixed(2)} MB).`);
}

export async function buildRemoteCars(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const files = (await fs.readdir(CARS_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.glb'))
    .map((entry) => entry.name)
    .filter((file) => !file.toLowerCase().endsWith('_compressed.glb'))
    .filter((file) => !options.ids.length || options.ids.includes(file.replace(/\.glb$/i, '')))
    .sort();
  if (!files.length) throw new Error('Nincs feldolgozható autó a megadott szűréssel.');

  const executable = await ensureGltfpack();
  const metadata = await readJson(METADATA_FILE, { version: PIPELINE_VERSION, cars: {} });
  const next = { version: PIPELINE_VERSION, targetMb: options.targetMb, generatedAt: new Date().toISOString(), cars: { ...metadata.cars } };
  const failures = [];
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const id = file.replace(/\.glb$/i, '');
    console.log(`\n[${index + 1}/${files.length}]`);
    try {
      next.cars[id] = await buildCar(executable, file, options, metadata.cars?.[id]);
      await fs.writeFile(METADATA_FILE, `${JSON.stringify(next, null, 2)}\n`);
    } catch (error) {
      failures.push({ id, error: error.message });
      console.error(`  ✗ ${error.message}`);
    }
  }

  if (failures.length) {
    console.error(`\n${failures.length} autó konvertálása sikertelen.`);
    process.exitCode = 1;
  } else {
    const total = Object.values(next.cars).reduce((sum, car) => sum + (car.bytes || 0), 0);
    console.log(`\nKész: ${files.length} autó, összesen ${(total / 1024 / 1024).toFixed(1)} MB a compressed mappában.`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await buildRemoteCars();
