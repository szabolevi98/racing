// Online verseny kliens: a saját autó fizikája helyben fut, kész állapotát a
// szerver ellenőrzi és továbbítja. A többi autó snapshotból, interpolálva jelenik meg.
import {
  C2S, S2C, ROOM_STATE, GAME_MODE, TAINT, TICK_MS,
  PLAYER_TOKEN_LENGTH, sanitizeName, sanitizePlayerToken,
} from '/shared/protocol.js';
import {
  forwardSpeed, REVERSE_BRAKE_THRESHOLD, shouldBrakeFinishedVelocity,
} from '/shared/vehicleConfig.js';
import { raceClockTimes } from '/shared/raceClock.js';

const G = window.__game;
// Diagnosztika. A step() azért kell, mert a requestAnimationFrame megáll, ha
// a lap háttérbe kerül — enélkül a hálózati réteget nem lehetne automatizáltan
// tesztelni (a képkocka-számláló ilyenkor csalókán nullán marad).
window.__mp = {
  stage: 'init', frames: 0, snaps: 0,
  // Hány ping-mintát dobtunk el főszál-akadás miatt (lásd startStallWatch).
  // Ha ez folyamatosan nő, az nem hálózati gond, hanem akadozó kliens.
  pingDiscarded: 0,
  step: () => frame(),
  get others() { return others.size; },
  get room() { return room; },
  // Mesterséges késleltetés: __mp.setPing(150) vagy __mp.setPing(150, 30).
  // Ugyanez URL-ből: ?lag=150&jitter=30
  setPing: (rtt, jitter) => setPing(rtt, jitter),
  get net() { return { ...netsim }; },
  get inputSeq() { return inputSeq; },
  get pingMs() { return +pingRttMs.toFixed(1); },
  get jitterMs() { return +pingJitterMs.toFixed(1); },
  get clockOffsetMs() { return +clockOffsetMs.toFixed(1); },
  get interpDelayMs() { return +interpDelayMs.toFixed(1); },
  get physSteps() { return physSteps; },
  // A szerver legutóbbi ellenőrzött állapota a saját kocsinkról.
  get lastSelf() { return lastSnapshot?.cars?.find((c) => c.id === me.id) || null; },
  // A helyi fizika és a kirajzolási interpoláció pozíciója diagnosztikához.
  get rawPos() { const s = G.getCarState(); return [s.p[0], s.p[2]]; },
  get interpPos() { const s = interpolatedPhys(); return [s.p[0], s.p[2]]; },
};
const THREE = G.THREE;

let ws = null;
let me = { id: null, name: null, token: localStorage.getItem('racing.token') || null };
let room = null;
let starting = null;
let pendingHotLap = null;
// A távoli autók modelljei: playerId -> { group, buf: [állapotok] }
const others = new Map();
// A kiválasztott ranglistakör áttetsző visszajátszása. Nem kerül fizikai
// proxyba, ezért nem tud ütközni.
let ghostCar = null;
let currentRaceResults = null;
let inputSeq = 0;
let awaitingFirstSnapshot = false;
let raceLoadGeneration = 0;
let raceLoadActive = false;
// Elromlott-e már az aktuális kör a szerver szerint, és ha igen, MIÉRT: a
// snapshot `ti` mezője a TAINT kódját küldi (0 = érvényes). A konkrét ok kell,
// nem csak egy igen/nem — abból a játékos nem tudja, mit rontott el.
let lapTainted = TAINT.NONE;
let inputTimer = null;
// A RACE_END után true: a frame() innentől nem írja felül a HUD-ot a
// kör/játékos szöveggel, különben a showResults() eredménylistája egyetlen
// képkockányi ideig látszana csak, mielőtt a következő frame() lenullázná.
let raceEnded = false;
let finishedDriving = false;
let lastEvents = [];

// ---------- Lobby felület ----------

