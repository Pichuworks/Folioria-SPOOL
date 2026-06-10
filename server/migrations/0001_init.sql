-- ============================================================
-- S.P.O.O.L. — folioria.db  ·  0001_init.sql
-- Source of truth: PRD v1.1 (C1–C9). Claude Code: 本文件为人审定稿，
-- 禁止擅自增删表/列；变更须新增 migration 并在 docs/decisions.md 留记录。
--
-- 约定（来自 PRD C7）：
--   · 金额一律 INTEGER 定点。单价层字段后缀 _c（最小货币单位×100），
--     金额层字段无后缀（最小货币单位）。禁止 REAL 存钱。
--   · 时间戳 TEXT，ISO-8601 UTC（'2026-06-10T12:00:00Z'）。
--   · UUID 业务记录（订单/作业/日志）TEXT 主键，由应用层 randomUUID() 生成；
--     定价/配置类表用 INTEGER 主键（与 seed.json 对齐，便于 admin CRUD）。
--   · 软删除统一 archived 列；物理 DELETE 仅限无引用的配置行。
--   · 运行时每连接执行: PRAGMA foreign_keys=ON; 库级一次性: journal_mode=WAL。
--   · 备份用 VACUUM INTO，禁止直接 cp（PRD E 节）。
-- ============================================================

-- ---------- 货币与系统配置 (C7) ----------

CREATE TABLE currencies (
  code            TEXT PRIMARY KEY,            -- 'JPY' | 'CNY' | 'USD' | ...
  symbol          TEXT NOT NULL,
  decimal_places  INTEGER NOT NULL             -- ISO 4217 exponent
) STRICT;

INSERT INTO currencies VALUES ('JPY','¥',0), ('CNY','￥',2), ('USD','$',2);

CREATE TABLE system_config (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),  -- 单行表
  base_currency           TEXT NOT NULL REFERENCES currencies(code),
  -- ⚠️ 产生业务数据后禁止变更 base_currency（应用层强制，换币种=新实例）
  min_margin_bp           INTEGER NOT NULL DEFAULT 6700,       -- 基点: 6700 = 67%
  unify_pricing           INTEGER NOT NULL DEFAULT 1,          -- bool
  force_min_margin        INTEGER NOT NULL DEFAULT 0,          -- bool：开启时手动价被抬至地板价
  overhead_dep_months     INTEGER NOT NULL DEFAULT 36,         -- 设备折旧月数
  overhead_month_volume   INTEGER NOT NULL DEFAULT 2000,       -- 月摊薄基准张数
  quote_valid_days        INTEGER NOT NULL DEFAULT 14,
  initialized_at          TEXT
) STRICT;

-- ---------- 用户 / 会话 (B1, E) ----------

CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash     TEXT NOT NULL,                      -- bcrypt
  name              TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'customer'
                    CHECK (role IN ('customer','member','admin')),
  -- customer/member = 下单域；member 由 admin 对已注册账号升格（B1 账号供给规则）
  -- admin = 管理域；不可自注册，初始 admin 由 spool init 创建
  contact_info      TEXT,                               -- LINE ID / 电话等
  email_verified_at TEXT,
  notify_channels   TEXT NOT NULL DEFAULT '["email"]',  -- JSON array
  notify_addresses  TEXT NOT NULL DEFAULT '{}',         -- JSON object
  archived          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
) STRICT;

-- 若 auth 定案为 JWT 方案则删除本表；定案 session 方案则保留（PRD 技术栈讨论 #2）
CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,                        -- sha256(token)，不存明文
  user_id      TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT
) STRICT;
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- ---------- 定价推导模型 (C9) ----------

