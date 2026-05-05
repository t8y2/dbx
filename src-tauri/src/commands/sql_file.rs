use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use crate::commands::connection::AppState;
use crate::commands::query::execute_sql_statement;

pub use dbx_core::sql::{
    statement_summary, SqlFilePreview, SqlFileProgress, SqlFileRequest,
    SqlFileStatus, SqlStatementSplitter,
};

static SQL_FILE_EXECUTIONS: std::sync::LazyLock<RwLock<HashMap<String, CancellationToken>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashMap::new()));

#[derive(Debug)]
struct StatementErrorDecision {
    progress: Vec<SqlFileProgress>,
    failure_count: usize,
    result: Result<bool, String>,
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
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| e.to_string())?;
    let mut file = tokio::fs::File::open(&path)
        .await
        .map_err(|e| e.to_string())?;
    let mut buffer = vec![0; 4096];
    let bytes_read = tokio::io::AsyncReadExt::read(&mut file, &mut buffer)
        .await
        .map_err(|e| e.to_string())?;
    buffer.truncate(bytes_read);
    let preview = String::from_utf8_lossy(&buffer).to_string();

    Ok(SqlFilePreview {
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("script.sql")
            .to_string(),
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
        let mut executions = SQL_FILE_EXECUTIONS.write().await;
        register_sql_file_execution(&mut executions, request.execution_id.clone(), token.clone())?;
    }

    let started_at = Instant::now();
    emit_progress(
        &app,
        &request.execution_id,
        SqlFileStatus::Started,
        0,
        0,
        0,
        0,
        started_at,
        "",
        None,
    );

    let result = execute_sql_file_inner(&app, &state, &request, token, started_at).await;
    {
        let mut executions = SQL_FILE_EXECUTIONS.write().await;
        remove_sql_file_execution(&mut executions, &request.execution_id);
    }
    result
}

#[tauri::command]
pub async fn cancel_sql_file_execution(execution_id: String) -> Result<bool, String> {
    let executions = SQL_FILE_EXECUTIONS.read().await;
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
    let mut statement_index = 0;
    let mut success_count = 0;
    let mut failure_count = 0;
    let mut affected_rows = 0;

    let file = match tokio::fs::File::open(&request.file_path).await {
        Ok(file) => file,
        Err(error) => {
            let error = error.to_string();
            emit_file_io_error_progress(
                app,
                &request.execution_id,
                statement_index,
                success_count,
                failure_count,
                affected_rows,
                started_at,
                error.clone(),
            );
            return Err(error);
        }
    };
    let mut reader = BufReader::new(file);
    let mut splitter = SqlStatementSplitter::default();
    let mut line = String::new();

    loop {
        if token.is_cancelled() {
            emit_progress(
                app,
                &request.execution_id,
                SqlFileStatus::Cancelled,
                statement_index,
                success_count,
                failure_count,
                affected_rows,
                started_at,
                "",
                None,
            );
            return Ok(());
        }

        line.clear();
        let bytes_read = match reader.read_line(&mut line).await {
            Ok(bytes_read) => bytes_read,
            Err(error) => {
                let error = error.to_string();
                emit_file_io_error_progress(
                    app,
                    &request.execution_id,
                    statement_index,
                    success_count,
                    failure_count,
                    affected_rows,
                    started_at,
                    error.clone(),
                );
                return Err(error);
            }
        };
        if bytes_read == 0 {
            break;
        }

        for statement in splitter.push_chunk(&line) {
            statement_index += 1;
            if execute_statement_with_progress(
                app,
                state,
                request,
                &token,
                started_at,
                statement_index,
                &statement,
                &mut success_count,
                &mut failure_count,
                &mut affected_rows,
            )
            .await?
            {
                return Ok(());
            }
        }
    }

    for statement in splitter.finish() {
        statement_index += 1;
        if execute_statement_with_progress(
            app,
            state,
            request,
            &token,
            started_at,
            statement_index,
            &statement,
            &mut success_count,
            &mut failure_count,
            &mut affected_rows,
        )
        .await?
        {
            return Ok(());
        }
    }

    emit_progress(
        app,
        &request.execution_id,
        SqlFileStatus::Done,
        statement_index,
        success_count,
        failure_count,
        affected_rows,
        started_at,
        "",
        None,
    );
    Ok(())
}

