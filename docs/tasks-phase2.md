# Phase 2+ 任务清单（依赖序 · 一项一会话）

> 接 docs/tasks-phase1.md（T01–T15 全部完成）。新会话开工前先读：CLAUDE.md（铁律）、
> docs/prd.md（语义）、docs/acceptance.md（验收真值）、docs/schema.sql（表结构定稿）、
> memory/MEMORY.md（含部署拓扑 remote-debug-box）。
> 工作方式不变：acceptance 覆盖的先写测试再实现；每次改动跑 `npm run typecheck && npm test`；
> 做完勾 checkbox → commit → `git push`（origin）；涉及部署的另 `git push deploy main` 并按
> remote-debug-box 流程在盒上 pull/build/restart。禁改 schema.sql / acceptance.md / seed.json。

## 当前线上状态（2026-06-12）
- 调试实例公网可达：**https://spool.pichu.moe** 与 **https://www.folioria.com**（同一 Cloudflare Tunnel）。
- **正式主入口 = `www.folioria.com`**（对所有人可用，不被过滤，实测 200）。
- apex `folioria.com` 被本地网络链路 SNI 过滤（实测：同 IP 同 TCP，SNI=apex 握手被掐、SNI=www 放行）；
  服务端健康（远端 OpenSSL 访问 apex 返回 200，证书 SAN 含 apex，CF 边缘**无** 301）。
  ECH 已在 CF 端默认开启，开了浏览器「安全 DNS / DoH」的客户端可绕过过滤直达 apex。
- 三个 systemd 用户服务在跑：spool-api(127.0.0.1:3000) / spool-web(vite preview [::1]:5173) / spool-tunnel。
- 限流（auth 10/5min、quote 60/min，键取 CF-Connecting-IP）已上线并公网实测（commit a5dde21）。

---

## P0 上线运维收尾

- [x] O1 入口策略定稿：**www.folioria.com 为正式主入口**，对外宣传与书签一律用 www。
      apex 边缘 301 跳转**非必需、不再追求**——对被 SNI 过滤的客户端无意义（过滤在 TLS 握手阶段，
      拿不到 301），对开 ECH 的客户端 apex 本就直达。实测：远端 OpenSSL 直连 apex=200（边缘无 301）、www=200。
      若日后仍想给「能正常握手 apex 的外部访客」配裸域跳转，用 CF 边缘 Redirect Rule（需 zone API token）。
- [x] O2 调试机备份已上线（2026-06-12）：deploy/remote-backup-setup.sh 装**用户级** timer
      （每日 04:30 + Persistent，VACUUM INTO → `~/.local/share/spool/backups` 滚动 30 份）。
      盒上实测：手动触发产物 verify-backup ok（integrity ok / 0 FK / user_version 2）。
- [ ] O3 裸域 `pichu.moe` 占位：重定向到 github.com/Pichuworks，或 Cloudflare Pages 极简主页。
- [ ] O4（可延后）正式生产实例与调试实例分离：PRD §4 的 201 服务器 + systemd 系统级部署。

## P1 安全加固 backlog（全量对抗审查中裁决「属 Phase 2」的项；后台任务卡 task_bbca44b2）

- [x] S1 PATCH /api/admin/users/:id：禁止归档/降格**最后一个活跃 admin** → 409 last_admin（防实例永久失管）。server/src/app.ts
- [x] S2 登录恒时比对：对不存在的邮箱也跑一次 bcrypt（消除用户枚举的计时侧信道）。server/src/auth.ts verifyLogin
- [x] S3 admin 创建用户置 `must_change_password=1`（创建者知晓的初始密码不应永久有效）。server/src/app.ts
- [x] S4 convert 校验 from/to 同 `paper_id`（跨纸种「裁切」→ 422 cross_paper；D1 只允许同纸不同尺寸折算）。server/src/inventory-routes.ts
- [ ] S5 print_modes POST/PATCH 捕获 FK 错误 → 409/422（未知 printer_id/ref_size/max_size 现返回 500）。server/src/pricing-routes.ts
- [ ] S6 cookie `secure` 配置化 + 部署文档强调 TLS 前置（当前 Tunnel 下恒 HTTPS 故 OK，明文 HTTP 直连会登录静默失败）。

## P2 Phase 1.5 缺口（建议在订单系统前补齐；PRD §8 点名但未建）

- [ ] F1 Settings API：`GET|PATCH /api/settings`（min_margin_bp / 折旧参数 / unify / force / quote_valid_days）。
      现状只能直接改库。遵 schema system_config 单行表；base_currency 产生数据后锁定不可改。
- [ ] F2 Reports API：`GET /api/reports/{monthly,equipment-usage,paper-consumption}`（内部消耗单列）。
- [ ] F3 管理域 Web UI（最大一块，可拆多会话；API 全已就绪，下单域字段白名单已在序列化层）。
      按使用频率排：
      `/admin/jobs`（新建向导·实时成本预览·可用量提示）→
      `/admin/inventory`（纸张卡片 / 耗材寿命进度条 / 出入库时间线·含裁切录入）→
      `/admin/pricing`（四表 CRUD·毛利警示标色：below_margin 橙 / LOSS 红）→
      `/admin/equipment`（档案 + 维护日历 + 校准记录）→
      `/admin/users`（member 升格 / admin 添加）→ `/admin/settings` → `/admin/reports`。

## P3 Phase 2 订单系统（PRD 排期 2–4 周；acceptance §5/§6 订单项 = 验收基准）

- [ ] R1 订单全状态流 quoted→file_pending→file_approved→confirmed→in_production→ready→delivered（+cancelled）← §5
- [ ] R2 access_token 防枚举查询 `/order/:token`；顺序 order_number 不可用于查询接口 ← §5/§6
- [ ] R3 unit_price_c 下单定格快照（改价不影响既有单）；discount 非整数/负数超 subtotal → 422 ← §5
- [ ] R4 下单域开放注册 + 邮箱验证（邀请码开关默认关）← PRD D10
- [ ] R5 文件上传：order_item 级，类型白名单 / ≤200MB / 不可执行目录隔离存储 + 人工审稿 file_status
- [ ] R6 支付状态记录（unpaid/deposit/paid）+ 报价有效期闭环（过期 quoted → confirm 拒绝 409）← §5
- [ ] R7 Notifier 抽象层 + email adapter（Resend/SES 事务邮件商）
      ← 依赖 folioria.com 的 SPF/DKIM（域名已接好）；LINE Notify 已停服，文档不得引用
- [ ] R8 下单域门面：`/` 首页 · `/quote` 公开配置器 · `/price-list` 价目表 · `/my/orders`

## P4 Phase 3 远期（PRD 立项，不急）

- 环境传感器 MQTT → location 湿度自动预警 · 打印机 SNMP → 出纸计数/碳粉余量自动校正
- 文件自动预检（出血/分辨率/色彩空间）· 月度报表自动生成 · LINE Messaging API / 短信 adapter · Fiery 热文件夹

---

## 建议执行顺序
O2 备份 timer（数据安全优先）→ S1–S6 安全加固（一会话扫完）→
F1 Settings → F2 Reports → F3 管理域 UI（多会话）→ R1… 订单系统。
