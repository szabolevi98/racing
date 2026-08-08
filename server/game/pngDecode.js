// Minimális PNG-dekóder: csak annyi, amennyi a zóna-térkép beolvasásához kell.
//
// Miért nem könyvtár: a projekt szándékosan függőség-szegény, és a bemenet
// nem tetszőleges PNG, hanem amit a böngésző canvas.toBlob()-ja ír ki —
// 8 bites, nem-interlaced, RGB vagy RGBA. Erre a szűk esetre a dekódolás
// néhány tucat sor, a zlib pedig eleve benne van a Node-ban.
//
// Ha valaha más alakú PNG kerülne ide, inkább hangosan elhasal, mint hogy
// csendben rossz képpontokat adjon.
//
// Miért SORONKÉNT ad vissza, és miért async? A zóna-térképek nagyok (mérve:
// 2432x4968 – 4394x4551, azaz 12–20 millió képpont). Egyben kibontva ez
// egyrészt 0,35–0,79 másodpercig egyhuzamban megállította a szervert — a Node
// egyszálú, tehát a többi szoba versenyét is —, másrészt egy 80 MB-os köztes
// RGBA puffert foglalt, amit a hívó úgyis rögtön eldobott. Soronként átadva
// nincs köztes puffer, és néhány ezredmásodpercenként visszaadjuk a szót az
// eseményhuroknak.
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const inflate = promisify(zlib.inflate);

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Ennyi ideig dolgozhatunk egyhuzamban, mielőtt visszaadjuk a szót.
const YIELD_MS = 8;

// A Paeth-előrejelző a PNG szabvány szerint: a bal, a fenti és az átlós
// szomszéd közül azt választja, amelyik a becsléshez legközelebb van.
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Egy sor szűrésének visszafejtése, HELYBEN. Szűrőnként külön ciklus: a régi
// változat képpontonként ágazott el egy switch-csel, ami 60 millió bájtnál
// önmagában is számottevő.
function unfilterRow(filter, line, prev, channels, stride) {
  switch (filter) {
    case 0:                                   // None
      return;
    case 1:                                   // Sub
      for (let i = channels; i < stride; i++) line[i] = (line[i] + line[i - channels]) & 0xff;
      return;
    case 2:                                   // Up
      for (let i = 0; i < stride; i++) line[i] = (line[i] + prev[i]) & 0xff;
      return;
    case 3:                                   // Average
      for (let i = 0; i < channels; i++) line[i] = (line[i] + (prev[i] >> 1)) & 0xff;
      for (let i = channels; i < stride; i++) {
        line[i] = (line[i] + ((line[i - channels] + prev[i]) >> 1)) & 0xff;
      }
      return;
    case 4:                                   // Paeth
      for (let i = 0; i < channels; i++) line[i] = (line[i] + prev[i]) & 0xff;
      for (let i = channels; i < stride; i++) {
        line[i] = (line[i] + paeth(line[i - channels], prev[i], prev[i - channels])) & 0xff;
      }
      return;
    default:
      throw new Error('ismeretlen PNG sor-szűrő: ' + filter);
  }
}

// A fejléc és az IDAT darabok kiszedése. Tisztán bájtolvasás, gyors.
function readChunks(buf) {
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
  return { width, height, channels, idat };
}

// Soronkénti dekódolás. Az `onRow(line, y, width, height, channels)` a
// KIBONTOTT sort kapja; a puffer a következő sorra újrahasznosul, tehát a
// hívónak azonnal fel kell dolgoznia (nem tárolhatja el a hivatkozást). A teljes
// méretet is megkapja, hogy már az első sornál akkora tárolót foglalhasson,
// amekkora kell.
//
// Visszatér: { width, height, channels }.
export async function decodePngRows(buf, onRow) {
  const { width, height, channels, idat } = readChunks(buf);
  // A kicsomagolás a Node szálkészletén fut, nem a fő szálon — ez önmagában
  // 73–132 ms blokkolást vesz le a rajtról.
  const raw = await inflate(Buffer.concat(idat));

  const stride = width * channels;
  let line = Buffer.alloc(stride);
  let prev = Buffer.alloc(stride);          // az előző sor, SZŰRÉS UTÁN
  let p = 0;
  let chunkStart = performance.now();

  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    raw.copy(line, 0, p, p + stride);
    p += stride;
    unfilterRow(filter, line, prev, channels, stride);
    onRow(line, y, width, height, channels);
    // A most kész sor lesz a következő "fent" szomszédja; a régi prev puffert
    // pedig újrahasznosítjuk, hogy soronként ne foglaljunk.
    const swap = prev; prev = line; line = swap;

    if (performance.now() - chunkStart >= YIELD_MS) {
      await new Promise((resolve) => setImmediate(resolve));
      chunkStart = performance.now();
    }
  }
  return { width, height, channels };
}
