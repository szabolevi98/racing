// A kerékből kidobja azt, ami NEM forgásszimmetrikus.
//
// Ez a harmadik, önálló hibaosztály a kerekeknél, és a kilengés-mérce nem
// fogja meg: a fékhűtő terelő KONCENTRIKUS a kerékkel, tehát forgatáskor nem
// leng ki, csak pörög a helyén. A felhasználó viszont pontosan ezt látja meg —
// előbb az F2004-en ("a kerék belsején lévő karbon"), majd a Mercedes W05-ön.
//
// A jel: ami tényleg együtt forog a kerékkel, annak a befoglaló doboza a
// forgás síkjában NÉGYZETES (a felni, a gumi és a féktárcsa 0-1%-os eltéréssel
// az, a terelő 32%, a féknyereg még több).
//
// Szándékosan csak SZŰKÍT: a jelenlegi találatokból dob ki, sosem vesz be
// újat. A megmaradókat pontos anyagnévvel sorolja fel, szóhatárra kötve.
import fs from 'node:fs';
import path from 'node:path';
import { normalize } from '../analyze.mjs';
import { radialSwing } from './wheel-orbit.mjs';

const DIR = 'web/assets/cars';
const ROUND_LIMIT = 0.06;
const SPECIAL = /[.*+?^${}()|[\]\\]/g;
const escape = (text) => text.replace(SPECIAL, (m) => `\\${m}`);
const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function dropNonRound(file, pattern, yawDegrees = 0) {
  let re;
  try { re = new RegExp(pattern, 'i'); } catch { return { skip: 'hibás regex' }; }
  const { prims } = normalize(file, yawDegrees);
  const matched = prims.filter((p) => re.test(`${p.fullName} ${p.mat}`));
  if (matched.length < 4) return { skip: 'kevés találat' };

  // Anyagonként a példányok MEDIÁNJA dönt: egy sarokban torz doboz önmagában
  // nem tehet rossszá egy valóban forgó alkatrészt.
  const groups = new Map();
  for (const p of matched) {
    const key = p.mat || p.fullName.split(' ').pop() || '?';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(Math.abs(p.size[1] - p.size[2]) / Math.max(p.size[1], p.size[2], 1e-9));
  }
  const round = [], flat = [];
  for (const [key, values] of groups) (median(values) <= ROUND_LIMIT ? round : flat).push(key);
  if (!flat.length) return { skip: 'minden találat forgásszimmetrikus' };
  if (round.length < 2) return { skip: 'túl kevés forgó alkatrész maradna' };

  const next = round.map((name) => `${escape(name)}(?![^\\s])`).join('|');
  const before = radialSwing(file, pattern);
  const after = radialSwing(file, next);
  if (!after) return { skip: 'a javaslat nem bontható sarkokra', pattern: next };
  // Kapu: a szűkítés nem ronthat. A W05-nél a nem-kerek darabok kidobása
  // után a maradék egyike (discs_1) távolabbi geometriát húzott be, és a
  // kilengés 47%-ról 135%-ra ugrott — enélkül a kapu nélkül ezt alkalmaztam
  // volna.
  if (before && after.swing / after.diameter > before.swing / before.diameter + 0.01) {
    return {
      skip: `a szűkítés rontana (${Math.round((before.swing / before.diameter) * 100)}% -> ${Math.round((after.swing / after.diameter) * 100)}%)`,
      pattern: next,
    };
  }
  return {
    pattern: next,
    dropped: flat,
    kept: round,
    parts: after.parts,
    before: before ? before.swing / before.diameter : null,
    after: after.swing / after.diameter,
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

    let r;
    try { r = dropNonRound(path.join(DIR, file), config.wheelPattern, config.yawDegrees || 0); }
    catch (error) { console.log(`--  ${id}: hiba — ${error.message}`); continue; }
    if (r.skip) { if (only.length) console.log(`NEM ${id.padEnd(30)} ${r.skip}`); continue; }

    console.log(`OK  ${id.padEnd(30)} kidobva: ${r.dropped.join(', ').slice(0, 40).padEnd(42)} ${r.before !== null ? `${(r.before * 100).toFixed(0)}%` : '?'} -> ${(r.after * 100).toFixed(0)}%`);
    if (!write) continue;
    const note = `JAVÍTVA: a kerék olyan darabot is megfogott, ami nem forgásszimmetrikus (${r.dropped.join(', ')}), `
      + 'tehát nem foroghat vele — jellemzően fékhűtő terelő vagy burkolat. A kilengés-mérce ezt nem fogja meg, '
      + 'mert az ilyen darab KONCENTRIKUS a kerékkel: nem leng ki, csak pörög a helyén. A jel az, hogy a '
      + 'befoglaló doboza a forgás síkjában nem négyzetes (a felni, a gumi és a féktárcsa 0-1%-os eltéréssel az). '
      + `A minta ezért a megmaradó darabok pontos anyagneveit sorolja fel. Mérve: ${r.parts} darab, kilengés `
      + `${r.before !== null ? Math.round(r.before * 100) : '?'}% -> ${Math.round(r.after * 100)}%.`;
    fs.writeFileSync(configFile, `${JSON.stringify({
      ...config,
      _wheelPattern: config._wheelPattern ? `${note}\n\nKorábbi megjegyzés, referenciaként: ${config._wheelPattern}` : note,
      wheelPattern: r.pattern,
    }, null, 2)}\n`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('drop-nonround.mjs')) run(process.argv.slice(2));
