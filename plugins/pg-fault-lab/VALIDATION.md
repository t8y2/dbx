# Validation record

Date: 2026-09-30. Cloud-only isolated workspace. No user desktop, real database,
real credentials, privileged container, public listener, GVA project changes,
system package installation, repository signing or deployment.

## Current 0.1.1 integration

- Linux x64; Go 1.25.0; PostgreSQL 17.11 from official Debian binaries
- pgx 5.11.0; GORM 1.31.2; PostgreSQL driver 1.6.3; gorm-gen 0.3.29;
  dbresolver 1.6.2; local DBX SDK from fork base 9192af28 (DBX 0.6.29)
- `go generate ./example` actually generates typed query source. A second run
  produces identical SHA-256 values for both generated files. The model definitions, generator and
  generated query files are committed, not hand-written query substitutes
- Both independent example functions, ordinary GORM and gorm-gen, execute actual
  PostgreSQL transactions through the PG wire proxy. Both verify successful
  create/update commit, pause/resume before UPDATE, failed COMMIT without partial
  data and two concurrent transactions with independently resumed/aborted barriers
- Existing pgx/GORM tests remain: prepared/cached/binary queries, success versus
  commit abort with independent row/lock evidence, implicit Sync abort, timeout,
  cancellation, error/Sync recovery, rejected unsupported paths, SCRAM and truthful
  unknown outcome after a sent COMMIT loses its reply
- 26 top-level Go tests plus four nested cases (GORM/gorm-gen and timeout/cancel),
  all passed with the race detector
- Four jsdom UI tests cover observe-only, safe text rendering, control routing,
  duplicate actions, rejected-call retry and navigation/stale capability handling
- Actual external `dbx-mcp` subprocess: manifest/sidecar registry loading,
  seven-tool discovery, host-bound explicit start/stop, real PostgreSQL query/pause/resume,
  COMMIT injection with zero rows persisted, snapshot redaction, unknown connection
  rejection, global read-only denial, saved read-only denial and saved injection
  opt-out. SHA-256 hashes of the actual binaries are recorded by the harness
- Global discovery revealed a real integration bug in 0.1.0: standalone DBX MCP
  calls `mcp/tools` without a connection and does not implicitly call connect.
  0.1.1 fixes this with side-effect-free static discovery and annotated, explicit
  `lab_start`/`lab_stop`; snapshot never silently starts a proxy
- Native sidecar SDK/companion CLI smoke and package checksum validation remain
  available through `scripts/smoke.py` and the official plugin packager

The external harness uses the already-built DBX CLI/MCP test binaries (package
version 0.4.102), not a fake MCP implementation. It isolates HOME, all relevant
XDG/APPDATA paths, DBX_DATA_DIR, and an ephemeral fixture-only storage key. The
registry fixture is unpacked development source plus the actual sidecar binary;
it does not claim to test package signing, trust installation or the native GUI.

The current CLI's AddInput only accepts basic connection fields. The harness
uses it to initialize a new fixture row, then inserts plugin metadata into that
**new disposable fixture store** before MCP starts. No existing DBX database is
read/edited. This is explicitly not a user-facing store-editing workaround.

## Docker assessment

The cloud executor has no docker/podman CLI, no system or user Docker socket,
zero effective/permitted/bounding capabilities, `NoNewPrivs=1`, and no mounted
`/sys/fs/cgroup`. AF_UNIX socket creation is unavailable. Installing a Docker CLI
would not provide a usable daemon here. No privileged mode, namespace/security
setting changes or public daemon listener were attempted. The tests still run
**real PostgreSQL 17 processes**, each created and destroyed inside the fixture;
Docker is not required for database realism.

## Remaining boundaries

- No native desktop installation or browser visual acceptance: cloud browser
  rejects localhost with ERR_BLOCKED_BY_CLIENT; sandbox Chromium cannot create
  its required AF_UNIX sockets. DOM behavior tests do not replace screenshots
- No marketplace signing/installation test, macOS/Windows/ARM64 matrix, load test,
  exhaustive fuzz campaign or full security audit
- Protocol remains PostgreSQL 17 / wire 3.0 / loopback-only. TLS, COPY,
  replication, procedures/2PC and multi-execution pipeline are rejected
- No full DBX make/Rust test suite was rerun for this isolated plugin. Core changes
  remain owned and verified separately
- The user explicitly chose independent GORM/gorm-gen examples, so no complete
  GVA startup or application configuration is included or needed

## Reproduce

```sh
cd plugins/pg-fault-lab/backend
GOMAXPROCS=1 go generate ./example
GOMAXPROCS=1 go test -p 1 ./...
DBX_FAULT_LAB_TEST=1 DBX_FAULT_PG_BIN=/absolute/pg17/bin \
  GOMAXPROCS=1 go test -race -p 1 -count=1 -v ./...
GOMAXPROCS=1 go build -p 1 -o ../dist/dbx-pg-fault .
python ../scripts/smoke.py ../dist/dbx-pg-fault
cd ..
python scripts/external_mcp.py --dbx /absolute/bin/dbx \
  --mcp /absolute/bin/dbx-mcp --sidecar dist/dbx-pg-fault \
  --pg-bin /absolute/pg17/bin
npm ci --ignore-scripts
npm test
dbx-plugin package . --target linux-x64
```

The SDK uses a local replace: keep this plugin inside the DBX checkout. The
0.1.9 dev host's SDK-root override creates a Go1.22 workfile and conflicts with
this Go1.25 module; the native dev command works without that override, using the
checked-in replace. Packaging is unaffected. No upstream tooling was modified.

## Earlier baseline

0.1.0 passed 23 Go tests plus two nested cases with `-race`, four DOM tests and
packaged sidecar SDK/CLI/MCP-shaped smoke on GORM1.25.12 / driver1.5.11. The runtime
already pinned pgx5.11.0 after checking published decoder advisories; initial
pgx5.7.2 compatibility experiments are not the shipped dependency selection.
