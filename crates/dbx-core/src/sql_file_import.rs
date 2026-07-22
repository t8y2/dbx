use std::path::Path;
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, BufReader};
use tokio_util::sync::CancellationToken;

use crate::connection::{AppState, PoolKind};
use crate::db;
use crate::models::connection::DatabaseType;
use crate::query::{
    execute_sql_statement_with_options, pool_error_action, wait_for_query_opt, DbOperationBudget, PoolErrorAction,
    QueryExecutionOptions,
};
use crate::sql::{
    optimize_sql_file_import_statements, prepare_sql_file_statement, split_sql_batches, statement_summary,
    SqlFileImportStatement, SqlFileImportStatementKind, SqlFileProgress, SqlFileRequest, SqlFileStatementAction,
    SqlFileStatus, SqlParsingOptions, SqlStatementSplitter,
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

const SQL_FILE_READ_CHUNK_BYTES: usize = 256 * 1024;
const SQL_FILE_STATEMENT_BATCH_SIZE: usize = 256;
const SQL_FILE_PREVIEW_ENCODING_SAMPLE_BYTES: usize = 1024 * 1024;
const SQL_FILE_PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);

pub struct SqlFileProgressEmitter<F, C = fn() -> Instant> {
    emit: F,
    now: C,
    last_regular_emit_at: Option<Instant>,
    pending_regular: Option<SqlFileProgress>,
}

impl<F> SqlFileProgressEmitter<F>
where
    F: FnMut(SqlFileProgress),
{
    pub fn new(emit: F) -> Self {
        Self::with_clock(emit, Instant::now)
    }
}

impl<F, C> SqlFileProgressEmitter<F, C>
where
    F: FnMut(SqlFileProgress),
    C: FnMut() -> Instant,
{
    fn with_clock(emit: F, now: C) -> Self {
        Self { emit, now, last_regular_emit_at: None, pending_regular: None }
    }

    pub fn emit(&mut self, progress: SqlFileProgress) {
        if sql_file_progress_is_immediate(progress.status) {
            // Preserve ordering and final counters before terminal or failure events.
            self.flush_pending();
            (self.emit)(progress);
            return;
        }

        self.pending_regular = Some(progress);
        let now = (self.now)();
        if self
            .last_regular_emit_at
            .is_none_or(|last_emit_at| now.duration_since(last_emit_at) >= SQL_FILE_PROGRESS_EMIT_INTERVAL)
        {
            self.flush_pending_at(now);
        }
    }

    fn flush_pending(&mut self) {
        if self.pending_regular.is_none() {
            return;
        }
        let now = (self.now)();
        self.flush_pending_at(now);
    }

    fn flush_pending_at(&mut self, now: Instant) {
        if let Some(progress) = self.pending_regular.take() {
            self.last_regular_emit_at = Some(now);
            (self.emit)(progress);
        }
    }
}

fn sql_file_progress_is_immediate(status: SqlFileStatus) -> bool {
    matches!(
        status,
        SqlFileStatus::Started
            | SqlFileStatus::StatementFailed
            | SqlFileStatus::Done
            | SqlFileStatus::Error
            | SqlFileStatus::Cancelled
    )
}

struct SqlFileExecutionProgress {
    statement_index: usize,
    success_count: usize,
    failure_count: usize,
    affected_rows: u64,
}

impl SqlFileExecutionProgress {
    fn new() -> Self {
        Self { statement_index: 0, success_count: 0, failure_count: 0, affected_rows: 0 }
    }
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
    let statements =
        split_sql_file_import_statements(file_content, import_target.as_ref().map(|target| target.db_type));

    let planned_statements = optimize_sql_file_import_statements(
        &statements,
        import_target.as_ref().map(|target| target.db_type),
        import_target.as_ref().and_then(|target| target.driver_profile.as_deref()),
    );
    // MySQL-family imports need one pinned connection so `USE` and session
    // state survive across the whole file.
    let mut mysql_executor = MySqlSqlFileExecutor::build(state, request, import_target.as_ref()).await?;
    let mut progress = SqlFileExecutionProgress::new();
    execute_planned_statements_with_progress(
        state,
        request,
        &token,
        started_at,
        &planned_statements,
        mysql_executor.as_mut(),
        &mut progress,
        &mut emit,
    )
    .await?;
    emit_sql_file_terminal_progress(request, &token, started_at, &progress, &mut emit);
    Ok(())
}

