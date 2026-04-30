use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

use crate::db;
use crate::db::ssh_tunnel::TunnelManager;
use crate::models::connection::{ConnectionConfig, DatabaseType};

pub enum PoolKind {
    Mysql(sqlx::mysql::MySqlPool),
    Postgres(sqlx::postgres::PgPool),
    Sqlite(sqlx::sqlite::SqlitePool),
    Redis(tokio::sync::Mutex<redis::aio::MultiplexedConnection>),
    DuckDb(std::sync::Arc<std::sync::Mutex<duckdb::Connection>>),
    MongoDb(mongodb::Client),
    ClickHouse(db::clickhouse_driver::ChClient),
    SqlServer(std::sync::Arc<tokio::sync::Mutex<db::sqlserver::SqlServerClient>>),
    Oracle(std::sync::Arc<tokio::sync::Mutex<db::oracle_driver::OracleClient>>),
}

pub struct AppState {
    pub connections: Mutex<HashMap<String, PoolKind>>,
    pub configs: Mutex<HashMap<String, ConnectionConfig>>,
    pub tunnels: TunnelManager,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            configs: Mutex::new(HashMap::new()),
            tunnels: TunnelManager::new(),
        }
    }

    pub async fn get_or_create_pool(
        &self,
        connection_id: &str,
        database: Option<&str>,
    ) -> Result<String, String> {
        let db_type = {
            let configs = self.configs.lock().await;
            configs.get(connection_id).map(|c| c.db_type.clone())
        };

        let is_embedded = matches!(db_type, Some(DatabaseType::Sqlite) | Some(DatabaseType::DuckDb));
        if is_embedded {
            return Ok(connection_id.to_string());
        }

        let is_single_conn = matches!(db_type, Some(DatabaseType::Oracle));
        let pool_key = if is_single_conn {
            connection_id.to_string()
        } else {
            match database {
                Some(db) => format!("{connection_id}:{db}"),
                None => connection_id.to_string(),
            }
        };

        let conns = self.connections.lock().await;
        if conns.contains_key(&pool_key) {
            return Ok(pool_key);
        }
        drop(conns);

        let configs = self.configs.lock().await;
        let config = configs
            .get(connection_id)
            .ok_or("Connection config not found")?
            .clone();
        drop(configs);

        let mut db_config = config.clone();
        if let Some(db) = database {
            if db_config.db_type != DatabaseType::Oracle {
                db_config.database = Some(db.to_string());
            }
        }

        let (host, port) = self.connection_host_port(connection_id, &db_config).await?;
        let url = connection_url_for_endpoint(&db_config, &host, port);
        let pool = match db_config.db_type {
            DatabaseType::Mysql => PoolKind::Mysql(db::mysql::connect(&url).await?),
            DatabaseType::Postgres => PoolKind::Postgres(db::postgres::connect(&url).await?),
            DatabaseType::Sqlite => PoolKind::Sqlite(db::sqlite::connect(&url).await?),
            DatabaseType::Redis => {
                let con = db::redis_driver::connect(&url).await?;
                PoolKind::Redis(tokio::sync::Mutex::new(con))
            }
            DatabaseType::DuckDb => {
                let con = duckdb::Connection::open(&db_config.host).map_err(|e| e.to_string())?;
                PoolKind::DuckDb(std::sync::Arc::new(std::sync::Mutex::new(con)))
            }
            DatabaseType::MongoDb => {
                let client = mongodb::Client::with_uri_str(&url).await.map_err(|e| e.to_string())?;
                PoolKind::MongoDb(client)
            }
            DatabaseType::ClickHouse => {
                let client = db::clickhouse_driver::ChClient::new(&url);
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
                    &db_config.username, &db_config.password,
                )
                .await?;
                PoolKind::Oracle(std::sync::Arc::new(tokio::sync::Mutex::new(client)))
            }
        };

        self.connections.lock().await.insert(pool_key.clone(), pool);
        Ok(pool_key)
    }

    async fn connection_host_port(
        &self,
        connection_id: &str,
        config: &ConnectionConfig,
    ) -> Result<(String, u16), String> {
        if !config.ssh_enabled || config.ssh_host.is_empty() {
            return Ok((config.host.clone(), config.port));
        }

        if let Some(local_port) = self.tunnels.local_port(connection_id).await {
            return Ok(("127.0.0.1".to_string(), local_port));
        }

        let local_port = self
            .tunnels
            .start_tunnel(
                connection_id,
                &config.ssh_host,
                config.ssh_port,
                &config.ssh_user,
                &config.ssh_password,
                &config.ssh_key_path,
                &config.host,
                config.port,
            )
            .await?;

        Ok(("127.0.0.1".to_string(), local_port))
    }

    pub async fn reconnect_pool(
        &self,
        connection_id: &str,
        database: Option<&str>,
    ) -> Result<String, String> {
        let is_single_conn = {
            let configs = self.configs.lock().await;
            configs.get(connection_id)
                .map(|c| c.db_type == DatabaseType::Oracle)
                .unwrap_or(false)
        };
        let pool_key = if is_single_conn {
            connection_id.to_string()
        } else {
            match database {
                Some(db) => format!("{connection_id}:{db}"),
                None => connection_id.to_string(),
            }
        };
        self.connections.lock().await.remove(&pool_key);
        self.get_or_create_pool(connection_id, database).await
    }
}

