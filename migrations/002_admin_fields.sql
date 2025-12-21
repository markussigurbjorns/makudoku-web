PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS puzzles_new (
  date_utc TEXT PRIMARY KEY
    CHECK (
      date_utc GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    ),

  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'archived')),

  puzzle_json TEXT NOT NULL,

  svg TEXT,

  render_version INTEGER NOT NULL DEFAULT 1,

  title TEXT,
  author TEXT,
  difficulty INTEGER,
  variants TEXT,

  created_at_utc TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  updated_at_utc TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  published_at_utc TEXT,

  CHECK (status != 'published' OR svg IS NOT NULL)
);

INSERT INTO puzzles_new (
  date_utc,
  status,
  puzzle_json,
  svg,
  render_version,
  title,
  difficulty,
  variants,
  created_at_utc,
  updated_at_utc,
  published_at_utc,
  author
)
SELECT
  date_utc,
  status,
  puzzle_json,
  svg,
  render_version,
  title,
  difficulty,
  variants,
  created_at_utc,
  updated_at_utc,
  published_at_utc,
  NULL
FROM puzzles;

DROP TABLE puzzles;
ALTER TABLE puzzles_new RENAME TO puzzles;

CREATE INDEX IF NOT EXISTS idx_puzzles_status_date
  ON puzzles(status, date_utc);

CREATE INDEX IF NOT EXISTS idx_puzzles_published_at
  ON puzzles(published_at_utc);

CREATE TRIGGER IF NOT EXISTS trg_puzzles_updated_at
AFTER UPDATE ON puzzles
FOR EACH ROW
BEGIN
  UPDATE puzzles
  SET updated_at_utc = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE date_utc = OLD.date_utc;
END;

PRAGMA foreign_keys = ON;
