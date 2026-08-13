// Könnyű, kliensoldali "fekete doboz" a multiplayer hálózati hibáihoz.
//
// A forró útvonalon nincs objektum- vagy JSON-építés: három előre lefoglalt
// typed array körpufferként őrzi az utolsó 30 másodperc számait. JSON és Blob
// kizárólag az F9-es kézi letöltéskor készül. Játékosnév, szobakód, token,
// chat- vagy szerverhiba-szöveg szándékosan soha nem kerül a pufferbe.

export const NET_DIAG_WINDOW_MS = 30_000;
export const NET_DIAG_CAPACITY = 4096;
export const NET_DIAG_VALUE_COUNT = 8;
export const NET_DIAG_MAX_INCIDENTS = 3;

export const NET_DIAG_EVENT = Object.freeze({
  PERFORMANCE: 1,
  STATE_OUT: 2,
  SNAPSHOT_IN: 3,
  PING: 4,
  PING_DISCARDED: 5,
  CONNECTION: 6,
  VALIDATION: 7,
  CAR_RESET: 8,
  ROOM: 9,
  WAITING: 10,
  RACE: 11,
  LAP: 12,
  SERVER_ERROR: 13,
  MANUAL_EXPORT: 14,
});

export const NET_DIAG_INCIDENT = Object.freeze({
  HIGH_PING: 'high_ping',
  FRAME_STALL: 'frame_stall',
  CONNECTION_LOST: 'connection_lost',
  SERVER_VALIDATION: 'server_validation',
});

export const NET_DIAG_CONNECTION = Object.freeze({
  CONNECTING: 1,
  OPEN: 2,
  CLOSED: 3,
  ERROR: 4,
});

export const NET_DIAG_RACE_STAGE = Object.freeze({
  LOADING: 1,
  READY: 2,
  COUNTDOWN: 3,
  RUNNING: 4,
  ENDED: 5,
});

const EVENT_SCHEMA = Object.freeze({
  [NET_DIAG_EVENT.PERFORMANCE]: ['performance', [
    'avgFrameMs', 'maxFrameMs', 'fps', 'physicsSteps',
    'physicsTimerLateMs', 'physicsTimerJitterMs', 'predictionDelayMs', 'interpolationDelayMs',
  ]],
  [NET_DIAG_EVENT.STATE_OUT]: ['state_out', [
    'sequence', 'x', 'z', 'speedMps', 'wsBufferedBytes', 'offtrack',
    'physicsTimerLateMs', 'physicsTimerJitterMs',
  ]],
  [NET_DIAG_EVENT.SNAPSHOT_IN]: ['snapshot_in', [
    'transitMs', 'snapshotJitterMs', 'interpolationDelayMs', 'selfSequence',
    'selfReady', 'carCount', 'selfEchoDistanceM', 'wsBufferedBytes',
  ]],
  [NET_DIAG_EVENT.PING]: ['ping', [
    'rawRttMs', 'smoothedRttMs', 'jitterMs', 'serverBlockedMs', 'clockOffsetMs',
  ]],
  [NET_DIAG_EVENT.PING_DISCARDED]: ['ping_discarded', [
    'reasonCode', 'sampleAgeMs', 'serverBlockedMs', 'raceLoading', 'localMainThreadStall',
  ]],
  [NET_DIAG_EVENT.CONNECTION]: ['connection', ['stateCode', 'closeCode']],
  [NET_DIAG_EVENT.VALIDATION]: ['server_validation', ['taintCode', 'lap', 'checkpoint']],
  [NET_DIAG_EVENT.CAR_RESET]: ['car_reset', ['x', 'z', 'success']],
  [NET_DIAG_EVENT.ROOM]: ['room', [
    'stateCode', 'playerCount', 'readyCount', 'selfReady', 'laps', 'modeCode',
  ]],
  [NET_DIAG_EVENT.WAITING]: ['waiting', ['visible', 'playerCount', 'waitingForStart']],
  [NET_DIAG_EVENT.RACE]: ['race', ['stageCode', 'startDelayMs', 'lapCount', 'carCount']],
  [NET_DIAG_EVENT.LAP]: ['lap', ['lap', 'timeMs', 'invalid', 'taintCode']],
  [NET_DIAG_EVENT.SERVER_ERROR]: ['server_error', ['duringRace']],
  [NET_DIAG_EVENT.MANUAL_EXPORT]: ['manual_export', []],
});

const INCIDENT_REASONS = new Set(Object.values(NET_DIAG_INCIDENT));
const EMPTY_VALUE = Number.NaN;

function safeId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[a-z0-9_.-]{1,80}$/i.test(trimmed) ? trimmed : null;
}

function numeric(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : EMPTY_VALUE;
}

function jsonNumber(value) {
  if (!Number.isFinite(value)) return null;
  // A hálózati diagnosztikához a mikrométeres pontosság csak fájlméret lenne.
  return Math.round(value * 1000) / 1000;
}

export class NetDiagnosticsRecorder {
  constructor({
    capacity = NET_DIAG_CAPACITY,
    windowMs = NET_DIAG_WINDOW_MS,
    maxIncidents = NET_DIAG_MAX_INCIDENTS,
    now = () => performance.now(),
    wallNow = () => Date.now(),
  } = {}) {
    this.capacity = Math.max(1, Math.trunc(capacity));
    this.windowMs = Math.max(1, Number(windowMs));
    this.maxIncidents = Math.max(0, Math.trunc(maxIncidents));
    this.now = now;
    this.wallNow = wallNow;
    this.times = new Float64Array(this.capacity);
    this.types = new Uint8Array(this.capacity);
    this.values = new Float32Array(this.capacity * NET_DIAG_VALUE_COUNT);
    this.writeIndex = 0;
    this.count = 0;
    this.context = Object.freeze({ mode: null, mapId: null, carId: null });
    this.incidents = [];
    this.lastIncidentAt = new Map();
  }

