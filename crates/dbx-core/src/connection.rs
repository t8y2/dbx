use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::db;
use crate::db::ssh_tunnel::TunnelManager;
use crate::models::connection::{parse_mongo_first_host, ConnectionConfig, DatabaseType};
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

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MysqlMode {
    Normal,
    Bare,
    OceanBaseOracle,
}

pub enum PoolKind {
    Mysql(sqlx::mysql::MySqlPool, MysqlMode),
    Postgres(sqlx::postgres::PgPool),
    Sqlite(sqlx::sqlite::SqlitePool),
    Redis(tokio::sync::Mutex<redis::aio::MultiplexedConnection>),
    DuckDb(Arc<std::sync::Mutex<duckdb::Connection>>),
    MongoDb(mongodb::Client),
    ClickHouse(db::clickhouse_driver::ChClient),
    SqlServer(Arc<tokio::sync::Mutex<db::sqlserver::SqlServerClient>>),
    Oracle(Arc<tokio::sync::Mutex<db::oracle_driver::OracleClient>>),
    Elasticsearch(db::elasticsearch_driver::EsClient),
    Dameng(Arc<std::sync::Mutex<db::dm_driver::DmClient>>),
    Gaussdb(Arc<tokio::sync::Mutex<db::gaussdb_driver::GaussdbClient>>),
}

pub struct AppState {
    pub connections: Mutex<HashMap<String, PoolKind>>,
    pub configs: Mutex<HashMap<String, ConnectionConfig>>,
    pub running_queries: RunningQueries,
    pub tunnels: TunnelManager,
    pub storage: Storage,
}

pub fn metadata_connection_config(config: &ConnectionConfig) -> ConnectionConfig {
    let mut db_config = config.clone();
    if matches!(db_config.db_type, DatabaseType::Mysql | DatabaseType::Doris | DatabaseType::StarRocks) {
        db_config.database = None;
    }
    db_config
}

