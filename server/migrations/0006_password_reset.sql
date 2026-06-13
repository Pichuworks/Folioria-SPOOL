-- 0006: 忘记密码（D19）。独立于 email_verification_tokens（两类 token 信任级别不同，不复用）。
-- 仅存 sha256 哈希；一次性消费；TTL。重置成功撤销该用户全部会话。
CREATE TABLE password_reset_tokens (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  expires_at   TEXT NOT NULL,
  consumed_at  TEXT
) STRICT;
CREATE INDEX idx_prt_user ON password_reset_tokens(user_id);
