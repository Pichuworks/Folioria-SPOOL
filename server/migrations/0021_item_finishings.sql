-- 0021: 单页工艺支持。order_items 可附带工艺，镜像 order_book_finishings 结构。

CREATE TABLE order_item_finishings (
  id              TEXT PRIMARY KEY,
  order_item_id   TEXT NOT NULL REFERENCES order_items(id),
  finishing_id    INTEGER NOT NULL,
  name            TEXT NOT NULL,
  pricing         TEXT NOT NULL,
  price_c         INTEGER NOT NULL,
  contribution_c  INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_oif_order_item ON order_item_finishings(order_item_id);
