use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, RwLock};
use tokio::task::JoinHandle;

use mysql_async::prelude::Queryable;
use mysql_async::Row as MysqlRow;

use crate::agent_connection::{
    agent_connect_params, h2_file_path_from_jdbc_url, is_h2_file_connection, mongo_legacy_error_with_auth_hint,
    mongo_uses_legacy_driver, oracle_alternate_connect_config_labels, oracle_alternate_connect_configs,
    oracle_error_with_driver_hint, should_retry_mongo_with_legacy_driver, trino_like_jdbc_connection_string,
};
use crate::agent_manager::{JavaRuntimeMode, DEFAULT_JRE_KEY};
use crate::database_capabilities;
use crate::db;
use crate::db::agent_driver::AgentMethod;
use crate::db::http_tunnel::HttpTunnelManager;
use crate::db::proxy_tunnel::ProxyTunnelManager;
use crate::db::ssh_tunnel::TunnelManager;
use crate::models::connection::{
    parse_jdbc_host_port, parse_mongo_first_host, rewrite_jdbc_url_host, ConnectionConfig, DatabaseType,
};
use crate::path_utils::expand_tilde;
use crate::plugins::{PluginDriverSession, PluginRegistry, PluginRuntimeEnv};
use crate::query_cancel::RunningQueries;
use crate::storage::{normalize_duckdb_worker_max_processes, Storage, DUCKDB_WORKER_MAX_PROCESSES_DEFAULT};

pub const JDBC_PLUGIN_NOT_INSTALLED: &str =
    "JDBC plugin is not installed. Install the optional JDBC plugin to use this connection.";
pub const PRESTOSQL_JDBC_DRIVER_CLASS: &str = "io.prestosql.jdbc.PrestoDriver";
const SQLSERVER_LEGACY_DRIVER_INSTALL_HINT: &str =
    "Install the SQL Server legacy compatibility component from Driver Manager, or open the connection settings and enable SQL Server legacy compatibility mode again.";
const DEFAULT_AGENT_CONNECT_TIMEOUT_SECS: u64 = 30;
const ACCESS_AGENT_CONNECT_TIMEOUT_SECS: u64 = 30;
const POOL_CLOSE_TIMEOUT_SECS: u64 = 3;

#[cfg(feature = "duckdb-bundled")]
mod duckdb_types {
    use std::sync::Arc;
    pub type DuckDbHandle = Arc<crate::db::duckdb_driver::DuckDbConnection>;
    pub type DuckDbWorkerHandle = Arc<crate::db::duckdb_worker_process::DuckDbWorkerClient>;
    pub type ExternalTabularHandle = Arc<crate::external::ExternalPool>;
}
#[cfg(not(feature = "duckdb-bundled"))]
mod duckdb_types {
    pub type DuckDbHandle = ();
    pub type DuckDbWorkerHandle = ();
    pub type ExternalTabularHandle = ();
}

use duckdb_types::{DuckDbHandle, DuckDbWorkerHandle, ExternalTabularHandle};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MysqlMode {
    Normal,
    Bare,
    OceanBaseOracle,
}

fn is_oceanbase_mysql_config(config: &ConnectionConfig) -> bool {
    config.db_type == DatabaseType::Mysql
        && config.driver_profile.as_deref().is_some_and(|profile| profile.eq_ignore_ascii_case("oceanbase"))
}

pub(crate) fn oceanbase_mysql_query_timeout_sql(config: &ConnectionConfig, timeout_secs: u64) -> Option<String> {
    if !is_oceanbase_mysql_config(config) || timeout_secs == 0 {
        return None;
    }
    let timeout_us = timeout_secs.saturating_mul(1_000_000);
    Some(format!("SET ob_query_timeout = {timeout_us}"))
}

fn oceanbase_mysql_setup_queries(config: &ConnectionConfig) -> Vec<String> {
    oceanbase_mysql_query_timeout_sql(config, config.query_timeout_secs).into_iter().collect()
}

pub enum PoolKind {
    Mysql(db::mysql::MySqlPool, MysqlMode),
    Postgres(deadpool_postgres::Pool),
    Sqlite(db::sqlite::SqliteHandle),
    Rqlite(db::rqlite_driver::RqliteClient),
    Turso(db::turso_driver::TursoClient),
    Redis(db::redis_driver::RedisConnection),
    DuckDb(DuckDbHandle),
    DuckDbWorker(DuckDbWorkerHandle),
    MongoDb(mongodb::Client),
    ClickHouse(db::clickhouse_driver::ChClient),
    SqlServer(Arc<tokio::sync::Mutex<db::sqlserver::SqlServerClient>>),
    Elasticsearch(db::elasticsearch_driver::EsClient),
    VectorDb(db::vector_driver::VectorClient),
    InfluxDb(db::influxdb_driver::InfluxdbClient),
    Agent(Arc<tokio::sync::Mutex<db::agent_driver::AgentDriverClient>>),
    ExternalTabular(ExternalTabularHandle),
    ExternalDriver {
        driver_id: String,
        config: Arc<ConnectionConfig>,
        session: Arc<PluginDriverSession>,
    },
    /// Message queue admin connection (not a data query pool; serves as a
    /// marker that this connection_id is a valid MQ admin connection).
    MessageQueue,
    /// Nacos admin connection marker.
    Nacos,
}

/// Held connection for a manual transaction session
pub enum TxnConnection {
    Postgres(Box<deadpool_postgres::Object>),
    Mysql(mysql_async::Conn),
}

pub struct TransactionSession {
    pub connection: Arc<Mutex<TxnConnection>>,
    pub pool_key: String,
    pub last_activity: std::time::Instant,
    pub busy: bool,
    pub connection_id: String,
    pub database: String,
    pub schema: Option<String>,
}

macro_rules! agent_connection_pool_database_type {
    () => {
        DatabaseType::Dameng
            | DatabaseType::Kingbase
            | DatabaseType::Highgo
            | DatabaseType::Vastbase
            | DatabaseType::Goldendb
            | DatabaseType::Databend
            | DatabaseType::Yashandb
            | DatabaseType::Databricks
            | DatabaseType::SapHana
            | DatabaseType::Teradata
            | DatabaseType::Vertica
            | DatabaseType::Firebird
            | DatabaseType::Exasol
            | DatabaseType::OceanbaseOracle
            | DatabaseType::Gbase
            | DatabaseType::Oracle
            | DatabaseType::H2
            | DatabaseType::Snowflake
            | DatabaseType::Trino
            | DatabaseType::Hive
            | DatabaseType::Spark
            | DatabaseType::Db2
            | DatabaseType::Informix
            | DatabaseType::Neo4j
            | DatabaseType::Cassandra
            | DatabaseType::Bigquery
            | DatabaseType::Kylin
            | DatabaseType::Sundb
            | DatabaseType::Oscar
            | DatabaseType::Tdengine
            | DatabaseType::Xugu
            | DatabaseType::Iotdb
            | DatabaseType::Etcd
            | DatabaseType::ZooKeeper
            | DatabaseType::Iris
            | DatabaseType::Access
    };
}

pub struct AppState {
    pub connections: Arc<RwLock<HashMap<String, PoolKind>>>,
    keepalive_tasks: Arc<RwLock<HashMap<String, JoinHandle<()>>>>,
    pool_activity: Arc<RwLock<HashMap<String, PoolActivity>>>,
    connection_attempts: RwLock<HashMap<String, ConnectionAttemptState>>,
    pub configs: RwLock<HashMap<String, ConnectionConfig>>,
    pub running_queries: RunningQueries,
    pub tunnels: TunnelManager,
    pub proxy_tunnels: ProxyTunnelManager,
    pub http_tunnels: HttpTunnelManager,
    pub storage: Storage,
    pub plugins: PluginRegistry,
    pub agent_manager: crate::agent_manager::AgentManager,
    pub nacos_registry: crate::nacos::NacosAdminRegistry,
    duckdb_worker_process_isolation: AtomicBool,
    duckdb_worker_max_processes: AtomicUsize,
    /// PostgreSQL TLS cancel context, keyed by pool_key.
    /// Used to reconstruct a TLS connector compatible with the original connection when cancelling.
    postgres_cancel_contexts: Arc<RwLock<HashMap<String, db::postgres::PostgresCancelContext>>>,
    pub transaction_sessions: Arc<RwLock<HashMap<String, TransactionSession>>>,
    #[cfg(feature = "mq-admin")]
    pub mq_registry: crate::mq::MqAdminRegistry,
}

#[derive(Clone, Copy)]
struct PoolActivity {
    last_used_at: Instant,
}

#[derive(Clone, Copy)]
struct ConnectionAttemptState {
    server_attempt: u64,
    client_attempt: Option<u64>,
}

impl PoolActivity {
    fn now() -> Self {
        Self { last_used_at: Instant::now() }
    }
}

pub struct PoolActivityTouch {
    pool_key: String,
    connections: Arc<RwLock<HashMap<String, PoolKind>>>,
    pool_activity: Arc<RwLock<HashMap<String, PoolActivity>>>,
}

impl Drop for PoolActivityTouch {
    fn drop(&mut self) {
        let pool_key = self.pool_key.clone();
        let connections = self.connections.clone();
        let pool_activity = self.pool_activity.clone();
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        handle.spawn(async move {
            if !connections.read().await.contains_key(&pool_key) {
                return;
            }
            pool_activity.write().await.insert(pool_key, PoolActivity::now());
        });
    }
}

pub fn metadata_connection_config(config: &ConnectionConfig) -> ConnectionConfig {
    let mut db_config = config.canonicalized();
    if database_capabilities::is_metadata_connection_scoped(&db_config.db_type) {
        db_config.database = None;
    }
    db_config
}

pub fn database_connection_config(config: &ConnectionConfig, database: Option<&str>) -> ConnectionConfig {
    let mut db_config = if database.is_some() { config.clone() } else { metadata_connection_config(config) };
    if let Some(db) = database {
        if !matches!(
            db_config.db_type,
            DatabaseType::Oracle | DatabaseType::Dameng | DatabaseType::MongoDb | DatabaseType::OceanbaseOracle
        ) {
            db_config.database = Some(db.to_string());
        }
    }
    db_config
}

pub fn prestosql_jdbc_config_for_endpoint(config: &ConnectionConfig, host: &str, port: u16) -> ConnectionConfig {
    let mut jdbc_config = config.clone();
    jdbc_config.connection_string =
        Some(trino_like_jdbc_connection_string(config, host, port, config.effective_database().unwrap_or("")));
    if jdbc_config.jdbc_driver_class.as_deref().is_none_or(|value| value.trim().is_empty()) {
        jdbc_config.jdbc_driver_class = Some(PRESTOSQL_JDBC_DRIVER_CLASS.to_string());
    }
    jdbc_config
}

pub fn sqlserver_legacy_agent_config(config: &ConnectionConfig) -> ConnectionConfig {
    let mut legacy_config = config.clone();
    legacy_config.driver_profile = Some(db::sqlserver::SQLSERVER_LEGACY_DRIVER_PROFILE.to_string());
    legacy_config.driver_label = Some(db::sqlserver::SQLSERVER_LEGACY_DRIVER_LABEL.to_string());
    legacy_config
}

pub fn sqlserver_legacy_agent_error(native_error: &str, agent_error: &str) -> String {
    let install_hint = if agent_error.contains("driver is not installed") {
        format!("\n\n{SQLSERVER_LEGACY_DRIVER_INSTALL_HINT}")
    } else {
        String::new()
    };
    format!(
        "{native_error}\n\nFallback with SQL Server legacy compatibility component failed: {agent_error}{install_hint}"
    )
}

pub async fn connect_mysql_metadata_pool(
    config: &ConnectionConfig,
    db_config: &ConnectionConfig,
    host: &str,
    port: u16,
    connect_timeout: std::time::Duration,
    max_connections: usize,
) -> Result<(db::mysql::MySqlPool, MysqlMode), String> {
    let url = connection_url_for_endpoint(db_config, host, port);
    let idle_timeout_secs = Some(db_config.idle_timeout_secs);
    let extra_setup_queries = oceanbase_mysql_setup_queries(db_config);
    if db_config.needs_bare_mysql() {
        return match connect_bare_mysql_pool_with_setup(
            db_config,
            &url,
            connect_timeout,
            max_connections,
            &extra_setup_queries,
        )
        .await
        {
            Ok(pool) => Ok((pool, MysqlMode::Bare)),
            Err(err) => {
                let fallback_url = mysql_metadata_fallback_url(config, db_config, host, port);
                if let Some(fallback_url) = fallback_url {
                    log::info!(
                        "MySQL metadata connection without a default database failed ({err}); retrying with configured default database."
                    );
                    connect_bare_mysql_pool_with_setup(
                        db_config,
                        &fallback_url,
                        connect_timeout,
                        max_connections,
                        &extra_setup_queries,
                    )
                    .await
                    .map(|pool| (pool, MysqlMode::Bare))
                } else if let Some(db) = db_config.effective_database() {
                    let mut unscoped_config = db_config.clone();
                    unscoped_config.database = None;
                    let unscoped_url = connection_url_for_endpoint(&unscoped_config, host, port);
                    log::info!("MySQL connection with database in URL failed ({err}); retrying without database in URL and using USE statement.");
                    connect_bare_mysql_pool_with_setup_database(
                        &unscoped_config,
                        &unscoped_url,
                        connect_timeout,
                        max_connections,
                        db,
                        &extra_setup_queries,
                    )
                    .await
                    .map(|pool| (pool, MysqlMode::Bare))
                } else {
                    Err(err)
                }
            }
        };
    }

    match db::mysql::connect_with_ca_cert_pool_limit_idle_and_setup(
        &url,
        Some(&db_config.ca_cert_path),
        connect_timeout,
        max_connections,
        idle_timeout_secs,
        &extra_setup_queries,
    )
    .await
    {
        Ok(pool) => {
            let mode = detect_ob_oracle_mode(config, &pool).await;
            Ok((pool, mode))
        }
        Err(err) => {
            let fallback_url = mysql_metadata_fallback_url(config, db_config, host, port);
            if let Some(fallback_url) = fallback_url {
                log::info!(
                    "MySQL metadata connection without a default database failed ({err}); retrying with configured default database."
                );
                let pool = db::mysql::connect_with_ca_cert_pool_limit_idle_and_setup(
                    &fallback_url,
                    Some(&config.ca_cert_path),
                    connect_timeout,
                    max_connections,
                    idle_timeout_secs,
                    &extra_setup_queries,
                )
                .await?;
                let mode = detect_ob_oracle_mode(config, &pool).await;
                Ok((pool, mode))
            } else if let Some(db) = db_config.effective_database() {
                let mut unscoped_config = db_config.clone();
                unscoped_config.database = None;
                let unscoped_url = connection_url_for_endpoint(&unscoped_config, host, port);
                log::info!("MySQL connection with database in URL failed ({err}); retrying without database in URL and using USE statement.");
                let pool = db::mysql::connect_with_ca_cert_pool_limit_idle_and_setup_database(
                    &unscoped_url,
                    Some(&config.ca_cert_path),
                    connect_timeout,
                    max_connections,
                    idle_timeout_secs,
                    Some(db),
                    &extra_setup_queries,
                )
                .await?;
                let mode = detect_ob_oracle_mode(config, &pool).await;
                Ok((pool, mode))
            } else {
                Err(err)
            }
        }
    }
}

pub async fn connect_bare_metadata_pool(
    db_config: &ConnectionConfig,
    host: &str,
    port: u16,
    connect_timeout: std::time::Duration,
    max_connections: usize,
) -> Result<db::mysql::MySqlPool, String> {
    let url = connection_url_for_endpoint(db_config, host, port);
    let extra_setup_queries = oceanbase_mysql_setup_queries(db_config);
    if db_config.effective_database().is_none() {
        return connect_bare_mysql_pool_with_setup(
            db_config,
            &url,
            connect_timeout,
            max_connections,
            &extra_setup_queries,
        )
        .await;
    }

    let mut unscoped_config = db_config.clone();
    unscoped_config.database = None;
    let unscoped_url = connection_url_for_endpoint(&unscoped_config, host, port);
    if unscoped_url == url {
        return connect_bare_mysql_pool_with_setup(
            db_config,
            &url,
            connect_timeout,
            max_connections,
            &extra_setup_queries,
        )
        .await;
    }

    let preferred =
        connect_bare_mysql_pool_with_setup(db_config, &url, connect_timeout, max_connections, &extra_setup_queries);
    let unscoped = connect_bare_mysql_pool_with_setup(
        db_config,
        &unscoped_url,
        connect_timeout,
        max_connections,
        &extra_setup_queries,
    );
    tokio::pin!(preferred);
    tokio::pin!(unscoped);

    tokio::select! {
        result = &mut preferred => match result {
            Ok(pool) => Ok(pool),
            Err(preferred_err) => match (&mut unscoped).await {
                Ok(pool) => Ok(pool),
                Err(unscoped_err) => Err(format!(
                    "Connection with the configured database failed: {preferred_err}\n\nConnection without a default database also failed: {unscoped_err}"
                )),
            },
        },
        result = &mut unscoped => match result {
            Ok(pool) => Ok(pool),
            Err(unscoped_err) => match (&mut preferred).await {
                Ok(pool) => Ok(pool),
                Err(preferred_err) => Err(format!(
                    "Connection with the configured database failed: {preferred_err}\n\nConnection without a default database also failed: {unscoped_err}"
                )),
            },
        },
    }
}

async fn connect_bare_mysql_pool_with_setup(
    db_config: &ConnectionConfig,
    url: &str,
    connect_timeout: std::time::Duration,
    max_connections: usize,
    extra_setup_queries: &[String],
) -> Result<db::mysql::MySqlPool, String> {
    if db_config.bare_mysql_uses_tls() {
        let idle_timeout_secs = Some(db_config.idle_timeout_secs);
        db::mysql::connect_compatible_with_ca_cert_pool_limit_idle_and_setup(
            url,
            Some(&db_config.ca_cert_path),
            connect_timeout,
            max_connections,
            idle_timeout_secs,
            extra_setup_queries,
        )
        .await
    } else {
        db::mysql::connect_bare_with_pool_limit_and_setup(url, connect_timeout, max_connections, extra_setup_queries)
            .await
    }
}

async fn connect_bare_mysql_pool_with_setup_database(
    db_config: &ConnectionConfig,
    url: &str,
    connect_timeout: std::time::Duration,
    max_connections: usize,
    setup_database: &str,
    extra_setup_queries: &[String],
) -> Result<db::mysql::MySqlPool, String> {
    // Some MySQL proxies reject the default database in the handshake; pass it
    // separately so DB-layer setup keeps the normal charset/catalog/USE order.
    if db_config.bare_mysql_uses_tls() {
        let idle_timeout_secs = Some(db_config.idle_timeout_secs);
        db::mysql::connect_compatible_with_ca_cert_pool_limit_idle_and_setup_database(
            url,
            Some(&db_config.ca_cert_path),
            connect_timeout,
            max_connections,
            idle_timeout_secs,
            Some(setup_database),
            extra_setup_queries,
        )
        .await
    } else {
        db::mysql::connect_bare_with_pool_limit_and_setup_database(
            url,
            connect_timeout,
            max_connections,
            Some(setup_database),
            extra_setup_queries,
        )
        .await
    }
}

fn mysql_metadata_fallback_url(
    config: &ConnectionConfig,
    db_config: &ConnectionConfig,
    host: &str,
    port: u16,
) -> Option<String> {
    if db_config.db_type != DatabaseType::Mysql || db_config.effective_database().is_some() {
        return None;
    }
    config.effective_database()?;
    Some(connection_url_for_endpoint(config, host, port))
}

impl AppState {
    pub fn new(storage: Storage) -> Self {
        Self::new_with_plugin_dir(storage, default_plugin_dir())
    }

    pub fn new_with_plugin_dir(storage: Storage, plugin_dir: PathBuf) -> Self {
        Self::new_with_plugin_dir_and_app_version(storage, plugin_dir, env!("CARGO_PKG_VERSION"))
    }

    pub fn new_with_plugin_dir_and_app_version(
        storage: Storage,
        plugin_dir: PathBuf,
        app_version: impl Into<String>,
    ) -> Self {
        Self::new_with_plugin_and_agent_dir_and_app_version(storage, plugin_dir, default_agent_dir(), app_version)
    }

