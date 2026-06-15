-- 0017: 文件自动预检（D35）。order_items 与 order_book_components 增 file_precheck TEXT（JSON 快照），
-- 上传后 best-effort 跑（DPI/色彩空间/页数/加密/可解析），advisory 不阻断人工审稿；重传重置（随 file_status）。
-- STRICT 表 ALTER ADD COLUMN：可空 TEXT 默认 NULL，既有行回填 NULL。

ALTER TABLE order_items ADD COLUMN file_precheck TEXT;
ALTER TABLE order_book_components ADD COLUMN file_precheck TEXT;
