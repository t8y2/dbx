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
use dbx_core::{
    db::redis_driver::{classify_command, parse_command_argv, RedisCommandResult, RedisCommandSafety},
    models::connection::DatabaseType,
    production_safety::{is_production_database, targets_production_database},
    sql_risk::{classify_sql_risk_for_database, SqlRisk},
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
    tool_router: ToolRouter<Self>,
}

#[derive(Clone, Debug, Default)]
pub struct McpScope {
    pub connection_id: Option<String>,
    pub connection_name: Option<String>,
    pub database: Option<String>,
}

impl McpScope {
    pub fn from_env() -> Self {
        Self {
            connection_id: non_empty_env("DBX_MCP_SCOPE_CONNECTION_ID"),
            connection_name: non_empty_env("DBX_MCP_SCOPE_CONNECTION_NAME"),
            database: non_empty_env("DBX_MCP_SCOPE_DATABASE"),
        }
    }

    fn enabled(&self) -> bool {
        self.connection_id.is_some() || self.connection_name.is_some()
    }

    fn matches(&self, connection: &dbx_core::models::connection::ConnectionConfig) -> bool {
        self.connection_id.as_deref() == Some(connection.id.as_str())
            || self.connection_name.as_deref() == Some(connection.name.as_str())
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
        Self { backend, scope, tool_router }
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
            Err(error) => tool_error("CONNECTION_LOAD_ERROR", error),
        }
    }

    #[tool(name = "dbx_list_tables", description = "List tables and views for a database connection")]
    async fn list_tables(&self, Parameters(request): Parameters<ListTablesRequest>) -> CallToolResult {
        let connection = match self.resolve_connection(&request.selector).await {
            Ok(connection) => connection,
            Err(error) => return error,
        };
        let database = self.resolve_database(request.database, &connection);
        match self.backend.list_tables(&connection, &database, &request.schema.unwrap_or_default()).await {
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
        let connection = match self.resolve_connection(&request.selector).await {
            Ok(connection) => connection,
            Err(error) => return error,
        };
        let database = self.resolve_database(request.database, &connection);
        match self
            .backend
            .get_columns(&connection, &database, &request.schema.unwrap_or_default(), &request.table)
            .await
        {
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
        let connection = match self.resolve_connection(&request.selector).await {
            Ok(connection) => connection,
            Err(error) => return error,
        };
        if connection.db_type == dbx_core::models::connection::DatabaseType::Redis {
            return tool_error(
                "REDIS_COMMAND_REQUIRED",
                "Redis connections do not accept SQL through dbx_execute_query. Use dbx_execute_redis_command.",
            );
        }
        let database = self.resolve_database(request.database, &connection);
        if connection.db_type == DatabaseType::MongoDb {
            let command = match validate_mongo_command(&connection, &database, &request.sql) {
                Ok(command) => command,
                Err(error) => return error,
            };
            return match self.backend.execute_mongo_command(&connection, &database, &command).await {
                Ok(result) => text(format_query_result(&result, 100)),
                Err(error) => tool_error("QUERY_ERROR", error),
            };
        }
        let result = self
            .backend
            .execute_agent_tool(
                &connection,
                &database,
                "execute_query",
                json!({ "sql": request.sql, "limit": 100 }),
                default_permissions(),
            )
            .await;
        agent_result(result)
    }

    #[tool(name = "dbx_execute_redis_command", description = "Execute a Redis command on a Redis connection")]
    async fn execute_redis_command(
        &self,
        Parameters(request): Parameters<ExecuteRedisCommandRequest>,
    ) -> CallToolResult {
        let connection = match self.resolve_connection(&request.selector).await {
            Ok(connection) => connection,
            Err(error) => return error,
        };
        if connection.db_type != DatabaseType::Redis {
            return tool_error("INVALID_CONNECTION_TYPE", format!("Connection \"{}\" is not Redis.", connection.name));
        }
        let argv = match parse_command_argv(&request.command) {
            Ok(argv) => argv,
            Err(error) => return tool_error("REDIS_COMMAND_BLOCKED", error),
        };
        let safety = classify_command(&argv[0]);
        let permissions = default_permissions();
        if safety == RedisCommandSafety::Blocked && !permissions.allow_dangerous {
            return tool_error(
                "REDIS_COMMAND_BLOCKED",
                format!(
                    "Dangerous Redis command \"{}\" is blocked. Set DBX_MCP_ALLOW_DANGEROUS_SQL=1 to allow it.",
                    argv[0].to_ascii_uppercase()
                ),
            );
        }
        if safety != RedisCommandSafety::Allowed && !permissions.allow_writes {
            return tool_error(
                "REDIS_COMMAND_BLOCKED",
                "MCP Redis command execution is read-only for this session. Set DBX_MCP_ALLOW_WRITES=1 to allow write or dangerous commands.",
            );
        }
        let database = request
            .db
            .or_else(|| self.scope.database.as_deref().and_then(parse_redis_database))
            .or_else(|| redis_database(&connection))
            .unwrap_or(0);
        // Production protection is stricter than the opt-in write flags by design.
        if safety != RedisCommandSafety::Allowed && is_production_database(&connection, &database.to_string()) {
            return tool_error(
                "PRODUCTION_WRITE_BLOCKED",
                "MCP cannot execute write or dangerous Redis commands against a production database.",
            );
        }
        match self
            .backend
            .execute_redis_command(
                &connection,
                database,
                &request.command,
                safety == RedisCommandSafety::Blocked && permissions.allow_dangerous,
            )
            .await
        {
            Ok(result) => text(format_redis_result(&result)),
            Err(error) => tool_error("REDIS_COMMAND_ERROR", error),
        }
    }

    #[tool(name = "dbx_get_schema_context", description = "Get compact table and column context for writing SQL")]
    async fn get_schema_context(&self, Parameters(request): Parameters<SchemaContextRequest>) -> CallToolResult {
        let connection = match self.resolve_connection(&request.selector).await {
            Ok(connection) => connection,
            Err(error) => return error,
        };
        let database = self.resolve_database(request.database, &connection);
        let schema = request.schema.unwrap_or_default();
        let max_tables = request.max_tables.unwrap_or(8).clamp(1, 20);
        let available = match self.backend.list_tables(&connection, &database, &schema).await {
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
            let columns = match self.backend.get_columns(&connection, &database, &schema, &table.name).await {
                Ok(columns) => columns,
                Err(error) => return tool_error("SCHEMA_CONTEXT_ERROR", error),
            };
            tables.push((table.clone(), columns));
        }
        text(format_schema_context(&connection.name, &database, &schema, &tables, truncated))
    }

    #[tool(name = "dbx_add_connection", description = "Add a new database connection to DBX")]
    async fn add_connection(&self, Parameters(request): Parameters<AddConnectionRequest>) -> CallToolResult {
        let mut connections = match self.backend.load_connections().await {
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
        connections.push(config.clone());
        if let Err(error) = self.backend.save_connections(&connections).await {
            return tool_error("CONNECTION_SAVE_ERROR", error);
        }
        text(format!("Connection \"{}\" added (id: {}).", config.name, config.id))
    }

    #[tool(name = "dbx_remove_connection", description = "Remove a database connection from DBX")]
    async fn remove_connection(&self, Parameters(request): Parameters<RemoveConnectionRequest>) -> CallToolResult {
        let mut connections = match self.backend.load_connections().await {
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
        connections.retain(|connection| connection.id != target.id);
        if let Err(error) = self.backend.save_connections(&connections).await {
            return tool_error("CONNECTION_SAVE_ERROR", error);
        }
        text(format!("Connection \"{}\" (id: {}) removed.", target.name, target.id))
    }

    #[tool(name = "dbx_open_table", description = "Open a table in DBX desktop app. Requires DBX to be running.")]
    async fn open_table(&self, Parameters(request): Parameters<OpenTableRequest>) -> CallToolResult {
        let connection = match self.resolve_connection(&request.selector).await {
            Ok(connection) => connection,
            Err(error) => return error,
        };
        let database = self.resolve_database(request.database, &connection);
        match self
            .backend
            .bridge_request(
                "/open-table",
                json!({
                    "connection_id": connection.id,
                    "connection_name": connection.name,
                    "table": request.table,
                    "database": database,
                    "schema": request.schema,
                }),
            )
            .await
        {
            Ok(()) => text(format!("Opened {} in DBX", request.table)),
            Err(error) => tool_error("DBX_NOT_RUNNING", error),
        }
    }

    #[tool(
        name = "dbx_execute_and_show",
        description = "Execute a SQL query in DBX desktop app UI and show results there. Requires DBX to be running."
    )]
    async fn execute_and_show(&self, Parameters(request): Parameters<ExecuteAndShowRequest>) -> CallToolResult {
        let connection = match self.resolve_connection(&request.selector).await {
            Ok(connection) => connection,
            Err(error) => return error,
        };
        if connection.db_type == DatabaseType::Redis {
            return tool_error("REDIS_COMMAND_REQUIRED", "Use dbx_execute_redis_command for Redis connections.");
        }
        let database = self.resolve_database(request.database, &connection);
        let permissions = default_permissions();
        if connection.db_type == DatabaseType::MongoDb {
            if let Err(error) = validate_mongo_command(&connection, &database, &request.sql) {
                return error;
            }
        } else {
            let risk = match classify_sql_risk_for_database(&request.sql, connection.db_type) {
                Ok(risk) => risk,
                Err(error) => return tool_error("SQL_BLOCKED", error),
            };
            if risk != SqlRisk::ReadOnly && targets_production_database(&connection, &database, &request.sql) {
                return tool_error(
                    "PRODUCTION_WRITE_BLOCKED",
                    "MCP cannot send writes against a production database to DBX.",
                );
            }
            if risk == SqlRisk::Transaction || (risk == SqlRisk::Ddl && !permissions.allow_dangerous) {
                return tool_error("SQL_BLOCKED", format!("{} statement is blocked for this session.", risk));
            }
            if risk == SqlRisk::Write && !permissions.allow_writes {
                return tool_error("SQL_BLOCKED", "MCP SQL execution is read-only for this session.");
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
            Err(error) => tool_error("DBX_NOT_RUNNING", error),
        }
    }
}

impl DbxMcpServer {
    async fn load_scoped_connections(&self) -> Result<Vec<dbx_core::models::connection::ConnectionConfig>, String> {
        let connections = self.backend.load_connections().await?;
        if !self.scope.enabled() {
            return Ok(connections);
        }
        Ok(connections.into_iter().filter(|connection| self.scope.matches(connection)).collect())
    }

    fn resolve_database(
        &self,
        requested: Option<String>,
        connection: &dbx_core::models::connection::ConnectionConfig,
    ) -> String {
        requested.or_else(|| self.scope.database.clone()).or_else(|| connection.database.clone()).unwrap_or_default()
    }

    async fn resolve_connection(
        &self,
        selector: &ConnectionSelector,
    ) -> Result<dbx_core::models::connection::ConnectionConfig, CallToolResult> {
        let connections =
            self.backend.load_connections().await.map_err(|error| tool_error("CONNECTION_LOAD_ERROR", error))?;
        if let Some(id) = selector.connection_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
            let connection = connections
                .into_iter()
                .find(|connection| connection.id == id)
                .ok_or_else(|| tool_error("CONNECTION_NOT_FOUND", format!("Connection with id \"{id}\" not found.")))?;
            if self.scope.enabled() && !self.scope.matches(&connection) {
                return Err(tool_error(
                    "CONNECTION_OUT_OF_SCOPE",
                    format!("Connection \"{id}\" is outside this DBX AI session scope."),
                ));
            }
            return Ok(connection);
        }
        if self.scope.enabled() {
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
            return Ok(connection);
        }
        let Some(name) = selector.connection_name.as_deref().map(str::trim).filter(|name| !name.is_empty()) else {
            return Err(tool_error("CONNECTION_NOT_FOUND", "Either connection_id or connection_name is required."));
        };
        let matching =
            connections.into_iter().filter(|connection| connection.name.eq_ignore_ascii_case(name)).collect::<Vec<_>>();
        match matching.as_slice() {
            [] => Err(tool_error("CONNECTION_NOT_FOUND", format!("Connection \"{name}\" not found."))),
            [connection] => Ok(connection.clone()),
            _ => Err(tool_error("AMBIGUOUS_CONNECTION", ambiguous_connections(name, &matching))),
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

fn agent_result(result: dbx_core::agent_events::ToolResult) -> CallToolResult {
    if result.is_error {
        tool_error("DBX_TOOL_ERROR", result.content.trim_start_matches("Error: "))
    } else {
        text(result.content)
    }
}

fn default_permissions() -> dbx_core::agent_tools::AgentSqlPermissions {
    dbx_core::agent_tools::AgentSqlPermissions {
        allow_writes: boolean_env("DBX_MCP_ALLOW_WRITES").unwrap_or(true),
        allow_dangerous: boolean_env("DBX_MCP_ALLOW_DANGEROUS_SQL").unwrap_or(false),
    }
}

fn validate_mongo_command(
    connection: &dbx_core::models::connection::ConnectionConfig,
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
    let permissions = default_permissions();
    if let Err(error) = mongo::validate_safety(
        &command,
        permissions.allow_writes,
        permissions.allow_dangerous,
        is_production_database(connection, database),
    ) {
        return Err(match error {
            MongoSafetyError::WritesDisabled => tool_error(
                "SQL_BLOCKED",
                "MCP MongoDB execution is read-only for this session. Set DBX_MCP_ALLOW_WRITES=1 to allow write commands.",
            ),
            MongoSafetyError::EmptyFilter => tool_error(
                "SQL_BLOCKED",
                "MongoDB update/delete commands must include a non-empty filter unless DBX_MCP_ALLOW_DANGEROUS_SQL=1 is set.",
            ),
            MongoSafetyError::Dangerous => tool_error(
                "SQL_BLOCKED",
                "Dangerous MongoDB command is blocked. Set DBX_MCP_ALLOW_DANGEROUS_SQL=1 to allow it.",
            ),
            MongoSafetyError::ProductionWrite => {
                tool_error("PRODUCTION_WRITE_BLOCKED", "MCP cannot execute writes against a production database.")
            }
        });
    }
    Ok(command)
}

fn boolean_env(name: &str) -> Option<bool> {
    match std::env::var(name).ok()?.trim().to_ascii_lowercase().as_str() {
        "1" | "true" => Some(true),
        "0" | "false" => Some(false),
        _ => None,
    }
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
}

fn default_port(db_type: &str) -> Option<u16> {
    match db_type.trim().to_ascii_lowercase().as_str() {
        "mysql" | "doris" | "starrocks" | "manticoresearch" => Some(3306),
        "postgres" | "redshift" | "highgo" | "kingbase" | "opengauss" | "gaussdb" => Some(5432),
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

    struct FakeBackend {
        connections: Vec<ConnectionConfig>,
    }

    #[async_trait]
    impl DbxBackend for FakeBackend {
        async fn load_connections(&self) -> Result<Vec<ConnectionConfig>, String> {
            Ok(self.connections.clone())
        }

        async fn execute_agent_tool(
            &self,
            _connection: &ConnectionConfig,
            _database: &str,
            tool_name: &str,
            _arguments: serde_json::Value,
            _permissions: dbx_core::agent_tools::AgentSqlPermissions,
        ) -> dbx_core::agent_events::ToolResult {
            dbx_core::agent_events::ToolResult {
                tool_call_id: "test".to_string(),
                tool_name: tool_name.to_string(),
                content: "ok".to_string(),
                is_error: false,
                explain_data: None,
            }
        }

        async fn save_connections(&self, _connections: &[ConnectionConfig]) -> Result<(), String> {
            Ok(())
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
        let server = DbxMcpServer::with_runtime_options(
            Arc::new(FakeBackend { connections: Vec::new() }),
            McpScope::default(),
            false,
        );
        let tools = server.tool_router.list_all();
        let names = tools.iter().map(|tool| tool.name.as_ref()).collect::<Vec<_>>();
        assert_eq!(tools.len(), 10);
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
    }

    #[test]
    fn scoped_server_hides_mutating_and_desktop_tools() {
        let server = DbxMcpServer::with_runtime_options(
            Arc::new(FakeBackend { connections: Vec::new() }),
            McpScope { connection_id: Some("scoped".to_string()), ..Default::default() },
            false,
        );
        let names = server.tool_router.list_all().into_iter().map(|tool| tool.name).collect::<Vec<_>>();
        assert_eq!(names.len(), 6);
        assert!(!names.iter().any(|name| name == "dbx_add_connection"));
        assert!(!names.iter().any(|name| name == "dbx_remove_connection"));
        assert!(!names.iter().any(|name| name == "dbx_open_table"));
        assert!(!names.iter().any(|name| name == "dbx_execute_and_show"));
    }
}
