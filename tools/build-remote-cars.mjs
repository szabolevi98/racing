import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARS_DIR = path.join(ROOT, 'web', 'assets', 'cars');
const COMPRESSED_DIR = path.join(CARS_DIR, 'compressed');
// A teljes minőségű források szándékosan a webrooton kívül vannak: a játék és
// a publikus statikus kiszolgáló csak a 15 MB-os és az 5 MB-os változatot látja.
const MASTERS_DIR = path.join(ROOT, 'car-masters');
// A gltfpack binárist a repóban tartjuk (tools/vendor/), nem eldobható
// gyorsítótárban: így a konvertálás hálózat nélkül is fut, és nem függ attól,
// hogy a GitHub-kiadás elérhető marad-e. A verzió a mappanévben van, hogy
// verzióváltásnál ne keveredjen a régivel.
const VENDOR_DIR = path.join(ROOT, 'tools', 'vendor', 'gltfpack', 'v1.2');
// A növelése minden autót újrakonvertáltat: nem a forrás avult el, hanem a
// konvertálás módja.
//   2: a `-sp` már nem jár alanyi jogon minden futásnak (elcsúszó textúrák).
//   3: a geometria- és textúra-tengely külön mérése, kár szerint sorolt fokok.
//   4: float UV (`-vtf`) a kvantálás helyett — a gltfpack a saját
//      KHR_texture_transform-jával felülírta a forrásét, és 71 autó
//      textúrája csúszott el tőle.
export const PIPELINE_VERSION = 4;
const DEFAULT_TARGET_MB = 5;
const DEFAULT_PRIMARY_TARGET_MB = 15;
const DEFAULT_MASTER_THRESHOLD_MB = 20;

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

// Két FÜGGETLEN minőségi skála, nem egy összefűzött profil-létra.
//
// A korábbi megoldás egyetlen listát járt be, ahol minden fok egyszerre mondott
// geometria- és textúra-értéket. Ez azért rossz, mert autónként más a szűk
// keresztmetszet: a BMW 320i-nél a kép 3,25 MB és a geometria 1,71, a Porsche
// 911 GT1-nél pont fordítva (1,68 / 4,41). A kötegelt fokok emiatt mindkét
// autónál levágták azt is, ami nem szorított — a Porsche fele felbontású
// textúrát kapott, pedig nála nem a textúra volt a nagy tétel.
//
// Így viszont a kereső minden lépés előtt megnézi a gltfpack riportjából, hol
// vannak ténylegesen a bájtok, és csak azon az oldalon lép egyet. Lásd
// pickSettings().
// A `cost` az elvesztett látványminőség egy közös, önkényes skálán — azért
// kell, mert a két tengely nem hasonlítható össze bájtban. Egy 4096-os textúra
// felezése egy 20 méterre lévő ellenfélautón észrevehetetlen (cost 1), a
// háromszögek harmadolása viszont a sziluettet rontja el (cost 8). A kereső
// ezen a skálán választ, lásd planSettings().
// A fokok a KÁR mértéke szerint követik egymást, nem az arány szerint. Ezért
// fordulhat elő, hogy egy későbbi fok arányszáma nagyobb: egy varratokon is
// átvágó 50% kevesebbet ront, mint egy erőszakkal levágott 18%.
export const GEOMETRY_STEPS = Object.freeze([
  { ratio: 1, error: 0.001, cost: 0 },
  { ratio: 0.85, error: 0.002, cost: 1 },
  { ratio: 0.75, error: 0.003, cost: 2 },
  { ratio: 0.65, error: 0.006, cost: 3 },
  { ratio: 0.5, error: 0.01, cost: 5 },
  { ratio: 0.35, error: 0.02, cost: 8 },
  { ratio: 0.25, error: 0.04, cost: 11 },
  { ratio: 0.18, error: 0.06, cost: 14 },
  // A `-sp` innentől engedi a varratokon átnyúló összevonást, amitől a textúra
  // kissé elcsúszhat. Nem tiltott, csak lefokozott: seam-sűrű modelleknél a
  // fenti fokok elakadnak (a hibakorlát fog előbb, nem az arány), és ott az
  // alternatíva nem a szép textúra, hanem a szétvágott sziluett.
  { ratio: 0.5, error: 0.01, permissive: true, cost: 17 },
  { ratio: 0.35, error: 0.02, permissive: true, cost: 19 },
  { ratio: 0.25, error: 0.04, permissive: true, cost: 21 },
  { ratio: 0.15, error: 0.08, permissive: true, cost: 24 },
  // Végső eszköz. A gltfpack saját szava rá: "disregarding quality".
  { ratio: 0.12, error: 0.1, aggressive: true, cost: 30 },
  { ratio: 0.06, error: 0.15, aggressive: true, cost: 34 },
]);

