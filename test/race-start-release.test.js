import test from 'node:test';
import assert from 'node:assert/strict';
import { RaceController } from '../server/game/raceController.js';
import { GAME_MODE, ROOM_STATE } from '../shared/protocol.js';

function makeRoom(state, countdownEndsAt) {
  const player = { id: 'one', slot: 0, carId: 'car' };
  return {
    code: 'TEST',
    players: new Map([[player.id, player]]),
    mode: GAME_MODE.MULTIPLAYER,
    mapId: 'map',
    laps: 1,
    state,
    countdownEndsAt,
    raceGeneration: 1,
    raceId: 1,
    recordLap: async () => {},
    recordResults: async () => {},
    toJSON: () => ({}),
  };
}

async function startController(room) {
  const controller = new RaceController(room, {
    map: { spawns: [{ x: 0, z: 0, heading: 0 }] },
    broadcast: () => {},
  });
  room.sim = controller;
  await controller.start();
  clearInterval(controller.timer);
  controller.timer = null;
  return controller;
}

test('a controller that starts after the countdown deadline releases immediately', async () => {
  const room = makeRoom(ROOM_STATE.COUNTDOWN, 1_000);
  const controller = await startController(room);
  try {
    controller.pump(1_001);
    assert.equal(room.state, ROOM_STATE.RACING);
  } finally {
    controller.stop();
  }
});

test('a loading race stays frozen until its announced start time', async () => {
  const room = makeRoom(ROOM_STATE.LOADING, 0);
  const controller = await startController(room);
  try {
    controller.pump(1_500);
    assert.equal(room.state, ROOM_STATE.LOADING);

    room.state = ROOM_STATE.COUNTDOWN;
    controller.releaseAt(2_000);
    controller.pump(1_999);
    assert.equal(room.state, ROOM_STATE.COUNTDOWN);
    controller.pump(2_000);
    assert.equal(room.state, ROOM_STATE.RACING);
  } finally {
    controller.stop();
  }
});
