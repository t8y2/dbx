use std::{collections::HashMap, path::Path, sync::Arc};

use async_trait::async_trait;
use dbx_core::{
    agent_events::{ToolCall, ToolResult},
    agent_tools::{self, AgentSqlPermissions},
    connection::AppState,
    db::{redis_driver::RedisCommandResult, ColumnInfo, TableInfo},
    models::connection::{ConnectionConfig, DatabaseType},
    storage::{McpGlobalPolicy, McpGlobalPolicyState, Storage},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::mongo::MongoCommand;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ConnectionSummary {
    pub id: String,
    pub name: String,
    pub db_type: String,
    pub host: String,
    pub port: u16,
    pub database: String,
}

impl From<&ConnectionConfig> for ConnectionSummary {
    fn from(config: &ConnectionConfig) -> Self {
        let db_type = serde_json::to_value(config.db_type)
            .ok()
            .and_then(|value| value.as_str().map(ToOwned::to_owned))
            .unwrap_or_else(|| format!("{:?}", config.db_type).to_ascii_lowercase());
        Self {
            id: config.id.clone(),
            name: config.name.clone(),
            db_type,
            host: config.host.clone(),
            port: config.port,
            database: config.database.clone().unwrap_or_default(),
        }
    }
}

fn legacy_mcp_allow_writes() -> Option<bool> {
    match std::env::var("DBX_MCP_ALLOW_WRITES").ok()?.trim().to_ascii_lowercase().as_str() {
        "1" | "true" => Some(true),
        "0" | "false" => Some(false),
        _ => None,
    }
}

fn effective_mcp_policy(state: McpGlobalPolicyState) -> McpGlobalPolicy {
    effective_mcp_policy_with_legacy_allow_writes(state, legacy_mcp_allow_writes())
}

fn effective_mcp_policy_with_legacy_allow_writes(
    state: McpGlobalPolicyState,
    legacy_allow_writes: Option<bool>,
) -> McpGlobalPolicy {
    let configured = state.configured;
    let mut policy = state.policy();
    if !configured && legacy_allow_writes == Some(false) {
        policy.read_only = true;
    }
    policy
}

#[async_trait]
pub trait DbxBackend: Send + Sync {
    async fn load_mcp_global_policy(&self) -> Result<McpGlobalPolicy, String>;

    async fn load_connections(&self) -> Result<Vec<ConnectionConfig>, String>;
    async fn execute_agent_tool(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        tool_name: &str,
        arguments: Value,
        permissions: AgentSqlPermissions,
    ) -> ToolResult;
    async fn execute_query(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        sql: &str,
        max_rows: Option<usize>,
        timeout_secs: Option<u64>,
    ) -> Result<dbx_core::db::QueryResult, String> {
        let _ = (connection, database, sql, max_rows, timeout_secs);
        Err("SQL queries are not supported by this backend.".to_string())
    }
    async fn add_connection_for_mcp(&self, config: ConnectionConfig) -> Result<ConnectionConfig, String>;
    async fn remove_connection_for_mcp(&self, connection_id: &str) -> Result<bool, String>;
    async fn list_tables(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        schema: &str,
    ) -> Result<Vec<TableInfo>, String> {
        let _ = (connection, database, schema);
        Err("Table metadata is not supported by this backend.".to_string())
    }
    async fn get_columns(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        schema: &str,
        table: &str,
    ) -> Result<Vec<ColumnInfo>, String> {
        let _ = (connection, database, schema, table);
        Err("Column metadata is not supported by this backend.".to_string())
    }
    async fn execute_redis_command(
        &self,
        connection: &ConnectionConfig,
        database: u32,
        command: &str,
        skip_safety_check: bool,
    ) -> Result<RedisCommandResult, String> {
        let _ = (connection, database, command, skip_safety_check);
        Err("Redis commands are not supported by this backend.".to_string())
    }
    async fn execute_mongo_command(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        command: &MongoCommand,
    ) -> Result<dbx_core::db::QueryResult, String> {
        let _ = (connection, database, command);
        Err("MongoDB shell commands are not supported by this backend.".to_string())
    }
    async fn bridge_request(&self, path: &str, body: Value) -> Result<(), String> {
        let _ = (path, body);
        Err("DBX is not running. Please start DBX first.".to_string())
    }
}

pub struct LocalBackend {
    state: Arc<AppState>,
    data_dir: std::path::PathBuf,
}

#[derive(Default)]
struct WebAuthState {
    session_cookie: Option<String>,
    checked: bool,
}

pub struct WebBackend {
    base_url: String,
    password: String,
    client: reqwest::Client,
    auth: Mutex<WebAuthState>,
}

impl WebBackend {
    pub fn new(base_url: String, password: String) -> Result<Self, String> {
        let base_url = base_url.trim().trim_end_matches('/').to_string();
        if base_url.is_empty() {
            return Err("DBX_WEB_URL cannot be empty.".to_string());
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self { base_url, password, client, auth: Mutex::new(WebAuthState::default()) })
    }

    async fn ensure_auth(&self) -> Result<(), String> {
        let mut auth = self.auth.lock().await;
        if auth.session_cookie.is_some() || auth.checked {
            return Ok(());
        }
        #[derive(Deserialize)]
        struct AuthCheck {
            authenticated: bool,
            required: bool,
            setup_required: bool,
        }
        let response = self
            .client
            .get(format!("{}/api/auth/check", self.base_url))
            .send()
            .await
            .map_err(|error| format!("Authentication check failed: {error}"))?;
        if !response.status().is_success() {
            return Err(format!("Authentication check failed: {}", response.status()));
        }
        let check: AuthCheck = response.json().await.map_err(|error| format!("Invalid auth response: {error}"))?;
        if check.setup_required {
            return Err("DBX Web password setup is required before MCP Web mode can access APIs.".to_string());
        }
        if !check.required || check.authenticated {
            auth.checked = true;
            return Ok(());
        }
        if self.password.is_empty() {
            return Err("DBX Web authentication is required. Set DBX_WEB_PASSWORD for MCP Web mode.".to_string());
        }
        let response = self
            .client
            .post(format!("{}/api/auth/login", self.base_url))
            .json(&json!({ "password": self.password }))
            .send()
            .await
            .map_err(|error| format!("Authentication failed: {error}"))?;
        if !response.status().is_success() {
            return Err(format!("Authentication failed: {}", response.status()));
        }
        let cookie = response
            .headers()
            .get(reqwest::header::SET_COOKIE)
            .and_then(|value| value.to_str().ok())
            .and_then(extract_session_cookie)
            .ok_or_else(|| "Authentication failed: DBX Web did not return a session cookie.".to_string())?;
        auth.session_cookie = Some(cookie);
        auth.checked = true;
        Ok(())
    }

    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<reqwest::Response, String> {
        self.ensure_auth().await?;
        let mut retried = false;
        loop {
            let cookie = self.auth.lock().await.session_cookie.clone();
            let mut request = self
                .client
                .request(method.clone(), format!("{}{}", self.base_url, path))
                .header("x-dbx-mcp-request", "1");
            if let Some(cookie) = cookie {
                request = request.header(reqwest::header::COOKIE, format!("dbx_session={cookie}"));
            }
            if let Some(body) = body.as_ref() {
                request = request.json(body);
            }
            let response = request.send().await.map_err(|error| format!("API request {path} failed: {error}"))?;
            if response.status() == reqwest::StatusCode::UNAUTHORIZED && !retried && !self.password.is_empty() {
                *self.auth.lock().await = WebAuthState::default();
                self.ensure_auth().await?;
                retried = true;
                continue;
            }
            if response.status().is_success() {
                return Ok(response);
            }
            let status = response.status();
            let details = response.text().await.unwrap_or_default();
            return Err(format!("API request {path} failed: {status} {details}"));
        }
    }

    async fn ensure_connected(&self, connection: &ConnectionConfig) -> Result<(), String> {
        self.request(reqwest::Method::POST, "/api/connection/connect", Some(json!({ "config": connection }))).await?;
        Ok(())
    }
}

impl LocalBackend {
    pub async fn open(path: &Path) -> Result<Self, String> {
        let storage = Storage::open(path).await?;
        let configs = storage.load_connections().await?;
        let state = Arc::new(AppState::new(storage));
        let config_map: HashMap<String, ConnectionConfig> =
            configs.into_iter().map(|config| (config.id.clone(), config)).collect();
        *state.configs.write().await = config_map;
        let data_dir = path.parent().unwrap_or_else(|| Path::new(".")).to_path_buf();
        Ok(Self { state, data_dir })
    }

    pub fn state(&self) -> &Arc<AppState> {
        &self.state
    }
}

#[async_trait]
impl DbxBackend for LocalBackend {
    async fn load_mcp_global_policy(&self) -> Result<McpGlobalPolicy, String> {
        self.state.storage.load_mcp_global_policy().await.map(effective_mcp_policy)
    }

    async fn load_connections(&self) -> Result<Vec<ConnectionConfig>, String> {
        self.state.storage.load_connections().await
    }

    async fn execute_agent_tool(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        tool_name: &str,
        arguments: Value,
        permissions: AgentSqlPermissions,
    ) -> ToolResult {
        let call = ToolCall { id: format!("mcp-{tool_name}"), name: tool_name.to_string(), arguments };
        agent_tools::execute_tool(&call, &self.state, &connection.id, database, &connection.db_type, permissions).await
    }

    async fn execute_query(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        sql: &str,
        max_rows: Option<usize>,
        timeout_secs: Option<u64>,
    ) -> Result<dbx_core::db::QueryResult, String> {
        dbx_core::query::execute_sql_statement_with_options(
            &self.state,
            &connection.id,
            database,
            sql,
            None,
            None,
            dbx_core::query::QueryExecutionOptions { max_rows, timeout_secs, ..Default::default() },
        )
        .await
    }

    async fn add_connection_for_mcp(&self, config: ConnectionConfig) -> Result<ConnectionConfig, String> {
        let config = self.state.storage.add_connection_for_mcp(config).await?;
        self.state.configs.write().await.insert(config.id.clone(), config.clone());
        Ok(config)
    }

    async fn remove_connection_for_mcp(&self, connection_id: &str) -> Result<bool, String> {
        let removed = self.state.storage.remove_connection_for_mcp(connection_id).await?;
        if removed {
            self.state.configs.write().await.remove(connection_id);
        }
        Ok(removed)
    }

    async fn list_tables(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        schema: &str,
    ) -> Result<Vec<TableInfo>, String> {
        dbx_core::schema::list_tables_core(&self.state, &connection.id, database, schema, None, None, None, None).await
    }

    async fn get_columns(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        schema: &str,
        table: &str,
    ) -> Result<Vec<ColumnInfo>, String> {
        dbx_core::schema::get_columns_core(&self.state, &connection.id, database, schema, table).await
    }

    async fn execute_redis_command(
        &self,
        connection: &ConnectionConfig,
        database: u32,
        command: &str,
        skip_safety_check: bool,
    ) -> Result<RedisCommandResult, String> {
        dbx_core::redis_ops::redis_execute_command_core(
            &self.state,
            &connection.id,
            database,
            command,
            skip_safety_check,
        )
        .await
    }

    async fn execute_mongo_command(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        command: &MongoCommand,
    ) -> Result<dbx_core::db::QueryResult, String> {
        use dbx_core::mongo_ops;

        let connection_id = &connection.id;
        match command {
            MongoCommand::Version => mongo_ops::mongo_server_version_core(&self.state, connection_id, database)
                .await
                .map(|version| scalar_query_result("version", Value::String(version))),
            MongoCommand::Use { database } => Ok(scalar_query_result("database", Value::String(database.clone()))),
            MongoCommand::Find { collection, filter, projection, sort, skip, limit } => {
                let result = mongo_ops::mongo_find_documents_core(
                    &self.state,
                    connection_id,
                    database,
                    collection,
                    *skip,
                    *limit,
                    Some(filter),
                    projection.as_deref(),
                    sort.as_deref(),
                )
                .await?;
                Ok(mongo_documents_query_result(result.documents))
            }
            MongoCommand::FindOne { collection, filter, projection, options } => {
                let result = mongo_ops::mongo_find_one_core(
                    &self.state,
                    connection_id,
                    database,
                    collection,
                    Some(filter),
                    projection.as_deref(),
                    options.as_deref(),
                )
                .await?;
                Ok(mongo_documents_query_result(result.documents))
            }
            MongoCommand::Count { collection, filter, accurate } => {
                let mode = if *accurate { "accurate" } else { "legacy" };
                let total = mongo_ops::mongo_count_documents_core(
                    &self.state,
                    connection_id,
                    database,
                    collection,
                    Some(filter),
                    Some(mode),
                )
                .await?;
                Ok(scalar_query_result("count", Value::from(total)))
            }
            MongoCommand::Aggregate { collection, pipeline, options } => {
                let result = mongo_ops::mongo_aggregate_documents_core(
                    &self.state,
                    connection_id,
                    database,
                    collection,
                    pipeline,
                    Some(100),
                    options.as_deref(),
                )
                .await?;
                Ok(mongo_documents_query_result(result.documents))
            }
            MongoCommand::Distinct { collection, field, filter } => {
                let result = mongo_ops::mongo_distinct_core(
                    &self.state,
                    connection_id,
                    database,
                    collection,
                    field,
                    filter.as_deref(),
                )
                .await?;
                Ok(mongo_documents_query_result(result.documents))
            }
            MongoCommand::GetIndexes { collection } => {
                let result = mongo_ops::mongo_aggregate_documents_core(
                    &self.state,
                    connection_id,
                    database,
                    collection,
                    r#"[{"$indexStats":{}}]"#,
                    Some(100),
                    None,
                )
                .await?;
                Ok(mongo_documents_query_result(result.documents))
            }
            MongoCommand::CollectionStats { collection, metric, scale } => {
                let stats = mongo_ops::mongo_collection_stats_core(
                    &self.state,
                    connection_id,
                    database,
                    collection,
                    scale.clone(),
                )
                .await?;
                let value = serde_json::to_value(stats).map_err(|error| error.to_string())?;
                if metric == "stats" {
                    Ok(mongo_documents_query_result(vec![value]))
                } else {
                    let key = match metric.as_str() {
                        "dataSize" => "size",
                        "storageSize" => "storageSize",
                        "totalIndexSize" => "totalIndexSize",
                        _ => metric,
                    };
                    let metric_value = value.get(key).cloned().unwrap_or(Value::Null);
                    Ok(scalar_query_result(metric, metric_value))
                }
            }
            MongoCommand::Insert { collection, documents } => {
                let affected =
                    mongo_ops::mongo_insert_documents_core(&self.state, connection_id, database, collection, documents)
                        .await?;
                Ok(affected_query_result(affected))
            }
            MongoCommand::Update { collection, filter, update, options, many } => {
                let affected = mongo_ops::mongo_update_documents_core(
                    &self.state,
                    connection_id,
                    database,
                    collection,
                    filter,
                    update,
                    *many,
                    options.as_deref(),
                )
                .await?;
                Ok(affected_query_result(affected))
            }
            MongoCommand::Delete { collection, filter, many } => {
                let affected = mongo_ops::mongo_delete_documents_core(
                    &self.state,
                    connection_id,
                    database,
                    collection,
                    filter,
                    *many,
                )
                .await?;
                Ok(affected_query_result(affected))
            }
            MongoCommand::CreateIndex { collection, keys, options } => {
                let name = mongo_ops::mongo_create_index_core(
                    &self.state,
                    connection_id,
                    database,
                    collection,
                    keys,
                    options.as_deref(),
                )
                .await?;
                Ok(scalar_query_result("name", Value::String(name)))
            }
            MongoCommand::DropIndexes { collection, indexes, single } => {
                let result = mongo_ops::mongo_drop_indexes_core(
                    &self.state,
                    connection_id,
                    database,
                    collection,
                    indexes.as_deref(),
                    *single,
                )
                .await?;
                let rows = result.dropped_names.into_iter().map(|name| vec![Value::String(name)]).collect::<Vec<_>>();
                Ok(query_result(
                    if rows.is_empty() { Vec::new() } else { vec!["name".to_string()] },
                    rows,
                    result.affected_rows,
                ))
            }
            MongoCommand::DropCollection { collection } => {
                mongo_ops::mongo_drop_collection_core(&self.state, connection_id, database, collection).await?;
                Ok(affected_query_result(1))
            }
            MongoCommand::FindOneAndUpdate { collection, filter, update, options } => {
                let result = mongo_ops::mongo_find_one_and_update_core(
                    &self.state,
                    connection_id,
                    database,
                    collection,
                    filter,
                    update,
                    options.as_deref(),
                )
                .await?;
                Ok(mongo_documents_query_result(result.documents))
            }
            MongoCommand::FindOneAndReplace { collection, filter, replacement, options } => {
                let result = mongo_ops::mongo_find_one_and_replace_core(
                    &self.state,
                    connection_id,
                    database,
                    collection,
                    filter,
                    replacement,
                    options.as_deref(),
                )
                .await?;
                Ok(mongo_documents_query_result(result.documents))
            }
            MongoCommand::FindOneAndDelete { collection, filter, options } => {
                let result = mongo_ops::mongo_find_one_and_delete_core(
                    &self.state,
                    connection_id,
                    database,
                    collection,
                    filter,
                    options.as_deref(),
                )
                .await?;
                Ok(mongo_documents_query_result(result.documents))
            }
        }
    }

    async fn bridge_request(&self, path: &str, body: Value) -> Result<(), String> {
        let port = tokio::fs::read_to_string(self.data_dir.join("mcp-bridge-port"))
            .await
            .map_err(|_| "DBX is not running. Please start DBX first.".to_string())?;
        let response = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{}{}", port.trim(), path))
            .json(&body)
            .send()
            .await
            .map_err(|_| "DBX is not running. Please start DBX first.".to_string())?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(response.text().await.unwrap_or_else(|_| "DBX bridge request failed.".to_string()))
        }
    }
}

