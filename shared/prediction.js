// Tiszta, motorfüggetlen állapot-transzformáció a multiplayer jóslás
// korrekciójához. Külön modulban él, hogy Node alatt is regressziótesztelhető
// legyen anélkül, hogy a böngészős játékot vagy a Rapier WASM-ot betöltenénk.

export function multiplyQuaternions(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export function normalizeQuaternion(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export function conjugateQuaternion(q) {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function rotateVector(q, v) {
  const qv = [v[0], v[1], v[2], 0];
  const r = multiplyQuaternions(multiplyQuaternions(q, qv), conjugateQuaternion(q));
  return [r[0], r[1], r[2]];
}

export function rebasePredictedState(state, predictedAnchor, authoritativeAnchor, rotationDelta) {
  const rel = [
    state.p[0] - predictedAnchor.p[0],
    state.p[1] - predictedAnchor.p[1],
    state.p[2] - predictedAnchor.p[2],
  ];
  const rotatedRel = rotateVector(rotationDelta, rel);
  const predictedAnchorV = rotateVector(rotationDelta, predictedAnchor.v);
  const predictedAnchorW = rotateVector(rotationDelta, predictedAnchor.w);
  const rotatedV = rotateVector(rotationDelta, state.v);
  const rotatedW = rotateVector(rotationDelta, state.w);
  return {
    p: [
      authoritativeAnchor.p[0] + rotatedRel[0],
      authoritativeAnchor.p[1] + rotatedRel[1],
      authoritativeAnchor.p[2] + rotatedRel[2],
    ],
    q: normalizeQuaternion(multiplyQuaternions(rotationDelta, state.q)),
    v: [
      rotatedV[0] + authoritativeAnchor.v[0] - predictedAnchorV[0],
      rotatedV[1] + authoritativeAnchor.v[1] - predictedAnchorV[1],
      rotatedV[2] + authoritativeAnchor.v[2] - predictedAnchorV[2],
    ],
    w: [
      rotatedW[0] + authoritativeAnchor.w[0] - predictedAnchorW[0],
      rotatedW[1] + authoritativeAnchor.w[1] - predictedAnchorW[1],
      rotatedW[2] + authoritativeAnchor.w[2] - predictedAnchorW[2],
    ],
  };
}
