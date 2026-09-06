# Cassandra Agent benchmark

This benchmark compares the same DBX JSON-RPC operations through the native
Apache `cassandra-gocql-driver` Agent and the archived Cassandra JDBC Agent.
It measures process startup, connection creation, RSS, latency, throughput,
artifact size, and shutdown behavior.

Each connection sample uses a fresh Agent process so JDBC runtime pooling cannot
turn later samples into warm reconnects. Query workloads use one persistent,
already-connected process per candidate.

## Prepare the fixture

The default workload expects `dbx_native_test.all_types` with at least 100 rows
and an integer primary key named `id`. Override the SQL variables below when
using another schema.

## Build the native Agent

From `agents/`:

```bash
go build -o /tmp/dbx-cassandra-bench/cassandra-go ./drivers/cassandra-go
```

Keep an archived JDBC Agent JAR as the baseline. The production Cassandra
module publishes only the native executable.

## Run

```bash
GO_AGENT=/tmp/dbx-cassandra-bench/cassandra-go \
JDBC_AGENT_JAR=/tmp/dbx-cassandra-bench/dbx-agent-cassandra.jar \
CASSANDRA_HOST=127.0.0.1 \
CASSANDRA_PORT=9042 \
CASSANDRA_KEYSPACE=dbx_native_test \
python3 drivers/cassandra-go/bench/agent_compare.py \
  > /tmp/dbx-cassandra-bench/result.json
```

If Java is only available in a container, provide the full interactive command
as a JSON argv array so no shell is implied (pass `["sh", "-c", "..."]`
explicitly when you need shell features):

```bash
JDBC_AGENT_COMMAND='["docker","run","--rm","-i","--name","dbx-cassandra-jdbc-bench","-v","/tmp/dbx-cassandra-bench:/bench:ro","eclipse-temurin:21-jre","java","-jar","/bench/dbx-agent-cassandra.jar"]'
```

## Configuration

- `BENCH_CANDIDATES`: `go,jdbc` by default
- `BENCH_STARTUPS`: startup samples, default `10`
- `BENCH_CONNECTS`: connection samples, default `10`
- `BENCH_WARMUPS`: warmups before each workload, default `20`
- `CASSANDRA_USERNAME`, `CASSANDRA_PASSWORD`, `CASSANDRA_URL_PARAMS`
- `CASSANDRA_SSL`, `CASSANDRA_CA_CERT_PATH`, `CASSANDRA_CLIENT_CERT_PATH`, `CASSANDRA_CLIENT_KEY_PATH`
- `BENCH_SELECT_ONE_SQL`, `BENCH_DECODE_SQL`, `BENCH_PAGE_SQL`
- `BENCH_SELECT_ONE_COUNT`, `BENCH_DECODE_COUNT`, `BENCH_LIST_TABLES_COUNT`, `BENCH_PAGE_COUNT`

Run both candidates on the same host against the same Cassandra instance. Do
not compare a local native Agent with a remote JDBC Agent or change the query
shape between candidates.
