import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import * as CANNON from 'cannon-es';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// Az autó "hossz-tengelyét" (X vagy Z) automatikusan felismerjük, de hogy a
// modell eleje pontosan melyik irányba néz az adott tengely mentén, az
// exportálástól/forrástól függ — ez modellenként eltérő lehet. Ha egy adott
// kocsi fordítva (hátrafelé) néz vezetés közben, vedd fel ide a kocsi id-ját
// (az assets/cars/<id>.glb fájlnév kiterjesztés nélkül) Math.PI értékkel.
const CAR_YAW_OVERRIDES = {
  '2001_bmw_m3_gtr_e46': Math.PI,
};

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
const openZoneEditorBtn = document.getElementById('openZoneEditorBtn');
const closeZoneEditorBtn = document.getElementById('closeZoneEditorBtn');
const saveZoneBtn = document.getElementById('saveZoneBtn');
const zoneEditorEl = document.getElementById('zoneEditor');
const zoneOverlayCanvas = document.getElementById('zoneOverlayCanvas');
const zoneStatusEl = document.getElementById('zoneStatus');
const brushSizeRange = document.getElementById('brushSizeRange');
const brushSizeLabel = document.getElementById('brushSizeLabel');
const zoneIndicatorEl = document.getElementById('zoneIndicator');
const brushSizeRow = document.getElementById('brushSizeRow');
const spawnToolRow = document.getElementById('spawnToolRow');
const zoneSpawnCountEl = document.getElementById('zoneSpawnCount');
const undoSpawnBtn = document.getElementById('undoSpawnBtn');

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

// ---------- Cannon-es fizika világ ----------
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
world.defaultContactMaterial.friction = 0.3;

const groundMaterial = new CANNON.Material('ground');
const wheelMaterial = new CANNON.Material('wheel');
const wheelGroundContact = new CANNON.ContactMaterial(groundMaterial, wheelMaterial, {
  friction: 0.6,
  restitution: 0,
  contactEquationStiffness: 1000,
});
world.addContactMaterial(wheelGroundContact);

// Biztonsági "aljzat" — arra kell, hogy a kocsi ne essen a végtelenségig, ha
// kicsúszik a magasságtérkép lefedett területéről, VAGY ha a pálya modelljén
// lévő lyukon esik át. Csak pár egységgel a pálya legalja alatt van, hogy ne
// egy láthatatlan mélységbe zuhanjon az autó, hanem szinte azonnal elkapja
// egy sötétszürke "padló", ami takarja a lyukakat.
const safetyNetBody = new CANNON.Body({ mass: 0, material: groundMaterial });
safetyNetBody.addShape(new CANNON.Plane());
safetyNetBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
world.addBody(safetyNetBody);

const safetyFloorMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(6000, 6000),
  new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 1, metalness: 0, side: THREE.DoubleSide })
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
let heightfieldBody = null;

// ---------- Autó (chassis + raycast vehicle) ----------
const chassisSize = new CANNON.Vec3(1.0, 0.4, 2.2); // fél-méretek: szélesség/2, magasság/2, hossz/2
const chassisShape = new CANNON.Box(chassisSize);
const chassisBody = new CANNON.Body({ mass: 250, material: groundMaterial });
chassisBody.addShape(chassisShape);
chassisBody.position.set(0, 5, 0);
chassisBody.angularVelocity.set(0, 0, 0);

const vehicle = new CANNON.RaycastVehicle({
  chassisBody,
  indexRightAxis: 0,
  indexUpAxis: 1,
  indexForwardAxis: 2,
});

const wheelOptions = {
  radius: 0.35,
  directionLocal: new CANNON.Vec3(0, -1, 0),
  suspensionStiffness: 30,
  suspensionRestLength: 0.3,
  frictionSlip: 1.4,
  dampingRelaxation: 2.3,
  dampingCompression: 4.4,
  maxSuspensionForce: 100000,
  rollInfluence: 0.01,
  axleLocal: new CANNON.Vec3(1, 0, 0),
  chassisConnectionPointLocal: new CANNON.Vec3(1, 0, 1),
  maxSuspensionTravel: 0.3,
  customSlidingRotationalSpeed: -30,
  useCustomSlidingRotationalSpeed: true,
};

