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
- [x] S5 print_modes POST/PATCH 捕获 FK 错误 → 409 unknown_printer_or_size（原 500）。server/src/pricing-routes.ts
- [x] S6 cookie `secure` 配置化（buildApp cookieSecure / env SPOOL_COOKIE_SECURE=0 仅限调试）
      + deploy/README.md 强调 TLS 前置（明文 HTTP 直连会登录静默失败）。

## P2 Phase 1.5 缺口（建议在订单系统前补齐；PRD §8 点名但未建）

- [x] F1 Settings API：`GET|PATCH /api/settings`（min_margin_bp / 折旧参数 / unify / force / quote_valid_days）。
      base_currency 无业务数据可改（orders/jobs/inventory_log 任一非空 → 409 locked）；
      min_margin_bp 上限 9999（10000 会让地板价除零）。server/src/settings-routes.ts
- [x] F2 Reports API：`GET /api/reports/{monthly,equipment-usage,paper-consumption}`（?month=YYYY-MM，
      缺省当月；monthly 内部消耗单列＝quoted_price IS NULL）。server/src/reports-routes.ts
- [x] F3 管理域 Web UI（最大一块，可拆多会话；API 全已就绪，下单域字段白名单已在序列化层）。
      按使用频率排：
      `/admin/jobs`（新建向导·实时成本预览·可用量提示）→
      `/admin/inventory`（纸张卡片 / 耗材寿命进度条 / 出入库时间线·含裁切录入）→
      `/admin/pricing`（四表 CRUD·毛利警示标色：below_margin 橙 / LOSS 红）→
      `/admin/equipment`（档案 + 维护日历 + 校准记录）→
      `/admin/users`（member 升格 / admin 添加）→ `/admin/settings` → `/admin/reports`。
  - [x] F3a `/admin/jobs`（2026-06-12）：#/admin/jobs 挂 AdminGate（登录门抽自 Dashboard，web/src/AdminGate.tsx）；
        新建向导（calculator options 联动 + /api/jobs/preview 实时成本 + §3.3 可用量提示）、
        台账按状态分组（成本/毛利快照管理域可见）、状态流 draft→queued→printing→done（废品/实耗面数录入）+cancel。
        服务端补 display 字段（jobs 列表 + preview est_total 走唯一舍入点，formatMoney 服务端格式化，测试先行）。
        本地临时库实测：账面48 + queued 20/10 → 可用 18 → cancel → 28 → done(废品3) → 库存 25，
        双日志/耗材+23/计数器+23/成本快照 ¥8/毛利 ¥6 全部与 §3.1–3.3 一致。
  - [x] F3b `/admin/inventory`（2026-06-12）：纸张库存按纸分卡、出入库面板（动作符号由服务端校验）、
        裁切成对录入（同纸异尺寸，实测 convert_group 共享）、耗材寿命进度条（remaining_bp，低于阈值标橙）、
        出入库时间线（动作筛选 + 目标解析）。App.tsx 改路由表统一挂全部管理视图。
  - [x] F3c `/admin/pricing`（2026-06-12）：报价总览按组合分组（187 基线实测吻合，below_margin 橙 25 / LOSS 红 4）、
        手动价/内部价编辑（PUT combo prices，留空=自动地板）、纸张+尺寸口径/模式/尺寸/组合四表 CRUD。
        服务端 quotes 端点补 display（测试先行，用例 A 0.74/2.25/0.9）。
  - [x] F3d `/admin/equipment`（2026-06-12）：设备卡（状态即点即改、成本 display、双触发校准间隔编辑）、
        维护时间线 + 落档表单；实测 C6 校准基线重置（@23P）与 §3.5 换装事务（备品-1/usage 清零/installed_at）。
  - [x] F3e `/admin/users`（2026-06-12）：名册（角色即点即改、归档/恢复）+ 添加账号（首登强制改密）；
        实测 S1 last_admin 守卫 409 提示。
  - [x] F3f `/admin/settings`（2026-06-12）：基准货币只读展示（锁定语义）+ 定价参数表单（PATCH 实测回显）。
  - [x] F3g `/admin/reports`（2026-06-12）：月份切换，月度损益（内外分列）/设备利用/纸张消耗三段；
        实测与当月作业数据逐项吻合（¥14/¥8/¥6 · C850 23P · 纸耗 23 张含废 3）。
        —— F3 全部七个视图完成，F3 整项闭合。

