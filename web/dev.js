// Fejlesztői eszközök: szabad kamera, autó tesztelő, zóna-szerkesztő,
// checkpoint-generátor, anyag alapú aszfalt-felismerés és ütközési háló
// kimentése.
//
// Ez a modul SZÁNDÉKOSAN külön fájl, és csak akkor töltődik be, amikor
// valaki tényleg dev módba lép (main.js: enterDevMode → dinamikus import).
// Egy rendes játékos — és a multiplayer kliens — soha nem tölti le: a
// main.js-ben ez a rész ~1200 sor volt, ami minden oldalbetöltésnél felesleges
// forgalom és feldolgozás.
//
// A main.js-hez az `initDevTools(api)` köti: az api egy szűk felület a játék
// belső állapotához. Ami a main.js-ben `let` (pályaváltáskor újra értéket kap),
// az az api-n GETTER — ezért olvasunk mindig `api.currentTrack`-et, nem
// destrukturáljuk. A ténylegesen állandó dolgok (scene, camera, renderer, …)
// viszont nyugodtan kicsomagolhatók.
import * as THREE from 'three';
import {
  MAX_STEER, STEER_VISUAL_SPEED,
  MAX_ENGINE_FORCE, REVERSE_FACTOR, BRAKE_FRONT, BRAKE_REAR, HANDBRAKE_REAR_SLIP,
  FRONT_FRICTION_SLIP, REAR_FRICTION_SLIP, SUSPENSION, LINEAR_DAMPING, ANGULAR_DAMPING,
  setLiveVehicleTunables, resetLiveVehicleTunables,
} from '/shared/vehicleConfig.js';

// ---------- DOM: a csak dev módban használt elemek ----------
// A markupjuk NINCS benne az index.html-ben — a dev.html-ből injektáljuk be
// (ld. injectMarkup lent), hogy egy rendes játékosnak ne kelljen letöltenie.
// Ezért ezek `let`-ek, és csak az injektálás UTÁN kapnak értéket.
let devHudEl, devSpawnCountEl, devSpawnStatusEl, devMapSelectEl;
let bakeCollisionBtn, bakeStatusEl, openZoneEditorBtn;
let carTesterBtn, carTesterHudEl, carTesterBackBtn, carTesterCarSelectEl;
let devDriveBtn, devDriveHudEl, devDriveBackBtn, devDriveResetBtn, devDriveSaveBtn, devDriveSlidersEl;
let openMaterialPickerBtn, generateCheckpointsBtn, autoCheckpointCountEl;
let materialPickerPanelEl, materialPickerGridEl, generateAsphaltBtn;
let closeMaterialPickerBtn, materialPickerStatusEl;
let closeZoneEditorBtn, saveZoneBtn, zoneEditorEl, zoneOverlayCanvas, zoneStatusEl;
let brushSizeRange, brushSizeLabel, brushSizeRow;
let spawnToolRow, zoneSpawnCountEl, undoSpawnBtn;
let gateToolRow, startLineStateEl, checkpointCountEl, undoGateBtn, clearCheckpointsBtn;
let guideToolRow, guidePointCountEl, undoGuideBtn, clearGuideBtn, autoCheckpointRow;

// A dev felület markupja + stílusa egy külön HTML-fragmentben él (nem önálló
// oldal: nincs benne <html>/<body>, csak a beszúrandó tartalom). Egyszer
// töltjük be, az első dev módba lépéskor.
async function injectMarkup() {
  if (document.getElementById('devUiRoot')) return;
  const res = await fetch('dev.html', { cache: 'no-cache' });
  if (!res.ok) throw new Error('dev.html HTTP ' + res.status);
  const host = document.createElement('div');
  host.id = 'devUiRoot';
  host.innerHTML = await res.text();
  document.body.appendChild(host);
}

function queryElements() {
  const $ = (id) => {
    const el = document.getElementById(id);
    // Elgépelt/átnevezett id-t azonnal lássunk, ne csak akkor, amikor egy
    // kezelő null-on hasal el valahol mélyen.
    if (!el) throw new Error('dev.html: hiányzó elem #' + id);
    return el;
  };
  devHudEl = $('devHud');
  devSpawnCountEl = $('devSpawnCount');
  devSpawnStatusEl = $('devSpawnStatus');
  devMapSelectEl = $('devMapSelect');
  bakeCollisionBtn = $('bakeCollisionBtn');
  bakeStatusEl = $('bakeStatus');
  openZoneEditorBtn = $('openZoneEditorBtn');
  carTesterBtn = $('carTesterBtn');
  carTesterHudEl = $('carTesterHud');
  carTesterBackBtn = $('carTesterBackBtn');
  carTesterCarSelectEl = $('carTesterCarSelect');
  devDriveBtn = $('devDriveBtn');
  devDriveHudEl = $('devDriveHud');
  devDriveBackBtn = $('devDriveBackBtn');
  devDriveResetBtn = $('devDriveResetBtn');
  devDriveSaveBtn = $('devDriveSaveBtn');
  devDriveSlidersEl = $('devDriveSliders');
  openMaterialPickerBtn = $('openMaterialPickerBtn');
  generateCheckpointsBtn = $('generateCheckpointsBtn');
  autoCheckpointCountEl = $('autoCheckpointCount');
  materialPickerPanelEl = $('materialPickerPanel');
  materialPickerGridEl = $('materialPickerGrid');
  generateAsphaltBtn = $('generateAsphaltBtn');
  closeMaterialPickerBtn = $('closeMaterialPickerBtn');
  materialPickerStatusEl = $('materialPickerStatus');
  closeZoneEditorBtn = $('closeZoneEditorBtn');
  saveZoneBtn = $('saveZoneBtn');
  zoneEditorEl = $('zoneEditor');
  zoneOverlayCanvas = $('zoneOverlayCanvas');
  zoneStatusEl = $('zoneStatus');
  brushSizeRange = $('brushSizeRange');
  brushSizeLabel = $('brushSizeLabel');
  brushSizeRow = $('brushSizeRow');
  spawnToolRow = $('spawnToolRow');
  zoneSpawnCountEl = $('zoneSpawnCount');
  undoSpawnBtn = $('undoSpawnBtn');
  gateToolRow = $('gateToolRow');
  startLineStateEl = $('startLineState');
  checkpointCountEl = $('checkpointCount');
  undoGateBtn = $('undoGateBtn');
  clearCheckpointsBtn = $('clearCheckpointsBtn');
  guideToolRow = $('guideToolRow');
  guidePointCountEl = $('guidePointCount');
  undoGuideBtn = $('undoGuideBtn');
  clearGuideBtn = $('clearGuideBtn');
  autoCheckpointRow = $('autoCheckpointRow');
}

// A main.js ezen keresztül rejti el a dev felületet, amikor menübe / vezetésbe
// / multiplayerbe vált — így a main.js-nek egyetlen dev DOM-elemet sem kell
// ismernie. Ha a modul nincs betöltve, nincs is mit elrejteni.
function hideOverlays() {
  devHudEl.classList.add('hidden');
  carTesterHudEl.classList.add('hidden');
  devDriveHudEl.classList.add('hidden');
  zoneEditorEl.classList.add('hidden');
  // Ha épp vezetéses tesztelés közben hívják (pl. a "Vissza a menübe" linkkel,
  // nem a panel saját gombjával), a hangolást AKKOR IS visszaállítjuk —
  // különben a felfüggesztés/csillapítás élőben módosított értéke átszivárogna
  // egy utána indított valódi versenybe (a motorerő/fék/tapadás ellen a
  // startRace() már véd, de ezek a Rapier-objektumon direktben módosított
  // értékek nem mennek át azon a biztonsági hálón).
  if (devDriveActive) {
    devDriveActive = false;
    resetAllTunables();
    devSpawnMarkers.forEach((m) => { m.visible = true; });
  }
}

let api = null;
// A main.js-ből kicsomagolt, nem változó dolgok — az initDevTools tölti fel.
let scene, camera, renderer, carPivot, keys, hudEl, menuEl, carSelect;
let NORMAL_FOG_DENSITY;
let moveTowardsAngle, updateSunTarget, updateShowcaseCamera;
let findEntry, fillSelect, setTrack, loadZoneRuntime, extractDrivableTriangles, makeSearchableSelect;

const maxSteerVal = MAX_STEER;

// ---------- Dev mód: szabad kamera + rajtrács-pontok kijelölése ----------
const devKeys = {};
let devYaw = 0;
let devPitch = 0;
let devSpeed = 8;
const devSpawnMarkers = [];
let devMarkerGeometry = null;
let devMarkerMaterial = null;

function enterDevMode() {
  api.appState = 'dev';
  menuEl.classList.add('hidden');
  hudEl.classList.add('hidden');
  devHudEl.classList.remove('hidden');
  document.activeElement?.blur();
  // Dev módban a köd csak zavarna a pálya nagyobb távolságú áttekintésénél.
  scene.fog.density = 0;

  const box = api.currentTrackBox;
  const center = box ? box.getCenter(new THREE.Vector3()) : new THREE.Vector3();
  const topY = box ? box.max.y + 40 : 40;
  camera.position.set(center.x, topY, center.z);
  devYaw = 0;
  devPitch = -0.5;

  refreshSpawnMarkers();
}

// ---------- Autó tesztelő (dev módból nyitható): a kocsi egy helyben áll a
// rajtponton, a kerekek folyamatosan forognak és A/D-vel (vagy a nyilakkal)
// vizuálisan kormányoznak — így gyorsan végig lehet nézni sok kocsi
// kerekeit anélkül, hogy tényleg vezetni kéne. A W/S (vagy fel/le nyíl) a
// következő/előző kocsira vált a legördülő megnyitása nélkül. Magát a
// kocsiváltást a main.js végzi (a MENÜBEN is működik), mi csak a tesztelő
// legördülőjét tartjuk szinkronban.
let carTestWheelAngle = 0;
let carTestSteerAngle = 0;
const CARTEST_ROLL_SPEED = 6; // rad/mp — kb. 1 fordulat/mp, jól látható tempó

