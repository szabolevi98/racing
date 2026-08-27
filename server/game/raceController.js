// Online versenyvezérlő.
//
// A szerver nem épít Rapier világot és nem szimulálja újra
// az autókat. A saját autó fizikáját minden böngésző helyben futtatja; ide a
// kész állapot érkezik. A szerver továbbra is központilag kezeli a köröket,
// checkpointokat, sorrendet, eredményeket és a szellem rögzítését.
import {
  S2C, ROOM_STATE, GAME_MODE, TAINT, SNAPSHOT_RATE, requiredCheckpoints, FINISH_GRACE_MS,
} from '../../shared/protocol.js';
import { gridSlotPose, hotLapStartPose } from '../../shared/grid.js';
import { crossingTime, gateRespawnPoint } from '../../shared/gate.js';
import {
  allWheelsOffTrack, sampleZone, wheelProbes, ZONE_ASPHALT,
} from '../../shared/zone.js';
import { WHEEL_POSITIONS } from '../../shared/vehicleConfig.js';
import {
  GHOST_SAMPLE_MS, MAX_GHOST_FRAMES, makeGhostFrame, makeGhostReplay,
} from '../../shared/ghost.js';
import { createPitState, hasCompletePitConfig, updatePitState } from '../../shared/pit.js';
import { loadMapZoneRuntime } from './zoneRuntime.js';
import { measureServerWork } from '../loopLag.js';

const SNAPSHOT_MS = 1000 / SNAPSHOT_RATE;
// A pump() SŰRŰBBEN fut, mint amilyen gyakran snapshotot küld, és ennek oka van.
// A snapshot csak tick-en indulhat, tehát a két köz közti tényleges távolság a
// tick-rácsra kerekedik. 16 ms-os tickkel az 50 ms-os célból a legkisebb elérhető
// köz 64 ms — vagyis a szerver 20 Hz helyett ~15 Hz-cel küldene. 8 ms-mal a
// kerekítési hiba feleződik, a pump munkája pedig elhanyagolható (állapotváltás,
// snapshot-döntés, határidő-nézés).
//
// Mérve, valódi Node-időzítővel, 400 tick alatt:
//   16 ms + „last = now”:   66.1 ms átlag (15.1 Hz), 60-80 ms szórás
//   16 ms + akkumulátor:    49.9 ms (20.0 Hz), de 30-79 ms — a behozás sorozatot csinál
//   8 ms  + akkumulátor:    49.9 ms (20.0 Hz), 45-64 ms
const PUMP_MS = 8;
const MAX_ABS_POSITION = 100_000;
const MAX_LINEAR_SPEED = 180; // Durva csomagszűrés; a játékszabály szerinti határ lejjebb van.
const MAX_ANGULAR_SPEED = 100;
// A kliens természetes cél-végsebessége ~378 km/h, a csak rendellenes helyzetre
// szolgáló biztonsági plafonja 420. A szerver ennél is megengedőbb: egy rövid
// ütközési kilengés ne tegye tönkre az egész kört.
const MAX_VALID_HORIZONTAL_SPEED = 500 / 3.6;
const MAX_PLAUSIBLE_MOVEMENT_SPEED = 150; // 540 km/h a pozícióalapú, tartós ellenőrzéshez.
const MOVEMENT_PACKET_GRACE_METERS = 3;
const MOVEMENT_WINDOW_GRACE_METERS = 8;
// Rövid ütközési/fizikai korrekciók több egymás utáni csomagban is
// jelentkezhetnek. Ezeket az egycsomagos teleportlimit továbbra is fogja, a
// gördülő (összeadódó) vizsgálat viszont csak tartós eltérésre lépjen életbe.
const MOVEMENT_WINDOW_MIN_MS = 500;
const MOVEMENT_WINDOW_MAX_MS = 1_500;
// A kliens már szerverórára átszámolva küldi a fizikai lépés időpontját. Ezt
// csak szűk, szerver által ellenőrzött ablakban fogadjuk el: így a hálózaton
// összetorlódott állapotok megtartják a valódi időközüket, de egy módosított
// kliens nem gyárthat tetszőleges köridőt a saját órájából.
const MAX_CLIENT_STATE_AGE_MS = 5_000;
const MAX_CLIENT_STATE_CLOCK_LEAD_MS = 500;
const MIN_CLIENT_STATE_ADVANCE_MS = 1;
const MAX_CLIENT_CLOCK_BACKSTEP_MS = 50;
const RESET_ACK_RADIUS_METERS = 2;
const HOT_LAP_HISTORY_LIMIT = 64;
const SERVER_WHEEL_PROBES = wheelProbes(WHEEL_POSITIONS);

// A toFixed minden számhoz átmeneti stringet gyártott. Snapshotonként minden
// autónál több tucat ilyen keletkezett, majd a következő GC kidobta őket.
// Numerikus kerekítéssel ugyanazt a drótformátumot kapjuk string-allokációk nélkül.
const roundNumber = (value, factor) => Math.round(value * factor) / factor;
const roundArray = (values, factor) => values.map((value) => roundNumber(value, factor));

