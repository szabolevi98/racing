// A szerveróra becslése csak a legkevésbé késleltetett csomagokból dolgozhat.
//
// Az `rtt/2` becslés SZIMMETRIKUS utat feltételez; egy torlódott csomagnál a
// hiba fele egyenesen az órába megy. És az óra minden távoli kocsi
// interpolációját hajtja, tehát egy rossz minta után MINDENKI egyszerre ugrik.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  updateMinRtt, acceptsClockSample, CLOCK_SAMPLE_MAX_RATIO, CLOCK_SAMPLE_MARGIN_MS,
} from '../shared/ping.js';
import fs from 'node:fs';

test('a minimum lefelé azonnal követ', () => {
  assert.equal(updateMinRtt(Infinity, 30), 30, 'az első minta lesz a minimum');
  assert.equal(updateMinRtt(30, 12), 12);
  assert.equal(updateMinRtt(12, 4), 4);
});

test('a minimum felfelé csak lassan kúszik', () => {
  // Enélkül egyetlen szerencsés csomag örökre kizárná az összes többit.
  assert.equal(updateMinRtt(30, 500), 31, 'egy kiugró minta nem viheti fel a minimumot');
  let min = 30;
  for (let i = 0; i < 100; i++) min = updateMinRtt(min, 200);
  assert.equal(min, 130, 'tartósan romló hálózathoz viszont hozzáigazodik');
});

test('a torlódott mintát nem engedjük az órabecslésbe', () => {
  const min = 30;
  assert.equal(acceptsClockSample(30, min), true, 'a minimum maga elfogadható');
  assert.equal(acceptsClockSample(45, min), true, 'a szokásos ingadozás belefér');
  assert.equal(acceptsClockSample(500, min), false, 'egy 500 ms-os kiugrás nem');
  assert.equal(acceptsClockSample(900, min), false);
  // A határ pontosan ott van, ahol a képlet mondja.
  const hatar = min * CLOCK_SAMPLE_MAX_RATIO + CLOCK_SAMPLE_MARGIN_MS;
  assert.equal(acceptsClockSample(hatar, min), true);
  assert.equal(acceptsClockSample(hatar + 0.1, min), false);
});

test('kis pingnél a margó nélkül értelmetlenül szigorú lenne a szűrés', () => {
  // Localhoston/LAN-on 1-2 ms a minimum; puszta aránnyal már 3 ms is kiesne,
  // pedig az ott teljesen normális ingadozás.
  assert.equal(acceptsClockSample(3, 1), true);
  assert.equal(acceptsClockSample(20, 1), true);
  assert.ok(CLOCK_SAMPLE_MARGIN_MS >= 10, 'a margó nem lehet elhanyagolható');
});

test('az első minta mindig elmegy, különben sosem indulna a becslés', () => {
  assert.equal(acceptsClockSample(900, Infinity), true);
});

test('a kliens tényleg ezeket használja, és a kiszűrt mintákat számolja', () => {
  const mp = fs.readFileSync(new URL('../web/mp.js', import.meta.url), 'utf8');
  assert.match(mp, /updateMinRtt, acceptsClockSample/, 'nincs importálva a két szabály');
  assert.match(mp, /pingMinRttMs = updateMinRtt\(pingMinRttMs, rtt\)/);
  assert.match(mp, /!clockReady \|\| acceptsClockSample\(rtt, pingMinRttMs\)/);
  assert.match(mp, /clockSamplesDropped\+\+/, 'a kiszűrt minta nem látszik a diagnosztikában');
});
