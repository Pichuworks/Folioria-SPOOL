# 性能优化全量改造 — Startup Prompt

> 本文件是一份给 Claude Code 的完整任务上下文。在新会话中粘贴本提示即可启动。
> 基线：2026-06-15 性能审查报告，共 28 项发现。

---

## Goal

对 folioria-spool 代码库进行性能全量改造。按下面的优先级分批实施，
每批改完跑 `npm run typecheck && npm test`，通过后 commit + push。

严格遵守 CLAUDE.md 约束：金额三铁律、schema 不改表（需要加索引则走新 migration）、
不做任务外重构。所有 SQL 性能改动必须保持现有测试通过——测试是验收真值。

---

## 第一批：Critical（阻塞性 / 高频热路径）

### P1. bcrypt 异步化 — 解除事件循环阻塞

`bcrypt.hashSync` / `compareSync` cost=12 约 200-400ms 阻塞事件循环。

涉及文件 & 行号：
- `server/src/auth.ts:99` — `compareSync` → `bcrypt.compare()`（verifyLogin 改 async）
- `server/src/auth.ts:135` — `hashSync` → `bcrypt.hash()`（resetPassword 改 async）
- `server/src/auth.ts:159-160` — 同上（changePassword 改 async）
- `server/src/app.ts:305` — 注册路由内 `hashSync` → `await bcrypt.hash()`
- `server/src/app.ts:648` — admin 创建用户同上
- `server/src/init.ts:25` — `hashSync`（init 是一次性的、可保留 sync；也可改 async，你选）

注意：`verifyLogin` 目前是同步函数被 async 路由直接调用。改 async 后上层调用处都要 await。
`changePassword`、`resetPassword` 内部有 `db.transaction()` —— bcrypt 在事务外，先 await hash 再进事务。

### P2. listQuotable / listProducts / quote — N+1 查询风暴消除

当前 `listQuotable()` (pricing.ts:177-198)：
1. 一条 SQL 查出 ~187 个可选组合行
2. 逐行调 `quote()` → 每次含 3 条 SQL（combo_prices + deriveUnitCost + getConfig）
3. = ~561 次 SQL

`listProducts()` (pricing.ts:215-259) 更糟：逐行调 `quote()`，又是同一规模。

**修复策略**：

a) `getConfig()` 缓存：在 `pricing.ts` 模块顶层加 `let configCache: PricingConfig | null = null`，
   `getConfig()` 读一次后缓存，提供 `invalidateConfigCache()` 给 settings 修改时清除。
   → 消除 187 次 getConfig 查询。

b) `listQuotable()` 重写为单条 SQL 或至多 2 条 SQL：
   把 `deriveUnitCost` 的 JOIN（print_modes + sizes×3 + paper_size_costs）
   和 `combo_prices` 的 LEFT JOIN 全部合入 listQuotable 的主查询。
   在 JS 侧 map 行数据做 divRoundHalfUp / ceilDiv / flag 推导。
   保持 `quote()` 单条调用版本不动（单次报价不需要优化），只改 list 版本。

c) `listProducts()` 同理：在合并后的 listQuotable 数据上做 category 折叠，不再逐行调 quote。

**关键约束**：公式逻辑（divRoundHalfUp / ceilDiv / auto_sell_c / flag）必须与 pricing.test.ts
  和 acceptance.md §2 全部用例完全一致。跑完测试后核对 §2.5 基线：187 可报价 / 43 手动价。

### P3. 订单列表 N+1 — orderDto 批量化

当前 `GET /api/orders` (orders-routes.ts:622)：
```
rows.map(o => orderDto(db, o, currency, { admin, includeToken: true }))
```
orderDto 内部逐单查 getOrderItems + getOrderBooks（+ admin: users + getPayments）。
500 单 × 4-6 查询 = 2000-3000 SQL。

**修复策略**：
- 提取所有 order id，批量查 items / books / payments / users，结果按 order_id 分组为 Map
- orderDto 改为接收预查数据（或新写 `batchOrderDtos(db, rows, currency, opts)` 函数）
- `getOrderBooks` 内部逐 book 查 components/finishings → 改为一次性 WHERE order_book_id IN (...)

