// Kliensoldali autó–autó kontakt közös, tisztán vízszintes megoldója.
//
// A távoli autó hálózati póza érinthetetlen: minden kliens kizárólag a SAJÁT
// autóját korrigálja. Így nincs helyben ellökött, majd snapshot által falból
// visszarántott ellenfél. A forma minden skin alatt ugyanabból a kanonikus
// F1-kasztni méretből származó, lekerekített 2D kapszula.
import { CHASSIS_SIZE } from './vehicleConfig.js';

export const CAR_CONTACT_RADIUS_M = CHASSIS_SIZE.x;
export const CAR_CONTACT_SEGMENT_HALF_M = Math.max(
  0,
  CHASSIS_SIZE.z - CAR_CONTACT_RADIUS_M,
);
export const CAR_CONTACT_MAX_STATE_AGE_MS = 300;
export const CAR_CONTACT_MAX_HEIGHT_DELTA_M = 1.5;
export const CAR_CONTACT_SWEEP_STEP_M = 0.25;
export const CAR_CONTACT_MAX_SWEEP_STEPS = 32;
export const CAR_CONTACT_SLOP_M = 0.01;
export const CAR_CONTACT_RELEASE_GAP_M = 0.25;
export const CAR_CONTACT_MAX_INITIAL_SEPARATION_M = 0.35;
export const CAR_CONTACT_RESTITUTION = 0.08;
// Ha minket talál el nagy tempóval a hálózati autó, egyetlen tick se adhat
// több mint ekkora gyorsulást. A saját becsapódásunkból eredő LASSULÁS nincs
// levágva: különben nagy sebességnél áthaladnánk az ellenfélen.
export const CAR_CONTACT_MAX_PUSH_DELTA_V_MPS = 18;
export const CAR_CONTACT_MAX_YAW_DELTA_RAD_S = 1.5;

const EPSILON = 1e-9;
const clamp01 = (value) => Math.max(0, Math.min(1, value));
const finite = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};
const dot = (a, b) => a.x * b.x + a.z * b.z;
const length = (v) => Math.hypot(v.x, v.z);
const lerp = (a, b, t) => a + (b - a) * t;
const wrapAngle = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
const lerpAngle = (a, b, t) => a + wrapAngle(b - a) * t;

export function carContactStateIsFresh(stateAgeMs) {
  const age = Number(stateAgeMs);
  return Number.isFinite(age) && age >= 0 && age <= CAR_CONTACT_MAX_STATE_AGE_MS;
}

export function quaternionYaw(q) {
  let x = finite(q?.[0]);
  let y = finite(q?.[1]);
  let z = finite(q?.[2]);
  let w = finite(q?.[3], 1);
  const magnitude = Math.hypot(x, y, z, w) || 1;
  x /= magnitude;
  y /= magnitude;
  z /= magnitude;
  w /= magnitude;
  return Math.atan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y));
}

export function carContactPose(state) {
  return {
    x: finite(state?.p?.[0]),
    y: finite(state?.p?.[1]),
    z: finite(state?.p?.[2]),
    yaw: quaternionYaw(state?.q),
    vx: finite(state?.v?.[0]),
    vz: finite(state?.v?.[2]),
  };
}

function interpolatePose(from, to, amount) {
  return {
    x: lerp(from.x, to.x, amount),
    y: lerp(from.y, to.y, amount),
    z: lerp(from.z, to.z, amount),
    yaw: lerpAngle(from.yaw, to.yaw, amount),
    vx: lerp(from.vx, to.vx, amount),
    vz: lerp(from.vz, to.vz, amount),
  };
}

function capsuleSegment(pose) {
  const fx = Math.sin(pose.yaw);
  const fz = Math.cos(pose.yaw);
  const dx = fx * CAR_CONTACT_SEGMENT_HALF_M;
  const dz = fz * CAR_CONTACT_SEGMENT_HALF_M;
  return {
    a: { x: pose.x - dx, z: pose.z - dz },
    b: { x: pose.x + dx, z: pose.z + dz },
  };
}

// Legközelebbi pontpár két szakaszon. Ugyanez kezeli a párhuzamos és a
// elfajult szakaszt is, így a kapszula későbbi méretváltoztatására sem érzékeny.
function closestSegmentPoints(first, second) {
  const d1 = { x: first.b.x - first.a.x, z: first.b.z - first.a.z };
  const d2 = { x: second.b.x - second.a.x, z: second.b.z - second.a.z };
  const r = { x: first.a.x - second.a.x, z: first.a.z - second.a.z };
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  let s = 0;
  let t = 0;

  if (a <= EPSILON && e <= EPSILON) {
    s = 0;
    t = 0;
  } else if (a <= EPSILON) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = dot(d1, r);
    if (e <= EPSILON) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = dot(d1, d2);
      const denominator = a * e - b * b;
      s = denominator > EPSILON ? clamp01((b * f - c * e) / denominator) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }

  return {
    first: { x: first.a.x + d1.x * s, z: first.a.z + d1.z * s },
    second: { x: second.a.x + d2.x * t, z: second.a.z + d2.z * t },
  };
}

