// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(feature = "duckdb-bundled")]
    if std::env::args().any(|arg| arg == "--duckdb-worker") {
        let runtime = tokio::runtime::Runtime::new().expect("Failed to create DuckDB worker runtime");
        if let Err(err) = runtime.block_on(dbx_core::db::duckdb_worker_runtime::run_stdio_worker()) {
            eprintln!("DuckDB worker failed: {err}");
            std::process::exit(1);
        }
        return;
    }

    dbx_lib::run();
}