const el = document.createElement('div');
el.id = 'mpOverlay';
el.className = 'hidden';
el.innerHTML = `
<div class="mp-panel">
  <div class="mp-head">
    <h5 id="mpTitle">Többjátékos</h5>
    <button id="mpClose" class="mp-x" title="Vissza a menübe">&times;</button>
  </div>
  <div class="mp-body">
    <div id="mpLogin">
      <label for="mpName" class="lbl d-block mb-2">Játékosnév</label>
      <input id="mpName" class="form-control mb-3" maxlength="20" placeholder="A neved">
      <button id="mpConnect" class="mp-btn primary w-100">Csatlakozás a szerverhez</button>
      <div class="mp-sep">vagy meglévő profil</div>
      <label for="mpToken" class="lbl d-block mb-2">Belépési token</label>
      <div class="d-flex gap-2">
        <input id="mpToken" class="form-control mp-token-input" type="password"
               maxlength="${PLAYER_TOKEN_LENGTH}" autocomplete="off" spellcheck="false"
               placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx">
        <button id="mpRestore" class="mp-btn ghost mp-btn-fixed">Visszalépés</button>
      </div>
      <div class="mp-token-note">A token a profilod kulcsa. Akinél megvan, beléphet a profilodba.</div>
    </div>

    <div id="mpRooms" class="hidden">
      <div class="mp-account mb-3">
        <div class="mp-account-status">Bejelentkezve: <b id="mpWho"></b></div>
        <div class="mp-account-panel">
          <div class="mp-account-actions">
            <button id="mpRenameToggle" class="mp-btn ghost compact">Név átírása</button>
            <button id="mpCopyToken" class="mp-btn ghost compact" aria-live="polite">Token másolása</button>
            <button id="mpLogout" class="mp-btn danger compact">Kijelentkezés</button>
          </div>
          <div id="mpRename" class="d-flex gap-2 mt-2 hidden">
            <input id="mpRenameName" class="form-control" maxlength="20" placeholder="Új játékosnév">
            <button id="mpRenameSave" class="mp-btn primary mp-btn-fixed">Mentés</button>
            <button id="mpRenameCancel" class="mp-btn ghost mp-btn-fixed">Mégse</button>
          </div>
          <div class="mp-token-note">A tokennel másik gépen is visszaléphetsz ebbe a profilba.</div>
        </div>
      </div>
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
        <button id="mpCopy" class="mp-btn ghost" style="flex:none;" aria-live="polite">Másol</button>
      </div>
      <div class="mp-meta">
        <span class="mp-chip">Pálya: <b id="mpRoomMap"></b></span>
        <span class="mp-chip"><b id="mpRoomLaps"></b> kör</span>
        <span class="mp-chip">Mód: <b id="mpRoomMode"></b></span>
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

// A multiplayer eredmény nem tűnik el automatikusan: mindenki nyugodtan
// megnézheti, majd kiléphet; a szoba tulajdonosa ugyanebből a panelből
// indíthatja a következő futamot ugyanazzal a társasággal.
const mpResultsEl = document.createElement('div');
mpResultsEl.id = 'mpResults';
mpResultsEl.className = 'hidden';
mpResultsEl.innerHTML = `
  <div class="panel mp-results-card">
    <div id="mpResultsTitle" class="results-title">Verseny vége</div>
    <div id="mpResultsBody"></div>
    <div id="mpResultsHint" class="mp-results-hint"></div>
    <div class="d-flex gap-2 mt-4">
      <button id="mpResultsRestart" class="mp-btn primary flex-grow-1">Új játék</button>
      <button id="mpResultsLeave" class="mp-btn ghost">Kilépés</button>
    </div>
  </div>`;
document.body.appendChild(mpResultsEl);

// A menübeli ranglista csak tájékoztat. A Hot Lap indításakor ez a külön
// ablak teszi egyértelművé, hogy lehet szellemet választani, de nélküle is
// el lehet indulni.
const hotLapGhostPickerEl = document.createElement('div');
hotLapGhostPickerEl.id = 'hotLapGhostPicker';
hotLapGhostPickerEl.className = 'hidden';
hotLapGhostPickerEl.innerHTML = `
  <div class="mp-panel hotlap-picker-panel">
    <div class="mp-head">
      <div>
        <h5>Időmérés indítása</h5>
        <div id="hotLapGhostMap" class="hotlap-picker-map"></div>
      </div>
      <button id="hotLapGhostClose" class="mp-x" title="Bezárás">&times;</button>
    </div>
    <div class="mp-body">
      <div class="hotlap-picker-intro">
        Válassz egy visszajátszható ranglistakört szellemnek, vagy indulj egyedül.
      </div>
      <div id="hotLapGhostList" class="hotlap-ghost-list"></div>
      <div id="hotLapGhostError" class="hotlap-picker-error"></div>
      <div class="hotlap-picker-actions">
        <button id="hotLapGhostCancel" class="mp-btn ghost">Mégse</button>
        <button id="hotLapGhostStart" class="mp-btn primary flex-grow-1">Időmérés indítása</button>
      </div>
    </div>
  </div>`;
document.body.appendChild(hotLapGhostPickerEl);

const $ = (id) => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle('hidden', !on);
const setErr = (m) => { $('mpError').textContent = m || ''; };
const ghostModeCheckbox = $('ghostModeCheckbox');
ghostModeCheckbox.checked = localStorage.getItem('racing.ghostMode') === '1';
ghostModeCheckbox.addEventListener('change', () => {
  localStorage.setItem('racing.ghostMode', ghostModeCheckbox.checked ? '1' : '0');
});

export function openLobby() {
  closeHotLapGhostPicker();
  pendingHotLap = null;
  $('mpTitle').textContent = 'Többjátékos';
  el.classList.remove('hidden');
  setErr('');
  if (ws?.readyState === WebSocket.OPEN && me.id) {
    show('mpLogin', false);
    if (room?.mode === GAME_MODE.MULTIPLAYER) renderRoom();
    else { show('mpRooms', true); show('mpRoom', false); }
  } else {
    show('mpLogin', true); show('mpRooms', false); show('mpRoom', false);
    $('mpName').value = localStorage.getItem('racing.name') || '';
  }
}
function closeLobby() {
  if (!room) pendingHotLap = null;
  el.classList.add('hidden');
}

function selectedMenuRace() {
  return {
    mapId: document.getElementById('mapSelect')?.value,
    carId: document.getElementById('carSelect')?.value,
  };
}

function sendPendingHotLap() {
  if (!pendingHotLap || ws?.readyState !== WebSocket.OPEN || !me.id) return false;
  const request = pendingHotLap;
  pendingHotLap = null;
  closeLobby();
  G.requestGameFullscreen();
  send(C2S.START_HOT_LAP, request);
  return true;
}

const HOT_LAP_GHOST_SELECTION_KEY = 'racing.hotLapGhosts';
let hotLapPickerRace = null;
let hotLapPickerGeneration = 0;

function readHotLapGhostSelections() {
  try {
    const value = JSON.parse(localStorage.getItem(HOT_LAP_GHOST_SELECTION_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function savedHotLapGhost(mapId) {
  const playerId = Number(readHotLapGhostSelections()[mapId]);
  return Number.isSafeInteger(playerId) && playerId > 0 ? playerId : null;
}

function saveHotLapGhost(mapId, playerId) {
  const selections = readHotLapGhostSelections();
  if (playerId) selections[mapId] = playerId;
  else delete selections[mapId];
  localStorage.setItem(HOT_LAP_GHOST_SELECTION_KEY, JSON.stringify(selections));
}

function ghostChoiceHtml(entries, selectedPlayerId) {
  const availableIds = new Set(entries
    .filter((entry) => !!entry.has_ghost)
    .map((entry) => Number(entry.player_id))
    .filter((id) => Number.isSafeInteger(id) && id > 0));
  const selectedAvailable = availableIds.has(selectedPlayerId);
  const noGhost =
    '<label class="hotlap-ghost-row hotlap-ghost-none">' +
      `<input type="radio" name="hotLapGhostChoice" value=""${selectedAvailable ? '' : ' checked'}>` +
      '<span class="hotlap-ghost-rank">—</span>' +
      '<span class="hotlap-ghost-name">Szellem nélkül</span>' +
      '<span class="hotlap-ghost-time">Egyedül indulok</span>' +
    '</label>';
  if (!entries.length) {
    return noGhost + '<div class="hotlap-picker-empty">Ezen a pályán még nincs ranglistakör.</div>';
  }
  return noGhost + entries.map((entry, index) => {
    const playerId = Number(entry.player_id);
    const available = !!entry.has_ghost && Number.isSafeInteger(playerId) && playerId > 0;
    const checked = available && playerId === selectedPlayerId;
    return `<label class="hotlap-ghost-row${available ? '' : ' is-unavailable'}">` +
      `<input type="radio" name="hotLapGhostChoice" value="${available ? playerId : ''}"` +
        `${checked ? ' checked' : ''}${available ? '' : ' disabled'}>` +
      `<span class="hotlap-ghost-rank num">${index + 1}</span>` +
      `<span class="hotlap-ghost-name">${escapeHtml(entry.name)}</span>` +
      `<span class="hotlap-ghost-time num">${G.formatTime(entry.best_ms)}</span>` +
      `<span class="hotlap-ghost-state">${available ? 'Választható' : 'Nincs felvétel'}</span>` +
    '</label>';
  }).join('');
}

function closeHotLapGhostPicker() {
  hotLapPickerGeneration++;
  hotLapPickerRace = null;
  hotLapGhostPickerEl.classList.add('hidden');
}

async function showHotLapGhostPicker(race) {
  const generation = ++hotLapPickerGeneration;
  hotLapPickerRace = race;
  const map = G.manifest?.maps.find((entry) => entry.id === race.mapId);
  $('hotLapGhostMap').textContent = map?.label || race.mapId;
  $('hotLapGhostError').textContent = '';
  $('hotLapGhostList').innerHTML = '<div class="hotlap-picker-empty">Ranglista betöltése…</div>';
  $('hotLapGhostStart').disabled = true;
  hotLapGhostPickerEl.classList.remove('hidden');

  try {
    const response = await fetch(`/api/leaderboard?mapId=${encodeURIComponent(race.mapId)}&limit=20`);
    if (!response.ok) throw new Error('A ranglista nem tölthető be.');
    const entries = (await response.json()).entries || [];
    if (generation !== hotLapPickerGeneration) return;
    $('hotLapGhostList').innerHTML = ghostChoiceHtml(entries, savedHotLapGhost(race.mapId));
  } catch {
    if (generation !== hotLapPickerGeneration) return;
    $('hotLapGhostList').innerHTML = ghostChoiceHtml([], null);
    $('hotLapGhostError').textContent = 'A ranglista nem töltődött be, de szellem nélkül elindulhatsz.';
  }
  $('hotLapGhostStart').disabled = false;
}

function beginHotLap(race, ghostPlayerId) {
  saveHotLapGhost(race.mapId, ghostPlayerId);
  pendingHotLap = { ...race, ghostPlayerId };
  closeHotLapGhostPicker();
  $('mpTitle').textContent = 'Időmérés';
  setErr('');
  hideMultiplayerResults();

  if (sendPendingHotLap()) return;

  el.classList.remove('hidden');
  show('mpRoom', false);
  show('mpRooms', false);
  show('mpLogin', true);
  $('mpName').value = localStorage.getItem('racing.name') || '';

  // A már ezen a gépen mentett profilhoz nem kérünk még egy kattintást. A
  // szerver ellenőrzi a tokent; ha már nem érvényes, a hiba a login panelen
  // marad, és kézzel lehet új profilt létrehozni vagy másik tokent beilleszteni.
  if (me.token) {
    authenticate(C2S.HELLO, {
      name: sanitizeName(localStorage.getItem('racing.name') || 'Játékos'),
      token: me.token,
    });
  }
}

export function openHotLap() {
  const { mapId, carId } = selectedMenuRace();
  if (!mapId || !carId) return G.setMenuStatus('Előbb válassz pályát és kocsit.');
  showHotLapGhostPicker({ mapId, carId });
}

$('hotLapGhostClose').addEventListener('click', closeHotLapGhostPicker);
$('hotLapGhostCancel').addEventListener('click', closeHotLapGhostPicker);
$('hotLapGhostStart').addEventListener('click', () => {
  if (!hotLapPickerRace) return;
  const selected = hotLapGhostPickerEl.querySelector('input[name="hotLapGhostChoice"]:checked');
  const playerId = Number(selected?.value);
  beginHotLap(
    hotLapPickerRace,
    Number.isSafeInteger(playerId) && playerId > 0 ? playerId : null
  );
});
hotLapGhostPickerEl.addEventListener('click', (event) => {
  if (event.target === hotLapGhostPickerEl) closeHotLapGhostPicker();
});

$('mpClose').addEventListener('click', closeLobby);

$('mpConnect').addEventListener('click', () => {
  const name = sanitizeName($('mpName').value);
  localStorage.setItem('racing.name', name);
  authenticate(C2S.HELLO, { name, token: me.token });
});
$('mpName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('mpConnect').click(); });

$('mpRestore').addEventListener('click', () => {
  const token = sanitizePlayerToken($('mpToken').value);
  if (!token) return setErr('Illessz be egy érvényes belépési tokent.');
  authenticate(C2S.RESTORE_PROFILE, { token });
});
$('mpToken').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('mpRestore').click(); });

$('mpRenameToggle').addEventListener('click', () => {
  $('mpRenameName').value = me.name || '';
  show('mpRename', true);
  $('mpRenameName').focus();
});
$('mpRenameCancel').addEventListener('click', () => show('mpRename', false));
$('mpRenameSave').addEventListener('click', () => {
  send(C2S.RENAME_PLAYER, { name: sanitizeName($('mpRenameName').value) });
});
$('mpRenameName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('mpRenameSave').click(); });

let loggingOut = false;
$('mpLogout').addEventListener('click', () => {
  loggingOut = true;
  pendingAuthentication = null;
  pendingHotLap = null;
  localStorage.removeItem('racing.token');
  localStorage.removeItem('racing.name');
  me = { id: null, name: null, token: null };
  $('mpName').value = '';
  $('mpToken').value = '';
  show('mpRename', false);
  show('mpLogin', true);
  show('mpRooms', false);
  show('mpRoom', false);
  setErr('');
  stopPingLoop();
  if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
  else {
    ws = null;
    loggingOut = false;
  }
});

$('mpCreate').addEventListener('click', () => {
  const mapId = document.getElementById('mapSelect')?.value;
  const carId = document.getElementById('carSelect')?.value;
  if (!mapId || !carId) return setErr('Előbb válassz pályát és kocsit a menüben.');
  send(C2S.CREATE_ROOM, {
    mapId,
    carId,
    laps: Number(document.getElementById('lapCountSelect')?.value) || 3,
    ghostMode: ghostModeCheckbox.checked,
  });
});

$('mpJoin').addEventListener('click', () => {
  const code = $('mpCode').value.trim().toUpperCase();
  if (code.length < 4) return setErr('Add meg a szobakódot.');
  send(C2S.JOIN_ROOM, { code, carId: document.getElementById('carSelect')?.value });
});
$('mpCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('mpJoin').click(); });

$('mpStart').addEventListener('click', () => {
  G.requestGameFullscreen();
  send(C2S.START_RACE);
});
$('mpLeave').addEventListener('click', () => {
  send(C2S.LEAVE_ROOM);
  clearOtherCars();
  room = null;
  show('mpRoom', false); show('mpRooms', true);
});
let copyFeedbackTimer = null;
$('mpCopy').addEventListener('click', async () => {
  const code = room?.code || '';
  if (!code) return;
  const button = $('mpCopy');
  try {
    await navigator.clipboard.writeText(code);
    if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
    button.textContent = 'Másolva ✓';
    button.classList.add('is-copied');
    copyFeedbackTimer = setTimeout(() => {
      button.textContent = 'Másol';
      button.classList.remove('is-copied');
      copyFeedbackTimer = null;
    }, 1400);
  } catch {
    setErr('A szobakódot nem sikerült a vágólapra másolni.');
  }
});

let tokenCopyFeedbackTimer = null;
$('mpCopyToken').addEventListener('click', async () => {
  if (!me.token) return setErr('Ehhez a profilhoz nincs másolható token.');
  const button = $('mpCopyToken');
  try {
    await navigator.clipboard.writeText(me.token);
    if (tokenCopyFeedbackTimer) clearTimeout(tokenCopyFeedbackTimer);
    button.textContent = 'Token másolva ✓';
    button.classList.add('is-copied');
    tokenCopyFeedbackTimer = setTimeout(() => {
      button.textContent = 'Token másolása';
      button.classList.remove('is-copied');
      tokenCopyFeedbackTimer = null;
    }, 1800);
  } catch {
    setErr('A belépési tokent nem sikerült a vágólapra másolni.');
  }
});

// Az "R" multiplayerben KÉRÉS a szerver felé, nem helyi teleport — a kocsi
// helyét a szerver birtokolja. Élre figyelünk (e.repeat nélkül), nem a
// lenyomva tartásra: különben képkockánként küldenénk egy kérést.
function requestMultiplayerReset() {
  if (G.appState === 'mp') send(C2S.RESET);
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR' && !e.repeat) requestMultiplayerReset();
});
// A mobilos visszaállítás-gomb ugyanazt a szerveroldali kérést használja,
// mint az R; a kliens sosem teleportálja önhatalmúlag a multiplayer autót.
window.addEventListener('racing:reset-request', requestMultiplayerReset);

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

// ---------- Főszál-akadás figyelése ----------
// A mért ping `performance.now() - m.t`, vagyis MINDENT belemér, ami a küldés
// és a válasz feldolgozása közt a főszálat blokkolja. Egy új meccs indításakor
// a fizikai világ felépítése egyetlen blokkban fut: mérve 216-300 ms a
// Hungaroringen (220 e háromszög), Shanghain (565 e) ennek a többszöröse —
// innen a "700 ms-os ping", ami valójában semmit nem mond a hálózatról.
//
// Az ilyen mintát el KELL dobni, mert a jitterbe beszállva feleslegesen
// megnövelné a távoli autók interpolációs késleltetését.
//
// A figyelő egy sűrű időzítő: ha két ütés között sokkal több idő telt el, mint
// kellett volna, akkor a főszál addig blokkolt. A PONG-nál elég annyit nézni,
// volt-e ilyen akadás a küldés ÓTA.
const STALL_TICK_MS = 200;
const STALL_THRESHOLD_MS = 400;
// A szerver által jelentett saját akadás, ami fölött a mintát eldobjuk. Bőven
// a hurok normális ingadozása fölött van, de jóval a rajtnál mért blokkok
// (több száz ms) alatt.
const SERVER_BLOCK_IGNORE_MS = 50;
let stallTimer = null;
let lastHeartbeatAt = 0;
let lastStallAt = 0;

function startStallWatch() {
  stopStallWatch();
  lastHeartbeatAt = performance.now();
  stallTimer = setInterval(() => {
    const now = performance.now();
    if (now - lastHeartbeatAt > STALL_THRESHOLD_MS) lastStallAt = now;
    lastHeartbeatAt = now;
  }, STALL_TICK_MS);
}

function stopStallWatch() {
  if (stallTimer) clearInterval(stallTimer);
  stallTimer = null;
}

function startPingLoop() {
  stopPingLoop();
  lastPingRttMs = null;
  pingJitterMs = 0;
  startStallWatch();
  sendPing();
  pingTimer = setInterval(sendPing, PING_INTERVAL_MS);
}

function stopPingLoop() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
  stopStallWatch();
}

let pendingAuthentication = null;

function authenticate(type, data) {
  pendingAuthentication = { type, data };
  if (ws?.readyState === WebSocket.OPEN) {
    send(type, data);
    return;
  }
  if (ws?.readyState === WebSocket.CONNECTING) return;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/ws`);
  ws = socket;
  socket.addEventListener('open', () => {
    if (ws !== socket) return;
    setErr('');
    const auth = pendingAuthentication;
    if (auth) send(auth.type, auth.data);
    startPingLoop();
  });
  socket.addEventListener('message', (ev) => {
    if (ws !== socket) return;
    // A feldolgozást késleltetjük, nem a JSON-elemzést — így a szimulátor
    // költsége nem torzítja a mért időt.
    const m = JSON.parse(ev.data);
    delayed('down', () => onMessage(m));
  });
  socket.addEventListener('close', () => {
    if (ws !== socket) return;
    const wasLoggingOut = loggingOut;
    loggingOut = false;
    ws = null;
    setErr(wasLoggingOut ? '' : 'A kapcsolat megszakadt.');
    // Verseny közbeni szakadásnál a többiek kocsija ott ragadna a pályán —
    // örökre mozdulatlanul, hiszen több snapshot nem jön hozzájuk.
    clearOtherCars();
    hideMultiplayerResults();
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
  socket.addEventListener('error', () => {
    if (ws === socket) setErr('Nem sikerült csatlakozni a szerverhez.');
  });
}

function onMessage(m) {
  switch (m.type) {
    case S2C.WELCOME:
      me = { id: m.playerId, name: m.name, token: m.token };
      localStorage.setItem('racing.token', m.token);
      localStorage.setItem('racing.name', m.name);
      $('mpToken').value = '';
      $('mpWho').textContent = m.name;
      if (!sendPendingHotLap()) {
        show('mpLogin', false); show('mpRooms', true);
      }
      break;

    case S2C.PROFILE_UPDATED:
      me.name = m.name;
      localStorage.setItem('racing.name', m.name);
      $('mpWho').textContent = m.name;
      show('mpRename', false);
      setErr('');
      break;

    case S2C.ROOM_STATE:
      room = m.room;
      if (room?.mode !== GAME_MODE.HOT_LAP) renderRoom();
      updateResultsActions();
      break;

    case S2C.ROOM_CLOSED:
      // Ez verseny KÖZBEN is jöhet (pl. a szoba gazdája kilép) — ilyenkor a
      // lobby jön elő, nem a menü, tehát az enterMenu()-s takarítás nem sülne el.
      clearOtherCars();
      hideMultiplayerResults();
      cancelRaceLoad();
      room = null;
      starting = null;
      stopInputLoop();
      awaitingFirstSnapshot = false;
      G.detachMultiplayerFrame();
      if (G.appState === 'mp') G.leaveMultiplayer();
      const stillAuthenticated = !!me.id && ws?.readyState === WebSocket.OPEN;
      show('mpLogin', !stillAuthenticated);
      show('mpRoom', false);
      show('mpRooms', stillAuthenticated);
      setErr(m.reason || '');
      break;

    case S2C.RACE_STARTING:
      // Ez a "töltsd be" jel: rajtidő még NINCS benne, azt a RACE_COUNTDOWN adja.
      starting = m;
      if (room) {
        room.ghostMode = m.ghostMode === true;
        room.mode = m.mode || room.mode;
      }
      hideMultiplayerResults();
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
      // Hot Lapnál ez még csak a felvezető kezdete. A mért kör hiteles
      // kezdőidejét az első rajtvonal-átlépés után a snapshot `ls` mezője adja.
      myLapStartedAt = isHotLap() ? 0 : m.startsAt;
      break;

    case S2C.SNAPSHOT:
      onSnapshot(m);
      break;

    case S2C.CAR_RESET:
      if (m.playerId === me.id && G.resetMultiplayerCar(m.respawn || {})) {
        predBuf.length = 0;
      }
      break;

    case S2C.RACE_EVENT:
      // A kilépés nem csak egy HUD-üzenet: a kocsiját is le kell venni a
      // pályáról. Ő nem kap több snapshotot, tehát az utolsó pozícióján
      // megfagyva ott maradna a verseny végéig.
      if (m.kind === 'left') removeOtherCar(m.playerId);
      if (m.kind === 'validation' && m.playerId === me.id) {
        G.showServerValidationAlert?.();
      }
      if (m.kind === 'lap' && m.playerId === me.id) {
        myLapTimes.push({ time: m.timeMs, invalid: !!m.invalid });
        // A következő kör kezdete nem a csomag megérkezési ideje: nagy
        // pingnél az késő lenne. Az előző hiteles rajtponthoz adjuk hozzá a
        // szerver által mért köridőt, így az Aktuális óra nem ugrik.
        myLapStartedAt = (myLapStartedAt || starting?.startsAt || serverNow()) + m.timeMs;
      }
      if (m.kind === 'finished' && m.playerId === me.id) {
        finishedDriving = true;
        G.setMultiplayerControlsEnabled(false);
      }
      if (m.kind !== 'validation') {
        lastEvents.unshift(m);
        lastEvents = lastEvents.slice(0, 4);
      }
      break;

    case S2C.RACE_END:
      showResults(m.results);
      break;

    case S2C.PONG:
      {
        // Ha a küldés óta blokkolt a főszál, a minta a blokkolás hosszát méri,
        // nem a hálózatot — eldobjuk (lásd startStallWatch). Az órabecslést is
        // kihagyjuk vele, mert az is az RTT felét használja.
        //
        // Három ok van, és mind ugyanoda vezet:
        //  - lastStallAt: a figyelő ütése már észlelte az akadást;
        //  - a heartbeat régen járt: ez az üzenet fut ELSŐKÉNT a blokk után,
        //    tehát a figyelő ütése még nem került sorra (böngészőben nem
        //    garantált, melyik előbb) — enélkül pont a legnagyobb tüske
        //    csúszna át;
        //  - m.blockedMs: nem mi akadtunk, hanem a SZERVER eseményhurka, és a
        //    PING nála állt sorban (lásd server/loopLag.js). Erre a saját
        //    figyelőnk vak, mert a mi szálunk közben szabad volt — ez az, ami
        //    verseny indításakor a több száz milliszekundumos pinget okozta.
        const stalledHere = lastStallAt > m.t
          || performance.now() - lastHeartbeatAt > STALL_THRESHOLD_MS;
        if (stalledHere || m.blockedMs > SERVER_BLOCK_IGNORE_MS) {
          window.__mp.pingDiscarded++;
          break;
        }
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
        G.setPingMs(pingRttMs);
      }
      break;

    case S2C.ERROR:
      setErr(m.message);
      updateResultsActions();
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
  $('mpRoomMode').textContent = room.ghostMode ? 'Ghost' : 'Normál';
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

function isHotLap() {
  return starting?.mode === GAME_MODE.HOT_LAP || room?.mode === GAME_MODE.HOT_LAP;
}

async function beginRace(info) {
  const loadGeneration = ++raceLoadGeneration;
  const ghostReplay = info.ghost?.replay?.frames?.length ? info.ghost : null;
  const reuseGhost = !!ghostReplay && !!ghostCar
    && ghostCar.playerId === ghostReplay.playerId
    && ghostCar.carId === ghostReplay.carId
    && ghostCar.timeMs === ghostReplay.timeMs;
  raceLoadActive = true;
  closeLobby();
  // Az eredménypanel alatt az előző inputciklus szándékosan tovább lépteti a
  // helyi fizikát, hogy a célba ért autó fékezve meg tudjon állni. Új futamnál
  // viszont ezt MÉG a raceEnded visszaállítása előtt le kell állítani.
  // Különben a régi, magas sorszámú inputok a betöltés alatt már az új futamba
  // mennek, és a régi ciklus a nullázott sebességet is újra felülírja. Ettől
  // kapkodott végig a motorhang a fokozatokon a második verseny elején.
  stopInputLoop();
  awaitingFirstSnapshot = false;
  predBuf.length = 0;
  // A második futam nem örökölheti az előző célba érési sebességét/fokozatát.
  // Enélkül a nulláról induló új autónál a hang gyorsan végigváltott lefelé,
  // mintha felgyorsított kazettát hallanánk.
  G.resetRaceAudio();
  window.__mp.stage = 'start';
  raceEnded = false;
  finishedDriving = false;
  myLap = 0;
  myCp = 0;
  myRank = 1;
  myGap = 0;
  myBestLap = null;
  myLastLap = null;
  myLastLapInvalid = false;
  myFinished = false;
  myLapTimes.length = 0;
  myLapStartedAt = 0;
  lastEvents = [];
  G.setMultiplayerControlsEnabled(true);
  // Tiszta lappal indulunk, FÜGGETLENÜL attól, hogyan ért véget az előző
  // meccs. Ez az utolsó védvonal: ha bármelyik kilépési ág mégis kihagyná a
  // takarítást, itt akkor sem halmozódhatnak egymásra az előző meccs kocsijai.
  clearOtherCars({ preserveGhost: reuseGhost });
  if (reuseGhost) {
    ghostCar.frames = ghostReplay.replay.frames;
    ghostCar.index = 0;
    ghostCar.group.visible = false;
  }
  resetNetworkRaceState();
  // Multiplayerben mindig a fájlba mentett, kanonikus járműbeállításokkal indulunk.
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
    tasks.push({ bytes: map.bytes, run: (onP) => G.setTrack('assets/' + map.file, map.id, map.spawns, map.gates, onP, map.hotLapSpawn) });
  }
  if (car) {
    tasks.push({ bytes: car.bytes, run: (onP) => G.setCar('assets/' + car.file, car.id, car.config, onP) });
  }
  otherPlayers.forEach((p) => {
    const otherCar = G.manifest.cars.find((c) => c.id === p.carId) || G.manifest.cars[0];
    tasks.push({ bytes: otherCar?.bytes, run: (onP) => addOtherCar(p, onP, loadGeneration) });
  });
  if (ghostReplay && !reuseGhost) {
    const replayCar = G.manifest.cars.find((c) => c.id === ghostReplay.carId) || G.manifest.cars[0];
    tasks.push({ bytes: replayCar?.bytes, run: (onP) => addGhostCar(ghostReplay, onP, loadGeneration) });
  }

  G.showLoadingOverlay(true);
  try {
    await G.runLoadTasks(tasks);
  } finally {
    if (loadGeneration === raceLoadGeneration) G.hideLoadingOverlay();
  }
  if (loadGeneration !== raceLoadGeneration) return;
  window.__mp.stage = 'kocsi-kesz';
  // strict: multiplayerben a pálya ütközési hálója KÖTELEZŐEN a bekészített
  // fájlból jön. Ha nem tölthető le, itt hibával elhasal — jobb, mint némán
  // rossz geometrián versenyezni (ettől
  // lebegett a kocsi a pálya fölött).
  await G.prepareTrackPhysics({ strict: true });
  if (loadGeneration !== raceLoadGeneration) return;
  window.__mp.stage = 'fizika-kesz';

  window.__mp.stage = 'tobbiek-kesz';
  G.setMenuStatus('');
  // A saját kocsit a rajthelyére tesszük, MIELŐTT az első képkocka kimenne.
  // A rajthelyet az indítási csomag adja; a helyi fizika különben a menübeli
  // kirakat-pózból indulna, ahol a kocsi 2
  // méterrel a talaj fölött lebeg. A játékos így egy pillanatra a levegőben
  // látta a saját autóját a rajtnál.
  G.placeAtGridSlot(
    info.spawns || map?.spawns || [],
    myPlayer?.slot ?? 0,
    info.mode === GAME_MODE.HOT_LAP ? (info.hotLapSpawn || null) : undefined
  );
  G.enterMultiplayer(frame);
  raceLoadActive = false;
  window.__mp.stage = 'fut';
  // Megvagyunk: innentől a szerveren rajtunk nem áll a rajt. A visszaszámlálás
  // csak akkor indul, ha MINDENKI jelentkezett (vagy lejár a türelmi idő) —
  // enélkül egy lassan töltő játékos a 3-2-1-ből csak az 1-et látta.
  // Már a visszajelzés ELŐTT várjuk az első snapshotot: localhoston a
  // az állapotrelé olyan gyors lehet, hogy különben megelőzné ezt a flaget.
  awaitingFirstSnapshot = true;
  const initialState = G.getCarState();
  const initialWheels = G.getWheelNetworkState?.() || { st: 0, wr: 0 };
  send(C2S.SET_READY, {
    ready: true,
    state: {
      seq: 0,
      t: serverNow(),
      ...initialState,
      ...initialWheels,
      th: 0,
      offtrack: !!G.isCarFullyOffTrack?.(),
    },
  });
  // Az állapotküldést az első snapshot után indítjuk, amikor a versenyvezérlő él.
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
function clearOtherCars({ preserveGhost = false } = {}) {
  for (const id of [...others.keys()]) removeOtherCar(id);
  if (preserveGhost && ghostCar) {
    ghostCar.index = 0;
    ghostCar.group.visible = false;
  } else {
    clearGhostCar();
  }
  G.clearRemoteCarProxies();
  // A modellek és fizikai proxyk mellett a minitérképes lenyomatuk is ugyanennek
  // az állapotnak a része. A játék közbeni „Vissza a menübe” közvetlenül az
  // enterMenu() cleanup hookján halad át, nem feltétlenül a leaveMultiplayer()-en,
  // ezért az ottani külön nullázás ezt az útvonalat nem fedte le.
  G.setMiniMapMarkers([], null);
}

// Egyetlen játékos kocsijának leszedése — verseny KÖZBEN is, amikor kilép
// vagy megszakad a kapcsolata. Enélkül a szerver ugyan szól róla
// (RACE_EVENT 'left'), de a kocsija megfagyva ott maradna a pályán a meccs
// végéig: több snapshot nem jön hozzá, tehát az utolsó pozícióján ragadna.
function removeOtherCar(playerId) {
  const entry = others.get(playerId);
  if (!entry) return;
  G.stopRemoteEngine(entry.engineAudio);
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
  predBuf.length = 0;
  G.detachMultiplayerFrame();
  hideMultiplayerResults();
  clearOtherCars();
  resetNetworkRaceState();

  // A versenyből a Menüre kattintás valódi kilépés, nem csak vizuális
  // elrejtés. A befejezett, már lobbyba visszaállt szobát viszont megtartjuk,
  // hogy ugyanazzal a társasággal lehessen újraindítani.
  if (wasActive && room && (room.mode === GAME_MODE.HOT_LAP || room.state !== ROOM_STATE.LOBBY)) {
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
  const group = await loadRemoteCarVisual(car, p.color, onProgress);
  // Névtábla a kocsi fölött, a játékos színével keretezve — ugyanaz a szín,
  // ami a HUD-listán és a minitérképen is jelöli őt.
  const label = makeNameSprite(p.name, p.color);
  label.position.y = 1.8;
  label.visible = false;
  group.add(label);

  // A modell letöltése közben megszakadhatott a kapcsolat vagy a játékos
  // visszaléphetett a menübe. A késve elkészült objektum ilyenkor nem kerülhet
  // vissza ghostként a jelenetbe.
  if (loadGeneration !== raceLoadGeneration) {
    G.disposeObject3D(group);
    return;
  }
  G.scene.add(group);
  others.set(p.id, {
    group, label, wheelRig: group.userData.wheelRig || { pivots: [], sources: [] },
    engineAudio: G.createRemoteEngine(), buf: [], color: p.color, name: p.name, lap: 0, cp: 0,
    rank: 0, gap: null, bestLap: null, lastLap: null, lastLapInvalid: false, finished: false,
  });
}

async function loadRemoteCarVisual(car, fallbackColor, onProgress, translucent = false) {
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
    // Ugyanaz a kerékközép-korrekció, mint a saját autónál. Egyes
    // GLB-k (pl. F2004) origója nincs a tengelytáv közepén; enélkül csak
    // távoli autóként látszanának előrébb a fizikai pozíciójuknál.
    G.centerCarModelOnWheels(model, car.config?.wheelPattern);
    const box3 = new THREE.Box3().setFromObject(model);
    // Ugyanaz a mért nyugalmi kasztnimagasság, mint a saját autónál. A régi
    // fix 0.85 a teljesen kinyúlt rugóhoz tartozott, ezért a távoli modelleket
    // néhány centivel a talaj alá tolta.
    model.position.y = -box3.min.y - G.getCarGroundOffset();
    if (translucent) {
      model.traverse((object) => {
        if (!object.isMesh || !object.material) return;
        const fade = (material) => {
          const clone = material.clone();
          clone.transparent = true;
          clone.opacity = 0.34;
          clone.depthWrite = false;
          clone.needsUpdate = true;
          return clone;
        };
        object.material = Array.isArray(object.material)
          ? object.material.map(fade)
          : fade(object.material);
        object.castShadow = false;
      });
    }
    group.add(model);
    // A saját autóval azonos geometriai felismerés: autónkénti kézi lista vagy
    // offset nélkül megtalálja és külön pivotokra fűzi a látható kerekeket.
    group.userData.wheelRig = G.createRemoteWheelRig(model, car.config?.wheelPattern, group);
  } catch {
    // Ha a modell nem tölthető, egy doboz is jobb, mint egy láthatatlan
    // ellenfél, akinek nekimehetünk. A doboz a játékos színét kapja, hogy
    // ilyenkor is beazonosítható legyen.
    group.add(new THREE.Mesh(
      new THREE.BoxGeometry(2, 0.8, 4.4),
      new THREE.MeshStandardMaterial({
        color: fallbackColor || '#ff4444', transparent: translucent,
        opacity: translucent ? 0.34 : 1, depthWrite: !translucent,
      })
    ));
  }
  return group;
}

async function warmGhostCarVisual(group) {
  // A rejtett szellemet a renderer az első valódi megjelenéséig nem készítené
  // elő. Ezért a GLB betöltése után, még a loading overlay alatt feltöltjük az
  // összes textúráját, majd lefordítjuk az áttetsző anyagok shaderprogramjait.
  // A rajtvonalnál így már csak a visible kapcsoló változik meg.
  const textures = new Set();
  group.traverse((object) => {
    if (!object.material) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => {
      if (!material) return;
      Object.values(material).forEach((value) => {
        if (value?.isTexture) textures.add(value);
      });
    });
  });
  textures.forEach((texture) => G.renderer.initTexture(texture));

  if (typeof G.renderer.compileAsync === 'function') {
    await G.renderer.compileAsync(group, G.camera, G.scene);
  } else {
    G.renderer.compile(group, G.camera, G.scene);
  }
}

async function addGhostCar(ghost, onProgress, loadGeneration) {
  const car = G.manifest.cars.find((c) => c.id === ghost.carId) || G.manifest.cars[0];
  const group = await loadRemoteCarVisual(car, '#75d7ff', onProgress, true);
  if (loadGeneration !== raceLoadGeneration) {
    G.disposeObject3D(group);
    return;
  }
  group.visible = false;
  G.scene.add(group);
  await warmGhostCarVisual(group);
  if (loadGeneration !== raceLoadGeneration) {
    G.scene.remove(group);
    G.disposeObject3D(group);
    return;
  }
  ghostCar = {
    group,
    playerId: ghost.playerId,
    carId: ghost.carId,
    frames: ghost.replay.frames,
    index: 0,
    name: ghost.name || 'Szellem',
    timeMs: ghost.timeMs,
  };
}

function clearGhostCar() {
  if (!ghostCar) return;
  G.scene.remove(ghostCar.group);
  G.disposeObject3D(ghostCar.group);
  ghostCar = null;
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
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, depthTest: true, depthWrite: false, transparent: true,
  }));
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
// Csak diagnosztikához (lásd __mp.lastSelf) — a feldolgozás nem használja.
let lastSnapshot = null;

