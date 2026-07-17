#![cfg(feature = "duckdb-bundled")]

use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().map(PathBuf::from).expect("DuckDB path argument");
    let hold_ms = args.next().expect("hold duration argument").parse::<u64>().expect("hold duration ms");

    let _connection = duckdb::Connection::open(&path).expect("open lock owner connection");
    println!("ready");
    std::io::stdout().flush().expect("flush ready line");
    std::thread::sleep(Duration::from_millis(hold_ms));
}
