// A közös renderóra és a távoli puffer célmélysége.
//
// A mérce mindenhol ugyanaz: a kirajzolt pillanat SOSEM léphet vissza. Egy
// visszalépés újra megmutat egy már látott időpontot, és pont ezt olvassa a
// szem ugrásnak.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceRenderClock, pushTransitSample, expireTransitSamples,
  transitPercentile, transitSpreadMs, remoteDelayTarget,
  REMOTE_CLOCK_RATE_MIN, REMOTE_CLOCK_RATE_MAX, RENDER_CLOCK_RESYNC_MS,
  SNAPSHOT_INTERVAL_MS, TRANSIT_HEADROOM_MS, TRANSIT_WINDOW_MS,
} from '../shared/renderClock.js';

const MIN = 100, MAX = 400, FRAME = 1000 / 60;

const remote = (renderAtMs, previousNowMs, nowMs, targetDelayMs, playbackRate) =>
  advanceRenderClock({
    renderAtMs, previousNowMs, nowMs, targetDelayMs, playbackRate,
    rateMin: REMOTE_CLOCK_RATE_MIN, rateMax: REMOTE_CLOCK_RATE_MAX,
    minDelayMs: MIN, maxDelayMs: MAX,
  });

test('a távoli óra a célmélység ugrálása közben is monoton marad', () => {
  let now = 5000;
  let clock = remote(NaN, NaN, now, MIN);
  let previousAt = clock.at;
  let jumps = 0;
  for (let frame = 0; frame < 900; frame++) {
    const previousNow = now;
    now += FRAME;
    // A cél 100 és 400 közt ide-oda csapkod — pont az a minta, amit a valódi
    // hálózat csinál, és amitől a régi kód lépcsőzött.
    const target = frame % 40 < 20 ? MAX : MIN;
    clock = remote(clock.at, previousNow, now, target, clock.rate);
    if (clock.at < previousAt) jumps++;
    assert.ok(clock.rate >= REMOTE_CLOCK_RATE_MIN && clock.rate <= REMOTE_CLOCK_RATE_MAX);
    previousAt = clock.at;
  }
  assert.equal(jumps, 0, 'az idővonal egyszer sem léphet vissza');
});

test('a mélyítés lassítással történik, nem visszalépéssel', () => {
  let now = 0;
  let clock = remote(NaN, NaN, now, MIN);
  const kezdet = clock.at;
  let previousNow = now;
  // Hirtelen 125 ms-mal mélyebb puffer kell — pont akkora ugrás, amekkorát a
  // 2026-08-20-i felvételen a régi kód egyetlen snapshot alatt megtett.
  for (let frame = 0; frame < 60; frame++) {
    previousNow = now;
    now += FRAME;
    clock = remote(clock.at, previousNow, now, MIN + 125, clock.rate);
  }
  const eltelt = now - 0;
  const haladt = clock.at - kezdet;
  assert.ok(haladt > 0, 'közben is haladt előre');
  assert.ok(haladt < eltelt, 'de lassabban, mint a valós idő — ettől mélyül a puffer');
  const megvalosult = now - clock.at;
  assert.ok(megvalosult > MIN + 60, `egy másodperc alatt érdemben mélyült: ${megvalosult.toFixed(0)} ms`);
});

test('reménytelenül lemaradt óránál ugrik — de ELŐRE, nem vissza', () => {
  // Az óra a küszöbnél is jobban lemaradt. Ezt 1,05-ös ütemmel tíz
  // másodpercig kellene ledolgozni; ilyenkor az őszinte ugrás a jobb.
  const lemaradas = MIN + RENDER_CLOCK_RESYNC_MS + 1;
  const ugras = remote(2000 - lemaradas, 2000, 2000 + FRAME, MIN, 1);
  assert.equal(ugras.resynced, true);
  assert.equal(ugras.rate, 1);
  assert.ok(ugras.at > 2000 - lemaradas, 'a resync sem viheti vissza az idővonalat');

  // A másik irány nem is tud idáig fajulni: a célmélység a plafonnál (400 ms)
  // megáll, a megvalósult késleltetés pedig nem mehet nulla alá — a kettő közti
  // eltérés így sosem éri el az 500 ms-os küszöböt. A sekély puffert tehát
  // MINDIG lassítással mélyítjük, ugrás nélkül.
  const sekely = remote(1000, 1000, 1000 + FRAME, MAX, 1);
  assert.equal(sekely.resynced, false);

  const sima = remote(1000 - MIN, 1000, 1000 + FRAME, MIN, 1);
  assert.equal(sima.resynced, false);
});

