// Egy versenyszoba: kik vannak bent, melyik pályán, és hol tart a verseny.
//
// A szoba a memóriában él — másodpercenként sokszor változik, és egy
// szerver-újraindítás után úgyis értelmét vesztené. Csak a lefutott verseny
// eredménye kerül adatbázisba.
import {
  ROOM_STATE, MAX_PLAYERS_PER_ROOM, COUNTDOWN_MS, PLAYER_COLORS, RACE_LOAD_TIMEOUT_MS,
} from '../../shared/protocol.js';
import { createRace, finishRace, saveResult, saveLap } from '../db/index.js';

export class Room {
  constructor(code, host, { mapId, laps, ghostMode = false }) {
    this.code = code;
    this.hostId = host.id;
    this.mapId = mapId;
    this.laps = Math.max(1, Math.min(20, Number(laps) || 3));
    // Szobaszintű és futam közben nem változtatható: minden kliensnek és a
    // hiteles szerverfizikának ugyanazt kell használnia.
    this.ghostMode = ghostMode === true;
    this.state = ROOM_STATE.LOBBY;
    this.players = new Map(); // playerId -> player
    this.raceId = null;       // adatbázis-beli verseny azonosító
    this.sim = null;          // a fizikai szimuláció (RaceSim), amíg megy a verseny
    this.countdownEndsAt = 0;
    this.loadingSince = 0;    // mikor kezdődött a betöltési szakasz (időkorláthoz)
    this.loadTimer = null;    // a betöltési időkorlát órája, hogy le is lehessen állítani
    this.createdAt = Date.now();
  }

  get size() {
    return this.players.size;
  }

  get isFull() {
    return this.players.size >= MAX_PLAYERS_PER_ROOM;
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
      ghostMode: this.ghostMode,
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

  // A rajt két szakaszra válik. Először LOADING: a kliensek megkapják, mit
  // töltsenek be, és jelentik, ha megvannak. A visszaszámlálás csak utána
  // indul — enélkül egy lassan töltő játékos a 3-2-1-ből csak az 1-et látta,
  // vagy a rajt után csöppent be.
  async beginLoading() {
    this.state = ROOM_STATE.LOADING;
    this.countdownEndsAt = 0;
    this.loadingSince = Date.now();
    // Új verseny: a korábbi "kész" jelzések nem érvényesek rá.
    for (const p of this.players.values()) p.ready = false;
    this.raceId = await createRace(this.code, this.mapId, this.laps).catch(() => null);
  }

  beginCountdown() {
    this.state = ROOM_STATE.COUNTDOWN;
    this.countdownEndsAt = Date.now() + COUNTDOWN_MS;
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

  async recordLap(player, lapNumber, timeMs, invalid) {
    await saveLap(this.raceId, player.dbId, lapNumber, timeMs, invalid).catch(() => {});
  }

  async recordResults(results) {
    for (const r of results) {
      const p = this.players.get(r.playerId);
      if (p) await saveResult(this.raceId, p.dbId, r).catch(() => {});
    }
    await finishRace(this.raceId).catch(() => {});
  }
}
