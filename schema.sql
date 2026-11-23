-- CubiX production platform schema (Cloudflare D1 / SQLite)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS shops (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  url         TEXT,
  plan        TEXT NOT NULL DEFAULT 'pay_per_model',   -- pay_per_model | starter | growth | studio
  free_used   INTEGER NOT NULL DEFAULT 0,
  notes       TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('client','modeler','admin')),
  shop_id       TEXT REFERENCES shops(id),
  password_hash TEXT,
  password_salt TEXT,
  capacity      INTEGER NOT NULL DEFAULT 4,               -- open orders a modeler can carry
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (                       -- password setup and reset links
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  purpose     TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS login_attempts (
  email       TEXT NOT NULL,
  at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  shop_id      TEXT NOT NULL REFERENCES shops(id),
  created_by   TEXT REFERENCES users(id),
  title        TEXT NOT NULL,
  product      TEXT,
  size         TEXT,
  printer      TEXT,
  formats      TEXT,
  notes        TEXT,
  channel      TEXT,
  status       TEXT NOT NULL DEFAULT 'new',
  priority     TEXT NOT NULL DEFAULT 'normal',          -- normal | rush
  is_free      INTEGER NOT NULL DEFAULT 0,
  price        REAL,
  paid         INTEGER NOT NULL DEFAULT 0,
  paid_via     TEXT,
  assignee_id  TEXT REFERENCES users(id),
  due_at       TEXT NOT NULL,
  revisions    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  delivered_at TEXT,
  approved_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_shop ON orders(shop_id);
CREATE INDEX IF NOT EXISTS idx_orders_assignee ON orders(assignee_id);
CREATE INDEX IF NOT EXISTS idx_orders_due ON orders(due_at);

CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders(id),
  kind        TEXT NOT NULL CHECK (kind IN ('reference','preview','final')),
  version     INTEGER NOT NULL DEFAULT 1,
  r2_key      TEXT NOT NULL,
  name        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  type        TEXT,
  uploaded_by TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_order ON files(order_id);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders(id),
  user_id     TEXT REFERENCES users(id),
  body        TEXT NOT NULL,
  internal    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_order ON messages(order_id);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    TEXT NOT NULL REFERENCES orders(id),
  user_id     TEXT REFERENCES users(id),
  type        TEXT NOT NULL,
  detail      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_order ON events(order_id);

-- File contents when R2 is not enabled: each file is split into chunks under D1's 2 MB row limit.
CREATE TABLE IF NOT EXISTS file_chunks (
  file_id     TEXT NOT NULL,
  idx         INTEGER NOT NULL,
  data        BLOB NOT NULL,
  PRIMARY KEY (file_id, idx)
);
