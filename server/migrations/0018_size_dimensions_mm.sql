-- 0018: sizes 绝对 mm 尺寸（D36）。供 D35 文件预检做「文件尺寸 vs 下单尺寸 + 出血」匹配。
-- 回填标准尺寸（6寸=4R / A5 / A4 / A3 / SRA3）；A3+ 因机型而异（329×483 或 318×450…）留 NULL 由 admin 按实际机台填。
-- STRICT 表 ALTER ADD COLUMN：可空 INTEGER 默认 NULL；mm 为整数（ISO/照片尺寸本就整数 mm）。

ALTER TABLE sizes ADD COLUMN width_mm INTEGER;
ALTER TABLE sizes ADD COLUMN height_mm INTEGER;

UPDATE sizes SET width_mm = 152, height_mm = 102 WHERE key = '6';     -- 6寸 = 4R 152×102
UPDATE sizes SET width_mm = 148, height_mm = 210 WHERE key = 'A5';
UPDATE sizes SET width_mm = 210, height_mm = 297 WHERE key = 'A4';
UPDATE sizes SET width_mm = 297, height_mm = 420 WHERE key = 'A3';
UPDATE sizes SET width_mm = 320, height_mm = 450 WHERE key = 'SRA3';  -- ISO SRA3
-- A3P（A3+）留 NULL：admin 在 /admin/pricing 尺寸表单按实际机台填
