-- Racing adatbázis-séma.
--
-- Ami MEMÓRIÁBAN él a szerveren és nincs itt: a szobák pillanatnyi állapota
-- (ki hol tart a pályán, milyen gyorsan megy). Az másodpercenként sokszor
-- változik, és egy szerver-újraindítás után úgyis értelmét veszti.
--
-- Ami IDE kerül: ami túléli a versenyt — kik játszottak, mit futottak.

CREATE DATABASE IF NOT EXISTS racing
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE racing;

-- Nincs jelszó/regisztráció: a játékos nevet ad meg, és kap egy tokent, amivel
-- vissza tud térni ugyanahhoz a névhez (pl. újratöltés után).
CREATE TABLE IF NOT EXISTS players (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name         VARCHAR(32)     NOT NULL,
  token        CHAR(36)        NOT NULL,
  created_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_token (token),
  KEY idx_name (name)
) ENGINE=InnoDB;

-- Egy lefutott verseny. A szoba maga memóriában él; ide csak akkor kerül sor,
-- amikor a verseny ténylegesen elindult.
CREATE TABLE IF NOT EXISTS races (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  room_code   CHAR(6)         NOT NULL,
  map_id      VARCHAR(128)    NOT NULL,
  total_laps  TINYINT UNSIGNED NOT NULL,
  started_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP       NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_map (map_id),
  KEY idx_started (started_at)
) ENGINE=InnoDB;

-- Egy játékos eredménye egy versenyen. A finish_position NULL, ha nem ért célba.
CREATE TABLE IF NOT EXISTS race_results (
  race_id         BIGINT UNSIGNED NOT NULL,
  player_id       BIGINT UNSIGNED NOT NULL,
  car_id          VARCHAR(128)    NOT NULL,
  finish_position TINYINT UNSIGNED NULL,
  total_ms        INT UNSIGNED    NULL,
  best_lap_ms     INT UNSIGNED    NULL,
  laps_completed  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (race_id, player_id),
  KEY idx_player (player_id),
  KEY idx_best_lap (best_lap_ms),
  CONSTRAINT fk_result_race   FOREIGN KEY (race_id)   REFERENCES races(id)   ON DELETE CASCADE,
  CONSTRAINT fk_result_player FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Körönkénti idők. Az érvénytelen kört megtartjuk (megjelöléssel), mert a
-- versenyóra szempontjából eltelt idő — csak a legjobb körbe nem számít.
CREATE TABLE IF NOT EXISTS lap_times (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  race_id    BIGINT UNSIGNED NOT NULL,
  player_id  BIGINT UNSIGNED NOT NULL,
  lap_number TINYINT UNSIGNED NOT NULL,
  time_ms    INT UNSIGNED    NOT NULL,
  invalid    TINYINT(1)      NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_race_player (race_id, player_id),
  CONSTRAINT fk_lap_race   FOREIGN KEY (race_id)   REFERENCES races(id)   ON DELETE CASCADE,
  CONSTRAINT fk_lap_player FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Pályánkénti egyéni rekord: játékosonként és pályánként EGY sor, a valaha
-- futott leggyorsabb ÉRVÉNYES kör.
--
-- Miért külön tábla, és nem a lap_times-ból számoljuk (ahogy korábban)?
-- Mert a lap_times ON DELETE CASCADE-del lóg a races-en: bármilyen
-- verseny-takarítás NÉMÁN megsemmisítené a ranglistát. Így a rekord az
-- előzménytől függetlenül él tovább — a nyers körök szabadon törölhetők —,
-- és a ranglista is olcsóbb lesz: egy kis táblát olvas, nem GROUP BY-oz
-- végig az egész előzményen.
--
-- A race_id szándékosan SET NULL-ozódik, nem törli a sort: ha a verseny
-- eltűnik, a rekord marad, csak a hivatkozás vész el.
CREATE TABLE IF NOT EXISTS map_records (
  player_id   BIGINT UNSIGNED NOT NULL,
  map_id      VARCHAR(128)    NOT NULL,
  car_id      VARCHAR(128)    NOT NULL DEFAULT '',
  best_ms     INT UNSIGNED    NOT NULL,
  race_id     BIGINT UNSIGNED NULL,
  ghost_data  MEDIUMTEXT      NULL,
  achieved_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (player_id, map_id),
  KEY idx_map_best (map_id, best_ms),
  CONSTRAINT fk_record_player FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
  CONSTRAINT fk_record_race   FOREIGN KEY (race_id)   REFERENCES races(id)   ON DELETE SET NULL
) ENGINE=InnoDB;