    pub fn new_with_plugin_and_agent_dir_and_app_version(
        storage: Storage,
        plugin_dir: PathBuf,
        agent_dir: PathBuf,
        app_version: impl Into<String>,
    ) -> Self {
        Self {
            connections: Arc::new(RwLock::new(HashMap::new())),
            keepalive_tasks: Arc::new(RwLock::new(HashMap::new())),
            pool_activity: Arc::new(RwLock::new(HashMap::new())),
            connection_attempts: RwLock::new(HashMap::new()),
            configs: RwLock::new(HashMap::new()),
            running_queries: RunningQueries::default(),
            tunnels: TunnelManager::new(),
            proxy_tunnels: ProxyTunnelManager::new(),
            http_tunnels: HttpTunnelManager::new(),
            storage,
            plugins: PluginRegistry::new(plugin_dir),
            agent_manager: crate::agent_manager::AgentManager::new_with_base_dir_and_app_version(
                agent_dir,
                app_version,
            ),
            nacos_registry: crate::nacos::NacosAdminRegistry::new(),
            duckdb_worker_process_isolation: AtomicBool::new(false),
            duckdb_worker_max_processes: AtomicUsize::new(DUCKDB_WORKER_MAX_PROCESSES_DEFAULT),
            postgres_cancel_contexts: Arc::new(RwLock::new(HashMap::new())),
            transaction_sessions: Arc::new(RwLock::new(HashMap::new())),
            #[cfg(feature = "mq-admin")]
            mq_registry: crate::mq::MqAdminRegistry::new(),
        }
    }

    pub fn jdbc_unavailable_error(&self) -> String {
        match self.plugins.find_driver("jdbc") {
            Ok(Some(_)) => "JDBC plugin is installed, but the connection could not be opened.".to_string(),
            Ok(None) => JDBC_PLUGIN_NOT_INSTALLED.to_string(),
            Err(err) => format!("Failed to inspect JDBC plugin: {err}"),
        }
    }

    pub fn set_duckdb_worker_process_isolation_enabled(&self, enabled: bool) {
        self.duckdb_worker_process_isolation.store(enabled, Ordering::Relaxed);
    }

    pub fn set_duckdb_worker_max_processes(&self, max_processes: usize) {
        self.duckdb_worker_max_processes.store(normalize_duckdb_worker_max_processes(max_processes), Ordering::Relaxed);
    }

    pub async fn apply_duckdb_worker_process_isolation(&self, enabled: bool) {
        let previous = self.duckdb_worker_process_isolation.swap(enabled, Ordering::Relaxed);
        if previous != enabled {
            self.remove_duckdb_pools_detached().await;
        }
    }

    pub async fn test_external_driver(&self, driver_id: &str, config: &ConnectionConfig) -> Result<String, String> {
        let params = serde_json::json!({ "connection": config });
        let env = self.external_driver_runtime_env(driver_id)?;
        self.plugins
            .invoke_driver_with_env_and_timeout::<serde_json::Value>(
                driver_id,
                "testConnection",
                params,
                env,
                Some(external_driver_connect_timeout(config)),
            )
            .await?;
        Ok("Connection successful".to_string())
    }

    pub async fn external_driver_pool(&self, driver_id: &str, config: &ConnectionConfig) -> Result<PoolKind, String> {
        let env = self.external_driver_runtime_env(driver_id)?;
        let session = self.plugins.start_driver_session_with_env(driver_id, env).await?;
        let params = serde_json::json!({ "connection": config });
        session
            .invoke_with_timeout::<serde_json::Value>("connect", params, Some(external_driver_connect_timeout(config)))
            .await?;
        Ok(PoolKind::ExternalDriver { driver_id: driver_id.to_string(), config: Arc::new(config.clone()), session })
    }

    pub async fn test_sqlserver_connection_with_legacy_fallback(
        &self,
        config: &ConnectionConfig,
        host: &str,
        port: u16,
        connect_timeout: Duration,
    ) -> Result<String, String> {
        match db::sqlserver::connect(
            host,
            port,
            &config.username,
            &config.password,
            config.database.as_deref(),
            config.url_params.as_deref(),
            connect_timeout,
        )
        .await
        {
            Ok(_) => Ok("Connection successful".to_string()),
            Err(native_error)
                if db::sqlserver::sqlserver_legacy_compatibility_enabled(config.url_params.as_deref()) =>
            {
                let legacy_config = sqlserver_legacy_agent_config(config);
                let connect_params =
                    agent_connect_params(&legacy_config, host, port, legacy_config.effective_database().unwrap_or(""));
                let mut client = self
                    .agent_manager
                    .spawn(&legacy_config.db_type, legacy_config.driver_profile.as_deref())
                    .await
                    .map_err(|err| sqlserver_legacy_agent_error(&native_error, &err))?;
                client
                    .call_method_with_timeout::<serde_json::Value>(
                        AgentMethod::TestConnection,
                        connect_params,
                        Some(agent_connect_timeout(&legacy_config)),
                    )
                    .await
                    .map_err(|err| sqlserver_legacy_agent_error(&native_error, &err))?;
                client.disconnect().await.ok();
                Ok("Connection successful (via SQL Server legacy compatibility driver)".to_string())
            }
            Err(err) => Err(err),
        }
    }

    pub async fn connect_sqlserver_pool_with_legacy_fallback(
        &self,
        config: &ConnectionConfig,
        host: &str,
        port: u16,
        connect_timeout: Duration,
    ) -> Result<PoolKind, String> {
        match db::sqlserver::connect(
            host,
            port,
            &config.username,
            &config.password,
            config.database.as_deref(),
            config.url_params.as_deref(),
            connect_timeout,
        )
        .await
        {
            Ok(client) => Ok(PoolKind::SqlServer(Arc::new(tokio::sync::Mutex::new(client)))),
            Err(native_error)
                if db::sqlserver::sqlserver_legacy_compatibility_enabled(config.url_params.as_deref()) =>
            {
                let legacy_config = sqlserver_legacy_agent_config(config);
                let connect_params =
                    agent_connect_params(&legacy_config, host, port, legacy_config.effective_database().unwrap_or(""));
                let mut client = self
                    .agent_manager
                    .spawn(&legacy_config.db_type, legacy_config.driver_profile.as_deref())
                    .await
                    .map_err(|err| sqlserver_legacy_agent_error(&native_error, &err))?;
                client
                    .call_method_with_timeout::<serde_json::Value>(
                        AgentMethod::Connect,
                        connect_params,
                        Some(agent_connect_timeout(&legacy_config)),
                    )
                    .await
                    .map_err(|err| sqlserver_legacy_agent_error(&native_error, &err))?;
                Ok(PoolKind::Agent(Arc::new(tokio::sync::Mutex::new(client))))
            }
            Err(err) => Err(err),
        }
    }

    pub fn external_driver_runtime_env(&self, driver_id: &str) -> Result<PluginRuntimeEnv, String> {
        if driver_id != "jdbc" {
            return Ok(PluginRuntimeEnv::default());
        }
        let state = self.agent_manager.load_state();
        if state.java_runtime.mode == JavaRuntimeMode::Managed && !self.agent_manager.is_jre_installed(DEFAULT_JRE_KEY)
        {
            return Ok(PluginRuntimeEnv::default());
        }
        let java = self.agent_manager.resolve_java_runtime(&state, DEFAULT_JRE_KEY)?;
        Ok(PluginRuntimeEnv::default().with_var("DBX_JAVA_BIN", java.to_string_lossy().to_string()))
    }

    pub async fn insert_connection_pool(&self, pool_key: String, pool: PoolKind, config: &ConnectionConfig) {
        self.stop_keepalive_task(&pool_key).await;
        self.pool_activity.write().await.insert(pool_key.clone(), PoolActivity::now());
        self.start_keepalive_task(&pool_key, &pool, config).await;
        let previous_key = pool_key.clone();
        let previous = self.connections.write().await.insert(pool_key, pool);
        if let Some(pool) = previous {
            close_pool_kind_with_timeout(previous_key, pool).await;
        }
    }

    pub async fn begin_connection_attempt(&self, connection_id: &str) -> u64 {
        self.begin_connection_attempt_with_client_attempt(connection_id, None).await
    }

    pub async fn begin_connection_attempt_with_client_attempt(
        &self,
        connection_id: &str,
        client_attempt: Option<u64>,
    ) -> u64 {
        let mut attempts = self.connection_attempts.write().await;
        let next = attempts.get(connection_id).map(|state| state.server_attempt).unwrap_or(0).wrapping_add(1);
        attempts.insert(connection_id.to_string(), ConnectionAttemptState { server_attempt: next, client_attempt });
        next
    }

    pub async fn supersede_connection_attempt(&self, connection_id: &str) {
        self.begin_connection_attempt(connection_id).await;
    }

    pub async fn supersede_connection_attempt_if_client_attempt(
        &self,
        connection_id: &str,
        client_attempt: u64,
    ) -> bool {
        let mut attempts = self.connection_attempts.write().await;
        let Some(current) = attempts.get(connection_id).copied() else {
            return false;
        };
        if current.client_attempt != Some(client_attempt) {
            return false;
        }
        attempts.insert(
            connection_id.to_string(),
            ConnectionAttemptState { server_attempt: current.server_attempt.wrapping_add(1), client_attempt: None },
        );
        true
    }

    async fn connection_attempt_is_current(&self, connection_id: &str, attempt: u64) -> bool {
        self.connection_attempts.read().await.get(connection_id).map(|state| state.server_attempt) == Some(attempt)
    }

    pub async fn ensure_current_connection_attempt(
        &self,
        connection_id: &str,
        attempt: Option<u64>,
    ) -> Result<(), String> {
        let Some(attempt) = attempt else {
            return Ok(());
        };
        if self.connection_attempt_is_current(connection_id, attempt).await {
            Ok(())
        } else {
            Err("Connection attempt was superseded by a newer attempt".to_string())
        }
    }

    pub async fn insert_connection_pool_for_attempt(
        &self,
        connection_id: &str,
        attempt: u64,
        pool_key: String,
        pool: PoolKind,
        config: &ConnectionConfig,
    ) -> Result<(), String> {
        if let Err(err) = self.ensure_current_connection_attempt(connection_id, Some(attempt)).await {
            close_pool_kind_with_timeout(pool_key, pool).await;
            return Err(err);
        }
        self.insert_connection_pool(pool_key, pool, config).await;
        Ok(())
    }

    async fn discard_stale_connection_attempt_pool(
        &self,
        connection_id: &str,
        pool_key: String,
        pool: PoolKind,
        config: &ConnectionConfig,
    ) {
        // mq_registry only exists in mq-admin builds; other builds reject MQ connects before a pool is created.
        #[cfg(feature = "mq-admin")]
        if matches!(pool, PoolKind::MessageQueue) {
            self.mq_registry.drop_connection(connection_id).await;
        }
        self.reset_connection_transport_for_config(connection_id, config).await;
        close_pool_kind_with_timeout(pool_key, pool).await;
    }

    async fn start_keepalive_task(&self, pool_key: &str, pool: &PoolKind, config: &ConnectionConfig) {
        let interval_secs = config.keepalive_interval_secs;
        let idle_timeout_secs = config.idle_timeout_secs;
        let idle_cleanup_enabled = is_session_scoped_pool_key(pool_key) && idle_timeout_secs > 0;
        let mut target = keepalive_target_from_pool(pool, config);
        if interval_secs == 0 && !idle_cleanup_enabled {
            return;
        }
        if interval_secs > 0 && target.is_none() {
            log::debug!(
                "Connection keepalive requested for '{pool_key}', but this database driver does not keep a pingable client handle."
            );
            if !idle_cleanup_enabled {
                return;
            }
        };

        let key = pool_key.to_string();
        let interval = if interval_secs > 0 {
            Duration::from_secs(interval_secs.max(1))
        } else {
            Duration::from_secs(idle_timeout_secs.min(60).max(1))
        };
        let timeout = Duration::from_secs(config.effective_connect_timeout_secs().max(1));
        let connections = self.connections.clone();
        let keepalive_tasks = self.keepalive_tasks.clone();
        let pool_activity = self.pool_activity.clone();
        let cancel_contexts = self.postgres_cancel_contexts.clone();
        let running_queries = self.running_queries.clone();
        let idle_timeout = Duration::from_secs(idle_timeout_secs.max(1));
        let handle = tokio::spawn(async move {
            loop {
                tokio::time::sleep(interval).await;

                if running_queries.is_pool_active(&key) {
                    continue;
                }

                if idle_cleanup_enabled {
                    let idle_for = {
                        let activity = pool_activity.read().await;
                        activity.get(&key).map(|activity| activity.last_used_at.elapsed())
                    };
                    if idle_for.is_some_and(|elapsed| elapsed >= idle_timeout) {
                        log::info!(
                            "Closing idle session-scoped connection pool '{key}' after {}s",
                            idle_timeout.as_secs()
                        );
                        keepalive_tasks.write().await.remove(&key);
                        pool_activity.write().await.remove(&key);
                        cancel_contexts.write().await.remove(&key);
                        let removed = connections.write().await.remove(&key);
                        if let Some(pool) = removed {
                            close_pool_kind_with_timeout(key, pool).await;
                        }
                        break;
                    }
                }

                if let Some(target) = target.as_mut() {
                    let result = tokio::time::timeout(timeout, ping_keepalive_target(target, timeout)).await;
                    match result {
                        Ok(Ok(())) => {}
                        Ok(Err(err)) => {
                            log::warn!("Connection keepalive failed for '{key}': {err}; invalidating pool");
                            keepalive_tasks.write().await.remove(&key);
                            pool_activity.write().await.remove(&key);
                            cancel_contexts.write().await.remove(&key);
                            let removed = connections.write().await.remove(&key);
                            if let Some(pool) = removed {
                                close_pool_kind_with_timeout(key, pool).await;
                            }
                            break;
                        }
                        Err(_) => {
                            log::warn!(
                                "Connection keepalive timed out for '{key}' after {}s; invalidating pool",
                                timeout.as_secs()
                            );
                            keepalive_tasks.write().await.remove(&key);
                            pool_activity.write().await.remove(&key);
                            cancel_contexts.write().await.remove(&key);
                            let removed = connections.write().await.remove(&key);
                            if let Some(pool) = removed {
                                close_pool_kind_with_timeout(key, pool).await;
                            }
                            break;
                        }
                    }
                }
            }
        });
        let previous = self.keepalive_tasks.write().await.insert(pool_key.to_string(), handle);
        if let Some(previous) = previous {
            previous.abort();
        }
    }

    async fn stop_keepalive_task(&self, pool_key: &str) {
        let task = self.keepalive_tasks.write().await.remove(pool_key);
        if let Some(task) = task {
            task.abort();
        }
    }

    async fn stop_keepalive_tasks(&self, pool_keys: &[String]) {
        let mut tasks = self.keepalive_tasks.write().await;
        for pool_key in pool_keys {
            if let Some(task) = tasks.remove(pool_key) {
                task.abort();
            }
        }
    }

    pub async fn touch_pool_activity(&self, pool_key: &str) {
        self.pool_activity.write().await.insert(pool_key.to_string(), PoolActivity::now());
    }

    /// Get the PostgreSQL TLS cancel context (used to reconstruct the TLS connector when cancelling a query).
    pub async fn get_postgres_cancel_context(&self, pool_key: &str) -> Option<db::postgres::PostgresCancelContext> {
        self.postgres_cancel_contexts.read().await.get(pool_key).cloned()
    }

    pub fn pool_activity_touch(&self, pool_key: &str) -> PoolActivityTouch {
        PoolActivityTouch {
            pool_key: pool_key.to_string(),
            connections: self.connections.clone(),
            pool_activity: self.pool_activity.clone(),
        }
    }

    pub async fn get_or_create_pool(&self, connection_id: &str, database: Option<&str>) -> Result<String, String> {
        self.get_or_create_pool_for_session(connection_id, database, None).await
    }

    pub async fn get_or_create_pool_for_connection_attempt(
        &self,
        connection_id: &str,
        database: Option<&str>,
        attempt: u64,
    ) -> Result<String, String> {
        self.get_or_create_pool_for_session_inner(connection_id, database, None, Some(attempt)).await
    }

    pub async fn get_or_create_pool_for_session(
        &self,
        connection_id: &str,
        database: Option<&str>,
        client_session_id: Option<&str>,
    ) -> Result<String, String> {
        self.get_or_create_pool_for_session_inner(connection_id, database, client_session_id, None).await
    }

