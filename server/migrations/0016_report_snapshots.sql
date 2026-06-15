-- 0016: 月度报表自动快照（D34）。一月一行，CLI/timer 重算时按 month 幂等 upsert。
-- 金额为基准货币最小单位整数（金额层）；payload 存完整月度报表 JSON 快照（含内外分列）。
CREATE TABLE report_snapshots (
  month         TEXT PRIMARY KEY,          -- 'YYYY-MM'
  ext_revenue   INTEGER NOT NULL,
  ext_cost      INTEGER NOT NULL,
  ext_profit    INTEGER NOT NULL,
  int_cost      INTEGER NOT NULL,
  jobs_done     INTEGER NOT NULL,
  pages         INTEGER NOT NULL,
  payload       TEXT NOT NULL,             -- 完整月度报表 JSON 快照
  generated_at  TEXT NOT NULL
) STRICT;