function finiteVector(raw, length, maxAbs) {
  if (!Array.isArray(raw) || raw.length !== length) return null;
  const values = raw.map(Number);
  if (!values.every((value) => Number.isFinite(value) && Math.abs(value) <= maxAbs)) return null;
  return values;
}

export function sanitizeClientCarState(raw) {
  const p = finiteVector(raw?.p, 3, MAX_ABS_POSITION);
  const q = finiteVector(raw?.q, 4, 2);
  const v = finiteVector(raw?.v, 3, MAX_LINEAR_SPEED);
  const w = finiteVector(raw?.w, 3, MAX_ANGULAR_SPEED);
  if (!p || !q || !v || !w) return null;
  const qLength = Math.hypot(...q);
  if (qLength < 0.5 || qLength > 1.5) return null;
  return {
    p,
    q: q.map((value) => value / qLength),
    v,
    w,
    st: Math.max(-1.5, Math.min(1.5, Number(raw.st) || 0)),
    wr: Math.max(-100_000, Math.min(100_000, Number(raw.wr) || 0)),
    th: Math.max(-1, Math.min(1, Number(raw.th) || 0)),
    offtrack: raw.offtrack === true,
  };
}

function horizontalDistance(a, b) {
  return Math.hypot(b.p[0] - a.p[0], b.p[2] - a.p[2]);
}

function clientStateTime(car, rawTime, receivedAt, { initial = false } = {}) {
  const candidate = Number(rawTime);
  if (!Number.isFinite(candidate)) {
    // Átmeneti kompatibilitás régi klienssel: ott csak a beérkezési idő áll
    // rendelkezésre. Az új kliens mindig küld `t`-t, ezért a csomagkötegek
    // helyes időköze azon az úton megmarad.
    return {
      at: Math.max(receivedAt, (car.lastMovementAt || receivedAt) + (initial ? 0 : MIN_CLIENT_STATE_ADVANCE_MS)),
      valid: true,
    };
  }
  const inServerWindow = candidate >= receivedAt - MAX_CLIENT_STATE_AGE_MS
    && candidate <= receivedAt + MAX_CLIENT_STATE_CLOCK_LEAD_MS;
  const monotonic = !car.lastMovementAt
    || candidate >= car.lastMovementAt + MIN_CLIENT_STATE_ADVANCE_MS;

  if (inServerWindow && (initial || monotonic)) return { at: candidate, valid: true };
  // A pingmintából becsült szerveróra néhány ms-ot hátra korrigálhat. Ez nem
  // hálózati állapot-visszalépés: kis tartományban monotonra igazítjuk, hogy
  // egy jó órakorrekció ne érvénytelenítsen egy teljes kört.
  if (inServerWindow && candidate >= car.lastMovementAt - MAX_CLIENT_CLOCK_BACKSTEP_MS) {
    return { at: car.lastMovementAt + MIN_CLIENT_STATE_ADVANCE_MS, valid: true };
  }
  if (initial) return { at: receivedAt, valid: true };

  // Régi/hibás kliensidővel nem próbálunk virtuális tickeket gyártani. A
  // beérkezési idő monoton pótlék, de a kör validációs hibát kap, ezért ebből
  // nem lehet rövid, hiteles kört készíteni.
  return {
    at: Math.max(receivedAt, (car.lastMovementAt || receivedAt) + MIN_CLIENT_STATE_ADVANCE_MS),
    valid: false,
  };
}

function hasImplausibleMovement(car, next, movementAt) {
  if (!car.lastMovementAt) return false;
  const elapsedMs = Math.max(0, movementAt - car.lastMovementAt);
  const packetLimit = MOVEMENT_PACKET_GRACE_METERS
    + MAX_PLAUSIBLE_MOVEMENT_SPEED * elapsedMs / 1_000;
  if (horizontalDistance(car.state, next) > packetLimit) return true;

  for (const sample of car.movementSamples) {
    const windowMs = movementAt - sample.at;
    if (windowMs < MOVEMENT_WINDOW_MIN_MS) continue;
    if (windowMs > MOVEMENT_WINDOW_MAX_MS) continue;
    const windowLimit = MOVEMENT_WINDOW_GRACE_METERS
      + MAX_PLAUSIBLE_MOVEMENT_SPEED * windowMs / 1_000;
    if (horizontalDistance(sample, next) > windowLimit) return true;
  }
  return false;
}

function recordMovementSample(car, state, movementAt) {
  car.movementSamples.push({ p: [...state.p], at: movementAt });
  const keepAfter = movementAt - MOVEMENT_WINDOW_MAX_MS;
  while (car.movementSamples.length > 1 && car.movementSamples[0].at < keepAfter) {
    car.movementSamples.shift();
  }
}

function exceedsSpeedLimit(state) {
  return Math.hypot(state.v[0], state.v[2]) > MAX_VALID_HORIZONTAL_SPEED;
}

