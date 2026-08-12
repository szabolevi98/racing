// Asset-manifest: végigpásztázza a web/assets/{cars,maps,skybox} mappákat, és
// megadja a kliensnek, mi érhető el. Új asset hozzáadásához elég bemásolni a
// megfelelő mappába — nincs kézzel karbantartott lista.
//
// (A korábbi assets/list.php portja. A szerver ugyanezeket a fájlokat olvassa
// a versenyhez is — a gates.json-ból számolja a köröket —, ezért a beolvasás
// itt egy helyen történik.)
import fs from 'node:fs/promises';
import path from 'node:path';
import { ASSETS_DIR } from './paths.js';

function prettify(name) {
  return name
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1));
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function exists(file) {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

// A letöltött modellek license.txt-jében ott a mű eredeti címe — ez szebb
// névadás, mint a mappanévből képzett.
async function readLicenseTitle(dir) {
  try {
    const txt = await fs.readFile(path.join(dir, 'license.txt'), 'utf8');
    const m = txt.match(/^\*?\s*title:\s*(.+)$/im);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

// Félretett mappák: ide lehet behúzni egy pályát/égboltot anélkül, hogy törölni
// kellene. A `not_used` és a `_`/`.` kezdetű nevek kimaradnak a pásztázásból.
//
// Enélkül is kimaradna az olyan mappa, amiben nincs scene fájl (lásd
// collectMaps), de az csak véletlen: amint valaki bedob egy .glb-t a félretett
// mappába — vagy egy komplett, működő pályát húz oda —, azonnal megjelenne a
// választóban. Ez a szabály teszi szándékossá a kihagyást.
const IGNORED_DIRS = /^(not_used|[_.].*)$/i;

async function listDirs(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !IGNORED_DIRS.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

async function listFiles(dir, ext) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(ext)).map((e) => e.name);
  } catch {
    return [];
  }
}

async function collectCars() {
  const carsDir = path.join(ASSETS_DIR, 'cars');
  const out = [];
  for (const file of (await listFiles(carsDir, '.glb')).sort()) {
    const id = file.replace(/\.glb$/i, '');
    const entry = { id, label: prettify(id), file: `cars/${file}` };
    // A kliens betöltő-sávja ebből súlyozza, mennyire számít az adott fájl a
    // teljes %-ba — enélkül egy 5 MB-os és egy 150 MB-os asset egyformán
    // 1/3-ot érne, és a sáv az apró fájlok után gyorsan felfutna, majd a
    // nagy pályánál "beragadna".
    try {
      entry.bytes = (await fs.stat(path.join(carsDir, file))).size;
    } catch { /* nem kritikus, a kliens ilyenkor egyenlő súlyra esik vissza */ }
    // Az eredeti modell marad a játékos saját autója. Ha az automatikus
    // konvertáló elkészítette a könnyített párját, ellenfélnél és ghostnál ezt
    // tölti le a kliens. A config továbbra is az eredeti autóé, így a
    // wheelPattern és az iránykorrekció változatlan marad.
    const remotePath = path.join(carsDir, 'compressed', file);
    try {
      const remoteStat = await fs.stat(remotePath);
      entry.remoteFile = `cars/compressed/${file}`;
      entry.remoteBytes = remoteStat.size;
    } catch { /* nincs remote változat: a kliens biztonságosan az eredetire esik vissza */ }
    // Opcionális kocsi-beállítások: <id>.json — a modell előre-iránya és a
    // kerék-mesh-ek felismerése. Ha nincs, a játék az alapértelmezésekkel megy.
    const config = await readJson(path.join(carsDir, `${id}.json`));
    if (config) {
      entry.config = {
        yawDegrees: Number(config.yawDegrees) || 0,
        wheelPattern: config.wheelPattern ?? null,
      };
    }
    out.push(entry);
  }
  return out;
}

async function collectMaps() {
  const mapsDir = path.join(ASSETS_DIR, 'maps');
  const out = [];
  for (const id of (await listDirs(mapsDir)).sort()) {
    const mapDir = path.join(mapsDir, id);

    let sceneFile = null;
    if (await exists(path.join(mapDir, 'scene.gltf'))) {
      sceneFile = 'scene.gltf';
    } else {
      const glbs = await listFiles(mapDir, '.glb');
      if (glbs.length) sceneFile = glbs.sort()[0];
    }
    if (!sceneFile) continue;

    const entry = {
      id,
      label: (await readLicenseTitle(mapDir)) || prettify(id),
      file: `maps/${id}/${sceneFile}`,
    };
    // Lásd a kocsiknál lévő megjegyzést: ez a betöltő-sáv súlyozásához kell.
    try {
      entry.bytes = (await fs.stat(path.join(mapDir, sceneFile))).size;
    } catch { /* nem kritikus */ }

    // Opcionális, pályánkénti menüfigyelmeztetés. Szándékosan a manifestbe
    // kerül, így a kliensnek nem kell minden pályához külön HTTP-kérést indítani.
    // Csak a három ismert megjelenési típus mehet át; hibás fájlnál inkább ne
    // mutassunk félreformázott üzenetet.
    const alertData = await readJson(path.join(mapDir, 'alert.json'));
    const alertType = String(alertData?.type || '').toLowerCase();
    const alertMessage = typeof alertData?.message === 'string' ? alertData.message.trim() : '';
    if (['success', 'warning', 'danger'].includes(alertType) && alertMessage) {
      entry.alert = { type: alertType, message: alertMessage };
    }

    // Kézi rajtrács (spawn.json). Egyetlen {x,z} objektum is elfogadott a
    // korábbi formátum miatt. A heading radiánban adja meg, merre nézzen az
    // autó; ha hiányzik, 0 (a világ +Z iránya).
    let spawnData = await readJson(path.join(mapDir, 'spawn.json'));
    if (spawnData && !Array.isArray(spawnData) && spawnData.x !== undefined) spawnData = [spawnData];
    if (Array.isArray(spawnData)) {
      const spawns = spawnData
        .slice(0, 8)
        .filter((p) => p && p.x !== undefined && p.z !== undefined)
        .map((p) => ({ x: p.x, z: p.z, heading: Number(p.heading) || 0 }));
      if (spawns.length) entry.spawns = spawns;
    }

    // Opcionális, külön Hot Lap felvezetőpont. Szándékosan nem a nyolc
    // rajtrácspont közé kerül: így azok sorrendje és régi fájlformátuma nem
    // változik. Ha nincs fájl, a közös grid-logika a 8. rajthelyre esik vissza.
    const hotLapSpawn = await readJson(path.join(mapDir, 'hotlap_spawn.json'));
    const hotLapX = Number(hotLapSpawn?.x);
    const hotLapZ = Number(hotLapSpawn?.z);
    const hotLapHeading = Number(hotLapSpawn?.heading);
    if (Number.isFinite(hotLapX) && Number.isFinite(hotLapZ)) {
      entry.hotLapSpawn = {
        x: hotLapX,
        z: hotLapZ,
        heading: Number.isFinite(hotLapHeading) ? hotLapHeading : 0,
      };
    }

    // Zóna-térkép (dev módban festett aszfalt/kifutó/fal maszk).
    const zonePng = path.join(mapDir, 'zonemap.png');
    const zoneMeta = await readJson(path.join(mapDir, 'zonemap.json'));
    if (zoneMeta?.bounds && (await exists(zonePng))) {
      // A `v` ugyanaz a cache-kulcs, mint a collision.bin-nél: a fájl
      // lenyomata (méret + módosítási idő). A kliens korábban Date.now()-t
      // tett a kérés végére, ami MINDEN pályabetöltésnél újratöltette a
      // 330-900 KB-os képet — pont a nagy pálya-modell letöltése mellett,
      // ugyanazon a gyenge hálózaton, ahol ez a legrosszabbul esik. Így
      // cache-elhető, de a dev módbeli újrafestés után magától új kulcsot kap.
      const zst = await fs.stat(zonePng);
      entry.zonemap = {
        file: `maps/${id}/zonemap.png`,
        bounds: zoneMeta.bounds,
        texW: zoneMeta.texW ?? null,
        texH: zoneMeta.texH ?? null,
        v: `${zst.size.toString(36)}-${Math.round(zst.mtimeMs).toString(36)}`,
      };
    }

    // Rajtvonal + checkpointok: ebből számoljuk a köröket. A szerver
    // ugyanezt olvassa a verseny hitelesítéséhez.
    const gates = await readJson(path.join(mapDir, 'gates.json'));
    if (gates) {
      entry.gates = { start: gates.start ?? null, checkpoints: gates.checkpoints ?? [] };
    }

    // Opcionális boxutca: bejárat, kijárat és pontosan nyolc számozott megállóhely.
    // A félkész adat is a manifestbe kerül, hogy a dev szerkesztőből folytatható legyen.
    const pit = await readJson(path.join(mapDir, 'pit.json'));
    if (pit) {
      entry.pit = {
        entries: Array.isArray(pit.entries) ? pit.entries : [],
        exits: Array.isArray(pit.exits) ? pit.exits : [],
        stops: Array.isArray(pit.stops) ? pit.stops.slice(0, 8) : [],
      };
    }

    // Előre bekészített ütközési háló: minden kliens BITRE ugyanazt a
    // geometriát kapja, ami a multiplayerhez elengedhetetlen.
    try {
      const st = await fs.stat(path.join(mapDir, 'collision.bin'));
      // A `v` a fájl tartalmának lenyomata (méret + módosítási idő). A kliens
      // ezt teszi a kérés végére cache-kulcsként. Korábban ott egy
      // Date.now() állt, ami minden versenyindításnál újratöltette a fájlt —
      // pont a leggyengébb hálózaton, a pálya letöltése MELLETT, ezért hasalt
      // el olyan sokszor. Így cache-elhető, de dev módbeli újragenerálás után
      // magától új kulcsot kap.
      entry.collision = {
        file: `maps/${id}/collision.bin`,
        bytes: st.size,
        v: `${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}`,
      };
    } catch { /* nincs bekészítve, a kliens a modellből nyeri ki */ }

    out.push(entry);
  }
  return out;
}

async function collectSkyboxes() {
  const skyDir = path.join(ASSETS_DIR, 'skybox');
  const out = [];
  for (const id of (await listDirs(skyDir)).sort()) {
    const envDir = path.join(skyDir, id);
    let files = await listFiles(envDir, '.hdr');
    if (!files.length) files = await listFiles(envDir, '.exr');
    if (!files.length) continue;
    const skyFile = files.sort()[0];
    const entry = {
      id,
      label: (await readLicenseTitle(envDir)) || prettify(id),
      file: `skybox/${id}/${skyFile}`,
    };
    // Lásd a kocsiknál lévő megjegyzést: ez a betöltő-sáv súlyozásához kell.
    try {
      entry.bytes = (await fs.stat(path.join(envDir, skyFile))).size;
    } catch { /* nem kritikus */ }
    out.push(entry);
  }
  return out;
}

// A manifest lassú (sok fájlrendszer-művelet), de ritkán változik: egyszer
// felépítjük, és a dev-mentések után érvénytelenítjük.
let cached = null;

export function invalidateManifest() {
  cached = null;
}

export async function getManifest() {
  if (!cached) {
    const [cars, maps, skyboxes] = await Promise.all([collectCars(), collectMaps(), collectSkyboxes()]);
    cached = { cars, maps, skyboxes };
  }
  return cached;
}
