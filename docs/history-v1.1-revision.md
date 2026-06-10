# S.P.O.O.L. PRD v1.1 修订案

**对 v1.0 的审阅结论 + 变更集 · 待璃奈确认合并**

```
repo:    folioria-spool
status:  v1.1 Revision Draft
base:    PRD v1.0 (天王寺璃奈)
type:    review changeset（按节给出 diff，不是全文重写）
created: 2026-06
```

> 设计哲学一句话总结：**库存表只记已发生的事实，预测性数字全部动态计算。**
> v1.0 的 InventoryLog 本来就是事件溯源风格，本次修订全部顺着这个思路走。

---

## A. 决策记录（Decision Record）

六个核心决策，已逐条确认：

| # | 问题 | 决策 |
|---|---|---|
| D1 | 开纸换算（采购尺寸≠输出尺寸） | **不建自动换算模型**。不买卷纸；裁切由人工折算，系统提供 `convert` 日志动作留痕 |
| D2 | 耗材型号与在役实例是否分离 | **单表保留**。换装走 `MaintenanceEvent(toner_change)` 记录旧件最终用量后清零 |
| D3 | 库存扣减时机 | **done 时实扣（含废品）**。预占用动态计算、不落库；cancelled 无需回滚 |
| D4 | 3D / UV 范围 | **整个移出系统**，另行记账。删除相关打印机、工艺、enum 值 |
| D5 | 成本/毛利可见性 | **按域切分**：下单域只见单价/总价；管理域可见一切。字段级权限在 API 层实施 |
| D6 | 通知渠道 | **邮件先行 + 泛用 Notifier 接口**。LINE/短信等渠道作为可插拔 adapter 后续接入 |

---

## B. 架构级变更

### B1. 角色模型重构：从四角色到双域（替换 v1.0 §1）

v1.0 的 guest/customer/member/admin 四级权限废弃，改为**两个域 + 域内角色**：

```
┌─────────────────────────┐   ┌─────────────────────────┐
│  下单域 (Storefront)     │   │  管理域 (Workshop)       │
│                         │   │                         │
│  guest    浏览价目表     │   │  admin   K君/望/璃奈     │
│  customer 外部客户       │   │          全部数据可见     │
│  member   内部成员       │   │          全部操作可执行   │
│  （202住户+常客）        │   │                         │
└─────────────────────────┘   └─────────────────────────┘
```

**下单域**只能看到：当前印刷配置的**单价与总价**、自己订单的状态。
看不到：成本、毛利、库存数量、其他人的订单、设备状态。

**管理域**：库存管理、作业管理、设备维护、定价、用户管理、报表——什么都能看到。

关键变化：

1. **内部打印需求统一走下单域入口。** member 不再有"录入作业/查看库存"特权——v1.0 里 member 录作业能看到自动算出的毛利，常客可见成本结构，这是泄露。内部成员和外部客户用同一个下单流程，区别仅在于适用**内部价格规则**（见 B1.1）。
2. **字段级权限在后端实施。** 下单域 API 响应中物理剥离 `*_cost` / `profit` / `margin` 字段（序列化层白名单），不是前端隐藏。
3. **Job 的录入与操作归管理域。** Order confirmed 后由 admin 创建 Job；内部需求同理（内部 Order → Job）。
4. **账号供给规则。** 下单域（customer / member）开放自注册 + 邮箱验证；member 身份由 admin 在用户管理中对已注册账号**升格**（打内部标记），不走单独注册通道。管理域 admin 不可自注册：初始 admin 由部署 CLI 创建，后续 admin 由既有 admin 手动添加。

#### B1.1 内部价格规则

```
CostRule 增加字段:
  internal_price   float | null    // 内部价（null = 内部不开放此工艺）
```

202 住户打印按内部价（可设为成本价或 0），月度报表中内部消耗单独归类，解决"内部作业成本归属"问题。

### B1.2 页面结构相应调整（修改 v1.0 §3）

