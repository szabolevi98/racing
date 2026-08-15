// Kerék-minták automatikus szűkítése: ami nem forog, ne is forogjon.
//
// A hiba, amit javít: a wheelPattern gyakran egy NODE-névre illeszkedik
// (`wheel`), a játék pedig a mesh teljes ős-láncára illeszt — így a sarok
// minden gyereke bekerül a kerékbe, köztük a féknyereg és a fékhűtő terelő is,
// amik az álló felfüggesztésen ülnek. Kézzel két autón javítottam (F2004,
// RB7); a wheel-orbit.mjs mérése szerint 226-ból 138 érintett, ezért innentől
// gépi.
//
// A módszer nem névre tippel, hanem GEOMETRIÁRA:
//   1. a jelenlegi minta találatait a játék saját logikájával sarkokra bontjuk;
//   2. sarkonként a legnagyobb darab (a gumi) adja a forgástengelyt;
//   3. amelyik darab közepe a tengelyre MERŐLEGES síkban messze esik, az
//      forgatáskor körbelengene — ez a "rossz" halmaz;
//   4. keresünk egy minta-halmazt, ami a jókat lefedi, a rosszakat és a
//      karosszériát viszont nem érinti.
//
// Amit nem talál meg biztonsággal, azt érintetlenül hagyja és jelenti.
import fs from 'node:fs';
import path from 'node:path';
import { normalize, splitPrim, median } from '../analyze.mjs';

const CARS_DIR = 'web/assets/cars';
// E fölött már látható a kilengés (a kerékátmérő arányában). Az F2004 hibás
// állapota 31%, a javított 1% volt.
const ORBIT_LIMIT = 0.15;
// Ennél távolabbi darabot a kerékhez sorolni biztosan hiba (a kerékátmérő
// arányában, a sarok pivotjától vízszintesen mérve).
const FAR_FROM_WHEEL = 1.5;

// A kilengés-mérce egy fontos esetet nem fog meg: a fékhűtő terelő KONCENTRIKUS
// a kerékkel, tehát forgatáskor nem leng ki, csak pörög a helyén — a
// felhasználó viszont pontosan ezt jelezte az F2004-en.
//
// Ezért a második feltétel a forgásszimmetria. Ami tényleg együtt forog a
// kerékkel, annak a befoglaló doboza a forgás síkjában négyzetes: mérve a
// felni, a gumi és a féktárcsa 1,00–1,01 arányú, a fékhűtő terelő 0,90, a
// féknyereg 3,1. Szükséges feltétel, nem elégséges — de jól elválaszt.
const ROUND_TOLERANCE = 0.06;

// Álló alkatrészek szótára. Csak akkor dobunk el valamit, ha a geometria ÉS a
// név is ezt mondja — két független jel.
//
// Miért kell a név is: egy felnimatrica ugyanúgy a tengelyen kívül ül, mint a
// féknyereg, geometriailag megkülönböztethetetlenek. Csakhogy a matrica a
// FELNIN van, tehát együtt forog vele; kidobva állva maradna, miközben a felni
// pörög — az is látható hiba, csak fordítva. Ezért a bizonytalan neveket
// inkább kézi vizsgálatra hagyjuk.
//
// A 'brake' azért KERÜLT bele, mert ebben a módban a geometria már kizárta a
// féktárcsát: a tárcsa koncentrikus a tengellyel, tehát sosem esik a kilengő
// halmazba. Ami 'brake' nevű ÉS kilengő, az nyereg, terelő vagy fékvezeték.
// (A 'caliper' módban ugyanez nem igaz, ott külön védett lista óvja a tárcsát.)
// A féknyereg neve. A valóságban a féltengelycsonkra van szerelve, tehát
// SOSEM forog a kerékkel — ezért a 'caliper' módban a puszta név elég.
const CALIPER_NAME = /calip|cala|pinza/i;

// Amit SOHA nem dobunk el: ezek a valóságban is együtt forognak a kerékkel.
// Kellett a védelem, mert a féknyereg-nevű NODE alatt ülő féktárcsa (DISC88,
// rotor) és a felnimatrica (EXT_Rim_Decals) is nyeregnek minősült volna.
const ROTATING_NAME = /disc|disk|rotor|rim|tyre|tire|tread|spoke|hub|wheel|nut|bolt|lug/i;