pub async fn execute_sql_file_path(
    state: &AppState,
    request: &SqlFileRequest,
    file_path: &Path,
    token: CancellationToken,
    started_at: Instant,
    mut emit: impl FnMut(SqlFileProgress),
) -> Result<(), String> {
    let import_target = sql_file_import_target(state, &request.connection_id).await;
    let options =
        import_target.as_ref().map(|target| SqlParsingOptions::for_database_type(target.db_type)).unwrap_or_default();
    let mut splitter = StreamingSqlFileSplitter::new(import_target.as_ref().map(|target| target.db_type), options);
    let mut mysql_executor = MySqlSqlFileExecutor::build(state, request, import_target.as_ref()).await?;
    let mut progress = SqlFileExecutionProgress::new();
    let mut pending_statements = Vec::with_capacity(SQL_FILE_STATEMENT_BATCH_SIZE);
    let mut decoder = match SqlFileStreamDecoder::open(file_path).await {
        Ok(decoder) => decoder,
        Err(error) => {
            emit(sql_file_error_progress(&request.execution_id, started_at, error.clone()));
            return Err(error);
        }
    };

    loop {
        let chunk = match decoder.next_chunk().await {
            Ok(chunk) => chunk,
            Err(error) => {
                emit(sql_file_progress(
                    &request.execution_id,
                    SqlFileStatus::Error,
                    progress.statement_index,
                    progress.success_count,
                    progress.failure_count,
                    progress.affected_rows,
                    started_at,
                    "",
                    Some(error.clone()),
                ));
                return Err(error);
            }
        };
        let Some(chunk) = chunk else {
            break;
        };
        if token.is_cancelled() {
            emit_sql_file_terminal_progress(request, &token, started_at, &progress, &mut emit);
            return Ok(());
        }
        pending_statements.extend(splitter.push_chunk(&chunk));
        if pending_statements.len() >= SQL_FILE_STATEMENT_BATCH_SIZE {
            execute_sql_file_statement_batch(
                state,
                request,
                &token,
                started_at,
                &mut pending_statements,
                import_target.as_ref(),
                mysql_executor.as_mut(),
                &mut progress,
                &mut emit,
            )
            .await?;
        }
    }

    pending_statements.extend(splitter.finish());
    execute_sql_file_statement_batch(
        state,
        request,
        &token,
        started_at,
        &mut pending_statements,
        import_target.as_ref(),
        mysql_executor.as_mut(),
        &mut progress,
        &mut emit,
    )
    .await?;
    emit_sql_file_terminal_progress(request, &token, started_at, &progress, &mut emit);
    Ok(())
}

pub async fn read_sql_file_preview(file_path: &Path, max_chars: usize) -> Result<String, String> {
    let mut decoder =
        SqlFileStreamDecoder::open_with_detection_limit(file_path, Some(SQL_FILE_PREVIEW_ENCODING_SAMPLE_BYTES))
            .await?;
    let mut preview = String::new();
    while preview.chars().count() < max_chars {
        let Some(chunk) = decoder.next_chunk().await? else {
            break;
        };
        preview.push_str(&chunk);
    }
    Ok(preview.chars().take(max_chars).collect())
}

struct SqlFileStreamDecoder {
    reader: BufReader<tokio::fs::File>,
    decoder: encoding_rs::Decoder,
    pending_bytes: Vec<u8>,
    reached_eof: bool,
}

impl SqlFileStreamDecoder {
    async fn open(file_path: &Path) -> Result<Self, String> {
        Self::open_with_detection_limit(file_path, None).await
    }

    async fn open_with_detection_limit(file_path: &Path, detection_limit: Option<usize>) -> Result<Self, String> {
        let (encoding, bom_len) = detect_sql_file_encoding(file_path, detection_limit).await?;
        let mut file = tokio::fs::File::open(file_path).await.map_err(|error| error.to_string())?;
        let mut prefix = [0u8; 3];
        let prefix_len = file.read(&mut prefix).await.map_err(|error| error.to_string())?;
        let prefix = &prefix[..prefix_len];
        let mut pending_bytes = prefix[bom_len..].to_vec();
        pending_bytes.reserve(SQL_FILE_READ_CHUNK_BYTES);
        Ok(Self {
            reader: BufReader::with_capacity(SQL_FILE_READ_CHUNK_BYTES, file),
            decoder: encoding.new_decoder_without_bom_handling(),
            pending_bytes,
            reached_eof: false,
        })
    }

