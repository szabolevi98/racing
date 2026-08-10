// Szerver által rögzített Hot Lap / multiplayer szellemkör formátuma.
//
// A fizika 60 Hz-en fut, de a vizuális visszajátszáshoz 10 minta/mp bőven elég:
// a kliens a minták között interpolál. Egy 90 másodperces kör így körülbelül
// 900 kis tömb, nem pedig több ezer teljes szerver-snapshot.
export const GHOST_VERSION = 1;
export const GHOST_SAMPLE_RATE = 10;
export const GHOST_SAMPLE_MS = 1000 / GHOST_SAMPLE_RATE;
export const MAX_GHOST_FRAMES = 12_000; // legfeljebb 20 percnyi kör

const round = (value, digits) => {
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
};

// [eltelt ms, x, y, z, qx, qy, qz, qw]
export function makeGhostFrame(elapsedMs, position, rotation) {
  return [
    Math.max(0, Math.round(elapsedMs)),
    round(position.x, 3), round(position.y, 3), round(position.z, 3),
    round(rotation.x, 4), round(rotation.y, 4), round(rotation.z, 4), round(rotation.w, 4),
  ];
}

export function makeGhostReplay(frames) {
  if (!Array.isArray(frames) || frames.length < 2 || frames.length > MAX_GHOST_FRAMES) return null;
  return { version: GHOST_VERSION, sampleRate: GHOST_SAMPLE_RATE, frames };
}

// Adatbázisból és hálózatról érkező visszajátszást is ezen az egy szigorú
// kapun engedjük át. Így egy sérült régi rekord nem tud NaN pozíciókat vagy
// korlátlan méretű payloadot juttatni a kliensre.
export function sanitizeGhostReplay(value) {
  if (!value || Number(value.version) !== GHOST_VERSION || !Array.isArray(value.frames)) return null;
  if (value.frames.length < 2 || value.frames.length > MAX_GHOST_FRAMES) return null;

  let previousTime = -1;
  const frames = [];
  for (const raw of value.frames) {
    if (!Array.isArray(raw) || raw.length !== 8) return null;
    const frame = raw.map(Number);
    if (!frame.every(Number.isFinite)) return null;
    if (frame[0] < previousTime || frame[0] < 0) return null;
    previousTime = frame[0];
    frames.push(frame);
  }
  return { version: GHOST_VERSION, sampleRate: GHOST_SAMPLE_RATE, frames };
}
