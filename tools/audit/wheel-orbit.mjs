import fs from 'node:fs';
import path from 'node:path';
import { normalize, splitPrim, median } from '../analyze.mjs';

// A csoportosítás az analyze.mjs evaluate()-jéből átemelve, hogy pontosan azt
// mérjük, amit a játék épít. Az egyetlen különbség: a kilengést a kerék
// tengelyére MERŐLEGES síkban (Y/Z) nézzük, mert az X tengely KÖRÜL forog —
// egy oldalirányban eltolt fékkorong nem mozdul forgás közben, egy sugárban
// eltolt féknyereg viszont körbeleng.
export function radialSwing(file, pattern) {
  const { prims, g, bin, scale, yaw } = normalize(file, 0);
  let re; try { re = new RegExp(pattern, 'i'); } catch { return { skip: 'hibás regex' }; }
  const matches = prims.filter((p) => re.test(`${p.fullName} ${p.mat}`));
  if (!matches.length) return { skip: 'nincs találat' };
  const gmX = median(matches.map((p) => p.c[0])), gmZ = median(matches.map((p) => p.c[2]));
  const parts = [];
  matches.forEach((p) => {
    if (p.size[0] > 1.0 || p.size[2] > 1.0) {
      const sp = splitPrim(p, g, bin, gmX, gmZ, scale, yaw);
      if (sp) { sp.forEach((s) => parts.push({ ...s, src: p, volume: s.size[0] * s.size[1] * s.size[2] })); return; }
    }
    parts.push({ ...p, src: p, volume: p.size[0] * p.size[1] * p.size[2] });
  });
  if (parts.length < 2) return { skip: 'kevesebb mint 2 darab' };
  const xs = parts.map((p) => p.c[0]), zs = parts.map((p) => p.c[2]);
  const spanX = Math.max(...xs) - Math.min(...xs), spanZ = Math.max(...zs) - Math.min(...zs);
  const midX = median(xs), midZ = median(zs);
  const axleMode = spanX < spanZ * 0.25;
  const sideRef = (v, mid) => {
    const hi = v.filter((x) => x > mid), lo = v.filter((x) => x < mid);
    return { hi: hi.length ? median(hi) : mid, lo: lo.length ? median(lo) : mid };
  };
  const zR = sideRef(zs, midZ), xR = sideRef(xs, midX);
  const nh = (v, r) => Math.abs(v - r.hi) <= Math.abs(v - r.lo);
  const groups = axleMode ? [[], []] : [[], [], [], []];
  parts.forEach((p) => {
    const rear = nh(p.c[2], zR) ? 0 : 1;
    if (axleMode) groups[rear].push(p);
    else groups[rear * 2 + (nh(p.c[0], xR) ? 1 : 0)].push(p);
  });
  if (groups.some((gr) => !gr.length)) return { skip: axleMode ? 'üres csoport (tengely-mód)' : 'üres csoport' };

  let worst = 0, worstName = '', diameter = 0;
  for (const gr of groups) {
    const anchor = gr.reduce((a, b) => (b.volume > a.volume ? b : a));
    const piv = anchor.c;
    const d = Math.max(...gr.map((p) => Math.max(p.size[1], p.size[2])));
    if (d > diameter) diameter = d;
    for (const p of gr) {
      const off = Math.hypot(p.c[1] - piv[1], p.c[2] - piv[2]);
      if (off > worst) { worst = off; worstName = p.mat || (p.fullName || p.src?.mat || p.src?.fullName || '?').split(' ').pop() || '?'; }
    }
  }
  return { swing: worst * 2, diameter, name: worstName, parts: parts.length };
}

if (process.argv[2] === '--scan') {
  const DIR = 'web/assets/cars';
  const sorok = []; const kihagyva = {};
  for (const file of fs.readdirSync(DIR).filter((n) => n.endsWith('.glb'))) {
    const id = file.replace(/\.glb$/, '');
    let cfg; try { cfg = JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8')); } catch { continue; }
    if (!cfg.wheelPattern) continue;
    let r; try { r = radialSwing(path.join(DIR, file), cfg.wheelPattern); } catch (e) { const k = 'hiba: ' + String(e.message).slice(0, 40); (kihagyva[k] = kihagyva[k] || []).push(id); continue; }
    if (r && r.skip) { (kihagyva[r.skip] = kihagyva[r.skip] || []).push(id); continue; }
    if (!r || !(r.diameter > 0)) { (kihagyva['nulla átmérő'] = kihagyva['nulla átmérő'] || []).push(id); continue; }
    sorok.push({ id, arany: r.swing / r.diameter, ...r });
  }
  sorok.sort((a, b) => b.arany - a.arany);
  const kuszob = 0.15;
  console.log(`elemezhető: ${sorok.length}`);
  for (const [ok, lista] of Object.entries(kihagyva)) console.log(`  kihagyva — ${ok}: ${lista.length}`);
  console.log(`kilengés a kerékátmérő 15%-a felett: ${sorok.filter((s) => s.arany > kuszob).length}\n`);
  for (const s of sorok.filter((x) => x.arany > kuszob)) {
    console.log(s.id.padEnd(36), (s.arany * 100).toFixed(0).padStart(4) + '%', '| a legrosszabb darab:', s.name.slice(0, 34));
  }
}
