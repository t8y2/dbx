use std::collections::HashSet;
use std::sync::Arc;
use tauri::State;

pub use dbx_core::agent_connection::{
    agent_connect_params, mongo_legacy_error_with_auth_hint, mongo_uses_legacy_driver, oracle_alternate_connect_config,
    oracle_error_with_driver_hint, should_retry_mongo_with_legacy_driver,
};
pub use dbx_core::connection::{
    agent_connect_timeout, connect_bare_metadata_pool, connect_mysql_metadata_pool, connection_configs_pool_equivalent,
    connection_configs_session_credentials_compatible, connection_url_for_endpoint, gaussdb_m_jdbc_config_for_endpoint,
    gaussdb_uses_m_jdbc_driver, metadata_connection_config, prestosql_jdbc_config_for_endpoint,
    probe_connection_endpoint, redacted_connection_url_for_endpoint, AppState, MysqlMode, PoolKind,
};
use dbx_core::database_capabilities;
use dbx_core::db;
use dbx_core::db::agent_driver::{AgentDriverClient, AgentMethod};
use dbx_core::models::connection::{
    database_info_from_protocol_value, rewrite_jdbc_url_host, ConnectionConfig, ConnectionTestResult,
    DatabaseConnectionInfo, DatabaseType,
};
pub use dbx_core::path_utils::expand_tilde;
use dbx_core::runtime_config::{release_runtime_config_on_disconnect, should_retain_runtime_config};

const MONGO_LEGACY_DRIVER_PROFILE: &str = "mongodb-legacy";
const MONGO_LEGACY_DRIVER_LABEL: &str = "MongoDB (Legacy)";

fn gaussdb_m_jdbc_command_config(config: &ConnectionConfig, host: &str, port: u16) -> Option<ConnectionConfig> {
    gaussdb_uses_m_jdbc_driver(config).then(|| gaussdb_m_jdbc_config_for_endpoint(config, host, port))
}

fn jdbc_command_config_for_endpoint(
    config: &ConnectionConfig,
    host: &str,
    port: u16,
) -> Result<ConnectionConfig, String> {
    let mut jdbc_config = config.clone();
    if host != config.host || port != config.port {
        if let Some(ref url) = jdbc_config.connection_string {
            jdbc_config.connection_string = Some(rewrite_jdbc_url_host(url, host, port)?);
        }
    }
    Ok(jdbc_config)
}

fn mongo_legacy_connect_params(config: &ConnectionConfig, host: &str, port: u16) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "connection": agent_connect_params(config, host, port, config.effective_database().unwrap_or(""))?
    }))
}

fn mongo_legacy_fallback_error(native_error: &str, stage: &str, fallback_error: &str) -> String {
    format!("{native_error}\n\n{stage}: {fallback_error}")
}

async fn spawn_mongo_legacy_fallback_agent(
    state: &AppState,
    db_type: &DatabaseType,
    native_error: &str,
) -> Result<AgentDriverClient, String> {
    let agent_key =
        dbx_core::agent_manager::AgentManager::db_type_to_agent_key(db_type, Some(MONGO_LEGACY_DRIVER_PROFILE))
            .ok_or_else(|| {
                mongo_legacy_fallback_error(
                    native_error,
                    "Failed to prepare MongoDB (Legacy) fallback driver",
                    "Agent mapping is unavailable",
                )
            })?;
    dbx_core::agent_service::ensure_agent_driver_ready(&state.agent_manager, agent_key).await.map_err(|error| {
        mongo_legacy_fallback_error(native_error, "Failed to prepare MongoDB (Legacy) fallback driver", &error)
    })?;
    state.agent_manager.spawn(db_type, Some(MONGO_LEGACY_DRIVER_PROFILE)).await.map_err(|error| {
        mongo_legacy_fallback_error(
            native_error,
            "Fallback with MongoDB (Legacy) driver failed",
            &mongo_legacy_error_with_auth_hint(&error),
        )
    })
}

fn mark_mongo_legacy_driver(config: &mut ConnectionConfig) -> bool {
    if config.db_type != DatabaseType::MongoDb {
        return false;
    }
    let changed = config.driver_profile.as_deref() != Some(MONGO_LEGACY_DRIVER_PROFILE)
        || config.driver_label.as_deref() != Some(MONGO_LEGACY_DRIVER_LABEL);
    config.driver_profile = Some(MONGO_LEGACY_DRIVER_PROFILE.to_string());
    config.driver_label = Some(MONGO_LEGACY_DRIVER_LABEL.to_string());
    changed
}

async fn persist_mongo_legacy_driver_profile(state: &AppState, config: &ConnectionConfig) -> Result<bool, String> {
    if config.one_time {
        return Ok(true);
    }
    state
        .storage
        .save_connection_driver_profile(
            config,
            Some(MONGO_LEGACY_DRIVER_PROFILE.to_string()),
            Some(MONGO_LEGACY_DRIVER_LABEL.to_string()),
        )
        .await
}

async fn test_agent_connection(
    state: &Arc<AppState>,
    config: &ConnectionConfig,
    host: &str,
    port: u16,
) -> Result<ConnectionTestResult, String> {
    let connect_params = agent_connect_params(config, host, port, config.database.as_deref().unwrap_or(""))?;
    let result = state
        .agent_manager
        .call_daemon_method_with_timeout::<serde_json::Value>(
            &config.db_type,
            config.driver_profile.as_deref(),
            AgentMethod::TestConnection,
            connect_params,
            Some(agent_connect_timeout(config)),
        )
        .await;

    let response = match result {
        Ok(response) => response,
        Err(err) => {
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
                        )?,
                        Some(agent_connect_timeout(&alternate_config)),
                    )
                    .await
                    .map_err(|alternate_err| {
                        format!("{err}\n\nFallback with alternate Oracle descriptor failed: {alternate_err}")
                    })?
            } else {
                return Err(oracle_error_with_driver_hint(config, &err));
            }
        }
    };

    Ok(ConnectionTestResult::success("Connection successful")
        .with_database_info(database_info_from_protocol_value(&response)))
}

async fn optional_mysql_database_info(
    pool: &db::mysql::MySqlPool,
    config: &ConnectionConfig,
) -> Option<DatabaseConnectionInfo> {
    match db::mysql::database_connection_info(pool, db::mysql::protocol_product_name(config)).await {
        Ok(info) => Some(info),
        Err(error) => {
            log::warn!("Failed to read optional MySQL database information: {error}");
            None
        }
    }
}

async fn connect_agent_pool(
    state: &Arc<AppState>,
    config: &ConnectionConfig,
    host: &str,
    port: u16,
) -> Result<PoolKind, String> {
    let connect_params = agent_connect_params(config, host, port, config.effective_database().unwrap_or(""))?;
    let mut client = state.agent_manager.spawn(&config.db_type, config.driver_profile.as_deref()).await?;
    let connect_result = client
        .call_method_with_timeout::<serde_json::Value>(
            AgentMethod::Connect,
            connect_params,
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
                    )?,
                    Some(agent_connect_timeout(&alternate_config)),
                )
                .await
                .map_err(|alternate_err| {
                    format!("{err}\n\nFallback with alternate Oracle descriptor failed: {alternate_err}")
                })?;
        } else {
            return Err(oracle_error_with_driver_hint(config, &err));
        }
    }

    Ok(PoolKind::agent(client))
}

#[cfg(test)]
mod tests {
    #[cfg(feature = "mq-admin")]
    use super::load_connection_configs;
    use super::{
        connect_sqlite_from_config, gaussdb_m_jdbc_command_config, jdbc_command_config_for_endpoint,
        mark_mongo_legacy_driver, mongo_legacy_connect_params, mongo_legacy_fallback_error,
        persist_mongo_legacy_driver_profile, save_connection_configs, sync_connection_configs,
        MONGO_LEGACY_DRIVER_LABEL, MONGO_LEGACY_DRIVER_PROFILE,
    };
    use dbx_core::connection::{AppState, PoolKind};
    use dbx_core::models::connection::{AttachedDatabaseConfig, ConnectionConfig, DatabaseType};
    use dbx_core::storage::Storage;

    fn mongodb_config() -> ConnectionConfig {
        ConnectionConfig {
            docs_notes_path: None,
            id: "mongo".to_string(),
            name: "MongoDB".to_string(),
            note: String::new(),
            db_type: DatabaseType::MongoDb,
            driver_profile: Some("mongodb".to_string()),
            driver_label: Some("MongoDB".to_string()),
            url_params: Some("authSource=admin&authMechanism=SCRAM-SHA-1".to_string()),
            agent_java_options: Vec::new(),
            host: "172.22.4.42".to_string(),
            port: 27017,
            username: "mongouser".to_string(),
            password: "secret".to_string(),
            database: Some("RestCloud_V45PUB_Gateway".to_string()),
            default_schema: None,
            visible_databases: None,
            visible_database_patterns: None,
            visible_schemas: None,
            show_system_schemas: false,
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
            redis_scan_page_size: None,
            redis_database_aliases: Default::default(),
            redis_key_templates: Vec::new(),
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            save_password: true,
            read_only: false,
            is_production: false,
            production_databases: vec![],
            database_info: None,
        }
    }

