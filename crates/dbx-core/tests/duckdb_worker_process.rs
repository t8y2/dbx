#![cfg(feature = "duckdb-bundled")]

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use dbx_core::db::duckdb_worker_process::DuckDbWorkerClient;
use dbx_core::query_cancel::{RunningQueries, RunningTaskMetadata};
use tokio_util::sync::CancellationToken;

static TEMP_DB_COUNTER: AtomicU64 = AtomicU64::new(0);

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_process_recovers_immediately_after_cancelled_long_query() {
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

fn temp_duckdb_path() -> PathBuf {
    let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let pid = std::process::id();
    // These tests run concurrently; the counter prevents same-tick temp DB paths
    // from sharing a DuckDB file lock.
    let counter = TEMP_DB_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("dbx-duckdb-worker-process-{pid}-{suffix}-{counter}.duckdb"))
}
