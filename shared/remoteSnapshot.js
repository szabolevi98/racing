// Eldönti, hogy egy 20 Hz-es snapshot ténylegesen új autóállapotot hozott-e.
// Az új szerver autónkénti `at` mezőt küld; régi szervernél csak a növekvő
// sorszám különbözteti meg az új állapotot a snapshotban ismételt stale póztól.
export function remoteSnapshotSample(previous, car, snapshotAt) {
  const hasPerCarTime = car?.at !== null
    && car?.at !== ''
    && Number.isFinite(Number(car?.at));
  const stateTime = hasPerCarTime ? Number(car.at) : Number(snapshotAt);
  const sequence = Math.trunc(Number(car?.seq) || 0);
  return {
    stateTime,
    sequence,
    isNew: !previous
      || sequence > previous.seq
      || (hasPerCarTime && stateTime > previous.t),
  };
}

export function remoteExtrapolationTiming(latestTime, targetTime, maxAgeMs) {
  const elapsedMs = Math.max(0, Number(targetTime) - Number(latestTime));
  const limitMs = Math.max(0, Number(maxAgeMs) || 0);
  return {
    ageMs: Math.min(limitMs, elapsedMs),
    moving: elapsedMs < limitMs,
  };
}