function resetNetworkRaceState() {
  interpDelayMs = MIN_INTERP_DELAY_MS;
  snapshotTransitMs = 0;
  snapshotJitterMs = 0;
  lastSnapshotTransitMs = null;
}

function mulQuat(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
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
// fizikai lépés.
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

function recordPhysState(scheduledAt, state = G.getCarState()) {
  pushPredState(state, scheduledAt ?? performance.now());
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

// A visszaszámlálás alatt befagyasztjuk a helyi kocsit.
// Áll-e még a kocsi (befékezve). Ha a rajtidőt még nem tudjuk, akkor IGEN: a
// a versenyvezérlő a betöltésre vár.
function isFrozen() {
  return !starting?.startsAt || serverNow() < starting.startsAt;
}

function onSnapshot(m) {
  window.__mp.snaps++;
  lastSnapshot = m;
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
    const buf = entry?.buf;
    if (buf) {
      buf.push({
        t: m.t, p: c.p, q: c.q, v: c.v, w: c.w,
        st: c.st ?? 0, wr: c.wr ?? 0, th: c.th, seq: c.seq, lap: c.lap,
      });
      // Az adaptív puffer nagy pingnél 400 ms-ig nőhet; két másodpercnyi múlt
      // elég hozzá és a proxyk jelenre történő extrapolációjához is.
      while (buf.length > 40) buf.shift();
    }
    if (entry) {
      // A HUD-lista sorrendjéhez: hányadik körben tart, és azon belül melyik
      // checkpointot várja. A puffer az interpolációról szól, ez viszont a
      // LEGFRISSEBB állás — a sorrendet nem akarjuk 100 ms-mal késleltetni.
      entry.lap = c.lap ?? 0;
      entry.cp = c.cp ?? 0;
      entry.rank = c.rk ?? 0;
      entry.gap = c.gap ?? null;
      entry.bestLap = c.best ?? null;
      entry.lastLap = c.last ?? null;
      entry.lastLapInvalid = !!c.li;
      entry.finished = !!c.fin;
    }
    if (c.id === me.id) {
      const speedState = G.getCarState();
      G.setSpeed(Math.hypot(speedState.v[0], speedState.v[2]) * 3.6);
      myLap = c.lap;
      myCp = c.cp ?? 0;
      myRank = c.rk ?? 1;
      myGap = c.gap ?? 0;
      myBestLap = c.best ?? null;
      myLastLap = c.last ?? null;
      myLastLapInvalid = !!c.li;
      myFinished = !!c.fin;
      if (isHotLap()) {
        // A szerver az egyetlen hiteles időmérő: null a felvezetőn, majd az
        // átlépés szimulációs időpontja. Így nagy pingnél sem a csomag
        // megérkezése indítja késve az órát vagy a szellemet.
        myLapStartedAt = Number.isFinite(c.ls) ? c.ls : 0;
      }
      lapTainted = c.ti || TAINT.NONE;
    }
  }
  if (startAfterSnapshot) startInputLoop();
}

let myLap = 0;
// Melyik checkpointot várja a saját kocsi — a HUD-lista sorrendjéhez, körön
// belüli másodlagos rendezési kulcsként.
let myCp = 0;
let myRank = 1;
let myGap = 0;
let myBestLap = null;
let myLastLap = null;
let myLastLapInvalid = false;
let myFinished = false;
// A köridőket a szerver RACE_EVENT üzeneteiből őrizzük. A kliens csak az
// élően futó Aktuális/Összes órát rajzolja a szinkronizált szerveridőből.
const myLapTimes = [];
let myLapStartedAt = 0;

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
        st: (a.st ?? 0) + ((b.st ?? a.st ?? 0) - (a.st ?? 0)) * f,
        wr: (a.wr ?? 0) + ((b.wr ?? a.wr ?? 0) - (a.wr ?? 0)) * f,
        th: (a.th ?? 0) + ((b.th ?? a.th ?? 0) - (a.th ?? 0)) * f,
      };
    }
  }
  return renderTime < buf[0].t ? buf[0] : buf[buf.length - 1];
}

