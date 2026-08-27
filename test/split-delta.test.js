// Részidő-különbség: checkpointonként mennyivel vagyunk jobbak vagy
// rosszabbak a viszonyítási körnél.
//
// A két oldal, amit itt mérünk: a szerver adja-e a pontos, kör-relatív
// részidőt, és a szellem felvételéből ugyanaz jön-e ki, mint amit élőben
// mértünk volna. Ha a kettő nem ugyanazt a matekot használná, a delta
// rendszeresen csúszna — épp azt a néhány századot, amiért készül.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  crossingTime, gateCrossingFraction, gateRespawnPoint, ghostCheckpointSplits,
} from '../shared/gate.js';
import { RaceController } from '../server/game/raceController.js';
import { Room } from '../server/game/room.js';
import { GAME_MODE, ROOM_STATE } from '../shared/protocol.js';

// Egyenes „pálya" a z tengely mentén: két checkpoint és a rajtvonal.
const CHECKPOINTS = [
  { x1: -20, z1: 30, x2: 20, z2: 30 },
  { x1: -20, z1: 60, x2: 20, z2: 60 },
];
const GATES = { start: { x1: -20, z1: 0, x2: 20, z2: 0 }, checkpoints: CHECKPOINTS };

test('a crossing is timed between samples, not snapped to one', () => {
  // A szakasz feleútján metsz: az időnek is félúton kell lennie.
  assert.equal(gateCrossingFraction(CHECKPOINTS[0], 0, 20, 0, 40), 0.5);
  assert.equal(crossingTime(CHECKPOINTS[0], 0, 20, 0, 40, 1000, 2000), 1500);
  // Nincs metszés: a szakasz meg sem közelíti a kaput.
  assert.equal(crossingTime(CHECKPOINTS[0], 0, 0, 0, 10, 0, 100), null);
  // A kapu SZÉLESSÉGÉN kívül elhaladva sincs átlépés.
  assert.equal(crossingTime(CHECKPOINTS[0], 500, 20, 500, 40, 0, 100), null);
});

test('reset keeps an asphalt crossing but falls back to the gate middle off track', () => {
  const gate = { x1: 10, z1: -10, x2: 10, z2: 10 };
  assert.deepEqual(
    gateRespawnPoint(gate, 0, 6, 20, 6, (x, z) => x === 10 && z === 6),
    { x: 10, z: 6 }
  );
  assert.deepEqual(
    gateRespawnPoint(gate, 0, 8, 20, 8, () => false),
    { x: 10, z: 0 }
  );
});

test('ghost splits come out of the recorded path with sub-sample accuracy', () => {
  // 10 Hz-es felvétel, egyenletes 100 m/s: a 30 m-es kapu 300 ms-nál van,
  // a 60 m-es 600 ms-nál — tehát MINTÁK KÖZÉ esik mindkettő.
  const frames = [];
  for (let i = 0; i <= 10; i++) frames.push([i * 100, 0, 1, i * 10, 0, 0, 0, 1]);
  const splits = ghostCheckpointSplits(frames, CHECKPOINTS);
  assert.equal(splits.length, 2);
  assert.ok(Math.abs(splits[0] - 300) < 1e-6, `elso checkpoint: ${splits[0]}`);
  assert.ok(Math.abs(splits[1] - 600) < 1e-6, `masodik checkpoint: ${splits[1]}`);
});

test('a ghost that never reached a checkpoint reports null, not a wrong time', () => {
  // A felvétel a 45 m-nél megszakad: a második kapu nincs meg.
  const frames = [];
  for (let i = 0; i <= 4; i++) frames.push([i * 100, 0, 1, i * 10, 0, 0, 0, 1]);
  frames.push([450, 0, 1, 45, 0, 0, 0, 1]);
  const splits = ghostCheckpointSplits(frames, CHECKPOINTS);
  assert.ok(Math.abs(splits[0] - 300) < 1e-6);
  assert.equal(splits[1], null, 'nincs mihez mérni — inkább semmit, mint rosszat');
});

test('ghost splits keep checkpoint order even when one segment spans two gates', () => {
  // Egyetlen ugrás 0-ról 70 m-re: mindkét kaput átvágja ugyanabban a szakaszban.
  const splits = ghostCheckpointSplits([[0, 0, 1, 0, 0, 0, 0, 1], [700, 0, 1, 70, 0, 0, 0, 1]], CHECKPOINTS);
  assert.ok(Math.abs(splits[0] - 300) < 1e-6, `elso: ${splits[0]}`);
  assert.ok(Math.abs(splits[1] - 600) < 1e-6, `masodik: ${splits[1]}`);
  assert.ok(splits[0] < splits[1], 'a sorrend nem fordulhat meg');
});