    async fn next_chunk(&mut self) -> Result<Option<String>, String> {
        if self.reached_eof && self.pending_bytes.is_empty() {
            return Ok(None);
        }
        while !self.reached_eof && self.pending_bytes.len() < SQL_FILE_READ_CHUNK_BYTES {
            let mut buffer = vec![0u8; SQL_FILE_READ_CHUNK_BYTES - self.pending_bytes.len()];
            let read = self.reader.read(&mut buffer).await.map_err(|error| error.to_string())?;
            if read == 0 {
                self.reached_eof = true;
                break;
            }
            self.pending_bytes.extend_from_slice(&buffer[..read]);
        }

        let mut output = String::with_capacity(
            self.decoder
                .max_utf8_buffer_length_without_replacement(self.pending_bytes.len())
                .unwrap_or(self.pending_bytes.len()),
        );
        let (result, read) =
            self.decoder.decode_to_string_without_replacement(&self.pending_bytes, &mut output, self.reached_eof);
        self.pending_bytes.drain(..read);
        match result {
            encoding_rs::DecoderResult::InputEmpty => Ok((!output.is_empty()).then_some(output)),
            encoding_rs::DecoderResult::OutputFull => Ok(Some(output)),
            encoding_rs::DecoderResult::Malformed(_, _) => Err("Unsupported or invalid SQL file encoding".to_string()),
        }
    }
}

async fn detect_sql_file_encoding(
    file_path: &Path,
    detection_limit: Option<usize>,
) -> Result<(&'static encoding_rs::Encoding, usize), String> {
    let mut file = tokio::fs::File::open(file_path).await.map_err(|error| error.to_string())?;
    let mut prefix = [0u8; 3];
    let prefix_len = file.read(&mut prefix).await.map_err(|error| error.to_string())?;
    let prefix = &prefix[..prefix_len];
    if prefix.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Ok((encoding_rs::UTF_8, 3));
    }
    if prefix.starts_with(&[0xFF, 0xFE]) {
        return Ok((encoding_rs::UTF_16LE, 2));
    }
    if prefix.starts_with(&[0xFE, 0xFF]) {
        return Ok((encoding_rs::UTF_16BE, 2));
    }

    // SQL dumps often begin with ASCII comments even when the remaining file
    // is GBK. Validate the entire stream as UTF-8 with bounded buffers before
    // falling back to the legacy GBK behavior.
    let mut decoder = encoding_rs::UTF_8.new_decoder_without_bom_handling();
    let mut input = prefix.to_vec();
    let mut inspected_bytes = prefix.len();
    let mut reached_eof = false;
    loop {
        let reached_detection_limit = detection_limit.is_some_and(|limit| inspected_bytes >= limit);
        if !reached_eof && !reached_detection_limit {
            let remaining =
                detection_limit.map(|limit| limit.saturating_sub(inspected_bytes)).unwrap_or(SQL_FILE_READ_CHUNK_BYTES);
            let mut buffer = vec![0u8; SQL_FILE_READ_CHUNK_BYTES.min(remaining.max(1))];
            let read = file.read(&mut buffer).await.map_err(|error| error.to_string())?;
            if read == 0 {
                reached_eof = true;
            } else {
                inspected_bytes += read;
                input.extend_from_slice(&buffer[..read]);
            }
        }
        let mut output = String::with_capacity(
            decoder.max_utf8_buffer_length_without_replacement(input.len()).unwrap_or(input.len()),
        );
        let (result, read) = decoder.decode_to_string_without_replacement(&input, &mut output, reached_eof);
        input.drain(..read);
        match result {
            encoding_rs::DecoderResult::Malformed(_, _) => return Ok((encoding_rs::GBK, 0)),
            encoding_rs::DecoderResult::InputEmpty if reached_eof || reached_detection_limit => {
                return Ok((encoding_rs::UTF_8, 0));
            }
            encoding_rs::DecoderResult::InputEmpty | encoding_rs::DecoderResult::OutputFull => {}
        }
    }
}

enum StreamingSqlFileSplitter {
    Statements(SqlStatementSplitter),
    SqlServerBatches(SqlServerBatchSplitter),
}

impl StreamingSqlFileSplitter {
    fn new(db_type: Option<DatabaseType>, options: SqlParsingOptions) -> Self {
        if db_type == Some(DatabaseType::SqlServer) {
            Self::SqlServerBatches(SqlServerBatchSplitter::default())
        } else {
            Self::Statements(SqlStatementSplitter::with_options(options))
        }
    }