// A matricáról a neve önmagában nem árulja el, a FELNIN van-e (forog) vagy a
// NYERGEN (áll). Ezért védett — kivéve, ha a nyerget is megnevezi
// ('Caliper_Logo'), mert az egyértelmű.
const AMBIGUOUS_DECAL = /decal|sticker|logo|badge/i;

const STATIC_PART_NAME = /calip|caliper|cala|pinza|brembo|brake|susp|sospension|upright|knuckle|damper|shock|wishbone|duct|scoop|air|claw|bracket|mechanic|wire/i;

function isRound(part) {
  const y = part.size[1], z = part.size[2];
  if (!(y > 0) || !(z > 0)) return false;
  return Math.abs(y - z) / Math.max(y, z) <= ROUND_TOLERANCE;
}

function tokenize(text) {
  return [...new Set(
    String(text).split(/[^a-z0-9]+/i)
      .map((t) => t.toLowerCase())
      .filter((t) => t.length >= 3 && !/^\d+$/.test(t))
  )];
}

// A darabokra bontás és a sarkokra osztás az analyze.mjs evaluate()-jéből
// származik, hogy pontosan azt mérjük, amit a játék épít.
export function cornersFor(file, pattern, yawDegrees = 0) {
  const { prims, g, bin, scale, yaw } = normalize(file, yawDegrees);
  let re;
  try { re = new RegExp(pattern, 'i'); } catch { return null; }
  const matches = prims.filter((p) => re.test(`${p.fullName} ${p.mat}`));
  if (matches.length < 2) return null;

  const gmX = median(matches.map((p) => p.c[0])), gmZ = median(matches.map((p) => p.c[2]));
  const parts = [];
  matches.forEach((p) => {
    if (p.size[0] > 1.0 || p.size[2] > 1.0) {
      const sp = splitPrim(p, g, bin, gmX, gmZ, scale, yaw);
      if (sp) { sp.forEach((s) => parts.push({ ...s, src: p, volume: s.size[0] * s.size[1] * s.size[2] })); return; }
    }
    parts.push({ ...p, src: p, volume: p.size[0] * p.size[1] * p.size[2] });
  });
  if (parts.length < 2) return null;

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
  if (groups.some((gr) => !gr.length)) return null;

  const corners = groups.map((gr) => {
    const anchor = gr.reduce((a, b) => (b.volume > a.volume ? b : a));
    const diameter = Math.max(...gr.map((p) => Math.max(p.size[1], p.size[2])));
    return { pivot: anchor.c, diameter, parts: gr };
  });
  return { prims, parts, corners, axleMode };
}

export function worstOrbit(corners) {
  let worst = 0, name = '';
  for (const c of corners) {
    if (!(c.diameter > 0)) continue;
    for (const p of c.parts) {
      const off = Math.hypot(p.c[1] - c.pivot[1], p.c[2] - c.pivot[2]) / c.diameter;
      if (off > worst) { worst = off; name = p.mat || p.src?.mat || '?'; }
    }
  }
  return { orbit: worst * 2, name };
}

