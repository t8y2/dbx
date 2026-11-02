#!/usr/bin/env bash
set -euo pipefail
# Run in a managed background job. EXIT/INT/TERM stop only this invocation's children.
module_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
repo_root=$(cd "$module_dir/../../.." && pwd)
fixture="$repo_root/tmp/rocketmq-proxy-fixture"
java_home="${JAVA_HOME:-}"
maven="${MAVEN:-mvn}"
mode="${1:-run}"
if [[ -z "$java_home" && -x /usr/libexec/java_home ]]; then
  java_home=$(/usr/libexec/java_home -v '17+' 2>/dev/null || true)
fi
if [[ -n "$java_home" ]]; then
  java_bin="$java_home/bin/java"
else
  java_bin=$(command -v java || true)
fi
if [[ -z "$java_bin" || ! -x "$java_bin" ]]; then
  echo "Java 17+ is required; set JAVA_HOME or put java on PATH." >&2
  exit 1
fi
java_version=$("$java_bin" -version 2>&1)
java_major=$(printf '%s\n' "$java_version" | sed -nE 's/.*version "([0-9]+).*/\1/p' | head -1)
if [[ ! "$java_major" =~ ^[0-9]+$ ]] || (( java_major < 17 )); then
  echo "Java 17+ is required; detected: $java_version" >&2
  exit 1
fi
mkdir -p "$fixture/conf" "$fixture/lib" "$fixture/store" "$fixture/logs"
if ! mkdir "$fixture/run.lock" 2>/dev/null; then
  echo "Fixture lock exists: $fixture/run.lock; inspect recorded PIDs before removing a stale lock." >&2
  exit 1
