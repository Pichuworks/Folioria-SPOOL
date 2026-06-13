# S.P.O.O.L.

**Smart Production Operations & Order Ledger**

*Folioria 印刷工坊管理系统 · Product Requirements Document*

```
repo:    folioria-spool
status:  PRD v1.1 · Final（v1.0 + 修订案合并定稿）
author:  天王寺璃奈
co-author: 星街望 / 佐藤圭介(K君) / Claude
created: 2026-06
normative: 数据模型字段级定义以 docs/schema.sql 为准；本文描述语义与规则。
```

> "……spool……是打印的术语……也是线轴……把所有东西卷在一起。"
> —— 璃奈

> 设计哲学：**库存表只记已发生的事实，预测性数字全部动态计算；
> 金额全程整数定点，浮点不入账。**

---

## 0. 系统定位

Folioria 创意印刷工坊的全链路管理系统：**库存 → 报价 → 下单 → 生产 → 核算 → 维护**。

系统分两个域：**下单域**（外部客户与内部成员自助报价下单），**管理域**（admin 掌控库存、生产、定价、报表）。

**Out of Scope**：UV 打印与 3D 打印（耗材/承印物/成本核算另行记账；纳入需将 Paper 泛化为 Material，属 breaking change 须重新评审）；卷纸库存（不采购，如有按手工折算）；多币种同时记账（单实例单基准货币）。

---

## 1. 域与用户模型

```
┌─────────────────────────┐   ┌─────────────────────────┐
│  下单域 (Storefront)     │   │  管理域 (Workshop)       │
│  guest    浏览价目表     │   │  admin   K君/望/璃奈     │
│  customer 外部客户       │   │  全部数据可见            │
│  member   内部成员       │   │  全部操作可执行          │
│  （202住户+常客）        │   │                         │
└─────────────────────────┘   └─────────────────────────┘
```

- **下单域可见**：当前配置的单价与总价、自己订单的状态。**不可见**：成本、毛利、库存数量、他人订单、设备状态。字段级权限在 API 序列化层以白名单实施，非前端隐藏。
- **内部打印需求统一走下单域入口**，区别仅为适用内部价格规则（combo_prices.internal_sell_c 覆盖；缺省同对外逻辑）。内部消耗在月度报表单独归类。
- **Job 的录入与操作归管理域**：Order 确认后由 admin 创建 Job。
- **账号供给**：下单域开放自注册 + 邮箱验证（邀请码为可选开关，默认关闭）；member 身份由 admin 对已注册账号升格（内部标记），无独立注册通道；admin 不可自注册——初始 admin 由 `spool init` 创建（首次登录强制改密），后续在 `/admin/users` 手动添加。

---

## 2. 功能模块

### 2.1 📦 库存（Inventory）

实体拆分（字段见 schema.sql）：

- **papers** —— 纸张身份（名称/分类/克重/供应商）。
- **paper_stocks** —— 实物库存，按 **纸 × 尺寸 × 位置** 持有，数量为整数张。同种纸的 A3 与 SRA3 分开采购、分开存放、分开计数。
- **paper_size_costs** —— 采购口径（包价 ÷ 张数），同时是定价模型的纸张成本来源（§2.3）。
- **locations** —— 存放位置，湿度状态挂在位置上（Phase 3 绑定传感器），纸张湿度由所在位置推导，不逐纸维护。
- **consumables** —— 耗材单表。`cost_model` 区分：`per_page`（激光碳粉/drum/fuser，按标称寿命摊每面）与 `per_job_rule`（喷墨墨水，成本不从用量反推，由定价模型按面积推导）。换装流程：录入 MaintenanceEvent(toner_change, final_usage=旧件读数) → current_usage 清零、installed_at 更新、备品 −1，全程单事务。寿命历史留在维护日志。
- **inventory_log** —— 事件溯源。action 含 `convert`（裁切转换）：A3+ 裁 A4 录成对日志（−10 / +20，共享 convert_group），月底对账组内守恒。采购日志留原币痕：original_currency / original_amount（原币最小单位整数）/ converted_cost_c（录入时定格）/ exchange_rate_note（仅备注，不参与运算）。

**库存扣减规则**：

