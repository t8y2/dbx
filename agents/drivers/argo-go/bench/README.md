# Hive Agent benchmark

This benchmark compares the same DBX JSON-RPC operations through the native
Go Hive Agent and the archived JDBC Hive Agent. Both candidates run on the same
host and connect to the same HiveServer2 instance.

Use `functional_probe.py` before running performance benchmarks. It validates
connection, sessions, query values, metadata, pagination, failed-SQL semantics,
clean shutdown, and Java/Go result parity without concurrency load.

The runner measures:

- process startup and fresh connection latency;
- artifact size, idle RSS, and peak RSS;
- `SELECT 1`-shape lookup and 100/1,000/10,000-row decoding;
- `list_databases`, `list_tables`, and complete paged reads;
- 1, 8, and 32 concurrent DBX Agent sessions;
- mean, p50, p95, p99, throughput, and clean shutdown behavior.

Candidate order rotates between rounds to reduce warm-cache and server-order
bias. Startup and connection samples always use a fresh Agent process.

## Prepare the fixture

The defaults expect `dbx_agent_bench.agent_bench` with exactly 10,000 or more
rows and columns named `id` and `payload`:

```sql
CREATE DATABASE IF NOT EXISTS dbx_agent_bench;
CREATE TABLE IF NOT EXISTS dbx_agent_bench.agent_bench (
  id BIGINT,
  payload STRING
) STORED AS ORC;
```

Populate deterministic rows before running the benchmark. Keep the fixture,
HiveServer2 configuration, Agent host, and Java runtime unchanged between
candidates.

## Run

Functional parity probe:

```bash
GO_AGENT=/tmp/dbx-hive-bench/hive-agent-linux-amd64 \
JDBC_AGENT_JAR=/tmp/dbx-hive-bench/dbx-agent-hive.jar \
JAVA_BIN=/tmp/dbx-hive-bench/jre21/bin/java \
HIVE_HOST=127.0.0.1 \
HIVE_PORT=10000 \
HIVE_DATABASE=dbx_agent_bench \
HIVE_URL_PARAMS=auth=noSasl \
python3 agents/drivers/hive-go/bench/functional_probe.py \
  > /tmp/dbx-hive-bench/functional-result.json
```

The functional probe runs the Go candidate only by default. Set
`BENCH_CANDIDATES=go,jdbc` only when an explicit historical-JDBC comparison is
needed.

Performance benchmark:

```bash
GO_AGENT=/tmp/dbx-hive-bench/hive-agent-linux-amd64 \
JDBC_AGENT_JAR=/tmp/dbx-hive-bench/dbx-agent-hive.jar \
HIVE_HOST=127.0.0.1 \
HIVE_PORT=10000 \
HIVE_DATABASE=dbx_agent_bench \
HIVE_URL_PARAMS=auth=noSasl \
python3 agents/drivers/hive-go/bench/agent_compare.py \
  > /tmp/dbx-hive-bench/result.json
```

## Configuration

- `BENCH_CANDIDATES`: performance benchmark default `go,jdbc`; functional probe
  default `go`.
- `GO_AGENT_COMMAND`, `JDBC_AGENT_COMMAND`: optional full launch commands.
- `BENCH_STARTUPS`, `BENCH_CONNECTS`: fresh-process sample counts, default `8`.
- `BENCH_ROUNDS`: alternating steady-state rounds, default `3`.
- `BENCH_WARMUPS`: warmups before each workload, default `2`.
- `BENCH_CONCURRENCY`: comma-separated session counts, default `1,8,32`.
- `BENCH_CONCURRENCY_OPS_PER_WORKER`: operations per session, default `8`.
- `HIVE_HOST`, `HIVE_PORT`, `HIVE_DATABASE`, `HIVE_BENCH_TABLE`.
- `HIVE_USERNAME`, `HIVE_PASSWORD`, `HIVE_URL_PARAMS`, `HIVE_CONNECTION_STRING`.
- `HIVE_SSL`, `HIVE_CA_CERT_PATH`, `HIVE_CLIENT_CERT_PATH`, `HIVE_CLIENT_KEY_PATH`.
- `BENCH_*_SQL` and `BENCH_*_COUNT` override individual workloads.

Run the benchmark on the Agent host. Do not compare a local Go process with a
remote JDBC process, use different HS2 endpoints, or mutate the fixture between
candidates.

## Kerberos fixture

`kdc_fixture` starts a test-only in-process KDC and writes a temporary
`krb5.conf` and keytab containing `alice` and `hive/localhost`. Never use these
credentials outside an isolated compatibility environment, and delete the
generated directory after validation.

```bash
go run ./bench/kdc_fixture -dir /tmp/dbx-hive-kerberos
```
