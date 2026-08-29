// Online verseny kliens: a saját autó fizikája helyben fut, kész állapotát a
// szerver ellenőrzi és továbbítja. A többi autó snapshotból, interpolálva jelenik meg.
import {
  C2S, S2C, ROOM_STATE, GAME_MODE, TAINT, TICK_MS,
  CLIENT_STATE_INTERVAL_TICKS, clientStateSendDue,
  PLAYER_TOKEN_LENGTH, RECONNECT_GRACE_MS, sanitizeName, sanitizePlayerToken,
} from '/shared/protocol.js';
import {
  forwardSpeed, REVERSE_BRAKE_THRESHOLD, shouldBrakeFinishedVelocity, STEER_VISUAL_SPEED,
} from '/shared/vehicleConfig.js';
import { raceClockTimes } from '/shared/raceClock.js';
import { ghostCheckpointSplits } from '/shared/gate.js';
import {
  LOCAL_RENDER_DELAY_MAX_MS, LOCAL_RENDER_DELAY_MIN_MS,
  REMOTE_VISUAL_PREDICT_FAR,
  alignedRemoteRenderTime,
  localRenderDelayTarget, remoteDetailPhase, remoteDetailUpdateInterval,
  remoteVisualCorrectionHalfLife,
  remoteVisualNearFactor, smootherLeadSeconds,
} from '/shared/remoteVisual.js';
import {
  advanceRenderClock, pushTransitSample, expireTransitSamples,
  remoteDelayTarget, transitSpreadMs,
  LOCAL_CLOCK_RATE_MIN, LOCAL_CLOCK_RATE_MAX,
  REMOTE_CLOCK_RATE_MIN, REMOTE_CLOCK_RATE_MAX,
} from '/shared/renderClock.js';
import { createPitState, hasCompletePitConfig, updatePitState } from '/shared/pit.js';
import {
  changeTires, createTireWearState,
  syncTireWearSnapshot,
} from '/shared/tireWear.js';
import {
  acceptsClockSample, smoothPing, updateMinRtt,
} from '/shared/ping.js';
import { ERR } from '/shared/errorCodes.js';
import { remoteExtrapolationTiming, remoteSnapshotSample } from '/shared/remoteSnapshot.js';
import { carContactStateIsFresh } from '/shared/carContact.js';
import {
  createVisualMotionTracker, observeVisualMotion, resetVisualMotionTracker,
} from '/shared/visualMotion.js';
import { t, hasKey, onLanguageChange, applyToDom } from './lang.js';
import {
  NET_DIAG_CONNECTION, NET_DIAG_EVENT, NET_DIAG_INCIDENT, NET_DIAG_RACE_STAGE,
  netDiagnostics,
} from './netDiagnostics.js';
import { hideSplitDelta, showSplitDelta } from './splitDelta.js';

// A szerver kódot küld (shared/errorCodes.js), a szöveg itt születik a
// játékos nyelvén. A `detail` technikai adat (kivételszöveg, üzenettípus),
// azt nem fordítjuk, csak hozzáfűzzük.
function serverText(m) {
  const key = m.code ? `server.${m.code}` : null;
  if (key && hasKey(key)) return t(key) + (m.detail || '');
  // Ismeretlen kód esetén inkább a nyers szöveg, mint semmi.
  return m.message || m.reason || m.code || '';
}

const G = window.__game;
// Diagnosztika. A step() azért kell, mert a requestAnimationFrame megáll, ha
// a lap háttérbe kerül — enélkül a hálózati réteget nem lehetne automatizáltan
// tesztelni (a képkocka-számláló ilyenkor csalókán nullán marad).
window.__mp = {
  stage: 'init', frames: 0, snaps: 0, snapshotsApplied: 0,
  // Hány ping-mintát dobtunk el főszál-akadás miatt (lásd startStallWatch).
  // Ha ez folyamatosan nő, az nem hálózati gond, hanem akadozó kliens.
  pingDiscarded: 0,
  snapshotTransitDropped: 0,
  // Hány ping-minta bizonyult túl késleltetettnek az ÓRA becsléséhez, és hány
  // állapotküldést hagytunk ki torlódott kimeneti sor miatt. Mindkettő azt
  // mutatja, hogy a védelem dolgozik — a növekedésük nem hiba.
  get clockSamplesDropped() { return clockSamplesDropped; },
  get statesDropped() { return statesDropped; },
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
  get predDelayMs() { return +predDelayMs.toFixed(1); },
  get physSteps() { return physSteps; },
  get physicsTimerLatenessMs() { return +physicsTimerLatenessMs.toFixed(1); },
  get physicsTimerJitterMs() { return +physicsTimerJitterMs.toFixed(1); },
  takePipelineTimings: () => takePipelineTimings(),
  takeLocalPlaybackDiagnostics: () => takeLocalPlaybackDiagnostics(),
  takeVisualMotionDiagnostics: () => takeVisualMotionDiagnostics(),
  // A szerver legutóbbi ellenőrzött állapota a saját kocsinkról.
  get lastSelf() { return lastSnapshot?.cars?.find((c) => c.id === me.id) || null; },
  // A helyi fizika és a kirajzolási interpoláció pozíciója diagnosztikához.
  get rawPos() { const s = G.getCarState(); return [s.p[0], s.p[2]]; },
  get interpPos() { const s = interpolatedPhys(); return [s.p[0], s.p[2]]; },
};
const THREE = G.THREE;

let ws = null;
let me = { id: null, name: null, token: localStorage.getItem('racing.token') || null };
let resumeSessionId = null;
let reconnecting = false;
let reconnectTimer = null;
let reconnectDeadline = 0;
let reconnectAttempt = 0;
let room = null;
let starting = null;
let pendingHotLap = null;
// A távoli autók modelljei: playerId -> { group, buf: [állapotok] }
const others = new Map();
let nearestRemoteVisualDistanceM = Infinity;
let nearRemoteTimelineShiftMaxM = 0;
let nearRemoteVisualJerkMaxM = 0;
let nearRemoteSeen = false;
let nearRemoteMotionSeen = false;

function takeVisualMotionDiagnostics() {
  const sample = {
    nearestDistanceM: Number.isFinite(nearestRemoteVisualDistanceM)
      ? nearestRemoteVisualDistanceM
      : Number.NaN,
    nearTimelineShiftMaxM: nearRemoteSeen ? nearRemoteTimelineShiftMaxM : Number.NaN,
    nearJerkMaxM: nearRemoteMotionSeen ? nearRemoteVisualJerkMaxM : Number.NaN,
  };
  nearestRemoteVisualDistanceM = Infinity;
  nearRemoteTimelineShiftMaxM = 0;
  nearRemoteVisualJerkMaxM = 0;
  nearRemoteSeen = false;
  nearRemoteMotionSeen = false;
  return sample;
}

function observeRemoteVisualMotion(o, nowMs, distanceM, timelineShiftM) {
  if (distanceM < nearestRemoteVisualDistanceM) {
    nearestRemoteVisualDistanceM = distanceM;
  }
  const motionValid = observeVisualMotion(
    o.visualMotion,
    o.group.position.x,
    o.group.position.y,
    o.group.position.z,
    nowMs,
  );
  if (distanceM > REMOTE_VISUAL_PREDICT_FAR) return;
  nearRemoteSeen = true;
  nearRemoteTimelineShiftMaxM = Math.max(nearRemoteTimelineShiftMaxM, timelineShiftM);
  if (!motionValid) return;
  nearRemoteMotionSeen = true;
  nearRemoteVisualJerkMaxM = Math.max(nearRemoteVisualJerkMaxM, o.visualMotion.residualM);
}
// A kiválasztott ranglistakör áttetsző visszajátszása. Nem kerül fizikai
// kontaktlistába, ezért nem tud ütközni.
let ghostCar = null;
let currentRaceResults = null;
let inputSeq = 0;
let awaitingFirstSnapshot = false;
let raceLoadGeneration = 0;
let raceLoadActive = false;
let raceLoadController = null;
// Kilépés érkezhet addig, amíg az ellenfél GLB-je még töltődik. A mapból
// ilyenkor még nincs mit eltávolítani, ezért külön megjegyezzük, hogy a későn
// elkészült modell már nem tartozik az aktuális mezőnyhöz.
const departedPlayerIds = new Set();
// Elromlott-e már az aktuális kör a szerver szerint, és ha igen, MIÉRT: a
// snapshot `ti` mezője a TAINT kódját küldi (0 = érvényes). A konkrét ok kell,
// nem csak egy igen/nem — abból a játékos nem tudja, mit rontott el.
let lapTainted = TAINT.NONE;
let localPitConfig = null;
let localPitState = createPitState(false);
let localTireState = createTireWearState(false);
let localPitStopIndex = 0;
let pitPrevPosition = null;
let inputLoopActive = false;
let nextInputTickAt = 0;
// A helyi fizika 60 Hz marad, de csak minden második lépés kerül hálózatra.
// Futam/reconnect kezdetén a nulla fázis azonnali első csomagot jelent.
let stateSendPhase = 0;
// A RACE_END után true: a frame() innentől nem írja felül a HUD-ot a
// kör/játékos szöveggel, különben a showResults() eredménylistája egyetlen
// képkockányi ideig látszana csak, mielőtt a következő frame() lenullázná.
let raceEnded = false;
let finishedDriving = false;
let raceRunningDiagnosticRecorded = false;
let lastEvents = [];
// Mikor zárul le magától a futam az első befutó után, a SZERVER órája szerint
// (vagy null, ha még senki sem ért célba). A snapshotokból frissül, a
// kijelzést a frame() számolja belőle — így a visszaszámláló képkocka-simán
// pörög, nem a 20 Hz-es snapshot-ütemben ugrik.
let finishDeadlineAt = null;

// Kit nézünk célba érés után. null = a saját (leparkolt) kocsinkat.
// Csak a `finishedDriving` állapotban van értelme; a kamerát a main.js
// állítja át, itt csak azt tartjuk nyilván, KIRE.
let spectateId = null;

// ---------- Részidő-különbség ----------
//
// Checkpointonként megmutatjuk, mennyivel vagyunk jobbak vagy rosszabbak a
// viszonyítási körnél. Normál versenyben a SAJÁT legjobb érvényes körünk;
// Időmérésben mindig a kiválasztott szellemé — ott ő az ellenfél.
//
// A részidőket a szerver adja (snapshot `ci`/`ct`), mert az átlépés pontos
// idejét csak ő ismeri: a kliens a 20 Hz-es snapshotokból legfeljebb 50 ms-ra
// tippelhetne, és a delta pont századokról szól.
let lastSeenSplitIndex = -1;

function resetSplitTracking() {
  lastSeenSplitIndex = -1;
  hideSplitDelta();
}

// Mihez mérjük magunkat? Időmérésben kizárólag a szellemhez — ő az ellenfél,
// az ő idejét akarjuk verni. Normál versenyben a szerver által küldött saját
// legjobb érvényes körhöz. Ha a választott referenciának még nincs részideje,
// nincs mit kiírni.
// A szellem checkpoint-részidői a felvett pályájából. A párhuzamos assetek
// elkészülte után előre kiszámoljuk őket; ez a függvény lazy tartalék is arra,
// ha akkor még nem álltak a kapuk. A pálya azonosítóját is eltesszük, hogy egy
// másik pályára maradt számítás ne ragadjon bent.
function ghostSplits() {
  if (!ghostCar?.frames) return null;
  const mapId = G.currentMapId;
  const checkpoints = G.currentGates?.checkpoints;
  if (!checkpoints?.length) return null;
  if (ghostCar.splitsMapId !== mapId) {
    ghostCar.splits = ghostCheckpointSplits(ghostCar.frames, checkpoints);
    ghostCar.splitsMapId = mapId;
  }
  return ghostCar.splits;
}

function splitReference(index, bestSplitMs) {
  if (isHotLap()) {
    const splits = ghostSplits();
    const split = splits?.[index];
    return Number.isFinite(split)
      ? { split, label: ghostCar.name || t('mp.ghost') }
      : null;
  }
  return Number.isFinite(bestSplitMs)
    ? { split: bestSplitMs, label: t('hud.bestLap') }
    : null;
}

const waitingPlayersAlertEl = document.getElementById('waitingPlayersAlert');
const waitingPlayersAlertTextEl = document.getElementById('waitingPlayersAlertText');
let lastWaitingDiagnostic = '';

function setWaitingPlayersAlert(visible, waiting = []) {
  waitingPlayersAlertTextEl.textContent = waiting.length
    ? t('mp.waitingForOthers', { names: waiting.join(', ') })
    : t('mp.waitingForStart');
  waitingPlayersAlertEl.classList.toggle('hidden', !visible);
  const diagnostic = visible ? `1:${waiting.length}` : '0';
  if (diagnostic !== lastWaitingDiagnostic) {
    lastWaitingDiagnostic = diagnostic;
    netDiagnostics.record(
      NET_DIAG_EVENT.WAITING,
      visible,
      waiting.length,
      visible && waiting.length === 0,
    );
  }
}

// A szerver minden snapshotban elmondja, melyik checkpointot érintettük
// utoljára és mikor, valamint ugyanott mennyi volt a legjobb körünk részideje.
// Új sorszámnál, ha van mihez mérni, kiírjuk.
function trackSplit(index, splitMs, bestSplitMs) {
  if (!Number.isInteger(index) || index < 0 || index === lastSeenSplitIndex) return;
  lastSeenSplitIndex = index;
  const reference = splitReference(index, bestSplitMs);
  if (!reference || !Number.isFinite(splitMs)) return;
  showSplitDelta(splitMs - reference.split, reference.label);
}

// ---------- Lobby felület ----------

