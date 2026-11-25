-- Production control
ALTER TABLE orders ADD COLUMN handin_at TEXT;        -- team deadline, earlier than the client due time (room for QC)
ALTER TABLE orders ADD COLUMN ship_by TEXT;          -- the shop's own ship by date (Etsy), for the risk badge
ALTER TABLE orders ADD COLUMN group_id TEXT;         -- several models ordered together
ALTER TABLE orders ADD COLUMN item_no INTEGER;
ALTER TABLE orders ADD COLUMN item_count INTEGER;
ALTER TABLE orders ADD COLUMN wait_from TEXT;        -- status to return to after "waiting on client"
ALTER TABLE orders ADD COLUMN paused_at TEXT;        -- when the clock was paused
ALTER TABLE orders ADD COLUMN preview_seen_at TEXT;  -- when the client first opened the latest preview
ALTER TABLE orders ADD COLUMN client_msg_at TEXT;    -- last thing the client sent
ALTER TABLE orders ADD COLUMN team_seen_at TEXT;     -- when the team pressed "Got it"
ALTER TABLE files ADD COLUMN released INTEGER NOT NULL DEFAULT 1;  -- previews wait at 0 until QC passes them
ALTER TABLE files ADD COLUMN request_id TEXT;        -- photos attached to a revision request

-- Revision rounds: each change request, with numbered pins on the 3D model
CREATE TABLE IF NOT EXISTS requests (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders(id),
  round       INTEGER NOT NULL,
  body        TEXT NOT NULL,
  pins        TEXT NOT NULL DEFAULT '[]',
  model_file  TEXT,
  created_by  TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_order ON requests(order_id);

-- Build rules: per product type (handbook) and per shop
CREATE TABLE IF NOT EXISTS rules (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL CHECK (scope IN ('product','shop')),
  product     TEXT,
  shop_id     TEXT REFERENCES shops(id),
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  updated_by  TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rules_shop ON rules(shop_id);
CREATE INDEX IF NOT EXISTS idx_orders_group ON orders(group_id);
CREATE INDEX IF NOT EXISTS idx_files_request ON files(request_id);

-- existing open orders get a hand in time 6 hours before their due time
UPDATE orders SET handin_at = strftime('%Y-%m-%dT%H:%M:%fZ', due_at, '-6 hours') WHERE handin_at IS NULL;
