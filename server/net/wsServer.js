// WebSocket réteg: kapcsolatok, szobák, üzenetkezelés.
//
// A verseny állapotát a RaceController kezeli; ez a fájl a hálózati protokollt
// és a szobák életciklusát tartja kézben.
import { WebSocketServer } from 'ws';
import { ERR } from '../../shared/errorCodes.js';
import { randomUUID } from 'node:crypto';
import {
  C2S, S2C, ROOM_STATE, GAME_MODE, ROOM_CODE_LENGTH, sanitizeName, sanitizePlayerToken,
  RACE_LOAD_TIMEOUT_MS, paginateRooms,
} from '../../shared/protocol.js';
import { Room } from '../game/room.js';
import { RaceController, sanitizeClientCarState } from '../game/raceController.js';
import {
  dbAvailable, findPlayerByToken, ghostLap, renamePlayer, upsertPlayer,
} from '../db/index.js';
import { getManifest } from '../assets.js';
import { recentBlockMs } from '../loopLag.js';
import { hasCompletePitConfig } from '../../shared/pit.js';

const rooms = new Map();    // kód -> Room
const players = new Map();  // playerId -> player
const MAX_BUFFERED_SNAPSHOTS = 3;
const MAX_WS_PAYLOAD_BYTES = 64 * 1024;
const HEARTBEAT_INTERVAL_MS = 15_000;

// Összetéveszthető karakterek (0/O, 1/I) nélkül — a kódot élőszóban is
// szokták diktálni.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeRoomCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  return null;
}

function send(socket, type, data = {}) {
  if (socket?.readyState === 1) socket.send(JSON.stringify({ type, ...data }));
}

// A szerver kódot küld, nem kész szöveget — lásd shared/errorCodes.js.
function fail(socket, code, detail) {
  send(socket, S2C.ERROR, detail ? { code, detail } : { code });
}

function isActivePlayer(player) {
  return players.get(player.id) === player && player.socket?.readyState === 1;
}

// Egyszerű token bucket kapcsolatonként. A normál kliens 60 STATE/s + 1 PING/s
// körül küld; a limitek hagynak bőséges burst-t a hálózaton összetorlódott
// csomagokra, de nem engednek korlátlan JSON/DB/szobalétrehozási áradatot.
function consumeRate(player, key, refillPerSecond, capacity, now = Date.now()) {
  const previous = player.rateLimits.get(key) || { tokens: capacity, at: now };
  const elapsed = Math.max(0, now - previous.at) / 1_000;
  const tokens = Math.min(capacity, previous.tokens + elapsed * refillPerSecond);
  if (tokens < 1) {
    player.rateLimits.set(key, { tokens, at: now });
    return false;
  }
  player.rateLimits.set(key, { tokens: tokens - 1, at: now });
  return true;
}

function messageRateAllowed(player, type, now = Date.now()) {
  if (type === C2S.STATE) return consumeRate(player, 'state', 90, 150, now);
  if (type === C2S.PING) return consumeRate(player, 'ping', 2, 4, now);
  return consumeRate(player, 'control', 4, 8, now);
}

function broadcastRoom(room, type, data = {}) {
  // Egy snapshot minden címzettnél azonos. Korábban játékosonként újra
  // JSON.stringify-oltuk, és lassú kapcsolatnál korlátlanul sorba állítottuk a
  // már elavult állapotokat. Az állapotcsomag eldobható: hamarosan jön frissebb.
  const payload = JSON.stringify({ type, ...data });
  const snapshotBacklogLimit = Math.max(4096, payload.length * MAX_BUFFERED_SNAPSHOTS);
  for (const p of room.players.values()) {
    const socket = p.socket;
    if (socket?.readyState !== 1) continue;
    if (type === S2C.SNAPSHOT && socket.bufferedAmount > snapshotBacklogLimit) continue;
    socket.send(payload);
  }
}

function pushRoomState(room) {
  broadcastRoom(room, S2C.ROOM_STATE, { room: room.toJSON() });
}

