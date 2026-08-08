// Multiplayer kliens: lobby, kapcsolat, és a többi autó megjelenítése.
//
// Multiplayerben a SZERVER a hiteles forrás — a helyi fizika nem fut. Ez a
// modul a bemenetet küldi, és a beérkező állapotot jeleníti meg; a köztes
// időt interpolálja, hogy a 20/mp állapot is folyamatos mozgásnak látsszon.
import { C2S, S2C, ROOM_STATE, TAINT, TICK_RATE, TICK_MS, sanitizeName } from '/shared/protocol.js';
import { forwardSpeed, REVERSE_BRAKE_THRESHOLD } from '/shared/vehicleConfig.js';

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
  // Az óra-sodródás elleni szabályozás állapota: milyen mély a szerver sora,
  // és mennyire tért el ettől a küldési ütem a névleges tick-időtől.
  get queueDepth() { return queueDepth; },
  get queueTarget() { return queueTarget; },
  get queueDrops() { return queueDrops; },
  get queueUnderflows() { return queueUnderflows; },
  get sendPeriod() { return +sendPeriod.toFixed(2); },
  get pingMs() { return +pingRttMs.toFixed(1); },
  get jitterMs() { return +pingJitterMs.toFixed(1); },
  get clockOffsetMs() { return +clockOffsetMs.toFixed(1); },
  get interpDelayMs() { return +interpDelayMs.toFixed(1); },
  get physSteps() { return physSteps; },
  // Rángás-diagnosztikához: a kirajzolt pozíció három összetevője külön.
  // Így kiderül, MELYIK ugrik — a nyers fizika, az interpoláció, vagy a
  // korrekció-simítás —, ahelyett hogy tippelnénk.
  get rawPos() { const s = G.getCarState(); return [s.p[0], s.p[2]]; },
  get interpPos() { const s = interpolatedPhys(); return [s.p[0], s.p[2]]; },
  get smoothLen() { return Math.hypot(smooth.p[0], smooth.p[1], smooth.p[2]); },
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
// A verseny végi visszaszámláló (eredményhirdetés -> lobby). Azért tároljuk,
// mert le KELL tudni lőni: ha a játékos a 8 mp letelte előtt a "Menü" gombbal
// lép ki, a később elsülő időzítő visszarántaná a lobbyba az egyjátékos
// menetből.
let resultsTimer = null;
let inputSeq = 0;
let awaitingFirstSnapshot = false;
let raceLoadGeneration = 0;
let raceLoadActive = false;
let queueDepth = 0;
let queueDrops = 0;
let queueUnderflows = 0;
let queueTarget = 1;
let queueTargetBoost = 0;
let lastQueueIssueAt = 0;
// Elromlott-e már az aktuális kör a szerver szerint, és ha igen, MIÉRT: a
// snapshot `ti` mezője a TAINT kódját küldi (0 = érvényes). A konkrét ok kell,
// nem csak egy igen/nem — abból a játékos nem tudja, mit rontott el.
let lapTainted = TAINT.NONE;
let inputTimer = null;
// A RACE_END után true: a frame() innentől nem írja felül a HUD-ot a
// kör/játékos szöveggel, különben a showResults() eredménylistája egyetlen
// képkockányi ideig látszana csak, mielőtt a következő frame() lenullázná.
let raceEnded = false;
let lastEvents = [];

// ---------- Lobby felület ----------