function populateCarTesterSelect() {
  const manifest = api.manifest;
  if (!manifest || carTesterCarSelectEl.options.length) return;
  manifest.cars.forEach((entry, idx) => {
    const opt = document.createElement('option');
    opt.value = entry.id;
    opt.textContent = `${idx + 1}/${manifest.cars.length}: ${entry.label}`;
    carTesterCarSelectEl.appendChild(opt);
  });
}

function enterCarTester() {
  if (!api.manifest) return;
  api.appState = 'cartest';
  devHudEl.classList.add('hidden');
  carTesterHudEl.classList.remove('hidden');
  carTestWheelAngle = 0;
  // A rajtpont-jelölők kitakarnák a közelről nézett kocsit.
  devSpawnMarkers.forEach((m) => { m.visible = false; });
  populateCarTesterSelect();
  carTesterCarSelectEl.value = carSelect.value;
  // A szabad kamerás dev nézetben a köd csak zavarna a pálya áttekintésénél
  // (enterDevMode ezért nullázza) — közelről néző autó-tesztelőben viszont
  // pont úgy kell kinéznie a kocsinak, mint rendes vezetés közben.
  scene.fog.density = NORMAL_FOG_DENSITY;
}

function exitCarTester() {
  carTesterHudEl.classList.add('hidden');
  api.appState = 'dev';
  devHudEl.classList.remove('hidden');
  devSpawnMarkers.forEach((m) => { m.visible = true; });
  scene.fog.density = 0;
}

function updateCarTest(dt) {
  carTestWheelAngle += dt * CARTEST_ROLL_SPEED;
  const steerLeft = keys['KeyA'] || keys['ArrowLeft'];
  const steerRight = keys['KeyD'] || keys['ArrowRight'];
  const targetSteer = steerLeft ? maxSteerVal : steerRight ? -maxSteerVal : 0;
  carTestSteerAngle = moveTowardsAngle(carTestSteerAngle, targetSteer, STEER_VISUAL_SPEED * dt);
  const wheelPivots = api.wheelPivots;
  const wheelSources = api.wheelSources;
  for (let i = 0; i < wheelPivots.length; i++) {
    const src = wheelSources[i];
    wheelPivots[i].rotation.set(carTestWheelAngle, src.steer ? carTestSteerAngle : 0, 0);
  }
  updateSunTarget(carPivot.position);
  updateShowcaseCamera(dt);
}

// ---------- Vezetéses teszt: a kocsi VALÓDI fizikával megy a pályán, verseny/
// checkpointok nélkül, plusz egy panel a menetdinamika élő hangolásához.
//
// Nincs önálló animate()-ág: a meglévő 'driving' állapotot használjuk
// (ugyanaz a fix-timestep fizika, interpoláció, kerékvizuál, kameraden, amit
// az egyjátékos vezetés is), csak `race.active = false`-ra állítva — így
// verseny/visszaszámlálás nélkül, azonnal irányítható a kocsi. Ez a
// legkisebb kockázatú megoldás: a driving-ág kódját egyáltalán nem kell
// megérteni/módosítani, csak "belépünk" az állapotba.
//
// A csúszkák a motorerőt/kormányt/féket/tapadást a shared/vehicleConfig.js
// MUTÁLHATÓ élő másolatán (setLiveVehicleTunables) írják át — ezt az
// applyControls minden képkockán onnan olvassa. A felfüggesztést és a
// csillapítást viszont KÖZVETLENÜL a Rapier-objektumon állítjuk, mert azok
// nem "per-frame" olvasott értékek, hanem a jármű felépítésekor egyszer
// beállított paraméterek — de a Rapier engedi őket futás közben is módosítani.
let devDriveActive = false;

// [kulcs, felirat, min, max, lépésköz]. A kulcs SZÁNDÉKOSAN pontosan
// megegyezik a shared/vehicleTunables.js export-nevével (SUSPENSION_* is!) —
// ez teszi lehetővé, hogy a "Mentés fájlba" gomb közvetlenül ebből a
// listából generáljon egy azzal a fájllal 1:1 megegyező tartalmat, mapping
// nélkül. A felfüggesztés/csillapítás nem "per-frame" olvasott érték
// (azokat az applyTunable közvetlenül a Rapier-objektumon állítja), a többi
// a shared/vehicleConfig.js élő, mutálható másolatán megy át.
const VEHICLE_TUNABLES = [
  ['MAX_ENGINE_FORCE', 'Motorerő', 300, 2500, 10],
  ['REVERSE_FACTOR', 'Hátramenet szorzó', 0.1, 1, 0.01],
  ['MAX_STEER', 'Kormány max. szöge', 0.2, 1.0, 0.01],
  ['BRAKE_FRONT', 'Fék — elöl', 1, 120, 0.5],
  ['BRAKE_REAR', 'Fék — hátul', 1, 120, 0.5],
  ['HANDBRAKE_REAR_SLIP', 'Kézifék — hátsó tapadás', 0.1, 3, 0.05],
  ['FRONT_FRICTION_SLIP', 'Tapadás — elöl', 0.5, 8, 0.05],
  ['REAR_FRICTION_SLIP', 'Tapadás — hátul', 0.5, 8, 0.05],
  ['SUSPENSION_STIFFNESS', 'Felfüggesztés — merevség', 5, 100, 1],
  ['SUSPENSION_COMPRESSION', 'Felfüggesztés — kompresszió', 0.5, 10, 0.1],
  ['SUSPENSION_RELAXATION', 'Felfüggesztés — relaxáció', 0.5, 10, 0.1],
  ['SUSPENSION_MAX_TRAVEL', 'Felfüggesztés — max. löket', 0.05, 1, 0.01],
  ['LINEAR_DAMPING', 'Lineáris csillapítás', 0, 1, 0.01],
  ['ANGULAR_DAMPING', 'Szögsebesség-csillapítás', 0, 2, 0.01],
];

// A kanonikus (shared/vehicleTunables.js-beli) alapérték minden kulcshoz —
// ebből épül a panel induláskor, és ide áll vissza az "Alapértékek".
const CANONICAL_TUNABLES = {
  MAX_ENGINE_FORCE, REVERSE_FACTOR, MAX_STEER,
  BRAKE_FRONT, BRAKE_REAR, HANDBRAKE_REAR_SLIP,
  FRONT_FRICTION_SLIP, REAR_FRICTION_SLIP,
  SUSPENSION_STIFFNESS: SUSPENSION.stiffness,
  SUSPENSION_COMPRESSION: SUSPENSION.compression,
  SUSPENSION_RELAXATION: SUSPENSION.relaxation,
  SUSPENSION_MAX_TRAVEL: SUSPENSION.maxTravel,
  LINEAR_DAMPING, ANGULAR_DAMPING,
};

// A négy kerékre egyszerre — a felfüggesztés minden keréken azonos, a
// vehicleConfig.js is így építi fel (ld. buildVehicle).
function applyTunable(key, value) {
  const vehicle = api.vehicle;
  switch (key) {
    case 'SUSPENSION_STIFFNESS':
      for (let i = 0; i < 4; i++) vehicle.setWheelSuspensionStiffness(i, value);
      break;
    case 'SUSPENSION_COMPRESSION':
      for (let i = 0; i < 4; i++) vehicle.setWheelSuspensionCompression(i, value);
      break;
    case 'SUSPENSION_RELAXATION':
      for (let i = 0; i < 4; i++) vehicle.setWheelSuspensionRelaxation(i, value);
      break;
    case 'SUSPENSION_MAX_TRAVEL':
      for (let i = 0; i < 4; i++) vehicle.setWheelMaxSuspensionTravel(i, value);
      break;
    case 'LINEAR_DAMPING':
      api.chassisBody.setLinearDamping(value);
      break;
    case 'ANGULAR_DAMPING':
      api.chassisBody.setAngularDamping(value);
      break;
    default:
      // MAX_ENGINE_FORCE, MAX_STEER, BRAKE_*, HANDBRAKE_REAR_SLIP,
      // FRONT/REAR_FRICTION_SLIP, REVERSE_FACTOR — ezeket az applyControls
      // olvassa minden képkockán a shared/vehicleConfig.js élő másolatából.
      setLiveVehicleTunables({ [key]: value });
  }
}

// A jelenlegi csúszka-állásokból generál egy, a shared/vehicleTunables.js-szel
// FORMÁTUM szerint megegyező .js fájl-tartalmat — a kulcsok szándékos
// egyezése miatt (ld. VEHICLE_TUNABLES) ez tényleg csak felsorolás, mapping
// nélkül. A DOM-ból olvasunk (nem a Rapier-állapotból): a csúszka maga az
// egyetlen forrás, ami a "mit állítottam be" kérdésre válaszol.
function generateTunablesFileContent() {
  const lines = VEHICLE_TUNABLES.map(([key]) => {
    const input = document.getElementById(`vt-${key}`);
    const value = input ? Number(input.value) : CANONICAL_TUNABLES[key];
    return `export const ${key} = ${value};`;
  });
  return (
    '// A dev autó-tesztelő "Mentés fájlba" gombjával generálva.\n' +
    '// Ha ez jó lett, ez a fájl írja felül a projekt shared/vehicleTunables.js-ét.\n\n' +
    lines.join('\n') + '\n'
  );
}

