use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::db;
use crate::db::ssh_tunnel::TunnelManager;
use crate::models::connection::{ConnectionConfig, DatabaseType};
use crate::query_cancel::RunningQueries;
use crate::storage::Storage;

pub fn expand_tilde(path: &str) -> String {
    if path == "~" || path.starts_with("~/") {
        if let Ok(home) = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
            return format!("{}{}", home, &path[1..]);
        }
    }
    path.to_string()
}

pub enum PoolKind {
    Mysql(sqlx::mysql::MySqlPool, bool),
    Postgres(sqlx::postgres::PgPool),
    Sqlite(sqlx::sqlite::SqlitePool),
    Redis(tokio::sync::Mutex<redis::aio::MultiplexedConnection>),
    DuckDb(Arc<std::sync::Mutex<duckdb::Connection>>),
    MongoDb(mongodb::Client),
    ClickHouse(db::clickhouse_driver::ChClient),
    SqlServer(Arc<tokio::sync::Mutex<db::sqlserver::SqlServerClient>>),
    Oracle(Arc<tokio::sync::Mutex<db::oracle_driver::OracleClient>>),
    Elasticsearch(db::elasticsearch_driver::EsClient),
}

pub struct AppState {
    pub connections: Mutex<HashMap<String, PoolKind>>,
    pub configs: Mutex<HashMap<String, ConnectionConfig>>,
    pub running_queries: RunningQueries,
    pub tunnels: TunnelManager,
    pub storage: Storage,
}

impl AppState {
    pub fn new(storage: Storage) -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            configs: Mutex::new(HashMap::new()),
            running_queries: RunningQueries::default(),
            tunnels: TunnelManager::new(),
            storage,
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
            DatabaseType::Mysql if db_config.needs_bare_mysql() => PoolKind::Mysql(db::mysql::connect_bare(&url).await?, true),
            DatabaseType::Mysql => PoolKind::Mysql(db::mysql::connect(&url).await?, false),
            DatabaseType::Doris | DatabaseType::StarRocks => PoolKind::Mysql(db::mysql::connect_bare(&url).await?, true),
            DatabaseType::Postgres | DatabaseType::Redshift => PoolKind::Postgres(db::postgres::connect(&url).await?),
            DatabaseType::Sqlite => PoolKind::Sqlite(db::sqlite::connect_path(&expand_tilde(&db_config.host)).await?),
            DatabaseType::Redis => {
                let con = db::redis_driver::connect(&url).await?;
                PoolKind::Redis(tokio::sync::Mutex::new(con))
            }
            DatabaseType::DuckDb => {
                let con = duckdb::Connection::open(&expand_tilde(&db_config.host)).map_err(|e| e.to_string())?;
                PoolKind::DuckDb(Arc::new(std::sync::Mutex::new(con)))
            }
            DatabaseType::MongoDb => {
                let client = mongodb::Client::with_uri_str(&url).await.map_err(|e| e.to_string())?;
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
                PoolKind::SqlServer(Arc::new(tokio::sync::Mutex::new(client)))
            }
            DatabaseType::Oracle => {
                let client = db::oracle_driver::connect(
                    &host,
                    port,
                    db_config.database.as_deref().unwrap_or("ORCL"),
                    &db_config.username, &db_config.password,
                )
                .await?;
                PoolKind::Oracle(Arc::new(tokio::sync::Mutex::new(client)))
            }
            DatabaseType::Elasticsearch => {
                let client = db::elasticsearch_driver::EsClient::new(
                    &url,
                    Some(&db_config.username),
                    Some(&db_config.password),
                );
                db::elasticsearch_driver::test_connection(&client).await?;
                PoolKind::Elasticsearch(client)
            }
        };

        self.connections.lock().await.insert(pool_key.clone(), pool);
        Ok(pool_key)
    }

    pub async fn connection_host_port(
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
                &config.ssh_key_passphrase,
                &config.host,
                config.port,
                config.ssh_expose_lan,
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
                .map(|c| c.db_type == DatabaseType::Oracle || c.db_type == DatabaseType::Elasticsearch)
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

pub fn connection_url_for_endpoint(config: &ConnectionConfig, host: &str, port: u16) -> String {
    if host == config.host && port == config.port {
        config.connection_url()
    } else {
        config.connection_url_with_host(host, port)
    }
}

pub fn redacted_connection_url_for_endpoint(
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
