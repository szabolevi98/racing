import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import RAPIER from 'rapier';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// A Rapier WebAssembly-ben fut, ezért használat előtt inicializálni kell.
// Top-level await: a modul többi része addig nem fut le, így minden alábbi
// RAPIER hívás biztosan kész motorral dolgozik.
await RAPIER.init();

// Az autó "hossz-tengelyét" (X vagy Z) automatikusan felismerjük, de hogy a
// modell eleje pontosan melyik irányba néz az adott tengely mentén, az
// exportálástól/forrástól függ. Ezt (és a kerék-mesh-ek felismerését) a
// kocsi melletti assets/cars/<id>.json fájl írja le — nincs a kódban
// modellenkénti kivétel.

// ---------- DOM ----------
const loadingEl = document.getElementById('loading');
const menuEl = document.getElementById('menu');
const hudEl = document.getElementById('hud');
const statusEl = document.getElementById('status');
const menuStatusEl = document.getElementById('menuStatus');
const mapSelect = document.getElementById('mapSelect');
const carSelect = document.getElementById('carSelect');
const envSelect = document.getElementById('envSelect');
const startBtn = document.getElementById('startBtn');
const backToMenuLink = document.getElementById('backToMenuLink');
const devHudEl = document.getElementById('devHud');
const devSpawnCountEl = document.getElementById('devSpawnCount');
const devSpawnStatusEl = document.getElementById('devSpawnStatus');
const devMapSelectEl = document.getElementById('devMapSelect');
const bakeCollisionBtn = document.getElementById('bakeCollisionBtn');
const bakeStatusEl = document.getElementById('bakeStatus');
const openZoneEditorBtn = document.getElementById('openZoneEditorBtn');
const carTesterBtn = document.getElementById('carTesterBtn');
const carTesterHudEl = document.getElementById('carTesterHud');
const carTesterBackBtn = document.getElementById('carTesterBackBtn');
const carTesterCarSelectEl = document.getElementById('carTesterCarSelect');
const openMaterialPickerBtn = document.getElementById('openMaterialPickerBtn');
const generateCheckpointsBtn = document.getElementById('generateCheckpointsBtn');
const autoCheckpointCountEl = document.getElementById('autoCheckpointCount');
const materialPickerPanelEl = document.getElementById('materialPickerPanel');
const materialPickerGridEl = document.getElementById('materialPickerGrid');
const generateAsphaltBtn = document.getElementById('generateAsphaltBtn');
const closeMaterialPickerBtn = document.getElementById('closeMaterialPickerBtn');
const materialPickerStatusEl = document.getElementById('materialPickerStatus');
const closeZoneEditorBtn = document.getElementById('closeZoneEditorBtn');
const saveZoneBtn = document.getElementById('saveZoneBtn');
const zoneEditorEl = document.getElementById('zoneEditor');
const zoneOverlayCanvas = document.getElementById('zoneOverlayCanvas');
const zoneStatusEl = document.getElementById('zoneStatus');
const brushSizeRange = document.getElementById('brushSizeRange');
const brushSizeLabel = document.getElementById('brushSizeLabel');
const zoneIndicatorEl = document.getElementById('zoneIndicator');
const rolloverAlertEl = document.getElementById('rolloverAlert');
const rolloverAlertTextEl = document.getElementById('rolloverAlertText');
const lapInvalidAlertEl = document.getElementById('lapInvalidAlert');
const brushSizeRow = document.getElementById('brushSizeRow');
const spawnToolRow = document.getElementById('spawnToolRow');
const zoneSpawnCountEl = document.getElementById('zoneSpawnCount');
const undoSpawnBtn = document.getElementById('undoSpawnBtn');
const gateToolRow = document.getElementById('gateToolRow');
const startLineStateEl = document.getElementById('startLineState');
const checkpointCountEl = document.getElementById('checkpointCount');
const undoGateBtn = document.getElementById('undoGateBtn');
const clearCheckpointsBtn = document.getElementById('clearCheckpointsBtn');
const guideToolRow = document.getElementById('guideToolRow');
const guidePointCountEl = document.getElementById('guidePointCount');
const undoGuideBtn = document.getElementById('undoGuideBtn');
const clearGuideBtn = document.getElementById('clearGuideBtn');
const autoCheckpointRow = document.getElementById('autoCheckpointRow');
const lapCountSelect = document.getElementById('lapCountSelect');
const raceHudEl = document.getElementById('raceHud');
const raceHudWrapEl = document.getElementById('raceHudWrap');
const countdownEl = document.getElementById('countdown');
const resultsEl = document.getElementById('results');
const resultsBodyEl = document.getElementById('resultsBody');
const resultsRestartBtn = document.getElementById('resultsRestartBtn');
const resultsMenuBtn = document.getElementById('resultsMenuBtn');

// Dev mód: ?dev=1 az URL-ben — szabad kamerával be lehet járni a pályát és
// kijelölni a rajtrács-pontokat (assets/maps/<id>/spawn.json).
const DEV_MODE = new URLSearchParams(window.location.search).has('dev');

function setStatus(text) {
  statusEl.textContent = text;
}
function setMenuStatus(text) {
  menuStatusEl.textContent = text;
}

// ---------- Three.js alapok ----------
const scene = new THREE.Scene();
// Exponenciális köd: a távolsággal fokozatosan sűrűsödik, nem egy éles
// "fal"-ként vág el mindent egy adott távolságban (mint a lineáris Fog),
// ezért sokkal életszerűbb, természetes páraréteg-hatást ad.
const NORMAL_FOG_DENSITY = 0.0025;
scene.fog = new THREE.FogExp2(0x9aa5ab, NORMAL_FOG_DENSITY);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 5000);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
// A HDRI környezeti megvilágítás tone mapping nélkül túlexponáltnak (túl
// világosnak) tűnik — ez korrigálja, hogy a pálya ne legyen kimosott fehér.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.8;
document.body.appendChild(renderer.domElement);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- HDRI skybox (háttér + környezeti fény/tükröződés) ----------
const pmremGenerator = new THREE.PMREMGenerator(renderer);
pmremGenerator.compileEquirectangularShader();
let currentEnvMap = null;

// A jelenlegi fénybeállítások (sun 3.85 stb.) a day_1 HDRI-hez lettek
// behangolva — ennek a mért átlagos fényereje a viszonyítási alap. A többi
// égbolt fényviszonyait ehhez képest, a saját mért fényerejükből származtatjuk,
// így egy új skybox bedobásakor sem kell semmit kézzel állítani.
const REFERENCE_ENV_LUMINANCE = 0.366;
const REFERENCE_SUN_INTENSITY = 3.85;
const REFERENCE_HEMI_INTENSITY = 0.25;
// E fölött nappalnak számít; alatta bekapcsolnak a fényszórók.
const NIGHT_LUMINANCE_THRESHOLD = 0.12;

// Egy HDRI átlagos színének/fényerejének megmérése (ritkított mintavétellel).
// Az RGBELoader half-float adatot ad vissza, ezért kell a fromHalfFloat.
function analyzeEnvTexture(hdrTexture) {
  const { data, width, height } = hdrTexture.image;
  const pixelCount = width * height;
  const step = Math.max(1, Math.floor(pixelCount / 30000));
  let r = 0, g = 0, b = 0, samples = 0;
  for (let i = 0; i < pixelCount; i += step) {
    const o = i * 4;
    r += THREE.DataUtils.fromHalfFloat(data[o]);
    g += THREE.DataUtils.fromHalfFloat(data[o + 1]);
    b += THREE.DataUtils.fromHalfFloat(data[o + 2]);
    samples++;
  }
  r /= samples; g /= samples; b /= samples;
  return { r, g, b, luminance: 0.2126 * r + 0.7152 * g + 0.0722 * b };
}

function applyEnvLighting(analysis) {
  const relative = analysis.luminance / REFERENCE_ENV_LUMINANCE;

  sun.intensity = THREE.MathUtils.clamp(REFERENCE_SUN_INTENSITY * relative, 0.15, 6);
  hemi.intensity = THREE.MathUtils.clamp(REFERENCE_HEMI_INTENSITY * relative, 0.05, 0.6);

  // A közvetlen fény színe az égbolt saját színárnyalatát veszi fel
  // (éjszaka ettől lesz hideg, holdfényes a megvilágítás).
  const maxChannel = Math.max(analysis.r, analysis.g, analysis.b, 1e-6);
  sun.color.setRGB(analysis.r / maxChannel, analysis.g / maxChannel, analysis.b / maxChannel);

  // A ködöt a Three.js lineáris térben, még a tone mapping előtt keveri a
  // képbe — ezért ide a HDRI nyers (lineáris) átlagszíne való, gamma nélkül.
  // Így a köd magától együtt sötétedik/színeződik az éggel.
  scene.fog.color.setRGB(analysis.r, analysis.g, analysis.b);

  const isNight = analysis.luminance < NIGHT_LUMINANCE_THRESHOLD;
  setHeadlights(isNight);
  // Éjszaka a szórt fényt még a nappalinál is jobban visszavesszük: a
  // tone mapping magától felhozná a sötét részeket (ettől nézett ki a
  // "night" inkább alkonyatnak), a látást pedig a fényszórók biztosítják.
  scene.environmentIntensity = isNight ? 0.3 : 0.5;
}

function setSkybox(skyUrl) {
  return new Promise((resolve, reject) => {
    new RGBELoader().load(
      skyUrl,
      (hdrTexture) => {
        const analysis = analyzeEnvTexture(hdrTexture);
        const newEnvMap = pmremGenerator.fromEquirectangular(hdrTexture).texture;
        hdrTexture.dispose();
        if (currentEnvMap) currentEnvMap.dispose();
        currentEnvMap = newEnvMap;
        scene.background = newEnvMap;
        scene.environment = newEnvMap;
        applyEnvLighting(analysis);
        resolve();
      },
      undefined,
      reject
    );
  });
}

const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.25);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 3.85);
sun.position.set(200, 300, 100);
sun.castShadow = true;
sun.shadow.camera.left = -100;
sun.shadow.camera.right = 100;
sun.shadow.camera.top = 100;
sun.shadow.camera.bottom = -100;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 600;
sun.shadow.mapSize.set(2048, 2048);
// A pálya "groove" (gumicsík) overlay mesh-je majdnem egy szinten van az
// alatta lévő aszfalttal — enélkül a shadow bias/normalBias nélkül a kettő
// egymást önárnyékolja, ami periodikus csíkokként jelenik meg a pályán.
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.4;
scene.add(sun);
scene.add(sun.target);

// A nap fix, kis (±100 egységes) árnyék-frusztuma minden képkockán az autó
// fölé/mellé tolódik — így bárhol jár a pályán, az árnyék-kamera mindig
// körülötte marad (élesebb, mint egy egész pályát lefedő verzió lenne).
const sunOffset = new THREE.Vector3(80, 150, 60);
function updateSunTarget(targetPos) {
  sun.position.copy(targetPos).add(sunOffset);
  sun.target.position.copy(targetPos);
}

// ---------- Rapier fizika világ ----------
// Rapierre váltottunk a cannon-es helyett, mert az ütközés előre bekészített
// háromszöghálóból (trimesh) jön, hogy a hidak/felüljárók is működjenek — egy
// magasságtérkép elvileg sem tud két szintet ugyanazon (x,z) ponton. A
// cannon-es erre alkalmatlan volt: raycastje trimesh ellen ~2 ms/sugár (a
// négy kerékkel ~8 ms/képkocka a 16.6-ból), és Box↔Trimesh ütközése nincs is.
// A Rapier ugyanezt ~0.0066 ms/sugárral hozza.
const world = new RAPIER.World({ x: 0, y: -9.82, z: 0 });
world.timestep = 1 / 60;

// Biztonsági "aljzat" — arra kell, hogy a kocsi ne essen a végtelenségig, ha
// lecsúszik a pályáról, VAGY ha a pálya modelljén lévő lyukon esik át. Csak
// pár egységgel a pálya legalja alatt van, hogy ne egy láthatatlan mélységbe
// zuhanjon az autó, hanem szinte azonnal elkapja egy sötétszürke "padló",
// ami takarja a lyukakat. A Rapiernek nincs végtelen síkja, ezért egy nagyon
// nagy, lapos hasáb tölti be ezt a szerepet.
const safetyNetBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
const safetyNetCollider = world.createCollider(
  RAPIER.ColliderDesc.cuboid(5000, 1, 5000),
  safetyNetBody
);

// Világos szürke, hogy jól elüssön az aszfalttól: ahol a modell lyukas, ott
// egyértelműen látszódjon, hogy ez a takaró padló, ne olvadjon össze az úttal.
const safetyFloorMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(6000, 6000),
  new THREE.MeshStandardMaterial({ color: 0x8b9096, roughness: 1, metalness: 0, side: THREE.DoubleSide })
);
safetyFloorMesh.rotation.x = -Math.PI / 2;
safetyFloorMesh.receiveShadow = true;
scene.add(safetyFloorMesh);

