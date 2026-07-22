use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::connection::AppState;

use dbx_core::storage::McpGlobalPolicy;

const BIND_ADDR: &str = "127.0.0.1:0";
const MCP_BRIDGE_PORT_FILE: &str = "mcp-bridge-port";
const MCP_EXECUTE_AND_SHOW_SQL_ONLY: &str =
    "UNSUPPORTED_OPERATION: MCP execute-and-show only supports SQL connections.";

#[derive(Deserialize)]
struct OpenTableRequest {
    connection_name: String,
    connection_id: Option<String>,
    database: Option<String>,
    schema: Option<String>,
    table: String,
}

#[derive(Deserialize)]
struct ExecuteQueryRequest {
    connection_name: String,
    connection_id: Option<String>,
    database: Option<String>,
    sql: String,
    schema: Option<String>,
}

#[derive(Deserialize)]
struct ListTablesRequest {
    connection_name: String,
    connection_id: Option<String>,
    database: Option<String>,
    schema: Option<String>,
}

#[derive(Deserialize)]
struct DescribeTableRequest {
    connection_name: String,
    connection_id: Option<String>,
    database: Option<String>,
    schema: Option<String>,
    table: String,
}

#[derive(Deserialize)]
struct MongoFindDocumentsRequest {
    connection_name: String,
    connection_id: Option<String>,
    database: Option<String>,
    collection: String,
    skip: Option<u64>,
    limit: Option<i64>,
    filter: Option<String>,
    projection: Option<String>,
    sort: Option<String>,
}

#[derive(Deserialize)]
struct MongoCountDocumentsRequest {
    connection_name: String,
    connection_id: Option<String>,
    database: Option<String>,
    collection: String,
    filter: Option<String>,
    mode: Option<String>,
}

#[derive(Deserialize)]
struct MongoServerVersionRequest {
    connection_name: String,
    connection_id: Option<String>,
    database: Option<String>,
}

#[derive(Deserialize)]
struct MongoCollectionStatsRequest {
    connection_name: String,
    connection_id: Option<String>,
    database: Option<String>,
    collection: String,
    scale: Option<serde_json::Number>,
}

#[derive(Deserialize)]
struct MongoAggregateDocumentsRequest {
    connection_name: String,
    connection_id: Option<String>,
    database: Option<String>,
    collection: String,
    pipeline_json: String,
    max_rows: Option<usize>,
    options_json: Option<String>,
}

#[derive(Deserialize)]
struct MongoDistinctRequest {
    connection_name: String,
    connection_id: Option<String>,
    database: Option<String>,
    collection: String,
    field: String,
    filter: Option<String>,
}

#[derive(Deserialize)]
struct MongoCreateIndexRequest {
    connection_name: String,
    connection_id: Option<String>,
    database: Option<String>,
    collection: String,
    keys_json: String,
    options_json: Option<String>,
}

#[derive(Deserialize)]
struct MongoDropIndexesRequest {
    connection_name: String,
    connection_id: Option<String>,
    database: Option<String>,
    collection: String,
    indexes_json: Option<String>,
    single: bool,
}

#[derive(Deserialize)]
struct MongoDropCollectionRequest {
    connection_name: String,
    connection_id: Option<String>,
    database: Option<String>,
    collection: String,
}

#[derive(Deserialize)]
struct MongoInsertDocumentsRequest {
    connection_name: String,
    connection_id: Option<String>,
    database: Option<String>,
    collection: String,
    docs_json: String,
}

#[derive(Deserialize)]
struct MongoUpdateDocumentsRequest {
    connection_name: String,
    connection_id: Option<String>,
    database: Option<String>,
    collection: String,
    filter_json: String,
    update_json: String,
    many: bool,
    options_json: Option<String>,
}

#[derive(Deserialize)]
struct MongoDeleteDocumentsRequest {
    connection_name: String,
    connection_id: Option<String>,
    database: Option<String>,
    collection: String,
    filter_json: String,
    many: bool,
}

#[derive(Deserialize)]
struct RedisCommandRequest {
    connection_name: String,
    connection_id: Option<String>,
    db: u32,
    command: String,
    #[serde(rename = "skip_safety_check")]
    _skip_safety_check: Option<bool>,
}

#[derive(Clone, Serialize)]
pub struct McpOpenTableEvent {
    pub connection_id: String,
    pub database: String,
    pub schema: Option<String>,
    pub table: String,
}

#[derive(Clone, Serialize)]
pub struct McpExecuteQueryEvent {
    pub connection_id: String,
    pub database: String,
    pub sql: String,
    pub results: Vec<dbx_core::db::QueryResult>,
}

pub fn start(app_handle: AppHandle, state: Arc<AppState>, data_dir: PathBuf) {
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::bind(BIND_ADDR).await {
            Ok(l) => l,
            Err(e) => {
                log::warn!("MCP bridge failed to bind {BIND_ADDR}: {e}");
                return;
            }
        };
        log::info!("MCP bridge listening on {BIND_ADDR}");
        let actual_port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
        log::info!("MCP bridge assigned port {actual_port}");
        // Publish into DBX's resolved data dir so DBX_DATA_DIR and portable mode share the same discovery file.
        if let Err(err) = write_port_file(&data_dir, actual_port) {
            log::warn!("MCP bridge failed to write port file in {}: {err}", data_dir.display());
        }
        loop {
            let (mut stream, _) = match listener.accept().await {
                Ok(s) => s,
                Err(_) => continue,
            };
            let app = app_handle.clone();
            let st = state.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 65536];
                let n = match stream.read(&mut buf).await {
                    Ok(n) if n > 0 => n,
                    _ => return,
                };
                let request = String::from_utf8_lossy(&buf[..n]);
                let body = request.split("\r\n\r\n").nth(1).unwrap_or("");
                let first_line = request.lines().next().unwrap_or("");

                if first_line.starts_with("POST /open-table") {
                    handle_open_table(&app, &st, body, &mut stream).await;
                } else if first_line.starts_with("POST /data/list-tables") {
                    handle_list_tables_data(&st, body, &mut stream).await;
                } else if first_line.starts_with("POST /data/describe-table") {
                    handle_describe_table_data(&st, body, &mut stream).await;
                } else if first_line.starts_with("POST /data/mongo/list-collections") {
                    handle_mongo_list_collections_data(&st, body, &mut stream).await;
                } else if first_line.starts_with("POST /data/mongo/count-documents") {
                    handle_mongo_count_documents_data(&st, body, &mut stream).await;
                } else if first_line.starts_with("POST /data/mongo/find-documents") {
                    handle_mongo_find_documents_data(&st, body, &mut stream).await;
                } else if first_line.starts_with("POST /data/mongo/server-version") {
                    handle_mongo_server_version_data(&st, body, &mut stream).await;
                } else if first_line.starts_with("POST /data/mongo/collection-stats") {
                    handle_mongo_collection_stats_data(&st, body, &mut stream).await;
                } else if first_line.starts_with("POST /data/mongo/aggregate-documents") {
                    handle_mongo_aggregate_documents_data(&st, body, &mut stream).await;
                } else if first_line.starts_with("POST /data/mongo/distinct") {
                    handle_mongo_distinct_data(&st, body, &mut stream).await;
                } else if first_line.starts_with("POST /data/mongo/create-index") {
                    handle_mongo_create_index_data(&st, body, &mut stream).await;
                } else if first_line.starts_with("POST /data/mongo/drop-indexes") {
                    handle_mongo_drop_indexes_data(&st, body, &mut stream).await;
                } else if first_line.starts_with("POST /data/mongo/drop-collection") {
                    handle_mongo_drop_collection_data(&st, body, &mut stream).await;
                } else if first_line.starts_with("POST /data/mongo/insert-documents") {
                    handle_mongo_insert_documents_data(&st, body, &mut stream).await;
                } else if first_line.starts_with("POST /data/mongo/update-documents") {
                    handle_mongo_update_documents_data(&st, body, &mut stream).await;
                } else if first_line.starts_with("POST /data/mongo/delete-documents") {
                    handle_mongo_delete_documents_data(&st, body, &mut stream).await;
                } else if first_line.starts_with("POST /data/redis/execute-command") {
                    handle_redis_execute_command_data(&st, body, &mut stream).await;
                } else if first_line.starts_with("POST /data/execute-query") {
                    handle_execute_query_data(&st, body, &mut stream).await;
                } else if first_line.starts_with("POST /execute-query") {
                    handle_execute_query(&app, &st, body, &mut stream).await;
                } else if first_line.starts_with("POST /reload-connections") {
                    let _ = app.emit("mcp-reload-connections", ());
                    respond(&mut stream, "200 OK", "ok").await;
                } else {
                    let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;
                }
            });
        }
    });
}