    fn sqlite_config(path: &std::path::Path, password: &str) -> ConnectionConfig {
        let mut config = mongodb_config();
        config.id = "sqlite".to_string();
        config.name = "SQLite".to_string();
        config.db_type = DatabaseType::Sqlite;
        config.driver_profile = None;
        config.driver_label = None;
        config.url_params = None;
        config.host = path.to_string_lossy().to_string();
        config.port = 0;
        config.username = String::new();
        config.password = password.to_string();
        config.database = None;
        config.connection_string = None;
        config
    }

    fn nacos_config(id: &str) -> ConnectionConfig {
        let mut config = mongodb_config();
        config.id = id.to_string();
        config.name = "Nacos".to_string();
        config.db_type = DatabaseType::Nacos;
        config.driver_profile = None;
        config.driver_label = None;
        config.url_params = None;
        config.host = "127.0.0.1".to_string();
        config.port = 8848;
        config.username = "ordinary-user".to_string();
        config.password.clear();
        config.database = None;
        config.connection_string = None;
        config.save_password = false;
        config.visible_databases = Some(vec!["namespace-a".to_string()]);
        config.external_config = Some(serde_json::json!({
            "implementation": "nacos",
            "versionMode": "v3",
            "apiPlane": "admin",
            "serverAddr": "http://127.0.0.1:8848",
            "managedNamespaces": ["namespace-a"],
            "auth": {
                "kind": "usernamePassword",
                "username": "ordinary-user",
                "password": "old-password"
            }
        }));
        config
    }