const el = document.createElement('div');
el.id = 'mpOverlay';
el.className = 'hidden';
el.innerHTML = `
<div class="mp-panel">
  <div class="mp-head">
    <h5 id="mpTitle" data-i18n="menu.multiplayer">Többjátékos</h5>
    <button id="mpClose" class="mp-x" data-i18n-title="mp.ui.backToMenu" title="Vissza a menübe">&times;</button>
  </div>
  <div class="mp-body">
    <div id="mpLogin">
      <label for="mpName" class="lbl d-block mb-2" data-i18n="mp.ui.playerName">Játékosnév</label>
      <input id="mpName" class="form-control mb-3" maxlength="20" data-i18n-placeholder="mp.ui.yourName" placeholder="A neved">
      <button id="mpConnect" class="mp-btn primary w-100" data-i18n="mp.ui.connect">Csatlakozás a szerverhez</button>
      <div class="mp-sep" data-i18n="mp.ui.orExistingProfile">vagy meglévő profil</div>
      <label for="mpToken" class="lbl d-block mb-2" data-i18n="mp.ui.loginToken">Belépési token</label>
      <div class="d-flex gap-2">
        <input id="mpToken" class="form-control mp-token-input" type="password"
               maxlength="${PLAYER_TOKEN_LENGTH}" autocomplete="off" spellcheck="false"
               placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx">
        <button id="mpRestore" class="mp-btn ghost mp-btn-fixed" data-i18n="mp.ui.restore">Visszalépés</button>
      </div>
      <div class="mp-token-note" data-i18n="mp.ui.tokenNote">A token a profilod kulcsa.</div>
    </div>

    <div id="mpRooms" class="hidden">
      <div class="mp-account mb-3">
        <div class="mp-account-status"><span data-i18n="mp.ui.loggedInAs">Bejelentkezve:</span> <b id="mpWho"></b></div>
        <div class="mp-account-panel">
          <div class="mp-account-actions">
            <button id="mpRenameToggle" class="mp-btn ghost compact" data-i18n="mp.ui.rename">Név átírása</button>
            <button id="mpCopyToken" class="mp-btn ghost compact" aria-live="polite" data-i18n="mp.copyToken">Token másolása</button>
            <button id="mpLogout" class="mp-btn danger compact" data-i18n="mp.ui.logout">Kijelentkezés</button>
          </div>
          <div id="mpRename" class="d-flex gap-2 mt-2 hidden">
            <input id="mpRenameName" class="form-control" maxlength="20" data-i18n-placeholder="mp.ui.newName" placeholder="Új játékosnév">
            <button id="mpRenameSave" class="mp-btn primary mp-btn-fixed" data-i18n="mp.ui.save">Mentés</button>
            <button id="mpRenameCancel" class="mp-btn ghost mp-btn-fixed" data-i18n="mp.ui.cancel">Mégse</button>
          </div>
          <div class="mp-token-note" data-i18n="mp.ui.tokenNote2">A tokennel másik gépen is visszaléphetsz.</div>
        </div>
      </div>
      <button id="mpCreate" class="mp-btn primary w-100" data-i18n="mp.ui.createRoom">Új szoba létrehozása</button>
      <label class="mp-visibility" for="mpPublicRoom">
        <input id="mpPublicRoom" type="checkbox" checked>
        <span>
          <strong data-i18n="mp.ui.publicRoom">Publikus szoba</strong>
          <small data-i18n="mp.ui.publicRoomHint">Megjelenik a keresőben.</small>
        </span>
      </label>

      <div class="mp-sep" data-i18n="mp.ui.or">vagy</div>
      <div class="mp-browse-head">
        <span class="lbl" data-i18n="mp.ui.browseRooms">Szoba keresése</span>
        <span id="mpBrowseCount" class="mp-browse-count"></span>
      </div>
      <div id="mpBrowseList" class="mp-browse-list">
        <div class="mp-browse-empty" data-i18n="leaderboard.loading">Betöltés…</div>
      </div>
      <div id="mpBrowsePager" class="mp-browse-pager hidden">
        <button id="mpBrowsePrev" class="mp-btn ghost compact" type="button" data-i18n="mp.ui.prevPage">‹ Előző</button>
        <span id="mpBrowsePage" class="mp-browse-page"></span>
        <button id="mpBrowseNext" class="mp-btn ghost compact" type="button" data-i18n="mp.ui.nextPage">Következő ›</button>
      </div>

      <div class="mp-sep" data-i18n="mp.ui.or">vagy</div>
      <label for="mpCode" class="lbl d-block mb-2" data-i18n="mp.ui.joinByCode">Csatlakozás kóddal</label>
      <div class="d-flex gap-2">
        <input id="mpCode" class="form-control text-uppercase" maxlength="6" data-i18n-placeholder="mp.ui.roomCodePlaceholder" placeholder="SZOBAKÓD"
               style="letter-spacing:.16em; font-weight:700;">
        <button id="mpJoin" class="mp-btn ghost" style="flex:none;" data-i18n="mp.join">Belépés</button>
      </div>
    </div>

    <div id="mpRoom" class="hidden">
      <div class="mp-code-box">
        <div>
          <span class="lbl d-block mb-2" data-i18n="mp.ui.roomCode">Szobakód</span>
          <span id="mpRoomCode" class="mp-code-val num"></span>
        </div>
        <button id="mpCopy" class="mp-btn ghost" style="flex:none;" aria-live="polite" data-i18n="mp.copy">Másol</button>
      </div>
      <div class="mp-meta">
        <span class="mp-chip"><span data-i18n="mp.ui.trackLabel">Pálya:</span> <b id="mpRoomMap"></b></span>
        <span class="mp-chip"><b id="mpRoomLaps"></b> <span data-i18n="mp.ui.lapsWord">kör</span></span>
        <span class="mp-chip"><span data-i18n="mp.ui.modeLabel">Mód:</span> <b id="mpRoomMode"></b></span>
        <span class="mp-chip" id="mpRoomVisibility"></span>
      </div>
      <span class="lbl d-block mb-2" data-i18n="mp.ui.players">Játékosok</span>
      <div id="mpPlayers"></div>
      <div id="mpHint" class="mp-note"></div>
      <div class="d-flex gap-2 mt-3">
        <button id="mpStart" class="mp-btn primary flex-grow-1" data-i18n="mp.ui.startRace">Verseny indítása</button>
        <button id="mpLeave" class="mp-btn danger" data-i18n="mp.ui.leave">Kilépés</button>
      </div>
    </div>

    <div id="mpError"></div>
  </div>
</div>`;
document.body.appendChild(el);
applyToDom(el);

// A multiplayer eredmény nem tűnik el automatikusan: mindenki nyugodtan
// megnézheti, majd kiléphet; a szoba tulajdonosa ugyanebből a panelből
// indíthatja a következő futamot ugyanazzal a társasággal.
const mpResultsEl = document.createElement('div');
mpResultsEl.id = 'mpResults';
mpResultsEl.className = 'hidden';
mpResultsEl.innerHTML = `
  <div class="panel mp-results-card">
    <div id="mpResultsTitle" class="results-title" data-i18n="mp.raceOver">Verseny vége</div>
    <div id="mpResultsBody"></div>
    <div id="mpResultsHint" class="mp-results-hint"></div>
    <div class="d-flex gap-2 mt-4">
      <button id="mpResultsRestart" class="mp-btn primary flex-grow-1" data-i18n="mp.newGame">Új játék</button>
      <button id="mpResultsLeave" class="mp-btn ghost" data-i18n="mp.ui.leave">Kilépés</button>
    </div>
  </div>`;