fi
children=()
cleanup() {
  trap - EXIT INT TERM
  for pid in "${children[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; fi
  done
  for pid in "${children[@]}"; do wait "$pid" 2>/dev/null || true; done
  # Exact fixed fixture path; preserve configs, data and logs for diagnosis.
  rmdir "$fixture/run.lock"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for port in 19876 20909 20911 20912 18080 18081; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Refusing to start: TCP $port is already occupied; no existing process was stopped." >&2
    exit 1
  fi
done
cat >"$fixture/pom.xml" <<'XML'
<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>com.dbx.test</groupId><artifactId>rocketmq-proxy-fixture</artifactId><version>1.0</version><dependencies><dependency><groupId>org.apache.rocketmq</groupId><artifactId>rocketmq-namesrv</artifactId><version>5.3.2</version></dependency><dependency><groupId>org.apache.rocketmq</groupId><artifactId>rocketmq-broker</artifactId><version>5.3.2</version></dependency><dependency><groupId>org.apache.rocketmq</groupId><artifactId>rocketmq-proxy</artifactId><version>5.3.2</version></dependency></dependencies></project>
XML
if [[ "$mode" != "run-cached" ]]; then
  JAVA_HOME="$java_home" "$maven" -B -f "$fixture/pom.xml" dependency:copy-dependencies -DoutputDirectory="$fixture/lib"
fi
for component in namesrv broker proxy; do
cat >"$fixture/conf/logback_${component}.xml" <<'XML'
<configuration><appender name="STDOUT" class="ch.qos.logback.core.ConsoleAppender"><encoder><pattern>%date %-5level %logger - %msg%n</pattern></encoder></appender><root level="INFO"><appender-ref ref="STDOUT"/></root></configuration>
XML
done
cat >"$fixture/namesrv.conf" <<'CONF'
listenPort=19876
CONF
cat >"$fixture/broker.conf" <<CONF
brokerClusterName=DefaultCluster
brokerName=dbx-proxy-fixture
brokerId=0
brokerIP1=127.0.0.1
namesrvAddr=127.0.0.1:19876
listenPort=20911
haListenPort=20912
autoCreateTopicEnable=true
autoCreateSubscriptionGroup=true
brokerRole=ASYNC_MASTER
flushDiskType=ASYNC_FLUSH
storePathRootDir=$fixture/store
storePathCommitLog=$fixture/store/commitlog
mappedFileSizeCommitLog=16777216
diskMaxUsedSpaceRatio=95
CONF
cat >"$fixture/proxy.json" <<'JSON'
{"rocketMQClusterName":"DefaultCluster","namesrvAddr":"127.0.0.1:19876","proxyMode":"CLUSTER","grpcServerPort":18081,"remotingListenPort":18080,"localServeAddr":"127.0.0.1","remotingAccessAddr":"127.0.0.1"}
JSON
jvm=(-Xms128m -Xmx256m --add-exports=java.base/jdk.internal.ref=ALL-UNNAMED --add-opens=java.base/java.nio=ALL-UNNAMED --add-opens=java.base/sun.nio.ch=ALL-UNNAMED -Drocketmq.home.dir="$fixture" -Duser.home="$fixture" -cp "$fixture/lib/*")
printf 'supervisor=%s\n' "$$" >"$fixture/pids.env"
"$java_bin" "${jvm[@]}" org.apache.rocketmq.namesrv.NamesrvStartup -c "$fixture/namesrv.conf" >"$fixture/namesrv.stdout.log" 2>&1 &
children+=("$!")
printf 'namesrv=%s\n' "$!" >>"$fixture/pids.env"
"$java_bin" "${jvm[@]}" org.apache.rocketmq.broker.BrokerStartup -c "$fixture/broker.conf" >"$fixture/broker.stdout.log" 2>&1 &
children+=("$!")
printf 'broker=%s\n' "$!" >>"$fixture/pids.env"
# Proxy startup creates cluster system topics and requires a registered broker.
registered=false
for attempt in {1..120}; do
  for pid in "${children[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then echo "Fixture child $pid exited before registration" >&2; exit 1; fi
  done
  if "$java_bin" "${jvm[@]}" org.apache.rocketmq.tools.command.MQAdminStartup clusterList -n 127.0.0.1:19876 >"$fixture/cluster.stdout.log" 2>&1 && grep -q 'dbx-proxy-fixture' "$fixture/cluster.stdout.log"; then
    registered=true
    break
  fi
  sleep 1
done
if [[ "$registered" != true ]]; then echo "Broker registration timeout; inspect cluster.stdout.log" >&2; exit 1; fi
"$java_bin" "${jvm[@]}" org.apache.rocketmq.proxy.ProxyStartup -pc "$fixture/proxy.json" >"$fixture/proxy.stdout.log" 2>&1 &
children+=("$!")
printf 'proxy=%s\n' "$!" >>"$fixture/pids.env"
for attempt in {1..120}; do
  for pid in "${children[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Fixture process $pid exited; inspect $fixture/*.stdout.log" >&2
      exit 1
    fi
  done
  ready=true
  for port in 19876 20911 18080 18081; do
    if ! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then ready=false; fi
  done
  if [[ "$ready" == true ]]; then
    printf 'READY namesrv=127.0.0.1:19876 broker=127.0.0.1:20911 proxy_grpc=127.0.0.1:18081 proxy_remoting=127.0.0.1:18080 supervisor=%s\n' "$$"
    printf 'Cleanup: kill -TERM %s (or cancel managed background job); trap stops recorded children.\n' "$$"
    break
  fi
  if [[ "$attempt" == 120 ]]; then echo "Fixture readiness timeout" >&2; exit 1; fi
  sleep 1
done
# These admin calls are fixture setup, not part of the proxy-only client test.
"$java_bin" "${jvm[@]}" org.apache.rocketmq.tools.command.MQAdminStartup updateTopic -n 127.0.0.1:19876 -b 127.0.0.1:20911 -t DBX_PROXY_TEST -a +message.type=NORMAL >"$fixture/topic.stdout.log" 2>&1
printf 'TOPIC_READY DBX_PROXY_TEST\n'
# Poll only our children so any service failure tears down the fixture.
while true; do
  for pid in "${children[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then echo "Fixture child $pid exited" >&2; exit 1; fi
  done
  sleep 2
done