fn write_port_file(data_dir: &Path, actual_port: u16) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(data_dir)?;
    let path = data_dir.join(MCP_BRIDGE_PORT_FILE);
    std::fs::write(&path, actual_port.to_string())?;
    Ok(path)
}

fn find_config_by_name<'a>(
    configs: &'a [crate::models::connection::ConnectionConfig],
    name: &str,
) -> Option<&'a crate::models::connection::ConnectionConfig> {
    configs.iter().find(|c| c.name.eq_ignore_ascii_case(name))
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_connection_in_mcp_scope, ensure_mcp_connection_sql_write_allowed, ensure_mcp_execute_and_show_supported,
        ensure_mcp_sql_database_switch_allowed, mongo_filter_is_effectively_unbounded, mongo_pipeline_has_write_stage,
        resolve_connection, resolve_mongo_database, resolve_mongo_target_values, write_port_file, AppState,
    };
    use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
    use dbx_core::storage::{McpGlobalPolicy, Storage};
    use std::sync::Arc;

    fn mysql_config(read_only: bool) -> ConnectionConfig {
        serde_json::from_value(serde_json::json!({
            "id": "readonly-connection",
            "name": "Read-only connection",
            "db_type": "mysql",
            "host": "localhost",
            "port": 3306,
            "username": "tester",
            "password": "",
            "database": "test",
            "read_only": read_only
        }))
        .unwrap()
    }

    #[test]
    fn writes_bridge_port_file_to_resolved_data_dir() {
        let root = std::env::temp_dir().join(format!(
            "dbx-mcp-bridge-port-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let default_data_dir = root.join("default-app-data");
        let resolved_data_dir = root.join("resolved-data");
        std::fs::create_dir_all(&default_data_dir).unwrap();

        let port_file = write_port_file(&resolved_data_dir, 49152).unwrap();

        assert_eq!(port_file, resolved_data_dir.join("mcp-bridge-port"));
        assert_eq!(std::fs::read_to_string(port_file).unwrap(), "49152");
        assert!(!default_data_dir.join("mcp-bridge-port").exists());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn mongo_database_uses_configured_default_for_missing_or_blank_request() {
        let configured = Some("sample_db".to_string());

        assert_eq!(resolve_mongo_database(None, configured.clone()), "sample_db");
        assert_eq!(resolve_mongo_database(Some(String::new()), configured.clone()), "sample_db");
        assert_eq!(resolve_mongo_database(Some("  ".to_string()), configured), "sample_db");
    }

    #[test]
    fn mongo_database_preserves_explicit_target() {
        assert_eq!(resolve_mongo_database(Some("admin".to_string()), Some("sample_db".to_string())), "admin");
    }

    #[test]
    fn mongo_target_keeps_connection_id_separate_from_database() {
        assert_eq!(
            resolve_mongo_target_values(
                "connection-id".to_string(),
                Some("sample_db".to_string()),
                Some("default_db".to_string()),
            ),
            ("connection-id".to_string(), "sample_db".to_string())
        );
    }

    #[test]
    fn execute_and_show_accepts_sql_connections_only() {
        assert!(ensure_mcp_execute_and_show_supported(&DatabaseType::Mysql).is_ok());
        assert!(ensure_mcp_execute_and_show_supported(&DatabaseType::MongoDb).is_err());
        assert!(ensure_mcp_execute_and_show_supported(&DatabaseType::Redis).is_err());
        assert!(ensure_mcp_execute_and_show_supported(&DatabaseType::Elasticsearch).is_err());
    }

    #[test]
    fn mcp_sql_checks_supplied_connection_read_only_flag() {
        let mut config = mysql_config(true);

        assert!(ensure_mcp_connection_sql_write_allowed(&config, false).is_ok());
        let error = ensure_mcp_connection_sql_write_allowed(&config, true).unwrap_err();
        assert!(error.starts_with("CONNECTION_READ_ONLY:"));

        config.read_only = false;
        assert!(ensure_mcp_connection_sql_write_allowed(&config, true).is_ok());
    }

    #[tokio::test]
    async fn resolve_connection_refreshes_read_only_from_storage() {
        let root = std::env::temp_dir().join(format!(
            "dbx-mcp-bridge-connection-refresh-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let storage = Storage::open(&root.join("storage.db")).await.unwrap();
        let mut config = mysql_config(false);
        storage.save_connections(&[config.clone()]).await.unwrap();
        let state = Arc::new(AppState::new_with_plugin_dir(storage, root.join("plugins")));

        let initial = resolve_connection(&state, Some(&config.id), &config.name).await.unwrap();
        assert!(!initial.read_only);

        config.read_only = true;
        state.storage.save_connections(&[config.clone()]).await.unwrap();
        let refreshed = resolve_connection(&state, Some(&config.id), &config.name).await.unwrap();
        assert!(refreshed.read_only);

        drop(state);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn mcp_sql_rejects_persistent_database_switches() {
        assert!(ensure_mcp_sql_database_switch_allowed(DatabaseType::Mysql, "SELECT 1").is_ok());
        assert_eq!(
            ensure_mcp_sql_database_switch_allowed(DatabaseType::Mysql, "USE production").unwrap_err(),
            "SQL_BLOCKED: MCP does not allow USE or persistent database switching."
        );
    }

    #[test]
    fn mcp_allowlist_distinguishes_all_subset_and_none() {
        let all = McpGlobalPolicy { read_only: false, allow_dangerous_sql: false, allowed_connection_ids: None };
        assert!(ensure_connection_in_mcp_scope(&all, "conn-1").is_ok());

        let subset = McpGlobalPolicy {
            read_only: false,
            allow_dangerous_sql: false,
            allowed_connection_ids: Some(vec!["conn-1".to_string()]),
        };
        assert!(ensure_connection_in_mcp_scope(&subset, "conn-1").is_ok());
        assert!(ensure_connection_in_mcp_scope(&subset, "conn-2").unwrap_err().starts_with("CONNECTION_OUT_OF_SCOPE:"));

        let none =
            McpGlobalPolicy { read_only: false, allow_dangerous_sql: false, allowed_connection_ids: Some(Vec::new()) };
        assert!(ensure_connection_in_mcp_scope(&none, "conn-1").is_err());
    }

    #[test]
    fn mongo_aggregate_write_stages_are_detected_structurally() {
        assert!(mongo_pipeline_has_write_stage(r#"[{"$match":{}},{"$out":"archive"}]"#));
        assert!(mongo_pipeline_has_write_stage(r#"[{"$merge":{"into":"archive"}}]"#));
        assert!(!mongo_pipeline_has_write_stage(r#"[{"$project":{"label":"$out"}}]"#));
    }

    #[test]
    fn mongo_filters_distinguish_guarded_and_unbounded_writes() {
        for filter in [
            "{}",
            r#"{"$comment":"all rows"}"#,
            r#"{"$expr":true}"#,
            r#"{"$or":[{}, {"id":1}]}"#,
            r#"{"$nor":[{"$expr":false}]}"#,
            r#"{"$or":[{"id":{"$exists":true}},{"id":{"$exists":false}}]}"#,
            r#"{"$or":[{"id":{"$exists":true}},{"id":{"$not":{"$exists":true}}}]}"#,
            r#"{"$or":[{"id":{"$eq":1}},{"id":{"$ne":1}}]}"#,
            r#"{"$or":[{"$and":[{"id":{"$eq":1}}]},{"id":{"$ne":1}}]}"#,
            r#"{"$or":[{"$and":[{"id":{"$eq":1}},{}]},{"id":{"$ne":1}}]}"#,
            r#"{"$or":[{"$and":[{"id":{"$eq":1}},{"x":{"$exists":true}}]},{"id":{"$ne":1}},{"x":{"$exists":false}}]}"#,
            r#"{"$or":[{"id":1},{"id":{"$ne":1}}]}"#,
            r#"{"$or":[{"id":{"$gt":1}},{"id":{"$lte":1}}]}"#,
            r#"{"$or":[{"id":{"$gte":1}},{"id":{"$lt":1}}]}"#,
            r#"{"$or":[{"id":{"$in":[1,2]}},{"id":{"$nin":[2,1]}}]}"#,
            r#"{"_id":{"$exists":true}}"#,
            r#"{"id":{"$nin":[]}}"#,
            r#"{"_id":{"$oid":"not-an-object-id"}}"#,
            r#"{"sequence":{"$numberLong":"9223372036854775808"}}"#,
            r#"{"created_at":{"$date":"2026-02-30T00:00:00Z"}}"#,
            r#"{"name":{"$regex":".*"}}"#,
            r#"{"$or":[{"_id":{"$oid":"507f1f77bcf86cd799439011"}},{"_id":{"$ne":{"$oid":"507f1f77bcf86cd799439011"}}}]}"#,
            r#"{"$and":[{"tenant_id":1},{"$nor":[{"archived":true}]}]}"#,
            r#"{"$or":[]}"#,
            r#"{"$opaque":[{"id":1}]}"#,
        ] {
            assert!(mongo_filter_is_effectively_unbounded(filter), "{filter}");
        }
        for filter in [
            r#"{"id":1}"#,
            r#"{"created_at":{"$gte":"2026-01-01"}}"#,
            r#"{"$and":[{}, {"tenant_id":1}]}"#,
            r#"{"$or":[{"tenant_id":1},{"tenant_id":2}]}"#,
            r#"{"id":{"$ne":1}}"#,
            r#"{"id":{"$in":[1,2]}}"#,
            r#"{"id":{"$exists":true}}"#,
            r#"{"_id":{"$oid":"507f1f77bcf86cd799439011"}}"#,
            r#"{"sequence":{"$numberLong":"9223372036854775807"}}"#,
            r#"{"created_at":{"$date":"2026-01-01T00:00:00.000Z"}}"#,
            r#"{"tenant_id":1,"id":{"$nin":[]}}"#,
        ] {
            assert!(!mongo_filter_is_effectively_unbounded(filter), "{filter}");
        }
    }
}

async fn respond(stream: &mut tokio::net::TcpStream, status: &str, body: &str) {
    let resp = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\n\r\n{body}", body.len());
    let _ = stream.write_all(resp.as_bytes()).await;
}

async fn respond_json<T: Serialize>(stream: &mut tokio::net::TcpStream, data: &T) {
    let body = serde_json::to_string(data).unwrap_or_else(|_| "null".to_string());
    let resp =
        format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len());
    let _ = stream.write_all(resp.as_bytes()).await;
}

async fn respond_error(stream: &mut tokio::net::TcpStream, status: &str, message: &str) {
    let body = serde_json::json!({ "error": message }).to_string();
    let resp =
        format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len());
    let _ = stream.write_all(resp.as_bytes()).await;
}

async fn resolve_connection(
    state: &Arc<AppState>,
    connection_id: Option<&str>,
    connection_name: &str,
) -> Result<crate::models::connection::ConnectionConfig, String> {
    let policy = load_mcp_policy(state).await?;
    let configs = state.storage.load_connections().await.map_err(|e| mcp_policy_unavailable(e.to_string()))?;
    let config = if let Some(id) = connection_id.filter(|s| !s.is_empty()) {
        configs.iter().find(|c| c.id == id).ok_or_else(|| format!("Connection with id '{}' not found", id))?
    } else {
        find_config_by_name(&configs, connection_name).ok_or_else(|| "Connection not found".to_string())?
    };
    ensure_connection_in_mcp_scope(&policy, &config.id)?;
    let mut state_configs = state.configs.write().await;
    if !state_configs.contains_key(&config.id) {
        state_configs.insert(config.id.clone(), config.clone());
    }
    drop(state_configs);
    Ok(config.clone())
}

async fn load_mcp_policy(state: &Arc<AppState>) -> Result<McpGlobalPolicy, String> {
    state
        .storage
        .load_mcp_global_policy()
        .await
        .map(|state| state.policy())
        .map_err(|error| mcp_policy_unavailable(error.to_string()))
}

fn mcp_policy_unavailable(error: String) -> String {
    if error.starts_with("MCP_POLICY_UNAVAILABLE:") {
        error
    } else {
        format!("MCP_POLICY_UNAVAILABLE: {error}")
    }
}

fn ensure_connection_in_mcp_scope(policy: &McpGlobalPolicy, connection_id: &str) -> Result<(), String> {
    if policy.allowed_connection_ids.as_ref().is_some_and(|allowed| !allowed.iter().any(|id| id == connection_id)) {
        return Err(format!(
            "CONNECTION_OUT_OF_SCOPE: connection '{connection_id}' is not allowed by DBX MCP settings"
        ));
    }
    Ok(())
}

async fn ensure_mcp_write_allowed(
    state: &Arc<AppState>,
    config: &crate::models::connection::ConnectionConfig,
    database: &str,
    action: &str,
) -> Result<(), String> {
    ensure_mcp_write_allowed_with_risk(state, config, database, action, false).await
}

async fn ensure_mcp_write_allowed_with_risk(
    state: &Arc<AppState>,
    config: &crate::models::connection::ConnectionConfig,
    database: &str,
    action: &str,
    dangerous: bool,
) -> Result<(), String> {
    let policy = load_mcp_policy(state).await?;
    ensure_connection_in_mcp_scope(&policy, &config.id)?;
    if policy.read_only {
        return Err(format!("MCP_READ_ONLY: DBX MCP read-only mode is enabled. {action} blocked."));
    }
    if dangerous && !policy.allow_dangerous_sql {
        return Err(format!("SQL_BLOCKED: High-risk operation '{action}' is disabled in DBX MCP settings."));
    }
    if config.read_only {
        return Err(format!(
            "CONNECTION_READ_ONLY: connection '{}' has read-only protection enabled. {action} blocked.",
            config.name
        ));
    }
    if dbx_core::production_safety::is_production_database(config, database) {
        return Err(format!("PRODUCTION_DATABASE_READ_ONLY: {action} blocked for production database '{database}'."));
    }
    Ok(())
}

pub(crate) async fn ensure_mcp_read_allowed_by_id(
    state: &Arc<AppState>,
    connection_id: &str,
    database: &str,
) -> Result<(), String> {
    let policy = load_mcp_policy(state).await?;
    ensure_connection_in_mcp_scope(&policy, connection_id)?;
    let configs = state.storage.load_connections().await.map_err(|e| format!("MCP_POLICY_UNAVAILABLE: {e}"))?;
    let config = configs
        .iter()
        .find(|config| config.id == connection_id)
        .ok_or_else(|| format!("Connection with id '{connection_id}' not found"))?;
    check_visible_database(config, database)
}

pub(crate) async fn ensure_mcp_write_allowed_by_id(
    state: &Arc<AppState>,
    connection_id: &str,
    database: &str,
    action: &str,
) -> Result<(), String> {
    ensure_mcp_write_allowed_by_id_with_risk(state, connection_id, database, action, false).await
}

pub(crate) async fn ensure_mcp_dangerous_write_allowed_by_id(
    state: &Arc<AppState>,
    connection_id: &str,
    database: &str,
    action: &str,
) -> Result<(), String> {
    ensure_mcp_write_allowed_by_id_with_risk(state, connection_id, database, action, true).await
}

async fn ensure_mcp_mongo_pipeline_target_allowed_by_id(
    state: &Arc<AppState>,
    connection_id: &str,
    database: &str,
    pipeline_json: &str,
) -> Result<(), String> {
    let configs = state.storage.load_connections().await.map_err(|e| format!("MCP_POLICY_UNAVAILABLE: {e}"))?;
    let config = configs
        .iter()
        .find(|config| config.id == connection_id)
        .ok_or_else(|| format!("Connection with id '{connection_id}' not found"))?;
    if dbx_core::production_safety::mongo_pipeline_targets_production_database(config, database, pipeline_json) {
        return Err(
            "PRODUCTION_DATABASE_READ_ONLY: MongoDB aggregate write targeting production scope is blocked.".to_string()
        );
    }
    Ok(())
}

async fn ensure_mcp_write_allowed_by_id_with_risk(
    state: &Arc<AppState>,
    connection_id: &str,
    database: &str,
    action: &str,
    dangerous: bool,
) -> Result<(), String> {
    let configs = state.storage.load_connections().await.map_err(|e| format!("MCP_POLICY_UNAVAILABLE: {e}"))?;
    let config = configs
        .iter()
        .find(|config| config.id == connection_id)
        .ok_or_else(|| format!("Connection with id '{connection_id}' not found"))?;
    ensure_mcp_write_allowed_with_risk(state, config, database, action, dangerous).await
}

pub(crate) async fn ensure_mcp_mongo_filtered_write_allowed_by_id(
    state: &Arc<AppState>,
    connection_id: &str,
    database: &str,
    action: &str,
    filter_json: &str,
) -> Result<(), String> {
    if mongo_filter_is_effectively_unbounded(filter_json) {
        ensure_mcp_dangerous_write_allowed_by_id(state, connection_id, database, action).await
    } else {
        ensure_mcp_write_allowed_by_id(state, connection_id, database, action).await
    }
}

pub(crate) async fn ensure_mcp_mongo_aggregate_allowed_by_id(
    state: &Arc<AppState>,
    connection_id: &str,
    database: &str,
    pipeline_json: &str,
) -> Result<(), String> {
    if !mongo_pipeline_has_write_stage(pipeline_json) {
        return ensure_mcp_read_allowed_by_id(state, connection_id, database).await;
    }
    ensure_mcp_dangerous_write_allowed_by_id(state, connection_id, database, "MongoDB aggregate write").await?;
    ensure_mcp_mongo_pipeline_target_allowed_by_id(state, connection_id, database, pipeline_json).await
}

fn mongo_pipeline_has_write_stage(pipeline_json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(pipeline_json)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .is_some_and(|stages| {
            stages.iter().any(|stage| {
                stage
                    .as_object()
                    .is_some_and(|document| document.contains_key("$out") || document.contains_key("$merge"))
            })
        })
}

fn mongo_filter_is_effectively_unbounded(filter_json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(filter_json)
        .ok()
        .as_ref()
        .is_none_or(|value| mongo_filter_contains_opaque_logic(value) || mongo_filter_value_is_unbounded(value))
}

fn mongo_filter_contains_opaque_logic(value: &serde_json::Value) -> bool {
    let Some(filter) = value.as_object() else {
        return true;
    };
    filter.iter().any(|(key, value)| match key.as_str() {
        "$comment" => false,
        "$where" | "$expr" | "$nor" => true,
        "$and" | "$or" => {
            let Some(clauses) = value.as_array() else {
                return true;
            };
            clauses.is_empty()
                || clauses.iter().any(|clause| !clause.is_object() || mongo_filter_contains_opaque_logic(clause))
                || (key == "$or"
                    && clauses
                        .iter()
                        .any(|clause| clause.as_object().is_some_and(|document| document.contains_key("$and"))))
                || (key == "$or" && mongo_or_has_complementary_field_clauses(clauses))
        }
        _ => key.starts_with('$') || mongo_field_predicate_contains_opaque_logic(value),
    })
}

fn mongo_field_predicate_contains_opaque_logic(value: &serde_json::Value) -> bool {
    let Some(predicate) = value.as_object() else {
        return false;
    };
    if mongo_extended_json_scalar_literal_is_valid(value) {
        return false;
    }
    let has_operator = predicate.keys().any(|key| key.starts_with('$'));
    has_operator
        && predicate.keys().any(|key| {
            !matches!(key.as_str(), "$eq" | "$ne" | "$gt" | "$gte" | "$lt" | "$lte" | "$in" | "$nin" | "$exists")
        })
}

fn mongo_extended_json_scalar_literal_is_valid(value: &serde_json::Value) -> bool {
    let Some(wrapper) = value.as_object().filter(|wrapper| wrapper.len() == 1) else {
        return false;
    };
    if let Some(value) = wrapper.get("$oid").and_then(serde_json::Value::as_str) {
        return value.len() == 24 && value.bytes().all(|byte| byte.is_ascii_hexdigit());
    }
    if let Some(value) = wrapper.get("$numberLong").and_then(serde_json::Value::as_str) {
        return value.parse::<i64>().is_ok();
    }
    wrapper
        .get("$date")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| chrono::DateTime::parse_from_rfc3339(value).is_ok())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MongoFieldOperator {
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
    In,
    Nin,
    Exists,
}

struct MongoPureFieldPredicate<'a> {
    field: &'a str,
    operator: MongoFieldOperator,
    operand: &'a serde_json::Value,
}

fn mongo_or_has_complementary_field_clauses(clauses: &[serde_json::Value]) -> bool {
    clauses.iter().enumerate().any(|(index, clause)| {
        let Some(predicate) = mongo_pure_field_predicate(clause) else {
            return false;
        };
        clauses[index + 1..]
            .iter()
            .filter_map(mongo_pure_field_predicate)
            .any(|other| mongo_field_predicates_are_complementary(&predicate, &other))
    })
}

fn mongo_pure_field_predicate(value: &serde_json::Value) -> Option<MongoPureFieldPredicate<'_>> {
    let filter = value.as_object()?;
    let mut entries = filter.iter().filter(|(key, _)| key.as_str() != "$comment");
    let (field, predicate) = entries.next()?;
    if entries.next().is_some() {
        return None;
    }
    if field == "$and" {
        let clauses = predicate.as_array()?;
        let mut bounded = clauses.iter().filter(|clause| !mongo_filter_value_is_unbounded(clause));
        let clause = bounded.next()?;
        if bounded.next().is_some() {
            return None;
        }
        return mongo_pure_field_predicate(clause);
    }
    if field == "$or" {
        let clauses = predicate.as_array()?;
        return (clauses.len() == 1).then(|| mongo_pure_field_predicate(&clauses[0])).flatten();
    }
    if field.starts_with('$') {
        return None;
    }
    let Some(operator_document) = predicate.as_object() else {
        return Some(MongoPureFieldPredicate { field, operator: MongoFieldOperator::Eq, operand: predicate });
    };
    if mongo_extended_json_scalar_literal_is_valid(predicate)
        || !operator_document.keys().any(|key| key.starts_with('$'))
    {
        return Some(MongoPureFieldPredicate { field, operator: MongoFieldOperator::Eq, operand: predicate });
    }
    let mut operators = operator_document.iter();
    let (operator, operand) = operators.next()?;
    if operators.next().is_some() {
        return None;
    }
    let operator = match operator.as_str() {
        "$eq" => MongoFieldOperator::Eq,
        "$ne" => MongoFieldOperator::Ne,
        "$gt" => MongoFieldOperator::Gt,
        "$gte" => MongoFieldOperator::Gte,
        "$lt" => MongoFieldOperator::Lt,
        "$lte" => MongoFieldOperator::Lte,
        "$in" => MongoFieldOperator::In,
        "$nin" => MongoFieldOperator::Nin,
        "$exists" => MongoFieldOperator::Exists,
        _ => return None,
    };
    Some(MongoPureFieldPredicate { field, operator, operand })
}

fn mongo_field_predicates_are_complementary(
    left: &MongoPureFieldPredicate<'_>,
    right: &MongoPureFieldPredicate<'_>,
) -> bool {
    if left.field != right.field {
        return false;
    }
    use MongoFieldOperator::{Eq, Exists, Gt, Gte, In, Lt, Lte, Ne, Nin};
    match (left.operator, right.operator) {
        (Exists, Exists) => {
            left.operand.as_bool().zip(right.operand.as_bool()).is_some_and(|(left, right)| left != right)
        }
        (In, Nin) | (Nin, In) => mongo_json_sets_equal(left.operand, right.operand),
        (Eq, Ne) | (Ne, Eq) | (Gt, Lte) | (Lte, Gt) | (Gte, Lt) | (Lt, Gte) => left.operand == right.operand,
        _ => false,
    }
}

fn mongo_json_sets_equal(left: &serde_json::Value, right: &serde_json::Value) -> bool {
    let (Some(left), Some(right)) = (left.as_array(), right.as_array()) else {
        return false;
    };
    left.iter().all(|value| right.contains(value)) && right.iter().all(|value| left.contains(value))
}

fn mongo_filter_value_is_unbounded(value: &serde_json::Value) -> bool {
    let Some(filter) = value.as_object() else {
        return true;
    };
    if filter.is_empty() || filter.contains_key("$where") || filter.contains_key("$expr") {
        return true;
    }
    filter.iter().all(|(key, value)| match key.as_str() {
        "$comment" => true,
        "$and" => value
            .as_array()
            .is_none_or(|clauses| clauses.is_empty() || clauses.iter().all(mongo_filter_value_is_unbounded)),
        "$or" => value
            .as_array()
            .is_none_or(|clauses| clauses.is_empty() || clauses.iter().any(mongo_filter_value_is_unbounded)),
        "$nor" => true,
        _ if mongo_field_predicate_is_empty_nin(value) => true,
        "_id" if mongo_field_predicate_is_exists_true(value) => true,
        _ => key.starts_with('$'),
    })
}

fn mongo_field_predicate_is_empty_nin(value: &serde_json::Value) -> bool {
    value.as_object().is_some_and(|predicate| {
        predicate.len() == 1 && predicate.get("$nin").and_then(serde_json::Value::as_array).is_some_and(Vec::is_empty)
    })
}

fn mongo_field_predicate_is_exists_true(value: &serde_json::Value) -> bool {
    value.as_object().is_some_and(|predicate| {
        predicate.len() == 1 && predicate.get("$exists").and_then(serde_json::Value::as_bool) == Some(true)
    })
}

async fn ensure_mcp_sql_allowed(
    state: &Arc<AppState>,
    config: &crate::models::connection::ConnectionConfig,
    database: &str,
    sql: &str,
) -> Result<(), String> {
    let policy = load_mcp_policy(state).await?;
    ensure_connection_in_mcp_scope(&policy, &config.id)?;
    ensure_mcp_sql_database_switch_allowed(config.db_type, sql)?;
    let is_write = dbx_core::query_execution_sql::is_write_sql_for_database(sql, config.db_type);
    if policy.read_only && is_write {
        return Err("MCP_READ_ONLY: DBX MCP read-only mode is enabled. SQL write blocked.".to_string());
    }
    if !policy.allow_dangerous_sql && dbx_core::sql_risk::is_dangerous_sql_for_database(sql, config.db_type) {
        return Err("SQL_BLOCKED: High-risk SQL is disabled in DBX MCP settings.".to_string());
    }
    ensure_mcp_connection_sql_write_allowed(config, is_write)?;
    if is_write && dbx_core::production_safety::targets_production_database(config, database, sql) {
        return Err("PRODUCTION_DATABASE_READ_ONLY: SQL write targeting production scope is blocked.".to_string());
    }
    Ok(())
}

fn ensure_mcp_sql_database_switch_allowed(
    database_type: crate::models::connection::DatabaseType,
    sql: &str,
) -> Result<(), String> {
    if dbx_core::sql_risk::mcp_sql_has_forbidden_database_switch(sql, database_type) {
        return Err("SQL_BLOCKED: MCP does not allow USE or persistent database switching.".to_string());
    }
    Ok(())
}

fn ensure_mcp_connection_sql_write_allowed(
    config: &crate::models::connection::ConnectionConfig,
    is_write: bool,
) -> Result<(), String> {
    if is_write && config.read_only {
        return Err(format!(
            "CONNECTION_READ_ONLY: connection '{}' has read-only protection enabled. SQL write blocked.",
            config.name
        ));
    }
    Ok(())
}

fn check_visible_database(config: &crate::models::connection::ConnectionConfig, database: &str) -> Result<(), String> {
    if let Some(ref visible) = config.visible_databases {
        if !visible.is_empty() && !visible.iter().any(|v| v == database) {
            return Err(format!("Database '{}' is not in the visible databases list for this connection", database));
        }
    }
    Ok(())
}

fn resolve_mongo_database(requested: Option<String>, configured: Option<String>) -> String {
    requested.filter(|database| !database.trim().is_empty()).or(configured).unwrap_or_default()
}

fn resolve_mongo_target_values(
    connection_id: String,
    requested_database: Option<String>,
    configured_database: Option<String>,
) -> (String, String) {
    (connection_id, resolve_mongo_database(requested_database, configured_database))
}

async fn resolve_mongo_target(
    state: &Arc<AppState>,
    connection_id: Option<&str>,
    connection_name: &str,
    database: Option<String>,
    stream: &mut tokio::net::TcpStream,
) -> Option<(String, String)> {
    let config = match resolve_connection(state, connection_id, connection_name).await {
        Ok(c) => c,
        Err(e) => {
            respond_error(stream, "404 Not Found", &e).await;
            return None;
        }
    };
    let (connection_id, database) = resolve_mongo_target_values(config.id.clone(), database, config.database.clone());
    if let Err(e) = check_visible_database(&config, &database) {
        respond_error(stream, "403 Forbidden", &e).await;
        return None;
    }
    Some((connection_id, database))
}

async fn handle_open_table(app: &AppHandle, state: &Arc<AppState>, body: &str, stream: &mut tokio::net::TcpStream) {
    let req: OpenTableRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(_) => {
            respond(stream, "400 Bad Request", "").await;
            return;
        }
    };
    let config = match resolve_connection(state, req.connection_id.as_deref(), &req.connection_name).await {
        Ok(c) => c,
        Err(e) => {
            respond(stream, "404 Not Found", &e).await;
            return;
        }
    };
    let event = McpOpenTableEvent {
        connection_id: config.id.clone(),
        database: req.database.unwrap_or_else(|| config.database.clone().unwrap_or_default()),
        schema: req.schema,
        table: req.table,
    };
    let _ = app.emit("mcp-open-table", &event);
    respond(stream, "200 OK", "ok").await;
}

async fn handle_execute_query(app: &AppHandle, state: &Arc<AppState>, body: &str, stream: &mut tokio::net::TcpStream) {
    let req: ExecuteQueryRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(_) => {
            respond(stream, "400 Bad Request", "").await;
            return;
        }
    };
    let config = match resolve_connection(state, req.connection_id.as_deref(), &req.connection_name).await {
        Ok(c) => c,
        Err(e) => {
            respond(stream, "404 Not Found", &e).await;
            return;
        }
    };
    let database = req.database.unwrap_or_else(|| config.database.clone().unwrap_or_default());
    if let Err(error) = ensure_mcp_execute_and_show_supported(&config.db_type) {
        respond(stream, "400 Bad Request", error).await;
        return;
    }
    // Check the complete batch first so a session-changing statement cannot
    // hide a later production write, then recheck every statement immediately
    // before it reaches the database.
    if let Err(e) = ensure_mcp_sql_allowed(state, &config, &database, &req.sql).await {
        respond(stream, "403 Forbidden", &e).await;
        return;
    }
    let statements = if config.db_type == crate::models::connection::DatabaseType::SqlServer {
        dbx_core::sql::split_sql_batches(&req.sql)
    } else {
        dbx_core::sql::split_sql_statements_for_database(&req.sql, config.db_type)
    };
    let statements = if statements.is_empty() { vec![req.sql.clone()] } else { statements };
    let mut results = Vec::with_capacity(statements.len());
    for statement in statements {
        let current = match resolve_connection(state, Some(&config.id), &config.name).await {
            Ok(config) => config,
            Err(e) => {
                respond(stream, "403 Forbidden", &e).await;
                return;
            }
        };
        if let Err(e) = ensure_mcp_sql_allowed(state, &current, &database, &statement).await {
            respond(stream, "403 Forbidden", &e).await;
            return;
        }
        match dbx_core::query::execute_sql_statement(state, &current.id, &database, &statement, None, None).await {
            Ok(result) => results.push(result),
            Err(e) => {
                respond(stream, "500 Internal Server Error", &format!("QUERY_ERROR: {e}")).await;
                return;
            }
        }
    }
    let event = McpExecuteQueryEvent { connection_id: config.id.clone(), database, sql: req.sql, results };
    let _ = app.emit("mcp-execute-query", &event);
    respond(stream, "200 OK", "ok").await;
}

fn ensure_mcp_execute_and_show_supported(
    database_type: &crate::models::connection::DatabaseType,
) -> Result<(), &'static str> {
    if dbx_core::query_execution_sql::supports_sql_query(*database_type) {
        Ok(())
    } else {
        Err(MCP_EXECUTE_AND_SHOW_SQL_ONLY)
    }
}

async fn handle_list_tables_data(state: &Arc<AppState>, body: &str, stream: &mut tokio::net::TcpStream) {
    let req: ListTablesRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(_) => {
            respond_error(stream, "400 Bad Request", "Invalid JSON").await;
            return;
        }
    };
    let config = match resolve_connection(state, req.connection_id.as_deref(), &req.connection_name).await {
        Ok(c) => c,
        Err(e) => {
            respond_error(stream, "404 Not Found", &e).await;
            return;
        }
    };
    let database = req.database.unwrap_or_else(|| config.database.clone().unwrap_or_default());
    let schema = req.schema.unwrap_or_default();
    if let Err(e) = check_visible_database(&config, &database) {
        respond_error(stream, "403 Forbidden", &e).await;
        return;
    }
    match dbx_core::schema::list_tables_core(state, &config.id, &database, &schema, None, None, None, None).await {
        Ok(tables) => respond_json(stream, &tables).await,
        Err(e) => respond_error(stream, "500 Internal Server Error", &e).await,
    }
}

async fn handle_describe_table_data(state: &Arc<AppState>, body: &str, stream: &mut tokio::net::TcpStream) {
    let req: DescribeTableRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(_) => {
            respond_error(stream, "400 Bad Request", "Invalid JSON").await;
            return;
        }
    };
    let config = match resolve_connection(state, req.connection_id.as_deref(), &req.connection_name).await {
        Ok(c) => c,
        Err(e) => {
            respond_error(stream, "404 Not Found", &e).await;
            return;
        }
    };
    let database = req.database.unwrap_or_else(|| config.database.clone().unwrap_or_default());
    let schema = req.schema.unwrap_or_default();
    if let Err(e) = check_visible_database(&config, &database) {
        respond_error(stream, "403 Forbidden", &e).await;
        return;
    }
    match dbx_core::schema::get_columns_core(state, &config.id, &database, &schema, &req.table).await {
        Ok(columns) => respond_json(stream, &columns).await,
        Err(e) => respond_error(stream, "500 Internal Server Error", &e).await,
    }
}

async fn handle_mongo_list_collections_data(state: &Arc<AppState>, body: &str, stream: &mut tokio::net::TcpStream) {
    let req: ListTablesRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(_) => {
            respond_error(stream, "400 Bad Request", "Invalid JSON").await;
            return;
        }
    };
    let Some((connection_id, database)) =
        resolve_mongo_target(state, req.connection_id.as_deref(), &req.connection_name, req.database, stream).await
    else {
        return;
    };
    match dbx_core::mongo_ops::mongo_list_collections_core(state, &connection_id, &database).await {
        Ok(collections) => respond_json(stream, &collections).await,
        Err(e) => respond_error(stream, "500 Internal Server Error", &e).await,
    }
}

async fn handle_mongo_find_documents_data(state: &Arc<AppState>, body: &str, stream: &mut tokio::net::TcpStream) {
    let req: MongoFindDocumentsRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(_) => {
            respond_error(stream, "400 Bad Request", "Invalid JSON").await;
            return;
        }
    };
    let Some((connection_id, database)) =
        resolve_mongo_target(state, req.connection_id.as_deref(), &req.connection_name, req.database, stream).await
    else {
        return;
    };
    match dbx_core::mongo_ops::mongo_find_documents_core(
        state,
        &connection_id,
        &database,
        &req.collection,
        req.skip.unwrap_or(0),
        req.limit.unwrap_or(100),
        req.filter.as_deref(),
        req.projection.as_deref(),
        req.sort.as_deref(),
    )
    .await
    {
        Ok(result) => respond_json(stream, &result).await,
        Err(e) => respond_error(stream, "500 Internal Server Error", &e).await,
    }
}