#[async_trait]
impl DbxBackend for WebBackend {
    async fn load_mcp_global_policy(&self) -> Result<McpGlobalPolicy, String> {
        self.request(reqwest::Method::GET, "/api/app-settings/mcp-policy", None)
            .await?
            .json::<McpGlobalPolicyState>()
            .await
            .map(effective_mcp_policy)
            .map_err(|error| format!("Invalid MCP policy response: {error}"))
    }

    async fn load_connections(&self) -> Result<Vec<ConnectionConfig>, String> {
        self.request(reqwest::Method::GET, "/api/connection/list", None)
            .await?
            .json()
            .await
            .map_err(|error| format!("Invalid connection list response: {error}"))
    }

    async fn execute_agent_tool(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        tool_name: &str,
        arguments: Value,
        _permissions: AgentSqlPermissions,
    ) -> ToolResult {
        let result = async {
            if tool_name != "execute_query" {
                return Err(format!("Unsupported DBX Web agent tool: {tool_name}"));
            }
            if connection.db_type == DatabaseType::MongoDb {
                return Err(
                    "MongoDB shell commands in DBX Web mode are not implemented by the Rust MCP yet.".to_string()
                );
            }
            self.ensure_connected(connection).await?;
            let sql = arguments.get("sql").and_then(Value::as_str).ok_or("Missing SQL query")?;
            let max_rows = arguments.get("limit").and_then(Value::as_u64).unwrap_or(100) as usize;
            let response = self
                .request(
                    reqwest::Method::POST,
                    "/api/query/execute",
                    Some(json!({ "connectionId": connection.id, "database": database, "sql": sql })),
                )
                .await?;
            let query_result: dbx_core::db::QueryResult =
                response.json().await.map_err(|error| format!("Invalid query response: {error}"))?;
            Ok(format_query_result(&query_result, max_rows))
        }
        .await;
        ToolResult {
            tool_call_id: format!("mcp-{tool_name}"),
            tool_name: tool_name.to_string(),
            content: result.as_ref().cloned().unwrap_or_else(|error| format!("Error: {error}")),
            is_error: result.is_err(),
            explain_data: None,
        }
    }

