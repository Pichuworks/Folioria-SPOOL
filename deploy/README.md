# 部署须知

## TLS 前置是硬要求

session cookie 默认带 `Secure` 属性：**API 前面必须有 TLS 终结**（Cloudflare Tunnel /
反向代理均可）。用明文 HTTP 直连访问时浏览器会丢弃 cookie，表现为**登录静默失败**
（接口 200 但后续请求全部 401）。

仅限本机明文调试可设 `SPOOL_COOKIE_SECURE=0` 关闭 Secure；生产/公网实例**禁止**设置。

## 历史 CNY 单价层复核

从 `user_version < 36` 升级的既有 CNY 实例会置 `pricing_needs_reentry=1`，在明确
口径前拒绝新订单。0019 不再切换币种或删除业务数据，0035 也不再自动将价格乘 100。

先查看受影响字段及最大值：

```bash
cd /opt/folioria-spool/server
pnpm run cli pricing-scale inspect --db /var/lib/spool/folioria.db
```

若所有 `_c` 值已经是“最小货币单位 x100”，只记录人工确认：

```bash
pnpm run cli pricing-scale mark-canonical --db /var/lib/spool/folioria.db --confirm
```

若确认仍是历史 `RMB x100` 口径，执行显式修复。命令会先 `VACUUM INTO` 备份并通过
integrity/FK 校验，之后才在单事务中将白名单价格字段乘 100：

```bash
pnpm run cli pricing-scale repair-cny \
  --db /var/lib/spool/folioria.db \
  --backup-dir /mnt/nas/spool-backups \
  --confirm
```

修复或确认后重新运行 `inspect`，输出必须为 `needs_review: false`。禁止直接修改
`pricing_needs_reentry`，否则不会留下审计记录。

## 文件索引

- `remote-debug-setup.sh` — 调试机用户级服务（spool-api / spool-web），可重放
- `remote-tunnel-setup.sh` — Cloudflare Tunnel（spool.pichu.moe + folioria.com/www）
- `remote-backup-setup.sh` — 调试机用户级每日备份 timer（VACUUM INTO，滚动 30 份）
- `spool-backup.{service,timer}` — 正式实例系统级备份模板（PRD §4 的 201 服务器用）
- `restore-drill.md` — 恢复演练流程（上线前必做，每季度一次）
