import test from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { getManifest } from '../server/assets.js';
import { RaceSim } from '../server/game/raceSim.js';
import { ROOM_STATE } from '../shared/protocol.js';

await RAPIER.init();

// Egy szoba, ami már a visszaszámlálásnál tart, MIELŐTT a szimuláció elkészülne.
// Pontosan ez az éles sorrend, ha a kliens gyorsabban tölt be, mint ahogy a
// szerver felépíti a fizikát: a RACE_STARTING-re küldött SET_READY elindítja a
// 3-2-1-et, miközben a room.sim még nem létezik.
function roomAlreadyCountingDown(mapId, countdownEndsAt) {
  const players = new Map([['one', { id: 'one', slot: 0, carId: 'car' }]]);
  return {
    code: 'TEST', players, mapId, laps: 1,
    state: ROOM_STATE.COUNTDOWN,
    countdownEndsAt,
    recordLap: async () => {}, recordResults: async () => {}, toJSON: () => ({}),
  };
}

async function startedSim(room, map) {
  const sim = new RaceSim(room, { map, broadcast: () => {} });
  room.sim = sim;
  await sim.start();
  clearInterval(sim.timer);
  sim.timer = null;
  return sim;
}

test('a simulation that comes up mid-countdown still releases its cars', async () => {
  const map = (await getManifest()).maps.find((entry) => entry.collision);
  assert.ok(map, 'at least one baked map is required');

  // A visszaszámlálás vége már ELMÚLT, mire a fizika elkészült — a versenynek
  // tehát azonnal élnie kell.
  const room = roomAlreadyCountingDown(map.id, Date.now() - 1000);
  const sim = await startedSim(room, map);

  try {
    const car = sim.cars.get('one');
    const before = car.body.translation();

    // Teljes gáz két másodpercig. Befagyasztva a szerver kézifékkel tartja a
    // kocsit, és ez a távolság nulla marad — pontosan ez volt élesben.
    for (let tick = 0; tick < 120; tick++) {
      car.queue.push({ steer: 0, throttle: 1, brake: false, handbrake: false, seq: tick + 1 });
      sim.step();
    }

    const after = car.body.translation();
    const moved = Math.hypot(after.x - before.x, after.z - before.z);
    assert.ok(
      moved > 3,
      `a kocsi ${moved.toFixed(2)} m-t haladt teljes gázzal — befagyasztva maradt`
    );
  } finally {
    sim.stop();
  }
});

test('a simulation that comes up before the countdown stays frozen until released', async () => {
  const map = (await getManifest()).maps.find((entry) => entry.collision);
  const room = roomAlreadyCountingDown(map.id, 0);
  // A szokásos sorrend: a szoba még betölt, nincs rajtidő.
  room.state = ROOM_STATE.LOADING;
  room.countdownEndsAt = 0;
  const sim = await startedSim(room, map);

  try {
    const car = sim.cars.get('one');
    const before = car.body.translation();
    for (let tick = 0; tick < 120; tick++) {
      car.queue.push({ steer: 0, throttle: 1, brake: false, handbrake: false, seq: tick + 1 });
      sim.step();
    }
    const after = car.body.translation();
    const moved = Math.hypot(after.x - before.x, after.z - before.z);
    // A rajt előtt a gáz NEM vihet előre: enélkül a visszaszámlálás alatt el
    // lehetne lopni egy indulást.
    assert.ok(moved < 0.5, `a kocsi ${moved.toFixed(2)} m-t haladt a rajt ELŐTT`);

    // Elengedés után viszont azonnal indulnia kell.
    sim.releaseAt(sim.simTimeMs);
    for (let tick = 0; tick < 120; tick++) {
      car.queue.push({ steer: 0, throttle: 1, brake: false, handbrake: false, seq: 200 + tick });
      sim.step();
    }
    const released = car.body.translation();
    assert.ok(
      Math.hypot(released.x - after.x, released.z - after.z) > 3,
      'elengedés után is állva maradt'
    );
  } finally {
    sim.stop();
  }
});
