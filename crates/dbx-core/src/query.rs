use futures::StreamExt;
use mysql_async::prelude::Queryable;
use serde::{Deserialize, Serialize};
use sqlparser::ast::{
    visit_relations_mut, Ident, ObjectName, ObjectNamePart, ObjectType, Statement, TableFactor, VisitMut, VisitorMut,
};
use sqlparser::dialect::{GenericDialect, PostgreSqlDialect};
use sqlparser::parser::Parser;
use std::collections::HashSet;
use std::future::Future;
use std::ops::ControlFlow;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::agent_recovery::{RecoveryDecision, RecoveryPolicy, RecoveryScope};
use crate::connection::{AppState, PoolKind, TransactionSession, TxnConnection};
use crate::database_capabilities;
use crate::db;
use crate::db::agent_driver::{AgentCallError, AgentErrorStage, AgentOperationOutcome};
use crate::models::connection::{ConnectionConfig, DatabaseType};
use crate::query_execution_sql::is_write_sql;
use crate::sql::{split_sql_batches, split_sql_statements};
use crate::sql_dialect::{resolve_for_db, CAP_TRANSACTIONAL_DDL};
use crate::sql_risk::{classify_sql_risk_for_database, SqlRisk};

pub const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
pub const MAX_ROWS: usize = 10000;
pub const QUERY_CANCELED: &str = "Query canceled";
/// Fallback when a Mongo connection hits the generic SQL executor instead of the shell path.
/// Wording must match packages/mongo-shell `MONGO_SHELL_COMMAND_HINT`
/// (desktop/CLI diagnose first; this is only the Rust SQL-executor backstop).
const MONGO_SHELL_COMMAND_HINT: &str = "Use MongoDB shell-style commands, for example: db.collection.find({}).limit(100), db.collection.aggregate([]), db.collection.aggregate([], { explain: true }), db.version(), db.collection.countDocuments({}), db.collection.distinct(\"field\"), db.collection.getIndexes(), db.collection.createIndex({...}), or db.collection.insertOne({...}).";
const SQL_OMITTED_ERROR_CONTEXT: &str =
    "SQL text omitted from user-facing error; enable debug SQL diagnostics to inspect the original statement.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PoolErrorAction {
    Keep,
    Discard,
    ReconnectAndRetry,
}

#[derive(Debug, Clone)]
pub enum QueryExecutionError {
    Agent(AgentCallError),
    DuckDb { code: String, message: String },
    Canceled { stage: AgentErrorStage, operation_outcome: AgentOperationOutcome },
    Timeout(String),
    Sql(String),
    Legacy(String),
}

impl QueryExecutionError {
    pub fn into_legacy_string(self) -> String {
        match self {
            Self::Agent(error) => error.into_legacy_string(),
            Self::DuckDb { message, .. } => message,
            Self::Canceled { .. } => canceled_error(),
            Self::Timeout(error) => error,
            Self::Sql(error) => error,
            Self::Legacy(error) => error,
        }
    }

    pub fn into_backend_error(self) -> crate::backend_error::BackendError {
        match self {
            Self::Agent(error) => crate::backend_error::BackendError::from_agent_call_error(&error),
            Self::DuckDb { code, message } => {
                crate::backend_error::BackendError::from_duckdb_worker_error(&code, &message)
            }
            Self::Canceled { stage, operation_outcome } => {
                crate::backend_error::BackendError::from_canceled(stage, operation_outcome)
            }
            Self::Timeout(error) => crate::backend_error::BackendError::from_timeout_detail(&error),
            Self::Sql(error) => crate::backend_error::BackendError::from_sql_detail(&error),
            Self::Legacy(error) => crate::backend_error::BackendError::from_legacy_string(&error),
        }
    }

    fn with_omitted_sql_context(self, sql: &str) -> Self {
        match self {
            Self::Agent(error) => Self::Agent(error),
            Self::DuckDb { code, message } => {
                Self::DuckDb { code, message: query_error_with_omitted_sql_context(&message, sql) }
            }
            canceled @ Self::Canceled { .. } => canceled,
            Self::Timeout(error) => Self::Timeout(query_error_with_omitted_sql_context(&error, sql)),
            Self::Sql(error) => Self::Sql(append_typed_sql_error_context(&error, sql)),
            Self::Legacy(error) => Self::Legacy(query_error_with_omitted_sql_context(&error, sql)),
        }
    }

    fn with_context(self, context: &str) -> Self {
        match self {
            Self::Agent(error) => Self::Agent(error),
            Self::DuckDb { code, message } => Self::DuckDb { code, message: format!("{message}; {context}") },
            canceled @ Self::Canceled { .. } => canceled,
            Self::Timeout(error) => Self::Timeout(format!("{error}; {context}")),
            Self::Sql(error) => Self::Sql(format!("{error}; {context}")),
            Self::Legacy(error) => Self::Legacy(format!("{error}; {context}")),
        }
    }

    fn as_agent_error(&self) -> Option<&AgentCallError> {
        match self {
            Self::Agent(error) => Some(error),
            Self::DuckDb { .. } | Self::Canceled { .. } | Self::Timeout(_) | Self::Sql(_) | Self::Legacy(_) => None,
        }
    }
}

impl std::fmt::Display for QueryExecutionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Agent(error) => error.fmt(formatter),
            Self::DuckDb { message, .. } => formatter.write_str(message),
            Self::Canceled { .. } => formatter.write_str(QUERY_CANCELED),
            Self::Timeout(error) => formatter.write_str(error),
            Self::Sql(error) => formatter.write_str(error),
            Self::Legacy(error) => formatter.write_str(error),
        }
    }
}

impl From<AgentCallError> for QueryExecutionError {
    fn from(error: AgentCallError) -> Self {
        Self::Agent(error)
    }
}

impl From<String> for QueryExecutionError {
    fn from(error: String) -> Self {
        Self::Legacy(error)
    }
}

impl From<&str> for QueryExecutionError {
    fn from(error: &str) -> Self {
        Self::Legacy(error.to_string())
    }
}

fn query_error_with_omitted_sql_context(error: &str, _sql: &str) -> String {
    crate::db::agent_driver::append_legacy_error_context(error, SQL_OMITTED_ERROR_CONTEXT)
}

fn append_typed_sql_error_context(error: &str, _sql: &str) -> String {
    if error.contains(SQL_OMITTED_ERROR_CONTEXT) {
        return error.to_string();
    }
    let separator = if error.trim_start().starts_with("Server error:") { " " } else { "\n" };
    format!("{error}{separator}{SQL_OMITTED_ERROR_CONTEXT}")
}

/// A multi-statement result with metadata intended for query clients.
///
/// `execution_error` is emitted for synthesized per-statement errors so clients
/// can distinguish them from a successful result column named `Error`.
/// `statement_index` is emitted only after a concrete statement starts running.
/// `server_message` is emitted only for SQL Server TDS informational messages.
#[derive(Debug, Clone, Serialize)]
pub struct ExecuteMultiResult {
    #[serde(flatten)]
    pub result: db::QueryResult,
    #[serde(skip_serializing_if = "is_false")]
    pub execution_error: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub statement_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<crate::backend_error::BackendError>,
    #[serde(skip_serializing_if = "is_false")]
    pub server_message: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExecuteMultiProgress {
    pub statement_index: usize,
    pub completed: usize,
    pub total: usize,
    pub success: bool,
    pub execution_time_ms: u128,
    pub affected_rows: u64,
    pub error: Option<crate::backend_error::BackendError>,
}

pub type ExecuteMultiProgressCallback = Arc<dyn Fn(ExecuteMultiProgress) + Send + Sync>;

fn report_execute_multi_progress(
    progress: Option<&ExecuteMultiProgressCallback>,
    statement_index: usize,
    total: usize,
    result: &db::QueryResult,
    success: bool,
    error: Option<crate::backend_error::BackendError>,
) {
    if let Some(progress) = progress {
        progress(ExecuteMultiProgress {
            statement_index,
            completed: statement_index + 1,
            total,
            success,
            execution_time_ms: result.execution_time_ms,
            affected_rows: result.affected_rows,
            error,
        });
    }
}

impl ExecuteMultiResult {
    fn execution_error(result: db::QueryResult) -> Self {
        let error = error_from_query_result(&result);
        Self { result, execution_error: true, statement_index: None, error, server_message: false }
    }

    fn execution_error_with_index(result: db::QueryResult, statement_index: usize) -> Self {
        let error = error_from_query_result(&result);
        Self { result, execution_error: true, statement_index: Some(statement_index), error, server_message: false }
    }

    fn execution_error_with_backend(
        result: db::QueryResult,
        statement_index: Option<usize>,
        error: crate::backend_error::BackendError,
    ) -> Self {
        Self { result, execution_error: true, statement_index, error: Some(error), server_message: false }
    }

    fn success_with_index(result: db::QueryResult, statement_index: usize) -> Self {
        Self {
            result,
            execution_error: false,
            statement_index: Some(statement_index),
            error: None,
            server_message: false,
        }
    }

    pub fn without_error_detail(mut self) -> Self {
        self.error = self.error.map(crate::backend_error::BackendError::without_detail);
        self
    }

    fn into_query_result(self) -> db::QueryResult {
        self.result
    }
}

impl From<db::QueryResult> for ExecuteMultiResult {
    fn from(result: db::QueryResult) -> Self {
        Self { result, execution_error: false, statement_index: None, error: None, server_message: false }
    }
}

impl From<db::sqlserver::SqlServerBatchResult> for ExecuteMultiResult {
    fn from(result: db::sqlserver::SqlServerBatchResult) -> Self {
        Self {
            result: result.result,
            execution_error: false,
            statement_index: None,
            error: None,
            server_message: result.server_message,
        }
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn error_from_query_result(result: &db::QueryResult) -> Option<crate::backend_error::BackendError> {
    result.rows.first()?.first()?.as_str().map(crate::backend_error::BackendError::from_legacy_string)
}

/// Unified database operation execution budget.
/// query_timeout = None only means SQL execution has no upper limit;
/// checkout/connect/recycle/cancel/cleanup always have hard upper limits and cannot be disabled.
#[derive(Debug, Clone)]
pub struct DbOperationBudget {
    pub checkout_timeout: Duration,
    pub connect_timeout: Duration,
    pub recycle_timeout: Duration,
    pub query_timeout: Option<Duration>,
    pub cancel_timeout: Duration,
    pub cleanup_timeout: Duration,
}

impl DbOperationBudget {
    /// Build an execution budget from connection config.
    /// checkout/connect/recycle use connect_timeout_secs (clamped to 1s minimum, 300s maximum).
    /// query_timeout follows resolve_query_timeout semantics (Some(0) -> None).
    /// cancel/cleanup are fixed values and cannot be disabled.
    pub fn from_config(connect_timeout_secs: u64, query_timeout_secs: Option<u64>) -> Self {
        let infra_timeout = Duration::from_secs(connect_timeout_secs.clamp(1, 300));
        Self {
            checkout_timeout: infra_timeout,
            connect_timeout: infra_timeout,
            recycle_timeout: infra_timeout,
            query_timeout: resolve_query_timeout(query_timeout_secs),
            cancel_timeout: Duration::from_secs(5),
            cleanup_timeout: Duration::from_secs(3),
        }
    }

    pub fn from_connection_config(config: &ConnectionConfig) -> Self {
        Self::from_config(config.effective_connect_timeout_secs(), Some(config.query_timeout_secs))
    }

    /// Use global default values (when no connection config is available).
    pub fn with_defaults() -> Self {
        let default_infra = db::connection_timeout();
        Self {
            checkout_timeout: default_infra,
            connect_timeout: default_infra,
            recycle_timeout: default_infra,
            query_timeout: Some(QUERY_TIMEOUT),
            cancel_timeout: Duration::from_secs(5),
            cleanup_timeout: Duration::from_secs(3),
        }
    }
}

/// Check read-only protection for a connection, blocking write SQL statements.
/// Only clones the connection name when read-only mode is active, avoiding
/// unnecessary allocations otherwise.
/// Uses config_for_pool_key to correctly resolve configs when pool_key includes
/// a database suffix (e.g., "prod:app" → config stored under "prod").
pub async fn check_read_only_for_connection(state: &AppState, pool_key: &str, sql: &str) -> Result<(), String> {
    let connection = {
        let configs = state.configs.read().await;
        crate::connection::config_for_pool_key(pool_key, &configs)
            .filter(|config| config.read_only)
            .map(|config| (config.name.clone(), config.db_type))
    };
    if let Some((name, database_type)) = connection {
        crate::query_execution_sql::check_read_only(sql, &name, database_type)?;
    }
    Ok(())
}

/// Check read-only protection for a connection across multiple SQL statements.
pub async fn check_read_only_for_connection_multi(
    state: &AppState,
    pool_key: &str,
    statements: &[impl AsRef<str>],
) -> Result<(), String> {
    let connection = {
        let configs = state.configs.read().await;
        crate::connection::config_for_pool_key(pool_key, &configs)
            .filter(|config| config.read_only)
            .map(|config| (config.name.clone(), config.db_type))
    };
    if let Some((name, database_type)) = connection {
        for sql in statements {
            crate::query_execution_sql::check_read_only(sql.as_ref(), &name, database_type)?;
        }
    }
    Ok(())
}

/// Check whether a connection has read-only mode enabled, returning the connection name if so.
/// This uses connection_id directly (not pool_key), so it is safe to call at command entry points
/// before any pool key is constructed.
pub async fn connection_readonly_name(state: &AppState, connection_id: &str) -> Option<String> {
    state.configs.read().await.get(connection_id).filter(|c| c.read_only).map(|c| c.name.clone())
}

async fn connection_is_mongodb(state: &AppState, connection_id: &str) -> bool {
    let configs = state.configs.read().await;
    configs.get(connection_id).is_some_and(|config| config.db_type == DatabaseType::MongoDb)
}

async fn connection_database_type(state: &AppState, connection_id: &str) -> Option<DatabaseType> {
    let configs = state.configs.read().await;
    configs.get(connection_id).map(|config| config.db_type)
}

async fn connection_mysql_query_dialect(state: &AppState, connection_id: &str) -> db::mysql::MySqlQueryDialect {
    let configs = state.configs.read().await;
    configs
        .get(connection_id)
        .map(|config| db::mysql::MySqlQueryDialect::for_connection(config.db_type, config.driver_profile.as_deref()))
        .unwrap_or_default()
}

async fn connection_mysql_catalog_dialect(
    state: &AppState,
    connection_id: &str,
) -> Option<db::mysql::MySqlCatalogDialect> {
    let configs = state.configs.read().await;
    configs
        .get(connection_id)
        .and_then(|config| db::mysql::mysql_catalog_dialect(config.db_type, config.driver_profile.as_deref()))
}

async fn connection_mysql_catalog_dialect_for_pool_key(
    state: &AppState,
    pool_key: &str,
) -> Option<db::mysql::MySqlCatalogDialect> {
    let configs = state.configs.read().await;
    crate::connection::config_for_pool_key(pool_key, &configs)
        .and_then(|config| db::mysql::mysql_catalog_dialect(config.db_type, config.driver_profile.as_deref()))
}

async fn connection_database_type_for_pool_key(state: &AppState, pool_key: &str) -> Option<DatabaseType> {
    let configs = state.configs.read().await;
    configs
        .iter()
        .filter(|(connection_id, _)| {
            pool_key.strip_prefix(connection_id.as_str()).is_some_and(|rest| rest.is_empty() || rest.starts_with(':'))
        })
        .max_by_key(|(connection_id, _)| connection_id.len())
        .map(|(_, config)| config.db_type)
}

fn schema_for_execution_context(db_type: Option<DatabaseType>, schema: Option<&str>) -> Option<&str> {
    if matches!(db_type, Some(DatabaseType::Iris)) {
        None
    } else {
        schema
    }
}

fn sql_for_execution_context(db_type: Option<DatabaseType>, sql: &str, schema: Option<&str>) -> String {
    let Some(schema) = schema.map(str::trim).filter(|schema| !schema.is_empty()) else {
        return sql.to_string();
    };
    match db_type {
        Some(DatabaseType::Iris) => qualify_iris_unqualified_dml(sql, schema).unwrap_or_else(|| sql.to_string()),
        Some(DatabaseType::Kingbase) => {
            qualify_kingbase_unqualified_relations(sql, schema).unwrap_or_else(|| sql.to_string())
        }
        _ => sql.to_string(),
    }
}

fn qualify_iris_unqualified_dml(sql: &str, schema: &str) -> Option<String> {
    let dialect = GenericDialect {};
    let mut statements = Parser::parse_sql(&dialect, sql).ok()?;
    if statements.is_empty() {
        return None;
    }

    let mut changed = false;
    for statement in &mut statements {
        if !statement_uses_schema_context(statement) {
            continue;
        }
        let cte_names = statement_cte_names(statement);
        let _ = visit_relations_mut(statement, |name| {
            if qualify_unqualified_relation_name(name, schema, &cte_names) {
                changed = true;
            }
            ControlFlow::<()>::Continue(())
        });
    }

    changed.then(|| statements.iter().map(ToString::to_string).collect::<Vec<_>>().join("; "))
}

fn qualify_kingbase_unqualified_relations(sql: &str, schema: &str) -> Option<String> {
    let dialect = PostgreSqlDialect {};
    let mut statements = Parser::parse_sql(&dialect, sql).ok()?;
    if statements.is_empty() {
        return None;
    }

    let mut changed = false;
    for statement in &mut statements {
        if !statement_uses_schema_context(statement) {
            continue;
        }
        let cte_names = statement_cte_names(statement);
        let mut qualifier =
            KingbaseRelationQualifier { schema, cte_names: &cte_names, parameterized_table_depth: 0, changed: false };
        let _ = statement.visit(&mut qualifier);
        changed |= qualifier.changed;
    }

    changed.then(|| statements.iter().map(ToString::to_string).collect::<Vec<_>>().join("; "))
}

struct KingbaseRelationQualifier<'a> {
    schema: &'a str,
    cte_names: &'a HashSet<String>,
    parameterized_table_depth: usize,
    changed: bool,
}

impl VisitorMut for KingbaseRelationQualifier<'_> {
    type Break = ();

    fn pre_visit_table_factor(&mut self, table_factor: &mut TableFactor) -> ControlFlow<Self::Break> {
        if matches!(table_factor, TableFactor::Table { args: Some(_), .. }) {
            self.parameterized_table_depth += 1;
        }
        ControlFlow::Continue(())
    }

    fn post_visit_table_factor(&mut self, table_factor: &mut TableFactor) -> ControlFlow<Self::Break> {
        if matches!(table_factor, TableFactor::Table { args: Some(_), .. }) {
            self.parameterized_table_depth = self.parameterized_table_depth.saturating_sub(1);
        }
        ControlFlow::Continue(())
    }