// A jelenlegi találatokból eldönti, mely darabok forognak valóban, és keres egy
// szűkebb mintát. A jelölt mintát a TELJES modellen újraértékeljük — enélkül egy
// látszólag ártalmatlan szó a karosszériát is behúzhatná.
export function proposePattern(file, current, yawDegrees = 0, mode = 'orbit') {
  const base = cornersFor(file, current, yawDegrees);
  if (!base) return { skip: 'a jelenlegi minta nem bontható 4 sarokra' };
  const before = worstOrbit(base.corners);
  if (mode !== 'caliper' && before.orbit <= ORBIT_LIMIT) return { skip: 'már rendben van', before };

  // Az osztályozás ANYAGONKÉNT történik, nem darabonként — a minta is név
  // szerint válogat. Egy anyag négy sarokban négyszer fordul elő; ha az
  // összeolvasztott mesh-ek szétvágása az egyik sarokban torz dobozt ad, az
  // önmagában nem tehet rossszá egy valóban forgó alkatrészt. Ezért a
  // példányok MEDIÁNJA dönt.
  const kulcs = (p) => p.mat || p.src?.mat || (p.src?.fullName || p.fullName || '').split(' ').pop() || '?';
  const peldanyok = new Map();
  for (const c of base.corners) {
    if (!(c.diameter > 0)) continue;
    for (const p of c.parts) {
      const k = kulcs(p);
      if (!peldanyok.has(k)) peldanyok.set(k, []);
      peldanyok.get(k).push({
        part: p,
        szoveg: `${p.src?.fullName || p.fullName || ''} ${p.mat || p.src?.mat || ''}`,
        orbit: (Math.hypot(p.c[1] - c.pivot[1], p.c[2] - c.pivot[2]) / c.diameter) * 2,
        kerekseg: Math.abs(p.size[1] - p.size[2]) / Math.max(p.size[1], p.size[2], 1e-9),
      });
    }
  }
  const good = [], bad = [], nevGyanus = [];
  for (const [k, lista] of peldanyok) {
    // 'caliper' mód: a féknyereg a NEVÉRŐL azonosítható, és a valóságban sosem
    // forog — az a féltengelycsonkra van szerelve, nem az agyra. Itt tehát nem
    // kell a geometriára hagyatkozni. A 'Caliper_Logo' is ide tartozik (a
    // nyergen ül), a 'Rim_Decals' viszont NEM: az a felnin van, és együtt forog
    // vele — ezért nem elég egy általános „matrica" szabály.
    if (mode === 'caliper') {
      // Csak az ANYAGNÉV dönt, nem a node-lánc: egy féknyereg-nevű csoport
      // alatt ülő féktárcsa nem nyereg. És ami forgó alkatrészt nevez meg, azt
      // akkor sem dobjuk el, ha a neve mellesleg a nyerget is említi.
      const nyereg = CALIPER_NAME.test(k) && !ROTATING_NAME.test(k.replace(CALIPER_NAME, ''));
      (nyereg ? bad : good).push(...lista.map((e) => e.part));
      continue;
    }
    const orbit = median(lista.map((e) => e.orbit));
    const kerekseg = median(lista.map((e) => e.kerekseg));
    const geometriaRossz = orbit > ORBIT_LIMIT || kerekseg > ROUND_TOLERANCE;
    if (!geometriaRossz) { good.push(...lista.map((e) => e.part)); continue; }
    // A geometria önmagában nem elég: egy FELNIMATRICA is a tengelyen kívül ül,
    // csakhogy az együtt forog a felnivel — kidobva állva maradna, miközben a
    // felni pörög. A féknyereg és a felnimatrica geometriailag egyforma, ezért
    // a névnek is meg kell erősítenie, hogy álló alkatrészről van szó.
    // RÉSZLEGES javítás megengedett: amiről a név is megerősíti, hogy álló
    // alkatrész, azt eldobjuk; a bizonytalan nevűt bent hagyjuk. Így az
    // eredmény sosem rosszabb a mostaninál, legfeljebb nem tökéletes — a
    // maradékot a végén jelentjük.
    // A védett lista itt is érvényes: a nevében forgó alkatrészt megnevező
    // darabot (felni, gumi, tárcsa, kerékanya, matrica a felnin) akkor sem
    // dobjuk el, ha az ŐS-LÁNCA történetesen egy féknyereg-csoportot említ.
    const vedett = ROTATING_NAME.test(k) || (AMBIGUOUS_DECAL.test(k) && !CALIPER_NAME.test(k));
    if (!vedett && lista.some((e) => STATIC_PART_NAME.test(e.szoveg))) bad.push(...lista.map((e) => e.part));
    else { good.push(...lista.map((e) => e.part)); nevGyanus.push(k); }
  }
  if (!good.length || !bad.length) return { skip: 'nincs mit szétválasztani', before };

  // Tilos halmaz: a kilengő darabok, ÉS minden olyan primitív, ami egyik
  // saroktól sincs kerék-közelben (vagyis karosszéria).
  const nearWheel = (p) => base.corners.some((c) => c.diameter > 0
    && Math.hypot(p.c[0] - c.pivot[0], p.c[2] - c.pivot[2]) < FAR_FROM_WHEEL * c.diameter);
  // Az összeolvasztott kerék-mesh-ek (egy mesh, benne mind a négy kerék) közepe
  // a KOCSI közepére esik, tehát a puszta távolság karosszériának nézné őket —
  // és ezzel a saját anyagnevüket tiltaná ki. Amiből forgó darab lett, az
  // sosem karosszéria.
  const forgoForras = new Set(good.map((p) => p.src || p));
  const forbidden = [
    ...bad.map((p) => `${p.src?.fullName || p.fullName || ''} ${p.mat || p.src?.mat || ''}`),
    ...base.prims
      .filter((p) => !forgoForras.has(p) && !nearWheel(p))
      .map((p) => `${p.fullName} ${p.mat}`),
  ];
  const goodText = good.map((p) => `${p.src?.fullName || p.fullName || ''} ${p.mat || p.src?.mat || ''}`);

  // Jelölt tokenek: csak azok, amik EGYETLEN tiltott szövegre sem illeszkednek.
  //
  // A puszta szavakon túl a TELJES anyagnév is jelölt (regexre menekítve). Sok
  // modellben ugyanis a forgó darab és a féknyereg egyazon node-ág alatt ül, és
  // az anyagnevük csak a sorszámban tér el ("Material.004" vs "Material.007") —
  // a szavakra bontás pont ezt a különbséget dobná el.
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const counts = new Map();
  for (const p of good) {
    const text = `${p.src?.fullName || p.fullName || ''} ${p.mat || p.src?.mat || ''}`;
    for (const t of tokenize(text)) counts.set(t, (counts.get(t) || 0) + 1);
    const mat = p.mat || p.src?.mat;
    if (mat) counts.set(escape(mat), (counts.get(escape(mat)) || 0) + 1);
  }
  const safe = [...counts.keys()].filter((t) => {
    const re = new RegExp(t, 'i');
    return !forbidden.some((f) => re.test(f));
  });
  if (!safe.length) return { skip: 'nincs olyan szó, ami csak a forgó darabokra illik', before };

  // Mohó lefedés: mindig az a szó jön, ami a legtöbb még fedetlen darabot viszi.
  const remaining = new Set(goodText.keys ? goodText.map((_, i) => i) : []);
  goodText.forEach((_, i) => remaining.add(i));
  const chosen = [];
  while (remaining.size) {
    let best = null, bestHits = null;
    for (const t of safe) {
      if (chosen.includes(t)) continue;
      const re = new RegExp(t, 'i');
      const hits = [...remaining].filter((i) => re.test(goodText[i]));
      if (!best || hits.length > bestHits.length) { best = t; bestHits = hits; }
    }
    if (!best || !bestHits.length) break;
    chosen.push(best);
    bestHits.forEach((i) => remaining.delete(i));
  }
  if (remaining.size) return { skip: `${remaining.size} forgó darabot nem sikerült lefedni`, before };

  const pattern = chosen.sort().join('|');
  const after = cornersFor(file, pattern, yawDegrees);
  if (mode === 'caliper' && after) {
    const maradt = after.parts.filter((p) => CALIPER_NAME.test(`${p.src?.fullName || p.fullName || ''} ${p.mat || p.src?.mat || ''}`));
    if (maradt.length) return { skip: 'a nyereg a javaslatban is bent maradna', before, pattern };
  }
  if (!after) return { skip: 'a javasolt minta nem bontható 4 sarokra', before, pattern };
  const result = worstOrbit(after.corners);
  if (mode !== 'caliper' && result.orbit >= before.orbit - 0.02) {
    return { skip: 'a javaslat érdemben nem javít', before, pattern, after: result };
  }

  // Biztonsági kapuk. A mérőszámot könnyű úgy „javítani", hogy közben valódi
  // kerék-alkatrészek esnek ki — attól a kilengés nulla lesz, a kerék viszont
  // hiányos. Ezért:
  const kept = new Set(after.parts.map((p) => kulcs(p)));
  const dropped = [...peldanyok.keys()].filter((k) => !kept.has(k));
  //  - minden saroknak maradnia kell legalább két darabbal;
  if (after.corners.some((c) => c.parts.length < 2)) return { skip: 'egy sarokban egyetlen darab maradna', before, pattern };
  //  - a gumi (a legnagyobb átmérőjű darab) nem eshet ki;
  const beforeDia = Math.max(...base.corners.map((c) => c.diameter));
  const afterDia = Math.max(...after.corners.map((c) => c.diameter));
  if (afterDia < beforeDia * 0.9) return { skip: 'a legnagyobb kerék-alkatrész is kiesne', before, pattern };
  //  - és nem eshet ki több anyag, mint amennyi marad.
  if (dropped.length > kept.size) return { skip: `túl sok anyag esne ki (${dropped.length} vs ${kept.size})`, before, pattern };

  return { pattern, before, after: result, parts: after.parts.length, dropped, kept: [...kept], maradek: nevGyanus };
}

