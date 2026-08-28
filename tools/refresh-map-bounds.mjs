// A pálya-masterek elavult befoglaló dobozainak helyrehozása.
//
// A csúcsmozgató (dev mód, objektumvágó) bájtpontosan írja át a
// koordinátákat, de a glTF-ben a `min`/`max` KÜLÖN mező a JSON-ban. A mentés
// ezt 2026-08-28 óta magától frissíti; az annál korábban szerkesztett
// masterekben viszont elavultan maradt.
//
// A hiba csendes: a Three.js ebből a két mezőből veszi a `boundingBox`-ot,
// tehát a látótér-vágás és a sugárvetés a valóságosnál szűkebb dobozzal
// dolgozik. A KISZOLGÁLT modelleket nem érinti, mert azok befoglalóját a
// gltfpack újraszámolja — csak a dev mód tölti be a mastert.
//
// A BIN egyetlen bájtja sem mozdul, csak a JSON-darab épül újra. Az eszköz
// ezt minden fájlon ellenőrzi is, mielőtt kiírná.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGlb, refreshPositionBounds } from '../shared/meshCut.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MASTERS = path.join(ROOT, 'masters', 'maps');

// Csak azok az accessorok jöhetnek szóba, amiket a javító egyáltalán olvasni
// tud: tömörítetlen, float32 POSITION. A masterek ilyenek, de egy jövőbeli
// formátumváltásnál inkább hagyjuk ki őket, mint hogy elszálljunk.
function pozicioAccessorok(glb) {
  const ki = new Set();
  for (const mesh of glb.json.meshes || []) {
    for (const prim of mesh.primitives || []) {
      const idx = prim.attributes?.POSITION;
      if (idx === undefined) continue;
      const acc = glb.json.accessors?.[idx];
      if (!acc || acc.componentType !== 5126) continue;
      const view = glb.json.bufferViews?.[acc.bufferView];
      if (!view || view.extensions?.EXT_meshopt_compression) continue;
      ki.add(idx);
    }
  }
  return ki;
}

// A fájlnév NEM mindig egyezik a mappanévvel: néhány pálya azonosítója
// kötőjeles, a modellé viszont aláhúzásos (suzuka-circuit-2001-layout ->
// suzuka_circuit_2001_layout.glb). Ezért a mappa tartalmából indulunk ki.
function masterFajl(id) {
  const dir = path.join(MASTERS, id);
  if (!fs.existsSync(dir)) return null;
  const glbk = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.glb'));
  if (glbk.length !== 1) return null;
  return path.join(dir, glbk[0]);
}

function javit(id, { szaraz }) {
  const file = masterFajl(id);
  if (!file) return { id, allapot: 'nincs master (vagy több GLB a mappában)' };
  const bytes = new Uint8Array(fs.readFileSync(file));
  const glb = parseGlb(bytes);
  const accessorok = pozicioAccessorok(glb);
  if (!accessorok.size) return { id, allapot: 'nincs olvasható POSITION' };

  const eredmeny = refreshPositionBounds(bytes, glb, accessorok);
  if (!eredmeny) return { id, allapot: 'naprakész', vizsgalt: accessorok.size };

  // A geometriának bájtra változatlannak kell maradnia. Ha ez nem áll, valami
  // olyat rontottunk el, amit egy méret-összevetés nem fogna meg.
  const ujGlb = parseGlb(eredmeny.bytes);
  const regiBin = bytes.subarray(glb.binStart, glb.binStart + glb.binLength);
  const ujBin = eredmeny.bytes.subarray(ujGlb.binStart, ujGlb.binStart + ujGlb.binLength);
  if (regiBin.byteLength !== ujBin.byteLength) {
    throw new Error(`${id}: a BIN hossza megváltozott — nem írom ki.`);
  }
  for (let i = 0; i < regiBin.byteLength; i++) {
    if (regiBin[i] !== ujBin[i]) throw new Error(`${id}: a BIN ${i}. bájtja megváltozott — nem írom ki.`);
  }

  const legnagyobb = eredmeny.frissitve.reduce((m, f) => Math.max(m, f.elteres), 0);
  if (!szaraz) fs.writeFileSync(file, eredmeny.bytes);
  return {
    id,
    allapot: szaraz ? 'javítható' : 'javítva',
    vizsgalt: accessorok.size,
    frissitve: eredmeny.frissitve.length,
    legnagyobb,
    meret: [bytes.byteLength, eredmeny.bytes.byteLength],
  };
}

const argv = process.argv.slice(2);
const szaraz = argv.includes('--dry-run');
const idk = argv.filter((a) => !a.startsWith('--'));
const cel = idk.length ? idk : fs.readdirSync(MASTERS).filter(
  (d) => fs.statSync(path.join(MASTERS, d)).isDirectory()
);

if (!cel.length) {
  console.error('Nincs feldolgozható pálya. Használat:');
  console.error('  node tools/refresh-map-bounds.mjs [pálya-azonosító ...] [--dry-run]');
  process.exitCode = 1;
} else {
  console.log(`${cel.length} master vizsgálata${szaraz ? ' (száraz futás, nem ír)' : ''}...\n`);
  let valtozott = 0;
  for (const id of cel) {
    const r = javit(id, { szaraz });
    if (r.allapot === 'naprakész') continue;
    if (r.frissitve) {
      valtozott++;
      const [a, b] = r.meret;
      console.log(`  ${r.id}`);
      console.log(`    ${r.allapot}: ${r.frissitve} / ${r.vizsgalt} befoglaló, `
        + `legnagyobb eltérés ${(r.legnagyobb * 100).toFixed(1)} cm`);
      console.log(`    fájlméret ${a} -> ${b} bájt (${b - a >= 0 ? '+' : ''}${b - a}), a BIN változatlan`);
    } else {
      console.log(`  ${r.id}: ${r.allapot}`);
    }
  }
  console.log(`\n${valtozott ? valtozott + ' master' : 'egyik master sem'} szorult javításra.`);
  if (valtozott && !szaraz) {
    console.log('A kiszolgált modelleket NEM kell újragenerálni: azok befoglalóját a gltfpack');
    console.log('amúgy is újraszámolja, tehát bennük eddig is helyes volt.');
  }
}
