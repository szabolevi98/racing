import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/game/room.js';
import { GAME_MODE } from '../shared/protocol.js';

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
