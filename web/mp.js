// Multiplayer kliens: lobby, kapcsolat, és a többi autó megjelenítése.
//
// Multiplayerben a SZERVER a hiteles forrás — a helyi fizika nem fut. Ez a
// modul a bemenetet küldi, és a beérkező állapotot jeleníti meg; a köztes
// időt interpolálja, hogy a 20/mp állapot is folyamatos mozgásnak látsszon.
import { C2S, S2C, ROOM_STATE, TICK_RATE, TICK_MS, sanitizeName } from '/shared/protocol.js';

const G = window.__game;
// Diagnosztika. A step() azért kell, mert a requestAnimationFrame megáll, ha
// a lap háttérbe kerül — enélkül a hálózati réteget nem lehetne automatizáltan
// tesztelni (a képkocka-számláló ilyenkor csalókán nullán marad).
window.__mp = {
  stage: 'init', frames: 0, snaps: 0,
  step: () => frame(),
  get others() { return others.size; },
  get selfBuf() { return selfBuf.length; },
  get room() { return room; },
  // Mesterséges késleltetés: __mp.setPing(150) vagy __mp.setPing(150, 30).
  // Ugyanez URL-ből: ?lag=150&jitter=30
  setPing: (rtt, jitter) => setPing(rtt, jitter),
  get net() { return { ...netsim }; },
  // Prediction-diagnosztika: hány saját bemenet vár még nyugtázásra, és
  // meddig jutott a szerver. A kettő különbsége a tényleges bemenet-késés
  // tickben mérve.
  get inputSeq() { return inputSeq; },
  get ackedSeq() { return ackedSeq; },
  get pending() { return inputHistory.length; },
  // Jóslás: be van-e kapcsolva (?predict=0 kikapcsolja), és mekkora volt a
  // legutóbbi korrekció méterben. Ha ez tartósan nagy, a két szimuláció
  // eltér egymástól — az bug, nem hangolási kérdés.
  get predict() { return predict; },
  lastError: 0,
};
const THREE = G.THREE;

let ws = null;
let me = { id: null, name: null, token: localStorage.getItem('racing.token') || null };
let room = null;
let starting = null;
// A távoli autók modelljei: playerId -> { group, buf: [állapotok] }
const others = new Map();
// A saját kocsi állapot-puffere is kell: a szerver mozgat minket is.
let selfBuf = [];
let inputSeq = 0;
let awaitingFirstSnapshot = false;
let inputTimer = null;
let lastEvents = [];

// ---------- Lobby felület ----------

const el = document.createElement('div');
el.id = 'mpOverlay';
el.className = 'hidden';
el.innerHTML = `
<div class="mp-panel">
  <h5 class="mb-3">Többjátékos</h5>
  <div id="mpLogin">
    <label class="form-label small">Játékosnév</label>
    <input id="mpName" class="form-control form-control-sm mb-2" maxlength="20" placeholder="A neved">
    <button id="mpConnect" class="btn btn-primary btn-sm w-100">Csatlakozás a szerverhez</button>
  </div>
  <div id="mpRooms" class="hidden">
    <div class="mb-2 small">Bejelentkezve: <strong id="mpWho"></strong></div>
    <div class="row g-2 mb-2">
      <div class="col-12"><button id="mpCreate" class="btn btn-success btn-sm w-100">Új szoba létrehozása</button></div>
      <div class="col-8"><input id="mpCode" class="form-control form-control-sm text-uppercase" maxlength="6" placeholder="SZOBAKÓD"></div>
      <div class="col-4"><button id="mpJoin" class="btn btn-outline-light btn-sm w-100">Belépés</button></div>
    </div>
  </div>
  <div id="mpRoom" class="hidden">
    <div class="mb-2">Szobakód: <strong id="mpRoomCode" class="fs-5"></strong>
      <button id="mpCopy" class="btn btn-outline-light btn-sm py-0 px-1 ms-1">másol</button></div>
    <div class="small mb-1">Pálya: <span id="mpRoomMap"></span> — <span id="mpRoomLaps"></span> kör</div>
    <ul id="mpPlayers" class="list-unstyled small mb-2"></ul>
    <div class="d-flex gap-2">
      <button id="mpStart" class="btn btn-primary btn-sm flex-grow-1">Verseny indítása</button>
      <button id="mpLeave" class="btn btn-outline-danger btn-sm">Kilépés</button>
    </div>
    <div id="mpHint" class="small text-warning mt-2"></div>
  </div>
  <div id="mpError" class="small text-danger mt-2"></div>
  <button id="mpClose" class="btn btn-link btn-sm text-secondary mt-2 p-0">Vissza a menübe</button>
</div>`;
document.body.appendChild(el);

