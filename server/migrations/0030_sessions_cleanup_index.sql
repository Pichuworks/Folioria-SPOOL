-- Sessions cleanup index: speeds up hourly DELETE by expires_at
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
