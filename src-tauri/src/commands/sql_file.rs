use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use tauri::{AppHandle, Emitter, State};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use crate::commands::connection::AppState;
use dbx_core::sql_file_import::{execute_sql_file_content, sql_file_error_progress, sql_file_progress};

pub use dbx_core::sql::{decode_sql_file_bytes, SqlFilePreview, SqlFileRequest, SqlFileStatus};

static SQL_FILE_EXECUTIONS: OnceLock<RwLock<HashMap<String, CancellationToken>>> = OnceLock::new();

fn sql_file_executions() -> &'static RwLock<HashMap<String, CancellationToken>> {
    SQL_FILE_EXECUTIONS.get_or_init(|| RwLock::new(HashMap::new()))
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
struct SqlFileSummary {
    status: SqlFileStatus,
    success_count: usize,
    failure_count: usize,
    failed_statement_index: Option<usize>,
}

#[tauri::command]
pub async fn preview_sql_file(file_path: String) -> Result<SqlFilePreview, String> {
    let path = PathBuf::from(&file_path);
    let metadata = tokio::fs::metadata(&path).await.map_err(|e| e.to_string())?;
    let bytes = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
    let preview = decode_sql_file_bytes(&bytes)?.chars().take(20_000).collect();

    Ok(SqlFilePreview {
        file_name: path.file_name().and_then(|name| name.to_str()).unwrap_or("script.sql").to_string(),
        file_path,
        size_bytes: metadata.len(),
        preview,
    })
}

#[tauri::command]
pub async fn execute_sql_file(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: SqlFileRequest,
) -> Result<(), String> {
    let token = CancellationToken::new();
    {
        let mut executions = sql_file_executions().write().await;
        register_sql_file_execution(&mut executions, request.execution_id.clone(), token.clone())?;
    }

    let started_at = Instant::now();
    emit_progress(&app, &request.execution_id, SqlFileStatus::Started, 0, 0, 0, 0, started_at, "", None);

    let result = execute_sql_file_inner(&app, &state, &request, token, started_at).await;
    {
        let mut executions = sql_file_executions().write().await;
        remove_sql_file_execution(&mut executions, &request.execution_id);
    }
    result
}

#[tauri::command]
pub async fn cancel_sql_file_execution(execution_id: String) -> Result<bool, String> {
    let executions = sql_file_executions().read().await;
    if let Some(token) = executions.get(&execution_id) {
        token.cancel();
        Ok(true)
    } else {
        Ok(false)
    }
}

async fn execute_sql_file_inner(
    app: &AppHandle,
    state: &State<'_, Arc<AppState>>,
    request: &SqlFileRequest,
    token: CancellationToken,
    started_at: Instant,
) -> Result<(), String> {
    let file_bytes = match tokio::fs::read(&request.file_path).await {
        Ok(bytes) => bytes,
        Err(error) => {
            let error = error.to_string();
            emit_file_io_error_progress(app, &request.execution_id, started_at, error.clone());
            return Err(error);
        }
    };
    let file_content = match decode_sql_file_bytes(&file_bytes) {
        Ok(content) => content,
        Err(error) => {
            emit_file_io_error_progress(app, &request.execution_id, started_at, error.clone());
            return Err(error);
        }
    };

    execute_sql_file_content(state.inner().as_ref(), request, &file_content, token, started_at, |progress| {
        let _ = app.emit("sql-file-progress", progress);
    })
    .await
}

fn register_sql_file_execution(
    executions: &mut HashMap<String, CancellationToken>,
    execution_id: String,
    token: CancellationToken,
) -> Result<(), String> {
    if executions.contains_key(&execution_id) {
        return Err(format!("SQL file execution '{execution_id}' already exists"));
    }

    executions.insert(execution_id, token);
    Ok(())
}

fn remove_sql_file_execution(executions: &mut HashMap<String, CancellationToken>, execution_id: &str) {
    executions.remove(execution_id);
}

#[allow(clippy::too_many_arguments)]
fn emit_progress(
    app: &AppHandle,
    execution_id: &str,
    status: SqlFileStatus,
    statement_index: usize,
    success_count: usize,
    failure_count: usize,
    affected_rows: u64,
    started_at: Instant,
    statement_summary: &str,
    error: Option<String>,
) {
    let _ = app.emit(
        "sql-file-progress",
        sql_file_progress(
            execution_id,
            status,
            statement_index,
            success_count,
            failure_count,
            affected_rows,
            started_at,
            statement_summary,
            error,
        ),
    );
}