async fn execute_statement_with_progress(
    app: &AppHandle,
    state: &State<'_, Arc<AppState>>,
    request: &SqlFileRequest,
    token: &CancellationToken,
    started_at: Instant,
    statement_index: usize,
    statement: &str,
    success_count: &mut usize,
    failure_count: &mut usize,
    affected_rows: &mut u64,
) -> Result<bool, String> {
    let summary = statement_summary(statement);

    if token.is_cancelled() {
        emit_progress(
            app,
            &request.execution_id,
            SqlFileStatus::Cancelled,
            statement_index,
            *success_count,
            *failure_count,
            *affected_rows,
            started_at,
            &summary,
            None,
        );
        return Ok(true);
    }

    emit_progress(
        app,
        &request.execution_id,
        SqlFileStatus::Running,
        statement_index,
        *success_count,
        *failure_count,
        *affected_rows,
        started_at,
        &summary,
        None,
    );

    match execute_sql_statement(
        state.inner().as_ref(),
        &request.connection_id,
        &request.database,
        statement,
        Some(token.clone()),
    )
    .await
    {
        Ok(result) => {
            *success_count += 1;
            *affected_rows += result.affected_rows;
            emit_progress(
                app,
                &request.execution_id,
                SqlFileStatus::StatementDone,
                statement_index,
                *success_count,
                *failure_count,
                *affected_rows,
                started_at,
                &summary,
                None,
            );
            Ok(false)
        }
        Err(error) => {
            let decision = statement_error_decision(
                &request.execution_id,
                token,
                request.continue_on_error,
                started_at,
                statement_index,
                *success_count,
                *failure_count,
                *affected_rows,
                &summary,
                error,
            );

            *failure_count = decision.failure_count;
            for progress in decision.progress {
                let _ = app.emit("sql-file-progress", progress);
            }
            decision.result
        }
    }
}

fn register_sql_file_execution(
    executions: &mut HashMap<String, CancellationToken>,
    execution_id: String,
    token: CancellationToken,
) -> Result<(), String> {
    if executions.contains_key(&execution_id) {
        return Err(format!(
            "SQL file execution '{execution_id}' already exists"
        ));
    }

    executions.insert(execution_id, token);
    Ok(())
}

fn remove_sql_file_execution(
    executions: &mut HashMap<String, CancellationToken>,
    execution_id: &str,
) {
    executions.remove(execution_id);
}

fn statement_error_decision(
    execution_id: &str,
    token: &CancellationToken,
    continue_on_error: bool,
    started_at: Instant,
    statement_index: usize,
    success_count: usize,
    failure_count: usize,
    affected_rows: u64,
    summary: &str,
    error: String,
) -> StatementErrorDecision {
    if token.is_cancelled() {
        return StatementErrorDecision {
            progress: vec![sql_file_progress(
                execution_id,
                SqlFileStatus::Cancelled,
                statement_index,
                success_count,
                failure_count,
                affected_rows,
                started_at,
                summary,
                None,
            )],
            failure_count,
            result: Ok(true),
        };
    }

    let failure_count = failure_count + 1;
    let statement_failed = sql_file_progress(
        execution_id,
        SqlFileStatus::StatementFailed,
        statement_index,
        success_count,
        failure_count,
        affected_rows,
        started_at,
        summary,
        Some(error.clone()),
    );

    if continue_on_error {
        return StatementErrorDecision {
            progress: vec![statement_failed],
            failure_count,
            result: Ok(false),
        };
    }

    let terminal_error = sql_file_progress(
        execution_id,
        SqlFileStatus::Error,
        statement_index,
        success_count,
        failure_count,
        affected_rows,
        started_at,
        summary,
        Some(error.clone()),
    );

    StatementErrorDecision {
        progress: vec![statement_failed, terminal_error],
        failure_count,
        result: Err(error),
    }
}

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

fn emit_file_io_error_progress(
    app: &AppHandle,
    execution_id: &str,
    statement_index: usize,
    success_count: usize,
    failure_count: usize,
    affected_rows: u64,
    started_at: Instant,
    error: String,
) {
    let _ = app.emit(
        "sql-file-progress",
        file_io_error_progress(
            execution_id,
            statement_index,
            success_count,
            failure_count,
            affected_rows,
            started_at,
            error,
        ),
    );
}

fn file_io_error_progress(
    execution_id: &str,
    statement_index: usize,
    success_count: usize,
    failure_count: usize,
    affected_rows: u64,
    started_at: Instant,
    error: String,
) -> SqlFileProgress {
    sql_file_progress(
        execution_id,
        SqlFileStatus::Error,
        statement_index,
        success_count,
        failure_count,
        affected_rows,
        started_at,
        "",
        Some(error),
    )
}