const wheelPositions = [
  new CANNON.Vec3(-0.85, -0.2, 1.5),  // első bal
  new CANNON.Vec3(0.85, -0.2, 1.5),   // első jobb
  new CANNON.Vec3(-0.85, -0.2, -1.5), // hátsó bal
  new CANNON.Vec3(0.85, -0.2, -1.5),  // hátsó jobb
];
wheelPositions.forEach((pos) => {
  const opts = { ...wheelOptions, chassisConnectionPointLocal: pos };
  vehicle.addWheel(opts);
});
vehicle.addToWorld(world);

const wheelBodies = [];
vehicle.wheelInfos.forEach(() => {
  const body = new CANNON.Body({ mass: 0, material: wheelMaterial });
  body.type = CANNON.Body.KINEMATIC;
  body.collisionFilterGroup = 0;
  wheelBodies.push(body);
  world.addBody(body);
});

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
let currentTrack = null;
let currentTrackBox = null;
let currentMapId = null;
// A pálya kézi rajtrács-pontjai (assets/maps/<id>/spawn.json-ból, max 8),
// a jövőbeli multiplayerhez előkészítve — egyelőre mindig az első szabad
// (üresnek tekintett) pontot használjuk, mert még nincs több játékos.
let currentSpawnPoints = [];

