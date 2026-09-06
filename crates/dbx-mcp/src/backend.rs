use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use async_trait::async_trait;
use dbx_core::{
    agent_events::{ToolCall, ToolResult},
    agent_tools::{self, format_query_result_as_text, AgentSqlPermissions, QueryCellWindow},
    connection::AppState,
    db::{mongo_driver::MongoIndexSpec, redis_driver::RedisCommandResult, ColumnInfo, TableInfo},
    models::connection::{ConnectionConfig, DatabaseType},
    storage::{DesktopSettings, McpGlobalPolicy, McpGlobalPolicyState, Storage},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

use crate::mongo::MongoCommand;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ConnectionSummary {
    pub id: String,
    pub name: String,
    pub db_type: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub group_path: Vec<String>,
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
            group_path: Vec::new(),
        }
    }
}

#[derive(Deserialize)]
struct SidebarLayout {
    #[serde(default)]
    groups: Vec<SidebarGroup>,
    #[serde(default)]
    order: Vec<SidebarOrderEntry>,
}

#[derive(Deserialize)]
struct SidebarGroup {
    id: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum SidebarOrderEntry {
    #[serde(rename = "group")]
    Group {
        id: String,
        children: Option<Vec<SidebarOrderEntry>>,
        #[serde(rename = "connectionIds")]
        connection_ids: Option<Vec<String>>,
    },
    #[serde(rename = "connection")]
    Connection { id: String },
}

fn connection_group_paths(layout: Value) -> HashMap<String, Vec<String>> {
    let Ok(layout) = serde_json::from_value::<SidebarLayout>(layout) else {
        return HashMap::new();
    };
    let groups = layout.groups.into_iter().map(|group| (group.id, group.name)).collect::<HashMap<_, _>>();
    let mut paths = HashMap::new();
    collect_connection_group_paths(&layout.order, &groups, &mut Vec::new(), &mut paths);
    paths
}

fn collect_connection_group_paths(
    entries: &[SidebarOrderEntry],
    groups: &HashMap<String, String>,
    path: &mut Vec<String>,
    paths: &mut HashMap<String, Vec<String>>,
) {
    for entry in entries {
        match entry {
            SidebarOrderEntry::Connection { id } => {
                paths.insert(id.clone(), path.clone());
            }
            SidebarOrderEntry::Group { id, children, connection_ids } => {
                let Some(name) = groups.get(id) else {
                    continue;
                };
                path.push(name.clone());
                if let Some(children) = children {
                    collect_connection_group_paths(children, groups, path, paths);
                } else if let Some(connection_ids) = connection_ids {
                    for connection_id in connection_ids {
                        paths.insert(connection_id.clone(), path.clone());
                    }
                }
                path.pop();
            }
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
    let mut policy = state.policy();
    // When DBX_MCP_ALLOW_WRITES is explicitly set to false by the CLI agent
    // for an unconfirmed run, force read-only regardless of the configured
    // persistent MCP policy. Run-scoped CLI restrictions must override the
    // persistent policy, otherwise a user with a writable configured policy
    // can execute unconfirmed writes through CLI providers.
    if legacy_allow_writes == Some(false) {
        policy.read_only = true;
    }
    policy
}

/// Wire-level result for one statement within a `dbx_execute_batch` call.
///
/// Mirrors the per-statement metadata the Web `/api/query/execute-multi` route
/// returns. `dbx_core::query::ExecuteMultiResult` only derives `Serialize`, so
/// a separate type that also derives `Deserialize` lets the Web backend decode
/// the JSON response while LocalBackend adapts from the core type. The error is
/// kept as an optional message string so `Deserialize` never has to handle the
/// private-field `BackendError` envelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchStatementResult {
    #[serde(flatten)]
    pub result: dbx_core::db::QueryResult,
    #[serde(skip_serializing_if = "is_false")]
    pub execution_error: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub statement_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    /// True when this entry is the single merged outcome of a `use_transaction`
    /// batch rather than an auto-commit per-statement result. Set by the MCP
    /// server, which knows the requested mode; the wire decoders default to
    /// false.
    #[serde(skip_serializing_if = "is_false")]
    pub merged: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl From<dbx_core::query::ExecuteMultiResult> for BatchStatementResult {
    fn from(result: dbx_core::query::ExecuteMultiResult) -> Self {
        let error_message = result.error.as_ref().and_then(|error| error.detail().map(str::to_owned)).or_else(|| {
            result.result.rows.first().and_then(|row| row.first()).and_then(Value::as_str).map(str::to_owned)
        });
        Self {
            result: result.result,
            execution_error: result.execution_error,
            statement_index: result.statement_index,
            error_message,
            merged: false,
        }
    }
}

/// Optionally decode a loose per-statement JSON object from the Web
/// `/api/query/execute-multi` response into a `BatchStatementResult`.
///
/// The Web route serializes `dbx_core::query::ExecuteMultiResult`, whose fields
/// are flattened onto the `QueryResult` and whose `error` is a `BackendError`
/// envelope with private fields and no `Deserialize` impl. This decodes only
/// the fields the MCP renderer needs instead of reconstructing the envelope.
/// Returns an explicit error when the response shape is not what this client
/// expects, so a protocol drift fails loudly instead of silently dropping
/// statements from the batch.
fn batch_statement_result_from_json(value: &Value) -> Result<BatchStatementResult, String> {
    let result: dbx_core::db::QueryResult = serde_json::from_value(value.clone())
        .map_err(|error| format!("Invalid execute-multi statement envelope: {error} (element: {value})"))?;
    let execution_error = value.get("execution_error").and_then(Value::as_bool).unwrap_or(false);
    let statement_index = value.get("statement_index").and_then(Value::as_u64).map(|index| index as usize);
    let error_message = value
        .pointer("/error/detail")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| value.pointer("/rows/0/0").and_then(Value::as_str).map(str::to_owned));
    Ok(BatchStatementResult { result, execution_error, statement_index, error_message, merged: false })
}

/// Wire-level options for a documentation snapshot. Mirrors
/// `dbx_core::docs::CollectOptions` minus the fields the backend fills in.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocsSnapshotOptions {
    #[serde(default)]
    pub schemas: Vec<String>,
    #[serde(default)]
    pub tables: Vec<String>,
    #[serde(default)]
    pub project_name: Option<String>,
}

#[async_trait]
pub trait DbxBackend: Send + Sync {
    async fn load_mcp_global_policy(&self) -> Result<McpGlobalPolicy, String>;

    async fn load_connections(&self) -> Result<Vec<ConnectionConfig>, String>;
    /// Return database names visible to the DBX connection itself. The MCP
    /// server applies its own database-scope policy before exposing these
    /// names to a client.
    async fn list_databases(&self, connection: &ConnectionConfig) -> Result<Vec<String>, String> {
        let _ = connection;
        Err("Database metadata is not supported by this backend.".to_string())
    }
    async fn load_connection_group_paths(&self) -> Result<HashMap<String, Vec<String>>, String> {
        Ok(HashMap::new())
    }
    async fn execute_agent_tool(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        tool_name: &str,
        arguments: Value,
        permissions: AgentSqlPermissions,
    ) -> ToolResult;
    #[cfg(feature = "mq-admin")]
    async fn send_message(
        &self,
        connection: &ConnectionConfig,
        request: dbx_core::mq::SendMessageRequest,
    ) -> Result<dbx_core::mq::SendMessageResponse, String> {
        let _ = (connection, request);
        Err("Message queue sending is not supported by this backend.".to_string())
    }
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
    /// Execute a multi-statement SQL script, returning one result per statement.
    ///
    /// The script text is split using the database-dialect-aware splitter so
    /// semicolons inside strings, comments, and stored procedures are handled.
    /// `schema` carries the configured scope schema when present. `continue_on_error`
    /// / `use_transaction` / `client_session_id` are carried through `options`.
    /// Mirrors the Web `/api/query/execute-multi` route.
    async fn execute_batch(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        schema: Option<&str>,
        sql: &str,
        options: dbx_core::query::QueryExecutionOptions,
    ) -> Result<Vec<BatchStatementResult>, String> {
        let _ = (connection, database, schema, sql, options);
        Err("SQL batch execution is not supported by this backend.".to_string())
    }
    /// Dialect-aware execution plan for a batch script, computed the way the core
    /// will split it (including the SQL Server agent `GO`-batch splitter), so the
    /// MCP pre-check's transaction-entry decision never diverges from the core.
    /// The in-process backend overrides this to resolve the pool's agent-ness;
    /// the default is the database-dialect splitter.
    async fn execution_plan(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        sql: &str,
    ) -> dbx_core::sql::SqlExecutionPlan {
        let _ = database;
        dbx_core::sql::sql_execution_plan_for_database(sql, connection.db_type)
    }
    async fn add_connection_for_mcp(&self, config: ConnectionConfig) -> Result<ConnectionConfig, String>;
    async fn duplicate_connection_for_mcp(
        &self,
        source_id: &str,
        copy_id: &str,
        copy_name: &str,
    ) -> Result<ConnectionConfig, String>;
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
    /// List stored routines (procedures/functions) for a schema. `routine_types`
    /// filters by object type ("PROCEDURE"/"FUNCTION"); `None` returns both.
    async fn list_routines(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        schema: &str,
        routine_types: Option<&[String]>,
    ) -> Result<Vec<dbx_core::db::ObjectInfo>, String> {
        let _ = (connection, database, schema, routine_types);
        Err("Routine metadata is not supported by this backend.".to_string())
    }
    /// Fetch a stored routine's full source text. `object_type` is
    /// `PROCEDURE` or `FUNCTION` (SCREAMING_SNAKE_CASE, as in the desktop API).
    async fn get_routine_source(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        schema: &str,
        name: &str,
        object_type: &str,
        signature: Option<&str>,
    ) -> Result<dbx_core::db::ObjectSource, String> {
        let _ = (connection, database, schema, name, object_type, signature);
        Err("Routine source is not supported by this backend.".to_string())
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
    /// Release the connection pool pinned by an MCP session (`client_session_id`).
    async fn close_client_session(
        &self,
        connection_id: &str,
        database: &str,
        client_session_id: &str,
    ) -> Result<bool, String> {
        let _ = (connection_id, database, client_session_id);
        Err("Session cleanup is not supported by this backend.".to_string())
    }
    async fn bridge_request(&self, path: &str, body: Value) -> Result<(), String> {
        let _ = (path, body);
        Err("DBX is not running. Please start DBX first.".to_string())
    }
    async fn collect_docs_snapshot(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        options: DocsSnapshotOptions,
    ) -> Result<dbx_core::docs::SchemaSnapshot, String> {
        let _ = (connection, database, options);
        Err("Documentation snapshots are not supported by this backend.".to_string())
    }
}

pub struct LocalBackend {
    state: Arc<AppState>,
    data_dir: std::path::PathBuf,
}

#[derive(Debug, Default)]
struct WebAuthState {
    session_cookie: Option<String>,
    checked: bool,
}

pub struct WebBackend {
    base_url: String,
    username: String,
    password: String,
    client: reqwest::Client,
    headers: HeaderMap,
    auth: Mutex<WebAuthState>,
    connected: Mutex<HashMap<String, ConnectionConfig>>,
}

// Manual impl: the derived one would print `password` (and the session cookie
// inside `auth`) in plaintext. Redact credentials and skip lockable state.
impl std::fmt::Debug for WebBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let header_names = self.headers.keys().map(HeaderName::as_str).collect::<Vec<_>>();
        f.debug_struct("WebBackend")
            .field("base_url", &self.base_url)
            .field("password", &"<redacted>")
            .field("header_names", &header_names)
            .finish_non_exhaustive()
    }
}

