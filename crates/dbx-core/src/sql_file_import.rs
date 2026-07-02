use std::time::Instant;

use tokio_util::sync::CancellationToken;

use crate::connection::{AppState, PoolKind};
use crate::db;
use crate::models::connection::DatabaseType;
use crate::query::{
    execute_sql_statement_with_options, pool_error_action, wait_for_query_opt, DbOperationBudget, PoolErrorAction,
    QueryExecutionOptions,
};
use crate::sql::{
    optimize_sql_file_import_statements, prepare_sql_file_statement, statement_summary, SqlFileImportStatement,
    SqlFileImportStatementKind, SqlFileProgress, SqlFileRequest, SqlFileStatementAction, SqlFileStatus,
    SqlParsingOptions, SqlStatementSplitter,
};
use crate::types::QueryResult;

#[derive(Debug, Clone)]
struct SqlFileImportTarget {
    db_type: DatabaseType,
    driver_profile: Option<String>,
}

#[derive(Debug)]
struct StatementErrorDecision {
    progress: Vec<SqlFileProgress>,
    failure_count: usize,
    result: Result<bool, String>,
}

struct MySqlSqlFileExecutor {
    connection_id: String,
    database: String,
    pool_key: String,
    db_type: Option<DatabaseType>,
    bare: bool,
    dialect: db::mysql::MySqlQueryDialect,
    budget: DbOperationBudget,
    conn: Option<mysql_async::Conn>,
}

impl MySqlSqlFileExecutor {
    async fn build(
        state: &AppState,
        request: &SqlFileRequest,
        import_target: Option<&SqlFileImportTarget>,
    ) -> Result<Option<Self>, String> {
        let Some(target) = import_target else {
            return Ok(None);
        };
        if !crate::sql::supports_connection_level_database_bootstrap_target(
            &target.db_type,
            target.driver_profile.as_deref(),
        ) {
            return Ok(None);
        }

        let database = request.database.trim();
        let database = (!database.is_empty()).then_some(database);
        let pool_key = state.get_or_create_pool_for_session(&request.connection_id, database, None).await?;
        let (db_type, driver_profile, bare) = {
            let connections = state.connections.read().await;
            let Some(PoolKind::Mysql(_, mode)) = connections.get(&pool_key) else {
                return Ok(None);
            };
            (Some(target.db_type), target.driver_profile.as_deref(), *mode == crate::connection::MysqlMode::Bare)
        };
        let budget = {
            let configs = state.configs.read().await;
            let config = configs.get(&request.connection_id).ok_or("Connection config not found")?;
            DbOperationBudget::from_connection_config(config)
        };

        Ok(Some(Self {
            connection_id: request.connection_id.clone(),
            database: request.database.clone(),
            pool_key,
            db_type,
            bare,
            dialect: db::mysql::MySqlQueryDialect::for_connection(
                db_type.unwrap_or(DatabaseType::Mysql),
                driver_profile,
            ),
            budget,
            conn: None,
        }))
    }

    async fn execute_statement(
        &mut self,
        state: &AppState,
        request: &SqlFileRequest,
        sql: &str,
        token: &CancellationToken,
        statement_index: usize,
    ) -> Result<QueryResult, String> {
        let execution_id = sql_file_statement_execution_id(&request.execution_id, statement_index);
        let registered = state.running_queries.register(execution_id.clone());
        let child_token = registered.token();
        let cancel_task = {
            let parent_token = token.clone();
            let running_queries = state.running_queries.clone();
            let execution_id = execution_id.clone();
            tokio::spawn(async move {
                parent_token.cancelled().await;
                running_queries.cancel(&execution_id);
            })
        };

        let result = self.execute_statement_inner(state, sql, &child_token, &execution_id).await;

        cancel_task.abort();
        result
    }