// A felbontás előbbre való a kódolási minőségnél: egy 2048-as textúra q7-en
// még olvasható rajtszámot és feliratot ad, a 1024-re zsugorított q9 viszont
// már visszahozhatatlanul elvesztette a részletet. Ezért megyünk végig a
// 2048-as fokokon, mielőtt felezünk.
export const TEXTURE_STEPS = Object.freeze([
  { limit: 4096, quality: 10, cost: 0 },
  { limit: 2048, quality: 9, cost: 1 },
  { limit: 2048, quality: 8, cost: 2 },
  { limit: 2048, quality: 7, cost: 4 },
  { limit: 1024, quality: 8, cost: 7 },
  { limit: 1024, quality: 7, cost: 9 },
  { limit: 768, quality: 7, cost: 13 },
  { limit: 512, quality: 6, cost: 17 },
  { limit: 384, quality: 5, cost: 21 },
]);

const PRIMARY_PRESERVED_TEXTURE = Object.freeze({ preserve: true, cost: 0 });
const PRIMARY_WEBP_Q10 = Object.freeze({ limit: 4096, quality: 10, cost: 1 });
const PRIMARY_WEBP_Q9 = Object.freeze({ limit: 4096, quality: 9, cost: 2 });

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

export async function ensureGltfpack() {
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
  // A régi alak első mezője a pipeline verziója. Ha az azóta változott, a kész
  // fájl AKKOR SEM érvényes, ha a forrás egy bájtot sem mozdult — nem a forrás
  // avult el, hanem a konvertálás módja. Enélkül a `-sp` kivétele után 130 autó
  // csendben megtartotta a régi, elcsúszott textúrájú kimenetét.
  if (Number(parts[0]) !== PIPELINE_VERSION) return false;
  return Number(parts[1]) === sourceBytes && Number(parts[3]) === targetBytes;
}

function parseArgs(argv) {
  const options = { force: false, primary: false, targetMb: null, masterThresholdMb: DEFAULT_MASTER_THRESHOLD_MB, ids: [] };
  for (const arg of argv) {
    if (arg === '--force') options.force = true;
    else if (arg === '--primary') options.primary = true;
    else if (arg.startsWith('--target-mb=')) options.targetMb = Number(arg.slice(12));
    else if (arg.startsWith('--master-threshold-mb=')) options.masterThresholdMb = Number(arg.slice(22));
    else options.ids.push(arg.replace(/\.glb$/i, ''));
  }
  options.targetMb ??= options.primary ? DEFAULT_PRIMARY_TARGET_MB : DEFAULT_TARGET_MB;
  if (!(options.targetMb > 0)) throw new Error('A --target-mb pozitív szám legyen.');
  if (!(options.masterThresholdMb > options.targetMb)) throw new Error('--master-threshold-mb must exceed --target-mb.');
  return options;
}

function describeSettings({ geometry, texture }) {
  const mode = geometry.aggressive ? ' erőszakolt' : geometry.permissive ? ' varratokon át' : '';
  const textureLabel = texture.preserve ? 'eredeti textúra' : `textúra ${texture.limit}/q${texture.quality}`;
  return `geometria ${Math.round(geometry.ratio * 100)}%${mode} · ${textureLabel}`;
}

// Windowson a frissen írt fájlt a víruskereső (vagy maga a kilépő gltfpack)
// még egy pillanatig fogja, és a törlés EBUSY-val elszáll. Ez nem a
// konvertálás hibája, ezért nem is buktathat el egy autót — csak várunk rá.
async function removeWithRetry(file, { required = false } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rm(file, { force: true });
      return true;
    } catch (error) {
      if (attempt >= 6) {
        if (required) throw error;
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
    }
  }
}