    async fn execute_query(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        sql: &str,
        _max_rows: Option<usize>,
        _timeout_secs: Option<u64>,
    ) -> Result<dbx_core::db::QueryResult, String> {
        if connection.db_type == DatabaseType::MongoDb {
            return Err("MongoDB shell commands in DBX Web mode are not implemented by the Rust CLI yet.".to_string());
        }
        self.ensure_connected(connection).await?;
        self.request(
            reqwest::Method::POST,
            "/api/query/execute",
            Some(json!({ "connectionId": connection.id, "database": database, "sql": sql })),
        )
        .await?
        .json()
        .await
        .map_err(|error| format!("Invalid query response: {error}"))
    }

    async fn add_connection_for_mcp(&self, config: ConnectionConfig) -> Result<ConnectionConfig, String> {
        self.request(reqwest::Method::POST, "/api/connection/mcp/add", Some(json!({ "config": config })))
            .await?
            .json()
            .await
            .map_err(|error| format!("Invalid MCP connection response: {error}"))
    }

    async fn remove_connection_for_mcp(&self, connection_id: &str) -> Result<bool, String> {
        self.request(
            reqwest::Method::POST,
            "/api/connection/mcp/remove",
            Some(json!({ "connectionId": connection_id })),
        )
        .await?
        .json()
        .await
        .map_err(|error| format!("Invalid MCP connection response: {error}"))
    }

