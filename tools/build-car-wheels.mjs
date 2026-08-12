// Kerék-konfigok kötegelt elkészítése — a `npm run cars:compress` mintájára.
//
// Miért kell: egy új autó eddig kézi munka volt (propose.mjs futtatása, majd a
// JSON megírása). Ez a script mindkettőt elvégzi az összes olyan autóra,
// aminek még NINCS configja.
//
// A MEGLÉVŐ configokat szándékosan nem írja felül. Nem óvatoskodásból: a
// repóban lévő JSON-ok kézzel szerzett tudást hordoznak, konkrét, élőben
// jelentett hibákból ("gumi forog, felnik nem", "a futófelület egy helyben
// marad", kormánykerék-anyagok szándékos kizárása). Egy vak újragenerálás
// ezeket csendben eldobná, és a hibák visszatérnének. Kifejezetten kérni kell
// a felülírást (--force), és olyankor is megőrizzük a korábbi megjegyzést.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { propose } from './propose.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARS_DIR = path.join(ROOT, 'web', 'assets', 'cars');

// E pontszám alatt a javaslat inkább tipp, mint mérés — jellemzően generikus,
// szemantika nélküli anyagnevek (mat_13.001), ahol a geometria dönt. Ezeket
// külön kigyűjtjük a végén, hogy tudni lehessen, mit érdemes élőben megnézni.
const LOW_CONFIDENCE = 0.5;

export function buildConfig(id, best, previousConfig) {
  const measurement = `Mérés: nyomtáv ${best.sc.track}, tengelytáv ${best.sc.wheelbase}, ${best.sc.parts} darab.`;
  const confidence = best.sc.s < LOW_CONFIDENCE
    ? ` ALACSONY biztonság (pontszám ${best.sc.s}) — mindenképp nézd meg élőben.`
    : '';
  const alien = best.alien?.length
    ? ` FIGYELEM: a minta kerékhez nem tartozó darabot is megfog: ${best.alien.join(', ')}.`
    : '';
  // A korábbi megjegyzést nem dobjuk el, hanem referenciaként megtartjuk —
  // gyakran ez az egyetlen nyoma egy régen javított, élőben talált hibának.
  const previousNote = previousConfig?._wheelPattern
    ? `\n\nKorábbi megjegyzés, referenciaként: ${previousConfig._wheelPattern}`
    : '';

  return {
    _megjegyzes: 'Kocsi-beállítások. A .glb mellé, ugyanazzal a névvel. Minden mező elhagyható.',
    // Mindig 0: a modellek túlnyomó része előre néz, és a kivételt úgyis csak
    // élőben lehet észrevenni. Kézzel felülírható.
    _yawDegrees: 'Alapértelmezés 0 (előre néző modellt feltételezve). Ha a kocsi hátrafelé áll, ezt kézzel írd át.',
    yawDegrees: previousConfig?.yawDegrees ?? 0,
    _wheelPattern: `Automatikusan generálva (tools/build-car-wheels.mjs). ${measurement}${confidence}${alien}${previousNote}`,
    wheelPattern: best.pat,
  };
}

function parseArgs(argv) {
  const options = { force: false, ids: [] };
  for (const arg of argv) {
    if (arg === '--force') options.force = true;
    else options.ids.push(arg.replace(/\.glb$/i, ''));
  }
  return options;
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

export async function buildCarWheels(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const files = (await fs.readdir(CARS_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.glb'))
    .map((entry) => entry.name)
    .filter((file) => !options.ids.length || options.ids.includes(file.replace(/\.glb$/i, '')))
    .sort();
  if (!files.length) throw new Error('Nincs feldolgozható autó a megadott szűréssel.');

  const written = [], skipped = [], lowConfidence = [], failures = [];

  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const id = file.replace(/\.glb$/i, '');
    const configFile = path.join(CARS_DIR, `${id}.json`);
    const previous = await readJson(configFile);

    if (previous && !options.force) {
      skipped.push(id);
      continue;
    }

    process.stdout.write(`[${index + 1}/${files.length}] ${id} ... `);
    try {
      const { best } = propose(path.join(CARS_DIR, file));
      if (!best) throw new Error('nincs használható kerék-jelölt');
      const config = buildConfig(id, best, previous);
      await fs.writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`);
      written.push(id);
      const flag = best.sc.s < LOW_CONFIDENCE ? '  ⚠ alacsony biztonság' : '';
      console.log(`kész (pontszám ${best.sc.s}, ${best.sc.parts} darab)${flag}`);
      if (best.sc.s < LOW_CONFIDENCE) lowConfidence.push({ id, score: best.sc.s });
      if (best.alien?.length) console.log(`    ⚠ kerékhez nem tartozó darabot is megfog: ${best.alien.join(', ')}`);
    } catch (error) {
      failures.push({ id, error: error.message });
      console.log(`HIBA — ${error.message}`);
    }
  }

  console.log(`\nÍrva: ${written.length} · változatlanul hagyva: ${skipped.length} · hiba: ${failures.length}`);
  if (skipped.length && !options.force) {
    console.log('A meglévő configokhoz nem nyúltunk. Felülíráshoz: --force (a korábbi megjegyzés megmarad).');
  }
  if (lowConfidence.length) {
    console.log(`\nEllenőrizd élőben a kocsi-tesztelőben (alacsony pontszám):`);
    lowConfidence.forEach(({ id, score }) => console.log(`  ${id} (${score})`));
  }
  if (failures.length) {
    console.log('\nSikertelen:');
    failures.forEach(({ id, error }) => console.log(`  ${id}: ${error}`));
    process.exitCode = 1;
  }
  return { written, skipped, lowConfidence, failures };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await buildCarWheels();
