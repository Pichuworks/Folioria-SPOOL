-- 0012: 管理域审计日志（Track B，D29）。单一 choke-point audit() 写入，覆盖
-- 定价 / 折扣 / 收款 / 角色归档 / 设置 等敏感变更，供审阅视图回看。append-only。

CREATE TABLE admin_audit (
  id           TEXT PRIMARY KEY,
  actor_id     TEXT REFERENCES users(id),       -- 操作者（NULL = 系统/未知）
  action       TEXT NOT NULL,                    -- 'payment.record' | 'order.discount' | 'user.update' | 'settings.update' | 'pricing.combo_price'
  target_type  TEXT NOT NULL,                    -- 'order' | 'user' | 'settings' | 'combo'
  target_id    TEXT,
  summary      TEXT NOT NULL,                    -- 人类可读摘要
  detail       TEXT,                             -- 可选 JSON（before/after 等）
  created_at   TEXT NOT NULL
) STRICT;
CREATE INDEX idx_admin_audit_created ON admin_audit(created_at);
CREATE INDEX idx_admin_audit_target  ON admin_audit(target_type, target_id);
