use std::io::Read as StdRead;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use mysql_async::prelude::Queryable;
use tokio::io::{AsyncReadExt, BufReader};
use tokio_util::sync::CancellationToken;

use crate::connection::{AppState, PoolKind};
use crate::db;
use crate::models::connection::DatabaseType;

pub const DEFAULT_SQL_FILE_UPLOAD_MAX_MB: u32 = 200;
pub const MAX_SQL_FILE_UPLOAD_MAX_MB: u32 = 4096;

pub fn clamp_sql_file_upload_max_mb(value: u32) -> u32 {
    value.clamp(1, MAX_SQL_FILE_UPLOAD_MAX_MB)
}
use crate::query::{
    execute_in_manual_transaction, execute_sql_statement_with_options, keep_manual_transaction_alive,
    pool_error_action, rollback_manual_transaction, wait_for_query_opt, DbOperationBudget, PoolErrorAction,
    QueryExecutionOptions,
};
use crate::sql::{
    optimize_sql_file_import_statements, prepare_sql_file_statement, split_sql_batches, statement_summary,
    SqlFileImportStatement, SqlFileImportStatementKind, SqlFilePhase, SqlFileProgress, SqlFileRequest,
    SqlFileStatementAction, SqlFileStatus, SqlParsingOptions, SqlStatementSplitter, SqlStatementWithControl,
};
use crate::types::QueryResult;

mod table_restore;
pub use table_restore::SqlFileTable;
use table_restore::TableRestoreFilter;

/// How the database compatibility mode used for SQL statement splitting was
/// resolved. `Option<String>` cannot express the difference between "this
/// database has no compatibility mode concept" and "the probe failed", and
/// conflating those silently downgraded openGauss A-mode PL/SQL splitting to
/// the plain PostgreSQL splitter.
#[derive(Debug, Clone, PartialEq, Eq)]
enum SqlCompatibilityMode {
    /// The database type has no compatibility-mode concept (non-openGauss).
    NotApplicable,
    /// The database is openGauss but the probe failed or the pool was
    /// unavailable. The parser must not fall back to PostgreSQL semantics;
    /// it uses the PL/SQL-capable openGauss profile so an A-mode package body
    /// is never split on its inner semicolons.
    Unknown,
    /// Probe succeeded; carries the catalog-reported mode (may be B/C/PG/...).
    Resolved(String),
}

impl SqlCompatibilityMode {
    /// The mode string for [`SqlParsingOptions::for_database_type_and_compatibility`],
    /// or `None` when the database has no mode concept or the mode is unknown.
    ///
    /// `None` is interpreted as "unknown openGauss" by the parser (see that
    /// function), which selects the conservative PL/SQL-capable profile.
    fn as_mode_str(&self) -> Option<&str> {
        match self {
            Self::Resolved(mode) => Some(mode.as_str()),
            Self::Unknown | Self::NotApplicable => None,
        }
    }
}

#[derive(Debug, Clone)]
struct SqlFileImportTarget {
    db_type: DatabaseType,
    driver_profile: Option<String>,
    compatibility_mode: SqlCompatibilityMode,
}

#[derive(Debug)]
struct StatementErrorDecision {
    progress: Vec<SqlFileProgress>,
    failure_count: usize,
    result: Result<bool, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ControlledSqlFileImportStatement {
    statement: SqlFileImportStatement,
    stop_on_error: bool,
}

pub(crate) const SQL_FILE_READ_CHUNK_BYTES: usize = 256 * 1024;
const SQL_FILE_STATEMENT_BATCH_SIZE: usize = 256;
const SQL_FILE_PREVIEW_ENCODING_SAMPLE_BYTES: usize = 1024 * 1024;
const SQL_FILE_PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);

struct SqlFileReadProgress {
    bytes_read: Arc<AtomicU64>,
    total_bytes: Option<u64>,
}

impl SqlFileReadProgress {
    async fn new(file_paths: &[&Path]) -> Self {
        let mut total_bytes = Some(0u64);
        for file_path in file_paths {
            let size = tokio::fs::metadata(file_path).await.ok().filter(|metadata| metadata.is_file());
            total_bytes = total_bytes.and_then(|total| total.checked_add(size?.len()));
            if total_bytes.is_none() {
                break;
            }
        }
        Self { bytes_read: Arc::new(AtomicU64::new(0)), total_bytes }
    }

    fn attach(&self, mut progress: SqlFileProgress) -> SqlFileProgress {
        progress.bytes_read = Some(self.bytes_read.load(Ordering::Relaxed));
        progress.total_bytes = self.total_bytes;
        progress.phase = match progress.status {
            SqlFileStatus::Done | SqlFileStatus::Error | SqlFileStatus::Cancelled => None,
            SqlFileStatus::Started => Some(SqlFilePhase::Preparing),
            SqlFileStatus::Running if progress.file_index.is_some() => Some(SqlFilePhase::Preparing),
            _ if progress.statement_summary.is_empty() => Some(SqlFilePhase::Reading),
            _ => Some(SqlFilePhase::Executing),
        };
        progress
    }
}

struct SqlFileCountingReader<Reader> {
    reader: Reader,
    bytes_read: Option<Arc<AtomicU64>>,
}

impl<Reader: StdRead> StdRead for SqlFileCountingReader<Reader> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let read = self.reader.read(buffer)?;
        if let Some(bytes_read) = &self.bytes_read {
            bytes_read.fetch_add(read as u64, Ordering::Relaxed);
        }
        Ok(read)
    }
}

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
        if sql_file_progress_is_immediate(progress.status) || progress.file_index.is_some() {
            // Preserve ordering and final counters before terminal or failure
            // events.  File-boundary events (file_index is Some) are also
            // emitted immediately so rapid multi-file runs don't lose per-file
            // summaries through throttling.
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
    constraints_disabled: bool,
}

