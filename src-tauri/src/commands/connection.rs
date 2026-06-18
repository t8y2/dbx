use std::collections::HashSet;
use std::sync::Arc;
use tauri::State;

pub use dbx_core::agent_connection::{
    agent_connect_params, mongo_legacy_error_with_auth_hint, mongo_uses_legacy_driver, oracle_alternate_connect_config,
    oracle_auth_fallback_profiles, oracle_error_with_driver_hint, should_retry_mongo_with_legacy_driver,
    should_retry_oracle_with_10g_driver,
};
pub use dbx_core::connection::{
    agent_connect_timeout, connect_bare_metadata_pool, connect_mysql_metadata_pool, connection_url_for_endpoint,
    metadata_connection_config, probe_connection_endpoint, redacted_connection_url_for_endpoint, AppState, MysqlMode,
    PoolKind,
};
use dbx_core::database_capabilities;
use dbx_core::db;
use dbx_core::db::agent_driver::AgentMethod;
use dbx_core::models::connection::{rewrite_jdbc_url_host, ConnectionConfig, DatabaseType};
pub use dbx_core::path_utils::expand_tilde;

fn mongo_legacy_connect_params(config: &ConnectionConfig, host: &str, port: u16) -> serde_json::Value {
    serde_json::json!({
        "connection": agent_connect_params(config, host, port, config.effective_database().unwrap_or(""))
    })
}

async fn test_agent_connection(
    state: &Arc<AppState>,
    config: &ConnectionConfig,
    host: &str,
    port: u16,
) -> Result<String, String> {
    let connect_params = agent_connect_params(config, host, port, config.database.as_deref().unwrap_or(""));
    let result = state
        .agent_manager
        .call_daemon_method_with_timeout::<serde_json::Value>(
            &config.db_type,
            config.driver_profile.as_deref(),
            AgentMethod::TestConnection,
            connect_params.clone(),
            Some(agent_connect_timeout(config)),
        )
        .await;

    if let Err(err) = result {
        if let Some(alternate_config) = oracle_alternate_connect_config(config, &err) {
            state
                .agent_manager
                .call_daemon_method_with_timeout::<serde_json::Value>(
                    &alternate_config.db_type,
                    alternate_config.driver_profile.as_deref(),
                    AgentMethod::TestConnection,
                    agent_connect_params(
                        &alternate_config,
                        host,
                        port,
                        alternate_config.database.as_deref().unwrap_or(""),
                    ),
                    Some(agent_connect_timeout(&alternate_config)),
                )
                .await
                .map_err(|alternate_err| {
                    format!("{err}\n\nFallback with alternate Oracle descriptor failed: {alternate_err}")
                })?;
        } else if should_retry_oracle_with_10g_driver(config, &err) {
            let mut fallback_errors = Vec::new();
            let mut connected = false;
            for profile in oracle_auth_fallback_profiles(config, &err) {
                match state
                    .agent_manager
                    .call_daemon_method_with_timeout::<serde_json::Value>(
                        &config.db_type,
                        Some(profile),
                        AgentMethod::TestConnection,
                        connect_params.clone(),
                        Some(agent_connect_timeout(config)),
                    )
                    .await
                {
                    Ok(_) => {
                        connected = true;
                        break;
                    }
                    Err(fallback_err) => fallback_errors.push(format!("{profile}: {fallback_err}")),
                }
            }
            if !connected {
                return Err(format!(
                    "{err}\n\nFallback with legacy Oracle drivers failed: {}",
                    fallback_errors.join("\n")
                ));
            }
        } else {
            return Err(oracle_error_with_driver_hint(config, &err));
        }
    }

    Ok("Connection successful".to_string())
}

async fn connect_agent_pool(
    state: &Arc<AppState>,
    config: &ConnectionConfig,
    host: &str,
    port: u16,
) -> Result<PoolKind, String> {
    let connect_params = agent_connect_params(config, host, port, config.effective_database().unwrap_or(""));
    let mut client = state.agent_manager.spawn(&config.db_type, config.driver_profile.as_deref()).await?;
    let connect_result = client
        .call_method_with_timeout::<serde_json::Value>(
            AgentMethod::Connect,
            connect_params.clone(),
            Some(agent_connect_timeout(config)),
        )
        .await;

    if let Err(err) = connect_result {
        if let Some(alternate_config) = oracle_alternate_connect_config(config, &err) {
            client
                .call_method_with_timeout::<serde_json::Value>(
                    AgentMethod::Connect,
                    agent_connect_params(
                        &alternate_config,
                        host,
                        port,
                        alternate_config.effective_database().unwrap_or(""),
                    ),
                    Some(agent_connect_timeout(&alternate_config)),
                )
                .await
                .map_err(|alternate_err| {
                    format!("{err}\n\nFallback with alternate Oracle descriptor failed: {alternate_err}")
                })?;
        } else if should_retry_oracle_with_10g_driver(config, &err) {
            let mut fallback_errors = Vec::new();
            let mut connected_client = None;
            for profile in oracle_auth_fallback_profiles(config, &err) {
                match state.agent_manager.spawn(&config.db_type, Some(profile)).await {
                    Ok(mut fallback_client) => {
                        match fallback_client
                            .call_method_with_timeout::<serde_json::Value>(
                                AgentMethod::Connect,
                                connect_params.clone(),
                                Some(agent_connect_timeout(config)),
                            )
                            .await
                        {
                            Ok(_) => {
                                connected_client = Some(fallback_client);
                                break;
                            }
                            Err(fallback_err) => fallback_errors.push(format!("{profile}: {fallback_err}")),
                        }
                    }
                    Err(fallback_err) => fallback_errors.push(format!("{profile}: {fallback_err}")),
                }
            }
            client = connected_client.ok_or_else(|| {
                format!("{err}\n\nFallback with legacy Oracle drivers failed: {}", fallback_errors.join("\n"))
            })?;
        } else {
            return Err(oracle_error_with_driver_hint(config, &err));
        }
    }

    Ok(PoolKind::Agent(Arc::new(tokio::sync::Mutex::new(client))))
}