function stateBody(state) {
  return {
    translation: () => ({ x: state.p[0], y: state.p[1], z: state.p[2] }),
    rotation: () => ({ x: state.q[0], y: state.q[1], z: state.q[2], w: state.q[3] }),
  };
}

function headingFrom(fromX, fromZ, toX, toZ, fallback) {
  const dx = toX - fromX, dz = toZ - fromZ;
  if (Math.abs(dx) < 1e-4 && Math.abs(dz) < 1e-4) return fallback;
  return Math.atan2(dx, dz);
}

function createRaceState(x, z, pitRequired = false) {
  return {
    lap: 0,
    nextCheckpoint: 0,
    passed: new Set(),
    taintReason: TAINT.NONE,
    hasCrossedStart: false,
    lapStart: 0,
    lapTimes: [],
    bestLapTime: null,
    ghostFrames: null,
    lastGhostSampleAt: 0,
    progressKey: -1,
    splits: new Map(),
    // A legutóbbi, pályán ELŐREFELÉ haladást jelentő checkpoint és a kör
    // kezdetétől mért ideje. Hiányzó kapu után is továbbhalad, miközben a kör
    // érvénytelen marad; különben a standings a rajtvonalig beragadna.
    // Ebből számol a kliens delta-kijelzője; azért a szerver adja, mert itt van
    // meg az interpolált átlépési idő — a kliens a 20 Hz-es snapshotokból
    // legfeljebb 50 ms pontossággal tippelhetne, ami századokat mérő
    // kijelzőnél használhatatlan.
    lastSplitIndex: -1,
    lastSplitMs: 0,
    finished: false,
    prevX: x,
    prevZ: z,
    prevAt: 0,
    validationAlertLap: -1,
    pit: createPitState(pitRequired),
  };
}

export class RaceController {
  constructor(room, { map, broadcast, generation = room.raceGeneration, raceId = room.raceId }) {
    this.room = room;
    this.map = map;
    this.broadcast = broadcast;
    this.generation = generation;
    this.raceId = raceId;
    this.cars = new Map();
    this.tick = 0;
    this.timer = null;
    this.startAt = Infinity;
    this.nextSnapshotAt = 0;
    this.stopped = false;
    // Az első befutó indítja; ekkortól ennyi ideje van a mezőny többi részének.
    // null = még senki sem ért célba, tehát nincs is mit visszaszámolni.
    this.finishDeadline = null;
    this.zoneRuntime = map?.zoneRuntime || null;
  }

  async start() {
    if (this.room.mode === GAME_MODE.MULTIPLAYER) {
      this.zoneRuntime ||= await loadMapZoneRuntime(this.map);
    }
    const spawns = this.map?.spawns?.length ? this.map.spawns : [{ x: 0, z: 0, heading: 0 }];
    let index = 0;
    for (const player of this.room.players.values()) {
      const spawn = this.room.mode === GAME_MODE.HOT_LAP
        ? hotLapStartPose(spawns, this.map?.hotLapSpawn)
        : gridSlotPose(spawns, player.slot ?? index);
      const half = (spawn.heading || 0) / 2;
      this.cars.set(player.id, {
        playerId: player.id,
        state: {
          p: [spawn.x, 0, spawn.z],
          q: [0, Math.sin(half), 0, Math.cos(half)],
          v: [0, 0, 0],
          w: [0, 0, 0],
          st: 0,
          wr: 0,
          th: 0,
          offtrack: false,
        },
        lastSeq: 0,
        lastAcceptedSeq: 0,
        lastStateAt: 0,
        lastMovementAt: 0,
        movementSamples: [],
        acceptTeleportOnce: true,
        pendingReset: null,
        respawn: { x: spawn.x, z: spawn.z, heading: spawn.heading || 0 },
        race: createRaceState(
          spawn.x,
          spawn.z,
          this.room.laps > 1
            && this.room.mandatoryPitStop === true
            && hasCompletePitConfig(this.map?.pit)
        ),
      });
      index++;
    }
    this.nextSnapshotAt = Date.now();
    this.timer = setInterval(() => this.pump(), PUMP_MS);
    if (this.room.countdownEndsAt) this.releaseAt(this.room.countdownEndsAt);
  }

  releaseAt(startAt) {
    this.startAt = startAt;
  }

