// Egyetlen renderóra-mechanizmus MINDKÉT idővonalhoz.
//
// A saját kocsi és a többiek kirajzolása ugyanaz a feladat: időbélyeges
// puffert mintavételezni egy kicsit a jelen MÖGÖTT. Két külön megoldás azt
// jelentette, hogy két helyen kell jól csinálni ugyanazt — és csak az egyik
// lett jó. A saját kocsi sebességkorlátos órát kapott, a többieké viszont egy
// egyszerű változó volt, amit minden snapshot felülírt:
//
//     renderTime = nowServer - interpDelayMs;   // 100 → 225 egy képkocka alatt
//
// Mérve (2026-08-20, három diagnosztikai felvétel): a késleltetés egyetlen
// snapshot alatt 125 ms-ot ugrott, vagyis a távoli idővonal ennyit lépett
// VISSZA — 200 km/h-nál hét méter. Utána ~1,5 s alatt mászott vissza, ami
// alatt a távoli autó 22%-kal gyorsabban játszott le.
//
// A szabály, amiből ez a modul indul, nem az, hogy „lassan változzon", hanem:
//
//   A RENDERÓRA SOSEM MEHET HÁTRA.
//
// Mélyebb puffer kell → LASSÍTUNK. Sekélyebb kell → gyorsítunk egy kicsit.
// Mindkettő monoton; egy visszalépés viszont újra megmutat egy már látott
// pillanatot, és pont ezt olvassa a szem ugrásnak.
//
// A tűrés fogyasztónként más, és ez szándékos:
//   - a saját kocsinál a lassítás INPUT-KÉSLELTETÉS, amit a kezed érez, ezért
//     szűk a sáv, és a puffer tartománya is kicsi (33–100 ms);
//   - a többieknél a mélyítés BIZTONSÁGI kérdés (üres puffer = megálló autó),
//     a sekélyítés csak kényelmi, ezért tág és aszimmetrikus a sáv.

import { SNAPSHOT_RATE } from './protocol.js';

export const SNAPSHOT_INTERVAL_MS = 1000 / SNAPSHOT_RATE;

// A saját kocsi: a mostani, bevált tűrés. Szándékosan változatlan — ez az út
// működött, itt csak a közös mechanizmusra állunk át.
export const LOCAL_CLOCK_RATE_MIN = 0.985;
export const LOCAL_CLOCK_RATE_MAX = 1.005;

// A többiek: mélyíteni gyorsan, sekélyíteni lassan. 0,85 azt jelenti, hogy
// 100 ms valós idő alatt 15 ms késleltetést nyerünk — egy 125 ms-os mélyítés
// így 0,8 másodperc alatt megvan, végig folyamatos mozgással.
export const REMOTE_CLOCK_RATE_MIN = 0.85;
export const REMOTE_CLOCK_RATE_MAX = 1.05;

// Ekkora eltérésnél feladjuk a fokozatosságot. Nem szépészeti határ: ennyivel
// a cél alatt a puffer már ÜRES, tehát a "folyamatos" mozgás úgyis csak a
// puffer végén álló utolsó minta ismételgetése lenne. Ilyenkor az őszinte
// ugrás a jobb — és jelezzük is a hívónak, hogy a képi simítót nullázhassa.
export const RENDER_CLOCK_RESYNC_MS = 500;

// Ennél hosszabb szünet után (háttérfül, alvó gép) nincs értelme a rég kidobott
// pufferhez visszakapaszkodni.
const MAX_ELAPSED_MS = 250;

// Egy képkockányi elmozdulás felső korlátja: egy hosszú képkocka ne rántsa
// előre az órát egy fél másodpercet.
const MAX_STEP_MS = 100;

// Mekkora sebességkorrekciót kérünk adott hibára. 1000 azt jelenti, hogy
// 100 ms eltérésnél 10%-ot — a tényleges értéket utána a sáv vágja le.
const RATE_GAIN_MS = 1000;

/**
 * Egy lépés a renderórán.
 *
 * @returns {{at:number, rate:number, resynced:boolean}} `at` a kirajzolandó
 *   pillanat, `rate` a következő híváshoz visszaadandó sebesség, `resynced`
 *   pedig azt jelzi, hogy az óra ugrott (a hívó ilyenkor a képi simítót is
 *   újraindíthatja, különben másodpercekig csúszna a helyére).
 */
export function advanceRenderClock({
  renderAtMs,
  previousNowMs,
  nowMs,
  targetDelayMs,
  playbackRate = 1,
  rateMin,
  rateMax,
  minDelayMs = 0,
  maxDelayMs = Infinity,
  resyncMs = RENDER_CLOCK_RESYNC_MS,
}) {
  const now = Number(nowMs) || 0;
  const target = Math.max(
    minDelayMs,
    Math.min(maxDelayMs, Number(targetDelayMs) || minDelayMs)
  );
  const previousNow = Number(previousNowMs);
  const renderAt = Number(renderAtMs);
  const rawElapsed = now - previousNow;

  // Első képkocka, háttérből visszatérés, vagy visszafelé lépő óra.
  if (!Number.isFinite(renderAt) || !Number.isFinite(previousNow)
      || rawElapsed < 0 || rawElapsed > MAX_ELAPSED_MS) {
    return { at: now - target, rate: 1, resynced: true };
  }

  const currentDelay = previousNow - renderAt;
  const delayError = currentDelay - target;

  // Reménytelenül sekély (vagy abszurdan mély) puffer: ugrunk, és szólunk.
  if (Math.abs(delayError) > resyncMs) {
    return { at: now - target, rate: 1, resynced: true };
  }

  const previousRate = Math.max(rateMin, Math.min(rateMax, Number(playbackRate) || 1));
  const elapsed = Math.min(MAX_STEP_MS, rawElapsed);
  const desiredRate = Math.max(
    rateMin,
    Math.min(rateMax, 1 + delayError / RATE_GAIN_MS)
  );
  // Kb. negyed másodperces lecsengés: maga a korrekció INDULÁSA se legyen
  // észrevehető sebességlépcső.
  const blend = 1 - Math.exp(-elapsed / 250);
  const rate = previousRate + (desiredRate - previousRate) * blend;
  // `rate` a sávon belül van, `elapsed` nem negatív — az óra tehát monoton.
  return { at: renderAt + elapsed * rate, rate, resynced: false };
}

