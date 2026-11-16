-- Snapshots table for the crypto revenue dashboard — identical schema
-- to the Muse artifact's SQLite table (drizzle/0002): one row per
-- refresh, payload is the full dashboard JSON (v7), pruned to the
-- newest 60 rows by the Worker after every write.
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fetched_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);
