use std::sync::Arc;

use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerInfo},
    schemars, tool, tool_handler, tool_router, ServerHandler,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::backend::{format_query_result, new_connection_config, parse_database_type, ConnectionSummary, DbxBackend};
use crate::enterprise_tools::{
    build_milvus_filter, build_plan, cell_char_limit, column_type_hints, file_identity, milvus_delete_batch_query,
    milvus_search_query, milvus_upsert_query, preview_limit, query_result_rows, read_semantic_jsonl,
    revalidate_plan_file, sanitize_preview, structure_fingerprint, validate_embedding, validate_import_file,
    validate_mappings, validate_staging_target, validate_vector_collection, vector_output_fields, vector_top_k,
    vector_upsert_batch_size, EnterpriseRuntime, EnterpriseToolError, ImportStatusRequest, PrepareTableImportRequest,
    PreviewImportFileRequest, StartTableImportRequest, VectorDeleteByBatchRequest, VectorSearchRequest,
    VectorUpsertFileRequest, FORMAT_VERSION, STRUCTURE_PROFILE_ROWS,
};
use crate::mongo::{self, MongoCommand, MongoSafetyError};
use crate::session::{McpSession, McpSessionStore};
use dbx_core::{
    agent_tools::{format_query_result_as_text, QueryCellWindow},
    database_manifest,
    db::redis_driver::{classify_command, parse_command_argv, RedisCommandResult, RedisCommandSafety},
    models::connection::DatabaseType,
    production_safety::{
        is_production_database, mongo_pipeline_targets_production_database, sql_references_disallowed_database,
        targets_production_database,
    },
    query_execution_sql::is_write_sql_for_database,
    sql_risk::{
        classify_sql_risk_for_database, is_dangerous_sql_for_database, mcp_sql_has_forbidden_database_switch, SqlRisk,
    },
    storage::{McpDatabaseScope, McpGlobalPolicy},
};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListConnectionsRequest {}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListDatabasesRequest {
    #[serde(flatten)]
    pub selector: ConnectionSelector,
}

