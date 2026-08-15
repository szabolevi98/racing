// Utolsó kör a féknyeregre: a mintát a forgó darabok PONTOS anyagneveiből építi.
//
// A szavas keresés ezeknél az autóknál nem elég. A féknyereg vagy a saját
// nevén jött be, vagy a node-láncán keresztül (a modell a nyerget a kerék
// csoportjába tette), és nincs olyan szó, ami a forgó darabokat megfogja, a
// nyerget viszont nem. Az anyagnév viszont mindig megkülönbözteti őket.
//
// A neveket szóhatárra kötjük — `név(?![^\s])` —, ahogy a repó máshol is teszi,
// különben a "rim" a "blur_rim"-et is megfogná.
import fs from 'node:fs';
import path from 'node:path';
import { cornersFor, worstOrbit } from './fix-wheel-orbit.mjs';

const DIR = 'web/assets/cars';
const CALIPER = /calip|cala|pinza/i;
const SPECIAL = /[.*+?^${}()|[\]\\]/g;
const escape = (text) => text.replace(SPECIAL, (match) => `\\${match}`);

export function exactPattern(file, current, yawDegrees = 0) {
  const base = cornersFor(file, current, yawDegrees);
  if (!base) return { skip: 'a jelenlegi minta nem bontható sarkokra' };
  const calipers = base.parts.filter((p) => CALIPER.test(p.mat || p.src?.mat || ''));
  if (!calipers.length) return { skip: 'nincs nyereg a kerékben' };

  const rotating = [...new Set(base.parts
    .map((p) => p.mat || p.src?.mat || '')
    .filter((name) => name && !CALIPER.test(name)))];
  if (!rotating.length) return { skip: 'a találatok közt nincs nyeregen kívüli anyag' };

  const pattern = rotating.map((name) => `${escape(name)}(?![^\\s])`).join('|');
  const after = cornersFor(file, pattern, yawDegrees);
  if (!after) return { skip: 'a javaslat nem bontható sarkokra', pattern };

  const left = after.parts.filter((p) => CALIPER.test(p.mat || p.src?.mat || ''));
  if (left.length) return { skip: 'a nyereg a javaslatban is bent maradna', pattern };
  if (after.corners.some((c) => c.parts.length < 2)) return { skip: 'egy sarokban egyetlen darab maradna', pattern };
  // A találatszám nem NŐHET: ha nő, a pontos név karosszériát is behúzott. A
  // Cadillacnél például az egyik „forgó” anyag CHASSIS_MISC, és arra keresve a
  // kocsi többi része is bejönne (29 -> 40 darab).
  if (after.parts.length > base.parts.length) {
    return { skip: `a pontos név karosszériát is behúzna (${base.parts.length} -> ${after.parts.length} darab)`, pattern };
  }

  const before = worstOrbit(base.corners).orbit;
  const orbit = worstOrbit(after.corners).orbit;
  if (orbit > before + 0.01) return { skip: 'a kilengés nőne', pattern };
  return {
    pattern, before, after: orbit, parts: after.parts.length, wasParts: base.parts.length,
    dropped: [...new Set(calipers.map((p) => p.mat || p.src?.mat))],
  };
}

function run(argv) {
  const write = argv.includes('--write');
  const only = argv.filter((a) => !a.startsWith('--'));
  for (const file of fs.readdirSync(DIR).filter((n) => n.endsWith('.glb'))) {
    const id = file.replace(/\.glb$/, '');
    if (only.length && !only.includes(id)) continue;
    const configFile = path.join(DIR, `${id}.json`);
    let config;
    try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { continue; }
    if (!config.wheelPattern) continue;

    let result;
    try { result = exactPattern(path.join(DIR, file), config.wheelPattern, config.yawDegrees || 0); }
    catch (error) { console.log(`--  ${id}: hiba — ${error.message}`); continue; }
    if (result.skip === 'nincs nyereg a kerékben') continue;
    if (result.skip) { console.log(`NEM ${id.padEnd(34)} ${result.skip}`); continue; }

    console.log(`OK  ${id.padEnd(34)} ${(result.before * 100).toFixed(0).padStart(4)}% -> ${(result.after * 100).toFixed(0).padStart(3)}%  darab ${result.wasParts}->${result.parts}  elhagyva: ${result.dropped.join(', ').slice(0, 60)}`);
    if (!write) continue;

    const note = `JAVÍTVA: a féknyereg (${result.dropped.join(', ')}) együtt forgott a kerékkel. A valóságban `
      + 'az a féltengelycsonkra van szerelve, nem az agyra, tehát nem foroghat. A korábbi minta szavakkal '
      + 'keresett, és a nyereg vagy a saját nevén, vagy a node-láncán keresztül bejött — ezért ez a minta a '
      + 'forgó darabok PONTOS anyagneveit sorolja fel, szóhatárra kötve. Mérve: kilengés '
      + `${Math.round(result.before * 100)}% -> ${Math.round(result.after * 100)}%, ${result.parts} darab.`;
    fs.writeFileSync(configFile, `${JSON.stringify({
      ...config,
      _wheelPattern: config._wheelPattern ? `${note}\n\nKorábbi megjegyzés, referenciaként: ${config._wheelPattern}` : note,
      wheelPattern: result.pattern,
    }, null, 2)}\n`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('caliper-exact.mjs')) run(process.argv.slice(2));
