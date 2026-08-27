// Árkádszerű, de kiszámítható F1-gumikopás.
//
// Minden új szett első, egy referenciakörnyi távolsága kopásmentes. Utána
// minden további referenciakör 50 százalék kopást ad, tehát egy szett a
// harmadik rajtvonal-átlépés környékére éri el a plafont. A referencia az
// adott játékos első teljes körének ténylegesen megtett távolsága, ezért egy
// rövid és egy hosszú pályán is ugyanannyi KÖRNYI használatot bír a gumi.

export const TIRE_WEAR_PER_REFERENCE_LAP = 0.5;
export const TIRE_WEAR_WARNING = 0.4;
export const TIRE_CHANGE_RECOMMENDED = 0.5;
export const TIRE_WEAR_CRITICAL = 0.8;

// A kopás eleje alig érezhető, a teljesen elkopott gumi viszont már
// egyértelműen kisebb hosszanti és oldalirányú tapadást ad. Nem lesz defekt és
// nem válik vezethetetlenné: a veszteség ezen a plafonon megáll.
export const TIRE_GRIP_LOSS_START = 0.25;
export const TIRE_LONGITUDINAL_MAX_LOSS = 0.18;
export const TIRE_LATERAL_MAX_LOSS = 0.25;

const MIN_REFERENCE_LAP_DISTANCE_M = 250;
const MAX_REFERENCE_LAP_DISTANCE_M = 30_000;
const MAX_DISTANCE_SAMPLE_M = 1_000;

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

export function createTireWearState(enabled = false) {
  return {
    enabled: !!enabled,
    wear: 0,
    referenceLapDistance: null,
    calibrationDistance: 0,
    distanceSinceChange: 0,
    graceDistanceRemaining: null,
    changeCount: 0,
  };
}

// A helyi fizika sebességből, a szerver az elfogadott pozíciómintákból adja a
// távolságot. A mintánkénti korlát a resetet/teleportot nem engedi egyetlen
// lépésben több környi kopássá válni; a normál 30–60 Hz-es mozgás ennek csak
// a töredéke.
export function advanceTireWear(state, distanceM) {
  if (!state?.enabled) return state;
  let distance = Math.max(0, Math.min(MAX_DISTANCE_SAMPLE_M, Number(distanceM) || 0));
  if (distance <= 0) return state;

  state.distanceSinceChange += distance;
  if (!Number.isFinite(state.referenceLapDistance)) {
    state.calibrationDistance += distance;
    return state;
  }

  if (state.graceDistanceRemaining > 0) {
    const protectedDistance = Math.min(distance, state.graceDistanceRemaining);
    state.graceDistanceRemaining -= protectedDistance;
    distance -= protectedDistance;
  }
  if (distance > 0) {
    state.wear = clamp01(
      state.wear + distance / state.referenceLapDistance * TIRE_WEAR_PER_REFERENCE_LAP
    );
  }
  return state;
}

// Az első teljes kör lezárásakor válik ismertté a pálya játékos által megtett
// hossza. Az induló szett ezt a friss kört már elfogyasztotta; ha valaki még
// a kalibráció alatt állt ki, az új szett megmaradt védett távolságát is
// helyesen kiszámítjuk.
export function completeTireCalibrationLap(state) {
  if (!state?.enabled || Number.isFinite(state.referenceLapDistance)) return false;
  const measured = Number(state.calibrationDistance) || 0;
  if (measured <= 0) return false;
  state.referenceLapDistance = Math.max(
    MIN_REFERENCE_LAP_DISTANCE_M,
    Math.min(MAX_REFERENCE_LAP_DISTANCE_M, measured)
  );
  state.graceDistanceRemaining = Math.max(
    0,
    state.referenceLapDistance - state.distanceSinceChange
  );
  return true;
}

export function restartTireCalibrationLap(state) {
  if (!state?.enabled || Number.isFinite(state.referenceLapDistance)) return false;
  state.calibrationDistance = 0;
  return true;
}

export function changeTires(state) {
  if (!state?.enabled) return false;
  state.wear = 0;
  state.distanceSinceChange = 0;
  state.graceDistanceRemaining = Number.isFinite(state.referenceLapDistance)
    ? state.referenceLapDistance
    : null;
  state.changeCount = Math.max(0, Math.trunc(Number(state.changeCount) || 0)) + 1;
  return true;
}

export function tireConditionPercent(state) {
  return Math.round((1 - clamp01(state?.wear)) * 100);
}

export function tireWearLevel(state) {
  const wear = clamp01(state?.wear);
  if (!state?.enabled || wear < TIRE_WEAR_WARNING) return 'fresh';
  if (wear < TIRE_CHANGE_RECOMMENDED) return 'wearing';
  if (wear < TIRE_WEAR_CRITICAL) return 'recommended';
  return 'critical';
}

function smoothstep01(value) {
  const x = clamp01(value);
  return x * x * (3 - 2 * x);
}

export function tireGripMultipliers(wear) {
  const loss = smoothstep01(
    (clamp01(wear) - TIRE_GRIP_LOSS_START) / (1 - TIRE_GRIP_LOSS_START)
  );
  return {
    longitudinal: 1 - TIRE_LONGITUDINAL_MAX_LOSS * loss,
    lateral: 1 - TIRE_LATERAL_MAX_LOSS * loss,
  };
}

// Tömör snapshot a szerver és a helyi predikció egyeztetéséhez. A távolságok
// tizedméteres, a kopás ezredes felbontása bőven finomabb annál, amit a
// vezetésben érzékelni lehet.
export function encodeTireWearSnapshot(state) {
  if (!state?.enabled) return null;
  const scaled = (value) => Number.isFinite(value) ? Math.round(value * 10) : null;
  return {
    w: Math.round(clamp01(state.wear) * 1000),
    r: scaled(state.referenceLapDistance),
    g: scaled(state.graceDistanceRemaining),
    d: scaled(state.calibrationDistance),
    s: scaled(state.distanceSinceChange),
    c: Math.max(0, Math.trunc(Number(state.changeCount) || 0)),
  };
}

export function syncTireWearSnapshot(state, snapshot) {
  if (!state?.enabled || !snapshot) return false;
  const serverChanges = Math.max(0, Math.trunc(Number(snapshot.c) || 0));
  // A kliens a három másodperc leteltekor azonnal előre jelezheti a cserét;
  // egy még úton lévő régi snapshot ilyenkor nem teheti vissza a kopott gumit.
  if (serverChanges < state.changeCount) return false;
  const distance = (value) => Number.isFinite(Number(value)) ? Number(value) / 10 : null;
  state.wear = clamp01(Number(snapshot.w) / 1000);
  state.referenceLapDistance = distance(snapshot.r);
  state.graceDistanceRemaining = distance(snapshot.g);
  state.calibrationDistance = distance(snapshot.d) ?? 0;
  state.distanceSinceChange = distance(snapshot.s) ?? 0;
  state.changeCount = serverChanges;
  return true;
}
