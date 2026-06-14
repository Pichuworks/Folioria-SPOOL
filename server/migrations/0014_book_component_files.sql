-- 0014: 书组件文件上传/审稿（D31，Track B 收尾）。order_book_components 增 file_url/file_status/file_note，
-- 与 order_items 同口径（pending/approved/rejected）。含书行订单 confirm 须「全部书组件有文件且 approved」，
-- 纯书单不再无文件门（与单页 item 同口径）。additive：combos/§2.5 stored 基线（187/43）不动。
-- STRICT 表 ALTER ADD COLUMN：NOT NULL 列须带非空默认（既有行回填 'pending'）。

ALTER TABLE order_book_components ADD COLUMN file_url TEXT;
ALTER TABLE order_book_components ADD COLUMN file_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (file_status IN ('pending', 'approved', 'rejected'));
ALTER TABLE order_book_components ADD COLUMN file_note TEXT;
