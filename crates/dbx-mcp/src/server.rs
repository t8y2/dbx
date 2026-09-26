use std::{collections::HashMap, sync::Arc, time::Duration, time::Instant};

use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{
        CallToolResult, ContentBlock, ErrorData, Implementation, ListResourceTemplatesResult, ListResourcesResult,
        ReadResourceRequestParams, ReadResourceResult, Resource, ResourceContents, ResourceTemplate,
        ServerCapabilities, ServerInfo,
    },
    schemars, tool, tool_handler, tool_router, ServerHandler,
};
use serde::Deserialize;
use serde_json::json;
use url::Url;
use uuid::Uuid;

use crate::backend::{format_query_result, new_connection_config, parse_database_type, ConnectionSummary, DbxBackend};
use crate::mongo::{self, MongoCommand, MongoSafetyError};
use crate::session::{McpSession, McpSessionStore};
use crate::transaction::{TransactionFailure, TransactionResult, TransactionStatus};
use dbx_core::{
    agent_tools::{
        format_query_result_as_text, normalize_sql_for_confirmation, QueryCellWindow, MAX_EXECUTE_QUERY_ROWS,
    },
    connection::SalesforceCurrentUser,
    database_manifest,
    db::redis_driver::{classify_command, parse_command_argv, RedisCommandResult, RedisCommandSafety},
    db::salesforce_driver::parse_salesforce_statement,
    history::HistoryEntry,
    mcp_policy::connection_allows_salesforce_dml,
    models::connection::ConnectionConfig,
    models::connection::DatabaseType,
    production_safety::{
        is_production_database, mongo_pipeline_targets_production_database, sql_references_disallowed_database,
        targets_production_database,
    },
    query_execution_sql::{classify_salesforce_statement_risk, is_write_sql_for_database, SalesforceStatementRisk},
    sql_risk::{
        classify_sql_risk_for_database, is_dangerous_sql_for_database, mcp_sql_has_forbidden_database_switch, SqlRisk,
    },
    storage::{McpDatabaseScope, McpGlobalPolicy},
};

const CONNECTIONS_RESOURCE_URI: &str = "dbx://connections";
const DATABASES_RESOURCE_TEMPLATE: &str = "dbx://connections/{connection_id}/databases";
const TABLES_RESOURCE_TEMPLATE: &str = "dbx://connections/{connection_id}/tables{?database,schema}";
const TABLE_SCHEMA_RESOURCE_TEMPLATE: &str = "dbx://connections/{connection_id}/table-schema{?database,schema,table}";

#[derive(Debug, PartialEq, Eq)]
enum DbxResourceRequest {
    Connections,
    Databases { connection_id: String },
    Tables { connection_id: String, database: Option<String>, schema: Option<String> },
    TableSchema { connection_id: String, database: Option<String>, schema: Option<String>, table: String },
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListConnectionsRequest {}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListDatabasesRequest {
    #[serde(flatten)]
    pub selector: ConnectionSelector,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ConnectionSelector {
    #[schemars(description = "Unique ID of the DBX connection")]
    #[schemars(extend("type" = "string"))]
    pub connection_id: Option<String>,
    #[schemars(description = "Name of the DBX connection")]
    #[schemars(extend("type" = "string"))]
    pub connection_name: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListTablesRequest {
    #[serde(flatten)]
    pub selector: ConnectionSelector,
    #[schemars(description = "Database name")]
    #[schemars(extend("type" = "string"))]
    pub database: Option<String>,
    #[schemars(description = "Schema name")]
    #[schemars(extend("type" = "string"))]
    pub schema: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct DescribeTableRequest {
    #[serde(flatten)]
    pub selector: ConnectionSelector,
    #[schemars(description = "Table name")]
    pub table: String,
    #[schemars(description = "Database name")]
    #[schemars(extend("type" = "string"))]
    pub database: Option<String>,
    #[schemars(description = "Schema name")]
    #[schemars(extend("type" = "string"))]
    pub schema: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListRoutinesRequest {
    #[serde(flatten)]
    pub selector: ConnectionSelector,
    #[schemars(description = "Database name")]
    #[schemars(extend("type" = "string"))]
    pub database: Option<String>,
    #[schemars(description = "Schema name")]
    #[schemars(extend("type" = "string"))]
    pub schema: Option<String>,
    #[schemars(
        description = "Optional routine type filter: PROCEDURE or FUNCTION. Omit to list both. Unsupported databases return an empty list."
    )]
    #[schemars(extend("type" = "string"))]
    pub routine_type: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetRoutineSourceRequest {
    #[serde(flatten)]
    pub selector: ConnectionSelector,
    #[schemars(description = "Routine name (as returned by dbx_list_routines)")]
    pub name: String,
    #[schemars(description = "Routine type: PROCEDURE or FUNCTION")]
    pub object_type: String,
    #[schemars(description = "Optional routine signature for databases that overload routine names (e.g. Oracle)")]
    #[schemars(extend("type" = "string"))]
    pub signature: Option<String>,
    #[schemars(description = "Database name")]
    #[schemars(extend("type" = "string"))]
    pub database: Option<String>,
    #[schemars(description = "Schema name")]
    #[schemars(extend("type" = "string"))]
    pub schema: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ExecuteQueryRequest {
    #[serde(flatten)]
    pub selector: ConnectionSelector,
    #[schemars(description = "Database name")]
    #[schemars(extend("type" = "string"))]
    pub database: Option<String>,
    #[schemars(description = "SQL query to execute")]
    pub sql: String,
    #[schemars(
        description = "Session ID from dbx_open_session. When set, the query runs on the session's pinned connection, preserving USE/SET and other session state across calls."
    )]
    #[schemars(extend("type" = "string"))]
    pub session_id: Option<String>,
    #[schemars(
        description = "Start character offset for every string cell (default 0, max 1000000). Use the next offset reported by a truncated result to slide through a long value; narrow the query to the target row and column first."
    )]
    #[schemars(extend("type" = "integer"))]
    pub cell_char_offset: Option<u64>,
    #[schemars(
        description = "Maximum characters returned per string cell (default 200, max 4000). Increase only for an explicit long-value expansion."
    )]
    #[schemars(extend("type" = "integer"))]
    pub cell_char_limit: Option<u64>,
    #[schemars(
        description = "Maximum rows returned for this call (default 100, max 1000; larger values are clamped). SQL connections only - MongoDB shell commands always return at most 100 rows, and multi-statement scripts routed to the batch executor return at most 100 rows per statement."
    )]
    #[schemars(extend("type" = "integer"))]
    pub max_rows: Option<u64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct OpenSessionRequest {
    #[serde(flatten)]
    pub selector: ConnectionSelector,
    #[schemars(description = "Database name")]
    #[schemars(extend("type" = "string"))]
    pub database: Option<String>,
    #[serde(default)]
    #[schemars(description = "Eagerly reserve one native MySQL connection for explicit transaction tools")]
    pub enable_transactions: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct CloseSessionRequest {
    #[schemars(description = "Session ID returned by dbx_open_session")]
    pub session_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct TransactionSessionRequest {
    #[schemars(description = "Transaction-enabled session ID returned by dbx_open_session")]
    pub session_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct AddConnectionRequest {
    pub name: String,
    pub db_type: String,
    pub host: String,
    #[schemars(extend("type" = "integer"))]
    pub port: Option<u16>,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[schemars(extend("type" = "string"))]
    pub database: Option<String>,
    #[serde(default)]
    pub ssl: bool,
    #[schemars(extend("type" = "string"))]
    pub driver_profile: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct DuplicateConnectionRequest {
    #[serde(flatten)]
    pub selector: ConnectionSelector,
    #[schemars(description = "Name for the copied connection")]
    pub new_name: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct RemoveConnectionRequest {
    #[schemars(description = "Name of the DBX connection when connection_id is not provided")]
    #[schemars(extend("type" = "string"))]
    pub connection_name: Option<String>,
    #[schemars(extend("type" = "string"))]
    pub connection_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ExecuteRedisCommandRequest {
    #[serde(flatten)]
    pub selector: ConnectionSelector,
    #[schemars(description = "Redis logical database number. Use this argument instead of the SELECT command.")]
    #[schemars(extend("type" = "integer"))]
    pub db: Option<u32>,
    #[schemars(description = "Redis command to execute, for example GET mykey or INFO")]
    pub command: String,
}

#[derive(Debug, Default, serde::Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PeekStartPosition {
    #[default]
    Latest,
    Earliest,
    Offset,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct PeekMessagesRequest {
    #[serde(flatten)]
    pub selector: ConnectionSelector,
    #[schemars(description = "Kafka topic name")]
    pub topic: String,
    #[schemars(description = "Number of messages, 1 to 100 (default 20)", extend("type" = "integer"))]
    pub count: Option<u32>,
    #[serde(default)]
    #[schemars(description = "Read latest messages (default), earliest messages, or from an offset")]
    pub start_position: PeekStartPosition,
    #[schemars(description = "Non-negative partition; omit to read across partitions", extend("type" = "integer"))]
    pub partition: Option<i32>,
    #[schemars(description = "Non-negative offset, required only for start_position=offset", extend("type" = "integer"))]
    pub offset: Option<i64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SendMessageRequest {
    #[serde(flatten)]
    pub selector: ConnectionSelector,
    #[schemars(description = "Message queue topic name")]
    pub topic: String,
    #[schemars(description = "Message payload encoded as standard base64")]
    pub payload_base64: String,
    #[serde(default)]
    #[schemars(description = "Optional message key used for partitioning")]
    #[schemars(extend("type" = "string"))]
    pub key: Option<String>,
    #[serde(default)]
    #[schemars(description = "Optional UTF-8 text preview of the payload")]
    #[schemars(extend("type" = "string"))]
    pub payload_text: Option<String>,
    #[serde(default)]
    #[schemars(description = "Optional message headers")]
    pub headers: std::collections::HashMap<String, String>,
    #[serde(default)]
    #[schemars(description = "Optional target partition")]
    #[schemars(extend("type" = "integer"))]
    pub partition: Option<i32>,
    #[serde(default)]
    #[schemars(description = "RabbitMQ exchange name")]
    #[schemars(extend("type" = "string"))]
    pub exchange: Option<String>,
    #[serde(default)]
    #[schemars(description = "RabbitMQ routing key")]
    #[schemars(extend("type" = "string"))]
    pub routing_key: Option<String>,
    #[serde(default)]
    #[schemars(description = "RabbitMQ virtual-host namespace")]
    #[schemars(extend("type" = "string"))]
    pub namespace: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SchemaContextRequest {
    #[serde(flatten)]
    pub selector: ConnectionSelector,
    #[schemars(extend("type" = "string"))]
    pub database: Option<String>,
    #[schemars(extend("type" = "string"))]
    pub schema: Option<String>,
    #[schemars(description = "Specific table names to include")]
    #[schemars(extend("type" = "array"))]
    pub tables: Option<Vec<String>>,
    #[schemars(description = "Maximum number of tables to include, from 1 to 20")]
    #[schemars(extend("type" = "integer"))]
    pub max_tables: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct OpenTableRequest {
    #[serde(flatten)]
    pub selector: ConnectionSelector,
    pub table: String,
    #[schemars(extend("type" = "string"))]
    pub database: Option<String>,
    #[schemars(extend("type" = "string"))]
    pub schema: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ExecuteAndShowRequest {
    #[serde(flatten)]
    pub selector: ConnectionSelector,
    pub sql: String,
    #[schemars(extend("type" = "string"))]
    pub database: Option<String>,
}

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
pub struct CellWindowArgs {
    #[schemars(
        description = "Start character offset for every string cell (default 0, max 1000000). Use the next offset reported by a truncated result to slide through a long value; narrow the query to the target row and column first."
    )]
    #[schemars(extend("type" = "integer"))]
    pub cell_char_offset: Option<u64>,
    #[schemars(
        description = "Maximum characters returned per string cell (default 200, max 4000). Increase only for an explicit long-value expansion."
    )]
    #[schemars(extend("type" = "integer"))]
    pub cell_char_limit: Option<u64>,
}

impl CellWindowArgs {
    fn to_query_window(&self) -> QueryCellWindow {
        QueryCellWindow::from_options(self.cell_char_offset, self.cell_char_limit)
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ExecuteBatchQueryRequest {
    #[serde(flatten)]
    pub selector: ConnectionSelector,
    /// Per-cell character window for every rendered statement. Flattened from
    /// `CellWindowArgs` so the batch tool accepts the same `cell_char_offset` /
    /// `cell_char_limit` arguments as `dbx_execute_query` instead of silently
    /// ignoring them (#9865).
    #[serde(flatten)]
    pub cell_window: CellWindowArgs,
    #[schemars(description = "Database name")]
    #[schemars(extend("type" = "string"))]
    pub database: Option<String>,
    #[schemars(
        description = "SQL script containing one or more statements. Statements are split using the database-dialect-aware splitter, so semicolons inside strings, comments, and stored procedures are handled."
    )]
    pub sql: String,
    #[schemars(
        description = "Session ID from dbx_open_session. When set, every statement runs on the session's pinned connection, preserving USE/SET, temporary tables and other session state across statements in the script and across calls."
    )]
    #[schemars(extend("type" = "string"))]
    pub session_id: Option<String>,
    #[schemars(
        description = "When true, execution continues after a statement error instead of stopping at the first failure. Connection-level failures always stop the batch. Default false (stop at first failure)."
    )]
    #[schemars(extend("type" = "boolean"))]
    pub continue_on_error: Option<bool>,
    #[schemars(
        description = "When true and the script has more than one statement, all statements run inside one transaction (BEGIN … COMMIT) so the whole batch succeeds or rolls back, and the call returns a single merged result. For a single-statement script the option is ignored and the statement runs as normal auto-commit. Backends that cannot provide a rollbackable transaction reject this option. Cannot be combined with session_id or continue_on_error. Rejected for MySQL-family DDL scripts because DDL implicitly commits and cannot be rolled back. Default is auto-commit for each statement."
    )]
    #[schemars(extend("type" = "boolean"))]
    pub use_transaction: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SalesforceIdentityRequest {
    #[serde(flatten)]
    pub selector: ConnectionSelector,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SalesforcePrepareWriteRequest {
    #[serde(flatten)]
    pub selector: ConnectionSelector,
    #[schemars(
        description = "Database name. Salesforce has no databases, so omit this unless DBX MCP settings scope the connection."
    )]
    #[schemars(extend("type" = "string"))]
    pub database: Option<String>,
    #[schemars(description = "Write operation: \"insert\", \"update\" or \"delete\". One record per call.")]
    pub op: String,
    #[schemars(
        description = "Salesforce object API name, e.g. \"Account\", \"Contact\" or a custom object such as \"Invoice__c\"."
    )]
    pub object: String,
    #[schemars(
        description = "Record Id of the row to change. Required for update and delete; omit for insert, where Salesforce assigns it."
    )]
    #[schemars(extend("type" = "string"))]
    pub id: Option<String>,
    #[schemars(
        description = "Field API name to value map, e.g. {\"Name\": \"Acme\", \"AnnualRevenue\": 1200}. Required and non-empty for insert and update; omit for delete. Never include \"Id\"."
    )]
    #[schemars(extend("type" = "object"))]
    pub fields: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SalesforceApplyWriteRequest {
    #[schemars(
        description = "The confirm_token returned by dbx_salesforce_prepare_write. Single-use, and valid only for the exact write that was summarized."
    )]
    pub confirm_token: String,
}

/// How long a prepared Salesforce write stays applicable. Long enough for an
/// agent to show the summary and for a human to answer, short enough that a
/// token left in a transcript cannot be replayed much later against a changed
/// org.
const SALESFORCE_WRITE_CONFIRM_TTL: Duration = Duration::from_secs(300);
/// Ceiling on simultaneously pending confirmations. Prepared writes live in
/// process memory, so an agent that prepares in a loop must not be able to grow
/// the map without bound.
const SALESFORCE_WRITE_PENDING_LIMIT: usize = 64;
/// Field rows shown in a confirmation summary before it collapses the rest into
/// a count. The full statement is still in `structured_content`.
const SALESFORCE_SUMMARY_MAX_FIELDS: usize = 40;
/// Characters of one field value shown in the summary.
const SALESFORCE_SUMMARY_MAX_VALUE_CHARS: usize = 200;
/// Header the Salesforce driver routes to its REST DML endpoints. Mirrors
/// `dbx-sql`'s grid save builder; the driver matches it case-insensitively.
const SALESFORCE_DML_HEADER: &str = "DBX SALESFORCE DML";

/// One write prepared by `dbx_salesforce_prepare_write` and waiting for its
/// `dbx_salesforce_apply_write` call.
///
/// Salesforce has no transactions and no rollback, so this confirmation step is
/// the only place a write can still be stopped. The statement text is captured
/// here verbatim and re-sent verbatim: what the summary showed the user is
/// exactly what the org receives, and an agent cannot widen it in between.
#[derive(Debug, Clone)]
struct PendingSalesforceWrite {
    connection_id: String,
    database: String,
    statement: String,
    created_at: Instant,
}

#[derive(Debug)]
struct PendingSalesforceWrites {
    ttl: Duration,
    entries: tokio::sync::Mutex<HashMap<String, PendingSalesforceWrite>>,
}

impl PendingSalesforceWrites {
    fn new(ttl: Duration) -> Arc<Self> {
        Arc::new(Self { ttl, entries: tokio::sync::Mutex::new(HashMap::new()) })
    }

    fn ttl_secs(&self) -> u64 {
        self.ttl.as_secs()
    }

    fn is_expired(&self, pending: &PendingSalesforceWrite) -> bool {
        pending.created_at.elapsed() >= self.ttl
    }

    /// Store a prepared write under its token, dropping expired entries first
    /// and then the oldest ones until the cap has room.
    async fn insert(&self, token: String, pending: PendingSalesforceWrite) {
        let mut entries = self.entries.lock().await;
        entries.retain(|_, entry| !self.is_expired(entry));
        while entries.len() >= SALESFORCE_WRITE_PENDING_LIMIT {
            let Some(oldest) = entries.iter().min_by_key(|(_, entry)| entry.created_at).map(|(token, _)| token.clone())
            else {
                break;
            };
            entries.remove(&oldest);
        }
        entries.insert(token, pending);
    }

    /// Consume a token. Single-use by design: a failed apply, a retry, or a
    /// second call with the same token all have to go back through prepare, so
    /// every write that reaches Salesforce was summarized again first.
    async fn take(&self, token: &str) -> Option<PendingSalesforceWrite> {
        let entry = self.entries.lock().await.remove(token.trim())?;
        (!self.is_expired(&entry)).then_some(entry)
    }
}

#[derive(Clone)]
pub struct DbxMcpServer {
    backend: Arc<dyn DbxBackend>,
    scope: McpScope,
    sessions: Arc<McpSessionStore>,
    pending_salesforce_writes: Arc<PendingSalesforceWrites>,
    tool_router: ToolRouter<Self>,
}

#[derive(Clone, Debug, Default)]
pub struct McpScope {
    pub connection_ids: Vec<String>,
    pub connection_name: Option<String>,
    pub database: Option<String>,
    pub schema: Option<String>,
}

struct ResolvedConnection {
    connection: dbx_core::models::connection::ConnectionConfig,
    policy: McpGlobalPolicy,
    database_scope: DatabaseScope,
    group_ids: Vec<String>,
}

struct SessionCleanupResult {
    status: Option<TransactionStatus>,
    error: Option<String>,
}

#[derive(Clone, Debug)]
enum DatabaseScope {
    All,
    Selected(Vec<String>),
    None,
}

impl McpScope {
    pub fn from_env() -> Self {
        let mut connection_ids = scoped_connection_ids(std::env::var("DBX_MCP_SCOPE_CONNECTION_IDS").ok().as_deref());
        if connection_ids.is_empty() {
            if let Some(connection_id) = non_empty_env("DBX_MCP_SCOPE_CONNECTION_ID") {
                connection_ids.push(connection_id);
            }
        }
        Self {
            connection_ids,
            connection_name: non_empty_env("DBX_MCP_SCOPE_CONNECTION_NAME"),
            database: non_empty_env("DBX_MCP_SCOPE_DATABASE"),
            schema: non_empty_env("DBX_MCP_SCOPE_SCHEMA"),
        }
    }

    fn enabled(&self) -> bool {
        self.connection_scope_enabled() || self.database.is_some() || self.schema.is_some()
    }

    fn connection_scope_enabled(&self) -> bool {
        !self.connection_ids.is_empty() || self.connection_name.is_some()
    }

    fn matches(&self, connection: &dbx_core::models::connection::ConnectionConfig) -> bool {
        if !self.connection_ids.is_empty() {
            return self.connection_ids.iter().any(|id| id == &connection.id);
        }
        self.connection_name.as_deref() == Some(connection.name.as_str())
    }
}

impl DbxMcpServer {
    pub fn new(backend: Arc<dyn DbxBackend>) -> Self {
        Self::with_runtime_options(backend, McpScope::from_env(), std::env::var_os("DBX_WEB_URL").is_some())
    }

    pub fn with_runtime_options(backend: Arc<dyn DbxBackend>, scope: McpScope, web_mode: bool) -> Self {
        // The workspace enables more than one rustls crypto feature through
        // transitive dependencies. Native MCP runs outside the desktop/web
        // startup paths, so select the same provider before any TLS tool call.
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let mut tool_router = Self::tool_router();
        if scope.enabled() {
            tool_router.disable_route("dbx_add_connection");
            tool_router.disable_route("dbx_duplicate_connection");
            tool_router.disable_route("dbx_remove_connection");
        }
        // Desktop UI bridge operations are intentionally unavailable remotely and in scoped AI sessions.
        if web_mode || scope.enabled() {
            tool_router.disable_route("dbx_open_table");
            tool_router.disable_route("dbx_execute_and_show");
        }
        #[cfg(not(feature = "mq-admin"))]
        {
            tool_router.disable_route("dbx_send_message");
            tool_router.disable_route("dbx_peek_messages");
        }
        Self {
            backend,
            scope,
            sessions: McpSessionStore::new(),
            pending_salesforce_writes: PendingSalesforceWrites::new(SALESFORCE_WRITE_CONFIRM_TTL),
            tool_router,
        }
    }

    fn spawn_session_cleanup(&self, session: McpSession) -> tokio::sync::oneshot::Receiver<SessionCleanupResult> {
        let backend = self.backend.clone();
        let sessions = self.sessions.clone();
        let (result_tx, result_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let status = if let Some(owner) = &session.transaction_owner {
                match owner.close().await {
                    Ok(status) => Some(status),
                    Err(_) => {
                        owner.wait_closed().await;
                        Some(owner.status())
                    }
                }
            } else {
                None
            };
            let close_result = backend
                .close_client_session(&session.connection_id, &session.database, &session.client_session_id)
                .await;
            let error = match close_result {
                Ok(_) => {
                    sessions.finish_close(&session.id).await;
                    None
                }
                Err(error) if session.transaction_owner.is_none() => {
                    sessions.restore_after_failed_close(session).await;
                    Some(error)
                }
                Err(error) => {
                    sessions.finish_close(&session.id).await;
                    Some(error)
                }
            };
            let _ = result_tx.send(SessionCleanupResult { status, error });
        });
        result_rx
    }

    async fn close_backend_sessions_best_effort(&self, sessions: Vec<McpSession>) {
        let cleanups = sessions.into_iter().map(|session| self.spawn_session_cleanup(session)).collect::<Vec<_>>();
        for cleanup in cleanups {
            let _ = cleanup.await;
        }
    }

    fn spawn_transaction_session_open(
        &self,
        connection: ConnectionConfig,
        database: String,
        session: McpSession,
    ) -> (
        tokio::sync::oneshot::Receiver<Result<Arc<crate::transaction::TransactionOwner>, String>>,
        tokio::sync::oneshot::Sender<()>,
    ) {
        let backend = self.backend.clone();
        let sessions = self.sessions.clone();
        let (prepared_tx, prepared_rx) = tokio::sync::oneshot::channel();
        let (ack_tx, ack_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let owner = match backend.open_transaction_owner(&connection, &database, &session.client_session_id).await {
                Ok(owner) => owner,
                Err(error) => {
                    sessions.cancel_opening(&session.id).await;
                    let _ = backend
                        .close_client_session(&session.connection_id, &session.database, &session.client_session_id)
                        .await;
                    let _ = prepared_tx.send(Err(error));
                    return;
                }
            };
            if prepared_tx.send(Ok(owner.clone())).is_err() || ack_rx.await.is_err() {
                sessions.cancel_opening(&session.id).await;
                let _ = owner.close().await;
                owner.wait_closed().await;
                let _ = backend
                    .close_client_session(&session.connection_id, &session.database, &session.client_session_id)
                    .await;
            }
        });
        (prepared_rx, ack_tx)
    }
    async fn save_mcp_sql_history(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        sql: &str,
        started_at: Instant,
        success: bool,
        error: Option<String>,
        affected_rows: Option<i64>,
    ) {
        let entry = HistoryEntry {
            id: Uuid::new_v4().to_string(),
            connection_id: connection.id.clone(),
            connection_name: connection.name.clone(),
            database: database.to_string(),
            sql: sql.to_string(),
            executed_at: chrono::Utc::now().to_rfc3339(),
            execution_time_ms: started_at.elapsed().as_millis(),
            success,
            error,
            activity_kind: mcp_sql_activity_kind(sql, connection.db_type).to_string(),
            operation: mcp_sql_operation(sql, connection.db_type),
            target: String::new(),
            affected_rows,
            rollback_sql: None,
            details_json: Some(r#"{"source":"mcp"}"#.to_string()),
        };
        if let Err(error) = self.backend.save_history_entry(&entry).await {
            log::warn!("failed to save MCP SQL history for connection {}: {error}", connection.id);
        }
    }
}