// Egy sík, fix magasságú padló völgyekben átlógna, dombos/hidas részeken meg
// túl messze maradna a lyukaktól. Ehelyett a padlót a magasságtérkép ADATÁBÓL
// (amit a fizikához amúgy is kiszámolunk) építjük fel: a pálya tényleges
// terepkontúrját követi, csak mindenhol pár egységgel lejjebb tolva — így
// garantáltan mindenhol közel marad, sosem lóg át a valódi felszínen.
function buildContourFloorMesh(data, elementSize, box, margin) {
  const nx = data.length;
  const nz = data[0].length;
  const positions = new Float32Array(nx * nz * 3);

  for (let i = 0; i < nx; i++) {
    const worldX = box.min.x + i * elementSize;
    for (let j = 0; j < nz; j++) {
      const worldZ = box.max.z - j * elementSize;
      const idx = (i * nz + j) * 3;
      positions[idx] = worldX;
      positions[idx + 1] = data[i][j] - margin;
      positions[idx + 2] = worldZ;
    }
  }

  const indices = [];
  for (let i = 0; i < nx - 1; i++) {
    for (let j = 0; j < nz - 1; j++) {
      const a = i * nz + j;
      const b = (i + 1) * nz + j;
      const c = (i + 1) * nz + (j + 1);
      const d = i * nz + (j + 1);
      indices.push(a, b, d, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  safetyFloorMesh.geometry.dispose();
  safetyFloorMesh.geometry = geometry;
  // A geometria már világ-koordinátákban van felépítve, nincs szükség
  // pozíció/forgatás transzformra.
  safetyFloorMesh.position.set(0, 0, 0);
  safetyFloorMesh.rotation.set(0, 0, 0);
}

let spawnPoint = new THREE.Vector3(0, 5, 0);
// A pálya ütközési háromszöghálója (a heightfieldet váltja ki).
let trackColliderBody = null;
let trackCollider = null;

// ---------- Autó (chassis + Rapier raycast vehicle) ----------
const chassisSize = { x: 1.0, y: 0.4, z: 2.2 }; // fél-méretek: szélesség/2, magasság/2, hossz/2
const chassisBody = world.createRigidBody(
  RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(0, 5, 0)
    // Enélkül a kocsi a legkisebb egyenetlenségen is pörögni kezdene; a
    // cannon-es alapból csillapított, a Rapier nem.
    .setLinearDamping(0.05)
    .setAngularDamping(0.5)
    // A pálya ütközője háromszögháló, aminek NINCS vastagsága: gyors esésnél
    // (pl. rajtoláskor vagy ugratás után) a kasztni doboza egyetlen lépés
    // alatt átugorhatná a felületet, és a kocsi a világ alá kerülne. A
    // folytonos ütközésdetektálás ezt megakadályozza.
    .setCcdEnabled(true)
);
const chassisCollider = world.createCollider(
  RAPIER.ColliderDesc.cuboid(chassisSize.x, chassisSize.y, chassisSize.z).setMass(250),
  chassisBody
);

const vehicle = world.createVehicleController(chassisBody);
vehicle.indexUpAxis = 1;          // Y = fel
vehicle.setIndexForwardAxis = 2;  // Z = előre (a .d.ts-ben tényleg így hívják a settert)

const WHEEL_RADIUS = 0.35;
const SUSPENSION_REST_LENGTH = 0.3;
const wheelPositions = [
  { x: -0.85, y: -0.2, z: 1.5 },  // 0: első bal
  { x: 0.85, y: -0.2, z: 1.5 },   // 1: első jobb
  { x: -0.85, y: -0.2, z: -1.5 }, // 2: hátsó bal
  { x: 0.85, y: -0.2, z: -1.5 },  // 3: hátsó jobb
];
wheelPositions.forEach((pos, i) => {
  vehicle.addWheel(pos, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, SUSPENSION_REST_LENGTH, WHEEL_RADIUS);
  // A cannon-es-ből átemelt, már behangolt felfüggesztés-értékek — mindkét
  // motor ugyanannak a Bullet-féle raycast vehicle-nek a portja, ezért
  // közvetlenül átvihetők.
  vehicle.setWheelSuspensionStiffness(i, 30);
  vehicle.setWheelSuspensionCompression(i, 4.4);
  vehicle.setWheelSuspensionRelaxation(i, 2.3);
  vehicle.setWheelMaxSuspensionTravel(i, 0.3);
  vehicle.setWheelMaxSuspensionForce(i, 100000);
  vehicle.setWheelFrictionSlip(i, 1.4);
});

// Milyen mélyen van a talaj a kasztni KÖZEPE alatt, ha az autó nyugalomban áll?
// A látható modellt ehhez igazítjuk, nem a kasztni-doboz aljához: a kerék a
// kasztni alja alá lóg (rácsatlakozás + rugóhossz + keréksugár), ezért a
// doboz aljához igazított modell a levegőben lóg.
//
// A nyugalmi rugóhosszt nem számoljuk ki képletből (a Bullet-féle rugóerő
// pontos alakja motor-belső), hanem az első olyan képkockán MÉRJÜK, amikor
// mind a négy kerék a talajon van és a kocsi már nem mozog függőlegesen.
// Addig a teljesen kinyúlt rugóval számolunk.
const WHEEL_CONNECTION_DROP = -wheelPositions[0].y;
let groundOffset = WHEEL_CONNECTION_DROP + SUSPENSION_REST_LENGTH + WHEEL_RADIUS;
let groundOffsetCalibrated = false;

function calibrateGroundOffset() {
  if (groundOffsetCalibrated) return;
  if (Math.abs(chassisBody.linvel().y) > 0.05) return;
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    if (!vehicle.wheelIsInContact(i)) return;
    sum += vehicle.wheelSuspensionLength(i) ?? SUSPENSION_REST_LENGTH;
  }
  groundOffset = WHEEL_CONNECTION_DROP + sum / 4 + WHEEL_RADIUS;
  groundOffsetCalibrated = true;
  applyCarModelHeight();
}

// A Rapierben a merev test állapota csak settereken át írható (a getterek
// másolatot adnak vissza), ezért kell külön függvény a visszahelyezéshez.
// A heading az Y tengely körüli elfordulás: 0 = a világ +Z iránya (az autó
// "előre" tengelye). Pályánként állítjuk a szerkesztőben, mert a rajtvonal
// nem mindenhol néz ugyanabba az irányba.
let spawnHeading = 0;

function resetCarTo(pos, heading = spawnHeading) {
  const half = heading / 2;
  chassisBody.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
  chassisBody.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, true);
  chassisBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
  chassisBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
  lastSafePos.copy(pos);
  // A kör-logika a kocsi ELŐZŐ és MOSTANI pozíciója közötti szakaszt metszi a
  // kapukkal. Teleportálás után (pl. R) ez a szakasz a régi, akár messzi
  // pozíciótól az új helyig érne — útközben átvágva más kapukon is —, ezért
  // itt "megszakítjuk" azzal, hogy az előző pozíciót is az újra állítjuk.
  race.prevX = pos.x;
  race.prevZ = pos.z;
}

function removeTrackCollider() {
  if (trackCollider) {
    world.removeCollider(trackCollider, false);
    trackCollider = null;
  }
  if (trackColliderBody) {
    world.removeRigidBody(trackColliderBody);
    trackColliderBody = null;
  }
}

// ---------- Segédfüggvény: 3D objektum erőforrásainak felszabadítása ----------
function disposeObject3D(root) {
  root.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => {
        Object.keys(m).forEach((key) => {
          if (m[key] && m[key].isTexture) m[key].dispose();
        });
        m.dispose();
      });
    }
  });
}

// ---------- GLTF betöltés ----------
const gltfLoader = new GLTFLoader();
const carPivot = new THREE.Group();
scene.add(carPivot);

// ---------- Fényszórók (sötét környezetben automatikusan bekapcsolnak) ----------
// A carPivot gyerekei, így együtt mozognak/fordulnak a kocsival. Az autó
// "előre" iránya a fizikai +Z tengely. Szándékosan nem vetnek árnyékot:
// két árnyékvető spotlámpa jelentős plusz költség lenne, a hatás pedig
// enélkül is meggyőző.
const headlights = [];
[-0.65, 0.65].forEach((x) => {
  const spot = new THREE.SpotLight(0xfff1d0, 0, 90, 0.55, 0.45, 1.2);
  spot.position.set(x, 0.15, 1.9);
  spot.target.position.set(x * 0.6, -1.2, 26);
  carPivot.add(spot);
  carPivot.add(spot.target);
  headlights.push(spot);
});

function setHeadlights(on) {
  headlights.forEach((spot) => {
    spot.intensity = on ? 900 : 0;
  });
}

let carLoaded = false;
let currentCarModel = null;
// A betöltött modell aljának távolsága a saját origójától (a skálázás után).
// Ebből és a groundOffsetből jön ki, hova kell tenni a modellt a carPivoton belül.
let carModelBottomRaw = 0;

function applyCarModelHeight() {
  if (currentCarModel) currentCarModel.position.y = carModelBottomRaw - groundOffset;
}
let currentTrack = null;
let currentTrackBox = null;
let currentMapId = null;
// A pálya kézi rajtrács-pontjai (assets/maps/<id>/spawn.json-ból, max 8),
// a jövőbeli multiplayerhez előkészítve — egyelőre mindig az első szabad
// (üresnek tekintett) pontot használjuk, mert még nincs több játékos.
let currentSpawnPoints = [];
// Rajtvonal + checkpointok. Egy kapu egy szakasz felülnézetből: {x1,z1,x2,z2}.
// A checkpointokat SORRENDBEN kell érinteni, utána a rajtvonal zárja a kört —
// enélkül a rajtvonal előtt oda-vissza hajtva lehetne köröket gyűjteni.
let currentGates = { start: null, checkpoints: [] };
// Durva, kézzel kattintott vezetővonal a checkpont-generáláshoz — csak
// szerkesztés közbeni segédadat, nem mentjük ki (a generálás UTÁN a
// tényleges checkpontok már currentGates.checkpoints-ban vannak).
let currentGuidePath = [];

function pickSpawnSlot(spawnPoints, occupiedIndices = []) {
  if (!spawnPoints || !spawnPoints.length) return null;
  const freeIndex = spawnPoints.findIndex((_, idx) => !occupiedIndices.includes(idx));
  const chosen = spawnPoints[freeIndex >= 0 ? freeIndex : 0];
  return { x: chosen.x, z: chosen.z, heading: chosen.heading || 0 };
}

function loadGLTF(url) {
  return new Promise((resolve, reject) => gltfLoader.load(url, resolve, undefined, reject));
}

// Néhány gyors sugárvetés a pálya bbox-a fölött, hogy legyen egy használható
// pont a kirakat-nézethez (autó pozíciója a menüben). A pontos, teljes
// magasságtérkép csak Indításkor épül (buildTrackHeightfield). Egyetlen,
// bbox-közepére lőtt sugár nem elég: nagy, ritkán fedett dobozú pályáknál
// (pl. valós domborzatot is tartalmazó modelleknél) simán a semmibe lőhet,
// ezért egy rácson próbálkozunk, a közepéhez legközelebbitől kifelé haladva.
function findShowcaseSpot(track, box, preferXZ) {
  track.traverse((obj) => {
    if (obj.isMesh && obj.geometry) obj.geometry.computeBoundsTree();
  });

  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  const dir = new THREE.Vector3(0, -1, 0);
  const rayOriginY = box.max.y + 20;
  const centerX = (box.min.x + box.max.x) / 2;
  const centerZ = (box.min.z + box.max.z) / 2;
  // Ha van pályánként megadott kézi kezdőpont (assets/maps/<id>/spawn.json),
  // ahhoz keressük a legközelebbi találatot, nem a bbox mértani közepéhez.
  const prefX = preferXZ ? preferXZ.x : centerX;
  const prefZ = preferXZ ? preferXZ.z : centerZ;

  if (preferXZ) {
    raycaster.set(new THREE.Vector3(prefX, rayOriginY, prefZ), dir);
    const hits = raycaster.intersectObject(track, true);
    if (hits.length) return hits[0].point.clone();
  }

  const GRID = 21;
  const candidates = [];
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const x = box.min.x + ((box.max.x - box.min.x) * i) / (GRID - 1);
      const z = box.min.z + ((box.max.z - box.min.z) * j) / (GRID - 1);
      candidates.push({ x, z, d: (x - prefX) ** 2 + (z - prefZ) ** 2 });
    }
  }
  candidates.sort((a, b) => a.d - b.d);

  for (const { x, z } of candidates) {
    raycaster.set(new THREE.Vector3(x, rayOriginY, z), dir);
    const hits = raycaster.intersectObject(track, true);
    if (hits.length) return hits[0].point.clone();
  }
  // Ha semmi sem talált (elvileg nem fordulhat elő), a bbox függőleges
  // közepe biztonságosabb tippnek, mint a teteje (nem lóg majd az égben).
  return new THREE.Vector3(centerX, (box.min.y + box.max.y) / 2, centerZ);
}

async function setTrack(trackUrl, mapId, spawnPoints, gates) {
  setMenuStatus('Pálya betöltése...');
  currentMapId = mapId || null;
  currentSpawnPoints = spawnPoints || [];
  currentGates = {
    start: (gates && gates.start) || null,
    checkpoints: (gates && gates.checkpoints) || [],
  };

  removeTrackCollider();
  if (currentTrack) {
    scene.remove(currentTrack);
    disposeObject3D(currentTrack);
    currentTrack = null;
  }

  const gltf = await loadGLTF(trackUrl);
  const track = gltf.scene;
  const dsSeen = new Set();
  track.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
      // A modellben helyenként fordított normálvektorú háromszögek vannak,
      // ezért kétoldalas renderelés kell (enélkül egyes foltokon átlátszana
      // a háttér). FONTOS: a transzparenciához NEM szabad hozzányúlni itt —
      // több anyag (pl. a gumicsík/groove overlay az aszfalton) szándékosan
      // alfa-blend átlátszó, ha ezt kikapcsoljuk, azok szilárd, hibás
      // foltokká válnak.
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => {
        if (m && !dsSeen.has(m.uuid)) {
          dsSeen.add(m.uuid);
          m.side = THREE.DoubleSide;
        }
      });
    }
  });
  scene.add(track);
  currentTrack = track;
  currentTrackBox = new THREE.Box3().setFromObject(track);

  const floorY = currentTrackBox.min.y - 3;
  safetyFloorMesh.position.set(
    (currentTrackBox.min.x + currentTrackBox.max.x) / 2,
    floorY,
    (currentTrackBox.min.z + currentTrackBox.max.z) / 2
  );
  // A hasáb közepét kell megadni: a teteje legyen a floorY szinten.
  safetyNetBody.setTranslation({ x: 0, y: floorY - 1, z: 0 }, true);

  const slot = pickSpawnSlot(currentSpawnPoints);
  const spot = findShowcaseSpot(track, currentTrackBox, slot);
  spawnPoint.copy(spot).add(new THREE.Vector3(0, 2, 0));
  // A menü-előnézetben nincs fizika, ezért a carPivotot kézzel emeljük a
  // kasztni nyugalmi magasságába — így a modell alja pontosan a talajra kerül.
  carPivot.position.copy(spot);
  carPivot.position.y += groundOffset;
  // A pozíció mellett a rajtpont iránya is számít — enélkül a kirakat-nézetben
  // a kocsi mindig az alapértelmezett (0 fokos) irányba nézne, játékban viszont
  // már a helyes irányba fordulva indul.
  spawnHeading = slot ? slot.heading : 0;
  carPivot.rotation.y = spawnHeading;
  resetCarTo(spawnPoint);

  // A pályához tartozó zóna-térkép (ha van) betöltése a vezetéshez.
  await loadZoneRuntime(manifest && findEntry(manifest.maps, mapId));

  setMenuStatus('');
}

