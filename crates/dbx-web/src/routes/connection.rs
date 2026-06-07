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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisconnectRequest {
    pub connection_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseDatabaseConnectionRequest {
    pub connection_id: String,
    pub database: String,
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
    let mut connections = app.connections.write().await;
    let temp_keys: Vec<String> = connections.keys().filter(|key| key.starts_with(&temp_id)).cloned().collect();
    for key in temp_keys {
        connections.remove(&key);
    }
    drop(connections);
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

    app.configs.write().await.insert(connection_id.clone(), config.clone());

    app.get_or_create_pool(&connection_id, None).await.map_err(AppError)?;

    Ok(Json(connection_id))
}

pub async fn disconnect_db(
    State(state): State<Arc<WebState>>,
    Json(body): Json<DisconnectRequest>,
) -> Result<Json<()>, AppError> {
    let app = &state.app;
    let mut connections = app.connections.write().await;

    let pool_prefix = format!("{}:", body.connection_id);
    let keys_to_remove: Vec<String> =
        connections.keys().filter(|k| *k == &body.connection_id || k.starts_with(&pool_prefix)).cloned().collect();
    for key in keys_to_remove {
        connections.remove(&key);
    }
    drop(connections);

    app.tunnels.stop_tunnel(&body.connection_id).await;
    app.proxy_tunnels.stop_tunnel(&body.connection_id).await;

    Ok(Json(()))
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
    cache_connection_configs(&state, &body.configs).await;
    Ok(Json(()))
}

pub async fn load_connections(State(state): State<Arc<WebState>>) -> Result<Json<Vec<ConnectionConfig>>, AppError> {
    let configs = state.app.storage.load_connections().await.map_err(AppError)?;
    cache_connection_configs(&state, &configs).await;
    Ok(Json(configs))
}

async fn cache_connection_configs(state: &WebState, configs: &[ConnectionConfig]) {
    let mut runtime_configs = state.app.configs.write().await;
    for config in configs {
        runtime_configs.insert(config.id.clone(), config.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::{disconnect_db, save_connections, DisconnectRequest, SaveConnectionsRequest};
    use crate::state::{LoginRateLimit, WebState};
    use axum::extract::State;
    use axum::Json;
    use dbx_core::connection::{AppState, PoolKind};
    use dbx_core::models::connection::{ConnectionConfig, DatabaseType, ProxyType};
    use dbx_core::storage::Storage;
    use std::collections::{HashMap, HashSet};
    use std::sync::Arc;
    use tokio::sync::{Mutex, RwLock};

    fn sqlite_config(id: &str, path: &str) -> ConnectionConfig {
        ConnectionConfig {
            id: id.to_string(),
            name: "SQLite".to_string(),
            db_type: DatabaseType::Sqlite,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            host: path.to_string(),
            port: 0,
            username: String::new(),
            password: String::new(),
            database: None,
            visible_databases: None,
            attached_databases: Vec::new(),
            color: None,
            ssh_enabled: false,
            ssh_host: String::new(),
            ssh_port: 22,
            ssh_user: String::new(),
            ssh_password: String::new(),
            ssh_key_path: String::new(),
            ssh_key_passphrase: String::new(),
            ssh_expose_lan: false,
            ssh_connect_timeout_secs: dbx_core::models::connection::default_ssh_connect_timeout_secs(),
            ssh_tunnels: Vec::new(),
            connect_timeout_secs: dbx_core::models::connection::default_connect_timeout_secs(),
            query_timeout_secs: dbx_core::models::connection::default_query_timeout_secs(),
            proxy_enabled: false,
            proxy_type: ProxyType::Socks5,
            proxy_host: String::new(),
            proxy_port: 1080,
            proxy_username: String::new(),
            proxy_password: String::new(),
            ssl: false,
            ca_cert_path: String::new(),
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
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
        }
    }

    async fn test_web_state() -> (Arc<WebState>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("dbx-web-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let app = Arc::new(AppState::new_with_plugin_dir(storage, dir.join("plugins")));
        let state = Arc::new(WebState {
            app,
            data_dir: dir.clone(),
            password_hash: RwLock::new(None),
            sessions: RwLock::new(HashSet::new()),
            sse_channels: RwLock::new(HashMap::new()),
            sql_file_executions: RwLock::new(HashMap::new()),
            login_rate_limit: Mutex::new(LoginRateLimit { fail_count: 0, locked_until: None }),
            export_files: RwLock::new(HashMap::new()),
        });
        (state, dir)
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

        let result =
            disconnect_db(State(state.clone()), Json(DisconnectRequest { connection_id: "conn".to_string() })).await;
        assert!(result.is_ok());

        let connections = state.app.connections.read().await;
        assert!(!connections.contains_key("conn"));
        assert!(connections.contains_key("conn2"));

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

        let result =
            disconnect_db(State(state.clone()), Json(DisconnectRequest { connection_id: "conn".to_string() })).await;
        assert!(result.is_ok());

        let configs = state.app.configs.read().await;
        assert!(configs.contains_key("conn"));

        let _ = std::fs::remove_dir_all(dir);
    }
}