document.body.appendChild(mpResultsEl);
applyToDom(mpResultsEl);

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
        <h5 data-i18n="mp.ui.startHotLap">Időmérés indítása</h5>
        <div id="hotLapGhostMap" class="hotlap-picker-map"></div>
      </div>
      <button id="hotLapGhostClose" class="mp-x" data-i18n-title="mp.ui.close" title="Bezárás">&times;</button>
    </div>
    <div class="mp-body">
      <div class="hotlap-picker-intro" data-i18n="mp.ui.ghostPickerIntro">
        Válassz egy ranglistakört szellemnek.
      </div>
      <div id="hotLapGhostList" class="hotlap-ghost-list"></div>
      <div id="hotLapGhostError" class="hotlap-picker-error"></div>
      <div class="hotlap-picker-actions">
        <button id="hotLapGhostCancel" class="mp-btn ghost" data-i18n="mp.ui.cancel">Mégse</button>
        <button id="hotLapGhostStart" class="mp-btn primary flex-grow-1" data-i18n="mp.ui.startHotLap">Időmérés indítása</button>
      </div>
    </div>
  </div>`;
document.body.appendChild(hotLapGhostPickerEl);
applyToDom(hotLapGhostPickerEl);

const $ = (id) => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle('hidden', !on);
const setErr = (m) => { $('mpError').textContent = m || ''; };
const ghostModeCheckbox = $('ghostModeCheckbox');
const tireWearCheckbox = $('tireWearCheckbox');
ghostModeCheckbox.checked = localStorage.getItem('racing.ghostMode') === '1';
ghostModeCheckbox.addEventListener('change', () => {
  localStorage.setItem('racing.ghostMode', ghostModeCheckbox.checked ? '1' : '0');
});
// A szoba láthatósága is megjegyződik, mint a Ghost mód. Alapból PUBLIKUS:
// a kereső csak akkor ér valamit, ha van benne mit találni; aki zárt kört
// akar, egy kattintással kikapcsolja, és a beállítás megmarad neki.
const publicRoomCheckbox = $('mpPublicRoom');
publicRoomCheckbox.checked = localStorage.getItem('racing.publicRoom') !== '0';
publicRoomCheckbox.addEventListener('change', () => {
  localStorage.setItem('racing.publicRoom', publicRoomCheckbox.checked ? '1' : '0');
});

export function openLobby() {
  closeHotLapGhostPicker();
  pendingHotLap = null;
  $('mpTitle').textContent = t('menu.multiplayer');
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
  // A kereső csak akkor kérdezzen, ha a panel nyitva van — a lekérés maga is
  // ellenőrzi a láthatóságot, itt csak elindítjuk/leállítjuk az órát.
  startRoomListLoop();
}
function closeLobby() {
  if (!room) pendingHotLap = null;
  el.classList.add('hidden');
  stopRoomListLoop();
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
      `<span class="hotlap-ghost-name">${t('mp.noGhost')}</span>` +
      `<span class="hotlap-ghost-time">${t('mp.startAlone')}</span>` +
    '</label>';
  if (!entries.length) {
    return noGhost + `<div class="hotlap-picker-empty">${t('mp.noLeaderboardLap')}</div>`;
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
      `<span class="hotlap-ghost-state">${available ? t('mp.ghostAvailable') : t('mp.ghostNoRecording')}</span>` +
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
  $('hotLapGhostList').innerHTML = `<div class="hotlap-picker-empty">${t('mp.leaderboardLoading')}</div>`;
  $('hotLapGhostStart').disabled = true;
  hotLapGhostPickerEl.classList.remove('hidden');

  try {
    const response = await fetch(`/api/leaderboard?mapId=${encodeURIComponent(race.mapId)}&limit=20`);
    if (!response.ok) throw new Error(t('mp.leaderboardFailed'));
    const entries = (await response.json()).entries || [];
    if (generation !== hotLapPickerGeneration) return;
    $('hotLapGhostList').innerHTML = ghostChoiceHtml(entries, savedHotLapGhost(race.mapId));
  } catch {
    if (generation !== hotLapPickerGeneration) return;
    $('hotLapGhostList').innerHTML = ghostChoiceHtml([], null);
    $('hotLapGhostError').textContent = t('mp.leaderboardFailedHint');
  }
  $('hotLapGhostStart').disabled = false;
}

function beginHotLap(race, ghostPlayerId) {
  saveHotLapGhost(race.mapId, ghostPlayerId);
  pendingHotLap = { ...race, ghostPlayerId };
  closeHotLapGhostPicker();
  $('mpTitle').textContent = t('mp.hotLap');
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
      name: sanitizeName(localStorage.getItem('racing.name') || t('mp.defaultName')),
      token: me.token,
    });
  }
}

export function openHotLap() {
  const { mapId, carId } = selectedMenuRace();
  if (!mapId || !carId) return G.setMenuStatus(t('mp.pickMapCar'));
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
  if (!token) return setErr(t('mp.invalidToken'));
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
  cancelReconnect();
  resumeSessionId = null;
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
  if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000, 'logout');
  else {
    ws = null;
    loggingOut = false;
  }
});

$('mpCreate').addEventListener('click', () => {
  const mapId = document.getElementById('mapSelect')?.value;
  const carId = document.getElementById('carSelect')?.value;
  const laps = Number(document.getElementById('lapCountSelect')?.value) || 5;
  if (!mapId || !carId) return setErr(t('mp.pickMapCarMenu'));
  send(C2S.CREATE_ROOM, {
    mapId,
    carId,
    laps,
    ghostMode: ghostModeCheckbox.checked,
    tireWear: laps > 1 && tireWearCheckbox.checked,
    isPublic: publicRoomCheckbox.checked,
  });
});

$('mpJoin').addEventListener('click', () => {
  const code = $('mpCode').value.trim().toUpperCase();
  if (code.length < 4) return setErr(t('mp.enterRoomCode'));
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
  requestRoomList();
});
let copyFeedbackTimer = null;
$('mpCopy').addEventListener('click', async () => {
  const code = room?.code || '';
  if (!code) return;
  const button = $('mpCopy');
  try {
    await navigator.clipboard.writeText(code);
    if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
    button.textContent = t('mp.copied');
    button.classList.add('is-copied');
    copyFeedbackTimer = setTimeout(() => {
      button.textContent = t('mp.copy');
      button.classList.remove('is-copied');
      copyFeedbackTimer = null;
    }, 1400);
  } catch {
    setErr(t('mp.copyRoomFailed'));
  }
});

let tokenCopyFeedbackTimer = null;
$('mpCopyToken').addEventListener('click', async () => {
  if (!me.token) return setErr(t('mp.noToken'));
  const button = $('mpCopyToken');
  try {
    await navigator.clipboard.writeText(me.token);
    if (tokenCopyFeedbackTimer) clearTimeout(tokenCopyFeedbackTimer);
    button.textContent = t('mp.tokenCopied');
    button.classList.add('is-copied');
    tokenCopyFeedbackTimer = setTimeout(() => {
      button.textContent = t('mp.copyToken');
      button.classList.remove('is-copied');
      tokenCopyFeedbackTimer = null;
    }, 1800);
  } catch {
    setErr(t('mp.copyTokenFailed'));
  }
});

// Az "R" multiplayerben KÉRÉS a szerver felé, nem helyi teleport — a kocsi
// helyét a szerver birtokolja. Élre figyelünk (e.repeat nélkül), nem a
// lenyomva tartásra: különben képkockánként küldenénk egy kérést.
let multiplayerStartCrossed = false;
let resetPending = false;

function requestMultiplayerReset() {
  if (G.appState !== 'mp') return;
  if (isHotLap()) return send(C2S.RESET);
  if (!multiplayerStartCrossed || resetPending) return;
  resetPending = true;
  send(C2S.RESET);
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
// Pályabetöltés közben a WebSocket-válasz feldolgozását maga a kliens főszála
// késleltetheti. Az ilyen PING-ek nem hálózati minták; a betöltés végén húzott
// határ előtt indult válaszokat akkor is eldobjuk, ha csak utána érkeznek meg.
let pingValidAfter = 0;
let pingNeedsFreshSample = false;
// A LEGKISEBB eddig látott körút-idő. A szerveróra becslése ugyanis
// `serverNow + rtt/2` alakú, ami SZIMMETRIKUS utat feltételez — egy torlódott
// csomagnál ez nagyot téved, és a hiba fele egyenesen az órabecslésbe megy.
// Mérve, 30 ms-os valódi ping mellett: egy 500 ms-os minta 235 ms becslési
// hibát jelent, aminek a 10%-a (az EWMA súlya) azonnal eltolja az órát — és az
// óra MINDEN távoli kocsi interpolációját hajtja, tehát egyszerre ugranak.
//
// A legkevésbé késleltetett csomag torzít a legkevésbé, ezért az órát csak a
// minimum közelébe eső mintákból frissítjük. A minimum lefelé azonnal követ,
// felfelé mintánként 1 ms-t kúszik: így egy tartósan romló hálózathoz
// hozzáigazodik, de egyetlen szerencsés csomag nem zárja ki örökre a többit.
let pingMinRttMs = Infinity;
let clockSamplesDropped = 0;

// Minden abszolút szerveridő (snapshot, rajt) ezen keresztül megy. A PONG
// mintákból becsült offset miatt a kliens elállított órája sem tolja el a
// visszaszámlálást vagy az interpolációs ablakot.
function serverNow() {
  return Date.now() + (clockReady ? clockOffsetMs : 0);
}

// Egy HELYI (performance.now) időpont szerverórára átszámolva.
//
// Az ütemező behozáskor egyetlen hívásban akár három fizikai lépést is
// lefuttat egymás után. Azok a lépések a SAJÁT ütemezett idejükkel dolgoznak,
// tehát három külön szimulációs pillanatot jelentenek — a falióra viszont
// közben alig mozdul. Aki `serverNow()`-t hívna mindháromban, gyakorlatilag
// ugyanazt az időt kapná, és a távoli kontaktpóz állna, míg a sajátunk
// három ticknyit halad. Kontaktban ez háromszorozná a benyomódást.
function serverTimeFor(localMs) {
  return serverNow() + (localMs - performance.now());
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
// kellett volna, akkor a főszál addig blokkolt. Nem a RAF-kockák távolságából
// döntünk: egy stabilan 20 FPS-es gépen az 50 ms teljesen szabályos ütemezés,
// nem bizonyítja, hogy a JavaScript szál blokkolt.
const STALL_TICK_MS = 50;
const STALL_THRESHOLD_MS = 100;
// A főszál felengedésekor a WebSocket callbackek csak akkor futnak le, tehát a
// csomag `serverNow() - snapshot.t` értéke a HELYI fagyást is tartalmazza.
// Rövid türelmi ablakban ezeket az állapotokat továbbra is feldolgozzuk, csak a
// hálózati p95 mintájába nem engedjük be őket.
const STALL_TRANSIT_GRACE_MS = 500;
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
  pingRttMs = 0;
  lastPingRttMs = null;
  pingJitterMs = 0;
  pingValidAfter = 0;
  pingNeedsFreshSample = false;
  startStallWatch();
  sendPing();
  pingTimer = setInterval(sendPing, PING_INTERVAL_MS);
}

function stopPingLoop() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
  stopStallWatch();
}

// ---------- Szobakereső ----------
//
// A lista LEKÉRÉSSEL frissül, nem szerver-oldali szórással: így csak az kap
// forgalmat, aki tényleg a keresőt nézi, és nem kell minden szoba-eseményt
// (belépés, rajt, verseny vége) külön értesítési útvonalra fűzni. Egyetlen
// óra fut, az is csak akkor kér, ha a panel LÁTSZIK — háttérben ülő fülnek
// nincs miért kérdezősködnie.
const ROOM_LIST_INTERVAL_MS = 4000;
let roomListTimer = null;
// Hányadik oldalt nézzük (0-tól). A szerver a válaszban megmondja, melyik
// oldalt adta ténylegesen — ha az általunk kért közben megszűnt, ő igazít,
// és mi ahhoz állunk hozzá. Így a lapozó sosem mutat nem létező oldalt.
let roomListPage = 0;

function requestRoomList() {
  if (ws?.readyState !== WebSocket.OPEN || !me.id) return;
  if ($('mpRooms').classList.contains('hidden')) return;
  send(C2S.LIST_ROOMS, { page: roomListPage });
}

function stepRoomListPage(delta) {
  roomListPage = Math.max(0, roomListPage + delta);
  requestRoomList();
}

$('mpBrowsePrev').addEventListener('click', () => stepRoomListPage(-1));
$('mpBrowseNext').addEventListener('click', () => stepRoomListPage(1));

function startRoomListLoop() {
  stopRoomListLoop();
  // Friss belépéskor az első oldalról indulunk — a korábbi böngészés helye
  // nem érdekes, és a szobák úgyis cserélődtek azóta.
  roomListPage = 0;
  requestRoomList();
  roomListTimer = setInterval(requestRoomList, ROOM_LIST_INTERVAL_MS);
}

function stopRoomListLoop() {
  if (roomListTimer) clearInterval(roomListTimer);
  roomListTimer = null;
}

function renderRoomList(list, { page = 0, pages = 1, total = list.length } = {}) {
  const wrap = $('mpBrowseList');
  const count = $('mpBrowseCount');
  // A szerveré az utolsó szó abban, melyik oldalon vagyunk.
  roomListPage = page;
  const pager = $('mpBrowsePager');
  // Egyetlen oldalnál a lapozó csak zaj lenne.
  pager.classList.toggle('hidden', pages <= 1);
  $('mpBrowsePage').textContent = `${page + 1} / ${pages}`;
  $('mpBrowsePrev').disabled = page <= 0;
  $('mpBrowseNext').disabled = page >= pages - 1;

  if (!list.length) {
    count.textContent = '';
    wrap.innerHTML = `<div class="mp-browse-empty">${t('mp.noPublicRooms')}</div>`;
    return;
  }
  count.textContent = t(total === 1 ? 'mp.roomCountOne' : 'mp.roomCount', { n: total });
  wrap.innerHTML = list.map((room) => {
    const map = G.manifest?.maps.find((entry) => entry.id === room.mapId);
    const tele = room.players >= room.max;
    return '<div class="mp-browse-row">' +
      '<span class="br-main">' +
        `<span class="br-map">${escapeHtml(map?.label || room.mapId)}</span>` +
        `<span class="br-meta">${t('mp.roomLaps', { n: room.laps })}${room.ghostMode ? ' · ghost' : ''}${room.tireWear ? t('mp.roomPit') : ''}</span>` +
      '</span>' +
      `<span class="br-players${tele ? ' is-full' : ''}">${room.players}/${room.max}</span>` +
      `<button class="mp-btn ghost compact br-join" data-code="${escapeHtml(room.code)}">${t('mp.join')}</button>` +
    '</div>';
  }).join('');
}

$('mpBrowseList').addEventListener('click', (e) => {
  const button = e.target.closest('.br-join');
  if (!button) return;
  send(C2S.JOIN_ROOM, { code: button.dataset.code, carId: document.getElementById('carSelect')?.value });
});

let pendingAuthentication = null;

function cancelReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnecting = false;
  reconnectDeadline = 0;
  reconnectAttempt = 0;
}

function disableRemoteContacts() {
  for (const [id, other] of others) {
    other.contactActive = false;
    G.setRemoteCarContact(id, null);
  }
}

function leaveDisconnectedRace({ restoreProfile = false } = {}) {
  cancelReconnect();
  resumeSessionId = null;
  const token = me.token;
  const name = me.name || localStorage.getItem('racing.name') || t('mp.defaultName');
  const wasInGame = G.appState === 'mp';
  clearOtherCars();
  hideMultiplayerResults();
  cancelRaceLoad();
  stopInputLoop();
  awaitingFirstSnapshot = false;
  room = null;
  starting = null;
  G.detachMultiplayerFrame();
  if (wasInGame) G.leaveMultiplayer();
  me = { id: null, name, token };
  show('mpLogin', true);
  show('mpRooms', false);
  show('mpRoom', false);
  if (restoreProfile && token) {
    authenticate(C2S.HELLO, { name: sanitizeName(name), token });
  }
}

function scheduleRaceReconnect() {
  if (!resumeSessionId || loggingOut) return leaveDisconnectedRace();
  const now = performance.now();
  if (!reconnecting) {
    reconnecting = true;
    netDiagnostics.record(NET_DIAG_EVENT.CONNECTION, NET_DIAG_CONNECTION.RECONNECTING);
    reconnectDeadline = now + RECONNECT_GRACE_MS - 750;
    reconnectAttempt = 0;
  }
  if (now >= reconnectDeadline) {
    setErr('A kapcsolat nem állt helyre időben.');
    leaveDisconnectedRace({ restoreProfile: true });
    return;
  }
  if (reconnectTimer) return;
  const delay = Math.min(1_500, 250 * (2 ** Math.min(3, reconnectAttempt++)));
  setErr('Kapcsolat helyreállítása…');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    authenticate(C2S.RESUME_SESSION, { sessionId: resumeSessionId });
  }, delay);
}

const ROOM_STATE_DIAG_CODE = Object.freeze({
  [ROOM_STATE.LOBBY]: 1,
  [ROOM_STATE.LOADING]: 2,
  [ROOM_STATE.COUNTDOWN]: 3,
  [ROOM_STATE.RACING]: 4,
  [ROOM_STATE.FINISHED]: 5,
});

function recordRoomDiagnostic(value) {
  if (!value) return;
  const players = Array.isArray(value.players) ? value.players : [];
  const self = players.find((player) => player.id === me.id);
  netDiagnostics.record(
    NET_DIAG_EVENT.ROOM,
    ROOM_STATE_DIAG_CODE[value.state] || 0,
    players.length,
    players.reduce((count, player) => count + (player.ready ? 1 : 0), 0),
    !!self?.ready,
    value.laps,
    value.mode === GAME_MODE.HOT_LAP ? 2 : 1,
  );
}

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
  netDiagnostics.record(NET_DIAG_EVENT.CONNECTION, NET_DIAG_CONNECTION.CONNECTING);
  socket.addEventListener('open', () => {
    if (ws !== socket) return;
    netDiagnostics.record(NET_DIAG_EVENT.CONNECTION, NET_DIAG_CONNECTION.OPEN);
    if (!reconnecting) setErr('');
    const auth = pendingAuthentication;
    if (auth) send(auth.type, auth.data);
    startPingLoop();
  });
  socket.addEventListener('message', (ev) => {
    if (ws !== socket) return;
    // A feldolgozást késleltetjük, nem a JSON-elemzést — így a szimulátor
    // költsége nem torzítja a mért időt.
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      // A hibás csomag szövegét nem mentjük el: lehet benne felhasználói adat.
      netDiagnostics.record(NET_DIAG_EVENT.SERVER_ERROR, G.appState === 'mp');
      return;
    }
    delayed('down', () => onMessage(m));
  });
  socket.addEventListener('close', (event) => {
    if (ws !== socket) return;
    const wasLoggingOut = loggingOut;
    const connectionWasInRace = G.appState === 'mp' || !!starting;
    netDiagnostics.record(
      NET_DIAG_EVENT.CONNECTION,
      NET_DIAG_CONNECTION.CLOSED,
      Number(event.code) || 0,
    );
    if (!wasLoggingOut && connectionWasInRace) {
      netDiagnostics.captureIncident(NET_DIAG_INCIDENT.CONNECTION_LOST);
    }
    loggingOut = false;
    ws = null;
    stopInputLoop();
    clearPendingSnapshot();
    stopPingLoop();
    if (!wasLoggingOut && connectionWasInRace && resumeSessionId) {
      // A helyi fizika megáll ugyanazon a pózon; a szerver is ezt az utolsó
      // elfogadott állapotot tartja. A távoli kontaktokat azonnal levesszük,
      // hogy a snapshotok nélküli vak időben ne maradjon aktív akadály.
      disableRemoteContacts();
      G.setMultiplayerControlsEnabled(false);
      // Betöltés közben még nem indulhat el az input loop egy közben érkező
      // snapshotra; a beginRace() majd a fizikai világ elkészültekor élesíti.
      awaitingFirstSnapshot = G.appState === 'mp';
      resetNetworkRaceState();
      resetPredState();
      scheduleRaceReconnect();
      return;
    }
    setErr(wasLoggingOut ? '' : 'A kapcsolat megszakadt.');
    leaveDisconnectedRace();
  });
  socket.addEventListener('error', () => {
    if (ws !== socket) return;
    netDiagnostics.record(NET_DIAG_EVENT.CONNECTION, NET_DIAG_CONNECTION.ERROR);
    if (G.appState === 'mp' || starting) {
      netDiagnostics.captureIncident(NET_DIAG_INCIDENT.CONNECTION_LOST);
    }
    if (!reconnecting) setErr(t('mp.connectFailed'));
  });
}

function onMessage(m) {
  // A snapshot állapotminta, ezért több egymás után feltorlódott példányából a
  // legfrissebb elég. Egy külön versenyesemény előtt viszont előbb alkalmazzuk
  // az addig várót: így a WebSocket eredeti sorrendje az összevonás mellett is
  // megmarad (például snapshot -> reset -> snapshot).
  if (m.type !== S2C.SNAPSHOT) flushPendingSnapshot(2);
  switch (m.type) {
    case S2C.WELCOME:
      cancelReconnect();
      pendingAuthentication = null;
      me = { id: m.playerId, name: m.name, token: m.token };
      resumeSessionId = sanitizePlayerToken(m.sessionId) || null;
      localStorage.setItem('racing.token', m.token);
      localStorage.setItem('racing.name', m.name);
      $('mpToken').value = '';
      $('mpWho').textContent = m.name;
      if (!sendPendingHotLap()) {
        show('mpLogin', false); show('mpRooms', true);
        requestRoomList();
      }
      break;

    case S2C.SESSION_RESUMED:
      netDiagnostics.record(NET_DIAG_EVENT.CONNECTION, NET_DIAG_CONNECTION.RESUMED);
      cancelReconnect();
      pendingAuthentication = null;
      me = { id: m.playerId, name: m.name, token: m.token };
      resumeSessionId = sanitizePlayerToken(m.sessionId) || resumeSessionId;
      room = m.room;
      setErr('');
      if (!room) {
        leaveDisconnectedRace({ restoreProfile: true });
        break;
      }
      recordRoomDiagnostic(room);
      const resumedPlayerIds = new Set(room.players?.map((player) => player.id) || []);
      for (const id of [...others.keys()]) {
        if (!resumedPlayerIds.has(id)) removeOtherCar(id);
      }
      for (const other of others.values()) other.buf.length = 0;
      disableRemoteContacts();
      resetNetworkRaceState();
      resetPredState();
      // A szerver a resume-válaszban explicit módon közli, van-e még nyitott
      // reset tranzakció. Ha a RESET kérés nem jutott el hozzá, a helyi flaget
      // biztonságosan feloldjuk; ha a CAR_RESET válasz veszett el, ugyanarra a
      // szerver által birtokolt checkpoint-pózra állunk vissza.
      resetPending = false;
      if (m.pendingReset) {
        const reset = G.resetMultiplayerCar(m.pendingReset);
        netDiagnostics.record(
          NET_DIAG_EVENT.CAR_RESET,
          m.pendingReset.x,
          m.pendingReset.z,
          reset,
        );
        if (reset) {
          resetPredState();
          const resetState = G.getCarState();
          pitPrevPosition = { x: resetState.p[0], z: resetState.p[2] };
        }
      }
      if (Array.isArray(m.results) && m.results.length) {
        showResults(m.results);
      } else {
        if (G.appState === 'mp') {
          // Ha a pályabetöltés pont a kapcsolat nélküli ablakban ért véget, a
          // SET_READY csomag elveszett. A szoba visszhangjából ezt felismerjük
          // és ugyanazzal a kanonikus helyi állapottal megismételjük.
          const self = room.players?.find((player) => player.id === me.id);
          if (self?.ready !== true) {
            const state = G.getCarState();
            const wheels = G.getWheelNetworkState?.() || { st: 0, wr: 0 };
            send(C2S.SET_READY, {
              ready: true,
              state: {
                seq: inputSeq,
                t: serverNow(),
                ...state,
                ...wheels,
                th: 0,
                offtrack: !!G.isCarFullyOffTrack?.(),
              },
            });
          }
          awaitingFirstSnapshot = true;
          G.setMultiplayerControlsEnabled(!finishedDriving && !raceEnded);
        }
      }
      break;

    case S2C.SESSION_RESUME_FAILED:
      setErr('A futamhoz tartozó kapcsolat lejárt.');
      leaveDisconnectedRace({ restoreProfile: true });
      break;

    case S2C.PROFILE_UPDATED:
      me.name = m.name;
      localStorage.setItem('racing.name', m.name);
      $('mpWho').textContent = m.name;
      show('mpRename', false);
      setErr('');
      break;

    case S2C.ROOM_LIST:
      renderRoomList(Array.isArray(m.rooms) ? m.rooms : [], m);
      break;

    case S2C.ROOM_STATE: {
      // Szobán KÍVÜLRŐL érkezett, tehát most léptünk be (vagy most hoztuk
      // létre). Ilyenkor az előző szobáról szóló üzenet ("Kiléptél a
      // szobából.", "A szoba megszűnt.") már nem aktuális, viszont ugyanabban
      // a sávban maradna ott. Csak a belépés pillanatában törlünk, nem minden
      // szobafrissítéskor: ide jönnek a szerver hibaüzenetei is, azokat egy
      // közben beeső roomState (más beállt készre, valaki csatlakozott)
      // különben azonnal letörölné.
      const entered = !room;
      room = m.room;
      recordRoomDiagnostic(room);
      if (entered) setErr('');
      if (room?.mode !== GAME_MODE.HOT_LAP) renderRoom();
      updateResultsActions();
      break;
    }

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
      requestRoomList();
      setErr(serverText(m));
      break;

    case S2C.RACE_STARTING:
      // Ez a "töltsd be" jel: rajtidő még NINCS benne, azt a RACE_COUNTDOWN adja.
      starting = m;
      if (room) {
        room.ghostMode = m.ghostMode === true;
        room.tireWear = m.tireWear === true;
        room.mode = m.mode || room.mode;
      }
      hideMultiplayerResults();
      netDiagnostics.record(
        NET_DIAG_EVENT.RACE,
        NET_DIAG_RACE_STAGE.LOADING,
        0,
        m.laps,
        Array.isArray(m.players) ? m.players.length : 0,
      );
      beginRace(m).catch((err) => {
        // A játékos vagy a kapcsolat közben kilépett, és már másik életciklus
        // az aktuális. Az elkéső régi betöltés nem nyithatja vissza a lobbyt.
        if (err?.name === 'AbortError' || starting !== m) return;
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
        setErr(t('mp.raceLoadFailed') + err.message);
      });
      break;

    case S2C.RACE_COUNTDOWN:
      // Mindenki betöltött (vagy lejárt a türelmi idő): innen számol a 3-2-1.
      if (starting) starting.startsAt = m.startsAt;
      setWaitingPlayersAlert(false);
      netDiagnostics.record(
        NET_DIAG_EVENT.RACE,
        NET_DIAG_RACE_STAGE.COUNTDOWN,
        Number(m.startsAt) - serverNow(),
        room?.laps,
        room?.players?.length,
      );
      // Hot Lapnál ez még csak a felvezető kezdete. A mért kör hiteles
      // kezdőidejét az első rajtvonal-átlépés után a snapshot `ls` mezője adja.
      myLapStartedAt = isHotLap() ? 0 : m.startsAt;
      break;

    case S2C.SNAPSHOT:
      queueSnapshot(m);
      break;

    case S2C.CAR_RESET:
      if (m.playerId === me.id) {
        resetPending = false;
        const reset = G.resetMultiplayerCar(m.respawn || {});
        netDiagnostics.record(
          NET_DIAG_EVENT.CAR_RESET,
          m.respawn?.x,
          m.respawn?.z,
          reset,
        );
        if (reset) resetPredState();
      } else {
        // A távoli reset nem normál mozgásminta. Ha a régi és a checkpointi
        // pózt ugyanabban a pufferben hagynánk, a render interpolálva
        // végighúzná az autót a pályán, a kontakt pedig ezt a hamis utat
        // követné. A következő hiteles snapshot tiszta pufferből indul.
        const other = others.get(m.playerId);
        if (other) {
          other.buf.length = 0;
          other.present = false;
          other.contactActive = false;
          other.group.visible = false;
          G.setRemoteCarContact(m.playerId, null);
        }
      }
      break;

    case S2C.RACE_EVENT:
      // A kilépés nem csak egy HUD-üzenet: a kocsiját is le kell venni a
      // pályáról. Ő nem kap több snapshotot, tehát az utolsó pozícióján
      // megfagyva ott maradna a verseny végéig.
      if (m.kind === 'left') {
        departedPlayerIds.add(m.playerId);
        removeOtherCar(m.playerId);
      }
      if (m.kind === 'validation' && m.playerId === me.id) {
        netDiagnostics.record(NET_DIAG_EVENT.VALIDATION, lapTainted, myLap, myCp);
        netDiagnostics.captureIncident(NET_DIAG_INCIDENT.SERVER_VALIDATION);
        G.showServerValidationAlert?.();
      }
      if (m.kind === 'lap' && m.playerId === me.id) {
        netDiagnostics.record(
          NET_DIAG_EVENT.LAP,
          m.lap,
          m.timeMs,
          !!m.invalid,
          lapTainted,
        );
        myLapTimes.push({ time: m.timeMs, invalid: !!m.invalid });
        if (isHotLap() && myLapTimes.length > 64) {
          myLapTimes.splice(0, myLapTimes.length - 64);
        }
        // A következő kör kezdete nem a csomag megérkezési ideje: nagy
        // pingnél az késő lenne. Az előző hiteles rajtponthoz adjuk hozzá a
        // szerver által mért köridőt, így az Aktuális óra nem ugrik.
        myLapStartedAt = (myLapStartedAt || starting?.startsAt || serverNow()) + m.timeMs;
      }
      if (m.kind === 'lapRetry' && m.playerId === me.id) {
        myLapStartedAt = Number.isFinite(m.startedAt) ? m.startedAt : serverNow();
        lastSeenSplitIndex = -1;
        hideSplitDelta();
      }
      if (m.kind === 'finished' && m.playerId === me.id) {
        finishedDriving = true;
        G.setMultiplayerControlsEnabled(false);
      } else if (m.kind === 'finished') {
        // Az esemény hamarabb érkezhet, mint a következő snapshot. Már itt
        // levesszük az ütközőtestet, hogy a célvonalon álló autó egyetlen
        // további fizikai lépésig se tudja eltalálni a mögötte érkezőt.
        const finished = others.get(m.playerId);
        if (finished) {
          finished.finished = true;
          finished.contactActive = false;
          G.setRemoteCarContact(m.playerId, null);
        }
      }
      if (m.kind !== 'validation' && m.kind !== 'lapRetry') {
        lastEvents.unshift(m);
        lastEvents = lastEvents.slice(0, 4);
      }
      break;

    case S2C.RACE_END:
      netDiagnostics.record(
        NET_DIAG_EVENT.RACE,
        NET_DIAG_RACE_STAGE.ENDED,
        0,
        room?.laps,
        room?.players?.length,
      );
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
        const sentAt = Number(m.t);
        const pongNow = performance.now();
        const loadingSample = raceLoadActive || sentAt < pingValidAfter;
        const stalledHere = lastStallAt > sentAt
          || pongNow - lastHeartbeatAt > STALL_THRESHOLD_MS;
        if (!Number.isFinite(sentAt) || loadingSample || stalledHere || m.blockedMs > SERVER_BLOCK_IGNORE_MS) {
          window.__mp.pingDiscarded++;
          const discardReason = !Number.isFinite(sentAt)
            ? 1
            : loadingSample ? 2 : stalledHere ? 3 : 4;
          netDiagnostics.record(
            NET_DIAG_EVENT.PING_DISCARDED,
            discardReason,
            Number.isFinite(sentAt) ? Math.max(0, pongNow - sentAt) : 0,
            Number(m.blockedMs) || 0,
            loadingSample,
            stalledHere,
          );
          break;
        }
        const rtt = Math.max(0, pongNow - sentAt);
        if (pingNeedsFreshSample) {
          // A betöltés előtti, esetleg már felugrott átlagot az első tiszta minta
          // azonnal leváltja. Különben a régi EWMA még sok másodpercig 900-at
          // mutatna egy már újra 30-40 ms-os kapcsolaton.
          pingRttMs = rtt;
          lastPingRttMs = null;
          pingJitterMs = 0;
          pingNeedsFreshSample = false;
          // A minimum is a friss kapcsolathoz tartozik: egy betöltés előtti,
          // más hálózati helyzetből származó érték itt csak félrevezetne.
          pingMinRttMs = rtt;
        } else {
          if (lastPingRttMs !== null) {
            const delta = Math.abs(rtt - lastPingRttMs);
            pingJitterMs += (delta - pingJitterMs) * 0.25;
          }
          pingRttMs = smoothPing(pingRttMs, rtt);
        }
        lastPingRttMs = rtt;
        // A szerver a PONG elküldése előtti saját idejét adja. Szimmetrikus
        // hálózati úttal a válasz megérkezésekor serverNow + RTT/2 a legjobb
        // becslés; az EWMA kiszűri az egy-egy torlódott mintát.
        pingMinRttMs = updateMinRtt(pingMinRttMs, rtt);
        if (Number.isFinite(m.serverNow)) {
          const sampleOffset = m.serverNow + rtt / 2 - Date.now();
          // Csak a minimum közelébe eső minta frissítheti az órát. Az elsőt
          // muszáj elfogadni, különben sosem indulna el a becslés.
          const usable = !clockReady || acceptsClockSample(rtt, pingMinRttMs);
          if (!clockReady) {
            clockOffsetMs = sampleOffset;
            clockReady = true;
          } else if (usable) {
            clockOffsetMs += (sampleOffset - clockOffsetMs) * 0.1;
          } else {
            clockSamplesDropped++;
          }
        }
        G.setPingMs(pingRttMs);
        netDiagnostics.record(
          NET_DIAG_EVENT.PING,
          rtt,
          pingRttMs,
          pingJitterMs,
          Number(m.blockedMs) || 0,
          clockOffsetMs,
        );
        if (rtt >= 500) netDiagnostics.captureIncident(NET_DIAG_INCIDENT.HIGH_PING);
      }
      break;

    case S2C.ERROR:
      netDiagnostics.record(NET_DIAG_EVENT.SERVER_ERROR, G.appState === 'mp');
      if (m.code === ERR.RACE_START_FAILED && starting) {
        // A szerver visszaállította a szobát lobbyba. A régi beginRace nem
        // futhat tovább a háttérben és nem küldhet SET_READY-t a lobbyra.
        cancelRaceLoad();
        clearOtherCars();
        stopInputLoop();
        awaitingFirstSnapshot = false;
        starting = null;
        G.detachMultiplayerFrame();
        if (G.appState === 'mp') G.leaveMultiplayer();
        openLobby();
      }
      setErr(serverText(m));
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
  $('mpRoomMode').textContent = (room.ghostMode ? t('mp.modeGhost') : t('mp.modeNormal'))
    + (room.tireWear ? t('mp.roomPitLong') : '');
  // Publikus szobába a keresőből ismeretlenek is érkezhetnek — ezt látni kell
  // bent is, ne érje meglepetésként a társaságot.
  $('mpRoomVisibility').textContent = room.isPublic ? t('mp.public') : t('mp.private');
  $('mpPlayers').innerHTML = room.players.map((p) => {
    const car = G.manifest?.cars.find((c) => c.id === p.carId);
    const self = p.id === me.id;
    return `<div class="mp-player${self ? ' is-self' : ''}">` +
      `<span class="dot" style="background:${safeColor(p.color)}"></span>` +
      '<span class="who">' +
        `<span class="nm">${escapeHtml(p.name)}${self ? ' (te)' : ''}</span>` +
        `<span class="car">${escapeHtml(car?.label || p.carId || 'nincs kocsi')}</span>` +
      '</span>' +
      (p.isHost ? `<span class="mp-crown" title="${t('mp.hostTitle')}">👑</span>` : '') +
    '</div>';
  }).join('');
  const isHost = room.hostId === me.id;
  $('mpStart').disabled = !isHost;
  $('mpHint').className = 'mp-note' + (isHost ? ' is-host' : '');
  $('mpHint').textContent = isHost
    ? t('mp.youAreHost')
    : t('mp.waitingForHost');
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
  raceLoadController?.abort();
  const loadController = new AbortController();
  raceLoadController = loadController;
  const { signal } = loadController;
  const loadGeneration = ++raceLoadGeneration;
  departedPlayerIds.clear();
  const myPlayer = info.players.find((player) => player.id === me.id);
  netDiagnostics.setContext({
    mode: info.mode,
    mapId: info.mapId,
    carId: myPlayer?.carId,
  });
  const ghostReplay = info.ghost?.replay?.frames?.length ? info.ghost : null;
  const reuseGhost = !!ghostReplay && !!ghostCar
    && ghostCar.playerId === ghostReplay.playerId
    && ghostCar.carId === ghostReplay.carId
    && ghostCar.timeMs === ghostReplay.timeMs;
  raceLoadActive = true;
  pingNeedsFreshSample = true;
  closeLobby();
  // Az eredménypanel alatt az előző inputciklus szándékosan tovább lépteti a
  // helyi fizikát, hogy a célba ért autó fékezve meg tudjon állni. Új futamnál
  // viszont ezt MÉG a raceEnded visszaállítása előtt le kell állítani.
  // Különben a régi, magas sorszámú inputok a betöltés alatt már az új futamba
  // mennek, és a régi ciklus a nullázott sebességet is újra felülírja. Ettől
  // kapkodott végig a motorhang a fokozatokon a második verseny elején.
  stopInputLoop();
  awaitingFirstSnapshot = false;
  resetPredState();
  // A második futam nem örökölheti az előző célba érési sebességét/fokozatát.
  // Enélkül a nulláról induló új autónál a hang gyorsan végigváltott lefelé,
  // mintha felgyorsított kazettát hallanánk.
  G.resetRaceAudio();
  window.__mp.stage = 'start';
  raceEnded = false;
  finishedDriving = false;
  raceRunningDiagnosticRecorded = false;
  finishDeadlineAt = null;
  resetSpectate();
  resetSplitTracking();
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
  multiplayerStartCrossed = false;
  resetPending = false;
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
  G.resetLiveTireGripTunables();
  G.setMenuStatus(t('mp.loadingRace'));

  // A saját kocsi, a pálya és a többi játékos kocsija — mind egyszerre, EGY
  // fájlméret szerint súlyozott betöltés-sávon, hogy szar neten is látszódjon
  // a haladás ahelyett, hogy percekig néma maradna a képernyő.
  const map = G.manifest.maps.find((m) => m.id === info.mapId);
  localPitConfig = info.pit || map?.pit || null;
  localPitStopIndex = Math.max(0, Math.min(7, myPlayer?.slot ?? 0));
  localPitState = createPitState(
    info.mode !== GAME_MODE.HOT_LAP
      && Number(info.laps) > 1
      && info.tireWear === true
      && hasCompletePitConfig(localPitConfig)
  );
  localTireState = createTireWearState(localPitState.enabled);
  pitPrevPosition = null;
  const car = G.manifest.cars.find((c) => c.id === myPlayer?.carId);
  const otherPlayers = info.players.filter((p) => p.id !== me.id);

  const tasks = [];
  if (G.currentMapId !== info.mapId) {
    tasks.push({
      bytes: map.bytes,
      run: (onP) => G.setTrack(
        G.assetUrl(map), map.id, map.spawns, map.gates, onP,
        map.hotLapSpawn, map.pit, signal
      ),
    });
  }
  if (car) {
    tasks.push({
      bytes: car.bytes,
      run: (onP) => G.setCar(G.assetUrl(car), car.id, car.config, onP, signal),
    });
  }
  otherPlayers.forEach((p) => {
    const otherCar = G.manifest.cars.find((c) => c.id === p.carId) || G.manifest.cars[0];
    tasks.push({
      bytes: otherCar?.remoteBytes ?? otherCar?.bytes,
      run: (onP) => addOtherCar(p, onP, loadGeneration, signal),
    });
  });
  if (ghostReplay && !reuseGhost) {
    const replayCar = G.manifest.cars.find((c) => c.id === ghostReplay.carId) || G.manifest.cars[0];
    tasks.push({
      bytes: replayCar?.remoteBytes ?? replayCar?.bytes,
      run: (onP) => addGhostCar(ghostReplay, onP, loadGeneration, signal),
    });
  }

  G.showLoadingOverlay(true);
  try {
    await G.runLoadTasks(tasks);
    if (signal.aborted || loadGeneration !== raceLoadGeneration) return;
    // A compileAsync a shaderprogramokat elkészíti, de a GLB vertex/index
    // buffereit csak egy valódi draw tölti fel a GPU-ra. Az új ellenfélmodellek
    // normál és egyszerűsített változatát is itt rajzoljuk először, még a
    // loading overlay alatt. Így sem az első megjelenésük, sem a terhelés alatti
    // első minőségváltás nem fordul verseny közbeni shader/buffer-akadásba.
    const visualsToWarm = [...others.values()].map((entry) => entry.group);
    if (ghostReplay && !reuseGhost && ghostCar) visualsToWarm.push(ghostCar.group);
    await warmCarVisuals(visualsToWarm);
    if (ghostReplay) ghostSplits();
  } finally {
    if (loadGeneration === raceLoadGeneration) G.hideLoadingOverlay();
  }
  if (signal.aborted || loadGeneration !== raceLoadGeneration) return;
  window.__mp.stage = 'kocsi-kesz';
  // strict: multiplayerben a pálya ütközési hálója KÖTELEZŐEN a bekészített
  // fájlból jön. Ha nem tölthető le, itt hibával elhasal — jobb, mint némán
  // rossz geometrián versenyezni (ettől
  // lebegett a kocsi a pálya fölött).
  await G.prepareTrackPhysics({ strict: true, signal });
  if (signal.aborted || loadGeneration !== raceLoadGeneration) return;
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
  const placedState = G.getCarState();
  pitPrevPosition = { x: placedState.p[0], z: placedState.p[2] };
  G.setPitStopMarker(localPitConfig?.stops?.[localPitStopIndex], false);
  G.renderPitStopHud(localPitState, localPitStopIndex, localTireState);
  G.enterMultiplayer(frame);
  raceLoadActive = false;
  if (raceLoadController === loadController) raceLoadController = null;
  pingValidAfter = performance.now();
  window.__mp.stage = 'fut';
  netDiagnostics.record(
    NET_DIAG_EVENT.RACE,
    NET_DIAG_RACE_STAGE.READY,
    0,
    info.laps,
    info.players.length,
  );
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
      seq: inputSeq,
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
  G.clearRemoteCarContacts();
  // A frame() innentől akár le is állhat (menübe lépés, szoba bezárása), tehát
  // a visszaszámlálót nem bízhatjuk rá — itt vesszük le, ahol minden bontási
  // útvonal áthalad.
  finishDeadlineAt = null;
  hideFinishTimer();
  resetSpectate();
  resetSplitTracking();
  // A modellek és fizikai kontaktok mellett a minitérképes lenyomatuk is ugyanennek
  // az állapotnak a része. A játék közbeni „Vissza a menübe” közvetlenül az
  // enterMenu() cleanup hookján halad át, nem feltétlenül a leaveMultiplayer()-en,
  // ezért az ottani külön nullázás ezt az útvonalat nem fedte le.
  G.setMiniMapMarkers([], null);
  localPitConfig = null;
  localPitState = createPitState(false);
  localTireState = createTireWearState(false);
  pitPrevPosition = null;
  G.setPitStopMarker(null, false);
  G.renderPitStopHud(localPitState, 0, localTireState);
  G.setTireCondition(null);
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
  G.removeRemoteCarContact(playerId);
  others.delete(playerId);
}

function cleanupMultiplayerForMenu() {
  const wasActive = G.appState === 'mp' || inputLoopActive || awaitingFirstSnapshot || raceLoadActive;
  cancelRaceLoad();
  stopInputLoop();
  awaitingFirstSnapshot = false;
  resetPredState();
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
  raceLoadController?.abort();
  raceLoadController = null;
  raceLoadGeneration++;
  raceLoadActive = false;
  pingValidAfter = performance.now();
  pingNeedsFreshSample = false;
  setWaitingPlayersAlert(false);
  G.hideLoadingOverlay();
}

async function addOtherCar(p, onProgress, loadGeneration, signal) {
  const car = G.manifest.cars.find((c) => c.id === p.carId) || G.manifest.cars[0];
  const group = await loadRemoteCarVisual(car, p.color, onProgress, false, signal);
  // Névtábla a kocsi fölött, a játékos színével keretezve — ugyanaz a szín,
  // ami a HUD-listán és a minitérképen is jelöli őt.
  const label = makeNameSprite(p.name, p.color);
  label.position.y = 1.8;
  label.visible = false;
  group.add(label);

  // A modell letöltése közben megszakadhatott a kapcsolat vagy a játékos
  // visszaléphetett a menübe. A késve elkészült objektum ilyenkor nem kerülhet
  // vissza ghostként a jelenetbe.
  if (signal?.aborted || loadGeneration !== raceLoadGeneration || departedPlayerIds.has(p.id)) {
    G.disposeObject3D(group);
    return;
  }
  // Rejtve születik: a helyét az első valódi állapotból kapja meg (frame()).
  // Enélkül egy képkockányit a világ origójában villanna, mert a csoport
  // alapból oda kerül.
  group.visible = false;
  G.scene.add(group);
  others.set(p.id, {
    group, label, wheelRig: group.userData.wheelRig || { pivots: [], sources: [] },
    engineAudio: G.createRemoteEngine(), buf: [], color: p.color, name: p.name, lap: 0, cp: 0,
    rank: 0, gap: null, bestLap: null, lastLap: null, lastLapInvalid: false, finished: false,
    tireState: null,
    detailPhase: remoteDetailPhase(p.id), audioDt: 0, visualSteerAngle: 0,
    visualMotion: createVisualMotionTracker(),
    contactActive: false,
  });
}

async function loadRemoteCarVisual(car, fallbackColor, onProgress, translucent = false, signal) {
  const group = new THREE.Group();
  try {
    const gltf = await G.loadGLTF(G.assetUrl(car, true), onProgress, signal);
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
          // A compressed ghoston visszatérhet a sima, szemcsézés nélküli
          // alfa-keverés. A mélységírás megfogja a belső karosszériaelemek
          // felesleges egymásra rajzolását, a forceSinglePass pedig megakadályozza,
          // hogy a kétoldalas, áttetsző anyagokat a Three.js két menetben rajzolja.
          clone.transparent = true;
          clone.alphaHash = false;
          clone.opacity = 0.34;
          clone.depthWrite = true;
          clone.forceSinglePass = true;
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
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) throw error;
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

async function warmCarVisuals(groups) {
  const visuals = groups.filter(Boolean);
  if (!visuals.length) return;
  // A rejtett távoli autókat a renderer az első valódi megjelenésükig nem
  // készítené elő. A régi 1x1 pixeles, kamerán kívüli draw ugyan létrehozta a
  // programokat, de a driver a valódi textúramintavételt és a GPU-s munkát
  // továbbra is az első látható képkockára halaszthatta. Két mérésben ekkor
  // 640, majd 247/226/144 ms-os rendermegállás jelent meg.
  //
  // Külön jelenetben, tényleges 256x256-os célra, két oldalról rajzoljuk ki a
  // valódi ellenfélmodellt. A finish() szándékosan blokkol — de még a
  // loading overlay alatt —, így ez a költség nem verseny közben jelentkezik.
  const textures = new Set();
  visuals.forEach((group) => {
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
  });
  textures.forEach((texture) => G.renderer.initTexture(texture));

  const renderer = G.renderer;
  const warmTarget = new THREE.WebGLRenderTarget(256, 256, {
    depthBuffer: true,
    stencilBuffer: false,
  });
  warmTarget.texture.generateMipmaps = false;
  const warmScene = new THREE.Scene();
  warmScene.fog = G.scene.fog;
  warmScene.environment = G.scene.environment;
  const warmCamera = new THREE.PerspectiveCamera(42, 1, 0.1, 50);
  warmCamera.position.set(0, 2.2, 8);
  warmCamera.lookAt(0, 0.5, 0);

  // Ugyanazok a fénytípusok és árnyék-shader variánsok készüljenek el, mint a
  // valódi jelenetben. A pályát viszont nem tesszük a warm scene-be, ezért a
  // 256x256-os draw költsége kizárólag az aktuális ellenfélmodelleké.
  G.scene.traverse((object) => {
    if (!object.isLight) return;
    const light = object.clone();
    warmScene.add(light);
    if (light.target && !light.target.parent) warmScene.add(light.target);
  });

  const previousTarget = renderer.getRenderTarget();
  const previousCubeFace = renderer.getActiveCubeFace();
  const previousMipmapLevel = renderer.getActiveMipmapLevel();
  const previousShadowAutoUpdate = renderer.shadowMap.autoUpdate;
  const previousShadowNeedsUpdate = renderer.shadowMap.needsUpdate;
  const visualStates = visuals.map((group) => ({
    group,
    groupVisible: group.visible,
    parent: group.parent,
    parentIndex: group.parent?.children.indexOf(group) ?? -1,
    position: group.position.clone(),
    quaternion: group.quaternion.clone(),
    scale: group.scale.clone(),
  }));
  const frustumStates = [];
  visuals.forEach((group) => {
    group.traverse((object) => {
      if (!(object.isMesh || object.isLine || object.isPoints || object.isSprite)) return;
      frustumStates.push([object, object.frustumCulled]);
      // Betöltéskor még az origóban vannak, amely az aktuális kamera
      // látómezején kívül eshet. A warm-up draw így is érjen el mindent.
      object.frustumCulled = false;
    });
  });

  try {
    visualStates.forEach(({ group }) => {
      warmScene.add(group);
      group.visible = false;
      group.position.set(0, 0, 0);
      group.quaternion.identity();
      group.scale.set(1, 1, 1);
      group.updateMatrixWorld(true);
    });
    // Az árnyékprogramok a castShadow fényekből így is elkészülnek, magát az
    // árnyéktérképet viszont nem kell négyszer újrarajzolni modellenként.
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = false;
    for (const group of visuals) {
      group.visible = true;
      if (typeof renderer.compileAsync === 'function') {
        await renderer.compileAsync(warmScene, warmCamera);
      } else {
        renderer.compile(warmScene, warmCamera);
      }
      for (const z of [8, -8]) {
        warmCamera.position.set(0, 2.2, z);
        warmCamera.lookAt(0, 0.5, 0);
        renderer.setRenderTarget(warmTarget);
        renderer.clear();
        renderer.render(warmScene, warmCamera);
        renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmapLevel);
      }
      group.visible = false;
    }
    // Az initTexture és az összes draw ténylegesen érjen le a GPU-ig, mielőtt
    // eltűnik a töltőképernyő.
    const gl = renderer.getContext();
    if (!gl.isContextLost()) gl.finish();
  } finally {
    renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmapLevel);
    renderer.shadowMap.autoUpdate = previousShadowAutoUpdate;
    renderer.shadowMap.needsUpdate = previousShadowNeedsUpdate;
    visualStates.forEach(({
      group, groupVisible, parent, parentIndex, position, quaternion, scale,
    }) => {
      (parent || G.scene).add(group);
      if (parent && parentIndex >= 0) {
        const currentIndex = parent.children.indexOf(group);
        parent.children.splice(currentIndex, 1);
        parent.children.splice(Math.min(parentIndex, parent.children.length), 0, group);
      }
      group.position.copy(position);
      group.quaternion.copy(quaternion);
      group.scale.copy(scale);
      group.visible = groupVisible;
      group.updateMatrixWorld(true);
    });
    frustumStates.forEach(([object, frustumCulled]) => {
      object.frustumCulled = frustumCulled;
    });
    warmTarget.dispose();
    warmScene.clear();
  }
}

async function addGhostCar(ghost, onProgress, loadGeneration, signal) {
  const car = G.manifest.cars.find((c) => c.id === ghost.carId) || G.manifest.cars[0];
  const group = await loadRemoteCarVisual(car, '#75d7ff', onProgress, true, signal);
  if (signal?.aborted || loadGeneration !== raceLoadGeneration) {
    G.disposeObject3D(group);
    return;
  }
  group.visible = false;
  G.scene.add(group);
  ghostCar = {
    group,
    playerId: ghost.playerId,
    carId: ghost.carId,
    frames: ghost.replay.frames,
    index: 0,
    name: ghost.name || 'Szellem',
    timeMs: ghost.timeMs,
    // A checkpoint-részidők NEM itt készülnek: a szellem a pályával
    // párhuzamosan töltődik (runLoadTasks: Promise.all), tehát itt még nem
    // biztos, hogy állnak a kapuk. A beginRace az összes task után számolja ki.
    splits: null,
    splitsMapId: null,
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
// A transit-minták csúszóablaka. Ebből jön a célmélység — nem a szomszédos
// csomagok különbségéből, lásd a shared/renderClock.js indoklását.
const transitSamples = [];
// A távoli idővonal MEGVALÓSULT késleltetése. Nem ez vezérel: ez a renderóra
// állásából adódik, és a diagnosztika meg a képi simító olvassa.
let interpDelayMs = MIN_INTERP_DELAY_MS;
let interpRenderAt = NaN;
let interpUpdatedAt = 0;
let interpPlaybackRate = 1;
// Csak diagnosztikához (lásd __mp.lastSelf) — a feldolgozás nem használja.
let lastSnapshot = null;
let pendingSnapshot = null;
let pendingSnapshotCount = 0;
let pendingSnapshotFirstAt = 0;
let pendingSnapshotLastAt = 0;
let pendingSnapshotTransitMs = 0;
let pendingSnapshotTransitTrusted = true;

function clearPendingSnapshot() {
  pendingSnapshot = null;
  pendingSnapshotCount = 0;
  pendingSnapshotFirstAt = 0;
  pendingSnapshotLastAt = 0;
  pendingSnapshotTransitMs = 0;
  pendingSnapshotTransitTrusted = true;
}

function queueSnapshot(snapshot) {
  const now = performance.now();
  // Ugyanaz a versenyhelyzet, mint a PONG-nál: lehet, hogy ez a message callback
  // fut le előbb, és a sűrű stall-figyelő csak utána. Itt helyben is felismerjük
  // a késő heartbeatet, majd a köteg minden tagját megjelöljük szennyezettként.
  const heartbeatLate = lastHeartbeatAt > 0
    && now - lastHeartbeatAt > STALL_THRESHOLD_MS;
  if (heartbeatLate) lastStallAt = now;
  const transitTrusted = !heartbeatLate && !(
    lastStallAt > 0 && now - lastStallAt <= STALL_TRANSIT_GRACE_MS
  );
  window.__mp.snaps++;
  if (!pendingSnapshot) {
    pendingSnapshotFirstAt = now;
    pendingSnapshotCount = 1;
  } else {
    pendingSnapshotCount++;
  }
  pendingSnapshot = snapshot;
  pendingSnapshotLastAt = now;
  // A hálózati érkezési időt MOST mérjük, nem a következő képkockás
  // feldolgozáskor. Különben a 0–16 ms-os render-várakozást hamisan hálózati
  // jitternek nézné az adaptív interpolációs puffer.
  pendingSnapshotTransitMs = Math.max(0, serverNow() - snapshot.t);
  pendingSnapshotTransitTrusted = transitTrusted;
}

function flushPendingSnapshot(reasonCode) {
  if (!pendingSnapshot) return false;
  const snapshot = pendingSnapshot;
  const count = pendingSnapshotCount;
  const firstAt = pendingSnapshotFirstAt;
  const lastAt = pendingSnapshotLastAt;
  const transitMs = pendingSnapshotTransitMs;
  const transitTrusted = pendingSnapshotTransitTrusted;
  clearPendingSnapshot();
  window.__mp.snapshotsApplied++;
  netDiagnostics.record(
    NET_DIAG_EVENT.SNAPSHOT_QUEUE,
    count,
    Math.max(0, count - 1),
    Math.max(0, performance.now() - firstAt),
    Math.max(0, lastAt - firstAt),
    reasonCode,
  );
  onSnapshot(snapshot, transitMs, lastAt, transitTrusted);
  return true;
}

function resetNetworkRaceState() {
  clearPendingSnapshot();
  transitSamples.length = 0;
  interpDelayMs = MIN_INTERP_DELAY_MS;
  interpRenderAt = NaN;
  interpUpdatedAt = 0;
  interpPlaybackRate = 1;
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
// A fizika fix 60 Hz-en lép (a képkocka eleji fix lépéses hurokban), a képernyő viszont a saját
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
// A késleltetés alapból két tick. Ha a főszál terhelése miatt a setTimeout
// rendszeresen késik, fokozatosan legfeljebb hat tickre nő; amikor a terhelés
// elmúlik, lassan visszaáll. Így nem a puffer legutolsó elemén megakadva várjuk
// a következő fizikai lépést.
const predBuf = [];
let physSteps = 0;   // diagnosztikához: hány fizikai lépés történt eddig
let predDelayMs = LOCAL_RENDER_DELAY_MIN_MS;
let predDelayTargetMs = LOCAL_RENDER_DELAY_MIN_MS;
let predDelayUpdatedAt = 0;
let predRenderAt = NaN;
let predSampleAt = NaN;
let predPlaybackRate = 1;
let physicsTimerLatenessMs = 0;
let physicsTimerJitterMs = 0;
let contactTimingTotalMs = 0;
let contactTimingMaxMs = 0;
let physicsTimingTotalMs = 0;
let physicsTimingMaxMs = 0;
let pipelineTimingSteps = 0;
let localBufferStarvedMaxMs = 0;
let localBufferHeadroomMs = 0;
let inputTickGapMaxMs = 0;
let lastInputTickAt = 0;

function resetPipelineTimings() {
  contactTimingTotalMs = 0;
  contactTimingMaxMs = 0;
  physicsTimingTotalMs = 0;
  physicsTimingMaxMs = 0;
  pipelineTimingSteps = 0;
}

function observePipelineTimings(contactMs, physicsMs) {
  contactTimingTotalMs += contactMs;
  contactTimingMaxMs = Math.max(contactTimingMaxMs, contactMs);
  physicsTimingTotalMs += physicsMs;
  physicsTimingMaxMs = Math.max(physicsTimingMaxMs, physicsMs);
  pipelineTimingSteps++;
}

// A képkocka-diagnosztika 250 ms-onként fogyasztja el. Így nem írunk 120 új
// eseményt másodpercenként, de az átlag és a csúcs külön megmarad.
function takePipelineTimings() {
  const count = pipelineTimingSteps;
  const sample = {
    contactAvgMs: count ? contactTimingTotalMs / count : 0,
    contactMaxMs: contactTimingMaxMs,
    physicsAvgMs: count ? physicsTimingTotalMs / count : 0,
    physicsMaxMs: physicsTimingMaxMs,
  };
  resetPipelineTimings();
  return sample;
}

function takeLocalPlaybackDiagnostics() {
  const sample = {
    bufferStarvedMaxMs: localBufferStarvedMaxMs,
    bufferHeadroomMs: localBufferHeadroomMs,
    inputTickGapMaxMs,
    predictionBufferSamples: predBuf.length,
  };
  localBufferStarvedMaxMs = 0;
  inputTickGapMaxMs = 0;
  return sample;
}

function resetPredState() {
  predBuf.length = 0;
  predDelayMs = LOCAL_RENDER_DELAY_MIN_MS;
  predDelayTargetMs = LOCAL_RENDER_DELAY_MIN_MS;
  predDelayUpdatedAt = performance.now();
  predRenderAt = NaN;
  predSampleAt = NaN;
  predPlaybackRate = 1;
  physicsTimerLatenessMs = 0;
  physicsTimerJitterMs = 0;
  localBufferStarvedMaxMs = 0;
  localBufferHeadroomMs = 0;
  inputTickGapMaxMs = 0;
  lastInputTickAt = 0;
  resetPipelineTimings();
}

function observePhysicsTimer(latenessMs) {
  const sample = Math.max(0, Math.min(250, latenessMs));
  const deviation = Math.abs(sample - physicsTimerLatenessMs);
  physicsTimerLatenessMs += (sample - physicsTimerLatenessMs) * 0.12;
  physicsTimerJitterMs += (deviation - physicsTimerJitterMs) * 0.12;
  predDelayTargetMs = localRenderDelayTarget(physicsTimerLatenessMs, physicsTimerJitterMs);
}

// A `t` a lépés ÜTEMEZETT ideje (egyenletesen TICK_MS-enként), nem az, amikor
// a böngésző ténylegesen odaért. A kettő rendszeresen eltér, és a kirajzolás
// az idő szerint interpolál — tehát az egyenletes időbélyeg a lényeg.
function pushPredState(state, t) {
  predBuf.push({ t, p: [...state.p], q: [...state.q] });
  // Negyed másodpercnyi múlt bőven elég a késleltetett mintavételhez.
  while (predBuf.length > 20) predBuf.shift();
}

function shiftPredictionTimeline(deltaMs) {
  if (!(deltaMs > 0)) return;
  for (let i = 0; i < predBuf.length; i++) predBuf[i].t += deltaMs;
}

function recordPhysState(scheduledAt, state = G.getCarState()) {
  pushPredState(state, scheduledAt ?? performance.now());
  physSteps++;
}

function interpolatedPhys(now = performance.now()) {
  if (!predBuf.length) {
    localBufferHeadroomMs = 0;
    predSampleAt = now;
    return G.getCarState();
  }
  const clock = advanceRenderClock({
    renderAtMs: predRenderAt,
    previousNowMs: predDelayUpdatedAt,
    nowMs: now,
    targetDelayMs: predDelayTargetMs,
    playbackRate: predPlaybackRate,
    // A saját kocsinál a lassítás input-késleltetés, amit a kezed érez: szűk
    // tűrés, és a puffer tartománya is kicsi (33–100 ms).
    rateMin: LOCAL_CLOCK_RATE_MIN,
    rateMax: LOCAL_CLOCK_RATE_MAX,
    minDelayMs: LOCAL_RENDER_DELAY_MIN_MS,
    maxDelayMs: LOCAL_RENDER_DELAY_MAX_MS,
  });
  predDelayUpdatedAt = now;
  predRenderAt = clock.at;
  predPlaybackRate = clock.rate;
  predDelayMs = Math.max(0, now - predRenderAt);
  const at = predRenderAt;
  const newest = predBuf[predBuf.length - 1];
  localBufferHeadroomMs = newest.t - at;
  localBufferStarvedMaxMs = Math.max(
    localBufferStarvedMaxMs,
    Math.max(0, -localBufferHeadroomMs),
  );
  for (let i = predBuf.length - 1; i > 0; i--) {
    const a = predBuf[i - 1], b = predBuf[i];
    if (a.t <= at && at <= b.t) {
      const span = b.t - a.t;
      const f = span > 0 ? (at - a.t) / span : 0;
      predSampleAt = at;
      return {
        p: [a.p[0] + (b.p[0] - a.p[0]) * f, a.p[1] + (b.p[1] - a.p[1]) * f, a.p[2] + (b.p[2] - a.p[2]) * f],
        q: slerp(a.q, b.q, f),
      };
    }
  }
  // A kért idő a puffer előtt/után van (indulás, vagy megakadt a fizika) —
  // ilyenkor a legközelebbi ismert állapot a legjobb tipp.
  const nearest = at < predBuf[0].t ? predBuf[0] : predBuf[predBuf.length - 1];
  predSampleAt = nearest.t;
  return nearest;
}

// A visszaszámlálás alatt befagyasztjuk a helyi kocsit.
// Áll-e még a kocsi (befékezve). Ha a rajtidőt még nem tudjuk, akkor IGEN: a
// a versenyvezérlő a betöltésre vár.
function isFrozen() {
  return !starting?.startsAt || serverNow() < starting.startsAt;
}

function onSnapshot(
  m,
  receivedTransitMs = Math.max(0, serverNow() - m.t),
  receivedAt = performance.now(),
  transitTrusted = true,
) {
  lastSnapshot = m;
  // Mikor zárul le magától a futam (szerver-óra). Minden snapshot hozza, tehát
  // egy elveszett csomag után is helyreáll.
  finishDeadlineAt = Number.isFinite(m.fd) ? m.fd : null;
  const transit = receivedTransitMs;
  // A snapshot csak MINTÁT ad; a késleltetést nem itt állítjuk be, hanem a
  // renderóra közelíti hozzá képkockánként (lásd frame()). Enélkül a
  // kirajzolt pillanat egyetlen csomag hatására ugorhatna vissza.
  if (transitTrusted) {
    pushTransitSample(transitSamples, transit, receivedAt);
  } else {
    window.__mp.snapshotTransitDropped++;
  }

  const startAfterSnapshot = awaitingFirstSnapshot;
  awaitingFirstSnapshot = false;
  let selfDiagnosticCar = null;
  let selfDiagnosticState = null;
  for (const c of m.cars) {
    const entry = c.id === me.id ? null : others.get(c.id);
    // Amíg a játékos tölt, a szerver csak egy rajtrács-helyfoglalót küld róla,
    // magasság nélkül (`rd: false`). Ezt NEM tesszük a pufferbe: nemcsak
    // kirajzolni nem akarjuk, de a puffer az interpolációt és a fizikai kontaktot
    // is hajtja. Ha benne lenne, betöltéskor a helyfoglaló és az első valódi
    // állapot KÖZÖTT interpolálnánk — vagyis a kocsi ugyanúgy előbukkanna a
    // talaj alól, csak rövidebben —, ütközni pedig egy ott sem lévő autóval
    // lehetne. A régi szerver nem küld `rd`-t; annak a hiánya jelenlétet jelent.
    const present = c.rd !== false;
    if (entry) entry.present = present;
    const buf = present ? entry?.buf : null;
    if (buf) {
      const previous = buf[buf.length - 1];
      const sample = remoteSnapshotSample(previous, c, m.t);
      // A snapshot 20 Hz-es, az autóállapot viszont csak akkor új, ha a
      // szerver ténylegesen elfogadott hozzá új csomagot. A régi kód minden
      // snapshot globális `m.t` idejével újramintázta ugyanazt a pozíciót:
      // ettől a stale autó frissnek látszott, az extrapoláció újra és újra
      // nekifutott, a fizikai kontakt pedig soha nem évült el.
      //
      // Az azonos seq melletti újabb autónkénti idő egy szerveres reset lehet,
      // ezért azt az új protokollban elfogadjuk. Régi szervernél (nincs `at`)
      // kizárólag a sorszám növekedése jelent új mintát.
      if (sample.isNew) {
        buf.push({
          t: sample.stateTime, p: c.p, q: c.q, v: c.v, w: c.w,
          st: c.st ?? 0, wr: c.wr ?? 0, th: c.th, seq: sample.sequence, lap: c.lap,
        });
      }
      // Az adaptív puffer nagy pingnél 400 ms-ig nőhet; két másodpercnyi múlt
      // elég hozzá és a kontaktok jelenre történő extrapolációjához is.
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
      const remoteWear = Number(c.tw?.w);
      entry.tireState = Number.isFinite(remoteWear)
        ? { enabled: true, wear: Math.max(0, Math.min(1, remoteWear / 1000)) }
        : null;
      entry.finished = !!c.fin;
      if (entry.finished) {
        entry.contactActive = false;
        G.setRemoteCarContact(c.id, null);
      }
    }
    if (c.id === me.id) {
      selfDiagnosticCar = c;
      if (Number.isFinite(c.ls)) multiplayerStartCrossed = true;
      // Nézői módban a nézett kocsié megy a kijelzőre (lásd frame()), a
      // sajátunké nem írhatja felül.
      if (!spectateId) {
        const speedState = G.getCarState();
        selfDiagnosticState = speedState;
        G.setSpeed(Math.hypot(speedState.v[0], speedState.v[2]) * 3.6);
      }
      // Körváltáskor ugyanaz a checkpoint-index újra feldolgozható. A
      // referencia-részidőt a szerver a legjobb érvényes körből küldi.
      if (c.lap > myLap) {
        lastSeenSplitIndex = -1;
      } else if (c.lap < myLap) {
        // Visszafelé csak újrakezdéskor (R az Időmérésben) léphet a körszám.
        // Ilyenkor az addigi részidők nem tartoznak az új próbálkozáshoz.
        resetSplitTracking();
      }
      trackSplit(c.ci, c.ct, c.bt);
      myLap = c.lap;
      myCp = c.cp ?? 0;
      myRank = c.rk ?? 1;
      myGap = c.gap ?? 0;
      myBestLap = c.best ?? null;
      myLastLap = c.last ?? null;
      myLastLapInvalid = !!c.li;
      myFinished = !!c.fin;
      const serverPitChanges = Math.max(0, Math.trunc(Number(c.ps) || 0));
      if (serverPitChanges >= localPitState.changeCount) {
        localPitState.changeCount = serverPitChanges;
        localPitState.servicedThisVisit = !!c.pv;
      }
      if (!localPitState.servicedThisVisit && Number.isFinite(c.pt)) {
        localPitState.stopElapsedMs = Math.max(localPitState.stopElapsedMs, c.pt);
      }
      syncTireWearSnapshot(localTireState, c.tw);
      G.setPitStopMarker(
        localPitConfig?.stops?.[localPitStopIndex],
        localPitState.enabled && localPitState.inLane
      );
      G.renderPitStopHud(localPitState, localPitStopIndex, localTireState);
      if (isHotLap()) {
        // A szerver az egyetlen hiteles időmérő: null a felvezetőn, majd az
        // átlépés szimulációs időpontja. Így nagy pingnél sem a csomag
        // megérkezése indítja késve az órát vagy a szellemet.
        myLapStartedAt = Number.isFinite(c.ls) ? c.ls : 0;
      }
      lapTainted = c.ti || TAINT.NONE;
    }
  }
  if (selfDiagnosticCar) {
    selfDiagnosticState ||= G.getCarState();
    const echoX = Number(selfDiagnosticCar.p?.[0]);
    const echoZ = Number(selfDiagnosticCar.p?.[2]);
    const echoDistance = Number.isFinite(echoX) && Number.isFinite(echoZ)
      ? Math.hypot(selfDiagnosticState.p[0] - echoX, selfDiagnosticState.p[2] - echoZ)
      : 0;
    netDiagnostics.record(
      NET_DIAG_EVENT.SNAPSHOT_IN,
      transit,
      transitSpreadMs(transitSamples),
      interpDelayMs,
      selfDiagnosticCar.seq,
      selfDiagnosticCar.rd !== false,
      m.cars.length,
      echoDistance,
      ws?.bufferedAmount || 0,
    );
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

const REMOTE_CONTACT_RANGE = 60;
const REMOTE_CONTACT_RANGE_SQ = REMOTE_CONTACT_RANGE * REMOTE_CONTACT_RANGE;
const REMOTE_CONTACT_EXIT_RANGE = 75;
const REMOTE_CONTACT_EXIT_RANGE_SQ = REMOTE_CONTACT_EXIT_RANGE * REMOTE_CONTACT_EXIT_RANGE;
// A játékosnév közelről segít azonosítani az ellenfelet, távolról viszont
// csak teleszórja a pályát és könnyen elárulna egy épület mögötti autót.
// 38 métertől halványul, 50 méternél teljesen eltűnik; a Sprite depthTestje
// ezen belül is gondoskodik róla, hogy falon/épületen ne rajzolódjon át.
const PLAYER_LABEL_FADE_START = 38;
const PLAYER_LABEL_MAX_RANGE = 50;
const PLAYER_LABEL_MAX_RANGE_SQ = PLAYER_LABEL_MAX_RANGE * PLAYER_LABEL_MAX_RANGE;
// A kép tovább maradhat látható egy rövid csomagkimaradás alatt, mint ameddig
// biztonságos fizikai kontaktot számolni belőle. A kontakt külön, 300 ms-os
// határát a közös carContact szabálya adja.
const REMOTE_VISUAL_MAX_AGE_MS = 750;
const REMOTE_EXTRAP_MAX_MS = 250;
// Egy állapotcsomag ~210 bájt; nagyjából öt csomagnyi sor 30 Hz-en ~160 ms
// elmaradás. Efölött a régi állapotokat nem küldjük el — lásd sendOneInput().
const STATE_BACKLOG_LIMIT_BYTES = 1000;
let statesDropped = 0;
let lastContactSyncDiagnosticAt = -Infinity;
// A pálya köde 700 méternél már 5% alá csökkenti a kontrasztot. A teljes,
// több százezer háromszöges autómodellt ott már nem érdemes kirajzolni. A
// minitérképes jel megmarad, és spectate-ben a kocsi mindig kivétel.
const REMOTE_RENDER_MAX_RANGE = 700;
const REMOTE_RENDER_MAX_RANGE_SQ = REMOTE_RENDER_MAX_RANGE * REMOTE_RENDER_MAX_RANGE;
const REMOTE_AUDIO_MAX_RANGE = 125;
let remoteDetailFrame = 0;

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
  const timing = remoteExtrapolationTiming(latest.t, targetServerTime, REMOTE_EXTRAP_MAX_MS);
  const dt = timing.ageMs / 1000;
  const v = latest.v || [0, 0, 0];
  const w = latest.w || [0, 0, 0];
  return {
    p: [latest.p[0] + v[0] * dt, latest.p[1] + v[1] * dt, latest.p[2] + v[2] * dt],
    q: integrateRotation(latest.q, w, dt),
    // A 250 ms-os becslési határ után a POZÍCIÓ már nem mozoghat tovább.
    // Ilyenkor a sebességet is nullázzuk, hogy a kontaktmegoldó se kezelje
    // tovább mozgó akadályként a már bizonytalanná vált hálózati állapotot.
    v: timing.moving ? v : [0, 0, 0],
    w: timing.moving ? w : [0, 0, 0],
    st: latest.st ?? 0,
    wr: latest.wr ?? 0,
    th: latest.th ?? 0,
  };
}

// A kontaktpózok időpontja az adott helyi fizikai lépés szerverórára
// átszámolt ideje. A távoli póz csak bemenet: a kontakt soha nem írja vissza.
function syncRemoteContacts(targetServerTime) {
  // Ghost módban nincs autó–autó kontakt.
  if (starting?.ghostMode === true || room?.ghostMode === true) return;
  const mine = G.getCarState().p;
  const now = serverNow();
  let activeCount = 0;
  let staleCount = 0;
  let maxStateAgeMs = 0;
  let maxStateStepM = 0;
  let maxSequenceGap = 0;
  for (const [id, o] of others) {
    if (o.finished) {
      o.contactActive = false;
      G.setRemoteCarContact(id, null);
      continue;
    }
    const latest = o.buf[o.buf.length - 1];
    const state = remoteStateAt(o.buf, targetServerTime);
    const stateAgeMs = latest ? Math.max(0, now - latest.t) : Infinity;
    if (Number.isFinite(stateAgeMs)) maxStateAgeMs = Math.max(maxStateAgeMs, stateAgeMs);
    if (!latest || !state || !carContactStateIsFresh(stateAgeMs)) {
      if (latest) staleCount++;
      o.contactActive = false;
      G.setRemoteCarContact(id, null);
      continue;
    }
    const dx = state.p[0] - mine[0], dy = state.p[1] - mine[1], dz = state.p[2] - mine[2];
    const distSq = dx * dx + dy * dy + dz * dz;
    o.contactActive = o.contactActive
      ? distSq <= REMOTE_CONTACT_EXIT_RANGE_SQ
      : distSq <= REMOTE_CONTACT_RANGE_SQ;
    const synced = G.setRemoteCarContact(id, o.contactActive ? state : null);
    if (o.contactActive) activeCount++;
    if (synced) maxStateStepM = Math.max(maxStateStepM, synced.distance || 0);
    const previous = o.buf[o.buf.length - 2];
    if (previous) maxSequenceGap = Math.max(maxSequenceGap, latest.seq - previous.seq);
  }
  const diagnosticNow = performance.now();
  if (others.size && diagnosticNow - lastContactSyncDiagnosticAt >= 50) {
    lastContactSyncDiagnosticAt = diagnosticNow;
    netDiagnostics.record(
      NET_DIAG_EVENT.CONTACT_SYNC,
      others.size,
      activeCount,
      staleCount,
      maxStateAgeMs,
      maxStateStepM,
      maxSequenceGap,
    );
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

// A hálózatról kapott fizikai kormányállás digitális irányításnál
// egyik snapshotról a másikra nagyot ugorhat. A saját autóhoz hasonlóan csak
// a látható kerék közelít fokozatosan; a fizika és a hálózati állapot nem
// változik. A kormányzott pivotok olcsó Y-forgatása minden képkockán fut,
// miközben a gördülés továbbra is megtartja a távolságalapú ritkítást.
function moveRemoteSteerTowards(current, target, dt) {
  const maxDelta = STEER_VISUAL_SPEED * dt;
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
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

// „A VERSENY VÉGET ÉR — 12.4". Az első befutó után jelenik meg, és a szerver
// órájához igazodik: a határidő szerver-időben érkezik, a serverNow() pedig a
// ping-mintákból karbantartott eltolással számol, tehát mindenki nagyjából
// ugyanazt a számot látja.
//
// Miért itt, képkockánként, és nem a snapshot beérkezésekor: a snapshot 20 Hz,
// abból a tizedek szaggatva lépnének. Így viszont a szám folyamatosan pörög.
const finishTimerEl = document.getElementById('finishTimer');
const finishTimerValueEl = document.getElementById('finishTimerValue');
let finishTimerShown = false;

function hideFinishTimer() {
  if (!finishTimerShown) return;
  finishTimerEl.classList.add('hidden');
  finishTimerEl.classList.remove('is-urgent');
  finishTimerShown = false;
}

function renderFinishTimer(nowServer) {
  if (finishDeadlineAt === null || raceEnded) {
    hideFinishTimer();
    return;
  }
  const leftMs = Math.max(0, finishDeadlineAt - nowServer);
  const secs = leftMs / 1000;
  finishTimerValueEl.textContent = secs.toFixed(1);
  finishTimerEl.classList.toggle('is-urgent', secs <= 10);
  if (!finishTimerShown) {
    finishTimerEl.classList.remove('hidden');
    finishTimerShown = true;
  }
}

// ---------- Nézői mód ----------
//
// Aki célba ért, a saját leparkolt kocsiját bámulná, amíg a többiek beérnek —
// ehelyett átkapcsolhat rájuk. A kamerát a main.js állítja (setSpectateTarget),
// itt csak azt tartjuk nyilván, kire, és ezt írjuk ki.

const spectateBarEl = document.getElementById('spectateBar');
const spectateNameEl = document.getElementById('spectateName');
const spectateNextEl = document.getElementById('spectateNext');
// Egyszer, az első célba érés utáni képkockán ugrunk a mezőnyre; utána a
// játékos választása számít (a saját kocsi is választható).
let spectateArmed = false;

// Kit lehet nézni: aki már megérkezett (van valódi állapota) és még megy.
// A sorrend a `others` beszúrási sorrendje, tehát a „Következő" mindig
// ugyanúgy körbejár — a helyezés szerinti sorrend versenyzés közben átrendeződne.
function spectatableIds() {
  return [...others.entries()].filter(([, o]) => o.present && !o.finished).map(([id]) => id);
}

function applySpectateTarget() {
  const entry = spectateId ? others.get(spectateId) : null;
  G.setSpectateTarget(entry?.group || null);
}

function setSpectate(id) {
  spectateId = id;
  applySpectateTarget();
}

// Körbelépés: a nézhetők, végül a saját kocsi (null), majd újra elölről.
function cycleSpectate() {
  if (!canSpectate()) return;
  const list = [...spectatableIds(), null];
  const index = list.indexOf(spectateId);
  setSpectate(list[(index + 1) % list.length]);
}

function canSpectate() {
  return finishedDriving && !raceEnded && !isHotLap();
}

function updateSpectateBar() {
  const list = canSpectate() ? spectatableIds() : [];
  if (!list.length) {
    // Nincs kit nézni (mindenki beért, vagy még nem értünk célba): vissza a
    // saját kocsira, hogy a kamera ne egy eltűnő autón ragadjon.
    if (spectateId !== null) setSpectate(null);
    spectateBarEl.classList.add('hidden');
    return;
  }
  // Az épp nézett kiesett a mezőnyből (beért vagy kilépett): lépjünk a
  // következőre magától, ne álljon meg a kép egy már nem frissülő kocsin.
  if (spectateId !== null && !list.includes(spectateId)) setSpectate(list[0]);
  // Célba éréskor rögtön a mezőnyre váltunk: a saját kocsi ilyenkor már áll,
  // nincs rajta mit nézni.
  else if (spectateId === null && !spectateArmed) setSpectate(list[0]);
  spectateArmed = true;

  spectateNameEl.textContent = spectateId
    ? (others.get(spectateId)?.name || '—')
    : t('mp.yourCar');
  spectateBarEl.classList.remove('hidden');
}

function resetSpectate() {
  spectateArmed = false;
  spectateId = null;
  G.setSpectateTarget(null);
  spectateBarEl.classList.add('hidden');
}

spectateNextEl.addEventListener('click', cycleSpectate);
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyV' || e.repeat) return;
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
  cycleSpectate();
});

// Egy távoli autó eltüntetése — akár azért, mert még nincs róla valódi
// állapot, akár mert a ködben már úgysem látszana.
//
// A `renderReady` NULLÁZÁSA a lényeg: amíg igaz, a következő megjelenéskor a
// látható modell a RÉGI helyéről indulva csúszik az újra. Ez a helyben
// maradóknál észrevehetetlen, de a 700 méteren kívülre került autó közben fél
// pályányit haladhat — visszatéréskor átsuhanna a képen. Hamisra állítva
// odakerül, nem odacsúszik.
function hideRemoteCar(o) {
  o.group.visible = false;
  o.label.visible = false;
  o.renderReady = false;
  resetVisualMotionTracker(o.visualMotion);
}

// Minden képkockán fut (a main.js animate-jéből).
function frame(dt = 1 / 60) {
  window.__mp.frames++;
  // A böngésző egy hosszú render/főszál-akadás után több WebSocket message
  // callbacket is lefuttathat a következő kép előtt. Ezekből itt pontosan egy,
  // a legfrissebb állapot kerül a pufferekbe; az eseményeket az onMessage
  // továbbra is mind, érkezési sorrendben dolgozza fel.
  flushPendingSnapshot(1);
  const nowLocal = performance.now();
  pumpInputLoop(nowLocal);
  remoteDetailFrame = (remoteDetailFrame + 1) % 240;
  const nowServer = serverNow();
  // Hálózati biztonsági referencia: megmutatja, milyen mély puffer kellene
  // extrapoláció nélkül a snapshotokhoz. A látható autó nem ezt az időt
  // követi, hanem lejjebb a saját autó tényleges kirajzolási időpontját; a
  // referencia a korrekció erősségéhez és az F9-diagnosztikához marad meg.
  const interpClock = advanceRenderClock({
    renderAtMs: interpRenderAt,
    previousNowMs: interpUpdatedAt,
    nowMs: nowServer,
    targetDelayMs: remoteDelayTarget(transitSamples, {
      minMs: MIN_INTERP_DELAY_MS,
      maxMs: MAX_INTERP_DELAY_MS,
    }),
    playbackRate: interpPlaybackRate,
    rateMin: REMOTE_CLOCK_RATE_MIN,
    rateMax: REMOTE_CLOCK_RATE_MAX,
    minDelayMs: MIN_INTERP_DELAY_MS,
    maxDelayMs: MAX_INTERP_DELAY_MS,
  });
  interpRenderAt = interpClock.at;
  interpUpdatedAt = nowServer;
  interpPlaybackRate = interpClock.rate;
  interpDelayMs = Math.max(0, nowServer - interpClock.at);
  const stableRemoteTime = interpClock.at;
  // Az ablak akkor is öregedjen, ha épp nem jön snapshot — különben egy
  // megszakadt kapcsolat után a régi minták tartanák magasan a célmélységet.
  expireTransitSamples(transitSamples, nowLocal);

  const state = interpolatedPhys(nowLocal);
  G.applyServerTransform(state.p, state.q);
  // A saját és a távoli autó ugyanazt a szimulációs pillanatot mutassa. A
  // saját renderóra performance.now()-alapú; ezt egyszer átváltjuk a távoli
  // minták szerverórájára. Korábban a közeli autót egészen `nowServer`-ig
  // húztuk előre, miközben a saját képünk 33–100 ms-mal a jelen mögött járt.
  const localRenderTime = alignedRemoteRenderTime(
    nowServer,
    nowLocal,
    predSampleAt,
    predDelayMs,
  );

  // A többiek helye a minitérképhez is kell, ezért ugyanabban a körben
  // gyűjtjük — a kirajzolt (interpolált) pozícióból, hogy a pötty pontosan azt
  // mutassa, amit a képen látunk.
  const markers = [];
  // Nézői módban a sebességmérőt a nézett kocsi hajtja, KÉPKOCKÁNKÉNT, az
  // interpolált állapotból — nem a 20 Hz-es snapshotból. Így ugyanolyan
  // folyamatos, mint vezetés közben a sajátunk.
  const watchedEntry = spectateId ? others.get(spectateId) : null;
  G.setTireCondition(
    spectateId
      ? (watchedEntry?.tireState ?? null)
      : (localTireState.enabled ? localTireState : null)
  );
  for (const o of others.values()) {
    const latest = o.buf[o.buf.length - 1];
    const currentState = remoteStateAt(o.buf, nowServer);
    // Nincs valódi vagy még elfogadhatóan friss állapota: a kép és a fizikai
    // kontakt együtt tűnjön el. Így reconnect-türelmi idő alatt sincs 9
    // másodpercig látható, de már átjárhatóvá vált „szellem-autó”.
    if (!currentState) {
      hideRemoteCar(o);
      continue;
    }
    if (!latest || nowServer - latest.t > REMOTE_VISUAL_MAX_AGE_MS) {
      hideRemoteCar(o);
      continue;
    }
    const mine = G.getCarState().p;
    const dx = currentState.p[0] - mine[0], dy = currentState.p[1] - mine[1], dz = currentState.p[2] - mine[2];
    const distSq = dx * dx + dy * dy + dz * dz;
    // A NÉVTÁBLA halványodása a kamerától mért távolság szerint megy, nem a
    // saját kocsinktól. Vezetés közben a kettő gyakorlatilag ugyanaz (a kamera
    // néhány méterrel a kocsi mögött ül), nézői módban viszont nem: ott a
    // saját kocsink fél pályával arrébb parkol, és épp a nézett játékos
    // névtáblája tűnne el. A közelségi korrekciós súly (lásd lejjebb)
    // szándékosan marad a saját kocsihoz kötve; a névtábla viszont ahhoz,
    // amit a kamera ténylegesen lát.
    const cam = G.camera.position;
    const lx = currentState.p[0] - cam.x, ly = currentState.p[1] - cam.y, lz = currentState.p[2] - cam.z;
    const labelDistSq = lx * lx + ly * ly + lz * lz;
    const cameraDistance = Math.sqrt(labelDistSq);
    const watched = o === watchedEntry;
    const detailInterval = remoteDetailUpdateInterval(cameraDistance, watched);
    const detailDue = detailInterval === 1
      || (remoteDetailFrame + o.detailPhase) % detailInterval === 0;

    o.audioDt = Math.min(0.5, (o.audioDt || 0) + dt);
    const audioInterval = watched || cameraDistance <= REMOTE_AUDIO_MAX_RANGE
      ? detailInterval
      : 30;
    const audioDue = audioInterval === 1
      || (remoteDetailFrame + o.detailPhase) % audioInterval === 0;

    // A ködben már nem látható kasztni GPU-munkáját teljesen elhagyjuk. A
    // currentState-ből a minitérkép és a lehalkítás továbbra is frissül.
    if (!watched && labelDistSq > REMOTE_RENDER_MAX_RANGE_SQ) {
      hideRemoteCar(o);
      if (audioDue) {
        G.updateRemoteEngine(o.engineAudio, {
          position: currentState.p,
          velocity: currentState.v,
          speedKmh: Math.hypot(currentState.v?.[0] || 0, currentState.v?.[2] || 0) * 3.6,
          throttle: currentState.th ?? 0,
        }, o.audioDt);
        o.audioDt = 0;
      }
      markers.push({ x: currentState.p[0], z: currentState.p[2], color: o.color || '#ffffff' });
      continue;
    }

    const delayedState = sampleAt(o.buf, stableRemoteTime);
    if (!delayedState) {
      hideRemoteCar(o);
      continue;
    }
    o.group.visible = true;
    if (detailDue) {
      if (labelDistSq >= PLAYER_LABEL_MAX_RANGE_SQ) {
        o.label.visible = false;
      } else {
        const opacity = cameraDistance <= PLAYER_LABEL_FADE_START
          ? 1
          : (PLAYER_LABEL_MAX_RANGE - cameraDistance) / (PLAYER_LABEL_MAX_RANGE - PLAYER_LABEL_FADE_START);
        o.label.material.opacity = opacity;
        o.label.visible = opacity > 0.01;
      }
    }
    // A távolság csak a korrekció lecsengését szabályozza. Magát a mintavételi
    // időt nem: előzéskor a távolságtól függő idővonal 300–378 km/h-nál
    // 10–16 métert adott hozzá, majd távolodáskor ugyanennyit vett vissza.
    const remoteDistance = Math.sqrt(distSq);
    const nearFactor = remoteVisualNearFactor(remoteDistance);
    const s = remoteStateAt(o.buf, localRenderTime);
    if (!s) continue;
    const firstRenderedFrame = !o.renderReady;
    if (firstRenderedFrame) {
      resetVisualMotionTracker(o.visualMotion);
      o.group.position.set(s.p[0], s.p[1], s.p[2]);
      o.group.quaternion.set(s.q[0], s.q[1], s.q[2], s.q[3]);
      o.renderReady = true;
    } else {
      // A közös időpontra vett cél korrekciója nagy hálózati késésnél lassabban
      // cseng le, ezért az új snapshot nem rántja oldalra az autót.
      const halfLife = remoteVisualCorrectionHalfLife(interpDelayMs, nearFactor);
      const alpha = 1 - Math.pow(0.5, dt / halfLife);
      // A simító célja a kocsi ELŐRE vetített helye, hogy a szűrő állandósult
      // lemaradása épp kiessen — különben a látható kocsi a saját ütközőteste
      // mögött jár, a másik autó sebességével arányosan. Lásd a
      // smootherLeadSeconds() indoklását.
      const lead = smootherLeadSeconds(alpha, dt);
      const v = s.v || [0, 0, 0];
      const tx = s.p[0] + (v[0] || 0) * lead;
      const ty = s.p[1] + (v[1] || 0) * lead;
      const tz = s.p[2] + (v[2] || 0) * lead;
      o.group.position.x += (tx - o.group.position.x) * alpha;
      o.group.position.y += (ty - o.group.position.y) * alpha;
      o.group.position.z += (tz - o.group.position.z) * alpha;
      // Ugyanez a lemaradás a FORGÁSRA is igaz: kanyarban a látható kocsi
      // orra elmaradna a valódi állásától.
      const q0 = [o.group.quaternion.x, o.group.quaternion.y, o.group.quaternion.z, o.group.quaternion.w];
      const qr = slerp(q0, integrateRotation(s.q, s.w || [0, 0, 0], lead), alpha);
      o.group.quaternion.set(qr[0], qr[1], qr[2], qr[3]);
    }
    const timelineShiftM = Math.hypot(
      s.p[0] - delayedState.p[0],
      s.p[1] - delayedState.p[1],
      s.p[2] - delayedState.p[2],
    );
    observeRemoteVisualMotion(o, nowLocal, remoteDistance, timelineShiftM);
    const targetSteer = s.st ?? 0;
    o.visualSteerAngle = firstRenderedFrame
      ? targetSteer
      : moveRemoteSteerTowards(o.visualSteerAngle ?? 0, targetSteer, dt);
    for (let i = 0; i < o.wheelRig.pivots.length; i++) {
      const pivot = o.wheelRig.pivots[i];
      const source = o.wheelRig.sources[i];
      if (detailDue) pivot.rotation.x = s.wr ?? 0;
      if (source?.steer) pivot.rotation.y = o.visualSteerAngle;
    }
    const kmh = Math.hypot(s.v?.[0] || 0, s.v?.[2] || 0) * 3.6;
    if (o === watchedEntry) G.setSpeed(kmh);
    if (audioDue) {
      G.updateRemoteEngine(o.engineAudio, {
        position: o.group.position,
        velocity: s.v,
        speedKmh: kmh,
        throttle: s.th ?? 0,
      }, o.audioDt);
      o.audioDt = 0;
    }
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

  // A raceEnded-es kiugrás ELŐTT: aki már célba ért, annak is látnia kell,
  // meddig várunk még a többiekre — pont ő az, aki nézelődik.
  renderFinishTimer(nowServer);
  // Szintén ide, és nem lejjebb: a nézői sávnak a verseny végén is el kell
  // tűnnie, azt pedig már nem érné el a kiugrás után.
  updateSpectateBar();

  // A mozdulatlan rajtnál középen, név szerint jelezzük, kire várunk. Hot
  // Lapban nincs másik játékos, ezért ott nem villantjuk fel.
  // A roomState szerver-visszhangjáig a saját `ready` mezőnk még hamis lehet,
  // de ettől nem magunkra várunk: a név szerinti lista csak a többieket mutassa.
  const waitingPlayers = room?.players
    .filter((p) => p.id !== me.id && !p.ready)
    .map((p) => p.name) || [];
  setWaitingPlayersAlert(
    !raceEnded && !isHotLap() && !starting?.startsAt,
    waitingPlayers
  );

  if (raceEnded) return;

  // Amíg nincs rajtidő, a többiek betöltésére várunk. A panel ilyenkor is a
  // VÉGLEGES vázát mutatja, csak placeholder értékekkel — korábban üres volt,
  // és a rajtnál egyszerre ugrott be az egész doboz. Így viszont a játékos már
  // a várakozás alatt látja, hány körös a futam, és a rajtkor csak a számok
  // kezdenek élni.
  if (!starting?.startsAt) {
    G.setHud(lapPanelHtml({
      lapNow: 1,
      lapTotal: room?.laps ?? '?',
      current: NaN, best: NaN, total: NaN, lapsDone: 0,
      hotLap: isHotLap(),
    }));
    G.setStandings('');
    return;
  }

  if (isHotLap() && !myLapStartedAt) {
    G.setHud(
      '<div class="lap-head">' +
        `<span class="lbl">${t('mp.hotLap')}</span>` +
        `<span><span class="lap-now num">${myLap + 1}</span></span>` +
      '</div>' +
      `<div class="hud-note"><strong>${t('hud.warmUp')}</strong><br>${t('hud.warmUpHint')}</div>`
    );
    G.setStandings('');
    return;
  }

// A jobb felső kör-panel HTML-je. EGY helyen, mert két állapot használja: a
// várakozó (még nincs rajtidő) és a futó. Ha külön épülnének, elcsúsznának
// egymástól, és a rajtnál látszana az ugrás.
//
// A hiányzó időket nem külön ággal kezeljük: a formatTime a nem véges értékre
// „--:--.---”-t ad, tehát a placeholder ugyanaz a doboz, ugyanazon a helyen.
function lapPanelHtml({
  lapNow, lapTotal, current, best, total, lapsDone,
  tainted = false, hotLap = false,
}) {
  // Időmérésben nincs körszám-korlát, tehát nincs mihez viszonyítani: csak a
  // sorszám megy ki, „/ 1” nélkül.
  const korSzamlalo = hotLap
    ? `<span class="lap-now num">${lapNow}</span>`
    : `<span class="lap-now num">${lapNow}</span><span class="lap-total num"> / ${lapTotal}</span>`;
  return '<div class="lap-head">' +
      `<span class="lbl">${t('hud.lap')}</span>` +
      `<span>${korSzamlalo}</span>` +
    '</div>' +
    (tainted ? `<div class="t-warn mb-2">${t('hud.lapInvalidNote')}</div>` : '') +
    `<div class="t-row"><span class="lbl">${t('hud.current')}</span>` +
      `<span class="t-val num">${G.formatTime(current)}</span></div>` +
    `<div class="t-row${Number.isFinite(best) ? ' is-best' : ''}">` +
      `<span class="lbl">${t('hud.best')}</span>` +
      `<span class="t-val num">${G.formatTime(best)}</span></div>` +
    // Időmérésben az „Összes” ugyanazt mutatná, mint az „Aktuális” (a
    // raceClock ott mindkettőt a kör kezdetétől számolja) — korlátlan körnél
    // a megfutott körök száma többet mond.
    (hotLap
      ? `<div class="t-row"><span class="lbl">${t('mp.lapsDone')}</span>` +
        `<span class="t-val num">${lapsDone}</span></div>`
      : `<div class="t-row"><span class="lbl">${t('hud.total')}</span>` +
        `<span class="t-val num">${G.formatTime(total)}</span></div>`);
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
  const bestTime = Number.isFinite(myBestLap)
    ? myBestLap
    : validTimes.length ? Math.min(...validTimes) : NaN;
  G.setHud(lapPanelHtml({
    lapNow: isHotLap() ? myLap + 1 : Math.min(myLap + 1, room?.laps ?? myLap + 1),
    lapTotal: room?.laps ?? '?',
    current: currentTime,
    best: bestTime,
    total: totalTime,
    lapsDone: myLap,
    tainted: lapTainted,
    hotLap: isHotLap(),
  }));

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
      `<span>${t('mp.standings')}</span>` +
      `<span>${t('mp.starters', { n: rows.length })}</span>` +
    '</div>' +
    '<div class="st-cols">' +
      `<span>#</span><span></span><span>${t('mp.name')}</span><span>${t('hud.lap')}</span>` +
      `<span>${t('mp.gap')}</span><span>${t('mp.bestShort')}</span><span>${t('mp.last')}</span>` +
    '</div>' + body;
}

function formatStandingTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return G.formatTime(ms).replace(/^0:/, '');
}

function eventText(e) {
  const who = room?.players.find((p) => p.id === e.playerId)?.name || 'Valaki';
  if (e.kind === 'lap') return t('mp.feedLap', { who, lap: e.lap, time: (e.timeMs / 1000).toFixed(2), flag: e.invalid ? ' ⚠️' : '' });
  if (e.kind === 'finished') return t('mp.feedFinished', { who });
  if (e.kind === 'left') return t('mp.feedLeft', { name: e.name });
  return '';
}

// A helyi fizikát a képkocka elején, de fix 60 Hz-es idővonalon futtatjuk:
// egy képkockára az eltelt időtől függően 0–3 lépés jut. A viselkedés és a
// hálózati terhelés így nem válik a pillanatnyi FPS függvényévé.

function startInputLoop() {
  stopInputLoop();
  // A sorszám a teljes WebSocket-kapcsolaton monoton nő. R után még úton
  // lehetnek az előző próbálkozás csomagjai; ha nulláznánk, az új állapotokat
  // a szerver addig réginek hinné, amíg újra el nem érjük a korábbi értéket.
  lapTainted = TAINT.NONE;
  finishedDriving = false;
  G.setMultiplayerControlsEnabled(true);
  resetPredState();
  stateSendPhase = 0;

  // A renderrel versengő külön setTimeout-hurok terhelt integrált GPU-kon
  // 80–125 ms-ra is kiszorult a főszál ütemezéséből, miközben képkockák még
  // készültek. Ilyenkor a saját renderpuffer kifogyott, a kocsi megállt, majd
  // a késve egymás után lefutó lépésektől előreugrott. A 60 Hz-es ütemet most
  // a képkocka ELEJÉN fogyasztjuk el; így minden kirajzolás előtt biztosan
  // elkészülnek az addig esedékes fizikai állapotok.
  nextInputTickAt = performance.now();
  inputLoopActive = true;
}

