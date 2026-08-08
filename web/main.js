import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import RAPIER from 'rapier';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import {
  GRAVITY, CHASSIS_SIZE, WHEEL_RADIUS, SUSPENSION_REST_LENGTH, WHEEL_POSITIONS,
  STEER_VISUAL_SPEED, buildVehicle, applyControls, resetLiveVehicleTunables,
  FLOOR_COLLIDER_GROUPS, WALL_COLLIDER_GROUPS, WHEEL_RAY_FILTER_GROUPS,
  CAR_PROXY_COLLIDER_GROUPS, TRACK_FRICTION, applyChassisMassProperties,
  forwardSpeed, REVERSE_BRAKE_THRESHOLD, applySpeedCap, settleFinishedBody,
} from '/shared/vehicleConfig.js';
import { TAINT, requiredCheckpoints } from '/shared/protocol.js';
import { classifyPing } from '/shared/ping.js';
import {
  countdownBeep, startBeep, setMuted, isMuted, setVolume, getVolume, primeOnFirstGesture,
  startEngine, stopEngine, updateEngine,
  createRemoteEngine, updateRemoteEngine, stopRemoteEngine, updateAudioListener,
} from './audio.js';
import {
  ZONE_ASPHALT, ZONE_OFFTRACK, ZONE_WALL, decodeZoneCodes, sampleZone,
  wallProbes, wheelProbes,
  carTouchesWall as sharedCarTouchesWall,
  allWheelsOffTrack as sharedAllWheelsOffTrack,
  wheelsOffTrack as sharedWheelsOffTrack,
  applyWallConstraint as sharedApplyWallConstraint,
} from '/shared/zone.js';


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
const loadingBarEl = document.getElementById('loadingBar');
const loadingPctEl = document.getElementById('loadingPct');
const menuEl = document.getElementById('menu');

// ---------- Betöltés-overlay (induláskor ÉS kocsi/pálya/ég váltásnál) ----------
// Az induló betöltésen kívül máshol (menüben kocsi/ég váltás, multiplayer
// verseny-indítás) eddig semmilyen visszajelzés nem volt letöltés közben —
// szar neten ez percekig tartó, néma várakozásnak tűnt. Ugyanezt a sávot és
// %-ot használjuk mindenhol, csak "translucent" módban, hogy a mögötte lévő
// menü/játék állóképe átlásszon.
function showLoadingOverlay(translucent) {
  loadingEl.classList.toggle('overlay-translucent', !!translucent);
  loadingBarEl.style.width = '0%';
  loadingPctEl.textContent = '0%';
  loadingEl.style.display = 'flex';
}

function hideLoadingOverlay() {
  loadingEl.style.display = 'none';
  loadingEl.classList.remove('overlay-translucent');
}

// tasks: [{ bytes, run(onProgress) => Promise }]. A %-ot fájlméret szerint
// súlyozva számolja (lásd server/assets.js entry.bytes) — enélkül egy pár
// MB-os kocsi és egy 100+ MB-os pálya egyformán érne a sávban.
async function runLoadTasks(tasks) {
  const weights = tasks.map((t) => t.bytes || 1);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const fractions = tasks.map(() => 0);
  const update = () => {
    const overall = fractions.reduce((sum, f, i) => sum + f * weights[i], 0) / totalWeight;
    const pct = Math.round(Math.min(1, overall) * 100);
    loadingBarEl.style.width = pct + '%';
    loadingPctEl.textContent = pct + '%';
  };
  update();
  await Promise.all(tasks.map((t, i) => t.run((evt) => {
    if (evt.lengthComputable) fractions[i] = evt.loaded / evt.total;
    update();
  }).then(() => { fractions[i] = 1; update(); })));
}
const hudEl = document.getElementById('hud');
const menuStatusEl = document.getElementById('menuStatus');
const mapSelect = document.getElementById('mapSelect');
const carSelect = document.getElementById('carSelect');
const envSelect = document.getElementById('envSelect');
const startBtn = document.getElementById('startBtn');
const backToMenuLink = document.getElementById('backToMenuLink');
// A fejlesztői felületnek EGY eleme sincs itt: a markupja a dev.html-ben van,
// és a dev.js injektálja be, amikor tényleg dev módba lépsz. Elrejteni a
// devTools?.hideOverlays() hívással lehet.
makeSearchableSelect(mapSelect);
makeSearchableSelect(carSelect);
makeSearchableSelect(envSelect);
const zoneIndicatorEl = document.getElementById('zoneIndicator');
const miniMapCanvas = document.getElementById('miniMapCanvas');
const miniMapCtx = miniMapCanvas.getContext('2d');
const speedValueEl = document.getElementById('speedValue');
const pingBoxEl = document.getElementById('pingBox');
const pingValueEl = document.getElementById('pingValue');
const fpsValueEl = document.getElementById('fpsValue');
const rolloverAlertEl = document.getElementById('rolloverAlert');
const rolloverAlertTextEl = document.getElementById('rolloverAlertText');
const highPingAlertEl = document.getElementById('highPingAlert');
const highPingAlertTextEl = document.getElementById('highPingAlertText');
const lapInvalidAlertEl = document.getElementById('lapInvalidAlert');
const lapInvalidAlertTextEl = document.getElementById('lapInvalidAlertText');
const lapCountSelect = document.getElementById('lapCountSelect');
const raceHudEl = document.getElementById('raceHud');
const raceHudWrapEl = document.getElementById('raceHudWrap');
const standingsEl = document.getElementById('standings');
const standingsWrapEl = document.getElementById('standingsWrap');
const helpBtn = document.getElementById('helpBtn');
const helpPanelEl = document.getElementById('helpPanel');
const volumeSliderEl = document.getElementById('volumeSlider');
const volumeValueEl = document.getElementById('volumeValue');
const countdownEl = document.getElementById('countdown');
const resultsEl = document.getElementById('results');
const resultsBodyEl = document.getElementById('resultsBody');
const resultsRestartBtn = document.getElementById('resultsRestartBtn');
const resultsMenuBtn = document.getElementById('resultsMenuBtn');
const touchControlsEl = document.getElementById('touchControls');

// Dev mód: /dev útvonalon VAGY ?dev=1 lekérdezés-paraméterrel — szabad
// kamerával be lehet járni a pályát és kijelölni a rajtrács-pontokat
// (assets/maps/<id>/spawn.json). A /dev-et a szerver (static.js) is
// ugyanarra az index.html-re képezi le, mint a "/"-t — itt csak fel kell
// ismerni, melyik útvonalon jöttünk.
const DEV_MODE =
  window.location.pathname === '/dev' ||
  new URLSearchParams(window.location.search).has('dev');

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

function setSkybox(skyUrl, onProgress) {
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
      onProgress,
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
// A normalBias VILÁG-egységben tolja el az árnyék-mintavétel helyét a felszín
// normálisa mentén, tehát az ASZFALT mintavételi pontját is ennyivel emeli:
// ami ez alatt van, az megszűnik árnyékot vetni. Itt 0.4 állt (a pályán
// megjelenő önárnyékoló csíkozás ellen), és ez a VÉKONY kocsik árnyékát
// gyakorlatilag kiirtotta. Mérve: az F2004 geometriájának 64.5%-a van 0.4 m
// alatt és csak 1.5%-a 0.6 m felett, ezért legfeljebb a légbeömlő/hátsó szárny
// vetett valamit; egy magas GT-autónál (BMW M3 GTR: a geometria 61%-a van
// 0.4 m FELETT) ugyanez alig látszott.
//
// FIGYELEM, ez a 0.02 még nincs igazolva: az árnyék visszatérését nem sikerült
// méréssel kimutatni, és nem tudjuk, visszajön-e tőle a csíkozás a pályán. Ha
// igen, ez az egy sor a visszaút (a régi érték 0.4 volt). Az árnyéktextúra
// egyébként 9.8 cm/texel (2048² egy 200 m-es frusztumon), ami a szárnyaknál
// már eleve a texel-méret alatt van — lehet, hogy a valódi ok inkább ez.
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
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
const world = new RAPIER.World(GRAVITY);
world.timestep = 1 / 60;

let spawnPoint = new THREE.Vector3(0, 5, 0);
// A pálya ütközési háromszöghálója (a heightfieldet váltja ki).
let trackColliderBody = null;
let trackCollider = null;

// ---------- Autó (chassis + Rapier raycast vehicle) ----------
// A kocsit a KÖZÖS buildVehicle() építi, ugyanaz a függvény, amit a szerver is
// hív. Korábban itt egy külön, kézzel karbantartott másolat állt: minden értéke
// egyezett a shared/vehicleConfig.js-ével, de két helyen kellett javítani, és
// egy elmaradt átvezetés csendben elrontotta volna a client-side predictiont —
// a kliens és a szerver ilyenkor másképp számol, a kocsi pedig ugrálni kezd.
const chassisSize = CHASSIS_SIZE;
const { body: chassisBody, collider: chassisCollider, vehicle } =
  buildVehicle(RAPIER, world, { x: 0, y: 5, z: 0 });

// Közeli ellenfelek dinamikus ütközőtestei a helyi jósláshoz. A szerver
// marad a hiteles forrás; ezek csak azt akadályozzák meg, hogy a kliens olyan
// akadálytalan mozgást jósoljon, miközben a szerver már autó–autó kontaktot lát.
const remoteCarProxies = new Map();

function setRemoteCarProxy(id, state) {
  let proxy = remoteCarProxies.get(id);
  if (!state) {
    if (proxy) {
      proxy.collider.setEnabled(false);
      proxy.body.setEnabled(false);
    }
    return;
  }
  const { p, q, v = [0, 0, 0], w = [0, 0, 0] } = state;
  if (!proxy) {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(p[0], p[1], p[2])
        .setGravityScale(0)
        .setCanSleep(false)
        .setCcdEnabled(true)
    );
    const collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(CHASSIS_SIZE.x, CHASSIS_SIZE.y, CHASSIS_SIZE.z)
        .setCollisionGroups(CAR_PROXY_COLLIDER_GROUPS),
      body
    );
    applyChassisMassProperties(collider, body);
    proxy = { body, collider };
    remoteCarProxies.set(id, proxy);
  }
  proxy.body.setEnabled(true);
  proxy.collider.setEnabled(true);
  proxy.body.setTranslation({ x: p[0], y: p[1], z: p[2] }, true);
  proxy.body.setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] }, true);
  proxy.body.setLinvel({ x: v[0], y: v[1], z: v[2] }, true);
  proxy.body.setAngvel({ x: w[0], y: w[1], z: w[2] }, true);
}

function removeRemoteCarProxy(id) {
  const proxy = remoteCarProxies.get(id);
  if (!proxy) return;
  try { world.removeRigidBody(proxy.body); } catch { /* már törölve */ }
  remoteCarProxies.delete(id);
}

function clearRemoteCarProxies() {
  for (const id of [...remoteCarProxies.keys()]) removeRemoteCarProxy(id);
}

// Milyen mélyen van a talaj a kasztni KÖZEPE alatt, ha az autó nyugalomban áll?
// A látható modellt ehhez igazítjuk, nem a kasztni-doboz aljához: a kerék a
// kasztni alja alá lóg (rácsatlakozás + rugóhossz + keréksugár), ezért a
// doboz aljához igazított modell a levegőben lóg.
//
// A nyugalmi rugóhosszt nem számoljuk ki képletből (a Bullet-féle rugóerő
// pontos alakja motor-belső), hanem az első olyan képkockán MÉRJÜK, amikor
// mind a négy kerék a talajon van és a kocsi már nem mozog függőlegesen.
// Addig a teljesen kinyúlt rugóval számolunk.
const WHEEL_CONNECTION_DROP = -WHEEL_POSITIONS[0].y;
let groundOffset = WHEEL_CONNECTION_DROP + SUSPENSION_REST_LENGTH + WHEEL_RADIUS;
let groundOffsetCalibrated = false;

// A kalibrált értékre nem ugrunk át, hanem odacsúszunk.
//
// A mért érték ~7 cm-rel tér el a kinduló becsléstől, a kerekek helyzetét
// viszont semmi nem követi vele (updateWheelVisuals csak FORGATJA őket) — így
// egy egy-képkockás váltás azt mutatja, mintha a felfüggesztés hirtelen
// kinyúlna. Ez épp a rajt előtt, a visszaszámlálás alatt esne, ahol a kocsi
// egyébként áll, tehát jól látszik. Néhány tized másodperc alatt átcsúszva
// nem tűnik fel.
let groundOffsetTarget = groundOffset;
const GROUND_OFFSET_EASE_SPEED = 0.25;   // m/mp

// A "megnyugodott-e" próba MAGÁN a felfüggesztés-hosszon fut, nem a kasztni
// függőleges sebességén.
//
// A sebesség itt használhatatlan: a jármű-vezérlő alatt a test helyben áll
// (mérve: y négy tizedesjegyre változatlan 500 ticken át), a linvel().y mégis
// konstans ~0.95-öt jelent — a felfüggesztés által épp kioltott, névleges
// értéket. A régi `|linvel.y| > 0.05` feltétel ezért 600 tickből 19-ben
// engedett át: a kalibrálás egyjátékosban is csak szerencsével futott le,
// multiplayerben pedig sosem. Ha nem fut le, a modell a teljesen kinyúlt
// rugóval számolt magassággal ül, vagyis ~7 cm-rel az aszfalt alá kerül.
// Mennyit mozdulhat a felfüggesztés az ablak EGÉSZE alatt, hogy még
// "megnyugodott"-nak számítson.
const SUSPENSION_SETTLED_EPS = 0.002;
// Ennyi egymást követő képkockán kell ennyire stabilnak lennie. Nem elég EGY
// egyező mérés: a fizika fix 60 Hz-en lép, a képernyő gyorsabban rajzol, tehát
// két képkocka közé eshet nulla fizikai lépés — olyankor a leolvasás magától
// azonos, és egy épp pattogó rugót is megnyugodottnak hinnénk.
const SUSPENSION_SETTLED_FRAMES = 8;
// Az összehasonlítás alapja az ABLAK ELEJE, nem az előző képkocka. Ez nem
// finomság: a rugó a rajt utáni első másodpercben lassan, egyenletesen
// süllyed, képkockánként a küszöb alatti lépésekben. Az előző képkockához
// mérve ez végig "stabilnak" látszik, és a kalibrálás egy még mozgó
// állapotot rögzít (mérve: 1.1 cm hibával). Az ablak kezdetéhez mérve a
// TELJES elmozdulás korlátos, és a mért érték 0.1 mm-re pontos.
let suspensionRefAvg = null;
let suspensionStableFrames = 0;

function resetGroundOffsetCalibration() {
  groundOffsetCalibrated = false;
  groundOffsetTarget = groundOffset;
  suspensionRefAvg = null;
  suspensionStableFrames = 0;
}

// Minden képkockán fut (egyjátékosban és multiplayerben is): amíg van hova,
// csúsztatja a modellt a mért magasság felé, aztán megkeresi ezt a magasságot.
function calibrateGroundOffset(dt = 1 / 60) {
  if (groundOffset !== groundOffsetTarget) {
    const step = GROUND_OFFSET_EASE_SPEED * dt;
    const remaining = groundOffsetTarget - groundOffset;
    groundOffset = Math.abs(remaining) <= step ? groundOffsetTarget : groundOffset + Math.sign(remaining) * step;
    applyCarModelHeight();
  }
  if (groundOffsetCalibrated) return;
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    // Mind a négy keréknek a talajon kell lennie, különben nem a nyugalmi
    // helyzetet mérnénk (ugratás, felborulás, félig kerékvetőn állás).
    if (!vehicle.wheelIsInContact(i)) {
      suspensionRefAvg = null;
      suspensionStableFrames = 0;
      return;
    }
    sum += vehicle.wheelSuspensionLength(i) ?? SUSPENSION_REST_LENGTH;
  }

  const avg = sum / 4;
  if (suspensionRefAvg !== null && Math.abs(avg - suspensionRefAvg) < SUSPENSION_SETTLED_EPS) {
    suspensionStableFrames++;
  } else {
    // Kilépett a sávból: innen indul az új ablak.
    suspensionRefAvg = avg;
    suspensionStableFrames = 0;
  }
  if (suspensionStableFrames < SUSPENSION_SETTLED_FRAMES) return;

  // Csak a CÉLT állítjuk be — a modell néhány tized másodperc alatt csúszik oda
  // (ld. GROUND_OFFSET_EASE_SPEED), hogy ne egy képkockás ugrás legyen.
  groundOffsetTarget = WHEEL_CONNECTION_DROP + avg + WHEEL_RADIUS;
  groundOffsetCalibrated = true;
}

// A Rapierben a merev test állapota csak settereken át írható (a getterek
// másolatot adnak vissza), ezért kell külön függvény a visszahelyezéshez.
// A heading az Y tengely körüli elfordulás: 0 = a világ +Z iránya (az autó
// "előre" tengelye). Pályánként állítjuk a szerkesztőben, mert a rajtvonal
// nem mindenhol néz ugyanabba az irányba.
let spawnHeading = 0;

// A kirajzoláshoz a két utolsó fizikai állapot kell. A fizika fix 60 Hz-en lép,
// a képernyő viszont a saját frissítésével rajzol — 75 Hz-en a képkockák egy
// részére NULLA lépés jut, másokra kettő. Ha a test pillanatnyi állapotát
// rajzolnánk ki, a kocsi pontosan ilyen egyenetlenül haladna.
//
// (Korábban ez a rángás azért nem létezett, mert a fizika képkockánként lépett
// egyet — de épp emiatt függött a játék sebessége a monitortól. A helyes
// megoldás mindkettőt kezeli: valós idő szerinti léptetés + interpoláció.
// Multiplayerben ugyanezt időbélyeges pufferrel csináljuk; itt elég a két
// szomszédos állapot, mert a lépéseket maga a képkocka-hurok végzi.)
const prevCarPos = new THREE.Vector3();
const currCarPos = new THREE.Vector3();
const prevCarQuat = new THREE.Quaternion();
const currCarQuat = new THREE.Quaternion();
let carInterpReady = false;

function captureCarState() {
  prevCarPos.copy(currCarPos);
  prevCarQuat.copy(currCarQuat);
  const p = chassisBody.translation();
  const q = chassisBody.rotation();
  currCarPos.set(p.x, p.y, p.z);
  currCarQuat.set(q.x, q.y, q.z, q.w);
}

// Teleportálás (rajt, R) után a két állapot közé interpolálni annyi lenne, mint
// a régi helyről átcsúsztatni a kocsit az újra — ezért ilyenkor mindkettőt az
// új állapotra állítjuk.
function resetCarInterpolation() {
  const p = chassisBody.translation();
  const q = chassisBody.rotation();
  currCarPos.set(p.x, p.y, p.z);
  currCarQuat.set(q.x, q.y, q.z, q.w);
  prevCarPos.copy(currCarPos);
  prevCarQuat.copy(currCarQuat);
  carInterpReady = true;
}

