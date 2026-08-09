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

function interpolateQuaternion(a, b, f) {
  let bb = b;
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (dot < 0) {
    bb = [-b[0], -b[1], -b[2], -b[3]];
    dot = -dot;
  }
  if (dot > 0.9995) {
    return normalizeQuaternion([
      a[0] + (bb[0] - a[0]) * f,
      a[1] + (bb[1] - a[1]) * f,
      a[2] + (bb[2] - a[2]) * f,
      a[3] + (bb[3] - a[3]) * f,
    ]);
  }
  const theta = Math.acos(Math.max(-1, Math.min(1, dot)));
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - f) * theta) / sinTheta;
  const wb = Math.sin(f * theta) / sinTheta;
  return [
    a[0] * wa + bb[0] * wb,
    a[1] * wa + bb[1] * wb,
    a[2] * wa + bb[2] * wb,
    a[3] * wa + bb[3] * wb,
  ];
}

// A szerver snapshotja egy fizikai IDŐPONTHOZ tartozik. Nagy pingnél nem az
// akkor feldolgozott bemenet sorszáma mondja meg, hol tartott ugyanabban a
// pillanatban a kliens: az a bemenet a hálózati út miatt korábban keletkezett.
// Ezért a helyi jóslat időbélyeges történetéből interpoláljuk ki az azonos
// pillanathoz tartozó állapotot.
export function samplePredictionStateAt(history, at) {
  if (!history.length) return null;
  if (at <= history[0].t) return history[0].state;
  const last = history[history.length - 1];
  if (at >= last.t) return last.state;

  for (let i = history.length - 1; i > 0; i--) {
    const a = history[i - 1];
    const b = history[i];
    if (a.t > at || at > b.t) continue;
    const span = b.t - a.t;
    const f = span > 0 ? (at - a.t) / span : 0;
    const lerp3 = (x, y) => [
      x[0] + (y[0] - x[0]) * f,
      x[1] + (y[1] - x[1]) * f,
      x[2] + (y[2] - x[2]) * f,
    ];
    return {
      p: lerp3(a.state.p, b.state.p),
      q: interpolateQuaternion(a.state.q, b.state.q, f),
      v: lerp3(a.state.v, b.state.v),
      w: lerp3(a.state.w, b.state.w),
    };
  }
  return last.state;
}

// Egy talajon guruló raycast-autónál a szerver kis pitch/roll/Y korrekciója
// nem írhatja felül a kliens működő rugózását. A relatív forgatásból csak a
// függőleges tengely körüli (kormányzási) részt tartjuk meg; ugrásnál vagy
// borulásnál ezt a szűrést a hívó nem használja.
export function yawTwist(q) {
  return normalizeQuaternion([0, q[1], 0, q[3]]);
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
