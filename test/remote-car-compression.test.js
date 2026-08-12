import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REMOTE_CAR_PROFILES, sourceSignature, legacySignatureMatches } from '../tools/build-remote-cars.mjs';

const assets = fs.readFileSync(new URL('../server/assets.js', import.meta.url), 'utf8');
const multiplayer = fs.readFileSync(new URL('../web/mp.js', import.meta.url), 'utf8');

test('remote car compression profiles become progressively smaller', () => {
  assert.equal(REMOTE_CAR_PROFILES[0].name, 'lossless');
  assert.equal(REMOTE_CAR_PROFILES.at(-1).name, 'last-resort');
  for (let i = 1; i < REMOTE_CAR_PROFILES.length; i++) {
    assert.ok(REMOTE_CAR_PROFILES[i].ratio <= REMOTE_CAR_PROFILES[i - 1].ratio);
    assert.ok(REMOTE_CAR_PROFILES[i].textureLimit <= REMOTE_CAR_PROFILES[i - 1].textureLimit);
    assert.ok(REMOTE_CAR_PROFILES[i].quality <= REMOTE_CAR_PROFILES[i - 1].quality);
  }
});

// Az aláírás a nyilvántartás lelke: ez dönti el, hogy egy autót újra kell-e
// konvertálni. Korábban a forrás módosítási idejéből képződött, amit a git nem
// őriz meg — a commitolt manifest így más gépen semmit nem spórolt volna.
test('the signature follows the file content, not its timestamp', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'remote-car-sig-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'car.glb');
  const target = 5 * 1024 * 1024;

  await fs.promises.writeFile(file, 'ugyanaz a tartalom');
  const first = await sourceSignature(file, (await fs.promises.stat(file)).size, target);

  // Csak az mtime változik: ettől NEM szabad újrakonvertálni.
  const later = new Date(Date.now() + 60_000);
  await fs.promises.utimes(file, later, later);
  const afterTouch = await sourceSignature(file, (await fs.promises.stat(file)).size, target);
  assert.equal(afterTouch, first, 'az érintés önmagában nem változtathatja meg az aláírást');

  // Azonos HOSSZÚSÁGÚ, de más tartalom: pont az az eset, amit a puszta
  // méret-összehasonlítás elszalasztana.
  await fs.promises.writeFile(file, 'ugyanaz a hosszúsag');
  const changed = await sourceSignature(file, (await fs.promises.stat(file)).size, target);
  assert.notEqual(changed, first, 'az azonos méretű átírást is észre kell venni');

  // Más célméret is új konvertálást kíván.
  const otherTarget = await sourceSignature(file, (await fs.promises.stat(file)).size, target / 2);
  assert.notEqual(otherTarget, changed);
});

test('legacy timestamp signatures are reused instead of forcing a full rebuild', () => {
  // Régi alak: <pipeline>:<méret>:<mtime>:<célméret>
  const legacy = '1:41196616:1785691169823:5242880';
  assert.ok(legacySignatureMatches(legacy, 41196616, 5242880), 'egyező méret és célméret mellett a kész fájl érvényes marad');
  assert.ok(!legacySignatureMatches(legacy, 41196617, 5242880), 'más forrásméret újrakonvertálást kíván');
  assert.ok(!legacySignatureMatches(legacy, 41196616, 4194304), 'más célméret újrakonvertálást kíván');

  // Az új alakot nem szabad örökölt aláírásként elfogadni: azt pontosan,
  // hash-re kell egyeztetni, különben a tartalomváltozás észrevétlen maradna.
  const modern = 'v2:1:41196616:5242880:' + 'a'.repeat(64);
  assert.ok(!legacySignatureMatches(modern, 41196616, 5242880));
  assert.ok(!legacySignatureMatches(undefined, 1, 1));
});

test('manifest and multiplayer use compressed visuals with original fallback', () => {
  assert.match(assets, /entry\.remoteFile = `cars\/compressed\/\$\{file\}`/);
  assert.match(assets, /entry\.remoteBytes = remoteStat\.size/);
  assert.match(multiplayer, /car\.remoteFile \|\| car\.file/);
  assert.match(multiplayer, /remoteBytes \?\? otherCar\?\.bytes/);
  assert.match(multiplayer, /remoteBytes \?\? replayCar\?\.bytes/);
  assert.match(multiplayer, /createRemoteWheelRig\(model, car\.config\?\.wheelPattern, group\)/);
});
