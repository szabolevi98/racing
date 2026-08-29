import test from 'node:test';
import assert from 'node:assert/strict';
import { RaceController, sanitizeClientCarState } from '../server/game/raceController.js';
import { ROOM_STATE, GAME_MODE, S2C, TAINT, TICK_MS, FINISH_GRACE_MS } from '../shared/protocol.js';

const wireState = (seq, t, x, z = 0, extra = {}) => ({
  seq, t,
  p: [x, 0.8, z],
  q: [0, 0, 0, 1],
  v: [10, 0, 0],
  w: [0, 0, 0],
  st: 0.1,
  wr: 4,
  th: 1,
  offtrack: false,
  ...extra,
});

function makeRoom() {
  const player = { id: 'p1', carId: 'car', dbId: 1, slot: 0 };
  return {
    code: 'TEST',
    mode: GAME_MODE.HOT_LAP,
    laps: 1,
    state: ROOM_STATE.LOADING,
    countdownEndsAt: 0,
    raceGeneration: 1,
    raceId: 7,
    players: new Map([[player.id, player]]),
    lapsSaved: [],
    resultsSaved: [],
    async recordLap(...args) { this.lapsSaved.push(args); },
    async recordResults(results) { this.resultsSaved.push(results); },
    toJSON() { return { code: this.code, state: this.state }; },
  };
}

test('client car state rejects non-finite and implausibly fast payloads', () => {
  assert.ok(sanitizeClientCarState(wireState(1, 1000, 0)));
  assert.equal(sanitizeClientCarState(wireState(1, 1000, 0, 0, { p: [NaN, 0, 0] })), null);
  assert.equal(sanitizeClientCarState(wireState(1, 1000, 0, 0, { v: [500, 0, 0] })), null);
  assert.equal(sanitizeClientCarState(wireState(1, 1000, 0, 0, { q: [0, 0, 0, 0] })), null);
});

test('race controller relays state and still owns lap timing and ghosts', async () => {
  const room = makeRoom();
  const messages = [];
  const map = {
    spawns: [{ x: -1, z: 0, heading: Math.PI / 2 }],
    gates: {
      start: { x1: 0, z1: -5, x2: 0, z2: 5 },
      checkpoints: [{ x1: 10, z1: -5, x2: 10, z2: 5 }],
    },
  };
  const sim = new RaceController(room, {
    map,
    broadcast: (type, data) => messages.push({ type, ...data }),
  });
  room.sim = sim;
  await sim.start();
  try {
    assert.equal(sim.world, undefined, 'client mode must not create a Rapier world');
    assert.equal(sim.receiveState('p1', wireState(0, 90_000, -1), { initial: true, receivedAt: 900 }), true);
    room.state = ROOM_STATE.COUNTDOWN;
    sim.releaseAt(1000);
    sim.pump(1000);
    assert.equal(room.state, ROOM_STATE.RACING);

    assert.equal(sim.receiveState('p1', wireState(1, 1100, 1), { receivedAt: 1100 }), true);
    assert.equal(sim.cars.get('p1').race.hasCrossedStart, true);
    assert.equal(sim.receiveState('p1', wireState(2, 2000, 11), { receivedAt: 2000 }), true);
    assert.equal(sim.cars.get('p1').race.nextCheckpoint, 1);
    assert.equal(sim.receiveState('p1', wireState(3, 3000, -1), { receivedAt: 3000 }), true);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(room.lapsSaved.length, 1);
    assert.ok(Math.abs(room.lapsSaved[0][2] - 1_916.6667) < 0.01);
    assert.equal(
      messages.find((message) => message.type === S2C.RACE_EVENT && message.kind === 'lap')?.timeMs,
      1_917,
      'gate interpolation uses the server-validated client simulation timeline'
    );
    assert.ok(room.lapsSaved[0][4]?.frames?.length >= 2, 'valid lap should save a ghost replay');
    assert.ok(messages.some((message) => message.type === S2C.RACE_EVENT && message.kind === 'lap'));
    assert.ok(messages.some((message) => message.type === S2C.RACE_END));
  } finally {
    sim.stop();
  }
});

test('one accepted movement segment counts every checkpoint it crosses in order', async () => {
  const room = makeRoom();
  const sim = new RaceController(room, {
    map: {
      spawns: [{ x: 0, z: 0, heading: 0 }],
      gates: {
        start: { x1: 100, z1: -5, x2: 100, z2: 5 },
        checkpoints: [
          { x1: 10, z1: -5, x2: 10, z2: 5 },
          { x1: 20, z1: -5, x2: 20, z2: 5 },
        ],
      },
    },
    broadcast: () => {},
  });
  await sim.start();
  try {
    const car = sim.cars.get('p1');
    car.race.hasCrossedStart = true;
    car.race.lapStart = 1_000;
    car.race.prevX = 0;
    car.race.prevZ = 0;
    car.race.prevAt = 1_000;
    car.state.p = [25, 0.8, 0];
    sim.updateCarProgress(car, 1_250);

    assert.equal(car.race.nextCheckpoint, 2);
    assert.deepEqual([...car.race.passed], [0, 1]);
    assert.equal(car.race.taintReason, TAINT.NONE);
    assert.equal(car.race.splits.get(1), 1_100);
    assert.equal(car.race.splits.get(2), 1_200);
    assert.equal(car.respawn.x, 20, 'the latest crossed checkpoint becomes the reset point');
  } finally {
    sim.stop();
  }
});

