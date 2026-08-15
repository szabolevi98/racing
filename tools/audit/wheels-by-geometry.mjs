// Kerék-minta készítése GEOMETRIÁBÓL, ha a nevek semmit nem érnek.
//
// A car packekből szétvágott kocsik minden anyaga `MIRRORS.013_18` stílusú, és
// egy-egy primitív az EGÉSZ kocsit átfogja (a modell anyagonként van
// szervezve). A tools/propose.mjs név-tokenekből épít mintát, ezért itt nem
// talál semmit — viszont minden primitívnek EGYEDI neve van, tehát pontos
// névvel hivatkozhatunk rájuk.
//
// A módszer: minden anyagot egyesével kipróbálunk a játék saját kiértékelőjével
// (analyze.mjs evaluate), ami az összeolvasztott darabot négy sarokra vágja.
// Ami tényleg kerék, arra négy csoport áll össze, mind a négy kerek a forgás
// síkjában, egyforma átmérővel és szimmetrikusan elhelyezve.
import fs from 'node:fs';
import path from 'node:path';
import { normalize, evaluate } from '../analyze.mjs';

const SPECIAL = /[.*+?^${}()|[\]\\]/g;
const escape = (text) => text.replace(SPECIAL, (m) => `\\${m}`);
const exact = (name) => `${escape(name)}(?![^\\s])`;

// Egy kerék a forgás síkjában kerek (az analyze.mjs `round` mezője az Y és Z
// kiterjedés különbsége), és a négy saroknak egyforma átmérőjűnek kell lennie.
const ROUND_LIMIT = 0.06;
const DIAMETER_SPREAD = 0.15;
// Játék-léptékben (a kasztni 2*CHASSIS_Z hosszúra normálva) ekkora a GUMI.
const MAX_DIAMETER = 1.0;
// A többi kerék-alkatrész ennél kisebb: a felni a gumin belül ül, a féktárcsa
// még beljebb. Egy abszolút alsó korlát ezeket kizárná — a Ferrari F14 T-nél
// a felni 0,31 átmérőjű, és egy 0,35-ös küszöb miatt maradt ki, amit a
// felhasználó élőben vett észre ("a felni nem forog"). Ezért a küszöb a
// legnagyobb keréké-hez képest relatív.
const MIN_RELATIVE_DIAMETER = 0.3;
// És koncentrikusnak kell lennie a gumival: ami nem a kerék tengelyén ül,
// az nem kerék-alkatrész, akármilyen kerek.
const CONCENTRIC_LIMIT = 0.1;

export function wheelCandidates(file, yawDegrees = 0) {
  const { prims } = normalize(file, yawDegrees);
  const names = [...new Set(prims.map((p) => p.mat).filter(Boolean))];
  const good = [];
  for (const name of names) {
    let r;
    try { r = evaluate(file, exact(name), yawDegrees); } catch { continue; }
    if (!r.ok || r.axleMode || r.info.length !== 4) continue;
    const diameters = r.info.map((g) => g.size[1]);
    const spread = (Math.max(...diameters) - Math.min(...diameters)) / Math.max(...diameters);
    const roundest = Math.max(...r.info.map((g) => g.round));
    if (spread > DIAMETER_SPREAD) continue;
    if (roundest > ROUND_LIMIT) continue;
    if (Math.max(...diameters) > MAX_DIAMETER) continue;
    good.push({
      name,
      diameter: Math.max(...diameters),
      round: roundest,
      swing: Math.max(...r.info.map((g) => g.swing)),
      // A sarkok középpontja: ebből derül ki, hogy egy tengelyen ülnek-e.
      centres: r.info.map((g) => g.pivot),
    });
  }
  if (!good.length) return good;

  // A legnagyobb átmérőjű a gumi; a felni és a féktárcsa ennél kisebb, de
  // KONCENTRIKUS vele. Aki nem az, azt kidobjuk.
  const tyre = good.reduce((a, b) => (b.diameter > a.diameter ? b : a));
  return good.filter((c) => {
    if (c.diameter < tyre.diameter * MIN_RELATIVE_DIAMETER) return false;
    // A koncentricitást a tengelyre MERŐLEGES síkban (Y/Z) mérjük. A kerék az
    // X tengely körül forog, tehát az axiális eltolás közömbös — a kerék külső
    // és belső oldala 0,13-mal odébb ül, és egy 3D-távolság ezeket tévesen
    // kizárta (mérve az F14 T-n: a négyből kettő esett ki emiatt).
    return c.centres.every((centre) => tyre.centres.some((t) => (
      Math.hypot(centre[1] - t[1], centre[2] - t[2]) <= tyre.diameter * CONCENTRIC_LIMIT
    )));
  });
}

export function proposeByGeometry(file, yawDegrees = 0) {
  const candidates = wheelCandidates(file, yawDegrees);
  if (!candidates.length) return { skip: 'egyetlen anyag sem viselkedik kerékként' };
  // A legnagyobb átmérő a gumi; a többi kerék-alkatrész (felni, tárcsa) ennél
  // kisebb, de ugyanabban a négy sarokban ül. A méret-szűrés már megvolt,
  // ezért itt mindet elfogadjuk.
  const pattern = candidates.map((c) => exact(c.name)).join('|');
  let combined;
  try { combined = evaluate(file, pattern, yawDegrees); } catch { return { skip: 'az együttes minta kiértékelése elszállt', candidates }; }
  if (!combined.ok || combined.info.length !== 4) return { skip: 'az együttes minta nem ad négy sarkot', candidates };
  return {
    pattern,
    candidates,
    corners: combined.info.length,
    parts: combined.parts,
    diameter: Math.max(...combined.info.map((g) => g.size[1])),
    swing: Math.max(...combined.info.map((g) => g.swing)),
  };
}

if (process.argv[1] && process.argv[1].endsWith('wheels-by-geometry.mjs')) {
  const input = process.argv[2];
  if (!input) { console.error('Használat: node tools/audit/wheels-by-geometry.mjs <kocsi.glb>'); process.exit(1); }
  const files = fs.statSync(input).isDirectory()
    ? fs.readdirSync(input).filter((n) => n.endsWith('.glb')).map((n) => path.join(input, n))
    : [input];
  for (const file of files) {
    const r = proposeByGeometry(file);
    const nev = path.basename(file, '.glb');
    if (r.skip) { console.log(`NEM ${nev.padEnd(26)} ${r.skip}`); continue; }
    console.log(`OK  ${nev.padEnd(26)} ${String(r.candidates.length).padStart(2)} anyag, ${String(r.parts).padStart(2)} darab, átmérő ${r.diameter.toFixed(2)}, kilengés ${r.swing.toFixed(2)}`);
    console.log(`    ${r.pattern}`);
  }
}
