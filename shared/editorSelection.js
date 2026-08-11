function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function distance(ax, az, bx, bz) {
  return Math.hypot(finite(ax) - finite(bx), finite(az) - finite(bz));
}

export function pointToSegmentDistance(x, z, x1, z1, x2, z2) {
  const ax = finite(x1);
  const az = finite(z1);
  const dx = finite(x2) - ax;
  const dz = finite(z2) - az;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq <= Number.EPSILON) return distance(x, z, ax, az);
  const t = Math.max(0, Math.min(1, ((finite(x) - ax) * dx + (finite(z) - az) * dz) / lengthSq));
  return distance(x, z, ax + dx * t, az + dz * t);
}

export function findGateHit(gates, x, z, tolerance) {
  const maxDistance = Math.max(0, finite(tolerance));
  let bestEndpoint = null;
  let bestLine = null;
  const consider = (index, part, hitDistance) => {
    if (hitDistance > maxDistance) return;
    const endpoint = part !== 'move';
    const best = endpoint ? bestEndpoint : bestLine;
    if (best && hitDistance >= best.distance) return;
    const candidate = { index, part, distance: hitDistance };
    if (endpoint) bestEndpoint = candidate;
    else bestLine = candidate;
  };

  (gates || []).forEach((gate, index) => {
    if (!gate) return;
    consider(index, 'p1', distance(x, z, gate.x1, gate.z1));
    consider(index, 'p2', distance(x, z, gate.x2, gate.z2));
    consider(index, 'move', pointToSegmentDistance(x, z, gate.x1, gate.z1, gate.x2, gate.z2));
  });
  return bestEndpoint || bestLine;
}

export function findSpawnHit(points, x, z, tolerance, headingLength = 8) {
  const maxDistance = Math.max(0, finite(tolerance));
  let best = null;
  const consider = (index, part, hitDistance) => {
    if (hitDistance > maxDistance) return;
    if (!best || hitDistance < best.distance) best = { index, part, distance: hitDistance };
  };

  (points || []).forEach((point, index) => {
    if (!point) return;
    const heading = finite(point.heading);
    const tipX = finite(point.x) + Math.sin(heading) * finite(headingLength);
    const tipZ = finite(point.z) + Math.cos(heading) * finite(headingLength);
    consider(index, 'position', distance(x, z, point.x, point.z));
    consider(index, 'heading', distance(x, z, tipX, tipZ));
  });
  return best;
}
