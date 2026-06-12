#!/usr/bin/env bash
# 调试实例:用户级每日备份 timer(VACUUM INTO → ~/.local/share/spool/backups,滚动 30 份)
# PRD E 节:禁止直接 cp;backup 命令自带 verify-backup,失败时 exit 1
set -euo pipefail

mkdir -p ~/.config/systemd/user ~/.local/share/spool/backups

cat > ~/.config/systemd/user/spool-backup.service <<'EOF'
[Unit]
Description=S.P.O.O.L. SQLite backup (VACUUM INTO, keep 30)

[Service]
Type=oneshot
Environment=PATH=/home/neko/.local/node24/bin:/usr/bin:/bin
WorkingDirectory=/home/neko/code/folioria-spool/server
ExecStart=/home/neko/code/folioria-spool/server/node_modules/.bin/tsx src/cli.ts backup --db /home/neko/.local/share/spool/folioria.db --dest /home/neko/.local/share/spool/backups --keep 30
EOF

cat > ~/.config/systemd/user/spool-backup.timer <<'EOF'
[Unit]
Description=Daily S.P.O.O.L. backup timer

[Timer]
OnCalendar=*-*-* 04:30:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now spool-backup.timer
systemctl --user start spool-backup.service   # 立即跑一次验证全链路
systemctl --user list-timers spool-backup.timer --no-pager
ls -lh ~/.local/share/spool/backups/
