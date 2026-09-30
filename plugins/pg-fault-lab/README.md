# PostgreSQL Fault Lab (experimental)

A DBX plugin and Go sidecar for **disposable, synthetic PostgreSQL 17 databases**.
GVA/GORM/pgx connect to a real PostgreSQL wire proxy; they do not call an HTTP SQL
facade and do not need a business-code SDK. Only the lab database endpoint changes.

Status: bounded MVP, **not a production proxy**. Source lives in this fork while
scope is evaluated. No DBX core changes, marketplace publication, signing, desktop
installation, production connection, or GVA application rewrite are included.

## What works

- One frontend socket to one upstream PostgreSQL socket; no connection pooling
- Simple Query and the ordinary extended Parse/Bind/Describe/Execute/Sync cycle,
  including named prepared statements, unnamed portals, and binary bind/results
- Exact selectors on startup application/database/user, proxy connection ID,
  SHA-256 of original SQL text, or uppercase first SQL keyword
- Bounded, one-shot or limited-hit rules before execution, before explicit
  COMMIT/END, before extended implicit-transaction Sync, or before upstream connect
- Separate pause IDs per connection: resume, abort, finite timeout, and cancellation
- Original PostgreSQL success/error events separated from injected failure events
- Confirmed COMMIT/ROLLBACK, rejected commit, and unknown outcome distinctions
- DBX workbench, built-in/external MCP tool bridge, and standalone CLI share the
  same control dispatcher; CLI can control the instance opened by DBX

**Observe-only means no fault injection. It does not make the application's SQL
read-only.** All data must still be synthetic and disposable.

## Support boundary

Validated on Linux x64, PostgreSQL **17.11**, Go **1.25.0**, pgx **5.11.0**,
GORM **1.31.2**, gorm postgres driver **1.6.3**, and gorm-gen **0.3.29**, with prepared statements enabled.
Initial compatibility testing also passed pgx 5.7.2, but the shipped sidecar pins
5.11.0 for the current protocol decoder fixes. DBX contract: manifest v1, Host API
1.x, sidecar protocol v1, minimum declared DBX **0.6.29**.

Only PostgreSQL major 17 and wire protocol **3.0** are accepted. Other majors,
protocol 3.2, TLS/GSS encryption, proxies/tunnels, replication, COPY, fast-path calls,
CALL/DO, SQL-level PREPARE/EXECUTE, two-phase commit, suspended portals/cursors,
and multiple executions before Sync are unsupported. Unsupported paths fail
closed by closing **both** sockets. See [PROTOCOL.md](PROTOCOL.md) for the precise
state/transaction contract, including simple autocommit and escaped SQL strings.

TLS is not terminated or passed through in this MVP. SSLRequest/GSSENCRequest
receive `N`; TLS-required clients fail. **Do not downgrade an existing environment's
TLS settings.** Use `sslmode=disable` only on a newly created loopback-only lab.

The real standalone `dbx-mcp` process has loaded this plugin from an isolated
development registry, discovered/called its tools, and controlled real PostgreSQL.
The full native desktop and visual workbench installation remain unverified. This is not a claim that a signed release or installed desktop
integration has passed. External plugin MCP tools require DBX's native plugin
bridge; the current DBX Web/Docker backend does not expose plugin tools.

## Build and run

From this checkout (Go 1.25+):

```sh
cd plugins/pg-fault-lab/backend
GOMAXPROCS=1 go build -p 1 -trimpath -o ../dist/dbx-pg-fault .
../dist/dbx-pg-fault serve --disposable-lab \
  --upstream 127.0.0.1:55432 --listen 127.0.0.1:55433
```

The upstream must be a separately created **empty synthetic PG17 cluster**.
No database credentials are accepted or stored by the proxy: it relays the
application's authentication exchange. There is no attempt to read a saved DBX
SQL connection, environment DSN, `.pgpass`, keychain, or application configuration.

