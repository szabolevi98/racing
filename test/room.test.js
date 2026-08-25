import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/game/room.js';
import { COUNTDOWN_MS, GAME_MODE, HOT_LAP_COUNTDOWN_MS } from '../shared/protocol.js';

test('each race randomly assigns exactly the first N grid slots', () => {
  const host = { id: 'host' };
  const room = new Room('TEST', host, { mapId: 'map', laps: 3 });
  room.add(host, 'car');
  room.add({ id: 'second' }, 'car');
  room.add({ id: 'third' }, 'car');

  // Kiszámítható keverés: bizonyítja, hogy a host nincs a 0. helyhez kötve.
  room.randomizeGridSlots(() => 0);
  const firstAssignment = [...room.players.values()].map((player) => player.slot);
  assert.deepEqual([...firstAssignment].sort((a, b) => a - b), [0, 1, 2]);
  assert.notEqual(room.players.get('host').slot, 0);

  // A következő futam újraoszt, továbbra is hézag és távolabbi rajthely nélkül.
  room.randomizeGridSlots(() => 0.999999);
  const secondAssignment = [...room.players.values()].map((player) => player.slot);
  assert.deepEqual(secondAssignment, [0, 1, 2]);
});

test('ghost mode is a room-wide setting included in room state', () => {
  const host = { id: 'host' };
  const ghostRoom = new Room('GHOST', host, { mapId: 'map', laps: 3, ghostMode: true });
  const normalRoom = new Room('NORMAL', host, { mapId: 'map', laps: 3 });

  assert.equal(ghostRoom.ghostMode, true);
  assert.equal(ghostRoom.toJSON().ghostMode, true);
  assert.equal(normalRoom.ghostMode, false);
  assert.equal(normalRoom.toJSON().ghostMode, false);
});

test('mandatory pit stop needs multiplayer mode and more than one lap', () => {
  const host = { id: 'host' };
  const race = new Room('PIT', host, { mapId: 'map', laps: 3, mandatoryPitStop: true });
  const oneLap = new Room('ONE', host, { mapId: 'map', laps: 1, mandatoryPitStop: true });
  const hotLap = new Room('HOT', host, {
    mapId: 'map', laps: 1, mode: GAME_MODE.HOT_LAP, mandatoryPitStop: true,
  });
  assert.equal(race.toJSON().mandatoryPitStop, true);
  assert.equal(race.listing().mandatoryPitStop, true);
  assert.equal(oneLap.toJSON().mandatoryPitStop, false);
  assert.equal(hotLap.toJSON().mandatoryPitStop, false);
});

test('Hot Lap is a one-lap server mode with collisionless replay support', () => {
  const host = { id: 'host' };
  const room = new Room('HOTLAP', host, {
    mapId: 'map', laps: 1, mode: GAME_MODE.HOT_LAP, ghostPlayerId: 42,
  });
  room.add(host, 'f2004');
  host.slot = 7;

  assert.equal(room.mode, GAME_MODE.HOT_LAP);
  assert.equal(room.ghostMode, true);
  assert.equal(room.ghostPlayerId, 42);
  assert.equal(room.toJSON().mode, GAME_MODE.HOT_LAP);
  assert.equal(room.toJSON().players[0].slot, 7);
});

test('Hot Lap keeps the selected ghost replay across R restarts', async () => {
  const host = { id: 'host' };
  const room = new Room('HOTLAP', host, {
    mapId: 'map', laps: 1, mode: GAME_MODE.HOT_LAP, ghostPlayerId: 42,
  });
  const replay = { playerId: 42, replay: { frames: [[0, 1, 2, 3, 0, 0, 0, 1]] } };
  let loads = 0;
  const loader = async () => { loads++; return replay; };

  assert.equal(await room.loadSelectedGhost(loader), replay);
  await room.finishAttempt(null);
  assert.equal(await room.loadSelectedGhost(loader), replay);
  assert.equal(loads, 1, 'R must reuse the selected replay instead of querying it again');
});

test('Hot Lap counts down for 3 seconds while multiplayer keeps 5 seconds', () => {
  const host = { id: 'host' };
  const multiplayer = new Room('MULTI', host, { mapId: 'map', laps: 3 });
  const hotLap = new Room('HOTLAP', host, {
    mapId: 'map', laps: 1, mode: GAME_MODE.HOT_LAP,
  });

  assert.equal(multiplayer.beginCountdown(1_000), 1_000 + COUNTDOWN_MS);
  assert.equal(hotLap.beginCountdown(1_000), 1_000 + HOT_LAP_COUNTDOWN_MS);
  assert.equal(COUNTDOWN_MS, 5_000);
  assert.equal(HOT_LAP_COUNTDOWN_MS, 3_000);
});

test('loading waits through the short reconnect grace instead of dropping the player immediately', () => {
  const host = { id: 'host', ready: true, socket: { readyState: 1 } };
  const other = { id: 'other', ready: false, socket: null, reconnectTimer: {} };
  const room = new Room('RECONNECT', host, { mapId: 'map', laps: 3 });
  room.add(host, 'car');
  room.add(other, 'car');
  host.ready = true;
  other.ready = false;

  assert.equal(room.allReady(), false);
  other.ready = true;
  assert.equal(room.allReady(), true);
});