pub fn database_connection_config(config: &ConnectionConfig, database: Option<&str>) -> ConnectionConfig {
    let mut db_config = if database.is_some() { config.clone() } else { metadata_connection_config(config) };
    if let Some(db) = database {
        if db_config.db_type != DatabaseType::Oracle
            && db_config.db_type != DatabaseType::Dameng
            && db_config.db_type != DatabaseType::Gaussdb
        {
            db_config.database = Some(db.to_string());
        }
    }
    db_config
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

    pub async fn get_or_create_pool(&self, connection_id: &str, database: Option<&str>) -> Result<String, String> {
        let db_type = {
            let configs = self.configs.lock().await;
            configs.get(connection_id).map(|c| c.db_type.clone())
        };

        let is_embedded = matches!(db_type, Some(DatabaseType::Sqlite) | Some(DatabaseType::DuckDb));
        if is_embedded {
            return Ok(connection_id.to_string());
        }

        let is_single_conn =
            matches!(db_type, Some(DatabaseType::Oracle) | Some(DatabaseType::Dameng) | Some(DatabaseType::Gaussdb));
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
            if let Some(PoolKind::Oracle(client)) = conns.get(&pool_key) {
                let conn = client.lock().await;
                if conn.is_closed() {
                    drop(conn);
                    drop(conns);
                    log::info!("[oracle] connection closed, reconnecting...");
                    self.connections.lock().await.remove(&pool_key);
                } else {
                    return Ok(pool_key);
                }
            } else {
                return Ok(pool_key);
            }
        } else {
            drop(conns);
        }

        let configs = self.configs.lock().await;
        let config = configs.get(connection_id).ok_or("Connection config not found")?.clone();
        drop(configs);

        let db_config = database_connection_config(&config, database);

        let (host, port) = self.connection_host_port(connection_id, &db_config).await?;
        probe_connection_endpoint(&db_config, &host, port).await?;
        let url = connection_url_for_endpoint(&db_config, &host, port);
        let pool = match db_config.db_type {
            DatabaseType::Mysql if db_config.needs_bare_mysql() => {
                PoolKind::Mysql(db::mysql::connect_bare(&url).await?, MysqlMode::Bare)
            }
            DatabaseType::Mysql => {
                let pool = db::mysql::connect(&url).await?;
                let mode = detect_ob_oracle_mode(&db_config, &pool).await;
                PoolKind::Mysql(pool, mode)
            }
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
                PoolKind::DuckDb(con)
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
                PoolKind::SqlServer(Arc::new(tokio::sync::Mutex::new(client)))
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
                PoolKind::Oracle(Arc::new(tokio::sync::Mutex::new(client)))
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
                PoolKind::Dameng(Arc::new(std::sync::Mutex::new(client)))
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
                PoolKind::Gaussdb(Arc::new(tokio::sync::Mutex::new(client)))
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

        let (remote_host, remote_port) = if config.db_type == DatabaseType::MongoDb {
            config
                .connection_string
                .as_deref()
                .filter(|s| !s.is_empty())
                .and_then(parse_mongo_first_host)
                .unwrap_or_else(|| (config.host.clone(), config.port))
        } else {
            (config.host.clone(), config.port)
        };

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
                &remote_host,
                remote_port,
                config.ssh_expose_lan,
            )
            .await?;

        Ok(("127.0.0.1".to_string(), local_port))
    }

    pub async fn reconnect_pool(&self, connection_id: &str, database: Option<&str>) -> Result<String, String> {
        let is_single_conn = {
            let configs = self.configs.lock().await;
            configs
                .get(connection_id)
                .map(|c| {
                    c.db_type == DatabaseType::Oracle
                        || c.db_type == DatabaseType::Elasticsearch
                        || c.db_type == DatabaseType::Dameng
                        || c.db_type == DatabaseType::Gaussdb
                })
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

pub fn redacted_connection_url_for_endpoint(config: &ConnectionConfig, host: &str, port: u16) -> String {
    if host == config.host && port == config.port {
        config.redacted_connection_url()
    } else {
        config.redacted_connection_url_with_host(host, port)
    }
}

pub async fn probe_connection_endpoint(config: &ConnectionConfig, host: &str, port: u16) -> Result<(), String> {
    match config.db_type {
        DatabaseType::Sqlite | DatabaseType::DuckDb => Ok(()),
        DatabaseType::MongoDb if config.connection_string.as_deref().is_some_and(|value| !value.is_empty()) => Ok(()),
        _ => db::probe_tcp_endpoint(&format!("{:?}", config.db_type), host, port).await,
    }
}

async fn detect_ob_oracle_mode(config: &ConnectionConfig, pool: &sqlx::mysql::MySqlPool) -> MysqlMode {
    let profile = config.driver_profile.as_deref().unwrap_or("").to_lowercase();
    if !profile.contains("oceanbase") {
        return MysqlMode::Normal;
    }
    match sqlx::query_as::<_, (String, String)>("SHOW VARIABLES LIKE 'ob_compatibility_mode'")
        .fetch_optional(pool)
        .await
    {
        Ok(Some((_, val))) if val.to_lowercase() == "oracle" => MysqlMode::OceanBaseOracle,
        _ => MysqlMode::Normal,
    }
}

#[cfg(test)]
mod tests {
    use super::{database_connection_config, metadata_connection_config};
    use crate::models::connection::{ConnectionConfig, DatabaseType};

    fn mysql_config(database: Option<&str>) -> ConnectionConfig {
        ConnectionConfig {
            id: "conn".to_string(),
            name: "MySQL".to_string(),
            db_type: DatabaseType::Mysql,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            host: "127.0.0.1".to_string(),
            port: 3306,
            username: "root".to_string(),
            password: "secret".to_string(),
            database: database.map(str::to_string),
            color: None,
            ssh_enabled: false,
            ssh_host: String::new(),
            ssh_port: 22,
            ssh_user: String::new(),
            ssh_password: String::new(),
            ssh_key_path: String::new(),
            ssh_key_passphrase: String::new(),
            ssh_expose_lan: false,
            ssl: false,
            sysdba: false,
            connection_string: None,
        }
    }

    #[test]
    fn mysql_metadata_connection_ignores_saved_default_database() {
        let config = mysql_config(Some("app"));

        let metadata = metadata_connection_config(&config);

        assert_eq!(metadata.database, None);
        assert_eq!(metadata.db_type, DatabaseType::Mysql);
    }

    #[test]
    fn mysql_database_connection_keeps_requested_database() {
        let config = mysql_config(Some("app"));

        let scoped = database_connection_config(&config, Some("analytics"));

        assert_eq!(scoped.database.as_deref(), Some("analytics"));
    }
}