const REMOTE_PROXY_RANGE = 60;
const REMOTE_PROXY_RANGE_SQ = REMOTE_PROXY_RANGE * REMOTE_PROXY_RANGE;
const REMOTE_PROXY_EXIT_RANGE = 75;
const REMOTE_PROXY_EXIT_RANGE_SQ = REMOTE_PROXY_EXIT_RANGE * REMOTE_PROXY_EXIT_RANGE;
// A játékosnév közelről segít azonosítani az ellenfelet, távolról viszont
// csak teleszórja a pályát és könnyen elárulna egy épület mögötti autót.
// 38 métertől halványul, 50 méternél teljesen eltűnik; a Sprite depthTestje
// ezen belül is gondoskodik róla, hogy falon/épületen ne rajzolódjon át.
const PLAYER_LABEL_FADE_START = 38;
const PLAYER_LABEL_MAX_RANGE = 50;
const PLAYER_LABEL_MAX_RANGE_SQ = PLAYER_LABEL_MAX_RANGE * PLAYER_LABEL_MAX_RANGE;
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
    st: latest.st ?? 0,
    wr: latest.wr ?? 0,
    th: latest.th ?? 0,
  };
}

// A proxyk időpontja az adott helyi fizikai lépés szerverórára átszámolt ideje.
function syncRemoteProxies(targetServerTime) {
  // Ghost módban nem hozunk létre távoli dinamikus proxykat, ezért a kocsik
  // helyben sem tudnak egymással ütközni.
  if (starting?.ghostMode === true || room?.ghostMode === true) return;
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

function updateGhostPlayback(nowServer) {
  if (!ghostCar) return;
  if (!myLapStartedAt || myFinished || raceEnded) {
    ghostCar.group.visible = false;
    ghostCar.index = 0;
    return;
  }
  const elapsed = Math.max(0, nowServer - myLapStartedAt);
  const frames = ghostCar.frames;
  if (!frames?.length) {
    ghostCar.group.visible = false;
    return;
  }

  let i = Math.max(0, Math.min(ghostCar.index, frames.length - 1));
  while (i + 1 < frames.length && frames[i + 1][0] <= elapsed) i++;
  while (i > 0 && frames[i][0] > elapsed) i--;
  ghostCar.index = i;
  const a = frames[i];
  const b = frames[Math.min(i + 1, frames.length - 1)];
  const span = b[0] - a[0];
  const f = span > 0 ? Math.max(0, Math.min(1, (elapsed - a[0]) / span)) : 0;
  const q = slerp(a.slice(4, 8), b.slice(4, 8), f);
  ghostCar.group.position.set(
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
    a[3] + (b[3] - a[3]) * f
  );
  ghostCar.group.quaternion.set(q[0], q[1], q[2], q[3]);
  ghostCar.group.visible = true;
}

// Minden képkockán fut (a main.js animate-jéből).
function frame(dt = 1 / 60) {
  window.__mp.frames++;
  const nowServer = serverNow();
  const renderTime = nowServer - interpDelayMs;

  const state = interpolatedPhys();
  G.applyServerTransform(state.p, state.q);

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
    if (distSq >= PLAYER_LABEL_MAX_RANGE_SQ) {
      o.label.visible = false;
    } else {
      const distance = Math.sqrt(distSq);
      const opacity = distance <= PLAYER_LABEL_FADE_START
        ? 1
        : (PLAYER_LABEL_MAX_RANGE - distance) / (PLAYER_LABEL_MAX_RANGE - PLAYER_LABEL_FADE_START);
      o.label.material.opacity = opacity;
      o.label.visible = opacity > 0.01;
    }
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
    for (let i = 0; i < o.wheelRig.pivots.length; i++) {
      const source = o.wheelRig.sources[i];
      o.wheelRig.pivots[i].rotation.set(s.wr ?? 0, source?.steer ? (s.st ?? 0) : 0, 0);
    }
    G.updateRemoteEngine(o.engineAudio, {
      position: o.group.position,
      velocity: s.v,
      speedKmh: Math.hypot(s.v?.[0] || 0, s.v?.[2] || 0) * 3.6,
      throttle: s.th ?? 0,
    }, dt);
    markers.push({ x: o.group.position.x, z: o.group.position.z, color: o.color || '#ffffff' });
  }
  // A main.js a stepMultiplayerFrame-ben MIUTÁN meghívta ezt a frame()-et,
  // rajzolja a térképet — tehát az itt beadott pöttyök még ebben a képkockában
  // megjelennek.
  updateGhostPlayback(nowServer);
  if (ghostCar?.group.visible) {
    markers.push({
      x: ghostCar.group.position.x,
      z: ghostCar.group.position.z,
      color: 'rgba(117, 215, 255, 0.62)',
    });
  }
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

  if (isHotLap() && !myLapStartedAt) {
    G.setHud(
      '<div class="lap-head">' +
        '<span class="lbl">Időmérés</span>' +
        '<span><span class="lap-now num">1</span><span class="lap-total num"> / 1</span></span>' +
      '</div>' +
      '<div class="hud-note"><strong>Felvezető</strong><br>Az időmérés a rajtvonalnál indul.</div>' +
      '<div class="t-row"><span class="lbl">Aktuális</span><span class="t-val num">—</span></div>' +
      '<div class="t-row"><span class="lbl">Összes</span><span class="t-val num">—</span></div>'
    );
    G.setStandings('');
    return;
  }

  // A kör-kijelző (jobb fent) ugyanaz a panel, mint egyjátékosban; a mezőny
  // állása KÜLÖN panelbe megy (bal fent). Korábban a kettő egy dobozban volt,
  // és pont ettől lett belőle olvashatatlan szövegfal.
  const completedTotal = myLapTimes.reduce((sum, lap) => sum + lap.time, 0);
  const { currentTime, totalTime } = raceClockTimes({
    now: nowServer,
    raceStartedAt: starting.startsAt,
    lapStartedAt: myLapStartedAt,
    completedTotal,
    finished: finishedDriving,
    hotLap: isHotLap(),
  });
  const validTimes = myLapTimes.filter((lap) => !lap.invalid).map((lap) => lap.time);
  const bestTime = validTimes.length ? Math.min(...validTimes) : NaN;
  G.setHud(
    '<div class="lap-head">' +
      '<span class="lbl">Kör</span>' +
      `<span><span class="lap-now num">${Math.min(myLap + 1, room?.laps ?? myLap + 1)}</span>` +
      `<span class="lap-total num"> / ${room?.laps ?? '?'}</span></span>` +
    '</div>' +
    (lapTainted ? '<div class="t-warn mb-2">⚠ Ez a kör érvénytelen</div>' : '') +
    `<div class="t-row"><span class="lbl">Aktuális</span>` +
      `<span class="t-val num">${G.formatTime(currentTime)}</span></div>` +
    `<div class="t-row${Number.isFinite(bestTime) ? ' is-best' : ''}">` +
      `<span class="lbl">Legjobb</span>` +
      `<span class="t-val num">${G.formatTime(bestTime)}</span></div>` +
    `<div class="t-row"><span class="lbl">Összes</span>` +
      `<span class="t-val num">${G.formatTime(totalTime)}</span></div>`
  );

  const evt = lastEvents[0];
  if (isHotLap()) {
    G.setStandings('');
  } else {
    G.setStandings(
      standingsHtml() +
      (evt ? `<div class="st-event">${escapeHtml(eventText(evt))}</div>` : '')
    );
  }
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
    {
      id: me.id, name: me.name || 'Te', color: myColor(), lap: myLap, cp: myCp,
      rank: myRank, gap: myGap, bestLap: myBestLap, lastLap: myLastLap,
      lastLapInvalid: myLastLapInvalid, finished: myFinished, self: true,
    },
    ...[...others.entries()].map(([id, o]) => ({
      id, name: o.name || '?', color: o.color, lap: o.lap || 0, cp: o.cp || 0,
      rank: o.rank, gap: o.gap, bestLap: o.bestLap, lastLap: o.lastLap,
      lastLapInvalid: o.lastLapInvalid, finished: o.finished, self: false,
    })),
  ].sort((a, b) => (a.rank || Infinity) - (b.rank || Infinity)
    || (b.lap - a.lap) || (b.cp - a.cp));

  const totalLaps = room?.laps ?? 0;
  const body = rows.map((r, i) => {
    const name = escapeHtml(r.name.slice(0, 14));
    const lap = totalLaps ? Math.min(r.lap + 1, totalLaps) : r.lap + 1;
    const gap = r.rank === 1 || i === 0
      ? '—'
      : Number.isFinite(r.gap) ? `+${(r.gap / 1000).toFixed(2)} s` : '…';
    const lastClass = r.lastLapInvalid ? ' is-invalid' : '';
    return `<div class="st-row${r.self ? ' is-self' : ''}${r.finished ? ' is-finished' : ''}">` +
      `<span class="st-pos num">${r.rank || i + 1}</span>${colorDot(r.color)}` +
      `<span class="st-name">${name}</span>` +
      `<span class="st-lap num">${lap}/${totalLaps || '?'}</span>` +
      `<span class="st-gap num">${gap}</span>` +
      `<span class="st-time num">${formatStandingTime(r.bestLap)}</span>` +
      `<span class="st-time num${lastClass}">${formatStandingTime(r.lastLap)}</span>` +
    '</div>';
  }).join('');

  return '<div class="st-title">' +
      '<span>Versenyállás</span>' +
      `<span>${rows.length} induló</span>` +
    '</div>' +
    '<div class="st-cols">' +
      '<span>#</span><span></span><span>Név</span><span>Kör</span>' +
      '<span>Rés</span><span>Legj.</span><span>Utolsó</span>' +
    '</div>' + body;
}

function formatStandingTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return G.formatTime(ms).replace(/^0:/, '');
}

function eventText(e) {
  const who = room?.players.find((p) => p.id === e.playerId)?.name || 'Valaki';
  if (e.kind === 'lap') return `${who}: ${e.lap}. kör ${(e.timeMs / 1000).toFixed(2)}s${e.invalid ? ' ⚠️' : ''}`;
  if (e.kind === 'finished') return `${who} célba ért!`;
  if (e.kind === 'left') return `${e.name} kilépett`;
  return '';
}

// A helyi fizikát és az állapotküldést fix ütemben futtatjuk, nem
// képkockánként, így a viselkedés és a hálózati terhelés FPS-független.

function startInputLoop() {
  stopInputLoop();
  // Új versenyben a csomagsorszámozás nulláról indul.
  inputSeq = 0;
  lapTainted = TAINT.NONE;
  finishedDriving = false;
  G.setMultiplayerControlsEnabled(true);
  predBuf.length = 0;

  // Önkorrigáló ütemező, nem setInterval: az utóbbi ezredmásodpercre kerekít
  // és hosszabb távon sodródna.
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
      next += TICK_MS;
      steps++;
    }
    if (next < now) next = now;
    inputTimer = setTimeout(tick, Math.max(0, next - performance.now()));
  };
  tick();
}

