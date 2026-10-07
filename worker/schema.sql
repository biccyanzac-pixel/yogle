-- D1 schema for Yogle's shared daily leaderboard.
--
-- Pose tracking and scoring happen entirely in the player's browser; video never leaves the device.
-- This worker only validates and stores the numbers the browser computed (client-authoritative, like
-- jacob.gg's leaderboard) and closes the cheap holes: server-issued player ids, the pose must be the
-- one scheduled for that day, no future days, internally consistent numbers, insert-only rows.

CREATE TABLE IF NOT EXISTS players (
  id         TEXT PRIMARY KEY,   -- server-generated UUID, never client-chosen
  token_hash TEXT NOT NULL,      -- SHA-256 of a server-issued session token
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS results (
  id             TEXT PRIMARY KEY,
  player_id      TEXT NOT NULL REFERENCES players (id),
  day_key        TEXT NOT NULL,                 -- the puzzle's UTC day, YYYY-MM-DD
  pose_id        TEXT NOT NULL,                 -- must equal the server's own schedule for day_key
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  display_name   TEXT NOT NULL,
  score          REAL NOT NULL CHECK (score >= 0 AND score <= 100),
  accuracy       REAL NOT NULL CHECK (accuracy >= 0 AND accuracy <= 100),   -- pose quality
  stability      REAL NOT NULL CHECK (stability >= 0 AND stability <= 100), -- stillness
  held           REAL NOT NULL CHECK (held >= 0 AND held <= 10),            -- seconds held (of 10)
  grid           TEXT NOT NULL,                 -- JSON: 4 rows x 5 cells (emoji grid source)
  submitted_at   TEXT NOT NULL,
  -- 0 = submitted on the puzzle's own UTC day (the real board); 1 = played later from the archive.
  -- The two are never ranked together.
  is_late        INTEGER NOT NULL DEFAULT 0
);

-- One row per (player, day, late-flag, attempt number); attempt numbers are assigned server-side.
CREATE UNIQUE INDEX IF NOT EXISTS results_player_day_attempt
  ON results (player_id, day_key, is_late, attempt_number);

CREATE INDEX IF NOT EXISTS results_board
  ON results (day_key, is_late, score DESC, submitted_at ASC);