    async fn list_tables(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        schema: &str,
    ) -> Result<Vec<TableInfo>, String> {
        self.ensure_connected(connection).await?;
        if connection.db_type == DatabaseType::MongoDb {
            let values: Vec<Value> = self
                .request(
                    reqwest::Method::POST,
                    "/api/mongo/list-collections",
                    Some(json!({ "connectionId": connection.id, "database": database })),
                )
                .await?
                .json()
                .await
                .map_err(|error| format!("Invalid collection list response: {error}"))?;
            return Ok(values
                .into_iter()
                .filter_map(|value| {
                    let name = value
                        .as_str()
                        .map(ToOwned::to_owned)
                        .or_else(|| value.get("name").and_then(Value::as_str).map(ToOwned::to_owned))?;
                    Some(TableInfo {
                        name,
                        table_type: "COLLECTION".to_string(),
                        comment: None,
                        parent_schema: None,
                        parent_name: None,
                    })
                })
                .collect());
        }
        self.request(
            reqwest::Method::GET,
            &format!(
                "/api/schema/tables?connection_id={}&database={}&schema={}",
                url_encode(&connection.id),
                url_encode(database),
                url_encode(schema)
            ),
            None,
        )
        .await?
        .json()
        .await
        .map_err(|error| format!("Invalid table list response: {error}"))
    }

