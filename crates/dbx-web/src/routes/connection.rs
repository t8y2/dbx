use std::collections::HashSet;
use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use dbx_core::models::connection::ConnectionConfig;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub config: ConnectionConfig,
    pub client_attempt: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisconnectRequest {
    pub connection_id: String,
    pub client_attempt: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseDatabaseConnectionRequest {
    pub connection_id: String,
    pub database: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionIdentifierQuoteRequest {
    pub connection_id: String,
    pub database: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveConnectionsRequest {
    pub configs: Vec<ConnectionConfig>,
}

pub async fn test_connection(
    State(state): State<Arc<WebState>>,
    Json(body): Json<ConnectRequest>,
) -> Result<Json<String>, AppError> {
    let config = body.config;
    let app = &state.app;

    // Store config temporarily
    let temp_id = format!("__test_{}", uuid::Uuid::new_v4());
    app.configs.write().await.insert(temp_id.clone(), config.clone());

    // Try to connect
    let result = app.get_or_create_pool(&temp_id, config.database.as_deref()).await;

    // Clean up any pool keys created for the temporary connection, including
    // database-scoped keys like "__test_uuid:database".
    app.remove_connection_pools(&temp_id).await;
    app.reset_connection_transport_for_config(&temp_id, &config).await;
    app.configs.write().await.remove(&temp_id);

    match result {
        Ok(_) => Ok(Json("Connection successful".to_string())),
        Err(e) => Err(AppError(e)),
    }
}

pub async fn connect_db(
    State(state): State<Arc<WebState>>,
    Json(body): Json<ConnectRequest>,
) -> Result<Json<String>, AppError> {
    let config = body.config;
    let app = &state.app;
    let connection_id = config.id.clone();
    let attempt = app.begin_connection_attempt_with_client_attempt(&connection_id, body.client_attempt).await;

    app.remove_connection_pools_detached(&connection_id).await;
    app.reset_connection_transport_for_config(&connection_id, &config).await;
    app.configs.write().await.insert(connection_id.clone(), config.clone());

    app.get_or_create_pool_for_connection_attempt(&connection_id, None, attempt).await.map_err(AppError)?;

    Ok(Json(connection_id))
}

pub async fn connection_final_proxy_port(
    State(state): State<Arc<WebState>>,
    Json(body): Json<ConnectRequest>,
) -> Result<Json<u16>, AppError> {
    let runtime_config = body.config.canonicalized();
    if !runtime_config.has_effective_transport_layers() {
        return Err(AppError("Connection has no configured transport layers".to_string()));
    }

    let app = &state.app;
    let connection_id = runtime_config.id.clone();
    let db_config = dbx_core::connection::metadata_connection_config(&runtime_config);
    app.configs.write().await.insert(connection_id.clone(), runtime_config);

    let (_, port) = app.connection_host_port(&connection_id, &db_config).await.map_err(AppError)?;
    Ok(Json(port))
}

pub async fn disconnect_db(
    State(state): State<Arc<WebState>>,
    Json(body): Json<DisconnectRequest>,
) -> Result<Json<()>, AppError> {
    let app = &state.app;

    let should_disconnect = if let Some(client_attempt) = body.client_attempt {
        app.supersede_connection_attempt_if_client_attempt(&body.connection_id, client_attempt).await
    } else {
        app.supersede_connection_attempt(&body.connection_id).await;
        true
    };
    if !should_disconnect {
        return Ok(Json(()));
    }
    app.remove_connection_pools_detached(&body.connection_id).await;
    app.nacos_registry.drop_connection(&body.connection_id).await;
    #[cfg(feature = "mq-admin")]
    app.mq_registry.drop_connection(&body.connection_id).await;
    app.reset_connection_transport(&body.connection_id).await;
    if body.connection_id.starts_with("__visible_draft_") || body.connection_id.starts_with("__visible_schema_draft_") {
        app.configs.write().await.remove(&body.connection_id);
    }

    Ok(Json(()))
}

pub async fn check_connection_health(
    State(state): State<Arc<WebState>>,
    Json(body): Json<DisconnectRequest>,
) -> Result<Json<()>, AppError> {
    state.app.check_connection_health(&body.connection_id).await.map_err(AppError)?;
    Ok(Json(()))
}

pub async fn connection_identifier_quote(
    State(state): State<Arc<WebState>>,
    Json(body): Json<ConnectionIdentifierQuoteRequest>,
) -> Result<Json<Option<String>>, AppError> {
    state
        .app
        .connection_identifier_quote(&body.connection_id, body.database.as_deref())
        .await
        .map(Json)
        .map_err(AppError)
}

pub async fn close_database_connection(
    State(state): State<Arc<WebState>>,
    Json(body): Json<CloseDatabaseConnectionRequest>,
) -> Result<Json<bool>, AppError> {
    let database = body.database.trim();
    let database = if database.is_empty() { None } else { Some(database) };
    state.app.close_database_pool(&body.connection_id, database).await.map(Json).map_err(AppError)
}

pub async fn save_connections(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SaveConnectionsRequest>,
) -> Result<Json<()>, AppError> {
    state.app.storage.save_connections(&body.configs).await.map_err(AppError)?;
    let sync = sync_connection_configs(&state, &body.configs).await;
    remove_connection_pools_for_connection_ids(&state, &sync.connection_pool_ids_to_drop).await;
    drop_nacos_adapters_for_connection_ids(&state, &sync.nacos_adapter_ids_to_drop).await;
    drop_mq_adapters_for_connection_ids(&state, &sync.mq_adapter_ids_to_drop).await;
    Ok(Json(()))
}

pub async fn load_connections(State(state): State<Arc<WebState>>) -> Result<Json<Vec<ConnectionConfig>>, AppError> {
    let configs = state.app.storage.load_connections().await.map_err(AppError)?;
    let sync = sync_connection_configs(&state, &configs).await;
    remove_connection_pools_for_connection_ids(&state, &sync.connection_pool_ids_to_drop).await;
    drop_nacos_adapters_for_connection_ids(&state, &sync.nacos_adapter_ids_to_drop).await;
    drop_mq_adapters_for_connection_ids(&state, &sync.mq_adapter_ids_to_drop).await;
    Ok(Json(configs))
}

struct ConnectionConfigSync {
    nacos_adapter_ids_to_drop: Vec<String>,
    mq_adapter_ids_to_drop: Vec<String>,
    connection_pool_ids_to_drop: Vec<String>,
}

async fn sync_connection_configs(state: &WebState, configs: &[ConnectionConfig]) -> ConnectionConfigSync {
    let saved_ids: HashSet<&str> = configs.iter().map(|config| config.id.as_str()).collect();
    let mut nacos_adapter_ids_to_drop = HashSet::new();
    let mut mq_adapter_ids_to_drop = HashSet::new();
    let mut connection_pool_ids_to_drop = HashSet::new();
    let mut runtime_configs = state.app.configs.write().await;
    runtime_configs.retain(|id, existing| {
        if saved_ids.contains(id.as_str()) || is_transient_runtime_config_id(id) {
            true
        } else {
            connection_pool_ids_to_drop.insert(id.clone());
            if existing.db_type == dbx_core::models::connection::DatabaseType::Nacos {
                nacos_adapter_ids_to_drop.insert(id.clone());
            }
            if existing.db_type == dbx_core::models::connection::DatabaseType::MessageQueue {
                mq_adapter_ids_to_drop.insert(id.clone());
            }
            false
        }
    });
    for config in configs {
        if config.db_type == dbx_core::models::connection::DatabaseType::Nacos {
            nacos_adapter_ids_to_drop.insert(config.id.clone());
        }
        if config.db_type == dbx_core::models::connection::DatabaseType::MessageQueue {
            mq_adapter_ids_to_drop.insert(config.id.clone());
        }
        if let Some(previous) = runtime_configs.insert(config.id.clone(), config.clone()) {
            if previous.db_type == dbx_core::models::connection::DatabaseType::Nacos {
                nacos_adapter_ids_to_drop.insert(config.id.clone());
            }
            if previous.db_type == dbx_core::models::connection::DatabaseType::MessageQueue {
                mq_adapter_ids_to_drop.insert(config.id.clone());
            }
            if &previous != config {
                connection_pool_ids_to_drop.insert(config.id.clone());
            }
        }
    }
    ConnectionConfigSync {
        nacos_adapter_ids_to_drop: nacos_adapter_ids_to_drop.into_iter().collect(),
        mq_adapter_ids_to_drop: mq_adapter_ids_to_drop.into_iter().collect(),
        connection_pool_ids_to_drop: connection_pool_ids_to_drop.into_iter().collect(),
    }
}

fn is_transient_runtime_config_id(id: &str) -> bool {
    id.starts_with("__test_") || id.starts_with("__visible_draft_") || id.starts_with("__visible_schema_draft_")
}

async fn drop_nacos_adapters_for_connection_ids(state: &WebState, connection_ids: &[String]) {
    for connection_id in connection_ids {
        state.app.nacos_registry.drop_connection(connection_id).await;
    }
}

#[cfg(feature = "mq-admin")]
async fn drop_mq_adapters_for_connection_ids(state: &WebState, connection_ids: &[String]) {
    for connection_id in connection_ids {
        state.app.mq_registry.drop_connection(connection_id).await;
    }
}

#[cfg(not(feature = "mq-admin"))]
async fn drop_mq_adapters_for_connection_ids(_state: &WebState, _connection_ids: &[String]) {}

async fn remove_connection_pools_for_connection_ids(state: &WebState, connection_ids: &[String]) {
    for connection_id in connection_ids {
        state.app.remove_connection_pools_detached(connection_id).await;
    }
}

#[cfg(test)]
mod tests {
    use super::{
        connect_db, disconnect_db, load_connections, save_connections, ConnectRequest, DisconnectRequest,
        SaveConnectionsRequest,
    };
    use crate::state::{LoginRateLimit, WebState};
    use axum::extract::State;
    use axum::Json;
    use dbx_core::connection::{AppState, PoolKind};
    use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
    use dbx_core::storage::Storage;
    use std::collections::{HashMap, HashSet};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::{Mutex, RwLock};

    fn sqlite_config(id: &str, path: &str) -> ConnectionConfig {
        ConnectionConfig {
            id: id.to_string(),
            name: "SQLite".to_string(),
            db_type: DatabaseType::Sqlite,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            agent_java_options: Vec::new(),
            host: path.to_string(),
            port: 0,
            username: String::new(),
            password: String::new(),
            database: None,
            visible_databases: None,
            visible_schemas: None,
            attached_databases: Vec::new(),
            init_script: None,
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: dbx_core::models::connection::default_connect_timeout_secs(),
            query_timeout_secs: dbx_core::models::connection::default_query_timeout_secs(),
            idle_timeout_secs: dbx_core::models::connection::default_idle_timeout_secs(),
            keepalive_interval_secs: dbx_core::models::connection::default_keepalive_interval_secs(),
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
            redis_key_separator: dbx_core::models::connection::default_redis_key_separator(),
            redis_scan_page_size: None,
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
        }
    }

    fn mq_config(id: &str, admin_url: &str) -> ConnectionConfig {
        let mut config = sqlite_config(id, "");
        config.name = "Pulsar".to_string();
        config.db_type = DatabaseType::MessageQueue;
        config.external_config = Some(serde_json::json!({
            "systemKind": "pulsar",
            "adminUrl": admin_url,
            "auth": { "kind": "none" },
            "pinnedVersion": "3.1"
        }));
        config
    }

    async fn test_web_state() -> (Arc<WebState>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("dbx-web-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let app = Arc::new(AppState::new_with_plugin_dir(storage, dir.join("plugins")));
        let state = Arc::new(WebState {
            app,
            data_dir: dir.clone(),
            public_base_path: "/".to_string(),
            password_disabled: false,
            password_hash: RwLock::new(None),
            sessions: RwLock::new(HashSet::new()),
            sse_channels: RwLock::new(HashMap::new()),
            sql_file_executions: RwLock::new(HashMap::new()),
            login_rate_limit: Mutex::new(LoginRateLimit { fail_count: 0, locked_until: None }),
            export_files: RwLock::new(HashMap::new()),
        });
        (state, dir)
    }

    async fn spawn_pulsar_clusters_server() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut buf = [0_u8; 1024];
                    let Ok(n) = stream.read(&mut buf).await else {
                        return;
                    };
                    let request = String::from_utf8_lossy(&buf[..n]);
                    let status =
                        if request.starts_with("GET /admin/v2/clusters ") { "200 OK" } else { "404 Not Found" };
                    let body = if status.starts_with("200") { r#"["ec-pulsar"]"# } else { r#"{"reason":"missing"}"# };
                    let response = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn save_connections_updates_runtime_config_cache() {
        let (state, dir) = test_web_state().await;
        let db_path = dir.join("app.db");
        let config = sqlite_config("sqlite-conn", &db_path.to_string_lossy());

        let result =
            save_connections(State(state.clone()), Json(SaveConnectionsRequest { configs: vec![config.clone()] }))
                .await;
        assert!(result.is_ok());

        let configs = state.app.configs.read().await;
        assert_eq!(configs.get("sqlite-conn").map(|c| c.host.as_str()), Some(config.host.as_str()));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn save_connections_drops_cached_mq_adapter_for_updated_config() {
        let (state, dir) = test_web_state().await;
        let initial = mq_config("mq-conn", "http://127.0.0.1:8080");
        state.app.configs.write().await.insert(initial.id.clone(), initial.clone());
        state.app.connections.write().await.insert(initial.id.clone(), PoolKind::MessageQueue);
        let first = state.app.mq_registry.get_or_build(&initial).await.unwrap();

        let updated = mq_config("mq-conn", "http://127.0.0.1:8081");
        let result =
            save_connections(State(state.clone()), Json(SaveConnectionsRequest { configs: vec![updated.clone()] }))
                .await;
        assert!(result.is_ok());

        let cached_admin_url = state
            .app
            .configs
            .read()
            .await
            .get("mq-conn")
            .and_then(|config| config.external_config.as_ref())
            .and_then(|external| external.get("adminUrl"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        assert_eq!(cached_admin_url.as_deref(), Some("http://127.0.0.1:8081"));

        let second = state.app.mq_registry.get_or_build(&updated).await.unwrap();
        assert!(!Arc::ptr_eq(&first, &second));
        assert!(!state.app.connections.read().await.contains_key(&initial.id));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(feature = "mq-admin")]
    #[tokio::test]
    async fn connect_db_rebuilds_mq_adapter_for_updated_config_with_same_id() {
        let (state, dir) = test_web_state().await;
        let initial = mq_config("mq-conn", "http://127.0.0.1:8080");
        state.app.configs.write().await.insert(initial.id.clone(), initial.clone());
        state.app.connections.write().await.insert(initial.id.clone(), PoolKind::MessageQueue);
        let first = state.app.mq_registry.get_or_build(&initial).await.unwrap();

        let updated = mq_config("mq-conn", &spawn_pulsar_clusters_server().await);
        let result =
            connect_db(State(state.clone()), Json(ConnectRequest { config: updated.clone(), client_attempt: None }))
                .await;
        assert!(result.is_ok());

        let second = state.app.mq_registry.get_or_build(&updated).await.unwrap();
        assert!(!Arc::ptr_eq(&first, &second));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn load_connections_drops_cached_pool_for_updated_config() {
        let (state, dir) = test_web_state().await;
        let initial = mq_config("mq-conn", "http://127.0.0.1:8080");
        let updated = mq_config("mq-conn", "http://127.0.0.1:8081");
        state.app.storage.save_connections(&[updated.clone()]).await.unwrap();
        state.app.configs.write().await.insert(initial.id.clone(), initial.clone());
        state.app.connections.write().await.insert(initial.id.clone(), PoolKind::MessageQueue);

        let result = load_connections(State(state.clone())).await;
        assert!(result.is_ok());

        let configs = state.app.configs.read().await;
        let cached_admin_url = configs
            .get("mq-conn")
            .and_then(|config| config.external_config.as_ref())
            .and_then(|external| external.get("adminUrl"))
            .and_then(serde_json::Value::as_str);
        assert_eq!(cached_admin_url, Some("http://127.0.0.1:8081"));
        drop(configs);
        assert!(!state.app.connections.read().await.contains_key(&initial.id));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(feature = "mq-admin")]
    #[tokio::test]
    async fn save_connections_removes_deleted_runtime_config_and_mq_adapter() {
        let (state, dir) = test_web_state().await;
        let kept = sqlite_config("kept", &dir.join("kept.db").to_string_lossy());
        let removed = mq_config("removed-mq", "http://127.0.0.1:8080");
        {
            let mut configs = state.app.configs.write().await;
            configs.insert(kept.id.clone(), kept.clone());
            configs.insert(removed.id.clone(), removed.clone());
        }
        let stale = state.app.mq_registry.get_or_build(&removed).await.unwrap();

        let result =
            save_connections(State(state.clone()), Json(SaveConnectionsRequest { configs: vec![kept.clone()] })).await;
        assert!(result.is_ok());

        let configs = state.app.configs.read().await;
        assert!(configs.contains_key("kept"));
        assert!(!configs.contains_key("removed-mq"));
        drop(configs);

        let rebuilt = state.app.mq_registry.get_or_build(&removed).await.unwrap();
        assert!(!Arc::ptr_eq(&stale, &rebuilt));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(feature = "mq-admin")]
    #[tokio::test]
    async fn save_connections_removes_deleted_connection_pools() {
        let (state, dir) = test_web_state().await;
        let kept = sqlite_config("kept", &dir.join("kept.db").to_string_lossy());
        let removed = mq_config("removed-mq", "http://127.0.0.1:8080");
        {
            let mut configs = state.app.configs.write().await;
            configs.insert(kept.id.clone(), kept.clone());
            configs.insert(removed.id.clone(), removed.clone());
        }
        state.app.connections.write().await.insert(removed.id.clone(), PoolKind::MessageQueue);

        let result =
            save_connections(State(state.clone()), Json(SaveConnectionsRequest { configs: vec![kept.clone()] })).await;
        assert!(result.is_ok());

        assert!(!state.app.connections.read().await.contains_key(&removed.id));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn disconnect_db_keeps_connections_with_similar_prefixes() {
        let (state, dir) = test_web_state().await;
        let conn_path = dir.join("conn.db");
        let conn2_path = dir.join("conn2.db");
        std::fs::File::create(&conn_path).unwrap();
        std::fs::File::create(&conn2_path).unwrap();
        let conn_pool = dbx_core::db::sqlite::connect_path(&conn_path.to_string_lossy()).await.unwrap();
        let conn2_pool = dbx_core::db::sqlite::connect_path(&conn2_path.to_string_lossy()).await.unwrap();

        {
            let mut connections = state.app.connections.write().await;
            connections.insert("conn".to_string(), PoolKind::Sqlite(conn_pool));
            connections.insert("conn2".to_string(), PoolKind::Sqlite(conn2_pool));
        }

        let result = disconnect_db(
            State(state.clone()),
            Json(DisconnectRequest { connection_id: "conn".to_string(), client_attempt: None }),
        )
        .await;
        assert!(result.is_ok());

        let connections = state.app.connections.read().await;
        assert!(!connections.contains_key("conn"));
        assert!(connections.contains_key("conn2"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn disconnect_db_ignores_stale_client_attempt_cancel() {
        let (state, dir) = test_web_state().await;
        let conn_path = dir.join("conn.db");
        std::fs::File::create(&conn_path).unwrap();
        let conn_pool = dbx_core::db::sqlite::connect_path(&conn_path.to_string_lossy()).await.unwrap();
        state.app.begin_connection_attempt_with_client_attempt("conn", Some(1)).await;
        let current_attempt = state.app.begin_connection_attempt_with_client_attempt("conn", Some(2)).await;
        state.app.connections.write().await.insert("conn".to_string(), PoolKind::Sqlite(conn_pool));

        let result = disconnect_db(
            State(state.clone()),
            Json(DisconnectRequest { connection_id: "conn".to_string(), client_attempt: Some(1) }),
        )
        .await;
        assert!(result.is_ok());

        assert!(state.app.connections.read().await.contains_key("conn"));
        assert!(state.app.ensure_current_connection_attempt("conn", Some(current_attempt)).await.is_ok());

        let result = disconnect_db(
            State(state.clone()),
            Json(DisconnectRequest { connection_id: "conn".to_string(), client_attempt: Some(2) }),
        )
        .await;
        assert!(result.is_ok());

        assert!(!state.app.connections.read().await.contains_key("conn"));
        assert!(state.app.ensure_current_connection_attempt("conn", Some(current_attempt)).await.is_err());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn disconnect_db_keeps_connection_config_for_reconnect() {
        let (state, dir) = test_web_state().await;
        let conn_path = dir.join("conn.db");
        std::fs::File::create(&conn_path).unwrap();
        let conn_pool = dbx_core::db::sqlite::connect_path(&conn_path.to_string_lossy()).await.unwrap();

        {
            let mut connections = state.app.connections.write().await;
            connections.insert("conn".to_string(), PoolKind::Sqlite(conn_pool));
        }
        {
            let mut configs = state.app.configs.write().await;
            configs.insert("conn".to_string(), sqlite_config("conn", &conn_path.to_string_lossy()));
        }

        let result = disconnect_db(
            State(state.clone()),
            Json(DisconnectRequest { connection_id: "conn".to_string(), client_attempt: None }),
        )
        .await;
        assert!(result.is_ok());

        let configs = state.app.configs.read().await;
        assert!(configs.contains_key("conn"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(feature = "mq-admin")]
    #[tokio::test]
    async fn disconnect_db_drops_cached_mq_adapter() {
        let (state, dir) = test_web_state().await;
        let config = mq_config("mq-conn", "http://127.0.0.1:8080");
        state.app.configs.write().await.insert(config.id.clone(), config.clone());
        state.app.connections.write().await.insert(config.id.clone(), PoolKind::MessageQueue);
        let first = state.app.mq_registry.get_or_build(&config).await.unwrap();

        let result = disconnect_db(
            State(state.clone()),
            Json(DisconnectRequest { connection_id: config.id.clone(), client_attempt: None }),
        )
        .await;
        assert!(result.is_ok());

        assert!(!state.app.connections.read().await.contains_key(&config.id));
        let second = state.app.mq_registry.get_or_build(&config).await.unwrap();
        assert!(!Arc::ptr_eq(&first, &second));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn disconnect_db_removes_visible_database_draft_config() {
        let (state, dir) = test_web_state().await;
        let conn_path = dir.join("draft.db");
        let draft_id = "__visible_draft_test";
        std::fs::File::create(&conn_path).unwrap();

        {
            let mut configs = state.app.configs.write().await;
            configs.insert(draft_id.to_string(), sqlite_config(draft_id, &conn_path.to_string_lossy()));
        }

        let result = disconnect_db(
            State(state.clone()),
            Json(DisconnectRequest { connection_id: draft_id.to_string(), client_attempt: None }),
        )
        .await;
        assert!(result.is_ok());

        let configs = state.app.configs.read().await;
        assert!(!configs.contains_key(draft_id));

        let _ = std::fs::remove_dir_all(dir);
    }
}