async function cleanTempFiles(id, outputDir) {
  const stuck = [];
  for (const item of await fs.readdir(outputDir)) {
    if (item.startsWith(`.${id}.`) && (item.endsWith('.tmp.glb') || item.endsWith('.report.json'))) {
      // A takarítás bukása nem érvényteleníti a kész kimenetet: csak szemét
      // marad, amit a következő futás úgyis felülír.
      if (!await removeWithRetry(path.join(outputDir, item))) stuck.push(item);
    }
  }
  if (stuck.length) console.warn(`  ⚠ ${stuck.length} ideiglenes fájl zárolva maradt, a következő futás felülírja`);
}

// Egy gltfpack-futás. A riportot is beolvassa, mert abból derül ki, hogy a
// bájtok a képekben vagy a geometriában ülnek — a kereső ezen a mérésen dönt.
async function packOnce(executable, { id, input, outputDir, geometry, texture }) {
  // A mód is bekerül, mert ugyanaz az arány több fokon is előfordul (normál és
  // permisszív) — enélkül a két futás egymás ideiglenes fájljára írna.
  const mode = geometry.aggressive ? 'a' : geometry.permissive ? 'p' : 'n';
  const textureTag = texture.preserve ? 'source' : `${texture.limit}q${texture.quality}`;
  const tag = `g${mode}${geometry.ratio}-t${textureTag}`;
  const candidate = path.join(outputDir, `.${id}.${tag}.tmp.glb`);
  const reportFile = path.join(outputDir, `.${id}.${tag}.report.json`);
  // Itt viszont muszáj eltűnnie: egy bent ragadt riportból a kereső a MÚLTKORI
  // méreteket olvasná ki, és arra tervezne.
  await removeWithRetry(candidate, { required: true });
  await removeWithRetry(reportFile, { required: true });
  // NINCS `-sp`: az "attribute discontinuity" a gltfpack szótárában az
  // UV-varrat, a permisszív mód pedig engedélyt ad az egyszerűsítőnek, hogy
  // azokon átnyúlva vonjon össze csúcsokat — ettől csúszik el a textúra a
  // modellen. Mérve a négy legerősebben tömörített autón: az elhagyása
  // +0,2…1,2% méret, és a célarányt nélküle is eléri (80 504 helyett 81 263
  // háromszög). Ennyiért nem éri meg.
  //
  // `-vtf` (float UV) a korábbi `-vt 16` helyett. A gltfpack a kvantált UV-t
  // egy általa GYÁRTOTT KHR_texture_transform-mal állítja vissza — de ha az
  // anyagnak MÁR VOLT saját ilyen transzformja, azt felülírja ahelyett, hogy
  // összefűzné a kettőt. A forrás-anyag skálázása és eltolása így elveszik.
  //
  // Mérve az 1999-es Viper karosszériáján (`body.007`): az eredeti transzform
  // offset [0.0017, -0.048] / scale [0.05, 0.05] helyére offset
  // [1.994, -138.818] / scale [0.863, 0.964] került, az UV-doboz 131,88
  // egységgel csúszott el. Csempézett textúránál egész eltolás láthatatlan
  // lenne, ez viszont tört (~0,88), tehát a kép szemmel láthatóan elmászik.
  // Ugyanennek a modellnek a saját transzform nélküli anyagai hibátlanok
  // voltak — pontosan az különbözteti meg a rossz eseteket.
  //
  // A 183 autóból 71 használ KHR_texture_transform-ot a forrásban, tehát a
  // kvantálás megtartása mellett ennyi lenne veszélyben. `-vtf`-fel az
  // UV-dobozok legnagyobb eltérése 131,88-ról 0,0004-re esett (float-kerekítés).
  // Ára ezen az autón +12,5% méret (4,65 → 5,23 MB).
  const args = [
    '-i', input, '-o', candidate,
    '-kn', '-km', '-vtf',
    '-si', String(geometry.ratio), '-se', String(geometry.error),
    '-r', reportFile,
  ];
  if (!texture.preserve) args.push('-tw', '-tq', String(texture.quality), '-tl', String(texture.limit));
  if (geometry.permissive) args.push('-sp');
  if (geometry.aggressive) args.push('-sa');
  await run(executable, args, { quiet: true });
  const stat = await fs.stat(candidate);
  const report = await readJson(reportFile, {});
  const buffers = report.data?.buffers || {};
  return {
    file: candidate,
    bytes: stat.size,
    geometry,
    texture,
    triangles: report.render?.triangleCount ?? null,
    imageBytes: buffers.image ?? 0,
    geometryBytes: (buffers.vertex ?? 0) + (buffers.index ?? 0),
  };
}

