-- 0009: 既有实例回填 color_class（③⑤,K 君映射,按模式名）。
-- 新装实例在 migrate 时 print_modes 尚空,此处 no-op,改由 seed.ts classifyColorClass 赋值(逻辑一致)。
-- 文档=黑白彩色皆可;照片分三品质档(性价比 L15168 / 高质量 G580 / 艺术微喷 P708)。
UPDATE print_modes SET color_class = 'bw,color'      WHERE color_class IS NULL AND name LIKE '%文档%';
UPDATE print_modes SET color_class = 'bw'            WHERE color_class IS NULL AND name LIKE '%黑白%';
UPDATE print_modes SET color_class = 'photo-value'   WHERE color_class IS NULL AND name LIKE '%照片%';
UPDATE print_modes SET color_class = 'photo-premium' WHERE color_class IS NULL AND name LIKE '%G580%';
UPDATE print_modes SET color_class = 'photo-art'     WHERE color_class IS NULL AND name LIKE '%P708%';
UPDATE print_modes SET color_class = 'color'         WHERE color_class IS NULL;
