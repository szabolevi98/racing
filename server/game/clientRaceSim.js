// Kliens-autoritatív online versenyvezérlő.
//
// Ebben az üzemmódban a szerver nem épít Rapier világot és nem szimulálja újra
// az autókat. A saját autó fizikáját minden böngésző helyben futtatja; ide a
// kész állapot érkezik. A szerver továbbra is központilag kezeli a köröket,
// checkpointokat, sorrendet, eredményeket és a szellem rögzítését.
import {
  S2C, ROOM_STATE, GAME_MODE, TAINT, TICK_MS, SNAPSHOT_RATE, requiredCheckpoints,
} from '../../shared/protocol.js';
import { gridSlotPose, hotLapStartPose } from '../../shared/grid.js';
import {
  GHOST_SAMPLE_MS, MAX_GHOST_FRAMES, makeGhostFrame, makeGhostReplay,
} from '../../shared/ghost.js';

const SNAPSHOT_MS = 1000 / SNAPSHOT_RATE;
const MAX_ABS_POSITION = 100_000;
const MAX_LINEAR_SPEED = 180; // 648 km/h: hibás/csaló csomagot fog, ütközési tüskét nem.
const MAX_ANGULAR_SPEED = 100;
const MAX_STATE_AGE_MS = 2_000;
const MAX_FUTURE_MS = 150;
const TELEPORT_GRACE_METERS = 6;

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

