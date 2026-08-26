// Minden vezethető aszfaltot kék simításjelöléssel fest be a zónatérképen.
//
// Miért kell: a sütés simításjelölés HIÁNYÁBAN a teljes aszfaltot simítja. Ha
// abból csak néhány szakaszt akarsz kihagyni (mert ott durva a háló vagy valódi
// lejtés van), akkor kézzel kellene végigfesteni az egész pályát, hogy aztán a
// kihagyandó részt letöröld. Ez az eszköz megcsinálja helyetted a kiindulást:
// utána a zóna-szerkesztőben már csak a kihagyandó foltokat kell visszatörölni
// sima aszfaltra. A párja a clear-smoothing-paint.mjs.
//
// Miért a geometriából dolgozik, és nem festi tele az egész képet: a zónatérkép
// alapértéke az "aszfalt", tehát a festetlen képpont a pályán KÍVÜL is aszfalt.
// Ha az egész kép kék lenne, a szerkesztőben nem látszana a pálya vonala, és
// nem lehetne mit visszatörölni. Ezért a lesütött ütközési TALAJHÁLÓT vetítjük
// a képre: pontosan az lesz kék, amit a fizika vezethetőnek tart.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';

import { decodePngRows } from '../server/game/pngDecode.js';
import { isSmoothingPaint } from '../shared/zone.js';

// A szerkesztő ecsetjének színe — lásd shared/zone.js isSmoothingPaint().
const FESTEK = [30, 144, 255, 255];
const COLLISION_MAGIC = 0xc0111505;

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

// A collision.bin TALAJ hálója: magic, majd két háló (talaj, fal), mindkettő
// csúcsszám + indexszám fejléccel. Nekünk csak az első kell.
function floorMesh(file) {
  const buffer = readFileSync(file);
  if (buffer.length < 12 || buffer.readUInt32LE(0) !== COLLISION_MAGIC) {
    throw new Error(`Nem ütközési fájl (hiányzó fejléc): ${file}`);
  }
  const vertexCount = buffer.readUInt32LE(4);
  const indexCount = buffer.readUInt32LE(8);
  const positions = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount * 3; i++) positions[i] = buffer.readFloatLE(12 + i * 4);
  const indices = new Uint32Array(indexCount);
  const base = 12 + vertexCount * 12;
  for (let i = 0; i < indexCount; i++) indices[i] = buffer.readUInt32LE(base + i * 4);
  return { positions, indices };
}

// Háromszög kirasztereálása a képpontrácsra, a képpont KÖZEPÉRE illesztett
// baricentrikus teszttel. A `sampleZone` képlete a mérce: u az X-ből, v a
// Z-ből, sor-folytonos tárolás.
function rasterize(mark, width, height, bounds, positions, indices) {
  const skalaX = width / (bounds.maxX - bounds.minX);
  const skalaZ = height / (bounds.maxZ - bounds.minZ);
  const kepX = (x) => (x - bounds.minX) * skalaX;
  const kepZ = (z) => (z - bounds.minZ) * skalaZ;
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ax = kepX(positions[a]), az = kepZ(positions[a + 2]);
    const bx = kepX(positions[b]), bz = kepZ(positions[b + 2]);
    const cx = kepX(positions[c]), cz = kepZ(positions[c + 2]);
    const ter = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    if (Math.abs(ter) < 1e-12) continue;   // elfajult vagy függőleges lap
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
    const z0 = Math.max(0, Math.floor(Math.min(az, bz, cz)));
    const z1 = Math.min(height - 1, Math.ceil(Math.max(az, bz, cz)));
    for (let py = z0; py <= z1; py++) {
      const qz = py + 0.5;
      for (let px = x0; px <= x1; px++) {
        const qx = px + 0.5;
        const w0 = ((bx - ax) * (qz - az) - (bz - az) * (qx - ax)) / ter;
        const w1 = ((qx - ax) * (cz - az) - (qz - az) * (cx - ax)) / ter;
        if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
        mark[py * width + px] = 1;
      }
    }
  }
  return mark;
}

// Egy képpontnyi kiterjesztés. A képpontközepes teszt a közös éleken hajszálnyi
// lyukakat hagyhat, és egy lyuk a maszkban azt jelentené, hogy ott mégis a
// "nincs jelölés" ág fut le.
function dilate(mark, width, height) {
  const out = Uint8Array.from(mark);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mark[y * width + x]) continue;
      for (let dy = -1; dy <= 1 && !out[y * width + x]; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny < 0 || nx < 0 || ny >= height || nx >= width) continue;
          if (mark[ny * width + nx]) { out[y * width + x] = 1; break; }
        }
      }
    }
  }
  return out;
}

async function fillMap(dir) {
  const png = join(dir, 'zonemap.png');
  const meta = join(dir, 'zonemap.json');
  const collision = join(dir, 'collision.bin');
  for (const f of [png, meta, collision]) {
    if (!existsSync(f)) throw new Error(`Hiányzik: ${f}`);
  }
  const { bounds } = JSON.parse(readFileSync(meta, 'utf8'));

  let rgba = null, width = 0, height = 0;
  await decodePngRows(readFileSync(png), (row, y, w, h, channels) => {
    if (!rgba) { width = w; height = h; rgba = Buffer.alloc(w * h * 4); }
    for (let x = 0; x < w; x++) {
      const s = x * channels, t = (y * w + x) * 4;
      rgba[t] = row[s]; rgba[t + 1] = row[s + 1]; rgba[t + 2] = row[s + 2];
      rgba[t + 3] = channels === 4 ? row[s + 3] : 255;
    }
  });
  if (!rgba) throw new Error(`Nem dekódolható PNG: ${png}`);

  const { positions, indices } = floorMesh(collision);
  const mark = dilate(rasterize(new Uint8Array(width * height), width, height, bounds, positions, indices),
    width, height);

  let festve = 0, marVolt = 0, erintetlen = 0;
  for (let p = 0; p < width * height; p++) {
    if (!mark[p]) continue;
    const t = p * 4;
    if (isSmoothingPaint(rgba[t], rgba[t + 1], rgba[t + 2], rgba[t + 3])) { marVolt++; continue; }
    // A fal- és kifutófestéshez NEM nyúlunk: azok szándékos döntések, és a
    // simításjelölés úgysem érvényes rájuk (ott nincs aszfalt).
    if (rgba[t + 3] >= 16) { erintetlen++; continue; }
    rgba[t] = FESTEK[0]; rgba[t + 1] = FESTEK[1]; rgba[t + 2] = FESTEK[2]; rgba[t + 3] = FESTEK[3];
    festve++;
  }
  writeFileSync(png, encodeRgbaPng(width, height, rgba));
  return { festve, marVolt, erintetlen, width, height, haromszog: indices.length / 3 };
}

const dirs = process.argv.slice(2).map((d) => resolve(d));
if (!dirs.length) {
  console.error('Használat: node tools/fill-smoothing-paint.mjs <pálya mappája> [...]');
  console.error('Például:   node tools/fill-smoothing-paint.mjs web/assets/maps/sachsenring_2020_layout');
  process.exitCode = 1;
} else {
  for (const dir of dirs) {
    const r = await fillMap(dir);
    console.log(`${dir}`);
    console.log(`  kép ${r.width}×${r.height}, talajháló ${r.haromszog} háromszög`);
    console.log(`  simításra festve: ${r.festve} képpont`);
    console.log(`  már jelölt volt:  ${r.marVolt}`);
    console.log(`  fal/kifutó, érintetlen hagyva: ${r.erintetlen}`);
  }
}