#[tool_router]
impl DbxMcpServer {
    #[tool(
        name = "dbx_list_connections",
        description = "List database connections configured in DBX. Returns connection IDs, names, group paths, database types, endpoints, and selected databases."
    )]
    async fn list_connections(
        &self,
        Parameters(ListConnectionsRequest {}): Parameters<ListConnectionsRequest>,
    ) -> CallToolResult {
        if let Err(error) = self.ensure_tool_allowed("dbx_list_connections").await {
            return error;
        }
        match self.load_scoped_connections().await {
            Ok(connections) if connections.is_empty() => text("No connections configured in DBX."),
            Ok(connections) => {
                let group_paths = self.backend.load_connection_group_details().await.unwrap_or_default();
                let rows = connections
                    .iter()
                    .map(|connection| {
                        let mut summary = ConnectionSummary::from(connection);
                        summary.group_path =
                            group_paths.get(&connection.id).map(|path| path.names.clone()).unwrap_or_default();
                        summary
                    })
                    .collect::<Vec<_>>();
                text(format_connections(&rows))
            }
            Err(error) => backend_tool_error("CONNECTION_LOAD_ERROR", error),
        }
    }

    #[tool(
        name = "dbx_list_databases",
        description = "List database names available through a DBX connection. When the connection has a database allowlist, returns only the databases allowed by DBX MCP settings; use this before listing tables if the connection has no default database."
    )]
    async fn list_databases(&self, Parameters(request): Parameters<ListDatabasesRequest>) -> CallToolResult {
        if let Err(error) = self.ensure_tool_allowed("dbx_list_databases").await {
            return error;
        }
        let resolved = match self.resolve_connection(&request.selector).await {
            Ok(resolved) => resolved,
            Err(error) => return error,
        };
        self.list_databases_for_resolved(&resolved).await
    }

    #[tool(name = "dbx_list_tables", description = "List tables and views for a database connection")]
    async fn list_tables(&self, Parameters(request): Parameters<ListTablesRequest>) -> CallToolResult {
        if let Err(error) = self.ensure_tool_allowed("dbx_list_tables").await {
            return error;
        }
        let resolved = match self.resolve_connection(&request.selector).await {
            Ok(resolved) => resolved,
            Err(error) => return error,
        };
        let database = match self.resolve_database(request.database, &resolved) {
            Ok(database) => database,
            Err(error) => return error,
        };
        let schema = match self.resolve_schema(request.schema) {
            Ok(schema) => schema,
            Err(error) => return error,
        };
        match self.backend.list_tables(&resolved.connection, &database, &schema).await {
            Ok(tables) if tables.is_empty() => text("No tables found."),
            Ok(tables) => text(
                tables
                    .into_iter()
                    .map(|table| {
                        let comment = table
                            .comment
                            .filter(|comment| !comment.is_empty())
                            .map(|comment| format!(" -- {comment}"))
                            .unwrap_or_default();
                        format!("- {} ({}){}", table.name, table.table_type, comment)
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
            Err(error) => tool_error("TABLE_LIST_ERROR", error),
        }
    }

    #[tool(name = "dbx_describe_table", description = "Get column definitions for a table")]
    async fn describe_table(&self, Parameters(request): Parameters<DescribeTableRequest>) -> CallToolResult {
        if let Err(error) = self.ensure_tool_allowed("dbx_describe_table").await {
            return error;
        }
        let resolved = match self.resolve_connection(&request.selector).await {
            Ok(resolved) => resolved,
            Err(error) => return error,
        };
        let database = match self.resolve_database(request.database, &resolved) {
            Ok(database) => database,
            Err(error) => return error,
        };
        let schema = match self.resolve_schema(request.schema) {
            Ok(schema) => schema,
            Err(error) => return error,
        };
        match self.backend.get_columns(&resolved.connection, &database, &schema, &request.table).await {
            Ok(columns) if columns.is_empty() => text("No columns found."),
            Ok(columns) => text(format_columns(&columns)),
            Err(error) => tool_error("TABLE_DESCRIPTION_ERROR", error),
        }
    }

    #[tool(name = "dbx_list_routines", description = "List stored procedures and functions for a database schema")]
    async fn list_routines(&self, Parameters(request): Parameters<ListRoutinesRequest>) -> CallToolResult {
        if let Err(error) = self.ensure_tool_allowed("dbx_list_routines").await {
            return error;
        }
        let resolved = match self.resolve_connection(&request.selector).await {
            Ok(resolved) => resolved,
            Err(error) => return error,
        };
        let database = match self.resolve_database(request.database, &resolved) {
            Ok(database) => database,
            Err(error) => return error,
        };
        let schema = match self.resolve_schema(request.schema) {
            Ok(schema) => schema,
            Err(error) => return error,
        };
        let routine_types = match request.routine_type.as_deref() {
            None => None,
            Some(kind) => match normalize_routine_type(kind) {
                Ok(kind) => Some(vec![kind]),
                Err(error) => return tool_error("ROUTINE_LIST_ERROR", error),
            },
        };
        match self.backend.list_routines(&resolved.connection, &database, &schema, routine_types.as_deref()).await {
            Ok(routines) if routines.is_empty() => text("No routines found."),
            Ok(routines) => text(format_routines(&routines)),
            Err(error) => tool_error("ROUTINE_LIST_ERROR", error),
        }
    }

    #[tool(name = "dbx_get_routine_source", description = "Get the full source text of a stored procedure or function")]
    async fn get_routine_source(&self, Parameters(request): Parameters<GetRoutineSourceRequest>) -> CallToolResult {
        if let Err(error) = self.ensure_tool_allowed("dbx_get_routine_source").await {
            return error;
        }
        let resolved = match self.resolve_connection(&request.selector).await {
            Ok(resolved) => resolved,
            Err(error) => return error,
        };
        let database = match self.resolve_database(request.database, &resolved) {
            Ok(database) => database,
            Err(error) => return error,
        };
        let schema = match self.resolve_schema(request.schema) {
            Ok(schema) => schema,
            Err(error) => return error,
        };
        let object_type = match normalize_routine_type(&request.object_type) {
            Ok(kind) => kind,
            Err(error) => return tool_error("ROUTINE_SOURCE_ERROR", error),
        };
        match self
            .backend
            .get_routine_source(
                &resolved.connection,
                &database,
                &schema,
                &request.name,
                &object_type,
                request.signature.as_deref(),
            )
            .await
        {
            Ok(source) if source.source.trim().is_empty() => text("Routine source is empty."),
            Ok(source) => text(source.source),
            Err(error) => tool_error("ROUTINE_SOURCE_ERROR", error),
        }
    }

    #[tool(
        name = "dbx_execute_query",
        description = "Execute a SQL query on a database connection (default 100 rows; pass max_rows to return up to 1000 rows; larger values are clamped; MongoDB shell commands and multi-statement scripts routed through the batch executor stay at 100 rows). For backwards compatibility, multi-statement scripts and stored-procedure scripts are routed through the dialect-aware batch executor."
    )]
    async fn execute_query_tool(
        &self,
        cancellation: tokio_util::sync::CancellationToken,
        parameters: Parameters<ExecuteQueryRequest>,
    ) -> CallToolResult {
        cancellable_tool_call(cancellation, self.execute_query(parameters)).await
    }

    async fn execute_query(&self, Parameters(request): Parameters<ExecuteQueryRequest>) -> CallToolResult {
        if let Err(error) = self.ensure_tool_allowed("dbx_execute_query").await {
            return error;
        }
        let explicit_cell_window = (request.cell_char_offset.is_some() || request.cell_char_limit.is_some())
            .then(|| QueryCellWindow::from_options(request.cell_char_offset, request.cell_char_limit));
        let resolved = match self.resolve_connection(&request.selector).await {
            Ok(resolved) => resolved,
            Err(error) => return error,
        };
        let connection = &resolved.connection;
        if connection.db_type == dbx_core::models::connection::DatabaseType::Redis {
            return tool_error(
                "REDIS_COMMAND_REQUIRED",
                "Redis connections do not accept SQL through dbx_execute_query. Use dbx_execute_redis_command.",
            );
        }
        if connection.db_type == DatabaseType::Salesforce
            && !is_database_discovery_sql(&request.sql)
            && is_write_sql_for_database(&request.sql, DatabaseType::Salesforce)
        {
            // SOQL has no write verbs, so anything the Salesforce classifier reads
            // as a write here is a `DBX SALESFORCE DML` pseudo-command. Letting it
            // ride along as a "query" would bypass both the connection's DML opt-in
            // and the two-step confirmation, and Salesforce cannot roll it back.
            // `SHOW DATABASES` is the one non-SOQL probe exempted: SOQL rules read
            // every non-SELECT as opaque, and the discovery path below answers it
            // with the "one org is one scope" explanation instead.
            return tool_error(
                "SALESFORCE_DML_REQUIRES_CONFIRMATION",
                "Salesforce writes cannot run through dbx_execute_query. Call dbx_salesforce_prepare_write, show its summary to the user, then dbx_salesforce_apply_write with the confirm_token it returns.",
            );
        }
        if sql_requires_batch_execution(&request.sql, connection.db_type) {
            return self
                .execute_batch_request(ExecuteBatchQueryRequest {
                    selector: ConnectionSelector { connection_id: Some(connection.id.clone()), connection_name: None },
                    cell_window: CellWindowArgs {
                        cell_char_offset: request.cell_char_offset,
                        cell_char_limit: request.cell_char_limit,
                    },
                    database: request.database.clone(),
                    sql: request.sql.clone(),
                    session_id: request.session_id.clone(),
                    continue_on_error: None,
                    use_transaction: None,
                })
                .await;
        }
        // Database discovery does not require a default database. In a
        // narrowed MCP scope it must never reveal names outside the allowlist,
        // so serve it directly from the scoped discovery path instead of
        // passing SHOW DATABASES to the database driver.
        if is_database_discovery_sql(&request.sql) {
            return self.list_databases_for_resolved(&resolved).await;
        }
        // Resolve the session before the database so its connection/database
        // binding is enforced on every stateful query.
        let session = match request.session_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
            Some(session_id) => {
                let (session, expired) = self.sessions.resolve(session_id).await.into_parts();
                self.close_backend_sessions_best_effort(expired).await;
                match session {
                    Some(session) if session.connection_id == connection.id => Some(session),
                    Some(_) => {
                        return tool_error(
                            "SESSION_CONNECTION_MISMATCH",
                            format!("Session \"{session_id}\" is bound to a different connection."),
                        );
                    }
                    None => {
                        return tool_error(
                            "SESSION_NOT_FOUND",
                            format!(
                                "Session \"{session_id}\" not found or expired. Open a new one with dbx_open_session."
                            ),
                        );
                    }
                }
            }
            None => None,
        };
        let database = match self.resolve_database(request.database, &resolved) {
            Ok(database) => database,
            Err(error) => return error,
        };
        let policy =
            effective_policy_for_database_with_groups(&resolved.policy, &resolved.group_ids, connection, &database);
        if let Some(session) = &session {
            if session.database != database {
                return tool_error(
                    "SESSION_DATABASE_MISMATCH",
                    format!(
                        "Session \"{}\" is bound to database \"{}\", not \"{database}\".",
                        session.id, session.database
                    ),
                );
            }
        }
        if connection.db_type == DatabaseType::MongoDb {
            // max_rows is deliberately ignored here: MongoDB shell commands
            // always return at most 100 rows, and this branch returns before the
            // arguments below are built.
            let command = match validate_mongo_command_with_groups(
                connection,
                &resolved.policy,
                &resolved.group_ids,
                &resolved.database_scope,
                &database,
                &request.sql,
            ) {
                Ok(command) => command,
                Err(error) => return error,
            };
            return match self.backend.execute_mongo_command(connection, &database, &command).await {
                Ok(result) => match explicit_cell_window {
                    Some(window) => match format_query_result_as_text(&result, 100, window) {
                        Ok(output) => text(output),
                        Err(error) => backend_tool_error("QUERY_FORMAT_ERROR", error),
                    },
                    None => text(format_query_result(&result, 100)),
                },
                Err(error) => backend_tool_error("QUERY_ERROR", error),
            };
        }
        // A pinned session makes USE/SET CATALOG meaningful, so database
        // switching is allowed — unless a hard database scope is configured,
        // which a USE statement could otherwise escape.
        let allow_database_switch = session.is_some() && self.scope.database.is_none();
        if connection.db_type != DatabaseType::MongoDb {
            if let Err(error) = ensure_sql_database_scope(&resolved.database_scope, connection, &database, &request.sql)
            {
                return error;
            }
            if let Err(error) =
                ensure_sql_database_execution_scope(&resolved.policy, connection, &database, &request.sql)
            {
                return error;
            }
        }
        let permissions = match validate_sql_policy(connection, &policy, &database, &request.sql, allow_database_switch)
        {
            Ok(permissions) => permissions,
            Err(error) => return error,
        };
        let max_rows = request.max_rows.map(|value| value.clamp(1, MAX_EXECUTE_QUERY_ROWS as u64)).unwrap_or(100);
        if let Some(session) = session.as_ref().filter(|session| session.transaction_owner.is_some()) {
            if let Err(error) = validate_transaction_sql_shape(&request.sql) {
                return tool_error("TRANSACTION_SQL_BLOCKED", error);
            }
            if let Some(reason) = confirmed_batch_sql_block_reason(
                &request.sql,
                connection.db_type,
                permissions.confirmed_write_sql.as_deref(),
            ) {
                return tool_error("SQL_BLOCKED", reason);
            }
            let owner = session.transaction_owner.as_ref().expect("filtered transaction owner").clone();
            let lease = match owner.acquire().await {
                Ok(lease) => lease,
                Err(error) => return transaction_failure_result(&session.id, error),
            };

            // The lease is the queue boundary. Re-read every mutable policy and
            // connection binding after waiting so queued work cannot outrun a
            // revocation or configuration refresh.
            if let Err(error) = self.ensure_tool_allowed("dbx_execute_query").await {
                return error;
            }
            let refreshed = match self
                .resolve_connection(&ConnectionSelector {
                    connection_id: Some(session.connection_id.clone()),
                    connection_name: None,
                })
                .await
            {
                Ok(resolved) => resolved,
                Err(error) => return error,
            };
            if !transaction_connection_supported(&refreshed.connection)
                || refreshed.connection.id != session.connection_id
            {
                return tool_error("TRANSACTION_UNSUPPORTED", "The bound native MySQL connection changed.");
            }
            if let Err(error) = ensure_sql_database_scope(
                &refreshed.database_scope,
                &refreshed.connection,
                &session.database,
                &request.sql,
            ) {
                return error;
            }
            if let Err(error) = ensure_sql_database_execution_scope(
                &refreshed.policy,
                &refreshed.connection,
                &session.database,
                &request.sql,
            ) {
                return error;
            }
            let refreshed_policy = effective_policy_for_database_with_groups(
                &refreshed.policy,
                &refreshed.group_ids,
                &refreshed.connection,
                &session.database,
            );
            let refreshed_permissions = match validate_sql_policy(
                &refreshed.connection,
                &refreshed_policy,
                &session.database,
                &request.sql,
                false,
            ) {
                Ok(permissions) => permissions,
                Err(error) => return error,
            };
            if let Err(error) = validate_transaction_sql_shape(&request.sql) {
                return tool_error("TRANSACTION_SQL_BLOCKED", error);
            }
            if let Some(reason) = confirmed_batch_sql_block_reason(
                &request.sql,
                refreshed.connection.db_type,
                refreshed_permissions.confirmed_write_sql.as_deref(),
            ) {
                return tool_error("SQL_BLOCKED", reason);
            }

            let history_sql = request.sql.clone();
            let started_at = Instant::now();
            return match lease.query(request.sql, Some(max_rows as usize)).await {
                Ok(execution) => {
                    let rendered = explicit_cell_window
                        .and_then(|window| {
                            format_query_result_as_text(&execution.result, max_rows as usize, window).ok()
                        })
                        .unwrap_or_else(|| format_query_result(&execution.result, max_rows as usize));
                    self.save_mcp_sql_history(
                        &refreshed.connection,
                        &session.database,
                        &history_sql,
                        started_at,
                        true,
                        None,
                        Some(execution.result.affected_rows as i64),
                    )
                    .await;
                    transaction_success_result(&session.id, &rendered, execution)
                }
                Err(error) => {
                    self.save_mcp_sql_history(
                        &refreshed.connection,
                        &session.database,
                        &history_sql,
                        started_at,
                        false,
                        Some(error.message.clone()),
                        None,
                    )
                    .await;
                    transaction_failure_result(&session.id, error)
                }
            };
        }
        let history_sql = request.sql.clone();
        let mut arguments = json!({ "sql": request.sql, "limit": max_rows });
        if let Some(schema) = self.scope.schema.as_deref() {
            arguments["schema"] = json!(schema);
        }
        if let Some(session) = &session {
            arguments["client_session_id"] = json!(session.client_session_id);
        }
        if let Some(offset) = request.cell_char_offset {
            arguments["cell_char_offset"] = json!(offset);
        }
        if let Some(limit) = request.cell_char_limit {
            arguments["cell_char_limit"] = json!(limit);
        }
        // Surface the global MCP query timeout as a per-query argument. It is
        // re-read on every tool call, so a settings-page change takes effect on
        // the next MCP query with no client-config regeneration. A future
        // per-call `timeout_secs` tool parameter can slot in above this by not
        // being clobbered when set by the model.
        if let Some(secs) = resolved.policy.query_timeout_secs {
            arguments["timeout_secs"] = json!(secs);
        }
        let started_at = Instant::now();
        let result =
            self.backend.execute_agent_tool(connection, &database, "execute_query", arguments, permissions).await;
        let success = !result.is_error;
        let error = result.is_error.then(|| result.content.trim_start_matches("Error: ").to_string());
        self.save_mcp_sql_history(connection, &database, &history_sql, started_at, success, error, None).await;
        agent_result(result)
    }

    #[tool(
        name = "dbx_execute_batch",
        description = "Execute a SQL script containing multiple statements in one call and return a result per statement. Statements are split with a database-dialect-aware parser, so semicolons inside strings, comments and stored procedures are handled. Stops at the first failing statement unless continue_on_error is true. Pass session_id (from dbx_open_session) when statements must share one connection (e.g. temporary tables, USE/SET). Pass cell_char_offset/cell_char_limit to expand long string cells in every statement's result, exactly like dbx_execute_query. When use_transaction is true and the script has multiple statements, the whole script runs in one transaction and the call returns a single merged result instead of one result per statement (single-statement scripts run normally and return that one result); use_transaction cannot be combined with session_id or continue_on_error, and is rejected when the backend cannot provide a rollbackable transaction or for MySQL-family DDL scripts (DDL implicitly commits and cannot be rolled back)."
    )]
    async fn execute_batch_tool(
        &self,
        cancellation: tokio_util::sync::CancellationToken,
        parameters: Parameters<ExecuteBatchQueryRequest>,
    ) -> CallToolResult {
        cancellable_tool_call(cancellation, self.execute_batch(parameters)).await
    }

    async fn execute_batch(&self, Parameters(request): Parameters<ExecuteBatchQueryRequest>) -> CallToolResult {
        if let Err(error) = self.ensure_tool_allowed("dbx_execute_batch").await {
            return error;
        }
        self.execute_batch_request(request).await
    }

    async fn execute_batch_request(&self, request: ExecuteBatchQueryRequest) -> CallToolResult {
        let resolved = match self.resolve_connection(&request.selector).await {
            Ok(resolved) => resolved,
            Err(error) => return error,
        };
        let connection = &resolved.connection;
        if connection.db_type == DatabaseType::Salesforce {
            return tool_error(
                "DBX_BATCH_UNSUPPORTED",
                "Salesforce has no batch execution: SOQL is read-only and every write touches exactly one record. Use dbx_execute_query for SOQL, and dbx_salesforce_prepare_write followed by dbx_salesforce_apply_write for a write.",
            );
        }
        if matches!(connection.db_type, DatabaseType::Redis | DatabaseType::MongoDb) {
            return tool_error(
                "DBX_BATCH_UNSUPPORTED",
                format!("Batch SQL execution is not available for {connection:?} connections."),
            );
        }
        let sql = request.sql.trim();
        if sql.is_empty() {
            return tool_error("SQL_BATCH_EMPTY", "SQL script cannot be empty.");
        }
        // Every statement is rendered on its own, so the requested per-cell
        // character window has to reach `format_batch_results`; without it the
        // renderer silently fell back to the 200-character default and
        // `cell_char_limit` looked ignored (#9865).
        let cell_window = request.cell_window.to_query_window();
        let session = match request.session_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
            Some(session_id) => {
                let (session, expired) = self.sessions.resolve(session_id).await.into_parts();
                self.close_backend_sessions_best_effort(expired).await;
                match session {
                    Some(session) if session.connection_id == connection.id => Some(session),
                    Some(_) => {
                        return tool_error(
                            "SESSION_CONNECTION_MISMATCH",
                            format!("Session \"{session_id}\" is bound to a different connection."),
                        );
                    }
                    None => {
                        return tool_error(
                            "SESSION_NOT_FOUND",
                            format!(
                                "Session \"{session_id}\" not found or expired. Open a new one with dbx_open_session."
                            ),
                        );
                    }
                }
            }
            None => None,
        };
        let database = match self.resolve_database(request.database, &resolved) {
            Ok(database) => database,
            Err(error) => return error,
        };
        if let Some(session) = &session {
            if session.database != database {
                return tool_error(
                    "SESSION_DATABASE_MISMATCH",
                    format!(
                        "Session \"{}\" is bound to database \"{}\", not \"{database}\".",
                        session.id, session.database
                    ),
                );
            }
        }
        // A pinned session makes USE/SET CATALOG meaningful, so database
        // switching is allowed — unless a hard database scope is configured.
        let allow_database_switch = session.is_some() && self.scope.database.is_none();
        let policy =
            effective_policy_for_database_with_groups(&resolved.policy, &resolved.group_ids, connection, &database);
        if let Err(error) = ensure_sql_database_scope(&resolved.database_scope, connection, &database, sql) {
            return error;
        }
        if let Err(error) = ensure_sql_database_execution_scope(&resolved.policy, connection, &database, sql) {
            return error;
        }
        // Split with the same dialect-aware splitter the core uses, early, so the
        // option-validity checks below only fire for scripts that actually enter
        // transaction mode (more than one statement). A single-statement script
        // ignores use_transaction and runs as normal auto-commit, so combining it
        // with session_id / continue_on_error must still be allowed.
        let execution_plan = self.backend.execution_plan(connection, &database, sql).await;
        let statement_count = execution_plan.statements.len();
        let transactional = request.use_transaction == Some(true) && statement_count > 1;
        // A transactional batch runs on a pooled connection and returns one
        // merged result, so it cannot preserve session state or yield per-
        // statement results. The core transaction path takes no client session
        // id, so combining the two would silently drop the session pin. Only
        // relevant when the script actually enters transaction mode.
        if transactional && session.is_some() {
            return tool_error(
                "TRANSACTION_WITH_SESSION_UNSUPPORTED",
                "use_transaction cannot be combined with session_id: transactional batches run on a pooled connection, discard session state, and return a single merged result. Run the batch either without use_transaction (auto-commit, one result per statement) or without session_id.",
            );
        }
        // The core transaction path rolls back and stops on the first failure
        // (query.rs:2970), so continue_on_error is silently ignored there.
        // Accepting both would promise per-statement continuation that never
        // happens — reject the combination instead. Only relevant when the
        // script actually enters transaction mode.
        if transactional && request.continue_on_error == Some(true) {
            return tool_error(
                "TRANSACTION_WITH_CONTINUE_UNSUPPORTED",
                "use_transaction cannot be combined with continue_on_error: a transactional batch stops and rolls back at the first failure, so continue_on_error would be ignored. Run the batch either without use_transaction (auto-commit, one result per statement, may continue on error) or without continue_on_error.",
            );
        }
        // DDL implicitly commits on MySQL-family and Oracle engines (and any
        // backend without transactional DDL — the shared capability check), so
        // the transaction wrapper cannot roll back a DDL that already committed
        // (e.g. "CREATE TABLE a; INSERT INTO missing" leaves the table behind
        // after the failed INSERT rolls back). A transactional batch containing
        // DDL would over-promise atomicity — reject it instead. Gated on multi-
        // statement like the other rejects: a single DDL statement is plain
        // auto-commit and safe.
        if transactional
            && dbx_core::query::batch_transaction_ddl_is_unrollbackable(
                Some(connection.db_type),
                &execution_plan.statements,
            )
        {
            return tool_error(
                "TRANSACTION_WITH_DDL_UNSUPPORTED",
                "use_transaction cannot be used with a batch whose DDL cannot be rolled back: DDL statements implicitly commit and cannot be rolled back, so the batch would not be atomic. Run the batch without use_transaction (auto-commit, one result per statement) or split the DDL and DML into separate calls.",
            );
        }
        // Classify the whole script as a unit so a single write/DDL statement in
        // the batch fails closed under read-only / dangerous-SQL / production
        // policy, exactly as the Web /api/query/execute-multi route does.
        let permissions = match validate_sql_policy(connection, &policy, &database, sql, allow_database_switch) {
            Ok(permissions) => permissions,
            Err(error) => return error,
        };
        // When the user confirmed a specific write SQL for this run, the batch
        // must not smuggle a different write/DDL statement past that binding.
        // Fail closed on the whole script when it contains a write and is not
        // exactly the confirmed SQL — matching execute_query's anti-replay rule.
        if let Some(message) =
            confirmed_batch_sql_block_reason(sql, connection.db_type, permissions.confirmed_write_sql.as_deref())
        {
            return tool_error("SQL_BLOCKED", message);
        }
        if let Some(session) = session.as_ref().filter(|session| session.transaction_owner.is_some()) {
            if request.use_transaction == Some(true) {
                return tool_error(
                    "TRANSACTION_WITH_SESSION_UNSUPPORTED",
                    "use_transaction cannot be combined with a transaction-enabled session; use dbx_begin_transaction and dbx_commit_transaction.",
                );
            }
            for statement in &execution_plan.statements {
                if let Err(error) = validate_transaction_sql_shape(statement) {
                    return tool_error("TRANSACTION_SQL_BLOCKED", error);
                }
            }
            let owner = session.transaction_owner.as_ref().expect("filtered transaction owner").clone();
            let lease = match owner.acquire().await {
                Ok(lease) => lease,
                Err(error) => return transaction_failure_result(&session.id, error),
            };
            if let Err(error) = self.ensure_tool_allowed("dbx_execute_batch").await {
                return error;
            }
            let refreshed = match self
                .resolve_connection(&ConnectionSelector {
                    connection_id: Some(session.connection_id.clone()),
                    connection_name: None,
                })
                .await
            {
                Ok(resolved) => resolved,
                Err(error) => return error,
            };
            if !transaction_connection_supported(&refreshed.connection)
                || refreshed.connection.id != session.connection_id
            {
                return tool_error("TRANSACTION_UNSUPPORTED", "The bound native MySQL connection changed.");
            }
            if let Err(error) =
                ensure_sql_database_scope(&refreshed.database_scope, &refreshed.connection, &session.database, sql)
            {
                return error;
            }
            if let Err(error) =
                ensure_sql_database_execution_scope(&refreshed.policy, &refreshed.connection, &session.database, sql)
            {
                return error;
            }
            let refreshed_policy = effective_policy_for_database_with_groups(
                &refreshed.policy,
                &refreshed.group_ids,
                &refreshed.connection,
                &session.database,
            );
            let refreshed_permissions =
                match validate_sql_policy(&refreshed.connection, &refreshed_policy, &session.database, sql, false) {
                    Ok(permissions) => permissions,
                    Err(error) => return error,
                };
            if let Some(message) = confirmed_batch_sql_block_reason(
                sql,
                refreshed.connection.db_type,
                refreshed_permissions.confirmed_write_sql.as_deref(),
            ) {
                return tool_error("SQL_BLOCKED", message);
            }
            for statement in &execution_plan.statements {
                if let Err(error) = validate_transaction_sql_shape(statement) {
                    return tool_error("TRANSACTION_SQL_BLOCKED", error);
                }
            }

            let started_at = Instant::now();
            let executions = lease
                .batch(
                    execution_plan.statements.clone(),
                    Some(BATCH_MAX_ROWS),
                    request.continue_on_error.unwrap_or(false),
                )
                .await;
            let mut results = Vec::with_capacity(executions.len());
            let mut failures = Vec::new();
            for (index, execution) in executions.into_iter().enumerate() {
                match execution {
                    Ok(execution) => results.push(crate::backend::BatchStatementResult {
                        result: execution.result,
                        execution_error: false,
                        statement_index: Some(index),
                        error_message: None,
                        merged: false,
                        transaction_state: Some(execution.state),
                        transaction_outcome: execution.outcome,
                    }),
                    Err(error) => {
                        failures.push(error.message.clone());
                        results.push(crate::backend::BatchStatementResult {
                            result: empty_query_result(),
                            execution_error: true,
                            statement_index: Some(index),
                            error_message: Some(error.message),
                            merged: false,
                            transaction_state: Some(error.state),
                            transaction_outcome: error.outcome,
                        });
                    }
                }
            }
            let status = owner.status();
            self.save_mcp_sql_history(
                &refreshed.connection,
                &session.database,
                sql,
                started_at,
                failures.is_empty(),
                (!failures.is_empty()).then(|| failures.join("; ")),
                failures.is_empty().then(|| {
                    results.iter().map(|result| result.result.affected_rows).sum::<u64>().min(i64::MAX as u64) as i64
                }),
            )
            .await;
            let mut tool_result = text(format_batch_results(&results, cell_window));
            tool_result.structured_content = Some(json!({
                "session_id": session.id,
                "transaction_state": status.state,
                "transaction_outcome": status.outcome,
                "results": results,
            }));
            return tool_result;
        }
        // A transactional batch runs on the plain (non-session) pool: the core
        // transaction wrapper ignores client_session_id (query.rs:2970 →
        // execute_statements_in_transaction_typed re-resolves the default pool
        // with get_or_create_pool). Creating an ephemeral session pool here
        // would open physical connections that are closed unused, so only
        // auto-commit batches get an ephemeral pinned pool — it keeps temp
        // tables and SET state alive for every statement in the script.
        let ephemeral_client_session_id =
            (!transactional && session.is_none()).then(|| format!("mcp-batch-{}", Uuid::new_v4()));
        let client_session_id = session
            .as_ref()
            .map(|session| session.client_session_id.clone())
            .or_else(|| ephemeral_client_session_id.clone());
        let mut options = dbx_core::query::QueryExecutionOptions {
            max_rows: Some(BATCH_MAX_ROWS),
            continue_on_error: request.continue_on_error.unwrap_or(false),
            use_transaction: request.use_transaction,
            client_session_id: client_session_id.clone(),
            ..Default::default()
        };
        // Surface the global MCP query timeout. It is re-read on every tool
        // call, so a settings change takes effect without client-config
        // regeneration.
        options.timeout_secs = resolved.policy.query_timeout_secs;
        let schema = self.scope.schema.as_deref();
        let started_at = Instant::now();
        let execution = self.backend.execute_batch(connection, &database, schema, sql, options).await;
        if let Some(client_session_id) = ephemeral_client_session_id.as_deref() {
            if let Err(error) = self.backend.close_client_session(&connection.id, &database, client_session_id).await {
                log::warn!("failed to close ephemeral MCP batch session for {}: {error}", connection.id);
            }
        }
        match execution {
            Ok(mut results) => {
                // The core transaction path collapses the whole script into one
                // merged QueryResult. Mark it so callers can tell a merged
                // outcome from a per-statement result, and render it distinctly
                // instead of implying per-statement outcomes. The len()==1 guard
                // keeps drivers that return per-statement results even with
                // use_transaction (e.g. SQL Server scripts with result sets)
                // from being mislabelled as transactional.
                if transactional && results.len() == 1 {
                    results[0].merged = true;
                    results[0].statement_index = None;
                }
                let failures = results
                    .iter()
                    .filter(|result| result.execution_error)
                    .map(|result| {
                        result.error_message.clone().unwrap_or_else(|| match result.statement_index {
                            Some(index) => format!("Statement {} failed", index + 1),
                            None => "Batch execution failed".to_string(),
                        })
                    })
                    .collect::<Vec<_>>();
                let success = failures.is_empty();
                let affected_rows = success.then(|| {
                    results.iter().map(|result| result.result.affected_rows).sum::<u64>().min(i64::MAX as u64) as i64
                });
                self.save_mcp_sql_history(
                    connection,
                    &database,
                    sql,
                    started_at,
                    success,
                    (!failures.is_empty()).then(|| failures.join("; ")),
                    affected_rows,
                )
                .await;
                let markdown = format_batch_results(&results, cell_window);
                // Issue #7548 requires structured per-statement results so callers do not
                // parse concatenated text. MCP requires structuredContent to be an object,
                // so the array lives under `results`.
                let mut tool_result = CallToolResult::success(vec![ContentBlock::text(markdown)]);
                tool_result.structured_content = Some(serde_json::json!({ "results": results }));
                tool_result
            }
            Err(error) => {
                self.save_mcp_sql_history(connection, &database, sql, started_at, false, Some(error.clone()), None)
                    .await;
                backend_tool_error("DBX_BATCH_EXECUTION_ERROR", error)
            }
        }
    }

    #[tool(
        name = "dbx_open_session",
        description = "Open a stateful query session pinned to a single backend connection. Returns a session ID for dbx_execute_query: USE, SET CATALOG, session variables and temporary tables persist across calls within the session. Close with dbx_close_session when done; idle sessions expire after 30 minutes by default (configurable with DBX_SESSION_IDLE_TTL_SECS)."
    )]
    async fn open_session_tool(
        &self,
        cancellation: tokio_util::sync::CancellationToken,
        parameters: Parameters<OpenSessionRequest>,
    ) -> CallToolResult {
        cancellable_tool_call(cancellation, self.open_session(parameters)).await
    }

    async fn open_session(&self, Parameters(request): Parameters<OpenSessionRequest>) -> CallToolResult {
        if let Err(error) = self.ensure_tool_allowed("dbx_open_session").await {
            return error;
        }
        let resolved = match self.resolve_connection(&request.selector).await {
            Ok(resolved) => resolved,
            Err(error) => return error,
        };
        let connection = &resolved.connection;
        if connection.db_type == DatabaseType::Salesforce {
            return tool_error(
                "SESSION_UNSUPPORTED",
                "Salesforce connections are stateless REST calls: there is no session to pin, no USE, and no transaction. Use dbx_execute_query for SOQL, and dbx_salesforce_prepare_write followed by dbx_salesforce_apply_write for a write.",
            );
        }
        if matches!(connection.db_type, DatabaseType::Redis | DatabaseType::MongoDb) {
            return tool_error(
                "SESSION_UNSUPPORTED",
                format!("Sessions are only supported for SQL connections; \"{}\" is not one.", connection.name),
            );
        }
        let database = match self.resolve_database(request.database, &resolved) {
            Ok(database) => database,
            Err(error) => return error,
        };
        if request.enable_transactions && !transaction_connection_supported(connection) {
            return tool_error(
                "TRANSACTION_UNSUPPORTED",
                "Fixed-session transactions require a native local MySQL connection without an external driver profile.",
            );
        }
        let (session, expired) = if request.enable_transactions {
            self.sessions.reserve_opening(&connection.id, &database).await.into_parts()
        } else {
            self.sessions.open(&connection.id, &database).await.into_parts()
        };
        self.close_backend_sessions_best_effort(expired).await;
        let session = match session {
            Ok(session) => session,
            Err(error) => return tool_error("SESSION_LIMIT", error),
        };
        if request.enable_transactions {
            let (prepared, acknowledge) =
                self.spawn_transaction_session_open(connection.clone(), database.clone(), session.clone());
            let owner = match prepared.await {
                Ok(Ok(owner)) => owner,
                Ok(Err(error)) => return backend_tool_error("TRANSACTION_UNSUPPORTED", error),
                Err(_) => return tool_error("SESSION_OPEN_ERROR", "Transaction session open worker stopped."),
            };
            let session = match self.sessions.promote_opening(&session.id, owner).await {
                Ok(session) => session,
                Err(error) => return tool_error("SESSION_OPEN_ERROR", error),
            };
            let mut result = text(format!(
                "Session opened.\nsession_id: {}\nconnection: {} (id: {})\ndatabase: {}\ntransactions: enabled\n\nPass session_id to dbx_execute_query to run every query on the same pinned connection. Close with dbx_close_session when done.",
                session.id, connection.name, connection.id, database
            ));
            result.structured_content = Some(json!({
                "session_id": session.id,
                "transaction_state": "idle",
                "transaction_outcome": null,
            }));
            let _ = acknowledge.send(());
            return result;
        }
        text(format!(
            "Session opened.\nsession_id: {}\nconnection: {} (id: {})\ndatabase: {}\n\nPass session_id to dbx_execute_query to run every query on the same pinned connection. Close with dbx_close_session when done.",
            session.id, connection.name, connection.id, database
        ))
    }

    #[tool(
        name = "dbx_begin_transaction",
        description = "Begin a transaction on a transaction-enabled native MySQL session"
    )]
    async fn begin_transaction_tool(
        &self,
        cancellation: tokio_util::sync::CancellationToken,
        parameters: Parameters<TransactionSessionRequest>,
    ) -> CallToolResult {
        cancellable_tool_call(cancellation, self.begin_transaction(parameters)).await
    }

    async fn begin_transaction(&self, Parameters(request): Parameters<TransactionSessionRequest>) -> CallToolResult {
        if let Err(error) = self.ensure_tool_allowed("dbx_begin_transaction").await {
            return error;
        }
        let (session, expired) = self.sessions.resolve(&request.session_id).await.into_parts();
        self.close_backend_sessions_best_effort(expired).await;
        let Some(session) = session else {
            return tool_error(
                "SESSION_NOT_FOUND",
                format!("Session \"{}\" not found or expired.", request.session_id),
            );
        };
        let Some(owner) = session.transaction_owner.clone() else {
            return tool_error("TRANSACTION_UNSUPPORTED", "This session was not opened with enable_transactions=true.");
        };
        let lease = match owner.acquire().await {
            Ok(lease) => lease,
            Err(error) => return transaction_failure_result(&session.id, error),
        };
        if let Err(error) = self.ensure_tool_allowed("dbx_begin_transaction").await {
            return error;
        }
        if let Err(error) = self.validate_transaction_control(&session, "BEGIN").await {
            return error;
        }
        match lease.begin().await {
            Ok(result) => transaction_success_result(&session.id, "Transaction started.", result),
            Err(error) => transaction_failure_result(&session.id, error),
        }
    }

    #[tool(
        name = "dbx_commit_transaction",
        description = "Commit the active transaction; committed is reported only after MySQL acknowledges COMMIT"
    )]
    async fn commit_transaction_tool(
        &self,
        cancellation: tokio_util::sync::CancellationToken,
        parameters: Parameters<TransactionSessionRequest>,
    ) -> CallToolResult {
        cancellable_tool_call(cancellation, self.commit_transaction(parameters)).await
    }

    async fn commit_transaction(&self, Parameters(request): Parameters<TransactionSessionRequest>) -> CallToolResult {
        if let Err(error) = self.ensure_tool_allowed("dbx_commit_transaction").await {
            return error;
        }
        let (session, expired) = self.sessions.resolve(&request.session_id).await.into_parts();
        self.close_backend_sessions_best_effort(expired).await;
        let Some(session) = session else {
            return tool_error(
                "SESSION_NOT_FOUND",
                format!("Session \"{}\" not found or expired.", request.session_id),
            );
        };
        let Some(owner) = session.transaction_owner.clone() else {
            return tool_error("TRANSACTION_UNSUPPORTED", "This session was not opened with enable_transactions=true.");
        };
        let lease = match owner.acquire().await {
            Ok(lease) => lease,
            Err(error) => return transaction_failure_result(&session.id, error),
        };
        if let Err(error) = self.ensure_tool_allowed("dbx_commit_transaction").await {
            return error;
        }
        if let Err(error) = self.validate_transaction_control(&session, "COMMIT").await {
            return error;
        }
        match lease.commit().await {
            Ok(result) => transaction_success_result(&session.id, "Transaction committed.", result),
            Err(error) => transaction_failure_result(&session.id, error),
        }
    }

    #[tool(
        name = "dbx_rollback_transaction",
        description = "Roll back the active transaction. Cleanup remains available after write-policy revocation."
    )]
    async fn rollback_transaction_tool(
        &self,
        cancellation: tokio_util::sync::CancellationToken,
        parameters: Parameters<TransactionSessionRequest>,
    ) -> CallToolResult {
        cancellable_tool_call(cancellation, self.rollback_transaction(parameters)).await
    }

    async fn rollback_transaction(&self, Parameters(request): Parameters<TransactionSessionRequest>) -> CallToolResult {
        let (session, expired) = self.sessions.resolve(&request.session_id).await.into_parts();
        self.close_backend_sessions_best_effort(expired).await;
        let Some(session) = session else {
            return tool_error(
                "SESSION_NOT_FOUND",
                format!("Session \"{}\" not found or expired.", request.session_id),
            );
        };
        let Some(owner) = session.transaction_owner.clone() else {
            return tool_error("TRANSACTION_UNSUPPORTED", "This session was not opened with enable_transactions=true.");
        };
        let lease = match owner.acquire().await {
            Ok(lease) => lease,
            Err(error) => return transaction_failure_result(&session.id, error),
        };
        match lease.rollback().await {
            Ok(result) => transaction_success_result(&session.id, "Transaction rolled back.", result),
            Err(error) => transaction_failure_result(&session.id, error),
        }
    }

    #[tool(
        name = "dbx_close_session",
        description = "Close a stateful query session and release its pinned backend connection"
    )]
    async fn close_session_tool(
        &self,
        cancellation: tokio_util::sync::CancellationToken,
        parameters: Parameters<CloseSessionRequest>,
    ) -> CallToolResult {
        cancellable_tool_call(cancellation, self.close_session(parameters)).await
    }

    async fn close_session(&self, Parameters(request): Parameters<CloseSessionRequest>) -> CallToolResult {
        let (session, expired) = self.sessions.begin_close(&request.session_id).await.into_parts();
        self.close_backend_sessions_best_effort(expired).await;
        let Some(session) = session else {
            return tool_error(
                "SESSION_NOT_FOUND",
                format!("Session \"{}\" not found or already closed.", request.session_id),
            );
        };
        let session_id = session.id.clone();
        let cleanup = self.spawn_session_cleanup(session);
        let cleanup = match cleanup.await {
            Ok(cleanup) => cleanup,
            Err(_) => return tool_error("SESSION_CLOSE_ERROR", "Session cleanup worker stopped."),
        };
        if let Some(error) = cleanup.error {
            return backend_tool_error("SESSION_CLOSE_ERROR", error);
        }
        let mut result = text(format!("Session \"{}\" closed.", session_id));
        if let Some(status) = cleanup.status {
            result.structured_content = Some(json!({
                "session_id": session_id,
                "transaction_state": status.state,
                "transaction_outcome": status.outcome,
            }));
        }
        result
    }

    #[tool(
        name = "dbx_execute_redis_command",
        description = "Execute a Redis command on a Redis connection. Use the db argument to select a logical database instead of sending SELECT. Use SCAN rather than KEYS when enumerating keys."
    )]
    async fn execute_redis_command(
        &self,
        Parameters(request): Parameters<ExecuteRedisCommandRequest>,
    ) -> CallToolResult {
        if let Err(error) = self.ensure_tool_allowed("dbx_execute_redis_command").await {
            return error;
        }
        let resolved = match self.resolve_connection(&request.selector).await {
            Ok(resolved) => resolved,
            Err(error) => return error,
        };
        let connection = &resolved.connection;
        if connection.db_type != DatabaseType::Redis {
            return tool_error("INVALID_CONNECTION_TYPE", format!("Connection \"{}\" is not Redis.", connection.name));
        }
        let database = match self.resolve_redis_database(request.db, &resolved) {
            Ok(database) => database,
            Err(error) => return error,
        };
        let argv = match parse_command_argv(&request.command) {
            Ok(argv) => argv,
            Err(error) => return tool_error("REDIS_COMMAND_BLOCKED", error),
        };
        if argv[0].eq_ignore_ascii_case("SELECT") {
            return tool_error(
                "REDIS_DATABASE_SELECTION_REQUIRED",
                "Redis SELECT is not available through MCP. Set the db argument to the logical database number instead; when db is omitted, DBX uses the current scoped database.",
            );
        }
        let safety = classify_command(&argv[0]);
        let policy = effective_policy_for_database_with_groups(
            &resolved.policy,
            &resolved.group_ids,
            connection,
            &database.to_string(),
        );
        let permissions = mcp_permissions(connection, &policy);
        if safety != RedisCommandSafety::Allowed && policy.read_only {
            return tool_error(
                "MCP_READ_ONLY",
                format!("MCP execution permission for Redis database {database} is read-only. Redis command blocked."),
            );
        }
        if safety != RedisCommandSafety::Allowed && connection.read_only {
            return tool_error(
                "CONNECTION_READ_ONLY",
                format!("Connection \"{}\" has read-only protection enabled. Redis command blocked.", connection.name),
            );
        }
        if safety == RedisCommandSafety::Blocked && !permissions.allow_dangerous {
            return tool_error(
                "REDIS_COMMAND_BLOCKED",
                format!(
                    "Dangerous Redis command \"{}\" is disabled in DBX MCP settings.",
                    argv[0].to_ascii_uppercase()
                ),
            );
        }
        if safety != RedisCommandSafety::Allowed && !permissions.allow_writes {
            return tool_error(
                "REDIS_COMMAND_BLOCKED",
                "MCP Redis command execution is read-only in DBX MCP settings.",
            );
        }
        // Production protection is stricter than the opt-in write flags by design.
        if safety != RedisCommandSafety::Allowed && is_production_database(connection, &database.to_string()) {
            return tool_error(
                "PRODUCTION_WRITE_BLOCKED",
                "MCP cannot execute write or dangerous Redis commands against a production database.",
            );
        }
        match self
            .backend
            .execute_redis_command(
                connection,
                database,
                &request.command,
                safety == RedisCommandSafety::Blocked && permissions.allow_dangerous,
            )
            .await
        {
            Ok(result) => text(format_redis_result(&result)),
            Err(error) => backend_tool_error("REDIS_COMMAND_ERROR", error),
        }
    }

    #[tool(
        name = "dbx_peek_messages",
        description = "Read up to 100 Kafka messages without committing consumer offsets. Defaults to the latest 20 messages. Returns JSON with base64 payloads, UTF-8 previews, metadata, incomplete (partial broker read), and outputTruncated (256 KiB message output budget). Only Kafka is supported."
    )]
    async fn peek_messages(&self, Parameters(request): Parameters<PeekMessagesRequest>) -> CallToolResult {
        if let Err(error) = self.ensure_tool_allowed("dbx_peek_messages").await {
            return error;
        }
        #[cfg(not(feature = "mq-admin"))]
        {
            let _ = request;
            tool_error("MQ_UNSUPPORTED", "Message queue support is not compiled into this DBX MCP build.")
        }
        #[cfg(feature = "mq-admin")]
        {
            use dbx_core::mq::{
                config::MqAdminConfig, MqSystemKind, PeekMessagesOptions, PeekStartPosition as Start, TopicRef,
            };
            let resolved = match self.resolve_connection(&request.selector).await {
                Ok(resolved) => resolved,
                Err(error) => return error,
            };
            match MqAdminConfig::from_connection(&resolved.connection) {
                Ok(config) if config.system_kind == MqSystemKind::Kafka => {}
                _ => {
                    return tool_error("MQ_UNSUPPORTED", "Message reading through MCP supports Kafka connections only.")
                }
            }
            let count = request.count.unwrap_or(20);
            let start_position = match request.start_position {
                PeekStartPosition::Latest => Start::Latest,
                PeekStartPosition::Earliest => Start::Earliest,
                PeekStartPosition::Offset => Start::Offset,
            };
            if request.topic.trim().is_empty() {
                return tool_error("MESSAGE_TOPIC_REQUIRED", "Message topic must not be empty.");
            }
            if !(1..=100).contains(&count)
                || request.partition.is_some_and(|value| value < 0)
                || request.offset.is_some_and(|value| value < 0)
                || (start_position == Start::Offset) != request.offset.is_some()
            {
                return tool_error("INVALID_PEEK_OPTIONS", "count must be 1..100; partition and offset must be non-negative; offset is required only for start_position=offset.");
            }
            let topic = TopicRef {
                tenant: "_kafka".into(),
                namespace: "default".into(),
                topic: request.topic.trim().into(),
                ..Default::default()
            };
            let options = PeekMessagesOptions {
                start_position: Some(start_position),
                partition: request.partition,
                offset: request.offset,
            };
            match self.backend.peek_messages(&resolved.connection, topic, count, options).await {
                Ok(result) => text(format_peek_messages_result(result, count as usize)),
                Err(error) => backend_tool_error("MESSAGE_PEEK_ERROR", error),
            }
        }
    }

    #[tool(
        name = "dbx_send_message",
        description = "Send a base64-encoded message to a Kafka, RocketMQ, or RabbitMQ topic/queue"
    )]
    async fn send_message(&self, Parameters(request): Parameters<SendMessageRequest>) -> CallToolResult {
        if let Err(error) = self.ensure_tool_allowed("dbx_send_message").await {
            return error;
        }
        #[cfg(not(feature = "mq-admin"))]
        {
            let _ = request;
            return tool_error("MQ_UNSUPPORTED", "Message queue support is not compiled into this DBX MCP build.");
        }

        #[cfg(feature = "mq-admin")]
        {
            let resolved = match self.resolve_connection(&request.selector).await {
                Ok(resolved) => resolved,
                Err(error) => return error,
            };
            let connection = &resolved.connection;
            let mq_config = match dbx_core::mq::config::MqAdminConfig::from_connection(connection) {
                Ok(config) => config,
                Err(error) => return tool_error("MQ_UNSUPPORTED", error),
            };
            if request.topic.trim().is_empty() {
                return tool_error("MESSAGE_TOPIC_REQUIRED", "Message topic must not be empty.");
            }
            let policy = effective_policy_for_database_with_groups(
                &resolved.policy,
                &resolved.group_ids,
                connection,
                connection.database.as_deref().unwrap_or(""),
            );
            if policy.read_only {
                return tool_error(
                    "MCP_READ_ONLY",
                    "The effective MCP execution permission is read-only. Message sending is blocked.",
                );
            }
            if connection.read_only {
                return tool_error(
                    "CONNECTION_READ_ONLY",
                    format!(
                        "Connection \"{}\" has read-only protection enabled. Message sending is blocked.",
                        connection.name
                    ),
                );
            }
            if dbx_core::production_safety::is_production_database(
                connection,
                connection.database.as_deref().unwrap_or(""),
            ) {
                return tool_error("PRODUCTION_WRITE_BLOCKED", "MCP cannot send messages to a production database.");
            }
            let request = dbx_core::mq::SendMessageRequest {
                topic: request.topic.trim().to_string(),
                key: request.key,
                payload_base64: request.payload_base64,
                payload_text: request.payload_text,
                headers: request.headers,
                partition: request.partition,
                exchange: request.exchange,
                routing_key: request.routing_key,
                namespace: request.namespace,
            };
            match self.backend.send_message(connection, request).await {
                Ok(result) => text(format_send_message_result(&mq_config.system_kind, &result)),
                Err(error) => backend_tool_error("MESSAGE_SEND_ERROR", error),
            }
        }
    }

    #[tool(name = "dbx_get_schema_context", description = "Get compact table and column context for writing SQL")]
    async fn get_schema_context(&self, Parameters(request): Parameters<SchemaContextRequest>) -> CallToolResult {
        if let Err(error) = self.ensure_tool_allowed("dbx_get_schema_context").await {
            return error;
        }
        let resolved = match self.resolve_connection(&request.selector).await {
            Ok(resolved) => resolved,
            Err(error) => return error,
        };
        let connection = &resolved.connection;
        let database = match self.resolve_database(request.database, &resolved) {
            Ok(database) => database,
            Err(error) => return error,
        };
        let schema = match self.resolve_schema(request.schema) {
            Ok(schema) => schema,
            Err(error) => return error,
        };
        let max_tables = request.max_tables.unwrap_or(8).clamp(1, 20);
        let available = match self.backend.list_tables(connection, &database, &schema).await {
            Ok(tables) => tables,
            Err(error) => return tool_error("SCHEMA_CONTEXT_ERROR", error),
        };
        let requested = request
            .tables
            .unwrap_or_default()
            .into_iter()
            .map(|name| name.to_ascii_lowercase())
            .collect::<std::collections::HashSet<_>>();
        let mut selected = if requested.is_empty() {
            available.iter().collect::<Vec<_>>()
        } else {
            available.iter().filter(|table| requested.contains(&table.name.to_ascii_lowercase())).collect::<Vec<_>>()
        };
        let truncated = selected.len() > max_tables || (requested.is_empty() && available.len() > max_tables);
        selected.truncate(max_tables);
        if selected.is_empty() {
            return text("No matching tables found.");
        }
        let mut tables = Vec::with_capacity(selected.len());
        for table in selected {
            // Keep metadata calls sequential because some embedded drivers expose a single physical connection.
            let columns = match self.backend.get_columns(connection, &database, &schema, &table.name).await {
                Ok(columns) => columns,
                Err(error) => return tool_error("SCHEMA_CONTEXT_ERROR", error),
            };
            tables.push((table.clone(), columns));
        }
        text(format_schema_context(&connection.name, &database, &schema, &tables, truncated))
    }

    #[tool(name = "dbx_add_connection", description = "Add a new database connection to DBX")]
    async fn add_connection(&self, Parameters(request): Parameters<AddConnectionRequest>) -> CallToolResult {
        if let Err(error) = self.ensure_tool_allowed("dbx_add_connection").await {
            return error;
        }
        let policy = match self.load_policy().await {
            Ok(policy) => policy,
            Err(error) => return error,
        };
        if policy.read_only {
            return tool_error(
                "MCP_READ_ONLY",
                "DBX global MCP read-only mode is enabled. Connection management is not allowed.",
            );
        }
        let connections = match self.backend.load_connections().await {
            Ok(connections) => connections,
            Err(error) => return tool_error("CONNECTION_LOAD_ERROR", error),
        };
        if connections.iter().any(|connection| connection.name.eq_ignore_ascii_case(&request.name)) {
            return text(format!("Connection \"{}\" already exists.", request.name));
        }
        let db_type = match parse_database_type(&request.db_type) {
            Ok(db_type) => db_type,
            Err(error) => return tool_error("INVALID_CONNECTION_TYPE", error),
        };
        let port = match request.port.or_else(|| database_manifest::default_port(&db_type)) {
            Some(port) => port,
            None => return text("Port is required for this database type."),
        };
        let config = match new_connection_config(
            Uuid::new_v4().to_string(),
            request.name,
            db_type,
            request.host,
            port,
            request.username,
            request.password,
            request.database,
            request.ssl,
            request.driver_profile,
        ) {
            Ok(config) => config,
            Err(error) => return tool_error("INVALID_CONNECTION", error),
        };
        match self.backend.add_connection_for_mcp(config).await {
            Ok(config) => text(format!("Connection \"{}\" added (id: {}).", config.name, config.id)),
            Err(error) => backend_tool_error("CONNECTION_SAVE_ERROR", error),
        }
    }

    #[tool(
        name = "dbx_duplicate_connection",
        description = "Duplicate a DBX connection with its complete settings, credentials, tunnels, and sidebar group"
    )]
    async fn duplicate_connection(
        &self,
        Parameters(request): Parameters<DuplicateConnectionRequest>,
    ) -> CallToolResult {
        if let Err(error) = self.ensure_tool_allowed("dbx_duplicate_connection").await {
            return error;
        }
        let policy = match self.load_policy().await {
            Ok(policy) => policy,
            Err(error) => return error,
        };
        if policy.read_only {
            return tool_error(
                "MCP_READ_ONLY",
                "DBX global MCP read-only mode is enabled. Connection management is not allowed.",
            );
        }
        let connections = match self.backend.load_connections().await {
            Ok(connections) => connections,
            Err(error) => return tool_error("CONNECTION_LOAD_ERROR", error),
        };
        let group_paths = match self.load_group_paths_for_policy(&policy).await {
            Ok(paths) => paths,
            Err(error) => return backend_tool_error("MCP_POLICY_UNAVAILABLE", error),
        };
        let allowed = connections
            .iter()
            .filter(|connection| policy_allows_connection(&policy, group_paths.get(&connection.id), connection))
            .cloned()
            .collect::<Vec<_>>();
        let source =
            if let Some(id) = request.selector.connection_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
                allowed.iter().find(|connection| connection.id == id).cloned()
            } else if let Some(name) =
                request.selector.connection_name.as_deref().map(str::trim).filter(|name| !name.is_empty())
            {
                let matching = allowed
                    .iter()
                    .filter(|connection| connection.name.eq_ignore_ascii_case(name))
                    .cloned()
                    .collect::<Vec<_>>();
                if matching.len() > 1 {
                    return tool_error("AMBIGUOUS_CONNECTION", ambiguous_connections(name, &matching));
                }
                matching.into_iter().next()
            } else {
                return tool_error("CONNECTION_NOT_FOUND", "Either connection_id or connection_name is required.");
            };
        let Some(source) = source else {
            return tool_error("CONNECTION_NOT_FOUND", "The source connection was not found or is outside MCP scope.");
        };
        let new_name = request.new_name.trim();
        if new_name.is_empty() {
            return tool_error("INVALID_CONNECTION", "The copied connection name must not be empty.");
        }
        if connections.iter().any(|connection| connection.name.eq_ignore_ascii_case(new_name)) {
            return tool_error("CONNECTION_ALREADY_EXISTS", format!("Connection \"{new_name}\" already exists."));
        }
        match self.backend.duplicate_connection_for_mcp(&source.id, &Uuid::new_v4().to_string(), new_name).await {
            Ok(copy) => text(format!("Connection \"{}\" duplicated (id: {}).", copy.name, copy.id)),
            Err(error) => backend_tool_error("CONNECTION_SAVE_ERROR", error),
        }
    }

    #[tool(name = "dbx_remove_connection", description = "Remove a database connection from DBX")]
    async fn remove_connection(&self, Parameters(request): Parameters<RemoveConnectionRequest>) -> CallToolResult {
        if let Err(error) = self.ensure_tool_allowed("dbx_remove_connection").await {
            return error;
        }
        let policy = match self.load_policy().await {
            Ok(policy) => policy,
            Err(error) => return error,
        };
        if policy.read_only {
            return tool_error(
                "MCP_READ_ONLY",
                "DBX global MCP read-only mode is enabled. Connection management is not allowed.",
            );
        }
        let connections = match self.backend.load_connections().await {
            Ok(connections) => connections,
            Err(error) => return tool_error("CONNECTION_LOAD_ERROR", error),
        };
        let target = if let Some(id) = request.connection_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
            connections.iter().find(|connection| connection.id == id).cloned()
        } else {
            let Some(name) = request.connection_name.as_deref().map(str::trim).filter(|name| !name.is_empty()) else {
                return tool_error("CONNECTION_NOT_FOUND", "Either connection_id or connection_name is required.");
            };
            let matching = connections
                .iter()
                .filter(|connection| connection.name.eq_ignore_ascii_case(name))
                .cloned()
                .collect::<Vec<_>>();
            if matching.len() > 1 {
                return tool_error("AMBIGUOUS_CONNECTION", ambiguous_connections(name, &matching));
            }
            matching.into_iter().next()
        };
        let Some(target) = target else {
            return tool_error(
                "CONNECTION_NOT_FOUND",
                request
                    .connection_id
                    .as_deref()
                    .filter(|id| !id.trim().is_empty())
                    .map(|id| format!("Connection with id \"{id}\" not found."))
                    .unwrap_or_else(|| {
                        format!("Connection \"{}\" not found.", request.connection_name.as_deref().unwrap_or_default())
                    }),
            );
        };
        let group_paths = match self.load_group_paths_for_policy(&policy).await {
            Ok(paths) => paths,
            Err(error) => return backend_tool_error("MCP_POLICY_UNAVAILABLE", error),
        };
        if !policy_allows_connection(&policy, group_paths.get(&target.id), &target) {
            return tool_error(
                "CONNECTION_OUT_OF_SCOPE",
                format!("Connection \"{}\" is not allowed by DBX MCP settings.", target.id),
            );
        }
        match self.backend.remove_connection_for_mcp(&target.id).await {
            Ok(true) => text(format!("Connection \"{}\" (id: {}) removed.", target.name, target.id)),
            Ok(false) => tool_error("CONNECTION_NOT_FOUND", format!("Connection \"{}\" not found.", target.name)),
            Err(error) => backend_tool_error("CONNECTION_SAVE_ERROR", error),
        }
    }

    #[tool(name = "dbx_open_table", description = "Open a table in DBX desktop app. Requires DBX to be running.")]
    async fn open_table(&self, Parameters(request): Parameters<OpenTableRequest>) -> CallToolResult {
        if let Err(error) = self.ensure_tool_allowed("dbx_open_table").await {
            return error;
        }
        let resolved = match self.resolve_connection(&request.selector).await {
            Ok(resolved) => resolved,
            Err(error) => return error,
        };
        let connection = &resolved.connection;
        let database = match self.resolve_database(request.database, &resolved) {
            Ok(database) => database,
            Err(error) => return error,
        };
        let schema = match self.resolve_schema(request.schema) {
            Ok(schema) => schema,
            Err(error) => return error,
        };
        match self
            .backend
            .bridge_request(
                "/open-table",
                json!({
                    "connection_id": connection.id,
                    "connection_name": connection.name,
                    "table": request.table,
                    "database": database,
                    "schema": schema,
                }),
            )
            .await
        {
            Ok(()) => text(format!("Opened {} in DBX", request.table)),
            Err(error) => backend_tool_error("DBX_NOT_RUNNING", error),
        }
    }

    #[tool(
        name = "dbx_execute_and_show",
        description = "Execute a SQL query in DBX desktop app UI and show results there. Requires DBX to be running."
    )]
    async fn execute_and_show(&self, Parameters(request): Parameters<ExecuteAndShowRequest>) -> CallToolResult {
        if let Err(error) = self.ensure_tool_allowed("dbx_execute_and_show").await {
            return error;
        }
        let resolved = match self.resolve_connection(&request.selector).await {
            Ok(resolved) => resolved,
            Err(error) => return error,
        };
        let connection = &resolved.connection;
        if connection.db_type == DatabaseType::Redis {
            return tool_error("REDIS_COMMAND_REQUIRED", "Use dbx_execute_redis_command for Redis connections.");
        }
        let database = match self.resolve_database(request.database, &resolved) {
            Ok(database) => database,
            Err(error) => return error,
        };
        let policy =
            effective_policy_for_database_with_groups(&resolved.policy, &resolved.group_ids, connection, &database);
        if connection.db_type != DatabaseType::MongoDb {
            if let Err(error) = ensure_sql_database_scope(&resolved.database_scope, connection, &database, &request.sql)
            {
                return error;
            }
            if let Err(error) =
                ensure_sql_database_execution_scope(&resolved.policy, connection, &database, &request.sql)
            {
                return error;
            }
        }
        let permissions = if connection.db_type == DatabaseType::MongoDb {
            mcp_permissions(connection, &policy)
        } else {
            match validate_sql_policy(connection, &policy, &database, &request.sql, false) {
                Ok(permissions) => permissions,
                Err(error) => return error,
            }
        };
        if connection.db_type == DatabaseType::MongoDb {
            if let Err(error) = validate_mongo_command_with_groups(
                connection,
                &resolved.policy,
                &resolved.group_ids,
                &resolved.database_scope,
                &database,
                &request.sql,
            ) {
                return error;
            }
        }
        match self
            .backend
            .bridge_request(
                "/execute-query",
                json!({
                    "connection_id": connection.id,
                    "connection_name": connection.name,
                    "sql": request.sql,
                    "database": database,
                    "allow_writes": permissions.allow_writes,
                    "allow_dangerous": permissions.allow_dangerous,
                }),
            )
            .await
        {
            Ok(()) => text("Query sent to DBX"),
            Err(error) => backend_tool_error("DBX_NOT_RUNNING", error),
        }
    }

    #[tool(
        name = "dbx_salesforce_current_user",
        description = "Show the Salesforce identity behind a DBX connection: the connected user, their profile, whether that profile holds \"Modify All Data\" (which bypasses field-level security and record sharing), and the org. Read-only. Call it before preparing a write so the user knows who the change will be attributed to, and to tell a permission failure apart from a bad record Id."
    )]
    async fn salesforce_current_user(
        &self,
        Parameters(request): Parameters<SalesforceIdentityRequest>,
    ) -> CallToolResult {
        if let Err(error) = self.ensure_tool_allowed("dbx_salesforce_current_user").await {
            return error;
        }
        let resolved = match self.resolve_connection(&request.selector).await {
            Ok(resolved) => resolved,
            Err(error) => return error,
        };
        let connection = &resolved.connection;
        if connection.db_type != DatabaseType::Salesforce {
            return not_salesforce_error(connection);
        }
        match self.backend.salesforce_current_user(connection).await {
            Ok(identity) => {
                let mut result = text(format_salesforce_identity_block(connection, Some(&identity)));
                result.structured_content = Some(salesforce_identity_json(&identity));
                result
            }
            Err(error) => tool_error("SALESFORCE_IDENTITY_ERROR", error),
        }
    }

    #[tool(
        name = "dbx_salesforce_prepare_write",
        description = "Step 1 of 2 for a Salesforce write: prepare an insert, update or delete of exactly ONE record. Nothing is sent to Salesforce. The call validates the request against DBX MCP policy and returns a human-readable summary plus a single-use confirm_token. Show that summary to the user and wait for their approval, then call dbx_salesforce_apply_write with the token. Salesforce has no transactions, so an applied write cannot be rolled back. Reads never need this: use dbx_execute_query with SOQL."
    )]
    async fn salesforce_prepare_write(
        &self,
        Parameters(request): Parameters<SalesforcePrepareWriteRequest>,
    ) -> CallToolResult {
        if let Err(error) = self.ensure_tool_allowed("dbx_salesforce_prepare_write").await {
            return error;
        }
        let resolved = match self.resolve_connection(&request.selector).await {
            Ok(resolved) => resolved,
            Err(error) => return error,
        };
        let connection = &resolved.connection;
        if connection.db_type != DatabaseType::Salesforce {
            return not_salesforce_error(connection);
        }
        let database = match self.resolve_database(request.database, &resolved) {
            Ok(database) => database,
            Err(error) => return error,
        };
        if !connection_allows_salesforce_dml(&resolved.policy, &connection.id) {
            return tool_error(
                "SALESFORCE_DML_DISABLED",
                format!(
                    "Salesforce writes are disabled for connection \"{}\". The user has to enable the \"Allow DML\" switch for this connection in DBX Settings → MCP, and the connection must not be read-only. Reads are unaffected: use dbx_execute_query with SOQL.",
                    connection.name
                ),
            );
        }
        let statement = match build_salesforce_dml_statement(
            &request.op,
            &request.object,
            request.id.as_deref(),
            request.fields.as_ref(),
        ) {
            Ok(statement) => statement,
            Err(error) => return tool_error("SALESFORCE_DML_INVALID", error),
        };
        // The driver is the authority on what a statement means. Refusing here
        // rather than at apply time means a token is never handed out for a write
        // the org would reject.
        if let Err(error) = parse_salesforce_statement(&statement) {
            return tool_error("SALESFORCE_DML_INVALID", error);
        }
        let policy =
            effective_policy_for_database_with_groups(&resolved.policy, &resolved.group_ids, connection, &database);
        // The same envelope every other statement passes through: global and
        // connection read-only rules, the high-risk tier for a write whose scope
        // the classifier cannot pin down, and the production block. SOQL and the
        // DML pseudo-command cannot name another database, so the SQL
        // database-scope guards have nothing to add here.
        if let Err(error) = validate_sql_policy(connection, &policy, &database, &statement, false) {
            return error;
        }
        // Best effort: a failed identity lookup must not block the confirmation,
        // it only leaves the "signed in as" line out of the summary.
        let identity = self.backend.salesforce_current_user(connection).await.ok();
        let token = format!("sfdml-{}", Uuid::new_v4());
        let expires_in_secs = self.pending_salesforce_writes.ttl_secs();
        self.pending_salesforce_writes
            .insert(
                token.clone(),
                PendingSalesforceWrite {
                    connection_id: connection.id.clone(),
                    database: database.clone(),
                    statement: statement.clone(),
                    created_at: Instant::now(),
                },
            )
            .await;
        let summary =
            format_salesforce_write_summary(&statement, connection, identity.as_ref(), &token, expires_in_secs);
        let mut result = text(summary);
        result.structured_content = Some(json!({
            "confirm_token": token,
            "expires_in_secs": expires_in_secs,
            "connection_id": connection.id,
            "statement": statement,
            "identity": identity.as_ref().map(salesforce_identity_json),
        }));
        result
    }

    #[tool(
        name = "dbx_salesforce_apply_write",
        description = "Step 2 of 2 for a Salesforce write: execute exactly the write prepared by dbx_salesforce_prepare_write, identified by its confirm_token. The token is single-use, expires 5 minutes after it was issued, and is bound to that one statement — a changed write needs a new prepare. Call this only after the user has approved the summary they were shown. Returns the Salesforce result, or the org's own per-record error text."
    )]
    async fn salesforce_apply_write(
        &self,
        Parameters(request): Parameters<SalesforceApplyWriteRequest>,
    ) -> CallToolResult {
        if let Err(error) = self.ensure_tool_allowed("dbx_salesforce_apply_write").await {
            return error;
        }
        let Some(pending) = self.pending_salesforce_writes.take(&request.confirm_token).await else {
            return tool_error(
                "CONFIRM_TOKEN_INVALID",
                format!(
                    "No pending Salesforce write for confirm_token \"{}\". Tokens are single-use and expire {} seconds after they are issued; call dbx_salesforce_prepare_write again and show the new summary to the user.",
                    request.confirm_token.trim(),
                    self.pending_salesforce_writes.ttl_secs()
                ),
            );
        };
        // Re-read the connection and the whole policy envelope at apply time: the
        // user may have flipped the connection to read-only, withdrawn the DML
        // opt-in or narrowed the scope while the summary was on screen.
        let resolved = match self
            .resolve_connection(&ConnectionSelector {
                connection_id: Some(pending.connection_id.clone()),
                connection_name: None,
            })
            .await
        {
            Ok(resolved) => resolved,
            Err(error) => return error,
        };
        let connection = &resolved.connection;
        if connection.db_type != DatabaseType::Salesforce {
            return not_salesforce_error(connection);
        }
        if !connection_allows_salesforce_dml(&resolved.policy, &connection.id) {
            return tool_error(
                "SALESFORCE_DML_DISABLED",
                format!(
                    "Salesforce writes were disabled for connection \"{}\" after this write was prepared. Nothing was sent. Re-enable the \"Allow DML\" switch in DBX Settings → MCP and prepare the write again.",
                    connection.name
                ),
            );
        }
        let policy = effective_policy_for_database_with_groups(
            &resolved.policy,
            &resolved.group_ids,
            connection,
            &pending.database,
        );
        let permissions = match validate_sql_policy(connection, &policy, &pending.database, &pending.statement, false) {
            Ok(permissions) => permissions,
            Err(error) => return error,
        };
        let mut arguments = json!({ "sql": pending.statement, "limit": 1 });
        if let Some(secs) = resolved.policy.query_timeout_secs {
            arguments["timeout_secs"] = json!(secs);
        }
        let label = salesforce_write_label(&pending.statement);
        let started_at = Instant::now();
        let result = self
            .backend
            .execute_agent_tool(connection, &pending.database, "execute_query", arguments, permissions)
            .await;
        let success = !result.is_error;
        let error = result.is_error.then(|| result.content.trim_start_matches("Error: ").to_string());
        self.save_mcp_sql_history(connection, &pending.database, &pending.statement, started_at, success, error, None)
            .await;
        if !success {
            return agent_result(result);
        }
        text(format!("Salesforce write applied: {label}.\n{}", result.content))
    }
}