// A látható kerekek forgatásához kerekenként egy pivot kell, a kerék
// geometriai közepén. Sorrend: 0 = első bal, 1 = első jobb, 2 = hátsó bal,
// 3 = hátsó jobb — ugyanaz, mint a fizikai kerekeknél.
//
// Néhány modellben viszont a bal és a jobb kerék EGYETLEN mesh-be van
// olvasztva (tengelyenként egy darab, a középvonalon). Ott csak a gördülést
// tudjuk mutatni: a tengely közepe körüli kormányzás oldalra lökné a
// kerekeket. Ilyenkor 2 pivot van (első és hátsó tengely), steer nélkül.
let wheelPivots = [];
let wheelSources = [];

// Néhány modellben (pl. Sketchfab-exportok, anyagonként egy mesh) mind a 4
// kerék EGYETLEN mesh geometriájába van összeolvasztva — nem 4 külön
// objektum, hanem 4 külön HÁROMSZÖG-CSOPORT ugyanabban a BufferGeometry-ban.
// Ha egy találat mérete jóval nagyobb egy kerékméretnél (a saját tengelye
// mentén is), szétvágjuk a háromszögeit pozíció szerint 4 (vagy tengely-módban
// 2) ÚJ mesh-re, hogy utána ugyanúgy pivotra lehessen fűzni őket, mint egy
// eleve különálló darabot. Ha a szétválasztás nem ad 4 (ill. 2) nem-üres
// csoportot, feladjuk (null) — jobb egyáltalán nem forgatni, mint rosszul.
// midX/midZ a TELJES kerék-készlet (az összes találat) középvonalai, nem
// ennek az egy mesh-nek a sajátja — enélkül egy csak-egy-tengelynyi (bal+jobb,
// de nem elöl+hátul) összeolvasztott darabot tévesen 4 felé vágnánk szét
// a SAJÁT (véletlenszerű, csak erre a tengelyre jellemző) Z-közepén, ami
// egyetlen kereket vágna ketté "elöl/hátul" helyett.
function splitMergedWheelMesh(mesh, midX, midZ) {
  const geom = mesh.geometry;
  const posAttr = geom.attributes && geom.attributes.position;
  const idxAttr = geom.index;
  if (!posAttr || !idxAttr) return null;

  mesh.updateWorldMatrix(true, false);
  const toCarPivot = new THREE.Matrix4().copy(carPivot.matrixWorld).invert().multiply(mesh.matrixWorld);
  const v = new THREE.Vector3();
  const vertCount = posAttr.count;
  const localX = new Float32Array(vertCount);
  const localZ = new Float32Array(vertCount);
  for (let i = 0; i < vertCount; i++) {
    v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(toCarPivot);
    localX[i] = v.x;
    localZ[i] = v.z;
  }

  const idx = idxAttr.array;
  const triCount = idx.length / 3;
  const triCX = new Float32Array(triCount);
  const triCZ = new Float32Array(triCount);
  let hasLeft = false, hasRight = false, hasFront = false, hasRear = false;
  for (let t = 0; t < triCount; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    const cx = (localX[a] + localX[b] + localX[c]) / 3;
    const cz = (localZ[a] + localZ[b] + localZ[c]) / 3;
    triCX[t] = cx; triCZ[t] = cz;
    if (cx > midX) hasRight = true; else hasLeft = true;
    if (cz > midZ) hasFront = true; else hasRear = true;
  }
  // Ha ez az EGY darab csak az egyik oldalon (bal VAGY jobb) ül, esetleg csak
  // az egyik tengelyen (elöl VAGY hátul), akkor abban az irányban nincs mit
  // szétválasztani — csak ott vágjunk, ahol a darab ténylegesen átnyúlik a
  // globális középvonalon.
  const splitX = hasLeft && hasRight;
  const splitZ = hasFront && hasRear;
  if (!splitX && !splitZ) return null;

  const triGroups = splitX && splitZ ? [[], [], [], []] : [[], []];
  for (let t = 0; t < triCount; t++) {
    let g;
    if (splitX && splitZ) g = (triCZ[t] > midZ ? 0 : 1) * 2 + (triCX[t] > midX ? 1 : 0);
    else if (splitX) g = triCX[t] > midX ? 1 : 0;
    else g = triCZ[t] > midZ ? 0 : 1;
    triGroups[g].push(t);
  }
  if (triGroups.some((g) => g.length === 0)) return null;

  const attrNames = Object.keys(geom.attributes);
  const newMeshes = triGroups.map((tris) => {
    const remap = new Map();
    const newIndex = new Uint32Array(tris.length * 3);
    const newAttrData = {};
    attrNames.forEach((name) => { newAttrData[name] = []; });
    let cursor = 0;
    tris.forEach((t) => {
      for (let k = 0; k < 3; k++) {
        const orig = idx[t * 3 + k];
        let ni = remap.get(orig);
        if (ni === undefined) {
          ni = remap.size;
          remap.set(orig, ni);
          attrNames.forEach((name) => {
            const src = geom.attributes[name];
            for (let c = 0; c < src.itemSize; c++) newAttrData[name].push(src.getComponent(orig, c));
          });
        }
        newIndex[cursor++] = ni;
      }
    });
    const newGeom = new THREE.BufferGeometry();
    attrNames.forEach((name) => {
      const src = geom.attributes[name];
      newGeom.setAttribute(name, new THREE.Float32BufferAttribute(newAttrData[name], src.itemSize));
    });
    newGeom.setIndex(new THREE.BufferAttribute(newIndex, 1));
    const newMesh = new THREE.Mesh(newGeom, mesh.material);
    newMesh.castShadow = mesh.castShadow;
    newMesh.receiveShadow = mesh.receiveShadow;
    mesh.matrix.decompose(newMesh.position, newMesh.quaternion, newMesh.scale);
    return newMesh;
  });

  const parent = mesh.parent;
  newMeshes.forEach((m) => parent.add(m));
  parent.remove(mesh);
  geom.dispose();
  return newMeshes;
}

// Ugyanazzal a névre+anyagra illesztéssel megméri, hol van a LÁTHATÓ
// kerekek középpontja a carRoot saját (még nem carPivot-hoz csatolt)
// terében — ebből tudja a hívó, mennyivel kell eltolni a modellt, hogy a
// kerekek a fizikai kasztni origójára (X=0, Z=0) essenek. Nem ad vissza
// semmit, ha nincs elég találat (legalább 2 kell egy értelmes középhez).
// A középső elem (páros elemszámnál a két középső átlaga) — a min/max
// átlagával ellentétben nem csúszik el egyetlen kilógó (pl. egy hibás,
// eltévedt duplikátum darab a forrásmodellben) ponttól.
function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// A puszta medián csak akkor esik a két tengely (illetve a bal/jobb oldal)
// KÖZÉ, ha a minta nagyjából ugyanannyi darabot fogott meg elöl és hátul.
// Ez gyakran nem igaz — a Red Bull RB20-nál például a féknyereg csak az
// első tengelyen létezik —, és akkor a medián átcsúszik az egyik tengelyre:
// onnantól a modellt fél tengelytávval eltolva ültetnénk a fizikai
// kasztnira, vagyis a kocsi láthatóan hátrébb (vagy előrébb) állna a
// többinél. Ezért a mediánt csak ELVÁLASZTÓNAK használjuk, és a két oldal
// saját mediánjának a felezőpontját vesszük valódi középnek — ez független
// attól, melyik oldalon hány darab van, és egy-egy kilógó darabra ugyanúgy
// érzéketlen marad, mint a puszta medián.
function axisCentre(values) {
  const mid = median(values);
  const hi = values.filter((v) => v > mid);
  const lo = values.filter((v) => v < mid);
  if (!hi.length || !lo.length) return mid;
  return (median(hi) + median(lo)) / 2;
}

function findWheelCentreOffset(carRoot, wheelPattern) {
  if (!wheelPattern) return null;
  let regex;
  try {
    regex = new RegExp(wheelPattern, 'i');
  } catch (err) {
    return null;
  }
  const box = new THREE.Box3();
  const centre = new THREE.Vector3();
  const xs = [];
  const zs = [];
  carRoot.traverse((obj) => {
    if (!obj.isMesh) return;
    let name = '';
    for (let n = obj; n && n !== carRoot.parent; n = n.parent) name += ' ' + (n.name || '');
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    mats.forEach((m) => { if (m && m.name) name += ' ' + m.name; });
    if (!regex.test(name)) return;
    box.setFromObject(obj);
    box.getCenter(centre);
    xs.push(centre.x);
    zs.push(centre.z);
  });
  if (xs.length < 2) return null;
  return {
    x: axisCentre(xs),
    z: axisCentre(zs),
  };
}

// A kerék-alkatrészeket pozíció szerint osztjuk 4 sarokba, mert a nevek
// gyakran NEM árulják el, melyik melyik (a BMW M3-nál például a hátsó
// kerekek is "FRONT_TIRE" néven szerepelnek, csak sorszámmal).
// Ráadásul egyes alkatrészeknél a pozíció a vertexekbe van sütve, ezért
// a csoport közepére tett pivotra fűzzük fel őket: az Object3D.attach
// megtartja a világ-transzformot, így a kerék nem ugrik el.
function buildWheelPivots(carRoot, wheelPattern) {
  wheelPivots = [];
  wheelSources = [];
  if (!wheelPattern) return;

  let regex;
  try {
    regex = new RegExp(wheelPattern, 'i');
  } catch (err) {
    console.warn('Hibás wheelPattern a kocsi konfigjában', err);
    return;
  }

  carPivot.updateMatrixWorld(true);
  // Először csak ÖSSZEGYŰJTJÜK a találatokat — a traverse közben nem
  // módosíthatjuk a fát (a szétvágás mesh-eket cserélne ki), azt egy
  // különálló, második körben tesszük meg.
  const matches = [];
  carRoot.traverse((obj) => {
    if (!obj.isMesh) return;
    // A név a szülőkben is lehet (a glTF gyakran Object_N néven hagyja a mesh-t).
    let name = '';
    for (let n = obj; n && n !== carRoot.parent; n = n.parent) name += ' ' + (n.name || '');
    // Néhány modellnél (anyagonként egy mesh, pl. "lamborghini_countach_7") a
    // kerékre utaló infó KIZÁRÓLAG az anyag nevében van, a mesh/objektum neve
    // csak egy generikus sorszám — ezért az anyagnév(ek)et is hozzáfűzzük.
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    mats.forEach((m) => { if (m && m.name) name += ' ' + m.name; });
    if (!regex.test(name)) return;
    matches.push(obj);
  });

  const box = new THREE.Box3();
  const centre = new THREE.Vector3();
  const size = new THREE.Vector3();

  // Első kör: csak a KÖZÉPPONTOKAT és méreteket mérjük fel — ez adja a teljes
  // kerék-készlet globális középvonalait (globalMidX/Z), MIELŐTT bármit
  // szétvágnánk. Enélkül egy csak-egy-tengelynyi (bal+jobb, de nem elöl is)
  // összeolvasztott darabot a SAJÁT véletlenszerű közepén vágnánk szét,
  // ami egyetlen kereket bontana ketté "elöl/hátul" helyett.
  const prelim = matches.map((obj) => {
    box.setFromObject(obj);
    box.getCenter(centre);
    box.getSize(size);
    return { mesh: obj, local: carPivot.worldToLocal(centre.clone()), size: size.clone() };
  });
  if (prelim.length < 1) return;
  const prelimXs = prelim.map((p) => p.local.x);
  const prelimZs = prelim.map((p) => p.local.z);
  const globalMidX = median(prelimXs);
  const globalMidZ = median(prelimZs);

  const parts = [];
  prelim.forEach(({ mesh, size }) => {
    // Ha egy TALÁLAT önmagában is jóval nagyobb egy keréknél (a vízszintes
    // irányok legalább egyikében), az nagy eséllyel több kereket tartalmaz
    // egyetlen geometriában összeolvasztva (Sketchfab anyagonkénti export) —
    // megpróbáljuk a háromszögeit a globális középvonalak mentén szétvágni.
    if (size.x > 1.0 || size.z > 1.0) {
      const split = splitMergedWheelMesh(mesh, globalMidX, globalMidZ);
      if (split) {
        split.forEach((m) => {
          box.setFromObject(m);
          box.getCenter(centre);
          box.getSize(size);
          parts.push({ mesh: m, local: carPivot.worldToLocal(centre.clone()), volume: size.x * size.y * size.z });
        });
        return;
      }
    }
    box.setFromObject(mesh);
    box.getCenter(centre);
    box.getSize(size);
    parts.push({ mesh, local: carPivot.worldToLocal(centre.clone()), volume: size.x * size.y * size.z });
  });
  if (parts.length < 2) return;

  const xs = parts.map((p) => p.local.x);
  const zs = parts.map((p) => p.local.z);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanZ = Math.max(...zs) - Math.min(...zs);
  const midX = median(xs);
  const midZ = median(zs);

  // Ha a darabok mind a középvonalon ülnek, akkor bal/jobb nincs külön
  // mesh-ben: tengelyenként csoportosítunk, és nem kormányzunk.
  const axleMode = spanX < spanZ * 0.25;

  // A medián önmagában NEM használható vágóvonalnak: a modellt épp az imént
  // igazítottuk a kerekek mediánjára (findWheelCentreOffset), így darabok
  // PONTOSAN rá is eshetnek a mediánra. Ilyenkor egy szigorú "> medián"
  // teszten a lebegőpontos hajszál dönti el, melyik tengelyhez kerül a darab
  // — a rossz oldalra sorolt apró alkatrész (pl. egy féknyereg) aztán a másik
  // kerék pivotja körül, méteres sugárban kering. Ezért nem a mediánhoz mért
  // "nagyobb/kisebb" dönt, hanem a két TÉNYLEGES oldal-közép: a darab ahhoz a
  // tengelyhez/oldalhoz kerül, amelyikhez közelebb van.
  const sideRef = (values, mid) => {
    const hi = values.filter((v) => v > mid);
    const lo = values.filter((v) => v < mid);
    return { hi: hi.length ? median(hi) : mid, lo: lo.length ? median(lo) : mid };
  };
  const zRef = sideRef(zs, midZ);
  const xRef = sideRef(xs, midX);
  const nearerHi = (value, ref) => Math.abs(value - ref.hi) <= Math.abs(value - ref.lo);

  // index: 0=FL, 1=FR, 2=RL, 3=RR — a +Z az autó eleje
  // (tengely-módban: 0 = első tengely, 1 = hátsó tengely)
  const groups = axleMode ? [[], []] : [[], [], [], []];
  parts.forEach((p) => {
    const rear = nearerHi(p.local.z, zRef) ? 0 : 1;
    if (axleMode) groups[rear].push(p);
    else groups[rear * 2 + (nearerHi(p.local.x, xRef) ? 1 : 0)].push(p);
  });
  if (groups.some((g) => g.length === 0)) return;

  // Melyik fizikai kerékről vegyük a gördülést, és forduljon-e a pivot.
  wheelSources = axleMode
    ? [{ wheel: 0, steer: false }, { wheel: 2, steer: false }]
    : [0, 1, 2, 3].map((i) => ({ wheel: i, steer: i < 2 }));

  wheelPivots = groups.map((group) => {
    const pivot = new THREE.Group();
    pivot.rotation.order = 'YXZ'; // előbb a gördülés (X), utána a kormányzás (Y)
    // A pivotot NEM a csoport összes darabjának átlagára tesszük: a féknyereg
    // és a féktárcsa gyakran több cm-rel arrébb van a valódi tengelyhez képest,
    // mint a gumi, és az átlag emiatt lecsúszna a tengelyről — forgás közben
    // az egész kerék "kilendülne" a hibás pivot körül. Ehelyett a csoport
    // legnagyobb térfogatú darabját (szinte mindig a gumi, ami forgásszimmetrikus)
    // vesszük referenciának.
    const anchor = group.reduce((a, b) => (b.volume > a.volume ? b : a));
    pivot.position.copy(anchor.local);
    carPivot.add(pivot);
    // attach (nem add): megtartja a világ-pozíciót, így a baked geometria
    // is a helyén marad.
    group.forEach((p) => pivot.attach(p.mesh));
    return pivot;
  });
}