function resetCarTo(pos, heading = spawnHeading) {
  const half = heading / 2;
  chassisBody.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
  chassisBody.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, true);
  chassisBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
  chassisBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
  lastSafePos.x = pos.x; lastSafePos.y = pos.y; lastSafePos.z = pos.z;
  // A kör-logika a kocsi ELŐZŐ és MOSTANI pozíciója közötti szakaszt metszi a
  // kapukkal. Teleportálás után (pl. R) ez a szakasz a régi, akár messzi
  // pozíciótól az új helyig érne — útközben átvágva más kapukon is —, ezért
  // itt "megszakítjuk" azzal, hogy az előző pozíciót is az újra állítjuk.
  race.prevX = pos.x;
  race.prevZ = pos.z;
  // Ugyanez a megfontolás a kirajzolásnál: a képkocka-interpoláció se
  // csúsztassa át a kocsit a régi helyről az újra.
  resetCarInterpolation();
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

function loadGLTF(url, onProgress) {
  return new Promise((resolve, reject) => gltfLoader.load(url, resolve, onProgress, reject));
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

// Megmondja egy textúráról, hogy MASZK jellegű-e: a lombozat/kerítés-textúrák
// alfája jellemzően bináris (egy képpont vagy teljesen átlátszó, vagy teljesen
// fedő), csak a levélszélek élsimított sávja köztes. Ezzel különítjük el őket a
// VALÓDI félig-átlátszó anyagoktól (üveg, aszfalt-gumicsík, füst), amiken
// szándékosan át kell látni.
//
// A döntő jel a teljesen FEDŐ képpontok aránya: mind a három pályán mérve a
// valódi félig-átlátszó anyagoknál ez PONTOSAN nulla, a lombozatnál 7-100%.
// Emellett kizárjuk azt is, aminek a képe túlnyomórészt köztes alfájú (pl.
// nagyon finom, élsimított drótháló) — ott a mélység-írás túl sok mindent
// levágna a háttérből.
// Kitölti az átlátszó képpontok RGB-jét a szomszédos LÁTHATÓ képpontok
// színével ("alpha bleeding" / dilatáció). Erre azért van szükség, mert a
// glTF-textúrákban a teljesen átlátszó terület RGB-je jellemzően FEKETE
// (mérve: [0,0,0] minden fa-textúránál, míg a látható rész zöld). A forrás-
// textúra alfája szinte tökéletesen bináris, a köztes átlátszóság futásidőben,
// a GPU mipmap-átlagolásából keletkezik — és ott a levél zöldje a fekete
// háttérrel keveredik. Kivágásnál az így kapott sötét képpont teljes erővel
// jelenik meg: ettől lett foltos a lombozat a korábbi próbálkozásban.
// A kitöltés után a mipmap már csak leveleket átlagol.
//
// A terjesztés hullámfrontosan (BFS), tipizált tömbökkel megy, és a TELJES
// átlátszó területre kifut: a mipmap felső szintjein már nagy környezet
// átlagolódik egyetlen képpontba, így a nagy átlátszó foltok belseje is
// beleszámít. Minden képpontot pontosan egyszer érintünk, így egy 2048x1024-es
// textúra is ezredmásodpercek alatt kész.
function dilateTextureRGB(tex) {
  const img = tex.image;
  const w = img.width;
  const h = img.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0);
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;

  const total = w * h;
  const solid = new Uint8Array(total);
  const queue = new Int32Array(total);
  let tail = 0;
  for (let i = 0; i < total; i++) {
    if (d[i * 4 + 3] > 127) {
      solid[i] = 1;
      queue[tail++] = i;
    }
  }
  if (tail === 0) return tex; // nincs látható képpont, nincs mit terjeszteni

  for (let head = 0; head < tail; head++) {
    const i = queue[head];
    const si = i * 4;
    const x = i % w;
    const y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        const j = yy * w + xx;
        if (solid[j]) continue;
        const sj = j * 4;
        // Csak a SZÍNT vesszük át, az alfa marad 0 — a képpont továbbra is
        // láthatatlan, csak már nem fekete, amikor a mipmap átlagol.
        d[sj] = d[si];
        d[sj + 1] = d[si + 1];
        d[sj + 2] = d[si + 2];
        solid[j] = 1;
        queue[tail++] = j;
      }
    }
  }

  // FONTOS: az eredményt NEM adhatjuk vissza canvas-textúraként. A canvas 2D
  // belül ELŐRE SZOROZZA a színt az alfával, így a teljesen átlátszó képpontok
  // RGB-je a visszaolvasáskor nullázódna (szín * 0) — pontosan az az adat
  // veszne el, amit az imént töltöttünk ki. A nyers képpont-tömböt ezért
  // közvetlenül, DataTexture-ként adjuk a GPU-nak.
  const out = new THREE.DataTexture(new Uint8Array(d.buffer), w, h, THREE.RGBAFormat);
  out.wrapS = tex.wrapS;
  out.wrapT = tex.wrapT;
  out.repeat.copy(tex.repeat);
  out.offset.copy(tex.offset);
  out.flipY = tex.flipY;
  out.colorSpace = tex.colorSpace;
  out.anisotropy = tex.anisotropy;
  out.generateMipmaps = true;
  out.minFilter = THREE.LinearMipmapLinearFilter;
  out.magFilter = THREE.LinearFilter;
  out.needsUpdate = true;
  out.userData.originalTexture = tex; // hibakereséshez: az érintetlen eredeti
  return out;
}

const dilatedTextureCache = new Map();
function getDilatedTexture(tex) {
  if (dilatedTextureCache.has(tex.uuid)) return dilatedTextureCache.get(tex.uuid);
  let out = tex;
  try {
    out = dilateTextureRGB(tex);
  } catch (err) {
    out = tex; // pl. cross-origin kép: maradjon az eredeti
  }
  dilatedTextureCache.set(tex.uuid, out);
  return out;
}

const maskTextureCache = new Map();
function isMaskLikeTexture(tex) {
  if (!tex || !tex.image) return false;
  if (maskTextureCache.has(tex.uuid)) return maskTextureCache.get(tex.uuid);

  let result = false;
  try {
    const img = tex.image;
    const w = img.width;
    const h = img.height;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    // NEAREST mintavétel (imageSmoothingEnabled = false): a bilineáris
    // interpoláció maga gyártana köztes alfa-értékeket a 0/255 határon, és
    // minden textúra félig-átlátszónak tűnne.
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, w, h).data;

    let opaque = 0;
    let mid = 0;
    for (let i = 3; i < d.length; i += 4) {
      const a = d[i];
      if (a > 239) opaque++;
      else if (a >= 16) mid++;
    }
    const total = w * h;
    const maskLike = opaque / total > 0.01 && mid / total < 0.4;

    // Túlél-e a kicsinyítés? A GPU a mipmap-szinteket a szomszédos képpontok
    // átlagolásával készíti, és a 0.5-ös vágási küszöb alá eső átlagú
    // képpontok egyszerűen eltűnnek. VÉKONY, rácsos mintáknál (drótháló
    // kerítés) ez drasztikus: mérve a tartalmas 4x4-es blokkok 57-77%-a
    // veszne el már az ELSŐ szinten, vagyis a kerítés távolról kifakulna —
    // a lombozatnál ugyanez csak 5-17%. Az ilyen finom mintákat ezért békén
    // hagyjuk (marad a régi, kevert megjelenítés): a kerítés úgyis alig takar,
    // ott a takarási hiba nem feltűnő, a szétfoszló rács viszont az lenne.
    let blocks = 0;
    let lost = 0;
    const B = 4;
    for (let by = 0; by + B <= h; by += B) {
      for (let bx = 0; bx + B <= w; bx += B) {
        let sum = 0;
        for (let y = 0; y < B; y++) {
          for (let x = 0; x < B; x++) sum += d[((by + y) * w + (bx + x)) * 4 + 3];
        }
        const avg = sum / (B * B);
        if (avg > 8) {
          blocks++;
          if (avg < 127.5) lost++;
        }
      }
    }
    const survivesMipmapping = blocks === 0 || lost / blocks < 0.4;

    result = maskLike && survivesMipmapping;
  } catch (err) {
    result = false; // pl. cross-origin textúra: nem olvasható, hagyjuk békén
  }

  maskTextureCache.set(tex.uuid, result);
  return result;
}

async function setTrack(trackUrl, mapId, spawnPoints, gates, onProgress) {
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

  const gltf = await loadGLTF(trackUrl, onProgress);
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

          // A lombozat/kerítés alfa-keverve érkezik, aminek az alapértelmezése
          // depthWrite = false — vagyis NEM ír a mélységi pufferbe. A Three.js
          // a keverendő darabokat objektum-KÖZÉPPONT szerint rendezi hátulról
          // előre; a sok fát tartalmazó, nagy kiterjedésű mesh-eknél ez eleve
          // rossz sorrendet ad, és mélység-írás híján a később rajzolt TÁVOLI
          // fa egyszerűen rárajzolódik a közelire — ez a "fák átlátszanak
          // egymáson" hiba.
          //
          // Három dolog kell egyszerre, és mindhárom egy-egy korábbi
          // próbálkozás buktatóját kerüli ki:
          //
          // 1) depthWrite = true — ez maga a javítás. Enélkül a lombozat nem ír
          //    a mélységi pufferbe, a Three.js pedig a keverendő darabokat
          //    objektum-KÖZÉPPONT szerint rendezi, ami itt értelmetlen (egy mesh
          //    több ezer egységnyi területen szórt fákat tartalmaz) — így a
          //    távoli fasor rendszeresen a közeliek UTÁN, tehát rájuk rajzolódott.
          //
          // 2) A keverés MEGMARAD (transparent = true). Teljes kivágásra váltva
          //    a lomb érezhetően elsötétül: a fa-textúrák látható része eleve
          //    sötét zöld (átlag [52,66,33]), és keverve a levélszélek átengedik
          //    a világos hátteret — kivágásnál viszont teljes erővel jelennek
          //    meg. Keverve marad a megszokott, világos lombkép.
          //
          // 3) alphaTest = 0.5, nem 0.1. Alacsony küszöbbel a félig átlátszó
          //    levélszél is mélységet ír, és mivel a mögötte lévő fát az már
          //    kivágta, a HÁTTÉRREL keveredik: ettől kap minden fa világos,
          //    égbolt-színű körvonalat, a drótháló kerítés mögül pedig eltűnnek
          //    a fák. Magas küszöbbel ezek a képpontok eldobódnak — nem írnak
          //    mélységet, nincs mit kivágniuk.
          //
          // A textúrát emellett kitöltjük (dilateTextureRGB): a forrás alfája
          // szinte tökéletesen bináris, a köztes átlátszóság a GPU mipmap-
          // átlagolásából keletkezik, és ott a levél zöldje a textúra átlátszó
          // területének FEKETE RGB-jével keveredne.
          if (m.transparent && m.map && isMaskLikeTexture(m.map)) {
            m.map = getDilatedTexture(m.map);
            m.alphaTest = 0.5;
            m.depthWrite = true;
            m.needsUpdate = true;
          }
        }
      });
    }
  });
  scene.add(track);
  currentTrack = track;
  currentTrackBox = new THREE.Box3().setFromObject(track);

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
  resetCarTo(spawnPoint);
  // Nem elég csak rotation.y-t írni: az Euler setter megtarthatja a korábbi
  // vezetésből származó X/Z dőlést és más Euler-feloldást. A kirakat
  // pontosan ugyanazt a tiszta quaterniont kapja, amelyet a fizikai autó és
  // később a játék rajtja is használ.
  const spawnRotation = chassisBody.rotation();
  carPivot.quaternion.set(
    spawnRotation.x, spawnRotation.y, spawnRotation.z, spawnRotation.w
  );

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
  // Négyfelé vágásnál előfordulhat, hogy a darab valójában csak egy ÁTLÓS
  // párt tartalmaz (pl. első-bal + hátsó-jobb, mert az exportáló a mesh-t
  // technikai okból — pl. 16 bites indexpuffer-korlát — véletlenszerűen
  // darabolta fel, nem sarok szerint), és a "hiányzó" másik két sarok negyede
  // üres marad. Ilyenkor NEM esünk vissza egytengelyes (2 felé) vágásra —
  // az ÖSSZEMOSNÁ két VALÓDI sarkot egyetlen darabba (pl. ha csak a hátsó-bal
  // hiányzik, egy X-menti vágás a hátsó-jobbat a hátsó-ballal egy csoportba
  // tenné). Ehelyett egyszerűen ELHAGYJUK az üres negyedet — a megmaradó
  // darabok már eleve a saját, valódi sarkukba esnek, a külső (buildWheelPivots)
  // csoportosítás pedig pozíció alapján úgyis helyesen sorolja be őket.
  const nonEmpty = triGroups.filter((g) => g.length > 0);
  if (nonEmpty.length < 2) return null;

  const attrNames = Object.keys(geom.attributes);
  const newMeshes = nonEmpty.map((tris) => {
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

// A saját és a távoli autó ugyanazon a normalizáláson menjen át.
// Különösen az F2004-nél fontos: a GLB origója nincs a tengelytáv
// közepén, ezért wheelPattern nélkül a látható modell előrébb kerülne a
// hiteles fizikai kasztninál. A függvény a már elforgatott és skálázott
// modellt igazítja, így mindkét kirajzolási út pontosan ugyanazt kapja.
function centerCarModelOnWheels(carRoot, wheelPattern) {
  const wheelCentre = findWheelCentreOffset(carRoot, wheelPattern);
  if (!wheelCentre) return false;
  carRoot.position.x -= wheelCentre.x;
  carRoot.position.z -= wheelCentre.z;
  carRoot.updateMatrixWorld(true);
  return true;
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
    // Megmérjük, milyen mélyen van a GUMI ALJA a pivot origójához képest. Ebből
    // az updateWheelVisuals pontosan a fizikai érintkezési pontra tudja tenni a
    // kereket — kocsinként és kerekenként magától, kézi korrekció nélkül.
    //
    // Miért mérés és nem becslés: a pivot origója a csoport legnagyobb darabjának
    // origója (ld. fentebb), ami a keréktengely KÖRNYÉKÉN van, de nem pontosan a
    // gumi közepén. Ha innen csak a rugóhossz VÁLTOZÁSÁT követnénk, a kiinduló
    // magasság öröklött hiba maradna — modellenként más, néhány centis eltolás.
    pivot.userData.bottomOffset = measureLocalBottom(pivot);
    return pivot;
  });
}

// Egy objektum legalsó pontja a SAJÁT koordinátarendszerében. Nem a
// Box3.setFromObject-et használjuk, mert az világ-dobozt ad: ha a kocsi épp
// dől vagy forog, annak az alja nem a lokális alj. A geometriák sarokpontjait
// visszatranszformáljuk a pivot terébe, így az eredmény független attól, hogy
// a kocsi hogyan áll — és a kerék gördülésétől is, mert a mérés a pivot
// forgatása ELŐTTI állapotban, egyszer történik.
function measureLocalBottom(root) {
  root.updateWorldMatrix(true, true);
  const toLocal = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const corner = new THREE.Vector3();
  const m = new THREE.Matrix4();
  let min = Infinity;
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
    const gb = obj.geometry.boundingBox;
    if (!gb) return;
    m.multiplyMatrices(toLocal, obj.matrixWorld);
    for (let xi = 0; xi < 2; xi++) {
      for (let yi = 0; yi < 2; yi++) {
        for (let zi = 0; zi < 2; zi++) {
          corner.set(xi ? gb.max.x : gb.min.x, yi ? gb.max.y : gb.min.y, zi ? gb.max.z : gb.min.z);
          corner.applyMatrix4(m);
          if (corner.y < min) min = corner.y;
        }
      }
    }
  });
  return Number.isFinite(min) ? min : 0;
}

