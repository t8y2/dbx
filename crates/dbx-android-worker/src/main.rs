//! On-device SQLite worker for DBX "Android (ADB)" connections.
//!
//! Pushed to `/data/local/tmp/dbx-android-worker` by the desktop client and
//! started through `adb shell exec-out run-as <package> <worker>`, so the
//! process runs as the target app's uid and can open that app's database
//! files directly. Speaks the same JSON line protocol as `dbx-sqlite-worker`
//! over stdin/stdout (`adb exec-out` is binary-safe).
//!
//! Flags:
//! - `--db <path>`  open this database before serving requests (optional; the
//!                  client may still send an `open` request).
//! - `--stdio`      accepted for symmetry, this is the only mode.
//! - `--version`    print the worker version and exit (protocol handshake).
//!
//! Session knobs are fixed here rather than negotiated over the protocol:
//! busy_timeout keeps the worker polite while the host app writes, and the
//! first write of every session snapshots the database file first.

use std::time::Duration;

const BUSY_TIMEOUT_SECS: u64 = 5;
const BACKUP_KEEP: usize = 3;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut preopen: Option<String> = None;
    let mut version_only = false;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--db" => {
                preopen = iter.next().cloned();
                if preopen.is_none() {
                    eprintln!("--db requires a path argument");
                    std::process::exit(2);
                }
            }
            "--stdio" => {}
            "--version" => {
                version_only = true;
            }
            other => {
                eprintln!("unknown argument: {other}");
                std::process::exit(2);
            }
        }
    }
    if version_only {
        println!("dbx-android-worker {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let options = dbx_sqlite_worker::runtime::RuntimeOptions {
        busy_timeout: Duration::from_secs(BUSY_TIMEOUT_SECS),
        backup_before_write: true,
        backup_keep: BACKUP_KEEP,
    };
    if let Err(error) = dbx_sqlite_worker::runtime::run_stdio_with_options_and_preopen(options, preopen) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