  receiveState(playerId, raw, { initial = false, receivedAt = Date.now() } = {}) {
    const car = this.cars.get(playerId);
    if (!car || this.stopped) return false;
    const seq = Math.trunc(Number(raw?.seq) || 0);
    if (!initial && seq <= car.lastSeq) return false;
    const state = sanitizeClientCarState(raw);
    if (!state) return false;

    // A kliens szerverórára vetített fizikai időpontját ugyanaz az idővonal
    // használja a mozgásvizsgálathoz és a körórához. Az abszolút értéket és a
    // monoton haladást is a szerver korlátozza.
    const eventTime = Math.max(car.lastStateAt || -Infinity, receivedAt);
    if (!initial && car.pendingReset) {
      const distanceToTarget = Math.hypot(
        state.p[0] - car.pendingReset.x,
        state.p[2] - car.pendingReset.z
      );
      if (distanceToTarget > RESET_ACK_RADIUS_METERS) {
        // Az R elküldése és a CAR_RESET válasz megérkezése között a kliens még
        // küldhetett egy régi pozíciót. Ezt nem tekintjük új teleportnak, és a
        // szerver resetelt állapotát sem írhatja vissza a pálya másik pontjára.
        //
        // Nincs időkorlát: ha a kapcsolat pont a CAR_RESET előtt szakad meg,
        // a kliens csak újracsatlakozáskor kapja meg újra a célpontot. Egy
        // lejáró tranzakció ilyenkor visszaengedné a régi, reset előtti pózt.
        car.lastSeq = Math.max(car.lastSeq, seq);
        return false;
      }
      car.pendingReset = null;
      car.acceptTeleportOnce = true;
    }
    const stateClock = clientStateTime(car, raw?.t, eventTime, { initial });
    const movementAt = stateClock.at;
    const validationFailed = !initial && (
      !stateClock.valid
      || exceedsSpeedLimit(state)
      || (!car.acceptTeleportOnce && hasImplausibleMovement(car, state, movementAt))
    );

    // A zónatérkép a szerveren is rendelkezésre áll. Ha van, nem hisszük el a
    // kliens `offtrack` bitjét: ugyanazzal a négy kerékponttal számolunk, mint a
    // böngésző. Zónatérkép nélküli pályán marad a régi kompatibilis jelzés.
    if (this.zoneRuntime) {
      state.offtrack = allWheelsOffTrack(this.zoneRuntime, stateBody(state), SERVER_WHEEL_PROBES);
    }

    // A hibás állapot nemcsak a köridő szempontjából veszélyes: a fogadó
    // kliensek ezt a pózt használják a távoli autó megjelenítéséhez és a saját
    // autójukkal való kontakt számításához. Ezért nem relézzük és nem engedjük
    // kaput keresztezni sem. A sorszámot viszont elfogyasztjuk, hogy ugyanazt
    // a csomagot ne lehessen újrajátszani.
    if (validationFailed) {
      car.lastSeq = Math.max(car.lastSeq, seq);
      if (car.race.hasCrossedStart) this.flagServerValidation(car);
      return false;
    }

    car.state = state;
    car.lastSeq = Math.max(car.lastSeq, seq);
    car.lastAcceptedSeq = car.lastSeq;
    car.lastStateAt = eventTime;
    car.lastMovementAt = movementAt;
    car.acceptTeleportOnce = false;
    recordMovementSample(car, state, movementAt);

    if (initial || this.room.state !== ROOM_STATE.RACING || eventTime < this.startAt) {
      car.race.prevX = state.p[0];
      car.race.prevZ = state.p[2];
      car.race.prevAt = movementAt;
      return true;
    }
    this.updateCarProgress(car, movementAt);
    return true;
  }

  // A kliensnek csak a pálya talajmagasságát kell közölnie. Az X/Z helyet és
  // az irányt a szerver által kiosztott rajtpozícióból tartjuk meg, így a
  // betöltés végi ready csomag nem lehet tiszta rajtrács-teleport.
  receiveInitialState(playerId, raw, { receivedAt = Date.now() } = {}) {
    const car = this.cars.get(playerId);
    const state = sanitizeClientCarState(raw);
    if (!car || !state || this.stopped) return false;
    return this.receiveState(playerId, {
      ...state,
      seq: Math.trunc(Number(raw?.seq) || 0),
      t: raw?.t,
      p: [car.state.p[0], Math.max(-1_000, Math.min(10_000, state.p[1])), car.state.p[2]],
      q: [...car.state.q],
      v: [0, 0, 0],
      w: [0, 0, 0],
      st: 0,
      wr: 0,
      th: 0,
      offtrack: false,
    }, { initial: true, receivedAt });
  }

  flagServerValidation(car) {
    const r = car.race;
    if (!r.hasCrossedStart || r.finished) return;
    if (!r.taintReason) r.taintReason = TAINT.VALIDATION;
    if (r.validationAlertLap === r.lap) return;
    r.validationAlertLap = r.lap;
    this.broadcast(S2C.RACE_EVENT, {
      kind: 'validation', playerId: car.playerId, reason: TAINT.VALIDATION,
    });
  }