async function setCar(carUrl, carId, config, onProgress) {
  setMenuStatus('Kocsi betöltése...');

  carLoaded = false;
  // A groundOffset kocsinkénti kalibrálása (calibrateGroundOffset) csak EGYSZER
  // futott le a teljes oldal-betöltés alatt (a groundOffsetCalibrated zászló
  // sosem állt vissza), ezért az ELSŐ vezetett kocsi felfüggesztés-hosszából
  // számolt érték minden KÉSŐBB kiválasztott kocsinál is megmaradt — akkor is,
  // ha annak egészen más a kerék-mérete. Emiatt tűnhetett úgy, hogy egy adott
  // kocsinál a felfüggesztés/kerék-agy magasabban ül, mint a kerék közepe: a
  // vizuális modell a SAJÁT (helyes) méretéhez igazodik, de vezetés közben a
  // kasztni egy IDEGEN kocsi kalibrált magasságában állt meg fizikailag.
  // Kocsiváltáskor ezért újra kalibrálni kell.
  groundOffset = WHEEL_CONNECTION_DROP + SUSPENSION_REST_LENGTH + WHEEL_RADIUS;
  resetGroundOffsetCalibration();
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

  const gltf = await loadGLTF(carUrl, onProgress);
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
  centerCarModelOnWheels(carRoot, config && config.wheelPattern);

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

// ---------- Ütközési háromszögháló kinyerése a pálya modelljéből ----------
// Ez váltja ki a korábbi magasságtérképet. Egy magasságtérkép 2D függvény —
// egy (x,z) ponthoz egyetlen magasság —, ezért elvileg sem tud hidat/felüljárót
// ábrázolni. Egy valódi háromszöghálónál ez magától megoldódik.
//
// Szűrés: csak a nagyjából vízszintes lapokat tartjuk meg (a függőleges falak,
// kerítések, épületoldalak kiesnek), így a háromszögszám nagyjából felére
// csökken, és nem a falakon akad meg a kerék-sugár.
const COLLISION_NORMAL_MIN_Y = 0.5;

function extractDrivableTriangles(track, pruneDebris = true) {
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

  const mesh = { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
  return pruneDebris ? pruneIsolatedDebris(mesh.positions, mesh.indices) : mesh;
}

// A fal-háromszögek kinyerése: pontosan a fordítottja az extractDrivableTriangles
// szűrésének (a majdnem-vízszintes lapok itt esnek ki, a majdnem-függőlegesek
// maradnak). Ez adja a kasztni-only ütközőt, ami megállítja a kocsit a
// falaknál/kerítéseknél, anélkül hogy a kerék-sugarat zavarná (lásd
// shared/vehicleConfig.js: COLLISION_GROUP_WALL, WHEEL_RAY_FILTER_GROUPS).
//
// A debris-szűrést itt is futtatjuk, a talaj-hálóhoz hasonlóan: egy kis,
// önmagában álló doboznak (pl. bokszutcai reklám-kocka) minden oldala megvan,
// a függőleges falai is — szűrés nélkül épp ezek a "kockák" kerülnének be
// látszólag szilárd, láthatatlan falként. Egy valódi kerítés/fal ennél a
// méret-küszöbnél (3 m) jóval hosszabb, tehát nem esik ki.
//
// A `pruneDebris` kikapcsolható (dev bake felület, ellenőrzés célból) —
// normál játékmenetben (fallback kinyerés) mindig bekapcsolva marad.
function extractWallTriangles(track, pruneDebris = true) {
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
      if (Math.abs(n.y) > COLLISION_NORMAL_MIN_Y) continue;
      const base = positions.length / 3;
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      indices.push(base, base + 1, base + 2);
    }
  });

  const mesh = { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
  return pruneDebris ? pruneIsolatedDebris(mesh.positions, mesh.indices) : mesh;
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

// ---------- A talaj-háló lejtéstöréseinek simítása (bake-időben) ----------
// A rázókövek egy része NEM lépcsős, hanem hullámos: pár méterenként 4-5 cm-es
// éles emelkedés, aztán lassú visszaesés. Pontonként ez kis magasságkülönbség
// (a lépcső-mérés simának is látja), a TETŐ SUGARA viszont 1-5 méter — 157
// km/h-n ennek követéséhez 40 g kellene, a gravitáció 1-et ad, tehát a kocsi
// elemelkedik. Mérve: mind a négy kerék fél másodpercre elhagyta a talajt, és
// mivel a felfüggesztésnek csak 8 cm lefelé útja van, utána nem ért vissza —
// innen a "megakad / elrepül" élmény.
//
// Ezért nem a magasságkülönbséget nézzük, hanem azt, hogy a felület egy adott
// pont körül MENNYIRE NEM SÍK (síkillesztés maradéka). Ez a mennyiség
// szándékosan érzéketlen a pálya vonalvezetésére: egy kanyar, egy lejtő vagy
// egy dőlt szakasz lokálisan tökéletesen sík. Suzukán mérve — kanyarok
// átlaga 0.7 mm (a legélesebb, 89 fokos kanyar 0.5 mm), egyenesek 1.0 mm,
// a kilövő rázókő 9.2 mm.
// A sugarat a HÁLÓ FELBONTÁSA szabja meg, nem az ízlés: a csúcsok sorokban
// állnak (Suzukán a szomszéd medián 0.23 m), a SOROK KÖZT viszont akár 1.6 m a
// hézag. Egy 0.6 m-es sugár ezért csak egyetlen sort fog be — a síkillesztés
// elfajul (majdnem kollineáris pontok), és a simítás nem csinál semmit. 1.5 m
// már biztosan több sort ér el, tehát valódi foltot lát.
const SMOOTH_RADIUS = 1.5;        // m — ekkora környezetben vizsgáljuk a felületet
const SMOOTH_TRIGGER = 0.004;     // m — 4 mm fölött simítunk (aszfalt: 0.7-1.0 mm)
const SMOOTH_MAX_SHIFT = 0.05;    // m — egy csúcs sem mozdulhat 5 cm-nél többet
const SMOOTH_ITERATIONS = 2;

// A csúcsokat CSAK függőlegesen mozgatjuk: a pálya rajzolata, szélessége és íve
// így biztosan változatlan marad. A ±5 cm-es korlát pedig azt garantálja, hogy
// a valódi lépcsők (pályaszél, korlát alja, akár 50 cm) érdemben ne simuljanak
// el — a szűrő csak a kis amplitúdójú töréseket tudja ténylegesen kiegyenlíteni.
function smoothFloorHeights(positions, indices) {
  const n = positions.length / 3;
  const cell = SMOOTH_RADIUS;
  const grid = new Map();
  const key = (ix, iz) => ix + ',' + iz;
  for (let i = 0; i < n; i++) {
    const k = key(Math.floor(positions[i * 3] / cell), Math.floor(positions[i * 3 + 2] / cell));
    let a = grid.get(k);
    if (!a) grid.set(k, a = []);
    a.push(i);
  }
  const neighboursOf = (i) => {
    const x = positions[i * 3], z = positions[i * 3 + 2];
    const ix = Math.floor(x / cell), iz = Math.floor(z / cell);
    const out = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const a = grid.get(key(ix + dx, iz + dz));
        if (!a) continue;
        for (const j of a) {
          const ddx = positions[j * 3] - x, ddz = positions[j * 3 + 2] - z;
          if (ddx * ddx + ddz * ddz <= SMOOTH_RADIUS * SMOOTH_RADIUS) out.push(j);
        }
      }
    }
    return out;
  };

  // 1) Hol nem sík a felület? (legkisebb négyzetes síkillesztés maradéka)
  const marked = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const nb = neighboursOf(i);
    if (nb.length < 6) continue;
    const x0 = positions[i * 3], z0 = positions[i * 3 + 2];
    let Sxx = 0, Szz = 0, Sxz = 0, Sx = 0, Sz = 0, S1 = 0, Sxy = 0, Szy = 0, Sy = 0;
    for (const j of nb) {
      const dx = positions[j * 3] - x0, dz = positions[j * 3 + 2] - z0, y = positions[j * 3 + 1];
      Sxx += dx * dx; Szz += dz * dz; Sxz += dx * dz;
      Sx += dx; Sz += dz; S1++; Sxy += dx * y; Szy += dz * y; Sy += y;
    }
    const det = Sxx * (Szz * S1 - Sz * Sz) - Sxz * (Sxz * S1 - Sz * Sx) + Sx * (Sxz * Sz - Szz * Sx);
    if (Math.abs(det) < 1e-12) continue;
    const a = (Sxy * (Szz * S1 - Sz * Sz) - Sxz * (Szy * S1 - Sz * Sy) + Sx * (Szy * Sz - Szz * Sy)) / det;
    const b = (Sxx * (Szy * S1 - Sz * Sy) - Sxy * (Sxz * S1 - Sz * Sx) + Sx * (Sxz * Sy - Szy * Sx)) / det;
    const c = (Sxx * (Szz * Sy - Szy * Sz) - Sxz * (Sxz * Sy - Szy * Sx) + Sxy * (Sxz * Sz - Szz * Sx)) / det;
    let s = 0;
    for (const j of nb) {
      const dx = positions[j * 3] - x0, dz = positions[j * 3 + 2] - z0;
      const e = positions[j * 3 + 1] - (a * dx + b * dz + c);
      s += e * e;
    }
    if (Math.sqrt(s / nb.length) > SMOOTH_TRIGGER) marked[i] = 1;
  }

  // 2) A maszkot egy gyűrűvel kiterjesztjük, hogy a simított és az érintetlen
  //    rész HATÁRÁN ne keletkezzen új törés — épp azt akarjuk megszüntetni.
  const grown = marked.slice();
  for (let i = 0; i < n; i++) {
    if (marked[i]) continue;
    for (const j of neighboursOf(i)) if (marked[j]) { grown[i] = 1; break; }
  }

  // 3) Átlagoló simítás — csak a megjelölt csúcsokon, csak az Y-on.
  const out = new Float32Array(positions);
  const idxs = [];
  for (let i = 0; i < n; i++) if (grown[i]) idxs.push(i);
  const nbCache = idxs.map(neighboursOf);
  for (let it = 0; it < SMOOTH_ITERATIONS; it++) {
    const snapshot = out.slice();
    idxs.forEach((i, k) => {
      const nb = nbCache[k];
      let s = 0;
      for (const j of nb) s += snapshot[j * 3 + 1];
      out[i * 3 + 1] = s / nb.length;
    });
  }
  // 4) Korlát: senki nem mozdulhat 5 cm-nél többet az eredetihez képest.
  let moved = 0;
  for (const i of idxs) {
    const d = out[i * 3 + 1] - positions[i * 3 + 1];
    const clamped = Math.max(-SMOOTH_MAX_SHIFT, Math.min(SMOOTH_MAX_SHIFT, d));
    out[i * 3 + 1] = positions[i * 3 + 1] + clamped;
    if (Math.abs(clamped) > 0.001) moved++;
  }

  return { positions: out, indices, jelolt: idxs.length, mozdult: moved, osszes: n };
}

function applyTrackCollider(floor, wall) {
  removeTrackCollider();
  trackColliderBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  trackCollider = world.createCollider(
    RAPIER.ColliderDesc.trimesh(floor.positions, floor.indices)
      .setFriction(TRACK_FRICTION)
      .setCollisionGroups(FLOOR_COLLIDER_GROUPS),
    trackColliderBody
  );
  // A fal-collider csak a kasztnival ütközik — a kerék-sugarat a
  // WHEEL_RAY_FILTER_GROUPS zárja ki belőle (lásd az updateVehicle hívásokat).
  if (wall && wall.indices.length > 0) {
    world.createCollider(
      RAPIER.ColliderDesc.trimesh(wall.positions, wall.indices)
        .setFriction(TRACK_FRICTION)
        .setCollisionGroups(WALL_COLLIDER_GROUPS),
      trackColliderBody
    );
  }
  // A Rapier lekérdező pipeline-ját a world.step() frissíti; enélkül a
  // kerekek sugarai némán semmit sem találnának el az első képkockákon.
  world.step();
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
// A zóna-kódok, a maszk értelmezése és a mintavétel a shared/zone.js-ben van,
// mert a SZERVER is pontosan ugyanezt csinálja: multiplayerben ő dönti el,
// lassul-e a kocsi a kifutón, a kliens pedig ezt előre jósolja.
let zoneRuntime = null;

async function loadZoneRuntime(entry) {
  zoneRuntime = null;
  miniMapTrackCanvas = null;
  miniMapBounds = null;
  if (!entry || !entry.zonemap) return;

  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    // Cache-kulcs a manifestből (méret + mtime), nem Date.now() — ugyanaz a
    // minta, mint a collision.bin-nél. A Date.now() minden pályabetöltésnél
    // újratöltette ezt a 330-900 KB-os képet, hiába nem változott.
    img.src = 'assets/' + entry.zonemap.file + (entry.zonemap.v ? '?v=' + entry.zonemap.v : '');
  });

  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height).data;

  const codes = decodeZoneCodes(data, img.width, img.height);

  zoneRuntime = { codes, w: img.width, h: img.height, bounds: entry.zonemap.bounds };
  buildMiniMapTrack(zoneRuntime);
}