fn emit_file_io_error_progress(app: &AppHandle, execution_id: &str, started_at: Instant, error: String) {
    let _ = app.emit("sql-file-progress", sql_file_error_progress(execution_id, started_at, error));
}

#[cfg(test)]
async fn run_statements_for_test(
    statements: Vec<String>,
    continue_on_error: bool,
    token: CancellationToken,
    cancel_after_successes: Option<usize>,
) -> SqlFileSummary {
    let mut success_count = 0;
    let mut failure_count = 0;
    let mut failed_statement_index = None;

    for (idx, statement) in statements.iter().enumerate() {
        if token.is_cancelled() {
            return SqlFileSummary {
                status: SqlFileStatus::Cancelled,
                success_count,
                failure_count,
                failed_statement_index,
            };
        }

        if statement.starts_with("fail") {
            failure_count += 1;
            failed_statement_index = Some(idx + 1);
            if !continue_on_error {
                return SqlFileSummary {
                    status: SqlFileStatus::Error,
                    success_count,
                    failure_count,
                    failed_statement_index,
                };
            }
        } else {
            success_count += 1;
            if cancel_after_successes == Some(success_count) {
                token.cancel();
            }
        }
    }

    SqlFileSummary {
        status: if token.is_cancelled() { SqlFileStatus::Cancelled } else { SqlFileStatus::Done },
        success_count,
        failure_count,
        failed_statement_index,
    }
}

#[cfg(test)]
mod execution_tests {
    use super::*;
    use tokio_util::sync::CancellationToken;

    async fn run_fake_script(
        statements: Vec<String>,
        continue_on_error: bool,
        cancel_after_successes: Option<usize>,
    ) -> SqlFileSummary {
        let token = CancellationToken::new();
        run_statements_for_test(statements, continue_on_error, token, cancel_after_successes).await
    }

    #[tokio::test]
    async fn stops_on_first_failure_by_default() {
        let summary = run_fake_script(vec!["ok 1".into(), "fail 2".into(), "ok 3".into()], false, None).await;

        assert_eq!(summary.success_count, 1);
        assert_eq!(summary.failure_count, 1);
        assert_eq!(summary.status, SqlFileStatus::Error);
        assert_eq!(summary.failed_statement_index, Some(2));
    }

    #[tokio::test]
    async fn continues_after_failure_when_enabled() {
        let summary = run_fake_script(vec!["ok 1".into(), "fail 2".into(), "ok 3".into()], true, None).await;

        assert_eq!(summary.success_count, 2);
        assert_eq!(summary.failure_count, 1);
        assert_eq!(summary.status, SqlFileStatus::Done);
    }

    #[tokio::test]
    async fn cancellation_stops_before_next_statement() {
        let summary = run_fake_script(vec!["ok 1".into(), "ok 2".into(), "ok 3".into()], true, Some(1)).await;

        assert_eq!(summary.success_count, 1);
        assert_eq!(summary.status, SqlFileStatus::Cancelled);
    }

    #[test]
    fn file_io_errors_build_terminal_error_progress() {
        let progress = sql_file_error_progress("exec-1", Instant::now(), "read failed".to_string());

        assert_eq!(progress.execution_id, "exec-1");
        assert_eq!(progress.status, SqlFileStatus::Error);
        assert_eq!(progress.statement_index, 0);
        assert_eq!(progress.success_count, 0);
        assert_eq!(progress.failure_count, 0);
        assert_eq!(progress.affected_rows, 0);
        assert_eq!(progress.statement_summary, "");
        assert_eq!(progress.error, Some("read failed".to_string()));
    }

    #[test]
    fn duplicate_execution_id_is_rejected_without_replacing_token() {
        let mut executions = HashMap::new();
        let original = CancellationToken::new();
        let replacement = CancellationToken::new();
        executions.insert("dup".to_string(), original.clone());

        let result = register_sql_file_execution(&mut executions, "dup".to_string(), replacement.clone());

        assert_eq!(result.unwrap_err(), "SQL file execution 'dup' already exists");
        assert_eq!(executions.len(), 1);

        executions.get("dup").unwrap().cancel();
        assert!(original.is_cancelled());
        assert!(!replacement.is_cancelled());
    }
}