Injection is off by default. Add `--allow-injection` only for the disposable lab.
The process prints its proxy address and independent loopback control endpoints:
`observe` and, if enabled, `inject`. Each has its own random, **process-lifetime**
capability. These are not persisted and expire when the process exits. Keep the
injection capability private. The control transport is bounded JSON over raw TCP,
not an HTTP server, and cannot listen outside numeric loopback addresses.

Point the test application's ordinary PostgreSQL configuration at 127.0.0.1:55433,
using its synthetic role/database and an application name such as `lab_gorm`.
Use a dedicated pool per scenario; after an injected disconnect, dispose/recreate
that pool. No schema migration against an existing database is necessary.

```text
host=127.0.0.1 port=55433 user=lab dbname=lab sslmode=disable application_name=lab_gorm
```

## CLI controls

Use the address and capability of the desired endpoint. Set
`DBX_FAULT_CAPABILITY` in the current shell from the launch output (do not put it
in a repository, shared log, or persistent shell profile).

```sh
printf '%s\n' '{"method":"snapshot"}' |
  dbx-pg-fault ctl --address 127.0.0.1:CONTROL_PORT
```

For injection, use the separate `inject` endpoint and capability:

```json
{"method":"add_rule","rule":{"selector":{"application":"lab_gorm","command":"COMMIT"},"phase":"commit","action":"abort","hits":1,"ttlMs":60000}}
```

Other requests are `{"method":"resume","id":"p-N"}`,
`{"method":"abort","id":"p-N"}`, and
`{"method":"delete_rule","id":"r-N"}`. Get exact IDs from a snapshot.
The observe endpoint always rejects mutations, even with a valid observe
capability. Core authorization independently rejects mutations when injection
was not enabled. An injection capability cannot authenticate to the observe
endpoint, or vice versa.

Rule selection is first matching rule in insertion order. All nonempty selector
fields are ANDed exact matches; `command` is the first keyword (`WITH` stays WITH),
not an SQL parser-derived semantic type. `sqlHash` is lowercase SHA-256 of the
original SQL bytes; bind values are never included. For implicit extended commit,
use phase `commit`, command `SYNC`, optionally the executed SQL hash. For an
explicit transaction, use command `COMMIT` (or `END`). At least one selector is
required; hits 1–100 and TTL 10–300000 ms are mandatory. Deleting a rule prevents
future hits but does not release already-published pauses: resume/abort their IDs.

## DBX workbench and MCP

Build an unsigned review candidate with the existing DBX plugin packager:

```sh
dbx-plugin package plugins/pg-fault-lab --target linux-x64
```

This is an unsigned development artifact, not a marketplace release. Installation
or changing DBX's unsigned-development setting is a separate operator decision.
No signing keys are generated by this project.

Create the plugin's **PostgreSQL Fault Lab** connection. Set the synthetic
loopback upstream, the desired proxy port, confirm disposable data, and opt in
to injection only if needed. Connecting starts the proxy; disconnecting closes
it, releases all barriers, destroys rules, and closes both application/upstream
sockets. The Test button validates configuration only and says so explicitly.

The workbench shows pauses, rules, transaction events and a Refresh button. It
never exposes SQL text, bind values or result rows. “Show CLI endpoints” is an
explicit reveal of ephemeral capabilities for controlling the same running
instance; changing connection context clears that display.

MCP contribution `external_tools: true` supports two host flows. The built-in AI
can discover tools on an already-open connection. Standalone `dbx-mcp` first
calls `mcp/tools` without a connection, so it gets the static seven-tool catalog:
`lab_snapshot`, `lab_add_rule`, `lab_delete_rule`, `lab_resume`, `lab_abort`,
`lab_start`, and `lab_stop`. Discovery never starts a listener. Explicitly call
`lab_start` on a saved lab connection before standalone inspection/injection;
`lab_stop` closes it. Only `lab_snapshot` is read-only.

Mutating tools have `readOnlyHint:false` and remain subject to DBX's host
approval/read-only/connection allowlist policy. The plugin additionally enforces
the saved connection's read-only flag and injection opt-in at call time. Calls
must use the host-bound connection; unknown/cross-connection selections are
rejected. `lab_start` rejects changed settings on an already-running instance;
stop/restart to apply settings. Capabilities are never returned by MCP.

