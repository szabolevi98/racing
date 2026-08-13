// Az Időmérés addig tart, ameddig a játékos akarja: minden kör lezárul és
// elmentődik, de a futam nem ér véget magától — se az első, se a tizedik kör
// után. A többjátékos futam viszont továbbra is a beállított körszámnál áll le.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RaceController } from '../server/game/raceController.js';
import { Room } from '../server/game/room.js';
import { GAME_MODE, ROOM_STATE } from '../shared/protocol.js';

// Egy rövid, egyenes „pálya": a rajtvonal az X tengelyt metszi z=0-nál, a
// checkpoint z=50-nél. Aki z=-10-ről z=60-ra megy, mindkettőt átlépte.
const GATES = {
  start: { x1: -20, z1: 0, x2: 20, z2: 0 },
  checkpoints: [{ x1: -20, z1: 50, x2: 20, z2: 50 }],
};

function setup(mode, laps) {
  const sent = [];
  const host = { id: 'p1', slot: 0, carId: 'auto', name: 'Vezeto' };
  const room = new Room('TEST01', host, { mapId: 'palya', laps, mode });
  room.add(host, 'auto');
  room.state = ROOM_STATE.RACING;
  room.recordLap = async () => {};
  room.recordResults = async () => {};
  room.toJSON = () => ({});
  const sim = new RaceController(room, {
    map: { spawns: [{ x: 0, z: -10, heading: 0 }], gates: GATES, hotLapSpawn: null },
    broadcast: (type, payload) => sent.push({ type, payload }),
  });
  return { sim, room, sent };
}

// Egy teljes kör: felmegyünk a checkpointon túlra, majd vissza a rajtvonalon át.
let ora = 1_000_000;
function korMegy(sim) {
  const kuld = (z) => {
    ora += 500;
    sim.receiveState('p1', {
      seq: Math.round(ora / 10), p: [0, 1, z], q: [0, 0, 0, 1],
      v: [0, 0, 20], w: [0, 0, 0], st: 0, wr: 0, th: 1,
    }, { receivedAt: ora });
  };
  kuld(20);   // rajtvonal mögül a checkpoint elé
  kuld(60);   // checkpoint átlépve
  kuld(-10);  // vissza a rajtvonalon át: kör lezárva
}

test('Hot Lap keeps going lap after lap', async () => {
  const { sim, room, sent } = setup(GAME_MODE.HOT_LAP, 1);
  assert.equal(room.endlessLaps, true, 'az Időmérésnek nincs körszám-korlátja');
  await sim.start();
  sim.releaseAt(ora - 1000);          // a rajt már megvolt
  try {
    const car = sim.cars.get('p1');
    car.race.prevX = 0;
    car.race.prevZ = -10;
    car.race.prevAt = ora;

    for (let i = 1; i <= 5; i++) {
      korMegy(sim);
      assert.equal(car.race.lap, i, `${i}. kör lezárult`);
      assert.equal(car.race.finished, false, `a ${i}. kör után sem ér véget`);
      assert.equal(sim.stopped, false, 'a szimuláció fut tovább');
    }
    assert.equal(sent.filter((s) => s.payload?.kind === 'lap').length, 5,
      'mind az öt körről ment értesítés');
    assert.equal(sent.some((s) => s.payload?.kind === 'finished'), false,
      'célba érés nincs — nincs mibe beérni');
    assert.equal(sent.some((s) => s.type === 'raceEnd'), false, 'a futam nem zárult le');
    // A ranglistához minden kör ideje kell, nem csak az elsőé.
    assert.equal(car.race.lapTimes.length, 5);
  } finally {
    sim.stop();
  }
});

test('a multiplayer race still ends at its lap count', async () => {
  const { sim, room, sent } = setup(GAME_MODE.MULTIPLAYER, 2);
  assert.equal(room.endlessLaps, false);
  await sim.start();
  sim.releaseAt(ora - 1000);
  try {
    const car = sim.cars.get('p1');
    car.race.prevX = 0;
    car.race.prevZ = -10;
    car.race.prevAt = ora;

    korMegy(sim);
    assert.equal(car.race.finished, false, 'két körből egy még nem elég');
    korMegy(sim);
    assert.equal(car.race.finished, true, 'a második kör után célba ért');
    assert.equal(sent.some((s) => s.payload?.kind === 'finished'), true);
  } finally {
    sim.stop();
  }
});

test('Hot Lap keeps only bounded timing and split history', async () => {
  const { sim } = setup(GAME_MODE.HOT_LAP, 1);
  await sim.start();
  sim.releaseAt(ora - 1000);
  try {
    const car = sim.cars.get('p1');
    car.race.prevX = 0;
    car.race.prevZ = -10;
    car.race.prevAt = ora;
    for (let i = 0; i < 80; i++) korMegy(sim);
    assert.equal(car.race.lap, 80);
    assert.ok(car.race.lapTimes.length <= 64);
    assert.ok(car.race.splits.size <= GATES.checkpoints.length + 1);
    assert.ok(Number.isFinite(car.race.bestLapTime));
  } finally {
    sim.stop();
  }
});
