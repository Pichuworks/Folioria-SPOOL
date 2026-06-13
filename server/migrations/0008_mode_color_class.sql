-- 0008: 单页属性配置器的结构化「色彩档」（D25）。print_modes 增 color_class（可空），
-- 由 admin 在 /admin/pricing 后台理算（黑白/彩色/图质…，档位由 K 君定）。
-- 本迁移纯加列、不回填、不动 storefront / seed / acceptance —— 客户端切换与 §2.5
-- 客户可见基线搬家须另行人审签字（见 docs/design-product-layer.md）。
ALTER TABLE print_modes ADD COLUMN color_class TEXT;
