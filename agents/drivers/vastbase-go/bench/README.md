# Vastbase Agent benchmark

This benchmark compares the same DBX JSON-RPC workload through:

- Vastbase JDBC `2.11v` (current DBX baseline)
- Vastbase JDBC `2.15v`
- openGauss Go connector `v1.0.8`

It keeps one physical database connection per Agent session and reports startup,
connection/authentication, steady-state latency, throughput, RSS, and artifact size.

## Build candidates

```bash
mkdir -p /tmp/dbx-vastbase-bench

go build -o /tmp/dbx-vastbase-bench/vastbase-go ./drivers/vastbase-go
go build -o /tmp/dbx-vastbase-bench/agent-compare ./drivers/vastbase-go/bench
```

Run these commands from `agents/`. Supply the archived JDBC `2.11v` and `2.15v`
agent JARs through `JDBC_211_AGENT_JAR` and `JDBC_215_AGENT_JAR`; the production
Vastbase module no longer builds or ships the JDBC agent.

## Direct connector probe

Use the direct probe to separate openGauss connector row-decoding cost from the
Agent JSON-RPC path. It pins one physical connection per worker and runs the same
1,000-row decode query used by `decode_rows`.

```bash
go build -o /tmp/dbx-vastbase-bench/vastbase-direct ./drivers/vastbase-go/bench/direct

DBX_TEST_PASSWORD='secret' \
VASTBASE_HOST=127.0.0.1 \
VASTBASE_PORT=5432 \
VASTBASE_DATABASE=postgres \
VASTBASE_USERNAME=vastbase \
BENCH_MODE=collect \
BENCH_CONCURRENCY=32 \
BENCH_SECONDS=4 \
/tmp/dbx-vastbase-bench/vastbase-direct
```

Set `BENCH_MODE=marshal` to include `encoding/json` serialization of the collected
result. The probe is diagnostic evidence for the Go connector path; it is not a
replacement for the JDBC-vs-Go Agent benchmark.

## Startup-only benchmark

Startup does not require a database server:

```bash
JDBC_211_AGENT_JAR=/tmp/dbx-vastbase-bench/vastbase-jdbc-2.11v.jar \
JDBC_215_AGENT_JAR=/tmp/dbx-vastbase-bench/vastbase-jdbc-2.15v.jar \
GO_AGENT=/tmp/dbx-vastbase-bench/vastbase-go \
BENCH_PHASES=startup \
/tmp/dbx-vastbase-bench/agent-compare > /tmp/dbx-vastbase-bench/startup.ndjson
```

## Live G100/V100 benchmark

```bash
JDBC_211_AGENT_JAR=/tmp/dbx-vastbase-bench/vastbase-jdbc-2.11v.jar \
JDBC_215_AGENT_JAR=/tmp/dbx-vastbase-bench/vastbase-jdbc-2.15v.jar \
GO_AGENT=/tmp/dbx-vastbase-bench/vastbase-go \
VASTBASE_HOST=127.0.0.1 \
VASTBASE_PORT=5432 \
VASTBASE_DATABASE=postgres \
VASTBASE_USERNAME=vastbase \
VASTBASE_PASSWORD='secret' \
VASTBASE_SERVER='G100-V3.0.9-test' \
/tmp/dbx-vastbase-bench/agent-compare > /tmp/dbx-vastbase-bench/live.ndjson
```

Defaults:

- phases: `startup,connect,query`
- workloads: `select_literal,decode_rows,page_rows,list_tables`
- rounds: `3`
- measured duration: `4s` per workload/agent/concurrency/round
- concurrency: `1,8,32`
- decoded/page rows: `1000`

The following variables can override the defaults:

- `BENCH_PHASES`
- `BENCH_WORKLOADS`
- `BENCH_ROUNDS`
- `BENCH_SECONDS`
- `BENCH_CONCURRENCIES`
- `BENCH_LITERAL_SQL`
- `BENCH_DECODE_SQL`
- `BENCH_DECODE_ROWS`
- `BENCH_PAGE_SQL`
- `BENCH_PAGE_ROWS`
- `BENCH_SCHEMA`
- `VASTBASE_SSL`
- `VASTBASE_URL_PARAMS`
- `VASTBASE_CONNECTION_STRING`
- `VASTBASE_CA_CERT_PATH`
- `VASTBASE_CLIENT_CERT_PATH`
- `VASTBASE_CLIENT_KEY_PATH`

Do not use a PostgreSQL/openGauss mock to make a Vastbase performance claim.
Record the exact G100/V100 edition and server version from the emitted metadata.
