PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS puzzle_stats (
  date_utc TEXT PRIMARY KEY
    CHECK (
      date_utc GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    ),

  views INTEGER NOT NULL DEFAULT 0,
  checks INTEGER NOT NULL DEFAULT 0,
  solves INTEGER NOT NULL DEFAULT 0,
  last_seen_utc TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
