// Statikus fájlkiszolgálás a web/ mappából. Ez váltja ki az Apache-ot.
//
// Két dolgot csinál, amit az .htaccess korábban:
//  - a HTML/JS/CSS mindig újraérvényesítődik: a böngésző eltárolja, de
//    használat előtt ETag-gel rákérdez, így sosem futhat régi kód (a stale
//    cache fejlesztés közben nagyon megtévesztő hibákat okoz: "hiba", ami
//    valójában csak korábban betöltött kód) — a változatlan fájl viszont
//    304-gyel, üres törzzsel jön vissza, nem tölt le újra;
//  - az assetek (modellek, textúrák, HDRI) hosszan, "immutable" módon
//    cache-elődnek — ezek nagyok és ritkán változnak. Amelyik mégis változhat
//    (zonemap.png, collision.bin), az a manifestből kap `v` cache-kulcsot.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream';
import { WEB_DIR, SHARED_DIR } from './paths.js';
import { registerLoopLagContext } from './loopLag.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.hdr': 'image/vnd.radiance',
  '.exr': 'image/x-exr',
  '.ktx2': 'image/ktx2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

// A WASM is futó kód, és a basis_transcoder.js-szel verzióban együtt mozog.
// Ugyanúgy újraérvényesítjük, mint a JS-t; változatlanul 304, frissítéskor pedig
// nem ragadhat bent az egyéves immutable cache-ben egy inkompatibilis dekóder.
const NO_CACHE = new Set(['.html', '.js', '.mjs', '.css', '.wasm']);

// Amit érdemes menet közben tömöríteni. A .glb/.png/.hdr KIMARAD: a képek és
// a textúrákat tartalmazó modellek már tömörítettek, azokon a gzip alig nyer,
// viszont minden kérésnél CPU-t égetne. (Mért adat ebben a projektben:
// collision.bin 49%-ot nyer, egy 59 MB-os pálya-glb viszont csak 20%-ot.)
const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.html', '.json', '.gltf', '.bin', '.svg', '.txt']);
// Ez alatt nem érdemes: a fejléc-többlet többe kerül, mint amennyit nyerünk.
const MIN_COMPRESS_BYTES = 1024;
let activeTransfers = 0;
let activeCompressedTransfers = 0;
let activeSourceBytes = 0;

registerLoopLagContext('static', () => ({
  activeTransfers,
  activeCompressedTransfers,
  activeSourceMb: Math.round(activeSourceBytes / (1024 * 1024) * 10) / 10,
}));

function trackTransfer(res, sourceBytes, compressed = false) {
  activeTransfers++;
  if (compressed) activeCompressedTransfers++;
  activeSourceBytes += Math.max(0, Number(sourceBytes) || 0);
  let active = true;
  const finish = () => {
    if (!active) return;
    active = false;
    activeTransfers--;
    if (compressed) activeCompressedTransfers--;
    activeSourceBytes -= Math.max(0, Number(sourceBytes) || 0);
  };
  res.once('finish', finish);
  res.once('close', finish);
}

// A kérés útvonalát fájlrendszer-útvonallá alakítja, és megakadályozza a
// kitörést a gyökér alól (../-es kérések).
function resolveSafe(baseDir, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const rel = path.normalize(decoded).replace(/^([/\\])+/, '');
  const full = path.join(baseDir, rel);
  if (full !== baseDir && !full.startsWith(baseDir + path.sep)) return null;
  return full;
}

export async function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  // A /dev csak egy szebb alternatíva a ?dev=1-hez — ugyanazt az index.html-t
  // adja ki, a dev mód felismerése a kliens oldalon (main.js) az útvonalból
  // is megy, nem csak a query paraméterből.
  if (urlPath === '/' || urlPath === '/dev') urlPath = '/index.html';

  // A kliens és a szerver közös kódja a shared/ mappában él (a repo
  // gyökerében, nem a web/ alatt) — a böngészőnek viszont el kell érnie,
  // ezért ezt az egy útvonalat külön kiszolgáljuk.
  let baseDir = WEB_DIR;
  if (urlPath.startsWith('/shared/')) {
    baseDir = SHARED_DIR;
    urlPath = urlPath.slice('/shared'.length);
  }

  const full = resolveSafe(baseDir, urlPath);
  if (!full) {
    res.writeHead(403).end('Forbidden');
    return true;
  }

  let stat;
  try {
    stat = await fsp.stat(full);
    if (stat.isDirectory()) {
      const idx = path.join(full, 'index.html');
      stat = await fsp.stat(idx);
      return sendFile(req, res, idx, stat);
    }
  } catch {
    return false; // nincs ilyen fájl — a hívó dönt (404 vagy más útvonal)
  }
  return sendFile(req, res, full, stat);
}