## P3 Phase 2 订单系统（PRD 排期 2–4 周；acceptance §5/§6 订单项 = 验收基准）
> R1–R8 于 2026-06-13 整段完成（commit c733e03…）：测试先行（§5/§6 全绿，全套 257 个），
> 本地临时库全链路实测：注册→邮箱验证→#/quote 两行下单→上传→驳回（意见落 item）→重传→
> 复审→confirm 自动建 2 Job→printing→done 落账（库存 −203/−100、C850 +303P、毛利与 §2.3 推导一致）
> →ready→delivered+收款¥104；反例：过期 confirm 409 quote_expired、错 token/order_number 作 token 404、
> member 内部价 ¥0.05 下单 is_internal=1（customer 同组合仍 ¥0.07）。决策留痕 prd.md 附录 A D12–D16。

- [x] R1 订单全状态流 quoted→file_pending→file_approved→confirmed→in_production→ready→delivered（+cancelled）← §5
      file_pending/file_approved 仅系统自动流转（D13）；confirm 建 Job 见 D14。server/src/orders.ts
- [x] R2 access_token 防枚举查询 `/order/:token`；顺序 order_number 不可用于查询接口 ← §5/§6
      GET /api/orders/by-token/:token（错 token 404，不泄露存在性）；他人订单 id 同样 404。
- [x] R3 unit_price_c 下单定格快照（改价不影响既有单）；discount 非整数/负数超 subtotal → 422 ← §5
      member/admin 下单取 internal_sell_c 口径并置 is_internal（B1.1）；subtotal 整数加法。
- [x] R4 下单域开放注册 + 邮箱验证（邀请码开关默认关）← PRD D10
      0003 migration：email_verification_tokens + registration_open/invite_code；
      未验证可登录但下单 403 email_unverified；注册不置 must_change_password（D11 仅 admin 供给）。
- [x] R5 文件上传：order_item 级，类型白名单 / ≤200MB / 不可执行目录隔离存储 + 人工审稿 file_status
      扩展+magic bytes 双查；randomUUID 存储名（原名不落盘）；下载限 owner/admin + attachment+nosniff；
      重传重置 pending 清驳回意见。server/src/files-routes.ts
- [x] R6 支付状态记录（unpaid/deposit/paid）+ 报价有效期闭环（过期 quoted → confirm 拒绝 409）← §5
      PATCH /api/orders/:id/payment · /discount；quote_valid_until = created + quote_valid_days。
- [x] R7 Notifier 抽象层 + email adapter（Resend HTTP API；无 key → skipped 落 notification_log 不阻塞）
      事件：email_verification / order_file_pending(→admin) / order_confirmed / order_ready(→customer)。
      server/src/notify.ts ← SPF/DKIM 就绪后设 SPOOL_RESEND_API_KEY/SPOOL_MAIL_FROM 即升级实发
- [x] R8 下单域门面：`/quote` 公开配置器+购物车（提交即下单，CustomerGate 登录/注册门）·
      `/price-list` 公开价目表 · `/order/:token` 公开查询+owner 上传 · `/my/orders` · `/verify/:token`；
      `#/calculator` 跳转 `#/quote`；导航三态（guest/下单用户/admin，公开导航不罗列管理链接）；
      管理域 `#/admin/orders` 六列看板（审稿/confirm 建 job/状态推进/收款/折扣）。
  - [x] `/` 首页（2026-06-12）：视觉方案 = Asagaya 设计系统 modern·杂志版式 × eri 配色
        （酒红 #800020 / 金 #D9A11E / 暖纸底，Noto Serif SC + EB Garamond，无渐变·1px 墨线）。
        web/src/Home.tsx；#/ 缺省路由，Calculator 挪 #/calculator；价目区实时取
        /api/calculator/options 起价，API 不可达时优雅降级。

## P4 Phase 3 远期（PRD 立项，不急）

- 环境传感器 MQTT → location 湿度自动预警 · 打印机 SNMP → 出纸计数/碳粉余量自动校正
- 文件自动预检（出血/分辨率/色彩空间）· 月度报表自动生成 · LINE Messaging API / 短信 adapter · Fiery 热文件夹

---

## 建议执行顺序
O2 备份 timer（数据安全优先）→ S1–S6 安全加固（一会话扫完）→
F1 Settings → F2 Reports → F3 管理域 UI（多会话）→ R1… 订单系统。
