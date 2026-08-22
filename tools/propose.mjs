import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalize, evaluate, splitPrim, median } from './analyze.mjs';

// A projekt gyökeréhez képest — így akárhonnan futtatva is a helyes,
// web/assets/cars mappát találja meg (nem a régi, azóta megszűnt
// D:/xampp/htdocs/racing/assets/cars utat).
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'assets', 'cars');

// Egy kiértékelés "kerékszerűségének" pontozása.
export function score(r) {
  if (!r.ok || r.axleMode) return null;
  const g = r.info;
  const ys = g.map((i) => i.pivot[1]);
  const xs = g.map((i) => i.pivot[0]);
  const zs = g.map((i) => i.pivot[2]);
  // 4 sarok: FL,FR,RL,RR -> groups[0]=hátsó? (rear*2+x) index 0..3
  // szimmetria: |x| párok egyezzenek, z párok egyezzenek
  const symX = Math.abs(Math.abs(xs[0]) - Math.abs(xs[1])) + Math.abs(Math.abs(xs[2]) - Math.abs(xs[3]));
  const symZ = Math.abs(zs[0] - zs[1]) + Math.abs(zs[2] - zs[3]);
  const ySpread = Math.max(...ys) - Math.min(...ys);
  const track = (Math.abs(xs[0]) + Math.abs(xs[1]) + Math.abs(xs[2]) + Math.abs(xs[3])) / 2;
  const wheelbase = Math.abs(((zs[0] + zs[1]) - (zs[2] + zs[3])) / 2);
  // méret: minden csoport bboxa kerék-méretű legyen
  const sizes = g.map((i) => Math.max(i.size[0], i.size[1], i.size[2]));
  const maxSize = Math.max(...sizes), minSize = Math.min(...sizes);
  const swing = Math.max(...g.map((i) => i.swing));
  const off = Math.max(...g.map((i) => i.off));
  const round = Math.max(...g.map((i) => i.round));
  let s = 0;
  s -= symX * 6 + symZ * 6 + ySpread * 6;
  s -= swing * 3;
  // a pivot a kerék közepén üljön, és a kerék legyen kör (nem lengőkar/tartó)
  s -= off * 8;
  s -= round * 5;
  if (maxSize > 1.4) s -= (maxSize - 1.4) * 10;      // túl nagy = karosszériát is behúzott
  if (minSize < 0.15) s -= (0.15 - minSize) * 10;    // túl kicsi = csak egy apró alkatrész
  if (track < 0.8 || track > 2.4) s -= 8;
  if (wheelbase < 1.2 || wheelbase > 3.6) s -= 8;
  // a kerekek a kocsi alján ülnek
  s -= Math.max(0, Math.max(...ys) - 0.9) * 5;
  s += Math.min(r.parts, 24) * 0.12;                  // több alkatrész/kerék = teljesebb
  return { s: +s.toFixed(2), track: +track.toFixed(2), wheelbase: +wheelbase.toFixed(2),
    swing, off, round, maxSize: +maxSize.toFixed(2), minSize: +minSize.toFixed(2),
    symX: +symX.toFixed(2), symZ: +symZ.toFixed(2), ySpread: +ySpread.toFixed(2), parts: r.parts };
}

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Ezek a kerék KÖZELÉBEN vannak és a mérethatárba is beleférnek, de NEM
// forognak a kerékkel (a felfüggesztés csak a kormányzást követi). Ha
// bekerülnének a kerék-pivotba, gördüléskor együtt pörögnének a kerékkel —
// az egyik legfeltűnőbb hiba, ezért név alapján kizárjuk őket.
const BANNED_TOKEN = /^(susp\w*|sospension\w*|sospensioni|wishbone\w*|damper\w*|shock\w*|spring\w*|upright\w*|pushrod\w*|steering|axle|arm|arms|swingarm|strut\w*|linkage|knuckle|fender\w*|body\w*|chassis|floor|diffuser|underbody|splitter|mudguard\w*|arch|wing|aero|caliper\w*|calliper\w*|brakecaliper\w*)$/i;
// A teljes anyagneveknél (pl. "ae2_susp_front_stup.003") részstringként is
// keresni kell, különben a tokenszintű tiltás mellett becsúszik.
//
// A FÉKNYEREG külön tanulság: geometriailag a kerék BELSEJÉBEN ül, tehát az
// inWheel() minden mérethatárt teljesít — mégsem forog vele, mert az álló
// felfüggesztésre van szerelve. Csak név alapján lehet kiszűrni. Kézzel hat
// autónál kellett utólag kivenni (F2004, RB7 Showrun, Mazda Furai, McLaren
// 650S GT3, Koenigsegg CCGT, Nissan GT-R), 24-48%-os kilengéssel.
//
// A féktárcsa (rotor/disc/disk) SZÁNDÉKOSAN nincs tiltva: az valóban forog.
const BANNED_PART = /susp|sospension|wishbone|damper|upright|pushrod|knuckle|swingarm|wheelarch|caliper|calliper/i;
const BANNED = (t) => BANNED_TOKEN.test(t) || BANNED_PART.test(t);