  pump(now = Date.now()) {
    if (this.stopped) return;
    if (now >= this.startAt && this.room.state === ROOM_STATE.COUNTDOWN) {
      this.room.state = ROOM_STATE.RACING;
      for (const car of this.cars.values()) car.race.lapStart = this.startAt;
    }
    // A következő időpontot NEM a mostani tickhez igazítjuk, hanem a tervezetthez
    // adunk hozzá egy periódust. Enélkül minden köz felfelé kerekedik a tick-rácsra
    // és a hiba HALMOZÓDIK — ez vitte a 20 Hz-et 15 Hz-re.
    if (now >= this.nextSnapshotAt) {
      this.nextSnapshotAt += SNAPSHOT_MS;
      // Hosszú akadás (GC, betöltés) után ne próbálja meg egyszerre behozni az
      // elmaradt snapshotokat: az sorozatban érkező csomagokat jelentene, ami a
      // kliens interpolációjának ugyanolyan rossz, mint a késés.
      if (this.nextSnapshotAt <= now) this.nextSnapshotAt = now + SNAPSHOT_MS;
      this.tick++;
      this.sendSnapshot(now);
    }
    // Lejárt a mezőny ideje: a még kint lévők az addigi állásukkal kerülnek az
    // eredménybe. A snapshot KÜLDÉSE UTÁN nézzük, hogy a kliensek lássák a
    // nullát is, ne az utolsó előtti tizeden ragadjon a visszaszámláló.
    if (this.finishDeadline !== null && now >= this.finishDeadline) void this.endRace();
  }

  resetCar(playerId) {
    const car = this.cars.get(playerId);
    if (!car || car.race.finished || !car.race.hasCrossedStart) return false;
    const { x, z, heading } = car.respawn;
    const half = heading / 2;
    car.state = {
      ...car.state,
      p: [x, car.state.p[1], z],
      q: [0, Math.sin(half), 0, Math.cos(half)],
      v: [0, 0, 0],
      w: [0, 0, 0],
      st: 0,
      wr: 0,
      th: 0,
      offtrack: false,
    };
    car.race.prevX = x;
    car.race.prevZ = z;
    const resetAt = Math.max(Date.now(), car.lastMovementAt || 0);
    car.race.prevAt = resetAt;
    car.lastStateAt = resetAt;
    car.lastMovementAt = resetAt;
    car.movementSamples = [{ p: [...car.state.p], at: car.lastMovementAt }];
    car.acceptTeleportOnce = true;
    car.pendingReset = { x, z, heading };
    this.broadcast(S2C.CAR_RESET, { playerId, respawn: { x, z, heading } });
    return true;
  }

  // Rövid kapcsolatvesztéskor a SESSION_RESUMED ezzel tudja újraküldeni a
  // még vissza nem igazolt resetet. A belső tranzakciót nem adjuk ki, csak a
  // kliensnek szükséges kanonikus pózt.
  pendingResetPose(playerId) {
    const pending = this.cars.get(playerId)?.pendingReset;
    return pending
      ? { x: pending.x, z: pending.z, heading: pending.heading || 0 }
      : null;
  }

  beginGhostRecording(car, now) {
    const r = car.race;
    r.ghostFrames = [];
    r.lastGhostSampleAt = now;
    const [x, y, z] = car.state.p;
    const [qx, qy, qz, qw] = car.state.q;
    r.ghostFrames.push(makeGhostFrame(0, { x, y, z }, { x: qx, y: qy, z: qz, w: qw }));
  }

  recordGhostFrame(car, now, force = false) {
    const r = car.race;
    if (!r.hasCrossedStart || !r.ghostFrames) return;
    if (!force && now - r.lastGhostSampleAt < GHOST_SAMPLE_MS) return;
    if (r.ghostFrames.length >= MAX_GHOST_FRAMES) {
      r.ghostFrames = null;
      return;
    }
    const [x, y, z] = car.state.p;
    const [qx, qy, qz, qw] = car.state.q;
    const frame = makeGhostFrame(
      now - r.lapStart, { x, y, z }, { x: qx, y: qy, z: qz, w: qw }
    );
    const last = r.ghostFrames.at(-1);
    if (force && last?.[0] >= frame[0]) r.ghostFrames[r.ghostFrames.length - 1] = frame;
    else r.ghostFrames.push(frame);
    r.lastGhostSampleAt = now;
  }

  finishGhostRecording(car, now) {
    this.recordGhostFrame(car, now, true);
    return makeGhostReplay(car.race.ghostFrames);
  }

  respawnPoint(gate, fromX, fromZ, toX, toZ) {
    return gateRespawnPoint(
      gate, fromX, fromZ, toX, toZ,
      (x, z) => sampleZone(this.zoneRuntime, x, z) === ZONE_ASPHALT
    );
  }

  restartCheckpointRejectedLap(car, crossedAt, checkpointCount) {
    const r = car.race;
    const baseKey = r.lap * (checkpointCount + 1);
    for (let key = baseKey + 1; key <= baseKey + checkpointCount; key++) r.splits.delete(key);
    r.progressKey = baseKey;
    r.splits.set(baseKey, crossedAt);
    r.nextCheckpoint = 0;
    r.passed.clear();
    r.taintReason = TAINT.NONE;
    r.lapStart = crossedAt;
    r.lastSplitIndex = -1;
    r.lastSplitMs = 0;
    this.beginGhostRecording(car, crossedAt);
    // A minimum alatt a rajtvonal nem zárhatja le a kört: ez akadályozza meg,
    // hogy valaki oda-vissza gurulással teljesítse a versenyt. A küszöböt elérő,
    // de hiányos kör viszont lezárul és érvénytelenként beleszámít a távba.
    this.broadcast(S2C.RACE_EVENT, {
      kind: 'lapRetry', playerId: car.playerId, startedAt: Math.round(crossedAt),
    });
  }

