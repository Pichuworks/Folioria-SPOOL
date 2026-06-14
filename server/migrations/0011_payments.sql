-- 0011: 收款/退款流水账（Track B，D28）。append-only payments；orders.paid_amount/payment_status
-- 改为该账投影（不再覆盖式 PATCH）。金额层带符号：收款(deposit/balance)正、退款(refund)负。
-- 约束在应用层强制：0 ≤ Σamount ≤ total，且 kind 与符号一致。

CREATE TABLE payments (
  id           TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES orders(id),
  kind         TEXT NOT NULL CHECK (kind IN ('deposit','balance','refund')),
  amount       INTEGER NOT NULL,                 -- 金额层，带符号（收正/退负）
  method       TEXT,
  operator_id  TEXT REFERENCES users(id),
  note         TEXT,
  created_at   TEXT NOT NULL
) STRICT;
CREATE INDEX idx_payments_order ON payments(order_id, created_at);

-- 既有订单 paid_amount 留痕：投影一条迁移流水，使 Σpayments == paid_amount，账实相符。
INSERT INTO payments (id, order_id, kind, amount, method, note, created_at)
SELECT 'mig-0011-' || id, id,
       CASE WHEN paid_amount >= total THEN 'balance' ELSE 'deposit' END,
       paid_amount, payment_method, '0011 迁移前留痕',
       COALESCE(paid_at, created_at)
FROM orders WHERE paid_amount > 0;
