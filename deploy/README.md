# 部署须知

## TLS 前置是硬要求

session cookie 默认带 `Secure` 属性：**API 前面必须有 TLS 终结**（Cloudflare Tunnel /
反向代理均可）。用明文 HTTP 直连访问时浏览器会丢弃 cookie，表现为**登录静默失败**
（接口 200 但后续请求全部 401）。

仅限本机明文调试可设 `SPOOL_COOKIE_SECURE=0` 关闭 Secure；生产/公网实例**禁止**设置。

## 文件索引

- `remote-debug-setup.sh` — 调试机用户级服务（spool-api / spool-web），可重放
- `remote-tunnel-setup.sh` — Cloudflare Tunnel（spool.pichu.moe + folioria.com/www）
- `remote-backup-setup.sh` — 调试机用户级每日备份 timer（VACUUM INTO，滚动 30 份）
- `spool-backup.{service,timer}` — 正式实例系统级备份模板（PRD §4 的 201 服务器用）
- `restore-drill.md` — 恢复演练流程（上线前必做，每季度一次）
