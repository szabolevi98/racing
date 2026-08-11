// Mi kerülhet a szobakeresőbe? A lényeg nem az, hogy a lista működik, hanem
// hogy PONTOSAN a nyitott publikus versenyszobák látszanak — és hogy a
// listasor nem szivárogtat ki a bent lévőkről semmit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/game/room.js';
import { GAME_MODE, ROOM_STATE, MAX_PLAYERS_PER_ROOM } from '../shared/protocol.js';

const host = { id: 'host' };
const makeRoom = (opts = {}) =>
  new Room('ABC123', host, { mapId: 'palya', laps: 3, ...opts });

test('a public multiplayer lobby is listed', () => {
  const room = makeRoom();
  room.add(host, 'auto');
  assert.equal(room.isPublic, true, 'alapból publikus');
  assert.equal(room.isListable, true);
});

test('a private room stays out of the browser', () => {
  const room = makeRoom({ isPublic: false });
  room.add(host, 'auto');
  assert.equal(room.isPublic, false);
  assert.equal(room.isListable, false);
});

test('Hot Lap is never public', () => {
  // Egyszemélyes, nincs mit meghirdetni — akkor sem, ha a kérés publikusat kér.
  const room = makeRoom({ mode: GAME_MODE.HOT_LAP, isPublic: true });
  assert.equal(room.isPublic, false);
  assert.equal(room.isListable, false);
});

test('a room that already started is not listed', () => {
  const room = makeRoom();
  room.add(host, 'auto');
  for (const state of [ROOM_STATE.LOADING, ROOM_STATE.COUNTDOWN, ROOM_STATE.RACING, ROOM_STATE.FINISHED]) {
    room.state = state;
    assert.equal(room.isListable, false, `${state} állapotban ne hirdesse magát`);
  }
  room.state = ROOM_STATE.LOBBY;
  assert.equal(room.isListable, true, 'a verseny után újra nyitott');
});

test('a full room is not listed', () => {
  const room = makeRoom();
  for (let i = 0; i < MAX_PLAYERS_PER_ROOM; i++) room.add({ id: 'p' + i }, 'auto');
  assert.equal(room.isFull, true);
  assert.equal(room.isListable, false);
});

test('the listing carries the player count but no player details', () => {
  const room = makeRoom({ laps: 7 });
  room.add(host, 'auto');
  room.add({ id: 'masik', name: 'Titkos Név' }, 'auto');
  const sor = room.listing();

  assert.equal(sor.players, 2, 'a létszám szám, nem lista');
  assert.equal(sor.max, MAX_PLAYERS_PER_ROOM);
  assert.equal(sor.code, 'ABC123');
  assert.equal(sor.laps, 7);
  // A listát olyanok kapják, akik NINCSENEK bent: a bent lévők neve, színe és
  // készenléte nem tartozik rájuk.
  assert.equal(JSON.stringify(sor).includes('Titkos Név'), false);
  assert.deepEqual(
    Object.keys(sor).sort(),
    ['code', 'ghostMode', 'laps', 'mandatoryPitStop', 'mapId', 'max', 'players'],
  );
});

test('room state tells members whether the room is public', () => {
  const nyilt = makeRoom();
  nyilt.add(host, 'auto');
  assert.equal(nyilt.toJSON().isPublic, true);

  const zart = makeRoom({ isPublic: false });
  zart.add(host, 'auto');
  assert.equal(zart.toJSON().isPublic, false);
});