impl DbxMcpServer {
    async fn list_databases_for_resolved(&self, resolved: &ResolvedConnection) -> CallToolResult {
        if resolved.connection.db_type == DatabaseType::Salesforce
            && !matches!(resolved.database_scope, DatabaseScope::None)
        {
            // An org has no database layer, so an empty list would read as a
            // broken connection. Point at the surface that does exist instead.
            return text(
                "Salesforce has no databases: the whole org is one scope.\n\
                 List its objects with dbx_list_tables, then read them with dbx_execute_query using SOQL, e.g. SELECT Id, Name FROM Account LIMIT 10.\n\
                 Writes go through dbx_salesforce_prepare_write and dbx_salesforce_apply_write.",
            );
        }
        match &resolved.database_scope {
            DatabaseScope::None => tool_error(
                "DATABASE_OUT_OF_SCOPE",
                "This connection is configured with no database access in DBX MCP settings.",
            ),
            DatabaseScope::Selected(databases) => text(format_database_names(databases)),
            DatabaseScope::All => match self.backend.list_databases(&resolved.connection).await {
                Ok(databases) => text(format_database_names(&databases)),
                Err(error) => tool_error("DATABASE_LIST_ERROR", error),
            },
        }
    }

    async fn load_scoped_connections(&self) -> Result<Vec<dbx_core::models::connection::ConnectionConfig>, String> {
        let policy = self.backend.load_mcp_global_policy().await?;
        let connections = self.backend.load_connections().await?;
        let group_paths = self.load_group_paths_for_policy(&policy).await?;
        Ok(connections
            .into_iter()
            .filter(|connection| policy_allows_connection(&policy, group_paths.get(&connection.id), connection))
            .filter(|connection| !self.scope.connection_scope_enabled() || self.scope.matches(connection))
            .collect())
    }

    async fn load_group_paths_for_policy(
        &self,
        policy: &McpGlobalPolicy,
    ) -> Result<HashMap<String, dbx_core::mcp_policy::McpConnectionGroupPath>, String> {
        match self.backend.load_connection_group_details().await {
            Ok(paths) => Ok(paths),
            Err(error) if dbx_core::mcp_policy::policy_uses_connection_groups(policy) => {
                Err(format!("MCP_POLICY_UNAVAILABLE: {error}"))
            }
            Err(_) => Ok(HashMap::new()),
        }
    }

    // CallToolResult is the rmcp wire response type; keeping it unboxed avoids conversions at every tool boundary.
    #[allow(clippy::result_large_err)]
    async fn load_policy(&self) -> Result<McpGlobalPolicy, CallToolResult> {
        self.backend.load_mcp_global_policy().await.map_err(|error| backend_tool_error("MCP_POLICY_UNAVAILABLE", error))
    }

    // CallToolResult is the rmcp wire response type; keeping it unboxed avoids conversions at every tool boundary.
    #[allow(clippy::result_large_err)]
    async fn validate_transaction_control(&self, session: &McpSession, operation: &str) -> Result<(), CallToolResult> {
        let resolved = self
            .resolve_connection(&ConnectionSelector {
                connection_id: Some(session.connection_id.clone()),
                connection_name: None,
            })
            .await?;
        if !transaction_connection_supported(&resolved.connection) {
            return Err(tool_error(
                "TRANSACTION_UNSUPPORTED",
                "The session connection is no longer a native MySQL connection.",
            ));
        }
        ensure_database_in_scope(&resolved.database_scope, &session.database)?;
        let policy = effective_policy_for_database_with_groups(
            &resolved.policy,
            &resolved.group_ids,
            &resolved.connection,
            &session.database,
        );
        if policy.read_only {
            return Err(tool_error(
                "MCP_READ_ONLY",
                format!("MCP execution permission is read-only; {operation} is write-capable."),
            ));
        }
        if resolved.connection.read_only {
            return Err(tool_error(
                "CONNECTION_READ_ONLY",
                format!("Connection \"{}\" is read-only; {operation} is blocked.", resolved.connection.name),
            ));
        }
        if is_production_database(&resolved.connection, &session.database) {
            return Err(tool_error(
                "PRODUCTION_WRITE_BLOCKED",
                format!("{operation} is not allowed against a production database."),
            ));
        }
        Ok(())
    }

    // CallToolResult is the rmcp wire response type; keeping it unboxed avoids conversions at every tool boundary.
    #[allow(clippy::result_large_err)]
    async fn ensure_tool_allowed(&self, tool_name: &str) -> Result<(), CallToolResult> {
        let policy = self.load_policy().await?;
        if policy_allows_tool(&policy, tool_name) {
            Ok(())
        } else {
            Err(tool_error("TOOL_OUT_OF_SCOPE", format!("Tool \"{tool_name}\" is not allowed by DBX MCP settings.")))
        }
    }

    /// The advertised `tools/list` view: router-enabled tools narrowed to the
    /// global policy's tool allowlist. When the policy cannot be loaded every
    /// tool call already fails with `MCP_POLICY_UNAVAILABLE`, so fall back to
    /// the plain router view rather than adding a new failure mode here.
    async fn policy_filtered_tools(&self) -> Vec<rmcp::model::Tool> {
        match self.load_policy().await {
            Ok(policy) => self
                .tool_router
                .list_all()
                .into_iter()
                .filter(|tool| policy_allows_tool(&policy, tool.name.as_ref()))
                .collect(),
            Err(_) => self.tool_router.list_all(),
        }
    }

    // CallToolResult is the rmcp wire response type; keeping it unboxed avoids conversions at every tool boundary.
    #[allow(clippy::result_large_err)]
    fn resolve_database(
        &self,
        requested: Option<String>,
        resolved: &ResolvedConnection,
    ) -> Result<String, CallToolResult> {
        let requested = requested.map(|database| database.trim().to_string()).filter(|database| !database.is_empty());
        let database = if let Some(scoped) = self.scope.database.as_deref() {
            if let Some(requested) = requested.as_deref() {
                if requested != scoped {
                    return Err(tool_error(
                        "DATABASE_OUT_OF_SCOPE",
                        format!("Database \"{requested}\" is outside the scoped database \"{scoped}\"."),
                    ));
                }
            }
            scoped.to_string()
        } else {
            requested.or_else(|| resolved.connection.database.clone()).unwrap_or_default()
        };
        ensure_database_in_scope(&resolved.database_scope, &database)?;
        Ok(database)
    }

    /// Resolve the schema for scoped CLI agents. A selected schema is a hard
    /// bound, matching the existing database scope behavior.
    #[allow(clippy::result_large_err)]
    fn resolve_schema(&self, requested: Option<String>) -> Result<String, CallToolResult> {
        let requested = requested.map(|schema| schema.trim().to_string()).filter(|schema| !schema.is_empty());
        if let Some(scoped) = self.scope.schema.as_deref() {
            if let Some(requested) = requested.as_deref() {
                if requested != scoped {
                    return Err(tool_error(
                        "SCHEMA_OUT_OF_SCOPE",
                        format!("Schema \"{requested}\" is outside the scoped schema \"{scoped}\"."),
                    ));
                }
            }
            return Ok(scoped.to_string());
        }
        Ok(requested.unwrap_or_default())
    }

    // CallToolResult is the rmcp wire response type; keeping it unboxed avoids conversions at every tool boundary.
    #[allow(clippy::result_large_err)]
    fn resolve_redis_database(
        &self,
        requested: Option<u32>,
        resolved: &ResolvedConnection,
    ) -> Result<u32, CallToolResult> {
        if let Some(scoped) = self.scope.database.as_deref() {
            let scoped_database = parse_redis_database(scoped).ok_or_else(|| {
                tool_error(
                    "INVALID_DATABASE_SCOPE",
                    format!("Redis database scope \"{scoped}\" must be a non-negative integer."),
                )
            })?;
            if let Some(requested) = requested {
                if requested != scoped_database {
                    return Err(tool_error(
                        "DATABASE_OUT_OF_SCOPE",
                        format!("Redis database {requested} is outside the scoped database {scoped_database}."),
                    ));
                }
            }
            ensure_database_in_scope(&resolved.database_scope, &scoped_database.to_string())?;
            return Ok(scoped_database);
        }
        let database = requested.or_else(|| redis_database(&resolved.connection)).unwrap_or(0);
        ensure_database_in_scope(&resolved.database_scope, &database.to_string())?;
        Ok(database)
    }