export function tokensOf(prims) {
  const set = new Map();
  prims.forEach((p) => {
    const txt = p.fullName + ' ' + p.mat;
    txt.split(/[^A-Za-z0-9]+/).forEach((t) => {
      if (t.length < 2 || /^\d+$/.test(t)) return;
      set.set(t.toLowerCase(), (set.get(t.toLowerCase()) || 0) + 1);
    });
  });
  // A TELJES anyagnevek is jelöltek: néhány modellnél (pl. "Material_169.001_8",
  // "plastic_SGL_9") a név semmitmondó és tokenekre bontva használhatatlan
  // ("material" az egész kocsit behúzná) — egészben viszont pont egy
  // alkatrészt azonosít.
  const toks = [...set.keys()].map((t) => ({ t, pat: esc(t) }));
  // Az egész anyagnév véghorgonyt kap: enélkül a "Material_169.001_1"
  // részlegesen illeszkedne a "Material_169.001_12"-re is.
  const mats = new Set();
  prims.forEach((p) => { if (p.mat && p.mat.length > 2) mats.add(p.mat); });
  // A horgony lookahead (nem `(\s|$)`), mert az tartalmazna egy `|`-t, ami
  // összekeveredne az alternatívák elválasztójával.
  mats.forEach((m) => toks.push({ t: m, pat: esc(m) + '(?![^\\s])' }));
  return toks;
}

