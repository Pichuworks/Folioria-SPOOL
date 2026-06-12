#!/usr/bin/env bash
# CLI 管理的 Cloudflare Tunnel:spool.pichu.moe → localhost:5173(vite preview)
set -euo pipefail
CF=~/.local/bin/cloudflared

# 已存在同名 tunnel 则复用（脚本可重放）
if ! $CF tunnel list 2>/dev/null | grep -q '\bspool\b'; then
  $CF tunnel create spool
fi
UUID=$($CF tunnel list | awk '$2 == "spool" {print $1}' | head -1)
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
  - hostname: folioria.com
    service: http://localhost:5173
  - hostname: www.folioria.com
    service: http://localhost:5173
  - service: http_status:404
EOF

$CF tunnel route dns spool spool.pichu.moe || echo "route dns: 可能已存在，继续"
# ⚠️ cert.pem 按 zone 签发（pichu.moe），route dns 管不到 folioria.com zone，
#   跨 zone 会错误地拼成 folioria.com.pichu.moe。须在 CF 面板 folioria.com zone 手动建：
#   CNAME @   → $UUID.cfargotunnel.com （Proxied）
#   CNAME www → $UUID.cfargotunnel.com （Proxied）
echo "folioria.com zone 需手动 CNAME → $UUID.cfargotunnel.com（见上方注释）"

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
systemctl --user enable spool-tunnel
systemctl --user restart spool-tunnel   # ingress 变更须重启生效
sleep 5
systemctl --user is-active spool-api spool-web spool-tunnel
journalctl --user -u spool-tunnel -n 5 --no-pager | tail -5
