import fs from 'node:fs/promises';
import path from 'node:path';
import { ASSETS_DIR } from '../paths.js';
import { zoneCodesFromRow } from '../../shared/zone.js';
import { decodePngRows } from './pngDecode.js';

// A nagy zónatérképeket csak használatkor dekódoljuk, és legfeljebb három
// pályát tartunk memóriában. A manifest `v` kulcsa dev mentés után megváltozik,
// ezért az új kép automatikusan új cache-bejegyzést kap.
const CACHE_LIMIT = 3;
const cache = new Map();

function remember(key, value) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return value;
}

export async function loadMapZoneRuntime(map) {
  if (map?.zoneRuntime) return map.zoneRuntime;
  const zonemap = map?.zonemap;
  if (!zonemap?.file || !zonemap?.bounds) return null;

  const key = `${zonemap.file}?${zonemap.v || ''}`;
  if (cache.has(key)) return cache.get(key);

  const loading = (async () => {
    try {
      const file = path.resolve(ASSETS_DIR, zonemap.file);
      const assetsRoot = path.resolve(ASSETS_DIR) + path.sep;
      if (!file.startsWith(assetsRoot)) throw new Error('érvénytelen zónatérkép útvonal');
      const png = await fs.readFile(file);
      let codes;
      const size = await decodePngRows(png, (row, y, width, height, channels) => {
        if (!codes) codes = new Uint8Array(width * height);
        zoneCodesFromRow(codes, y * width, row, 0, width, channels);
      });
      return { codes, w: size.width, h: size.height, bounds: zonemap.bounds };
    } catch (error) {
      console.warn(`[zone] ${map?.id || 'ismeretlen pálya'} zónatérképe nem olvasható:`, error.message);
      return null;
    }
  })();

  remember(key, loading);
  const runtime = await loading;
  return remember(key, runtime);
}
