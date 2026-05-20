use std::sync::Arc;
use tauri::State;

pub use dbx_core::connection::{
    agent_connect_params, connection_url_for_endpoint, expand_tilde, metadata_connection_config,
    mongo_legacy_error_with_auth_hint, probe_connection_endpoint, redacted_connection_url_for_endpoint, AppState,
    MysqlMode, PoolKind,
};
use dbx_core::database_capabilities;
use dbx_core::db;
use dbx_core::db::agent_driver::AgentMethod;
use dbx_core::models::connection::{rewrite_jdbc_url_host, ConnectionConfig, DatabaseType};

fn mongo_legacy_connect_params(config: &ConnectionConfig, host: &str, port: u16) -> serde_json::Value {
    serde_json::json!({
        "connection": agent_connect_params(config, host, port, config.effective_database().unwrap_or(""))
    })
}

#[cfg(test)]
mod tests {
    use super::mongo_legacy_connect_params;
    use dbx_core::models::connection::{ConnectionConfig, DatabaseType, ProxyType};

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
            ssh_enabled: false,
            ssh_host: String::new(),
            ssh_port: 22,
            ssh_user: String::new(),
            ssh_password: String::new(),
            ssh_key_path: String::new(),
            ssh_key_passphrase: String::new(),
            ssh_expose_lan: false,
            ssh_connect_timeout_secs: dbx_core::models::connection::default_ssh_connect_timeout_secs(),
            proxy_enabled: false,
            proxy_type: ProxyType::Socks5,
            proxy_host: String::new(),
            proxy_port: 1080,
            proxy_username: String::new(),
            proxy_password: String::new(),
            ssl: false,
            sysdba: false,
            oracle_connection_type: None,
            connection_string: Some(
                "mongodb://mongouser:secret@172.22.4.42:27017/RestCloud_V45PUB_Gateway?authSource=admin".to_string(),
            ),
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
        }
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
}

#[tauri::command]
pub async fn save_connections(state: State<'_, Arc<AppState>>, configs: Vec<ConnectionConfig>) -> Result<(), String> {
    let configs: Vec<ConnectionConfig> = configs.into_iter().map(|config| config.canonicalized()).collect();
    state.storage.save_connections(&configs).await
}