    fn post_visit_relation(&mut self, relation: &mut ObjectName) -> ControlFlow<Self::Break> {
        if self.parameterized_table_depth == 0
            && qualify_unqualified_relation_name(relation, self.schema, self.cte_names)
        {
            self.changed = true;
        }
        ControlFlow::Continue(())
    }
}

fn statement_uses_schema_context(statement: &Statement) -> bool {
    matches!(
        statement,
        Statement::Query(_)
            | Statement::Insert(_)
            | Statement::Update(_)
            | Statement::Delete(_)
            | Statement::Truncate(_)
    )
}

fn qualify_unqualified_relation_name(name: &mut ObjectName, schema: &str, cte_names: &HashSet<String>) -> bool {
    let [ObjectNamePart::Identifier(table)] = name.0.as_slice() else {
        return false;
    };
    if cte_names.contains(&table.value.to_ascii_uppercase()) {
        return false;
    }

    let table = table.clone();
    name.0 = vec![ObjectNamePart::Identifier(Ident::with_quote('"', schema)), ObjectNamePart::Identifier(table)];
    true
}

fn statement_cte_names(statement: &Statement) -> HashSet<String> {
    let mut names = HashSet::new();
    collect_statement_cte_names(statement, &mut names);
    names
}

fn collect_statement_cte_names(statement: &Statement, names: &mut HashSet<String>) {
    match statement {
        Statement::Query(query) => collect_query_cte_names(query, names),
        Statement::Insert(insert) => {
            if let Some(source) = &insert.source {
                collect_query_cte_names(source, names);
            }
        }
        _ => {}
    }
}

fn collect_query_cte_names(query: &sqlparser::ast::Query, names: &mut HashSet<String>) {
    if let Some(with) = &query.with {
        for cte in &with.cte_tables {
            names.insert(cte.alias.name.value.to_ascii_uppercase());
            collect_query_cte_names(&cte.query, names);
        }
    }
}

fn qualifies_unqualified_agent_relations(db_type: Option<DatabaseType>) -> bool {
    matches!(db_type, Some(DatabaseType::Iris | DatabaseType::Kingbase))
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QueryExecutionMode {
    #[default]
    Standard,
    Simple,
    PostgresReadOnlyTransaction,
}

#[derive(Clone, Debug, Default)]
pub struct QueryExecutionOptions {
    pub max_rows: Option<usize>,
    pub fetch_size: Option<usize>,
    pub page_size: Option<usize>,
    /// Doris / StarRocks catalog selected for this query tab.
    pub catalog: Option<String>,
    pub result_session_id: Option<String>,
    pub client_session_id: Option<String>,
    /// Query timeout in seconds. `None` uses the default (30s).
    /// `Some(0)` disables the timeout entirely.
    pub timeout_secs: Option<u64>,
    pub execution_id: Option<String>,
    /// When `Some(true)`, multiple statements are executed within a single transaction
    /// (BEGIN … COMMIT) instead of auto-commit mode. `None` and `Some(false)` behave
    /// identically — auto-commit for each statement.
    pub use_transaction: Option<bool>,
    /// When `true`, multi-statement execution continues after a statement error instead
    /// of stopping at the first failure. Connection-level failures always stop the batch.
    pub continue_on_error: bool,
    /// Explicit low-level execution path. `Simple` is currently used by SQL Server
    /// SHOWPLAN so the source SQL bypasses result-set probing and query rewriting.
    /// `PostgresReadOnlyTransaction` executes on an isolated client session and
    /// always rolls the transaction back after the result is collected.
    pub execution_mode: QueryExecutionMode,
}

fn validate_query_execution_mode(
    db_type: Option<DatabaseType>,
    sql: &str,
    options: &QueryExecutionOptions,
) -> Result<(), String> {
    if options.execution_mode != QueryExecutionMode::PostgresReadOnlyTransaction {
        return Ok(());
    }
    if db_type != Some(DatabaseType::Postgres) {
        return Err("PostgreSQL read-only transaction mode requires a PostgreSQL connection".to_string());
    }
    if options.client_session_id.as_deref().is_none_or(|session_id| session_id.trim().is_empty()) {
        return Err("PostgreSQL read-only transaction mode requires an isolated client session".to_string());
    }
    if crate::sql::split_sql_statements_for_database(sql, DatabaseType::Postgres).len() != 1 {
        return Err("PostgreSQL read-only transaction mode requires exactly one statement".to_string());
    }
    Ok(())
}

fn query_result_row_limit(max_rows: Option<usize>) -> usize {
    max_rows.unwrap_or(MAX_ROWS).max(1)
}

pub fn truncate_result(result: db::QueryResult) -> db::QueryResult {
    truncate_result_with_max_rows(result, None)
}

pub fn truncate_result_with_max_rows(mut result: db::QueryResult, max_rows: Option<usize>) -> db::QueryResult {
    let row_limit = query_result_row_limit(max_rows);
    if result.rows.len() > row_limit {
        result.rows.truncate(row_limit);
        result.truncated = true;
    }
    result
}

fn normalize_query_result_for_js(mut result: db::QueryResult) -> db::QueryResult {
    result.rows = result.rows.into_iter().map(|row| row.into_iter().map(db::json_value_for_js).collect()).collect();
    result
}

pub fn agent_execute_query_params(
    sql: &str,
    database: Option<&str>,
    schema: Option<&str>,
    options: QueryExecutionOptions,
) -> serde_json::Value {
    let mut params = serde_json::json!({
        "sql": sql,
        "maxRows": options.max_rows.unwrap_or(MAX_ROWS),
    });
    if let Some(database) = database.map(str::trim).filter(|database| !database.is_empty()) {
        params["database"] = serde_json::json!(database);
    }
    if let Some(schema) = schema {
        params["schema"] = serde_json::json!(schema);
    }
    if let Some(fetch_size) = options.fetch_size {
        params["fetchSize"] = serde_json::json!(fetch_size);
    }
    if let Some(timeout_secs) = options.timeout_secs {
        params["timeoutSecs"] = serde_json::json!(timeout_secs);
    }
    params
}

pub fn agent_execute_query_page_params(
    sql: &str,
    database: Option<&str>,
    schema: Option<&str>,
    options: QueryExecutionOptions,
) -> serde_json::Value {
    let mut params = serde_json::json!({
        "sql": sql,
        "pageSize": options.page_size.unwrap_or(MAX_ROWS),
        "maxRows": options.max_rows.unwrap_or(MAX_ROWS),
    });
    if let Some(database) = database.map(str::trim).filter(|database| !database.is_empty()) {
        params["database"] = serde_json::json!(database);
    }
    if let Some(schema) = schema {
        params["schema"] = serde_json::json!(schema);
    }
    if let Some(fetch_size) = options.fetch_size {
        params["fetchSize"] = serde_json::json!(fetch_size);
    }
    if let Some(timeout_secs) = options.timeout_secs {
        params["timeoutSecs"] = serde_json::json!(timeout_secs);
    }
    params
}

pub fn agent_fetch_query_page_params(session_id: &str, page_size: usize) -> serde_json::Value {
    serde_json::json!({
        "sessionId": session_id,
        "pageSize": page_size,
    })
}

pub fn agent_close_query_session_params(session_id: &str) -> serde_json::Value {
    serde_json::json!({
        "sessionId": session_id,
    })
}

pub fn is_connection_error(err: &str) -> bool {
    let lower = err.to_lowercase();
    if is_dbx_query_timeout_error(&lower) || is_agent_rpc_timeout_error(&lower) {
        return false;
    }
    lower.contains("connection")
        || lower.contains("broken pipe")
        || lower.contains("reset by peer")
        || lower.contains("timed out")
        || (lower.contains("pool") && lower.contains("timeout"))
        || lower.contains("closed")
        || lower.contains("关闭的连接")
        || lower.contains("连接已关闭")
        || lower.contains("网络通信异常")
        || lower.contains("通信异常")
        || lower.contains("communications link failure")
        || lower.contains("sqlrecoverableexception")
        || lower.contains("sqlnontransientconnectionexception")
        || lower.contains("sqltransientconnectionexception")
        || lower.contains("eof")
        || lower.contains("i/o error")
        || lower.contains("input/output error")
        || lower.contains("not connected")
        || lower.contains("end-of-file")
        || lower.contains("idle")
        || lower.contains("agent stdin not available")
        || lower.contains("agent stdout not available")
        || lower.contains("agent runtime terminated")
        || lower.contains("agent runtime is unavailable")
        || lower.contains("agent runtime unavailable")
        || lower.contains("failed to write to agent stdin")
        || lower.contains("failed to flush agent stdin")
        || lower.contains("communicating with the server")
        || is_os_connection_error(&lower)
}

fn is_dbx_query_timeout_error(lower: &str) -> bool {
    lower.starts_with("query timed out after ")
}

fn is_agent_rpc_timeout_error(lower: &str) -> bool {
    lower.starts_with("agent rpc call timed out ")
}

fn is_schema_reset_cleanup_error(lower: &str) -> bool {
    lower.contains("schema.reset cleanup failed")
}

fn is_postgres_transaction_cleanup_error(lower: &str) -> bool {
    lower.contains("postgresql read-only transaction cleanup failed")
}

fn should_discard_agent_pool_after_error(err: &str) -> bool {
    crate::db::agent_driver::agent_recovery_decision(err, RecoveryScope::UserOperation).discards_session()
}

pub fn pool_error_action(db_type: Option<DatabaseType>, err: &str) -> PoolErrorAction {
    if db_type.is_some_and(|db_type| database_capabilities::is_agent_type(&db_type)) {
        return if should_discard_agent_pool_after_error(err) {
            // Agent user operations are never replayed from an error hint because
            // the database-side outcome may be unknown.
            PoolErrorAction::Discard
        } else {
            PoolErrorAction::Keep
        };
    }
    let lower = err.to_lowercase();
    if db::sqlserver::is_driver_panic_error(err)
        || (is_dbx_query_timeout_error(&lower) && should_discard_pool_after_query_timeout(db_type))
        || is_schema_reset_cleanup_error(&lower)
        || is_postgres_transaction_cleanup_error(&lower)
    {
        return PoolErrorAction::Discard;
    }

    if is_connection_error(err) {
        PoolErrorAction::ReconnectAndRetry
    } else {
        PoolErrorAction::Keep
    }
}

fn should_continue_batch_after_error(continue_on_error: bool, action: PoolErrorAction) -> bool {
    // A broken connection cannot safely execute the remaining statements even when
    // the user explicitly enabled continue-on-error.
    continue_on_error && action == PoolErrorAction::Keep
}

fn options_for_sequential_statements(
    options: &QueryExecutionOptions,
    statement_count: usize,
    db_type: Option<DatabaseType>,
) -> QueryExecutionOptions {
    let mut statement_options = options.clone();
    if statement_count <= 1 || db_type != Some(DatabaseType::Kingbase) || statement_options.result_session_id.is_some()
    {
        return statement_options;
    }

    if let Some(page_size) = statement_options.page_size.take() {
        let page_size = page_size.max(1);
        statement_options.max_rows =
            Some(statement_options.max_rows.map_or(page_size, |max_rows| max_rows.min(page_size)));
    }
    statement_options
}

fn should_discard_pool_after_query_timeout(db_type: Option<DatabaseType>) -> bool {
    let Some(db_type) = db_type else {
        return false;
    };
    database_capabilities::is_agent_type(&db_type)
        || matches!(
            db_type,
            DatabaseType::Mysql
                | DatabaseType::Postgres
                | DatabaseType::Redshift
                | DatabaseType::Gaussdb
                | DatabaseType::Kwdb
                | DatabaseType::OpenGauss
                | DatabaseType::Questdb
                | DatabaseType::Doris
                | DatabaseType::StarRocks
                | DatabaseType::ManticoreSearch
                | DatabaseType::ClickHouse
                | DatabaseType::SqlServer
                | DatabaseType::Rqlite
                | DatabaseType::Turso
                | DatabaseType::CloudflareD1
                | DatabaseType::Elasticsearch
                | DatabaseType::Easysearch
                | DatabaseType::Qdrant
                | DatabaseType::Milvus
                | DatabaseType::Weaviate
                | DatabaseType::ChromaDb
                | DatabaseType::InfluxDb
        )
}

pub fn should_discard_pool_after_error(db_type: Option<DatabaseType>, err: &str) -> bool {
    matches!(pool_error_action(db_type, err), PoolErrorAction::Discard | PoolErrorAction::ReconnectAndRetry)
}

async fn discard_pool_after_error(state: &AppState, pool_key: &str, db_type: Option<DatabaseType>, error: &str) {
    let action = pool_error_action(db_type, error);
    if !matches!(action, PoolErrorAction::Discard | PoolErrorAction::ReconnectAndRetry) {
        return;
    }

    let replace_agent_runtime = db_type.is_some_and(|db_type| database_capabilities::is_agent_type(&db_type))
        && crate::db::agent_driver::agent_recovery_decision(error, RecoveryScope::UserOperation).replaces_runtime();
    if replace_agent_runtime {
        state.detach_pool_by_key(pool_key, true).await;
    } else {
        state.remove_pool_by_key(pool_key).await;
    }
}

async fn discard_agent_pool_after_typed_error(
    state: &AppState,
    pool_key: &str,
    client: &Arc<crate::db::agent_driver::PooledAgentClient>,
    error: &AgentCallError,
    scope: RecoveryScope,
) {
    discard_agent_pool_after_decision(state, pool_key, client, RecoveryPolicy::decide(error, scope)).await;
}

async fn discard_agent_pool_after_decision(
    state: &AppState,
    pool_key: &str,
    client: &Arc<crate::db::agent_driver::PooledAgentClient>,
    decision: RecoveryDecision,
) {
    if decision.discards_session() {
        state.detach_agent_pool_if_current(pool_key, client, decision.replaces_runtime()).await;
    }
}

fn query_pool_error_action(db_type: Option<DatabaseType>, sql: &str, err: &str) -> PoolErrorAction {
    match pool_error_action(db_type, err) {
        // A connection error does not prove that the database did not receive
        // a write. Only replay statements already accepted by the read-only
        // protection classifier; writes discard the stale pool without retry.
        PoolErrorAction::ReconnectAndRetry if is_write_sql(sql) => PoolErrorAction::Discard,
        action => action,
    }
}

fn query_execution_error_action(
    db_type: Option<DatabaseType>,
    sql: &str,
    error: &QueryExecutionError,
) -> PoolErrorAction {
    if let Some(agent_error) = error.as_agent_error() {
        return if RecoveryPolicy::decide(agent_error, RecoveryScope::UserOperation).discards_session() {
            PoolErrorAction::Discard
        } else {
            PoolErrorAction::Keep
        };
    }
    match error {
        QueryExecutionError::Canceled { .. } => PoolErrorAction::Keep,
        QueryExecutionError::DuckDb { message, .. } => query_pool_error_action(db_type, sql, message),
        QueryExecutionError::Timeout(message)
        | QueryExecutionError::Sql(message)
        | QueryExecutionError::Legacy(message) => query_pool_error_action(db_type, sql, message),
        QueryExecutionError::Agent(_) => unreachable!("Agent errors return above"),
    }
}

fn is_os_connection_error(lower: &str) -> bool {
    let os_error_codes = ["10053", "10054", "10057", "10058", "10060", "10061"];
    if let Some(pos) = lower.find("os error ") {
        let after = &lower[pos + 9..];
        let code: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
        return os_error_codes.contains(&code.as_str());
    }
    false
}

pub fn timeout_error() -> String {
    timeout_error_for(QUERY_TIMEOUT)
}

fn timeout_error_for(timeout_duration: Duration) -> String {
    let seconds = timeout_duration.as_secs().max(1);
    format!("Query timed out after {seconds} seconds")
}

pub fn canceled_error() -> String {
    QUERY_CANCELED.to_string()
}

fn canceled_query_execution_error() -> QueryExecutionError {
    QueryExecutionError::Canceled { stage: AgentErrorStage::Cancel, operation_outcome: AgentOperationOutcome::Unknown }
}

fn pre_dispatch_canceled_query_execution_error() -> QueryExecutionError {
    QueryExecutionError::Canceled {
        stage: AgentErrorStage::Request,
        operation_outcome: AgentOperationOutcome::NotStarted,
    }
}

fn postgres_transaction_statement_error(
    statement_index: usize,
    message: &str,
    sql: &str,
    is_server_error: bool,
) -> QueryExecutionError {
    let detail = query_error_with_omitted_sql_context(&format!("Statement {statement_index} failed: {message}"), sql);
    let lower = message.to_ascii_lowercase();
    if is_dbx_query_timeout_error(&lower) {
        QueryExecutionError::Timeout(detail)
    } else if message == QUERY_CANCELED {
        canceled_query_execution_error()
    } else if is_server_error {
        QueryExecutionError::Sql(detail)
    } else {
        QueryExecutionError::Legacy(detail)
    }
}

pub(crate) struct StreamProgressClock {
    started_at: tokio::time::Instant,
    last_progress_ms: AtomicU64,
}

impl StreamProgressClock {
    pub(crate) fn new() -> Self {
        Self { started_at: tokio::time::Instant::now(), last_progress_ms: AtomicU64::new(0) }
    }

    pub(crate) fn mark(&self) {
        self.last_progress_ms.store(self.started_at.elapsed().as_millis() as u64, Ordering::Relaxed);
    }

    fn elapsed_since_progress(&self) -> Duration {
        let last_progress_ms = self.last_progress_ms.load(Ordering::Relaxed);
        let elapsed_ms = self.started_at.elapsed().as_millis() as u64;
        Duration::from_millis(elapsed_ms.saturating_sub(last_progress_ms))
    }
}

pub(crate) async fn await_stream_with_progress_timeout<F, T>(
    stream_future: F,
    timeout: Option<Duration>,
    progress_clock: Arc<StreamProgressClock>,
    cancel_token: Option<&CancellationToken>,
    timeout_message: String,
) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    let Some(timeout) = timeout else {
        return match cancel_token {
            Some(token) => {
                tokio::select! {
                    biased;
                    _ = token.cancelled() => Err(canceled_error()),
                    result = stream_future => result,
                }
            }
            None => stream_future.await,
        };
    };

    tokio::pin!(stream_future);
    loop {
        // Query timeout is an inactivity budget, not a cap on total stream duration.
        let remaining = timeout.saturating_sub(progress_clock.elapsed_since_progress());
        if remaining.is_zero() {
            return Err(timeout_message.clone());
        }
        let sleep = tokio::time::sleep(remaining);
        tokio::pin!(sleep);

        match cancel_token {
            Some(token) => {
                tokio::select! {
                    biased;
                    _ = token.cancelled() => return Err(canceled_error()),
                    result = &mut stream_future => return result,
                    _ = &mut sleep => {},
                }
            }
            None => {
                tokio::select! {
                    biased;
                    result = &mut stream_future => return result,
                    _ = &mut sleep => {},
                }
            }
        }

        if progress_clock.elapsed_since_progress() >= timeout {
            return Err(timeout_message);
        }
    }
}

pub fn is_canceled(cancel_token: &Option<CancellationToken>) -> bool {
    cancel_token.as_ref().map(|token| token.is_cancelled()).unwrap_or(false)
}

pub async fn wait_for_query<F>(cancel_token: Option<CancellationToken>, future: F) -> Result<db::QueryResult, String>
where
    F: Future<Output = Result<db::QueryResult, String>>,
{
    wait_for_query_with_timeout(cancel_token, QUERY_TIMEOUT, future).await
}

pub async fn wait_for_query_with_timeout<F>(
    cancel_token: Option<CancellationToken>,
    timeout_duration: Duration,
    future: F,
) -> Result<db::QueryResult, String>
where
    F: Future<Output = Result<db::QueryResult, String>>,
{
    wait_for_result_with_timeout(cancel_token, timeout_duration, future).await
}

async fn wait_for_result_with_timeout<T, F>(
    cancel_token: Option<CancellationToken>,
    timeout_duration: Duration,
    future: F,
) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    if let Some(token) = cancel_token {
        tokio::select! {
            biased;
            _ = token.cancelled() => Err(canceled_error()),
            result = timeout(timeout_duration, future) => result.map_err(|_| timeout_error_for(timeout_duration))?,
        }
    } else {
        timeout(timeout_duration, future).await.map_err(|_| timeout_error_for(timeout_duration))?
    }
}

/// Like `wait_for_query_with_timeout` but with an optional timeout.
/// `None` means no timeout (only cancellation can stop the query).
pub async fn wait_for_query_opt<F>(
    cancel_token: Option<CancellationToken>,
    timeout_duration: Option<Duration>,
    future: F,
) -> Result<db::QueryResult, String>
where
    F: Future<Output = Result<db::QueryResult, String>>,
{
    wait_for_result_opt(cancel_token, timeout_duration, future).await
}

async fn wait_for_result_opt<T, F>(
    cancel_token: Option<CancellationToken>,
    timeout_duration: Option<Duration>,
    future: F,
) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    match timeout_duration {
        Some(d) => wait_for_result_with_timeout(cancel_token, d, future).await,
        None => match cancel_token {
            Some(token) => {
                tokio::select! {
                    biased;
                    _ = token.cancelled() => Err(canceled_error()),
                    result = future => result,
                }
            }
            None => future.await,
        },
    }
}

async fn wait_for_value_opt<T, F>(
    cancel_token: Option<CancellationToken>,
    timeout_duration: Option<Duration>,
    future: F,
) -> Result<T, String>
where
    F: Future<Output = T>,
{
    match timeout_duration {
        Some(timeout_duration) => {
            if let Some(token) = cancel_token {
                tokio::select! {
                    biased;
                    _ = token.cancelled() => Err(canceled_error()),
                    result = timeout(timeout_duration, future) => result.map_err(|_| timeout_error_for(timeout_duration)),
                }
            } else {
                timeout(timeout_duration, future).await.map_err(|_| timeout_error_for(timeout_duration))
            }
        }
        None => match cancel_token {
            Some(token) => {
                tokio::select! {
                    biased;
                    _ = token.cancelled() => Err(canceled_error()),
                    result = future => Ok(result),
                }
            }
            None => Ok(future.await),
        },
    }
}

async fn sqlserver_pool_is_current(
    state: &AppState,
    pool_key: &str,
    client: &Arc<tokio::sync::Mutex<db::sqlserver::SqlServerClient>>,
) -> bool {
    let connections = state.connections.read().await;
    matches!(connections.get(pool_key), Some(PoolKind::SqlServer(current)) if Arc::ptr_eq(current, client))
}

fn resolve_query_timeout(timeout_secs: Option<u64>) -> Option<Duration> {
    match timeout_secs {
        Some(0) => None,
        Some(n) => Some(Duration::from_secs(n)),
        None => Some(QUERY_TIMEOUT),
    }
}

fn query_pool_database<'a>(database: &'a str, catalog: Option<&str>) -> Option<&'a str> {
    if database.is_empty() || catalog.is_some() {
        None
    } else {
        Some(database)
    }
}

fn postgres_prefers_text_protocol(db_type: Option<DatabaseType>) -> bool {
    db_type == Some(DatabaseType::Redshift)
}

pub async fn operation_budget_for_pool_key(
    state: &AppState,
    pool_key: &str,
    query_timeout: Option<Duration>,
) -> DbOperationBudget {
    let mut budget = configured_operation_budget_for_pool_key(state, pool_key).await;
    budget.query_timeout = query_timeout;
    budget
}

async fn configured_operation_budget_for_pool_key(state: &AppState, pool_key: &str) -> DbOperationBudget {
    let configs = state.configs.read().await;
    crate::connection::config_for_pool_key(pool_key, &configs)
        .map(DbOperationBudget::from_connection_config)
        .unwrap_or_else(DbOperationBudget::with_defaults)
}

fn oceanbase_mysql_session_timeout_sql(config: Option<&ConnectionConfig>, timeout_secs: Option<u64>) -> Option<String> {
    let config = config?;
    let timeout_secs = timeout_secs.unwrap_or(config.query_timeout_secs);
    crate::connection::oceanbase_mysql_query_timeout_sql(config, timeout_secs)
}