impl WebBackend {
    pub fn new(base_url: String, password: String, username: Option<String>) -> Result<Self, String> {
        let (proxy, no_proxy) = standard_web_proxy(&base_url);
        let tls_skip_verify = std::env::var("DBX_WEB_INSECURE_SKIP_VERIFY")
            .ok()
            .map(|value| value.trim().to_ascii_lowercase())
            .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"));
        Self::new_with_config(
            base_url,
            password,
            username,
            proxy,
            no_proxy,
            std::env::var("DBX_WEB_HEADERS").ok(),
            tls_skip_verify,
            std::env::var("DBX_WEB_CA_CERT").ok().filter(|value| !value.trim().is_empty()),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn new_with_config(
        base_url: String,
        password: String,
        username: Option<String>,
        proxy: Option<String>,
        no_proxy: Option<String>,
        headers_json: Option<String>,
        tls_skip_verify: bool,
        ca_cert_path: Option<String>,
    ) -> Result<Self, String> {
        let base_url = base_url.trim().trim_end_matches('/').to_string();
        if base_url.is_empty() {
            return Err("DBX_WEB_URL cannot be empty.".to_string());
        }
        let username =
            username.map(|u| u.trim().to_string()).filter(|u| !u.is_empty()).unwrap_or_else(|| "admin".to_string());
        let mut builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());
        if let Some(proxy_url) = proxy.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
            let mut proxy = reqwest::Proxy::all(proxy_url)
                .map_err(|error| format!("Invalid HTTP(S)_PROXY/ALL_PROXY value: {error}"))?;
            if let Some(no_proxy) = no_proxy.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
                proxy = proxy.no_proxy(reqwest::NoProxy::from_string(no_proxy));
            }
            builder = builder.proxy(proxy);
        } else {
            // Unset or empty proxy configuration: connect directly.
            builder = builder.no_proxy();
        }
        // TLS: mirror the Consul/Nacos client convention. Certificate
        // verification is on by default; opt out with DBX_WEB_INSECURE_SKIP_VERIFY
        // for self-signed endpoints, or trust a private CA with DBX_WEB_CA_CERT.
        if tls_skip_verify {
            builder = builder.danger_accept_invalid_certs(true);
        }
        if let Some(ca_cert_path) = ca_cert_path.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
            let path = dbx_core::path_utils::expand_tilde(ca_cert_path);
            let bytes =
                std::fs::read(&path).map_err(|error| format!("Failed to read DBX_WEB_CA_CERT at {path}: {error}"))?;
            let certificates = reqwest::Certificate::from_pem_bundle(&bytes)
                .or_else(|_| reqwest::Certificate::from_der(&bytes).map(|certificate| vec![certificate]))
                .map_err(|error| format!("Failed to parse DBX_WEB_CA_CERT at {path}: {error}"))?;
            for certificate in certificates {
                builder = builder.add_root_certificate(certificate);
            }
        }
        let client = builder.build().map_err(|error| error.to_string())?;
        Ok(Self {
            base_url,
            username,
            password,
            client,
            headers: parse_custom_headers(headers_json.as_deref())?,
            auth: Mutex::new(WebAuthState::default()),
            connected: Mutex::new(HashMap::new()),
        })
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
        let mut request = self.client.get(format!("{}/api/auth/check", self.base_url));
        for (name, value) in &self.headers {
            request = request.header(name, value);
        }
        let response = request.send().await.map_err(|error| format!("Authentication check failed: {error}"))?;
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
        let mut request = self.client.post(format!("{}/api/auth/login", self.base_url));
        for (name, value) in &self.headers {
            request = request.header(name, value);
        }
        let response = request
            .json(&json!({ "username": self.username, "password": self.password }))
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
            for (name, value) in &self.headers {
                request = request.header(name, value);
            }
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
        let mut connected = self.connected.lock().await;
        if connected.get(&connection.id) == Some(connection) {
            return Ok(());
        }
        self.request(reqwest::Method::POST, "/api/connection/connect", Some(json!({ "config": connection }))).await?;
        connected.insert(connection.id.clone(), connection.clone());
        Ok(())
    }
}

impl LocalBackend {
    /// Reuse an already initialized DBX application state, for hosts that
    /// embed MCP alongside their own HTTP server.
    pub fn from_app_state(state: Arc<AppState>, data_dir: PathBuf) -> Self {
        Self { state, data_dir }
    }

    pub async fn open(path: &Path) -> Result<Self, String> {
        let storage = Storage::open(path).await?;
        let configs = storage.load_connections().await?;
        let desktop_settings = storage.load_desktop_settings().await.unwrap_or_default();
        let data_dir = path.parent().unwrap_or_else(|| Path::new(".")).to_path_buf();
        let plugin_dir = local_plugin_dir(&desktop_settings, &data_dir);
        let agent_dir = local_agent_dir(&desktop_settings, &data_dir);
        let state = Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
            storage,
            plugin_dir,
            agent_dir,
            env!("CARGO_PKG_VERSION"),
        ));
        let config_map: HashMap<String, ConnectionConfig> =
            configs.into_iter().map(|config| (config.id.clone(), config)).collect();
        *state.configs.write().await = config_map;
        Ok(Self { state, data_dir })
    }

    pub fn state(&self) -> &Arc<AppState> {
        &self.state
    }

    /// Sync the latest connection list from storage into the `AppState.configs` in-memory cache:
    /// upsert new/changed entries and remove connections deleted from storage. Only LocalBackend
    /// needs this — WebBackend talks HTTP and holds no local AppState, and the desktop mcp_bridge
    /// shares the DBX process so it is unaffected by this cache desync.
    async fn sync_runtime_configs(&self, configs: &[ConnectionConfig]) {
        let mut runtime = self.state.configs.write().await;
        for config in configs {
            match runtime.get(&config.id) {
                Some(existing) if existing == config => {}
                _ => {
                    runtime.insert(config.id.clone(), config.clone());
                }
            }
        }
        let stale_ids: Vec<String> =
            runtime.keys().filter(|id| !configs.iter().any(|config| &config.id == *id)).cloned().collect();
        for id in stale_ids {
            runtime.remove(&id);
        }
    }
}

fn local_plugin_dir(settings: &DesktopSettings, data_dir: &Path) -> PathBuf {
    let legacy_driver_base =
        settings.driver_store_dir.as_ref().filter(|value| !value.trim().is_empty()).map(PathBuf::from);
    settings
        .plugin_store_dir
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| legacy_driver_base.map(|base| base.join("plugins")))
        .unwrap_or_else(|| data_dir.join("plugins"))
}

/// Whether an object listing entry is a stored routine (procedure or function).
fn is_routine_object(object_type: &str) -> bool {
    object_type.eq_ignore_ascii_case("PROCEDURE") || object_type.eq_ignore_ascii_case("FUNCTION")
}

/// Parse a routine type string ("PROCEDURE"/"FUNCTION", case-insensitive) into
/// the core `ObjectSourceKind` used by `get_object_source_core`.
fn parse_routine_kind(object_type: &str) -> Result<dbx_core::db::ObjectSourceKind, String> {
    match object_type.trim().to_ascii_uppercase().as_str() {
        "PROCEDURE" => Ok(dbx_core::db::ObjectSourceKind::Procedure),
        "FUNCTION" => Ok(dbx_core::db::ObjectSourceKind::Function),
        other => Err(format!("Unsupported routine type \"{other}\"; use PROCEDURE or FUNCTION.")),
    }
}

fn local_agent_dir(settings: &DesktopSettings, data_dir: &Path) -> PathBuf {
    let legacy_driver_base =
        settings.driver_store_dir.as_ref().filter(|value| !value.trim().is_empty()).map(PathBuf::from);
    settings
        .agent_store_dir
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| legacy_driver_base.map(|base| base.join("agents")))
        .unwrap_or_else(|| {
            if std::env::var_os("DBX_DATA_DIR").filter(|value| !value.is_empty()).is_some() {
                data_dir.join("agents")
            } else {
                dbx_core::connection::default_agent_dir()
            }
        })
}

#[async_trait]
impl DbxBackend for LocalBackend {
    async fn load_mcp_global_policy(&self) -> Result<McpGlobalPolicy, String> {
        self.state.storage.load_mcp_global_policy().await.map(effective_mcp_policy)
    }

    async fn load_connections(&self) -> Result<Vec<ConnectionConfig>, String> {
        let configs = self.state.storage.load_connections().await?;
        // Connections created/modified/deleted in the DBX desktop UI after this process started
        // only update the shared SQLite storage; the AppState.configs in-memory cache is not kept
        // in sync. Sync the latest config into the runtime cache after each read, otherwise DB
        // operations that look up the pool by id via get_or_create_pool fail with
        // "Connection config not found" (the agent can list the connection but cannot use it,
        // and a manual MCP reload is needed to recover).
        self.sync_runtime_configs(&configs).await;
        Ok(configs)
    }

    async fn list_databases(&self, connection: &ConnectionConfig) -> Result<Vec<String>, String> {
        // `list_databases_core` supports many database engines and therefore
        // produces a very large future. Boxing it here keeps the async-trait
        // implementation below Rust's type-layout recursion limit in desktop
        // builds without changing its execution behaviour.
        Box::pin(dbx_core::schema::list_databases_core(&self.state, &connection.id))
            .await
            .map(|databases| databases.into_iter().map(|database| database.name).collect())
    }

    async fn load_connection_group_paths(&self) -> Result<HashMap<String, Vec<String>>, String> {
        Ok(self.state.storage.load_sidebar_layout().await?.map(connection_group_paths).unwrap_or_default())
    }

    async fn execute_agent_tool(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        tool_name: &str,
        arguments: Value,
        permissions: AgentSqlPermissions,
    ) -> ToolResult {
        let schema = arguments.get("schema").and_then(|value| value.as_str()).map(ToOwned::to_owned);
        let call =
            ToolCall { id: format!("mcp-{tool_name}"), name: tool_name.to_string(), arguments, provider_payload: None };
        agent_tools::execute_tool(
            &call,
            &self.state,
            &connection.id,
            database,
            schema.as_deref(),
            &connection.db_type,
            permissions,
        )
        .await
    }