const el = document.createElement('div');
el.id = 'mpOverlay';
el.className = 'hidden';
el.innerHTML = `
<div class="mp-panel">
  <div class="mp-head">
    <h5>Többjátékos</h5>
    <button id="mpClose" class="mp-x" title="Vissza a menübe">&times;</button>
  </div>
  <div class="mp-body">
    <div id="mpLogin">
      <label for="mpName" class="lbl d-block mb-2">Játékosnév</label>
      <input id="mpName" class="form-control mb-3" maxlength="20" placeholder="A neved">
      <button id="mpConnect" class="mp-btn primary w-100">Csatlakozás a szerverhez</button>
    </div>

    <div id="mpRooms" class="hidden">
      <div class="mp-chip mb-3">Bejelentkezve: <b id="mpWho"></b></div>
      <button id="mpCreate" class="mp-btn primary w-100">Új szoba létrehozása</button>
      <div class="mp-sep">vagy</div>
      <label for="mpCode" class="lbl d-block mb-2">Csatlakozás kóddal</label>
      <div class="d-flex gap-2">
        <input id="mpCode" class="form-control text-uppercase" maxlength="6" placeholder="SZOBAKÓD"
               style="letter-spacing:.16em; font-weight:700;">
        <button id="mpJoin" class="mp-btn ghost" style="flex:none;">Belépés</button>
      </div>
    </div>

    <div id="mpRoom" class="hidden">
      <div class="mp-code-box">
        <div>
          <span class="lbl d-block mb-2">Szobakód</span>
          <span id="mpRoomCode" class="mp-code-val num"></span>
        </div>
        <button id="mpCopy" class="mp-btn ghost" style="flex:none;">Másol</button>
      </div>
      <div class="mp-meta">
        <span class="mp-chip">Pálya: <b id="mpRoomMap"></b></span>
        <span class="mp-chip"><b id="mpRoomLaps"></b> kör</span>
      </div>
      <span class="lbl d-block mb-2">Játékosok</span>
      <div id="mpPlayers"></div>
      <div id="mpHint" class="mp-note"></div>
      <div class="d-flex gap-2 mt-3">
        <button id="mpStart" class="mp-btn primary flex-grow-1">Verseny indítása</button>
        <button id="mpLeave" class="mp-btn danger">Kilépés</button>
      </div>
    </div>

    <div id="mpError"></div>
  </div>
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
$('mpLeave').addEventListener('click', () => {
  send(C2S.LEAVE_ROOM);
  clearOtherCars();
  room = null;
  show('mpRoom', false); show('mpRooms', true);
});
$('mpCopy').addEventListener('click', () => navigator.clipboard?.writeText(room?.code || ''));

// Az "R" multiplayerben KÉRÉS a szerver felé, nem helyi teleport — a kocsi
// helyét a szerver birtokolja. Élre figyelünk (e.repeat nélkül), nem a
// lenyomva tartásra: különben képkockánként küldenénk egy kérést.
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR' && !e.repeat && G.appState === 'mp') send(C2S.RESET);
});

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

// ---------- Ping mérés ----------
// A szerver a C2S.PING-et változatlanul visszaküldi C2S.PONG-ként (lásd
// wsServer.js) — a kliens feladata csak a küldés és a körút-idő számolása.
// A send()/onMessage() már átmegy a netsim mesterséges késleltetésén is
// (delayed 'up' / 'down'), tehát __mp.setPing(150) hatása itt is látszik —
// ez egyben a ping-kijelző saját ellenőrzése is.
let pingTimer = null;
const PING_INTERVAL_MS = 1000;
let pingRttMs = 0;
let lastPingRttMs = null;
let pingJitterMs = 0;
let clockOffsetMs = 0;
let clockReady = false;

// Minden abszolút szerveridő (snapshot, rajt) ezen keresztül megy. A PONG
// mintákból becsült offset miatt a kliens elállított órája sem tolja el a
// visszaszámlálást vagy az interpolációs ablakot.
function serverNow() {
  return Date.now() + (clockReady ? clockOffsetMs : 0);
}

function sendPing() {
  send(C2S.PING, { t: performance.now(), clientNow: Date.now() });
}

function startPingLoop() {
  stopPingLoop();
  lastPingRttMs = null;
  pingJitterMs = 0;
  sendPing();
  pingTimer = setInterval(sendPing, PING_INTERVAL_MS);
}

function stopPingLoop() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
}

function connect(name) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.addEventListener('open', () => {
    setErr('');
    send(C2S.HELLO, { name, token: me.token });
    startPingLoop();
  });
  ws.addEventListener('message', (ev) => {
    // A feldolgozást késleltetjük, nem a JSON-elemzést — így a szimulátor
    // költsége nem torzítja a mért időt.
    const m = JSON.parse(ev.data);
    delayed('down', () => onMessage(m));
  });
  ws.addEventListener('close', () => {
    setErr('A kapcsolat megszakadt.');
    // Verseny közbeni szakadásnál a többiek kocsija ott ragadna a pályán —
    // örökre mozdulatlanul, hiszen több snapshot nem jön hozzájuk.
    clearOtherCars();
    cancelRaceLoad();
    show('mpLogin', true); show('mpRooms', false); show('mpRoom', false);
    stopInputLoop();
    stopPingLoop();
    awaitingFirstSnapshot = false;
    room = null;
    starting = null;
    G.detachMultiplayerFrame();
    if (G.appState === 'mp') G.leaveMultiplayer();
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
      // Ez verseny KÖZBEN is jöhet (pl. a szoba gazdája kilép) — ilyenkor a
      // lobby jön elő, nem a menü, tehát az enterMenu()-s takarítás nem sülne el.
      clearOtherCars();
      cancelRaceLoad();
      room = null;
      starting = null;
      stopInputLoop();
      awaitingFirstSnapshot = false;
      G.detachMultiplayerFrame();
      if (G.appState === 'mp') G.leaveMultiplayer();
      show('mpRoom', false); show('mpRooms', true);
      setErr(m.reason || '');
      break;

    case S2C.RACE_STARTING:
      // Ez a "töltsd be" jel: rajtidő még NINCS benne, azt a RACE_COUNTDOWN adja.
      starting = m;
      beginRace(m).catch((err) => {
        // A játékos vagy a kapcsolat közben kilépett, és már másik életciklus
        // az aktuális. Az elkéső régi betöltés nem nyithatja vissza a lobbyt.
        if (starting !== m) return;
        // A félbeszakadt betöltés is hagyhat kocsikat a jelenetben: az
        // addOtherCar játékosonként külön fut, tehát a hiba előtt sikeresen
        // betöltöttek MÁR bekerültek a scene-be.
        clearOtherCars();
        cancelRaceLoad();
        if (room && room.state !== ROOM_STATE.LOBBY) send(C2S.LEAVE_ROOM);
        room = null;
        starting = null;
        show('mpRoom', false);
        show('mpRooms', true);
        // A lobbyt újra kinyitjuk, különben a játékos egy üres képernyőn
        // maradna, és nem is látná, mi a hiba.
        openLobby();
        setErr('Nem sikerült betölteni a versenyt: ' + err.message);
      });
      break;

    case S2C.RACE_COUNTDOWN:
      // Mindenki betöltött (vagy lejárt a türelmi idő): innen számol a 3-2-1.
      if (starting) starting.startsAt = m.startsAt;
      break;

    case S2C.SNAPSHOT:
      onSnapshot(m);
      break;

    case S2C.RACE_EVENT:
      // A kilépés nem csak egy HUD-üzenet: a kocsiját is le kell venni a
      // pályáról. Ő nem kap több snapshotot, tehát az utolsó pozícióján
      // megfagyva ott maradna a verseny végéig.
      if (m.kind === 'left') removeOtherCar(m.playerId);
      lastEvents.unshift(m);
      lastEvents = lastEvents.slice(0, 4);
      break;

    case S2C.RACE_END:
      showResults(m.results);
      break;

    case S2C.PONG:
      {
        const rtt = Math.max(0, performance.now() - m.t);
        if (lastPingRttMs !== null) {
          const delta = Math.abs(rtt - lastPingRttMs);
          pingJitterMs += (delta - pingJitterMs) * 0.25;
        }
        lastPingRttMs = rtt;
        pingRttMs = pingRttMs ? pingRttMs * 0.75 + rtt * 0.25 : rtt;
        // A szerver a PONG elküldése előtti saját idejét adja. Szimmetrikus
        // hálózati úttal a válasz megérkezésekor serverNow + RTT/2 a legjobb
        // becslés; az EWMA kiszűri az egy-egy torlódott mintát.
        if (Number.isFinite(m.serverNow)) {
          const sampleOffset = m.serverNow + rtt / 2 - Date.now();
          if (!clockReady) {
            clockOffsetMs = sampleOffset;
            clockReady = true;
          } else {
            clockOffsetMs += (sampleOffset - clockOffsetMs) * 0.1;
          }
        }
        // Csak a jitter növeli az alap inputpuffert; a stabil ping nem. Ha a
        // szerver mégis kiéhezést jelentett, arra külön, lassan lecsengő plusz
        // tartalék kerül (onSnapshot), nem írjuk felül a következő PONG-nál.
        const jitterTarget = 1 + Math.ceil(pingJitterMs / TICK_MS);
        if (queueTargetBoost && performance.now() - lastQueueIssueAt > 10000) {
          queueTargetBoost--;
          lastQueueIssueAt = performance.now();
        }
        queueTarget = Math.max(1, Math.min(6, jitterTarget + queueTargetBoost));
        G.setPingMs(pingRttMs);
      }
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
    const self = p.id === me.id;
    return `<div class="mp-player${self ? ' is-self' : ''}">` +
      `<span class="dot" style="background:${safeColor(p.color)}"></span>` +
      '<span class="who">' +
        `<span class="nm">${escapeHtml(p.name)}${self ? ' (te)' : ''}</span>` +
        `<span class="car">${escapeHtml(car?.label || p.carId || 'nincs kocsi')}</span>` +
      '</span>' +
      (p.isHost ? '<span class="mp-crown" title="Szoba tulajdonosa">👑</span>' : '') +
    '</div>';
  }).join('');
  const isHost = room.hostId === me.id;
  $('mpStart').disabled = !isHost;
  $('mpHint').className = 'mp-note' + (isHost ? ' is-host' : '');
  $('mpHint').textContent = isHost
    ? 'Te vagy a szoba tulajdonosa — te indíthatod a versenyt.'
    : 'Várakozás a szoba tulajdonosára…';
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A játékos színe apró pöttyként. Ugyanez a szín jelöli a minitérképen, a
// névtáblán és a lobby-listán is — a szoba osztja ki, tehát mindenkinél egyezik.
// A szín a palettából jön (shared/protocol.js), nem felhasználói adat, de a
// CSS-be így is csak a hexa-alakot engedjük be.
const safeColor = (color) => (/^#[0-9a-f]{6}$/i.test(color || '') ? color : '#ffffff');
const colorDot = (color) =>
  `<span class="st-dot" style="background:${safeColor(color)}"></span>`;

// ---------- Verseny ----------

async function beginRace(info) {
  const loadGeneration = ++raceLoadGeneration;
  raceLoadActive = true;
  closeLobby();
  window.__mp.stage = 'start';
  raceEnded = false;
  // Tiszta lappal indulunk, FÜGGETLENÜL attól, hogyan ért véget az előző
  // meccs. Ez az utolsó védvonal: ha bármelyik kilépési ág mégis kihagyná a
  // takarítást, itt akkor sem halmozódhatnak egymásra az előző meccs kocsijai.
  clearOtherCars();
  resetNetworkRaceState();
  // Biztonsági háló: a dev autó-tesztelő élő hangolása (motorerő/fék/tapadás)
  // csak a helyi jóslatot érintené, de multiplayerben a szerver mindig a
  // kanonikus értékekkel számol — a jóslatnak is azzal kell indulnia, különben
  // folytonos, meglepő korrekciók jönnének.
  G.resetLiveVehicleTunables();
  G.setMenuStatus('Verseny betöltése...');

  // A saját kocsi, a pálya és a többi játékos kocsija — mind egyszerre, EGY
  // fájlméret szerint súlyozott betöltés-sávon, hogy szar neten is látszódjon
  // a haladás ahelyett, hogy percekig néma maradna a képernyő.
  const myPlayer = info.players.find((p) => p.id === me.id);
  const map = G.manifest.maps.find((m) => m.id === info.mapId);
  const car = G.manifest.cars.find((c) => c.id === myPlayer?.carId);
  const otherPlayers = info.players.filter((p) => p.id !== me.id);

  const tasks = [];
  if (G.currentMapId !== info.mapId) {
    tasks.push({ bytes: map.bytes, run: (onP) => G.setTrack('assets/' + map.file, map.id, map.spawns, map.gates, onP) });
  }
  if (car) {
    tasks.push({ bytes: car.bytes, run: (onP) => G.setCar('assets/' + car.file, car.id, car.config, onP) });
  }
  otherPlayers.forEach((p) => {
    const otherCar = G.manifest.cars.find((c) => c.id === p.carId) || G.manifest.cars[0];
    tasks.push({ bytes: otherCar?.bytes, run: (onP) => addOtherCar(p, onP, loadGeneration) });
  });

  G.showLoadingOverlay(true);
  try {
    await G.runLoadTasks(tasks);
  } finally {
    if (loadGeneration === raceLoadGeneration) G.hideLoadingOverlay();
  }
  if (loadGeneration !== raceLoadGeneration) return;
  window.__mp.stage = 'kocsi-kesz';
  // strict: multiplayerben a pálya ütközési hálója KÖTELEZŐEN a bekészített
  // fájlból jön, mert a szerver is abból számol. Ha nem tölthető le, itt
  // hibával elhasal — jobb, mint némán rossz geometrián versenyezni (ettől
  // lebegett a kocsi a pálya fölött).
  await G.prepareTrackPhysics({ strict: true });
  if (loadGeneration !== raceLoadGeneration) return;
  window.__mp.stage = 'fizika-kesz';

  window.__mp.stage = 'tobbiek-kesz';
  G.setMenuStatus('');
  G.enterMultiplayer(frame);
  raceLoadActive = false;
  window.__mp.stage = 'fut';
  // Megvagyunk: innentől a szerveren rajtunk nem áll a rajt. A visszaszámlálás
  // csak akkor indul, ha MINDENKI jelentkezett (vagy lejár a türelmi idő) —
  // enélkül egy lassan töltő játékos a 3-2-1-ből csak az 1-et látta.
  send(C2S.SET_READY, { ready: true });
  // A bemenet-küldést NEM itt indítjuk, hanem az első snapshotnál. A
  // raceStarting jóval előbb megérkezik, mint ahogy a szerver szimulációja
  // tényleg futni kezd (előtte betölti a pálya ütközési hálóját) — az addig
  // elküldött bemenetek csak felhalmozódnának a szerver sorában, és onnantól
  // minden bemenet ennyivel késve érvényesülne. Az első snapshot a bizonyíték
  // arra, hogy a szimuláció ÉL és fogyaszt.
  awaitingFirstSnapshot = true;
}

// ---------- A távoli kocsik eltakarítása ----------
// EGYETLEN hely, ami a többiek modelljeit leszedi a jelenetről. Idempotens:
// bármennyiszer hívható, üres állapoton sem csinál semmit. Minden kilépési
// útnak ezt kell hívnia, mert bármelyik kimaradása "ghost kocsit" hagy az
// előző meccsből — akár az egyjátékos menetben, akár a következő meccsen.
//
// Két beakasztási pontja van, szándékosan átfedésben:
//  1. a main.js enterMenu()-je (setMultiplayerCleanupHook) — ez fogja a
//     menübe visszavezető utakat, a verseny végi "Menü" gombot is;
//  2. innen, közvetlenül azokon az ágakon, amelyek NEM mennek a menübe
//     (kapcsolatvesztés, szoba bezárása, kilépés a szobából) — ilyenkor a
//     lobby jön elő, a menü nem, tehát az 1-es nem sülne el.
function clearOtherCars() {
  if (resultsTimer) { clearTimeout(resultsTimer); resultsTimer = null; }
  for (const id of [...others.keys()]) removeOtherCar(id);
  G.clearRemoteCarProxies();
  selfBuf = [];
}

// Egyetlen játékos kocsijának leszedése — verseny KÖZBEN is, amikor kilép
// vagy megszakad a kapcsolata. Enélkül a szerver ugyan szól róla
// (RACE_EVENT 'left'), de a kocsija megfagyva ott maradna a pályán a meccs
// végéig: több snapshot nem jön hozzá, tehát az utolsó pozícióján ragadna.
function removeOtherCar(playerId) {
  const entry = others.get(playerId);
  if (!entry) return;
  G.scene.remove(entry.group);
  // A scene.remove() csak a jelenetgráfból veszi ki; a GPU-oldali
  // geometria/anyag/textúra enélkül meccsről meccsre halmozódna.
  G.disposeObject3D(entry.group);
  G.removeRemoteCarProxy(playerId);
  others.delete(playerId);
}

function cleanupMultiplayerForMenu() {
  const wasActive = G.appState === 'mp' || !!inputTimer || awaitingFirstSnapshot || raceLoadActive;
  cancelRaceLoad();
  stopInputLoop();
  awaitingFirstSnapshot = false;
  inputHistory.length = 0;
  predBuf.length = 0;
  smooth.p = [0, 0, 0];
  smooth.q = [0, 0, 0, 1];
  smooth.active = false;
  G.detachMultiplayerFrame();
  clearOtherCars();
  resetNetworkRaceState();

  // A versenyből a Menüre kattintás valódi kilépés, nem csak vizuális
  // elrejtés. A befejezett, már lobbyba visszaállt szobát viszont megtartjuk,
  // hogy ugyanazzal a társasággal lehessen újraindítani.
  if (wasActive && room && room.state !== ROOM_STATE.LOBBY) {
    send(C2S.LEAVE_ROOM);
    room = null;
    starting = null;
    show('mpRoom', false);
    show('mpRooms', true);
  }
}

G.setMultiplayerCleanupHook(cleanupMultiplayerForMenu);

function cancelRaceLoad() {
  raceLoadGeneration++;
  raceLoadActive = false;
  G.hideLoadingOverlay();
}

async function addOtherCar(p, onProgress, loadGeneration) {
  const car = G.manifest.cars.find((c) => c.id === p.carId) || G.manifest.cars[0];
  const group = new THREE.Group();
  try {
    const gltf = await G.loadGLTF('assets/' + car.file, onProgress);
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
    // ellenfél, akinek nekimehetünk. A doboz a játékos színét kapja, hogy
    // ilyenkor is beazonosítható legyen.
    group.add(new THREE.Mesh(
      new THREE.BoxGeometry(2, 0.8, 4.4),
      new THREE.MeshStandardMaterial({ color: p.color || '#ff4444' })
    ));
  }

  // Névtábla a kocsi fölött, a játékos színével keretezve — ugyanaz a szín,
  // ami a HUD-listán és a minitérképen is jelöli őt.
  const label = makeNameSprite(p.name, p.color);
  label.position.y = 1.8;
  group.add(label);

  // A modell letöltése közben megszakadhatott a kapcsolat vagy a játékos
  // visszaléphetett a menübe. A késve elkészült objektum ilyenkor nem kerülhet
  // vissza ghostként a jelenetbe.
  if (loadGeneration !== raceLoadGeneration) {
    G.disposeObject3D(group);
    return;
  }
  G.scene.add(group);
  others.set(p.id, { group, buf: [], color: p.color, name: p.name, lap: 0, cp: 0 });
}

function makeNameSprite(name, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 28px sans-serif';
  g.textAlign = 'center';
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.fillRect(0, 0, 256, 64);
  if (color) {
    // Kitöltés helyett keret: a névnek fehéren, olvashatóan kell maradnia
    // akkor is, ha a kiosztott szín világos (sárga/türkiz).
    g.strokeStyle = color;
    g.lineWidth = 6;
    g.strokeRect(3, 3, 250, 58);
  }
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
const MIN_INTERP_DELAY_MS = 100;
const MAX_INTERP_DELAY_MS = 400;
let interpDelayMs = MIN_INTERP_DELAY_MS;
let snapshotTransitMs = 0;
let snapshotJitterMs = 0;
let lastSnapshotTransitMs = null;

function resetNetworkRaceState() {
  interpDelayMs = MIN_INTERP_DELAY_MS;
  snapshotTransitMs = 0;
  snapshotJitterMs = 0;
  lastSnapshotTransitMs = null;
  queueTarget = 1;
  queueTargetBoost = 0;
  lastQueueIssueAt = 0;
}

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
// Az eltolás felső korlátja. Kell, mert a korrekciók sűrűbben jönnek (20/mp),
// mint ahogy a simítás lecseng (120 ms félidő): két korrekció közt csak ~0.75-re
// esik, a maradék pedig halmozódik. Az egyensúly így a hiba ~négyszerese lenne
// — 0 pingnél láthatatlan (1 mm -> 4 mm), nagy késleltetésnél viszont több
// méterrel a valódi helye MÖGÖTT rajzolnánk ki a kocsit. Inkább vállalunk egy
// alig látható maradék-ugrást, mint egy tartós lemaradást.
const SMOOTH_MAX_OFFSET = 1.5;

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
  // Ahol a kocsi LÁTSZIK most — a jóslat PLUSZ a még le nem csengett korábbi
  // korrekció. Ez a fontos: ha csak a nyers jóslatból számolnánk az új
  // eltolást, minden snapshotnál (20/mp) egy csapásra eldobnánk a maradékot,
  // és pont ez adna egy apró, folyamatos rángatást.
  const visualX = before.p[0] + smooth.p[0];
  const visualY = before.p[1] + smooth.p[1];
  const visualZ = before.p[2] + smooth.p[2];
  const visualQ = smooth.active ? mulQuat(smooth.q, before.q) : before.q;

  G.setCarState(state);
  for (const input of inputHistory) {
    syncRemoteProxies(input.at ?? serverNow());
    G.stepLocalPhysics(input, input.frozen ?? isFrozen());
  }

  const after = G.getCarState();
  // A jóslási hiba maga a nyers jóslat és a szerver igazsága közti eltérés —
  // ezt mérjük, nem a látható eltolást.
  window.__mp.lastError = +Math.hypot(
    before.p[0] - after.p[0], before.p[1] - after.p[1], before.p[2] - after.p[2]
  ).toFixed(3);

  // Az újrajátszás a kocsit MÁS pontra tette, mint ahol a jóslat tartott. A
  // puffer a jóslat pályáját tárolja, ezért az EGÉSZ pályát eltoljuk a
  // korrekcióval — így a benne lévő múlt is a javított rendszerben lesz, és a
  // következő lépések folytonosan illeszkednek hozzá. (Korábban itt egyszerűen
  // eldobtam az interpolációt, és mivel korrekció 20-szor jön másodpercenként,
  // a képkocka-simítás gyakorlatilag sosem működött — ez volt a rángás.)
  const cdx = after.p[0] - before.p[0];
  const cdy = after.p[1] - before.p[1];
  const cdz = after.p[2] - before.p[2];
  const cq = mulQuat(after.q, invQuat(before.q));
  for (const e of predBuf) {
    e.p[0] += cdx; e.p[1] += cdy; e.p[2] += cdz;
    e.q = mulQuat(cq, e.q);
  }
  // Új bejegyzést NEM szúrunk be: az eltolás után a puffer utolsó eleme már
  // pontosan a javított állapot (definíció szerint before + delta = after).
  // Egy külön push nulla hosszú szakaszt csinálna, és a rajta való
  // "interpoláció" épp az az ugrás lenne, amit el akarunk kerülni.

  const dx = visualX - after.p[0];
  const dy = visualY - after.p[1];
  const dz = visualZ - after.p[2];
  if (Math.hypot(dx, dy, dz) > SMOOTH_MAX_DIST) {
    // Túl nagy ugrás a simításhoz (újraszületés, teleport): ilyenkor a
    // hirtelen váltás a helyes, a köztes út hazugság lenne.
    smooth.p = [0, 0, 0];
    smooth.q = [0, 0, 0, 1];
    smooth.active = false;
    return;
  }
  // A LÁTHATÓ kocsi ott marad, ahol volt, és onnan csúszik a helyes helyre.
  const len = Math.hypot(dx, dy, dz);
  const k = len > SMOOTH_MAX_OFFSET ? SMOOTH_MAX_OFFSET / len : 1;
  smooth.p = [dx * k, dy * k, dz * k];
  smooth.q = mulQuat(visualQ, invQuat(after.q));
  smooth.active = true;
}

// ---------- A saját kocsi megjelenítése: időbélyeges puffer ----------
// A fizika fix 60 Hz-en lép (a bemenet-hurokban), a képernyő viszont a saját
// frissítésével rajzol — 75 Hz-en mérve a képkockák 27%-ára NULLA lépés jutott,
// 7%-ára kettő. Ha a fizikai test pillanatnyi állapotát rajzolnánk ki, a kocsi
// pont ilyen egyenetlenül haladna: ez a rángás.
//
// Ezért ugyanúgy csináljuk, ahogy a TÁVOLI kocsiknál már bevált: minden
// fizikai lépést időbélyeggel eltárolunk, és a képet egy kicsivel a jelen
// MÖGÖTT, a puffer két eleme közé interpolálva rajzoljuk ki. Így a kirajzolt
// pozíció a VALÓS idő szerint halad, függetlenül attól, mikor esik egy-egy
// fizikai lépés vagy szerver-korrekció.
//
// Ára ennyi megjelenítési késleltetés. Két tick, hogy a setTimeout
// pontatlansága (a lépések nem pontosan 16.67 ms-onként esnek) se tudja
// kiéheztetni az interpolációt.
const PRED_DELAY_MS = TICK_MS * 2;
const predBuf = [];
let physSteps = 0;   // diagnosztikához: hány fizikai lépés történt eddig

// A `t` a lépés ÜTEMEZETT ideje (egyenletesen TICK_MS-enként), nem az, amikor
// a böngésző ténylegesen odaért. A kettő rendszeresen eltér, és a kirajzolás
// az idő szerint interpolál — tehát az egyenletes időbélyeg a lényeg.
function pushPredState(state, t) {
  predBuf.push({ t, p: [...state.p], q: [...state.q] });
  // Negyed másodpercnyi múlt bőven elég a késleltetett mintavételhez.
  while (predBuf.length > 20) predBuf.shift();
}

function recordPhysState(scheduledAt) {
  pushPredState(G.getCarState(), scheduledAt ?? performance.now());
  physSteps++;
}

function interpolatedPhys() {
  if (!predBuf.length) return G.getCarState();
  const at = performance.now() - PRED_DELAY_MS;
  for (let i = predBuf.length - 1; i > 0; i--) {
    const a = predBuf[i - 1], b = predBuf[i];
    if (a.t <= at && at <= b.t) {
      const span = b.t - a.t;
      const f = span > 0 ? (at - a.t) / span : 0;
      return {
        p: [a.p[0] + (b.p[0] - a.p[0]) * f, a.p[1] + (b.p[1] - a.p[1]) * f, a.p[2] + (b.p[2] - a.p[2]) * f],
        q: slerp(a.q, b.q, f),
      };
    }
  }
  // A kért idő a puffer előtt/után van (indulás, vagy megakadt a fizika) —
  // ilyenkor a legközelebbi ismert állapot a legjobb tipp.
  return at < predBuf[0].t ? predBuf[0] : predBuf[predBuf.length - 1];
}

function invQuat(q) {
  return [-q[0], -q[1], -q[2], q[3]];   // egységkvaternióra a konjugált
}

// A visszaszámlálás alatt a szerver befagyasztja a kocsikat — a jóslatnak
// ugyanezt kell tennie, különben elindulnánk a rajt előtt.
// Áll-e még a kocsi (befékezve). Ha a rajtidőt még nem tudjuk, akkor IGEN: a
// szerver a betöltésre várva szintén fagyasztva tartja a kocsikat, és ha a
// kliens közben szabadon jósolna, a két szimuláció azonnal elcsúszna.
function isFrozen() {
  return !starting?.startsAt || serverNow() < starting.startsAt;
}

function onSnapshot(m) {
  window.__mp.snaps++;
  const transit = Math.max(0, serverNow() - m.t);
  if (lastSnapshotTransitMs !== null) {
    const delta = Math.abs(transit - lastSnapshotTransitMs);
    snapshotJitterMs += (delta - snapshotJitterMs) * 0.2;
  }
  lastSnapshotTransitMs = transit;
  snapshotTransitMs = snapshotTransitMs ? snapshotTransitMs * 0.8 + transit * 0.2 : transit;
  interpDelayMs = Math.max(
    MIN_INTERP_DELAY_MS,
    Math.min(MAX_INTERP_DELAY_MS, snapshotTransitMs + 75 + snapshotJitterMs * 2)
  );

  const startAfterSnapshot = awaitingFirstSnapshot;
  awaitingFirstSnapshot = false;
  for (const c of m.cars) {
    const entry = c.id === me.id ? null : others.get(c.id);
    const buf = c.id === me.id ? selfBuf : entry?.buf;
    if (buf) {
      buf.push({ t: m.t, p: c.p, q: c.q, v: c.v, w: c.w, seq: c.seq, lap: c.lap });
      // Az adaptív puffer nagy pingnél 400 ms-ig nőhet; két másodpercnyi múlt
      // elég hozzá és a proxyk történeti újrajátszásához is.
      while (buf.length > 40) buf.shift();
    }
    if (entry) {
      // A HUD-lista sorrendjéhez: hányadik körben tart, és azon belül melyik
      // checkpointot várja. A puffer az interpolációról szól, ez viszont a
      // LEGFRISSEBB állás — a sorrendet nem akarjuk 100 ms-mal késleltetni.
      entry.lap = c.lap ?? 0;
      entry.cp = c.cp ?? 0;
    }
    if (c.id === me.id) {
      G.setSpeed(Math.hypot(c.v[0], c.v[2]) * 3.6);
      myLap = c.lap;
      myCp = c.cp ?? 0;
      ackedSeq = c.seq || 0;
      lapTainted = c.ti || TAINT.NONE;
      // A nyugtázott bemenetek hatása már benne van a kapott állapotban,
      // őket nem szabad újrajátszani.
      while (inputHistory.length && inputHistory[0].seq <= ackedSeq) inputHistory.shift();
      // A maradékot viszont igen: a szerver ezekhez még nem ért hozzá.
      if (predict && inputTimer) reconcile({ p: c.p, q: c.q, v: c.v, w: c.w });
      else if (predict && startAfterSnapshot) G.setCarState({ p: c.p, q: c.q, v: c.v, w: c.w });
      if (typeof c.qd === 'number') {
        queueDepth = c.qd;
        adjustSendRate(c.qd);
      }
      if (typeof c.qdrop === 'number') queueDrops = c.qdrop;
      if (typeof c.qunder === 'number') {
        if (c.qunder > queueUnderflows) {
          queueTargetBoost = Math.min(5, queueTargetBoost + 1);
          lastQueueIssueAt = performance.now();
          queueTarget = Math.min(6, queueTarget + 1);
        }
        queueUnderflows = c.qunder;
      }
    }
  }
  if (startAfterSnapshot) startInputLoop();
}

let myLap = 0;
// Melyik checkpointot várja a saját kocsi — a HUD-lista sorrendjéhez, körön
// belüli másodlagos rendezési kulcsként.
let myCp = 0;

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
        v: a.v && b.v ? [a.v[0] + (b.v[0] - a.v[0]) * f, a.v[1] + (b.v[1] - a.v[1]) * f, a.v[2] + (b.v[2] - a.v[2]) * f] : (b.v || [0, 0, 0]),
        w: a.w && b.w ? [a.w[0] + (b.w[0] - a.w[0]) * f, a.w[1] + (b.w[1] - a.w[1]) * f, a.w[2] + (b.w[2] - a.w[2]) * f] : (b.w || [0, 0, 0]),
      };
    }
  }
  return renderTime < buf[0].t ? buf[0] : buf[buf.length - 1];
}

const REMOTE_PROXY_RANGE = 60;
const REMOTE_PROXY_RANGE_SQ = REMOTE_PROXY_RANGE * REMOTE_PROXY_RANGE;
const REMOTE_PROXY_EXIT_RANGE = 75;
const REMOTE_PROXY_EXIT_RANGE_SQ = REMOTE_PROXY_EXIT_RANGE * REMOTE_PROXY_EXIT_RANGE;
const REMOTE_PROXY_MAX_AGE_MS = 750;
const REMOTE_EXTRAP_MAX_MS = 250;

function integrateRotation(q, w, dt) {
  const speed = Math.hypot(w?.[0] || 0, w?.[1] || 0, w?.[2] || 0);
  if (speed < 1e-6 || dt <= 0) return q;
  const half = speed * dt / 2;
  const s = Math.sin(half) / speed;
  // A Rapier szögsebessége világkoordinátás, ezért a delta balról szorzandó.
  return mulQuat([w[0] * s, w[1] * s, w[2] * s, Math.cos(half)], q);
}

function remoteStateAt(buf, targetServerTime) {
  if (!buf.length) return null;
  const latest = buf[buf.length - 1];
  if (targetServerTime <= latest.t) return sampleAt(buf, targetServerTime);
  const ageMs = Math.max(0, Math.min(REMOTE_EXTRAP_MAX_MS, targetServerTime - latest.t));
  const dt = ageMs / 1000;
  const v = latest.v || [0, 0, 0];
  const w = latest.w || [0, 0, 0];
  return {
    p: [latest.p[0] + v[0] * dt, latest.p[1] + v[1] * dt, latest.p[2] + v[2] * dt],
    q: integrateRotation(latest.q, w, dt),
    v,
    w,
  };
}

// A proxyk időpontja az adott jóslási lépés saját, szerverórára átszámolt
// ideje. Reconciliationkor így nem a jelenlegi ellenfélpozíciót használjuk az
// összes történeti inputhoz, hanem lépésenként a hozzá tartozó becslést.
function syncRemoteProxies(targetServerTime) {
  const mine = G.getCarState().p;
  const now = serverNow();
  for (const [id, o] of others) {
    const latest = o.buf[o.buf.length - 1];
    const state = remoteStateAt(o.buf, targetServerTime);
    if (!latest || !state || now - latest.t > REMOTE_PROXY_MAX_AGE_MS) {
      o.proxyActive = false;
      G.setRemoteCarProxy(id, null);
      continue;
    }
    const dx = state.p[0] - mine[0], dy = state.p[1] - mine[1], dz = state.p[2] - mine[2];
    const distSq = dx * dx + dy * dy + dz * dz;
    o.proxyActive = o.proxyActive
      ? distSq <= REMOTE_PROXY_EXIT_RANGE_SQ
      : distSq <= REMOTE_PROXY_RANGE_SQ;
    G.setRemoteCarProxy(id, o.proxyActive ? state : null);
  }
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
  const nowServer = serverNow();
  const renderTime = nowServer - interpDelayMs;

  if (predict) {
    // JÓSLÁS: a saját kocsit a HELYI fizika mozgatja, azonnal reagálva a
    // billentyűkre. A szerver korrekcióját nem ugrásként visszük fel, hanem
    // egy lecsengő eltolással (ld. reconcile) — így a kocsi akkor sem
    // rándul, ha a jóslat egy kicsit mellément.
    decaySmoothing(dt);
    const s = interpolatedPhys();
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
      const ahead = Math.max(0, Math.min((nowServer - mine.t) / 1000, 0.25));
      G.applyServerTransform(
        [mine.p[0] + mine.v[0] * ahead, mine.p[1] + mine.v[1] * ahead, mine.p[2] + mine.v[2] * ahead],
        mine.q
      );
    }
  }

  // A többiek helye a minitérképhez is kell, ezért ugyanabban a körben
  // gyűjtjük — a kirajzolt (interpolált) pozícióból, hogy a pötty pontosan azt
  // mutassa, amit a képen látunk.
  const markers = [];
  for (const o of others.values()) {
    const delayedState = sampleAt(o.buf, renderTime);
    const currentState = remoteStateAt(o.buf, nowServer);
    if (!delayedState || !currentState) continue;
    const mine = G.getCarState().p;
    const dx = currentState.p[0] - mine[0], dy = currentState.p[1] - mine[1], dz = currentState.p[2] - mine[2];
    const distSq = dx * dx + dy * dy + dz * dz;
    o.nearVisual = o.nearVisual
      ? distSq <= REMOTE_PROXY_EXIT_RANGE_SQ
      : distSq <= REMOTE_PROXY_RANGE_SQ;
    const near = o.nearVisual;
    const s = near ? currentState : delayedState;
    if (!s) continue;
    if (!o.renderReady) {
      o.group.position.set(s.p[0], s.p[1], s.p[2]);
      o.group.quaternion.set(s.q[0], s.q[1], s.q[2], s.q[3]);
      o.renderReady = true;
    } else {
      // Közel a jelenre extrapolált pozíció kell, különben a szerver már
      // ütközést látna, miközben a képen még több méter rés van. Az enyhe
      // lecsengés a friss snapshot korrekcióját rejti el.
      const alpha = 1 - Math.pow(0.5, dt / (near ? 0.045 : 0.025));
      o.group.position.x += (s.p[0] - o.group.position.x) * alpha;
      o.group.position.y += (s.p[1] - o.group.position.y) * alpha;
      o.group.position.z += (s.p[2] - o.group.position.z) * alpha;
      const q0 = [o.group.quaternion.x, o.group.quaternion.y, o.group.quaternion.z, o.group.quaternion.w];
      const qr = slerp(q0, s.q, alpha);
      o.group.quaternion.set(qr[0], qr[1], qr[2], qr[3]);
    }
    markers.push({ x: o.group.position.x, z: o.group.position.z, color: o.color || '#ffffff' });
  }
  // A main.js a stepMultiplayerFrame-ben MIUTÁN meghívta ezt a frame()-et,
  // rajzolja a térképet — tehát az itt beadott pöttyök még ebben a képkockában
  // megjelennek.
  G.setMiniMapMarkers(markers, myColor());

  // A nagy 3-2-1. A szerver órája a mérvadó (starting.startsAt), nem a helyi
  // versenyállapot — az multiplayerben nem is fut.
  G.setCountdown(starting?.startsAt ? Math.ceil((starting.startsAt - nowServer) / 1000) : 0);
  G.setLapInvalid(lapTainted);

  if (raceEnded) return;

  // Amíg nincs rajtidő, a többiek betöltésére várunk. Ezt ki KELL írni:
  // különben a játékos egy néma, mozdulatlan képet lát, és azt hiszi, beragadt.
  if (!starting?.startsAt) {
    const waiting = room?.players.filter((p) => !p.ready).map((p) => p.name) || [];
    G.setHud(
      '<div class="hud-note"><strong>Várakozás a többiekre…</strong>' +
      (waiting.length ? `<br>Még tölt: ${escapeHtml(waiting.join(', '))}` : '') +
      '</div>'
    );
    G.setStandings('');
    return;
  }

  // A kör-kijelző (jobb fent) ugyanaz a panel, mint egyjátékosban; a mezőny
  // állása KÜLÖN panelbe megy (bal fent). Korábban a kettő egy dobozban volt,
  // és pont ettől lett belőle olvashatatlan szövegfal.
  G.setHud(
    '<div class="lap-head">' +
      '<span class="lbl">Kör</span>' +
      `<span><span class="lap-now num">${myLap + 1}</span>` +
      `<span class="lap-total num"> / ${room?.laps ?? '?'}</span></span>` +
    '</div>' +
    (lapTainted ? '<div class="t-warn">⚠ Ez a kör érvénytelen</div>' : '')
  );

  const evt = lastEvents[0];
  G.setStandings(
    '<span class="lbl">Állás</span>' +
    standingsHtml() +
    (evt ? `<div class="st-event">${escapeHtml(eventText(evt))}</div>` : '')
  );
}

// A saját színünk. A szoba osztja ki (szerver = hiteles forrás), tehát ugyanaz,
// amit a többiek látnak rólunk.
function myColor() {
  return room?.players.find((p) => p.id === me.id)?.color || null;
}

// Élő állás a HUD-on: ki hol tart. Sorrend: több teljes kör előrébb, azon belül
// aki messzebb jár a körében (a következő checkpoint indexe). A célba érés
// pillanatában a kör nő és a checkpoint nullázódik, tehát a kör az elsődleges
// kulcs — enélkül a célba érő visszacsúszna a lista aljára.
function standingsHtml() {
  const rows = [
    { id: me.id, name: me.name || 'Te', color: myColor(), lap: myLap, cp: myCp, self: true },
    ...[...others.entries()].map(([id, o]) => ({
      id, name: o.name || '?', color: o.color, lap: o.lap || 0, cp: o.cp || 0, self: false,
    })),
  ].sort((a, b) => (b.lap - a.lap) || (b.cp - a.cp));

  return rows.map((r, i) => {
    const name = escapeHtml(r.name.slice(0, 14));
    return `<div class="st-row${r.self ? ' is-self' : ''}">` +
      `<span class="st-pos num">${i + 1}</span>${colorDot(r.color)}` +
      `<span class="st-name">${name}</span>` +
      `<span class="st-lap num">${r.lap + 1}. kör</span>` +
    '</div>';
  }).join('');
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
const MAX_INPUT_HISTORY = TICK_RATE * 3;

// ---------- Óra-sodródás elleni visszacsatolás ----------
// A kliens és a szerver órája sosem jár pontosan egyformán. Ha a kliens akár
// ezrelékkel gyorsabban küld, a szerver sora lassan feltöltődik, és a korlát
// fölött eldobás lesz belőle; ha lassabban, a sor kiürül, és a szerver az
// utolsó bemenetet ismételgeti. Mindkettő elrontja az újrajátszást — de csak
// sok másodperc alatt, ezért localhoston, rövid teszten észre sem venni.
//
// Ezért a szerver minden snapshotban megmondja, milyen mély a sor, a kliens
// pedig ehhez igazítja az ütemét. A cél alapból 1 elem, de mért jitter vagy
// szerveroldali kiéhezés esetén átmenetileg nagyobb lesz.
let sendPeriod = TICK_MS;

function adjustSendRate(depth) {
  const err = depth - queueTarget;
  // Legfeljebb ±4% eltérés a tick-ütemtől. Ennyi bőven fedi a valós
  // óra-sodródást (az nagyságrendekkel kisebb), viszont olyan lassan hat,
  // hogy vezetés közben nem érződik.
  sendPeriod = TICK_MS * (1 + Math.max(-0.04, Math.min(0.04, err * 0.02)));
}

function startInputLoop() {
  stopInputLoop();
  // Új verseny: a sorszámozás és az előzmény is nulláról indul, különben a
  // szerver (ami szintén 0-ról kezd) a régi, magas sorszámokat látná.
  inputSeq = 0;
  ackedSeq = 0;
  inputHistory.length = 0;
  lapTainted = TAINT.NONE;
  predBuf.length = 0;
  smooth.p = [0, 0, 0];
  smooth.q = [0, 0, 0, 1];
  smooth.active = false;
  sendPeriod = TICK_MS;
  queueDepth = 0;
  queueDrops = 0;
  queueUnderflows = 0;
  queueTarget = Math.max(1, Math.min(6, 1 + Math.ceil(pingJitterMs / TICK_MS)));
  queueTargetBoost = 0;
  lastQueueIssueAt = 0;

  // Önkorrigáló ütemező, nem setInterval: az egész ezredmásodpercre kerekít és
  // sodródik, ráadásul a küldési ütemet menet közben állítani kell (ld.
  // adjustSendRate).
  let next = performance.now();
  const tick = () => {
    const now = performance.now();
    // A behozatalt korlátozzuk. Ha a lap háttérbe került, az ütemező befagy,
    // és visszatéréskor több száz bemenetet akarna egyszerre kilőni — az csak
    // elárasztaná a szerver sorát, ami onnan eldobásba fordulna.
    let steps = 0;
    while (next <= now && steps < 3) {
      // Az ÜTEMEZETT időt adjuk át, nem a tényleges órát. Ez a kulcs a sima
      // képhez: a setTimeout rendszeresen késve sül el (a Windows időzítő-
      // granularitása ~15.6 ms), ilyenkor két lépés fut le EGYMÁS UTÁN,
      // ugyanabban a hívásban. A tényleges órával mindkettő szinte azonos
      // időbélyeget kapna — pedig két ticknyi mozgást jelentenek —, és a
      // képkocka-interpoláció ezen a "függőleges" szakaszon ugrana egyet.
      sendOneInput(next);
      next += sendPeriod;
      steps++;
    }
    if (next < now) next = now;
    inputTimer = setTimeout(tick, Math.max(0, next - performance.now()));
  };
  tick();
}

function sendOneInput(scheduledAt) {
  const k = G.keys;
  const backwardHeld = !!(k['KeyS'] || k['ArrowDown']);
  // Ugyanaz a "S/le nyíl fékezzen, amíg még előre gördül" logika, mint az
  // egyjátékos updateControls()-ban (web/main.js) — különben itt, a
  // multiplayer bemenetben az S megint csak a gyenge motor-fékezést adná,
  // ugyanaz a hiba térne vissza hálózaton.
  const { q, v } = G.getCarState();
  const fwdSpeed = forwardSpeed(q[0], q[1], q[2], q[3], v[0], v[1], v[2]);
  const brake = backwardHeld && fwdSpeed > REVERSE_BRAKE_THRESHOLD;
  const input = {
    seq: ++inputSeq,
    // Csak helyi metaadat: reconciliationkor ebből tudjuk, melyik történeti
    // időpontra kell tenni a távoli autók fizikai proxyját.
    at: serverNow(),
    frozen: isFrozen(),
    steer: (k['KeyA'] || k['ArrowLeft']) ? 1 : (k['KeyD'] || k['ArrowRight']) ? -1 : 0,
    throttle: (k['KeyW'] || k['ArrowUp']) ? 1 : (backwardHeld && !brake) ? -1 : 0,
    brake,
    handbrake: !!k['Space'],
  };
  inputHistory.push(input);
  // Nyugtázásig őrizzük meg. A korábbi fél másodperces plafon 500 ms körül
  // garantáltan levágott még szükséges inputokat; három másodperc már extrém
  // kapcsolaton is tartalék, de végesen tartja a rollback költségét.
  while (inputHistory.length > MAX_INPUT_HISTORY) inputHistory.shift();
  const { at: _localPredictionTime, frozen: _localFrozen, ...wireInput } = input;
  send(C2S.INPUT, wireInput);
  // Ugyanaz a bemenet AZONNAL lefut helyben is: egy bemenet = egy lépés,
  // pontosan úgy, ahogy a szerver majd elvégzi. Ettől reagál a kocsi
  // késleltetés nélkül a billentyűkre.
  if (predict) {
    syncRemoteProxies(input.at);
    G.stepLocalPhysics(input, input.frozen);
    recordPhysState(scheduledAt);
  }
}

function stopInputLoop() {
  if (inputTimer) clearTimeout(inputTimer);
  inputTimer = null;
}

function showResults(results) {
  stopInputLoop();
  raceEnded = true;
  const rows = results.map((r) => {
    const player = room?.players.find((p) => p.id === r.playerId);
    const name = escapeHtml(player?.name || '?');
    const best = r.bestLapMs ? (r.bestLapMs / 1000).toFixed(2) + 's' : '—';
    return `<div class="st-row${r.playerId === me.id ? ' is-self' : ''}">` +
      `<span class="st-pos num">${r.position}</span>${colorDot(player?.color)}` +
      `<span class="st-name">${name}</span>` +
      `<span class="st-lap num">${(r.totalMs / 1000).toFixed(2)}s · ${best}</span>` +
    '</div>';
  }).join('');
  G.setHud('<div class="lap-head"><span class="lbl">Verseny vége</span></div>');
  G.setStandings('<span class="lbl">Végeredmény</span>' + rows);
  // A leaveMultiplayer() az enterMenu()-n át amúgy is meghívja a
  // clearOtherCars()-t (setMultiplayerCleanupHook) — a takarítás tehát akkor
  // is megtörténik, ha a játékos a 8 mp letelte előtt lép ki a "Menü" gombbal.
  // Olyankor viszont ez az időzítő már le is lett lőve, épp a clearOtherCars()
  // által: enélkül utólag rántaná vissza a lobbyba az egyjátékos menetből.
  resultsTimer = setTimeout(() => {
    resultsTimer = null;
    G.leaveMultiplayer();
    openLobby();
  }, 8000);
}

// A menübe egy gomb, ami megnyitja a lobbyt.
const btn = document.createElement('button');
btn.id = 'mpOpenBtn';
btn.className = 'btn-race btn-mp mt-2';
btn.textContent = 'Többjátékos';
btn.addEventListener('click', openLobby);
document.getElementById('startBtn')?.insertAdjacentElement('afterend', btn);