function sendOneInput(scheduledAt) {
  const k = G.keys;
  const controlsEnabled = !finishedDriving && !raceEnded;
  const axes = G.getDriveAxes();
  const pedal = controlsEnabled ? axes.pedal : 0;
  const backwardAmount = Math.max(0, -pedal);
  const backwardHeld = backwardAmount > 0;
  // Ugyanaz a "S/le nyíl fékezzen, amíg még előre gördül" logika, mint az
  // egyjátékos updateControls()-ban (web/main.js) — különben itt, a
  // multiplayer bemenetben az S megint csak a gyenge motor-fékezést adná,
  // ugyanaz a hiba térne vissza hálózaton.
  const { q, v } = G.getCarState();
  const fwdSpeed = forwardSpeed(q[0], q[1], q[2], q[3], v[0], v[1], v[2]);
  const brake = backwardHeld && fwdSpeed > REVERSE_BRAKE_THRESHOLD ? backwardAmount : 0;
  const reverseAmount = backwardHeld && !brake ? backwardAmount : 0;
  const finishedBraking = !controlsEnabled && shouldBrakeFinishedVelocity(v[0], v[2]);
  const shouldSend = !raceEnded;
  const input = {
    seq: shouldSend ? ++inputSeq : inputSeq,
    // Csak helyi metaadat: ebből tudjuk, melyik időpontra kell tenni a távoli
    // autók fizikai proxyját.
    at: serverNow(),
    frozen: isFrozen(),
    steer: controlsEnabled ? axes.steer : 0,
    throttle: Math.max(0, pedal) || -reverseAmount,
    brake: controlsEnabled ? brake : finishedBraking,
    handbrake: controlsEnabled && !!k['Space'],
  };
  syncRemoteProxies(input.at);
  G.stepLocalPhysics(input, input.frozen, !controlsEnabled);
  const state = G.getCarState();
  recordPhysState(scheduledAt, state);
  G.setSpeed(Math.hypot(state.v[0], state.v[2]) * 3.6);
  if (shouldSend) {
    const wheels = G.getWheelNetworkState?.() || { st: 0, wr: 0 };
    send(C2S.STATE, {
      seq: input.seq,
      t: serverNow() + (scheduledAt - performance.now()),
      ...state,
      ...wheels,
      th: input.throttle,
      offtrack: !!G.isCarFullyOffTrack?.(),
    });
  }
}