    fn push_chunk(&mut self, chunk: &str) -> Vec<String> {
        match self {
            Self::Statements(splitter) => splitter.push_chunk(chunk),
            Self::SqlServerBatches(splitter) => splitter.push_chunk(chunk),
        }
    }

    fn finish(self) -> Vec<String> {
        match self {
            Self::Statements(splitter) => splitter.finish(),
            Self::SqlServerBatches(splitter) => splitter.finish(),
        }
    }
}

#[derive(Default)]
struct SqlServerBatchSplitter {
    batch: String,
    partial_line: String,
}

impl SqlServerBatchSplitter {
    fn push_chunk(&mut self, chunk: &str) -> Vec<String> {
        self.partial_line.push_str(chunk);
        let mut batches = Vec::new();
        while let Some(newline) = self.partial_line.find('\n') {
            let line = self.partial_line[..newline].trim_end_matches('\r').to_string();
            self.partial_line.drain(..=newline);
            self.push_line(&line, &mut batches);
        }
        batches
    }

    fn finish(mut self) -> Vec<String> {
        let mut batches = Vec::new();
        if !self.partial_line.is_empty() {
            let line = std::mem::take(&mut self.partial_line);
            self.push_line(line.trim_end_matches('\r'), &mut batches);
        }
        self.push_batch(&mut batches);
        batches
    }

    fn push_line(&mut self, line: &str, batches: &mut Vec<String>) {
        if line.trim().eq_ignore_ascii_case("go") {
            self.push_batch(batches);
        } else {
            self.batch.push_str(line);
            self.batch.push('\n');
        }
    }