test('háttérből visszatérve nem kapaszkodik a rég kidobott pufferhez', () => {
  const vissza = remote(1000, 1000, 1000 + 5000, MIN, 1);
  assert.equal(vissza.at, 1000 + 5000 - MIN);
  assert.equal(vissza.resynced, true);
});

test('egymást követő 100–250 ms-os renderakadások sem mélyítik el az órát', () => {
  const localMin = SNAPSHOT_INTERVAL_MS * 2 / 3;
  const localMax = SNAPSHOT_INTERVAL_MS * 2;
  const local = (renderAtMs, previousNowMs, nowMs, targetDelayMs, playbackRate) =>
    advanceRenderClock({
      renderAtMs, previousNowMs, nowMs, targetDelayMs, playbackRate,
      rateMin: 0.985, rateMax: 1.005,
      minDelayMs: localMin, maxDelayMs: localMax,
    });

  let now = 1000;
  let clock = local(NaN, NaN, now, localMin, 1);
  let previousAt = clock.at;
  // A 2026-08-25-i exportban pontosan ez a három renderidő hagyta a saját
  // autó képét 359 ms-mal a fizika mögött, noha a cél plafonja 100 ms volt.
  for (const gap of [247.4, 226.5, 143.8]) {
    const previousNow = now;
    now += gap;
    clock = local(clock.at, previousNow, now, localMax, clock.rate);
    assert.ok(clock.at >= previousAt, 'a helyreállítás sem léphet vissza');
    assert.ok(now - clock.at <= localMax + 1e-9,
      `a megvalósult késés maradjon a plafonon belül: ${now - clock.at}`);
    assert.equal(clock.resynced, true);
    previousAt = clock.at;
  }
});

// ---- A célmélység becslése ----

test('a percentilis és a szórás az ablakból jön', () => {
  const w = [];
  for (const v of [10, 12, 11, 13, 90, 12, 11, 10, 12, 11]) pushTransitSample(w, v, 0);
  assert.equal(transitPercentile(w, 0.5), 11);
  assert.equal(transitPercentile(w, 1), 90);
  assert.ok(transitSpreadMs(w) > 0, 'a kilógó minta megjelenik a szórásban');
});

test('a kiöregedett minták új minta nélkül is kiesnek', () => {
  const w = [];
  pushTransitSample(w, 300, 0);
  pushTransitSample(w, 300, 100);
  expireTransitSamples(w, TRANSIT_WINDOW_MS + 1000);
  assert.equal(w.length, 1, 'az utolsó minta megmarad — jobb elavult becslés, mint semmi');
});

// Ez a modul létezésének oka. A 2026-08-20-i felvételen 277 ms-nyi csend után
// öt snapshot érkezett UGYANABBAN az ezredmásodpercben, 250/200/145/99/43 ms
// transittal. A régi becslő a köztük lévő ~50 ms különbséget jitternek nézte —
// pedig az a szerver küldési üteme —, és a késleltetést jóval a hálózat
// helyreállása után is fent tartotta.
test('a kötegben érkező snapshotok nem fújják fel a célmélységet', () => {
  const KOTEG = [250, 200, 145, 99, 43];

  // A RÉGI becslő, ahogy a kódban állt: a szomszédos transit-különbségek
  // exponenciális átlaga, kétszeres súllyal a késleltetésben.
  let transitEwma = 20, jitterEwma = 0, elozo = 20;
  const regiMinta = (v) => {
    jitterEwma += (Math.abs(v - elozo) - jitterEwma) * 0.2;
    elozo = v;
    transitEwma = transitEwma * 0.8 + v * 0.2;
    return transitEwma + 75 + jitterEwma * 2;
  };
  for (let i = 0; i < 60; i++) regiMinta(20);
  let regi = 0;
  for (const v of KOTEG) regi = regiMinta(v);

  // Az ÚJ becslő ugyanazon az adaton.
  const w = [];
  for (let i = 0; i < 60; i++) pushTransitSample(w, 20, i * 50);
  const alap = remoteDelayTarget(w, { minMs: MIN, maxMs: MAX });
  for (const v of KOTEG) pushTransitSample(w, v, 3000);
  const uj = remoteDelayTarget(w, { minMs: MIN, maxMs: MAX });

  // Mélyíteni JOGOS: öt csomag tényleg negyed másodpercet késett. Csak nem
  // annyival, amennyit a régi becslő kihozott belőle — az minden kötegtagot
  // külön ingadozásként nyelt le, pedig a köztük lévő ~50 ms a szerver
  // küldési üteme.
  assert.ok(uj > alap, 'a valódi késés megjelenik');
  assert.ok(uj < regi, `az új becslés visszafogottabb: ${uj.toFixed(0)} < ${regi.toFixed(0)} ms`);

  // És ami a régiből hiányzott: a köteg hatása AZ ABLAKKAL EGYÜTT jár le, nem
  // egy exponenciális átlag lecsengésével. Amint kiesik, a becslés visszaáll.
  for (let i = 0; i < 60; i++) pushTransitSample(w, 20, 3100 + i * 50);
  assert.equal(remoteDelayTarget(w, { minMs: MIN, maxMs: MAX }), MIN,
    'a nyugodt vonal visszakapja a padlót');
});