test('a checkpoint skip taints the lap but later checkpoints restore standings progress', async () => {
  const room = makeRoom();
  room.mode = GAME_MODE.MULTIPLAYER;
  room.players.set('p2', { id: 'p2', carId: 'car', dbId: 2, slot: 1 });
  const checkpoints = [10, 20, 30, 40].map((x) => ({ x1: x, z1: -5, x2: x, z2: 5 }));
  const sim = new RaceController(room, {
    map: {
      spawns: [{ x: 0, z: 0, heading: 0 }, { x: 0, z: 2, heading: 0 }],
      gates: { start: { x1: 100, z1: -5, x2: 100, z2: 5 }, checkpoints },
    },
    broadcast: () => {},
  });
  await sim.start();
  try {
    const car = sim.cars.get('p1');
    car.race.hasCrossedStart = true;
    car.race.lapStart = 1_000;
    car.race.prevX = 0;
    car.race.prevZ = 0;
    car.race.prevAt = 1_000;

    // CP0 szabályos, CP1 mellett z=10-nél elmegy, majd CP2-nél visszatér a
    // pályára és CP3-on is áthalad. A kihagyás nem tűnhet el a passed Setből.
    for (const [x, z, at] of [[11, 0, 1_100], [15, 10, 1_150], [25, 10, 1_250], [31, 0, 1_350], [41, 0, 1_450]]) {
      car.state.p = [x, 0.8, z];
      sim.updateCarProgress(car, at);
    }

    assert.equal(car.race.taintReason, TAINT.CHECKPOINT);
    assert.deepEqual([...car.race.passed].sort((a, b) => a - b), [0, 2, 3]);
    assert.equal(car.race.nextCheckpoint, 4, 'the next real checkpoint resumes progress');
    assert.equal(car.race.progressKey, 4, 'standings reaches the latest crossed checkpoint');
    assert.equal(car.race.splits.has(2), false, 'the missing checkpoint gets no fabricated split');
    assert.ok(Number.isFinite(car.race.splits.get(3)));
    assert.ok(Number.isFinite(car.race.splits.get(4)));
    assert.equal(car.respawn.x, 40, 'reset follows the latest checkpoint actually crossed after the skip');

    const other = sim.cars.get('p2');
    other.race.progressKey = 3;
    other.race.splits.set(3, 1_300);
    assert.deepEqual(sim.orderedCars().map((entry) => entry.playerId), ['p1', 'p2']);
  } finally {
    sim.stop();
  }
});