const $ = (id) => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle('hidden', !on);
const setErr = (m) => { $('mpError').textContent = m || ''; };

export function openLobby() {
  el.classList.remove('hidden');
  setErr('');
  if (!ws || ws.readyState > 1) {
    show('mpLogin', true); show('mpRooms', false); show('mpRoom', false);
    $('mpName').value = localStorage.getItem('racing.name') || '';
  }
}
function closeLobby() { el.classList.add('hidden'); }

$('mpClose').addEventListener('click', closeLobby);

$('mpConnect').addEventListener('click', () => {
  const name = sanitizeName($('mpName').value);
  localStorage.setItem('racing.name', name);
  connect(name);
});
$('mpName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('mpConnect').click(); });

$('mpCreate').addEventListener('click', () => {
  const mapId = document.getElementById('mapSelect')?.value;
  const carId = document.getElementById('carSelect')?.value;
  if (!mapId || !carId) return setErr('Előbb válassz pályát és kocsit a menüben.');
  send(C2S.CREATE_ROOM, { mapId, carId, laps: Number(document.getElementById('lapCountSelect')?.value) || 3 });
});

$('mpJoin').addEventListener('click', () => {
  const code = $('mpCode').value.trim().toUpperCase();
  if (code.length < 4) return setErr('Add meg a szobakódot.');
  send(C2S.JOIN_ROOM, { code, carId: document.getElementById('carSelect')?.value });
});
$('mpCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('mpJoin').click(); });

$('mpStart').addEventListener('click', () => send(C2S.START_RACE));
$('mpLeave').addEventListener('click', () => { send(C2S.LEAVE_ROOM); room = null; show('mpRoom', false); show('mpRooms', true); });
$('mpCopy').addEventListener('click', () => navigator.clipboard?.writeText(room?.code || ''));

// ---------- Kapcsolat ----------

// ---------- Mesterséges hálózati késleltetés (fejlesztéshez) ----------
// Localhoston a ping 0 ms: a lomhaság nem látszik, és így a javítása sem
// ellenőrizhető. Ez a réteg mindkét irányba késleltetést tesz, hogy a valódi
// játékélményt még deploy nélkül is meg lehessen nézni — determinisztikusan és
// ismételhetően, szemben egy éles szerverrel, ahol minden mérés más.
//
// FONTOS: a WebSocket TCP fölött megy, ami SOHA nem cserél sorrendet. Ezért a
// kézbesítés jitter mellett is monoton: egy csomag nem előzheti meg az előtte
// küldöttet. Enélkül a szimulátor olyan hibát mutatna (átrendeződés), ami
// élesben elő sem fordulhat — és a snapshot-puffer interpolációját is
// összezavarná.
const netsim = { up: 0, down: 0, jitter: 0 };
let upReleaseAt = 0;
let downReleaseAt = 0;

function delayed(dir, fn) {
  const base = dir === 'up' ? netsim.up : netsim.down;
  // Kikapcsolva nincs setTimeout sem — a normál út közvetlen hívás marad.
  if (base <= 0 && netsim.jitter <= 0) return fn();
  const now = performance.now();
  const target = now + base + (netsim.jitter > 0 ? Math.random() * netsim.jitter : 0);
  const at = dir === 'up'
    ? (upReleaseAt = Math.max(upReleaseAt, target))
    : (downReleaseAt = Math.max(downReleaseAt, target));
  setTimeout(fn, at - now);
}

// A megadott érték a teljes körbefordulás (RTT), ahogy a ping is — ezért
// felezve kerül a két irányra.
function setPing(rttMs, jitterMs = 0) {
  netsim.up = netsim.down = Math.max(0, rttMs) / 2;
  netsim.jitter = Math.max(0, jitterMs);
  return { ...netsim, rtt: rttMs, jitter: jitterMs };
}

// ?lag=150 (opcionálisan ?jitter=30) az URL-ben — kényelmi kapcsoló, hogy
// újratöltéskor ne kelljen kézzel beállítani.
{
  const q = new URLSearchParams(location.search);
  if (q.has('lag')) setPing(Number(q.get('lag')) || 0, Number(q.get('jitter')) || 0);
}

function send(type, data = {}) {
  if (ws?.readyState !== 1) return;
  const payload = JSON.stringify({ type, ...data });
  delayed('up', () => { if (ws?.readyState === 1) ws.send(payload); });
}

function connect(name) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.addEventListener('open', () => {
    setErr('');
    send(C2S.HELLO, { name, token: me.token });
  });
  ws.addEventListener('message', (ev) => {
    // A feldolgozást késleltetjük, nem a JSON-elemzést — így a szimulátor
    // költsége nem torzítja a mért időt.
    const m = JSON.parse(ev.data);
    delayed('down', () => onMessage(m));
  });
  ws.addEventListener('close', () => {
    setErr('A kapcsolat megszakadt.');
    show('mpLogin', true); show('mpRooms', false); show('mpRoom', false);
    stopInputLoop();
  });
  ws.addEventListener('error', () => setErr('Nem sikerült csatlakozni a szerverhez.'));
}

function onMessage(m) {
  switch (m.type) {
    case S2C.WELCOME:
      me = { id: m.playerId, name: m.name, token: m.token };
      localStorage.setItem('racing.token', m.token);
      $('mpWho').textContent = m.name;
      show('mpLogin', false); show('mpRooms', true);
      break;

    case S2C.ROOM_STATE:
      room = m.room;
      renderRoom();
      break;

    case S2C.ROOM_CLOSED:
      room = null;
      show('mpRoom', false); show('mpRooms', true);
      setErr(m.reason || '');
      break;

    case S2C.RACE_STARTING:
      starting = m;
      beginRace(m).catch((err) => setErr('Nem sikerült betölteni a versenyt: ' + err.message));
      break;

    case S2C.SNAPSHOT:
      onSnapshot(m);
      break;

    case S2C.RACE_EVENT:
      lastEvents.unshift(m);
      lastEvents = lastEvents.slice(0, 4);
      break;

    case S2C.RACE_END:
      showResults(m.results);
      break;

    case S2C.ERROR:
      setErr(m.message);
      break;
  }
}

function renderRoom() {
  if (!room) return;
  show('mpRooms', false); show('mpRoom', true);
  $('mpRoomCode').textContent = room.code;
  const map = G.manifest?.maps.find((x) => x.id === room.mapId);
  $('mpRoomMap').textContent = map?.label || room.mapId;
  $('mpRoomLaps').textContent = room.laps;
  $('mpPlayers').innerHTML = room.players.map((p) => {
    const car = G.manifest?.cars.find((c) => c.id === p.carId);
    return `<li>${p.isHost ? '👑 ' : ''}${escapeHtml(p.name)}${p.id === me.id ? ' <em>(te)</em>' : ''}
      <span class="text-secondary">— ${escapeHtml(car?.label || p.carId || 'nincs kocsi')}</span></li>`;
  }).join('');
  const isHost = room.hostId === me.id;
  $('mpStart').disabled = !isHost;
  $('mpHint').textContent = isHost
    ? 'Te vagy a szoba tulajdonosa — te indíthatod a versenyt.'
    : 'Várakozás a szoba tulajdonosára...';
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Verseny ----------

async function beginRace(info) {
  closeLobby();
  window.__mp.stage = 'start';
  G.setMenuStatus('Verseny betöltése...');

  // A saját kocsi és a pálya betöltése (ha még nem az van betöltve).
  const myPlayer = info.players.find((p) => p.id === me.id);
  const map = G.manifest.maps.find((m) => m.id === info.mapId);
  if (G.currentMapId !== info.mapId) {
    await G.setTrack('assets/' + map.file, map.id, map.spawns, map.gates);
  }
  window.__mp.stage = 'track-kesz';
  const car = G.manifest.cars.find((c) => c.id === myPlayer?.carId);
  if (car) await G.setCar('assets/' + car.file, car.id, car.config);
  window.__mp.stage = 'kocsi-kesz';
  await G.prepareTrackPhysics();
  window.__mp.stage = 'fizika-kesz';

  // A többi játékos kocsija — külön modellek, a saját konfigjukkal.
  for (const p of info.players) {
    if (p.id === me.id) continue;
    await addOtherCar(p);
  }

  window.__mp.stage = 'tobbiek-kesz';
  G.setMenuStatus('');
  G.enterMultiplayer(frame);
  window.__mp.stage = 'fut';
  // A bemenet-küldést NEM itt indítjuk, hanem az első snapshotnál. A
  // raceStarting jóval előbb megérkezik, mint ahogy a szerver szimulációja
  // tényleg futni kezd (előtte betölti a pálya ütközési hálóját) — az addig
  // elküldött bemenetek csak felhalmozódnának a szerver sorában, és onnantól
  // minden bemenet ennyivel késve érvényesülne. Az első snapshot a bizonyíték
  // arra, hogy a szimuláció ÉL és fogyaszt.
  awaitingFirstSnapshot = true;
}

async function addOtherCar(p) {
  const car = G.manifest.cars.find((c) => c.id === p.carId) || G.manifest.cars[0];
  const group = new THREE.Group();
  try {
    const gltf = await G.loadGLTF('assets/' + car.file);
    const model = gltf.scene;
    // Ugyanaz a normalizálás, mint a saját kocsinál: a hossz-tengely Z-re
    // forgatva, és a fizikai kasztni hosszára skálázva — enélkül a többiek
    // más méretben látszanának.
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const yaw = (size.x >= size.z ? Math.PI / 2 : 0) + THREE.MathUtils.degToRad(car.config?.yawDegrees || 0);
    model.rotation.y = yaw;
    model.updateMatrixWorld(true);
    const box2 = new THREE.Box3().setFromObject(model);
    const size2 = box2.getSize(new THREE.Vector3());
    const scale = size2.z > 0 ? 4.4 / size2.z : 1;
    model.scale.setScalar(scale);
    model.updateMatrixWorld(true);
    const box3 = new THREE.Box3().setFromObject(model);
    model.position.y = -box3.min.y - 0.85;
    group.add(model);
  } catch {
    // Ha a modell nem tölthető, egy doboz is jobb, mint egy láthatatlan
    // ellenfél, akinek nekimehetünk.
    group.add(new THREE.Mesh(
      new THREE.BoxGeometry(2, 0.8, 4.4),
      new THREE.MeshStandardMaterial({ color: 0xff4444 })
    ));
  }

  // Névtábla a kocsi fölött
  const label = makeNameSprite(p.name);
  label.position.y = 1.8;
  group.add(label);

  G.scene.add(group);
  others.set(p.id, { group, buf: [] });
}

function makeNameSprite(name) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 28px sans-serif';
  g.textAlign = 'center';
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.fillRect(0, 0, 256, 64);
  g.fillStyle = '#fff';
  g.fillText(name.slice(0, 16), 128, 42);
  const tex = new THREE.CanvasTexture(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set(3, 0.75, 1);
  return sp;
}

// A beérkező állapotokat pufferbe tesszük, és KÉSLELTETVE játsszuk vissza.
// Enélkül minden csomagvesztés megakasztaná a mozgást; így viszont mindig
// van két állapot, ami közt interpolálhatunk.
const INTERP_DELAY_MS = 100;

// ---------- Client-side prediction ----------
// A saját kocsit a HELYI fizika mozgatja, azonnal a billentyűkre reagálva —
// nem várjuk meg a szerver válaszát. A szerver marad a hiteles forrás: minden
// snapshotnál visszaállunk az általa küldött állapotra, és újrajátsszuk azokat
// a bemeneteket, amiket ő még nem dolgozott fel.
//
// Ez CSAK azért működhet pontosan, mert (1) a két oldal ugyanazt a
// buildVehicle/applyControls kódot futtatja ugyanazon a Rapier buildon, és
// (2) a szerver tickenként pontosan egy bemenetet fogyaszt — tehát az
// újrajátszás bemenetenként egy lépés.
//
// ?predict=0 kikapcsolja, és visszaáll a régi, szerverkövető viselkedésre —
// így ugyanazon a késleltetésen összehasonlítható a kettő.
const predict = new URLSearchParams(location.search).get('predict') !== '0';

// A szerver által legutóbb FELHASZNÁLT saját bemenet sorszáma. Minden, ami
// ennél újabb, még nincs benne a kapott állapotban — azokat kell a
// prediction újrajátszania.
let ackedSeq = 0;

// A korrekció simítása. A jóslat és a szerver igazsága közti különbséget nem
// ugrásként visszük fel, hanem eltolásként, ami ~120 ms alatt lecseng. A
// fizika közben MÁR a helyes állapotban van; ez pusztán a megjelenítés.
const smooth = { p: [0, 0, 0], q: [0, 0, 0, 1], active: false };
const SMOOTH_HALFLIFE = 0.12;   // mp
// Efölött nincs értelme simítani (újraszületés, nagy ütközés, teleport) —
// olyankor a hirtelen ugrás a helyes, mert a köztes út hazugság lenne.
const SMOOTH_MAX_DIST = 8;

function decaySmoothing(dt) {
  if (!smooth.active) return;
  const k = Math.pow(0.5, dt / SMOOTH_HALFLIFE);
  smooth.p[0] *= k; smooth.p[1] *= k; smooth.p[2] *= k;
  smooth.q = slerp([0, 0, 0, 1], smooth.q, k);
  if (Math.hypot(...smooth.p) < 0.005) {
    smooth.p = [0, 0, 0];
    smooth.q = [0, 0, 0, 1];
    smooth.active = false;
  }
}

function mulQuat(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

// A szerver állapotára visszaállás, majd a nyugtázatlan bemenetek
// újrajátszása. Bemenetenként PONTOSAN egy lépés — ugyanannyi, amennyit a
// szerver is tenni fog, mire hozzájuk ér.
function reconcile(state) {
  const before = G.getCarState();

  G.setCarState(state);
  for (const input of inputHistory) G.stepLocalPhysics(input, isFrozen());

  const after = G.getCarState();
  const dx = before.p[0] - after.p[0];
  const dy = before.p[1] - after.p[1];
  const dz = before.p[2] - after.p[2];
  const dist = Math.hypot(dx, dy, dz);
  window.__mp.lastError = +dist.toFixed(3);

  if (dist > SMOOTH_MAX_DIST) {
    // Túl nagy ugrás a simításhoz: ilyenkor a hirtelen váltás a helyes.
    smooth.p = [0, 0, 0];
    smooth.q = [0, 0, 0, 1];
    smooth.active = false;
    return;
  }
  // A LÁTHATÓ kocsi ott marad, ahol volt, és onnan csúszik a helyes helyre.
  smooth.p = [dx, dy, dz];
  smooth.q = mulQuat(before.q, invQuat(after.q));
  smooth.active = true;
}

function invQuat(q) {
  return [-q[0], -q[1], -q[2], q[3]];   // egységkvaternióra a konjugált
}

// A visszaszámlálás alatt a szerver befagyasztja a kocsikat — a jóslatnak
// ugyanezt kell tennie, különben elindulnánk a rajt előtt.
function isFrozen() {
  return !!starting?.startsAt && Date.now() < starting.startsAt;
}

function onSnapshot(m) {
  window.__mp.snaps++;
  if (awaitingFirstSnapshot) {
    awaitingFirstSnapshot = false;
    startInputLoop();
  }
  for (const c of m.cars) {
    const entry = c.id === me.id ? null : others.get(c.id);
    const buf = entry ? entry.buf : selfBuf;
    buf.push({ t: m.t, p: c.p, q: c.q, v: c.v, seq: c.seq, lap: c.lap });
    // Csak a közelmúlt kell; a régit eldobjuk.
    while (buf.length > 30) buf.shift();
    if (c.id === me.id) {
      G.setSpeed(Math.hypot(c.v[0], c.v[2]) * 3.6);
      myLap = c.lap;
      ackedSeq = c.seq || 0;
      // A nyugtázott bemenetek hatása már benne van a kapott állapotban,
      // őket nem szabad újrajátszani.
      while (inputHistory.length && inputHistory[0].seq <= ackedSeq) inputHistory.shift();
      // A maradékot viszont igen: a szerver ezekhez még nem ért hozzá.
      if (predict && inputTimer) reconcile({ p: c.p, q: c.q, v: c.v, w: c.w });
    }
  }
}

let myLap = 0;

function sampleAt(buf, renderTime) {
  if (!buf.length) return null;
  if (buf.length === 1) return buf[0];
  for (let i = buf.length - 1; i > 0; i--) {
    if (buf[i - 1].t <= renderTime && renderTime <= buf[i].t) {
      const a = buf[i - 1], b = buf[i];
      const span = b.t - a.t;
      const f = span > 0 ? (renderTime - a.t) / span : 0;
      return {
        p: [a.p[0] + (b.p[0] - a.p[0]) * f, a.p[1] + (b.p[1] - a.p[1]) * f, a.p[2] + (b.p[2] - a.p[2]) * f],
        q: slerp(a.q, b.q, f),
      };
    }
  }
  // A puffer még nem ért el a kért időig — a legfrissebbet mutatjuk.
  return buf[buf.length - 1];
}

function slerp(a, b, f) {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (dot < 0) { bb = [-b[0], -b[1], -b[2], -b[3]]; dot = -dot; }
  if (dot > 0.9995) {
    const o = [a[0] + (bb[0] - a[0]) * f, a[1] + (bb[1] - a[1]) * f, a[2] + (bb[2] - a[2]) * f, a[3] + (bb[3] - a[3]) * f];
    const n = Math.hypot(...o) || 1;
    return o.map((v) => v / n);
  }
  const th = Math.acos(dot), s = Math.sin(th);
  const w1 = Math.sin((1 - f) * th) / s, w2 = Math.sin(f * th) / s;
  return [a[0] * w1 + bb[0] * w2, a[1] * w1 + bb[1] * w2, a[2] * w1 + bb[2] * w2, a[3] * w1 + bb[3] * w2];
}

// Minden képkockán fut (a main.js animate-jéből).
// A dt-nek van alapértéke, mert a __mp.step() (kézi léptetés teszteléshez)
// paraméter nélkül hívja — enélkül a simítás lecsengése NaN-ra futna.
function frame(dt = 1 / 60) {
  window.__mp.frames++;
  const renderTime = Date.now() - INTERP_DELAY_MS;

  if (predict) {
    // JÓSLÁS: a saját kocsit a HELYI fizika mozgatja, azonnal reagálva a
    // billentyűkre. A szerver korrekcióját nem ugrásként visszük fel, hanem
    // egy lecsengő eltolással (ld. reconcile) — így a kocsi akkor sem
    // rándul, ha a jóslat egy kicsit mellément.
    const s = G.getCarState();
    decaySmoothing(dt);
    G.applyServerTransform(
      [s.p[0] + smooth.p[0], s.p[1] + smooth.p[1], s.p[2] + smooth.p[2]],
      smooth.active ? mulQuat(smooth.q, s.q) : s.q
    );
  } else {
    // JÓSLÁS NÉLKÜL (?predict=0): a saját kocsi a szerver állapotát követi.
    // A késleltetést itt sem alkalmazzuk — az a többiek simításához kell, a
    // sajátunkat csak még lomhábbá tenné a hálózati út késése MELLÉ jőve.
    // Helyette a legfrissebb állapotot vesszük, és a szerver óta eltelt időre
    // a sebességgel előre becsüljük.
    const mine = selfBuf[selfBuf.length - 1];
    if (mine) {
      // A mine.t a SZERVER órája szerinti idő, a Date.now() a kliensé — a kettő
      // eltérhet, ezért az eredményt mindkét irányban korlátozzuk. Enélkül egy
      // elállított óra a kocsit a semmibe repítené (vagy hátrafelé rántaná).
      const ahead = Math.max(0, Math.min((Date.now() - mine.t) / 1000, 0.25));
      G.applyServerTransform(
        [mine.p[0] + mine.v[0] * ahead, mine.p[1] + mine.v[1] * ahead, mine.p[2] + mine.v[2] * ahead],
        mine.q
      );
    }
  }

  for (const { group, buf } of others.values()) {
    const s = sampleAt(buf, renderTime);
    if (!s) continue;
    group.position.set(s.p[0], s.p[1], s.p[2]);
    group.quaternion.set(s.q[0], s.q[1], s.q[2], s.q[3]);
  }

  const evt = lastEvents[0];
  G.setHud(
    `Kör: <strong>${myLap + 1} / ${room?.laps ?? '?'}</strong><br>` +
    `Játékosok: ${(room?.players.length ?? 1)}<br>` +
    (evt ? `<span class="text-warning">${escapeHtml(eventText(evt))}</span>` : '')
  );
}

function eventText(e) {
  const who = room?.players.find((p) => p.id === e.playerId)?.name || 'Valaki';
  if (e.kind === 'lap') return `${who}: ${e.lap}. kör ${(e.timeMs / 1000).toFixed(2)}s${e.invalid ? ' ⚠️' : ''}`;
  if (e.kind === 'finished') return `${who} célba ért!`;
  if (e.kind === 'left') return `${e.name} kilépett`;
  return '';
}

// A bemenetet fix ütemben küldjük, nem képkockánként: így a hálózati terhelés
// független attól, milyen erős a gép.
//
// Az ütem PONTOSAN a szerver tickje (TICK_MS), mert a szerver tickenként
// egyetlen bemenetet fogyaszt el a sorából. Egy input = egy tick: csak így
// tudja a kliens újrajátszani azt, amit a szerver számolt — enélkül nem
// tudhatná, hány tickre érvényesült egy-egy bemenete, és a prediction
// korrekciója sosem konvergálna.
//
// A megőrzött előzmény (inputHistory) a nyugtázatlan bemeneteket tartalmazza:
// a szerver a snapshotban visszaküldi, meddig HASZNÁLTA FEL őket, az addigiakat
// eldobjuk, a többit pedig újra le kell játszani a kapott állapotra.
const inputHistory = [];

function startInputLoop() {
  stopInputLoop();
  // Új verseny: a sorszámozás és az előzmény is nulláról indul, különben a
  // szerver (ami szintén 0-ról kezd) a régi, magas sorszámokat látná.
  inputSeq = 0;
  ackedSeq = 0;
  inputHistory.length = 0;
  smooth.p = [0, 0, 0];
  smooth.q = [0, 0, 0, 1];
  smooth.active = false;
  inputTimer = setInterval(() => {
    const k = G.keys;
    const input = {
      seq: ++inputSeq,
      steer: (k['KeyA'] || k['ArrowLeft']) ? 1 : (k['KeyD'] || k['ArrowRight']) ? -1 : 0,
      throttle: (k['KeyW'] || k['ArrowUp']) ? 1 : (k['KeyS'] || k['ArrowDown']) ? -1 : 0,
      brake: !!k['Space'],
    };
    inputHistory.push(input);
    // Fél másodpercnyi tartalék bőven elég: ennél régebbi bemenetet már
    // rég nyugtázott a szerver (különben a kapcsolat amúgy is használhatatlan).
    while (inputHistory.length > TICK_RATE / 2) inputHistory.shift();
    send(C2S.INPUT, input);
    // Ugyanaz a bemenet AZONNAL lefut helyben is: egy bemenet = egy lépés,
    // pontosan úgy, ahogy a szerver majd elvégzi. Ettől reagál a kocsi
    // késleltetés nélkül a billentyűkre.
    if (predict) G.stepLocalPhysics(input, isFrozen());
  }, TICK_MS);
}
function stopInputLoop() {
  if (inputTimer) clearInterval(inputTimer);
  inputTimer = null;
}

function showResults(results) {
  stopInputLoop();
  const rows = results.map((r) => {
    const name = room?.players.find((p) => p.id === r.playerId)?.name || '?';
    const best = r.bestLapMs ? (r.bestLapMs / 1000).toFixed(2) + 's' : '—';
    return `<div class="small">${r.position}. ${escapeHtml(name)} — ${(r.totalMs / 1000).toFixed(2)}s (legjobb kör: ${best})</div>`;
  }).join('');
  G.setHud(`<strong>Vége!</strong><br>${rows}`);
  setTimeout(() => {
    for (const { group } of others.values()) G.scene.remove(group);
    others.clear();
    selfBuf = [];
    G.leaveMultiplayer();
    openLobby();
  }, 8000);
}

// A menübe egy gomb, ami megnyitja a lobbyt.
const btn = document.createElement('button');
btn.id = 'mpOpenBtn';
btn.className = 'btn btn-warning w-100 mt-2';
btn.textContent = 'Többjátékos';
btn.addEventListener('click', openLobby);
document.getElementById('startBtn')?.insertAdjacentElement('afterend', btn);
