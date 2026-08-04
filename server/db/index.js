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
  } catch (err) {
    available = false;
    console.warn('Adatbázis: NEM elérhető — az eredmények nem lesznek elmentve.');
    console.warn('  ' + err.message);
  }
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

export async function saveLap(raceId, playerId, lapNumber, timeMs, invalid) {
  if (!available || !raceId || !playerId) return;
  await pool.query(
    'INSERT INTO lap_times (race_id, player_id, lap_number, time_ms, invalid) VALUES (?, ?, ?, ?, ?)',
    [raceId, playerId, lapNumber, Math.round(timeMs), invalid ? 1 : 0]
  );
}

// Pályánkénti leggyorsabb ÉRVÉNYES körök — ranglistához.
export async function bestLaps(mapId, limit = 20) {
  if (!available) return [];
  const [rows] = await pool.query(
    `SELECT p.name, MIN(l.time_ms) AS best_ms, r.map_id
       FROM lap_times l
       JOIN races r  ON r.id = l.race_id
       JOIN players p ON p.id = l.player_id
      WHERE l.invalid = 0 AND r.map_id = ?
      GROUP BY p.id, r.map_id
      ORDER BY best_ms ASC
      LIMIT ?`,
    [mapId, limit]
  );
  return rows;
}
