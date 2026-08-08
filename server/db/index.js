// MySQL/MariaDB kapcsolat és a tartós adatok kezelése.
//
// A kapcsolat NEM kötelező: ha nincs adatbázis, a játék attól még megy — csak
// az eredmények nem őrződnek meg. Egy hiányzó DB ne akadályozza a versenyzést.
import mysql from 'mysql2/promise';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SERVER_DIR } from '../paths.js';

let pool = null;
let available = false;

export function dbAvailable() {
  return available;
}

export async function initDb() {
  const cfg = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'racing',
    connectionLimit: 10,
    charset: 'utf8mb4',
  };
  try {
    pool = mysql.createPool(cfg);
    const conn = await pool.getConnection();
    // A séma futtatása induláskor idempotens (CREATE TABLE IF NOT EXISTS),
    // így egy friss gépen nem kell kézzel importálni.
    const sql = await fs.readFile(path.join(SERVER_DIR, 'db', 'schema.sql'), 'utf8');
    for (const stmt of sql.split(/;\s*[\r\n]/).map((s) => s.trim()).filter(Boolean)) {
      // A CREATE DATABASE/USE sorokat kihagyjuk: a pool már a megadott
      // adatbázishoz kapcsolódik, és lehet, hogy nincs jogunk DB-t létrehozni.
      if (/^\s*(CREATE\s+DATABASE|USE)\b/i.test(stmt)) continue;
      await conn.query(stmt);
    }
    conn.release();
    available = true;
    console.log(`Adatbázis: csatlakozva (${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database})`);

    // Karbantartás induláskor. Nem kritikus: ha elhasal, a játék megy tovább,
    // csak a takarítás marad el — ezért nem dobunk hibát.
    try {
      const torolt = await purgeAbandonedRaces();
      if (torolt) console.log(`Adatbázis: ${torolt} elhagyott (üres) verseny törölve.`);
    } catch (err) {
      console.warn('Adatbázis: a karbantartás nem futott le — ' + err.message);
    }
  } catch (err) {
    available = false;
    console.warn('Adatbázis: NEM elérhető — az eredmények nem lesznek elmentve.');
    console.warn('  ' + err.message);
  }
}

// --- Karbantartás (induláskor fut) -----------------------------------------

// Elhagyott versenyek: a races sor a verseny INDÍTÁSAKOR születik, még mielőtt
// bárki betöltött volna — így minden megszakadt indítás otthagy egy üres sort
// (mérve: 39-ből 27 ilyen volt). Ezek bármilyen korban értéktelenek, tehát nem
// időalapú retenció, hanem egyszerű szemét-eltakarítás.
//
// A "se köre, se eredménye" feltétel miatt rekordot nem érinthet: ahhoz kör
// kellene. A folyamatban lévő versenyt a NOW() - 1 óra védi.
export async function purgeAbandonedRaces() {
  if (!available) return 0;
  const [res] = await pool.query(
    `DELETE r FROM races r
      WHERE r.started_at < (NOW() - INTERVAL 1 HOUR)
        AND NOT EXISTS (SELECT 1 FROM lap_times    l WHERE l.race_id = r.id)
        AND NOT EXISTS (SELECT 1 FROM race_results x WHERE x.race_id = r.id)`
  );
  return res.affectedRows;
}

// --- Játékosok -------------------------------------------------------------

// Névvel lépünk be; a visszakapott token teszi lehetővé, hogy újratöltés után
// ugyanaz a játékos legyünk. Ha érvényes tokent küldenek, azt frissítjük.
export async function upsertPlayer(name, token) {
  if (!available) {
    // Adatbázis nélkül is működjön a játék: adunk egy ideiglenes azonosítót.
    return { id: null, name, token: token || randomUUID() };
  }
  if (token) {
    const [rows] = await pool.query('SELECT id, name FROM players WHERE token = ? LIMIT 1', [token]);
    if (rows.length) {
      if (rows[0].name !== name) {
        await pool.query('UPDATE players SET name = ? WHERE id = ?', [name, rows[0].id]);
      } else {
        await pool.query('UPDATE players SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?', [rows[0].id]);
      }
      return { id: rows[0].id, name, token };
    }
  }
  const fresh = randomUUID();
  const [res] = await pool.query('INSERT INTO players (name, token) VALUES (?, ?)', [name, fresh]);
  return { id: res.insertId, name, token: fresh };
}

