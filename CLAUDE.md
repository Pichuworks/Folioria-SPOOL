# S.P.O.O.L. — folioria-spool

Folioria 印刷工坊管理系统。库存 → 报价 → 下单 → 生产 → 核算 → 维护。

## 技术栈（已定稿，不讨论替代方案）
- TypeScript 前后端 · Node ≥24（LTS 下限，开发环境实测 v26.1.0）
- API: Fastify v5 · 全端点 JSON Schema 校验
- DB: SQLite · better-sqlite3 · WAL · STRICT tables · 每连接 `PRAGMA foreign_keys=ON`
- 前端: React 18 + Vite + Tailwind **v4**（不要生成 v3 风格 tailwind.config.js）
- Auth: session 表 + httpOnly cookie（不是 JWT）

## 金额三铁律（违反 = 严重 bug）
1. 金额一律 INTEGER 定点：单价层后缀 `_c`（最小货币单位×100），金额层无后缀。
   TS 用 branded type（`MoneyC` / `Money`）隔离，混算必须编译报错。
2. 金额运算禁止浮点；除法只允许出现在 `formatMoney()` 一处。
3. 唯一舍入点：`line_total = round_half_up(unit_price_c × qty / 100)`；
   subtotal 起全是整数加法。自动地板价用 **ceil**。
   手动售价低于地板价时**生效并警示，禁止静默抬价**（见 docs/acceptance.md §2.3）。

## 单一事实源
- 需求与规则: @docs/prd.md（字段级定义以 schema.sql 为准）
- 表结构: @docs/schema.sql —— 人审定稿。禁止擅自改表；变更须新增 migration
  并在 docs/prd.md 附录 A 决策记录中补一行
- 验收基准: @docs/acceptance.md —— 测试先行；实现与测试冲突时，错的是实现
- 初始数据: data/seed.json（金额已是 _c 整数，导入时不做任何换算）

## 工作方式
- 一个任务一个会话；做完勾 docs/tasks-phase1.md 的 checkbox 再 commit
- 大改动先 plan mode 复述理解
- 每次代码改动后跑 `npm run typecheck && npm test`
- 不要重构与当前任务无关的代码；不要写多余注释
- 不确定的业务语义：查 prd.md 附录 A 决策记录，仍不确定就停下来问，不要猜

## commit
feat / fix / refactor / style / data / docs / test / chore
例: `fix(pricing): manual price must not be silently raised to floor`
