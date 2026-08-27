// Árkádszerű, de kiszámítható F1-gumikopás.
//
// A kopás a pálya checkpointjaihoz kötődik, ezért nem függ az FPS-től, a
// hálózati mintavételtől, a resetektől vagy egy hibásan bemért referenciakörtől.
// Egy teljes kör checkpointjai a gumi egyharmadát fogyasztják el: a kopás már
// az első körben látszik, egy szett pedig nagyjából három teljes kört bír.

export const TIRE_WEAR_PER_LAP = 1 / 3;
export const TIRE_WEAR_WARNING = 0.4;
export const TIRE_CHANGE_RECOMMENDED = 0.6;
export const TIRE_WEAR_CRITICAL = 0.8;

// A kopás eleje alig érezhető, a teljesen elkopott gumi viszont már
// egyértelműen kisebb hosszanti és oldalirányú tapadást ad. Nem lesz defekt és
// nem válik vezethetetlenné: a veszteség ezen a plafonon megáll.
export const TIRE_GRIP_LOSS_START = 0.25;
export const TIRE_LONGITUDINAL_MAX_LOSS = 0.18;
export const TIRE_LATERAL_MAX_LOSS = 0.25;

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

export function createTireWearState(enabled = false) {
  return {
    enabled: !!enabled,
    wear: 0,
    changeCount: 0,
  };
}

// Minden checkpoint egyenlő részt ér az adott pályán. A hívó ugyanazt a
// checkpointot körönként csak egyszer adhatja át. A rajtvonalnál a hiányzó
// checkpointok is elszámolhatók, így egy kihagyás érvényteleníti a kört, de
// nem ad mellé gumielőnyt.
export function advanceTireWearByCheckpoints(state, crossedCount, checkpointCount) {
  if (!state?.enabled) return state;
  const total = Math.max(0, Math.trunc(Number(checkpointCount) || 0));
  const crossed = Math.max(0, Math.trunc(Number(crossedCount) || 0));
  if (total <= 0 || crossed <= 0) return state;
  state.wear = clamp01(
    state.wear + Math.min(crossed, total) / total * TIRE_WEAR_PER_LAP
  );
  return state;
}

export function changeTires(state) {
  if (!state?.enabled) return false;
  state.wear = 0;
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

// Tömör snapshot a szerver és a kliens egyeztetéséhez. A szerver számolja a
// checkpointokat; a kliens ezt jeleníti meg és adja át a helyi fizikának.
export function encodeTireWearSnapshot(state) {
  if (!state?.enabled) return null;
  return {
    w: Math.round(clamp01(state.wear) * 1000),
    c: Math.max(0, Math.trunc(Number(state.changeCount) || 0)),
  };
}

export function syncTireWearSnapshot(state, snapshot) {
  if (!state?.enabled || !snapshot) return false;
  const serverChanges = Math.max(0, Math.trunc(Number(snapshot.c) || 0));
  // A kliens a három másodperc leteltekor azonnal előre jelezheti a cserét;
  // egy még úton lévő régi snapshot ilyenkor nem teheti vissza a kopott gumit.
  if (serverChanges < state.changeCount) return false;
  state.wear = clamp01(Number(snapshot.w) / 1000);
  state.changeCount = serverChanges;
  return true;
}