```
Job: draft → queued → printing → done / cancelled
queued/printing  不动库存
done             一次性落账（单事务）:
                   paper_stock −(quantity + waste_quantity)
                     → inventory_log(consume) [+ scrap 若有废品]
                   该打印机全部在役 per_page 耗材 usage += 实耗面数 → 阈值检查
                   printer.total_pages += 实耗面数 → 校准检查
cancelled        无任何库存动作（从未扣过，无需回滚）

可用量（动态计算，不落库）:
  available = stock.quantity − Σ(queued/printing 作业计划消耗)
  展示为「账面 48 · 排队占用 30 · 可用 18」；不足时警告但不阻断（admin 可强排）
```

### 2.2 🖨️ 设备（Equipment）

printers + maintenance_events（字段见 schema.sql）。要点：

- 校准**双触发**：calibration_interval_pages 或 calibration_interval_days，先到为准（任一为 NULL 则该维度不触发）。
- equipment_cost_c / monthly_cost_c 在单价层（参与折旧摊薄除法）。
- C850 设备成本 = 2060000_c（不含备品碳粉；备用 T01 一套归 consumables 初始库存）。

### 2.3 🎨 定价推导模型（Pricing）

> 替代 v1.0 的 CostRule 平面单价表。模型为推导式：改一次采购价，下游报价全部自动更新。

四张表：**sizes**（相对面积注册表）· **print_modes**（打印机×墨路×单双面，含墨水经济学）· **paper_size_costs**（§2.1 复用）· **combos + combo_prices**（兼容矩阵 + 手动售价覆盖）。duplex 编码在模式中（·双 出片量减半已含于 yield），不是独立报价参数。

**推导公式（全整数，舍入点固定）**：

```
eff_ink_c   = pricing_mode==ml ? ink_price_c × ml_per_batch : ink_price_c
ink_c       = round_half_up( eff_ink_c × size.area ÷ (yield_sheets × ref_size.area) )
paper_c     = round_half_up( pack_price_c ÷ pack_count )
overhead_c  = round( equipment_cost_c ÷ (dep_months × month_volume) )   // 设置默认 36×2000
total_c     = ink_c + paper_c [+ overhead_c]
auto_sell_c = ceil( total_c × 10000 ÷ (10000 − min_margin_bp) )
              // ceil：自动地板价永不击穿最低毛利（默认 6700bp = 67%）
```

**报价规则**：

```
报价 = 手动价存在 ? 手动价 : auto_sell_c
手动价允许低于地板价（引流价/市场价，如黑白 ¥0.07）：
  管理域对低毛利标橙、亏本标红，但不篡改售价
force_min_margin 设置开启时才将手动价抬升至地板价（默认关闭）
unify_pricing 设置：同纸张同尺寸同单双面取各模式最低有效价（管理域展示用）
```

**可选性规则**（报价配置器）：组合可选 ⇔ `Combo 存在 ∧ size.area ≤ mode.max_size.area ∧ PaperSizeCost 存在`。三条件任一不满足即不可选，客户永远选不出报不了价的组合。

管理域 `/admin/pricing` 对 sizes / print_modes / papers+paper_size_costs / combos 提供全量 CRUD（即现有成本计算器"参数设置"tab 的 API 化）。

### 2.4 📋 作业（Jobs）

字段见 schema.sql。要点：

- order_item_id 为 NULL 即内部作业；quoted_price 为 NULL 即不收费记账。
- waste_quantity 在 done 时录入，计入实耗。
- 成本快照（paper_cost_c / consumable_cost_c / overhead_cost_c / total_cost）在 done 时按 §2.3 推导定格，不实时引用定价表。

### 2.5 🧾 订单（Orders）

字段见 schema.sql。要点：

- **状态流**（含审稿环节）：

```
quoted → file_pending → file_approved → confirmed
       → in_production → ready → delivered      （任意状态 → cancelled）
```

- **文件**：order_item 级上传（PDF/TIFF/PNG，≤200MB），file_status: pending/approved/rejected + 审稿意见。Phase 2 人工审稿（出血/分辨率/色彩空间检查清单在运营文档）；自动预检属 Phase 3。
- **支付**：payment_status (unpaid/deposit/paid) + paid_amount + payment_method + paid_at。
- **报价时效**：quote_valid_until（默认 created_at + 系统设置 quote_valid_days=14），过期不可 confirm，须重新报价。
- **防枚举**：订单查询走随机 access_token（`/order/:token`）；order_number（FOL-2026-0001）仅人类可读展示。
- **价格快照**：order_items.unit_price_c 下单时定格，改价不影响既有订单（配合报价时效闭环）。

