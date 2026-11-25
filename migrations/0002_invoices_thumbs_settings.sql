-- Small preview images stored next to each uploaded image (fast thumbnails).
ALTER TABLE files ADD COLUMN thumb BLOB;

-- Business details used on invoices, editable by admins.
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT
);

CREATE TABLE IF NOT EXISTS invoices (
  id            TEXT PRIMARY KEY,
  number        TEXT NOT NULL UNIQUE,
  token         TEXT NOT NULL UNIQUE,
  shop_id       TEXT NOT NULL REFERENCES shops(id),
  order_id      TEXT REFERENCES orders(id),
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','paid','void')),
  bill_name     TEXT NOT NULL,
  bill_email    TEXT,
  bill_extra    TEXT,
  project_title TEXT,
  project_ref   TEXT,
  items         TEXT NOT NULL DEFAULT '[]',
  currency      TEXT NOT NULL DEFAULT 'USD',
  tax_rate      REAL NOT NULL DEFAULT 0,
  subtotal      REAL NOT NULL DEFAULT 0,
  tax           REAL NOT NULL DEFAULT 0,
  total         REAL NOT NULL DEFAULT 0,
  terms         TEXT,
  payment_note  TEXT,
  notes         TEXT,
  issued_at     TEXT NOT NULL,
  sent_at       TEXT,
  paid_at       TEXT,
  paid_via      TEXT,
  created_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_shop ON invoices(shop_id);
CREATE INDEX IF NOT EXISTS idx_invoices_order ON invoices(order_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_users_shop ON users(shop_id);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(email, at);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