function plausibleMovement(previous, next, elapsedMs) {
  if (!previous || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return true;
  const distance = Math.hypot(
    next.p[0] - previous.p[0], next.p[1] - previous.p[1], next.p[2] - previous.p[2]
  );
  return distance <= TELEPORT_GRACE_METERS + MAX_LINEAR_SPEED * Math.min(elapsedMs, 1_000) / 1_000;
}

function headingFrom(fromX, fromZ, toX, toZ, fallback) {
  const dx = toX - fromX, dz = toZ - fromZ;
  if (Math.abs(dx) < 1e-4 && Math.abs(dz) < 1e-4) return fallback;
  return Math.atan2(dx, dz);
}

function gateMidpoint(gate) {
  return { x: (gate.x1 + gate.x2) / 2, z: (gate.z1 + gate.z2) / 2 };
}

function crossedGate(gate, fromX, fromZ, toX, toZ) {
  if (!gate) return false;
  const { x1, z1, x2, z2 } = gate;
  const d = (x2 - x1) * (toZ - fromZ) - (z2 - z1) * (toX - fromX);
  if (Math.abs(d) < 1e-9) return false;
  const t = ((fromX - x1) * (toZ - fromZ) - (fromZ - z1) * (toX - fromX)) / d;
  const u = ((fromX - x1) * (z2 - z1) - (fromZ - z1) * (x2 - x1)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

function createRaceState(x, z) {
  return {
    lap: 0,
    nextCheckpoint: 0,
    passed: new Set(),
    taintReason: TAINT.NONE,
    hasCrossedStart: false,
    lapStart: 0,
    lapTimes: [],
    ghostFrames: null,
    lastGhostSampleAt: 0,
    progressKey: -1,
    splits: new Map(),
    finished: false,
    prevX: x,
    prevZ: z,
  };
}

export class ClientRaceSim {
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
  }

  async start() {
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
        acceptTeleportOnce: true,
        respawn: { x: spawn.x, z: spawn.z, heading: spawn.heading || 0 },
        race: createRaceState(spawn.x, spawn.z),
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

  queueInput() {
    // Szándékosan üres: kliensfizikánál kész állapot érkezik INPUT helyett.
  }

  receiveState(playerId, raw, { initial = false, receivedAt = Date.now() } = {}) {
    const car = this.cars.get(playerId);
    if (!car || this.stopped) return false;
    const seq = Math.trunc(Number(raw?.seq) || 0);
    if (!initial && seq <= car.lastSeq) return false;
    const state = sanitizeClientCarState(raw);
    if (!state) return false;

    const rawTime = Number(raw?.t);
    const clampedTime = Number.isFinite(rawTime)
      ? Math.max(receivedAt - MAX_STATE_AGE_MS, Math.min(receivedAt + MAX_FUTURE_MS, rawTime))
      : receivedAt;
    // A WebSocket sorrendtartó, de a kliens időbecslése finoman korrigálódhat.
    // Ettől a szerver versenyórája nem mehet visszafelé.
    const eventTime = Math.max(car.lastStateAt || -Infinity, clampedTime);
    const elapsed = car.lastStateAt ? eventTime - car.lastStateAt : 0;
    if (!initial && !car.acceptTeleportOnce && !plausibleMovement(car.state, state, elapsed)) return false;

    car.state = state;
    car.lastSeq = Math.max(car.lastSeq, seq);
    car.lastStateAt = eventTime;
    car.acceptTeleportOnce = false;

    if (initial || this.room.state !== ROOM_STATE.RACING || eventTime < this.startAt) {
      car.race.prevX = state.p[0];
      car.race.prevZ = state.p[2];
      return true;
    }
    this.updateCarProgress(car, eventTime);
    return true;
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
  }

  resetCar(playerId) {
    const car = this.cars.get(playerId);
    if (!car || car.race.finished) return;
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
    car.acceptTeleportOnce = true;
    this.broadcast(S2C.CAR_RESET, { playerId, respawn: { x, z, heading } });
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
    if (force && last?.[0] === frame[0]) r.ghostFrames[r.ghostFrames.length - 1] = frame;
    else r.ghostFrames.push(frame);
    r.lastGhostSampleAt = now;
  }

  finishGhostRecording(car, now) {
    this.recordGhostFrame(car, now, true);
    return makeGhostReplay(car.race.ghostFrames);
  }

  updateCarProgress(car, now) {
    const gates = this.map?.gates;
    if (!gates?.start || car.race.finished) return;
    const checkpoints = gates.checkpoints || [];
    const r = car.race;
    const x = car.state.p[0], z = car.state.p[2];
    const fromX = r.prevX, fromZ = r.prevZ;
    r.prevX = x;
    r.prevZ = z;
    this.recordGhostFrame(car, now);

    if (r.hasCrossedStart) {
      for (let i = 0; i < checkpoints.length; i++) {
        if (!crossedGate(checkpoints[i], fromX, fromZ, x, z)) continue;
        r.passed.add(i);
        if (i === r.nextCheckpoint) {
          r.nextCheckpoint++;
          const splitKey = r.lap * (checkpoints.length + 1) + i + 1;
          r.progressKey = splitKey;
          r.splits.set(splitKey, now);
          car.respawn = {
            ...gateMidpoint(checkpoints[i]),
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

    if (!crossedGate(gates.start, fromX, fromZ, x, z)) return;
    if (!r.hasCrossedStart) {
      r.hasCrossedStart = true;
      r.nextCheckpoint = 0;
      r.passed.clear();
      r.taintReason = TAINT.NONE;
      r.lapStart = now;
      this.beginGhostRecording(car, now);
      r.progressKey = r.lap * (checkpoints.length + 1);
      r.splits.set(r.progressKey, now);
      car.respawn = {
        ...gateMidpoint(gates.start),
        heading: headingFrom(fromX, fromZ, x, z, car.respawn.heading),
      };
      return;
    }
    if (r.passed.size < requiredCheckpoints(checkpoints.length)) {
      r.taintReason = TAINT.CHECKPOINT;
      return;
    }

    car.respawn = {
      ...gateMidpoint(gates.start),
      heading: headingFrom(fromX, fromZ, x, z, car.respawn.heading),
    };
    if (r.passed.size < checkpoints.length) r.taintReason = TAINT.CHECKPOINT;
    const invalid = !!r.taintReason;
    const time = now - r.lapStart;
    const ghost = invalid ? null : this.finishGhostRecording(car, now);
    const splitKey = (r.lap + 1) * (checkpoints.length + 1);
    r.progressKey = splitKey;
    r.splits.set(splitKey, now);
    r.lapTimes.push({ time, invalid });
    r.lap++;
    r.nextCheckpoint = 0;
    r.passed.clear();
    r.taintReason = TAINT.NONE;
    r.lapStart = now;
    if (r.lap < this.room.laps) this.beginGhostRecording(car, now);
    this.room.recordLap(
      this.room.players.get(car.playerId), r.lap, time, invalid, ghost, this.raceId
    ).catch(() => {});
    this.broadcast(S2C.RACE_EVENT, {
      kind: 'lap', playerId: car.playerId, lap: r.lap, timeMs: Math.round(time), invalid,
    });
    if (r.lap >= this.room.laps) {
      r.finished = true;
      r.finishedAt = now;
      this.broadcast(S2C.RACE_EVENT, { kind: 'finished', playerId: car.playerId });
    }
    if ([...this.cars.values()].every((entry) => entry.race.finished)) void this.endRace();
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
      const validLaps = car.race.lapTimes.filter((lap) => !lap.invalid);
      const bestLap = validLaps.length ? Math.min(...validLaps.map((lap) => lap.time)) : null;
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
        ls: car.race.hasCrossedStart ? Math.round(car.race.lapStart) : null,
        fin: !!car.race.finished,
      };
    });
    this.broadcast(S2C.SNAPSHOT, { tick: this.tick, t: now, cars });
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