### P4. Vite 构建优化

`web/vite.config.ts` 添加：

```ts
build: {
  rollupOptions: {
    output: {
      manualChunks: {
        'react-vendor': ['react', 'react-dom'],
        'recharts': ['recharts'],
      },
    },
  },
},
```

---

## 第二批：High（显著影响用户体验的热路径）

### P5. 告警扫描批量化

`POST /api/alerts/scan` (alerts-routes.ts:70-110):
- 库存扫描：全量 load 后 JS 过滤 → 改 SQL `WHERE ps.quantity <= ?`
- 把整个扫描过程包在 `db.transaction()` 里（批量 INSERT 共享一个事务）
- 耗材检查 `checkConsumableThreshold` 逐条查 → 批量查出全部 per_page 耗材，JS 侧判断阈值，一次性 raiseAlert
- 校准检查 `checkCalibration` 逐台查 → 批量查 printers + 校准数据，JS 侧判断，批量 raiseAlert

### P6. recommendMachines N+1 消除

`jobs.ts:92-145`：逐 mode 查 3 次（deriveUnitCost + overheadC + queue）。
→ 预查：
- 一条 SQL JOIN 全部 mode 的成本数据（同 P2 策略）
- 一条 SQL 汇总各 printer 的 queue_pages
- overheadC 数据从 printers 表批量查
- JS 侧 map 组装

### P7. 月度趋势 6 次查询 → 1 条 SQL

`reports-routes.ts:272-293`：循环 6 个月各调 `monthlyReport()`。
→ 写一条 SQL：
```sql
SELECT substr(j.completed_at, 1, 7) AS month, COUNT(*) AS jobs_done, ...
FROM jobs j LEFT JOIN ... 
WHERE j.status = 'done' AND j.completed_at >= ?
GROUP BY substr(j.completed_at, 1, 7)
ORDER BY month
```
6 条 → 1 条。

### P8. 全端点分页支持

给以下端点加 `?offset=0&limit=50` 参数（schema + SQL LIMIT/OFFSET）：
- `GET /api/orders` — 默认 limit 50，最大 200
- `GET /api/jobs` — 同上
- `GET /api/alerts` — 默认 100
- 库存日志 `GET /api/inventory/log` — 默认 100

返回格式增加 `{ data: [...], total: N }` 包裹（或 `X-Total-Count` header）。
前端调用处对应更新。

### P9. 前端路由 lazy loading

`web/src/App.tsx` 改为 React.lazy + Suspense：

```tsx
const AdminPricing = lazy(() => import('./AdminPricing'))
const AdminOrders = lazy(() => import('./AdminOrders'))
const AdminJobs = lazy(() => import('./AdminJobs'))
// ... 所有 admin 页面
```

各页面组件文件加 `export default` 如果还没有。
用 `<Suspense fallback={<SkeletonPage />}>` 包裹。

### P10. AdminPricing reload 并行化

`AdminPricing.tsx` 的 `reload()` 8 个 API 调用：
→ `await Promise.all([...])` 并行发起。
同样检查 AdminInventory、AdminReports 的 reload 是否串行。

### P11. 全局 loading bar 改为非阻塞

`api.ts` 的 `startLoading()` / `stopLoading()` 触发全局 re-render。
→ 方案一：改为 `requestAnimationFrame` + CSS transition 控制 loading bar，
  不走 React state（DOM 直操作）。
→ 方案二：把 loading 状态隔离到独立 context，仅 Shell loading bar 订阅。
  选二比较稳，改动小。

---

## 第三批：Medium（日常体验优化）

### P12. getConfig 缓存（已含在 P2 中，此条确认 settings 写入时清缓存）

`settings-routes.ts` 中修改 system_config 后调 `invalidateConfigCache()`。

### P13. papers / combos / books API 内存 filter → SQL JOIN

`pricing-routes.ts`:
- `GET /api/pricing/papers` (line 274-286)：全量 load papers + costs 再 JS `.filter(c => c.paper_id === p.id)`
  → 改为 SQL LEFT JOIN + GROUP_CONCAT 或应用层 Map 分组
