use std::sync::Arc;
use tauri::State;

pub use dbx_core::agent_connection::{
    agent_connect_params, mongo_legacy_error_with_auth_hint, oracle_alternate_connect_config,
    oracle_auth_fallback_profiles, oracle_error_with_driver_hint, should_retry_oracle_with_10g_driver,
};
pub use dbx_core::connection::{
    connect_bare_metadata_pool, connect_mysql_metadata_pool, connection_url_for_endpoint, metadata_connection_config,
    probe_connection_endpoint, redacted_connection_url_for_endpoint, AppState, MysqlMode, PoolKind,
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
        .call_daemon_method::<serde_json::Value>(
            &config.db_type,
            config.driver_profile.as_deref(),
            AgentMethod::TestConnection,
            connect_params.clone(),
        )
        .await;

    if let Err(err) = result {
        if let Some(alternate_config) = oracle_alternate_connect_config(config, &err) {
            state
                .agent_manager
                .call_daemon_method::<serde_json::Value>(
                    &alternate_config.db_type,
                    alternate_config.driver_profile.as_deref(),
                    AgentMethod::TestConnection,
                    agent_connect_params(
                        &alternate_config,
                        host,
                        port,
                        alternate_config.database.as_deref().unwrap_or(""),
                    ),
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
                    .call_daemon_method::<serde_json::Value>(
                        &config.db_type,
                        Some(profile),
                        AgentMethod::TestConnection,
                        connect_params.clone(),
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
    let connect_result = client.call_method::<serde_json::Value>(AgentMethod::Connect, connect_params.clone()).await;

    if let Err(err) = connect_result {
        if let Some(alternate_config) = oracle_alternate_connect_config(config, &err) {
            client
                .call_method::<serde_json::Value>(
                    AgentMethod::Connect,
                    agent_connect_params(
                        &alternate_config,
                        host,
                        port,
                        alternate_config.effective_database().unwrap_or(""),
                    ),
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
                            .call_method::<serde_json::Value>(AgentMethod::Connect, connect_params.clone())
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
    use super::mongo_legacy_connect_params;
    use dbx_core::models::connection::{ConnectionConfig, DatabaseType};

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
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: false,
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
                match db::sqlite::connect_path_with_extensions(&expand_tilde(&config.host), extensions).await {
                    Ok(_) => Ok("Connection successful".to_string()),
                    Err(e) => Err(e),
                }
            }
            DatabaseType::Redis => {
                let con = if config.uses_redis_cluster() {
                    db::redis_driver::connect_cluster(&config).await?;
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
                db::sqlite::connect_path_with_extensions(&expand_tilde(&db_config.host), extensions).await?,
            )
        }
        DatabaseType::Redis => {
            let con = if db_config.uses_redis_cluster() {
                PoolKind::Redis(db::redis_driver::RedisConnection::Cluster(
                    db::redis_driver::connect_cluster(&db_config).await?,
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
            let native_err = match db::mongo_driver::connect(&url, connect_timeout, idle_timeout).await {
                Ok(client) => {
                    match db::mongo_driver::test_connection(&client, connect_timeout, db_config.effective_database())
                        .await
                    {
                        Ok(()) => {
                            state.configs.write().await.insert(id.clone(), config);
                            state.connections.write().await.insert(id.clone(), PoolKind::MongoDb(client));
                            return Ok(id);
                        }
                        Err(e) => e,
                    }
                }
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
        db_type if database_capabilities::is_agent_type(&db_type) => {
            connect_agent_pool(state.inner(), &db_config, &host, port).await?
        }
        DatabaseType::Jdbc => state.external_driver_pool("jdbc", &db_config).await?,
        db_type => return Err(format!("Unsupported database type: {db_type:?}")),
    };

    state.connections.write().await.insert(id.clone(), pool);
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
    let mut conns = state.connections.write().await;
    let keys_to_remove: Vec<String> =
        conns.keys().filter(|k| *k == &connection_id || k.starts_with(&format!("{connection_id}:"))).cloned().collect();
    for key in keys_to_remove {
        if let Some(pool) = conns.remove(&key) {
            dbx_core::connection::close_pool_kind(pool).await;
        }
    }
    drop(conns);
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
