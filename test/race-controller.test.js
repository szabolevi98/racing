import test from 'node:test';
import assert from 'node:assert/strict';
import { RaceController, sanitizeClientCarState } from '../server/game/raceController.js';
import { ROOM_STATE, GAME_MODE, S2C, TAINT, TICK_MS } from '../shared/protocol.js';

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

    assert.equal(sim.receiveState('p1', wireState(1, -50_000, 1), { receivedAt: 1100 }), true);
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
      'gate interpolation uses server receipt times and ignores client timestamps'
    );
    assert.ok(room.lapsSaved[0][4]?.frames?.length >= 2, 'valid lap should save a ghost replay');
    assert.ok(messages.some((message) => message.type === S2C.RACE_EVENT && message.kind === 'lap'));
    assert.ok(messages.some((message) => message.type === S2C.RACE_END));
  } finally {
    sim.stop();
  }
});

test('race controller speed validation invalidates once and keeps the player racing', async () => {
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
    ), true, 'suspicious state is relayed instead of kicking the player');
    sim.receiveState('p1', wireState(3, 1300, 3, 0, { v: [160, 0, 0] }), { receivedAt: 1300 });
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

test('missing mandatory pit stop invalidates only the final lap and still finishes the race', async () => {
  const room = makeRoom();
  room.mode = GAME_MODE.MULTIPLAYER;
  room.laps = 2;
  room.mandatoryPitStop = true;
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
    assert.equal(room.lapsSaved[0][3], true, 'the final lap cannot become a best lap');
    assert.equal(sim.cars.get('p1').race.lap, 2, 'the lap still counts toward race distance');
    assert.equal(sim.cars.get('p1').race.finished, true, 'the player still finishes normally');
    assert.equal(
      messages.find((message) => message.kind === 'lap')?.invalid,
      true
    );
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
    // A ping után ezek szinte egyszerre érkeznek meg a szerverhez.
    const speed = 125;
    let seq = 1;
    let x = 1;
    for (let i = 1; i <= 20; i++) {
      seq += 3;
      x += speed * 3 * TICK_MS / 1_000;
      sim.receiveState(
        'p1', wireState(seq, 1100 + i * 50, x, 0, { v: [speed, 0, 0] }),
        { receivedAt: 1200 + i }
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
    sim.receiveState('p1', wireState(0, 1000, 5, 6), { initial: true, receivedAt: 1000 });
    sim.cars.get('p1').race.hasCrossedStart = true;
    sim.cars.get('p1').respawn = { x: 100, z: 200, heading: 1 };
    sim.resetCar('p1');
    assert.deepEqual(messages.at(-1), {
      type: S2C.CAR_RESET,
      playerId: 'p1',
      respawn: { x: 100, z: 200, heading: 1 },
    });
    assert.equal(
      sim.receiveState('p1', wireState(1, 1017, 100, 200), { receivedAt: 1017 }),
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
    sim.receiveState('p1', wireState(0, 1000, 5, 6), { initial: true, receivedAt: 1000 });
    const car = sim.cars.get('p1');
    car.race.hasCrossedStart = true;
    car.respawn = { x: 100, z: 200, heading: 0 };
    assert.equal(sim.resetCar('p1'), true);

    assert.equal(
      sim.receiveState('p1', wireState(1, 1010, 6, 6), { receivedAt: 1010 }),
      false,
      'the pre-reset position is ignored while the reset response is in flight'
    );
    assert.deepEqual(car.state.p.slice(0, 3), [100, 0.8, 200]);
    assert.equal(sim.receiveState('p1', wireState(2, 1020, 100, 200), { receivedAt: 1020 }), true);
    assert.equal(car.race.taintReason, TAINT.NONE);
    assert.equal(messages.some((message) => message.kind === 'validation'), false);
  } finally {
    sim.stop();
  }
});

test('multiplayer respawn keeps an asphalt crossing and uses gate middle off track', async () => {
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
    assert.deepEqual(car.respawn, { x: 10, z: 3, heading: Math.PI / 2 });

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
    assert.deepEqual(car.respawn, { x: 10, z: 0, heading: Math.PI / 2 });
  } finally {
    sim.stop();
  }
});