- `GET /api/pricing/combos` (line 424-428)：同上
- `GET /api/pricing/books` (line 554-568)：三表 load 后 JS filter
  → 改为 SQL JOIN 或至少用 Map 分组（O(n) 而非 O(n²)）

### P14. dashboard 查询合并

`dashboard-routes.ts:21-99`：5 个独立 COUNT/SUM 查询。
可合并为 1-2 条 SQL，例如：
```sql
SELECT
  (SELECT COUNT(*) FROM jobs WHERE status IN ('draft','queued','printing')) AS jobs_active,
  (SELECT COUNT(*) FROM orders WHERE status NOT IN ('delivered','cancelled')) AS orders_active,
  (SELECT COUNT(*) FROM alerts WHERE resolved_at IS NULL AND type IN ('calibration_due','maintenance_due')) AS maint_alerts
```

### P15. getOrderBooks 批量查

`orders.ts:172-193`：已用 prepared stmt 但逐 book 查 components/finishings。
→ 改为 WHERE order_book_id IN (?) 批量查（如果 book 列表从外部已知 order_id 集合则更好）。

### P16. 前端子组件 memo

给以下组件加 `React.memo`（仅 props 浅比较即可）：
- AdminOrders: OrderDetail, ReviewRow, BookComponentReviewRow
- AdminJobs: JobRow, BookJobGroup, StatusGroup
- AdminEquipment: PrinterCard
- OrderView: ItemRow, BookLine

给高频回调加 `useCallback`（如 onStatusChange, onReload）。

### P17. 前端缓存 TTL

`api.ts` 中的 `optionsCache` / `productsCache` / `booksCache` / `dashboardCache`：
加 `cachedAt: number` 时间戳，fetch 时检查 `Date.now() - cachedAt > TTL`（建议 60s）。
过期后仍先返回旧缓存（立即渲染），再后台刷新（stale-while-revalidate 模式）。

### P18. Quote.tsx 拆分

529 行单组件 → 拆为：
- `QuoteConfigurator` — 选品 + 参数
- `QuoteCart` — 购物车列表
- `QuoteCheckout` — 提交 + 访客表单
- `BookConfigurator` 已独立，改 `lazy(() => import('./BookConfigurator'))`

### P19. 缺失索引 migration

新建 `server/migrations/0020_perf_indexes.sql`：

```sql
-- 订单按客户+时间查（admin 订单列表、CRM 钻取）
CREATE INDEX IF NOT EXISTS idx_orders_customer_created ON orders(customer_id, created_at DESC);

-- 作业按状态+时间查
CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at DESC);

-- 订单号 LIKE 前缀匹配
CREATE INDEX IF NOT EXISTS idx_orders_number ON orders(order_number);

-- 书组件按 job_id 查（jobs 列表 LEFT JOIN）
CREATE INDEX IF NOT EXISTS idx_obc_job ON order_book_components(job_id) WHERE job_id IS NOT NULL;
```

记得在 docs/prd.md 附录 A 决策记录补一行。

---

## 第四批：Low（可选优化）

### P20. hashToken 重复调用

`auth.ts:verifyEmail` 内 hashToken(token) 调了两次（line 67 和 70）→ 提变量。

### P21. Date 对象复用

同一请求内 `new Date().toISOString()` 多次调用 → 提为 `const now = new Date().toISOString()`。

### P22. 告警扫描事务包裹

P5 已含。

### P23. recharts lazy import

Dashboard.tsx 和 AdminReports.tsx 的 recharts 组件用 `React.lazy` 按需加载。

---

## 验收清单

每批改完后验证：

1. `npm run typecheck` 通过
2. `npm test` 全部通过
3. pricing.test.ts §2.5 基线：187 可报价 / 43 手动价 / LOSS 4 / below_margin 25 不变
4. 金额字段无浮点运算引入
5. 前端 `npm run build` 成功，无 TS 错误
6. 启动 dev server，admin 关键页面（订单列表、定价、Dashboard）功能正常

## 工作方式

- 按批次推进，一批一个 commit（可按模块拆多个 commit 都行）
- commit message 用 `perf(scope): ...` 格式
- 每个 commit 直接 push 到 origin main
- 如果某项改动发现与现有测试冲突，停下来报告，不要猜