// A rács kiszámítása mérésekből.
//
// A két tengely FÜGGETLEN: a geometria aránya nem befolyásolja a textúrák
// méretét és fordítva. Ez nem feltételezés, hanem a riportokból leolvasható —
// a Porschénál a kép végig pontosan 2,20 MB maradt, miközben a geometria
// 5,13-ról 1,94-re csökkent; a BMW-nél a geometria végig 2,19, miközben a kép
// 4,17-ről 2,36-ra ment.
//
// Ezért nem kell tapogatózni. Elég mindkét tengelyt EGYSZER végigmérni (a
// másikat közben a legolcsóbb fokon tartva), utána a teljes 10×9-es rács
// minden cellája ismert egy összeadással. Ebből választjuk a legkisebb
// minőségvesztésű cellát, ami befér.
//
// Ez azért többet ér egy lépegető keresőnél, mert az mohó: mindig a pillanatnyi
// legjobb lépést teszi, és nem tudja, hány lépés kell még — így túllő. A
// Porschét 35%-ra vágta (107 ezer háromszög), pedig 65% is befért volna
// (201 ezer), csak egy fokkal olcsóbb textúra mellett.
export function planSettings(imageBytes, geometryBytes, overheadBytes, targetBytes, rejected = new Set()) {
  let best = null;
  for (let g = 0; g < GEOMETRY_STEPS.length; g++) {
    for (let t = 0; t < TEXTURE_STEPS.length; t++) {
      if (rejected.has(`${g}:${t}`)) continue;
      // A meg nem mért fokok kimaradnak: azokat a kereső bizonyítottan
      // fölöslegesnek találta (lásd a mérés leállítását pickSettings-ben).
      if (imageBytes[t] === undefined || geometryBytes[g] === undefined) continue;
      if (overheadBytes + imageBytes[t] + geometryBytes[g] > targetBytes) continue;
      const cost = GEOMETRY_STEPS[g].cost + TEXTURE_STEPS[t].cost;
      // Azonos áron a több háromszög nyer: a sziluett messziről is látszik.
      if (!best || cost < best.cost || (cost === best.cost && g < best.g)) best = { g, t, cost };
    }
  }
  return best;
}

async function pickSettings(executable, { id, input, outputDir, targetBytes }) {
  const mb = (n) => (n / 1024 / 1024).toFixed(2);
  const show = (r) => console.log(`  ${describeSettings(r).padEnd(36)} ${mb(r.bytes)} MB  (kép ${mb(r.imageBytes)} · geo ${mb(r.geometryBytes)})`);
  const pack = (g, t) => packOnce(executable, { id, input, outputDir, geometry: GEOMETRY_STEPS[g], texture: TEXTURE_STEPS[t] });
  const lastG = GEOMETRY_STEPS.length - 1, lastT = TEXTURE_STEPS.length - 1;

  // A legtöbb autó a legjobb beállítással is befér — annak egyetlen futás elég.
  const finest = await pack(0, 0);
  show(finest);
  if (finest.bytes <= targetBytes) return withLimit(finest);

  // A fejrész (JSON, minták, egyéb pufferek) nagyjából állandó. A legfinomabb
  // futásból vesszük, mert ott a legtöbb a node és így a legnagyobb a JSON —
  // a becslés inkább legyen óvatos, mint optimista.
  const overhead = Math.max(0, finest.bytes - finest.imageBytes - finest.geometryBytes);

  // Tengelyenkénti mérés. A másik tengelyt közben a legolcsóbb fokon tartjuk:
  // azok a futások a leggyorsabbak, és a két tengely függetlensége miatt az
  // eredményt úgysem befolyásolják.
  //
  // A mérést ott hagyjuk abba, ahol bizonyítottan fölösleges. Ha egy fok a
  // MÁSIK tengely legjobb beállításával is befér, akkor minden nála durvább fok
  // szigorúan drágább egy már beférő cellánál — azt sosem választanánk. Így a
  // legtöbb autónál a 17 mérőfutás töredéke is elég.
  const imageBytes = [finest.imageBytes];
  const geometryBytes = [finest.geometryBytes];
  let probes = 0;
  for (let t = 1; t <= lastT; t++) {
    if (overhead + imageBytes[t - 1] + finest.geometryBytes <= targetBytes) break;
    imageBytes[t] = (await pack(lastG, t)).imageBytes;
    probes++;
  }
  for (let g = 1; g <= lastG; g++) {
    if (overhead + finest.imageBytes + geometryBytes[g - 1] <= targetBytes) break;
    geometryBytes[g] = (await pack(g, lastT)).geometryBytes;
    probes++;
  }
  console.log(`  ${String(probes).padStart(2)} mérőfutás: kép ${mb(imageBytes.at(-1))}–${mb(imageBytes[0])} MB · geometria ${mb(geometryBytes.at(-1))}–${mb(geometryBytes[0])} MB`);
  if (process.env.DEBUG_PLAN) {
    console.log('    kép:', imageBytes.map((n) => mb(n)).join(' '));
    console.log('    geo:', geometryBytes.map((n) => mb(n)).join(' '));
    console.log('    fejrész:', mb(overhead), '· cél:', mb(targetBytes));
  }

  // A becslés nem tökéletes (a kvantálás kerekít), ezért a tervet leellenőrizzük,
  // és ha mégsem fér be, a következő legolcsóbb cellát vesszük.
  const rejected = new Set();
  for (;;) {
    const plan = planSettings(imageBytes, geometryBytes, overhead, targetBytes, rejected);
    if (!plan) {
      const floor = overhead + imageBytes.at(-1) + geometryBytes.at(-1);
      throw new Error(`${id}: a legerősebb beállítással sem fért be (minimum ${mb(floor)} MB).`);
    }
    const result = await pack(plan.g, plan.t);
    show(result);
    if (result.bytes <= targetBytes) return withLimit(result);
    // A becslés optimista volt erre a cellára — kizárjuk, és jöhet a következő
    // legolcsóbb. A mért tengelyeket NEM írjuk át: azok pontosak, csak a
    // fejrész-becslés csúszott.
    rejected.add(`${plan.g}:${plan.t}`);
  }
}

