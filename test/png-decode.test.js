import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { decodePngRows } from '../server/game/pngDecode.js';
import {
  zoneCodesFromRow, decodeZoneCodes, decodeSmoothingMask,
  ZONE_ASPHALT, ZONE_OFFTRACK, ZONE_WALL,
} from '../shared/zone.js';

// Egy PNG összerakása kézzel. A dekóder nem ellenőriz CRC-t (a bemenet mindig
// a saját zóna-szerkesztőnk kimenete), ezért a CRC helye maradhat nulla.
function makePng(width, height, channels, rows) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;                              // bitmélység
  ihdr[9] = channels === 4 ? 6 : 2;         // RGBA / RGB
  ihdr[12] = 0;                             // nem interlaced
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Ugyanaz a kép ötféle sor-szűrővel kódolva. A szűrők a PNG szabvány szerint
// az ELŐZŐ (már visszafejtett) sorhoz képest dolgoznak.
function encodeRows(pixels, width, height, channels, filter) {
  const stride = width * channels;
  const rows = [];
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const raw = pixels.subarray(y * stride, (y + 1) * stride);
    const enc = Buffer.alloc(stride + 1);
    enc[0] = filter;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? raw[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let sub;
      switch (filter) {
        case 0: sub = 0; break;
        case 1: sub = a; break;
        case 2: sub = b; break;
        case 3: sub = (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          sub = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          break;
        }
        default: throw new Error('ismeretlen szűrő');
      }
      enc[i + 1] = (raw[i] - sub) & 0xff;
    }
    raw.copy(prev);
    rows.push(enc);
  }
  return rows;
}

async function decodeToCodes(png) {
  let codes = null;
  const size = await decodePngRows(png, (line, y, w, h, channels) => {
    if (codes === null) codes = new Uint8Array(w * h);
    zoneCodesFromRow(codes, y * w, line, 0, w, channels);
  });
  return { codes, ...size };
}

test('every PNG row filter decodes to the same zone codes', async () => {
  const width = 7, height = 5, channels = 4;
  const pixels = Buffer.alloc(width * height * channels);
  // Festetlen (átlátszó) = aszfalt, narancs = kifutó, bordó = fal — ugyanazok a
  // színek, amiket a zóna-szerkesztő ír ki.
  const paint = (x, y, r, g, b, a) => {
    const o = (y * width + x) * channels;
    pixels[o] = r; pixels[o + 1] = g; pixels[o + 2] = b; pixels[o + 3] = a;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x === y) paint(x, y, 255, 165, 0, 255);          // kifutó
      else if (x === y + 1) paint(x, y, 220, 20, 60, 255); // fal
      else if (x === 6) paint(x, y, 255, 165, 0, 10);      // majdnem átlátszó -> aszfalt
    }
  }
  const vart = decodeZoneCodes(pixels, width, height);

  for (const filter of [0, 1, 2, 3, 4]) {
    const png = makePng(width, height, channels, encodeRows(pixels, width, height, channels, filter));
    const { codes, width: w, height: h } = await decodeToCodes(png);
    assert.equal(w, width);
    assert.equal(h, height);
    assert.deepEqual(
      Array.from(codes), Array.from(vart),
      `a(z) ${filter}. szűrővel kódolt kép másképp jött vissza`
    );
  }
  // A minta tényleg tartalmazza mindhárom zónát — különben a teszt üresen is
  // átmenne.
  assert.ok(vart.includes(ZONE_ASPHALT) && vart.includes(ZONE_OFFTRACK) && vart.includes(ZONE_WALL));
});

test('RGB (alpha-less) PNGs count every pixel as painted', async () => {
  const width = 3, height = 2, channels = 3;
  const pixels = Buffer.from([
    255, 165, 0,   220, 20, 60,   255, 165, 0,
    220, 20, 60,   255, 165, 0,   220, 20, 60,
  ]);
  const png = makePng(width, height, channels, encodeRows(pixels, width, height, channels, 0));
  const { codes } = await decodeToCodes(png);
  assert.deepEqual(Array.from(codes), [
    ZONE_OFFTRACK, ZONE_WALL, ZONE_OFFTRACK,
    ZONE_WALL, ZONE_OFFTRACK, ZONE_WALL,
  ]);
});

test('blue smoothing paint stays asphalt for physics and remains separately selectable', () => {
  const pixels = Uint8ClampedArray.from([
    30, 144, 255, 255,
    255, 165, 0, 255,
    220, 20, 60, 255,
    30, 144, 255, 10,
  ]);
  assert.deepEqual(Array.from(decodeZoneCodes(pixels, 4, 1)), [
    ZONE_ASPHALT, ZONE_OFFTRACK, ZONE_WALL, ZONE_ASPHALT,
  ]);
  assert.deepEqual(Array.from(decodeSmoothingMask(pixels, 4, 1)), [1, 0, 0, 0]);
});

test('a malformed header fails loudly instead of returning wrong pixels', async () => {
  await assert.rejects(
    () => decodeToCodes(Buffer.alloc(64)),
    /nem PNG fájl/
  );
});
