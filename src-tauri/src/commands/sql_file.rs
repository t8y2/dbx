use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use crate::commands::connection::AppState;
use crate::commands::query::execute_sql_statement;

static SQL_FILE_EXECUTIONS: std::sync::LazyLock<RwLock<HashMap<String, CancellationToken>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashMap::new()));

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileRequest {
    pub execution_id: String,
    pub connection_id: String,
    pub database: String,
    pub file_path: String,
    pub continue_on_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFilePreview {
    pub file_name: String,
    pub file_path: String,
    pub size_bytes: u64,
    pub preview: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SqlFileStatus {
    Started,
    Running,
    StatementDone,
    StatementFailed,
    Done,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileProgress {
    pub execution_id: String,
    pub status: SqlFileStatus,
    pub statement_index: usize,
    pub success_count: usize,
    pub failure_count: usize,
    pub affected_rows: u64,
    pub elapsed_ms: u128,
    pub statement_summary: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SqlFileSummary {
    status: SqlFileStatus,
    success_count: usize,
    failure_count: usize,
    failed_statement_index: Option<usize>,
}

#[derive(Default)]
struct SqlStatementSplitter {
    buffer: String,
    in_single_quote: bool,
    in_double_quote: bool,
    in_backtick: bool,
    in_line_comment: bool,
    in_block_comment: bool,
    previous: Option<char>,
}

impl SqlStatementSplitter {
    fn push_chunk(&mut self, chunk: &str) -> Vec<String> {
        let mut statements = Vec::new();
        let mut chars = chunk.chars().peekable();

        while let Some(ch) = chars.next() {
            let next = chars.peek().copied();

            if self.in_line_comment {
                self.buffer.push(ch);
                if ch == '\n' {
                    self.in_line_comment = false;
                }
                self.previous = Some(ch);
                continue;
            }

            if self.in_block_comment {
                self.buffer.push(ch);
                if self.previous == Some('*') && ch == '/' {
                    self.in_block_comment = false;
                }
                self.previous = Some(ch);
                continue;
            }

            if !self.in_single_quote && !self.in_double_quote && !self.in_backtick {
                if self.previous == Some('-') && ch == '-' {
                    self.in_line_comment = true;
                    self.buffer.push(ch);
                    self.previous = Some(ch);
                    continue;
                }
                if self.previous == Some('/') && ch == '*' {
                    self.in_block_comment = true;
                    self.buffer.push(ch);
                    self.previous = Some(ch);
                    continue;
                }
                if ch == '-' && next == Some('-') {
                    self.in_line_comment = true;
                    self.buffer.push(ch);
                    self.previous = Some(ch);
                    continue;
                }
                if ch == '/' && next == Some('*') {
                    self.in_block_comment = true;
                    self.buffer.push(ch);
                    self.previous = Some(ch);
                    continue;
                }
            }

            match ch {
                '\'' if !self.in_double_quote
                    && !self.in_backtick
                    && self.previous != Some('\\') =>
                {
                    self.in_single_quote = !self.in_single_quote;
                    self.buffer.push(ch);
                }
                '"' if !self.in_single_quote
                    && !self.in_backtick
                    && self.previous != Some('\\') =>
                {
                    self.in_double_quote = !self.in_double_quote;
                    self.buffer.push(ch);
                }
                '`' if !self.in_single_quote && !self.in_double_quote => {
                    self.in_backtick = !self.in_backtick;
                    self.buffer.push(ch);
                }
                ';' if !self.in_single_quote && !self.in_double_quote && !self.in_backtick => {
                    self.push_current_statement(&mut statements);
                }
                _ => self.buffer.push(ch),
            }

            self.previous = Some(ch);
        }

        statements
    }

    fn finish(mut self) -> Vec<String> {
        let mut statements = Vec::new();
        self.push_current_statement(&mut statements);
        statements
    }

    fn push_current_statement(&mut self, statements: &mut Vec<String>) {
        let statement = self.buffer.trim();
        if !statement.is_empty() {
            statements.push(statement.to_string());
        }
        self.buffer.clear();
        self.previous = None;
    }
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
    SQL_FILE_EXECUTIONS
        .write()
        .await
        .insert(request.execution_id.clone(), token.clone());

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
    SQL_FILE_EXECUTIONS
        .write()
        .await
        .remove(&request.execution_id);
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
    let file = tokio::fs::File::open(&request.file_path)
        .await
        .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file);
    let mut splitter = SqlStatementSplitter::default();
    let mut line = String::new();
    let mut statement_index = 0;
    let mut success_count = 0;
    let mut failure_count = 0;
    let mut affected_rows = 0;

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
        let bytes_read = reader
            .read_line(&mut line)
            .await
            .map_err(|e| e.to_string())?;
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
            *failure_count += 1;
            emit_progress(
                app,
                &request.execution_id,
                SqlFileStatus::StatementFailed,
                statement_index,
                *success_count,
                *failure_count,
                *affected_rows,
                started_at,
                &summary,
                Some(error.clone()),
            );

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
                    Some(error),
                );
                return Ok(true);
            }

            if request.continue_on_error {
                Ok(false)
            } else {
                emit_progress(
                    app,
                    &request.execution_id,
                    SqlFileStatus::Error,
                    statement_index,
                    *success_count,
                    *failure_count,
                    *affected_rows,
                    started_at,
                    &summary,
                    Some(error),
                );
                Ok(true)
            }
        }
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
        },
    );
}

