use std::sync::Arc;

use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerInfo},
    schemars, tool, tool_handler, tool_router, ServerHandler,
};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::backend::{format_query_result, new_connection_config, parse_database_type, ConnectionSummary, DbxBackend};
use crate::mongo::{self, MongoCommand, MongoSafetyError};
use crate::session::{McpSession, McpSessionStore};
use dbx_core::{
    agent_tools::{format_query_result_as_text, QueryCellWindow},
    db::redis_driver::{classify_command, parse_command_argv, RedisCommandResult, RedisCommandSafety},
    models::connection::DatabaseType,
    production_safety::{
        is_production_database, mongo_pipeline_targets_production_database, targets_production_database,
    },
    query_execution_sql::is_write_sql_for_database,
    sql_risk::{
        classify_sql_risk_for_database, is_dangerous_sql_for_database, mcp_sql_has_forbidden_database_switch, SqlRisk,
    },
    storage::McpGlobalPolicy,
};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListConnectionsRequest {}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ConnectionSelector {
    #[schemars(description = "Unique ID of the DBX connection")]
    pub connection_id: Option<String>,
    #[schemars(description = "Name of the DBX connection")]
    pub connection_name: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListTablesRequest {
    #[serde(flatten)]
    pub selector: ConnectionSelector,
    #[schemars(description = "Database name")]
    pub database: Option<String>,
    #[schemars(description = "Schema name")]
    pub schema: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct DescribeTableRequest {
    #[serde(flatten)]
    pub selector: ConnectionSelector,
    #[schemars(description = "Table name")]
    pub table: String,
    #[schemars(description = "Database name")]
    pub database: Option<String>,
    #[schemars(description = "Schema name")]
    pub schema: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ExecuteQueryRequest {
    #[serde(flatten)]
    pub selector: ConnectionSelector,
    #[schemars(description = "Database name")]
    pub database: Option<String>,
    #[schemars(description = "SQL query to execute")]
    pub sql: String,
    #[schemars(
        description = "Session ID from dbx_open_session. When set, the query runs on the session's pinned connection, preserving USE/SET and other session state across calls."
    )]
    pub session_id: Option<String>,
    #[schemars(
        description = "Start character offset for every string cell (default 0, max 1000000). Use the next offset reported by a truncated result to slide through a long value; narrow the query to the target row and column first."
    )]
    pub cell_char_offset: Option<u64>,
    #[schemars(
        description = "Maximum characters returned per string cell (default 200, max 4000). Increase only for an explicit long-value expansion."
    )]
    pub cell_char_limit: Option<u64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct OpenSessionRequest {
    #[serde(flatten)]
    pub selector: ConnectionSelector,
    #[schemars(description = "Database name")]
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
    pub port: Option<u16>,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    pub database: Option<String>,
    #[serde(default)]
    pub ssl: bool,
    pub driver_profile: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct RemoveConnectionRequest {
    pub connection_name: String,
    pub connection_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ExecuteRedisCommandRequest {
    #[serde(flatten)]
    pub selector: ConnectionSelector,
    #[schemars(description = "Redis logical database number")]
    pub db: Option<u32>,
    #[schemars(description = "Redis command to execute, for example GET mykey or INFO")]
    pub command: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SchemaContextRequest {
    #[serde(flatten)]
    pub selector: ConnectionSelector,
    pub database: Option<String>,
    pub schema: Option<String>,
    #[schemars(description = "Specific table names to include")]
    pub tables: Option<Vec<String>>,
    #[schemars(description = "Maximum number of tables to include, from 1 to 20")]
    pub max_tables: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct OpenTableRequest {
    #[serde(flatten)]
    pub selector: ConnectionSelector,
    pub table: String,
    pub database: Option<String>,
    pub schema: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ExecuteAndShowRequest {
    #[serde(flatten)]
    pub selector: ConnectionSelector,
    pub sql: String,
    pub database: Option<String>,
}

#[derive(Clone)]
pub struct DbxMcpServer {
    backend: Arc<dyn DbxBackend>,
    scope: McpScope,
    sessions: Arc<McpSessionStore>,
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
        let mut tool_router = Self::tool_router();
        if scope.enabled() {
            tool_router.disable_route("dbx_add_connection");
            tool_router.disable_route("dbx_remove_connection");
        }
        // Desktop UI bridge operations are intentionally unavailable remotely and in scoped AI sessions.
        if web_mode || scope.enabled() {
            tool_router.disable_route("dbx_open_table");
            tool_router.disable_route("dbx_execute_and_show");
        }
        Self { backend, scope, sessions: McpSessionStore::new(), tool_router }
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
        description = "List database connections configured in DBX. Returns connection IDs, names, database types, endpoints, and selected databases."
    )]
    async fn list_connections(
        &self,
        Parameters(ListConnectionsRequest {}): Parameters<ListConnectionsRequest>,
    ) -> CallToolResult {
        match self.load_scoped_connections().await {
            Ok(connections) if connections.is_empty() => text("No connections configured in DBX."),
            Ok(connections) => {
                let rows = connections.iter().map(ConnectionSummary::from).collect::<Vec<_>>();
                text(format_connections(&rows))
            }
            Err(error) => backend_tool_error("CONNECTION_LOAD_ERROR", error),
        }
    }

    #[tool(name = "dbx_list_tables", description = "List tables and views for a database connection")]
    async fn list_tables(&self, Parameters(request): Parameters<ListTablesRequest>) -> CallToolResult {
        let resolved = match self.resolve_connection(&request.selector).await {
            Ok(resolved) => resolved,
            Err(error) => return error,
        };
        let database = match self.resolve_database(request.database, &resolved.connection) {
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
        let resolved = match self.resolve_connection(&request.selector).await {
            Ok(resolved) => resolved,
            Err(error) => return error,
        };
        let database = match self.resolve_database(request.database, &resolved.connection) {
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

    #[tool(
        name = "dbx_execute_query",
        description = "Execute a SQL query on a database connection (max 100 rows returned)"
    )]
    async fn execute_query(&self, Parameters(request): Parameters<ExecuteQueryRequest>) -> CallToolResult {
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
        let database = match self.resolve_database(request.database, connection) {
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
        if connection.db_type == DatabaseType::MongoDb {
            let command = match validate_mongo_command(connection, &resolved.policy, &database, &request.sql) {
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
        let permissions =
            match validate_sql_policy(connection, &resolved.policy, &database, &request.sql, allow_database_switch) {
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
        let result =
            self.backend.execute_agent_tool(connection, &database, "execute_query", arguments, permissions).await;
        agent_result(result)
    }

    #[tool(
        name = "dbx_open_session",
        description = "Open a stateful query session pinned to a single backend connection. Returns a session ID for dbx_execute_query: USE, SET CATALOG, session variables and temporary tables persist across calls within the session. Close with dbx_close_session when done; idle sessions expire after 30 minutes."
    )]
    async fn open_session(&self, Parameters(request): Parameters<OpenSessionRequest>) -> CallToolResult {
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
        let database = match self.resolve_database(request.database, connection) {
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
        let resolved = match self.resolve_connection(&request.selector).await {
            Ok(resolved) => resolved,
            Err(error) => return error,
        };
        let connection = &resolved.connection;
        if connection.db_type != DatabaseType::Redis {
            return tool_error("INVALID_CONNECTION_TYPE", format!("Connection \"{}\" is not Redis.", connection.name));
        }
        let argv = match parse_command_argv(&request.command) {
            Ok(argv) => argv,
            Err(error) => return tool_error("REDIS_COMMAND_BLOCKED", error),
        };
        let safety = classify_command(&argv[0]);
        let permissions = mcp_permissions(connection, &resolved.policy);
        if safety != RedisCommandSafety::Allowed && resolved.policy.read_only {
            return tool_error("MCP_READ_ONLY", "DBX global MCP read-only mode is enabled. Redis command blocked.");
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
        let database = match self.resolve_redis_database(request.db, connection) {
            Ok(database) => database,
            Err(error) => return error,
        };
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

    #[tool(name = "dbx_get_schema_context", description = "Get compact table and column context for writing SQL")]
    async fn get_schema_context(&self, Parameters(request): Parameters<SchemaContextRequest>) -> CallToolResult {
        let resolved = match self.resolve_connection(&request.selector).await {
            Ok(resolved) => resolved,
            Err(error) => return error,
        };
        let connection = &resolved.connection;
        let database = match self.resolve_database(request.database, connection) {
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
        let port = match request.port.or_else(|| default_port(&request.db_type)) {
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

    #[tool(name = "dbx_remove_connection", description = "Remove a database connection from DBX")]
    async fn remove_connection(&self, Parameters(request): Parameters<RemoveConnectionRequest>) -> CallToolResult {
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
            let matching = connections
                .iter()
                .filter(|connection| connection.name.eq_ignore_ascii_case(&request.connection_name))
                .cloned()
                .collect::<Vec<_>>();
            if matching.len() > 1 {
                return tool_error("AMBIGUOUS_CONNECTION", ambiguous_connections(&request.connection_name, &matching));
            }
            matching.into_iter().next()
        };
        let Some(target) = target else {
            return tool_error(
                "CONNECTION_NOT_FOUND",
                format!("Connection \"{}\" not found.", request.connection_name),
            );
        };
        match self.backend.remove_connection_for_mcp(&target.id).await {
            Ok(true) => text(format!("Connection \"{}\" (id: {}) removed.", target.name, target.id)),
            Ok(false) => tool_error("CONNECTION_NOT_FOUND", format!("Connection \"{}\" not found.", target.name)),
            Err(error) => backend_tool_error("CONNECTION_SAVE_ERROR", error),
        }
    }

    #[tool(name = "dbx_open_table", description = "Open a table in DBX desktop app. Requires DBX to be running.")]
    async fn open_table(&self, Parameters(request): Parameters<OpenTableRequest>) -> CallToolResult {
        let resolved = match self.resolve_connection(&request.selector).await {
            Ok(resolved) => resolved,
            Err(error) => return error,
        };
        let connection = &resolved.connection;
        let database = match self.resolve_database(request.database, connection) {
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
        let resolved = match self.resolve_connection(&request.selector).await {
            Ok(resolved) => resolved,
            Err(error) => return error,
        };
        let connection = &resolved.connection;
        if connection.db_type == DatabaseType::Redis {
            return tool_error("REDIS_COMMAND_REQUIRED", "Use dbx_execute_redis_command for Redis connections.");
        }
        let database = match self.resolve_database(request.database, connection) {
            Ok(database) => database,
            Err(error) => return error,
        };
        let permissions = if connection.db_type == DatabaseType::MongoDb {
            mcp_permissions(connection, &resolved.policy)
        } else {
            match validate_sql_policy(connection, &resolved.policy, &database, &request.sql, false) {
                Ok(permissions) => permissions,
                Err(error) => return error,
            }
        };
        if connection.db_type == DatabaseType::MongoDb {
            if let Err(error) = validate_mongo_command(connection, &resolved.policy, &database, &request.sql) {
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

    // CallToolResult is the rmcp wire response type; keeping it unboxed avoids conversions at every tool boundary.
    #[allow(clippy::result_large_err)]
    fn resolve_database(
        &self,
        requested: Option<String>,
        connection: &dbx_core::models::connection::ConnectionConfig,
    ) -> Result<String, CallToolResult> {
        let requested = requested.map(|database| database.trim().to_string()).filter(|database| !database.is_empty());
        if let Some(scoped) = self.scope.database.as_deref() {
            if let Some(requested) = requested.as_deref() {
                if requested != scoped {
                    return Err(tool_error(
                        "DATABASE_OUT_OF_SCOPE",
                        format!("Database \"{requested}\" is outside the scoped database \"{scoped}\"."),
                    ));
                }
            }
            return Ok(scoped.to_string());
        }
        Ok(requested.or_else(|| connection.database.clone()).unwrap_or_default())
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
        connection: &dbx_core::models::connection::ConnectionConfig,
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
            return Ok(scoped_database);
        }
        Ok(requested.or_else(|| redis_database(connection)).unwrap_or(0))
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
            return Ok(ResolvedConnection { connection, policy });
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
            return Ok(ResolvedConnection { connection, policy });
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
            [connection] => Ok(ResolvedConnection { connection: connection.clone(), policy }),
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
}

fn text(value: impl Into<String>) -> CallToolResult {
    CallToolResult::success(vec![ContentBlock::text(value)])
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
    let is_write = is_write_sql_for_database(sql, connection.db_type);
    if policy.read_only && is_write {
        return Err(tool_error("MCP_READ_ONLY", "DBX global MCP read-only mode is enabled. SQL write blocked."));
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
    let permissions = mcp_permissions(connection, policy);
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
                if policy.read_only { "MCP_READ_ONLY" } else { "CONNECTION_READ_ONLY" },
                "MCP MongoDB execution is read-only in DBX MCP settings.",
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

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
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

fn default_port(db_type: &str) -> Option<u16> {
    match db_type.trim().to_ascii_lowercase().as_str() {
        "mysql" | "doris" | "starrocks" | "manticoresearch" => Some(3306),
        "postgres" | "redshift" | "highgo" | "kingbase" | "opengauss" | "gaussdb" => Some(5432),
        "uxdb" => Some(52025),
        "redis" => Some(6379),
        "mongodb" => Some(27017),
        "rqlite" => Some(4001),
        "kwdb" => Some(26257),
        "cloudflare-d1" => Some(443),
        "tdengine" => Some(6041),
        "iotdb" => Some(6667),
        "xugu" => Some(5138),
        "sqlite" | "duckdb" | "access" => Some(0),
        _ => None,
    }
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
    let mut output =
        String::from("| ID | Name | Type | Host | Port | Database |\n| --- | --- | --- | --- | --- | --- |");
    for connection in connections {
        output.push_str(&format!(
            "\n| {} | {} | {} | {} | {} | {} |",
            escape_cell(&connection.id),
            escape_cell(&connection.name),
            escape_cell(&connection.db_type),
            escape_cell(&connection.host),
            connection.port,
            escape_cell(&connection.database),
        ));
    }
    output
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

    struct FakeBackend {
        connections: Vec<ConnectionConfig>,
        recorded_arguments: std::sync::Mutex<Vec<(String, serde_json::Value)>>,
        closed_sessions: std::sync::Mutex<Vec<String>>,
        pinned_sessions: std::sync::Mutex<HashSet<String>>,
        close_failures_remaining: std::sync::Mutex<usize>,
    }

    impl Default for FakeBackend {
        fn default() -> Self {
            Self {
                connections: Vec::new(),
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
            Ok(McpGlobalPolicy::default())
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
        }]);
        assert!(output.contains("id\\|1"));
        assert!(output.contains("local pg"));
    }

    #[test]
    fn server_registers_list_connections_tool() {
        let server = DbxMcpServer::with_runtime_options(Arc::new(FakeBackend::default()), McpScope::default(), false);
        let tools = server.tool_router.list_all();
        let names = tools.iter().map(|tool| tool.name.as_ref()).collect::<Vec<_>>();
        assert_eq!(tools.len(), 12);
        assert!(names.contains(&"dbx_list_connections"));
        assert!(names.contains(&"dbx_list_tables"));
        assert!(names.contains(&"dbx_describe_table"));
        assert!(names.contains(&"dbx_execute_query"));
        assert!(names.contains(&"dbx_add_connection"));
        assert!(names.contains(&"dbx_remove_connection"));
        assert!(names.contains(&"dbx_execute_redis_command"));
        assert!(names.contains(&"dbx_get_schema_context"));
        assert!(names.contains(&"dbx_open_table"));
        assert!(names.contains(&"dbx_execute_and_show"));
        assert!(names.contains(&"dbx_open_session"));
        assert!(names.contains(&"dbx_close_session"));
    }

    #[test]
    fn scoped_server_hides_mutating_and_desktop_tools() {
        let server = DbxMcpServer::with_runtime_options(
            Arc::new(FakeBackend::default()),
            McpScope { connection_ids: vec!["scoped".to_string()], ..Default::default() },
            false,
        );
        let names = server.tool_router.list_all().into_iter().map(|tool| tool.name).collect::<Vec<_>>();
        assert_eq!(names.len(), 8);
        assert!(!names.iter().any(|name| name == "dbx_add_connection"));
        assert!(!names.iter().any(|name| name == "dbx_remove_connection"));
        assert!(!names.iter().any(|name| name == "dbx_open_table"));
        assert!(!names.iter().any(|name| name == "dbx_execute_and_show"));
        assert!(names.iter().any(|name| name == "dbx_open_session"));
        assert!(names.iter().any(|name| name == "dbx_close_session"));
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
        assert_eq!(server.resolve_database(None, &scoped).unwrap(), "analytics");
        assert_eq!(server.resolve_database(Some("analytics".to_string()), &scoped).unwrap(), "analytics");
        let error = server.resolve_database(Some("production".to_string()), &scoped).unwrap_err();
        assert!(result_text(&error).contains("DATABASE_OUT_OF_SCOPE"));

        let names = server.tool_router.list_all().into_iter().map(|tool| tool.name).collect::<Vec<_>>();
        assert!(!names.iter().any(|name| name == "dbx_add_connection"));
        assert!(!names.iter().any(|name| name == "dbx_execute_and_show"));
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

        assert_eq!(server.resolve_database(None, &dameng).unwrap(), "APPDB");
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
        assert_eq!(scoped.resolve_redis_database(None, &redis).unwrap(), 2);
        let error = scoped.resolve_redis_database(Some(3), &redis).unwrap_err();
        assert!(result_text(&error).contains("DATABASE_OUT_OF_SCOPE"));

        let invalid = DbxMcpServer::with_runtime_options(
            Arc::new(FakeBackend { connections: vec![redis.clone()], ..Default::default() }),
            McpScope { database: Some("analytics".to_string()), ..Default::default() },
            false,
        );
        let error = invalid.resolve_redis_database(None, &redis).unwrap_err();
        assert!(result_text(&error).contains("INVALID_DATABASE_SCOPE"));
    }

    #[test]
    fn local_mongo_aggregate_cannot_write_to_a_production_database() {
        let mut mongo = connection("mongo", "mongo", "mongodb", "staging");
        mongo.production_databases = vec!["production".to_string()];
        let policy = McpGlobalPolicy { read_only: false, allow_dangerous_sql: true, allowed_connection_ids: None };

        let error = validate_mongo_command(
            &mongo,
            &policy,
            "staging",
            r#"db.items.aggregate([{"$out":{"db":"production","coll":"archive"}}])"#,
        )
        .unwrap_err();
        assert!(result_text(&error).contains("PRODUCTION_WRITE_BLOCKED"));

        assert!(
            validate_mongo_command(&mongo, &policy, "staging", r#"db.items.aggregate([{"$out":"archive"}])"#,).is_ok()
        );
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
        let writable_policy =
            McpGlobalPolicy { read_only: false, allow_dangerous_sql: true, allowed_connection_ids: None };
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
        let safe_write = McpGlobalPolicy { read_only: false, allow_dangerous_sql: false, allowed_connection_ids: None };
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
        let full_access = McpGlobalPolicy { read_only: false, allow_dangerous_sql: true, allowed_connection_ids: None };
        let permissions =
            validate_sql_policy(&connection, &full_access, "app", "CREATE TABLE metrics (id INT)", false).unwrap();
        assert!(permissions.allow_writes);
        assert!(permissions.allow_dangerous);
        assert_eq!(permissions.confirmed_write_sql.as_deref(), Some("CREATE TABLE metrics (id INT)"));

        // A global read-only policy is still authoritative even for the exact
        // confirmed statement, while read queries remain available.
        let read_only_policy =
            McpGlobalPolicy { read_only: true, allow_dangerous_sql: false, allowed_connection_ids: None };
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
        let policy = McpGlobalPolicy { read_only: false, allow_dangerous_sql: false, allowed_connection_ids: None };

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