    async fn get_columns(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        schema: &str,
        table: &str,
    ) -> Result<Vec<ColumnInfo>, String> {
        self.ensure_connected(connection).await?;
        if connection.db_type == DatabaseType::MongoDb {
            #[derive(Deserialize)]
            struct MongoDocuments {
                documents: Vec<Value>,
            }
            let result: MongoDocuments = self
                .request(
                    reqwest::Method::POST,
                    "/api/mongo/find-documents",
                    Some(json!({
                        "connectionId": connection.id,
                        "database": database,
                        "collection": table,
                        "skip": 0,
                        "limit": 20,
                        "filter": "{}",
                    })),
                )
                .await?
                .json()
                .await
                .map_err(|error| format!("Invalid MongoDB document response: {error}"))?;
            return Ok(infer_document_columns(&result.documents));
        }
        self.request(
            reqwest::Method::GET,
            &format!(
                "/api/schema/columns?connection_id={}&database={}&schema={}&table={}",
                url_encode(&connection.id),
                url_encode(database),
                url_encode(schema),
                url_encode(table)
            ),
            None,
        )
        .await?
        .json()
        .await
        .map_err(|error| format!("Invalid column list response: {error}"))
    }

    async fn execute_redis_command(
        &self,
        connection: &ConnectionConfig,
        database: u32,
        command: &str,
        skip_safety_check: bool,
    ) -> Result<RedisCommandResult, String> {
        self.ensure_connected(connection).await?;
        self.request(
            reqwest::Method::POST,
            "/api/redis/execute-command",
            Some(json!({
                "connectionId": connection.id,
                "db": database,
                "command": command,
                "skipSafetyCheck": skip_safety_check,
            })),
        )
        .await?
        .json()
        .await
        .map_err(|error| format!("Invalid Redis command response: {error}"))
    }