    async fn execute_statement_inner(
        &mut self,
        state: &AppState,
        sql: &str,
        child_token: &CancellationToken,
        execution_id: &str,
    ) -> Result<QueryResult, String> {
        // Mirror `execute_sql_statement_with_options`: on a transient
        // connection error the pool is reconnected and the statement is
        // retried once instead of failing the whole import. The pinned
        // connection is re-acquired from the fresh pool by `ensure_conn` on
        // each attempt, so `USE`/session state is re-established via the
        // tracked `self.database` before the retry runs.
        for attempt in 0..2 {
            self.ensure_conn(state, child_token).await?;
            state.running_queries.set_pool_key(execution_id, self.pool_key.clone());
            state.touch_pool_activity(&self.pool_key).await;
            let _activity_touch = state.pool_activity_touch(&self.pool_key);

            let conn = self.conn.as_mut().ok_or("MySQL SQL file executor is missing a connection".to_string())?;
            let connection_id = conn.id();
            let kill_opts = conn.opts().clone();
            state.running_queries.register_interrupt(execution_id, move || {
                let kill_opts = kill_opts.clone();
                tokio::spawn(async move {
                    if let Err(error) = db::mysql::kill_query_with_opts(kill_opts, connection_id).await {
                        log::warn!("Failed to cancel MySQL SQL file import query {connection_id}: {error}");
                    }
                });
            });

            let result = wait_for_query_opt(
                Some(child_token.clone()),
                self.budget.query_timeout,
                db::mysql::execute_query_on_conn_with_max_rows(conn, sql, self.bare, None, self.dialect),
            )
            .await;

            if result.is_ok() {
                // Reconnects should reopen the most recent `USE` target rather than
                // the request's initial database value.
                if let Some(database) = mysql_use_database_target(sql) {
                    self.database = database;
                }
                return result;
            }

            let action = pool_error_action(self.db_type, result.as_ref().unwrap_err());
            match action {
                PoolErrorAction::Keep => return result,
                PoolErrorAction::Discard => {
                    self.conn.take();
                    state.remove_pool_by_key(&self.pool_key).await;
                    return result;
                }
                PoolErrorAction::ReconnectAndRetry => {
                    self.conn.take();
                    if attempt == 0 && !child_token.is_cancelled() {
                        let database = self.database.trim();
                        let database = (!database.is_empty()).then_some(database);
                        self.pool_key = state.reconnect_pool_for_session(&self.connection_id, database, None).await?;
                        continue;
                    }
                    // Cancelled, or the retry itself failed with another
                    // reconnectable error: refresh the pool so the next
                    // statement starts from a clean connection, then surface
                    // the original error.
                    if !child_token.is_cancelled() {
                        let database = self.database.trim();
                        let database = (!database.is_empty()).then_some(database);
                        let _ = state.reconnect_pool_for_session(&self.connection_id, database, None).await;
                    }
                    return result;
                }
            }
        }
        unreachable!("MySQL SQL file executor retry loop runs at most twice")
    }

    async fn ensure_conn(&mut self, state: &AppState, token: &CancellationToken) -> Result<(), String> {
        if self.conn.is_some() {
            return Ok(());
        }

        let database = self.database.trim();
        let database = (!database.is_empty()).then_some(database);
        self.pool_key = state.get_or_create_pool_for_session(&self.connection_id, database, None).await?;
        let pool = {
            let connections = state.connections.read().await;
            match connections.get(&self.pool_key) {
                Some(PoolKind::Mysql(pool, _)) => pool.clone(),
                Some(_) => return Err("SQL file import expected a MySQL-compatible pooled connection".to_string()),
                None => return Err("Connection not found".to_string()),
            }
        };

        self.conn = Some(
            db::mysql::get_conn_with_health_check_with_cancel(
                &pool,
                self.budget.checkout_timeout,
                self.budget.cleanup_timeout,
                Some(token),
            )
            .await?,
        );
        Ok(())
    }
}