function sendFile(req, res, full, stat) {
  const ext = path.extname(full).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
  };

  if (NO_CACHE.has(ext)) {
    // "no-cache" NEM azt jelenti, hogy tilos tárolni — azt jelenti, hogy
    // használat előtt mindig újra kell érvényesíteni. A böngésző eltárolja a
    // fájlt, majd minden betöltésnél If-None-Match fejléccel rákérdez, és ha
    // az ETag stimmel, 304-et kap ÜRES törzzsel.
    //
    // Korábban itt "no-store" is szerepelt, ami megtiltotta a tárolást — így
    // az alatta felépített ETag-gépezet sosem jutott szóhoz, és a teljes
    // kliens (main.js + mp.js + shared + vendor = gzip-pel ~1.1 MB, aminek
    // 95%-a a gyakorlatilag sosem változó vendor/) MINDEN oldalbetöltésnél
    // újra lement a dróton.
    //
    // A frissesség változatlanul garantált: az ETag a fájl méretéből és
    // mtime-jából készül, tehát bármilyen mentés új kulcsot ad, és a
    // böngésző azonnal a friss tartalmat tölti — fejlesztés közben is.
    //
    // Ezért NEM kapnak ezek a fájlok hosszú "immutable" cache-t sem, pedig a
    // vendor/ mérete csábító: egy beragadt régi rapier.es.js némán eltérő
    // fizikát adna a játékosok böngészőiben.
    //
    // És ezért nincs "?v=..." az index.html <script src="main.js">-én sem.
    // Egy query string ott CSAK azt az egy fájlt verziózná: az ES-modul
    // importokat (./vendor/..., /shared/...) a böngésző külön, query nélkül
    // kéri le, tehát a forgalom 95%-át nem érintené. A teljes modulgráf
    // verziózásához build lépés kellene, ami minden import útvonalat átír —
    // az itteni újraérvényesítés ugyanazt a frissességet adja anélkül.
    headers['Cache-Control'] = 'no-cache, must-revalidate';
  } else {
    // Az assetek nagyok (egy pálya 60-150 MB) és gyakorlatilag sosem
    // változnak — egy távoli játékosnak az első betöltés így is percekig
    // tarthat a feltöltési sávszélességen. Hosszú, "immutable" cache-sel a
    // MÁSODIK indulás azonnali: a böngésző rá se kérdez a szerverre.
    // A manifest méret+mtime verziót tesz a nagy assetek URL-jére, ezért egy
    // frissített modell új címet kap anélkül, hogy át kellene nevezni a fájlt.
    headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  }

  // Egyszerű, de elegendő ETag: méret + módosítási idő.
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  headers.ETag = etag;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers).end();
    return true;
  }

  // Range-kérés (a böngésző nagy modelleknél élhet vele)
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (start <= end && end < stat.size) {
        headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
        headers['Content-Length'] = end - start + 1;
        headers['Accept-Ranges'] = 'bytes';
        res.writeHead(206, headers);
        trackTransfer(res, end - start + 1);
        fs.createReadStream(full, { start, end }).pipe(res);
        return true;
      }
    }
  }

  // Tömörítés, ha a böngésző kéri és a típuson van mit nyerni. A
  // Content-Length ilyenkor elmarad (nem tudjuk előre a tömörített méretet),
  // ezért chunked válasz megy.
  const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (acceptsGzip && COMPRESSIBLE.has(ext) && stat.size >= MIN_COMPRESS_BYTES && req.method !== 'HEAD') {
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
    res.writeHead(200, headers);
    trackTransfer(res, stat.size, true);
    pipeline(fs.createReadStream(full), zlib.createGzip({ level: 6 }), res, () => {});
    return true;
  }

  headers['Content-Length'] = stat.size;
  headers['Accept-Ranges'] = 'bytes';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
  } else {
    trackTransfer(res, stat.size);
    fs.createReadStream(full).pipe(res);
  }
  return true;
}