// A mini-térkép pálya-sziluettje ugyanabból a zonemap-ből épül, amit a zóna-
// szerkesztő fest: festetlen = aszfalt (0), ebből rajzolunk ki egy világos
// foltot, a kifutó/fal festék pedig átlátszó marad. Ez csak PÁLYAVÁLTÁSKOR
// fut le egyszer (nem képkockánként), a kis felbontású eredmény kerül
// képkockánként a látható canvas-ra a játékos-pötty mellé.
const MINIMAP_TARGET = 220; // a hosszabbik oldal célmérete képpontban
let miniMapTrackCanvas = null;
// A kijelzett (kivágott) térkép-darab VILÁGKOORDINÁTÁS határai — nem
// egyezik a teljes zonemap.bounds-szal, mert a modell (díszlet, üres
// terület a pálya körül) sokkal nagyobb, mint maga a pálya-szalag.
let miniMapBounds = null;
function buildMiniMapTrack(runtime) {
  const { w, h, codes } = runtime;

  // A zonemap-en a kifutó/fal fedi a kép TÚLNYOMÓ többségét (minden, ami
  // nem pálya) — a tényleges festetlen (aszfalt) sáv ehhez képest alig
  // 1 százaléknyi terület. Emiatt a teljes bounds (a modell teljes
  // határdoboza) hatalmas ürességet ad a vékony pálya-szalag köré. Ezért
  // az ASZFALT pixelek határdobozára vágunk — ez tömören a pálya köré
  // simul, bármi más (díszlet, üres terület) kimarad.
  let minU = w, maxU = -1, minV = h, maxV = -1;
  for (let v = 0; v < h; v++) {
    const row = v * w;
    for (let u = 0; u < w; u++) {
      if (codes[row + u] !== ZONE_ASPHALT) continue;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
  }
  if (maxU < minU) { // nincs aszfalt pixel — nincs mit szűkíteni
    minU = 0; maxU = w - 1; minV = 0; maxV = h - 1;
  }
  const padU = Math.round((maxU - minU) * 0.06) + 4;
  const padV = Math.round((maxV - minV) * 0.06) + 4;
  minU = Math.max(0, minU - padU);
  maxU = Math.min(w - 1, maxU + padU);
  minV = Math.max(0, minV - padV);
  maxV = Math.min(h - 1, maxV + padV);
  const cropW = maxU - minU + 1;
  const cropH = maxV - minV + 1;

  // A dilatáció (lásd lejjebb) a szomszédokat is nézi, ezért a TELJES
  // képen kell számolni, nem a már kivágotton — utána vágunk csak a kis
  // rárajzoláshoz.
  const radius = Math.max(2, Math.round(Math.max(cropW, cropH) / 400));
  const rowPass = new Uint8Array(w * h);
  for (let y = minV; y <= maxV; y++) {
    const row = y * w;
    let count = 0;
    for (let x = minU - radius; x <= maxU; x++) {
      const add = x + radius;
      if (add <= maxU && add >= 0 && codes[row + add] === ZONE_ASPHALT) count++;
      const rem = x - radius - 1;
      if (rem >= minU && codes[row + rem] === ZONE_ASPHALT) count--;
      if (x >= minU) rowPass[row + x] = count > 0 ? 1 : 0;
    }
  }
  const dilated = new Uint8Array(cropW * cropH);
  for (let x = minU; x <= maxU; x++) {
    let count = 0;
    for (let y = minV - radius; y <= maxV; y++) {
      const add = y + radius;
      if (add <= maxV && add >= 0 && rowPass[add * w + x]) count++;
      const rem = y - radius - 1;
      if (rem >= minV && rowPass[rem * w + x]) count--;
      if (y >= minV) dilated[(y - minV) * cropW + (x - minU)] = count > 0 ? 1 : 0;
    }
  }

  const full = document.createElement('canvas');
  full.width = cropW;
  full.height = cropH;
  const fullCtx = full.getContext('2d');
  const imgData = fullCtx.createImageData(cropW, cropH);
  for (let i = 0; i < dilated.length; i++) {
    if (!dilated[i]) continue;
    const o = i * 4;
    imgData.data[o] = 210; imgData.data[o + 1] = 214; imgData.data[o + 2] = 222; imgData.data[o + 3] = 235;
  }
  fullCtx.putImageData(imgData, 0, 0);

  // Fokozatos (mindig felező) kicsinyítés — egy nagy ugrás elmosná a
  // vonalat, több lépésben félig-félig zsugorítva sokkal jobban megmarad
  // (a klasszikus mipmap-trükk).
  let cur = full;
  while (cur.width > MINIMAP_TARGET * 2 || cur.height > MINIMAP_TARGET * 2) {
    const next = document.createElement('canvas');
    next.width = Math.max(1, Math.round(cur.width / 2));
    next.height = Math.max(1, Math.round(cur.height / 2));
    next.getContext('2d').drawImage(cur, 0, 0, next.width, next.height);
    cur = next;
  }
  miniMapTrackCanvas = cur;

  // A kivágott pixel-tartományt visszaváltjuk világkoordinátákra — ez lesz
  // a kocsi-pötty pozicionálásának vonatkoztatási kerete (NEM a teljes
  // zonemap.bounds).
  const b = runtime.bounds;
  miniMapBounds = {
    minX: b.minX + (minU / w) * (b.maxX - b.minX),
    maxX: b.minX + ((maxU + 1) / w) * (b.maxX - b.minX),
    minZ: b.minZ + (minV / h) * (b.maxZ - b.minZ),
    maxZ: b.minZ + ((maxV + 1) / h) * (b.maxZ - b.minZ),
  };

  // A kijelzett canvas méretét a kivágott terület arányához igazítjuk,
  // hogy a térkép ne torzuljon (nyújtás/összenyomás) egy kényszerített
  // négyzetbe.
  const aspect = (miniMapBounds.maxX - miniMapBounds.minX) / (miniMapBounds.maxZ - miniMapBounds.minZ);
  if (aspect >= 1) {
    miniMapCanvas.width = MINIMAP_TARGET;
    miniMapCanvas.height = Math.round(MINIMAP_TARGET / aspect);
  } else {
    miniMapCanvas.height = MINIMAP_TARGET;
    miniMapCanvas.width = Math.round(MINIMAP_TARGET * aspect);
  }
}

// A többi játékos pöttyei a minitérképen. Multiplayerben a hálózati modul
// tölti fel (setMiniMapMarkers), egyjátékosban üres. A saját színt külön
// tartjuk, hogy a HUD-listán és itt UGYANAZ látszódjon.
let miniMapMarkers = [];
let miniMapSelfColor = null;

function drawMiniMapDot(x, z, color, radius) {
  const w = miniMapCanvas.width;
  const h = miniMapCanvas.height;
  const b = miniMapBounds;
  const px = ((x - b.minX) / (b.maxX - b.minX)) * w;
  const py = ((z - b.minZ) / (b.maxZ - b.minZ)) * h;
  miniMapCtx.beginPath();
  miniMapCtx.arc(px, py, radius, 0, Math.PI * 2);
  miniMapCtx.fillStyle = color;
  miniMapCtx.strokeStyle = 'rgba(0,0,0,0.6)';
  miniMapCtx.lineWidth = 1.5;
  miniMapCtx.fill();
  miniMapCtx.stroke();
}

function updateMiniMap(carX, carZ) {
  const w = miniMapCanvas.width;
  const h = miniMapCanvas.height;
  miniMapCtx.clearRect(0, 0, w, h);
  if (!miniMapBounds || !miniMapTrackCanvas) return;
  miniMapCtx.drawImage(miniMapTrackCanvas, 0, 0, w, h);

  // A többiek ELŐBB, hogy a saját pötty mindig a legfelső legyen — egymáson
  // állva is tudni akarjuk, hol vagyunk.
  for (const m of miniMapMarkers) drawMiniMapDot(m.x, m.z, m.color, 4);
  drawMiniMapDot(carX, carZ, miniMapSelfColor || '#ff3b3b', 5.5);
}

function sampleZoneAt(x, z) {
  return sampleZone(zoneRuntime, x, z);
}

// A falkezelés és a "mind a négy kerék lement" szabály a shared/zone.js-ben
// van, mert multiplayerben a SZERVER is pontosan ugyanezt futtatja — a kliens
// pedig előre jósolja. Itt csak az aktuális kocsira kötjük rá.
const WALL_PROBES = wallProbes(chassisSize);
const WHEEL_PROBES = wheelProbes(WHEEL_POSITIONS);
// Hol volt a kocsi utoljára érvényes (nem fal) helyen.
const lastSafePos = { x: 0, y: 0, z: 0 };

const allWheelsOffTrack = () => sharedAllWheelsOffTrack(zoneRuntime, chassisBody, WHEEL_PROBES);
// Kerekenkénti kifutó-jelzés a tapadáshoz. UGYANAZOK a mintavételi pontok,
// mint a kör érvényességénél — a játék eddig is kerekenként mintázott, csak
// épp a tapadásnál nem használtuk ki.
const wheelsOffTrack = () => sharedWheelsOffTrack(zoneRuntime, chassisBody, WHEEL_PROBES);
const carTouchesWall = () => sharedCarTouchesWall(zoneRuntime, chassisBody, WALL_PROBES);
const applyWallConstraint = () =>
  sharedApplyWallConstraint(chassisBody, zoneRuntime, lastSafePos, WALL_PROBES);

// A látható kerekek beállítása a fizikából: gördülés minden keréken,
// kormányzás csak az elsőkön. A pivot Euler-sorrendje YXZ, ezért a gördülés
// (X) a kerék saját tengelye körül történik, és utána forgatja el a
// kormányzás (Y) — fordított sorrendben csálén állna a kerék.
let visualSteerAngle = 0;
function updateWheelVisuals(dt) {
  if (!wheelPivots.length) return;
  // Az első kerekek (wheelSources[i].steer) ugyanazt a fizikai kormányzási
  // értéket kapják (lásd updateControls: setWheelSteering(0,...)/(1,...) azonos
  // értékkel) — elég egyszer lekérdezni, melyiket, és afelé simán közelíteni.
  let steerWheelIdx = -1;
  for (let i = 0; i < wheelSources.length; i++) {
    if (wheelSources[i].steer) { steerWheelIdx = wheelSources[i].wheel; break; }
  }
  const targetSteer = steerWheelIdx >= 0 ? (vehicle.wheelSteering(steerWheelIdx) ?? 0) : 0;
  visualSteerAngle = moveTowardsAngle(visualSteerAngle, targetSteer, STEER_VISUAL_SPEED * dt);

  for (let i = 0; i < wheelPivots.length; i++) {
    const src = wheelSources[i];
    const roll = vehicle.wheelRotation(src.wheel) ?? 0;
    const steer = src.steer ? visualSteerAngle : 0;
    wheelPivots[i].rotation.set(roll, steer, 0);

    // ---- A kerék MAGASSÁGA: a fizikai érintkezési pontra illesztve ----
    // Korábban a látható kerék mereven a kasztnihoz volt szögezve, ami egy
    // felfüggesztéses járműnél alapból hibás: a kerék a talajon gördül, és a
    // kasztni mozog HOZZÁ képest, nem fordítva. A kocsi súlya alatt a rugó
    // 30 cm-ről ~23-ra nyomódik, és a gumi ennyivel az aszfalt alá került.
    //
    // Itt nem becslünk és nem korrigálunk: mindkét oldal MÉRT adat.
    //  - a fizikából tudjuk, hol ér földet ez a kerék a kasztnihoz képest:
    //    a rácsatlakozási pont alatt a rugóhossznyival van a kerék közepe,
    //    az alatt a keréksugárnyival az érintkezési pont;
    //  - a modellből betöltéskor megmértük, milyen mélyen van a gumi alja a
    //    pivot origójához képest (bottomOffset).
    // A kettőből a pivot helye egyenesen adódik. Nincs benne konstans, nincs
    // kocsinkénti hangolótábla — bármekkora gumival és bárhol álló
    // pivot-origóval magától a helyére kerül, kerekenként külön (tehát
    // rázókövön, bukkanón és kanyarban dőlve is a valódi rugóutat mutatja).
    //
    // A dev panel csúszkái (merevség, kompresszió, relaxáció, max. löket)
    // ezért maguktól hatnak: a rugóhossz képkockánként a fizikától jön, a
    // bottomOffset pedig tisztán geometria, amit a hangolás nem érint.
    const len = vehicle.wheelSuspensionLength(src.wheel) ?? SUSPENSION_REST_LENGTH;
    const contactY = WHEEL_POSITIONS[src.wheel].y - len - WHEEL_RADIUS;
    wheelPivots[i].position.y = contactY - wheelPivots[i].userData.bottomOffset;
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
  nextCheckpoint: 0,  // hányadik checkpoint jön SORRENDBEN (ezen múlik a taint)
  // Mely kapukat érintette ebben a körben, sorrendtől függetlenül. A kör
  // lezárásához ez kell, nem a nextCheckpoint: az egy sorrend-mutató, ami a
  // kihagyott kapun megáll, tehát a mögötte begyűjtöttekről semmit nem mond.
  passed: new Set(),
  startTime: 0,
  lapStartTime: 0,
  lapTimes: [],       // { time, invalid } — az érvénytelen kör is SZÁMÍT, csak meg van jelölve
  lapTainted: false,  // elromlott-e már ez a kör (kihagyott checkpoint vagy letérés)
  taintReason: TAINT.NONE,  // TAINT kódja — mi rontotta el a kört
  prevX: 0,
  prevZ: 0,
  invalidUntil: 0,  // performance.now() időbélyeg, ameddig a "kör érvénytelen" üzenet látszik
  hasCrossedStart: false,  // a rajtpont a rajtvonal ELŐTT van, ezért az induláskori
                           // első átlépés csak a kört KEZDI, nem zárja le
};

// A nagy 3-2-1 kiírás ÉS a hozzá tartozó hang — egy helyen, mert az
// egyjátékos versenylogika és a multiplayer (a szerver órájából, a mp.js-en át)
// is ezt hívja. A hang nem képkockánként szól, hanem csak amikor a kiírt SZÁM
// megváltozik: ezt hívó képkockánként hívja mindkét ág, tehát egy egyszerű
// "mi volt legutóbb" összehasonlítás kell hozzá.
//
// A rajt (0-ra váltás) más hangot kap, mint a számok. A hangmagasság-ugrás az,
// amitől félrehallás nélkül tudod, hogy indulhatsz, anélkül hogy a képernyő
// közepére kellene néznod.
// A kezdőérték 0, nem null: a "nincs visszaszámlálás" állapot maga is 0, tehát
// innen a legelső 3-as is VÁLTOZÁS, és megkapja a bipet. (Multiplayerben a
// mp.js képkockánként hívja 0-val, amíg nem megy a visszaszámlálás — az így
// némán marad.)
let lastCountdownShown = 0;

function showCountdown(secondsLeft) {
  const n = !secondsLeft || secondsLeft <= 0 ? 0 : secondsLeft;
  if (n !== lastCountdownShown) {
    if (n === 0) startBeep();
    else countdownBeep();
    lastCountdownShown = n;
  }
  countdownEl.classList.toggle('hidden', n === 0);
  if (n > 0) countdownEl.textContent = String(n);
}

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

// Az R-re ide tesszük vissza a kocsit: a kapu FELEZŐPONTJÁRA, nem oda, ahol a
// játékos áthaladt rajta. A kapuk szélesek (átérnek az aszfalton túlra is),
// tehát az átlépés pontja simán lehet a kifutón vagy a fal mellett — onnan
// visszaindulni büntetés lenne. A vonalat viszont mindig úgy húzzuk be, hogy a
// közepe az aszfalt közepére essen, tehát az biztosan használható rajtpont.
// (Ugyanez a számítás fut a szerveren is — lásd server/game/raceSim.js.)
function gateMidpoint(gate) {
  return { x: (gate.x1 + gate.x2) / 2, z: (gate.z1 + gate.z2) / 2 };
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
  // Biztonsági háló: ha a dev autó-tesztelőben hangoltunk (élő motorerő/fék/
  // tapadás), egy valódi versenynek MINDIG a kanonikus értékekkel kell
  // indulnia, függetlenül attól, hogyan hagytuk ott a dev módot.
  resetLiveVehicleTunables();
  const pos = chassisBody.translation();
  race.active = !!currentGates.start;
  race.phase = 'countdown';
  race.countdownLeft = COUNTDOWN_SECONDS;
  race.totalLaps = Number(lapCountSelect.value) || 3;
  race.lap = 0;
  race.nextCheckpoint = 0;
  race.passed.clear();
  race.lapTimes = [];
  race.lapTainted = false;
  race.taintReason = TAINT.NONE;
  race.prevX = pos.x;
  race.prevZ = pos.z;
  race.invalidUntil = 0;
  race.hasCrossedStart = false;
  lastCheckpointSpawn = { x: spawnPoint.x, z: spawnPoint.z, heading: spawnHeading };
  resultsEl.classList.add('hidden');
  lapInvalidAlertEl.classList.add('hidden');
  updateRaceHud();
}

// A "kör érvénytelen" szöveg — EGY helyen, mert az egyjátékos versenylogika és
// a multiplayer (a szerver snapshotjának `ti` mezője) ugyanezt írja ki. A kettő
// korábban elcsúszott: multiplayerben csak egy általános "Kör érvénytelen!"
// jött, amiből a játékos nem tudta, mit rontott el.
function lapInvalidText(reason) {
  if (reason === TAINT.OFFTRACK) return 'Kör érvénytelen — mind a négy kerékkel letértél az aszfaltról!';
  // A kihagyott checkpoint nem "érvénytelenít", hanem meg sem engedi a kör
  // lezárását — a szöveg ezt mondja meg, hogy a játékos tudja: nem elég
  // átgurulni a rajtvonalon, tényleg körbe kell menni.
  if (reason === TAINT.CHECKPOINT) return 'Checkpoint kimaradt — a kör csak akkor számít, ha mindegyiken áthaladsz!';
  return 'Kör érvénytelen!';
}

// A sebességpanel alatti zóna-jelvény. Az egyjátékos HUD és a multiplayer
// képkocka is ezt hívja, hogy a felirat ÉS a színezés (data-zone, lásd a
// CSS-t az index.html-ben) biztosan ugyanaz legyen a két módban.
function updateZoneIndicator(x, z) {
  const zone = carTouchesWall() ? 'wall' : sampleZoneAt(x, z) === ZONE_OFFTRACK ? 'offtrack' : 'asphalt';
  zoneIndicatorEl.dataset.zone = zone;
  zoneIndicatorEl.textContent =
    zone === 'wall' ? 'fal' : zone === 'offtrack' ? 'kifutó' : 'aszfalt';
}

function updateRaceHud() {
  if (!race.active) {
    raceHudEl.innerHTML = '<div class="hud-note">Nincs rajtvonal — szabad vezetés</div>';
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
    '<div class="lap-head">' +
      '<span class="lbl">Kör</span>' +
      `<span><span class="lap-now num">${Math.min(race.lap + 1, race.totalLaps)}</span>` +
      `<span class="lap-total num"> / ${race.totalLaps}</span></span>` +
    '</div>' +
    (race.lapTainted ? '<div class="t-warn mb-2">⚠ Ez a kör érvénytelen</div>' : '') +
    `<div class="t-row"><span class="lbl">Aktuális</span><span class="t-val num">${formatTime(current)}</span></div>` +
    // A zöld kiemelés csak akkor jár, ha VAN már érvényes köridő — enélkül a
    // "--:--.---" is zölden világítana, mintha eredmény lenne.
    `<div class="t-row${Number.isFinite(best) ? ' is-best' : ''}">` +
      `<span class="lbl">Legjobb</span><span class="t-val num">${formatTime(best)}</span></div>` +
    `<div class="t-row"><span class="lbl">Összes</span><span class="t-val num">${formatTime(total)}</span></div>`;
  // A figyelmeztetés nem néhány másodperc után tűnik el, hanem addig marad,
  // amíg a folyamatban lévő kör tart — a játékos végig lássa, hogy ez a kör
  // már nem számít. A rajtvonalnál a lapTainted nullázódik, ezzel együtt ez is.
  if (race.taintReason) {
    lapInvalidAlertTextEl.textContent = lapInvalidText(race.taintReason);
  }
  lapInvalidAlertEl.classList.toggle('hidden', !race.lapTainted && now >= race.invalidUntil);
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
    '<div class="res-hero">' +
      `<div><span class="lbl">Összidő</span><span class="res-big num">${formatTime(total)}</span></div>` +
      `<div><span class="lbl">Legjobb kör</span><span class="res-big num">${formatTime(best)}</span></div>` +
    '</div>' +
    race.lapTimes
      .map((l, i) => {
        const tag = l.invalid
          ? '<span class="res-tag bad">érvénytelen</span>'
          : l.time === best ? '<span class="res-tag best">legjobb</span>' : '';
        return '<div class="res-lap">' +
          `<span class="res-lap-i">${i + 1}. kör</span>` +
          `<span>${tag}<span class="num ms-2">${formatTime(l.time)}</span></span>` +
        '</div>';
      })
      .join('');
  resultsEl.classList.remove('hidden');
}

function updateRace(dt) {
  if (!race.active) return;

  if (race.phase === 'countdown') {
    // A visszaszámlálás alatt a felfüggesztés beállása / gravitáció miatt is
    // mozoghat kicsit a kocsi — ha prevX/prevZ a rajt pillanatában rögzített
    // (régi) pozíción maradna, az első futó képkockán ez a "szegmens" hamisan
    // metszhetné a rajtvonalat, és azonnal (0 checkpontos, tehát érvénytelen)
    // kört zárna, mielőtt a játékos egyáltalán elindult volna. Ezért itt is
    // folyamatosan frissítjük.
    const p = chassisBody.translation();
    race.prevX = p.x;
    race.prevZ = p.z;
    race.countdownLeft -= dt;
    if (race.countdownLeft <= 0) {
      race.phase = 'running';
      race.startTime = performance.now();
      race.lapStartTime = race.startTime;
      showCountdown(0);
    } else {
      // A kijelzést (és vele a hangot) a közös showCountdown végzi — korábban ez
      // az ág maga írta a countdownEl-t, a multiplayer viszont a setCountdown-on
      // ment. Két külön út két külön hang-bekötést jelentett volna, ami előbb-
      // utóbb elcsúszik egymástól.
      showCountdown(Math.ceil(race.countdownLeft));
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

  // A kört a rajtvonal zárja le, de CSAK akkor, ha közben minden checkpoint
  // megvolt. Enélkül a rajtvonalon oda-vissza gurulva végig lehetett "menni" a
  // versenyen, mert a crossedGate iránytól függetlenül metsz szakaszt.
  //
  // Ennek ára van: aki kihagy egy kaput, annak a nextCheckpoint azon a kapun
  // marad, tehát a kör csak a KÖVETKEZŐ körben zárul le, amikor visszaér oda.
  // Egy hiba így egy egész körbe kerül — nem holtpont, de nem is a régi,
  // elnéző szabály (ott a kör lezárult, csak "érvénytelen" jelzést kapott).
  if (crossedCheckpoint !== -1) {
    // A Set miatt ugyanaz a kapu kétszer sem számít duplán.
    race.passed.add(crossedCheckpoint);
    lastCheckpointSpawn = {
      ...gateMidpoint(checkpoints[crossedCheckpoint]),
      heading: headingFromMovement(fromX, fromZ, pos.x, pos.z, lastCheckpointSpawn?.heading ?? spawnHeading),
    };
    if (crossedCheckpoint === race.nextCheckpoint) {
      race.nextCheckpoint++;
    } else if (crossedCheckpoint > race.nextCheckpoint) {
      // Előrébb lévő kapu: valahol kihagyott egyet. Azonnal jelezzük, de
      // hagyjuk tovább menni — a rajtvonalnál dől el, hogy a kör érvénytelen
      // volt.
      //
      // Egy MÁR MEGSZERZETT kapu újbóli átlépése viszont NEM hiba: a
      // crossedGate iránytól függetlenül metsz szakaszt, tehát egy megcsúszás
      // vagy pördülés ugyanazon a vonalon másodszor is "átlépés". Korábban ez
      // csalás nélkül is elrontotta a kört. (Ugyanez a szabály fut a
      // szerveren — a két oldal nem térhet el.)
      race.lapTainted = true;
      race.taintReason = TAINT.CHECKPOINT;
      race.invalidUntil = now + 2500;
    }
  }

  // Teljes letérés az aszfaltról: a valódi F1-ben a kör akkor vész el, ha
  // MIND A NÉGY kerék a pályán kívülre kerül — egy kerékkel még bent lehet
  // maradni. Ugyanaz a kezelés, mint a kihagyott checkpointnál: a kör
  // érvénytelen lesz, de a versenyben tovább lehet menni.
  if (!race.lapTainted && allWheelsOffTrack()) {
    race.lapTainted = true;
    race.taintReason = TAINT.OFFTRACK;
  }

  if (startCrossed && !race.hasCrossedStart) {
    // A rajtpont a rajtvonal előtt van: ez az első átlépés csak azt jelenti,
    // hogy a játékos elindult a rajtvonalon túlra — ez KEZDI az 1. kört, nem
    // zárja le, ezért nem számít bele a körökbe/időkbe.
    race.hasCrossedStart = true;
    race.lapStartTime = now;
    lastCheckpointSpawn = {
      ...gateMidpoint(currentGates.start),
      heading: headingFromMovement(fromX, fromZ, pos.x, pos.z, lastCheckpointSpawn?.heading ?? spawnHeading),
    };
  } else if (startCrossed && race.passed.size < requiredCheckpoints(checkpoints.length)) {
    // TÚL KEVÉS kapu: a kör NEM zárul le. Enélkül a rajtvonalon oda-vissza
    // gurulva végig lehetett "teljesíteni" a versenyt — a crossedGate iránytól
    // független, tehát minden áthaladás számított. (Ugyanez a szabály fut a
    // szerveren is; a két oldal nem térhet el.)
    race.lapTainted = true;
    race.taintReason = TAINT.CHECKPOINT;
    race.invalidUntil = now + 2500;
  } else if (startCrossed) {
    // A kör lezárul — de ha bármi hiányzott vagy lement a pályáról, akkor
    // érvénytelenül. A kör SZÁMÍT (nem kell újrázni), csak a legjobb körbe nem
    // megy bele.
    if (race.passed.size < checkpoints.length) {
      race.lapTainted = true;
      race.taintReason = TAINT.CHECKPOINT;
    }
    const invalid = race.lapTainted;
    race.lapTimes.push({ time: now - race.lapStartTime, invalid });
    race.lapStartTime = now;
    race.lap++;
    race.nextCheckpoint = 0;
    race.passed.clear();
    race.lapTainted = false;
    if (invalid) race.invalidUntil = now + 2500;
    lastCheckpointSpawn = {
      ...gateMidpoint(currentGates.start),
      heading: headingFromMovement(fromX, fromZ, pos.x, pos.z, lastCheckpointSpawn?.heading ?? spawnHeading),
    };
    if (race.lap >= race.totalLaps) finishRace();
  }

  updateRaceHud();
}

// ---------- Irányítás (csak vezetés közben aktív) ----------
const keys = {};
const keyboardKeys = new Set();
const touchKeyCounts = new Map();
const touchPointers = new Map();
const touchAxes = { steer: 0, pedal: 0 };
const joystickStates = new Map();
const JOYSTICK_DEADZONE = 0.1;

function refreshControlKey(code) {
  keys[code] = keyboardKeys.has(code) || (touchKeyCounts.get(code) || 0) > 0;
}

window.addEventListener('keydown', (e) => {
  keyboardKeys.add(e.code);
  refreshControlKey(e.code);
});
window.addEventListener('keyup', (e) => {
  keyboardKeys.delete(e.code);
  refreshControlKey(e.code);
});

function releaseTouchPointer(pointerId) {
  const held = touchPointers.get(pointerId);
  if (!held) return;
  touchPointers.delete(pointerId);
  const remaining = Math.max(0, (touchKeyCounts.get(held.code) || 1) - 1);
  if (remaining) touchKeyCounts.set(held.code, remaining);
  else touchKeyCounts.delete(held.code);
  held.button.classList.remove('is-pressed');
  refreshControlKey(held.code);
}

function clearTouchInputs() {
  const codes = new Set([...touchPointers.values()].map((held) => held.code));
  for (const held of touchPointers.values()) held.button.classList.remove('is-pressed');
  touchPointers.clear();
  touchKeyCounts.clear();
  for (const code of codes) refreshControlKey(code);

  for (const [joystick, state] of joystickStates) {
    state.pointerId = null;
    state.knob.style.transform = 'translate3d(-50%, -50%, 0)';
    joystick.classList.remove('is-active');
    joystick.setAttribute('aria-valuenow', '0');
  }
  touchAxes.steer = 0;
  touchAxes.pedal = 0;
}

function setTouchControlsEnabled(enabled) {
  touchControlsEl.classList.toggle('is-disabled', !enabled);
  touchControlsEl.querySelectorAll('[data-touch-joystick]').forEach((joystick) => {
    joystick.setAttribute('aria-disabled', String(!enabled));
  });
  touchControlsEl.querySelectorAll('button').forEach((button) => {
    button.disabled = !enabled && button.dataset.touchAction !== 'mute';
  });
  if (!enabled) clearTouchInputs();
}

function normalizeJoystickAxis(raw) {
  const value = Math.max(-1, Math.min(1, raw));
  const magnitude = Math.abs(value);
  if (magnitude <= JOYSTICK_DEADZONE) return 0;
  return Math.sign(value) * (magnitude - JOYSTICK_DEADZONE) / (1 - JOYSTICK_DEADZONE);
}

function updateJoystickFromPointer(joystick, state, event) {
  const rect = joystick.getBoundingClientRect();
  const radius = rect.width / 2;
  const knobRadius = state.knob.getBoundingClientRect().width / 2;
  const travel = Math.max(0, radius - knobRadius - 7);
  const centerX = rect.left + radius;
  const centerY = rect.top + radius;

  // A kör alakú karok szándékosan egytengelyesek: a kormány csak vízszintesen,
  // a pedál csak függőlegesen mozog. Így az ujj oldalirányú sodródása nem vesz
  // el gázt, a függőleges sodródás pedig nem rángatja meg a kormányt.
  const raw = state.axis === 'x'
    ? (event.clientX - centerX) / radius
    : (centerY - event.clientY) / radius;
  const clamped = Math.max(-1, Math.min(1, raw));
  const value = normalizeJoystickAxis(clamped);
  touchAxes[state.output] = state.invert ? -value : value;

  const offset = clamped * travel;
  const x = state.axis === 'x' ? offset : 0;
  const y = state.axis === 'y' ? -offset : 0;
  state.knob.style.transform = `translate3d(calc(-50% + ${x}px), calc(-50% + ${y}px), 0)`;
  joystick.classList.toggle('is-active', Math.abs(value) > 0);
  joystick.setAttribute('aria-valuenow', String(Math.round(touchAxes[state.output] * 100)));
}

touchControlsEl.querySelectorAll('[data-touch-joystick]').forEach((joystick) => {
  const kind = joystick.dataset.touchJoystick;
  const state = {
    pointerId: null,
    knob: joystick.querySelector('.joystick-knob'),
    axis: kind === 'steer' ? 'x' : 'y',
    output: kind,
    // A fizika előjel-konvenciója szerint +1 a balra kormányzás.
    invert: kind === 'steer',
  };
  joystickStates.set(joystick, state);

  joystick.addEventListener('pointerdown', (event) => {
    if (touchControlsEl.classList.contains('is-disabled') || state.pointerId !== null) return;
    event.preventDefault();
    state.pointerId = event.pointerId;
    updateJoystickFromPointer(joystick, state, event);
    try { joystick.setPointerCapture(event.pointerId); } catch { /* pointer már megszűnt */ }
  });
  joystick.addEventListener('pointermove', (event) => {
    if (state.pointerId !== event.pointerId) return;
    event.preventDefault();
    updateJoystickFromPointer(joystick, state, event);
  });
  const release = (event) => {
    if (state.pointerId !== event.pointerId) return;
    state.pointerId = null;
    touchAxes[state.output] = 0;
    state.knob.style.transform = 'translate3d(-50%, -50%, 0)';
    joystick.classList.remove('is-active');
    joystick.setAttribute('aria-valuenow', '0');
  };
  joystick.addEventListener('pointerup', release);
  joystick.addEventListener('pointercancel', release);
  joystick.addEventListener('lostpointercapture', release);
  joystick.addEventListener('contextmenu', (event) => event.preventDefault());
});

function getDriveAxes() {
  const keyboardSteer = (keys['KeyA'] || keys['ArrowLeft'])
    ? 1
    : (keys['KeyD'] || keys['ArrowRight']) ? -1 : null;
  const keyboardPedal = (keys['KeyW'] || keys['ArrowUp'])
    ? 1
    : (keys['KeyS'] || keys['ArrowDown']) ? -1 : null;
  return {
    steer: keyboardSteer ?? touchAxes.steer,
    pedal: keyboardPedal ?? touchAxes.pedal,
  };
}

// A megmaradt digitális touch gomb (kézifék) ugyanabba a `keys` állapotba fut,
// mint a billentyűzet. A két analóg joystick külön tengelyértéket tart fenn.
touchControlsEl.querySelectorAll('[data-touch-key]').forEach((button) => {
  const code = button.dataset.touchKey;
  button.addEventListener('pointerdown', (event) => {
    if (button.disabled || touchPointers.has(event.pointerId)) return;
    event.preventDefault();
    touchPointers.set(event.pointerId, { code, button });
    touchKeyCounts.set(code, (touchKeyCounts.get(code) || 0) + 1);
    button.classList.add('is-pressed');
    refreshControlKey(code);
    try { button.setPointerCapture(event.pointerId); } catch { /* pointer már megszűnt */ }
  });
  const release = (event) => releaseTouchPointer(event.pointerId);
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('lostpointercapture', release);
  button.addEventListener('contextmenu', (event) => event.preventDefault());
});

touchControlsEl.querySelector('[data-touch-action="camera"]').addEventListener('pointerdown', (event) => {
  event.preventDefault();
  if (appState === 'driving' || appState === 'mp') cycleCameraView();
});
const touchMuteBtn = touchControlsEl.querySelector('[data-touch-action="mute"]');

function syncTouchMuteButton() {
  const muted = isMuted();
  touchMuteBtn.textContent = muted ? '🔇' : '🔊';
  touchMuteBtn.classList.toggle('is-muted', muted);
  touchMuteBtn.setAttribute('aria-label', muted ? 'Hang bekapcsolása' : 'Némítás');
  touchMuteBtn.title = muted ? 'Hang bekapcsolása' : 'Némítás';
}

function syncVolumeControl() {
  const percent = Math.round(getVolume() * 100);
  volumeSliderEl.value = String(percent);
  volumeValueEl.value = `${percent}%`;
  volumeValueEl.textContent = `${percent}%`;
}

function toggleMuted() {
  saveLastChoice('muted', setMuted(!isMuted()) ? '1' : '0');
  syncTouchMuteButton();
}

touchMuteBtn.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  toggleMuted();
});
volumeSliderEl.addEventListener('input', () => {
  const volume = setVolume(Number(volumeSliderEl.value) / 100);
  saveLastChoice('volume', String(volume));
  saveLastChoice('muted', setMuted(volume === 0) ? '1' : '0');
  syncVolumeControl();
  syncTouchMuteButton();
});
touchControlsEl.querySelector('[data-touch-action="reset"]').addEventListener('pointerdown', (event) => {
  event.preventDefault();
  if (appState === 'driving') resetSinglePlayerCar();
  else if (appState === 'mp') window.dispatchEvent(new Event('racing:reset-request'));
});

window.addEventListener('blur', () => {
  keyboardKeys.clear();
  clearTouchInputs();
  resetManualOrbit();
  for (const code of Object.keys(keys)) refreshControlKey(code);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTouchInputs();
    resetManualOrbit();
  }
});

// A kameranézet váltása egyszeri esemény, nem folytatólagos állapot (mint a
// mozgásgombok) — ezért NEM a `keys` térképen, hanem egy külön 'keydown'
// eseményen, `e.repeat` szűréssel: a `keys`-es megoldás nyomva tartva
// képkockánként újra váltana.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyC' || e.repeat) return;
  if (appState !== 'driving' && appState !== 'mp') return;
  cycleCameraView();
});

