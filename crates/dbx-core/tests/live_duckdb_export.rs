#![cfg(feature = "duckdb-sidecar")]

#[path = "support/duckdb_export.rs"]
mod support;

#[test]
#[ignore = "requires DBX_DUCKDB_DRIVER_PATH pointing at a DuckDB worker"]
fn duckdb_query_pages_preserve_one_execution() {
    support::run_query_pages(std::env::var_os("DBX_DUCKDB_DRIVER_PATH").unwrap().into());
}

#[test]
#[ignore = "requires DBX_DUCKDB_DRIVER_PATH pointing at a DuckDB worker"]
fn duckdb_parquet_exports_are_consistent() {
    support::run_parquet_exports(std::env::var_os("DBX_DUCKDB_DRIVER_PATH").unwrap().into());
}

#[test]
#[ignore = "requires DBX_DUCKDB_DRIVER_PATH pointing at a DuckDB worker"]
fn duckdb_export_snapshots_preserve_values_and_cleanup() {
    support::run_snapshot_cleanup(std::env::var_os("DBX_DUCKDB_DRIVER_PATH").unwrap().into());
}
