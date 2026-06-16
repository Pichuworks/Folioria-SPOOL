# S.P.O.O.L. 设计规范 · docs/design-guide.md

> Asagaya modern（杂志/规格书）× 秋枫配色 — 枫光映刻

## 排版层级

| 层级 | 用途 | 字号 | 字重 | tracking | 色 | 示例 |
|---|---|---|---|---|---|---|
| H1 刊头 | 品牌标题 | 44px | bold | .14em | ink | 枫光映刻 |
| H2 节标题 | MagSec 主标题 | 26px | semibold | .06em | ink | 纸张库存 / 价目管理 |
| H3 Modal 标题 | Modal header | 20px | semibold | — | ink | 编辑纸张 |
| Sub-heading | 分组/行标题 | 14px | medium | .04em | ink | 打印纸70g / QUEUED |
| Body | 正文 | 13–15px | normal | — | ink | SpecRow label |
| Field label | 表单标签 | 12px | normal | .06em | dim | 纸张 / 数量 |
| Mono label | 机器标签/标记 | 10–11px | normal | .08–.22em | dim/paper | NEW STOCK FILE / EXTERNAL |
| Data mono | 数值/计数 | 10–13px | normal | .05–.1em | ink/dim | 200 张 / 3/50P |

## 色彩

定义于 `web/src/index.css` @theme 块。

| token | hex | 语义 |
|---|---|---|
| paper | #f8f4ee | 页面底色（暖象牙） |
| card | #fefcf8 | 卡片底色（暖白） |
| deep | #ebe3d5 | 禁用/骨架底色（暖砂） |
| line | #d0c2a7 | 分隔线（永远 1px） |
| ink | #3d1e10 | 主文字（铁胆墨） |
| dim | #6a4e30 | 次要文字（暖褐） |
| wine | #b84520 | 主强调（秋枫） |
| wine-ink | #873212 | 强调文字/链接（深锈） |
| wine-dim | #f2ddc8 | 强调淡底（蜜桃） |
| gold | #c89018 | 辅助强调（琥珀） |
| cream | #fce8c8 | 按钮文字（金奶） |
| warn | #a85e15 | 警告（谨慎使用） |

## 字体

| token | 用途 |
|---|---|
| serif | 正文（Noto Serif SC/JP） |
| garamond | 西文装饰（EB Garamond） |
| script | 副标题（IM Fell English） |
| mono | 数据/标签（SF Mono, Menlo） |

## 组件约定

- **MagSec**: 节容器，`pt-13` 上间距，`border-b border-ink pb-3` 底线。可选 tag（墨底反白 mono 标签）、note（右对齐 mono 小字）。
- **TabBar**: 节内分 tab，`border-b border-line`，active = `border-wine text-wine-ink`。带可选 count badge。
- **Modal**: 固定 z-50，`border border-ink bg-paper shadow-e1`。标题 H3 + 底线。
- **Field**: `label + children`，标签 12px dim tracking-[.06em]。
- **PillBtn / PillLink**: 圆角按钮，`tracking-[.02em]`。primary = wine 底 cream 字；ghost = 透明底 wine-ink 字。
- **SpecRow**: 规格行，label + Leader + value。
- **Leader**: 弹性点线填充。
- **分隔**: 主分隔 `border-ink`；次分隔 `border-line`。
