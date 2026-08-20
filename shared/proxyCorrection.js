// A hálózati ellenfél fizikai proxyja nem ugorhat korlátlanul a legújabb
// becslésre. A látható autó külön, finoman interpolált idővonalon mozog; ez a
// szabály kizárólag a helyi Rapier-testet védi attól, hogy egy hálózati
// korrekció teleportként nagy impulzust adjon a saját autónknak.

export const PROXY_MAX_POSITION_STEP_M = 0.35;
export const PROXY_MAX_ROTATION_STEP_RAD = 8 * Math.PI / 180;
export const PROXY_HARD_RESET_DISTANCE_M = 4.5;
export const PROXY_COLLIDER_COOLDOWN_STEPS = 6;
export const PROXY_MAX_DEEP_OVERLAP_WAIT_STEPS = 30;
export const PROXY_DEEP_OVERLAP_DISTANCE_M = 1.25;

function normalizedQuaternion(q) {
  const length = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return { x: q.x / length, y: q.y / length, z: q.z / length, w: q.w / length };
}

function slerpQuaternion(from, target, amount) {
  const a = normalizedQuaternion(from);
  let b = normalizedQuaternion(target);
  let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  if (dot < 0) {
    dot = -dot;
    b = { x: -b.x, y: -b.y, z: -b.z, w: -b.w };
  }
  dot = Math.max(-1, Math.min(1, dot));
  if (dot > 0.9995) {
    return normalizedQuaternion({
      x: a.x + (b.x - a.x) * amount,
      y: a.y + (b.y - a.y) * amount,
      z: a.z + (b.z - a.z) * amount,
      w: a.w + (b.w - a.w) * amount,
    });
  }
  const angle = Math.acos(dot);
  const sin = Math.sin(angle);
  const wa = Math.sin((1 - amount) * angle) / sin;
  const wb = Math.sin(amount * angle) / sin;
  return {
    x: a.x * wa + b.x * wb,
    y: a.y * wa + b.y * wb,
    z: a.z * wa + b.z * wb,
    w: a.w * wa + b.w * wb,
  };
}

export function planProxyCorrection(currentPosition, currentRotation, targetPosition, targetRotation) {
  const dx = targetPosition.x - currentPosition.x;
  const dy = targetPosition.y - currentPosition.y;
  const dz = targetPosition.z - currentPosition.z;
  const distance = Math.hypot(dx, dy, dz);
  const hardReset = distance > PROXY_HARD_RESET_DISTANCE_M;
  const positionAmount = hardReset || distance <= PROXY_MAX_POSITION_STEP_M
    ? 1
    : PROXY_MAX_POSITION_STEP_M / distance;

  const fromQ = normalizedQuaternion(currentRotation);
  const toQ = normalizedQuaternion(targetRotation);
  const absDot = Math.min(1, Math.abs(
    fromQ.x * toQ.x + fromQ.y * toQ.y + fromQ.z * toQ.z + fromQ.w * toQ.w
  ));
  const rotationError = 2 * Math.acos(absDot);
  const rotationAmount = hardReset || rotationError <= PROXY_MAX_ROTATION_STEP_RAD
    ? 1
    : PROXY_MAX_ROTATION_STEP_RAD / rotationError;

  return {
    position: {
      x: currentPosition.x + dx * positionAmount,
      y: currentPosition.y + dy * positionAmount,
      z: currentPosition.z + dz * positionAmount,
    },
    rotation: rotationAmount >= 1
      ? toQ
      : slerpQuaternion(fromQ, toQ, rotationAmount),
    distance,
    positionStep: hardReset ? distance : Math.min(distance, PROXY_MAX_POSITION_STEP_M),
    rotationError,
    clamped: !hardReset && (positionAmount < 1 || rotationAmount < 1),
    hardReset,
  };
}
