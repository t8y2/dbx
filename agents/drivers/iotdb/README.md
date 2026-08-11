# Apache IoTDB native Agent

This module implements the DBX Agent protocol with the official Apache IoTDB
Go client. Tree SQL is the default; set `sql_dialect=table` for the Table model.

## Build and test

Go 1.25 or newer is required by the pinned upstream client revision.

```bash
go test ./...
go test -race ./...
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o agent .
```

Run the live Tree/Table, paging, multi-session, and cancellation tests against
an IoTDB server with:

```bash
DBX_IOTDB_LIVE=1 go test -race ./... -count=1
```

The live tests default to `127.0.0.1:6667` with `root/root`. Override them with
`DBX_IOTDB_HOST`, `DBX_IOTDB_PORT`, `DBX_IOTDB_USER`, and
`DBX_IOTDB_PASSWORD`. Tests create and remove isolated Tree and Table databases.

## Connection options

DBX connection fields and `jdbc:iotdb://...` connection strings are accepted.
The following URL parameters are supported:

- `sql_dialect=tree|table`
- `database` or `db`
- `fetch_size`
- `time_zone`
- `connect_retry_max`
- `connect_timeout_ms`
- `enable_compression=true`
- `node_urls=host1:6667,host2:6667` for cluster sessions
- `ssl=true` and `insecure_skip_verify=true`

The standard DBX certificate fields provide CA and client certificate paths
for TLS or mTLS connections.

## Compatibility

- Tree sessions expose databases, devices, timeseries columns, queries, DDL,
  paging, and sequential batch/transaction execution.
- Table sessions expose databases, tables, TIME/TAG/FIELD column categories,
  comments, queries, DDL, paging, and database switching.
- The Agent keeps one physical IoTDB session per logical DBX session and
  invalidates that session after cancellation, timeout, or connection failure.

The historical JDBC-versus-Go driver benchmark and raw result summary are kept
under [`bench`](bench/README.md).
