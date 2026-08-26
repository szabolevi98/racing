// A látható távoli autó és a saját ütközőteste közti rendszeres eltolódás.
//
// A fizikai kontakt a friss becslést használja, a látható modell viszont
// exponenciálisan kúszik oda. Egy ilyen szűrő egyenletes sebességű célt sosem
// ér utol — állandósult állapotban `v * dt * (1-alpha)/alpha`-val marad mögötte.
// Ez az, ami miatt állva, hátulról nekünk jövő autónál a lökés hamarabb jött,
// mint ahogy a kocsi odaért volna a képen.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  smootherLeadSeconds, remoteVisualCorrectionHalfLife,
} from '../shared/remoteVisual.js';

const FPS = 75;
const DT = 1 / FPS;

// A jelenet szimulálása: egyenletes sebességgel haladó cél, exponenciális
// simító. Visszaadja, hány méterrel marad le a kép a céltól, miután beállt.
function allandosultLemaradas(vMps, { lead }) {
  const halfLife = remoteVisualCorrectionHalfLife(106, 1);
  const alpha = 1 - Math.pow(0.5, DT / halfLife);
  const elore = lead ? smootherLeadSeconds(alpha, DT) : 0;
  let cel = 0, kep = 0;
  for (let i = 0; i < 2000; i++) {
    cel += vMps * DT;
    kep += (cel + vMps * elore - kep) * alpha;
  }
  return cel - kep;
}

test('előrecélzás nélkül a kép a sebességgel arányosan marad le', () => {
  // Ez a HIBÁS viselkedés — azért írjuk le, hogy a javítás mértéke látszódjon.
  const kmh200 = allandosultLemaradas(200 / 3.6, { lead: false });
  assert.ok(kmh200 > 4, `200 km/h-nál több mint négy méter: ${kmh200.toFixed(2)} m`);
  // És arányos: kétszeres sebesség, kétszeres lemaradás.
  const kmh100 = allandosultLemaradas(100 / 3.6, { lead: false });
  assert.ok(Math.abs(kmh200 / kmh100 - 2) < 0.01, 'a lemaradás a sebességgel arányos');
});

test('előrecélzással a lemaradás nulla, bármilyen sebességnél', () => {
  for (const kmh of [30, 100, 200, 300]) {
    const maradek = allandosultLemaradas(kmh / 3.6, { lead: true });
    assert.ok(Math.abs(maradek) < 1e-9,
      `${kmh} km/h-nál ne maradjon eltolódás: ${maradek} m`);
  }
});

test('a képkockasebességtől sem függ — a diszkrét maradékot számoljuk, nem a folytonos közelítést', () => {
  const halfLife = remoteVisualCorrectionHalfLife(106, 1);
  for (const fps of [30, 60, 75, 144]) {
    const dt = 1 / fps;
    const alpha = 1 - Math.pow(0.5, dt / halfLife);
    const elore = smootherLeadSeconds(alpha, dt);
    const v = 200 / 3.6;
    let cel = 0, kep = 0;
    for (let i = 0; i < 3000; i++) { cel += v * dt; kep += (cel + v * elore - kep) * alpha; }
    assert.ok(Math.abs(cel - kep) < 1e-9, `${fps} fps-en is nulla: ${(cel - kep)} m`);
  }
});

test('a simítás megmarad: egy ugrásszerű zavart továbbra is elken', () => {
  const halfLife = remoteVisualCorrectionHalfLife(106, 1);
  const alpha = 1 - Math.pow(0.5, DT / halfLife);
  const elore = smootherLeadSeconds(alpha, DT);
  // Álló cél, ami egyszer csak öt métert ugrik (ilyen egy rossz extrapoláció).
  let kep = 0;
  const cel = 5;
  kep += (cel + 0 * elore - kep) * alpha;
  assert.ok(kep < 1.5, `az első képkocka ne vigye oda: ${kep.toFixed(2)} m`);
  assert.ok(kep > 0.05, 'de haladjon felé');
});

test('elfajult bemenetre nem ad értelmetlen előrecélzást', () => {
  assert.equal(smootherLeadSeconds(1, 1 / 60), 0, 'alpha=1: nincs mit kompenzálni');
  assert.equal(smootherLeadSeconds(0, 1 / 60), 0);
  assert.equal(smootherLeadSeconds(0.5, 0), 0);
  assert.equal(smootherLeadSeconds(NaN, 1 / 60), 0);
});

test('a kliens a sebességgel ELŐRE tolt célra simít, és a forgásra is', async () => {
  const mp = await fs.readFile(new URL('../web/mp.js', import.meta.url), 'utf8');
  assert.match(mp, /const lead = smootherLeadSeconds\(alpha, dt\);/);
  assert.match(mp, /const tx = s\.p\[0\] \+ \(v\[0\] \|\| 0\) \* lead;/);
  assert.match(mp, /integrateRotation\(s\.q, s\.w \|\| \[0, 0, 0\], lead\)/);
  assert.match(mp, /const s = remoteStateAt\(o\.buf, localRenderTime\)/,
    'a távoli kép ugyanazt a kirajzolt időpontot kövesse, mint a saját autó');
  assert.doesNotMatch(mp, /blendRemoteStates/,
    'a távolság nem húzhatja előre-hátra a távoli autó idővonalát');
});
