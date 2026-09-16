# IoTDB JDBC vs Go driver benchmark

This standalone benchmark preserves the JDBC-versus-Go comparison used before
the production IoTDB Agent migrated to Go. It compares the released Apache
IoTDB `2.0.8` JDBC and Go clients against the same Tree-model server and
fixture, measuring cold process plus connection startup and warm query latency
while fully decoding every returned cell.

The default fixture contains 10,000 rows in `root.dbx_bench.d1`. Workloads are:

- `SHOW DATABASES`
- one timestamp point query
- a 100-row range query
- a full scan of all fixture rows

## Start IoTDB

For example, run the matching standalone Docker image:

```bash
docker run --rm --name dbx-iotdb-bench -p 6667:6667 apache/iotdb:2.0.8-standalone
```

Wait until port `6667` is ready before starting the benchmark.

## Run

From the repository root:

```bash
python3 agents/drivers/iotdb/bench/run.py \
  > /tmp/dbx-iotdb-driver-benchmark.json
```

The runner builds both candidates from this benchmark directory, recreates the
fixture, alternates cold-start and connected-RSS samples, then runs three warm
workload rounds with alternating candidate order. It does not build or modify
the production IoTDB Agent.

## Configuration

- `IOTDB_HOST`, `IOTDB_PORT`, `IOTDB_USERNAME`, `IOTDB_PASSWORD`
- `BENCH_ROWS`, default `10000`
- `BENCH_FETCH_SIZE`, default `1024`
- `BENCH_STARTUPS`, default `5`
- `BENCH_RSS_SAMPLES`, default `3`
- `BENCH_ROUNDS`, default `3`
- `BENCH_ORDER`, default `jdbc,go`; use `go,jdbc` to check order effects
- `BENCH_WARMUPS`, default `3`
- `BENCH_METADATA_ITERATIONS`, default `20`
- `BENCH_POINT_ITERATIONS`, default `100`
- `BENCH_RANGE_ITERATIONS`, default `30`
- `BENCH_SCAN_ITERATIONS`, default `5`
- `BENCH_PREPARE=false` to preserve an existing fixture
- `BENCH_SKIP_BUILD=true` to reuse existing benchmark artifacts

Run both candidates against the same server and do not change the fixture or
fetch size between candidates. This is a client-side comparison, not an IoTDB
server throughput benchmark.