    fn push_batch(&mut self, batches: &mut Vec<String>) {
        let batch = self.batch.trim();
        if !batch.is_empty() {
            batches.push(batch.to_string());
        }
        self.batch.clear();
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute_sql_file_statement_batch(
    state: &AppState,
    request: &SqlFileRequest,
    token: &CancellationToken,
    started_at: Instant,
    statements: &mut Vec<String>,
    import_target: Option<&SqlFileImportTarget>,
    mysql_executor: Option<&mut MySqlSqlFileExecutor>,
    progress: &mut SqlFileExecutionProgress,
    emit: &mut impl FnMut(SqlFileProgress),
) -> Result<(), String> {
    if statements.is_empty() {
        return Ok(());
    }
    let statements = std::mem::take(statements);
    let planned_statements = optimize_sql_file_import_statements(
        &statements,
        import_target.map(|target| target.db_type),
        import_target.and_then(|target| target.driver_profile.as_deref()),
    );
    execute_planned_statements_with_progress(
        state,
        request,
        token,
        started_at,
        &planned_statements,
        mysql_executor,
        progress,
        emit,
    )
    .await
}

fn emit_sql_file_terminal_progress(
    request: &SqlFileRequest,
    token: &CancellationToken,
    started_at: Instant,
    progress: &SqlFileExecutionProgress,
    emit: &mut impl FnMut(SqlFileProgress),
) {
    emit(sql_file_progress(
        &request.execution_id,
        if token.is_cancelled() { SqlFileStatus::Cancelled } else { SqlFileStatus::Done },
        progress.statement_index,
        progress.success_count,
        progress.failure_count,
        progress.affected_rows,
        started_at,
        "",
        None,
    ));
}

fn split_sql_file_import_statements(file_content: &str, db_type: Option<DatabaseType>) -> Vec<String> {
    if db_type == Some(DatabaseType::SqlServer) {
        // GO is a client-side batch delimiter, not T-SQL. SQL Server module DDL
        // must also remain a complete batch because procedure bodies contain semicolons.
        return split_sql_batches(file_content);
    }

    let options = db_type.map(SqlParsingOptions::for_database_type).unwrap_or_default();
    let mut splitter = SqlStatementSplitter::with_options(options);
    let mut statements = splitter.push_chunk(file_content);
    statements.extend(splitter.finish());
    statements
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

        // Connection-scoped SHOW (DATABASES, VARIABLES, PROCESSLIST, …) does not
        // need a selected schema. Object-scoped SHOW still fails at the server.
        if keyword.eq_ignore_ascii_case("SHOW") {
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
    progress: &mut SqlFileExecutionProgress,
    emit: &mut impl FnMut(SqlFileProgress),
) -> Result<(), String> {
    for planned_statement in planned_statements {
        if token.is_cancelled() {
            return Ok(());
        }

        let next_statement_index = progress.statement_index + planned_statement.source_statement_count;
        if execute_statement_with_progress(
            state,
            request,
            token,
            started_at,
            next_statement_index,
            planned_statement,
            &mut progress.success_count,
            &mut progress.failure_count,
            &mut progress.affected_rows,
            mysql_executor.as_deref_mut(),
            emit,
        )
        .await?
        {
            return Ok(());
        }
        progress.statement_index = next_statement_index;
    }
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
    use std::cell::Cell;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_SQL_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    async fn temporary_sql_file(bytes: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "dbx-sql-file-{}-{}.sql",
            std::process::id(),
            TEMP_SQL_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        tokio::fs::write(&path, bytes).await.unwrap();
        path
    }

    fn test_progress(status: SqlFileStatus, statement_index: usize) -> SqlFileProgress {
        SqlFileProgress {
            execution_id: "test-execution".to_string(),
            status,
            statement_index,
            success_count: statement_index,
            failure_count: 0,
            affected_rows: statement_index as u64,
            elapsed_ms: statement_index as u128,
            statement_summary: format!("statement {statement_index}"),
            error: None,
        }
    }

    #[test]
    fn progress_emitter_compresses_high_frequency_regular_events() {
        let base = Instant::now();
        let elapsed = Cell::new(Duration::ZERO);
        let mut emitted = Vec::new();
        {
            let mut emitter =
                SqlFileProgressEmitter::with_clock(|progress| emitted.push(progress), || base + elapsed.get());

            for statement_index in 1..=1_000 {
                elapsed.set(Duration::from_millis((statement_index - 1) as u64));
                emitter.emit(test_progress(SqlFileStatus::Running, statement_index));
                emitter.emit(test_progress(SqlFileStatus::StatementDone, statement_index));
            }
            emitter.emit(test_progress(SqlFileStatus::Done, 1_000));
        }

        let regular_count = emitted
            .iter()
            .filter(|progress| matches!(progress.status, SqlFileStatus::Running | SqlFileStatus::StatementDone))
            .count();
        assert_eq!(regular_count, 11);
        assert_eq!(emitted.last().unwrap().status, SqlFileStatus::Done);
        assert_eq!(emitted[emitted.len() - 2].statement_index, 1_000);
    }

    #[test]
    fn progress_emitter_sends_key_events_immediately() {
        let base = Instant::now();
        let elapsed = Cell::new(Duration::ZERO);
        let mut emitted = Vec::new();
        {
            let mut emitter =
                SqlFileProgressEmitter::with_clock(|progress| emitted.push(progress), || base + elapsed.get());

            for status in [
                SqlFileStatus::Started,
                SqlFileStatus::StatementFailed,
                SqlFileStatus::Error,
                SqlFileStatus::Cancelled,
                SqlFileStatus::Done,
            ] {
                emitter.emit(test_progress(status, 1));
            }
        }

        assert_eq!(
            emitted.iter().map(|progress| progress.status).collect::<Vec<_>>(),
            vec![
                SqlFileStatus::Started,
                SqlFileStatus::StatementFailed,
                SqlFileStatus::Error,
                SqlFileStatus::Cancelled,
                SqlFileStatus::Done,
            ]
        );
    }

    #[test]
    fn progress_emitter_flushes_latest_counters_before_terminal_event() {
        let base = Instant::now();
        let elapsed = Cell::new(Duration::ZERO);
        let mut emitted = Vec::new();
        {
            let mut emitter =
                SqlFileProgressEmitter::with_clock(|progress| emitted.push(progress), || base + elapsed.get());

            emitter.emit(test_progress(SqlFileStatus::Running, 1));
            elapsed.set(Duration::from_millis(10));
            emitter.emit(test_progress(SqlFileStatus::StatementDone, 2));
            emitter.emit(test_progress(SqlFileStatus::Done, 2));
        }

        assert_eq!(emitted.len(), 3);
        assert_eq!(emitted[1].status, SqlFileStatus::StatementDone);
        assert_eq!(emitted[1].statement_index, 2);
        assert_eq!(emitted[2].status, SqlFileStatus::Done);
    }

    #[test]
    fn progress_emitter_keeps_small_file_progress_timely() {
        let base = Instant::now();
        let mut emitted = Vec::new();
        {
            let mut emitter = SqlFileProgressEmitter::with_clock(|progress| emitted.push(progress), || base);
            emitter.emit(test_progress(SqlFileStatus::Started, 0));
            emitter.emit(test_progress(SqlFileStatus::Running, 1));
            emitter.emit(test_progress(SqlFileStatus::StatementDone, 1));
            emitter.emit(test_progress(SqlFileStatus::Done, 1));
        }

        assert_eq!(
            emitted.iter().map(|progress| progress.status).collect::<Vec<_>>(),
            vec![SqlFileStatus::Started, SqlFileStatus::Running, SqlFileStatus::StatementDone, SqlFileStatus::Done,]
        );
    }

    #[test]
    fn sqlserver_sql_file_splits_go_batches_without_sending_delimiters() {
        let statements = split_sql_file_import_statements(
            "CREATE TABLE dbo.items (id INT);\nGO\nINSERT INTO dbo.items VALUES (1);\nGO\nSELECT * FROM dbo.items;",
            Some(DatabaseType::SqlServer),
        );

        assert_eq!(
            statements,
            vec!["CREATE TABLE dbo.items (id INT);", "INSERT INTO dbo.items VALUES (1);", "SELECT * FROM dbo.items;"]
        );
        assert!(statements
            .iter()
            .all(|statement| !statement.lines().any(|line| line.trim().eq_ignore_ascii_case("go"))));
    }

    #[test]
    fn sqlserver_sql_file_keeps_module_body_in_one_batch() {
        let statements = split_sql_file_import_statements(
            "CREATE PROCEDURE dbo.demo AS\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND\nGO\nSELECT 3;",
            Some(DatabaseType::SqlServer),
        );

        assert_eq!(statements.len(), 2);
        assert_eq!(statements[0], "CREATE PROCEDURE dbo.demo AS\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND");
        assert_eq!(statements[1], "SELECT 3;");
    }

    #[test]
    fn streaming_sqlserver_splitter_handles_go_across_chunks() {
        let mut splitter = SqlServerBatchSplitter::default();
        let mut batches = splitter.push_chunk("CREATE PROCEDURE dbo.demo AS\nBEGIN\nSELECT 1;\nEND\nG");
        batches.extend(splitter.push_chunk("O\r\nSELECT 2;\nGO\n"));
        batches.extend(splitter.finish());

        assert_eq!(batches, vec!["CREATE PROCEDURE dbo.demo AS\nBEGIN\nSELECT 1;\nEND", "SELECT 2;"]);
    }

    #[tokio::test]
    async fn streaming_decoder_detects_gbk_after_ascii_prefix() {
        let (encoded, _, _) = encoding_rs::GBK.encode("-- Navicat dump\nINSERT INTO t VALUES ('中文');");
        let path = temporary_sql_file(encoded.as_ref()).await;
        let mut decoder = SqlFileStreamDecoder::open(&path).await.unwrap();
        let mut decoded = String::new();
        while let Some(chunk) = decoder.next_chunk().await.unwrap() {
            decoded.push_str(&chunk);
        }
        tokio::fs::remove_file(path).await.unwrap();

        assert_eq!(decoded, "-- Navicat dump\nINSERT INTO t VALUES ('中文');");
    }

    #[tokio::test]
    async fn streaming_decoder_preserves_utf16le_bom_files() {
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "SELECT '中文';".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let path = temporary_sql_file(&bytes).await;
        let mut decoder = SqlFileStreamDecoder::open(&path).await.unwrap();
        let mut decoded = String::new();
        while let Some(chunk) = decoder.next_chunk().await.unwrap() {
            decoded.push_str(&chunk);
        }
        tokio::fs::remove_file(path).await.unwrap();

        assert_eq!(decoded, "SELECT '中文';");
    }

    #[test]
    fn non_sqlserver_sql_file_keeps_statement_splitting_behavior() {
        assert_eq!(
            split_sql_file_import_statements("SELECT 1; SELECT 2;", Some(DatabaseType::Postgres)),
            vec!["SELECT 1", "SELECT 2"]
        );
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
        assert!(mysql_like_sql_file_can_execute_without_selected_database("SHOW DATABASES"));
        assert!(mysql_like_sql_file_can_execute_without_selected_database(
            "SHOW SCHEMAS;\nSHOW VARIABLES LIKE 'version%'"
        ));
        assert!(!mysql_like_sql_file_can_execute_without_selected_database(
            "CREATE DATABASE app_db;\nCREATE TABLE users(id INT)"
        ));
        assert!(!mysql_like_sql_file_can_execute_without_selected_database(
            "SHOW DATABASES;\nCREATE TABLE users(id INT)"
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