fn statement_summary(statement: &str) -> String {
    const MAX_LEN: usize = 120;

    let collapsed = statement.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= MAX_LEN {
        return collapsed;
    }

    collapsed.chars().take(MAX_LEN).collect()
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
fn split_sql_script(sql: &str) -> Result<Vec<String>, String> {
    let mut splitter = SqlStatementSplitter::default();
    let mut statements = splitter.push_chunk(sql);
    statements.extend(splitter.finish());
    Ok(statements)
}

#[cfg(test)]
mod tests {
    use super::{split_sql_script, SqlStatementSplitter};

    #[test]
    fn splits_semicolon_delimited_statements() {
        assert_eq!(
            split_sql_script("CREATE TABLE a(id int); INSERT INTO a VALUES (1);").unwrap(),
            vec!["CREATE TABLE a(id int)", "INSERT INTO a VALUES (1)"]
        );
    }

    #[test]
    fn ignores_semicolons_inside_quotes_and_comments() {
        let sql = "\
            INSERT INTO logs VALUES ('a;b', \"c;d\", `weird;name`);\n\
            -- comment ; ignored\n\
            /* block ; ignored */\n\
            SELECT 1;";
        assert_eq!(
            split_sql_script(sql).unwrap(),
            vec![
                "INSERT INTO logs VALUES ('a;b', \"c;d\", `weird;name`)",
                "-- comment ; ignored\n/* block ; ignored */\nSELECT 1",
            ]
        );
    }

    #[test]
    fn emits_trailing_statement_without_semicolon() {
        assert_eq!(
            split_sql_script("CREATE TABLE a(id int);\nINSERT INTO a VALUES (1)").unwrap(),
            vec!["CREATE TABLE a(id int)", "INSERT INTO a VALUES (1)"]
        );
    }

    #[test]
    fn line_comment_openers_can_span_chunks() {
        let mut splitter = SqlStatementSplitter::default();

        assert_eq!(splitter.push_chunk("SELECT 1; -"), vec!["SELECT 1"]);
        assert_eq!(
            splitter.push_chunk("- comment ; ignored\nSELECT 2;"),
            vec!["-- comment ; ignored\nSELECT 2"]
        );
        assert_eq!(splitter.finish(), Vec::<String>::new());
    }

    #[test]
    fn block_comment_openers_can_span_chunks() {
        let mut splitter = SqlStatementSplitter::default();

        assert_eq!(splitter.push_chunk("SELECT 1; /"), vec!["SELECT 1"]);
        assert_eq!(
            splitter.push_chunk("* comment ; ignored */\nSELECT 2;"),
            vec!["/* comment ; ignored */\nSELECT 2"]
        );
        assert_eq!(splitter.finish(), Vec::<String>::new());
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
}
