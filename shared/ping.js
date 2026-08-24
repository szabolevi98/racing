// A ping-doboz SZÍNE és a felugró figyelmeztető sáv két külön kérdés, ezért
// két külön küszöb.
//
// A szín 60 ms-tól piros: onnantól a késés már érezhető, és jó, ha a játékos
// egy pillantással látja. A sáv viszont csak 100 ms-tól jön elő — 100-ig a
// játék még játszható, egy folyton kint lévő figyelmeztetés ott nem segít,
// csak takarja a pályát.
export const HIGH_PING_ALERT_MS = 100;
// Ennyi ideig tartó képkocka már érezhető helyi akadás, és a főszálon érkező
// PONG feldolgozását is ugyanennyivel késleltetheti. Ez nem hálózati RTT.
export const CLIENT_FRAME_STALL_THRESHOLD_MS = 50;

export function isClientFrameStall(elapsedMs) {
  return Math.max(0, Number(elapsedMs) || 0) >= CLIENT_FRAME_STALL_THRESHOLD_MS;
}

export function classifyPing(ms) {
  const value = Math.max(0, Math.round(Number(ms) || 0));
  const quality = value < 30 ? 'good' : value < 60 ? 'warning' : 'bad';
  return { value, quality };
}

// Kiírjuk-e a figyelmeztető sávot? Szándékosan NEM a `quality`-ből dolgozik:
// az a színt szabja meg, és a kettőnek nem kell egyszerre váltania.
export function shouldWarnAboutPing(ms) {
  return classifyPing(ms).value >= HIGH_PING_ALERT_MS;
}

// A felfele ugró mintát tompítjuk, mert egyetlen torlódott csomag ne rángassa
// meg a HUD-ot és a távoli autók renderpufferét. Lefelé viszont gyorsabban
// követjük a mérést: ha a hálózat már helyreállt, ne mutassunk még 10-15
// másodpercig egy régi, több száz milliszekundumos értéket.
export function smoothPing(previousMs, sampleMs) {
  const sample = Math.max(0, Number(sampleMs) || 0);
  const previous = Math.max(0, Number(previousMs) || 0);
  if (!previous) return sample;
  const weight = sample < previous ? 0.7 : 0.25;
  return previous + (sample - previous) * weight;
}

// ---------- A szerveróra becslésének mintaszűrése ----------
//
// Az órabecslés `serverNow + rtt/2` alakú, ami SZIMMETRIKUS hálózati utat
// feltételez. Egy torlódott csomagnál ez nagyot téved, és a hiba fele
// egyenesen a becslésbe megy. Mérve, 30 ms-os valódi ping mellett: egy 500
// ms-os minta 235 ms hibát jelent, aminek a súlyozott része azonnal eltolja az
// órát — az óra pedig MINDEN távoli kocsi interpolációját hajtja, tehát
// egyszerre ugranak.
//
// A legkevésbé késleltetett csomag torzít a legkevésbé, ezért a minimum
// közelébe eső mintákat fogadjuk csak el.
export const CLOCK_SAMPLE_MAX_RATIO = 1.5;
export const CLOCK_SAMPLE_MARGIN_MS = 20;

// A futó minimum: lefelé azonnal követ, felfelé mintánként 1 ms-t kúszik.
// Az utóbbi azért kell, hogy egy tartósan romló hálózathoz hozzáigazodjon —
// enélkül egyetlen szerencsés csomag örökre kizárná az összes többit.
export function updateMinRtt(previousMin, sampleMs) {
  const sample = Math.max(0, Number(sampleMs) || 0);
  if (!Number.isFinite(previousMin)) return sample;
  return sample < previousMin ? sample : previousMin + 1;
}

// Elég közel van-e a minta a minimumhoz ahhoz, hogy az órát frissítse?
// A margó a kis pingű (LAN, localhost) esetekhez kell: 2 ms minimumnál a
// puszta arány már 3 ms-nál kizárna, ami értelmetlenül szigorú.
export function acceptsClockSample(sampleMs, minRttMs) {
  if (!Number.isFinite(minRttMs)) return true;
  return sampleMs <= minRttMs * CLOCK_SAMPLE_MAX_RATIO + CLOCK_SAMPLE_MARGIN_MS;
}