pub async fn execute_sql_file_content(
    state: &AppState,
    request: &SqlFileRequest,
    file_content: &str,
    token: CancellationToken,
    started_at: Instant,
    mut emit: impl FnMut(SqlFileProgress),
) -> Result<(), String> {
    let import_target = sql_file_import_target(state, &request.connection_id).await;
    let options =
        import_target.as_ref().map(|target| SqlParsingOptions::for_database_type(target.db_type)).unwrap_or_default();
    let mut splitter = SqlStatementSplitter::with_options(options);
    let mut statements = splitter.push_chunk(file_content);
    statements.extend(splitter.finish());

    let planned_statements = optimize_sql_file_import_statements(
        &statements,
        import_target.as_ref().map(|target| target.db_type),
        import_target.as_ref().and_then(|target| target.driver_profile.as_deref()),
    );
    // MySQL-family imports need one pinned connection so `USE` and session
    // state survive across the whole file.
    let mut mysql_executor = MySqlSqlFileExecutor::build(state, request, import_target.as_ref()).await?;
    execute_planned_statements_with_progress(
        state,
        request,
        &token,
        started_at,
        &planned_statements,
        mysql_executor.as_mut(),
        &mut emit,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub fn sql_file_progress(
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

pub fn sql_file_error_progress(execution_id: &str, started_at: Instant, error: String) -> SqlFileProgress {
    sql_file_progress(execution_id, SqlFileStatus::Error, 0, 0, 0, 0, started_at, "", Some(error))
}

async fn sql_file_import_target(state: &AppState, connection_id: &str) -> Option<SqlFileImportTarget> {
    let configs = state.configs.read().await;
    configs
        .get(connection_id)
        .map(|config| SqlFileImportTarget { db_type: config.db_type, driver_profile: config.driver_profile.clone() })
}

pub fn mysql_like_sql_file_can_execute_without_selected_database(file_content: &str) -> bool {
    let options = SqlParsingOptions::mysql_compatible();
    let mut splitter = SqlStatementSplitter::with_options(options);
    let mut statements = splitter.push_chunk(file_content);
    statements.extend(splitter.finish());

    let mut saw_statement = false;
    let mut has_database_context = false;

    for statement in statements {
        let prepared = match prepare_sql_file_statement(&statement, &DatabaseType::Mysql, None) {
            SqlFileStatementAction::Skip => continue,
            SqlFileStatementAction::Execute(sql) => sql,
        };
        let statement = strip_leading_sql_comments(&prepared, true).trim_start();
        if statement.is_empty() {
            continue;
        }

        // Keep preview gating aligned with the executor: setup statements may
        // run before the script establishes its own database context.
        saw_statement = true;
        let Some((keyword, remainder)) = leading_sql_keyword(statement) else {
            return false;
        };

        if keyword.eq_ignore_ascii_case("SET") {
            continue;
        }

        if mysql_use_database_target(statement).is_some() {
            has_database_context = true;
            continue;
        }

        if (keyword.eq_ignore_ascii_case("DROP") || keyword.eq_ignore_ascii_case("CREATE"))
            && leading_sql_keyword(remainder)
                .is_some_and(|(next, _)| next.eq_ignore_ascii_case("DATABASE") || next.eq_ignore_ascii_case("SCHEMA"))
        {
            continue;
        }

        if !has_database_context {
            return false;
        }
    }

    saw_statement
}

fn mysql_use_database_target(sql: &str) -> Option<String> {
    let sql = strip_leading_sql_comments(sql, true).trim_start();
    let rest = sql.get(..3).filter(|prefix| prefix.eq_ignore_ascii_case("USE")).and_then(|_| sql.get(3..))?;
    if rest.is_empty() || !rest.as_bytes()[0].is_ascii_whitespace() {
        return None;
    }

    let (database, remainder) = parse_mysql_identifier(rest.trim_start())?;
    sql_remainder_is_comment_only(remainder).then_some(database)
}

fn strip_leading_sql_comments(mut sql: &str, supports_hash_line_comments: bool) -> &str {
    loop {
        sql = sql.trim_start();
        if sql.is_empty() {
            return sql;
        }

        if let Some(rest) = sql.strip_prefix("--") {
            if let Some(idx) = rest.find('\n') {
                sql = &rest[idx + 1..];
                continue;
            }
            return "";
        }

        if supports_hash_line_comments {
            if let Some(rest) = sql.strip_prefix('#') {
                if let Some(idx) = rest.find('\n') {
                    sql = &rest[idx + 1..];
                    continue;
                }
                return "";
            }
        }

        if let Some(rest) = sql.strip_prefix("/*") {
            let Some(close) = rest.find("*/") else {
                return "";
            };
            sql = &rest[close + 2..];
            continue;
        }

        return sql;
    }
}

fn leading_sql_keyword(input: &str) -> Option<(&str, &str)> {
    let input = input.trim_start();
    let end = input.find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_')).unwrap_or(input.len());
    (end > 0).then_some((&input[..end], &input[end..]))
}

fn parse_mysql_identifier(input: &str) -> Option<(String, &str)> {
    let first = *input.as_bytes().first()?;
    match first {
        b'`' | b'"' => parse_mysql_doubled_delimited_identifier(input, first),
        b'[' => parse_mysql_bracket_identifier(input),
        _ => {
            let end = input.find(|c: char| c.is_whitespace() || c == ';').unwrap_or(input.len());
            let identifier = input[..end].trim();
            (!identifier.is_empty()).then_some((identifier.to_string(), &input[end..]))
        }
    }
}

fn parse_mysql_doubled_delimited_identifier(input: &str, quote: u8) -> Option<(String, &str)> {
    let bytes = input.as_bytes();
    let mut index = 1;
    let mut segment_start = 1;
    let mut identifier = String::new();

    while index < bytes.len() {
        if bytes[index] == quote {
            identifier.push_str(&input[segment_start..index]);
            if bytes.get(index + 1) == Some(&quote) {
                identifier.push(quote as char);
                index += 2;
                segment_start = index;
                continue;
            }
            return Some((identifier, &input[index + 1..]));
        }
        index += 1;
    }

    None
}

fn parse_mysql_bracket_identifier(input: &str) -> Option<(String, &str)> {
    let bytes = input.as_bytes();
    let mut index = 1;
    let mut segment_start = 1;
    let mut identifier = String::new();

    while index < bytes.len() {
        if bytes[index] == b']' {
            identifier.push_str(&input[segment_start..index]);
            if bytes.get(index + 1) == Some(&b']') {
                identifier.push(']');
                index += 2;
                segment_start = index;
                continue;
            }
            return Some((identifier, &input[index + 1..]));
        }
        index += 1;
    }

    None
}

fn sql_remainder_is_comment_only(mut remainder: &str) -> bool {
    loop {
        remainder = remainder.trim_start();
        if remainder.is_empty() {
            return true;
        }
        if let Some(rest) = remainder.strip_prefix(';') {
            remainder = rest;
            continue;
        }
        if remainder.starts_with("--") || remainder.starts_with('#') {
            return true;
        }
        if let Some(rest) = remainder.strip_prefix("/*") {
            let Some(close) = rest.find("*/") else {
                return false;
            };
            remainder = &rest[close + 2..];
            continue;
        }
        return false;
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute_planned_statements_with_progress(
    state: &AppState,
    request: &SqlFileRequest,
    token: &CancellationToken,
    started_at: Instant,
    planned_statements: &[SqlFileImportStatement],
    mut mysql_executor: Option<&mut MySqlSqlFileExecutor>,
    emit: &mut impl FnMut(SqlFileProgress),
) -> Result<(), String> {
    let mut statement_index = 0;
    let mut success_count = 0;
    let mut failure_count = 0;
    let mut affected_rows = 0;

    for planned_statement in planned_statements {
        if token.is_cancelled() {
            emit(sql_file_progress(
                &request.execution_id,
                SqlFileStatus::Cancelled,
                statement_index,
                success_count,
                failure_count,
                affected_rows,
                started_at,
                "",
                None,
            ));
            return Ok(());
        }

        let next_statement_index = statement_index + planned_statement.source_statement_count;
        if execute_statement_with_progress(
            state,
            request,
            token,
            started_at,
            next_statement_index,
            planned_statement,
            &mut success_count,
            &mut failure_count,
            &mut affected_rows,
            mysql_executor.as_deref_mut(),
            emit,
        )
        .await?
        {
            return Ok(());
        }
        statement_index = next_statement_index;
    }

    emit(sql_file_progress(
        &request.execution_id,
        SqlFileStatus::Done,
        statement_index,
        success_count,
        failure_count,
        affected_rows,
        started_at,
        "",
        None,
    ));
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn execute_statement_with_progress(
    state: &AppState,
    request: &SqlFileRequest,
    token: &CancellationToken,
    started_at: Instant,
    statement_index: usize,
    statement: &SqlFileImportStatement,
    success_count: &mut usize,
    failure_count: &mut usize,
    affected_rows: &mut u64,
    mut mysql_executor: Option<&mut MySqlSqlFileExecutor>,
    emit: &mut impl FnMut(SqlFileProgress),
) -> Result<bool, String> {
    if token.is_cancelled() {
        let summary = statement_summary(&statement.sql);
        emit(sql_file_progress(
            &request.execution_id,
            SqlFileStatus::Cancelled,
            statement_index,
            *success_count,
            *failure_count,
            *affected_rows,
            started_at,
            &summary,
            None,
        ));
        return Ok(true);
    }

    if statement.kind == SqlFileImportStatementKind::Skip {
        let summary = statement_summary(&statement.sql);
        emit(sql_file_progress(
            &request.execution_id,
            SqlFileStatus::Running,
            statement_index,
            *success_count,
            *failure_count,
            *affected_rows,
            started_at,
            &summary,
            None,
        ));
        *success_count += statement.source_statement_count;
        emit(sql_file_progress(
            &request.execution_id,
            SqlFileStatus::StatementDone,
            statement_index,
            *success_count,
            *failure_count,
            *affected_rows,
            started_at,
            &summary,
            None,
        ));
        return Ok(false);
    }

    let summary = statement_summary(&statement.sql);
    emit(sql_file_progress(
        &request.execution_id,
        SqlFileStatus::Running,
        statement_index,
        *success_count,
        *failure_count,
        *affected_rows,
        started_at,
        &summary,
        None,
    ));

    let result = {
        let mysql_executor = mysql_executor.as_deref_mut();
        execute_sql_file_statement_with_executor(state, request, &statement.sql, token, statement_index, mysql_executor)
            .await
    };

    match result {
        Ok(result) => {
            *success_count += statement.source_statement_count;
            *affected_rows += result.affected_rows;
            emit(sql_file_progress(
                &request.execution_id,
                SqlFileStatus::StatementDone,
                statement_index,
                *success_count,
                *failure_count,
                *affected_rows,
                started_at,
                &summary,
                None,
            ));
            Ok(false)
        }
        Err(error) => {
            if statement.source_statement_count > 1 && !token.is_cancelled() {
                return execute_merged_statement_fallback_with_progress(
                    state,
                    request,
                    token,
                    started_at,
                    statement_index + 1 - statement.source_statement_count,
                    statement,
                    success_count,
                    failure_count,
                    affected_rows,
                    mysql_executor,
                    emit,
                )
                .await;
            }

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
                emit(progress);
            }
            decision.result
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute_merged_statement_fallback_with_progress(
    state: &AppState,
    request: &SqlFileRequest,
    token: &CancellationToken,
    started_at: Instant,
    first_statement_index: usize,
    statement: &SqlFileImportStatement,
    success_count: &mut usize,
    failure_count: &mut usize,
    affected_rows: &mut u64,
    mut mysql_executor: Option<&mut MySqlSqlFileExecutor>,
    emit: &mut impl FnMut(SqlFileProgress),
) -> Result<bool, String> {
    for (offset, source_sql) in statement.source_sqls.iter().enumerate() {
        let statement_index = first_statement_index + offset;
        if token.is_cancelled() {
            emit(sql_file_progress(
                &request.execution_id,
                SqlFileStatus::Cancelled,
                statement_index,
                *success_count,
                *failure_count,
                *affected_rows,
                started_at,
                &statement_summary(source_sql),
                None,
            ));
            return Ok(true);
        }

        let summary = statement_summary(source_sql);
        emit(sql_file_progress(
            &request.execution_id,
            SqlFileStatus::Running,
            statement_index,
            *success_count,
            *failure_count,
            *affected_rows,
            started_at,
            &summary,
            None,
        ));

        match execute_sql_file_statement_with_executor(
            state,
            request,
            source_sql,
            token,
            statement_index,
            mysql_executor.as_deref_mut(),
        )
        .await
        {
            Ok(result) => {
                *success_count += 1;
                *affected_rows += result.affected_rows;
                emit(sql_file_progress(
                    &request.execution_id,
                    SqlFileStatus::StatementDone,
                    statement_index,
                    *success_count,
                    *failure_count,
                    *affected_rows,
                    started_at,
                    &summary,
                    None,
                ));
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
                    emit(progress);
                }
                if decision.result? {
                    return Ok(true);
                }
            }
        }
    }

    Ok(false)
}

async fn execute_sql_file_statement_with_executor(
    state: &AppState,
    request: &SqlFileRequest,
    sql: &str,
    token: &CancellationToken,
    statement_index: usize,
    mysql_executor: Option<&mut MySqlSqlFileExecutor>,
) -> Result<QueryResult, String> {
    if let Some(mysql_executor) = mysql_executor {
        mysql_executor.execute_statement(state, request, sql, token, statement_index).await
    } else {
        execute_sql_file_statement(state, request, sql, token, statement_index).await
    }
}

async fn execute_sql_file_statement(
    state: &AppState,
    request: &SqlFileRequest,
    sql: &str,
    token: &CancellationToken,
    statement_index: usize,
) -> Result<QueryResult, String> {
    let execution_id = sql_file_statement_execution_id(&request.execution_id, statement_index);
    let registered = state.running_queries.register(execution_id.clone());
    let child_token = registered.token();
    let cancel_task = {
        let parent_token = token.clone();
        let running_queries = state.running_queries.clone();
        let execution_id = execution_id.clone();
        tokio::spawn(async move {
            parent_token.cancelled().await;
            running_queries.cancel(&execution_id);
        })
    };

    let result = execute_sql_statement_with_options(
        state,
        &request.connection_id,
        &request.database,
        sql,
        None,
        Some(child_token),
        QueryExecutionOptions { execution_id: Some(execution_id), ..Default::default() },
    )
    .await;

    cancel_task.abort();
    result
}

fn sql_file_statement_execution_id(parent_execution_id: &str, statement_index: usize) -> String {
    format!("{parent_execution_id}:statement:{statement_index}")
}

#[allow(clippy::too_many_arguments)]
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
        return StatementErrorDecision { progress: vec![statement_failed], failure_count, result: Ok(false) };
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

    StatementErrorDecision { progress: vec![statement_failed, terminal_error], failure_count, result: Err(error) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::connection::DatabaseType;

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
        let progress =
            sql_file_progress("exec-1", SqlFileStatus::StatementDone, 1, 1, 0, 3, Instant::now(), "select 1", None);

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

    #[test]
    fn supports_connection_level_database_bootstrap_for_mysql_like_targets() {
        assert!(crate::sql::supports_connection_level_database_bootstrap_target(&DatabaseType::Mysql, None));
        assert!(crate::sql::supports_connection_level_database_bootstrap_target(&DatabaseType::Doris, None));
        assert!(crate::sql::supports_connection_level_database_bootstrap_target(&DatabaseType::Goldendb, None));
        assert!(crate::sql::supports_connection_level_database_bootstrap_target(
            &DatabaseType::Mysql,
            Some("selectdb")
        ));
        assert!(crate::sql::supports_connection_level_database_bootstrap_target(
            &DatabaseType::Mysql,
            Some("oceanbase")
        ));
    }

    #[test]
    fn excludes_non_mysql_bootstrap_targets() {
        assert!(!crate::sql::supports_connection_level_database_bootstrap_target(&DatabaseType::Postgres, None));
        assert!(
            !crate::sql::supports_connection_level_database_bootstrap_target(&DatabaseType::ManticoreSearch, None,)
        );
        assert!(
            !crate::sql::supports_connection_level_database_bootstrap_target(&DatabaseType::OceanbaseOracle, None,)
        );
    }

    #[test]
    fn mysql_like_sql_file_without_selected_database_requires_bootstrap_context() {
        assert!(mysql_like_sql_file_can_execute_without_selected_database(
            "SET NAMES utf8mb4;\nCREATE DATABASE app_db;\n-- switch tenant\nUSE app_db;\nCREATE TABLE users(id INT)"
        ));
        assert!(!mysql_like_sql_file_can_execute_without_selected_database(
            "CREATE DATABASE app_db;\nCREATE TABLE users(id INT)"
        ));
        assert!(!mysql_like_sql_file_can_execute_without_selected_database(
            "CREATE DATABASE app_db;\nUSE app_db SELECT 1;\nCREATE TABLE users(id INT)"
        ));
    }

    #[test]
    fn parses_mysql_use_database_targets() {
        assert_eq!(mysql_use_database_target("USE app_db"), Some("app_db".to_string()));
        assert_eq!(mysql_use_database_target(" use `app-db` ; "), Some("app-db".to_string()));
        assert_eq!(mysql_use_database_target(r#"USE "tenant""01""#), Some(r#"tenant"01"#.to_string()));
        assert_eq!(mysql_use_database_target("USE [tenant]]01]"), Some("tenant]01".to_string()));
        assert_eq!(mysql_use_database_target("USE app_db; -- switch tenant"), Some("app_db".to_string()));
        assert_eq!(mysql_use_database_target("-- switch tenant\nUSE app_db"), Some("app_db".to_string()));
    }

    #[test]
    fn ignores_non_terminal_use_statements() {
        assert_eq!(mysql_use_database_target("SELECT 1"), None);
        assert_eq!(mysql_use_database_target("USE"), None);
        assert_eq!(mysql_use_database_target("USE app_db SELECT 1"), None);
    }
}
