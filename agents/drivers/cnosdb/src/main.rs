#[tokio::main]
async fn main() {
    if let Err(error) = dbx_cnosdb_driver::run().await {
        eprintln!("CnosDB driver failed: {error:#}");
        std::process::exit(1);
    }
}