    async fn get_or_create_pool_for_session_inner(
        &self,
        connection_id: &str,
        database: Option<&str>,
        client_session_id: Option<&str>,
        connection_attempt: Option<u64>,
    ) -> Result<String, String> {
        let db_type = {
            let configs = self.configs.read().await;
            configs.get(connection_id).map(|c| c.db_type)
        };

        let base_pool_key = base_pool_key_for(db_type, connection_id, database, false);
        let pool_key = session_scoped_pool_key_for(db_type, base_pool_key, client_session_id);

        let conns = self.connections.read().await;
        if conns.contains_key(&pool_key) {
            drop(conns);
            if self.remove_pool_if_duckdb_isolation_mismatch(&pool_key).await {
                // Recreate below using the current DuckDB isolation mode.
            } else if !self.remove_stale_connection_pool(&pool_key).await {
                self.touch_pool_activity(&pool_key).await;
                return Ok(pool_key);
            }
        } else {
            drop(conns);
        }

        let configs = self.configs.read().await;
        let config = configs.get(connection_id).ok_or("Connection config not found")?.clone();
        drop(configs);

        let db_config = database_connection_config(&config, database);

        validate_h2_file_connection(&db_config)?;
        self.ensure_current_connection_attempt(connection_id, connection_attempt).await?;
        let (host, port) = self.connection_host_port(connection_id, &db_config).await?;
        if let Err(err) = self.ensure_current_connection_attempt(connection_id, connection_attempt).await {
            self.reset_connection_transport_for_config(connection_id, &db_config).await;
            return Err(err);
        }
        probe_connection_endpoint(&db_config, &host, port).await?;
        if let Err(err) = self.ensure_current_connection_attempt(connection_id, connection_attempt).await {
            self.reset_connection_transport_for_config(connection_id, &db_config).await;
            return Err(err);
        }
        let url = connection_url_for_endpoint(&db_config, &host, port);
        let connect_timeout = std::time::Duration::from_secs(db_config.effective_connect_timeout_secs());
        let idle_timeout = std::time::Duration::from_secs(db_config.idle_timeout_secs);
        let mysql_pool_max_connections = mysql_pool_max_connections_for_session(client_session_id);
        let pool = match db_config.db_type {
            DatabaseType::Mysql => {
                let (pool, mode) = connect_mysql_metadata_pool(
                    &config,
                    &db_config,
                    &host,
                    port,
                    connect_timeout,
                    mysql_pool_max_connections,
                )
                .await?;
                PoolKind::Mysql(pool, mode)
            }
            DatabaseType::Doris | DatabaseType::StarRocks | DatabaseType::ManticoreSearch => {
                let pool = if database.is_none() {
                    connect_bare_metadata_pool(&db_config, &host, port, connect_timeout, mysql_pool_max_connections)
                        .await?
                } else {
                    connect_bare_mysql_pool_with_setup(
                        &db_config,
                        &url,
                        connect_timeout,
                        mysql_pool_max_connections,
                        &oceanbase_mysql_setup_queries(&db_config),
                    )
                    .await?
                };
                PoolKind::Mysql(pool, MysqlMode::Bare)
            }
            DatabaseType::Postgres
            | DatabaseType::Redshift
            | DatabaseType::Gaussdb
            | DatabaseType::Kwdb
            | DatabaseType::Questdb
            | DatabaseType::OpenGauss => {
                let pg_pool = db::postgres::connect(&url, connect_timeout).await?;
                // Build TLS cancel context for reconstructing TLS connection during cancel
                if let Some(ctx) = db::postgres::build_postgres_cancel_context(&url) {
                    self.postgres_cancel_contexts.write().await.insert(pool_key.clone(), ctx);
                }
                PoolKind::Postgres(pg_pool)
            }
            DatabaseType::Sqlite => {
                let extensions = db::sqlite::sqlite_extension_specs_from_url_params(db_config.url_params.as_deref())
                    .into_iter()
                    .map(|mut extension| {
                        extension.path = expand_tilde(&extension.path);
                        extension
                    })
                    .collect();
                PoolKind::Sqlite(
                    db::sqlite::connect_path_with_cipher_key_and_extensions(
                        &expand_tilde(&db_config.host),
                        &db_config.password,
                        extensions,
                    )
                    .await?,
                )
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
                    db_config.url_params.as_deref().and_then(extract_auth_token_from_params).unwrap_or_default()
                };
                let client = db::turso_driver::TursoClient::new(&url, &auth_token, db_config.ssl, connect_timeout)?;
                db::turso_driver::test_connection(&client, connect_timeout).await?;
                PoolKind::Turso(client)
            }
            DatabaseType::Redis => {
                let con = if db_config.uses_redis_cluster() {
                    db::redis_driver::RedisConnection::Cluster(
                        self.connect_redis_cluster(connection_id, &db_config).await?,
                    )
                } else if db_config.uses_redis_sentinel() {
                    db::redis_driver::RedisConnection::Direct(tokio::sync::Mutex::new(
                        self.connect_redis_sentinel(connection_id, &db_config).await?,
                    ))
                } else {
                    db::redis_driver::RedisConnection::Direct(tokio::sync::Mutex::new(
                        db::redis_driver::connect_standalone(&db_config, &host, port, connect_timeout).await?,
                    ))
                };
                PoolKind::Redis(con)
            }
            #[cfg(feature = "duckdb-bundled")]
            DatabaseType::DuckDb => {
                if self.duckdb_worker_process_isolation.load(Ordering::Relaxed) {
                    let attached_databases = db_config
                        .attached_databases
                        .iter()
                        .map(|attached| crate::models::connection::AttachedDatabaseConfig {
                            name: attached.name.clone(),
                            path: expand_tilde(&attached.path),
                        })
                        .collect();
                    let client = db::duckdb_worker_process::DuckDbWorkerClient::open_with_process_limit(
                        expand_tilde(&db_config.host),
                        attached_databases,
                        self.duckdb_worker_max_processes.load(Ordering::Relaxed),
                    )
                    .await?;
                    PoolKind::DuckDbWorker(Arc::new(client))
                } else {
                    let con = db::duckdb_driver::connect_path(&expand_tilde(&db_config.host))?;
                    {
                        let locked = con.lock().map_err(|e| e.to_string())?;
                        for attached in &db_config.attached_databases {
                            crate::schema::duckdb_attach_database(
                                &locked,
                                &attached.name,
                                &expand_tilde(&attached.path),
                            )?;
                        }
                    }
                    PoolKind::DuckDb(con)
                }
            }
            #[cfg(not(feature = "duckdb-bundled"))]
            DatabaseType::DuckDb => {
                return Err("DuckDB support is not compiled in this build. Rebuild with default features.".to_string());
            }
            DatabaseType::MongoDb => {
                if mongo_uses_legacy_driver(&db_config) {
                    log::info!("Using configured MongoDB legacy driver for connection_id={connection_id}");
                    let connect_params = serde_json::json!({ "connection": agent_connect_params(&db_config, &host, port, db_config.effective_database().unwrap_or("")) });
                    let mut client = self.agent_manager.spawn(&DatabaseType::MongoDb, Some("mongodb-legacy")).await?;
                    client.connect(connect_params).await.map_err(|err| mongo_legacy_error_with_auth_hint(&err))?;
                    PoolKind::Agent(Arc::new(tokio::sync::Mutex::new(client)))
                } else {
                    let native_err = match db::mongo_driver::connect(&url, connect_timeout, idle_timeout).await {
                        Ok(client) => match db::mongo_driver::test_connection(
                            &client,
                            connect_timeout,
                            db_config.effective_database(),
                        )
                        .await
                        {
                            Ok(()) => {
                                // Re-check: another task may have created the pool while we were connecting.
                                if self.connections.read().await.contains_key(&pool_key) {
                                    close_pool_kind_with_timeout(pool_key.clone(), PoolKind::MongoDb(client)).await;
                                    return Ok(pool_key);
                                }
                                if let Err(err) =
                                    self.ensure_current_connection_attempt(connection_id, connection_attempt).await
                                {
                                    self.discard_stale_connection_attempt_pool(
                                        connection_id,
                                        pool_key.clone(),
                                        PoolKind::MongoDb(client),
                                        &db_config,
                                    )
                                    .await;
                                    return Err(err);
                                }
                                self.insert_connection_pool(pool_key.clone(), PoolKind::MongoDb(client), &db_config)
                                    .await;
                                return Ok(pool_key);
                            }
                            Err(e) => e,
                        },
                        Err(e) => e,
                    };
                    if should_retry_mongo_with_legacy_driver(&native_err) {
                        log::info!("Native MongoDB driver failed ({native_err}), falling back to agent driver");
                        let connect_params = serde_json::json!({ "connection": agent_connect_params(&db_config, &host, port, db_config.effective_database().unwrap_or("")) });
                        let mut client =
                            self.agent_manager.spawn(&DatabaseType::MongoDb, Some("mongodb-legacy")).await?;
                        client.connect(connect_params).await.map_err(|err| {
                            format!(
                                "{native_err}\n\nFallback with MongoDB (Legacy) driver failed: {}",
                                mongo_legacy_error_with_auth_hint(&err)
                            )
                        })?;
                        PoolKind::Agent(Arc::new(tokio::sync::Mutex::new(client)))
                    } else {
                        return Err(native_err);
                    }
                }
            }
            DatabaseType::ClickHouse => {
                let username = if db_config.username.is_empty() { None } else { Some(db_config.username.clone()) };
                let password = if db_config.password.is_empty() { None } else { Some(db_config.password.clone()) };
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
                self.connect_sqlserver_pool_with_legacy_fallback(&db_config, &host, port, connect_timeout).await?
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
                );
                db::vector_driver::test_connection(&client, connect_timeout).await?;
                PoolKind::VectorDb(client)
            }
            DatabaseType::InfluxDb => {
                let client = db::influxdb_driver::InfluxdbClient::new_for_config(&url, &db_config, connect_timeout)?;
                db::influxdb_driver::test_connection(&client, connect_timeout).await?;
                PoolKind::InfluxDb(client)
            }
            DatabaseType::Nacos => {
                let admin_config = self.nacos_admin_config_for_connection(connection_id, &config).await?;
                let adapter = self.nacos_registry.build_transient_config(admin_config).await?;
                adapter.test_connection().await?;
                PoolKind::Nacos
            }
            agent_connection_pool_database_type!() => {
                let connect_params =
                    agent_connect_params(&db_config, &host, port, db_config.effective_database().unwrap_or(""));
                // Kerberos JVM properties are connection-scoped; shared agent daemons must not inherit them.
                let mut client = self
                    .agent_manager
                    .spawn_with_extra_java_args(
                        &db_config.db_type,
                        db_config.driver_profile.as_deref(),
                        &db_config.agent_java_options,
                    )
                    .await?;
                let connect_result = client
                    .call_method_with_timeout::<serde_json::Value>(
                        AgentMethod::Connect,
                        connect_params,
                        Some(agent_connect_timeout(&db_config)),
                    )
                    .await;
                if let Err(err) = connect_result {
                    let alternate_configs = oracle_alternate_connect_configs(&db_config, &err);
                    if !alternate_configs.is_empty() {
                        log::warn!(
                            "Oracle connect failed with {:?} descriptor: {}. Retrying with Oracle JDBC URL variants: {:?}.",
                            db_config.oracle_connection_type,
                            err,
                            oracle_alternate_connect_config_labels(&alternate_configs)
                        );
                        let mut fallback_errors = Vec::new();
                        let mut connected = false;
                        for alternate_config in alternate_configs {
                            let label = oracle_alternate_connect_config_labels(std::slice::from_ref(&alternate_config))
                                .into_iter()
                                .next()
                                .unwrap_or_else(|| "alternate".to_string());
                            match client
                                .call_method_with_timeout::<serde_json::Value>(
                                    AgentMethod::Connect,
                                    agent_connect_params(
                                        &alternate_config,
                                        &host,
                                        port,
                                        alternate_config.effective_database().unwrap_or(""),
                                    ),
                                    Some(agent_connect_timeout(&alternate_config)),
                                )
                                .await
                            {
                                Ok(_) => {
                                    connected = true;
                                    break;
                                }
                                Err(alternate_err) => {
                                    fallback_errors.push(format!("{label}: {alternate_err}"));
                                }
                            }
                        }
                        if !connected {
                            return Err(format!(
                                "{err}\n\nFallback with alternate Oracle JDBC URLs failed: {}",
                                fallback_errors.join("\n")
                            ));
                        }
                    } else {
                        return Err(oracle_error_with_driver_hint(&db_config, &err));
                    }
                }
                PoolKind::Agent(Arc::new(tokio::sync::Mutex::new(client)))
            }
            DatabaseType::PrestoSql => {
                let jdbc_config = prestosql_jdbc_config_for_endpoint(&db_config, &host, port);
                self.external_driver_pool("jdbc", &jdbc_config).await?
            }
            DatabaseType::Jdbc => {
                let mut jdbc_config = db_config.clone();
                if host != config.host || port != config.port {
                    if let Some(ref url) = jdbc_config.connection_string {
                        jdbc_config.connection_string = Some(rewrite_jdbc_url_host(url, &host, port));
                    }
                }
                self.external_driver_pool("jdbc", &jdbc_config).await?
            }
            #[cfg(feature = "mq-admin")]
            DatabaseType::MessageQueue => {
                // MQ admin connections don't hold a data query pool. We just test
                // connectivity via the mq_registry and insert a marker so this
                // connection_id is recognized as valid.
                let mqc = self.mq_admin_config_for_connection(connection_id, &config).await?;
                let kafka_launch = crate::mq::service::resolve_kafka_launch_spec(&mqc, self);
                let adapter = match self.mq_registry.get_or_build_config(connection_id, mqc, kafka_launch).await {
                    Ok(adapter) => adapter,
                    Err(err) => {
                        self.mq_registry.drop_connection(connection_id).await;
                        return Err(err);
                    }
                };
                if let Err(err) = adapter.test_connection().await {
                    self.mq_registry.drop_connection(connection_id).await;
                    return Err(err);
                }
                if let Err(err) = self.ensure_current_connection_attempt(connection_id, connection_attempt).await {
                    self.mq_registry.drop_connection(connection_id).await;
                    self.reset_connection_transport_for_config(connection_id, &db_config).await;
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
        };

        if let Err(err) = self.ensure_current_connection_attempt(connection_id, connection_attempt).await {
            self.discard_stale_connection_attempt_pool(connection_id, pool_key.clone(), pool, &db_config).await;
            return Err(err);
        }
        self.insert_connection_pool(pool_key.clone(), pool, &db_config).await;
        Ok(pool_key)
    }

    pub async fn connection_host_port(
        &self,
        connection_id: &str,
        config: &ConnectionConfig,
    ) -> Result<(String, u16), String> {
        let transport_layers = config.effective_transport_layers();
        if transport_layers.is_empty() {
            return Ok((config.host.clone(), config.port));
        }

        let (remote_host, remote_port) = connection_remote_endpoint(config);
        let local_port = db::transport_layer_tunnel::start_transport_layers(
            connection_id,
            &transport_layers,
            &remote_host,
            remote_port,
            &self.tunnels,
            &self.proxy_tunnels,
            &self.http_tunnels,
        )
        .await?;

        Ok(("127.0.0.1".to_string(), local_port))
    }

    pub async fn connect_redis_sentinel(
        &self,
        connection_id: &str,
        config: &ConnectionConfig,
    ) -> Result<redis::aio::MultiplexedConnection, String> {
        let transport_layers = config.effective_transport_layers();
        if transport_layers.is_empty() {
            return db::redis_driver::connect_sentinel(config).await;
        }

        let result = async {
            let sentinel_nodes = db::redis_driver::redis_sentinel_node_endpoints(config)?;
            let connect_timeout = std::time::Duration::from_secs(config.effective_connect_timeout_secs());
            let layer_count = transport_layers.len();
            let mut last_error = None;

            for sentinel in sentinel_nodes {
                let sentinel_tunnel_id = redis_sentinel_transport_id(connection_id, "sentinel", &sentinel);
                let sentinel_local_port = match db::transport_layer_tunnel::start_transport_layers(
                    &sentinel_tunnel_id,
                    &transport_layers,
                    &sentinel.host,
                    sentinel.port,
                    &self.tunnels,
                    &self.proxy_tunnels,
                    &self.http_tunnels,
                )
                .await
                {
                    Ok(port) => port,
                    Err(err) => {
                        last_error =
                            Some(format!("Redis Sentinel {}:{} transport failed: {err}", sentinel.host, sentinel.port));
                        continue;
                    }
                };

                let master =
                    match db::redis_driver::discover_sentinel_master(config, "127.0.0.1", sentinel_local_port).await {
                        Ok(master) => master,
                        Err(err) => {
                            last_error = Some(format!(
                                "Redis Sentinel {}:{} master lookup failed: {err}",
                                sentinel.host, sentinel.port
                            ));
                            db::transport_layer_tunnel::stop_transport_layers(
                                &sentinel_tunnel_id,
                                layer_count,
                                &self.tunnels,
                                &self.proxy_tunnels,
                                &self.http_tunnels,
                            )
                            .await;
                            continue;
                        }
                    };

                let master_tunnel_id = redis_sentinel_transport_id(connection_id, "master", &master);
                let master_local_port = match db::transport_layer_tunnel::start_transport_layers(
                    &master_tunnel_id,
                    &transport_layers,
                    &master.host,
                    master.port,
                    &self.tunnels,
                    &self.proxy_tunnels,
                    &self.http_tunnels,
                )
                .await
                {
                    Ok(port) => port,
                    Err(err) => {
                        last_error = Some(format!(
                            "Redis Sentinel master {}:{} transport failed: {err}",
                            master.host, master.port
                        ));
                        db::transport_layer_tunnel::stop_transport_layers(
                            &sentinel_tunnel_id,
                            layer_count,
                            &self.tunnels,
                            &self.proxy_tunnels,
                            &self.http_tunnels,
                        )
                        .await;
                        continue;
                    }
                };

                match db::redis_driver::connect_standalone(config, "127.0.0.1", master_local_port, connect_timeout)
                    .await
                {
                    Ok(con) => return Ok(con),
                    Err(err) => {
                        last_error = Some(format!(
                            "Redis Sentinel master {}:{} connection failed: {err}",
                            master.host, master.port
                        ));
                        db::transport_layer_tunnel::stop_transport_layers(
                            &master_tunnel_id,
                            layer_count,
                            &self.tunnels,
                            &self.proxy_tunnels,
                            &self.http_tunnels,
                        )
                        .await;
                        db::transport_layer_tunnel::stop_transport_layers(
                            &sentinel_tunnel_id,
                            layer_count,
                            &self.tunnels,
                            &self.proxy_tunnels,
                            &self.http_tunnels,
                        )
                        .await;
                    }
                }
            }

            Err(last_error.unwrap_or_else(|| "Redis Sentinel master discovery failed".to_string()))
        }
        .await;

        if result.is_err() {
            let redis_sentinel_prefix = redis_sentinel_transport_prefix(connection_id);
            self.tunnels.stop_tunnels_with_prefix(&redis_sentinel_prefix).await;
            self.proxy_tunnels.stop_tunnels_with_prefix(&redis_sentinel_prefix).await;
            self.http_tunnels.stop_tunnels_with_prefix(&redis_sentinel_prefix).await;
        }

        result
    }

    pub async fn connect_redis_cluster(
        &self,
        connection_id: &str,
        config: &ConnectionConfig,
    ) -> Result<db::redis_driver::RedisClusterPool, String> {
        let transport_layers = config.effective_transport_layers();
        if transport_layers.is_empty() {
            return db::redis_driver::connect_cluster(config).await;
        }

        let result = async {
            let seed_nodes = db::redis_driver::redis_cluster_seed_nodes(config)?;
            let seed_routes = self.redis_cluster_node_routes(connection_id, &transport_layers, &seed_nodes).await?;
            let (auth, slot_ranges) =
                db::redis_driver::discover_cluster_slot_ranges_from_routes(config, &seed_routes).await?;
            let master_nodes = db::redis_driver::unique_master_nodes(&slot_ranges);
            let node_routes = self.redis_cluster_node_routes(connection_id, &transport_layers, &master_nodes).await?;

            db::redis_driver::connect_routed_cluster(config, seed_routes, slot_ranges, node_routes, auth).await
        }
        .await;

        if result.is_err() {
            let redis_cluster_prefix = redis_cluster_transport_prefix(connection_id);
            self.tunnels.stop_tunnels_with_prefix(&redis_cluster_prefix).await;
            self.proxy_tunnels.stop_tunnels_with_prefix(&redis_cluster_prefix).await;
            self.http_tunnels.stop_tunnels_with_prefix(&redis_cluster_prefix).await;
        }

        result
    }

    async fn redis_cluster_node_routes(
        &self,
        connection_id: &str,
        transport_layers: &[crate::models::connection::TransportLayerConfig],
        nodes: &[db::redis_driver::RedisNodeEndpoint],
    ) -> Result<Vec<db::redis_driver::RedisNodeRoute>, String> {
        let mut routes = Vec::with_capacity(nodes.len());
        for node in nodes {
            let tunnel_id = redis_cluster_transport_id(connection_id, node);
            let local_port = db::transport_layer_tunnel::start_transport_layers(
                &tunnel_id,
                transport_layers,
                &node.host,
                node.port,
                &self.tunnels,
                &self.proxy_tunnels,
                &self.http_tunnels,
            )
            .await?;
            routes.push(db::redis_driver::RedisNodeRoute {
                advertised: node.clone(),
                connect: db::redis_driver::RedisNodeEndpoint { host: "127.0.0.1".to_string(), port: local_port },
            });
        }
        Ok(routes)
    }

    #[cfg(feature = "mq-admin")]
    pub async fn mq_admin_config_for_connection(
        &self,
        connection_id: &str,
        config: &ConnectionConfig,
    ) -> Result<crate::mq::config::MqAdminConfig, String> {
        let mqc = crate::mq::config::MqAdminConfig::from_connection(config)?;
        if !config.has_effective_transport_layers() {
            return Ok(mqc);
        }

        let (host, port) = self.connection_host_port(connection_id, config).await?;
        Ok(mqc.with_connect_override(&host, port))
    }

    pub async fn nacos_admin_config_for_connection(
        &self,
        connection_id: &str,
        config: &ConnectionConfig,
    ) -> Result<crate::nacos::config::NacosAdminConfig, String> {
        let nacos_config = crate::nacos::config::NacosAdminConfig::from_connection(config)?;
        if !config.has_effective_transport_layers() {
            return Ok(nacos_config);
        }

        let (host, port) = self.connection_host_port(connection_id, config).await?;
        nacos_config.with_server_endpoint(&host, port)
    }