    #[cfg(feature = "mq-admin")]
    async fn send_message(
        &self,
        connection: &ConnectionConfig,
        request: dbx_core::mq::SendMessageRequest,
    ) -> Result<dbx_core::mq::SendMessageResponse, String> {
        dbx_core::mq::service::mq_send_message_core(&self.state, &connection.id, request).await
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

    async fn execute_batch(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        schema: Option<&str>,
        sql: &str,
        options: dbx_core::query::QueryExecutionOptions,
    ) -> Result<Vec<BatchStatementResult>, String> {
        // The multi-statement executor dispatches across every database engine
        // and produces a very large future. Boxing it keeps the async-trait
        // implementation below Rust's type-layout recursion limit (query depth
        // overflow reported at this async block) without changing behaviour.
        let results = Box::pin(dbx_core::query::execute_multi_core_with_options_for_client(
            &self.state,
            &connection.id,
            database,
            sql,
            schema,
            None,
            options,
        ))
        .await?;
        Ok(results.into_iter().map(BatchStatementResult::from).collect())
    }

    async fn execution_plan(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        sql: &str,
    ) -> dbx_core::sql::SqlExecutionPlan {
        let is_sqlserver_agent =
            dbx_core::query::connection_pool_is_sqlserver_agent(self.state.as_ref(), &connection.id, database).await;
        dbx_core::query::query_execution_plan(sql, Some(connection.db_type), is_sqlserver_agent)
    }

    async fn add_connection_for_mcp(&self, config: ConnectionConfig) -> Result<ConnectionConfig, String> {
        let config = self.state.storage.add_connection_for_mcp(config).await?;
        self.state.configs.write().await.insert(config.id.clone(), config.clone());
        Ok(config)
    }

    async fn duplicate_connection_for_mcp(
        &self,
        source_id: &str,
        copy_id: &str,
        copy_name: &str,
    ) -> Result<ConnectionConfig, String> {
        let config = self.state.storage.duplicate_connection_for_mcp(source_id, copy_id, copy_name).await?;
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
        dbx_core::schema::list_tables_core(&self.state, &connection.id, database, schema, None, None, None, None, None)
            .await
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

    async fn list_routines(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        schema: &str,
        routine_types: Option<&[String]>,
    ) -> Result<Vec<dbx_core::db::ObjectInfo>, String> {
        let default_types = ["PROCEDURE".to_string(), "FUNCTION".to_string()];
        let object_types = routine_types.unwrap_or(default_types.as_slice());
        let objects = dbx_core::schema::list_objects_core(
            &self.state,
            &connection.id,
            database,
            schema,
            None,
            None,
            None,
            Some(object_types),
            None,
        )
        .await?;
        Ok(objects.into_iter().filter(|object| is_routine_object(&object.object_type)).collect())
    }

    async fn get_routine_source(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        schema: &str,
        name: &str,
        object_type: &str,
        signature: Option<&str>,
    ) -> Result<dbx_core::db::ObjectSource, String> {
        let kind = parse_routine_kind(object_type)?;
        dbx_core::schema::get_object_source_core(
            &self.state,
            &connection.id,
            database,
            schema,
            name,
            kind,
            signature,
            None,
        )
        .await
    }

    async fn collect_docs_snapshot(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        options: DocsSnapshotOptions,
    ) -> Result<dbx_core::docs::SchemaSnapshot, String> {
        let collect_options = dbx_core::docs::CollectOptions {
            database: database.to_string(),
            schemas: options.schemas,
            tables: options.tables,
            project_name: options.project_name.unwrap_or_else(|| connection.name.clone()),
        };
        dbx_core::docs::collect_snapshot(
            &self.state,
            connection,
            &collect_options,
            &|_progress| {},
            &std::sync::atomic::AtomicBool::new(false),
        )
        .await
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
        dbx_core::mongo_ops::execute_mongo_command_core(&self.state, &connection.id, database, command, 100).await
    }

    async fn close_client_session(
        &self,
        connection_id: &str,
        database: &str,
        client_session_id: &str,
    ) -> Result<bool, String> {
        let database = if database.trim().is_empty() { None } else { Some(database) };
        self.state.close_client_session_pool(connection_id, database, client_session_id).await
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

    async fn list_databases(&self, connection: &ConnectionConfig) -> Result<Vec<String>, String> {
        self.ensure_connected(connection).await?;
        match connection.db_type {
            DatabaseType::MongoDb => self
                .request(
                    reqwest::Method::POST,
                    "/api/mongo/list-databases",
                    Some(json!({ "connectionId": connection.id })),
                )
                .await?
                .json::<Vec<String>>()
                .await
                .map_err(|error| format!("Invalid MongoDB database list response: {error}")),
            DatabaseType::Redis => {
                let databases = self
                    .request(
                        reqwest::Method::POST,
                        "/api/redis/list-databases",
                        Some(json!({ "connectionId": connection.id })),
                    )
                    .await?
                    .json::<Vec<Value>>()
                    .await
                    .map_err(|error| format!("Invalid Redis database list response: {error}"))?;
                Ok(databases
                    .into_iter()
                    .filter_map(|database| {
                        database.get("db").and_then(Value::as_u64).map(|database| database.to_string())
                    })
                    .collect())
            }
            _ => self
                .request(
                    reqwest::Method::GET,
                    &format!("/api/schema/databases?connection_id={}", url_encode(&connection.id)),
                    None,
                )
                .await?
                .json::<Vec<dbx_core::db::DatabaseInfo>>()
                .await
                .map(|databases| databases.into_iter().map(|database| database.name).collect())
                .map_err(|error| format!("Invalid database list response: {error}")),
        }
    }

    async fn load_connection_group_paths(&self) -> Result<HashMap<String, Vec<String>>, String> {
        let layout = self
            .request(reqwest::Method::GET, "/api/layout/sidebar", None)
            .await?
            .json::<Option<Value>>()
            .await
            .map_err(|error| format!("Invalid sidebar layout response: {error}"))?;
        Ok(layout.map(connection_group_paths).unwrap_or_default())
    }

    async fn execute_agent_tool(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        tool_name: &str,
        arguments: Value,
        permissions: AgentSqlPermissions,
    ) -> ToolResult {
        let explicit_cell_window = QueryCellWindow::explicit_from_arguments(&arguments);
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

            // Replicate the confirmed-SQL binding check here because the
            // /api/query/execute endpoint performs its own risk checks but
            // does NOT receive the confirmed_write_sql binding from the MCP
            // layer.  Without this, a CLI/MCP agent could execute a different
            // write/DDL statement after a single user confirmation.
            let risk = dbx_core::sql_risk::classify_sql_risk_for_database(sql, connection.db_type)
                .map_err(|error| format!("SQL risk classification failed: {error}"))?;
            if risk != dbx_core::sql_risk::SqlRisk::ReadOnly {
                if let Some(ref confirmed) = permissions.confirmed_write_sql {
                    let normalized = agent_tools::normalize_sql_for_confirmation(sql);
                    let normalized_confirmed = agent_tools::normalize_sql_for_confirmation(confirmed);
                    if normalized != normalized_confirmed {
                        return Err(format!(
                            "Blocked: the executed SQL does not match the user-confirmed SQL.\n\
                             Confirmed: {}\n\
                             Attempted: {}",
                            confirmed, sql,
                        ));
                    }
                }
            }

            let max_rows = arguments.get("limit").and_then(Value::as_u64).unwrap_or(100) as usize;
            let mut body = json!({ "connectionId": connection.id, "database": database, "sql": sql });
            // Stateful MCP sessions pin every query to the same backend pool.
            if let Some(client_session_id) = arguments.get("client_session_id").and_then(Value::as_str) {
                body["clientSessionId"] = json!(client_session_id);
            }
            // The query timeout is resolved once here and carried on every
            // request: policy > connection effective timeout (see
            // `agent_query_timeout_secs`). `arguments["timeout_secs"]` holds the
            // global MCP policy value injected by the server; an absent value
            // means inherit the connection's setting.
            body["timeoutSecs"] = json!(agent_tools::agent_query_timeout_secs(
                arguments.get("timeout_secs").and_then(Value::as_u64),
                Some(connection),
            ));
            let response = self.request(reqwest::Method::POST, "/api/query/execute", Some(body)).await?;
            let query_result: dbx_core::db::QueryResult =
                response.json().await.map_err(|error| format!("Invalid query response: {error}"))?;
            match explicit_cell_window {
                Some(window) => format_query_result_as_text(&query_result, max_rows, window),
                None => Ok(format_query_result(&query_result, max_rows)),
            }
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

    #[cfg(feature = "mq-admin")]
    async fn send_message(
        &self,
        connection: &ConnectionConfig,
        request: dbx_core::mq::SendMessageRequest,
    ) -> Result<dbx_core::mq::SendMessageResponse, String> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct SendMessageBody {
            connection_id: String,
            req: dbx_core::mq::SendMessageRequest,
        }

        self.request(
            reqwest::Method::POST,
            "/api/mq/send-message",
            Some(json!(SendMessageBody { connection_id: connection.id.clone(), req: request })),
        )
        .await?
        .json()
        .await
        .map_err(|error| format!("Invalid message send response: {error}"))
    }

    async fn execute_query(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        sql: &str,
        _max_rows: Option<usize>,
        timeout_secs: Option<u64>,
    ) -> Result<dbx_core::db::QueryResult, String> {
        if connection.db_type == DatabaseType::MongoDb {
            return Err("MongoDB shell commands in DBX Web mode are not implemented by the Rust CLI yet.".to_string());
        }
        self.ensure_connected(connection).await?;
        self.request(
            reqwest::Method::POST,
            "/api/query/execute",
            Some(json!({ "connectionId": connection.id, "database": database, "sql": sql, "timeoutSecs": agent_tools::agent_query_timeout_secs(timeout_secs, Some(connection)) })),
        )
        .await?
        .json()
        .await
        .map_err(|error| format!("Invalid query response: {error}"))
    }

    async fn execute_batch(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        schema: Option<&str>,
        sql: &str,
        options: dbx_core::query::QueryExecutionOptions,
    ) -> Result<Vec<BatchStatementResult>, String> {
        if connection.db_type == DatabaseType::MongoDb {
            return Err("MongoDB batch execution in DBX Web mode is not implemented by the Rust CLI yet.".to_string());
        }
        self.ensure_connected(connection).await?;
        let mut body = json!({
            "connectionId": connection.id,
            "database": database,
            "sql": sql,
            // Keep Web-mode structured results within the MCP 100-row contract.
            "maxRows": options.max_rows,
            "timeoutSecs": agent_tools::agent_query_timeout_secs(options.timeout_secs, Some(connection)),
        });
        if let Some(schema) = schema.map(str::trim).filter(|schema| !schema.is_empty()) {
            body["schema"] = json!(schema);
        }
        if let Some(client_session_id) = options.client_session_id.as_deref().filter(|id| !id.trim().is_empty()) {
            body["clientSessionId"] = json!(client_session_id);
        }
        if options.continue_on_error {
            body["continueOnError"] = json!(true);
        }
        if options.use_transaction == Some(true) {
            body["useTransaction"] = json!(true);
        }
        let value: Value = self
            .request(reqwest::Method::POST, "/api/query/execute-multi", Some(body))
            .await?
            .json()
            .await
            .map_err(|error| format!("Invalid execute-multi response: {error}"))?;
        // Fail loudly on any element that does not match the expected envelope
        // instead of silently dropping statements from the batch.
        let results = value
            .as_array()
            .ok_or_else(|| "Invalid execute-multi response: expected an array of per-statement results".to_string())?
            .iter()
            .map(batch_statement_result_from_json)
            .collect::<Result<Vec<BatchStatementResult>, String>>()?;
        Ok(results)
    }

    async fn close_client_session(
        &self,
        connection_id: &str,
        database: &str,
        client_session_id: &str,
    ) -> Result<bool, String> {
        self.request(
            reqwest::Method::POST,
            "/api/query/close-client-session",
            Some(json!({
                "connectionId": connection_id,
                "database": database,
                "clientSessionId": client_session_id,
            })),
        )
        .await?
        .json()
        .await
        .map_err(|error| format!("Invalid close session response: {error}"))
    }

    async fn add_connection_for_mcp(&self, config: ConnectionConfig) -> Result<ConnectionConfig, String> {
        self.request(reqwest::Method::POST, "/api/connection/mcp/add", Some(json!({ "config": config })))
            .await?
            .json()
            .await
            .map_err(|error| format!("Invalid MCP connection response: {error}"))
    }

    async fn duplicate_connection_for_mcp(
        &self,
        source_id: &str,
        copy_id: &str,
        copy_name: &str,
    ) -> Result<ConnectionConfig, String> {
        self.request(
            reqwest::Method::POST,
            "/api/connection/mcp/duplicate",
            Some(json!({ "sourceId": source_id, "copyId": copy_id, "copyName": copy_name })),
        )
        .await?
        .json()
        .await
        .map_err(|error| format!("Invalid MCP connection response: {error}"))
    }

    async fn remove_connection_for_mcp(&self, connection_id: &str) -> Result<bool, String> {
        let removed = self
            .request(
                reqwest::Method::POST,
                "/api/connection/mcp/remove",
                Some(json!({ "connectionId": connection_id })),
            )
            .await?
            .json()
            .await
            .map_err(|error| format!("Invalid MCP connection response: {error}"))?;
        if removed {
            self.connected.lock().await.remove(connection_id);
        }
        Ok(removed)
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

    async fn list_routines(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        schema: &str,
        routine_types: Option<&[String]>,
    ) -> Result<Vec<dbx_core::db::ObjectInfo>, String> {
        self.ensure_connected(connection).await?;
        let types = routine_types.map(|types| types.join(",")).unwrap_or_else(|| "PROCEDURE,FUNCTION".to_string());
        self.request(
            reqwest::Method::GET,
            &format!(
                "/api/schema/objects?connection_id={}&database={}&schema={}&object_types={}",
                url_encode(&connection.id),
                url_encode(database),
                url_encode(schema),
                url_encode(&types)
            ),
            None,
        )
        .await?
        .json::<Vec<dbx_core::db::ObjectInfo>>()
        .await
        .map(|objects| objects.into_iter().filter(|object| is_routine_object(&object.object_type)).collect())
        .map_err(|error| format!("Invalid routine list response: {error}"))
    }

    async fn get_routine_source(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        schema: &str,
        name: &str,
        object_type: &str,
        signature: Option<&str>,
    ) -> Result<dbx_core::db::ObjectSource, String> {
        let kind = parse_routine_kind(object_type)?;
        let kind_name = match kind {
            dbx_core::db::ObjectSourceKind::Procedure => "PROCEDURE",
            dbx_core::db::ObjectSourceKind::Function => "FUNCTION",
            _ => unreachable!("parse_routine_kind only yields routines"),
        };
        self.ensure_connected(connection).await?;
        let mut query = format!(
            "/api/schema/object-source?connection_id={}&database={}&schema={}&table={}&object_type={}",
            url_encode(&connection.id),
            url_encode(database),
            url_encode(schema),
            url_encode(name),
            url_encode(kind_name),
        );
        if let Some(signature) = signature.filter(|value| !value.trim().is_empty()) {
            query.push_str(&format!("&signature={}", url_encode(signature)));
        }
        self.request(reqwest::Method::GET, &query, None)
            .await?
            .json()
            .await
            .map_err(|error| format!("Invalid routine source response: {error}"))
    }

    async fn collect_docs_snapshot(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        options: DocsSnapshotOptions,
    ) -> Result<dbx_core::docs::SchemaSnapshot, String> {
        self.ensure_connected(connection).await?;
        self.request(
            reqwest::Method::POST,
            "/api/docs/snapshot",
            Some(json!({
                "connectionId": connection.id,
                "database": database,
                "schemas": options.schemas,
                "tables": options.tables,
                "projectName": options.project_name.clone().unwrap_or_else(|| connection.name.clone()),
            })),
        )
        .await?
        .json()
        .await
        .map_err(|error| format!("Invalid docs snapshot response: {error}"))
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
            MongoCommand::ShowDatabases => {
                let result = self
                    .request(
                        reqwest::Method::POST,
                        "/api/mongo/run-command",
                        Some(json!({
                            "connectionId": connection_id,
                            "database": dbx_core::mongo_ops::MONGO_SHOW_DATABASES_DATABASE,
                            "commandJson": dbx_core::mongo_ops::MONGO_SHOW_DATABASES_COMMAND_JSON,
                        })),
                    )
                    .await?
                    .json::<WebMongoDocuments>()
                    .await
                    .map_err(|error| format!("Invalid MongoDB listDatabases response: {error}"))?;
                dbx_core::mongo_ops::mongo_show_databases_query_result(result.documents, 100)
            }
            MongoCommand::RunCommand { .. } => {
                Err("MongoDB runCommand is not available through the DBX MCP backend".to_string())
            }
            MongoCommand::Find { collection, filter, projection, sort, collation, skip, limit } => {
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
                            "collation": collation,
                        })),
                    )
                    .await?
                    .json::<WebMongoDocuments>()
                    .await
                    .map_err(|error| format!("Invalid MongoDB find response: {error}"))?;
                Ok(mongo_documents_query_result(result.documents))
            }
            MongoCommand::FindExplain { collection, filter, projection, sort, collation, skip, limit, verbosity } => {
                let result = self
                    .request(
                        reqwest::Method::POST,
                        "/api/mongo/explain-find",
                        Some(json!({
                            "connectionId": connection_id,
                            "database": database,
                            "collection": collection,
                            "skip": skip,
                            "limit": limit,
                            "filter": filter,
                            "projection": projection,
                            "sort": sort,
                            "collation": collation,
                            "verbosity": verbosity,
                        })),
                    )
                    .await?
                    .json::<Value>()
                    .await
                    .map_err(|error| format!("Invalid MongoDB explain response: {error}"))?;
                Ok(mongo_documents_query_result(vec![result]))
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
                let specs = self
                    .request(
                        reqwest::Method::POST,
                        "/api/mongo/list-index-specs",
                        Some(json!({
                            "connectionId": connection_id,
                            "database": database,
                            "collection": collection,
                        })),
                    )
                    .await?
                    .json::<Vec<MongoIndexSpec>>()
                    .await
                    .map_err(|error| format!("Invalid MongoDB index specs response: {error}"))?;
                Ok(dbx_core::mongo_ops::mongo_indexes_query_result(specs, 100))
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
            MongoCommand::CreateUser { user_json, write_concern_json } => {
                let value: Value = self
                    .request(
                        reqwest::Method::POST,
                        "/api/mongo/create-user",
                        Some(json!({
                            "connectionId": connection_id,
                            "database": database,
                            "userJson": user_json,
                            "writeConcernJson": write_concern_json,
                        })),
                    )
                    .await?
                    .json()
                    .await
                    .map_err(|error| format!("Invalid MongoDB create user response: {error}"))?;
                Ok(affected_query_result(affected_rows_from_value(&value)))
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
                    .map(str::to_string)
                    .collect::<Vec<_>>();
                let failures = value
                    .get("failures")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|failure| {
                        Some((
                            failure.get("name")?.as_str()?.to_string(),
                            failure.get("message")?.as_str()?.to_string(),
                        ))
                    })
                    .collect::<Vec<_>>();
                Ok(mongo_drop_indexes_query_result(dropped_names, failures, affected_rows_from_value(&value)))
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

/// Lowercased URL scheme: the part before the first `://` separator, with
/// surrounding whitespace trimmed. Input without a `://` separator yields the
/// whole trimmed, lowercased input.
fn normalize_scheme(base_url: &str) -> String {
    base_url.trim().split("://").next().unwrap_or_default().to_ascii_lowercase()
}

/// Resolves the standard proxy environment variables for a DBX Web backend.
///
/// Follows the conventional precedence: the scheme-specific variable
/// (`HTTPS_PROXY`/`https_proxy` for https URLs, `HTTP_PROXY`/`http_proxy`
/// for http URLs) wins, with `ALL_PROXY`/`all_proxy` as the fallback.
/// Empty values count as unset. `NO_PROXY`/`no_proxy` is returned alongside
/// so the client can bypass the proxy for matching hosts.
fn standard_web_proxy(base_url: &str) -> (Option<String>, Option<String>) {
    let http_proxy = first_non_empty_env(&["HTTP_PROXY", "http_proxy"]);
    let https_proxy = first_non_empty_env(&["HTTPS_PROXY", "https_proxy"]);
    let all_proxy = first_non_empty_env(&["ALL_PROXY", "all_proxy"]);
    (
        select_proxy_url(
            &normalize_scheme(base_url),
            http_proxy.as_deref(),
            https_proxy.as_deref(),
            all_proxy.as_deref(),
        ),
        first_non_empty_env(&["NO_PROXY", "no_proxy"]),
    )
}

/// Picks the proxy URL for a target scheme. The scheme-specific variable wins;
/// `ALL_PROXY` is the fallback. Empty or whitespace-only values count as unset.
/// `None` means "no proxy".
fn select_proxy_url(
    scheme: &str,
    http_proxy: Option<&str>,
    https_proxy: Option<&str>,
    all_proxy: Option<&str>,
) -> Option<String> {
    fn usable(value: Option<&str>) -> Option<&str> {
        value.map(str::trim).filter(|value| !value.is_empty())
    }
    match scheme {
        "http" => usable(http_proxy).or_else(|| usable(all_proxy)).map(ToOwned::to_owned),
        "https" => usable(https_proxy).or_else(|| usable(all_proxy)).map(ToOwned::to_owned),
        _ => None,
    }
}

fn first_non_empty_env(names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        std::env::var(name).ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
    })
}

/// Parses the `DBX_WEB_HEADERS` JSON object into a `HeaderMap`. Every parsed
/// header is attached to each DBX Web request, including auth checks.
fn parse_custom_headers(headers_json: Option<&str>) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    let Some(value) = headers_json.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(headers);
    };
    let entries: serde_json::Map<String, Value> = serde_json::from_str(value)
        .map_err(|error| format!("Invalid DBX_WEB_HEADERS: expected a JSON object, got {error}"))?;
    for (name, value) in entries {
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| format!("Invalid DBX_WEB_HEADERS header name: {name}"))?;
        // Names the client already manages internally (session cookie, request
        // marker) or that would corrupt the HTTP framing. Rejecting them
        // prevents duplicate/conflicting values on the wire.
        const RESERVED: [&str; 7] = [
            "cookie",
            "x-dbx-mcp-request",
            "host",
            "content-length",
            "connection",
            "transfer-encoding",
            "proxy-authorization",
        ];
        if RESERVED.iter().any(|reserved| header_name.as_str().eq_ignore_ascii_case(reserved)) {
            return Err(format!("Invalid DBX_WEB_HEADERS header name: {name} (reserved by DBX)"));
        }
        let Value::String(header_value) = value else {
            return Err(format!("Invalid DBX_WEB_HEADERS value for {name}: expected a string"));
        };
        let header_value = HeaderValue::from_str(&header_value)
            .map_err(|error| format!("Invalid DBX_WEB_HEADERS value for {name}: {error}"))?;
        headers.append(header_name, header_value);
    }
    Ok(headers)
}