  updateCarProgress(car, now) {
    const gates = this.map?.gates;
    const r = car.race;
    if (car.race.finished) return;
    const x = car.state.p[0], z = car.state.p[2];
    const fromX = r.prevX, fromZ = r.prevZ;
    const fromAt = r.prevAt || now;
    r.prevX = x;
    r.prevZ = z;
    r.prevAt = now;
    updatePitState(r.pit, this.map?.pit, this.room.players.get(car.playerId)?.slot ?? 0, {
      fromX, fromZ, x, z, now,
      speedMps: Math.hypot(car.state.v[0], car.state.v[2]),
    });
    if (!gates?.start) return;
    const checkpoints = gates.checkpoints || [];
    this.recordGhostFrame(car, now);

    if (r.hasCrossedStart) {
      // Egy visszatartott STATE után ugyanaz a mozgásszakasz több, egymáshoz
      // közeli kaput is átvághat. Az összes metszést időrendben dolgozzuk fel:
      // a manifest sorrendje normál esetben ugyanaz, de egy ferde szakasznál
      // csak a metszési idő garantálja, hogy a valódi haladási sorrendet
      // kövessük. A korábbi `break` az első után eldobta a többit.
      const crossings = [];
      for (let i = 0; i < checkpoints.length; i++) {
        const crossedAt = crossingTime(checkpoints[i], fromX, fromZ, x, z, fromAt, now);
        if (crossedAt !== null) crossings.push({ i, crossedAt });
      }
      crossings.sort((a, b) => a.crossedAt - b.crossedAt || a.i - b.i);
      for (const { i, crossedAt } of crossings) {
        r.passed.add(i);
        if (i >= r.nextCheckpoint) {
          const skippedCheckpoint = i > r.nextCheckpoint;
          if (skippedCheckpoint) r.taintReason = TAINT.CHECKPOINT;
          // A nextCheckpoint a standings előrehaladási mutatója is. Ha egy
          // kapu kimaradt, a kör már érvénytelen, de a következő ténylegesen
          // érintett kapunál nem maradhat a teljes körre a régi helyen.
          r.nextCheckpoint = i + 1;
          const splitKey = r.lap * (checkpoints.length + 1) + i + 1;
          r.progressKey = splitKey;
          r.splits.set(splitKey, crossedAt);
          r.lastSplitIndex = i;
          r.lastSplitMs = Math.max(0, crossedAt - r.lapStart);
          // Az R ugyanoda kövesse az előrehaladást, mint a standings: ha egy
          // kapu kimaradt, a kör továbbra is érvénytelen, de egy későbbi,
          // ténylegesen átlépett checkpoint után ne dobjon vissza a kihagyás
          // előtti pontra. Ettől nem lesz érvényes a levágás, csak a respawn
          // viselkedik ugyanúgy, mint singleplayerben.
          car.respawn = {
            ...this.respawnPoint(checkpoints[i], fromX, fromZ, x, z),
            heading: headingFrom(fromX, fromZ, x, z, car.respawn.heading),
          };
        }
      }
    }

    if (r.hasCrossedStart && !r.taintReason && car.state.offtrack) {
      r.taintReason = TAINT.OFFTRACK;
    }

    const crossedAt = crossingTime(gates.start, fromX, fromZ, x, z, fromAt, now);
    if (crossedAt === null) return;
    if (!r.hasCrossedStart) {
      r.hasCrossedStart = true;
      r.nextCheckpoint = 0;
      r.passed.clear();
      r.taintReason = TAINT.NONE;
      r.lapStart = crossedAt;
      r.lastSplitIndex = -1;
      this.beginGhostRecording(car, crossedAt);
      r.progressKey = r.lap * (checkpoints.length + 1);
      r.splits.set(r.progressKey, crossedAt);
      car.respawn = {
        ...this.respawnPoint(gates.start, fromX, fromZ, x, z),
        heading: headingFrom(fromX, fromZ, x, z, car.respawn.heading),
      };
      return;
    }
    if (r.passed.size < requiredCheckpoints(checkpoints.length)) {
      r.taintReason = TAINT.CHECKPOINT;
      if (!this.room.endlessLaps) this.restartCheckpointRejectedLap(car, crossedAt, checkpoints.length);
      return;
    }

    car.respawn = {
      ...this.respawnPoint(gates.start, fromX, fromZ, x, z),
      heading: headingFrom(fromX, fromZ, x, z, car.respawn.heading),
    };
    if (r.passed.size < checkpoints.length) r.taintReason = TAINT.CHECKPOINT;
    if (!this.room.endlessLaps && r.lap + 1 >= this.room.laps && r.pit.required && !r.pit.completed) {
      r.taintReason = TAINT.PIT_STOP;
    }
    const invalid = !!r.taintReason;
    const time = crossedAt - r.lapStart;
    const ghost = invalid ? null : this.finishGhostRecording(car, crossedAt);
    const splitKey = (r.lap + 1) * (checkpoints.length + 1);
    r.progressKey = splitKey;
    r.splits.set(splitKey, crossedAt);
    r.lapTimes.push({ time, invalid });
    if (!invalid && (r.bestLapTime === null || time < r.bestLapTime)) r.bestLapTime = time;
    if (this.room.endlessLaps && r.lapTimes.length > HOT_LAP_HISTORY_LIMIT) {
      r.lapTimes.splice(0, r.lapTimes.length - HOT_LAP_HISTORY_LIMIT);
    }
    r.lap++;
    r.nextCheckpoint = 0;
    r.passed.clear();
    r.taintReason = TAINT.NONE;
    r.lapStart = crossedAt;
    // Új kör: a delta-kijelző ne az előző kör utolsó részidejét hasonlítgassa.
    r.lastSplitIndex = -1;
    if (this.room.endlessLaps) {
      // Hot Lapban egyetlen autó van, ezért a régi körök abszolút splitjeire
      // nincs szükség a mezőnyréshez. A jelenlegi rajtvonal-bejegyzés elég.
      r.splits.clear();
      r.splits.set(r.progressKey, crossedAt);
    }
    if (this.room.endlessLaps || r.lap < this.room.laps) this.beginGhostRecording(car, crossedAt);
    this.room.recordLap(
      this.room.players.get(car.playerId), r.lap, time, invalid, ghost, this.raceId
    ).catch(() => {});
    this.broadcast(S2C.RACE_EVENT, {
      kind: 'lap', playerId: car.playerId, lap: r.lap, timeMs: Math.round(time), invalid,
    });
    // Az Időmérés nem ér véget magától: a kör lezárul, elmentődik, és rögtön
    // indul a következő. A futamot a kilépés zárja le.
    if (!this.room.endlessLaps && r.lap >= this.room.laps) {
      r.finished = true;
      r.finishedAt = crossedAt;
      this.broadcast(S2C.RACE_EVENT, { kind: 'finished', playerId: car.playerId });
      this.armFinishDeadline(crossedAt);
    }
    if ([...this.cars.values()].every((entry) => entry.race.finished)) void this.endRace();
  }

