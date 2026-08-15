// Hiányzó kerék-alkatrészek keresése az egész állományon.
//
// A wheelPattern általában NEVEKBŐL épül. Ha egy modell anyagai semmitmondóak
// (material_10, MIRRORS.013_18), a névre épülő felismerés csak azt találja meg,
// amit véletlenül eltalált — és néma marad arról, ami kimaradt. A felhasználó
// ezt élőben veszi észre: "a felni nem forog", "a belső pereme nem fordul".
//
// Ez a script a geometriai felismerővel (wheels-by-geometry.mjs) újraszámolja,
// mi VISELKEDIK kerékként, és összeveti azzal, amit a jelenlegi minta megfog.
// Ami a geometria szerint kerék, de a minta nem fogja meg, az hiányzik.
import fs from 'node:fs';
import path from 'node:path';
import { normalize } from '../analyze.mjs';
import { wheelCandidates } from './wheels-by-geometry.mjs';

const DIR = 'web/assets/cars';

export function missingParts(file, pattern, yawDegrees = 0) {
  let re;
  try { re = new RegExp(pattern, 'i'); } catch { return null; }
  const candidates = wheelCandidates(file, yawDegrees);
  if (candidates.length < 2) return null;
  const { prims } = normalize(file, yawDegrees);
  const missing = candidates.filter((c) => {
    const p = prims.find((q) => q.mat === c.name);
    return p && !re.test(`${p.fullName} ${p.mat}`);
  });
  return { candidates, missing };
}

if (process.argv[1] && process.argv[1].endsWith('missing-wheel-parts.mjs')) {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const rows = [];
  for (const file of fs.readdirSync(DIR).filter((n) => n.endsWith('.glb'))) {
    const id = file.replace(/\.glb$/, '');
    if (only.length && !only.includes(id)) continue;
    let config;
    try { config = JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8')); } catch { continue; }
    if (!config.wheelPattern) continue;
    let r;
    try { r = missingParts(path.join(DIR, file), config.wheelPattern, config.yawDegrees || 0); } catch { continue; }
    if (!r || !r.missing.length) continue;
    rows.push({ id, missing: r.missing, total: r.candidates.length });
  }
  console.log(`hiányzó kerék-alkatrész: ${rows.length} autónál\n`);
  for (const row of rows.sort((a, b) => b.missing.length - a.missing.length)) {
    console.log(`${row.id.padEnd(34)} ${row.missing.length}/${row.total} hiányzik: ${row.missing.map((m) => `${m.name} (átmérő ${m.diameter.toFixed(2)})`).join(', ').slice(0, 70)}`);
  }
}