async fn handle_mongo_count_documents_data(state: &Arc<AppState>, body: &str, stream: &mut tokio::net::TcpStream) {
    let req: MongoCountDocumentsRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(_) => {
            respond_error(stream, "400 Bad Request", "Invalid JSON").await;
            return;
        }
    };
    let Some((connection_id, database)) =
        resolve_mongo_target(state, req.connection_id.as_deref(), &req.connection_name, req.database, stream).await
    else {
        return;
    };
    match dbx_core::mongo_ops::mongo_count_documents_core(
        state,
        &connection_id,
        &database,
        &req.collection,
        req.filter.as_deref(),
        req.mode.as_deref(),
    )
    .await
    {
        Ok(total) => respond_json(stream, &total).await,
        Err(e) => respond_error(stream, "500 Internal Server Error", &e).await,
    }
}

async fn handle_mongo_server_version_data(state: &Arc<AppState>, body: &str, stream: &mut tokio::net::TcpStream) {
    let req: MongoServerVersionRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(_) => {
            respond_error(stream, "400 Bad Request", "Invalid JSON").await;
            return;
        }
    };
    let Some((connection_id, database)) =
        resolve_mongo_target(state, req.connection_id.as_deref(), &req.connection_name, req.database, stream).await
    else {
        return;
    };
    match dbx_core::mongo_ops::mongo_server_version_core(state, &connection_id, &database).await {
        Ok(version) => respond_json(stream, &version).await,
        Err(e) => respond_error(stream, "500 Internal Server Error", &e).await,
    }
}