fn sql_file_progress(
    execution_id: &str,
    status: SqlFileStatus,
    statement_index: usize,
    success_count: usize,
    failure_count: usize,
    affected_rows: u64,
    started_at: Instant,
    statement_summary: &str,
    error: Option<String>,
) -> SqlFileProgress {
    SqlFileProgress {
        execution_id: execution_id.to_string(),
        status,
        statement_index,
        success_count,
        failure_count,
        affected_rows,
        elapsed_ms: started_at.elapsed().as_millis(),
        statement_summary: statement_summary.to_string(),
        error,
    }
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
        status: if token.is_cancelled() {
            SqlFileStatus::Cancelled
        } else {
            SqlFileStatus::Done
        },
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
        let summary = run_fake_script(
            vec!["ok 1".into(), "fail 2".into(), "ok 3".into()],
            false,
            None,
        )
        .await;

        assert_eq!(summary.success_count, 1);
        assert_eq!(summary.failure_count, 1);
        assert_eq!(summary.status, SqlFileStatus::Error);
        assert_eq!(summary.failed_statement_index, Some(2));
    }

    #[tokio::test]
    async fn continues_after_failure_when_enabled() {
        let summary = run_fake_script(
            vec!["ok 1".into(), "fail 2".into(), "ok 3".into()],
            true,
            None,
        )
        .await;

        assert_eq!(summary.success_count, 2);
        assert_eq!(summary.failure_count, 1);
        assert_eq!(summary.status, SqlFileStatus::Done);
    }

    #[tokio::test]
    async fn cancellation_stops_before_next_statement() {
        let summary = run_fake_script(
            vec!["ok 1".into(), "ok 2".into(), "ok 3".into()],
            true,
            Some(1),
        )
        .await;

        assert_eq!(summary.success_count, 1);
        assert_eq!(summary.status, SqlFileStatus::Cancelled);
    }

    #[test]
    fn file_io_errors_build_terminal_error_progress() {
        let progress = file_io_error_progress(
            "exec-1",
            4,
            2,
            1,
            17,
            Instant::now(),
            "read failed".to_string(),
        );

        assert_eq!(progress.execution_id, "exec-1");
        assert_eq!(progress.status, SqlFileStatus::Error);
        assert_eq!(progress.statement_index, 4);
        assert_eq!(progress.success_count, 2);
        assert_eq!(progress.failure_count, 1);
        assert_eq!(progress.affected_rows, 17);
        assert_eq!(progress.statement_summary, "");
        assert_eq!(progress.error, Some("read failed".to_string()));
    }

    #[test]
    fn duplicate_execution_id_is_rejected_without_replacing_token() {
        let mut executions = HashMap::new();
        let original = CancellationToken::new();
        let replacement = CancellationToken::new();
        executions.insert("dup".to_string(), original.clone());

        let result =
            register_sql_file_execution(&mut executions, "dup".to_string(), replacement.clone());

        assert_eq!(
            result.unwrap_err(),
            "SQL file execution 'dup' already exists"
        );
        assert_eq!(executions.len(), 1);

        executions.get("dup").unwrap().cancel();
        assert!(original.is_cancelled());
        assert!(!replacement.is_cancelled());
    }

    #[test]
    fn stop_on_error_returns_err_with_terminal_error_progress() {
        let decision = statement_error_decision(
            "exec-1",
            &CancellationToken::new(),
            false,
            Instant::now(),
            3,
            1,
            0,
            5,
            "bad statement",
            "syntax error".to_string(),
        );

        assert_eq!(decision.failure_count, 1);
        assert_eq!(decision.result, Err("syntax error".to_string()));
        assert_eq!(decision.progress.len(), 2);
        assert_eq!(decision.progress[0].status, SqlFileStatus::StatementFailed);
        assert_eq!(decision.progress[1].status, SqlFileStatus::Error);
        assert_eq!(decision.progress[1].error, Some("syntax error".to_string()));
    }

    #[test]
    fn cancelled_in_flight_error_does_not_increment_failure_count() {
        let token = CancellationToken::new();
        token.cancel();

        let decision = statement_error_decision(
            "exec-1",
            &token,
            false,
            Instant::now(),
            2,
            1,
            4,
            9,
            "slow statement",
            "Query canceled".to_string(),
        );

        assert_eq!(decision.failure_count, 4);
        assert_eq!(decision.result, Ok(true));
        assert_eq!(decision.progress.len(), 1);
        assert_eq!(decision.progress[0].status, SqlFileStatus::Cancelled);
        assert_eq!(decision.progress[0].failure_count, 4);
        assert_eq!(decision.progress[0].error, None);
    }

    #[test]
    fn progress_payload_serializes_camel_case_status() {
        let progress = sql_file_progress(
            "exec-1",
            SqlFileStatus::StatementDone,
            1,
            1,
            0,
            3,
            Instant::now(),
            "select 1",
            None,
        );

        let value = serde_json::to_value(progress).unwrap();

        assert_eq!(value["executionId"], "exec-1");
        assert_eq!(value["statementIndex"], 1);
        assert_eq!(value["successCount"], 1);
        assert_eq!(value["failureCount"], 0);
        assert_eq!(value["affectedRows"], 3);
        assert_eq!(value["statementSummary"], "select 1");
        assert_eq!(value["status"], "statementDone");
        assert!(value.get("execution_id").is_none());
    }
}