async fn apply_oceanbase_mysql_session_timeout(
    state: &AppState,
    pool_key: &str,
    conn: &mut mysql_async::Conn,
    timeout_secs: Option<u64>,
) -> Result<(), String> {
    let sql = {
        let configs = state.configs.read().await;
        oceanbase_mysql_session_timeout_sql(crate::connection::config_for_pool_key(pool_key, &configs), timeout_secs)
    };
    if let Some(sql) = sql {
        // OceanBase enforces query timeouts through a session variable; set it
        // on the checked-out connection in case the pooled session was reset.
        conn.query_drop(&sql).await.map_err(|err| format!("Failed to apply OceanBase query timeout: {err}"))?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn do_execute_typed(
    state: &AppState,
    pool_key: &str,
    mysql_dialect: db::mysql::MySqlQueryDialect,
    database: Option<&str>,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
) -> Result<db::QueryResult, QueryExecutionError> {
    crate::sql_diagnostics::debug_sql("do_execute", sql);
    if let Some(execution_id) = options.execution_id.as_deref() {
        state.running_queries.set_pool_key(execution_id, pool_key.to_string());
    }
    state.touch_pool_activity(pool_key).await;
    let _activity_touch = state.pool_activity_touch(pool_key);

    let query_timeout = resolve_query_timeout(options.timeout_secs);
    let read_only_connection = {
        let configs = state.configs.read().await;
        let config = crate::connection::config_for_pool_key(pool_key, &configs);
        config.filter(|config| config.read_only).map(|config| (config.name.clone(), config.db_type))
    };
    let operation_budget = operation_budget_for_pool_key(state, pool_key, query_timeout).await;
    if let Some((name, database_type)) = read_only_connection {
        crate::query_execution_sql::check_read_only(sql, &name, database_type)?;
    }
    let pool_db_type = connection_database_type_for_pool_key(state, pool_key).await;
    let mysql_catalog_dialect = connection_mysql_catalog_dialect_for_pool_key(state, pool_key).await;
    let connections = state.connections.read().await;
    let pool = connections.get(pool_key).ok_or("Connection not found")?;

    let mut typed_agent_error = None;
    #[cfg(feature = "duckdb-sidecar")]
    let mut typed_duckdb_error = None;
    let result: Result<db::QueryResult, String> = match pool {
        #[cfg(feature = "duckdb-sidecar")]
        PoolKind::DuckDbWorker(client) => {
            let client = client.clone();
            if let Some(ref execution_id) = options.execution_id {
                let cancel_client = client.clone();
                state.running_queries.register_interrupt(execution_id, move || {
                    let cancel_client = cancel_client.clone();
                    tokio::spawn(async move {
                        if let Err(error) = cancel_client.cancel().await {
                            log::warn!("Failed to cancel DuckDB worker query: {error}");
                        }
                    });
                });
            }
            let sql = sql.to_string();
            let database = database.map(str::to_string);
            let max_rows = options.max_rows;
            drop(connections);
            match client.execute_typed(database, sql, max_rows, cancel_token, query_timeout).await {
                Ok(result) => Ok(result),
                Err(error) => {
                    let is_control_error = error.message == QUERY_CANCELED
                        || is_dbx_query_timeout_error(&error.message.to_ascii_lowercase());
                    if !is_control_error {
                        typed_duckdb_error = Some(error.clone());
                    }
                    Err(error.message)
                }
            }
        }
        #[cfg(not(feature = "duckdb-sidecar"))]
        PoolKind::DuckDbWorker(_) => {
            return Err("DuckDB worker support is not compiled in this build".into());
        }
        PoolKind::Mysql(p, mode) => {
            let p = p.clone();
            let bare = *mode == crate::connection::MysqlMode::Bare;
            let max_rows = options.max_rows;
            drop(connections);
            let mut conn = match db::mysql::get_conn_with_health_check_with_cancel(
                &p,
                operation_budget.checkout_timeout,
                operation_budget.cleanup_timeout,
                cancel_token.as_ref(),
            )
            .await
            {
                Ok(conn) => conn,
                Err(err) if err == QUERY_CANCELED => {
                    state.remove_pool_by_key(pool_key).await;
                    return Err(err.into());
                }
                Err(err) => return Err(err.into()),
            };
            let connection_id = conn.id();
            if let Some(ref execution_id) = options.execution_id {
                let kill_opts = conn.opts().clone();
                state.running_queries.register_interrupt(execution_id, move || {
                    let kill_opts = kill_opts.clone();
                    tokio::spawn(async move {
                        if let Err(error) = db::mysql::kill_query_with_opts(kill_opts, connection_id).await {
                            log::warn!("Failed to cancel MySQL query {connection_id}: {error}");
                        }
                    });
                });
            }
            apply_oceanbase_mysql_session_timeout(state, pool_key, &mut conn, options.timeout_secs).await?;
            wait_for_result_opt(
                cancel_token.clone(),
                query_timeout,
                db::mysql::apply_catalog_database_context(
                    &mut conn,
                    mysql_catalog_dialect,
                    options.catalog.as_deref(),
                    database.unwrap_or_default(),
                ),
            )
            .await?;
            wait_for_query_opt(
                cancel_token,
                query_timeout,
                db::mysql::execute_query_on_conn_with_max_rows(&mut conn, sql, bare, max_rows, mysql_dialect),
            )
            .await
        }
        PoolKind::Postgres(p) => {
            let p = p.clone();
            let schema = schema.map(|s| s.to_string());
            let max_rows = options.max_rows;
            let prefer_text_protocol = postgres_prefers_text_protocol(pool_db_type);
            let execution_mode = options.execution_mode;
            let cancel_context = state.get_postgres_cancel_context(pool_key).await;
            drop(connections);
            if execution_mode == QueryExecutionMode::PostgresReadOnlyTransaction {
                db::postgres::execute_query_in_read_only_transaction_with_rollback(
                    &p,
                    schema.as_deref(),
                    sql,
                    max_rows,
                    cancel_token,
                    operation_budget.clone(),
                    cancel_context,
                )
                .await
            } else if let Some(schema) = schema {
                db::postgres::execute_query_with_schema_and_max_rows_and_cancel(
                    &p,
                    &schema,
                    sql,
                    max_rows,
                    cancel_token,
                    operation_budget.clone(),
                    cancel_context,
                    prefer_text_protocol,
                )
                .await
            } else {
                db::postgres::execute_query_with_max_rows_and_cancel(
                    &p,
                    sql,
                    max_rows,
                    cancel_token,
                    operation_budget.clone(),
                    cancel_context,
                    prefer_text_protocol,
                )
                .await
            }
        }
        PoolKind::Sqlite(p) => {
            let p = p.clone();
            let max_rows = options.max_rows;
            drop(connections);
            wait_for_query_opt(cancel_token, query_timeout, db::sqlite::execute_query_with_max_rows(&p, sql, max_rows))
                .await
        }
        PoolKind::Rqlite(client) => {
            let client = client.clone();
            let max_rows = options.max_rows;
            drop(connections);
            wait_for_query_opt(
                cancel_token,
                query_timeout,
                db::rqlite_driver::execute_query_with_max_rows(&client, sql, max_rows),
            )
            .await
        }
        PoolKind::Turso(client) => {
            let client = client.clone();
            let max_rows = options.max_rows;
            drop(connections);
            wait_for_query_opt(
                cancel_token,
                query_timeout,
                db::turso_driver::execute_query_with_max_rows(&client, sql, max_rows),
            )
            .await
        }
        PoolKind::CloudflareD1(client) => {
            let client = client.clone();
            let max_rows = options.max_rows;
            drop(connections);
            wait_for_query_opt(
                cancel_token,
                query_timeout,
                db::cloudflare_d1_driver::execute_query_with_max_rows(&client, sql, max_rows),
            )
            .await
        }
        PoolKind::ClickHouse(client) => {
            let client = client.clone();
            let database = pool_key.split(':').nth(1).unwrap_or("default").to_string();
            let max_rows = options.max_rows;
            drop(connections);
            let result = wait_for_query_opt(
                cancel_token,
                query_timeout,
                db::clickhouse_driver::execute_query_with_max_rows(&client, &database, sql, max_rows),
            )
            .await
            .map(|result| truncate_result_with_max_rows(result, max_rows));
            if matches!(result.as_ref(), Err(err) if should_discard_pool_after_error(pool_db_type, err)) {
                state.remove_pool_by_key(pool_key).await;
            }
            result
        }
        PoolKind::SqlServer(client) => {
            let client = client.clone();
            let max_rows = options.max_rows;
            let execution_mode = options.execution_mode;
            drop(connections);
            let mut client = match cancel_token.as_ref() {
                Some(token) => tokio::select! {
                    biased;
                    _ = token.cancelled() => return Err(canceled_error().into()),
                    guard = client.lock() => guard,
                },
                None => client.lock().await,
            };
            let execution = async {
                if execution_mode == QueryExecutionMode::Simple {
                    let mut results =
                        db::sqlserver::execute_simple_batch_with_max_rows(&mut client, sql, max_rows).await?;
                    Ok(results.remove(0))
                } else {
                    db::sqlserver::execute_query_with_max_rows(&mut client, sql, max_rows).await
                }
            };
            let result = wait_for_query_opt(cancel_token, query_timeout, execution)
                .await
                .map(|result| truncate_result_with_max_rows(result, max_rows));
            drop(client);
            if matches!(result.as_ref(), Err(err) if should_discard_pool_after_error(pool_db_type, err)) {
                state.remove_pool_by_key(pool_key).await;
            }
            result
        }
        PoolKind::Elasticsearch(client) => {
            let client = client.clone();
            let sql = sql.to_string();
            let max_rows = options.max_rows;
            drop(connections);
            let result = wait_for_query_opt(
                cancel_token,
                query_timeout,
                db::elasticsearch_driver::execute_rest_query(&client, &sql),
            )
            .await
            .map(|result| truncate_result_with_max_rows(result, max_rows));
            if matches!(result.as_ref(), Err(err) if should_discard_pool_after_error(pool_db_type, err)) {
                state.remove_pool_by_key(pool_key).await;
            }
            result
        }
        PoolKind::Easysearch(client) => {
            let client = client.clone();
            let sql = sql.to_string();
            let max_rows = options.max_rows;
            drop(connections);
            let result = wait_for_query_opt(
                cancel_token,
                query_timeout,
                db::easysearch_driver::execute_rest_query(&client, &sql),
            )
            .await
            .map(|result| truncate_result_with_max_rows(result, max_rows));
            if matches!(result.as_ref(), Err(err) if should_discard_pool_after_error(pool_db_type, err)) {
                state.remove_pool_by_key(pool_key).await;
            }
            result
        }
        PoolKind::VectorDb(client) => {
            let client = client.clone();
            let sql = sql.to_string();
            let max_rows = options.max_rows;
            drop(connections);
            let result =
                wait_for_query_opt(cancel_token, query_timeout, db::vector_driver::execute_rest_query(&client, &sql))
                    .await
                    .map(|result| truncate_result_with_max_rows(result, max_rows));
            if matches!(result.as_ref(), Err(err) if should_discard_pool_after_error(pool_db_type, err)) {
                state.remove_pool_by_key(pool_key).await;
            }
            result
        }
        PoolKind::Redis(_) => Err("Use Redis-specific commands".to_string()),
        PoolKind::MongoDb(_) => Err(MONGO_SHELL_COMMAND_HINT.to_string()),
        PoolKind::MessageQueue => Err("Use Message Queue-specific commands".to_string()),
        #[cfg(feature = "mq-admin")]
        PoolKind::Mqtt(_) => Err("Use MQTT-specific commands".to_string()),
        PoolKind::Nacos => Err("Use Nacos-specific commands".to_string()),
        PoolKind::InfluxDb(client) => {
            let client = client.clone();
            let database = pool_key.split(':').nth(1).unwrap_or("default").to_string();
            let max_rows = options.max_rows;
            drop(connections);
            let result = wait_for_query_opt(
                cancel_token,
                query_timeout,
                db::influxdb_driver::execute_query(&client, &database, sql),
            )
            .await
            .map(|result| truncate_result_with_max_rows(result, max_rows));
            if matches!(result.as_ref(), Err(err) if should_discard_pool_after_error(pool_db_type, err)) {
                state.remove_pool_by_key(pool_key).await;
            }
            result
        }
        PoolKind::Agent(client) => {
            let client = client.clone();
            let source_client = client.clone();
            let sql = sql_for_execution_context(pool_db_type, sql, schema);
            let database = database.map(|s| s.to_string());
            let schema = schema_for_execution_context(pool_db_type, schema).map(|s| s.to_string());
            let max_rows = options.max_rows;
            let rpc_timeout = query_timeout;
            drop(connections);
            if is_canceled(&cancel_token) {
                return Err(canceled_error().into());
            }
            let cancel_for_agent = cancel_token.clone();
            let result = async move {
                let mut client = match cancel_for_agent.as_ref() {
                    Some(token) => {
                        tokio::select! {
                            biased;
                            _ = token.cancelled() => return Err(AgentCallError::Canceled {
                                stage: AgentErrorStage::Cancel,
                                operation_outcome: AgentOperationOutcome::Unknown,
                            }),
                            guard = client.lock() => guard,
                        }
                    }
                    None => client.lock().await,
                };
                if let Some(session_id) = options.result_session_id.as_deref() {
                    let params = agent_fetch_query_page_params(session_id, options.page_size.unwrap_or(MAX_ROWS));
                    client
                        .fetch_query_page_typed_with_timeout_and_cancel(params, rpc_timeout, cancel_for_agent.clone())
                        .await
                } else if options.page_size.is_some() {
                    let params = agent_execute_query_page_params(&sql, database.as_deref(), schema.as_deref(), options);
                    client
                        .execute_query_page_typed_with_timeout_and_cancel(params, rpc_timeout, cancel_for_agent.clone())
                        .await
                } else {
                    let params = agent_execute_query_params(&sql, database.as_deref(), schema.as_deref(), options);
                    client
                        .execute_query_typed_with_timeout_and_cancel(params, rpc_timeout, cancel_for_agent.clone())
                        .await
                }
            }
            .await
            .map(|result| truncate_result_with_max_rows(result, max_rows));
            if let Err(err) = result.as_ref() {
                discard_agent_pool_after_typed_error(
                    state,
                    pool_key,
                    &source_client,
                    err,
                    RecoveryScope::UserOperation,
                )
                .await;
            }
            typed_agent_error = result.as_ref().err().cloned();
            result.map_err(AgentCallError::into_legacy_string)
        }
        PoolKind::ExternalDriver { config, session, .. } => {
            let config = config.clone();
            let session = session.clone();
            let sql = sql.to_string();
            let schema = schema.map(str::to_string);
            let database = database.unwrap_or_else(|| config.effective_database().unwrap_or("")).to_string();
            let max_rows = options.max_rows;
            let plugin_timeout = query_timeout;
            drop(connections);
            wait_for_query_opt(cancel_token, query_timeout, async move {
                if let Some(session_id) = options.result_session_id.as_deref() {
                    let params = external_driver_fetch_query_page_params(
                        config.as_ref(),
                        session_id,
                        options.page_size.unwrap_or(MAX_ROWS),
                    );
                    session.invoke_with_timeout::<db::QueryResult>("fetchQueryPage", params, plugin_timeout).await
                } else if options.page_size.is_some() {
                    let params =
                        external_driver_query_params(config.as_ref(), &sql, &database, schema.as_deref(), &options);
                    invoke_external_driver_query_page(session.as_ref(), params, plugin_timeout).await
                } else {
                    let params =
                        external_driver_query_params(config.as_ref(), &sql, &database, schema.as_deref(), &options);
                    session.invoke_with_timeout::<db::QueryResult>("executeQuery", params, plugin_timeout).await
                }
            })
            .await
            .map(|result| truncate_result_with_max_rows(result, max_rows))
        }
        PoolKind::HBase(_) => Err("SQL execution is not supported for HBase connections".to_string()),
    };
    result
        .map(normalize_query_result_for_js)
        .map_err(|error| {
            #[cfg(feature = "duckdb-sidecar")]
            if let Some(duckdb_error) = typed_duckdb_error {
                return QueryExecutionError::DuckDb { code: duckdb_error.code, message: duckdb_error.message };
            }
            typed_agent_error.map_or_else(|| QueryExecutionError::Legacy(error), QueryExecutionError::Agent)
        })
        .map_err(|error| classify_query_error(pool_db_type, error))
}

fn classify_query_error(db_type: Option<DatabaseType>, error: QueryExecutionError) -> QueryExecutionError {
    match error {
        QueryExecutionError::Legacy(message) if message == QUERY_CANCELED => canceled_query_execution_error(),
        QueryExecutionError::Legacy(message) if is_dbx_query_timeout_error(&message.to_ascii_lowercase()) => {
            QueryExecutionError::Timeout(message)
        }
        QueryExecutionError::Legacy(message) if is_native_sql_server_error(db_type, &message) => {
            QueryExecutionError::Sql(message)
        }
        other => other,
    }
}

fn is_native_sql_server_error(db_type: Option<DatabaseType>, message: &str) -> bool {
    let message = message.trim_start();
    match db_type {
        Some(DatabaseType::Postgres) => message.starts_with("ERROR:"),
        Some(DatabaseType::Mysql) => message.starts_with("Server error: `ERROR "),
        _ => false,
    }
}

pub async fn do_execute(
    state: &AppState,
    pool_key: &str,
    mysql_dialect: db::mysql::MySqlQueryDialect,
    database: Option<&str>,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
) -> Result<db::QueryResult, String> {
    do_execute_typed(state, pool_key, mysql_dialect, database, sql, schema, cancel_token, options)
        .await
        .map_err(QueryExecutionError::into_legacy_string)
}

async fn invoke_external_driver_query_page(
    session: &crate::plugins::PluginDriverSession,
    params: serde_json::Value,
    plugin_timeout: Option<Duration>,
) -> Result<db::QueryResult, String> {
    match session.invoke_with_timeout::<db::QueryResult>("executeQueryPage", params.clone(), plugin_timeout).await {
        Ok(result) => Ok(result),
        Err(error) if is_external_driver_method_unsupported(&error, "executeQueryPage") => {
            // Plugins installed by older DBX releases predate cursor pagination. Keep
            // basic queries usable until the user updates the plugin, without retrying
            // actual JDBC/SQL failures that may have side effects.
            log::warn!("[query][external-driver] executeQueryPage unsupported; falling back to executeQuery");
            session.invoke_with_timeout::<db::QueryResult>("executeQuery", params, plugin_timeout).await
        }
        Err(error) => Err(error),
    }
}

fn is_external_driver_method_unsupported(error: &str, method: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    let method = method.to_ascii_lowercase();
    normalized.contains(&method)
        && (normalized.contains("unsupported jdbc plugin method")
            || normalized.contains("unknown method")
            || normalized.contains("method not found"))
}

fn external_driver_query_params(
    config: &crate::models::connection::ConnectionConfig,
    sql: &str,
    database: &str,
    schema: Option<&str>,
    options: &QueryExecutionOptions,
) -> serde_json::Value {
    let mut params = serde_json::json!({
        "connection": config,
        "sql": sql,
        "database": database,
        "schema": schema,
        "maxRows": options.max_rows.unwrap_or(MAX_ROWS),
    });
    if let Some(fetch_size) = options.fetch_size {
        params["fetchSize"] = serde_json::json!(fetch_size);
    }
    if let Some(timeout_secs) = options.timeout_secs {
        params["timeoutSecs"] = serde_json::json!(timeout_secs);
    }
    if let Some(page_size) = options.page_size {
        params["pageSize"] = serde_json::json!(page_size);
    }
    params
}

fn external_driver_fetch_query_page_params(
    config: &crate::models::connection::ConnectionConfig,
    session_id: &str,
    page_size: usize,
) -> serde_json::Value {
    serde_json::json!({
        "connection": config,
        "sessionId": session_id,
        "pageSize": page_size,
    })
}

pub async fn execute_sql_statement(
    state: &AppState,
    connection_id: &str,
    database: &str,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
) -> Result<db::QueryResult, String> {
    execute_sql_statement_with_options(
        state,
        connection_id,
        database,
        sql,
        schema,
        cancel_token,
        QueryExecutionOptions::default(),
    )
    .await
}

pub async fn execute_sql_statement_with_options_typed(
    state: &AppState,
    connection_id: &str,
    database: &str,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
) -> Result<db::QueryResult, QueryExecutionError> {
    // MongoDB connections use shell-style commands dispatched through the
    // frontend parser. Queries that fall through to the generic SQL executor
    // (e.g. typos) must be rejected before any pool/key creation so that
    // session-scoped pools do not leak MongoDB Clients and SSH tunnels.
    if connection_is_mongodb(state, connection_id).await {
        return Err(MONGO_SHELL_COMMAND_HINT.into());
    }

    let db_type = connection_database_type(state, connection_id).await;
    validate_query_execution_mode(db_type, sql, &options)?;
    let has_executable_sql = db_type.map_or_else(
        || crate::sql::has_executable_sql(sql),
        |db_type| crate::sql::has_executable_sql_for_database(sql, db_type),
    );
    if !has_executable_sql {
        return Ok(empty_query_result(0));
    }

    if let Some(target_database) = postgres_drop_database_target(db_type, sql) {
        return execute_postgres_drop_database(state, connection_id, &target_database, sql, cancel_token, options)
            .await
            .map_err(Into::into);
    }

    // When a query tab has a client session, keep even database-less execution
    // on that tab-scoped pool so connection-level state (for example MySQL @vars)
    // survives across runs.
    let pool_database = query_pool_database(database, options.catalog.as_deref());
    let pool_key = state
        .get_or_create_pool_for_session(connection_id, pool_database, options.client_session_id.as_deref())
        .await
        .map_err(|e| query_error_with_omitted_sql_context(&e, sql))?;

    if is_canceled(&cancel_token) {
        return Err(pre_dispatch_canceled_query_execution_error());
    }

    let mysql_dialect = connection_mysql_query_dialect(state, connection_id).await;
    let result = do_execute_typed(
        state,
        &pool_key,
        mysql_dialect,
        Some(database),
        sql,
        schema,
        cancel_token.clone(),
        options.clone(),
    )
    .await;

    let with_sql_context = |result: Result<db::QueryResult, QueryExecutionError>| {
        result.map_err(|error| error.with_omitted_sql_context(sql))
    };

    let action = result.as_ref().err().map(|error| query_execution_error_action(db_type, sql, error));
    match action {
        Some(PoolErrorAction::ReconnectAndRetry) if !is_canceled(&cancel_token) => {
            let pool_database = query_pool_database(database, options.catalog.as_deref());
            let new_key = state
                .reconnect_pool_for_session(connection_id, pool_database, options.client_session_id.as_deref())
                .await
                .map_err(|e| query_error_with_omitted_sql_context(&e, sql))?;
            with_sql_context(
                do_execute_typed(state, &new_key, mysql_dialect, Some(database), sql, schema, cancel_token, options)
                    .await,
            )
        }
        Some(PoolErrorAction::Discard) => {
            // Agent execution owns structured quarantine/runtime replacement before
            // returning. Native drivers retain the existing caller-side cleanup.
            if !db_type.is_some_and(|db_type| database_capabilities::is_agent_type(&db_type)) {
                state.remove_pool_by_key(&pool_key).await;
            }
            with_sql_context(result)
        }
        _ => with_sql_context(result),
    }
}

pub async fn execute_sql_statement_with_options(
    state: &AppState,
    connection_id: &str,
    database: &str,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
) -> Result<db::QueryResult, String> {
    execute_sql_statement_with_options_typed(state, connection_id, database, sql, schema, cancel_token, options)
        .await
        .map_err(QueryExecutionError::into_legacy_string)
}

async fn execute_postgres_drop_database(
    state: &AppState,
    connection_id: &str,
    target_database: &str,
    sql: &str,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
) -> Result<db::QueryResult, String> {
    state.close_database_pool(connection_id, Some(target_database)).await?;

    let admin_database = postgres_drop_database_admin_database(target_database);
    let pool_key = state
        .get_or_create_pool_for_session(connection_id, Some(admin_database), options.client_session_id.as_deref())
        .await
        .map_err(|e| query_error_with_omitted_sql_context(&e, sql))?;
    if let Some(execution_id) = options.execution_id.as_deref() {
        state.running_queries.set_pool_key(execution_id, pool_key.clone());
    }
    state.touch_pool_activity(&pool_key).await;
    let _activity_touch = state.pool_activity_touch(pool_key.as_str());

    if is_canceled(&cancel_token) {
        return Err(canceled_error());
    }

    check_read_only_for_connection(state, &pool_key, sql).await?;
    let pool = {
        let connections = state.connections.read().await;
        match connections.get(&pool_key) {
            Some(PoolKind::Postgres(pool)) => pool.clone(),
            Some(_) => return Err("DROP DATABASE reconnect did not create a PostgreSQL connection".to_string()),
            None => return Err("Connection not found".to_string()),
        }
    };

    let query_timeout = resolve_query_timeout(options.timeout_secs);
    let max_rows = options.max_rows;
    wait_for_query_opt(cancel_token, query_timeout, async {
        db::postgres::terminate_current_user_database_backends(&pool, target_database).await?;
        db::postgres::execute_query_with_max_rows(&pool, sql, max_rows).await
    })
    .await
}

fn postgres_drop_database_target(db_type: Option<DatabaseType>, sql: &str) -> Option<String> {
    if db_type != Some(DatabaseType::Postgres) {
        return None;
    }
    parse_drop_database_target(sql)
}

fn postgres_drop_database_admin_database(target_database: &str) -> &'static str {
    if target_database.eq_ignore_ascii_case("postgres") {
        "template1"
    } else {
        "postgres"
    }
}

fn parse_drop_database_target(sql: &str) -> Option<String> {
    let dialect = PostgreSqlDialect {};
    let statements = Parser::parse_sql(&dialect, sql).ok()?;
    let [Statement::Drop { object_type, names, .. }] = statements.as_slice() else {
        return None;
    };
    if *object_type != ObjectType::Database || names.len() != 1 {
        return None;
    }

    let parts = &names[0].0;
    if parts.len() != 1 {
        return None;
    }
    parts[0].as_ident().map(|ident| ident.value.clone())
}

pub async fn close_query_session(
    state: &AppState,
    connection_id: &str,
    database: &str,
    session_id: &str,
    client_session_id: Option<&str>,
    catalog: Option<&str>,
) -> Result<bool, String> {
    let pool_database = query_pool_database(database, catalog);
    let pool_key = state.get_or_create_pool_for_session(connection_id, pool_database, client_session_id).await?;

    let connections = state.connections.read().await;
    let pool = connections.get(&pool_key).ok_or("Connection not found")?;
    match pool {
        PoolKind::Agent(client) => {
            let client = client.clone();
            drop(connections);
            let mut client = client.lock().await;
            client.close_query_session(session_id).await
        }
        PoolKind::ExternalDriver { config, session, .. } => {
            let config = config.clone();
            let session = session.clone();
            drop(connections);
            let params = external_driver_fetch_query_page_params(config.as_ref(), session_id, 1);
            session
                .invoke::<serde_json::Value>("closeQuerySession", params)
                .await
                .map(|value| value.get("ok").and_then(|ok| ok.as_bool()).unwrap_or(false))
        }
        _ => Ok(false),
    }
}

pub async fn execute_multi_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
) -> Result<Vec<db::QueryResult>, String> {
    execute_multi_core_with_options(
        state,
        connection_id,
        database,
        sql,
        schema,
        cancel_token,
        QueryExecutionOptions::default(),
    )
    .await
}

pub async fn execute_multi_core_with_options(
    state: &AppState,
    connection_id: &str,
    database: &str,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
) -> Result<Vec<db::QueryResult>, String> {
    execute_multi_core_with_options_for_client(state, connection_id, database, sql, schema, cancel_token, options)
        .await
        .map(|results| results.into_iter().map(ExecuteMultiResult::into_query_result).collect())
}

/// Execute a SQL batch and retain client-facing metadata for synthesized errors.
pub async fn execute_multi_core_with_options_for_client(
    state: &AppState,
    connection_id: &str,
    database: &str,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
) -> Result<Vec<ExecuteMultiResult>, String> {
    execute_multi_core_with_options_for_client_typed(state, connection_id, database, sql, schema, cancel_token, options)
        .await
        .map_err(QueryExecutionError::into_legacy_string)
}

/// Execute a SQL batch for a client while preserving typed failures.
pub async fn execute_multi_core_with_options_for_client_typed(
    state: &AppState,
    connection_id: &str,
    database: &str,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
) -> Result<Vec<ExecuteMultiResult>, QueryExecutionError> {
    execute_multi_core_with_options_for_client_and_progress_typed(
        state,
        connection_id,
        database,
        sql,
        schema,
        cancel_token,
        options,
        None,
    )
    .await
}

/// Executes a SQL batch and reports each completed statement to the optional callback.
pub async fn execute_multi_core_with_options_for_client_and_progress(
    state: &AppState,
    connection_id: &str,
    database: &str,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
    progress: Option<ExecuteMultiProgressCallback>,
) -> Result<Vec<ExecuteMultiResult>, String> {
    execute_multi_core_with_options_for_client_and_progress_typed(
        state,
        connection_id,
        database,
        sql,
        schema,
        cancel_token,
        options,
        progress,
    )
    .await
    .map_err(QueryExecutionError::into_legacy_string)
}

/// Executes a SQL batch without erasing structured query errors at transport boundaries.
pub async fn execute_multi_core_with_options_for_client_and_progress_typed(
    state: &AppState,
    connection_id: &str,
    database: &str,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
    progress: Option<ExecuteMultiProgressCallback>,
) -> Result<Vec<ExecuteMultiResult>, QueryExecutionError> {
    let pool_database = query_pool_database(database, options.catalog.as_deref());
    // Reject MongoDB queries that fall through to the generic executor.
    if connection_is_mongodb(state, connection_id).await {
        return Err(MONGO_SHELL_COMMAND_HINT.into());
    }

    let db_type = connection_database_type(state, connection_id).await;
    validate_query_execution_mode(db_type, sql, &options)?;
    if options.execution_mode == QueryExecutionMode::PostgresReadOnlyTransaction {
        let result =
            execute_sql_statement_with_options(state, connection_id, database, sql, schema, cancel_token, options)
                .await?;
        return Ok(vec![result.into()]);
    }

    let pool_key = state
        .get_or_create_pool_for_session(connection_id, pool_database, options.client_session_id.as_deref())
        .await
        .map_err(|e| query_error_with_omitted_sql_context(&e, sql))?;
    if let Some(execution_id) = options.execution_id.as_deref() {
        state.running_queries.set_pool_key(execution_id, pool_key.clone());
    }
    state.touch_pool_activity(&pool_key).await;
    let _activity_touch = state.pool_activity_touch(pool_key.as_str());

    let is_sqlserver = {
        let connections = state.connections.read().await;
        matches!(connections.get(&pool_key), Some(PoolKind::SqlServer(_)))
    };

    if is_sqlserver {
        return execute_multi_sqlserver(state, &pool_key, sql, cancel_token, options).await.map_err(Into::into);
    }

    let is_http_sqlite = {
        let configs = state.configs.read().await;
        configs
            .get(connection_id)
            .is_some_and(|c| matches!(c.db_type, DatabaseType::Turso | DatabaseType::CloudflareD1))
    };

    // HTTP SQLite providers send all statements in one request so the provider
    // can preserve batch ordering and atomicity.
    if is_http_sqlite {
        return single_statement_multi_result(
            execute_sql_statement_with_options_typed(
                state,
                connection_id,
                database,
                sql,
                schema,
                cancel_token,
                options,
            )
            .await,
        );
    }

    let statements = db_type.map_or_else(
        || split_sql_statements(sql),
        |db_type| crate::sql::split_sql_statements_for_database(sql, db_type),
    );
    if statements.is_empty() {
        return Ok(vec![empty_query_result(0).into()]);
    }

    // When use_transaction is explicitly true and we have multiple statements,
    // route through the transaction wrapper instead of the sequential auto-commit loop.
    if options.use_transaction == Some(true) && statements.len() > 1 {
        let result = execute_statements_in_transaction_typed(
            state,
            connection_id,
            database,
            &statements,
            schema,
            options.catalog.as_deref(),
        )
        .await?;
        return Ok(vec![result.into()]);
    }

    let mysql_pool = {
        let connections = state.connections.read().await;
        match connections.get(&pool_key) {
            Some(PoolKind::Mysql(pool, mode)) => Some((pool.clone(), *mode)),
            _ => None,
        }
    };

    if statements.len() <= 1 {
        let single_sql = statements.into_iter().next().unwrap_or_default();
        return single_statement_multi_result(
            execute_sql_statement_with_options_typed(
                state,
                connection_id,
                database,
                &single_sql,
                schema,
                cancel_token,
                options,
            )
            .await,
        );
    }

    if let Some((pool, mode)) = mysql_pool {
        // Read-only check for MySQL batch path
        check_read_only_for_connection_multi(state, &pool_key, &statements).await?;
        let mysql_dialect = connection_mysql_query_dialect(state, connection_id).await;
        let mysql_catalog_dialect = connection_mysql_catalog_dialect(state, connection_id).await;
        return execute_multi_mysql(
            state,
            &pool_key,
            db_type,
            &pool,
            mode,
            mysql_dialect,
            mysql_catalog_dialect,
            database,
            &statements,
            cancel_token,
            options,
            progress.as_ref(),
        )
        .await
        .map_err(Into::into);
    }

    // Kingbase Go keeps one physical connection per Agent session, so an open
    // result cursor prevents the next statement from acquiring that connection.
    // Multi-result execution therefore reads a bounded first page for each
    // Kingbase statement without retaining cursors.
    let statement_options = options_for_sequential_statements(&options, statements.len(), db_type);
    let mut results = Vec::with_capacity(statements.len());
    for (statement_index, stmt) in statements.iter().enumerate() {
        if is_canceled(&cancel_token) {
            let error = canceled_query_execution_error();
            results.push(ExecuteMultiResult::execution_error_with_backend(
                error_query_result(error.clone().into_legacy_string()),
                Some(statement_index),
                error.into_backend_error(),
            ));
            break;
        }
        match execute_sql_statement_with_options_typed(
            state,
            connection_id,
            database,
            stmt,
            schema,
            cancel_token.clone(),
            statement_options.clone(),
        )
        .await
        {
            Ok(r) => {
                report_execute_multi_progress(progress.as_ref(), statement_index, statements.len(), &r, true, None);
                results.push(ExecuteMultiResult::success_with_index(r, statement_index));
            }
            Err(error) => {
                let action = query_execution_error_action(db_type, stmt, &error);
                let result = error_query_result(error.clone().into_legacy_string());
                let backend_error = error.into_backend_error();
                report_execute_multi_progress(
                    progress.as_ref(),
                    statement_index,
                    statements.len(),
                    &result,
                    false,
                    Some(backend_error.clone()),
                );
                results.push(ExecuteMultiResult::execution_error_with_backend(
                    result,
                    Some(statement_index),
                    backend_error,
                ));
                if !should_continue_batch_after_error(options.continue_on_error, action) {
                    break;
                }
            }
        }
    }

    Ok(results)
}

fn single_statement_multi_result(
    result: Result<db::QueryResult, QueryExecutionError>,
) -> Result<Vec<ExecuteMultiResult>, QueryExecutionError> {
    result.map(|result| vec![result.into()])
}

trait MysqlBatchStatementExecutor {
    async fn execute_statement(&mut self, statement: &str) -> Result<Vec<db::QueryResult>, String>;
}

struct MysqlBatchConnection<'a> {
    conn: &'a mut mysql_async::Conn,
    cancel_token: Option<CancellationToken>,
    query_timeout: Option<Duration>,
    bare: bool,
    max_rows: Option<usize>,
    dialect: db::mysql::MySqlQueryDialect,
}

impl MysqlBatchStatementExecutor for MysqlBatchConnection<'_> {
    async fn execute_statement(&mut self, statement: &str) -> Result<Vec<db::QueryResult>, String> {
        wait_for_result_opt(
            self.cancel_token.clone(),
            self.query_timeout,
            db::mysql::execute_query_results_on_conn_with_max_rows(
                &mut *self.conn,
                statement,
                self.bare,
                self.max_rows,
                self.dialect,
            ),
        )
        .await
    }
}

async fn execute_mysql_batch_statements<E>(
    executor: &mut E,
    statements: &[String],
    db_type: Option<DatabaseType>,
    cancel_token: Option<CancellationToken>,
    continue_on_error: bool,
    progress: Option<&ExecuteMultiProgressCallback>,
) -> (Vec<ExecuteMultiResult>, Option<PoolErrorAction>)
where
    E: MysqlBatchStatementExecutor,
{
    let mut results = Vec::with_capacity(statements.len());
    for (statement_index, statement) in statements.iter().enumerate() {
        if is_canceled(&cancel_token) {
            results.push(ExecuteMultiResult::execution_error(error_query_result(canceled_error())));
            return (results, None);
        }

        match executor.execute_statement(statement).await {
            Ok(statement_results) => {
                if let Some(result) = statement_results.last() {
                    report_execute_multi_progress(progress, statement_index, statements.len(), result, true, None);
                }
                results.extend(
                    statement_results
                        .into_iter()
                        .map(|result| ExecuteMultiResult::success_with_index(result, statement_index)),
                );
            }
            Err(err) => {
                let action = pool_error_action(db_type, &err);
                let result = error_query_result(err.clone());
                report_execute_multi_progress(
                    progress,
                    statement_index,
                    statements.len(),
                    &result,
                    false,
                    Some(crate::backend_error::BackendError::from_legacy_backend(&err)),
                );
                results.push(ExecuteMultiResult::execution_error_with_index(result, statement_index));
                // Statement errors are safe to collect, but connection-level failures leave
                // the protocol state unusable and must still trigger pool cleanup.
                if !should_continue_batch_after_error(continue_on_error, action) {
                    return (results, Some(action));
                }
            }
        }
    }

    (results, None)
}

