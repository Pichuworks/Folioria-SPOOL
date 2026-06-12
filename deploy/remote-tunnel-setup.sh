#!/usr/bin/env bash
# CLI 管理的 Cloudflare Tunnel:spool.pichu.moe → localhost:5173(vite preview)
set -euo pipefail
CF=~/.local/bin/cloudflared

# 已存在同名 tunnel 则复用（脚本可重放）
if ! $CF tunnel list 2>/dev/null | grep -q '\bspool\b'; then
  $CF tunnel create spool
fi
UUID=$($CF tunnel list --output json | grep -o '"id":"[^"]*"[^}]*"name":"spool"' | head -1 | cut -d'"' -f4)
if [ -z "$UUID" ]; then
  # 退路：从凭证文件名取
  UUID=$(ls ~/.cloudflared/*.json | head -1 | xargs -n1 basename | sed 's/\.json//')
fi
echo "tunnel uuid: $UUID"

cat > ~/.cloudflared/config.yml <<EOF
tunnel: $UUID
credentials-file: /home/neko/.cloudflared/$UUID.json
ingress:
  - hostname: spool.pichu.moe
    service: http://localhost:5173
  - service: http_status:404
EOF

$CF tunnel route dns spool spool.pichu.moe || echo "route dns: 可能已存在，继续"

cat > ~/.config/systemd/user/spool-tunnel.service <<'EOF'
[Unit]
Description=Cloudflare Tunnel (spool.pichu.moe)
After=network-online.target spool-web.service

[Service]
ExecStart=/home/neko/.local/bin/cloudflared --no-autoupdate tunnel run spool
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now spool-tunnel
sleep 5
systemctl --user is-active spool-api spool-web spool-tunnel
journalctl --user -u spool-tunnel -n 5 --no-pager | tail -5
