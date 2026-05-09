use std::sync::Arc;
use tauri::State;

pub use dbx_core::connection::{
    connection_url_for_endpoint, expand_tilde, metadata_connection_config, probe_connection_endpoint,
    redacted_connection_url_for_endpoint, AppState, MysqlMode, PoolKind,
};
use dbx_core::db;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};

#[tauri::command]
pub async fn save_connections(state: State<'_, Arc<AppState>>, configs: Vec<ConnectionConfig>) -> Result<(), String> {
    state.storage.save_connections(&configs).await
}

#[tauri::command]
pub async fn load_connections(state: State<'_, Arc<AppState>>) -> Result<Vec<ConnectionConfig>, String> {
    state.storage.load_connections().await
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
            DatabaseType::DuckDb => duckdb::Connection::open(&expand_tilde(&config.host))
                .map(|_| "Connection successful".to_string())
                .map_err(|e| e.to_string()),
            DatabaseType::MongoDb => match db::mongo_driver::connect(&url).await {
                Ok(client) => {
                    db::mongo_driver::test_connection(&client).await.map(|_| "Connection successful".to_string())
                }
                Err(e) => Err(e.to_string()),
            },
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
            DatabaseType::Oracle => db::oracle_driver::connect(
                &host,
                port,
                config.database.as_deref().unwrap_or("ORCL"),
                &config.username,
                &config.password,
                config.sysdba,
            )
            .await
            .map(|_| "Connection successful".to_string()),
            DatabaseType::Elasticsearch => {
                let client =
                    db::elasticsearch_driver::EsClient::new(&url, Some(&config.username), Some(&config.password));
                db::elasticsearch_driver::test_connection(&client).await.map(|_| "Connection successful".to_string())
            }
            DatabaseType::Dameng => db::dm_driver::connect(
                &host,
                port,
                config.database.as_deref().unwrap_or(""),
                &config.username,
                &config.password,
            )
            .await
            .map(|_| "Connection successful".to_string()),
            DatabaseType::Gaussdb => db::gaussdb_driver::connect(
                &host,
                port,
                config.database.as_deref().unwrap_or(""),
                &config.username,
                &config.password,
            )
            .await
            .map(|_| "Connection successful".to_string()),
        },
    };

    if config.ssh_enabled && !config.ssh_host.is_empty() {
        state.tunnels.stop_tunnel(&tunnel_id).await;
    }

    result
}

#[tauri::command]
pub async fn connect_db(state: State<'_, Arc<AppState>>, config: ConnectionConfig) -> Result<String, String> {
    let id = config.id.clone();
    let db_config = metadata_connection_config(&config);

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
            let con = duckdb::Connection::open(&expand_tilde(&db_config.host)).map_err(|e| e.to_string())?;
            PoolKind::DuckDb(std::sync::Arc::new(std::sync::Mutex::new(con)))
        }
        DatabaseType::MongoDb => {
            let client = db::mongo_driver::connect(&url).await?;
            db::mongo_driver::test_connection(&client).await?;
            PoolKind::MongoDb(client)
        }
        DatabaseType::ClickHouse => {
            let username = if db_config.username.is_empty() { None } else { Some(db_config.username.clone()) };
            let password = if db_config.password.is_empty() { None } else { Some(db_config.password.clone()) };
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
        DatabaseType::Oracle => {
            let client = db::oracle_driver::connect(
                &host,
                port,
                db_config.database.as_deref().unwrap_or("ORCL"),
                &db_config.username,
                &db_config.password,
                db_config.sysdba,
            )
            .await?;
            PoolKind::Oracle(std::sync::Arc::new(tokio::sync::Mutex::new(client)))
        }
        DatabaseType::Elasticsearch => {
            let client =
                db::elasticsearch_driver::EsClient::new(&url, Some(&db_config.username), Some(&db_config.password));
            db::elasticsearch_driver::test_connection(&client).await?;
            PoolKind::Elasticsearch(client)
        }
        DatabaseType::Dameng => {
            let client = db::dm_driver::connect(
                &host,
                port,
                db_config.database.as_deref().unwrap_or(""),
                &db_config.username,
                &db_config.password,
            )
            .await?;
            PoolKind::Dameng(std::sync::Arc::new(std::sync::Mutex::new(client)))
        }
        DatabaseType::Gaussdb => {
            let client = db::gaussdb_driver::connect(
                &host,
                port,
                db_config.database.as_deref().unwrap_or(""),
                &db_config.username,
                &db_config.password,
            )
            .await?;
            PoolKind::Gaussdb(std::sync::Arc::new(tokio::sync::Mutex::new(client)))
        }
    };

    state.connections.lock().await.insert(id.clone(), pool);
    state.configs.lock().await.insert(id.clone(), config);

    Ok(id)
}

#[tauri::command]
pub async fn disconnect_db(state: State<'_, Arc<AppState>>, connection_id: String) -> Result<(), String> {
    let mut conns = state.connections.lock().await;
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
                PoolKind::Oracle(_) => {}
                PoolKind::Elasticsearch(_) => {}
                PoolKind::Dameng(_) => {}
                PoolKind::Gaussdb(_) => {}
            }
        }
    }
    drop(conns);
    state.configs.lock().await.remove(&connection_id);
    state.tunnels.stop_tunnel(&connection_id).await;
    Ok(())
}
