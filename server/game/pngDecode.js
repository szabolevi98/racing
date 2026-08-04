// Minimális PNG-dekóder: csak annyi, amennyi a zóna-térkép beolvasásához kell.
//
// Miért nem könyvtár: a projekt szándékosan függőség-szegény, és a bemenet
// nem tetszőleges PNG, hanem amit a böngésző canvas.toBlob()-ja ír ki —
// 8 bites, nem-interlaced, RGB vagy RGBA. Erre a szűk esetre a dekódolás
// néhány tucat sor, a zlib pedig eleve benne van a Node-ban.
//
// Ha valaha más alakú PNG kerülne ide, inkább hangosan elhasal, mint hogy
// csendben rossz képpontokat adjon.
import zlib from 'node:zlib';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// A Paeth-előrejelző a PNG szabvány szerint: a bal, a fenti és az átlós
// szomszéd közül azt választja, amelyik a becsléshez legközelebb van.
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(buf) {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (buf[i] !== SIGNATURE[i]) throw new Error('nem PNG fájl');
  }

  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  let o = 8;
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    o += 12 + len;                       // hossz + típus + adat + CRC

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG nem támogatott');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (bitDepth !== 8) throw new Error(`csak 8 bites PNG támogatott (kapott: ${bitDepth})`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`csak RGB/RGBA PNG támogatott (colorType: ${colorType})`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);

  let prev = Buffer.alloc(stride);       // az előző sor, SZŰRÉS UTÁN
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;

    // A szűrők visszafejtése. A "bal" szomszéd a saját sorban van, ezért
    // helyben, balról jobbra kell dolgozni.
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;   // bal
      const b = prev[i];                                  // fent
      const c = i >= channels ? prev[i - channels] : 0;   // átlós
      switch (filter) {
        case 0: break;                                     // None
        case 1: line[i] = (line[i] + a) & 0xff; break;     // Sub
        case 2: line[i] = (line[i] + b) & 0xff; break;     // Up
        case 3: line[i] = (line[i] + ((a + b) >> 1)) & 0xff; break;  // Average
        case 4: line[i] = (line[i] + paeth(a, b, c)) & 0xff; break;  // Paeth
        default: throw new Error('ismeretlen PNG sor-szűrő: ' + filter);
      }
    }

    // Egységesen RGBA-ra hozzuk, hogy a hívó ne foglalkozzon a csatornaszámmal.
    for (let x = 0; x < width; x++) {
      const s = x * channels, d = (y * width + x) * 4;
      out[d] = line[s];
      out[d + 1] = line[s + 1];
      out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }

  return { width, height, rgba: out };
}
