#!/bin/sh
# 完整重置演示环境：销毁全部数据卷（含 dbx-web 的连接与历史、三台演示库），
# 重新拉起并触发首次播种。建议 cron 定时执行，例如每 15 分钟：
#   */15 * * * * cd /opt/dbx-demo && ./reset.sh >> /var/log/dbx-demo-reset.log 2>&1
set -e
cd "$(dirname "$0")"
docker compose down -v --remove-orphans
docker compose up -d --quiet-pull
echo "[demo] environment reset at $(date)"
