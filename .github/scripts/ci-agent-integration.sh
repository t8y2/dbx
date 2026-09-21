#!/usr/bin/env bash
set -euo pipefail

scenario="${1:?scenario is required}"
version="${2:?version is required}"
image="${3:-}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

case "$scenario" in
  zookeeper)
    cd "$root/agents/drivers/zookeeper"
    name="dbx-zookeeper-${version//./-}"
    docker rm -fv "$name" >/dev/null 2>&1 || true
    docker run -d --name "$name" -p 2181:2181 "zookeeper:$version"
    cleanup() {
      docker rm -fv "$name" >/dev/null 2>&1 || true
    }
    trap cleanup EXIT
    ready=false
    for _ in $(seq 1 90); do
      if timeout 1 bash -c '</dev/tcp/127.0.0.1/2181' >/dev/null 2>&1; then
        ready=true
        break
      fi
      sleep 2
    done
    if [ "$ready" != true ]; then
      docker logs "$name"
      exit 1
    fi
    DBX_ZOOKEEPER_TEST_CONNECT_STRING=127.0.0.1:2181 \
      go test -run '^TestZooKeeperIntegration$' -count=1 ./...
    if [ "$version" = "3.7.0" ]; then
      DBX_ZOOKEEPER_TEST_CONNECT_STRING=127.0.0.1:2181 \
        go test -run '^TestZooKeeperLargeChildrenIntegration$' -count=1 ./...
    fi
    ;;
  zookeeper-sasl)
    cd "$root/agents/drivers/zookeeper"
    name="dbx-zookeeper-sasl-3-7-0"
    jaas_file=$(mktemp)
    cat > "$jaas_file" <<'EOF'
    Server {
      org.apache.zookeeper.server.auth.DigestLoginModule required
      user_dbx="dbx-secret";
    };
