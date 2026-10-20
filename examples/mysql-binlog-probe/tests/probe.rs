#[path = "../../../crates/dbx-binlog/tests/common/mod.rs"]
mod common;
use common::*;
use std::io::Cursor;

#[test]
fn cli_prints_counts_without_row_values_and_fails_on_invalid_files() {
    let path = std::env::temp_dir().join(format!("dbx-12838-probe-{}.binlog", std::process::id()));
    let mut bytes = with_table();
    let mut write = row_prefix(7);
    write.extend(image(1, b"sensitive-row-value", None));
    append(&mut bytes, 30, &write);
    std::fs::write(&path, bytes).unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_dbx-mysql-binlog-probe")).arg(&path).output().unwrap();
    // Remove only this test's file even when a later assertion fails.
    std::fs::remove_file(&path).unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.contains("rows=1"));
    assert!(!text.contains("sensitive-row-value"));
    assert!(text.contains("not a recovery eligibility check"));

    let missing = std::process::Command::new(env!("CARGO_BIN_EXE_dbx-mysql-binlog-probe")).arg(&path).output().unwrap();
    assert!(!missing.status.success());
    let invalid = std::process::Command::new(env!("CARGO_BIN_EXE_dbx-mysql-binlog-probe")).output().unwrap();
    assert!(!invalid.status.success());
}

#[test]
fn cli_lists_transactions_and_exports_only_after_full_validation() {
    use dbx_mysql_binlog_probe::read_log;
    let prefix = std::env::temp_dir().join(format!("dbx-12838-recovery-{}", std::process::id()));
    let binlog = prefix.with_extension("binlog");
    let manifest = prefix.with_extension("json");
    let mut bytes = named_log();
    query(&mut bytes, b"BEGIN");
    write_row(&mut bytes, 1);
    query(&mut bytes, b"COMMIT");
    let parsed = read_log(Cursor::new(&bytes)).unwrap();
    std::fs::write(&binlog, bytes).unwrap();
    std::fs::write(&manifest, serde_json::to_vec(&snapshot(&parsed)).unwrap()).unwrap();
    let listing = std::process::Command::new(env!("CARGO_BIN_EXE_dbx-mysql-binlog-probe"))
        .arg("transactions")
        .arg(&binlog)
        .output()
        .unwrap();
    let start = parsed.transactions()[0].start_position.to_string();
    let script = std::process::Command::new(env!("CARGO_BIN_EXE_dbx-mysql-binlog-probe"))
        .arg("recover")
        .arg(&binlog)
        .arg(&manifest)
        .arg(&start)
        .output()
        .unwrap();
    let rejected = std::process::Command::new(env!("CARGO_BIN_EXE_dbx-mysql-binlog-probe"))
        .arg("recover")
        .arg(&binlog)
        .arg(&manifest)
        .arg("9999999")
        .output()
        .unwrap();
    std::fs::remove_file(binlog).unwrap();
    std::fs::remove_file(manifest).unwrap();
    assert!(listing.status.success(), "{}", String::from_utf8_lossy(&listing.stderr));
    let listing: serde_json::Value = serde_json::from_slice(&listing.stdout).unwrap();
    assert_eq!(listing["transactions"][0]["start_position"], start);
    assert!(script.status.success(), "{}", String::from_utf8_lossy(&script.stderr));
    assert!(String::from_utf8(script.stdout).unwrap().contains("DELETE FROM `test`.`items`"));
    assert!(!rejected.status.success());
    assert!(rejected.stdout.is_empty());
}

#[test]
fn worker_subprocess_handles_one_request_and_returns_only_json() {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    let path = std::env::temp_dir().join(format!("dbx12838-worker-cli-{}.binlog", std::process::id()));
    let mut bytes = named_log();
    query(&mut bytes, b"BEGIN");
    write_row(&mut bytes, u64::MAX);
    query(&mut bytes, b"COMMIT");
    std::fs::write(&path, bytes).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_dbx-mysql-binlog-probe"))
        .arg("--worker")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&serde_json::json!({"action":"list","path":path})).unwrap())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    std::fs::remove_file(path).unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["total"], 1);
    assert!(!String::from_utf8(output.stdout).unwrap().contains("18446744073709551615"));
}

#[test]
fn native_host_invokes_real_worker_and_rejects_bad_requests() {
    use dbx_mysql_binlog_probe::host::{run_worker,WorkerLimits};
    let path = std::env::temp_dir().join(format!("dbx12838-host-{}.binlog",std::process::id()));
    let mut bytes = named_log(); query(&mut bytes,b"BEGIN"); write_row(&mut bytes,7); query(&mut bytes,b"COMMIT");
    std::fs::write(&path,bytes).unwrap();
    let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_dbx-mysql-binlog-probe")); command.arg("--worker");
    let result = run_worker(command,&serde_json::to_vec(&serde_json::json!({"action":"list","path":path})).unwrap(),WorkerLimits::default());
    std::fs::remove_file(path).unwrap();
    let value:serde_json::Value = serde_json::from_str(&result.unwrap()).unwrap(); assert_eq!(value["total"],1);
    let command = std::process::Command::new(env!("CARGO_BIN_EXE_dbx-mysql-binlog-probe"));
    assert!(run_worker(command,&vec![0;65537],WorkerLimits::default()).unwrap_err().contains("64 KiB"));
}

#[cfg(unix)]
#[test]
fn native_host_kills_only_its_timed_out_or_oversized_worker() {
    use dbx_mysql_binlog_probe::host::{run_worker,WorkerLimits};
    use std::{process::Command,time::{Duration,Instant}};
    let start=Instant::now();
    let mut command=Command::new("python3"); command.args(["-c","import time; time.sleep(20)"]);
    let error=run_worker(command,b"{}",WorkerLimits {timeout:Duration::from_millis(100),..Default::default()}).unwrap_err();
    assert!(error.contains("timed out")); assert!(start.elapsed()<Duration::from_secs(5));
    let mut command=Command::new("python3"); command.args(["-c","import sys,time;sys.stdout.write('x'*100000);sys.stdout.flush();time.sleep(20)"]);
    let error=run_worker(command,b"{}",WorkerLimits {max_output_bytes:256,..Default::default()}).unwrap_err();
    assert!(error.contains("output limit"));
    let mut command=Command::new("python3"); command.args(["-c","import time; time.sleep(20)"]);
    let error=run_worker(command,b"{}",WorkerLimits {max_memory_bytes:1,..Default::default()}).unwrap_err();
    assert!(error.contains("memory limit"));
}