async function pickPrimarySettings(executable, { id, input, outputDir, targetBytes }) {
  const mb = (n) => (n / 1024 / 1024).toFixed(2);
  // A sorrend szándékos, és a három jóváhagyott próbamodellt reprodukálja:
  // 1) teljes geometria + forrástextúra; 2) enyhe geometriai egyszerűsítés;
  // 3) csak ezután WebP, ha azzal több geometria őrizhető meg.
  const trials = [
    { geometry: GEOMETRY_STEPS[0], texture: PRIMARY_PRESERVED_TEXTURE },
    { geometry: GEOMETRY_STEPS[1], texture: PRIMARY_PRESERVED_TEXTURE },
    { geometry: GEOMETRY_STEPS[0], texture: PRIMARY_WEBP_Q10 },
    { geometry: GEOMETRY_STEPS[2], texture: PRIMARY_PRESERVED_TEXTURE },
    { geometry: GEOMETRY_STEPS[0], texture: PRIMARY_WEBP_Q9 },
  ];
  for (const trial of trials) {
    const result = await packOnce(executable, { id, input, outputDir, ...trial });
    console.log(`  ${describeSettings(result).padEnd(36)} ${mb(result.bytes)} MB`);
    if (result.bytes <= targetBytes) return withLimit(result);
  }
  // Ritka, különösen nagy/nehéz modell: innen a teljes adaptív kereső veszi át,
  // ugyanazzal a minőségköltség-alapú döntéssel, mint a remote modelleknél.
  return pickSettings(executable, { id, input, outputDir, targetBytes });
}

function withLimit(result) {
  return { ...result, limitedBy: result.imageBytes > result.geometryBytes ? 'textúra' : 'geometria' };
}

async function buildCar(executable, file, options, previous, { sourceDir, outputDir }) {
  const id = file.replace(/\.glb$/i, '');
  const master = path.join(MASTERS_DIR, file);
  const input = !options.primary && await fileExists(master) ? master : path.join(sourceDir, file);
  const output = path.join(outputDir, file);
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
    return { signature, copied: true, bytes: sourceStat.size, sourceBytes: sourceStat.size };
  }

  let found;
  try {
    found = options.primary
      ? await pickPrimarySettings(executable, { id, input, outputDir, targetBytes })
      : await pickSettings(executable, { id, input, outputDir, targetBytes });
    await validateCandidate(input, found.file, config, targetBytes);
    await fs.copyFile(found.file, output);
  } finally {
    await cleanTempFiles(id, outputDir);
  }
  console.log(`  ✓ ${describeSettings(found)}, ${found.triangles?.toLocaleString('hu-HU') || '?'} háromszög (a ${found.limitedBy} szorított)`);
  return {
    signature,
    geometry: found.geometry,
    texture: found.texture,
    limitedBy: found.limitedBy,
    bytes: found.bytes,
    sourceBytes: sourceStat.size,
    triangles: found.triangles,
    imageBytes: found.imageBytes,
    geometryBytes: found.geometryBytes,
  };
}

