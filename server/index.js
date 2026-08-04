// A játékszerver belépési pontja.
//
// Egyetlen Node processz szolgálja ki a statikus klienst, a REST API-t és a
// WebSocket kapcsolatokat is — így fejlesztéskor egy `npm start` elég, és
// nincs külön Apache/PHP a képben.
import http from 'node:http';
import 'dotenv/config';
import { serveStatic } from './static.js';
import { getManifest } from './assets.js';
import { saveSpawn, saveGates, saveZonemap, saveCollision } from './devApi.js';

const PORT = Number(process.env.PORT) || 3000;
// A dev-mentések lemezre írnak és nincs mögöttük jogosultság-ellenőrzés.
// Éles kiszolgálón kapcsold ki (ALLOW_DEV_WRITES=0).
const ALLOW_DEV_WRITES = process.env.ALLOW_DEV_WRITES !== '0';

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limitBytes = 128 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('Túl nagy kérés.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/assets' && req.method === 'GET') {
    sendJson(res, 200, await getManifest());
    return true;
  }

  const devRoutes = {
    '/api/dev/spawn': async () => saveSpawn(JSON.parse((await readBody(req)).toString('utf8'))),
    '/api/dev/gates': async () => saveGates(JSON.parse((await readBody(req)).toString('utf8'))),
    '/api/dev/zonemap': async () => saveZonemap(JSON.parse((await readBody(req)).toString('utf8'))),
    '/api/dev/collision': async () => saveCollision(url.searchParams.get('mapId'), await readBody(req)),
  };

  const route = devRoutes[url.pathname];
  if (route) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Csak POST.' });
      return true;
    }
    if (!ALLOW_DEV_WRITES) {
      sendJson(res, 403, { error: 'A fejlesztői mentés ki van kapcsolva (ALLOW_DEV_WRITES=0).' });
      return true;
    }
    try {
      sendJson(res, 200, await route());
    } catch (err) {
      sendJson(res, err.status || 500, { error: err.message || 'Ismeretlen hiba.' });
    }
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname.startsWith('/api/')) {
      if (await handleApi(req, res, url)) return;
      sendJson(res, 404, { error: 'Nincs ilyen végpont.' });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (await serveStatic(req, res)) return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 — nincs ilyen fájl');
  } catch (err) {
    console.error('Kérés-hiba:', err);
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message || 'Szerverhiba.' });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Racing szerver fut:  http://localhost:${PORT}`);
  if (ALLOW_DEV_WRITES) console.log('Fejlesztői mentés: BE (ALLOW_DEV_WRITES=0 kapcsolja ki)');
});