  // Az első befutó elindítja a mezőny hátralévő idejét. Csak egyszer:
  // a másodiknak, harmadiknak beérkező NEM tolja ki a határidőt.
  //
  // Ha ekkor már mindenki célban van, nincs mit indítani — a hívó úgyis
  // azonnal lezárja a futamot. Ezért ez a feltétel egyben a Hot Lapot is
  // kizárja: ott egyetlen igazi autó van, amelyik a befutójával végzett is.
  // A kliens mozgásideje már szerveróra-tartományban van, ezért ugyanazon az
  // abszolút idővonalon képezhető belőle a pump() által figyelt határidő.
  armFinishDeadline(finishedAt) {
    if (this.finishDeadline !== null) return;
    if ([...this.cars.values()].every((entry) => entry.race.finished)) return;
    this.finishDeadline = finishedAt + FINISH_GRACE_MS;
  }

  orderedCars() {
    return [...this.cars.values()].sort((a, b) => {
      if (a.race.finished && b.race.finished) {
        return (a.race.finishedAt || Infinity) - (b.race.finishedAt || Infinity);
      }
      if (a.race.finished !== b.race.finished) return a.race.finished ? -1 : 1;
      if (a.race.progressKey !== b.race.progressKey) return b.race.progressKey - a.race.progressKey;
      const aAt = a.race.splits.get(a.race.progressKey) ?? Infinity;
      const bAt = b.race.splits.get(b.race.progressKey) ?? Infinity;
      return aAt - bAt;
    });
  }

  sendSnapshot(now) {
    return measureServerWork('snapshot_build', () => this.sendSnapshotMeasured(now));
  }

