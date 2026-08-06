// A zóna-térkép (aszfalt / kifutó / fal) értelmezése — EGY helyen, mert a
// kliens és a szerver is ezt használja.
//
// Miért közös: multiplayerben a szerver dönti el, lassul-e a kocsi a pályán
// kívül, a kliens viszont ELŐRE JÓSOL ugyanezzel. Ha a két oldal akár egy
// képpontnyit is másképp mintázna, a jóslat a pálya szélén folyamatosan
// eltérne a szervertől — pont ott, ahol a játékos amúgy is küzd.
//
// A maszkot a dev módbeli zóna-szerkesztő festi, és zonemap.png-ként menti.

export const ZONE_ASPHALT = 0;
export const ZONE_OFFTRACK = 1;
export const ZONE_WALL = 2;

// RGBA képpontokból zóna-kódok. A bemenet bármi lehet, ami indexelhető
// (böngészőben ImageData.data, szerveren a kicsomagolt PNG bájtjai).
export function decodeZoneCodes(rgba, width, height) {
  const codes = new Uint8Array(width * height);
  for (let i = 0; i < codes.length; i++) {
    const alpha = rgba[i * 4 + 3];
    // Az ecsetvonás pereme élsimított (halvány) — alacsony küszöb kell, hogy
    // a látható folt SZÉLE is beleszámítson, különben a fal/kifutó egy
    // képpontnyival kisebb lenne, mint amit a szerkesztőben látsz.
    if (alpha < 16) continue; // festetlen = aszfalt (0)
    // A két festék jól elkülönül a zöld csatornán:
    // kifutó = rgb(255,165,0) -> g=165, fal = rgb(220,20,60) -> g=20.
    codes[i] = rgba[i * 4 + 1] > 100 ? ZONE_OFFTRACK : ZONE_WALL;
  }
  return codes;
}

// Milyen felület van a világ (x, z) pontja alatt?
// A `runtime` alakja: { codes, w, h, bounds: {minX, maxX, minZ, maxZ} }
export function sampleZone(runtime, x, z) {
  if (!runtime) return ZONE_ASPHALT;
  const b = runtime.bounds;
  const u = Math.floor(((x - b.minX) / (b.maxX - b.minX)) * runtime.w);
  const v = Math.floor(((z - b.minZ) / (b.maxZ - b.minZ)) * runtime.h);
  if (u < 0 || v < 0 || u >= runtime.w || v >= runtime.h) return ZONE_ASPHALT;
  return runtime.codes[v * runtime.w + u];
}

// ---------- A kocsi alaprajzának mintavétele ----------
// Innentől a pályaszabályok: fal és "mind a négy kerék lement". Mindkettőt a
// szerver ÉS a kliens is futtatja (a kliens a jóslásához), ezért itt van, és
// nem a main.js-ben, ahol eddig volt. THREE nélkül, mert a szerveren nincs.

// Egy lokális pont elforgatása a kocsi állásába: v' = v + 2q⃗ × (q⃗ × v + w·v)
function rotateByQuat(q, x, y, z) {
  const tx = 2 * (q.y * z - q.z * y);
  const ty = 2 * (q.z * x - q.x * z);
  const tz = 2 * (q.x * y - q.y * x);
  return {
    x: x + q.w * tx + (q.y * tz - q.z * ty),
    y: y + q.w * ty + (q.z * tx - q.x * tz),
    z: z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

// A falat az autó TELJES alaprajzával ütköztetjük, nem csak a középpontjával:
// négy sarok + a közép. Enélkül a kocsi orra/oldala jócskán belelógna a falba,
// amíg a középpont még kívül van.
export function wallProbes(chassisSize) {
  return [
    { x: 0, z: 0 },
    { x: chassisSize.x, z: chassisSize.z },
    { x: -chassisSize.x, z: chassisSize.z },
    { x: chassisSize.x, z: -chassisSize.z },
    { x: -chassisSize.x, z: -chassisSize.z },
  ];
}

// A kerekek talajpontjai — a "mind a négy kerék lement" szabályhoz.
export function wheelProbes(wheelPositions) {
  return wheelPositions.map((w) => ({ x: w.x, z: w.z }));
}

function probeHits(runtime, body, probes, predicate) {
  const q = body.rotation();
  const p = body.translation();
  for (const local of probes) {
    const r = rotateByQuat(q, local.x, 0, local.z);
    if (predicate(sampleZone(runtime, p.x + r.x, p.z + r.z))) return true;
  }
  return false;
}

export function carTouchesWall(runtime, body, probes) {
  if (!runtime) return false;
  return probeHits(runtime, body, probes, (zone) => zone === ZONE_WALL);
}

// Melyik kerék áll kifutón? KEREKENKÉNT, nem a kocsi középpontjából.
//
// Ez korábban egyetlen pont volt (a kasztni középpontja) és bináris: amint a
// középpont átlépte az aszfalt szélét, MIND A NÉGY kerék egyszerre veszítette
// el a tapadása kétharmadát. Két baj volt vele. Egy: két kerékkel a rázókövön
// semmi nem történt, aztán egy centivel arrébb az egész kocsi elszállt. Kettő:
// a rázókő szélén a középpont képkockánként ide-oda lépett a határon, tehát a
// tapadás 60 Hz-cel csapkodott a teljes és a harmada között — ettől rántott
// meg és borult fel a kocsi, nem a pár centis peremtől.
//
// A visszaadott tömb sorrendje a WHEEL_POSITIONS sorrendje (0-1 első, 2-3 hátsó).
export function wheelsOffTrack(runtime, body, probes) {
  if (!runtime) return probes.map(() => false);
  const q = body.rotation();
  const p = body.translation();
  return probes.map((local) => {
    const r = rotateByQuat(q, local.x, 0, local.z);
    return sampleZone(runtime, p.x + r.x, p.z + r.z) === ZONE_OFFTRACK;
  });
}

// A valódi F1-szabály: a kör csak akkor vész el, ha MIND A NÉGY kerék a pályán
// kívülre kerül — ha akár egy is az aszfalton maradt, az még belefér.
export function allWheelsOffTrack(runtime, body, probes) {
  if (!runtime) return false;
  return !probeHits(runtime, body, probes, (zone) => zone === ZONE_ASPHALT);
}

// Láthatatlan fal: nem építünk hozzá ütköző-geometriát, hanem ha a kocsi
// falcellába kerül, visszatesszük az utolsó érvényes helyre, és csak a falba
// MUTATÓ sebesség-komponenst vesszük el — így a fal mentén tovább lehet
// csúszni, nem ragad meg és nem pattan vissza.
//
// A `lastSafe` a hívóé ({x, y, z}), mert kocsinként külön kell tárolni.
export function applyWallConstraint(body, runtime, lastSafe, probes) {
  const pos = body.translation();
  if (!carTouchesWall(runtime, body, probes)) {
    lastSafe.x = pos.x; lastSafe.y = pos.y; lastSafe.z = pos.z;
    return;
  }

  const dx = pos.x - lastSafe.x;
  const dz = pos.z - lastSafe.z;
  const len = Math.hypot(dx, dz);
  body.setTranslation({ x: lastSafe.x, y: pos.y, z: lastSafe.z }, true);

  if (len > 1e-4) {
    const nx = dx / len;
    const nz = dz / len;
    const v = body.linvel();
    const into = v.x * nx + v.z * nz;
    let vx = v.x;
    let vz = v.z;
    if (into > 0) {
      vx -= into * nx;
      vz -= into * nz;
    }
    body.setLinvel({ x: vx * 0.85, y: v.y, z: vz * 0.85 }, true);
  }
}