```
§3.2 成员页面 整节删除，其中:
  /inventory/*   → 移入 §3.3 管理页面 (/admin/inventory/*)
  /jobs/*        → 移入 §3.3 管理页面 (/admin/jobs/*)
  /calculator    → 移入管理域（含成本数据，不能对下单域开放）
  /dashboard     → 管理域专属

下单域新增:
  /my/orders     登录用户（customer + member）的订单列表
```

### B2. 3D / UV 移出（执行 D4，修改 v1.0 §2.2 / §2.3 / §9）

```
删除:
  Printer 初始数据:  UV5060 (UV 5060 TX800) · P1S (Bambu Lab P1S Combo)
  Printer.type enum: 移除 uv | sublimation | 3d → 保留 laser | inkjet
  Process 初始数据:  uv_print · uv_relief · 3d_print
  Process.category:  移除 uv | 3d

保留:
  white_toner / foil_stamping (CP5225 是激光机，留在系统内)

PRD 增加 Out of Scope 声明:
  「UV 打印与 3D 打印的耗材、承印物、成本核算不在 SPOOL 范围内，
   另行记账。若未来纳入，需将 Paper 泛化为 Material（unit 增加
   gram/piece），属 breaking change，须重新评审。」
```

---

## C. 数据模型变更

### C1. 库存（修改 v1.0 §2.1）

```diff
InventoryLog {
-  action   enum   purchase | consume | adjust | scrap | return
+  action   enum   purchase | consume | adjust | scrap | return | convert
+  convert_group   UUID | null   // 裁切转换：成对日志共享同一 group id
}
```

**裁切转换用法**（D1）：A3+ 裁 A4 时人工录入一笔转换，系统生成成对日志：
`(convert, A3+纸, −10)` + `(convert, A4纸, +20)`，同 `convert_group`。
月底对账时 convert 组内自洽，不会出现"纸凭空变多"的幽灵库存。

```diff
Paper {
   quantity   float → 拆分语义:
+    quantity 仅在 unit=meter 时允许小数；unit=sheet 时校验为整数
+  archived   bool   false        // 软删除标记（见 C5）
-  moisture_status  enum          // 从 Paper 移除，改为推导字段
}

+ Location {                      // 新增轻量实体
+   id        string    "3F纸张柜·A区"
+   sensor_id string | null       // Phase 3 绑定 MQTT 传感器
+   moisture_status  enum  ok | warning | danger
+ }
+ // Paper.location 改为 ref→Location
+ // 纸张湿度状态 = 所在 Location 的状态（推导，不逐纸维护）
```

### C2. 耗材（执行 D2，修改 v1.0 §2.1.2）

单表保留，换装流程固化：

```diff
Consumable {
+  archived   bool   false
+  cost_model enum   per_page | per_job_rule
+    // per_page:     激光碳粉/drum/fuser → 按 rated_life 摊到每面
+    // per_job_rule: 喷墨墨水 → 不从 usage 反推，成本直接取
+    //               CostRule.ink_cost_per_unit（按尺寸的经验值）
}

MaintenanceEvent {
+  final_usage  int | null   // toner_change 时记录旧件最终用量
}
```

**换装流程**：录入 `MaintenanceEvent(toner_change)` → 旧件 `current_usage` 写入 `final_usage` → `Consumable.current_usage` 清零、`installed_date` 更新、备品 `quantity −1`。寿命历史留在维护日志里（回答"实际寿命比标称差多少"够用）。

**多耗材联动**（修正 v1.0 §5.2 只更新 T01 的遗漏）：Job 完成时，该打印机**所有在役 per_page 耗材**统一 `+pages_consumed`，逐一检查 `alert_threshold`。

~~CostRule.ink_cost_per_unit~~ → 废止。读取实际成本计算器源码后确认
v1.0 §2.3 的 CostRule 平面单价模型与现实不符，整体替换为 C9 的推导模型。

### C3. 作业与扣减时机（执行 D3，修改 v1.0 §2.4 / §5.2）

```diff
Job {
+  waste_quantity   int   0     // 打废重印数（实耗 = quantity + waste）
}
```

**扣减规则改写 §5.2**：