function pumpInputLoop(now = performance.now()) {
  if (!inputLoopActive) return;
  if (lastInputTickAt > 0) {
    inputTickGapMaxMs = Math.max(inputTickGapMaxMs, now - lastInputTickAt);
  }
  lastInputTickAt = now;
  observePhysicsTimer(now - nextInputTickAt);

  // Hosszú háttérbe kerülés vagy valódi főszálfagyás után nem játszunk le
  // több száz lépést gyorsítva. Normál 30–60 FPS között a háromlépéses keret
  // bőven elég a fix 60 Hz megtartásához.
  const latestCatchupStart = now - TICK_MS * 2;
  if (nextInputTickAt < latestCatchupStart) {
    // Még a lépések ELŐTT dobjuk el a három ticken túli régi időt. Így a
    // szerverre sem mennek ki frissen elkészített, de 100+ ms-os időbélyegű
    // állapotok, és a helyi renderpuffer régi mintái is ugyanannyival
    // tolódnak: a fizika és a kép idővonala együtt marad.
    const droppedMs = latestCatchupStart - nextInputTickAt;
    shiftPredictionTimeline(droppedMs);
    nextInputTickAt = latestCatchupStart;
  }

  let steps = 0;
  while (nextInputTickAt <= now && steps < 3) {
    // Az ÜTEMEZETT idő marad a fizikai és hálózati állapot időbélyege. Két,
    // ugyanazon képkocka előtt behozott lépés így továbbra is két külön tick,
    // nem két szinte azonos performance.now()-minta.
    sendOneInput(nextInputTickAt);
    nextInputTickAt += TICK_MS;
    steps++;
  }
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
  const beforeState = G.getCarState();
  const { q, v } = beforeState;
  const previousPitPosition = pitPrevPosition || { x: beforeState.p[0], z: beforeState.p[2] };
  let pitChangesBefore = localPitState.changeCount;
  updatePitState(localPitState, localPitConfig, localPitStopIndex, {
    fromX: previousPitPosition.x,
    fromZ: previousPitPosition.z,
    x: beforeState.p[0],
    z: beforeState.p[2],
    now: scheduledAt,
    speedMps: Math.hypot(v[0], v[2]),
  });
  if (localPitState.changeCount > pitChangesBefore) changeTires(localTireState);
  const fwdSpeed = forwardSpeed(q[0], q[1], q[2], q[3], v[0], v[1], v[2]);
  const brake = backwardHeld && fwdSpeed > REVERSE_BRAKE_THRESHOLD ? backwardAmount : 0;
  const reverseAmount = backwardHeld && !brake ? backwardAmount : 0;
  const finishedBraking = !controlsEnabled && shouldBrakeFinishedVelocity(v[0], v[2]);
  const shouldSend = !raceEnded && !resetPending;
  const sendStateNow = shouldSend && clientStateSendDue(stateSendPhase);
  if (shouldSend) {
    stateSendPhase = (stateSendPhase + 1) % CLIENT_STATE_INTERVAL_TICKS;
  } else {
    // Reset/eredmény után az első újra engedélyezett lépés rögtön menjen ki.
    stateSendPhase = 0;
  }
  const input = {
    seq: sendStateNow ? ++inputSeq : inputSeq,
    // Csak helyi metaadat: ebből tudjuk, melyik időpontra kell tenni a távoli
    // autók fizikai kontaktpózát. A LÉPÉS ütemezett ideje, nem a hívás pillanata —
    // lásd serverTimeFor().
    at: serverTimeFor(scheduledAt),
    frozen: isFrozen(),
    steer: controlsEnabled ? axes.steer : 0,
    throttle: Math.max(0, pedal) || -reverseAmount,
    brake: controlsEnabled ? brake : finishedBraking,
    handbrake: controlsEnabled && !!k['Space'],
  };
  if (!input.frozen && !raceRunningDiagnosticRecorded) {
    raceRunningDiagnosticRecorded = true;
    netDiagnostics.record(
      NET_DIAG_EVENT.RACE,
      NET_DIAG_RACE_STAGE.RUNNING,
      0,
      room?.laps,
      room?.players?.length,
    );
  }
  const contactStartedAt = performance.now();
  syncRemoteContacts(input.at);
  const physicsStartedAt = performance.now();
  G.stepLocalPhysics(
    input,
    input.frozen,
    !controlsEnabled,
    localPitState.enabled && localPitState.inLane,
    localTireState.wear,
  );
  const physicsFinishedAt = performance.now();
  observePipelineTimings(
    physicsStartedAt - contactStartedAt,
    physicsFinishedAt - physicsStartedAt,
  );
  const state = G.getCarState();
  pitChangesBefore = localPitState.changeCount;
  updatePitState(localPitState, localPitConfig, localPitStopIndex, {
    fromX: beforeState.p[0],
    fromZ: beforeState.p[2],
    x: state.p[0],
    z: state.p[2],
    now: scheduledAt + TICK_MS,
    speedMps: Math.hypot(state.v[0], state.v[2]),
  });
  if (localPitState.changeCount > pitChangesBefore) changeTires(localTireState);
  pitPrevPosition = { x: state.p[0], z: state.p[2] };
  G.setPitStopMarker(
    localPitConfig?.stops?.[localPitStopIndex],
    localPitState.enabled && localPitState.inLane
  );
  G.renderPitStopHud(localPitState, localPitStopIndex, localTireState);
  const steppedAt = scheduledAt + TICK_MS;
  recordPhysState(steppedAt, state);
  // Nézői módban NEM a saját kocsink hajtja a sebességmérőt — azt a frame()
  // állítja a nézett kocsiról. Enélkül a két forrás váltogatná egymást: ez a
  // 60 Hz-es ciklus a leparkolt (0 km/h) sajátunkat írta ki, a képkockánkénti
  // rajzolás meg a nézettét, és a kijelző 0 és 140 közt ugrált.
  if (!spectateId) G.setSpeed(Math.hypot(state.v[0], state.v[2]) * 3.6);
  // A saját kimeneti sor fojtása. Ugyanaz a gondolat, mint a szerver
  // broadcastRoom-jában: egy elavult állapotcsomagot nincs értelme sorba
  // állítani, mert a következő tick úgyis felülírja. A különbség csak annyi,
  // hogy TCP-n a már elküldöttet nem tudjuk visszavonni — azt viszont
  // eldönthetjük, hogy el se induljon.
  //
  // Enélkül egy pillanatnyi feltöltési akadásnál (wifi, mobilnet) a csomagok
  // felgyűlnek, majd késve, SOROZATBAN érkeznek meg: a szerver elavult
  // állapotok sorát kapja, a többi játékos pedig azt látja, hogy ez a kocsi
  // megáll, majd ugrik egyet.
  //
  // A küszöb 30 Hz-en ~160 ms-nyi torlódás: ennél régebbi állapotot már nem
  // érdemes útnak indítani.
  const backlog = ws?.bufferedAmount || 0;
  const backlogFull = backlog > STATE_BACKLOG_LIMIT_BYTES;
  if (sendStateNow && backlogFull) statesDropped++;
  if (sendStateNow && !backlogFull) {
    const wheels = G.getWheelNetworkState?.() || { st: 0, wr: 0 };
    const offtrack = !!G.isCarFullyOffTrack?.();
    netDiagnostics.record(
      NET_DIAG_EVENT.STATE_OUT,
      input.seq,
      state.p[0],
      state.p[2],
      Math.hypot(state.v[0], state.v[2]),
      ws?.bufferedAmount || 0,
      offtrack,
      physicsTimerLatenessMs,
      physicsTimerJitterMs,
    );
    send(C2S.STATE, {
      seq: input.seq,
      // A kiküldött állapot a world.step UTÁNI pillanatot írja le.
      t: serverTimeFor(steppedAt),
      ...state,
      ...wheels,
      th: input.throttle,
      offtrack,
    });
  }
}