#[cfg(test)]
mod tests {
    use super::{load_connection_configs, mongo_legacy_connect_params, save_connection_configs};
    use dbx_core::connection::{AppState, PoolKind};
    use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
    use dbx_core::storage::Storage;

    fn mongodb_config() -> ConnectionConfig {
        ConnectionConfig {
            id: "mongo".to_string(),
            name: "MongoDB".to_string(),
            db_type: DatabaseType::MongoDb,
            driver_profile: Some("mongodb".to_string()),
            driver_label: Some("MongoDB".to_string()),
            url_params: Some("authSource=admin&authMechanism=SCRAM-SHA-1".to_string()),
            host: "172.22.4.42".to_string(),
            port: 27017,
            username: "mongouser".to_string(),
            password: "secret".to_string(),
            database: Some("RestCloud_V45PUB_Gateway".to_string()),
            visible_databases: None,
            attached_databases: Vec::new(),
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
            connection_string: Some(
                "mongodb://mongouser:secret@172.22.4.42:27017/RestCloud_V45PUB_Gateway?authSource=admin".to_string(),
            ),
            redis_connection_mode: None,
            redis_sentinel_master: String::new(),
            redis_sentinel_nodes: String::new(),
            redis_sentinel_username: String::new(),
            redis_sentinel_password: String::new(),
            redis_sentinel_tls: false,
            redis_cluster_nodes: String::new(),
            redis_key_separator: dbx_core::models::connection::default_redis_key_separator(),
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: false,
        }
    }

    fn mq_config(id: &str, admin_url: &str) -> ConnectionConfig {
        let mut config = mongodb_config();
        config.id = id.to_string();
        config.name = "Pulsar".to_string();
        config.db_type = DatabaseType::MessageQueue;
        config.driver_profile = None;
        config.driver_label = None;
        config.url_params = None;
        config.host = String::new();
        config.port = 0;
        config.username = String::new();
        config.password = String::new();
        config.database = None;
        config.connection_string = None;
        config.external_config = Some(serde_json::json!({
            "systemKind": "pulsar",
            "adminUrl": admin_url,
            "auth": { "kind": "none" },
            "pinnedVersion": "3.1"
        }));
        config
    }

    #[test]
    fn mongo_legacy_connect_params_preserve_auth_options() {
        let config = mongodb_config();

        let params = mongo_legacy_connect_params(&config, "172.22.4.42", 27017);

        assert_eq!(params["connection"]["database"], "RestCloud_V45PUB_Gateway");
        assert_eq!(params["connection"]["url_params"], "authSource=admin&authMechanism=SCRAM-SHA-1");
        assert_eq!(
            params["connection"]["connection_string"],
            "mongodb://mongouser:secret@172.22.4.42:27017/RestCloud_V45PUB_Gateway?authSource=admin"
        );
    }