async function setCar(carUrl, carId, config) {
  setMenuStatus('Kocsi betöltése...');

  carLoaded = false;
  // Csak a korábbi karosszéria-modellt dobjuk el — a fényszórók (és a
  // célpontjaik) szintén a carPivot gyerekei, azokat meg kell tartani.
  if (currentCarModel) {
    carPivot.remove(currentCarModel);
    disposeObject3D(currentCarModel);
    currentCarModel = null;
  }
  wheelPivots.forEach((p) => carPivot.remove(p));
  wheelPivots = [];
  wheelSources = [];

  const gltf = await loadGLTF(carUrl);
  const carRoot = gltf.scene;
  carRoot.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });

  // A modell "hossz-tengelyét" automatikusan felismerjük: amelyik vízszintes
  // tengely (X vagy Z) mentén nagyobb a kiterjedés, az a kocsi hossza.
  // Ha ez X, 90 fokkal el kell forgatni, hogy a fizikai Z-tengellyel (előre) essen egybe.
  // Az előre/hátra felcserélést a kocsi JSON-jában lévő yawDegrees javítja.
  const box = new THREE.Box3().setFromObject(carRoot);
  const size = new THREE.Vector3();
  box.getSize(size);
  const extraYaw = THREE.MathUtils.degToRad((config && config.yawDegrees) || 0);
  const yaw = (size.x >= size.z ? Math.PI / 2 : 0) + extraYaw;
  carRoot.rotation.y = yaw;
  carRoot.updateMatrixWorld(true);

  // Újramérjük a bboxot a forgatás után, hogy a helyes tengely mentén skálázzunk.
  const box2 = new THREE.Box3().setFromObject(carRoot);
  const size2 = new THREE.Vector3();
  box2.getSize(size2);
  const targetLength = chassisSize.z * 2;
  const scale = size2.z > 0 ? targetLength / size2.z : 1;
  carRoot.scale.setScalar(scale);
  carRoot.updateMatrixWorld(true);

  // Néhány letöltött modellnél a fájl saját origója NEM a tengelytáv
  // közepén van (pl. egy hosszú orrú versenyautónál a modellező nem oda
  // tette a nullpontot) — emiatt a látható kocsi eltolva ülne a láthatatlan
  // fizikai kasztnihoz (és a fizikai kerekekhez, amik ±1.5-nél vannak)
  // képest, és az egyik vége jobban belelógna a falba ütközéskor, mint
  // kellene. Ha van wheelPattern, megmérjük, hol van a LÁTHATÓ kerekek
  // középpontja, és eltoljuk a modellt, hogy az pontosan a fizikai
  // kerekek középpontjára (X=0, Z=0) essen.
  const wheelCentre = findWheelCentreOffset(carRoot, config && config.wheelPattern);
  if (wheelCentre) {
    carRoot.position.x -= wheelCentre.x;
    carRoot.position.z -= wheelCentre.z;
    carRoot.updateMatrixWorld(true);
  }

  // Végül a modellt úgy toljuk el, hogy a gumik alja pontosan a talajon legyen
  // (a groundOffset a kasztni közepétől a talajig mért távolság).
  const box3 = new THREE.Box3().setFromObject(carRoot);
  carModelBottomRaw = -box3.min.y;

  carPivot.add(carRoot);
  currentCarModel = carRoot;
  applyCarModelHeight();
  buildWheelPivots(carRoot, config && config.wheelPattern);
  carLoaded = true;
  setMenuStatus('');
}

// Egyetlen GPU-render alapú "fedettségi maszk": felülről lefotózzuk a pályát
// (fekete háttérrel), és minden nem-fekete pixel jelzi, hogy ott VAN valami.
// Ez sokezerszer gyorsabb, mint sugarakkal letapogatni ugyanezt, és — mivel
// egy hurok-alakú pálya kontúrja amúgy is majdnem kitölti a saját bbox-át —
// ez az egyetlen praktikus módja annak, hogy finoman (ne csak egy durva
// rács alapján) kizárjuk a pálya melletti üres területeket a sűrű
// mintavételből.
function buildCoverageMask(track, box, resolution) {
  const width = box.max.x - box.min.x;
  const depth = box.max.z - box.min.z;
  const aspect = width / depth;
  const texW = Math.max(2, Math.round(aspect >= 1 ? resolution : resolution * aspect));
  const texH = Math.max(2, Math.round(aspect >= 1 ? resolution / aspect : resolution));

  const centerX = (box.min.x + box.max.x) / 2;
  const centerZ = (box.min.z + box.max.z) / 2;
  const topCamera = new THREE.OrthographicCamera(-width / 2, width / 2, depth / 2, -depth / 2, 0.1, (box.max.y - box.min.y) + 200);
  topCamera.position.set(centerX, box.max.y + 100, centerZ);
  topCamera.up.set(0, 0, -1);
  topCamera.lookAt(centerX, box.min.y, centerZ);
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
  camera.aspect = prevSize.x / prevSize.y;
  camera.updateProjectionMatrix();

  const mask = new Uint8Array(texW * texH);
  for (let p = 0; p < texW * texH; p++) {
    const o = p * 4;
    if (pixels[o] > 12 || pixels[o + 1] > 12 || pixels[o + 2] > 12) mask[p] = 1;
  }
  return { mask, texW, texH, box };
}

// ---------- Aszfalt automatikus felismerése anyag-kiválasztás alapján ----------
// A letöltött pályamodellek anyagai gyakran értelmetlen nevekkel jönnek
// (pl. "282_63"), úgyhogy nem lehet név szerint megkeresni, melyik az
// útburkolat. Ehelyett a felhasználó bélyegképek alapján, VIZUÁLISAN
// kiválasztja, melyik anyag(ok) az aszfalt — utána ugyanazzal a felülnézeti
// GPU-renderrel (mint buildCoverageMask), csak anyag szerint szűrve,
// kirajzoljuk, hol van ilyen anyagú felület, és abból generáljuk a zóna-maszkot.
const highlightMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });

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
  if (!currentTrack) return;
  selectedRoadMaterials = new Set();
  materialPickerGridEl.innerHTML = '';
  materialPickerStatusEl.textContent = '';
  const materials = collectTrackMaterials(currentTrack);
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

// Ugyanaz a GPU-s felülnézeti render, mint buildCoverageMask, csak itt csak
// a kiválasztott anyagú mesh-ek látszanak (fehéren, világítástól függetlenül),
// minden más el van rejtve — így a kapott kép pontosan az útburkolat alakja.
function renderMaterialMask(track, bounds, texW, texH, materialSet) {
  const saved = [];
  track.traverse((obj) => {
    if (!obj.isMesh) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const uses = mats.some((m) => materialSet.has(m));
    saved.push({ obj, visible: obj.visible, material: obj.material });
    obj.visible = uses;
    if (uses) obj.material = highlightMaterial;
  });

  // A "lyukakat takaró" vizuális padló és a kocsi NEM a track gyereke, hanem
  // közvetlenül a jelenethez van adva — enélkül a fenti elrejtés után is
  // átlátszana rajtuk a kamera, és a padló (ami mindent befed alattuk)
  // tévesen mindenhol "fehérnek" tűnne.
  const extraHidden = [safetyFloorMesh, carPivot, ...devSpawnMarkers].filter(Boolean);
  const savedExtra = extraHidden.map((obj) => ({ obj, visible: obj.visible }));
  extraHidden.forEach((obj) => { obj.visible = false; });

  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxZ - bounds.minZ;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;
  const topCamera = new THREE.OrthographicCamera(-width / 2, width / 2, depth / 2, -depth / 2, 0.1, (currentTrackBox.max.y - currentTrackBox.min.y) + 200);
  topCamera.position.set(centerX, currentTrackBox.max.y + 100, centerZ);
  topCamera.up.set(0, 0, -1);
  topCamera.lookAt(centerX, currentTrackBox.min.y, centerZ);
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
  if (!currentTrack || !zoneMaskCanvas) return;
  if (!selectedRoadMaterials.size) {
    materialPickerStatusEl.textContent = 'Válassz ki legalább egy aszfalt-anyagot.';
    return;
  }
  materialPickerStatusEl.textContent = 'Generálás...';
  const texW = zoneMaskCanvas.width;
  const texH = zoneMaskCanvas.height;
  const mask = renderMaterialMask(currentTrack, zoneBounds, texW, texH, selectedRoadMaterials);

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

openMaterialPickerBtn.addEventListener('click', openMaterialPicker);
closeMaterialPickerBtn.addEventListener('click', closeMaterialPicker);
generateAsphaltBtn.addEventListener('click', generateAsphaltMask);

// Van-e bármi a világ (x,z) pont közelében a maszk szerint (kis margóval,
// hogy a pálya széle biztosan ne maradjon ki egy pixelnyi pontatlanság miatt).
function maskHasCoverage(cov, x, z) {
  const px = Math.floor(((x - cov.box.min.x) / (cov.box.max.x - cov.box.min.x)) * cov.texW);
  const py = Math.floor(((z - cov.box.min.z) / (cov.box.max.z - cov.box.min.z)) * cov.texH);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const nx = px + dx, ny = py + dy;
      if (nx >= 0 && nx < cov.texW && ny >= 0 && ny < cov.texH && cov.mask[ny * cov.texW + nx]) return true;
    }
  }
  return false;
}

// ---------- Ütközési háromszögháló kinyerése a pálya modelljéből ----------
// Ez váltja ki a korábbi magasságtérképet. Egy magasságtérkép 2D függvény —
// egy (x,z) ponthoz egyetlen magasság —, ezért elvileg sem tud hidat/felüljárót
// ábrázolni. Egy valódi háromszöghálónál ez magától megoldódik.
//
// Szűrés: csak a nagyjából vízszintes lapokat tartjuk meg (a függőleges falak,
// kerítések, épületoldalak kiesnek), így a háromszögszám nagyjából felére
// csökken, és nem a falakon akad meg a kerék-sugár.
const COLLISION_NORMAL_MIN_Y = 0.5;

function extractDrivableTriangles(track) {
  track.updateMatrixWorld(true);
  const positions = [];
  const indices = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();

  track.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    const pos = obj.geometry.attributes.position;
    const idx = obj.geometry.index;
    const count = idx ? idx.count : pos.count;
    for (let i = 0; i < count; i += 3) {
      const i0 = idx ? idx.getX(i) : i;
      const i1 = idx ? idx.getX(i + 1) : i + 1;
      const i2 = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(obj.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(obj.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(obj.matrixWorld);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      n.crossVectors(ab, ac).normalize();
      if (Math.abs(n.y) <= COLLISION_NORMAL_MIN_Y) continue;
      const base = positions.length / 3;
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      indices.push(base, base + 1, base + 2);
    }
  });

  return pruneIsolatedDebris(new Float32Array(positions), new Uint32Array(indices));
}