### 2.6 🔔 提醒（Alerts）

去重在数据库层强制：`UNIQUE(target_type, target_id, type) WHERE resolved_at IS NULL`。未解决的同源同类提醒不可重复产生（severity 可原地升级）；resolve 后再次越界产生新提醒。

### 2.7 📨 通知抽象层（Notifier）

```
interface NotificationChannel { id: string; send(to, msg): Promise<Result> }
事件 → 渲染模板 → 逐渠道分发 → notification_log 留痕
用户侧: notify_channels（订阅渠道，默认 ["email"]）+ notify_addresses
```

Phase 2 仅实现 **email adapter**（须经事务邮件服务商 Resend/SES/Mailgun，家庭宽带 IP 直发 SMTP 必进垃圾箱）。LINE Messaging API / 短信平台为后续可插拔 adapter（注意：LINE Notify 已于 2025-03 停服，文档中不得再引用）。

---

## 3. 页面结构

### 3.1 下单域（guest / customer / member）

```
/                  首页 · Folioria 介绍 + 工艺展示
/quote             自助报价器（配置器风格 · 实时算价 · 可选性三条件联动）
/order/:token      订单状态查询
/price-list        公开价目表
/my/orders         登录用户订单列表
```

### 3.2 管理域（admin）

```
/dashboard               四宫格：待办(订单+维护) · 库存预警 · 本月统计 · 设备状态
/admin/orders            看板视图：报价中→审稿→已确认→生产中→待取→已完成
/admin/inventory         纸张(卡片) / 耗材(寿命进度条) / 出入库(时间线·含裁切转换录入)
/admin/jobs              作业列表 + 新建向导（实时成本预览 · 可用量提示）
/admin/equipment         设备档案 + 维护日历 + 校准记录
/admin/pricing           定价管理（四表 CRUD · 成本速查 · 毛利警示）
/admin/users             用户管理（member 升格 · admin 添加）
/admin/settings          系统设置（毛利率/统一定价/强制覆盖 · 折旧参数 · 提醒规则 · 备份）
/admin/reports           月度成本/收入（内部消耗单列）· 设备利用率 · 纸张消耗排行
/calculator              成本计算器（管理域 · 数据源改 API）
```

---

## 4. 技术架构

```
Browser (React 18 + Vite + Tailwind v4 + TypeScript)
   │  REST API (JSON) · httpOnly session cookie
201 服务器 (systemd service)
   ├─ Fastify v5 (Node LTS · TypeScript · JSON Schema 全端点校验)
   ├─ SQLite (better-sqlite3 · WAL · STRICT tables · 外键 ON)
   │    备份: VACUUM INTO → NAS · systemd timer 每日 · 滚动保留 30 份
   │    ⚠️ 禁止直接 cp 数据库文件（WAL 不一致快照）· 上线前做恢复演练
   └─ 公网暴露: 反向代理 + TLS（推荐 Cloudflare Tunnel 或 Caddy）
```

| 决策 | 选择 | 理由 |
|---|---|---|
| 语言 | **TypeScript（前后端）** | branded type 隔离两级金额（MoneyC/Money），混算编译期报错 |
| API | Fastify v5（定稿，不再"or Hono"） | JSON Schema 在边界挡住浮点金额 |
| DB 驱动 | better-sqlite3 | 同步事务，扣库存+写日志原子操作最干净 |
| Auth | **session 表 + httpOnly cookie** | 单体应用无状态收益为零；可即时吊销、防 XSS 偷凭证 |
| 部署 | 201 · systemd | 与现有基础设施统一 |

### 4.1 开发分期

#### Phase 1 · MVP（4-6周）

```
[必须] spool init 向导：选基准货币（JPY/CNY/USD，产生数据后锁定）+ 初始 admin
[必须] 金额工具函数 + branded types + 验收用例测试（先行，见 docs/acceptance.md）
[必须] schema migration + seed 导入（docs/schema.sql · data/seed.json）
[必须] 定价四表 CRUD + 报价推导 API（/calculator 页面接 API）
[必须] 纸张库存（papers/stocks/locations）+ 裁切转换录入
[必须] 耗材库存 + 寿命进度条 + 换装流程
[必须] 设备档案 + 维护事件 + 双触发校准提醒
[必须] 作业录入向导 + done 落账 + 可用量动态展示
[必须] 提醒（库存低/校准/耗材阈值）
[必须] 管理域用户系统 + session auth
[必须] Dashboard
```