function stopInputLoop() {
  if (inputTimer) clearTimeout(inputTimer);
  inputTimer = null;
}

function showResults(results) {
  const hotLap = isHotLap();
  raceEnded = true;
  finishedDriving = true;
  G.setMultiplayerControlsEnabled(false);
  // Ne tartsa ki az eredménypanel alatt az utolsó, esetleg magas fordulatot.
  G.resetRaceAudio();
  for (const other of others.values()) {
    G.stopRemoteEngine(other.engineAudio);
    other.engineAudio = null;
  }
  currentRaceResults = results;
  const rows = results.map((r) => {
    const player = room?.players.find((p) => p.id === r.playerId);
    const name = escapeHtml(player?.name || '?');
    return `<div class="mp-res-row${r.playerId === me.id ? ' is-self' : ''}">` +
      `<span class="mp-res-pos num">${r.position}</span>${colorDot(player?.color)}` +
      `<span class="mp-res-name">${name}</span>` +
      `<span class="mp-res-laps num">${r.lapsCompleted}/${room?.laps ?? '?'}</span>` +
      `<span class="mp-res-time num">${G.formatTime(r.totalMs)}</span>` +
      `<span class="mp-res-time num">${Number.isFinite(r.bestLapMs) ? G.formatTime(r.bestLapMs) : '—'}</span>` +
    '</div>';
  }).join('');
  G.setHud(`<div class="lap-head"><span class="lbl">${hotLap ? 'Időmérés vége' : 'Verseny vége'}</span></div>`);
  G.setStandings('');
  $('mpResultsTitle').textContent = hotLap ? 'Időmérés vége' : 'Verseny vége';
  $('mpResultsBody').innerHTML =
    '<div class="mp-res-cols">' +
      '<span>#</span><span></span><span>Név</span><span>Kör</span>' +
      '<span>Összes</span><span>Legjobb</span>' +
    '</div>' + rows;
  mpResultsEl.classList.remove('hidden');
  updateResultsActions();
}