    // CallToolResult is the rmcp wire response type; keeping it unboxed avoids conversions at every tool boundary.
    #[allow(clippy::result_large_err)]
    async fn resolve_connection(&self, selector: &ConnectionSelector) -> Result<ResolvedConnection, CallToolResult> {
        let policy = self.load_policy().await?;
        let group_paths = self
            .load_group_paths_for_policy(&policy)
            .await
            .map_err(|error| backend_tool_error("MCP_POLICY_UNAVAILABLE", error))?;
        let connections =
            self.backend.load_connections().await.map_err(|error| tool_error("CONNECTION_LOAD_ERROR", error))?;
        if let Some(id) = selector.connection_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
            let connection = connections
                .into_iter()
                .find(|connection| connection.id == id)
                .ok_or_else(|| tool_error("CONNECTION_NOT_FOUND", format!("Connection with id \"{id}\" not found.")))?;
            if self.scope.connection_scope_enabled() && !self.scope.matches(&connection) {
                return Err(tool_error(
                    "CONNECTION_OUT_OF_SCOPE",
                    format!("Connection \"{id}\" is outside this DBX AI session scope."),
                ));
            }
            if !policy_allows_connection(&policy, group_paths.get(&connection.id), &connection) {
                return Err(tool_error(
                    "CONNECTION_OUT_OF_SCOPE",
                    format!("Connection \"{id}\" is not allowed by DBX MCP settings."),
                ));
            }
            return Ok(resolved_connection(policy, connection, group_paths.get(id)));
        }
        if self.scope.connection_scope_enabled() {
            let connection = connections
                .into_iter()
                .find(|connection| self.scope.matches(connection))
                .ok_or_else(|| tool_error("CONNECTION_NOT_FOUND", "Scoped DBX connection was not found."))?;
            if let Some(name) = selector.connection_name.as_deref().map(str::trim).filter(|name| !name.is_empty()) {
                if name != connection.name && name != connection.id {
                    return Err(tool_error(
                        "CONNECTION_OUT_OF_SCOPE",
                        format!("Connection \"{name}\" is outside this DBX AI session scope."),
                    ));
                }
            }
            if !policy_allows_connection(&policy, group_paths.get(&connection.id), &connection) {
                return Err(tool_error(
                    "CONNECTION_OUT_OF_SCOPE",
                    "The DBX AI session scope is outside the global MCP connection allowlist.",
                ));
            }
            let path = group_paths.get(&connection.id);
            return Ok(resolved_connection(policy, connection, path));
        }
        let Some(name) = selector.connection_name.as_deref().map(str::trim).filter(|name| !name.is_empty()) else {
            return Err(tool_error("CONNECTION_NOT_FOUND", "Either connection_id or connection_name is required."));
        };
        let matching =
            connections.into_iter().filter(|connection| connection.name.eq_ignore_ascii_case(name)).collect::<Vec<_>>();
        let allowed = matching
            .iter()
            .filter(|connection| policy_allows_connection(&policy, group_paths.get(&connection.id), connection))
            .cloned()
            .collect::<Vec<_>>();
        match allowed.as_slice() {
            [] if matching.is_empty() => {
                Err(tool_error("CONNECTION_NOT_FOUND", format!("Connection \"{name}\" not found.")))
            }
            [] => Err(tool_error(
                "CONNECTION_OUT_OF_SCOPE",
                format!("Connection \"{name}\" is not allowed by DBX MCP settings."),
            )),
            [connection] => Ok(resolved_connection(policy, connection.clone(), group_paths.get(&connection.id))),
            _ => Err(tool_error("AMBIGUOUS_CONNECTION", ambiguous_connections(name, &allowed))),
        }
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for DbxMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().enable_resources().build())
            .with_server_info(Implementation::new("dbx", env!("CARGO_PKG_VERSION")))
            .with_instructions("Use DBX connections to inspect schemas and query databases safely.")
    }

    async fn list_resources(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        let tools = self.policy_filtered_tools().await;
        let resources = tools
            .iter()
            .any(|tool| tool.name.as_ref() == "dbx_list_connections")
            .then(|| {
                Resource::new(CONNECTIONS_RESOURCE_URI, "dbx_connections")
                    .with_title("DBX connections")
                    .with_description("Database connections visible to the current DBX MCP scope")
                    .with_mime_type("text/markdown")
            })
            .into_iter()
            .collect();
        Ok(ListResourcesResult { resources, meta: None, next_cursor: None })
    }

    async fn list_resource_templates(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Result<ListResourceTemplatesResult, ErrorData> {
        let tools = self.policy_filtered_tools().await;
        let has_tool = |name: &str| tools.iter().any(|tool| tool.name.as_ref() == name);
        let mut resource_templates = Vec::new();
        if has_tool("dbx_list_databases") {
            resource_templates.push(
                ResourceTemplate::new(DATABASES_RESOURCE_TEMPLATE, "dbx_connection_databases")
                    .with_title("DBX connection databases")
                    .with_description("Databases visible through a DBX connection")
                    .with_mime_type("text/markdown"),
            );
        }
        if has_tool("dbx_list_tables") {
            resource_templates.push(
                ResourceTemplate::new(TABLES_RESOURCE_TEMPLATE, "dbx_connection_tables")
                    .with_title("DBX connection tables")
                    .with_description("Tables and views visible through a DBX connection and optional database/schema")
                    .with_mime_type("text/markdown"),
            );
        }
        if has_tool("dbx_describe_table") {
            resource_templates.push(
                ResourceTemplate::new(TABLE_SCHEMA_RESOURCE_TEMPLATE, "dbx_table_schema")
                    .with_title("DBX table schema")
                    .with_description("Column definitions for a table visible through a DBX connection")
                    .with_mime_type("text/markdown"),
            );
        }
        Ok(ListResourceTemplatesResult { resource_templates, meta: None, next_cursor: None })
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Result<ReadResourceResult, ErrorData> {
        let uri = request.uri;
        let result = match parse_dbx_resource_uri(&uri)? {
            DbxResourceRequest::Connections => self.list_connections(Parameters(ListConnectionsRequest {})).await,
            DbxResourceRequest::Databases { connection_id } => {
                self.list_databases(Parameters(ListDatabasesRequest {
                    selector: ConnectionSelector { connection_id: Some(connection_id), connection_name: None },
                }))
                .await
            }
            DbxResourceRequest::Tables { connection_id, database, schema } => {
                self.list_tables(Parameters(ListTablesRequest {
                    selector: ConnectionSelector { connection_id: Some(connection_id), connection_name: None },
                    database,
                    schema,
                }))
                .await
            }
            DbxResourceRequest::TableSchema { connection_id, database, schema, table } => {
                self.describe_table(Parameters(DescribeTableRequest {
                    selector: ConnectionSelector { connection_id: Some(connection_id), connection_name: None },
                    table,
                    database,
                    schema,
                }))
                .await
            }
        };
        resource_result_from_tool(uri, result)
    }

    /// Hide tools the global policy disallows from the advertised list, the
    /// same way scope-based route disabling does. Per-call enforcement stays
    /// in `ensure_tool_allowed`; this only stops clients (especially LLMs)
    /// from seeing — and repeatedly retrying — capabilities that would be
    /// rejected anyway. When the policy cannot be loaded, every call already
    /// fails with `MCP_POLICY_UNAVAILABLE`, so the listing falls back to the
    /// router view instead of adding a new failure mode here.
    async fn list_tools(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> Result<rmcp::model::ListToolsResult, rmcp::ErrorData> {
        Ok(rmcp::model::ListToolsResult { tools: self.policy_filtered_tools().await, meta: None, next_cursor: None })
    }
}

fn parse_dbx_resource_uri(uri: &str) -> Result<DbxResourceRequest, ErrorData> {
    let parsed = Url::parse(uri).map_err(|_| ErrorData::invalid_params("Invalid DBX resource URI.", None))?;
    if parsed.scheme() != "dbx"
        || parsed.host_str() != Some("connections")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
        || parsed.fragment().is_some()
    {
        return Err(ErrorData::resource_not_found(format!("Unknown DBX resource: {uri}"), None));
    }

    let path = parsed.path().trim_matches('/');
    let segments = if path.is_empty() { Vec::new() } else { path.split('/').collect::<Vec<_>>() };
    let mut query = HashMap::new();
    for (key, value) in parsed.query_pairs() {
        let key = key.into_owned();
        if query.insert(key.clone(), value.into_owned()).is_some() {
            return Err(ErrorData::invalid_params(format!("Duplicate DBX resource parameter: {key}"), None));
        }
    }

    match segments.as_slice() {
        [] => {
            reject_resource_parameters(&query, &[])?;
            Ok(DbxResourceRequest::Connections)
        }
        [connection_id, "databases"] => {
            reject_resource_parameters(&query, &[])?;
            Ok(DbxResourceRequest::Databases {
                connection_id: required_resource_value("connection_id", connection_id)?,
            })
        }
        [connection_id, "tables"] => {
            reject_resource_parameters(&query, &["database", "schema"])?;
            Ok(DbxResourceRequest::Tables {
                connection_id: required_resource_value("connection_id", connection_id)?,
                database: optional_resource_parameter(&query, "database"),
                schema: optional_resource_parameter(&query, "schema"),
            })
        }
        [connection_id, "table-schema"] => {
            reject_resource_parameters(&query, &["database", "schema", "table"])?;
            Ok(DbxResourceRequest::TableSchema {
                connection_id: required_resource_value("connection_id", connection_id)?,
                database: optional_resource_parameter(&query, "database"),
                schema: optional_resource_parameter(&query, "schema"),
                table: required_resource_parameter(&query, "table")?,
            })
        }
        _ => Err(ErrorData::resource_not_found(format!("Unknown DBX resource: {uri}"), None)),
    }
}

fn reject_resource_parameters(parameters: &HashMap<String, String>, allowed: &[&str]) -> Result<(), ErrorData> {
    if let Some(name) = parameters.keys().find(|name| !allowed.contains(&name.as_str())) {
        return Err(ErrorData::invalid_params(format!("Unknown DBX resource parameter: {name}"), None));
    }
    Ok(())
}

fn optional_resource_parameter(parameters: &HashMap<String, String>, name: &str) -> Option<String> {
    parameters.get(name).map(|value| value.trim()).filter(|value| !value.is_empty()).map(str::to_string)
}

fn required_resource_parameter(parameters: &HashMap<String, String>, name: &str) -> Result<String, ErrorData> {
    optional_resource_parameter(parameters, name)
        .ok_or_else(|| ErrorData::invalid_params(format!("Missing DBX resource parameter: {name}"), None))
}

fn required_resource_value(name: &str, value: &str) -> Result<String, ErrorData> {
    let value = value.trim();
    if value.is_empty() {
        Err(ErrorData::invalid_params(format!("Missing DBX resource parameter: {name}"), None))
    } else {
        Ok(value.to_string())
    }
}

fn resource_result_from_tool(uri: String, result: CallToolResult) -> Result<ReadResourceResult, ErrorData> {
    let output = result
        .content
        .iter()
        .filter_map(|content| content.as_text().map(|text| text.text.as_str()))
        .collect::<Vec<_>>()
        .join("\n");
    if result.is_error == Some(true) {
        let message = if output.is_empty() { "DBX resource read failed.".to_string() } else { output };
        return Err(ErrorData::invalid_params(message, Some(json!({ "uri": uri }))));
    }
    if output.is_empty() {
        return Err(ErrorData::internal_error("DBX resource returned no text content.", Some(json!({ "uri": uri }))));
    }
    Ok(ReadResourceResult::new(vec![ResourceContents::text(output, uri).with_mime_type("text/markdown")]))
}

fn text(value: impl Into<String>) -> CallToolResult {
    CallToolResult::success(vec![ContentBlock::text(value)])
}

async fn cancellable_tool_call(
    cancellation: tokio_util::sync::CancellationToken,
    operation: impl std::future::Future<Output = CallToolResult>,
) -> CallToolResult {
    tokio::select! {
        result = operation => result,
        _ = cancellation.cancelled() => tool_error("REQUEST_CANCELLED", "The MCP request was cancelled."),
    }
}

fn transaction_success_result(session_id: &str, message: &str, execution: TransactionResult) -> CallToolResult {
    let mut result = text(format!(
        "{message}\nsession_id: {session_id}\ntransaction_state: {}{}",
        execution.state.as_str(),
        execution.outcome.map(|outcome| format!("\ntransaction_outcome: {}", outcome.as_str())).unwrap_or_default()
    ));
    result.structured_content = Some(json!({
        "session_id": session_id,
        "transaction_state": execution.state,
        "transaction_outcome": execution.outcome,
        "result": execution.result,
    }));
    result
}

fn transaction_failure_result(session_id: &str, failure: TransactionFailure) -> CallToolResult {
    let mut result = tool_error(failure.code, &failure.message);
    result.structured_content = Some(json!({
        "session_id": session_id,
        "transaction_state": failure.state,
        "transaction_outcome": failure.outcome,
        "mysql_code": failure.mysql_code,
        "error": failure.message,
    }));
    result
}

fn tool_error(code: &str, message: impl Into<String>) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(format!("Error [{code}]: {}", message.into()))])
}

fn backend_tool_error(default_code: &str, error: impl Into<String>) -> CallToolResult {
    let error = error.into();
    for code in [
        "MCP_POLICY_UNAVAILABLE",
        "MCP_READ_ONLY",
        "CONNECTION_OUT_OF_SCOPE",
        "DATABASE_OUT_OF_SCOPE",
        "DATABASE_EXECUTION_POLICY_OUT_OF_SCOPE",
        "INVALID_DATABASE_SCOPE",
        "CONNECTION_READ_ONLY",
        "PRODUCTION_DATABASE_READ_ONLY",
        "PRODUCTION_WRITE_BLOCKED",
        "SQL_BLOCKED",
        "TRANSACTION_UNSUPPORTED",
    ] {
        let marker = format!("{code}:");
        if let Some(index) = error.find(&marker) {
            return tool_error(code, error[index + marker.len()..].trim());
        }
    }
    tool_error(default_code, error)
}

/// Keep older MCP clients compatible with the original single-query tool when
/// they send a complete SQL script. The batch executor removes client-side
/// commands such as MySQL `DELIMITER` and preserves semicolons inside routine
/// bodies before dispatching statements to the database.
fn sql_requires_batch_execution(sql: &str, database_type: DatabaseType) -> bool {
    if sql.lines().any(|line| line.trim_start().to_ascii_lowercase().starts_with("delimiter ")) {
        return true;
    }
    dbx_core::sql::sql_execution_plan_for_database(sql, database_type).statements.len() > 1
}

/// Maximum rows returned per statement in a `dbx_execute_batch` call. The batch
/// executor is deliberately tighter than dbx_execute_query's default: a script
/// has many statements, so its row budget multiplies.
const BATCH_MAX_ROWS: usize = 100;

fn mcp_sql_activity_kind(sql: &str, database_type: DatabaseType) -> &'static str {
    if database_type == DatabaseType::Salesforce {
        // The generic path below derives the kind from SQL risk tiers, and the
        // Salesforce tiers deliberately fail closed: an unscoped or unrecognized
        // write lands in the DDL tier, which would file a record mutation under
        // "schema_change". Every Salesforce statement is either a SOQL read or a
        // DML write, so classify it as one unit instead.
        return match classify_salesforce_statement_risk(sql) {
            SalesforceStatementRisk::Read => "query",
            SalesforceStatementRisk::ScopedWrite | SalesforceStatementRisk::OpaqueWrite => "data_change",
        };
    }
    let risks = dbx_core::sql::sql_execution_plan_for_database(sql, database_type)
        .statements
        .into_iter()
        .filter_map(|statement| classify_sql_risk_for_database(&statement, database_type).ok())
        .collect::<Vec<_>>();
    if risks.contains(&SqlRisk::Ddl) {
        "schema_change"
    } else if risks.contains(&SqlRisk::Write) {
        "data_change"
    } else {
        "query"
    }
}

fn mcp_sql_operation(sql: &str, database_type: DatabaseType) -> String {
    if database_type == DatabaseType::Salesforce {
        // Naming the DML verb keeps history readable; "DBX" (the first word of
        // the pseudo-command header) would say nothing about what changed.
        return match classify_salesforce_statement_risk(sql) {
            SalesforceStatementRisk::Read => "SELECT".to_string(),
            SalesforceStatementRisk::ScopedWrite | SalesforceStatementRisk::OpaqueWrite => {
                parse_salesforce_statement(sql)
                    .map(|parsed| parsed.op.as_str().to_ascii_uppercase())
                    .unwrap_or_else(|_| "DML".to_string())
            }
        };
    }
    dbx_core::sql::sql_execution_plan_for_database(sql, database_type)
        .statements
        .first()
        .map(|statement| dbx_core::query_execution_sql::strip_sql_comments(statement))
        .and_then(|statement| statement.split_whitespace().next().map(str::to_string))
        .map(|operation| operation.trim_matches(|character: char| !character.is_ascii_alphabetic()).to_string())
        .filter(|operation| !operation.is_empty())
        .map(|operation| operation.to_ascii_uppercase())
        .unwrap_or_else(|| "SQL".to_string())
}

/// Render a multi-statement batch result as one Markdown text block per
/// statement. Each statement is labelled by its index so callers can see which
/// statement failed, how many rows each affected, or what each returned. A
/// `merged` entry (use_transaction mode) is labelled as the transaction outcome
/// instead of a per-statement result.
fn format_batch_results(results: &[crate::backend::BatchStatementResult], cell_window: QueryCellWindow) -> String {
    let mut output = String::new();
    for (index, result) in results.iter().enumerate() {
        if index > 0 {
            output.push('\n');
        }
        if result.merged {
            output.push_str("### Transaction outcome");
            output.push('\n');
            if result.execution_error {
                let message = result.error_message.as_deref().unwrap_or("Transaction failed");
                output.push_str(&format!("**Status:** failed\n\n{message}\n"));
            } else {
                let rendered = format_query_result_as_text(&result.result, BATCH_MAX_ROWS, cell_window)
                    .unwrap_or_else(|error| error);
                output.push_str(rendered.trim_start_matches("Query executed. "));
            }
            continue;
        }
        let heading = match result.statement_index {
            Some(statement_index) => format!("### Statement {}", statement_index + 1),
            None => format!("### Statement {}", index + 1),
        };
        output.push_str(&heading);
        output.push('\n');
        if result.execution_error {
            let message = result.error_message.as_deref().unwrap_or("Statement failed");
            output.push_str(&format!("**Status:** failed\n\n{message}\n"));
        } else {
            let rendered =
                format_query_result_as_text(&result.result, BATCH_MAX_ROWS, cell_window).unwrap_or_else(|error| error);
            output.push_str(rendered.trim_start_matches("Query executed. "));
        }
    }
    output
}

fn empty_query_result() -> dbx_core::db::QueryResult {
    dbx_core::db::QueryResult {
        columns: Vec::new(),
        column_types: Vec::new(),
        column_sortables: Vec::new(),
        spatial_columns: Vec::new(),
        spatial_values: Vec::new(),
        rows: Vec::new(),
        affected_rows: 0,
        execution_time_ms: 0,
        server_execute_time_us: None,
        query_timings_ms: None,
        truncated: false,
        session_id: None,
        has_more: false,
        elasticsearch_raw_body: None,
        messages: Vec::new(),
    }
}

fn agent_result(result: dbx_core::agent_events::ToolResult) -> CallToolResult {
    if result.is_error {
        backend_tool_error("DBX_TOOL_ERROR", result.content.trim_start_matches("Error: "))
    } else {
        text(result.content)
    }
}

fn policy_allows_connection(
    policy: &McpGlobalPolicy,
    group_path: Option<&dbx_core::mcp_policy::McpConnectionGroupPath>,
    connection: &dbx_core::models::connection::ConnectionConfig,
) -> bool {
    dbx_core::mcp_policy::policy_allows_connection(policy, group_path, &connection.id)
}

fn policy_allows_tool(policy: &McpGlobalPolicy, tool_name: &str) -> bool {
    policy.allowed_tool_names.as_ref().is_none_or(|allowed| allowed.iter().any(|name| name == tool_name))
}

fn database_scope_for_connection(
    policy: &McpGlobalPolicy,
    connection: &dbx_core::models::connection::ConnectionConfig,
) -> DatabaseScope {
    let Some(rule) = policy.connection_policies.iter().find(|rule| rule.connection_id == connection.id) else {
        return DatabaseScope::All;
    };
    match rule.database_scope {
        McpDatabaseScope::All => DatabaseScope::All,
        McpDatabaseScope::Selected => DatabaseScope::Selected(rule.allowed_databases.clone()),
        McpDatabaseScope::None => DatabaseScope::None,
    }
}

fn resolved_connection(
    policy: McpGlobalPolicy,
    connection: dbx_core::models::connection::ConnectionConfig,
    group_path: Option<&dbx_core::mcp_policy::McpConnectionGroupPath>,
) -> ResolvedConnection {
    let database_scope = database_scope_for_connection(&policy, &connection);
    let group_ids = group_path.map(|path| path.ids.clone()).unwrap_or_default();
    ResolvedConnection { connection, policy, database_scope, group_ids }
}

#[allow(clippy::result_large_err)]
fn ensure_database_in_scope(scope: &DatabaseScope, database: &str) -> Result<(), CallToolResult> {
    match scope {
        DatabaseScope::All => Ok(()),
        DatabaseScope::Selected(allowed) if allowed.iter().any(|allowed| allowed == database) => Ok(()),
        DatabaseScope::Selected(_) | DatabaseScope::None => Err(tool_error(
            "DATABASE_OUT_OF_SCOPE",
            format!("Database \"{database}\" is not allowed by DBX MCP settings for this connection."),
        )),
    }
}

/// A selected database scope applies to SQL object references as well as the
/// request-level `database` field. Without this guard an MCP client could pick
/// an allowed default and access another MySQL/SQL Server database through a
/// qualified name such as `other_db.users`.
#[allow(clippy::result_large_err)]
fn ensure_sql_database_scope(
    scope: &DatabaseScope,
    connection: &dbx_core::models::connection::ConnectionConfig,
    active_database: &str,
    sql: &str,
) -> Result<(), CallToolResult> {
    let DatabaseScope::Selected(allowed_databases) = scope else {
        return Ok(());
    };
    if sql_references_disallowed_database(sql, &connection.db_type, active_database, allowed_databases) {
        return Err(tool_error(
            "DATABASE_OUT_OF_SCOPE",
            "SQL references a database that is not allowed by DBX MCP settings for this connection.",
        ));
    }
    Ok(())
}

fn is_database_discovery_sql(sql: &str) -> bool {
    let normalized = sql.trim().trim_end_matches(';').trim().to_ascii_lowercase();
    matches!(normalized.as_str(), "show databases" | "show schemas")
}

fn format_database_names(databases: &[String]) -> String {
    if databases.is_empty() {
        "No databases are available through this MCP connection.".to_string()
    } else {
        databases.iter().map(|database| format!("- {database}")).collect::<Vec<_>>().join("\n")
    }
}

/// Execution modes are scoped defaults: a database rule overrides a configured
/// connection default, which in turn overrides the global default. Connection
/// read-only protection and production-database protections are enforced
/// separately and cannot be bypassed by these defaults.
#[cfg(test)]
fn effective_policy_for_database(
    policy: &McpGlobalPolicy,
    connection: &dbx_core::models::connection::ConnectionConfig,
    database: &str,
) -> McpGlobalPolicy {
    effective_policy_for_database_with_groups(policy, &[], connection, database)
}

fn effective_policy_for_database_with_groups(
    policy: &McpGlobalPolicy,
    group_ids: &[String],
    connection: &dbx_core::models::connection::ConnectionConfig,
    database: &str,
) -> McpGlobalPolicy {
    let mut policy = policy.clone();
    (policy.read_only, policy.allow_dangerous_sql) =
        dbx_core::mcp_policy::effective_database_execution_policy_with_groups(
            &policy,
            group_ids,
            &connection.id,
            database,
        );
    // This returned value is carried through the request only; retaining a
    // complete policy document here could accidentally be reused for another
    // connection by a future caller.
    policy.connection_policies.clear();
    policy
}

/// A database-level execution rule must not be bypassed by qualifying another
/// allowed database in SQL. Until individual references are evaluated with
/// their own policies, cross-database SQL is intentionally rejected whenever
/// this connection has database-specific execution rules.
#[allow(clippy::result_large_err)]
fn ensure_sql_database_execution_scope(
    policy: &McpGlobalPolicy,
    connection: &dbx_core::models::connection::ConnectionConfig,
    active_database: &str,
    sql: &str,
) -> Result<(), CallToolResult> {
    dbx_core::mcp_policy::ensure_sql_database_execution_scope(policy, connection, active_database, sql)
        .map_err(|error| tool_error("DATABASE_EXECUTION_POLICY_OUT_OF_SCOPE", error))
}

fn mcp_permissions(
    connection: &dbx_core::models::connection::ConnectionConfig,
    policy: &McpGlobalPolicy,
) -> dbx_core::agent_tools::AgentSqlPermissions {
    dbx_core::agent_tools::AgentSqlPermissions {
        allow_writes: !policy.read_only && !connection.read_only,
        allow_dangerous: !policy.read_only && !connection.read_only && policy.allow_dangerous_sql,
        confirmed_write_sql: mcp_confirmed_write_sql_from_env(),
    }
}

fn transaction_connection_supported(connection: &dbx_core::models::connection::ConnectionConfig) -> bool {
    crate::backend::native_mysql_transaction_connection(connection)
}

/// Read the DBX_MCP_CONFIRMED_WRITE_SQL env var (set by the CLI agent when the
/// user confirmed a specific write SQL). Returns None when the var is unset or
/// empty, so desktop-embedded MCP contexts (which don't set this var) continue
/// to work without a confirmed-SQL binding.
fn mcp_confirmed_write_sql_from_env() -> Option<String> {
    normalize_confirmed_write_sql(std::env::var("DBX_MCP_CONFIRMED_WRITE_SQL").ok())
}

