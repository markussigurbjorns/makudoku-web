# makudoku-web

export DATABASE_URL="sqlite:$(pwd)/data/makudoku.db"

## Admin API

All admin endpoints are under `/api/admin` and are intended to be protected by your reverse proxy.

### Generate a puzzle

```
POST /api/admin/puzzles/generate
```

Response includes `puzzle_json`, `svg`, and `variants`.

### Generate a puzzle with custom constraints

```
POST /api/admin/puzzles/generate/custom
```

Body example:

```json
{
  "constraints": [
    { "type": "kropki_white", "a": [0, 0], "b": [0, 1] },
    { "type": "thermo", "path": [[3, 3], [4, 3], [5, 3]] }
  ],
  "clue_target": 30,
  "seed": 12345
}
```

### Create or overwrite a puzzle

```
POST /api/admin/puzzles
```

Body example:

```json
{
  "date_utc": "2025-01-15",
  "puzzle_json": "{...}",
  "svg": "<svg>...</svg>",
  "name": "Daily Variant #1",
  "author": "Makudoku",
  "status": "draft",
  "difficulty": 3,
  "overwrite": true
}
```

If `svg` is omitted, the server will attempt to render it from `puzzle_json` using known constraints.

### List puzzles

```
GET /api/admin/puzzles
GET /api/admin/puzzles?status=published
```

### Fetch a puzzle

```
GET /api/admin/puzzles/{date_utc}
```

### Publish or archive

```
POST /api/admin/puzzles/{date_utc}/publish
POST /api/admin/puzzles/{date_utc}/archive
```