```
Job 状态机: draft → queued → printing → done / cancelled

queued / printing:  不动库存。
done:               按实际消耗一次性落账:
                      Paper −(quantity + waste_quantity) 换算后张数
                      → InventoryLog(consume) + 若有废品 InventoryLog(scrap)
                      在役耗材 usage += 实耗面数 → 阈值检查
                      Printer.total_pages += 实耗面数 → 校准检查
cancelled:          无任何库存动作（从未扣过，无需回滚）。
```

**预占用动态计算**（不落库）：

```
available = Paper.quantity − Σ( queued/printing 作业的计划消耗 )
```

库存卡片与新建作业向导显示三个数：`账面 48 · 排队占用 30 · 可用 18`。
可用不足时向导给出警告但**不阻断**（admin 有权强排，纸可能在路上）。

### C4. 订单：支付、报价有效期、查询令牌（修改 v1.0 §2.5）

```diff
Order {
+  // 支付（v1.0 完全缺失）
+  payment_status   enum    unpaid | deposit | paid
+  paid_amount      float   0
+  payment_method   string | null     // 现金/转账/PayPay...
+  paid_at          datetime | null

+  // 报价时效
+  quote_valid_until  date            // 默认 created_at + 14天
+    // 过期 quoted 订单不可 confirm，需重新报价

+  // 防枚举查询令牌
+  access_token     string            // 随机 token，订单查询链接用它
+    // /order/:token 替代 /order/:id —— FOL-2026-0001 顺序号
+    // + 弱验证可被遍历试出，order_number 仅作人类可读展示
}
```

**状态流插入审稿环节**（v1.0 状态机缺最关键一步——印什么）：

```diff
- quoted → confirmed → in_production → ready → delivered
+ quoted → file_pending → file_approved → confirmed
+        → in_production → ready → delivered
+ (任意状态 → cancelled)

OrderItem {
+  file_url      string | null
+  file_status   enum   pending | approved | rejected
+  file_note     string         // 审稿意见："出血不足3mm，请重新导出"
}
```

文件上传约束：PDF / TIFF / PNG，单文件 ≤ 200MB，审稿由 admin 人工执行（出血、分辨率、色彩空间检查清单放运营文档，不做自动预检——Phase 3 再说）。

### C5. 软删除（全局）

```
所有被 InventoryLog / Job / Order 引用的实体（Paper, Consumable,
Printer, Process, User）物理 DELETE 改为 archived 标记:

  DELETE /api/inventory/paper/:id  →  实际执行 archived=true
  列表默认过滤 archived，加 ?include_archived=true 参数
```

### C6. 设备：校准双触发（修改 v1.0 §2.2）

```diff
Printer {
   calibration_interval_pages  int    5000
+  calibration_interval_days   int    90
+  // 触发规则：页数或天数，先到为准
+  // next_calibration_due 由两者共同推导，解决 v1.0 中
+  // "按页配置 vs 按日期到期" 的自相矛盾
}
```

### C7. 币种与金额精度（全局约定）

**全文清算：v1.0 中所有金额类 `float` 字段一律废除，改为整数定点存储。**
理由：IEEE 754 浮点累加必然产生误差（`0.1+0.2≠0.3`），且 SQLite 无真正的
DECIMAL 类型——声明了也按 REAL 亲和性落盘。金额运算全程整数，杜绝对账误差。

