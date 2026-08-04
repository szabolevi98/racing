// WebSocket réteg: kapcsolatok, szobák, üzenetkezelés.
//
// A tényleges fizikai szimuláció a game/raceSim.js-ben él; ez a fájl csak a
// hálózati protokollt kezeli, és a szobákat tartja nyilván.
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import {
  C2S, S2C, ROOM_STATE, ROOM_CODE_LENGTH, sanitizeName, COUNTDOWN_MS, RACE_LOAD_TIMEOUT_MS,
} from '../../shared/protocol.js';
import { Room } from '../game/room.js';
import { upsertPlayer } from '../db/index.js';
import { getManifest } from '../assets.js';

const rooms = new Map();    // kód -> Room
const players = new Map();  // playerId -> player

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
  for (const p of room.players.values()) send(p.socket, type, data);
}

function pushRoomState(room) {
  broadcastRoom(room, S2C.ROOM_STATE, { room: room.toJSON() });
}

function leaveRoom(player, reason) {
  const room = rooms.get(player.roomCode);
  if (!room) return;
  const remaining = room.remove(player.id);
  if (remaining === 0) {
    room.sim?.stop();
    clearTimeout(room.loadTimer);
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
      const name = sanitizeName(msg.name);
      const rec = await upsertPlayer(name, msg.token).catch(() => ({ id: null, name, token: msg.token || randomUUID() }));
      player.name = name;
      player.dbId = rec.id;
      player.token = rec.token;
      send(socket, S2C.WELCOME, { playerId: player.id, token: rec.token, name });
      return;
    }

    case C2S.CREATE_ROOM: {
      if (!player.name) return fail(socket, 'Előbb add meg a neved.');
      if (player.roomCode) leaveRoom(player);
      const manifest = await getManifest();
      if (!manifest.maps.some((m) => m.id === msg.mapId)) return fail(socket, 'Nincs ilyen pálya.');
      const code = makeRoomCode();
      if (!code) return fail(socket, 'Nem sikerült szobakódot foglalni, próbáld újra.');
      const room = new Room(code, player, { mapId: msg.mapId, laps: msg.laps });
      room.add(player, msg.carId);
      rooms.set(code, room);
      pushRoomState(room);
      return;
    }

    case C2S.JOIN_ROOM: {
      if (!player.name) return fail(socket, 'Előbb add meg a neved.');
      const code = String(msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return fail(socket, 'Nincs ilyen szoba.');
      if (room.isFull) return fail(socket, 'A szoba megtelt.');
      if (room.state !== ROOM_STATE.LOBBY) return fail(socket, 'A verseny már elindult ebben a szobában.');
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

    case C2S.INPUT: {
      const room = rooms.get(player.roomCode);
      // A bemenetet a szimuláció dolgozza fel; itt csak eltároljuk a
      // legfrissebbet. (A szerver szimulál, a kliens csak kér.)
      room?.sim?.queueInput(player.id, msg);
      return;
    }

    case C2S.RESET: {
      const room = rooms.get(player.roomCode);
      room?.sim?.resetCar(player.id);
      return;
    }

    case C2S.PING: {
      send(socket, S2C.PONG, { t: msg.t });
      return;
    }

    default:
      fail(socket, 'Ismeretlen üzenet: ' + msg.type);
  }
}

async function startRace(room) {
  await room.beginLoading();
  const manifest = await getManifest();
  const map = manifest.maps.find((m) => m.id === room.mapId);

  // A rajtrács-pontok a pálya spawn.json-jából jönnek; ha kevesebb van, mint
  // ahány játékos, körbeforgunk rajtuk (a szimuláció szétdobja őket).
  // A startsAt itt szándékosan NINCS: ez a "töltsd be" jel, nem a rajt. A
  // pontos rajtidőt a RACE_COUNTDOWN adja meg, ha mindenki megvan.
  const spawns = map?.spawns || [];
  broadcastRoom(room, S2C.RACE_STARTING, {
    mapId: room.mapId,
    laps: room.laps,
    spawns,
    players: room.toJSON().players,
  });
  pushRoomState(room);

  // A szimulációt a raceSim modul indítja — külön fájlban, hogy ez a réteg
  // tisztán a hálózatról szóljon. Befagyasztva indul, és a releaseAt oldja.
  const { RaceSim } = await import('../game/raceSim.js');
  const sim = new RaceSim(room, { map, broadcast: (type, data) => broadcastRoom(room, type, data) });
  try {
    await sim.start();
  } catch (err) {
    // A szoba nem maradhat LOADING-ban: onnan sem indítani, sem csatlakozni nem
    // lehetne, vagyis az egész szoba használhatatlanná válna egy hibás pályától.
    console.error(`[${room.code}] A verseny nem indítható:`, err);
    sim.stop();
    room.state = ROOM_STATE.LOBBY;
    room.sim = null;
    broadcastRoom(room, S2C.ERROR, { message: 'A verseny nem indítható: ' + err.message });
    pushRoomState(room);
    return;
  }
  room.sim = sim;

  // Az időkorlát: ha valaki nem jelentkezik be készen, nélküle indulunk.
  room.loadTimer = setTimeout(() => maybeBeginCountdown(room, true), RACE_LOAD_TIMEOUT_MS);
  // Egyjátékos szoba (vagy már mindenki kész) esetén ne várjunk feleslegesen.
  maybeBeginCountdown(room);
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
  broadcastRoom(room, S2C.RACE_COUNTDOWN, { startsAt, countdownMs: COUNTDOWN_MS });
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
