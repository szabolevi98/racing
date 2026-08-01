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

// Aszinkron, darabolt sugárvetés-alapú magasságtérkép építése a pálya vizuális
// geometriájából. A cél: a fizikai "talaj" kövesse a pálya tényleges felszínét
// (lejtők, hidak stb.), ne egy sík legyen alatta/felette. Csak Indításkor fut le.
function buildTrackHeightfield(track, box, onDone, preferXZ) {
  const prefX = preferXZ ? preferXZ.x : 0;
  const prefZ = preferXZ ? preferXZ.z : 0;
  track.traverse((obj) => {
    if (obj.isMesh && obj.geometry) {
      obj.geometry.computeBoundsTree();
    }
  });

  const sizeX = box.max.x - box.min.x;
  const sizeZ = box.max.z - box.min.z;

  // Rács-felbontás úgy megválasztva, hogy kb. 20 000 mintapont körül legyen
  // (ez néhány másodperc alatt lefut BVH-gyorsított raycasteléssel).
  const targetPoints = 20000;
  const elementSize = Math.max(4, Math.sqrt((sizeX * sizeZ) / targetPoints));
  const nx = Math.max(2, Math.ceil(sizeX / elementSize) + 1);
  const nz = Math.max(2, Math.ceil(sizeZ / elementSize) + 1);

  const data = [];
  for (let i = 0; i < nx; i++) data.push(new Array(nz).fill(box.min.y - 50));

  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  const dir = new THREE.Vector3(0, -1, 0);
  const rayOriginY = box.max.y + 20;

  let bestDist = Infinity;
  let bestPoint = null;

  let i = 0;
  const BATCH = 400;

  function step() {
    const end = Math.min(nx, i + Math.ceil(BATCH / nz) + 1);
    for (; i < end; i++) {
      const worldX = box.min.x + i * elementSize;
      for (let j = 0; j < nz; j++) {
        const worldZ = box.max.z - j * elementSize;
        raycaster.set(new THREE.Vector3(worldX, rayOriginY, worldZ), dir);
        const hits = raycaster.intersectObject(track, true);
        if (hits.length) {
          const y = hits[0].point.y;
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
      onDone({ data, elementSize, spawn: bestPoint });
    }
  }

  step();
}

// ---------- Irányítás (csak vezetés közben aktív) ----------
const keys = {};
window.addEventListener('keydown', (e) => { keys[e.code] = true; });
window.addEventListener('keyup', (e) => { keys[e.code] = false; });

const maxSteerVal = 0.5;
const maxForce = 900;
const brakeForce = 60;

function updateControls() {
  const forward = keys['KeyW'] || keys['ArrowUp'];
  const backward = keys['KeyS'] || keys['ArrowDown'];
  const left = keys['KeyA'] || keys['ArrowLeft'];
  const right = keys['KeyD'] || keys['ArrowRight'];
  const brake = keys['Space'];

  const force = forward ? -maxForce : backward ? maxForce * 0.6 : 0;
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

  // A már meglévő (spawn.json-ból betöltött) pontokat is megjelenítjük.
  devSpawnMarkers.splice(0).forEach((m) => scene.remove(m));
  if (currentTrack) {
    const raycaster = new THREE.Raycaster();
    raycaster.firstHitOnly = true;
    currentSpawnPoints.forEach(({ x, z }) => {
      raycaster.set(new THREE.Vector3(x, currentTrackBox.max.y + 20, z), new THREE.Vector3(0, -1, 0));
      const hits = raycaster.intersectObject(currentTrack, true);
      addDevSpawnMarker(x, hits.length ? hits[0].point.y : currentTrackBox.min.y, z);
    });
  }
  devSpawnCountEl.textContent = String(currentSpawnPoints.length);
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

function addDevSpawnMarker(x, y, z) {
  const marker = new THREE.Mesh(devMarkerGeometry, devMarkerMaterial);
  marker.position.set(x, y + 1.2, z);
  scene.add(marker);
  devSpawnMarkers.push(marker);
}

function removeLastDevSpawnMarker() {
  const marker = devSpawnMarkers.pop();
  if (marker) scene.remove(marker);
}

function markDevSpawnPoint() {
  if (!currentTrack) return;
  if (currentSpawnPoints.length >= 8) {
    devSpawnStatusEl.textContent = 'Már megvan mind a 8 pont.';
    return;
  }
  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  raycaster.set(camera.position, new THREE.Vector3(0, -1, 0));
  const hits = raycaster.intersectObject(currentTrack, true);
  if (!hits.length) {
    devSpawnStatusEl.textContent = 'Nincs pálya a kamera alatt itt.';
    return;
  }
  const { x, y, z } = hits[0].point;
  currentSpawnPoints.push({ x: +x.toFixed(2), z: +z.toFixed(2) });
  addDevSpawnMarker(x, y, z);
  devSpawnCountEl.textContent = String(currentSpawnPoints.length);
  devSpawnStatusEl.textContent = '';
}

function saveDevSpawnPoints() {
  if (!currentMapId || !currentSpawnPoints.length) {
    devSpawnStatusEl.textContent = 'Nincs mit menteni.';
    return;
  }
  devSpawnStatusEl.textContent = 'Mentés...';
  fetch('assets/save_spawn.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapId: currentMapId, spawns: currentSpawnPoints }),
  })
    .then((res) => res.json())
    .then((data) => {
      devSpawnStatusEl.textContent = data.ok
        ? `Elmentve (${data.count} pont).`
        : 'Hiba: ' + (data.error || 'ismeretlen');
    })
    .catch((err) => {
      devSpawnStatusEl.textContent = 'Hiba: ' + err.message;
    });
}

window.addEventListener('keydown', (e) => {
  if (appState !== 'dev') return;
  devKeys[e.code] = true;
  if (e.code === 'KeyM') markDevSpawnPoint();
  if (e.code === 'Backspace') {
    if (currentSpawnPoints.length) {
      currentSpawnPoints.pop();
      removeLastDevSpawnMarker();
      devSpawnCountEl.textContent = String(currentSpawnPoints.length);
    }
  }
  if (e.code === 'Enter') saveDevSpawnPoints();
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

startBtn.addEventListener('click', () => {
  if (!currentTrack || !currentTrackBox) return;
  startBtn.disabled = true;

  if (heightfieldBody) {
    world.removeBody(heightfieldBody);
    heightfieldBody = null;
  }

  buildTrackHeightfield(currentTrack, currentTrackBox, ({ data, elementSize, spawn }) => {
    const heightfieldShape = new CANNON.Heightfield(data, { elementSize });
    heightfieldBody = new CANNON.Body({ mass: 0, material: groundMaterial });
    heightfieldBody.addShape(heightfieldShape);
    // A heightfield helyi (x=i*elementSize, y=j*elementSize, z=magasság) rendszerét
    // -90 fokkal elforgatva Y-up világba állítjuk: worldX = pos.x + i*elementSize,
    // worldZ = pos.z - j*elementSize, worldY = pos.y + data[i][j].
    heightfieldBody.position.set(currentTrackBox.min.x, 0, currentTrackBox.max.z);
    heightfieldBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(heightfieldBody);

    buildContourFloorMesh(data, elementSize, currentTrackBox, 3);

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
  } else {
    updateSunTarget(carPivot.position);
    updateShowcaseCamera(dt);
  }

  renderer.render(scene, camera);
}

animate();

window.__debug = { chassisBody, vehicle, world, carPivot, camera, currentSpawnPoints, currentTrackBox };
