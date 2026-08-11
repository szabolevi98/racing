// WebSocket réteg: kapcsolatok, szobák, üzenetkezelés.
//
// A verseny állapotát a RaceController kezeli; ez a fájl a hálózati protokollt
// és a szobák életciklusát tartja kézben.
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import {
  C2S, S2C, ROOM_STATE, GAME_MODE, ROOM_CODE_LENGTH, sanitizeName, sanitizePlayerToken,
  RACE_LOAD_TIMEOUT_MS, paginateRooms,
} from '../../shared/protocol.js';
import { Room } from '../game/room.js';
import { RaceController } from '../game/raceController.js';
import {
  dbAvailable, findPlayerByToken, ghostLap, renamePlayer, upsertPlayer,
} from '../db/index.js';
import { getManifest } from '../assets.js';
import { recentBlockMs } from '../loopLag.js';

const rooms = new Map();    // kód -> Room
const players = new Map();  // playerId -> player
const MAX_BUFFERED_SNAPSHOTS = 3;

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

function fail(socket, message) {
  send(socket, S2C.ERROR, { message });
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
      if (player.roomCode) return fail(socket, 'Szobában nem válthatsz profilt.');
      const name = sanitizeName(msg.name);
      const token = sanitizePlayerToken(msg.token);
      const rec = await upsertPlayer(name, token)
        .catch(() => ({ id: null, name, token: token || randomUUID() }));
      welcomePlayer(player, rec);
      return;
    }

    case C2S.RESTORE_PROFILE: {
      if (player.roomCode) return fail(socket, 'Szobában nem válthatsz profilt.');
      const token = sanitizePlayerToken(msg.token);
      if (!token) return fail(socket, 'A megadott belépési token formátuma hibás.');
      if (!dbAvailable()) return fail(socket, 'A profil-visszaállítás jelenleg nem elérhető.');
      const rec = await findPlayerByToken(token);
      if (!rec) return fail(socket, 'Nincs profil ezzel a belépési tokennel.');
      welcomePlayer(player, rec);
      return;
    }

    case C2S.RENAME_PLAYER: {
      if (!player.name) return fail(socket, 'Előbb jelentkezz be.');
      if (player.roomCode) return fail(socket, 'A nevet a szobába belépés előtt módosítsd.');
      const name = sanitizeName(msg.name);
      if (!(await renamePlayer(player.dbId, name))) {
        return fail(socket, 'A név módosítása nem sikerült.');
      }
      player.name = name;
      send(socket, S2C.PROFILE_UPDATED, { name });
      return;
    }

    case C2S.CREATE_ROOM: {
      if (!player.name) return fail(socket, 'Előbb add meg a neved.');
      if (player.roomCode) leaveRoom(player);
      const manifest = await getManifest();
      if (!manifest.maps.some((m) => m.id === msg.mapId)) return fail(socket, 'Nincs ilyen pálya.');
      const code = makeRoomCode();
      if (!code) return fail(socket, 'Nem sikerült szobakódot foglalni, próbáld újra.');
      const room = new Room(code, player, {
        mapId: msg.mapId,
        laps: msg.laps,
        ghostMode: msg.ghostMode === true,
        isPublic: msg.isPublic !== false,
      });
      room.add(player, msg.carId);
      rooms.set(code, room);
      pushRoomState(room);
      return;
    }

    case C2S.LIST_ROOMS: {
      if (!player.name) return fail(socket, 'Előbb add meg a neved.');
      sendRoomList(socket, Math.trunc(Number(msg.page) || 0));
      return;
    }

    case C2S.START_HOT_LAP: {
      if (!player.name) return fail(socket, 'Előbb add meg a neved.');
      if (player.roomCode) leaveRoom(player);
      const manifest = await getManifest();
      const map = manifest.maps.find((m) => m.id === msg.mapId);
      const car = manifest.cars.find((c) => c.id === msg.carId);
      if (!map) return fail(socket, 'Nincs ilyen pálya.');
      if (!car) return fail(socket, 'Nincs ilyen kocsi.');
      const code = makeRoomCode();
      if (!code) return fail(socket, 'Nem sikerült időmérést indítani, próbáld újra.');
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
      if (!player.name) return fail(socket, 'Előbb add meg a neved.');
      const code = String(msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return fail(socket, 'Nincs ilyen szoba.');
      if (room.mode === GAME_MODE.HOT_LAP) return fail(socket, 'Ez egy egyszemélyes időmérés.');
      if (room.isFull) return fail(socket, 'A szoba megtelt.');
      if (room.state !== ROOM_STATE.LOBBY) return fail(socket, 'A verseny már elindult ebben a szobában.');
      // Ugyanaz a profil ne kerüljön kétszer ugyanabba a szobába (két fül,
      // egy token). Másik szobában párhuzamosan viszont szabad — az nem
      // rontja el egyik futam rajtrácsát sem.
      if (room.hasProfile(player.token, player.id)) {
        return fail(socket, 'Ezzel a profillal már bent vagy ebben a szobában.');
      }
      if (player.roomCode) leaveRoom(player);
      room.add(player, msg.carId);
      pushRoomState(room);
      return;
    }

    case C2S.LEAVE_ROOM: {
      leaveRoom(player, true);
      send(socket, S2C.ROOM_CLOSED, { reason: 'Kiléptél a szobából.' });
      return;
    }

    case C2S.SET_CAR: {
      const room = rooms.get(player.roomCode);
      if (!room) return;
      if (room.state !== ROOM_STATE.LOBBY) return fail(socket, 'Verseny közben nem lehet kocsit váltani.');
      player.carId = msg.carId || null;
      pushRoomState(room);
      return;
    }

    case C2S.SET_READY: {
      const room = rooms.get(player.roomCode);
      if (!room) return;
      // Kliensfizikánál a betöltés végén már a pályára helyezett, helyes Y
      // pozíciót is elküldjük. Ha a nagyon gyors kliens megelőzte a vezérlő
      // elkészültét, ideiglenesen a playeren tartjuk, és startRace átveszi.
      if (msg.state) {
        if (room.sim) {
          room.sim.receiveState?.(player.id, msg.state, { initial: true });
          player.pendingInitialState = null;
        } else {
          player.pendingInitialState = msg.state;
        }
      }
      player.ready = !!msg.ready;
      pushRoomState(room);
      // Verseny előtti betöltés: ez volt az utolsó, akire vártunk?
      maybeBeginCountdown(room);
      return;
    }

    case C2S.START_RACE: {
      const room = rooms.get(player.roomCode);
      if (!room) return fail(socket, 'Nem vagy szobában.');
      if (room.hostId !== player.id) return fail(socket, 'Csak a szoba tulajdonosa indíthatja a versenyt.');
      const problem = room.canStart();
      if (problem) return fail(socket, problem);
      await startRace(room);
      return;
    }

    case C2S.STATE: {
      const room = rooms.get(player.roomCode);
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
      fail(socket, 'Ismeretlen üzenet: ' + msg.type);
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
    broadcastRoom(room, S2C.ERROR, { message: 'A verseny nem indítható: ' + err.message });
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
      sim.receiveState(player.id, player.pendingInitialState, { initial: true });
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
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

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
      lastSeen: Date.now(),
    };
    players.set(player.id, player);

    socket.on('message', async (raw) => {
      player.lastSeen = Date.now();
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return fail(socket, 'Hibás üzenet (nem JSON).');
      }
      try {
        await handleMessage(player, msg);
      } catch (err) {
        console.error('WS üzenet hiba:', err);
        fail(socket, 'Szerverhiba az üzenet feldolgozásakor.');
      }
    });

    socket.on('close', () => {
      leaveRoom(player, true);
      players.delete(player.id);
    });

    socket.on('error', () => { /* a close úgyis lefut */ });
  });

  // Elhalt kapcsolatok kitakarítása: a böngésző nem mindig zárja rendesen.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const p of players.values()) {
      if (p.socket.readyState !== 1 && now - p.lastSeen > 30000) {
        leaveRoom(p, true);
        players.delete(p.id);
      }
    }
  }, 15000);
  wss.on('close', () => clearInterval(sweep));

  console.log('WebSocket: /ws');
  return wss;
}

export function roomStats() {
  return { rooms: rooms.size, players: players.size };
}