async fn handle_mongo_collection_stats_data(state: &Arc<AppState>, body: &str, stream: &mut tokio::net::TcpStream) {
    let req: MongoCollectionStatsRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(_) => {
            respond_error(stream, "400 Bad Request", "Invalid JSON").await;
            return;
        }
    };
    let Some((connection_id, database)) =
        resolve_mongo_target(state, req.connection_id.as_deref(), &req.connection_name, req.database, stream).await
    else {
        return;
    };
    match dbx_core::mongo_ops::mongo_collection_stats_core(state, &connection_id, &database, &req.collection, req.scale)
        .await
    {
        Ok(result) => respond_json(stream, &result).await,
        Err(e) => respond_error(stream, "500 Internal Server Error", &e).await,
    }
}

async fn handle_mongo_aggregate_documents_data(state: &Arc<AppState>, body: &str, stream: &mut tokio::net::TcpStream) {
    let req: MongoAggregateDocumentsRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(_) => {
            respond_error(stream, "400 Bad Request", "Invalid JSON").await;
            return;
        }
    };
    let Some((connection_id, database)) =
        resolve_mongo_target(state, req.connection_id.as_deref(), &req.connection_name, req.database, stream).await
    else {
        return;
    };
    if let Err(e) = ensure_mcp_mongo_aggregate_allowed_by_id(state, &connection_id, &database, &req.pipeline_json).await
    {
        respond_error(stream, "403 Forbidden", &e).await;
        return;
    }
    match dbx_core::mongo_ops::mongo_aggregate_documents_core(
        state,
        &connection_id,
        &database,
        &req.collection,
        &req.pipeline_json,
        req.max_rows,
        req.options_json.as_deref(),
    )
    .await
    {
        Ok(result) => respond_json(stream, &result).await,
        Err(e) => respond_error(stream, "500 Internal Server Error", &e).await,
    }
}

