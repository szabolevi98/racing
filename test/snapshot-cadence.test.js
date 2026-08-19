// A snapshotok ütemének 20 Hz-nek kell lennie, és egyenletesnek.
//
// A kliens interpolációja erre a ütemre épül, a saját adaptív késleltetése
// viszont a csomagok ÉRKEZÉSI KÉSÉSÉNEK ingadozását figyeli, nem a közöket —
// egy egyenetlenül kibocsátó szervert tehát nem is lát, így nem tud rá
// kompenzálni. Innen a "a többiek kocsija ugrál, pedig 60-75 fps van" tünet.
//
// A korábbi hiba: a következő snapshot idejét a MOSTANI tickhez igazította
// (`lastSnapshotAt = now`), így minden köz felfelé kerekedett a tick-rácsra és
// a hiba halmozódott. Valódi Node-időzítővel mérve 66,1 ms lett az 50 helyett,
// vagyis 15,1 Hz a 20 helyett.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RaceController } from '../server/game/raceController.js';
import { Room } from '../server/game/room.js';
import { GAME_MODE, SNAPSHOT_RATE } from '../shared/protocol.js';

const SNAPSHOT_MS = 1000 / SNAPSHOT_RATE;

// A vezérlőt kézzel léptetjük: nem indítunk időzítőt, csak a pump()-ot hívjuk
// a megadott időpontokkal, és nézzük, mikor küldött.
function kozok({ pumpMs, lepesek = 600, akadasNal = null }) {
  const kuldott = [];
  const room = new Room('CADENC', { id: 'p1', slot: 0, carId: 'auto', name: 'A' },
    { mapId: 'palya', laps: 3, mode: GAME_MODE.RACE });
  const c = new RaceController(room, {
    map: { gates: { start: null, checkpoints: [] } },
    send: () => {},
    broadcast: () => {},
  });
  c.sendSnapshot = (now) => kuldott.push(now);

  let t = 0;
  for (let i = 0; i < lepesek; i++) {
    t += pumpMs;
    if (akadasNal && i === akadasNal) t += 400;   // hosszú akadás utánzása
    c.pump(t);
  }
  const k = [];
  for (let i = 1; i < kuldott.length; i++) k.push(kuldott[i] - kuldott[i - 1]);
  return k;
}

test('a snapshot-ütem 20 Hz, nem lassabb', () => {
  const k = kozok({ pumpMs: 8 });
  assert.ok(k.length > 50, 'kevés minta');
  const atlag = k.reduce((s, x) => s + x, 0) / k.length;
  assert.ok(Math.abs(atlag - SNAPSHOT_MS) < 1,
    `az átlagos köz ${atlag.toFixed(1)} ms, a cél ${SNAPSHOT_MS} — a ráta ${(1000 / atlag).toFixed(1)} Hz`);
});

test('a közök egyenletesek: egyik sem nyúlik a periódus másfélszeresére', () => {
  const k = kozok({ pumpMs: 8 });
  const legnagyobb = Math.max(...k);
  assert.ok(legnagyobb <= SNAPSHOT_MS * 1.5,
    `a leghosszabb köz ${legnagyobb} ms, a periódus ${SNAPSHOT_MS}`);
});

test('a 16 ms-os rács sem viszi el a rátát (a hiba nem halmozódhat)', () => {
  // Ez a mérés fogta volna meg az eredeti hibát: durvább tick-rácson is
  // 20 Hz-nek kell maradnia az ÁTLAGNAK.
  const k = kozok({ pumpMs: 16 });
  const atlag = k.reduce((s, x) => s + x, 0) / k.length;
  assert.ok(Math.abs(atlag - SNAPSHOT_MS) < 2,
    `16 ms-os rácson az átlag ${atlag.toFixed(1)} ms lett`);
});

test('hosszú akadás után nem indul sorozat, hogy behozza az elmaradást', () => {
  // A behozás ugyanolyan rossz a kliensnek, mint a késés: egyszerre érkező
  // csomagokból nem lehet simán interpolálni.
  const k = kozok({ pumpMs: 8, akadasNal: 100 });
  const tulSuru = k.filter((x) => x < SNAPSHOT_MS * 0.5);
  assert.equal(tulSuru.length, 0,
    `${tulSuru.length} köz lett a periódus felénél rövidebb: ${tulSuru.slice(0, 5).join(', ')}`);
});
