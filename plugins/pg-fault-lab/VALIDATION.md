# Validation record

Date: 2026-09-30. Cloud-only isolated workspace; no user desktop, real database,
real credentials, system package installation, repository signing or deployment.

## Passed

- Go 1.25.0, linux/amd64; sidecar/runtime pgx 5.11.0; local DBX Go SDK from
  fork base `9192af28aefb434fb90d27dad78831961ce0f1e8` (DBX 0.6.29)
- PostgreSQL 17.11 Debian official binaries, unpacked into the task workspace
- New per-run temporary cluster, `dbx_fault_fixture` synthetic role, random
  loopback port, trust for that role and SCRAM for one synthetic test role;
  the test harness stops/removes the cluster and does not accept an external DSN
- `go test -race -p 1 -count=1 -v ./...` with the integration fixture: 23 top-level
  Go tests plus the timeout/cancel subcases; no detected data races
- Real GORM 1.25.12 / postgres driver 1.5.11 with prepared statements enabled:
  normal commit persists exactly one row; forced pre-COMMIT disconnect does not
  persist its row and its advisory transaction lock is independently released
- Real pgx prepared/cached queries, binary parameter/result transport, independent
  concurrent barriers, execution pause/resume/abort, pause timeout, paused and
  running CancelRequest, SQL-error/Sync recovery, implicit extended commit abort,
  simple-autocommit unsupported-boundary rejection, connection drop, multi-SQL and
  pipelined execution rejection without partial commit, savepoint outcome accuracy,
  TLS-required rejection and SCRAM relay
- Deterministic wire fixture: COMMIT is actually received upstream, its reply is
  lost, and the proxy records `unknown` rather than rollback/success
- Observer/injector capability isolation, independent core read-only authorization,
  bounded selector/rule/TTL validation, control shutdown, snapshot redaction,
  MCP host-connection binding and mutation annotations
- Four jsdom UI behavior tests: observe-only controls, text-only hostile event
  rendering, arm/resume/abort/delete routing, rapid duplicate actions, rejected-call
  retry and connection-navigation/stale-capability handling
- Native binary `scripts/smoke.py`: real DBX Go SDK stdio initialization,
  connection lifecycle, companion CLI observer denial/injector success, shared
  rules through MCP discovery/call, redaction and disconnect/EOF cleanup
- Manifest validates against the checkout's draft-2020-12 JSON schema
- Official `@dbx-app/plugin-cli` 0.1.9 packages a linux-x64 **unsigned review
  candidate** with checksums; the source does not contain the binary artifact
- Official plugin dev host builds and initializes this Go sidecar successfully

## Not verified / blocked

- Native DBX desktop installation, actual external `dbx-mcp` process, marketplace
  signing/installation and end-user GVA project execution were not run. GORM uses
  its actual ordinary APIs in the fixture; no claim is made about every GVA path
- A real browser screenshot/visual acceptance was not obtained. The cloud browser
  rejects the private localhost development URL with `ERR_BLOCKED_BY_CLIENT`;
  sandbox Chromium cannot start because AF_UNIX sockets are unavailable. No public
  listener or security-policy change was introduced to bypass these restrictions
- Full DBX `make check`, Rust/backend build and unrelated workspace test suites
  were not run for this isolated plugin; other tasks own the core changes
- macOS, Windows, ARM64, PostgreSQL versions other than 17, server-side TLS, COPY,
  replication, procedure/2PC and multi-execution pipeline compatibility are not
  certified or implemented. The plugin rejects unsupported protocol paths
- Dependency selection includes pgx 5.11.0's published decoder hardening. This is
  not a full security audit, exhaustive protocol fuzzer run, load test, or claim
  that all dependencies/toolchain versions are free of vulnerabilities

## Useful tooling limitation

The 0.1.9 development host's `DBX_PLUGIN_SDK_ROOT` override generates a Go 1.22
workspace, which conflicts with this module's Go 1.25 requirement. Running its
native CLI **without that override** works with the module's checked-in relative
SDK replace. Packaging with the SDK override works; this issue is confined to the
existing development-host workfile. No core tooling was modified as part of this
plugin. A separate upstream report/fix has not been published.

## Reproduce

```sh
cd plugins/pg-fault-lab/backend
GOMAXPROCS=1 go test -p 1 ./...
DBX_FAULT_LAB_TEST=1 DBX_FAULT_PG_BIN=/absolute/pg17/bin \
  GOMAXPROCS=1 go test -race -p 1 -count=1 -v ./...
GOMAXPROCS=1 go build -p 1 -o ../dist/dbx-pg-fault .
python ../scripts/smoke.py ../dist/dbx-pg-fault
cd ..
npm ci --ignore-scripts
npm test
dbx-plugin package . --target linux-x64
```

The SDK is a local replace, so keep this plugin inside the DBX checkout when
reproducing. For a standalone plugin repository, deliberately pin/package the SDK
and review licensing before removing that replace.
