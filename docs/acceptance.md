# S.P.O.O.L. 验收用例 · docs/acceptance.md

> 给 Claude Code：开工第一个任务是把本文件全部用例写成自动化测试（vitest），
> **测试先行，实现随后**。本文数字已在 schema.sql + seed.json 上人工回归验证过，
> 是基准真值——实现与测试冲突时，错的是实现。

货币上下文：§1 金额工具函数沿用 JPY 通用向量（decimal_places=0）；
§2 seed 定价基线使用 CNY（decimal_places=2）。
CNY 下 `_c` = 分×100，因此 `1 RMB = 10000_c`；金额层 = 整数分。

---

## 1. 金额工具函数

### 1.1 round_half_up（唯一指定舍入函数）

| 输入 | 期望 |
|---|---|
| 23.31 | 23 |
| 23.5 | 24 |
| 2.5 | 3 |
| 0.4999 | 0 |
| 74.0 | 74 |

### 1.2 行小计（唯一舍入点）`line_total = round_half_up(unit_price_c × qty / 100)`

| unit_price_c | qty | line_total（円） |
|---|---|---|
| 7 | 200 | 14 |
| 7 | 333 | 23 |
| 5 | 50 | 3 |（250_c=2.5円 → half up → 3）
| 90 | 100 | 90 |
| 2500 | 7 | 175 |

### 1.3 subtotal 守恒

任意订单：`subtotal === items.map(line_total).reduce(+)`，整数加法，
**禁止**出现"对总额再舍入"的代码路径。

### 1.4 branded type 编译期隔离

`MoneyC + Money`、`Money 直接乘数量后当 Money 用` 等混算必须无法通过 tsc
（用 @ts-expect-error 用例固化）。

---

## 2. 定价推导（§2.3 公式，seed 数据基准）

### 2.1 成本推导

| 用例 | mode | paper | size | ink_c | paper_c | total_c |
|---|---|---|---|---|---|---|
| A | 6 C850彩图·单 | 6 哑光铜版纸 | A3 | 5571 | 1629 | 7200 |
| B | 1 C850黑白·单 | 1 亚太森博 A4 | A4 | 250 | 317 | 567 |
| C | 7 P708原装(set) | 11 RC艺术纸 | A3 | 227273 | 24635 | 251908 |
| D | 6 C850彩图·单 | 8 不干胶光面 | A4 | 2800 | 2883 | 5683 |

（C 验证 set 计价：eff=25000000_c；ml 计价用 mode 8 P708灌装：
eff=10000×1000=10000000_c。D40 口径：旧 `index.html` 表格里的 P708
低成本区间只对应灌装模式，不覆盖 P708 原装模式；C850 按 T01 CMYK
套装 14000000_c，G580/L15168 按墨水套装 2500000_c，seed 里已按保守产量摊销。）

### 2.2 自动地板价（ceil，永不击穿 67%）

| total_c | min_margin_bp | auto_sell_c |
|---|---|---|
| 7200 | 6700 | 21819 |
| 567 | 6700 | 1719 |
| 5683 | 6700 | 17222 |
| 251908 | 6700 | 763358 |

性质测试：对任意 total_c>0，`(auto_sell_c − total_c) / auto_sell_c ≥ 0.67`。

### 2.3 报价规则（D8 — 本表防翻案）

force_min_margin = **OFF**（默认）：

| 用例 | 手动价 | auto_c | 期望 sell_c | 期望标记 |
|---|---|---|---|---|
| 黑白×亚太森博 A4 | 700 | 1719 | **700**（￥0.07） | below_margin（橙） |
| 彩图×哑光铜版纸 A3 | 9000 | 21819 | **9000** | below_margin |
| P708原装×RC艺术纸 A3 | 250000 | 763358 | **250000** | LOSS（红，sell<total） |
| 黑白×金华盛 A4 | 无 | 2876 | 2876 | auto |

force_min_margin = ON：黑白×亚太森博 A4 → sell_c=1719，标记 forced。

⚠️ **手动价被静默抬升至地板价 = 严重 bug**（曾在评审中出现，全量回归否决）。

### 2.4 可选性三条件（任一不满足 → 配置器不可选 / quote 接口 404）

| 用例 | 缺的条件 |
|---|---|
| mode 9 G580(max=A4) × paper 1 @ A3 | 尺寸越界 |
| mode 6 × paper 7 A3++纸 @ A4 | 无 paper_size_cost（该纸无 A4 口径） |
| mode 14 × paper 10 | Combo 不存在 |

### 2.5 全量回归基线

seed 全量（70 combo × 7 size）：可报价组合 **60** 个；手动价 **13**
（LOSS **1** / below_margin **7**）；自动 **47**；sell_c 全部为正整数。
seed 或公式任何改动后此基线变化须人工确认。

---

## 3. 库存

### 3.1 done 落账（单事务）

打印 200 张 + 废品 3 张：paper_stock −203；inventory_log 两条
（consume −200, scrap −3，同 related_job）；在役 per_page 耗材**全部**
usage +203；printer.total_pages +203。事务中途失败 → 全部回滚，无半账。

### 3.2 cancelled 零动作

queued → cancelled：库存、日志、耗材、计数器全部无变化（断言前后快照相等）。

### 3.3 可用量动态计算

账面 48，两个 queued 作业计划 20+10 → available=18；
其一 cancelled → available=28（无任何表写入，纯查询变化）。

### 3.4 裁切转换守恒

A3+ −10 / A4 +20 成对日志同 convert_group；
对任意 convert_group：组内含 ≥2 条日志，且与录入换算系数一致（应用层校验录入时机）。
单条 convert 日志（无配对）→ 录入接口拒绝。

### 3.5 耗材换装

T01 换装：MaintenanceEvent(toner_change, final_usage=54200) 落档；
consumable.current_usage 清零、installed_at 更新、quantity 1→0；
全程单事务。

---

## 4. 提醒

- usage 越过阈值 → 创建 Alert；再次越过（19%→18%）→ **不**新建
  （数据库 uniq_alert_open 拒绝，应用层捕获为 no-op，severity 可原地升级）。
- resolve 后再次越界 → 新 Alert 创建成功。
- 校准双触发：页数超限或天数超限任一满足即触发；两者均 NULL 不触发。

## 5. 订单

- quote_valid_until 过期的 quoted 订单 → confirm 接口拒绝（409），其余状态不受影响。
- 顺序 order_number 不可用于查询接口；access_token 错误 → 404（不泄露存在性）。
- unit_price_c 下单后改动定价表 → 既有 order_item 金额不变。
- discount 传入非整数或负数超过 subtotal → 422。

## 6. 权限（双域）

- 下单域任意端点响应 JSON 深度遍历：不得出现 `cost`、`profit`、`margin` 字样的键
  （序列化白名单测试，遍历断言而非点名字段）。
- customer A 用 customer B 的订单 id/token → 404。
- member 调用管理域端点 → 403；admin 自注册通道不存在 → 404。

## 7. STRICT / 类型边界

- API 层：金额字段传 `1.5` / `"100"` → Fastify schema 422。
- DB 层：绕过 API 直插 REAL 金额 → STRICT 拒绝（开发期防呆）。
