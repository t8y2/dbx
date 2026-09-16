fn main() {
    if let Err(error) = dbx_sqlite_worker::runtime::run_stdio() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
