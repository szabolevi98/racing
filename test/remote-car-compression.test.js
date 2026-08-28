import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GEOMETRY_STEPS, TEXTURE_STEPS, PIPELINE_VERSION, planSettings, sourceSignature, legacySignatureMatches } from '../tools/build-remote-cars.mjs';

const build = fs.readFileSync(new URL('../tools/build-remote-cars.mjs', import.meta.url), 'utf8');

const assets = fs.readFileSync(new URL('../server/assets.js', import.meta.url), 'utf8');
const multiplayer = fs.readFileSync(new URL('../web/mp.js', import.meta.url), 'utf8');

test('both quality scales get monotonically worse and more expensive', () => {
  // A geometria-fokok a KÁR szerint sorolódnak, nem az arány szerint — egy
  // varratokon átvágó 50% kevesebbet ront, mint egy erőszakolt 18%. Ezért az
  // arány nem monoton; a költségnek és a módnak viszont annak kell lennie.
  for (let i = 1; i < GEOMETRY_STEPS.length; i++) {
    assert.ok(GEOMETRY_STEPS[i].cost > GEOMETRY_STEPS[i - 1].cost);
  }
  const mode = (s) => (s.aggressive ? 2 : s.permissive ? 1 : 0);
  for (let i = 1; i < GEOMETRY_STEPS.length; i++) {
    assert.ok(mode(GEOMETRY_STEPS[i]) >= mode(GEOMETRY_STEPS[i - 1]), 'a durvább mód nem előzheti meg a finomabbat');
    if (mode(GEOMETRY_STEPS[i]) === mode(GEOMETRY_STEPS[i - 1])) {
      assert.ok(GEOMETRY_STEPS[i].ratio < GEOMETRY_STEPS[i - 1].ratio, 'azonos módon belül az aránynak csökkennie kell');
      assert.ok(GEOMETRY_STEPS[i].error >= GEOMETRY_STEPS[i - 1].error);
    }
  }
  // A felbontás sosem nőhet. A kódolási minőség viszont igen — de csak akkor,
  // ha közben feleztük a felbontást: negyed annyi képponton belefér a jobb
  // kódolás, és összességében így is kisebb a fájl. Azonos felbontáson már
  // csak lefelé mehet.
  for (let i = 1; i < TEXTURE_STEPS.length; i++) {
    const a = TEXTURE_STEPS[i - 1], b = TEXTURE_STEPS[i];
    assert.ok(b.limit <= a.limit, 'a felbontás nem nőhet lefelé haladva');
    if (b.limit === a.limit) assert.ok(b.quality < a.quality, 'azonos felbontáson a minőségnek csökkennie kell');
    assert.ok(b.limit * b.limit * b.quality < a.limit * a.limit * a.quality, 'minden fok tényleg kisebb kimenetet célozzon');
    assert.ok(b.cost > a.cost);
  }
  assert.equal(GEOMETRY_STEPS[0].ratio, 1);
  assert.equal(GEOMETRY_STEPS[0].cost, 0);
  assert.equal(TEXTURE_STEPS[0].cost, 0);
});

// A tervező a mért tengelyekből választ cellát. A két autó, ami az egészet
// kiváltotta: a BMW 320i textúra-korlátos (kép 4,17 / geometria 2,19), a
// Porsche 911 GT1 geometria-korlátos (2,20 / 5,13). A jó válasz mindkettőnél a
// SZORÍTÓ oldal vágása — a másikhoz hozzá se nyúlni.
test('the planner cuts the side that actually holds the bytes', () => {
  const MB = 1024 * 1024;
  // Mért képméretek a textúra-skála fokain, és geometria-méretek a másikon.
  const bmwImages = [4.17, 3.25, 2.36, 1.87, 1.40, 1.10, 0.80, 0.55, 0.40].map((n) => n * MB);
  const bmwGeometry = [2.19, 1.86, 1.64, 1.42, 1.10, 0.77, 0.55, 0.39, 0.22, 0.13].map((n) => n * MB);
  const bmw = planSettings(bmwImages, bmwGeometry, 0.05 * MB, 5 * MB);
  assert.equal(GEOMETRY_STEPS[bmw.g].ratio, 1, 'a BMW geometriájához nem kell nyúlni');
  assert.equal(TEXTURE_STEPS[bmw.t].limit, 2048);

  const porscheImages = [2.20, 1.68, 1.20, 0.94, 0.70, 0.55, 0.40, 0.28, 0.20].map((n) => n * MB);
  const porscheGeometry = [5.13, 4.41, 3.93, 3.44, 2.72, 1.94, 1.40, 1.00, 0.60, 0.36].map((n) => n * MB);
  const porsche = planSettings(porscheImages, porscheGeometry, 0.09 * MB, 5 * MB);
  assert.equal(TEXTURE_STEPS[porsche.t].limit, 2048, 'a Porsche textúráját nem szabad felezni');
  assert.ok(GEOMETRY_STEPS[porsche.g].ratio >= 0.65, 'a mohó kereső itt 0.35-ig vágott, pedig 0.65 is befér');
});

