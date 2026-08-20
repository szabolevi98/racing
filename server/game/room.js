// Egy versenyszoba: kik vannak bent, melyik pályán, és hol tart a verseny.
//
// A szoba a memóriában él — másodpercenként sokszor változik, és egy
// szerver-újraindítás után úgyis értelmét vesztené. Csak a lefutott verseny
// eredménye kerül adatbázisba.
import {
  ROOM_STATE, GAME_MODE, MAX_PLAYERS_PER_ROOM, COUNTDOWN_MS, HOT_LAP_COUNTDOWN_MS,
  PLAYER_COLORS, RACE_LOAD_TIMEOUT_MS,
} from '../../shared/protocol.js';
import { createRace, finishRace, saveResult, saveLap } from '../db/index.js';

export class Room {
  constructor(code, host, {
    mapId, laps, ghostMode = false, mode = GAME_MODE.MULTIPLAYER, ghostPlayerId = null,
    isPublic = true, mandatoryPitStop = false,
  }) {
    this.code = code;
    this.hostId = host.id;
    // Publikus szoba: megjelenik a szobakeresőben, tehát ismeretlenek is
    // beléphetnek. A privát csak KÓDDAL érhető el — a listából kimarad, de
    // aki megkapja a kódot, ugyanúgy be tud lépni.
    //
    // Az Időmérés soha nem publikus: egyszemélyes, nincs mit meghirdetni.
    this.isPublic = mode !== GAME_MODE.HOT_LAP && isPublic !== false;
    this.mapId = mapId;
    this.laps = Math.max(1, Math.min(20, Number(laps) || 3));
    this.mode = mode === GAME_MODE.HOT_LAP ? GAME_MODE.HOT_LAP : GAME_MODE.MULTIPLAYER;
    this.ghostPlayerId = Number.isSafeInteger(ghostPlayerId) && ghostPlayerId > 0
      ? ghostPlayerId
      : null;
    // Az Időmérés indításakor kiválasztott konkrét visszajátszás az egész
    // szoba-életciklusra rögzül. Az R csak új próbálkozás, nem új
    // szellemválasztás, ezért nem kérjük le újra minden restartnál.
    this.selectedGhost = undefined;
    // Szobaszintű és futam közben nem változtatható: minden kliensnek ugyanazt
    // kell használnia.
    this.ghostMode = this.mode === GAME_MODE.HOT_LAP || ghostMode === true;
    this.mandatoryPitStop = this.mode !== GAME_MODE.HOT_LAP
      && this.laps > 1
      && mandatoryPitStop === true;
    this.state = ROOM_STATE.LOBBY;
    this.players = new Map(); // playerId -> player
    this.raceId = null;       // adatbázis-beli verseny azonosító
    this.sim = null;          // RaceController versenyvezérlő
    this.countdownEndsAt = 0;
    this.loadingSince = 0;    // mikor kezdődött a betöltési szakasz (időkorláthoz)
    this.loadTimer = null;    // a betöltési időkorlát órája, hogy le is lehessen állítani
    this.restarting = false;
    this.lastResults = null;   // rövid reconnect alatt elmulasztott RACE_END pótlásához
    this.raceGeneration = 0;  // az elkéső, már lecserélt vezérlők érvénytelenítéséhez
    this.createdAt = Date.now();
  }

  get size() {
    return this.players.size;
  }

  get isFull() {
    return this.players.size >= MAX_PLAYERS_PER_ROOM;
  }

  // Az Időmérésnek nincs körszám-korlátja: addig lehet körözni, ameddig a
  // játékos kedve tartja — nincs mit „megnyerni", minden kör önmagában mérés,
  // és mindegyik felkerül a ranglistára. A futam attól ér véget, hogy a
  // játékos kilép, nem attól, hogy elfogytak a körök.
  get endlessLaps() {
    return this.mode === GAME_MODE.HOT_LAP;
  }

  // Bent van-e MÁR ez a profil ebben a szobában, egy másik kapcsolaton?
  //
  // A `players` kulcsa a kapcsolatonként egyedi `player.id`, a profilt viszont
  // a token azonosítja — két füllel ugyanazzal a tokennel belépve tehát
  // ugyanaz az ember kétszer szerepelne a rajtrácson.
  //
  // Az `exceptId` a hívó SAJÁT kapcsolatát hagyja ki: aki már bent van és
  // ugyanabba a szobába lép be újra, az nem ütközik önmagával.
  hasProfile(token, exceptId) {
    if (!token) return false;
    for (const p of this.players.values()) {
      if (p.id !== exceptId && p.token === token) return true;
    }
    return false;
  }