#[allow(clippy::too_many_arguments)]
async fn execute_multi_mysql(
    state: &AppState,
    pool_key: &str,
    db_type: Option<DatabaseType>,
    pool: &db::mysql::MySqlPool,
    mode: crate::connection::MysqlMode,
    dialect: db::mysql::MySqlQueryDialect,
    catalog_dialect: Option<db::mysql::MySqlCatalogDialect>,
    database: &str,
    statements: &[String],
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
    progress: Option<&ExecuteMultiProgressCallback>,
) -> Result<Vec<ExecuteMultiResult>, String> {
    let query_timeout = resolve_query_timeout(options.timeout_secs);
    let operation_budget = operation_budget_for_pool_key(state, pool_key, query_timeout).await;
    let bare = mode == crate::connection::MysqlMode::Bare;
    let max_rows = options.max_rows;
    let mut conn = match db::mysql::get_conn_with_health_check_with_cancel(
        pool,
        operation_budget.checkout_timeout,
        operation_budget.cleanup_timeout,
        cancel_token.as_ref(),
    )
    .await
    {
        Ok(conn) => conn,
        Err(err) => {
            if matches!(pool_error_action(db_type, &err), PoolErrorAction::Discard | PoolErrorAction::ReconnectAndRetry)
                || err == QUERY_CANCELED
            {
                state.remove_pool_by_key(pool_key).await;
            }
            return Ok(vec![ExecuteMultiResult::execution_error(error_query_result(err))]);
        }
    };
    apply_oceanbase_mysql_session_timeout(state, pool_key, &mut conn, options.timeout_secs).await?;
    wait_for_result_opt(
        cancel_token.clone(),
        query_timeout,
        db::mysql::apply_catalog_database_context(&mut conn, catalog_dialect, options.catalog.as_deref(), database),
    )
    .await?;

    let mut executor = MysqlBatchConnection {
        conn: &mut conn,
        cancel_token: cancel_token.clone(),
        query_timeout,
        bare,
        max_rows,
        dialect,
    };
    let (results, error_action) = execute_mysql_batch_statements(
        &mut executor,
        statements,
        db_type,
        cancel_token,
        options.continue_on_error,
        progress,
    )
    .await;
    drop(executor);

    if matches!(error_action, Some(PoolErrorAction::Discard | PoolErrorAction::ReconnectAndRetry)) {
        state.remove_pool_by_key(pool_key).await;
    }

    Ok(results)
}

fn error_query_result(message: String) -> db::QueryResult {
    db::QueryResult {
        columns: vec!["Error".to_string()],
        column_types: Vec::new(),
        column_sortables: vec![],
        spatial_columns: vec![],
        spatial_values: vec![],
        rows: vec![vec![serde_json::Value::String(message)]],
        affected_rows: 0,
        execution_time_ms: 0,
        truncated: false,
        session_id: None,
        has_more: false,
        elasticsearch_raw_body: None,
    }
}

fn empty_query_result(execution_time_ms: u128) -> db::QueryResult {
    db::QueryResult {
        columns: vec![],
        column_types: Vec::new(),
        column_sortables: vec![],
        spatial_columns: vec![],
        spatial_values: vec![],
        rows: vec![],
        affected_rows: 0,
        execution_time_ms,
        truncated: false,
        session_id: None,
        has_more: false,
        elasticsearch_raw_body: None,
    }
}

fn sqlserver_batch_results(results: Vec<db::sqlserver::SqlServerBatchResult>) -> Vec<ExecuteMultiResult> {
    results.into_iter().map(ExecuteMultiResult::from).collect()
}

async fn execute_multi_sqlserver(
    state: &AppState,
    pool_key: &str,
    sql: &str,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
) -> Result<Vec<ExecuteMultiResult>, String> {
    let batches = split_sql_batches(sql);

    // Read-only check for SQL Server batch path
    check_read_only_for_connection_multi(state, pool_key, &batches).await?;
    let mut all_results = Vec::new();
    let max_rows = options.max_rows;
    let query_timeout = resolve_query_timeout(options.timeout_secs);
    let execution_mode = options.execution_mode;

    for batch in &batches {
        if is_canceled(&cancel_token) {
            let error = canceled_error();
            all_results.push(ExecuteMultiResult::execution_error_with_backend(
                error_query_result(error.clone()),
                None,
                crate::backend_error::BackendError::from_legacy_backend(&error),
            ));
            break;
        }

        let connections = state.connections.read().await;
        let pool = connections.get(pool_key).ok_or("Connection not found")?;
        let client = match pool {
            PoolKind::SqlServer(c) => c.clone(),
            _ => return Err("Expected SQL Server connection".to_string()),
        };
        drop(connections);

        let mut client_guard = match wait_for_value_opt(cancel_token.clone(), query_timeout, client.lock()).await {
            Ok(guard) => guard,
            Err(err) => {
                all_results.push(ExecuteMultiResult::execution_error_with_backend(
                    error_query_result(err.clone()),
                    None,
                    crate::backend_error::BackendError::from_legacy_backend(&err),
                ));
                break;
            }
        };

        if !sqlserver_pool_is_current(state, pool_key, &client).await {
            let error = "SQL Server connection was reset while waiting for the query lock; please retry.".to_string();
            all_results.push(ExecuteMultiResult::execution_error_with_backend(
                error_query_result(error.clone()),
                None,
                crate::backend_error::BackendError::from_legacy_backend(&error),
            ));
            break;
        }

        let execution = async {
            if execution_mode == QueryExecutionMode::Simple {
                db::sqlserver::execute_simple_batch_with_max_rows_metadata(&mut client_guard, batch, max_rows).await
            } else {
                db::sqlserver::execute_batch_with_max_rows_metadata(&mut client_guard, batch, max_rows).await
            }
        };
        let result = wait_for_result_opt(cancel_token.clone(), query_timeout, execution).await;
        drop(client_guard);

        match result {
            Ok(results) => all_results.extend(sqlserver_batch_results(results)),
            Err(e) => {
                let action = pool_error_action(Some(DatabaseType::SqlServer), &e);
                all_results.push(ExecuteMultiResult::execution_error_with_backend(
                    error_query_result(e.clone()),
                    None,
                    crate::backend_error::BackendError::from_legacy_backend(&e),
                ));
                if matches!(action, PoolErrorAction::Discard | PoolErrorAction::ReconnectAndRetry) {
                    state.remove_pool_by_key(pool_key).await;
                }
                if !should_continue_batch_after_error(options.continue_on_error, action) {
                    break;
                }
            }
        }
    }

    if all_results.is_empty() {
        all_results.push(empty_query_result(0).into());
    }

    Ok(all_results)
}

async fn execute_multi_agent(
    client: &mut db::agent_driver::AgentDriverClient,
    database: Option<&str>,
    statements: &[String],
    schema: Option<&str>,
    timeout_secs: Option<u64>,
) -> Result<db::QueryResult, AgentCallError> {
    client.execute_batch_typed(database, statements, schema, resolve_query_timeout(timeout_secs)).await
}

pub async fn execute_statements(
    state: &AppState,
    connection_id: &str,
    database: &str,
    statements: &[String],
    schema: Option<&str>,
    timeout_secs: Option<u64>,
) -> Result<db::QueryResult, String> {
    let sql_ctx = statements.first().map(|s| s.as_str()).unwrap_or("");
    let pool_key = if database.is_empty() {
        connection_id.to_string()
    } else {
        state
            .get_or_create_pool(connection_id, Some(database))
            .await
            .map_err(|e| query_error_with_omitted_sql_context(&e, sql_ctx))?
    };

    let mut total_affected: u64 = 0;
    let start = std::time::Instant::now();
    let mysql_dialect = connection_mysql_query_dialect(state, connection_id).await;

    let agent_client = {
        let conns = state.connections.read().await;
        match conns.get(&pool_key) {
            Some(PoolKind::Agent(client)) => Some(client.clone()),
            _ => None,
        }
    };
    if let Some(client) = agent_client {
        let source_client = client.clone();
        check_read_only_for_connection_multi(state, &pool_key, statements).await?;
        let db_type = connection_database_type_for_pool_key(state, &pool_key).await;
        let execution_schema = schema_for_execution_context(db_type, schema);
        let rewritten_statements;
        let statements = if qualifies_unqualified_agent_relations(db_type) {
            rewritten_statements =
                statements.iter().map(|sql| sql_for_execution_context(db_type, sql, schema)).collect::<Vec<_>>();
            rewritten_statements.as_slice()
        } else {
            statements
        };
        let mut client = client.lock().await;
        let database = if database.trim().is_empty() { None } else { Some(database) };
        let result = execute_multi_agent(&mut client, database, statements, execution_schema, timeout_secs).await;
        drop(client);
        match result {
            Ok(result) => return Ok(db::QueryResult { execution_time_ms: start.elapsed().as_millis(), ..result }),
            Err(err) => {
                if is_agent_execute_batch_unsupported(&err.to_string()) {
                    log::warn!(
                        "Agent does not support execute_batch; falling back to statement-by-statement execution"
                    );
                } else {
                    discard_agent_pool_after_typed_error(
                        state,
                        &pool_key,
                        &source_client,
                        &err,
                        RecoveryScope::UserOperation,
                    )
                    .await;
                    return Err(query_error_with_omitted_sql_context(&err.into_legacy_string(), sql_ctx));
                }
            }
        }
    }

    for (i, sql) in statements.iter().enumerate() {
        match do_execute(
            state,
            &pool_key,
            mysql_dialect,
            Some(database),
            sql,
            schema,
            None,
            QueryExecutionOptions { timeout_secs, ..Default::default() },
        )
        .await
        {
            Ok(result) => {
                total_affected += result.affected_rows;
            }
            Err(e) => {
                let db_type = connection_database_type(state, connection_id).await;
                match pool_error_action(db_type, &e) {
                    PoolErrorAction::ReconnectAndRetry => {
                        let db_opt = if database.is_empty() { None } else { Some(database) };
                        let _ = state.reconnect_pool(connection_id, db_opt).await;
                    }
                    PoolErrorAction::Discard
                        if !db_type.is_some_and(|db_type| database_capabilities::is_agent_type(&db_type)) =>
                    {
                        let _ = state.remove_pool_by_key(&pool_key).await;
                    }
                    PoolErrorAction::Discard | PoolErrorAction::Keep => {}
                }
                let error = crate::db::agent_driver::append_legacy_error_context(
                    &e,
                    &format!("Statement {} failed; previous {} statement(s) may have been committed.", i + 1, i),
                );
                return Err(query_error_with_omitted_sql_context(&error, sql));
            }
        }
    }

    Ok(db::QueryResult {
        columns: vec![],
        column_types: Vec::new(),
        column_sortables: vec![],
        spatial_columns: vec![],
        spatial_values: vec![],
        rows: vec![],
        affected_rows: total_affected,
        execution_time_ms: start.elapsed().as_millis(),
        truncated: false,
        session_id: None,
        has_more: false,
        elasticsearch_raw_body: None,
    })
}

fn is_agent_execute_batch_unsupported(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("execute_batch") && (lower.contains("unknown method") || lower.contains("method not found"))
}

/// Deploy result for Schema Diff: single-connection transactional execution.
/// On statement failure the transaction is rolled back by the underlying path.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDiffDeployResult {
    pub transaction_id: String,
    pub status: String,
    pub participants: Vec<crate::two_phase_commit::ParticipantInfo>,
    pub created_at: String,
    pub updated_at: String,
    pub executed_count: usize,
    pub statement_count: usize,
    pub error: Option<String>,
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SchemaDiffAtomicity {
    GuaranteedRollback,
    PartialEffectsPossible,
}

impl SchemaDiffAtomicity {
    fn ddl_atomic(self) -> bool {
        matches!(self, Self::GuaranteedRollback)
    }
}

fn database_supports_transactional_ddl(db_type: DatabaseType) -> bool {
    if resolve_for_db(db_type).has_capability(CAP_TRANSACTIONAL_DDL) {
        return true;
    }
    // SQLite-family DDL is transactional even when dialect registry omits the flag.
    matches!(db_type, DatabaseType::Sqlite | DatabaseType::Rqlite | DatabaseType::Turso | DatabaseType::CloudflareD1)
}

fn classify_schema_diff_atomicity(
    db_type: Option<DatabaseType>,
    statements: &[String],
    has_transactional_path: bool,
) -> SchemaDiffAtomicity {
    if !has_transactional_path {
        return SchemaDiffAtomicity::PartialEffectsPossible;
    }

    let mut contains_ddl = false;
    for statement in statements {
        let risk = match db_type {
            Some(db_type) => classify_sql_risk_for_database(statement, db_type).ok(),
            None => None,
        };

        match risk {
            Some(SqlRisk::Ddl) => {
                contains_ddl = true;
            }
            Some(SqlRisk::Write | SqlRisk::ReadOnly) => {}
            Some(SqlRisk::Transaction) | None => {
                return SchemaDiffAtomicity::PartialEffectsPossible;
            }
        }
    }

    if !contains_ddl {
        return SchemaDiffAtomicity::GuaranteedRollback;
    }

    match db_type {
        Some(db_type) if database_supports_transactional_ddl(db_type) => SchemaDiffAtomicity::GuaranteedRollback,
        _ => SchemaDiffAtomicity::PartialEffectsPossible,
    }
}

fn executed_count_before_error(error: &str, statement_count: usize) -> usize {
    let Some(rest) = error.strip_prefix("Statement ") else {
        return statement_count;
    };
    let digits: String = rest.chars().take_while(|ch| ch.is_ascii_digit()).collect();
    let Ok(statement_number) = digits.parse::<usize>() else {
        return statement_count;
    };
    statement_number.saturating_sub(1).min(statement_count)
}

/// Pure failure mapping used by deploy and unit tests.
fn schema_diff_failure_outcome(
    atomicity: SchemaDiffAtomicity,
    error: &str,
    statement_count: usize,
) -> (crate::two_phase_commit::TransactionStatus, usize) {
    if atomicity.ddl_atomic() {
        (crate::two_phase_commit::TransactionStatus::RolledBack, 0)
    } else {
        (crate::two_phase_commit::TransactionStatus::Mixed, executed_count_before_error(error, statement_count))
    }
}

fn pool_kind_has_transactional_path(pool: &PoolKind) -> bool {
    match pool {
        PoolKind::Postgres(_)
        | PoolKind::Mysql(_, _)
        | PoolKind::Sqlite(_)
        | PoolKind::CloudflareD1(_)
        | PoolKind::ClickHouse(_)
        | PoolKind::Rqlite(_)
        | PoolKind::Turso(_)
        | PoolKind::SqlServer(_)
        | PoolKind::Agent(_) => true,
        PoolKind::MessageQueue
        | PoolKind::Nacos
        | PoolKind::HBase(_)
        | PoolKind::DuckDbWorker(_)
        | PoolKind::Redis(_)
        | PoolKind::MongoDb(_)
        | PoolKind::Elasticsearch(_)
        | PoolKind::Easysearch(_)
        | PoolKind::VectorDb(_)
        | PoolKind::InfluxDb(_)
        | PoolKind::ExternalDriver { .. } => false,
        #[cfg(feature = "mq-admin")]
        PoolKind::Mqtt(_) => false,
    }
}

/// Execute Schema Diff deploy SQL as one real single-connection transaction.
///
/// - Uses [`execute_statements_in_transaction`] so partial success rolls back.
/// - Returns a structured result (never re-executes statements to probe status).
/// - Comment-only / empty scripts succeed as `committed` with zero statements.
/// - When the target path cannot guarantee DDL atomicity (MySQL/Oracle DDL
///   auto-commit, `TxPath::None`, etc.), a failure reports `mixed` and
///   `executed_count` reflects the statements that were issued before the
///   error, so the caller can warn the user that partial effects may persist.
pub async fn execute_schema_diff_deploy(
    state: &AppState,
    connection_id: &str,
    database: &str,
    statements: &[String],
    schema: Option<&str>,
) -> SchemaDiffDeployResult {
    let tx_id = format!("deploy_{}", uuid::Uuid::new_v4());
    let now = chrono::Utc::now().to_rfc3339();
    let db_type = connection_database_type(state, connection_id).await;

    let parsed: Vec<String> = statements
        .iter()
        .flat_map(|s| {
            db_type.map_or_else(|| split_sql_statements(s), |dt| crate::sql::split_sql_statements_for_database(s, dt))
        })
        .map(|s| s.trim().to_string())
        .filter(|s| {
            !s.is_empty()
                && !s.lines().all(|line| {
                    let t = line.trim();
                    t.is_empty() || t.starts_with("--")
                })
        })
        .collect();

    let participant = crate::two_phase_commit::ParticipantInfo {
        id: "connection".to_string(),
        name: format!("{connection_id}/{database}"),
        role: "database".to_string(),
    };

    if parsed.is_empty() {
        return SchemaDiffDeployResult {
            transaction_id: tx_id,
            status: crate::two_phase_commit::TransactionStatus::Committed.as_str().to_string(),
            participants: vec![participant],
            created_at: now.clone(),
            updated_at: now,
            executed_count: 0,
            statement_count: 0,
            error: None,
            metadata: serde_json::json!({"source": "schema_diff_deploy", "mode": "single_connection_tx"}),
        };
    }

    let pool_key = if database.is_empty() {
        connection_id.to_string()
    } else {
        match state.get_or_create_pool(connection_id, Some(database)).await {
            Ok(key) => key,
            Err(_) => {
                return SchemaDiffDeployResult {
                    transaction_id: tx_id.clone(),
                    status: crate::two_phase_commit::TransactionStatus::RolledBack.as_str().to_string(),
                    participants: vec![participant],
                    created_at: now.clone(),
                    updated_at: chrono::Utc::now().to_rfc3339(),
                    executed_count: 0,
                    statement_count: parsed.len(),
                    error: Some("Connection not available for deploy".to_string()),
                    metadata: serde_json::json!({"source": "schema_diff_deploy", "mode": "single_connection_tx"}),
                };
            }
        }
    };
    let has_transactional_path = {
        let conns = state.connections.read().await;
        conns.get(&pool_key).is_some_and(pool_kind_has_transactional_path)
    };
    let atomicity = classify_schema_diff_atomicity(db_type, &parsed, has_transactional_path);

    match execute_statements_in_transaction_on_pool(state, &pool_key, connection_id, database, &parsed, schema, None)
        .await
    {
        Ok(result) => SchemaDiffDeployResult {
            transaction_id: tx_id,
            status: crate::two_phase_commit::TransactionStatus::Committed.as_str().to_string(),
            participants: vec![participant],
            created_at: now.clone(),
            updated_at: chrono::Utc::now().to_rfc3339(),
            executed_count: parsed.len(),
            statement_count: parsed.len(),
            error: None,
            metadata: serde_json::json!({
                "source": "schema_diff_deploy",
                "mode": "single_connection_tx",
                "affected_rows": result.affected_rows,
                "execution_time_ms": result.execution_time_ms,
            }),
        },
        Err(e) => {
            let (status, executed_count) = schema_diff_failure_outcome(atomicity, &e, parsed.len());
            SchemaDiffDeployResult {
                transaction_id: tx_id,
                status: status.as_str().to_string(),
                participants: vec![participant],
                created_at: now.clone(),
                updated_at: chrono::Utc::now().to_rfc3339(),
                executed_count,
                statement_count: parsed.len(),
                error: Some(e.clone()),
                metadata: serde_json::json!({
                    "source": "schema_diff_deploy",
                    "mode": "single_connection_tx",
                    "ddl_atomic": atomicity.ddl_atomic(),
                    "atomicity": match atomicity {
                        SchemaDiffAtomicity::GuaranteedRollback => "guaranteed_rollback",
                        SchemaDiffAtomicity::PartialEffectsPossible => "partial_effects_possible",
                    },
                    "error": e,
                }),
            }
        }
    }
}

/// Execute multiple SQL statements within a single transaction.
/// For pooled drivers (Postgres/MySQL), uses the driver transaction API.
/// For SQLite and already-single-connection drivers (ClickHouse/SqlServer/Agent),
/// uses explicit BEGIN/COMMIT/ROLLBACK on the shared connection.
/// For databases that don't support explicit transactions (Redis, MongoDB, Oracle),
/// executes statements sequentially without transaction.
/// If BEGIN fails, returns an error instead of silently falling back to auto-commit.
pub async fn execute_statements_in_transaction(
    state: &AppState,
    connection_id: &str,
    database: &str,
    statements: &[String],
    schema: Option<&str>,
    catalog: Option<&str>,
) -> Result<db::QueryResult, String> {
    execute_statements_in_transaction_typed(state, connection_id, database, statements, schema, catalog)
        .await
        .map_err(QueryExecutionError::into_legacy_string)
}

/// Execute multiple SQL statements transactionally while retaining typed failures.
pub async fn execute_statements_in_transaction_typed(
    state: &AppState,
    connection_id: &str,
    database: &str,
    statements: &[String],
    schema: Option<&str>,
    catalog: Option<&str>,
) -> Result<db::QueryResult, QueryExecutionError> {
    let sql_ctx = statements.first().map(|s| s.as_str()).unwrap_or("");
    let pool_database = query_pool_database(database, catalog);
    let pool_key = state
        .get_or_create_pool(connection_id, pool_database)
        .await
        .map_err(|e| query_error_with_omitted_sql_context(&e, sql_ctx))?;

    execute_statements_in_transaction_on_pool_typed(
        state,
        &pool_key,
        connection_id,
        database,
        statements,
        schema,
        catalog,
    )
    .await
}

/// Execute multiple SQL statements transactionally on an already-resolved pool.
/// This preserves session-scoped pools used by long-running imports.
pub async fn execute_statements_in_transaction_on_pool(
    state: &AppState,
    pool_key: &str,
    connection_id: &str,
    database: &str,
    statements: &[String],
    schema: Option<&str>,
    catalog: Option<&str>,
) -> Result<db::QueryResult, String> {
    execute_statements_in_transaction_on_pool_typed(
        state,
        pool_key,
        connection_id,
        database,
        statements,
        schema,
        catalog,
    )
    .await
    .map_err(QueryExecutionError::into_legacy_string)
}

/// Execute a transaction on an already-resolved pool without erasing typed failures.
pub async fn execute_statements_in_transaction_on_pool_typed(
    state: &AppState,
    pool_key: &str,
    connection_id: &str,
    database: &str,
    statements: &[String],
    schema: Option<&str>,
    catalog: Option<&str>,
) -> Result<db::QueryResult, QueryExecutionError> {
    // Read-only check: intercept all transaction paths before dispatching
    check_read_only_for_connection_multi(state, pool_key, statements).await?;

    let start = std::time::Instant::now();
    let db_type = connection_database_type(state, connection_id).await;
    let mysql_catalog_dialect = connection_mysql_catalog_dialect(state, connection_id).await;
    let operation_budget = configured_operation_budget_for_pool_key(state, pool_key).await;

    // Clone the pool handle within the lock, then drop it before any async work.
    let path = {
        let conns = state.connections.read().await;
        conns.get(pool_key).map(|p| match p {
            PoolKind::Postgres(pg) => TxPath::Pg(pg.clone()),
            PoolKind::Mysql(mp, _mode) => TxPath::Mysql(mp.clone(), false),
            PoolKind::Sqlite(sq) => TxPath::Sqlite(sq.clone()),
            PoolKind::CloudflareD1(client) => TxPath::CloudflareD1(client.clone()),
            PoolKind::ClickHouse(_) | PoolKind::Rqlite(_) | PoolKind::Turso(_) | PoolKind::SqlServer(_) => {
                TxPath::Explicit
            }
            PoolKind::Agent(client) => TxPath::Agent(client.clone()),
            PoolKind::MessageQueue | PoolKind::Nacos | PoolKind::HBase(_) => TxPath::None,
            #[cfg(feature = "mq-admin")]
            PoolKind::Mqtt(_) => TxPath::None,
            PoolKind::DuckDbWorker(_)
            | PoolKind::Redis(_)
            | PoolKind::MongoDb(_)
            | PoolKind::Elasticsearch(_)
            | PoolKind::Easysearch(_)
            | PoolKind::VectorDb(_)
            | PoolKind::InfluxDb(_)
            | PoolKind::ExternalDriver { .. } => TxPath::None,
        })
    };

    let result = match path {
        Some(TxPath::Pg(pool)) => {
            let cancel_context = state.get_postgres_cancel_context(pool_key).await;
            exec_tx_pg_inner(pool, statements, schema, start, operation_budget.clone(), cancel_context).await
        }
        Some(TxPath::Mysql(pool, _bare)) => exec_tx_mysql_inner(
            state,
            pool_key,
            pool,
            statements,
            start,
            operation_budget.clone(),
            mysql_catalog_dialect,
            catalog,
            database,
        )
        .await
        .map_err(Into::into),
        Some(TxPath::Sqlite(pool)) => exec_tx_sqlite_inner(pool, statements, start).await.map_err(Into::into),
        Some(TxPath::CloudflareD1(client)) => {
            let sql = statements.join(";\n");
            wait_for_query_opt(
                None,
                operation_budget.query_timeout,
                db::cloudflare_d1_driver::execute_query_with_max_rows(&client, &sql, None),
            )
            .await
            .map_err(Into::into)
        }
        Some(TxPath::Agent(client)) => {
            let result = exec_tx_agent_inner(client.clone(), db_type, Some(database), statements, schema, start).await;
            if let Err(error) = result.as_ref() {
                discard_agent_pool_after_typed_error(state, pool_key, &client, error, RecoveryScope::UserOperation)
                    .await;
            }
            return result.map_err(QueryExecutionError::Agent);
        }
        Some(TxPath::Explicit) => {
            let mysql_dialect = connection_mysql_query_dialect(state, connection_id).await;
            exec_tx_explicit_inner(state, pool_key, mysql_dialect, Some(database), statements, schema, start)
                .await
                .map_err(Into::into)
        }
        Some(TxPath::None) => {
            let mysql_dialect = connection_mysql_query_dialect(state, connection_id).await;
            exec_tx_none_inner(state, pool_key, mysql_dialect, Some(database), statements, schema, start)
                .await
                .map_err(Into::into)
        }
        None => Err("Connection not found for transaction".to_string().into()),
    };

    if let Err(err) = result.as_ref() {
        discard_pool_after_error(state, pool_key, db_type, &err.to_string()).await;
    }

    result
}

/// Owned pool variants for safe dispatch across async boundaries.
enum TxPath {
    Pg(deadpool_postgres::Pool),
    Mysql(mysql_async::Pool, bool),
    Sqlite(db::sqlite::SqliteHandle),
    CloudflareD1(db::cloudflare_d1_driver::CloudflareD1Client),
    Agent(Arc<crate::db::agent_driver::PooledAgentClient>),
    Explicit,
    None,
}

// Each of these acquires a dedicated connection and runs all statements within
// BEGIN ... COMMIT/ROLLBACK, guaranteeing a single physical connection.

async fn exec_tx_pg_inner(
    pool: deadpool_postgres::Pool,
    statements: &[String],
    schema: Option<&str>,
    start: std::time::Instant,
    budget: DbOperationBudget,
    cancel_context: Option<db::postgres::PostgresCancelContext>,
) -> Result<db::QueryResult, QueryExecutionError> {
    let mut client = db::postgres::checkout_postgres_client(&pool, None, budget.checkout_timeout)
        .await
        .map_err(|e| format!("Failed to acquire connection: {}", e))?;
    let had_schema = schema.is_some();
    if let Some(s) = schema {
        db::postgres::set_postgres_search_path(
            &client,
            s,
            db::postgres::PostgresSearchPathContext::Transaction,
            budget.recycle_timeout,
        )
        .await
        .map_err(|e| format!("SET search_path failed: {}", e))?;
    }
    let tx_result = exec_tx_pg_statements(&mut client, statements, &budget, cancel_context).await;

    // Always reset search_path so the connection is clean when returned to the pool
    let reset_result = if had_schema {
        db::postgres::execute_postgres_infra_statement(
            &client,
            "RESET search_path",
            budget.cleanup_timeout,
            "schema.reset",
        )
        .await
        .map_err(|err| QueryExecutionError::Legacy(format!("PostgreSQL schema.reset cleanup failed: {err}")))
    } else {
        Ok(0)
    };

    match (tx_result, reset_result) {
        (Ok(total_affected), Ok(_)) => Ok(db::QueryResult {
            columns: vec![],
            column_types: Vec::new(),
            column_sortables: vec![],
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: vec![],
            affected_rows: total_affected,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
        }),
        (Err(e), Ok(_)) => Err(e),
        (Ok(_), Err(reset_err)) => Err(reset_err),
        (Err(e), Err(reset_err)) => Err(e.with_context(&reset_err.to_string())),
    }
}