// A böngésző File System Access API-ja (showSaveFilePicker) valódi "Mentés
// másként" ablakot nyit, amiben a projekt shared/ mappájába navigálva
// KÖZVETLENÜL felülírható a vehicleTunables.js — ez pontosan az, amit
// kértél. Csak Chromium-alapú böngészőkben létezik; ha nincs (Firefox/
// Safari, vagy ha a dev.html-t nem https/localhost-ról szolgálják ki),
// visszaesünk egy sima letöltésre — az a Letöltések mappába megy, onnan
// kézzel kell átmozgatni.
async function saveTunablesToFile() {
  const content = generateTunablesFileContent();
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: 'vehicleTunables.js',
        types: [{ description: 'JavaScript modul', accept: { 'text/javascript': ['.js'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      return;
    } catch (err) {
      // Az AbortError azt jelenti, hogy a mentési ablakot a felhasználó
      // zárta be — ez nem hiba, nincs mit jelezni.
      if (err.name === 'AbortError') return;
      console.warn('showSaveFilePicker sikertelen, letöltésre esünk vissza', err);
    }
  }
  const blob = new Blob([content], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'vehicleTunables.js';
  a.click();
  URL.revokeObjectURL(url);
}

function formatTunableValue(value, step) {
  const decimals = step < 1 ? String(step).split('.')[1]?.length ?? 2 : 0;
  return value.toFixed(decimals);
}

// A panel egyszeri felépítése: minden sor egy csúszka + élő kiolvasás.
// Nem a dev.html-ben van kézzel felsorolva mind a 14 sor, hogy a felirat, a
// tartomány és a kulcs EGY helyen (VEHICLE_TUNABLES) éljen — elgépelés esetén
// itt derül ki, nem egy másik fájlban eltérő id-ként.
function buildTunablePanel() {
  if (devDriveSlidersEl.childElementCount) return;
  for (const [key, label, min, max, step] of VEHICLE_TUNABLES) {
    const row = document.createElement('div');
    row.className = 'vt-row';
    row.innerHTML =
      `<label for="vt-${key}">${label}</label>` +
      `<input type="range" id="vt-${key}" min="${min}" max="${max}" step="${step}">` +
      `<span class="vt-value" id="vt-${key}-val"></span>`;
    devDriveSlidersEl.appendChild(row);
    const input = row.querySelector('input');
    const valueEl = row.querySelector('.vt-value');
    input.addEventListener('input', () => {
      const value = Number(input.value);
      applyTunable(key, value);
      valueEl.textContent = formatTunableValue(value, step);
    });
  }
}

// Minden csúszkát és a mögötte lévő élő/Rapier-értéket visszaállít a
// kanonikus alapra. Ezt hívja a "Vissza a dev módba" gomb ÉS a
// hideOverlays() is (ha máshonnan lép ki, pl. a "Vissza a menübe" linkkel) —
// így hangolás után SOSEM maradhat élesben a helyi jóslat vagy egy következő
// egyjátékos/multiplayer verseny.
function resetAllTunables() {
  resetLiveVehicleTunables();
  for (const [key, , , , step] of VEHICLE_TUNABLES) {
    const value = CANONICAL_TUNABLES[key];
    applyTunable(key, value);
    const input = document.getElementById(`vt-${key}`);
    if (input) {
      input.value = value;
      document.getElementById(`vt-${key}-val`).textContent = formatTunableValue(value, step);
    }
  }
}

function enterDevDrive() {
  if (!api.manifest || !api.currentTrack || devDriveActive) return;
  devDriveActive = true;
  devHudEl.classList.add('hidden');
  buildTunablePanel();
  resetAllTunables();
  api.prepareTrackPhysics()
    .then(() => {
      api.resetCarTo(api.spawnPoint);
      // Szabad vezetés: nincs rajtvonal-logika, visszaszámlálás, kör.
      api.race.active = false;
      api.appState = 'driving';
      hudEl.classList.remove('hidden');
      devDriveHudEl.classList.remove('hidden');
      // Ugyanaz a megfontolás, mint az autó-tesztelőnél: rendes vezetés
      // közben is van köd, a teszt akkor ér valamit, ha úgy néz ki, mint éles.
      scene.fog.density = NORMAL_FOG_DENSITY;
      // A 8 rajtpont-gömb csak a felülnézeti dev szerkesztéshez kell —
      // vezetés közben csak zavarna, és a saját kocsi mellett/alatt állva
      // kitakarná a kilátást.
      devSpawnMarkers.forEach((m) => { m.visible = false; });
      document.activeElement?.blur();
    })
    .catch((err) => {
      devDriveActive = false;
      devHudEl.classList.remove('hidden');
      devSpawnStatusEl.textContent = 'Nem sikerült előkészíteni a pálya fizikáját: ' + err.message;
    });
}

function exitDevDrive() {
  if (!devDriveActive) return;
  devDriveActive = false;
  resetAllTunables();
  devDriveHudEl.classList.add('hidden');
  hudEl.classList.add('hidden');
  api.appState = 'dev';
  devHudEl.classList.remove('hidden');
  scene.fog.density = 0;
  devSpawnMarkers.forEach((m) => { m.visible = true; });
}

// Jobb-klikk + húzás a nézelődéshez — nem pointer lock, hogy az egérmutató
// látható maradjon dev módban (nem tűnik el a képernyőről). A mousedown/
// mouseup PÁROSÍTÁS helyett minden mozgás-eseménynél az aktuális e.buttons
// bitmaszkot nézzük (2 = jobb gomb) — ha egy mouseup esemény elveszik
// (pl. a contextmenu miatt), ez önmagát korrigálja, nem "ragad be" a nézelődés.
let devLastMouseX = 0;
let devLastMouseY = 0;

// A 3D jelölő-gömböket mindig a currentSpawnPoints listából építjük újra —
// így a szabad kamerás dev nézetben és a felülnézeti szerkesztőben is
// ugyanaz látszik, bárhonnan is módosítottuk a listát.
function refreshSpawnMarkers() {
  devSpawnMarkers.splice(0).forEach((m) => scene.remove(m));
  const track = api.currentTrack;
  const box = api.currentTrackBox;
  if (!track || !box) return;

  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  api.currentSpawnPoints.forEach(({ x, z }) => {
    raycaster.set(new THREE.Vector3(x, box.max.y + 20, z), new THREE.Vector3(0, -1, 0));
    const hits = raycaster.intersectObject(track, true);
    const y = hits.length ? hits[0].point.y : box.min.y;
    const marker = new THREE.Mesh(devMarkerGeometry, devMarkerMaterial);
    marker.position.set(x, y + 1.2, z);
    scene.add(marker);
    devSpawnMarkers.push(marker);
  });
  devSpawnCountEl.textContent = String(api.currentSpawnPoints.length);
}

function updateDevCamera(dt) {
  camera.quaternion.setFromEuler(new THREE.Euler(devPitch, devYaw, 0, 'YXZ'));

  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const speed = devSpeed * (devKeys['ShiftLeft'] || devKeys['ShiftRight'] ? 15 : 1) * dt;

  if (devKeys['KeyW'] || devKeys['ArrowUp']) camera.position.addScaledVector(forward, speed);
  if (devKeys['KeyS'] || devKeys['ArrowDown']) camera.position.addScaledVector(forward, -speed);
  if (devKeys['KeyD'] || devKeys['ArrowRight']) camera.position.addScaledVector(right, speed);
  if (devKeys['KeyA'] || devKeys['ArrowLeft']) camera.position.addScaledVector(right, -speed);
  if (devKeys['Space']) camera.position.y += speed;
  if (devKeys['ControlLeft'] || devKeys['ControlRight']) camera.position.y -= speed;
}

// ---------- Aszfalt automatikus felismerése anyag-kiválasztás alapján ----------
// A letöltött pályamodellek anyagai gyakran értelmetlen nevekkel jönnek
// (pl. "282_63"), úgyhogy nem lehet név szerint megkeresni, melyik az
// útburkolat. Ehelyett a felhasználó bélyegképek alapján, VIZUÁLISAN
// kiválasztja, melyik anyag(ok) az aszfalt — utána ugyanazzal a felülnézeti
// GPU-renderrel, anyag szerint szűrve, kirajzoljuk, hol van ilyen anyagú
// felület, és abból generáljuk a zóna-maszkot.
let highlightMaterial = null;

// Az össze anyag begyűjtése a pálya modelljéből, bélyegkép-készítéshez.
// Egy anyaghoz több mesh is tartozhat — csak egyszer szerepeljen a listában.
function collectTrackMaterials(track) {
  const seen = new Set();
  const list = [];
  track.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    mats.forEach((mat) => {
      if (seen.has(mat)) return;
      seen.add(mat);
      list.push(mat);
    });
  });
  return list;
}

// Bélyegkép egy anyagról: ha van diffúz textúrája, azt rajzoljuk ki
// kicsiben, egyébként az anyag alapszínével töltjük ki a négyzetet.
function drawMaterialThumb(material, canvas) {
  const ctx = canvas.getContext('2d');
  const tex = material.map;
  const img = tex && tex.image;
  if (img && (img.width || img.videoWidth)) {
    try {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return;
    } catch (err) {
      // pl. még nem dekódolt kép — essünk vissza a színre
    }
  }
  const c = material.color || new THREE.Color(0x888888);
  ctx.fillStyle = `rgb(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

let selectedRoadMaterials = new Set();

function openMaterialPicker() {
  const track = api.currentTrack;
  if (!track) return;
  selectedRoadMaterials = new Set();
  materialPickerGridEl.innerHTML = '';
  materialPickerStatusEl.textContent = '';
  const materials = collectTrackMaterials(track);
  materials.forEach((mat) => {
    const canvas = document.createElement('canvas');
    canvas.width = 56;
    canvas.height = 56;
    canvas.className = 'material-thumb';
    canvas.title = mat.name || '(névtelen anyag)';
    drawMaterialThumb(mat, canvas);
    canvas.addEventListener('click', () => {
      if (selectedRoadMaterials.has(mat)) {
        selectedRoadMaterials.delete(mat);
        canvas.classList.remove('selected');
      } else {
        selectedRoadMaterials.add(mat);
        canvas.classList.add('selected');
      }
    });
    materialPickerGridEl.appendChild(canvas);
  });
  materialPickerPanelEl.classList.remove('hidden');
}

function closeMaterialPicker() {
  materialPickerPanelEl.classList.add('hidden');
}

// GPU-s felülnézeti render, ahol csak a kiválasztott anyagú mesh-ek
// látszanak (fehéren, világítástól függetlenül), minden más el van rejtve —
// így a kapott kép pontosan az útburkolat alakja.
function renderMaterialMask(track, bounds, texW, texH, materialSet) {
  const trackBox = api.currentTrackBox;
  const saved = [];
  track.traverse((obj) => {
    if (!obj.isMesh) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const uses = mats.some((m) => materialSet.has(m));
    saved.push({ obj, visible: obj.visible, material: obj.material });
    obj.visible = uses;
    if (uses) obj.material = highlightMaterial;
  });

  // A kocsi NEM a track gyereke, hanem közvetlenül a jelenethez van adva —
  // enélkül a fenti elrejtés után is átlátszana rajta a kamera.
  const extraHidden = [carPivot, ...devSpawnMarkers].filter(Boolean);
  const savedExtra = extraHidden.map((obj) => ({ obj, visible: obj.visible }));
  extraHidden.forEach((obj) => { obj.visible = false; });

  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxZ - bounds.minZ;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;
  const topCamera = new THREE.OrthographicCamera(-width / 2, width / 2, depth / 2, -depth / 2, 0.1, (trackBox.max.y - trackBox.min.y) + 200);
  topCamera.position.set(centerX, trackBox.max.y + 100, centerZ);
  topCamera.up.set(0, 0, -1);
  topCamera.lookAt(centerX, trackBox.min.y, centerZ);
  topCamera.updateProjectionMatrix();

  const prevSize = new THREE.Vector2();
  renderer.getSize(prevSize);
  const prevBackground = scene.background;
  const prevFogDensity = scene.fog.density;
  scene.background = new THREE.Color(0x000000);
  scene.fog.density = 0;

  renderer.setSize(texW, texH, false);
  renderer.render(scene, topCamera);

  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width = texW;
  tmpCanvas.height = texH;
  tmpCanvas.getContext('2d').drawImage(renderer.domElement, 0, 0, texW, texH);
  const pixels = tmpCanvas.getContext('2d').getImageData(0, 0, texW, texH).data;

  scene.background = prevBackground;
  scene.fog.density = prevFogDensity;
  renderer.setSize(prevSize.x, prevSize.y, false);

  saved.forEach((s) => {
    s.obj.visible = s.visible;
    s.obj.material = s.material;
  });
  savedExtra.forEach((s) => { s.obj.visible = s.visible; });

  const mask = new Uint8Array(texW * texH);
  for (let p = 0; p < texW * texH; p++) {
    const o = p * 4;
    if (pixels[o] > 40 || pixels[o + 1] > 40 || pixels[o + 2] > 40) mask[p] = 1;
  }
  return mask;
}

// A kiválasztott anyagok alapján legenerálja a TELJES zóna-maszkot: mindenhol
// kifutó (a felhasználó eredeti kérése — "legyen mindenhol sárga lassító"),
// kivéve ahol a kiválasztott anyagú felület van, ott aszfalt (törölt/átlátszó
// pixel — pont úgy, ahogy az aszfalt-ecset is töröl). Fal nem kerül bele.
function generateAsphaltMask() {
  const track = api.currentTrack;
  if (!track || !zoneMaskCanvas) return;
  if (!selectedRoadMaterials.size) {
    materialPickerStatusEl.textContent = 'Válassz ki legalább egy aszfalt-anyagot.';
    return;
  }
  materialPickerStatusEl.textContent = 'Generálás...';
  const texW = zoneMaskCanvas.width;
  const texH = zoneMaskCanvas.height;
  const mask = renderMaterialMask(track, zoneBounds, texW, texH, selectedRoadMaterials);

  const ctx = zoneMaskCanvas.getContext('2d');
  const imageData = ctx.createImageData(texW, texH);
  const data = imageData.data;
  // rgb(255,165,0) == OFFTRACK_COLOR — ugyanaz, mint amit az ecset fest.
  for (let p = 0; p < texW * texH; p++) {
    const o = p * 4;
    if (mask[p]) {
      data[o] = 0; data[o + 1] = 0; data[o + 2] = 0; data[o + 3] = 0;
    } else {
      data[o] = 255; data[o + 1] = 165; data[o + 2] = 0; data[o + 3] = 255;
    }
  }
  ctx.clearRect(0, 0, texW, texH);
  ctx.putImageData(imageData, 0, 0);

  closeMaterialPicker();
  zoneStatusEl.textContent = 'Aszfalt-maszk legenerálva a kiválasztott anyagokból — nézd át és finomítsd kézzel, majd Mentés.';
}

// ---------- Zóna-szerkesztő: felülnézeti "ecsetes" aszfalt/kifutó/fal térkép ----------
// A magasságtérkép (mennyire magas a talaj) és a zóna-térkép (milyen FELÜLET
// van ott) két teljesen külön adatréteg. Ez utóbbit itt festjük fel, egy
// world-editor jellegű ecsettel.
//
// FONTOS tervezési döntés: a pályát NEM egy előre elkészített kép mutatja,
// hanem élőben, ortografikus felülnézeti kamerával renderelt VALÓDI 3D
// geometria — így bármilyen zoomon éles marad (egy fix bitmap Spánál ~14
// világegység/pixel felbontású lenne, tehát nagyítva menthetetlenül homályos).
// Maga a festett maszk egy külön, világ-koordinátákhoz kötött rácson él, az
// ecset mérete pedig VILÁGEGYSÉGBEN értendő, nem képernyőpixelben — így a
// zoomtól függetlenül ugyanakkora területet fest.
const OFFTRACK_COLOR = 'rgb(255,165,0)';
const WALL_COLOR = 'rgb(220,20,60)';
// A festés pontosságának valódi korlátja a MASZK felbontása (nem az ecset
// mérete): ha egy maszk-pixel 3.5 világegység, akkor a pálya szélét sem lehet
// ennél pontosabban meghúzni. Ezért 0.5 egység/pixel a cél, összpixel-
// korláttal, hogy a nagyobb pályák se egyenek meg túl sok memóriát
// (RGBA canvas ~4 bájt/pixel).
const TARGET_MASK_CELL = 0.5;      // cél: ennyi világegység / maszk-pixel
const MAX_MASK_DIM = 8192;         // technikai felső korlát oldalhosszra
const MAX_MASK_PIXELS = 20e6;      // ~80 MB canvas — efölött arányosan durvítunk

let zoneBounds = null;       // {minX, maxX, minZ, maxZ} — a maszk világ-lefedettsége
let zoneMaskCanvas = null;   // offscreen: maga a festett maszk, világ-rácsban
let zonePainting = false;
let previousAppStateBeforeZone = 'dev';

// Az élő felülnézeti kamera állapota (világegységben).
const zoneView = { centerX: 0, centerZ: 0, height: 100 };
let zoneOrthoCam = null;

let zoneCursorWorld = null;  // az ecset-előnézethez

function getSelectedBrush() {
  const checked = document.querySelector('input[name="zoneBrush"]:checked');
  return checked ? checked.value : '0';
}

// A rajtrács-pontok lerakása is itt, a felülnézeti szerkesztőben történik —
// sokkal pontosabb, mint a 3D szabad kamerából lefelé lőtt sugárral.
function isSpawnTool() {
  return getSelectedBrush() === 'spawn';
}
function isGateTool() {
  const b = getSelectedBrush();
  return b === 'start' || b === 'checkpoint';
}
function isGuideTool() {
  return getSelectedBrush() === 'guide';
}
function isPaintTool() {
  return !isSpawnTool() && !isGateTool() && !isGuideTool();
}

function updateSpawnToolUI() {
  brushSizeRow.classList.toggle('d-none', !isPaintTool());
  spawnToolRow.classList.toggle('d-none', !isSpawnTool());
  gateToolRow.classList.toggle('d-none', !isGateTool());
  guideToolRow.classList.toggle('d-none', !isGuideTool());
  autoCheckpointRow.classList.toggle('d-none', !isGateTool() && !isGuideTool());
  zoneSpawnCountEl.textContent = String(api.currentSpawnPoints.length);
  devSpawnCountEl.textContent = String(api.currentSpawnPoints.length);
  startLineStateEl.textContent = api.currentGates.start ? 'kész' : 'nincs';
  checkpointCountEl.textContent = String(api.currentGates.checkpoints.length);
  guidePointCountEl.textContent = String(api.currentGuidePath.length);
}

// A rajtpont iránya (heading): az autó "előre" iránya a világ +Z, ezért a
// heading az ettől való elfordulás. atan2(dx, dz) adja meg, hogy a húzás
// irányához mennyit kell fordulni.
function headingFromDelta(dx, dz) {
  return Math.atan2(dx, dz);
}

function addSpawnPointAtWorld(x, z) {
  if (api.currentSpawnPoints.length >= 8) {
    zoneStatusEl.textContent = 'Már megvan mind a 8 rajtpont.';
    return null;
  }
  const point = { x: +x.toFixed(2), z: +z.toFixed(2), heading: 0 };
  api.currentSpawnPoints.push(point);
  refreshSpawnMarkers();
  updateSpawnToolUI();
  zoneStatusEl.textContent = '';
  return point;
}

function removeLastSpawnPoint() {
  if (!api.currentSpawnPoints.length) return;
  api.currentSpawnPoints.pop();
  refreshSpawnMarkers();
  updateSpawnToolUI();
}

function removeLastGate() {
  if (getSelectedBrush() === 'start') {
    api.currentGates.start = null;
  } else if (api.currentGates.checkpoints.length) {
    api.currentGates.checkpoints.pop();
  }
  updateSpawnToolUI();
}

function getBrushWorldRadius() {
  return Number(brushSizeRange.value);
}

function updateZoneOrthoCamera() {
  const trackBox = api.currentTrackBox;
  const w = zoneOverlayCanvas.width;
  const h = zoneOverlayCanvas.height;
  const aspect = w / h;
  const halfH = zoneView.height / 2;
  const halfW = halfH * aspect;
  zoneOrthoCam.left = -halfW;
  zoneOrthoCam.right = halfW;
  zoneOrthoCam.top = halfH;
  zoneOrthoCam.bottom = -halfH;
  zoneOrthoCam.near = 0.1;
  zoneOrthoCam.far = (trackBox.max.y - trackBox.min.y) + 500;
  zoneOrthoCam.position.set(zoneView.centerX, trackBox.max.y + 200, zoneView.centerZ);
  zoneOrthoCam.lookAt(zoneView.centerX, trackBox.min.y, zoneView.centerZ);
  zoneOrthoCam.updateProjectionMatrix();
}

// Képernyő-pixel -> világ X/Z. A felülnézeti ortokamera up=(0,0,-1) miatt a
// képernyő jobbra = világ +X, képernyő lefelé = világ +Z.
function zoneScreenToWorld(clientX, clientY) {
  const rect = zoneOverlayCanvas.getBoundingClientRect();
  const w = zoneOverlayCanvas.width;
  const h = zoneOverlayCanvas.height;
  const aspect = w / h;
  const halfH = zoneView.height / 2;
  const halfW = halfH * aspect;
  const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = -((((clientY - rect.top) / rect.height) * 2) - 1);
  return {
    x: zoneView.centerX + ndcX * halfW,
    z: zoneView.centerZ - ndcY * halfH,
  };
}

function zoneWorldToMaskPixel(x, z) {
  return {
    u: ((x - zoneBounds.minX) / (zoneBounds.maxX - zoneBounds.minX)) * zoneMaskCanvas.width,
    v: ((z - zoneBounds.minZ) / (zoneBounds.maxZ - zoneBounds.minZ)) * zoneMaskCanvas.height,
  };
}

function paintAtWorld(x, z) {
  const { u, v } = zoneWorldToMaskPixel(x, z);
  const unitsPerMaskPixel = (zoneBounds.maxX - zoneBounds.minX) / zoneMaskCanvas.width;
  const radiusPx = Math.max(0.5, getBrushWorldRadius() / unitsPerMaskPixel);
  const brush = getSelectedBrush();
  const ctx = zoneMaskCanvas.getContext('2d');

  ctx.save();
  ctx.beginPath();
  ctx.arc(u, v, radiusPx, 0, Math.PI * 2);
  if (brush === '0') {
    // Aszfalt = törlés (visszaáll az alapértelmezett, "nincs kijelölve" állapotra).
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fill();
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = brush === '1' ? OFFTRACK_COLOR : WALL_COLOR;
    ctx.fill();
  }
  ctx.restore();
}

// A maszkot és az ecset-előnézetet a 3D kép TETEJÉRE rajzoljuk, ugyanazzal a
// vetítéssel, amivel a felülnézeti kamera dolgozik.
function drawZoneOverlay() {
  const ctx = zoneOverlayCanvas.getContext('2d');
  const w = zoneOverlayCanvas.width;
  const h = zoneOverlayCanvas.height;
  ctx.clearRect(0, 0, w, h);

  const aspect = w / h;
  const halfH = zoneView.height / 2;
  const halfW = halfH * aspect;
  const worldW = zoneBounds.maxX - zoneBounds.minX;
  const worldD = zoneBounds.maxZ - zoneBounds.minZ;

  const su = ((zoneView.centerX - halfW - zoneBounds.minX) / worldW) * zoneMaskCanvas.width;
  const sv = ((zoneView.centerZ - halfH - zoneBounds.minZ) / worldD) * zoneMaskCanvas.height;
  const sw = ((2 * halfW) / worldW) * zoneMaskCanvas.width;
  const sh = ((2 * halfH) / worldD) * zoneMaskCanvas.height;

  ctx.globalAlpha = 0.55;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(zoneMaskCanvas, su, sv, sw, sh, 0, 0, w, h);
  ctx.globalAlpha = 1;

  // Világ X/Z -> képernyő-pixel (ugyanaz a vetítés, mint a felülnézeti kamerán).
  const toScreen = (wx, wz) => ({
    x: ((wx - (zoneView.centerX - halfW)) / (2 * halfW)) * w,
    y: ((wz - (zoneView.centerZ - halfH)) / (2 * halfH)) * h,
  });

  // Kapuk: a rajtvonal zöld, a checkpointok kékek és sorszámozottak.
  const drawGate = (g, color, label) => {
    const a = toScreen(g.x1, g.z1);
    const b = toScreen(g.x2, g.z2);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.stroke();
    if (label) {
      ctx.fillStyle = color;
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, (a.x + b.x) / 2, (a.y + b.y) / 2 - 12);
    }
  };
  const gates = api.currentGates;
  if (gates.start) drawGate(gates.start, '#28d17c', 'RAJT');
  gates.checkpoints.forEach((g, i) => drawGate(g, '#4aa3ff', 'CP' + (i + 1)));
  if (drawingGate) {
    drawGate(drawingGate, getSelectedBrush() === 'start' ? '#28d17c' : '#4aa3ff', null);
  }

  // Kézzel rajzolt vezetővonal a checkpont-generáláshoz — pontok sorban
  // összekötve, hogy lássa a felhasználó, merre fog "menni" a generálás.
  const guidePath = api.currentGuidePath;
  if (guidePath.length) {
    ctx.beginPath();
    guidePath.forEach((p, i) => {
      const s = toScreen(p.x, p.z);
      if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
    });
    ctx.strokeStyle = '#ffc107';
    ctx.lineWidth = 3;
    ctx.stroke();
    guidePath.forEach((p) => {
      const s = toScreen(p.x, p.z);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ffc107';
      ctx.fill();
    });
  }

  // Rajtrács-pontok sorszámozva — a sorrend számít (ez lesz a rajtsorrend).
  // A tüske mutatja, merre néz majd az autó.
  api.currentSpawnPoints.forEach((p, idx) => {
    const s = toScreen(p.x, p.z);
    const heading = p.heading || 0;
    const tip = toScreen(p.x + Math.sin(heading) * 8, p.z + Math.cos(heading) * 8);
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.strokeStyle = '#0dcaf0';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(s.x, s.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(13,202,240,0.85)';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#00232e';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(idx + 1), s.x, s.y);
  });

  if (zoneCursorWorld) {
    const s = toScreen(zoneCursorWorld.x, zoneCursorWorld.z);
    ctx.beginPath();
    if (isSpawnTool()) {
      // Rajtpont eszköznél célkereszt, nem ecset-kör.
      ctx.moveTo(s.x - 10, s.y); ctx.lineTo(s.x + 10, s.y);
      ctx.moveTo(s.x, s.y - 10); ctx.lineTo(s.x, s.y + 10);
    } else {
      const pxPerUnit = w / (2 * halfW);
      ctx.arc(s.x, s.y, getBrushWorldRadius() * pxPerUnit, 0, Math.PI * 2);
    }
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

function resizeZoneOverlayCanvas() {
  zoneOverlayCanvas.width = window.innerWidth;
  zoneOverlayCanvas.height = window.innerHeight;
}

// Húzásos szerkesztés állapota: a rajtpontnál a húzás az irányt adja meg,
// a kapuknál a vonal két végpontját.
let aimingSpawn = null;
let drawingGate = null;
let zonePanLast = null;

function enterZoneEditor() {
  const box = api.currentTrackBox;
  if (!api.currentTrack || !box) return;
  previousAppStateBeforeZone = api.appState;
  api.appState = 'zone-edit';

  zoneBounds = { minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z };

  // A maszk felbontását a világ mérete szabja meg (cél ~2 egység/pixel),
  // maximált oldalhosszal, hogy a memória/PNG-méret kordában maradjon.
  const worldW = box.max.x - box.min.x;
  const worldD = box.max.z - box.min.z;
  let maskW = Math.ceil(worldW / TARGET_MASK_CELL);
  let maskH = Math.ceil(worldD / TARGET_MASK_CELL);
  const shrink = Math.min(
    1,
    MAX_MASK_DIM / Math.max(maskW, maskH),
    Math.sqrt(MAX_MASK_PIXELS / (maskW * maskH))
  );
  maskW = Math.max(2, Math.round(maskW * shrink));
  maskH = Math.max(2, Math.round(maskH * shrink));

  zoneMaskCanvas = document.createElement('canvas');
  zoneMaskCanvas.width = maskW;
  zoneMaskCanvas.height = maskH;

  zoneView.centerX = (box.min.x + box.max.x) / 2;
  zoneView.centerZ = (box.min.z + box.max.z) / 2;
  zoneView.height = worldD;

  resizeZoneOverlayCanvas();
  loadExistingZoneMask();

  scene.fog.density = 0;
  // A dev HUD-ot elrejtjük, különben a zóna-eszköztár alatt átlátszana.
  devHudEl.classList.add('hidden');
  zoneEditorEl.classList.remove('hidden');
  updateSpawnToolUI();
  zoneStatusEl.textContent = `Maszk: ${maskW}x${maskH} (${(worldW / maskW).toFixed(2)} egység/pixel)`;
}

function exitZoneEditor() {
  zoneEditorEl.classList.add('hidden');
  api.appState = previousAppStateBeforeZone;
  if (api.appState === 'dev') {
    devHudEl.classList.remove('hidden');
  } else {
    scene.fog.density = NORMAL_FOG_DENSITY;
  }
}

// Ha a pályához már van mentett zonemap.png, betöltjük a maszkra, hogy
// tovább lehessen finomítani (ne kelljen mindig nulláról kezdeni).
function loadExistingZoneMask() {
  const ctx = zoneMaskCanvas.getContext('2d');
  ctx.clearRect(0, 0, zoneMaskCanvas.width, zoneMaskCanvas.height);
  const manifest = api.manifest;
  const entry = manifest && findEntry(manifest.maps, api.currentMapId);
  if (!entry || !entry.zonemap) return;
  const img = new Image();
  img.onload = () => ctx.drawImage(img, 0, 0, zoneMaskCanvas.width, zoneMaskCanvas.height);
  img.src = 'assets/' + entry.zonemap.file + '?t=' + Date.now();
}

// A "Mentés" gomb a zóna-maszkot ÉS a rajtrács-pontokat is kiírja — egy
// helyen szerkesztjük őket, így egy gombbal is mentődjenek.
function saveSpawnPoints() {
  if (!api.currentMapId || !api.currentSpawnPoints.length) return Promise.resolve(null);
  return fetch('/api/dev/spawn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapId: api.currentMapId, spawns: api.currentSpawnPoints }),
  }).then((res) => res.json());
}

function saveGates() {
  if (!api.currentMapId) return Promise.resolve(null);
  const gates = api.currentGates;
  if (!gates.start && !gates.checkpoints.length) return Promise.resolve(null);
  return fetch('/api/dev/gates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mapId: api.currentMapId,
      start: gates.start,
      checkpoints: gates.checkpoints,
    }),
  }).then((res) => res.json());
}

function saveZoneMap() {
  const mapId = api.currentMapId;
  if (!mapId || !zoneMaskCanvas) return;
  zoneStatusEl.textContent = 'Mentés...';
  saveSpawnPoints().catch((err) => {
    zoneStatusEl.textContent = 'Rajtpont mentési hiba: ' + err.message;
  });
  saveGates().catch((err) => {
    zoneStatusEl.textContent = 'Kapu mentési hiba: ' + err.message;
  });
  zoneMaskCanvas.toBlob((blob) => {
    const reader = new FileReader();
    reader.onload = () => {
      fetch('/api/dev/zonemap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mapId,
          pngBase64: reader.result,
          bounds: zoneBounds,
          texW: zoneMaskCanvas.width,
          texH: zoneMaskCanvas.height,
        }),
      })
        .then((res) => res.json())
        .then((data) => {
          const gates = api.currentGates;
          zoneStatusEl.textContent = data.ok
            ? `Elmentve (zóna + ${api.currentSpawnPoints.length} rajtpont + ${gates.checkpoints.length} CP${gates.start ? ' + rajtvonal' : ''}).`
            : 'Hiba: ' + (data.error || 'ismeretlen');
          if (data.ok) {
            // A manifestet is frissítjük, hogy a mentett zóna azonnal életbe
            // lépjen a vezetésben, oldal-újratöltés nélkül.
            const manifest = api.manifest;
            const entry = manifest && findEntry(manifest.maps, mapId);
            if (entry) {
              entry.zonemap = {
                file: `maps/${mapId}/zonemap.png`,
                bounds: zoneBounds,
                texW: zoneMaskCanvas.width,
                texH: zoneMaskCanvas.height,
              };
              loadZoneRuntime(entry);
            }
          }
        })
        .catch((err) => {
          zoneStatusEl.textContent = 'Hiba: ' + err.message;
        });
    };
    reader.readAsDataURL(blob);
  }, 'image/png');
}

// ---------- Checkpontok automatikus generálása ----------
// A rajtvonaltól indulva, a rajtpontok iránya szerint, "középvonal-követéssel"
// bejárjuk a pályát: minden lépésnél merőlegesen megmérjük az aszfalt szélét
// balra-jobbra, és a kettő közepére korrigálunk — így akkor sem szalad le a
// vonal, ha a helyi irány kicsit pontatlan. A bejárt útvonalat a végén
// egyenletesen felosztjuk a kért darabszámra, és minden ponton a HELYI
// pályaszélesség alapján méretezzük a kaput (ld. lent).
function generateCheckpoints(count) {
  const gates = api.currentGates;
  const spawnPoints = api.currentSpawnPoints;
  const guidePath = api.currentGuidePath;
  if (!zoneMaskCanvas || !gates.start) {
    zoneStatusEl.textContent = 'Előbb kell rajtvonal és aszfalt-térkép.';
    return;
  }
  if (!spawnPoints.length) {
    zoneStatusEl.textContent = 'Előbb kell legalább egy rajtpont (ebből tudjuk az irányt).';
    return;
  }

  const ctx = zoneMaskCanvas.getContext('2d');
  const w = zoneMaskCanvas.width, h = zoneMaskCanvas.height;
  const data = ctx.getImageData(0, 0, w, h).data;
  const worldPerPixel = (zoneBounds.maxX - zoneBounds.minX) / w;

  function isAsphaltAtMaskPx(u, v) {
    if (u < 0 || u >= w || v < 0 || v >= h) return false;
    const alpha = data[(v * w + u) * 4 + 3];
    return alpha < 16;
  }
  function isAsphaltAt(x, z) {
    const { u, v } = zoneWorldToMaskPixel(x, z);
    return isAsphaltAtMaskPx(Math.floor(u), Math.floor(v));
  }

  const MARCH_STEP = Math.max(0.25, worldPerPixel);
  const MAX_MARCH = 60; // világegység — ennél szélesebb pálya nem valószínű

  // Merőlegesen (perpX,perpZ) irányban, x,z-ből indulva, meddig tart az aszfalt.
  function marchEdge(x, z, perpX, perpZ) {
    let dist = 0;
    while (dist < MAX_MARCH && isAsphaltAt(x + perpX * dist, z + perpZ * dist)) {
      dist += MARCH_STEP;
    }
    return dist;
  }

  // Ha (x,z) maga nincs aszfalton (pl. egy kicsit pontatlan vezetővonal-pont),
  // spirálban keresünk a közelben egy aszfalt-pontot — enélkül a lenti
  // szélesség-mérés 0-t adna, és nulla hosszú (haszontalan) kaput építenénk.
  function nearestAsphalt(x, z) {
    if (isAsphaltAt(x, z)) return { x, z };
    for (let r = 1; r <= 150; r++) {
      const dist = r * MARCH_STEP;
      const samples = 8 * r;
      for (let i = 0; i < samples; i++) {
        const a = (i / samples) * Math.PI * 2;
        const tx = x + Math.cos(a) * dist, tz = z + Math.sin(a) * dist;
        if (isAsphaltAt(tx, tz)) return { x: tx, z: tz };
      }
    }
    return { x, z }; // nem találtunk semmit a közelben — marad az eredeti
  }

  // Az (x,z) pontot a helyi aszfaltcsík közepére tolja, és visszaadja a
  // szélességet is (balra + jobbra mért távolság összege).
  function recenter(x, z, dirX, dirZ) {
    const near = nearestAsphalt(x, z);
    const perpX = -dirZ, perpZ = dirX;
    const left = marchEdge(near.x, near.z, perpX, perpZ);
    const right = marchEdge(near.x, near.z, -perpX, -perpZ);
    const shift = (left - right) / 2;
    return { x: near.x + perpX * shift, z: near.z + perpZ * shift, width: left + right };
  }

  // Kezdőpont: a rajtvonal közepe, irány: a rajtvonalra merőleges két lehetőség
  // közül az, amelyik az 1. rajtpont irányával egyezik (skaláris szorzat > 0).
  const g = gates.start;
  let x = (g.x1 + g.x2) / 2, z = (g.z1 + g.z2) / 2;
  const gx = g.x2 - g.x1, gz = g.z2 - g.z1;
  const glen = Math.hypot(gx, gz) || 1;
  let dirX = -gz / glen, dirZ = gx / glen;
  const heading = spawnPoints[0].heading || 0;
  const wantX = Math.sin(heading), wantZ = Math.cos(heading);
  if (dirX * wantX + dirZ * wantZ < 0) { dirX = -dirX; dirZ = -dirZ; }

  const startCentered = recenter(x, z, dirX, dirZ);
  x = startCentered.x; z = startCentered.z;

  const STEP = 2; // világegység / lépés
  let path;
  let closed;

  // Ha van kézzel rajzolt vezetővonal, azt követjük — a felhasználó vonala
  // eleve a helyes ágat választja kereszteződéseknél/hidaknál (pl. Suzuka
  // "8"-as szakasza), ahol a tisztán automatikus bejárás könnyen átvágna a
  // másik ágra. Csak rá kell simítani az aszfalt közepére.
  if (guidePath.length >= 2) {
    path = [];
    let arc = 0;
    let prevX = null, prevZ = null;
    for (let i = 0; i < guidePath.length - 1; i++) {
      const a = guidePath[i], b = guidePath[i + 1];
      const segX = b.x - a.x, segZ = b.z - a.z;
      const segLen = Math.hypot(segX, segZ);
      if (segLen < 1e-6) continue;
      const segDirX = segX / segLen, segDirZ = segZ / segLen;
      const steps = Math.max(1, Math.round(segLen / STEP));
      for (let s = i === 0 ? 0 : 1; s <= steps; s++) {
        const t = s / steps;
        const rec = recenter(a.x + segX * t, a.z + segZ * t, segDirX, segDirZ);
        if (prevX !== null) arc += Math.hypot(rec.x - prevX, rec.z - prevZ);
        path.push({ x: rec.x, z: rec.z, arc });
        prevX = rec.x; prevZ = rec.z;
      }
    }
    closed = true;
  } else {

  const path2 = [{ x, z, arc: 0 }];
  const MAX_ITERS = 8000;
  const MIN_ARC_BEFORE_CLOSE = 150;
  const CLOSE_RADIUS = STEP * 2.5;
  let arc = 0;
  closed = false;
  // Átlagos pályaszélesség (mozgóátlag) — ha egy pontnál a mért szélesség
  // ennek sokszorosa, az nem éles kanyar, hanem kereszteződés/híd (pl. a
  // Suzuka "8"-as át-/alatta-vezetése): a felülnézeti maszkban ott KÉT
  // pályaszakasz fedi egymást, és az oldalra-korrigálás könnyen átrántaná a
  // vonalat a másik ágra. Ilyenkor nem korrigálunk oldalra, egyenesen megyünk
  // tovább az addigi irányban, amíg a szélesség vissza nem áll normálisra.
  let avgWidth = startCentered.width;
  const WIDTH_SPIKE_FACTOR = 1.8;

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const candX = x + dirX * STEP, candZ = z + dirZ * STEP;
    if (!isAsphaltAt(candX, candZ)) {
      // Kis oldalirányú keresés — hátha csak egy kanyar szélén csúszott le.
      const perpX = -dirZ, perpZ = dirX;
      let found = null;
      for (let s = 1; s <= 6 && !found; s++) {
        for (const sign of [1, -1]) {
          const tx = candX + perpX * s * MARCH_STEP, tz = candZ + perpZ * s * MARCH_STEP;
          if (isAsphaltAt(tx, tz)) { found = { x: tx, z: tz }; break; }
        }
      }
      if (!found) break; // tényleg elakadt — amíg addig jutottunk, azt megtartjuk
      const rec = recenter(found.x, found.z, dirX, dirZ);
      const newDirX = rec.x - x, newDirZ = rec.z - z;
      const len = Math.hypot(newDirX, newDirZ) || 1;
      dirX = newDirX / len; dirZ = newDirZ / len;
      arc += Math.hypot(rec.x - x, rec.z - z);
      x = rec.x; z = rec.z;
      avgWidth = avgWidth * 0.95 + rec.width * 0.05;
      path2.push({ x, z, arc });
    } else {
      const rec = recenter(candX, candZ, dirX, dirZ);
      if (rec.width > avgWidth * WIDTH_SPIKE_FACTOR) {
        // Kereszteződés/híd — menjünk egyenesen, ne korrigáljunk oldalra, és
        // ne is számítsuk bele az átlagba (nehogy elmossa a normál szélességet).
        arc += STEP;
        x = candX; z = candZ;
        path2.push({ x, z, arc });
      } else {
        const rawDirX = rec.x - x, rawDirZ = rec.z - z;
        const rawLen = Math.hypot(rawDirX, rawDirZ) || 1;
        // Enyhe simítás, hogy a maszk pixel-zaja ne cikkcakkoztassa az irányt.
        let newDirX = dirX * 0.7 + (rawDirX / rawLen) * 0.3;
        let newDirZ = dirZ * 0.7 + (rawDirZ / rawLen) * 0.3;
        const newLen = Math.hypot(newDirX, newDirZ) || 1;
        dirX = newDirX / newLen; dirZ = newDirZ / newLen;
        arc += Math.hypot(rec.x - x, rec.z - z);
        x = rec.x; z = rec.z;
        avgWidth = avgWidth * 0.95 + rec.width * 0.05;
        path2.push({ x, z, arc });
      }
    }

    if (arc > MIN_ARC_BEFORE_CLOSE && Math.hypot(x - path2[0].x, z - path2[0].z) < CLOSE_RADIUS) {
      closed = true;
      break;
    }
  }
  path = path2;
  }

  if (path.length < count) {
    zoneStatusEl.textContent = guidePath.length >= 2
      ? `A vezetővonal csak ${path.length} mintapontot adott — kevés a ${count} checkpointhoz. Rajzolj hosszabb/részletesebb vonalat, vagy kérj kevesebb checkpontot.`
      : `A bejárás csak ${path.length} pontig jutott — kevés a ${count} checkpointhoz. Próbáld kevesebbel, vagy javítsd kézzel az aszfalt-maszkot ott, ahol elakadt (~${x.toFixed(0)}, ${z.toFixed(0)}).`;
    return;
  }

  const totalArc = path[path.length - 1].arc;
  const checkpoints = [];
  for (let i = 1; i <= count; i++) {
    const targetArc = (totalArc * i) / (count + 1); // az utolsó "kör-lezáró" szakaszt a rajtvonal adja, nem kell külön kapu oda
    let p = path[path.length - 1];
    for (let k = 0; k < path.length - 1; k++) {
      if (path[k].arc <= targetArc && path[k + 1].arc >= targetArc) {
        const span = path[k + 1].arc - path[k].arc || 1;
        const t = (targetArc - path[k].arc) / span;
        p = { x: path[k].x + (path[k + 1].x - path[k].x) * t, z: path[k].z + (path[k + 1].z - path[k].z) * t };
        var prevP = path[k], nextP = path[k + 1];
        break;
      }
    }
    const tanX = nextP.x - prevP.x, tanZ = nextP.z - prevP.z;
    const tanLen = Math.hypot(tanX, tanZ) || 1;
    const dx = tanX / tanLen, dz = tanZ / tanLen;
    const rec = recenter(p.x, p.z, dx, dz);
    const perpX = -dz, perpZ = dx;
    // Fél szélesség az élig + még egy fél szélesség ráhagyás mindkét oldalra —
    // így egy kicsit lemenve az aszfaltról sem esik ki azonnal a checkpointból.
    const halfLen = rec.width; // = width/2 (élig) + width/2 (ráhagyás)
    checkpoints.push({
      x1: +(rec.x + perpX * halfLen).toFixed(2), z1: +(rec.z + perpZ * halfLen).toFixed(2),
      x2: +(rec.x - perpX * halfLen).toFixed(2), z2: +(rec.z - perpZ * halfLen).toFixed(2),
    });
  }

  gates.checkpoints = checkpoints;
  updateSpawnToolUI();
  if (guidePath.length >= 2) {
    zoneStatusEl.textContent = `${checkpoints.length} checkpoint legenerálva a vezetővonal alapján.`;
  } else {
    zoneStatusEl.textContent = closed
      ? `${checkpoints.length} checkpoint legenerálva (a bejárás visszaért a rajtvonalhoz).`
      : `${checkpoints.length} checkpoint legenerálva, de a bejárás NEM ért vissza a rajtvonalhoz (elakadt kb. itt: ${x.toFixed(0)}, ${z.toFixed(0)}) — nézd át kézzel.`;
  }
}

// ---------- Ütközési háló kimentése fájlba ----------
// A kinyeréskor minden háromszög külön 3 csúcsot kap, így a közös csúcsok
// sokszorosan szerepelnek. Az összevonás nagyjából harmadára csökkenti a
// fájlt — ez minden játékosnak letöltés, ezért megéri.
function dedupeVertices(positions, indices) {
  const map = new Map();
  const outPositions = [];
  const outIndices = new Uint32Array(indices.length);

  for (let i = 0; i < indices.length; i++) {
    const v = indices[i] * 3;
    // Milliméter-pontosságú kulcs: az ennél közelebbi csúcsok azonosnak
    // számítanak (a pálya méretéhez képest ez elhanyagolható eltérés).
    const key =
      Math.round(positions[v] * 1000) + ',' +
      Math.round(positions[v + 1] * 1000) + ',' +
      Math.round(positions[v + 2] * 1000);
    let idx = map.get(key);
    if (idx === undefined) {
      idx = outPositions.length / 3;
      map.set(key, idx);
      outPositions.push(positions[v], positions[v + 1], positions[v + 2]);
    }
    outIndices[i] = idx;
  }
  return { positions: new Float32Array(outPositions), indices: outIndices };
}

// Dev mód: az aktuális pálya ütközési hálójának kinyerése és kimentése
// fájlba. Innentől a játék ezt tölti be a modellből való kinyerés helyett.
async function bakeCollisionToFile() {
  const track = api.currentTrack;
  const mapId = api.currentMapId;
  if (!track || !mapId) return;
  bakeStatusEl.textContent = 'Kinyerés...';
  await new Promise((r) => setTimeout(r, 0)); // hadd frissüljön a felirat

  const raw = extractDrivableTriangles(track);
  const mesh = dedupeVertices(raw.positions, raw.indices);

  const vertexCount = mesh.positions.length / 3;
  const buffer = new ArrayBuffer(8 + mesh.positions.byteLength + mesh.indices.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, vertexCount, true);
  view.setUint32(4, mesh.indices.length, true);
  new Float32Array(buffer, 8, mesh.positions.length).set(mesh.positions);
  new Uint32Array(buffer, 8 + mesh.positions.byteLength, mesh.indices.length).set(mesh.indices);

  bakeStatusEl.textContent = 'Mentés...';
  try {
    const res = await fetch('/api/dev/collision?mapId=' + encodeURIComponent(mapId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buffer,
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'ismeretlen hiba');

    // A manifestet is frissítjük, hogy azonnal a fájl legyen érvényben.
    const manifest = api.manifest;
    const entry = manifest && findEntry(manifest.maps, mapId);
    if (entry) entry.collision = { file: `maps/${mapId}/collision.bin`, bytes: data.bytes };

    // A háromszögszámot magunk számoljuk (mesh.indices.length / 3) — a szerver
    // válasza nem "triangles" mezőt ad, hanem "indices"-t (az index-tömb
    // HOSSZÁT, nem a háromszögek számát), ezért a data.triangles mindig
    // undefined volt.
    bakeStatusEl.textContent =
      `Kész: ${mesh.indices.length / 3} háromszög, ${(data.bytes / 1048576).toFixed(1)} MB ` +
      `(${raw.positions.length / 3} → ${vertexCount} csúcs)`;
  } catch (err) {
    bakeStatusEl.textContent = 'Hiba: ' + err.message;
  }
}

// ---------- Egy zóna-szerkesztős képkocka ----------
// A pálya élőben, valódi 3D geometriaként renderelődik felülnézetből — ezért
// marad éles bármilyen zoomon, szemben egy fix felbontású képpel.
function renderZoneEditorFrame() {
  updateZoneOrthoCamera();
  renderer.render(scene, zoneOrthoCam);
  drawZoneOverlay();
}

// ---------- Bekötés ----------
let wired = false;

function wireEvents() {
  if (wired) return;
  wired = true;

  makeSearchableSelect(carTesterCarSelectEl);

  carTesterBtn.addEventListener('click', enterCarTester);
  carTesterBackBtn.addEventListener('click', exitCarTester);
  carTesterCarSelectEl.addEventListener('change', () => {
    const manifest = api.manifest;
    if (!manifest) return;
    api.switchCarTo(findEntry(manifest.cars, carTesterCarSelectEl.value));
  });

  devDriveBtn.addEventListener('click', enterDevDrive);
  devDriveBackBtn.addEventListener('click', exitDevDrive);
  devDriveResetBtn.addEventListener('click', resetAllTunables);
  devDriveSaveBtn.addEventListener('click', saveTunablesToFile);

  // A W/S kocsiváltást a main.js kezeli (a menüben is működik) — mi csak az
  // Escape-et vesszük át, ami kilép a tesztelőből / a vezetéses tesztből.
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && api.appState === 'cartest') exitCarTester();
    else if (e.code === 'Escape' && devDriveActive) exitDevDrive();
  });

  // Kocsiváltás közben a tesztelő legördülője le van tiltva, utána szinkronba
  // kerül a ténylegesen betöltött kocsival.
  api.setCarSwitchHook({
    begin: () => { carTesterCarSelectEl.disabled = true; },
    end: (entry) => {
      carTesterCarSelectEl.value = entry.id;
      carTesterCarSelectEl.disabled = false;
    },
  });

  renderer.domElement.addEventListener('contextmenu', (e) => {
    if (api.appState === 'dev') e.preventDefault();
  });
  renderer.domElement.addEventListener('mousedown', (e) => {
    if (api.appState === 'dev' && e.button === 2) {
      devLastMouseX = e.clientX;
      devLastMouseY = e.clientY;
    }
  });
  window.addEventListener('mousemove', (e) => {
    const rightButtonHeld = (e.buttons & 2) === 2;
    if (api.appState !== 'dev' || !rightButtonHeld) {
      devLastMouseX = e.clientX;
      devLastMouseY = e.clientY;
      return;
    }
    const dx = e.clientX - devLastMouseX;
    const dy = e.clientY - devLastMouseY;
    devLastMouseX = e.clientX;
    devLastMouseY = e.clientY;
    devYaw -= dx * 0.0035;
    devPitch = THREE.MathUtils.clamp(devPitch - dy * 0.0035, -Math.PI / 2 + 0.05, Math.PI / 2 - 0.05);
  });

  window.addEventListener('keydown', (e) => {
    if (api.appState === 'zone-edit' && e.code === 'Backspace' && isSpawnTool()) {
      e.preventDefault();
      removeLastSpawnPoint();
      return;
    }
    if (api.appState !== 'dev') return;
    devKeys[e.code] = true;
  });
  window.addEventListener('keyup', (e) => {
    if (api.appState === 'dev') devKeys[e.code] = false;
  });

  document.querySelectorAll('input[name="zoneBrush"]').forEach((el) => {
    el.addEventListener('change', updateSpawnToolUI);
  });
  undoSpawnBtn.addEventListener('click', removeLastSpawnPoint);
  undoGateBtn.addEventListener('click', removeLastGate);
  clearCheckpointsBtn.addEventListener('click', () => {
    api.currentGates.checkpoints = [];
    updateSpawnToolUI();
  });
  undoGuideBtn.addEventListener('click', () => { api.currentGuidePath.pop(); updateSpawnToolUI(); });
  clearGuideBtn.addEventListener('click', () => { api.currentGuidePath = []; updateSpawnToolUI(); });

  zoneOverlayCanvas.addEventListener('mousedown', (e) => {
    if (e.button === 0) {
      const { x, z } = zoneScreenToWorld(e.clientX, e.clientY);
      if (isSpawnTool()) {
        aimingSpawn = addSpawnPointAtWorld(x, z);
        return;
      }
      if (isGateTool()) {
        drawingGate = { x1: x, z1: z, x2: x, z2: z };
        return;
      }
      if (isGuideTool()) {
        api.currentGuidePath.push({ x, z });
        updateSpawnToolUI();
        return;
      }
      zonePainting = true;
      paintAtWorld(x, z);
    } else if (e.button === 1 || e.button === 2) {
      e.preventDefault();
      zonePanLast = { x: e.clientX, y: e.clientY };
    }
  });
  zoneOverlayCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('mousemove', (e) => {
    if (api.appState !== 'zone-edit') return;
    zoneCursorWorld = zoneScreenToWorld(e.clientX, e.clientY);

    if (zonePainting) {
      paintAtWorld(zoneCursorWorld.x, zoneCursorWorld.z);
      return;
    }
    if (aimingSpawn) {
      const dx = zoneCursorWorld.x - aimingSpawn.x;
      const dz = zoneCursorWorld.z - aimingSpawn.z;
      // Túl rövid húzásból nem lehet irányt olvasni, olyankor marad a régi.
      if (Math.hypot(dx, dz) > 0.5) {
        aimingSpawn.heading = +headingFromDelta(dx, dz).toFixed(4);
        refreshSpawnMarkers();
      }
      return;
    }
    if (drawingGate) {
      drawingGate.x2 = zoneCursorWorld.x;
      drawingGate.z2 = zoneCursorWorld.z;
      return;
    }
    // Középső/jobb gomb nyomva tartva: pásztázás.
    const dragging = (e.buttons & 4) === 4 || (e.buttons & 2) === 2;
    if (dragging && zonePanLast) {
      const rect = zoneOverlayCanvas.getBoundingClientRect();
      const aspect = zoneOverlayCanvas.width / zoneOverlayCanvas.height;
      const unitsPerPxY = zoneView.height / rect.height;
      const unitsPerPxX = (zoneView.height * aspect) / rect.width;
      zoneView.centerX -= (e.clientX - zonePanLast.x) * unitsPerPxX;
      zoneView.centerZ -= (e.clientY - zonePanLast.y) * unitsPerPxY;
      zonePanLast = { x: e.clientX, y: e.clientY };
    } else if (!dragging) {
      zonePanLast = null;
    }
  });
  window.addEventListener('mouseup', () => {
    zonePainting = false;
    zonePanLast = null;
    aimingSpawn = null;

    if (drawingGate) {
      const len = Math.hypot(drawingGate.x2 - drawingGate.x1, drawingGate.z2 - drawingGate.z1);
      // A nulla hosszú kaput (sima kattintás) eldobjuk — azt nem lehet átmetszeni.
      if (len > 1) {
        const gate = {
          x1: +drawingGate.x1.toFixed(2), z1: +drawingGate.z1.toFixed(2),
          x2: +drawingGate.x2.toFixed(2), z2: +drawingGate.z2.toFixed(2),
        };
        if (getSelectedBrush() === 'start') api.currentGates.start = gate;
        else api.currentGates.checkpoints.push(gate);
        updateSpawnToolUI();
      }
      drawingGate = null;
    }
  });

  // Görgő = zoom, a kurzor alatti világpont a helyén marad.
  zoneOverlayCanvas.addEventListener(
    'wheel',
    (e) => {
      if (api.appState !== 'zone-edit') return;
      e.preventDefault();
      const before = zoneScreenToWorld(e.clientX, e.clientY);
      const trackSpan = Math.max(zoneBounds.maxX - zoneBounds.minX, zoneBounds.maxZ - zoneBounds.minZ);
      zoneView.height = THREE.MathUtils.clamp(
        zoneView.height * (e.deltaY < 0 ? 1 / 1.15 : 1.15),
        20,
        trackSpan * 1.5
      );
      const after = zoneScreenToWorld(e.clientX, e.clientY);
      zoneView.centerX += before.x - after.x;
      zoneView.centerZ += before.z - after.z;
    },
    { passive: false }
  );

  generateCheckpointsBtn.addEventListener('click', () => {
    const count = Math.max(4, Math.min(500, Number(autoCheckpointCountEl.value) || 100));
    generateCheckpoints(count);
  });

  openZoneEditorBtn.addEventListener('click', enterZoneEditor);
  closeZoneEditorBtn.addEventListener('click', exitZoneEditor);
  saveZoneBtn.addEventListener('click', saveZoneMap);
  brushSizeRange.addEventListener('input', () => {
    brushSizeLabel.textContent = brushSizeRange.value;
  });
  window.addEventListener('resize', () => {
    if (api.appState === 'zone-edit') resizeZoneOverlayCanvas();
  });

  openMaterialPickerBtn.addEventListener('click', openMaterialPicker);
  closeMaterialPickerBtn.addEventListener('click', closeMaterialPicker);
  generateAsphaltBtn.addEventListener('click', generateAsphaltMask);

  bakeCollisionBtn.addEventListener('click', bakeCollisionToFile);

  // A dev pálya-választó csak itt él: a rendes menü mapSelect-jétől külön,
  // de a kiválasztást átvezetjük oda is, hogy az indítás ugyanazt a pályát
  // kapja.
  const manifest = api.manifest;
  if (manifest) {
    fillSelect(devMapSelectEl, manifest.maps);
    devMapSelectEl.value = api.currentMapId;
  }
  devMapSelectEl.addEventListener('change', async () => {
    const entry = findEntry(api.manifest.maps, devMapSelectEl.value);
    api.selectMap(entry.id);
    devSpawnStatusEl.textContent = 'Pálya betöltése...';
    await setTrack('assets/' + entry.file, entry.id, entry.spawns, entry.gates);
    enterDevMode();
    devSpawnStatusEl.textContent = '';
  });

  // A futásidejű zóna-hibakereső felületet (window.__debug.zone) a main.js
  // hozza létre; a szerkesztő-specifikus részeket itt fűzzük hozzá.
  if (window.__debug && window.__debug.zone) {
    Object.assign(window.__debug.zone, {
      getMask: () => zoneMaskCanvas,
      getBounds: () => zoneBounds,
      getView: () => zoneView,
      screenToWorld: zoneScreenToWorld,
      worldToMask: zoneWorldToMaskPixel,
      setGuidePath: (p) => { api.currentGuidePath = p; updateSpawnToolUI(); },
      generateCheckpoints,
    });
  }
}

// A main.js egyszer hívja meg, a dev modul betöltése után. Azért async, mert
// előbb le kell kérni és beszúrni a dev.html-t — előtte egyetlen elem sem
// létezik, amire a kezelőket rá lehetne kötni.
export async function initDevTools(gameApi) {
  api = gameApi;

  await injectMarkup();
  queryElements();

  ({
    scene, camera, renderer, carPivot, keys, hudEl, menuEl, carSelect,
    NORMAL_FOG_DENSITY,
    moveTowardsAngle, updateSunTarget, updateShowcaseCamera,
    findEntry, fillSelect, setTrack, loadZoneRuntime, extractDrivableTriangles, makeSearchableSelect,
  } = api);

  // THREE-objektumok csak most jönnek létre — a modul betöltésekor még nem
  // biztos, hogy bármi kell belőlük.
  devMarkerGeometry = new THREE.SphereGeometry(1.2, 12, 12);
  devMarkerMaterial = new THREE.MeshBasicMaterial({ color: 0xffcc00 });
  highlightMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  zoneOrthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000);
  zoneOrthoCam.up.set(0, 0, -1);

  wireEvents();

  return {
    enterDevMode,
    updateDevCamera,
    updateCarTest,
    renderZoneEditorFrame,
    hideOverlays,
  };
}
