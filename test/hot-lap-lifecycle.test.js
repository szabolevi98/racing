import test from 'node:test';
import assert from 'node:assert/strict';
import { RaceController } from '../server/game/raceController.js';
import { GAME_MODE, ROOM_STATE, S2C, TAINT } from '../shared/protocol.js';

test('Hot Lap warm-up ignores checkpoints before the timing line', () => {
  const room = {
    laps: 1,
    mode: GAME_MODE.HOT_LAP,
    players: new Map([['driver', { id: 'driver' }]]),
  };
  const sim = new RaceController(room, {
    map: {
      gates: {
        start: { x1: 20, z1: -2, x2: 20, z2: 2 },
        checkpoints: [
          { x1: 2, z1: -2, x2: 2, z2: 2 },
          { x1: 5, z1: -2, x2: 5, z2: 2 },
        ],
      },
    },
    broadcast: () => {},
  });
  const race = {
    lap: 0,
    nextCheckpoint: 0,
    passed: new Set(),
    taintReason: TAINT.NONE,
    hasCrossedStart: false,
    ghostFrames: null,
    progressKey: -1,
    splits: new Map(),
    finished: false,
    prevX: 4,
    prevZ: 0,
    prevAt: 900,
    lapTimes: [],
    lastGhostSampleAt: 0,
    validationAlertLap: -1,
  };
  sim.cars.set('driver', {
    playerId: 'driver',
    state: {
      p: [6, 0, 0], q: [0, 0, 0, 1], v: [0, 0, 0], w: [0, 0, 0], offtrack: false,
    },
    race,
    respawn: { x: 0, z: 0, heading: 0 },
  });

  // A felvezetés közvetlenül a második checkpointon halad át. Ez mért körben
  // kihagyás lenne, a rajtvonal előtt viszont sem állapotot, sem alertet nem adhat.
  sim.updateCarProgress(sim.cars.get('driver'), 1_000);

  assert.equal(race.nextCheckpoint, 0);
  assert.equal(race.passed.size, 0);
  assert.equal(race.taintReason, TAINT.NONE);
});

test('an old Hot Lap finish cannot overwrite a restarted attempt', async () => {
  let releaseResults;
  const resultsSaved = new Promise((resolve) => { releaseResults = resolve; });
  const broadcasts = [];
  const player = { id: 'driver', carId: 'f2004' };
  const room = {
    state: ROOM_STATE.RACING,
    raceGeneration: 1,
    raceId: 101,
    players: new Map([[player.id, player]]),
    async recordResults(results, raceId) {
      assert.equal(raceId, 101);
      await resultsSaved;
    },
    toJSON() { return { state: this.state }; },
  };
  const sim = new RaceController(room, {
    map: {}, generation: 1, raceId: 101,
    broadcast: (type, data) => broadcasts.push({ type, data }),
  });
  sim.cars.set(player.id, {
    playerId: player.id,
    race: {
      lap: 1,
      lapTimes: [{ time: 60_000, invalid: false }],
      finishedAt: 70_000,
    },
  });
  sim.stop = () => { sim.stopped = true; };
  room.sim = sim;

  const ending = sim.endRace();
  await Promise.resolve();

  // Ugyanez történik, amikor az R új generációt és új szimulációt indít.
  room.raceGeneration = 2;
  room.state = ROOM_STATE.LOADING;
  room.raceId = 202;
  room.sim = { newAttempt: true };
  releaseResults();
  await ending;

  assert.equal(room.state, ROOM_STATE.LOADING);
  assert.equal(room.raceId, 202);
  assert.deepEqual(room.sim, { newAttempt: true });
  assert.equal(broadcasts.some(({ type }) => type === S2C.RACE_END), false);
});

test('Hot Lap R accepts the first new state without waiting for an old sequence number', async () => {
  const player = { id: 'driver', carId: 'f2004' };
  const room = {
    laps: 1,
    mode: GAME_MODE.HOT_LAP,
    state: ROOM_STATE.LOADING,
    countdownEndsAt: 0,
    players: new Map([[player.id, player]]),
  };
  const sim = new RaceController(room, {
    map: {
      spawns: [{ x: 0, z: 0, heading: 0 }],
      gates: { start: { x1: 10, z1: -2, x2: 10, z2: 2 }, checkpoints: [] },
    },
    broadcast: () => {},
  });
  await sim.start();
  clearInterval(sim.timer);
  sim.timer = null;

  const packet = (seq, x) => ({
    seq, p: [x, 0, 0], q: [0, 0, 0, 1],
    v: [1, 0, 0], w: [0, 0, 0], st: 0, wr: 0, th: 1,
  });

  // Az R után még beérhet egy régi, magas sorszámú állapot az R helyéről.
  assert.equal(sim.receiveState(player.id, packet(50, 30), { receivedAt: 1_000 }), true);
  // A kliens kezdőállapota visszateszi az autót a felvezető elejére, de a
  // sorszámnak ugyanonnan kell folytatódnia, nem nulláról újraindulnia.
  assert.equal(sim.receiveState(player.id, packet(50, 0), { initial: true, receivedAt: 1_100 }), true);
  room.state = ROOM_STATE.RACING;
  sim.startAt = 0;

  assert.equal(sim.receiveState(player.id, packet(1, 11), { receivedAt: 1_200 }), false);
  assert.equal(sim.receiveState(player.id, packet(51, 11), { receivedAt: 1_300 }), true);
  assert.equal(sim.cars.get(player.id).race.hasCrossedStart, true);
  assert.ok(sim.cars.get(player.id).race.lapStart > 1_200);
  assert.ok(sim.cars.get(player.id).race.lapStart <= 1_300);
});