EOF
    chmod 0644 "$jaas_file"
    docker rm -fv "$name" >/dev/null 2>&1 || true
    docker run -d --name "$name" -p 2181:2181 \
      -v "$jaas_file:/conf/server-jaas.conf:ro" \
      -e ZOO_CFG_EXTRA="authProvider.1=org.apache.zookeeper.server.auth.SASLAuthenticationProvider" \
      -e JVMFLAGS="-Djava.security.auth.login.config=/conf/server-jaas.conf -Dzookeeper.sasl.serverconfig=Server -Dzookeeper.sessionRequireClientSASLAuth=true" \
      zookeeper:3.7.0
    cleanup() {
      docker rm -fv "$name" >/dev/null 2>&1 || true
    }
    trap cleanup EXIT
    ready=false
    for _ in $(seq 1 90); do
      if timeout 1 bash -c '</dev/tcp/127.0.0.1/2181' >/dev/null 2>&1; then
        ready=true
        break
      fi
      sleep 2
    done
    if [ "$ready" != true ]; then
      docker logs "$name"
      exit 1
    fi
    DBX_ZOOKEEPER_TEST_CONNECT_STRING=127.0.0.1:2181 \
      DBX_ZOOKEEPER_TEST_AUTH_SCHEME=sasl_digest \
      DBX_ZOOKEEPER_TEST_USERNAME=dbx \
      DBX_ZOOKEEPER_TEST_PASSWORD=dbx-secret \
      go test -run '^TestZooKeeperIntegration$' -count=1 ./...
    ;;
  rocketmq)
    cd "$root/agents/drivers/rocketmq"
    ./scripts/run-integration.sh "$version"
    ;;
  tdengine)
    cd "$root/agents"
    name="dbx-tdengine-${version//./-}"
    docker rm -fv "$name" >/dev/null 2>&1 || true
    docker run -d --name "$name" \
      --memory 4g \
      --ulimit nofile=65535:65535 \
      -p 6030:6030 \
      -p 6041:6041 \
      "$image"
    cleanup() {
      docker rm -fv "$name" >/dev/null 2>&1 || true
    }
    trap cleanup EXIT
    ready=false
    dnodes=""
    for _ in $(seq 1 90); do
      dnodes="$(docker exec "$name" taos -s 'SHOW DNODES' 2>/dev/null || true)"
      if grep -Eq '\|[[:space:]]*ready[[:space:]]*\|' <<<"$dnodes"; then
        ready=true
        break
      fi
      sleep 2
    done
    if [ "$ready" != "true" ]; then
      printf '%s\n' "$dnodes"
      docker logs "$name"
      exit 1
    fi
    TDENGINE_INTEGRATION=1 \
      TDENGINE_TEST_HOST=127.0.0.1 \
      TDENGINE_TEST_PORT=6041 \
      cargo nextest run --manifest-path drivers/tdengine/Cargo.toml --locked --test live --no-capture --no-fail-fast
    ;;
  cassandra)
    cd "$root/agents/drivers/cassandra-go"
    name="dbx-cassandra-${version//./-}"
    docker rm -fv "$name" >/dev/null 2>&1 || true
    docker run -d --name "$name" \
      -e CASSANDRA_CLUSTER_NAME="DBX Cassandra CI $version" \
      -e CASSANDRA_DC=dc1 \
      -e CASSANDRA_RACK=rack1 \
      -e CASSANDRA_ENDPOINT_SNITCH=GossipingPropertyFileSnitch \
      -e CASSANDRA_NUM_TOKENS=16 \
      -e MAX_HEAP_SIZE=512M \
      -e HEAP_NEWSIZE=100M \
      -p 9042:9042 \
      "cassandra:$version"
    cleanup() {
      docker rm -fv "$name" >/dev/null 2>&1 || true
    }
    trap cleanup EXIT
    ready=false
    for _ in $(seq 1 100); do
      if docker exec "$name" cqlsh -e 'SELECT release_version FROM system.local' >/dev/null 2>&1; then
        ready=true
        break
      fi
      sleep 3
    done
    if [ "$ready" != "true" ]; then
      docker logs "$name"
      exit 1
    fi
    CASSANDRA_TEST_HOST=127.0.0.1 \
      CASSANDRA_TEST_PORT=9042 \
      go test -run '^TestCassandraIntegration$' -count=1 ./...
    ;;
  rabbitmq)
    cd "$root/agents/drivers/rabbitmq"
    name="dbx-rabbitmq-${version//./-}"
    cookie="dbx-ci-${GITHUB_RUN_ID:-local}-${version//./-}"
    # RabbitMQ is disposable in CI. Keep its data on a fresh tmpfs
    # owned by the image's rabbitmq user so .erlang.cookie is readable.
    docker rm -fv "$name" >/dev/null 2>&1 || true
    docker run -d --name "$name" \
      --user 999:999 \
      --tmpfs /var/lib/rabbitmq:rw,exec,uid=999,gid=999,mode=700 \
      -e RABBITMQ_DEFAULT_USER=dbx \
      -e RABBITMQ_DEFAULT_PASS=dbx-password \
      -e RABBITMQ_ERLANG_COOKIE="$cookie" \
      -p 5672:5672 -p 15672:15672 \
      "rabbitmq:${version}-management"
    cleanup() {
      docker rm -fv "$name" >/dev/null 2>&1 || true
    }
    trap cleanup EXIT
    ready=false
    for _ in $(seq 1 60); do
      if docker exec "$name" rabbitmq-diagnostics -q check_running >/dev/null 2>&1 \
        && curl --fail --silent --noproxy '*' --user dbx:dbx-password \
          http://127.0.0.1:15672/api/overview >/dev/null; then
        ready=true
        break
      fi
      sleep 2
    done
    if [ "$ready" != "true" ]; then
      docker inspect "$name" --format 'image={{.Config.Image}} user={{.Config.User}} status={{.State.Status}} exit={{.State.ExitCode}}' || true
      docker logs "$name"
      exit 1
    fi
    RABBITMQ_INTEGRATION=1 \
      RABBITMQ_USERNAME=dbx \
      RABBITMQ_PASSWORD=dbx-password \
      go test -run '^TestRabbitMQIntegration$' -count=1 ./...
    ;;
  *)
    echo "Unknown integration scenario: $scenario" >&2
    exit 2
    ;;
esac