#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
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
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct OpenSessionRequest {
    #[serde(flatten)]
    pub selector: ConnectionSelector,
    #[schemars(description = "Database name")]
    #[schemars(extend("type" = "string"))]
    pub database: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct CloseSessionRequest {
    #[schemars(description = "Session ID returned by dbx_open_session")]
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
    #[schemars(description = "Redis logical database number")]
    #[schemars(extend("type" = "integer"))]
    pub db: Option<u32>,
    #[schemars(description = "Redis command to execute, for example GET mykey or INFO")]
    pub command: String,
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

#[derive(Clone)]
pub struct DbxMcpServer {
    backend: Arc<dyn DbxBackend>,
    scope: McpScope,
    sessions: Arc<McpSessionStore>,
    enterprise: Arc<EnterpriseRuntime>,
    web_mode: bool,
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
        tool_router.disable_route("dbx_send_message");
        Self {
            backend,
            scope,
            sessions: McpSessionStore::new(),
            enterprise: Arc::new(EnterpriseRuntime::default()),
            web_mode,
            tool_router,
        }
    }

    async fn close_backend_sessions_best_effort(&self, sessions: Vec<McpSession>) {
        for session in sessions {
            let _ = self
                .backend
                .close_client_session(&session.connection_id, &session.database, &session.client_session_id)
                .await;
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
                let group_paths = self.backend.load_connection_group_paths().await.unwrap_or_default();
                let rows = connections
                    .iter()
                    .map(|connection| {
                        let mut summary = ConnectionSummary::from(connection);
                        summary.group_path = group_paths.get(&connection.id).cloned().unwrap_or_default();
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
        name = "dbx_preview_import_file",
        description = "Preview an allowed local Excel/CSV/TSV/JSON file without writing data. Returns bounded rows, sheets, hashes, columns, row counts and a structure fingerprint. Local DBX Desktop/MCP mode only."
    )]
    async fn preview_import_file(&self, Parameters(request): Parameters<PreviewImportFileRequest>) -> CallToolResult {
        if self.web_mode {
            return enterprise_error(EnterpriseToolError::new(
                "IMPORT_UNSUPPORTED_IN_WEB_MODE_V1",
                "v1 文件导入仅支持本地 DBX Desktop/MCP 模式。",
            ));
        }
        let path = match validate_import_file(&request.file_path, false) {
            Ok(path) => path,
            Err(error) => return enterprise_error(error),
        };
        let identity = match file_identity(path.clone()).await {
            Ok(identity) => identity,
            Err(error) => return enterprise_error(error),
        };
        let parse_options = match request.parse_options.into_core() {
            Ok(options) => options,
            Err(error) => return enterprise_error(error),
        };
        let preview_rows = match preview_limit(request.preview_rows) {
            Ok(limit) => limit,
            Err(error) => return enterprise_error(error),
        };
        let char_limit = match cell_char_limit(request.cell_char_limit) {
            Ok(limit) => limit,
            Err(error) => return enterprise_error(error),
        };
        let preview = dbx_core::table_import::preview_table_import_file_with_request(
            dbx_core::table_import::TableImportPreviewRequest {
                file_path: path.to_string_lossy().to_string(),
                source_ref: Some(identity.sha256.clone()),
                source_format: request.source_format.map(Into::into),
                parse_options: parse_options.clone(),
                preview_limit: Some(STRUCTURE_PROFILE_ROWS),
            },
        )
        .await;
        let mut preview = match preview {
            Ok(preview) => sanitize_preview(preview, char_limit),
            Err(error) => {
                return enterprise_error(EnterpriseToolError::new("IMPORT_PREVIEW_FAILED", error));
            }
        };
        let fingerprint = structure_fingerprint(&preview, &parse_options);
        let type_hints = column_type_hints(&preview);
        preview.rows.truncate(preview_rows);
        let title_row = parse_options.title_row.or_else(|| parse_options.has_header.unwrap_or(true).then_some(1));
        let data_start_row = parse_options.data_start_row.unwrap_or_else(|| title_row.map_or(1, |row| row + 1));
        let last_row = data_start_row.saturating_add(preview.total_rows.saturating_sub(1));
        let summary = format!(
            "已只读剖析 {}：{} 列，{} 行，返回 {} 行预览。",
            preview.file_name,
            preview.columns.len(),
            preview.total_rows,
            preview.rows.len()
        );
        structured_success(
            summary,
            json!({
                "file": identity,
                "structureFingerprint": fingerprint,
                "columnTypeHints": type_hints,
                "usedRange": {
                    "firstRow": title_row.unwrap_or(data_start_row),
                    "lastRow": last_row,
                    "firstColumn": if preview.columns.is_empty() { 0 } else { 1 },
                    "lastColumn": preview.columns.len(),
                },
                "preview": preview,
            }),
        )
    }

    #[tool(
        name = "dbx_prepare_table_import",
        description = "Validate an approved-template mapping and immutable local source, then create a single-use import plan valid for 30 minutes. This tool never writes data."
    )]
    async fn prepare_table_import(&self, Parameters(request): Parameters<PrepareTableImportRequest>) -> CallToolResult {
        if self.web_mode {
            return enterprise_error(EnterpriseToolError::new(
                "IMPORT_UNSUPPORTED_IN_WEB_MODE_V1",
                "v1 文件导入仅支持本地 DBX Desktop/MCP 模式。",
            ));
        }
        if let Err(error) = validate_staging_target(&request.schema, &request.table) {
            return enterprise_error(error);
        }
        let resolved = match self.resolve_connection(&request.selector).await {
            Ok(resolved) => resolved,
            Err(error) => return error,
        };
        let database = match self.resolve_database(request.database.clone(), &resolved.connection) {
            Ok(database) => database,
            Err(error) => return error,
        };
        if resolved.connection.db_type != DatabaseType::Postgres {
            return enterprise_error(EnterpriseToolError::new(
                "IMPORT_REQUIRES_POSTGRES_V1",
                "v1 MCP 表导入只允许 PostgreSQL staging 连接。",
            ));
        }
        if let Err(error) = validate_safe_write_connection(&resolved.connection, &resolved.policy, &database) {
            return error;
        }
        let path = match validate_import_file(&request.file_path, false) {
            Ok(path) => path,
            Err(error) => return enterprise_error(error),
        };
        let identity = match file_identity(path.clone()).await {
            Ok(identity) => identity,
            Err(error) => return enterprise_error(error),
        };
        let parse_options = match request.parse_options.into_core() {
            Ok(options) => options,
            Err(error) => return enterprise_error(error),
        };
        let source_format = request.source_format.map(Into::into);
        let preview = dbx_core::table_import::preview_table_import_file_with_request(
            dbx_core::table_import::TableImportPreviewRequest {
                file_path: path.to_string_lossy().to_string(),
                source_ref: Some(identity.sha256.clone()),
                source_format,
                parse_options: parse_options.clone(),
                preview_limit: Some(STRUCTURE_PROFILE_ROWS),
            },
        )
        .await;
        let preview = match preview {
            Ok(preview) => preview,
            Err(error) => return enterprise_error(EnterpriseToolError::new("IMPORT_PREVIEW_FAILED", error)),
        };
        let mappings = request.mappings.into_iter().map(Into::into).collect::<Vec<_>>();
        if let Err(error) = validate_mappings(&mappings, &preview.columns) {
            return enterprise_error(error);
        }
        if !request.create_table {
            let columns = match self
                .backend
                .get_columns(&resolved.connection, &database, &request.schema, &request.table)
                .await
            {
                Ok(columns) => columns,
                Err(error) => return enterprise_error(EnterpriseToolError::new("IMPORT_TARGET_CHECK_FAILED", error)),
            };
            let target_columns =
                columns.iter().map(|column| column.name.as_str()).collect::<std::collections::HashSet<_>>();
            if let Some(missing) =
                mappings.iter().find(|mapping| !target_columns.contains(mapping.target_column.as_str()))
            {
                return enterprise_error(EnterpriseToolError::new(
                    "IMPORT_TARGET_COLUMN_NOT_FOUND",
                    format!("目标表缺少字段 {}。", missing.target_column),
                ));
            }
        }
        let batch_size = request.batch_size.unwrap_or(1_000);
        if !(1..=50_000).contains(&batch_size) {
            return enterprise_error(EnterpriseToolError::new(
                "IMPORT_BATCH_SIZE_INVALID",
                "batch_size 必须在 1 到 50000 之间。",
            ));
        }
        let fingerprint = structure_fingerprint(&preview, &parse_options);
        let plan = match build_plan(
            resolved.connection.id.clone(),
            resolved.connection.name.clone(),
            database,
            request.schema,
            request.table,
            request.template_version,
            identity,
            fingerprint,
            source_format,
            parse_options,
            mappings,
            request.create_table,
            batch_size,
            request.date_time_format,
        ) {
            Ok(plan) => plan,
            Err(error) => return enterprise_error(error),
        };
        self.enterprise.insert_plan(plan.clone()).await;
        structured_success(
            format!("导入计划 {} 已准备；绑定模板 {}，30 分钟内可启动一次。", plan.plan_id, plan.template_version),
            json!({ "plan": plan }),
        )
    }

    #[tool(
        name = "dbx_start_table_import",
        description = "Start a previously prepared single-use PostgreSQL staging import. The file, target, parsing options and mappings are revalidated and cannot be replaced."
    )]
    async fn start_table_import(&self, Parameters(request): Parameters<StartTableImportRequest>) -> CallToolResult {
        if self.web_mode {
            return enterprise_error(EnterpriseToolError::new(
                "IMPORT_UNSUPPORTED_IN_WEB_MODE_V1",
                "v1 文件导入仅支持本地 DBX Desktop/MCP 模式。",
            ));
        }
        let plan = match self.enterprise.consume_plan(request.plan_id.trim()).await {
            Ok(plan) => plan,
            Err(error) => return enterprise_error(error),
        };
        if let Err(error) = revalidate_plan_file(&plan).await {
            return enterprise_error(error);
        }
        let selector = ConnectionSelector { connection_id: Some(plan.connection_id.clone()), connection_name: None };
        let resolved = match self.resolve_connection(&selector).await {
            Ok(resolved) => resolved,
            Err(error) => return error,
        };
        if resolved.connection.db_type != DatabaseType::Postgres {
            return enterprise_error(EnterpriseToolError::new(
                "IMPORT_REQUIRES_POSTGRES_V1",
                "计划绑定的连接已不再是 PostgreSQL。",
            ));
        }
        if let Err(error) = validate_safe_write_connection(&resolved.connection, &resolved.policy, &plan.database) {
            return error;
        }
        let job = self.enterprise.create_job(&plan).await;
        let import_id = job.snapshot.lock().unwrap_or_else(|error| error.into_inner()).import_id.clone();
        let import_request = plan.to_import_request(import_id.clone());
        let backend = self.backend.clone();
        let connection = resolved.connection.clone();
        let task_job = job.clone();
        tokio::spawn(async move {
            let progress_job = task_job.clone();
            let progress = Arc::new(move |mut update: dbx_core::table_import::TableImportProgress| {
                if update.status == dbx_core::table_import::TableImportStatus::Done {
                    update.status = dbx_core::table_import::TableImportStatus::Running;
                    update.phase = dbx_core::table_import::TableImportPhase::Finalizing;
                }
                progress_job.snapshot.lock().unwrap_or_else(|error| error.into_inner()).apply_progress(update);
            });
            let result = backend
                .import_table_file_for_mcp(&connection, import_request, task_job.cancelled.clone(), progress)
                .await;
            let mut snapshot = task_job.snapshot.lock().unwrap_or_else(|error| error.into_inner());
            match result {
                Ok(summary) => {
                    snapshot.status = dbx_core::table_import::TableImportStatus::Done;
                    snapshot.phase = dbx_core::table_import::TableImportPhase::Done;
                    snapshot.rows_imported = summary.rows_imported;
                    snapshot.total_rows = summary.total_rows;
                    snapshot.elapsed_ms = summary.elapsed_ms;
                    snapshot.summary = Some(summary);
                    snapshot.error = None;
                }
                Err(error) => {
                    snapshot.status = if task_job.cancelled.load(std::sync::atomic::Ordering::Acquire) {
                        dbx_core::table_import::TableImportStatus::Cancelled
                    } else {
                        dbx_core::table_import::TableImportStatus::Error
                    };
                    snapshot.error = Some(error);
                }
            }
        });
        structured_success(
            format!("导入任务 {import_id} 已启动；只会写入隔离 staging。"),
            json!({ "importId": import_id, "planId": plan.plan_id, "status": "running" }),
        )
    }

    #[tool(
        name = "dbx_get_import_status",
        description = "Get machine-readable progress, row counts, bytes, elapsed time, errors and final summary for an MCP table import."
    )]
    async fn get_import_status(&self, Parameters(request): Parameters<ImportStatusRequest>) -> CallToolResult {
        if self.web_mode {
            return enterprise_error(EnterpriseToolError::new(
                "IMPORT_UNSUPPORTED_IN_WEB_MODE_V1",
                "v1 文件导入仅支持本地 DBX Desktop/MCP 模式。",
            ));
        }
        let Some(job) = self.enterprise.job(request.import_id.trim()).await else {
            return enterprise_error(EnterpriseToolError::new("IMPORT_JOB_NOT_FOUND", "没有找到指定导入任务。"));
        };
        let snapshot = job.snapshot.lock().unwrap_or_else(|error| error.into_inner()).clone();
        structured_success(
            format!("导入任务 {} 当前状态：{:?} / {:?}。", snapshot.import_id, snapshot.status, snapshot.phase),
            json!({ "job": snapshot }),
        )
    }

    #[tool(
        name = "dbx_cancel_import",
        description = "Request cancellation of an MCP staging import. Cancellation stops subsequent batches and never publishes staging data to core or mart."
    )]
    async fn cancel_import(&self, Parameters(request): Parameters<ImportStatusRequest>) -> CallToolResult {
        if self.web_mode {
            return enterprise_error(EnterpriseToolError::new(
                "IMPORT_UNSUPPORTED_IN_WEB_MODE_V1",
                "v1 文件导入仅支持本地 DBX Desktop/MCP 模式。",
            ));
        }
        let snapshot = match self.enterprise.cancel_job(request.import_id.trim()).await {
            Ok(snapshot) => snapshot,
            Err(error) => return enterprise_error(error),
        };
        structured_success(
            format!("已向导入任务 {} 发送取消请求。", snapshot.import_id),
            json!({ "importId": snapshot.import_id, "cancellationRequested": true, "lastStatus": snapshot.status }),
        )
    }

    #[tool(
        name = "dbx_vector_search",
        description = "Search an allowed Milvus semantic collection with a bounded vector and safe equality filters. Approval status and semantic version are always enforced."
    )]
    async fn vector_search(&self, Parameters(request): Parameters<VectorSearchRequest>) -> CallToolResult {
        let resolved = match self.resolve_connection(&request.selector).await {
            Ok(resolved) => resolved,
            Err(error) => return error,
        };
        if resolved.connection.db_type != DatabaseType::Milvus {
            return enterprise_error(EnterpriseToolError::new(
                "VECTOR_REQUIRES_MILVUS",
                "dbx_vector_search 只接受 Milvus 连接。",
            ));
        }
        if let Err(error) = validate_vector_collection(&request.collection) {
            return enterprise_error(error);
        }
        if let Err(error) = validate_embedding(&request.embedding) {
            return enterprise_error(error);
        }
        let top_k = match vector_top_k(request.top_k) {
            Ok(value) => value,
            Err(error) => return enterprise_error(error),
        };
        let output_fields = match vector_output_fields(request.output_fields) {
            Ok(fields) => fields,
            Err(error) => return enterprise_error(error),
        };
        let filter =
            match build_milvus_filter(&request.active_at, request.semantic_version.as_deref(), &request.filters) {
                Ok(filter) => filter,
                Err(error) => return enterprise_error(error),
            };
        let database = match self.resolve_database(request.database, &resolved.connection) {
            Ok(database) => database,
            Err(error) => return error,
        };
        let query =
            milvus_search_query(&database, &request.collection, &request.embedding, top_k, &filter, &output_fields);
        match self.backend.execute_query(&resolved.connection, &database, &query, Some(top_k), Some(30)).await {
            Ok(result) => {
                let rows = query_result_rows(result);
                structured_success(
                    format!("Milvus 语义检索返回 {} 条已批准结果。", rows.len()),
                    json!({
                        "collection": request.collection,
                        "activeAt": request.active_at,
                        "semanticVersion": request.semantic_version,
                        "topK": top_k,
                        "filter": filter,
                        "rows": rows,
                    }),
                )
            }
            Err(error) => enterprise_error(EnterpriseToolError::new("VECTOR_SEARCH_FAILED", error)),
        }
    }

    #[tool(
        name = "dbx_vector_upsert_file",
        description = "Upsert approved semantic cards from one allowed JSONL file into an allowed Milvus collection. Requires MCP safe-write permission."
    )]
    async fn vector_upsert_file(&self, Parameters(request): Parameters<VectorUpsertFileRequest>) -> CallToolResult {
        let resolved = match self.resolve_connection(&request.selector).await {
            Ok(resolved) => resolved,
            Err(error) => return error,
        };
        if resolved.connection.db_type != DatabaseType::Milvus {
            return enterprise_error(EnterpriseToolError::new(
                "VECTOR_REQUIRES_MILVUS",
                "dbx_vector_upsert_file 只接受 Milvus 连接。",
            ));
        }
        let database = match self.resolve_database(request.database, &resolved.connection) {
            Ok(database) => database,
            Err(error) => return error,
        };
        if let Err(error) = validate_safe_write_connection(&resolved.connection, &resolved.policy, &database) {
            return error;
        }
        if let Err(error) = validate_vector_collection(&request.collection) {
            return enterprise_error(error);
        }
        let path = match validate_import_file(&request.file_path, true) {
            Ok(path) => path,
            Err(error) => return enterprise_error(error),
        };
        let identity = match file_identity(path.clone()).await {
            Ok(identity) => identity,
            Err(error) => return enterprise_error(error),
        };
        let semantic_batch_id = request.semantic_batch_id.clone();
        let records = match tokio::task::spawn_blocking(move || read_semantic_jsonl(&path, &semantic_batch_id)).await {
            Ok(Ok(records)) => records,
            Ok(Err(error)) => return enterprise_error(error),
            Err(error) => {
                return enterprise_error(EnterpriseToolError::new("VECTOR_JSONL_READ_FAILED", error.to_string()))
            }
        };
        let current_identity = match file_identity(std::path::PathBuf::from(&identity.canonical_path)).await {
            Ok(identity) => identity,
            Err(error) => return enterprise_error(error),
        };
        if current_identity != identity {
            return enterprise_error(EnterpriseToolError::new(
                "VECTOR_JSONL_CHANGED",
                "语义 JSONL 在校验期间发生变化；未向 Milvus 写入。",
            ));
        }
        let batch_size = match vector_upsert_batch_size(request.batch_size) {
            Ok(batch_size) => batch_size,
            Err(error) => return enterprise_error(error),
        };
        let mut upserted = 0usize;
        for chunk in records.chunks(batch_size) {
            let query = milvus_upsert_query(&database, &request.collection, chunk);
            if let Err(error) =
                self.backend.execute_query(&resolved.connection, &database, &query, Some(1), Some(60)).await
            {
                return enterprise_error(EnterpriseToolError::new(
                    "VECTOR_UPSERT_FAILED",
                    format!("已提交 {upserted} 条后失败；语义版本尚未激活，可按 semantic_batch_id 撤销：{error}"),
                ));
            }
            upserted += chunk.len();
        }
        structured_success(
            format!("已向 Milvus upsert {upserted} 张 approved 语义卡。"),
            json!({
                "collection": request.collection,
                "semanticBatchId": request.semantic_batch_id,
                "upserted": upserted,
                "source": identity,
            }),
        )
    }

    #[tool(
        name = "dbx_vector_delete_by_batch",
        description = "Delete one unpublished Milvus semantic batch by exact semantic_batch_id. Requires high-risk MCP permission; arbitrary filter expressions are never accepted."
    )]
    async fn vector_delete_by_batch(
        &self,
        Parameters(request): Parameters<VectorDeleteByBatchRequest>,
    ) -> CallToolResult {
        let resolved = match self.resolve_connection(&request.selector).await {
            Ok(resolved) => resolved,
            Err(error) => return error,
        };
        if resolved.connection.db_type != DatabaseType::Milvus {
            return enterprise_error(EnterpriseToolError::new(
                "VECTOR_REQUIRES_MILVUS",
                "dbx_vector_delete_by_batch 只接受 Milvus 连接。",
            ));
        }
        let database = match self.resolve_database(request.database, &resolved.connection) {
            Ok(database) => database,
            Err(error) => return error,
        };
        if let Err(error) = validate_safe_write_connection(&resolved.connection, &resolved.policy, &database) {
            return error;
        }
        if !resolved.policy.allow_dangerous_sql {
            return enterprise_error(EnterpriseToolError::new(
                "VECTOR_HIGH_RISK_WRITE_BLOCKED",
                "按批删除语义向量需要开启 DBX MCP 高风险写入权限。",
            ));
        }
        if let Err(error) = validate_vector_collection(&request.collection) {
            return enterprise_error(error);
        }
        if request.semantic_batch_id.trim().is_empty() || request.semantic_batch_id.len() > 200 {
            return enterprise_error(EnterpriseToolError::new(
                "SEMANTIC_BATCH_ID_INVALID",
                "semantic_batch_id 必须是 1～200 个字符。",
            ));
        }
        let query = milvus_delete_batch_query(&database, &request.collection, &request.semantic_batch_id);
        match self.backend.execute_query(&resolved.connection, &database, &query, Some(1), Some(30)).await {
            Ok(_) => structured_success(
                format!("已删除未发布语义批次 {}。", request.semantic_batch_id),
                json!({
                    "collection": request.collection,
                    "semanticBatchId": request.semantic_batch_id,
                    "deleted": true,
                }),
            ),
            Err(error) => enterprise_error(EnterpriseToolError::new("VECTOR_DELETE_FAILED", error)),
        }
    }

    #[tool(
        name = "dbx_execute_query",
        description = "Execute a SQL query on a database connection (max 100 rows returned)"
    )]
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
                        )
                    }
                    None => {
                        return tool_error(
                            "SESSION_NOT_FOUND",
                            format!(
                                "Session \"{session_id}\" not found or expired. Open a new one with dbx_open_session."
                            ),
                        )
                    }
                }
            }
            None => None,
        };
        let database = match self.resolve_database(request.database, &resolved) {
            Ok(database) => database,
            Err(error) => return error,
        };
        let policy = effective_policy_for_database(&resolved.policy, connection, &database);
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
            let command = match validate_mongo_command(
                connection,
                &resolved.policy,
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
        let mut arguments = json!({ "sql": request.sql, "limit": 100 });
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
        let result =
            self.backend.execute_agent_tool(connection, &database, "execute_query", arguments, permissions).await;
        agent_result(result)
    }

    #[tool(
        name = "dbx_open_session",
        description = "Open a stateful query session pinned to a single backend connection. Returns a session ID for dbx_execute_query: USE, SET CATALOG, session variables and temporary tables persist across calls within the session. Close with dbx_close_session when done; idle sessions expire after 30 minutes."
    )]
    async fn open_session(&self, Parameters(request): Parameters<OpenSessionRequest>) -> CallToolResult {
        if let Err(error) = self.ensure_tool_allowed("dbx_open_session").await {
            return error;
        }
        let resolved = match self.resolve_connection(&request.selector).await {
            Ok(resolved) => resolved,
            Err(error) => return error,
        };
        let connection = &resolved.connection;
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
        let (session, expired) = self.sessions.open(&connection.id, &database).await.into_parts();
        self.close_backend_sessions_best_effort(expired).await;
        match session {
            Ok(session) => text(format!(
                "Session opened.\nsession_id: {}\nconnection: {} (id: {})\ndatabase: {}\n\nPass session_id to dbx_execute_query to run every query on the same pinned connection. Close with dbx_close_session when done.",
                session.id, connection.name, connection.id, database
            )),
            Err(error) => tool_error("SESSION_LIMIT", error),
        }
    }

    #[tool(
        name = "dbx_close_session",
        description = "Close a stateful query session and release its pinned backend connection"
    )]
    async fn close_session(&self, Parameters(request): Parameters<CloseSessionRequest>) -> CallToolResult {
        if let Err(error) = self.ensure_tool_allowed("dbx_close_session").await {
            return error;
        }
        let (session, expired) = self.sessions.begin_close(&request.session_id).await.into_parts();
        self.close_backend_sessions_best_effort(expired).await;
        let Some(session) = session else {
            return tool_error(
                "SESSION_NOT_FOUND",
                format!("Session \"{}\" not found or already closed.", request.session_id),
            );
        };
        match self
            .backend
            .close_client_session(&session.connection_id, &session.database, &session.client_session_id)
            .await
        {
            Ok(_) => {
                self.sessions.finish_close(&session.id).await;
                text(format!("Session \"{}\" closed.", session.id))
            }
            Err(error) => {
                self.sessions.restore_after_failed_close(session).await;
                backend_tool_error("SESSION_CLOSE_ERROR", error)
            }
        }
    }

    #[tool(name = "dbx_execute_redis_command", description = "Execute a Redis command on a Redis connection")]
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
        let safety = classify_command(&argv[0]);
        let policy = effective_policy_for_database(&resolved.policy, connection, &database.to_string());
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
            let policy = effective_policy_for_database(
                &resolved.policy,
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
        let allowed = connections
            .iter()
            .filter(|connection| policy_allows_connection(&policy, connection))
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
        if !policy_allows_connection(&policy, &target) {
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
        let policy = effective_policy_for_database(&resolved.policy, connection, &database);
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
            if let Err(error) =
                validate_mongo_command(connection, &resolved.policy, &resolved.database_scope, &database, &request.sql)
            {
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
}

impl DbxMcpServer {
    async fn list_databases_for_resolved(&self, resolved: &ResolvedConnection) -> CallToolResult {
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
        Ok(connections
            .into_iter()
            .filter(|connection| policy_allows_connection(&policy, connection))
            .filter(|connection| !self.scope.connection_scope_enabled() || self.scope.matches(connection))
            .collect())
    }

    async fn load_policy(&self) -> Result<McpGlobalPolicy, CallToolResult> {
        self.backend.load_mcp_global_policy().await.map_err(|error| backend_tool_error("MCP_POLICY_UNAVAILABLE", error))
    }

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

    async fn resolve_connection(&self, selector: &ConnectionSelector) -> Result<ResolvedConnection, CallToolResult> {
        let policy = self.load_policy().await?;
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
            if !policy_allows_connection(&policy, &connection) {
                return Err(tool_error(
                    "CONNECTION_OUT_OF_SCOPE",
                    format!("Connection \"{id}\" is not allowed by DBX MCP settings."),
                ));
            }
            return Ok(resolved_connection(policy, connection));
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
            if !policy_allows_connection(&policy, &connection) {
                return Err(tool_error(
                    "CONNECTION_OUT_OF_SCOPE",
                    "The DBX AI session scope is outside the global MCP connection allowlist.",
                ));
            }
            return Ok(resolved_connection(policy, connection));
        }
        let Some(name) = selector.connection_name.as_deref().map(str::trim).filter(|name| !name.is_empty()) else {
            return Err(tool_error("CONNECTION_NOT_FOUND", "Either connection_id or connection_name is required."));
        };
        let matching =
            connections.into_iter().filter(|connection| connection.name.eq_ignore_ascii_case(name)).collect::<Vec<_>>();
        let allowed = matching
            .iter()
            .filter(|connection| policy_allows_connection(&policy, connection))
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
            [connection] => Ok(resolved_connection(policy, connection.clone())),
            _ => Err(tool_error("AMBIGUOUS_CONNECTION", ambiguous_connections(name, &allowed))),
        }
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for DbxMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("dbx", env!("CARGO_PKG_VERSION")))
            .with_instructions("Use DBX connections to inspect schemas and query databases safely.")
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

fn text(value: impl Into<String>) -> CallToolResult {
    CallToolResult::success(vec![ContentBlock::text(value)])
}

fn structured_success(summary: impl Into<String>, data: serde_json::Value) -> CallToolResult {
    let summary = summary.into();
    let mut result = CallToolResult::structured(json!({
        "formatVersion": FORMAT_VERSION,
        "ok": true,
        "summary": summary,
        "data": data,
    }));
    result.content = vec![ContentBlock::text(summary)];
    result
}

fn enterprise_error(error: EnterpriseToolError) -> CallToolResult {
    let summary = format!("错误 [{}]：{}", error.code, error.message);
    let mut result = CallToolResult::structured_error(json!({
        "formatVersion": FORMAT_VERSION,
        "ok": false,
        "error": {
            "code": error.code,
            "message": error.message,
        },
    }));
    result.content = vec![ContentBlock::text(summary)];
    result
}

fn tool_error(code: &str, message: impl Into<String>) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(format!("Error [{code}]: {}", message.into()))])
}

