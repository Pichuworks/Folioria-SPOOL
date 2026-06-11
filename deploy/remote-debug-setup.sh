#!/usr/bin/env bash
# 调试实例:systemd 用户服务(localhost-only,经 SSH 隧道访问)
set -euo pipefail

pkill -f "vite.js preview" 2>/dev/null || true
pkill -f "tsx src/serve.ts" 2>/dev/null || true
sleep 1

loginctl enable-linger neko || echo "WARN: enable-linger failed (服务将随登录会话退出)"
loginctl show-user neko -p Linger

mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/spool-api.service <<'EOF'
[Unit]
Description=S.P.O.O.L. API (Fastify, localhost:3000)
After=network.target

[Service]
Environment=PATH=/home/neko/.local/node24/bin:/usr/bin:/bin
Environment=SPOOL_DB=/home/neko/.local/share/spool/folioria.db
Environment=PORT=3000
WorkingDirectory=/home/neko/code/folioria-spool/server
ExecStart=/home/neko/code/folioria-spool/server/node_modules/.bin/tsx src/serve.ts
Restart=on-failure

[Install]
WantedBy=default.target
EOF

cat > ~/.config/systemd/user/spool-web.service <<'EOF'
[Unit]
Description=S.P.O.O.L. web (vite preview + /api proxy, localhost:5173)
After=spool-api.service

[Service]
Environment=PATH=/home/neko/.local/node24/bin:/usr/bin:/bin
WorkingDirectory=/home/neko/code/folioria-spool/web
ExecStart=/home/neko/code/folioria-spool/web/node_modules/.bin/vite preview --port 5173
Restart=on-failure

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now spool-api spool-web
sleep 3
systemctl --user --no-pager status spool-api spool-web | grep -E "spool-|Active"
ss -tln | grep -E ":(3000|5173)"
