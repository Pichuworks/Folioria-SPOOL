# Phase 1 任务清单（依赖序 · 一项一会话）

- [x] T01 工程脚手架: pnpm workspace (server/web) · tsconfig strict · vitest · eslint
- [x] T02 金额模块: MoneyC/Money branded types · round_half_up · formatMoney
      ← 先把 acceptance.md §1 全部写成测试，再实现
- [x] T03 DB 层: better-sqlite3 接入 · migration runner · 执行 docs/schema.sql
- [x] T04 seed 导入: data/seed.json → DB（金额已是整数，禁止换算）· acceptance §2.5 基线测试
- [x] T05 定价推导: 成本/地板价/报价规则/可选性三条件 ← acceptance §2 全量
- [x] T06 spool init CLI: 选基准货币 + 初始 admin（首登强制改密）
- [x] T07 session auth: 注册关闭(Phase1) · 登录/登出 · 管理域守卫 ← acceptance §6
- [x] T08 定价四表 CRUD API + /calculator 页面（参数设置 tab API 化）
- [x] T09 纸张库存: papers/stocks/locations CRUD · 裁切转换 ← acceptance §3.4
- [x] T10 耗材: CRUD · 寿命进度条 · 换装事务 ← acceptance §3.5
- [x] T11 设备: 档案 · 维护事件 · 双触发校准 ← acceptance §4
- [x] T12 作业: 新建向导(实时成本预览·可用量提示) · done 落账事务 ← acceptance §3.1-3.3
- [x] T13 提醒: 阈值检查 · 去重 · resolve ← acceptance §4
- [x] T14 Dashboard 四宫格
- [x] T15 备份: VACUUM INTO systemd timer · 恢复演练脚本
- [x] R01 迁移安全: 0019/0035 无损化 · CNY 单价层显式复核/备份/幂等修复
- [x] R02 完整常用尺寸目录 · 报价开纸换算择低 · A5 书册选纸 · 自助报价双栏排版
