#!/usr/bin/env bash
set -euo pipefail

# The DBX RocketMQ agent under test is the Go binary in this directory. Maven
# only supplies disposable official RocketMQ NameServer/Broker server JARs.
version="${1:?RocketMQ version is required}"
module_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/dbx-rocketmq-${version}.XXXXXX")
namesrv_port="${ROCKETMQ_NAMESRV_PORT:-19876}"
broker_port="${ROCKETMQ_BROKER_PORT:-20911}"
store_root="${ROCKETMQ_STORE_ROOT:-${work_dir}/store}"
namesrv_pid=""
broker_pid=""

cleanup() {
  if [[ -n "$broker_pid" ]] && kill -0 "$broker_pid" 2>/dev/null; then
    kill "$broker_pid" 2>/dev/null || true
  fi
  if [[ -n "$namesrv_pid" ]] && kill -0 "$namesrv_pid" 2>/dev/null; then
    kill "$namesrv_pid" 2>/dev/null || true
  fi
  wait "$broker_pid" 2>/dev/null || true
  wait "$namesrv_pid" 2>/dev/null || true
  rm -rf "$work_dir"
}
trap cleanup EXIT

cat >"$work_dir/pom.xml" <<EOF
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.dbx.test</groupId>
  <artifactId>rocketmq-integration</artifactId>
  <version>1.0.0</version>
  <dependencies>
    <dependency>
      <groupId>org.apache.rocketmq</groupId>
      <artifactId>rocketmq-namesrv</artifactId>
      <version>${version}</version>
    </dependency>
    <dependency>
      <groupId>org.apache.rocketmq</groupId>
      <artifactId>rocketmq-broker</artifactId>
      <version>${version}</version>
    </dependency>
  </dependencies>
</project>
EOF

mvn -q -f "$work_dir/pom.xml" dependency:copy-dependencies -DoutputDirectory="$work_dir/lib"

mkdir -p "$work_dir/conf"
for component in namesrv broker; do
  cat >"$work_dir/conf/logback_${component}.xml" <<'EOF'
<configuration>
  <appender name="STDOUT" class="ch.qos.logback.core.ConsoleAppender">
    <encoder>
      <pattern>%date %-5level %logger - %msg%n</pattern>
    </encoder>
  </appender>
  <root level="INFO">
    <appender-ref ref="STDOUT" />
  </root>
</configuration>
EOF
done

cat >"$work_dir/namesrv.conf" <<EOF
listenPort=${namesrv_port}
EOF
cat >"$work_dir/broker.conf" <<EOF
brokerClusterName=DefaultCluster
brokerName=broker-a
brokerId=0
brokerIP1=127.0.0.1
namesrvAddr=127.0.0.1:${namesrv_port}
listenPort=${broker_port}
haListenPort=$((broker_port + 1))
autoCreateTopicEnable=true
autoCreateSubscriptionGroup=true
deleteWhen=04
fileReservedTime=1
brokerRole=ASYNC_MASTER
flushDiskType=ASYNC_FLUSH
storePathRootDir=${store_root}
storePathCommitLog=${store_root}/commitlog
maxMessageSize=4194304
diskMaxUsedSpaceRatio=95
EOF

java -Xms128m -Xmx128m -Xmn64m \
  -Drocketmq.home.dir="$work_dir" -Duser.home="$work_dir" \
  -cp "$work_dir/lib/*" org.apache.rocketmq.namesrv.NamesrvStartup -c "$work_dir/namesrv.conf" \
  >"$work_dir/namesrv.stdout.log" 2>&1 &
namesrv_pid=$!

java -Xms256m -Xmx256m -Xmn128m \
  --add-exports=java.base/jdk.internal.ref=ALL-UNNAMED \
  --add-opens=java.base/java.nio=ALL-UNNAMED \
  --add-opens=java.base/sun.nio.ch=ALL-UNNAMED \
  -Drocketmq.home.dir="$work_dir" -Duser.home="$work_dir" \
  -cp "$work_dir/lib/*" org.apache.rocketmq.broker.BrokerStartup -c "$work_dir/broker.conf" \
  >"$work_dir/broker.stdout.log" 2>&1 &
broker_pid=$!

for _ in $(seq 1 120); do
  if ! kill -0 "$namesrv_pid" 2>/dev/null; then
    cat "$work_dir/namesrv.stdout.log"
    exit 1
  fi
  if ! kill -0 "$broker_pid" 2>/dev/null; then
    cat "$work_dir/broker.stdout.log"
    exit 1
  fi
  if grep -Rqs "boot success" "$work_dir/logs" "$work_dir/broker.stdout.log" 2>/dev/null; then
    break
  fi
  sleep 1
done

if ! grep -Rqs "boot success" "$work_dir/logs" "$work_dir/broker.stdout.log" 2>/dev/null; then
  cat "$work_dir/namesrv.stdout.log"
  cat "$work_dir/broker.stdout.log"
  find "$work_dir/logs" -type f -maxdepth 3 -print -exec tail -80 {} \; 2>/dev/null || true
  exit 1
fi

ROCKETMQ_INTEGRATION=1 \
ROCKETMQ_VERSION="$version" \
ROCKETMQ_NAMESRV_ADDR="127.0.0.1:${namesrv_port}" \
go test -C "$module_dir" -run '^TestRocketMQIntegration$' -count=1 -v .
