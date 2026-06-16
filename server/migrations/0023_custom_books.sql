-- 0023: 自定义书册（去成品化）。finishing_ops 增 category 列；order_books.book_id 改可空。
-- additive：combos / combo_prices / §2.5 stored 基线（187/43）一行不动。
-- 既有 book_products / book_components / book_finishings 保留（历史订单引用），
-- 新订单书行 book_id 可为 NULL（自定义配置，无预定义成品）。

-- ① finishing_ops 增 category TEXT（binding / cover / structural / NULL）
ALTER TABLE finishing_ops ADD COLUMN category TEXT;

-- ② 重建 order_books：book_id 由 NOT NULL 改可空
PRAGMA foreign_keys = OFF;

CREATE TABLE order_books_new (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id),
  book_id       INTEGER REFERENCES book_products(id),  -- nullable for custom books
  name          TEXT NOT NULL,
  count         INTEGER NOT NULL CHECK (count > 0),
  unit_price_c  INTEGER NOT NULL,
  line_total    INTEGER NOT NULL
) STRICT;

INSERT INTO order_books_new SELECT * FROM order_books;
DROP TABLE order_books;
ALTER TABLE order_books_new RENAME TO order_books;
CREATE INDEX idx_order_books_order ON order_books(order_id);

PRAGMA foreign_keys = ON;
PRAGMA foreign_key_check;

-- ③ 种子：默认装订方式与工艺（admin 后续调价）
INSERT INTO finishing_ops (name, pricing, price_c, category) VALUES
  ('骑马钉',     'per_book', 200,  'binding'),
  ('无线胶装',   'per_book', 500,  'binding'),
  ('精装',       'per_book', 2000, 'binding'),
  ('覆膜·哑光', 'per_page', 10,   'cover'),
  ('覆膜·亮光', 'per_page', 10,   'cover'),
  ('勒口',       'per_book', 300,  'structural'),
  ('扉页',       'per_book', 200,  'structural'),
  ('护封',       'per_book', 500,  'structural');
