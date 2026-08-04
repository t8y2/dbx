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
go test -run '^TestVastbaseIntegration$' -count=1 ./...
```

The benchmark harness under `bench/` compares this native agent with the
Vastbase JDBC 2.11v and 2.15v agents.
