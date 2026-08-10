# IoTDB 2.0.8 local driver comparison

Date: 2026-08-10

Environment:

- Apple M2 Pro, macOS arm64
- Java 21.0.7
- Go 1.26.5
- Apache IoTDB 2.0.8 standalone
- JDBC and Go clients both pinned to 2.0.8
- 10,000 Tree-model rows, fetch size 1,024
- 15 alternating cold starts, 5 connected-RSS samples, 5 alternating workload rounds

| Metric | JDBC | Go | Go reduction |
| --- | ---: | ---: | ---: |
| Cold process + connection p50 | 172.612 ms | 9.315 ms | 94.6% |
| Connected RSS p50 | 62,368 KB | 7,008 KB | 88.8% |
| Artifact size | 25,864,492 B | 6,475,202 B | 75.0% |
| In-process connection mean | 66.061 ms | 1.932 ms | 97.1% |
| `SHOW DATABASES` mean | 0.775 ms | 0.428 ms | 44.8% |
| Point query mean | 0.813 ms | 0.595 ms | 26.8% |
| 100-row query mean | 1.437 ms | 1.010 ms | 29.7% |
| 10,000-row full decode mean | 5.455 ms | 4.941 ms | 9.4% |

The result supports a Go Agent primarily for startup, connection, memory, and
distribution-size improvements. Warm query differences are much smaller and
shrink as server work and result decoding increase. This benchmark compares
drivers directly; it does not include the DBX JSON-RPC Agent layer or prove
feature and version compatibility parity.

See `iotdb-2.0.8-macos-arm64.json` for all raw rounds.
