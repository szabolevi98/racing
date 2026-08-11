// A szobakereső lapozása. A lényeg nem az, hogy a szeletelés működik, hanem
// hogy egy kérés MINDIG legfeljebb egy oldalnyit visz át, a lapok együtt
// pontosan a teljes listát adják, és egy időközben megszűnt oldal kérése a
// legközelebbi létezőre esik vissza — nem üres képernyőre.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOM_LIST_PAGE_SIZE, paginateRooms as oldal } from '../shared/protocol.js';

// Szándékosan a VALÓDI szeletelőt hívjuk, nem másoljuk le a képletét — a
// szerver (wsServer sendRoomList) is ezt használja, tehát ha az elromlik, ez
// a teszt megbukik. Szoba-példányok nélkül vizsgáljuk: itt a lapozás
// aritmetikája a kérdés, a szobák életciklusa a room-listing tesztre tartozik.

const szobak = (n) => Array.from({ length: n }, (_, i) => `SZOBA${i}`);

test('one page is five rooms', () => {
  assert.equal(ROOM_LIST_PAGE_SIZE, 5);
});

test('a request never carries more than one page', () => {
  for (const n of [0, 1, 5, 6, 12, 100, 1000]) {
    const v = oldal(szobak(n), 0);
    assert.ok(v.rooms.length <= ROOM_LIST_PAGE_SIZE,
      `${n} szobánál ${v.rooms.length} ment volna át`);
    assert.equal(v.total, n, 'az összlétszám viszont mindig megvan');
  }
});

test('the pages together are exactly the whole list', () => {
  const osszes = szobak(100);
  const latott = [];
  const { pages } = oldal(osszes, 0);
  assert.equal(pages, 20);
  for (let p = 0; p < pages; p++) latott.push(...oldal(osszes, p).rooms);
  assert.deepEqual(latott, osszes, 'se kihagyás, se ismétlés');
});

test('the last page holds the remainder', () => {
  const v = oldal(szobak(12), 2);
  assert.equal(v.pages, 3);
  assert.deepEqual(v.rooms, ['SZOBA10', 'SZOBA11']);
});

test('a page that no longer exists falls back to the last one', () => {
  // A kereső a 4. oldalon állt, mire a szobák nagy része megtelt vagy elindult.
  const v = oldal(szobak(7), 3);
  assert.equal(v.pages, 2);
  assert.equal(v.page, 1, 'a legközelebbi létező oldal');
  assert.ok(v.rooms.length > 0, 'és van rajta mit mutatni');
});

test('a negative page lands on the first', () => {
  assert.equal(oldal(szobak(20), -5).page, 0);
});

test('an empty list is still one page, not zero', () => {
  // Nulla oldal esetén a kliens „1 / 0"-t írna ki, és a lapozó értelmetlen lenne.
  const v = oldal([], 0);
  assert.equal(v.pages, 1);
  assert.equal(v.page, 0);
  assert.deepEqual(v.rooms, []);
});