impl MySqlSqlFileExecutor {
    async fn build(
        state: &AppState,
        request: &SqlFileRequest,
        import_target: Option<&SqlFileImportTarget>,
    ) -> Result<Option<Self>, String> {
        if request.txn_session_id.is_some() {
            return Ok(None);
        }
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
            let pool_handle = state.pool_handle(&pool_key).await;
            let Some(PoolKind::Mysql(_, mode)) = pool_handle.as_ref() else {
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
            constraints_disabled: false,
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
                        // A fresh session restores the server default FOREIGN_KEY_CHECKS = 1;
                        // re-issue the bypass so the remaining parts match the caller's toggle.
                        if self.constraints_disabled {
                            self.set_foreign_key_checks(state, child_token, false).await?;
                        }
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

    async fn set_foreign_key_checks(
        &mut self,
        state: &AppState,
        token: &CancellationToken,
        enabled: bool,
    ) -> Result<(), String> {
        self.ensure_conn(state, token).await?;
        let conn = self.conn.as_mut().ok_or("MySQL SQL file executor is missing a connection".to_string())?;
        conn.query_drop(if enabled { "SET FOREIGN_KEY_CHECKS = 1" } else { "SET FOREIGN_KEY_CHECKS = 0" })
            .await
            .map_err(|error| error.to_string())
    }

    async fn ensure_conn(&mut self, state: &AppState, token: &CancellationToken) -> Result<(), String> {
        if self.conn.is_some() {
            return Ok(());
        }

        let database = self.database.trim();
        let database = (!database.is_empty()).then_some(database);
        self.pool_key = state.get_or_create_pool_for_session(&self.connection_id, database, None).await?;
        let pool = {
            let pool_handle = state.pool_handle(&self.pool_key).await;
            match pool_handle.as_ref() {
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

/// Which database-family mechanism `skip_relational_constraints` uses. Unlike
/// MySQL's session-scoped `FOREIGN_KEY_CHECKS`, the PostgreSQL and SQL Server
/// mechanisms below are catalog-level (`ALTER TABLE ... DISABLE TRIGGER ALL` /
/// `NOCHECK CONSTRAINT ALL`): the effect is visible to every connection in the
/// pool immediately, so neither needs [`MySqlSqlFileExecutor`]'s pinned-connection
/// bookkeeping. Both are applied to every table in the database, not just the
/// tables referenced by the imported file, matching "temporarily disable
/// relational constraints" at the database scope the option describes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RelationalConstraintBypassKind {
    Mysql,
    Postgres,
    SqlServer,
}

fn relational_constraint_bypass_kind(target: &SqlFileImportTarget) -> Option<RelationalConstraintBypassKind> {
    if crate::sql::supports_connection_level_database_bootstrap_target(
        &target.db_type,
        target.driver_profile.as_deref(),
    ) {
        return Some(RelationalConstraintBypassKind::Mysql);
    }
    match target.db_type {
        DatabaseType::Postgres | DatabaseType::Gaussdb | DatabaseType::OpenGauss => {
            Some(RelationalConstraintBypassKind::Postgres)
        }
        DatabaseType::SqlServer => Some(RelationalConstraintBypassKind::SqlServer),
        _ => None,
    }
}

// `pg_tables` lists every table the connection can see, including system
// catalog tables owned by `pg_catalog`/`information_schema` (unlike
// `information_schema.tables`, it has no built-in system-schema filter). Those
// must be excluded explicitly or the loop fails trying to alter tables the
// user cannot own, aborting the whole bypass. Temp schemas are excluded for
// the same reason `POSTGRES_SCHEMA_INFOS_HIDE_SYSTEM_SQL` (schema.rs) does.
// Foreign tables and empty partitioned parents are intentionally out of
// scope: `DISABLE TRIGGER ALL` only matters for plain tables that can carry
// FK/RI triggers.
// Altering a table's triggers requires table ownership (or superuser). A
// multi-schema database can easily contain tables the importing role does not
// own; wrapping each ALTER in its own sub-transaction (BEGIN/EXCEPTION) means
// one inaccessible table is skipped instead of aborting the bypass — and the
// import it gates — for every table the role *can* alter. If every table hit
// `insufficient_privilege` (a common case: `DISABLE TRIGGER` also affects
// internal FK/RI triggers, which PostgreSQL restricts to the table owner or a
// superuser), the toggle would otherwise be a silent no-op the caller cannot
// distinguish from "there were no tables"; raise instead so the import fails
// loudly rather than running with constraints the user believed were disabled.
const POSTGRES_DISABLE_ALL_RELATIONAL_TRIGGERS_SQL: &str = "\
    DO $dbx_disable_constraints$ \
    DECLARE dbx_rel record; \
    DECLARE dbx_total integer := 0; \
    DECLARE dbx_disabled integer := 0; \
    BEGIN \
        FOR dbx_rel IN SELECT schemaname, tablename FROM pg_tables \
            WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') \
              AND schemaname NOT LIKE 'pg\\_temp\\_%' AND schemaname NOT LIKE 'pg\\_toast\\_temp\\_%' \
        LOOP \
            dbx_total := dbx_total + 1; \
            BEGIN \
                EXECUTE format('ALTER TABLE %I.%I DISABLE TRIGGER ALL', dbx_rel.schemaname, dbx_rel.tablename); \
                dbx_disabled := dbx_disabled + 1; \
            EXCEPTION WHEN insufficient_privilege THEN NULL; \
            END; \
        END LOOP; \
        IF dbx_total > 0 AND dbx_disabled = 0 THEN \
            RAISE EXCEPTION 'Could not disable relational constraints on any of % table(s): the connection role lacks owner/superuser privileges required to disable internal foreign-key triggers', dbx_total; \
        END IF; \
    END $dbx_disable_constraints$;";

const POSTGRES_ENABLE_ALL_RELATIONAL_TRIGGERS_SQL: &str = "\
    DO $dbx_enable_constraints$ \
    DECLARE dbx_rel record; \
    BEGIN \
        FOR dbx_rel IN SELECT schemaname, tablename FROM pg_tables \
            WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') \
              AND schemaname NOT LIKE 'pg\\_temp\\_%' AND schemaname NOT LIKE 'pg\\_toast\\_temp\\_%' \
        LOOP \
            BEGIN \
                EXECUTE format('ALTER TABLE %I.%I ENABLE TRIGGER ALL', dbx_rel.schemaname, dbx_rel.tablename); \
            EXCEPTION WHEN insufficient_privilege THEN NULL; \
            END; \
        END LOOP; \
    END $dbx_enable_constraints$;";

// `sys.tables`/`sys.schemas` (rather than the undocumented `sp_msforeachtable`)
// keeps this portable across on-prem SQL Server and Azure SQL Database.
// `is_ms_shipped = 0` excludes system tables that cannot carry FK constraints.
// `HAS_PERMS_BY_NAME(..., 'ALTER')` filters out tables the importing login
// cannot alter (e.g. a multi-schema database where it does not own every
// table) before building the batch, so one inaccessible table cannot abort
// a single `ALTER TABLE ... NOCHECK CONSTRAINT ALL` statement covering every
// table the login *can* alter.
const SQLSERVER_DISABLE_ALL_FOREIGN_KEYS_SQL: &str = "\
    DECLARE @dbx_fk_sql nvarchar(max) = N''; \
    SELECT @dbx_fk_sql = @dbx_fk_sql + N'ALTER TABLE ' + QUOTENAME(s.name) + N'.' + QUOTENAME(t.name) \
        + N' NOCHECK CONSTRAINT ALL;' \
    FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id \
    WHERE t.is_ms_shipped = 0 \
      AND HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(t.name), N'OBJECT', N'ALTER') = 1; \
    IF @dbx_fk_sql <> N'' EXEC sys.sp_executesql @dbx_fk_sql;";

// Restores enforcement for future writes with `WITH NOCHECK` (skips re-validating
// rows written while constraints were disabled) so re-enabling never fails or
// stalls on data an in-progress, possibly partial (continue-on-error) import left
// behind; that mirrors how `mysqldump`/`pg_restore`-style tools re-enable checks.
const SQLSERVER_ENABLE_ALL_FOREIGN_KEYS_SQL: &str = "\
    DECLARE @dbx_fk_sql nvarchar(max) = N''; \
    SELECT @dbx_fk_sql = @dbx_fk_sql + N'ALTER TABLE ' + QUOTENAME(s.name) + N'.' + QUOTENAME(t.name) \
        + N' WITH NOCHECK CHECK CONSTRAINT ALL;' \
    FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id \
    WHERE t.is_ms_shipped = 0 \
      AND HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(t.name), N'OBJECT', N'ALTER') = 1; \
    IF @dbx_fk_sql <> N'' EXEC sys.sp_executesql @dbx_fk_sql;";

async fn set_relational_constraints_enabled(
    state: &AppState,
    request: &SqlFileRequest,
    kind: RelationalConstraintBypassKind,
    token: &CancellationToken,
    enabled: bool,
) -> Result<(), String> {
    let sql = match (kind, enabled) {
        (RelationalConstraintBypassKind::Postgres, false) => POSTGRES_DISABLE_ALL_RELATIONAL_TRIGGERS_SQL,
        (RelationalConstraintBypassKind::Postgres, true) => POSTGRES_ENABLE_ALL_RELATIONAL_TRIGGERS_SQL,
        (RelationalConstraintBypassKind::SqlServer, false) => SQLSERVER_DISABLE_ALL_FOREIGN_KEYS_SQL,
        (RelationalConstraintBypassKind::SqlServer, true) => SQLSERVER_ENABLE_ALL_FOREIGN_KEYS_SQL,
        (RelationalConstraintBypassKind::Mysql, _) => {
            unreachable!("MySQL constraint bypass is handled by MySqlSqlFileExecutor, not this helper")
        }
    };
    execute_sql_statement_with_options(
        state,
        &request.connection_id,
        &request.database,
        sql,
        None,
        Some(token.clone()),
        QueryExecutionOptions::default(),
    )
    .await
    .map(|_| ())
}

async fn sql_file_transaction_schema(state: &AppState, request: &SqlFileRequest) -> Result<Option<String>, String> {
    let Some(session_id) = request.txn_session_id.as_deref() else {
        return Ok(None);
    };
    let sessions = state.transaction_sessions.read().await;
    let session =
        sessions.get(session_id).ok_or("SQL file transaction session not found; no statements were retried")?;
    if session.connection_id != request.connection_id || session.database != request.database {
        return Err("SQL file target does not match its manual transaction".to_string());
    }
    Ok(session.schema.clone())
}

async fn with_sql_file_transaction<T>(
    state: &AppState,
    request: &SqlFileRequest,
    token: &CancellationToken,
    execution: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let Some(session_id) = request.txn_session_id.as_deref() else {
        return execution.await;
    };
    sql_file_transaction_schema(state, request).await?;
    if request.continue_on_error || request.skip_relational_constraints {
        return Err("Manual SQL file execution cannot continue after an error or disable constraints".to_string());
    }
    let _keep_alive = keep_manual_transaction_alive(state, session_id).await?;
    let result = execution.await;
    let should_rollback =
        (result.is_err() || token.is_cancelled()) && state.transaction_sessions.read().await.contains_key(session_id);
    if should_rollback {
        // Never drop an in-flight database future on cancellation. Finish that
        // round trip, stop before the next statement, then roll back the session.
        if let Err(rollback_error) = rollback_manual_transaction(state, session_id).await {
            return Err(format!(
                "{}. Rollback failed: {rollback_error}",
                result.err().unwrap_or_else(|| "SQL file cancelled".to_string())
            ));
        }
    }
    result
}

pub async fn execute_sql_file_content(
    state: &AppState,
    request: &SqlFileRequest,
    file_content: &str,
    token: CancellationToken,
    started_at: Instant,
    emit: impl FnMut(SqlFileProgress),
) -> Result<(), String> {
    with_sql_file_transaction(
        state,
        request,
        &token,
        Box::pin(execute_sql_file_content_inner(state, request, file_content, token.clone(), started_at, emit)),
    )
    .await
}

async fn execute_sql_file_content_inner(
    state: &AppState,
    request: &SqlFileRequest,
    file_content: &str,
    token: CancellationToken,
    started_at: Instant,
    mut emit: impl FnMut(SqlFileProgress),
) -> Result<(), String> {
    let import_target = sql_file_import_target(state, &request.connection_id, &request.database).await;
    validate_table_restore_target(request, import_target.as_ref(), 1)?;
    let mut statements = split_sql_file_import_statements_with_control(
        file_content,
        import_target.as_ref().map(|target| target.db_type),
        import_target.as_ref().and_then(|target| target.compatibility_mode.as_mode_str()),
    );

    if let Some(selected) = &request.selected_tables {
        let mut scan = TableRestoreFilter::default();
        for statement in &statements {
            scan.inspect(&statement.sql)?;
        }
        let (tables, views) = scan.finish();
        validate_selected_tables(selected, &tables)?;
        filter_restore_statements(&mut statements, &mut TableRestoreFilter::with_views(views), selected)?;
    }

    let planned_statements = plan_sql_file_statements(
        &statements,
        import_target.as_ref().map(|target| target.db_type),
        import_target.as_ref().and_then(|target| target.driver_profile.as_deref()),
        request.txn_session_id.is_some(),
    );
    // MySQL-family imports need one pinned connection so `USE` and session
    // state survive across the whole file.
    let mut mysql_executor = MySqlSqlFileExecutor::build(state, request, import_target.as_ref()).await?;
    let bypass_kind = import_target.as_ref().and_then(relational_constraint_bypass_kind);
    let non_mysql_bypass = request.skip_relational_constraints
        && mysql_executor.is_none()
        && matches!(
            bypass_kind,
            Some(RelationalConstraintBypassKind::Postgres | RelationalConstraintBypassKind::SqlServer)
        );
    if non_mysql_bypass {
        let kind = bypass_kind.expect("non_mysql_bypass implies bypass_kind is set");
        set_relational_constraints_enabled(state, request, kind, &token, false).await?;
    }
    let mut progress = SqlFileExecutionProgress::new();
    let import_result = execute_planned_statements_with_progress(
        state,
        request,
        &token,
        started_at,
        &planned_statements,
        mysql_executor.as_mut(),
        &mut progress,
        &mut emit,
    )
    .await;
    if non_mysql_bypass {
        let kind = bypass_kind.expect("non_mysql_bypass implies bypass_kind is set");
        // Use a fresh token, not the (possibly already-cancelled) import token: the
        // restore is catalog-level and must run even after the user cancels, or FK
        // enforcement stays disabled database-wide for every session. The already
        // cancelled `token` would fail `execute_sql_statement_with_options`'s
        // pre-dispatch cancellation check before the restore SQL is ever sent.
        if let Err(error) =
            set_relational_constraints_enabled(state, request, kind, &CancellationToken::new(), true).await
        {
            log::error!(
                "[sql_file_import] failed to restore relational constraints for connection {}: {error}",
                request.connection_id
            );
        }
    }
    import_result?;
    emit_sql_file_terminal_progress(request, &token, started_at, &progress, &mut emit);
    Ok(())
}

pub async fn execute_sql_file_path(
    state: &AppState,
    request: &SqlFileRequest,
    file_path: &Path,
    token: CancellationToken,
    started_at: Instant,
    emit: impl FnMut(SqlFileProgress),
) -> Result<(), String> {
    execute_sql_file_paths(state, request, &[file_path], token, started_at, emit).await
}

/// Executes multiple SQL files as one import operation. MySQL-family imports
/// deliberately reuse one pinned connection across every file, so session
/// state such as `USE`, temporary tables, variables, and transactions remains
/// available to the next file in the batch.
pub async fn execute_sql_file_paths(
    state: &AppState,
    request: &SqlFileRequest,
    file_paths: &[&Path],
    token: CancellationToken,
    started_at: Instant,
    emit: impl FnMut(SqlFileProgress),
) -> Result<(), String> {
    with_sql_file_transaction(
        state,
        request,
        &token,
        Box::pin(execute_sql_file_paths_inner(state, request, file_paths, token.clone(), started_at, emit)),
    )
    .await
}

async fn execute_sql_file_paths_inner(
    state: &AppState,
    request: &SqlFileRequest,
    file_paths: &[&Path],
    token: CancellationToken,
    started_at: Instant,
    mut emit: impl FnMut(SqlFileProgress),
) -> Result<(), String> {
    if file_paths.is_empty() {
        let error = "No SQL files selected".to_string();
        emit(sql_file_error_progress(&request.execution_id, started_at, error.clone()));
        return Err(error);
    }

    let read_progress = SqlFileReadProgress::new(file_paths).await;
    let mut emit = |progress| emit(read_progress.attach(progress));
    emit(sql_file_progress(&request.execution_id, SqlFileStatus::Started, 0, 0, 0, 0, started_at, "", None));

    let import_target = sql_file_import_target(state, &request.connection_id, &request.database).await;
    let options = import_target
        .as_ref()
        .map(|target| {
            SqlParsingOptions::for_database_type_and_compatibility(
                target.db_type,
                target.compatibility_mode.as_mode_str(),
            )
        })
        .unwrap_or_default();
    let database_type = import_target.as_ref().map(|target| target.db_type);
    let mut progress = SqlFileExecutionProgress::new();
    // Validate the entire dump before any SQL reaches the database. This also
    // identifies view placeholders whose final CREATE VIEW appears later.
    let restore_filter = async {
        validate_table_restore_target(request, import_target.as_ref(), file_paths.len())?;
        let Some(selected) = &request.selected_tables else {
            return Ok(None);
        };
        let (tables, views) = scan_sql_file_tables(file_paths[0], &token).await?;
        validate_selected_tables(selected, &tables)?;
        Ok::<_, String>(Some(TableRestoreFilter::with_views(views)))
    }
    .await;
    let mut restore_filter = match restore_filter {
        Ok(filter) => filter,
        Err(error) => {
            if token.is_cancelled() {
                emit_sql_file_terminal_progress(request, &token, started_at, &progress, &mut emit);
                return Ok(());
            }
            emit(sql_file_execution_error_progress(&request.execution_id, started_at, &progress, error.clone()));
            return Err(error);
        }
    };
    let mut mysql_executor = match MySqlSqlFileExecutor::build(state, request, import_target.as_ref()).await {
        Ok(executor) => executor,
        Err(error) => {
            emit(sql_file_execution_error_progress(&request.execution_id, started_at, &progress, error.clone()));
            return Err(error);
        }
    };
    let constraints_disabled = request.skip_relational_constraints && mysql_executor.is_some();
    if constraints_disabled {
        let executor = mysql_executor.as_mut().expect("missing MySQL executor while disabling constraints");
        if let Err(error) = executor.set_foreign_key_checks(state, &token, false).await {
            emit(sql_file_execution_error_progress(&request.execution_id, started_at, &progress, error.clone()));
            return Err(error);
        }
        executor.constraints_disabled = true;
    }
    let bypass_kind = import_target.as_ref().and_then(relational_constraint_bypass_kind);
    let non_mysql_bypass = request.skip_relational_constraints
        && mysql_executor.is_none()
        && matches!(
            bypass_kind,
            Some(RelationalConstraintBypassKind::Postgres | RelationalConstraintBypassKind::SqlServer)
        );
    if non_mysql_bypass {
        let kind = bypass_kind.expect("non_mysql_bypass implies bypass_kind is set");
        if let Err(error) = set_relational_constraints_enabled(state, request, kind, &token, false).await {
            emit(sql_file_execution_error_progress(&request.execution_id, started_at, &progress, error.clone()));
            return Err(error);
        }
    }
    let file_count = file_paths.len();
    let mut prev_statement_index = 0usize;
    let mut prev_success_count = 0usize;
    let mut prev_failure_count = 0usize;
    let mut prev_affected_rows = 0u64;
    let import_result = async {
        for (file_index, file_path) in file_paths.iter().enumerate() {
            let file_name = file_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();

            // Emit a file-boundary progress event so the frontend knows which file is
            // currently executing and can display a "File N/M" indicator.
            if file_count > 1 {
                emit(SqlFileProgress {
                    execution_id: request.execution_id.clone(),
                    status: SqlFileStatus::Running,
                    statement_index: progress.statement_index,
                    success_count: progress.success_count,
                    failure_count: progress.failure_count,
                    affected_rows: progress.affected_rows,
                    elapsed_ms: started_at.elapsed().as_millis(),
                    statement_summary: String::new(),
                    error: None,
                    bytes_read: None,
                    total_bytes: None,
                    phase: None,
                    file_index: Some(file_index),
                    file_name: Some(file_name.clone()),
                });
            }

            let mut splitter = StreamingSqlFileSplitter::new(database_type, options);
            let mut pending_statements = Vec::with_capacity(SQL_FILE_STATEMENT_BATCH_SIZE);
            let normalize_mysql_binary_literals = import_target.as_ref().is_some_and(|target| {
                crate::sql::is_mysql_compatible_import_target(&target.db_type, target.driver_profile.as_deref())
            });
            let mut decoder = match SqlFileStreamDecoder::open_for_target_with_progress(
                file_path,
                normalize_mysql_binary_literals,
                read_progress.bytes_read.clone(),
            )
            .await
            {
                Ok(decoder) => decoder,
                Err(error) => {
                    emit(sql_file_execution_error_progress(
                        &request.execution_id,
                        started_at,
                        &progress,
                        error.clone(),
                    ));
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
                emit(sql_file_progress(
                    &request.execution_id,
                    SqlFileStatus::Running,
                    progress.statement_index,
                    progress.success_count,
                    progress.failure_count,
                    progress.affected_rows,
                    started_at,
                    "",
                    None,
                ));
                let mut next_statements = splitter.push_chunk(&chunk);
                if let Some(filter) = restore_filter.as_mut() {
                    if let Err(error) = filter_restore_statements(
                        &mut next_statements,
                        filter,
                        request.selected_tables.as_deref().unwrap_or_default(),
                    ) {
                        emit(sql_file_execution_error_progress(
                            &request.execution_id,
                            started_at,
                            &progress,
                            error.clone(),
                        ));
                        return Err(error);
                    }
                }
                pending_statements.extend(next_statements);
                if pending_statements.len() < SQL_FILE_STATEMENT_BATCH_SIZE {
                    continue;
                }
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

            let mut next_statements = splitter.finish();
            if let Some(filter) = restore_filter.as_mut() {
                if let Err(error) = filter_restore_statements(
                    &mut next_statements,
                    filter,
                    request.selected_tables.as_deref().unwrap_or_default(),
                ) {
                    emit(sql_file_execution_error_progress(
                        &request.execution_id,
                        started_at,
                        &progress,
                        error.clone(),
                    ));
                    return Err(error);
                }
            }
            pending_statements.extend(next_statements);
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

            // After each file, emit a per-file summary with diff-based counters so
            // the frontend can build a per-file breakdown table.
            if file_count > 1 {
                emit(SqlFileProgress {
                    execution_id: request.execution_id.clone(),
                    status: SqlFileStatus::StatementDone,
                    statement_index: progress.statement_index - prev_statement_index,
                    success_count: progress.success_count - prev_success_count,
                    failure_count: progress.failure_count - prev_failure_count,
                    affected_rows: progress.affected_rows - prev_affected_rows,
                    elapsed_ms: started_at.elapsed().as_millis(),
                    statement_summary: String::new(),
                    error: None,
                    bytes_read: None,
                    total_bytes: None,
                    phase: None,
                    file_index: Some(file_index),
                    file_name: Some(file_name),
                });
                prev_statement_index = progress.statement_index;
                prev_success_count = progress.success_count;
                prev_failure_count = progress.failure_count;
                prev_affected_rows = progress.affected_rows;
            }
            if file_index + 1 < file_count && request.part_cooldown_ms > 0 {
                tokio::select! {
                    _ = token.cancelled() => {
                        emit_sql_file_terminal_progress(request, &token, started_at, &progress, &mut emit);
                        return Ok(());
                    }
                    _ = tokio::time::sleep(Duration::from_millis(request.part_cooldown_ms)) => {}
                }
            }
        }
        emit_sql_file_terminal_progress(request, &token, started_at, &progress, &mut emit);
        Ok(())
    }
    .await;
    if constraints_disabled {
        if let Some(executor) = mysql_executor.as_mut() {
            let _ = executor.set_foreign_key_checks(state, &token, true).await;
        }
    }
    if non_mysql_bypass {
        let kind = bypass_kind.expect("non_mysql_bypass implies bypass_kind is set");
        // Fresh token: see the matching comment in `execute_sql_file_content`. `token`
        // here may already be cancelled (user cancel or terminal error), which would
        // make `execute_sql_statement_with_options` refuse to send the restore SQL.
        if let Err(error) =
            set_relational_constraints_enabled(state, request, kind, &CancellationToken::new(), true).await
        {
            log::error!(
                "[sql_file_import] failed to restore relational constraints for connection {}: {error}",
                request.connection_id
            );
        }
    }
    import_result
}

pub async fn inspect_sql_file_tables(file_path: &Path) -> Result<Vec<SqlFileTable>, String> {
    scan_sql_file_tables(file_path, &CancellationToken::new()).await.map(|(tables, _)| tables)
}

async fn scan_sql_file_tables(
    file_path: &Path,
    token: &CancellationToken,
) -> Result<(Vec<SqlFileTable>, std::collections::BTreeSet<SqlFileTable>), String> {
    let mut decoder = SqlFileStreamDecoder::open_for_target(file_path, true).await?;
    let mut splitter = StreamingSqlFileSplitter::new(Some(DatabaseType::Mysql), SqlParsingOptions::mysql_compatible());
    let mut scan = TableRestoreFilter::default();
    while let Some(chunk) = decoder.next_chunk().await? {
        if token.is_cancelled() {
            return Err("Table inspection cancelled".to_string());
        }
        for statement in splitter.push_chunk(&chunk) {
            scan.inspect(&statement.sql)?;
        }
    }
    for statement in splitter.finish() {
        scan.inspect(&statement.sql)?;
    }
    Ok(scan.finish())
}

fn validate_table_restore_target(
    request: &SqlFileRequest,
    target: Option<&SqlFileImportTarget>,
    file_count: usize,
) -> Result<(), String> {
    let Some(selected) = &request.selected_tables else {
        return Ok(());
    };
    if selected.is_empty() {
        return Err("Select at least one table to restore".to_string());
    }
    if file_count != 1 {
        return Err("Selected-table restore requires exactly one SQL file".to_string());
    }
    if !target.is_some_and(|target| {
        crate::sql::supports_connection_level_database_bootstrap_target(
            &target.db_type,
            target.driver_profile.as_deref(),
        )
    }) {
        return Err("Selected-table restore is only supported for MySQL-compatible connections".to_string());
    }
    Ok(())
}

fn validate_selected_tables(selected: &[SqlFileTable], available: &[SqlFileTable]) -> Result<(), String> {
    if selected.iter().any(|table| !available.contains(table)) {
        return Err("A selected table is no longer present in the backup; scan the file again".to_string());
    }
    Ok(())
}

fn filter_restore_statements(
    statements: &mut Vec<SqlStatementWithControl>,
    filter: &mut TableRestoreFilter,
    selected: &[SqlFileTable],
) -> Result<(), String> {
    let mut filtered = Vec::new();
    for mut statement in std::mem::take(statements) {
        if let Some(sql) = filter.filter(&statement.sql, selected)? {
            statement.sql = sql;
            filtered.push(statement);
        }
    }
    *statements = filtered;
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

pub(crate) struct SqlFileStreamDecoder {
    reader: SqlFileByteReader,
    encoding: &'static encoding_rs::Encoding,
    decoder: encoding_rs::Decoder,
    mysql_binary_normalizer: Option<MysqlDumpBinaryLiteralNormalizer>,
    pending_bytes: Vec<u8>,
    pending_decoded_bytes: Vec<u8>,
    reached_eof: bool,
}

enum SqlFileByteReader {
    Plain(BufReader<tokio::fs::File>, Option<Arc<AtomicU64>>),
    Gzip(Arc<Mutex<flate2::read::GzDecoder<SqlFileCountingReader<std::io::BufReader<std::fs::File>>>>>),
}

impl SqlFileByteReader {
    async fn open(file_path: &Path) -> Result<Self, String> {
        Self::open_with_progress(file_path, None).await
    }

    async fn open_with_progress(file_path: &Path, bytes_read: Option<Arc<AtomicU64>>) -> Result<Self, String> {
        if is_gzip_sql_file_path(file_path) {
            let path = file_path.to_path_buf();
            let reader = tokio::task::spawn_blocking(move || {
                let file = std::fs::File::open(&path).map_err(|error| error.to_string())?;
                Ok::<_, String>(flate2::read::GzDecoder::new(SqlFileCountingReader {
                    reader: std::io::BufReader::new(file),
                    bytes_read,
                }))
            })
            .await
            .map_err(|error| format!("Failed to open compressed SQL file: {error}"))??;
            return Ok(Self::Gzip(Arc::new(Mutex::new(reader))));
        }

        let file = tokio::fs::File::open(file_path).await.map_err(|error| error.to_string())?;
        Ok(Self::Plain(BufReader::with_capacity(SQL_FILE_READ_CHUNK_BYTES, file), bytes_read))
    }

    async fn read(&mut self, buffer: &mut [u8]) -> Result<usize, String> {
        match self {
            Self::Plain(reader, bytes_read) => {
                let read = reader.read(buffer).await.map_err(|error| error.to_string())?;
                if let Some(bytes_read) = bytes_read {
                    bytes_read.fetch_add(read as u64, Ordering::Relaxed);
                }
                Ok(read)
            }
            Self::Gzip(reader) => {
                let reader = reader.clone();
                let capacity = buffer.len();
                let (chunk, read) = tokio::task::spawn_blocking(move || {
                    let mut chunk = vec![0; capacity];
                    let mut reader =
                        reader.lock().map_err(|_| "Compressed SQL reader lock was poisoned".to_string())?;
                    let read =
                        reader.read(&mut chunk).map_err(|error| format!("Failed to decompress SQL file: {error}"))?;
                    Ok::<_, String>((chunk, read))
                })
                .await
                .map_err(|error| format!("Failed to read compressed SQL file: {error}"))??;
                buffer[..read].copy_from_slice(&chunk[..read]);
                Ok(read)
            }
        }
    }
}

/// 嗅探文件开头的字节序标记，存在时返回 BOM 对应的编码与长度。
///
/// 表导入显式选择编码时也优先按 BOM 解码：与非流式 `Encoding::decode`
/// 的行为保持一致，避免显式编码与 BOM 不匹配时把 BOM 字节解成
/// 垃圾前缀黏在首条语句上。
async fn detect_file_bom(file_path: &Path) -> Result<(&'static encoding_rs::Encoding, usize), String> {
    let mut reader = SqlFileByteReader::open(file_path).await?;
    let mut prefix = [0u8; 3];
    let prefix_len = reader.read(&mut prefix).await?;
    match encoding_rs::Encoding::for_bom(&prefix[..prefix_len]) {
        Some((encoding, bom_len)) => Ok((encoding, bom_len)),
        None => Ok((encoding_rs::UTF_8, 0)),
    }
}

fn is_gzip_sql_file_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("gz"))
        && path
            .file_stem()
            .and_then(|stem| Path::new(stem).extension())
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("sql"))
}

impl SqlFileStreamDecoder {
    #[cfg(test)]
    async fn open(file_path: &Path) -> Result<Self, String> {
        Self::open_with_options(file_path, None, false, None).await
    }

    async fn open_with_detection_limit(file_path: &Path, detection_limit: Option<usize>) -> Result<Self, String> {
        Self::open_with_options(file_path, detection_limit, false, None).await
    }

    async fn open_for_target(file_path: &Path, normalize_mysql_binary_literals: bool) -> Result<Self, String> {
        Self::open_with_options(file_path, None, normalize_mysql_binary_literals, None).await
    }

    async fn open_for_target_with_progress(
        file_path: &Path,
        normalize_mysql_binary_literals: bool,
        bytes_read: Arc<AtomicU64>,
    ) -> Result<Self, String> {
        Self::open_with_options(file_path, None, normalize_mysql_binary_literals, Some(bytes_read)).await
    }

    /// 以调用方已经确定的编码打开解码器。
    ///
    /// 表导入会先解析用户的编码设置：显式选择了编码时不再自动探测，
    /// 但文件带 BOM 时仍优先按 BOM 的编码解码并跳过，保持与旧的非流式
    /// 实现一致的语义。
    pub(crate) async fn open_for_import(
        file_path: &Path,
        encoding: Option<&'static encoding_rs::Encoding>,
        normalize_mysql_binary_literals: bool,
        bytes_read: Option<Arc<AtomicU64>>,
    ) -> Result<Self, String> {
        let Some(encoding) = encoding else {
            return Self::open_with_options(file_path, None, normalize_mysql_binary_literals, bytes_read).await;
        };
        let (bom_encoding, bom_len) = detect_file_bom(file_path).await?;
        let (encoding, bom_len) = if bom_len > 0 { (bom_encoding, bom_len) } else { (encoding, 0) };
        Self::open_with_resolved_encoding(file_path, encoding, bom_len, normalize_mysql_binary_literals, bytes_read)
            .await
    }

    /// 解码器实际使用的文本编码（显式指定或自动探测的结果）。
    pub(crate) fn encoding(&self) -> &'static encoding_rs::Encoding {
        self.encoding
    }

    async fn open_with_options(
        file_path: &Path,
        detection_limit: Option<usize>,
        normalize_mysql_binary_literals: bool,
        bytes_read: Option<Arc<AtomicU64>>,
    ) -> Result<Self, String> {
        let (encoding, bom_len, detected_mysql_binary_literals) =
            detect_sql_file_encoding(file_path, detection_limit).await?;
        Self::open_with_resolved_encoding(
            file_path,
            encoding,
            bom_len,
            normalize_mysql_binary_literals || detected_mysql_binary_literals,
            bytes_read,
        )
        .await
    }

    async fn open_with_resolved_encoding(
        file_path: &Path,
        encoding: &'static encoding_rs::Encoding,
        bom_len: usize,
        normalize_mysql_binary_literals: bool,
        bytes_read: Option<Arc<AtomicU64>>,
    ) -> Result<Self, String> {
        let mut reader = SqlFileByteReader::open_with_progress(file_path, bytes_read).await?;
        let mut prefix = [0u8; 3];
        let prefix_len = reader.read(&mut prefix).await?;
        let prefix = &prefix[..prefix_len];
        let mut pending_bytes = prefix[bom_len..].to_vec();
        pending_bytes.reserve(SQL_FILE_READ_CHUNK_BYTES);
        Ok(Self {
            reader,
            encoding,
            decoder: encoding.new_decoder_without_bom_handling(),
            mysql_binary_normalizer: (encoding == encoding_rs::UTF_8 && normalize_mysql_binary_literals)
                .then(MysqlDumpBinaryLiteralNormalizer::default),
            pending_bytes,
            pending_decoded_bytes: Vec::new(),
            reached_eof: false,
        })
    }

    pub(crate) async fn next_chunk(&mut self) -> Result<Option<String>, String> {
        if self.reached_eof && self.pending_bytes.is_empty() && self.pending_decoded_bytes.is_empty() {
            return Ok(None);
        }
        while !self.reached_eof && self.pending_bytes.len() < SQL_FILE_READ_CHUNK_BYTES {
            let mut buffer = vec![0u8; SQL_FILE_READ_CHUNK_BYTES - self.pending_bytes.len()];
            let read = self.reader.read(&mut buffer).await?;
            if read == 0 {
                self.reached_eof = true;
                break;
            }
            self.pending_bytes.extend_from_slice(&buffer[..read]);
        }

        let normalized = if let Some(normalizer) = self.mysql_binary_normalizer.as_mut() {
            let input = normalizer.normalize(&self.pending_bytes, self.reached_eof)?;
            self.pending_bytes.clear();
            input
        } else {
            std::mem::take(&mut self.pending_bytes)
        };
        let mut input = std::mem::take(&mut self.pending_decoded_bytes);
        input.extend_from_slice(&normalized);
        let mut output = String::with_capacity(
            self.decoder.max_utf8_buffer_length_without_replacement(input.len()).unwrap_or(input.len()),
        );
        let (result, read) = self.decoder.decode_to_string_without_replacement(&input, &mut output, self.reached_eof);
        if read < input.len() {
            self.pending_decoded_bytes.extend_from_slice(&input[read..]);
        }
        match result {
            encoding_rs::DecoderResult::InputEmpty => Ok((!output.is_empty()).then_some(output)),
            encoding_rs::DecoderResult::OutputFull => Ok(Some(output)),
            encoding_rs::DecoderResult::Malformed(_, _) => Err("Unsupported or invalid SQL file encoding".to_string()),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum MysqlDumpBinaryLiteralState {
    #[default]
    Normal,
    SingleQuoted,
    DoubleQuoted,
    BacktickQuoted,
    LineComment,
    BlockComment,
    BinaryQuoted,
}

#[derive(Debug, Default)]
struct MysqlDumpBinaryLiteralNormalizer {
    state: MysqlDumpBinaryLiteralState,
    pending: Vec<u8>,
    previous_source_byte: Option<u8>,
    quoted_escape_pending: bool,
}

impl MysqlDumpBinaryLiteralNormalizer {
    fn normalize(&mut self, input: &[u8], eof: bool) -> Result<Vec<u8>, String> {
        self.pending.extend_from_slice(input);
        let mut output = Vec::with_capacity(self.pending.len());
        let mut index = 0;

        while index < self.pending.len() {
            let byte = self.pending[index];
            match self.state {
                MysqlDumpBinaryLiteralState::Normal => {
                    if byte == b'_' {
                        if self.pending.len() - index < b"_binary".len() {
                            if !eof {
                                break;
                            }
                        } else if self.pending[index..index + 7].eq_ignore_ascii_case(b"_binary")
                            && !is_sql_identifier_byte(self.source_byte_before(index))
                        {
                            let mut quote_index = index + 7;
                            while quote_index < self.pending.len() && self.pending[quote_index].is_ascii_whitespace() {
                                quote_index += 1;
                            }
                            if quote_index == self.pending.len() && !eof {
                                break;
                            }
                            if self.pending.get(quote_index) == Some(&b'\'') {
                                output.extend_from_slice(b"X'");
                                self.state = MysqlDumpBinaryLiteralState::BinaryQuoted;
                                self.previous_source_byte = Some(b'\'');
                                index = quote_index + 1;
                                continue;
                            }
                        }
                    }

                    if byte == b'-' && self.pending.get(index + 1) == Some(&b'-') {
                        // MySQL requires whitespace or a control character after `--`
                        // to open a line comment: `5--1` is subtraction, matching the
                        // splitter's dash_dash_starts_line_comment rule.
                        let byte_after_dashes = self.pending.get(index + 2).copied();
                        if byte_after_dashes.is_none() && !eof {
                            break;
                        }
                        output.extend_from_slice(b"--");
                        self.previous_source_byte = Some(b'-');
                        index += 2;
                        if byte_after_dashes.is_none_or(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control()) {
                            self.state = MysqlDumpBinaryLiteralState::LineComment;
                        }
                    } else if byte == b'-' && self.pending.get(index + 1).is_none() && !eof {
                        break;
                    } else if byte == b'#' {
                        output.push(byte);
                        self.state = MysqlDumpBinaryLiteralState::LineComment;
                        self.previous_source_byte = Some(byte);
                        index += 1;
                    } else if byte == b'/' && self.pending.get(index + 1) == Some(&b'*') {
                        output.extend_from_slice(b"/*");
                        self.state = MysqlDumpBinaryLiteralState::BlockComment;
                        self.previous_source_byte = Some(b'*');
                        index += 2;
                    } else if byte == b'/' && self.pending.get(index + 1).is_none() && !eof {
                        break;
                    } else {
                        output.push(byte);
                        self.previous_source_byte = Some(byte);
                        self.state = match byte {
                            b'\'' => MysqlDumpBinaryLiteralState::SingleQuoted,
                            b'"' => MysqlDumpBinaryLiteralState::DoubleQuoted,
                            b'`' => MysqlDumpBinaryLiteralState::BacktickQuoted,
                            _ => MysqlDumpBinaryLiteralState::Normal,
                        };
                        index += 1;
                    }
                }
                MysqlDumpBinaryLiteralState::SingleQuoted
                | MysqlDumpBinaryLiteralState::DoubleQuoted
                | MysqlDumpBinaryLiteralState::BacktickQuoted => {
                    let quote = match self.state {
                        MysqlDumpBinaryLiteralState::SingleQuoted => b'\'',
                        MysqlDumpBinaryLiteralState::DoubleQuoted => b'"',
                        MysqlDumpBinaryLiteralState::BacktickQuoted => b'`',
                        _ => unreachable!(),
                    };
                    if byte == quote && self.pending.get(index + 1).is_none() && !eof {
                        break;
                    }
                    output.push(byte);
                    self.previous_source_byte = Some(byte);
                    index += 1;
                    if self.quoted_escape_pending {
                        self.quoted_escape_pending = false;
                    } else if byte == b'\\' {
                        if let Some(escaped) = self.pending.get(index) {
                            output.push(*escaped);
                            self.previous_source_byte = Some(*escaped);
                            index += 1;
                        } else if !eof {
                            self.quoted_escape_pending = true;
                        }
                    } else if byte == quote {
                        if self.pending.get(index) == Some(&quote) {
                            output.push(quote);
                            self.previous_source_byte = Some(quote);
                            index += 1;
                        } else {
                            self.state = MysqlDumpBinaryLiteralState::Normal;
                        }
                    }
                }
                MysqlDumpBinaryLiteralState::LineComment => {
                    output.push(byte);
                    self.previous_source_byte = Some(byte);
                    index += 1;
                    if byte == b'\n' {
                        self.state = MysqlDumpBinaryLiteralState::Normal;
                    }
                }
                MysqlDumpBinaryLiteralState::BlockComment => {
                    if byte == b'*' && self.pending.get(index + 1).is_none() && !eof {
                        break;
                    }
                    output.push(byte);
                    self.previous_source_byte = Some(byte);
                    index += 1;
                    if byte == b'*' && self.pending.get(index) == Some(&b'/') {
                        output.push(b'/');
                        self.previous_source_byte = Some(b'/');
                        index += 1;
                        self.state = MysqlDumpBinaryLiteralState::Normal;
                    }
                }
                MysqlDumpBinaryLiteralState::BinaryQuoted => {
                    if byte == b'\\' {
                        let Some(escaped) = self.pending.get(index + 1).copied() else {
                            if !eof {
                                break;
                            }
                            return Err("Unterminated MySQL binary literal".to_string());
                        };
                        let value = match escaped {
                            b'0' => 0x00,
                            b'b' => 0x08,
                            b'n' => b'\n',
                            b'r' => b'\r',
                            b't' => b'\t',
                            b'Z' => 0x1A,
                            b'\\' => b'\\',
                            b'\'' => b'\'',
                            b'"' => b'"',
                            other => other,
                        };
                        append_hex(&mut output, value);
                        self.previous_source_byte = Some(escaped);
                        index += 2;
                    } else if byte == b'\'' && self.pending.get(index + 1).is_none() && !eof {
                        break;
                    } else if byte == b'\'' {
                        if self.pending.get(index + 1) == Some(&b'\'') {
                            append_hex(&mut output, b'\'');
                            self.previous_source_byte = Some(b'\'');
                            index += 2;
                        } else {
                            output.push(b'\'');
                            self.previous_source_byte = Some(b'\'');
                            self.state = MysqlDumpBinaryLiteralState::Normal;
                            index += 1;
                        }
                    } else {
                        append_hex(&mut output, byte);
                        self.previous_source_byte = Some(byte);
                        index += 1;
                    }
                }
            }
        }

        self.pending.drain(..index);
        if eof {
            if self.state == MysqlDumpBinaryLiteralState::BinaryQuoted {
                return Err("Unterminated MySQL binary literal".to_string());
            }
            if !self.pending.is_empty() {
                output.extend_from_slice(&self.pending);
                self.pending.clear();
            }
        }
        Ok(output)
    }

    fn source_byte_before(&self, index: usize) -> Option<u8> {
        if index > 0 {
            self.pending.get(index - 1).copied()
        } else {
            self.previous_source_byte
        }
    }
}

fn is_sql_identifier_byte(byte: Option<u8>) -> bool {
    byte.is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$'))
}

fn append_hex(output: &mut Vec<u8>, byte: u8) {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    output.push(HEX[(byte >> 4) as usize]);
    output.push(HEX[(byte & 0x0F) as usize]);
}

async fn detect_sql_file_encoding(
    file_path: &Path,
    detection_limit: Option<usize>,
) -> Result<(&'static encoding_rs::Encoding, usize, bool), String> {
    let mut file = SqlFileByteReader::open(file_path).await?;
    let mut prefix = [0u8; 3];
    let prefix_len = file.read(&mut prefix).await.map_err(|error| error.to_string())?;
    let prefix = &prefix[..prefix_len];
    if prefix.starts_with(&[0xFF, 0xFE]) {
        return Ok((encoding_rs::UTF_16LE, 2, false));
    }
    if prefix.starts_with(&[0xFE, 0xFF]) {
        return Ok((encoding_rs::UTF_16BE, 2, false));
    }
    let bom_len = usize::from(prefix.starts_with(&[0xEF, 0xBB, 0xBF])) * 3;

    // SQL dumps often begin with ASCII comments even when the remaining file
    // is GBK. Validate the entire stream as UTF-8 with bounded buffers before
    // falling back to the legacy GBK behavior.
    let mut decoder = encoding_rs::UTF_8.new_decoder_without_bom_handling();
    let mut input = prefix[bom_len..].to_vec();
    let mut inspected_bytes = prefix.len();
    let mut reached_eof = false;
    loop {
        let reached_detection_limit = detection_limit.is_some_and(|limit| inspected_bytes >= limit);
        if !reached_eof && !reached_detection_limit {
            let remaining =
                detection_limit.map(|limit| limit.saturating_sub(inspected_bytes)).unwrap_or(SQL_FILE_READ_CHUNK_BYTES);
            let mut buffer = vec![0u8; SQL_FILE_READ_CHUNK_BYTES.min(remaining.max(1))];
            let read = file.read(&mut buffer).await?;
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
            encoding_rs::DecoderResult::Malformed(_, _) => {
                if validate_utf8_with_mysql_binary_literals(file_path, detection_limit).await? {
                    return Ok((encoding_rs::UTF_8, bom_len, true));
                }
                return Ok(if bom_len > 0 {
                    (encoding_rs::UTF_8, bom_len, false)
                } else {
                    (encoding_rs::GBK, 0, false)
                });
            }
            encoding_rs::DecoderResult::InputEmpty if reached_eof || reached_detection_limit => {
                return Ok((encoding_rs::UTF_8, bom_len, false));
            }
            encoding_rs::DecoderResult::InputEmpty | encoding_rs::DecoderResult::OutputFull => {}
        }
    }
}

async fn validate_utf8_with_mysql_binary_literals(
    file_path: &Path,
    detection_limit: Option<usize>,
) -> Result<bool, String> {
    let mut file = SqlFileByteReader::open(file_path).await?;
    let mut normalizer = MysqlDumpBinaryLiteralNormalizer::default();
    let mut decoder = encoding_rs::UTF_8.new_decoder_without_bom_handling();
    let mut input = Vec::new();
    let mut inspected_bytes = 0;
    let mut reached_eof = false;

    loop {
        let reached_detection_limit = detection_limit.is_some_and(|limit| inspected_bytes >= limit);
        if !reached_eof && !reached_detection_limit {
            let remaining =
                detection_limit.map(|limit| limit.saturating_sub(inspected_bytes)).unwrap_or(SQL_FILE_READ_CHUNK_BYTES);
            let mut buffer = vec![0u8; SQL_FILE_READ_CHUNK_BYTES.min(remaining.max(1))];
            let read = file.read(&mut buffer).await?;
            if read == 0 {
                reached_eof = true;
            } else {
                inspected_bytes += read;
                input.extend_from_slice(&buffer[..read]);
            }
        }

        let normalized = match normalizer.normalize(&input, reached_eof) {
            Ok(normalized) => normalized,
            Err(_) => return Ok(false),
        };
        input.clear();
        let mut output = String::with_capacity(
            decoder
                .max_utf8_buffer_length_without_replacement(normalized.len())
                .unwrap_or(normalized.len().saturating_mul(3)),
        );
        let (result, _) = decoder.decode_to_string_without_replacement(&normalized, &mut output, reached_eof);
        if !matches!(result, encoding_rs::DecoderResult::InputEmpty) {
            return Ok(false);
        }
        if reached_eof || reached_detection_limit {
            return Ok(true);
        }
    }
}

pub(crate) struct StreamingSqlFileSplitter(StreamingSqlFileSplitterKind);

enum StreamingSqlFileSplitterKind {
    Statements(SqlStatementSplitter),
    SqlServerBatches(SqlServerBatchSplitter),
}

impl StreamingSqlFileSplitter {
    pub(crate) fn new(db_type: Option<DatabaseType>, options: SqlParsingOptions) -> Self {
        Self(StreamingSqlFileSplitterKind::new(db_type, options))
    }

    pub(crate) fn push_chunk(&mut self, chunk: &str) -> Vec<SqlStatementWithControl> {
        self.0.push_chunk(chunk)
    }

    pub(crate) fn finish(self) -> Vec<SqlStatementWithControl> {
        self.0.finish()
    }
}

impl StreamingSqlFileSplitterKind {
    fn new(db_type: Option<DatabaseType>, options: SqlParsingOptions) -> Self {
        if db_type == Some(DatabaseType::SqlServer) {
            Self::SqlServerBatches(SqlServerBatchSplitter::default())
        } else {
            Self::Statements(SqlStatementSplitter::with_options(options))
        }
    }

    fn push_chunk(&mut self, chunk: &str) -> Vec<SqlStatementWithControl> {
        match self {
            Self::Statements(splitter) => splitter.push_chunk_with_control(chunk),
            Self::SqlServerBatches(splitter) => splitter
                .push_chunk(chunk)
                .into_iter()
                .map(|sql| SqlStatementWithControl { sql, stop_on_error: false })
                .collect(),
        }
    }

    fn finish(self) -> Vec<SqlStatementWithControl> {
        match self {
            Self::Statements(splitter) => splitter.finish_with_control(),
            Self::SqlServerBatches(splitter) => {
                splitter.finish().into_iter().map(|sql| SqlStatementWithControl { sql, stop_on_error: false }).collect()
            }
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
    statements: &mut Vec<SqlStatementWithControl>,
    import_target: Option<&SqlFileImportTarget>,
    mysql_executor: Option<&mut MySqlSqlFileExecutor>,
    progress: &mut SqlFileExecutionProgress,
    emit: &mut impl FnMut(SqlFileProgress),
) -> Result<(), String> {
    if statements.is_empty() {
        return Ok(());
    }
    let statements = std::mem::take(statements);
    let planned_statements = plan_sql_file_statements(
        &statements,
        import_target.map(|target| target.db_type),
        import_target.and_then(|target| target.driver_profile.as_deref()),
        request.txn_session_id.is_some(),
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

#[cfg(test)]
fn split_sql_file_import_statements(file_content: &str, db_type: Option<DatabaseType>) -> Vec<String> {
    split_sql_file_import_statements_with_control(file_content, db_type, None)
        .into_iter()
        .map(|statement| statement.sql)
        .collect()
}

fn split_sql_file_import_statements_with_control(
    file_content: &str,
    db_type: Option<DatabaseType>,
    compatibility_mode: Option<&str>,
) -> Vec<SqlStatementWithControl> {
    if db_type == Some(DatabaseType::SqlServer) {
        // GO is a client-side batch delimiter, not T-SQL. SQL Server module DDL
        // must also remain a complete batch because procedure bodies contain semicolons.
        return split_sql_batches(file_content)
            .into_iter()
            .map(|sql| SqlStatementWithControl { sql, stop_on_error: false })
            .collect();
    }

    let options = db_type
        .map(|db_type| SqlParsingOptions::for_database_type_and_compatibility(db_type, compatibility_mode))
        .unwrap_or_default();
    let mut splitter = SqlStatementSplitter::with_options(options);
    let mut statements = splitter.push_chunk_with_control(file_content);
    statements.extend(splitter.finish_with_control());
    statements
}

fn plan_sql_file_statements(
    statements: &[SqlStatementWithControl],
    db_type: Option<DatabaseType>,
    driver_profile: Option<&str>,
    manual: bool,
) -> Vec<ControlledSqlFileImportStatement> {
    if !manual {
        return optimize_controlled_sql_file_import_statements(statements, db_type, driver_profile);
    }
    // Preserve each statement and its error boundary. The normal import path
    // may merge INSERTs and retry them individually, which is not valid after
    // a failed manual transaction has been rolled back.
    statements
        .iter()
        .flat_map(|statement| {
            optimize_sql_file_import_statements(std::slice::from_ref(&statement.sql), db_type, driver_profile)
                .into_iter()
                .map(|statement| ControlledSqlFileImportStatement { statement, stop_on_error: true })
        })
        .collect()
}

fn optimize_controlled_sql_file_import_statements(
    statements: &[SqlStatementWithControl],
    db_type: Option<DatabaseType>,
    driver_profile: Option<&str>,
) -> Vec<ControlledSqlFileImportStatement> {
    let mut controlled = Vec::new();
    let mut start = 0;
    while start < statements.len() {
        let stop_on_error = statements[start].stop_on_error;
        let mut end = start + 1;
        while end < statements.len() && statements[end].stop_on_error == stop_on_error {
            end += 1;
        }
        let sql = statements[start..end].iter().map(|statement| statement.sql.clone()).collect::<Vec<_>>();
        controlled.extend(
            optimize_sql_file_import_statements(&sql, db_type, driver_profile)
                .into_iter()
                .map(|statement| ControlledSqlFileImportStatement { statement, stop_on_error }),
        );
        start = end;
    }
    controlled
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
        bytes_read: None,
        total_bytes: None,
        phase: None,
        file_index: None,
        file_name: None,
    }
}

pub fn sql_file_error_progress(execution_id: &str, started_at: Instant, error: String) -> SqlFileProgress {
    sql_file_progress(execution_id, SqlFileStatus::Error, 0, 0, 0, 0, started_at, "", Some(error))
}

fn sql_file_execution_error_progress(
    execution_id: &str,
    started_at: Instant,
    progress: &SqlFileExecutionProgress,
    error: String,
) -> SqlFileProgress {
    sql_file_progress(
        execution_id,
        SqlFileStatus::Error,
        progress.statement_index,
        progress.success_count,
        progress.failure_count,
        progress.affected_rows,
        started_at,
        "",
        Some(error),
    )
}

async fn sql_file_import_target(state: &AppState, connection_id: &str, database: &str) -> Option<SqlFileImportTarget> {
    let config = state.configs.read().await.get(connection_id).cloned()?;
    // Probing must never drop db_type: even when the pool is unavailable the file
    // still uses the openGauss splitter. A failed probe is recorded as `Unknown`
    // rather than `None` so the splitter keeps PL/SQL package bodies intact
    // instead of silently falling back to PostgreSQL statement semantics.
    let compatibility_mode = if config.db_type == DatabaseType::OpenGauss {
        let pool = match state.get_or_create_pool(connection_id, Some(database)).await {
            Ok(pool_key) => match state.pool_handle(&pool_key).await {
                Some(PoolKind::Postgres(pool)) => Some(pool),
                _ => None,
            },
            Err(_) => None,
        };
        match pool {
            Some(pool) => match db::postgres::opengauss_compatibility_mode(&pool).await {
                Ok(Some(mode)) => SqlCompatibilityMode::Resolved(mode),
                // Catalog returned no row, or the probe errored (permissions,
                // timeout, older kernel without pg_database.datcompatibility).
                Ok(None) | Err(_) => {
                    log::warn!(
                        "[sql_file_import] openGauss compatibility mode probe failed for connection {connection_id}; \
                         splitting with the conservative PL/SQL profile"
                    );
                    SqlCompatibilityMode::Unknown
                }
            },
            None => SqlCompatibilityMode::Unknown,
        }
    } else {
        SqlCompatibilityMode::NotApplicable
    };
    Some(SqlFileImportTarget { db_type: config.db_type, driver_profile: config.driver_profile, compatibility_mode })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MysqlLikeSqlFileBootstrapAnalysis {
    pub can_execute_without_selected_database: bool,
    pub establishes_database_context: bool,
}

pub fn mysql_like_sql_file_bootstrap_analysis(file_content: &str) -> MysqlLikeSqlFileBootstrapAnalysis {
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
            return MysqlLikeSqlFileBootstrapAnalysis {
                can_execute_without_selected_database: false,
                establishes_database_context: has_database_context,
            };
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
            return MysqlLikeSqlFileBootstrapAnalysis {
                can_execute_without_selected_database: false,
                establishes_database_context: false,
            };
        }
    }

    MysqlLikeSqlFileBootstrapAnalysis {
        can_execute_without_selected_database: saw_statement,
        establishes_database_context: has_database_context,
    }
}

pub fn mysql_like_sql_file_can_execute_without_selected_database(file_content: &str) -> bool {
    mysql_like_sql_file_bootstrap_analysis(file_content).can_execute_without_selected_database
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
    planned_statements: &[ControlledSqlFileImportStatement],
    mut mysql_executor: Option<&mut MySqlSqlFileExecutor>,
    progress: &mut SqlFileExecutionProgress,
    emit: &mut impl FnMut(SqlFileProgress),
) -> Result<(), String> {
    for planned_statement in planned_statements {
        if token.is_cancelled() {
            return Ok(());
        }

        let next_statement_index = progress.statement_index + planned_statement.statement.source_statement_count;
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
    controlled_statement: &ControlledSqlFileImportStatement,
    success_count: &mut usize,
    failure_count: &mut usize,
    affected_rows: &mut u64,
    mut mysql_executor: Option<&mut MySqlSqlFileExecutor>,
    emit: &mut impl FnMut(SqlFileProgress),
) -> Result<bool, String> {
    let statement = &controlled_statement.statement;
    let continue_on_error = request.continue_on_error && !controlled_statement.stop_on_error;
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
                    continue_on_error,
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
                continue_on_error,
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
    continue_on_error: bool,
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
                    continue_on_error,
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
    if let Some(session_id) = request.txn_session_id.as_deref() {
        let schema = sql_file_transaction_schema(state, request).await?;
        let mut results =
            execute_in_manual_transaction(state, session_id, sql, &request.database, schema.as_deref(), Some(1))
                .await?
                .into_iter();
        let mut result = results.next().ok_or("SQL file statement returned no result")?;
        for next in results {
            result.affected_rows += next.affected_rows;
            result.execution_time_ms += next.execution_time_ms;
        }
        return Ok(result);
    }
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

    let timeout_secs = {
        let configs = state.configs.read().await;
        configs.get(&request.connection_id).map(|config| config.effective_query_timeout_secs())
    };
    let result = execute_sql_statement_with_options(
        state,
        &request.connection_id,
        &request.database,
        sql,
        None,
        Some(child_token),
        QueryExecutionOptions { execution_id: Some(execution_id), timeout_secs, ..Default::default() },
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

    #[test]
    fn manual_file_plan_keeps_insert_error_boundaries() {
        let statements = split_sql_file_import_statements_with_control(
            "INSERT INTO t VALUES (1); INSERT INTO t VALUES (2);",
            Some(DatabaseType::Postgres),
            None,
        );
        let optimized = plan_sql_file_statements(&statements, Some(DatabaseType::Postgres), None, false);
        assert_eq!(optimized.len(), 1);
        let manual = plan_sql_file_statements(&statements, Some(DatabaseType::Postgres), None, true);
        assert_eq!(manual.len(), 2);
        assert!(manual.iter().all(|item| item.stop_on_error && item.statement.source_statement_count == 1));
        assert_eq!(manual[0].statement.sql, statements[0].sql);
        assert_eq!(manual[1].statement.sql, statements[1].sql);
    }

    #[tokio::test]
    async fn manual_file_missing_session_never_falls_back_to_ordinary_execution() {
        let directory = tempfile::tempdir().unwrap();
        let storage = crate::storage::Storage::open(&directory.path().join("storage.db")).await.unwrap();
        let state = AppState::new(storage);
        let request = SqlFileRequest {
            txn_session_id: Some("expired-session".to_string()),
            execution_id: "file-missing-session".to_string(),
            connection_id: "unconfigured".to_string(),
            database: String::new(),
            file_path: String::new(),
            continue_on_error: false,
            selected_tables: None,
            part_cooldown_ms: 0,
            skip_relational_constraints: false,
        };
        let mut events = Vec::new();
        let error = execute_sql_file_content(
            &state,
            &request,
            "INSERT INTO t VALUES (1);",
            CancellationToken::new(),
            Instant::now(),
            |event| events.push(event),
        )
        .await
        .unwrap_err();
        assert!(error.contains("transaction session not found"));
        assert!(events.is_empty());
    }

    async fn temporary_sql_file(bytes: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "dbx-sql-file-{}-{}.sql",
            std::process::id(),
            TEMP_SQL_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        tokio::fs::write(&path, bytes).await.unwrap();
        path
    }

    async fn temporary_gzip_sql_file(bytes: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "dbx-sql-file-{}-{}.sql.gz",
            std::process::id(),
            TEMP_SQL_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let bytes = bytes.to_vec();
        let output = path.clone();
        tokio::task::spawn_blocking(move || {
            use std::io::Write;

            let file = std::fs::File::create(&output).unwrap();
            let mut writer = flate2::write::GzEncoder::new(file, flate2::Compression::default());
            writer.write_all(&bytes).unwrap();
            writer.finish().unwrap();
        })
        .await
        .unwrap();
        path
    }

    #[tokio::test]
    async fn table_restore_scan_reads_beyond_preview_and_supports_gzip_and_utf16() {
        let sql = format!(
            "CREATE TABLE a (id INT); INSERT INTO a VALUES ('{}'); CREATE TABLE late_table (id INT);",
            "x".repeat(1_100_000)
        );
        let mut utf16 = vec![0xff, 0xfe];
        for unit in sql.encode_utf16() {
            utf16.extend_from_slice(&unit.to_le_bytes());
        }
        for path in [
            temporary_sql_file(sql.as_bytes()).await,
            temporary_gzip_sql_file(sql.as_bytes()).await,
            temporary_sql_file(&utf16).await,
        ] {
            let tables = inspect_sql_file_tables(&path).await.unwrap();
            tokio::fs::remove_file(&path).await.unwrap();
            assert_eq!(tables.iter().map(|table| table.name.as_str()).collect::<Vec<_>>(), vec!["a", "late_table"]);
        }
    }

    #[test]
    fn table_restore_stream_filters_each_statement_once_across_chunks() {
        let selected = [
            SqlFileTable { database: None, name: "a".to_string() },
            SqlFileTable { database: Some("second".to_string()), name: "b".to_string() },
        ];
        let mut splitter =
            StreamingSqlFileSplitter::new(Some(DatabaseType::Mysql), SqlParsingOptions::mysql_compatible());
        let mut filter = TableRestoreFilter::default();
        let mut statements = Vec::new();
        for chunk in ["INSERT INTO a VALUES (1); USE second;", "INSERT INTO b VALUES (2); INSERT INTO a VALUES (3);"] {
            let mut next = splitter.push_chunk(chunk);
            filter_restore_statements(&mut next, &mut filter, &selected).unwrap();
            statements.extend(next);
        }
        let mut next = splitter.finish();
        filter_restore_statements(&mut next, &mut filter, &selected).unwrap();
        statements.extend(next);
        assert_eq!(
            statements.iter().map(|statement| statement.sql.as_str()).collect::<Vec<_>>(),
            vec!["INSERT INTO a VALUES (1)", "USE second", "INSERT INTO b VALUES (2)"]
        );
    }

    #[test]
    fn table_restore_request_is_opt_in_and_rejects_empty_or_missing_selections() {
        let mut request: SqlFileRequest = serde_json::from_value(serde_json::json!({"executionId":"test", "connectionId":"conn", "database":"app", "filePath":"backup.sql", "continueOnError":false})).unwrap();
        assert!(request.selected_tables.is_none());
        assert!(validate_table_restore_target(&request, None, 1).is_ok());
        request.selected_tables = Some(Vec::new());
        assert!(validate_table_restore_target(&request, None, 1).is_err());
        request.selected_tables = Some(vec![SqlFileTable { database: None, name: "a".to_string() }]);
        assert!(validate_table_restore_target(
            &request,
            Some(&SqlFileImportTarget {
                db_type: DatabaseType::Postgres,
                driver_profile: None,
                compatibility_mode: SqlCompatibilityMode::NotApplicable
            }),
            1
        )
        .is_err());
        assert!(validate_table_restore_target(
            &request,
            Some(&SqlFileImportTarget {
                db_type: DatabaseType::Mysql,
                driver_profile: None,
                compatibility_mode: SqlCompatibilityMode::NotApplicable
            }),
            2
        )
        .is_err());
        assert!(validate_selected_tables(request.selected_tables.as_ref().unwrap(), &[]).is_err());
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
            bytes_read: None,
            total_bytes: None,
            phase: None,
            file_index: None,
            file_name: None,
        }
    }

    fn test_file_progress(
        status: SqlFileStatus,
        statement_index: usize,
        file_index: usize,
        file_name: &str,
    ) -> SqlFileProgress {
        SqlFileProgress {
            file_index: Some(file_index),
            file_name: Some(file_name.to_string()),
            ..test_progress(status, statement_index)
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

    #[tokio::test]
    async fn file_progress_counts_source_bytes_without_counting_encoding_detection() {
        let sql = "SELECT '中文';\n".repeat(40_000);
        let mut utf16 = vec![0xff, 0xfe];
        utf16.extend(sql.encode_utf16().flat_map(u16::to_le_bytes));
        let (gbk, _, _) = encoding_rs::GBK.encode(&sql);
        for bytes in [sql.as_bytes().to_vec(), utf16, gbk.into_owned()] {
            let path = temporary_sql_file(&bytes).await;
            let read_progress = SqlFileReadProgress::new(&[&path]).await;
            let mut decoder =
                SqlFileStreamDecoder::open_for_target_with_progress(&path, false, read_progress.bytes_read.clone())
                    .await
                    .unwrap();
            assert_eq!(read_progress.bytes_read.load(Ordering::Relaxed), 3);
            let mut decoded = String::new();
            let mut previous = 0;
            while let Some(chunk) = decoder.next_chunk().await.unwrap() {
                decoded.push_str(&chunk);
                let current = read_progress.bytes_read.load(Ordering::Relaxed);
                assert!(current >= previous && current <= bytes.len() as u64);
                previous = current;
            }
            assert_eq!(decoded, sql);
            assert_eq!(read_progress.bytes_read.load(Ordering::Relaxed), bytes.len() as u64);
            assert_eq!(read_progress.total_bytes, Some(bytes.len() as u64));
            tokio::fs::remove_file(path).await.unwrap();
        }
    }

    #[tokio::test]
    async fn file_progress_aggregates_plain_compressed_and_empty_files() {
        let sql = "SELECT 1;\n".repeat(80_000);
        let paths = [
            temporary_sql_file(sql.as_bytes()).await,
            temporary_gzip_sql_file(sql.as_bytes()).await,
            temporary_sql_file(b"").await,
        ];
        let path_refs = paths.iter().map(|path| path.as_path()).collect::<Vec<_>>();
        let read_progress = SqlFileReadProgress::new(&path_refs).await;
        let mut expected_bytes = 0;
        for path in &paths {
            let mut decoder =
                SqlFileStreamDecoder::open_for_target_with_progress(path, false, read_progress.bytes_read.clone())
                    .await
                    .unwrap();
            while decoder.next_chunk().await.unwrap().is_some() {}
            expected_bytes += tokio::fs::metadata(path).await.unwrap().len();
            assert_eq!(read_progress.bytes_read.load(Ordering::Relaxed), expected_bytes);
        }
        assert_eq!(read_progress.total_bytes, Some(expected_bytes));
        assert!(expected_bytes < 2 * sql.len() as u64);
        for path in paths {
            tokio::fs::remove_file(path).await.unwrap();
        }
    }

    #[tokio::test]
    async fn file_progress_does_not_invent_missing_file_sizes() {
        let path = std::env::temp_dir().join(format!("dbx-missing-sql-{}", uuid::Uuid::new_v4()));
        assert_eq!(SqlFileReadProgress::new(&[&path]).await.total_bytes, None);
    }

    #[test]
    fn file_progress_distinguishes_reading_execution_and_terminal_states() {
        let read_progress = SqlFileReadProgress { bytes_read: Arc::new(AtomicU64::new(25)), total_bytes: Some(100) };
        let started = read_progress.attach(test_progress(SqlFileStatus::Started, 0));
        assert_eq!(started.phase, Some(SqlFilePhase::Preparing));
        let mut reading = test_progress(SqlFileStatus::Running, 0);
        reading.statement_summary.clear();
        assert_eq!(read_progress.attach(reading).phase, Some(SqlFilePhase::Reading));
        assert_eq!(read_progress.attach(test_progress(SqlFileStatus::Running, 1)).phase, Some(SqlFilePhase::Executing));
        for status in [SqlFileStatus::Done, SqlFileStatus::Error, SqlFileStatus::Cancelled] {
            let event = read_progress.attach(test_progress(status, 1));
            assert_eq!(event.status, status);
            assert_eq!(event.phase, None);
            assert_eq!(event.bytes_read, Some(25));
            assert_eq!(event.total_bytes, Some(100));
        }
        let old_payload = serde_json::to_value(test_progress(SqlFileStatus::Running, 1)).unwrap();
        assert!(old_payload.get("bytesRead").is_none());
        assert_eq!(serde_json::from_value::<SqlFileProgress>(old_payload).unwrap().bytes_read, None);
    }

    #[tokio::test]
    async fn file_progress_executor_preserves_success_cancellation_and_failure() {
        let directory = std::env::temp_dir().join(format!("dbx-file-progress-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let storage = crate::storage::Storage::open(&directory.join("storage.db")).await.unwrap();
        let state = AppState::new(storage);
        let comments = "-- no database operation\n".repeat(40_000).into_bytes();
        for (bytes, cancel, terminal) in [
            (Vec::new(), false, SqlFileStatus::Done),
            (comments.clone(), false, SqlFileStatus::Done),
            (comments, true, SqlFileStatus::Cancelled),
            (vec![0xef, 0xbb, 0xbf, 0xff], false, SqlFileStatus::Error),
            (b"SELECT 1;".to_vec(), false, SqlFileStatus::Error),
        ] {
            let path = temporary_sql_file(&bytes).await;
            let request = SqlFileRequest {
                txn_session_id: None,
                execution_id: "file-progress".to_string(),
                connection_id: "unconfigured".to_string(),
                database: String::new(),
                file_path: path.to_string_lossy().to_string(),
                continue_on_error: false,
                selected_tables: None,
                part_cooldown_ms: 0,
                skip_relational_constraints: false,
            };
            let token = CancellationToken::new();
            let mut events = Vec::new();
            let result = execute_sql_file_path(&state, &request, &path, token.clone(), Instant::now(), |event| {
                if cancel && event.phase == Some(SqlFilePhase::Reading) {
                    token.cancel();
                }
                events.push(event);
            })
            .await;
            assert_eq!(result.is_err(), terminal == SqlFileStatus::Error);
            assert_eq!(events.last().unwrap().status, terminal);
            assert!(events.iter().all(|event| event.total_bytes == Some(bytes.len() as u64)));
            assert!(events.windows(2).all(|pair| pair[0].bytes_read <= pair[1].bytes_read));
            assert_eq!(
                events
                    .iter()
                    .filter(|event| matches!(
                        event.status,
                        SqlFileStatus::Done | SqlFileStatus::Error | SqlFileStatus::Cancelled
                    ))
                    .count(),
                1
            );
            tokio::fs::remove_file(path).await.unwrap();
        }
        drop(state);
        tokio::fs::remove_dir_all(directory).await.unwrap();
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

    #[tokio::test]
    async fn streaming_import_prefers_utf8_bom_over_explicit_gbk() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("INSERT INTO t VALUES ('中文');".as_bytes());
        let path = temporary_sql_file(&bytes).await;
        let mut decoder =
            SqlFileStreamDecoder::open_for_import(&path, Some(encoding_rs::GBK), false, None).await.unwrap();
        let mut decoded = String::new();
        while let Some(chunk) = decoder.next_chunk().await.unwrap() {
            decoded.push_str(&chunk);
        }
        tokio::fs::remove_file(path).await.unwrap();

        assert_eq!(decoder.encoding(), encoding_rs::UTF_8);
        assert_eq!(decoded, "INSERT INTO t VALUES ('中文');");
    }

    #[tokio::test]
    async fn streaming_import_prefers_utf16le_bom_over_explicit_utf8() {
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "SELECT '中文';".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let path = temporary_sql_file(&bytes).await;
        let mut decoder =
            SqlFileStreamDecoder::open_for_import(&path, Some(encoding_rs::UTF_8), false, None).await.unwrap();
        let mut decoded = String::new();
        while let Some(chunk) = decoder.next_chunk().await.unwrap() {
            decoded.push_str(&chunk);
        }
        tokio::fs::remove_file(path).await.unwrap();

        assert_eq!(decoder.encoding(), encoding_rs::UTF_16LE);
        assert_eq!(decoded, "SELECT '中文';");
    }

    #[tokio::test]
    async fn streaming_import_uses_explicit_encoding_without_bom() {
        let sql = "INSERT INTO t VALUES ('中文');";
        let (encoded, _, _) = encoding_rs::GBK.encode(sql);
        let path = temporary_sql_file(encoded.as_ref()).await;
        let mut decoder =
            SqlFileStreamDecoder::open_for_import(&path, Some(encoding_rs::GBK), false, None).await.unwrap();
        let mut decoded = String::new();
        while let Some(chunk) = decoder.next_chunk().await.unwrap() {
            decoded.push_str(&chunk);
        }
        tokio::fs::remove_file(path).await.unwrap();

        assert_eq!(decoder.encoding(), encoding_rs::GBK);
        assert_eq!(decoded, sql);
    }

    #[tokio::test]
    async fn streaming_decoder_reads_gzip_sql_files() {
        let path = temporary_gzip_sql_file(b"SELECT 'compressed';\n").await;
        let mut decoder = SqlFileStreamDecoder::open(&path).await.unwrap();
        let mut decoded = String::new();
        while let Some(chunk) = decoder.next_chunk().await.unwrap() {
            decoded.push_str(&chunk);
        }
        tokio::fs::remove_file(path).await.unwrap();

        assert_eq!(decoded, "SELECT 'compressed';\n");
    }

    #[tokio::test]
    async fn mysql_target_decoder_preserves_utf16le_bom_files() {
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "SELECT _binary 'abc', '中文';".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let path = temporary_sql_file(&bytes).await;
        let mut decoder = SqlFileStreamDecoder::open_for_target(&path, true).await.unwrap();
        let mut decoded = String::new();
        while let Some(chunk) = decoder.next_chunk().await.unwrap() {
            decoded.push_str(&chunk);
        }
        tokio::fs::remove_file(path).await.unwrap();

        assert_eq!(decoded, "SELECT _binary 'abc', '中文';");
    }

    #[tokio::test]
    async fn mysql_target_decoder_preserves_gbk_files() {
        let sql = "INSERT INTO t VALUES ('中文');";
        let (encoded, _, _) = encoding_rs::GBK.encode(sql);
        let path = temporary_sql_file(encoded.as_ref()).await;
        let mut decoder = SqlFileStreamDecoder::open_for_target(&path, true).await.unwrap();
        let mut decoded = String::new();
        while let Some(chunk) = decoder.next_chunk().await.unwrap() {
            decoded.push_str(&chunk);
        }
        tokio::fs::remove_file(path).await.unwrap();

        assert_eq!(decoded, sql);
    }

    #[test]
    fn mysql_binary_literal_normalizer_preserves_bytes_and_mysql_escapes() {
        let mut source = b"INSERT INTO t VALUES (_binary '".to_vec();
        source.extend_from_slice(&[0xAC, b'\\', 0xED, b'\\', b'0', b'\\', b'n', b'\\', b'\'', b'\\', b'\\']);
        source.extend_from_slice(b"'); -- _binary '\\xFF'\nSELECT 'not _binary x';");

        let mut normalizer = MysqlDumpBinaryLiteralNormalizer::default();
        let mut normalized = Vec::new();
        for chunk in source.chunks(3) {
            normalized.extend(normalizer.normalize(chunk, false).unwrap());
        }
        normalized.extend(normalizer.normalize(&[], true).unwrap());

        assert_eq!(
            String::from_utf8(normalized).unwrap(),
            "INSERT INTO t VALUES (X'ACED000A275C'); -- _binary '\\xFF'\nSELECT 'not _binary x';"
        );
    }

    #[tokio::test]
    async fn streaming_decoder_recovers_utf8_mysql_dump_with_raw_binary_bytes() {
        let mut bytes = b"-- MySQL dump\nINSERT INTO t VALUES (_binary '".to_vec();
        bytes.extend_from_slice(&[0xAC, b'\\', 0xED, b'\\', b'0', 0x05]);
        bytes.extend_from_slice(b"', '\xE4\xB8\xAD\xE6\x96\x87');\n");
        let path = temporary_sql_file(&bytes).await;
        let mut decoder = SqlFileStreamDecoder::open(&path).await.unwrap();
        let mut decoded = String::new();
        while let Some(chunk) = decoder.next_chunk().await.unwrap() {
            decoded.push_str(&chunk);
        }
        tokio::fs::remove_file(path).await.unwrap();

        assert_eq!(decoded, "-- MySQL dump\nINSERT INTO t VALUES (X'ACED0005', '中文');\n");
    }

    #[tokio::test]
    async fn streaming_decoder_recovers_bom_utf8_mysql_dump_with_raw_binary_bytes() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"INSERT INTO t VALUES (_binary '");
        bytes.extend_from_slice(&[0xAC, b'\\', 0xED, b'\\', b'0', 0x05]);
        bytes.extend_from_slice(b"');\n");
        let path = temporary_sql_file(&bytes).await;
        let mut decoder = SqlFileStreamDecoder::open(&path).await.unwrap();
        let mut decoded = String::new();
        while let Some(chunk) = decoder.next_chunk().await.unwrap() {
            decoded.push_str(&chunk);
        }
        tokio::fs::remove_file(path).await.unwrap();

        assert_eq!(decoded, "INSERT INTO t VALUES (X'ACED0005');\n");
    }

    #[tokio::test]
    async fn streaming_decoder_recovers_gzip_mysql_dump_with_raw_binary_bytes() {
        // Encoding detection and binary-literal validation must run on the
        // decompressed bytes, not on the raw gzip stream.
        let mut bytes = b"-- MySQL dump\nINSERT INTO t VALUES (_binary '".to_vec();
        bytes.extend_from_slice(&[0xAC, b'\\', 0xED, b'\\', b'0', 0x05]);
        bytes.extend_from_slice(b"', '\xE4\xB8\xAD\xE6\x96\x87');\n");
        let path = temporary_gzip_sql_file(&bytes).await;
        let mut decoder = SqlFileStreamDecoder::open(&path).await.unwrap();
        let mut decoded = String::new();
        while let Some(chunk) = decoder.next_chunk().await.unwrap() {
            decoded.push_str(&chunk);
        }
        tokio::fs::remove_file(path).await.unwrap();

        assert_eq!(decoded, "-- MySQL dump\nINSERT INTO t VALUES (X'ACED0005', '中文');\n");
    }

    #[test]
    fn mysql_binary_literal_normalizer_does_not_rewrite_comments_or_strings() {
        let source = b"-- _binary '\xAC'\nSELECT '_binary \'x\'', `col_binary`; /* _binary '\xAC' */";
        let mut normalizer = MysqlDumpBinaryLiteralNormalizer::default();
        let normalized = normalizer.normalize(source, true).unwrap();

        assert_eq!(normalized, source);
    }

    #[test]
    fn mysql_binary_literal_normalizer_rejects_unterminated_literal() {
        let mut normalizer = MysqlDumpBinaryLiteralNormalizer::default();
        let error = normalizer.normalize(b"SELECT _binary 'abc", true).unwrap_err();

        assert_eq!(error, "Unterminated MySQL binary literal");
    }

    #[test]
    fn mysql_binary_literal_normalizer_treats_dash_dash_digit_as_subtraction() {
        // MySQL treats `--` as a comment opener only when followed by whitespace
        // or a control character, so `5--1` is subtraction and the `_binary`
        // literal later on the same line must still be normalized.
        let mut source = b"SELECT 5--1, _binary '".to_vec();
        source.extend_from_slice(&[0xAC, 0x05]);
        source.extend_from_slice(b"';\n");

        let mut normalizer = MysqlDumpBinaryLiteralNormalizer::default();
        let normalized = normalizer.normalize(&source, true).unwrap();

        assert_eq!(normalized, b"SELECT 5--1, X'AC05';\n".to_vec());
    }

    #[test]
    fn non_sqlserver_sql_file_keeps_statement_splitting_behavior() {
        assert_eq!(
            split_sql_file_import_statements("SELECT 1; SELECT 2;", Some(DatabaseType::Postgres)),
            vec!["SELECT 1", "SELECT 2"]
        );
    }

    #[tokio::test]
    async fn streaming_gaussdb_on_error_stop_overrides_continue_on_error_at_script_position() {
        let dir = std::env::temp_dir().join(format!("dbx-sql-file-stop-on-error-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = crate::storage::Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = crate::connection::AppState::new(storage);
        let config: crate::models::connection::ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "gauss-stream",
            "name": "GaussDB stream test",
            "db_type": "gaussdb",
            "host": "localhost",
            "port": 5432,
            "username": "",
            "password": "",
            "database": null
        }))
        .unwrap();
        state.configs.write().await.insert(config.id.clone(), config);

        let pool = crate::db::sqlite::connect_path(":memory:").await.unwrap();
        state
            .update_connection_pools(|connections| {
                connections.insert("gauss-stream".to_string(), crate::connection::PoolKind::Sqlite(pool.clone()));
            })
            .await;

        let path = temporary_sql_file(
            b"CREATE TABLE side_effects(value INTEGER);\nINSERT INTO missing_before_control VALUES (1);\nINSERT INTO side_effects VALUES (1);\n\\set ON_ERROR_STOP on\nINSERT INTO missing_after_control VALUES (1);\nINSERT INTO side_effects VALUES (2);",
        )
        .await;
        let request = SqlFileRequest {
            txn_session_id: None,
            execution_id: "gauss-stop-on-error".to_string(),
            connection_id: "gauss-stream".to_string(),
            database: String::new(),
            file_path: path.to_string_lossy().to_string(),
            continue_on_error: true,
            selected_tables: None,
            part_cooldown_ms: 0,
            skip_relational_constraints: false,
        };
        let mut progress = Vec::new();

        let result =
            execute_sql_file_path(&state, &request, &path, CancellationToken::new(), Instant::now(), |event| {
                progress.push(event)
            })
            .await;

        assert!(result.is_err());
        let count = crate::db::sqlite::execute_query(&pool, "SELECT COUNT(*) FROM side_effects").await.unwrap().rows[0]
            [0]
        .as_i64();
        assert_eq!(count, Some(1));
        assert!(progress.iter().any(|event| event.status == SqlFileStatus::Error));
        assert!(!progress.iter().any(|event| event.status == SqlFileStatus::Done));

        let _ = tokio::fs::remove_file(path).await;
        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[test]
    fn postgres_pg_dump_guards_are_removed_from_import_plan() {
        let statements = split_sql_file_import_statements(
            "-- PostgreSQL database dump\n\n\\restrict Guard123\n\nSET statement_timeout = 0;\nSELECT 1;\n\n-- PostgreSQL database dump complete\n\n\\unrestrict Guard123",
            Some(DatabaseType::Postgres),
        );
        let planned = optimize_sql_file_import_statements(&statements, Some(DatabaseType::Postgres), None);

        assert_eq!(planned.len(), 3);
        assert_eq!(planned[0].kind, SqlFileImportStatementKind::Execute);
        assert!(!planned[0].sql.contains("\\restrict"));
        assert!(planned[0].sql.contains("SET statement_timeout = 0"));
        assert_eq!(planned[1].sql, "SELECT 1");
        assert_eq!(planned[2].kind, SqlFileImportStatementKind::Skip);
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
    fn mysql_like_sql_file_bootstrap_analysis_tracks_context_for_following_files() {
        assert_eq!(
            mysql_like_sql_file_bootstrap_analysis("SHOW DATABASES;"),
            MysqlLikeSqlFileBootstrapAnalysis {
                can_execute_without_selected_database: true,
                establishes_database_context: false,
            }
        );
        assert_eq!(
            mysql_like_sql_file_bootstrap_analysis("CREATE DATABASE app_db;\nUSE app_db;\nCREATE TABLE users(id INT);"),
            MysqlLikeSqlFileBootstrapAnalysis {
                can_execute_without_selected_database: true,
                establishes_database_context: true,
            }
        );
        assert_eq!(
            mysql_like_sql_file_bootstrap_analysis("CREATE TABLE users(id INT);"),
            MysqlLikeSqlFileBootstrapAnalysis {
                can_execute_without_selected_database: false,
                establishes_database_context: false,
            }
        );
    }

    #[test]
    fn execution_error_progress_preserves_cumulative_counters() {
        let progress =
            SqlFileExecutionProgress { statement_index: 4, success_count: 3, failure_count: 1, affected_rows: 9 };

        let terminal =
            sql_file_execution_error_progress("exec-1", Instant::now(), &progress, "file missing".to_string());

        assert_eq!(terminal.status, SqlFileStatus::Error);
        assert_eq!(terminal.statement_index, 4);
        assert_eq!(terminal.success_count, 3);
        assert_eq!(terminal.failure_count, 1);
        assert_eq!(terminal.affected_rows, 9);
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

    #[test]
    fn file_boundary_events_bypass_throttling_and_retain_order() {
        // Regression: rapid multi-file runs must not lose per-file boundary
        // events through the progress emitter's 100 ms throttle window.
        let base = Instant::now();
        let elapsed = Cell::new(Duration::ZERO);
        let mut emitted = Vec::new();
        {
            let mut emitter =
                SqlFileProgressEmitter::with_clock(|progress| emitted.push(progress), || base + elapsed.get());

            // Simulate two small files executing within the same throttle window.
            for statement_index in 1..=3 {
                emitter.emit(test_progress(SqlFileStatus::StatementDone, statement_index));
            }
            // File 0 start + done.
            emitter.emit(test_file_progress(SqlFileStatus::Running, 3, 0, "a.sql"));
            emitter.emit(test_file_progress(SqlFileStatus::StatementDone, 3, 0, "a.sql"));

            for statement_index in 4..=6 {
                emitter.emit(test_progress(SqlFileStatus::StatementDone, statement_index));
            }
            // File 1 start + done — still within the same throttle window.
            emitter.emit(test_file_progress(SqlFileStatus::Running, 6, 1, "b.sql"));
            emitter.emit(test_file_progress(SqlFileStatus::StatementDone, 6, 1, "b.sql"));

            emitter.emit(test_progress(SqlFileStatus::Done, 6));
        }

        let file_boundary_events: Vec<_> = emitted
            .iter()
            .filter(|p| p.file_index.is_some())
            .map(|p| (p.status, p.file_index, p.file_name.clone()))
            .collect();
        assert_eq!(
            file_boundary_events,
            vec![
                (SqlFileStatus::Running, Some(0), Some("a.sql".to_string())),
                (SqlFileStatus::StatementDone, Some(0), Some("a.sql".to_string())),
                (SqlFileStatus::Running, Some(1), Some("b.sql".to_string())),
                (SqlFileStatus::StatementDone, Some(1), Some("b.sql".to_string())),
            ],
            "file-boundary events must be emitted immediately, in order, without being dropped by throttling"
        );
        assert_eq!(emitted.last().unwrap().status, SqlFileStatus::Done);
    }

    // No live PostgreSQL/SQL Server instance is available in this unit-test
    // module (see the `#[ignore]`d live_* integration tests for those), so
    // these regression tests assert on the generated SQL/control-flow source
    // directly for the two properties raised in review:
    //   1. the restore (re-enable) call must not be gated on the same
    //      `CancellationToken` used for the import, or a user cancellation
    //      permanently disables constraints database-wide (see
    //      `execute_sql_file_content` / `execute_sql_file_paths`).
    //   2. the PostgreSQL disable statement must fail loudly instead of
    //      silently doing nothing when every table hits `insufficient_privilege`
    //      (non-superuser importing roles cannot disable internal FK/RI
    //      triggers on tables they do not own).

    #[test]
    fn relational_constraint_restore_never_reuses_the_import_cancellation_token() {
        let source = include_str!("sql_file_import.rs");
        for call_site in
            source.match_indices("set_relational_constraints_enabled(state, request, kind, ").map(|(i, _)| i)
        {
            let after_call = &source[call_site..];
            let args_end = after_call.find(')').unwrap_or(after_call.len());
            let call = &after_call[..args_end];
            let is_restore_call = call.trim_end().ends_with("true");
            if is_restore_call {
                assert!(
                    call.contains("CancellationToken::new()"),
                    "restore (enable=true) call must use a fresh CancellationToken, not the import's \
                     (possibly already-cancelled) token, or constraints stay disabled database-wide \
                     after a cancel: {call}"
                );
            }
        }
    }

    #[test]
    fn postgres_constraint_disable_raises_when_every_table_lacks_privilege() {
        assert!(
            POSTGRES_DISABLE_ALL_RELATIONAL_TRIGGERS_SQL.contains("dbx_total > 0 AND dbx_disabled = 0"),
            "the disable statement must detect and raise when it altered zero of the tables it found, \
             instead of silently continuing as if the bypass succeeded"
        );
        assert!(
            POSTGRES_DISABLE_ALL_RELATIONAL_TRIGGERS_SQL.contains("RAISE EXCEPTION"),
            "must actually raise, not just count, so the caller's `execute_sql_statement_with_options` call \
             surfaces an error instead of reporting success"
        );
    }

    #[test]
    fn postgres_and_sqlserver_disable_statements_exclude_system_schemas() {
        for schema in ["pg_catalog", "information_schema", "pg_toast"] {
            assert!(
                POSTGRES_DISABLE_ALL_RELATIONAL_TRIGGERS_SQL.contains(schema),
                "must exclude system schema {schema} or the bypass tries to alter catalog tables"
            );
        }
        assert!(SQLSERVER_DISABLE_ALL_FOREIGN_KEYS_SQL.contains("is_ms_shipped = 0"));
    }

    #[test]
    fn relational_constraint_bypass_kind_covers_postgres_family_and_sqlserver() {
        let target = |db_type| SqlFileImportTarget {
            db_type,
            driver_profile: None,
            compatibility_mode: SqlCompatibilityMode::NotApplicable,
        };
        assert_eq!(
            relational_constraint_bypass_kind(&target(DatabaseType::Mysql)),
            Some(RelationalConstraintBypassKind::Mysql)
        );
        for db_type in [DatabaseType::Postgres, DatabaseType::Gaussdb, DatabaseType::OpenGauss] {
            assert_eq!(
                relational_constraint_bypass_kind(&target(db_type)),
                Some(RelationalConstraintBypassKind::Postgres),
                "{db_type:?} should use the PostgreSQL trigger-disable bypass"
            );
        }
        assert_eq!(
            relational_constraint_bypass_kind(&target(DatabaseType::SqlServer)),
            Some(RelationalConstraintBypassKind::SqlServer)
        );
        assert_eq!(relational_constraint_bypass_kind(&target(DatabaseType::Oracle)), None);
    }
}
