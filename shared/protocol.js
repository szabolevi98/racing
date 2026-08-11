// A kliens és a szerver közötti üzenetek típusai és közös állandói.
//
// Ez a fájl MINDKÉT oldalon fut (a böngésző a /shared/protocol.js útvonalon
// kapja meg), így a két oldal nem tud elcsúszni egymástól.

export const C2S = {
  HELLO: 'hello',              // { name, token? }        — belépés névvel
  RESTORE_PROFILE: 'restoreProfile', // { token }         — meglévő profil visszaállítása
  RENAME_PLAYER: 'renamePlayer',     // { name }          — bejelentkezett profil átnevezése
  CREATE_ROOM: 'createRoom',   // { mapId, carId, laps, ghostMode, isPublic }
  LIST_ROOMS: 'listRooms',     // — a nyitott publikus szobák listáját kéri
  START_HOT_LAP: 'startHotLap', // { mapId, carId, ghostPlayerId? }
  JOIN_ROOM: 'joinRoom',       // { code, carId }
  LEAVE_ROOM: 'leaveRoom',
  SET_CAR: 'setCar',           // { carId }
  SET_READY: 'setReady',       // { ready }
  START_RACE: 'startRace',     // csak a szoba tulajdonosa
  STATE: 'state',              // { seq, t, p, q, v, w, st, wr, th, offtrack }
  RESET: 'reset',              // az "R": multi = checkpoint, Hot Lap = teljes újrakezdés
  PING: 'ping',                // { t }
};

export const S2C = {
  WELCOME: 'welcome',          // { playerId, token, name }
  PROFILE_UPDATED: 'profileUpdated', // { name }
  ROOM_STATE: 'roomState',     // { code, hostId, mapId, laps, ghostMode, state, players[] }
  ROOM_LIST: 'roomList',       // { rooms: [{ code, mapId, laps, ghostMode, players, max }] }
  ROOM_CLOSED: 'roomClosed',   // { reason }
  RACE_STARTING: 'raceStarting', // { spawns, mapId, laps, ghostMode, players } — TÖLTS BE
  RACE_COUNTDOWN: 'raceCountdown', // { startsAt, countdownMs } — mindenki kész, indul a 3-2-1
  SNAPSHOT: 'snapshot',        // { tick, cars[] }  — a szerver hiteles állapota
  CAR_RESET: 'carReset',       // { playerId, respawn:{x,z,heading} }
  RACE_EVENT: 'raceEvent',     // { kind, playerId, ... } — kör, érvénytelenítés, célba érés
  RACE_END: 'raceEnd',         // { results[] }
  ERROR: 'error',              // { message }
  PONG: 'pong',                // { t, serverNow, blockedMs } — blockedMs: a szerver saját akadása
};

// Mi rontotta el a folyamatban lévő kört. A snapshot `ti` mezője ezt küldi,
// és a kliens ebből írja ki, MIÉRT érvénytelen — egy puszta igen/nem bitből a
// játékos nem tudja, mit csinált másképp legközelebb. Egyjátékosban ugyanezek
// a kódok járnak körbe, hogy a szöveg egy helyen éljen.
// A NONE szándékosan 0, hogy a puszta igazságérték-vizsgálat is működjön.
export const TAINT = {
  NONE: 0,
  OFFTRACK: 1,    // mind a négy kerék lehagyta az aszfaltot
  CHECKPOINT: 2,  // kimaradt egy checkpoint
  VALIDATION: 3,  // a kliensállapot szerveroldali hihetőségvizsgálata jelzett
};

// Mennyi checkpointot kell ÖSSZESEN érinteni ahhoz, hogy a rajtvonal lezárja a
// kört. Nem sorrendben — arra a taint való —, hanem darabszámra.
//
// Miért kell egyáltalán küszöb: a crossedGate iránytól függetlenül metsz
// szakaszt, ezért a rajtvonalon oda-vissza gurulva végig lehetne "menni" a
// versenyen. Valamennyi tényleges körbeérést tehát meg kell követelni.
//
// Miért nem 100%: akkor egyetlen kihagyott kapu miatt a kör csak a KÖVETKEZŐ
// körben zárulna le (a sorrend-mutató a kihagyott kapun ragad), vagyis egy
// apró hiba egy egész körbe kerülne.
//
// Miért pont 0.8: ez az arány közvetlenül azt szabja meg, mennyit lehet
// LEVÁGNI a pályából — a kapuk nagyjából egyenletesen oszlanak el. 0.5-nél
// valaki átvághatna az infielden, kihagyhatná a pálya felét, és fél idő alatt
// teljesítené a versenyt (a kör érvénytelen lenne, de a körszámlálóba akkor is
// beleszámít). 0.8 mellett a levágás legfeljebb a pálya ötöde, tisztességes
// vezetésnél viszont bőven belefér az 1-2 elnézett kapu.
export const LAP_MIN_CHECKPOINT_RATIO = 0.8;