    async fn remove_stale_connection_pool(&self, pool_key: &str) -> bool {
        if self.running_queries.is_pool_active(pool_key) {
            return false;
        }

        let stale = {
            let connections = self.connections.read().await;
            let Some(pool) = connections.get(pool_key) else {
                return false;
            };
            match pool {
                PoolKind::Mysql(pool, _) => {
                    let pool = pool.clone();
                    drop(connections);
                    match db::mysql::get_conn_with_health_check(&pool).await {
                        Ok(_) => false,
                        Err(err) => {
                            log::warn!("MySQL connection pool '{pool_key}' is stale: {err}");
                            true
                        }
                    }
                }
                PoolKind::Postgres(pool) => {
                    let pool = pool.clone();
                    drop(connections);
                    let timeout = crate::db::connection_timeout();
                    match tokio::time::timeout(timeout, pool.get()).await {
                        Ok(Ok(client)) => match tokio::time::timeout(timeout, client.simple_query("SELECT 1")).await {
                            Ok(Ok(_)) => false,
                            Ok(Err(err)) => {
                                log::warn!("PostgreSQL connection pool '{pool_key}' is stale: {err}");
                                true
                            }
                            Err(_) => {
                                log::warn!("PostgreSQL connection pool '{pool_key}' is stale: health check timed out");
                                true
                            }
                        },
                        Ok(Err(err)) => {
                            log::warn!("PostgreSQL connection pool '{pool_key}' is stale: {err}");
                            true
                        }
                        Err(_) => {
                            log::warn!("PostgreSQL connection pool '{pool_key}' is stale: get connection timed out");
                            true
                        }
                    }
                }
                PoolKind::SqlServer(client) => {
                    let client = client.clone();
                    drop(connections);
                    let mut client = client.lock().await;
                    match db::sqlserver::test_connection(&mut client).await {
                        Ok(()) => false,
                        Err(err) => {
                            log::warn!("SQL Server connection pool '{pool_key}' is stale: {err}");
                            true
                        }
                    }
                }
                PoolKind::Redis(redis) => match db::redis_driver::test_connection(redis).await {
                    Ok(()) => false,
                    Err(err) => {
                        log::warn!("Redis connection pool '{pool_key}' is stale: {err}");
                        true
                    }
                },
                PoolKind::MongoDb(client) => {
                    let client = client.clone();
                    drop(connections);
                    let (connect_timeout, database) = {
                        let configs = self.configs.read().await;
                        let config = config_for_pool_key(pool_key, &configs);
                        (
                            config
                                .map(|config| Duration::from_secs(config.effective_connect_timeout_secs().max(1)))
                                .unwrap_or_else(|| Duration::from_secs(1)),
                            config.and_then(|config| config.effective_database().map(str::to_string)),
                        )
                    };
                    match db::mongo_driver::test_connection(&client, connect_timeout, database.as_deref()).await {
                        Ok(()) => false,
                        Err(err) => {
                            log::warn!("MongoDB connection pool '{pool_key}' is stale: {err}");
                            true
                        }
                    }
                }
                PoolKind::ClickHouse(client) => {
                    let client = client.clone();
                    drop(connections);
                    let timeout = crate::db::connection_timeout();
                    match db::clickhouse_driver::test_connection(&client, timeout).await {
                        Ok(()) => false,
                        Err(err) => {
                            log::warn!("ClickHouse connection pool '{pool_key}' is stale: {err}");
                            true
                        }
                    }
                }
                PoolKind::Elasticsearch(client) => {
                    let mut client = client.clone();
                    drop(connections);
                    let timeout = crate::db::connection_timeout();
                    match db::elasticsearch_driver::test_connection(&mut client, timeout).await {
                        Ok(()) => false,
                        Err(err) => {
                            log::warn!("Elasticsearch connection pool '{pool_key}' is stale: {err}");
                            true
                        }
                    }
                }
                PoolKind::VectorDb(client) => {
                    let client = client.clone();
                    drop(connections);
                    let timeout = crate::db::connection_timeout();
                    match db::vector_driver::test_connection(&client, timeout).await {
                        Ok(()) => false,
                        Err(err) => {
                            log::warn!("VectorDB connection pool '{pool_key}' is stale: {err}");
                            true
                        }
                    }
                }
                PoolKind::InfluxDb(client) => {
                    let client = client.clone();
                    drop(connections);
                    let timeout = crate::db::connection_timeout();
                    match db::influxdb_driver::test_connection(&client, timeout).await {
                        Ok(()) => false,
                        Err(err) => {
                            log::warn!("InfluxDB connection pool '{pool_key}' is stale: {err}");
                            true
                        }
                    }
                }
                PoolKind::Rqlite(client) => {
                    let client = client.clone();
                    drop(connections);
                    let timeout = crate::db::connection_timeout();
                    match db::rqlite_driver::test_connection(&client, timeout).await {
                        Ok(()) => false,
                        Err(err) => {
                            log::warn!("rqlite connection pool '{pool_key}' is stale: {err}");
                            true
                        }
                    }
                }
                PoolKind::Turso(client) => {
                    let client = client.clone();
                    drop(connections);
                    let timeout = crate::db::connection_timeout();
                    match db::turso_driver::test_connection(&client, timeout).await {
                        Ok(()) => false,
                        Err(err) => {
                            log::warn!("Turso connection pool '{pool_key}' is stale: {err}");
                            true
                        }
                    }
                }
                PoolKind::Agent(client) => {
                    let client = client.clone();
                    drop(connections);
                    let mut agent = client.lock().await;
                    let timeout = crate::db::connection_timeout();
                    match agent.validate_connection(Some(timeout)).await {
                        Ok(_) => false,
                        Err(err) if is_agent_validate_connection_unsupported(&err) => {
                            log::debug!(
                                "Agent connection pool '{pool_key}' does not support validate_connection; keeping pool"
                            );
                            false
                        }
                        Err(err) => {
                            log::warn!("Agent connection pool '{pool_key}' is stale: {err}");
                            true
                        }
                    }
                }
                PoolKind::Sqlite(_)
                | PoolKind::DuckDb(_)
                | PoolKind::DuckDbWorker(_)
                | PoolKind::ExternalTabular(_)
                | PoolKind::ExternalDriver { .. }
                | PoolKind::MessageQueue
                | PoolKind::Nacos => false,
            }
        };

        if !stale {
            return false;
        }

        self.stop_keepalive_task(pool_key).await;
        self.pool_activity.write().await.remove(pool_key);
        self.postgres_cancel_contexts.write().await.remove(pool_key);
        let removed = self.connections.write().await.remove(pool_key);
        if let Some(pool) = removed {
            close_pool_kind_with_timeout(pool_key.to_string(), pool).await;
            true
        } else {
            false
        }
    }

    pub async fn reconnect_pool(&self, connection_id: &str, database: Option<&str>) -> Result<String, String> {
        self.reconnect_pool_for_session(connection_id, database, None).await
    }

    pub async fn reconnect_pool_for_session(
        &self,
        connection_id: &str,
        database: Option<&str>,
        client_session_id: Option<&str>,
    ) -> Result<String, String> {
        let db_type = {
            let configs = self.configs.read().await;
            configs.get(connection_id).map(|c| c.db_type)
        };
        let base_pool_key = base_pool_key_for(db_type, connection_id, database, true);
        let pool_key = session_scoped_pool_key_for(db_type, base_pool_key, client_session_id);
        if self.uses_forwarded_transport(connection_id).await {
            self.remove_connection_pools(connection_id).await;
            self.reset_connection_transport(connection_id).await;
        } else {
            self.stop_keepalive_task(&pool_key).await;
            self.pool_activity.write().await.remove(&pool_key);
            self.postgres_cancel_contexts.write().await.remove(&pool_key);
            let removed = self.connections.write().await.remove(&pool_key);
            if let Some(pool) = removed {
                close_pool_kind_with_timeout(pool_key.clone(), pool).await;
            }
        }
        self.get_or_create_pool_for_session(connection_id, database, client_session_id).await
    }

