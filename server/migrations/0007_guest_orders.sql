-- 0007: 免登录（访客）下单（D23）。orders 挂访客联系字段；customer_id 仍 NOT NULL，
-- 访客单指向合成哨兵用户（archived=1，永不解析会话/登录），避开 NOT-NULL→NULL 整表重建。
-- guest_orders_open 默认 0（显式 opt-in）。
ALTER TABLE orders ADD COLUMN guest_email TEXT;
ALTER TABLE orders ADD COLUMN guest_name TEXT;
ALTER TABLE orders ADD COLUMN guest_contact TEXT;
ALTER TABLE system_config ADD COLUMN guest_orders_open INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO users (id, email, password_hash, name, role, archived, created_at)
VALUES ('guest', 'guest@local.invalid', 'x', 'Guest', 'customer', 1, '2026-01-01T00:00:00Z');