// --- Versenyek -------------------------------------------------------------

export async function createRace(roomCode, mapId, totalLaps) {
  if (!available) return null;
  const [res] = await pool.query(
    'INSERT INTO races (room_code, map_id, total_laps) VALUES (?, ?, ?)',
    [roomCode, mapId, totalLaps]
  );
  return res.insertId;
}

export async function finishRace(raceId) {
  if (!available || !raceId) return;
  await pool.query('UPDATE races SET finished_at = CURRENT_TIMESTAMP WHERE id = ?', [raceId]);
}

export async function saveResult(raceId, playerId, data) {
  if (!available || !raceId || !playerId) return;
  await pool.query(
    `INSERT INTO race_results (race_id, player_id, car_id, finish_position, total_ms, best_lap_ms, laps_completed)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE finish_position = VALUES(finish_position), total_ms = VALUES(total_ms),
       best_lap_ms = VALUES(best_lap_ms), laps_completed = VALUES(laps_completed)`,
    [raceId, playerId, data.carId || '', data.position ?? null, data.totalMs ?? null,
     data.bestLapMs ?? null, data.lapsCompleted ?? 0]
  );
}

export async function saveLap(raceId, playerId, lapNumber, timeMs, invalid, mapId) {
  if (!available || !raceId || !playerId) return;
  const ms = Math.round(timeMs);
  await pool.query(
    'INSERT INTO lap_times (race_id, player_id, lap_number, time_ms, invalid) VALUES (?, ?, ?, ?, ?)',
    [raceId, playerId, lapNumber, ms, invalid ? 1 : 0]
  );
  // A rekord a NYERS előzménytől függetlenül él (lásd map_records a
  // schema.sql-ben). Csak érvényes kör számít, és csak akkor írjuk felül, ha
  // tényleg gyorsabb — a feltételes UPDATE miatt ehhez nem kell külön SELECT,
  // tehát két egyszerre beérkező kör sem tud rossz sorrendben landolni.
  //
  // Az értékadások SORRENDJE számít: a best_ms megy utoljára. A MariaDB balról
  // jobbra értékel, tehát ha elöl állna, a mögötte lévő IF-ek már az ÚJ értéket
  // hasonlítanák önmagához (mindig hamis) — pontosan ettől frissült korábban
  // csak az idő, a race_id és az achieved_at pedig a régi rekordé maradt.
  if (invalid || !mapId) return;
  await pool.query(
    `INSERT INTO map_records (player_id, map_id, best_ms, race_id)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       race_id     = IF(VALUES(best_ms) < map_records.best_ms, VALUES(race_id),  map_records.race_id),
       achieved_at = IF(VALUES(best_ms) < map_records.best_ms, CURRENT_TIMESTAMP, map_records.achieved_at),
       best_ms     = LEAST(map_records.best_ms, VALUES(best_ms))`,
    [playerId, mapId, ms, raceId]
  );
}

// Pályánkénti leggyorsabb körök — ranglistához. A map_records-ból olvas, tehát
// a rekordok akkor is megmaradnak, ha a mögöttük lévő versenyt kitakarítottuk.
export async function bestLaps(mapId, limit = 20) {
  if (!available) return [];
  const [rows] = await pool.query(
    `SELECT p.name, m.best_ms, m.map_id, m.achieved_at
       FROM map_records m
       JOIN players p ON p.id = m.player_id
      WHERE m.map_id = ?
      ORDER BY m.best_ms ASC
      LIMIT ?`,
    [mapId, limit]
  );
  return rows;
}
