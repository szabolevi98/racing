// A kliens ne állítson sorba elavult állapotcsomagokat.
//
// A szerver már így működik (wsServer.broadcastRoom: lassú kliensnél eldobja a
// snapshotot), a kliens oldalán viszont nem volt párja. Egy pillanatnyi
// feltöltési akadásnál a csomagok felgyűlnek, majd késve, SOROZATBAN érkeznek:
// a szerver elavult állapotok sorát kapja, a többi játékos pedig azt látja,
// hogy az a kocsi megáll, majd ugrik egyet.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const mp = fs.readFileSync(new URL('../web/mp.js', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../server/net/wsServer.js', import.meta.url), 'utf8');

test('a kliens a kimeneti sor méretéhez köti az állapotküldést', () => {
  assert.match(mp, /const backlog = ws\?\.bufferedAmount \|\| 0/);
  assert.match(mp, /const backlogFull = backlog > STATE_BACKLOG_LIMIT_BYTES/);
  assert.match(mp, /if \(sendStateNow && !backlogFull\)/, 'a küldés nincs a sorhoz kötve');
});

test('a küszöb nagyságrendje néhány csomagnyi, nem több másodpercnyi', () => {
  const m = /const STATE_BACKLOG_LIMIT_BYTES = (\d+);/.exec(mp);
  assert.ok(m, 'nincs küszöb-konstans');
  const limit = Number(m[1]);
  // Egy állapotcsomag ~210 bájt, a küldés 30 Hz. A sor ne jelentsen többet
  // ~200 ms elmaradásnál, mert annál régebbi állapotot már nem érdemes útnak
  // indítani — de legyen benne néhány csomagnyi tartalék a normál működéshez.
  const csomag = 210, hz = 30;
  const elmaradasMs = limit / csomag / hz * 1000;
  assert.ok(elmaradasMs >= 30, `a küszöb túl szoros: ${elmaradasMs.toFixed(0)} ms`);
  assert.ok(elmaradasMs <= 200, `a küszöb túl laza: ${elmaradasMs.toFixed(0)} ms`);
});

test('a kihagyott küldés látszik a diagnosztikában', () => {
  assert.match(mp, /statesDropped\+\+/);
  assert.match(mp, /get statesDropped\(\)/);
});

test('a szerver oldali párja megmarad', () => {
  // Ha ez eltűnne, a lassú kliens megint korlátlanul sorba állna.
  assert.match(server, /type === S2C\.SNAPSHOT && socket\.bufferedAmount > snapshotBacklogLimit/);
});
