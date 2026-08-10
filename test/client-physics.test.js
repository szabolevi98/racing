import test from 'node:test';
import assert from 'node:assert/strict';
import { physicsAuthorityFromEnv } from '../server/config.js';
import { ClientRaceSim, sanitizeClientCarState } from '../server/game/clientRaceSim.js';
import { PHYSICS_AUTHORITY, ROOM_STATE, GAME_MODE, S2C } from '../shared/protocol.js';

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

test('physics authority is server by default and client only when explicitly selected', () => {
  assert.equal(physicsAuthorityFromEnv({}), PHYSICS_AUTHORITY.SERVER);
  assert.equal(physicsAuthorityFromEnv({ PHYSICS_AUTHORITY: 'client' }), PHYSICS_AUTHORITY.CLIENT);
  assert.equal(physicsAuthorityFromEnv({ PHYSICS_AUTHORITY: ' CLIENT ' }), PHYSICS_AUTHORITY.CLIENT);
  assert.equal(physicsAuthorityFromEnv({ PHYSICS_AUTHORITY: 'anything-else' }), PHYSICS_AUTHORITY.SERVER);
});

test('client car state rejects non-finite and implausibly fast payloads', () => {
  assert.ok(sanitizeClientCarState(wireState(1, 1000, 0)));
  assert.equal(sanitizeClientCarState(wireState(1, 1000, 0, 0, { p: [NaN, 0, 0] })), null);
  assert.equal(sanitizeClientCarState(wireState(1, 1000, 0, 0, { v: [500, 0, 0] })), null);
  assert.equal(sanitizeClientCarState(wireState(1, 1000, 0, 0, { q: [0, 0, 0, 0] })), null);
});

test('client-authoritative controller relays state and still owns lap timing and ghosts', async () => {
  const room = makeRoom();
  const messages = [];
  const map = {
    spawns: [{ x: -1, z: 0, heading: Math.PI / 2 }],
    gates: {
      start: { x1: 0, z1: -5, x2: 0, z2: 5 },
      checkpoints: [{ x1: 10, z1: -5, x2: 10, z2: 5 }],
    },
  };
  const sim = new ClientRaceSim(room, {
    map,
    broadcast: (type, data) => messages.push({ type, ...data }),
  });
  room.sim = sim;
  await sim.start();
  try {
    assert.equal(sim.world, undefined, 'client mode must not create a Rapier world');
    assert.equal(sim.receiveState('p1', wireState(0, 900, -1), { initial: true, receivedAt: 900 }), true);
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
    assert.equal(room.lapsSaved[0][2], 1_900);
    assert.ok(room.lapsSaved[0][4]?.frames?.length >= 2, 'valid lap should save a ghost replay');
    assert.ok(messages.some((message) => message.type === S2C.RACE_EVENT && message.kind === 'lap'));
    assert.ok(messages.some((message) => message.type === S2C.RACE_END));
  } finally {
    sim.stop();
  }
});

test('client-authoritative reset is server-selected and allows the resulting teleport once', async () => {
  const room = makeRoom();
  const messages = [];
  const sim = new ClientRaceSim(room, {
    map: { spawns: [{ x: 5, z: 6, heading: 0 }], gates: null },
    broadcast: (type, data) => messages.push({ type, ...data }),
  });
  await sim.start();
  try {
    sim.receiveState('p1', wireState(0, 1000, 5, 6), { initial: true, receivedAt: 1000 });
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