function stopInputLoop() {
  inputLoopActive = false;
  nextInputTickAt = 0;
  lastInputTickAt = 0;
}

function showResults(results) {
  const hotLap = isHotLap();
  raceEnded = true;
  setWaitingPlayersAlert(false);
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
  G.setHud(`<div class="lap-head"><span class="lbl">${hotLap ? t('mp.hotLapOver') : t('mp.raceOver')}</span></div>`);
  G.setStandings('');
  $('mpResultsTitle').textContent = hotLap ? t('mp.hotLapOver') : t('mp.raceOver');
  $('mpResultsBody').innerHTML =
    '<div class="mp-res-cols">' +
      `<span>#</span><span></span><span>${t('mp.name')}</span><span>${t('hud.lap')}</span>` +
      `<span>${t('hud.total')}</span><span>${t('hud.best')}</span>` +
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
  restart.textContent = hotLap ? t('mp.tryAgain') : t('mp.newGame');
  $('mpResultsHint').textContent = hotLap
    ? t('mp.restartHint')
    : isHost
    ? t('mp.hostCanRestart')
    : t('mp.waitingForHostOrLeave');
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
  button.textContent = t('mp.starting');
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
hotLapBtn.textContent = t('mp.hotLap');
hotLapBtn.addEventListener('click', openHotLap);
modeButtons?.appendChild(hotLapBtn);

const btn = document.createElement('button');
btn.id = 'mpOpenBtn';
btn.className = 'btn-race btn-mp';
btn.textContent = t('menu.multiplayer');
btn.addEventListener('click', openLobby);
modeButtons?.appendChild(btn);

// A két gomb felirata csak itt, egyszer íródik ki — nyelvváltáskor magától nem
// frissülne. A szoba- és eredménypanel a következő szerverüzenetnél amúgy is
// újrarajzolódik, de a lobbi látható részét azonnal frissítjük.
onLanguageChange(() => {
  hotLapBtn.textContent = t('mp.hotLap');
  btn.textContent = t('menu.multiplayer');
  // A három panel a body-ban él, nem az index.html-ben — a main.js
  // applyToDom() hívása a `document`-et járja be, tehát ezeket is eléri, de a
  // panelek a saját dinamikus részüket maguk írják újra.
  $('mpTitle').textContent = isHotLap() ? t('mp.hotLap') : t('menu.multiplayer');
  if (room) renderRoom();
  else if (!$('mpRooms').classList.contains('hidden')) requestRoomList();
});