// ---------- A távoli puffer célmélysége ----------
//
// A régi becslő két EGYMÁS UTÁNI csomag transit-különbségét átlagolta:
//
//     snapshotJitterMs += (|transit - előző| - snapshotJitterMs) * 0.2;
//
// Ezzel két baj van, és mindkettő látszik a felvételeken.
//
// 1. EGY késve érkező csomag KÉTSZER számít bele: egyszer, amikor felszökik a
//    transit, másodszor, amikor visszaesik.
//
// 2. Kötegnél teljesen mást mér, mint amit hisz. A 2026-08-20-i felvételen egy
//    277 ms-os szünet után öt snapshot érkezett ugyanabban az ezredmásodpercben,
//    250 / 200 / 145 / 99 / 43 ms transittal. A köztük lévő ~50 ms különbség
//    nem ingadozás — az a SZERVER KÜLDÉSI ÜTEME. A becslő mégis mindegyiket
//    jitterként nyelte le (22 → 63), és a késleltetést jóval azután is fent
//    tartotta, hogy a hálózat rendbe jött.
//
// Amit valójában tudni akarunk: „milyen mély puffer kell ahhoz, hogy a csomagok
// döntő többsége IDŐBEN odaérjen?" Erre a kérdésre a transit-értékek eloszlása
// válaszol, nem a szomszédos különbségük. Egy csúszóablak p95-e pontosan ez.

export const TRANSIT_WINDOW_MS = 3000;
export const TRANSIT_TARGET_PERCENTILE = 0.95;
// Ráhagyás a p95 fölé. Egy snapshot-köz azért kell, hogy a kirajzolt pillanat
// két VALÓDI minta közé essen, ne az utolsó ismertre; a 25 ms pedig tartalék.
//
// A két értéket nem hasra ütöttük: a három 2026-08-20-i felvételt visszajátszva
// ez az a ráhagyás, ami a jó vonalakon a régivel azonos frissességet és üres-
// puffer arányt adja (106 ms / 0,7% és 116 ms / 1,8%, szemben a 103/0,6 és
// 109/1,4 eredetivel), a rossz vonalon pedig változatlan üres-puffer mellett
// 55 ms-mal mélyebb — miközben az idővonal EGYSZER SEM lép hátra (a régi
// 7, 11 és 57 alkalommal lépett).
export const TRANSIT_HEADROOM_MS = 25;

/**
 * Új transit-minta az ablakba. A tömböt HELYBEN módosítja (képkockánként
 * többször is hívódhat, ne szemeteljen).
 */
export function pushTransitSample(samples, transitMs, nowMs, windowMs = TRANSIT_WINDOW_MS) {
  samples.push({ t: Number(nowMs) || 0, v: Math.max(0, Number(transitMs) || 0) });
  return expireTransitSamples(samples, nowMs, windowMs);
}

/**
 * Az ablakból kiöregedett minták eldobása új minta nélkül.
 *
 * Külön hívható, mert az ablaknak akkor is telnie kell, ha épp NEM jön
 * snapshot: egy megszakadt kapcsolat után különben a régi, magas minták
 * tartanák mélyen a puffert, jóval azután is, hogy a vonal rendbe jött.
 * Az utolsó mintát mindig meghagyjuk — jobb egy elavult becslés, mint semmi.
 */
export function expireTransitSamples(samples, nowMs, windowMs = TRANSIT_WINDOW_MS) {
  const cutoff = (Number(nowMs) || 0) - windowMs;
  // Az ablak eleje mindig a legrégebbi elem: elég előlről vágni.
  while (samples.length > 1 && samples[0].t < cutoff) samples.shift();
  return samples;
}

/** Az ablak percentilise. Üres ablakra nullát ad. */
export function transitPercentile(samples, q = TRANSIT_TARGET_PERCENTILE) {
  if (!samples.length) return 0;
  const sorted = samples.map((s) => s.v).sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

/**
 * A távoli idővonal célmélysége: a transit p95-e plusz ráhagyás.
 *
 * Ez a szám arra a kérdésre felel, hogy „milyen mély puffer kell ahhoz, hogy a
 * csomagok döntő többsége IDŐBEN odaérjen" — és pont ezt kell tudnunk.
 */
export function remoteDelayTarget(samples, { minMs, maxMs }) {
  const p95 = transitPercentile(samples);
  return Math.max(
    minMs,
    Math.min(maxMs, p95 + SNAPSHOT_INTERVAL_MS + TRANSIT_HEADROOM_MS)
  );
}

/**
 * A megfigyelt ingadozás — a diagnosztikai naplónak, nem a szabályozásnak.
 * A p95 és a p50 különbsége: mennyivel érkeznek később a lemaradó csomagok,
 * mint a tipikus. Ez az, amit a régi „szomszédos különbségek átlaga" mérni
 * akart, de kötegnél nem tudott.
 */
export function transitSpreadMs(samples) {
  return transitPercentile(samples, TRANSIT_TARGET_PERCENTILE)
    - transitPercentile(samples, 0.5);
}