async fn exec_tx_pg_statements(
    client: &mut deadpool_postgres::Client,
    statements: &[String],
    budget: &DbOperationBudget,
    cancel_context: Option<db::postgres::PostgresCancelContext>,
) -> Result<u64, QueryExecutionError> {
    let tx = tokio::time::timeout(budget.recycle_timeout, client.transaction())
        .await
        .map_err(|_| {
            format!("Failed to begin transaction: timed out after {} seconds", budget.recycle_timeout.as_secs())
        })?
        .map_err(|e| format!("Failed to begin transaction: {}", e))?;
    let mut total_affected: u64 = 0;
    for (i, sql) in statements.iter().enumerate() {
        let pg_cancel_token = tx.client().cancel_token();
        let mut is_server_error = false;
        let affected = db::postgres::wait_postgres_operation(
            pg_cancel_token,
            cancel_context.clone(),
            budget.query_timeout,
            budget.cancel_timeout,
            async {
                tx.execute(sql, &[]).await.map_err(|error| {
                    is_server_error = error.as_db_error().is_some();
                    error.to_string()
                })
            },
        )
        .await
        .map_err(|e| postgres_transaction_statement_error(i + 1, &e, sql, is_server_error))?;
        total_affected += affected;
    }
    tokio::time::timeout(budget.cleanup_timeout, tx.commit())
        .await
        .map_err(|_| format!("COMMIT timed out after {} seconds", budget.cleanup_timeout.as_secs()))?
        .map_err(|e| format!("COMMIT failed: {}", e))?;
    Ok(total_affected)
}

async fn exec_tx_mysql_inner(
    state: &AppState,
    pool_key: &str,
    pool: mysql_async::Pool,
    statements: &[String],
    start: std::time::Instant,
    budget: DbOperationBudget,
    catalog_dialect: Option<db::mysql::MySqlCatalogDialect>,
    catalog: Option<&str>,
    database: &str,
) -> Result<db::QueryResult, String> {
    let mut conn = db::mysql::get_conn_with_health_check_with_timeout(&pool, budget.checkout_timeout).await?;
    apply_oceanbase_mysql_session_timeout(state, pool_key, &mut conn, None).await?;
    db::mysql::apply_catalog_database_context(&mut conn, catalog_dialect, catalog, database).await?;
    mysql_query_drop_with_timeout(
        &mut conn,
        "START TRANSACTION",
        budget.recycle_timeout,
        "Failed to begin transaction",
    )
    .await?;
    let mut total_affected: u64 = 0;
    for (i, sql) in statements.iter().enumerate() {
        match mysql_query_iter_with_timeout(&mut conn, sql, budget.query_timeout).await {
            Ok(affected) => total_affected += affected,
            Err(e) => {
                let _ = mysql_query_drop_with_timeout(&mut conn, "ROLLBACK", budget.cleanup_timeout, "ROLLBACK failed")
                    .await;
                return Err(query_error_with_omitted_sql_context(&format!("Statement {} failed: {}", i + 1, e), sql));
            }
        }
    }
    mysql_query_drop_with_timeout(&mut conn, "COMMIT", budget.cleanup_timeout, "COMMIT failed").await?;
    Ok(db::QueryResult {
        columns: vec![],
        column_types: Vec::new(),
        column_sortables: vec![],
        spatial_columns: vec![],
        spatial_values: vec![],
        rows: vec![],
        affected_rows: total_affected,
        execution_time_ms: start.elapsed().as_millis(),
        truncated: false,
        session_id: None,
        has_more: false,
        elasticsearch_raw_body: None,
    })
}

async fn mysql_query_drop_with_timeout(
    conn: &mut mysql_async::Conn,
    sql: &str,
    timeout_duration: Duration,
    context: &str,
) -> Result<(), String> {
    tokio::time::timeout(timeout_duration, conn.query_drop(sql))
        .await
        .map_err(|_| format!("{context}: timed out after {} seconds", timeout_duration.as_secs()))?
        .map_err(|e| format!("{context}: {e}"))
}

async fn mysql_query_iter_with_timeout(
    conn: &mut mysql_async::Conn,
    sql: &str,
    timeout_duration: Option<Duration>,
) -> Result<u64, String> {
    match timeout_duration {
        Some(timeout_duration) => tokio::time::timeout(timeout_duration, conn.query_iter(sql))
            .await
            .map_err(|_| format!("Query timed out after {} seconds", timeout_duration.as_secs()))?
            .map(|result| result.affected_rows())
            .map_err(|e| e.to_string()),
        None => conn.query_iter(sql).await.map(|result| result.affected_rows()).map_err(|e| e.to_string()),
    }
}