test('the server reports the current split with the same checkpoint from the best valid lap', async () => {
  const host = { id: 'p1', slot: 0, carId: 'auto', name: 'Vezeto' };
  const room = new Room('SPLIT1', host, { mapId: 'palya', laps: 3, mode: GAME_MODE.MULTIPLAYER });
  room.add(host, 'auto');
  room.state = ROOM_STATE.RACING;
  room.recordLap = async () => {};
  room.recordResults = async () => {};
  room.toJSON = () => ({});
  const sent = [];
  const sim = new RaceController(room, {
    map: { spawns: [{ x: 0, z: -10, heading: 0 }], gates: GATES },
    broadcast: (type, payload) => sent.push({ type, payload }),
  });
  await sim.start();

  let ora = 500_000;
  sim.releaseAt(ora - 1000);
  const car = sim.cars.get('p1');
  car.race.prevX = 0;
  car.race.prevZ = -10;
  car.race.prevAt = ora;
  const kuld = (z, dtMs) => {
    ora += dtMs;
    sim.receiveState('p1', {
      seq: Math.round(ora), p: [0, 1, z], q: [0, 0, 0, 1], v: [0, 0, 20], w: [0, 0, 0],
      st: 0, wr: 0, th: 1,
    }, { receivedAt: ora });
  };
  const utolsoSnapshot = () => {
    sim.sendSnapshot(ora);
    return sent.filter((s) => s.type === 'snapshot').at(-1).payload.cars[0];
  };

  try {
    // A rajtvonal átlépése indítja a kört; a checkpoint még nem jött.
    kuld(10, 1000);
    assert.equal(car.race.hasCrossedStart, true);
    assert.equal(utolsoSnapshot().ci, -1, 'még nincs részidő');

    // Minden átlépés MINTÁK KÖZÉ esik, tehát mindegyik interpolált:
    //   rajtvonal (z=0):     a -10→10 szakasz felén  -> 500 500
    //   1. checkpoint (z=30): a  10→50 szakasz felén  -> 502 000, azaz +1500
    //   2. checkpoint (z=60): a  50→70 szakasz felén  -> 503 500, azaz +3000
    // Egyik érték sem esik snapshot-határra: pont ezért adja a szerver.
    kuld(50, 2000);
    const elso = utolsoSnapshot();
    assert.equal(elso.ci, 0);
    assert.equal(elso.ct, 1500, 'a kör kezdetétől mért, interpolált idő');

    kuld(70, 1000);
    const masodik = utolsoSnapshot();
    assert.equal(masodik.ci, 1);
    assert.equal(masodik.ct, 3000);

    // Új kör: a részidő-jelző nullázódik, hogy ne az előző kör utolsó
    // értékét hasonlítgassa a kliens.
    kuld(-10, 1000);
    assert.equal(car.race.lap, 1, 'lezárult a kör');
    const ujKor = utolsoSnapshot();
    assert.equal(ujKor.ci, -1, 'új körben tiszta lappal indul');
    assert.equal(ujKor.bt, null, 'checkpoint nélkül nincs referencia-részidő');
    assert.deepEqual(car.race.bestLapSplits, [1500, 2999.5]);

    // A tesztpálya a rajtvonalnál „körbetekeredik”: a következő mintát már
    // közvetlenül a vonal utáni pontról indítjuk. A második kör szándékosan
    // lassabb, mégsem válhat a harmadik kör delta-referenciájává.
    car.state.p[2] = 10;
    car.race.prevZ = 10;
    car.race.prevAt = ora;
    kuld(50, 2000);
    const masodikKorElso = utolsoSnapshot();
    assert.equal(masodikKorElso.ci, 0);
    assert.equal(masodikKorElso.bt, 1500, 'a referencia az első kör legjobb részideje');
    kuld(70, 1000);
    kuld(-10, 5000);
    assert.equal(car.race.lap, 2, 'a lassabb második kör is lezárult');
    assert.deepEqual(
      car.race.bestLapSplits,
      [1500, 2999.5],
      'a lassabb előző kör nem írhatja felül a legjobb kör részidőit'
    );

    car.state.p[2] = 10;
    car.race.prevZ = 10;
    car.race.prevAt = ora;
    kuld(50, 2000);
    assert.equal(
      utolsoSnapshot().bt,
      1500,
      'a harmadik kör továbbra is a legjobb, nem az előző körhöz mér'
    );
  } finally {
    sim.stop();
  }
});