async fn handle_mongo_distinct_data(state: &Arc<AppState>, body: &str, stream: &mut tokio::net::TcpStream) {
    let req: MongoDistinctRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(_) => {
            respond_error(stream, "400 Bad Request", "Invalid JSON").await;
            return;
        }
    };
    let Some((connection_id, database)) =
        resolve_mongo_target(state, req.connection_id.as_deref(), &req.connection_name, req.database, stream).await
    else {
        return;
    };
    match dbx_core::mongo_ops::mongo_distinct_core(
        state,
        &connection_id,
        &database,
        &req.collection,
        &req.field,
        req.filter.as_deref(),
    )
    .await
    {
        Ok(result) => respond_json(stream, &result).await,
        Err(e) => respond_error(stream, "500 Internal Server Error", &e).await,
    }
}

async fn handle_mongo_create_index_data(state: &Arc<AppState>, body: &str, stream: &mut tokio::net::TcpStream) {
    let req: MongoCreateIndexRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(_) => {
            respond_error(stream, "400 Bad Request", "Invalid JSON").await;
            return;
        }
    };
    let Some((connection_id, database)) =
        resolve_mongo_target(state, req.connection_id.as_deref(), &req.connection_name, req.database, stream).await
    else {
        return;
    };
    if let Err(e) = ensure_mcp_dangerous_write_allowed_by_id(state, &connection_id, &database, "Create index").await {
        respond_error(stream, "403 Forbidden", &e).await;
        return;
    }
    match dbx_core::mongo_ops::mongo_create_index_core(
        state,
        &connection_id,
        &database,
        &req.collection,
        &req.keys_json,
        req.options_json.as_deref(),
    )
    .await
    {
        Ok(name) => respond_json(stream, &serde_json::json!({ "name": name })).await,
        Err(e) => respond_error(stream, "500 Internal Server Error", &e).await,
    }
}