    pub async fn close_client_session_pool(
        &self,
        connection_id: &str,
        database: Option<&str>,
        client_session_id: &str,
    ) -> Result<bool, String> {
        let session = normalize_client_session_id(Some(client_session_id));
        let Some(session) = session else {
            return Ok(false);
        };
        let db_type = {
            let configs = self.configs.read().await;
            configs.get(connection_id).map(|c| c.db_type)
        };
        let base_pool_key = base_pool_key_for(db_type, connection_id, database, false);
        let pool_key = session_scoped_pool_key_for(db_type, base_pool_key.clone(), Some(&session));
        if pool_key == base_pool_key {
            return Ok(false);
        }
        self.stop_keepalive_task(&pool_key).await;
        self.pool_activity.write().await.remove(&pool_key);
        self.postgres_cancel_contexts.write().await.remove(&pool_key);
        let removed = self.connections.write().await.remove(&pool_key);
        if let Some(pool) = removed {
            close_pool_kind_with_timeout(pool_key, pool).await;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub async fn remove_pool_by_key(&self, pool_key: &str) -> bool {
        self.stop_keepalive_task(pool_key).await;
        self.pool_activity.write().await.remove(pool_key);
        self.postgres_cancel_contexts.write().await.remove(pool_key);
        let removed = self.connections.write().await.remove(pool_key);
        if let Some(pool) = removed {
            close_pool_kind_with_timeout(pool_key.to_string(), pool).await;
            true
        } else {
            false
        }
    }

    #[cfg(feature = "duckdb-bundled")]
    async fn remove_pool_by_key_detached(&self, pool_key: &str) -> bool {
        self.stop_keepalive_task(pool_key).await;
        self.pool_activity.write().await.remove(pool_key);
        self.postgres_cancel_contexts.write().await.remove(pool_key);
        let removed = self.connections.write().await.remove(pool_key);
        if let Some(pool) = removed {
            close_removed_pools_in_background(vec![(pool_key.to_string(), pool)]);
            true
        } else {
            false
        }
    }

    #[cfg(feature = "duckdb-bundled")]
    async fn remove_pool_if_duckdb_isolation_mismatch(&self, pool_key: &str) -> bool {
        let isolation_enabled = self.duckdb_worker_process_isolation.load(Ordering::Relaxed);
        let mismatch = {
            let connections = self.connections.read().await;
            match connections.get(pool_key) {
                Some(PoolKind::DuckDb(_)) => isolation_enabled,
                Some(PoolKind::DuckDbWorker(_)) => !isolation_enabled,
                _ => false,
            }
        };
        if mismatch {
            self.remove_pool_by_key_detached(pool_key).await
        } else {
            false
        }
    }

    #[cfg(not(feature = "duckdb-bundled"))]
    async fn remove_pool_if_duckdb_isolation_mismatch(&self, _pool_key: &str) -> bool {
        false
    }

    #[cfg(feature = "duckdb-bundled")]
    pub fn spawn_duckdb_pool_cleanup(&self, pool_key: String, con: DuckDbHandle) {
        let connections = self.connections.clone();
        let keepalive_tasks = self.keepalive_tasks.clone();
        let pool_activity = self.pool_activity.clone();
        let postgres_cancel_contexts = self.postgres_cancel_contexts.clone();
        tokio::spawn(async move {
            while Arc::strong_count(&con) > 2 {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            if let Some(handle) = keepalive_tasks.write().await.remove(&pool_key) {
                handle.abort();
            }
            pool_activity.write().await.remove(&pool_key);
            postgres_cancel_contexts.write().await.remove(&pool_key);
            let removed = {
                let mut conns = connections.write().await;
                match conns.get(&pool_key) {
                    Some(PoolKind::DuckDb(current)) if Arc::ptr_eq(current, &con) => conns.remove(&pool_key),
                    _ => None,
                }
            };
            if let Some(pool) = removed {
                // Keep the old DuckDB pool marked as draining until it is no longer
                // visible in the pool map, otherwise a concurrent query could reuse it.
                con.clear_draining();
                drop(con);
                close_pool_kind_with_timeout(pool_key, pool).await;
            }
        });
    }

    #[cfg(feature = "duckdb-bundled")]
    pub fn spawn_duckdb_draining_cleanup(
        &self,
        pool_key: String,
        con: DuckDbHandle,
        task: JoinHandle<Result<db::QueryResult, String>>,
    ) {
        let connections = self.connections.clone();
        let keepalive_tasks = self.keepalive_tasks.clone();
        let pool_activity = self.pool_activity.clone();
        let postgres_cancel_contexts = self.postgres_cancel_contexts.clone();
        tokio::spawn(async move {
            let _ = task.await;
            while Arc::strong_count(&con) > 2 {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            if let Some(handle) = keepalive_tasks.write().await.remove(&pool_key) {
                handle.abort();
            }
            pool_activity.write().await.remove(&pool_key);
            postgres_cancel_contexts.write().await.remove(&pool_key);
            let removed = {
                let mut conns = connections.write().await;
                match conns.get(&pool_key) {
                    Some(PoolKind::DuckDb(current)) if Arc::ptr_eq(current, &con) => conns.remove(&pool_key),
                    _ => None,
                }
            };
            if let Some(pool) = removed {
                // Keep the old DuckDB pool marked as draining until it is no longer
                // visible in the pool map, otherwise a concurrent query could reuse it.
                con.clear_draining();
                drop(con);
                close_pool_kind_with_timeout(pool_key, pool).await;
            }
        });
    }

    pub async fn close_database_pool(&self, connection_id: &str, database: Option<&str>) -> Result<bool, String> {
        let db_type = {
            let configs = self.configs.read().await;
            configs.get(connection_id).map(|c| c.db_type)
        };
        if database.is_some() && db_type.is_some_and(|db_type| shares_database_pool_with_connection(&db_type)) {
            return Ok(false);
        }
        let base_pool_key = base_pool_key_for(db_type, connection_id, database, false);
        let session_prefix = format!("{base_pool_key}:session:");
        let keys_to_remove: Vec<String> = self
            .connections
            .read()
            .await
            .keys()
            .filter(|key| *key == &base_pool_key || key.starts_with(&session_prefix))
            .cloned()
            .collect();
        self.stop_keepalive_tasks(&keys_to_remove).await;
        {
            let mut activity = self.pool_activity.write().await;
            let mut cancel_contexts = self.postgres_cancel_contexts.write().await;
            for key in &keys_to_remove {
                activity.remove(key);
                cancel_contexts.remove(key);
            }
        }
        let mut conns = self.connections.write().await;
        let mut removed = Vec::with_capacity(keys_to_remove.len());
        for key in keys_to_remove {
            if let Some(pool) = conns.remove(&key) {
                removed.push((key, pool));
            }
        }
        drop(conns);
        let closed = !removed.is_empty();
        for (key, pool) in removed {
            close_pool_kind_with_timeout(key, pool).await;
        }
        Ok(closed)
    }

    pub async fn active_agent_driver_keys(&self) -> HashSet<String> {
        let configs = self.configs.read().await;
        let connections = self.connections.read().await;
        let mut keys = HashSet::new();

        for (pool_key, pool) in connections.iter() {
            if !matches!(pool, PoolKind::Agent(_)) {
                continue;
            }
            let Some(config) = config_for_pool_key(pool_key, &configs) else {
                continue;
            };
            if let Some(agent_key) = crate::agent_manager::AgentManager::db_type_to_agent_key(
                &config.db_type,
                config.driver_profile.as_deref(),
            ) {
                keys.insert(agent_key.to_string());
            }
        }

        drop(connections);
        drop(configs);

        for key in self.agent_manager.active_daemon_keys().await {
            keys.insert(key);
        }

        keys
    }

    #[cfg(feature = "duckdb-bundled")]
    pub async fn duckdb_existing_pool_is_usable_for_config(&self, config: &ConnectionConfig) -> Result<bool, String> {
        if config.db_type != DatabaseType::DuckDb {
            return Ok(false);
        }

        let matches_existing_config = {
            let configs = self.configs.read().await;
            configs.get(&config.id).is_some_and(|existing| {
                existing.db_type == DatabaseType::DuckDb && duckdb_paths_match(&existing.host, &config.host)
            })
        };
        if !matches_existing_config {
            return Ok(false);
        }

        let duckdb_pool = {
            let conns = self.connections.read().await;
            match conns.get(&config.id) {
                Some(PoolKind::DuckDb(con)) => Some(con.clone()),
                _ => None,
            }
        };

        let Some(con) = duckdb_pool else {
            return Ok(false);
        };

        let locked = con.lock().map_err(|e| e.to_string())?;
        locked.execute_batch("SELECT 1;").map_err(|e| format!("DuckDb connection failed: {e}"))?;
        Ok(true)
    }

    pub async fn reset_connection_transport(&self, connection_id: &str) {
        let layer_count = {
            let configs = self.configs.read().await;
            configs.get(connection_id).map(|config| config.effective_transport_layers().len()).unwrap_or(0)
        };
        self.reset_connection_transport_layers(connection_id, layer_count).await;
    }

    pub async fn reset_connection_transport_for_config(&self, connection_id: &str, config: &ConnectionConfig) {
        let existing_layer_count = {
            let configs = self.configs.read().await;
            configs.get(connection_id).map(|config| config.effective_transport_layers().len()).unwrap_or(0)
        };
        let layer_count = existing_layer_count.max(config.effective_transport_layers().len());
        self.reset_connection_transport_layers(connection_id, layer_count).await;
    }

    async fn reset_connection_transport_layers(&self, connection_id: &str, layer_count: usize) {
        let redis_cluster_prefix = redis_cluster_transport_prefix(connection_id);
        self.tunnels.stop_tunnels_with_prefix(&redis_cluster_prefix).await;
        self.proxy_tunnels.stop_tunnels_with_prefix(&redis_cluster_prefix).await;
        self.http_tunnels.stop_tunnels_with_prefix(&redis_cluster_prefix).await;
        let redis_sentinel_prefix = redis_sentinel_transport_prefix(connection_id);
        self.tunnels.stop_tunnels_with_prefix(&redis_sentinel_prefix).await;
        self.proxy_tunnels.stop_tunnels_with_prefix(&redis_sentinel_prefix).await;
        self.http_tunnels.stop_tunnels_with_prefix(&redis_sentinel_prefix).await;
        db::transport_layer_tunnel::stop_transport_layers(
            connection_id,
            layer_count,
            &self.tunnels,
            &self.proxy_tunnels,
            &self.http_tunnels,
        )
        .await;
        self.tunnels.stop_tunnel(connection_id).await;
        self.proxy_tunnels.stop_tunnel(connection_id).await;
        self.http_tunnels.stop_tunnel(connection_id).await;
    }

    /// Health-check the base connection pool for a given connection_id.
    /// Returns `Ok(())` if the pool exists and is healthy, `Err` otherwise.
    /// If the pool is unhealthy it is removed from the map so subsequent
    /// `get_or_create_pool` calls will transparently recreate it.
    pub async fn check_connection_health(&self, connection_id: &str) -> Result<(), String> {
        let db_type = {
            let configs = self.configs.read().await;
            configs.get(connection_id).map(|c| c.db_type)
        };
        let pool_key = base_pool_key_for(db_type, connection_id, None, false);

        // Check if pool exists first
        {
            let connections = self.connections.read().await;
            if !connections.contains_key(&pool_key) {
                return Err("No active connection pool found".to_string());
            }
        }

        // `remove_stale_connection_pool` returns true if the pool was stale (and removed)
        if self.remove_stale_connection_pool(&pool_key).await {
            return Err("Connection pool is unhealthy".to_string());
        }
        Ok(())
    }

    pub async fn refresh_connections(&self) {
        // Clone pool handles under a short-lived read lock, then release it
        // before performing I/O-heavy health checks to avoid blocking writers.
        // Redis pools are handled separately because RedisConnection cannot be cloned.
        let (checks, redis_keys): (Vec<(String, PoolKind)>, Vec<String>) = {
            let conns = self.connections.read().await;
            let mut checks = Vec::with_capacity(conns.len());
            let mut redis_keys = Vec::new();
            for (key, pool) in conns.iter() {
                match pool {
                    PoolKind::Redis(_) => redis_keys.push(key.clone()),
                    _ => checks.push((key.clone(), clone_pool_kind(pool))),
                }
            }
            (checks, redis_keys)
        };

        let mut dead_keys = Vec::new();
        let timeout = crate::db::connection_timeout();

        // Check cloned pools (async I/O, no lock held)
        for (key, pool) in &checks {
            let healthy = match pool {
                PoolKind::Mysql(p, _) => match db::mysql::get_conn_with_health_check(p).await {
                    Ok(_) => true,
                    Err(e) => {
                        log::warn!("MySQL connection pool '{key}' is unhealthy: {e}");
                        false
                    }
                },
                PoolKind::Postgres(p) => match tokio::time::timeout(timeout, p.get()).await {
                    Ok(Ok(client)) => match tokio::time::timeout(timeout, client.simple_query("SELECT 1")).await {
                        Ok(Ok(_)) => true,
                        Ok(Err(e)) => {
                            log::warn!("PostgreSQL connection pool '{key}' is unhealthy: {e}");
                            false
                        }
                        Err(_) => {
                            log::warn!("PostgreSQL connection pool '{key}' is unhealthy: health check timed out");
                            false
                        }
                    },
                    Ok(Err(e)) => {
                        log::warn!("PostgreSQL connection pool '{key}' is unhealthy: {e}");
                        false
                    }
                    Err(_) => {
                        log::warn!("PostgreSQL connection pool '{key}' is unhealthy: get connection timed out");
                        false
                    }
                },
                PoolKind::SqlServer(client) => {
                    let mut client = client.lock().await;
                    match db::sqlserver::test_connection(&mut client).await {
                        Ok(()) => true,
                        Err(e) => {
                            log::warn!("SQL Server connection pool '{key}' is unhealthy: {e}");
                            false
                        }
                    }
                }
                PoolKind::MongoDb(client) => match db::mongo_driver::test_connection(client, timeout, None).await {
                    Ok(()) => true,
                    Err(e) => {
                        log::warn!("MongoDB connection pool '{key}' is unhealthy: {e}");
                        false
                    }
                },
                PoolKind::ClickHouse(client) => match db::clickhouse_driver::test_connection(client, timeout).await {
                    Ok(()) => true,
                    Err(e) => {
                        log::warn!("ClickHouse connection pool '{key}' is unhealthy: {e}");
                        false
                    }
                },
                PoolKind::Elasticsearch(client) => {
                    let mut client = client.clone();
                    match db::elasticsearch_driver::test_connection(&mut client, timeout).await {
                        Ok(()) => true,
                        Err(e) => {
                            log::warn!("Elasticsearch connection pool '{key}' is unhealthy: {e}");
                            false
                        }
                    }
                }
                PoolKind::VectorDb(client) => match db::vector_driver::test_connection(client, timeout).await {
                    Ok(()) => true,
                    Err(e) => {
                        log::warn!("VectorDB connection pool '{key}' is unhealthy: {e}");
                        false
                    }
                },
                PoolKind::InfluxDb(client) => match db::influxdb_driver::test_connection(client, timeout).await {
                    Ok(()) => true,
                    Err(e) => {
                        log::warn!("InfluxDB connection pool '{key}' is unhealthy: {e}");
                        false
                    }
                },
                PoolKind::Rqlite(client) => match db::rqlite_driver::test_connection(client, timeout).await {
                    Ok(()) => true,
                    Err(e) => {
                        log::warn!("rqlite connection pool '{key}' is unhealthy: {e}");
                        false
                    }
                },
                PoolKind::Turso(client) => match db::turso_driver::test_connection(client, timeout).await {
                    Ok(()) => true,
                    Err(e) => {
                        log::warn!("Turso connection pool '{key}' is unhealthy: {e}");
                        false
                    }
                },
                PoolKind::Agent(client) => {
                    let mut agent = client.lock().await;
                    match agent.test_connection(serde_json::json!({})).await {
                        Ok(_) => true,
                        Err(e) => {
                            log::warn!("Agent connection pool '{key}' is unhealthy: {e}");
                            false
                        }
                    }
                }
                PoolKind::Sqlite(_)
                | PoolKind::DuckDb(_)
                | PoolKind::DuckDbWorker(_)
                | PoolKind::ExternalTabular(_)
                | PoolKind::ExternalDriver { .. }
                | PoolKind::MessageQueue
                | PoolKind::Nacos => true,
                PoolKind::Redis(_) => unreachable!("Redis handled separately"),
            };
            if !healthy {
                dead_keys.push(key.clone());
            }
        }

        // Check Redis pools (read lock held briefly, no cloning needed)
        {
            let conns = self.connections.read().await;
            for key in &redis_keys {
                if let Some(PoolKind::Redis(redis)) = conns.get(key) {
                    match db::redis_driver::test_connection(redis).await {
                        Ok(()) => {}
                        Err(e) => {
                            log::warn!("Redis connection pool '{key}' is unhealthy: {e}");
                            dead_keys.push(key.clone());
                        }
                    }
                }
            }
        }

        // Remove dead pools
        if !dead_keys.is_empty() {
            self.stop_keepalive_tasks(&dead_keys).await;
            {
                let mut activity = self.pool_activity.write().await;
                for key in &dead_keys {
                    activity.remove(key);
                }
            }
            let mut conns = self.connections.write().await;
            let mut removed = Vec::with_capacity(dead_keys.len());
            for key in &dead_keys {
                if let Some(pool) = conns.remove(key) {
                    removed.push((key.clone(), pool));
                }
            }
            drop(conns);
            close_removed_pools(removed).await;
        }

        // Re-establish SSH tunnels that have died
        let tunnel_connection_ids: Vec<String> = {
            let configs = self.configs.read().await;
            configs.iter().filter(|(_, c)| c.has_effective_transport_layers()).map(|(id, _)| id.clone()).collect()
        };
        for connection_id in tunnel_connection_ids {
            self.reset_connection_transport(&connection_id).await;
            // Tunnels will be re-created on next pool access via connection_host_port
        }
    }

    pub async fn remove_connection_pools(&self, connection_id: &str) {
        let removed = self.drain_connection_pools(connection_id).await;
        close_removed_pools(removed).await;
    }

    pub async fn remove_connection_pools_detached(&self, connection_id: &str) {
        let removed = self.drain_connection_pools(connection_id).await;
        close_removed_pools_in_background(removed);
    }

    #[cfg(feature = "duckdb-bundled")]
    async fn remove_duckdb_pools_detached(&self) {
        let removed = self.drain_duckdb_pools().await;
        close_removed_pools_in_background(removed);
    }

    #[cfg(not(feature = "duckdb-bundled"))]
    async fn remove_duckdb_pools_detached(&self) {}

    pub async fn remove_external_driver_pools(&self, driver_id: &str) {
        let removed = self.drain_external_driver_pools(driver_id).await;
        close_removed_pools(removed).await;
    }

    async fn drain_connection_pools(&self, connection_id: &str) -> Vec<(String, PoolKind)> {
        let pool_prefix = format!("{connection_id}:");
        let keys_to_remove: Vec<String> = self
            .connections
            .read()
            .await
            .keys()
            .filter(|k| *k == connection_id || k.starts_with(&pool_prefix))
            .cloned()
            .collect();
        self.stop_keepalive_tasks(&keys_to_remove).await;
        {
            let mut activity = self.pool_activity.write().await;
            let mut cancel_contexts = self.postgres_cancel_contexts.write().await;
            for key in &keys_to_remove {
                activity.remove(key);
                cancel_contexts.remove(key);
            }
        }
        let mut conns = self.connections.write().await;
        let mut removed = Vec::with_capacity(keys_to_remove.len());
        for key in keys_to_remove {
            if let Some(pool) = conns.remove(&key) {
                removed.push((key, pool));
            }
        }
        drop(conns);
        // Also drop the MQ admin adapter if this is an MQ connection.
        #[cfg(feature = "mq-admin")]
        self.mq_registry.drop_connection(connection_id).await;
        removed
    }

    #[cfg(feature = "duckdb-bundled")]
    async fn drain_duckdb_pools(&self) -> Vec<(String, PoolKind)> {
        let keys_to_remove: Vec<String> = self
            .connections
            .read()
            .await
            .iter()
            .filter_map(|(key, pool)| match pool {
                PoolKind::DuckDb(_) | PoolKind::DuckDbWorker(_) => Some(key.clone()),
                _ => None,
            })
            .collect();
        self.stop_keepalive_tasks(&keys_to_remove).await;
        {
            let mut activity = self.pool_activity.write().await;
            let mut cancel_contexts = self.postgres_cancel_contexts.write().await;
            for key in &keys_to_remove {
                activity.remove(key);
                cancel_contexts.remove(key);
            }
        }
        let mut conns = self.connections.write().await;
        let mut removed = Vec::with_capacity(keys_to_remove.len());
        for key in keys_to_remove {
            if let Some(pool) = conns.remove(&key) {
                removed.push((key, pool));
            }
        }
        removed
    }

    async fn drain_external_driver_pools(&self, driver_id: &str) -> Vec<(String, PoolKind)> {
        let keys_to_remove: Vec<String> = self
            .connections
            .read()
            .await
            .iter()
            .filter_map(|(key, pool)| match pool {
                PoolKind::ExternalDriver { driver_id: pool_driver_id, .. } if pool_driver_id == driver_id => {
                    Some(key.clone())
                }
                _ => None,
            })
            .collect();
        self.stop_keepalive_tasks(&keys_to_remove).await;
        {
            let mut activity = self.pool_activity.write().await;
            for key in &keys_to_remove {
                activity.remove(key);
            }
        }
        let mut conns = self.connections.write().await;
        let mut removed = Vec::with_capacity(keys_to_remove.len());
        for key in keys_to_remove {
            if let Some(pool) = conns.remove(&key) {
                removed.push((key, pool));
            }
        }
        removed
    }

    async fn uses_forwarded_transport(&self, connection_id: &str) -> bool {
        let configs = self.configs.read().await;
        configs.get(connection_id).is_some_and(|config| config.has_effective_transport_layers())
    }
}

enum KeepaliveTarget {
    Mysql(db::mysql::MySqlPool),
    Postgres(deadpool_postgres::Pool),
    Rqlite(db::rqlite_driver::RqliteClient),
    Turso(db::turso_driver::TursoClient),
    MongoDb { client: mongodb::Client, database: Option<String> },
    ClickHouse(db::clickhouse_driver::ChClient),
    SqlServer(Arc<tokio::sync::Mutex<db::sqlserver::SqlServerClient>>),
    Elasticsearch(db::elasticsearch_driver::EsClient),
    VectorDb(db::vector_driver::VectorClient),
    InfluxDb(db::influxdb_driver::InfluxdbClient),
    Agent(Arc<tokio::sync::Mutex<db::agent_driver::AgentDriverClient>>),
}

fn keepalive_target_from_pool(pool: &PoolKind, config: &ConnectionConfig) -> Option<KeepaliveTarget> {
    match pool {
        PoolKind::Mysql(pool, _) => Some(KeepaliveTarget::Mysql(pool.clone())),
        PoolKind::Postgres(pool) => Some(KeepaliveTarget::Postgres(pool.clone())),
        PoolKind::Rqlite(client) => Some(KeepaliveTarget::Rqlite(client.clone())),
        PoolKind::Turso(client) => Some(KeepaliveTarget::Turso(client.clone())),
        PoolKind::MongoDb(client) => Some(KeepaliveTarget::MongoDb {
            client: client.clone(),
            database: config.effective_database().map(str::to_string),
        }),
        PoolKind::ClickHouse(client) => Some(KeepaliveTarget::ClickHouse(client.clone())),
        PoolKind::SqlServer(client) => Some(KeepaliveTarget::SqlServer(client.clone())),
        PoolKind::Elasticsearch(client) => Some(KeepaliveTarget::Elasticsearch(client.clone())),
        PoolKind::VectorDb(client) => Some(KeepaliveTarget::VectorDb(client.clone())),
        PoolKind::InfluxDb(client) => Some(KeepaliveTarget::InfluxDb(client.clone())),
        PoolKind::Agent(client) => Some(KeepaliveTarget::Agent(client.clone())),
        _ => None,
    }
}

async fn ping_keepalive_target(target: &mut KeepaliveTarget, timeout: Duration) -> Result<(), String> {
    match target {
        KeepaliveTarget::Mysql(pool) => {
            let mut conn = db::mysql::get_conn_with_health_check(pool).await?;
            conn.ping().await.map_err(|e| e.to_string())
        }
        KeepaliveTarget::Postgres(pool) => {
            let client = pool.get().await.map_err(|e| format!("PostgreSQL pool error: {e}"))?;
            client.simple_query("SELECT 1").await.map(|_| ()).map_err(|e| e.to_string())
        }
        KeepaliveTarget::Rqlite(client) => db::rqlite_driver::test_connection(client, timeout).await,
        KeepaliveTarget::Turso(client) => db::turso_driver::test_connection(client, timeout).await,
        KeepaliveTarget::MongoDb { client, database } => {
            db::mongo_driver::test_connection(client, timeout, database.as_deref()).await
        }
        KeepaliveTarget::ClickHouse(client) => db::clickhouse_driver::test_connection(client, timeout).await,
        KeepaliveTarget::SqlServer(client) => {
            let Ok(mut client) = client.try_lock() else {
                return Ok(());
            };
            db::sqlserver::test_connection(&mut client).await
        }
        KeepaliveTarget::Elasticsearch(client) => db::elasticsearch_driver::test_connection(client, timeout).await,
        KeepaliveTarget::VectorDb(client) => db::vector_driver::test_connection(client, timeout).await,
        KeepaliveTarget::InfluxDb(client) => db::influxdb_driver::test_connection(client, timeout).await,
        KeepaliveTarget::Agent(client) => {
            let Ok(mut client) = client.try_lock() else {
                return Ok(());
            };
            match client.validate_connection(Some(timeout)).await {
                Ok(_) => Ok(()),
                Err(err) if is_agent_validate_connection_unsupported(&err) => Ok(()),
                Err(err) => {
                    client.kill();
                    Err(err)
                }
            }
        }
    }
}

fn is_agent_validate_connection_unsupported(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    lower.contains("validate_connection") && (lower.contains("unknown method") || lower.contains("method not found"))
}

fn connection_remote_endpoint(config: &ConnectionConfig) -> (String, u16) {
    if config.db_type == DatabaseType::MongoDb {
        config
            .connection_string
            .as_deref()
            .filter(|s| !s.is_empty())
            .and_then(parse_mongo_first_host)
            .unwrap_or_else(|| (config.host.clone(), config.port))
    } else if config.db_type == DatabaseType::Jdbc {
        config
            .connection_string
            .as_deref()
            .filter(|s| !s.is_empty())
            .and_then(parse_jdbc_host_port)
            .unwrap_or_else(|| (config.host.clone(), config.port))
    } else if config.db_type == DatabaseType::MessageQueue {
        parse_mq_admin_host_port(config).unwrap_or_else(|| (config.host.clone(), config.port))
    } else if config.db_type == DatabaseType::Nacos {
        parse_nacos_server_host_port(config).unwrap_or_else(|| (config.host.clone(), config.port))
    } else {
        (config.host.clone(), config.port)
    }
}

fn parse_mq_admin_host_port(config: &ConnectionConfig) -> Option<(String, u16)> {
    let value = config
        .external_config
        .as_ref()?
        .get("adminUrl")
        .or_else(|| config.external_config.as_ref()?.get("admin_url"))?
        .as_str()?
        .trim();
    if value.is_empty() {
        return None;
    }
    let url = reqwest::Url::parse(value).ok()?;
    let host = url.host_str()?.to_string();
    let port = url.port_or_known_default()?;
    Some((host, port))
}

fn parse_nacos_server_host_port(config: &ConnectionConfig) -> Option<(String, u16)> {
    let value = config
        .external_config
        .as_ref()?
        .get("serverAddr")
        .or_else(|| config.external_config.as_ref()?.get("server_addr"))?
        .as_str()?
        .trim();
    if value.is_empty() {
        return None;
    }
    let url = reqwest::Url::parse(value).ok()?;
    let host = url.host_str()?.to_string();
    let port = url.port_or_known_default()?;
    Some((host, port))
}

fn normalize_client_session_id(client_session_id: Option<&str>) -> Option<String> {
    client_session_id.map(str::trim).filter(|session| !session.is_empty()).map(|session| session.replace(':', "_"))
}

fn mysql_pool_max_connections_for_session(client_session_id: Option<&str>) -> usize {
    if normalize_client_session_id(client_session_id).is_some() {
        1
    } else {
        10
    }
}

fn redis_cluster_transport_prefix(connection_id: &str) -> String {
    format!("{connection_id}:redis-cluster:")
}

fn redis_cluster_transport_id(connection_id: &str, endpoint: &db::redis_driver::RedisNodeEndpoint) -> String {
    format!(
        "{}{host}:{port}",
        redis_cluster_transport_prefix(connection_id),
        host = endpoint.host,
        port = endpoint.port
    )
}

fn redis_sentinel_transport_prefix(connection_id: &str) -> String {
    format!("{connection_id}:redis-sentinel:")
}

fn redis_sentinel_transport_id(
    connection_id: &str,
    role: &str,
    endpoint: &db::redis_driver::RedisNodeEndpoint,
) -> String {
    format!(
        "{}{role}:{host}:{port}",
        redis_sentinel_transport_prefix(connection_id),
        host = endpoint.host,
        port = endpoint.port
    )
}

fn session_scoped_pool_key(base_pool_key: String, client_session_id: Option<&str>) -> String {
    normalize_client_session_id(client_session_id)
        .map(|session| format!("{base_pool_key}:session:{session}"))
        .unwrap_or(base_pool_key)
}

fn is_session_scoped_pool_key(pool_key: &str) -> bool {
    pool_key.contains(":session:")
}

pub(crate) fn config_for_pool_key<'a>(
    pool_key: &str,
    configs: &'a HashMap<String, ConnectionConfig>,
) -> Option<&'a ConnectionConfig> {
    configs
        .iter()
        .filter(|(connection_id, _)| {
            pool_key.strip_prefix(connection_id.as_str()).is_some_and(|rest| rest.is_empty() || rest.starts_with(':'))
        })
        .max_by_key(|(connection_id, _)| connection_id.len())
        .map(|(_, config)| config)
}

fn session_scoped_pool_key_for(
    db_type: Option<DatabaseType>,
    base_pool_key: String,
    client_session_id: Option<&str>,
) -> String {
    if matches!(db_type, Some(DatabaseType::DuckDb)) {
        return base_pool_key;
    }
    session_scoped_pool_key(base_pool_key, client_session_id)
}

fn clone_pool_kind(pool: &PoolKind) -> PoolKind {
    match pool {
        PoolKind::Mysql(p, mode) => PoolKind::Mysql(p.clone(), *mode),
        PoolKind::Postgres(p) => PoolKind::Postgres(p.clone()),
        PoolKind::Sqlite(p) => PoolKind::Sqlite(p.clone()),
        PoolKind::Rqlite(client) => PoolKind::Rqlite(client.clone()),
        PoolKind::Turso(client) => PoolKind::Turso(client.clone()),
        #[cfg(feature = "duckdb-bundled")]
        PoolKind::DuckDb(con) => PoolKind::DuckDb(con.clone()),
        #[cfg(feature = "duckdb-bundled")]
        PoolKind::DuckDbWorker(client) => PoolKind::DuckDbWorker(client.clone()),
        #[cfg(not(feature = "duckdb-bundled"))]
        PoolKind::DuckDb(con) => PoolKind::DuckDb(con.clone()),
        #[cfg(not(feature = "duckdb-bundled"))]
        PoolKind::DuckDbWorker(client) => PoolKind::DuckDbWorker(client.clone()),
        PoolKind::MongoDb(client) => PoolKind::MongoDb(client.clone()),
        PoolKind::ClickHouse(client) => PoolKind::ClickHouse(client.clone()),
        PoolKind::SqlServer(client) => PoolKind::SqlServer(client.clone()),
        PoolKind::Elasticsearch(client) => PoolKind::Elasticsearch(client.clone()),
        PoolKind::VectorDb(client) => PoolKind::VectorDb(client.clone()),
        PoolKind::InfluxDb(client) => PoolKind::InfluxDb(client.clone()),
        PoolKind::Agent(client) => PoolKind::Agent(client.clone()),
        PoolKind::ExternalTabular(ext) => PoolKind::ExternalTabular(ext.clone()),
        PoolKind::ExternalDriver { driver_id, config, session } => {
            PoolKind::ExternalDriver { driver_id: driver_id.clone(), config: config.clone(), session: session.clone() }
        }
        PoolKind::MessageQueue => PoolKind::MessageQueue,
        PoolKind::Nacos => PoolKind::Nacos,
        PoolKind::Redis(_) => panic!("clone_pool_kind not supported for Redis — handled separately"),
    }
}

pub async fn close_pool_kind(pool: PoolKind) {
    match pool {
        PoolKind::Mysql(p, _) => {
            let _ = p.disconnect().await;
        }
        PoolKind::Postgres(p) => p.close(),
        PoolKind::Sqlite(_) => {}
        PoolKind::Rqlite(_) => {}
        PoolKind::Turso(_) => {}
        PoolKind::Redis(conn) => {
            drop(conn);
        }
        #[cfg(feature = "duckdb-bundled")]
        PoolKind::DuckDb(con) => {
            crate::db::duckdb_driver::close_connection(con);
        }
        #[cfg(feature = "duckdb-bundled")]
        PoolKind::DuckDbWorker(client) => {
            client.shutdown().await;
        }
        #[cfg(not(feature = "duckdb-bundled"))]
        PoolKind::DuckDb(_) => {}
        #[cfg(not(feature = "duckdb-bundled"))]
        PoolKind::DuckDbWorker(_) => {}
        PoolKind::MongoDb(client) => {
            drop(client);
        }
        PoolKind::ClickHouse(client) => {
            drop(client);
        }
        PoolKind::SqlServer(client) => {
            drop(client);
        }
        PoolKind::Elasticsearch(client) => {
            drop(client);
        }
        PoolKind::VectorDb(client) => {
            drop(client);
        }
        PoolKind::InfluxDb(client) => {
            drop(client);
        }
        PoolKind::Agent(client) => {
            let mut client = client.lock().await;
            let _ = client.disconnect().await;
        }
        PoolKind::ExternalTabular(_) => {}
        PoolKind::ExternalDriver { session, .. } => {
            session.shutdown().await;
        }
        PoolKind::MessageQueue => {}
        PoolKind::Nacos => {}
    }
}

async fn close_removed_pools(removed: Vec<(String, PoolKind)>) {
    for (pool_key, pool) in removed {
        close_pool_kind_with_timeout(pool_key, pool).await;
    }
}

fn close_removed_pools_in_background(removed: Vec<(String, PoolKind)>) {
    if removed.is_empty() {
        return;
    }
    tokio::spawn(async move {
        close_removed_pools(removed).await;
    });
}

async fn close_pool_kind_with_timeout(pool_key: String, pool: PoolKind) {
    match tokio::time::timeout(Duration::from_secs(POOL_CLOSE_TIMEOUT_SECS), close_pool_kind(pool)).await {
        Ok(()) => {}
        Err(_) => log::warn!(
            "Timed out closing connection pool '{pool_key}' after {POOL_CLOSE_TIMEOUT_SECS}s; cleanup will continue by dropping the pool handle."
        ),
    }
}

fn extract_auth_token_from_params(params: &str) -> Option<String> {
    params
        .trim()
        .trim_start_matches('?')
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(key, _)| {
            let k = key.trim().to_ascii_lowercase();
            k == "auth_token" || k == "authtoken" || k == "auth-token"
        })
        .map(|(_, value)| value.trim().to_string())
}

fn base_pool_key_for(
    db_type: Option<DatabaseType>,
    connection_id: &str,
    database: Option<&str>,
    include_elasticsearch_single_pool: bool,
) -> String {
    let is_single_connection_pool = db_type.as_ref().is_some_and(|db_type| {
        let is_single = database_capabilities::is_single_connection_pool(db_type)
            || (include_elasticsearch_single_pool
                && matches!(
                    db_type,
                    DatabaseType::Elasticsearch
                        | DatabaseType::Qdrant
                        | DatabaseType::Milvus
                        | DatabaseType::Weaviate
                        | DatabaseType::ChromaDb
                ));
        is_single && (!database_capabilities::is_agent_type(db_type) || shares_database_pool_with_connection(db_type))
    });

    if is_single_connection_pool {
        connection_id.to_string()
    } else {
        match database.map(str::trim).filter(|db| !db.is_empty()) {
            Some(db) => format!("{connection_id}:{db}"),
            None => connection_id.to_string(),
        }
    }
}

fn shares_database_pool_with_connection(db_type: &DatabaseType) -> bool {
    matches!(db_type, DatabaseType::Oracle)
}

#[cfg(test)]
fn uses_agent_connection_pool(db_type: &DatabaseType) -> bool {
    matches!(*db_type, agent_connection_pool_database_type!())
}

#[cfg(test)]
fn uses_bare_mysql_pool(db_type: &DatabaseType) -> bool {
    matches!(db_type, DatabaseType::Doris | DatabaseType::StarRocks | DatabaseType::ManticoreSearch)
}

fn default_plugin_dir() -> PathBuf {
    default_dbx_dir().join("plugins")
}

pub fn default_agent_dir() -> PathBuf {
    default_dbx_dir().join("agents")
}

fn default_dbx_dir() -> PathBuf {
    let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".dbx")
}