async fn exec_tx_sqlite_inner(
    pool: db::sqlite::SqliteHandle,
    statements: &[String],
    start: std::time::Instant,
) -> Result<db::QueryResult, String> {
    let statements = statements.to_vec();
    tokio::task::spawn_blocking(move || {
        pool.with_connection(|conn| {
            conn.execute_batch("BEGIN").map_err(|e| format!("Failed to begin transaction: {}", e))?;
            let mut total_affected: u64 = 0;
            for (i, sql) in statements.iter().enumerate() {
                match conn.execute_batch(sql) {
                    Ok(_) => total_affected += conn.changes(),
                    Err(e) => {
                        let _ = conn.execute_batch("ROLLBACK");
                        return Err(query_error_with_omitted_sql_context(
                            &format!("Statement {} failed: {}", i + 1, e),
                            sql,
                        ));
                    }
                }
            }
            conn.execute_batch("COMMIT").map_err(|e| format!("COMMIT failed: {}", e))?;
            Ok(db::QueryResult {
                columns: vec![],
                column_types: Vec::new(),
                column_sortables: vec![],
                spatial_columns: vec![],
                spatial_values: vec![],
                rows: vec![],
                affected_rows: total_affected,
                execution_time_ms: start.elapsed().as_millis(),
                truncated: false,
                session_id: None,
                has_more: false,
                elasticsearch_raw_body: None,
            })
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn exec_tx_explicit_inner(
    state: &AppState,
    pool_key: &str,
    mysql_dialect: db::mysql::MySqlQueryDialect,
    database: Option<&str>,
    statements: &[String],
    schema: Option<&str>,
    start: std::time::Instant,
) -> Result<db::QueryResult, String> {
    do_execute(
        state,
        pool_key,
        mysql_dialect,
        database,
        "BEGIN TRANSACTION",
        schema,
        None,
        QueryExecutionOptions::default(),
    )
    .await
    .map_err(|e| format!("Failed to begin transaction: {}", e))?;

    let mut total_affected: u64 = 0;
    for (i, sql) in statements.iter().enumerate() {
        match do_execute(state, pool_key, mysql_dialect, database, sql, schema, None, QueryExecutionOptions::default())
            .await
        {
            Ok(result) => {
                total_affected += result.affected_rows;
            }
            Err(e) => {
                if let Err(rb_err) = do_execute(
                    state,
                    pool_key,
                    mysql_dialect,
                    database,
                    "ROLLBACK",
                    schema,
                    None,
                    QueryExecutionOptions::default(),
                )
                .await
                {
                    log::error!("ROLLBACK failed after statement {} error: {}", i + 1, rb_err);
                }
                return Err(query_error_with_omitted_sql_context(&format!("Statement {} failed: {}", i + 1, e), sql));
            }
        }
    }

    do_execute(state, pool_key, mysql_dialect, database, "COMMIT", schema, None, QueryExecutionOptions::default())
        .await
        .map_err(|e| format!("COMMIT failed: {}", e))?;

    Ok(db::QueryResult {
        columns: vec![],
        column_types: Vec::new(),
        column_sortables: vec![],
        spatial_columns: vec![],
        spatial_values: vec![],
        rows: vec![],
        affected_rows: total_affected,
        execution_time_ms: start.elapsed().as_millis(),
        truncated: false,
        session_id: None,
        has_more: false,
        elasticsearch_raw_body: None,
    })
}

async fn exec_tx_agent_inner(
    client: Arc<crate::db::agent_driver::PooledAgentClient>,
    db_type: Option<DatabaseType>,
    database: Option<&str>,
    statements: &[String],
    schema: Option<&str>,
    start: std::time::Instant,
) -> Result<db::QueryResult, AgentCallError> {
    let execution_schema = schema_for_execution_context(db_type, schema);
    let rewritten_statements;
    let statements = if qualifies_unqualified_agent_relations(db_type) {
        rewritten_statements =
            statements.iter().map(|sql| sql_for_execution_context(db_type, sql, schema)).collect::<Vec<_>>();
        rewritten_statements.as_slice()
    } else {
        statements
    };
    let mut client = client.lock().await;
    let result: db::QueryResult = client.execute_transaction_typed(database, statements, execution_schema).await?;
    Ok(db::QueryResult { execution_time_ms: start.elapsed().as_millis(), ..result })
}

async fn exec_tx_none_inner(
    state: &AppState,
    pool_key: &str,
    mysql_dialect: db::mysql::MySqlQueryDialect,
    database: Option<&str>,
    statements: &[String],
    schema: Option<&str>,
    start: std::time::Instant,
) -> Result<db::QueryResult, String> {
    let mut total_affected: u64 = 0;
    for (i, sql) in statements.iter().enumerate() {
        log::info!("[query][tx-none:statement:start] index={}", i + 1);
        match do_execute(state, pool_key, mysql_dialect, database, sql, schema, None, QueryExecutionOptions::default())
            .await
        {
            Ok(result) => {
                total_affected += result.affected_rows;
                log::info!("[query][tx-none:statement:done] index={} affected_rows={}", i + 1, result.affected_rows);
            }
            Err(e) => {
                log::warn!("Statement {} failed (no transaction support): {}", i + 1, e);
                return Err(query_error_with_omitted_sql_context(
                    &format!("Statement {} failed: {}. No transaction support for this database type.", i + 1, e),
                    sql,
                ));
            }
        }
    }

    Ok(db::QueryResult {
        columns: vec![],
        column_types: Vec::new(),
        column_sortables: vec![],
        spatial_columns: vec![],
        spatial_values: vec![],
        rows: vec![],
        affected_rows: total_affected,
        execution_time_ms: start.elapsed().as_millis(),
        truncated: false,
        session_id: None,
        has_more: false,
        elasticsearch_raw_body: None,
    })
}

/// Start a manual transaction session, holding a connection from the pool.
/// Returns a transaction session ID that must be passed to subsequent calls.
pub async fn begin_manual_transaction(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: Option<&str>,
    catalog: Option<&str>,
) -> Result<String, String> {
    begin_transaction_session(state, connection_id, database, schema, catalog, false).await
}

/// Start a read-only, repeatable snapshot for a database backup.
pub async fn begin_database_backup_snapshot(
    state: &AppState,
    connection_id: &str,
    database: &str,
) -> Result<String, String> {
    begin_transaction_session(state, connection_id, database, None, None, true).await
}

fn postgres_transaction_begin_sql(consistent_snapshot: bool) -> &'static str {
    if consistent_snapshot {
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
    } else {
        "BEGIN"
    }
}

fn mysql_transaction_begin_sql_candidates(consistent_snapshot: bool) -> &'static [&'static str] {
    if consistent_snapshot {
        &[
            "START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY",
            "START TRANSACTION WITH CONSISTENT SNAPSHOT",
            "START TRANSACTION",
        ]
    } else {
        &["START TRANSACTION"]
    }
}

fn mysql_transaction_isolation_sql(consistent_snapshot: bool) -> Option<&'static str> {
    consistent_snapshot.then_some("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
}

fn mysql_error_is_syntax_error(error: &mysql_async::Error) -> bool {
    matches!(error, mysql_async::Error::Server(server_error) if server_error.code == 1064)
}

async fn begin_transaction_session(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: Option<&str>,
    catalog: Option<&str>,
    consistent_snapshot: bool,
) -> Result<String, String> {
    let mysql_catalog_dialect = connection_mysql_catalog_dialect(state, connection_id).await;
    let pool_database = query_pool_database(database, catalog);
    let pool_key = state.get_or_create_pool(connection_id, pool_database).await?;

    // Clone the pool handle under a brief read lock, then drop the lock before
    // any async I/O — same pattern as do_execute throughout this file.
    enum TxnPoolHandle {
        Postgres(deadpool_postgres::Pool),
        Mysql(db::mysql::MySqlPool),
    }
    let pool_handle = {
        let connections = state.connections.read().await;
        match connections.get(&pool_key).ok_or("Connection not found")? {
            PoolKind::Postgres(pg) => TxnPoolHandle::Postgres(pg.clone()),
            PoolKind::Mysql(mp, _) => TxnPoolHandle::Mysql(mp.clone()),
            _ => return Err("Manual transaction is not supported for this database type".to_string()),
        }
    }; // connections lock released here

    let txn_conn = match pool_handle {
        TxnPoolHandle::Postgres(pg_pool) => {
            let conn = pg_pool.get().await.map_err(|e| format!("Failed to get Postgres connection: {e}"))?;
            let begin_sql = postgres_transaction_begin_sql(consistent_snapshot);
            conn.execute(begin_sql, &[]).await.map_err(|e| format!("BEGIN failed: {e}"))?;
            if let Some(schema) = schema {
                db::postgres::set_postgres_search_path(
                    &conn,
                    schema,
                    db::postgres::PostgresSearchPathContext::LocalTransaction,
                    db::connection_timeout(),
                )
                .await
                .map_err(|e| format!("SET search_path failed: {e}"))?;
            }
            TxnConnection::Postgres(Box::new(conn))
        }
        TxnPoolHandle::Mysql(mysql_pool) => {
            let mut conn = mysql_pool.get_conn().await.map_err(|e| format!("Failed to get MySQL connection: {e}"))?;
            db::mysql::apply_catalog_database_context(&mut conn, mysql_catalog_dialect, catalog, database).await?;
            if let Some(isolation_sql) = mysql_transaction_isolation_sql(consistent_snapshot) {
                conn.query_drop(isolation_sql).await.map_err(|e| format!("SET TRANSACTION failed: {e}"))?;
            }
            let mut syntax_errors = Vec::new();
            for begin_sql in mysql_transaction_begin_sql_candidates(consistent_snapshot) {
                match conn.query_drop(*begin_sql).await {
                    Ok(()) => {
                        syntax_errors.clear();
                        break;
                    }
                    Err(error) if mysql_error_is_syntax_error(&error) => {
                        syntax_errors.push(format!("{begin_sql}: {error}"));
                    }
                    Err(error) => return Err(format!("START TRANSACTION failed: {error}")),
                }
            }
            if !syntax_errors.is_empty() {
                return Err(format!("START TRANSACTION failed for all compatible forms: {}", syntax_errors.join("; ")));
            }
            TxnConnection::Mysql(conn)
        }
    };

    let txn_session_id = uuid::Uuid::new_v4().to_string();
    let session = TransactionSession {
        connection: Arc::new(tokio::sync::Mutex::new(txn_conn)),
        pool_key: pool_key.clone(),
        last_activity: std::time::Instant::now(),
        busy: false,
        connection_id: connection_id.to_string(),
        database: database.to_string(),
        schema: schema.map(|s| s.to_string()),
    };

    {
        let mut sessions = state.transaction_sessions.write().await;
        sessions.insert(txn_session_id.clone(), session);
    }

    // Schedule idle timeout watcher
    spawn_txn_idle_watcher(state, txn_session_id.clone());

    log::info!("[query][manual_txn:begin] session_id={}", txn_session_id);
    Ok(txn_session_id)
}

/// Execute SQL within an existing manual transaction session.
pub async fn execute_in_manual_transaction(
    state: &AppState,
    txn_session_id: &str,
    sql: &str,
    _database: &str,
    _schema: Option<&str>,
    max_rows: Option<usize>,
) -> Result<Vec<db::QueryResult>, String> {
    const TXN_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

    // Resolve statements and validate before taking the per-session connection
    // lock. The session stays visible in the map so close/disconnect cleanup can
    // remove it and roll back once the current DB operation releases the lock.
    let (pool_key, connection_id) = {
        let sessions = state.transaction_sessions.read().await;
        let session = sessions
            .get(txn_session_id)
            .ok_or("Transaction session not found or expired; it may have been auto-rolled back due to inactivity")?;
        (session.pool_key.clone(), session.connection_id.clone())
    };

    let db_type = connection_database_type(state, &connection_id).await;
    let statements = db_type.map_or_else(
        || split_sql_statements(sql),
        |db_type| crate::sql::split_sql_statements_for_database(sql, db_type),
    );
    if statements.is_empty() {
        return Ok(vec![empty_query_result(0)]);
    }

    // Read-only check while the session is still in the map. If this fails the
    // session remains intact.
    check_read_only_for_connection_multi(state, &pool_key, &statements).await?;

    let connection = {
        let mut sessions = state.transaction_sessions.write().await;
        let Some(session) = sessions.get_mut(txn_session_id) else {
            return Err(
                "Transaction session not found or expired; it may have been auto-rolled back due to inactivity"
                    .to_string(),
            );
        };
        if session.busy {
            return Err("Transaction session is already executing".to_string());
        }
        if session.last_activity.elapsed() > TXN_IDLE_TIMEOUT {
            let session = sessions.remove(txn_session_id).expect("session exists");
            Some(session.connection)
        } else {
            session.busy = true;
            session.last_activity = std::time::Instant::now();
            None
        }
    };
    if let Some(connection) = connection {
        let mut conn = connection.lock().await;
        let _ = rollback_manual_txn_connection(&mut conn).await;
        return Err("Transaction was auto-rolled back due to 5 minutes of inactivity".to_string());
    }

    let connection = {
        let sessions = state.transaction_sessions.read().await;
        sessions
            .get(txn_session_id)
            .map(|session| Arc::clone(&session.connection))
            .ok_or("Transaction session not found or expired; it may have been auto-rolled back due to inactivity")?
    };
    let row_limit = max_rows.unwrap_or(MAX_ROWS).max(1);
    let mut results = Vec::with_capacity(statements.len());

    let mut conn = connection.lock().await;
    for (i, statement) in statements.iter().enumerate() {
        let result = match &mut *conn {
            TxnConnection::Postgres(conn) => {
                execute_manual_txn_postgres_statement(conn.as_ref(), statement, row_limit).await
            }
            TxnConnection::Mysql(conn) => execute_manual_txn_mysql_statement(conn, statement, row_limit).await,
        };
        match result {
            Ok(query_result) => results.push(query_result),
            Err(e) => {
                // Statement failure ends the transaction. If another cleanup path
                // already removed the session, it owns the final rollback.
                let should_rollback = {
                    let mut sessions = state.transaction_sessions.write().await;
                    sessions.remove(txn_session_id).is_some()
                };
                if should_rollback {
                    let _ = rollback_manual_txn_connection(&mut conn).await;
                }
                return Err(format!("Statement {} failed: {}. Transaction was auto-rolled back.", i + 1, e));
            }
        }
    }
    drop(conn);

    let should_watch = {
        let mut sessions = state.transaction_sessions.write().await;
        if let Some(session) = sessions.get_mut(txn_session_id) {
            session.busy = false;
            session.last_activity = std::time::Instant::now();
            true
        } else {
            false
        }
    };
    if should_watch {
        spawn_txn_idle_watcher(state, txn_session_id.to_string());
    }

    Ok(results)
}

/// Stream a read query through an existing transaction without materializing
/// the whole result set. The callback runs once per batch while the same held
/// connection and transaction snapshot remain active.
pub async fn stream_rows_in_manual_transaction<F>(
    state: &AppState,
    txn_session_id: &str,
    sql: &str,
    batch_size: usize,
    mut on_batch: F,
) -> Result<u64, String>
where
    F: FnMut(Vec<Vec<serde_json::Value>>) -> Result<(), String> + Send,
{
    const TXN_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

    let expired_connection = {
        let mut sessions = state.transaction_sessions.write().await;
        let Some(session) = sessions.get_mut(txn_session_id) else {
            return Err(
                "Transaction session not found or expired; it may have been auto-rolled back due to inactivity"
                    .to_string(),
            );
        };
        if session.busy {
            return Err("Transaction session is already executing".to_string());
        }
        if session.last_activity.elapsed() > TXN_IDLE_TIMEOUT {
            Some(sessions.remove(txn_session_id).expect("session exists").connection)
        } else {
            session.busy = true;
            session.last_activity = std::time::Instant::now();
            None
        }
    };
    if let Some(connection) = expired_connection {
        let mut conn = connection.lock().await;
        let _ = rollback_manual_txn_connection(&mut conn).await;
        return Err("Transaction was auto-rolled back due to 5 minutes of inactivity".to_string());
    }

    let connection = {
        let sessions = state.transaction_sessions.read().await;
        sessions
            .get(txn_session_id)
            .map(|session| Arc::clone(&session.connection))
            .ok_or("Transaction session not found or expired; it may have been auto-rolled back due to inactivity")?
    };
    let batch_size = batch_size.max(1);
    let mut conn = connection.lock().await;
    let stream_result = match &mut *conn {
        TxnConnection::Postgres(conn) => {
            let mut batch = Vec::with_capacity(batch_size);
            let mut total_rows = 0_u64;
            let result = db::postgres::stream_select_query_inner(conn, sql, None, &mut |item| {
                if let db::postgres::PostgresQueryStreamItem::Row(row) = item {
                    batch.push(row);
                    total_rows += 1;
                    if batch.len() >= batch_size {
                        on_batch(std::mem::take(&mut batch))?;
                        batch = Vec::with_capacity(batch_size);
                    }
                }
                Ok(())
            })
            .await;
            match result {
                Ok(_) if !batch.is_empty() => on_batch(batch).map(|_| total_rows),
                Ok(_) => Ok(total_rows),
                Err(error) => Err(error),
            }
        }
        TxnConnection::Mysql(conn) => match conn.query_iter(sql).await {
            Ok(mut result) => match result.stream::<mysql_async::Row>().await {
                Ok(Some(mut stream)) => {
                    let mut batch = Vec::with_capacity(batch_size);
                    let mut total_rows = 0_u64;
                    let mut error = None;
                    while let Some(row_result) = stream.next().await {
                        match row_result {
                            Ok(row) => {
                                batch.push(
                                    (0..row.len()).map(|index| db::mysql::mysql_value_to_json(&row, index)).collect(),
                                );
                                total_rows += 1;
                                if batch.len() >= batch_size {
                                    if let Err(err) = on_batch(std::mem::take(&mut batch)) {
                                        error = Some(err);
                                        break;
                                    }
                                    batch = Vec::with_capacity(batch_size);
                                }
                            }
                            Err(err) => {
                                error = Some(format!("Query failed: {err}"));
                                break;
                            }
                        }
                    }
                    if error.is_none() && !batch.is_empty() {
                        if let Err(err) = on_batch(batch) {
                            error = Some(err);
                        }
                    }
                    error.map_or(Ok(total_rows), Err)
                }
                Ok(None) => Err("Empty result set stream".to_string()),
                Err(err) => Err(format!("Query failed: {err}")),
            },
            Err(err) => Err(format!("Query failed: {err}")),
        },
    };

    if let Err(err) = &stream_result {
        let should_rollback = state.transaction_sessions.write().await.remove(txn_session_id).is_some();
        if should_rollback {
            let _ = rollback_manual_txn_connection(&mut conn).await;
        }
        return Err(format!("{err}. Transaction was auto-rolled back."));
    }
    drop(conn);

    let should_watch = {
        let mut sessions = state.transaction_sessions.write().await;
        if let Some(session) = sessions.get_mut(txn_session_id) {
            session.busy = false;
            session.last_activity = std::time::Instant::now();
            true
        } else {
            false
        }
    };
    if should_watch {
        spawn_txn_idle_watcher(state, txn_session_id.to_string());
    }
    stream_result
}

async fn rollback_manual_txn_connection(conn: &mut TxnConnection) -> Result<(), String> {
    match conn {
        TxnConnection::Postgres(conn) => {
            conn.execute("ROLLBACK", &[]).await.map_err(|e| format!("ROLLBACK failed: {e}"))?;
        }
        TxnConnection::Mysql(conn) => {
            conn.query_drop("ROLLBACK").await.map_err(|e| format!("ROLLBACK failed: {e}"))?;
        }
    }
    Ok(())
}

/// Spawn a background task that removes and rolls back a transaction session
/// after 5 minutes of inactivity. The task does not hold the global lock across
/// I/O: it briefly checks the map, and if the session exists and is expired,
/// removes it, drops the lock, then rolls back the held connection.
///
/// Safety: if multiple watchers exist for the same session ID (e.g. due to
/// a race), only the one that actually finds the session in the map and
/// observes an elapsed time >= timeout will remove and roll back. Others
/// will see a missing session or a non-expired one and exit harmlessly.
fn spawn_txn_idle_watcher(state: &AppState, txn_session_id: String) {
    let sessions = Arc::clone(&state.transaction_sessions);
    tokio::spawn(async move {
        const TXN_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);
        tokio::time::sleep(TXN_IDLE_TIMEOUT).await;

        let removed: Option<TransactionSession> = {
            let mut guard = sessions.write().await;
            match guard.get(&txn_session_id) {
                Some(session) if !session.busy && session.last_activity.elapsed() >= TXN_IDLE_TIMEOUT => {
                    guard.remove(&txn_session_id)
                }
                _ => None,
            }
        };

        if let Some(session) = removed {
            let mut conn = session.connection.lock().await;
            let _ = rollback_manual_txn_connection(&mut conn).await;
            log::info!(
                "[query][manual_txn:idle_timeout] session_id={} auto-rolled back after 5 minutes of inactivity",
                txn_session_id
            );
        }
    });
}

async fn execute_manual_txn_postgres_statement(
    conn: &deadpool_postgres::Object,
    sql: &str,
    row_limit: usize,
) -> Result<db::QueryResult, String> {
    if db::postgres::postgres_statement_returns_rows(sql) {
        db::postgres::execute_select_query(conn, sql, std::time::Instant::now(), row_limit).await
    } else {
        let affected = conn.execute(sql, &[]).await.map_err(|e| format!("Query failed: {e}"))?;
        Ok(db::QueryResult {
            columns: vec![],
            column_types: Vec::new(),
            column_sortables: vec![],
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: vec![],
            affected_rows: affected,
            execution_time_ms: 0,
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
        })
    }
}

async fn execute_manual_txn_mysql_statement(
    conn: &mut mysql_async::Conn,
    sql: &str,
    row_limit: usize,
) -> Result<db::QueryResult, String> {
    if db::mysql::is_result_set_query(sql, db::mysql::MySqlQueryDialect::default()) {
        let start = std::time::Instant::now();
        let mut result = conn.query_iter(sql).await.map_err(|e| format!("Query failed: {e}"))?;
        let columns: Vec<String> = result.columns_ref().iter().map(|c| c.name_str().to_string()).collect();
        let column_types: Vec<String> = result.columns_ref().iter().map(db::mysql::mysql_column_type_name).collect();
        let mut data: Vec<Vec<serde_json::Value>> = Vec::with_capacity(row_limit.min(1024));
        let mut stream = result
            .stream::<mysql_async::Row>()
            .await
            .map_err(|e| format!("Query failed: {e}"))?
            .ok_or_else(|| "Empty result set stream".to_string())?;
        let mut truncated = false;
        while let Some(row) = stream.next().await {
            if data.len() >= row_limit {
                truncated = true;
                break;
            }
            let row = row.map_err(|e| format!("Query failed: {e}"))?;
            data.push((0..row.len()).map(|i| db::mysql::mysql_value_to_json(&row, i)).collect());
        }
        Ok(db::QueryResult {
            columns,
            column_types,
            column_sortables: vec![],
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: data,
            affected_rows: 0,
            execution_time_ms: start.elapsed().as_millis(),
            truncated,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
        })
    } else {
        let result = conn.query_iter(sql).await.map_err(|e| format!("Query failed: {e}"))?;
        let affected_rows = result.affected_rows();
        result.drop_result().await.map_err(|e| format!("Query failed: {e}"))?;
        Ok(db::QueryResult {
            columns: vec![],
            column_types: Vec::new(),
            column_sortables: vec![],
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: vec![],
            affected_rows,
            execution_time_ms: 0,
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
        })
    }
}

/// Commit an existing manual transaction session.
pub async fn commit_manual_transaction(state: &AppState, txn_session_id: &str) -> Result<db::QueryResult, String> {
    let session = {
        let mut sessions = state.transaction_sessions.write().await;
        sessions.remove(txn_session_id).ok_or("Transaction session not found")?
    };

    let mut conn = session.connection.lock().await;
    match &mut *conn {
        TxnConnection::Postgres(conn) => {
            conn.execute("COMMIT", &[]).await.map_err(|e| format!("COMMIT failed: {e}"))?;
        }
        TxnConnection::Mysql(conn) => {
            conn.query_drop("COMMIT").await.map_err(|e| format!("COMMIT failed: {e}"))?;
        }
    }

    log::info!("[query][manual_txn:commit] session_id={}", txn_session_id);
    Ok(db::QueryResult {
        columns: vec![],
        column_types: Vec::new(),
        column_sortables: vec![],
        spatial_columns: vec![],
        spatial_values: vec![],
        rows: vec![],
        affected_rows: 0,
        execution_time_ms: 0,
        truncated: false,
        session_id: None,
        has_more: false,
        elasticsearch_raw_body: None,
    })
}

/// Rollback an existing manual transaction session.
pub async fn rollback_manual_transaction(state: &AppState, txn_session_id: &str) -> Result<db::QueryResult, String> {
    let session = {
        let mut sessions = state.transaction_sessions.write().await;
        sessions.remove(txn_session_id).ok_or("Transaction session not found")?
    };

    let mut conn = session.connection.lock().await;
    rollback_manual_txn_connection(&mut conn).await?;

    log::info!("[query][manual_txn:rollback] session_id={}", txn_session_id);
    Ok(db::QueryResult {
        columns: vec![],
        column_types: Vec::new(),
        column_sortables: vec![],
        spatial_columns: vec![],
        spatial_values: vec![],
        rows: vec![],
        affected_rows: 0,
        execution_time_ms: 0,
        truncated: false,
        session_id: None,
        has_more: false,
        elasticsearch_raw_body: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redshift_queries_prefer_text_protocol() {
        assert!(postgres_prefers_text_protocol(Some(DatabaseType::Redshift)));
        assert!(!postgres_prefers_text_protocol(Some(DatabaseType::Postgres)));
        assert!(!postgres_prefers_text_protocol(None));
    }
    #[cfg(unix)]
    use crate::db::agent_driver::{AgentDriverClient, AgentLaunchSpec};
    use crate::models::connection::{default_redis_key_separator, ConnectionConfig, DatabaseType};
    #[cfg(unix)]
    use crate::plugins::{
        InstalledPlugin, PluginDriverManifest, PluginDriverSession, PluginManifest, PluginRuntimeEnv,
    };
    use crate::storage::Storage;

    #[cfg(unix)]
    async fn spawn_agent_batch_timeout_test_client() -> (AgentDriverClient, tempfile::NamedTempFile) {
        use std::io::Write;

        let mut script = tempfile::NamedTempFile::new().unwrap();
        write!(
            script,
            r#"import json
import sys
import time

print(json.dumps({{"ready": True}}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    statements = request.get("params", {{}}).get("statements", [])
    time.sleep(1.2 if statements == ["slow"] else 0.05)
    result = {{
        "columns": [],
        "column_types": [],
        "column_sortables": [],
        "rows": [],
        "affected_rows": 1,
        "execution_time_ms": 50,
        "truncated": False,
        "session_id": None,
        "has_more": False
    }}
    print(json.dumps({{"jsonrpc": "2.0", "id": request["id"], "result": result}}), flush=True)
"#
        )
        .unwrap();
        script.flush().unwrap();

        let client = AgentDriverClient::spawn(
            AgentLaunchSpec::new("python3").with_args([script.path().to_string_lossy().to_string()]),
        )
        .await
        .unwrap();
        (client, script)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn execute_multi_agent_zero_timeout_waits_for_response() {
        let (mut client, _script) = spawn_agent_batch_timeout_test_client().await;

        let result = execute_multi_agent(&mut client, None, &["fast".to_string()], None, Some(0)).await.unwrap();

        assert_eq!(result.affected_rows, 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn execute_multi_agent_positive_timeout_still_expires() {
        let (mut client, _script) = spawn_agent_batch_timeout_test_client().await;

        let error = execute_multi_agent(&mut client, None, &["slow".to_string()], None, Some(1)).await.unwrap_err();

        assert!(matches!(
            error,
            AgentCallError::Timeout {
                stage: AgentErrorStage::Execute,
                operation_outcome: AgentOperationOutcome::Unknown,
            }
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn execute_multi_agent_default_timeout_keeps_normal_execution() {
        let (mut client, _script) = spawn_agent_batch_timeout_test_client().await;

        let result = execute_multi_agent(&mut client, None, &["fast".to_string()], None, None).await.unwrap();

        assert_eq!(result.affected_rows, 1);
        assert_eq!(resolve_query_timeout(None), Some(QUERY_TIMEOUT));
    }

    #[test]
    fn external_catalog_queries_do_not_bind_database_during_pool_creation() {
        assert_eq!(query_pool_database("bi", Some("paimon_catalog")), None);
        assert_eq!(query_pool_database("bi", None), Some("bi"));
        assert_eq!(query_pool_database("", None), None);
    }

    #[tokio::test]
    async fn query_and_transaction_paths_resolve_catalog_dialect_from_connection() {
        let dir = std::env::temp_dir().join(format!("dbx-catalog-dialect-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = AppState::new(storage);

        let mut doris = test_connection_config(DatabaseType::Doris);
        doris.id = "doris".to_string();
        let mut starrocks = test_connection_config(DatabaseType::StarRocks);
        starrocks.id = "starrocks".to_string();
        {
            let mut configs = state.configs.write().await;
            configs.insert(doris.id.clone(), doris);
            configs.insert(starrocks.id.clone(), starrocks);
        }

        assert_eq!(
            connection_mysql_catalog_dialect_for_pool_key(&state, "doris:bi").await,
            Some(db::mysql::MySqlCatalogDialect::Doris)
        );
        assert_eq!(
            connection_mysql_catalog_dialect(&state, "starrocks").await,
            Some(db::mysql::MySqlCatalogDialect::StarRocks)
        );

        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn schema_diff_atomicity_marks_mysql_ddl_as_partial() {
        let atomicity = classify_schema_diff_atomicity(
            Some(DatabaseType::Mysql),
            &["CREATE TABLE users (id INT)".to_string(), "ALTER TABLE users ADD COLUMN name VARCHAR(32)".to_string()],
            true,
        );

        assert_eq!(atomicity, SchemaDiffAtomicity::PartialEffectsPossible);
    }

    #[test]
    fn schema_diff_atomicity_marks_oracle_ddl_as_partial() {
        let atomicity = classify_schema_diff_atomicity(
            Some(DatabaseType::Oracle),
            &["CREATE TABLE users (id INT)".to_string(), "ALTER TABLE users ADD name VARCHAR2(32)".to_string()],
            true,
        );

        assert_eq!(atomicity, SchemaDiffAtomicity::PartialEffectsPossible);
    }

    #[test]
    fn schema_diff_atomicity_keeps_postgres_ddl_atomic() {
        let atomicity = classify_schema_diff_atomicity(
            Some(DatabaseType::Postgres),
            &["CREATE TABLE users (id INT)".to_string(), "ALTER TABLE users ADD COLUMN name VARCHAR(32)".to_string()],
            true,
        );

        assert_eq!(atomicity, SchemaDiffAtomicity::GuaranteedRollback);
    }

    #[test]
    fn schema_diff_atomicity_keeps_dml_atomic_when_tx_path_exists() {
        let atomicity = classify_schema_diff_atomicity(
            Some(DatabaseType::Mysql),
            &["INSERT INTO users VALUES (1)".to_string(), "UPDATE users SET active = 1 WHERE id = 1".to_string()],
            true,
        );

        assert_eq!(atomicity, SchemaDiffAtomicity::GuaranteedRollback);
    }

    #[test]
    fn schema_diff_atomicity_marks_missing_transaction_path_as_partial() {
        let atomicity = classify_schema_diff_atomicity(
            Some(DatabaseType::Postgres),
            &["CREATE TABLE users (id INT)".to_string()],
            false,
        );

        assert_eq!(atomicity, SchemaDiffAtomicity::PartialEffectsPossible);
    }

    #[test]
    fn executed_count_before_error_uses_failing_statement_index() {
        assert_eq!(executed_count_before_error("Statement 1 failed: syntax error", 3), 0);
        assert_eq!(executed_count_before_error("Statement 2 failed: syntax error", 3), 1);
        assert_eq!(executed_count_before_error("Statement 3 failed: syntax error", 3), 2);
    }

    #[test]
    fn schema_diff_failure_outcome_rolls_back_when_atomic() {
        let (status, executed) =
            schema_diff_failure_outcome(SchemaDiffAtomicity::GuaranteedRollback, "Statement 2 failed: syntax error", 3);
        assert_eq!(status, crate::two_phase_commit::TransactionStatus::RolledBack);
        assert_eq!(executed, 0);
    }

    #[test]
    fn schema_diff_failure_outcome_reports_mixed_with_partial_count() {
        let (status, executed) = schema_diff_failure_outcome(
            SchemaDiffAtomicity::PartialEffectsPossible,
            "Statement 2 failed: syntax error",
            3,
        );
        assert_eq!(status, crate::two_phase_commit::TransactionStatus::Mixed);
        assert_eq!(executed, 1);
    }

    #[test]
    fn schema_diff_atomicity_keeps_sqlite_ddl_atomic() {
        let atomicity = classify_schema_diff_atomicity(
            Some(DatabaseType::Sqlite),
            &["CREATE TABLE users (id INTEGER)".to_string()],
            true,
        );
        assert_eq!(atomicity, SchemaDiffAtomicity::GuaranteedRollback);
    }

    /// MySQL: first DDL may already commit; second fails → mixed + executed_count = 1.
    #[test]
    fn mysql_second_ddl_failure_maps_to_mixed_with_partial_executed_count() {
        let stmts = ["CREATE TABLE t1 (id INT)".to_string(), "CREATE TABLE t2 (id INT)".to_string()];
        let atomicity = classify_schema_diff_atomicity(Some(DatabaseType::Mysql), &stmts, true);
        assert_eq!(atomicity, SchemaDiffAtomicity::PartialEffectsPossible);
        let (status, executed) =
            schema_diff_failure_outcome(atomicity, "Statement 2 failed: table already exists", stmts.len());
        assert_eq!(status, crate::two_phase_commit::TransactionStatus::Mixed);
        assert_eq!(executed, 1);
    }

    /// Oracle: same non-transactional DDL semantics as MySQL for deploy status.
    #[test]
    fn oracle_second_ddl_failure_maps_to_mixed_with_partial_executed_count() {
        let stmts = ["CREATE TABLE t1 (id NUMBER)".to_string(), "ALTER TABLE t1 ADD name VARCHAR2(32)".to_string()];
        let atomicity = classify_schema_diff_atomicity(Some(DatabaseType::Oracle), &stmts, true);
        assert_eq!(atomicity, SchemaDiffAtomicity::PartialEffectsPossible);
        let (status, executed) = schema_diff_failure_outcome(atomicity, "Statement 2 failed: ORA-00942", stmts.len());
        assert_eq!(status, crate::two_phase_commit::TransactionStatus::Mixed);
        assert_eq!(executed, 1);
    }

    /// Postgres transactional DDL: second fails → rolled_back + executed_count = 0.
    #[test]
    fn postgres_second_ddl_failure_maps_to_rolled_back_zero_executed() {
        let stmts = ["CREATE TABLE t1 (id INT)".to_string(), "CREATE TABLE t2 (id INT)".to_string()];
        let atomicity = classify_schema_diff_atomicity(Some(DatabaseType::Postgres), &stmts, true);
        assert_eq!(atomicity, SchemaDiffAtomicity::GuaranteedRollback);
        let (status, executed) =
            schema_diff_failure_outcome(atomicity, "Statement 2 failed: relation already exists", stmts.len());
        assert_eq!(status, crate::two_phase_commit::TransactionStatus::RolledBack);
        assert_eq!(executed, 0);
    }

    #[test]
    fn query_execution_mode_deserializes_simple_client_value() {
        let mode: QueryExecutionMode = serde_json::from_str("\"simple\"").unwrap();

        assert_eq!(mode, QueryExecutionMode::Simple);
        assert_eq!(QueryExecutionMode::default(), QueryExecutionMode::Standard);
    }

    #[test]
    fn query_execution_mode_deserializes_postgres_read_only_transaction() {
        let mode: QueryExecutionMode = serde_json::from_str("\"postgres_read_only_transaction\"").unwrap();

        assert_eq!(mode, QueryExecutionMode::PostgresReadOnlyTransaction);
    }

    #[test]
    fn postgres_read_only_transaction_requires_postgres_and_isolated_session() {
        let mut options = QueryExecutionOptions {
            execution_mode: QueryExecutionMode::PostgresReadOnlyTransaction,
            ..Default::default()
        };

        assert!(validate_query_execution_mode(Some(DatabaseType::Mysql), "SELECT 1", &options).is_err());
        assert!(validate_query_execution_mode(Some(DatabaseType::Postgres), "SELECT 1", &options).is_err());

        options.client_session_id = Some("tab:explain:execution".to_string());
        assert_eq!(validate_query_execution_mode(Some(DatabaseType::Postgres), "SELECT 1", &options), Ok(()));
        assert!(validate_query_execution_mode(Some(DatabaseType::Postgres), "SELECT 1; SELECT 2", &options).is_err());
    }

    fn test_connection_config(db_type: DatabaseType) -> ConnectionConfig {
        ConnectionConfig {
            id: "conn-1".to_string(),
            name: "Connection".to_string(),
            note: String::new(),
            db_type,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            agent_java_options: Vec::new(),
            host: "localhost".to_string(),
            port: 0,
            username: String::new(),
            password: String::new(),
            database: None,
            visible_databases: None,
            visible_schemas: None,
            show_system_schemas: false,
            attached_databases: Vec::new(),
            init_script: None,
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: 10,
            query_timeout_secs: 30,
            idle_timeout_secs: 60,
            keepalive_interval_secs: 30,
            ssl: false,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            sysdba: false,
            oracle_connection_type: None,
            connection_string: None,
            redis_connection_mode: None,
            redis_sentinel_master: String::new(),
            redis_sentinel_nodes: String::new(),
            redis_sentinel_username: String::new(),
            redis_sentinel_password: String::new(),
            redis_sentinel_tls: false,
            redis_cluster_nodes: String::new(),
            redis_key_separator: default_redis_key_separator(),
            redis_scan_page_size: None,
            redis_database_aliases: Default::default(),
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: false,
            is_production: false,
            production_databases: vec![],
            database_info: None,
        }
    }

    async fn agent_error_state(
        disposition: &str,
    ) -> (AppState, std::path::PathBuf, std::sync::Arc<crate::db::agent_driver::AgentRuntimeClient>) {
        let dir = std::env::temp_dir().join(format!("dbx-query-agent-error-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script_path = dir.join("agent.py");
        std::fs::write(
            &script_path,
            format!(
                r#"import json, sys
print(json.dumps({{'ready': True}}), flush=True)
for line in sys.stdin:
    req = json.loads(line)
    if req['method'] == 'handshake':
        response = {{
            'jsonrpc': '2.0',
            'id': req['id'],
            'result': {{'protocolVersion': 2, 'agentProtocolVersion': 2, 'capabilities': ['multi_session']}}
        }}
    elif req['method'] in ('execute_query', 'execute_batch', 'execute_transaction'):
        response = {{
            'jsonrpc': '2.0',
            'id': req['id'],
            'error': {{
                'code': -1,
                'message': 'injected Agent failure',
                'data': {{
                    'category': 'resource',
                    'retryable': False,
                    'sessionDisposition': '{disposition}',
                    'stage': 'execute'
                }}
            }}
        }}
    else:
        response = {{'jsonrpc': '2.0', 'id': req['id'], 'result': {{}}}}
    print(json.dumps(response), flush=True)
"#
            ),
        )
        .unwrap();

        let python = if cfg!(windows) { "python" } else { "python3" };
        let runtime = crate::db::agent_driver::AgentRuntimeClient::spawn(
            crate::db::agent_driver::AgentLaunchSpec::new(python)
                .with_args([script_path.to_string_lossy().to_string()]),
            "test",
        )
        .await
        .unwrap();
        runtime.increment_session_count();

        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = AppState::new(storage);
        state.configs.write().await.insert("conn-1".to_string(), test_connection_config(DatabaseType::Dameng));
        state.connections.write().await.insert(
            "conn-1".to_string(),
            PoolKind::agent(crate::db::agent_driver::AgentDriverClient::shared_session(
                runtime.clone(),
                "session-1".to_string(),
            )),
        );

        (state, dir, runtime)
    }

    #[tokio::test]
    async fn agent_query_replace_runtime_error_detaches_pool_and_stops_runtime() {
        let (state, dir, runtime) = agent_error_state("replace_runtime").await;

        let error = execute_sql_statement(&state, "conn-1", "", "SELECT 1", None, None).await.unwrap_err();

        assert!(error.contains("injected Agent failure"));
        assert!(!state.connections.read().await.contains_key("conn-1"));
        assert!(runtime.is_failed());

        runtime.kill();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn single_statement_multi_core_keeps_query_error_typed() {
        let (state, dir, runtime) = agent_error_state("keep").await;

        let error = execute_multi_core_with_options_for_client_and_progress_typed(
            &state,
            "conn-1",
            "",
            "SELECT 1",
            None,
            None,
            QueryExecutionOptions::default(),
            None,
        )
        .await
        .unwrap_err();

        assert!(matches!(error, QueryExecutionError::Agent(_)));

        runtime.kill();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn native_pre_dispatch_cancellation_stays_typed() {
        let dir = std::env::temp_dir().join(format!("dbx-query-native-cancel-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = AppState::new(storage);
        let connection_id = "sqlite-cancel";
        let sqlite = db::sqlite::connect_path_create_if_missing(dir.join("query.db").to_str().unwrap()).await.unwrap();
        state.connections.write().await.insert(connection_id.to_string(), PoolKind::Sqlite(sqlite));
        state.configs.write().await.insert(connection_id.to_string(), test_connection_config(DatabaseType::Sqlite));
        let cancel_token = CancellationToken::new();
        cancel_token.cancel();

        let error = execute_sql_statement_with_options_typed(
            &state,
            connection_id,
            "",
            "SELECT 1",
            None,
            Some(cancel_token),
            QueryExecutionOptions::default(),
        )
        .await
        .unwrap_err();

        assert!(matches!(
            &error,
            QueryExecutionError::Canceled {
                stage: AgentErrorStage::Request,
                operation_outcome: AgentOperationOutcome::NotStarted,
            }
        ));
        let backend_error = error.into_backend_error();
        assert_eq!(backend_error.code(), "DBX-JDBC-2003");
        assert_eq!(backend_error.source(), crate::backend_error::BackendErrorSource::LegacyBackend);
        assert_eq!(backend_error.operation_outcome(), crate::backend_error::BackendOperationOutcome::NotStarted);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn agent_pre_dispatch_cancellation_stays_local_and_typed() {
        let (state, dir, runtime) = agent_error_state("keep").await;
        let cancel_token = CancellationToken::new();
        cancel_token.cancel();

        let error = execute_sql_statement_with_options_typed(
            &state,
            "conn-1",
            "",
            "SELECT 1",
            None,
            Some(cancel_token),
            QueryExecutionOptions::default(),
        )
        .await
        .unwrap_err();

        assert!(matches!(
            &error,
            QueryExecutionError::Canceled {
                stage: AgentErrorStage::Request,
                operation_outcome: AgentOperationOutcome::NotStarted,
            }
        ));
        let backend_error = error.into_backend_error();
        assert_eq!(backend_error.code(), "DBX-JDBC-2003");
        assert_eq!(backend_error.source(), crate::backend_error::BackendErrorSource::LegacyBackend);
        assert_eq!(backend_error.operation_outcome(), crate::backend_error::BackendOperationOutcome::NotStarted);
        assert!(!runtime.is_failed());

        runtime.kill();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn agent_transaction_replace_runtime_error_detaches_pool_and_stops_runtime() {
        let (state, dir, runtime) = agent_error_state("replace_runtime").await;

        let error = execute_statements_in_transaction_on_pool(
            &state,
            "conn-1",
            "conn-1",
            "",
            &["UPDATE test_table SET value = 1".to_string()],
            None,
            None,
        )
        .await
        .unwrap_err();

        assert!(error.contains("injected Agent failure"));
        assert!(!state.connections.read().await.contains_key("conn-1"));
        assert!(runtime.is_failed());

        runtime.kill();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn agent_batch_replace_runtime_error_detaches_pool_and_stops_runtime() {
        let (state, dir, runtime) = agent_error_state("replace_runtime").await;

        let error =
            execute_statements(&state, "conn-1", "", &["UPDATE test_table SET value = 1".to_string()], None, None)
                .await
                .unwrap_err();

        assert!(error.contains("injected Agent failure"));
        assert!(!state.connections.read().await.contains_key("conn-1"));
        assert!(runtime.is_failed());

        runtime.kill();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn agent_quarantine_error_removes_only_target_pool() {
        let (state, dir, runtime) = agent_error_state("quarantine").await;

        let error = execute_sql_statement(&state, "conn-1", "", "SELECT 1", None, None).await.unwrap_err();

        assert!(error.contains("injected Agent failure"));
        assert!(!state.connections.read().await.contains_key("conn-1"));
        assert!(!runtime.is_failed());

        runtime.kill();
        let _ = std::fs::remove_dir_all(dir);
    }

    struct FakeMysqlBatchExecutor {
        outcomes: std::collections::VecDeque<Result<Vec<db::QueryResult>, String>>,
        executed: Vec<String>,
    }

    impl MysqlBatchStatementExecutor for FakeMysqlBatchExecutor {
        async fn execute_statement(&mut self, statement: &str) -> Result<Vec<db::QueryResult>, String> {
            self.executed.push(statement.to_string());
            self.outcomes.pop_front().expect("test outcome for statement")
        }
    }

    fn mysql_batch_result(result: db::QueryResult) -> Result<Vec<db::QueryResult>, String> {
        Ok(vec![result])
    }

    async fn assert_sqlite_batch_error_behavior(failure_first: bool, continue_on_error: bool) {
        let dir = std::env::temp_dir().join(format!("dbx-query-batch-error-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = AppState::new(storage);
        let connection_id = "sqlite-batch";
        let sqlite = db::sqlite::connect_path_create_if_missing(dir.join("query.db").to_str().unwrap()).await.unwrap();
        state.connections.write().await.insert(connection_id.to_string(), PoolKind::Sqlite(sqlite));
        state.configs.write().await.insert(connection_id.to_string(), test_connection_config(DatabaseType::Sqlite));

        let sql = if failure_first {
            "INSERT INTO missing_table VALUES (1); CREATE TABLE executed_after_error (id INTEGER);"
        } else {
            "CREATE TABLE before_error (id INTEGER); INSERT INTO missing_table VALUES (1); CREATE TABLE executed_after_error (id INTEGER);"
        };
        let results = execute_multi_core_with_options(
            &state,
            connection_id,
            "",
            sql,
            None,
            None,
            QueryExecutionOptions { continue_on_error, ..Default::default() },
        )
        .await
        .unwrap();
        let error_index = usize::from(!failure_first);
        assert_eq!(results[error_index].columns, vec!["Error"]);
        assert_eq!(
            results.len(),
            if failure_first { 1 + usize::from(continue_on_error) } else { 2 + usize::from(continue_on_error) }
        );

        let table_check = execute_sql_statement(
            &state,
            connection_id,
            "",
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'executed_after_error'",
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(!table_check.rows.is_empty(), continue_on_error);
    }

    #[test]
    fn agent_execute_batch_unsupported_detects_case_insensitive_method_errors() {
        assert!(is_agent_execute_batch_unsupported("Agent RPC error (-1): unknown method: execute_batch"));
        assert!(is_agent_execute_batch_unsupported("Agent RPC error (-1): Unknown method: execute_batch"));
        assert!(is_agent_execute_batch_unsupported("Agent RPC error (-32601): Method not found: execute_batch"));
    }

    #[test]
    fn agent_execute_batch_unsupported_ignores_unrelated_errors() {
        assert!(!is_agent_execute_batch_unsupported("ORA-00955: name is already used by an existing object"));
        assert!(!is_agent_execute_batch_unsupported("Agent RPC error (-1): unknown method: execute_query"));
    }

    #[test]
    fn query_pool_error_policy_retries_reads_but_not_writes() {
        assert_eq!(
            query_pool_error_action(Some(DatabaseType::Postgres), "SELECT * FROM users", "connection reset by peer"),
            PoolErrorAction::ReconnectAndRetry
        );
        assert_eq!(
            query_pool_error_action(
                Some(DatabaseType::Postgres),
                "UPDATE users SET active = true",
                "connection reset by peer"
            ),
            PoolErrorAction::Discard
        );
    }

    #[tokio::test]
    async fn sqlite_batch_stops_when_the_first_statement_fails() {
        assert_sqlite_batch_error_behavior(true, false).await;
    }

    #[tokio::test]
    async fn sqlite_batch_continues_when_the_first_statement_fails_and_enabled() {
        assert_sqlite_batch_error_behavior(true, true).await;
    }

    #[tokio::test]
    async fn sqlite_batch_stops_when_a_middle_statement_fails() {
        assert_sqlite_batch_error_behavior(false, false).await;
    }

    #[tokio::test]
    async fn sqlite_batch_continues_when_a_middle_statement_fails_and_enabled() {
        assert_sqlite_batch_error_behavior(false, true).await;
    }

    #[tokio::test]
    async fn mysql_batch_stops_after_the_first_statement_error() {
        let statements = vec!["first".to_string(), "fails".to_string(), "must-not-run".to_string()];
        let mut executor = FakeMysqlBatchExecutor {
            outcomes: std::collections::VecDeque::from([
                mysql_batch_result(empty_query_result(0)),
                Err("Duplicate entry".to_string()),
                mysql_batch_result(empty_query_result(0)),
            ]),
            executed: Vec::new(),
        };

        let (results, error_action) =
            execute_mysql_batch_statements(&mut executor, &statements, Some(DatabaseType::Mysql), None, false, None)
                .await;

        assert_eq!(executor.executed, vec!["first", "fails"]);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].statement_index, Some(0));
        assert_eq!(results[1].statement_index, Some(1));
        assert!(results[1].execution_error);
        assert_eq!(error_action, Some(PoolErrorAction::Keep));
    }

    #[tokio::test]
    async fn mysql_batch_reports_progress_for_each_completed_statement() {
        let statements = vec!["first".to_string(), "fails".to_string(), "must-not-run".to_string()];
        let mut executor = FakeMysqlBatchExecutor {
            outcomes: std::collections::VecDeque::from([
                mysql_batch_result(empty_query_result(0)),
                Err("Duplicate entry".to_string()),
            ]),
            executed: Vec::new(),
        };
        let progress_events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let progress: ExecuteMultiProgressCallback = {
            let progress_events = Arc::clone(&progress_events);
            Arc::new(move |event| progress_events.lock().unwrap().push(event))
        };

        let (results, error_action) = execute_mysql_batch_statements(
            &mut executor,
            &statements,
            Some(DatabaseType::Mysql),
            None,
            false,
            Some(&progress),
        )
        .await;

        assert_eq!(executor.executed, vec!["first", "fails"]);
        assert_eq!(results.len(), 2);
        assert_eq!(
            *progress_events.lock().unwrap(),
            vec![
                ExecuteMultiProgress {
                    statement_index: 0,
                    completed: 1,
                    total: 3,
                    success: true,
                    execution_time_ms: 0,
                    affected_rows: 0,
                    error: None,
                },
                ExecuteMultiProgress {
                    statement_index: 1,
                    completed: 2,
                    total: 3,
                    success: false,
                    execution_time_ms: 0,
                    affected_rows: 0,
                    error: Some(crate::backend_error::BackendError::from_legacy_backend("Duplicate entry")),
                },
            ]
        );
        assert_eq!(error_action, Some(PoolErrorAction::Keep));
    }

    #[tokio::test]
    async fn mysql_batch_preserves_multiple_result_sets_from_one_statement() {
        let statements = vec!["CALL testA()".to_string(), "UPDATE users SET active = 1".to_string()];
        let result_set = |value| db::QueryResult {
            columns: vec!["value".to_string()],
            column_types: vec!["INT".to_string()],
            column_sortables: vec![],
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: vec![vec![serde_json::json!(value)]],
            affected_rows: 0,
            execution_time_ms: 1,
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
        };
        let mut executor = FakeMysqlBatchExecutor {
            outcomes: std::collections::VecDeque::from([
                Ok(vec![result_set(1), result_set(2), result_set(3)]),
                mysql_batch_result(empty_query_result(1)),
            ]),
            executed: Vec::new(),
        };

        let (results, error_action) =
            execute_mysql_batch_statements(&mut executor, &statements, Some(DatabaseType::Mysql), None, false, None)
                .await;

        assert_eq!(executor.executed, statements);
        assert_eq!(results.len(), 4);
        assert_eq!(
            results.iter().map(|result| result.statement_index).collect::<Vec<_>>(),
            vec![Some(0), Some(0), Some(0), Some(1)]
        );
        assert_eq!(
            results[..3].iter().map(|result| result.result.rows[0][0].clone()).collect::<Vec<_>>(),
            vec![serde_json::json!(1), serde_json::json!(2), serde_json::json!(3)]
        );
        assert_eq!(error_action, None);
    }

    #[tokio::test]
    async fn mysql_batch_stops_when_the_first_statement_fails() {
        let statements = vec!["fails".to_string(), "must-not-run".to_string()];
        let mut executor = FakeMysqlBatchExecutor {
            outcomes: std::collections::VecDeque::from([
                Err("Duplicate entry".to_string()),
                mysql_batch_result(empty_query_result(0)),
            ]),
            executed: Vec::new(),
        };

        let (results, error_action) =
            execute_mysql_batch_statements(&mut executor, &statements, Some(DatabaseType::Mysql), None, false, None)
                .await;

        assert_eq!(executor.executed, vec!["fails"]);
        assert_eq!(results.len(), 1);
        assert!(results[0].execution_error);
        assert_eq!(error_action, Some(PoolErrorAction::Keep));
    }

    #[tokio::test]
    async fn mysql_batch_continues_after_statement_errors_when_enabled() {
        let statements = vec!["first".to_string(), "fails".to_string(), "third".to_string()];
        let mut executor = FakeMysqlBatchExecutor {
            outcomes: std::collections::VecDeque::from([
                mysql_batch_result(empty_query_result(0)),
                Err("Duplicate entry".to_string()),
                mysql_batch_result(empty_query_result(0)),
            ]),
            executed: Vec::new(),
        };

        let (results, error_action) =
            execute_mysql_batch_statements(&mut executor, &statements, Some(DatabaseType::Mysql), None, true, None)
                .await;

        assert_eq!(executor.executed, statements);
        assert_eq!(results.len(), 3);
        assert_eq!(
            results.iter().map(|result| result.statement_index).collect::<Vec<_>>(),
            vec![Some(0), Some(1), Some(2)]
        );
        assert!(results[1].execution_error);
        assert_eq!(error_action, None);
    }

    #[tokio::test]
    async fn mysql_batch_continues_when_the_first_statement_fails_and_enabled() {
        let statements = vec!["fails".to_string(), "second".to_string()];
        let mut executor = FakeMysqlBatchExecutor {
            outcomes: std::collections::VecDeque::from([
                Err("Duplicate entry".to_string()),
                mysql_batch_result(empty_query_result(0)),
            ]),
            executed: Vec::new(),
        };

        let (results, error_action) =
            execute_mysql_batch_statements(&mut executor, &statements, Some(DatabaseType::Mysql), None, true, None)
                .await;

        assert_eq!(executor.executed, statements);
        assert_eq!(results.len(), 2);
        assert!(results[0].execution_error);
        assert_eq!(error_action, None);
    }

    #[tokio::test]
    async fn mysql_batch_stops_on_connection_errors_when_continue_is_enabled() {
        let statements = vec!["first".to_string(), "disconnects".to_string(), "must-not-run".to_string()];
        let mut executor = FakeMysqlBatchExecutor {
            outcomes: std::collections::VecDeque::from([
                mysql_batch_result(empty_query_result(0)),
                Err("connection reset by peer".to_string()),
                mysql_batch_result(empty_query_result(0)),
            ]),
            executed: Vec::new(),
        };

        let (results, error_action) =
            execute_mysql_batch_statements(&mut executor, &statements, Some(DatabaseType::Mysql), None, true, None)
                .await;

        assert_eq!(executor.executed, vec!["first", "disconnects"]);
        assert_eq!(results.len(), 2);
        assert_eq!(results.iter().map(|result| result.statement_index).collect::<Vec<_>>(), vec![Some(0), Some(1)]);
        assert!(results[1].execution_error);
        assert_eq!(error_action, Some(PoolErrorAction::ReconnectAndRetry));
    }

    #[test]
    fn execute_multi_result_serializes_client_metadata_only_when_present() {
        let success = serde_json::to_value(ExecuteMultiResult::from(empty_query_result(0))).unwrap();
        assert!(success.get("execution_error").is_none());
        assert!(success.get("statement_index").is_none());
        assert!(success.get("server_message").is_none());

        let mut error_column = empty_query_result(0);
        error_column.columns = vec!["Error".to_string()];
        error_column.rows = vec![vec![serde_json::json!("valid query value")]];
        let error_column = serde_json::to_value(ExecuteMultiResult::success_with_index(error_column, 0)).unwrap();
        assert!(error_column.get("execution_error").is_none());
        assert!(error_column.get("error").is_none());

        let failure = serde_json::to_value(ExecuteMultiResult::execution_error_with_index(
            error_query_result("failed".to_string()),
            2,
        ))
        .unwrap();
        assert_eq!(failure.get("execution_error"), Some(&serde_json::Value::Bool(true)));
        assert_eq!(failure.get("statement_index"), Some(&serde_json::json!(2)));
        assert_eq!(failure.get("columns"), Some(&serde_json::json!(["Error"])));
        assert_eq!(
            failure.get("error").and_then(|value| value.get("code")),
            Some(&serde_json::json!("DBX-LEGACY-0001"))
        );

        let redacted = serde_json::to_value(
            ExecuteMultiResult::execution_error_with_index(error_query_result("safe failure".to_string()), 2)
                .without_error_detail(),
        )
        .unwrap();
        assert!(redacted.get("error").and_then(|value| value.get("detail")).is_none());
    }

    #[test]
    fn sqlserver_batch_results_do_not_claim_statement_indexes() {
        assert_eq!(split_sql_batches("SELECT 1; SELECT 2;").len(), 1);

        let results = sqlserver_batch_results(vec![
            db::sqlserver::SqlServerBatchResult { result: empty_query_result(1), server_message: false },
            db::sqlserver::SqlServerBatchResult { result: empty_query_result(2), server_message: true },
        ]);

        assert_eq!(results.iter().map(|result| result.statement_index).collect::<Vec<_>>(), vec![None, None]);
        assert!(!results[0].server_message);
        assert!(results[1].server_message);

        let serialized = serde_json::to_value(&results[1]).unwrap();
        assert_eq!(serialized.get("server_message"), Some(&serde_json::Value::Bool(true)));
    }

    #[test]
    fn query_execution_error_preserves_structured_catalog_identity() {
        let error = QueryExecutionError::Agent(AgentCallError::Structured {
            rpc_code: -1,
            message: "connection lost".to_string(),
            context: crate::db::agent_driver::AgentErrorContext {
                contract_version: 1,
                category: crate::db::agent_driver::AgentErrorCategory::Connection,
                retryable: false,
                session_disposition: crate::db::agent_driver::AgentSessionDisposition::Quarantine,
                stage: AgentErrorStage::Execute,
                operation_outcome: AgentOperationOutcome::Unknown,
                agent_session_id: Some("session-1".to_string()),
                sql_state: None,
                vendor_code: None,
                exception_class: None,
            },
        });

        assert_eq!(error.into_backend_error().code(), "DBX-JDBC-1002");
    }

    #[test]
    fn duckdb_worker_error_preserves_catalog_identity_and_detail() {
        let error = QueryExecutionError::DuckDb {
            code: "duckdb_execute_failed".to_string(),
            message: "Catalog Error: Table missing_table does not exist".to_string(),
        };
        let backend_error = error.into_backend_error();

        assert_eq!(backend_error.code(), "DBX-JDBC-4001");
        assert_eq!(backend_error.detail(), Some("Catalog Error: Table missing_table does not exist"));
    }

    #[test]
    fn query_timeout_preserves_timeout_catalog_identity_and_detail() {
        let error = classify_query_error(
            Some(DatabaseType::Postgres),
            QueryExecutionError::Legacy("Query timed out after 1 seconds".to_string()),
        )
        .with_omitted_sql_context("SELECT pg_sleep(10)");
        let backend_error = error.into_backend_error();

        assert_eq!(backend_error.code(), "DBX-JDBC-2002");
        assert_eq!(
            backend_error.message_params().get("stage"),
            Some(&crate::backend_error::BackendMessageParam::String("execute".to_string()))
        );
        assert_eq!(
            backend_error.detail(),
            Some("Query timed out after 1 seconds\nSQL text omitted from user-facing error; enable debug SQL diagnostics to inspect the original statement.")
        );
    }

    #[test]
    fn postgres_server_error_preserves_sql_catalog_identity_and_detail() {
        let error = classify_query_error(
            Some(DatabaseType::Postgres),
            QueryExecutionError::Legacy("ERROR: relation \"dbx_table_that_does_not_exist\" does not exist".to_string()),
        )
        .with_omitted_sql_context("SELECT * FROM dbx_table_that_does_not_exist");
        let backend_error = error.into_backend_error();

        assert_eq!(backend_error.code(), "DBX-JDBC-4001");
        assert_eq!(
            backend_error.message_params().get("stage"),
            Some(&crate::backend_error::BackendMessageParam::String("execute".to_string()))
        );
        assert_eq!(
            backend_error.detail(),
            Some(
                "ERROR: relation \"dbx_table_that_does_not_exist\" does not exist\nSQL text omitted from user-facing error; enable debug SQL diagnostics to inspect the original statement."
            )
        );
    }

    #[test]
    fn mysql_server_error_preserves_sql_catalog_identity_and_detail() {
        let error = classify_query_error(
            Some(DatabaseType::Mysql),
            QueryExecutionError::Legacy(
                "Server error: `ERROR 1064 (42000): You have an error in your SQL syntax`".to_string(),
            ),
        )
        .with_omitted_sql_context("SELECT 111 AS first_value FROM DUAL");
        let backend_error = error.into_backend_error();

        assert_eq!(backend_error.code(), "DBX-JDBC-4001");
        assert_eq!(backend_error.message_key(), "backendErrors.jdbc.sqlFailed");
        assert_eq!(
            backend_error.message_params().get("stage"),
            Some(&crate::backend_error::BackendMessageParam::String("execute".to_string()))
        );
        assert_eq!(
            backend_error.detail(),
            Some(
                "Server error: `ERROR 1064 (42000): You have an error in your SQL syntax` SQL text omitted from user-facing error; enable debug SQL diagnostics to inspect the original statement."
            )
        );
    }

    #[test]
    fn single_statement_multi_result_preserves_sql_error_type() {
        let error = classify_query_error(
            Some(DatabaseType::Postgres),
            QueryExecutionError::Legacy("ERROR: relation \"dbx_table_that_does_not_exist\" does not exist".to_string()),
        )
        .with_omitted_sql_context("SELECT * FROM dbx_table_that_does_not_exist");

        let error = single_statement_multi_result(Err(error)).unwrap_err();
        let backend_error = error.into_backend_error();

        assert_eq!(backend_error.code(), "DBX-JDBC-4001");
        assert_eq!(backend_error.message_key(), "backendErrors.jdbc.sqlFailed");
        assert_eq!(
            backend_error.detail(),
            Some(
                "ERROR: relation \"dbx_table_that_does_not_exist\" does not exist\nSQL text omitted from user-facing error; enable debug SQL diagnostics to inspect the original statement."
            )
        );
    }

    #[test]
    fn postgres_transaction_statement_error_preserves_sql_catalog_identity() {
        let error = postgres_transaction_statement_error(
            1,
            "ERROR: relation \"dbx_table_that_does_not_exist\" does not exist",
            "SELECT * FROM dbx_table_that_does_not_exist",
            true,
        );
        let backend_error = error.into_backend_error();

        assert_eq!(backend_error.code(), "DBX-JDBC-4001");
        assert_eq!(backend_error.message_key(), "backendErrors.jdbc.sqlFailed");
        assert_eq!(
            backend_error.detail(),
            Some(
                "Statement 1 failed: ERROR: relation \"dbx_table_that_does_not_exist\" does not exist\nSQL text omitted from user-facing error; enable debug SQL diagnostics to inspect the original statement."
            )
        );
    }

    #[test]
    fn postgres_transaction_uses_driver_fact_not_error_wording() {
        let error = postgres_transaction_statement_error(
            1,
            "ERROR: relation \"connection_closed\" does not exist",
            "SELECT * FROM connection_closed",
            true,
        );

        assert_eq!(error.into_backend_error().code(), "DBX-JDBC-4001");
    }

    #[test]
    fn sequential_multi_cancellation_uses_canceled_catalog() {
        let backend_error = canceled_query_execution_error().into_backend_error();

        assert_eq!(backend_error.code(), "DBX-JDBC-2003");
        assert_eq!(backend_error.message_key(), "backendErrors.jdbc.operationCanceled");
    }

    #[test]
    fn external_driver_method_unsupported_detects_legacy_plugin_errors() {
        assert!(is_external_driver_method_unsupported(
            "Unsupported JDBC plugin method: executeQueryPage",
            "executeQueryPage"
        ));
        assert!(is_external_driver_method_unsupported(
            "Plugin RPC error (-32601): Method not found: executeQueryPage",
            "executeQueryPage"
        ));
        assert!(is_external_driver_method_unsupported("Unknown method executeQueryPage", "executeQueryPage"));
    }

    #[test]
    fn external_driver_method_unsupported_ignores_query_and_other_method_errors() {
        assert!(!is_external_driver_method_unsupported(
            "The JDBC driver does not support this SQL operation",
            "executeQueryPage"
        ));
        assert!(!is_external_driver_method_unsupported(
            "Unsupported JDBC plugin method: listTables",
            "executeQueryPage"
        ));
        assert!(!is_external_driver_method_unsupported(
            "Unknown column executeQueryPage in field list",
            "executeQueryPage"
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn external_driver_query_page_falls_back_to_legacy_execute_query() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("dbx-legacy-jdbc-plugin-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let executable = dir.join("plugin.sh");
        let calls = dir.join("calls.log");
        std::fs::write(
            &executable,
            format!(
                "#!/bin/sh\nwhile IFS= read -r line; do\n  id=$(printf '%s' \"$line\" | sed -E 's/.*\"id\":([0-9]+).*/\\1/')\n  case \"$line\" in\n    *'\"method\":\"executeQueryPage\"'*)\n      echo executeQueryPage >> '{}'\n      printf '{{\"id\":%s,\"error\":{{\"message\":\"Unsupported JDBC plugin method: executeQueryPage\"}}}}\\n' \"$id\"\n      ;;\n    *'\"method\":\"executeQuery\"'*)\n      echo executeQuery >> '{}'\n      printf '{{\"id\":%s,\"result\":{{\"columns\":[\"value\"],\"rows\":[[42]],\"affected_rows\":0,\"execution_time_ms\":1,\"truncated\":false}}}}\\n' \"$id\"\n      ;;\n  esac\ndone\n",
                calls.display(),
                calls.display()
            ),
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&executable, permissions).unwrap();

        let plugin = InstalledPlugin {
            manifest: PluginManifest {
                id: "jdbc".to_string(),
                name: "JDBC".to_string(),
                version: "legacy".to_string(),
                protocol_version: 1,
                description: String::new(),
                executable: Some("plugin.sh".to_string()),
                drivers: vec![PluginDriverManifest {
                    id: "jdbc".to_string(),
                    label: "JDBC".to_string(),
                    kind: "external".to_string(),
                    database_type: Some("jdbc".to_string()),
                }],
            },
            path: dir.clone(),
        };
        let session = PluginDriverSession::start_for_test(plugin, "jdbc".to_string(), PluginRuntimeEnv::default())
            .await
            .expect("legacy plugin should start");

        let result = invoke_external_driver_query_page(
            &session,
            serde_json::json!({ "sql": "SELECT 42", "pageSize": 100 }),
            Some(Duration::from_secs(5)),
        )
        .await
        .expect("legacy executeQuery fallback should succeed");

        assert_eq!(result.columns, vec!["value"]);
        assert_eq!(result.rows, vec![vec![serde_json::json!(42)]]);
        assert_eq!(std::fs::read_to_string(&calls).unwrap(), "executeQueryPage\nexecuteQuery\n");

        session.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn external_driver_query_page_does_not_retry_jdbc_errors() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("dbx-jdbc-query-error-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let executable = dir.join("plugin.sh");
        let calls = dir.join("calls.log");
        std::fs::write(
            &executable,
            format!(
                "#!/bin/sh\nwhile IFS= read -r line; do\n  id=$(printf '%s' \"$line\" | sed -E 's/.*\"id\":([0-9]+).*/\\1/')\n  echo request >> '{}'\n  printf '{{\"id\":%s,\"error\":{{\"message\":\"Incorrect syntax near SELECT\"}}}}\\n' \"$id\"\ndone\n",
                calls.display()
            ),
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&executable, permissions).unwrap();

        let plugin = InstalledPlugin {
            manifest: PluginManifest {
                id: "jdbc".to_string(),
                name: "JDBC".to_string(),
                version: "current".to_string(),
                protocol_version: 1,
                description: String::new(),
                executable: Some("plugin.sh".to_string()),
                drivers: vec![PluginDriverManifest {
                    id: "jdbc".to_string(),
                    label: "JDBC".to_string(),
                    kind: "external".to_string(),
                    database_type: Some("jdbc".to_string()),
                }],
            },
            path: dir.clone(),
        };
        let session = PluginDriverSession::start_for_test(plugin, "jdbc".to_string(), PluginRuntimeEnv::default())
            .await
            .expect("plugin should start");

        let error = invoke_external_driver_query_page(
            &session,
            serde_json::json!({ "sql": "SELECT broken", "pageSize": 100 }),
            Some(Duration::from_secs(5)),
        )
        .await
        .expect_err("JDBC query errors must be returned without retrying");

        assert_eq!(error, "Incorrect syntax near SELECT");
        assert_eq!(std::fs::read_to_string(&calls).unwrap(), "request\n");

        session.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn oceanbase_mysql_session_timeout_sql_uses_connection_timeout_by_default() {
        let mut config = test_connection_config(DatabaseType::Mysql);
        config.driver_profile = Some("oceanbase".to_string());
        config.query_timeout_secs = 300_000;

        assert_eq!(
            oceanbase_mysql_session_timeout_sql(Some(&config), None),
            Some("SET ob_query_timeout = 300000000000".to_string())
        );
    }

    #[test]
    fn oceanbase_mysql_session_timeout_sql_prefers_execution_timeout_override() {
        let mut config = test_connection_config(DatabaseType::Mysql);
        config.driver_profile = Some("oceanbase".to_string());
        config.query_timeout_secs = 30;

        assert_eq!(
            oceanbase_mysql_session_timeout_sql(Some(&config), Some(600)),
            Some("SET ob_query_timeout = 600000000".to_string())
        );
    }

    #[test]
    fn oceanbase_mysql_session_timeout_sql_skips_plain_mysql() {
        let config = test_connection_config(DatabaseType::Mysql);

        assert_eq!(oceanbase_mysql_session_timeout_sql(Some(&config), Some(600)), None);
    }

    #[tokio::test]
    async fn wait_for_query_returns_cancelled_when_token_is_cancelled() {
        let token = CancellationToken::new();
        token.cancel();

        let result = wait_for_query(Some(token), async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok(db::QueryResult {
                columns: vec![],
                column_types: Vec::new(),
                column_sortables: vec![],
                spatial_columns: vec![],
                spatial_values: vec![],
                rows: vec![],
                affected_rows: 0,
                execution_time_ms: 0,
                truncated: false,
                session_id: None,
                has_more: false,
                elasticsearch_raw_body: None,
            })
        })
        .await;

        assert_eq!(result.unwrap_err(), QUERY_CANCELED);
    }

    #[tokio::test]
    async fn wait_for_query_without_token_still_times_out() {
        let result = wait_for_query_with_timeout(None, Duration::from_millis(10), async {
            tokio::time::sleep(Duration::from_secs(1)).await;
            Ok(db::QueryResult {
                columns: vec![],
                column_types: Vec::new(),
                column_sortables: vec![],
                spatial_columns: vec![],
                spatial_values: vec![],
                rows: vec![],
                affected_rows: 0,
                execution_time_ms: 0,
                truncated: false,
                session_id: None,
                has_more: false,
                elasticsearch_raw_body: None,
            })
        })
        .await;

        assert_eq!(result.unwrap_err(), timeout_error_for(Duration::from_millis(10)));
    }

    #[tokio::test]
    async fn wait_for_value_opt_times_out_while_waiting_for_lock() {
        let lock = tokio::sync::Mutex::new(());
        let _guard = lock.lock().await;

        let result = wait_for_value_opt(None, Some(Duration::from_millis(10)), lock.lock()).await;

        assert_eq!(result.unwrap_err(), timeout_error_for(Duration::from_millis(10)));
    }

    #[tokio::test]
    async fn wait_for_value_opt_can_cancel_while_waiting_for_lock() {
        let lock = tokio::sync::Mutex::new(());
        let _guard = lock.lock().await;
        let token = CancellationToken::new();
        token.cancel();

        let result = wait_for_value_opt(Some(token), Some(Duration::from_secs(30)), lock.lock()).await;

        assert_eq!(result.unwrap_err(), QUERY_CANCELED);
    }

    #[test]
    fn db_operation_budget_from_config() {
        let budget = DbOperationBudget::from_config(10, Some(30));
        assert_eq!(budget.checkout_timeout, Duration::from_secs(10));
        assert_eq!(budget.connect_timeout, Duration::from_secs(10));
        assert_eq!(budget.recycle_timeout, Duration::from_secs(10));
        assert_eq!(budget.query_timeout, Some(Duration::from_secs(30)));
        assert_eq!(budget.cancel_timeout, Duration::from_secs(5));
        assert_eq!(budget.cleanup_timeout, Duration::from_secs(3));
    }

    #[test]
    fn db_operation_budget_from_connection_config_uses_connection_settings() {
        let mut config = test_connection_config(DatabaseType::Postgres);
        config.connect_timeout_secs = 12;
        config.query_timeout_secs = 0;

        let budget = DbOperationBudget::from_connection_config(&config);

        assert_eq!(budget.checkout_timeout, Duration::from_secs(12));
        assert_eq!(budget.connect_timeout, Duration::from_secs(12));
        assert_eq!(budget.recycle_timeout, Duration::from_secs(12));
        assert_eq!(budget.query_timeout, None);
        assert_eq!(budget.cancel_timeout, Duration::from_secs(5));
        assert_eq!(budget.cleanup_timeout, Duration::from_secs(3));
    }

    #[test]
    fn db_operation_budget_query_timeout_zero_means_no_limit() {
        let budget = DbOperationBudget::from_config(10, Some(0));
        assert_eq!(budget.query_timeout, None);
        // Infrastructure timeouts still have hard limits
        assert_eq!(budget.checkout_timeout, Duration::from_secs(10));
        assert_eq!(budget.cancel_timeout, Duration::from_secs(5));
    }

    #[test]
    fn db_operation_budget_query_timeout_zero_keeps_transaction_infra_limits() {
        let mut config = test_connection_config(DatabaseType::Mysql);
        config.connect_timeout_secs = 7;
        config.query_timeout_secs = 0;

        let budget = DbOperationBudget::from_connection_config(&config);

        assert_eq!(budget.query_timeout, None);
        assert_eq!(budget.checkout_timeout, Duration::from_secs(7));
        assert_eq!(budget.recycle_timeout, Duration::from_secs(7));
        assert_eq!(budget.cleanup_timeout, Duration::from_secs(3));
    }

    #[test]
    fn db_operation_budget_clamps_infra_timeout() {
        let budget = DbOperationBudget::from_config(0, Some(30));
        assert_eq!(budget.checkout_timeout, Duration::from_secs(1)); // clamped to min 1s
        let budget = DbOperationBudget::from_config(600, Some(30));
        assert_eq!(budget.checkout_timeout, Duration::from_secs(300)); // clamped to max 300s
    }

    #[test]
    fn db_operation_budget_with_defaults() {
        let budget = DbOperationBudget::with_defaults();
        assert_eq!(budget.checkout_timeout, db::connection_timeout());
        assert_eq!(budget.query_timeout, Some(QUERY_TIMEOUT));
    }

    #[test]
    fn is_connection_error_detects_english_messages() {
        assert!(is_connection_error("connection reset"));
        assert!(is_connection_error("broken pipe"));
        assert!(is_connection_error("reset by peer"));
        assert!(is_connection_error("Connection timed out"));
        assert!(is_connection_error("socket closed"));
        assert!(is_connection_error("unexpected eof"));
        assert!(is_connection_error("Error occurred while creating a new object: error communicating with the server"));
    }

    #[test]
    fn query_error_context_omits_raw_sql_and_is_not_duplicated() {
        let sql = "select 'secret-123' as token";
        let error = query_error_with_omitted_sql_context("driver rejected statement", sql);

        assert!(error.contains("driver rejected statement"));
        assert!(error.contains(SQL_OMITTED_ERROR_CONTEXT));
        assert!(!error.contains("secret-123"));
        assert!(!error.contains("SQL:"));

        let repeated = query_error_with_omitted_sql_context(&error, sql);
        assert_eq!(repeated.matches(SQL_OMITTED_ERROR_CONTEXT).count(), 1);
    }

    #[test]
    fn typed_sql_error_context_keeps_driver_text_on_one_line() {
        let error = QueryExecutionError::Sql("Server error: `ERROR 1064 (42000): syntax error`".to_string())
            .with_omitted_sql_context("SELECT * FROM users")
            .into_backend_error();

        assert_eq!(
            error.detail(),
            Some("Server error: `ERROR 1064 (42000): syntax error` SQL text omitted from user-facing error; enable debug SQL diagnostics to inspect the original statement.")
        );
    }

    #[test]
    fn reconnect_retry_error_context_omits_raw_sql() {
        let sql = "select 'secret-123' as token";
        let reconnect_error = query_error_with_omitted_sql_context("connection reset after reconnect", sql);

        assert!(reconnect_error.contains("connection reset after reconnect"));
        assert!(reconnect_error.contains(SQL_OMITTED_ERROR_CONTEXT));
        assert!(!reconnect_error.contains("secret-123"));
    }

    #[test]
    fn execute_statements_error_omits_raw_sql() {
        let sql = "select 'secret-token' as t";
        let err = query_error_with_omitted_sql_context(
            &format!(
                "Statement {} failed: {}. Previous {} statement(s) may have been committed.",
                2, "driver error", 1
            ),
            sql,
        );

        assert!(err.contains("driver error"));
        assert!(err.contains(SQL_OMITTED_ERROR_CONTEXT));
        assert!(!err.contains("secret-token"));
        assert!(!err.contains("SQL:"));
        assert!(err.contains("Statement 2 failed:"));
    }

    #[test]
    fn batch_transaction_error_omits_raw_sql() {
        let sql = "delete from users where id = 'secret-id'";
        let err = query_error_with_omitted_sql_context(
            &format!("Statement {} failed: {}. No transaction support for this database type.", 3, "batch error"),
            sql,
        );

        assert!(err.contains("batch error"));
        assert!(err.contains(SQL_OMITTED_ERROR_CONTEXT));
        assert!(!err.contains("secret-id"));
        assert!(err.contains("Statement 3 failed:"));
    }

    #[test]
    fn is_connection_error_detects_oracle_idle_timeout() {
        assert!(is_connection_error("ORA-02396: exceeded maximum idle time, please connect again"));
        assert!(is_connection_error(
            "Agent RPC error (-32603): ORA-02396: exceeded maximum idle time, please connect again"
        ));
        assert!(is_connection_error("ORA-03113: end-of-file on communication channel"));
        assert!(is_connection_error("ORA-03114: not connected to Oracle"));
        assert!(is_connection_error("ORA-03135: connection lost contact"));
        assert!(is_connection_error("Agent RPC error (-1): java.sql.SQLRecoverableException: 关闭的连接"));
        assert!(is_connection_error("java.sql.SQLRecoverableException: 连接已关闭"));
    }

    #[test]
    fn is_connection_error_detects_localized_io_errors() {
        assert!(is_connection_error("I/O error: 远程主机强迫关闭了一个现有的连接。 (os error 10054)"));
        assert!(is_connection_error(
            "I/O error: 由于连接方在一段时间后没有正确答复或连接的主机没有反应，连接尝试失败。 (os error 10060)"
        ));
        assert!(is_connection_error("Agent RPC error (-1): dm.jdbc.driver.DMException: 网络通信异常"));
        assert!(is_connection_error(
            "Agent RPC error (-1): java.sql.SQLRecoverableException: IO 错误: Got minus one from a read call"
        ));
        assert!(is_connection_error(
            "Agent RPC error (-1): com.mysql.cj.jdbc.exceptions.CommunicationsException: Communications link failure"
        ));
    }

    #[test]
    fn is_connection_error_detects_os_error_codes() {
        assert!(is_connection_error("os error 10053"));
        assert!(is_connection_error("os error 10054"));
        assert!(is_connection_error("os error 10060"));
        assert!(is_connection_error("os error 10061"));
    }

    #[test]
    fn is_connection_error_rejects_non_connection_errors() {
        assert!(!is_connection_error("Query timed out after 30 seconds"));
        assert!(!is_connection_error("ORA-00942: table or view does not exist"));
        assert!(!is_connection_error("syntax error at position 5"));
        assert!(!is_connection_error("os error 13"));
    }

    #[test]
    fn is_connection_error_detects_deadpool_pool_timeouts() {
        // deadpool-postgres PoolError::Timeout messages (contain "pool" + "timeout" but not "timed out")
        assert!(is_connection_error("pool wait timeout"));
        assert!(is_connection_error("pool create timeout"));
        assert!(is_connection_error("pool recycle timeout"));
        // checkout helper timeout messages
        assert!(is_connection_error("PostgreSQL connection pool checkout timed out (5s)"));
        assert!(is_connection_error("MySQL get connection timed out"));
        assert!(is_connection_error("MySQL ping timed out"));
        assert!(is_connection_error("MySQL kill connection checkout timed out"));
        assert!(is_connection_error("MySQL KILL QUERY timed out"));
    }

    #[test]
    fn pool_error_action_discards_sqlserver_driver_panic_without_retry() {
        let err = format!("{} the current client will be rebuilt.", db::sqlserver::SQLSERVER_DRIVER_PANIC_ERROR_PREFIX);

        assert_eq!(pool_error_action(Some(DatabaseType::SqlServer), &err), PoolErrorAction::Discard);
        assert!(should_discard_pool_after_error(Some(DatabaseType::SqlServer), &err));
        assert!(!is_connection_error(&err));
    }

    #[test]
    fn pool_error_action_discards_sqlserver_timeout_without_retry() {
        let err = "Query timed out after 30 seconds";

        assert_eq!(pool_error_action(Some(DatabaseType::SqlServer), err), PoolErrorAction::Discard);
        assert_eq!(pool_error_action(Some(DatabaseType::Mysql), err), PoolErrorAction::Discard);
        assert_eq!(pool_error_action(Some(DatabaseType::Postgres), err), PoolErrorAction::Discard);
        assert_eq!(pool_error_action(Some(DatabaseType::ClickHouse), err), PoolErrorAction::Discard);
        assert_eq!(pool_error_action(Some(DatabaseType::Oracle), err), PoolErrorAction::Discard);
        assert_eq!(pool_error_action(Some(DatabaseType::Sqlite), err), PoolErrorAction::Keep);
        assert_eq!(pool_error_action(Some(DatabaseType::DuckDb), err), PoolErrorAction::Keep);
    }

    #[test]
    fn pool_error_action_discards_schema_reset_cleanup_without_retry() {
        let err = "PostgreSQL schema.reset cleanup failed: PostgreSQL schema.reset timed out after 3 seconds";

        assert_eq!(pool_error_action(Some(DatabaseType::Postgres), err), PoolErrorAction::Discard);
        assert_eq!(pool_error_action(Some(DatabaseType::OpenGauss), err), PoolErrorAction::Discard);
        assert!(should_discard_pool_after_error(Some(DatabaseType::Postgres), err));
    }

    #[test]
    fn pool_error_action_discards_postgres_read_only_transaction_cleanup_without_retry() {
        let err = "PostgreSQL read-only transaction cleanup failed: PostgreSQL explain_analyze.rollback timed out after 3 seconds";

        assert_eq!(pool_error_action(Some(DatabaseType::Postgres), err), PoolErrorAction::Discard);
        assert!(should_discard_pool_after_error(Some(DatabaseType::Postgres), err));
    }

    #[test]
    fn pool_error_action_reconnects_non_agent_errors_but_never_replays_agent_operations() {
        let err = "connection reset by peer";

        assert_eq!(pool_error_action(Some(DatabaseType::SqlServer), err), PoolErrorAction::ReconnectAndRetry);
        assert_eq!(pool_error_action(Some(DatabaseType::Postgres), err), PoolErrorAction::ReconnectAndRetry);

        let dameng_err = "Agent RPC error (-1): dm.jdbc.driver.DMException: 网络通信异常";
        assert_eq!(pool_error_action(Some(DatabaseType::Dameng), dameng_err), PoolErrorAction::Discard);
    }

    #[test]
    fn external_driver_query_params_include_database_and_schema_context() {
        let config = ConnectionConfig {
            id: "jdbc-1".to_string(),
            name: "JDBC".to_string(),
            note: String::new(),
            db_type: DatabaseType::Jdbc,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            agent_java_options: Vec::new(),
            host: "localhost".to_string(),
            port: 0,
            username: String::new(),
            password: String::new(),
            database: None,
            visible_databases: None,
            visible_schemas: None,
            show_system_schemas: false,
            attached_databases: Vec::new(),
            init_script: None,
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: 5,
            query_timeout_secs: 30,
            idle_timeout_secs: 60,
            keepalive_interval_secs: 0,
            ssl: false,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            sysdba: false,
            oracle_connection_type: None,
            connection_string: Some("jdbc:h2:mem:test".to_string()),
            redis_connection_mode: None,
            redis_sentinel_master: String::new(),
            redis_sentinel_nodes: String::new(),
            redis_sentinel_username: String::new(),
            redis_sentinel_password: String::new(),
            redis_sentinel_tls: false,
            redis_cluster_nodes: String::new(),
            redis_key_separator: default_redis_key_separator(),
            redis_scan_page_size: None,
            redis_database_aliases: Default::default(),
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: false,
            is_production: false,
            production_databases: vec![],
            database_info: None,
        };

        let params = external_driver_query_params(
            &config,
            "SELECT * FROM events",
            "analytics",
            Some("app"),
            &QueryExecutionOptions {
                max_rows: Some(500),
                fetch_size: Some(250),
                timeout_secs: Some(600),
                ..Default::default()
            },
        );

        assert_eq!(params["connection"]["id"], "jdbc-1");
        assert_eq!(params["sql"], "SELECT * FROM events");
        assert_eq!(params["database"], "analytics");
        assert_eq!(params["schema"], "app");
        assert_eq!(params["maxRows"], 500);
        assert_eq!(params["fetchSize"], 250);
        assert_eq!(params["timeoutSecs"], 600);
    }

    #[test]
    fn agent_execute_query_params_include_row_and_fetch_limits() {
        let params = agent_execute_query_params(
            "SELECT * FROM events",
            Some("analytics"),
            Some("app"),
            QueryExecutionOptions {
                max_rows: Some(500),
                fetch_size: Some(250),
                timeout_secs: Some(600),
                ..Default::default()
            },
        );

        assert_eq!(params["sql"], "SELECT * FROM events");
        assert_eq!(params["database"], "analytics");
        assert_eq!(params["schema"], "app");
        assert_eq!(params["maxRows"], 500);
        assert_eq!(params["fetchSize"], 250);
        assert_eq!(params["timeoutSecs"], 600);
    }

    #[test]
    fn iris_execution_context_omits_schema() {
        assert_eq!(schema_for_execution_context(Some(DatabaseType::Iris), Some("SQLUser")), None);
        assert_eq!(schema_for_execution_context(Some(DatabaseType::Oracle), Some("APP")), Some("APP"));
        assert_eq!(schema_for_execution_context(None, Some("APP")), Some("APP"));
    }

    #[test]
    fn iris_execution_context_qualifies_unqualified_dml_tables() {
        assert_eq!(
            sql_for_execution_context(Some(DatabaseType::Iris), "SELECT * FROM TABLES", Some("INFORMATION_SCHEMA")),
            "SELECT * FROM \"INFORMATION_SCHEMA\".TABLES"
        );
        let qualified_join = sql_for_execution_context(
            Some(DatabaseType::Iris),
            "SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id",
            Some("Sales"),
        );
        assert!(qualified_join.contains("FROM \"Sales\".orders"));
        assert!(qualified_join.contains("JOIN \"Sales\".customers"));
        assert!(qualified_join.contains("c.id = o.customer_id"));
        assert_eq!(
            sql_for_execution_context(Some(DatabaseType::Iris), "SELECT * FROM INFORMATION_SCHEMA.TABLES", Some("APP")),
            "SELECT * FROM INFORMATION_SCHEMA.TABLES"
        );
    }

    #[test]
    fn iris_execution_context_qualifies_nested_dml_tables_but_not_ctes() {
        assert_eq!(
            sql_for_execution_context(
                Some(DatabaseType::Iris),
                "WITH recent AS (SELECT * FROM events) SELECT * FROM recent WHERE EXISTS (SELECT 1 FROM audits)",
                Some("APP")
            ),
            "WITH recent AS (SELECT * FROM \"APP\".events) SELECT * FROM recent WHERE EXISTS (SELECT 1 FROM \"APP\".audits)"
        );
        assert_eq!(
            sql_for_execution_context(
                Some(DatabaseType::Iris),
                "INSERT INTO events SELECT * FROM staging_events",
                Some("APP")
            ),
            "INSERT INTO \"APP\".events SELECT * FROM \"APP\".staging_events"
        );
        assert_eq!(
            sql_for_execution_context(
                Some(DatabaseType::Iris),
                "UPDATE events SET status = 'done' WHERE id IN (SELECT event_id FROM audit_events)",
                Some("APP")
            ),
            "UPDATE \"APP\".events SET status = 'done' WHERE id IN (SELECT event_id FROM \"APP\".audit_events)"
        );
    }

    #[test]
    fn iris_execution_context_leaves_ddl_and_unparseable_sql_unchanged() {
        assert_eq!(
            sql_for_execution_context(Some(DatabaseType::Iris), "CREATE TABLE events (id INT)", Some("APP")),
            "CREATE TABLE events (id INT)"
        );
        assert_eq!(
            sql_for_execution_context(Some(DatabaseType::Iris), "SELECT %ID FROM", Some("APP")),
            "SELECT %ID FROM"
        );
        assert_eq!(
            sql_for_execution_context(Some(DatabaseType::Postgres), "SELECT * FROM events", Some("APP")),
            "SELECT * FROM events"
        );
    }

    #[test]
    fn kingbase_execution_context_qualifies_only_unqualified_relations() {
        assert_eq!(
            sql_for_execution_context(Some(DatabaseType::Kingbase), "SELECT * FROM sys_user", Some("app")),
            "SELECT * FROM \"app\".sys_user"
        );
        assert_eq!(
            sql_for_execution_context(Some(DatabaseType::Kingbase), "SELECT * FROM other_schema.sys_user", Some("app")),
            "SELECT * FROM other_schema.sys_user"
        );

        let mixed = sql_for_execution_context(
            Some(DatabaseType::Kingbase),
            "SELECT pg_typeof(u.id) FROM generate_series(1, 2) AS n JOIN sys_user u ON true",
            Some("app"),
        );
        assert!(mixed.contains("FROM generate_series(1, 2) AS n"), "{mixed}");
        assert!(mixed.contains("JOIN \"app\".sys_user u"), "{mixed}");
        assert!(mixed.contains("pg_typeof(u.id)"), "{mixed}");
    }

    #[test]
    fn kingbase_execution_context_preserves_ctes_functions_types_and_unsupported_sql() {
        assert_eq!(
            sql_for_execution_context(
                Some(DatabaseType::Kingbase),
                "WITH current_user AS (SELECT * FROM sys_user) SELECT * FROM current_user",
                Some("APP")
            ),
            "WITH current_user AS (SELECT * FROM \"APP\".sys_user) SELECT * FROM current_user"
        );
        assert_eq!(
            sql_for_execution_context(
                Some(DatabaseType::Kingbase),
                "SELECT pg_typeof(1::int), current_user",
                Some("APP")
            ),
            "SELECT pg_typeof(1::int), current_user"
        );
        assert_eq!(
            sql_for_execution_context(Some(DatabaseType::Kingbase), "CREATE TABLE sys_user (id INT)", Some("APP")),
            "CREATE TABLE sys_user (id INT)"
        );
        assert_eq!(
            sql_for_execution_context(Some(DatabaseType::Kingbase), "SELECT * FROM", Some("APP")),
            "SELECT * FROM"
        );
    }

    #[test]
    fn parses_postgres_drop_database_target() {
        assert_eq!(parse_drop_database_target("DROP DATABASE vaultwarden;"), Some("vaultwarden".to_string()));
        assert_eq!(parse_drop_database_target("drop database if exists \"app db\";"), Some("app db".to_string()));
        assert_eq!(
            parse_drop_database_target("/*x*/ DROP DATABASE \"app\"\"db\" -- trailing\n;"),
            Some("app\"db".to_string())
        );
    }

    #[test]
    fn ignores_non_single_drop_database_statements() {
        assert_eq!(parse_drop_database_target("DROP TABLE vaultwarden;"), None);
        assert_eq!(parse_drop_database_target("DROP DATABASE vaultwarden; SELECT 1;"), None);
        assert_eq!(parse_drop_database_target("DROP DATABASE 123bad;"), None);
    }

    #[test]
    fn chooses_safe_postgres_drop_database_admin_database() {
        assert_eq!(postgres_drop_database_admin_database("vaultwarden"), "postgres");
        assert_eq!(postgres_drop_database_admin_database("postgres"), "template1");
    }

    #[test]
    fn agent_execute_query_params_default_to_safety_row_limit() {
        let params = agent_execute_query_params("SELECT * FROM events", None, None, QueryExecutionOptions::default());

        assert_eq!(params["sql"], "SELECT * FROM events");
        assert!(params.get("database").is_none());
        assert!(params.get("schema").is_none());
        assert_eq!(params["maxRows"], MAX_ROWS);
        assert!(params.get("fetchSize").is_none());
        assert!(params.get("timeoutSecs").is_none());
    }

    #[test]
    fn agent_execute_query_page_params_include_page_fetch_and_safety_limits() {
        let params = agent_execute_query_page_params(
            "SELECT * FROM events",
            Some("analytics"),
            Some("app"),
            QueryExecutionOptions {
                page_size: Some(500),
                fetch_size: Some(250),
                timeout_secs: Some(600),
                ..Default::default()
            },
        );

        assert_eq!(params["sql"], "SELECT * FROM events");
        assert_eq!(params["database"], "analytics");
        assert_eq!(params["schema"], "app");
        assert_eq!(params["pageSize"], 500);
        assert_eq!(params["fetchSize"], 250);
        assert_eq!(params["timeoutSecs"], 600);
        assert_eq!(params["maxRows"], MAX_ROWS);
    }

    #[test]
    fn agent_fetch_query_page_params_include_session_and_page_size() {
        let params = agent_fetch_query_page_params("session-1", 500);

        assert_eq!(params["sessionId"], "session-1");
        assert_eq!(params["pageSize"], 500);
    }

    #[test]
    fn agent_close_query_session_params_include_session() {
        let params = agent_close_query_session_params("session-1");

        assert_eq!(params["sessionId"], "session-1");
    }

    #[test]
    fn multi_statement_execution_does_not_retain_query_cursors() {
        let options = QueryExecutionOptions {
            max_rows: Some(100_000),
            fetch_size: Some(100),
            page_size: Some(100),
            timeout_secs: Some(30),
            ..Default::default()
        };

        let adjusted = options_for_sequential_statements(&options, 2, Some(DatabaseType::Kingbase));

        assert_eq!(adjusted.page_size, None);
        assert_eq!(adjusted.max_rows, Some(100));
        assert_eq!(adjusted.fetch_size, Some(100));
        assert_eq!(adjusted.timeout_secs, Some(30));
    }

    #[test]
    fn multi_statement_execution_preserves_smaller_row_limit() {
        let options = QueryExecutionOptions { max_rows: Some(25), page_size: Some(100), ..Default::default() };

        let adjusted = options_for_sequential_statements(&options, 2, Some(DatabaseType::Kingbase));

        assert_eq!(adjusted.page_size, None);
        assert_eq!(adjusted.max_rows, Some(25));
    }

    #[test]
    fn single_statement_and_existing_cursor_execution_keep_paging_options() {
        let first_page = QueryExecutionOptions { max_rows: Some(100_000), page_size: Some(100), ..Default::default() };
        let next_page = QueryExecutionOptions {
            max_rows: Some(100_000),
            page_size: Some(100),
            result_session_id: Some("session-1".to_string()),
            ..Default::default()
        };

        let single = options_for_sequential_statements(&first_page, 1, Some(DatabaseType::Kingbase));
        let existing_cursor = options_for_sequential_statements(&next_page, 2, Some(DatabaseType::Kingbase));

        assert_eq!(single.page_size, Some(100));
        assert_eq!(single.max_rows, Some(100_000));
        assert_eq!(existing_cursor.page_size, Some(100));
        assert_eq!(existing_cursor.result_session_id.as_deref(), Some("session-1"));
    }

    #[test]
    fn other_databases_keep_multi_statement_cursor_options() {
        let options = QueryExecutionOptions { max_rows: Some(100_000), page_size: Some(100), ..Default::default() };

        let adjusted = options_for_sequential_statements(&options, 2, Some(DatabaseType::Oracle));

        assert_eq!(adjusted.page_size, Some(100));
        assert_eq!(adjusted.max_rows, Some(100_000));
    }

    #[test]
    fn agent_timeout_discards_pool_but_does_not_retry_same_query() {
        assert!(should_discard_agent_pool_after_error("Query timed out after 30 seconds"));
        assert!(should_discard_agent_pool_after_error("Agent RPC call timed out (30s)"));
        assert!(!is_connection_error("Agent RPC call timed out (30s)"));
        assert_eq!(
            pool_error_action(Some(DatabaseType::Oracle), "Agent RPC call timed out (30s)"),
            PoolErrorAction::Discard
        );
    }

    #[test]
    fn structured_agent_disposition_controls_pool_recovery() {
        let quarantined = "Agent RPC error (-1): lost\nDBX_AGENT_ERROR_DATA:{\"category\":\"connection\",\"sessionDisposition\":\"quarantine\"}";
        let replace_runtime = "Agent RPC error (-1): saturated\nDBX_AGENT_ERROR_DATA:{\"category\":\"resource\",\"sessionDisposition\":\"replace_runtime\"}";

        assert!(should_discard_agent_pool_after_error(quarantined));
        assert!(should_discard_agent_pool_after_error(replace_runtime));
        assert_eq!(pool_error_action(Some(DatabaseType::Oracle), quarantined), PoolErrorAction::Discard);
        assert_eq!(pool_error_action(Some(DatabaseType::Oracle), replace_runtime), PoolErrorAction::Discard);
    }

    #[test]
    fn unavailable_agent_pipes_discard_without_replaying_user_operations() {
        assert!(should_discard_agent_pool_after_error("Agent stdin not available"));
        assert!(should_discard_agent_pool_after_error("Agent stdout not available"));
        assert!(is_connection_error("Agent stdin not available"));
        assert!(is_connection_error("Agent stdout not available"));
        assert!(is_connection_error("Agent runtime terminated"));
        assert!(is_connection_error("Agent runtime is unavailable"));
        assert_eq!(
            pool_error_action(Some(DatabaseType::Oracle), "Agent stdin not available"),
            PoolErrorAction::Discard
        );
        assert_eq!(pool_error_action(Some(DatabaseType::Oracle), "Agent runtime terminated"), PoolErrorAction::Discard);
        assert_eq!(
            pool_error_action(Some(DatabaseType::Oracle), "Agent runtime is unavailable"),
            PoolErrorAction::Discard
        );
    }

    #[test]
    fn query_results_convert_unsafe_json_integers_to_strings_for_js() {
        let result = db::QueryResult {
            columns: vec!["id".to_string(), "nested".to_string()],
            column_types: Vec::new(),
            column_sortables: vec![],
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: vec![vec![
                serde_json::json!(2_041_797_190_226_354_178_i64),
                serde_json::json!([1, 2_041_797_190_226_354_178_i64]),
            ]],
            affected_rows: 0,
            execution_time_ms: 0,
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
        };

        let normalized = normalize_query_result_for_js(result);

        assert_eq!(normalized.rows[0][0], serde_json::json!("2041797190226354178"));
        assert_eq!(normalized.rows[0][1], serde_json::json!([1, "2041797190226354178"]));
    }

    #[test]
    fn query_execution_options_default_use_transaction_is_none() {
        let opts = QueryExecutionOptions::default();
        assert_eq!(opts.use_transaction, None);
    }

    #[test]
    fn query_execution_options_use_transaction_some_true_is_preserved() {
        let opts = QueryExecutionOptions { use_transaction: Some(true), ..Default::default() };
        assert_eq!(opts.use_transaction, Some(true));
    }

    #[test]
    fn query_execution_options_use_transaction_some_false_is_preserved() {
        let opts = QueryExecutionOptions { use_transaction: Some(false), ..Default::default() };
        assert_eq!(opts.use_transaction, Some(false));
    }

    #[test]
    fn database_backup_transactions_request_consistent_snapshots() {
        assert_eq!(postgres_transaction_begin_sql(true), "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        assert_eq!(mysql_transaction_isolation_sql(true), Some("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"));
        assert_eq!(
            mysql_transaction_begin_sql_candidates(true),
            [
                "START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY",
                "START TRANSACTION WITH CONSISTENT SNAPSHOT",
                "START TRANSACTION",
            ]
        );
        assert_eq!(mysql_transaction_isolation_sql(false), None);
        assert_eq!(mysql_transaction_begin_sql_candidates(false), ["START TRANSACTION"]);
    }

    #[test]
    fn mysql_backup_transaction_only_falls_back_for_syntax_errors() {
        let syntax_error = mysql_async::Error::Server(mysql_async::ServerError {
            code: 1064,
            message: "unsupported transaction characteristic".to_string(),
            state: "42000".to_string(),
        });
        let permission_error = mysql_async::Error::Server(mysql_async::ServerError {
            code: 1044,
            message: "access denied".to_string(),
            state: "42000".to_string(),
        });

        assert!(mysql_error_is_syntax_error(&syntax_error));
        assert!(!mysql_error_is_syntax_error(&permission_error));
    }
}