// A szobakereső egy oldala. A legrégebben nyitott szoba kerül elsőnek: aki
// vár valakire, az várjon a legkevesebbet — és ez a rendezés lapozás közben
// sem rendeződik át a szemünk előtt (a létszám szerinti igen).
//
// A szeletelés ITT történik, nem a kliensen: a lista tetszőlegesen hosszú
// lehet, de a dróton mindig legfeljebb egy oldalnyi megy át.
function sendRoomList(socket, requestedPage = 0) {
  const all = [...rooms.values()]
    .filter((room) => room.isListable)
    .sort((a, b) => a.createdAt - b.createdAt);
  const oldal = paginateRooms(all, requestedPage);
  send(socket, S2C.ROOM_LIST, {
    ...oldal,
    rooms: oldal.rooms.map((room) => room.listing()),
  });
}

function welcomePlayer(player, record) {
  player.name = record.name;
  player.dbId = record.id;
  player.token = record.token;
  send(player.socket, S2C.WELCOME, {
    playerId: player.id,
    token: record.token,
    name: record.name,
  });
}

function leaveRoom(player, reason) {
  const room = rooms.get(player.roomCode);
  if (!room) {
    player.roomCode = null;
    return;
  }
  room.sim?.removeCar(player.id);
  const remaining = room.remove(player.id);
  if (remaining === 0) {
    room.sim?.stop();
    clearTimeout(room.loadTimer);
    void room.finishAttempt();
    rooms.delete(room.code);
  } else {
    pushRoomState(room);
    if (reason) broadcastRoom(room, S2C.RACE_EVENT, { kind: 'left', playerId: player.id, name: player.name });
    // Ha épp a verseny betöltésére vártunk, és ő volt a hiányzó, most már
    // indulhatunk — különben a kilépőre várnánk a teljes időkorlátig.
    maybeBeginCountdown(room);
  }
}

