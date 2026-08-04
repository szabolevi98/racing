// A kliens és a szerver közötti üzenetek típusai és közös állandói.
//
// Ez a fájl MINDKÉT oldalon fut (a böngésző a /shared/protocol.js útvonalon
// kapja meg), így a két oldal nem tud elcsúszni egymástól.

export const C2S = {
  HELLO: 'hello',              // { name, token? }        — belépés névvel
  CREATE_ROOM: 'createRoom',   // { mapId, carId, laps }
  JOIN_ROOM: 'joinRoom',       // { code, carId }
  LEAVE_ROOM: 'leaveRoom',
  SET_CAR: 'setCar',           // { carId }
  SET_READY: 'setReady',       // { ready }
  START_RACE: 'startRace',     // csak a szoba tulajdonosa
  INPUT: 'input',              // { seq, t, steer, throttle, brake }
  PING: 'ping',                // { t }
};

export const S2C = {
  WELCOME: 'welcome',          // { playerId, token, name }
  ROOM_STATE: 'roomState',     // { code, hostId, mapId, laps, state, players[] }
  ROOM_CLOSED: 'roomClosed',   // { reason }
  RACE_STARTING: 'raceStarting', // { countdownMs, spawns, tickRate }
  SNAPSHOT: 'snapshot',        // { tick, cars[] }  — a szerver hiteles állapota
  RACE_EVENT: 'raceEvent',     // { kind, playerId, ... } — kör, érvénytelenítés, célba érés
  RACE_END: 'raceEnd',         // { results[] }
  ERROR: 'error',              // { message }
  PONG: 'pong',                // { t }
};

// A szoba életciklusa.
export const ROOM_STATE = {
  LOBBY: 'lobby',
  COUNTDOWN: 'countdown',
  RACING: 'racing',
  FINISHED: 'finished',
};

// A szerver ennyiszer lépteti a fizikát másodpercenként. A kliens ugyanezzel
// a lépésközzel jósol előre, hogy a két szimuláció ne csússzon el.
export const TICK_RATE = 60;
export const TICK_MS = 1000 / TICK_RATE;

// Ennyiszer küld állapotot másodpercenként. Kevesebb, mint a tickRate — a
// kliens a köztes időt interpolálja, így a sávszélesség töredékére csökken
// anélkül, hogy a mozgás akadozna.
export const SNAPSHOT_RATE = 20;

export const MAX_PLAYERS_PER_ROOM = 8;
export const ROOM_CODE_LENGTH = 6;
export const COUNTDOWN_MS = 5000;

export const MAX_NAME_LENGTH = 20;

export function sanitizeName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return name || 'Névtelen';
}