#### Phase 2 · 订单系统（2-4周）

```
[计划] 下单域开放注册 + 邮箱验证（邀请码开关默认关）
[计划] 自助报价器（公开）+ 公开价目表
[计划] 订单全状态流（含审稿）+ 文件上传
[计划] 支付状态记录 + 报价有效期 + access_token 查询
[计划] Notifier 抽象层 + email adapter（事务邮件服务商）
[计划] 安全基线（TLS / 限流 / 注册防滥用，见 §6）
```

#### Phase 3 · 智能化（持续）

```
[未来] 环境传感器 MQTT → location 湿度自动预警
[未来] 打印机 SNMP → 出纸计数/碳粉余量自动校正
[未来] 文件自动预检（出血/分辨率/色彩空间）
[未来] 月度报表自动生成 · 库存预测建议补货
[未来] LINE Messaging API / 短信 adapter（按需）
[未来] Fiery 热文件夹监控 → 自动记作业
```

---

## 5. 核心数据流

### 5.1 自助报价 → 下单 → 审稿 → 生产

```
Customer                    System                      Admin
   │ 选模式/纸/尺寸/数量      │                           │
   │ ──────────────────────→ │ 可选性三条件 → 推导报价    │
   │ ← 实时报价 ──────────── │                           │
   │ 确认下单 + 上传文件      │                           │
   │ ──────────────────────→ │ Order(quoted→file_pending)│
   │                          │ ────── 通知 ────────────→ │ 审稿
   │                          │ ← file_approved/rejected─ │
   │ ←（驳回则改稿重传）───── │                           │
   │                          │ ← confirmed ───────────── │ 创建 Job(queued)
   │ ← 订单确认通知 ───────── │                           │ 生产 → Job done 落账
   │                          │ ← ready ────────────────  │
   │ ← 可取货通知 ─────────── │                           │
   │ 取货/付款                │                           │ delivered + paid
```

### 5.2 Job done 落账（单事务）

```
Job done（打印200张 A4 彩色 + 废品3张）
  ├→ paper_stock(铜版128g·A4) −203 → inventory_log(consume −200, scrap −3)
  ├→ C850 在役 per_page 耗材（T01碳粉/drum/fuser…全部）usage +203面
  │    └→ 各自检查 alert_threshold → 越界且无未解决提醒 → 新 Alert
  ├→ printer.total_pages +203
  │    └→ 距上次校准 页数 or 天数 任一越界 → Alert(calibration_due)
  └→ 成本快照定格（ink/paper/overhead → total_cost, profit）
```

---

## 6. 安全基线

```
[必须] 反向代理 + TLS，API 不裸奔公网
[必须] session: httpOnly + Secure + SameSite；token 仅存哈希；可吊销
[必须] 速率限制：/api/auth/* 与 /api/calculator/quote 按 IP 限流
[必须] 下单域注册邮箱验证；admin 无自注册通道
[必须] 订单查询走 access_token，禁止顺序号枚举
[必须] 文件上传：类型白名单 + 大小上限 + 不可执行目录隔离存储
[建议] 管理域路由限制来源 IP 段（内网/VPN）
```

---

## 7. 金额与货币（全局纪律）

1. **整数定点，两级精度**：单价层 = 最小货币单位 ×100（后缀 `_c`）；金额层 = 最小货币单位整数（无后缀）。SQLite 无真 DECIMAL，全部 INTEGER + STRICT 表强制。
2. **唯一舍入点**：`line_total = round_half_up(unit_price_c × quantity ÷ 100)`。subtotal 起全是整数加法，明细与总计在结构上不可能对不上。推导模型内的中间舍入按 §2.3 公式固定。
3. **百分比用基点**：min_margin_bp（6700=67%）、alert_threshold_bp（2000=20%）。remaining_pct 不落库，展示层算。
4. **折扣只允许整数减额**，不做百分比折扣。
5. **货币注册表 + 实例基准货币**：currencies 种子 JPY/CNY/USD（含 ISO 4217 exponent）；base_currency 在 spool init 选定，产生业务数据后锁定（换币种=新实例）；扩新货币=注册表插一行。采购原币仅留痕，换算结果录入时定格。
6. **`formatMoney(amount, currency)` 是全系统唯一允许除法的函数**（JPY→`¥3,400`，USD→`$34.00`）。
7. TS 侧 branded type（MoneyC/Money）隔离两层；Fastify JSON Schema 全金额字段 `type: integer`。