    async fn execute_mongo_command(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        command: &MongoCommand,
    ) -> Result<dbx_core::db::QueryResult, String> {
        self.ensure_connected(connection).await?;
        let connection_id = &connection.id;
        match command {
            MongoCommand::Version => {
                let version: String = self
                    .request(
                        reqwest::Method::POST,
                        "/api/mongo/server-version",
                        Some(json!({ "connectionId": connection_id, "database": database })),
                    )
                    .await?
                    .json()
                    .await
                    .map_err(|error| format!("Invalid MongoDB version response: {error}"))?;
                Ok(scalar_query_result("version", Value::String(version)))
            }
            MongoCommand::Use { database } => Ok(scalar_query_result("database", Value::String(database.clone()))),
            MongoCommand::Find { collection, filter, projection, sort, skip, limit } => {
                let result = self
                    .request(
                        reqwest::Method::POST,
                        "/api/mongo/find-documents",
                        Some(json!({
                            "connectionId": connection_id,
                            "database": database,
                            "collection": collection,
                            "skip": skip,
                            "limit": limit,
                            "filter": filter,
                            "projection": projection,
                            "sort": sort,
                        })),
                    )
                    .await?
                    .json::<WebMongoDocuments>()
                    .await
                    .map_err(|error| format!("Invalid MongoDB find response: {error}"))?;
                Ok(mongo_documents_query_result(result.documents))
            }
            MongoCommand::FindOne { collection, filter, projection, options } => {
                let result = self
                    .request(
                        reqwest::Method::POST,
                        "/api/mongo/find-one",
                        Some(json!({
                            "connectionId": connection_id,
                            "database": database,
                            "collection": collection,
                            "filter": filter,
                            "projection": projection,
                            "options": options,
                        })),
                    )
                    .await?
                    .json::<WebMongoDocuments>()
                    .await
                    .map_err(|error| format!("Invalid MongoDB findOne response: {error}"))?;
                Ok(mongo_documents_query_result(result.documents))
            }
            MongoCommand::Count { collection, filter, accurate } => {
                let total: u64 = self
                    .request(
                        reqwest::Method::POST,
                        "/api/mongo/count-documents",
                        Some(json!({
                            "connectionId": connection_id,
                            "database": database,
                            "collection": collection,
                            "filter": filter,
                            "mode": if *accurate { "accurate" } else { "legacy" },
                        })),
                    )
                    .await?
                    .json()
                    .await
                    .map_err(|error| format!("Invalid MongoDB count response: {error}"))?;
                Ok(scalar_query_result("count", Value::from(total)))
            }
            MongoCommand::Aggregate { collection, pipeline, options } => {
                let result = self
                    .request(
                        reqwest::Method::POST,
                        "/api/mongo/aggregate-documents",
                        Some(json!({
                            "connectionId": connection_id,
                            "database": database,
                            "collection": collection,
                            "pipelineJson": pipeline,
                            "maxRows": 100,
                            "optionsJson": options,
                        })),
                    )
                    .await?
                    .json::<WebMongoDocuments>()
                    .await
                    .map_err(|error| format!("Invalid MongoDB aggregate response: {error}"))?;
                Ok(mongo_documents_query_result(result.documents))
            }
            MongoCommand::Distinct { collection, field, filter } => {
                let result = self
                    .request(
                        reqwest::Method::POST,
                        "/api/mongo/distinct",
                        Some(json!({
                            "connectionId": connection_id,
                            "database": database,
                            "collection": collection,
                            "field": field,
                            "filter": filter,
                        })),
                    )
                    .await?
                    .json::<WebMongoDocuments>()
                    .await
                    .map_err(|error| format!("Invalid MongoDB distinct response: {error}"))?;
                Ok(mongo_documents_query_result(result.documents))
            }
            MongoCommand::GetIndexes { collection } => {
                let result = self
                    .request(
                        reqwest::Method::POST,
                        "/api/mongo/aggregate-documents",
                        Some(json!({
                            "connectionId": connection_id,
                            "database": database,
                            "collection": collection,
                            "pipelineJson": r#"[{"$indexStats":{}}]"#,
                            "maxRows": 100,
                        })),
                    )
                    .await?
                    .json::<WebMongoDocuments>()
                    .await
                    .map_err(|error| format!("Invalid MongoDB indexes response: {error}"))?;
                Ok(mongo_documents_query_result(result.documents))
            }
            MongoCommand::CollectionStats { collection, metric, scale } => {
                let value: Value = self
                    .request(
                        reqwest::Method::POST,
                        "/api/mongo/collection-stats",
                        Some(json!({
                            "connectionId": connection_id,
                            "database": database,
                            "collection": collection,
                            "scale": scale,
                        })),
                    )
                    .await?
                    .json()
                    .await
                    .map_err(|error| format!("Invalid MongoDB stats response: {error}"))?;
                if metric == "stats" {
                    Ok(mongo_documents_query_result(vec![value]))
                } else {
                    let key = match metric.as_str() {
                        "dataSize" => "size",
                        "storageSize" => "storageSize",
                        "totalIndexSize" => "totalIndexSize",
                        _ => metric,
                    };
                    let metric_value = value.get(key).cloned().unwrap_or(Value::Null);
                    Ok(scalar_query_result(metric, metric_value))
                }
            }
            MongoCommand::Insert { collection, documents } => {
                let value: Value = self
                    .request(
                        reqwest::Method::POST,
                        "/api/mongo/insert-documents",
                        Some(json!({
                            "connectionId": connection_id,
                            "database": database,
                            "collection": collection,
                            "docsJson": documents,
                        })),
                    )
                    .await?
                    .json()
                    .await
                    .map_err(|error| format!("Invalid MongoDB insert response: {error}"))?;
                Ok(affected_query_result(affected_rows_from_value(&value)))
            }
            MongoCommand::Update { collection, filter, update, options, many } => {
                let value: Value = self
                    .request(
                        reqwest::Method::POST,
                        "/api/mongo/update-documents",
                        Some(json!({
                            "connectionId": connection_id,
                            "database": database,
                            "collection": collection,
                            "filterJson": filter,
                            "updateJson": update,
                            "many": many,
                            "optionsJson": options,
                        })),
                    )
                    .await?
                    .json()
                    .await
                    .map_err(|error| format!("Invalid MongoDB update response: {error}"))?;
                Ok(affected_query_result(affected_rows_from_value(&value)))
            }
            MongoCommand::Delete { collection, filter, many } => {
                let value: Value = self
                    .request(
                        reqwest::Method::POST,
                        "/api/mongo/delete-documents",
                        Some(json!({
                            "connectionId": connection_id,
                            "database": database,
                            "collection": collection,
                            "filterJson": filter,
                            "many": many,
                        })),
                    )
                    .await?
                    .json()
                    .await
                    .map_err(|error| format!("Invalid MongoDB delete response: {error}"))?;
                Ok(affected_query_result(affected_rows_from_value(&value)))
            }
            MongoCommand::CreateIndex { collection, keys, options } => {
                let value: Value = self
                    .request(
                        reqwest::Method::POST,
                        "/api/mongo/create-index",
                        Some(json!({
                            "connectionId": connection_id,
                            "database": database,
                            "collection": collection,
                            "keysJson": keys,
                            "optionsJson": options,
                        })),
                    )
                    .await?
                    .json()
                    .await
                    .map_err(|error| format!("Invalid MongoDB create index response: {error}"))?;
                Ok(scalar_query_result(
                    "name",
                    Value::String(value.get("name").and_then(Value::as_str).unwrap_or("").to_string()),
                ))
            }
            MongoCommand::DropIndexes { collection, indexes, single } => {
                let value: Value = self
                    .request(
                        reqwest::Method::POST,
                        "/api/mongo/drop-indexes",
                        Some(json!({
                            "connectionId": connection_id,
                            "database": database,
                            "collection": collection,
                            "indexesJson": indexes,
                            "single": single,
                        })),
                    )
                    .await?
                    .json()
                    .await
                    .map_err(|error| format!("Invalid MongoDB drop indexes response: {error}"))?;
                let dropped_names = value
                    .get("dropped_names")
                    .or_else(|| value.get("droppedNames"))
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(|name| vec![Value::String(name.to_string())])
                    .collect::<Vec<_>>();
                Ok(query_result(
                    if dropped_names.is_empty() { Vec::new() } else { vec!["name".to_string()] },
                    dropped_names,
                    affected_rows_from_value(&value),
                ))
            }
            MongoCommand::DropCollection { collection } => {
                self.request(
                    reqwest::Method::POST,
                    "/api/mongo/drop-collection",
                    Some(json!({ "connectionId": connection_id, "database": database, "collection": collection })),
                )
                .await?;
                Ok(affected_query_result(1))
            }
            MongoCommand::FindOneAndUpdate { collection, filter, update, options } => {
                let result = self
                    .request(
                        reqwest::Method::POST,
                        "/api/mongo/find-one-and-update",
                        Some(json!({
                            "connectionId": connection_id,
                            "database": database,
                            "collection": collection,
                            "filterJson": filter,
                            "updateJson": update,
                            "optionsJson": options,
                        })),
                    )
                    .await?
                    .json::<WebMongoDocuments>()
                    .await
                    .map_err(|error| format!("Invalid MongoDB findOneAndUpdate response: {error}"))?;
                Ok(mongo_documents_query_result(result.documents))
            }
            MongoCommand::FindOneAndReplace { collection, filter, replacement, options } => {
                let result = self
                    .request(
                        reqwest::Method::POST,
                        "/api/mongo/find-one-and-replace",
                        Some(json!({
                            "connectionId": connection_id,
                            "database": database,
                            "collection": collection,
                            "filterJson": filter,
                            "replacementJson": replacement,
                            "optionsJson": options,
                        })),
                    )
                    .await?
                    .json::<WebMongoDocuments>()
                    .await
                    .map_err(|error| format!("Invalid MongoDB findOneAndReplace response: {error}"))?;
                Ok(mongo_documents_query_result(result.documents))
            }
            MongoCommand::FindOneAndDelete { collection, filter, options } => {
                let result = self
                    .request(
                        reqwest::Method::POST,
                        "/api/mongo/find-one-and-delete",
                        Some(json!({
                            "connectionId": connection_id,
                            "database": database,
                            "collection": collection,
                            "filterJson": filter,
                            "optionsJson": options,
                        })),
                    )
                    .await?
                    .json::<WebMongoDocuments>()
                    .await
                    .map_err(|error| format!("Invalid MongoDB findOneAndDelete response: {error}"))?;
                Ok(mongo_documents_query_result(result.documents))
            }
        }
    }
}

