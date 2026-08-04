// Statikus fájlkiszolgálás a web/ mappából. Ez váltja ki az Apache-ot.
//
// Két dolgot csinál, amit az .htaccess korábban:
//  - a HTML/JS soha nem cache-elődik (fejlesztés közben a stale cache nagyon
//    megtévesztő hibákat okoz: "hiba", ami valójában csak régi betöltött kód),
//  - az assetek (modellek, textúrák, HDRI) viszont igen — ezek nagyok és
//    ritkán változnak, minden játékosnak letöltés.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { WEB_DIR, SHARED_DIR } from './paths.js';

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

const NO_CACHE = new Set(['.html', '.js', '.mjs', '.css']);

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
  if (urlPath === '/') urlPath = '/index.html';

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
    headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
  } else {
    // Az assetek tartalma a nevükhöz kötött és ritkán változik; az ETag
    // miatt a böngésző így is ellenőrzi, hogy friss-e.
    headers['Cache-Control'] = 'public, max-age=3600';
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
        fs.createReadStream(full, { start, end }).pipe(res);
        return true;
      }
    }
  }

  headers['Content-Length'] = stat.size;
  headers['Accept-Ranges'] = 'bytes';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
  } else {
    fs.createReadStream(full).pipe(res);
  }
  return true;
}