---

## 8. API 端点概览

```
Auth:       POST /api/auth/login · POST /api/auth/register (下单域)
            POST /api/auth/logout · GET /api/auth/me
Pricing:    GET|POST|PATCH|DELETE /api/pricing/{sizes,modes,papers,paper-size-costs,combos}
            （admin · DELETE 为 archive）
Calculator: POST /api/calculator/quote { mode, paper, size, quantity }
            GET  /api/calculator/options（可选性矩阵，下单域可见、仅含售价）
Inventory:  GET|POST|PATCH /api/inventory/{stocks,consumables}
            POST /api/inventory/convert（裁切转换，成对日志）
            GET  /api/inventory/log ?target=&action=&from=&to=
Equipment:  GET|PATCH /api/equipment/:id · GET|POST /api/equipment/:id/maintenance
Jobs:       GET|POST|PATCH /api/jobs · POST /api/jobs/:id/done {waste_quantity}
Orders:     GET|POST /api/orders · PATCH /api/orders/:id/status
            POST /api/orders/:id/items/:iid/file (上传) · PATCH …/file-review
            GET  /api/orders/by-token/:token（下单域查询）
Alerts:     GET /api/alerts · PATCH /api/alerts/:id/{acknowledge,resolve}
Reports:    GET /api/reports/{monthly,equipment-usage,paper-consumption}
Settings:   GET|PATCH /api/settings（admin）
```

下单域响应序列化白名单剥离一切 `*_cost*` / `profit` / `margin` 字段。

---

## 9. 初始数据

以 `data/seed.json` 为准（自 folioria_cost.html 提取，金额已转 `_c` 整数，提取脚本零精度损失校验通过）：

- 6 尺寸（6寸/A5/A4/A3/A3+/SRA3，含相对面积）
- 6 物理打印机（C850/P708/G580/L15168/C650 + CP5225[白碳粉/烫金，暂无成本模式]）
- 16 打印模式 · 13 纸张 · 38 组纸张×尺寸采购口径 · 70 组合（20 手动定价 / 50 自动地板价）
- 耗材：备用 T01 一套（140000_c）—— C850 设备投入 2060000_c 不含此项
- 系统设置：min_margin_bp 6700 · unify ON · force OFF · 折旧 36月×2000张/月

---

## 10. UI 设计方向

（沿用 v1.0 §6 全部内容：深林绿/暖金/暖白色板 · Fraunces/Inter/JetBrains Mono/Noto Sans JP · 8px 圆角 · 4px 间距基准 · 关键交互表。新增一条：）

| 场景 | 交互方式 |
|---|---|
| 定价警示 | 手动价低于毛利线标橙 · 亏本标红 · 自动地板价以斜体"≥¥x"展示（沿用计算器现行视觉语义） |

---

## 11. commit 惯例

```
feat / fix / refactor / style / data / docs / test / chore
示例: feat(inventory): add paper cut-conversion paired logging
      fix(pricing): manual price must not be silently raised to floor
      data(seed): import 16 print modes from cost calculator
```

---

## 附录 A · 决策记录

