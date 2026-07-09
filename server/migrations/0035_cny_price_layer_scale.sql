-- 0035: CNY 单价层补正。
-- 0019 已把运行实例切到 CNY，但当时配置价仍按“RMB×100”录入；
-- 系统 _c 语义是“最小货币单位×100”，CNY 下即“分×100 = RMB×10000”。
-- 这里只补配置/价格事实源，不改订单/作业/报表等历史金额快照。

UPDATE printers
SET equipment_cost_c = equipment_cost_c * 100,
    monthly_cost_c = monthly_cost_c * 100
WHERE EXISTS (SELECT 1 FROM system_config WHERE id = 1 AND base_currency = 'CNY');

UPDATE print_modes
SET ink_price_c = ink_price_c * 100
WHERE EXISTS (SELECT 1 FROM system_config WHERE id = 1 AND base_currency = 'CNY');

UPDATE paper_size_costs
SET pack_price_c = pack_price_c * 100
WHERE EXISTS (SELECT 1 FROM system_config WHERE id = 1 AND base_currency = 'CNY');

UPDATE combo_prices
SET sell_c = CASE WHEN sell_c IS NULL THEN NULL ELSE sell_c * 100 END,
    internal_sell_c = CASE WHEN internal_sell_c IS NULL THEN NULL ELSE internal_sell_c * 100 END
WHERE EXISTS (SELECT 1 FROM system_config WHERE id = 1 AND base_currency = 'CNY');

UPDATE combo_price_tiers
SET sell_c = sell_c * 100,
    internal_sell_c = CASE WHEN internal_sell_c IS NULL THEN NULL ELSE internal_sell_c * 100 END
WHERE EXISTS (SELECT 1 FROM system_config WHERE id = 1 AND base_currency = 'CNY');

UPDATE consumables
SET unit_cost_c = unit_cost_c * 100
WHERE EXISTS (SELECT 1 FROM system_config WHERE id = 1 AND base_currency = 'CNY');

UPDATE finishing_ops
SET price_c = price_c * 100
WHERE EXISTS (SELECT 1 FROM system_config WHERE id = 1 AND base_currency = 'CNY');
