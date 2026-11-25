-- Large files: the browser sends each file in 1.5 MB parts, so uploads up to 100 MB work on the free plan.
CREATE TABLE IF NOT EXISTS uploads (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT,
  name        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  type        TEXT,
  parts       INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  thumb       BLOB,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uploads_status ON uploads(status, created_at);

-- The Etsy customer's own words, kept apart from the seller's notes.
ALTER TABLE orders ADD COLUMN customer_notes TEXT;

-- Comments pinned to a spot on the 3D model, with replies, open until resolved.
CREATE TABLE IF NOT EXISTS pins (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders(id),
  n           INTEGER NOT NULL,
  round       INTEGER NOT NULL,
  part        TEXT,
  pos         TEXT NOT NULL,
  body        TEXT NOT NULL,
  model_file  TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  created_by  TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL,
  resolved_by TEXT,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pins_order ON pins(order_id);
CREATE TABLE IF NOT EXISTS pin_replies (
  id          TEXT PRIMARY KEY,
  pin_id      TEXT NOT NULL REFERENCES pins(id),
  user_id     TEXT REFERENCES users(id),
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pin_replies_pin ON pin_replies(pin_id);