  sendSnapshotMeasured(now) {
    const ordered = this.orderedCars();
    const rankById = new Map(ordered.map((car, index) => [car.playerId, index + 1]));
    const leader = ordered[0] || null;
    const cars = [...this.cars.values()].map((car) => {
      const bestLap = car.race.bestLapTime;
      const lastLap = car.race.lapTimes.at(-1) || null;
      let gapMs = null;
      if (leader === car) gapMs = 0;
      else if (leader && car.race.progressKey >= 0) {
        const commonKey = Math.min(car.race.progressKey, leader.race.progressKey);
        const carAt = car.race.splits.get(commonKey);
        const leaderAt = leader.race.splits.get(commonKey);
        if (Number.isFinite(carAt) && Number.isFinite(leaderAt) && carAt >= leaderAt) {
          gapMs = carAt - leaderAt;
        }
      }
      return {
        id: car.playerId,
        p: roundArray(car.state.p, 1_000),
        q: roundArray(car.state.q, 10_000),
        v: roundArray(car.state.v, 100),
        w: roundArray(car.state.w, 1_000),
        st: roundNumber(car.state.st, 1_000),
        wr: roundNumber(car.state.wr, 100),
        th: car.race.finished ? 0 : roundNumber(car.state.th, 100),
        seq: car.lastAcceptedSeq,
        // Az állapot SAJÁT időpontja, nem a snapshot összeállításának ideje.
        // Változatlan autóállapot változatlan `at`-tal ismétlődik, így a kliens
        // felismeri a stale pózt és időben megszünteti annak kontaktjogát.
        at: Math.round(car.lastMovementAt),
        ti: car.race.taintReason,
        lap: car.race.lap,
        cp: car.race.nextCheckpoint,
        rk: rankById.get(car.playerId) || 0,
        gap: gapMs === null ? null : Math.round(gapMs),
        best: bestLap === null ? null : Math.round(bestLap),
        last: lastLap ? Math.round(lastLap.time) : null,
        li: !!lastLap?.invalid,
        ls: car.race.hasCrossedStart
          ? Math.round(car.race.lapStart)
          : null,
        fin: !!car.race.finished,
        pc: !!car.race.pit.completed,
        pi: !!car.race.pit.inLane,
        pt: Math.round(car.race.pit.stopElapsedMs),
        // A legutóbbi checkpoint sorszáma és a kör kezdetétől mért ideje — a
        // delta-kijelző alapja. Minden snapshotban megy, nem egyszeri
        // eseményként: így egy elveszett csomag nem hagy ki egy részidőt.
        ci: car.race.lastSplitIndex,
        ct: Math.round(car.race.lastSplitMs),
        // Küldött-e már valódi állapotot, vagy még a rajtrács-helyfoglalón ül?
        //
        // A kezdőállapotot a start() rakja össze a rajthelyből, ahol viszont
        // nincs magasság (spawn.json: csak x/z/heading), ezért y=0 — a pálya
        // szintje alatt akár több tíz méterrel. Amíg a játékos tölt, ez a
        // hamis magasság menne ki róla, és betöltéskor „felbukkanna” a talaj
        // alól. A kliens ebből tudja, hogy őt még nem szabad kirajzolni.
        rd: car.lastStateAt > 0,
      };
    });
    // `fd`: mikor zárul le magától a futam (szerver-óra szerint), vagy null.
    // Azért a snapshotban megy és nem egyszeri eseményként, mert így nem tud
    // elveszni: minden snapshot újra elmondja, tehát egy kimaradt csomag után
    // is helyreáll a visszaszámláló.
    this.broadcast(S2C.SNAPSHOT, { tick: this.tick, t: now, cars, fd: this.finishDeadline });
  }

  removeCar(playerId) {
    const removed = this.cars.delete(playerId);
    if (removed && this.cars.size && [...this.cars.values()].every((car) => car.race.finished)) {
      void this.endRace();
    }
    return removed;
  }

  async endRace() {
    if (this.stopped) return;
    // Egy már lecserélt Hot Lap-próbálkozás sem a szobát, sem az új futamot
    // nem írhatja felül. Ezt még bármilyen állapotváltoztatás előtt döntjük el.
    if ((this.room.sim && this.room.sim !== this)
      || (Number.isFinite(this.room.raceGeneration)
        && this.room.raceGeneration !== this.generation)) {
      this.stop();
      return;
    }
    this.stop();
    this.room.state = ROOM_STATE.FINISHED;
    // Ugyanaz a sorrend zárja a futamot, mint amit az utolsó élő snapshot
    // mutatott. A puszta `laps + completed-lap total` a még pályán lévő,
    // azonos körön haladó autókat rossz sorrendbe rendezte.
    const results = this.orderedCars()
      .map((car) => {
        const valid = car.race.lapTimes.filter((lap) => !lap.invalid).map((lap) => lap.time);
        return {
          playerId: car.playerId,
          carId: this.room.players.get(car.playerId)?.carId || '',
          lapsCompleted: car.race.lap,
          totalMs: Math.round(car.race.lapTimes.reduce((sum, lap) => sum + lap.time, 0)),
          bestLapMs: valid.length ? Math.round(Math.min(...valid)) : null,
          finishedAt: car.race.finishedAt || null,
        };
      });
    results.forEach((result, index) => { result.position = index + 1; });
    this.room.lastResults = results;

    // A hálózati lezárás nem várhat adatbázisra. Egy lassú vagy elérhetetlen
    // DB korábban befagyasztotta az eredményképernyőt, miközben a szerver már
    // leállította a snapshotokat. A mentés háttérben, a rögzített raceId-val
    // fut; a Room generációvédelme nem engedi, hogy egy új futamot leválasszon.
    this.broadcast(S2C.RACE_END, { results });
    this.room.state = ROOM_STATE.LOBBY;
    if (this.room.sim === this) this.room.sim = null;
    this.broadcast(S2C.ROOM_STATE, { room: this.room.toJSON() });
    this.persistence = Promise.resolve()
      .then(() => this.room.recordResults(results, this.raceId))
      .catch(() => {});
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