#[derive(Deserialize)]
struct WebMongoDocuments {
    documents: Vec<Value>,
}

fn extract_session_cookie(header: &str) -> Option<String> {
    header
        .split(';')
        .find_map(|part| part.trim().strip_prefix("dbx_session=").map(ToOwned::to_owned))
        .filter(|value| !value.is_empty())
}

fn url_encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

pub(crate) fn format_query_result(result: &dbx_core::db::QueryResult, max_rows: usize) -> String {
    if result.columns.is_empty() {
        return format!("Query executed. {} row(s) affected.", result.affected_rows);
    }
    let rows = result
        .rows
        .iter()
        .take(max_rows)
        .map(|row| row.iter().map(format_query_cell).collect::<Vec<_>>())
        .collect::<Vec<_>>();
    let mut output = markdown_table(&result.columns, &rows);
    output.push_str(&format!("\n\n{} row(s)", rows.len()));
    output
}

fn query_result(columns: Vec<String>, rows: Vec<Vec<Value>>, affected_rows: u64) -> dbx_core::db::QueryResult {
    dbx_core::db::QueryResult {
        columns,
        column_types: Vec::new(),
        column_sortables: Vec::new(),
        rows,
        affected_rows,
        execution_time_ms: 0,
        truncated: false,
        session_id: None,
        has_more: false,
    }
}

