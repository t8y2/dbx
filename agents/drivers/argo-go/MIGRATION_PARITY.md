# Argo Go agent notes

Status date: 2026-09-03.

This agent is a fork of `agents/drivers/hive-go` created to serve 星环Argo
(Transwarp ArgoDB) connections exclusively: `supportsRoutines()` returns true
unconditionally and connection identity reports `ArgoDB (Transwarp)` /
`DBX ArgoDB Go Agent`. Vanilla Hive / Kyuubi / Impala stay on hive-go.

No Hive 3 / Hive 4 / Kyuubi parity is claimed for this directory. The
validation matrix in `agents/drivers/hive-go/MIGRATION_PARITY.md` applies to
hive-go only.

## Maintenance rule

Most files are kept byte-identical to hive-go. Fixes landing in hive-go that
touch `metadata.go` or `main.go` must be ported here (adjusting only the
argo-specific branding, the unconditional `supportsRoutines()`, and log
prefixes), including their regression tests.

## Validation

Validated against Transwarp ArgoDB by the PR author (#7933):

- `go test ./...` green in this module (routine views asserted queried
  unconditionally; ArgoDB identity asserted)
- End-to-end on a local build with an ArgoDB connection: 星环Argo branding
  shown, stored-procedure source opens as one whole statement, `CREATE OR
  REPLACE PROCEDURE` executes as a single statement, and execute errors
  surface readable diagnostics
