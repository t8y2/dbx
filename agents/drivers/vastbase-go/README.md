# Vastbase Native Agent

This module implements the DBX agent protocol for Vastbase with the pure-Go
`openGauss-connector-go-pq` driver.

## Build

```bash
go test ./...
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o agent .
```

## Local DBX Test

Build the binary, then copy it into DBX's installed Vastbase driver directory:

```bash
mkdir -p ~/.dbx/agents/drivers/vastbase
cp agent ~/.dbx/agents/drivers/vastbase/agent
chmod +x ~/.dbx/agents/drivers/vastbase/agent
```

DBX prefers `agent` over `agent.jar`. Remove the native binary to restore a
previously installed JDBC agent.

## Integration Test

Set `VASTBASE_TEST_HOST`, `VASTBASE_TEST_PORT`, `VASTBASE_TEST_DATABASE`,
`VASTBASE_TEST_USERNAME`, and `VASTBASE_TEST_PASSWORD`, then run:

```bash
go test -count=1 ./...
```

`TestVastbaseConstraintsIntegration` validates structured primary-key,
foreign-key, unique, check, deferrability, validation, enabled state, and
deparser metadata. To qualify multiple real database compatibility modes,
create one test database per mode and pass all names as a comma-separated list:

```bash
VASTBASE_TEST_DATABASES=vastbase_a,vastbase_b,vastbase_pg go test -run '^TestVastbaseConstraintsIntegration$' -count=1
```

The agent reads each database's `pg_catalog.pg_database.datcompatibility` value
and reports both a normalized `compatibilityMode` (`oracle`, `mysql`,
`postgres`, or `sqlserver`) and the server's original
`compatibilityModeRaw` value. `B`, `M`, and `MYSQL` use MySQL identifier rules.
Catalog availability and SQL Server identity metadata are probed separately
from the normalized mode. Vastbase `A` is normalized to Oracle compatibility,
but the tested A release rejects `DISABLE CONSTRAINT`, so that DDL assertion is
only enabled for server values that explicitly report `O`, `ORA`, or `ORACLE`. For a full compatibility
qualification, run the complete suite separately against A (Oracle), B
(MySQL), PG (PostgreSQL), and MSSQL (SQL Server) instances. Supply credentials
through the `VASTBASE_TEST_*` environment variables; do not commit them.

MySQL-compatible instances intentionally skip the PostgreSQL-only SQL-function
fixture and `search_path` visibility assertion, while still running the table,
column, index, view, transaction, paging, cancellation, and structured
constraint coverage.

The benchmark harness under `bench/` compares this native agent with the
Vastbase JDBC 2.11v and 2.15v agents.