fn scalar_query_result(column: impl Into<String>, value: Value) -> dbx_core::db::QueryResult {
    query_result(vec![column.into()], vec![vec![value]], 0)
}

fn affected_query_result(affected_rows: u64) -> dbx_core::db::QueryResult {
    query_result(Vec::new(), Vec::new(), affected_rows)
}

fn mongo_documents_query_result(documents: Vec<Value>) -> dbx_core::db::QueryResult {
    if documents.is_empty() {
        return query_result(Vec::new(), Vec::new(), 0);
    }
    let mut columns = std::collections::BTreeSet::new();
    for document in &documents {
        if let Some(object) = document.as_object() {
            columns.extend(object.keys().cloned());
        } else {
            columns.insert("value".to_string());
        }
    }
    let columns = columns.into_iter().collect::<Vec<_>>();
    let rows = documents
        .into_iter()
        .map(|document| {
            columns
                .iter()
                .map(|column| {
                    document
                        .as_object()
                        .and_then(|object| object.get(column))
                        .cloned()
                        .or_else(|| (column == "value").then(|| document.clone()))
                        .unwrap_or(Value::Null)
                })
                .collect()
        })
        .collect();
    query_result(columns, rows, 0)
}

fn affected_rows_from_value(value: &Value) -> u64 {
    value.get("affected_rows").or_else(|| value.get("affectedRows")).and_then(Value::as_u64).unwrap_or(0)
}

fn format_query_cell(value: &Value) -> String {
    match value {
        Value::Null => "NULL".to_string(),
        Value::String(value) => value.clone(),
        Value::Array(_) | Value::Object(_) => serde_json::to_string(value).unwrap_or_else(|_| value.to_string()),
        value => value.to_string(),
    }
}

fn markdown_table(headers: &[String], rows: &[Vec<String>]) -> String {
    let mut output = format!(
        "| {} |\n| {} |",
        headers.iter().map(|value| escape_markdown_cell(value)).collect::<Vec<_>>().join(" | "),
        vec!["---"; headers.len()].join(" | ")
    );
    for row in rows {
        output.push_str(&format!(
            "\n| {} |",
            row.iter().map(|value| escape_markdown_cell(value)).collect::<Vec<_>>().join(" | ")
        ));
    }
    output
}

fn escape_markdown_cell(value: &str) -> String {
    value.replace('|', "\\|").replace(['\r', '\n'], " ")
}

fn infer_document_columns(documents: &[Value]) -> Vec<ColumnInfo> {
    let mut columns = std::collections::BTreeMap::<String, String>::new();
    for document in documents {
        let Some(object) = document.as_object() else { continue };
        for (name, value) in object {
            columns.entry(name.clone()).or_insert_with(|| json_type_name(value).to_string());
        }
    }
    columns
        .into_iter()
        .map(|(name, data_type)| ColumnInfo {
            name,
            data_type,
            is_nullable: true,
            column_default: None,
            is_primary_key: false,
            extra: None,
            comment: None,
            numeric_precision: None,
            numeric_scale: None,
            character_maximum_length: None,
            enum_values: None,
            character_set: None,
            collation: None,
        })
        .collect()
}

fn json_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(number) if number.is_i64() || number.is_u64() => "integer",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

pub fn parse_database_type(value: &str) -> Result<DatabaseType, String> {
    serde_json::from_value(serde_json::Value::String(value.trim().to_ascii_lowercase()))
        .map_err(|_| format!("Unsupported database type: {value}"))
}

#[derive(Debug, Deserialize, Serialize)]
struct NewConnectionConfig {
    id: String,
    name: String,
    db_type: DatabaseType,
    host: String,
    port: u16,
    username: String,
    password: String,
    database: Option<String>,
    ssl: bool,
    driver_profile: Option<String>,
}

pub fn new_connection_config(
    id: String,
    name: String,
    db_type: DatabaseType,
    host: String,
    port: u16,
    username: String,
    password: String,
    database: Option<String>,
    ssl: bool,
    driver_profile: Option<String>,
) -> Result<ConnectionConfig, String> {
    let minimal =
        NewConnectionConfig { id, name, db_type, host, port, username, password, database, ssl, driver_profile };
    serde_json::from_value(serde_json::to_value(minimal).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy_state(configured: bool, read_only: bool) -> McpGlobalPolicyState {
        McpGlobalPolicyState { configured, read_only, allow_dangerous_sql: false, allowed_connection_ids: None }
    }

    #[test]
    fn legacy_read_only_only_restricts_an_unconfigured_policy() {
        assert!(effective_mcp_policy_with_legacy_allow_writes(policy_state(false, false), Some(false)).read_only);
        assert!(!effective_mcp_policy_with_legacy_allow_writes(policy_state(false, false), Some(true)).read_only);
        assert!(!effective_mcp_policy_with_legacy_allow_writes(policy_state(true, false), Some(false)).read_only);
        assert!(effective_mcp_policy_with_legacy_allow_writes(policy_state(true, true), Some(true)).read_only);
    }

    #[test]
    fn parses_database_type_using_dbx_protocol_names() {
        assert_eq!(parse_database_type("Postgres").unwrap(), DatabaseType::Postgres);
        assert_eq!(parse_database_type("mongodb").unwrap(), DatabaseType::MongoDb);
        assert!(parse_database_type("unknown").is_err());
    }
}
