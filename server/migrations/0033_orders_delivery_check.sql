-- 0033: 为 orders.delivery_method 补 CHECK 约束（review L-0013）。0013 新增该列、0027 重建时均未补，
-- 与同表 status/payment_status 的 CHECK 惯例不一致。STRICT 表无法 ALTER 加约束，须重建表。
-- 列定义严格沿用 0027（当前 orders 形态，其后无列变更），仅给 delivery_method 加 CHECK。
PRAGMA foreign_keys = OFF;

CREATE TABLE orders_new (
  id                TEXT PRIMARY KEY,
  order_number      TEXT NOT NULL UNIQUE,
  access_token      TEXT NOT NULL UNIQUE,
  customer_id       TEXT NOT NULL REFERENCES users(id),
  contact_info      TEXT,
  is_internal       INTEGER NOT NULL DEFAULT 0,
  subtotal          INTEGER NOT NULL DEFAULT 0,
  discount          INTEGER NOT NULL DEFAULT 0,
  total             INTEGER NOT NULL DEFAULT 0,
  payment_status    TEXT NOT NULL DEFAULT 'unpaid'
                    CHECK (payment_status IN ('unpaid','deposit','paid')),
  paid_amount       INTEGER NOT NULL DEFAULT 0,
  payment_method    TEXT,
  paid_at           TEXT,
  status            TEXT NOT NULL DEFAULT 'quoted'
                    CHECK (status IN ('quoted','file_pending','file_approved','confirmed',
                                      'in_production','printed','ready','delivered','cancelled')),
  quote_valid_until TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  confirmed_at      TEXT,
  due_date          TEXT,
  completed_at      TEXT,
  notes             TEXT,
  guest_email       TEXT,
  guest_name        TEXT,
  guest_contact     TEXT,
  delivery_method   TEXT NOT NULL DEFAULT 'pickup'
                    CHECK (delivery_method IN ('pickup','shipping')),
  delivery_address  TEXT,
  membership_discount INTEGER NOT NULL DEFAULT 0,
  membership_tier_id  INTEGER REFERENCES membership_tiers(id)
) STRICT;

INSERT INTO orders_new SELECT * FROM orders;
DROP TABLE orders;
ALTER TABLE orders_new RENAME TO orders;

CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_customer_created ON orders(customer_id, created_at DESC);
CREATE INDEX idx_orders_number ON orders(order_number);

PRAGMA foreign_keys = ON;
PRAGMA foreign_key_check;