  add(player, carId) {
    player.roomCode = this.code;
    player.carId = carId || null;
    player.ready = false;
    // A rajtrács-hely érkezési sorrendben; a szimuláció ez alapján osztja ki
    // a spawn pontokat, hogy ne egymáson induljanak.
    player.slot = this.nextFreeSlot();
    player.color = this.nextFreeColor();
    this.players.set(player.id, player);
  }

  remove(playerId) {
    const p = this.players.get(playerId);
    if (p) {
      p.roomCode = null;
      p.slot = null;
      p.color = null;
      this.players.delete(playerId);
    }
    // Ha a tulajdonos lépett ki, a legrégebben bent lévő veszi át — így a
    // szoba nem marad gazdátlanul (indíthatatlanul).
    if (playerId === this.hostId && this.players.size > 0) {
      this.hostId = this.players.keys().next().value;
    }
    return this.players.size;
  }

  nextFreeSlot() {
    const taken = new Set([...this.players.values()].map((p) => p.slot));
    for (let i = 0; i < MAX_PLAYERS_PER_ROOM; i++) if (!taken.has(i)) return i;
    return this.players.size;
  }

  // Minden futamhoz új rajtsorrend készül. Pontosan az első N rajthelyet
  // osztjuk ki az N játékos között Fisher–Yates keveréssel: három indulónál
  // tehát a 0/1/2 slot mind gazdára talál, de egyik sem kötődik a hosthoz vagy
  // a szobába érkezés sorrendjéhez. A random paraméter csak a tesztelhetőségért
  // injektálható; élesben a Math.random az alapértelmezett.
  randomizeGridSlots(random = Math.random) {
    const slots = Array.from({ length: this.players.size }, (_, index) => index);
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }
    let index = 0;
    for (const player of this.players.values()) player.slot = slots[index++];
  }

  // Szín a szoba palettájából: a szabadok közül VÉLETLENÜL választ, hogy két
  // egymás utáni verseny ne mindig ugyanabban a sorrendben osztódjon ki, de
  // egy szobán belül soha ne legyen két egyforma (a paletta pont annyi elemű,
  // mint a maximális létszám, tehát mindig van szabad).
  nextFreeColor() {
    const taken = new Set([...this.players.values()].map((p) => p.color));
    const free = PLAYER_COLORS.filter((c) => !taken.has(c));
    if (!free.length) return PLAYER_COLORS[this.players.size % PLAYER_COLORS.length];
    return free[Math.floor(Math.random() * free.length)];
  }

  canStart() {
    if (this.state !== ROOM_STATE.LOBBY) return 'A verseny már elindult.';
    if (this.players.size < 1) return 'Nincs játékos a szobában.';
    for (const p of this.players.values()) {
      if (!p.carId) return `${p.name} még nem választott kocsit.`;
    }
    return null;
  }

  // A kliensnek küldött, szerializálható kép a szobáról.
  toJSON() {
    return {
      code: this.code,
      hostId: this.hostId,
      mapId: this.mapId,
      laps: this.laps,
      mode: this.mode,
      ghostMode: this.ghostMode,
      mandatoryPitStop: this.mandatoryPitStop,
      isPublic: this.isPublic,
      state: this.state,
      countdownEndsAt: this.countdownEndsAt || null,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        carId: p.carId,
        slot: p.slot,
        color: p.color,
        ready: !!p.ready,
        isHost: p.id === this.hostId,
        connected: p.socket?.readyState === 1,
      })),
    };
  }

  // Meghirdethető-e a szobakeresőben? Csak a nyitott, még nem tele publikus
  // versenyszobák: egy futó versenybe úgysem lehetne belépni, a tele szobába
  // pedig hiába próbálkozna bárki.
  get isListable() {
    return this.isPublic
      && this.mode === GAME_MODE.MULTIPLAYER
      && this.state === ROOM_STATE.LOBBY
      && !this.isFull;
  }

  // Amit a kereső lát. Szándékosan kevesebb, mint a toJSON: ezt olyanok
  // kapják, akik NINCSENEK bent, nekik a bent lévők neve, színe és
  // készenléte nem tartozik rájuk — csak az, hova érdemes belépni.
  listing() {
    return {
      code: this.code,
      mapId: this.mapId,
      laps: this.laps,
      ghostMode: this.ghostMode,
      mandatoryPitStop: this.mandatoryPitStop,
      players: this.players.size,
      max: MAX_PLAYERS_PER_ROOM,
    };
  }

  // A rajt két szakaszra válik. Először LOADING: a kliensek megkapják, mit
  // töltsenek be, és jelentik, ha megvannak. A visszaszámlálás csak utána
  // indul — enélkül egy lassan töltő játékos a 3-2-1-ből csak az 1-et látta,
  // vagy a rajt után csöppent be.
  async beginLoading() {
    this.state = ROOM_STATE.LOADING;
    this.lastResults = null;
    this.countdownEndsAt = 0;
    this.loadingSince = Date.now();
    // Új verseny: a korábbi "kész" jelzések nem érvényesek rá.
    for (const p of this.players.values()) {
      p.ready = false;
      // Csak az aktuális betöltési generáció kezdőállapota használható. Az
      // előző futamé különben az új vezérlő létrejöttekor visszakerülhetne.
      p.pendingInitialState = null;
    }
    // Az elkészült azonosítót a startRace csak akkor kapcsolja a szobához,
    // ha ez a betöltési generáció még mindig aktuális. Két egymásra futó
    // próbálkozás így nem írhatja felül egymás raceId-ját.
    return createRace(this.code, this.mapId, this.laps).catch(() => null);
  }

  get countdownMs() {
    return this.mode === GAME_MODE.HOT_LAP ? HOT_LAP_COUNTDOWN_MS : COUNTDOWN_MS;
  }

  beginCountdown(now = Date.now()) {
    this.state = ROOM_STATE.COUNTDOWN;
    this.countdownEndsAt = now + this.countdownMs;
    return this.countdownEndsAt;
  }

  // Csak az ÉLŐ kapcsolatokat várjuk meg: egy félúton elhalt socket különben a
  // teljes időkorlátot rászabná mindenki másra.
  allReady() {
    for (const p of this.players.values()) {
      if (p.socket?.readyState === 1 && !p.ready) return false;
    }
    return true;
  }

  loadingExpired() {
    return Date.now() - (this.loadingSince || 0) >= RACE_LOAD_TIMEOUT_MS;
  }

  async loadSelectedGhost(loader) {
    if (this.mode !== GAME_MODE.HOT_LAP || !this.ghostPlayerId) return null;
    if (this.selectedGhost !== undefined) return this.selectedGhost;
    try {
      this.selectedGhost = await loader(this.mapId, this.ghostPlayerId) || null;
    } catch {
      this.selectedGhost = null;
    }
    return this.selectedGhost;
  }

  async recordLap(player, lapNumber, timeMs, invalid, ghost = null, raceId = this.raceId) {
    // A mapId azért kell, mert az érvényes kör a pályánkénti rekordot is
    // frissíti (map_records) — az a ranglista forrása, és túléli a versenyek
    // későbbi takarítását.
    await saveLap(raceId, player.dbId, lapNumber, timeMs, invalid, this.mapId, {
      carId: player.carId || '',
      ghost,
    }).catch(() => {});
  }

  async finishAttempt(raceId = this.raceId) {
    // Előbb választjuk le a szobáról, és csak utána várunk az adatbázisra.
    // Közben már indulhat új próbálkozás anélkül, hogy a régi lezárása annak
    // azonosítóját nullázná ki.
    if (this.raceId === raceId) this.raceId = null;
    await finishRace(raceId).catch(() => {});
  }

  async recordResults(results, raceId = this.raceId) {
    // A befejezett futamot azonnal leválasztjuk a szobáról. Közben már
    // indulhat új raceId-val a következő anélkül, hogy a régi mentése azt
    // később nullára írná. A játékosonkénti INSERT-ek egymástól függetlenek,
    // ezért nem kell sorban kivárni őket.
    if (this.raceId === raceId) this.raceId = null;
    await Promise.all(results.map(async (r) => {
      const p = this.players.get(r.playerId);
      if (p) await saveResult(raceId, p.dbId, r).catch(() => {});
    }));
    await finishRace(raceId).catch(() => {});
  }
}