function run(argv) {
  const write = argv.includes('--write');
  const mode = argv.includes('--calipers') ? 'caliper' : 'orbit';
  const only = argv.filter((a) => !a.startsWith('--'));
  const files = fs.readdirSync(CARS_DIR).filter((n) => n.endsWith('.glb'))
    .filter((n) => !only.length || only.includes(n.replace(/\.glb$/, '')));

  const javitva = [], rendben = [], kezzel = [];
  for (const file of files) {
    const id = file.replace(/\.glb$/, '');
    const configFile = path.join(CARS_DIR, `${id}.json`);
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { continue; }
    if (!cfg.wheelPattern) continue;

    let r;
    try { r = proposePattern(path.join(CARS_DIR, file), cfg.wheelPattern, cfg.yawDegrees || 0, mode); }
    catch (error) { kezzel.push({ id, ok: `hiba: ${error.message}` }); continue; }

    if (r.skip === 'már rendben van') { rendben.push(id); continue; }
    if (r.skip) { kezzel.push({ id, ok: r.skip, orbit: r.before?.orbit, name: r.before?.name }); continue; }

    javitva.push({ id, elotte: r.before, utana: r.after, minta: r.pattern, regi: cfg.wheelPattern, parts: r.parts, dropped: r.dropped });
    if (!write) continue;

    const note = `AUTOMATIKUSAN SZŰKÍTVE (tools/audit/fix-wheel-orbit.mjs): a korábbi minta olyan darabot is `
      + `megfogott, ami nem a kerékkel forog — a legrosszabb a(z) "${r.before.name}" volt, `
      + `a kerékátmérő ${Math.round(r.before.orbit * 100)}%-ával kilengve. Az új minta csak azokat a `
      + `darabokat fogja meg, amelyek a forgástengelyre központozva ülnek: `
      + `${Math.round(r.after.orbit * 100)}% kilengés, ${r.parts} darab. Élőben ellenőrizendő.`;
    const next = {
      ...cfg,
      _wheelPattern: cfg._wheelPattern ? `${note}\n\nKorábbi megjegyzés, referenciaként: ${cfg._wheelPattern}` : note,
      wheelPattern: r.pattern,
    };
    fs.writeFileSync(configFile, `${JSON.stringify(next, null, 2)}\n`);
  }

  console.log(`már rendben: ${rendben.length}`);
  console.log(`${write ? 'javítva' : 'javítható'}: ${javitva.length}`);
  console.log(`kézi vizsgálatot kíván: ${kezzel.length}\n`);
  for (const j of javitva.sort((a, b) => b.elotte.orbit - a.elotte.orbit)) {
    console.log(`${j.id.padEnd(38)} ${(j.elotte.orbit * 100).toFixed(0).padStart(4)}% -> ${(j.utana.orbit * 100).toFixed(0).padStart(3)}%  elhagyva: ${(j.dropped || []).join(', ').slice(0, 70)}`);
  }
  if (kezzel.length) {
    console.log('\n--- kézzel megnézendő ---');
    for (const k of kezzel) console.log(`  ${k.id.padEnd(38)} ${k.orbit ? `${(k.orbit * 100).toFixed(0)}%` : ''} ${k.ok}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('fix-wheel-orbit.mjs')) run(process.argv.slice(2));