pub fn connection_url_for_endpoint(config: &ConnectionConfig, host: &str, port: u16) -> String {
    let normalized = native_postgres_url_config(config);
    let config = normalized.as_ref().unwrap_or(config);
    if host == config.host && port == config.port {
        config.connection_url()
    } else {
        config.connection_url_with_host(host, port)
    }
}

pub fn redacted_connection_url_for_endpoint(config: &ConnectionConfig, host: &str, port: u16) -> String {
    let normalized = native_postgres_url_config(config);
    let config = normalized.as_ref().unwrap_or(config);
    if host == config.host && port == config.port {
        config.redacted_connection_url()
    } else {
        config.redacted_connection_url_with_host(host, port)
    }
}

pub fn agent_connect_timeout(config: &ConnectionConfig) -> std::time::Duration {
    let min_timeout = if config.db_type == DatabaseType::Access {
        ACCESS_AGENT_CONNECT_TIMEOUT_SECS
    } else {
        DEFAULT_AGENT_CONNECT_TIMEOUT_SECS
    };
    std::time::Duration::from_secs(config.effective_connect_timeout_secs().max(min_timeout))
}

fn external_driver_connect_timeout(config: &ConnectionConfig) -> std::time::Duration {
    agent_connect_timeout(config)
}

fn native_postgres_url_config(config: &ConnectionConfig) -> Option<ConnectionConfig> {
    match config.db_type {
        DatabaseType::Gaussdb | DatabaseType::Kwdb | DatabaseType::OpenGauss | DatabaseType::Questdb => {
            let mut normalized = config.clone();
            normalized.database = normalized.effective_database().map(str::to_string);
            if matches!(config.db_type, DatabaseType::Gaussdb | DatabaseType::Kwdb) {
                let params = normalized.url_params.as_deref().unwrap_or("").trim().trim_start_matches('?');
                if !params.to_lowercase().contains("sslmode=") {
                    normalized.url_params = Some(if params.is_empty() {
                        if config.ssl {
                            "sslmode=require".to_string()
                        } else {
                            "sslmode=disable".to_string()
                        }
                    } else {
                        let sslmode = if config.ssl { "sslmode=require" } else { "sslmode=disable" };
                        format!("{sslmode}&{params}")
                    });
                }
            }
            normalized.db_type = DatabaseType::Postgres;
            Some(normalized)
        }
        _ => None,
    }
}

#[cfg(feature = "duckdb-bundled")]
fn duckdb_paths_match(left: &str, right: &str) -> bool {
    let left = expand_tilde(left);
    let right = expand_tilde(right);

    if db::duckdb_driver::is_memory_database_path(&left) || db::duckdb_driver::is_memory_database_path(&right) {
        return left.trim().eq_ignore_ascii_case(right.trim());
    }

    if let (Ok(left_path), Ok(right_path)) = (std::fs::canonicalize(&left), std::fs::canonicalize(&right)) {
        return left_path == right_path;
    }

    if cfg!(windows) {
        left.eq_ignore_ascii_case(&right)
    } else {
        left == right
    }
}

pub async fn probe_connection_endpoint(config: &ConnectionConfig, host: &str, port: u16) -> Result<(), String> {
    if !uses_tcp_probe(config, host, port) {
        return Ok(());
    }
    let timeout = std::time::Duration::from_secs(config.effective_connect_timeout_secs());
    db::probe_tcp_endpoint(&format!("{:?}", config.db_type), host, port, timeout).await
}

fn validate_h2_file_connection(config: &ConnectionConfig) -> Result<(), String> {
    if !is_h2_file_connection(config) {
        return Ok(());
    }
    let path = config
        .connection_string
        .as_deref()
        .and_then(h2_file_path_from_jdbc_url)
        .filter(|path| !path.trim().is_empty())
        .unwrap_or_else(|| config.host.clone());
    validate_h2_database_path(&path)
}

fn validate_h2_database_path(path: &str) -> Result<(), String> {
    let first_err = match db::validate_file_path(path, |_| false) {
        Ok(()) => return Ok(()),
        Err(err) => err,
    };

    for suffix in [".mv.db", ".h2.db"] {
        if path.ends_with(suffix) {
            continue;
        }
        let candidate = format!("{path}{suffix}");
        if db::validate_file_path(&candidate, |_| false).is_ok() {
            return Ok(());
        }
    }

    Err(first_err)
}

fn uses_tcp_probe(config: &ConnectionConfig, host: &str, port: u16) -> bool {
    if config.db_type == DatabaseType::MongoDb
        && config.connection_string.as_deref().is_some_and(|value| !value.is_empty())
    {
        return false;
    }
    if database_capabilities::skips_tcp_probe(&config.db_type) {
        return false;
    }
    if is_original_endpoint(config, host, port) {
        return false;
    }
    true
}

fn is_original_endpoint(config: &ConnectionConfig, host: &str, port: u16) -> bool {
    host == config.host && port == config.port
}