// Néhány letöltött pályamodellben apró, a valódi útfelülettől teljesen
// ELKÜLÖNÜLŐ tárgyak (pl. reklám-kockák a bokszutca szélén) is bekerülnek az
// ütközésbe — a vizuális modellben nem is látszanak (a Sketchfab-konverzió
// kihagyta őket), de az ütközésük megmarad, és a kocsi beléjük ragad.
//
// A valódi útfelület egyetlen összefüggő háromszög-háló (a kerekek sugara
// mindig átjut egyik lapról a másikra). Ami ehhez képest KICSI ÉS elszigetelt
// (nincs közös éle semmi mással), az nagy eséllyel egy ilyen "elszabadult"
// tárgy — ezeket dobjuk el. A méret-küszöb óvatos: egy igazi, de kisebb
// pályaelem (pl. egy híd egy szakasza) jóval nagyobb ennél, szóval megmarad.
const DEBRIS_MAX_TRIANGLES = 300;
const DEBRIS_MAX_SIZE = 3; // méter, a komponens bbox egyik oldala se legyen ennél nagyobb

function pruneIsolatedDebris(positions, indices) {
  const parent = new Map();
  function find(key) {
    let root = key;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root);
    let cur = key;
    while (parent.has(cur) && parent.get(cur) !== root) {
      const next = parent.get(cur);
      parent.set(cur, root);
      cur = next;
    }
    if (!parent.has(root)) parent.set(root, root);
    return root;
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  // Milliméter-pontosságú kulcs: az egymáshoz kapcsolódó háromszögek közös
  // csúcsai (bár az extractDrivableTriangles nem oszt indexet) ugyanide esnek.
  const keyOf = (i) => {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    return Math.round(x * 1000) + ',' + Math.round(y * 1000) + ',' + Math.round(z * 1000);
  };

  const triCount = indices.length / 3;
  const triKeys = new Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
    const k0 = keyOf(i0), k1 = keyOf(i1), k2 = keyOf(i2);
    union(k0, k1);
    union(k1, k2);
    triKeys[t] = k0;
  }

  const compTris = new Map(); // root -> [triangle indexek]
  const compBounds = new Map(); // root -> {minX,maxX,minY,maxY,minZ,maxZ}
  for (let t = 0; t < triCount; t++) {
    const root = find(triKeys[t]);
    if (!compTris.has(root)) {
      compTris.set(root, []);
      compBounds.set(root, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity });
    }
    compTris.get(root).push(t);
    const b = compBounds.get(root);
    for (let k = 0; k < 3; k++) {
      const vi = indices[t * 3 + k];
      const x = positions[vi * 3], y = positions[vi * 3 + 1], z = positions[vi * 3 + 2];
      if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x;
      if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y;
      if (z < b.minZ) b.minZ = z; if (z > b.maxZ) b.maxZ = z;
    }
  }

  const keptPositions = [];
  const keptIndices = [];
  let droppedComponents = 0, droppedTriangles = 0;
  for (const [root, tris] of compTris) {
    const b = compBounds.get(root);
    const size = Math.max(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ);
    const isDebris = tris.length <= DEBRIS_MAX_TRIANGLES && size <= DEBRIS_MAX_SIZE;
    if (isDebris) {
      droppedComponents++;
      droppedTriangles += tris.length;
      continue;
    }
    for (const t of tris) {
      const base = keptPositions.length / 3;
      for (let k = 0; k < 3; k++) {
        const vi = indices[t * 3 + k];
        keptPositions.push(positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]);
      }
      keptIndices.push(base, base + 1, base + 2);
    }
  }

  if (droppedComponents > 0) {
    console.info(`Ütközés: ${droppedComponents} elszigetelt, kis darab kihagyva (${droppedTriangles} háromszög) — feltehetően a modellből örökölt, láthatatlan tárgyak.`);
  }

  return { positions: new Float32Array(keptPositions), indices: new Uint32Array(keptIndices) };
}

function applyTrackCollider(positions, indices) {
  removeTrackCollider();
  trackColliderBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  trackCollider = world.createCollider(
    RAPIER.ColliderDesc.trimesh(positions, indices).setFriction(1.0),
    trackColliderBody
  );
  // A Rapier lekérdező pipeline-ját a world.step() frissíti; enélkül a
  // kerekek sugarai némán semmit sem találnának el az első képkockákon.
  world.step();
}

// A LÁTHATÓ padlóhoz (ami a modell lyukait takarja) továbbra is kell egy durva
// magasság-rács. Ez viszont csak dísz, nem fizika, ezért sokkal ritkább
// mintavétel is elég — a fedettségi maszkkal együtt ez már gyors.
function buildVisualFloorGrid(track, box) {
  track.traverse((obj) => {
    if (obj.isMesh && obj.geometry) obj.geometry.computeBoundsTree();
  });
  const coverage = buildCoverageMask(track, box, 1024);

  const sizeX = box.max.x - box.min.x;
  const sizeZ = box.max.z - box.min.z;
  const elementSize = Math.max(8, Math.sqrt((sizeX * sizeZ) / 20000));
  const nx = Math.max(2, Math.ceil(sizeX / elementSize) + 1);
  const nz = Math.max(2, Math.ceil(sizeZ / elementSize) + 1);

  const data = [];
  for (let i = 0; i < nx; i++) data.push(new Array(nz).fill(box.min.y - 50));

  const raycaster = new THREE.Raycaster();
  // A LEGALSÓ találat kell, nem a legfelső. A legfelső egy épületnél a tető
  // lenne, és a padló felkúszna a tetőig (fekete tüskék a pálya mellett).
  // A padlónak definíció szerint minden alatt kell lennie.
  raycaster.firstHitOnly = false;
  // A rács ritka (több tíz méteres cellák), ezért két mintavételi pont között
  // a padló átlósan elvághatja a domborzatot, és néhol kibukkan a talajból.
  // Ezért az egészet lejjebb toljuk: a lyukakat így is takarja, de nem kúszik fel.
  const FLOOR_DROP = 3.5;
  const dir = new THREE.Vector3(0, -1, 0);
  const rayOriginY = box.max.y + 20;

  for (let i = 0; i < nx; i++) {
    const worldX = box.min.x + i * elementSize;
    for (let j = 0; j < nz; j++) {
      const worldZ = box.max.z - j * elementSize;
      if (!maskHasCoverage(coverage, worldX, worldZ)) continue;
      raycaster.set(new THREE.Vector3(worldX, rayOriginY, worldZ), dir);
      const hits = raycaster.intersectObject(track, true);
      if (hits.length) data[i][j] = hits[hits.length - 1].point.y - FLOOR_DROP;
    }
  }

  return { data, elementSize };
}

// A rajtponthoz a legközelebbi tényleges felszín megkeresése (a kocsit ide
// tesszük Indításkor). Egyetlen lefelé lőtt sugár a kívánt X/Z fölött.
function findGroundAt(track, box, x, z) {
  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  raycaster.set(new THREE.Vector3(x, box.max.y + 20, z), new THREE.Vector3(0, -1, 0));
  const hits = raycaster.intersectObject(track, true);
  return hits.length ? hits[0].point.y : null;
}

// ---------- Zóna-térkép futásidőben (aszfalt / kifutó / fal) ----------
// A dev módban festett maszkot itt olvassuk vissza, és tömör (1 bájt/cella)
// kódtömbbé alakítjuk — így a vezetés közbeni lekérdezés egy sima
// tömb-indexelés, nincs képfeldolgozás képkockánként.
const ZONE_ASPHALT = 0;
const ZONE_OFFTRACK = 1;
const ZONE_WALL = 2;
let zoneRuntime = null;

async function loadZoneRuntime(entry) {
  zoneRuntime = null;
  if (!entry || !entry.zonemap) return;

  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = 'assets/' + entry.zonemap.file + '?t=' + Date.now();
  });

  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height).data;

  const codes = new Uint8Array(img.width * img.height);
  for (let i = 0; i < codes.length; i++) {
    const alpha = data[i * 4 + 3];
    // Az ecsetvonás pereme élsimított (halvány) — alacsony küszöb kell, hogy
    // a látható folt SZÉLE is beleszámítson, különben a fal/kifutó egy
    // pixelnyivel kisebb lenne, mint amit a szerkesztőben látsz.
    if (alpha < 16) continue; // festetlen = aszfalt (0)
    // A két festék jól elkülönül a zöld csatornán:
    // kifutó = rgb(255,165,0) -> g=165, fal = rgb(220,20,60) -> g=20.
    codes[i] = data[i * 4 + 1] > 100 ? ZONE_OFFTRACK : ZONE_WALL;
  }

  zoneRuntime = { codes, w: img.width, h: img.height, bounds: entry.zonemap.bounds };
}

function sampleZoneAt(x, z) {
  if (!zoneRuntime) return ZONE_ASPHALT;
  const b = zoneRuntime.bounds;
  const u = Math.floor(((x - b.minX) / (b.maxX - b.minX)) * zoneRuntime.w);
  const v = Math.floor(((z - b.minZ) / (b.maxZ - b.minZ)) * zoneRuntime.h);
  if (u < 0 || v < 0 || u >= zoneRuntime.w || v >= zoneRuntime.h) return ZONE_ASPHALT;
  return zoneRuntime.codes[v * zoneRuntime.w + u];
}

// A falkezeléshez tudnunk kell, hol volt a kocsi utoljára érvényes helyen.
const lastSafePos = new THREE.Vector3();

// A falat az autó TELJES alaprajzával ütköztetjük, nem csak a középpontjával:
// négy sarokpontot (+ a közepet) is megmintázunk, elforgatva a kocsi aktuális
// állásába. Enélkül a kocsi orra/oldala jócskán belelógott a falba, amíg a
// középpont még kívül volt.
const wallProbeLocal = [
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(chassisSize.x, 0, chassisSize.z),
  new THREE.Vector3(-chassisSize.x, 0, chassisSize.z),
  new THREE.Vector3(chassisSize.x, 0, -chassisSize.z),
  new THREE.Vector3(-chassisSize.x, 0, -chassisSize.z),
];
const _probeVec = new THREE.Vector3();
const _probeQuat = new THREE.Quaternion();

function carTouchesWall() {
  const q = chassisBody.rotation();
  const pos = chassisBody.translation();
  _probeQuat.set(q.x, q.y, q.z, q.w);
  for (const local of wallProbeLocal) {
    _probeVec.copy(local).applyQuaternion(_probeQuat);
    if (sampleZoneAt(pos.x + _probeVec.x, pos.z + _probeVec.z) === ZONE_WALL) return true;
  }
  return false;
}

// Láthatatlan fal: nem építünk hozzá ütköző-geometriát, hanem ha a kocsi
// falcellába kerül, visszatesszük az utolsó érvényes helyre, és csak a falba
// MUTATÓ sebesség-komponenst vesszük el — így a fal mentén tovább lehet
// csúszni, nem ragad meg és nem pattan vissza.
function applyWallConstraint() {
  const pos = chassisBody.translation();
  if (!carTouchesWall()) {
    lastSafePos.set(pos.x, pos.y, pos.z);
    return;
  }

  const dx = pos.x - lastSafePos.x;
  const dz = pos.z - lastSafePos.z;
  const len = Math.hypot(dx, dz);
  chassisBody.setTranslation({ x: lastSafePos.x, y: pos.y, z: lastSafePos.z }, true);

  if (len > 1e-4) {
    const nx = dx / len;
    const nz = dz / len;
    const v = chassisBody.linvel();
    const into = v.x * nx + v.z * nz;
    let vx = v.x;
    let vz = v.z;
    if (into > 0) {
      vx -= into * nx;
      vz -= into * nz;
    }
    chassisBody.setLinvel({ x: vx * 0.85, y: v.y, z: vz * 0.85 }, true);
  }
}

// A látható kerekek beállítása a fizikából: gördülés minden keréken,
// kormányzás csak az elsőkön. A pivot Euler-sorrendje YXZ, ezért a gördülés
// (X) a kerék saját tengelye körül történik, és utána forgatja el a
// kormányzás (Y) — fordított sorrendben csálén állna a kerék.
function updateWheelVisuals() {
  if (!wheelPivots.length) return;
  for (let i = 0; i < wheelPivots.length; i++) {
    const src = wheelSources[i];
    const roll = vehicle.wheelRotation(src.wheel) ?? 0;
    const steer = src.steer ? (vehicle.wheelSteering(src.wheel) ?? 0) : 0;
    wheelPivots[i].rotation.set(roll, steer, 0);
  }
}

// ---------- Verseny: körszámlálás, visszaszámlálás, eredmény ----------
// A köröket kapu-átmetszéssel számoljuk: minden képkockán megnézzük, hogy az
// autó ELŐZŐ és MOSTANI pozíciója közötti szakasz metszi-e a soron következő
// kaput. Ez nagy sebességnél sem hibázik (nem lehet "átugrani" a vonalat),
// szemben egy egyszerű távolság-ellenőrzéssel.
const COUNTDOWN_SECONDS = 3;

const race = {
  active: false,
  phase: 'idle',      // 'countdown' | 'running' | 'finished'
  countdownLeft: 0,
  totalLaps: 3,
  lap: 0,             // hány kört teljesített
  nextCheckpoint: 0,  // hányadik checkpoint jön (utána a rajtvonal zárja a kört)
  startTime: 0,
  lapStartTime: 0,
  lapTimes: [],       // { time, invalid } — az érvénytelen kör is SZÁMÍT, csak meg van jelölve
  lapTainted: false,  // ebben a körben már volt rossz sorrendű checkpoint-átlépés
  prevX: 0,
  prevZ: 0,
  invalidUntil: 0,  // performance.now() időbélyeg, ameddig a "kör érvénytelen" üzenet látszik
};

// Hova helyezze vissza a kocsit az R billentyű: az utolsó érintett
// checkpont (vagy a rajtvonal, ha még egyet sem ért el ebben a körben).
// Csak sikeres áthaladáskor frissül — kihagyott/érvénytelen kereszteződéskor
// szándékosan nem, így R mindig a legutóbbi jó pontra visz vissza.
let lastCheckpointSpawn = null;

