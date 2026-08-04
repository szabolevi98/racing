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