async fn handle_mongo_drop_indexes_data(state: &Arc<AppState>, body: &str, stream: &mut tokio::net::TcpStream) {
    let req: MongoDropIndexesRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(_) => {
            respond_error(stream, "400 Bad Request", "Invalid JSON").await;
            return;
        }
    };
    let Some((connection_id, database)) =
        resolve_mongo_target(state, req.connection_id.as_deref(), &req.connection_name, req.database, stream).await
    else {
        return;
    };
    if let Err(e) = ensure_mcp_dangerous_write_allowed_by_id(state, &connection_id, &database, "Drop indexes").await {
        respond_error(stream, "403 Forbidden", &e).await;
        return;
    }
    match dbx_core::mongo_ops::mongo_drop_indexes_core(
        state,
        &connection_id,
        &database,
        &req.collection,
        req.indexes_json.as_deref(),
        req.single,
    )
    .await
    {
        Ok(result) => respond_json(stream, &result).await,
        Err(e) => respond_error(stream, "500 Internal Server Error", &e).await,
    }
}

async fn handle_mongo_drop_collection_data(state: &Arc<AppState>, body: &str, stream: &mut tokio::net::TcpStream) {
    let req: MongoDropCollectionRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(_) => {
            respond_error(stream, "400 Bad Request", "Invalid JSON").await;
            return;
        }
    };
    let Some((connection_id, database)) =
        resolve_mongo_target(state, req.connection_id.as_deref(), &req.connection_name, req.database, stream).await
    else {
        return;
    };
    if let Err(e) = ensure_mcp_dangerous_write_allowed_by_id(state, &connection_id, &database, "Drop collection").await
    {
        respond_error(stream, "403 Forbidden", &e).await;
        return;
    }
    match dbx_core::mongo_ops::mongo_drop_collection_core(state, &connection_id, &database, &req.collection).await {
        Ok(()) => respond_json(stream, &serde_json::json!({ "ok": true })).await,
        Err(e) => respond_error(stream, "500 Internal Server Error", &e).await,
    }
}