```
实例基准货币（首次初始化时选定）:

+ Currency {                       // 货币注册表 · 种子数据 JPY / CNY / USD
+   code            string   "JPY" | "CNY" | "USD"
+   symbol          string   "¥"   | "￥"  | "$"
+   decimal_places  int       0    |  2    |  2     // ISO 4217 exponent
+   // 最小单位: JPY→円 · CNY→分 · USD→cent
+   // 扩展新货币 = 注册表插一行，零代码改动
+ }
+
+ SystemConfig {
+   base_currency   ref→Currency   // 初始化向导中选择
+   // ⚠️ 一经产生业务数据后不可更改——变更基准货币意味着
+   //    全库历史金额换算，禁止。换币种 = 新实例。
+ }
+
+ 所有报价、成本、报表均以 base_currency 记账。

两级精度（按基准货币的最小单位泛化）:
  ┌─ 单价层（最小单位 ×100 定点 · JPY→厘 / USD→0.0001$）─┐
  │  CostRule.cost_per_unit / min_price / internal_price  │
  │  CostRule.ink_cost_per_unit                           │
  │  Paper.unit_cost · Consumable.unit_cost               │
  │  OrderItem.unit_price                                 │
  │  Job.paper_cost / consumable_cost / overhead_cost     │
  │  Printer.monthly_cost_c / equipment_cost_c            │
  │    （参与折旧摊薄除法，须留两位精度 → 单价层）        │
  └───────────────────┬───────────────────────────────────┘
                      │ 唯一舍入点：单价×数量 → 行小计
                      │ 规则: round half up，固定不商量
  ┌─ 金额层（最小货币单位整数 · 円/分/cent）┴─────────────┐
  │  OrderItem.line_total                                 │
  │  Order.subtotal / discount / total / paid_amount      │
  │  Job.total_cost / quoted_price / profit               │
  │  MaintenanceEvent.cost                                │
  └───────────────────────────────────────────────────────┘

  subtotal = Σ line_total（整数加法，不再二次舍入）
  字段命名约定: 单价层字段加后缀 _c（centi-minor，如 unit_price_c），
  金额层字段无后缀，代码评审时一眼可辨，杜绝两层混算。
```

**百分比同理去浮点**：

```
CostRule.margin_target        float %  →  int 基点（3500 = 35.00%）
Consumable.alert_threshold    float %  →  int 基点（2000 = 20.00%）
Consumable.remaining_pct      → 删除存储，纯展示层计算（本来就标了自动计算）
Order.discount                → 仅允许最小货币单位整数减额，不做百分比折扣
                                （要打折就让 admin 自己心算填整数，封死误差入口）
```

**采购原币**：

```
InventoryLog (action=purchase) 增加:
+  original_currency  ref→Currency           // 任意已注册货币（淘宝→CNY 等）
+  original_amount    int                    // 原币最小单位整数（分/cent/円）
+  converted_cost_c   int                    // 换算为基准货币单价层，录入时定格
+  exchange_rate_note string | null          // 当日汇率仅作备注留痕，
                                             // 不参与任何后续运算
```

汇率只在录入瞬间用一次、结果定格为整数，之后所有计算只碰 `converted_cost_c`
——汇率本身不需要精确存储，因此连定点都不用，备注留痕即可。

**实现约束**：JS 侧金额变量全程 `number` 整数运算（最大金额远低于 2^53，
安全），禁止出现 `/100` 后再参与运算的中间值；除法仅允许出现在展示格式化
函数中。Fastify 的 JSON Schema 对所有金额字段声明 `type: integer`。
展示格式化由 Currency 注册表驱动（symbol + decimal_places），即
`formatMoney(amount, currency)` 是全系统唯一允许除法的地方——JPY 显示
`¥3,400`，USD 显示 `$34.00`，业务层对此无感知。

### C8. Alert 去重（修改 v1.0 §2.6）

```
创建规则: 同 (target_type, target_id, type) 存在 resolved_at IS NULL
的 Alert 时不重复创建（碳粉 19%→18%→17% 只产生一条，severity 可升级）。
resolve 后再次越界才产生新 Alert。
```

### C9. 成本模型实形化（整体替换 v1.0 §2.3 CostRule）

读取 `folioria_cost.html` 实际实现后确认：现行成本模型是**推导式**而非
平面单价表。改一次碳粉采购价，下游所有报价自动更新——这个性质必须保留，
故 v1.0 的 CostRule{cost_per_unit} 废弃，按实际模型建表：

