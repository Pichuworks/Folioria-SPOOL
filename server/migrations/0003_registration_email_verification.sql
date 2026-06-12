-- D12（prd.md 附录 A）: 下单域开放注册 + 邮箱验证（R4 / PRD D10）。
-- 验证 token 仅存 sha256 哈希（同 sessions）；registration_open / invite_code 为注册开关
-- （invite_code NULL = 邀请码关闭，默认关）。

CREATE TABLE email_verification_tokens (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  expires_at   TEXT NOT NULL,
  consumed_at  TEXT
) STRICT;
CREATE INDEX idx_evt_user ON email_verification_tokens(user_id);

ALTER TABLE system_config ADD COLUMN registration_open INTEGER NOT NULL DEFAULT 1;
ALTER TABLE system_config ADD COLUMN invite_code TEXT;