async fn handle_mongo_insert_documents_data(state: &Arc<AppState>, body: &str, stream: &mut tokio::net::TcpStream) {
    let req: MongoInsertDocumentsRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(_) => {
            respond_error(stream, "400 Bad Request", "Invalid JSON").await;
            return;
        }
    };
    let Some((connection_id, database)) =
        resolve_mongo_target(state, req.connection_id.as_deref(), &req.connection_name, req.database, stream).await
    else {
        return;
    };
    if let Err(e) = ensure_mcp_write_allowed_by_id(state, &connection_id, &database, "Insert").await {
        respond_error(stream, "403 Forbidden", &e).await;
        return;
    }
    match dbx_core::mongo_ops::mongo_insert_documents_core(
        state,
        &connection_id,
        &database,
        &req.collection,
        &req.docs_json,
    )
    .await
    {
        Ok(inserted) => respond_json(stream, &serde_json::json!({ "affected_rows": inserted })).await,
        Err(e) => respond_error(stream, "500 Internal Server Error", &e).await,
    }
}

async fn handle_mongo_update_documents_data(state: &Arc<AppState>, body: &str, stream: &mut tokio::net::TcpStream) {
    let req: MongoUpdateDocumentsRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(_) => {
            respond_error(stream, "400 Bad Request", "Invalid JSON").await;
            return;
        }
    };
    let Some((connection_id, database)) =
        resolve_mongo_target(state, req.connection_id.as_deref(), &req.connection_name, req.database, stream).await
    else {
        return;
    };
    let policy_check = if mongo_filter_is_effectively_unbounded(&req.filter_json) {
        ensure_mcp_dangerous_write_allowed_by_id(state, &connection_id, &database, "Update").await
    } else {
        ensure_mcp_write_allowed_by_id(state, &connection_id, &database, "Update").await
    };
    if let Err(e) = policy_check {
        respond_error(stream, "403 Forbidden", &e).await;
        return;
    }
    match dbx_core::mongo_ops::mongo_update_documents_core(
        state,
        &connection_id,
        &database,
        &req.collection,
        &req.filter_json,
        &req.update_json,
        req.many,
        req.options_json.as_deref(),
    )
    .await
    {
        Ok(modified) => respond_json(stream, &serde_json::json!({ "affected_rows": modified })).await,
        Err(e) => respond_error(stream, "500 Internal Server Error", &e).await,
    }
}

