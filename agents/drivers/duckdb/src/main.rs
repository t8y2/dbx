#[tokio::main]
async fn main() {
    if let Err(error) = dbx_duckdb_driver::run_stdio_worker().await {
        eprintln!("DuckDB driver failed: {error}");
        std::process::exit(1);
    }
}