export function carCapsuleSeparation(own, remote) {
  if (Math.abs(own.y - remote.y) > CAR_CONTACT_MAX_HEIGHT_DELTA_M) {
    return {
      separationM: Infinity,
      penetrationM: 0,
      distanceM: Infinity,
      normal: { x: 0, z: 0 },
      ownPoint: { x: own.x, z: own.z },
      remotePoint: { x: remote.x, z: remote.z },
      ambiguousNormal: false,
    };
  }
  const points = closestSegmentPoints(capsuleSegment(own), capsuleSegment(remote));
  const dx = points.first.x - points.second.x;
  const dz = points.first.z - points.second.z;
  const distanceM = Math.hypot(dx, dz);
  let nx = dx;
  let nz = dz;
  let ambiguousNormal = distanceM <= EPSILON;
  if (ambiguousNormal) {
    nx = own.x - remote.x;
    nz = own.z - remote.z;
  }
  const normalLength = Math.hypot(nx, nz);
  if (normalLength > EPSILON) {
    nx /= normalLength;
    nz /= normalLength;
    ambiguousNormal = false;
  } else {
    nx = 1;
    nz = 0;
  }
  const combinedRadius = CAR_CONTACT_RADIUS_M * 2;
  return {
    separationM: distanceM - combinedRadius,
    penetrationM: Math.max(0, combinedRadius - distanceM),
    distanceM,
    normal: { x: nx, z: nz },
    ownPoint: points.first,
    remotePoint: points.second,
    ambiguousNormal,
  };
}

function contactAt(ownPrevious, ownCurrent, remotePrevious, remoteCurrent, amount) {
  const own = interpolatePose(ownPrevious, ownCurrent, amount);
  const remote = interpolatePose(remotePrevious, remoteCurrent, amount);
  return { own, remote, info: carCapsuleSeparation(own, remote) };
}

function collisionNormal(contact, relativeMotion) {
  if (!contact.info.ambiguousNormal) return contact.info.normal;
  const motionLength = length(relativeMotion);
  if (motionLength > EPSILON) {
    return { x: -relativeMotion.x / motionLength, z: -relativeMotion.z / motionLength };
  }
  return contact.info.normal;
}

function findSweptContact(ownPrevious, ownCurrent, remotePrevious, remoteCurrent) {
  const relativeMotion = {
    x: (ownCurrent.x - ownPrevious.x) - (remoteCurrent.x - remotePrevious.x),
    z: (ownCurrent.z - ownPrevious.z) - (remoteCurrent.z - remotePrevious.z),
  };
  const angularTravel = (
    Math.abs(wrapAngle(ownCurrent.yaw - ownPrevious.yaw))
    + Math.abs(wrapAngle(remoteCurrent.yaw - remotePrevious.yaw))
  ) * (CAR_CONTACT_SEGMENT_HALF_M + CAR_CONTACT_RADIUS_M);
  const sampleCount = Math.max(1, Math.min(
    CAR_CONTACT_MAX_SWEEP_STEPS,
    Math.ceil((length(relativeMotion) + angularTravel) / CAR_CONTACT_SWEEP_STEP_M),
  ));
  const start = contactAt(ownPrevious, ownCurrent, remotePrevious, remoteCurrent, 0);
  const current = contactAt(ownPrevious, ownCurrent, remotePrevious, remoteCurrent, 1);

  if (start.info.separationM <= 0) {
    const normal = collisionNormal(start, relativeMotion);
    // Ha az előző tick már érintkezésből indult, de az autók egyértelműen
    // távolodnak és a végére kijutottak egymásból, ne keltsünk új ütközést.
    if (
      dot(relativeMotion, normal) > EPSILON
      && current.info.separationM > start.info.separationM + EPSILON
    ) {
      return { contact: null, current, sampleCount };
    }
    return { contact: { ...start, amount: 0, normal }, current, sampleCount };
  }

  let previousAmount = 0;
  for (let sample = 1; sample <= sampleCount; sample++) {
    const amount = sample / sampleCount;
    const candidate = contactAt(
      ownPrevious, ownCurrent, remotePrevious, remoteCurrent, amount,
    );
    if (candidate.info.separationM <= 0) {
      let low = previousAmount;
      let high = amount;
      let hit = candidate;
      // Az első kontakt ideje elég pontos legyen ahhoz, hogy 378 km/h-nál se
      // maradjon képkockafüggő, több tízcentis benyomódás.
      for (let iteration = 0; iteration < 12; iteration++) {
        const middle = (low + high) / 2;
        const probe = contactAt(
          ownPrevious, ownCurrent, remotePrevious, remoteCurrent, middle,
        );
        if (probe.info.separationM <= 0) {
          high = middle;
          hit = probe;
        } else {
          low = middle;
        }
      }
      return {
        contact: {
          ...hit,
          amount: high,
          normal: collisionNormal(hit, relativeMotion),
        },
        current,
        sampleCount,
      };
    }
    previousAmount = amount;
  }
  return { contact: null, current, sampleCount };
}