function pickSpawnSlot(spawnPoints, occupiedIndices = []) {
  if (!spawnPoints || !spawnPoints.length) return null;
  const freeIndex = spawnPoints.findIndex((_, idx) => !occupiedIndices.includes(idx));
  const chosen = spawnPoints[freeIndex >= 0 ? freeIndex : 0];
  return { x: chosen.x, z: chosen.z };
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

async function setTrack(trackUrl, mapId, spawnPoints) {
  setMenuStatus('Pálya betöltése...');
  currentMapId = mapId || null;
  currentSpawnPoints = spawnPoints || [];

  if (heightfieldBody) {
    world.removeBody(heightfieldBody);
    heightfieldBody = null;
  }
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
  safetyNetBody.position.set(0, floorY, 0);

  const spot = findShowcaseSpot(track, currentTrackBox, pickSpawnSlot(currentSpawnPoints));
  spawnPoint.copy(spot).add(new THREE.Vector3(0, 2, 0));
  carPivot.position.copy(spot);
  chassisBody.position.copy(spawnPoint);
  lastSafePos.copy(spawnPoint);

  // A pályához tartozó zóna-térkép (ha van) betöltése a vezetéshez.
  await loadZoneRuntime(manifest && findEntry(manifest.maps, mapId));

  setMenuStatus('');
}

async function setCar(carUrl, carId) {
  setMenuStatus('Kocsi betöltése...');

  carLoaded = false;
  // Csak a korábbi karosszéria-modellt dobjuk el — a fényszórók (és a
  // célpontjaik) szintén a carPivot gyerekei, azokat meg kell tartani.
  if (currentCarModel) {
    carPivot.remove(currentCarModel);
    disposeObject3D(currentCarModel);
    currentCarModel = null;
  }

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
  const box = new THREE.Box3().setFromObject(carRoot);
  const size = new THREE.Vector3();
  box.getSize(size);
  const extraYaw = CAR_YAW_OVERRIDES[carId] || 0;
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

  // Végül a modellt a saját aljához igazítjuk, hogy a kerekek a chassis alján legyenek.
  const box3 = new THREE.Box3().setFromObject(carRoot);
  carRoot.position.y = -box3.min.y - chassisSize.y;

  carPivot.add(carRoot);
  currentCarModel = carRoot;
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

// Aszinkron, darabolt sugárvetés-alapú magasságtérkép építése a pálya vizuális
// geometriájából. A cél: a fizikai "talaj" kövesse a pálya tényleges felszínét
// (lejtők, hidak stb.), ne egy sík legyen alatta/felette. Csak Indításkor fut le.
//
// Két javítás a korábbi (egylépéses, teljes bbox-ra szétosztott) verzióhoz
// képest:
// 1. A fenti fedettségi maszk alapján kihagyjuk a raycastelést azokon a
//    finom rácspontokon, ahol úgysincs semmi — így ugyanannyi idő alatt
//    sokkal sűrűbb (kisebb elementSize) rácsot engedhetünk meg magunknak.
// 2. Minden rácsponton nem csak az ELSŐ találatot vesszük, hanem az összes,
//    közeli (a legfelsőhöz képest kis magasság-különbségen belüli) találat
//    KÖZÜL A LEGALACSONYABBAT — ez kiküszöböli, hogy a sugár hol a vékony
//    gumicsík-overlay-t, hol magát az utat találja el elsőként (ami eddig a
//    "hol fölötte lebeg, hol beleolvad" ingadozást okozta).
function buildTrackHeightfield(track, box, onDone, preferXZ) {
  const prefX = preferXZ ? preferXZ.x : 0;
  const prefZ = preferXZ ? preferXZ.z : 0;
  track.traverse((obj) => {
    if (obj.isMesh && obj.geometry) {
      obj.geometry.computeBoundsTree();
    }
  });

  const coverage = buildCoverageMask(track, box, 2048);

  const sizeX = box.max.x - box.min.x;
  const sizeZ = box.max.z - box.min.z;

  // Cél: kb. 5 egységes rácsméret, de időkorlát miatt legfeljebb ~250 000
  // ténylegesen elraycastelt pont (a fedettségi maszk sokat kihagy ebből).
  const TARGET_ELEMENT_SIZE = 5;
  const MAX_SAMPLES = 250000;
  let elementSize = Math.max(1.5, TARGET_ELEMENT_SIZE);
  let nx = Math.max(2, Math.ceil(sizeX / elementSize) + 1);
  let nz = Math.max(2, Math.ceil(sizeZ / elementSize) + 1);
  if (nx * nz > MAX_SAMPLES * 6) {
    // Ha a maszk becsülhetően nem hagyna ki eleget (pl. nagyon tömör pálya),
    // durvítunk, nehogy irreálisan sokáig fusson.
    const scale = Math.sqrt((nx * nz) / (MAX_SAMPLES * 6));
    elementSize *= scale;
    nx = Math.max(2, Math.ceil(sizeX / elementSize) + 1);
    nz = Math.max(2, Math.ceil(sizeZ / elementSize) + 1);
  }

  const data = [];
  for (let i = 0; i < nx; i++) data.push(new Array(nz).fill(box.min.y - 50));

  const dir = new THREE.Vector3(0, -1, 0);
  const rayOriginY = box.max.y + 20;
  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = false; // kellenek a közeli, egymáshoz képest kicsit eltolt találatok is
  const overlayBand = 1.5; // ekkora magasság-különbségen belüli találatok "ugyanaz a felszín"

  let bestDist = Infinity;
  let bestPoint = null;

  let i = 0;
  const BATCH = 250;

  function step() {
    const end = Math.min(nx, i + Math.ceil(BATCH / nz) + 1);
    for (; i < end; i++) {
      const worldX = box.min.x + i * elementSize;
      for (let j = 0; j < nz; j++) {
        const worldZ = box.max.z - j * elementSize;
        if (!maskHasCoverage(coverage, worldX, worldZ)) continue;
        raycaster.set(new THREE.Vector3(worldX, rayOriginY, worldZ), dir);
        const hits = raycaster.intersectObject(track, true);
        if (hits.length) {
          const topY = hits[0].point.y;
          let y = topY;
          for (const h of hits) {
            if (topY - h.point.y > overlayBand) break; // ez már egy külön (pl. híd alatti) réteg
            if (h.point.y < y) y = h.point.y;
          }
          data[i][j] = y;
          const d = (worldX - prefX) ** 2 + (worldZ - prefZ) ** 2;
          if (d < bestDist) {
            bestDist = d;
            bestPoint = { x: worldX, y, z: worldZ };
          }
        }
      }
    }

    setMenuStatus(`Pálya fizika építése... ${Math.round((i / nx) * 100)}%`);

    if (i < nx) {
      setTimeout(step, 0);
    } else {
      onDone({ data, elementSize, spawn: bestPoint, box });
    }
  }

  step();
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
  const q = chassisBody.quaternion;
  _probeQuat.set(q.x, q.y, q.z, q.w);
  for (const local of wallProbeLocal) {
    _probeVec.copy(local).applyQuaternion(_probeQuat);
    const x = chassisBody.position.x + _probeVec.x;
    const z = chassisBody.position.z + _probeVec.z;
    if (sampleZoneAt(x, z) === ZONE_WALL) return true;
  }
  return false;
}

// Láthatatlan fal: nem építünk hozzá ütköző-geometriát, hanem ha a kocsi
// falcellába kerül, visszatesszük az utolsó érvényes helyre, és csak a falba
// MUTATÓ sebesség-komponenst vesszük el — így a fal mentén tovább lehet
// csúszni, nem ragad meg és nem pattan vissza.
function applyWallConstraint() {
  const pos = chassisBody.position;
  if (!carTouchesWall()) {
    lastSafePos.set(pos.x, pos.y, pos.z);
    return;
  }

  const dx = pos.x - lastSafePos.x;
  const dz = pos.z - lastSafePos.z;
  const len = Math.hypot(dx, dz);
  pos.x = lastSafePos.x;
  pos.z = lastSafePos.z;

  if (len > 1e-4) {
    const nx = dx / len;
    const nz = dz / len;
    const v = chassisBody.velocity;
    const into = v.x * nx + v.z * nz;
    if (into > 0) {
      v.x -= into * nx;
      v.z -= into * nz;
    }
    v.x *= 0.85;
    v.z *= 0.85;
  }
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
  const forward = keys['KeyW'] || keys['ArrowUp'];
  const backward = keys['KeyS'] || keys['ArrowDown'];
  const left = keys['KeyA'] || keys['ArrowLeft'];
  const right = keys['KeyD'] || keys['ArrowRight'];
  const brake = keys['Space'];

  const zone = sampleZoneAt(chassisBody.position.x, chassisBody.position.z);
  const offtrack = zone === ZONE_OFFTRACK;
  zoneIndicatorEl.textContent =
    carTouchesWall() ? 'FAL' : offtrack ? 'kifutó (lassít)' : 'aszfalt';
  const forceFactor = offtrack ? OFFTRACK_FORCE_FACTOR : 1;
  const slip = offtrack ? OFFTRACK_FRICTION_SLIP : ASPHALT_FRICTION_SLIP;
  vehicle.wheelInfos.forEach((w) => { w.frictionSlip = slip; });
  if (offtrack) {
    chassisBody.velocity.x *= OFFTRACK_DRAG;
    chassisBody.velocity.z *= OFFTRACK_DRAG;
  }

  const force = (forward ? -maxForce : backward ? maxForce * 0.6 : 0) * forceFactor;
  vehicle.applyEngineForce(force, 2);
  vehicle.applyEngineForce(force, 3);

  const steer = left ? maxSteerVal : right ? -maxSteerVal : 0;
  vehicle.setSteeringValue(steer, 0);
  vehicle.setSteeringValue(steer, 1);

  const b = brake ? brakeForce : 0;
  for (let i = 0; i < 4; i++) vehicle.setBrake(b, i);

  if (keys['KeyR']) {
    chassisBody.position.copy(spawnPoint);
    chassisBody.velocity.set(0, 0, 0);
    chassisBody.angularVelocity.set(0, 0, 0);
    chassisBody.quaternion.set(0, 0, 0, 1);
    lastSafePos.copy(spawnPoint);
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
  const chassisPos = chassisBody.position;
  const chassisQuat = chassisBody.quaternion;
  const q = new THREE.Quaternion(chassisQuat.x, chassisQuat.y, chassisQuat.z, chassisQuat.w);

  // A jobb-klikkes körbenézés extra forgatása a kocsi irányához képest.
  const orbitQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(orbitPitch, orbitYaw, 0, 'YXZ'));
  q.multiply(orbitQuat);

  const desiredOffset = chaseOffset.clone().applyQuaternion(q);
  const desiredPos = new THREE.Vector3(chassisPos.x, chassisPos.y, chassisPos.z).add(desiredOffset);

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
  scene.fog.density = NORMAL_FOG_DENSITY;
}

function enterDriving() {
  appState = 'driving';
  menuEl.classList.add('hidden');
  hudEl.classList.remove('hidden');
  devHudEl.classList.add('hidden');
  scene.fog.density = NORMAL_FOG_DENSITY;
  // Ha a gombon/legördülőn maradt a fókusz, a szóköz/nyilak azt vezérelnék
  // vezetés helyett — ezért levesszük róla.
  document.activeElement?.blur();
}

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

function updateSpawnToolUI() {
  const spawnMode = isSpawnTool();
  brushSizeRow.classList.toggle('d-none', spawnMode);
  spawnToolRow.classList.toggle('d-none', !spawnMode);
  zoneSpawnCountEl.textContent = String(currentSpawnPoints.length);
  devSpawnCountEl.textContent = String(currentSpawnPoints.length);
}

function addSpawnPointAtWorld(x, z) {
  if (currentSpawnPoints.length >= 8) {
    zoneStatusEl.textContent = 'Már megvan mind a 8 rajtpont.';
    return;
  }
  currentSpawnPoints.push({ x: +x.toFixed(2), z: +z.toFixed(2) });
  refreshSpawnMarkers();
  updateSpawnToolUI();
  zoneStatusEl.textContent = '';
}

function removeLastSpawnPoint() {
  if (!currentSpawnPoints.length) return;
  currentSpawnPoints.pop();
  refreshSpawnMarkers();
  updateSpawnToolUI();
}

document.querySelectorAll('input[name="zoneBrush"]').forEach((el) => {
  el.addEventListener('change', updateSpawnToolUI);
});
undoSpawnBtn.addEventListener('click', removeLastSpawnPoint);

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

  // Rajtrács-pontok sorszámozva — a sorrend számít (ez lesz a rajtsorrend).
  currentSpawnPoints.forEach((p, idx) => {
    const s = toScreen(p.x, p.z);
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

zoneOverlayCanvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) {
    const { x, z } = zoneScreenToWorld(e.clientX, e.clientY);
    if (isSpawnTool()) {
      addSpawnPointAtWorld(x, z);
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

function saveZoneMap() {
  if (!currentMapId || !zoneMaskCanvas) return;
  zoneStatusEl.textContent = 'Mentés...';
  saveSpawnPoints().catch((err) => {
    zoneStatusEl.textContent = 'Rajtpont mentési hiba: ' + err.message;
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
            ? `Elmentve (zóna + ${currentSpawnPoints.length} rajtpont).`
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

openZoneEditorBtn.addEventListener('click', enterZoneEditor);
closeZoneEditorBtn.addEventListener('click', exitZoneEditor);
saveZoneBtn.addEventListener('click', saveZoneMap);
brushSizeRange.addEventListener('input', () => {
  brushSizeLabel.textContent = brushSizeRange.value;
});
window.addEventListener('resize', () => {
  if (appState === 'zone-edit') resizeZoneOverlayCanvas();
});

startBtn.addEventListener('click', () => {
  if (!currentTrack || !currentTrackBox) return;
  startBtn.disabled = true;

  if (heightfieldBody) {
    world.removeBody(heightfieldBody);
    heightfieldBody = null;
  }

  buildTrackHeightfield(currentTrack, currentTrackBox, ({ data, elementSize, spawn, box }) => {
    const heightfieldShape = new CANNON.Heightfield(data, { elementSize });
    heightfieldBody = new CANNON.Body({ mass: 0, material: groundMaterial });
    heightfieldBody.addShape(heightfieldShape);
    // A heightfield helyi (x=i*elementSize, y=j*elementSize, z=magasság) rendszerét
    // -90 fokkal elforgatva Y-up világba állítjuk: worldX = pos.x + i*elementSize,
    // worldZ = pos.z - j*elementSize, worldY = pos.y + data[i][j].
    // FONTOS: a "box" itt a durva letapogatással megtalált, SZŰKÍTETT pálya-sáv
    // (nem feltétlen ugyanaz, mint currentTrackBox), mert a data-tömb ehhez a
    // szűkebb sávhoz igazodik.
    heightfieldBody.position.set(box.min.x, 0, box.max.z);
    heightfieldBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(heightfieldBody);

    buildContourFloorMesh(data, elementSize, box, 3);

    if (spawn) {
      spawnPoint.set(spawn.x, spawn.y + 2, spawn.z);
    } else {
      spawnPoint.set(0, currentTrackBox.max.y + 2, 0);
    }
    chassisBody.position.copy(spawnPoint);
    chassisBody.velocity.set(0, 0, 0);
    chassisBody.angularVelocity.set(0, 0, 0);
    chassisBody.quaternion.set(0, 0, 0, 1);

    setStatus(`Pálya fizika: ${data.length}x${data[0].length} pont, elementSize=${elementSize.toFixed(2)}`);
    setMenuStatus('');
    startBtn.disabled = false;
    enterDriving();
  }, pickSpawnSlot(currentSpawnPoints));
});

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
    setTrack('assets/' + initialMap.file, initialMap.id, initialMap.spawns),
    setCar('assets/' + initialCar.file, initialCar.id),
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
    setTrack('assets/' + entry.file, entry.id, entry.spawns);
  });
  carSelect.addEventListener('change', () => {
    const entry = findEntry(manifest.cars, carSelect.value);
    setCar('assets/' + entry.file, entry.id);
  });
  envSelect.addEventListener('change', () => {
    const entry = findEntry(manifest.skyboxes, envSelect.value);
    setSkybox('assets/' + entry.file);
  });

  devMapSelectEl.addEventListener('change', async () => {
    const entry = findEntry(manifest.maps, devMapSelectEl.value);
    mapSelect.value = entry.id;
    devSpawnStatusEl.textContent = 'Pálya betöltése...';
    await setTrack('assets/' + entry.file, entry.id, entry.spawns);
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
    world.step(1 / 60, dt, 5);
    applyWallConstraint();

    if (carLoaded) {
      carPivot.position.set(chassisBody.position.x, chassisBody.position.y, chassisBody.position.z);
      carPivot.quaternion.set(
        chassisBody.quaternion.x,
        chassisBody.quaternion.y,
        chassisBody.quaternion.z,
        chassisBody.quaternion.w
      );
      updateSunTarget(carPivot.position);
    }

    for (let i = 0; i < vehicle.wheelInfos.length; i++) {
      vehicle.updateWheelTransform(i);
      const t = vehicle.wheelInfos[i].worldTransform;
      wheelBodies[i].position.copy(t.position);
      wheelBodies[i].quaternion.copy(t.quaternion);
    }

    updateChaseCamera();
  } else if (appState === 'dev') {
    updateDevCamera(dt);
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
  chassisBody, vehicle, world, carPivot, camera, currentSpawnPoints, currentTrackBox,
  zone: {
    getMask: () => zoneMaskCanvas, getBounds: () => zoneBounds, getView: () => zoneView,
    screenToWorld: zoneScreenToWorld, worldToMask: zoneWorldToMaskPixel,
    setRuntime: (z) => { zoneRuntime = z; }, sampleAt: sampleZoneAt, touchesWall: carTouchesWall,
    applyWall: applyWallConstraint, lastSafe: lastSafePos,
  },
};