CREATE TABLE sizes (
  key    TEXT PRIMARY KEY,                              -- 'A4' | '6' | 'SRA3'
  label  TEXT NOT NULL,
  area   REAL NOT NULL CHECK (area > 0),                -- 相对面积单位（非金额，REAL 允许）
  sort   INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE printers (
  id                          INTEGER PRIMARY KEY,
  code                        TEXT NOT NULL UNIQUE,     -- 'C850'
  name                        TEXT NOT NULL,
  type                        TEXT NOT NULL CHECK (type IN ('laser','inkjet')),
  location                    TEXT,
  status                      TEXT NOT NULL DEFAULT 'online'
                              CHECK (status IN ('online','standby','maintenance','offline')),
  total_pages                 INTEGER NOT NULL DEFAULT 0,
  equipment_cost_c            INTEGER NOT NULL DEFAULT 0,   -- 单价层（参与折旧摊薄除法）
  monthly_cost_c              INTEGER NOT NULL DEFAULT 0,
  last_calibration_at         TEXT,
  last_calibration_pages      INTEGER NOT NULL DEFAULT 0,   -- 上次校准时的计数器读数
  calibration_interval_pages  INTEGER,                      -- 双触发 (C6)：页数或天数
  calibration_interval_days   INTEGER,                      -- 先到为准；NULL = 该维度不触发
  archived                    INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE print_modes (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,                          -- 'C850 彩图·单'
  printer_id    INTEGER NOT NULL REFERENCES printers(id),
  ink_type      TEXT NOT NULL CHECK (ink_type IN ('toner','pigment','dye')),
  pricing_mode  TEXT NOT NULL CHECK (pricing_mode IN ('set','ml')),
  ink_price_c   INTEGER NOT NULL,                       -- _c/套 或 _c/ml
  ml_per_batch  INTEGER,                                -- pricing_mode='ml' 时必填（应用层校验）
  yield_sheets  INTEGER NOT NULL CHECK (yield_sheets > 0),
  ref_size      TEXT NOT NULL REFERENCES sizes(key),
  max_size      TEXT NOT NULL REFERENCES sizes(key),
  duplex        INTEGER NOT NULL DEFAULT 0,             -- ·双 模式；yield 已含减半
  color_tag     TEXT,
  archived      INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE papers (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  category   TEXT,                                      -- plain|coated|art_cotton|baryta|... 自由文本
  gsm        INTEGER,
  color_tag  TEXT,
  supplier   TEXT,
  notes      TEXT,
  archived   INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE paper_size_costs (
  paper_id      INTEGER NOT NULL REFERENCES papers(id),
  size_key      TEXT NOT NULL REFERENCES sizes(key),
  pack_price_c  INTEGER NOT NULL,
  pack_count    INTEGER NOT NULL CHECK (pack_count > 0),
  PRIMARY KEY (paper_id, size_key)
) STRICT;

CREATE TABLE combos (
  id        INTEGER PRIMARY KEY,
  mode_id   INTEGER NOT NULL REFERENCES print_modes(id),
  paper_id  INTEGER NOT NULL REFERENCES papers(id),
  archived  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (mode_id, paper_id)
) STRICT;

CREATE TABLE combo_prices (
  combo_id         INTEGER NOT NULL REFERENCES combos(id),
  size_key         TEXT NOT NULL REFERENCES sizes(key),
  sell_c           INTEGER,        -- 手动售价/张；NULL = 自动地板价 (C9 公式)
  internal_sell_c  INTEGER,        -- 内部价覆盖 (B1.1)；NULL = 同对外逻辑
  PRIMARY KEY (combo_id, size_key)
) STRICT;
-- 可选性规则 (C9): combo 存在 ∧ size.area ≤ mode.max_size.area
--                  ∧ paper_size_costs 行存在 —— 应用层在报价接口实施

-- ---------- 库存 (C1, C3) ----------

CREATE TABLE locations (
  id               TEXT PRIMARY KEY,                    -- '3F纸张柜·A区'
  sensor_id        TEXT,                                -- Phase 3 MQTT 绑定
  moisture_status  TEXT NOT NULL DEFAULT 'ok'
                   CHECK (moisture_status IN ('ok','warning','danger'))
) STRICT;

-- 纸张实物库存：按 纸 × 尺寸 持有（湿度状态由 location 推导，不在本表）
CREATE TABLE paper_stocks (
  id           TEXT PRIMARY KEY,
  paper_id     INTEGER NOT NULL REFERENCES papers(id),
  size_key     TEXT NOT NULL REFERENCES sizes(key),
  quantity     INTEGER NOT NULL DEFAULT 0,              -- 张（D1: 仅平张，整数）
  location_id  TEXT REFERENCES locations(id),
  opened       INTEGER NOT NULL DEFAULT 0,
  opened_at    TEXT,
  notes        TEXT,
  archived     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (paper_id, size_key, location_id)
) STRICT;

CREATE TABLE consumables (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  type                TEXT NOT NULL
                      CHECK (type IN ('toner','ink','printhead','fuser','drum','other')),
  printer_id          INTEGER NOT NULL REFERENCES printers(id),
  quantity            INTEGER NOT NULL DEFAULT 0,       -- 备品数
  installed_at        TEXT,                             -- 当前在役件装机时间
  cost_model          TEXT NOT NULL DEFAULT 'per_page'
                      CHECK (cost_model IN ('per_page','per_job_rule')),  -- C2
  rated_life_pages    INTEGER,                          -- per_page 模式必填（应用层校验）
  current_usage_pages INTEGER NOT NULL DEFAULT 0,
  unit_cost_c         INTEGER NOT NULL DEFAULT 0,
  supplier            TEXT,
  alert_threshold_bp  INTEGER NOT NULL DEFAULT 2000,    -- 2000 = 20.00% (C7)
  archived            INTEGER NOT NULL DEFAULT 0
) STRICT;
-- 换装流程 (C2): MaintenanceEvent(toner_change, final_usage=旧件读数)
--   → current_usage_pages 清零, installed_at 更新, quantity -1（应用层事务）

CREATE TABLE inventory_log (
  id                 TEXT PRIMARY KEY,
  target_type        TEXT NOT NULL CHECK (target_type IN ('paper_stock','consumable')),
  target_id          TEXT NOT NULL,
  action             TEXT NOT NULL
                     CHECK (action IN ('purchase','consume','adjust','scrap','return','convert')),
  quantity_delta     INTEGER NOT NULL,                  -- 负=出 正=入（张/件）
  convert_group      TEXT,                              -- C1: 裁切转换成对日志共享
  reason             TEXT,
  operator_id        TEXT REFERENCES users(id),
  related_job_id     TEXT,                              -- FK 见 jobs 建表后（SQLite 允许前向引用名）
  -- 采购原币留痕 (C7)，仅 action='purchase' 使用
  original_currency  TEXT REFERENCES currencies(code),
  original_amount    INTEGER,                           -- 原币最小单位整数
  converted_cost_c   INTEGER,                           -- 换算为基准货币单价层，录入时定格
  exchange_rate_note TEXT,                              -- 备注留痕，不参与运算
  created_at         TEXT NOT NULL
) STRICT;
CREATE INDEX idx_invlog_target  ON inventory_log(target_type, target_id);
CREATE INDEX idx_invlog_created ON inventory_log(created_at);
CREATE INDEX idx_invlog_convert ON inventory_log(convert_group) WHERE convert_group IS NOT NULL;

-- ---------- 设备维护 ----------

CREATE TABLE maintenance_events (
  id           TEXT PRIMARY KEY,
  printer_id   INTEGER NOT NULL REFERENCES printers(id),
  type         TEXT NOT NULL
               CHECK (type IN ('calibration','toner_change','nozzle_check','head_clean',
                               'fuser_replace','drum_replace','firmware_update',
                               'deep_clean','other')),
  occurred_at  TEXT NOT NULL,
  operator_id  TEXT REFERENCES users(id),
  notes        TEXT,
  next_due     TEXT,
  cost         INTEGER,                                 -- 金额层（外部维修支出）
  final_usage  INTEGER                                  -- C2: toner_change 时旧件读数
) STRICT;
CREATE INDEX idx_maint_printer ON maintenance_events(printer_id, occurred_at);

-- ---------- 订单 (C4) ----------

CREATE TABLE orders (
  id                TEXT PRIMARY KEY,
  order_number      TEXT NOT NULL UNIQUE,               -- 'FOL-2026-0001' 仅人类可读
  access_token      TEXT NOT NULL UNIQUE,               -- 随机，订单查询链接用（防枚举）
  customer_id       TEXT NOT NULL REFERENCES users(id),
  contact_info      TEXT,
  is_internal       INTEGER NOT NULL DEFAULT 0,         -- member 内部需求标记 (B1.1)
  subtotal          INTEGER NOT NULL DEFAULT 0,         -- 金额层
  discount          INTEGER NOT NULL DEFAULT 0,         -- 整数减额，禁百分比 (C7)
  total             INTEGER NOT NULL DEFAULT 0,
  payment_status    TEXT NOT NULL DEFAULT 'unpaid'
                    CHECK (payment_status IN ('unpaid','deposit','paid')),
  paid_amount       INTEGER NOT NULL DEFAULT 0,
  payment_method    TEXT,
  paid_at           TEXT,
  status            TEXT NOT NULL DEFAULT 'quoted'
                    CHECK (status IN ('quoted','file_pending','file_approved','confirmed',
                                      'in_production','ready','delivered','cancelled')),
  quote_valid_until TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  confirmed_at      TEXT,
  due_date          TEXT,
  completed_at      TEXT,
  notes             TEXT
) STRICT;
CREATE INDEX idx_orders_status   ON orders(status);
CREATE INDEX idx_orders_customer ON orders(customer_id);

CREATE TABLE order_items (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id),
  mode_id       INTEGER NOT NULL REFERENCES print_modes(id),
  paper_id      INTEGER NOT NULL REFERENCES papers(id),
  size_key      TEXT NOT NULL REFERENCES sizes(key),
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_c  INTEGER NOT NULL,                       -- 下单时定格快照（不实时引用定价表）
  line_total    INTEGER NOT NULL,                       -- 唯一舍入点产物 (C7)
  file_url      TEXT,
  file_status   TEXT NOT NULL DEFAULT 'pending'
                CHECK (file_status IN ('pending','approved','rejected')),
  file_note     TEXT,
  job_id        TEXT                                    -- 确认后生成，FK 至 jobs
) STRICT;
CREATE INDEX idx_items_order ON order_items(order_id);

-- ---------- 作业 (C3) ----------

CREATE TABLE jobs (
  id                 TEXT PRIMARY KEY,
  order_item_id      TEXT REFERENCES order_items(id),   -- NULL = 内部作业
  requester_id       TEXT NOT NULL REFERENCES users(id),
  title              TEXT NOT NULL,
  mode_id            INTEGER NOT NULL REFERENCES print_modes(id),
  paper_id           INTEGER NOT NULL REFERENCES papers(id),
  size_key           TEXT NOT NULL REFERENCES sizes(key),
  quantity           INTEGER NOT NULL CHECK (quantity > 0),   -- 计划输出张数
  waste_quantity     INTEGER NOT NULL DEFAULT 0,              -- 废品（done 时录入）
  pages_consumed     INTEGER,                                 -- 实耗面数（done 时落账）
  file_url           TEXT,
  -- 成本快照（done 时按 C9 推导定格；单价层）
  paper_cost_c       INTEGER,
  consumable_cost_c  INTEGER,
  overhead_cost_c    INTEGER,
  total_cost         INTEGER,                                 -- 金额层
  quoted_price       INTEGER,                                 -- NULL = 内部作业
  profit             INTEGER,
  status             TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','queued','printing','done','cancelled')),
  created_at         TEXT NOT NULL,
  started_at         TEXT,
  completed_at       TEXT,
  operator_id        TEXT REFERENCES users(id),
  notes              TEXT
) STRICT;
CREATE INDEX idx_jobs_status ON jobs(status);
-- 扣减规则 (C3): 仅 done 落账（quantity+waste → inventory_log consume/scrap，
--   在役 per_page 耗材 usage += 实耗面数，printer total_pages 同步）。
--   queued/printing 不动库存；可用量 = quantity − Σ(queued/printing 计划耗) 动态算。
--   全过程单事务（better-sqlite3 同步事务）。

-- ---------- 提醒 (C8) ----------

CREATE TABLE alerts (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL
                  CHECK (type IN ('low_stock','calibration_due','maintenance_due',
                                  'order_due','moisture_warning','consumable_low')),
  severity        TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  target_type     TEXT NOT NULL,
  target_id       TEXT NOT NULL,
  message         TEXT NOT NULL,
  acknowledged    INTEGER NOT NULL DEFAULT 0,
  acknowledged_by TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL,
  resolved_at     TEXT
) STRICT;
-- C8 去重在数据库层强制：未解决的同源同类提醒不可重复创建
CREATE UNIQUE INDEX uniq_alert_open
  ON alerts(target_type, target_id, type) WHERE resolved_at IS NULL;

-- ---------- 通知 (D 节) ----------

CREATE TABLE notification_log (
  id         TEXT PRIMARY KEY,
  event      TEXT NOT NULL,           -- 'order_confirmed' | 'order_ready' | ...
  channel    TEXT NOT NULL,           -- 'email' | 后续 adapter id
  recipient  TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('sent','failed','skipped')),
  error      TEXT,
  sent_at    TEXT NOT NULL
) STRICT;