#[tauri::command]
pub async fn load_connections(state: State<'_, Arc<AppState>>) -> Result<Vec<ConnectionConfig>, String> {
    state
        .storage
        .load_connections()
        .await
        .map(|configs| configs.into_iter().map(|config| config.canonicalized()).collect())
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
    let connection_id =
        if config.ssh_enabled && !config.ssh_host.is_empty() { tunnel_id.as_str() } else { config.id.as_str() };
    let (host, port) = state.connection_host_port(connection_id, &config).await?;
    let probe_result = probe_connection_endpoint(&config, &host, port).await;
    let url = connection_url_for_endpoint(&config, &host, port);
    let target = redacted_connection_url_for_endpoint(&config, &host, port);
    log::info!("[test_connection] db_type={:?} target={}", config.db_type, target);
    let result = match probe_result {
        Err(e) => Err(e),
        Ok(()) => match config.db_type {
            DatabaseType::Mysql if config.needs_bare_mysql() => match db::mysql::connect_bare(&url).await {
                Ok(pool) => {
                    pool.close().await;
                    Ok("Connection successful".to_string())
                }
                Err(e) => Err(e),
            },
            DatabaseType::Mysql => match db::mysql::connect(&url).await {
                Ok(pool) => {
                    pool.close().await;
                    Ok("Connection successful".to_string())
                }
                Err(e) => Err(e),
            },
            DatabaseType::Doris | DatabaseType::StarRocks => match db::mysql::connect_bare(&url).await {
                Ok(pool) => {
                    pool.close().await;
                    Ok("Connection successful".to_string())
                }
                Err(e) => Err(e),
            },
            DatabaseType::Postgres | DatabaseType::Redshift => match db::postgres::connect(&url).await {
                Ok(pool) => {
                    pool.close().await;
                    Ok("Connection successful".to_string())
                }
                Err(e) => Err(e),
            },
            DatabaseType::Sqlite => match db::sqlite::connect_path(&expand_tilde(&config.host)).await {
                Ok(pool) => {
                    pool.close().await;
                    Ok("Connection successful".to_string())
                }
                Err(e) => Err(e),
            },
            DatabaseType::Redis => db::redis_driver::connect(&url).await.map(|_| "Connection successful".to_string()),
            DatabaseType::DuckDb => {
                if state.duckdb_existing_pool_is_usable_for_config(&config).await? {
                    Ok("Connection successful".to_string())
                } else {
                    db::duckdb_driver::connect_path(&expand_tilde(&config.host))
                        .map(|_| "Connection successful".to_string())
                }
            }
            DatabaseType::MongoDb => {
                let native_err = match db::mongo_driver::connect(&url).await {
                    Ok(client) => match db::mongo_driver::test_connection(&client).await {
                        Ok(()) => return Ok("Connection successful".to_string()),
                        Err(e) => e,
                    },
                    Err(e) => e,
                };
                if native_err.contains("wire version") {
                    let am = &state.agent_manager;
                    let mut client = am.spawn(&config.db_type, config.driver_profile.as_deref()).await?;
                    client
                        .connect(mongo_legacy_connect_params(&config, &host, port))
                        .await
                        .map_err(|err| mongo_legacy_error_with_auth_hint(&err))?;
                    client.disconnect().await.ok();
                    Ok("Connection successful (via legacy driver)".to_string())
                } else {
                    Err(native_err)
                }
            }
            DatabaseType::ClickHouse => {
                let username = if config.username.is_empty() { None } else { Some(config.username.clone()) };
                let password = if config.password.is_empty() { None } else { Some(config.password.clone()) };
                let client = db::clickhouse_driver::ChClient::new(&url, username, password);
                db::clickhouse_driver::test_connection(&client).await.map(|_| "Connection successful".to_string())
            }
            DatabaseType::SqlServer => {
                db::sqlserver::connect(&host, port, &config.username, &config.password, config.database.as_deref())
                    .await
                    .map(|_| "Connection successful".to_string())
            }
            DatabaseType::Elasticsearch => {
                let client = db::elasticsearch_driver::EsClient::new(
                    &url,
                    Some(&config.username),
                    Some(&config.password),
                    config.ssl,
                );
                db::elasticsearch_driver::test_connection(&client).await.map(|_| "Connection successful".to_string())
            }
            db_type if database_capabilities::is_agent_type(&db_type) => {
                state
                    .agent_manager
                    .call_daemon_method::<serde_json::Value>(
                        &config.db_type,
                        config.driver_profile.as_deref(),
                        AgentMethod::TestConnection,
                        agent_connect_params(&config, &host, port, config.database.as_deref().unwrap_or("")),
                    )
                    .await?;
                Ok("Connection successful".to_string())
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

    if config.ssh_enabled && !config.ssh_host.is_empty() {
        state.tunnels.stop_tunnel(&tunnel_id).await;
    }
    if config.proxy_enabled && !config.proxy_host.is_empty() {
        state.proxy_tunnels.stop_tunnel(&tunnel_id).await;
    }

    result
}

#[tauri::command]
pub async fn connect_db(state: State<'_, Arc<AppState>>, config: ConnectionConfig) -> Result<String, String> {
    let config = config.canonicalized();
    let id = config.id.clone();
    let db_config = metadata_connection_config(&config);

    state.remove_connection_pools(&id).await;
    state.reset_connection_transport(&id).await;

    let (host, port) = state.connection_host_port(&id, &db_config).await?;
    probe_connection_endpoint(&db_config, &host, port).await?;
    let url = connection_url_for_endpoint(&db_config, &host, port);

    let pool = match db_config.db_type {
        DatabaseType::Mysql if db_config.needs_bare_mysql() => {
            PoolKind::Mysql(db::mysql::connect_bare(&url).await?, MysqlMode::Bare)
        }
        DatabaseType::Mysql => PoolKind::Mysql(db::mysql::connect(&url).await?, MysqlMode::Normal),
        DatabaseType::Doris | DatabaseType::StarRocks => {
            PoolKind::Mysql(db::mysql::connect_bare(&url).await?, MysqlMode::Bare)
        }
        DatabaseType::Postgres | DatabaseType::Redshift => PoolKind::Postgres(db::postgres::connect(&url).await?),
        DatabaseType::Sqlite => PoolKind::Sqlite(db::sqlite::connect_path(&expand_tilde(&db_config.host)).await?),
        DatabaseType::Redis => {
            let con = db::redis_driver::connect(&url).await?;
            PoolKind::Redis(tokio::sync::Mutex::new(con))
        }
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
        DatabaseType::MongoDb => {
            let native_err = match db::mongo_driver::connect(&url).await {
                Ok(client) => match db::mongo_driver::test_connection(&client).await {
                    Ok(()) => {
                        state.configs.write().await.insert(id.clone(), config);
                        state.connections.write().await.insert(id.clone(), PoolKind::MongoDb(client));
                        return Ok(id);
                    }
                    Err(e) => e,
                },
                Err(e) => e,
            };
            if native_err.contains("wire version") {
                log::info!("Native MongoDB driver failed ({native_err}), falling back to agent driver");
                let mut client =
                    state.agent_manager.spawn(&db_config.db_type, db_config.driver_profile.as_deref()).await?;
                client.connect(mongo_legacy_connect_params(&db_config, &host, port)).await?;
                PoolKind::Agent(std::sync::Arc::new(tokio::sync::Mutex::new(client)))
            } else {
                return Err(native_err);
            }
        }
        DatabaseType::ClickHouse => {
            let username = if db_config.username.is_empty() { None } else { Some(db_config.username.clone()) };
            let password = if db_config.password.is_empty() { None } else { Some(db_config.password.clone()) };
            log::info!("[connect_db] ClickHouse url={url} user={:?} has_pass={}", username, password.is_some());
            let client = db::clickhouse_driver::ChClient::new(&url, username, password);
            db::clickhouse_driver::test_connection(&client).await?;
            PoolKind::ClickHouse(client)
        }
        DatabaseType::SqlServer => {
            let client = db::sqlserver::connect(
                &host,
                port,
                &db_config.username,
                &db_config.password,
                db_config.database.as_deref(),
            )
            .await?;
            PoolKind::SqlServer(std::sync::Arc::new(tokio::sync::Mutex::new(client)))
        }
        DatabaseType::Elasticsearch => {
            let client = db::elasticsearch_driver::EsClient::new(
                &url,
                Some(&db_config.username),
                Some(&db_config.password),
                db_config.ssl,
            );
            db::elasticsearch_driver::test_connection(&client).await?;
            PoolKind::Elasticsearch(client)
        }
        db_type if database_capabilities::is_agent_type(&db_type) => {
            let mut client = state.agent_manager.spawn(&db_config.db_type, db_config.driver_profile.as_deref()).await?;
            client
                .call_method::<serde_json::Value>(
                    AgentMethod::Connect,
                    agent_connect_params(&db_config, &host, port, db_config.effective_database().unwrap_or("")),
                )
                .await?;
            PoolKind::Agent(std::sync::Arc::new(tokio::sync::Mutex::new(client)))
        }
        DatabaseType::Jdbc => state.external_driver_pool("jdbc", &db_config).await?,
        db_type => return Err(format!("Unsupported database type: {db_type:?}")),
    };

    state.connections.write().await.insert(id.clone(), pool);
    state.configs.write().await.insert(id.clone(), config);

    Ok(id)
}

#[tauri::command]
pub async fn disconnect_db(state: State<'_, Arc<AppState>>, connection_id: String) -> Result<(), String> {
    let mut conns = state.connections.write().await;
    let keys_to_remove: Vec<String> =
        conns.keys().filter(|k| *k == &connection_id || k.starts_with(&format!("{connection_id}:"))).cloned().collect();
    for key in keys_to_remove {
        if let Some(pool) = conns.remove(&key) {
            match pool {
                PoolKind::Mysql(p, _) => p.close().await,
                PoolKind::Postgres(p) => p.close().await,
                PoolKind::Sqlite(p) => p.close().await,
                PoolKind::Redis(_) => {}
                PoolKind::DuckDb(_) => {}
                PoolKind::MongoDb(_) => {}
                PoolKind::ClickHouse(_) => {}
                PoolKind::SqlServer(_) => {}
                PoolKind::Elasticsearch(_) => {}
                PoolKind::Agent(_) => {}
                PoolKind::ExternalTabular(_) => {}
                PoolKind::ExternalDriver { .. } => {}
            }
        }
    }
    drop(conns);
    state.configs.write().await.remove(&connection_id);
    state.reset_connection_transport(&connection_id).await;
    Ok(())
}
