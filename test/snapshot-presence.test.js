// A még be nem töltött játékosról a szerver csak rajtrács-helyfoglalót tud
// (magasság nélkül, y=0). A snapshot `rd` mezője mondja meg a kliensnek, hogy
// ezt még nem szabad kirajzolni — enélkül a kocsi a talaj alatt állna, majd
// betöltéskor előbukkanna alóla.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RaceController } from '../server/game/raceController.js';
import { GAME_MODE, ROOM_STATE } from '../shared/protocol.js';

function makeController(playerCount) {
  const sent = [];
  const players = new Map();
  for (let i = 0; i < playerCount; i++) players.set(`p${i}`, { id: `p${i}`, slot: i, carId: 'car' });
  const room = {
    code: 'TEST', players, mode: GAME_MODE.MULTIPLAYER, state: ROOM_STATE.RACING,
    laps: 1, raceGeneration: 1, raceId: 1,
    recordLap: async () => {}, recordResults: async () => {}, toJSON: () => ({}),
  };
  const controller = new RaceController(room, {
    map: { spawns: [{ x: 10, z: 20, heading: 0 }, { x: 14, z: 20, heading: 0 }] },
    broadcast: (type, payload) => sent.push({ type, payload }),
  });
  return { controller, sent };
}
const lastSnapshot = (sent) => sent.filter((s) => s.type === 'snapshot').at(-1).payload;
const carOf = (snap, id) => snap.cars.find((c) => c.id === id);

test('a player who has not reported a position yet is marked absent', async () => {
  const { controller, sent } = makeController(2);
  await controller.start();
  try {
    controller.sendSnapshot(Date.now());
    const snap = lastSnapshot(sent);
    for (const id of ['p0', 'p1']) {
      assert.equal(carOf(snap, id).rd, false, `${id} még nem küldött állapotot`);
      // A helyfoglaló magassága tényleg 0 — ezért nem szabad kirajzolni.
      assert.equal(carOf(snap, id).p[1], 0);
    }
  } finally {
    controller.stop();
  }
});

test('reporting a position marks that player present, and only that one', async () => {
  const { controller, sent } = makeController(2);
  await controller.start();
  try {
    controller.receiveState('p0', {
      seq: 1, p: [10, 38.79, 20], q: [0, 0, 0, 1], v: [0, 0, 0], w: [0, 0, 0],
      st: 0, wr: 0, th: 0,
    }, { initial: true });
    controller.sendSnapshot(Date.now());
    const snap = lastSnapshot(sent);
    assert.equal(carOf(snap, 'p0').rd, true, 'p0 jelentkezett');
    assert.equal(carOf(snap, 'p1').rd, false, 'p1 még nem — őt ez nem érintheti');
    // És a valódi magassága megy ki, nem a helyfoglalóé.
    assert.equal(carOf(snap, 'p0').p[1], 38.79);
  } finally {
    controller.stop();
  }
});

test('a rejected state does not make the player present', async () => {
  const { controller, sent } = makeController(1);
  await controller.start();
  try {
    // Hiányos állapot: a sanitizeClientCarState elutasítja.
    const accepted = controller.receiveState('p0', { seq: 1, p: [1, 2] }, { initial: true });
    assert.equal(accepted, false, 'a szerver nem fogadta el');
    controller.sendSnapshot(Date.now());
    assert.equal(carOf(lastSnapshot(sent), 'p0').rd, false);
  } finally {
    controller.stop();
  }
});

test('a snapshot preserves each car state time until a new safe state is accepted', async () => {
  const { controller, sent } = makeController(1);
  await controller.start();
  try {
    const state = {
      seq: 1, t: 1_000,
      p: [10, 1, 20], q: [0, 0, 0, 1], v: [0, 0, 0], w: [0, 0, 0],
      st: 0, wr: 0, th: 0,
    };
    controller.receiveState('p0', state, { initial: true, receivedAt: 1_000 });
    controller.sendSnapshot(1_100);
    controller.sendSnapshot(1_200);
    assert.equal(carOf(lastSnapshot(sent), 'p0').at, 1_000);
    assert.equal(carOf(lastSnapshot(sent), 'p0').seq, 1);

    assert.equal(controller.receiveState('p0', {
      ...state, seq: 2, t: 1_250, p: [11, 1, 20], v: [160, 0, 0],
    }, { receivedAt: 1_250 }), false);
    controller.sendSnapshot(1_300);
    assert.equal(carOf(lastSnapshot(sent), 'p0').at, 1_000,
      'a karanténba tett póz nem frissítheti a proxy életkorát');
    assert.equal(carOf(lastSnapshot(sent), 'p0').seq, 1);

    assert.equal(controller.receiveState('p0', {
      ...state, seq: 3, t: 1_400, p: [10.1, 1, 20],
    }, { receivedAt: 1_400 }), true);
    controller.sendSnapshot(1_450);
    assert.equal(carOf(lastSnapshot(sent), 'p0').at, 1_400);
    assert.equal(carOf(lastSnapshot(sent), 'p0').seq, 3);
  } finally {
    controller.stop();
  }
});
