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

test('bunched sequence numbers cannot produce a zero-time valid lap', async () => {
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
    sim.receiveState('p1', wireState(12, 1000, 0, 1), { receivedAt: 1000 });
    sim.receiveState('p1', wireState(24, 1000, 0, 21), { receivedAt: 1000 });
    sim.receiveState('p1', wireState(36, 1000, 0, -1), { receivedAt: 1000 });
    await new Promise((resolve) => setImmediate(resolve));

    const lap = sim.cars.get('p1').race.lapTimes[0];
    assert.ok(lap.time >= 400, `a sorszám idővonala is számítson, kapott: ${lap.time} ms`);
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

  // 500 ms néma szünet, majd 30 állapot egyetlen kötegben.
  const burstAt = 1_000 + 30 * TICK_MS + 500;
  for (let n = 1; n <= 30; n++) {
    sim.receiveState(player.id, wireState(++seq, burstAt, (30 + n) * 0.01), { receivedAt: burstAt + n * 0.1 });
  }

  const advanced = car.lastMovementAt - before;
  assert.ok(advanced > 400, `a kötegnek valódi időt kell kapnia, nem a beérkezési 3 ms-ot (kapott: ${advanced.toFixed(1)} ms)`);
});

// Pingkiugrás után a mozgás-óra tartósan a valós idő előtt jár (lásd
// clockLead()). A kifelé küldött kör-kezdetből ezt le kell vonni, különben a
// kliens — ami a saját faliórájához méri — pont ennyivel később indítja a
// szellemet és a futó órát.
test('the lap start goes out on the wall clock, not the drifted one', async () => {
  const player = { id: 'driver', carId: 'f2004' };
  const room = {
    laps: 1, mode: GAME_MODE.HOT_LAP, state: ROOM_STATE.LOADING,
    countdownEndsAt: 0, players: new Map([[player.id, player]]),
  };
  const snapshots = [];
  const sim = new RaceController(room, {
    map: { spawns: [{ x: 0, z: 0, heading: 0 }], gates: { start: { x1: 200, z1: -50, x2: 200, z2: 50 }, checkpoints: [] } },
    broadcast: (type, payload) => { if (type === S2C.SNAPSHOT) snapshots.push(payload); },
  });
  await sim.start();
  clearInterval(sim.timer);
  sim.timer = null;
  room.state = ROOM_STATE.RACING;
  sim.startAt = 0;

  const car = sim.cars.get(player.id);
  let seq = 0, x = 0, wall = 1_000;
  const drive = (receivedAt) => {
    x += 1; // méterenként, azaz 60 m/s — bőven a mozgásvizsgálat határa alatt
    sim.receiveState(player.id, wireState(++seq, receivedAt, x), { receivedAt });
  };

  for (let n = 0; n < 60; n++) { wall += TICK_MS; drive(wall); }

  // Fél másodperces akadás: a kliens tovább szimulál, az állapotok utána
  // egyetlen kupacban érkeznek. Ettől kap az óra tartós előnyt.
  wall += 500;
  for (let n = 0; n < 30; n++) drive(wall + n * 0.1);
  wall += 30 * 0.1;
  assert.ok(clockLeadOf(car) > 300, 'a kiugrásnak valódi előnyt kell hagynia az órán');

  // Utána szabályos forgalom, egészen a rajtvonal átlépéséig.
  while (!car.race.hasCrossedStart) { wall += TICK_MS; drive(wall); }
  const wallCrossing = wall;

  sim.sendSnapshot(wall);
  const reported = snapshots.at(-1).cars.find((entry) => entry.id === player.id).ls;

  assert.ok(Math.abs(reported - wallCrossing) < 60,
    `a kör kezdete a faliórán legyen (küldött ${reported}, valós ${wallCrossing.toFixed(0)})`);
  assert.ok(car.race.lapStart - reported > 300,
    'a korrekciónak érdemben el kell térnie a nyers, mozgás-órás értéktől');
});

const clockLeadOf = (car) => Math.max(0, car.lastMovementAt - car.lastStateAt);

// A mezőny hátralévő idejét az első befutó indítja. A határidőt a pump() a
// Date.now()-hoz méri, és a kliens is a saját órájából számolja a
// visszaszámlálót — a befutó ideje viszont a mozgás-óráról jön. A győztes
// akadásának méretével kapott eddig mindenki több időt.
test('the finish deadline follows the wall clock, not the winner hiccup', async () => {
  const winner = { id: 'winner', carId: 'f2004' };
  const other = { id: 'other', carId: 'f2004' };
  const room = {
    laps: 1, mode: GAME_MODE.MULTIPLAYER, state: ROOM_STATE.LOADING, countdownEndsAt: 0,
    players: new Map([[winner.id, winner], [other.id, other]]),
    recordLap: async () => {},
  };
  const sim = new RaceController(room, {
    map: {
      spawns: [{ x: 0, z: 0, heading: 0 }, { x: 0, z: 6, heading: 0 }],
      gates: { start: { x1: 120, z1: -50, x2: 120, z2: 50 }, checkpoints: [] },
    },
    broadcast: () => {},
  });
  await sim.start();
  clearInterval(sim.timer);
  sim.timer = null;
  room.state = ROOM_STATE.RACING;
  sim.startAt = 0;

  const car = sim.cars.get(winner.id);
  let seq = 0, x = 0, wall = 1_000;
  const drive = (receivedAt) => {
    x += 1;
    sim.receiveState(winner.id, wireState(++seq, receivedAt, x), { receivedAt });
  };

  for (let n = 0; n < 40; n++) { wall += TICK_MS; drive(wall); }
  wall += 500;                                   // akadás
  for (let n = 0; n < 30; n++) drive(wall + n * 0.1);
  wall += 30 * 0.1;
  assert.ok(clockLeadOf(car) > 300);

  // Egy körös futam: a rajtvonal első átlépése indítja, a második zárja.
  while (!car.race.finished) { wall += TICK_MS; drive(wall); }
  const wallFinish = wall;

  assert.notEqual(sim.finishDeadline, null);
  const grace = sim.finishDeadline - wallFinish;
  assert.ok(Math.abs(grace - FINISH_GRACE_MS) < 60,
    `a türelmi idő a faliórán mérve legyen ${FINISH_GRACE_MS} ms (mért: ${grace.toFixed(0)})`);
  assert.ok(car.race.finishedAt - wallFinish > 300,
    'a befutó nyers ideje továbbra is a mozgás-órán van — épp ezt kellett korrigálni');
});