async function handleMessage(player, msg) {
  const socket = player.socket;

  switch (msg.type) {
    case C2S.HELLO: {
      if (player.roomCode) return fail(socket, ERR.PROFILE_IN_ROOM);
      const name = sanitizeName(msg.name);
      const token = sanitizePlayerToken(msg.token);
      const rec = await upsertPlayer(name, token)
        .catch(() => ({ id: null, name, token: token || randomUUID() }));
      if (!isActivePlayer(player)) return;
      welcomePlayer(player, rec);
      return;
    }

    case C2S.RESTORE_PROFILE: {
      if (player.roomCode) return fail(socket, ERR.PROFILE_IN_ROOM);
      const token = sanitizePlayerToken(msg.token);
      if (!token) return fail(socket, ERR.BAD_TOKEN_FORMAT);
      if (!dbAvailable()) return fail(socket, ERR.RESTORE_UNAVAILABLE);
      const rec = await findPlayerByToken(token);
      if (!isActivePlayer(player)) return;
      if (!rec) return fail(socket, ERR.NO_PROFILE_FOR_TOKEN);
      welcomePlayer(player, rec);
      return;
    }

    case C2S.RENAME_PLAYER: {
      if (!player.name) return fail(socket, ERR.LOGIN_FIRST);
      if (player.roomCode) return fail(socket, ERR.RENAME_BEFORE_ROOM);
      const name = sanitizeName(msg.name);
      if (!(await renamePlayer(player.dbId, name))) {
        return fail(socket, ERR.RENAME_FAILED);
      }
      if (!isActivePlayer(player)) return;
      player.name = name;
      send(socket, S2C.PROFILE_UPDATED, { name });
      return;
    }

    case C2S.CREATE_ROOM: {
      if (!player.name) return fail(socket, ERR.NAME_FIRST);
      if (player.roomCode) leaveRoom(player);
      const manifest = await getManifest();
      if (!isActivePlayer(player)) return;
      const selectedMap = manifest.maps.find((m) => m.id === msg.mapId);
      const selectedCar = manifest.cars.find((c) => c.id === msg.carId);
      if (!selectedMap) return fail(socket, ERR.NO_SUCH_MAP);
      if (!selectedCar) return fail(socket, ERR.NO_SUCH_CAR);
      const code = makeRoomCode();
      if (!code) return fail(socket, ERR.ROOM_CODE_FAILED);
      const room = new Room(code, player, {
        mapId: msg.mapId,
        laps: msg.laps,
        ghostMode: msg.ghostMode === true,
        mandatoryPitStop: msg.mandatoryPitStop === true && hasCompletePitConfig(selectedMap.pit),
        isPublic: msg.isPublic !== false,
      });
      room.add(player, selectedCar.id);
      rooms.set(code, room);
      pushRoomState(room);
      return;
    }

    case C2S.LIST_ROOMS: {
      if (!player.name) return fail(socket, ERR.NAME_FIRST);
      sendRoomList(socket, Math.trunc(Number(msg.page) || 0));
      return;
    }

    case C2S.START_HOT_LAP: {
      if (!player.name) return fail(socket, ERR.NAME_FIRST);
      if (player.roomCode) leaveRoom(player);
      const manifest = await getManifest();
      if (!isActivePlayer(player)) return;
      const map = manifest.maps.find((m) => m.id === msg.mapId);
      const car = manifest.cars.find((c) => c.id === msg.carId);
      if (!map) return fail(socket, ERR.NO_SUCH_MAP);
      if (!car) return fail(socket, ERR.NO_SUCH_CAR);
      const code = makeRoomCode();
      if (!code) return fail(socket, ERR.HOT_LAP_START_FAILED);
      const ghostPlayerId = Number(msg.ghostPlayerId);
      const room = new Room(code, player, {
        mapId: map.id,
        laps: 1,
        ghostMode: true,
        mode: GAME_MODE.HOT_LAP,
        ghostPlayerId: Number.isSafeInteger(ghostPlayerId) && ghostPlayerId > 0
          ? ghostPlayerId
          : null,
      });
      room.add(player, car.id);
      // A Hot Lap felvezetőből indul: minden aktív pályán pontosan nyolc
      // rajthely van, a 7-es index tehát a nyolcadik, legtávolabbi kocka.
      player.slot = 7;
      rooms.set(code, room);
      pushRoomState(room);
      await startRace(room);
      return;
    }

    case C2S.JOIN_ROOM: {
      if (!player.name) return fail(socket, ERR.NAME_FIRST);
      const code = String(msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return fail(socket, ERR.NO_SUCH_ROOM);
      if (room.mode === GAME_MODE.HOT_LAP) return fail(socket, ERR.HOT_LAP_IS_SOLO);
      if (room.isFull) return fail(socket, ERR.ROOM_FULL);
      if (room.state !== ROOM_STATE.LOBBY) return fail(socket, ERR.RACE_ALREADY_STARTED);
      // Ugyanaz a profil ne kerüljön kétszer ugyanabba a szobába (két fül,
      // egy token). Másik szobában párhuzamosan viszont szabad — az nem
      // rontja el egyik futam rajtrácsát sem.
      if (room.hasProfile(player.token, player.id)) {
        return fail(socket, ERR.ALREADY_IN_ROOM);
      }
      const manifest = await getManifest();
      if (!isActivePlayer(player)) return;
      const selectedCar = manifest.cars.find((car) => car.id === msg.carId);
      if (!selectedCar) return fail(socket, ERR.NO_SUCH_CAR);
      // A manifest olvasása aszinkron: közben a host elindíthatta vagy mások
      // feltölthették a szobát, ezért a változó állapotot újra ellenőrizzük.
      if (rooms.get(code) !== room) return fail(socket, ERR.NO_SUCH_ROOM);
      if (room.isFull) return fail(socket, ERR.ROOM_FULL);
      if (room.state !== ROOM_STATE.LOBBY) return fail(socket, ERR.RACE_ALREADY_STARTED);
      if (room.hasProfile(player.token, player.id)) {
        return fail(socket, ERR.ALREADY_IN_ROOM);
      }
      if (player.roomCode) leaveRoom(player);
      room.add(player, selectedCar.id);
      pushRoomState(room);
      return;
    }

    case C2S.LEAVE_ROOM: {
      leaveRoom(player, true);
      send(socket, S2C.ROOM_CLOSED, { code: ERR.ROOM_LEFT });
      return;
    }

    case C2S.SET_CAR: {
      let room = rooms.get(player.roomCode);
      if (!room) return;
      if (room.state !== ROOM_STATE.LOBBY) return fail(socket, ERR.NO_CAR_SWAP_IN_RACE);
      const roomCode = room.code;
      const manifest = await getManifest();
      if (!isActivePlayer(player)) return;
      const selectedCar = manifest.cars.find((car) => car.id === msg.carId);
      if (!selectedCar) return fail(socket, ERR.NO_SUCH_CAR);
      room = rooms.get(player.roomCode);
      if (!room || room.code !== roomCode || room.state !== ROOM_STATE.LOBBY) {
        return fail(socket, ERR.NO_CAR_SWAP_IN_RACE);
      }
      player.carId = selectedCar.id;
      pushRoomState(room);
      return;
    }

    case C2S.SET_READY: {
      const room = rooms.get(player.roomCode);
      if (!room) return;
      const ready = msg.ready === true;
      const loading = room.state === ROOM_STATE.LOADING;
      const lateReady = ready
        && !player.ready
        && !!room.sim
        && (room.state === ROOM_STATE.COUNTDOWN || room.state === ROOM_STATE.RACING);
      // Egy már elfogadott ready csomag megismétlődhet hálózati/UI okból. Ne
      // írjuk felül vele a kanonikus kezdőállapotot, és ne mutassunk hibát sem.
      if (ready && player.ready) return;
      if (!loading && !lateReady) {
        return fail(socket, ERR.READY_ONLY_WHILE_LOADING);
      }
      // Kliensfizikánál a betöltés végén már a pályára helyezett, helyes Y
      // pozíciót is elküldjük. Ha a nagyon gyors kliens megelőzte a vezérlő
      // elkészültét, ideiglenesen a playeren tartjuk, és startRace átveszi. A
      // 30 másodperces időkorlát után elkészülő kliens ugyanezt biztonságosan
      // megteheti COUNTDOWN/RACING alatt, ha még egy állapotát sem fogadtuk el.
      if (ready) {
        if (!msg.state) return fail(socket, ERR.READY_NEEDS_STATE);
        const initialState = sanitizeClientCarState(msg.state);
        if (!initialState) return fail(socket, ERR.BAD_INITIAL_STATE);
        initialState.seq = Math.trunc(Number(msg.state.seq) || 0);
        if (room.sim) {
          if (!room.sim.receiveInitialState?.(player.id, initialState)) {
            return fail(socket, ERR.INITIAL_STATE_REJECTED);
          }
          player.pendingInitialState = null;
        } else {
          player.pendingInitialState = initialState;
        }
      } else {
        // Ha betöltés közben visszavonja a készenlétet, a korábban félretett
        // állapot se kerülhessen később automatikusan az új vezérlőbe.
        player.pendingInitialState = null;
      }
      player.ready = ready;
      // Verseny előtti betöltés: ez volt az utolsó, akire vártunk?
      if (loading) {
        pushRoomState(room);
        maybeBeginCountdown(room);
      }
      return;
    }

    case C2S.START_RACE: {
      const room = rooms.get(player.roomCode);
      if (!room) return fail(socket, ERR.NOT_IN_ROOM);
      if (room.hostId !== player.id) return fail(socket, ERR.HOST_ONLY_START);
      const problem = room.canStart();
      if (problem) return fail(socket, problem);
      await startRace(room);
      return;
    }

    case C2S.STATE: {
      const room = rooms.get(player.roomCode);
      // Normál mozgást csak a kanonizált SET_READY kezdőállapot után fogadunk.
      // Így a betöltési időkorlát kivárásával sem lehet az első STATE csomagot
      // egyszeri, tetszőleges rajtrács-teleportként felhasználni.
      if (!player.ready) return;
      room?.sim?.receiveState?.(player.id, msg);
      return;
    }

    case C2S.RESET: {
      const room = rooms.get(player.roomCode);
      if (room?.mode === GAME_MODE.HOT_LAP) await restartHotLap(room);
      else room?.sim?.resetCar(player.id);
      return;
    }

    case C2S.PING: {
      // Ha az imént ért véget egy akadás nálunk, akkor ez a PING a mi sorunkban
      // várakozott — a kliens ezért eldobja a mintát (lásd loopLag.js).
      send(socket, S2C.PONG, { t: msg.t, serverNow: Date.now(), blockedMs: recentBlockMs() });
      return;
    }

    default:
      fail(socket, ERR.UNKNOWN_MESSAGE, String(msg.type));
  }
}

async function startRace(room) {
  const generation = ++room.raceGeneration;
  const raceId = await room.beginLoading();
  // A DB-művelet alatt a tulajdonos bezárhatta a lapot. Ilyenkor a szoba már
  // nincs a nyilvántartásban; nem indítunk hozzá árva fizikai időzítőt.
  if (rooms.get(room.code) !== room || room.size === 0 || room.raceGeneration !== generation) {
    await room.finishAttempt(raceId);
    return;
  }
  room.raceId = raceId;
  // A rajtsorrend futamonként új: csak az első N rajthelyet osztjuk ki az N
  // résztvevő között, véletlenszerűen. Itt történik, nem belépéskor, ezért a
  // host és a korábban érkezők sem kapnak állandó rajtpozíciót.
  if (room.mode === GAME_MODE.HOT_LAP) {
    for (const player of room.players.values()) player.slot = 7;
  } else {
    room.randomizeGridSlots();
  }
  const manifest = await getManifest();
  if (rooms.get(room.code) !== room || room.size === 0 || room.raceGeneration !== generation) return;
  const map = manifest.maps.find((m) => m.id === room.mapId);
  const ghost = await room.loadSelectedGhost(ghostLap);
  if (rooms.get(room.code) !== room || room.size === 0 || room.raceGeneration !== generation) return;

  // A rajtrács-pontok a pálya spawn.json-jából jönnek; ha kevesebb van, mint
  // ahány játékos, a közös rajtrács-logika folytatja hátrafelé a kiosztást.
  // A startsAt itt szándékosan NINCS: ez a "töltsd be" jel, nem a rajt. A
  // pontos rajtidőt a RACE_COUNTDOWN adja meg, ha mindenki megvan.
  const spawns = map?.spawns || [];
  broadcastRoom(room, S2C.RACE_STARTING, {
    mapId: room.mapId,
    laps: room.laps,
    mode: room.mode,
    ghostMode: room.ghostMode,
    mandatoryPitStop: room.mandatoryPitStop,
    pit: room.mandatoryPitStop ? (map?.pit || null) : null,
    ghost,
    spawns,
    hotLapSpawn: room.mode === GAME_MODE.HOT_LAP ? (map?.hotLapSpawn || null) : null,
    players: room.toJSON().players,
  });
  pushRoomState(room);

  // A versenyvezérlő befagyasztva indul, és a releaseAt oldja a rajtnál.
  const sim = new RaceController(room, {
    map,
    generation,
    raceId,
    broadcast: (type, data) => broadcastRoom(room, type, data),
  });
  try {
    await sim.start();
  } catch (err) {
    if (rooms.get(room.code) !== room || room.raceGeneration !== generation) {
      sim.stop();
      return;
    }
    // A szoba nem maradhat LOADING-ban: onnan sem indítani, sem csatlakozni nem
    // lehetne, vagyis az egész szoba használhatatlanná válna egy hibás pályától.
    console.error(`[${room.code}] A verseny nem indítható:`, err);
    sim.stop();
    await room.finishAttempt(raceId);
    room.state = ROOM_STATE.LOBBY;
    room.sim = null;
    broadcastRoom(room, S2C.ERROR, { code: ERR.RACE_START_FAILED, detail: err.message });
    pushRoomState(room);
    return;
  }
  // Az aszinkron indítás alatt is kiléphetett valaki. Az üres vagy már
  // lecserélt szobát teljesen leállítjuk; többjátékos szobánál pedig az
  // időközben távozott autókat eltávolítjuk, mielőtt egyetlen snapshot kimenne.
  if (rooms.get(room.code) !== room || room.size === 0 || room.raceGeneration !== generation) {
    sim.stop();
    return;
  }
  for (const playerId of [...sim.cars.keys()]) {
    if (!room.players.has(playerId)) sim.removeCar(playerId);
  }
  room.sim = sim;
  for (const player of room.players.values()) {
    if (player.pendingInitialState) {
      sim.receiveInitialState(player.id, player.pendingInitialState);
      player.pendingInitialState = null;
    }
  }

  // Ha a visszaszámlálás már elindult a vezérlő létrejötte előtt, a start()
  // átvette a szobától a meghirdetett rajtidőt.

  // Az időkorlát: ha valaki nem jelentkezik be készen, nélküle indulunk.
  room.loadTimer = setTimeout(() => maybeBeginCountdown(room, true), RACE_LOAD_TIMEOUT_MS);
  // Egyjátékos szoba (vagy már mindenki kész) esetén ne várjunk feleslegesen.
  maybeBeginCountdown(room);
}

async function restartHotLap(room) {
  if (room.mode !== GAME_MODE.HOT_LAP || room.restarting) return;
  room.restarting = true;
  try {
    // Az épp még aszinkron indítás alatt álló régi startRace azonnal érvényét
    // veszti; amikor elkészül, a generation-ellenőrzés leállítja.
    room.raceGeneration++;
    clearTimeout(room.loadTimer);
    room.loadTimer = null;
    room.sim?.stop();
    room.sim = null;
    room.state = ROOM_STATE.LOBBY;
    room.countdownEndsAt = 0;
    for (const player of room.players.values()) player.ready = false;
    await room.finishAttempt();
    if (rooms.get(room.code) === room && room.size === 1) await startRace(room);
  } finally {
    room.restarting = false;
  }
}

// Elindítja a 3-2-1-et, ha mindenki betöltött — vagy ha lejárt a türelmi idő.
// Ez az EGYETLEN hely, ahol a LOADING állapot COUNTDOWN-ra vált, hogy ne
// lehessen két visszaszámlálást indítani ugyanarra a versenyre.
function maybeBeginCountdown(room, timedOut = false) {
  if (room.state !== ROOM_STATE.LOADING) return;
  if (!timedOut && !room.allReady()) return;
  if (timedOut) {
    const missing = [...room.players.values()].filter((p) => !p.ready).map((p) => p.name);
    if (missing.length) console.warn(`[${room.code}] Betöltési időkorlát, nélkülük indulunk: ${missing.join(', ')}`);
  }
  clearTimeout(room.loadTimer);
  room.loadTimer = null;

  const startsAt = room.beginCountdown();
  room.sim?.releaseAt(startsAt);
  broadcastRoom(room, S2C.RACE_COUNTDOWN, { startsAt, countdownMs: room.countdownMs });
  pushRoomState(room);
}

export function attachWebSocket(httpServer) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: MAX_WS_PAYLOAD_BYTES,
  });

  wss.on('connection', (socket) => {
    const player = {
      id: randomUUID(),
      socket,
      name: null,
      dbId: null,
      token: null,
      roomCode: null,
      carId: null,
      slot: null,
      ready: false,
      pendingInitialState: null,
      rateLimits: new Map(),
      messageChain: Promise.resolve(),
    };
    players.set(player.id, player);
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });

    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        socket.close(1003, 'Csak JSON üzenet engedélyezett.');
        return;
      }
      // A teljes üzenetfolyamot még a JSON feldolgozása előtt korlátozzuk,
      // különben hibás JSON-nal ki lehetne kerülni a típusonkénti limitet.
      if (!consumeRate(player, 'all', 120, 180)) {
        socket.close(1008, 'Túl sok üzenet.');
        return;
      }
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return fail(socket, ERR.BAD_JSON);
      }
      if (!messageRateAllowed(player, msg?.type)) {
        socket.close(1008, 'Túl sok üzenet.');
        return;
      }
      // Az EventEmitter nem várja meg az async callbacket. Saját sor nélkül két
      // CREATE_ROOM ugyanazon await előtt ellenőrizné a roomCode-ot, majd két
      // szobát hozna létre. A lánc kapcsolatonként megőrzi a drót sorrendjét.
      player.messageChain = player.messageChain
        .then(async () => {
          if (!isActivePlayer(player)) return;
          await handleMessage(player, msg);
        })
        .catch((err) => {
          console.error('WS üzenet hiba:', err);
          if (isActivePlayer(player)) fail(socket, ERR.SERVER_ERROR);
        });
    });

    socket.on('close', () => {
      leaveRoom(player, true);
      players.delete(player.id);
    });

    socket.on('error', () => { /* a close úgyis lefut */ });
  });

  // Protokollszintű heartbeat: a böngésző akkor is automatikusan PONG-ol, ha a
  // JS főszála háttérben áll. A félbeszakadt TCP kapcsolat viszont a következő
  // körben terminate-et kap, és a rendes close takarítja a szobáját/szimulációját.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  wss.on('close', () => clearInterval(heartbeat));

  console.log('WebSocket: /ws');
  return wss;
}

export function roomStats() {
  return { rooms: rooms.size, players: players.size };
}