test('race controller quarantines invalid physics states and keeps the player racing', async () => {
  const room = makeRoom();
  const messages = [];
  const map = {
    spawns: [{ x: -1, z: 0, heading: 0 }],
    gates: {
      start: { x1: 0, z1: -5, x2: 0, z2: 5 },
      checkpoints: [{ x1: 10, z1: -5, x2: 10, z2: 5 }],
    },
  };
  const sim = new RaceController(room, {
    map,
    broadcast: (type, data) => messages.push({ type, ...data }),
  });
  room.sim = sim;
  await sim.start();
  try {
    sim.receiveState('p1', wireState(0, 900, -1), { initial: true, receivedAt: 900 });
    room.state = ROOM_STATE.COUNTDOWN;
    sim.releaseAt(1000);
    sim.pump(1000);
    sim.receiveState('p1', wireState(1, 1100, 1), { receivedAt: 1100 });

    assert.equal(sim.receiveState(
      'p1', wireState(2, 1200, 2, 0, { v: [160, 0, 0] }), { receivedAt: 1200 }
    ), false, 'a suspicious pose must not become an active remote contact');
    assert.equal(sim.cars.get('p1').state.p[0], 1, 'the last safe state remains authoritative');
    assert.equal(sim.cars.get('p1').lastAcceptedSeq, 1);
    assert.equal(sim.receiveState('p1', wireState(3, 1300, 3), { receivedAt: 1300 }), true,
      'a later safe state continues the race without kicking the player');
    assert.equal(sim.cars.get('p1').race.taintReason, TAINT.VALIDATION);
    assert.equal(
      messages.filter((message) => message.kind === 'validation').length,
      1,
      'the warning is emitted only once in the same lap'
    );

    sim.receiveState('p1', wireState(4, 2000, 11), { receivedAt: 2000 });
    sim.receiveState('p1', wireState(5, 3000, -1), { receivedAt: 3000 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(room.lapsSaved[0][3], true);
    assert.equal(room.lapsSaved[0][4], null, 'an invalid lap must not save a ghost');
  } finally {
    sim.stop();
  }
});

test('skipping a tire change never invalidates the final lap', async () => {
  const room = makeRoom();
  room.mode = GAME_MODE.MULTIPLAYER;
  room.laps = 2;
  room.tireWear = true;
  const messages = [];
  const map = {
    spawns: [{ x: -1, z: 0, heading: 0 }],
    gates: {
      start: { x1: 0, z1: -5, x2: 0, z2: 5 },
      checkpoints: [{ x1: 10, z1: -5, x2: 10, z2: 5 }],
    },
    pit: {
      entries: [{ x1: 20, z1: -5, x2: 20, z2: 5 }],
      exits: [{ x1: 30, z1: -5, x2: 30, z2: 5 }],
      stops: Array.from({ length: 8 }, (_, i) => ({ x: 22 + i, z: 0, heading: 0 })),
    },
  };
  const sim = new RaceController(room, {
    map,
    broadcast: (type, data) => messages.push({ type, ...data }),
  });
  room.sim = sim;
  await sim.start();
  try {
    sim.receiveState('p1', wireState(0, 900, -1), { initial: true, receivedAt: 900 });
    room.state = ROOM_STATE.COUNTDOWN;
    sim.releaseAt(1000);
    sim.pump(1000);
    sim.receiveState('p1', wireState(1, 1100, 1), { receivedAt: 1100 });
    // Közvetlenül a kétkörös verseny utolsó körének lezárását vizsgáljuk.
    sim.cars.get('p1').race.lap = 1;
    sim.receiveState('p1', wireState(2, 2000, 11), { receivedAt: 2000 });
    sim.receiveState('p1', wireState(3, 3000, -1), { receivedAt: 3000 });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(room.lapsSaved.length, 1);
    assert.equal(room.lapsSaved[0][3], false, 'tire strategy affects grip, not lap validity');
    assert.ok(
      Math.abs(sim.cars.get('p1').race.tires.wear - 1 / 4) < 1e-12,
      'the authoritative server charges one quarter of a set for the completed lap'
    );
    assert.equal(sim.cars.get('p1').race.lap, 2, 'the lap still counts toward race distance');
    assert.equal(sim.cars.get('p1').race.finished, true, 'the player still finishes normally');
    assert.equal(
      messages.find((message) => message.kind === 'lap')?.invalid,
      false
    );
  } finally {
    sim.stop();
  }
});

test('a multiplayer lap with 80% of checkpoints counts as invalid race distance', async () => {
  const room = makeRoom();
  room.mode = GAME_MODE.MULTIPLAYER;
  room.laps = 1;
  const messages = [];
  const checkpoints = Array.from({ length: 5 }, (_, index) => ({
    x1: 100 + index * 10, z1: -5, x2: 100 + index * 10, z2: 5,
  }));
  const sim = new RaceController(room, {
    map: {
      spawns: [{ x: 1, z: 0, heading: 0 }],
      gates: { start: { x1: 0, z1: -5, x2: 0, z2: 5 }, checkpoints },
    },
    broadcast: (type, payload) => messages.push({ type, payload }),
  });
  await sim.start();
  try {
    const car = sim.cars.get('p1');
    car.race.hasCrossedStart = true;
    car.race.lapStart = 1_000;
    car.race.prevX = 1;
    car.race.prevZ = 0;
    car.race.prevAt = 1_000;
    car.race.passed = new Set([0, 1, 2, 3]); // 80% megvan, de az ötödik hiányzik
    car.race.nextCheckpoint = 4;
    car.state.p = [-1, 0.8, 0];
    sim.updateCarProgress(car, 2_000);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(car.race.lap, 1, 'the invalid lap still counts toward race distance');
    assert.equal(car.race.finished, true, 'the final invalid lap still finishes the race');
    assert.equal(car.race.lapTimes[0].invalid, true);
    assert.equal(room.lapsSaved[0][3], true, 'the stored lap must remain invalid');
    assert.equal(room.lapsSaved[0][4], null, 'an invalid lap must not save a ghost');
    assert.equal(messages.find((message) => message.payload?.kind === 'lap')?.payload.invalid, true);
    assert.equal(messages.some((message) => message.payload?.kind === 'lapRetry'), false);
  } finally {
    sim.stop();
  }
});

test('a multiplayer lap below the 80% checkpoint threshold must be retried', async () => {
  const room = makeRoom();
  room.mode = GAME_MODE.MULTIPLAYER;
  room.laps = 1;
  const messages = [];
  const checkpoints = Array.from({ length: 5 }, (_, index) => ({
    x1: 100 + index * 10, z1: -5, x2: 100 + index * 10, z2: 5,
  }));
  const sim = new RaceController(room, {
    map: {
      spawns: [{ x: 1, z: 0, heading: 0 }],
      gates: { start: { x1: 0, z1: -5, x2: 0, z2: 5 }, checkpoints },
    },
    broadcast: (type, payload) => messages.push({ type, payload }),
  });
  await sim.start();
  try {
    const car = sim.cars.get('p1');
    car.race.hasCrossedStart = true;
    car.race.lapStart = 1_000;
    car.race.prevX = 1;
    car.race.prevZ = 0;
    car.race.prevAt = 1_000;
    car.race.passed = new Set([0, 1, 2]); // 60%: a rajtvonal még nem zárhatja le a kört
    car.race.nextCheckpoint = 3;
    car.state.p = [-1, 0.8, 0];
    sim.updateCarProgress(car, 2_000);

    assert.equal(car.race.lap, 0);
    assert.equal(car.race.finished, false);
    assert.equal(car.race.lapStart, 1_500, 'the retry starts at the interpolated line crossing');
    assert.equal(car.race.nextCheckpoint, 0);
    assert.equal(car.race.taintReason, TAINT.NONE);
    assert.ok(messages.some((message) => message.payload?.kind === 'lapRetry'));
  } finally {
    sim.stop();
  }
});

test('rolling movement validation catches repeated small position cheats', async () => {
  const room = makeRoom();
  const messages = [];
  const sim = new RaceController(room, {
    map: {
      spawns: [{ x: -1, z: 0, heading: 0 }],
      gates: {
        start: { x1: 0, z1: -5, x2: 0, z2: 5 },
        checkpoints: [{ x1: 1000, z1: -5, x2: 1000, z2: 5 }],
      },
    },
    broadcast: (type, data) => messages.push({ type, ...data }),
  });
  await sim.start();
  try {
    sim.receiveState('p1', wireState(0, 900, -1), { initial: true, receivedAt: 900 });
    room.state = ROOM_STATE.COUNTDOWN;
    sim.releaseAt(1000);
    sim.pump(1000);
    sim.receiveState('p1', wireState(1, 1100, 1), { receivedAt: 1100 });

    for (let i = 1; i <= 20; i++) {
      const at = 1100 + i * 25;
      sim.receiveState('p1', wireState(1 + i, at, 1 + i * 4.5), { receivedAt: at });
    }
    assert.equal(sim.cars.get('p1').race.taintReason, TAINT.VALIDATION);
    assert.equal(messages.filter((message) => message.kind === 'validation').length, 1);
  } finally {
    sim.stop();
  }
});

test('brief chained physics corrections do not invalidate a lap', async () => {
  const room = makeRoom();
  const messages = [];
  const sim = new RaceController(room, {
    map: {
      spawns: [{ x: -1, z: 0, heading: 0 }],
      gates: {
        start: { x1: 0, z1: -5, x2: 0, z2: 5 },
        checkpoints: [{ x1: 1000, z1: -5, x2: 1000, z2: 5 }],
      },
    },
    broadcast: (type, data) => messages.push({ type, ...data }),
  });
  await sim.start();
  try {
    sim.receiveState('p1', wireState(0, 900, -1), { initial: true, receivedAt: 900 });
    room.state = ROOM_STATE.COUNTDOWN;
    sim.releaseAt(1000);
    sim.pump(1000);
    sim.receiveState('p1', wireState(1, 1100, 1), { receivedAt: 1100 });

    // Egy rázókő/ütközés rövid ideig több egymást követő pozíciókorrekciót
    // okozhat. Csomagonként egyik sem teleport, és 500 ms alatt lecseng.
    for (let i = 1; i <= 10; i++) {
      const at = 1100 + i * 25;
      sim.receiveState('p1', wireState(1 + i, at, 1 + i * 4.5), { receivedAt: at });
    }
    assert.equal(sim.cars.get('p1').race.taintReason, TAINT.NONE);
    assert.equal(messages.some((message) => message.kind === 'validation'), false);
  } finally {
    sim.stop();
  }
});

test('high speed and packets bunched by a ping spike stay valid', async () => {
  const room = makeRoom();
  const messages = [];
  const sim = new RaceController(room, {
    map: {
      spawns: [{ x: -1, z: 0, heading: 0 }],
      gates: {
        start: { x1: 0, z1: -5, x2: 0, z2: 5 },
        checkpoints: [{ x1: 1000, z1: -5, x2: 1000, z2: 5 }],
      },
    },
    broadcast: (type, data) => messages.push({ type, ...data }),
  });
  await sim.start();
  try {
    sim.receiveState('p1', wireState(0, 900, -1), { initial: true, receivedAt: 900 });
    room.state = ROOM_STATE.COUNTDOWN;
    sim.releaseAt(1000);
    sim.pump(1000);
    sim.receiveState('p1', wireState(1, 1100, 1), { receivedAt: 1100 });

    // 450 km/h-s rövid fizikai kilengés, minden harmadik kliensállapot jut át.
    // A szerverhez egy másodperccel később, szinte egyszerre érkeznek meg, de
    // a saját szimulációs időpontjuk megmarad.
    const speed = 125;
    let seq = 1;
    let x = 1;
    for (let i = 1; i <= 20; i++) {
      seq += 3;
      x += speed * 3 * TICK_MS / 1_000;
      sim.receiveState(
        'p1', wireState(seq, 1100 + i * 50, x, 0, { v: [speed, 0, 0] }),
        { receivedAt: 2200 + i * 0.1 }
      );
    }

    assert.equal(sim.cars.get('p1').race.taintReason, TAINT.NONE);
    assert.equal(messages.some((message) => message.kind === 'validation'), false);
  } finally {
    sim.stop();
  }
});

test('race controller reset is server-selected and allows the resulting teleport once', async () => {
  const room = makeRoom();
  const messages = [];
  const sim = new RaceController(room, {
    map: { spawns: [{ x: 5, z: 6, heading: 0 }], gates: null },
    broadcast: (type, data) => messages.push({ type, ...data }),
  });
  await sim.start();
  try {
    const now = Date.now();
    sim.receiveState('p1', wireState(0, now, 5, 6), { initial: true, receivedAt: now });
    sim.cars.get('p1').race.hasCrossedStart = true;
    sim.cars.get('p1').respawn = { x: 100, z: 200, heading: 1 };
    sim.resetCar('p1');
    assert.deepEqual(messages.at(-1), {
      type: S2C.CAR_RESET,
      playerId: 'p1',
      respawn: { x: 100, z: 200, heading: 1 },
    });
    assert.equal(
      sim.receiveState('p1', wireState(1, now + 17, 100, 200), { receivedAt: now + 17 }),
      true,
      'the first grounded state after a requested reset may jump to the checkpoint'
    );
  } finally {
    sim.stop();
  }
});

test('reset is blocked before the first start-line crossing', async () => {
  const room = makeRoom();
  const messages = [];
  const sim = new RaceController(room, {
    map: { spawns: [{ x: 5, z: 6, heading: 0 }], gates: null },
    broadcast: (type, data) => messages.push({ type, ...data }),
  });
  await sim.start();
  try {
    assert.equal(sim.resetCar('p1'), false);
    assert.equal(messages.some((message) => message.type === S2C.CAR_RESET), false);
  } finally {
    sim.stop();
  }
});

test('stale states sent while reset is in flight cannot invalidate the lap', async () => {
  const room = makeRoom();
  room.state = ROOM_STATE.RACING;
  const messages = [];
  const sim = new RaceController(room, {
    map: { spawns: [{ x: 5, z: 6, heading: 0 }], gates: null },
    broadcast: (type, data) => messages.push({ type, ...data }),
  });
  await sim.start();
  try {
    const now = Date.now();
    sim.receiveState('p1', wireState(0, now, 5, 6), { initial: true, receivedAt: now });
    const car = sim.cars.get('p1');
    car.race.hasCrossedStart = true;
    car.respawn = { x: 100, z: 200, heading: 0 };
    assert.equal(sim.resetCar('p1'), true);

    assert.equal(
      sim.receiveState('p1', wireState(1, now + 10, 6, 6), { receivedAt: now + 10 }),
      false,
      'the pre-reset position is ignored while the reset response is in flight'
    );
    assert.deepEqual(car.state.p.slice(0, 3), [100, 0.8, 200]);
    assert.equal(sim.receiveState(
      'p1', wireState(2, now + 20, 100, 200), { receivedAt: now + 20 }
    ), true);
    assert.equal(car.race.taintReason, TAINT.NONE);
    assert.equal(messages.some((message) => message.kind === 'validation'), false);
  } finally {
    sim.stop();
  }
});

test('a pending reset survives a long disconnect until the checkpoint pose is acknowledged', async () => {
  const room = makeRoom();
  room.state = ROOM_STATE.RACING;
  const sim = new RaceController(room, {
    map: { spawns: [{ x: 5, z: 6, heading: 0 }], gates: null },
    broadcast: () => {},
  });
  await sim.start();
  try {
    const now = Date.now();
    sim.receiveState('p1', wireState(0, now, 5, 6), { initial: true, receivedAt: now });
    const car = sim.cars.get('p1');
    car.race.hasCrossedStart = true;
    car.respawn = { x: 100, z: 200, heading: 1 };
    assert.equal(sim.resetCar('p1'), true);
    assert.deepEqual(sim.pendingResetPose('p1'), { x: 100, z: 200, heading: 1 });

    assert.equal(sim.receiveState(
      'p1', wireState(1, now + 10_000, 6, 6), { receivedAt: now + 10_000 }
    ), false, 'the pre-reset pose must not return after an arbitrary timeout');
    assert.deepEqual(sim.pendingResetPose('p1'), { x: 100, z: 200, heading: 1 });

    assert.equal(sim.receiveState(
      'p1', wireState(2, now + 10_020, 100, 200), { receivedAt: now + 10_020 }
    ), true);
    assert.equal(sim.pendingResetPose('p1'), null);
  } finally {
    sim.stop();
  }
});

test('multiplayer respawn keeps an asphalt crossing and uses gate middle off track', async () => {
  // Az irány a KÖVETKEZŐ kapu közepe felé néz, nem a haladási irányba. Egyetlen
  // checkpoint van, tehát utána a rajtvonal jön: annak a közepe a (0,0).
  const room = makeRoom();
  const width = 21, height = 21;
  const codes = new Uint8Array(width * height);
  const map = {
    spawns: [{ x: -1, z: 0, heading: 0 }],
    gates: {
      start: { x1: 0, z1: -5, x2: 0, z2: 5 },
      checkpoints: [{ x1: 10, z1: -5, x2: 10, z2: 5 }],
    },
    zoneRuntime: { codes, w: width, h: height, bounds: { minX: 0, maxX: 21, minZ: -10, maxZ: 11 } },
  };
  const sim = new RaceController(room, { map, broadcast: () => {} });
  await sim.start();
  try {
    room.state = ROOM_STATE.RACING;
    sim.startAt = 0;
    const car = sim.cars.get('p1');
    car.race.hasCrossedStart = true;
    car.race.prevX = 9;
    car.race.prevZ = 3;
    car.race.prevAt = 1000;
    sim.receiveState('p1', wireState(1, 1100, 11, 3), { receivedAt: 1100 });
    assert.deepEqual(
      car.respawn,
      { x: 10, z: 3, heading: Math.atan2(0 - 10, 0 - 3) }
    );

    // A következő átlépési pont képpontját kifutónak jelöljük.
    const u = Math.floor((10 / 21) * width);
    const v = Math.floor(((4 + 10) / 21) * height);
    codes[v * width + u] = 1;
    car.race.nextCheckpoint = 0;
    car.race.passed.clear();
    car.race.prevX = 9;
    car.race.prevZ = 4;
    car.race.prevAt = 1200;
    sim.receiveState('p1', wireState(2, 1300, 11, 4), { receivedAt: 1300 });
    // A kapuközépre esve (10,0) a rajtvonal közepe pontosan -X irányban van.
    assert.deepEqual(car.respawn, { x: 10, z: 0, heading: -Math.PI / 2 });
  } finally {
    sim.stop();
  }
});

test('bunched packets keep their simulation time and cannot produce a zero-time valid lap', async () => {
  const room = makeRoom();
  const map = {
    spawns: [{ x: 0, z: -1, heading: 0 }],
    gates: {
      start: { x1: -5, z1: 0, x2: 5, z2: 0 },
      checkpoints: [{ x1: -5, z1: 20, x2: 5, z2: 20 }],
    },
  };
  const sim = new RaceController(room, { map, broadcast: () => {} });
  await sim.start();
  try {
    room.state = ROOM_STATE.RACING;
    sim.releaseAt(0);
    sim.receiveState('p1', wireState(0, 1000, 0, -1), { initial: true, receivedAt: 1000 });
    sim.receiveState('p1', wireState(12, 1200, 0, 1), { receivedAt: 2000 });
    sim.receiveState('p1', wireState(24, 1400, 0, 21), { receivedAt: 2000.1 });
    sim.receiveState('p1', wireState(36, 1600, 0, -1), { receivedAt: 2000.2 });
    await new Promise((resolve) => setImmediate(resolve));

    const lap = sim.cars.get('p1').race.lapTimes[0];
    assert.ok(lap.time >= 400, `a szimulációs idővonal számítson, kapott: ${lap.time} ms`);
    assert.equal(lap.invalid, false);
  } finally {
    sim.stop();
  }
});

test('ready initial state keeps the server-assigned grid position', async () => {
  const room = makeRoom();
  const sim = new RaceController(room, {
    map: { spawns: [{ x: 5, z: 6, heading: 0.75 }], gates: null },
    broadcast: () => {},
  });
  await sim.start();
  try {
    const assigned = [...sim.cars.get('p1').state.p];
    assert.equal(sim.receiveInitialState('p1', wireState(99, 1000, 5000, 5000)), true);
    const car = sim.cars.get('p1');
    assert.deepEqual(car.state.p, [assigned[0], 0.8, assigned[2]]);
    assert.equal(car.lastSeq, 99);
  } finally {
    sim.stop();
  }
});

test('server zone map overrides a client that lies about offtrack state', async () => {
  const room = makeRoom();
  room.mode = GAME_MODE.MULTIPLAYER;
  const runtime = {
    codes: new Uint8Array(100).fill(1),
    w: 10,
    h: 10,
    bounds: { minX: -5, maxX: 5, minZ: -5, maxZ: 5 },
  };
  const sim = new RaceController(room, {
    map: {
      spawns: [{ x: 0, z: 0, heading: 0 }],
      gates: { start: { x1: 50, z1: -5, x2: 50, z2: 5 }, checkpoints: [] },
      zoneRuntime: runtime,
    },
    broadcast: () => {},
  });
  await sim.start();
  try {
    room.state = ROOM_STATE.RACING;
    sim.releaseAt(0);
    sim.receiveState('p1', wireState(0, 1000, 0, 0), { initial: true, receivedAt: 1000 });
    const car = sim.cars.get('p1');
    car.race.hasCrossedStart = true;
    car.race.lapStart = 1000;
    sim.receiveState('p1', wireState(1, 1100, 0.1, 0, { offtrack: false }), { receivedAt: 1100 });
    assert.equal(car.state.offtrack, true);
    assert.equal(car.race.taintReason, TAINT.OFFTRACK);
  } finally {
    sim.stop();
  }
});

// A szerver a kapukat (és így a kör kezdetét) a mozgás-idővonalon bélyegzi.
// Ez az óra korábban egyirányú racsni volt: a lépés
// `lastMovementAt + max(beérkezési különbség, sorszám × TICK_MS)` minden korán
// érkező csomagnál a nagyobb, sorszám-alapú tagot írta jóvá, a többletet pedig
// sosem adta vissza. Szabályos 60 Hz-es küldésnél és NULLA ÁTLAGÚ hálózati
// szórásnál is elszaladt — mérve 7 másodperc alatt 763 ms —, míg neki nem
// ütközött az 1 másodperces plafonnak. A látható tünet: a Hot Lap szelleme
// ennyit várt a rajtvonalnál, mielőtt elindult, és végig ennyivel maradt le.
// A köridő-KÜLÖNBSÉG közben helyes maradt, mert annak mindkét vége ugyanazon
// az eltolt órán ült — ezért maradhatott sokáig észrevétlen.
test('the movement clock does not ratchet ahead on ordinary network jitter', async () => {
  const player = { id: 'driver', carId: 'f2004' };
  const room = {
    laps: 1, mode: GAME_MODE.HOT_LAP, state: ROOM_STATE.LOADING,
    countdownEndsAt: 0, players: new Map([[player.id, player]]),
  };
  const sim = new RaceController(room, {
    // A rajtvonal elérhetetlen messze: itt csak az órát mérjük.
    map: { spawns: [{ x: 0, z: 0, heading: 0 }], gates: { start: { x1: 1e6, z1: -2, x2: 1e6, z2: 2 }, checkpoints: [] } },
    broadcast: () => {},
  });
  await sim.start();
  clearInterval(sim.timer);
  sim.timer = null;
  room.state = ROOM_STATE.RACING;
  sim.startAt = 0;

  const car = sim.cars.get(player.id);
  let receivedAt = 0;
  for (let n = 1; n <= 600; n++) {
    // Determinisztikus, nulla átlagú szórás: a hálózat nem siet, csak ingadozik.
    receivedAt = 1_000 + n * TICK_MS + 4 * Math.sin(n * 1.7);
    sim.receiveState(player.id, wireState(n, receivedAt, n * 0.01), { receivedAt });
  }

  const lead = car.lastMovementAt - receivedAt;
  assert.ok(lead >= 0, 'az óra nem futhat a beérkezési idő mögé');
  assert.ok(lead < 30, `a szórásnak nem szabad halmozódnia (mért előny: ${lead.toFixed(1)} ms)`);
});

// A racsni javítása nem gyengítheti azt a védelmet, amiért az óra létezik: egy
// pingkiugrás után egyszerre beérkező állapotköteg nem tömörítheti a kört
// néhány ezredmásodpercre.
test('a burst after a ping spike still advances the clock by the simulated time', async () => {
  const player = { id: 'driver', carId: 'f2004' };
  const room = {
    laps: 1, mode: GAME_MODE.HOT_LAP, state: ROOM_STATE.LOADING,
    countdownEndsAt: 0, players: new Map([[player.id, player]]),
  };
  const sim = new RaceController(room, {
    map: { spawns: [{ x: 0, z: 0, heading: 0 }], gates: { start: { x1: 1e6, z1: -2, x2: 1e6, z2: 2 }, checkpoints: [] } },
    broadcast: () => {},
  });
  await sim.start();
  clearInterval(sim.timer);
  sim.timer = null;
  room.state = ROOM_STATE.RACING;
  sim.startAt = 0;

  const car = sim.cars.get(player.id);
  let seq = 0;
  for (let n = 1; n <= 30; n++) {
    const receivedAt = 1_000 + n * TICK_MS;
    sim.receiveState(player.id, wireState(++seq, receivedAt, n * 0.01), { receivedAt });
  }
  const before = car.lastMovementAt;

  // 500 ms-nyi kliensszimuláció állapotai egyetlen hálózati kötegben
  // érkeznek meg. A csomagok SAJÁT ideje 16,67 ms-onként halad, miközben a
  // beérkezési idő csak három milliszekundumot mozdul.
  const burstAt = 1_000 + 30 * TICK_MS + 500;
  for (let n = 1; n <= 30; n++) {
    const simulatedAt = before + n * TICK_MS;
    sim.receiveState(
      player.id,
      wireState(++seq, simulatedAt, (30 + n) * 0.01),
      { receivedAt: burstAt + n * 0.1 },
    );
  }

  const advanced = car.lastMovementAt - before;
  assert.ok(Math.abs(advanced - 500) < 0.01,
    `a köteg a szimulált 500 ms-ot tartsa meg (kapott: ${advanced.toFixed(1)} ms)`);
});

// Ugyanaz a fizikai út ugyanazt az időt kell adja akkor is, ha minden állapot
// külön érkezik, és akkor is, ha a hálózat egy másodpercig tartja, majd TCP-
// sorrendben egyszerre kézbesíti. A régi szerveróra itt 483 ms eltérést adott.
test('normal and bunched delivery produce the same lap time', async () => {
  async function run(bunched) {
    const player = { id: 'driver', carId: 'f2004' };
    const room = {
      laps: 1, mode: GAME_MODE.HOT_LAP, state: ROOM_STATE.RACING,
      countdownEndsAt: 0, players: new Map([[player.id, player]]),
      endlessLaps: true,
      recordLap: async () => {},
    };
    const snapshots = [];
    const sim = new RaceController(room, {
      map: {
        spawns: [{ x: 0, z: -1, heading: 0 }],
        gates: {
          start: { x1: -5, z1: 0, x2: 5, z2: 0 },
          checkpoints: [{ x1: -5, z1: 20, x2: 5, z2: 20 }],
        },
      },
      broadcast: (type, payload) => { if (type === S2C.SNAPSHOT) snapshots.push(payload); },
    });
    await sim.start();
    clearInterval(sim.timer);
    sim.timer = null;
    sim.startAt = 0;
    sim.receiveState(player.id, wireState(0, 1_000, 0, -1), { initial: true, receivedAt: 1_000 });
    const samples = [
      [1, 1_100, 1],
      [2, 1_300, 21],
      [3, 1_600, -1],
    ];
    for (let i = 0; i < samples.length; i++) {
      const [seq, at, z] = samples[i];
      sim.receiveState(
        player.id,
        wireState(seq, at, 0, z),
        { receivedAt: bunched ? 2_000 + i * 0.1 : at },
      );
    }
    await new Promise((resolve) => setImmediate(resolve));
    sim.sendSnapshot(bunched ? 2_001 : 1_601);
    const car = sim.cars.get(player.id);
    const result = {
      lapTime: car.race.lapTimes[0]?.time,
      lapStart: car.race.lapStart,
      reportedLapStart: snapshots.at(-1).cars[0].ls,
    };
    sim.stop();
    return result;
  }

  const normal = await run(false);
  const bunched = await run(true);
  assert.ok(Number.isFinite(normal.lapTime));
  assert.ok(Math.abs(normal.lapTime - bunched.lapTime) < 0.001,
    `normál ${normal.lapTime} ms, kötegelt ${bunched.lapTime} ms`);
  assert.equal(normal.reportedLapStart, Math.round(normal.lapStart));
  assert.equal(bunched.reportedLapStart, Math.round(bunched.lapStart));
});

test('the finish deadline uses the same validated server timeline as the winner', async () => {
  const winner = { id: 'winner', carId: 'f2004' };
  const other = { id: 'other', carId: 'f2004' };
  const room = {
    laps: 1, mode: GAME_MODE.MULTIPLAYER, state: ROOM_STATE.RACING, countdownEndsAt: 0,
    players: new Map([[winner.id, winner], [other.id, other]]),
    recordLap: async () => {},
  };
  const sim = new RaceController(room, {
    map: {
      spawns: [{ x: 0, z: -1, heading: 0 }, { x: 5, z: -1, heading: 0 }],
      gates: { start: { x1: -20, z1: 0, x2: 20, z2: 0 }, checkpoints: [] },
    },
    broadcast: () => {},
  });
  await sim.start();
  clearInterval(sim.timer);
  sim.timer = null;
  sim.startAt = 0;
  sim.receiveState(winner.id, wireState(0, 1_000, 0, -1), { initial: true, receivedAt: 1_000 });
  sim.receiveState(winner.id, wireState(1, 1_100, 0, 1), { receivedAt: 2_000 });
  sim.receiveState(winner.id, wireState(2, 1_600, 0, -1), { receivedAt: 2_000.1 });

  const car = sim.cars.get(winner.id);
  assert.equal(car.race.finished, true);
  assert.equal(sim.finishDeadline, car.race.finishedAt + FINISH_GRACE_MS);
  sim.stop();
});

test('race end keeps live progress order and does not wait for result storage', async () => {
  const a = { id: 'a', carId: 'f2004', dbId: 1, slot: 0 };
  const b = { id: 'b', carId: 'f2004', dbId: 2, slot: 1 };
  let releaseStorage;
  const storage = new Promise((resolve) => { releaseStorage = resolve; });
  const room = {
    laps: 3,
    mode: GAME_MODE.MULTIPLAYER,
    state: ROOM_STATE.RACING,
    raceGeneration: 1,
    raceId: 77,
    players: new Map([[a.id, a], [b.id, b]]),
    async recordResults() { await storage; },
    toJSON() { return { state: this.state }; },
  };
  const messages = [];
  const sim = new RaceController(room, {
    map: { spawns: [{ x: 0, z: 0, heading: 0 }, { x: 0, z: 5, heading: 0 }], gates: null },
    generation: 1,
    raceId: 77,
    broadcast: (type, payload) => messages.push({ type, payload }),
  });
  await sim.start();
  room.sim = sim;
  const carA = sim.cars.get(a.id);
  const carB = sim.cars.get(b.id);
  carA.race.lap = carB.race.lap = 1;
  carA.race.progressKey = 4;
  carB.race.progressKey = 5;
  carA.race.splits.set(4, 1_000);
  carB.race.splits.set(5, 1_100);

  await sim.endRace();
  const end = messages.find((message) => message.type === S2C.RACE_END);
  assert.deepEqual(end.payload.results.map((result) => result.playerId), ['b', 'a']);
  assert.equal(room.state, ROOM_STATE.LOBBY);
  assert.equal(room.sim, null);

  releaseStorage();
  await sim.persistence;
});
