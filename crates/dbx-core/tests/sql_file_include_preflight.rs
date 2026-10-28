use dbx_core::connection::AppState;
use dbx_core::sql::{SqlFileRequest, SqlFileStatus};
use dbx_core::sql_file_import::execute_sql_file_path;
use std::path::Path;
use std::time::Instant;
use tokio_util::sync::CancellationToken;

fn request(path: &Path, enabled: bool) -> SqlFileRequest {
    serde_json::from_value(serde_json::json!({
        "executionId": "external-include-preflight", "connectionId": "not-configured",
        "database": "", "filePath": path, "continueOnError": false, "resolveIncludes": enabled
    }))
    .unwrap()
}

// No recursion_limit override: public async callers must compile with Rust's default.
#[tokio::test]
async fn missing_include_fails_before_dispatch_from_an_external_caller() {
    let directory = tempfile::tempdir().unwrap();
    let storage = dbx_core::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    let path = directory.path().join("main.sql");
    std::fs::write(&path, "CREATE TABLE never_dispatched(v INTEGER);\n-- @include missing.sql\n").unwrap();
    let mut events = Vec::new();
    let error = execute_sql_file_path(
        &state,
        &request(&path, true),
        &path,
        CancellationToken::new(),
        Instant::now(),
        |event| events.push(event),
    )
    .await
    .unwrap_err();
    assert!(error.contains("missing.sql"), "{error}");
    assert_eq!(events.last().unwrap().status, SqlFileStatus::Error);
    assert!(events.iter().all(|event| event.statement_index == 0));
    assert!(!events
        .iter()
        .any(|event| matches!(event.status, SqlFileStatus::StatementDone | SqlFileStatus::StatementFailed)));
}

#[tokio::test]
async fn external_caller_preserves_legacy_comments_and_nested_includes() {
    let directory = tempfile::tempdir().unwrap();
    let storage = dbx_core::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    let path = directory.path().join("main.sql");
    std::fs::write(&path, "-- @include shared/child.sql\n").unwrap();
    for enabled in [false, true] {
        if enabled {
            std::fs::create_dir(directory.path().join("shared")).unwrap();
            std::fs::write(directory.path().join("shared/child.sql"), "-- no database statements").unwrap();
        }
        let mut events = Vec::new();
        execute_sql_file_path(
            &state,
            &request(&path, enabled),
            &path,
            CancellationToken::new(),
            Instant::now(),
            |event| events.push(event),
        )
        .await
        .unwrap();
        let terminal = events.last().unwrap();
        assert_eq!(terminal.status, SqlFileStatus::Done);
        assert_eq!((terminal.success_count, terminal.failure_count), (0, 0));
    }
}

#[tokio::test]
async fn external_caller_cancels_preparation_without_dispatch() {
    let directory = tempfile::tempdir().unwrap();
    let storage = dbx_core::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    let path = directory.path().join("main.sql");
    std::fs::write(&path, "-- @include missing.sql\n").unwrap();
    let token = CancellationToken::new();
    token.cancel();
    let mut events = Vec::new();
    execute_sql_file_path(&state, &request(&path, true), &path, token, Instant::now(), |event| events.push(event))
        .await
        .unwrap();
    assert_eq!(events.last().unwrap().status, SqlFileStatus::Cancelled);
    assert!(events.iter().all(|event| event.statement_index == 0 && event.error.is_none()));
}