  setContext({ mode = null, mapId = null, carId = null } = {}) {
    this.context = Object.freeze({
      mode: safeId(mode),
      mapId: safeId(mapId),
      carId: safeId(carId),
    });
  }

  // Nyolc külön paraméter szándékos: a rest-paraméter minden 60 Hz-es
  // állapotmintánál új tömböt foglalna.
  record(type, v0 = EMPTY_VALUE, v1 = EMPTY_VALUE, v2 = EMPTY_VALUE, v3 = EMPTY_VALUE,
    v4 = EMPTY_VALUE, v5 = EMPTY_VALUE, v6 = EMPTY_VALUE, v7 = EMPTY_VALUE) {
    if (!EVENT_SCHEMA[type]) return false;
    const index = this.writeIndex;
    this.times[index] = this.now();
    this.types[index] = type;
    const offset = index * NET_DIAG_VALUE_COUNT;
    this.values[offset] = numeric(v0);
    this.values[offset + 1] = numeric(v1);
    this.values[offset + 2] = numeric(v2);
    this.values[offset + 3] = numeric(v3);
    this.values[offset + 4] = numeric(v4);
    this.values[offset + 5] = numeric(v5);
    this.values[offset + 6] = numeric(v6);
    this.values[offset + 7] = numeric(v7);
    this.writeIndex = (index + 1) % this.capacity;
    this.count = Math.min(this.capacity, this.count + 1);
    return true;
  }

  hasData() {
    return this.count > 0 || this.incidents.length > 0;
  }

  captureIncident(reason) {
    if (!INCIDENT_REASONS.has(reason) || this.maxIncidents === 0) return false;
    const now = this.now();
    const previous = this.lastIncidentAt.get(reason) ?? -Infinity;
    // Egy rossz kapcsolat vagy ismétlődő validáció ne másolja le másodpercenként
    // ugyanazt a 30 másodperces ablakot.
    if (now - previous < 15_000) return false;
    this.lastIncidentAt.set(reason, now);
    const sample = this.copyWindow(now);
    sample.reason = reason;
    sample.context = { ...this.context };
    sample.capturedWallTime = this.wallNow();
    this.incidents.push(sample);
    if (this.incidents.length > this.maxIncidents) this.incidents.shift();
    return true;
  }

  copyWindow(endTime = this.now()) {
    const oldestAllowed = endTime - this.windowMs;
    const start = (this.writeIndex - this.count + this.capacity) % this.capacity;
    let kept = 0;
    for (let i = 0; i < this.count; i++) {
      const index = (start + i) % this.capacity;
      if (this.times[index] >= oldestAllowed && this.times[index] <= endTime) kept++;
    }

    const times = new Float64Array(kept);
    const types = new Uint8Array(kept);
    const values = new Float32Array(kept * NET_DIAG_VALUE_COUNT);
    let out = 0;
    for (let i = 0; i < this.count; i++) {
      const index = (start + i) % this.capacity;
      const time = this.times[index];
      if (time < oldestAllowed || time > endTime) continue;
      times[out] = time;
      types[out] = this.types[index];
      const sourceOffset = index * NET_DIAG_VALUE_COUNT;
      values.set(
        this.values.subarray(sourceOffset, sourceOffset + NET_DIAG_VALUE_COUNT),
        out * NET_DIAG_VALUE_COUNT,
      );
      out++;
    }
    return { endTime, times, types, values };
  }

  serializeWindow(sample, fallbackReason = 'manual') {
    const events = new Array(sample.times.length);
    for (let i = 0; i < sample.times.length; i++) {
      const schema = EVENT_SCHEMA[sample.types[i]];
      const fields = schema?.[1] || [];
      const row = [Math.round(sample.times[i] - sample.endTime), schema?.[0] || 'unknown'];
      const valueOffset = i * NET_DIAG_VALUE_COUNT;
      for (let j = 0; j < fields.length; j++) row.push(jsonNumber(sample.values[valueOffset + j]));
      events[i] = row;
    }
    return {
      reason: sample.reason || fallbackReason,
      capturedAt: new Date(sample.capturedWallTime ?? this.wallNow()).toISOString(),
      context: sample.context || { ...this.context },
      durationMs: sample.times.length
        ? Math.round(sample.endTime - sample.times[0])
        : 0,
      events,
    };
  }

  buildReport() {
    const current = this.copyWindow();
    current.context = { ...this.context };
    current.capturedWallTime = this.wallNow();
    const fields = {};
    for (const [, [name, names]] of Object.entries(EVENT_SCHEMA)) fields[name] = ['relativeMs', ...names];
    return {
      schemaVersion: 1,
      generatedAt: new Date(this.wallNow()).toISOString(),
      windowMs: this.windowMs,
      privacy: 'No player names, room codes, authentication tokens or message text are recorded.',
      eventFields: fields,
      current: this.serializeWindow(current),
      incidents: this.incidents.map((sample) => this.serializeWindow(sample, sample.reason)),
    };
  }

  download() {
    if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') {
      return false;
    }
    this.record(NET_DIAG_EVENT.MANUAL_EXPORT);
    const report = this.buildReport();
    const blob = new Blob([JSON.stringify(report)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    anchor.href = url;
    anchor.download = `racing-netcode-${stamp}.json`;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  }

  memoryBytes() {
    let total = this.times.byteLength + this.types.byteLength + this.values.byteLength;
    for (const incident of this.incidents) {
      total += incident.times.byteLength + incident.types.byteLength + incident.values.byteLength;
    }
    return total;
  }
}

export const netDiagnostics = new NetDiagnosticsRecorder();
