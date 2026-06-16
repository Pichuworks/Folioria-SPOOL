-- 0022: 阶梯定价。每个 combo×size 可配多档数量折扣。

CREATE TABLE combo_price_tiers (
  combo_id        INTEGER NOT NULL REFERENCES combos(id),
  size_key        TEXT NOT NULL REFERENCES sizes(key),
  min_qty         INTEGER NOT NULL CHECK (min_qty > 1),
  sell_c          INTEGER NOT NULL CHECK (sell_c > 0),
  internal_sell_c INTEGER,
  PRIMARY KEY (combo_id, size_key, min_qty)
) STRICT;