    #[cfg(feature = "mq-admin")]
    #[tokio::test]
    async fn save_connection_configs_updates_runtime_cache_and_drops_mq_adapter() {
        let dir = std::env::temp_dir().join(format!("dbx-tauri-conn-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = AppState::new_with_plugin_dir(storage, dir.join("plugins"));
        let initial = mq_config("mq-conn", "http://127.0.0.1:8080");
        state.configs.write().await.insert(initial.id.clone(), initial.clone());
        state.connections.write().await.insert(initial.id.clone(), PoolKind::MessageQueue);
        let first = state.mq_registry.get_or_build(&initial).await.unwrap();

        let updated = mq_config("mq-conn", "http://127.0.0.1:8081");
        save_connection_configs(&state, &[updated.clone()]).await.unwrap();

        let cached_admin_url = state
            .configs
            .read()
            .await
            .get("mq-conn")
            .and_then(|config| config.external_config.as_ref())
            .and_then(|external| external.get("adminUrl"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        assert_eq!(cached_admin_url.as_deref(), Some("http://127.0.0.1:8081"));

        let second = state.mq_registry.get_or_build(&updated).await.unwrap();
        assert!(!std::sync::Arc::ptr_eq(&first, &second));
        assert!(!state.connections.read().await.contains_key(&initial.id));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(feature = "mq-admin")]
    #[tokio::test]
    async fn load_connection_configs_syncs_runtime_cache_and_drops_stale_pool() {
        let dir = std::env::temp_dir().join(format!("dbx-tauri-conn-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = AppState::new_with_plugin_dir(storage, dir.join("plugins"));
        let initial = mq_config("mq-conn", "http://127.0.0.1:8080");
        let updated = mq_config("mq-conn", "http://127.0.0.1:8081");
        state.storage.save_connections(&[updated.clone()]).await.unwrap();
        state.configs.write().await.insert(initial.id.clone(), initial.clone());
        state.connections.write().await.insert(initial.id.clone(), PoolKind::MessageQueue);

        let loaded = load_connection_configs(&state).await.unwrap();

        assert_eq!(loaded.len(), 1);
        let cached_admin_url = state
            .configs
            .read()
            .await
            .get("mq-conn")
            .and_then(|config| config.external_config.as_ref())
            .and_then(|external| external.get("adminUrl"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        assert_eq!(cached_admin_url.as_deref(), Some("http://127.0.0.1:8081"));
        assert!(!state.connections.read().await.contains_key(&initial.id));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(feature = "mq-admin")]
    #[tokio::test]
    async fn save_connection_configs_removes_deleted_runtime_config_and_mq_adapter() {
        let dir = std::env::temp_dir().join(format!("dbx-tauri-conn-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = AppState::new_with_plugin_dir(storage, dir.join("plugins"));
        let kept = mongodb_config();
        let removed = mq_config("removed-mq", "http://127.0.0.1:8080");
        {
            let mut configs = state.configs.write().await;
            configs.insert(kept.id.clone(), kept.clone());
            configs.insert(removed.id.clone(), removed.clone());
        }
        let stale = state.mq_registry.get_or_build(&removed).await.unwrap();

        save_connection_configs(&state, &[kept.clone()]).await.unwrap();

        let configs = state.configs.read().await;
        assert!(configs.contains_key(&kept.id));
        assert!(!configs.contains_key("removed-mq"));
        drop(configs);

        let rebuilt = state.mq_registry.get_or_build(&removed).await.unwrap();
        assert!(!std::sync::Arc::ptr_eq(&stale, &rebuilt));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(feature = "mq-admin")]
    #[tokio::test]
    async fn save_connection_configs_removes_deleted_connection_pools() {
        let dir = std::env::temp_dir().join(format!("dbx-tauri-conn-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = AppState::new_with_plugin_dir(storage, dir.join("plugins"));
        let kept = mongodb_config();
        let removed = mq_config("removed-mq", "http://127.0.0.1:8080");
        {
            let mut configs = state.configs.write().await;
            configs.insert(kept.id.clone(), kept.clone());
            configs.insert(removed.id.clone(), removed.clone());
        }
        state.connections.write().await.insert(removed.id.clone(), PoolKind::MessageQueue);

        save_connection_configs(&state, &[kept.clone()]).await.unwrap();

        assert!(!state.connections.read().await.contains_key(&removed.id));

        let _ = std::fs::remove_dir_all(dir);
    }
}

#[tauri::command]
pub async fn save_connections(state: State<'_, Arc<AppState>>, configs: Vec<ConnectionConfig>) -> Result<(), String> {
    let configs: Vec<ConnectionConfig> = configs.into_iter().map(|config| config.canonicalized()).collect();
    save_connection_configs(state.inner(), &configs).await
}

async fn save_connection_configs(state: &AppState, configs: &[ConnectionConfig]) -> Result<(), String> {
    state.storage.save_connections(configs).await?;
    let sync = sync_connection_configs(state, configs).await;
    remove_connection_pools_for_connection_ids(state, &sync.connection_pool_ids_to_drop).await;
    drop_mq_adapters_for_connection_ids(state, &sync.mq_adapter_ids_to_drop).await;
    Ok(())
}

struct ConnectionConfigSync {
    mq_adapter_ids_to_drop: Vec<String>,
    connection_pool_ids_to_drop: Vec<String>,
}

async fn sync_connection_configs(state: &AppState, configs: &[ConnectionConfig]) -> ConnectionConfigSync {
    let saved_ids: HashSet<&str> = configs.iter().map(|config| config.id.as_str()).collect();
    let mut mq_adapter_ids_to_drop = HashSet::new();
    let mut connection_pool_ids_to_drop = HashSet::new();
    let mut runtime_configs = state.configs.write().await;
    runtime_configs.retain(|id, existing| {
        if saved_ids.contains(id.as_str()) || is_transient_runtime_config_id(id) {
            true
        } else {
            connection_pool_ids_to_drop.insert(id.clone());
            if existing.db_type == DatabaseType::MessageQueue {
                mq_adapter_ids_to_drop.insert(id.clone());
            }
            false
        }
    });
    for config in configs {
        if config.db_type == DatabaseType::MessageQueue {
            mq_adapter_ids_to_drop.insert(config.id.clone());
        }
        if let Some(previous) = runtime_configs.insert(config.id.clone(), config.clone()) {
            if previous.db_type == DatabaseType::MessageQueue {
                mq_adapter_ids_to_drop.insert(config.id.clone());
            }
            if &previous != config {
                connection_pool_ids_to_drop.insert(config.id.clone());
            }
        }
    }
    ConnectionConfigSync {
        mq_adapter_ids_to_drop: mq_adapter_ids_to_drop.into_iter().collect(),
        connection_pool_ids_to_drop: connection_pool_ids_to_drop.into_iter().collect(),
    }
}

fn is_transient_runtime_config_id(id: &str) -> bool {
    id.starts_with("__test_") || id.starts_with("__visible_draft_")
}

#[cfg(feature = "mq-admin")]
async fn drop_mq_adapters_for_connection_ids(state: &AppState, connection_ids: &[String]) {
    for connection_id in connection_ids {
        state.mq_registry.drop_connection(connection_id).await;
    }
}

#[cfg(not(feature = "mq-admin"))]
async fn drop_mq_adapters_for_connection_ids(_state: &AppState, _connection_ids: &[String]) {}

async fn remove_connection_pools_for_connection_ids(state: &AppState, connection_ids: &[String]) {
    for connection_id in connection_ids {
        state.remove_connection_pools(connection_id).await;
    }
}

#[tauri::command]
pub async fn load_connections(state: State<'_, Arc<AppState>>) -> Result<Vec<ConnectionConfig>, String> {
    load_connection_configs(state.inner()).await
}

async fn load_connection_configs(state: &AppState) -> Result<Vec<ConnectionConfig>, String> {
    let configs: Vec<ConnectionConfig> =
        state.storage.load_connections().await?.into_iter().map(|config| config.canonicalized()).collect();
    let sync = sync_connection_configs(state, &configs).await;
    remove_connection_pools_for_connection_ids(state, &sync.connection_pool_ids_to_drop).await;
    drop_mq_adapters_for_connection_ids(state, &sync.mq_adapter_ids_to_drop).await;
    Ok(configs)
}

#[tauri::command]
pub async fn save_sidebar_layout(state: State<'_, Arc<AppState>>, layout: serde_json::Value) -> Result<(), String> {
    state.storage.save_sidebar_layout(&layout).await
}

#[tauri::command]
pub async fn load_sidebar_layout(state: State<'_, Arc<AppState>>) -> Result<Option<serde_json::Value>, String> {
    state.storage.load_sidebar_layout().await
}

#[tauri::command]
pub async fn test_connection(state: State<'_, Arc<AppState>>, config: ConnectionConfig) -> Result<String, String> {
    let tunnel_id = format!("{}:test", config.id);
    let has_transport_layers = config.has_effective_transport_layers();
    let connection_id = if has_transport_layers { tunnel_id.as_str() } else { config.id.as_str() };
    let (host, port) = state.connection_host_port(connection_id, &config).await?;
    let probe_result = probe_connection_endpoint(&config, &host, port).await;
    let url = connection_url_for_endpoint(&config, &host, port);
    let target = redacted_connection_url_for_endpoint(&config, &host, port);
    let connect_timeout = std::time::Duration::from_secs(config.effective_connect_timeout_secs());
    let idle_timeout = std::time::Duration::from_secs(config.idle_timeout_secs);
    log::info!("[test_connection] db_type={:?} target={}", config.db_type, target);
    let result = match probe_result {
        Err(e) => Err(e),
        Ok(()) => match config.db_type {
            DatabaseType::Mysql if config.needs_bare_mysql() => {
                match db::mysql::connect_bare(&url, connect_timeout).await {
                    Ok(pool) => {
                        let _ = pool.disconnect().await;
                        Ok("Connection successful".to_string())
                    }
                    Err(e) => Err(e),
                }
            }
            DatabaseType::Mysql => {
                match db::mysql::connect_with_ca_cert(&url, Some(&config.ca_cert_path), connect_timeout).await {
                    Ok(pool) => {
                        let _ = pool.disconnect().await;
                        Ok("Connection successful".to_string())
                    }
                    Err(e) => Err(e),
                }
            }
            DatabaseType::Doris | DatabaseType::StarRocks | DatabaseType::ManticoreSearch => {
                match db::mysql::connect_bare(&url, connect_timeout).await {
                    Ok(pool) => {
                        let _ = pool.disconnect().await;
                        Ok("Connection successful".to_string())
                    }
                    Err(e) => Err(e),
                }
            }
            DatabaseType::Postgres
            | DatabaseType::Redshift
            | DatabaseType::Gaussdb
            | DatabaseType::Kwdb
            | DatabaseType::Questdb
            | DatabaseType::OpenGauss => match db::postgres::connect(&url, connect_timeout).await {
                Ok(pool) => {
                    pool.close();
                    Ok("Connection successful".to_string())
                }
                Err(e) => Err(e),
            },
            DatabaseType::Sqlite => {
                let extensions = db::sqlite::sqlite_extension_specs_from_url_params(config.url_params.as_deref())
                    .into_iter()
                    .map(|mut extension| {
                        extension.path = expand_tilde(&extension.path);
                        extension
                    })
                    .collect();
                match db::sqlite::connect_path_create_if_missing_with_extensions(
                    &expand_tilde(&config.host),
                    extensions,
                )
                .await
                {
                    Ok(_) => Ok("Connection successful".to_string()),
                    Err(e) => Err(e),
                }
            }
            DatabaseType::Redis => {
                let con = if config.uses_redis_cluster() {
                    state.connect_redis_cluster(&tunnel_id, &config).await?;
                    return Ok("Connection successful".to_string());
                } else if config.uses_redis_sentinel() {
                    db::redis_driver::connect_sentinel(&config).await?
                } else {
                    db::redis_driver::connect(&url, connect_timeout).await?
                };
                drop(con);
                Ok("Connection successful".to_string())
            }
            #[cfg(feature = "duckdb-bundled")]
            DatabaseType::DuckDb => {
                if state.duckdb_existing_pool_is_usable_for_config(&config).await? {
                    Ok("Connection successful".to_string())
                } else {
                    let con = db::duckdb_driver::connect_path(&expand_tilde(&config.host))?;
                    dbx_core::db::duckdb_driver::close_connection(con);
                    Ok("Connection successful".to_string())
                }
            }
            #[cfg(not(feature = "duckdb-bundled"))]
            DatabaseType::DuckDb => Err("DuckDB support not compiled (enable duckdb-bundled feature)".to_string()),
            DatabaseType::MongoDb => {
                if mongo_uses_legacy_driver(&config) {
                    let am = &state.agent_manager;
                    let mut client = am.spawn(&config.db_type, config.driver_profile.as_deref()).await?;
                    client
                        .connect(mongo_legacy_connect_params(&config, &host, port))
                        .await
                        .map_err(|err| mongo_legacy_error_with_auth_hint(&err))?;
                    client.disconnect().await.ok();
                    return Ok("Connection successful (via legacy driver)".to_string());
                }

                let native_err = match db::mongo_driver::connect(&url, connect_timeout, idle_timeout).await {
                    Ok(client) => {
                        match db::mongo_driver::test_connection(&client, connect_timeout, config.effective_database())
                            .await
                        {
                            Ok(()) => return Ok("Connection successful".to_string()),
                            Err(e) => e,
                        }
                    }
                    Err(e) => e,
                };
                if should_retry_mongo_with_legacy_driver(&native_err) {
                    let am = &state.agent_manager;
                    let mut client = am.spawn(&config.db_type, Some("mongodb-legacy")).await?;
                    client.connect(mongo_legacy_connect_params(&config, &host, port)).await.map_err(|err| {
                        format!(
                            "{native_err}\n\nFallback with MongoDB (Legacy) driver failed: {}",
                            mongo_legacy_error_with_auth_hint(&err)
                        )
                    })?;
                    client.disconnect().await.ok();
                    Ok("Connection successful (via legacy driver)".to_string())
                } else {
                    Err(native_err)
                }
            }
            DatabaseType::ClickHouse => {
                let username = if config.username.is_empty() { None } else { Some(config.username.clone()) };
                let password = if config.password.is_empty() { None } else { Some(config.password.clone()) };
                let client = db::clickhouse_driver::ChClient::new_with_ca_cert(
                    &url,
                    username,
                    password,
                    Some(&config.ca_cert_path),
                    connect_timeout,
                )?;
                db::clickhouse_driver::test_connection(&client, connect_timeout)
                    .await
                    .map(|_| "Connection successful".to_string())
            }
            DatabaseType::SqlServer => db::sqlserver::connect(
                &host,
                port,
                &config.username,
                &config.password,
                config.database.as_deref(),
                connect_timeout,
            )
            .await
            .map(|_| "Connection successful".to_string()),
            DatabaseType::Elasticsearch => {
                let mut client = db::elasticsearch_driver::EsClient::from_config(
                    &url,
                    Some(&config.username),
                    Some(&config.password),
                    config.ssl,
                    config.url_params.as_deref(),
                    connect_timeout,
                );
                db::elasticsearch_driver::test_connection(&mut client, connect_timeout)
                    .await
                    .map(|_| "Connection successful".to_string())
            }
            DatabaseType::Rqlite => {
                let client = db::rqlite_driver::RqliteClient::new(
                    &url,
                    config.url_params.as_deref(),
                    &config.username,
                    &config.password,
                    config.ssl,
                    connect_timeout,
                )?;
                db::rqlite_driver::test_connection(&client, connect_timeout)
                    .await
                    .map(|_| "Connection successful".to_string())
            }
            DatabaseType::Turso => {
                let auth_token = if !config.password.is_empty() {
                    config.password.clone()
                } else {
                    config
                        .url_params
                        .as_deref()
                        .and_then(|p| {
                            p.trim()
                                .trim_start_matches('?')
                                .split('&')
                                .filter_map(|pair| pair.split_once('='))
                                .find(|(key, _)| {
                                    let k = key.trim().to_ascii_lowercase();
                                    k == "auth_token" || k == "authtoken" || k == "auth-token"
                                })
                                .map(|(_, value)| value.trim().to_string())
                        })
                        .unwrap_or_default()
                };
                let client = db::turso_driver::TursoClient::new(&url, &auth_token, config.ssl, connect_timeout)?;
                db::turso_driver::test_connection(&client, connect_timeout)
                    .await
                    .map(|_| "Connection successful".to_string())
            }
            DatabaseType::InfluxDb => {
                let username = if config.username.is_empty() { None } else { Some(config.username.clone()) };
                let password = if config.password.is_empty() { None } else { Some(config.password.clone()) };
                let client = db::influxdb_driver::InfluxdbClient::new_with_ca_cert(
                    &url,
                    username,
                    password,
                    Some(&config.ca_cert_path),
                    connect_timeout,
                )?;
                db::influxdb_driver::test_connection(&client, connect_timeout)
                    .await
                    .map(|_| "Connection successful".to_string())
            }
            #[cfg(feature = "mq-admin")]
            DatabaseType::MessageQueue => {
                let mqc = state.mq_admin_config_for_connection(connection_id, &config).await?;
                let adapter = state.mq_registry.build_transient_config(mqc).await?;
                adapter.test_connection().await?;
                Ok("Connection successful".to_string())
            }
            #[cfg(not(feature = "mq-admin"))]
            DatabaseType::MessageQueue => {
                Err("Message queue admin support is not compiled in this build. Rebuild with the 'mq-admin' feature."
                    .to_string())
            }
            db_type if database_capabilities::is_agent_type(&db_type) => {
                test_agent_connection(state.inner(), &config, &host, port).await
            }
            DatabaseType::Jdbc => {
                let mut jdbc_config = config.clone();
                if host != config.host || port != config.port {
                    if let Some(ref url) = jdbc_config.connection_string {
                        jdbc_config.connection_string = Some(rewrite_jdbc_url_host(url, &host, port));
                    }
                }
                state.test_external_driver("jdbc", &jdbc_config).await
            }
            db_type => Err(format!("Unsupported database type: {db_type:?}")),
        },
    };

    if has_transport_layers {
        state.reset_connection_transport_for_config(&tunnel_id, &config).await;
    }

    result
}

#[tauri::command]
pub async fn connect_db(state: State<'_, Arc<AppState>>, config: ConnectionConfig) -> Result<String, String> {
    let config = config.canonicalized();
    let id = config.id.clone();
    let db_config = metadata_connection_config(&config);

    state.remove_connection_pools(&id).await;
    state.reset_connection_transport_for_config(&id, &db_config).await;

    let (host, port) = state.connection_host_port(&id, &db_config).await?;
    probe_connection_endpoint(&db_config, &host, port).await?;
    let url = connection_url_for_endpoint(&db_config, &host, port);
    let connect_timeout = std::time::Duration::from_secs(db_config.effective_connect_timeout_secs());
    let idle_timeout = std::time::Duration::from_secs(db_config.idle_timeout_secs);

    let pool = match db_config.db_type {
        DatabaseType::Mysql => {
            let (pool, mode) =
                connect_mysql_metadata_pool(&config, &db_config, &host, port, connect_timeout, 3).await?;
            PoolKind::Mysql(pool, mode)
        }
        DatabaseType::Doris | DatabaseType::StarRocks | DatabaseType::ManticoreSearch => PoolKind::Mysql(
            connect_bare_metadata_pool(&db_config, &host, port, connect_timeout, 3).await?,
            MysqlMode::Bare,
        ),
        DatabaseType::Postgres
        | DatabaseType::Redshift
        | DatabaseType::Gaussdb
        | DatabaseType::Kwdb
        | DatabaseType::Questdb
        | DatabaseType::OpenGauss => PoolKind::Postgres(db::postgres::connect(&url, connect_timeout).await?),
        DatabaseType::Sqlite => {
            let extensions = db::sqlite::sqlite_extension_specs_from_url_params(db_config.url_params.as_deref())
                .into_iter()
                .map(|mut extension| {
                    extension.path = expand_tilde(&extension.path);
                    extension
                })
                .collect();
            PoolKind::Sqlite(
                db::sqlite::connect_path_create_if_missing_with_extensions(&expand_tilde(&db_config.host), extensions)
                    .await?,
            )
        }
        DatabaseType::Redis => {
            let con = if db_config.uses_redis_cluster() {
                PoolKind::Redis(db::redis_driver::RedisConnection::Cluster(
                    state.connect_redis_cluster(&id, &db_config).await?,
                ))
            } else if db_config.uses_redis_sentinel() {
                PoolKind::Redis(db::redis_driver::RedisConnection::Direct(tokio::sync::Mutex::new(
                    db::redis_driver::connect_sentinel(&db_config).await?,
                )))
            } else {
                PoolKind::Redis(db::redis_driver::RedisConnection::Direct(tokio::sync::Mutex::new(
                    db::redis_driver::connect(&url, connect_timeout).await?,
                )))
            };
            con
        }
        #[cfg(feature = "duckdb-bundled")]
        DatabaseType::DuckDb => {
            let con = db::duckdb_driver::connect_path(&expand_tilde(&db_config.host))?;
            {
                let locked = con.lock().map_err(|e| e.to_string())?;
                for attached in &db_config.attached_databases {
                    dbx_core::schema::duckdb_attach_database(&locked, &attached.name, &expand_tilde(&attached.path))?;
                }
            }
            PoolKind::DuckDb(con)
        }
        #[cfg(not(feature = "duckdb-bundled"))]
        DatabaseType::DuckDb => return Err("DuckDB support not compiled (enable duckdb-bundled feature)".to_string()),
        DatabaseType::MongoDb => {
            if mongo_uses_legacy_driver(&db_config) {
                let mut client = state.agent_manager.spawn(&db_config.db_type, Some("mongodb-legacy")).await?;
                client
                    .connect(mongo_legacy_connect_params(&db_config, &host, port))
                    .await
                    .map_err(|err| mongo_legacy_error_with_auth_hint(&err))?;
                PoolKind::Agent(std::sync::Arc::new(tokio::sync::Mutex::new(client)))
            } else {
                let native_err = match db::mongo_driver::connect(&url, connect_timeout, idle_timeout).await {
                    Ok(client) => {
                        match db::mongo_driver::test_connection(
                            &client,
                            connect_timeout,
                            db_config.effective_database(),
                        )
                        .await
                        {
                            Ok(()) => {
                                state.configs.write().await.insert(id.clone(), config);
                                state.insert_connection_pool(id.clone(), PoolKind::MongoDb(client), &db_config).await;
                                return Ok(id);
                            }
                            Err(e) => e,
                        }
                    }
                    Err(e) => e,
                };
                if should_retry_mongo_with_legacy_driver(&native_err) {
                    log::info!("Native MongoDB driver failed ({native_err}), falling back to agent driver");
                    let mut client = state.agent_manager.spawn(&db_config.db_type, Some("mongodb-legacy")).await?;
                    client.connect(mongo_legacy_connect_params(&db_config, &host, port)).await.map_err(|err| {
                        format!(
                            "{native_err}\n\nFallback with MongoDB (Legacy) driver failed: {}",
                            mongo_legacy_error_with_auth_hint(&err)
                        )
                    })?;
                    PoolKind::Agent(std::sync::Arc::new(tokio::sync::Mutex::new(client)))
                } else {
                    return Err(native_err);
                }
            }
        }
        DatabaseType::ClickHouse => {
            let username = if db_config.username.is_empty() { None } else { Some(db_config.username.clone()) };
            let password = if db_config.password.is_empty() { None } else { Some(db_config.password.clone()) };
            log::info!("[connect_db] ClickHouse url={url} user={:?} has_pass={}", username, password.is_some());
            let client = db::clickhouse_driver::ChClient::new_with_ca_cert(
                &url,
                username,
                password,
                Some(&db_config.ca_cert_path),
                connect_timeout,
            )?;
            db::clickhouse_driver::test_connection(&client, connect_timeout).await?;
            PoolKind::ClickHouse(client)
        }
        DatabaseType::SqlServer => {
            let client = db::sqlserver::connect(
                &host,
                port,
                &db_config.username,
                &db_config.password,
                db_config.database.as_deref(),
                connect_timeout,
            )
            .await?;
            PoolKind::SqlServer(std::sync::Arc::new(tokio::sync::Mutex::new(client)))
        }
        DatabaseType::Elasticsearch => {
            let mut client = db::elasticsearch_driver::EsClient::from_config(
                &url,
                Some(&db_config.username),
                Some(&db_config.password),
                db_config.ssl,
                db_config.url_params.as_deref(),
                connect_timeout,
            );
            db::elasticsearch_driver::test_connection(&mut client, connect_timeout).await?;
            PoolKind::Elasticsearch(client)
        }
        DatabaseType::Rqlite => {
            let client = db::rqlite_driver::RqliteClient::new(
                &url,
                db_config.url_params.as_deref(),
                &db_config.username,
                &db_config.password,
                db_config.ssl,
                connect_timeout,
            )?;
            db::rqlite_driver::test_connection(&client, connect_timeout).await?;
            PoolKind::Rqlite(client)
        }
        DatabaseType::Turso => {
            let auth_token = if !db_config.password.is_empty() {
                db_config.password.clone()
            } else {
                db_config
                    .url_params
                    .as_deref()
                    .and_then(|p| {
                        p.trim()
                            .trim_start_matches('?')
                            .split('&')
                            .filter_map(|pair| pair.split_once('='))
                            .find(|(key, _)| {
                                let k = key.trim().to_ascii_lowercase();
                                k == "auth_token" || k == "authtoken" || k == "auth-token"
                            })
                            .map(|(_, value)| value.trim().to_string())
                    })
                    .unwrap_or_default()
            };
            let client = db::turso_driver::TursoClient::new(&url, &auth_token, db_config.ssl, connect_timeout)?;
            db::turso_driver::test_connection(&client, connect_timeout).await?;
            PoolKind::Turso(client)
        }
        DatabaseType::InfluxDb => {
            let username = if db_config.username.is_empty() { None } else { Some(db_config.username.clone()) };
            let password = if db_config.password.is_empty() { None } else { Some(db_config.password.clone()) };
            let client = db::influxdb_driver::InfluxdbClient::new_with_ca_cert(
                &url,
                username,
                password,
                Some(&db_config.ca_cert_path),
                connect_timeout,
            )?;
            db::influxdb_driver::test_connection(&client, connect_timeout).await?;
            PoolKind::InfluxDb(client)
        }
        #[cfg(feature = "mq-admin")]
        DatabaseType::MessageQueue => {
            let mqc = state.mq_admin_config_for_connection(&id, &config).await?;
            let adapter = state.mq_registry.build_transient_config(mqc).await?;
            adapter.test_connection().await?;
            PoolKind::MessageQueue
        }
        #[cfg(not(feature = "mq-admin"))]
        DatabaseType::MessageQueue => {
            return Err(
                "Message queue admin support is not compiled in this build. Rebuild with the 'mq-admin' feature."
                    .to_string(),
            );
        }
        db_type if database_capabilities::is_agent_type(&db_type) => {
            connect_agent_pool(state.inner(), &db_config, &host, port).await?
        }
        DatabaseType::Jdbc => state.external_driver_pool("jdbc", &db_config).await?,
        db_type => return Err(format!("Unsupported database type: {db_type:?}")),
    };

    state.insert_connection_pool(id.clone(), pool, &db_config).await;
    state.configs.write().await.insert(id.clone(), config);

    Ok(id)
}

#[tauri::command]
pub async fn connection_final_proxy_port(
    state: State<'_, Arc<AppState>>,
    config: ConnectionConfig,
) -> Result<u16, String> {
    let runtime_config = config.canonicalized();
    if !runtime_config.has_effective_transport_layers() {
        return Err("Connection has no configured transport layers".to_string());
    }

    let connection_id = runtime_config.id.clone();
    let db_config = metadata_connection_config(&runtime_config);
    state.configs.write().await.insert(connection_id.clone(), runtime_config);

    let (_, port) = state.connection_host_port(&connection_id, &db_config).await?;
    Ok(port)
}

#[tauri::command]
pub async fn disconnect_db(state: State<'_, Arc<AppState>>, connection_id: String) -> Result<(), String> {
    state.remove_connection_pools_detached(&connection_id).await;
    drop_mq_adapters_for_connection_ids(state.inner(), std::slice::from_ref(&connection_id)).await;
    state.reset_connection_transport(&connection_id).await;
    if connection_id.starts_with("__visible_draft_") {
        state.configs.write().await.remove(&connection_id);
    }
    Ok(())
}

#[tauri::command]
pub async fn close_database_connection(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
) -> Result<bool, String> {
    let database = database.trim();
    let database = if database.is_empty() { None } else { Some(database) };
    state.close_database_pool(&connection_id, database).await
}

#[tauri::command]
pub async fn refresh_connections(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.refresh_connections().await;
    Ok(())
}

/// Check whether a connection has read-only protection enabled.
/// Returns an error if the connection is read-only, preventing write operations.
pub async fn ensure_connection_writable(
    state: &Arc<AppState>,
    connection_id: &str,
    action: &str,
) -> Result<(), String> {
    if let Some(name) = dbx_core::query::connection_readonly_name(state, connection_id).await {
        return Err(format!(
            "Read-only mode: connection '{}' has read-only protection enabled. {} blocked.",
            name, action
        ));
    }
    Ok(())
}