Standalone `dbx-pg-fault` is a companion CLI: DBX currently has no plugin-defined
native `dbx` subcommand hook.

## Verification

Unit/authorization/state tests do not need PostgreSQL:

```sh
cd plugins/pg-fault-lab/backend
GOMAXPROCS=1 go test -p 1 ./...
```

For the complete integration suite, provide installed PostgreSQL 17 binaries:

```sh
DBX_FAULT_LAB_TEST=1 DBX_FAULT_PG_BIN=/absolute/path/to/postgresql/17/bin \
  GOMAXPROCS=1 go test -race -p 1 -count=1 -v ./...
```

The test harness creates a **new** temporary PGDATA/role, chooses a free numeric
loopback port, prevents reading existing libpq profiles/credentials, then stops
and removes that exact cluster. It accepts no external DSN. No Docker, system
service, root installation, or real database is required.

Coverage includes real prepared and cached execution, GORM's unchanged transaction
path, successful commit versus forced pre-commit abort, absence of the aborted
row, advisory-lock release, implicit extended commit abort, independent concurrent
barriers, pause timeout/cancel, running query cancel and Sync recovery, upstream
errors, unsupported SQL/pipeline closure, TLS-required rejection and SCRAM relay.
A deterministic wire fixture proves a sent COMMIT with a lost reply records
`unknown`. Additional tests cover bounded rule matching/TTL, observer/injector
separation, token redaction, MCP connection binding, and lifecycle cleanup.

### Reproducible GORM and gorm-gen application example

`backend/example/service.go` provides the same synthetic create/update order
transaction using ordinary GORM (`PlaceOrderGORM`) and generated typed queries
(`PlaceOrder`). Neither function imports the proxy or calls its API. The tests
point their ordinary DB connection at the proxy and control faults out-of-band.

```sh
cd plugins/pg-fault-lab/backend
go generate ./example
# Model definitions and generated queries are checked in; regeneration is byte-identical.
DBX_FAULT_LAB_TEST=1 DBX_FAULT_PG_BIN=/absolute/pg17/bin \
  GOMAXPROCS=1 go test -race -p 1 -run TestRealGORMAndGeneratedTransactions -v ./faultproxy
```

Both variants cover normal commit, pause/resume before UPDATE, forced COMMIT
failure without partial data, and independent concurrent transactions where one
resumes and the other aborts. The generator uses local Go models; it never
introspects an existing database or reads application configuration.

### Real external MCP regression

After building the plugin, provide actual native DBX CLI/MCP binaries:

```sh
python scripts/external_mcp.py --dbx /absolute/bin/dbx \
  --mcp /absolute/bin/dbx-mcp --sidecar dist/dbx-pg-fault \
  --pg-bin /absolute/pg17/bin
```

This creates a disposable DBX store and PG17 instance, loads an unpacked
**development fixture** through the real plugin registry, and verifies discovery,
host-bound start/stop, SQL, COMMIT abort, zero committed rows, redaction and global
and saved read-only/injection policy. It records binary SHA-256 values. The
current CLI's add input exposes only basic connection fields, so the harness adds
plugin metadata directly to its newly created fixture storage. This is neither a
production configuration recipe nor a signed-package installer test.

See [VALIDATION.md](VALIDATION.md) for the actual run and remaining gaps.

## Ownership and dependencies

Apache-2.0, consistent with the fork and upstream. See the repository LICENSE
and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The official [DBX plugin contract](../README.md) already supplies native sidecars,
workbenches and the MCP bridge, so no core patch is needed. The MIT-licensed
[jackc/pgx pgproto3](https://github.com/jackc/pgx/tree/v5.11.0/pgproto3) provides
wire framing/encoding; this project owns the bounded proxy state machine.
[Toxiproxy](https://github.com/Shopify/toxiproxy) is useful for opaque TCP faults,
but it does not provide SQL/transaction boundaries and is not a dependency here.
