#![cfg(feature = "duckdb-bundled")]

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use dbx_core::db::duckdb_worker_process::DuckDbWorkerClient;
use dbx_core::db::duckdb_worker_protocol::{
    DuckDbWorkerConnectParams, DuckDbWorkerExecuteParams, DuckDbWorkerMethod, DuckDbWorkerRequest, DuckDbWorkerResponse,
};
use dbx_core::query_cancel::{RunningQueries, RunningTaskMetadata};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

static TEMP_DB_COUNTER: AtomicU64 = AtomicU64::new(0);

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_process_recovers_immediately_after_cancelled_long_query() {
    let _guard = duckdb_worker_process_test_guard().await;
    let executable = PathBuf::from(env!("CARGO_BIN_EXE_duckdb-worker-test-host"));
    let db_path = temp_duckdb_path();
    let _ = std::fs::remove_file(&db_path);

    let client =
        DuckDbWorkerClient::open_with_executable(executable, db_path.to_string_lossy().to_string(), Vec::new())
            .await
            .expect("worker process connects");

    let token = CancellationToken::new();
    let long_query = client.execute(
        None,
        "SELECT sum(sin(i::DOUBLE) * cos(i::DOUBLE / 3.0)) FROM range(100000000000) AS t(i)".to_string(),
        Some(10),
        Some(token.clone()),
        Some(Duration::from_secs(30)),
    );
    tokio::pin!(long_query);

    tokio::time::sleep(Duration::from_millis(200)).await;
    token.cancel();

    let cancelled = tokio::time::timeout(Duration::from_secs(5), &mut long_query)
        .await
        .expect("cancelled query should return promptly");
    assert_eq!(cancelled.expect_err("long query should be cancelled"), dbx_core::query::canceled_error());

    let probe = tokio::time::timeout(
        Duration::from_secs(5),
        client.execute(
            None,
            "SELECT 1 AS after_cancel_probe".to_string(),
            Some(10),
            None,
            Some(Duration::from_secs(5)),
        ),
    )
    .await
    .expect("probe query should not hang")
    .expect("probe query should succeed");

    assert_eq!(probe.columns, vec!["after_cancel_probe".to_string()]);
    assert_eq!(probe.rows, vec![vec![serde_json::json!(1)]]);

    client.shutdown().await;
    let _ = std::fs::remove_file(&db_path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_process_recovers_after_registered_cancel_interrupt() {
    let _guard = duckdb_worker_process_test_guard().await;
    let executable = PathBuf::from(env!("CARGO_BIN_EXE_duckdb-worker-test-host"));
    let db_path = temp_duckdb_path();
    let _ = std::fs::remove_file(&db_path);

    let client =
        DuckDbWorkerClient::open_with_executable(executable, db_path.to_string_lossy().to_string(), Vec::new())
            .await
            .expect("worker process connects");

    let running_queries = RunningQueries::default();
    let execution_id = "duckdb-worker-cancel-test";
    let registered = running_queries
        .register_task(execution_id.to_string(), RunningTaskMetadata::query("duckdb-conn", "main", None));
    let cancel_client = client.clone();
    running_queries.register_interrupt(execution_id, move || {
        let cancel_client = cancel_client.clone();
        tokio::spawn(async move {
            let _ = cancel_client.cancel().await;
        });
    });

    let long_query = client.execute(
        None,
        "SELECT sum(sin(i::DOUBLE) * cos(i::DOUBLE / 3.0)) FROM range(100000000000) AS t(i)".to_string(),
        Some(10),
        Some(registered.token()),
        Some(Duration::from_secs(30)),
    );
    tokio::pin!(long_query);

    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(running_queries.cancel(execution_id));

    let cancelled = tokio::time::timeout(Duration::from_secs(5), &mut long_query)
        .await
        .expect("cancelled query should return promptly");
    assert_eq!(cancelled.expect_err("long query should be cancelled"), dbx_core::query::canceled_error());
    drop(registered);

    let probe = tokio::time::timeout(
        Duration::from_secs(5),
        client.execute(
            None,
            "SELECT 1 AS after_cancel_probe".to_string(),
            Some(10),
            None,
            Some(Duration::from_secs(5)),
        ),
    )
    .await
    .expect("probe query should not hang")
    .expect("probe query should succeed");

    assert_eq!(probe.columns, vec!["after_cancel_probe".to_string()]);
    assert_eq!(probe.rows, vec![vec![serde_json::json!(1)]]);

    client.shutdown().await;
    let _ = std::fs::remove_file(&db_path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_process_recovers_after_parser_error() {
    let _guard = duckdb_worker_process_test_guard().await;
    let executable = PathBuf::from(env!("CARGO_BIN_EXE_duckdb-worker-test-host"));
    let db_path = temp_duckdb_path();
    let _ = std::fs::remove_file(&db_path);

    let client =
        DuckDbWorkerClient::open_with_executable(executable, db_path.to_string_lossy().to_string(), Vec::new())
            .await
            .expect("worker process connects");

    client
        .execute(
            None,
            "CREATE TABLE events (id INTEGER, name VARCHAR); INSERT INTO events VALUES (1, 'login');".to_string(),
            Some(10),
            None,
            Some(Duration::from_secs(5)),
        )
        .await
        .expect("create events table");

    let err = client
        .execute(None, "select * from table limit 19;".to_string(), Some(10), None, Some(Duration::from_secs(5)))
        .await
        .expect_err("reserved word query should fail");
    assert!(err.contains("Parser Error"), "unexpected error: {err}");

    let probe = tokio::time::timeout(
        Duration::from_secs(5),
        client.execute(
            None,
            "SELECT * FROM events LIMIT 100;".to_string(),
            Some(100),
            None,
            Some(Duration::from_secs(5)),
        ),
    )
    .await
    .expect("query after parser error should not hang")
    .expect("query after parser error should succeed");

    assert_eq!(probe.columns, vec!["id".to_string(), "name".to_string()]);
    assert_eq!(probe.rows, vec![vec![serde_json::json!(1), serde_json::json!("login")]]);

    client.shutdown().await;
    let _ = std::fs::remove_file(&db_path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_process_keeps_session_state_after_benign_error() {
    let _guard = duckdb_worker_process_test_guard().await;
    let executable = PathBuf::from(env!("CARGO_BIN_EXE_duckdb-worker-test-host"));
    let db_path = temp_duckdb_path();
    let _ = std::fs::remove_file(&db_path);

    let client =
        DuckDbWorkerClient::open_with_executable(executable, db_path.to_string_lossy().to_string(), Vec::new())
            .await
            .expect("worker process connects");

    // Temp tables live only in the worker's session. If a benign error restarted the
    // worker, this table would be gone after the error.
    client
        .execute(
            None,
            "CREATE TEMP TABLE scratch (id INTEGER); INSERT INTO scratch VALUES (7);".to_string(),
            Some(10),
            None,
            Some(Duration::from_secs(5)),
        )
        .await
        .expect("create temp table");

    // Catalog error: prepare succeeds, the query fails at bind/exec time. This does not
    // poison the connection, so the worker must stay alive and keep the temp table.
    let err = client
        .execute(None, "SELECT * FROM does_not_exist;".to_string(), Some(10), None, Some(Duration::from_secs(5)))
        .await
        .expect_err("missing table query should fail");
    assert!(err.contains("does_not_exist") || err.contains("Catalog Error"), "unexpected error: {err}");

    let probe = tokio::time::timeout(
        Duration::from_secs(5),
        client.execute(None, "SELECT id FROM scratch;".to_string(), Some(10), None, Some(Duration::from_secs(5))),
    )
    .await
    .expect("query after benign error should not hang")
    .expect("temp table should still exist after a benign error");

    assert_eq!(probe.columns, vec!["id".to_string()]);
    assert_eq!(probe.rows, vec![vec![serde_json::json!(7)]]);

    client.shutdown().await;
    let _ = std::fs::remove_file(&db_path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_process_exits_when_stdin_closes_during_active_query() {
    let _guard = duckdb_worker_process_test_guard().await;
    let executable = PathBuf::from(env!("CARGO_BIN_EXE_duckdb-worker-test-host"));
    let db_path = temp_duckdb_path();
    let _ = std::fs::remove_file(&db_path);
    let mut child = Command::new(executable)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn worker");
    let mut stdin = child.stdin.take().expect("worker stdin");
    let stdout = child.stdout.take().expect("worker stdout");
    let mut lines = BufReader::new(stdout).lines();

    write_worker_request(
        &mut stdin,
        DuckDbWorkerRequest::new(
            "connect",
            DuckDbWorkerMethod::Connect,
            DuckDbWorkerConnectParams { path: db_path.to_string_lossy().to_string(), attached_databases: Vec::new() },
        )
        .expect("connect request"),
    )
    .await;
    let connected = read_worker_response(&mut lines).await;
    assert!(connected.ok, "connect failed: {connected:?}");

    write_worker_request(
        &mut stdin,
        DuckDbWorkerRequest::new(
            "long-query",
            DuckDbWorkerMethod::Execute,
            DuckDbWorkerExecuteParams {
                sql: "SELECT sum(sin(i::DOUBLE) * cos(i::DOUBLE / 3.0)) FROM range(100000000000) AS t(i)".to_string(),
                database: None,
                max_rows: Some(10),
            },
        )
        .expect("execute request"),
    )
    .await;

    tokio::time::sleep(Duration::from_millis(200)).await;
    drop(stdin);

    tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .expect("worker should exit after stdin closes")
        .expect("wait for worker");
    let _ = std::fs::remove_file(&db_path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_process_is_killed_after_connect_timeout() {
    let _guard = duckdb_worker_process_test_guard().await;
    let executable = PathBuf::from(env!("CARGO_BIN_EXE_duckdb-worker-hanging-connect-test-host"));
    let db_path = temp_duckdb_path();
    let pid_file = temp_pid_path();
    let _ = std::fs::remove_file(&pid_file);
    let _ = std::fs::remove_file(&db_path);

    std::env::set_var("DBX_DUCKDB_HANGING_CONNECT_PID_FILE", &pid_file);
    let client = DuckDbWorkerClient::new_unconnected_with_timeouts(
        executable,
        db_path.to_string_lossy().to_string(),
        Vec::new(),
        4,
        Duration::from_secs(1),
        Duration::from_secs(5),
    );

    let err = client
        .execute(None, "SELECT 1".to_string(), Some(10), None, Some(Duration::from_secs(5)))
        .await
        .expect_err("connect should time out");
    std::env::remove_var("DBX_DUCKDB_HANGING_CONNECT_PID_FILE");
    assert!(err.contains("timed out"), "unexpected error: {err}");

    let pid = read_pid_file(&pid_file).expect("hanging worker pid");
    wait_until_process_exits(pid, Duration::from_secs(5)).await;

    let _ = std::fs::remove_file(&pid_file);
    let _ = std::fs::remove_file(&db_path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_process_is_killed_after_connect_error() {
    let _guard = duckdb_worker_process_test_guard().await;
    let executable = PathBuf::from(env!("CARGO_BIN_EXE_duckdb-worker-pid-test-host"));
    let missing_dir = temp_duckdb_path();
    let db_path = missing_dir.join("missing.duckdb");
    let pid_file = temp_pid_path();
    let _ = std::fs::remove_file(&pid_file);
    let _ = std::fs::remove_dir_all(&missing_dir);

    std::env::set_var("DBX_DUCKDB_PID_TEST_HOST_PID_FILE", &pid_file);
    let client = DuckDbWorkerClient::new_unconnected_with_timeouts(
        executable,
        db_path.to_string_lossy().to_string(),
        Vec::new(),
        4,
        Duration::from_secs(5),
        Duration::from_secs(5),
    );

    let err = client
        .execute(None, "SELECT 1".to_string(), Some(10), None, Some(Duration::from_secs(5)))
        .await
        .expect_err("connect should fail with an invalid DuckDB path");
    std::env::remove_var("DBX_DUCKDB_PID_TEST_HOST_PID_FILE");
    assert!(
        err.contains("Cannot open file")
            || err.contains("No such file")
            || err.contains("Parent directory does not exist")
            || err.contains("不存在"),
        "unexpected error: {err}"
    );

    let pid = read_pid_file(&pid_file).expect("worker pid");
    wait_until_process_exits(pid, Duration::from_secs(5)).await;

    let _ = std::fs::remove_file(&pid_file);
    let _ = std::fs::remove_dir_all(&missing_dir);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_process_retries_connect_after_transient_file_lock() {
    let _guard = duckdb_worker_process_test_guard().await;
    let executable = PathBuf::from(env!("CARGO_BIN_EXE_duckdb-worker-test-host"));
    let lock_owner_executable = PathBuf::from(env!("CARGO_BIN_EXE_duckdb-worker-file-lock-owner"));
    let db_path = temp_duckdb_path();
    let _ = std::fs::remove_file(&db_path);

    let mut lock_owner = Command::new(lock_owner_executable)
        .arg(&db_path)
        .arg("500")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn lock owner");
    let lock_owner_stdout = lock_owner.stdout.take().expect("lock owner stdout");
    let mut lock_owner_lines = BufReader::new(lock_owner_stdout).lines();
    let ready = tokio::time::timeout(Duration::from_secs(5), lock_owner_lines.next_line())
        .await
        .expect("lock owner ready timed out")
        .expect("read lock owner ready line")
        .expect("lock owner ready line");
    assert_eq!(ready, "ready");

    let client = DuckDbWorkerClient::new_unconnected_with_timeouts(
        executable,
        db_path.to_string_lossy().to_string(),
        Vec::new(),
        4,
        Duration::from_secs(5),
        Duration::from_secs(5),
    );
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        client.execute(None, "SELECT 42 AS retried".to_string(), Some(10), None, Some(Duration::from_secs(5))),
    )
    .await;

    tokio::time::timeout(Duration::from_secs(5), lock_owner.wait())
        .await
        .expect("lock owner should exit")
        .expect("wait for lock owner");
    client.shutdown().await;
    let _ = std::fs::remove_file(&db_path);

    let result = result
        .expect("retrying connect should not hang")
        .expect("connect should retry after a transient DuckDB file lock");
    assert_eq!(result.columns, vec!["retried".to_string()]);
    assert_eq!(result.rows, vec![vec![serde_json::json!(42)]]);
}

async fn write_worker_request(stdin: &mut tokio::process::ChildStdin, request: DuckDbWorkerRequest) {
    let line = serde_json::to_string(&request).expect("request json");
    stdin.write_all(line.as_bytes()).await.expect("write request");
    stdin.write_all(b"\n").await.expect("write newline");
    stdin.flush().await.expect("flush request");
}

async fn read_worker_response(
    lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
) -> DuckDbWorkerResponse {
    let line = tokio::time::timeout(Duration::from_secs(5), lines.next_line())
        .await
        .expect("worker response timed out")
        .expect("read worker response")
        .expect("worker response line");
    serde_json::from_str(&line).expect("parse worker response")
}

fn temp_duckdb_path() -> PathBuf {
    let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let pid = std::process::id();
    // These tests run concurrently; the counter prevents same-tick temp DB paths
    // from sharing a DuckDB file lock.
    let counter = TEMP_DB_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("dbx-duckdb-worker-process-{pid}-{suffix}-{counter}.duckdb"))
}

async fn duckdb_worker_process_test_guard() -> tokio::sync::MutexGuard<'static, ()> {
    static GUARD: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    GUARD.get_or_init(|| tokio::sync::Mutex::new(())).lock().await
}

fn temp_pid_path() -> PathBuf {
    let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let pid = std::process::id();
    let counter = TEMP_DB_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("dbx-duckdb-worker-process-{pid}-{suffix}-{counter}.pid"))
}

fn read_pid_file(path: &PathBuf) -> Option<u32> {
    for _ in 0..20 {
        if let Ok(contents) = std::fs::read_to_string(path) {
            if let Ok(pid) = contents.trim().parse::<u32>() {
                return Some(pid);
            }
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    None
}

async fn wait_until_process_exits(pid: u32, timeout: Duration) {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if !process_exists(pid) {
            return;
        }
        assert!(tokio::time::Instant::now() < deadline, "worker process {pid} should have been killed");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn process_exists(pid: u32) -> bool {
    let mut system =
        System::new_with_specifics(RefreshKind::new().with_processes(ProcessRefreshKind::new().with_memory()));
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[Pid::from(pid as usize)]),
        true,
        ProcessRefreshKind::new().with_memory(),
    );
    system.process(Pid::from(pid as usize)).is_some()
}
