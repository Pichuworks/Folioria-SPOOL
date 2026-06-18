-- 0031: 清理冗余索引。idx_jobs_status(status) 被 idx_jobs_status_created(status, created_at DESC)
-- 左前缀完全覆盖（0020 加复合索引时未删旧单列索引），仅增加 jobs 写放大、无查询收益。
DROP INDEX IF EXISTS idx_jobs_status;
