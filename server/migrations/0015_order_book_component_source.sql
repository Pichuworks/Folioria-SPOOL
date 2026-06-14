-- 0015: 书行再下单（D32，Track B 收尾）。order_book_components 增 source_component_id 引用
-- book_components.id（下单时定格的目录组件来源），供 C1 reorder 按目录组件 id 还原各组件每本张数。
-- 成品/组件已归档则 reorder 跳过并提示（前台对照实时目录判定）。
-- STRICT 表 ALTER ADD COLUMN + REFERENCES：列可空、默认 NULL（SQLite 要求 FK 列默认 NULL），既有行回填 NULL。

ALTER TABLE order_book_components ADD COLUMN source_component_id INTEGER REFERENCES book_components(id);
