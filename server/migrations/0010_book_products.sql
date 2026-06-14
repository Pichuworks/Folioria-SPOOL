-- 0010: 书/册子组合产品（D27，Track A 头牌）。一本书 = 多张单页组件 + 工艺。
-- additive：combos / combo_prices / §2.5 stored 基线（187/43）一行不动，本层为叠加产品层。
-- 金额：单价层 _c（unit_sell_c / unit_price_c / price_c / contribution_c），金额层 line_total。
-- 定价/配置类用 INTEGER 主键（admin CRUD），订单侧业务记录用 TEXT 主键（randomUUID）。

-- ---------- 成品定义（admin 维护） ----------

CREATE TABLE book_products (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  archived  INTEGER NOT NULL DEFAULT 0
) STRICT;

-- 组件 = 一道单页规格。封面固定 1 张/本；内页必填、插图选填——每本张数客户下单时填，不写死。
CREATE TABLE book_components (
  id           INTEGER PRIMARY KEY,
  book_id      INTEGER NOT NULL REFERENCES book_products(id),
  role         TEXT NOT NULL CHECK (role IN ('cover','inner','insert')),
  paper_id     INTEGER NOT NULL REFERENCES papers(id),
  size_key     TEXT NOT NULL REFERENCES sizes(key),
  color_class  TEXT NOT NULL,                       -- 'bw' | 'color' | 'photo-*'（同 print_modes.color_class 单值）
  duplex       INTEGER NOT NULL DEFAULT 0,
  sort         INTEGER NOT NULL DEFAULT 0,
  archived     INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX idx_book_components_book ON book_components(book_id);

-- 工艺（装订/烫金/压纹/覆膜…）自带计价口径
CREATE TABLE finishing_ops (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  pricing   TEXT NOT NULL CHECK (pricing IN ('per_book','per_page','per_area')),
  price_c   INTEGER NOT NULL,                        -- _c/本 | _c/页 | _c/面积单位
  archived  INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE book_finishings (
  book_id       INTEGER NOT NULL REFERENCES book_products(id),
  finishing_id  INTEGER NOT NULL REFERENCES finishing_ops(id),
  PRIMARY KEY (book_id, finishing_id)
) STRICT;

-- ---------- 订单侧（下单定格快照） ----------

-- 一本书 = 购物车一行。unit_price_c = 每本定格快照；line_total = 唯一舍入点产物。
CREATE TABLE order_books (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id),
  book_id       INTEGER NOT NULL REFERENCES book_products(id),
  name          TEXT NOT NULL,                       -- 成品名快照
  count         INTEGER NOT NULL CHECK (count > 0),  -- 本数
  unit_price_c  INTEGER NOT NULL,                    -- 每本售价定格（含组件 + 工艺）
  line_total    INTEGER NOT NULL                     -- lineTotal(unit_price_c, count)
) STRICT;
CREATE INDEX idx_order_books_order ON order_books(order_id);

CREATE TABLE order_book_components (
  id              TEXT PRIMARY KEY,
  order_book_id   TEXT NOT NULL REFERENCES order_books(id),
  role            TEXT NOT NULL,
  paper_id        INTEGER NOT NULL REFERENCES papers(id),
  size_key        TEXT NOT NULL REFERENCES sizes(key),
  color_class     TEXT NOT NULL,
  duplex          INTEGER NOT NULL DEFAULT 0,
  mode_id         INTEGER NOT NULL REFERENCES print_modes(id),  -- 解析的最便宜模式（机器对客户不可见，confirm 建 Job 用）
  sheets_per_book INTEGER NOT NULL CHECK (sheets_per_book > 0), -- 封面=1，内页/插图客户填
  unit_sell_c     INTEGER NOT NULL,                  -- 单页售价快照
  job_id          TEXT REFERENCES jobs(id)           -- confirm 后回填
) STRICT;
CREATE INDEX idx_obc_order_book ON order_book_components(order_book_id);

-- 工艺记录（快照 + 生产留痕）
CREATE TABLE order_book_finishings (
  id              TEXT PRIMARY KEY,
  order_book_id   TEXT NOT NULL REFERENCES order_books(id),
  finishing_id    INTEGER NOT NULL REFERENCES finishing_ops(id),
  name            TEXT NOT NULL,
  pricing         TEXT NOT NULL,
  price_c         INTEGER NOT NULL,
  contribution_c  INTEGER NOT NULL                   -- 每本贡献定格（已并入 order_books.unit_price_c）
) STRICT;
CREATE INDEX idx_obf_order_book ON order_book_finishings(order_book_id);