| # | 决策 | 结论与理由 |
|---|---|---|
| D1 | 开纸换算 | 不建自动模型；裁切人工折算 + convert 成对日志留痕（不买卷纸） |
| D2 | 耗材模型 | 单表 + 换装走 MaintenanceEvent(final_usage)；喷墨成本走推导不走寿命 |
| D3 | 扣减时机 | done 实扣含废品；预占用动态算不落库；cancelled 零回滚（否决 reserved 状态：同步 bug 面大） |
| D4 | 3D/UV | 整体移出，另行记账（否决 Material 泛化：MVP 不背包袱） |
| D5 | 成本可见性 | 双域切分，字段级白名单在序列化层（否决角色打补丁） |
| D6 | 通知 | email 先行 + Notifier 可插拔（LINE Notify 已停服） |
| D7 | 货币 | 注册表 + 实例基准货币，init 选定后锁死；两级整数定点 |
| D8 | 定价模型 | 推导式（C9），否决 CostRule 平面表；手动价无条件生效，force 默认关——**曾误写为强制抬价，全量回归测试否决，引流价（黑白¥0.07）必须可低于地板价** |
| D9 | Auth | session 表 + httpOnly cookie（否决 JWT：黑名单查库后无状态收益归零） |
| D10 | 账号供给 | 下单域开放注册；member 升格制；admin 仅手动添加 + init 引导 |
| D11 | 首登改密标记 | users.must_change_password 列（0002 migration）；spool init 创建的 admin 置 1，改密成功后应用层清零（B1 首登强制改密的落地载体） |
| D12 | 注册与验证 | POST /api/auth/register 即注册即登录（role 恒 customer，body 白名单剥除 role 键；admin 自注册通道仍 404）；验证 token 仅存 sha256、48h 一次性；未验证可登录，下单是否受阻由 D17 的 require_email_verification 开关决定（开启时 403 email_unverified，默认关）；admin/init 手动供给的账号视为已验证；registration_open（默认开）+ invite_code（NULL=关）走 0003 migration |
| D13 | 审稿流转 | file_pending/file_approved 仅系统自动流转（不可手动 PATCH）：全部 item 有文件→file_pending；全 approved→file_approved，任一 rejected 留 file_pending 等重传；重传重置该 item pending 并清驳回意见、旧文件删除；file_approved 起上传冻结（admin 驳回才解锁） |
| D14 | confirm 与取消 | confirm 仅 file_approved 且未过 quote_valid_until（过期 409 quote_expired，其余状态不受时效影响）；单事务逐 item 建 Job(queued, quoted_price=line_total) 并回写 order_items.job_id；done 落账只走既有 completeJob；customer 仅可取消 confirm 前自己的单，confirmed 起仅 admin，取消连带取消未完成 Job（done 不动——C3 零回滚语义） |
| D15 | 文件存储 | SPOOL_UPLOAD_DIR（默认 ~/.local/share/spool/uploads，代码目录之外不可执行）+ randomUUID 存储名（原始文件名不落盘，路径穿越无面）；PDF/TIFF/PNG 扩展名+magic bytes 双查、≤200MB、超限/伪装不留半截文件；下载限 owner/admin，attachment + nosniff + octet-stream |
| D16 | 通知落地 | NotificationChannel 接口 + Resend HTTP adapter（家庭宽带直发 SMTP 必进垃圾箱，否决）；无 SPOOL_RESEND_API_KEY → skipped 落 notification_log + console dev 输出，分发永不抛错不阻塞业务；事件 email_verification / order_file_pending(→全体活跃 admin) / order_file_rejected(→customer，审稿驳回须通知重传) / order_confirmed / order_ready(→customer，尊重 notify_channels/notify_addresses) |
| D17 | 邮箱验证开关 | email 验证「是否必需」改为 system_config.require_email_verification 开关（0004 migration，默认 0=不要求）；为 1 时沿用 D12 的 403 email_unverified 下单门，为 0 时未验证亦可下单；验证邮件无论开关都照常下发（便于日后开启而不必补发 token）。公开 GET /api/public-config 暴露该标志（无成本字段，下单域可读）供前台条件提示。修订 D12 的无条件表述 |
| D18 | 用户名登录 | users.username 可选第二登录标识（0005 migration，部分唯一索引 COLLATE NOCASE on column）；email 仍为通知/验证主干与必填唯一键。登录 body 改 identifier（用户名或邮箱，保留 email 别名向后兼容），verifyLogin 以 `email=? OR username=? COLLATE NOCASE` 解析；username 格式 ^[a-z0-9_]{3,30}$（禁 '@'/空格保持解析无歧义）；重名 409 username_taken（与 email_exists 同为既有枚举面，不新增更敏感口径） |
| D19 | 忘记密码 | 独立 password_reset_tokens 表（0006 migration，不复用验证 token——信任级别不同）；仅存 sha256、2h、一次性。POST /api/auth/forgot-password 无论账号是否存在一律 204（不泄露存在性），存在则发 password_reset 邮件。POST /api/auth/reset-password 无效/过期/已用一律 404；成功置新密码、清 must_change_password、撤销该用户全部会话与其它未消费 reset token。前台 #/reset/:token + 登录页「忘记密码」入口 |
| D20 | Web 初始化向导 | POST /api/setup 包住 CLI 同款 spoolInit（id=1 守卫即「仅未初始化可达」真锁，重复 409 already_initialized）；body 基准货币/首位 admin（+可选 seed 导入），向导自设密码故置 must_change_password=0 并自动登录。无 schema 变更（GET /api/public-config 的 initialized 供前台首屏判定，未初始化即强制 #/setup 盖过路由）。CLI spool init 仍为无头部署路径，先写者赢 |
| D21 | 页计数口径（待 K 君确认） | jobs.pages_consumed / printers.total_pages / per_page 耗材 current_usage_pages 一律按 **impression（面）** 计：双面作业每张 = 2 面，故 completeJob 默认 `pages = (quantity+waste) × (duplex?2:1)` 正确。与成本侧解耦——成本走 ink_c（yield_sheets 已含双面减半），计数走面数，两套口径各自自洽。acceptance §3.1 仅覆盖单面(203 面 1:1)，双面口径据此裁定，实现不变 |
| D22 | 地板价成本基数（待 K 君确认） | 自动地板价 ceil 的成本基数 = **仅直接材料 ink_c+paper_c**（不含 overhead），故 §2.2/§2.5 基线（74→225…）不变；overhead 仅在 done 成本快照计入 total_cost。结论：「永不击穿 67%」是对**直接材料**的毛利保证，overhead 作为另一层成本会侵蚀该毛利垫，账面实际毛利可低于 67% —— 此为有意设计（改地板会牵动全量回归基线），非 bug，实现不变 |
| D24 | 机器推荐 / 改派（③⑤ 第一阶段） | **已实现**：recommendMachines(纸×尺寸[,单双面]) 列出能做的 mode/printer，按 在线→单张参考成本(含 overhead)升序→队列负载 排序；GET /api/jobs/recommend；PATCH /api/jobs/:id/mode 改派（done/cancelled 不可改；新机须 deriveUnitCost 非空）。min 成本仅作报价/选机参考，落账仍用**实际机器**（与 D22 一致）。AdminJobs 加改派面板。**待 K 君裁决（第二阶段，未实现）**：客户端产品抽象层（products/product_modes/product_prices，售价手填、机器无关 = A 内核）需 (a) 人工编 mode→product 映射（color_tag/ink_type/duplex 无法自动归类，见 review），(b) 搬动 §2.5「客户可见」基线——须先确认产品分类表与新等价数字，再落 0008 migration + 改 seed.test。当前 storefront 仍按 mode 选（机器对客户可见）= 唯一未闭合项 |
| D25 | 色彩档字段（③⑤ 第二阶段·基础设施） | print_modes.color_class（0008 migration，可空）= 单页属性配置器唯一需人工映射的「色彩档」槽（黑白/彩色/图质…，档位由 K 君定）。admin 在 /admin/pricing 模式编辑/新建处填写（pricing-routes modes CRUD + AdminPricing 表单）。本步**纯加列 + 后台录入**，不动 storefront / seed.json / acceptance / §2.5 基线——客户端属性配置器切换与客户可见基线搬家须另行人审签字（见 docs/design-product-layer.md）。user_version 7→8 |
| D23 | 免登录（访客）下单 | 放宽「订单须注册用户」的隐含前提，须独立裁决。orders.customer_id 仍 NOT NULL，访客单指向 0007 合成哨兵用户（id='guest'，archived=1，永不解析会话），orders 挂 guest_email/name/contact 留痕（避开 NOT-NULL→NULL 整表重建）。公开 POST /api/orders/guest（限流，复用 createOrder internal=false，仅回 access_token 链接），behind system_config.guest_orders_open（默认 0 显式 opt-in）。隐私一次性入口沿用随机 access_token（拒绝短码可枚举）。认领 POST /api/orders/by-token/:token/claim：须登录用户**邮箱已验证且 NOCASE == guest_email**（token 本身不足以改绑归属），通过则改绑 customer_id 并清 guest_*。访客单的 confirm/ready 通知走 guest_email 直发；orderDto admin 分支渲染 guest 身份而非哨兵 |

---

```
S.P.O.O.L. v1.1 PRD · Final
Co-authored-by: Rina Tennoji
Co-authored-by: Nozomu Hoshimachi
Co-authored-by: Keisuke Sato
Co-authored-by: Claude
```
