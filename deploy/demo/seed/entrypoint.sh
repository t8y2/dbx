#!/bin/sh
# 演示容器入口：数据卷为空（首次启动或刚被 reset.sh 重置）时，先在一个
# 未对外发布的端口上以普通模式短暂启动 dbx-web，通过 /api/connection/save
# 写入预置连接，再以 DBX_DEMO_MODE 正式启动。播种端口 4555 不在 compose
# 中发布，演示模式封锁面对外不可达。
set -e

DATA_DIR="${DBX_DATA_DIR:-/app/data}"
SEED_PORT=4555

if [ ! -f "$DATA_DIR/dbx.db" ]; then
    echo "[demo] empty data dir: seeding demo connections"
    # 播种实例必须绕过演示封锁（否则 connection/save 会被拒），且只监听内部端口。
    DBX_PORT="$SEED_PORT" DBX_DISABLE_PASSWORD=1 DBX_DEMO_MODE=0 /usr/local/bin/dbx-web &
    SEED_PID=$!

    for _ in $(seq 1 120); do
        if curl -sf -o /dev/null "http://127.0.0.1:$SEED_PORT/api/version"; then
            break
        fi
        sleep 0.5
    done

    curl -sf -o /dev/null \
        -H 'Content-Type: application/json' \
        --data-binary @/seed/connections.json \
        "http://127.0.0.1:$SEED_PORT/api/connection/save"

    kill "$SEED_PID" 2>/dev/null || true
    for _ in $(seq 1 30); do
        kill -0 "$SEED_PID" 2>/dev/null || break
        sleep 0.5
    done
    kill -9 "$SEED_PID" 2>/dev/null || true
    echo "[demo] seeding complete"
fi

exec /usr/local/bin/dbx-web
