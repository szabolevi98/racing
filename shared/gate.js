// Kapu-metszés: mikor és hol lép át egy mozgó pont egy kapuvonalat.
//
// Miért közös: a szerver ebből méri a köridőt és a részidőket, a kliens pedig
// ugyanezzel számolja ki a szellem részidejét a felvett pályájából. Ha a két
// oldal külön számolná, a delta-kijelző rendszeresen csúszna — épp azt a
// néhány századot, amiért az egész készül.

// Hol metszi a `from`→`to` szakasz a kaput? A visszaadott szám a SZAKASZON
// belüli arány (0…1), vagy null, ha nincs metszés.
export function gateCrossingFraction(gate, fromX, fromZ, toX, toZ) {
  if (!gate) return null;
  const { x1, z1, x2, z2 } = gate;
  const d = (x2 - x1) * (toZ - fromZ) - (z2 - z1) * (toX - fromX);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((fromX - x1) * (toZ - fromZ) - (fromZ - z1) * (toX - fromX)) / d;
  const u = ((fromX - x1) * (z2 - z1) - (fromZ - z1) * (x2 - x1)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? u : null;
}

// Mikor lépte át? A szakasz két végpontjához tartozó idő között interpolálunk,
// tehát az eredmény finomabb, mint a mintavételi ütem.
export function crossingTime(gate, fromX, fromZ, toX, toZ, fromAt, toAt) {
  const fraction = gateCrossingFraction(gate, fromX, fromZ, toX, toZ);
  if (fraction === null) return null;
  return fromAt + (toAt - fromAt) * fraction;
}

export function gateMidpoint(gate) {
  return { x: (gate.x1 + gate.x2) / 2, z: (gate.z1 + gate.z2) / 2 };
}

// Az R visszaállítási pontja normál esetben pontosan az, ahol a kocsi a kaput
// átlépte. Ha ez nem aszfalt (például egy széles checkpoint kifutóra nyúló
// része), a kapu biztonságos közepére esünk vissza.
export function gateRespawnPoint(gate, fromX, fromZ, toX, toZ, isAsphalt = () => true) {
  const fraction = gateCrossingFraction(gate, fromX, fromZ, toX, toZ);
  if (fraction !== null) {
    const point = {
      x: fromX + (toX - fromX) * fraction,
      z: fromZ + (toZ - fromZ) * fraction,
    };
    if (isAsphalt(point.x, point.z)) return point;
  }
  return gateMidpoint(gate);
}

// Egy RÖGZÍTETT pálya (szellem-képkockák) checkpoint-részidői, kör kezdetétől
// számolva. A képkocka alakja: [eltelt ms, x, y, z, …].
//
// Ugyanazt a SORRENDI szabályt követi, mint a szerver élőben: mindig csak a
// soron következő kaput figyeli. Enélkül egy közeli, később sorra kerülő kapu
// korábbi részidőt kapna, és a delta ott hirtelen ugrana egyet.
//
// A visszaadott tömb i-edik eleme az i-edik checkpoint ideje, vagy null, ha a
// felvétel nem ért el odáig.
export function ghostCheckpointSplits(frames, checkpoints) {
  const splits = new Array(checkpoints?.length || 0).fill(null);
  if (!Array.isArray(frames) || frames.length < 2 || !checkpoints?.length) return splits;

  let next = 0;
  for (let i = 1; i < frames.length && next < checkpoints.length; i++) {
    const a = frames[i - 1], b = frames[i];
    // Egy szakasz több kaput is átvághat (ritka, de a 10 Hz-es mintavétel
    // mellett előfordul szűk kanyarban), ezért ciklusban haladunk tovább.
    for (;;) {
      const at = crossingTime(checkpoints[next], a[1], a[3], b[1], b[3], a[0], b[0]);
      if (at === null) break;
      splits[next] = at;
      next++;
      if (next >= checkpoints.length) break;
    }
  }
  return splits;
}
