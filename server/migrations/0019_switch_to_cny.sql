-- 0019: 切换基准货币 JPY → CNY（一次性运维迁移）。
-- 清除所有 JPY 计价的业务数据，保留用户/设备/定价配置。
-- ⚠️ 定价表（combo_prices / paper_size_costs 等）数值含义随币种变化，
--    需在管理界面按 CNY 口径重新录入。

-- 按 FK 依赖倒序清除业务流水
DELETE FROM payments;
DELETE FROM order_book_finishings;
DELETE FROM order_book_components;
DELETE FROM order_books;
DELETE FROM inventory_log;
DELETE FROM jobs;
DELETE FROM order_items;
DELETE FROM orders;
DELETE FROM alerts;
DELETE FROM notification_log;
DELETE FROM admin_audit;
DELETE FROM report_snapshots;
DELETE FROM maintenance_events;

-- 切换基准货币
UPDATE system_config SET base_currency = 'CNY' WHERE id = 1;