// Hány kaput kell érinteni egy adott pályán. Közös függvény, mert a kliens és a
// szerver ugyanazt kell számolja — különben másképp döntenének a kör lezárásáról.
export function requiredCheckpoints(total) {
  return Math.ceil(total * LAP_MIN_CHECKPOINT_RATIO);
}

// A szoba életciklusa.
//
// A LOADING külön állapot, és nem kényelmi kérdés: a pálya 100+ MB, egy hideg
// cache-ű kliens ennyi idő alatt a teljes visszaszámlálást elégeti letöltéssel,
// és a rajt után csöppen be. Ezért a 3-2-1 csak akkor indul, ha mindenki
// jelentette, hogy betöltött (vagy lejárt a RACE_LOAD_TIMEOUT_MS).
export const ROOM_STATE = {
  LOBBY: 'lobby',
  LOADING: 'loading',
  COUNTDOWN: 'countdown',
  RACING: 'racing',
  FINISHED: 'finished',
};

export const GAME_MODE = {
  MULTIPLAYER: 'multiplayer',
  HOT_LAP: 'hotLap',
};

// A kliens ennyiszer lépteti a saját fizikáját és küldi az állapotát
// másodpercenként. A szerver ezeket ellenőrzi és továbbítja.
export const TICK_RATE = 60;
export const TICK_MS = 1000 / TICK_RATE;

// Ennyiszer küld állapotot másodpercenként. Kevesebb, mint a tickRate — a
// kliens a köztes időt interpolálja, így a sávszélesség töredékére csökken
// anélkül, hogy a mozgás akadozna.
export const SNAPSHOT_RATE = 20;

// Játékos-színek. A szoba osztja ki őket (szerver = hiteles forrás), hogy
// MINDENKI ugyanazt a színt lássa ugyanahhoz a játékoshoz — a minitérképen, a
// névtáblán és a HUD-listán is. Pontosan MAX_PLAYERS_PER_ROOM darab van, tehát
// egy tele szobában sincs két egyforma. Egymástól jól elváló, telített
// árnyalatok: sötét pályán és a világos aszfalton is felismerhetők.
export const PLAYER_COLORS = [
  '#ff3b3b', // piros
  '#3b9dff', // kék
  '#3bff6e', // zöld
  '#ffd23b', // sárga
  '#c471ff', // lila
  '#ff8c3b', // narancs
  '#3bf0ff', // türkiz
  '#ff5fc4', // rózsaszín
];

export const MAX_PLAYERS_PER_ROOM = 8;
export const ROOM_CODE_LENGTH = 6;
export const COUNTDOWN_MS = 5000;
export const HOT_LAP_COUNTDOWN_MS = 3000;
// Meddig várunk a betöltésre, mielőtt a hiányzók nélkül is elindulnánk. Kell a
// felső korlát: egy beragadt vagy elhalt kliens különben a végtelenségig
// túszként tartaná az egész szobát.
export const RACE_LOAD_TIMEOUT_MS = 30000;

// Mennyi ideje van a mezőnynek célba érni az ELSŐ befutó után. Utána a verseny
// magától lezárul, a még kint lévők az addigi állásukkal.
//
// Miért kell: enélkül egyetlen félreállt vagy elnavigált autó a végtelenségig
// bent tartja a többieket — nekik nincs mit tenniük, csak nézik a célvonalat.
// Ez a valódi versenyekben is bevett: a győztes befutója után korlátos ideig
// tart a futam.
//
// Miért a szerver dönt: ugyanaz az elv, mint a köröknél — a kliens csak
// KIÍRJA a hátralévő időt, a lezárást a szerver mondja ki.
export const FINISH_GRACE_MS = 60000;

export const MAX_NAME_LENGTH = 20;
export const PLAYER_TOKEN_LENGTH = 36;

export function sanitizePlayerToken(raw) {
  const token = String(raw ?? '').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token)
    ? token
    : '';
}

export function sanitizeName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return name || 'Névtelen';
}
