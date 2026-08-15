// Online versenyvezérlő.
//
// A szerver nem épít Rapier világot és nem szimulálja újra
// az autókat. A saját autó fizikáját minden böngésző helyben futtatja; ide a
// kész állapot érkezik. A szerver továbbra is központilag kezeli a köröket,
// checkpointokat, sorrendet, eredményeket és a szellem rögzítését.
import {
  S2C, ROOM_STATE, GAME_MODE, TAINT, TICK_MS, SNAPSHOT_RATE, requiredCheckpoints,
  FINISH_GRACE_MS,
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

const SNAPSHOT_MS = 1000 / SNAPSHOT_RATE;
const MAX_ABS_POSITION = 100_000;
const MAX_LINEAR_SPEED = 180; // Durva csomagszűrés; a játékszabály szerinti határ lejjebb van.
const MAX_ANGULAR_SPEED = 100;
// A kliens fizikai végsebessége 378 km/h. A szerver ennél szándékosan jóval
// megengedőbb: egy rövid ütközési kilengés ne tegye tönkre az egész kört.
const MAX_VALID_HORIZONTAL_SPEED = 500 / 3.6;
const MAX_PLAUSIBLE_MOVEMENT_SPEED = 150; // 540 km/h a pozícióalapú, tartós ellenőrzéshez.
const MAX_MOVEMENT_SEQUENCE_GAP = 12;
const MOVEMENT_PACKET_GRACE_METERS = 3;
const MOVEMENT_WINDOW_GRACE_METERS = 8;
// Rövid ütközési/fizikai korrekciók több egymás utáni csomagban is
// jelentkezhetnek. Ezeket az egycsomagos teleportlimit továbbra is fogja, a
// gördülő (összeadódó) vizsgálat viszont csak tartós eltérésre lépjen életbe.
const MOVEMENT_WINDOW_MIN_MS = 500;
const MOVEMENT_WINDOW_MAX_MS = 1_500;
// A csomagsorszám segíthet a hálózaton összetorlódott állapotok időzítésében, de
// nem gyárthat korlátlanul a szerver órája elé futó „virtuális időt”.
const MAX_MOVEMENT_CLOCK_LEAD_MS = 1_000;
const RESET_ACK_RADIUS_METERS = 2;
const RESET_ACK_TIMEOUT_MS = 5_000;
const HOT_LAP_HISTORY_LIMIT = 64;
const SERVER_WHEEL_PROBES = wheelProbes(WHEEL_POSITIONS);

const roundArray = (values, digits) => values.map((value) => +value.toFixed(digits));

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

function nextMovementTime(car, seq, receivedAt) {
  if (!car.lastMovementAt || !car.lastStateAt) return receivedAt;
  const sequenceDelta = Math.max(1, Math.min(MAX_MOVEMENT_SEQUENCE_GAP, seq - car.lastSeq));
  // Pingkiugrás után több, egymást követő fizikai állapot egyszerre érkezhet be.
  // A sorszám csak korlátozott időt adhat hozzá, ezért nem használható tetszőleges
  // teleport elfedésére, a szabályos 60 Hz-es mozgást viszont nem tömörítjük össze.
  //
  // A két forrás VERSENYEZ, nem adódik össze. Korábban a lépés
  // `lastMovementAt + max(beérkezési különbség, sorszám × TICK_MS)` volt, ami
  // egyirányú racsni: minden korán érkező csomagnál a sorszám-alapú (nagyobb)
  // tagot írta jóvá, a többletet pedig sosem adta vissza. Mérve, szabályos
  // 60 Hz-es küldésnél és ±4 ms-os, NULLA ÁTLAGÚ szórásnál: 7 másodperc
  // vezetés után 763 ms előny, majd beállás a plafonra. Mivel a kapuk is ezen
  // az órán kapnak időbélyeget, a kör kezdete ennyivel későbbre csúszott — a
  // szellem pontosan ennyit várt a rajtvonalnál, mielőtt elindult.
  //
  // A maximum-képzés ugyanazt a védelmet adja (kötegnél a beérkezési idő alig
  // mozdul, tehát a sorszám-tag nyer), de szabályos forgalomnál az óra
  // visszasimul a beérkezési időhöz, így nem halmozódik.
  const projected = Math.max(car.lastMovementAt + sequenceDelta * TICK_MS, receivedAt);
  return Math.min(projected, receivedAt + MAX_MOVEMENT_CLOCK_LEAD_MS);
}

// Mennyivel jár a mozgás-óra a valós beérkezési idő előtt.
//
// Egy pingkiugrás után a szerver ugyanazt a szünetet KÉTSZER számolja el: a
// fali órára is felzárkózik ("az előző csomag óta eltelt fél másodperc"), és a
// kupacban beérkezett állapotoknak is fizet egy-egy fizikai lépést. Mindkettőre
// szükség van — az első nélkül lemaradna az idővonal, a második nélkül az
// állapotok nulla idő alatt tett távnak, azaz teleportnak látszanának —, de az
// előny így nem simul vissza soha (mérve: fél másodperces akadás 480 ms tartós
// előnyt hagy, 30 másodperc múlva is).
//
// Befelé ez nem baj: a köridők és a részidők KÜLÖNBSÉGEK ugyanezen az órán,
// tehát az előny kiesik belőlük. Kifelé viszont minden olyan időbélyegből le
// kell vonni, amit a kliens a saját faliórájához hasonlít — különben pont
// ennyivel csúszik el.
function clockLead(car) {
  return Math.max(0, (car.lastMovementAt || 0) - (car.lastStateAt || 0));
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
    // Mennyit sietett a mozgás-óra, amikor ez a kör elindult — lásd clockLead().
    // A kliensnek küldött kör-kezdet ezzel korrigálva megy ki, hogy a szellem
    // és a futó óra a valódi faliórához igazodjon.
    lapStartLead: 0,
    lapTimes: [],
    bestLapTime: null,
    ghostFrames: null,
    lastGhostSampleAt: 0,
    progressKey: -1,
    splits: new Map(),
    // A legutóbb SORRENDBEN érintett checkpoint és a kör kezdetétől mért ideje.
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
    this.lastSnapshotAt = 0;
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
    this.lastSnapshotAt = Date.now() - SNAPSHOT_MS;
    this.timer = setInterval(() => this.pump(), Math.max(8, Math.floor(TICK_MS)));
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

    // A kliens `t` mezője csak hálózati diagnosztika lehet. A szerver saját,
    // monoton idővonalát a beérkezési időből és a korlátozott sorszámkülönbségből
    // építi; ugyanaz hajtja a mozgásvizsgálatot és a körórát is.
    const eventTime = Math.max(car.lastStateAt || -Infinity, receivedAt);
    if (!initial && car.pendingReset) {
      const distanceToTarget = Math.hypot(
        state.p[0] - car.pendingReset.x,
        state.p[2] - car.pendingReset.z
      );
      if (distanceToTarget > RESET_ACK_RADIUS_METERS && eventTime <= car.pendingReset.expiresAt) {
        // Az R elküldése és a CAR_RESET válasz megérkezése között a kliens még
        // küldhetett egy régi pozíciót. Ezt nem tekintjük új teleportnak, és a
        // szerver resetelt állapotát sem írhatja vissza a pálya másik pontjára.
        car.lastSeq = Math.max(car.lastSeq, seq);
        return false;
      }
      car.pendingReset = null;
      car.acceptTeleportOnce = distanceToTarget <= RESET_ACK_RADIUS_METERS;
    }
    const movementAt = initial ? eventTime : nextMovementTime(car, seq, eventTime);
    const validationFailed = !initial && (
      exceedsSpeedLimit(state)
      || (!car.acceptTeleportOnce && hasImplausibleMovement(car, state, movementAt))
    );

    // A zónatérkép a szerveren is rendelkezésre áll. Ha van, nem hisszük el a
    // kliens `offtrack` bitjét: ugyanazzal a négy kerékponttal számolunk, mint a
    // böngésző. Zónatérkép nélküli pályán marad a régi kompatibilis jelzés.
    if (this.zoneRuntime) {
      state.offtrack = allWheelsOffTrack(this.zoneRuntime, stateBody(state), SERVER_WHEEL_PROBES);
    }

    car.state = state;
    car.lastSeq = Math.max(car.lastSeq, seq);
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
    const wasOnMeasuredLap = car.race.hasCrossedStart;
    if (validationFailed && wasOnMeasuredLap) this.flagServerValidation(car);
    // Ugyanaz az idővonal hajtja a mozgásvizsgálatot és a körórát. Korábban a
    // sorszám időt adott a mozgásnak, a kapuk viszont a közel azonos beérkezési
    // időből számoltak; egy csomagköteg így akár 0 ms-os érvényes kört adott.
    this.updateCarProgress(car, movementAt);
    // Ha pont a szabálytalan szakasz metszette először a rajtvonalat, már az
    // így elkezdett kör legyen érvénytelen. Célba érésnél az előzetes jelölés
    // viszont már a lezárt körre került, ezért ott nem jelölünk még egyet.
    if (validationFailed && !wasOnMeasuredLap && car.race.hasCrossedStart) {
      this.flagServerValidation(car);
    }
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
    if (now - this.lastSnapshotAt >= SNAPSHOT_MS) {
      this.lastSnapshotAt = now;
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
    car.race.prevAt = car.lastStateAt || Date.now();
    car.lastMovementAt = car.race.prevAt;
    car.movementSamples = [{ p: [...car.state.p], at: car.lastMovementAt }];
    car.acceptTeleportOnce = true;
    car.pendingReset = { x, z, expiresAt: Date.now() + RESET_ACK_TIMEOUT_MS };
    this.broadcast(S2C.CAR_RESET, { playerId, respawn: { x, z, heading } });
    return true;
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
      for (let i = 0; i < checkpoints.length; i++) {
        const crossedAt = crossingTime(checkpoints[i], fromX, fromZ, x, z, fromAt, now);
        if (crossedAt === null) continue;
        r.passed.add(i);
        if (i === r.nextCheckpoint) {
          r.nextCheckpoint++;
          const splitKey = r.lap * (checkpoints.length + 1) + i + 1;
          r.progressKey = splitKey;
          r.splits.set(splitKey, crossedAt);
          r.lastSplitIndex = i;
          r.lastSplitMs = Math.max(0, crossedAt - r.lapStart);
          car.respawn = {
            ...this.respawnPoint(checkpoints[i], fromX, fromZ, x, z),
            heading: headingFrom(fromX, fromZ, x, z, car.respawn.heading),
          };
        } else if (i > r.nextCheckpoint) {
          r.taintReason = TAINT.CHECKPOINT;
        }
        break;
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
      r.lapStartLead = clockLead(car);
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
    r.lapStartLead = clockLead(car);
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
      this.armFinishDeadline(crossedAt, clockLead(car));
    }
    if ([...this.cars.values()].every((entry) => entry.race.finished)) void this.endRace();
  }

  // Az első befutó elindítja a mezőny hátralévő idejét. Csak egyszer:
  // a másodiknak, harmadiknak beérkező NEM tolja ki a határidőt.
  //
  // Ha ekkor már mindenki célban van, nincs mit indítani — a hívó úgyis
  // azonnal lezárja a futamot. Ezért ez a feltétel egyben a Hot Lapot is
  // kizárja: ott egyetlen igazi autó van, amelyik a befutójával végzett is.
  // A határidőt a faliórához mérjük — a pump() a Date.now()-hoz hasonlítja, és
  // a kliens is a saját órájából számolja a visszaszámlálót. A befutó ideje
  // viszont a mozgás-óráról jön, ezért annak az előnyét itt le kell vonni.
  // Enélkül a mezőny pontosan a győztes akadásának méretével kapott több időt,
  // és a képernyőn látszó szám is ennyivel volt optimista.
  armFinishDeadline(finishedAt, lead = 0) {
    if (this.finishDeadline !== null) return;
    if ([...this.cars.values()].every((entry) => entry.race.finished)) return;
    this.finishDeadline = finishedAt - lead + FINISH_GRACE_MS;
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
        p: roundArray(car.state.p, 3),
        q: roundArray(car.state.q, 4),
        v: roundArray(car.state.v, 2),
        w: roundArray(car.state.w, 3),
        st: +car.state.st.toFixed(3),
        wr: +car.state.wr.toFixed(2),
        th: car.race.finished ? 0 : +car.state.th.toFixed(2),
        seq: car.lastSeq,
        ti: car.race.taintReason,
        lap: car.race.lap,
        cp: car.race.nextCheckpoint,
        rk: rankById.get(car.playerId) || 0,
        gap: gapMs === null ? null : Math.round(gapMs),
        best: bestLap === null ? null : Math.round(bestLap),
        last: lastLap ? Math.round(lastLap.time) : null,
        li: !!lastLap?.invalid,
        // A kör kezdete a FALIÓRÁRA visszaszámolva megy ki: a kliens ehhez méri
        // a szellemet és a futó órát, a mozgás-óra előnyét tehát le kell vonni
        // (lásd clockLead()). A hiteles köridőt ez nem érinti — az továbbra is
        // a szerveren, a mozgás-órán képzett különbség.
        ls: car.race.hasCrossedStart
          ? Math.round(car.race.lapStart - car.race.lapStartLead)
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
    this.stop();
    this.room.state = ROOM_STATE.FINISHED;
    const results = [...this.cars.values()]
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
      })
      .sort((a, b) => (b.lapsCompleted - a.lapsCompleted) || (a.totalMs - b.totalMs));
    results.forEach((result, index) => { result.position = index + 1; });
    await this.room.recordResults(results, this.raceId).catch(() => {});
    if (this.room.sim !== this || this.room.raceGeneration !== this.generation) return;
    this.broadcast(S2C.RACE_END, { results });
    this.room.state = ROOM_STATE.LOBBY;
    this.room.sim = null;
    this.broadcast(S2C.ROOM_STATE, { room: this.room.toJSON() });
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