    #[tokio::test]
    async fn sqlite_connect_from_config_restores_attached_databases() {
        let dir = std::env::temp_dir().join(format!("dbx-tauri-sqlite-attach-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let main_path = dir.join("main.sqlite");
        let attached_path = dir.join("analytics.sqlite");
        drop(dbx_core::db::sqlite::connect_path_create_if_missing(main_path.to_str().unwrap()).await.unwrap());
        let attached =
            dbx_core::db::sqlite::connect_path_create_if_missing(attached_path.to_str().unwrap()).await.unwrap();
        dbx_core::db::sqlite::execute_query(&attached, "CREATE TABLE events(id INTEGER PRIMARY KEY);").await.unwrap();
        drop(attached);

        let mut config = sqlite_config(&main_path, "");
        config.attached_databases.push(AttachedDatabaseConfig {
            name: "analytics".to_string(),
            path: attached_path.to_string_lossy().to_string(),
        });

        let pool = connect_sqlite_from_config(&config).await.expect("open SQLite connection with attachments");
        let count = pool
            .with_connection(|conn| {
                conn.query_row(
                    "SELECT count(*) FROM analytics.sqlite_master WHERE type = 'table' AND name = 'events'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|error| error.to_string())
            })
            .expect("query attached SQLite database");
        assert_eq!(count, 1);

        drop(pool);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn sqlite_connect_from_config_rejects_sqlcipher_attachments_before_opening_files() {
        let mut config = sqlite_config(std::path::Path::new("/missing/main.sqlite"), "secret");
        config.attached_databases.push(AttachedDatabaseConfig {
            name: "analytics".to_string(),
            path: "/missing/analytics.sqlite".to_string(),
        });

        let error = match connect_sqlite_from_config(&config).await {
            Ok(_) => panic!("SQLCipher attachments must be rejected"),
            Err(error) => error,
        };
        assert!(error.contains("encrypted connections"), "{error}");
    }

    #[tokio::test]
    async fn saving_memory_sqlite_attachments_keeps_the_live_pool_intact() {
        let dir = std::env::temp_dir().join(format!("dbx-tauri-sqlite-memory-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = AppState::new_with_plugin_dir(storage, dir.join("plugins"));
        let initial = sqlite_config(std::path::Path::new(":memory:"), "");
        let pool = dbx_core::db::sqlite::connect_path(":memory:").await.unwrap();
        dbx_core::db::sqlite::execute_query(
            &pool,
            "CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('yes');",
        )
        .await
        .unwrap();
        state.configs.write().await.insert(initial.id.clone(), initial.clone());
        state.connections.write().await.insert(initial.id.clone(), PoolKind::Sqlite(pool.clone()));

        let mut invalid = initial.clone();
        invalid.attached_databases.push(AttachedDatabaseConfig {
            name: "analytics".to_string(),
            path: dir.join("analytics.sqlite").to_string_lossy().to_string(),
        });
        let error = save_connection_configs(&state, &[invalid]).await.unwrap_err();

        assert!(error.contains("in-memory main database"), "{error}");
        assert!(state.connections.read().await.contains_key(&initial.id));
        assert_eq!(state.configs.read().await.get(&initial.id), Some(&initial));
        let retained = dbx_core::db::sqlite::execute_query(&pool, "SELECT value FROM retained;").await.unwrap();
        assert_eq!(retained.rows[0][0], serde_json::json!("yes"));

        drop(pool);
        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(feature = "mq-admin")]
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
    fn gaussdb_m_commands_select_vendor_jdbc_config() {
        let mut config = mongodb_config();
        config.db_type = DatabaseType::Gaussdb;
        config.driver_profile = Some("gaussdb-m".to_string());
        config.host = "gaussdb.internal".to_string();
        config.port = 8000;
        config.database = Some("app".to_string());
        config.url_params = None;
        config.connection_string = None;

        let jdbc = gaussdb_m_jdbc_command_config(&config, "127.0.0.1", 18000).unwrap();
        assert_eq!(
            jdbc.connection_string.as_deref(),
            Some("jdbc:gaussdb://127.0.0.1:18000/app?sslmode=prefer&ssl=true")
        );
        assert_eq!(jdbc.jdbc_driver_class.as_deref(), Some("com.huawei.gaussdb.jdbc.Driver"));

        config.driver_profile = Some("gaussdb".to_string());
        assert!(gaussdb_m_jdbc_command_config(&config, "127.0.0.1", 18000).is_none());
    }

    #[test]
    fn jdbc_command_config_rewrites_url_for_transport_endpoint() {
        let mut config = mongodb_config();
        config.db_type = DatabaseType::Jdbc;
        config.host = "db.example.test".to_string();
        config.port = 3306;
        config.connection_string = Some("jdbc:mysql://db.example.test:3306".to_string());

        let tunneled = jdbc_command_config_for_endpoint(&config, "127.0.0.1", 45678).unwrap();
        assert_eq!(tunneled.connection_string.as_deref(), Some("jdbc:mysql://127.0.0.1:45678"));

        let direct = jdbc_command_config_for_endpoint(&config, &config.host, config.port).unwrap();
        assert_eq!(direct.connection_string, config.connection_string);
    }

    #[test]
    fn jdbc_command_config_rejects_named_instance_url_for_transport_endpoint() {
        let mut config = mongodb_config();
        config.db_type = DatabaseType::Jdbc;
        config.host = "db.example.test".to_string();
        config.port = 1433;
        config.connection_string =
            Some(r"jdbc:sqlserver://db.example.test\SQLEXPRESS:1433;databaseName=app".to_string());

        let err = jdbc_command_config_for_endpoint(&config, "127.0.0.1", 45678).unwrap_err();
        assert!(err.to_lowercase().contains("named instance"), "{err}");

        let direct = jdbc_command_config_for_endpoint(&config, &config.host, config.port).unwrap();
        assert_eq!(direct.connection_string, config.connection_string);
    }

    #[test]
    fn mongo_legacy_connect_params_preserve_auth_options() {
        let config = mongodb_config();

        let params = mongo_legacy_connect_params(&config, "172.22.4.42", 27017).unwrap();

        assert_eq!(params["connection"]["database"], "RestCloud_V45PUB_Gateway");
        assert_eq!(params["connection"]["url_params"], "authSource=admin&authMechanism=SCRAM-SHA-1");
        assert_eq!(
            params["connection"]["connection_string"],
            "mongodb://mongouser:secret@172.22.4.42:27017/RestCloud_V45PUB_Gateway?authSource=admin"
        );
    }

    #[test]
    fn mark_mongo_legacy_driver_updates_profile_and_label() {
        let mut config = mongodb_config();

        assert!(mark_mongo_legacy_driver(&mut config));
        assert_eq!(config.driver_profile.as_deref(), Some(MONGO_LEGACY_DRIVER_PROFILE));
        assert_eq!(config.driver_label.as_deref(), Some(MONGO_LEGACY_DRIVER_LABEL));
        assert!(!mark_mongo_legacy_driver(&mut config));
    }

    #[test]
    fn automatic_mongo_desktop_paths_share_the_ensure_helper() {
        let source = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/commands/connection.rs"));
        let helper_call = ["spawn_mongo_legacy_fallback_", "agent("].concat();
        let ensure_call = ["ensure_agent_driver_", "ready("].concat();

        assert_eq!(source.matches(&helper_call).count(), 3);
        assert_eq!(source.matches(&ensure_call).count(), 1);
    }

    #[test]
    fn mongo_legacy_fallback_error_preserves_native_and_agent_errors() {
        let error = mongo_legacy_fallback_error(
            "native wire version error",
            "Failed to prepare MongoDB (Legacy) fallback driver",
            "registry unavailable",
        );

        assert_eq!(
            error,
            "native wire version error\n\nFailed to prepare MongoDB (Legacy) fallback driver: registry unavailable"
        );
    }

    #[tokio::test]
    async fn persist_mongo_legacy_driver_profile_updates_only_the_target_connection() {
        let dir = std::env::temp_dir().join(format!("dbx-tauri-mongo-profile-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = AppState::new_with_plugin_dir(storage, dir.join("plugins"));
        let mongo = mongodb_config();
        let mut other = mongodb_config();
        other.id = "other".to_string();
        other.name = "Other MongoDB".to_string();
        state.storage.save_connections(&[mongo.clone(), other.clone()]).await.unwrap();

        persist_mongo_legacy_driver_profile(&state, &mongo).await.unwrap();

        let saved = state.storage.load_connections().await.unwrap();
        let updated = saved.iter().find(|config| config.id == mongo.id).unwrap();
        assert_eq!(updated.driver_profile.as_deref(), Some(MONGO_LEGACY_DRIVER_PROFILE));
        assert_eq!(updated.driver_label.as_deref(), Some(MONGO_LEGACY_DRIVER_LABEL));
        assert_eq!(saved.iter().find(|config| config.id == other.id), Some(&other));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(any(feature = "sqlite-sqlcipher", feature = "sqlite-multiple-ciphers"))]
    #[tokio::test]
    async fn sqlite_connect_from_config_uses_sqlcipher_key() {
        let path = std::env::temp_dir().join(format!("dbx-tauri-sqlcipher-{}.db", uuid::Uuid::new_v4()));
        let key = "dbx-pass";

        {
            let pool =
                dbx_core::db::sqlite::connect_path_create_if_missing_with_cipher_key(path.to_str().unwrap(), key)
                    .await
                    .expect("create encrypted sqlite");
            pool.with_connection(|conn| {
                conn.execute_batch(
                    "CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users(name) VALUES ('Ada'), ('Grace');",
                )
                .map_err(|err| err.to_string())
            })
            .expect("write encrypted sqlite");
        }

        let config = sqlite_config(&path, key);
        let pool = connect_sqlite_from_config(&config).await.expect("open encrypted sqlite");
        let count = pool
            .with_connection(|conn| {
                conn.query_row("SELECT count(*) FROM users", [], |row| row.get::<_, i64>(0))
                    .map_err(|err| err.to_string())
            })
            .expect("read encrypted sqlite");
        assert_eq!(count, 2);

        let wrong_key = match connect_sqlite_from_config(&sqlite_config(&path, "wrong-key")).await {
            Ok(_) => panic!("wrong SQLCipher key must fail"),
            Err(err) => err,
        };
        assert!(wrong_key.contains("Encrypted SQLite database unlock failed"));

        let missing_key = match connect_sqlite_from_config(&sqlite_config(&path, "")).await {
            Ok(_) => panic!("missing SQLCipher key must fail"),
            Err(err) => err,
        };
        assert!(missing_key.contains("not a valid SQLite database"));

        let _ = std::fs::remove_file(path);
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
        let first = state.mq_registry.get_or_build(&initial).await.unwrap().adapter;

        let updated = mq_config("mq-conn", "http://127.0.0.1:8081");
        save_connection_configs(&state, std::slice::from_ref(&updated)).await.unwrap();

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

        let second = state.mq_registry.get_or_build(&updated).await.unwrap().adapter;
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
        state.storage.save_connections(std::slice::from_ref(&updated)).await.unwrap();
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
        let stale = state.mq_registry.get_or_build(&removed).await.unwrap().adapter;

        save_connection_configs(&state, std::slice::from_ref(&kept)).await.unwrap();

        let configs = state.configs.read().await;
        assert!(configs.contains_key(&kept.id));
        assert!(!configs.contains_key("removed-mq"));
        drop(configs);

        let rebuilt = state.mq_registry.get_or_build(&removed).await.unwrap().adapter;
        assert!(!std::sync::Arc::ptr_eq(&stale, &rebuilt));

        let _ = std::fs::remove_dir_all(dir);
    }

    /// Dropped-file preview connection: in-memory DuckDB, `one_time`, never in the saved list.
    fn duckdb_preview_config() -> ConnectionConfig {
        ConnectionConfig {
            id: "preview-duckdb".to_string(),
            name: "[Preview] sales.parquet".to_string(),
            db_type: DatabaseType::DuckDb,
            driver_profile: Some("duckdb".to_string()),
            driver_label: Some("DuckDB".to_string()),
            url_params: Some(String::new()),
            host: ":memory:".to_string(),
            port: 0,
            username: String::new(),
            password: String::new(),
            database: None,
            one_time: true,
            ..mongodb_config()
        }
    }

    #[tokio::test]
    async fn save_connection_configs_retains_one_time_runtime_config_and_its_pool() {
        let dir = std::env::temp_dir().join(format!("dbx-tauri-conn-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = AppState::new_with_plugin_dir(storage, dir.join("plugins"));
        let persisted = mongodb_config();
        let preview = duckdb_preview_config();
        state.configs.write().await.insert(preview.id.clone(), preview.clone());

        let sync = sync_connection_configs(&state, std::slice::from_ref(&persisted)).await;

        let configs = state.configs.read().await;
        assert!(configs.contains_key(&persisted.id));
        assert!(configs.contains_key(&preview.id), "one_time runtime config must survive save sync");
        // The preview broke because the sync tore its pool down; asserting only that
        // the config survives would miss the actual regression.
        assert!(
            !sync.connection_pool_ids_to_drop.contains(&preview.id),
            "one_time connection pool must not be torn down by save sync"
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn save_connection_configs_keeps_session_credential_of_one_time_config() {
        let dir = std::env::temp_dir().join(format!("dbx-tauri-conn-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = AppState::new_with_plugin_dir(storage, dir.join("plugins"));
        let persisted = mongodb_config();
        let preview = duckdb_preview_config();
        state.configs.write().await.insert(preview.id.clone(), preview.clone());
        state.session_credentials.set("", &preview.id, "secret").expect("session credential fixture");

        save_connection_configs(&state, std::slice::from_ref(&persisted)).await.unwrap();

        // If the config is retained the credential must be retained with it, or the
        // next query re-prompts for a password that was already entered.
        assert!(state.session_credentials.has("", &preview.id));

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

        save_connection_configs(&state, std::slice::from_ref(&kept)).await.unwrap();

        assert!(!state.connections.read().await.contains_key(&removed.id));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn sync_connection_configs_ignores_password_only_changes() {
        let dir = std::env::temp_dir().join(format!("dbx-tauri-conn-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = AppState::new_with_plugin_dir(storage, dir.join("plugins"));

        let mut initial = mongodb_config();
        initial.id = "conn-a".to_string();
        initial.save_password = false;
        initial.password = "session-secret".to_string();
        let _ = state.session_credentials.set("", "conn-a", "session-secret");
        state.configs.write().await.insert(initial.id.clone(), initial.clone());

        // 持久化同步的空密码 config 覆盖运行态：save_password=false 连接仅密码
        // 差异不应销毁池（会话密码由内存仓库提供，与运行态 config 无关）。
        let mut updated = initial.clone();
        updated.password.clear();
        let sync = sync_connection_configs(&state, std::slice::from_ref(&updated)).await;
        assert!(sync.connection_pool_ids_to_drop.is_empty());
        assert_eq!(state.configs.read().await.get("conn-a").map(|c| c.password.as_str()), Some(""));
        assert!(state.session_credentials.has("", "conn-a"));

        // 真实连接参数（host）变化应销毁池，并清除旧会话凭据以便重新输入。
        let mut host_changed = updated.clone();
        host_changed.host = "other-host".to_string();
        let sync2 = sync_connection_configs(&state, std::slice::from_ref(&host_changed)).await;
        assert_eq!(sync2.connection_pool_ids_to_drop.as_slice(), &["conn-a".to_string()]);
        assert!(!state.session_credentials.has("", "conn-a"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn sync_connection_configs_preserves_nacos_session_password_for_scope_updates() {
        let dir = std::env::temp_dir().join(format!("dbx-tauri-nacos-scope-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = AppState::new_with_plugin_dir(storage, dir.join("plugins"));
        let initial = nacos_config("nacos-a");
        state.configs.write().await.insert(initial.id.clone(), initial.clone());
        let _ = state.session_credentials.set("", &initial.id, "new-password");
        state.session_credentials.set_for_purpose("", &initial.id, "nacos-primary-password", "new-password");

        let mut scope_updated = initial.clone();
        scope_updated.visible_databases = Some(vec!["namespace-a".to_string(), "namespace-b".to_string()]);
        scope_updated.external_config.as_mut().unwrap()["managedNamespaces"] =
            serde_json::json!(["namespace-a", "namespace-b"]);
        let sync = sync_connection_configs(&state, std::slice::from_ref(&scope_updated)).await;

        assert_eq!(sync.connection_pool_ids_to_drop.as_slice(), std::slice::from_ref(&initial.id));
        assert_eq!(state.session_credentials.get("", &initial.id).as_deref(), Some("new-password"));
        assert_eq!(
            state.session_credentials.get_for_purpose("", &initial.id, "nacos-primary-password").as_deref(),
            Some("new-password")
        );

        let mut endpoint_updated = scope_updated;
        endpoint_updated.host = "nacos.internal".to_string();
        endpoint_updated.external_config.as_mut().unwrap()["serverAddr"] =
            serde_json::json!("http://nacos.internal:8848");
        sync_connection_configs(&state, std::slice::from_ref(&endpoint_updated)).await;
        assert!(!state.session_credentials.has("", &initial.id));
        assert_eq!(state.session_credentials.get_for_purpose("", &initial.id, "nacos-primary-password"), None);

        let _ = std::fs::remove_dir_all(dir);
    }
}

#[tauri::command]
pub async fn save_connections(state: State<'_, Arc<AppState>>, configs: Vec<ConnectionConfig>) -> Result<(), String> {
    let configs: Vec<ConnectionConfig> = configs.into_iter().map(|config| config.canonicalized()).collect();
    save_connection_configs(state.inner(), &configs).await
}

async fn save_connection_configs(state: &AppState, configs: &[ConnectionConfig]) -> Result<(), String> {
    for config in configs {
        if config.db_type == DatabaseType::Sqlite {
            db::sqlite::validate_persistent_attachments(
                &config.host,
                &config.password,
                !config.attached_databases.is_empty(),
            )?;
        }
    }
    state.storage.save_connections(configs).await?;
    let sync = sync_connection_configs(state, configs).await;
    remove_connection_pools_for_connection_ids(state, &sync.connection_pool_ids_to_drop).await;
    drop_nacos_adapters_for_connection_ids(state, &sync.nacos_adapter_ids_to_drop).await;
    drop_mq_adapters_for_connection_ids(state, &sync.mq_adapter_ids_to_drop).await;
    Ok(())
}

struct ConnectionConfigSync {
    nacos_adapter_ids_to_drop: Vec<String>,
    mq_adapter_ids_to_drop: Vec<String>,
    connection_pool_ids_to_drop: Vec<String>,
}

async fn sync_connection_configs(state: &AppState, configs: &[ConnectionConfig]) -> ConnectionConfigSync {
    let saved_ids: HashSet<&str> = configs.iter().map(|config| config.id.as_str()).collect();
    let mut nacos_adapter_ids_to_drop = HashSet::new();
    let mut mq_adapter_ids_to_drop = HashSet::new();
    let mut connection_pool_ids_to_drop = HashSet::new();
    let mut runtime_configs = state.configs.write().await;
    runtime_configs.retain(|id, existing| {
        if saved_ids.contains(id.as_str()) || should_retain_runtime_config(id, existing) {
            true
        } else {
            connection_pool_ids_to_drop.insert(id.clone());
            // 连接已被删除：同步清理本次运行期会话凭据。
            state.session_credentials.clear_connection(id);
            if existing.db_type == DatabaseType::Nacos {
                nacos_adapter_ids_to_drop.insert(id.clone());
            }
            if existing.db_type == DatabaseType::MessageQueue {
                mq_adapter_ids_to_drop.insert(id.clone());
            }
            false
        }
    });
    for config in configs {
        if config.db_type == DatabaseType::Nacos {
            nacos_adapter_ids_to_drop.insert(config.id.clone());
        }
        if config.db_type == DatabaseType::MessageQueue {
            mq_adapter_ids_to_drop.insert(config.id.clone());
        }
        if let Some(previous) = runtime_configs.insert(config.id.clone(), config.clone()) {
            if previous.db_type == DatabaseType::Nacos {
                nacos_adapter_ids_to_drop.insert(config.id.clone());
            }
            if previous.db_type == DatabaseType::MessageQueue {
                mq_adapter_ids_to_drop.insert(config.id.clone());
            }
            if !connection_configs_session_credentials_compatible(&previous, config) {
                // 端点或认证身份变化后，旧密码不能安全复用。显示范围等本地设置
                // 不影响凭据归属，因此必须保留 no-save 连接的新会话密码。
                state.session_credentials.clear_connection(&config.id);
            }
            // 仅在真实连接参数变化时销毁池；save_password=false 连接因持久化
            // 空密码与运行态密码产生的差异被忽略（见 connection_configs_pool_equivalent）。
            if !connection_configs_pool_equivalent(&previous, config) {
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

async fn drop_nacos_adapters_for_connection_ids(state: &AppState, connection_ids: &[String]) {
    for connection_id in connection_ids {
        state.nacos_registry.drop_connection(connection_id).await;
    }
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
        state.remove_connection_pools_detached(connection_id).await;
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
    drop_nacos_adapters_for_connection_ids(state, &sync.nacos_adapter_ids_to_drop).await;
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

fn sqlite_extension_specs_from_config(config: &ConnectionConfig) -> Vec<db::sqlite::SqliteExtensionSpec> {
    db::sqlite::sqlite_extension_specs_from_url_params(config.url_params.as_deref())
        .into_iter()
        .map(|mut extension| {
            extension.path = expand_tilde(&extension.path);
            extension
        })
        .collect()
}

async fn connect_sqlite_from_config(config: &ConnectionConfig) -> Result<db::sqlite::SqliteHandle, String> {
    let sqlite_path = expand_tilde(&config.host);
    db::sqlite::validate_persistent_attachments(&sqlite_path, &config.password, !config.attached_databases.is_empty())?;
    let pool = db::sqlite::connect_path_with_cipher_key_and_extensions(
        &sqlite_path,
        &config.password,
        sqlite_extension_specs_from_config(config),
    )
    .await?;
    for attached in &config.attached_databases {
        db::sqlite::attach_database(&pool, &attached.name, &expand_tilde(&attached.path))?;
    }
    Ok(pool)
}

async fn test_redis_connection(
    state: &Arc<AppState>,
    tunnel_id: &str,
    config: &ConnectionConfig,
    host: &str,
    port: u16,
    connect_timeout: std::time::Duration,
) -> Result<Option<DatabaseConnectionInfo>, String> {
    // Connection tests must exercise the same Redis lifecycle as a saved connection,
    // including compatibility auth, TLS, and database selection.
    if config.uses_redis_cluster() {
        let connection =
            db::redis_driver::RedisConnection::Cluster(state.connect_redis_cluster(tunnel_id, config).await?);
        let info = db::redis_driver::database_connection_info(&connection).await.ok();
        drop(connection);
        return Ok(info);
    }
    if config.uses_redis_sentinel() {
        let connection = db::redis_driver::RedisConnection::Direct(tokio::sync::Mutex::new(
            state.connect_redis_sentinel(tunnel_id, config).await?,
        ));
        let info = db::redis_driver::database_connection_info(&connection).await.ok();
        drop(connection);
        return Ok(info);
    }
    let connection = db::redis_driver::RedisConnection::Direct(tokio::sync::Mutex::new(
        db::redis_driver::connect_standalone(config, host, port, connect_timeout).await?,
    ));
    let info = db::redis_driver::database_connection_info(&connection).await.ok();
    drop(connection);
    Ok(info)
}

#[tauri::command]
pub async fn test_connection(state: State<'_, Arc<AppState>>, config: ConnectionConfig) -> Result<String, String> {
    test_connection_with_info_inner(state.inner(), config).await.map(|result| result.message)
}

#[tauri::command]
pub async fn test_connection_with_info(
    state: State<'_, Arc<AppState>>,
    config: ConnectionConfig,
) -> Result<ConnectionTestResult, String> {
    test_connection_with_info_inner(state.inner(), config).await
}

async fn test_connection_with_info_inner(
    state: &Arc<AppState>,
    config: ConnectionConfig,
) -> Result<ConnectionTestResult, String> {
    let config = if config.uses_mongodb_oidc() { config.canonicalized() } else { config };
    let tunnel_id = format!("{}:test", config.id);
    let has_transport_layers = config.has_effective_transport_layers();
    let connection_id = if has_transport_layers { tunnel_id.as_str() } else { config.id.as_str() };
    let (host, port) = state.connection_host_port(connection_id, &config).await?;
    let probe_result = probe_connection_endpoint(&config, &host, port).await;
    let url = connection_url_for_endpoint(&config, &host, port);
    let target = redacted_connection_url_for_endpoint(&config, &host, port);
    let connect_timeout = std::time::Duration::from_secs(config.effective_connect_timeout_secs());
    let idle_timeout = std::time::Duration::from_secs(config.idle_timeout_secs);
    let gaussdb_m_jdbc_config = gaussdb_m_jdbc_command_config(&config, &host, port);
    log::info!("[test_connection] db_type={:?} target={}", config.db_type, target);
    let mut database_info = None;
    let result = match probe_result {
        Err(e) => Err(e),
        Ok(()) => match config.db_type {
            DatabaseType::Mysql if config.needs_bare_mysql() && !config.bare_mysql_uses_tls() => {
                match db::mysql::connect_bare(&url, connect_timeout).await {
                    Ok(pool) => {
                        database_info = optional_mysql_database_info(&pool, &config).await;
                        let _ = pool.disconnect().await;
                        Ok("Connection successful".to_string())
                    }
                    Err(e) => Err(e),
                }
            }
            DatabaseType::Mysql if config.needs_bare_mysql() && config.bare_mysql_uses_tls() => {
                match db::mysql::connect_compatible_with_ca_cert_pool_limit_idle_and_setup(
                    &url,
                    Some(&config.ca_cert_path),
                    connect_timeout,
                    10,
                    None,
                    &[],
                )
                .await
                {
                    Ok(pool) => {
                        database_info = optional_mysql_database_info(&pool, &config).await;
                        let _ = pool.disconnect().await;
                        Ok("Connection successful".to_string())
                    }
                    Err(e) => Err(e),
                }
            }
            DatabaseType::Mysql => {
                match db::mysql::connect_with_ca_cert(&url, Some(&config.ca_cert_path), connect_timeout).await {
                    Ok(pool) => {
                        database_info = optional_mysql_database_info(&pool, &config).await;
                        let _ = pool.disconnect().await;
                        Ok("Connection successful".to_string())
                    }
                    Err(e) => Err(e),
                }
            }
            DatabaseType::Doris | DatabaseType::ManticoreSearch => {
                match db::mysql::connect_bare(&url, connect_timeout).await {
                    Ok(pool) => {
                        database_info = optional_mysql_database_info(&pool, &config).await;
                        let _ = pool.disconnect().await;
                        Ok("Connection successful".to_string())
                    }
                    Err(e) => Err(e),
                }
            }
            DatabaseType::StarRocks => {
                let connect = if config.bare_mysql_uses_tls() {
                    db::mysql::connect_compatible_with_ca_cert_pool_limit_idle_and_setup(
                        &url,
                        Some(&config.ca_cert_path),
                        connect_timeout,
                        10,
                        None,
                        &[],
                    )
                    .await
                } else {
                    db::mysql::connect_bare(&url, connect_timeout).await
                };
                match connect {
                    Ok(pool) => {
                        database_info = optional_mysql_database_info(&pool, &config).await;
                        let _ = pool.disconnect().await;
                        Ok("Connection successful".to_string())
                    }
                    Err(e) => Err(e),
                }
            }
            DatabaseType::Gaussdb if gaussdb_m_jdbc_config.is_some() => {
                match state
                    .test_external_driver_with_info("jdbc", gaussdb_m_jdbc_config.as_ref().expect("checked above"))
                    .await
                {
                    Ok(details) => {
                        database_info = details.database_info;
                        Ok(details.message)
                    }
                    Err(err) => Err(err),
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
            DatabaseType::Sqlite => match connect_sqlite_from_config(&config).await {
                Ok(_) => Ok("Connection successful".to_string()),
                Err(e) => Err(e),
            },
            DatabaseType::Redis => {
                // Keep the result inside the outer lifecycle so temporary transports
                // are reset after both successful and failed Redis tests.
                match test_redis_connection(state, &tunnel_id, &config, &host, port, connect_timeout).await {
                    Ok(info) => {
                        database_info = info;
                        Ok("Connection successful".to_string())
                    }
                    Err(error) => Err(error),
                }
            }
            #[cfg(feature = "duckdb-sidecar")]
            DatabaseType::DuckDb => {
                state.test_duckdb_connection_config(&config).await?;
                Ok("Connection successful".to_string())
            }
            #[cfg(not(feature = "duckdb-sidecar"))]
            DatabaseType::DuckDb => Err("DuckDB support is not compiled in this build".to_string()),
            DatabaseType::MongoDb => {
                let uses_oidc = db::mongo_driver::mongo_uri_uses_oidc(&url);
                if mongo_uses_legacy_driver(&config) && !uses_oidc {
                    let am = &state.agent_manager;
                    let mut client = am.spawn(&config.db_type, config.driver_profile.as_deref()).await?;
                    client
                        .connect(mongo_legacy_connect_params(&config, &host, port)?)
                        .await
                        .map_err(|err| mongo_legacy_error_with_auth_hint(&err))?;
                    let version = client
                        .mongo_server_version::<String>(config.effective_database().unwrap_or("admin"))
                        .await
                        .ok();
                    client.disconnect().await.ok();
                    return Ok(ConnectionTestResult::success("Connection successful (via legacy driver)")
                        .with_database_info(version.map(|product_version| DatabaseConnectionInfo {
                            product_name: Some("MongoDB".to_string()),
                            product_version: Some(product_version),
                            current_database: config.effective_database().map(str::to_string),
                            driver_name: Some("MongoDB legacy Agent".to_string()),
                            ..Default::default()
                        })));
                }

                let native_err = match db::mongo_driver::connect_with_oidc(
                    &url,
                    connect_timeout,
                    idle_timeout,
                    state.mongo_oidc_browser_opener(),
                )
                .await
                {
                    Ok(client) => {
                        match db::mongo_driver::test_connection_for_url(
                            &client,
                            &url,
                            connect_timeout,
                            config.effective_database(),
                        )
                        .await
                        {
                            Ok(()) => {
                                let info =
                                    db::mongo_driver::database_connection_info(&client, config.effective_database())
                                        .await
                                        .ok();
                                return Ok(
                                    ConnectionTestResult::success("Connection successful").with_database_info(info)
                                );
                            }
                            Err(e) => e,
                        }
                    }
                    Err(e) => e,
                };
                if !uses_oidc && should_retry_mongo_with_legacy_driver(&native_err) {
                    let mut client =
                        spawn_mongo_legacy_fallback_agent(state.as_ref(), &config.db_type, &native_err).await?;
                    client.connect(mongo_legacy_connect_params(&config, &host, port)?).await.map_err(|err| {
                        mongo_legacy_fallback_error(
                            &native_err,
                            "Fallback with MongoDB (Legacy) driver failed",
                            &mongo_legacy_error_with_auth_hint(&err),
                        )
                    })?;
                    let version = client
                        .mongo_server_version::<String>(config.effective_database().unwrap_or("admin"))
                        .await
                        .ok();
                    client.disconnect().await.ok();
                    database_info = version.map(|product_version| DatabaseConnectionInfo {
                        product_name: Some("MongoDB".to_string()),
                        product_version: Some(product_version),
                        current_database: config.effective_database().map(str::to_string),
                        driver_name: Some("MongoDB legacy Agent".to_string()),
                        ..Default::default()
                    });
                    Ok("Connection successful (via legacy driver)".to_string())
                } else {
                    Err(native_err)
                }
            }
            DatabaseType::DynamoDb => {
                let client = db::dynamodb_driver::connect(&config, &host, port)?;
                db::dynamodb_driver::test_connection(&client, connect_timeout)
                    .await
                    .map(|_| "Connection successful".to_string())
            }
            DatabaseType::ClickHouse => {
                let username = if config.username.is_empty() { None } else { Some(config.username.clone()) };
                let password = if config.password.is_empty() { None } else { Some(config.password.clone()) };
                let client = db::clickhouse_driver::ChClient::new_with_ca_cert(
                    &url,
                    username,
                    password,
                    Some(&config.ca_cert_path),
                    config.url_params.as_deref(),
                    connect_timeout,
                )?;
                db::clickhouse_driver::test_connection(&client, connect_timeout)
                    .await
                    .map(|_| "Connection successful".to_string())
            }
            DatabaseType::SqlServer => {
                match state.test_sqlserver_connection_with_info(&config, &host, port, connect_timeout).await {
                    Ok(details) => {
                        database_info = details.database_info;
                        Ok(details.message)
                    }
                    Err(err) => Err(err),
                }
            }
            DatabaseType::Elasticsearch => {
                let mut client = db::elasticsearch_driver::EsClient::from_config(
                    &url,
                    Some(&config.username),
                    Some(&config.password),
                    config.ssl,
                    config.url_params.as_deref(),
                    config.external_config.as_ref(),
                    connect_timeout,
                );
                db::elasticsearch_driver::test_connection(&mut client, connect_timeout)
                    .await
                    .map(|_| "Connection successful".to_string())
            }
            DatabaseType::Easysearch => {
                let mut client = db::easysearch_driver::EasysearchClient::from_config(
                    &url,
                    Some(&config.username),
                    Some(&config.password),
                    config.ssl,
                    config.url_params.as_deref(),
                    config.external_config.as_ref(),
                    connect_timeout,
                );
                db::easysearch_driver::test_connection(&mut client, connect_timeout)
                    .await
                    .map(|_| "Connection successful".to_string())
            }
            DatabaseType::Meilisearch => {
                let client = db::meilisearch_driver::MeilisearchClient::new_for_config(
                    &url,
                    Some(&config.password),
                    config.ssl,
                    config.url_params.as_deref(),
                    config.external_config.as_ref(),
                    connect_timeout,
                )?;
                db::meilisearch_driver::test_connection(&client, connect_timeout).await?;
                database_info = db::meilisearch_driver::database_connection_info(&client).await.ok();
                Ok("Connection successful".to_string())
            }
            DatabaseType::Hbase => {
                let client = db::hbase_driver::HBaseClient::new(
                    &url,
                    Some(&config.username),
                    Some(&config.password),
                    false,
                    connect_timeout,
                )?;
                db::hbase_driver::test_connection(&client, connect_timeout).await?;
                database_info = db::hbase_driver::database_connection_info(&client).await.ok().flatten();
                Ok("Connection successful".to_string())
            }
            DatabaseType::Qdrant | DatabaseType::Milvus | DatabaseType::Weaviate | DatabaseType::ChromaDb => {
                let kind = match config.db_type {
                    DatabaseType::Qdrant => db::vector_driver::VectorDbKind::Qdrant,
                    DatabaseType::Milvus => db::vector_driver::VectorDbKind::Milvus,
                    DatabaseType::Weaviate => db::vector_driver::VectorDbKind::Weaviate,
                    DatabaseType::ChromaDb => db::vector_driver::VectorDbKind::ChromaDb,
                    _ => unreachable!(),
                };
                let client = db::vector_driver::VectorClient::new(
                    kind,
                    &url,
                    Some(&config.username),
                    Some(&config.password),
                    config.ssl,
                    connect_timeout,
                )
                .with_database(config.database.as_deref());
                db::vector_driver::test_connection(&client, connect_timeout)
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
            DatabaseType::CloudflareD1 => db::cloudflare_d1_driver::connect(&config, connect_timeout)
                .await
                .map(|_| "Connection successful".to_string()),
            DatabaseType::InfluxDb => {
                let client = db::influxdb_driver::InfluxdbClient::new_for_config(&url, &config, connect_timeout)?;
                db::influxdb_driver::test_connection(&client, connect_timeout)
                    .await
                    .map(|_| "Connection successful".to_string())
            }
            DatabaseType::VictoriaMetrics => {
                let client =
                    db::victoriametrics_driver::VictoriaMetricsClient::new_for_config(&url, &config, connect_timeout)?;
                db::victoriametrics_driver::test_connection(&client, connect_timeout).await?;
                database_info =
                    db::victoriametrics_driver::database_connection_info(&client, connect_timeout).await.ok();
                Ok("Connection successful".to_string())
            }
            DatabaseType::Nacos => {
                let admin_config = state.nacos_admin_config_for_connection(connection_id, &config).await?;
                let adapter = state.nacos_registry.build_transient_config(admin_config).await?;
                let info = adapter.test_connection_with_scope_validation().await?;
                database_info = dbx_core::nacos::service::database_info_from_connection(&info);
                Ok("Connection successful".to_string())
            }
            DatabaseType::Consul => {
                let mut consul_config = dbx_core::consul::ConsulConfig::from_connection(&config)?;
                let validate_agent_target = consul_config.agent_target.is_some();
                let original_host = consul_config.base_url.host_str().unwrap_or_default();
                let original_port = consul_config.base_url.port_or_known_default().unwrap_or(config.port);
                if host != original_host || port != original_port {
                    consul_config = consul_config.with_connect_override(&host, port);
                }
                let client = dbx_core::consul::ConsulClient::new(consul_config).await?;
                client.probe().await?;
                let identity = if validate_agent_target {
                    Some(client.validate_configured_agent_target().await?)
                } else {
                    client.agent_self().await.ok()
                };
                database_info = identity.as_ref().map(|identity| DatabaseConnectionInfo {
                    product_name: Some("Consul".to_string()),
                    product_version: identity.version.clone(),
                    server_comment: Some(format!("Agent {}", identity.node)),
                    driver_name: Some("Consul HTTP API".to_string()),
                    ..Default::default()
                });
                Ok(identity
                    .map(|identity| format!("Connection successful (Agent: {} at {})", identity.node, identity.address))
                    .unwrap_or_else(|| {
                        "Connection successful (Agent identity unavailable; Agent writes disabled)".to_string()
                    }))
            }
            #[cfg(feature = "mq-admin")]
            DatabaseType::MessageQueue => {
                // Probe with a transient adapter so Test Connection never retains/replaces
                // a live cached MQ agent for this connection id (same pattern as Nacos).
                let mqc = state.mq_admin_config_for_connection(connection_id, &config).await?;
                let agent_launch = dbx_core::mq::service::resolve_mq_agent_launch_spec(&mqc, state);
                let adapter = state.mq_registry.build_transient_config(mqc, agent_launch).await?;
                let info = adapter.test_connection().await?;
                database_info = Some(DatabaseConnectionInfo {
                    product_name: Some(
                        match info.system_kind {
                            dbx_core::mq::types::MqSystemKind::Pulsar => "Pulsar",
                            dbx_core::mq::types::MqSystemKind::Kafka => "Kafka",
                            dbx_core::mq::types::MqSystemKind::RocketMq => "RocketMQ",
                            dbx_core::mq::types::MqSystemKind::RabbitMq => "RabbitMQ",
                        }
                        .to_string(),
                    ),
                    product_version: info.server_version,
                    driver_name: Some("Message Queue Admin API".to_string()),
                    ..Default::default()
                });
                Ok("Connection successful".to_string())
            }
            #[cfg(not(feature = "mq-admin"))]
            DatabaseType::MessageQueue => {
                Err("Message queue admin support is not compiled in this build. Rebuild with the 'mq-admin' feature."
                    .to_string())
            }
            #[cfg(feature = "mq-admin")]
            DatabaseType::Mqtt => {
                let mqtt_config = dbx_core::mqtt::types::MqttConnectionConfig::from_connection(&config)?;
                let client = dbx_core::mqtt::client::MqttClient::connect(mqtt_config).await?;
                client.disconnect().await;
                Ok("Connection successful".to_string())
            }
            #[cfg(not(feature = "mq-admin"))]
            DatabaseType::Mqtt => {
                Err("MQTT support is not compiled in this build. Rebuild with the 'mq-admin' feature.".to_string())
            }
            db_type if database_capabilities::is_agent_type(&db_type) => {
                match test_agent_connection(state, &config, &host, port).await {
                    Ok(details) => {
                        database_info = details.database_info;
                        Ok(details.message)
                    }
                    Err(err) => Err(err),
                }
            }
            DatabaseType::PrestoSql => {
                let jdbc_config = prestosql_jdbc_config_for_endpoint(&config, &host, port)?;
                match state.test_external_driver_with_info("jdbc", &jdbc_config).await {
                    Ok(details) => {
                        database_info = details.database_info;
                        Ok(details.message)
                    }
                    Err(err) => Err(err),
                }
            }
            DatabaseType::Jdbc => {
                let jdbc_config = jdbc_command_config_for_endpoint(&config, &host, port)?;
                match state.test_external_driver_with_info("jdbc", &jdbc_config).await {
                    Ok(details) => {
                        database_info = details.database_info;
                        Ok(details.message)
                    }
                    Err(err) => Err(err),
                }
            }
            db_type => Err(format!("Unsupported database type: {db_type:?}")),
        },
    };

    if has_transport_layers {
        state.reset_connection_transport_for_config(&tunnel_id, &config).await;
    }

    result.map(|message| ConnectionTestResult::success(message).with_database_info(database_info))
}

/// 连接成功且 `save_password=false` 时，把本次输入的密码记入内存会话凭据仓库，
/// 供本次运行内 AI / 元数据 / 池重建复用（进程退出即丢，绝不落盘）。
fn record_session_credential(state: &AppState, config: &ConnectionConfig, connection_id: &str) {
    if !config.save_password && !config.password.is_empty() {
        let _ = state.session_credentials.set("", connection_id, &config.password);
    }
}

#[tauri::command]
pub async fn connect_db(
    state: State<'_, Arc<AppState>>,
    config: ConnectionConfig,
    client_attempt: Option<u64>,
) -> Result<String, String> {
    let config = config.canonicalized();
    if config.db_type == DatabaseType::Sqlite {
        db::sqlite::validate_persistent_attachments(
            &config.host,
            &config.password,
            !config.attached_databases.is_empty(),
        )?;
    }
    let id = config.id.clone();
    let mut db_config = metadata_connection_config(&config);
    // save_password=false 连接：前端在会话凭据存在时跳过弹窗并以空密码请求，
    // 此处从运行期会话凭据仓库补主密码，使重连/AI 新建池不再 ORA-01005。
    state.apply_session_credential(&config, &mut db_config, &id);
    let attempt = state.begin_connection_attempt_with_client_attempt(&id, client_attempt).await;
    let mut connected_config = config.clone();
    let mut connected_db_config = db_config.clone();

    state.remove_connection_pools_detached(&id).await;
    drop_nacos_adapters_for_connection_ids(state.inner(), std::slice::from_ref(&id)).await;
    state.reset_connection_transport_for_config(&id, &db_config).await;

    let (host, port) = state.connection_host_port(&id, &db_config).await?;
    if let Err(err) = state.ensure_current_connection_attempt(&id, Some(attempt)).await {
        state.reset_connection_transport_for_config(&id, &db_config).await;
        return Err(err);
    }
    probe_connection_endpoint(&db_config, &host, port).await?;
    if let Err(err) = state.ensure_current_connection_attempt(&id, Some(attempt)).await {
        state.reset_connection_transport_for_config(&id, &db_config).await;
        return Err(err);
    }
    let url = connection_url_for_endpoint(&db_config, &host, port);
    let connect_timeout = std::time::Duration::from_secs(db_config.effective_connect_timeout_secs());
    let idle_timeout = std::time::Duration::from_secs(db_config.idle_timeout_secs);
    let gaussdb_m_jdbc_config = gaussdb_m_jdbc_command_config(&db_config, &host, port);

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
        DatabaseType::Gaussdb if gaussdb_m_jdbc_config.is_some() => {
            state.external_driver_pool("jdbc", gaussdb_m_jdbc_config.as_ref().expect("checked above")).await?
        }
        DatabaseType::Postgres
        | DatabaseType::Redshift
        | DatabaseType::Gaussdb
        | DatabaseType::Kwdb
        | DatabaseType::Questdb
        | DatabaseType::OpenGauss => PoolKind::Postgres(db::postgres::connect(&url, connect_timeout).await?),
        DatabaseType::Sqlite => PoolKind::Sqlite(connect_sqlite_from_config(&db_config).await?),
        DatabaseType::Redis => {
            let con = if db_config.uses_redis_cluster() {
                PoolKind::Redis(db::redis_driver::RedisConnection::Cluster(
                    state.connect_redis_cluster(&id, &db_config).await?,
                ))
            } else if db_config.uses_redis_sentinel() {
                PoolKind::Redis(db::redis_driver::RedisConnection::Direct(tokio::sync::Mutex::new(
                    state.connect_redis_sentinel(&id, &db_config).await?,
                )))
            } else {
                PoolKind::Redis(db::redis_driver::RedisConnection::Direct(tokio::sync::Mutex::new(
                    db::redis_driver::connect_standalone(&db_config, &host, port, connect_timeout).await?,
                )))
            };
            con
        }
        #[cfg(feature = "duckdb-sidecar")]
        DatabaseType::DuckDb => state.create_duckdb_pool(&db_config).await?,
        #[cfg(not(feature = "duckdb-sidecar"))]
        DatabaseType::DuckDb => return Err("DuckDB support is not compiled in this build".to_string()),
        DatabaseType::MongoDb => {
            let uses_oidc = db::mongo_driver::mongo_uri_uses_oidc(&url);
            if mongo_uses_legacy_driver(&db_config) && !uses_oidc {
                let mut client =
                    state.agent_manager.spawn(&db_config.db_type, Some(MONGO_LEGACY_DRIVER_PROFILE)).await?;
                state.ensure_current_connection_attempt(&id, Some(attempt)).await?;
                client
                    .connect(mongo_legacy_connect_params(&db_config, &host, port)?)
                    .await
                    .map_err(|err| mongo_legacy_error_with_auth_hint(&err))?;
                state.ensure_current_connection_attempt(&id, Some(attempt)).await?;
                PoolKind::agent(client)
            } else {
                let native_err = match db::mongo_driver::connect_with_oidc(
                    &url,
                    connect_timeout,
                    idle_timeout,
                    state.mongo_oidc_browser_opener(),
                )
                .await
                {
                    Ok(client) => {
                        state.ensure_current_connection_attempt(&id, Some(attempt)).await?;
                        match db::mongo_driver::test_connection_for_url(
                            &client,
                            &url,
                            connect_timeout,
                            db_config.effective_database(),
                        )
                        .await
                        {
                            Ok(()) => {
                                state.ensure_current_connection_attempt(&id, Some(attempt)).await?;
                                if let Err(err) = state
                                    .insert_connection_pool_for_attempt(
                                        &id,
                                        attempt,
                                        id.clone(),
                                        PoolKind::MongoDb(client),
                                        &db_config,
                                    )
                                    .await
                                {
                                    state.reset_connection_transport_for_config(&id, &db_config).await;
                                    return Err(err);
                                }
                                record_session_credential(state.inner(), &config, &id);
                                let mut stored = config;
                                if !stored.save_password {
                                    stored.password.clear();
                                }
                                state.configs.write().await.insert(id.clone(), stored);
                                return Ok(id);
                            }
                            Err(e) => e,
                        }
                    }
                    Err(e) => e,
                };
                if !uses_oidc && should_retry_mongo_with_legacy_driver(&native_err) {
                    log::info!("Native MongoDB driver failed ({native_err}), falling back to agent driver");
                    let mut client =
                        spawn_mongo_legacy_fallback_agent(state.inner().as_ref(), &db_config.db_type, &native_err)
                            .await?;
                    state.ensure_current_connection_attempt(&id, Some(attempt)).await?;
                    client.connect(mongo_legacy_connect_params(&db_config, &host, port)?).await.map_err(|err| {
                        mongo_legacy_fallback_error(
                            &native_err,
                            "Fallback with MongoDB (Legacy) driver failed",
                            &mongo_legacy_error_with_auth_hint(&err),
                        )
                    })?;
                    state.ensure_current_connection_attempt(&id, Some(attempt)).await?;
                    persist_mongo_legacy_driver_profile(state.inner(), &connected_config).await?;
                    mark_mongo_legacy_driver(&mut connected_config);
                    connected_db_config = metadata_connection_config(&connected_config);
                    PoolKind::agent(client)
                } else {
                    return Err(native_err);
                }
            }
        }
        DatabaseType::DynamoDb => {
            let client = db::dynamodb_driver::connect(&db_config, &host, port)?;
            db::dynamodb_driver::test_connection(&client, connect_timeout).await?;
            PoolKind::DynamoDb(client)
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
                db_config.url_params.as_deref(),
                connect_timeout,
            )?;
            db::clickhouse_driver::test_connection(&client, connect_timeout).await?;
            PoolKind::ClickHouse(client)
        }
        DatabaseType::SqlServer => state.connect_sqlserver_pool(&db_config, &host, port, connect_timeout).await?,
        DatabaseType::Elasticsearch => {
            let mut client = db::elasticsearch_driver::EsClient::from_config(
                &url,
                Some(&db_config.username),
                Some(&db_config.password),
                db_config.ssl,
                db_config.url_params.as_deref(),
                db_config.external_config.as_ref(),
                connect_timeout,
            );
            db::elasticsearch_driver::test_connection(&mut client, connect_timeout).await?;
            PoolKind::Elasticsearch(client)
        }
        DatabaseType::Easysearch => {
            let mut client = db::easysearch_driver::EasysearchClient::from_config(
                &url,
                Some(&db_config.username),
                Some(&db_config.password),
                db_config.ssl,
                db_config.url_params.as_deref(),
                db_config.external_config.as_ref(),
                connect_timeout,
            );
            db::easysearch_driver::test_connection(&mut client, connect_timeout).await?;
            PoolKind::Easysearch(client)
        }
        DatabaseType::Meilisearch => {
            let client = db::meilisearch_driver::MeilisearchClient::new_for_config(
                &url,
                Some(&db_config.password),
                db_config.ssl,
                db_config.url_params.as_deref(),
                db_config.external_config.as_ref(),
                connect_timeout,
            )?;
            db::meilisearch_driver::test_connection(&client, connect_timeout).await?;
            PoolKind::Meilisearch(client)
        }
        DatabaseType::Hbase => {
            let client = db::hbase_driver::HBaseClient::new(
                &url,
                Some(&db_config.username),
                Some(&db_config.password),
                false,
                connect_timeout,
            )?;
            db::hbase_driver::test_connection(&client, connect_timeout).await?;
            PoolKind::HBase(client)
        }
        DatabaseType::Qdrant | DatabaseType::Milvus | DatabaseType::Weaviate | DatabaseType::ChromaDb => {
            let kind = match db_config.db_type {
                DatabaseType::Qdrant => db::vector_driver::VectorDbKind::Qdrant,
                DatabaseType::Milvus => db::vector_driver::VectorDbKind::Milvus,
                DatabaseType::Weaviate => db::vector_driver::VectorDbKind::Weaviate,
                DatabaseType::ChromaDb => db::vector_driver::VectorDbKind::ChromaDb,
                _ => unreachable!(),
            };
            let client = db::vector_driver::VectorClient::new(
                kind,
                &url,
                Some(&db_config.username),
                Some(&db_config.password),
                db_config.ssl,
                connect_timeout,
            )
            .with_database(db_config.database.as_deref());
            db::vector_driver::test_connection(&client, connect_timeout).await?;
            PoolKind::VectorDb(client)
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
        DatabaseType::CloudflareD1 => {
            PoolKind::CloudflareD1(db::cloudflare_d1_driver::connect(&db_config, connect_timeout).await?)
        }
        DatabaseType::InfluxDb => {
            let client = db::influxdb_driver::InfluxdbClient::new_for_config(&url, &db_config, connect_timeout)?;
            db::influxdb_driver::test_connection(&client, connect_timeout).await?;
            PoolKind::InfluxDb(client)
        }
        DatabaseType::VictoriaMetrics => {
            let client =
                db::victoriametrics_driver::VictoriaMetricsClient::new_for_config(&url, &db_config, connect_timeout)?;
            db::victoriametrics_driver::test_connection(&client, connect_timeout).await?;
            PoolKind::VictoriaMetrics(client)
        }
        DatabaseType::Nacos => {
            let admin_config = state.nacos_admin_config_for_connection(&id, &config).await?;
            let adapter = state.nacos_registry.build_transient_config(admin_config).await?;
            adapter.test_connection().await?;
            PoolKind::Nacos
        }
        DatabaseType::Consul => {
            let mut consul_config = dbx_core::consul::ConsulConfig::from_connection(&db_config)?;
            let original_host = consul_config.base_url.host_str().unwrap_or_default();
            let original_port = consul_config.base_url.port_or_known_default().unwrap_or(db_config.port);
            if host != original_host || port != original_port {
                consul_config = consul_config.with_connect_override(&host, port);
            }
            let client = dbx_core::consul::ConsulClient::new(consul_config).await?;
            client.probe().await?;
            PoolKind::Consul(client)
        }
        #[cfg(feature = "mq-admin")]
        DatabaseType::MessageQueue => {
            let mqc = state.mq_admin_config_for_connection(&id, &config).await?;
            let agent_launch = dbx_core::mq::service::resolve_mq_agent_launch_spec(&mqc, &state);
            let build = match state.mq_registry.get_or_build_config(&id, mqc, agent_launch).await {
                Ok(build) => build,
                Err(err) => {
                    state.mq_registry.drop_connection(&id).await;
                    return Err(err);
                }
            };
            if let Err(err) = state.ensure_current_connection_attempt(&id, Some(attempt)).await {
                state.mq_registry.drop_connection(&id).await;
                return Err(err);
            }
            if let Err(err) = dbx_core::mq::validate_mq_adapter_after_build(&build).await {
                state.mq_registry.drop_connection(&id).await;
                return Err(err);
            }
            if let Err(err) = state.ensure_current_connection_attempt(&id, Some(attempt)).await {
                state.mq_registry.drop_connection(&id).await;
                return Err(err);
            }
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
        DatabaseType::PrestoSql => {
            let jdbc_config = prestosql_jdbc_config_for_endpoint(&db_config, &host, port)?;
            state.external_driver_pool("jdbc", &jdbc_config).await?
        }
        DatabaseType::Jdbc => {
            let jdbc_config = jdbc_command_config_for_endpoint(&db_config, &host, port)?;
            state.external_driver_pool("jdbc", &jdbc_config).await?
        }
        #[cfg(feature = "mq-admin")]
        DatabaseType::Mqtt => {
            let mqtt_config = dbx_core::mqtt::types::MqttConnectionConfig::from_connection(&db_config)?;
            let client = dbx_core::mqtt::client::MqttClient::connect(mqtt_config).await?;
            PoolKind::Mqtt(client)
        }
        #[cfg(not(feature = "mq-admin"))]
        DatabaseType::Mqtt => {
            return Err("MQTT support is not compiled in this build. Rebuild with the 'mq-admin' feature.".to_string());
        }
        db_type => return Err(format!("Unsupported database type: {db_type:?}")),
    };

    if let Err(err) =
        state.insert_connection_pool_for_attempt(&id, attempt, id.clone(), pool, &connected_db_config).await
    {
        state.reset_connection_transport_for_config(&id, &connected_db_config).await;
        return Err(err);
    }
    record_session_credential(state.inner(), &connected_config, &id);
    // 存入全局运行态 configs 的配置脱敏（no-save 密码恒为空），明文只存在于会话凭据仓库。
    let mut stored = connected_config;
    if !stored.save_password {
        stored.password.clear();
    }
    state.configs.write().await.insert(id.clone(), stored);

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
    if runtime_config.db_type == DatabaseType::Sqlite {
        db::sqlite::validate_persistent_attachments(
            &runtime_config.host,
            &runtime_config.password,
            !runtime_config.attached_databases.is_empty(),
        )?;
    }

    let connection_id = runtime_config.id.clone();
    let db_config = metadata_connection_config(&runtime_config);
    // This pre-connect path caches the configuration for tunnel resolution. Keep
    // no-save passwords out of that shared runtime cache just like connect_db.
    let mut stored_config = runtime_config.clone();
    if !stored_config.save_password {
        stored_config.password.clear();
    }
    state.configs.write().await.insert(connection_id.clone(), stored_config);

    let (_, port) = state.connection_host_port(&connection_id, &db_config).await?;
    record_session_credential(state.inner(), &runtime_config, &connection_id);
    Ok(port)
}

#[tauri::command]
pub async fn disconnect_db(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    client_attempt: Option<u64>,
) -> Result<(), String> {
    let should_disconnect = if let Some(client_attempt) = client_attempt {
        state.supersede_connection_attempt_if_client_attempt(&connection_id, client_attempt).await
    } else {
        state.supersede_connection_attempt(&connection_id).await;
        true
    };
    if !should_disconnect {
        return Ok(());
    }
    state.running_queries.cancel_connection(&connection_id);
    state.remove_connection_pools_detached(&connection_id).await;
    drop_nacos_adapters_for_connection_ids(state.inner(), std::slice::from_ref(&connection_id)).await;
    drop_mq_adapters_for_connection_ids(state.inner(), std::slice::from_ref(&connection_id)).await;
    state.reset_connection_transport(&connection_id).await;
    release_runtime_config_on_disconnect(state.inner(), &connection_id).await;
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

/// 查询连接在本次运行期是否已输入并暂存密码（`save_password=false`）。
/// 供前端决定是否需要弹密码框；仅返回布尔状态，不泄露密码本身。
#[tauri::command]
pub async fn session_credential_status(state: State<'_, Arc<AppState>>, connection_id: String) -> Result<bool, String> {
    Ok(state.session_credentials.has("", &connection_id))
}

/// "断开并忘记本次密码"：清除连接本次运行期的临时密码，下次连接需重新输入。
/// 只清内存会话凭据，不影响持久化配置与已保存密码。
#[tauri::command]
pub async fn forget_session_credential(state: State<'_, Arc<AppState>>, connection_id: String) -> Result<(), String> {
    if !state.session_credentials.has("", &connection_id) {
        return Err(format!("Connection has no transient session credential to forget: {connection_id}"));
    }
    state.session_credentials.remove("", &connection_id);
    Ok(())
}

#[tauri::command]
pub async fn replace_nacos_session_credential(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    username: String,
    password: String,
) -> Result<(), String> {
    state
        .replace_nacos_session_credential(
            dbx_core::session_credentials::DESKTOP_OWNER,
            &connection_id,
            &username,
            &password,
        )
        .await
}

/// 清空全部运行期会话凭据（桌面端退出前调用；Web 端登出时走 `auth.rs logout`）。
/// 密码只存在于本次进程内存，进程退出本就会丢失；显式清除用于退出前兜底。
#[tauri::command]
pub async fn clear_all_session_credentials(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.session_credentials.clear();
    Ok(())
}

#[tauri::command]
pub async fn refresh_connections(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.refresh_connections().await;
    Ok(())
}

#[tauri::command]
pub async fn check_connection_health(state: State<'_, Arc<AppState>>, connection_id: String) -> Result<(), String> {
    state.check_connection_health(&connection_id).await
}

#[tauri::command]
pub async fn connection_identifier_quote(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: Option<String>,
) -> Result<Option<String>, String> {
    state.connection_identifier_quote(&connection_id, database.as_deref()).await
}

#[tauri::command]
pub async fn connection_database_info(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: Option<String>,
) -> Result<Option<DatabaseConnectionInfo>, String> {
    state.connection_database_info(&connection_id, database.as_deref()).await
}

#[tauri::command]
pub async fn save_connection_database_info(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database_info: Option<DatabaseConnectionInfo>,
) -> Result<(), String> {
    state.save_connection_database_info(&connection_id, database_info).await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteUnlockState {
    pub remaining_ms: u64,
}

#[tauri::command]
pub async fn unlock_connection_writes(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    duration_secs: u64,
) -> Result<WriteUnlockState, String> {
    if !state.configs.read().await.contains_key(&connection_id) {
        return Err("Connection not found".to_string());
    }
    let remaining_ms = state.write_unlock_windows.unlock(&connection_id, duration_secs).await?;
    Ok(WriteUnlockState { remaining_ms })
}

#[tauri::command]
pub async fn lock_connection_writes(state: State<'_, Arc<AppState>>, connection_id: String) -> Result<(), String> {
    state.write_unlock_windows.lock(&connection_id).await;
    Ok(())
}

#[tauri::command]
pub async fn connection_write_unlock_state(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<WriteUnlockState, String> {
    Ok(WriteUnlockState { remaining_ms: state.write_unlock_windows.remaining_ms(&connection_id).await })
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
