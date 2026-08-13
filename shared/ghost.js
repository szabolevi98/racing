// Szerver által rögzített Hot Lap / multiplayer szellemkör formátuma.
//
// A fizika 60 Hz-en fut, az új szellemkörökből pedig 20 mintát őrzünk meg
// másodpercenként. Nagy sebességnél ez felezi a két felvett pozíció közötti
// távolságot a régi 10 Hz-hez képest; a kliens a minták között továbbra is
// képkockánként interpolál.
export const GHOST_VERSION = 1;
export const LEGACY_GHOST_SAMPLE_RATE = 10;
export const GHOST_SAMPLE_RATE = 20;
export const GHOST_SAMPLE_MS = 1000 / GHOST_SAMPLE_RATE;
export const GHOST_SUPPORTED_SAMPLE_RATES = Object.freeze([
  LEGACY_GHOST_SAMPLE_RATE,
  GHOST_SAMPLE_RATE,
]);
const MAX_GHOST_SECONDS = 20 * 60;
export const MAX_GHOST_FRAMES = MAX_GHOST_SECONDS * GHOST_SAMPLE_RATE;

function maxGhostFrames(sampleRate) {
  return MAX_GHOST_SECONDS * sampleRate;
}

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
  const sampleRate = Number(value.sampleRate);
  // A korábbi 10 Hz-es rekordok az adatbázisban maradnak. Nem mintavételezzük
  // újra őket (attól nem keletkezne új részlet), hanem a saját frekvenciájukkal
  // fogadjuk el és adjuk tovább. A lejátszó az első mező időbélyegét használja,
  // ezért a 10 és 20 Hz-es körök ugyanazzal a kóddal játszhatók vissza.
  if (!GHOST_SUPPORTED_SAMPLE_RATES.includes(sampleRate)) return null;
  if (value.frames.length < 2 || value.frames.length > maxGhostFrames(sampleRate)) return null;

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
  return { version: GHOST_VERSION, sampleRate, frames };
}
