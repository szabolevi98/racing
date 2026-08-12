import { gateCrossingFraction } from './gate.js';

export const PIT_SPEED_LIMIT_KMH = 100;
export const PIT_SPEED_LIMIT_MPS = PIT_SPEED_LIMIT_KMH / 3.6;
export const PIT_AUTO_DECEL_MPS2 = 40;
export const PIT_STOP_RADIUS_M = 3;
export const PIT_STOP_MAX_SPEED_KMH = 5;
export const PIT_STOP_MAX_SPEED_MPS = PIT_STOP_MAX_SPEED_KMH / 3.6;
export const PIT_STOP_DURATION_MS = 3000;
export const PIT_STOP_COUNT = 8;

const finite = (value) => Number.isFinite(Number(value));
const validGate = (gate) => !!gate && ['x1', 'z1', 'x2', 'z2'].every((key) => finite(gate[key]));
const validStop = (point) => !!point && finite(point.x) && finite(point.z);

export function cleanPitGate(gate) {
  if (!validGate(gate)) return null;
  return {
    x1: Number(gate.x1), z1: Number(gate.z1),
    x2: Number(gate.x2), z2: Number(gate.z2),
  };
}

export function cleanPitStop(point) {
  if (!validStop(point)) return null;
  return {
    x: Number(point.x),
    z: Number(point.z),
    heading: finite(point.heading) ? Number(point.heading) : 0,
  };
}

export function pitEntryGates(raw) {
  return Array.isArray(raw?.entries) ? raw.entries.map(cleanPitGate).filter(Boolean) : [];
}

export function pitExitGates(raw) {
  return Array.isArray(raw?.exits) ? raw.exits.map(cleanPitGate).filter(Boolean) : [];
}

export function normalizePitConfig(raw) {
  return {
    entries: pitEntryGates(raw),
    exits: pitExitGates(raw),
    stops: Array.isArray(raw?.stops)
      ? raw.stops.slice(0, PIT_STOP_COUNT).map(cleanPitStop).filter(Boolean)
      : [],
  };
}

function hasCompleteNormalizedPit(pit) {
  return pit.entries.length > 0
    && pit.exits.length > 0
    && pit.stops.length === PIT_STOP_COUNT;
}

export function hasCompletePitConfig(raw) {
  return hasCompleteNormalizedPit(normalizePitConfig(raw));
}

export function createPitState(required = false) {
  return {
    required: !!required,
    completed: false,
    inLane: false,
    stopStartedAt: null,
    stopElapsedMs: 0,
  };
}

export function updatePitState(state, pitConfig, assignedStopIndex, sample) {
  if (!state?.required) return state;
  const pit = normalizePitConfig(pitConfig);
  if (!hasCompleteNormalizedPit(pit)) return state;
  const fromX = Number(sample?.fromX), fromZ = Number(sample?.fromZ);
  const x = Number(sample?.x), z = Number(sample?.z);
  const now = Number(sample?.now);
  const speed = Math.max(0, Number(sample?.speedMps) || 0);

  const crossings = [
    ...pit.entries.map((gate) => ({ type: 'entry', at: gateCrossingFraction(gate, fromX, fromZ, x, z) })),
    ...pit.exits.map((gate) => ({ type: 'exit', at: gateCrossingFraction(gate, fromX, fromZ, x, z) })),
  ].filter((crossing) => crossing.at !== null).sort((a, b) => a.at - b.at);
  for (const crossing of crossings) {
    state.inLane = crossing.type === 'entry';
    if (!state.inLane) {
      state.stopStartedAt = null;
      state.stopElapsedMs = 0;
    }
  }

  const stopIndex = Math.max(0, Math.min(PIT_STOP_COUNT - 1, Number(assignedStopIndex) || 0));
  const stop = pit.stops[stopIndex];
  const inStop = !!stop && Math.hypot(x - stop.x, z - stop.z) <= PIT_STOP_RADIUS_M;
  if (!state.completed && state.inLane && inStop && speed <= PIT_STOP_MAX_SPEED_MPS && Number.isFinite(now)) {
    if (!Number.isFinite(state.stopStartedAt)) state.stopStartedAt = now;
    state.stopElapsedMs = Math.max(0, now - state.stopStartedAt);
    if (state.stopElapsedMs >= PIT_STOP_DURATION_MS) {
      state.stopElapsedMs = PIT_STOP_DURATION_MS;
      state.completed = true;
    }
  } else if (!state.completed) {
    state.stopStartedAt = null;
    state.stopElapsedMs = 0;
  }
  return state;
}

// The car is not teleported from 300 to 100 km/h: braking is strong but smooth.
export function pitLimitedVelocity(vx, vz, dt) {
  const speed = Math.hypot(vx, vz);
  if (!Number.isFinite(speed) || speed <= PIT_SPEED_LIMIT_MPS) return { vx, vz };
  const nextSpeed = Math.max(
    PIT_SPEED_LIMIT_MPS,
    speed - PIT_AUTO_DECEL_MPS2 * Math.max(0, Number(dt) || 0)
  );
  const scale = nextSpeed / speed;
  return { vx: vx * scale, vz: vz * scale };
}
