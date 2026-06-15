-- 性能索引：常用查询路径加速

-- 订单按客户+时间查（admin 订单列表、CRM 钻取）
CREATE INDEX IF NOT EXISTS idx_orders_customer_created ON orders(customer_id, created_at DESC);

-- 作业按状态+时间查
CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at DESC);

-- 订单号 LIKE 前缀匹配
CREATE INDEX IF NOT EXISTS idx_orders_number ON orders(order_number);

-- 书组件按 job_id 查（jobs 列表 LEFT JOIN）
CREATE INDEX IF NOT EXISTS idx_obc_job ON order_book_components(job_id) WHERE job_id IS NOT NULL;
