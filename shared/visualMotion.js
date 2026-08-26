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

export function createAngularMotionTracker() {
  return {
    samples: 0,
    qx: 0,
    qy: 0,
    qz: 0,
    qw: 1,
    wx: 0,
    wy: 0,
    wz: 0,
    atMs: 0,
    stepRad: 0,
    residualRad: 0,
  };
}

export function resetVisualMotionTracker(tracker) {
  tracker.samples = 0;
  tracker.stepM = 0;
  tracker.residualM = 0;
}

export function resetAngularMotionTracker(tracker) {
  tracker.samples = 0;
  tracker.stepRad = 0;
  tracker.residualRad = 0;
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

function startAngularTracker(tracker, qx, qy, qz, qw, atMs) {
  tracker.samples = 1;
  tracker.qx = qx;
  tracker.qy = qy;
  tracker.qz = qz;
  tracker.qw = qw;
  tracker.wx = 0;
  tracker.wy = 0;
  tracker.wz = 0;
  tracker.atMs = atMs;
  tracker.stepRad = 0;
  tracker.residualRad = 0;
}

// A kamera forgásának megfelelő párja. Az egymást követő kvaterniókból
// világkoordinátás szögsebességet számol, majd annak képkockák közti változását
// méri. Az egyenletes fordulás így nem rángás, a hirtelen iránykorrekció igen.
export function observeAngularMotion(
  tracker,
  qx,
  qy,
  qz,
  qw,
  atMs,
  maxGapMs = 100,
  maxStepRad = Math.PI / 2,
) {
  if (!Number.isFinite(qx) || !Number.isFinite(qy) || !Number.isFinite(qz)
    || !Number.isFinite(qw) || !Number.isFinite(atMs)) {
    resetAngularMotionTracker(tracker);
    return false;
  }
  const magnitude = Math.hypot(qx, qy, qz, qw);
  if (!(magnitude > 1e-9)) {
    resetAngularMotionTracker(tracker);
    return false;
  }
  qx /= magnitude;
  qy /= magnitude;
  qz /= magnitude;
  qw /= magnitude;
  if (tracker.samples === 0) {
    startAngularTracker(tracker, qx, qy, qz, qw, atMs);
    return false;
  }

  const dtMs = atMs - tracker.atMs;
  // Világkoordinátás delta: current * inverse(previous).
  let dx = -qw * tracker.qx + qx * tracker.qw - qy * tracker.qz + qz * tracker.qy;
  let dy = -qw * tracker.qy + qx * tracker.qz + qy * tracker.qw - qz * tracker.qx;
  let dz = -qw * tracker.qz - qx * tracker.qy + qy * tracker.qx + qz * tracker.qw;
  let dw = qw * tracker.qw + qx * tracker.qx + qy * tracker.qy + qz * tracker.qz;
  if (dw < 0) {
    dx = -dx;
    dy = -dy;
    dz = -dz;
    dw = -dw;
  }
  const sinHalf = Math.hypot(dx, dy, dz);
  const stepRad = 2 * Math.atan2(sinHalf, Math.max(0, dw));
  if (dtMs < 1 || dtMs > maxGapMs || stepRad > maxStepRad) {
    startAngularTracker(tracker, qx, qy, qz, qw, atMs);
    return false;
  }

  const dt = dtMs / 1000;
  const scale = sinHalf > 1e-9 ? stepRad / (sinHalf * dt) : 0;
  const wx = dx * scale;
  const wy = dy * scale;
  const wz = dz * scale;
  tracker.stepRad = stepRad;
  tracker.residualRad = tracker.samples >= 2
    ? Math.hypot(wx - tracker.wx, wy - tracker.wy, wz - tracker.wz) * dt
    : 0;
  tracker.wx = wx;
  tracker.wy = wy;
  tracker.wz = wz;
  tracker.qx = qx;
  tracker.qy = qy;
  tracker.qz = qz;
  tracker.qw = qw;
  tracker.atMs = atMs;

  const valid = tracker.samples >= 2;
  tracker.samples = 2;
  return valid;
}