export function propose(glb, yaw = 0, verbose = false) {
  const { prims, g, bin, scale, yaw: yawRad } = normalize(glb, yaw);
  const toks = tokensOf(prims);
  const cand = [];
  for (const { t, pat } of toks) {
    if (BANNED(t)) continue;
    let r;
    try { r = evaluate(glb, pat, yaw); } catch (e) { continue; }
    const sc = score(r);
    if (sc && sc.s > -12) cand.push({ pat, sc, r });
  }
  cand.sort((a, b) => b.sc.s - a.sc.s);
  if (!cand.length) return { best: null, cand: [] };

  // Egy jelölt akkor "önmagával konzisztens", ha a saját találatai mind a
  // saját maga által kijelölt kerék-pozíciókra esnek (szétvágás után is).
  const landsOn = (p, hubs, rad) => {
    const sp = (p.size[0] > 1.0 || p.size[2] > 1.0)
      ? splitPrim(p, g, bin, median(hubs.map((h) => h[0])), median(hubs.map((h) => h[2])), scale, yawRad)
      : null;
    const pieces = sp || [p];
    return pieces.every((s) => hubs.some((h) =>
      Math.abs(s.c[0] - h[0]) < rad * 1.3 && Math.abs(s.c[2] - h[2]) < rad * 1.3));
  };
  function isSelfConsistent(c) {
    const hubs = c.r.info.map((i) => i.pivot);
    const rad = Math.max(Math.max(...c.r.info.map((i) => Math.max(i.size[1], i.size[2]))) / 2, 0.3);
    const re2 = new RegExp(c.pat, 'i');
    try {
      return prims.filter((p) => re2.test(p.fullName + ' ' + p.mat)).every((p) => landsOn(p, hubs, rad));
    } catch (e) { return false; }
  }

  // A legjobb token a MAG: megadja a 4 kerék helyét és méretét. Ezután
  // geometriailag keressük meg a TÖBBI kerék-alkatrészt (felni, féktárcsa,
  // nyereg): azokat, amik teljesen beleférnek egy kerék dobozába. Így nem
  // marad kint alkatrész (a "felni nem forog, gumi igen" hiba forrása), és
  // a hosszan benyúló felfüggesztés/lengőkar kimarad, mert nem fér bele.
  // A magot is ellenőrizni kell: ha maga a mag-token húz be egy futóművet
  // (a BMW M3 Touringnál a "wheel" a hátsó futóművet is megfogta), akkor
  // hiába szűrjük a TÖBBI alkatrészt, a hiba már bent van. Ezért sorban
  // végigmegyünk a jelölteken, és az elsőt fogadjuk el, amelynek minden
  // darabja tényleg a saját maga által kijelölt kerekekre esik.
  let core = cand[0];
  for (const c of cand) {
    if (isSelfConsistent(c)) { core = c; break; }
  }
  const hubs = core.r.info.map((i) => i.pivot);
  // A sugár NEM lehet pusztán a magé: ha a mag történetesen a féktárcsa (ami
  // jóval kisebb a keréknél), a keresődoboz olyan szűk lenne, hogy maga a
  // gumi sem férne bele — emiatt maradt korábban sok kocsi egyetlen
  // alkatrésznél. A kocsi hossza normalizálva mindig 4.4, egy kerék átmérője
  // ennek nagyjából a 15%-a, ezért alulról ehhez kötjük.
  const rad = Math.max(
    Math.max(...core.r.info.map((i) => Math.max(i.size[1], i.size[2]))) / 2,
    0.3);
  // Egy bbox önmagában nem árulja el, hogy egy széles, alacsony mesh KÉT KERÉK
  // egy darabban (jó), vagy a köztük átérő futómű/differenciálmű (rossz) — a
  // kettő bboxa véletlenül ugyanolyan arányú lehet. Szétvágjuk ugyanúgy, ahogy
  // a játék tenné, és megnézzük, hogy a keletkező darabok tényleg a kerekekre
  // esnek-e: a futómű darabjai a kocsi közepe felé csúsznak.
  const splitLandsOnWheels = (p) => {
    const sp = splitPrim(p, g, bin, median(hubs.map((h) => h[0])), median(hubs.map((h) => h[2])),
      scale, yawRad);
    if (!sp) return false;
    return sp.every((s) => hubs.some((h) =>
      Math.abs(s.c[0] - h[0]) < rad * 0.8 && Math.abs(s.c[2] - h[2]) < rad * 0.8));
  };

  const inWheel = (p) => {
    // (A) önálló kerék-alkatrész: a közepe egy keréken ül, és nem nagyobb egy
    // keréknél (a felfüggesztés/lengőkar hosszan benyúlik, ezért kiesik)
    const near = hubs.some((h) =>
      Math.abs(p.c[0] - h[0]) < rad * 1.2 && Math.abs(p.c[1] - h[1]) < rad * 0.9 &&
      Math.abs(p.c[2] - h[2]) < rad * 0.9);
    if (near && p.size[0] < rad * 3.0 && p.size[1] < rad * 2.6 && p.size[2] < rad * 2.6) return true;
    // (B) összeolvasztott: egyetlen mesh több kereket tartalmaz. Ilyenkor a
    // MAGASSÁGA árulkodik — az továbbra is csak kerékátmérőnyi, míg a
    // karosszéria/padlólemez ennél jóval magasabb.
    // Két eset fér bele: (1) a mesh több TENGELYT is átfog (Z-ben mély) —
    // ilyen a klasszikus "mind a 4 kerék egy mesh-ben"; (2) csak EGY tengely
    // két kerekét fogja át, ilyenkor viszont a keresztmetszetének KÖRNEK kell
    // lennie (Y ≈ Z, hiszen egy kerék kör). Ez zárja ki a kereszttengelyeket
    // és merevítő lapokat, amik szintén a kerékmagasságban ülnek és szintén
    // "lefedik" a bal+jobb kereket, de laposak — forgatva feltűnően kilengenének.
    const deep = p.size[2] > rad * 1.6;
    const roundSection = Math.abs(p.size[1] - p.size[2]) < 0.25 * Math.max(p.size[1], p.size[2]);
    if (p.size[1] < rad * 2.6 && (deep || roundSection) &&
        Math.abs(p.c[1] - hubs[0][1]) < rad * 0.9 && splitLandsOnWheels(p)) {
      // tűréssel: a féknyergek/tárcsák beljebb ülnek, mint maguk a gumik,
      // ezért a bboxuk nem éri el pontosan a kerékközepeket
      const covered = hubs.filter((h) =>
        p.min[0] - rad <= h[0] && h[0] <= p.max[0] + rad &&
        p.min[2] - rad <= h[2] && h[2] <= p.max[2] + rad).length;
      if (covered >= 2) return true;
    }
    return false;
  };

  // Csak azokat a tokeneket vesszük be, amelyek MINDEN találata kerék-alkatrész.
  const keep = [];
  for (const { t, pat } of toks) {
    if (BANNED(t)) continue;
    let re2;
    try { re2 = new RegExp(pat, 'i'); } catch (e) { continue; }
    const hits = prims.filter((p) => re2.test(p.fullName + ' ' + p.mat));
    // 1 találat is érvényes: az összeolvasztott modelleknél egy alkatrész
    // (pl. az összes féktárcsa) EGYETLEN primitívben van.
    if (hits.length < 1) continue;
    // Nem elég a TOKENT tiltani: egy rövid, ártatlan token RÉSZSTRINGKÉNT is
    // beleeshet egy tiltott alkatrész nevébe. A Koenigsegg CCGT-nél a "lip"
    // (első légterelő) a "caLIPer"-re is illeszkedett, és így a féknyereg
    // bekerült a kerék pivotjába — 42%-os kilengéssel. Ezért azt is nézzük,
    // hogy a token TALÁLATAI között van-e tiltott alkatrész.
    if (hits.some((p) => BANNED_PART.test(p.fullName + ' ' + p.mat))) continue;
    if (hits.every(inWheel)) keep.push({ t, pat, n: hits.length });
  }
  keep.sort((a, b) => b.n - a.n);

  let best = core;
  let altList = [core.pat];
  for (const k of keep) {
    if (altList.includes(k.pat)) continue;
    const merged = altList.concat(k.pat).join('|');
    let r;
    try { r = evaluate(glb, merged, yaw); } catch (e) { continue; }
    const sc = score(r);
    // elfogadjuk, ha nem romlik érdemben a geometria (több alkatrész = jobb)
    if (sc && sc.s > best.sc.s - 0.35 && sc.parts >= best.sc.parts) {
      best = { pat: merged, sc, r }; altList = altList.concat(k.pat);
    }
  }
  // A token- és a teljes-anyagnév jelöltek gyakran UGYANAZT fogják meg —
  // dobjuk el azokat az alternatívákat, amelyek elhagyása nem változtat a
  // megfogott primitívek halmazán.
  const setOf = (pat) => {
    const re2 = new RegExp(pat, 'i');
    return prims.map((p) => (re2.test(p.fullName + ' ' + p.mat) ? 1 : 0)).join('');
  };
  let alts = altList;
  const want = setOf(altList.join('|'));
  for (let i = alts.length - 1; i >= 0 && alts.length > 1; i--) {
    const trial = alts.slice(0, i).concat(alts.slice(i + 1));
    if (setOf(trial.join('|')) === want) alts = trial;
  }
  if (alts.join('|') !== altList.join('|')) {
    const r = evaluate(glb, alts.join('|'), yaw);
    const sc = score(r);
    if (sc) best = { pat: alts.join('|'), sc, r };
  }

  // Biztonsági kapu: a VÉGSŐ pattern egyetlen olyan primitívet se fogjon meg,
  // ami nem a kerekeken ül (pl. a gyökér-node nevéből származó token az egész
  // kocsit behúzná).
  const finalRe = new RegExp(best.pat, 'i');
  const alien = prims.filter((p) => finalRe.test(p.fullName + ' ' + p.mat) && !inWheel(p));
  best.alien = alien.map((p) => (p.mat || p.fullName || '?').slice(0, 40));
  return { best, cand: cand.slice(0, 8), core, inWheel, hubs, rad, prims };
}

