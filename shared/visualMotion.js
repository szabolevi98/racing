// Képkockánkénti vizuális mozgás könnyű, allokációmentes mérője.
//
// A puszta elmozdulás nem rángás: nagy sebességnél minden képkockán sokat
// halad az autó és a kamera. Ezért az előző képkocka sebességéből megjósoljuk
// a következő pozíciót, és csak a jóslattól való eltérést mérjük. Az egyenletes
// mozgás így nulla körüli, egy képi korrekció vagy kamera-rántás viszont
// közvetlenül méterben jelenik meg.

export function createVisualMotionTracker() {
  return {
    samples: 0,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    atMs: 0,
    stepM: 0,
    residualM: 0,
  };
}

export function resetVisualMotionTracker(tracker) {
  tracker.samples = 0;
  tracker.stepM = 0;
  tracker.residualM = 0;
}

function startTracker(tracker, x, y, z, atMs) {
  tracker.samples = 1;
  tracker.x = x;
  tracker.y = y;
  tracker.z = z;
  tracker.vx = 0;
  tracker.vy = 0;
  tracker.vz = 0;
  tracker.atMs = atMs;
  tracker.stepM = 0;
  tracker.residualM = 0;
}

// Igazzal tér vissza, ha már volt elég folytonos minta a residualM
// kiszámításához. Hosszú képkocka vagy teleport után új sorozatot kezd, hogy
// az ismert kihagyást/helyreállítást ne nevezze tévesen finom rángásnak.
export function observeVisualMotion(
  tracker,
  x,
  y,
  z,
  atMs,
  maxGapMs = 100,
  maxStepM = 25,
) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)
    || !Number.isFinite(atMs)) {
    resetVisualMotionTracker(tracker);
    return false;
  }
  if (tracker.samples === 0) {
    startTracker(tracker, x, y, z, atMs);
    return false;
  }

  const dtMs = atMs - tracker.atMs;
  const dx = x - tracker.x;
  const dy = y - tracker.y;
  const dz = z - tracker.z;
  const stepM = Math.hypot(dx, dy, dz);
  if (dtMs < 1 || dtMs > maxGapMs || stepM > maxStepM) {
    startTracker(tracker, x, y, z, atMs);
    return false;
  }

  const dt = dtMs / 1000;
  tracker.stepM = stepM;
  tracker.residualM = tracker.samples >= 2
    ? Math.hypot(
      x - (tracker.x + tracker.vx * dt),
      y - (tracker.y + tracker.vy * dt),
      z - (tracker.z + tracker.vz * dt),
    )
    : 0;
  tracker.vx = dx / dt;
  tracker.vy = dy / dt;
  tracker.vz = dz / dt;
  tracker.x = x;
  tracker.y = y;
  tracker.z = z;
  tracker.atMs = atMs;

  const valid = tracker.samples >= 2;
  tracker.samples = 2;
  return valid;
}
