# 设计稿 · ③⑤ 第二阶段:机器无关的客户产品层

> 状态:**待 K 君评审/拍板**。本稿只做设计,不改冻结文件(seed.json / acceptance.md)、
> 不落 migration、不猜业务语义。拿到下方「需拍板的决策」答复后,即可照本稿一次实现。
> 第一阶段(机器推荐 recommendMachines + 改派 PATCH /api/jobs/:id/mode)已上线(附录 A D24)。

## 0. 方向(K 君定调)

客户**选属性,不选机器**;系统据属性定机器。两类场景:

- **单页**:纸张类型 + 尺寸 + 是否双面 + 打印技术(激光/喷墨)+ 色彩档。
- **书(组合)**:封面材质 + 书本大小 + 内页材质 + 是否插图纸 + 工艺。

「有些能算,有些后台理算」——下面逐属性标注。

---

## 1. 单页属性配置器(小,基本在现有数据上)

### 1.1 客户属性 → 数据映射

| 客户选 | 映射 | 能算? |
|---|---|---|
| 纸张类型 | `paper_id` | ✅ 直接 |
| 尺寸 | `size_key` | ✅ 直接 |
| 是否双面 | `print_modes.duplex` | ✅ 直接 |
| 打印技术 激光/喷墨 | `printers.type`(laser/inkjet) | ✅ 直接 |
| **色彩档**(黑白/彩色/…) | **缺结构化字段**,藏在 mode 名 / `color_tag` | ❌ **后台理算** |

唯一缺口 = **色彩档**。`黑白/彩文/彩色/彩图` 自动归类会出错,须人工给每个 mode 打标。

### 1.2 解析与定价(Plan B 展示折叠,不动 stored 基线)

给定属性 `(paper, size, duplex, type, color_class)`:
1. 候选 mode = 满足 `m.printer.type=type ∧ m.duplex=duplex ∧ m.color_class=color ∧ deriveUnitCost(m,paper,size)≠null` 的全部 mode。
2. 对外价 = 候选里**最低 `sell_c`**(沿用现有 `combo_prices` 手填价;留空则地板价)。售价仍**手填、机器无关**(A 内核的展示等价形态)。
3. 下单绑**最便宜的候选 mode**(`order_items.mode_id`,保持 NOT NULL,避开整表重建);admin 用已上线的推荐/改派调整。
4. 落账成本仍按**实际印的那台**(与 D22 一致),min 仅作报价/选机参考。

> 关键:`combos`/`combo_prices` **一行不动** ⇒ acceptance §2.5 的 **stored** 基线 187/43/144 不变。

### 1.3 schema 改动(migration 0008 草案,additive)

```sql
ALTER TABLE print_modes ADD COLUMN color_class TEXT;  -- 'bw' | 'color' | 'photo' | ...(K 君定档)
```
- admin 在 `/admin/pricing` 模式表给现有 mode 勾选 color_class(后台理算)。
- seed.json 是否补 color_class:**需 K 君同意改冻结文件**;否则 demo 实例需 admin 手动标。

### 1.4 基线影响(需 K 君签字)

- stored 187/43/144 **不变**(combos 不动)。
- **客户可见目录**从「按 mode 列」折叠为「按属性组」——这是新的客户可见口径,数字我会先算给妳,签字后再写进新的 acceptance 断言(不删旧 stored 断言)。

---

## 2. 书 = 组合产品(新子系统,需独立设计)

一本书 = N 个单页作业(封面 / 内页 / 插图各一道)+ 装订/工艺。超出当前模型
(PRD 当初把 3D/UV 移出,见 D4)。草拟新表:

```
book_products(id, name, archived)                         -- 一种"书"产品
book_components(book_id, role['cover'|'inner'|'insert'],   -- 组件 = 一道单页规格
                paper_id, size_key, duplex, color_class, default_qty)
finishing_ops(id, name, pricing['per_book'|'per_page'], price_c)  -- 工艺(装订/烫金/…)
book_finishings(book_id, finishing_id)
```
- 定价 = Σ(各组件按 §1 单页推导) + Σ(工艺)。
- 落产时一本书 → 拆成多个 Job(每组件一道)+ 工艺记录。

### 待 K 君描述的开放问题
1. 「一本书」拆成哪几类组件?封面/内页/插图各算一道单页作业,对吗?
2. 工艺有哪些(装订方式/烫金/压纹/…)?各自怎么计价(按本/按页/按面积)?
3. 数量语义:印 50 本书 = 每组件 ×50?插图纸是整本固定张数还是按需?
4. 书的库存/排产:多组件作业如何编组、按哪台机器分别推荐?

---

## 3. 需 K 君拍板的决策

1. **色彩档**:分几档、各档名?哪个 mode 归哪档?(单页配置器的唯一人工映射)
2. **是否同意**为此改冻结的 seed.json(补 color_class)与 acceptance.md(新客户可见基线)——我会先把新数字算给妳。
3. **书子系统**:回答 §2 的四个开放问题(可另开会话慢慢来)。

## 4. 落地计划(拿到 1、2 即可启动单页)

- P1 单页(L):0008 加 color_class → admin CRUD 勾选 → `/api/calculator/options` 暴露属性维 → 重写 Quote 配置器为属性选择 + min 价 → 下单绑最便宜 mode(改派已就绪)→ 算并签新客户可见基线 → 改 acceptance。
- P2 书(XL,独立立项):待 §2 开放问题答复后设计 BOM + 工艺 + 多组件排产。