function updateResultsActions() {
  if (mpResultsEl.classList.contains('hidden')) return;
  const hotLap = isHotLap();
  const isHost = room?.hostId === me.id;
  const restart = $('mpResultsRestart');
  restart.classList.toggle('hidden', !hotLap && !isHost);
  restart.disabled = false;
  restart.textContent = hotLap ? 'Új próbálkozás' : 'Új játék';
  $('mpResultsHint').textContent = hotLap
    ? 'Az R billentyűvel menet közben is teljesen újrakezdheted a próbát.'
    : isHost
    ? 'Te vagy a szoba tulajdonosa — ugyanebben a szobában indíthatsz új futamot.'
    : 'Várakozás a szoba tulajdonosára, vagy kiléphetsz a szobából.';
}

function hideMultiplayerResults() {
  mpResultsEl.classList.add('hidden');
  currentRaceResults = null;
}

$('mpResultsRestart').addEventListener('click', () => {
  if (!currentRaceResults || (!isHotLap() && room?.hostId !== me.id)) return;
  G.requestGameFullscreen();
  const button = $('mpResultsRestart');
  button.disabled = true;
  button.textContent = 'Indítás…';
  send(isHotLap() ? C2S.RESET : C2S.START_RACE);
});

$('mpResultsLeave').addEventListener('click', () => {
  const hotLap = isHotLap();
  hideMultiplayerResults();
  if (room) send(C2S.LEAVE_ROOM);
  room = null;
  starting = null;
  G.leaveMultiplayer();
  show('mpRoom', false);
  if (!hotLap) {
    show('mpRooms', true);
    openLobby();
  }
});

// Az Egyjátékos és az Időmérés osztozik a felső soron; a Többjátékos külön,
// teljes szélességű sort kap alattuk, hogy a három mód ne zsúfolódjon össze.
const modeButtons = document.getElementById('modeButtons');
const hotLapBtn = document.createElement('button');
hotLapBtn.id = 'hotLapBtn';
hotLapBtn.className = 'btn-race btn-hotlap';
hotLapBtn.textContent = 'Időmérés';
hotLapBtn.addEventListener('click', openHotLap);
modeButtons?.appendChild(hotLapBtn);

const btn = document.createElement('button');
btn.id = 'mpOpenBtn';
btn.className = 'btn-race btn-mp';
btn.textContent = 'Többjátékos';
btn.addEventListener('click', openLobby);
modeButtons?.appendChild(btn);
