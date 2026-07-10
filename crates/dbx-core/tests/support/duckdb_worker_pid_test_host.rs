#![cfg(feature = "duckdb-bundled")]

fn main() {
    if let Ok(path) = std::env::var("DBX_DUCKDB_PID_TEST_HOST_PID_FILE") {
        let _ = std::fs::write(path, std::process::id().to_string());
    }

    let runtime = tokio::runtime::Runtime::new().expect("Failed to create DuckDB worker test runtime");
    if let Err(err) = runtime.block_on(dbx_core::db::duckdb_worker_runtime::run_stdio_worker()) {
        eprintln!("DuckDB worker test host failed: {err}");
        std::process::exit(1);
    }
}