```
Size {                       // 尺寸注册表（可在 /admin/pricing 增删）
  key      string   "A4"
  label    string   "A4"
  area     float    97       // 相对面积单位，墨水成本按此比例缩放
  sort     int
}

PrintMode {                  // 打印模式 = 打印机×墨路×单双面（替代 Process）
  id            int
  name          string   "C850 彩图·单"
  printer       ref→Printer
  ink_type      enum     toner | pigment | dye
  pricing_mode  enum     set | ml          // 整套计价 or 按毫升
  ink_price_c   int                        // _c/套 或 _c/ml
  ml_per_batch  int | null                 // ml 模式的批容量
  yield_sheets  int                        // 基准尺寸出片量
  ref_size      ref→Size                   // 基准尺寸
  max_size      ref→Size                   // 最大可印尺寸
  duplex        bool                       // ·双 模式出片量减半已含在 yield
}

PaperSizeCost {              // 纸张×尺寸的采购口径
  paper      ref→Paper
  size       ref→Size
  pack_price_c  int          // 包价
  pack_count    int          // 包内张数
}

Combo {                      // 兼容矩阵 + 手动售价覆盖
  mode       ref→PrintMode
  paper      ref→Paper
  sell_c     map<size_key, int>   // 手动售价/张；缺省 = 自动地板价
  internal_sell_c  map<size_key, int> | null   // 内部价覆盖（B1.1 迁移至此）
}
```

**成本与报价推导（全整数，舍入点固定）**：

```
ink_c(mode, size)   = round_half_up( eff_ink_c × size.area
                                     ÷ (yield_sheets × ref_size.area) )
                      eff_ink_c = pricing_mode==ml ? ink_price_c×ml : ink_price_c
paper_c(paper,size) = round_half_up( pack_price_c ÷ pack_count )
total_c             = ink_c + paper_c [+ overhead_c]
overhead_c          = round( equipment_cost_c ÷ (dep_months × month_volume) )
                      // 折旧参数入系统设置，默认 36月 × 2000张/月
auto_sell_c         = ceil( total_c × 10000 ÷ (10000 − min_margin_bp) )
                      // ceil：自动地板价永不击穿最低毛利
报价 = Combo.sell_c[size] 存在 ? 取手动价 : auto_sell_c
       手动价允许低于地板价（引流价/市场价，如黑白 ¥0.07）——
       管理域对低于 min_margin 的手动价显示警告、亏本价标红，但不篡改；
       force_min_margin 设置开启时才将手动价抬升至地板价（默认关闭，
       与现行计算器"强制覆盖"开关行为一致）。统一定价开关同迁系统设置。
```

**可选性规则（替换 F 节表述）**：配置器中组合可选 ⇔
`Combo 存在 ∧ size.area ≤ mode.max_size.area ∧ PaperSizeCost 存在`。
duplex 不再是独立参数——它编码在 PrintMode 里，天然消失。

**数据勘误（已确认）**：C850 设备成本 = **20600**（不含备品碳粉）；
v1.0 §9 的 22000 = 20600 + 备用 T01 一套（1400）。处理：equipment_cost_c
取 2060000，备用碳粉归入 Consumable 初始库存（quantity=1），不得混入
设备投入——否则折旧摊薄虚高。

⚠️ 本节同步影响：§8 calculator API 端点改为
`/api/calculator/{sizes,modes,papers,combos,quote}`，
管理域对四张表全量 CRUD（即现有"参数设置"tab 的 API 化）。

---

## D. 通知抽象层（执行 D6，新增章节）

```
Notifier 接口（Phase 2 实现 email adapter，其余渠道后续可插拔）:

  interface NotificationChannel {
    id:    string                    // "email" | "line" | "sms-xxx"
    send(to: Address, msg: RenderedMessage): Promise<Result>
  }

  NotificationLog {
    id          UUID
    event       enum     order_confirmed | order_ready | quote_expiring | ...
    channel     string
    recipient   string
    status      enum     sent | failed | skipped
    sent_at     datetime
    error       string | null
  }

  User 增加:
    notify_channels   [string]    // 用户订阅的渠道，默认 ["email"]
    notify_addresses  map         // { email: "...", line_user_id: "..." }
```

模板与渠道解耦：事件 → 渲染模板 → 逐渠道分发。回头要接短信平台或 LINE，写一个 adapter + 配置即可，业务代码零改动。

> ⚠️ v1.0 Phase 2 写的 **LINE Notify 已于 2025-03 停止服务**，全文替换为
> "LINE Messaging API（官方账号）"，且降级为后续可选 adapter，不在 Phase 2。

