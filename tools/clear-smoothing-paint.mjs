import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

import { decodePngRows } from '../server/game/pngDecode.js';
import { isSmoothingPaint } from '../shared/zone.js';

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const out = Buffer.allocUnsafe(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  name.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return out;
}

function encodeRgbaPng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.allocUnsafe((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    rows[row] = 0;
    rgba.copy(rows, row + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function clearFile(file) {
  const input = readFileSync(file);
  let rgba = null;
  let imageWidth = 0;
  let imageHeight = 0;
  let cleared = 0;
  await decodePngRows(input, (row, y, width, height, channels) => {
    if (!rgba) {
      imageWidth = width;
      imageHeight = height;
      rgba = Buffer.alloc(width * height * 4);
    }
    for (let x = 0; x < width; x++) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      const alpha = channels === 4 ? row[source + 3] : 255;
      rgba[target] = row[source];
      rgba[target + 1] = row[source + 1];
      rgba[target + 2] = row[source + 2];
      rgba[target + 3] = alpha;
      if (isSmoothingPaint(row[source], row[source + 1], row[source + 2], alpha)) {
        rgba.fill(0, target, target + 4);
        cleared++;
      }
    }
  });
  if (!rgba) throw new Error(`Nem dekódolható PNG: ${file}`);
  writeFileSync(file, encodeRgbaPng(imageWidth, imageHeight, rgba));
  return cleared;
}

const files = process.argv.slice(2).map((file) => resolve(file));
if (!files.length) {
  console.error('Használat: node tools/clear-smoothing-paint.mjs <zonemap.png> [...]');
  process.exitCode = 1;
} else {
  for (const file of files) {
    const cleared = await clearFile(file);
    console.log(`${file}: ${cleared} simításképpont törölve`);
  }
}