async fn handle_mongo_delete_documents_data(state: &Arc<AppState>, body: &str, stream: &mut tokio::net::TcpStream) {
    let req: MongoDeleteDocumentsRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(_) => {
            respond_error(stream, "400 Bad Request", "Invalid JSON").await;
            return;
        }
    };
    let Some((connection_id, database)) =
        resolve_mongo_target(state, req.connection_id.as_deref(), &req.connection_name, req.database, stream).await
    else {
        return;
    };
    let policy_check = if mongo_filter_is_effectively_unbounded(&req.filter_json) {
        ensure_mcp_dangerous_write_allowed_by_id(state, &connection_id, &database, "Delete").await
    } else {
        ensure_mcp_write_allowed_by_id(state, &connection_id, &database, "Delete").await
    };
    if let Err(e) = policy_check {
        respond_error(stream, "403 Forbidden", &e).await;
        return;
    }
    match dbx_core::mongo_ops::mongo_delete_documents_core(
        state,
        &connection_id,
        &database,
        &req.collection,
        &req.filter_json,
        req.many,
    )
    .await
    {
        Ok(deleted) => respond_json(stream, &serde_json::json!({ "affected_rows": deleted })).await,
        Err(e) => respond_error(stream, "500 Internal Server Error", &e).await,
    }
}

async fn handle_redis_execute_command_data(state: &Arc<AppState>, body: &str, stream: &mut tokio::net::TcpStream) {
    let req: RedisCommandRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(_) => {
            respond_error(stream, "400 Bad Request", "Invalid JSON").await;
            return;
        }
    };
    let config = match resolve_connection(state, req.connection_id.as_deref(), &req.connection_name).await {
        Ok(c) => c,
        Err(e) => {
            respond_error(stream, "404 Not Found", &e).await;
            return;
        }
    };
    let database = req.db.to_string();
    if let Err(e) = check_visible_database(&config, &database) {
        respond_error(stream, "403 Forbidden", &e).await;
        return;
    }
    let argv = match dbx_core::db::redis_driver::parse_command_argv(&req.command) {
        Ok(argv) => argv,
        Err(error) => {
            respond_error(stream, "400 Bad Request", &format!("Invalid Redis command: {error}")).await;
            return;
        }
    };
    let cmd_name = argv[0].to_ascii_uppercase();
    let safety = dbx_core::db::redis_driver::classify_command(&cmd_name);
    let centrally_approved_high_risk = safety == dbx_core::db::redis_driver::RedisCommandSafety::Blocked;
    if safety != dbx_core::db::redis_driver::RedisCommandSafety::Allowed {
        let policy_check = if centrally_approved_high_risk {
            ensure_mcp_write_allowed_with_risk(state, &config, &database, &format!("Redis command '{cmd_name}'"), true)
                .await
        } else {
            ensure_mcp_write_allowed(state, &config, &database, &format!("Redis command '{cmd_name}'")).await
        };
        if let Err(e) = policy_check {
            respond_error(stream, "403 Forbidden", &e).await;
            return;
        }
    }
    match dbx_core::redis_ops::redis_execute_command_core(
        state,
        &config.id,
        req.db,
        &req.command,
        centrally_approved_high_risk,
    )
    .await
    {
        Ok(result) => respond_json(stream, &result).await,
        Err(e) => respond_error(stream, "500 Internal Server Error", &e).await,
    }
}

async fn handle_execute_query_data(state: &Arc<AppState>, body: &str, stream: &mut tokio::net::TcpStream) {
    let req: ExecuteQueryRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(_) => {
            respond_error(stream, "400 Bad Request", "Invalid JSON").await;
            return;
        }
    };
    let config = match resolve_connection(state, req.connection_id.as_deref(), &req.connection_name).await {
        Ok(c) => c,
        Err(e) => {
            respond_error(stream, "404 Not Found", &e).await;
            return;
        }
    };
    let database = req.database.unwrap_or_else(|| config.database.clone().unwrap_or_default());
    if let Err(e) = check_visible_database(&config, &database) {
        respond_error(stream, "403 Forbidden", &e).await;
        return;
    }
    if let Err(e) = ensure_mcp_sql_allowed(state, &config, &database, &req.sql).await {
        respond_error(stream, "403 Forbidden", &e).await;
        return;
    }
    let statements = if config.db_type == crate::models::connection::DatabaseType::SqlServer {
        dbx_core::sql::split_sql_batches(&req.sql)
    } else {
        dbx_core::sql::split_sql_statements_for_database(&req.sql, config.db_type)
    };
    let statements = if statements.is_empty() { vec![req.sql] } else { statements };
    let mut last_result = None;
    for statement in statements {
        // Re-read both policy and connection settings immediately before every
        // statement so a settings change can stop the remainder of the batch.
        let current = match resolve_connection(state, Some(&config.id), &config.name).await {
            Ok(config) => config,
            Err(e) => {
                respond_error(stream, "403 Forbidden", &e).await;
                return;
            }
        };
        if let Err(e) = ensure_mcp_sql_allowed(state, &current, &database, &statement).await {
            respond_error(stream, "403 Forbidden", &e).await;
            return;
        }
        match dbx_core::query::execute_sql_statement(
            state,
            &current.id,
            &database,
            &statement,
            req.schema.as_deref(),
            None,
        )
        .await
        {
            Ok(result) => last_result = Some(result),
            Err(e) => {
                respond_error(stream, "500 Internal Server Error", &e).await;
                return;
            }
        }
    }
    if let Some(result) = last_result {
        respond_json(stream, &result).await;
    } else {
        respond_error(stream, "500 Internal Server Error", "No SQL statement to execute").await;
    }
}