// Parancssorból:  node tools/propose.mjs <kocsi-id> [yawDegrees]
// pl.             node tools/propose.mjs 2024_ford_mustang_gt3
if (process.argv[1] && process.argv[1].endsWith('propose.mjs') && process.argv[2]) {
  const name = process.argv[2].replace(/\.glb$/, '');
  const glb = name.includes('/') ? name + '.glb' : dir + '/' + name + '.glb';
  const yaw = Number(process.argv[3] || 0);
  const { best, cand } = propose(glb, yaw);
  console.log('=== ' + name + ' ===');
  console.log('Jelöltek (pontszám szerint):');
  cand.forEach((c) => console.log('  ', String(c.sc.s).padStart(7), c.pat.padEnd(28), JSON.stringify(c.sc)));
  if (!best) { console.log('NINCS használható jelölt.'); process.exit(1); }
  console.log('\nJAVASOLT wheelPattern:');
  console.log('  ' + best.pat);
  console.log('\nMérés:', JSON.stringify(best.sc));
  if (best.alien && best.alien.length) {
    console.log('FIGYELEM — a minta kerékhez NEM tartozó darabot is megfog:', best.alien.join(', '));
  }
  console.log('\nSarkok (0=hátsó-bal, 1=hátsó-jobb, 2=első-bal, 3=első-jobb sorrendben nem garantált):');
  best.r.info.forEach((i) => console.log('  ', JSON.stringify(i)));
}
