// SQLite storage using Node's built-in driver (Node 22+), so there is nothing native to compile.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'tapsplit.db'));

db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS bills (
    id          TEXT PRIMARY KEY,
    admin_token TEXT NOT NULL,
    title       TEXT NOT NULL,
    upi_id      TEXT,
    tax         INTEGER NOT NULL DEFAULT 0,
    tip         INTEGER NOT NULL DEFAULT 0,
    discount    INTEGER NOT NULL DEFAULT 0,
    payer_id    INTEGER,
    locked      INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS items (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    name    TEXT NOT NULL,
    price   INTEGER NOT NULL,
    qty     INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS people (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    name    TEXT NOT NULL,
    color   TEXT NOT NULL,
    UNIQUE (bill_id, name)
  );

  CREATE TABLE IF NOT EXISTS claims (
    item_id   INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    PRIMARY KEY (item_id, person_id)
  );
`);

module.exports = db;
