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

async function listDirs(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
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

    // Zóna-térkép (dev módban festett aszfalt/kifutó/fal maszk).
    const zoneMeta = await readJson(path.join(mapDir, 'zonemap.json'));
    if (zoneMeta?.bounds && (await exists(path.join(mapDir, 'zonemap.png')))) {
      entry.zonemap = {
        file: `maps/${id}/zonemap.png`,
        bounds: zoneMeta.bounds,
        texW: zoneMeta.texW ?? null,
        texH: zoneMeta.texH ?? null,
      };
    }

    // Rajtvonal + checkpointok: ebből számoljuk a köröket. A szerver
    // ugyanezt olvassa a verseny hitelesítéséhez.
    const gates = await readJson(path.join(mapDir, 'gates.json'));
    if (gates) {
      entry.gates = { start: gates.start ?? null, checkpoints: gates.checkpoints ?? [] };
    }

    // Előre bekészített ütközési háló: minden kliens BITRE ugyanazt a
    // geometriát kapja, ami a multiplayerhez elengedhetetlen.
    try {
      const st = await fs.stat(path.join(mapDir, 'collision.bin'));
      entry.collision = { file: `maps/${id}/collision.bin`, bytes: st.size };
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
    out.push({
      id,
      label: (await readLicenseTitle(envDir)) || prettify(id),
      file: `skybox/${id}/${files.sort()[0]}`,
    });
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