// CallToolResult 是 MCP 原生错误载荷；保持不装箱可让所有工具直接返回一致错误。
#[allow(clippy::result_large_err)]
fn validate_safe_write_connection(
    connection: &dbx_core::models::connection::ConnectionConfig,
    policy: &McpGlobalPolicy,
    database: &str,
) -> Result<(), CallToolResult> {
    if policy.read_only {
        return Err(enterprise_error(EnterpriseToolError::new(
            "MCP_READ_ONLY",
            "DBX 全局 MCP 只读模式已开启，写入被阻断。",
        )));
    }
    if connection.read_only {
        return Err(enterprise_error(EnterpriseToolError::new(
            "CONNECTION_READ_ONLY",
            format!("连接 {} 已启用只读保护。", connection.name),
        )));
    }
    if is_production_database(connection, database) {
        return Err(enterprise_error(EnterpriseToolError::new(
            "PRODUCTION_WRITE_BLOCKED",
            "MCP 不允许对标记为生产的数据库执行文件或向量写入。",
        )));
    }
    Ok(())
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
    ] {
        let marker = format!("{code}:");
        if let Some(index) = error.find(&marker) {
            return tool_error(code, error[index + marker.len()..].trim());
        }
    }
    tool_error(default_code, error)
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
    connection: &dbx_core::models::connection::ConnectionConfig,
) -> bool {
    policy.allowed_connection_ids.as_ref().is_none_or(|allowed| allowed.iter().any(|id| id == &connection.id))
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
) -> ResolvedConnection {
    let database_scope = database_scope_for_connection(&policy, &connection);
    ResolvedConnection { connection, policy, database_scope }
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
fn effective_policy_for_database(
    policy: &McpGlobalPolicy,
    connection: &dbx_core::models::connection::ConnectionConfig,
    database: &str,
) -> McpGlobalPolicy {
    let mut policy = policy.clone();
    (policy.read_only, policy.allow_dangerous_sql) =
        dbx_core::mcp_policy::effective_database_execution_policy(&policy, &connection.id, database);
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
#[allow(clippy::result_large_err)]
fn validate_mongo_command(
    connection: &dbx_core::models::connection::ConnectionConfig,
    policy: &McpGlobalPolicy,
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
    if matches!(command, MongoCommand::RunCommand { .. }) {
        return Err(tool_error(
            "SQL_BLOCKED",
            "MongoDB runCommand is not available through MCP; review and execute it manually in DBX.",
        ));
    }
    if let MongoCommand::Aggregate { pipeline, .. } = &command {
        dbx_core::mcp_policy::ensure_mongo_database_execution_scope(policy, &connection.id, database, pipeline)
            .map_err(|error| {
                let (code, message) = error
                    .strip_prefix("QUERY_ERROR: ")
                    .map_or(("DATABASE_EXECUTION_POLICY_OUT_OF_SCOPE", error.as_str()), |message| {
                        ("QUERY_ERROR", message)
                    });
                tool_error(code, message)
            })?;
        for target_database in mongo_aggregate_target_databases(pipeline, database)? {
            ensure_database_in_scope(database_scope, &target_database)?;
        }
    }
    let effective_policy = effective_policy_for_database(policy, connection, database);
    let permissions = mcp_permissions(connection, &effective_policy);
    let production_database = match &command {
        MongoCommand::Aggregate { pipeline, .. } => {
            mongo_pipeline_targets_production_database(connection, database, pipeline)
        }
        _ => is_production_database(connection, database),
    };
    if let Err(error) =
        mongo::validate_safety(&command, permissions.allow_writes, permissions.allow_dangerous, production_database)
    {
        return Err(match error {
            MongoSafetyError::WritesDisabled => tool_error(
                if effective_policy.read_only { "MCP_READ_ONLY" } else { "CONNECTION_READ_ONLY" },
                "MCP MongoDB execution is read-only for this database in DBX MCP settings.",
            ),
            MongoSafetyError::EmptyFilter => tool_error(
                "SQL_BLOCKED",
                "MongoDB update/delete commands must include a non-empty filter unless high-risk operations are enabled in DBX MCP settings.",
            ),
            MongoSafetyError::Dangerous => tool_error(
                "SQL_BLOCKED",
                "Dangerous MongoDB command is disabled in DBX MCP settings.",
            ),
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
    use std::collections::HashSet;

    static IMPORT_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct FakeBackend {
        connections: Vec<ConnectionConfig>,
        policy: McpGlobalPolicy,
        recorded_arguments: std::sync::Mutex<Vec<(String, serde_json::Value)>>,
        closed_sessions: std::sync::Mutex<Vec<String>>,
        pinned_sessions: std::sync::Mutex<HashSet<String>>,
        close_failures_remaining: std::sync::Mutex<usize>,
    }

    impl Default for FakeBackend {
        fn default() -> Self {
            Self {
                connections: Vec::new(),
                policy: McpGlobalPolicy::default(),
                recorded_arguments: std::sync::Mutex::new(Vec::new()),
                closed_sessions: std::sync::Mutex::new(Vec::new()),
                pinned_sessions: std::sync::Mutex::new(HashSet::new()),
                close_failures_remaining: std::sync::Mutex::new(0),
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
        ResolvedConnection { connection, policy: McpGlobalPolicy::default(), database_scope: DatabaseScope::All }
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
        async fn load_mcp_global_policy(&self) -> Result<McpGlobalPolicy, String> {
            Ok(self.policy.clone())
        }

        async fn load_connections(&self) -> Result<Vec<ConnectionConfig>, String> {
            Ok(self.connections.clone())
        }

        async fn execute_agent_tool(
            &self,
            _connection: &ConnectionConfig,
            _database: &str,
            tool_name: &str,
            arguments: serde_json::Value,
            _permissions: dbx_core::agent_tools::AgentSqlPermissions,
        ) -> dbx_core::agent_events::ToolResult {
            if let Some(client_session_id) =
                arguments.get("client_session_id").and_then(serde_json::Value::as_str).filter(|id| !id.is_empty())
            {
                self.pinned_sessions.lock().unwrap().insert(client_session_id.to_string());
            }
            self.recorded_arguments.lock().unwrap().push((tool_name.to_string(), arguments));
            dbx_core::agent_events::ToolResult {
                tool_call_id: "test".to_string(),
                tool_name: tool_name.to_string(),
                content: "ok".to_string(),
                is_error: false,
                explain_data: None,
            }
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
        assert_eq!(tools.len(), 24);
        assert!(names.contains(&"dbx_list_connections"));
        assert!(names.contains(&"dbx_list_databases"));
        assert!(names.contains(&"dbx_list_tables"));
        assert!(names.contains(&"dbx_describe_table"));
        assert!(names.contains(&"dbx_list_routines"));
        assert!(names.contains(&"dbx_get_routine_source"));
        assert!(names.contains(&"dbx_execute_query"));
        assert!(names.contains(&"dbx_add_connection"));
        assert!(names.contains(&"dbx_duplicate_connection"));
        assert!(names.contains(&"dbx_remove_connection"));
        assert!(names.contains(&"dbx_execute_redis_command"));
        assert!(names.contains(&"dbx_get_schema_context"));
        assert!(names.contains(&"dbx_open_table"));
        assert!(names.contains(&"dbx_execute_and_show"));
        assert!(names.contains(&"dbx_open_session"));
        assert!(names.contains(&"dbx_close_session"));
        #[cfg(feature = "mq-admin")]
        assert!(names.contains(&"dbx_send_message"));
        assert!(names.contains(&"dbx_preview_import_file"));
        assert!(names.contains(&"dbx_prepare_table_import"));
        assert!(names.contains(&"dbx_start_table_import"));
        assert!(names.contains(&"dbx_get_import_status"));
        assert!(names.contains(&"dbx_cancel_import"));
        assert!(names.contains(&"dbx_vector_search"));
        assert!(names.contains(&"dbx_vector_upsert_file"));
        assert!(names.contains(&"dbx_vector_delete_by_batch"));
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

    #[tokio::test]
    async fn import_plan_rejects_source_changed_after_prepare() {
        let _environment_guard = IMPORT_ENV_LOCK.lock().unwrap();
        let previous_roots = std::env::var_os("DBX_MCP_IMPORT_ROOTS");
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("orders.csv");
        std::fs::write(&source, "order_id,amount\nA001,10.00\n").unwrap();
        std::env::set_var("DBX_MCP_IMPORT_ROOTS", directory.path());

        let postgres = connection("write-pg", "运营组数据写入", "postgres", "enterprise");
        let server = DbxMcpServer::with_runtime_options(
            Arc::new(FakeBackend { connections: vec![postgres], ..Default::default() }),
            McpScope::default(),
            false,
        );
        let preview = server
            .preview_import_file(Parameters(PreviewImportFileRequest {
                file_path: source.to_string_lossy().to_string(),
                source_format: None,
                parse_options: Default::default(),
                preview_rows: Some(5),
                cell_char_limit: Some(100),
            }))
            .await;
        assert_eq!(preview.is_error, Some(false));
        assert_eq!(preview.structured_content.as_ref().and_then(|value| value.get("formatVersion")), Some(&json!(1)));

        let prepared = server
            .prepare_table_import(Parameters(PrepareTableImportRequest {
                selector: ConnectionSelector { connection_id: Some("write-pg".to_string()), connection_name: None },
                database: Some("enterprise".to_string()),
                schema: "staging".to_string(),
                table: "orders_batch_1".to_string(),
                template_version: "orders-v1".to_string(),
                file_path: source.to_string_lossy().to_string(),
                source_format: None,
                parse_options: Default::default(),
                mappings: vec![
                    crate::enterprise_tools::McpImportColumnMapping {
                        source_column: "order_id".to_string(),
                        target_column: "order_id".to_string(),
                        target_data_type: Some("TEXT".to_string()),
                    },
                    crate::enterprise_tools::McpImportColumnMapping {
                        source_column: "amount".to_string(),
                        target_column: "amount".to_string(),
                        target_data_type: Some("NUMERIC(20,2)".to_string()),
                    },
                ],
                create_table: true,
                batch_size: Some(1_000),
                date_time_format: None,
            }))
            .await;
        assert_eq!(prepared.is_error, Some(false));
        let plan_id = prepared
            .structured_content
            .as_ref()
            .and_then(|value| value.pointer("/data/plan/planId"))
            .and_then(serde_json::Value::as_str)
            .unwrap()
            .to_string();

        std::fs::write(&source, "order_id,amount\nA001,10.00\nA002,20.00\n").unwrap();
        let started = server.start_table_import(Parameters(StartTableImportRequest { plan_id })).await;
        assert_eq!(started.is_error, Some(true));
        assert_eq!(
            started.structured_content.as_ref().and_then(|value| value.pointer("/error/code")),
            Some(&json!("IMPORT_FILE_CHANGED"))
        );

        match previous_roots {
            Some(value) => std::env::set_var("DBX_MCP_IMPORT_ROOTS", value),
            None => std::env::remove_var("DBX_MCP_IMPORT_ROOTS"),
        }
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

        for tool_name in [
            "dbx_execute_query",
            "dbx_list_tables",
            "dbx_open_session",
            "dbx_prepare_table_import",
            "dbx_vector_search",
            "dbx_vector_upsert_file",
            "dbx_vector_delete_by_batch",
        ] {
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
            ("dbx_execute_query", &["database", "session_id", "cell_char_offset", "cell_char_limit"]),
            ("dbx_open_session", &["database"]),
            ("dbx_open_table", &["database", "schema"]),
            ("dbx_execute_and_show", &["database"]),
            ("dbx_add_connection", &["port", "database", "driver_profile"]),
            ("dbx_remove_connection", &["connection_id", "connection_name"]),
            ("dbx_execute_redis_command", &["db"]),
            ("dbx_get_schema_context", &["database", "schema", "max_tables"]),
            ("dbx_preview_import_file", &["source_format", "preview_rows", "cell_char_limit"]),
            (
                "dbx_prepare_table_import",
                &["connection_id", "connection_name", "database", "source_format", "batch_size", "date_time_format"],
            ),
            (
                "dbx_vector_search",
                &["connection_id", "connection_name", "database", "semantic_version", "top_k", "output_fields"],
            ),
            ("dbx_vector_upsert_file", &["connection_id", "connection_name", "database", "batch_size"]),
            ("dbx_vector_delete_by_batch", &["connection_id", "connection_name", "database"]),
        ];
        #[cfg(feature = "mq-admin")]
        checks
            .push(("dbx_send_message", &["key", "payload_text", "partition", "exchange", "routing_key", "namespace"]));

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
        assert!(explicit_nulls.selector.connection_id.is_none());
        assert!(explicit_nulls.selector.connection_name.is_none());
        assert_eq!(by_name.selector.connection_name.as_deref(), Some("test_conn"));
        assert_eq!(by_id.selector.connection_id.as_deref(), Some("123e4567-e89b-12d3-a456-426614174000"));

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
        assert_eq!(names.len(), 19);
        assert!(!names.iter().any(|name| name == "dbx_add_connection"));
        assert!(!names.iter().any(|name| name == "dbx_duplicate_connection"));
        assert!(!names.iter().any(|name| name == "dbx_remove_connection"));
        assert!(!names.iter().any(|name| name == "dbx_open_table"));
        assert!(!names.iter().any(|name| name == "dbx_execute_and_show"));
        assert!(names.iter().any(|name| name == "dbx_list_routines"));
        assert!(names.iter().any(|name| name == "dbx_get_routine_source"));
        assert!(names.iter().any(|name| name == "dbx_open_session"));
        assert!(names.iter().any(|name| name == "dbx_close_session"));
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
        };
        let server = DbxMcpServer::with_runtime_options(Arc::new(FakeBackend::default()), McpScope::default(), false);
        assert_eq!(server.resolve_database(Some("reporting".to_string()), &selected).unwrap(), "reporting");
        let error = server.resolve_database(Some("production".to_string()), &selected).unwrap_err();
        assert!(result_text(&error).contains("DATABASE_OUT_OF_SCOPE"));

        let redis = ResolvedConnection {
            connection: connection("redis", "redis", "redis", "0"),
            policy: McpGlobalPolicy::default(),
            database_scope: DatabaseScope::Selected(vec!["2".to_string()]),
        };
        assert_eq!(server.resolve_redis_database(Some(2), &redis).unwrap(), 2);
        let error = server.resolve_redis_database(Some(3), &redis).unwrap_err();
        assert!(result_text(&error).contains("DATABASE_OUT_OF_SCOPE"));
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
    async fn session_queries_pin_client_session_and_close_releases_pool() {
        let starrocks = connection("sr", "sr", "starrocks", "default_catalog");
        let backend = Arc::new(FakeBackend { connections: vec![starrocks], ..Default::default() });
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);

        let opened =
            server.open_session(Parameters(OpenSessionRequest { selector: selector("sr"), database: None })).await;
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
            }))
            .await;

        assert_eq!(result_text(&result), "ok");
        let recorded = backend.recorded_arguments.lock().unwrap();
        let (_, arguments) = recorded.iter().find(|(name, _)| name == "execute_query").unwrap();
        assert_eq!(arguments["cell_char_offset"], 200);
        assert_eq!(arguments["cell_char_limit"], 800);
    }

    #[tokio::test]
    async fn expired_sessions_close_backend_pools_without_accumulating() {
        let starrocks = connection("sr", "sr", "starrocks", "default_catalog");
        let backend = Arc::new(FakeBackend { connections: vec![starrocks], ..Default::default() });
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);
        let mut expired_client_session_ids = Vec::new();

        for _ in 0..3 {
            let opened =
                server.open_session(Parameters(OpenSessionRequest { selector: selector("sr"), database: None })).await;
            let session_id = opened_session_id(&opened);
            let result = server
                .execute_query(Parameters(ExecuteQueryRequest {
                    selector: selector("sr"),
                    database: None,
                    sql: "SELECT 1".to_string(),
                    session_id: Some(session_id.clone()),
                    cell_char_offset: None,
                    cell_char_limit: None,
                }))
                .await;
            assert_eq!(result_text(&result), "ok");
            assert_eq!(backend.pinned_sessions.lock().unwrap().len(), 1);

            server.sessions.expire_for_test(&session_id).await;
            expired_client_session_ids.push(format!("mcp:{session_id}"));
        }

        let opened =
            server.open_session(Parameters(OpenSessionRequest { selector: selector("sr"), database: None })).await;
        let final_session_id = opened_session_id(&opened);
        assert!(backend.pinned_sessions.lock().unwrap().is_empty());
        assert_eq!(backend.closed_sessions.lock().unwrap().as_slice(), expired_client_session_ids.as_slice());

        let closed = server.close_session(Parameters(CloseSessionRequest { session_id: final_session_id })).await;
        assert!(result_text(&closed).contains("closed"));
    }

    #[tokio::test]
    async fn failed_session_close_can_be_retried() {
        let starrocks = connection("sr", "sr", "starrocks", "default_catalog");
        let backend = Arc::new(FakeBackend { connections: vec![starrocks], ..Default::default() });
        *backend.close_failures_remaining.lock().unwrap() = 1;
        let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);

        let opened =
            server.open_session(Parameters(OpenSessionRequest { selector: selector("sr"), database: None })).await;
        let session_id = opened_session_id(&opened);
        let query = server
            .execute_query(Parameters(ExecuteQueryRequest {
                selector: selector("sr"),
                database: None,
                sql: "SELECT 1".to_string(),
                session_id: Some(session_id.clone()),
                cell_char_offset: None,
                cell_char_limit: None,
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
        let rejected =
            server.open_session(Parameters(OpenSessionRequest { selector: selector("redis"), database: None })).await;
        assert!(result_text(&rejected).contains("SESSION_UNSUPPORTED"));

        let missing = server
            .execute_query(Parameters(ExecuteQueryRequest {
                selector: selector("pg"),
                database: None,
                sql: "SELECT 1".to_string(),
                session_id: Some("mcp-session-nope".to_string()),
                cell_char_offset: None,
                cell_char_limit: None,
            }))
            .await;
        assert!(result_text(&missing).contains("SESSION_NOT_FOUND"));
    }
}
