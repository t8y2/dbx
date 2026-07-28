#![cfg(feature = "duckdb-bundled")]

use std::io::{self, BufRead};
use std::time::Duration;

fn main() {
    if let Ok(path) = std::env::var("DBX_DUCKDB_HANGING_CONNECT_PID_FILE") {
        let _ = std::fs::write(path, std::process::id().to_string());
    }

    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    let Some(Ok(_line)) = lines.next() else {
        return;
    };

    loop {
        std::thread::sleep(Duration::from_secs(60));
    }
}