// Némítás. Szándékosan MINDEN állapotban működik (a menüben is), nem csak
// vezetés közben: aki le akarja némítani a játékot, az általában épp azelőtt
// akarja, hogy megszólalna. A választás megmarad a következő indulásra is.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyM' || e.repeat) return;
  // Gépelés közben (pl. a multiplayer névmezőjében) az M betű maradjon betű.
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
  toggleMuted();
});

// A LÁTHATÓ kerék-kormányzás simán közelít a célértékhez, nem ugrik rá
// azonnal — valóságosabb, mint a korábbi azonnali végállás-váltás, de elég
// gyors ahhoz, hogy gyors ide-oda kormányzásnál se maradjon el az input
// mögött. Csak a MEGJELENÍTÉST érinti (a fizikai kormányzás — setWheelSteering
// — továbbra is azonnali, hogy a kocsi kezelése ne változzon).
function moveTowardsAngle(current, target, maxDelta) {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

function resetSinglePlayerCar() {
  const pos = chassisBody.translation();
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

// A motorerő, a fékerők, a kézifék-csúszás és a kifutó-szorzók a
// shared/vehicleConfig.js-ben laknak, az applyControls()-szal együtt — az
// indoklásuk (miért nem lehet a fék akármilyen erős, honnan jön a drift) is
// ott olvasható, egy helyen az értékekkel.

function updateControls(dt = 1 / 60) {
  // Visszaszámlálás alatt és a verseny után nincs gáz/kormány — a kocsi
  // a helyén marad, hogy ne lehessen elrajtolni a "rajt" előtt.
  const frozen = race.active && (race.phase === 'countdown' || race.phase === 'finished');
  const driveAxes = getDriveAxes();
  const pedal = frozen ? 0 : driveAxes.pedal;
  const steer = frozen ? 0 : driveAxes.steer;
  const forwardAmount = Math.max(0, pedal);
  const backwardAmount = Math.max(0, -pedal);
  const backwardHeld = backwardAmount > 0;

  // Amíg még előre gördül a kocsi, az S/le nyíl FÉKEZZEN (a valódi wheelBrake
  // mechanikával), ne a REVERSE_FACTOR-ral szorzott, sokkal gyengébb
  // "motor-fékezéssel" próbálkozzon — csak megálláshoz közel váltson tényleges
  // hátramenetbe. Sok versenyjátékban ez a megszokott S viselkedés, és ez volt
  // az, ami hiányzott: eddig az S NEM hívta a fék-mechanikát, ezért a fékerő
  // hangolásának semmi érzékelhető hatása nem volt.
  const q0 = chassisBody.rotation();
  const v0 = chassisBody.linvel();
  const fwdSpeed = forwardSpeed(q0.x, q0.y, q0.z, q0.w, v0.x, v0.y, v0.z);
  const brake = backwardHeld && fwdSpeed > REVERSE_BRAKE_THRESHOLD ? backwardAmount : 0;
  const reverseAmount = backwardHeld && !brake ? backwardAmount : 0;
  // A Space innentől KÉZIFÉK (csak hátsó kerék + kitörő hátulja), nem a sima
  // fék — a kettő szétválasztásáról lásd shared/vehicleConfig.js applyControls.
  const handbrake = !frozen && !!keys['Space'];

  const pos = chassisBody.translation();
  updateMiniMap(pos.x, pos.z);
  const linvel = chassisBody.linvel();
  const speedKmh = Math.hypot(linvel.x, linvel.z) * 3.6;
  speedValueEl.textContent = Math.round(speedKmh);
  updateZoneIndicator(pos.x, pos.z);
  // A motorhang a sebességből és a gázállásból él. A visszaszámlálás alatt a
  // kocsi be van fagyasztva (frozen), de a motor JÁR — ezért a gázt nem a
  // befagyasztott `forward`-ból vesszük: a rajt előtti gázadás hallatszódjon.
  updateEngine(speedKmh, Math.max(0, driveAxes.pedal), dt);
  // A tényleges vezérlés a KÖZÖS applyControls()-ban van — ugyanaz a kód fut
  // itt és a szerveren. A billentyűket normalizált bemenetté fordítjuk, pont
  // olyanná, amilyet a mp.js is küld a hálózaton.
  applyControls(
    vehicle,
    chassisBody,
    {
      throttle: forwardAmount || -reverseAmount,
      steer,
      brake,
      handbrake,
    },
    { offtrackWheels: wheelsOffTrack(), frozen }
  );

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

  if (keys['KeyR']) resetSinglePlayerCar();
}

// ---------- Kamera: vezetős nézetek, C-vel váltva ----------
// A `fpv` nézetnél a kamera a kocsi motorháztetője fölé kerül, és nem
// simítjuk a mozgását (a fej/motorháztető nem "csúszik" a kocsi mögött,
// mint egy követő kamera) — ilyenkor a SAJÁT kocsit el is rejtjük
// (lásd applyCameraViewVisibility), különben a modell belelógna a képbe.
// A `smoothing` (0-1, mennyit zár a kamera a célpozícióra képkockánként
// 60 fps-en) ADJA a sebességfüggő lemaradást: a célpont a kocsival együtt
// mozog, a kamera pedig ehhez képest KÉSVE követi — ez a lemaradás a
// sebességgel arányosan nő, a beállított offset-távolságtól függetlenül.
// A "far" nézetnél ez szándékos (filmszerűbb, nagy sebességnél hátrébb
// húzódik), de a "close"-nál épp ez tette a gyors kocsinál a "far"-hoz
// hasonlóan távolivá — ott nagyobb smoothing kell, hogy a lemaradás kisebb
// maradjon a fix közelségéhez képest.
const CAMERA_VIEWS = [
  { id: 'far', offset: new THREE.Vector3(0, 3.5, -7), fpv: false, smoothing: 0.1 },
  { id: 'close', offset: new THREE.Vector3(0, 2.1, -5.2), fpv: false, smoothing: 0.2 },
  { id: 'fpv', offset: new THREE.Vector3(0, 0.65, 0.3), fpv: true },
];
let cameraViewIndex = 0;
const chaseTarget = new THREE.Vector3();
const audioListenerForward = new THREE.Vector3();
const audioListenerUp = new THREE.Vector3();

function applyCameraViewVisibility() {
  const fpv = CAMERA_VIEWS[cameraViewIndex].fpv;
  if (currentCarModel) currentCarModel.visible = !fpv;
  wheelPivots.forEach((pivot) => { pivot.visible = !fpv; });
}

function cycleCameraView() {
  cameraViewIndex = (cameraViewIndex + 1) % CAMERA_VIEWS.length;
  applyCameraViewVisibility();
  saveLastChoice('camera', CAMERA_VIEWS[cameraViewIndex].id);
}

// Jobb-klikkel, illetve mobilon az üres játéktéren húzva lehet körbenézni.
// Csak nyomva tartás alatt forgatja el a kamerát; elengedéskor animálva
// (nem egyetlen képkockán) áll vissza az alap nézetbe.
let manualOrbitActive = false;
let orbitYaw = 0;
let orbitPitch = 0;
let lastMouseX = 0;
let lastMouseY = 0;
let touchOrbitPointerId = null;

function resetManualOrbit() {
  manualOrbitActive = false;
  touchOrbitPointerId = null;
  orbitYaw = 0;
  orbitPitch = 0;
}

renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
renderer.domElement.addEventListener('mousedown', (e) => {
  // Multiplayerben is: a kamera tisztán megjelenítés, semmi köze a
  // versenylogikához — nincs okunk elvenni a körbenézést.
  if (e.button === 2 && (appState === 'driving' || appState === 'mp')) {
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
    resetManualOrbit();
  }
});

renderer.domElement.addEventListener('pointerdown', (event) => {
  if (event.pointerType !== 'touch' || touchOrbitPointerId !== null) return;
  if (appState !== 'driving' && appState !== 'mp') return;
  event.preventDefault();
  touchOrbitPointerId = event.pointerId;
  manualOrbitActive = true;
  lastMouseX = event.clientX;
  lastMouseY = event.clientY;
  try { renderer.domElement.setPointerCapture(event.pointerId); } catch { /* pointer már megszűnt */ }
});
renderer.domElement.addEventListener('pointermove', (event) => {
  if (event.pointerId !== touchOrbitPointerId) return;
  event.preventDefault();
  const dx = event.clientX - lastMouseX;
  const dy = event.clientY - lastMouseY;
  lastMouseX = event.clientX;
  lastMouseY = event.clientY;
  orbitYaw -= dx * 0.006;
  orbitPitch = Math.max(-0.8, Math.min(0.8, orbitPitch - dy * 0.006));
});
const releaseTouchOrbit = (event) => {
  if (event.pointerId === touchOrbitPointerId) resetManualOrbit();
};
renderer.domElement.addEventListener('pointerup', releaseTouchOrbit);
renderer.domElement.addEventListener('pointercancel', releaseTouchOrbit);
renderer.domElement.addEventListener('lostpointercapture', releaseTouchOrbit);

function updateChaseCamera(dt = 1 / 60) {
  applyCameraViewVisibility();

  // A LÁTHATÓ kocsit követjük, nem a fizikai testet. Egyjátékosban a kettő
  // ugyanott van (a carPivot minden képkockán a chassisBody-ról frissül), de
  // multiplayerben a helyi fizika nem fut — a kocsit a szerver állapota
  // mozgatja —, így a chassisBody a rajtnál maradna, és vele a kamera is.
  const chassisPos = carPivot.position;
  const q = carPivot.quaternion;
  const view = CAMERA_VIEWS[cameraViewIndex];

  // Csak a kocsi YAW-ját (merre néz felülnézetből) vesszük át — a dőlést és a
  // bukást (pl. borulás közben) szándékosan figyelmen kívül hagyjuk. Enélkül
  // borulásnál a "fel" és "hátra" irány a kocsival együtt fejre áll, és a
  // kamera a föld ALÁ kerülne, onnan nézve felfelé.
  const yawOnly = new THREE.Euler().setFromQuaternion(q, 'YXZ').y;
  const yawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawOnly);

  // A jobb-klikkes körbenézés extra forgatása a kocsi irányához képest.
  const orbitQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(orbitPitch, orbitYaw, 0, 'YXZ'));
  yawQuat.multiply(orbitQuat);

  const desiredOffset = view.offset.clone().applyQuaternion(yawQuat);
  const desiredPos = new THREE.Vector3(chassisPos.x, chassisPos.y, chassisPos.z).add(desiredOffset);

  if (view.fpv) {
    // A motorháztető-nézetnél a kamera MEREVEN a kocsihoz van rögzítve —
    // egy követő kamera simítása itt épp az ellenkezőjét érné el annak, amit
    // egy fedélzeti nézettől várunk (a fej nem "csúszik" lemaradva a kocsi
    // mögött, hanem egyben mozog vele).
    camera.position.copy(desiredPos);
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(yawQuat);
    chaseTarget.copy(desiredPos).add(forward.multiplyScalar(50));
    camera.lookAt(chaseTarget);
    return;
  }

  // Biztonsági háló: a kamera sose kerüljön a kocsi alá — sem borulásnál, sem
  // ha valaki lefelé néz körbenézés közben.
  desiredPos.y = Math.max(desiredPos.y, chassisPos.y + 0.5);

  // A követés simítása KÉPKOCKA-IDŐVEL arányos, nem képkockánként fix arány.
  //
  // Fix aránnyal a kamera minden képkockán ugyanazt a 10%-ot zárja a kocsira,
  // akkor is, ha az adott képkocka másfélszer hosszabb volt. Egyjátékosban ez
  // nem látszott: ott a kocsi képkockánként pontosan egy fizikai lépést halad,
  // tehát az elmozdulása is állandó. Multiplayerben viszont a kocsi a VALÓS idő
  // szerint halad (időbélyeges pufferből interpolálva), így egy hosszabb
  // képkockán többet megy — a kamera-kocsi távolság ingadozni kezd, és az
  // ingadozás a sebességgel arányos. Pontosan ezt lehetett érezni: lassan
  // semmi, gyorsan rángás.
  //
  // A képlet 60 fps-nél pont a régi értéket adja, csak most bármilyen
  // képkocka-hossznál ugyanazt a valódi idő szerinti közelítést jelenti.
  const perFrameAt60 = manualOrbitActive ? Math.max(view.smoothing, 0.3) : view.smoothing;
  const a = 1 - Math.pow(1 - perFrameAt60, Math.max(dt, 0) * 60);
  camera.position.lerp(desiredPos, a);
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

// A Fullscreen API csak felhasználói gesztusból garantált, ezért a verseny
// indítógombjánál azonnal kérjük. Multiplayer vendégnél a rajt szerverüzenetre
// történik; ott az első játékbeli érintés a tartalék aktiválási pont.
const mobilePointerQuery = window.matchMedia('(hover: none) and (pointer: coarse)');
let gameFullscreenWanted = false;

function activeFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function requestGameFullscreen() {
  gameFullscreenWanted = true;
  if (!mobilePointerQuery.matches || activeFullscreenElement()) return;

  try {
    let request;
    if (document.documentElement.requestFullscreen) {
      request = document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } else if (document.documentElement.webkitRequestFullscreen) {
      request = document.documentElement.webkitRequestFullscreen();
    }
    request?.catch?.(() => {});
  } catch {
    // Néhány mobilböngésző csak a következő közvetlen érintésből engedi.
  }
}

function leaveGameFullscreen() {
  gameFullscreenWanted = false;
  if (!activeFullscreenElement()) return;

  try {
    const exit = document.exitFullscreen
      ? document.exitFullscreen()
      : document.webkitExitFullscreen?.();
    exit?.catch?.(() => {});
  } catch {
    // A böngésző saját kilépése mellett nincs további teendő.
  }
}

window.addEventListener('pointerdown', () => {
  if (gameFullscreenWanted && (appState === 'driving' || appState === 'mp')) {
    requestGameFullscreen();
  }
}, { capture: true });

// A multiplayer modul ide akasztja be a távoli kocsik eltakarítását. Azért
// ITT, az enterMenu()-ben hívjuk, mert ez az EGYETLEN út vissza a menübe —
// a verseny végi "Menü" gomb és a leaveMultiplayer() is ezen megy át. Ha a
// takarítás csak a mp.js-ben, a kilépési pontokon egyenként ülne, minden új
// kilépési ág újra elfelejtené, és a többiek kocsija ott ragadna a pályán
// az egyjátékos menetben is (pontosan ez volt a "ghost kocsi" hiba).
let multiplayerCleanupHook = null;

// A legutóbb kijelzett sebesség (km/h). Multiplayerben a szerver snapshotja
// és a helyi jóslás is frissíti; a motorhang ugyanezt az értéket követi.
let lastReportedSpeedKmh = 0;

function enterMenu() {
  // A takarítás ELŐBB fut, mint az állapotváltás: így ha bármi hibázna benne,
  // az nem hagyja félúton a menübe lépést.
  multiplayerCleanupHook?.();
  leaveGameFullscreen();
  clearTouchInputs();
  resetManualOrbit();
  setTouchControlsEnabled(true);
  appState = 'menu';
  menuEl.classList.remove('hidden');
  hudEl.classList.add('hidden');
  devTools?.hideOverlays();
  raceHudWrapEl.classList.add('hidden');
  standingsWrapEl.classList.add('hidden');
  setHelpOpen(false);
  countdownEl.classList.add('hidden');
  // A visszaszámláló-számláló is nulláról induljon a következő versenynél.
  // Enélkül egy visszaszámlálás KÖZBEN otthagyott verseny (pl. 1-nél kiléptél)
  // után a következő 0-ra váltás rajthangot adna — a menüben.
  lastCountdownShown = 0;
  // A motor a menüben ne járjon. (A kirakat-nézet néma; ha később mégis
  // kellene alapjárat a menübe, az külön döntés, nem ennek a mellékhatása.)
  stopEngine();
  resultsEl.classList.add('hidden');
  // A két figyelmeztetés a #hud konténeren KÍVÜL él (a képernyő tetején
  // középen, saját z-indexszel), ezért a hudEl elrejtése NEM tünteti el őket —
  // kézzel kell. Enélkül a "kör érvénytelen" / "felborultál" pirula ott
  // maradt a menü fölött is, a következő verseny rajtjáig.
  //
  // A megjelenítésüket egyébként a vezetés-képkocka számolja újra
  // (updateRace / a felborulás-figyelő), az viszont menüben már nem fut —
  // tehát ami az utolsó képkockán látszott, az fagy be.
  lapInvalidAlertEl.classList.add('hidden');
  rolloverAlertEl.classList.add('hidden');
  highPingAlertEl.classList.add('hidden');
  // A ping csak multiplayerben értelmes (nincs mihez mérni egyjátékosban) —
  // menüben mindegy, hogy áll, mert a #hud egésze el van rejtve, de a
  // konzisztencia kedvéért itt is nullázzuk.
  pingBoxEl.classList.add('hidden');
  // A kocsi vissza a rajthelyre. A menü ugyanazt a kocsit mutatja, amit az
  // előbb vezettünk: ott hagyva a pálya közepén — esetleg felborulva vagy a
  // falnak nyomódva — a kirakat-nézet romosan néz ki, és a következő "Indítás"
  // is onnan folytatná. A spawnPoint a verseny rajtrács-helye (a startBtn
  // állítja be), boot után pedig a kirakat-pozíció.
  resetCarTo(spawnPoint);
  // A LÁTHATÓ modellt külön kell a helyére tenni, és ez nem elhagyható: a
  // carPivot KIZÁRÓLAG a vezetés-képkockában frissül a fizikai testből (lásd
  // az animate() 'driving' ágát), a menü ágban csak a kamera mozog. Enélkül a
  // fizikai test visszaugrott a rajthoz, a kocsi viszont ott maradt a képen,
  // ahol kiléptünk — ugyanaz a kép a menüben, mint a pályán.
  //
  // A magasságot ugyanúgy kézzel számoljuk, ahogy a setTrack teszi a
  // kirakat-nézethez: a spawnPoint SZÁNDÉKOSAN a talaj fölött van (hogy a
  // rajtnál a kasztni ne verődjön bele a vékony háromszöghálóba), a menüben
  // viszont nem lép a fizika, ami leejtené — így ott lebegve maradna.
  // A groundOffset a kalibrált nyugalmi magasság: ezzel a modell alja pontosan
  // a talajra kerül.
  const spawnQ = chassisBody.rotation();
  carPivot.quaternion.set(spawnQ.x, spawnQ.y, spawnQ.z, spawnQ.w);
  const spawnGroundY = currentTrack
    ? findGroundAt(currentTrack, currentTrackBox, spawnPoint.x, spawnPoint.z)
    : null;
  carPivot.position.set(
    spawnPoint.x,
    spawnGroundY !== null ? spawnGroundY + groundOffset : spawnPoint.y,
    spawnPoint.z
  );
  // A kirakat mindig KÜLSŐ nézet, tehát a kocsinak látszania kell — akkor is,
  // ha a játékos FPV-ben lépett ki. Az FPV elrejti a karosszériát és a
  // kerekeket (applyCameraViewVisibility), és ez a rejtés a menüben is
  // érvényben maradt: a kamera egy üres folt körül forgott.
  //
  // A vezetésbe visszatérve nem kell visszaállítani: az updateChaseCamera
  // minden képkockán újra érvényesíti a nézethez tartozó láthatóságot, tehát
  // az FPV rejtés magától visszatér az első vezetés-képkockán.
  if (currentCarModel) currentCarModel.visible = true;
  wheelPivots.forEach((pivot) => { pivot.visible = true; });
  race.phase = 'idle';
  scene.fog.density = NORMAL_FOG_DENSITY;
}

function enterDriving() {
  requestGameFullscreen();
  appState = 'driving';
  setTouchControlsEnabled(true);
  menuEl.classList.add('hidden');
  hudEl.classList.remove('hidden');
  devTools?.hideOverlays();
  raceHudWrapEl.classList.remove('hidden');
  // Az állás-panel a multiplayeré; egyjátékosban nincs kihez viszonyítani.
  standingsWrapEl.classList.add('hidden');
  // A ping ugyanígy: egyjátékosban nincs szerver-körút, amit mérni lehetne.
  pingBoxEl.classList.add('hidden');
  setHelpOpen(false);
  scene.fog.density = NORMAL_FOG_DENSITY;
  // Alapjárattal indul, még a visszaszámlálás alatt — ahogy a rajtrácson is
  // jár a motor.
  startEngine();
  // Ha a gombon/legördülőn maradt a fókusz, a szóköz/nyilak azt vezérelnék
  // vezetés helyett — ezért levesszük róla.
  document.activeElement?.blur();
}

// A gombkiosztás nem állandó felirat a kép alján (az végig takart, pedig pár
// kör után már senki nem olvassa), hanem a vissza gomb melletti "i"-re nyíló
// panel. Mindig CSUKVA indul: a rajtnál a pálya kell látszódjon, nem egy
// súgódoboz — aki kíváncsi rá, egy kattintással előhozza.
function setHelpOpen(open) {
  helpPanelEl.classList.toggle('hidden', !open);
  helpBtn.classList.toggle('is-open', open);
}
helpBtn.addEventListener('click', () => setHelpOpen(helpPanelEl.classList.contains('hidden')));

resultsMenuBtn.addEventListener('click', enterMenu);
resultsRestartBtn.addEventListener('click', () => {
  resetCarTo(spawnPoint);
  startRace();
});

// ---------- Kocsiváltás billentyűzetről ----------
// A menüben (kirakat nézet) a W/S és a fel/le nyíl az előző/következő kocsira
// vált, a legördülő megnyitása nélkül. A dev módbeli autó tesztelő UGYANEZT
// használja — csak ráakaszt egy hookot, hogy a saját legördülőjét is
// szinkronban tartsa. Ezért él ez itt és nem a dev modulban: a menüben minden
// játékosnak működnie kell.
let carSwitching = false;
let carSwitchHook = null;

async function switchCarTo(entry) {
  if (!manifest || carSwitching || !entry) return;
  carSwitching = true;
  carSwitchHook?.begin(entry);
  carSelect.value = entry.id;
  saveLastChoice('car', entry.id);
  showLoadingOverlay(true);
  try {
    await runLoadTasks([{ bytes: entry.bytes, run: (onP) => setCar('assets/' + entry.file, entry.id, entry.config, onP) }]);
  } finally {
    hideLoadingOverlay();
    carSwitching = false;
    carSwitchHook?.end(entry);
  }
}

async function switchCarBy(delta) {
  if (!manifest || carSwitching) return;
  const list = manifest.cars;
  const currentIdx = list.findIndex((c) => c.id === carSelect.value);
  const nextIdx = ((currentIdx < 0 ? 0 : currentIdx) + delta + list.length) % list.length;
  await switchCarTo(list[nextIdx]);
}

window.addEventListener('keydown', (e) => {
  if ((appState !== 'cartest' && appState !== 'menu') || e.repeat) return;
  // Ha épp egy szöveges mezőben gépel (pl. a kereshető kocsi-select-ben),
  // a W/S/fel/le a kereséshez kell, nem kocsiváltáshoz.
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  if (e.code === 'ArrowUp' || e.code === 'KeyW') {
    e.preventDefault();
    switchCarBy(-1);
  } else if (e.code === 'ArrowDown' || e.code === 'KeyS') {
    e.preventDefault();
    switchCarBy(1);
  }
});

// ---------- Fejlesztői eszközök: külön modul, igény szerint betöltve ----------
// A szabad kamera, az autó tesztelő, a zóna-szerkesztő, a checkpoint-generátor,
// az anyag alapú aszfalt-felismerés és az ütközési háló kimentése együtt ~1200
// sor volt ebben a fájlban. Egy rendes játékosnak — és a multiplayer kliensnek
// — semmi szüksége rá, ezért a dev.js CSAK dev módba lépéskor töltődik be.
// A visszakapott hookokat az animate() hívja; amíg nincs betöltve, azok az
// állapotok (dev / cartest / zone-edit) elő sem fordulhatnak.
let devTools = null;
let devToolsLoading = null;

function loadDevTools() {
  if (!devToolsLoading) {
    devToolsLoading = import('./dev.js')
      // Az initDevTools async: előbb lekéri és beszúrja a dev.html markupját,
      // csak utána tud bármit is bekötni.
      .then((mod) => mod.initDevTools(devApi))
      .then((hooks) => {
        devTools = hooks;
        return hooks;
      })
      .catch((err) => {
        devToolsLoading = null; // hadd lehessen újrapróbálni
        console.error('A fejlesztői modul nem töltődött be:', err);
        throw err;
      });
  }
  return devToolsLoading;
}

async function enterDevMode() {
  const dev = await loadDevTools();
  dev.enterDevMode();
}

// A dev modul felülete a játék felé. Ami itt `let` (pályaváltáskor vagy
// kocsiváltáskor új értéket kap), az GETTERKÉNT megy át — egy egyszerű másolat
// elavulna. A ténylegesen állandó dolgok mehetnek értékként.
const devApi = {
  scene, camera, renderer, carPivot, keys,
  hudEl, menuEl, carSelect,
  NORMAL_FOG_DENSITY,
  moveTowardsAngle, updateSunTarget, updateShowcaseCamera,
  findEntry, fillSelect, setTrack, loadZoneRuntime, extractDrivableTriangles, extractWallTriangles,
  smoothFloorHeights,
  makeSearchableSelect,
  // A dev pályaváltás ugyanazt a betöltő-overlayt kapja, mint a menü: egy
  // pálya 60-150 MB, ami nélküle 20-30 másodpercnyi néma üres képernyő.
  showLoadingOverlay, hideLoadingOverlay, runLoadTasks,
  switchCarTo,
  setCarSwitchHook(hook) { carSwitchHook = hook; },
  selectMap(mapId) { mapSelect.value = mapId; },
  get appState() { return appState; },
  set appState(v) { appState = v; },
  get manifest() { return manifest; },
  get currentMapId() { return currentMapId; },
  get currentTrack() { return currentTrack; },
  get currentTrackBox() { return currentTrackBox; },
  get currentSpawnPoints() { return currentSpawnPoints; },
  get currentGates() { return currentGates; },
  get currentGuidePath() { return currentGuidePath; },
  set currentGuidePath(p) { currentGuidePath = p; },
  get wheelPivots() { return wheelPivots; },
  get wheelSources() { return wheelSources; },
  // ---- Autó-tesztelő: élő fizikai vezetés + hangolás ----
  // A chassisBody/vehicle egyszer, a modul betöltésekor épül fel (lásd a
  // buildVehicle hívást lentebb), és a teljes oldal-élet alatt ugyanaz marad —
  // ezért nyugodtan adható direkt értékként, nem getterként.
  chassisBody, vehicle,
  prepareTrackPhysics, resetCarTo,
  resetLiveVehicleTunables,
  get spawnPoint() { return spawnPoint; },
  // A race objektum referenciaként megy át: a dev.js az `active` mezőt írja,
  // hogy versenylogika/visszaszámlálás nélkül, azonnal vezethető legyen a
  // kocsi — a getter csak azért kell, mert `race` egy const, de a benne lévő
  // mezők mutálhatók.
  get race() { return race; },
};

// A pálya fizikájának előkészítése. Külön függvény, mert az egyjátékos
// indítás ÉS a multiplayer is ugyanezt kell csinálja — különösen a
// bekészített ütközési fájlt, hogy minden kliens (és a szerver) bitre
// azonos geometrián számoljon.
async function prepareTrackPhysics({ strict = false } = {}) {
  const mesh = await loadOrExtractCollision(strict);
  applyTrackCollider(mesh.floor, mesh.wall);
  return mesh;
}

startBtn.addEventListener('click', async () => {
  if (!currentTrack || !currentTrackBox) return;
  requestGameFullscreen();
  startBtn.disabled = true;
  setMenuStatus('Pálya fizika előkészítése...');

  try {
    // Ha van előre bekészített ütközési fájl, azt használjuk — ez a mérvadó
    // a multiplayerhez, mert így minden kliens BITRE ugyanazt a geometriát
    // kapja. Ha nincs, futásidőben nyerjük ki a modellből (ez is gyors).
    await prepareTrackPhysics();

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
// Ennyiszer próbáljuk letölteni az ütközési fájlt, mielőtt feladjuk. Nem
// luxus: ez a kérés a pálya (100+ MB) letöltése MELLETT fut, és gyenge
// hálózaton simán elhasal — egy második próbálkozás a legtöbb esetet megoldja.
const COLLISION_FETCH_ATTEMPTS = 3;

// A collision.bin v2 fejléce — lásd server/devApi.js: COLLISION_MAGIC.
const COLLISION_MAGIC = 0xc0111505;

function readCollisionMesh(view, buf, offset) {
  const vertexCount = view.getUint32(offset, true);
  const indexCount = view.getUint32(offset + 4, true);
  const positions = new Float32Array(buf, offset + 8, vertexCount * 3);
  const indices = new Uint32Array(buf, offset + 8 + vertexCount * 12, indexCount);
  return { positions, indices, nextOffset: offset + 8 + vertexCount * 12 + indexCount * 4 };
}

async function fetchPreparedCollision(entry) {
  // Cache-kulcs a manifestből (méret + mtime), nem Date.now(): így a böngésző
  // MEGTARTHATJA a fájlt két verseny között, de dev módbeli újragenerálás után
  // magától újat kér.
  const url = 'assets/' + entry.collision.file + (entry.collision.v ? '?v=' + entry.collision.v : '');
  let lastErr = null;
  for (let attempt = 1; attempt <= COLLISION_FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = await res.arrayBuffer();
      const view = new DataView(buf);
      if (buf.byteLength < 4 || view.getUint32(0, true) !== COLLISION_MAGIC) {
        throw new Error('érvénytelen vagy régi formátumú collision.bin — süsd be újra a Fejlesztői eszközökből');
      }
      const floor = readCollisionMesh(view, buf, 4);
      const wall = readCollisionMesh(view, buf, floor.nextOffset);
      return { floor, wall, source: 'fájlból' };
    } catch (err) {
      lastErr = err;
      console.warn(`Ütközési fájl letöltése sikertelen (${attempt}/${COLLISION_FETCH_ATTEMPTS})`, err);
    }
  }
  throw lastErr || new Error('ismeretlen hiba');
}

// A `strict` a multiplayer: ott TILOS a modellből kinyert hálóra visszaesni.
//
// Korábban némán visszaesett, és ez volt a "lebegek a pálya fölött" hiba
// gyökere: a kinyert háló NEM azonos a szerver collision.bin-jével, tehát a
// kliens jóslata más magasságon nyugtatta meg a kocsit, mint amit a szerver
// mond. A kirajzolt hely a jóslatból jön (a szerver-korrekció maximalizált és
// lecsengő), így a kocsi tartósan a rossz magasságon látszott. Inkább ne
// induljon a verseny, mint hogy rossz geometrián versenyezzünk.
async function loadOrExtractCollision(strict = false) {
  const entry = manifest && findEntry(manifest.maps, currentMapId);
  if (entry?.collision) {
    try {
      return await fetchPreparedCollision(entry);
    } catch (err) {
      if (strict) {
        throw new Error(
          'A pálya ütközési fájlja nem tölthető le, multiplayerben pedig nem lehet ' +
          'helyette a modellből számolni (a szerverrel bitre egyeznie kell). ' +
          'Ellenőrizd a hálózatot, és próbáld újra. (' + err.message + ')'
        );
      }
      console.warn('Bekészített ütközési fájl nem tölthető, visszaesés kinyerésre', err);
    }
  } else if (strict) {
    throw new Error(
      'Ehhez a pályához nincs bekészítve ütközési fájl (collision.bin), ' +
      'így multiplayerben nem használható — a szerver és a kliensek geometriája ' +
      'nem lenne azonos.'
    );
  }
  const floor = extractDrivableTriangles(currentTrack);
  const wall = extractWallTriangles(currentTrack);
  return { floor, wall, source: 'modellből' };
}

backToMenuLink.addEventListener('click', () => {
  enterMenu();
});

// ---------- Menü UI: /api/assets betöltése és a select-ek feltöltése ----------
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

// ---------- Alapértelmezett / legutóbb választott kocsi, pálya, környezet ----------
// Vadonatúj látogatónak ez az alap; ha valaki már választott korábban, azt
// jegyezzük meg localStorage-ban (gépenként/böngészőnként), és legközelebb
// azt töltjük be. Ha a mentett asset időközben eltűnt (törölt pálya/kocsi),
// a findEntry úgyis az első elérhetőre esik vissza.
const DEFAULT_CAR_ID = '2004_ferrari_f2004';
const DEFAULT_MAP_ID = 'hungaroring_2020_layout';
const DEFAULT_ENV_ID = 'day_1';
const LS_KEYS = {
  map: 'racing.lastMapId', car: 'racing.lastCarId', env: 'racing.lastEnvId',
  camera: 'racing.lastCameraView', muted: 'racing.muted', volume: 'racing.volume',
};

function loadLastChoice(kind, fallback) {
  try {
    return localStorage.getItem(LS_KEYS[kind]) || fallback;
  } catch {
    return fallback;
  }
}

function saveLastChoice(kind, id) {
  try {
    localStorage.setItem(LS_KEYS[kind], id);
  } catch { /* pl. letiltott localStorage — nem kritikus, csak nem emlékszik legközelebb */ }
}

// Kereshető select: a natív <select> köré egy szöveges mezőt és egy szűrhető
// legördülő listát épít, de a <select> marad az egyetlen igazságforrás
// (érték, disabled, 'change' esemény) — a meglévő kód (fillSelect,
// mapSelect.value = ..., addEventListener('change', ...) stb.) emiatt
// SEMMIT nem változik. A 'value'/'disabled' property-ket felülírjuk, hogy a
// látható mező mindig szinkronban maradjon akkor is, ha valaki kódból
// állítja őket. Üres keresőszöveg esetén a TELJES lista látszik, nincs
// találat-korlátozás (néhány száz autónál ez még nem jelent gondot).
function makeSearchableSelect(selectEl) {
  const wrap = document.createElement('div');
  wrap.className = 'ss-wrap';
  selectEl.parentNode.insertBefore(wrap, selectEl);
  wrap.appendChild(selectEl);
  selectEl.style.display = 'none';

  const input = document.createElement('input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.className = selectEl.className
    .split(' ')
    .map((c) => (c.startsWith('form-select') ? c.replace('form-select', 'form-control') : c))
    .join(' ');
  input.disabled = selectEl.disabled;
  wrap.appendChild(input);

  const menu = document.createElement('div');
  menu.className = 'ss-menu hidden';
  wrap.appendChild(menu);

  let activeIdx = -1;

  function currentLabel() {
    const opt = selectEl.options[selectEl.selectedIndex];
    return opt ? opt.textContent : '';
  }

  function closeMenu() {
    menu.classList.add('hidden');
    activeIdx = -1;
    input.value = currentLabel();
  }

  function visibleItems() {
    return [...menu.querySelectorAll('.ss-option:not(.ss-empty)')];
  }

  function highlight(idx) {
    const items = visibleItems();
    items.forEach((it, i) => it.classList.toggle('active', i === idx));
    if (items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
  }

  function selectValue(value) {
    if (selectEl.value !== value) {
      selectEl.value = value;
      selectEl.dispatchEvent(new Event('change'));
    }
    closeMenu();
  }

  function renderMenu(filterText) {
    const q = filterText.trim().toLowerCase();
    const opts = [...selectEl.options];
    const matches = q ? opts.filter((o) => o.textContent.toLowerCase().includes(q)) : opts;
    menu.innerHTML = '';
    if (!matches.length) {
      const empty = document.createElement('div');
      empty.className = 'ss-option ss-empty';
      empty.textContent = 'Nincs találat';
      menu.appendChild(empty);
    } else {
      matches.forEach((o) => {
        const item = document.createElement('div');
        item.className = 'ss-option' + (o.value === selectEl.value ? ' ss-selected' : '');
        item.textContent = o.textContent;
        item.dataset.value = o.value;
        item.addEventListener('mousedown', (e) => {
          e.preventDefault(); // ne vegye el a fókuszt a menü zárása előtt
          selectValue(o.value);
        });
        menu.appendChild(item);
      });
    }
    activeIdx = -1;
    menu.classList.remove('hidden');
  }

  input.addEventListener('focus', () => renderMenu(''));
  // A 'focus' esemény csak akkor sül el, ha a mező korábban NEM volt
  // fókuszban — ha kiválasztás után (ami bezárja a listát, de a mezőt
  // fókuszban hagyja) újra rákattintasz, az simán nem focus-váltás, tehát
  // a lista nyitva-tartásához külön 'click'-re is figyelnünk kell.
  input.addEventListener('click', () => renderMenu(''));
  input.addEventListener('input', () => renderMenu(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (menu.classList.contains('hidden')) { renderMenu(input.value); return; }
      activeIdx = Math.min(activeIdx + 1, visibleItems().length - 1);
      highlight(activeIdx);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, 0);
      highlight(activeIdx);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const items = visibleItems();
      if (activeIdx >= 0 && items[activeIdx]) selectValue(items[activeIdx].dataset.value);
      else if (items.length === 1) selectValue(items[0].dataset.value);
    } else if (e.key === 'Escape') {
      closeMenu();
      input.blur();
    }
  });
  input.addEventListener('blur', () => {
    // Kis késleltetés, hogy az option mousedown-ja lefusson a blur előtt.
    setTimeout(closeMenu, 120);
  });
  // Capture fázisban figyeljük (a kattintás lefelé tartó szakaszában, MIELŐTT
  // egy option saját mousedown-kezelője lefutna) — így akkor is helyesen
  // látja, hogy a kattintás a wrap-en belül történt, ha a kiválasztás közben
  // a renderMenu('') újraépíti (és eltávolítja) az éppen kattintott elemet.
  document.addEventListener('mousedown', (e) => {
    if (!wrap.contains(e.target)) closeMenu();
  }, true);

  const nativeValueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(selectEl, 'value', {
    get() { return nativeValueDesc.get.call(selectEl); },
    set(v) { nativeValueDesc.set.call(selectEl, v); input.value = currentLabel(); },
  });
  const nativeDisabledDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'disabled');
  Object.defineProperty(selectEl, 'disabled', {
    get() { return nativeDisabledDesc.get.call(selectEl); },
    set(v) { nativeDisabledDesc.set.call(selectEl, v); input.disabled = v; },
  });

  input.value = currentLabel();
}

async function init() {
  const res = await fetch('/api/assets');
  if (!res.ok) throw new Error('/api/assets HTTP ' + res.status);
  manifest = await res.json();

  if (!manifest.maps.length || !manifest.cars.length || !manifest.skyboxes.length) {
    setMenuStatus('Hiányzó assetek (pálya/kocsi/környezet) az assets mappában.');
    return;
  }

  fillSelect(mapSelect, manifest.maps);
  fillSelect(carSelect, manifest.cars);
  fillSelect(envSelect, manifest.skyboxes);

  const initialMap = findEntry(manifest.maps, loadLastChoice('map', DEFAULT_MAP_ID));
  const initialCar = findEntry(manifest.cars, loadLastChoice('car', DEFAULT_CAR_ID));
  const initialEnv = findEntry(manifest.skyboxes, loadLastChoice('env', DEFAULT_ENV_ID));
  mapSelect.value = initialMap.id;
  carSelect.value = initialCar.id;
  envSelect.value = initialEnv.id;

  const savedViewIdx = CAMERA_VIEWS.findIndex((v) => v.id === loadLastChoice('camera', CAMERA_VIEWS[0].id));
  if (savedViewIdx >= 0) cameraViewIndex = savedViewIdx;

  setVolume(Number(loadLastChoice('volume', '1')));
  syncVolumeControl();
  setMuted(loadLastChoice('muted', '0') === '1');
  syncTouchMuteButton();
  // A hang-láncot az első kattintásnál építjük fel, nem az első bipnél: a
  // böngésző csak felhasználói gesztus után enged hangot, és a felépítés maga
  // is eltarthat pár tized másodpercig — így a legelső "3" bipje sem késik.
  primeOnFirstGesture();

  await runLoadTasks([
    { bytes: initialEnv.bytes, run: (onP) => setSkybox('assets/' + initialEnv.file, onP) },
    { bytes: initialMap.bytes, run: (onP) => setTrack('assets/' + initialMap.file, initialMap.id, initialMap.spawns, initialMap.gates, onP) },
    { bytes: initialCar.bytes, run: (onP) => setCar('assets/' + initialCar.file, initialCar.id, initialCar.config, onP) },
  ]);

  mapSelect.disabled = false;
  carSelect.disabled = false;
  envSelect.disabled = false;
  startBtn.disabled = false;
  hideLoadingOverlay();
  if (DEV_MODE) {
    await enterDevMode();
  } else {
    enterMenu();
  }

  mapSelect.addEventListener('change', async () => {
    const entry = findEntry(manifest.maps, mapSelect.value);
    saveLastChoice('map', entry.id);
    showLoadingOverlay(true);
    try {
      await runLoadTasks([{ bytes: entry.bytes, run: (onP) => setTrack('assets/' + entry.file, entry.id, entry.spawns, entry.gates, onP) }]);
    } finally {
      hideLoadingOverlay();
    }
  });
  carSelect.addEventListener('change', async () => {
    const entry = findEntry(manifest.cars, carSelect.value);
    saveLastChoice('car', entry.id);
    showLoadingOverlay(true);
    try {
      await runLoadTasks([{ bytes: entry.bytes, run: (onP) => setCar('assets/' + entry.file, entry.id, entry.config, onP) }]);
    } finally {
      hideLoadingOverlay();
    }
  });
  envSelect.addEventListener('change', async () => {
    const entry = findEntry(manifest.skyboxes, envSelect.value);
    saveLastChoice('env', entry.id);
    showLoadingOverlay(true);
    try {
      await runLoadTasks([{ bytes: entry.bytes, run: (onP) => setSkybox('assets/' + entry.file, onP) }]);
    } finally {
      hideLoadingOverlay();
    }
  });
}

init().catch((err) => {
  console.error('Init error', err);
  loadingEl.textContent = 'Hiba az indításkor: ' + err.message;
});

// ---------- Fő ciklus ----------
const clock = new THREE.Clock();

// Az egyjátékos fizika fix lépésközének maradéka két képkocka között.
let physicsAccum = 0;

// ---------- FPS-kijelző ----------
// Nem képkockánként íratjuk ki: a szám maga is ugrálna képkockánként (16.1 ms
// vs 16.9 ms simán 60/62 FPS-nek olvasható ki egyetlen mintából), és a
// szöveges DOM-írás felesleges munka minden egyes képkockán. Egy fix ablakon
// (kb. fél másodperc) átlagolva a szám stabil, mégis eléggé friss.
let fpsFrames = 0;
let fpsWindowStart = 0;
const FPS_UPDATE_INTERVAL_MS = 500;

function tickFpsCounter(nowMs) {
  fpsFrames++;
  if (fpsWindowStart === 0) { fpsWindowStart = nowMs; return; }
  const elapsed = nowMs - fpsWindowStart;
  if (elapsed >= FPS_UPDATE_INTERVAL_MS) {
    fpsValueEl.textContent = Math.round((fpsFrames * 1000) / elapsed);
    fpsFrames = 0;
    fpsWindowStart = nowMs;
  }
}


function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  // Minden állapotban mérünk (menü, vezetés, mp, dev), nem csak vezetés
  // közben — az fps-doboz a #hud-on belül van, tehát csak driving/mp-ben
  // LÁTSZIK, de a számláló futása nem függ ettől.
  tickFpsCounter(performance.now());

  if (appState === 'driving') {
    updateControls(dt);
    // A fizikát a VALÓS eltelt idő szerint léptetjük, nem képkockánként egyszer.
    //
    // Korábban képkockánként pontosan egy lépés futott, a lépésköz viszont fix
    // 1/60 — így a szimuláció a képfrissítés ütemében járt: 75 Hz-en 1.25-ször
    // gyorsabban a valós időnél, 144 Hz-en 2.4-szer, 30 fps-en feleakkora
    // sebességgel. Vagyis mindenki más játékot játszott, a gépe szerint, és az
    // egyjátékos érezhetően fürgébb volt a multiplayernél (ami mindig pontos
    // 60 lépés/mp). Ez utóbbi a helyes, ezért igazodunk hozzá.
    physicsAccum += dt;
    let physSteps = 0;
    // Egy hosszabb akadás után nem játsszuk le gyorsítva a kimaradt időt.
    if (physicsAccum > world.timestep * 5) physicsAccum = world.timestep * 5;
    while (physicsAccum >= world.timestep && physSteps < 5) {
      // A Rapiernél a jármű-vezérlőt a világ léptetése ELŐTT kell frissíteni:
      // ez lövi ki a kerék-sugarakat és számolja a felfüggesztés/tapadás erőket.
      vehicle.updateVehicle(world.timestep, undefined, WHEEL_RAY_FILTER_GROUPS);
      world.step();
      applySpeedCap(chassisBody);
      applyWallConstraint();
      captureCarState();
      physicsAccum -= world.timestep;
      physSteps++;
    }
    calibrateGroundOffset(dt);
    updateRace(dt);

    if (carLoaded) {
      if (carInterpReady) {
        // A maradék mondja meg, hol tartunk a következő lépés felé: nulla =
        // épp most lépett, majdnem egy = mindjárt lép a következőt.
        const alpha = Math.max(0, Math.min(1, physicsAccum / world.timestep));
        carPivot.position.lerpVectors(prevCarPos, currCarPos, alpha);
        carPivot.quaternion.slerpQuaternions(prevCarQuat, currCarQuat, alpha);
      } else {
        const p = chassisBody.translation();
        const q = chassisBody.rotation();
        carPivot.position.set(p.x, p.y, p.z);
        carPivot.quaternion.set(q.x, q.y, q.z, q.w);
      }
      updateSunTarget(carPivot.position);
      updateWheelVisuals(dt);
    }

    updateChaseCamera(dt);
  } else if (appState === 'mp') {
    stepMultiplayerFrame(dt);
  } else if (appState === 'dev') {
    // Ezekbe az állapotokba csak a dev modul tud átbillenteni, tehát ha itt
    // vagyunk, a devTools már be van töltve — a ?. csak biztonsági öv.
    devTools?.updateDevCamera(dt);
  } else if (appState === 'cartest') {
    devTools?.updateCarTest(dt);
  } else if (appState === 'zone-edit') {
    // Külön képkocka: a szerkesztő saját (ortografikus, felülnézeti) kamerával
    // rendereli a pályát, ezért itt a szokásos renderelés kimarad.
    devTools?.renderZoneEditorFrame();
    return;
  } else {
    updateSunTarget(carPivot.position);
    updateShowcaseCamera(dt);
  }

  recordDiagFrame();
  renderer.render(scene, camera);
}

// ---------- Rángatás-diagnosztika ----------
// A rángatás ezredmásodperces időzítési kérdés: videón nem látszik, mitől van,
// és háttérfülön (ahol az időzítők fékezettek) nem is reprodukálható. Ezért
// itt mérünk, a VALÓDI gépen: képkockánként rögzítjük, mennyi idő telt el és
// mennyit mozdult a látható kocsi. Az arányuk a pillanatnyi sebesség — ha ez
// képkockáról képkockára ugrál, azt látja a szem rángatásnak.
//
// Használat a konzolban:  __diag.start(6)   majd 6 mp múlva:  __diag.report()
let diag = null;

function recordDiagFrame() {
  if (!diag) return;
  const now = performance.now();
  if (now > diag.until) return;
  const p = carPivot.position;
  const mp = window.__mp;
  const raw = mp?.rawPos, interp = mp?.interpPos;
  diag.rows.push({
    t: now,
    x: p.x, z: p.z,
    // A függőleges külön: egyenetlen talajon a felfüggesztés mozgatja a kocsit,
    // és azt a vízszintes mérőszám nem látja.
    y: p.y,
    // A kirajzolt pozíció összetevői külön, hogy lássuk, melyik ugrik:
    // rawX/rawZ  = a fizikai test PILLANATNYI állapota (interpoláció nélkül)
    // ipX/ipZ    = az időbélyeges pufferből interpolált érték
    // sm         = a korrekció-simítás eltolásának hossza
    rawX: raw?.[0], rawZ: raw?.[1],
    ipX: interp?.[0], ipZ: interp?.[1],
    sm: mp?.smoothLen ?? 0,
    // A KAMERA helye. A képernyő rángását ez adja, nem a kocsié — a kocsi
    // lehet tökéletesen sima, ha közben a kamera egyenetlenül követi.
    camX: camera.position.x, camZ: camera.position.z,
    snaps: mp?.snaps ?? 0,
    steps: mp?.physSteps ?? 0,
  });
}

const pct = (sorted, q) => sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(2) : 0;

window.__diag = {
  start(seconds = 6) {
    diag = { until: performance.now() + seconds * 1000, rows: [] };
    return `Mérés ${seconds} másodpercig — VEZESS közben (tartsd a gázt)! Utána: __diag.report()`;
  },
  report() {
    if (!diag || diag.rows.length < 10) return 'Előbb __diag.start(6), és vezess a mérés alatt.';
    const r = diag.rows;
    const dts = [], speeds = [], stepsPerFrame = [];
    let snapFrames = 0;
    for (let i = 1; i < r.length; i++) {
      const dt = r[i].t - r[i - 1].t;
      if (dt <= 0) continue;
      dts.push(dt);
      speeds.push(Math.hypot(r[i].x - r[i - 1].x, r[i].z - r[i - 1].z) / (dt / 1000));
      stepsPerFrame.push(r[i].steps - r[i - 1].steps);
      if (r[i].snaps > r[i - 1].snaps) snapFrames++;
    }
    const sortedDt = [...dts].sort((a, b) => a - b);
    const sortedSp = [...speeds].sort((a, b) => a - b);
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const spMean = mean(speeds);
    const spStd = Math.sqrt(mean(speeds.map((s) => (s - spMean) ** 2)));
    const hist = {};
    for (const s of stepsPerFrame) hist[s] = (hist[s] || 0) + 1;

    // A RÁNGÁS mértéke. A puszta szórás erre alkalmatlan: a gyorsulást is
    // beleszámolja, ezért egyjátékosban is 76%-ot adott, ahol pedig nincs
    // rángás. A rángás nagyfrekvenciás CIKCAKK — a gyorsulás viszont helyben
    // egyenletes —, ezért minden képkockát a két szomszédja átlagához
    // hasonlítunk: a sima gyorsulás ebből kiesik, a cikcakk megmarad.
    const zig = [];
    for (let i = 1; i < speeds.length - 1; i++) {
      zig.push(Math.abs(speeds[i] - (speeds[i - 1] + speeds[i + 1]) / 2));
    }
    const rangas = zig.length ? (mean(zig) / (spMean || 1)) * 100 : 0;

    // Ugyanez tetszőleges koordináta-párra, hogy a kirajzolt pozíció
    // összetevőit külön-külön is meg tudjuk mérni.
    // Egytengelyű változat. A függőleges mozgás átlaga nulla körüli (fel-le),
    // ezért nem az átlaghoz viszonyítunk, hanem a mozgás tipikus MÉRETÉHEZ —
    // különben nullával osztanánk.
    function jitter1D(key) {
      const sp = [];
      for (let i = 1; i < r.length; i++) {
        const dt2 = r[i].t - r[i - 1].t;
        if (dt2 <= 0 || r[i][key] === undefined) continue;
        sp.push((r[i][key] - r[i - 1][key]) / (dt2 / 1000));
      }
      if (sp.length < 3) return 0;
      const scale = mean(sp.map(Math.abs)) || 1;
      const z = [];
      for (let i = 1; i < sp.length - 1; i++) z.push(Math.abs(sp[i] - (sp[i - 1] + sp[i + 1]) / 2));
      return (mean(z) / scale) * 100;
    }

    function jitterOf(kx, kz) {
      const sp = [];
      for (let i = 1; i < r.length; i++) {
        const dt2 = r[i].t - r[i - 1].t;
        if (dt2 <= 0 || r[i][kx] === undefined || r[i - 1][kx] === undefined) continue;
        sp.push(Math.hypot(r[i][kx] - r[i - 1][kx], r[i][kz] - r[i - 1][kz]) / (dt2 / 1000));
      }
      if (sp.length < 3) return 0;
      const m = mean(sp);
      const z = [];
      for (let i = 1; i < sp.length - 1; i++) z.push(Math.abs(sp[i] - (sp[i - 1] + sp[i + 1]) / 2));
      return (mean(z) / (m || 1)) * 100;
    }

    return {
      mod: appState,
      kepkockak: r.length,
      fps: +(1000 / mean(dts)).toFixed(1),
      // Ha a képkocka-idő maga ingadozik, a baj a renderelésnél van (GPU),
      // nem a hálózatnál — akkor egyjátékosban is rángatna.
      kepkockaIdo_ms: { p50: pct(sortedDt, 0.5), p90: pct(sortedDt, 0.9), p99: pct(sortedDt, 0.99), max: +Math.max(...dts).toFixed(2) },
      // A látható sebesség szórása a rángatás mértéke. Ha az átlaghoz képest
      // nagy, a kocsi egyenetlenül halad a képen.
      latszoSebesseg_ms: { atlag: +spMean.toFixed(2), szoras: +spStd.toFixed(2), p50: pct(sortedSp, 0.5), p99: pct(sortedSp, 0.99) },
      // EZ a rángás mérőszáma (kisebb = simább). A gyorsulás nem számít bele.
      rangas_szazalek: +rangas.toFixed(1),
      // Ugyanez a mérőszám a kirajzolt pozíció ÖSSZETEVŐIRE. Amelyik magas,
      // az okozza a rángást:
      //   nyersFizika = interpoláció nélkül, a test pillanatnyi állapota
      //   interpolalt = az időbélyeges pufferből számolt érték
      // Ha a "nyersFizika" magas, de az "interpolalt" alacsony, az
      // interpoláció dolgozik, és a maradék a simításból jön.
      rangas_nyersFizika: +jitterOf('rawX', 'rawZ').toFixed(1),
      rangas_interpolalt: +jitterOf('ipX', 'ipZ').toFixed(1),
      // A ténylegesen látott kép ettől függ: a kamera mozgásának egyenletessége.
      rangas_kamera: +jitterOf('camX', 'camZ').toFixed(1),
      // Függőleges (felfüggesztés, bukkanók) — ezt a vízszintes szám nem méri.
      rangas_fuggoleges: +jitter1D('y').toFixed(1),
      simitasEltolas_m: { atlag: +mean(r.map((q) => q.sm || 0)).toFixed(3), max: +Math.max(...r.map((q) => q.sm || 0)).toFixed(3) },
      ingadozas_szazalek: +((spStd / (spMean || 1)) * 100).toFixed(1),
      // Hány fizikai lépés jutott egy-egy képkockára. Ha ez 0 és 2 közt
      // váltakozik, a fizika és a képfrissítés nincs szinkronban.
      fizikaiLepesKepkockankent: hist,
      snapshotosKepkockak_szazalek: +((100 * snapFrames) / (r.length - 1)).toFixed(1),
    };
  },
};

// Csak a diagnosztika deklarálása UTÁN indulhat a képkocka-hurok: az animate()
// már az első hívásnál olvassa a `diag`-ot, és egy még nem inicializált `let`
// olvasása megszakítaná az egész modul kiértékelését (a window.__game sem
// jönne létre).
animate();

// A multiplayer modul minden képkockán meghívandó függvénye (mp.js állítja be).
let mpFrameHook = null;
let multiplayerControlsEnabled = true;

// Egy multiplayer képkocka. Külön függvény, hogy teszteléskor kézzel is
// léptethető legyen: a requestAnimationFrame megáll, ha a lap háttérbe kerül.
// Multiplayerben a SZERVER a hiteles forrás, de a saját kocsit a hálózati
// modul helyben is lépteti a késleltetésmentes irányításhoz. A frame hook a
// jóslat kirajzolását, korrekcióját és a távoli autók interpolációját végzi.
function stepMultiplayerFrame(dt) {
  mpFrameHook?.(dt);
  // Ugyanaz, mint az egyjátékos animate()-ben: a modell magasságát a VALÓDI,
  // terhelt felfüggesztés-hosszból kell beállítani. Eddig ez csak vezetés
  // közben futott, multiplayerben nem — ezért a kocsi a teljesen kinyúlt
  // rugóval számolt 0.85-tel ült a kasztni alatt, miközben a valódi nyugalmi
  // távolság ~0.78, vagyis a modellt pár centivel az aszfalt alá rajzoltuk.
  // A függvény maga őrzi a feltételeit (négy kerék a talajon, a rugók
  // megnyugodtak), és csak egyszer mér kocsinként.
  calibrateGroundOffset(dt);
  updateSunTarget(carPivot.position);
  updateWheelVisuals(dt);
  updateChaseCamera(dt);
  camera.getWorldDirection(audioListenerForward);
  audioListenerUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
  updateAudioListener(camera.position, audioListenerForward, audioListenerUp, chassisBody.linvel());
  // A vezetős HUD-ot egyjátékosban az updateControls frissíti, ami
  // multiplayerben nem fut — emiatt hiányzott eddig a mini-térkép és a
  // zóna-kijelző. Mindkettő tisztán a kocsi helyéből számolható, tehát itt
  // is elvégezhető; a versenylogikához (kör, checkpoint) nem nyúlunk, az
  // marad a szerveré.
  const p = carPivot.position;
  updateMiniMap(p.x, p.z);
  updateZoneIndicator(p.x, p.z);

  // Motorhang. A kijelzett sebességet a snapshotok között a helyi jóslás
  // frissíti. Célba éréskor a gázt itt is letiltjuk, így a kiguruló autó
  // hangja a sebességével együtt cseng le.
  updateEngine(
    lastReportedSpeedKmh,
    multiplayerControlsEnabled ? Math.max(0, getDriveAxes().pedal) : 0,
    dt
  );

  // Felborulás. A visszahelyezést multiplayerben nem mi végezzük — a szerver
  // a hiteles forrás —, ezért csak jelezzük; az R-t a hálózati modul küldi el.
  const q = chassisBody.rotation();
  const flipped = 1 - 2 * (q.x * q.x + q.z * q.z) < 0.2;
  if (flipped) rolloverAlertTextEl.textContent = 'Felborultál! Nyomj R-et — vissza az utolsó checkpontra.';
  rolloverAlertEl.classList.toggle('hidden', !flipped);
}

// A multiplayer modul felülete a játék felé. Szándékosan szűk: csak annyit
// ad ki, amennyi a hálózati réteghez kell — a fizikát és a versenylogikát
// multiplayerben a szerver végzi.
window.__game = {
  THREE, scene, camera, carPivot, renderer,
  resetLiveVehicleTunables,
  get appState() { return appState; },
  get hasFrameHook() { return !!mpFrameHook; },
  stepMpFrame: stepMultiplayerFrame,
  get manifest() { return manifest; },
  get currentMapId() { return currentMapId; },
  get currentTrack() { return currentTrack; },
  get carLoaded() { return carLoaded; },
  keys,
  getDriveAxes,
  setCar, setTrack, prepareTrackPhysics, loadGLTF, centerCarModelOnWheels,
  createRemoteEngine, updateRemoteEngine, stopRemoteEngine,
  formatTime,
  enterMenu,
  // Multiplayer futamok között nem maradhat meg az előző utolsó sebessége,
  // fokozata vagy beütemezett hangmagasság-simítása. A stopEngine lecsengeti
  // és eldobja a teljes szintetizátort; a következő enterMultiplayer friss,
  // alapjárati gear/RPM állapottal építi újra.
  resetRaceAudio() {
    lastReportedSpeedKmh = 0;
    lastCountdownShown = 0;
    stopEngine();
  },
  // A mp.js ezzel regisztrálja a távoli kocsik eltakarítását — lásd enterMenu().
  setMultiplayerCleanupHook(hook) { multiplayerCleanupHook = hook; },
  detachMultiplayerFrame() { mpFrameHook = null; },
  setMultiplayerControlsEnabled(enabled) {
    multiplayerControlsEnabled = !!enabled;
    setTouchControlsEnabled(enabled);
  },
  setRemoteCarProxy,
  removeRemoteCarProxy,
  clearRemoteCarProxies,
  // A mp.js maga hozza létre a többiek modelljeit, tehát neki is kell tudnia
  // felszabadítani őket: a scene.remove() csak a jelenetgráfból veszi ki, a
  // GPU-oldali geometria/textúra ott maradna meccsről meccsre halmozódva.
  disposeObject3D,
  setMenuStatus,
  findGroundAt,
  get currentTrackBox() { return currentTrackBox; },
  showLoadingOverlay, hideLoadingOverlay, runLoadTasks,
  // A minitérkép pöttyei: a hálózati modul képkockánként adja meg, hol tartanak
  // a többiek, és milyen színt kapott ő maga. A sorrend fontos — ezt a
  // stepMultiplayerFrame ELŐTT hívja a modul, mielőtt a térkép kirajzolódik.
  setMiniMapMarkers(markers, selfColor) {
    miniMapMarkers = markers || [];
    miniMapSelfColor = selfColor || null;
  },
  // ---- Client-side prediction felülete ----
  // A helyi kocsi ÁLLAPOTÁNAK kiolvasása és beállítása, plusz egyetlen
  // szimulációs lépés. A hálózati modul ezekből építi fel a jóslást: a
  // szerver állapotára visszaáll, majd újrajátssza a még nem nyugtázott
  // bemeneteket.
  //
  // A szögsebesség (w) is kell, nem csak a hely/forgás/sebesség: enélkül a
  // kocsi pörgés vagy billenés közben más állapotból folytatná, mint a szerver.
  getCarState() {
    const p = chassisBody.translation(), q = chassisBody.rotation();
    const v = chassisBody.linvel(), w = chassisBody.angvel();
    return { p: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w], v: [v.x, v.y, v.z], w: [w.x, w.y, w.z] };
  },
  setCarState({ p, q, v, w }) {
    chassisBody.setTranslation({ x: p[0], y: p[1], z: p[2] }, true);
    chassisBody.setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] }, true);
    chassisBody.setLinvel({ x: v[0], y: v[1], z: v[2] }, true);
    if (w) chassisBody.setAngvel({ x: w[0], y: w[1], z: w[2] }, true);
  },
  // Egyetlen szimulációs lépés, PONTOSAN úgy, ahogy a szerver csinálja
  // (raceSim.step) — beleértve a kifutó-lassítást is. A zóna mintavétele
  // ugyanabból a maszkból, ugyanazzal a képlettel megy mindkét oldalon
  // (shared/zone.js), különben a pálya szélén a jóslat folyamatosan
  // eltérne a szervertől.
  stepLocalPhysics(input, frozen = false, finished = false) {
    applyControls(vehicle, chassisBody, input, { frozen, offtrackWheels: wheelsOffTrack() });
    vehicle.updateVehicle(world.timestep, undefined, WHEEL_RAY_FILTER_GROUPS);
    world.step();
    // A sebességplafon és a láthatatlan fal a lépés UTÁN, ugyanabban a
    // sorrendben, mint a szerveren és mint az egyjátékos animate()-ben.
    applySpeedCap(chassisBody);
    applyWallConstraint();
    if (finished) settleFinishedBody(chassisBody);
  },
  // A "kör érvénytelen" figyelmeztetés. Multiplayerben a szerver dönti el
  // (a snapshot `ti` mezője), egyjátékosban a helyi versenylogika.
  // A `reason` a TAINT kódja (0 = érvényes), ugyanaz, amit az egyjátékos
  // logika is használ — így a szöveg is ugyanaz, egy helyről.
  setLapInvalid(reason) {
    if (reason) lapInvalidAlertTextEl.textContent = lapInvalidText(reason);
    lapInvalidAlertEl.classList.toggle('hidden', !reason);
  },
  // Multiplayer módba váltás: a versenylogikát a szerver végzi. A helyi
  // fizikát a hálózati modul lépteti, ha a jóslás be van kapcsolva.
  enterMultiplayer(frameHook) {
    requestGameFullscreen();
    mpFrameHook = frameHook;
    multiplayerControlsEnabled = true;
    setTouchControlsEnabled(true);
    appState = 'mp';
    menuEl.classList.add('hidden');
    hudEl.classList.remove('hidden');
    raceHudWrapEl.classList.remove('hidden');
    setHelpOpen(false);
    devTools?.hideOverlays();
    scene.fog.density = NORMAL_FOG_DENSITY;
    startEngine();
    // Induláskor "–" (mérés alatt): az első PONG a mp.js periodikus
    // ping-küldése után érkezik, nem azonnal.
    pingValueEl.textContent = '–';
    pingBoxEl.removeAttribute('data-quality');
    highPingAlertEl.classList.add('hidden');
    pingBoxEl.classList.remove('hidden');
    document.activeElement?.blur();
  },
  // A mp.js hívja a periodikus PING/PONG körút mérése után.
  setPingMs(ms) {
    const { value: ping, quality } = classifyPing(ms);
    pingValueEl.textContent = ping;
    pingBoxEl.dataset.quality = quality;
    if (quality === 'bad') highPingAlertTextEl.textContent = `Magas ping: ${ping} ms — a kapcsolat akadozhat.`;
    highPingAlertEl.classList.toggle('hidden', quality !== 'bad');
  },
  requestGameFullscreen,
  leaveMultiplayer() {
    mpFrameHook = null;
    multiplayerControlsEnabled = true;
    clearTouchInputs();
    // Enélkül a legutóbbi verseny pöttyei az egyjátékos térképen is ott
    // maradnának, mozdulatlanul.
    miniMapMarkers = [];
    miniMapSelfColor = null;
    enterMenu();
  },
  // A látható kocsit a szerver állapotára állítja (a helyi fizika helyett).
  applyServerTransform(p, q) {
    carPivot.position.set(p[0], p[1], p[2]);
    carPivot.quaternion.set(q[0], q[1], q[2], q[3]);
  },
  setHud(html) { raceHudEl.innerHTML = html; },
  // A bal felső állás-panel (ki hol tart). Külön a jobb felső időmérőtől:
  // egy panelbe zsúfolva a kettő pont az az összeolvadó szövegfal volt, ami
  // olvashatatlanná tette a HUD-ot. Üres tartalomra elrejtjük magát a panelt,
  // hogy egyjátékosban ne lógjon ott egy üres doboz.
  setStandings(html) {
    standingsEl.innerHTML = html || '';
    standingsWrapEl.classList.toggle('hidden', !html);
  },
  setSpeed(kmh) {
    // Menet közben ezt a szerver-snapshot és a helyi jóslás is frissíti. A
    // célba érés után már nem jön snapshot, ezért a kiguruló helyi fizika kell
    // ahhoz, hogy a sebesség és a motorhang ténylegesen nullára csengjen.
    lastReportedSpeedKmh = kmh;
    speedValueEl.textContent = Math.round(kmh);
  },
  // A nagy 3-2-1 kiírás. Multiplayerben a visszaszámlálás a SZERVER órája
  // szerint jár (a kliens csak megjeleníti), ezért nem a helyi race.phase
  // vezérli, mint egyjátékosban — null/0 rejti el.
  setCountdown: showCountdown,
};

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
  // A FUTÁSIDEJŰ zóna-vizsgálat (vezetés közben is él) — a szerkesztő-oldali
  // részeket (maszk, nézet, checkpoint-generálás) a dev.js fűzi ehhez hozzá,
  // amikor betöltődik.
  zone: {
    setRuntime: (z) => { zoneRuntime = z; }, sampleAt: sampleZoneAt, touchesWall: carTouchesWall,
    applyWall: applyWallConstraint, lastSafe: lastSafePos,
    getGuidePath: () => currentGuidePath,
  },
};

// A multiplayer modult SZÁNDÉKOSAN innen töltjük be, nem külön <script>-ből:
// a window.__game csak eddigre áll össze, egy párhuzamosan induló modul pedig
// még üresen találná.
import('./mp.js').catch((err) => console.error('A többjátékos modul nem töltődött be:', err));
