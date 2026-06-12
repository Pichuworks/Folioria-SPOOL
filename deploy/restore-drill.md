# 恢复演练（上线前必做，之后每季度一次）

> ⚠️ 永远不要 `cp folioria.db`（WAL 模式下得到不一致快照）。备份只认 `VACUUM INTO` 产物。

```bash
# 1. 取最新备份做完整性验证（integrity_check / foreign_key_check / user_version）
pnpm --filter @spool/server run cli verify-backup --file /mnt/nas/spool-backups/folioria-<最新>.db

# 2. 用备份起一个演练实例（不要碰生产库文件）
SPOOL_DB=/tmp/drill.db
cp /mnt/nas/spool-backups/folioria-<最新>.db $SPOOL_DB   # 备份文件本身无 WAL，可直接复制
SPOOL_DB=$SPOOL_DB PORT=3999 pnpm --filter @spool/server run dev

# 3. 验收点（人工）
#    - admin 登录成功
#    - /api/dashboard 数字与生产对得上
#    - /api/calculator/options 报 187 个组合（seed 基线）
#    - 抽查最近一笔 done 作业的成本快照

# 4. 演练完删除 /tmp/drill.db*
```

定时备份安装：

```bash
# 正式实例（系统级，PRD §4 的 201 服务器）
sudo cp deploy/spool-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now spool-backup.timer
systemctl list-timers spool-backup.timer

# 调试机（用户级，无免密 sudo；产物在 ~/.local/share/spool/backups）
bash deploy/remote-backup-setup.sh
```