// A nyilvántartást autónként kiírjuk, hogy egy megszakadt futás se dobja el az
// addig elvégzett munkát. Ugyanezt a fájlt viszont a futó dev szerver is
// olvassa (az /api/assets-hez), és Windowson a párhuzamos olvasás néha épp a
// kiírás pillanatában nyitja meg — a writeFile ilyenkor UNKNOWN hibával száll
// el. Ideiglenes fájlba írunk és átnevezünk, néhány újrapróbálkozással.
async function writeMetadata(next, metadataFile) {
  const temporary = `${metadataFile}.tmp`;
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`);
      await fs.rename(temporary, metadataFile);
      return;
    } catch (error) {
      if (attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

export async function buildRemoteCars(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  await fs.mkdir(COMPRESSED_DIR, { recursive: true });
  await fs.mkdir(MASTERS_DIR, { recursive: true });

  if (options.primary) {
    const thresholdBytes = options.masterThresholdMb * 1024 * 1024;
    const rootFiles = (await fs.readdir(CARS_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.glb'))
      .filter((entry) => !entry.name.toLowerCase().includes('_test'));
    for (const entry of rootFiles) {
      const id = entry.name.replace(/\.glb$/i, '');
      if (options.ids.length && !options.ids.includes(id)) continue;
      const original = path.join(CARS_DIR, entry.name);
      const master = path.join(MASTERS_DIR, entry.name);
      if ((await fs.stat(original)).size > thresholdBytes && !await fileExists(master)) {
        await fs.copyFile(original, master);
        console.log(`master mentve: ${entry.name}`);
      }
    }
  }

  const sourceDir = options.primary ? MASTERS_DIR : CARS_DIR;
  const outputDir = options.primary ? CARS_DIR : COMPRESSED_DIR;
  const metadataFile = path.join(options.primary ? MASTERS_DIR : COMPRESSED_DIR, 'manifest.json');
  const files = (await fs.readdir(sourceDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.glb'))
    .map((entry) => entry.name)
    .filter((file) => !file.toLowerCase().endsWith('_compressed.glb'))
    .filter((file) => !file.toLowerCase().includes('_test'))
    .filter((file) => !options.ids.length || options.ids.includes(file.replace(/\.glb$/i, '')))
    .sort();
  if (!files.length) throw new Error('Nincs feldolgozható autó a megadott szűréssel.');

  const executable = await ensureGltfpack();
  const metadata = await readJson(metadataFile, { version: PIPELINE_VERSION, cars: {} });
  const next = { version: PIPELINE_VERSION, targetMb: options.targetMb, generatedAt: new Date().toISOString(), cars: { ...metadata.cars } };
  const failures = [];
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const id = file.replace(/\.glb$/i, '');
    console.log(`\n[${index + 1}/${files.length}]`);
    try {
      next.cars[id] = await buildCar(executable, file, options, metadata.cars?.[id], { sourceDir, outputDir });
    } catch (error) {
      failures.push({ id, error: error.message });
      console.error(`  ✗ ${error.message}`);
    }
    // A nyilvántartás írása KÍVÜL van a fenti try-on: egy fájlütközés nem a
    // kocsi konvertálásának a hibája, és nem is szabad annak jelenteni.
    await writeMetadata(next, metadataFile);
  }

  if (failures.length) {
    console.error(`\n${failures.length} autó konvertálása sikertelen.`);
    process.exitCode = 1;
  } else {
    const total = Object.values(next.cars).reduce((sum, car) => sum + (car.bytes || 0), 0);
    const label = options.primary ? 'játékosmodellek' : 'compressed mappa';
    console.log(`\nKész: ${files.length} autó, összesen ${(total / 1024 / 1024).toFixed(1)} MB (${label}).`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await buildRemoteCars();