fn normalize_confirmed_write_sql(value: Option<String>) -> Option<String> {
    let trimmed = value?.trim().to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// When the user confirmed a specific write SQL for this run, a batch that
/// contains a write/DDL statement must be exactly that confirmed SQL. Returns
/// the block message when the script differs from the confirmation and is not
/// read-only; `None` means the script is allowed (read-only, exact match, or
/// no binding). Unparseable SQL is treated as a write and fails closed.
fn confirmed_batch_sql_block_reason(
    sql: &str,
    db_type: dbx_core::models::connection::DatabaseType,
    confirmed: Option<&str>,
) -> Option<String> {
    let confirmed = confirmed?;
    if normalize_sql_for_confirmation(sql) == normalize_sql_for_confirmation(confirmed) {
        return None;
    }
    let is_write = match classify_sql_risk_for_database(sql, db_type) {
        Ok(risk) => risk != dbx_core::sql_risk::SqlRisk::ReadOnly,
        Err(_) => true,
    };
    if !is_write {
        return None;
    }
    Some(format!(
        "Blocked: the executed SQL does not match the user-confirmed SQL.\n\
         Confirmed: {}\n\
         Attempted: {}",
        confirmed, sql
    ))
}

fn validate_transaction_sql_shape(sql: &str) -> Result<(), String> {
    use sqlparser::{
        ast::{Expr, Statement, Visit, Visitor},
        dialect::MySqlDialect,
        parser::Parser,
        tokenizer::{Token, Tokenizer},
    };
    use std::ops::ControlFlow;

    const SAFE_FUNCTIONS: &[&str] = &[
        "abs",
        "ascii",
        "avg",
        "bin",
        "ceiling",
        "char_length",
        "character_length",
        "coalesce",
        "concat",
        "concat_ws",
        "connection_id",
        "conv",
        "count",
        "crc32",
        "curdate",
        "curtime",
        "current_date",
        "current_time",
        "current_timestamp",
        "date_format",
        "datediff",
        "dayname",
        "dayofmonth",
        "dayofweek",
        "dayofyear",
        "exp",
        "floor",
        "format",
        "greatest",
        "hex",
        "hour",
        "if",
        "ifnull",
        "inet_aton",
        "inet_ntoa",
        "instr",
        "isnull",
        "json_extract",
        "json_length",
        "json_unquote",
        "json_valid",
        "last_day",
        "lcase",
        "least",
        "left",
        "length",
        "ln",
        "locate",
        "log",
        "log10",
        "log2",
        "lower",
        "lpad",
        "ltrim",
        "max",
        "md5",
        "microsecond",
        "min",
        "minute",
        "mod",
        "month",
        "monthname",
        "now",
        "nullif",
        "oct",
        "ord",
        "position",
        "pow",
        "power",
        "quarter",
        "rand",
        "repeat",
        "replace",
        "reverse",
        "right",
        "round",
        "rpad",
        "rtrim",
        "second",
        "sha",
        "sha1",
        "sha2",
        "sign",
        "sleep",
        "space",
        "sqrt",
        "str_to_date",
        "substring",
        "substr",
        "time_format",
        "timediff",
        "timestampadd",
        "timestampdiff",
        "truncate",
        "unhex",
        "unix_timestamp",
        "upper",
        "ucase",
        "utc_date",
        "utc_time",
        "utc_timestamp",
        "uuid",
        "version",
        "week",
        "weekday",
        "year",
    ];

    struct TransactionFunctionVisitor {
        rejected: bool,
    }

    impl Visitor for TransactionFunctionVisitor {
        type Break = ();

        fn pre_visit_expr(&mut self, expr: &Expr) -> ControlFlow<()> {
            if let Expr::Function(function) = expr {
                let parts = &function.name.0;
                let allowed = parts.len() == 1
                    && parts.last().and_then(|part| part.as_ident()).is_some_and(|ident| {
                        SAFE_FUNCTIONS.iter().any(|candidate| ident.value.eq_ignore_ascii_case(candidate))
                    });
                if !allowed {
                    self.rejected = true;
                    return ControlFlow::Break(());
                }
            }
            ControlFlow::Continue(())
        }
    }

    if sql.contains("/*!") || sql.contains("/*+") {
        return Err("Executable comments and optimizer hints are not allowed in transaction sessions.".to_string());
    }
    let dialect = MySqlDialect {};
    let statements = Parser::parse_sql(&dialect, sql).map_err(|error| format!("SQL cannot be proven safe: {error}"))?;
    let [statement] = statements.as_slice() else {
        return Err("Transaction session calls must contain exactly one SQL statement.".to_string());
    };
    let tokens =
        Tokenizer::new(&dialect, sql).tokenize().map_err(|error| format!("SQL cannot be tokenized safely: {error}"))?;
    let has_word = |expected: &str| {
        tokens.iter().any(|token| matches!(token, Token::Word(word) if word.value.eq_ignore_ascii_case(expected)))
    };
    if tokens.iter().any(|token| matches!(token, Token::Assignment)) {
        return Err("User-variable assignment is not allowed in transaction sessions.".to_string());
    }

    match statement {
        Statement::Query(_) => {
            for forbidden in [
                "INTO",
                "OUTFILE",
                "DUMPFILE",
                "LOAD_FILE",
                "GET_LOCK",
                "RELEASE_LOCK",
                "IS_FREE_LOCK",
                "IS_USED_LOCK",
                "MASTER_POS_WAIT",
                "SQL_CALC_FOUND_ROWS",
            ] {
                if has_word(forbidden) {
                    return Err(format!("{forbidden} is not allowed in transaction session queries."));
                }
            }
            Ok(())
        }
        Statement::Insert(insert)
            if insert.output.is_none()
                && insert.returning.is_none()
                && insert.settings.is_none()
                && insert.format_clause.is_none()
                && insert.multi_table_insert_type.is_none()
                && insert.multi_table_into_clauses.is_empty()
                && insert.multi_table_when_clauses.is_empty()
                && insert.multi_table_else_clause.is_none() =>
        {
            Ok(())
        }
        Statement::Update(update) if update.output.is_none() && update.returning.is_none() => Ok(()),
        Statement::Delete(delete) if delete.output.is_none() && delete.returning.is_none() => Ok(()),
        _ => Err(
            "Transaction sessions allow only SELECT (including locking reads), INSERT, UPDATE, DELETE, and REPLACE."
                .to_string(),
        ),
    }?;

    let mut visitor = TransactionFunctionVisitor { rejected: false };
    let _ = statement.visit(&mut visitor);
    if visitor.rejected {
        return Err(
            "Only unqualified, known-safe MySQL built-in functions are allowed in transaction sessions.".to_string()
        );
    }
    Ok(())
}

// CallToolResult is the transport-native error payload; boxing it would complicate every MCP call site.
#[allow(clippy::result_large_err)]
fn not_salesforce_error(connection: &ConnectionConfig) -> CallToolResult {
    tool_error(
        "NOT_SALESFORCE_CONNECTION",
        format!(
            "Connection \"{}\" is a {:?} connection, not Salesforce. The dbx_salesforce_* tools only work against a Salesforce org.",
            connection.name, connection.db_type
        ),
    )
}

/// Build the exact `DBX SALESFORCE DML` pseudo-command the driver executes.
///
/// Validation lives here rather than in the driver so a rejected shape never
/// receives a confirm token: the statement that gets summarized is the statement
/// that gets sent, one record at a time. Upsert and bulk shapes are refused
/// outright — the driver cannot express them, and a token must not promise what
/// the org cannot do.
fn build_salesforce_dml_statement(
    op: &str,
    object: &str,
    id: Option<&str>,
    fields: Option<&serde_json::Value>,
) -> Result<String, String> {
    let op = op.trim().to_ascii_lowercase();
    let object = object.trim();
    if object.is_empty() {
        return Err("'object' must be a non-empty Salesforce object API name, e.g. \"Account\".".to_string());
    }
    let id = id.map(str::trim).filter(|id| !id.is_empty());
    let fields = match fields {
        None => None,
        Some(serde_json::Value::Object(map)) => (!map.is_empty()).then_some(map),
        Some(_) => return Err("'fields' must be a JSON object mapping field API names to values.".to_string()),
    };
    let body = match op.as_str() {
        "insert" => {
            if id.is_some() {
                return Err("insert creates a new record: drop 'id' and let Salesforce assign it.".to_string());
            }
            let Some(fields) = fields else {
                return Err("insert requires a non-empty 'fields' object.".to_string());
            };
            reject_salesforce_identity_field(fields)?;
            json!({ "op": "insert", "object": object, "fields": fields })
        }
        "update" => {
            let Some(id) = id else {
                return Err("update requires the 'id' of the record to change.".to_string());
            };
            let Some(fields) = fields else {
                return Err("update requires a non-empty 'fields' object.".to_string());
            };
            reject_salesforce_identity_field(fields)?;
            json!({ "op": "update", "object": object, "id": id, "fields": fields })
        }
        "delete" => {
            let Some(id) = id else {
                return Err("delete requires the 'id' of the record to remove.".to_string());
            };
            if fields.is_some() {
                return Err("delete takes no 'fields' — it removes the whole record.".to_string());
            }
            json!({ "op": "delete", "object": object, "id": id })
        }
        other => {
            return Err(format!(
                "Unknown op \"{other}\". Expected insert, update or delete — upsert, bulk and composite writes are not supported."
            ));
        }
    };
    Ok(format!("{SALESFORCE_DML_HEADER}\n{body}"))
}

/// `Id` is the record identity, never a write target: sending it would either be
/// ignored (insert) or read as an attempt to re-key a record (update).
fn reject_salesforce_identity_field(fields: &serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    if fields.keys().any(|name| name.eq_ignore_ascii_case("Id")) {
        return Err(
            "'fields' must not contain Id — the record identity is the 'id' parameter, and Salesforce assigns it on insert."
                .to_string(),
        );
    }
    if fields.keys().any(|name| name.trim().is_empty()) {
        return Err("'fields' contains an empty field name.".to_string());
    }
    Ok(())
}

/// One-line description of a prepared statement, in the same words the driver
/// uses in its own errors, so a summary and a failure line up.
fn salesforce_write_label(statement: &str) -> String {
    match parse_salesforce_statement(statement) {
        Ok(parsed) => match parsed.id.as_deref().filter(|id| !id.is_empty()) {
            Some(id) => format!("{} on {} (Id {id})", parsed.op.as_str(), parsed.object),
            None => format!("{} on {}", parsed.op.as_str(), parsed.object),
        },
        // Unreachable for a token the server issued; keep the line honest anyway.
        Err(_) => "Salesforce write".to_string(),
    }
}

/// The confirmation an agent must show the user before applying a prepared
/// write. It names the operation, the exact field values, and the identity the
/// change will be attributed to, then states the two properties that make
/// Salesforce different from SQL: no transaction and no rollback.
fn format_salesforce_write_summary(
    statement: &str,
    connection: &ConnectionConfig,
    identity: Option<&SalesforceCurrentUser>,
    token: &str,
    expires_in_secs: u64,
) -> String {
    let mut lines = vec!["Salesforce write prepared — nothing has been sent yet.".to_string(), String::new()];
    match parse_salesforce_statement(statement) {
        Ok(parsed) => {
            lines.push(format!("Operation:  {}", parsed.op.as_str()));
            lines.push(format!("Object:     {}", parsed.object));
            if let Some(id) = parsed.id.as_deref().filter(|id| !id.is_empty()) {
                lines.push(format!("Record Id:  {id}"));
            }
            if let Some(fields) = parsed.fields.as_ref() {
                lines.push(format!("Fields ({}):", fields.len()));
                for (index, (name, value)) in fields.iter().enumerate() {
                    if index >= SALESFORCE_SUMMARY_MAX_FIELDS {
                        lines.push(format!(
                            "  … and {} more (full statement in structured_content)",
                            fields.len() - index
                        ));
                        break;
                    }
                    lines.push(format!("  - {name} = {}", truncate_salesforce_value(value)));
                }
            }
        }
        Err(error) => lines.push(format!("Operation:  unparseable ({error})")),
    }
    lines.push(String::new());
    lines.push(format!("Connection:   {} ({})", connection.name, connection.id));
    lines.extend(format_salesforce_identity_lines(identity));
    lines.push(String::new());
    lines.push(
        "Salesforce writes are not transactional: once applied, this cannot be rolled back. Field-level security, record sharing, validation rules and flows all still apply, and a refusal comes back as Salesforce's own error text."
            .to_string(),
    );
    lines.push(String::new());
    lines.push(format!(
        "Show this summary to the user. Only if they approve, call dbx_salesforce_apply_write with confirm_token \"{token}\". The token is single-use and expires in {expires_in_secs} seconds; any change to the write needs a new dbx_salesforce_prepare_write."
    ));
    lines.join("\n")
}

/// The whole identity block, for `dbx_salesforce_current_user`.
fn format_salesforce_identity_block(connection: &ConnectionConfig, identity: Option<&SalesforceCurrentUser>) -> String {
    let mut lines = vec![format!("Salesforce identity for connection \"{}\" ({})", connection.name, connection.id)];
    lines.extend(format_salesforce_identity_lines(identity));
    lines.join("\n")
}

fn format_salesforce_identity_lines(identity: Option<&SalesforceCurrentUser>) -> Vec<String> {
    let Some(identity) = identity else {
        return vec![
            "Signed in as:   unknown — the identity lookup failed, so treat every permission as unverified. Salesforce still enforces its own rules on the write."
                .to_string(),
        ];
    };
    let profile = identity.profile_name.as_deref().map(str::trim).filter(|name| !name.is_empty()).unwrap_or("unknown");
    let rights = match identity.is_admin {
        Some(true) => "has \"Modify All Data\": it bypasses field-level security and record sharing",
        Some(false) => "no \"Modify All Data\": field-level security and record sharing apply",
        None => "\"Modify All Data\" could not be determined, so treat it as if it were granted",
    };
    vec![
        format!("Signed in as:   {} <{}> (user Id {})", identity.name, identity.email, identity.user_id),
        format!("Organization:   {} ({})", identity.org_name, identity.organization_id),
        format!("Profile:        \"{profile}\" — {rights}"),
    ]
}

fn salesforce_identity_json(identity: &SalesforceCurrentUser) -> serde_json::Value {
    json!({
        "user_id": identity.user_id,
        "name": identity.name,
        "email": identity.email,
        "username": identity.username,
        "organization_id": identity.organization_id,
        "org_name": identity.org_name,
        "profile_name": identity.profile_name,
        "is_admin": identity.is_admin,
    })
}

fn truncate_salesforce_value(value: &serde_json::Value) -> String {
    let rendered = value.to_string();
    if rendered.chars().count() <= SALESFORCE_SUMMARY_MAX_VALUE_CHARS {
        return rendered;
    }
    let kept: String = rendered.chars().take(SALESFORCE_SUMMARY_MAX_VALUE_CHARS).collect();
    format!("{kept}…")
}

// CallToolResult is the transport-native error payload; boxing it would complicate every MCP call site.
#[allow(clippy::result_large_err)]
fn validate_sql_policy(
    connection: &dbx_core::models::connection::ConnectionConfig,
    policy: &McpGlobalPolicy,
    database: &str,
    sql: &str,
    allow_database_switch: bool,
) -> Result<dbx_core::agent_tools::AgentSqlPermissions, CallToolResult> {
    if !allow_database_switch && mcp_sql_has_forbidden_database_switch(sql, connection.db_type) {
        return Err(tool_error(
            "SQL_BLOCKED",
            "MCP does not allow USE or persistent database switching outside a session. Open one with dbx_open_session to run stateful queries.",
        ));
    }
    let risk =
        classify_sql_risk_for_database(sql, connection.db_type).map_err(|error| tool_error("SQL_BLOCKED", error))?;
    if risk == SqlRisk::Transaction {
        return Err(tool_error("SQL_BLOCKED", "Transaction statements are not supported by MCP."));
    }
    // The keyword scan alone misses write-capable SQL that the risk classifier
    // does recognize (locking reads, side-effect functions, writable CTEs), and
    // those statements would otherwise reach the database whenever high-risk SQL
    // is permitted. Fail closed on either signal so read-only stays read-only.
    let is_write = risk != SqlRisk::ReadOnly || is_write_sql_for_database(sql, connection.db_type);
    if policy.read_only && is_write {
        return Err(tool_error(
            "MCP_READ_ONLY",
            format!("MCP execution permission for database \"{database}\" is read-only. SQL write blocked."),
        ));
    }
    if connection.read_only && is_write {
        return Err(tool_error(
            "CONNECTION_READ_ONLY",
            format!("Connection \"{}\" has read-only protection enabled. SQL write blocked.", connection.name),
        ));
    }
    let high_risk = risk == SqlRisk::Ddl || is_dangerous_sql_for_database(sql, connection.db_type);
    if high_risk && !policy.allow_dangerous_sql {
        return Err(tool_error("SQL_BLOCKED", "High-risk SQL is disabled in DBX MCP settings."));
    }
    if is_write && targets_production_database(connection, database, sql) {
        return Err(tool_error("PRODUCTION_WRITE_BLOCKED", "MCP cannot execute writes against a production database."));
    }
    Ok(mcp_permissions(connection, policy))
}

// CallToolResult is the transport-native error payload; boxing it would complicate every MCP call site.
#[cfg(test)]
#[allow(clippy::result_large_err)]
#[cfg(test)]
fn validate_mongo_command(
    connection: &dbx_core::models::connection::ConnectionConfig,
    policy: &McpGlobalPolicy,
    database_scope: &DatabaseScope,
    database: &str,
    source: &str,
) -> Result<MongoCommand, CallToolResult> {
    validate_mongo_command_with_groups(connection, policy, &[], database_scope, database, source)
}

#[allow(clippy::result_large_err)]
fn validate_mongo_command_with_groups(
    connection: &dbx_core::models::connection::ConnectionConfig,
    policy: &McpGlobalPolicy,
    group_ids: &[String],
    database_scope: &DatabaseScope,
    database: &str,
    source: &str,
) -> Result<MongoCommand, CallToolResult> {
    let command = mongo::parse(source).map_err(|error| {
        tool_error(
            "QUERY_ERROR",
            format!(
                "{error} Use MongoDB shell-style commands such as db.collection.find({{}}), db.collection.aggregate([]), or db.collection.countDocuments({{}})."
            ),
        )
    })?;
    let (target_database, command_to_validate) = match &command {
        MongoCommand::InDatabase { database, command } => (database.as_str(), command.as_ref()),
        command => (database, command),
    };
    ensure_database_in_scope(database_scope, target_database)?;
    if matches!(command_to_validate, MongoCommand::RunCommand { .. }) {
        return Err(tool_error(
            "SQL_BLOCKED",
            "MongoDB runCommand is not available through MCP; review and execute it manually in DBX.",
        ));
    }
    if let MongoCommand::Aggregate { pipeline, .. } = command_to_validate {
        dbx_core::mcp_policy::ensure_mongo_database_execution_scope(policy, &connection.id, target_database, pipeline)
            .map_err(|error| {
                let (code, message) = error
                    .strip_prefix("QUERY_ERROR: ")
                    .map_or(("DATABASE_EXECUTION_POLICY_OUT_OF_SCOPE", error.as_str()), |message| {
                        ("QUERY_ERROR", message)
                    });
                tool_error(code, message)
            })?;
        for output_database in mongo_aggregate_target_databases(pipeline, target_database)? {
            ensure_database_in_scope(database_scope, &output_database)?;
        }
    }
    let effective_policy = effective_policy_for_database_with_groups(policy, group_ids, connection, target_database);
    let permissions = mcp_permissions(connection, &effective_policy);
    let production_database = match command_to_validate {
        MongoCommand::Aggregate { pipeline, .. } => {
            mongo_pipeline_targets_production_database(connection, target_database, pipeline)
        }
        _ => is_production_database(connection, target_database),
    };
    if let Err(error) = mongo::validate_safety(
        command_to_validate,
        permissions.allow_writes,
        permissions.allow_dangerous,
        production_database,
    ) {
        return Err(match error {
            MongoSafetyError::WritesDisabled => tool_error(
                if effective_policy.read_only { "MCP_READ_ONLY" } else { "CONNECTION_READ_ONLY" },
                "MCP MongoDB execution is read-only for this database in DBX MCP settings.",
            ),
            MongoSafetyError::EmptyFilter => tool_error(
                "SQL_BLOCKED",
                "MongoDB update/delete commands must include a non-empty filter unless high-risk operations are enabled in DBX MCP settings.",
            ),
            MongoSafetyError::Dangerous => {
                tool_error("SQL_BLOCKED", "Dangerous MongoDB command is disabled in DBX MCP settings.")
            }
            MongoSafetyError::ProductionWrite => {
                tool_error("PRODUCTION_WRITE_BLOCKED", "MCP cannot execute writes against a production database.")
            }
        });
    }
    Ok(command)
}

#[allow(clippy::result_large_err)]
fn mongo_aggregate_target_databases(pipeline: &str, active_database: &str) -> Result<Vec<String>, CallToolResult> {
    dbx_core::mcp_policy::mongo_pipeline_output_databases(pipeline, active_database)
        .map_err(|error| tool_error("QUERY_ERROR", error.strip_prefix("QUERY_ERROR: ").unwrap_or(&error)))
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
}

#[cfg(feature = "mq-admin")]
fn format_peek_messages_result(result: dbx_core::mq::PeekMessagesResult, count: usize) -> String {
    let mut messages = Vec::new();
    let mut bytes = 0;
    let mut truncated = result.messages.len() > count;
    for message in result.messages.into_iter().take(count) {
        let value = serde_json::to_value(message).expect("message is JSON serializable");
        bytes += value.to_string().len();
        if bytes > 256 * 1024 {
            truncated = true;
            break;
        }
        messages.push(value);
    }
    json!({ "messages": messages, "incomplete": result.incomplete, "outputTruncated": truncated }).to_string()
}

#[cfg(feature = "mq-admin")]
fn format_send_message_result(
    system_kind: &dbx_core::mq::MqSystemKind,
    result: &dbx_core::mq::SendMessageResponse,
) -> String {
    let mut output = format!(
        "Message sent to {}.\ntopic: {}\npartition: {}\noffset: {}",
        system_kind.as_str(),
        result.topic,
        result.partition,
        result.offset
    );
    if let Some(timestamp) = result.timestamp.as_deref() {
        output.push_str(&format!("\ntimestamp: {timestamp}"));
    }
    output
}

fn scoped_connection_ids(value: Option<&str>) -> Vec<String> {
    let mut ids = Vec::new();
    for id in value.unwrap_or_default().split(',').map(str::trim).filter(|id| !id.is_empty()) {
        if !ids.iter().any(|existing| existing == id) {
            ids.push(id.to_string());
        }
    }
    ids
}

fn ambiguous_connections(name: &str, connections: &[dbx_core::models::connection::ConnectionConfig]) -> String {
    let lines = connections
        .iter()
        .map(|connection| {
            format!("- {}: {:?} @ {}:{}", connection.id, connection.db_type, connection.host, connection.port)
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("Multiple connections found with name \"{name}\". Please specify connection_id:\n{lines}")
}

fn format_connections(connections: &[ConnectionSummary]) -> String {
    let mut output = String::from(
        "| ID | Name | Group Path | Type | Host | Port | Database |\n| --- | --- | --- | --- | --- | --- | --- |",
    );
    for connection in connections {
        output.push_str(&format!(
            "\n| {} | {} | {} | {} | {} | {} | {} |",
            escape_cell(&connection.id),
            escape_cell(&connection.name),
            escape_cell(&connection.group_path.join(" / ")),
            escape_cell(&connection.db_type),
            escape_cell(&connection.host),
            connection.port,
            escape_cell(&connection.database),
        ));
    }
    output
}

/// Normalize a user-supplied routine type ("procedure", "PROCEDURE", ...) to
/// the canonical SCREAMING form used by the object listing protocol.
fn normalize_routine_type(value: &str) -> Result<String, String> {
    match value.trim().to_ascii_uppercase().as_str() {
        "PROCEDURE" => Ok("PROCEDURE".to_string()),
        "FUNCTION" => Ok("FUNCTION".to_string()),
        other => Err(format!("Unsupported routine type \"{other}\"; use PROCEDURE or FUNCTION.")),
    }
}

fn format_routines(routines: &[dbx_core::db::ObjectInfo]) -> String {
    let rows = routines
        .iter()
        .map(|routine| {
            vec![
                routine.name.clone(),
                routine.object_type.clone(),
                routine.schema.clone().unwrap_or_default(),
                routine.signature.clone().unwrap_or_default(),
                routine.comment.clone().unwrap_or_default(),
            ]
        })
        .collect::<Vec<_>>();
    markdown_table(&["Routine", "Type", "Schema", "Signature", "Comment"], &rows)
}

fn format_columns(columns: &[dbx_core::db::ColumnInfo]) -> String {
    let rows = columns
        .iter()
        .map(|column| {
            vec![
                if column.is_primary_key { format!("{} (PK)", column.name) } else { column.name.clone() },
                column.data_type.clone(),
                if column.is_nullable { "YES".to_string() } else { "NO".to_string() },
                column.column_default.clone().unwrap_or_default(),
                column.comment.clone().unwrap_or_default(),
            ]
        })
        .collect::<Vec<_>>();
    markdown_table(&["Column", "Type", "Nullable", "Default", "Comment"], &rows)
}

fn markdown_table(headers: &[&str], rows: &[Vec<String>]) -> String {
    let mut output = format!("| {} |\n| {} |", headers.join(" | "), vec!["---"; headers.len()].join(" | "));
    for row in rows {
        output
            .push_str(&format!("\n| {} |", row.iter().map(|value| escape_cell(value)).collect::<Vec<_>>().join(" | ")));
    }
    output
}

fn escape_cell(value: &str) -> String {
    value.replace('|', "\\|").replace('\n', " ")
}

fn redis_database(connection: &dbx_core::models::connection::ConnectionConfig) -> Option<u32> {
    connection.database.as_deref().and_then(parse_redis_database)
}

fn parse_redis_database(value: &str) -> Option<u32> {
    value.trim().parse().ok()
}

fn format_redis_result(result: &RedisCommandResult) -> String {
    let value =
        result.value.as_str().map(ToOwned::to_owned).unwrap_or_else(|| {
            serde_json::to_string_pretty(&result.value).unwrap_or_else(|_| result.value.to_string())
        });
    let safety = serde_json::to_value(&result.safety)
        .ok()
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_else(|| format!("{:?}", result.safety).to_ascii_lowercase());
    format!("Command: {}\nSafety: {}\n\n{}", result.command, safety, value)
}

fn format_schema_context(
    connection: &str,
    database: &str,
    schema: &str,
    tables: &[(dbx_core::db::TableInfo, Vec<dbx_core::db::ColumnInfo>)],
    truncated: bool,
) -> String {
    let mut output = format!("Connection: {connection}");
    if !database.is_empty() {
        output.push_str(&format!("\nDatabase: {database}"));
    }
    if !schema.is_empty() {
        output.push_str(&format!("\nSchema: {schema}"));
    }
    for (table, columns) in tables {
        output.push_str(&format!("\n\n## {}\nType: {}", table.name, table.table_type));
        for column in columns {
            output.push_str(&format!(
                "\n- {} {} {}{}{}",
                column.name,
                column.data_type,
                if column.is_nullable { "NULL" } else { "NOT NULL" },
                if column.is_primary_key { " PK" } else { "" },
                column.comment.as_ref().map(|comment| format!(" -- {comment}")).unwrap_or_default(),
            ));
        }
    }
    if truncated {
        output.push_str("\n\nNote: table list was truncated; request specific table names for more context.");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use dbx_core::models::connection::ConnectionConfig;
    use rmcp::{
        model::{CallToolRequest, CallToolRequestParams, ClientRequest},
        service::PeerRequestOptions,
        ServiceExt,
    };
    use std::{collections::HashSet, sync::atomic::AtomicUsize, time::Duration};

    #[test]
    fn parses_dbx_resource_uris_and_decodes_query_values() {
        assert_eq!(parse_dbx_resource_uri(CONNECTIONS_RESOURCE_URI).unwrap(), DbxResourceRequest::Connections);
        assert_eq!(
            parse_dbx_resource_uri("dbx://connections/connection-1/databases").unwrap(),
            DbxResourceRequest::Databases { connection_id: "connection-1".to_string() }
        );
        assert_eq!(
            parse_dbx_resource_uri(
                "dbx://connections/connection-1/table-schema?database=sales%20data&schema=public&table=order%20items"
            )
            .unwrap(),
            DbxResourceRequest::TableSchema {
                connection_id: "connection-1".to_string(),
                database: Some("sales data".to_string()),
                schema: Some("public".to_string()),
                table: "order items".to_string(),
            }
        );
    }

    #[test]
    fn rejects_invalid_dbx_resource_uris() {
        assert!(parse_dbx_resource_uri("dbx://connections/connection-1/table-schema").is_err());
        assert!(parse_dbx_resource_uri("dbx://connections/connection-1/tables?unknown=value").is_err());
        assert!(parse_dbx_resource_uri("file:///tmp/connections").is_err());
    }

    struct FakeTransactionIo {
        in_transaction: bool,
        executed_sql: Arc<std::sync::Mutex<Vec<String>>>,
        block_next_sql: Arc<std::sync::Mutex<Option<Arc<tokio::sync::Notify>>>>,
        disconnects: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl crate::transaction::TransactionIo for FakeTransactionIo {
        async fn execute(
            &mut self,
            sql: &str,
            _max_rows: Option<usize>,
        ) -> Result<crate::transaction::TransactionIoSuccess, crate::transaction::TransactionIoError> {
            self.executed_sql.lock().unwrap().push(sql.to_string());
            let block = self.block_next_sql.lock().unwrap().take();
            if let Some(block) = block {
                block.notified().await;
            }
            match sql {
                "START TRANSACTION" => self.in_transaction = true,
                "COMMIT" | "ROLLBACK" => self.in_transaction = false,
                _ => {}
            }
            Ok(crate::transaction::TransactionIoSuccess {
                result: dbx_core::db::QueryResult {
                    columns: Vec::new(),
                    column_types: Vec::new(),
                    column_sortables: Vec::new(),
                    spatial_columns: Vec::new(),
                    spatial_values: Vec::new(),
                    rows: Vec::new(),
                    affected_rows: 0,
                    execution_time_ms: 0,
                    server_execute_time_us: None,
                    query_timings_ms: None,
                    truncated: false,
                    session_id: None,
                    has_more: false,
                    elasticsearch_raw_body: None,
                    messages: Vec::new(),
                },
                in_transaction: self.in_transaction,
            })
        }

        async fn ping_in_transaction(&mut self) -> Result<bool, crate::transaction::TransactionIoError> {
            Ok(self.in_transaction)
        }

        async fn disconnect(&mut self) {
            self.disconnects.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    #[test]
    fn transaction_sql_allowlist_accepts_only_rollback_safe_mysql_dml_and_queries() {
        for sql in [
            "SELECT id FROM accounts WHERE id = 1",
            "SELECT id FROM accounts WHERE id = 1 FOR UPDATE",
            "SELECT CONNECTION_ID(), VERSION(), SLEEP(0)",
            "SELECT COUNT(*), LOWER(name), COALESCE(name, '') FROM accounts",
            "INSERT INTO accounts(id) VALUES (1)",
            "UPDATE accounts SET name = 'safe' WHERE id = 1",
            "DELETE FROM accounts WHERE id = 1",
            "REPLACE INTO accounts(id) VALUES (1)",
        ] {
            assert!(validate_transaction_sql_shape(sql).is_ok(), "expected allowed: {sql}");
        }

        for sql in [
            "CREATE TABLE t(id INT)",
            "CREATE TEMPORARY TABLE t(id INT)",
            "ALTER TABLE t ADD COLUMN name TEXT",
            "DROP TABLE t",
            "CALL mutate_data()",
            "LOAD DATA INFILE '/tmp/input' INTO TABLE t",
            "LOCK TABLES t WRITE",
            "UNLOCK TABLES",
            "SET autocommit = 0",
            "USE another_database",
            "XA START 'x'",
            "BEGIN",
            "COMMIT",
            "ROLLBACK",
            "SELECT 1 INTO OUTFILE '/tmp/output'",
            "SELECT @value := 1",
            "SELECT evil_udf(id) FROM accounts",
            "SELECT app.evil_udf(id) FROM accounts",
            "SELECT (SELECT evil_udf())",
            "INSERT INTO accounts(id) VALUES (evil_udf(1))",
            "UPDATE accounts SET name = evil_udf(name) WHERE id = 1",
            "DELETE FROM accounts WHERE evil_udf(id) = 1",
            "/*!40101 SET autocommit = 0 */",
            "SELECT 1; DELETE FROM accounts",
        ] {
            assert!(validate_transaction_sql_shape(sql).is_err(), "expected rejected: {sql}");
        }
    }

    struct FakeBackend {
        connections: Vec<ConnectionConfig>,
        policy: McpGlobalPolicy,
        recorded_arguments: std::sync::Mutex<Vec<(String, serde_json::Value)>>,
        history: std::sync::Mutex<Vec<dbx_core::history::HistoryEntry>>,
        closed_sessions: std::sync::Mutex<Vec<String>>,
        pinned_sessions: std::sync::Mutex<HashSet<String>>,
        close_failures_remaining: std::sync::Mutex<usize>,
        transaction_owners_opened: AtomicUsize,
        transaction_owner_sql: Arc<std::sync::Mutex<Vec<String>>>,
        transaction_block_next_sql: Arc<std::sync::Mutex<Option<Arc<tokio::sync::Notify>>>>,
        transaction_owner_disconnects: Arc<AtomicUsize>,
        transaction_owner_budget: Arc<tokio::sync::Semaphore>,
        transaction_open_before: Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>,
        transaction_open_after_owner: Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>,
        transaction_open_error: Option<String>,
        policy_override: std::sync::Mutex<Option<McpGlobalPolicy>>,
        salesforce_identity: Option<SalesforceCurrentUser>,
    }

    impl Default for FakeBackend {
        fn default() -> Self {
            Self {
                connections: Vec::new(),
                policy: McpGlobalPolicy::default(),
                recorded_arguments: std::sync::Mutex::new(Vec::new()),
                history: std::sync::Mutex::new(Vec::new()),
                closed_sessions: std::sync::Mutex::new(Vec::new()),
                pinned_sessions: std::sync::Mutex::new(HashSet::new()),
                close_failures_remaining: std::sync::Mutex::new(0),
                transaction_owners_opened: AtomicUsize::new(0),
                transaction_owner_sql: Arc::new(std::sync::Mutex::new(Vec::new())),
                transaction_block_next_sql: Arc::new(std::sync::Mutex::new(None)),
                transaction_owner_disconnects: Arc::new(AtomicUsize::new(0)),
                transaction_owner_budget: Arc::new(tokio::sync::Semaphore::new(32)),
                transaction_open_before: None,
                transaction_open_after_owner: None,
                transaction_open_error: None,
                policy_override: std::sync::Mutex::new(None),
                salesforce_identity: None,
            }
        }
    }

    fn connection(id: &str, name: &str, db_type: &str, database: &str) -> ConnectionConfig {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "name": name,
            "db_type": db_type,
            "host": "",
            "port": 0,
            "username": "",
            "password": "",
            "database": database,
            "ssl": false
        }))
        .unwrap()
    }

    fn resolved_connection_for_test(connection: ConnectionConfig) -> ResolvedConnection {
        ResolvedConnection {
            connection,
            policy: McpGlobalPolicy::default(),
            database_scope: DatabaseScope::All,
            group_ids: Vec::new(),
        }
    }

    fn result_text(result: &CallToolResult) -> &str {
        result.content[0].as_text().expect("text tool result").text.as_str()
    }

    fn opened_session_id(result: &CallToolResult) -> String {
        result_text(result)
            .lines()
            .find_map(|line| line.strip_prefix("session_id: "))
            .expect("open_session returns a session_id")
            .to_string()
    }

    #[async_trait]
    impl DbxBackend for FakeBackend {
        async fn save_history_entry(&self, entry: &dbx_core::history::HistoryEntry) -> Result<(), String> {
            self.history.lock().unwrap().push(entry.clone());
            Ok(())
        }
        async fn load_mcp_global_policy(&self) -> Result<McpGlobalPolicy, String> {
            Ok(self.policy_override.lock().unwrap().clone().unwrap_or_else(|| self.policy.clone()))
        }

        async fn load_connections(&self) -> Result<Vec<ConnectionConfig>, String> {
            Ok(self.connections.clone())
        }

        async fn open_transaction_owner(
            &self,
            _connection: &ConnectionConfig,
            _database: &str,
            _client_session_id: &str,
        ) -> Result<Arc<crate::transaction::TransactionOwner>, String> {
            if let Some(error) = &self.transaction_open_error {
                return Err(error.clone());
            }
            if let Some((entered, release)) = &self.transaction_open_before {
                entered.notify_one();
                release.notified().await;
            }
            self.transaction_owners_opened.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let permit = self
                .transaction_owner_budget
                .clone()
                .try_acquire_owned()
                .map_err(|_| "Too many open transaction-enabled MCP sessions (max 32).".to_string())?;
            let owner = crate::transaction::TransactionOwner::spawn_with_resource_permit(
                FakeTransactionIo {
                    in_transaction: false,
                    executed_sql: self.transaction_owner_sql.clone(),
                    block_next_sql: self.transaction_block_next_sql.clone(),
                    disconnects: self.transaction_owner_disconnects.clone(),
                },
                crate::transaction::TransactionOwnerConfig::default(),
                permit,
            );
            if let Some((entered, release)) = &self.transaction_open_after_owner {
                entered.notify_one();
                release.notified().await;
            }
            Ok(owner)
        }

        async fn execute_agent_tool(
            &self,
            _connection: &ConnectionConfig,
            _database: &str,
            tool_name: &str,
            arguments: serde_json::Value,
            _permissions: dbx_core::agent_tools::AgentSqlPermissions,
        ) -> dbx_core::agent_events::ToolResult {
            let is_error = tool_name == "execute_query"
                && arguments["sql"].as_str().is_some_and(|sql| sql.contains("FAIL_MCP_TEST"));
            if let Some(client_session_id) =
                arguments.get("client_session_id").and_then(serde_json::Value::as_str).filter(|id| !id.is_empty())
            {
                self.pinned_sessions.lock().unwrap().insert(client_session_id.to_string());
            }
            self.recorded_arguments.lock().unwrap().push((tool_name.to_string(), arguments));
            dbx_core::agent_events::ToolResult {
                tool_call_id: "test".to_string(),
                tool_name: tool_name.to_string(),
                content: if is_error { "Error: query failed" } else { "ok" }.to_string(),
                is_error,
                explain_data: None,
            }
        }

        async fn salesforce_current_user(
            &self,
            _connection: &ConnectionConfig,
        ) -> Result<SalesforceCurrentUser, String> {
            self.salesforce_identity.clone().ok_or_else(|| "no Salesforce pool".to_string())
        }

        #[cfg(feature = "mq-admin")]
        async fn peek_messages(
            &self,
            connection: &ConnectionConfig,
            topic: dbx_core::mq::TopicRef,
            count: u32,
            options: dbx_core::mq::PeekMessagesOptions,
        ) -> Result<dbx_core::mq::PeekMessagesResult, String> {
            self.recorded_arguments.lock().unwrap().push((
                "peek_messages".into(),
                json!({"connectionId": connection.id, "topic": topic, "count": count, "options": options}),
            ));
            Ok(dbx_core::mq::PeekMessagesResult {
                messages: vec![dbx_core::mq::PeekedMessage {
                    payload_base64: "aGk=".into(),
                    payload_text: Some("hi".into()),
                    ..Default::default()
                }],
                incomplete: true,
            })
        }

        async fn close_client_session(
            &self,
            _connection_id: &str,
            _database: &str,
            client_session_id: &str,
        ) -> Result<bool, String> {
            let mut failures = self.close_failures_remaining.lock().unwrap();
            if *failures > 0 {
                *failures -= 1;
                return Err("temporary close failure".to_string());
            }
            drop(failures);
            self.closed_sessions.lock().unwrap().push(client_session_id.to_string());
            self.pinned_sessions.lock().unwrap().remove(client_session_id);
            Ok(true)
        }

        async fn add_connection_for_mcp(&self, config: ConnectionConfig) -> Result<ConnectionConfig, String> {
            Ok(config)
        }

        async fn duplicate_connection_for_mcp(
            &self,
            source_id: &str,
            copy_id: &str,
            copy_name: &str,
        ) -> Result<ConnectionConfig, String> {
            let mut copy = self
                .connections
                .iter()
                .find(|connection| connection.id == source_id)
                .cloned()
                .ok_or_else(|| "source not found".to_string())?;
            copy.id = copy_id.to_string();
            copy.name = copy_name.to_string();
            Ok(copy)
        }

        async fn remove_connection_for_mcp(&self, _connection_id: &str) -> Result<bool, String> {
            Ok(true)
        }

        async fn execute_batch(
            &self,
            _connection: &ConnectionConfig,
            _database: &str,
            schema: Option<&str>,
            sql: &str,
            options: dbx_core::query::QueryExecutionOptions,
        ) -> Result<Vec<crate::backend::BatchStatementResult>, String> {
            let client_session_id =
                options.client_session_id.as_deref().filter(|id| !id.trim().is_empty()).map(str::to_owned);
            if let Some(client_session_id) = &client_session_id {
                self.pinned_sessions.lock().unwrap().insert(client_session_id.clone());
            }
            self.recorded_arguments.lock().unwrap().push((
                "execute_batch".to_string(),
                json!({
                    "sql": sql,
                    "schema": schema,
                    "continue_on_error": options.continue_on_error,
                    "use_transaction": options.use_transaction,
                    "client_session_id": client_session_id,
                }),
            ));
            let execution_error = sql.contains("FAIL_MCP_TEST") || sql.contains("FAIL_MCP_NO_MESSAGE_TEST");

            Ok(vec![crate::backend::BatchStatementResult {
                result: dbx_core::db::QueryResult {
                    columns: vec![],
                    column_types: vec![],
                    column_sortables: vec![],
                    spatial_columns: vec![],
                    spatial_values: vec![],
                    rows: vec![],
                    affected_rows: 0,
                    execution_time_ms: 1,
                    server_execute_time_us: None,
                    query_timings_ms: None,
                    truncated: false,
                    session_id: None,
                    has_more: false,
                    elasticsearch_raw_body: None,
                    messages: vec![],
                },
                execution_error,
                statement_index: Some(0),
                error_message: sql.contains("FAIL_MCP_TEST").then(|| "statement failed".to_string()),
                merged: false,
                transaction_state: None,
                transaction_outcome: None,
            }])
        }
    }

    #[cfg(feature = "mq-admin")]
    fn kafka_connection() -> ConnectionConfig {
        let mut conn = connection("kafka", "Kafka", "mq", "");
        conn.read_only = true;
        conn.is_production = true;
        conn.external_config = Some(
            json!({"systemKind":"kafka", "adminUrl":"", "auth":{"kind":"none"}, "extra":{"bootstrapServers":"localhost:9092"}}),
        );
        conn
    }

    #[cfg(feature = "mq-admin")]
    #[tokio::test]
    async fn peek_messages_reads_with_read_only_policy_and_forwards_positions() {
        let backend = Arc::new(FakeBackend { connections: vec![kafka_connection()], ..Default::default() });
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);
        for (extra, expected) in [
            (json!({}), json!({"startPosition":"latest"})),
            (json!({"start_position":"earliest", "partition":0}), json!({"startPosition":"earliest", "partition":0})),
            (
                json!({"start_position":"offset", "partition":2, "offset":17}),
                json!({"startPosition":"offset", "partition":2, "offset":17}),
            ),
            (json!({"start_position":"offset", "offset":0}), json!({"startPosition":"offset", "offset":0})),
        ] {
            let mut request = json!({"connection_id":"kafka", "topic":" events "});
            request.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            let result = server.peek_messages(Parameters(serde_json::from_value(request).unwrap())).await;
            assert_ne!(result.is_error, Some(true), "{}", result_text(&result));
            let response: serde_json::Value = serde_json::from_str(result_text(&result)).unwrap();
            assert_eq!(response["messages"][0]["payloadBase64"], "aGk=");
            assert_eq!(response["incomplete"], true);
            assert_eq!(response["outputTruncated"], false);
            let calls = backend.recorded_arguments.lock().unwrap();
            let args = &calls.last().unwrap().1;
            assert_eq!(args["options"], expected);
            assert_eq!(args["count"], 20);
            assert_eq!(args["topic"]["topic"], "events");
        }
    }

    #[cfg(feature = "mq-admin")]
    #[tokio::test]
    async fn peek_messages_rejects_invalid_options_before_backend_call() {
        let backend = Arc::new(FakeBackend { connections: vec![kafka_connection()], ..Default::default() });
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);
        for extra in [
            json!({"count":0}),
            json!({"count":101}),
            json!({"partition":-1}),
            json!({"start_position":"offset"}),
            json!({"offset":1}),
            json!({"start_position":"earliest", "offset":0}),
            json!({"start_position":"offset", "offset":-1}),
            json!({"topic":" "}),
        ] {
            let mut request = json!({"connection_id":"kafka", "topic":"events"});
            request.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            let result = server.peek_messages(Parameters(serde_json::from_value(request).unwrap())).await;
            assert_eq!(result.is_error, Some(true), "{}", result_text(&result));
        }
        assert!(backend.recorded_arguments.lock().unwrap().is_empty());
    }

    #[cfg(feature = "mq-admin")]
    #[tokio::test]
    async fn peek_messages_enforces_tool_connection_scope_and_kafka_only() {
        for (policy, conn, expected) in [
            (
                McpGlobalPolicy { allowed_tool_names: Some(vec![]), ..Default::default() },
                kafka_connection(),
                "TOOL_OUT_OF_SCOPE",
            ),
            (
                McpGlobalPolicy { allowed_connection_ids: Some(vec![]), ..Default::default() },
                kafka_connection(),
                "CONNECTION_OUT_OF_SCOPE",
            ),
            (McpGlobalPolicy::default(), connection("kafka", "redis", "redis", "0"), "MQ_UNSUPPORTED"),
        ] {
            let backend = Arc::new(FakeBackend { policy, connections: vec![conn], ..Default::default() });
            let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);
            let result = server
                .peek_messages(Parameters(
                    serde_json::from_value(json!({"connection_id":"kafka", "topic":"events"})).unwrap(),
                ))
                .await;
            assert_eq!(result.is_error, Some(true));
            assert!(result_text(&result).contains(expected), "{}", result_text(&result));
            assert!(backend.recorded_arguments.lock().unwrap().is_empty());
        }
    }

    #[cfg(feature = "mq-admin")]
    #[tokio::test]
    async fn peek_messages_respects_session_scope_and_rejects_other_queues() {
        let mut rabbit = kafka_connection();
        rabbit.external_config.as_mut().unwrap()["systemKind"] = json!("rabbitmq");
        for (conn, scope, expected) in [
            (
                kafka_connection(),
                McpScope { connection_ids: vec!["other".into()], ..Default::default() },
                "CONNECTION_OUT_OF_SCOPE",
            ),
            (rabbit, McpScope::default(), "MQ_UNSUPPORTED"),
        ] {
            let backend = Arc::new(FakeBackend { connections: vec![conn], ..Default::default() });
            let server = DbxMcpServer::with_runtime_options(backend.clone(), scope, false);
            let result = server
                .peek_messages(Parameters(
                    serde_json::from_value(json!({"connection_id":"kafka", "topic":"events"})).unwrap(),
                ))
                .await;
            assert_eq!(result.is_error, Some(true));
            assert!(result_text(&result).contains(expected), "{}", result_text(&result));
            assert!(backend.recorded_arguments.lock().unwrap().is_empty());
        }
    }

    #[cfg(feature = "mq-admin")]
    #[test]
    fn peek_messages_output_preserves_metadata_and_bounds_whole_messages() {
        use dbx_core::mq::{PeekMessagesResult, PeekedMessage};
        let message = PeekedMessage {
            payload_base64: "/w==".into(),
            message_id: Some("2:17".into()),
            headers: [("kind".into(), "event".into())].into(),
            ..Default::default()
        };
        let output = format_peek_messages_result(PeekMessagesResult::complete(vec![message.clone(), message]), 1);
        let result: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(result["messages"].as_array().unwrap().len(), 1);
        assert_eq!(result["messages"][0]["messageId"], "2:17");
        assert_eq!(result["messages"][0]["headers"]["kind"], "event");
        assert_eq!(result["outputTruncated"], true);
        assert_eq!(result["incomplete"], false);
        let output = format_peek_messages_result(
            PeekMessagesResult::complete(vec![PeekedMessage {
                payload_base64: "a".repeat(300_000),
                ..Default::default()
            }]),
            20,
        );
        let result: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert!(result["messages"].as_array().unwrap().is_empty());
        assert_eq!(result["outputTruncated"], true);
        assert!(output.len() < 256 * 1024);
    }

    #[test]
    fn connection_table_escapes_markdown_cells() {
        let output = format_connections(&[ConnectionSummary {
            id: "id|1".to_string(),
            name: "local\npg".to_string(),
            db_type: "postgres".to_string(),
            host: "127.0.0.1".to_string(),
            port: 5432,
            database: "app".to_string(),
            group_path: vec!["Project|A".to_string(), "Staging\nWest".to_string()],
        }]);
        assert!(output.contains("id\\|1"));
        assert!(output.contains("local pg"));
        assert!(output.contains("Project\\|A / Staging West"));
    }

    #[test]
    fn server_registers_list_connections_tool() {
        let server = DbxMcpServer::with_runtime_options(Arc::new(FakeBackend::default()), McpScope::default(), false);
        let tools = server.tool_router.list_all();
        let names = tools.iter().map(|tool| tool.name.as_ref()).collect::<Vec<_>>();
        #[cfg(feature = "mq-admin")]
        assert_eq!(tools.len(), 25);
        #[cfg(not(feature = "mq-admin"))]
        assert_eq!(tools.len(), 23);
        #[cfg(feature = "mq-admin")]
        assert!(names.contains(&"dbx_peek_messages"));
        #[cfg(not(feature = "mq-admin"))]
        assert!(!names.contains(&"dbx_peek_messages"));
        assert!(names.contains(&"dbx_list_connections"));
        assert!(names.contains(&"dbx_list_databases"));
        assert!(names.contains(&"dbx_list_tables"));
        assert!(names.contains(&"dbx_describe_table"));
        assert!(names.contains(&"dbx_list_routines"));
        assert!(names.contains(&"dbx_get_routine_source"));
        assert!(names.contains(&"dbx_execute_query"));
        assert!(names.contains(&"dbx_execute_batch"));
        assert!(names.contains(&"dbx_begin_transaction"));
        assert!(names.contains(&"dbx_commit_transaction"));
        assert!(names.contains(&"dbx_rollback_transaction"));
        assert!(names.contains(&"dbx_add_connection"));
        assert!(names.contains(&"dbx_duplicate_connection"));
        assert!(names.contains(&"dbx_remove_connection"));
        assert!(names.contains(&"dbx_execute_redis_command"));
        assert!(names.contains(&"dbx_salesforce_current_user"));
        assert!(names.contains(&"dbx_salesforce_prepare_write"));
        assert!(names.contains(&"dbx_salesforce_apply_write"));
        assert!(names.contains(&"dbx_get_schema_context"));
        assert!(names.contains(&"dbx_open_table"));
        assert!(names.contains(&"dbx_execute_and_show"));
        assert!(names.contains(&"dbx_open_session"));
        assert!(names.contains(&"dbx_close_session"));
        #[cfg(feature = "mq-admin")]
        assert!(names.contains(&"dbx_send_message"));
    }

    #[tokio::test]
    async fn tools_list_hides_tools_the_policy_disallows() {
        let policy = McpGlobalPolicy {
            allowed_tool_names: Some(vec!["dbx_list_connections".to_string(), "dbx_execute_query".to_string()]),
            ..Default::default()
        };
        let server = DbxMcpServer::with_runtime_options(
            Arc::new(FakeBackend { policy, ..Default::default() }),
            McpScope::default(),
            false,
        );

        let tools = server.policy_filtered_tools().await;
        let names = tools.iter().map(|tool| tool.name.as_ref()).collect::<Vec<_>>();

        assert_eq!(names, vec!["dbx_execute_query", "dbx_list_connections"]);
    }

    #[tokio::test]
    async fn tools_list_keeps_the_full_view_without_an_allowlist() {
        let server = DbxMcpServer::with_runtime_options(Arc::new(FakeBackend::default()), McpScope::default(), false);

        let tools = server.policy_filtered_tools().await;

        assert_eq!(tools.len(), server.tool_router.list_all().len());
    }

    #[test]
    fn schema_context_tables_schema_is_gemini_compatible() {
        let server = DbxMcpServer::with_runtime_options(Arc::new(FakeBackend::default()), McpScope::default(), false);
        let tool = server
            .tool_router
            .list_all()
            .into_iter()
            .find(|tool| tool.name == "dbx_get_schema_context")
            .expect("schema context tool should be registered");
        let tables = tool
            .input_schema
            .get("properties")
            .and_then(serde_json::Value::as_object)
            .and_then(|properties| properties.get("tables"))
            .expect("tables property should be published");

        assert_eq!(tables.get("type"), Some(&serde_json::json!("array")));
        assert_eq!(tables.pointer("/items/type"), Some(&serde_json::json!("string")));
        assert!(!tool
            .input_schema
            .get("required")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|required| required.iter().any(|field| field == "tables")));
    }

    #[test]
    fn connection_selector_schema_uses_optional_strings() {
        let server = DbxMcpServer::with_runtime_options(Arc::new(FakeBackend::default()), McpScope::default(), false);
        let tools = server.tool_router.list_all();

        for tool_name in ["dbx_execute_query", "dbx_list_tables", "dbx_open_session"] {
            let tool = tools.iter().find(|tool| tool.name == tool_name).expect("selector tool should be registered");
            let properties = tool
                .input_schema
                .get("properties")
                .and_then(serde_json::Value::as_object)
                .expect("selector tool should publish object properties");
            let required = tool
                .input_schema
                .get("required")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .collect::<Vec<_>>();

            for field in ["connection_id", "connection_name"] {
                let selector = properties.get(field).expect("selector field should be published");
                assert_eq!(selector.get("type"), Some(&serde_json::json!("string")), "{tool_name}.{field}");
                assert!(!required.iter().any(|required| *required == field), "{tool_name}.{field} must stay optional");
            }
        }
    }

    #[test]
    fn optional_fields_never_publish_nullable_union_types() {
        // Some MCP clients (e.g. OpenCode, see #6344) cannot resolve a JSON Schema
        // `"type": ["string", "null"]` union and fall back to wrapping the argument in a
        // nested error object instead of passing the value through. b521d0377 fixed this for
        // `ConnectionSelector`'s connection_id/connection_name but left every other optional
        // field on these request structs emitting the same union shape. Every optional field
        // must instead publish a single concrete `type`, relying on omission from `required`
        // (not a `"null"` union member) to signal optionality.
        let server = DbxMcpServer::with_runtime_options(Arc::new(FakeBackend::default()), McpScope::default(), false);
        let tools = server.tool_router.list_all();

        #[allow(unused_mut)]
        let mut checks: Vec<(&str, &[&str])> = vec![
            ("dbx_list_tables", &["database", "schema"]),
            ("dbx_describe_table", &["database", "schema"]),
            ("dbx_list_routines", &["database", "schema", "routine_type"]),
            ("dbx_get_routine_source", &["database", "schema", "signature"]),
            ("dbx_execute_query", &["database", "session_id", "cell_char_offset", "cell_char_limit", "max_rows"]),
            (
                "dbx_execute_batch",
                &[
                    "database",
                    "session_id",
                    "continue_on_error",
                    "use_transaction",
                    "cell_char_offset",
                    "cell_char_limit",
                ],
            ),
            ("dbx_open_session", &["database", "enable_transactions"]),
            ("dbx_open_table", &["database", "schema"]),
            ("dbx_execute_and_show", &["database"]),
            ("dbx_add_connection", &["port", "database", "driver_profile"]),
            ("dbx_remove_connection", &["connection_id", "connection_name"]),
            ("dbx_execute_redis_command", &["db"]),
            ("dbx_get_schema_context", &["database", "schema", "max_tables"]),
        ];
        #[cfg(feature = "mq-admin")]
        checks
            .push(("dbx_send_message", &["key", "payload_text", "partition", "exchange", "routing_key", "namespace"]));

        #[cfg(feature = "mq-admin")]
        checks.push(("dbx_peek_messages", &["count", "partition", "offset"]));
        for (tool_name, fields) in checks {
            let tool = tools.iter().find(|tool| tool.name == *tool_name).expect("tool should be registered");
            let properties = tool
                .input_schema
                .get("properties")
                .and_then(serde_json::Value::as_object)
                .expect("tool should publish object properties");
            let required = tool
                .input_schema
                .get("required")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .collect::<Vec<_>>();

            for &field in fields {
                let schema = properties.get(field).unwrap_or_else(|| panic!("{tool_name}.{field} should be published"));
                let type_value =
                    schema.get("type").unwrap_or_else(|| panic!("{tool_name}.{field} should publish a type"));
                assert!(
                    type_value.is_string(),
                    "{tool_name}.{field} must publish a single concrete type, not a union: {type_value:?}"
                );
                assert!(!required.iter().any(|required| *required == field), "{tool_name}.{field} must stay optional");
            }
        }
    }

    #[test]
    fn execute_query_selector_preserves_serde_inputs() {
        let omitted: ExecuteQueryRequest = serde_json::from_str(r#"{"sql":"SELECT 1"}"#).unwrap();
        let explicit_nulls: ExecuteQueryRequest =
            serde_json::from_str(r#"{"connection_id":null,"connection_name":null,"sql":"SELECT 1"}"#).unwrap();
        let by_name: ExecuteQueryRequest =
            serde_json::from_str(r#"{"connection_name":"test_conn","sql":"SELECT 1"}"#).unwrap();
        let by_id: ExecuteQueryRequest =
            serde_json::from_str(r#"{"connection_id":"123e4567-e89b-12d3-a456-426614174000","sql":"SELECT 1"}"#)
                .unwrap();

        assert!(omitted.selector.connection_id.is_none());
        assert!(omitted.selector.connection_name.is_none());
        assert!(omitted.max_rows.is_none());
        assert!(explicit_nulls.selector.connection_id.is_none());
        assert!(explicit_nulls.selector.connection_name.is_none());
        assert_eq!(by_name.selector.connection_name.as_deref(), Some("test_conn"));
        assert_eq!(by_id.selector.connection_id.as_deref(), Some("123e4567-e89b-12d3-a456-426614174000"));

        let with_max_rows: ExecuteQueryRequest = serde_json::from_str(r#"{"sql":"SELECT 1","max_rows":500}"#).unwrap();
        assert_eq!(with_max_rows.max_rows, Some(500));

        let nested = serde_json::from_str::<ExecuteQueryRequest>(
            r#"{"connection_name":{"tool":"dbx_dbx_execute_query","error":"Invalid input"},"sql":"SELECT 1"}"#,
        )
        .unwrap_err();
        assert!(nested.to_string().contains("invalid type: map, expected a string"));
    }

    #[cfg(feature = "mq-admin")]
    #[test]
    fn send_message_request_preserves_binary_payload_and_optional_fields() {
        let request: SendMessageRequest = serde_json::from_str(
            r#"{"connection_name":"events","topic":"orders","payload_base64":"AP8=","key":"order-1","partition":2,"headers":{"trace":"abc"}}"#,
        )
        .expect("send message request");

        assert_eq!(request.selector.connection_name.as_deref(), Some("events"));
        assert_eq!(request.topic, "orders");
        assert_eq!(request.payload_base64, "AP8=");
        assert_eq!(request.key.as_deref(), Some("order-1"));
        assert_eq!(request.partition, Some(2));
        assert_eq!(request.headers.get("trace").map(String::as_str), Some("abc"));
    }

    #[cfg(feature = "mq-admin")]
    #[test]
    fn format_send_message_result_is_concise_and_includes_delivery_metadata() {
        let result = dbx_core::mq::SendMessageResponse {
            topic: "orders".to_string(),
            partition: 2,
            offset: 41,
            timestamp: Some("1700000000000".to_string()),
        };
        let output = format_send_message_result(&dbx_core::mq::MqSystemKind::Kafka, &result);

        assert!(output.contains("Message sent to kafka."));
        assert!(output.contains("topic: orders"));
        assert!(output.contains("partition: 2"));
        assert!(output.contains("offset: 41"));
        assert!(output.contains("timestamp: 1700000000000"));
        assert!(!output.contains("AP8="));
    }

    #[test]
    fn schema_context_tables_preserve_optional_inputs() {
        let omitted: SchemaContextRequest = serde_json::from_str("{}").unwrap();
        let explicit_null: SchemaContextRequest = serde_json::from_str(r#"{"tables":null}"#).unwrap();
        let empty: SchemaContextRequest = serde_json::from_str(r#"{"tables":[]}"#).unwrap();
        let populated: SchemaContextRequest = serde_json::from_str(r#"{"tables":["users","orders"]}"#).unwrap();

        assert_eq!(omitted.tables, None);
        assert_eq!(explicit_null.tables, None);
        assert_eq!(empty.tables, Some(Vec::new()));
        assert_eq!(populated.tables, Some(vec!["users".to_string(), "orders".to_string()]));
    }

    #[test]
    fn scoped_server_hides_mutating_and_desktop_tools() {
        let server = DbxMcpServer::with_runtime_options(
            Arc::new(FakeBackend::default()),
            McpScope { connection_ids: vec!["scoped".to_string()], ..Default::default() },
            false,
        );
        let names = server.tool_router.list_all().into_iter().map(|tool| tool.name).collect::<Vec<_>>();
        #[cfg(feature = "mq-admin")]
        assert_eq!(names.len(), 20);
        #[cfg(not(feature = "mq-admin"))]
        assert_eq!(names.len(), 18);
        assert!(!names.iter().any(|name| name == "dbx_add_connection"));
        assert!(!names.iter().any(|name| name == "dbx_duplicate_connection"));
        assert!(!names.iter().any(|name| name == "dbx_remove_connection"));
        assert!(!names.iter().any(|name| name == "dbx_open_table"));
        assert!(!names.iter().any(|name| name == "dbx_execute_and_show"));
        assert!(names.iter().any(|name| name == "dbx_execute_batch"));
        assert!(names.iter().any(|name| name == "dbx_list_routines"));
        assert!(names.iter().any(|name| name == "dbx_get_routine_source"));
        assert!(names.iter().any(|name| name == "dbx_open_session"));
        assert!(names.iter().any(|name| name == "dbx_close_session"));
        assert!(names.iter().any(|name| name == "dbx_begin_transaction"));
        assert!(names.iter().any(|name| name == "dbx_commit_transaction"));
        assert!(names.iter().any(|name| name == "dbx_rollback_transaction"));
        // The Salesforce tools act on the scoped connection itself, so connection
        // scoping keeps them visible. What narrows them is the per-connection DML
        // opt-in and the execution policy, both re-checked on every call.
        assert!(names.iter().any(|name| name == "dbx_salesforce_current_user"));
        assert!(names.iter().any(|name| name == "dbx_salesforce_prepare_write"));
        assert!(names.iter().any(|name| name == "dbx_salesforce_apply_write"));
        #[cfg(feature = "mq-admin")]
        assert!(names.iter().any(|name| name == "dbx_send_message"));
    }

    #[test]
    fn scoped_connection_ids_are_deduplicated_and_take_precedence_over_name() {
        assert_eq!(scoped_connection_ids(Some(" first, second,first ,, ")), vec!["first", "second"]);

        let first = connection("first", "other", "sqlite", ":memory:");
        let named = ConnectionConfig { id: "named".to_string(), name: "scope-name".to_string(), ..first.clone() };
        let scope = McpScope {
            connection_ids: vec!["first".to_string()],
            connection_name: Some("scope-name".to_string()),
            database: None,
            schema: None,
        };

        assert!(scope.matches(&first));
        assert!(!scope.matches(&named));
    }

    #[tokio::test]
    async fn database_scope_is_a_hard_bound_without_filtering_connections() {
        let scoped = connection("scoped", "scoped", "postgres", "configured");
        let server = DbxMcpServer::with_runtime_options(
            Arc::new(FakeBackend { connections: vec![scoped.clone()], ..Default::default() }),
            McpScope { database: Some("analytics".to_string()), ..Default::default() },
            false,
        );

        assert_eq!(server.load_scoped_connections().await.unwrap().len(), 1);
        let resolved = resolved_connection_for_test(scoped.clone());
        assert_eq!(server.resolve_database(None, &resolved).unwrap(), "analytics");
        assert_eq!(server.resolve_database(Some("analytics".to_string()), &resolved).unwrap(), "analytics");
        let error = server.resolve_database(Some("production".to_string()), &resolved).unwrap_err();
        assert!(result_text(&error).contains("DATABASE_OUT_OF_SCOPE"));

        let names = server.tool_router.list_all().into_iter().map(|tool| tool.name).collect::<Vec<_>>();
        assert!(!names.iter().any(|name| name == "dbx_add_connection"));
        assert!(!names.iter().any(|name| name == "dbx_execute_and_show"));
    }

    #[test]
    fn configured_database_allowlist_is_enforced_for_sql_and_redis_targets() {
        let sql = connection("sql", "sql", "mysql", "reporting");
        let selected = ResolvedConnection {
            connection: sql,
            policy: McpGlobalPolicy::default(),
            database_scope: DatabaseScope::Selected(vec!["reporting".to_string()]),
            group_ids: Vec::new(),
        };
        let server = DbxMcpServer::with_runtime_options(Arc::new(FakeBackend::default()), McpScope::default(), false);
        assert_eq!(server.resolve_database(Some("reporting".to_string()), &selected).unwrap(), "reporting");
        let error = server.resolve_database(Some("production".to_string()), &selected).unwrap_err();
        assert!(result_text(&error).contains("DATABASE_OUT_OF_SCOPE"));

        let redis = ResolvedConnection {
            connection: connection("redis", "redis", "redis", "0"),
            policy: McpGlobalPolicy::default(),
            database_scope: DatabaseScope::Selected(vec!["2".to_string()]),
            group_ids: Vec::new(),
        };
        assert_eq!(server.resolve_redis_database(Some(2), &redis).unwrap(), 2);
        let error = server.resolve_redis_database(Some(3), &redis).unwrap_err();
        assert!(result_text(&error).contains("DATABASE_OUT_OF_SCOPE"));
    }

    #[tokio::test]
    async fn redis_select_is_rejected_even_with_high_risk_access() {
        let redis = connection("redis", "redis", "redis", "0");
        let backend = Arc::new(FakeBackend {
            connections: vec![redis],
            policy: McpGlobalPolicy {
                read_only: false,
                allow_dangerous_sql: true,
                allowed_connection_ids: None,
                ..Default::default()
            },
            ..Default::default()
        });
        let server = DbxMcpServer::with_runtime_options(backend, McpScope::default(), false);

        let result = server
            .execute_redis_command(Parameters(ExecuteRedisCommandRequest {
                selector: ConnectionSelector { connection_name: None, connection_id: Some("redis".to_string()) },
                db: Some(8),
                command: "SELECT 8".to_string(),
            }))
            .await;

        assert_eq!(result.is_error, Some(true));
        assert!(result_text(&result).contains("REDIS_DATABASE_SELECTION_REQUIRED"));
        assert!(result_text(&result).contains("Set the db argument"));
    }

    #[test]
    fn configured_database_allowlist_blocks_qualified_sql_references() {
        let connection = connection("sql", "sql", "mysql", "reporting");
        let scope = DatabaseScope::Selected(vec!["reporting".to_string()]);

        assert!(ensure_sql_database_scope(&scope, &connection, "reporting", "SELECT * FROM reporting.users").is_ok());
        let error =
            ensure_sql_database_scope(&scope, &connection, "reporting", "SELECT * FROM production.users").unwrap_err();
        assert!(result_text(&error).contains("DATABASE_OUT_OF_SCOPE"));
    }

    #[test]
    fn database_execution_policy_overrides_connection_and_global_defaults_and_blocks_cross_database_sql() {
        let connection = connection("sql", "sql", "mysql", "operations");
        let policy = McpGlobalPolicy {
            connection_policies: vec![dbx_core::storage::McpConnectionPolicy {
                connection_id: "sql".to_string(),
                read_only: false,
                allow_dangerous_sql: false,
                execution_mode_configured: true,
                execution_mode_policy_version: Some(dbx_core::mcp_policy::MCP_EXECUTION_POLICY_VERSION),
                database_scope: McpDatabaseScope::Selected,
                allowed_databases: vec!["operations".to_string(), "reporting".to_string()],
                database_policies: vec![
                    dbx_core::storage::McpDatabasePolicy {
                        database_name: "operations".to_string(),
                        read_only: false,
                        allow_dangerous_sql: true,
                    },
                    dbx_core::storage::McpDatabasePolicy {
                        database_name: "reporting".to_string(),
                        read_only: true,
                        allow_dangerous_sql: false,
                    },
                ],
                allow_salesforce_dml: false,
            }],
            ..Default::default()
        };

        let operations = effective_policy_for_database(&policy, &connection, "operations");
        assert!(!operations.read_only);
        assert!(operations.allow_dangerous_sql);

        let reporting = effective_policy_for_database(&policy, &connection, "reporting");
        assert!(reporting.read_only);
        assert!(!reporting.allow_dangerous_sql);

        let error = ensure_sql_database_execution_scope(
            &policy,
            &connection,
            "operations",
            "UPDATE reporting.jobs SET done = 1",
        )
        .unwrap_err();
        assert!(result_text(&error).contains("DATABASE_EXECUTION_POLICY_OUT_OF_SCOPE"));
    }

    #[tokio::test]
    async fn selected_database_scope_can_be_discovered_without_a_connection_default_database() {
        let connection = connection("sql", "sql", "mysql", "");
        let backend = Arc::new(FakeBackend {
            connections: vec![connection],
            policy: McpGlobalPolicy {
                allowed_connection_ids: Some(vec!["sql".to_string()]),
                connection_policies: vec![dbx_core::storage::McpConnectionPolicy {
                    connection_id: "sql".to_string(),
                    read_only: false,
                    allow_dangerous_sql: false,
                    database_scope: McpDatabaseScope::Selected,
                    allowed_databases: vec!["aa".to_string(), "aaa".to_string(), "abc".to_string()],
                    database_policies: Vec::new(),
                    execution_mode_configured: false,
                    execution_mode_policy_version: None,
                    allow_salesforce_dml: false,
                }],
                ..Default::default()
            },
            ..Default::default()
        });
        let server = DbxMcpServer::with_runtime_options(backend, McpScope::default(), false);
        let result = server.list_databases(Parameters(ListDatabasesRequest { selector: selector("sql") })).await;
        assert_eq!(result_text(&result), "- aa\n- aaa\n- abc");
        let show_databases = server
            .execute_query(Parameters(ExecuteQueryRequest {
                selector: selector("sql"),
                database: None,
                sql: "SHOW DATABASES".to_string(),
                session_id: None,
                cell_char_offset: None,
                cell_char_limit: None,
                max_rows: None,
            }))
            .await;
        assert_eq!(result_text(&show_databases), "- aa\n- aaa\n- abc");
        assert!(is_database_discovery_sql(" SHOW DATABASES; "));
        assert!(is_database_discovery_sql("show schemas"));
        assert!(!is_database_discovery_sql("show tables"));
    }

    #[test]
    fn schema_scope_is_a_hard_bound() {
        let dameng = connection("dameng-1", "Dameng", "dameng", "APPDB");
        let server = DbxMcpServer::with_runtime_options(
            Arc::new(FakeBackend::default()),
            McpScope {
                database: Some("APPDB".to_string()),
                schema: Some("REPORTING".to_string()),
                ..Default::default()
            },
            false,
        );

        let resolved = resolved_connection_for_test(dameng.clone());
        assert_eq!(server.resolve_database(None, &resolved).unwrap(), "APPDB");
        assert_eq!(server.resolve_schema(None).unwrap(), "REPORTING");
        assert_eq!(server.resolve_schema(Some("REPORTING".to_string())).unwrap(), "REPORTING");
        let error = server.resolve_schema(Some("APP_USER".to_string())).unwrap_err();
        assert!(result_text(&error).contains("SCHEMA_OUT_OF_SCOPE"));
    }

    #[test]
    fn redis_database_scope_fails_closed_and_cannot_be_overridden() {
        let redis = connection("redis", "redis", "redis", "1");
        let scoped = DbxMcpServer::with_runtime_options(
            Arc::new(FakeBackend { connections: vec![redis.clone()], ..Default::default() }),
            McpScope { database: Some("2".to_string()), ..Default::default() },
            false,
        );
        let resolved = resolved_connection_for_test(redis.clone());
        assert_eq!(scoped.resolve_redis_database(None, &resolved).unwrap(), 2);
        let error = scoped.resolve_redis_database(Some(3), &resolved).unwrap_err();
        assert!(result_text(&error).contains("DATABASE_OUT_OF_SCOPE"));

        let invalid = DbxMcpServer::with_runtime_options(
            Arc::new(FakeBackend { connections: vec![redis.clone()], ..Default::default() }),
            McpScope { database: Some("analytics".to_string()), ..Default::default() },
            false,
        );
        let error = invalid.resolve_redis_database(None, &resolved).unwrap_err();
        assert!(result_text(&error).contains("INVALID_DATABASE_SCOPE"));
    }

    #[test]
    fn local_mongo_aggregate_cannot_write_to_a_production_database() {
        let mut mongo = connection("mongo", "mongo", "mongodb", "staging");
        mongo.production_databases = vec!["production".to_string()];
        let policy = McpGlobalPolicy {
            read_only: false,
            allow_dangerous_sql: true,
            allowed_connection_ids: None,
            ..Default::default()
        };

        let error = validate_mongo_command(
            &mongo,
            &policy,
            &DatabaseScope::All,
            "staging",
            r#"db.items.aggregate([{"$out":{"db":"production","coll":"archive"}}])"#,
        )
        .unwrap_err();
        assert!(result_text(&error).contains("PRODUCTION_WRITE_BLOCKED"));

        assert!(validate_mongo_command(
            &mongo,
            &policy,
            &DatabaseScope::All,
            "staging",
            r#"db.items.aggregate([{"$out":"archive"}])"#,
        )
        .is_ok());
    }

    #[test]
    fn mongo_run_command_is_never_exposed_through_mcp() {
        let mongo = connection("mongo", "mongo", "mongodb", "staging");
        let source = r#"db.runCommand({ping: 1})"#;

        for policy in [
            McpGlobalPolicy {
                read_only: true,
                allow_dangerous_sql: false,
                allowed_connection_ids: None,
                ..Default::default()
            },
            McpGlobalPolicy {
                read_only: false,
                allow_dangerous_sql: false,
                allowed_connection_ids: None,
                ..Default::default()
            },
            McpGlobalPolicy {
                read_only: false,
                allow_dangerous_sql: true,
                allowed_connection_ids: None,
                ..Default::default()
            },
        ] {
            let error = validate_mongo_command(&mongo, &policy, &DatabaseScope::All, "staging", source).unwrap_err();
            assert!(result_text(&error).contains("SQL_BLOCKED"));
            assert!(result_text(&error).contains("runCommand"));
        }
    }

    #[test]
    fn mongo_sibling_database_run_command_is_never_exposed_through_mcp() {
        let mongo = connection("mongo", "mongo", "mongodb", "operations");
        let policy = McpGlobalPolicy {
            read_only: false,
            allow_dangerous_sql: true,
            allowed_connection_ids: None,
            ..Default::default()
        };

        let error = validate_mongo_command(
            &mongo,
            &policy,
            &DatabaseScope::All,
            "operations",
            r#"db.getSiblingDB("staging").runCommand({ping: 1})"#,
        )
        .unwrap_err();
        assert!(result_text(&error).contains("SQL_BLOCKED"));
        assert!(result_text(&error).contains("runCommand"));
    }

    #[test]
    fn mongo_sibling_database_honors_target_scope_and_read_only_policy() {
        let mongo = connection("mongo", "mongo", "mongodb", "operations");
        let policy = McpGlobalPolicy {
            connection_policies: vec![dbx_core::storage::McpConnectionPolicy {
                connection_id: "mongo".to_string(),
                read_only: false,
                allow_dangerous_sql: true,
                execution_mode_configured: true,
                execution_mode_policy_version: Some(dbx_core::mcp_policy::MCP_EXECUTION_POLICY_VERSION),
                database_scope: McpDatabaseScope::Selected,
                allowed_databases: vec!["operations".to_string(), "reporting".to_string()],
                database_policies: vec![
                    dbx_core::storage::McpDatabasePolicy {
                        database_name: "operations".to_string(),
                        read_only: false,
                        allow_dangerous_sql: true,
                    },
                    dbx_core::storage::McpDatabasePolicy {
                        database_name: "reporting".to_string(),
                        read_only: true,
                        allow_dangerous_sql: false,
                    },
                ],
                allow_salesforce_dml: false,
            }],
            ..Default::default()
        };

        let read_only_error = validate_mongo_command(
            &mongo,
            &policy,
            &DatabaseScope::Selected(vec!["operations".to_string(), "reporting".to_string()]),
            "operations",
            r#"db.getSiblingDB("reporting").users.deleteMany({_id: 1})"#,
        )
        .unwrap_err();
        assert!(result_text(&read_only_error).contains("MCP_READ_ONLY"));

        let scope_error = validate_mongo_command(
            &mongo,
            &policy,
            &DatabaseScope::Selected(vec!["operations".to_string()]),
            "operations",
            r#"db.getSiblingDB("reporting").users.find({})"#,
        )
        .unwrap_err();
        assert!(result_text(&scope_error).contains("DATABASE_OUT_OF_SCOPE"));
    }

    #[test]
    fn mongo_sibling_database_aggregate_honors_output_scope_and_production_protection() {
        let mut mongo = connection("mongo", "mongo", "mongodb", "operations");
        mongo.production_databases = vec!["production".to_string()];
        let policy = McpGlobalPolicy {
            read_only: false,
            allow_dangerous_sql: true,
            allowed_connection_ids: None,
            ..Default::default()
        };

        let production_error = validate_mongo_command(
            &mongo,
            &policy,
            &DatabaseScope::All,
            "operations",
            r#"db.getSiblingDB("staging").items.aggregate([{"$out":{"db":"production","coll":"archive"}}])"#,
        )
        .unwrap_err();
        assert!(result_text(&production_error).contains("PRODUCTION_WRITE_BLOCKED"));

        let scope_error = validate_mongo_command(
            &mongo,
            &policy,
            &DatabaseScope::Selected(vec!["operations".to_string(), "staging".to_string()]),
            "operations",
            r#"db.getSiblingDB("staging").items.aggregate([{"$merge":{"into":{"db":"archive","coll":"items"}}}])"#,
        )
        .unwrap_err();
        assert!(result_text(&scope_error).contains("DATABASE_OUT_OF_SCOPE"));
    }

    #[test]
    fn agent_results_preserve_stable_backend_policy_errors() {
        let result = agent_result(dbx_core::agent_events::ToolResult {
            tool_call_id: "test".to_string(),
            tool_name: "execute_query".to_string(),
            content: "Error: API request failed: MCP_READ_ONLY: policy changed".to_string(),
            is_error: true,
            explain_data: None,
        });
        assert!(result_text(&result).contains("Error [MCP_READ_ONLY]: policy changed"));
    }

    #[test]
    fn mcp_confirmation_and_policy_guards_fail_closed() {
        assert_eq!(
            normalize_confirmed_write_sql(Some("  DELETE FROM sessions WHERE id = 7  ".to_string())),
            Some("DELETE FROM sessions WHERE id = 7".to_string())
        );
        assert_eq!(normalize_confirmed_write_sql(Some(" \n ".to_string())), None);

        let read_only = ConnectionConfig { read_only: true, ..connection("readonly", "readonly", "postgres", "app") };
        let writable_policy = McpGlobalPolicy {
            read_only: false,
            allow_dangerous_sql: true,
            allowed_connection_ids: None,
            ..Default::default()
        };
        let read_only_error =
            validate_sql_policy(&read_only, &writable_policy, "app", "DELETE FROM sessions", false).unwrap_err();
        assert!(result_text(&read_only_error).contains("CONNECTION_READ_ONLY"));

        let mut production = connection("production", "production", "postgres", "app");
        production.production_databases = vec!["app".to_string()];
        let production_error =
            validate_sql_policy(&production, &writable_policy, "app", "DROP TABLE sessions", false).unwrap_err();
        assert!(result_text(&production_error).contains("PRODUCTION_WRITE_BLOCKED"));
    }

    /// RAII guard that sets an env var and restores the original value (or
    /// removes the var) on drop. Panic-safe — cleanup runs even when an
    /// assertion fails.
    struct EnvGuard {
        key: &'static str,
        original: Option<String>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let original = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, original }
        }

        fn remove(key: &'static str) -> Self {
            let original = std::env::var(key).ok();
            std::env::remove_var(key);
            Self { key, original }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.original {
                Some(original) => std::env::set_var(self.key, original),
                None => std::env::remove_var(self.key),
            }
        }
    }

    #[test]
    fn confirmed_sql_binding_cannot_elevate_central_policy() {
        let connection = connection("dev", "dev", "postgres", "app");

        // An exact confirmation remains available as a narrowing constraint,
        // but cannot turn the central safe-write policy into full access.
        let _guard = EnvGuard::set("DBX_MCP_CONFIRMED_WRITE_SQL", "CREATE TABLE metrics (id INT)");
        let safe_write = McpGlobalPolicy {
            read_only: false,
            allow_dangerous_sql: false,
            allowed_connection_ids: None,
            ..Default::default()
        };
        let permissions = mcp_permissions(&connection, &safe_write);
        assert!(!permissions.allow_dangerous, "confirmed SQL must NOT elevate allow_dangerous for Redis/Mongo paths");
        assert!(permissions.allow_writes);
        assert_eq!(permissions.confirmed_write_sql.as_deref(), Some("CREATE TABLE metrics (id INT)"));

        let error =
            validate_sql_policy(&connection, &safe_write, "app", "CREATE TABLE metrics (id INT)", false).unwrap_err();
        assert!(result_text(&error).contains("SQL_BLOCKED"));
        assert!(result_text(&error).contains("High-risk SQL is disabled"));
        drop(_guard);

        // A missing binding cannot change the same safe-write boundary.
        let _guard = EnvGuard::remove("DBX_MCP_CONFIRMED_WRITE_SQL");
        let error = validate_sql_policy(&connection, &safe_write, "app", "DROP TABLE sessions", false).unwrap_err();
        assert!(result_text(&error).contains("SQL_BLOCKED"));
        assert!(result_text(&error).contains("High-risk SQL is disabled"));
        drop(_guard);

        // Full access still permits an exact confirmed DDL statement and keeps
        // the binding for the execution-time anti-replay check.
        let _guard = EnvGuard::set("DBX_MCP_CONFIRMED_WRITE_SQL", "CREATE TABLE metrics (id INT)");
        let full_access = McpGlobalPolicy {
            read_only: false,
            allow_dangerous_sql: true,
            allowed_connection_ids: None,
            ..Default::default()
        };
        let permissions =
            validate_sql_policy(&connection, &full_access, "app", "CREATE TABLE metrics (id INT)", false).unwrap();
        assert!(permissions.allow_writes);
        assert!(permissions.allow_dangerous);
        assert_eq!(permissions.confirmed_write_sql.as_deref(), Some("CREATE TABLE metrics (id INT)"));

        // A global read-only policy is still authoritative even for the exact
        // confirmed statement, while read queries remain available.
        let read_only_policy = McpGlobalPolicy {
            read_only: true,
            allow_dangerous_sql: false,
            allowed_connection_ids: None,
            ..Default::default()
        };
        let error = validate_sql_policy(&connection, &read_only_policy, "app", "CREATE TABLE metrics (id INT)", false)
            .unwrap_err();
        assert!(result_text(&error).contains("MCP_READ_ONLY"), "confirmed SQL must not bypass global read_only");
        assert!(validate_sql_policy(&connection, &read_only_policy, "app", "SELECT 1", false).is_ok());
        drop(_guard);

        // Safe-write DML remains allowed, and an exact binding never grants the
        // DDL/high-risk bit implicitly.
        let _guard = EnvGuard::set("DBX_MCP_CONFIRMED_WRITE_SQL", "INSERT INTO metrics (id) VALUES (1)");
        let permissions =
            validate_sql_policy(&connection, &safe_write, "app", "INSERT INTO metrics (id) VALUES (1)", false).unwrap();
        assert!(permissions.allow_writes);
        assert!(!permissions.allow_dangerous);
        assert_eq!(permissions.confirmed_write_sql.as_deref(), Some("INSERT INTO metrics (id) VALUES (1)"));
    }

    #[test]
    fn use_statements_require_a_session() {
        let starrocks = connection("sr", "sr", "starrocks", "default_catalog");
        let policy = McpGlobalPolicy {
            read_only: false,
            allow_dangerous_sql: false,
            allowed_connection_ids: None,
            ..Default::default()
        };

        let blocked = validate_sql_policy(&starrocks, &policy, "default_catalog", "USE analytics", false).unwrap_err();
        assert!(result_text(&blocked).contains("SQL_BLOCKED"));
        assert!(result_text(&blocked).contains("dbx_open_session"));

        // Inside a pinned session, USE is meaningful and passes policy checks.
        assert!(validate_sql_policy(&starrocks, &policy, "default_catalog", "USE analytics", true).is_ok());
    }

    fn selector(id: &str) -> ConnectionSelector {
        ConnectionSelector { connection_id: Some(id.to_string()), connection_name: None }
    }

    #[tokio::test]
    async fn opted_in_session_exposes_transaction_tools_and_structured_state() {
        let policy = McpGlobalPolicy { read_only: false, allow_dangerous_sql: true, ..Default::default() };
        let backend = Arc::new(FakeBackend {
            connections: vec![connection("mysql", "mysql", "mysql", "app")],
            policy,
            ..Default::default()
        });
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);
        let opened = server
            .open_session(Parameters(OpenSessionRequest {
                selector: selector("mysql"),
                database: None,
                enable_transactions: true,
            }))
            .await;
        let session_id = opened_session_id(&opened);
        assert_eq!(backend.transaction_owners_opened.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(opened.structured_content.as_ref().unwrap()["transaction_state"], "idle");

        let begun =
            server.begin_transaction(Parameters(TransactionSessionRequest { session_id: session_id.clone() })).await;
        assert!(result_text(&begun).contains("transaction_state: active"));
        assert_eq!(begun.structured_content.as_ref().unwrap()["transaction_state"], "active");

        let queried = server
            .execute_query(Parameters(ExecuteQueryRequest {
                selector: selector("mysql"),
                database: None,
                sql: "SELECT id FROM accounts WHERE id = 1 FOR UPDATE".to_string(),
                session_id: Some(session_id.clone()),
                cell_char_offset: None,
                cell_char_limit: None,
                max_rows: None,
            }))
            .await;
        assert!(queried.structured_content.is_some(), "{}", result_text(&queried));
        assert_eq!(queried.structured_content.as_ref().unwrap()["transaction_state"], "active");

        let committed =
            server.commit_transaction(Parameters(TransactionSessionRequest { session_id: session_id.clone() })).await;
        let structured = committed.structured_content.as_ref().unwrap();
        assert!(result_text(&committed).contains("transaction_outcome: committed"));
        assert_eq!(structured["transaction_state"], "idle");
        assert_eq!(structured["transaction_outcome"], "committed");

        let closed = server.close_session(Parameters(CloseSessionRequest { session_id })).await;
        assert!(!closed.is_error.unwrap_or(false));
    }

    #[tokio::test]
    async fn legacy_session_open_text_is_unchanged_when_transactions_are_disabled() {
        let backend = Arc::new(FakeBackend {
            connections: vec![connection("mysql", "mysql", "mysql", "app")],
            ..Default::default()
        });
        let server = DbxMcpServer::with_runtime_options(backend, McpScope::default(), false);

        let opened = server
            .open_session(Parameters(OpenSessionRequest {
                selector: selector("mysql"),
                database: None,
                enable_transactions: false,
            }))
            .await;

        assert!(!result_text(&opened).contains("transactions:"));
    }

    #[tokio::test]
    async fn transaction_opt_in_rejects_non_mysql_external_profiles_and_unsupported_backends() {
        let postgres_backend = Arc::new(FakeBackend {
            connections: vec![connection("pg", "pg", "postgres", "app")],
            ..Default::default()
        });
        let postgres_server = DbxMcpServer::with_runtime_options(postgres_backend.clone(), McpScope::default(), false);
        let rejected = postgres_server
            .open_session(Parameters(OpenSessionRequest {
                selector: selector("pg"),
                database: None,
                enable_transactions: true,
            }))
            .await;
        assert!(result_text(&rejected).contains("TRANSACTION_UNSUPPORTED"));
        assert_eq!(postgres_backend.transaction_owners_opened.load(std::sync::atomic::Ordering::SeqCst), 0);

        let mut builtin_mysql = connection("builtin", "builtin", "mysql", "app");
        builtin_mysql.driver_profile = Some("mysql".to_string());
        let builtin_backend = Arc::new(FakeBackend { connections: vec![builtin_mysql], ..Default::default() });
        let builtin_server = DbxMcpServer::with_runtime_options(builtin_backend.clone(), McpScope::default(), false);
        let opened = builtin_server
            .open_session(Parameters(OpenSessionRequest {
                selector: selector("builtin"),
                database: None,
                enable_transactions: true,
            }))
            .await;
        assert!(!opened.is_error.unwrap_or(false));
        assert_eq!(builtin_backend.transaction_owners_opened.load(std::sync::atomic::Ordering::SeqCst), 1);

        let mut external_mysql = connection("external", "external", "mysql", "app");
        external_mysql.driver_profile = Some("custom-profile".to_string());
        let external_backend = Arc::new(FakeBackend { connections: vec![external_mysql], ..Default::default() });
        let external_server = DbxMcpServer::with_runtime_options(external_backend.clone(), McpScope::default(), false);
        let rejected = external_server
            .open_session(Parameters(OpenSessionRequest {
                selector: selector("external"),
                database: None,
                enable_transactions: true,
            }))
            .await;
        assert!(result_text(&rejected).contains("TRANSACTION_UNSUPPORTED"));
        assert_eq!(external_backend.transaction_owners_opened.load(std::sync::atomic::Ordering::SeqCst), 0);

        let unsupported_backend = Arc::new(FakeBackend {
            connections: vec![connection("mysql", "mysql", "mysql", "app")],
            transaction_open_error: Some("TRANSACTION_UNSUPPORTED: backend has no native fixed session".to_string()),
            ..Default::default()
        });
        let unsupported_server = DbxMcpServer::with_runtime_options(unsupported_backend, McpScope::default(), false);
        let rejected = unsupported_server
            .open_session(Parameters(OpenSessionRequest {
                selector: selector("mysql"),
                database: None,
                enable_transactions: true,
            }))
            .await;
        assert!(result_text(&rejected).contains("TRANSACTION_UNSUPPORTED"));
    }

    #[tokio::test]
    async fn invalid_transaction_transitions_do_not_send_sql() {
        let backend = Arc::new(FakeBackend {
            connections: vec![connection("mysql", "mysql", "mysql", "app")],
            ..Default::default()
        });
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);
        let opened = server
            .open_session(Parameters(OpenSessionRequest {
                selector: selector("mysql"),
                database: None,
                enable_transactions: true,
            }))
            .await;
        let session_id = opened_session_id(&opened);

        let no_active_commit =
            server.commit_transaction(Parameters(TransactionSessionRequest { session_id: session_id.clone() })).await;
        assert!(result_text(&no_active_commit).contains("TRANSACTION_NOT_ACTIVE"));
        server.begin_transaction(Parameters(TransactionSessionRequest { session_id: session_id.clone() })).await;
        let nested =
            server.begin_transaction(Parameters(TransactionSessionRequest { session_id: session_id.clone() })).await;
        assert!(result_text(&nested).contains("TRANSACTION_ALREADY_ACTIVE"));
        server.rollback_transaction(Parameters(TransactionSessionRequest { session_id: session_id.clone() })).await;
        let no_active_rollback =
            server.rollback_transaction(Parameters(TransactionSessionRequest { session_id })).await;
        assert!(result_text(&no_active_rollback).contains("TRANSACTION_NOT_ACTIVE"));
        assert_eq!(backend.transaction_owner_sql.lock().unwrap().as_slice(), ["START TRANSACTION", "ROLLBACK"]);
    }

    #[tokio::test]
    async fn queued_transaction_query_rechecks_revoked_policy_before_io() {
        let policy = McpGlobalPolicy { allow_dangerous_sql: true, ..Default::default() };
        let backend = Arc::new(FakeBackend {
            connections: vec![connection("mysql", "mysql", "mysql", "app")],
            policy: policy.clone(),
            ..Default::default()
        });
        let server = Arc::new(DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false));
        let opened = server
            .open_session(Parameters(OpenSessionRequest {
                selector: selector("mysql"),
                database: None,
                enable_transactions: true,
            }))
            .await;
        let session_id = opened_session_id(&opened);
        server.begin_transaction(Parameters(TransactionSessionRequest { session_id: session_id.clone() })).await;

        let release_first = Arc::new(tokio::sync::Notify::new());
        *backend.transaction_block_next_sql.lock().unwrap() = Some(release_first.clone());
        let first = {
            let server = server.clone();
            let session_id = session_id.clone();
            tokio::spawn(async move {
                server
                    .execute_query(Parameters(ExecuteQueryRequest {
                        selector: selector("mysql"),
                        database: None,
                        sql: "SELECT id FROM accounts WHERE id = 1 FOR UPDATE".to_string(),
                        session_id: Some(session_id),
                        cell_char_offset: None,
                        cell_char_limit: None,
                        max_rows: None,
                    }))
                    .await
            })
        };
        while backend.transaction_owner_sql.lock().unwrap().len() < 2 {
            tokio::task::yield_now().await;
        }
        let queued = {
            let server = server.clone();
            let session_id = session_id.clone();
            tokio::spawn(async move {
                server
                    .execute_query(Parameters(ExecuteQueryRequest {
                        selector: selector("mysql"),
                        database: None,
                        sql: "UPDATE accounts SET name = 'revoked' WHERE id = 1".to_string(),
                        session_id: Some(session_id),
                        cell_char_offset: None,
                        cell_char_limit: None,
                        max_rows: None,
                    }))
                    .await
            })
        };
        tokio::task::yield_now().await;
        let mut revoked = policy;
        revoked.read_only = true;
        *backend.policy_override.lock().unwrap() = Some(revoked);
        release_first.notify_one();
        assert!(!first.await.unwrap().is_error.unwrap_or(false));

        let denied = queued.await.unwrap();
        assert!(result_text(&denied).contains("MCP_READ_ONLY"));
        assert_eq!(
            backend.transaction_owner_sql.lock().unwrap().as_slice(),
            ["START TRANSACTION", "SELECT id FROM accounts WHERE id = 1 FOR UPDATE"]
        );

        let rolled_back =
            server.rollback_transaction(Parameters(TransactionSessionRequest { session_id: session_id.clone() })).await;
        assert!(!rolled_back.is_error.unwrap_or(false));
        let closed = server.close_session(Parameters(CloseSessionRequest { session_id })).await;
        assert!(!closed.is_error.unwrap_or(false));
    }

    #[tokio::test]
    async fn transaction_batch_keeps_one_lease_and_reports_each_resulting_state() {
        let policy = McpGlobalPolicy { allow_dangerous_sql: true, ..Default::default() };
        let backend = Arc::new(FakeBackend {
            connections: vec![connection("mysql", "mysql", "mysql", "app")],
            policy,
            ..Default::default()
        });
        let server = Arc::new(DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false));
        let opened = server
            .open_session(Parameters(OpenSessionRequest {
                selector: selector("mysql"),
                database: None,
                enable_transactions: true,
            }))
            .await;
        let session_id = opened_session_id(&opened);
        server.begin_transaction(Parameters(TransactionSessionRequest { session_id: session_id.clone() })).await;

        let release_first = Arc::new(tokio::sync::Notify::new());
        *backend.transaction_block_next_sql.lock().unwrap() = Some(release_first.clone());
        let batch = {
            let server = server.clone();
            let session_id = session_id.clone();
            tokio::spawn(async move {
                server
                    .execute_batch(Parameters(ExecuteBatchQueryRequest {
                        selector: selector("mysql"),
                        cell_window: CellWindowArgs::default(),
                        database: None,
                        sql: "UPDATE accounts SET name = 'first' WHERE id = 1; SELECT id FROM accounts WHERE id = 1"
                            .to_string(),
                        session_id: Some(session_id),
                        continue_on_error: Some(true),
                        use_transaction: None,
                    }))
                    .await
            })
        };
        while backend.transaction_owner_sql.lock().unwrap().len() < 2 {
            tokio::task::yield_now().await;
        }
        let queued_query = {
            let server = server.clone();
            let session_id = session_id.clone();
            tokio::spawn(async move {
                server
                    .execute_query(Parameters(ExecuteQueryRequest {
                        selector: selector("mysql"),
                        database: None,
                        sql: "SELECT id FROM accounts WHERE id = 2".to_string(),
                        session_id: Some(session_id),
                        cell_char_offset: None,
                        cell_char_limit: None,
                        max_rows: None,
                    }))
                    .await
            })
        };
        release_first.notify_one();
        let batch = batch.await.unwrap();
        assert!(!batch.is_error.unwrap_or(false));
        let structured = batch.structured_content.as_ref().unwrap();
        assert_eq!(structured["transaction_state"], "active");
        assert_eq!(structured["results"][0]["transaction_state"], "active");
        assert_eq!(structured["results"][1]["transaction_state"], "active");
        assert!(!queued_query.await.unwrap().is_error.unwrap_or(false));
        assert_eq!(
            backend.transaction_owner_sql.lock().unwrap().as_slice(),
            [
                "START TRANSACTION",
                "UPDATE accounts SET name = 'first' WHERE id = 1",
                "SELECT id FROM accounts WHERE id = 1",
                "SELECT id FROM accounts WHERE id = 2",
            ]
        );
    }

    #[tokio::test]
    async fn dropping_protocol_server_rolls_back_its_active_transaction_sessions() {
        let policy = McpGlobalPolicy { allow_dangerous_sql: true, ..Default::default() };
        let backend = Arc::new(FakeBackend {
            connections: vec![connection("mysql", "mysql", "mysql", "app")],
            policy,
            ..Default::default()
        });
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);
        let opened = server
            .open_session(Parameters(OpenSessionRequest {
                selector: selector("mysql"),
                database: None,
                enable_transactions: true,
            }))
            .await;
        let session_id = opened_session_id(&opened);
        server.begin_transaction(Parameters(TransactionSessionRequest { session_id })).await;

        drop(server);

        tokio::time::timeout(std::time::Duration::from_millis(250), async {
            loop {
                if backend.transaction_owner_sql.lock().unwrap().as_slice() == ["START TRANSACTION", "ROLLBACK"] {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("protocol session teardown must trigger bounded rollback");
    }

    #[tokio::test]
    async fn protocol_cancellation_drops_a_busy_transaction_tool_request() {
        let policy = McpGlobalPolicy { allow_dangerous_sql: true, ..Default::default() };
        let backend = Arc::new(FakeBackend {
            connections: vec![connection("mysql", "mysql", "mysql", "app")],
            policy,
            ..Default::default()
        });
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);
        let (server_transport, client_transport) = tokio::io::duplex(64 * 1024);
        let server_task = tokio::spawn(async move { server.serve(server_transport).await });
        let mut client = ().serve(client_transport).await.unwrap();
        let mut service = server_task.await.unwrap().unwrap();
        let arguments = |value: serde_json::Value| value.as_object().cloned().unwrap();

        let opened = client
            .peer()
            .call_tool(CallToolRequestParams::new("dbx_open_session").with_arguments(arguments(json!({
                "connection_id": "mysql",
                "database": "app",
                "enable_transactions": true
            }))))
            .await
            .unwrap();
        let session_id = opened.structured_content.unwrap()["session_id"].as_str().unwrap().to_string();
        client
            .peer()
            .call_tool(
                CallToolRequestParams::new("dbx_begin_transaction")
                    .with_arguments(arguments(json!({"session_id": session_id}))),
            )
            .await
            .unwrap();

        *backend.transaction_block_next_sql.lock().unwrap() = Some(Arc::new(tokio::sync::Notify::new()));
        let request = ClientRequest::CallToolRequest(CallToolRequest::new(
            CallToolRequestParams::new("dbx_execute_query").with_arguments(arguments(json!({
                "connection_id": "mysql",
                "database": "app",
                "session_id": session_id,
                "sql": "SELECT id FROM accounts WHERE id = 1 FOR UPDATE"
            }))),
        ));
        let request = client.peer().send_cancellable_request(request, PeerRequestOptions::no_options()).await.unwrap();
        while backend.transaction_owner_sql.lock().unwrap().len() < 2 {
            tokio::task::yield_now().await;
        }
        request.cancel(Some("test cancellation".to_string())).await.unwrap();

        let follow_up = tokio::time::timeout(
            std::time::Duration::from_millis(250),
            client.peer().call_tool(CallToolRequestParams::new("dbx_execute_query").with_arguments(arguments(json!({
                "connection_id": "mysql",
                "database": "app",
                "session_id": session_id,
                "sql": "SELECT 2"
            })))),
        )
        .await
        .expect("protocol cancellation must release the transaction operation slot")
        .unwrap();
        assert_eq!(follow_up.is_error, Some(true));

        let _ = client.close_with_timeout(std::time::Duration::from_millis(250)).await;
        let _ = service.close_with_timeout(std::time::Duration::from_millis(250)).await;
    }

    #[tokio::test]
    async fn session_queries_pin_client_session_and_close_releases_pool() {
        let starrocks = connection("sr", "sr", "starrocks", "default_catalog");
        let backend = Arc::new(FakeBackend { connections: vec![starrocks], ..Default::default() });
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);

        let opened = server
            .open_session(Parameters(OpenSessionRequest {
                selector: selector("sr"),
                database: None,
                enable_transactions: false,
            }))
            .await;
        let session_id = opened_session_id(&opened);

        // A USE statement is allowed inside the session and runs with the
        // session's pinned client_session_id.
        let result = server
            .execute_query(Parameters(ExecuteQueryRequest {
                selector: selector("sr"),
                database: None,
                sql: "USE analytics".to_string(),
                session_id: Some(session_id.clone()),
                cell_char_offset: None,
                cell_char_limit: None,
                max_rows: None,
            }))
            .await;
        assert_eq!(result_text(&result), "ok");
        let pinned_client_session = {
            let recorded = backend.recorded_arguments.lock().unwrap();
            let (_, arguments) = recorded.iter().find(|(name, _)| name == "execute_query").unwrap();
            arguments["client_session_id"].as_str().unwrap().to_string()
        };
        assert_eq!(pinned_client_session, format!("mcp:{session_id}"));

        // Queries bound to another database are rejected.
        let mismatch = server
            .execute_query(Parameters(ExecuteQueryRequest {
                selector: selector("sr"),
                database: Some("other".to_string()),
                sql: "SELECT 1".to_string(),
                session_id: Some(session_id.clone()),
                cell_char_offset: None,
                cell_char_limit: None,
                max_rows: None,
            }))
            .await;
        assert!(result_text(&mismatch).contains("SESSION_DATABASE_MISMATCH"));

        let closed = server.close_session(Parameters(CloseSessionRequest { session_id: session_id.clone() })).await;
        assert!(result_text(&closed).contains("closed"));
        assert_eq!(backend.closed_sessions.lock().unwrap().as_slice(), [format!("mcp:{session_id}")]);

        // The session is gone: further queries fail instead of silently
        // falling back to an unpinned connection.
        let missing = server
            .execute_query(Parameters(ExecuteQueryRequest {
                selector: selector("sr"),
                database: None,
                sql: "SELECT 1".to_string(),
                session_id: Some(session_id.clone()),
                cell_char_offset: None,
                cell_char_limit: None,
                max_rows: None,
            }))
            .await;
        assert!(result_text(&missing).contains("SESSION_NOT_FOUND"));

        let second_close = server.close_session(Parameters(CloseSessionRequest { session_id })).await;
        assert!(result_text(&second_close).contains("SESSION_NOT_FOUND"));
    }

    #[tokio::test]
    async fn execute_query_forwards_character_window_options() {
        let elasticsearch = connection("es", "es", "elasticsearch", "");
        let backend = Arc::new(FakeBackend { connections: vec![elasticsearch], ..Default::default() });
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);

        let result = server
            .execute_query(Parameters(ExecuteQueryRequest {
                selector: selector("es"),
                database: None,
                sql: "GET /logs/_search".to_string(),
                session_id: None,
                cell_char_offset: Some(200),
                cell_char_limit: Some(800),
                max_rows: None,
            }))
            .await;

        assert_eq!(result_text(&result), "ok");
        let recorded = backend.recorded_arguments.lock().unwrap();
        let (_, arguments) = recorded.iter().find(|(name, _)| name == "execute_query").unwrap();
        assert_eq!(arguments["cell_char_offset"], 200);
        assert_eq!(arguments["cell_char_limit"], 800);
    }

    #[tokio::test]
    async fn execute_query_forwards_and_clamps_max_rows() {
        let elasticsearch = connection("esm", "esm", "elasticsearch", "");
        let backend = Arc::new(FakeBackend { connections: vec![elasticsearch], ..Default::default() });
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);

        for max_rows in [None, Some(500), Some(100_000), Some(0)] {
            let result = server
                .execute_query(Parameters(ExecuteQueryRequest {
                    selector: selector("esm"),
                    database: None,
                    sql: "GET /logs/_search".to_string(),
                    session_id: None,
                    cell_char_offset: None,
                    cell_char_limit: None,
                    max_rows,
                }))
                .await;
            assert_eq!(result_text(&result), "ok");
        }

        let recorded = backend.recorded_arguments.lock().unwrap();
        let limits = recorded
            .iter()
            .filter(|(name, _)| name == "execute_query")
            .map(|(_, arguments)| arguments["limit"].as_u64().expect("limit should be published"))
            .collect::<Vec<_>>();
        // Omitted keeps the historical 100-row default; explicit values are clamped
        // into 1..=MAX_EXECUTE_QUERY_ROWS rather than rejected.
        assert_eq!(limits, vec![100, 500, MAX_EXECUTE_QUERY_ROWS as u64, 1]);
    }

    #[tokio::test]
    async fn expired_sessions_close_backend_pools_without_accumulating() {
        let starrocks = connection("sr", "sr", "starrocks", "default_catalog");
        let backend = Arc::new(FakeBackend { connections: vec![starrocks], ..Default::default() });
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);
        let mut expired_client_session_ids = Vec::new();

        for _ in 0..3 {
            let opened = server
                .open_session(Parameters(OpenSessionRequest {
                    selector: selector("sr"),
                    database: None,
                    enable_transactions: false,
                }))
                .await;
            let session_id = opened_session_id(&opened);
            let result = server
                .execute_query(Parameters(ExecuteQueryRequest {
                    selector: selector("sr"),
                    database: None,
                    sql: "SELECT 1".to_string(),
                    session_id: Some(session_id.clone()),
                    cell_char_offset: None,
                    cell_char_limit: None,
                    max_rows: None,
                }))
                .await;
            assert_eq!(result_text(&result), "ok");
            assert_eq!(backend.pinned_sessions.lock().unwrap().len(), 1);

            server.sessions.expire_for_test(&session_id).await;
            expired_client_session_ids.push(format!("mcp:{session_id}"));
        }

        let opened = server
            .open_session(Parameters(OpenSessionRequest {
                selector: selector("sr"),
                database: None,
                enable_transactions: false,
            }))
            .await;
        let final_session_id = opened_session_id(&opened);
        assert!(backend.pinned_sessions.lock().unwrap().is_empty());
        assert_eq!(backend.closed_sessions.lock().unwrap().as_slice(), expired_client_session_ids.as_slice());

        let closed = server.close_session(Parameters(CloseSessionRequest { session_id: final_session_id })).await;
        assert!(result_text(&closed).contains("closed"));
    }

    #[tokio::test]
    async fn cancelled_eager_open_while_backend_acquisition_is_blocked_does_not_leak_capacity() {
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let backend = Arc::new(FakeBackend {
            connections: vec![connection("mysql", "mysql", "mysql", "app")],
            transaction_open_before: Some((entered.clone(), release.clone())),
            ..Default::default()
        });
        let server = Arc::new(DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false));
        let opening = {
            let server = server.clone();
            tokio::spawn(async move {
                server
                    .open_session(Parameters(OpenSessionRequest {
                        selector: selector("mysql"),
                        database: None,
                        enable_transactions: true,
                    }))
                    .await
            })
        };
        entered.notified().await;

        opening.abort();
        assert!(opening.await.unwrap_err().is_cancelled());
        release.notify_waiters();

        tokio::time::timeout(Duration::from_millis(500), async {
            while backend.closed_sessions.lock().unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancelled provisional open must close its backend session");
        assert_eq!(backend.transaction_owner_disconnects.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cancelled_eager_open_after_owner_acquisition_disposes_owner_and_backend_session() {
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let backend = Arc::new(FakeBackend {
            connections: vec![connection("mysql", "mysql", "mysql", "app")],
            transaction_open_after_owner: Some((entered.clone(), release.clone())),
            ..Default::default()
        });
        let server = Arc::new(DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false));
        let opening = {
            let server = server.clone();
            tokio::spawn(async move {
                server
                    .open_session(Parameters(OpenSessionRequest {
                        selector: selector("mysql"),
                        database: None,
                        enable_transactions: true,
                    }))
                    .await
            })
        };
        entered.notified().await;

        opening.abort();
        assert!(opening.await.unwrap_err().is_cancelled());
        release.notify_waiters();

        tokio::time::timeout(Duration::from_millis(500), async {
            while backend.closed_sessions.lock().unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancelled prepared open must close its backend session");
        assert_eq!(backend.transaction_owner_disconnects.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn two_protocol_servers_share_physical_owner_budget_until_cleanup_finishes() {
        let backend = Arc::new(FakeBackend {
            connections: vec![connection("mysql", "mysql", "mysql", "app")],
            ..Default::default()
        });
        let server_a = Arc::new(DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false));
        let server_b = Arc::new(DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false));
        let mut sessions_a = Vec::new();
        for _ in 0..16 {
            let opened = server_a
                .open_session(Parameters(OpenSessionRequest {
                    selector: selector("mysql"),
                    database: None,
                    enable_transactions: true,
                }))
                .await;
            assert!(!opened.is_error.unwrap_or(false));
            sessions_a.push(opened_session_id(&opened));
        }
        for _ in 0..16 {
            let opened = server_b
                .open_session(Parameters(OpenSessionRequest {
                    selector: selector("mysql"),
                    database: None,
                    enable_transactions: true,
                }))
                .await;
            assert!(!opened.is_error.unwrap_or(false));
        }

        let rejected = server_b
            .open_session(Parameters(OpenSessionRequest {
                selector: selector("mysql"),
                database: None,
                enable_transactions: true,
            }))
            .await;
        assert!(result_text(&rejected).contains("max 32"));

        let session_id = sessions_a.pop().unwrap();
        let hidden_from_other_protocol =
            server_b.begin_transaction(Parameters(TransactionSessionRequest { session_id: session_id.clone() })).await;
        assert!(result_text(&hidden_from_other_protocol).contains("SESSION_NOT_FOUND"));
        server_a.begin_transaction(Parameters(TransactionSessionRequest { session_id: session_id.clone() })).await;
        let rollback_release = Arc::new(tokio::sync::Notify::new());
        *backend.transaction_block_next_sql.lock().unwrap() = Some(rollback_release.clone());
        let closing = {
            let server = server_a.clone();
            let session_id = session_id.clone();
            tokio::spawn(async move { server.close_session(Parameters(CloseSessionRequest { session_id })).await })
        };
        while !backend.transaction_owner_sql.lock().unwrap().iter().any(|sql| sql == "ROLLBACK") {
            tokio::task::yield_now().await;
        }
        closing.abort();
        assert!(closing.await.unwrap_err().is_cancelled());

        let still_rejected = server_b
            .open_session(Parameters(OpenSessionRequest {
                selector: selector("mysql"),
                database: None,
                enable_transactions: true,
            }))
            .await;
        assert!(result_text(&still_rejected).contains("max 32"));

        rollback_release.notify_one();
        tokio::time::timeout(Duration::from_millis(500), async {
            while backend.transaction_owner_budget.available_permits() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("physical owner permit must return after disposal");

        let opened = server_b
            .open_session(Parameters(OpenSessionRequest {
                selector: selector("mysql"),
                database: None,
                enable_transactions: true,
            }))
            .await;
        assert!(!opened.is_error.unwrap_or(false));
    }

    #[tokio::test]
    async fn failed_session_close_can_be_retried() {
        let starrocks = connection("sr", "sr", "starrocks", "default_catalog");
        let backend = Arc::new(FakeBackend { connections: vec![starrocks], ..Default::default() });
        *backend.close_failures_remaining.lock().unwrap() = 1;
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);

        let opened = server
            .open_session(Parameters(OpenSessionRequest {
                selector: selector("sr"),
                database: None,
                enable_transactions: false,
            }))
            .await;
        let session_id = opened_session_id(&opened);
        let query = server
            .execute_query(Parameters(ExecuteQueryRequest {
                selector: selector("sr"),
                database: None,
                sql: "SELECT 1".to_string(),
                session_id: Some(session_id.clone()),
                cell_char_offset: None,
                cell_char_limit: None,
                max_rows: None,
            }))
            .await;
        assert_eq!(result_text(&query), "ok");

        let failed = server.close_session(Parameters(CloseSessionRequest { session_id: session_id.clone() })).await;
        assert!(result_text(&failed).contains("SESSION_CLOSE_ERROR"));
        assert_eq!(backend.pinned_sessions.lock().unwrap().len(), 1);

        let retry_query = server
            .execute_query(Parameters(ExecuteQueryRequest {
                selector: selector("sr"),
                database: None,
                sql: "SELECT 1".to_string(),
                session_id: Some(session_id.clone()),
                cell_char_offset: None,
                cell_char_limit: None,
                max_rows: None,
            }))
            .await;
        assert_eq!(result_text(&retry_query), "ok");

        let closed = server.close_session(Parameters(CloseSessionRequest { session_id })).await;
        assert!(result_text(&closed).contains("closed"));
        assert!(backend.pinned_sessions.lock().unwrap().is_empty());
        assert_eq!(backend.closed_sessions.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn open_session_rejects_non_sql_connections_and_unknown_sessions_fail_closed() {
        let redis = connection("redis", "redis", "redis", "0");
        let pg = connection("pg", "pg", "postgres", "app");
        let server = DbxMcpServer::with_runtime_options(
            Arc::new(FakeBackend { connections: vec![redis, pg], ..Default::default() }),
            McpScope::default(),
            false,
        );
        let rejected = server
            .open_session(Parameters(OpenSessionRequest {
                selector: selector("redis"),
                database: None,
                enable_transactions: false,
            }))
            .await;
        assert!(result_text(&rejected).contains("SESSION_UNSUPPORTED"));

        let missing = server
            .execute_query(Parameters(ExecuteQueryRequest {
                selector: selector("pg"),
                database: None,
                sql: "SELECT 1".to_string(),
                session_id: Some("mcp-session-nope".to_string()),
                cell_char_offset: None,
                cell_char_limit: None,
                max_rows: None,
            }))
            .await;
        assert!(result_text(&missing).contains("SESSION_NOT_FOUND"));
    }

    #[tokio::test]
    async fn execute_batch_forwards_options_and_surfaces_results() {
        let postgres = connection("pg", "pg", "postgres", "app");
        let backend = Arc::new(FakeBackend { connections: vec![postgres], ..Default::default() });
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);

        let result = server
            .execute_batch(Parameters(ExecuteBatchQueryRequest {
                selector: selector("pg"),
                cell_window: CellWindowArgs::default(),
                database: Some("app".to_string()),
                sql: "SELECT 1; SELECT 2".to_string(),
                session_id: None,
                continue_on_error: Some(true),
                use_transaction: None,
            }))
            .await;

        // Auto-commit mode returns per-statement results; continue_on_error is
        // forwarded to the core.
        assert!(result_text(&result).contains("Statement 1"));
        let ephemeral_session_id = {
            let recorded = backend.recorded_arguments.lock().unwrap();
            let (_, arguments) = recorded.iter().find(|(name, _)| name == "execute_batch").unwrap();
            assert_eq!(arguments["continue_on_error"], true);
            assert!(
                arguments["use_transaction"].is_null(),
                "use_transaction must be forwarded as null, got: {}",
                arguments["use_transaction"]
            );
            arguments["client_session_id"]
                .as_str()
                .expect("auto-commit batch must use an ephemeral session")
                .to_string()
        };
        assert!(ephemeral_session_id.starts_with("mcp-batch-"));
        assert_eq!(backend.closed_sessions.lock().unwrap().as_slice(), [ephemeral_session_id]);
    }

    #[tokio::test]
    async fn execute_batch_pins_session_and_forwards_client_session_id() {
        let postgres = connection("pg", "pg", "postgres", "app");
        let backend = Arc::new(FakeBackend { connections: vec![postgres], ..Default::default() });
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);

        let opened = server
            .open_session(Parameters(OpenSessionRequest {
                selector: selector("pg"),
                database: None,
                enable_transactions: false,
            }))
            .await;
        let session_id = opened_session_id(&opened);

        let result = server
            .execute_batch(Parameters(ExecuteBatchQueryRequest {
                selector: selector("pg"),
                cell_window: CellWindowArgs::default(),
                database: None,
                sql: "SELECT 1; SELECT 2".to_string(),
                session_id: Some(session_id.clone()),
                continue_on_error: Some(false),
                use_transaction: None,
            }))
            .await;
        assert!(result_text(&result).contains("Statement 1"), "got: {}", result_text(&result));
        let recorded = backend.recorded_arguments.lock().unwrap();
        let (_, arguments) = recorded.iter().find(|(name, _)| name == "execute_batch").unwrap();
        assert_eq!(arguments["client_session_id"], format!("mcp:{session_id}"));
        assert!(backend.pinned_sessions.lock().unwrap().contains(&format!("mcp:{session_id}")));
    }

    #[tokio::test]
    async fn execute_batch_blocks_redis_and_mongo_connections() {
        for (id, db_type) in [("redis", "redis"), ("mongo", "mongodb")] {
            let backend =
                Arc::new(FakeBackend { connections: vec![connection(id, id, db_type, "db")], ..Default::default() });
            let server = DbxMcpServer::with_runtime_options(backend, McpScope::default(), false);
            let result = server
                .execute_batch(Parameters(ExecuteBatchQueryRequest {
                    selector: selector(id),
                    cell_window: CellWindowArgs::default(),
                    database: None,
                    sql: "SELECT 1".to_string(),
                    session_id: None,
                    continue_on_error: None,
                    use_transaction: None,
                }))
                .await;
            assert!(result_text(&result).contains("DBX_BATCH_UNSUPPORTED"));
        }
    }

    #[tokio::test]
    async fn execute_batch_forwards_scoped_schema() {
        let postgres = connection("pg", "pg", "postgres", "app");
        let backend = Arc::new(FakeBackend { connections: vec![postgres], ..Default::default() });
        let server = DbxMcpServer::with_runtime_options(
            backend.clone(),
            McpScope { schema: Some("REPORTING".to_string()), ..Default::default() },
            false,
        );

        let result = server
            .execute_batch(Parameters(ExecuteBatchQueryRequest {
                selector: selector("pg"),
                cell_window: CellWindowArgs::default(),
                database: None,
                sql: "SELECT 1; SELECT 2".to_string(),
                session_id: None,
                continue_on_error: None,
                use_transaction: None,
            }))
            .await;
        assert!(result_text(&result).contains("Statement 1"));

        let recorded = backend.recorded_arguments.lock().unwrap();
        let (_, arguments) = recorded.iter().find(|(name, _)| name == "execute_batch").unwrap();
        assert_eq!(arguments["schema"], "REPORTING");
    }

    #[tokio::test]
    async fn execute_batch_rejects_empty_script() {
        let postgres = connection("pg", "pg", "postgres", "app");
        let server = DbxMcpServer::with_runtime_options(
            Arc::new(FakeBackend { connections: vec![postgres], ..Default::default() }),
            McpScope::default(),
            false,
        );
        let result = server
            .execute_batch(Parameters(ExecuteBatchQueryRequest {
                selector: selector("pg"),
                cell_window: CellWindowArgs::default(),
                database: None,
                sql: "   ".to_string(),
                session_id: None,
                continue_on_error: None,
                use_transaction: None,
            }))
            .await;
        assert!(result_text(&result).contains("SQL_BATCH_EMPTY"));
    }

    #[tokio::test]
    async fn executed_mcp_query_is_saved_with_source_and_failure_status() {
        let postgres = connection("pg", "Reporting", "postgres", "app");
        let backend = Arc::new(FakeBackend { connections: vec![postgres], ..Default::default() });
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);

        let query = |sql: &str| ExecuteQueryRequest {
            selector: selector("pg"),
            database: None,
            sql: sql.to_string(),
            session_id: None,
            max_rows: None,
            cell_char_offset: None,
            cell_char_limit: None,
        };
        let success = server.execute_query(Parameters(query("SELECT 1"))).await;
        let failure = server.execute_query(Parameters(query("SELECT 1 /* FAIL_MCP_TEST */"))).await;
        assert_ne!(success.is_error, Some(true));
        assert_eq!(failure.is_error, Some(true));

        let history = backend.history.lock().unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].connection_id, "pg");
        assert_eq!(history[0].connection_name, "Reporting");
        assert_eq!(history[0].database, "app");
        assert_eq!(history[0].sql, "SELECT 1");
        assert!(history[0].success);
        assert_eq!(history[0].details_json.as_deref(), Some(r#"{"source":"mcp"}"#));
        assert!(!history[1].success);
        assert!(history[1].error.as_deref().unwrap_or_default().contains("query failed"));
    }

    #[tokio::test]
    async fn mcp_batch_failure_is_recorded_once_without_claiming_success() {
        let postgres = connection("pg", "Reporting", "postgres", "app");
        let backend = Arc::new(FakeBackend { connections: vec![postgres], ..Default::default() });
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);
        let sql = "SELECT 1 /* FAIL_MCP_TEST */; SELECT 2";
        let result = server
            .execute_batch(Parameters(ExecuteBatchQueryRequest {
                selector: selector("pg"),
                cell_window: CellWindowArgs::default(),
                database: None,
                sql: sql.to_string(),
                session_id: None,
                continue_on_error: Some(true),
                use_transaction: None,
            }))
            .await;
        assert!(result_text(&result).contains("failed"));
        let history = backend.history.lock().unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].sql, sql);
        assert!(!history[0].success);
        assert!(history[0].error.as_deref().unwrap_or_default().contains("statement failed"));
    }

    #[tokio::test]
    async fn mcp_batch_error_without_message_is_still_recorded_as_failed() {
        let postgres = connection("pg", "Reporting", "postgres", "app");
        let backend = Arc::new(FakeBackend { connections: vec![postgres], ..Default::default() });
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);
        let result = server
            .execute_batch(Parameters(ExecuteBatchQueryRequest {
                selector: selector("pg"),
                cell_window: CellWindowArgs::default(),
                database: None,
                sql: "SELECT 1 /* FAIL_MCP_NO_MESSAGE_TEST */".to_string(),
                session_id: None,
                continue_on_error: None,
                use_transaction: None,
            }))
            .await;
        assert!(result_text(&result).contains("failed"));
        let history = backend.history.lock().unwrap();
        assert_eq!(history.len(), 1);
        assert!(!history[0].success);
        assert_eq!(history[0].error.as_deref(), Some("Statement 1 failed"));
    }

    #[tokio::test]
    async fn preflight_rejection_does_not_enter_execution_history() {
        let postgres = connection("pg", "Reporting", "postgres", "app");
        let backend = Arc::new(FakeBackend { connections: vec![postgres], ..Default::default() });
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);
        let result = server
            .execute_batch(Parameters(ExecuteBatchQueryRequest {
                selector: selector("pg"),
                cell_window: CellWindowArgs::default(),
                database: None,
                sql: " ".to_string(),
                session_id: None,
                continue_on_error: None,
                use_transaction: None,
            }))
            .await;
        assert_eq!(result.is_error, Some(true));
        assert!(backend.history.lock().unwrap().is_empty());
    }

    #[test]
    fn mcp_history_metadata_handles_comments_and_mixed_batches() {
        assert_eq!(mcp_sql_operation("-- context\nSELECT 1", DatabaseType::Postgres), "SELECT");
        assert_eq!(
            mcp_sql_activity_kind(
                "UPDATE accounts SET active = true; CREATE INDEX active_idx ON accounts(active)",
                DatabaseType::Postgres
            ),
            "schema_change"
        );
    }

    #[test]
    fn mcp_history_metadata_reads_salesforce_statements_as_one_unit() {
        let database_type = DatabaseType::Salesforce;
        assert_eq!(mcp_sql_activity_kind("SELECT Id FROM Account", database_type), "query");
        assert_eq!(mcp_sql_operation("SELECT Id FROM Account", database_type), "SELECT");

        let update = "DBX SALESFORCE DML\n{\"op\":\"update\",\"object\":\"Account\",\"id\":\"001x\",\"fields\":{\"Name\":\"Acme\"}}";
        assert_eq!(mcp_sql_activity_kind(update, database_type), "data_change");
        assert_eq!(mcp_sql_operation(update, database_type), "UPDATE");

        // An unscoped write fails closed to the high-risk tier, which the generic
        // tier-based path would file under "schema_change". It is still a record
        // mutation; only the driver's own parser can say which verb it was.
        let unscoped = "DBX SALESFORCE DML\n{\"op\":\"delete\",\"object\":\"Account\"}";
        assert_eq!(mcp_sql_activity_kind(unscoped, database_type), "data_change");
        assert_eq!(mcp_sql_operation(unscoped, database_type), "DML");

        // A field value that reads like another statement is data, not a second
        // statement: the label must not change because of what it contains.
        let literal =
            "DBX SALESFORCE DML\n{\"op\":\"insert\",\"object\":\"Lead\",\"fields\":{\"Description\":\"a; CREATE TABLE t (id int)\"}}";
        assert_eq!(mcp_sql_activity_kind(literal, database_type), "data_change");
        assert_eq!(mcp_sql_operation(literal, database_type), "INSERT");
    }

    #[tokio::test]
    async fn execute_batch_rejects_transaction_with_session() {
        let postgres = connection("pg", "pg", "postgres", "app");
        let backend = Arc::new(FakeBackend { connections: vec![postgres], ..Default::default() });
        let server = DbxMcpServer::with_runtime_options(backend, McpScope::default(), false);

        let opened = server
            .open_session(Parameters(OpenSessionRequest {
                selector: selector("pg"),
                database: None,
                enable_transactions: false,
            }))
            .await;
        let session_id = opened_session_id(&opened);

        let result = server
            .execute_batch(Parameters(ExecuteBatchQueryRequest {
                selector: selector("pg"),
                cell_window: CellWindowArgs::default(),
                database: None,
                sql: "SELECT 1; SELECT 2".to_string(),
                session_id: Some(session_id),
                continue_on_error: None,
                use_transaction: Some(true),
            }))
            .await;
        assert!(result_text(&result).contains("TRANSACTION_WITH_SESSION_UNSUPPORTED"));
    }

    #[tokio::test]
    async fn execute_batch_rejects_transaction_with_continue_on_error() {
        // The core transaction path rolls back and stops at the first failure
        // (query.rs:2970), so continue_on_error would be silently ignored.
        // Reject the combination instead of promising continuation that never
        // happens, and make sure neither option reaches the backend.
        let postgres = connection("pg", "pg", "postgres", "app");
        let backend = Arc::new(FakeBackend { connections: vec![postgres], ..Default::default() });
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);

        let result = server
            .execute_batch(Parameters(ExecuteBatchQueryRequest {
                selector: selector("pg"),
                cell_window: CellWindowArgs::default(),
                database: None,
                sql: "INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)".to_string(),
                session_id: None,
                continue_on_error: Some(true),
                use_transaction: Some(true),
            }))
            .await;
        assert!(result_text(&result).contains("TRANSACTION_WITH_CONTINUE_UNSUPPORTED"));
        assert!(backend.recorded_arguments.lock().unwrap().iter().all(|(name, _)| name != "execute_batch"));
    }

    #[tokio::test]
    async fn execute_batch_rejects_mysql_family_ddl_with_transaction() {
        // MySQL-family engines implicitly commit before DDL, so a DDL batch
        // with use_transaction cannot roll back a DDL that already committed.
        // Reject the combination instead of over-promising atomicity. Plain
        // DML batches and transactional DDL engines (PostgreSQL) still accept
        // use_transaction.
        let mysql = connection("my", "my", "mysql", "app");
        let backend = Arc::new(FakeBackend { connections: vec![mysql], ..Default::default() });
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);

        let ddl = server
            .execute_batch(Parameters(ExecuteBatchQueryRequest {
                selector: selector("my"),
                cell_window: CellWindowArgs::default(),
                database: None,
                sql: "CREATE TABLE a (id INT); INSERT INTO missing VALUES (1)".to_string(),
                session_id: None,
                continue_on_error: None,
                use_transaction: Some(true),
            }))
            .await;
        assert!(result_text(&ddl).contains("TRANSACTION_WITH_DDL_UNSUPPORTED"));
        assert!(backend.recorded_arguments.lock().unwrap().iter().all(|(name, _)| name != "execute_batch"));

        // GoldenDB is a MySQL-compatible Agent driver, so its DDL has the
        // same implicit-commit boundary and must not be advertised as atomic.
        let goldendb = connection("goldendb", "goldendb", "goldendb", "app");
        let goldendb_backend = Arc::new(FakeBackend { connections: vec![goldendb], ..Default::default() });
        let goldendb_server = DbxMcpServer::with_runtime_options(goldendb_backend.clone(), McpScope::default(), false);
        let goldendb_ddl = goldendb_server
            .execute_batch(Parameters(ExecuteBatchQueryRequest {
                selector: selector("goldendb"),
                cell_window: CellWindowArgs::default(),
                database: None,
                sql: "CREATE TABLE a (id INT); INSERT INTO missing VALUES (1)".to_string(),
                session_id: None,
                continue_on_error: None,
                use_transaction: Some(true),
            }))
            .await;
        assert!(result_text(&goldendb_ddl).contains("TRANSACTION_WITH_DDL_UNSUPPORTED"));
        assert!(goldendb_backend.recorded_arguments.lock().unwrap().iter().all(|(name, _)| name != "execute_batch"));

        let dml = server
            .execute_batch(Parameters(ExecuteBatchQueryRequest {
                selector: selector("my"),
                cell_window: CellWindowArgs::default(),
                database: None,
                sql: "INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)".to_string(),
                session_id: None,
                continue_on_error: None,
                use_transaction: Some(true),
            }))
            .await;
        assert!(result_text(&dml).contains("Transaction outcome"));
        assert!(backend.recorded_arguments.lock().unwrap().iter().any(|(name, _)| name == "execute_batch"));

        let postgres = connection("pg", "pg", "postgres", "app");
        let postgres_backend = Arc::new(FakeBackend {
            connections: vec![postgres],
            policy: McpGlobalPolicy { read_only: false, allow_dangerous_sql: true, ..Default::default() },
            ..Default::default()
        });
        let postgres_server = DbxMcpServer::with_runtime_options(postgres_backend.clone(), McpScope::default(), false);
        let pg_ddl = postgres_server
            .execute_batch(Parameters(ExecuteBatchQueryRequest {
                selector: selector("pg"),
                cell_window: CellWindowArgs::default(),
                database: None,
                sql: "CREATE TABLE a (id INT); INSERT INTO t VALUES (1)".to_string(),
                session_id: None,
                continue_on_error: None,
                use_transaction: Some(true),
            }))
            .await;
        assert!(result_text(&pg_ddl).contains("Transaction outcome"));
    }

    #[tokio::test]
    async fn execute_batch_rejects_oracle_ddl_with_transaction() {
        // Oracle DDL implicitly commits just like MySQL-family engines, so a DDL
        // batch with use_transaction over-promises atomicity. The rejection must
        // come from the shared capability check, not a MySQL-only engine list —
        // otherwise Oracle would silently run a non-rollbackable "transaction".
        let oracle = connection("ora", "ora", "oracle", "app");
        let backend = Arc::new(FakeBackend { connections: vec![oracle], ..Default::default() });
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);

        let ddl = server
            .execute_batch(Parameters(ExecuteBatchQueryRequest {
                selector: selector("ora"),
                cell_window: CellWindowArgs::default(),
                database: None,
                sql: "CREATE TABLE a (id NUMBER); INSERT INTO missing VALUES (1)".to_string(),
                session_id: None,
                continue_on_error: None,
                use_transaction: Some(true),
            }))
            .await;
        assert!(result_text(&ddl).contains("TRANSACTION_WITH_DDL_UNSUPPORTED"));
        assert!(backend.recorded_arguments.lock().unwrap().iter().all(|(name, _)| name != "execute_batch"));
    }

    #[tokio::test]
    async fn execute_batch_single_statement_allows_transaction_option_combinations() {
        // A single-statement script ignores use_transaction and runs as normal
        // auto-commit, so it never enters transaction mode. Combining it with
        // session_id or continue_on_error is therefore harmless and must not be
        // rejected — the option-validity rejects apply only when the script
        // actually enters transaction mode (statement_count > 1). Contrast with
        // execute_batch_rejects_transaction_with_session / _continue_on_error,
        // which use multi-statement scripts and are still rejected.
        let postgres = connection("pg", "pg", "postgres", "app");
        let backend = Arc::new(FakeBackend { connections: vec![postgres], ..Default::default() });
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);

        let with_continue = server
            .execute_batch(Parameters(ExecuteBatchQueryRequest {
                selector: selector("pg"),
                cell_window: CellWindowArgs::default(),
                database: None,
                sql: "INSERT INTO t VALUES (1)".to_string(),
                session_id: None,
                continue_on_error: Some(true),
                use_transaction: Some(true),
            }))
            .await;
        assert!(
            !result_text(&with_continue).contains("TRANSACTION_WITH_CONTINUE_UNSUPPORTED"),
            "single-statement use_transaction + continue_on_error must not be rejected"
        );
        assert!(backend.recorded_arguments.lock().unwrap().iter().any(|(name, _)| name == "execute_batch"));

        // A real session bound to the same connection must likewise reach
        // execution rather than be rejected as a transaction/session conflict.
        let opened = server
            .open_session(Parameters(OpenSessionRequest {
                selector: selector("pg"),
                database: None,
                enable_transactions: false,
            }))
            .await;
        let session_id = opened_session_id(&opened);
        let with_session = server
            .execute_batch(Parameters(ExecuteBatchQueryRequest {
                selector: selector("pg"),
                cell_window: CellWindowArgs::default(),
                database: None,
                sql: "INSERT INTO t VALUES (1)".to_string(),
                session_id: Some(session_id),
                continue_on_error: None,
                use_transaction: Some(true),
            }))
            .await;
        assert!(
            !result_text(&with_session).contains("TRANSACTION_WITH_SESSION_UNSUPPORTED"),
            "single-statement use_transaction + session_id must not be rejected as a transaction/session conflict"
        );
    }

    #[tokio::test]
    async fn execute_batch_returns_structured_content() {
        let postgres = connection("pg", "pg", "postgres", "app");
        let backend = Arc::new(FakeBackend { connections: vec![postgres], ..Default::default() });
        let server = DbxMcpServer::with_runtime_options(backend, McpScope::default(), false);

        let result = server
            .execute_batch(Parameters(ExecuteBatchQueryRequest {
                selector: selector("pg"),
                cell_window: CellWindowArgs::default(),
                database: None,
                sql: "SELECT 1; SELECT 2".to_string(),
                session_id: None,
                continue_on_error: None,
                use_transaction: None,
            }))
            .await;
        // The human-readable block stays in content…
        assert!(result_text(&result).contains("Statement 1"));
        // …and structuredContent is a protocol-valid object carrying one result per statement.
        let structured = result.structured_content.as_ref().expect("structured content must be populated");
        assert!(structured.is_object(), "MCP structuredContent must be a JSON object");
        let results = structured["results"].as_array().expect("results must be an array");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["statement_index"], 0);
    }

    #[tokio::test]
    async fn execute_batch_enforces_confirmed_write_sql_binding() {
        // `confirmed_batch_sql_block_reason` is exercised directly (not through
        // the handler with DBX_MCP_CONFIRMED_WRITE_SQL) because the env var is
        // process-global and would race with `confirmed_sql_binding_cannot_elevate_central_policy`.
        let postgres_db_type = dbx_core::models::connection::DatabaseType::Postgres;
        let confirmed = Some("INSERT INTO t VALUES (1)");

        // An exact match (modulo surrounding whitespace) passes.
        assert!(confirmed_batch_sql_block_reason("  INSERT INTO t VALUES (1)  ", postgres_db_type, confirmed).is_none());
        // A differing write script fails closed.
        let blocked = confirmed_batch_sql_block_reason(
            "INSERT INTO t VALUES (1); INSERT INTO u VALUES (2)",
            postgres_db_type,
            confirmed,
        )
        .expect("differing write script must be blocked");
        assert!(blocked.contains("does not match the user-confirmed SQL"));
        // A read-only script is never subject to the write confirmation.
        assert!(confirmed_batch_sql_block_reason("SELECT 1; SELECT 2", postgres_db_type, confirmed).is_none());
        // No binding never blocks.
        assert!(confirmed_batch_sql_block_reason("INSERT INTO t VALUES (1)", postgres_db_type, None).is_none());
        // Unparseable SQL fails closed (treated as a write).
        assert!(confirmed_batch_sql_block_reason("NOT VALID SQL ;;;", postgres_db_type, confirmed).is_some());
    }

    #[test]
    fn execute_query_routes_scripts_to_the_dialect_aware_batch_path() {
        assert!(sql_requires_batch_execution("SELECT 1; SELECT 2", DatabaseType::Postgres));
        assert!(sql_requires_batch_execution(
            "DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nDELIMITER ;",
            DatabaseType::Mysql
        ));
        assert!(!sql_requires_batch_execution("SELECT 1;", DatabaseType::Mysql));
        assert!(!sql_requires_batch_execution("SELECT 1", DatabaseType::Mysql));
    }

    #[test]
    fn solr_rest_requests_stay_on_the_single_request_path() {
        // Solr speaks the DBX REST-console format (`METHOD /path` + optional
        // JSON body), not SQL. A single request must not be routed through the
        // `;`-splitting batch executor.
        assert!(!sql_requires_batch_execution("GET /mycore/select?q=*:*&rows=20", DatabaseType::Solr));
        assert!(!sql_requires_batch_execution(
            "POST /mycore/update\n{\"add\":{\"doc\":{\"id\":\"1\",\"title\":\"x\"}}}",
            DatabaseType::Solr
        ));
        // A REST request is never a forbidden database switch.
        assert!(!mcp_sql_has_forbidden_database_switch("GET /mycore/select?q=*:*", DatabaseType::Solr));
    }

    #[test]
    fn format_batch_results_renders_failed_statement() {
        let results = vec![crate::backend::BatchStatementResult {
            result: dbx_core::db::QueryResult {
                columns: vec![],
                column_types: vec![],
                column_sortables: vec![],
                spatial_columns: vec![],
                spatial_values: vec![],
                rows: vec![],
                affected_rows: 0,
                execution_time_ms: 0,
                server_execute_time_us: None,
                query_timings_ms: None,
                truncated: false,
                session_id: None,
                has_more: false,
                elasticsearch_raw_body: None,
                messages: vec![],
            },
            execution_error: true,
            statement_index: Some(2),
            error_message: Some("syntax error near SELECT".to_string()),
            merged: false,
            transaction_state: None,
            transaction_outcome: None,
        }];
        let output = format_batch_results(&results, QueryCellWindow::default());
        assert!(output.contains("### Statement 3"));
        assert!(output.contains("**Status:** failed"));
        assert!(output.contains("syntax error near SELECT"));
    }

    #[test]
    fn format_batch_results_renders_transaction_outcome() {
        let results = vec![crate::backend::BatchStatementResult {
            result: dbx_core::db::QueryResult {
                columns: vec![],
                column_types: vec![],
                column_sortables: vec![],
                spatial_columns: vec![],
                spatial_values: vec![],
                rows: vec![],
                affected_rows: 2,
                execution_time_ms: 0,
                server_execute_time_us: None,
                query_timings_ms: None,
                truncated: false,
                session_id: None,
                has_more: false,
                elasticsearch_raw_body: None,
                messages: vec![],
            },
            execution_error: false,
            statement_index: None,
            error_message: None,
            merged: true,
            transaction_state: None,
            transaction_outcome: None,
        }];
        let output = format_batch_results(&results, QueryCellWindow::default());
        assert!(output.contains("### Transaction outcome"));
        assert!(output.contains("2 row(s) affected"));
        assert!(!output.contains("Statement 1"));
    }

    #[test]
    fn format_batch_results_honors_requested_cell_window() {
        let long_value = "A".repeat(500);
        let batch_result = |value: String| crate::backend::BatchStatementResult {
            result: dbx_core::db::QueryResult {
                columns: vec!["body".to_string()],
                column_types: vec![],
                column_sortables: vec![],
                spatial_columns: vec![],
                spatial_values: vec![],
                rows: vec![vec![serde_json::Value::String(value)]],
                affected_rows: 1,
                execution_time_ms: 0,
                server_execute_time_us: None,
                query_timings_ms: None,
                truncated: false,
                session_id: None,
                has_more: false,
                elasticsearch_raw_body: None,
                messages: vec![],
            },
            execution_error: false,
            statement_index: Some(0),
            error_message: None,
            merged: false,
            transaction_state: None,
            transaction_outcome: None,
        };

        let capped = format_batch_results(&[batch_result(long_value.clone())], QueryCellWindow::default());
        assert!(capped.contains(&format!("{}... [chars 0..200; next cell_char_offset=200]", "A".repeat(200))));

        let expanded = format_batch_results(
            &[batch_result(long_value.clone())],
            QueryCellWindow::from_options(Some(0), Some(4000)),
        );
        assert!(expanded.contains(&long_value), "batch cells should honor cell_char_limit: {expanded}");
        assert!(!expanded.contains("next cell_char_offset"), "a 500-character cell fits in the 4000-character window");
    }

    #[test]
    fn batch_request_deserializes_the_cell_window_arguments() {
        let request: ExecuteBatchQueryRequest = serde_json::from_value(serde_json::json!({
            "connection_name": "mysql",
            "sql": "SELECT body FROM t",
            "cell_char_offset": 0,
            "cell_char_limit": 4000,
        }))
        .expect("batch request should accept the cell window arguments");
        assert_eq!(request.cell_window.cell_char_offset, Some(0));
        assert_eq!(request.cell_window.cell_char_limit, Some(4000));
        assert_eq!(request.cell_window.to_query_window(), QueryCellWindow::from_options(Some(0), Some(4000)));

        let without_window: ExecuteBatchQueryRequest =
            serde_json::from_value(serde_json::json!({ "connection_name": "mysql", "sql": "SELECT body FROM t" }))
                .expect("batch request should keep the cell window optional");
        assert_eq!(without_window.cell_window.to_query_window(), QueryCellWindow::default());
    }

    #[tokio::test]
    async fn execute_batch_transaction_mode_marks_merged_outcome() {
        let postgres = connection("pg", "pg", "postgres", "app");
        let backend = Arc::new(FakeBackend { connections: vec![postgres], ..Default::default() });
        let server = DbxMcpServer::with_runtime_options(backend, McpScope::default(), false);

        let result = server
            .execute_batch(Parameters(ExecuteBatchQueryRequest {
                selector: selector("pg"),
                cell_window: CellWindowArgs::default(),
                database: None,
                sql: "INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)".to_string(),
                session_id: None,
                continue_on_error: None,
                use_transaction: Some(true),
            }))
            .await;
        // The merged transaction outcome is labelled distinctly and does not
        // pretend to be per-statement.
        assert!(result_text(&result).contains("Transaction outcome"));
        assert!(!result_text(&result).contains("Statement 1"));
        let structured = result.structured_content.as_ref().expect("structured content must be populated");
        assert_eq!(structured["results"][0]["merged"], true);
        assert!(structured["results"][0]["statement_index"].is_null());
    }

    #[tokio::test]
    async fn execute_batch_single_statement_with_transaction_is_not_merged() {
        // The core transaction wrapper only applies to scripts with more than
        // one statement (query.rs:2970). A single statement with
        // use_transaction=true runs as a normal auto-commit statement and must
        // not be labelled as a transaction outcome.
        let postgres = connection("pg", "pg", "postgres", "app");
        let backend = Arc::new(FakeBackend { connections: vec![postgres], ..Default::default() });
        let server = DbxMcpServer::with_runtime_options(backend, McpScope::default(), false);

        let result = server
            .execute_batch(Parameters(ExecuteBatchQueryRequest {
                selector: selector("pg"),
                cell_window: CellWindowArgs::default(),
                database: None,
                sql: "INSERT INTO t VALUES (1)".to_string(),
                session_id: None,
                continue_on_error: None,
                use_transaction: Some(true),
            }))
            .await;
        assert!(result_text(&result).contains("Statement 1"));
        assert!(!result_text(&result).contains("Transaction outcome"));
        let structured = result.structured_content.as_ref().expect("structured content must be populated");
        // merged=false is skipped by serde, so the single statement must not
        // carry a merged marker (null/absent), unlike the transaction outcome.
        assert!(structured["results"][0]["merged"].is_null());
    }

    #[tokio::test]
    async fn execute_batch_sqlserver_use_transaction_marks_merged_outcome() {
        // SQL Server enters the core transaction path before its normal batch
        // fast path, so a successful multi-statement request is merged.
        let sqlserver = connection("mssql", "mssql", "sqlserver", "app");
        let backend = Arc::new(FakeBackend { connections: vec![sqlserver], ..Default::default() });
        let server = DbxMcpServer::with_runtime_options(backend, McpScope::default(), false);

        let result = server
            .execute_batch(Parameters(ExecuteBatchQueryRequest {
                selector: selector("mssql"),
                cell_window: CellWindowArgs::default(),
                database: None,
                sql: "INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)".to_string(),
                session_id: None,
                continue_on_error: None,
                use_transaction: Some(true),
            }))
            .await;
        assert!(result_text(&result).contains("Transaction outcome"));
        assert!(!result_text(&result).contains("Statement 1"));
        let structured = result.structured_content.as_ref().expect("structured content must be populated");
        assert_eq!(structured["results"][0]["merged"], true);
    }

    fn salesforce_connection() -> ConnectionConfig {
        connection("sfdc", "Acme QA org", "salesforce", "")
    }

    fn salesforce_dml_policy(allow_dml: bool, read_only: bool) -> McpGlobalPolicy {
        McpGlobalPolicy {
            read_only: false,
            allow_dangerous_sql: false,
            connection_policies: vec![dbx_core::storage::McpConnectionPolicy {
                connection_id: "sfdc".to_string(),
                read_only,
                allow_dangerous_sql: false,
                execution_mode_configured: false,
                execution_mode_policy_version: None,
                database_scope: McpDatabaseScope::All,
                allowed_databases: Vec::new(),
                database_policies: Vec::new(),
                allow_salesforce_dml: allow_dml,
            }],
            ..Default::default()
        }
    }

    fn salesforce_identity(is_admin: Option<bool>) -> SalesforceCurrentUser {
        SalesforceCurrentUser {
            user_id: "005000000000000001".to_string(),
            name: "Jane Doe".to_string(),
            email: "jane.doe@example.test".to_string(),
            organization_id: "00D000000000000001".to_string(),
            username: "jane.doe@example.test".to_string(),
            profile_name: Some("System Administrator".to_string()),
            is_admin,
            org_name: "Acme".to_string(),
        }
    }

    fn salesforce_server(policy: McpGlobalPolicy, identity: Option<SalesforceCurrentUser>) -> Arc<FakeBackend> {
        Arc::new(FakeBackend {
            connections: vec![salesforce_connection()],
            policy,
            salesforce_identity: identity,
            ..Default::default()
        })
    }

    fn prepare_request(
        op: &str,
        object: &str,
        id: Option<&str>,
        fields: Option<serde_json::Value>,
    ) -> Parameters<SalesforcePrepareWriteRequest> {
        Parameters(SalesforcePrepareWriteRequest {
            selector: selector("sfdc"),
            database: None,
            op: op.to_string(),
            object: object.to_string(),
            id: id.map(str::to_string),
            fields,
        })
    }

    fn confirm_token(result: &CallToolResult) -> String {
        result.structured_content.as_ref().expect("prepare returns structured content")["confirm_token"]
            .as_str()
            .expect("confirm_token")
            .to_string()
    }

    #[test]
    fn salesforce_dml_builder_accepts_only_single_scoped_records() {
        let update =
            build_salesforce_dml_statement("UPDATE", " Account ", Some(" 001x "), Some(&json!({"Name": "Acme"})))
                .expect("a scoped update is the shape the driver executes");
        assert!(update.starts_with("DBX SALESFORCE DML\n"), "missing pseudo-command header: {update}");
        assert_eq!(
            classify_salesforce_statement_risk(&update),
            SalesforceStatementRisk::ScopedWrite,
            "a prepared write must never land in the read tier"
        );
        let parsed = parse_salesforce_statement(&update).expect("the driver must accept what prepare handed out");
        assert_eq!(parsed.op.as_str(), "update");
        assert_eq!(parsed.object, "Account");
        assert_eq!(parsed.id.as_deref(), Some("001x"));
        assert_eq!(parsed.fields.expect("fields")["Name"], json!("Acme"));
        assert_eq!(salesforce_write_label(&update), "update on Account (Id 001x)");

        let insert = build_salesforce_dml_statement("insert", "Lead", None, Some(&json!({"Company": "Acme"}))).unwrap();
        assert_eq!(salesforce_write_label(&insert), "insert on Lead");
        let delete = build_salesforce_dml_statement("delete", "Lead", Some("00Qx"), None).unwrap();
        assert_eq!(salesforce_write_label(&delete), "delete on Lead (Id 00Qx)");

        let rejected: Vec<(&str, Result<String, String>)> = vec![
            ("no object", build_salesforce_dml_statement("update", "  ", Some("001x"), Some(&json!({"Name": "a"})))),
            ("no fields on insert", build_salesforce_dml_statement("insert", "Lead", None, None)),
            ("empty fields", build_salesforce_dml_statement("insert", "Lead", None, Some(&json!({})))),
            ("fields not an object", build_salesforce_dml_statement("insert", "Lead", None, Some(&json!(["Name"])))),
            (
                "id on insert",
                build_salesforce_dml_statement("insert", "Lead", Some("00Qx"), Some(&json!({"Company": "a"}))),
            ),
            ("no id on update", build_salesforce_dml_statement("update", "Lead", None, Some(&json!({"Company": "a"})))),
            ("no id on delete", build_salesforce_dml_statement("delete", "Lead", None, None)),
            (
                "fields on delete",
                build_salesforce_dml_statement("delete", "Lead", Some("00Qx"), Some(&json!({"Company": "a"}))),
            ),
            (
                "Id inside fields",
                build_salesforce_dml_statement("update", "Lead", Some("00Qx"), Some(&json!({"id": "00Qy"}))),
            ),
            (
                "empty field name",
                build_salesforce_dml_statement("update", "Lead", Some("00Qx"), Some(&json!({" ": "x"}))),
            ),
            ("upsert", build_salesforce_dml_statement("upsert", "Lead", Some("00Qx"), Some(&json!({"Company": "a"})))),
            ("raw sql", build_salesforce_dml_statement("DELETE FROM Lead", "Lead", None, None)),
        ];
        for (label, result) in rejected {
            assert!(result.is_err(), "{label} must be refused, got {:?}", result.ok());
        }
    }

    #[tokio::test]
    async fn pending_salesforce_writes_are_single_use_and_expire() {
        let statement =
            build_salesforce_dml_statement("update", "Account", Some("001x"), Some(&json!({"Name": "Acme"}))).unwrap();
        let pending = || PendingSalesforceWrite {
            connection_id: "sfdc".to_string(),
            database: String::new(),
            statement: statement.clone(),
            created_at: Instant::now(),
        };

        let live = PendingSalesforceWrites::new(SALESFORCE_WRITE_CONFIRM_TTL);
        live.insert("sfdml-a".to_string(), pending()).await;
        assert!(live.take("sfdml-a").await.is_some(), "a fresh token must apply");
        assert!(live.take("sfdml-a").await.is_none(), "a token is single-use: a replay must not execute twice");
        assert!(live.take(" sfdml-missing ").await.is_none());

        let expired = PendingSalesforceWrites::new(Duration::ZERO);
        expired.insert("sfdml-b".to_string(), pending()).await;
        assert!(expired.take("sfdml-b").await.is_none(), "an expired token must not execute");
    }

    #[tokio::test]
    async fn pending_salesforce_writes_stay_bounded() {
        let store = PendingSalesforceWrites::new(SALESFORCE_WRITE_CONFIRM_TTL);
        for index in 0..(SALESFORCE_WRITE_PENDING_LIMIT + 10) {
            store
                .insert(
                    format!("sfdml-{index}"),
                    PendingSalesforceWrite {
                        connection_id: "sfdc".to_string(),
                        database: String::new(),
                        statement: "DBX SALESFORCE DML\n{}".to_string(),
                        created_at: Instant::now(),
                    },
                )
                .await;
        }
        assert_eq!(store.entries.lock().await.len(), SALESFORCE_WRITE_PENDING_LIMIT);
    }

    #[tokio::test]
    async fn salesforce_prepare_write_needs_an_explicit_connection_opt_in() {
        for (label, policy) in [
            ("no connection rule", McpGlobalPolicy::default()),
            ("opt-in off", salesforce_dml_policy(false, false)),
            ("opt-in void on read-only", salesforce_dml_policy(true, true)),
        ] {
            let backend = salesforce_server(policy, None);
            let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);
            let prepared = server
                .salesforce_prepare_write(prepare_request(
                    "update",
                    "Account",
                    Some("001x"),
                    Some(json!({"Name": "Acme"})),
                ))
                .await;
            assert!(result_text(&prepared).contains("SALESFORCE_DML_DISABLED"), "{label}: {prepared:?}");
            assert!(backend.recorded_arguments.lock().unwrap().is_empty(), "{label} must not reach the org");
        }
    }

    #[tokio::test]
    async fn salesforce_prepare_write_summarises_the_write_and_the_identity() {
        let backend = salesforce_server(salesforce_dml_policy(true, false), Some(salesforce_identity(Some(true))));
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);
        let prepared = server
            .salesforce_prepare_write(prepare_request(
                "update",
                "Account",
                Some("001x"),
                Some(json!({"Name": "Acme", "AnnualRevenue": 1200})),
            ))
            .await;
        let summary = result_text(&prepared);
        assert_ne!(prepared.is_error, Some(true), "{prepared:?}");
        for expected in [
            "nothing has been sent yet",
            "Operation:  update",
            "Object:     Account",
            "Record Id:  001x",
            "Name = \"Acme\"",
            "AnnualRevenue = 1200",
            "Jane Doe",
            "\"System Administrator\"",
            "Modify All Data",
            "cannot be rolled back",
            "dbx_salesforce_apply_write",
        ] {
            assert!(summary.contains(expected), "summary is missing \"{expected}\":\n{summary}");
        }
        assert!(confirm_token(&prepared).starts_with("sfdml-"));
        assert_eq!(
            prepared.structured_content.as_ref().unwrap()["statement"].as_str().unwrap(),
            build_salesforce_dml_statement(
                "update",
                "Account",
                Some("001x"),
                Some(&json!({"Name": "Acme", "AnnualRevenue": 1200}))
            )
            .unwrap()
        );
        assert!(backend.recorded_arguments.lock().unwrap().is_empty(), "prepare must not write");
    }

    #[tokio::test]
    async fn salesforce_prepare_write_survives_a_failed_identity_lookup() {
        let backend = salesforce_server(salesforce_dml_policy(true, false), None);
        let server = DbxMcpServer::with_runtime_options(backend, McpScope::default(), false);
        let prepared = server.salesforce_prepare_write(prepare_request("delete", "Lead", Some("00Qx"), None)).await;
        assert_ne!(prepared.is_error, Some(true), "{prepared:?}");
        assert!(result_text(&prepared).contains("identity lookup failed"), "{}", result_text(&prepared));
    }

    #[tokio::test]
    async fn salesforce_apply_write_sends_the_prepared_statement_exactly_once() {
        let backend = salesforce_server(salesforce_dml_policy(true, false), Some(salesforce_identity(Some(false))));
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);
        let prepared = server
            .salesforce_prepare_write(prepare_request("update", "Account", Some("001x"), Some(json!({"Name": "Acme"}))))
            .await;
        let token = confirm_token(&prepared);
        let statement = prepared.structured_content.as_ref().unwrap()["statement"].as_str().unwrap().to_string();

        let applied = server
            .salesforce_apply_write(Parameters(SalesforceApplyWriteRequest { confirm_token: token.clone() }))
            .await;
        assert_ne!(applied.is_error, Some(true), "{applied:?}");
        assert!(
            result_text(&applied).starts_with("Salesforce write applied: update on Account (Id 001x)."),
            "{}",
            result_text(&applied)
        );

        let recorded = backend.recorded_arguments.lock().unwrap().clone();
        assert_eq!(recorded.len(), 1, "exactly one write reached the backend: {recorded:?}");
        assert_eq!(recorded[0].0, "execute_query");
        assert_eq!(
            recorded[0].1["sql"].as_str(),
            Some(statement.as_str()),
            "the applied statement must be the prepared one"
        );
        assert_eq!(recorded[0].1["limit"], json!(1));

        let history = backend.history.lock().unwrap().clone();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].sql, statement);
        assert_eq!(history[0].operation, "UPDATE");
        assert_eq!(history[0].activity_kind, "data_change");
        assert!(history[0].success);

        let replayed =
            server.salesforce_apply_write(Parameters(SalesforceApplyWriteRequest { confirm_token: token })).await;
        assert!(result_text(&replayed).contains("CONFIRM_TOKEN_INVALID"), "{replayed:?}");
        assert_eq!(backend.recorded_arguments.lock().unwrap().len(), 1, "a replayed token must not write again");
    }

    #[tokio::test]
    async fn salesforce_apply_write_rejects_a_token_it_never_issued() {
        let backend = salesforce_server(salesforce_dml_policy(true, false), None);
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);
        let applied = server
            .salesforce_apply_write(Parameters(SalesforceApplyWriteRequest {
                confirm_token: "sfdml-forged".to_string(),
            }))
            .await;
        assert!(result_text(&applied).contains("CONFIRM_TOKEN_INVALID"), "{applied:?}");
        assert!(result_text(&applied).contains("dbx_salesforce_prepare_write"));
        assert!(backend.recorded_arguments.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn salesforce_prepare_write_honours_read_only_and_production_rules() {
        let read_only = McpGlobalPolicy { read_only: true, ..salesforce_dml_policy(true, false) };
        let backend = salesforce_server(read_only, None);
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);
        let prepared = server
            .salesforce_prepare_write(prepare_request("update", "Account", Some("001x"), Some(json!({"Name": "Acme"}))))
            .await;
        assert!(result_text(&prepared).contains("MCP_READ_ONLY"), "{prepared:?}");
        assert!(backend.recorded_arguments.lock().unwrap().is_empty());

        let mut production = salesforce_connection();
        production.is_production = true;
        let backend = Arc::new(FakeBackend {
            connections: vec![production],
            policy: salesforce_dml_policy(true, false),
            ..Default::default()
        });
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);
        let prepared = server
            .salesforce_prepare_write(prepare_request("update", "Account", Some("001x"), Some(json!({"Name": "Acme"}))))
            .await;
        assert!(result_text(&prepared).contains("PRODUCTION_WRITE_BLOCKED"), "{prepared:?}");
        assert!(backend.recorded_arguments.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn salesforce_write_pseudo_commands_cannot_sneak_through_execute_query() {
        let backend = Arc::new(FakeBackend {
            connections: vec![salesforce_connection()],
            policy: McpGlobalPolicy { read_only: false, allow_dangerous_sql: true, ..Default::default() },
            ..Default::default()
        });
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);
        let statement = build_salesforce_dml_statement("delete", "Account", Some("001x"), None).unwrap();
        let blocked = server
            .execute_query(Parameters(ExecuteQueryRequest {
                selector: selector("sfdc"),
                database: None,
                sql: statement,
                session_id: None,
                cell_char_offset: None,
                cell_char_limit: None,
                max_rows: None,
            }))
            .await;
        assert!(result_text(&blocked).contains("SALESFORCE_DML_REQUIRES_CONFIRMATION"), "{blocked:?}");
        assert!(backend.recorded_arguments.lock().unwrap().is_empty(), "the write must not reach the org");

        // SOQL stays readable even when a literal or a custom field name looks
        // like a write verb to a keyword scan.
        for soql in ["SELECT Id FROM Case WHERE Subject = 'Delete request'", "SELECT Id, Update__c FROM Lead LIMIT 5"] {
            let queried = server
                .execute_query(Parameters(ExecuteQueryRequest {
                    selector: selector("sfdc"),
                    database: None,
                    sql: soql.to_string(),
                    session_id: None,
                    cell_char_offset: None,
                    cell_char_limit: None,
                    max_rows: None,
                }))
                .await;
            assert_ne!(queried.is_error, Some(true), "{soql}: {queried:?}");
        }
        let recorded = backend.recorded_arguments.lock().unwrap().clone();
        assert_eq!(recorded.len(), 2, "{recorded:?}");
        assert_eq!(recorded[0].1["sql"], json!("SELECT Id FROM Case WHERE Subject = 'Delete request'"));
    }

    #[tokio::test]
    async fn salesforce_database_discovery_probe_is_not_read_as_a_write() {
        // `SHOW DATABASES` is not SOQL, so the Salesforce classifier calls it an
        // opaque write. Answering it with "writes need confirmation" would send an
        // agent looking for a schema into the DML flow; the discovery path already
        // has the right answer.
        let backend = salesforce_server(McpGlobalPolicy::default(), None);
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);
        for probe in ["SHOW DATABASES", " show schemas; "] {
            let probed = server
                .execute_query(Parameters(ExecuteQueryRequest {
                    selector: selector("sfdc"),
                    database: None,
                    sql: probe.to_string(),
                    session_id: None,
                    cell_char_offset: None,
                    cell_char_limit: None,
                    max_rows: None,
                }))
                .await;
            assert_ne!(probed.is_error, Some(true), "{probe}: {probed:?}");
            assert!(result_text(&probed).contains("Salesforce has no databases"), "{probe}: {probed:?}");
        }
        assert!(backend.recorded_arguments.lock().unwrap().is_empty(), "a discovery probe must not reach the org");

        // The exemption is exact-match, so a pseudo-command still cannot use it as
        // a way past the confirmation guard.
        let smuggled = server
            .execute_query(Parameters(ExecuteQueryRequest {
                selector: selector("sfdc"),
                database: None,
                sql: "show databases; DBX SALESFORCE DML\n{\"op\":\"delete\",\"object\":\"Account\",\"id\":\"001x\"}"
                    .to_string(),
                session_id: None,
                cell_char_offset: None,
                cell_char_limit: None,
                max_rows: None,
            }))
            .await;
        assert!(result_text(&smuggled).contains("SALESFORCE_DML_REQUIRES_CONFIRMATION"), "{smuggled:?}");
    }

    #[tokio::test]
    async fn salesforce_has_no_batch_and_no_session() {
        let backend = salesforce_server(McpGlobalPolicy::default(), None);
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);
        let batch = server
            .execute_batch(Parameters(ExecuteBatchQueryRequest {
                selector: selector("sfdc"),
                database: None,
                sql: "SELECT Id FROM Account".to_string(),
                session_id: None,
                continue_on_error: None,
                use_transaction: None,
                cell_window: CellWindowArgs::default(),
            }))
            .await;
        assert!(result_text(&batch).contains("DBX_BATCH_UNSUPPORTED"), "{batch:?}");
        let session = server
            .open_session(Parameters(OpenSessionRequest {
                selector: selector("sfdc"),
                database: None,
                enable_transactions: false,
            }))
            .await;
        assert!(result_text(&session).contains("SESSION_UNSUPPORTED"), "{session:?}");
        assert!(backend.recorded_arguments.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn salesforce_list_databases_points_at_objects_and_soql() {
        let backend = salesforce_server(McpGlobalPolicy::default(), None);
        let server = DbxMcpServer::with_runtime_options(backend, McpScope::default(), false);
        let listed = server.list_databases(Parameters(ListDatabasesRequest { selector: selector("sfdc") })).await;
        assert_ne!(listed.is_error, Some(true), "{listed:?}");
        let text = result_text(&listed);
        assert!(text.contains("Salesforce has no databases"), "{text}");
        assert!(text.contains("dbx_list_tables"), "{text}");
        assert!(text.contains("SELECT Id, Name FROM Account LIMIT 10"), "{text}");
    }

    #[tokio::test]
    async fn salesforce_current_user_names_the_profile_rights() {
        for (is_admin, expected) in [
            (Some(true), "bypasses field-level security"),
            (Some(false), "field-level security and record sharing apply"),
            (None, "could not be determined"),
        ] {
            let backend = salesforce_server(McpGlobalPolicy::default(), Some(salesforce_identity(is_admin)));
            let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);
            let identity = server
                .salesforce_current_user(Parameters(SalesforceIdentityRequest { selector: selector("sfdc") }))
                .await;
            assert_ne!(identity.is_error, Some(true), "{identity:?}");
            let text = result_text(&identity);
            assert!(text.contains("Jane Doe"), "{text}");
            assert!(text.contains(expected), "{text}");
            assert_eq!(identity.structured_content.as_ref().unwrap()["is_admin"], json!(is_admin));
            assert!(backend.recorded_arguments.lock().unwrap().is_empty(), "identity must not run a query");
        }
    }

    #[tokio::test]
    async fn salesforce_tools_refuse_other_database_types() {
        let backend = Arc::new(FakeBackend {
            connections: vec![connection("pg", "pg", "postgres", "app")],
            ..Default::default()
        });
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);
        let postgres_selector = || ConnectionSelector { connection_id: Some("pg".to_string()), connection_name: None };
        let identity = server
            .salesforce_current_user(Parameters(SalesforceIdentityRequest { selector: postgres_selector() }))
            .await;
        assert!(result_text(&identity).contains("NOT_SALESFORCE_CONNECTION"), "{identity:?}");
        let prepared = server
            .salesforce_prepare_write(Parameters(SalesforcePrepareWriteRequest {
                selector: postgres_selector(),
                database: None,
                op: "update".to_string(),
                object: "Account".to_string(),
                id: Some("001x".to_string()),
                fields: Some(json!({"Name": "Acme"})),
            }))
            .await;
        assert!(result_text(&prepared).contains("NOT_SALESFORCE_CONNECTION"), "{prepared:?}");
        assert!(backend.recorded_arguments.lock().unwrap().is_empty());
    }
}
