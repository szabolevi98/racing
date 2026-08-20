// A behozó (catch-up) fizikai lépések ne ugyanarra az időpontra tegyék a
// távoli autók proxyját.
//
// ChatGPT 5.6 talalata a renderóra-refaktor átnézésekor. Az ütemező egyetlen
// hívásban legfeljebb három lépést futtat egymás után, mindegyiket a SAJÁT
// ütemezett idejével (`next += TICK_MS`). A proxy időpontja viszont
// `serverNow()` volt — a falióra —, ami három egymás utáni lépésben
// gyakorlatilag ugyanaz. Így a saját autónk három ticknyit haladt, a
// többiek proxyja meg állt; kontaktban ez háromszorozza a benyomódást.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const mp = await fs.readFile(new URL('../web/mp.js', import.meta.url), 'utf8');

test('a proxy időpontja a lépés ütemezett idejéből jön, nem a faliórából', () => {
  assert.match(mp, /at: serverTimeFor\(scheduledAt\)/,
    'a proxy-időnek a lépés saját idejét kell kapnia');
  assert.doesNotMatch(mp, /\n {4}at: serverNow\(\),/,
    'a nyers serverNow() nem maradhat a bemenet időbélyegében');
});

test('ugyanaz az átváltás hajtja az elküldött állapot időbélyegét is', () => {
  // Korábban ez a képlet kézzel, egy helyen szerepelt. Egy forrás, két hívó.
  assert.match(mp, /const steppedAt = scheduledAt \+ TICK_MS;/);
  assert.match(mp, /recordPhysState\(steppedAt, state\)/,
    'a helyi renderpuffer a world.step utáni időpontot kapja');
  assert.match(mp, /t: serverTimeFor\(steppedAt\)/,
    'a dróton küldött post-step állapot nem lehet egy tickkel visszadátumozva');
  assert.match(mp, /function serverTimeFor\(localMs\) \{\s*\n\s*return serverNow\(\) \+ \(localMs - performance\.now\(\)\);/);
});

test('a behozatal három lépése három KÜLÖN időpontot ad', () => {
  // Az átváltás matematikája: serverTimeFor(t) = serverNow() + (t - now).
  // A hurok `next`-je ticksenként nő, tehát a különbség pontosan TICK_MS.
  const TICK_MS = 1000 / 60;
  const serverNow = () => 100000;      // a falióra áll a behozatal alatt
  const perfNow = () => 5000;
  const serverTimeFor = (localMs) => serverNow() + (localMs - perfNow());
  const idok = [0, 1, 2].map((i) => serverTimeFor(4950 + i * TICK_MS));
  for (let i = 1; i < idok.length; i++) {
    assert.ok(Math.abs((idok[i] - idok[i - 1]) - TICK_MS) < 1e-9,
      `a lépések közt egy ticknyi legyen: ${idok[i] - idok[i - 1]} ms`);
  }
  // A régi viselkedés: mindhárom ugyanaz lett volna.
  const regi = [0, 1, 2].map(() => serverNow());
  assert.equal(new Set(regi).size, 1, 'a régi úton mindhárom azonos volt');
});