fn url_encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

pub(crate) fn format_query_result(result: &dbx_core::db::QueryResult, max_rows: usize) -> String {
    let mut output = if result.columns.is_empty() {
        format!("Query executed. {} row(s) affected.", result.affected_rows)
    } else {
        let rows = result
            .rows
            .iter()
            .take(max_rows)
            .map(|row| row.iter().map(format_query_cell).collect::<Vec<_>>())
            .collect::<Vec<_>>();
        let mut output = markdown_table(&result.columns, &rows);
        output.push_str(&format!("\n\n{} row(s)", rows.len()));
        output
    };
    if !result.messages.is_empty() {
        output.push_str("\n\nServer messages:");
        for message in &result.messages {
            output.push_str(&format!("\n- {}", message.format_line()));
        }
    }
    output
}

fn query_result(columns: Vec<String>, rows: Vec<Vec<Value>>, affected_rows: u64) -> dbx_core::db::QueryResult {
    dbx_core::db::QueryResult {
        columns,
        column_types: Vec::new(),
        column_sortables: Vec::new(),
        spatial_columns: vec![],
        spatial_values: vec![],
        rows,
        affected_rows,
        execution_time_ms: 0,
        truncated: false,
        session_id: None,
        has_more: false,
        elasticsearch_raw_body: None,
        messages: Vec::new(),
    }
}

