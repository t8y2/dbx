# DBX DuckDB Standalone Driver

This directory contains the standalone Rust DuckDB sidecar. It reuses DBX's
existing newline-delimited JSON worker runtime, while keeping DuckDB and
`libduckdb-sys` outside the main application dependency graph.

## Build

```bash
cargo build --manifest-path agents/drivers/duckdb/Cargo.toml --release --bin dbx-duckdb-driver
```

Point DBX at the resulting executable with:

```bash
DBX_DUCKDB_DRIVER_PATH=/absolute/path/to/dbx-duckdb-driver \
  cargo run -p dbx --no-default-features --features duckdb-sidecar
```

Release builds publish this driver through the DBX driver registry. Driver
Manager installs it as `~/.dbx/agents/drivers/duckdb/agent` (or `agent.exe` on
Windows). `DBX_DUCKDB_DRIVER_PATH` remains available for local development.

## Release package

Each platform is published as a self-contained `.tar.zst` package used by both
online Driver Manager installation and manual single-driver import:

```text
agent-registry.json
drivers/dbx-agent-duckdb-<version>-<platform>[.exe]
```

DBX decompresses the package itself, so users do not need to install `zstd`,
DuckDB, or a separate database driver. The existing aggregate offline `.zip`
packages remain supported for backward compatibility.

## Current scope

The driver implements connect, execute, database/schema/table/column metadata,
table DDL, view source, completion assistance, attach, cancel, and shutdown over
the DBX sidecar protocol.