fn connections_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("connections.json"))
}

fn connection_url_for_endpoint(config: &ConnectionConfig, host: &str, port: u16) -> String {
    if host == config.host && port == config.port {
        config.connection_url()
    } else {
        config.connection_url_with_host(host, port)
    }
}

fn redacted_connection_url_for_endpoint(
    config: &ConnectionConfig,
    host: &str,
    port: u16,
) -> String {
    if host == config.host && port == config.port {
        config.redacted_connection_url()
    } else {
        config.redacted_connection_url_with_host(host, port)
    }
}

#[tauri::command]
pub async fn save_connections(
    app: AppHandle,
    configs: Vec<ConnectionConfig>,
) -> Result<(), String> {
    let path = connections_file(&app)?;
    let json = serde_json::to_string_pretty(&configs).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn load_connections(app: AppHandle) -> Result<Vec<ConnectionConfig>, String> {
    let path = connections_file(&app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let json = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let configs: Vec<ConnectionConfig> =
        serde_json::from_str(&json).map_err(|e| e.to_string())?;
    Ok(configs)
}

#[tauri::command]
pub async fn test_connection(
    state: State<'_, Arc<AppState>>,
    config: ConnectionConfig,
) -> Result<String, String> {
    let tunnel_id = format!("{}:test", config.id);
    let connection_id = if config.ssh_enabled && !config.ssh_host.is_empty() {
        tunnel_id.as_str()
    } else {
        config.id.as_str()
    };
    let (host, port) = state.connection_host_port(connection_id, &config).await?;
    let url = connection_url_for_endpoint(&config, &host, port);
    let target = redacted_connection_url_for_endpoint(&config, &host, port);
    log::info!(
        "[test_connection] db_type={:?} target={}",
        config.db_type,
        target
    );
    let result = match config.db_type {
        DatabaseType::Mysql => match db::mysql::connect(&url).await {
            Ok(pool) => {
                pool.close().await;
                Ok("Connection successful".to_string())
            }
            Err(e) => Err(e),
        },
        DatabaseType::Postgres => match db::postgres::connect(&url).await {
            Ok(pool) => {
                pool.close().await;
                Ok("Connection successful".to_string())
            }
            Err(e) => Err(e),
        },
        DatabaseType::Sqlite => match db::sqlite::connect(&url).await {
            Ok(pool) => {
                pool.close().await;
                Ok("Connection successful".to_string())
            }
            Err(e) => Err(e),
        },
        DatabaseType::Redis => {
            db::redis_driver::connect(&url)
                .await
                .map(|_| "Connection successful".to_string())
        }
        DatabaseType::DuckDb => {
            duckdb::Connection::open(&config.host)
                .map(|_| "Connection successful".to_string())
                .map_err(|e| e.to_string())
        }
        DatabaseType::MongoDb => match mongodb::Client::with_uri_str(&url).await {
            Ok(client) => client
                .list_database_names()
                .await
                .map(|_| "Connection successful".to_string())
                .map_err(|e| e.to_string()),
            Err(e) => Err(e.to_string()),
        },
        DatabaseType::ClickHouse => {
            let client = db::clickhouse_driver::ChClient::new(&url);
            db::clickhouse_driver::test_connection(&client)
                .await
                .map(|_| "Connection successful".to_string())
        }
        DatabaseType::SqlServer => db::sqlserver::connect(
            &host,
            port,
            &config.username,
            &config.password,
            config.database.as_deref(),
        )
        .await
        .map(|_| "Connection successful".to_string()),
        DatabaseType::Oracle => db::oracle_driver::connect(
            &host,
            port,
            config.database.as_deref().unwrap_or("ORCL"),
            &config.username,
            &config.password,
        )
        .await
        .map(|_| "Connection successful".to_string()),
    };

    if config.ssh_enabled && !config.ssh_host.is_empty() {
        state.tunnels.stop_tunnel(&tunnel_id).await;
    }

    result
}

#[tauri::command]
pub async fn connect_db(
    state: State<'_, Arc<AppState>>,
    config: ConnectionConfig,
) -> Result<String, String> {
    let id = config.id.clone();

    let (host, port) = state.connection_host_port(&id, &config).await?;
    let url = connection_url_for_endpoint(&config, &host, port);

    let pool = match config.db_type {
        DatabaseType::Mysql => PoolKind::Mysql(db::mysql::connect(&url).await?),
        DatabaseType::Postgres => PoolKind::Postgres(db::postgres::connect(&url).await?),
        DatabaseType::Sqlite => PoolKind::Sqlite(db::sqlite::connect(&url).await?),
        DatabaseType::Redis => {
            let con = db::redis_driver::connect(&url).await?;
            PoolKind::Redis(tokio::sync::Mutex::new(con))
        }
        DatabaseType::DuckDb => {
            let con = duckdb::Connection::open(&config.host).map_err(|e| e.to_string())?;
            PoolKind::DuckDb(std::sync::Arc::new(std::sync::Mutex::new(con)))
        }
        DatabaseType::MongoDb => {
            let client = mongodb::Client::with_uri_str(&url).await.map_err(|e| e.to_string())?;
            PoolKind::MongoDb(client)
        }
        DatabaseType::ClickHouse => {
            let client = db::clickhouse_driver::ChClient::new(&url);
            db::clickhouse_driver::test_connection(&client).await?;
            PoolKind::ClickHouse(client)
        }
        DatabaseType::SqlServer => {
            let client = db::sqlserver::connect(
                &host,
                port,
                &config.username, &config.password,
                config.database.as_deref(),
            )
            .await?;
            PoolKind::SqlServer(std::sync::Arc::new(tokio::sync::Mutex::new(client)))
        }
        DatabaseType::Oracle => {
            let client = db::oracle_driver::connect(
                &host,
                port,
                config.database.as_deref().unwrap_or("ORCL"),
                &config.username,
                &config.password,
            )
            .await?;
            PoolKind::Oracle(std::sync::Arc::new(tokio::sync::Mutex::new(client)))
        }
    };

    state.connections.lock().await.insert(id.clone(), pool);
    state.configs.lock().await.insert(id.clone(), config);

    Ok(id)
}

#[tauri::command]
pub async fn disconnect_db(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<(), String> {
    let mut conns = state.connections.lock().await;
    let keys_to_remove: Vec<String> = conns
        .keys()
        .filter(|k| *k == &connection_id || k.starts_with(&format!("{connection_id}:")))
        .cloned()
        .collect();
    for key in keys_to_remove {
        if let Some(pool) = conns.remove(&key) {
            match pool {
                PoolKind::Mysql(p) => p.close().await,
                PoolKind::Postgres(p) => p.close().await,
                PoolKind::Sqlite(p) => p.close().await,
                PoolKind::Redis(_) => {},
                PoolKind::DuckDb(_) => {},
                PoolKind::MongoDb(_) => {},
                PoolKind::ClickHouse(_) => {},
                PoolKind::SqlServer(_) => {},
                PoolKind::Oracle(_) => {},
            }
        }
    }
    drop(conns);
    state.configs.lock().await.remove(&connection_id);
    state.tunnels.stop_tunnel(&connection_id).await;
    Ok(())
}