test('a célmélység a p95-ből és a ráhagyásból áll, a határok közé vágva', () => {
  const w = [];
  for (let i = 0; i < 100; i++) pushTransitSample(w, 200, i * 50);
  assert.equal(
    remoteDelayTarget(w, { minMs: MIN, maxMs: MAX }),
    200 + SNAPSHOT_INTERVAL_MS + TRANSIT_HEADROOM_MS
  );

  const gyors = [];
  for (let i = 0; i < 100; i++) pushTransitSample(gyors, 5, i * 50);
  assert.equal(remoteDelayTarget(gyors, { minMs: MIN, maxMs: MAX }), MIN, 'jó vonalon a padló');

  const rossz = [];
  for (let i = 0; i < 100; i++) pushTransitSample(rossz, 900, i * 50);
  assert.equal(remoteDelayTarget(rossz, { minMs: MIN, maxMs: MAX }), MAX, 'rossz vonalon a plafon');
});

test('üres ablakra sem ad értelmetlen mélységet', () => {
  assert.equal(transitPercentile([], 0.95), 0);
  assert.equal(remoteDelayTarget([], { minMs: MIN, maxMs: MAX }), MIN);
});

// ChatGPT 5.6 talalata a refaktor atnezesekor, reprodukalva: a resync ag
// megkerulte a monoton szabalyt. Egy epp a 250 ms-os kuszob fole nyulo szunet
// a `now - target`-re ugrott, ami MOGOTTE lehet a mostani renderidonek.
test('a resync sem viheti vissza az idővonalat — sem szünetnél, sem hátráló óránál', () => {
  // Az eredeti reprodukció: renderAt=900, előző jelen=1000 (100 ms mélység),
  // 251 ms szünet, közben a cél 400-ra nőtt. Régen: at=851, azaz 49 ms vissza.
  for (const szunet of [251, 266, 277, 300, 399]) {
    const c = remote(900, 1000, 1000 + szunet, MAX, 1);
    assert.ok(c.at >= 900, `${szunet} ms szünetnél sem léphet vissza: at=${c.at}`);
  }

  // Hátrafelé korrigáló szerveróra: a "jelen" csökken.
  const hatra = remote(900, 1000, 980, MIN, 1);
  assert.ok(hatra.at >= 900, `hátráló óránál sem: at=${hatra.at}`);

  // Ha az óra emiatt a helyén marad, azt NE jelentsük ugrásnak — különben a
  // hívó feleslegesen rántaná a helyükre a távoli autókat.
  const helyben = remote(900, 1000, 1251, MAX, 1);
  assert.equal(helyben.at, 900);
  assert.equal(helyben.resynced, false, 'nem mozdult, tehát nem ugrás');

  // A valódi előreugrás viszont továbbra is ugrás.
  const elore = remote(1000, 1000, 6000, MIN, 1);
  assert.equal(elore.at, 5900);
  assert.equal(elore.resynced, true);
});

test('a helyi főszálfagyás utáni snapshot nem kerülhet a transit p95-be', async () => {
  const source = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../web/mp.js', import.meta.url), 'utf8'));
  assert.match(source, /const STALL_TRANSIT_GRACE_MS = 500/);
  assert.match(source, /const heartbeatLate = lastHeartbeatAt > 0/);
  assert.match(source, /pendingSnapshotTransitTrusted = transitTrusted/);
  assert.match(source, /onSnapshot\(snapshot, transitMs, lastAt, transitTrusted\)/);
  assert.match(source, /if \(transitTrusted\) \{\s*pushTransitSample/);
  assert.match(source, /window\.__mp\.snapshotTransitDropped\+\+/);
});