fn scalar_query_result(column: impl Into<String>, value: Value) -> dbx_core::db::QueryResult {
    query_result(vec![column.into()], vec![vec![value]], 0)
}

fn affected_query_result(affected_rows: u64) -> dbx_core::db::QueryResult {
    query_result(Vec::new(), Vec::new(), affected_rows)
}

fn mongo_drop_indexes_query_result(
    dropped_names: Vec<String>,
    failures: Vec<(String, String)>,
    affected_rows: u64,
) -> dbx_core::db::QueryResult {
    if failures.is_empty() {
        let rows = dropped_names.into_iter().map(|name| vec![Value::String(name)]).collect::<Vec<_>>();
        return query_result(if rows.is_empty() { Vec::new() } else { vec!["name".to_string()] }, rows, affected_rows);
    }

    let mut rows = dropped_names
        .into_iter()
        .map(|name| vec![Value::String(name), Value::String("dropped".to_string()), Value::Null])
        .collect::<Vec<_>>();
    rows.extend(
        failures.into_iter().map(|(name, message)| {
            vec![Value::String(name), Value::String("failed".to_string()), Value::String(message)]
        }),
    );
    query_result(vec!["name".to_string(), "status".to_string(), "message".to_string()], rows, affected_rows)
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
            resolved_schema: None,
            is_nullable: true,
            column_default: None,
            is_primary_key: false,
            is_unique: false,
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
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc,
        time::Duration,
    };

    fn policy_state(configured: bool, read_only: bool) -> McpGlobalPolicyState {
        McpGlobalPolicyState {
            configured,
            read_only,
            allow_dangerous_sql: false,
            allowed_connection_ids: None,
            allowed_tool_names: None,
            connection_policies: Vec::new(),
            query_timeout_secs: None,
        }
    }

    #[test]
    fn legacy_read_only_overrides_configured_and_unconfigured_policies() {
        // DBX_MCP_ALLOW_WRITES=0 always forces read_only, even when the
        // persistent MCP policy is configured as writable.
        assert!(effective_mcp_policy_with_legacy_allow_writes(policy_state(false, false), Some(false)).read_only);
        assert!(!effective_mcp_policy_with_legacy_allow_writes(policy_state(false, false), Some(true)).read_only);
        assert!(effective_mcp_policy_with_legacy_allow_writes(policy_state(true, false), Some(false)).read_only);
        assert!(!effective_mcp_policy_with_legacy_allow_writes(policy_state(true, false), Some(true)).read_only);
        // Configured read_only is a hard upper bound — env var cannot relax it.
        assert!(effective_mcp_policy_with_legacy_allow_writes(policy_state(true, true), Some(true)).read_only);
        assert!(effective_mcp_policy_with_legacy_allow_writes(policy_state(true, true), Some(false)).read_only);
        // Unset env var leaves the policy as-is.
        assert!(!effective_mcp_policy_with_legacy_allow_writes(policy_state(true, false), None).read_only);
        assert!(effective_mcp_policy_with_legacy_allow_writes(policy_state(true, true), None).read_only);
    }

    #[test]
    fn parses_database_type_using_dbx_protocol_names() {
        assert_eq!(parse_database_type("Postgres").unwrap(), DatabaseType::Postgres);
        assert_eq!(parse_database_type("mongodb").unwrap(), DatabaseType::MongoDb);
        assert!(parse_database_type("unknown").is_err());
    }

    #[test]
    fn parses_nested_current_and_legacy_connection_group_paths() {
        let paths = connection_group_paths(json!({
            "groups": [
                { "id": "project", "name": "Project" },
                { "id": "staging", "name": "Staging" },
                { "id": "legacy", "name": "Legacy" }
            ],
            "order": [
                {
                    "type": "group",
                    "id": "project",
                    "children": [
                        {
                            "type": "group",
                            "id": "staging",
                            "children": [{ "type": "connection", "id": "nested" }]
                        },
                        { "type": "connection", "id": "grouped" }
                    ]
                },
                { "type": "group", "id": "legacy", "connectionIds": ["legacy-connection"] },
                {
                    "type": "group",
                    "id": "missing-group",
                    "children": [{ "type": "connection", "id": "dangling" }]
                },
                { "type": "connection", "id": "root" }
            ]
        }));

        assert_eq!(paths.get("nested"), Some(&vec!["Project".to_string(), "Staging".to_string()]));
        assert_eq!(paths.get("grouped"), Some(&vec!["Project".to_string()]));
        assert_eq!(paths.get("legacy-connection"), Some(&vec!["Legacy".to_string()]));
        assert_eq!(paths.get("root"), Some(&Vec::new()));
        assert!(!paths.contains_key("dangling"));
    }

    #[test]
    fn malformed_sidebar_layout_has_no_group_paths() {
        assert!(connection_group_paths(json!({ "groups": "invalid", "order": [] })).is_empty());
    }

    #[tokio::test]
    async fn web_backend_loads_connection_group_paths_from_sidebar_layout() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (request_sender, request_receiver) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 1024];
            loop {
                let count = stream.read(&mut buffer).unwrap();
                request.extend_from_slice(&buffer[..count]);
                if count == 0 || request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            request_sender.send(String::from_utf8(request).unwrap().lines().next().unwrap().to_string()).unwrap();
            let body = r#"{"groups":[{"id":"project","name":"Project"}],"order":[{"type":"group","id":"project","children":[{"type":"connection","id":"web-db"}]}]}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });

        let backend = WebBackend::new(format!("http://{address}"), String::new(), None).unwrap();
        backend.auth.lock().await.checked = true;
        let paths = backend.load_connection_group_paths().await.unwrap();

        server.join().unwrap();
        assert_eq!(request_receiver.recv().unwrap(), "GET /api/layout/sidebar HTTP/1.1");
        assert_eq!(paths.get("web-db"), Some(&vec!["Project".to_string()]));
    }

    #[test]
    fn agent_query_timeout_web_policy_applies_over_connection_effective_timeout() {
        // Unset policy inherits the connection's effective timeout
        let mut conn = new_connection_config(
            "timeout".to_string(),
            "timeout".to_string(),
            DatabaseType::Postgres,
            "localhost".to_string(),
            5432,
            String::new(),
            String::new(),
            None,
            false,
            None,
        )
        .unwrap();
        conn.query_timeout_secs = 60;
        assert_eq!(agent_tools::agent_query_timeout_secs(None, Some(&conn)), 60);

        conn.query_timeout_secs = 0;
        assert_eq!(agent_tools::agent_query_timeout_secs(None, Some(&conn)), 0);

        // Policy 300 overrides both a 60 and a 0 connection.
        assert_eq!(agent_tools::agent_query_timeout_secs(Some(300), Some(&conn)), 300);

        // Spanner floor applies to a finite policy but not to 0.
        let mut spanner = new_connection_config(
            "spanner".to_string(),
            "spanner".to_string(),
            DatabaseType::Spanner,
            "localhost".to_string(),
            5432,
            String::new(),
            String::new(),
            None,
            false,
            None,
        )
        .unwrap();
        spanner.query_timeout_secs = 60;
        assert_eq!(agent_tools::agent_query_timeout_secs(Some(60), Some(&spanner)), 120);
        assert_eq!(agent_tools::agent_query_timeout_secs(Some(0), Some(&spanner)), 0);
        assert_eq!(agent_tools::agent_query_timeout_secs(None, Some(&spanner)), 120);
    }

    #[tokio::test]
    async fn web_execute_agent_tool_carries_resolved_timeout_secs_in_body() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (request_sender, request_receiver) = mpsc::channel();
        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut request = Vec::new();
                let mut buffer = [0_u8; 1024];
                let header_end = loop {
                    let count = stream.read(&mut buffer).unwrap();
                    request.extend_from_slice(&buffer[..count]);
                    if let Some(position) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                        break position + 4;
                    }
                };
                let headers = String::from_utf8_lossy(&request[..header_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length").then_some(value.trim())
                    })
                    .unwrap()
                    .parse::<usize>()
                    .unwrap();
                while request.len() < header_end + content_length {
                    let count = stream.read(&mut buffer).unwrap();
                    request.extend_from_slice(&buffer[..count]);
                }
                let request = String::from_utf8(request).unwrap();
                let body = request[header_end..header_end + content_length].to_string();
                request_sender.send((request.lines().next().unwrap().to_string(), body)).unwrap();

                let response_body = r#"{"columns":["?"],"column_types":[],"column_sortables":[],"rows":[["1"]],"affected_rows":0,"execution_time_ms":0,"truncated":false,"has_more":false}"#;
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    response_body.len(),
                    response_body
                )
                .unwrap();
            }
        });

        let backend = WebBackend::new(format!("http://{address}"), String::new(), None).unwrap();
        backend.auth.lock().await.checked = true;
        let mut connection = new_connection_config(
            "web-timeout".to_string(),
            "web-timeout".to_string(),
            DatabaseType::Postgres,
            "localhost".to_string(),
            5432,
            String::new(),
            String::new(),
            None,
            false,
            None,
        )
        .unwrap();
        connection.query_timeout_secs = 60;
        // ensure_connected only POSTs /api/connection/connect when the backend has
        // no cached config; pre-seed the cache so the mock needs to answer only the
        // /api/query/execute request.
        backend.connected.lock().await.insert(connection.id.clone(), connection.clone());

        // No policy argument -> inherit the connection's effective timeout (60).
        let result = backend
            .execute_agent_tool(
                &connection,
                "postgres",
                "execute_query",
                json!({ "sql": "SELECT 1", "limit": 10 }),
                AgentSqlPermissions { allow_writes: false, allow_dangerous: false, confirmed_write_sql: None },
            )
            .await;
        assert!(!result.is_error, "{:?}", result);
        let (request_line, body) = request_receiver.recv().unwrap();
        assert_eq!(request_line, "POST /api/query/execute HTTP/1.1");
        let request: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(request["timeoutSecs"], 60);

        // Policy argument 300 overrides the connection.
        let result = backend
            .execute_agent_tool(
                &connection,
                "postgres",
                "execute_query",
                json!({ "sql": "SELECT 1", "limit": 10, "timeout_secs": 300 }),
                AgentSqlPermissions { allow_writes: false, allow_dangerous: false, confirmed_write_sql: None },
            )
            .await;
        assert!(!result.is_error, "{:?}", result);

        server.join().unwrap();
        let (_request_line, second_body) = request_receiver.recv().unwrap();
        let second_request: Value = serde_json::from_str(&second_body).unwrap();
        assert_eq!(second_request["timeoutSecs"], 300);
    }

    #[tokio::test]
    async fn web_execute_batch_hits_execute_multi_and_decodes_statement_results() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (request_sender, request_receiver) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 1024];
            let header_end = loop {
                let count = stream.read(&mut buffer).unwrap();
                request.extend_from_slice(&buffer[..count]);
                if let Some(position) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                    break position + 4;
                }
            };
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length").then_some(value.trim())
                })
                .unwrap()
                .parse::<usize>()
                .unwrap();
            while request.len() < header_end + content_length {
                let count = stream.read(&mut buffer).unwrap();
                request.extend_from_slice(&buffer[..count]);
            }
            let request = String::from_utf8(request).unwrap();
            let body = request[header_end..header_end + content_length].to_string();
            request_sender.send((request.lines().next().unwrap().to_string(), body)).unwrap();

            let response_body = r#"[{"columns":["id"],"column_types":[],"column_sortables":[],"rows":[["1"],["2"]],"affected_rows":0,"execution_time_ms":1,"truncated":false,"has_more":false,"statement_index":0},{"columns":[],"column_types":[],"column_sortables":[],"rows":[],"affected_rows":2,"execution_time_ms":1,"truncated":false,"has_more":false,"statement_index":1}]"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            )
            .unwrap();
        });

        // The mock is a loopback server, so it must not inherit a contributor's
        // outbound proxy configuration.
        let backend = WebBackend::new_with_config(
            format!("http://{address}"),
            String::new(),
            None,
            None,
            None,
            None,
            false,
            None,
        )
        .unwrap();
        backend.auth.lock().await.checked = true;
        let connection = new_connection_config(
            "web-batch".to_string(),
            "web-batch".to_string(),
            DatabaseType::Postgres,
            "localhost".to_string(),
            5432,
            String::new(),
            String::new(),
            None,
            false,
            None,
        )
        .unwrap();
        // Pre-seed so the mock only needs to answer /api/query/execute-multi.
        backend.connected.lock().await.insert(connection.id.clone(), connection.clone());

        let results = backend
            .execute_batch(
                &connection,
                "postgres",
                None,
                "SELECT 1; INSERT INTO t VALUES (1)",
                dbx_core::query::QueryExecutionOptions {
                    max_rows: Some(100),
                    timeout_secs: Some(0),
                    continue_on_error: true,
                    use_transaction: Some(true),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        assert_eq!(results.len(), 2);
        // Two metadata fields are transferred from the JSON envelope.
        assert_eq!(results[0].result.columns, vec!["id".to_string()]);
        assert_eq!(results[0].result.rows.len(), 2);
        assert_eq!(results[1].statement_index, Some(1));
        assert_eq!(results[1].result.affected_rows, 2);

        let (request_line, body) = request_receiver.recv().unwrap();
        assert_eq!(request_line, "POST /api/query/execute-multi HTTP/1.1");
        let request: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(request["sql"], "SELECT 1; INSERT INTO t VALUES (1)");
        assert_eq!(request["continueOnError"], true);
        assert_eq!(request["useTransaction"], true);
        assert_eq!(request["maxRows"], 100);
        assert_eq!(request["timeoutSecs"], 0);

        server.join().unwrap();
    }

    #[test]
    fn format_query_result_appends_server_messages() {
        let mut result = query_result(Vec::new(), Vec::new(), 3);
        assert_eq!(format_query_result(&result, 100), "Query executed. 3 row(s) affected.");

        result.messages = vec![
            dbx_core::db::QueryMessage {
                severity: "notice".to_string(),
                message: "hello world".to_string(),
                code: Some("00000".to_string()),
                detail: None,
                hint: Some("use a table".to_string()),
            },
            dbx_core::db::QueryMessage {
                severity: "WARNING".to_string(),
                message: "careful".to_string(),
                code: None,
                detail: None,
                hint: None,
            },
        ];
        assert_eq!(
            format_query_result(&result, 100),
            "Query executed. 3 row(s) affected.\n\nServer messages:\n- NOTICE: hello world (code: 00000, hint: use a table)\n- WARNING: careful"
        );
    }

    #[test]
    fn mongo_drop_indexes_query_result_preserves_partial_failures() {
        let result = mongo_drop_indexes_query_result(
            vec!["email_1".to_string()],
            vec![("missing_1".to_string(), "index not found".to_string())],
            1,
        );

        assert_eq!(result.columns, ["name", "status", "message"]);
        assert_eq!(
            result.rows,
            [
                vec![Value::String("email_1".to_string()), Value::String("dropped".to_string()), Value::Null],
                vec![
                    Value::String("missing_1".to_string()),
                    Value::String("failed".to_string()),
                    Value::String("index not found".to_string()),
                ],
            ]
        );
        assert_eq!(result.affected_rows, 1);
    }

    #[tokio::test]
    async fn web_mongo_get_indexes_uses_list_index_specs_endpoint() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (request_sender, request_receiver) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 1024];
            let header_end = loop {
                let count = stream.read(&mut buffer).unwrap();
                request.extend_from_slice(&buffer[..count]);
                if let Some(position) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                    break position + 4;
                }
            };
            let request_text = String::from_utf8_lossy(&request);
            let request_line = request_text.lines().next().unwrap().to_string();
            let content_length = request_text
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length").then_some(value.trim())
                })
                .unwrap()
                .parse::<usize>()
                .unwrap();
            while request.len() < header_end + content_length {
                let count = stream.read(&mut buffer).unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..count]);
            }
            let request_body = String::from_utf8_lossy(&request[header_end..]).to_string();
            request_sender.send((request_line.clone(), request_body)).unwrap();
            let body = r#"[
                {
                    "name": "_id_",
                    "keys": [{"field": "_id", "direction": "1"}],
                    "is_unique": true,
                    "is_primary": true,
                    "is_sparse": false,
                    "expire_after_seconds": null,
                    "partial_filter_expression": null,
                    "background": false,
                    "bucket_size": null,
                    "hidden": false,
                    "properties_complete": true,
                    "extra_options": null
                },
                {
                    "name": "createdAt_1",
                    "keys": [{"field": "createdAt", "direction": "1"}],
                    "is_unique": false,
                    "is_primary": false,
                    "is_sparse": false,
                    "expire_after_seconds": 3600,
                    "partial_filter_expression": null,
                    "background": false,
                    "bucket_size": null,
                    "hidden": false,
                    "properties_complete": true,
                    "extra_options": null
                }
            ]"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });

        let backend = WebBackend::new(format!("http://{address}"), String::new(), None).unwrap();
        backend.auth.lock().await.checked = true;
        let connection = new_connection_config(
            "legacy".to_string(),
            "Legacy MongoDB".to_string(),
            DatabaseType::MongoDb,
            "localhost".to_string(),
            27017,
            String::new(),
            String::new(),
            Some("app".to_string()),
            false,
            Some("mongodb-legacy".to_string()),
        )
        .unwrap();
        backend.connected.lock().await.insert(connection.id.clone(), connection.clone());

        let result = backend
            .execute_mongo_command(&connection, "app", &MongoCommand::GetIndexes { collection: "im_msg".to_string() })
            .await
            .unwrap();

        server.join().unwrap();
        let (request_line, request_body) = request_receiver.recv().unwrap();
        assert_eq!(request_line, "POST /api/mongo/list-index-specs HTTP/1.1");
        let request_json: Value = serde_json::from_str(&request_body).unwrap();
        assert_eq!(request_json, json!({"connectionId": "legacy", "database": "app", "collection": "im_msg"}));
        assert_eq!(result.columns, ["name", "columns", "unique", "primary", "type", "filter", "expireAfterSeconds"]);
        assert_eq!(
            result.rows,
            [
                vec![
                    Value::String("_id_".to_string()),
                    Value::String("_id".to_string()),
                    Value::Bool(true),
                    Value::Bool(true),
                    Value::String("_id: 1".to_string()),
                    Value::Null,
                    Value::Null,
                ],
                vec![
                    Value::String("createdAt_1".to_string()),
                    Value::String("createdAt".to_string()),
                    Value::Bool(false),
                    Value::Bool(false),
                    Value::String("createdAt: 1".to_string()),
                    Value::Null,
                    Value::from(3600),
                ],
            ]
        );
        assert_eq!(result.affected_rows, 2);
    }

    #[tokio::test]
    async fn web_mongo_show_databases_uses_one_admin_read_command() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (request_sender, request_receiver) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 1024];
            let header_end = loop {
                let count = stream.read(&mut buffer).unwrap();
                request.extend_from_slice(&buffer[..count]);
                if let Some(position) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                    break position + 4;
                }
            };
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length").then_some(value.trim())
                })
                .unwrap()
                .parse::<usize>()
                .unwrap();
            while request.len() < header_end + content_length {
                let count = stream.read(&mut buffer).unwrap();
                request.extend_from_slice(&buffer[..count]);
            }
            let request = String::from_utf8(request).unwrap();
            request_sender
                .send((
                    request.lines().next().unwrap().to_string(),
                    request[header_end..header_end + content_length].to_string(),
                ))
                .unwrap();

            let response_body = r#"{"documents":[{"databases":[{"name":"admin","sizeOnDisk":40960,"empty":false},{"name":"app","sizeOnDisk":8192,"empty":true}],"ok":1}]}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            )
            .unwrap();
        });

        let backend = WebBackend::new(format!("http://{address}"), String::new(), None).unwrap();
        backend.auth.lock().await.checked = true;
        let connection = new_connection_config(
            "legacy".to_string(),
            "Legacy MongoDB".to_string(),
            DatabaseType::MongoDb,
            "localhost".to_string(),
            27017,
            String::new(),
            String::new(),
            Some("app".to_string()),
            false,
            Some("mongodb-legacy".to_string()),
        )
        .unwrap();
        backend.connected.lock().await.insert(connection.id.clone(), connection.clone());

        let result = backend.execute_mongo_command(&connection, "app", &MongoCommand::ShowDatabases).await.unwrap();

        server.join().unwrap();
        let (request_line, body) = request_receiver.recv().unwrap();
        assert_eq!(request_line, "POST /api/mongo/run-command HTTP/1.1");
        let request: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(request["connectionId"], "legacy");
        assert_eq!(request["database"], "admin");
        assert_eq!(request["commandJson"], r#"{"listDatabases":1}"#);
        assert_eq!(result.columns, ["name", "sizeOnDisk", "empty"]);
        assert_eq!(result.rows.len(), 2);
        assert_eq!(result.affected_rows, 2);
    }

    #[tokio::test]
    async fn web_mongo_find_explain_uses_explain_endpoint_and_preserves_options() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (request_sender, request_receiver) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 1024];
            let header_end = loop {
                let count = stream.read(&mut buffer).unwrap();
                request.extend_from_slice(&buffer[..count]);
                if let Some(position) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                    break position + 4;
                }
            };
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length").then_some(value.trim())
                })
                .unwrap()
                .parse::<usize>()
                .unwrap();
            while request.len() < header_end + content_length {
                let count = stream.read(&mut buffer).unwrap();
                request.extend_from_slice(&buffer[..count]);
            }
            let request = String::from_utf8(request).unwrap();
            let body = request[header_end..header_end + content_length].to_string();
            request_sender.send((request.lines().next().unwrap().to_string(), body)).unwrap();

            let response_body = r#"{"queryPlanner":{"winningPlan":{"stage":"COLLSCAN"}}}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            )
            .unwrap();
        });

        let backend = WebBackend::new(format!("http://{address}"), String::new(), None).unwrap();
        backend.auth.lock().await.checked = true;
        let connection = new_connection_config(
            "legacy".to_string(),
            "Legacy MongoDB".to_string(),
            DatabaseType::MongoDb,
            "localhost".to_string(),
            27017,
            String::new(),
            String::new(),
            Some("app".to_string()),
            false,
            Some("mongodb-legacy".to_string()),
        )
        .unwrap();
        backend.connected.lock().await.insert(connection.id.clone(), connection.clone());

        let command = MongoCommand::FindExplain {
            collection: "im_msg".to_string(),
            filter: r#"{"active":true}"#.to_string(),
            projection: Some(r#"{"email":1}"#.to_string()),
            sort: Some(r#"{"email":1}"#.to_string()),
            collation: Some(r#"{"locale":"en","strength":1}"#.to_string()),
            skip: 2,
            limit: 5,
            verbosity: "executionStats".to_string(),
        };
        let result = backend.execute_mongo_command(&connection, "app", &command).await.unwrap();

        server.join().unwrap();
        let (request_line, body) = request_receiver.recv().unwrap();
        assert_eq!(request_line, "POST /api/mongo/explain-find HTTP/1.1");
        let request: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(request["connectionId"], "legacy");
        assert_eq!(request["database"], "app");
        assert_eq!(request["collection"], "im_msg");
        assert_eq!(request["skip"], 2);
        assert_eq!(request["limit"], 5);
        assert_eq!(request["filter"], r#"{"active":true}"#);
        assert_eq!(request["projection"], r#"{"email":1}"#);
        assert_eq!(request["sort"], r#"{"email":1}"#);
        assert_eq!(request["collation"], r#"{"locale":"en","strength":1}"#);
        assert_eq!(request["verbosity"], "executionStats");
        assert_eq!(result.columns, ["queryPlanner"]);
        assert_eq!(result.rows.len(), 1);
    }

    #[test]
    fn standard_web_proxy_follows_scheme_precedence_and_ignores_empty_values() {
        // https target: HTTPS_PROXY wins over ALL_PROXY.
        assert_eq!(
            select_proxy_url("https", Some("http://http-proxy"), Some("http://https-proxy"), Some("socks5://all")),
            Some("http://https-proxy".to_string())
        );
        // https target without HTTPS_PROXY: ALL_PROXY is the fallback.
        assert_eq!(
            select_proxy_url("https", Some("http://http-proxy"), None, Some("socks5://all")),
            Some("socks5://all".to_string())
        );
        // https target with only HTTP_PROXY: no proxy (HTTP_PROXY is not a fallback for https).
        assert_eq!(select_proxy_url("https", Some("http://http-proxy"), None, None), None);
        // http target: HTTP_PROXY wins.
        assert_eq!(
            select_proxy_url("http", Some("http://http-proxy"), Some("http://https-proxy"), Some("socks5://all")),
            Some("http://http-proxy".to_string())
        );
        // No proxy configured at all.
        assert_eq!(select_proxy_url("http", None, None, None), None);
        // Unsupported scheme: never proxied.
        assert_eq!(select_proxy_url("ftp", None, None, Some("http://all")), None);

        // Empty values behave like unset: no proxy, not an error.
        assert_eq!(select_proxy_url("https", None, Some(""), None), None);
        assert_eq!(select_proxy_url("https", None, Some("  "), Some("")), None);
    }

    #[test]
    fn normalize_scheme_lowercases_and_trims() {
        assert_eq!(normalize_scheme("https://host"), "https");
        assert_eq!(normalize_scheme("HTTPS://host"), "https");
        assert_eq!(normalize_scheme("  http://host  "), "http");
        assert_eq!(normalize_scheme("no-scheme"), "no-scheme");
        assert_eq!(normalize_scheme(""), "");
    }

    #[tokio::test]
    async fn web_backend_bypasses_proxy_for_no_proxy_hosts() {
        let proxy_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let proxy_address = proxy_listener.local_addr().unwrap();
        let unused = TcpListener::bind("127.0.0.1:0").unwrap();
        let base_address = unused.local_addr().unwrap();
        let base_url = format!("http://{base_address}");
        drop(unused);

        let backend = WebBackend::new_with_config(
            base_url,
            String::new(),
            None,
            Some(format!("http://{proxy_address}")),
            // Target host matches NO_PROXY: the request must go direct.
            Some("127.0.0.1".to_string()),
            None,
            false,
            None,
        )
        .unwrap();
        backend.auth.lock().await.checked = true;

        // Direct connection to the closed port fails; the proxy must never see
        // the request.
        let error = backend.load_connections().await.unwrap_err();
        assert!(error.contains("API request /api/connection/list"), "{error}");

        proxy_listener.set_nonblocking(true).unwrap();
        assert!(matches!(
            proxy_listener.accept(),
            Err(connection_error) if connection_error.kind() == std::io::ErrorKind::WouldBlock
        ));
    }

    #[tokio::test]
    async fn web_backend_applies_custom_headers_to_auth_and_api_requests() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (request_sender, request_receiver) = mpsc::channel();
        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut request = Vec::new();
                let mut buffer = [0_u8; 1024];
                loop {
                    let count = stream.read(&mut buffer).unwrap();
                    request.extend_from_slice(&buffer[..count]);
                    if count == 0 || request.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                let request = String::from_utf8(request).unwrap();
                request_sender.send(request.clone()).unwrap();
                let body = if request.starts_with("GET /api/auth/check ") {
                    r#"{"authenticated":true,"required":false,"setup_required":false}"#
                } else {
                    "[]"
                };
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
            }
        });

        let backend = WebBackend::new_with_config(
            format!("http://{address}"),
            String::new(),
            None,
            None,
            None,
            Some(r#"{"X-API-Key":"secret","X-Tenant":"acme"}"#.to_string()),
            false,
            None,
        )
        .unwrap();

        let connections = backend.load_connections().await.unwrap();
        assert!(connections.is_empty());
        server.join().unwrap();

        let auth_check = request_receiver.recv().unwrap().to_ascii_lowercase();
        assert!(auth_check.starts_with("get /api/auth/check "), "{auth_check}");
        assert!(auth_check.contains("x-api-key: secret"), "{auth_check}");
        assert!(auth_check.contains("x-tenant: acme"), "{auth_check}");

        let list = request_receiver.recv().unwrap().to_ascii_lowercase();
        assert!(list.starts_with("get /api/connection/list "), "{list}");
        assert!(list.contains("x-api-key: secret"), "{list}");
        assert!(list.contains("x-tenant: acme"), "{list}");
        assert!(list.contains("x-dbx-mcp-request: 1"), "{list}");
    }

    #[test]
    fn web_backend_debug_redacts_custom_header_values() {
        let backend = WebBackend::new_with_config(
            "http://127.0.0.1:8976".to_string(),
            "super-secret-password".to_string(),
            None,
            None,
            None,
            Some(r#"{"Authorization":"Bearer secret-token","X-Tenant":"acme"}"#.to_string()),
            false,
            None,
        )
        .unwrap();

        let debug = format!("{backend:?}");
        assert!(debug.contains("authorization"));
        assert!(debug.contains("x-tenant"));
        assert!(!debug.contains("secret-token"));
        assert!(!debug.contains("Bearer"));
        assert!(!debug.contains("super-secret-password"));
    }

    #[tokio::test]
    async fn web_backend_routes_requests_through_proxy() {
        let proxy_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let proxy_address = proxy_listener.local_addr().unwrap();
        // Port that is guaranteed closed: if the proxy is not used, the direct
        // connection to this address fails and the test fails.
        let unused = TcpListener::bind("127.0.0.1:0").unwrap();
        let base_address = unused.local_addr().unwrap();
        let base_url = format!("http://{base_address}");
        drop(unused);

        let (request_sender, request_receiver) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = proxy_listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 1024];
            loop {
                let count = stream.read(&mut buffer).unwrap();
                request.extend_from_slice(&buffer[..count]);
                if count == 0 || request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let request = String::from_utf8(request).unwrap();
            request_sender.send(request.lines().next().unwrap().to_string()).unwrap();
            let body = "[]";
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });

        let backend = WebBackend::new_with_config(
            base_url,
            String::new(),
            None,
            Some(format!("http://{proxy_address}")),
            None,
            None,
            false,
            None,
        )
        .unwrap();
        backend.auth.lock().await.checked = true;

        let connections = backend.load_connections().await.unwrap();
        assert!(connections.is_empty());
        server.join().unwrap();

        // HTTP proxies receive the request in absolute-form, proving the
        // request went through the proxy instead of straight to the target.
        let request_line = request_receiver.recv().unwrap();
        assert!(request_line.starts_with(&format!("GET http://{base_address}/api/connection/list ")), "{request_line}");
    }

    #[tokio::test]
    async fn web_backend_authenticates_against_proxy_from_url_credentials() {
        let proxy_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let proxy_address = proxy_listener.local_addr().unwrap();
        let unused = TcpListener::bind("127.0.0.1:0").unwrap();
        let base_address = unused.local_addr().unwrap();
        let base_url = format!("http://{base_address}");
        drop(unused);

        let (request_sender, request_receiver) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = proxy_listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 1024];
            loop {
                let count = stream.read(&mut buffer).unwrap();
                request.extend_from_slice(&buffer[..count]);
                if count == 0 || request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let request = String::from_utf8(request).unwrap();
            request_sender.send(request.clone()).unwrap();
            let body = "[]";
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });

        // Credentials embedded in the proxy URL become Proxy-Authorization.
        let backend = WebBackend::new_with_config(
            base_url,
            String::new(),
            None,
            Some(format!("http://admin:admin123@{proxy_address}")),
            None,
            None,
            false,
            None,
        )
        .unwrap();
        backend.auth.lock().await.checked = true;

        let connections = backend.load_connections().await.unwrap();
        assert!(connections.is_empty());
        server.join().unwrap();

        let request = request_receiver.recv().unwrap().to_ascii_lowercase();
        assert!(request.starts_with(&format!("get http://{base_address}/api/connection/list ")), "{request}");
        // base64("admin:admin123") = YWRtaW46YWRtaW4xMjM=
        assert!(request.contains("proxy-authorization: basic ywrtaw46ywrtaw4xmjm="), "{request}");
    }

    #[test]
    fn web_backend_rejects_invalid_proxy_and_header_config() {
        let error = WebBackend::new_with_config(
            "http://127.0.0.1:1".to_string(),
            String::new(),
            None,
            Some("not a url".to_string()),
            None,
            None,
            false,
            None,
        )
        .unwrap_err();
        assert!(error.contains("HTTP(S)_PROXY"), "{error}");

        let error = WebBackend::new_with_config(
            "http://127.0.0.1:1".to_string(),
            String::new(),
            None,
            None,
            None,
            Some("not json".to_string()),
            false,
            None,
        )
        .unwrap_err();
        assert!(error.contains("DBX_WEB_HEADERS"), "{error}");

        let error = WebBackend::new_with_config(
            "http://127.0.0.1:1".to_string(),
            String::new(),
            None,
            None,
            None,
            Some(r#"{"Bad Header Name":"v"}"#.to_string()),
            false,
            None,
        )
        .unwrap_err();
        assert!(error.contains("header name"), "{error}");

        let error = WebBackend::new_with_config(
            "http://127.0.0.1:1".to_string(),
            String::new(),
            None,
            None,
            None,
            Some(r#"{"X-Num":42}"#.to_string()),
            false,
            None,
        )
        .unwrap_err();
        assert!(error.contains("expected a string"), "{error}");

        // Reserved headers that DBX manages internally are rejected.
        let error = WebBackend::new_with_config(
            "http://127.0.0.1:1".to_string(),
            String::new(),
            None,
            None,
            None,
            Some(r#"{"Cookie":"session=1"}"#.to_string()),
            false,
            None,
        )
        .unwrap_err();
        assert!(error.contains("reserved by DBX"), "{error}");

        let error = WebBackend::new_with_config(
            "http://127.0.0.1:1".to_string(),
            String::new(),
            None,
            None,
            None,
            Some(r#"{"x-dbx-mcp-request":"1"}"#.to_string()),
            false,
            None,
        )
        .unwrap_err();
        assert!(error.contains("reserved by DBX"), "{error}");
    }

    /// Starts a TLS server with a freshly generated self-signed certificate
    /// for 127.0.0.1, answering the DBX Web auth/check + connection/list
    /// endpoints. Returns (base_url, ca_pem_path, tempdir) — the caller must
    /// hold the tempdir so the certificate file stays readable for the test.
    async fn spawn_self_signed_https_server() -> (String, std::path::PathBuf, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let ca_key = dir.path().join("ca.key");
        let ca_pem = dir.path().join("ca.pem");
        let server_key = dir.path().join("server.key");
        let server_csr = dir.path().join("server.csr");
        let server_pem = dir.path().join("server.pem");
        let run = |args: &[&str]| {
            let status = std::process::Command::new("openssl")
                .args(args)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap();
            let output = std::process::Command::new("openssl").args(args).output().unwrap();
            assert!(
                output.status.success(),
                "openssl failed: {args:?} stderr={}",
                String::from_utf8_lossy(&output.stderr)
            );
            let _ = status;
        };
        // Self-signed CA.
        run(&[
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            ca_key.to_str().unwrap(),
            "-out",
            ca_pem.to_str().unwrap(),
            "-subj",
            "/CN=DBX Test CA",
            "-days",
            "1",
            "-addext",
            "basicConstraints=critical,CA:TRUE",
        ]);
        // Server key + CSR.
        run(&[
            "req",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            server_key.to_str().unwrap(),
            "-out",
            server_csr.to_str().unwrap(),
            "-subj",
            "/CN=127.0.0.1",
        ]);
        // Server cert signed by the CA, with SAN for 127.0.0.1. The x509 -req
        // subcommand takes extensions via -extfile, not -addext.
        let ext_path = dir.path().join("server.ext");
        std::fs::write(&ext_path, "subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\n").unwrap();
        run(&[
            "x509",
            "-req",
            "-in",
            server_csr.to_str().unwrap(),
            "-CA",
            ca_pem.to_str().unwrap(),
            "-CAkey",
            ca_key.to_str().unwrap(),
            "-CAcreateserial",
            "-out",
            server_pem.to_str().unwrap(),
            "-days",
            "1",
            "-extfile",
            ext_path.to_str().unwrap(),
        ]);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        // Read certificate material before moving into the server task: the
        // tempdir is dropped when this function returns, deleting the files.
        let server_cert_bytes = std::fs::read(&server_pem).unwrap();
        let server_key_bytes = std::fs::read(&server_key).unwrap();
        tokio::spawn(async move {
            use std::io::BufReader;
            use tokio::io::{AsyncReadExt, AsyncWriteExt};

            let certs: Vec<rustls::pki_types::CertificateDer<'static>> = {
                let mut reader = BufReader::new(&server_cert_bytes[..]);
                rustls_pemfile::certs(&mut reader).collect::<Result<_, _>>().unwrap()
            };
            let key = {
                let mut reader = BufReader::new(&server_key_bytes[..]);
                rustls_pemfile::private_key(&mut reader).unwrap().unwrap()
            };
            // A single default provider avoids the "could not automatically
            // determine the process-level CryptoProvider" panic in workspace
            // builds where multiple rustls crypto features are present.
            let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
            let config = rustls::ServerConfig::builder().with_no_client_auth().with_single_cert(certs, key).unwrap();
            let acceptor = tokio_rustls::TlsAcceptor::from(std::sync::Arc::new(config));

            let (stream, _) = listener.accept().await.unwrap();
            let mut tls = acceptor.accept(stream).await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 1024];
            loop {
                let count = tls.read(&mut buffer).await.unwrap();
                request.extend_from_slice(&buffer[..count]);
                if count == 0 || request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let request = String::from_utf8(request).unwrap();
            let body = if request.contains("/api/auth/check") {
                r#"{"authenticated":true,"required":false,"setup_required":false}"#
            } else {
                "[]"
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            tls.write_all(response.as_bytes()).await.unwrap();
        });

        (format!("https://{address}"), ca_pem, dir)
    }

    #[tokio::test]
    async fn web_backend_rejects_self_signed_certificate_by_default() {
        let (base_url, _cert, _dir) = spawn_self_signed_https_server().await;
        let backend =
            WebBackend::new_with_config(base_url, String::new(), None, None, None, None, false, None).unwrap();
        backend.auth.lock().await.checked = true;

        let error = backend.load_connections().await.unwrap_err();
        // Verification is on by default: the self-signed chain is rejected.
        assert!(error.contains("API request /api/connection/list failed"), "{error}");
    }

    #[tokio::test]
    async fn web_backend_skips_verification_when_configured() {
        let (base_url, _cert, _dir) = spawn_self_signed_https_server().await;
        let backend = WebBackend::new_with_config(base_url, String::new(), None, None, None, None, true, None).unwrap();
        backend.auth.lock().await.checked = true;

        let connections = backend.load_connections().await.unwrap();
        assert!(connections.is_empty());
    }

    #[tokio::test]
    async fn web_backend_trusts_custom_ca_certificate() {
        let (base_url, ca_pem, _dir) = spawn_self_signed_https_server().await;
        let backend = WebBackend::new_with_config(
            base_url,
            String::new(),
            None,
            None,
            None,
            None,
            false,
            Some(ca_pem.to_str().unwrap().to_string()),
        )
        .unwrap();
        backend.auth.lock().await.checked = true;

        let connections = backend.load_connections().await.unwrap();
        assert!(connections.is_empty());
    }

    #[tokio::test]
    async fn local_backend_uses_desktop_plugin_directory() {
        let data_dir = tempfile::tempdir().unwrap();
        let database_path = data_dir.path().join("dbx.db");
        let jdbc_plugin_dir = data_dir.path().join("plugins").join("jdbc");
        std::fs::create_dir_all(&jdbc_plugin_dir).unwrap();
        std::fs::write(
            jdbc_plugin_dir.join("manifest.json"),
            r#"{
                "id": "jdbc",
                "name": "DBX JDBC Plugin",
                "drivers": [{
                    "id": "jdbc",
                    "label": "JDBC",
                    "kind": "external",
                    "database_type": "jdbc"
                }]
            }"#,
        )
        .unwrap();
        let storage = Storage::open(&database_path).await.unwrap();
        drop(storage);

        let backend = LocalBackend::open(&database_path).await.unwrap();

        assert_eq!(backend.state().plugins.root_dir(), data_dir.path().join("plugins"));
        assert!(backend.state().plugins.find_driver("jdbc").unwrap().is_some());
    }

    #[tokio::test]
    async fn local_backend_uses_desktop_agent_directory() {
        let data_dir = tempfile::tempdir().unwrap();
        let database_path = data_dir.path().join("dbx.db");
        let agent_dir = data_dir.path().join("agents-custom");
        let storage = Storage::open(&database_path).await.unwrap();
        storage
            .save_desktop_settings(&DesktopSettings {
                agent_store_dir: Some(agent_dir.to_string_lossy().to_string()),
                ..DesktopSettings::default()
            })
            .await
            .unwrap();
        drop(storage);

        let backend = LocalBackend::open(&database_path).await.unwrap();

        assert_eq!(backend.state().agent_manager.base_dir(), &agent_dir);
    }

    #[test]
    fn local_plugin_directory_honors_desktop_storage_settings() {
        let data_dir = Path::new("C:/Users/user/AppData/Roaming/com.dbx.app");
        let explicit = DesktopSettings {
            plugin_store_dir: Some("D:/DBX/plugins-custom".to_string()),
            ..DesktopSettings::default()
        };
        let legacy =
            DesktopSettings { driver_store_dir: Some("D:/DBX/drivers".to_string()), ..DesktopSettings::default() };

        assert_eq!(local_plugin_dir(&explicit, data_dir), PathBuf::from("D:/DBX/plugins-custom"));
        assert_eq!(local_plugin_dir(&legacy, data_dir), PathBuf::from("D:/DBX/drivers/plugins"));
    }

    #[test]
    fn local_agent_directory_honors_desktop_storage_settings() {
        let data_dir = Path::new("C:/Users/user/AppData/Roaming/com.dbx.app");
        let explicit =
            DesktopSettings { agent_store_dir: Some("D:/DBX/agents-custom".to_string()), ..DesktopSettings::default() };
        let legacy = DesktopSettings { driver_store_dir: Some("D:/DBX/drivers".to_string()), ..Default::default() };

        assert_eq!(local_agent_dir(&explicit, data_dir), PathBuf::from("D:/DBX/agents-custom"));
        assert_eq!(local_agent_dir(&legacy, data_dir), PathBuf::from("D:/DBX/drivers/agents"));
    }

    struct StubBackend;

    #[async_trait]
    impl DbxBackend for StubBackend {
        async fn load_mcp_global_policy(&self) -> Result<McpGlobalPolicy, String> {
            Err("unused".to_string())
        }
        async fn load_connections(&self) -> Result<Vec<ConnectionConfig>, String> {
            Ok(vec![])
        }
        async fn execute_agent_tool(
            &self,
            _connection: &ConnectionConfig,
            _database: &str,
            _tool_name: &str,
            _arguments: Value,
            _permissions: AgentSqlPermissions,
        ) -> ToolResult {
            unimplemented!("not exercised by this test")
        }
        async fn add_connection_for_mcp(&self, config: ConnectionConfig) -> Result<ConnectionConfig, String> {
            Ok(config)
        }
        async fn duplicate_connection_for_mcp(
            &self,
            _source_id: &str,
            _copy_id: &str,
            _copy_name: &str,
        ) -> Result<ConnectionConfig, String> {
            Err("unused".to_string())
        }
        async fn remove_connection_for_mcp(&self, _connection_id: &str) -> Result<bool, String> {
            Ok(false)
        }
    }

    #[tokio::test]
    async fn collect_docs_snapshot_defaults_to_unsupported() {
        let backend = StubBackend;
        let connection = new_connection_config(
            "c1".to_string(),
            "local".to_string(),
            DatabaseType::Postgres,
            "127.0.0.1".to_string(),
            5432,
            "user".to_string(),
            "password".to_string(),
            None,
            false,
            None,
        )
        .unwrap();

        let result = backend.collect_docs_snapshot(&connection, "shop", DocsSnapshotOptions::default()).await;

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not supported"));
    }
}