async fn detect_ob_oracle_mode(config: &ConnectionConfig, pool: &db::mysql::MySqlPool) -> MysqlMode {
    let profile = config.driver_profile.as_deref().unwrap_or("").to_lowercase();
    if !profile.contains("oceanbase") {
        return MysqlMode::Normal;
    }
    let mut conn = match pool.get_conn().await {
        Ok(c) => c,
        Err(_) => return MysqlMode::Normal,
    };
    let result = conn.query_iter("SHOW VARIABLES LIKE 'ob_compatibility_mode'").await;
    let rows: Vec<MysqlRow> = match result {
        Ok(r) => match r.collect_and_drop().await {
            Ok(rows) => rows,
            Err(_) => return MysqlMode::Normal,
        },
        Err(_) => return MysqlMode::Normal,
    };
    match rows.first() {
        Some(row) => {
            let val: String = row.get(1).unwrap_or_default();
            if val.to_lowercase() == "oracle" {
                MysqlMode::OceanBaseOracle
            } else {
                MysqlMode::Normal
            }
        }
        None => MysqlMode::Normal,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        agent_connect_timeout, connection_remote_endpoint, connection_url_for_endpoint, database_connection_config,
        metadata_connection_config, mysql_metadata_fallback_url, oceanbase_mysql_query_timeout_sql,
        oceanbase_mysql_setup_queries, prestosql_jdbc_config_for_endpoint, redacted_connection_url_for_endpoint,
        redis_sentinel_transport_id, redis_sentinel_transport_prefix, sqlserver_legacy_agent_config,
        sqlserver_legacy_agent_error, uses_bare_mysql_pool, uses_tcp_probe, validate_h2_database_path, AppState,
        PoolKind, PRESTOSQL_JDBC_DRIVER_CLASS,
    };
    use crate::agent_connection::{
        agent_connect_params, mongo_legacy_error_with_auth_hint, mongo_uses_legacy_driver,
        oracle_alternate_connect_config, should_retry_mongo_with_legacy_driver,
    };
    use crate::agent_manager::{AgentState, JavaRuntimeConfig, JavaRuntimeMode, DEFAULT_JRE_KEY};
    use crate::database_capabilities;
    use crate::db;
    use crate::models::connection::{
        default_connect_timeout_secs, default_redis_key_separator, ConnectionConfig, DatabaseType, ProxyTunnelConfig,
        ProxyType, TransportLayerConfig,
    };
    use crate::query;
    use crate::schema;
    use crate::storage::Storage;

    fn mysql_config(database: Option<&str>) -> ConnectionConfig {
        ConnectionConfig {
            id: "conn".to_string(),
            name: "MySQL".to_string(),
            db_type: DatabaseType::Mysql,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            agent_java_options: Vec::new(),
            host: "127.0.0.1".to_string(),
            port: 3306,
            username: "root".to_string(),
            password: "secret".to_string(),
            database: database.map(str::to_string),
            visible_databases: None,
            visible_schemas: None,
            attached_databases: Vec::new(),
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: default_connect_timeout_secs(),
            query_timeout_secs: crate::models::connection::default_query_timeout_secs(),
            idle_timeout_secs: crate::models::connection::default_idle_timeout_secs(),
            keepalive_interval_secs: crate::models::connection::default_keepalive_interval_secs(),
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
            redis_key_separator: default_redis_key_separator(),
            redis_scan_page_size: None,
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

    #[test]
    fn access_agent_connect_timeout_has_longer_default_floor() {
        let mut config = mysql_config(None);
        config.db_type = DatabaseType::Access;
        config.connect_timeout_secs = 5;
        assert_eq!(agent_connect_timeout(&config).as_secs(), 30);

        config.connect_timeout_secs = 45;
        assert_eq!(agent_connect_timeout(&config).as_secs(), 45);
    }

    #[test]
    fn non_access_agent_connect_timeout_uses_standard_floor() {
        let mut config = mysql_config(None);
        config.db_type = DatabaseType::Oracle;
        config.connect_timeout_secs = 5;
        assert_eq!(agent_connect_timeout(&config).as_secs(), 30);

        config.connect_timeout_secs = 45;
        assert_eq!(agent_connect_timeout(&config).as_secs(), 45);
    }

    #[test]
    fn prestosql_jdbc_config_sets_presto_url_and_driver_class() {
        let mut config = mysql_config(Some("hive/default"));
        config.db_type = DatabaseType::PrestoSql;
        config.host = "presto.example.com".to_string();
        config.port = 9090;

        let jdbc_config = prestosql_jdbc_config_for_endpoint(&config, "127.0.0.1", 19090);

        assert_eq!(jdbc_config.connection_string.as_deref(), Some("jdbc:presto://127.0.0.1:19090/hive/default"));
        assert_eq!(jdbc_config.jdbc_driver_class.as_deref(), Some(PRESTOSQL_JDBC_DRIVER_CLASS));
    }

    #[test]
    fn prestosql_jdbc_config_preserves_custom_driver_class_and_paths() {
        let mut config = mysql_config(Some("hive"));
        config.db_type = DatabaseType::PrestoSql;
        config.jdbc_driver_class = Some("custom.PrestoDriver".to_string());
        config.jdbc_driver_paths = vec!["D:\\software\\jar\\presto-jdbc-350.jar".to_string()];

        let jdbc_config = prestosql_jdbc_config_for_endpoint(&config, "presto.example.com", 9090);

        assert_eq!(jdbc_config.jdbc_driver_class.as_deref(), Some("custom.PrestoDriver"));
        assert_eq!(jdbc_config.jdbc_driver_paths, vec!["D:\\software\\jar\\presto-jdbc-350.jar"]);
    }

    #[test]
    fn sqlserver_legacy_agent_config_marks_hidden_profile() {
        let mut config = mysql_config(Some("master"));
        config.db_type = DatabaseType::SqlServer;

        let legacy = sqlserver_legacy_agent_config(&config);

        assert_eq!(legacy.db_type, DatabaseType::SqlServer);
        assert_eq!(legacy.driver_profile.as_deref(), Some(crate::db::sqlserver::SQLSERVER_LEGACY_DRIVER_PROFILE));
        assert_eq!(legacy.driver_label.as_deref(), Some(crate::db::sqlserver::SQLSERVER_LEGACY_DRIVER_LABEL));
    }

    #[test]
    fn sqlserver_legacy_agent_error_mentions_driver_manager_when_missing() {
        let message = sqlserver_legacy_agent_error(
            "native failed",
            "sqlserver-legacy driver is not installed. Please install it from the Driver Manager.",
        );

        assert!(message.contains("native failed"));
        assert!(message.contains("Fallback with SQL Server legacy compatibility component failed"));
        assert!(message.contains("Driver Manager"));
        assert!(message.contains("enable SQL Server legacy compatibility mode again"));
    }

    #[test]
    fn agent_connect_params_include_url_params() {
        let mut config = mysql_config(Some("testdb"));
        config.username = "informix".to_string();
        config.password = "in4mix".to_string();
        config.url_params = Some("INFORMIXSERVER=informix;CLIENT_LOCALE=en_US.utf8".to_string());

        let params = agent_connect_params(&config, "172.26.128.159", 20013, "testdb");

        assert_eq!(params["host"], "172.26.128.159");
        assert_eq!(params["port"], 20013);
        assert_eq!(params["database"], "testdb");
        assert_eq!(params["username"], "informix");
        assert_eq!(params["password"], "in4mix");
        assert_eq!(params["url_params"], "INFORMIXSERVER=informix;CLIENT_LOCALE=en_US.utf8");
    }

    #[test]
    fn databend_uses_agent_pool_not_bare_mysql_pool() {
        assert!(uses_bare_mysql_pool(&DatabaseType::Doris));
        assert!(uses_bare_mysql_pool(&DatabaseType::StarRocks));
        assert!(uses_bare_mysql_pool(&DatabaseType::ManticoreSearch));
        assert!(!uses_bare_mysql_pool(&DatabaseType::Databend));
        assert!(database_capabilities::is_agent_type(&DatabaseType::Databend));
        assert!(super::uses_agent_connection_pool(&DatabaseType::ZooKeeper));
    }

    #[test]
    fn validates_h2_database_base_path_when_mv_db_file_exists() {
        let dir = std::env::temp_dir().join(format!("dbx-h2-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file_path = dir.join("app.mv.db");
        std::fs::write(&file_path, b"h2").unwrap();
        let base_path = dir.join("app");

        validate_h2_database_path(base_path.to_str().unwrap()).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_missing_h2_database_path() {
        let dir = std::env::temp_dir().join(format!("dbx-h2-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let missing_path = dir.join("missing");

        let err = validate_h2_database_path(missing_path.to_str().unwrap()).unwrap_err();

        assert!(err.contains("File does not exist"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn agent_connect_params_build_mongodb_connection_string_from_form_fields() {
        let mut config = mysql_config(Some("RestCloud_V45PUB_Gateway"));
        config.db_type = DatabaseType::MongoDb;
        config.host = "172.22.4.42".to_string();
        config.port = 27017;
        config.username = "mongouser".to_string();
        config.password = "secret".to_string();
        config.url_params = Some("authSource=admin&authMechanism=SCRAM-SHA-1".to_string());

        let params = agent_connect_params(&config, "172.22.4.42", 27017, "RestCloud_V45PUB_Gateway");

        assert_eq!(params["connection_string"], "mongodb://mongouser:secret@172.22.4.42:27017/RestCloud%5FV45PUB%5FGateway?authSource=admin&authMechanism=SCRAM-SHA-1");
    }

    #[test]
    fn agent_connect_params_mongodb_uses_connection_string_database_when_database_is_empty() {
        let mut config = mysql_config(None);
        config.db_type = DatabaseType::MongoDb;
        config.connection_string =
            Some("mongodb://mongouser:secret@172.22.4.42:27017/RestCloud_V45PUB_Gateway?authSource=admin".to_string());

        let params = agent_connect_params(&config, "172.22.4.42", 27017, "");

        assert_eq!(params["database"], "RestCloud_V45PUB_Gateway");
    }

    #[test]
    fn mongo_legacy_auth_error_adds_auth_source_hint() {
        let err = "Agent RPC error: Exception authenticating MongoCredential{mechanism=SCRAM-SHA-1, userName='rwuser', source='gray_lite_twin_fat'}";

        assert_eq!(
            mongo_legacy_error_with_auth_hint(err),
            "Agent RPC error: Exception authenticating MongoCredential{mechanism=SCRAM-SHA-1, userName='rwuser', source='gray_lite_twin_fat'}\n\nCurrent authentication database: gray_lite_twin_fat. If this user was created in admin, set Authentication database to admin or add authSource=admin to URL params."
        );
    }

    #[test]
    fn oceanbase_mysql_setup_queries_follow_query_timeout() {
        let mut config = mysql_config(Some("dbx"));
        config.driver_profile = Some("oceanbase".to_string());
        config.query_timeout_secs = 30;

        assert_eq!(oceanbase_mysql_setup_queries(&config), vec!["SET ob_query_timeout = 30000000"]);
    }

    #[test]
    fn oceanbase_mysql_query_timeout_sql_accepts_large_timeout() {
        let mut config = mysql_config(Some("dbx"));
        config.driver_profile = Some("oceanbase".to_string());

        assert_eq!(
            oceanbase_mysql_query_timeout_sql(&config, 300_000),
            Some("SET ob_query_timeout = 300000000000".to_string())
        );
    }

    #[test]
    fn oceanbase_mysql_setup_queries_skip_disabled_timeout() {
        let mut config = mysql_config(Some("dbx"));
        config.driver_profile = Some("oceanbase".to_string());
        config.query_timeout_secs = 0;

        assert!(oceanbase_mysql_setup_queries(&config).is_empty());
    }

    #[test]
    fn oceanbase_mysql_setup_queries_do_not_apply_to_plain_mysql() {
        let mut config = mysql_config(Some("dbx"));
        config.query_timeout_secs = 30;

        assert!(oceanbase_mysql_setup_queries(&config).is_empty());
    }

    #[test]
    fn mongo_legacy_retry_covers_old_server_handshake_eof() {
        let err = r#"MongoDB connection failed: Kind: Server selection timeout: No available servers. Topology: { Type: Unknown, Servers: [ { Address: db.example.com:27017, Type: Unknown, Error: Kind: I/O error: unexpected end of file } ] }"#;

        assert!(mongo_uses_legacy_driver(&ConnectionConfig {
            driver_profile: Some("mongodb-legacy".to_string()),
            ..mysql_config(None)
        }));
        assert!(should_retry_mongo_with_legacy_driver(err));
        assert!(should_retry_mongo_with_legacy_driver("server reports wire version 5, but this driver requires 8"));
        assert!(!should_retry_mongo_with_legacy_driver("Authentication failed."));
    }

    #[test]
    fn agent_connect_params_build_oracle_service_connection_string() {
        let mut config = mysql_config(Some("ORCLPDB1"));
        config.db_type = DatabaseType::Oracle;
        config.host = "oracle.example.com".to_string();
        config.port = 1521;
        config.username = "system".to_string();
        config.password = "oracle".to_string();
        config.sysdba = true;
        config.oracle_connection_type = Some("service_name".to_string());

        let params = agent_connect_params(&config, "oracle.example.com", 1521, "ORCLPDB1");

        assert_eq!(params["database"], "SYSDBA:ORCLPDB1");
        assert_eq!(params["sysdba"], true);
        assert_eq!(params["connection_string"], "jdbc:oracle:thin:@//oracle.example.com:1521/ORCLPDB1");
    }

    #[test]
    fn agent_connect_params_build_postgres_like_agent_connection_string_for_selected_database() {
        let cases = [
            (
                DatabaseType::Kingbase,
                "kingbase.example.com",
                54321,
                "jdbc:kingbase8://kingbase.example.com:54321/platform_face_jgj",
                "jdbc:kingbase8://kingbase.example.com:54321/platform_face_freezer_jgj?sslmode=disable",
            ),
            (
                DatabaseType::Highgo,
                "highgo.example.com",
                5866,
                "jdbc:highgo://highgo.example.com:5866/highgo",
                "jdbc:highgo://highgo.example.com:5866/platform_face_freezer_jgj?sslmode=disable",
            ),
            (
                DatabaseType::Vastbase,
                "vastbase.example.com",
                5432,
                "jdbc:vastbase://vastbase.example.com:5432/postgres",
                "jdbc:vastbase://vastbase.example.com:5432/platform_face_freezer_jgj?sslmode=disable",
            ),
        ];

        for (db_type, host, port, stale_connection_string, expected_connection_string) in cases {
            let mut config = mysql_config(Some("platform_face_jgj"));
            config.db_type = db_type;
            config.host = host.to_string();
            config.port = port;
            config.username = "system".to_string();
            config.password = "secret".to_string();
            config.url_params = Some("sslmode=disable".to_string());
            config.connection_string = Some(stale_connection_string.to_string());

            let params = agent_connect_params(&config, host, port, "platform_face_freezer_jgj");

            assert_eq!(params["database"], "platform_face_freezer_jgj");
            assert_eq!(params["connection_string"], expected_connection_string);
        }
    }

    #[test]
    fn agent_connect_params_build_oracle_sid_connection_string() {
        let mut config = mysql_config(Some("ORCL"));
        config.db_type = DatabaseType::Oracle;
        config.oracle_connection_type = Some("sid".to_string());

        let params = agent_connect_params(&config, "127.0.0.1", 11521, "ORCL");

        assert_eq!(params["connection_string"], "jdbc:oracle:thin:@127.0.0.1:11521:ORCL");
    }

    #[test]
    fn agent_connect_params_preserve_legacy_oracle_configs_as_service_name() {
        let mut config = mysql_config(Some("ORCL"));
        config.db_type = DatabaseType::Oracle;
        config.oracle_connection_type = None;

        let params = agent_connect_params(&config, "127.0.0.1", 11521, "ORCL");

        assert_eq!(params["connection_string"], "jdbc:oracle:thin:@//127.0.0.1:11521/ORCL");
    }

    #[test]
    fn oracle_listener_errors_can_retry_with_alternate_connect_descriptor() {
        let mut config = mysql_config(Some("ORCL"));
        config.db_type = DatabaseType::Oracle;
        config.driver_profile = Some("oracle".to_string());
        config.oracle_connection_type = Some("service_name".to_string());

        let retry = oracle_alternate_connect_config(
            &config,
            "Agent RPC error (-1): ORA-12514: listener does not currently know of service requested",
        )
        .expect("listener errors should allow alternate descriptor retry");
        assert_eq!(retry.driver_profile.as_deref(), Some("oracle"));
        assert_eq!(retry.connection_string.as_deref(), Some("jdbc:oracle:thin:@127.0.0.1:3306:ORCL"));

        let mut sid_config = config.clone();
        sid_config.oracle_connection_type = Some("sid".to_string());
        let service_retry = oracle_alternate_connect_config(
            &sid_config,
            "Agent RPC error (-1): ORA-12505: listener does not currently know of SID given",
        )
        .expect("SID listener errors should allow service-name retry");
        assert_eq!(service_retry.connection_string.as_deref(), Some("jdbc:oracle:thin:@//127.0.0.1:3306/ORCL"));

        assert!(oracle_alternate_connect_config(&config, "ORA-12541: TNS:no listener").is_some());
    }

    #[test]
    fn oracle_alternate_descriptor_retry_skips_non_listener_errors() {
        let mut config = mysql_config(Some("ORCL"));
        config.db_type = DatabaseType::Oracle;
        config.driver_profile = Some("oracle".to_string());

        assert!(oracle_alternate_connect_config(&config, "ORA-01017: invalid username/password").is_none());
    }

    #[test]
    fn oracle_alternate_descriptor_retry_skips_custom_connection_strings() {
        let mut config = mysql_config(Some("ORCL"));
        config.db_type = DatabaseType::Oracle;
        config.driver_profile = Some("oracle".to_string());
        config.connection_string = Some("jdbc:oracle:thin:@//oracle.example.com:1521/ORCL".to_string());

        assert!(oracle_alternate_connect_config(&config, "ORA-12514: listener does not know service").is_none());
    }

    #[test]
    fn agent_connect_params_build_saphana_connection_string_from_database_and_url_params() {
        let mut config = mysql_config(Some("TENANT1"));
        config.db_type = DatabaseType::SapHana;
        config.host = "hana.example.com".to_string();
        config.port = 30013;
        config.username = "SYSTEM".to_string();
        config.password = "secret".to_string();
        config.url_params = Some("encrypt=true".to_string());

        let params = agent_connect_params(&config, "hana.example.com", 30013, "TENANT1");

        assert_eq!(params["database"], "TENANT1");
        assert_eq!(params["connection_string"], "jdbc:sap://hana.example.com:30013/?databaseName=TENANT1&encrypt=true");
    }

    async fn test_app_state() -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("dbx-core-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        (AppState::new(storage), dir)
    }

    fn touch_executable(path: &std::path::Path) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, b"").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mut permissions = std::fs::metadata(path).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(path, permissions).unwrap();
        }
    }

    #[tokio::test]
    async fn app_state_uses_explicit_agent_dir() {
        let dir = std::env::temp_dir().join(format!("dbx-core-agent-dir-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let agent_dir = dir.join("agents");

        let state = AppState::new_with_plugin_and_agent_dir_and_app_version(
            storage,
            dir.join("plugins"),
            agent_dir.clone(),
            "0.0.0-test",
        );

        assert_eq!(state.agent_manager.base_dir(), &agent_dir);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn stale_connection_attempt_cannot_replace_newer_pool() {
        let (state, dir) = test_app_state().await;
        let mut config = mysql_config(None);
        config.name = "SQLite".to_string();
        config.db_type = DatabaseType::Sqlite;
        config.host = dir.join("current.db").to_string_lossy().to_string();
        let old_attempt = state.begin_connection_attempt("conn").await;
        let new_attempt = state.begin_connection_attempt("conn").await;
        let current_pool =
            db::sqlite::connect_path_create_if_missing(&dir.join("current.db").to_string_lossy()).await.unwrap();
        let stale_pool =
            db::sqlite::connect_path_create_if_missing(&dir.join("stale.db").to_string_lossy()).await.unwrap();

        state
            .insert_connection_pool_for_attempt(
                "conn",
                new_attempt,
                "conn".to_string(),
                PoolKind::Sqlite(current_pool),
                &config,
            )
            .await
            .unwrap();

        let result = state
            .insert_connection_pool_for_attempt(
                "conn",
                old_attempt,
                "conn".to_string(),
                PoolKind::Sqlite(stale_pool),
                &config,
            )
            .await;

        assert!(result.is_err());
        let conns = state.connections.read().await;
        assert!(matches!(conns.get("conn"), Some(PoolKind::Sqlite(_))));
        assert_eq!(conns.len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn jdbc_plugin_env_uses_managed_jre_when_installed() {
        let dir = std::env::temp_dir().join(format!("dbx-core-jdbc-managed-jre-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = AppState::new_with_plugin_and_agent_dir_and_app_version(
            storage,
            dir.join("plugins"),
            dir.join("agents"),
            "0.0.0-test",
        );
        let java = state.agent_manager.jre_java_path(DEFAULT_JRE_KEY);
        touch_executable(&java);

        let env = state.external_driver_runtime_env("jdbc").unwrap();

        assert_eq!(env.get("DBX_JAVA_BIN"), Some(java.to_string_lossy().as_ref()));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn jdbc_plugin_env_keeps_wrapper_fallback_when_managed_jre_is_missing() {
        let dir = std::env::temp_dir().join(format!("dbx-core-jdbc-missing-jre-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = AppState::new_with_plugin_and_agent_dir_and_app_version(
            storage,
            dir.join("plugins"),
            dir.join("agents"),
            "0.0.0-test",
        );

        let env = state.external_driver_runtime_env("jdbc").unwrap();

        assert_eq!(env.get("DBX_JAVA_BIN"), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn jdbc_plugin_env_uses_custom_java_runtime() {
        let dir = std::env::temp_dir().join(format!("dbx-core-jdbc-custom-jre-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = AppState::new_with_plugin_and_agent_dir_and_app_version(
            storage,
            dir.join("plugins"),
            dir.join("agents"),
            "0.0.0-test",
        );
        let java = dir.join("custom").join("bin").join(if cfg!(windows) { "java.exe" } else { "java" });
        touch_executable(&java);
        state
            .agent_manager
            .save_state(&AgentState {
                java_runtime: JavaRuntimeConfig {
                    mode: JavaRuntimeMode::Custom,
                    custom_java_path: Some(java.to_string_lossy().to_string()),
                },
                ..AgentState::default()
            })
            .unwrap();

        let env = state.external_driver_runtime_env("jdbc").unwrap();

        assert_eq!(env.get("DBX_JAVA_BIN"), Some(java.to_string_lossy().as_ref()));
        let _ = std::fs::remove_dir_all(dir);
    }

    fn live_postgres_like_config(
        db_type: DatabaseType,
        host: &str,
        port: u16,
        username: &str,
        password: &str,
        url_params: Option<&str>,
    ) -> ConnectionConfig {
        let mut config = mysql_config(Some("postgres"));
        config.db_type = db_type;
        config.host = host.to_string();
        config.port = port;
        config.username = username.to_string();
        config.password = password.to_string();
        config.url_params = url_params.map(str::to_string);
        config
    }

    async fn assert_live_postgres_like_query(config: ConnectionConfig) {
        let url = connection_url_for_endpoint(&config, &config.host, config.port);
        let pool = db::postgres::connect(&url, std::time::Duration::from_secs(config.effective_connect_timeout_secs()))
            .await
            .unwrap_or_else(|err| {
                panic!("failed to connect to {:?} at {}:{}: {}", config.db_type, config.host, config.port, err)
            });
        let result =
            db::postgres::execute_query(&pool, "SELECT current_database(), current_schema()").await.unwrap_or_else(
                |err| panic!("failed to query {:?} at {}:{}: {}", config.db_type, config.host, config.port, err),
            );
        assert_eq!(result.rows.len(), 1);
        pool.close();
    }

    #[test]
    fn mysql_metadata_connection_ignores_saved_default_database() {
        let config = mysql_config(Some("app"));

        let metadata = metadata_connection_config(&config);

        assert_eq!(metadata.database, None);
        assert_eq!(metadata.db_type, DatabaseType::Mysql);
    }

    #[test]
    fn mysql_metadata_fallback_uses_saved_default_database() {
        let config = mysql_config(Some("app"));
        let metadata = metadata_connection_config(&config);

        assert_eq!(
            mysql_metadata_fallback_url(&config, &metadata, &config.host, config.port),
            Some("mysql://root:secret@127.0.0.1:3306/app?ssl-mode=disabled&charset=utf8mb4".to_string())
        );
    }

    #[test]
    fn mysql_metadata_fallback_is_unavailable_without_default_database() {
        let config = mysql_config(None);
        let metadata = metadata_connection_config(&config);

        assert_eq!(mysql_metadata_fallback_url(&config, &metadata, &config.host, config.port), None);
    }

    #[test]
    fn mysql_database_connection_keeps_requested_database() {
        let config = mysql_config(Some("app"));

        let scoped = database_connection_config(&config, Some("analytics"));

        assert_eq!(scoped.database.as_deref(), Some("analytics"));
    }

    #[test]
    fn gaussdb_database_connection_keeps_requested_database() {
        let mut config = mysql_config(Some("postgres"));
        config.db_type = DatabaseType::Gaussdb;

        let scoped = database_connection_config(&config, Some("analytics"));

        assert_eq!(scoped.database.as_deref(), Some("analytics"));
    }

    #[test]
    fn gaussdb_endpoint_url_uses_postgres_scheme_for_native_driver() {
        let mut config = mysql_config(Some("postgres"));
        config.db_type = DatabaseType::Gaussdb;
        config.username = "gaussdb".to_string();
        config.password = "secret".to_string();

        assert_eq!(
            connection_url_for_endpoint(&config, &config.host, config.port),
            "postgres://gaussdb:secret@127.0.0.1:3306/postgres?sslmode=disable"
        );
        assert_eq!(
            redacted_connection_url_for_endpoint(&config, &config.host, config.port),
            "postgres://127.0.0.1:3306/postgres?sslmode=disable"
        );
    }

    #[test]
    fn kwdb_endpoint_url_uses_postgres_scheme_for_native_driver() {
        let mut config = mysql_config(None);
        config.db_type = DatabaseType::Kwdb;
        config.username = "root".to_string();
        config.password = "secret".to_string();
        config.port = 26257;

        assert_eq!(
            connection_url_for_endpoint(&config, &config.host, config.port),
            "postgres://root:secret@127.0.0.1:26257/defaultdb?sslmode=disable"
        );
        assert_eq!(
            redacted_connection_url_for_endpoint(&config, &config.host, config.port),
            "postgres://127.0.0.1:26257/defaultdb?sslmode=disable"
        );
    }

    #[test]
    fn kwdb_endpoint_url_keeps_explicit_sslmode() {
        let mut config = mysql_config(None);
        config.db_type = DatabaseType::Kwdb;
        config.username = "root".to_string();
        config.password = "secret".to_string();
        config.port = 26257;
        config.url_params = Some("sslmode=require&application_name=dbx".to_string());

        assert_eq!(
            connection_url_for_endpoint(&config, &config.host, config.port),
            "postgres://root:secret@127.0.0.1:26257/defaultdb?sslmode=require&application_name=dbx"
        );
    }

    #[test]
    fn opengauss_endpoint_url_uses_postgres_scheme_for_native_driver() {
        let mut config = mysql_config(Some("postgres"));
        config.db_type = DatabaseType::OpenGauss;
        config.username = "gaussdb".to_string();
        config.password = "secret".to_string();

        assert_eq!(
            connection_url_for_endpoint(&config, &config.host, config.port),
            "postgres://gaussdb:secret@127.0.0.1:3306/postgres"
        );
    }

    #[test]
    fn gaussdb_endpoint_url_keeps_explicit_sslmode() {
        let mut config = mysql_config(Some("postgres"));
        config.db_type = DatabaseType::Gaussdb;
        config.username = "gaussdb".to_string();
        config.password = "secret".to_string();
        config.url_params = Some("sslmode=require&application_name=dbx".to_string());

        assert_eq!(
            connection_url_for_endpoint(&config, &config.host, config.port),
            "postgres://gaussdb:secret@127.0.0.1:3306/postgres?sslmode=require&application_name=dbx"
        );
    }

    #[test]
    fn gaussdb_endpoint_url_uses_require_sslmode_when_tls_enabled() {
        let mut config = mysql_config(Some("postgres"));
        config.db_type = DatabaseType::Gaussdb;
        config.username = "gaussdb".to_string();
        config.password = "secret".to_string();
        config.ssl = true;

        assert_eq!(
            connection_url_for_endpoint(&config, &config.host, config.port),
            "postgres://gaussdb:secret@127.0.0.1:3306/postgres?sslmode=require"
        );
    }

    #[test]
    fn gaussdb_endpoint_url_prepends_default_sslmode_to_custom_params() {
        let mut config = mysql_config(Some("postgres"));
        config.db_type = DatabaseType::Gaussdb;
        config.username = "gaussdb".to_string();
        config.password = "secret".to_string();
        config.url_params = Some("application_name=dbx".to_string());

        assert_eq!(
            connection_url_for_endpoint(&config, &config.host, config.port),
            "postgres://gaussdb:secret@127.0.0.1:3306/postgres?sslmode=disable&application_name=dbx"
        );
    }

    #[test]
    fn mongodb_database_connection_keeps_saved_database_for_auth() {
        let mut config = mysql_config(Some("admin"));
        config.db_type = DatabaseType::MongoDb;

        let scoped = database_connection_config(&config, Some("shop"));

        assert_eq!(scoped.database.as_deref(), Some("admin"));
    }

    #[test]
    fn oracle_database_connection_ignores_requested_database() {
        let mut config = mysql_config(Some("ORCL"));
        config.db_type = DatabaseType::Oracle;

        let scoped = database_connection_config(&config, Some("analytics"));

        assert_eq!(scoped.database.as_deref(), Some("ORCL"));
    }

    #[test]
    fn oracle_reuses_connection_scoped_pool_for_schema_database_keys() {
        assert_eq!(
            super::base_pool_key_for(Some(DatabaseType::Oracle), "oracle-conn", Some("ORCLPDB1"), false),
            "oracle-conn"
        );
    }

    #[test]
    fn other_agent_single_connection_types_keep_database_scoped_pool_keys() {
        assert_eq!(
            super::base_pool_key_for(Some(DatabaseType::Kingbase), "kingbase-conn", Some("app1"), false),
            "kingbase-conn:app1"
        );
        assert_eq!(
            super::base_pool_key_for(Some(DatabaseType::MongoDb), "mongo-conn", Some("shop"), false),
            "mongo-conn:shop"
        );
    }

    #[test]
    fn non_agent_single_connection_types_still_share_pool_keys() {
        assert_eq!(
            super::base_pool_key_for(Some(DatabaseType::Sqlite), "sqlite-conn", Some("main"), false),
            "sqlite-conn"
        );
        assert_eq!(
            super::base_pool_key_for(Some(DatabaseType::DuckDb), "duckdb-conn", Some("analytics"), false),
            "duckdb-conn"
        );
        assert_eq!(
            super::base_pool_key_for(Some(DatabaseType::Jdbc), "jdbc-conn", Some("analytics"), false),
            "jdbc-conn"
        );
    }

    #[test]
    fn session_scoped_pool_keys_are_sanitized_and_detected() {
        let key = super::session_scoped_pool_key_for(
            Some(DatabaseType::Mysql),
            "mysql-conn:analytics".to_string(),
            Some("tab-1:count"),
        );

        assert_eq!(key, "mysql-conn:analytics:session:tab-1_count");
        assert!(super::is_session_scoped_pool_key(&key));
        assert!(!super::is_session_scoped_pool_key("mysql-conn:analytics"));
        assert_eq!(
            super::session_scoped_pool_key_for(Some(DatabaseType::DuckDb), "duckdb-conn".to_string(), Some("tab-1")),
            "duckdb-conn"
        );
    }

    #[test]
    fn redis_sentinel_transport_ids_are_connection_scoped_by_role_and_endpoint() {
        let endpoint = db::redis_driver::RedisNodeEndpoint { host: "10.0.0.8".to_string(), port: 6379 };

        assert_eq!(redis_sentinel_transport_prefix("redis-prod"), "redis-prod:redis-sentinel:");
        assert_eq!(
            redis_sentinel_transport_id("redis-prod", "master", &endpoint),
            "redis-prod:redis-sentinel:master:10.0.0.8:6379"
        );
    }

    #[test]
    fn mysql_pool_size_keeps_session_pools_single_connection() {
        assert_eq!(super::mysql_pool_max_connections_for_session(None), 10);
        assert_eq!(super::mysql_pool_max_connections_for_session(Some("")), 10);
        assert_eq!(super::mysql_pool_max_connections_for_session(Some("tab-1")), 1);
    }

    #[test]
    fn prestosql_uses_external_driver_pool_not_agent_pool() {
        assert!(!super::uses_agent_connection_pool(&DatabaseType::PrestoSql));
        assert!(super::uses_agent_connection_pool(&DatabaseType::Trino));
    }

    #[test]
    fn mysql_hostname_connections_skip_tcp_probe() {
        let mut config = mysql_config(Some("app"));
        config.host = "mysql.example.com".to_string();

        assert!(!uses_tcp_probe(&config, "mysql.example.com", 3306));
        config.host = "192.0.2.10".to_string();
        assert!(!uses_tcp_probe(&config, "192.0.2.10", 3306));
        assert!(uses_tcp_probe(&config, "127.0.0.1", 53306));
    }

    #[test]
    fn native_direct_connections_skip_tcp_probe() {
        for db_type in [
            DatabaseType::Postgres,
            DatabaseType::Redshift,
            DatabaseType::Redis,
            DatabaseType::ClickHouse,
            DatabaseType::SqlServer,
            DatabaseType::Elasticsearch,
            DatabaseType::Kwdb,
        ] {
            let mut config = mysql_config(Some("app"));
            config.db_type = db_type;
            config.host = "db.example.com".to_string();

            assert!(!uses_tcp_probe(&config, "db.example.com", config.port), "{db_type:?} hostname");
            config.host = "192.0.2.10".to_string();
            assert!(!uses_tcp_probe(&config, "192.0.2.10", config.port), "{db_type:?} ip");
            assert!(uses_tcp_probe(&config, "127.0.0.1", 54000), "{db_type:?} forwarded");
        }
    }

    #[test]
    fn h2_agent_connections_skip_tcp_probe_for_file_and_tcp_modes() {
        let mut file_config = mysql_config(None);
        file_config.db_type = DatabaseType::H2;
        file_config.host = "/tmp/app.mv.db".to_string();
        file_config.port = 0;

        assert!(!uses_tcp_probe(&file_config, "/tmp/app.mv.db", 0));

        let mut tcp_config = mysql_config(Some("test"));
        tcp_config.db_type = DatabaseType::H2;
        tcp_config.host = "127.0.0.1".to_string();
        tcp_config.port = 9092;

        assert!(!uses_tcp_probe(&tcp_config, "127.0.0.1", 9092));
    }

    #[tokio::test]
    async fn sqlite_get_or_create_pool_initializes_connection_for_web_route() {
        let (state, dir) = test_app_state().await;
        let db_path = dir.join("app.db");
        std::fs::File::create(&db_path).unwrap();
        let mut config = mysql_config(None);
        config.id = "sqlite-conn".to_string();
        config.name = "SQLite".to_string();
        config.db_type = DatabaseType::Sqlite;
        config.host = db_path.to_string_lossy().to_string();
        config.port = 0;

        state.configs.write().await.insert(config.id.clone(), config);

        let pool_key = state.get_or_create_pool("sqlite-conn", None).await.unwrap();
        assert_eq!(pool_key, "sqlite-conn");

        let databases = schema::list_databases_core(&state, "sqlite-conn").await.unwrap();
        assert_eq!(databases.len(), 1);
        assert_eq!(databases[0].name, "main");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(feature = "duckdb-bundled")]
    #[tokio::test]
    async fn duckdb_existing_pool_can_be_used_for_connection_test() {
        let (state, dir) = test_app_state().await;
        let db_path = dir.join("app.duckdb");
        duckdb::Connection::open(&db_path).unwrap();
        let mut config = mysql_config(None);
        config.id = "duckdb-conn".to_string();
        config.name = "DuckDB".to_string();
        config.db_type = DatabaseType::DuckDb;
        config.host = db_path.to_string_lossy().to_string();
        config.port = 0;

        state.configs.write().await.insert(config.id.clone(), config.clone());
        state.get_or_create_pool("duckdb-conn", None).await.unwrap();

        assert!(state.duckdb_existing_pool_is_usable_for_config(&config).await.unwrap());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(feature = "duckdb-bundled")]
    #[tokio::test]
    async fn applying_duckdb_worker_isolation_drops_existing_duckdb_pools() {
        let (state, dir) = test_app_state().await;
        let db_path = dir.join("app.duckdb");
        duckdb::Connection::open(&db_path).unwrap();
        let mut config = mysql_config(None);
        config.id = "duckdb-conn".to_string();
        config.name = "DuckDB".to_string();
        config.db_type = DatabaseType::DuckDb;
        config.host = db_path.to_string_lossy().to_string();
        config.port = 0;

        state.configs.write().await.insert(config.id.clone(), config);
        state.get_or_create_pool("duckdb-conn", None).await.unwrap();
        assert!(matches!(state.connections.read().await.get("duckdb-conn"), Some(PoolKind::DuckDb(_))));

        state.apply_duckdb_worker_process_isolation(true).await;

        assert!(!state.connections.read().await.contains_key("duckdb-conn"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(feature = "duckdb-bundled")]
    #[tokio::test]
    async fn duckdb_pool_mode_mismatch_removes_existing_pool() {
        let (state, dir) = test_app_state().await;
        let db_path = dir.join("app.duckdb");
        duckdb::Connection::open(&db_path).unwrap();
        let mut config = mysql_config(None);
        config.id = "duckdb-conn".to_string();
        config.name = "DuckDB".to_string();
        config.db_type = DatabaseType::DuckDb;
        config.host = db_path.to_string_lossy().to_string();
        config.port = 0;

        state.configs.write().await.insert(config.id.clone(), config);
        state.get_or_create_pool("duckdb-conn", None).await.unwrap();
        assert!(matches!(state.connections.read().await.get("duckdb-conn"), Some(PoolKind::DuckDb(_))));

        state.set_duckdb_worker_process_isolation_enabled(true);

        assert!(state.remove_pool_if_duckdb_isolation_mismatch("duckdb-conn").await);
        assert!(!state.connections.read().await.contains_key("duckdb-conn"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn remove_connection_pools_clears_base_and_database_scoped_pools() {
        let (state, dir) = test_app_state().await;
        let pool = crate::db::sqlite::connect_path(":memory:").await.unwrap();

        {
            let mut conns = state.connections.write().await;
            conns.insert("conn".to_string(), PoolKind::Sqlite(pool.clone()));
            conns.insert("conn:analytics".to_string(), PoolKind::Sqlite(pool.clone()));
            conns.insert("conn:session:tab-1".to_string(), PoolKind::Sqlite(pool.clone()));
            conns.insert("conn:analytics:session:tab-1".to_string(), PoolKind::Sqlite(pool.clone()));
            conns.insert("other".to_string(), PoolKind::Sqlite(pool));
        }

        state.remove_connection_pools("conn").await;

        let conns = state.connections.read().await;
        assert!(!conns.contains_key("conn"));
        assert!(!conns.contains_key("conn:analytics"));
        assert!(!conns.contains_key("conn:session:tab-1"));
        assert!(!conns.contains_key("conn:analytics:session:tab-1"));
        assert!(conns.contains_key("other"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn pool_activity_touch_updates_existing_pool_only() {
        let (state, dir) = test_app_state().await;
        let pool = crate::db::sqlite::connect_path(":memory:").await.unwrap();
        let pool_key = "conn:session:tab-1";

        state.connections.write().await.insert(pool_key.to_string(), PoolKind::Sqlite(pool));
        state.pool_activity.write().await.insert(
            pool_key.to_string(),
            super::PoolActivity { last_used_at: std::time::Instant::now() - std::time::Duration::from_secs(10) },
        );

        {
            let _touch = state.pool_activity_touch(pool_key);
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        let elapsed = state.pool_activity.read().await.get(pool_key).unwrap().last_used_at.elapsed();
        assert!(elapsed < std::time::Duration::from_secs(10));

        {
            let _touch = state.pool_activity_touch(pool_key);
            state.connections.write().await.remove(pool_key);
            state.pool_activity.write().await.remove(pool_key);
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        assert!(!state.pool_activity.read().await.contains_key(pool_key));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn agent_validate_connection_unknown_method_is_not_stale() {
        assert!(super::is_agent_validate_connection_unsupported(
            "Agent RPC error (-1): Unknown method: validate_connection"
        ));
        assert!(super::is_agent_validate_connection_unsupported(
            "Agent RPC error (-32601): Method not found: validate_connection"
        ));
        assert!(!super::is_agent_validate_connection_unsupported("Agent RPC error (-1): Connection timed out"));
        assert!(!super::is_agent_validate_connection_unsupported("Agent RPC error (-1): Unknown method: kv_put"));
    }

    #[cfg(feature = "duckdb-bundled")]
    #[tokio::test]
    async fn duckdb_client_session_reuses_base_pool_to_avoid_file_locks() {
        let (state, dir) = test_app_state().await;
        let db_path = dir.join("session.duckdb");
        duckdb::Connection::open(&db_path).unwrap();
        let mut config = mysql_config(None);
        config.id = "duckdb-conn".to_string();
        config.name = "DuckDB".to_string();
        config.db_type = DatabaseType::DuckDb;
        config.host = db_path.to_string_lossy().to_string();
        config.port = 0;

        state.configs.write().await.insert(config.id.clone(), config.clone());
        let base_pool_key = state.get_or_create_pool("duckdb-conn", None).await.unwrap();
        let pool_key = state.get_or_create_pool_for_session("duckdb-conn", Some("main"), Some("tab-1")).await.unwrap();
        assert_eq!(pool_key, base_pool_key);

        assert!(!state.close_client_session_pool("duckdb-conn", Some("main"), "tab-1").await.unwrap());

        let conns = state.connections.read().await;
        assert!(conns.contains_key("duckdb-conn"));
        assert!(!conns.contains_key("duckdb-conn:session:tab-1"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn close_database_pool_removes_database_and_session_scoped_pools_only() {
        let (state, dir) = test_app_state().await;
        let mut config = mysql_config(None);
        config.id = "conn".to_string();
        state.configs.write().await.insert(config.id.clone(), config);
        let pool = crate::db::sqlite::connect_path(":memory:").await.unwrap();

        {
            let mut conns = state.connections.write().await;
            conns.insert("conn".to_string(), PoolKind::Sqlite(pool.clone()));
            conns.insert("conn:analytics".to_string(), PoolKind::Sqlite(pool.clone()));
            conns.insert("conn:analytics:session:tab-1".to_string(), PoolKind::Sqlite(pool.clone()));
            conns.insert("conn:billing".to_string(), PoolKind::Sqlite(pool));
        }

        assert!(state.close_database_pool("conn", Some("analytics")).await.unwrap());

        let conns = state.connections.read().await;
        assert!(conns.contains_key("conn"));
        assert!(!conns.contains_key("conn:analytics"));
        assert!(!conns.contains_key("conn:analytics:session:tab-1"));
        assert!(conns.contains_key("conn:billing"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn proxy_connection_uses_local_forward_endpoint() {
        let (state, dir) = test_app_state().await;
        let mut config = mysql_config(Some("app"));
        config.transport_layers = vec![TransportLayerConfig::Proxy(ProxyTunnelConfig {
            id: "proxy".to_string(),
            name: String::new(),
            enabled: true,
            proxy_type: ProxyType::Socks5,
            host: "127.0.0.1".to_string(),
            port: 65000,
            username: String::new(),
            password: String::new(),
        })];

        let (host, port) = state.connection_host_port("proxied", &config).await.unwrap();

        assert_eq!(host, "127.0.0.1");
        assert_ne!(port, config.port);
        state.proxy_tunnels.stop_tunnel("proxied:transport:0").await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn mq_remote_endpoint_comes_from_admin_url_when_host_fields_are_empty() {
        let mut config = mysql_config(None);
        config.db_type = DatabaseType::MessageQueue;
        config.host = String::new();
        config.port = 0;
        config.external_config = Some(serde_json::json!({
            "systemKind": "pulsar",
            "adminUrl": "https://broker.internal:8443/pulsar-admin?tenant=public",
            "auth": { "kind": "none" }
        }));

        assert_eq!(connection_remote_endpoint(&config), ("broker.internal".to_string(), 8443));
    }

    #[cfg(feature = "mq-admin")]
    #[tokio::test]
    async fn mq_admin_config_preserves_admin_url_and_uses_forwarded_connect_override() {
        let (state, dir) = test_app_state().await;
        let mut config = mysql_config(None);
        config.id = "proxied-mq".to_string();
        config.db_type = DatabaseType::MessageQueue;
        config.host = String::new();
        config.port = 0;
        config.external_config = Some(serde_json::json!({
            "systemKind": "pulsar",
            "adminUrl": "https://broker.internal:8443/pulsar-admin?tenant=public",
            "auth": { "kind": "none" }
        }));
        config.transport_layers = vec![TransportLayerConfig::Proxy(ProxyTunnelConfig {
            id: "proxy".to_string(),
            name: String::new(),
            enabled: true,
            proxy_type: ProxyType::Socks5,
            host: "127.0.0.1".to_string(),
            port: 65000,
            username: String::new(),
            password: String::new(),
        })];

        let mqc = state.mq_admin_config_for_connection("proxied-mq", &config).await.unwrap();

        assert_eq!(mqc.admin_url, "https://broker.internal:8443/pulsar-admin?tenant=public");
        let connect_override = mqc.connect_override.expect("MQ transport should set a connect override");
        assert_eq!(connect_override.host, "127.0.0.1");
        assert_ne!(connect_override.port, 8443);
        state.proxy_tunnels.stop_tunnel("proxied-mq:transport:0").await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn nacos_admin_config_allows_domain_server_addr_without_transport_override() {
        let (state, dir) = test_app_state().await;
        let mut config = mysql_config(None);
        config.id = "aliyun-nacos".to_string();
        config.db_type = DatabaseType::Nacos;
        config.host = "example.com".to_string();
        config.port = 8848;
        config.external_config = Some(serde_json::json!({
            "serverAddr": "https://nacos.aliyuncs.com:8848",
            "namespace": "public",
            "contextPath": "/nacos",
            "auth": { "kind": "none" }
        }));

        let nacos_config = state.nacos_admin_config_for_connection("aliyun-nacos", &config).await.unwrap();

        assert_eq!(nacos_config.server_addr, "https://nacos.aliyuncs.com:8848");
        assert!(nacos_config.connect_override.is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn nacos_admin_config_rewrites_server_addr_to_forwarded_endpoint() {
        let (state, dir) = test_app_state().await;
        let mut config = mysql_config(None);
        config.id = "proxied-nacos".to_string();
        config.db_type = DatabaseType::Nacos;
        config.host = "192.168.2.51".to_string();
        config.port = 10840;
        config.external_config = Some(serde_json::json!({
            "serverAddr": "http://192.168.2.51:10840",
            "namespace": "public",
            "contextPath": "",
            "auth": { "kind": "none" }
        }));
        config.transport_layers = vec![TransportLayerConfig::Proxy(ProxyTunnelConfig {
            id: "proxy".to_string(),
            name: String::new(),
            enabled: true,
            proxy_type: ProxyType::Socks5,
            host: "127.0.0.1".to_string(),
            port: 65000,
            username: String::new(),
            password: String::new(),
        })];

        let nacos_config = state.nacos_admin_config_for_connection("proxied-nacos", &config).await.unwrap();

        assert!(nacos_config.server_addr.starts_with("http://127.0.0.1:"));
        assert_ne!(nacos_config.server_addr, "http://192.168.2.51:10840");
        assert!(nacos_config.connect_override.is_none());
        state.proxy_tunnels.stop_tunnel("proxied-nacos:transport:0").await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    #[ignore = "requires a reachable GaussDB instance via environment variables"]
    async fn live_gaussdb_native_connection_succeeds() {
        let host = std::env::var("DBX_TEST_GAUSSDB_HOST").expect("DBX_TEST_GAUSSDB_HOST not set");
        let port = std::env::var("DBX_TEST_GAUSSDB_PORT")
            .expect("DBX_TEST_GAUSSDB_PORT not set")
            .parse::<u16>()
            .expect("DBX_TEST_GAUSSDB_PORT should be a u16");
        let username = std::env::var("DBX_TEST_GAUSSDB_USER").expect("DBX_TEST_GAUSSDB_USER not set");
        let password = std::env::var("DBX_TEST_GAUSSDB_PASSWORD").expect("DBX_TEST_GAUSSDB_PASSWORD not set");
        let url_params = std::env::var("DBX_TEST_GAUSSDB_URL_PARAMS").ok();

        assert_live_postgres_like_query(live_postgres_like_config(
            DatabaseType::Gaussdb,
            &host,
            port,
            &username,
            &password,
            url_params.as_deref(),
        ))
        .await;
    }

    #[tokio::test]
    #[ignore = "requires a reachable openGauss instance via environment variables"]
    async fn live_opengauss_native_connection_succeeds() {
        let host = std::env::var("DBX_TEST_OPENGAUSS_HOST").expect("DBX_TEST_OPENGAUSS_HOST not set");
        let port = std::env::var("DBX_TEST_OPENGAUSS_PORT")
            .expect("DBX_TEST_OPENGAUSS_PORT not set")
            .parse::<u16>()
            .expect("DBX_TEST_OPENGAUSS_PORT should be a u16");
        let username = std::env::var("DBX_TEST_OPENGAUSS_USER").expect("DBX_TEST_OPENGAUSS_USER not set");
        let password = std::env::var("DBX_TEST_OPENGAUSS_PASSWORD").expect("DBX_TEST_OPENGAUSS_PASSWORD not set");
        let url_params = std::env::var("DBX_TEST_OPENGAUSS_URL_PARAMS").ok();

        assert_live_postgres_like_query(live_postgres_like_config(
            DatabaseType::OpenGauss,
            &host,
            port,
            &username,
            &password,
            url_params.as_deref(),
        ))
        .await;
    }

    #[tokio::test]
    #[ignore = "requires a reachable KWDB instance via environment variables"]
    async fn live_kwdb_native_connection_succeeds() {
        let host = std::env::var("DBX_TEST_KWDB_HOST").expect("DBX_TEST_KWDB_HOST not set");
        let port = std::env::var("DBX_TEST_KWDB_PORT")
            .expect("DBX_TEST_KWDB_PORT not set")
            .parse::<u16>()
            .expect("DBX_TEST_KWDB_PORT should be a u16");
        let username = std::env::var("DBX_TEST_KWDB_USER").unwrap_or_else(|_| "root".to_string());
        let password = std::env::var("DBX_TEST_KWDB_PASSWORD").unwrap_or_default();
        let database = std::env::var("DBX_TEST_KWDB_DATABASE").unwrap_or_else(|_| "defaultdb".to_string());
        let url_params = std::env::var("DBX_TEST_KWDB_URL_PARAMS").unwrap_or_else(|_| "sslmode=disable".to_string());

        let mut config = mysql_config(Some(&database));
        config.id = "kwdb-live".to_string();
        config.db_type = DatabaseType::Kwdb;
        config.host = host;
        config.port = port;
        config.username = username;
        config.password = password;
        config.url_params = Some(url_params);

        let (state, dir) = test_app_state().await;
        state.configs.write().await.insert(config.id.clone(), config);
        let pool_key = state.get_or_create_pool("kwdb-live", None).await.unwrap();
        let pool = {
            let connections = state.connections.read().await;
            match connections.get(&pool_key).expect("KWDB pool should be created") {
                PoolKind::Postgres(pool) => pool.clone(),
                _ => panic!("KWDB should use the PostgreSQL pool path"),
            }
        };
        let result = query::execute_sql_statement(
            &state,
            "kwdb-live",
            &database,
            "SELECT current_database(), current_schema()",
            None,
            None,
        )
        .await
        .unwrap_or_else(|err| panic!("failed to query live KWDB: {err}"));
        assert_eq!(result.rows.len(), 1);
        let database_column_index = result
            .columns
            .iter()
            .position(|column| column == "current_database")
            .expect("current_database column should be present");
        assert_eq!(result.rows[0].get(database_column_index).and_then(|value| value.as_str()), Some(database.as_str()));
        let databases = schema::list_databases_core(&state, "kwdb-live").await.unwrap();
        assert!(databases.iter().any(|database| database.name == "defaultdb"));
        let test_schema = "dbx_kwdb_live";
        db::postgres::execute_query(&pool, &format!("DROP SCHEMA IF EXISTS {test_schema} CASCADE"))
            .await
            .unwrap_or_else(|err| panic!("failed to clean KWDB test schema: {err}"));
        query::execute_sql_statement(
            &state,
            "kwdb-live",
            &database,
            &format!("CREATE SCHEMA {test_schema}"),
            None,
            None,
        )
        .await
        .unwrap_or_else(|err| panic!("failed to create KWDB test schema: {err}"));
        query::execute_sql_statement(
            &state,
            "kwdb-live",
            &database,
            "CREATE TABLE devices (id INT PRIMARY KEY, name STRING, active BOOL)",
            Some(test_schema),
            None,
        )
        .await
        .unwrap_or_else(|err| panic!("failed to create KWDB test table: {err}"));
        query::execute_sql_statement(
            &state,
            "kwdb-live",
            &database,
            "INSERT INTO devices (id, name, active) VALUES (1, 'meter-a', true)",
            Some(test_schema),
            None,
        )
        .await
        .unwrap_or_else(|err| panic!("failed to insert KWDB test row: {err}"));
        let query_result = query::execute_sql_statement(
            &state,
            "kwdb-live",
            &database,
            "SELECT name, active FROM devices WHERE id = 1",
            Some(test_schema),
            None,
        )
        .await
        .unwrap_or_else(|err| panic!("failed to query KWDB test row: {err}"));
        assert_eq!(query_result.rows.len(), 1);
        assert_eq!(query_result.rows[0].first().and_then(|value| value.as_str()), Some("meter-a"));

        let schemas = schema::list_schemas_core(&state, "kwdb-live", &database).await.unwrap();
        assert!(schemas.iter().any(|schema| schema == test_schema));
        let tables = schema::list_tables_core(&state, "kwdb-live", &database, test_schema, None, None, None, None)
            .await
            .unwrap();
        assert!(tables.iter().any(|table| table.name == "devices" && table.table_type == "BASE TABLE"));
        let columns = schema::get_columns_core(&state, "kwdb-live", &database, test_schema, "devices").await.unwrap();
        let id_column = columns.iter().find(|column| column.name == "id").expect("id column should be listed");
        assert!(id_column.data_type.to_lowercase().contains("int"));
        let name_column = columns.iter().find(|column| column.name == "name").expect("name column should be listed");
        assert!(name_column.data_type.to_lowercase().contains("text"));
        let active_column =
            columns.iter().find(|column| column.name == "active").expect("active column should be listed");
        assert!(active_column.data_type.to_lowercase().contains("bool"));
        db::postgres::execute_query(&pool, &format!("DROP SCHEMA {test_schema} CASCADE"))
            .await
            .unwrap_or_else(|err| panic!("failed to drop KWDB test schema: {err}"));
        pool.close();
        let _ = std::fs::remove_dir_all(dir);
    }
}
