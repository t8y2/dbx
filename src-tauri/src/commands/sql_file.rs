use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use tauri::{AppHandle, Emitter, State};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use crate::commands::connection::{ensure_connection_writable, AppState};
use dbx_core::sql_file_import::{
    execute_sql_file_paths, mysql_like_sql_file_bootstrap_analysis, read_sql_file_preview, sql_file_progress,
    SqlFileProgressEmitter,
};

pub use dbx_core::sql::{SqlFilePreview, SqlFileRequest, SqlFileStatus};

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
    let prefix = read_sql_file_preview(&path, 1_000_000).await?;
    let bootstrap_analysis = mysql_like_sql_file_bootstrap_analysis(&prefix);
    let preview = prefix.chars().take(20_000).collect();

    Ok(SqlFilePreview {
        file_name: path.file_name().and_then(|name| name.to_str()).unwrap_or("script.sql").to_string(),
        file_path,
        size_bytes: metadata.len(),
        preview,
        can_execute_without_selected_database: bootstrap_analysis.can_execute_without_selected_database,
        establishes_database_context: bootstrap_analysis.establishes_database_context,
    })
}

#[tauri::command]
pub async fn execute_sql_file(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: SqlFileRequest,
) -> Result<(), String> {
    execute_sql_files(app, state, request.clone(), vec![request.file_path.clone()]).await
}

#[tauri::command]
pub async fn execute_sql_files(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: SqlFileRequest,
    file_paths: Vec<String>,
) -> Result<(), String> {
    // Fast-fail: reject early if the connection is read-only (individual statements are also checked in do_execute)
    ensure_connection_writable(&state, &request.connection_id, "SQL file execution").await?;
    if file_paths.is_empty() {
        return Err("No SQL files selected".to_string());
    }
    let token = CancellationToken::new();
    {
        let mut executions = sql_file_executions().write().await;
        register_sql_file_execution(&mut executions, request.execution_id.clone(), token.clone())?;
    }

    let started_at = Instant::now();
    let result = execute_sql_files_inner(&app, &state, &request, &file_paths, token, started_at).await;
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

async fn execute_sql_files_inner(
    app: &AppHandle,
    state: &State<'_, Arc<AppState>>,
    request: &SqlFileRequest,
    file_paths: &[String],
    token: CancellationToken,
    started_at: Instant,
) -> Result<(), String> {
    let mut progress_emitter = SqlFileProgressEmitter::new(|progress| {
        let _ = app.emit("sql-file-progress", progress);
    });
    progress_emitter.emit(sql_file_progress(
        &request.execution_id,
        SqlFileStatus::Started,
        0,
        0,
        0,
        0,
        started_at,
        "",
        None,
    ));
    let paths: Vec<PathBuf> = file_paths.iter().map(PathBuf::from).collect();
    let path_refs: Vec<&std::path::Path> = paths.iter().map(PathBuf::as_path).collect();
    execute_sql_file_paths(state.inner().as_ref(), request, &path_refs, token, started_at, |progress| {
        progress_emitter.emit(progress);
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
