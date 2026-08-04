// Egy helyen tartjuk a mappa-útvonalakat, hogy a szerver bárhonnan indítható
// legyen (nem függ attól, mi az aktuális munkakönyvtár).
//
// Szerkezet:
//   web/      — ez és CSAK ez publikus; a szerver innen szolgál ki fájlt
//   server/   — a játékszerver (nem publikus)
//   shared/   — a kliens és a szerver közös kódja (a kliens a webről kapja)
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(SERVER_DIR, '..');
export const WEB_DIR = path.join(ROOT_DIR, 'web');
export const ASSETS_DIR = path.join(WEB_DIR, 'assets');
export const SHARED_DIR = path.join(ROOT_DIR, 'shared');
