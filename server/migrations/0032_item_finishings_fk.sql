-- 0032: 为 order_item_finishings.finishing_id 补外键 REFERENCES finishing_ops(id)。
-- 0021 自述"镜像 order_book_finishings 结构"却漏了该 FK；STRICT 表无法 ALTER 加约束，须重建表。
PRAGMA foreign_keys = OFF;

CREATE TABLE order_item_finishings_new (
  id              TEXT PRIMARY KEY,
  order_item_id   TEXT NOT NULL REFERENCES order_items(id),
  finishing_id    INTEGER NOT NULL REFERENCES finishing_ops(id),
  name            TEXT NOT NULL,
  pricing         TEXT NOT NULL,
  price_c         INTEGER NOT NULL,
  contribution_c  INTEGER NOT NULL
) STRICT;

INSERT INTO order_item_finishings_new SELECT * FROM order_item_finishings;
DROP TABLE order_item_finishings;
ALTER TABLE order_item_finishings_new RENAME TO order_item_finishings;
CREATE INDEX idx_oif_order_item ON order_item_finishings(order_item_id);

PRAGMA foreign_keys = ON;
PRAGMA foreign_key_check;
