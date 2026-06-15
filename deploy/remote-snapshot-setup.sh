#!/usr/bin/env bash
# 调试实例:用户级月度报表快照 timer(每月 1 日 05:00 归档上月 → report_snapshots, 幂等 upsert)
# 缺省 --month = 上一个自然月; CLI snapshot-month 自带 migrate(确保表存在)
set -euo pipefail

mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/spool-snapshot.service <<'EOF'
[Unit]
Description=S.P.O.O.L. monthly report snapshot (archive previous month)

[Service]
Type=oneshot
Environment=PATH=/home/neko/.local/node24/bin:/usr/bin:/bin
WorkingDirectory=/home/neko/code/folioria-spool/server
ExecStart=/home/neko/code/folioria-spool/server/node_modules/.bin/tsx src/cli.ts snapshot-month --db /home/neko/.local/share/spool/folioria.db
EOF

cat > ~/.config/systemd/user/spool-snapshot.timer <<'EOF'
[Unit]
Description=Monthly S.P.O.O.L. report snapshot timer (1st of month, archives previous month)

[Timer]
OnCalendar=*-*-01 05:00:00
Persistent=true
RandomizedDelaySec=600

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now spool-snapshot.timer
systemctl --user start spool-snapshot.service   # 立即跑一次(归档上月)验证全链路
systemctl --user list-timers spool-snapshot.timer --no-pager