test('the planner reports nothing fits rather than picking an oversized cell', () => {
  const huge = new Array(TEXTURE_STEPS.length).fill(9 * 1024 * 1024);
  const alsoHuge = new Array(GEOMETRY_STEPS.length).fill(9 * 1024 * 1024);
  assert.equal(planSettings(huge, alsoHuge, 0, 5 * 1024 * 1024), null);
});

// A `-sp` ("permissive simplification") engedélyt ad az egyszerűsítőnek, hogy
// az UV-varratokon átnyúlva vonjon össze csúcsokat — ettől csúszik el a
// textúra a modellen. Korábban MINDEN futás megkapta, ezért csúszott el a
// textúra olyan autókon is, amiknek nem volt rá szükségük. Most a lista végén
// áll: csak akkor kerül elő, ha nélküle a sziluettet kellene feláldozni.
test('crossing UV seams is a late resort, never the default', () => {
  assert.ok(!GEOMETRY_STEPS[0].permissive && !GEOMETRY_STEPS[0].aggressive);
  const gentlest = GEOMETRY_STEPS.filter((s) => !s.permissive && !s.aggressive);
  const permissive = GEOMETRY_STEPS.filter((s) => s.permissive);
  const aggressive = GEOMETRY_STEPS.filter((s) => s.aggressive);
  assert.ok(permissive.length && aggressive.length, 'mindkét végső eszköznek léteznie kell');
  assert.ok(Math.min(...permissive.map((s) => s.cost)) > Math.max(...gentlest.map((s) => s.cost)));
  assert.ok(Math.min(...aggressive.map((s) => s.cost)) > Math.max(...permissive.map((s) => s.cost)));
  // A kvantálás oldaláról ugyanezt védi, és ez feltétel nélkül jár.
  assert.match(build, /'-vtf'/);
});

// A `-sp` a hívásban is csak akkor szerepelhet, ha a fok tényleg azt kérte.
test('the permissive flag follows the step, not the default', () => {
  assert.match(build, /if \(geometry\.permissive\) args\.push\('-sp'\)/);
  assert.doesNotMatch(build, /'-kn', '-km', '-sp'/);
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

test('legacy timestamp signatures are reused only within the same pipeline', () => {
  // Régi alak: <pipeline>:<méret>:<mtime>:<célméret>
  const current = `${PIPELINE_VERSION}:41196616:1785691169823:5242880`;
  assert.ok(legacySignatureMatches(current, 41196616, 5242880), 'egyező méret és célméret mellett a kész fájl érvényes marad');
  assert.ok(!legacySignatureMatches(current, 41196617, 5242880), 'más forrásméret újrakonvertálást kíván');
  assert.ok(!legacySignatureMatches(current, 41196616, 4194304), 'más célméret újrakonvertálást kíván');

  // Ez a lényeg: a `-sp` kivételekor a pipeline verziója 2-re ugrott, a régi
  // bejegyzések viszont 1-esek voltak — és mivel az örökölt ág csak a méretet
  // nézte, 130 autó "naprakész" címén megtartotta az elcsúszott textúrájú
  // kimenetét. Nem a forrás avult el, hanem a konvertálás módja.
  const olderPipeline = `${PIPELINE_VERSION - 1}:41196616:1785691169823:5242880`;
  assert.ok(!legacySignatureMatches(olderPipeline, 41196616, 5242880), 'régebbi pipeline kimenetét nem szabad megtartani');

  // Az új alakot nem szabad örökölt aláírásként elfogadni: azt pontosan,
  // hash-re kell egyeztetni, különben a tartalomváltozás észrevétlen maradna.
  const modern = 'v2:1:41196616:5242880:' + 'a'.repeat(64);
  assert.ok(!legacySignatureMatches(modern, 41196616, 5242880));
  assert.ok(!legacySignatureMatches(undefined, 1, 1));
});

test('manifest and multiplayer use compressed visuals with original fallback', () => {
  assert.match(assets, /entry\.remoteFile = `cars\/compressed\/\$\{file\}`/);
  assert.match(assets, /entry\.remoteBytes = remoteStat\.size/);
  assert.match(assets, /entry\.remoteV = fileVersion\(remoteStat\)/);
  assert.match(multiplayer, /G\.assetUrl\(car, true\)/);
  assert.match(multiplayer, /remoteBytes \?\? otherCar\?\.bytes/);
  assert.match(multiplayer, /remoteBytes \?\? replayCar\?\.bytes/);
  assert.match(multiplayer, /createRemoteWheelRig\(model, car\.config\?\.wheelPattern, group\)/);
});

test('large player cars keep a non-public master and remote builds prefer it', () => {
  assert.match(build, /const MASTERS_DIR = path\.join\(ROOT, 'masters', 'cars'\)/);
  assert.match(build, /options\.primary \? DEFAULT_PRIMARY_TARGET_MB : DEFAULT_TARGET_MB/);
  assert.match(build, /!options\.primary && await fileExists\(master\) \? master/);
  assert.match(build, /options\.primary \? CARS_DIR : COMPRESSED_DIR/);
});