export function resolveCarContact({
  ownPrevious,
  ownCurrent,
  remotePrevious,
  remoteCurrent,
  ownVelocity = { x: ownCurrent?.vx || 0, z: ownCurrent?.vz || 0 },
  ownYawRate = 0,
  wasTouching = false,
} = {}) {
  const sweep = findSweptContact(
    ownPrevious,
    ownCurrent,
    remotePrevious,
    remoteCurrent,
  );
  if (!sweep.contact) {
    return {
      collided: false,
      swept: false,
      separationM: sweep.current.info.separationM,
      penetrationM: sweep.current.info.penetrationM,
      position: { x: ownCurrent.x, z: ownCurrent.z },
      velocity: { x: finite(ownVelocity.x), z: finite(ownVelocity.z) },
      yawRate: finite(ownYawRate),
      deltaSpeedMps: 0,
      closingSpeedMps: 0,
      sampleCount: sweep.sampleCount,
    };
  }

  const hit = sweep.contact;
  const normal = hit.normal;
  const relativeRemaining = {
    x: (ownCurrent.x - hit.own.x) - (remoteCurrent.x - hit.remote.x),
    z: (ownCurrent.z - hit.own.z) - (remoteCurrent.z - hit.remote.z),
  };
  const inwardTravel = Math.max(0, -dot(relativeRemaining, normal));
  let separationCorrection = Math.max(inwardTravel, sweep.current.info.penetrationM);
  if (hit.amount === 0) {
    separationCorrection = Math.min(
      separationCorrection,
      CAR_CONTACT_MAX_INITIAL_SEPARATION_M,
    );
  }
  separationCorrection += CAR_CONTACT_SLOP_M;

  const ownV = { x: finite(ownVelocity.x), z: finite(ownVelocity.z) };
  const remoteV = { x: finite(remoteCurrent.vx), z: finite(remoteCurrent.vz) };
  const relativeVelocity = { x: ownV.x - remoteV.x, z: ownV.z - remoteV.z };
  const normalVelocity = dot(relativeVelocity, normal);
  const closingSpeedMps = Math.max(0, -normalVelocity);
  let deltaSpeedMps = 0;
  let velocity = { ...ownV };
  if (closingSpeedMps > 0) {
    const restitution = wasTouching ? 0 : CAR_CONTACT_RESTITUTION;
    let requestedDelta = closingSpeedMps * (1 + restitution);
    const unrestricted = {
      x: ownV.x + normal.x * requestedDelta,
      z: ownV.z + normal.z * requestedDelta,
    };
    const addsEnergy = dot(unrestricted, unrestricted) > dot(ownV, ownV) + EPSILON;
    if (addsEnergy) {
      requestedDelta = Math.min(requestedDelta, CAR_CONTACT_MAX_PUSH_DELTA_V_MPS);
    }
    velocity = {
      x: ownV.x + normal.x * requestedDelta,
      z: ownV.z + normal.z * requestedDelta,
    };
    deltaSpeedMps = requestedDelta;
  }

  let yawRate = finite(ownYawRate);
  if (!wasTouching && deltaSpeedMps > 0) {
    const surfacePoint = {
      x: hit.info.ownPoint.x - normal.x * CAR_CONTACT_RADIUS_M,
      z: hit.info.ownPoint.z - normal.z * CAR_CONTACT_RADIUS_M,
    };
    const offset = { x: surfacePoint.x - hit.own.x, z: surfacePoint.z - hit.own.z };
    const impulseVelocity = {
      x: normal.x * deltaSpeedMps,
      z: normal.z * deltaSpeedMps,
    };
    const leverScale = CAR_CONTACT_RADIUS_M ** 2 + CAR_CONTACT_SEGMENT_HALF_M ** 2;
    const yawDelta = (offset.x * impulseVelocity.z - offset.z * impulseVelocity.x)
      * 0.35 / Math.max(0.25, leverScale);
    yawRate += Math.max(
      -CAR_CONTACT_MAX_YAW_DELTA_RAD_S,
      Math.min(CAR_CONTACT_MAX_YAW_DELTA_RAD_S, yawDelta),
    );
  }

  return {
    collided: true,
    swept: hit.amount > 0 && sweep.current.info.separationM > 0,
    timeOfImpact: hit.amount,
    separationM: sweep.current.info.separationM,
    penetrationM: sweep.current.info.penetrationM,
    correctionM: separationCorrection,
    position: {
      x: ownCurrent.x + normal.x * separationCorrection,
      z: ownCurrent.z + normal.z * separationCorrection,
    },
    velocity,
    yawRate,
    deltaSpeedMps,
    closingSpeedMps,
    normal,
    sampleCount: sweep.sampleCount,
  };
}

export function carContactRemainsLatched(wasTouching, resolution) {
  if (resolution?.collided) return true;
  return !!wasTouching
    && Number.isFinite(resolution?.separationM)
    && resolution.separationM <= CAR_CONTACT_RELEASE_GAP_M;
}
