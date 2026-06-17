-- completed_at 范围查询用（月度报表、Dashboard、趋势）
CREATE INDEX IF NOT EXISTS idx_jobs_completed ON jobs(completed_at) WHERE status = 'done';

-- inventory_log created_at 范围查询用（纸张消耗报表）
CREATE INDEX IF NOT EXISTS idx_invlog_created_range ON inventory_log(target_type, created_at);