---

## E. 安全章节（v1.0 缺失，新增）

customer 自助下单 = 201 服务器暴露公网，最低要求：

```
[必须] 反向代理 (Caddy/nginx) + TLS，API 不裸奔
[必须] JWT: access 2h + refresh 14d；refresh 可吊销（DB 黑名单即可）
[必须] 速率限制: /api/auth/* 与 /api/calculator/quote 按 IP 限流
       （防爬价目表、防注册轰炸）
[必须] 下单域开放注册 + 邮箱验证；邀请码仅作可选开关，默认关闭
[必须] admin 账号不可自注册，只能由既有 admin 在管理域添加
[必须] 订单查询走 access_token（见 C4），禁止顺序号枚举
[必须] 文件上传: 类型白名单 + 大小上限 + 存储隔离（不可执行目录）
[建议] 管理域路由额外限制来源 IP 段（家庭内网 / VPN）
```

**SQLite 备份姿势修正**（修改 v1.0 §4 架构图注记）：

> WAL 模式下直接 `cp folioria.db` 会得到不一致快照。备份必须用
> `VACUUM INTO '/nas/backup/folioria-{date}.db'` 或 sqlite3 `.backup`
> 命令。建议 systemd timer 每日一次 + 保留 30 份滚动。
> **上线前做一次恢复演练**——没验证过的备份等于没有备份。

---

## F. 报价器联动约束（修改 v1.0 §6.2 自助报价）

```
规则: 无对应 CostRule 的 (process × paper × size × duplex) 组合
      在配置器中不可选。CostRule 表本身就是兼容矩阵。

推论: duplex 对艺术微喷等工艺自然消失（不建 duplex=true 的 rule 即可）
      客户永远选不出报不了价的组合，无需额外的兼容性配置表。
```

---

## G. Phase 划分调整（修改 v1.0 §4.2）

```diff
Phase 1 · MVP
-  [必须] 用户系统（admin/member 两个角色先行）
+  [必须] 用户系统（管理域）：
+         · 初始化向导（spool init）：选择实例基准货币（JPY/CNY/USD，
+           产生业务数据后锁定）+ 创建初始 admin（首次登录强制改密）
+         · 后续 admin 由既有 admin 在 /admin/users 手动添加，不写死账号
+         · 下单域开放注册随 Phase 2 一并上
+  [必须] InventoryLog convert 动作 + 裁切转换录入
+  [必须] Job.waste_quantity + done 时实扣逻辑
+  [必须] 预占用动态计算展示
+  [必须] 软删除 + Alert 去重
   （其余不变）

Phase 2 · 订单系统
-  [计划] 订单状态通知（LINE Notify / 邮件）
+  [计划] Notifier 抽象层 + email adapter
+  [计划] 文件上传 + 审稿状态流（file_pending → approved）
+  [计划] 支付状态记录（payment_status / 定金）
+  [计划] 报价有效期 + access_token 查询
+  [计划] 安全基线（TLS / 限流 / 邮箱验证）
   （其余不变）

Phase 3 · 智能化
-  [未来] 打印机 SNMP 读取
+  [未来] 打印机 SNMP 读取（含碳粉余量自动校正 current_usage）
+  [未来] LINE Messaging API / 短信 adapter（按需）
+  [未来] 文件自动预检（出血/分辨率/色彩空间）
   （其余不变）
```

---

## H. 不动的部分（明确点名，免得误改）

- OrderItem 快照 `unit_price` 而非实时引用 CostRule —— v1.0 这个设计是**对的**，保留。改价不影响已报价订单，配合 C4 的报价有效期形成闭环。
- 技术选型（Fastify + SQLite WAL + React/Vite/Tailwind）全部保留，规模匹配。
- UI 设计语言（§6.1）不动，深林绿配暖金挺好的。
- commit 惯例（§10）不动。

---

```
S.P.O.O.L. PRD v1.1 Revision
Status: 待璃奈确认合并 → 合并后升级为 PRD v1.1

Reviewed-by: 202 全员决策（六问六答）
Co-authored-by: Claude
```