// Két szakasz metszi-e egymást (2D, felülnézetből).
function segmentsIntersect(ax, az, bx, bz, cx, cz, dx, dz) {
  const d1 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d2 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  const d3 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d4 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
         ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function crossedGate(gate, fromX, fromZ, toX, toZ) {
  if (!gate) return false;
  return segmentsIntersect(fromX, fromZ, toX, toZ, gate.x1, gate.z1, gate.x2, gate.z2);
}

// A kapun áthaladáskor nincs eltárolt "helyes irány" (a checkpointoknak nincs
// heading-jük, csak egy szakasz) — ezért abból számoljuk, amerre a kocsi
// éppen haladt, amikor átment rajta. Ha épp egy helyben áll (dx=dz=0), inkább
// megtartjuk az előző mentett irányt, mint hogy nullát adjunk vissza.
function headingFromMovement(fromX, fromZ, toX, toZ, fallback) {
  const dx = toX - fromX, dz = toZ - fromZ;
  if (Math.abs(dx) < 1e-4 && Math.abs(dz) < 1e-4) return fallback;
  return Math.atan2(dx, dz);
}

function formatTime(ms) {
  if (!isFinite(ms) || ms < 0) return '--:--.---';
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  const msPart = Math.floor(ms % 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(msPart).padStart(3, '0')}`;
}

function startRace() {
  const pos = chassisBody.translation();
  race.active = !!currentGates.start;
  race.phase = 'countdown';
  race.countdownLeft = COUNTDOWN_SECONDS;
  race.totalLaps = Number(lapCountSelect.value) || 3;
  race.lap = 0;
  race.nextCheckpoint = 0;
  race.lapTimes = [];
  race.lapTainted = false;
  race.prevX = pos.x;
  race.prevZ = pos.z;
  race.invalidUntil = 0;
  lastCheckpointSpawn = { x: spawnPoint.x, z: spawnPoint.z, heading: spawnHeading };
  resultsEl.classList.add('hidden');
  lapInvalidAlertEl.classList.add('hidden');
  updateRaceHud();
}

function updateRaceHud() {
  if (!race.active) {
    raceHudEl.textContent = 'Nincs rajtvonal — szabad vezetés';
    lapInvalidAlertEl.classList.add('hidden');
    return;
  }
  const now = performance.now();
  const total = race.phase === 'running' ? now - race.startTime
    : race.phase === 'finished' ? race.lapTimes.reduce((a, l) => a + l.time, 0) : 0;
  const current = race.phase === 'running' ? now - race.lapStartTime : 0;
  const validTimes = race.lapTimes.filter((l) => !l.invalid).map((l) => l.time);
  const best = validTimes.length ? Math.min(...validTimes) : NaN;
  raceHudEl.innerHTML =
    `Kör: <strong>${Math.min(race.lap + 1, race.totalLaps)} / ${race.totalLaps}</strong><br>` +
    `Aktuális: ${formatTime(current)}<br>` +
    `Legjobb: ${formatTime(best)}<br>` +
    `Összesen: ${formatTime(total)}`;
  lapInvalidAlertEl.classList.toggle('hidden', now >= race.invalidUntil);
}

function finishRace() {
  race.phase = 'finished';
  // Az összidő MINDEN kört beleszámol, az érvénytelent is — a versenyóra
  // tényleg eltelt időt mér. A "legjobb kör" viszont csak az érvényesek közül
  // számít, egy levágott sarok ne legyen "gyorsabb" mint egy tiszta kör.
  const total = race.lapTimes.reduce((a, l) => a + l.time, 0);
  const validTimes = race.lapTimes.filter((l) => !l.invalid).map((l) => l.time);
  const best = validTimes.length ? Math.min(...validTimes) : NaN;
  resultsBodyEl.innerHTML =
    `<div class="mb-2">Összidő: <strong>${formatTime(total)}</strong></div>` +
    `<div class="mb-3">Legjobb kör: <strong>${formatTime(best)}</strong></div>` +
    race.lapTimes
      .map((l, i) => `<div class="small">${i + 1}. kör: ${formatTime(l.time)}` +
        `${l.invalid ? ' ⚠️ érvénytelen' : (l.time === best ? ' ⭐' : '')}</div>`)
      .join('');
  resultsEl.classList.remove('hidden');
}

function updateRace(dt) {
  if (!race.active) return;

  if (race.phase === 'countdown') {
    race.countdownLeft -= dt;
    if (race.countdownLeft <= 0) {
      race.phase = 'running';
      race.startTime = performance.now();
      race.lapStartTime = race.startTime;
      countdownEl.classList.add('hidden');
    } else {
      countdownEl.classList.remove('hidden');
      countdownEl.textContent = String(Math.ceil(race.countdownLeft));
    }
    return;
  }

  if (race.phase !== 'running') return;

  const pos = chassisBody.translation();
  const fromX = race.prevX, fromZ = race.prevZ;
  race.prevX = pos.x;
  race.prevZ = pos.z;

  const now = performance.now();
  const checkpoints = currentGates.checkpoints;
  const startCrossed = crossedGate(currentGates.start, fromX, fromZ, pos.x, pos.z);

  // Nem csak a soron következő checkpointot nézzük, hanem MINDET — így ha a
  // játékos egyet kihagyott és egy KÉSŐBBI checkpointon megy át, azt azonnal
  // észrevesszük, nem csak akkor, amikor (ha egyáltalán) visszaér a rajtvonalhoz.
  let crossedCheckpoint = -1;
  for (let i = 0; i < checkpoints.length; i++) {
    if (crossedGate(checkpoints[i], fromX, fromZ, pos.x, pos.z)) {
      crossedCheckpoint = i;
      break;
    }
  }

  // A checkpont-ellenőrzés csak azt dönti el, ÉRVÉNYES lesz-e a folyamatban
  // lévő kör — a kört magát mindig a rajtvonal zárja le, akkor is, ha
  // kihagyott valamit. Multiplayerben ez azért fontos, mert így senkinek nem
  // kell egy hibázás miatt a végtelenségig újrázni, míg a többiek várnak rá:
  // a kör egyszerűen "érvénytelen" jelzést kap (a legjobb körbe nem számít
  // bele), de a versenyben tovább halad.
  if (crossedCheckpoint !== -1) {
    lastCheckpointSpawn = {
      x: pos.x,
      z: pos.z,
      heading: headingFromMovement(fromX, fromZ, pos.x, pos.z, lastCheckpointSpawn?.heading ?? spawnHeading),
    };
    if (crossedCheckpoint === race.nextCheckpoint) {
      race.nextCheckpoint++;
    } else {
      // Rossz sorrendű checkpont: valahol kihagyott egyet. Azonnal jelezzük,
      // de hagyjuk tovább menni — a rajtvonalnál dől el, hogy a kör
      // érvénytelen volt.
      race.lapTainted = true;
      race.invalidUntil = now + 2500;
    }
  }

  if (startCrossed) {
    const invalid = race.lapTainted || race.nextCheckpoint < checkpoints.length;
    race.lapTimes.push({ time: now - race.lapStartTime, invalid });
    race.lapStartTime = now;
    race.lap++;
    race.nextCheckpoint = 0;
    race.lapTainted = false;
    if (invalid) race.invalidUntil = now + 2500;
    lastCheckpointSpawn = {
      x: pos.x,
      z: pos.z,
      heading: headingFromMovement(fromX, fromZ, pos.x, pos.z, lastCheckpointSpawn?.heading ?? spawnHeading),
    };
    if (race.lap >= race.totalLaps) finishRace();
  }

  updateRaceHud();
}

// ---------- Irányítás (csak vezetés közben aktív) ----------
const keys = {};
window.addEventListener('keydown', (e) => { keys[e.code] = true; });
window.addEventListener('keyup', (e) => { keys[e.code] = false; });

const maxSteerVal = 0.5;
const maxForce = 900;
const brakeForce = 60;
const ASPHALT_FRICTION_SLIP = 1.4;
// Kifutón (fű/kavics) kevesebb erő jut a talajra és csúszósabb is —
// ettől lesz érezhetően lassabb a pályán kívül.
const OFFTRACK_FORCE_FACTOR = 0.75;
const OFFTRACK_FRICTION_SLIP = 1.0;
const OFFTRACK_DRAG = 0.995;

function updateControls() {
  // Visszaszámlálás alatt és a verseny után nincs gáz/kormány — a kocsi
  // a helyén marad, hogy ne lehessen elrajtolni a "rajt" előtt.
  const frozen = race.active && (race.phase === 'countdown' || race.phase === 'finished');
  const forward = !frozen && (keys['KeyW'] || keys['ArrowUp']);
  const backward = !frozen && (keys['KeyS'] || keys['ArrowDown']);
  const left = !frozen && (keys['KeyA'] || keys['ArrowLeft']);
  const right = !frozen && (keys['KeyD'] || keys['ArrowRight']);
  const brake = frozen || keys['Space'];

  const pos = chassisBody.translation();
  const zone = sampleZoneAt(pos.x, pos.z);
  const offtrack = zone === ZONE_OFFTRACK;
  zoneIndicatorEl.textContent =
    carTouchesWall() ? 'FAL' : offtrack ? 'kifutó (lassít)' : 'aszfalt';
  const forceFactor = offtrack ? OFFTRACK_FORCE_FACTOR : 1;
  const slip = offtrack ? OFFTRACK_FRICTION_SLIP : ASPHALT_FRICTION_SLIP;
  for (let i = 0; i < 4; i++) vehicle.setWheelFrictionSlip(i, slip);
  if (offtrack) {
    const v = chassisBody.linvel();
    chassisBody.setLinvel({ x: v.x * OFFTRACK_DRAG, y: v.y, z: v.z * OFFTRACK_DRAG }, true);
  }

  // A Rapiernél a pozitív motorerő hajt előre (+Z), a cannon-esnél negatív volt.
  const force = (forward ? maxForce : backward ? -maxForce * 0.6 : 0) * forceFactor;
  vehicle.setWheelEngineForce(2, force);
  vehicle.setWheelEngineForce(3, force);

  const steer = left ? maxSteerVal : right ? -maxSteerVal : 0;
  vehicle.setWheelSteering(0, steer);
  vehicle.setWheelSteering(1, steer);

  const b = brake ? brakeForce : 0;
  for (let i = 0; i < 4; i++) vehicle.setWheelBrake(i, b);

  // Az "up" vektor Y-komponense a kasztni forgatásából: 1 = szabályosan áll,
  // 0 = oldalára dőlt, -1 = a tetején van. 0.2 alatt már egyértelműen borulás.
  const q = chassisBody.rotation();
  const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
  const flipped = upY < 0.2;
  if (flipped) {
    rolloverAlertTextEl.textContent = race.active
      ? 'Felborultál! Nyomj R-et — vissza az utolsó checkpontra.'
      : 'Felborultál! Nyomj R-et az újraindításhoz.';
  }
  rolloverAlertEl.classList.toggle('hidden', !flipped);

  if (keys['KeyR']) {
    if (race.active && lastCheckpointSpawn) {
      const groundY = findGroundAt(currentTrack, currentTrackBox, lastCheckpointSpawn.x, lastCheckpointSpawn.z);
      resetCarTo(
        { x: lastCheckpointSpawn.x, y: (groundY ?? pos.y) + 1, z: lastCheckpointSpawn.z },
        lastCheckpointSpawn.heading
      );
    } else {
      resetCarTo(spawnPoint);
    }
  }
}

// ---------- Kamera: vezetős (harmadik személyű követés) ----------
const chaseOffset = new THREE.Vector3(0, 3.5, -7);
const chaseTarget = new THREE.Vector3();

// Jobb-klikkel körbenézés: csak nyomva tartás alatt forgatja el a kamerát
// a kocsihoz képest, elengedéskor animálva (nem azonnal) áll vissza az alap nézetbe.
let manualOrbitActive = false;
let orbitYaw = 0;
let orbitPitch = 0;
let lastMouseX = 0;
let lastMouseY = 0;

renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
renderer.domElement.addEventListener('mousedown', (e) => {
  if (e.button === 2 && appState === 'driving') {
    manualOrbitActive = true;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  }
});
window.addEventListener('mousemove', (e) => {
  if (!manualOrbitActive) return;
  const dx = e.clientX - lastMouseX;
  const dy = e.clientY - lastMouseY;
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
  orbitYaw -= dx * 0.006;
  orbitPitch = Math.max(-0.8, Math.min(0.8, orbitPitch - dy * 0.006));
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 2 && manualOrbitActive) {
    manualOrbitActive = false;
    orbitYaw = 0;
    orbitPitch = 0;
  }
});

function updateChaseCamera() {
  const chassisPos = chassisBody.translation();
  const chassisQuat = chassisBody.rotation();
  const q = new THREE.Quaternion(chassisQuat.x, chassisQuat.y, chassisQuat.z, chassisQuat.w);

  // Csak a kocsi YAW-ját (merre néz felülnézetből) vesszük át — a dőlést és a
  // bukást (pl. borulás közben) szándékosan figyelmen kívül hagyjuk. Enélkül
  // borulásnál a "fel" és "hátra" irány a kocsival együtt fejre áll, és a
  // kamera a föld ALÁ kerülne, onnan nézve felfelé.
  const yawOnly = new THREE.Euler().setFromQuaternion(q, 'YXZ').y;
  const yawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawOnly);

  // A jobb-klikkes körbenézés extra forgatása a kocsi irányához képest.
  const orbitQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(orbitPitch, orbitYaw, 0, 'YXZ'));
  yawQuat.multiply(orbitQuat);

  const desiredOffset = chaseOffset.clone().applyQuaternion(yawQuat);
  const desiredPos = new THREE.Vector3(chassisPos.x, chassisPos.y, chassisPos.z).add(desiredOffset);
  // Biztonsági háló: a kamera sose kerüljön a kocsi alá — sem borulásnál, sem
  // ha valaki lefelé néz körbenézés közben.
  desiredPos.y = Math.max(desiredPos.y, chassisPos.y + 0.5);

  camera.position.lerp(desiredPos, manualOrbitActive ? 0.3 : 0.1);
  chaseTarget.set(chassisPos.x, chassisPos.y + 1, chassisPos.z);
  camera.lookAt(chaseTarget);
}

// ---------- Kamera: menü "kirakat" nézet (lassan körbeforgó) ----------
let showcaseAngle = 0;
function updateShowcaseCamera(dt) {
  showcaseAngle += dt * 0.3;
  const radius = 6.5;
  const height = 2.2;
  const center = carPivot.position;
  camera.position.set(
    center.x + Math.sin(showcaseAngle) * radius,
    center.y + height,
    center.z + Math.cos(showcaseAngle) * radius
  );
  camera.lookAt(center.x, center.y + 0.8, center.z);
}

// ---------- Állapotgép: 'menu' (kirakat) vagy 'driving' (vezetés) ----------
let appState = 'menu';

function enterMenu() {
  appState = 'menu';
  menuEl.classList.remove('hidden');
  hudEl.classList.add('hidden');
  devHudEl.classList.add('hidden');
  carTesterHudEl.classList.add('hidden');
  raceHudWrapEl.classList.add('hidden');
  countdownEl.classList.add('hidden');
  resultsEl.classList.add('hidden');
  race.phase = 'idle';
  scene.fog.density = NORMAL_FOG_DENSITY;
}

function enterDriving() {
  appState = 'driving';
  menuEl.classList.add('hidden');
  hudEl.classList.remove('hidden');
  devHudEl.classList.add('hidden');
  carTesterHudEl.classList.add('hidden');
  raceHudWrapEl.classList.remove('hidden');
  scene.fog.density = NORMAL_FOG_DENSITY;
  // Ha a gombon/legördülőn maradt a fókusz, a szóköz/nyilak azt vezérelnék
  // vezetés helyett — ezért levesszük róla.
  document.activeElement?.blur();
}

resultsMenuBtn.addEventListener('click', enterMenu);
resultsRestartBtn.addEventListener('click', () => {
  resetCarTo(spawnPoint);
  startRace();
});

// ---------- Dev mód: szabad kamera + rajtrács-pontok kijelölése ----------
const devKeys = {};
let devYaw = 0;
let devPitch = 0;
let devSpeed = 8;
const devSpawnMarkers = [];
const devMarkerGeometry = new THREE.SphereGeometry(1.2, 12, 12);
const devMarkerMaterial = new THREE.MeshBasicMaterial({ color: 0xffcc00 });

function enterDevMode() {
  appState = 'dev';
  menuEl.classList.add('hidden');
  hudEl.classList.add('hidden');
  devHudEl.classList.remove('hidden');
  document.activeElement?.blur();
  // Dev módban a köd csak zavarna a pálya nagyobb távolságú áttekintésénél.
  scene.fog.density = 0;

  const center = currentTrackBox
    ? currentTrackBox.getCenter(new THREE.Vector3())
    : new THREE.Vector3();
  const topY = currentTrackBox ? currentTrackBox.max.y + 40 : 40;
  camera.position.set(center.x, topY, center.z);
  devYaw = 0;
  devPitch = -0.5;

  refreshSpawnMarkers();
}

// ---------- Autó tesztelő (dev módból nyitható): a kocsi egy helyben áll a
// rajtponton, a kerekek folyamatosan forognak és A/D-vel (vagy a nyilakkal)
// vizuálisan kormányoznak — így gyorsan végig lehet nézni sok kocsi
// kerekeit anélkül, hogy tényleg vezetni kéne. A W/S (vagy fel/le nyíl) a
// következő/előző kocsira vált a legördülő megnyitása nélkül.
let carTestWheelAngle = 0;
let carTestSwitching = false;
const CARTEST_ROLL_SPEED = 6; // rad/mp — kb. 1 fordulat/mp, jól látható tempó

function carTesterLabel(entry, loading) {
  if (!manifest) return '-';
  const idx = manifest.cars.indexOf(entry);
  const total = manifest.cars.length;
  return `${idx + 1}/${total}: ${entry.label}` + (loading ? ' (betöltés…)' : '');
}

function populateCarTesterSelect() {
  if (!manifest || carTesterCarSelectEl.options.length) return;
  manifest.cars.forEach((entry, idx) => {
    const opt = document.createElement('option');
    opt.value = entry.id;
    opt.textContent = `${idx + 1}/${manifest.cars.length}: ${entry.label}`;
    carTesterCarSelectEl.appendChild(opt);
  });
}

function enterCarTester() {
  if (!manifest) return;
  appState = 'cartest';
  devHudEl.classList.add('hidden');
  carTesterHudEl.classList.remove('hidden');
  carTestWheelAngle = 0;
  // A rajtpont-jelölők kitakarnák a közelről nézett kocsit.
  devSpawnMarkers.forEach((m) => { m.visible = false; });
  populateCarTesterSelect();
  carTesterCarSelectEl.value = carSelect.value;
}

function exitCarTester() {
  carTesterHudEl.classList.add('hidden');
  appState = 'dev';
  devHudEl.classList.remove('hidden');
  devSpawnMarkers.forEach((m) => { m.visible = true; });
}

async function switchCarTestTo(entry) {
  if (!manifest || carTestSwitching || !entry) return;
  carTestSwitching = true;
  carTesterCarSelectEl.disabled = true;
  carSelect.value = entry.id;
  try {
    await setCar('assets/' + entry.file, entry.id, entry.config);
  } finally {
    carTesterCarSelectEl.value = entry.id;
    carTesterCarSelectEl.disabled = false;
    carTestSwitching = false;
  }
}

async function switchCarTestBy(delta) {
  if (!manifest || carTestSwitching) return;
  const list = manifest.cars;
  const currentIdx = list.findIndex((c) => c.id === carSelect.value);
  const nextIdx = ((currentIdx < 0 ? 0 : currentIdx) + delta + list.length) % list.length;
  await switchCarTestTo(list[nextIdx]);
}

function updateCarTest(dt) {
  carTestWheelAngle += dt * CARTEST_ROLL_SPEED;
  const steerLeft = keys['KeyA'] || keys['ArrowLeft'];
  const steerRight = keys['KeyD'] || keys['ArrowRight'];
  const steer = steerLeft ? maxSteerVal : steerRight ? -maxSteerVal : 0;
  for (let i = 0; i < wheelPivots.length; i++) {
    const src = wheelSources[i];
    wheelPivots[i].rotation.set(carTestWheelAngle, src.steer ? steer : 0, 0);
  }
  updateSunTarget(carPivot.position);
  updateShowcaseCamera(dt);
}

carTesterBtn.addEventListener('click', enterCarTester);
carTesterBackBtn.addEventListener('click', exitCarTester);
carTesterCarSelectEl.addEventListener('change', () => {
  const entry = findEntry(manifest.cars, carTesterCarSelectEl.value);
  switchCarTestTo(entry);
});

window.addEventListener('keydown', (e) => {
  if (appState !== 'cartest' || e.repeat) return;
  if (e.code === 'ArrowUp' || e.code === 'KeyW') {
    e.preventDefault();
    switchCarTestBy(-1);
  } else if (e.code === 'ArrowDown' || e.code === 'KeyS') {
    e.preventDefault();
    switchCarTestBy(1);
  } else if (e.code === 'Escape') {
    exitCarTester();
  }
});

// Jobb-klikk + húzás a nézelődéshez — nem pointer lock, hogy az egérmutató
// látható maradjon dev módban (nem tűnik el a képernyőről). A mousedown/
// mouseup PÁROSÍTÁS helyett minden mozgás-eseménynél az aktuális e.buttons
// bitmaszkot nézzük (2 = jobb gomb) — ha egy mouseup esemény elveszik
// (pl. a contextmenu miatt), ez önmagát korrigálja, nem "ragad be" a nézelődés.
let devLastMouseX = 0;
let devLastMouseY = 0;

renderer.domElement.addEventListener('contextmenu', (e) => {
  if (appState === 'dev') e.preventDefault();
});
renderer.domElement.addEventListener('mousedown', (e) => {
  if (appState === 'dev' && e.button === 2) {
    devLastMouseX = e.clientX;
    devLastMouseY = e.clientY;
  }
});
window.addEventListener('mousemove', (e) => {
  const rightButtonHeld = (e.buttons & 2) === 2;
  if (appState !== 'dev' || !rightButtonHeld) {
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

// A 3D jelölő-gömböket mindig a currentSpawnPoints listából építjük újra —
// így a szabad kamerás dev nézetben és a felülnézeti szerkesztőben is
// ugyanaz látszik, bárhonnan is módosítottuk a listát.
function refreshSpawnMarkers() {
  devSpawnMarkers.splice(0).forEach((m) => scene.remove(m));
  if (!currentTrack || !currentTrackBox) return;

  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  currentSpawnPoints.forEach(({ x, z }) => {
    raycaster.set(new THREE.Vector3(x, currentTrackBox.max.y + 20, z), new THREE.Vector3(0, -1, 0));
    const hits = raycaster.intersectObject(currentTrack, true);
    const y = hits.length ? hits[0].point.y : currentTrackBox.min.y;
    const marker = new THREE.Mesh(devMarkerGeometry, devMarkerMaterial);
    marker.position.set(x, y + 1.2, z);
    scene.add(marker);
    devSpawnMarkers.push(marker);
  });
  devSpawnCountEl.textContent = String(currentSpawnPoints.length);
}

window.addEventListener('keydown', (e) => {
  if (appState === 'zone-edit' && e.code === 'Backspace' && isSpawnTool()) {
    e.preventDefault();
    removeLastSpawnPoint();
    return;
  }
  if (appState !== 'dev') return;
  devKeys[e.code] = true;
});
window.addEventListener('keyup', (e) => {
  if (appState === 'dev') devKeys[e.code] = false;
});

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
const zoneOrthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000);
zoneOrthoCam.up.set(0, 0, -1);

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
  zoneSpawnCountEl.textContent = String(currentSpawnPoints.length);
  devSpawnCountEl.textContent = String(currentSpawnPoints.length);
  startLineStateEl.textContent = currentGates.start ? 'kész' : 'nincs';
  checkpointCountEl.textContent = String(currentGates.checkpoints.length);
  guidePointCountEl.textContent = String(currentGuidePath.length);
}

// A rajtpont iránya (heading): az autó "előre" iránya a világ +Z, ezért a
// heading az ettől való elfordulás. atan2(dx, dz) adja meg, hogy a húzás
// irányához mennyit kell fordulni.
function headingFromDelta(dx, dz) {
  return Math.atan2(dx, dz);
}

function addSpawnPointAtWorld(x, z) {
  if (currentSpawnPoints.length >= 8) {
    zoneStatusEl.textContent = 'Már megvan mind a 8 rajtpont.';
    return null;
  }
  const point = { x: +x.toFixed(2), z: +z.toFixed(2), heading: 0 };
  currentSpawnPoints.push(point);
  refreshSpawnMarkers();
  updateSpawnToolUI();
  zoneStatusEl.textContent = '';
  return point;
}

function removeLastSpawnPoint() {
  if (!currentSpawnPoints.length) return;
  currentSpawnPoints.pop();
  refreshSpawnMarkers();
  updateSpawnToolUI();
}

function removeLastGate() {
  if (getSelectedBrush() === 'start') {
    currentGates.start = null;
  } else if (currentGates.checkpoints.length) {
    currentGates.checkpoints.pop();
  }
  updateSpawnToolUI();
}

document.querySelectorAll('input[name="zoneBrush"]').forEach((el) => {
  el.addEventListener('change', updateSpawnToolUI);
});
undoSpawnBtn.addEventListener('click', removeLastSpawnPoint);
undoGateBtn.addEventListener('click', removeLastGate);
clearCheckpointsBtn.addEventListener('click', () => {
  currentGates.checkpoints = [];
  updateSpawnToolUI();
});
undoGuideBtn.addEventListener('click', () => { currentGuidePath.pop(); updateSpawnToolUI(); });
clearGuideBtn.addEventListener('click', () => { currentGuidePath = []; updateSpawnToolUI(); });

function getBrushWorldRadius() {
  return Number(brushSizeRange.value);
}

function updateZoneOrthoCamera() {
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
  zoneOrthoCam.far = (currentTrackBox.max.y - currentTrackBox.min.y) + 500;
  zoneOrthoCam.position.set(zoneView.centerX, currentTrackBox.max.y + 200, zoneView.centerZ);
  zoneOrthoCam.lookAt(zoneView.centerX, currentTrackBox.min.y, zoneView.centerZ);
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
  if (currentGates.start) drawGate(currentGates.start, '#28d17c', 'RAJT');
  currentGates.checkpoints.forEach((g, i) => drawGate(g, '#4aa3ff', 'CP' + (i + 1)));
  if (drawingGate) {
    drawGate(drawingGate, getSelectedBrush() === 'start' ? '#28d17c' : '#4aa3ff', null);
  }

  // Kézzel rajzolt vezetővonal a checkpont-generáláshoz — pontok sorban
  // összekötve, hogy lássa a felhasználó, merre fog "menni" a generálás.
  if (currentGuidePath.length) {
    ctx.beginPath();
    currentGuidePath.forEach((p, i) => {
      const s = toScreen(p.x, p.z);
      if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
    });
    ctx.strokeStyle = '#ffc107';
    ctx.lineWidth = 3;
    ctx.stroke();
    currentGuidePath.forEach((p) => {
      const s = toScreen(p.x, p.z);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ffc107';
      ctx.fill();
    });
  }

  // Rajtrács-pontok sorszámozva — a sorrend számít (ez lesz a rajtsorrend).
  // A tüske mutatja, merre néz majd az autó.
  currentSpawnPoints.forEach((p, idx) => {
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
      currentGuidePath.push({ x, z });
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

let zonePanLast = null;
window.addEventListener('mousemove', (e) => {
  if (appState !== 'zone-edit') return;
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
      if (getSelectedBrush() === 'start') currentGates.start = gate;
      else currentGates.checkpoints.push(gate);
      updateSpawnToolUI();
    }
    drawingGate = null;
  }
});

// Görgő = zoom, a kurzor alatti világpont a helyén marad.
zoneOverlayCanvas.addEventListener(
  'wheel',
  (e) => {
    if (appState !== 'zone-edit') return;
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

function enterZoneEditor() {
  if (!currentTrack || !currentTrackBox) return;
  previousAppStateBeforeZone = appState;
  appState = 'zone-edit';

  const box = currentTrackBox;
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
  appState = previousAppStateBeforeZone;
  if (appState === 'dev') {
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
  const entry = manifest && findEntry(manifest.maps, currentMapId);
  if (!entry || !entry.zonemap) return;
  const img = new Image();
  img.onload = () => ctx.drawImage(img, 0, 0, zoneMaskCanvas.width, zoneMaskCanvas.height);
  img.src = 'assets/' + entry.zonemap.file + '?t=' + Date.now();
}

// A "Mentés" gomb a zóna-maszkot ÉS a rajtrács-pontokat is kiírja — egy
// helyen szerkesztjük őket, így egy gombbal is mentődjenek.
function saveSpawnPoints() {
  if (!currentMapId || !currentSpawnPoints.length) return Promise.resolve(null);
  return fetch('assets/save_spawn.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapId: currentMapId, spawns: currentSpawnPoints }),
  }).then((res) => res.json());
}

function saveGates() {
  if (!currentMapId) return Promise.resolve(null);
  if (!currentGates.start && !currentGates.checkpoints.length) return Promise.resolve(null);
  return fetch('assets/save_gates.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mapId: currentMapId,
      start: currentGates.start,
      checkpoints: currentGates.checkpoints,
    }),
  }).then((res) => res.json());
}

function saveZoneMap() {
  if (!currentMapId || !zoneMaskCanvas) return;
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
      fetch('assets/save_zonemap.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mapId: currentMapId,
          pngBase64: reader.result,
          bounds: zoneBounds,
          texW: zoneMaskCanvas.width,
          texH: zoneMaskCanvas.height,
        }),
      })
        .then((res) => res.json())
        .then((data) => {
          zoneStatusEl.textContent = data.ok
            ? `Elmentve (zóna + ${currentSpawnPoints.length} rajtpont + ${currentGates.checkpoints.length} CP${currentGates.start ? ' + rajtvonal' : ''}).`
            : 'Hiba: ' + (data.error || 'ismeretlen');
          if (data.ok) {
            // A manifestet is frissítjük, hogy a mentett zóna azonnal életbe
            // lépjen a vezetésben, oldal-újratöltés nélkül.
            const entry = manifest && findEntry(manifest.maps, currentMapId);
            if (entry) {
              entry.zonemap = {
                file: `maps/${currentMapId}/zonemap.png`,
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
  if (!zoneMaskCanvas || !currentGates.start) {
    zoneStatusEl.textContent = 'Előbb kell rajtvonal és aszfalt-térkép.';
    return;
  }
  if (!currentSpawnPoints.length) {
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
  const g = currentGates.start;
  let x = (g.x1 + g.x2) / 2, z = (g.z1 + g.z2) / 2;
  const gx = g.x2 - g.x1, gz = g.z2 - g.z1;
  const glen = Math.hypot(gx, gz) || 1;
  let dirX = -gz / glen, dirZ = gx / glen;
  const heading = currentSpawnPoints[0].heading || 0;
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
  if (currentGuidePath.length >= 2) {
    path = [];
    let arc = 0;
    let prevX = null, prevZ = null;
    for (let i = 0; i < currentGuidePath.length - 1; i++) {
      const a = currentGuidePath[i], b = currentGuidePath[i + 1];
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
    zoneStatusEl.textContent = currentGuidePath.length >= 2
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

  currentGates.checkpoints = checkpoints;
  updateSpawnToolUI();
  if (currentGuidePath.length >= 2) {
    zoneStatusEl.textContent = `${checkpoints.length} checkpoint legenerálva a vezetővonal alapján.`;
  } else {
    zoneStatusEl.textContent = closed
      ? `${checkpoints.length} checkpoint legenerálva (a bejárás visszaért a rajtvonalhoz).`
      : `${checkpoints.length} checkpoint legenerálva, de a bejárás NEM ért vissza a rajtvonalhoz (elakadt kb. itt: ${x.toFixed(0)}, ${z.toFixed(0)}) — nézd át kézzel.`;
  }
}

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
  if (appState === 'zone-edit') resizeZoneOverlayCanvas();
});

startBtn.addEventListener('click', async () => {
  if (!currentTrack || !currentTrackBox) return;
  startBtn.disabled = true;
  setMenuStatus('Pálya fizika előkészítése...');

  try {
    // Ha van előre bekészített ütközési fájl, azt használjuk — ez a mérvadó
    // a multiplayerhez, mert így minden kliens BITRE ugyanazt a geometriát
    // kapja. Ha nincs, futásidőben nyerjük ki a modellből (ez is gyors).
    const mesh = await loadOrExtractCollision();
    applyTrackCollider(mesh.positions, mesh.indices);

    const { data, elementSize } = buildVisualFloorGrid(currentTrack, currentTrackBox);
    buildContourFloorMesh(data, elementSize, currentTrackBox, 3);

    // Épp csak a nyugalmi magasság fölé tesszük a kocsit (kerék sugara +
    // felfüggesztés + fél kasztni ~0.9), hogy egy nagy zuhanás ne verje bele
    // a dobozt a vékony háromszöghálóba.
    const SPAWN_HEIGHT = 1.0;
    const slot = pickSpawnSlot(currentSpawnPoints);
    if (slot) {
      const y = findGroundAt(currentTrack, currentTrackBox, slot.x, slot.z);
      spawnPoint.set(slot.x, (y ?? currentTrackBox.max.y) + SPAWN_HEIGHT, slot.z);
      spawnHeading = slot.heading || 0;
    } else {
      const spot = findShowcaseSpot(currentTrack, currentTrackBox, null);
      spawnPoint.copy(spot).add(new THREE.Vector3(0, SPAWN_HEIGHT, 0));
      spawnHeading = 0;
    }
    resetCarTo(spawnPoint);

    setStatus(`Ütközés: ${mesh.indices.length / 3} háromszög (${mesh.source})`);
    setMenuStatus('');
    startRace();
    enterDriving();
  } catch (err) {
    console.error('Fizika előkészítése sikertelen', err);
    setMenuStatus('Hiba a fizika előkészítésekor: ' + err.message);
  } finally {
    startBtn.disabled = false;
  }
});

// Bekészített ütközési fájl betöltése, ha van; különben kinyerés a modellből.
async function loadOrExtractCollision() {
  const entry = manifest && findEntry(manifest.maps, currentMapId);
  if (entry && entry.collision) {
    try {
      const res = await fetch('assets/' + entry.collision.file + '?t=' + Date.now());
      if (res.ok) {
        const buf = await res.arrayBuffer();
        const view = new DataView(buf);
        const vertexCount = view.getUint32(0, true);
        const indexCount = view.getUint32(4, true);
        const positions = new Float32Array(buf, 8, vertexCount * 3);
        const indices = new Uint32Array(buf, 8 + vertexCount * 12, indexCount);
        return { positions, indices, source: 'fájlból' };
      }
    } catch (err) {
      console.warn('Bekészített ütközési fájl nem tölthető, visszaesés kinyerésre', err);
    }
  }
  const mesh = extractDrivableTriangles(currentTrack);
  return { ...mesh, source: 'modellből' };
}

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
  if (!currentTrack || !currentMapId) return;
  bakeStatusEl.textContent = 'Kinyerés...';
  await new Promise((r) => setTimeout(r, 0)); // hadd frissüljön a felirat

  const raw = extractDrivableTriangles(currentTrack);
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
    const res = await fetch('assets/save_collision.php?mapId=' + encodeURIComponent(currentMapId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buffer,
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'ismeretlen hiba');

    // A manifestet is frissítjük, hogy azonnal a fájl legyen érvényben.
    const entry = manifest && findEntry(manifest.maps, currentMapId);
    if (entry) entry.collision = { file: `maps/${currentMapId}/collision.bin`, bytes: data.bytes };

    bakeStatusEl.textContent =
      `Kész: ${data.triangles} háromszög, ${(data.bytes / 1048576).toFixed(1)} MB ` +
      `(${raw.positions.length / 3} → ${vertexCount} csúcs)`;
  } catch (err) {
    bakeStatusEl.textContent = 'Hiba: ' + err.message;
  }
}

bakeCollisionBtn.addEventListener('click', bakeCollisionToFile);

backToMenuLink.addEventListener('click', () => {
  enterMenu();
});

// ---------- Menü UI: assets/list.php betöltése és a select-ek feltöltése ----------
let manifest = null;

function fillSelect(selectEl, items) {
  selectEl.innerHTML = '';
  items.forEach((item) => {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = item.label;
    selectEl.appendChild(opt);
  });
}

function findEntry(list, id) {
  return list.find((item) => item.id === id) || list[0];
}

async function init() {
  const res = await fetch('assets/list.php');
  if (!res.ok) throw new Error('assets/list.php HTTP ' + res.status);
  manifest = await res.json();

  if (!manifest.maps.length || !manifest.cars.length || !manifest.skyboxes.length) {
    setMenuStatus('Hiányzó assetek (pálya/kocsi/környezet) az assets mappában.');
    return;
  }

  fillSelect(mapSelect, manifest.maps);
  fillSelect(carSelect, manifest.cars);
  fillSelect(envSelect, manifest.skyboxes);
  fillSelect(devMapSelectEl, manifest.maps);

  const initialMap = findEntry(manifest.maps, null);
  const initialCar = findEntry(manifest.cars, null);
  const initialEnv = findEntry(manifest.skyboxes, null);
  mapSelect.value = initialMap.id;
  carSelect.value = initialCar.id;
  envSelect.value = initialEnv.id;
  devMapSelectEl.value = initialMap.id;

  await Promise.all([
    setSkybox('assets/' + initialEnv.file),
    setTrack('assets/' + initialMap.file, initialMap.id, initialMap.spawns, initialMap.gates),
    setCar('assets/' + initialCar.file, initialCar.id, initialCar.config),
  ]);

  mapSelect.disabled = false;
  carSelect.disabled = false;
  envSelect.disabled = false;
  startBtn.disabled = false;
  loadingEl.style.display = 'none';
  if (DEV_MODE) {
    enterDevMode();
  } else {
    enterMenu();
  }

  mapSelect.addEventListener('change', () => {
    const entry = findEntry(manifest.maps, mapSelect.value);
    setTrack('assets/' + entry.file, entry.id, entry.spawns, entry.gates);
  });
  carSelect.addEventListener('change', () => {
    const entry = findEntry(manifest.cars, carSelect.value);
    setCar('assets/' + entry.file, entry.id, entry.config);
  });
  envSelect.addEventListener('change', () => {
    const entry = findEntry(manifest.skyboxes, envSelect.value);
    setSkybox('assets/' + entry.file);
  });

  devMapSelectEl.addEventListener('change', async () => {
    const entry = findEntry(manifest.maps, devMapSelectEl.value);
    mapSelect.value = entry.id;
    devSpawnStatusEl.textContent = 'Pálya betöltése...';
    await setTrack('assets/' + entry.file, entry.id, entry.spawns, entry.gates);
    enterDevMode();
    devSpawnStatusEl.textContent = '';
  });
}

init().catch((err) => {
  console.error('Init error', err);
  loadingEl.textContent = 'Hiba az indításkor: ' + err.message;
});

// ---------- Fő ciklus ----------
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);

  if (appState === 'driving') {
    updateControls();
    // A Rapiernél a jármű-vezérlőt a világ léptetése ELŐTT kell frissíteni:
    // ez lövi ki a kerék-sugarakat és számolja a felfüggesztés/tapadás erőket.
    vehicle.updateVehicle(world.timestep);
    world.step();
    applyWallConstraint();
    calibrateGroundOffset();
    updateRace(dt);

    if (carLoaded) {
      const p = chassisBody.translation();
      const q = chassisBody.rotation();
      carPivot.position.set(p.x, p.y, p.z);
      carPivot.quaternion.set(q.x, q.y, q.z, q.w);
      updateSunTarget(carPivot.position);
      updateWheelVisuals();
    }

    updateChaseCamera();
  } else if (appState === 'dev') {
    updateDevCamera(dt);
  } else if (appState === 'cartest') {
    updateCarTest(dt);
  } else if (appState === 'zone-edit') {
    // A pálya élőben, valódi 3D geometriaként renderelődik felülnézetből —
    // ezért marad éles bármilyen zoomon, szemben egy fix felbontású képpel.
    updateZoneOrthoCamera();
    renderer.render(scene, zoneOrthoCam);
    drawZoneOverlay();
    return;
  } else {
    updateSunTarget(carPivot.position);
    updateShowcaseCamera(dt);
  }

  renderer.render(scene, camera);
}

animate();

window.__debug = {
  RAPIER, THREE,
  chassisBody, chassisCollider, vehicle, world, carPivot, camera,
  // Ezeket a setTrack újra értékül adja, ezért getterként kell kitenni —
  // egy egyszerű másolat elavulna pályaváltáskor.
  get currentSpawnPoints() { return currentSpawnPoints; },
  get currentGates() { return currentGates; },
  get currentTrackBox() { return currentTrackBox; },
  race, updateRace, crossedGate,
  getTrackCollider: () => trackCollider,
  zone: {
    getMask: () => zoneMaskCanvas, getBounds: () => zoneBounds, getView: () => zoneView,
    screenToWorld: zoneScreenToWorld, worldToMask: zoneWorldToMaskPixel,
    setRuntime: (z) => { zoneRuntime = z; }, sampleAt: sampleZoneAt, touchesWall: carTouchesWall,
    applyWall: applyWallConstraint, lastSafe: lastSafePos,
    getGuidePath: () => currentGuidePath, setGuidePath: (p) => { currentGuidePath = p; updateSpawnToolUI(); },
    generateCheckpoints,
  },
};
