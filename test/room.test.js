import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/game/room.js';

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
