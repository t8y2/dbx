use crate::agent_recovery::{RecoveryDecision, RecoveryPolicy, RecoveryScope};
use crate::connection::{
    connection_url_for_endpoint, database_connection_config, gaussdb_uses_m_jdbc_driver, task_client_session_id,
    AppState, MysqlMode, PoolKind,
};
use crate::db;
use crate::models::connection::{ConnectionConfig, DatabaseType};
use crate::query::{agent_execute_query_params, should_discard_pool_after_error, QueryExecutionOptions};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

mod kingbase;

macro_rules! extract_pool {
    ($connections:expr, $key:expr, $variant:ident) => {
        $connections.get($key).and_then(|v| match v {
            PoolKind::$variant(val) => Some(val.clone()),
            _ => None,
        })
    };
}

macro_rules! dispatch_mysql {
    ($p:expr, $mode:expr, $mysql:path, $ob:path $(, $arg:expr)*) => {
        if *$mode == MysqlMode::OceanBaseOracle {
            $ob($p $(, $arg)*).await
        } else {
            $mysql($p $(, $arg)*).await
        }
    };
}

struct EphemeralAgentMetadataSession {
    client_session_id: Option<String>,
    cleanup_guard: Option<crate::connection::ClientSessionPoolCleanupGuard>,
}

impl EphemeralAgentMetadataSession {
    async fn open(state: &AppState, connection_id: &str, database: Option<&str>, task_kind: &str) -> Self {
        let db_config = connection_config(state, connection_id).await;
        let client_session_id = ephemeral_agent_metadata_session_id(db_config.as_ref(), task_kind);
        let cleanup_guard = match client_session_id.as_deref() {
            Some(client_session_id) => {
                state.metadata_session_pool_cleanup_guard(connection_id, database, client_session_id).await
            }
            None => None,
        };
        Self { client_session_id, cleanup_guard }
    }

    fn client_session_id(&self) -> Option<&str> {
        self.client_session_id.as_deref()
    }

    async fn finish(mut self, state: &AppState, connection_id: &str, database: Option<&str>) {
        if close_ephemeral_agent_metadata_session(state, connection_id, database, self.client_session_id()).await {
            if let Some(cleanup_guard) = self.cleanup_guard.as_mut() {
                cleanup_guard.disarm();
            }
        }
    }
}

macro_rules! try_sqlserver {
    ($connections:expr, $pool_key:expr, $method:ident $(, $arg:expr)*) => {
        if let Some(client) = extract_pool!(&$connections, $pool_key, SqlServer) {
            drop($connections);
            let mut client = client.lock().await;
            return db::sqlserver::$method(&mut client $(, $arg)*).await;
        }
    };
}

const ORACLE_TABLE_COMMENT_BATCH_SIZE: usize = 500;
const TDENGINE_COMMENT_SEARCH_TIMEOUT: Duration = Duration::from_secs(5);
const TDENGINE_COMMENT_SEARCH_CACHE_TTL: Duration = Duration::from_secs(10);
const TDENGINE_LIKE_PATTERN_MAX_BYTES: usize = 100;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableNameFilter {
    pub include_patterns: Vec<String>,
    pub exclude_patterns: Vec<String>,
}

impl TableNameFilter {
    pub fn is_empty(&self) -> bool {
        self.include_patterns.iter().all(|pattern| pattern.trim().is_empty())
            && self.exclude_patterns.iter().all(|pattern| pattern.trim().is_empty())
    }
}

fn sql_like_pattern_matches_case_insensitive(pattern: &str, value: &str) -> bool {
    #[derive(Clone, Copy)]
    enum LikeToken {
        Any,
        One,
        Literal(char),
    }

    let mut tokens = Vec::new();
    let pattern = pattern.trim().to_lowercase();
    let mut pattern_chars = pattern.chars().peekable();
    while let Some(ch) = pattern_chars.next() {
        match ch {
            '%' => tokens.push(LikeToken::Any),
            '_' => tokens.push(LikeToken::One),
            '\\' => tokens.push(LikeToken::Literal(pattern_chars.next().unwrap_or('\\'))),
            literal => tokens.push(LikeToken::Literal(literal)),
        }
    }
    let value_chars: Vec<char> = value.to_lowercase().chars().collect();

    let mut previous = vec![false; value_chars.len() + 1];
    previous[0] = true;
    for token in tokens {
        let mut current = vec![false; value_chars.len() + 1];
        match token {
            LikeToken::Any => {
                current[0] = previous[0];
                for value_index in 1..=value_chars.len() {
                    current[value_index] = previous[value_index] || current[value_index - 1];
                }
            }
            LikeToken::One => {
                current[1..].copy_from_slice(&previous[..value_chars.len()]);
            }
            LikeToken::Literal(literal) => {
                for value_index in 1..=value_chars.len() {
                    current[value_index] = previous[value_index - 1] && value_chars[value_index - 1] == literal;
                }
            }
        }
        previous = current;
    }
    previous[value_chars.len()]
}

pub fn table_name_filter_matches(name: &str, filter: Option<&TableNameFilter>) -> bool {
    let Some(filter) = filter.filter(|filter| !filter.is_empty()) else {
        return true;
    };
    let include_patterns: Vec<&str> =
        filter.include_patterns.iter().map(|pattern| pattern.trim()).filter(|pattern| !pattern.is_empty()).collect();
    let exclude_patterns: Vec<&str> =
        filter.exclude_patterns.iter().map(|pattern| pattern.trim()).filter(|pattern| !pattern.is_empty()).collect();
    let included = include_patterns.is_empty()
        || include_patterns.iter().any(|pattern| sql_like_pattern_matches_case_insensitive(pattern, name));
    included && !exclude_patterns.iter().any(|pattern| sql_like_pattern_matches_case_insensitive(pattern, name))
}

fn clickhouse_metadata_database<'a>(database: &'a str, schema: &'a str) -> &'a str {
    if schema.trim().is_empty() {
        database
    } else {
        schema
    }
}

fn agent_metadata_timeout(config: Option<&ConnectionConfig>) -> Option<Duration> {
    let Some(config) = config else {
        return Some(Duration::from_secs(60));
    };
    match config.effective_query_timeout_secs() {
        0 => None,
        seconds => Some(Duration::from_secs(seconds.max(60))),
    }
}

pub async fn list_databases_core(state: &AppState, connection_id: &str) -> Result<Vec<db::DatabaseInfo>, String> {
    retry_metadata_connection(state, connection_id, None, || list_databases_once(state, connection_id)).await
}

/// Loads the more expensive database-level properties needed only by the
/// connection resource browser. General metadata paths keep using
/// `list_databases_core`, which only enumerates names.
pub async fn list_database_metadata_core(
    state: &AppState,
    connection_id: &str,
) -> Result<Vec<db::DatabaseInfo>, String> {
    retry_metadata_connection(state, connection_id, None, || list_database_metadata_once(state, connection_id)).await
}

pub async fn list_database_storage_core(
    state: &AppState,
    connection_id: &str,
    database_names: &[String],
) -> Result<Vec<db::DatabaseStorageInfo>, String> {
    const DATABASE_STORAGE_TIMEOUT: Duration = Duration::from_secs(5);
    const MAX_DATABASE_STORAGE_NAMES: usize = 2048;

    if database_names.is_empty() {
        return Ok(Vec::new());
    }
    let config = connection_config(state, connection_id).await;
    if !config.as_ref().is_some_and(|config| {
        config.db_type == DatabaseType::Postgres && config.driver_profile.as_deref() != Some("cockroachdb")
    }) {
        return Ok(Vec::new());
    }

    let pool = {
        let connections = state.connections.read().await;
        match connections.get(connection_id) {
            Some(PoolKind::Postgres(pool)) => pool.clone(),
            _ => return Ok(Vec::new()),
        }
    };
    let mut seen = std::collections::HashSet::new();
    let requested = database_names
        .iter()
        .filter(|name| !name.is_empty() && seen.insert((*name).clone()))
        .take(MAX_DATABASE_STORAGE_NAMES)
        .cloned()
        .collect::<Vec<_>>();
    if requested.is_empty() {
        return Ok(Vec::new());
    }

    match tokio::time::timeout(DATABASE_STORAGE_TIMEOUT, db::postgres::list_database_storage(&pool, &requested)).await {
        Ok(result) => result,
        Err(_) => {
            log::warn!(
                "[list_database_storage:timeout] connection_id={} database_count={} timeout_ms={}",
                connection_id,
                requested.len(),
                DATABASE_STORAGE_TIMEOUT.as_millis()
            );
            Ok(Vec::new())
        }
    }
}

pub async fn list_sqlserver_linked_servers_core(
    state: &AppState,
    connection_id: &str,
) -> Result<Vec<db::LinkedServerInfo>, String> {
    let connections = state.connections.read().await;
    if let Some(client) = extract_pool!(&connections, connection_id, SqlServer) {
        drop(connections);
        let mut client = client.lock().await;
        return db::sqlserver::list_linked_servers(&mut client).await;
    }
    Ok(vec![])
}

pub async fn get_sqlserver_completion_context_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
) -> Result<db::sqlserver::SqlServerCompletionContext, String> {
    retry_metadata_connection(state, connection_id, Some(database), || async {
        let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
        let db_config = connection_config(state, connection_id).await;
        let connections = state.connections.read().await;
        if let Some(PoolKind::ExternalDriver { config, session, .. }) = connections.get(&pool_key) {
            let config = config.clone();
            let session = session.clone();
            drop(connections);
            let result: db::QueryResult = session
                .invoke_with_timeout(
                    "executeQuery",
                    serde_json::json!({
                        "connection": config.as_ref(),
                        "database": database,
                        "sql": db::sqlserver::completion_context_sql(),
                        "maxRows": 1
                    }),
                    agent_metadata_timeout(Some(config.as_ref())),
                )
                .await?;
            return db::sqlserver::completion_context_from_query_result(result);
        }
        try_sqlserver!(connections, &pool_key, get_completion_context);
        if let Some(client) = extract_pool!(&connections, &pool_key, Agent) {
            drop(connections);
            let mut client = client.lock().await;
            let result = client
                .execute_query_with_timeout::<db::QueryResult>(
                    agent_execute_query_params(
                        db::sqlserver::completion_context_sql(),
                        if database.is_empty() { None } else { Some(database) },
                        None,
                        QueryExecutionOptions { max_rows: Some(1), ..Default::default() },
                    ),
                    agent_metadata_timeout(db_config.as_ref()),
                )
                .await?;
            return db::sqlserver::completion_context_from_query_result(result);
        }
        Err("SQL Server completion context requires a SQL Server connection".to_string())
    })
    .await
}

pub async fn list_sqlserver_linked_server_catalogs_core(
    state: &AppState,
    connection_id: &str,
    server: &str,
) -> Result<Vec<db::DatabaseInfo>, String> {
    let connections = state.connections.read().await;
    if let Some(client) = extract_pool!(&connections, connection_id, SqlServer) {
        drop(connections);
        let mut client = client.lock().await;
        return db::sqlserver::list_linked_server_catalogs(&mut client, server).await;
    }
    Ok(vec![])
}

pub async fn list_sqlserver_linked_server_schemas_core(
    state: &AppState,
    connection_id: &str,
    server: &str,
    catalog: &str,
) -> Result<Vec<String>, String> {
    let connections = state.connections.read().await;
    if let Some(client) = extract_pool!(&connections, connection_id, SqlServer) {
        drop(connections);
        let mut client = client.lock().await;
        return db::sqlserver::list_linked_server_schemas(&mut client, server, catalog).await;
    }
    Ok(vec![])
}

pub async fn list_sqlserver_linked_server_tables_core(
    state: &AppState,
    connection_id: &str,
    server: &str,
    catalog: &str,
    schema: &str,
    filter: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<db::TableInfo>, String> {
    let connections = state.connections.read().await;
    if let Some(client) = extract_pool!(&connections, connection_id, SqlServer) {
        drop(connections);
        let mut client = client.lock().await;
        return db::sqlserver::list_linked_server_tables(&mut client, server, catalog, schema, filter, limit, offset)
            .await;
    }
    Ok(vec![])
}

// ---------------------------------------------------------------------------
// Doris / StarRocks multi-catalog federation.
//
// These engines expose external catalogs (iceberg, hive, jdbc, ...) alongside
// the native `internal` catalog via `SHOW CATALOGS`. The functions below browse
// a specific catalog's databases/tables and read table metadata using 3-part
// qualified names (`<catalog>.<database>.<table>`), which the engines accept
// directly. The native `internal` catalog continues to use the existing
// `list_databases_core` / `list_tables_core` paths.
// ---------------------------------------------------------------------------

/// `SHOW CATALOGS` → catalogs visible to the current user. Returns an empty
/// list when the connection pool is not a MySQL pool (Doris/StarRocks always
/// use the MySQL protocol, so this is a defensive no-op); the caller's
/// flat-sidebar fallback then renders the standard database list.
pub async fn list_doris_catalogs_core(state: &AppState, connection_id: &str) -> Result<Vec<db::CatalogInfo>, String> {
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, None, None).await?;
    let db_config = connection_config(state, connection_id).await;
    let connections = state.connections.read().await;
    if let Some(PoolKind::Mysql(p, _)) = connections.get(&pool_key) {
        return if db_config.as_ref().is_some_and(is_starrocks_config) {
            db::starrocks::list_catalogs(p).await
        } else {
            db::doris::list_catalogs(p).await
        };
    }
    Ok(vec![])
}

/// `SHOW DATABASES FROM <catalog>` → databases in the given catalog.
///
/// For `internal`, system databases are filtered (mirroring `list_databases_core`).
/// For external catalogs, permission errors degrade to an empty list (the user
/// asked that inaccessible catalogs simply not be shown).
pub async fn list_doris_catalog_databases_core(
    state: &AppState,
    connection_id: &str,
    catalog: &str,
) -> Result<Vec<db::DatabaseInfo>, String> {
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, None, None).await?;
    let db_config = connection_config(state, connection_id).await;
    let connections = state.connections.read().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;
    let PoolKind::Mysql(p, _) = pool else {
        return Ok(vec![]);
    };
    let databases = if db_config.as_ref().is_some_and(is_starrocks_config) {
        db::starrocks::list_catalog_databases(p, catalog).await
    } else {
        db::doris::list_catalog_databases(p, catalog).await
    };
    // External catalogs may reject `SHOW DATABASES FROM <catalog>` when the user
    // lacks permission — surface as an empty list rather than an error.
    let databases = match databases {
        Ok(databases) => databases,
        Err(error) => {
            log::warn!(
                "[schema][doris:list_catalog_databases] connection_id={} catalog={} error={}",
                connection_id,
                catalog,
                error
            );
            return Ok(vec![]);
        }
    };
    if catalog == "internal" || catalog.eq_ignore_ascii_case("default_catalog") {
        return Ok(filter_mysql_system_databases_for_config(databases, db_config.as_ref()));
    }
    Ok(databases)
}

/// `SHOW TABLES FROM <catalog>.<database>` → tables in an external catalog.
pub async fn list_doris_catalog_tables_core(
    state: &AppState,
    connection_id: &str,
    catalog: &str,
    database: &str,
    filter: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
    object_types: Option<&[String]>,
    table_name_filter: Option<&TableNameFilter>,
) -> Result<Vec<db::TableInfo>, String> {
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, None, None).await?;
    let db_config = connection_config(state, connection_id).await;
    let connections = state.connections.read().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;
    let PoolKind::Mysql(p, _) = pool else {
        return Ok(vec![]);
    };
    let tables = if db_config.as_ref().is_some_and(is_starrocks_config) {
        db::starrocks::list_catalog_tables(p, catalog, database).await
    } else {
        db::doris::list_catalog_tables(p, catalog, database).await
    }?;
    Ok(filter_table_infos(tables, filter, limit, offset, object_types, table_name_filter))
}

/// Columns of an external catalog table via `SHOW COLUMNS FROM <catalog>.<db>.<table>`.
pub async fn get_doris_catalog_columns_core(
    state: &AppState,
    connection_id: &str,
    catalog: &str,
    database: &str,
    table: &str,
) -> Result<Vec<db::ColumnInfo>, String> {
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, None, None).await?;
    let db_config = connection_config(state, connection_id).await;
    let connections = state.connections.read().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;
    let PoolKind::Mysql(p, _) = pool else {
        return Ok(vec![]);
    };
    let columns = if db_config.as_ref().is_some_and(is_starrocks_config) {
        db::starrocks::get_catalog_columns(p, catalog, database, table).await
    } else {
        db::doris::get_catalog_columns(p, catalog, database, table).await
    }?;
    Ok(deduplicate_column_infos(columns))
}

/// DDL for an external catalog table via `SHOW CREATE TABLE <catalog>.<db>.<table>`.
pub async fn get_doris_catalog_table_ddl_core(
    state: &AppState,
    connection_id: &str,
    catalog: &str,
    database: &str,
    table: &str,
) -> Result<String, String> {
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, None, None).await?;
    let db_config = connection_config(state, connection_id).await;
    let connections = state.connections.read().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;
    let PoolKind::Mysql(p, _) = pool else {
        return Err("DDL not supported for this connection".to_string());
    };
    if db_config.as_ref().is_some_and(is_starrocks_config) {
        db::starrocks::get_catalog_table_ddl(p, catalog, database, table).await
    } else {
        db::doris::get_catalog_table_ddl(p, catalog, database, table).await
    }
}

/// Best-effort index listing for an external catalog table (derived from DDL).
pub async fn list_doris_catalog_indexes_core(
    state: &AppState,
    connection_id: &str,
    catalog: &str,
    database: &str,
    table: &str,
) -> Result<Vec<db::IndexInfo>, String> {
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, None, None).await?;
    let db_config = connection_config(state, connection_id).await;
    let connections = state.connections.read().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;
    let PoolKind::Mysql(p, _) = pool else {
        return Ok(vec![]);
    };
    if db_config.as_ref().is_some_and(is_starrocks_config) {
        db::starrocks::list_catalog_indexes(p, catalog, database, table).await
    } else {
        db::doris::list_catalog_indexes(p, catalog, database, table).await
    }
}

/// Table comment for an external catalog table. Doris does not reliably expose
/// comments for external catalog tables, so this returns `None`.
pub async fn get_doris_catalog_table_comment_core(
    _state: &AppState,
    _connection_id: &str,
    _catalog: &str,
    _database: &str,
    _table: &str,
) -> Result<Option<String>, String> {
    Ok(None)
}

/// Foreign keys are not applicable to external catalog tables.
pub async fn list_doris_catalog_foreign_keys_core(
    _state: &AppState,
    _connection_id: &str,
    _catalog: &str,
    _database: &str,
    _table: &str,
) -> Result<Vec<db::ForeignKeyInfo>, String> {
    Ok(vec![])
}

/// Triggers are not applicable to external catalog tables.
pub async fn list_doris_catalog_triggers_core(
    _state: &AppState,
    _connection_id: &str,
    _catalog: &str,
    _database: &str,
    _table: &str,
) -> Result<Vec<db::TriggerInfo>, String> {
    Ok(vec![])
}

/// Resolve a non-internal catalog for dispatch to the Doris multi-catalog path.
/// Returns `Some(catalog)` only when `catalog` is a non-empty, non-`internal`
/// name and the connection is a Doris-family engine that supports
/// `SHOW CATALOGS`. Otherwise `None` (caller uses the default metadata path).
pub async fn resolve_external_doris_catalog(
    state: &AppState,
    connection_id: &str,
    catalog: Option<&str>,
) -> Option<String> {
    let catalog = catalog?.trim();
    if catalog.is_empty() || catalog.eq_ignore_ascii_case("internal") || catalog.eq_ignore_ascii_case("default_catalog")
    {
        return None;
    }
    let config = connection_config(state, connection_id).await?;
    if is_doris_family_catalog_capable_config(&config) {
        Some(catalog.to_string())
    } else {
        None
    }
}

async fn list_databases_once(state: &AppState, connection_id: &str) -> Result<Vec<db::DatabaseInfo>, String> {
    log::info!("[list_databases] connection_id={connection_id}");
    let db_config = connection_config(state, connection_id).await;
    {
        let connections = state.connections.read().await;
        if let Some(PoolKind::ExternalDriver { config, session, .. }) = connections.get(connection_id) {
            let config = config.clone();
            let session = session.clone();
            drop(connections);
            return session
                .invoke_with_timeout::<Vec<db::DatabaseInfo>>(
                    "listDatabases",
                    serde_json::json!({ "connection": config.as_ref() }),
                    agent_metadata_timeout(Some(config.as_ref())),
                )
                .await;
        }
        if let Some(client) = extract_pool!(&connections, connection_id, ClickHouse) {
            drop(connections);
            return db::clickhouse_driver::list_databases(&client).await;
        }
        if let Some(client) = extract_pool!(&connections, connection_id, InfluxDb) {
            drop(connections);
            return db::influxdb_driver::list_databases(&client).await;
        }
        if let Some(client) = extract_pool!(&connections, connection_id, VictoriaMetrics) {
            drop(connections);
            return db::victoriametrics_driver::list_databases(&client).await;
        }
        try_sqlserver!(connections, connection_id, list_databases);
        if let Some(client) = extract_pool!(&connections, connection_id, Agent) {
            let is_mongo =
                state.configs.read().await.get(connection_id).is_some_and(|c| c.db_type == DatabaseType::MongoDb);
            if is_mongo {
                drop(connections);
                let dbs = crate::mongo_ops::mongo_list_databases_core(state, connection_id).await?;
                return Ok(dbs.into_iter().map(|name| db::DatabaseInfo { name, ..Default::default() }).collect());
            }
            drop(connections);
            let mut client = client.lock().await;
            return client.list_databases(agent_metadata_timeout(db_config.as_ref())).await;
        }
    }

    let db_config = connection_config(state, connection_id).await;
    let connections = state.connections.read().await;
    let pool = connections.get(connection_id).ok_or("Connection not found")?;

    match pool {
        PoolKind::Mysql(p, mode)
            if *mode != MysqlMode::OceanBaseOracle && db_config.as_ref().is_some_and(db::dolt::is_config) =>
        {
            db::dolt::list_databases(p).await
        }
        PoolKind::Mysql(p, _) if db_config.as_ref().is_some_and(is_doris_family_config) => {
            db::mysql::list_databases_show(p)
                .await
                .map(|databases| filter_mysql_system_databases_for_config(databases, db_config.as_ref()))
        }
        PoolKind::Mysql(p, mode) => dispatch_mysql!(p, mode, db::mysql::list_databases, db::ob_oracle::list_databases),
        PoolKind::Postgres(p) => db::postgres::list_databases(p).await,
        PoolKind::Sqlite(p) => db::sqlite::list_databases(p).await,
        PoolKind::Rqlite(client) => db::rqlite_driver::list_databases(client).await,
        PoolKind::Turso(client) => db::turso_driver::list_databases(client).await,
        PoolKind::HBase(client) => db::hbase_driver::list_namespaces(client).await,
        #[cfg(feature = "duckdb-sidecar")]
        PoolKind::DuckDbWorker(client) => {
            let client = client.clone();
            drop(connections);
            client.list_databases().await
        }
        PoolKind::CloudflareD1(client) => db::cloudflare_d1_driver::list_databases(client).await,
        _ => Ok(vec![]),
    }
}

async fn list_database_metadata_once(state: &AppState, connection_id: &str) -> Result<Vec<db::DatabaseInfo>, String> {
    let config = connection_config(state, connection_id).await;
    if config.as_ref().is_some_and(|config| db::dolt::is_config(config) || is_doris_family_config(config)) {
        return list_databases_once(state, connection_id).await;
    }
    let connections = state.connections.read().await;
    if let Some(client) = extract_pool!(&connections, connection_id, SqlServer) {
        drop(connections);
        let mut client = client.lock().await;
        return db::sqlserver::list_database_metadata(&mut client).await;
    }
    if let Some(PoolKind::Mysql(pool, mode)) = connections.get(connection_id) {
        let pool = pool.clone();
        let mode = *mode;
        drop(connections);
        return if mode == MysqlMode::OceanBaseOracle {
            db::ob_oracle::list_databases(&pool).await
        } else {
            db::mysql::list_database_metadata(&pool).await
        };
    }
    if let Some(pool) = extract_pool!(&connections, connection_id, Postgres) {
        drop(connections);
        return db::postgres::list_database_metadata(&pool).await;
    }
    drop(connections);
    list_databases_once(state, connection_id).await
}

pub async fn list_schemas_core(state: &AppState, connection_id: &str, database: &str) -> Result<Vec<String>, String> {
    list_schemas_core_with_visible_filter(state, connection_id, database, false).await
}

pub async fn list_schemas_core_with_visible_filter(
    state: &AppState,
    connection_id: &str,
    database: &str,
    apply_visible_filter: bool,
) -> Result<Vec<String>, String> {
    retry_metadata_connection(state, connection_id, Some(database), || {
        list_schemas_once(state, connection_id, database, apply_visible_filter)
    })
    .await
}

pub async fn list_schema_infos_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
) -> Result<Vec<db::SchemaInfo>, String> {
    retry_metadata_connection(state, connection_id, Some(database), || {
        list_schema_infos_once(state, connection_id, database)
    })
    .await
}

async fn list_schema_infos_once(
    state: &AppState,
    connection_id: &str,
    database: &str,
) -> Result<Vec<db::SchemaInfo>, String> {
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
    let db_config = connection_config(state, connection_id).await;
    let show_system_schemas = db_config.as_ref().is_some_and(|config| config.show_system_schemas);
    {
        let connections = state.connections.read().await;
        if let Some(PoolKind::Postgres(pool)) = connections.get(&pool_key) {
            return db::postgres::list_schema_infos_with_system(pool, show_system_schemas).await;
        }
    }

    let schemas = list_schemas_once(state, connection_id, database, false).await?;
    Ok(schemas.into_iter().map(|name| db::SchemaInfo { name, comment: None }).collect())
}

pub async fn list_data_types_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
) -> Result<Vec<String>, String> {
    retry_metadata_connection(state, connection_id, Some(database), || async {
        let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
        let db_config = connection_config(state, connection_id).await;
        let connections = state.connections.read().await;
        if let Some(PoolKind::ExternalDriver { config, session, .. }) = connections.get(&pool_key) {
            let config = config.clone();
            let session = session.clone();
            drop(connections);
            return session
                .invoke_with_timeout::<Vec<String>>(
                    "listDataTypes",
                    serde_json::json!({ "connection": config.as_ref(), "database": database }),
                    agent_metadata_timeout(Some(config.as_ref())),
                )
                .await
                .map(deduplicate_data_type_names);
        }
        if let Some(client) = extract_pool!(&connections, &pool_key, Agent) {
            drop(connections);
            let mut client = client.lock().await;
            return client
                .list_data_types::<Vec<String>>(database, agent_metadata_timeout(db_config.as_ref()))
                .await
                .map(deduplicate_data_type_names);
        }
        Ok(Vec::new())
    })
    .await
}

fn deduplicate_data_type_names(names: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    for name in names {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            continue;
        }
        let key = trimmed.to_ascii_lowercase();
        if seen.insert(key) {
            result.push(trimmed.to_string());
        }
    }
    result
}

async fn list_schemas_once(
    state: &AppState,
    connection_id: &str,
    database: &str,
    apply_visible_filter: bool,
) -> Result<Vec<String>, String> {
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
    let db_config = connection_config(state, connection_id).await;
    let show_system_schemas = db_config.as_ref().is_some_and(|config| config.show_system_schemas);
    let visible_schema_filter = visible_schema_filter(db_config.as_ref(), database, apply_visible_filter);

    {
        let connections = state.connections.read().await;
        if let Some(PoolKind::ExternalDriver { config, session, .. }) = connections.get(&pool_key) {
            let config = config.clone();
            let session = session.clone();
            drop(connections);
            return session
                .invoke_with_timeout::<Vec<String>>(
                    "listSchemas",
                    serde_json::json!({ "connection": config.as_ref(), "database": database }),
                    agent_metadata_timeout(Some(config.as_ref())),
                )
                .await;
        }
        try_sqlserver!(connections, &pool_key, list_schemas);
        if let Some(client) = extract_pool!(&connections, &pool_key, Agent) {
            let fallback_config = db_config.clone();
            drop(connections);
            let mut client = client.lock().await;
            match client
                .list_schemas_filtered::<Vec<String>>(
                    database,
                    visible_schema_filter.as_deref(),
                    show_system_schemas,
                    agent_metadata_timeout(db_config.as_ref()),
                )
                .await
            {
                Ok(schemas) if !schemas.is_empty() => {
                    return Ok(filter_visible_schema_names(schemas, visible_schema_filter.as_deref()))
                }
                Ok(schemas) => {
                    if let Some(config) = fallback_config.as_ref() {
                        match native_postgres_metadata_pool(state, connection_id, database, config).await {
                            Ok(Some(pool)) => {
                                return db::postgres::list_schemas_with_system(&pool, show_system_schemas).await.map(
                                    |schemas| filter_visible_schema_names(schemas, visible_schema_filter.as_deref()),
                                )
                            }
                            Ok(None) => {
                                return Ok(filter_visible_schema_names(schemas, visible_schema_filter.as_deref()))
                            }
                            Err(error) => {
                                log::warn!(
                                    "[schema][agent:list_schemas:fallback-failed] connection_id={} database={} error={}",
                                    connection_id,
                                    database,
                                    error
                                );
                            }
                        }
                    }
                    return Ok(filter_visible_schema_names(schemas, visible_schema_filter.as_deref()));
                }
                Err(agent_error) => {
                    if let Some(config) = fallback_config.as_ref() {
                        if let Some(pool) =
                            native_postgres_metadata_pool(state, connection_id, database, config).await?
                        {
                            return db::postgres::list_schemas_with_system(&pool, show_system_schemas)
                                .await
                                .map(|schemas| filter_visible_schema_names(schemas, visible_schema_filter.as_deref()))
                                .map_err(|fallback_error| {
                                    crate::db::agent_driver::append_legacy_error_context(
                                        &agent_error,
                                        &format!("Native PostgreSQL metadata fallback failed: {fallback_error}"),
                                    )
                                });
                        }
                    }
                    return Err(agent_error);
                }
            }
        }
    }

    let connections = state.connections.read().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;

    match pool {
        PoolKind::Mysql(p, mode) if *mode == MysqlMode::OceanBaseOracle => db::ob_oracle::list_schemas(p)
            .await
            .map(|schemas| filter_visible_schema_names(schemas, visible_schema_filter.as_deref())),
        PoolKind::Postgres(p) => db::postgres::list_schemas_with_system(p, show_system_schemas)
            .await
            .map(|schemas| filter_visible_schema_names(schemas, visible_schema_filter.as_deref())),
        #[cfg(feature = "duckdb-sidecar")]
        PoolKind::DuckDbWorker(client) => {
            let client = client.clone();
            let database = database.to_string();
            drop(connections);
            client
                .list_schemas(database)
                .await
                .map(|schemas| filter_visible_schema_names(schemas, visible_schema_filter.as_deref()))
        }
        _ => Ok(vec![]),
    }
}

fn visible_schema_filter(
    config: Option<&ConnectionConfig>,
    database: &str,
    apply_visible_filter: bool,
) -> Option<Vec<String>> {
    if !apply_visible_filter {
        return None;
    }
    config?.visible_schemas.as_ref()?.get(database).cloned()
}

fn filter_visible_schema_names(schemas: Vec<String>, visible: Option<&[String]>) -> Vec<String> {
    let Some(visible) = visible else {
        return schemas;
    };
    let visible: std::collections::HashSet<&str> = visible.iter().map(String::as_str).collect();
    schemas.into_iter().filter(|schema| visible.contains(schema.as_str())).collect()
}

pub async fn list_tables_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    filter: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
    object_types: Option<&[String]>,
    table_name_filter: Option<&TableNameFilter>,
) -> Result<Vec<db::TableInfo>, String> {
    let metadata_session = EphemeralAgentMetadataSession::open(state, connection_id, Some(database), "tables").await;
    let result = retry_metadata_connection_for_session(
        state,
        connection_id,
        Some(database),
        metadata_session.client_session_id(),
        || {
            list_tables_once(
                state,
                connection_id,
                database,
                schema,
                filter,
                limit,
                offset,
                object_types,
                table_name_filter,
                metadata_session.client_session_id(),
            )
        },
    )
    .await;
    metadata_session.finish(state, connection_id, Some(database)).await;
    result
}

/// List vector database collections, returning structured info (name, id, dimension).
/// Only works for PoolKind::VectorDb connections; returns an error for other types.
pub async fn list_vector_collections_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
) -> Result<Vec<db::vector_driver::CollectionInfo>, String> {
    let pool_key = state
        .get_or_create_metadata_pool_for_session(
            connection_id,
            if database.is_empty() { None } else { Some(database) },
            None,
        )
        .await?;
    let client = {
        let connections = state.connections.read().await;
        match connections.get(&pool_key) {
            Some(PoolKind::VectorDb(client)) => client.clone(),
            _ => return Err("Not a vector database connection".to_string()),
        }
    };
    db::vector_driver::list_collections_with_db(&client, database).await
}

/// Get detailed metadata for a single vector collection (dimension, config, etc).
pub async fn get_vector_collection_detail_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
) -> Result<db::vector_driver::CollectionInfo, String> {
    let pool_key = state
        .get_or_create_metadata_pool_for_session(
            connection_id,
            if database.is_empty() { None } else { Some(database) },
            None,
        )
        .await?;
    let client = {
        let connections = state.connections.read().await;
        match connections.get(&pool_key) {
            Some(PoolKind::VectorDb(client)) => client.clone(),
            _ => return Err("Not a vector database connection".to_string()),
        }
    };
    db::vector_driver::get_collection_detail(&client, database, collection).await
}

pub async fn get_table_comment_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<Option<String>, String> {
    if crate::sql_dialect::parse_sqlserver_linked_schema_ref(schema).is_some() {
        return Err("Table comments are not available for linked server tables".to_string());
    }

    let metadata_session =
        EphemeralAgentMetadataSession::open(state, connection_id, Some(database), "table-comment").await;
    let result = get_table_comment_core_for_session(
        state,
        connection_id,
        database,
        schema,
        table,
        metadata_session.client_session_id(),
    )
    .await;
    metadata_session.finish(state, connection_id, Some(database)).await;
    result
}

async fn get_table_comment_core_for_session(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
    client_session_id: Option<&str>,
) -> Result<Option<String>, String> {
    retry_metadata_connection_for_session(state, connection_id, Some(database), client_session_id, || async {
        let pool_key =
            state.get_or_create_metadata_pool_for_session(connection_id, Some(database), client_session_id).await?;
        let db_config = connection_config(state, connection_id).await;

        {
            let connections = state.connections.read().await;
            try_sqlserver!(connections, &pool_key, get_table_comment, schema, table);
            if let Some(client) = extract_pool!(&connections, &pool_key, Agent) {
                if db_config.as_ref().is_some_and(|config| {
                    matches!(config.db_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle)
                }) {
                    let sql = oracle_table_comment_sql(schema, table);
                    let timeout = agent_metadata_timeout(db_config.as_ref());
                    drop(connections);
                    let mut client = client.lock().await;
                    let result = client
                        .execute_query_with_timeout::<db::QueryResult>(
                            agent_execute_query_params(
                                &sql,
                                Some(database),
                                Some(schema),
                                QueryExecutionOptions { max_rows: Some(1), ..Default::default() },
                            ),
                            timeout,
                        )
                        .await?;
                    return oracle_table_comment_from_query_result(result);
                }
                if db_config.as_ref().is_some_and(|config| config.db_type == DatabaseType::Kingbase) {
                    let timeout = agent_metadata_timeout(db_config.as_ref());
                    drop(connections);
                    let mut client = client.lock().await;
                    return client.get_table_comment::<Option<String>>(database, schema, table, timeout).await;
                }
                if db_config.as_ref().is_some_and(|config| config.db_type == DatabaseType::Tdengine) {
                    let metadata_database = if schema.trim().is_empty() { database } else { schema };
                    let sql = tdengine_table_comment_sql(metadata_database, table);
                    let timeout = agent_metadata_timeout(db_config.as_ref());
                    drop(connections);
                    let mut client = client.lock().await;
                    let result = client
                        .execute_query_with_timeout::<db::QueryResult>(
                            agent_execute_query_params(
                                &sql,
                                Some(database),
                                (!schema.trim().is_empty()).then_some(schema),
                                QueryExecutionOptions { max_rows: Some(2), ..Default::default() },
                            ),
                            timeout,
                        )
                        .await?;
                    return oracle_table_comment_from_query_result(result);
                }
            }
        }

        let connections = state.connections.read().await;
        let pool = connections.get(&pool_key).ok_or("Pool not found")?;

        match pool {
            PoolKind::Mysql(p, mode)
                if *mode != MysqlMode::OceanBaseOracle
                    && !db_config.as_ref().is_some_and(is_doris_family_config)
                    && !db_config.as_ref().is_some_and(is_manticoresearch_config) =>
            {
                db::mysql::get_table_comment(p, database, table).await
            }
            PoolKind::Postgres(p) if !db_config.as_ref().is_some_and(is_questdb_config) => {
                db::postgres::get_table_comment(p, schema, table).await
            }
            _ => Err("Table comment lookup is not supported for this connection".to_string()),
        }
    })
    .await
}

fn oracle_table_comment_sql(schema: &str, table: &str) -> String {
    format!(
        "SELECT COMMENTS FROM ALL_TAB_COMMENTS WHERE OWNER = {} AND TABLE_NAME = {} AND TABLE_TYPE IN ('TABLE', 'VIEW')",
        sql_string(schema),
        sql_string(table),
    )
}

fn tdengine_table_comment_sql(database: &str, table: &str) -> String {
    format!(
        "SELECT table_comment FROM information_schema.ins_stables WHERE db_name = {} AND stable_name = {} \
         UNION ALL SELECT table_comment FROM information_schema.ins_tables WHERE db_name = {} AND table_name = {}",
        sql_string(database),
        sql_string(table),
        sql_string(database),
        sql_string(table),
    )
}

fn tdengine_table_comments_sql(database: &str, filter: &str) -> String {
    let pattern = tdengine_table_comment_like_pattern(filter);
    format!(
        "SELECT stable_name, table_comment FROM information_schema.ins_stables \
         WHERE db_name = {database} AND table_comment IS NOT NULL AND LOWER(table_comment) LIKE {pattern} \
         UNION ALL SELECT table_name, table_comment FROM information_schema.ins_tables \
         WHERE db_name = {database} AND table_comment IS NOT NULL AND LOWER(table_comment) LIKE {pattern}",
        database = sql_string(database),
        pattern = sql_string(&pattern),
    )
}

fn tdengine_table_comment_like_pattern(filter: &str) -> String {
    let normalized_filter = filter.trim().to_lowercase();
    if normalized_filter.is_empty() {
        return "%%".to_string();
    }

    let mut pattern = String::with_capacity(TDENGINE_LIKE_PATTERN_MAX_BYTES);
    pattern.push('%');
    for ch in normalized_filter.chars() {
        let fragment = match ch {
            '\\' | '%' | '_' => format!("\\{ch}"),
            _ => ch.to_string(),
        };
        if pattern.len() + fragment.len() + 1 > TDENGINE_LIKE_PATTERN_MAX_BYTES {
            break;
        }
        pattern.push_str(&fragment);
        pattern.push('%');
    }
    pattern
}

fn tdengine_table_comment_cache_key(database: &str, schema: &str, filter: &str) -> String {
    serde_json::json!([database, schema, filter.trim().to_lowercase()]).to_string()
}

fn oracle_table_comment_from_query_result(result: db::QueryResult) -> Result<Option<String>, String> {
    Ok(result
        .rows
        .first()
        .and_then(|row| row.iter().find_map(|value| value.as_str().map(str::to_string)))
        .filter(|value| !value.trim().is_empty()))
}

fn oracle_table_comments_sql(schema: &str, table_names: &[String]) -> Option<String> {
    if table_names.is_empty() {
        return None;
    }
    let names = table_names.iter().map(|name| sql_string(name)).collect::<Vec<_>>().join(", ");
    Some(format!(
        "SELECT TABLE_NAME, COMMENTS FROM ALL_TAB_COMMENTS WHERE OWNER = {} AND TABLE_NAME IN ({}) AND TABLE_TYPE IN ('TABLE', 'VIEW') AND COMMENTS IS NOT NULL",
        oracle_owner_filter(schema),
        names,
    ))
}

fn table_comments_from_query_result(result: db::QueryResult) -> HashMap<String, String> {
    result
        .rows
        .into_iter()
        .filter_map(|row| {
            let name = row.first()?.as_str()?.to_string();
            let comment = row.get(1)?.as_str()?.trim().to_string();
            (!name.is_empty() && !comment.is_empty()).then_some((name, comment))
        })
        .collect()
}

fn oracle_columns_sql(schema: &str, table: &str) -> String {
    let owner = oracle_columns_owner_filter(schema);
    format!(
        "WITH synonym_chain AS ( \
           SELECT CONNECT_BY_ROOT s.OWNER AS root_owner, \
                  s.TABLE_OWNER AS resolved_owner, \
                  s.TABLE_NAME AS resolved_table, \
                  LEVEL AS synonym_depth \
           FROM ALL_SYNONYMS s \
           START WITH s.SYNONYM_NAME = {table} \
             AND s.OWNER IN ({owner}, 'PUBLIC') \
             AND s.DB_LINK IS NULL \
           CONNECT BY NOCYCLE \
             PRIOR s.TABLE_OWNER = s.OWNER \
             AND PRIOR s.TABLE_NAME = s.SYNONYM_NAME \
             AND s.DB_LINK IS NULL \
         ), \
         resolved_object AS ( \
           SELECT resolved_owner, resolved_table \
           FROM ( \
             SELECT resolved_owner, resolved_table, resolution_priority, synonym_depth \
             FROM ( \
               SELECT o.OWNER AS resolved_owner, o.OBJECT_NAME AS resolved_table, \
                      0 AS resolution_priority, 0 AS synonym_depth \
               FROM ALL_OBJECTS o \
               WHERE o.OWNER = {owner} \
                 AND o.OBJECT_NAME = {table} \
                 AND o.OBJECT_TYPE IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW') \
               UNION ALL \
               SELECT sc.resolved_owner, sc.resolved_table, \
                      CASE WHEN sc.root_owner = {owner} THEN 1 ELSE 2 END AS resolution_priority, \
                      sc.synonym_depth \
               FROM synonym_chain sc \
               JOIN ALL_OBJECTS o \
                 ON o.OWNER = sc.resolved_owner \
                AND o.OBJECT_NAME = sc.resolved_table \
                AND o.OBJECT_TYPE IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW') \
             ) \
             ORDER BY resolution_priority, synonym_depth \
           ) \
           WHERE ROWNUM = 1 \
         ) \
         SELECT c.COLUMN_NAME, c.DATA_TYPE, c.NULLABLE, c.DATA_DEFAULT, \
         c.DATA_LENGTH, c.DATA_PRECISION, c.DATA_SCALE, c.COLUMN_ID, \
         CASE WHEN EXISTS ( \
           SELECT 1 \
           FROM ALL_CONS_COLUMNS cols \
           JOIN ALL_CONSTRAINTS con \
             ON con.OWNER = cols.OWNER \
            AND con.CONSTRAINT_NAME = cols.CONSTRAINT_NAME \
            AND con.CONSTRAINT_TYPE = 'P' \
           WHERE cols.OWNER = c.OWNER \
             AND cols.TABLE_NAME = c.TABLE_NAME \
             AND cols.COLUMN_NAME = c.COLUMN_NAME \
         ) THEN 1 ELSE 0 END AS IS_PK, \
         ( \
           SELECT cm.COMMENTS \
           FROM ALL_COL_COMMENTS cm \
           WHERE cm.OWNER = c.OWNER \
             AND cm.TABLE_NAME = c.TABLE_NAME \
             AND cm.COLUMN_NAME = c.COLUMN_NAME \
         ) AS COMMENTS \
         FROM ALL_TAB_COLUMNS c \
         JOIN resolved_object ro \
           ON ro.resolved_owner = c.OWNER AND ro.resolved_table = c.TABLE_NAME \
         ORDER BY c.COLUMN_ID",
        table = sql_string(table),
    )
}

fn oracle_columns_owner_filter(schema: &str) -> String {
    let schema = schema.trim();
    if schema.is_empty() {
        "SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')".to_string()
    } else {
        sql_string(&schema.to_uppercase())
    }
}

fn oracle_column_type(data_type: &str, precision: Option<i32>, scale: Option<i32>, length: Option<i32>) -> String {
    match data_type.to_ascii_uppercase().as_str() {
        "NUMBER" => match (precision, scale) {
            (Some(precision), Some(scale)) if scale > 0 => format!("NUMBER({precision},{scale})"),
            (Some(precision), _) => format!("NUMBER({precision})"),
            _ => "NUMBER".to_string(),
        },
        "VARCHAR2" | "NVARCHAR2" | "CHAR" | "NCHAR" | "RAW" => match length {
            Some(length) => format!("{data_type}({length})"),
            None => data_type.to_string(),
        },
        _ => data_type.to_string(),
    }
}

fn oracle_columns_from_query_result(result: db::QueryResult) -> Vec<db::ColumnInfo> {
    result
        .rows
        .into_iter()
        .filter_map(|row| {
            let name = query_result_cell_string(&row, 0)?;
            let data_type = query_result_cell_string(&row, 1).unwrap_or_default();
            let nullable = query_result_cell_string(&row, 2).unwrap_or_default();
            let default_value = query_result_cell_string(&row, 3)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            let length = query_result_cell_i64(&row, 4).and_then(|value| i32::try_from(value).ok());
            let precision = query_result_cell_i64(&row, 5).and_then(|value| i32::try_from(value).ok());
            let scale = query_result_cell_i64(&row, 6).and_then(|value| i32::try_from(value).ok());
            let is_primary_key = query_result_cell_i64(&row, 8).unwrap_or(0) == 1;
            let comment = query_result_cell_string(&row, 9).filter(|value| !value.trim().is_empty());
            Some(db::ColumnInfo {
                name,
                data_type: oracle_column_type(&data_type, precision, scale, length),
                is_nullable: nullable == "Y",
                column_default: default_value,
                is_primary_key,
                extra: None,
                comment,
                numeric_precision: precision,
                numeric_scale: scale,
                character_maximum_length: length,
                enum_values: None,
                ..Default::default()
            })
        })
        .collect()
}

async fn oracle_columns_via_sql(
    database: &str,
    schema: &str,
    table: &str,
    client: &mut db::agent_driver::AgentDriverClient,
    timeout_duration: Option<Duration>,
) -> Result<Vec<db::ColumnInfo>, String> {
    let sql = oracle_columns_sql(schema, table);
    let result = client
        .execute_query_with_timeout::<db::QueryResult>(
            agent_execute_query_params(
                &sql,
                if database.is_empty() { None } else { Some(database) },
                if schema.is_empty() { None } else { Some(schema) },
                QueryExecutionOptions { max_rows: Some(10_000), ..Default::default() },
            ),
            timeout_duration,
        )
        .await?;
    Ok(deduplicate_column_infos(oracle_columns_from_query_result(result)))
}

async fn external_driver_oracle_columns_via_sql(
    session: Arc<crate::plugins::PluginDriverSession>,
    config: &ConnectionConfig,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<db::ColumnInfo>, String> {
    let result: db::QueryResult = session
        .invoke_with_timeout(
            "executeQuery",
            serde_json::json!({
                "connection": config,
                "database": database,
                "schema": schema,
                "sql": oracle_columns_sql(schema, table),
                "maxRows": 10_000
            }),
            agent_metadata_timeout(Some(config)),
        )
        .await?;
    Ok(deduplicate_column_infos(oracle_columns_from_query_result(result)))
}

fn should_query_oracle_columns_via_sql_first(
    db_type: &DatabaseType,
    schema: &str,
    client_session_id: Option<&str>,
) -> bool {
    *db_type == DatabaseType::Oracle
        && schema.trim().is_empty()
        && client_session_id.is_some_and(|session_id| !session_id.trim().is_empty())
}

fn oracle_object_statistics_sql(schema: &str) -> String {
    oracle_object_statistics_owner_segments_sql(schema, "ALL_SEGMENTS")
}

fn oracle_object_statistics_dba_segments_sql(schema: &str) -> String {
    oracle_object_statistics_owner_segments_sql(schema, "DBA_SEGMENTS")
}

fn oracle_object_statistics_owner_segments_sql(schema: &str, segment_view: &str) -> String {
    format!(
        "SELECT t.TABLE_NAME, t.OWNER, t.NUM_ROWS, NVL(s.BYTES, 0) AS TOTAL_BYTES \
         FROM ALL_TABLES t \
         LEFT JOIN ( \
           SELECT owner, table_name, SUM(bytes) AS BYTES \
           FROM ( \
             SELECT s.OWNER, s.SEGMENT_NAME AS TABLE_NAME, s.BYTES \
             FROM {segment_view} s \
             WHERE s.OWNER = {} AND s.SEGMENT_TYPE IN ('TABLE','TABLE PARTITION','TABLE SUBPARTITION') \
             UNION ALL \
             SELECT i.TABLE_OWNER AS OWNER, i.TABLE_NAME, s.BYTES \
             FROM ALL_INDEXES i \
             JOIN {segment_view} s ON s.OWNER = i.OWNER AND s.SEGMENT_NAME = i.INDEX_NAME \
             WHERE i.TABLE_OWNER = {} AND s.SEGMENT_TYPE IN ('INDEX','INDEX PARTITION','INDEX SUBPARTITION') \
             UNION ALL \
             SELECT l.OWNER, l.TABLE_NAME, s.BYTES \
             FROM ALL_LOBS l \
             JOIN {segment_view} s ON s.OWNER = l.OWNER AND s.SEGMENT_NAME IN (l.SEGMENT_NAME, l.INDEX_NAME) \
             WHERE l.OWNER = {} AND s.SEGMENT_TYPE IN ('LOBSEGMENT','LOB PARTITION','LOB SUBPARTITION','LOBINDEX') \
           ) \
           GROUP BY owner, table_name \
         ) s ON s.OWNER = t.OWNER AND s.TABLE_NAME = t.TABLE_NAME \
         WHERE t.OWNER = {} AND t.NESTED = 'NO' \
         ORDER BY t.TABLE_NAME",
        oracle_owner_filter(schema),
        oracle_owner_filter(schema),
        oracle_owner_filter(schema),
        oracle_owner_filter(schema),
    )
}

fn oracle_object_statistics_user_segments_sql(schema: &str) -> String {
    // USER_SEGMENTS exposes objects owned by the login/current user, while DBX
    // may switch CURRENT_SCHEMA before metadata queries for cross-schema browsing.
    format!(
        "SELECT t.TABLE_NAME, t.OWNER, t.NUM_ROWS, NVL(s.BYTES, 0) AS TOTAL_BYTES \
         FROM ALL_TABLES t \
         LEFT JOIN ( \
           SELECT table_name, SUM(bytes) AS BYTES \
           FROM ( \
             SELECT s.SEGMENT_NAME AS TABLE_NAME, s.BYTES \
             FROM USER_SEGMENTS s \
             WHERE s.SEGMENT_TYPE IN ('TABLE','TABLE PARTITION','TABLE SUBPARTITION') \
             UNION ALL \
             SELECT i.TABLE_NAME, s.BYTES \
             FROM ALL_INDEXES i \
             JOIN USER_SEGMENTS s ON s.SEGMENT_NAME = i.INDEX_NAME \
             WHERE i.TABLE_OWNER = {} AND s.SEGMENT_TYPE IN ('INDEX','INDEX PARTITION','INDEX SUBPARTITION') \
             UNION ALL \
             SELECT l.TABLE_NAME, s.BYTES \
             FROM ALL_LOBS l \
             JOIN USER_SEGMENTS s ON s.SEGMENT_NAME IN (l.SEGMENT_NAME, l.INDEX_NAME) \
             WHERE l.OWNER = {} AND s.SEGMENT_TYPE IN ('LOBSEGMENT','LOB PARTITION','LOB SUBPARTITION','LOBINDEX') \
           ) \
           GROUP BY table_name \
         ) s ON s.TABLE_NAME = t.TABLE_NAME \
         WHERE t.OWNER = {} AND t.OWNER = USER AND t.NESTED = 'NO' \
         ORDER BY t.TABLE_NAME",
        oracle_owner_filter(schema),
        oracle_owner_filter(schema),
        oracle_owner_filter(schema),
    )
}

fn oracle_object_statistics_rows_only_sql(schema: &str) -> String {
    format!(
        "SELECT t.TABLE_NAME, t.OWNER, t.NUM_ROWS, CAST(NULL AS NUMBER) AS TOTAL_BYTES \
         FROM ALL_TABLES t \
         WHERE t.OWNER = {} AND t.NESTED = 'NO' \
         ORDER BY t.TABLE_NAME",
        oracle_owner_filter(schema),
    )
}

fn dameng_object_statistics_dba_segments_sql(schema: &str) -> String {
    format!(
        "SELECT t.TABLE_NAME, t.OWNER, t.NUM_ROWS, NVL(s.BYTES, 0) AS TOTAL_BYTES \
         FROM ALL_TABLES t \
         LEFT JOIN ( \
           SELECT owner, table_name, SUM(bytes) AS BYTES \
           FROM ( \
             SELECT s.OWNER, s.SEGMENT_NAME AS TABLE_NAME, s.BYTES \
             FROM DBA_SEGMENTS s \
             WHERE s.OWNER = {} AND s.SEGMENT_TYPE IN ('TABLE','TABLE PARTITION','TABLE SUBPARTITION') \
             UNION ALL \
             SELECT i.TABLE_OWNER AS OWNER, i.TABLE_NAME, s.BYTES \
             FROM ALL_INDEXES i \
             JOIN DBA_SEGMENTS s ON s.OWNER = i.OWNER AND s.SEGMENT_NAME = i.INDEX_NAME \
             WHERE i.TABLE_OWNER = {} AND s.SEGMENT_TYPE IN ('INDEX','INDEX PARTITION','INDEX SUBPARTITION') \
           ) \
           GROUP BY owner, table_name \
         ) s ON s.OWNER = t.OWNER AND s.TABLE_NAME = t.TABLE_NAME \
         WHERE t.OWNER = {} AND (t.NESTED IS NULL OR t.NESTED = 'NO') \
         ORDER BY t.TABLE_NAME",
        oracle_owner_filter(schema),
        oracle_owner_filter(schema),
        oracle_owner_filter(schema),
    )
}

fn dameng_object_statistics_user_segments_sql(schema: &str) -> String {
    format!(
        "SELECT t.TABLE_NAME, t.OWNER, t.NUM_ROWS, NVL(s.BYTES, 0) AS TOTAL_BYTES \
         FROM ALL_TABLES t \
         LEFT JOIN ( \
           SELECT table_name, SUM(bytes) AS BYTES \
           FROM ( \
             SELECT s.SEGMENT_NAME AS TABLE_NAME, s.BYTES \
             FROM USER_SEGMENTS s \
             WHERE s.SEGMENT_TYPE IN ('TABLE','TABLE PARTITION','TABLE SUBPARTITION') \
             UNION ALL \
             SELECT i.TABLE_NAME, s.BYTES \
             FROM ALL_INDEXES i \
             JOIN USER_SEGMENTS s ON s.SEGMENT_NAME = i.INDEX_NAME \
             WHERE i.TABLE_OWNER = {} AND s.SEGMENT_TYPE IN ('INDEX','INDEX PARTITION','INDEX SUBPARTITION') \
           ) \
           GROUP BY table_name \
         ) s ON s.TABLE_NAME = t.TABLE_NAME \
         WHERE t.OWNER = {} AND t.OWNER = USER AND (t.NESTED IS NULL OR t.NESTED = 'NO') \
         ORDER BY t.TABLE_NAME",
        oracle_owner_filter(schema),
        oracle_owner_filter(schema),
    )
}

fn dameng_object_statistics_rows_only_sql(schema: &str) -> String {
    format!(
        "SELECT t.TABLE_NAME, t.OWNER, t.NUM_ROWS, CAST(NULL AS NUMBER) AS TOTAL_BYTES \
         FROM ALL_TABLES t \
         WHERE t.OWNER = {} AND (t.NESTED IS NULL OR t.NESTED = 'NO') \
         ORDER BY t.TABLE_NAME",
        oracle_owner_filter(schema),
    )
}

fn gbase8a_object_statistics_sql(database: &str) -> String {
    format!(
        "SELECT TABLE_NAME, TABLE_SCHEMA, TABLE_ROWS, \
                COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) AS TOTAL_BYTES \
         FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = {} AND TABLE_TYPE <> 'VIEW' \
         ORDER BY TABLE_NAME",
        sql_string(database),
    )
}

fn query_result_cell_i64(row: &[serde_json::Value], index: usize) -> Option<i64> {
    let value = row.get(index)?;
    if value.is_null() {
        return None;
    }
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
        .or_else(|| value.as_f64().map(|value| value as i64))
        .or_else(|| value.as_str()?.trim().parse::<i64>().ok())
}

fn oracle_object_statistics_from_query_result(result: db::QueryResult) -> Vec<db::ObjectStatistics> {
    result
        .rows
        .into_iter()
        .filter_map(|row| {
            let name = query_result_cell_string(&row, 0)?;
            if name.trim().is_empty() {
                return None;
            }
            Some(db::ObjectStatistics {
                name,
                schema: query_result_cell_string(&row, 1),
                estimated_rows: query_result_cell_i64(&row, 2),
                total_bytes: query_result_cell_i64(&row, 3),
            })
        })
        .collect()
}

fn comment_is_blank(comment: &Option<String>) -> bool {
    comment.as_deref().map(str::trim).unwrap_or("").is_empty()
}

fn oracle_table_info_can_have_comment(table: &db::TableInfo) -> bool {
    oracle_type_is_table_or_view(&table.table_type)
}

fn oracle_object_info_can_have_table_comment(object: &db::ObjectInfo) -> bool {
    oracle_type_is_table_or_view(&object.object_type)
}

fn oracle_type_is_table_or_view(value: &str) -> bool {
    let normalized = value.to_ascii_uppercase().replace([' ', '-'], "_");
    matches!(normalized.as_str(), "TABLE" | "BASE_TABLE" | "VIEW")
}

fn oracle_missing_table_comment_names(tables: &[db::TableInfo]) -> Vec<String> {
    unique_oracle_comment_names(
        tables
            .iter()
            .filter(|table| oracle_table_info_can_have_comment(table) && comment_is_blank(&table.comment))
            .map(|table| table.name.as_str()),
    )
}

fn oracle_missing_object_table_comment_names(objects: &[db::ObjectInfo]) -> Vec<String> {
    unique_oracle_comment_names(
        objects
            .iter()
            .filter(|object| oracle_object_info_can_have_table_comment(object) && comment_is_blank(&object.comment))
            .map(|object| object.name.as_str()),
    )
}

fn unique_oracle_comment_names<'a>(names: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut unique = Vec::new();
    for name in names {
        let name = name.trim();
        if name.is_empty() || !seen.insert(name.to_string()) {
            continue;
        }
        unique.push(name.to_string());
    }
    unique
}

fn apply_table_comments(tables: &mut [db::TableInfo], comments: &HashMap<String, String>) {
    for table in tables {
        if !comment_is_blank(&table.comment) {
            continue;
        }
        if let Some(comment) = oracle_comment_for_name(comments, &table.name) {
            table.comment = Some(comment.clone());
        }
    }
}

fn apply_oracle_object_table_comments(objects: &mut [db::ObjectInfo], comments: &HashMap<String, String>) {
    for object in objects {
        if !comment_is_blank(&object.comment) {
            continue;
        }
        if let Some(comment) = oracle_comment_for_name(comments, &object.name) {
            object.comment = Some(comment.clone());
        }
    }
}

fn oracle_comment_for_name<'a>(comments: &'a HashMap<String, String>, name: &str) -> Option<&'a String> {
    comments
        .get(name)
        .or_else(|| comments.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value))
}

async fn oracle_table_comments_for_names(
    client: &mut db::agent_driver::AgentDriverClient,
    database: &str,
    schema: &str,
    table_names: &[String],
    timeout_duration: Option<Duration>,
) -> Result<HashMap<String, String>, String> {
    let mut comments = HashMap::new();
    for chunk in table_names.chunks(ORACLE_TABLE_COMMENT_BATCH_SIZE) {
        let Some(sql) = oracle_table_comments_sql(schema, chunk) else {
            continue;
        };
        let result = client
            .execute_query_with_timeout::<db::QueryResult>(
                agent_execute_query_params(
                    &sql,
                    if database.is_empty() { None } else { Some(database) },
                    if schema.is_empty() { None } else { Some(schema) },
                    QueryExecutionOptions { max_rows: Some(chunk.len()), ..Default::default() },
                ),
                timeout_duration,
            )
            .await?;
        comments.extend(table_comments_from_query_result(result));
    }
    Ok(comments)
}

async fn load_oracle_table_comments_for_tables(
    client: &mut db::agent_driver::AgentDriverClient,
    database: &str,
    schema: &str,
    tables: &mut [db::TableInfo],
    timeout_duration: Option<Duration>,
) -> Result<(), String> {
    let table_names = oracle_missing_table_comment_names(tables);
    if table_names.is_empty() {
        return Ok(());
    }
    let comments = oracle_table_comments_for_names(client, database, schema, &table_names, timeout_duration).await?;
    apply_table_comments(tables, &comments);
    Ok(())
}

async fn load_tdengine_table_comments_for_filter(
    client: &mut db::agent_driver::AgentDriverClient,
    database: &str,
    schema: &str,
    filter: &str,
    tables: &mut [db::TableInfo],
) -> Result<(), String> {
    let metadata_database = if schema.trim().is_empty() { database } else { schema };
    let sql = tdengine_table_comments_sql(metadata_database, filter);
    let cache_key = tdengine_table_comment_cache_key(database, schema, filter);
    let result = client
        .execute_query_cached_with_timeout::<db::QueryResult>(
            cache_key,
            TDENGINE_COMMENT_SEARCH_CACHE_TTL,
            agent_execute_query_params(
                &sql,
                if database.is_empty() { None } else { Some(database) },
                if schema.is_empty() { None } else { Some(schema) },
                QueryExecutionOptions::default(),
            ),
            Some(TDENGINE_COMMENT_SEARCH_TIMEOUT),
        )
        .await?;
    let comments = table_comments_from_query_result(result);
    apply_table_comments(tables, &comments);
    Ok(())
}

async fn load_oracle_table_comments_for_objects(
    client: &mut db::agent_driver::AgentDriverClient,
    database: &str,
    schema: &str,
    objects: &mut [db::ObjectInfo],
    timeout_duration: Option<Duration>,
) -> Result<(), String> {
    let table_names = oracle_missing_object_table_comment_names(objects);
    if table_names.is_empty() {
        return Ok(());
    }
    let comments = oracle_table_comments_for_names(client, database, schema, &table_names, timeout_duration).await?;
    apply_oracle_object_table_comments(objects, &comments);
    Ok(())
}

async fn oracle_agent_list_object_statistics(
    client: Arc<db::agent_driver::PooledAgentClient>,
    database: &str,
    schema: &str,
    timeout_duration: Option<Duration>,
) -> Result<Vec<db::ObjectStatistics>, String> {
    let mut client = client.lock().await;
    let queries = [
        ("all-segments", oracle_object_statistics_sql(schema), true),
        ("dba-segments", oracle_object_statistics_dba_segments_sql(schema), true),
        ("user-segments", oracle_object_statistics_user_segments_sql(schema), false),
        ("rows-only", oracle_object_statistics_rows_only_sql(schema), true),
    ];
    let mut last_error = None;
    for (source, sql, accept_empty) in queries {
        match agent_object_statistics_query(&mut client, database, schema, &sql, timeout_duration).await {
            Ok(result) if accept_empty || !result.rows.is_empty() => {
                return Ok(oracle_object_statistics_from_query_result(result));
            }
            Ok(_) => {
                log::debug!(
                    "[schema][oracle:list_object_statistics:empty-fallback] schema={} source={}",
                    schema,
                    source
                );
            }
            Err(error) => {
                log::debug!(
                    "[schema][oracle:list_object_statistics:fallback-failed] schema={} source={} error={}",
                    schema,
                    source,
                    error
                );
                last_error = Some(error);
            }
        }
    }
    Err(last_error.unwrap_or_else(|| "Oracle object statistics are unavailable".to_string()))
}

async fn dameng_agent_list_object_statistics(
    client: Arc<db::agent_driver::PooledAgentClient>,
    database: &str,
    schema: &str,
    timeout_duration: Option<Duration>,
) -> Result<Vec<db::ObjectStatistics>, String> {
    let mut client = client.lock().await;
    let queries = [
        ("dba-segments", dameng_object_statistics_dba_segments_sql(schema), true),
        ("user-segments", dameng_object_statistics_user_segments_sql(schema), false),
        ("rows-only", dameng_object_statistics_rows_only_sql(schema), true),
    ];
    let mut last_error = None;
    for (source, sql, accept_empty) in queries {
        match agent_object_statistics_query(&mut client, database, schema, &sql, timeout_duration).await {
            Ok(result) if accept_empty || !result.rows.is_empty() => {
                return Ok(oracle_object_statistics_from_query_result(result));
            }
            Ok(_) => {
                log::debug!(
                    "[schema][dameng:list_object_statistics:empty-fallback] schema={} source={}",
                    schema,
                    source
                );
            }
            Err(error) => {
                log::debug!(
                    "[schema][dameng:list_object_statistics:fallback-failed] schema={} source={} error={}",
                    schema,
                    source,
                    error
                );
                last_error = Some(error);
            }
        }
    }
    Err(last_error.unwrap_or_else(|| "Dameng object statistics are unavailable".to_string()))
}

async fn agent_list_object_statistics(
    client: Arc<db::agent_driver::PooledAgentClient>,
    database: &str,
    schema: &str,
    sql: String,
    timeout_duration: Option<Duration>,
) -> Result<Vec<db::ObjectStatistics>, String> {
    let mut client = client.lock().await;
    let result = agent_object_statistics_query(&mut client, database, schema, &sql, timeout_duration).await?;
    Ok(oracle_object_statistics_from_query_result(result))
}

async fn agent_object_statistics_query(
    client: &mut db::agent_driver::AgentDriverClient,
    database: &str,
    schema: &str,
    sql: &str,
    timeout_duration: Option<Duration>,
) -> Result<db::QueryResult, String> {
    client
        .execute_query_with_timeout(
            agent_execute_query_params(
                sql,
                if database.is_empty() { None } else { Some(database) },
                if schema.is_empty() { None } else { Some(schema) },
                QueryExecutionOptions { max_rows: Some(10_000), ..Default::default() },
            ),
            timeout_duration,
        )
        .await
}

#[cfg(feature = "mq-admin")]
fn message_queue_topic_tables(topics: Vec<crate::mq::TopicInfo>) -> Vec<db::TableInfo> {
    topics
        .into_iter()
        .map(|topic| db::TableInfo {
            name: topic.name,
            table_type: "TOPIC".to_string(),
            comment: None,
            parent_schema: topic.namespace,
            parent_name: None,
        })
        .collect()
}

async fn list_tables_once(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    filter: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
    object_types: Option<&[String]>,
    table_name_filter: Option<&TableNameFilter>,
    client_session_id: Option<&str>,
) -> Result<Vec<db::TableInfo>, String> {
    let pool_key =
        state.get_or_create_metadata_pool_for_session(connection_id, Some(database), client_session_id).await?;
    let db_config = connection_config(state, connection_id).await;

    #[cfg(feature = "mq-admin")]
    if db_config.as_ref().is_some_and(|config| config.db_type == DatabaseType::MessageQueue) {
        let topics = crate::mq::service::mq_list_topics_core(
            state,
            connection_id,
            crate::mq::NamespaceRef { tenant: database.to_string(), namespace: schema.to_string() },
            crate::mq::ListTopicsOpts::default(),
        )
        .await?;
        return Ok(filter_table_infos(
            message_queue_topic_tables(topics),
            filter,
            limit,
            offset,
            object_types,
            table_name_filter,
        ));
    }

    {
        let connections = state.connections.read().await;
        if let Some(PoolKind::ExternalDriver { config, session, .. }) = connections.get(&pool_key) {
            let config = config.clone();
            let session = session.clone();
            drop(connections);
            if uses_presto_like_information_schema_tables(&config.db_type) {
                let force_local_table_name_filter = table_name_filter.is_some_and(|filter| !filter.is_empty());
                return external_driver_presto_like_tables(
                    session,
                    config.as_ref(),
                    database,
                    schema,
                    filter,
                    if force_local_table_name_filter { None } else { limit },
                    if force_local_table_name_filter { None } else { offset },
                )
                .await
                .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types, table_name_filter));
            }
            let mut params =
                serde_json::json!({ "connection": config.as_ref(), "database": database, "schema": schema });
            if let Some(filter) = filter.map(str::trim).filter(|value| !value.is_empty()) {
                params["filter"] = serde_json::json!(filter);
            }
            if let Some(object_types) = object_types {
                params["object_types"] = serde_json::json!(object_types);
            }
            return session
                .invoke_with_timeout::<Vec<db::TableInfo>>(
                    "listTables",
                    params,
                    agent_metadata_timeout(Some(config.as_ref())),
                )
                .await
                .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types, table_name_filter));
        }
        #[cfg(feature = "duckdb-sidecar")]
        if let Some(client) = extract_pool!(&connections, &pool_key, DuckDbWorker) {
            let database = database.to_string();
            let schema = schema.to_string();
            drop(connections);
            return client
                .list_tables(database, schema)
                .await
                .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types, table_name_filter));
        }
        if let Some(client) = extract_pool!(&connections, &pool_key, ClickHouse) {
            drop(connections);
            return db::clickhouse_driver::list_tables(&client, clickhouse_metadata_database(database, schema))
                .await
                .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types, table_name_filter));
        }
        if let Some(client) = extract_pool!(&connections, &pool_key, InfluxDb) {
            drop(connections);
            return db::influxdb_driver::list_tables(&client, database)
                .await
                .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types, table_name_filter));
        }
        if let Some(client) = extract_pool!(&connections, &pool_key, VictoriaMetrics) {
            drop(connections);
            return db::victoriametrics_driver::list_tables(&client)
                .await
                .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types, table_name_filter));
        }
        if let Some(linked) = crate::sql_dialect::parse_sqlserver_linked_schema_ref(schema) {
            if let Some(client) = extract_pool!(&connections, &pool_key, SqlServer) {
                drop(connections);
                let mut client = client.lock().await;
                return db::sqlserver::list_linked_server_tables(
                    &mut client,
                    &linked.server,
                    &linked.catalog,
                    &linked.schema,
                    filter,
                    None,
                    None,
                )
                .await
                .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types, table_name_filter));
            }
        }
        if object_types.is_some() || table_name_filter.is_some_and(|filter| !filter.is_empty()) {
            if let Some(client) = extract_pool!(&connections, &pool_key, SqlServer) {
                drop(connections);
                let mut client = client.lock().await;
                return db::sqlserver::list_tables(&mut client, schema, filter, None, None)
                    .await
                    .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types, table_name_filter));
            }
        }
        try_sqlserver!(connections, &pool_key, list_tables, schema, filter, limit, offset);
        if let Some(client) = extract_pool!(&connections, &pool_key, Agent) {
            let use_mongodb_collection_listing = uses_mongodb_agent_collection_listing(db_config.as_ref());
            let is_oracle = db_config.as_ref().is_some_and(|config| config.db_type == DatabaseType::Oracle);
            let is_tdengine = db_config.as_ref().is_some_and(|config| config.db_type == DatabaseType::Tdengine);
            let use_agent_table_paging = db_config.as_ref().is_some_and(supports_agent_table_paging);
            let filter_locally_after_oracle_comments =
                is_oracle && filter.is_some_and(|filter| !filter.trim().is_empty());
            let filter_locally_after_tdengine_comments =
                is_tdengine && filter.is_some_and(|filter| !filter.trim().is_empty());
            let filter_locally_after_comments =
                filter_locally_after_oracle_comments || filter_locally_after_tdengine_comments;
            let timeout_duration = agent_metadata_timeout(db_config.as_ref());
            let fallback_config = db_config.clone();
            drop(connections);
            let mut client = client.lock().await;
            if use_mongodb_collection_listing {
                let collection_names = client.mongo_list_collections::<Vec<String>>(database).await?;
                return Ok(filter_mongodb_agent_collections(
                    collection_names,
                    filter,
                    limit,
                    offset,
                    object_types,
                    table_name_filter,
                ));
            }
            let agent_filter = if filter_locally_after_comments { None } else { filter };
            let force_local_table_name_filter = table_name_filter.is_some_and(|filter| !filter.is_empty());
            let agent_limit = if filter_locally_after_comments || force_local_table_name_filter {
                None
            } else if use_agent_table_paging {
                limit
            } else {
                None
            };
            let agent_offset = if filter_locally_after_comments || force_local_table_name_filter {
                None
            } else if use_agent_table_paging {
                offset
            } else {
                None
            };
            match client
                .list_tables_constrained::<Vec<db::TableInfo>>(
                    database,
                    schema,
                    agent_filter,
                    agent_limit,
                    agent_offset,
                    object_types,
                    timeout_duration,
                )
                .await
            {
                Ok(mut tables) if !tables.is_empty() => {
                    if is_oracle {
                        load_oracle_table_comments_for_tables(
                            &mut client,
                            database,
                            schema,
                            &mut tables,
                            timeout_duration,
                        )
                        .await?;
                    }
                    if filter_locally_after_tdengine_comments {
                        if let Err(error) = load_tdengine_table_comments_for_filter(
                            &mut client,
                            database,
                            schema,
                            filter.expect("TDengine comment filtering requires a non-empty filter"),
                            &mut tables,
                        )
                        .await
                        {
                            // TDengine 2.x can lack the information_schema views. SHOW
                            // metadata remains usable, so preserve name filtering when
                            // the optional comment lookup is unavailable or times out.
                            log::warn!(
                                "[schema][tdengine:list_tables:comment-search-failed] connection_id={} database={} schema={} error={}",
                                connection_id,
                                database,
                                schema,
                                error
                            );
                        }
                    }
                    let final_offset = if filter_locally_after_comments || force_local_table_name_filter {
                        offset
                    } else if agent_paging_likely_applied(use_agent_table_paging, limit, tables.len()) {
                        Some(0)
                    } else {
                        offset
                    };
                    let tables =
                        filter_table_infos(tables, filter, limit, final_offset, object_types, table_name_filter);
                    return Ok(tables);
                }
                Ok(tables) => {
                    if let Some(config) = fallback_config.as_ref() {
                        match native_postgres_metadata_pool(state, connection_id, database, config).await {
                            Ok(Some(pool)) => {
                                return if object_types.is_some() {
                                    db::postgres::list_tables_filtered(&pool, schema, filter, None, None).await.map(
                                        |tables| {
                                            filter_table_infos(
                                                tables,
                                                filter,
                                                limit,
                                                offset,
                                                object_types,
                                                table_name_filter,
                                            )
                                        },
                                    )
                                } else {
                                    db::postgres::list_tables_filtered(&pool, schema, filter, limit, offset).await
                                };
                            }
                            Ok(None) => {
                                return Ok(filter_table_infos(
                                    tables,
                                    filter,
                                    limit,
                                    offset,
                                    object_types,
                                    table_name_filter,
                                ))
                            }
                            Err(error) => {
                                log::warn!(
                                    "[schema][agent:list_tables:fallback-failed] connection_id={} database={} schema={} error={}",
                                    connection_id,
                                    database,
                                    schema,
                                    error
                                );
                            }
                        }
                    }
                    return Ok(filter_table_infos(tables, filter, limit, offset, object_types, table_name_filter));
                }
                Err(agent_error) => {
                    if let Some(config) = fallback_config.as_ref() {
                        if let Some(pool) =
                            native_postgres_metadata_pool(state, connection_id, database, config).await?
                        {
                            let result = if object_types.is_some() {
                                db::postgres::list_tables_filtered(&pool, schema, filter, None, None).await.map(
                                    |tables| {
                                        filter_table_infos(
                                            tables,
                                            filter,
                                            limit,
                                            offset,
                                            object_types,
                                            table_name_filter,
                                        )
                                    },
                                )
                            } else {
                                db::postgres::list_tables_filtered(&pool, schema, filter, limit, offset).await
                            };
                            return result.map_err(|fallback_error| {
                                crate::db::agent_driver::append_legacy_error_context(
                                    &agent_error,
                                    &format!("Native PostgreSQL metadata fallback failed: {fallback_error}"),
                                )
                            });
                        }
                    }
                    return Err(agent_error);
                }
            }
        }
    }

    let connections = state.connections.read().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;

    match pool {
        PoolKind::Mysql(p, _) if db_config.as_ref().is_some_and(is_starrocks_config) => {
            db::mysql::list_starrocks_tables(p, database)
                .await
                .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types, table_name_filter))
        }
        PoolKind::Mysql(p, _) if db_config.as_ref().is_some_and(is_doris_family_config) => {
            db::mysql::list_tables_show(p, database)
                .await
                .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types, table_name_filter))
        }
        PoolKind::Mysql(p, mode) => {
            if *mode == MysqlMode::OceanBaseOracle {
                let tables = db::ob_oracle::list_tables(p, schema).await?;
                Ok(filter_table_infos(tables, filter, limit, offset, object_types, table_name_filter))
            } else if mysql_table_list_source_for_config(db_config.as_ref()) == MysqlTableListSource::ShowFullTables {
                db::mysql::list_shardingsphere_tables(p, mysql_table_metadata_catalog(database, schema))
                    .await
                    .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types, table_name_filter))
            } else {
                db::mysql::list_tables_filtered(
                    p,
                    mysql_table_metadata_catalog(database, schema),
                    filter,
                    limit,
                    offset,
                    object_types,
                    table_name_filter,
                )
                .await
                .map(|tables| filter_table_infos(tables, None, None, None, object_types, None))
            }
        }
        PoolKind::Postgres(p) if db_config.as_ref().is_some_and(is_questdb_config) => {
            db::questdb::list_tables(p, schema)
                .await
                .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types, table_name_filter))
        }
        PoolKind::Postgres(p) if db_config.as_ref().is_some_and(is_cloudberry_config) => {
            if object_types.is_some() || table_name_filter.is_some_and(|filter| !filter.is_empty()) {
                db::cloudberry::list_tables_filtered(p, schema, filter, None, None)
                    .await
                    .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types, table_name_filter))
            } else {
                db::cloudberry::list_tables_filtered(p, schema, filter, limit, offset).await
            }
        }
        PoolKind::Postgres(p) => {
            if object_types.is_some() || table_name_filter.is_some_and(|filter| !filter.is_empty()) {
                db::postgres::list_tables_filtered(p, schema, filter, None, None)
                    .await
                    .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types, table_name_filter))
            } else {
                db::postgres::list_tables_filtered(p, schema, filter, limit, offset).await
            }
        }
        PoolKind::Sqlite(p) => db::sqlite::list_tables(p, schema)
            .await
            .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types, table_name_filter)),
        PoolKind::Rqlite(client) => db::rqlite_driver::list_tables(client, schema)
            .await
            .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types, table_name_filter)),
        PoolKind::Turso(client) => db::turso_driver::list_tables(client, schema)
            .await
            .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types, table_name_filter)),
        PoolKind::MongoDb(client) => db::mongo_driver::list_collections(client, database)
            .await
            .map(|names| collection_names_to_tables(names, "COLLECTION"))
            .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types, table_name_filter)),
        PoolKind::Elasticsearch(client) => db::elasticsearch_driver::list_indices(client)
            .await
            .map(|names| collection_names_to_tables(names, "INDEX"))
            .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types, table_name_filter)),
        PoolKind::Easysearch(client) => db::easysearch_driver::list_indices(client)
            .await
            .map(|names| collection_names_to_tables(names, "INDEX"))
            .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types, table_name_filter)),
        PoolKind::Meilisearch(client) => db::meilisearch_driver::list_indexes(client)
            .await
            .map(|names| collection_names_to_tables(names, "INDEX"))
            .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types, table_name_filter)),
        PoolKind::HBase(client) => db::hbase_driver::list_tables(client, database)
            .await
            .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types, table_name_filter)),
        PoolKind::VectorDb(client) => db::vector_driver::list_collections(client)
            .await
            .map(|infos| collection_names_to_tables(infos.into_iter().map(|i| i.name).collect(), "COLLECTION"))
            .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types, table_name_filter)),
        PoolKind::CloudflareD1(client) => db::cloudflare_d1_driver::list_tables(client, schema)
            .await
            .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types, table_name_filter)),
        _ => Ok(vec![]),
    }
}

fn collection_names_to_tables(names: Vec<String>, table_type: &str) -> Vec<db::TableInfo> {
    names
        .into_iter()
        .map(|name| db::TableInfo {
            name,
            table_type: table_type.to_string(),
            comment: None,
            parent_schema: None,
            parent_name: None,
        })
        .collect()
}

fn filter_mongodb_agent_collections(
    names: Vec<String>,
    filter: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
    object_types: Option<&[String]>,
    table_name_filter: Option<&TableNameFilter>,
) -> Vec<db::TableInfo> {
    filter_table_infos(
        collection_names_to_tables(names, "COLLECTION"),
        filter,
        limit,
        offset,
        object_types,
        table_name_filter,
    )
}

fn filter_table_infos(
    tables: Vec<db::TableInfo>,
    filter: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
    object_types: Option<&[String]>,
    table_name_filter: Option<&TableNameFilter>,
) -> Vec<db::TableInfo> {
    let filter = filter.unwrap_or("");
    let limit = limit.unwrap_or(usize::MAX);
    let offset = offset.unwrap_or(0);
    tables
        .into_iter()
        .filter(|table| metadata_name_or_comment_matches(&table.name, table.comment.as_deref(), filter))
        .filter(|table| table_name_filter_matches(&table.name, table_name_filter))
        .filter(|table| table_info_matches_object_types(table, object_types))
        .skip(offset)
        .take(limit)
        .collect()
}

fn filter_object_infos(
    objects: Vec<db::ObjectInfo>,
    filter: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
    object_types: Option<&[String]>,
) -> Vec<db::ObjectInfo> {
    let filter = filter.unwrap_or("");
    let limit = limit.unwrap_or(usize::MAX);
    let offset = offset.unwrap_or(0);
    objects
        .into_iter()
        .filter(|object| metadata_name_or_comment_matches(&object.name, object.comment.as_deref(), filter))
        .filter(|object| object_info_matches_object_types(object, object_types))
        .skip(offset)
        .take(limit)
        .collect()
}

fn metadata_name_or_comment_matches(name: &str, comment: Option<&str>, filter: &str) -> bool {
    if filter.trim().is_empty() {
        return true;
    }
    crate::sql::contains_or_fuzzy_match(name, filter)
        || comment.is_some_and(|comment| crate::sql::contains_or_fuzzy_match(comment, filter))
}

fn object_info_matches_object_types(object: &db::ObjectInfo, object_types: Option<&[String]>) -> bool {
    let Some(object_types) = object_types else {
        return true;
    };
    if object_types.is_empty() {
        return true;
    }
    let object_type = normalize_object_info_object_type(&object.object_type);
    object_types.iter().any(|expected| normalize_object_info_object_type(expected) == object_type)
}

fn normalize_object_info_object_type(value: &str) -> String {
    let upper = value.to_ascii_uppercase().replace(' ', "_");
    if upper.contains("MATERIALIZED") && upper.contains("VIEW") {
        return "MATERIALIZED_VIEW".to_string();
    }
    if upper == "BASE_TABLE" || upper.contains("TABLE") {
        return "TABLE".to_string();
    }
    if upper.contains("VIEW") {
        return "VIEW".to_string();
    }
    upper
}

fn table_info_matches_object_types(table: &db::TableInfo, object_types: Option<&[String]>) -> bool {
    let Some(object_types) = object_types else {
        return true;
    };
    if object_types.is_empty() {
        return true;
    }
    let table_type = normalize_table_info_object_type(&table.table_type);
    object_types.iter().any(|object_type| normalize_table_info_object_type(object_type) == table_type)
}

fn normalize_table_info_object_type(value: &str) -> String {
    let upper = value.to_ascii_uppercase().replace(' ', "_");
    if upper.contains("MATERIALIZED") && upper.contains("VIEW") {
        return "MATERIALIZED_VIEW".to_string();
    }
    if upper.contains("VIEW") {
        return "VIEW".to_string();
    }
    if upper.contains("COLLECTION") {
        return "COLLECTION".to_string();
    }
    if upper.contains("INDEX") {
        return "INDEX".to_string();
    }
    "TABLE".to_string()
}

fn uses_presto_like_information_schema_tables(db_type: &DatabaseType) -> bool {
    matches!(db_type, DatabaseType::PrestoSql | DatabaseType::Trino)
}

fn uses_mongodb_agent_collection_listing(config: Option<&ConnectionConfig>) -> bool {
    config.is_some_and(|config| config.db_type == DatabaseType::MongoDb)
}

async fn external_driver_presto_like_tables(
    session: Arc<crate::plugins::PluginDriverSession>,
    config: &ConnectionConfig,
    database: &str,
    schema: &str,
    filter: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<db::TableInfo>, String> {
    let query_limit = limit.map(|limit| limit.saturating_add(offset.unwrap_or(0)).max(1)).unwrap_or(100000);
    let result: db::QueryResult = session
        .invoke_with_timeout(
            "executeQuery",
            serde_json::json!({
                "connection": config,
                "database": database,
                "schema": schema,
                "sql": presto_like_information_schema_tables_sql(database, schema, filter, Some(query_limit)),
                "maxRows": query_limit,
                "fetchSize": 1000,
                "timeoutSecs": 60
            }),
            agent_metadata_timeout(Some(config)),
        )
        .await?;
    Ok(presto_like_tables_from_query_result(&result))
}

async fn external_driver_presto_like_objects(
    session: Arc<crate::plugins::PluginDriverSession>,
    config: &ConnectionConfig,
    database: &str,
    schema: &str,
    filter: Option<&str>,
    object_types: Option<&[String]>,
) -> Result<Vec<db::ObjectInfo>, String> {
    let tables = external_driver_presto_like_tables(session, config, database, schema, filter, None, None)
        .await
        .map(|tables| filter_table_infos(tables, filter, None, None, object_types, None))?;
    Ok(tables
        .into_iter()
        .map(|table| db::ObjectInfo {
            name: table.name,
            object_type: table.table_type,
            schema: Some(schema.to_string()),
            valid: None,
            signature: None,
            custom_type_kind: None,
            has_members: None,
            comment: table.comment,
            created_at: None,
            updated_at: None,
            parent_schema: table.parent_schema,
            parent_name: table.parent_name,
            trigger: None,
            xugu_type_members_expandable: None,
        })
        .collect())
}

async fn external_driver_presto_like_columns(
    session: Arc<crate::plugins::PluginDriverSession>,
    config: &ConnectionConfig,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<db::ColumnInfo>, String> {
    let result: db::QueryResult = session
        .invoke(
            "executeQuery",
            serde_json::json!({
                "connection": config,
                "database": database,
                "schema": schema,
                "sql": presto_like_information_schema_columns_sql(database, schema, table),
                "maxRows": 10000,
                "fetchSize": 1000,
                "timeoutSecs": 60
            }),
        )
        .await?;
    Ok(presto_like_columns_from_query_result(&result))
}

fn presto_like_information_schema_tables_sql(
    database: &str,
    schema: &str,
    filter: Option<&str>,
    limit: Option<usize>,
) -> String {
    let source = if database.trim().is_empty() {
        "information_schema.tables".to_string()
    } else {
        format!("{}.information_schema.tables", quote_presto_like_identifier(database))
    };
    let mut sql = format!(
        "SELECT table_name, CASE table_type WHEN 'BASE TABLE' THEN 'TABLE' ELSE table_type END AS table_type \
         FROM {source} \
         WHERE table_schema = {} AND table_type IN ('BASE TABLE', 'VIEW')",
        sql_string_literal(schema)
    );
    if let Some(filter) = filter.map(str::trim).filter(|value| !value.is_empty()) {
        sql.push_str(" AND lower(table_name) LIKE ");
        sql.push_str(&sql_string_literal(&format!("{}%", escape_presto_like_pattern(&filter.to_lowercase()))));
        sql.push_str(" ESCAPE '\\'");
    }
    sql.push_str(" ORDER BY table_type, table_name");
    if let Some(limit) = limit {
        sql.push_str(&format!(" LIMIT {}", limit.max(1)));
    }
    sql
}

fn presto_like_information_schema_columns_sql(database: &str, schema: &str, table: &str) -> String {
    let source = if database.trim().is_empty() {
        "information_schema.columns".to_string()
    } else {
        format!("{}.information_schema.columns", quote_presto_like_identifier(database))
    };
    format!(
        "SELECT column_name, data_type, is_nullable, column_default, comment \
         FROM {source} \
         WHERE table_schema = {} AND table_name = {} \
         ORDER BY ordinal_position",
        sql_string_literal(schema),
        sql_string_literal(table)
    )
}

fn presto_like_tables_from_query_result(result: &db::QueryResult) -> Vec<db::TableInfo> {
    result
        .rows
        .iter()
        .filter_map(|row| {
            let name = query_result_cell_string(row, 0)?;
            if name.trim().is_empty() {
                return None;
            }
            Some(db::TableInfo {
                name,
                table_type: normalize_information_schema_table_type(
                    query_result_cell_string(row, 1).as_deref().unwrap_or("TABLE"),
                ),
                comment: None,
                parent_schema: None,
                parent_name: None,
            })
        })
        .collect()
}

fn presto_like_columns_from_query_result(result: &db::QueryResult) -> Vec<db::ColumnInfo> {
    result
        .rows
        .iter()
        .filter_map(|row| {
            let name = query_result_cell_string(row, 0)?;
            if name.trim().is_empty() {
                return None;
            }
            let data_type = query_result_cell_string(row, 1).unwrap_or_default();
            Some(db::ColumnInfo {
                name,
                // Presto/Trino do not expose precision/length columns in information_schema.columns.
                data_type: data_type.clone(),
                is_nullable: query_result_cell_string(row, 2)
                    .map(|value| value.eq_ignore_ascii_case("YES"))
                    .unwrap_or(true),
                column_default: query_result_cell_string(row, 3),
                is_primary_key: false,
                extra: None,
                comment: query_result_cell_string(row, 4),
                numeric_precision: presto_like_numeric_precision(&data_type),
                numeric_scale: presto_like_numeric_scale(&data_type),
                character_maximum_length: presto_like_character_maximum_length(&data_type),
                enum_values: None,
                ..Default::default()
            })
        })
        .collect()
}

fn query_result_cell_string(row: &[serde_json::Value], index: usize) -> Option<String> {
    let value = row.get(index)?;
    if value.is_null() {
        return None;
    }
    value.as_str().map(ToString::to_string).or_else(|| Some(value.to_string()))
}

fn presto_like_numeric_precision(data_type: &str) -> Option<i32> {
    presto_like_type_argument(data_type, &["decimal", "numeric"], 0)
}

fn presto_like_numeric_scale(data_type: &str) -> Option<i32> {
    presto_like_type_argument(data_type, &["decimal", "numeric"], 1)
}

fn presto_like_character_maximum_length(data_type: &str) -> Option<i32> {
    presto_like_type_argument(data_type, &["char", "varchar"], 0)
}

fn presto_like_type_argument(data_type: &str, type_names: &[&str], index: usize) -> Option<i32> {
    let value = data_type.trim();
    let open = value.find('(')?;
    let close = value[open + 1..].find(')')? + open + 1;
    let name = value[..open].trim().to_ascii_lowercase();
    if !type_names.iter().any(|type_name| *type_name == name) {
        return None;
    }
    value[open + 1..close].split(',').nth(index)?.trim().parse::<i32>().ok()
}

fn normalize_information_schema_table_type(table_type: &str) -> String {
    match table_type.trim().to_ascii_uppercase().replace(' ', "_").as_str() {
        "BASE_TABLE" => "TABLE".to_string(),
        "VIEW" => "VIEW".to_string(),
        "MATERIALIZED_VIEW" => "MATERIALIZED_VIEW".to_string(),
        _ => table_type.to_string(),
    }
}

fn mysql_table_metadata_catalog<'a>(database: &'a str, schema: &'a str) -> &'a str {
    if schema.trim().is_empty() {
        database
    } else {
        schema
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MysqlTableListSource {
    InformationSchema,
    ShowFullTables,
}

fn is_shardingsphere_proxy_version(version: &str) -> bool {
    const MARKER: &[u8] = b"shardingsphere-proxy";
    version.as_bytes().windows(MARKER.len()).any(|window| window.eq_ignore_ascii_case(MARKER))
}

fn mysql_table_list_source_for_config(config: Option<&ConnectionConfig>) -> MysqlTableListSource {
    if config
        .and_then(|config| config.database_info.as_ref())
        .and_then(|info| info.product_version.as_deref())
        .is_some_and(is_shardingsphere_proxy_version)
    {
        MysqlTableListSource::ShowFullTables
    } else {
        MysqlTableListSource::InformationSchema
    }
}

fn quote_presto_like_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn sql_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn escape_presto_like_pattern(value: &str) -> String {
    value.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

#[cfg(test)]
mod tests {
    use super::db;
    use super::{
        clickhouse_metadata_database, dameng_object_statistics_dba_segments_sql,
        dameng_object_statistics_rows_only_sql, dameng_object_statistics_user_segments_sql, deduplicate_column_infos,
        ephemeral_agent_metadata_session_id, external_driver_uses_mysql_ddl, filter_mongodb_agent_collections,
        filter_mysql_system_databases_for_config, filter_object_infos, filter_table_infos, filter_visible_schema_names,
        gaussdb_m_view_object_source_sql, gbase8a_object_statistics_sql, is_agent_postgres_metadata_fallback_config,
        is_mysql_external_driver_config, is_retryable_metadata_error, metadata_error_action,
        metadata_name_or_comment_matches, mysql_external_driver_ddl_from_query_result, mysql_external_driver_ddl_sql,
        mysql_object_source_ddl_column_index, mysql_object_source_sql, mysql_table_list_source_for_config,
        mysql_table_metadata_catalog, normalize_information_schema_table_type, oracle_columns_from_query_result,
        oracle_columns_sql, oracle_object_statistics_dba_segments_sql, oracle_object_statistics_from_query_result,
        oracle_object_statistics_rows_only_sql, oracle_object_statistics_sql,
        oracle_object_statistics_user_segments_sql, oracle_table_comment_from_query_result, oracle_table_comment_sql,
        oracle_table_comments_sql, presto_like_columns_from_query_result, presto_like_information_schema_columns_sql,
        presto_like_information_schema_tables_sql, presto_like_tables_from_query_result, replace_metadata_runtime,
        should_query_oracle_columns_via_sql_first, table_comments_from_query_result, table_name_filter_matches,
        tdengine_table_comment_like_pattern, tdengine_table_comment_sql, tdengine_table_comments_sql,
        uses_mongodb_agent_collection_listing, visible_schema_filter, MetadataErrorAction, MysqlTableListSource,
        TableNameFilter, TDENGINE_COMMENT_SEARCH_TIMEOUT, TDENGINE_LIKE_PATTERN_MAX_BYTES,
    };
    use super::{list_databases_core, list_tables_core};
    use super::{
        object_types_include_custom_types, object_types_include_relations, object_types_include_routines,
        object_types_only_custom_types, supports_custom_type_details, supports_pg_custom_type_objects,
    };
    use crate::connection::{AppState, PoolKind};
    use crate::models::connection::{ConnectionConfig, DatabaseConnectionInfo, DatabaseType};
    use crate::storage::Storage;
    use std::collections::HashMap;
    use std::time::Duration;

    async fn spawn_turso_table_server() -> (String, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut saw_table_query = false;
            while !saw_table_query {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut chunk = [0_u8; 4096];
                let header_end = loop {
                    if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                        break index + 4;
                    }
                    let read = socket.read(&mut chunk).await.unwrap();
                    assert!(read > 0, "request ended before headers were complete");
                    request.extend_from_slice(&chunk[..read]);
                };
                let headers = String::from_utf8(request[..header_end].to_vec()).unwrap();
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                while request.len() < header_end + content_length {
                    let read = socket.read(&mut chunk).await.unwrap();
                    assert!(read > 0, "request ended before body was complete");
                    request.extend_from_slice(&chunk[..read]);
                }

                assert!(headers.starts_with("POST /v2/pipeline HTTP/1.1"));
                assert!(headers.to_ascii_lowercase().contains("authorization: bearer test-token"));
                let request_body: serde_json::Value =
                    serde_json::from_slice(&request[header_end..header_end + content_length]).unwrap();
                let sql = request_body["requests"][0]["stmt"]["sql"].as_str().unwrap();
                let is_table_query = sql.contains("sqlite_master");
                saw_table_query |= is_table_query;

                let body = if is_table_query {
                    r#"{"results":[{"type":"ok","response":{"type":"execute","result":{"cols":[{"name":"name","decltype":"TEXT"},{"name":"type","decltype":"TEXT"}],"rows":[[{"type":"text","value":"dbx_test_records"},{"type":"text","value":"table"}]],"rows_read":1,"rows_written":0}}}]}"#
                } else {
                    r#"{"results":[{"type":"ok","response":{"type":"execute","result":{"cols":[{"name":"1","decltype":"INTEGER"}],"rows":[[{"type":"integer","value":"1"}]],"rows_read":1,"rows_written":0}}}]}"#
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });

        (format!("http://{address}"), server)
    }

    async fn turso_test_state(base_url: &str) -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("dbx-turso-schema-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = AppState::new(storage);
        let mut config = test_connection_config(DatabaseType::Turso);
        config.database = Some("main".to_string());
        config.host = base_url.to_string();
        state.configs.write().await.insert(config.id.clone(), config);
        let client = db::turso_driver::TursoClient::new(base_url, "test-token", false, Duration::from_secs(2)).unwrap();
        state.connections.write().await.insert("test".to_string(), PoolKind::Turso(client));
        (state, dir)
    }

    fn test_column(name: &str, comment: Option<&str>, is_primary_key: bool) -> super::db::ColumnInfo {
        super::db::ColumnInfo {
            name: name.to_string(),
            data_type: "VARCHAR".to_string(),
            is_nullable: true,
            column_default: None,
            is_primary_key,
            extra: None,
            comment: comment.map(|value| value.to_string()),
            numeric_precision: None,
            numeric_scale: None,
            character_maximum_length: None,
            enum_values: None,
            ..Default::default()
        }
    }

    fn test_connection_config(db_type: DatabaseType) -> ConnectionConfig {
        ConnectionConfig {
            docs_notes_path: None,
            id: "test".to_string(),
            name: "test".to_string(),
            note: String::new(),
            db_type,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            agent_java_options: Vec::new(),
            host: "127.0.0.1".to_string(),
            port: 5432,
            username: "user".to_string(),
            password: "secret".to_string(),
            database: Some("demo".to_string()),
            default_schema: None,
            visible_databases: None,
            visible_schemas: None,
            show_system_schemas: false,
            attached_databases: Vec::new(),
            init_script: None,
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: 5,
            query_timeout_secs: 30,
            idle_timeout_secs: 60,
            keepalive_interval_secs: 0,
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
            redis_key_separator: crate::models::connection::default_redis_key_separator(),
            redis_scan_page_size: None,
            redis_database_aliases: Default::default(),
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

    #[tokio::test]
    async fn turso_schema_dispatch_lists_databases_and_tables() {
        let (base_url, server) = spawn_turso_table_server().await;
        let (state, dir) = turso_test_state(&base_url).await;

        let databases = list_databases_core(&state, "test").await.unwrap();
        assert_eq!(databases.into_iter().map(|database| database.name).collect::<Vec<_>>(), ["main"]);

        let tables = list_tables_core(&state, "test", "main", "main", None, None, None, None, None).await.unwrap();
        assert_eq!(tables.len(), 1);
        assert_eq!(tables[0].name, "dbx_test_records");
        assert_eq!(tables[0].table_type, "BASE TABLE");

        server.await.unwrap();
        drop(state);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn supports_pg_custom_type_objects_only_for_verified_family() {
        for db_type in [DatabaseType::Postgres, DatabaseType::OpenGauss, DatabaseType::Gaussdb] {
            assert!(supports_pg_custom_type_objects(&test_connection_config(db_type)), "{db_type:?}");
        }
        for db_type in [
            DatabaseType::Kingbase,
            DatabaseType::Vastbase,
            DatabaseType::Highgo,
            DatabaseType::Uxdb,
            DatabaseType::Kwdb,
            DatabaseType::Redshift,
        ] {
            assert!(!supports_pg_custom_type_objects(&test_connection_config(db_type)), "{db_type:?}");
        }
    }

    #[test]
    fn supports_custom_type_details_covers_five_verified_families() {
        for db_type in [
            DatabaseType::Postgres,
            DatabaseType::OpenGauss,
            DatabaseType::Gaussdb,
            DatabaseType::Kingbase,
            DatabaseType::Vastbase,
        ] {
            assert!(supports_custom_type_details(&test_connection_config(db_type)), "{db_type:?}");
        }
        for db_type in [
            DatabaseType::Highgo,
            DatabaseType::Uxdb,
            DatabaseType::Kwdb,
            DatabaseType::Redshift,
            DatabaseType::Mysql,
            DatabaseType::Xugu,
        ] {
            assert!(!supports_custom_type_details(&test_connection_config(db_type)), "{db_type:?}");
        }
    }

    #[test]
    fn object_types_include_custom_types_only_when_unfiltered_or_type_requested() {
        assert!(object_types_include_custom_types(None));
        assert!(object_types_include_custom_types(Some(&["TYPE".to_string()])));
        assert!(object_types_include_custom_types(Some(&["type_body".to_string()])));
        assert!(object_types_include_custom_types(Some(&["table".to_string(), "type".to_string()])));
        assert!(!object_types_include_custom_types(Some(&["TABLE".to_string()])));
        assert!(!object_types_include_custom_types(Some(&["FUNCTION".to_string()])));
    }

    #[test]
    fn object_types_select_independent_catalog_branches() {
        assert!(object_types_include_relations(None));
        assert!(object_types_include_routines(None));
        assert!(object_types_include_custom_types(None));

        assert!(object_types_include_relations(Some(&["TABLE".to_string()])));
        assert!(object_types_include_relations(Some(&["VIEW".to_string()])));
        assert!(object_types_include_relations(Some(&["SEQUENCE".to_string()])));
        assert!(!object_types_include_routines(Some(&["TABLE".to_string()])));
        assert!(!object_types_include_custom_types(Some(&["TABLE".to_string()])));

        assert!(object_types_include_routines(Some(&["PROCEDURE".to_string()])));
        assert!(object_types_include_routines(Some(&["FUNCTION".to_string()])));
        assert!(!object_types_include_relations(Some(&["FUNCTION".to_string()])));
        assert!(!object_types_include_custom_types(Some(&["FUNCTION".to_string()])));

        assert!(object_types_include_custom_types(Some(&["TYPE".to_string()])));
        assert!(!object_types_include_relations(Some(&["TYPE".to_string()])));
        assert!(!object_types_include_routines(Some(&["TYPE".to_string()])));

        // The sidebar type group sends the TYPE_BODY companion kind as well;
        // it must select the type branch alone, never relations or routines.
        let type_group = ["TYPE".to_string(), "TYPE_BODY".to_string()];
        assert!(object_types_include_custom_types(Some(&type_group)));
        assert!(!object_types_include_relations(Some(&type_group)));
        assert!(!object_types_include_routines(Some(&type_group)));
    }

    #[test]
    fn object_types_only_custom_types_detects_dedicated_type_requests() {
        assert!(!object_types_only_custom_types(None));
        assert!(object_types_only_custom_types(Some(&["TYPE".to_string()])));
        assert!(object_types_only_custom_types(Some(&["TYPE".to_string(), "TYPE_BODY".to_string()])));
        assert!(object_types_only_custom_types(Some(&["type_body".to_string()])));
        assert!(!object_types_only_custom_types(Some(&["TYPE".to_string(), "TABLE".to_string()])));
        assert!(!object_types_only_custom_types(Some(&["TABLE".to_string()])));
        assert!(!object_types_only_custom_types(Some(&[])));
    }

    #[test]
    fn agent_metadata_uses_unique_ephemeral_sessions_only_for_agents() {
        let oracle = test_connection_config(DatabaseType::Oracle);
        let first = ephemeral_agent_metadata_session_id(Some(&oracle), "completion-objects").unwrap();
        let second = ephemeral_agent_metadata_session_id(Some(&oracle), "completion-objects").unwrap();

        assert_ne!(first, second);
        assert!(first.starts_with("completion-objects:"));

        let postgres = test_connection_config(DatabaseType::Postgres);
        assert!(ephemeral_agent_metadata_session_id(Some(&postgres), "completion-objects").is_none());
        assert!(ephemeral_agent_metadata_session_id(None, "completion-objects").is_none());
    }

    #[test]
    fn mysql_table_child_metadata_prefers_schema_when_present() {
        assert_eq!(mysql_table_metadata_catalog("app_db", ""), "app_db");
        assert_eq!(mysql_table_metadata_catalog("app_db", "tenant_db"), "tenant_db");
    }

    #[test]
    fn mysql_external_driver_detection_only_accepts_standard_jdbc_signals() {
        let mut config = test_connection_config(DatabaseType::Jdbc);
        config.connection_string = Some(" jdbc:mysql://127.0.0.1:3306/demo ".to_string());
        assert!(is_mysql_external_driver_config(&config));

        config.connection_string = Some("jdbc:mariadb://127.0.0.1:3306/demo".to_string());
        config.jdbc_driver_class = Some("com.mysql.cj.jdbc.Driver".to_string());
        assert!(!is_mysql_external_driver_config(&config));

        config.connection_string = None;
        assert!(is_mysql_external_driver_config(&config));

        config.jdbc_driver_class = Some("org.mariadb.jdbc.Driver".to_string());
        assert!(!is_mysql_external_driver_config(&config));
    }

    #[test]
    fn gaussdb_m_external_driver_uses_mysql_style_ddl() {
        let mut config = test_connection_config(DatabaseType::Gaussdb);
        config.driver_profile = Some("gaussdb-m".to_string());
        config.jdbc_driver_class = Some("com.huawei.gaussdb.jdbc.Driver".to_string());

        assert!(external_driver_uses_mysql_ddl(&config));
        assert_eq!(
            mysql_external_driver_ddl_sql("app", "app_schema", "order"),
            "SHOW CREATE TABLE `app_schema`.`order`"
        );

        config.driver_profile = Some("gaussdb".to_string());
        assert!(!external_driver_uses_mysql_ddl(&config));
    }

    #[test]
    fn gaussdb_m_view_object_source_sql_is_qualified_and_gated() {
        let mut config = test_connection_config(DatabaseType::Gaussdb);
        config.driver_profile = Some("gaussdb-m".to_string());

        assert_eq!(
            gaussdb_m_view_object_source_sql(
                &config,
                "connection_db",
                "tenant`schema",
                "active`users",
                &db::ObjectSourceKind::View,
            )
            .as_deref(),
            Some("SHOW CREATE VIEW `tenant``schema`.`active``users`")
        );
        assert_eq!(
            gaussdb_m_view_object_source_sql(&config, "connection_db", "", "active`users", &db::ObjectSourceKind::View)
                .as_deref(),
            Some("SHOW CREATE VIEW `active``users`")
        );
        assert_eq!(
            gaussdb_m_view_object_source_sql(
                &config,
                "connection_db",
                "tenant_schema",
                "refresh_users",
                &db::ObjectSourceKind::Function,
            ),
            None
        );

        config.driver_profile = Some("gaussdb".to_string());
        assert_eq!(
            gaussdb_m_view_object_source_sql(
                &config,
                "connection_db",
                "tenant_schema",
                "active_users",
                &db::ObjectSourceKind::View,
            ),
            None
        );
    }

    #[test]
    fn mysql_external_driver_ddl_sql_uses_catalog_and_escaped_identifiers() {
        assert_eq!(
            mysql_external_driver_ddl_sql("app_db", "tenant`db", "user`events"),
            "SHOW CREATE TABLE `tenant``db`.`user``events`"
        );
        assert_eq!(
            mysql_external_driver_ddl_sql("app`db", "", "user`events"),
            "SHOW CREATE TABLE `app``db`.`user``events`"
        );
    }

    #[test]
    fn mysql_external_driver_ddl_reads_named_column_case_insensitively() {
        let result = db::QueryResult {
            columns: vec!["Table".to_string(), "Extra".to_string(), "CREATE TABLE".to_string()],
            column_types: Vec::new(),
            column_sortables: Vec::new(),
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: vec![vec![
                serde_json::json!("users"),
                serde_json::json!("ignored"),
                serde_json::json!("CREATE TABLE `users` (`id` bigint)"),
            ]],
            affected_rows: 0,
            execution_time_ms: 0,
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages: Vec::new(),
        };

        assert_eq!(
            mysql_external_driver_ddl_from_query_result(result, "Create Table").unwrap(),
            "CREATE TABLE `users` (`id` bigint);"
        );
    }

    #[test]
    fn mysql_external_driver_ddl_repairs_double_encoded_comments() {
        let result = db::QueryResult {
            columns: vec!["Table".to_string(), "Create Table".to_string()],
            column_types: Vec::new(),
            column_sortables: Vec::new(),
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: vec![vec![
                serde_json::json!("orders"),
                serde_json::json!("CREATE TABLE `orders` (`id` bigint COMMENT 'è®¢åID')"),
            ]],
            affected_rows: 0,
            execution_time_ms: 0,
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages: Vec::new(),
        };

        assert_eq!(
            mysql_external_driver_ddl_from_query_result(result, "Create Table").unwrap(),
            "CREATE TABLE `orders` (`id` bigint COMMENT '订单ID');"
        );
    }

    #[test]
    fn mysql_external_driver_ddl_falls_back_to_second_column() {
        let result = db::QueryResult {
            columns: vec!["name".to_string(), "definition".to_string()],
            column_types: Vec::new(),
            column_sortables: Vec::new(),
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: vec![vec![serde_json::json!("users"), serde_json::json!("CREATE TABLE `users` (`id` bigint);\n")]],
            affected_rows: 0,
            execution_time_ms: 0,
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages: Vec::new(),
        };

        assert_eq!(
            mysql_external_driver_ddl_from_query_result(result, "Create Table").unwrap(),
            "CREATE TABLE `users` (`id` bigint);\n"
        );
    }

    #[test]
    fn mysql_external_driver_view_ddl_reads_named_column_case_insensitively() {
        let result = db::QueryResult {
            columns: vec!["View".to_string(), "Extra".to_string(), "CREATE VIEW".to_string()],
            column_types: Vec::new(),
            column_sortables: Vec::new(),
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: vec![vec![
                serde_json::json!("active_users"),
                serde_json::json!("ignored"),
                serde_json::json!("CREATE VIEW `active_users` AS SELECT 1"),
            ]],
            affected_rows: 0,
            execution_time_ms: 0,
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages: Vec::new(),
        };

        assert_eq!(
            mysql_external_driver_ddl_from_query_result(result, "Create View").unwrap(),
            "CREATE VIEW `active_users` AS SELECT 1;"
        );
    }

    #[test]
    fn mysql_external_driver_view_ddl_falls_back_to_second_column() {
        let result = db::QueryResult {
            columns: vec!["name".to_string(), "definition".to_string()],
            column_types: Vec::new(),
            column_sortables: Vec::new(),
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: vec![vec![
                serde_json::json!("active_users"),
                serde_json::json!("CREATE VIEW `active_users` AS SELECT 1;\n"),
            ]],
            affected_rows: 0,
            execution_time_ms: 0,
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages: Vec::new(),
        };

        assert_eq!(
            mysql_external_driver_ddl_from_query_result(result, "Create View").unwrap(),
            "CREATE VIEW `active_users` AS SELECT 1;\n"
        );
    }

    #[test]
    fn mysql_object_source_sql_qualifies_cross_database_objects() {
        assert_eq!(
            mysql_object_source_sql("tenant_db", "users_view", &db::ObjectSourceKind::View),
            "SHOW CREATE VIEW `tenant_db`.`users_view`"
        );
        assert_eq!(
            mysql_object_source_sql("tenant_db", "sync_users", &db::ObjectSourceKind::Procedure),
            "SHOW CREATE PROCEDURE `tenant_db`.`sync_users`"
        );
        assert_eq!(
            mysql_object_source_sql("tenant_db", "calc_score", &db::ObjectSourceKind::Function),
            "SHOW CREATE FUNCTION `tenant_db`.`calc_score`"
        );
        assert_eq!(
            mysql_object_source_sql("", "users_view", &db::ObjectSourceKind::View),
            "SHOW CREATE VIEW `users_view`"
        );
    }

    #[test]
    fn mysql_object_source_sql_emits_show_create_trigger() {
        assert_eq!(
            mysql_object_source_sql("tenant_db", "before_insert", &db::ObjectSourceKind::Trigger),
            "SHOW CREATE TRIGGER `tenant_db`.`before_insert`"
        );
    }

    #[test]
    fn mysql_object_source_sql_emits_show_create_materialized_view() {
        // Regression for the review comment: Doris / StarRocks ride on the MySQL
        // protocol, so the MV branch of mysql_object_source_sql must produce a
        // real statement (used at crates/dbx-core/src/schema.rs:5395-5404 by
        // get_table_ddl_core). Returning an empty string silently broke the UI.
        assert_eq!(
            mysql_object_source_sql("shop", "daily_sales_mv", &db::ObjectSourceKind::MaterializedView),
            "SHOW CREATE MATERIALIZED VIEW `shop`.`daily_sales_mv`"
        );
        assert_eq!(
            mysql_object_source_sql("", "daily_sales_mv", &db::ObjectSourceKind::MaterializedView),
            "SHOW CREATE MATERIALIZED VIEW `daily_sales_mv`"
        );
    }

    #[test]
    fn mysql_object_source_ddl_column_index_matches_dialect_layout() {
        // VIEW and Doris/StarRocks MaterializedView return (Name, DDL).
        // PROCEDURE / FUNCTION return (Name, sql_mode, DDL, …).
        // Reading the wrong index returns the empty/no-op and surfaces as
        // "Failed to read object source" — regression-guarded here so we
        // don't have to spin up a real StarRocks to catch it.
        assert_eq!(mysql_object_source_ddl_column_index(&db::ObjectSourceKind::View), 1);
        assert_eq!(mysql_object_source_ddl_column_index(&db::ObjectSourceKind::MaterializedView), 1);
        assert_eq!(mysql_object_source_ddl_column_index(&db::ObjectSourceKind::Procedure), 2);
        assert_eq!(mysql_object_source_ddl_column_index(&db::ObjectSourceKind::Function), 2);
        assert_eq!(mysql_object_source_ddl_column_index(&db::ObjectSourceKind::Trigger), 2);
    }

    #[test]
    fn metadata_retry_recovers_missing_pool_only_as_transient_state() {
        assert!(is_retryable_metadata_error("Pool not found"));
        assert!(is_retryable_metadata_error("connection reset by peer"));
        assert!(is_retryable_metadata_error("Agent RPC error (-1): dm.jdbc.driver.DMException: 网络通信异常"));
        assert!(is_retryable_metadata_error(
            "Agent RPC error (-1): connection lost\nDBX_AGENT_ERROR_DATA:{\"category\":\"connection\",\"sessionDisposition\":\"quarantine\"}"
        ));
        assert!(!is_retryable_metadata_error(
            "Agent RPC error (-1): connection text in SQL error\nDBX_AGENT_ERROR_DATA:{\"category\":\"sql\",\"sessionDisposition\":\"keep\"}"
        ));
        assert!(!is_retryable_metadata_error(
            "Agent RPC error (-1): connection kept\nDBX_AGENT_ERROR_DATA:{\"category\":\"connection\",\"sessionDisposition\":\"keep\"}"
        ));
        assert!(!is_retryable_metadata_error(
            "Agent RPC error (-1): runtime saturated\nDBX_AGENT_ERROR_DATA:{\"category\":\"resource\",\"sessionDisposition\":\"replace_runtime\"}"
        ));
        assert!(!is_retryable_metadata_error("Unknown column 'email' in 'field list'"));
        assert!(!is_retryable_metadata_error("Access denied for user"));
    }

    #[test]
    fn metadata_error_action_applies_fail_stop_to_every_attempt() {
        let quarantine = "Agent RPC error (-1): connection lost\nDBX_AGENT_ERROR_DATA:{\"category\":\"connection\",\"sessionDisposition\":\"quarantine\"}";
        let replace_runtime = "Agent RPC error (-1): runtime saturated\nDBX_AGENT_ERROR_DATA:{\"category\":\"resource\",\"sessionDisposition\":\"replace_runtime\"}";
        let sql = "Agent RPC error (-1): syntax error\nDBX_AGENT_ERROR_DATA:{\"category\":\"sql\",\"sessionDisposition\":\"keep\"}";
        let db_type = Some(DatabaseType::Dameng);

        assert_eq!(metadata_error_action(db_type, quarantine, false), MetadataErrorAction::Retry);
        assert_eq!(metadata_error_action(db_type, quarantine, true), MetadataErrorAction::Discard);
        assert_eq!(
            metadata_error_action(db_type, "Agent RPC call timed out (30s)", false),
            MetadataErrorAction::Discard
        );
        assert_eq!(metadata_error_action(db_type, replace_runtime, false), MetadataErrorAction::ReplaceRuntime);
        assert_eq!(metadata_error_action(db_type, replace_runtime, true), MetadataErrorAction::ReplaceRuntime);
        assert_eq!(metadata_error_action(db_type, sql, false), MetadataErrorAction::Return);
    }

    #[tokio::test]
    async fn metadata_fail_stop_detaches_base_pool_without_client_session() {
        let dir = std::env::temp_dir().join(format!("dbx-schema-metadata-fail-stop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = crate::storage::Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = crate::connection::AppState::new(storage);
        let mut config = test_connection_config(DatabaseType::Dameng);
        config.id = "conn".to_string();
        state.configs.write().await.insert(config.id.clone(), config);
        state.connections.write().await.insert(
            "conn:analytics:role:metadata".to_string(),
            super::PoolKind::agent(crate::db::agent_driver::AgentDriverClient::test_stub()),
        );

        replace_metadata_runtime(&state, "conn", Some("analytics"), None).await;

        assert!(!state.connections.read().await.contains_key("conn:analytics:role:metadata"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn metadata_timeout_detaches_pool_without_replaying_operation() {
        let dir = std::env::temp_dir().join(format!("dbx-schema-metadata-timeout-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = crate::storage::Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = crate::connection::AppState::new(storage);
        let mut config = test_connection_config(DatabaseType::Dameng);
        config.id = "conn".to_string();
        state.configs.write().await.insert(config.id.clone(), config);
        let pool = crate::db::sqlite::connect_path(":memory:").await.unwrap();
        state.connections.write().await.insert("conn:role:metadata".to_string(), super::PoolKind::Sqlite(pool));
        let mut attempts = 0;

        let result = super::retry_metadata_connection_for_session(&state, "conn", None, None, || {
            attempts += 1;
            async { Err::<(), _>("Agent RPC call timed out (30s)".to_string()) }
        })
        .await;

        assert_eq!(result.unwrap_err(), "Agent RPC call timed out (30s)");
        assert_eq!(attempts, 1);
        assert!(!state.connections.read().await.contains_key("conn:role:metadata"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn metadata_second_quarantine_detaches_replacement_pool() {
        let dir = std::env::temp_dir().join(format!("dbx-schema-metadata-quarantine-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = crate::storage::Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = crate::connection::AppState::new(storage);
        let mut config = test_connection_config(DatabaseType::Sqlite);
        config.id = "conn".to_string();
        config.host = ":memory:".to_string();
        config.password.clear();
        config.database = None;
        state.configs.write().await.insert(config.id.clone(), config);
        let pool = crate::db::sqlite::connect_path(":memory:").await.unwrap();
        state.connections.write().await.insert("conn".to_string(), super::PoolKind::Sqlite(pool));
        let mut attempts = 0;
        let quarantine = "Agent RPC error (-1): connection lost\nDBX_AGENT_ERROR_DATA:{\"category\":\"connection\",\"sessionDisposition\":\"quarantine\"}";

        let result = super::retry_metadata_connection_for_session(&state, "conn", None, None, || {
            attempts += 1;
            async { Err::<(), _>(quarantine.to_string()) }
        })
        .await;

        assert_eq!(result.unwrap_err(), quarantine);
        assert_eq!(attempts, 2);
        assert!(!state.connections.read().await.contains_key("conn"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn table_ddl_timeout_detaches_metadata_pool_without_replay() {
        let dir = std::env::temp_dir().join(format!("dbx-schema-table-ddl-timeout-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script_path = dir.join("table-ddl-timeout-agent.py");
        let call_count_path = dir.join("table-ddl-call-count");
        let call_count = serde_json::to_string(&call_count_path.to_string_lossy()).unwrap();
        std::fs::write(
            &script_path,
            format!(
                r#"import json, pathlib, sys
call_count = pathlib.Path({call_count})
print(json.dumps({{'ready': True}}), flush=True)
for line in sys.stdin:
    req = json.loads(line)
    if req['method'] == 'handshake':
        result = {{'protocolVersion': 2, 'agentProtocolVersion': 2, 'capabilities': ['multi_session']}}
        response = {{'jsonrpc': '2.0', 'id': req['id'], 'result': result}}
    elif req['method'] in ('validate_session', 'validate_connection'):
        response = {{'jsonrpc': '2.0', 'id': req['id'], 'result': {{}}}}
    else:
        previous = int(call_count.read_text()) if call_count.exists() else 0
        call_count.write_text(str(previous + 1))
        response = {{
            'jsonrpc': '2.0',
            'id': req['id'],
            'error': {{
                'code': -1,
                'message': 'metadata timed out',
                'data': {{
                    'category': 'timeout',
                    'retryable': False,
                    'sessionDisposition': 'quarantine',
                    'stage': 'execute'
                }}
            }}
        }}
    print(json.dumps(response), flush=True)
"#
            ),
        )
        .unwrap();
        let python = if cfg!(windows) { "python" } else { "python3" };
        let runtime = crate::db::agent_driver::AgentRuntimeClient::spawn(
            crate::db::agent_driver::AgentLaunchSpec::new(python)
                .with_args([script_path.to_string_lossy().to_string()]),
            "test",
        )
        .await
        .unwrap();
        runtime.increment_session_count();
        let client =
            crate::db::agent_driver::AgentDriverClient::shared_session(runtime.clone(), "metadata-session".to_string());
        let storage = crate::storage::Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = crate::connection::AppState::new(storage);
        let mut config = test_connection_config(DatabaseType::Dameng);
        config.id = "conn".to_string();
        state.configs.write().await.insert(config.id.clone(), config);
        let pool_key = "conn:analytics:role:metadata";
        state.connections.write().await.insert(pool_key.to_string(), super::PoolKind::agent(client));

        let error = super::get_table_ddl_core(&state, "conn", "analytics", "APP", "EVENTS", None).await.unwrap_err();

        assert_eq!(
            crate::db::agent_driver::try_agent_error_from_legacy(&error).and_then(|error| error.category()),
            Some(crate::db::agent_driver::AgentErrorCategory::Timeout)
        );
        assert_eq!(std::fs::read_to_string(call_count_path).unwrap(), "1");
        assert!(!state.connections.read().await.contains_key(pool_key));
        runtime.kill();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn visible_schema_filter_only_applies_when_requested() {
        let mut config = test_connection_config(DatabaseType::Oracle);
        config.visible_schemas =
            Some(HashMap::from([("ORCLPDB1".to_string(), vec!["APP".to_string(), "REPORTING".to_string()])]));

        assert_eq!(visible_schema_filter(Some(&config), "ORCLPDB1", false), None);
        assert_eq!(
            visible_schema_filter(Some(&config), "ORCLPDB1", true),
            Some(vec!["APP".to_string(), "REPORTING".to_string()])
        );
        assert_eq!(visible_schema_filter(Some(&config), "OTHER", true), None);
    }

    #[test]
    fn default_oracle_agent_config_excludes_legacy_profiles() {
        let mut config = test_connection_config(DatabaseType::Oracle);
        assert!(super::is_default_oracle_agent_config(&config));

        config.driver_profile = Some("oracle".to_string());
        assert!(super::is_default_oracle_agent_config(&config));

        config.driver_profile = Some("oracle-legacy".to_string());
        assert!(!super::is_default_oracle_agent_config(&config));

        config.driver_profile = Some("oracle-10g".to_string());
        assert!(!super::is_default_oracle_agent_config(&config));
    }

    #[test]
    fn agent_table_paging_supports_tdengine_and_default_oracle_only() {
        assert!(super::supports_agent_table_paging(&test_connection_config(DatabaseType::Tdengine)));
        assert!(super::supports_agent_table_paging(&test_connection_config(DatabaseType::Oracle)));
        assert!(!super::supports_agent_table_paging(&test_connection_config(DatabaseType::Dameng)));

        let mut legacy_oracle = test_connection_config(DatabaseType::Oracle);
        legacy_oracle.driver_profile = Some("oracle-legacy".to_string());
        assert!(!super::supports_agent_table_paging(&legacy_oracle));
    }

    #[test]
    fn detects_opengauss_sequence_compatibility_profiles() {
        assert!(super::is_opengauss_family_config(&test_connection_config(DatabaseType::OpenGauss)));
        assert!(super::is_opengauss_family_config(&test_connection_config(DatabaseType::Gaussdb)));
        assert!(!super::is_opengauss_family_config(&test_connection_config(DatabaseType::Postgres)));

        let mut profiled_postgres = test_connection_config(DatabaseType::Postgres);
        profiled_postgres.driver_profile = Some("opengauss".to_string());
        assert!(super::is_opengauss_family_config(&profiled_postgres));

        profiled_postgres.driver_profile = Some("gaussdb".to_string());
        assert!(super::is_opengauss_family_config(&profiled_postgres));
    }

    #[test]
    fn agent_paging_detection_avoids_double_offset_only_when_page_sized() {
        assert!(super::agent_paging_likely_applied(true, Some(500), 500));
        assert!(super::agent_paging_likely_applied(true, Some(500), 120));
        assert!(!super::agent_paging_likely_applied(true, Some(500), 501));
        assert!(!super::agent_paging_likely_applied(false, Some(500), 120));
        assert!(!super::agent_paging_likely_applied(true, None, 120));
    }

    #[test]
    fn filter_visible_schema_names_preserves_database_order() {
        let schemas = vec!["APP".to_string(), "SYS".to_string(), "REPORTING".to_string()];
        let visible = vec!["REPORTING".to_string(), "APP".to_string()];

        assert_eq!(filter_visible_schema_names(schemas, Some(&visible)), vec!["APP", "REPORTING"]);
    }

    fn test_table_info(name: &str) -> super::db::TableInfo {
        super::db::TableInfo {
            name: name.to_string(),
            table_type: "BASE TABLE".to_string(),
            comment: None,
            parent_schema: None,
            parent_name: None,
        }
    }

    #[cfg(feature = "mq-admin")]
    #[test]
    fn message_queue_topics_are_exposed_as_table_metadata() {
        let tables = super::message_queue_topic_tables(vec![crate::mq::TopicInfo {
            name: "orders".to_string(),
            short_name: "orders".to_string(),
            partitioned: true,
            partitions: Some(3),
            persistent: true,
            internal: false,
            message_type: None,
            namespace: Some("default".to_string()),
            message_count: None,
            messages_ready: None,
            messages_unacked: None,
        }]);

        assert_eq!(tables.len(), 1);
        assert_eq!(tables[0].name, "orders");
        assert_eq!(tables[0].table_type, "TOPIC");
        assert_eq!(tables[0].parent_schema.as_deref(), Some("default"));
    }

    fn test_object_info(name: &str, object_type: &str) -> super::db::ObjectInfo {
        super::db::ObjectInfo {
            name: name.to_string(),
            object_type: object_type.to_string(),
            schema: Some("app".to_string()),
            valid: None,
            signature: None,
            custom_type_kind: None,
            has_members: None,
            comment: None,
            created_at: None,
            updated_at: None,
            parent_schema: None,
            parent_name: None,
            trigger: None,
            xugu_type_members_expandable: None,
        }
    }

    fn test_database_info(name: &str) -> super::db::DatabaseInfo {
        super::db::DatabaseInfo { name: name.to_string(), ..Default::default() }
    }

    #[test]
    fn manticoresearch_database_list_filters_mysql_system_databases() {
        let databases = vec![
            test_database_info("Manticore"),
            test_database_info("information_schema"),
            test_database_info("mysql"),
            test_database_info("performance_schema"),
            test_database_info("sys"),
        ];
        let config = test_connection_config(DatabaseType::ManticoreSearch);

        let filtered = filter_mysql_system_databases_for_config(databases, Some(&config));

        assert_eq!(filtered.into_iter().map(|database| database.name).collect::<Vec<_>>(), vec!["Manticore"]);
    }

    #[test]
    fn manticoresearch_show_metadata_uses_unqualified_table_names() {
        let config = test_connection_config(DatabaseType::ManticoreSearch);

        assert_eq!(super::mysql_show_metadata_database_for_config(Some(&config), "Manticore"), "");
    }

    #[test]
    fn doris_show_metadata_keeps_database_qualifier() {
        let config = test_connection_config(DatabaseType::Doris);

        assert_eq!(super::mysql_show_metadata_database_for_config(Some(&config), "analytics"), "analytics");
    }

    #[test]
    fn doris_database_list_keeps_system_databases() {
        let databases = vec![test_database_info("information_schema"), test_database_info("analytics")];
        let config = test_connection_config(DatabaseType::Doris);

        let filtered = filter_mysql_system_databases_for_config(databases, Some(&config));

        assert_eq!(
            filtered.into_iter().map(|database| database.name).collect::<Vec<_>>(),
            vec!["information_schema", "analytics"]
        );
    }

    #[test]
    fn filter_table_infos_applies_filter_offset_and_limit() {
        let tables = vec![
            test_table_info("alpha"),
            test_table_info("audit_log"),
            test_table_info("audit_record"),
            test_table_info("users"),
        ];

        let filtered = filter_table_infos(tables, Some("audit"), Some(1), Some(1), None, None);

        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].name, "audit_record");
    }

    #[test]
    fn shardingsphere_proxy_marker_is_ascii_case_insensitive_and_exact() {
        assert!(super::is_shardingsphere_proxy_version("5.7.22-ShardingSphere-Proxy 5.5.2"));
        assert!(super::is_shardingsphere_proxy_version("8.0.36-SHARDINGSPHERE-PROXY 5.5.2"));
        assert!(!super::is_shardingsphere_proxy_version("8.0.36-ShardingSphere Proxy 5.5.2"));
        assert!(!super::is_shardingsphere_proxy_version("8.0.36-MySQL Community Server"));
    }

    #[test]
    fn mysql_table_list_source_uses_only_saved_shardingsphere_version() {
        let mut config = test_connection_config(DatabaseType::Mysql);
        assert_eq!(mysql_table_list_source_for_config(Some(&config)), MysqlTableListSource::InformationSchema);

        config.database_info = Some(DatabaseConnectionInfo {
            product_version: Some("5.7.22-ShardingSphere-Proxy 5.5.2".to_string()),
            ..DatabaseConnectionInfo::default()
        });
        assert_eq!(mysql_table_list_source_for_config(Some(&config)), MysqlTableListSource::ShowFullTables);

        config.database_info.as_mut().unwrap().product_version = Some("8.0.36-MySQL Community Server".to_string());
        assert_eq!(mysql_table_list_source_for_config(Some(&config)), MysqlTableListSource::InformationSchema);
        assert_eq!(mysql_table_list_source_for_config(None), MysqlTableListSource::InformationSchema);
    }

    #[test]
    fn shardingsphere_logical_tables_keep_local_constraints() {
        let tables = vec![
            test_table_info("normal_table"),
            test_table_info("t_order"),
            test_table_info("t_order_archive"),
            super::db::TableInfo {
                name: "t_order_view".to_string(),
                table_type: "VIEW".to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            },
            test_table_info("t_user"),
        ];
        let table_types = vec!["TABLE".to_string()];
        let name_filter =
            TableNameFilter { include_patterns: vec!["t_%".to_string()], exclude_patterns: vec!["%user%".to_string()] };

        let filtered =
            filter_table_infos(tables, Some("order"), Some(1), Some(1), Some(&table_types), Some(&name_filter));

        assert_eq!(filtered.into_iter().map(|table| table.name).collect::<Vec<_>>(), vec!["t_order_archive"]);
    }

    #[test]
    fn mongodb_agent_collection_listing_only_applies_to_mongodb() {
        let mongodb = test_connection_config(DatabaseType::MongoDb);
        let postgres = test_connection_config(DatabaseType::Postgres);

        assert!(uses_mongodb_agent_collection_listing(Some(&mongodb)));
        assert!(!uses_mongodb_agent_collection_listing(Some(&postgres)));
        assert!(!uses_mongodb_agent_collection_listing(None));
    }

    #[test]
    fn mongodb_agent_collections_preserve_table_list_constraints() {
        let collection_types = vec!["COLLECTION".to_string()];
        let names = vec!["audit_log".to_string(), "users".to_string(), "audit_record".to_string()];

        let filtered = filter_mongodb_agent_collections(
            names.clone(),
            Some("audit"),
            Some(1),
            Some(1),
            Some(&collection_types),
            None,
        );

        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].name, "audit_record");
        assert_eq!(filtered[0].table_type, "COLLECTION");

        let table_types = vec!["TABLE".to_string()];
        let filtered = filter_mongodb_agent_collections(names, None, None, None, Some(&table_types), None);

        assert!(filtered.is_empty());
    }

    #[test]
    fn filter_table_infos_matches_fuzzy_subsequences() {
        let tables = vec![test_table_info("system_user"), test_table_info("user_order"), test_table_info("alpha")];

        let system_user = filter_table_infos(tables.clone(), Some("sysu"), None, None, None, None);
        assert_eq!(system_user.into_iter().map(|table| table.name).collect::<Vec<_>>(), vec!["system_user"]);

        let user_order = filter_table_infos(tables, Some("uo"), None, None, None, None);
        assert_eq!(user_order.into_iter().map(|table| table.name).collect::<Vec<_>>(), vec!["user_order"]);
    }

    #[test]
    fn filter_table_infos_matches_comments() {
        let mut orders = test_table_info("orders");
        orders.comment = Some("sales archive".to_string());
        let mut profile = test_table_info("profile");
        profile.comment = Some("customer account data".to_string());
        let tables = vec![orders, profile, test_table_info("logs")];

        let filtered = filter_table_infos(tables, Some("account"), None, None, None, None);

        assert_eq!(filtered.into_iter().map(|table| table.name).collect::<Vec<_>>(), vec!["profile"]);
    }

    #[test]
    fn filter_table_infos_skips_fuzzy_for_single_character_filters() {
        let tables = vec![test_table_info("orders"), test_table_info("user_order")];

        let filtered = filter_table_infos(tables, Some("u"), None, None, None, None);

        assert_eq!(filtered.into_iter().map(|table| table.name).collect::<Vec<_>>(), vec!["user_order"]);
    }

    #[test]
    fn filter_table_infos_keeps_special_filter_characters_literal() {
        let tables = vec![test_table_info("user_%"), test_table_info("user_account"), test_table_info("userXpercent")];

        let filtered = filter_table_infos(tables, Some("user_%"), None, None, None, None);

        assert_eq!(filtered.into_iter().map(|table| table.name).collect::<Vec<_>>(), vec!["user_%"]);
    }

    #[test]
    fn table_name_filter_uses_sql_like_without_fuzzy_subsequence() {
        let filter = TableNameFilter {
            include_patterns: vec!["ads_cp%".to_string()],
            exclude_patterns: vec!["%_bak".to_string()],
        };

        assert!(table_name_filter_matches("ads_cp_report", Some(&filter)));
        assert!(!table_name_filter_matches("ads_180d_creator_detail_report_di", Some(&filter)));
        assert!(!table_name_filter_matches("ads_cp_report_bak", Some(&filter)));
    }

    #[test]
    fn table_name_filter_supports_escaped_like_wildcards() {
        let filter = TableNameFilter { include_patterns: vec![r"order\_%".to_string()], exclude_patterns: vec![] };

        assert!(table_name_filter_matches("order_items", Some(&filter)));
        assert!(!table_name_filter_matches("orderXitems", Some(&filter)));
    }

    #[test]
    fn table_name_filter_handles_adversarial_failing_like_pattern() {
        let filter = TableNameFilter { include_patterns: vec!["%a".repeat(128)], exclude_patterns: vec![] };

        assert!(!table_name_filter_matches(&"a".repeat(127), Some(&filter)));
    }

    #[test]
    fn filter_table_infos_filters_object_type_before_offset_and_limit() {
        let tables = vec![
            test_table_info("orders"),
            super::db::TableInfo {
                name: "active_orders".to_string(),
                table_type: "VIEW".to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            },
            test_table_info("users"),
            super::db::TableInfo {
                name: "active_users".to_string(),
                table_type: "VIEW".to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            },
        ];
        let object_types = vec!["VIEW".to_string()];

        let filtered = filter_table_infos(tables, None, Some(1), Some(1), Some(&object_types), None);

        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].name, "active_users");
    }

    #[test]
    fn filter_table_infos_pages_starrocks_materialized_views_independently() {
        let tables = vec![
            test_table_info("orders"),
            super::db::TableInfo {
                name: "orders_view".to_string(),
                table_type: "VIEW".to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            },
            super::db::TableInfo {
                name: "daily_orders_mv".to_string(),
                table_type: "MATERIALIZED_VIEW".to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            },
            super::db::TableInfo {
                name: "monthly_orders_mv".to_string(),
                table_type: "MATERIALIZED_VIEW".to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            },
        ];
        let object_types = vec!["MATERIALIZED_VIEW".to_string()];

        let filtered = filter_table_infos(tables, Some("orders"), Some(1), Some(1), Some(&object_types), None);

        assert_eq!(filtered.into_iter().map(|table| table.name).collect::<Vec<_>>(), vec!["monthly_orders_mv"]);
    }

    #[test]
    fn filter_object_infos_filters_object_type_before_offset_and_limit() {
        let objects = vec![
            test_object_info("sync_user", "PROCEDURE"),
            test_object_info("find_user", "FUNCTION"),
            test_object_info("fetch_name", "FUNCTION"),
            test_object_info("orders", "TABLE"),
        ];
        let object_types = vec!["FUNCTION".to_string()];

        let filtered = filter_object_infos(objects, Some("fn"), Some(1), Some(1), Some(&object_types));

        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].name, "fetch_name");
    }

    #[test]
    fn filter_object_infos_pages_starrocks_materialized_views_independently() {
        let objects = vec![
            test_object_info("orders", "TABLE"),
            test_object_info("orders_view", "VIEW"),
            test_object_info("daily_orders_mv", "MATERIALIZED_VIEW"),
            test_object_info("monthly_orders_mv", "MATERIALIZED_VIEW"),
        ];
        let object_types = vec!["MATERIALIZED_VIEW".to_string()];

        let filtered = filter_object_infos(objects, Some("orders"), Some(1), Some(1), Some(&object_types));

        assert_eq!(filtered.into_iter().map(|object| object.name).collect::<Vec<_>>(), vec!["monthly_orders_mv"]);
    }

    #[test]
    fn filter_object_infos_matches_comments() {
        let mut order_view = test_object_info("order_view", "VIEW");
        order_view.comment = Some("monthly revenue summary".to_string());
        let mut sync_user = test_object_info("sync_user", "PROCEDURE");
        sync_user.comment = Some("sync account records".to_string());
        let objects = vec![order_view, sync_user, test_object_info("audit_log", "TABLE")];

        let object_types = vec!["VIEW".to_string()];
        let filtered = filter_object_infos(objects, Some("revenue"), None, None, Some(&object_types));

        assert_eq!(filtered.into_iter().map(|object| object.name).collect::<Vec<_>>(), vec!["order_view"]);
    }

    #[test]
    fn presto_like_information_schema_sql_uses_catalog_and_schema_without_system_jdbc() {
        let sql = presto_like_information_schema_tables_sql("hive", "sales_analytics", None, None);

        assert_eq!(
            sql,
            "SELECT table_name, CASE table_type WHEN 'BASE TABLE' THEN 'TABLE' ELSE table_type END AS table_type FROM \"hive\".information_schema.tables WHERE table_schema = 'sales_analytics' AND table_type IN ('BASE TABLE', 'VIEW') ORDER BY table_type, table_name"
        );
        assert!(!sql.contains("system.jdbc.tables"));
    }

    #[test]
    fn presto_like_information_schema_sql_escapes_identifiers_and_literals() {
        let sql = presto_like_information_schema_tables_sql("hi\"ve", "sales'analytics", None, None);

        assert!(sql.contains("\"hi\"\"ve\".information_schema.tables"));
        assert!(sql.contains("table_schema = 'sales''analytics'"));
    }

    #[test]
    fn presto_like_information_schema_sql_pushes_table_filter_and_limit() {
        let sql = presto_like_information_schema_tables_sql("hive", "sales_analytics", Some("Daily_%\\"), Some(20));

        assert!(sql.contains("AND lower(table_name) LIKE 'daily\\_\\%\\\\%' ESCAPE '\\'"));
        assert!(sql.ends_with("ORDER BY table_type, table_name LIMIT 20"));
    }

    #[test]
    fn presto_like_information_schema_columns_sql_uses_catalog_information_schema() {
        let sql = presto_like_information_schema_columns_sql("hive", "sales_analytics", "daily_revenue");

        assert_eq!(
            sql,
            "SELECT column_name, data_type, is_nullable, column_default, comment FROM \"hive\".information_schema.columns WHERE table_schema = 'sales_analytics' AND table_name = 'daily_revenue' ORDER BY ordinal_position"
        );
        assert!(!sql.contains("system.jdbc.columns"));
    }

    #[test]
    fn presto_like_information_schema_columns_sql_escapes_identifiers_and_literals() {
        let sql = presto_like_information_schema_columns_sql("hi\"ve", "sales'analytics", "daily'revenue");

        assert!(sql.contains("\"hi\"\"ve\".information_schema.columns"));
        assert!(sql.contains("table_schema = 'sales''analytics'"));
        assert!(sql.contains("table_name = 'daily''revenue'"));
    }

    #[test]
    fn presto_like_tables_from_query_result_normalizes_base_table_type() {
        let result = super::db::QueryResult {
            columns: vec!["table_name".to_string(), "table_type".to_string()],
            column_types: vec![],
            column_sortables: vec![],
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: vec![
                vec![serde_json::json!("daily_revenue"), serde_json::json!("BASE TABLE")],
                vec![serde_json::json!("revenue_view"), serde_json::json!("VIEW")],
            ],
            affected_rows: 0,
            execution_time_ms: 1,
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages: Vec::new(),
        };

        let tables = presto_like_tables_from_query_result(&result);

        assert_eq!(tables[0].name, "daily_revenue");
        assert_eq!(tables[0].table_type, "TABLE");
        assert_eq!(tables[1].name, "revenue_view");
        assert_eq!(tables[1].table_type, "VIEW");
        assert_eq!(normalize_information_schema_table_type("MATERIALIZED VIEW"), "MATERIALIZED_VIEW");
    }

    #[test]
    fn presto_like_columns_from_query_result_maps_column_metadata() {
        let result = super::db::QueryResult {
            columns: vec![
                "column_name".to_string(),
                "data_type".to_string(),
                "is_nullable".to_string(),
                "column_default".to_string(),
                "comment".to_string(),
            ],
            column_types: vec![],
            column_sortables: vec![],
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: vec![
                vec![
                    serde_json::json!("amount"),
                    serde_json::json!("decimal(12,2)"),
                    serde_json::json!("NO"),
                    serde_json::Value::Null,
                    serde_json::json!("daily amount"),
                ],
                vec![
                    serde_json::json!("code"),
                    serde_json::json!("varchar(64)"),
                    serde_json::json!("YES"),
                    serde_json::Value::Null,
                    serde_json::Value::Null,
                ],
            ],
            affected_rows: 0,
            execution_time_ms: 1,
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages: Vec::new(),
        };

        let columns = presto_like_columns_from_query_result(&result);

        assert_eq!(columns[0].name, "amount");
        assert_eq!(columns[0].data_type, "decimal(12,2)");
        assert!(!columns[0].is_nullable);
        assert_eq!(columns[0].comment.as_deref(), Some("daily amount"));
        assert_eq!(columns[0].numeric_precision, Some(12));
        assert_eq!(columns[0].numeric_scale, Some(2));
        assert_eq!(columns[0].character_maximum_length, None);
        assert!(!columns[0].is_primary_key);
        assert_eq!(columns[1].name, "code");
        assert!(columns[1].is_nullable);
        assert_eq!(columns[1].numeric_precision, None);
        assert_eq!(columns[1].numeric_scale, None);
        assert_eq!(columns[1].character_maximum_length, Some(64));
    }

    #[test]
    fn detects_unsupported_agent_completion_assistant_errors() {
        assert!(super::is_agent_completion_assistant_unsupported(
            "Agent RPC error (-1): Unknown method: completion_assistant_search_v1"
        ));
        assert!(super::is_agent_completion_assistant_unsupported(
            "Agent RPC error (-1): unknown method: completion_assistant_search_v1"
        ));
        assert!(super::is_agent_completion_assistant_unsupported(
            "Agent RPC error (-1): Completion assistant search is not supported by this agent"
        ));
        assert!(!super::is_agent_completion_assistant_unsupported("Agent RPC error (-1): Connection failed"));
    }

    #[test]
    fn clickhouse_metadata_prefers_schema_qualifier() {
        assert_eq!(clickhouse_metadata_database("", "testdb"), "testdb");
        assert_eq!(clickhouse_metadata_database("testdb", ""), "testdb");
        // 查询元数据流程：database 是 tab 当前库，schema 是 SQL 限定的真实库
        assert_eq!(clickhouse_metadata_database("default", "testdb"), "testdb");
    }

    #[test]
    fn deduplicates_columns_and_preserves_later_comment() {
        let columns = deduplicate_column_infos(vec![
            test_column("ID", None, false),
            test_column("ID", Some("源主键"), true),
            test_column("TFBH", Some(""), false),
            test_column("TFBH", Some("台账编号"), false),
        ]);

        assert_eq!(columns.len(), 2);
        assert_eq!(columns[0].name, "ID");
        assert_eq!(columns[0].comment.as_deref(), Some("源主键"));
        assert!(columns[0].is_primary_key);
        assert_eq!(columns[1].name, "TFBH");
        assert_eq!(columns[1].comment.as_deref(), Some("台账编号"));
    }

    #[test]
    fn postgres_like_agent_metadata_fallback_targets_pg_compatible_agents() {
        assert!(!is_agent_postgres_metadata_fallback_config(&test_connection_config(DatabaseType::Kingbase)));
        assert!(is_agent_postgres_metadata_fallback_config(&test_connection_config(DatabaseType::Highgo)));
        assert!(is_agent_postgres_metadata_fallback_config(&test_connection_config(DatabaseType::Vastbase)));
        assert!(!is_agent_postgres_metadata_fallback_config(&test_connection_config(DatabaseType::Uxdb)));
        assert!(!is_agent_postgres_metadata_fallback_config(&test_connection_config(DatabaseType::Postgres)));
        assert!(!is_agent_postgres_metadata_fallback_config(&test_connection_config(DatabaseType::Mysql)));
    }

    #[test]
    fn agent_metadata_timeout_defaults_to_sixty_seconds_and_honors_longer_config() {
        assert_eq!(super::agent_metadata_timeout(None), Some(std::time::Duration::from_secs(60)));

        let mut config = test_connection_config(DatabaseType::Oracle);
        assert_eq!(super::agent_metadata_timeout(Some(&config)), Some(std::time::Duration::from_secs(60)));

        config.query_timeout_secs = 120;
        assert_eq!(super::agent_metadata_timeout(Some(&config)), Some(std::time::Duration::from_secs(120)));

        config.query_timeout_secs = 0;
        assert_eq!(super::agent_metadata_timeout(Some(&config)), None);
    }

    #[test]
    fn oracle_table_comment_sql_targets_single_table_and_escapes_literals() {
        let sql = oracle_table_comment_sql("APP'S", "USER'S");

        assert!(sql.contains("ALL_TAB_COMMENTS"));
        assert!(sql.contains("OWNER = 'APP''S'"));
        assert!(sql.contains("TABLE_NAME = 'USER''S'"));
        assert!(sql.contains("TABLE_TYPE IN ('TABLE', 'VIEW')"));
        assert!(!sql.contains("ALL_OBJECTS"));
    }

    #[test]
    fn tdengine_table_comment_sql_targets_one_name_and_escapes_literals() {
        let sql = tdengine_table_comment_sql("dbx's", "meter's");

        assert!(sql.contains("information_schema.ins_stables"));
        assert!(sql.contains("information_schema.ins_tables"));
        assert!(sql.contains("db_name = 'dbx''s'"));
        assert!(sql.contains("stable_name = 'meter''s'"));
        assert!(sql.contains("table_name = 'meter''s'"));
    }

    #[test]
    fn tdengine_table_comments_sql_only_queries_comments_matching_the_filter() {
        let sql = tdengine_table_comments_sql("dbx's", "s_%\\q");

        assert!(sql.contains("information_schema.ins_stables"));
        assert!(sql.contains("information_schema.ins_tables"));
        assert!(sql.contains("db_name = 'dbx''s'"));
        assert!(sql.contains("table_comment IS NOT NULL"));
        assert!(sql.contains("LOWER(table_comment) LIKE '%s%\\_%\\%%\\\\%q%'"));
        assert!(!sql.contains("LIMIT"));
    }

    #[test]
    fn tdengine_table_comment_pattern_respects_ascii_boundary() {
        let filter_49 = "a".repeat(49);
        let filter_50 = format!("{filter_49}b");
        let pattern_49 = tdengine_table_comment_like_pattern(&filter_49);
        let pattern_50 = tdengine_table_comment_like_pattern(&filter_50);

        assert_eq!(pattern_49.len(), 99);
        assert_eq!(pattern_50, pattern_49);
        assert!(pattern_50.len() <= TDENGINE_LIKE_PATTERN_MAX_BYTES);
        assert!(!metadata_name_or_comment_matches("table", Some(&filter_49), &filter_50));
    }

    #[test]
    fn tdengine_table_comment_pattern_keeps_escaped_fragments_within_limit() {
        assert_eq!(tdengine_table_comment_like_pattern("%_\\"), r"%\%%\_%\\%");

        let pattern_33 = tdengine_table_comment_like_pattern(&"%".repeat(33));
        let pattern_34 = tdengine_table_comment_like_pattern(&"%".repeat(34));
        assert_eq!(pattern_33.len(), TDENGINE_LIKE_PATTERN_MAX_BYTES);
        assert_eq!(pattern_34, pattern_33);
        assert!(pattern_34.ends_with('%'));
    }

    #[test]
    fn tdengine_table_comment_pattern_truncates_only_at_utf8_boundaries() {
        let pattern_24 = tdengine_table_comment_like_pattern(&"你".repeat(24));
        let pattern_25 = tdengine_table_comment_like_pattern(&"你".repeat(25));

        assert_eq!(pattern_24.len(), 97);
        assert_eq!(pattern_25, pattern_24);
        assert!(pattern_25.is_char_boundary(pattern_25.len()));
        assert!(pattern_25.len() <= TDENGINE_LIKE_PATTERN_MAX_BYTES);
    }

    #[test]
    fn tdengine_comment_search_uses_a_short_outer_deadline() {
        assert_eq!(TDENGINE_COMMENT_SEARCH_TIMEOUT, std::time::Duration::from_secs(5));
    }

    #[test]
    fn oracle_table_comment_from_query_result_returns_optional_non_blank_comment() {
        let result = db::QueryResult {
            columns: vec!["COMMENTS".to_string()],
            column_types: Vec::new(),
            column_sortables: Vec::new(),
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: vec![vec![serde_json::json!("Customer table")]],
            affected_rows: 0,
            execution_time_ms: 0,
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages: Vec::new(),
        };

        assert_eq!(oracle_table_comment_from_query_result(result).unwrap().as_deref(), Some("Customer table"));

        let empty = db::QueryResult {
            columns: vec!["COMMENTS".to_string()],
            column_types: Vec::new(),
            column_sortables: Vec::new(),
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: vec![vec![serde_json::json!("  ")]],
            affected_rows: 0,
            execution_time_ms: 0,
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages: Vec::new(),
        };

        assert_eq!(oracle_table_comment_from_query_result(empty).unwrap(), None);
    }

    #[test]
    fn oracle_table_comments_sql_targets_current_page_tables() {
        let sql = oracle_table_comments_sql("dbx_test", &["ORDERS".to_string(), "USER'S".to_string()]).unwrap();

        assert!(sql.contains("ALL_TAB_COMMENTS"));
        assert!(sql.contains("OWNER = 'DBX_TEST'"));
        assert!(sql.contains("TABLE_NAME IN ('ORDERS', 'USER''S')"));
        assert!(sql.contains("TABLE_TYPE IN ('TABLE', 'VIEW')"));
        assert!(sql.contains("COMMENTS IS NOT NULL"));
        assert_eq!(oracle_table_comments_sql("DBX_TEST", &[]), None);
    }

    #[test]
    fn table_comments_from_query_result_maps_non_blank_comments() {
        let result = db::QueryResult {
            columns: vec!["TABLE_NAME".to_string(), "COMMENTS".to_string()],
            column_types: Vec::new(),
            column_sortables: Vec::new(),
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: vec![
                vec![serde_json::json!("ORDERS"), serde_json::json!("Orders table")],
                vec![serde_json::json!("PRODUCTS"), serde_json::json!(" ")],
            ],
            affected_rows: 0,
            execution_time_ms: 0,
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages: Vec::new(),
        };

        let comments = table_comments_from_query_result(result);
        assert_eq!(comments.get("ORDERS").map(String::as_str), Some("Orders table"));
        assert!(!comments.contains_key("PRODUCTS"));
    }

    #[test]
    fn oracle_columns_sql_uses_exact_table_name_for_quoted_lowercase_tables() {
        let sql = oracle_columns_sql("DBX_TEST", "test");

        assert!(sql.contains("ALL_TAB_COLUMNS"));
        assert!(sql.contains("ALL_COL_COMMENTS"));
        assert!(sql.contains("o.OWNER = 'DBX_TEST'"));
        assert!(sql.contains("o.OBJECT_NAME = 'test'"));
        assert!(sql.contains("cols.OWNER = c.OWNER"));
        assert!(sql.contains("cols.TABLE_NAME = c.TABLE_NAME"));
        assert!(sql.contains("cm.OWNER = c.OWNER"));
    }

    #[test]
    fn oracle_columns_sql_resolves_private_and_public_synonyms_in_oracle_precedence_order() {
        let sql = oracle_columns_sql("", "ORDERS_ALIAS");

        assert!(sql.contains("SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')"));
        assert!(sql.contains("FROM ALL_SYNONYMS s"));
        assert!(sql.contains("s.OWNER IN (SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA'), 'PUBLIC')"));
        assert!(sql.contains("CASE WHEN sc.root_owner = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') THEN 1 ELSE 2 END"));
        assert!(sql.contains("s.DB_LINK IS NULL"));
        assert!(sql.contains("ORDER BY resolution_priority, synonym_depth"));
        assert!(sql.contains("WHERE ROWNUM = 1"));
    }

    #[test]
    fn oracle_columns_sql_follows_two_level_synonyms_without_cycles() {
        let sql = oracle_columns_sql("DBX_TEST", "ORDERS_ALIAS");

        assert!(sql.contains("SELECT CONNECT_BY_ROOT s.OWNER AS root_owner"));
        assert!(sql.contains("LEVEL AS synonym_depth"));
        assert!(sql.contains("CONNECT BY NOCYCLE"));
        assert!(sql.contains("PRIOR s.TABLE_OWNER = s.OWNER"));
        assert!(sql.contains("PRIOR s.TABLE_NAME = s.SYNONYM_NAME"));
        assert!(sql.contains("JOIN ALL_OBJECTS o"));
        assert!(sql.contains("o.OWNER = sc.resolved_owner"));
        assert!(sql.contains("o.OBJECT_NAME = sc.resolved_table"));
    }

    #[test]
    fn oracle_columns_sql_preserves_quoted_case_synonym_names_and_excludes_database_links() {
        let sql = oracle_columns_sql("DBX_TEST", "Order Alias");

        assert!(sql.contains("s.SYNONYM_NAME = 'Order Alias'"));
        assert!(sql.contains("o.OBJECT_NAME = 'Order Alias'"));
        assert!(!sql.contains("ORDER ALIAS"));
        assert_eq!(sql.matches("s.DB_LINK IS NULL").count(), 2);
    }

    #[test]
    fn oracle_session_completion_queries_synonym_aware_columns_sql_first() {
        assert!(should_query_oracle_columns_via_sql_first(&DatabaseType::Oracle, "", Some("tab-1")));
        assert!(should_query_oracle_columns_via_sql_first(&DatabaseType::Oracle, "   ", Some("tab-1")));
    }

    #[test]
    fn oracle_columns_sql_first_is_limited_to_current_schema_editor_sessions() {
        assert!(!should_query_oracle_columns_via_sql_first(&DatabaseType::Oracle, "DBX_TEST", Some("tab-1")));
        assert!(!should_query_oracle_columns_via_sql_first(&DatabaseType::Oracle, "", None));
        assert!(!should_query_oracle_columns_via_sql_first(&DatabaseType::Oracle, "", Some("  ")));
        assert!(!should_query_oracle_columns_via_sql_first(&DatabaseType::Postgres, "", Some("tab-1")));
    }

    #[test]
    fn oracle_columns_from_query_result_maps_types_comments_and_primary_key() {
        let result = db::QueryResult {
            columns: vec![
                "COLUMN_NAME".to_string(),
                "DATA_TYPE".to_string(),
                "NULLABLE".to_string(),
                "DATA_DEFAULT".to_string(),
                "DATA_LENGTH".to_string(),
                "DATA_PRECISION".to_string(),
                "DATA_SCALE".to_string(),
                "COLUMN_ID".to_string(),
                "IS_PK".to_string(),
                "COMMENTS".to_string(),
            ],
            column_types: Vec::new(),
            column_sortables: Vec::new(),
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: vec![
                vec![
                    serde_json::json!("id"),
                    serde_json::json!("VARCHAR2"),
                    serde_json::json!("N"),
                    serde_json::Value::Null,
                    serde_json::json!("255"),
                    serde_json::Value::Null,
                    serde_json::Value::Null,
                    serde_json::json!("1"),
                    serde_json::json!("1"),
                    serde_json::json!("identifier"),
                ],
                vec![
                    serde_json::json!("data"),
                    serde_json::json!("TIMESTAMP"),
                    serde_json::json!("Y"),
                    serde_json::Value::Null,
                    serde_json::Value::Null,
                    serde_json::Value::Null,
                    serde_json::Value::Null,
                    serde_json::json!("2"),
                    serde_json::json!("0"),
                    serde_json::Value::Null,
                ],
            ],
            affected_rows: 0,
            execution_time_ms: 0,
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages: Vec::new(),
        };

        let columns = oracle_columns_from_query_result(result);

        assert_eq!(columns.len(), 2);
        assert_eq!(columns[0].name, "id");
        assert_eq!(columns[0].data_type, "VARCHAR2(255)");
        assert!(!columns[0].is_nullable);
        assert!(columns[0].is_primary_key);
        assert_eq!(columns[0].comment.as_deref(), Some("identifier"));
        assert_eq!(columns[1].name, "data");
        assert_eq!(columns[1].data_type, "TIMESTAMP");
        assert!(columns[1].is_nullable);
    }

    #[test]
    fn oracle_object_statistics_sql_reads_rows_and_segment_bytes() {
        let sql = oracle_object_statistics_sql("app's");

        assert!(sql.contains("ALL_TABLES"));
        assert!(sql.contains("ALL_SEGMENTS"));
        assert!(sql.contains("ALL_INDEXES"));
        assert!(sql.contains("ALL_LOBS"));
        assert!(sql.contains("t.NUM_ROWS"));
        assert!(sql.contains("OWNER = 'APP''S'"));
        assert!(sql.contains("t.NESTED = 'NO'"));

        let dba_sql = oracle_object_statistics_dba_segments_sql("app's");
        assert!(dba_sql.contains("DBA_SEGMENTS"));
        assert!(!dba_sql.contains("ALL_SEGMENTS"));

        let user_sql = oracle_object_statistics_user_segments_sql("app's");
        assert!(user_sql.contains("USER_SEGMENTS"));
        assert!(user_sql.contains("OWNER = 'APP''S'"));
        assert!(user_sql.contains("t.OWNER = USER"));
        assert!(!user_sql.contains("CURRENT_SCHEMA"));

        let rows_only_sql = oracle_object_statistics_rows_only_sql("app's");
        assert!(rows_only_sql.contains("ALL_TABLES"));
        assert!(rows_only_sql.contains("CAST(NULL AS NUMBER) AS TOTAL_BYTES"));
        assert!(!rows_only_sql.contains("ALL_SEGMENTS"));
    }

    #[test]
    fn dameng_object_statistics_sql_uses_available_segment_views() {
        let dba_sql = dameng_object_statistics_dba_segments_sql("app's");
        assert!(dba_sql.contains("DBA_SEGMENTS"));
        assert!(dba_sql.contains("ALL_INDEXES"));
        assert!(!dba_sql.contains("ALL_SEGMENTS"));
        assert!(!dba_sql.contains("ALL_LOBS"));
        assert!(dba_sql.contains("OWNER = 'APP''S'"));
        assert!(dba_sql.contains("t.NESTED IS NULL OR t.NESTED = 'NO'"));

        let user_sql = dameng_object_statistics_user_segments_sql("app's");
        assert!(user_sql.contains("USER_SEGMENTS"));
        assert!(user_sql.contains("t.OWNER = USER"));

        let rows_only_sql = dameng_object_statistics_rows_only_sql("app's");
        assert!(rows_only_sql.contains("CAST(NULL AS NUMBER) AS TOTAL_BYTES"));
        assert!(!rows_only_sql.contains("SEGMENTS"));
    }

    #[test]
    fn gbase8a_object_statistics_sql_uses_information_schema() {
        let gbase_sql = gbase8a_object_statistics_sql("shop's");
        assert!(gbase_sql.contains("information_schema.TABLES"));
        assert!(gbase_sql.contains("DATA_LENGTH"));
        assert!(gbase_sql.contains("INDEX_LENGTH"));
        assert!(gbase_sql.contains("TABLE_SCHEMA = 'shop''s'"));
    }

    #[test]
    fn oracle_object_statistics_from_query_result_maps_numbers() {
        let result = db::QueryResult {
            columns: vec![
                "TABLE_NAME".to_string(),
                "OWNER".to_string(),
                "NUM_ROWS".to_string(),
                "TOTAL_BYTES".to_string(),
            ],
            column_types: Vec::new(),
            column_sortables: Vec::new(),
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: vec![
                vec![
                    serde_json::json!("ORDERS"),
                    serde_json::json!("APP"),
                    serde_json::json!("1200"),
                    serde_json::json!(65536),
                ],
                vec![
                    serde_json::json!("AUDIT_LOG"),
                    serde_json::json!("APP"),
                    serde_json::Value::Null,
                    serde_json::json!("8192"),
                ],
            ],
            affected_rows: 0,
            execution_time_ms: 0,
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages: Vec::new(),
        };

        let stats = oracle_object_statistics_from_query_result(result);

        assert_eq!(stats.len(), 2);
        assert_eq!(stats[0].name, "ORDERS");
        assert_eq!(stats[0].schema.as_deref(), Some("APP"));
        assert_eq!(stats[0].estimated_rows, Some(1200));
        assert_eq!(stats[0].total_bytes, Some(65536));
        assert_eq!(stats[1].estimated_rows, None);
        assert_eq!(stats[1].total_bytes, Some(8192));
    }

    #[test]
    fn apply_table_comments_only_fills_missing_table_comments() {
        let mut tables = vec![
            super::db::TableInfo {
                name: "ORDERS".to_string(),
                table_type: "TABLE".to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            },
            super::db::TableInfo {
                name: "PRODUCTS".to_string(),
                table_type: "TABLE".to_string(),
                comment: Some("Existing".to_string()),
                parent_schema: None,
                parent_name: None,
            },
        ];
        let comments = HashMap::from([
            ("ORDERS".to_string(), "Orders table".to_string()),
            ("PRODUCTS".to_string(), "Products table".to_string()),
        ]);

        super::apply_table_comments(&mut tables, &comments);

        assert_eq!(tables[0].comment.as_deref(), Some("Orders table"));
        assert_eq!(tables[1].comment.as_deref(), Some("Existing"));
    }

    #[test]
    fn oracle_missing_object_table_comment_names_only_includes_tables_and_views() {
        let objects = vec![
            super::db::ObjectInfo {
                name: "ORDERS".to_string(),
                object_type: "TABLE".to_string(),
                schema: Some("DBX_TEST".to_string()),
                valid: None,
                signature: None,
                custom_type_kind: None,
                has_members: None,
                comment: None,
                created_at: None,
                updated_at: None,
                parent_schema: None,
                parent_name: None,
                trigger: None,
                xugu_type_members_expandable: None,
            },
            super::db::ObjectInfo {
                name: "ORDERS_VIEW".to_string(),
                object_type: "VIEW".to_string(),
                schema: Some("DBX_TEST".to_string()),
                valid: None,
                signature: None,
                custom_type_kind: None,
                has_members: None,
                comment: None,
                created_at: None,
                updated_at: None,
                parent_schema: None,
                parent_name: None,
                trigger: None,
                xugu_type_members_expandable: None,
            },
            super::db::ObjectInfo {
                name: "REFRESH_ORDERS".to_string(),
                object_type: "PROCEDURE".to_string(),
                schema: Some("DBX_TEST".to_string()),
                valid: None,
                signature: None,
                custom_type_kind: None,
                has_members: None,
                comment: None,
                created_at: None,
                updated_at: None,
                parent_schema: None,
                parent_name: None,
                trigger: None,
                xugu_type_members_expandable: None,
            },
        ];

        assert_eq!(
            super::oracle_missing_object_table_comment_names(&objects),
            vec!["ORDERS".to_string(), "ORDERS_VIEW".to_string()]
        );
    }

    #[test]
    fn doris_family_catalog_capable_matches_doris_and_starrocks_only() {
        // Doris and StarRocks expose multi-catalog federation.
        assert!(super::is_doris_family_catalog_capable_config(&test_connection_config(DatabaseType::Doris)));
        assert!(super::is_doris_family_catalog_capable_config(&test_connection_config(DatabaseType::StarRocks)));

        // Driver profiles for Doris/SelectDB/StarRocks also qualify.
        let mut doris = test_connection_config(DatabaseType::Mysql);
        doris.driver_profile = Some("doris".to_string());
        assert!(super::is_doris_family_catalog_capable_config(&doris));

        let mut selectdb = test_connection_config(DatabaseType::Mysql);
        selectdb.driver_profile = Some("selectdb".to_string());
        assert!(super::is_doris_family_catalog_capable_config(&selectdb));

        let mut starrocks = test_connection_config(DatabaseType::Mysql);
        starrocks.driver_profile = Some("starrocks".to_string());
        assert!(super::is_doris_family_catalog_capable_config(&starrocks));

        // ManticoreSearch shares the MySQL code path but has no catalog concept.
        assert!(!super::is_doris_family_catalog_capable_config(&test_connection_config(DatabaseType::ManticoreSearch)));

        let mut manticore = test_connection_config(DatabaseType::Mysql);
        manticore.driver_profile = Some("manticoresearch".to_string());
        assert!(!super::is_doris_family_catalog_capable_config(&manticore));

        // Plain MySQL / Postgres are not catalog-capable.
        assert!(!super::is_doris_family_catalog_capable_config(&test_connection_config(DatabaseType::Mysql)));
        assert!(!super::is_doris_family_catalog_capable_config(&test_connection_config(DatabaseType::Postgres)));
    }
}

pub async fn list_objects_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    filter: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
    object_types: Option<&[String]>,
) -> Result<Vec<db::ObjectInfo>, String> {
    let db_config = connection_config(state, connection_id).await;
    let filter_locally_after_oracle_comments = db_config.as_ref().is_some_and(|config| {
        config.db_type == DatabaseType::Oracle && filter.is_some_and(|filter| !filter.trim().is_empty())
    });
    let use_oracle_agent_paging =
        db_config.as_ref().is_some_and(is_default_oracle_agent_config) && !filter_locally_after_oracle_comments;
    let metadata_session = EphemeralAgentMetadataSession::open(state, connection_id, Some(database), "objects").await;
    let result = retry_metadata_connection_for_session(
        state,
        connection_id,
        Some(database),
        metadata_session.client_session_id(),
        || async {
            let objects = list_objects_once(
                state,
                connection_id,
                database,
                schema,
                filter,
                limit,
                offset,
                object_types,
                metadata_session.client_session_id(),
            )
            .await
            .map(|outcome| {
                let final_offset = if outcome.paging_applied
                    || agent_paging_likely_applied(use_oracle_agent_paging, limit, outcome.objects.len())
                {
                    Some(0)
                } else {
                    offset
                };
                filter_object_infos(outcome.objects, filter, limit, final_offset, object_types)
            })?;
            Ok(objects)
        },
    )
    .await;
    metadata_session.finish(state, connection_id, Some(database)).await;
    result
}

pub async fn list_object_statistics_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
) -> Result<Vec<db::ObjectStatistics>, String> {
    retry_metadata_connection(state, connection_id, Some(database), || {
        list_object_statistics_once(state, connection_id, database, schema)
    })
    .await
}

pub async fn list_completion_objects_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
) -> Result<Vec<db::ObjectInfo>, String> {
    let metadata_session =
        EphemeralAgentMetadataSession::open(state, connection_id, Some(database), "completion-objects").await;
    let result = retry_metadata_connection_for_session(
        state,
        connection_id,
        Some(database),
        metadata_session.client_session_id(),
        || list_completion_objects_once(state, connection_id, database, schema, metadata_session.client_session_id()),
    )
    .await;
    metadata_session.finish(state, connection_id, Some(database)).await;
    result
}

fn ephemeral_agent_metadata_session_id(config: Option<&ConnectionConfig>, task_kind: &str) -> Option<String> {
    config
        .filter(|config| crate::database_capabilities::is_agent_type(&config.db_type))
        .map(|_| task_client_session_id(task_kind, &uuid::Uuid::new_v4().to_string()))
}

async fn close_ephemeral_agent_metadata_session(
    state: &AppState,
    connection_id: &str,
    database: Option<&str>,
    client_session_id: Option<&str>,
) -> bool {
    let Some(client_session_id) = client_session_id else {
        return true;
    };
    match state.close_metadata_session_pool(connection_id, database, client_session_id).await {
        Ok(_) => true,
        Err(error) => {
            log::warn!(
                "Failed to close ephemeral Agent metadata session '{client_session_id}' for '{connection_id}': {error}"
            );
            false
        }
    }
}

pub async fn completion_assistant_search_core(
    state: &AppState,
    request: db::CompletionAssistantRequest,
) -> Result<db::CompletionAssistantResponse, String> {
    let started_at = Instant::now();
    let request_summary = format!(
        "connection_id={} database={} schema={:?} kinds={:?} mask={} limit={:?}",
        request.connection_id,
        request.database,
        request.schema,
        request.object_kinds,
        request.mask,
        request.max_results
    );
    retry_metadata_connection(state, &request.connection_id, Some(&request.database), || async {
        let pool_key = state
            .get_or_create_metadata_pool_for_session(&request.connection_id, Some(&request.database), None)
            .await?;
        log::debug!("[schema][completion_assistant:start] {request_summary}");
        {
            let connections = state.connections.read().await;
            try_sqlserver!(connections, &pool_key, completion_assistant_search, &request);
        }

        {
            let connections = state.connections.read().await;
            if let Some(pool) = connections.get(&pool_key).and_then(|pool| match pool {
                PoolKind::Sqlite(pool) => Some(pool.clone()),
                _ => None,
            }) {
                drop(connections);
                return db::sqlite::completion_assistant_search(&pool, &request).await;
            }
        }

        #[cfg(feature = "duckdb-sidecar")]
        {
            let connections = state.connections.read().await;
            if let Some(client) = extract_pool!(&connections, &pool_key, DuckDbWorker) {
                drop(connections);
                return client.completion_assistant(request.clone()).await;
            }
        }

        {
            let connections = state.connections.read().await;
            if let Some(pool) = connections.get(&pool_key).and_then(|pool| match pool {
                PoolKind::Postgres(pool) => Some(pool.clone()),
                _ => None,
            }) {
                drop(connections);
                return db::postgres::completion_assistant_search(&pool, &request).await;
            }
        }

        {
            let connections = state.connections.read().await;
            if let Some(pool) = connections.get(&pool_key).and_then(|pool| match pool {
                PoolKind::Mysql(pool, mode) if *mode != MysqlMode::OceanBaseOracle => Some(pool.clone()),
                _ => None,
            }) {
                drop(connections);
                return db::mysql::completion_assistant_search(&pool, &request).await;
            }
        }

        {
            let connections = state.connections.read().await;
            if let Some(client) = extract_pool!(&connections, &pool_key, Agent) {
                let db_config = connection_config(state, &request.connection_id).await;
                drop(connections);
                let mut client = client.lock().await;
                match client
                    .completion_assistant_search::<db::CompletionAssistantResponse>(
                        &request,
                        agent_metadata_timeout(db_config.as_ref()),
                    )
                    .await
                {
                    Ok(mut response) => {
                        response.fallback_used = false;
                        return Ok(response);
                    }
                    Err(error) if is_agent_completion_assistant_unsupported(&error) => {
                        log::debug!(
                            "[schema][completion_assistant:agent-fallback] {} reason={}",
                            request_summary,
                            error
                        );
                    }
                    Err(error) => return Err(error),
                }
            }
        }

        let response = completion_assistant_fallback_core(state, &request).await;
        if let Ok(response) = &response {
            log::debug!(
                "[schema][completion_assistant:done] {} elapsed_ms={} candidates={} fallback_used={}",
                request_summary,
                started_at.elapsed().as_millis(),
                response.candidates.len(),
                response.fallback_used
            );
        }
        response
    })
    .await
}

fn is_agent_completion_assistant_unsupported(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("unknown method: completion_assistant_search_v1")
        || error.contains("method not found: completion_assistant_search_v1")
        || error.contains("completion assistant search is not supported")
}

async fn completion_assistant_fallback_core(
    state: &AppState,
    request: &db::CompletionAssistantRequest,
) -> Result<db::CompletionAssistantResponse, String> {
    let limit = request.max_results.unwrap_or(100).clamp(1, 1000);
    let kinds = if request.object_kinds.is_empty() {
        vec![db::CompletionAssistantObjectKind::Table, db::CompletionAssistantObjectKind::View]
    } else {
        request.object_kinds.clone()
    };
    let mut candidates = Vec::new();
    let schema = request.parent_schema.as_deref().or(request.schema.as_deref()).unwrap_or("");
    let filter = request.mask.trim().trim_matches('%');

    if kinds.iter().any(|kind| matches!(kind, db::CompletionAssistantObjectKind::Schema)) {
        let schemas = list_schemas_core(state, &request.connection_id, &request.database).await?;
        for schema_name in schemas {
            if completion_name_matches(&schema_name, filter, request.match_mode.as_ref()) {
                candidates.push(db::CompletionAssistantCandidate {
                    name: schema_name.clone(),
                    kind: db::CompletionAssistantCandidateKind::Schema,
                    database: Some(request.database.clone()),
                    schema: Some(schema_name),
                    parent_schema: None,
                    parent_name: None,
                    comment: None,
                    data_type: None,
                    signature: None,
                });
            }
            if candidates.len() >= limit {
                return Ok(db::CompletionAssistantResponse { candidates, incomplete: true, fallback_used: true });
            }
        }
    }

    if kinds.iter().any(db::CompletionAssistantObjectKind::is_table_like) {
        let object_types = completion_table_object_types(&kinds);
        let tables = list_tables_core(
            state,
            &request.connection_id,
            &request.database,
            schema,
            if filter.is_empty() { None } else { Some(filter) },
            Some(limit),
            None,
            object_types.as_deref(),
            None,
        )
        .await?;
        for table in tables {
            let kind = if table.table_type.to_uppercase().contains("VIEW") {
                db::CompletionAssistantCandidateKind::View
            } else {
                db::CompletionAssistantCandidateKind::Table
            };
            candidates.push(db::CompletionAssistantCandidate {
                name: table.name,
                kind,
                database: Some(request.database.clone()),
                schema: if schema.is_empty() { None } else { Some(schema.to_string()) },
                parent_schema: table.parent_schema,
                parent_name: table.parent_name,
                comment: table.comment,
                data_type: None,
                signature: None,
            });
            if candidates.len() >= limit {
                return Ok(db::CompletionAssistantResponse { candidates, incomplete: true, fallback_used: true });
            }
        }
    }

    if kinds.iter().any(|kind| matches!(kind, db::CompletionAssistantObjectKind::Column)) {
        if let Some(table) = request.parent_name.as_deref().filter(|table| !table.trim().is_empty()) {
            let columns = get_columns_core(state, &request.connection_id, &request.database, schema, table).await?;
            for column in columns {
                if completion_name_matches(&column.name, filter, request.match_mode.as_ref()) {
                    candidates.push(db::CompletionAssistantCandidate {
                        name: column.name,
                        kind: db::CompletionAssistantCandidateKind::Column,
                        database: Some(request.database.clone()),
                        schema: if schema.is_empty() { None } else { Some(schema.to_string()) },
                        parent_schema: if schema.is_empty() { None } else { Some(schema.to_string()) },
                        parent_name: Some(table.to_string()),
                        comment: column.comment,
                        data_type: Some(column.data_type),
                        signature: None,
                    });
                }
                if candidates.len() >= limit {
                    return Ok(db::CompletionAssistantResponse { candidates, incomplete: true, fallback_used: true });
                }
            }
        }
    }

    Ok(db::CompletionAssistantResponse { candidates, incomplete: false, fallback_used: true })
}

fn completion_table_object_types(kinds: &[db::CompletionAssistantObjectKind]) -> Option<Vec<String>> {
    let mut object_types = Vec::new();
    if kinds.iter().any(|kind| matches!(kind, db::CompletionAssistantObjectKind::Table)) {
        object_types.push("table".to_string());
    }
    if kinds.iter().any(|kind| matches!(kind, db::CompletionAssistantObjectKind::View)) {
        object_types.push("view".to_string());
    }
    if object_types.is_empty() {
        None
    } else {
        Some(object_types)
    }
}

fn completion_name_matches(name: &str, filter: &str, mode: Option<&db::CompletionAssistantMatchMode>) -> bool {
    if filter.is_empty() {
        return true;
    }
    let name = name.to_lowercase();
    let filter = filter.to_lowercase();
    match mode.unwrap_or(&db::CompletionAssistantMatchMode::Prefix) {
        db::CompletionAssistantMatchMode::Prefix => name.starts_with(&filter),
        db::CompletionAssistantMatchMode::Contains => name.contains(&filter),
    }
}

async fn list_object_statistics_once(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
) -> Result<Vec<db::ObjectStatistics>, String> {
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
    let db_config = connection_config(state, connection_id).await;
    let connections = state.connections.read().await;
    try_sqlserver!(connections, &pool_key, list_object_statistics, schema);
    if let Some(client) = extract_pool!(&connections, &pool_key, Agent) {
        if db_config.as_ref().is_some_and(|config| config.db_type == DatabaseType::Oracle) {
            drop(connections);
            return oracle_agent_list_object_statistics(
                client,
                database,
                schema,
                agent_metadata_timeout(db_config.as_ref()),
            )
            .await;
        }
        if db_config.as_ref().is_some_and(|config| config.db_type == DatabaseType::Dameng) {
            drop(connections);
            return dameng_agent_list_object_statistics(
                client,
                database,
                schema,
                agent_metadata_timeout(db_config.as_ref()),
            )
            .await;
        }
        if db_config.as_ref().is_some_and(|config| config.db_type == DatabaseType::Kingbase) {
            let sql = kingbase::object_statistics_sql(schema);
            drop(connections);
            return agent_list_object_statistics(
                client,
                database,
                schema,
                sql,
                agent_metadata_timeout(db_config.as_ref()),
            )
            .await;
        }
        if db_config.as_ref().is_some_and(|config| {
            config.db_type == DatabaseType::Gbase && config.driver_profile.as_deref() != Some("gbase8s")
        }) {
            let sql = gbase8a_object_statistics_sql(database);
            drop(connections);
            return agent_list_object_statistics(
                client,
                database,
                schema,
                sql,
                agent_metadata_timeout(db_config.as_ref()),
            )
            .await;
        }
    }
    if let Some(client) = extract_pool!(&connections, &pool_key, VictoriaMetrics) {
        drop(connections);
        return db::victoriametrics_driver::list_object_statistics(&client).await;
    }
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;
    match pool {
        PoolKind::Mysql(p, mode) => {
            if *mode == MysqlMode::OceanBaseOracle || db_config.as_ref().is_some_and(is_manticoresearch_config) {
                Ok(vec![])
            } else {
                db::mysql::list_object_statistics(p, database).await
            }
        }
        PoolKind::Postgres(p) if db_config.as_ref().is_some_and(is_questdb_config) => Ok(vec![]),
        PoolKind::Postgres(p) => db::postgres::list_object_statistics(p, schema).await,
        PoolKind::ClickHouse(client) => {
            db::clickhouse_driver::list_object_statistics(client, clickhouse_metadata_database(database, schema)).await
        }
        _ => Ok(vec![]),
    }
}

struct ObjectListOutcome {
    objects: Vec<db::ObjectInfo>,
    paging_applied: bool,
}

fn unpaged_object_list(objects: Vec<db::ObjectInfo>) -> ObjectListOutcome {
    ObjectListOutcome { objects, paging_applied: false }
}

async fn list_objects_once(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    filter: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
    object_types: Option<&[String]>,
    client_session_id: Option<&str>,
) -> Result<ObjectListOutcome, String> {
    let pool_key =
        state.get_or_create_metadata_pool_for_session(connection_id, Some(database), client_session_id).await?;
    let db_config = connection_config(state, connection_id).await;
    let (mysql_limit, mysql_offset) =
        if filter.is_none_or(|value| value.trim().is_empty()) { (limit, offset) } else { (None, None) };

    {
        let connections = state.connections.read().await;
        if let Some(PoolKind::ExternalDriver { config, session, .. }) = connections.get(&pool_key) {
            let config = config.clone();
            let session = session.clone();
            drop(connections);
            if uses_presto_like_information_schema_tables(&config.db_type) {
                return external_driver_presto_like_objects(
                    session,
                    config.as_ref(),
                    database,
                    schema,
                    filter,
                    object_types,
                )
                .await
                .map(unpaged_object_list);
            }
            let mut params =
                serde_json::json!({ "connection": config.as_ref(), "database": database, "schema": schema });
            if let Some(filter) = filter.map(str::trim).filter(|value| !value.is_empty()) {
                params["filter"] = serde_json::json!(filter);
            }
            if let Some(object_types) = object_types {
                params["object_types"] = serde_json::json!(object_types);
            }
            return session
                .invoke_with_timeout::<Vec<db::ObjectInfo>>(
                    "listObjects",
                    params,
                    agent_metadata_timeout(Some(config.as_ref())),
                )
                .await
                .map(unpaged_object_list);
        }
        if let Some(client) = extract_pool!(&connections, &pool_key, SqlServer) {
            drop(connections);
            let mut client = client.lock().await;
            return db::sqlserver::list_objects(&mut client, schema).await.map(unpaged_object_list);
        }
        if let Some(client) = extract_pool!(&connections, &pool_key, Agent) {
            let is_oracle = db_config.as_ref().is_some_and(|config| config.db_type == DatabaseType::Oracle);
            let use_oracle_agent_paging = db_config.as_ref().is_some_and(is_default_oracle_agent_config);
            let filter_locally_after_oracle_comments =
                is_oracle && filter.is_some_and(|filter| !filter.trim().is_empty());
            let timeout_duration = agent_metadata_timeout(db_config.as_ref());
            let fallback_config = db_config.clone();
            drop(connections);
            if is_oracle && !use_oracle_agent_paging {
                return oracle_agent_list_objects(client, database, schema, timeout_duration)
                    .await
                    .map(unpaged_object_list);
            }
            let mut client = client.lock().await;
            let agent_filter = if filter_locally_after_oracle_comments { None } else { filter };
            let agent_limit = if filter_locally_after_oracle_comments {
                None
            } else if use_oracle_agent_paging {
                limit
            } else {
                None
            };
            let agent_offset = if filter_locally_after_oracle_comments {
                None
            } else if use_oracle_agent_paging {
                offset
            } else {
                None
            };
            match client
                .list_objects_constrained::<Vec<db::ObjectInfo>>(
                    database,
                    schema,
                    agent_filter,
                    agent_limit,
                    agent_offset,
                    object_types,
                    timeout_duration,
                )
                .await
            {
                Ok(mut objects) if !objects.is_empty() => {
                    if is_oracle {
                        load_oracle_table_comments_for_objects(
                            &mut client,
                            database,
                            schema,
                            &mut objects,
                            timeout_duration,
                        )
                        .await?;
                    }
                    return Ok(unpaged_object_list(objects));
                }
                Ok(objects) => {
                    if object_types_only_custom_types(object_types) {
                        // A dedicated type request: the agent is authoritative.
                        // The native fallback never lists types, so running it
                        // would turn a real empty schema or a catalog error into
                        // a misleading empty type group.
                        return Ok(unpaged_object_list(objects));
                    }
                    if let Some(config) = fallback_config.as_ref() {
                        match native_postgres_metadata_pool(state, connection_id, database, config).await {
                            Ok(Some(pool)) => {
                                return db::postgres::list_objects(&pool, schema, true, true, false)
                                    .await
                                    .map(unpaged_object_list)
                            }
                            Ok(None) => return Ok(unpaged_object_list(objects)),
                            Err(error) => {
                                log::warn!(
                                    "[schema][agent:list_objects:fallback-failed] connection_id={} database={} schema={} error={}",
                                    connection_id,
                                    database,
                                    schema,
                                    error
                                );
                            }
                        }
                    }
                    return Ok(unpaged_object_list(objects));
                }
                Err(agent_error) => {
                    if object_types_only_custom_types(object_types) {
                        // Preserve the type catalog error instead of masking it
                        // with a relation/function fallback that cannot serve
                        // user-defined types.
                        return Err(agent_error);
                    }
                    if let Some(config) = fallback_config.as_ref() {
                        if let Some(pool) =
                            native_postgres_metadata_pool(state, connection_id, database, config).await?
                        {
                            return db::postgres::list_objects(&pool, schema, true, true, false)
                                .await
                                .map(unpaged_object_list)
                                .map_err(|fallback_error| {
                                    crate::db::agent_driver::append_legacy_error_context(
                                        &agent_error,
                                        &format!("Native PostgreSQL metadata fallback failed: {fallback_error}"),
                                    )
                                });
                        }
                    }
                    return Err(agent_error);
                }
            }
        }
    }

    let connections = state.connections.read().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;

    match pool {
        PoolKind::Mysql(p, mode) => {
            // Note: mysql and ob_oracle take different second args (database vs schema)
            if *mode == MysqlMode::OceanBaseOracle {
                db::ob_oracle::list_objects(p, schema).await.map(unpaged_object_list)
            } else if db_config.as_ref().is_some_and(is_manticoresearch_config) {
                db::manticoresearch::list_objects(p, database).await.map(unpaged_object_list)
            } else if db_config.as_ref().is_some_and(is_starrocks_config) {
                db::mysql::list_starrocks_table_objects(p, database).await.map(unpaged_object_list)
            } else if db_config.as_ref().is_some_and(is_doris_family_config) {
                db::mysql::list_table_objects_show(p, database).await.map(unpaged_object_list)
            } else {
                db::mysql::list_objects(p, database, object_types, mysql_limit, mysql_offset)
                    .await
                    .map(|result| ObjectListOutcome { objects: result.objects, paging_applied: result.paging_applied })
            }
        }
        PoolKind::Postgres(p) if db_config.as_ref().is_some_and(is_questdb_config) => {
            db::questdb::list_objects(p, schema).await.map(unpaged_object_list)
        }
        PoolKind::Postgres(p) if db_config.as_ref().is_some_and(is_cloudberry_config) => {
            db::cloudberry::list_objects(p, schema).await.map(unpaged_object_list)
        }
        PoolKind::Postgres(p) => {
            let include_relations = object_types_include_relations(object_types);
            let include_routines = object_types_include_routines(object_types);
            let include_custom_types = db_config.as_ref().is_some_and(supports_pg_custom_type_objects)
                && object_types_include_custom_types(object_types);
            db::postgres::list_objects(p, schema, include_relations, include_routines, include_custom_types)
                .await
                .map(unpaged_object_list)
        }
        _ => {
            drop(connections);
            Ok(unpaged_object_list(
                list_tables_core(state, connection_id, database, schema, None, None, None, None, None)
                    .await?
                    .into_iter()
                    .map(|table| db::ObjectInfo {
                        name: table.name,
                        object_type: table.table_type,
                        schema: if schema.is_empty() { None } else { Some(schema.to_string()) },
                        valid: None,
                        signature: None,
                        custom_type_kind: None,
                        has_members: None,
                        comment: table.comment,
                        created_at: None,
                        updated_at: None,
                        parent_schema: table.parent_schema,
                        parent_name: table.parent_name,
                        trigger: None,
                        xugu_type_members_expandable: None,
                    })
                    .collect(),
            ))
        }
    }
}

async fn list_completion_objects_once(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    client_session_id: Option<&str>,
) -> Result<Vec<db::ObjectInfo>, String> {
    let pool_key =
        state.get_or_create_metadata_pool_for_session(connection_id, Some(database), client_session_id).await?;
    let db_config = connection_config(state, connection_id).await;

    let connections = state.connections.read().await;
    if let Some(PoolKind::ExternalDriver { config, session, .. }) = connections.get(&pool_key) {
        let config = config.clone();
        let session = session.clone();
        drop(connections);
        return session
            .invoke_with_timeout::<Vec<db::ObjectInfo>>(
                "listObjects",
                serde_json::json!({ "connection": config.as_ref(), "database": database, "schema": schema }),
                agent_metadata_timeout(Some(config.as_ref())),
            )
            .await
            .map(filter_completion_objects);
    }
    if let Some(client) = extract_pool!(&connections, &pool_key, Agent) {
        let is_oracle = db_config.as_ref().is_some_and(|config| config.db_type == DatabaseType::Oracle);
        let fallback_config = db_config.clone();
        drop(connections);
        let objects = if is_oracle {
            oracle_agent_list_objects(client, database, schema, agent_metadata_timeout(db_config.as_ref())).await?
        } else {
            let mut client = client.lock().await;
            match client
                .list_objects::<Vec<db::ObjectInfo>>(database, schema, agent_metadata_timeout(db_config.as_ref()))
                .await
            {
                Ok(objects) if !objects.is_empty() => objects,
                Ok(objects) => {
                    if let Some(config) = fallback_config.as_ref() {
                        match native_postgres_metadata_pool(state, connection_id, database, config).await {
                            Ok(Some(pool)) => {
                                return db::postgres::list_objects(&pool, schema, true, true, false)
                                    .await
                                    .map(filter_completion_objects)
                            }
                            Ok(None) => objects,
                            Err(error) => {
                                log::warn!(
                                    "[schema][agent:list_completion_objects:fallback-failed] connection_id={} database={} schema={} error={}",
                                    connection_id,
                                    database,
                                    schema,
                                    error
                                );
                                objects
                            }
                        }
                    } else {
                        objects
                    }
                }
                Err(agent_error) => {
                    if let Some(config) = fallback_config.as_ref() {
                        if let Some(pool) =
                            native_postgres_metadata_pool(state, connection_id, database, config).await?
                        {
                            return db::postgres::list_objects(&pool, schema, true, true, false)
                                .await
                                .map(filter_completion_objects)
                                .map_err(|fallback_error| {
                                    crate::db::agent_driver::append_legacy_error_context(
                                        &agent_error,
                                        &format!("Native PostgreSQL metadata fallback failed: {fallback_error}"),
                                    )
                                });
                        }
                    }
                    return Err(agent_error);
                }
            }
        };
        return Ok(filter_completion_objects(objects));
    }

    let pool = connections.get(&pool_key).ok_or("Pool not found")?;
    match pool {
        PoolKind::Mysql(p, mode) if *mode != MysqlMode::OceanBaseOracle => {
            db::mysql::list_completion_objects(p, database).await
        }
        PoolKind::Mysql(p, mode) if *mode == MysqlMode::OceanBaseOracle => {
            db::ob_oracle::list_objects(p, schema).await.map(filter_completion_objects)
        }
        PoolKind::Postgres(p) if db_config.as_ref().is_some_and(is_questdb_config) => {
            db::questdb::list_objects(p, schema).await.map(filter_completion_objects)
        }
        PoolKind::Postgres(p) if db_config.as_ref().is_some_and(is_cloudberry_config) => {
            db::cloudberry::list_objects(p, schema).await.map(filter_completion_objects)
        }
        PoolKind::Postgres(p) => {
            db::postgres::list_objects(p, schema, true, true, false).await.map(filter_completion_objects)
        }
        PoolKind::SqlServer(_) => {
            drop(connections);
            let outcome =
                list_objects_once(state, connection_id, database, schema, None, None, None, None, None).await?;
            Ok(filter_completion_objects(outcome.objects))
        }
        _ => Ok(Vec::new()),
    }
}

fn filter_completion_objects(objects: Vec<db::ObjectInfo>) -> Vec<db::ObjectInfo> {
    objects
        .into_iter()
        .filter(|object| {
            let object_type = object.object_type.to_ascii_uppercase();
            object_type.contains("PROCEDURE") || object_type.contains("FUNCTION") || object_type.contains("TRIGGER")
        })
        .collect()
}

fn is_agent_postgres_metadata_fallback_config(config: &ConnectionConfig) -> bool {
    // HighGo and Vastbase can use the native PostgreSQL metadata path when their
    // agent returns no rows. UXDB is JDBC-only; opening a PostgreSQL fallback
    // connection there turns valid empty schemas into misleading DB errors.
    matches!(config.db_type, DatabaseType::Highgo | DatabaseType::Vastbase)
}

async fn native_postgres_metadata_pool(
    state: &AppState,
    connection_id: &str,
    database: &str,
    config: &ConnectionConfig,
) -> Result<Option<deadpool_postgres::Pool>, String> {
    if !is_agent_postgres_metadata_fallback_config(config) {
        return Ok(None);
    }

    let mut postgres_config = database_connection_config(config, Some(database));
    postgres_config.db_type = DatabaseType::Postgres;
    postgres_config.validate_native_url_params()?;
    let (host, port) = state.connection_host_port(connection_id, &postgres_config).await?;
    let url = connection_url_for_endpoint(&postgres_config, &host, port);
    let connect_timeout = Duration::from_secs(postgres_config.effective_connect_timeout_secs());
    db::postgres::connect(&url, connect_timeout).await.map(Some)
}

async fn retry_metadata_connection<T, F, Fut>(
    state: &AppState,
    connection_id: &str,
    database: Option<&str>,
    operation: F,
) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, String>>,
{
    retry_metadata_connection_for_session(state, connection_id, database, None, operation).await
}

async fn retry_metadata_connection_for_session<T, F, Fut>(
    state: &AppState,
    connection_id: &str,
    database: Option<&str>,
    client_session_id: Option<&str>,
    mut operation: F,
) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, String>>,
{
    let db_type = {
        let configs = state.configs.read().await;
        configs.get(connection_id).map(|config| config.db_type)
    };
    let mut retried = false;
    loop {
        let result = operation().await;
        let recovery =
            result.as_ref().err().map(|error| metadata_recovery(db_type, error, retried)).unwrap_or_default();
        match recovery.action {
            MetadataErrorAction::ReplaceRuntime => {
                state
                    .detach_metadata_pool_after_recovery(
                        connection_id,
                        database,
                        client_session_id,
                        recovery.agent_session_id.as_deref(),
                        true,
                    )
                    .await;
                return result;
            }
            MetadataErrorAction::Discard => {
                state
                    .detach_metadata_pool_after_recovery(
                        connection_id,
                        database,
                        client_session_id,
                        recovery.agent_session_id.as_deref(),
                        false,
                    )
                    .await;
                return result;
            }
            MetadataErrorAction::Retry => {
                retried = true;
                if let Err(error) =
                    state.reconnect_metadata_pool_for_session(connection_id, database, client_session_id).await
                {
                    let reconnect_recovery = metadata_recovery(db_type, &error, true);
                    match reconnect_recovery.action {
                        MetadataErrorAction::ReplaceRuntime => {
                            state
                                .detach_metadata_pool_after_recovery(
                                    connection_id,
                                    database,
                                    client_session_id,
                                    reconnect_recovery.agent_session_id.as_deref(),
                                    true,
                                )
                                .await;
                        }
                        MetadataErrorAction::Retry | MetadataErrorAction::Discard => {
                            state
                                .detach_metadata_pool_after_recovery(
                                    connection_id,
                                    database,
                                    client_session_id,
                                    reconnect_recovery.agent_session_id.as_deref(),
                                    false,
                                )
                                .await;
                        }
                        MetadataErrorAction::Return => {}
                    }
                    return Err(error);
                }
            }
            MetadataErrorAction::Return => return result,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum MetadataErrorAction {
    Retry,
    Discard,
    ReplaceRuntime,
    #[default]
    Return,
}

#[derive(Debug, Default)]
struct MetadataRecovery {
    action: MetadataErrorAction,
    agent_session_id: Option<String>,
}

#[cfg(test)]
fn metadata_error_action(db_type: Option<DatabaseType>, error: &str, retried: bool) -> MetadataErrorAction {
    metadata_recovery(db_type, error, retried).action
}

fn metadata_recovery(db_type: Option<DatabaseType>, error: &str, retried: bool) -> MetadataRecovery {
    if db_type.is_some_and(|db_type| crate::database_capabilities::is_agent_type(&db_type)) {
        if let Some(error) = crate::db::agent_driver::try_agent_error_from_legacy(error) {
            let agent_session_id = error.session_id().map(str::to_string);
            let action = match RecoveryPolicy::decide(&error, RecoveryScope::ReadOnlyMetadata { retried }) {
                RecoveryDecision::RetryReadOnlyMetadata => MetadataErrorAction::Retry,
                RecoveryDecision::QuarantineSession => MetadataErrorAction::Discard,
                RecoveryDecision::ReplaceRuntime => MetadataErrorAction::ReplaceRuntime,
                RecoveryDecision::KeepSession => MetadataErrorAction::Return,
            };
            return MetadataRecovery { action, agent_session_id };
        }
    }

    let action = if !retried && is_retryable_metadata_error(error) {
        MetadataErrorAction::Retry
    } else if should_discard_pool_after_error(db_type, error) {
        MetadataErrorAction::Discard
    } else {
        MetadataErrorAction::Return
    };
    MetadataRecovery { action, agent_session_id: None }
}

#[cfg(test)]
async fn replace_metadata_runtime(
    state: &AppState,
    connection_id: &str,
    database: Option<&str>,
    client_session_id: Option<&str>,
) {
    state.replace_runtime_for_metadata_pool(connection_id, database, client_session_id).await;
}

fn is_retryable_metadata_error(error: &str) -> bool {
    if let Some(error) = crate::db::agent_driver::try_agent_error_from_legacy(error) {
        return RecoveryPolicy::decide(&error, RecoveryScope::ReadOnlyMetadata { retried: false })
            == RecoveryDecision::RetryReadOnlyMetadata;
    }
    error == "Pool not found" || crate::query::is_connection_error(error)
}

pub async fn get_columns_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<db::ColumnInfo>, String> {
    get_columns_core_for_session(state, connection_id, database, schema, table, None).await
}

pub async fn get_columns_core_for_session(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
    client_session_id: Option<&str>,
) -> Result<Vec<db::ColumnInfo>, String> {
    if client_session_id.is_none() {
        let metadata_session =
            EphemeralAgentMetadataSession::open(state, connection_id, Some(database), "columns").await;
        if metadata_session.client_session_id().is_some() {
            let result = get_columns_core_for_session_inner(
                state,
                connection_id,
                database,
                schema,
                table,
                metadata_session.client_session_id(),
                false,
            )
            .await;
            metadata_session.finish(state, connection_id, Some(database)).await;
            return result;
        }
    }
    get_columns_core_for_session_inner(state, connection_id, database, schema, table, client_session_id, true).await
}

async fn get_columns_core_for_session_inner(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
    client_session_id: Option<&str>,
    use_client_session_context: bool,
) -> Result<Vec<db::ColumnInfo>, String> {
    let context_session_id = if use_client_session_context { client_session_id } else { None };
    retry_metadata_connection_for_session(state, connection_id, Some(database), client_session_id, || async {
        let pool_key = state
            .get_or_create_metadata_pool_for_session(connection_id, Some(database), client_session_id)
            .await?;
        let db_config = connection_config(state, connection_id).await;

        {
            let connections = state.connections.read().await;
            if let Some(PoolKind::ExternalDriver { config, session, .. }) = connections.get(&pool_key) {
                let config = config.clone();
                let session = session.clone();
                drop(connections);
                if uses_presto_like_information_schema_tables(&config.db_type) {
                    return external_driver_presto_like_columns(session, config.as_ref(), database, schema, table).await;
                }
                let query_oracle_columns_first =
                    should_query_oracle_columns_via_sql_first(&config.db_type, schema, context_session_id);
                if query_oracle_columns_first {
                    match external_driver_oracle_columns_via_sql(
                        session.clone(),
                        config.as_ref(),
                        database,
                        schema,
                        table,
                    )
                    .await
                    {
                        Ok(columns) if !columns.is_empty() => return Ok(columns),
                        Ok(_) => {}
                        Err(error) => {
                            log::warn!(
                                "[schema][external-driver:get_columns:oracle-primary-sql-failed] connection_id={} database={} schema={} table={} error={}",
                                connection_id,
                                database,
                                schema,
                                table,
                                error
                            );
                        }
                    }
                }
                let columns = session
                    .invoke_with_timeout::<Vec<db::ColumnInfo>>(
                        "getColumns",
                        serde_json::json!({
                            "connection": config.as_ref(),
                            "database": database,
                            "schema": schema,
                            "table": table,
                        }),
                        agent_metadata_timeout(Some(config.as_ref())),
                    )
                    .await?;
                if columns.is_empty() && config.db_type == DatabaseType::Oracle && !query_oracle_columns_first {
                    match external_driver_oracle_columns_via_sql(
                        session.clone(),
                        config.as_ref(),
                        database,
                        schema,
                        table,
                    )
                    .await
                    {
                        Ok(fallback_columns) if !fallback_columns.is_empty() => return Ok(fallback_columns),
                        Ok(_) => {}
                        Err(error) => {
                            log::warn!(
                                "[schema][external-driver:get_columns:oracle-fallback-failed] connection_id={} database={} schema={} table={} error={}",
                                connection_id,
                                database,
                                schema,
                                table,
                                error
                            );
                        }
                    }
                }
                return Ok(deduplicate_column_infos(columns));
            }
            #[cfg(feature = "duckdb-sidecar")]
            if let Some(client) = extract_pool!(&connections, &pool_key, DuckDbWorker) {
                let database = database.to_string();
                let schema = schema.to_string();
                let table = table.to_string();
                drop(connections);
                return client.list_columns(database, schema, table).await;
            }
            if let Some(client) = extract_pool!(&connections, &pool_key, ClickHouse) {
                drop(connections);
                return db::clickhouse_driver::get_columns(&client, clickhouse_metadata_database(database, schema), table)
                    .await
                    .map(deduplicate_column_infos);
            }
            if let Some(client) = extract_pool!(&connections, &pool_key, InfluxDb) {
                drop(connections);
                return db::influxdb_driver::get_columns(&client, database, table).await.map(deduplicate_column_infos);
            }
            if let Some(client) = extract_pool!(&connections, &pool_key, VictoriaMetrics) {
                drop(connections);
                return db::victoriametrics_driver::get_columns(&client, table).await.map(deduplicate_column_infos);
            }
            if let Some(linked) = crate::sql_dialect::parse_sqlserver_linked_schema_ref(schema) {
                if let Some(client) = extract_pool!(&connections, &pool_key, SqlServer) {
                    drop(connections);
                    let mut client = client.lock().await;
                    return db::sqlserver::get_linked_server_columns(
                        &mut client,
                        &linked.server,
                        &linked.catalog,
                        &linked.schema,
                        table,
                    )
                    .await
                    .map(deduplicate_column_infos);
                }
            }
            try_sqlserver!(connections, &pool_key, get_columns, schema, table);
            if let Some(client) = extract_pool!(&connections, &pool_key, Agent) {
                let fallback_config = db_config.clone();
                drop(connections);
                let mut client = client.lock().await;
                let oracle_sql_config = fallback_config.as_ref().filter(|config| {
                    should_query_oracle_columns_via_sql_first(&config.db_type, schema, context_session_id)
                });
                let query_oracle_columns_first = oracle_sql_config.is_some();
                if let Some(config) = oracle_sql_config {
                    match oracle_columns_via_sql(
                        database,
                        schema,
                        table,
                        &mut client,
                        agent_metadata_timeout(Some(config)),
                    )
                    .await
                    {
                        Ok(columns) if !columns.is_empty() => return Ok(columns),
                        Ok(_) => {}
                        Err(error) => {
                            log::warn!(
                                "[schema][agent:get_columns:oracle-primary-sql-failed] connection_id={} database={} schema={} table={} error={}",
                                connection_id,
                                database,
                                schema,
                                table,
                                error
                            );
                        }
                    }
                }
                match client
                    .get_columns::<Vec<db::ColumnInfo>>(
                        database,
                        schema,
                        table,
                        agent_metadata_timeout(db_config.as_ref()),
                    )
                    .await
                {
                    Ok(columns) if !columns.is_empty() => return Ok(deduplicate_column_infos(columns)),
                    Ok(columns) => {
                        if let Some(config) = fallback_config.as_ref() {
                            if config.db_type == DatabaseType::Oracle && !query_oracle_columns_first {
                                match oracle_columns_via_sql(
                                    database,
                                    schema,
                                    table,
                                    &mut client,
                                    agent_metadata_timeout(Some(config)),
                                )
                                .await
                                {
                                    Ok(fallback_columns) if !fallback_columns.is_empty() => return Ok(fallback_columns),
                                    Ok(_) => {}
                                    Err(error) => {
                                        log::warn!(
                                            "[schema][agent:get_columns:oracle-fallback-failed] connection_id={} database={} schema={} table={} error={}",
                                            connection_id,
                                            database,
                                            schema,
                                            table,
                                            error
                                        );
                                    }
                                }
                            }
                            match native_postgres_metadata_pool(state, connection_id, database, config).await {
                                Ok(Some(pool)) => {
                                    return db::postgres::get_columns(&pool, schema, table)
                                        .await
                                        .map(deduplicate_column_infos);
                                }
                                Ok(None) => return Ok(deduplicate_column_infos(columns)),
                                Err(error) => {
                                    log::warn!(
                                        "[schema][agent:get_columns:fallback-failed] connection_id={} database={} schema={} table={} error={}",
                                        connection_id,
                                        database,
                                        schema,
                                        table,
                                        error
                                    );
                                }
                            }
                        }
                        return Ok(deduplicate_column_infos(columns));
                    }
                    Err(agent_error) => {
                        if let Some(config) = fallback_config.as_ref() {
                            if let Some(pool) =
                                native_postgres_metadata_pool(state, connection_id, database, config).await?
                            {
                                return db::postgres::get_columns(&pool, schema, table)
                                    .await
                                    .map(deduplicate_column_infos)
                                    .map_err(|fallback_error| {
                                        crate::db::agent_driver::append_legacy_error_context(
                                            &agent_error,
                                            &format!("Native PostgreSQL metadata fallback failed: {fallback_error}"),
                                        )
                                    });
                            }
                        }
                        return Err(agent_error);
                    }
                }
            }
        }

        let connections = state.connections.read().await;
        let pool = connections.get(&pool_key).ok_or("Pool not found")?;

        match pool {
            PoolKind::Mysql(p, _) if db_config.as_ref().is_some_and(is_manticoresearch_config) => {
                let metadata_database = mysql_show_metadata_database_for_config(db_config.as_ref(), database);
                db::manticoresearch::get_columns(p, metadata_database, table).await.map(deduplicate_column_infos)
            }
            PoolKind::Mysql(p, _) if db_config.as_ref().is_some_and(is_doris_family_config) => {
                let metadata_database = mysql_show_metadata_database_for_config(db_config.as_ref(), database);
                // Doris/StarRocks previously went straight to `SHOW COLUMNS` for
                // speed (see perf(doris) commit), but `SHOW COLUMNS` reports the
                // `Key` column as `YES`/`NO` rather than MySQL's `PRI`, so primary
                // keys were never detected. `get_columns` queries
                // information_schema.COLUMNS first — where `COLUMN_KEY = 'PRI'`
                // correctly identifies primary keys (and only real primary keys,
                // not duplicate-key sort columns) — and falls back to `SHOW COLUMNS`
                // automatically when information_schema is unavailable.
                db::mysql::get_columns(p, metadata_database, table).await.map(deduplicate_column_infos)
            }
            PoolKind::Mysql(p, mode) => {
                let effective_db = mysql_table_metadata_catalog(database, schema);
                dispatch_mysql!(p, mode, db::mysql::get_columns, db::ob_oracle::get_columns, effective_db, table)
                    .map(deduplicate_column_infos)
            }
            PoolKind::Postgres(p) if db_config.as_ref().is_some_and(is_questdb_config) => {
                db::questdb::get_columns(p, schema, table).await.map(deduplicate_column_infos)
            }
            PoolKind::Postgres(p)
                if db_config.as_ref().is_some_and(|config| config.db_type == DatabaseType::Redshift) =>
            {
                db::postgres::get_redshift_columns(p, schema, table).await.map(deduplicate_column_infos)
            }
            PoolKind::Postgres(p) => db::postgres::get_columns(p, schema, table).await.map(deduplicate_column_infos),
            PoolKind::Sqlite(p) => db::sqlite::get_columns(p, schema, table).await.map(deduplicate_column_infos),
            PoolKind::Rqlite(client) => {
                db::rqlite_driver::get_columns(client, schema, table).await.map(deduplicate_column_infos)
            }
            PoolKind::Turso(client) => {
                db::turso_driver::get_columns(client, schema, table).await.map(deduplicate_column_infos)
            }
            PoolKind::CloudflareD1(client) => db::cloudflare_d1_driver::get_columns(client, schema, table)
                .await
                .map(deduplicate_column_infos),
            PoolKind::Elasticsearch(client) => {
                db::elasticsearch_driver::get_columns(client, table).await.map(deduplicate_column_infos)
            }
            PoolKind::Easysearch(client) => {
                db::easysearch_driver::get_columns(client, table).await.map(deduplicate_column_infos)
            }
            PoolKind::Meilisearch(client) => {
                db::meilisearch_driver::get_columns(client, table).await.map(deduplicate_column_infos)
            }
            PoolKind::HBase(client) => {
                db::hbase_driver::get_columns(client, database, table).await.map(deduplicate_column_infos)
            }
            _ => Ok(vec![]),
        }
    })
    .await
}

pub async fn get_sqlserver_column_metadata_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<db::sqlserver::SqlServerColumnMetadata>, String> {
    retry_metadata_connection(state, connection_id, Some(database), || async {
        let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
        let connections = state.connections.read().await;
        try_sqlserver!(connections, &pool_key, get_column_metadata, schema, table);
        Err("SQL Server column metadata requires a native SQL Server connection".to_string())
    })
    .await
}

fn deduplicate_column_infos(columns: Vec<db::ColumnInfo>) -> Vec<db::ColumnInfo> {
    let mut result: Vec<db::ColumnInfo> = Vec::with_capacity(columns.len());
    for column in columns {
        if let Some(existing) = result.iter_mut().find(|existing| existing.name == column.name) {
            existing.is_primary_key |= column.is_primary_key;
            existing.is_unique |= column.is_unique;
            existing.is_nullable &= column.is_nullable;
            merge_optional_string(&mut existing.column_default, column.column_default);
            merge_optional_string(&mut existing.extra, column.extra);
            merge_optional_string(&mut existing.comment, column.comment);
            if existing.numeric_precision.is_none() {
                existing.numeric_precision = column.numeric_precision;
            }
            if existing.numeric_scale.is_none() {
                existing.numeric_scale = column.numeric_scale;
            }
            if existing.character_maximum_length.is_none() {
                existing.character_maximum_length = column.character_maximum_length;
            }
            if existing.data_type.trim().is_empty() && !column.data_type.trim().is_empty() {
                existing.data_type = column.data_type;
            }
        } else {
            result.push(column);
        }
    }
    result
}

pub async fn get_all_columns_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
) -> Result<Vec<db::TableColumnsResult>, String> {
    let tables = list_tables_core(state, connection_id, database, schema, None, None, None, None, None).await?;

    let mut result: Vec<db::TableColumnsResult> = Vec::with_capacity(tables.len());
    for table in tables {
        match get_columns_core(state, connection_id, database, schema, &table.name).await {
            Ok(columns) => {
                result.push(db::TableColumnsResult { table_name: table.name, columns, error: None });
            }
            Err(e) => {
                log::warn!(
                    "[schema][get_all_columns] connection_id={} database={} schema={} table={} error={}",
                    connection_id,
                    database,
                    schema,
                    table.name,
                    e
                );
                result.push(db::TableColumnsResult { table_name: table.name, columns: Vec::new(), error: Some(e) });
            }
        }
    }

    Ok(result)
}

fn merge_optional_string(target: &mut Option<String>, candidate: Option<String>) {
    let Some(candidate) = candidate else {
        return;
    };
    if candidate.trim().is_empty() {
        if target.is_none() {
            *target = Some(candidate);
        }
        return;
    }
    if target.as_ref().is_none_or(|value| value.trim().is_empty()) {
        *target = Some(candidate);
    }
}

pub async fn list_indexes_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<db::IndexInfo>, String> {
    if crate::sql_dialect::parse_sqlserver_linked_schema_ref(schema).is_some() {
        return Ok(vec![]);
    }
    let metadata_session = EphemeralAgentMetadataSession::open(state, connection_id, Some(database), "indexes").await;
    let result = list_indexes_core_for_session(
        state,
        connection_id,
        database,
        schema,
        table,
        metadata_session.client_session_id(),
    )
    .await;
    metadata_session.finish(state, connection_id, Some(database)).await;
    result
}

async fn list_indexes_core_for_session(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
    client_session_id: Option<&str>,
) -> Result<Vec<db::IndexInfo>, String> {
    retry_metadata_connection_for_session(state, connection_id, Some(database), client_session_id, || async {
        let pool_key =
            state.get_or_create_metadata_pool_for_session(connection_id, Some(database), client_session_id).await?;
        let db_config = connection_config(state, connection_id).await;

        {
            let connections = state.connections.read().await;
            try_sqlserver!(connections, &pool_key, list_indexes, schema, table);
            if let Some(client) = extract_pool!(&connections, &pool_key, Agent) {
                drop(connections);
                let mut client = client.lock().await;
                return client.list_indexes(database, schema, table, agent_metadata_timeout(db_config.as_ref())).await;
            }
        }

        let connections = state.connections.read().await;
        let pool = connections.get(&pool_key).ok_or("Pool not found")?;

        match pool {
            PoolKind::Mysql(p, mode) => {
                if db_config.as_ref().is_some_and(is_manticoresearch_config) {
                    return db::manticoresearch::list_indexes(p, table).await;
                }
                if *mode == MysqlMode::OceanBaseOracle {
                    db::ob_oracle::list_indexes(p, schema, table).await
                } else if db_config.as_ref().is_some_and(is_starrocks_config) {
                    db::starrocks::list_indexes(p, mysql_table_metadata_catalog(database, schema), table).await
                } else if db_config.as_ref().is_some_and(is_doris_config) {
                    db::doris::list_indexes(p, mysql_table_metadata_catalog(database, schema), table).await
                } else {
                    db::mysql::list_indexes(p, mysql_table_metadata_catalog(database, schema), table).await
                }
            }
            PoolKind::Postgres(p) if db_config.as_ref().is_some_and(is_questdb_config) => {
                db::questdb::list_indexes(p, schema, table).await
            }
            PoolKind::Postgres(_)
                if db_config.as_ref().is_some_and(|config| config.db_type == DatabaseType::Redshift) =>
            {
                Ok(vec![])
            }
            PoolKind::Postgres(p) => db::postgres::list_indexes(p, schema, table).await,
            PoolKind::Sqlite(p) => db::sqlite::list_indexes(p, schema, table).await,
            PoolKind::Rqlite(client) => db::rqlite_driver::list_indexes(client, schema, table).await,
            PoolKind::Turso(client) => db::turso_driver::list_indexes(client, schema, table).await,
            PoolKind::MongoDb(client) => db::mongo_driver::list_indexes(client, database, table).await,
            PoolKind::CloudflareD1(client) => db::cloudflare_d1_driver::list_indexes(client, schema, table).await,
            _ => Ok(vec![]),
        }
    })
    .await
}

pub async fn list_foreign_keys_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<db::ForeignKeyInfo>, String> {
    if crate::sql_dialect::parse_sqlserver_linked_schema_ref(schema).is_some() {
        return Ok(vec![]);
    }
    let metadata_session =
        EphemeralAgentMetadataSession::open(state, connection_id, Some(database), "foreign-keys").await;
    let result = list_foreign_keys_core_for_session(
        state,
        connection_id,
        database,
        schema,
        table,
        metadata_session.client_session_id(),
    )
    .await;
    metadata_session.finish(state, connection_id, Some(database)).await;
    result
}

async fn list_foreign_keys_core_for_session(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
    client_session_id: Option<&str>,
) -> Result<Vec<db::ForeignKeyInfo>, String> {
    retry_metadata_connection_for_session(state, connection_id, Some(database), client_session_id, || async {
        let pool_key =
            state.get_or_create_metadata_pool_for_session(connection_id, Some(database), client_session_id).await?;
        let db_config = connection_config(state, connection_id).await;

        {
            let connections = state.connections.read().await;
            try_sqlserver!(connections, &pool_key, list_foreign_keys, schema, table);
            if let Some(client) = extract_pool!(&connections, &pool_key, Agent) {
                drop(connections);
                let mut client = client.lock().await;
                return client
                    .list_foreign_keys(database, schema, table, agent_metadata_timeout(db_config.as_ref()))
                    .await;
            }
        }

        let connections = state.connections.read().await;
        let pool = connections.get(&pool_key).ok_or("Pool not found")?;

        match pool {
            PoolKind::Mysql(p, mode) => {
                if *mode == MysqlMode::OceanBaseOracle {
                    db::ob_oracle::list_foreign_keys(p, schema, table).await
                } else {
                    db::mysql::list_foreign_keys(p, mysql_table_metadata_catalog(database, schema), table).await
                }
            }
            PoolKind::Postgres(p) => db::postgres::list_foreign_keys(p, schema, table).await,
            PoolKind::Sqlite(p) => db::sqlite::list_foreign_keys(p, schema, table).await,
            PoolKind::Rqlite(client) => db::rqlite_driver::list_foreign_keys(client, schema, table).await,
            PoolKind::Turso(client) => db::turso_driver::list_foreign_keys(client, schema, table).await,
            PoolKind::CloudflareD1(client) => db::cloudflare_d1_driver::list_foreign_keys(client, schema, table).await,
            _ => Ok(vec![]),
        }
    })
    .await
}

pub async fn list_triggers_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<db::TriggerInfo>, String> {
    if crate::sql_dialect::parse_sqlserver_linked_schema_ref(schema).is_some() {
        return Ok(vec![]);
    }
    retry_metadata_connection(state, connection_id, Some(database), || async {
        let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
        let db_config = connection_config(state, connection_id).await;

        {
            let connections = state.connections.read().await;
            try_sqlserver!(connections, &pool_key, list_triggers, schema, table);
            if let Some(client) = extract_pool!(&connections, &pool_key, Agent) {
                drop(connections);
                let mut client = client.lock().await;
                return client.list_triggers(database, schema, table, agent_metadata_timeout(db_config.as_ref())).await;
            }
        }

        let connections = state.connections.read().await;
        let pool = connections.get(&pool_key).ok_or("Pool not found")?;

        match pool {
            PoolKind::Mysql(p, mode) => {
                if *mode == MysqlMode::OceanBaseOracle {
                    db::ob_oracle::list_triggers(p, schema, table).await
                } else {
                    db::mysql::list_triggers(p, mysql_table_metadata_catalog(database, schema), table).await
                }
            }
            PoolKind::Postgres(p) => db::postgres::list_triggers(p, schema, table).await,
            PoolKind::Sqlite(p) => db::sqlite::list_triggers(p, schema, table).await,
            PoolKind::Rqlite(client) => db::rqlite_driver::list_triggers(client, schema, table).await,
            PoolKind::Turso(client) => db::turso_driver::list_triggers(client, schema, table).await,
            PoolKind::CloudflareD1(client) => db::cloudflare_d1_driver::list_triggers(client, schema, table).await,
            _ => Ok(vec![]),
        }
    })
    .await
}

// These object kinds are currently exposed by the Xugu agent only. Keeping
// the core route generic makes the protocol reusable without altering the
// metadata behavior of any built-in database driver.
pub async fn list_constraints_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<db::ConstraintInfo>, String> {
    retry_metadata_connection(state, connection_id, Some(database), || async {
        let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
        let db_config = connection_config(state, connection_id).await;
        let connections = state.connections.read().await;
        if let Some(client) = extract_pool!(&connections, &pool_key, Agent) {
            drop(connections);
            let mut client = client.lock().await;
            return client.list_constraints(database, schema, table, agent_metadata_timeout(db_config.as_ref())).await;
        }
        Ok(vec![])
    })
    .await
}

pub async fn list_partitions_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<db::PartitionInfo>, String> {
    retry_metadata_connection(state, connection_id, Some(database), || async {
        let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
        let db_config = connection_config(state, connection_id).await;
        let connections = state.connections.read().await;
        if let Some(client) = extract_pool!(&connections, &pool_key, Agent) {
            drop(connections);
            let mut client = client.lock().await;
            return client.list_partitions(database, schema, table, agent_metadata_timeout(db_config.as_ref())).await;
        }
        Ok(vec![])
    })
    .await
}

pub async fn list_subpartitions_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<db::SubpartitionInfo>, String> {
    retry_metadata_connection(state, connection_id, Some(database), || async {
        let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
        let db_config = connection_config(state, connection_id).await;
        let connections = state.connections.read().await;
        if let Some(client) = extract_pool!(&connections, &pool_key, Agent) {
            drop(connections);
            let mut client = client.lock().await;
            return client
                .list_subpartitions(database, schema, table, agent_metadata_timeout(db_config.as_ref()))
                .await;
        }
        Ok(vec![])
    })
    .await
}

pub async fn list_functions_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
) -> Result<Vec<db::FunctionInfo>, String> {
    retry_metadata_connection(state, connection_id, Some(database), || async {
        let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
        let connections = state.connections.read().await;
        let pool = connections.get(&pool_key).ok_or("Pool not found")?;

        match pool {
            PoolKind::Postgres(p) => db::postgres::list_functions(p, schema).await,
            _ => Ok(vec![]),
        }
    })
    .await
}

pub async fn list_sequences_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    with_last_values: bool,
) -> Result<Vec<db::SequenceInfo>, String> {
    retry_metadata_connection(state, connection_id, Some(database), || async {
        let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
        let db_config = connection_config(state, connection_id).await;
        let connections = state.connections.read().await;
        let pool = connections.get(&pool_key).ok_or("Pool not found")?;

        match pool {
            PoolKind::Postgres(p) if db_config.as_ref().is_some_and(is_opengauss_family_config) => {
                db::postgres::list_opengauss_sequences(p, schema, with_last_values).await
            }
            PoolKind::Postgres(p) => db::postgres::list_sequences(p, schema, with_last_values).await,
            _ => Ok(vec![]),
        }
    })
    .await
}

pub async fn list_rules_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
) -> Result<Vec<db::RuleInfo>, String> {
    retry_metadata_connection(state, connection_id, Some(database), || async {
        let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
        let connections = state.connections.read().await;
        let pool = connections.get(&pool_key).ok_or("Pool not found")?;

        match pool {
            PoolKind::Postgres(p) => db::postgres::list_rules(p, schema).await,
            _ => Ok(vec![]),
        }
    })
    .await
}

pub async fn list_extensions_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: Option<&str>,
) -> Result<Vec<db::ExtensionInfo>, String> {
    retry_metadata_connection(state, connection_id, Some(database), || async {
        let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
        let db_config = connection_config(state, connection_id).await;
        if db_config.as_ref().is_some_and(|config| config.db_type == DatabaseType::Kingbase) {
            let connections = state.connections.read().await;
            if let Some(client) = extract_pool!(&connections, &pool_key, Agent) {
                drop(connections);
                return kingbase::list_extensions(client, database, schema, agent_metadata_timeout(db_config.as_ref()))
                    .await;
            }
        }

        let connections = state.connections.read().await;
        let pool = connections.get(&pool_key).ok_or("Pool not found")?;

        match pool {
            PoolKind::Postgres(p) => db::postgres::list_extensions(p, schema).await,
            _ => Ok(vec![]),
        }
    })
    .await
}

pub async fn list_available_extensions_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
) -> Result<Vec<db::ExtensionInfo>, String> {
    retry_metadata_connection(state, connection_id, Some(database), || async {
        let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
        let db_config = connection_config(state, connection_id).await;
        if db_config.as_ref().is_some_and(|config| config.db_type == DatabaseType::Kingbase) {
            let connections = state.connections.read().await;
            if let Some(client) = extract_pool!(&connections, &pool_key, Agent) {
                drop(connections);
                return kingbase::list_available_extensions(
                    client,
                    database,
                    agent_metadata_timeout(db_config.as_ref()),
                )
                .await;
            }
        }

        let connections = state.connections.read().await;
        let pool = connections.get(&pool_key).ok_or("Pool not found")?;

        match pool {
            PoolKind::Postgres(p) => db::postgres::list_available_extensions(p).await,
            _ => Ok(vec![]),
        }
    })
    .await
}

pub async fn list_owners_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
) -> Result<Vec<db::OwnerInfo>, String> {
    retry_metadata_connection(state, connection_id, Some(database), || async {
        let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
        let connections = state.connections.read().await;
        let pool = connections.get(&pool_key).ok_or("Pool not found")?;

        match pool {
            PoolKind::Postgres(p) => db::postgres::list_owners(p, schema).await,
            _ => Ok(vec![]),
        }
    })
    .await
}

pub async fn get_table_ddl_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
    object_type: Option<db::ObjectSourceKind>,
) -> Result<String, String> {
    get_table_ddl_core_with_options(state, connection_id, database, schema, table, object_type, false).await
}

pub async fn get_table_display_ddl_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
    object_type: Option<db::ObjectSourceKind>,
) -> Result<String, String> {
    get_table_ddl_core_with_options(state, connection_id, database, schema, table, object_type, true).await
}

async fn get_table_ddl_core_with_options(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
    object_type: Option<db::ObjectSourceKind>,
    include_postgres_access: bool,
) -> Result<String, String> {
    if crate::sql_dialect::parse_sqlserver_linked_schema_ref(schema).is_some() {
        return Err("DDL is not supported for SQL Server linked server tables".to_string());
    }
    if matches!(object_type, Some(db::ObjectSourceKind::View)) {
        let source = get_object_source_core(
            state,
            connection_id,
            database,
            schema,
            table,
            db::ObjectSourceKind::View,
            None,
            None,
        )
        .await?;
        let database_type = connection_config(state, connection_id).await.map(|config| config.db_type);
        // Kingbase MySQL compatibility mode reports a backtick identifier
        // quote; thread it through so the view DDL wraps hyphenated schema
        // names in backticks instead of double quotes the server rejects.
        let identifier_quote = state.connection_identifier_quote(connection_id, Some(database)).await.ok().flatten();
        return Ok(crate::object_source_sql::build_view_ddl_sql(crate::object_source_sql::BuildViewDdlInput {
            database_type,
            schema: if schema.trim().is_empty() { None } else { Some(schema.to_string()) },
            name: table.to_string(),
            source: source.source,
            identifier_quote,
        }));
    }
    if matches!(object_type, Some(db::ObjectSourceKind::MaterializedView)) {
        let source = get_object_source_core(
            state,
            connection_id,
            database,
            schema,
            table,
            db::ObjectSourceKind::MaterializedView,
            None,
            None,
        )
        .await?;
        return Ok(source.source);
    }

    retry_metadata_connection(state, connection_id, Some(database), || {
        get_table_ddl_once(state, connection_id, database, schema, table, include_postgres_access)
    })
    .await
}

async fn get_table_ddl_once(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
    include_postgres_access: bool,
) -> Result<String, String> {
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
    let db_config = connection_config(state, connection_id).await;

    {
        let connections = state.connections.read().await;
        if let Some(PoolKind::ExternalDriver { config, session, .. }) = connections.get(&pool_key) {
            if external_driver_uses_mysql_ddl(config.as_ref()) {
                let config = config.clone();
                let session = session.clone();
                drop(connections);
                return external_driver_mysql_ddl(session, config.as_ref(), database, schema, table).await;
            }
        }
        #[cfg(feature = "duckdb-sidecar")]
        if let Some(client) = extract_pool!(&connections, &pool_key, DuckDbWorker) {
            let client = client.clone();
            drop(connections);
            return client.get_table_ddl(database.to_string(), schema.to_string(), table.to_string()).await;
        }
        if let Some(client) = extract_pool!(&connections, &pool_key, ClickHouse) {
            drop(connections);
            let clickhouse_database = clickhouse_metadata_database(database, schema);
            let result = db::clickhouse_driver::execute_query(
                &client,
                clickhouse_database,
                &format!("SHOW CREATE TABLE `{table}`"),
            )
            .await?;
            return result
                .rows
                .first()
                .and_then(|r| r.first())
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .ok_or_else(|| "Table not found".to_string());
        }
        if let Some(client) = extract_pool!(&connections, &pool_key, SqlServer) {
            drop(connections);
            let mut client = client.lock().await;
            return build_sqlserver_ddl(&mut client, schema, table).await;
        }
        if let Some(client) = extract_pool!(&connections, &pool_key, Agent) {
            drop(connections);
            if let Some(config) = db_config.as_ref().filter(|config| is_agent_postgres_metadata_fallback_config(config))
            {
                match native_postgres_metadata_pool(state, connection_id, database, config).await {
                    Ok(Some(pool)) => match pg_ddl(&pool, schema, table).await {
                        Ok(ddl) => return Ok(ddl),
                        Err(error) => {
                            log::warn!(
                                "[schema][agent:get_table_ddl:postgres-compatible-native-fallback-failed] connection_id={} database={} schema={} table={} error={}",
                                connection_id,
                                database,
                                schema,
                                table,
                                error
                            );
                        }
                    },
                    Ok(None) => {}
                    Err(error) => {
                        log::warn!(
                            "[schema][agent:get_table_ddl:postgres-compatible-native-pool-failed] connection_id={} database={} schema={} table={} error={}",
                            connection_id,
                            database,
                            schema,
                            table,
                            error
                        );
                    }
                }
            }
            if db_config.as_ref().is_some_and(|config| config.db_type == DatabaseType::Oracle) {
                return oracle_agent_table_ddl(
                    client,
                    database,
                    schema,
                    table,
                    agent_metadata_timeout(db_config.as_ref()),
                )
                .await;
            }
            if db_config.as_ref().is_some_and(|config| config.db_type == DatabaseType::Db2) {
                return db2_agent_table_ddl(
                    client,
                    database,
                    schema,
                    table,
                    agent_metadata_timeout(db_config.as_ref()),
                )
                .await;
            }
            let mut client = client.lock().await;
            return client.get_table_ddl(database, schema, table, agent_metadata_timeout(db_config.as_ref())).await;
        }
    }

    let connections = state.connections.read().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;

    match pool {
        PoolKind::Mysql(p, _) => mysql_ddl(p, mysql_table_metadata_catalog(database, schema), table).await,
        PoolKind::Postgres(p) if db_config.as_ref().is_some_and(is_opengauss_family_config) => {
            match opengauss_table_ddl(p, schema, table).await {
                Ok(ddl) => Ok(ddl),
                Err(_) => pg_ddl(p, schema, table).await,
            }
        }
        PoolKind::Postgres(p) if db_config.as_ref().is_some_and(is_questdb_config) => {
            match db::questdb::questdb_table_or_view_ddl(p, table).await {
                Ok(ddl) => Ok(ddl),
                Err(_) => pg_ddl(p, schema, table).await,
            }
        }
        PoolKind::Postgres(p) if db_config.as_ref().is_some_and(is_cloudberry_config) => {
            cloudberry_ddl(p, schema, table).await
        }
        PoolKind::Postgres(p)
            if include_postgres_access && db_config.as_ref().is_some_and(is_native_postgres_config) =>
        {
            pg_display_ddl(p, schema, table).await
        }
        PoolKind::Postgres(p) => pg_ddl(p, schema, table).await,
        PoolKind::Sqlite(p) => sqlite_ddl(p, schema, table).await,
        PoolKind::Rqlite(client) => db::rqlite_driver::table_ddl(client, table).await,
        PoolKind::Turso(client) => db::turso_driver::table_ddl(client, table).await,
        PoolKind::CloudflareD1(client) => db::cloudflare_d1_driver::table_ddl(client, table).await,
        _ => Err("DDL not supported for this database type".to_string()),
    }
}

async fn connection_config(state: &AppState, connection_id: &str) -> Option<ConnectionConfig> {
    state.configs.read().await.get(connection_id).cloned()
}

fn is_opengauss_family_config(config: &ConnectionConfig) -> bool {
    matches!(config.db_type, DatabaseType::OpenGauss | DatabaseType::Gaussdb)
        || matches!(config.driver_profile.as_deref(), Some("opengauss" | "gaussdb"))
}

fn is_native_postgres_config(config: &ConnectionConfig) -> bool {
    config.db_type == DatabaseType::Postgres && matches!(config.driver_profile.as_deref(), None | Some("postgres"))
}

fn is_cloudberry_config(config: &ConnectionConfig) -> bool {
    matches!(config.driver_profile.as_deref(), Some("cloudberry"))
}

/// Whether a native PostgreSQL connection should list user-defined types.
///
/// Only databases with a verified `pg_type` catalog contract are enabled.
/// Other PG-protocol connections (Redshift, QuestDB, Cloudberry, KWDB, ...)
/// keep the legacy object list even though they share `PoolKind::Postgres`.
fn supports_pg_custom_type_objects(config: &ConnectionConfig) -> bool {
    matches!(config.db_type, DatabaseType::Postgres | DatabaseType::OpenGauss | DatabaseType::Gaussdb)
}

/// Whether a typed object-list request needs the pg_class relation branch.
///
/// `None` means the caller wants the full object list (object browser “all
/// objects” view), so every branch is selected. Group loads only request their
/// own kinds (e.g. `["TABLE"]`), which skips the other catalog scans entirely.
fn object_types_include_relations(object_types: Option<&[String]>) -> bool {
    object_types.is_none_or(|types| {
        types.iter().any(|t| {
            matches!(
                t.to_ascii_uppercase().as_str(),
                "TABLE" | "VIEW" | "MATERIALIZED_VIEW" | "SEQUENCE" | "FOREIGN_TABLE" | "PARTITIONED_TABLE"
            )
        })
    })
}

fn object_types_include_routines(object_types: Option<&[String]>) -> bool {
    object_types
        .is_none_or(|types| types.iter().any(|t| matches!(t.to_ascii_uppercase().as_str(), "PROCEDURE" | "FUNCTION")))
}

fn object_types_include_custom_types(object_types: Option<&[String]>) -> bool {
    object_types
        .is_none_or(|types| types.iter().any(|t| t.eq_ignore_ascii_case("TYPE") || t.eq_ignore_ascii_case("TYPE_BODY")))
}

/// Whether the object-type filter exclusively asks for user-defined types.
///
/// Used to keep agent errors visible: the native PostgreSQL fallback never
/// lists custom types, so running it for a dedicated type request would mask a
/// real catalog failure as an empty type group.
fn object_types_only_custom_types(object_types: Option<&[String]>) -> bool {
    object_types.is_some_and(|types| {
        !types.is_empty() && types.iter().all(|t| t.eq_ignore_ascii_case("TYPE") || t.eq_ignore_ascii_case("TYPE_BODY"))
    })
}

fn is_default_oracle_agent_config(config: &ConnectionConfig) -> bool {
    // Only the default go-oracle agent handles filtered/paged metadata; legacy profiles keep Rust fallback paging.
    matches!(config.db_type, DatabaseType::Oracle)
        && !matches!(config.driver_profile.as_deref(), Some("oracle-legacy" | "oracle-10g"))
}

fn supports_agent_table_paging(config: &ConnectionConfig) -> bool {
    // Keep paging opt-in until each legacy agent is known to apply metadata constraints server-side.
    matches!(config.db_type, DatabaseType::Tdengine) || is_default_oracle_agent_config(config)
}

fn agent_paging_likely_applied(enabled: bool, limit: Option<usize>, returned_len: usize) -> bool {
    enabled && limit.is_some_and(|limit| returned_len <= limit)
}

fn is_doris_family_config(config: &ConnectionConfig) -> bool {
    matches!(config.db_type, DatabaseType::Doris | DatabaseType::StarRocks | DatabaseType::ManticoreSearch)
        || matches!(config.driver_profile.as_deref(), Some("doris" | "selectdb" | "starrocks" | "manticoresearch"))
}

fn is_doris_config(config: &ConnectionConfig) -> bool {
    config.db_type == DatabaseType::Doris || matches!(config.driver_profile.as_deref(), Some("doris" | "selectdb"))
}

fn is_starrocks_config(config: &ConnectionConfig) -> bool {
    config.db_type == DatabaseType::StarRocks || matches!(config.driver_profile.as_deref(), Some("starrocks"))
}

/// Doris-family engines that support multi-catalog federation (`SHOW CATALOGS`).
/// Manticore Search is excluded — it shares the MySQL code path but has no
/// catalog concept.
pub fn is_doris_family_catalog_capable_config(config: &ConnectionConfig) -> bool {
    matches!(config.db_type, DatabaseType::Doris | DatabaseType::StarRocks)
        || matches!(config.driver_profile.as_deref(), Some("doris" | "selectdb" | "starrocks"))
}

fn is_manticoresearch_config(config: &ConnectionConfig) -> bool {
    matches!(config.db_type, DatabaseType::ManticoreSearch)
        || matches!(config.driver_profile.as_deref(), Some("manticoresearch"))
}

fn mysql_show_metadata_database_for_config<'a>(config: Option<&ConnectionConfig>, database: &'a str) -> &'a str {
    if config.is_some_and(is_manticoresearch_config) {
        ""
    } else {
        database
    }
}

fn filter_mysql_system_databases_for_config(
    databases: Vec<db::DatabaseInfo>,
    config: Option<&ConnectionConfig>,
) -> Vec<db::DatabaseInfo> {
    if !config.is_some_and(is_manticoresearch_config) {
        return databases;
    }

    databases.into_iter().filter(|database| !is_mysql_system_database(&database.name)).collect()
}

fn is_mysql_system_database(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), "information_schema" | "mysql" | "performance_schema" | "sys")
}

fn is_questdb_config(config: &ConnectionConfig) -> bool {
    matches!(config.db_type, DatabaseType::Questdb) || matches!(config.driver_profile.as_deref(), Some("questdb"))
}

fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn pg_ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn sqlserver_ident(value: &str) -> String {
    format!("[{}]", value.replace(']', "]]"))
}

fn sqlserver_n_string(value: &str) -> String {
    format!("N'{}'", value.replace('\'', "''"))
}

fn oracle_ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn mysql_ident(value: &str) -> String {
    format!("`{}`", value.replace('`', "``"))
}

fn mysql_qualified_name(database: &str, name: &str) -> String {
    if database.trim().is_empty() {
        mysql_ident(name)
    } else {
        format!("{}.{}", mysql_ident(database), mysql_ident(name))
    }
}

fn is_mysql_external_driver_config(config: &ConnectionConfig) -> bool {
    if config.db_type != DatabaseType::Jdbc {
        return false;
    }

    let connection_string = config.connection_string.as_deref().map(str::trim).filter(|value| !value.is_empty());
    let driver_class = config.jdbc_driver_class.as_deref().map(str::trim).filter(|value| !value.is_empty());
    let mysql_url = connection_string.map(|value| value.to_ascii_lowercase().starts_with("jdbc:mysql:"));
    let mysql_driver = driver_class.map(|value| matches!(value, "com.mysql.cj.jdbc.Driver" | "com.mysql.jdbc.Driver"));

    match (mysql_url, mysql_driver) {
        (Some(url_matches), Some(driver_matches)) => url_matches && driver_matches,
        (Some(url_matches), None) => url_matches,
        (None, Some(driver_matches)) => driver_matches,
        (None, None) => false,
    }
}

fn external_driver_uses_mysql_ddl(config: &ConnectionConfig) -> bool {
    is_mysql_external_driver_config(config) || gaussdb_uses_m_jdbc_driver(config)
}

fn gaussdb_m_view_object_source_sql(
    config: &ConnectionConfig,
    _database: &str,
    schema: &str,
    name: &str,
    kind: &db::ObjectSourceKind,
) -> Option<String> {
    (gaussdb_uses_m_jdbc_driver(config) && matches!(kind, db::ObjectSourceKind::View))
        .then(|| mysql_object_source_sql(schema, name, kind))
}

fn mysql_external_driver_ddl_sql(database: &str, schema: &str, table: &str) -> String {
    format!("SHOW CREATE TABLE {}", mysql_qualified_name(mysql_table_metadata_catalog(database, schema), table))
}

fn mysql_external_driver_ddl_from_query_result(
    result: db::QueryResult,
    named_ddl_column: &str,
) -> Result<String, String> {
    let row = result.rows.first().ok_or_else(|| "DDL not found".to_string())?;
    let named_index = result.columns.iter().position(|column| column.trim().eq_ignore_ascii_case(named_ddl_column));
    let ddl = named_index
        .into_iter()
        .chain(std::iter::once(1))
        .filter_map(|index| query_result_cell_string(row, index))
        .find(|value| !value.trim().is_empty())
        .ok_or_else(|| "Failed to read DDL".to_string())?;
    if named_ddl_column.eq_ignore_ascii_case("Create Table") {
        Ok(normalize_mysql_display_ddl(ddl))
    } else {
        Ok(ensure_display_ddl_terminated(ddl))
    }
}

fn sqlite_object_type(kind: &db::ObjectSourceKind) -> &'static str {
    match kind {
        db::ObjectSourceKind::View | db::ObjectSourceKind::MaterializedView => "view",
        db::ObjectSourceKind::Procedure
        | db::ObjectSourceKind::Function
        | db::ObjectSourceKind::Trigger
        | db::ObjectSourceKind::Sequence
        | db::ObjectSourceKind::Synonym
        | db::ObjectSourceKind::Package
        | db::ObjectSourceKind::PackageBody
        | db::ObjectSourceKind::Type
        | db::ObjectSourceKind::TypeBody => "routine",
    }
}

fn sqlserver_object_type_filter(kind: &db::ObjectSourceKind) -> &'static str {
    match kind {
        db::ObjectSourceKind::View => "'V'",
        db::ObjectSourceKind::Procedure => "'P'",
        db::ObjectSourceKind::Function => "'FN','IF','TF','FS','FT'",
        db::ObjectSourceKind::Trigger => "'TR'",
        db::ObjectSourceKind::Sequence
        | db::ObjectSourceKind::Synonym
        | db::ObjectSourceKind::Package
        | db::ObjectSourceKind::PackageBody
        | db::ObjectSourceKind::Type
        | db::ObjectSourceKind::TypeBody
        | db::ObjectSourceKind::MaterializedView => "''",
    }
}

pub fn sqlserver_object_source_sql(schema: &str, name: &str, kind: &db::ObjectSourceKind) -> String {
    format!(
        "SELECT m.definition FROM sys.sql_modules m \
         JOIN sys.objects o ON o.object_id = m.object_id \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         WHERE s.name = {} AND o.name = {} AND o.type IN ({})",
        sql_string(schema),
        sql_string(name),
        sqlserver_object_type_filter(kind)
    )
}

pub fn postgres_object_source_sql(
    schema: &str,
    name: &str,
    kind: &db::ObjectSourceKind,
    signature: Option<&str>,
) -> String {
    postgres_object_source_sql_inner(schema, name, kind, signature, true, false)
}

fn postgres_trigger_object_source_sql(schema: &str, name: &str, relation_name: Option<&str>) -> String {
    let relation_filter = relation_name
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!(" AND c.relname = {}", sql_string(value)))
        .unwrap_or_default();
    format!(
        "SELECT pg_catalog.pg_get_triggerdef(t.oid, true) \
         FROM pg_catalog.pg_trigger t \
         JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = {} AND t.tgname = {} AND NOT t.tgisinternal{} \
         ORDER BY t.oid LIMIT 1",
        sql_string(schema),
        sql_string(name),
        relation_filter
    )
}

fn opengauss_object_source_sql(
    schema: &str,
    name: &str,
    kind: &db::ObjectSourceKind,
    signature: Option<&str>,
) -> String {
    postgres_object_source_sql_inner(schema, name, kind, signature, true, true)
}

fn opengauss_sequence_object_source_sql(schema: &str, name: &str, include_cache: bool) -> String {
    let cache_clause = if include_cache {
        "'    cache ' || COALESCE((pg_sequence_last_value(c.oid)).cache_value::text, '1') || E'\\n' || "
    } else {
        ""
    };
    format!(
        "SELECT concat_ws(E'\\n\\n', \
           '-- auto-generated definition' || E'\\n' || \
           'create ' || CASE WHEN c.relkind IN ('L','Z') THEN 'large ' ELSE '' END || \
           'sequence ' || quote_ident(c.relname) || E'\\n' || \
           '    increment by ' || COALESCE(s.increment::text, '1') || E'\\n' || \
           '    minvalue ' || COALESCE(s.minimum_value::text, '1') || E'\\n' || \
           '    maxvalue ' || COALESCE(s.maximum_value::text, '9223372036854775807') || E'\\n' || \
           '    start with ' || COALESCE(s.start_value::text, '1') || E'\\n' || \
           {cache_clause} \
           CASE WHEN upper(COALESCE(s.cycle_option::text, 'NO')) = 'YES' \
             THEN '    cycle;' ELSE '    no cycle;' END, \
           'alter ' || CASE WHEN c.relkind IN ('L','Z') THEN 'large ' ELSE '' END || \
           'sequence ' || quote_ident(c.relname) || ' owner to ' || quote_ident(pg_get_userbyid(c.relowner)) || ';', \
           CASE WHEN owned.relname IS NOT NULL AND a.attname IS NOT NULL \
             THEN 'alter ' || CASE WHEN c.relkind IN ('L','Z') THEN 'large ' ELSE '' END || \
             'sequence ' || quote_ident(c.relname) || ' owned by ' || quote_ident(owned.relname) || '.' || quote_ident(a.attname) || ';' \
           END \
         ) \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         JOIN information_schema.sequences s \
           ON s.sequence_schema = n.nspname AND s.sequence_name = c.relname \
         LEFT JOIN pg_catalog.pg_depend d \
           ON d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'a' \
         LEFT JOIN pg_catalog.pg_class owned ON owned.oid = d.refobjid \
         LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid \
         WHERE n.nspname = {schema} AND c.relname = {name} AND c.relkind IN ('S','L','z','Z') \
         ORDER BY c.oid LIMIT 1",
        schema = sql_string(schema),
        name = sql_string(name)
    )
}

fn postgres_object_source_sql_without_relispopulated(
    schema: &str,
    name: &str,
    kind: &db::ObjectSourceKind,
    signature: Option<&str>,
) -> String {
    postgres_object_source_sql_inner(schema, name, kind, signature, false, false)
}

fn postgres_function_object_source_sql_without_prokind(
    schema: &str,
    name: &str,
    unwrap_opengauss_record: bool,
) -> String {
    let source_expression =
        if unwrap_opengauss_record { "(pg_get_functiondef(p.oid)).definition" } else { "pg_get_functiondef(p.oid)" };
    format!(
        "SELECT {source_expression} \
         FROM pg_proc p \
         JOIN pg_namespace n ON n.oid = p.pronamespace \
         WHERE n.nspname = {} AND p.proname = {} AND NOT p.proisagg AND NOT p.proiswindow \
         ORDER BY p.oid LIMIT 1",
        sql_string(schema),
        sql_string(name)
    )
}

fn opengauss_routine_source_fallback_sqls(
    schema: &str,
    name: &str,
    object_type: &db::ObjectSourceKind,
    signature: Option<&str>,
    primary_err: &str,
) -> Vec<(&'static str, String)> {
    if !matches!(object_type, db::ObjectSourceKind::Function) {
        return vec![("text-return", postgres_object_source_sql(schema, name, object_type, signature))];
    }

    let mut fallbacks = Vec::with_capacity(3);
    if !postgres_missing_prokind_error(primary_err) {
        fallbacks.push(("text-return", postgres_object_source_sql(schema, name, object_type, signature)));
    }
    // Legacy Gauss-family catalogs vary independently in pg_get_functiondef's return type and prokind support.
    // Keep both no-prokind expressions so a server with both compatibility differences still succeeds.
    fallbacks.push((
        "record-return without prokind",
        postgres_function_object_source_sql_without_prokind(schema, name, true),
    ));
    fallbacks.push((
        "text-return without prokind",
        postgres_function_object_source_sql_without_prokind(schema, name, false),
    ));
    fallbacks
}

fn postgres_object_source_sql_inner(
    schema: &str,
    name: &str,
    kind: &db::ObjectSourceKind,
    signature: Option<&str>,
    include_relispopulated: bool,
    unwrap_opengauss_record: bool,
) -> String {
    match kind {
        db::ObjectSourceKind::View | db::ObjectSourceKind::MaterializedView => {
            let materialized_populated_clause = if include_relispopulated {
                " || CASE WHEN c.relispopulated THEN ' WITH DATA' ELSE ' WITH NO DATA' END"
            } else {
                ""
            };
            let materialized_viewdef = "regexp_replace(pg_get_viewdef(c.oid, 0), ';[[:space:]]*$', '')";
            let materialized_source_expr = format!(
                "CASE WHEN {materialized_viewdef} ~* '^[[:space:]]*CREATE[[:space:]]+(OR[[:space:]]+REPLACE[[:space:]]+)?MATERIALIZED[[:space:]]+VIEW[[:space:]]+' \
                 THEN {materialized_viewdef} \
                 ELSE format('CREATE MATERIALIZED VIEW %I.%I AS ', n.nspname, c.relname) || {materialized_viewdef}{materialized_populated_clause} \
                 END"
            );
            format!(
                "SELECT CASE WHEN c.relkind = 'm' THEN {} \
                 ELSE format('CREATE OR REPLACE VIEW %I.%I AS ', n.nspname, c.relname) || pg_get_viewdef(c.oid, 0) \
                 END \
                 FROM pg_catalog.pg_class c \
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = {} AND c.relname = {} AND c.relkind IN ('v','m') \
                 ORDER BY c.oid LIMIT 1",
                materialized_source_expr,
                sql_string(schema),
                sql_string(name)
            )
        }
        db::ObjectSourceKind::Procedure | db::ObjectSourceKind::Function => {
            let prokind = if matches!(kind, db::ObjectSourceKind::Procedure) { "p" } else { "f" };
            let source_expression = if unwrap_opengauss_record {
                "(pg_get_functiondef(p.oid)).definition"
            } else {
                "pg_get_functiondef(p.oid)"
            };
            let signature_filter = signature
                .map(|value| format!(" AND pg_get_function_identity_arguments(p.oid) = {}", sql_string(value)))
                .unwrap_or_default();
            format!(
                "SELECT {source_expression} \
                 FROM pg_proc p \
                 JOIN pg_namespace n ON n.oid = p.pronamespace \
                 WHERE n.nspname = {} AND p.proname = {} AND p.prokind = '{}'{} \
                 ORDER BY p.oid LIMIT 1",
                sql_string(schema),
                sql_string(name),
                prokind,
                signature_filter
            )
        }
        db::ObjectSourceKind::Sequence => {
            if unwrap_opengauss_record {
                return opengauss_sequence_object_source_sql(schema, name, true);
            }
            format!(
                "SELECT concat_ws(E'\\n\\n', \
                   '-- auto-generated definition' || E'\\n' || \
                   'create sequence ' || quote_ident(c.relname) || E'\\n' || \
                   '    as ' || pg_catalog.format_type(s.seqtypid, NULL) || ';', \
                   'alter sequence ' || quote_ident(c.relname) || ' owner to ' || quote_ident(pg_get_userbyid(c.relowner)) || ';', \
                   CASE WHEN owned.relname IS NOT NULL AND a.attname IS NOT NULL \
                     THEN 'alter sequence ' || quote_ident(c.relname) || ' owned by ' || quote_ident(owned.relname) || '.' || quote_ident(a.attname) || ';' \
                   END \
                 ) \
                 FROM pg_catalog.pg_class c \
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 JOIN pg_catalog.pg_sequence s ON s.seqrelid = c.oid \
                 LEFT JOIN pg_catalog.pg_depend d \
                   ON d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'a' \
                 LEFT JOIN pg_catalog.pg_class owned ON owned.oid = d.refobjid \
                 LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid \
                 WHERE n.nspname = {} AND c.relname = {} AND c.relkind = 'S' \
                 ORDER BY c.oid LIMIT 1",
                sql_string(schema),
                sql_string(name)
            )
        }
        db::ObjectSourceKind::Trigger
        | db::ObjectSourceKind::Synonym
        | db::ObjectSourceKind::Package
        | db::ObjectSourceKind::PackageBody
        | db::ObjectSourceKind::Type
        | db::ObjectSourceKind::TypeBody => "SELECT NULL WHERE FALSE".to_string(),
    }
}

pub fn oracle_object_source_sql(schema: &str, name: &str, kind: &db::ObjectSourceKind) -> String {
    let object_type = match kind {
        db::ObjectSourceKind::View => "VIEW",
        db::ObjectSourceKind::MaterializedView => "MATERIALIZED_VIEW",
        db::ObjectSourceKind::Procedure => "PROCEDURE",
        db::ObjectSourceKind::Function => "FUNCTION",
        db::ObjectSourceKind::Trigger => "TRIGGER",
        db::ObjectSourceKind::Sequence => "SEQUENCE",
        db::ObjectSourceKind::Synonym => "SYNONYM",
        db::ObjectSourceKind::Package => "PACKAGE",
        db::ObjectSourceKind::PackageBody => "PACKAGE_BODY",
        db::ObjectSourceKind::Type => "TYPE",
        db::ObjectSourceKind::TypeBody => "TYPE_BODY",
    };
    if schema.trim().is_empty() {
        format!("SELECT DBMS_METADATA.GET_DDL({}, {}) FROM DUAL", sql_string(object_type), sql_string(name))
    } else {
        format!(
            "SELECT DBMS_METADATA.GET_DDL({}, {}, {}) FROM DUAL",
            sql_string(object_type),
            sql_string(name),
            sql_string(schema)
        )
    }
}

pub fn sqlite_object_source_sql(schema: &str, name: &str, kind: &db::ObjectSourceKind) -> String {
    format!(
        "SELECT sql FROM {}.sqlite_master WHERE type = {} AND name = {}",
        db::sqlite::sqlite_quote_schema_ident(schema),
        sql_string(sqlite_object_type(kind)),
        sql_string(name)
    )
}

async fn sqlite_object_source(
    pool: &db::sqlite::SqliteHandle,
    schema: &str,
    name: &str,
    kind: &db::ObjectSourceKind,
) -> Result<String, String> {
    let pool = pool.clone();
    let schema = schema.to_string();
    let name = sql_string(name);
    let object_type = sql_string(sqlite_object_type(kind));
    tokio::task::spawn_blocking(move || {
        pool.with_connection(|conn| {
            let schema = db::sqlite::sqlite_quote_schema_ident_for_connection(conn, &schema)?;
            let sql = format!("SELECT sql FROM {schema}.sqlite_master WHERE type = {object_type} AND name = {name}");
            conn.query_row(&sql, [], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn mysql_object_source_sql(database: &str, name: &str, kind: &db::ObjectSourceKind) -> String {
    let qualified_name = mysql_qualified_name(database, name);
    match kind {
        db::ObjectSourceKind::View => format!("SHOW CREATE VIEW {qualified_name}"),
        db::ObjectSourceKind::Procedure => format!("SHOW CREATE PROCEDURE {qualified_name}"),
        db::ObjectSourceKind::Function => format!("SHOW CREATE FUNCTION {qualified_name}"),
        db::ObjectSourceKind::Trigger => format!("SHOW CREATE TRIGGER {qualified_name}"),
        db::ObjectSourceKind::Sequence
        | db::ObjectSourceKind::Synonym
        | db::ObjectSourceKind::Package
        | db::ObjectSourceKind::PackageBody
        | db::ObjectSourceKind::Type
        | db::ObjectSourceKind::TypeBody => String::new(),
        // Doris and StarRocks expose materialized views via `SHOW CREATE MATERIALIZED VIEW`.
        // MySQL itself never reaches this arm in normal use: the desktop capabilities map at
        // apps/desktop/src/lib/database/databaseObjectCapabilities.ts has no "mysql" entry,
        // so the UI never sends MaterializedView for a real MySQL connection. If something
        // else forces the kind through, MySQL 8.x will surface a syntax error instead of
        // silently returning empty, which is the desired fail-loud behaviour.
        db::ObjectSourceKind::MaterializedView => {
            format!("SHOW CREATE MATERIALIZED VIEW {qualified_name}")
        }
    }
}

/// Column index of the DDL text in the row returned by the statements generated
/// by [`mysql_object_source_sql`].
///
/// The shape of the result is dialect-dependent:
/// - `SHOW CREATE VIEW`, Doris/StarRocks `SHOW CREATE MATERIALIZED VIEW` →
///   `(Name, DDL)` → DDL at index `1`.
/// - `SHOW CREATE PROCEDURE`, `SHOW CREATE FUNCTION`, `SHOW CREATE TRIGGER` →
///   `(Name, sql_mode, DDL, …)` → DDL at index `2`.
///
/// Encoded as a function so the index can be unit-tested without a live DB.
pub(crate) fn mysql_object_source_ddl_column_index(kind: &db::ObjectSourceKind) -> usize {
    match kind {
        db::ObjectSourceKind::View | db::ObjectSourceKind::MaterializedView => 1,
        db::ObjectSourceKind::Procedure
        | db::ObjectSourceKind::Function
        | db::ObjectSourceKind::Trigger
        | db::ObjectSourceKind::Sequence
        | db::ObjectSourceKind::Synonym
        | db::ObjectSourceKind::Package
        | db::ObjectSourceKind::PackageBody
        | db::ObjectSourceKind::Type
        | db::ObjectSourceKind::TypeBody => 2,
    }
}

pub fn postgres_view_source_fallback_sql(schema: &str, name: &str) -> String {
    format!(
        "SELECT definition \
         FROM pg_catalog.pg_views \
         WHERE schemaname = {} AND viewname = {} \
         LIMIT 1",
        sql_string(schema),
        sql_string(name)
    )
}

fn first_string_cell(result: db::QueryResult) -> Result<String, String> {
    result
        .rows
        .first()
        .and_then(|row| row.iter().find_map(|value| value.as_str().map(str::to_string)))
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Object source not found".to_string())
}

fn parse_hex_u32(value: &str, offset: usize) -> Option<u32> {
    let end = offset.checked_add(8)?;
    u32::from_str_radix(value.get(offset..end)?, 16).ok()
}

fn is_sql_routine_definition(source: &str) -> bool {
    let mut words = source.split_ascii_whitespace();
    if !words.next().is_some_and(|word| word.eq_ignore_ascii_case("CREATE")) {
        return false;
    }

    let Some(next) = words.next() else {
        return false;
    };
    let kind = if next.eq_ignore_ascii_case("OR") {
        if !words.next().is_some_and(|word| word.eq_ignore_ascii_case("REPLACE")) {
            return false;
        }
        words.next()
    } else {
        Some(next)
    };

    kind.is_some_and(|word| word.eq_ignore_ascii_case("FUNCTION") || word.eq_ignore_ascii_case("PROCEDURE"))
}

fn decode_opengauss_functiondef_record(source: &str) -> Option<String> {
    const RECORD_HEADER_HEX_LEN: usize = 48;
    const INT4_OID: u32 = 23;
    const TEXT_OID: u32 = 25;

    let hex = source.strip_prefix("0x").or_else(|| source.strip_prefix("0X"))?;
    if hex.len() < RECORD_HEADER_HEX_LEN || !hex.is_ascii() || !hex.len().is_multiple_of(2) {
        return None;
    }
    if parse_hex_u32(hex, 0)? != 2
        || parse_hex_u32(hex, 8)? != INT4_OID
        || parse_hex_u32(hex, 16)? != 4
        || parse_hex_u32(hex, 24).is_none()
        || parse_hex_u32(hex, 32)? != TEXT_OID
    {
        return None;
    }

    let definition_len = usize::try_from(parse_hex_u32(hex, 40)?).ok()?;
    let expected_len = RECORD_HEADER_HEX_LEN.checked_add(definition_len.checked_mul(2)?)?;
    if hex.len() != expected_len {
        return None;
    }

    let definition_hex = &hex[RECORD_HEADER_HEX_LEN..];
    let mut definition = Vec::with_capacity(definition_len);
    for pair in definition_hex.as_bytes().chunks_exact(2) {
        let pair = std::str::from_utf8(pair).ok()?;
        definition.push(u8::from_str_radix(pair, 16).ok()?);
    }
    let definition = String::from_utf8(definition).ok()?;
    is_sql_routine_definition(&definition).then_some(definition)
}

fn normalize_routine_object_source(source: String) -> String {
    decode_opengauss_functiondef_record(&source).unwrap_or(source)
}

async fn mysql_object_source(
    pool: &db::mysql::MySqlPool,
    database: &str,
    name: &str,
    kind: &db::ObjectSourceKind,
) -> Result<String, String> {
    let primary_sql = mysql_object_source_sql(database, name, kind);
    let primary_column_index = mysql_object_source_ddl_column_index(kind);
    let mut conn = db::mysql::get_conn_with_timeout(pool, db::connection_timeout()).await?;

    match read_mysql_object_source_row(&mut conn, &primary_sql, primary_column_index).await {
        Ok(source) => Ok(source),
        Err(primary_err) if matches!(kind, db::ObjectSourceKind::MaterializedView) => {
            // StarRocks predating PR 73396 rejects SHOW CREATE MATERIALIZED VIEW for
            // sync MVs. Fall back to the persistent definition exposed by
            // information_schema.materialized_views. The fallback returns a single
            // column (MATERIALIZED_VIEW_DEFINITION) so the column index is always 0.
            let fallback_sql = db::mysql::mysql_materialized_view_definition_sql(database, name);
            read_mysql_object_source_row(&mut conn, &fallback_sql, 0).await.map_err(|fallback_err| {
                format!(
                    "SHOW CREATE MATERIALIZED VIEW failed ({primary_err}); \
                         fallback query against information_schema.materialized_views failed ({fallback_err})"
                )
            })
        }
        Err(e) => Err(e),
    }
}

async fn read_mysql_object_source_row(
    conn: &mut mysql_async::Conn,
    sql: &str,
    ddl_column_index: usize,
) -> Result<String, String> {
    use mysql_async::prelude::*;
    let result = conn.query_iter(sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
    let row = rows.first().ok_or("Object source not found")?;
    row.get_opt::<String, usize>(ddl_column_index)
        .and_then(|result| result.ok())
        .or_else(|| {
            row.get_opt::<Vec<u8>, usize>(ddl_column_index)
                .and_then(|result| result.ok())
                .map(|b| String::from_utf8_lossy(&b).to_string())
        })
        .ok_or_else(|| "Failed to read object source".to_string())
}

/// Whether a connection may serve custom type details (phase 2). Kept
/// separate from listing support so a future per-kind DDL capability can be
/// toggled independently.
fn supports_custom_type_details(config: &ConnectionConfig) -> bool {
    matches!(
        config.db_type,
        DatabaseType::Postgres
            | DatabaseType::OpenGauss
            | DatabaseType::Gaussdb
            | DatabaseType::Kingbase
            | DatabaseType::Vastbase
    )
}

pub async fn get_custom_type_details_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    name: &str,
) -> Result<db::CustomTypeDetails, String> {
    retry_metadata_connection(state, connection_id, Some(database), || {
        get_custom_type_details_once(state, connection_id, database, schema, name)
    })
    .await
}

async fn get_custom_type_details_once(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    name: &str,
) -> Result<db::CustomTypeDetails, String> {
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
    let db_config = connection_config(state, connection_id).await;
    let Some(config) = db_config.as_ref() else {
        return Err("connection not found".to_string());
    };
    if !supports_custom_type_details(config) {
        return Err(format!("custom type details are not supported for {:?} connections", config.db_type));
    }
    {
        let connections = state.connections.read().await;
        if let Some(client) = extract_pool!(&connections, &pool_key, Agent) {
            let timeout_duration = agent_metadata_timeout(db_config.as_ref());
            drop(connections);
            let mut client = client.lock().await;
            return client
                .get_custom_type_details::<db::CustomTypeDetails>(database, schema, name, timeout_duration)
                .await;
        }
    }
    let connections = state.connections.read().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;
    match pool {
        PoolKind::Postgres(p) => db::postgres::get_custom_type_details(p, schema, name).await,
        _ => Err("custom type details are not supported for this connection type".to_string()),
    }
}

pub async fn get_object_source_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    name: &str,
    object_type: db::ObjectSourceKind,
    signature: Option<&str>,
    relation_name: Option<&str>,
) -> Result<db::ObjectSource, String> {
    let mut source = retry_metadata_connection(state, connection_id, Some(database), || {
        get_object_source_once(
            state,
            connection_id,
            database,
            schema,
            name,
            object_type.clone(),
            signature,
            relation_name,
        )
    })
    .await?;
    if matches!(source.object_type, db::ObjectSourceKind::Procedure | db::ObjectSourceKind::Function) {
        source.source = normalize_routine_object_source(source.source);
    }
    Ok(source)
}

async fn get_object_source_once(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    name: &str,
    object_type: db::ObjectSourceKind,
    signature: Option<&str>,
    relation_name: Option<&str>,
) -> Result<db::ObjectSource, String> {
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
    let db_config = connection_config(state, connection_id).await;
    let source = {
        let connections = state.connections.read().await;
        if let Some(PoolKind::ExternalDriver { config, session, .. }) = connections.get(&pool_key) {
            let config = config.clone();
            let session = session.clone();
            drop(connections);
            if let Some(sql) = gaussdb_m_view_object_source_sql(config.as_ref(), database, schema, name, &object_type) {
                let result: db::QueryResult = session
                    .invoke_with_timeout(
                        "executeQuery",
                        serde_json::json!({
                            "connection": config.as_ref(),
                            "database": database,
                            "schema": schema,
                            "sql": sql,
                            "maxRows": 1,
                        }),
                        agent_metadata_timeout(Some(config.as_ref())),
                    )
                    .await?;
                let source = mysql_external_driver_ddl_from_query_result(result, "Create View")?;
                return Ok(db::ObjectSource {
                    name: name.to_string(),
                    object_type,
                    schema: if schema.is_empty() { None } else { Some(schema.to_string()) },
                    source,
                    editable: None,
                });
            }
            let result: db::ObjectSource = session
                .invoke_with_timeout(
                    "getObjectSource",
                    serde_json::json!({
                        "connection": config.as_ref(),
                        "database": database,
                        "schema": schema,
                        "name": name,
                        "object_type": &object_type,
                    }),
                    agent_metadata_timeout(Some(config.as_ref())),
                )
                .await?;
            return Ok(result);
        }
        if let Some(client) = extract_pool!(&connections, &pool_key, SqlServer) {
            drop(connections);
            let mut client = client.lock().await;
            let result =
                db::sqlserver::execute_query(&mut client, &sqlserver_object_source_sql(schema, name, &object_type))
                    .await;
            drop(client);
            if matches!(result.as_ref(), Err(err) if should_discard_pool_after_error(Some(DatabaseType::SqlServer), err))
            {
                state.remove_pool_by_key(&pool_key).await;
            }
            first_string_cell(result?)?
        } else if let Some(client) = extract_pool!(&connections, &pool_key, Agent) {
            drop(connections);
            if db_config.as_ref().is_some_and(|config| config.db_type == DatabaseType::Oracle)
                && matches!(object_type, db::ObjectSourceKind::Package | db::ObjectSourceKind::PackageBody)
            {
                oracle_agent_object_source(
                    client,
                    database,
                    schema,
                    name,
                    &object_type,
                    agent_metadata_timeout(db_config.as_ref()),
                )
                .await?
            } else {
                let mut client = client.lock().await;
                let result: db::ObjectSource = client
                    .get_object_source(database, schema, name, &object_type, agent_metadata_timeout(db_config.as_ref()))
                    .await?;
                return Ok(result);
            }
        } else {
            match connections.get(&pool_key).ok_or("Pool not found")? {
                PoolKind::Mysql(pool, _) => {
                    mysql_object_source(pool, mysql_table_metadata_catalog(database, schema), name, &object_type)
                        .await?
                }
                PoolKind::Postgres(pool) if db_config.as_ref().is_some_and(is_questdb_config) => {
                    // only view
                    db::questdb::questdb_object_source(pool, name).await?
                }
                PoolKind::Postgres(pool) => {
                    let unwrap_opengauss_record = db_config.as_ref().is_some_and(is_opengauss_family_config);
                    postgres_object_source(
                        pool,
                        schema,
                        name,
                        &object_type,
                        signature,
                        relation_name,
                        unwrap_opengauss_record,
                    )
                    .await?
                }
                PoolKind::Sqlite(pool) => sqlite_object_source(pool, schema, name, &object_type).await?,
                #[cfg(feature = "duckdb-sidecar")]
                PoolKind::DuckDbWorker(client) => {
                    let client = client.clone();
                    let database = database.to_string();
                    let schema = schema.to_string();
                    let name = name.to_string();
                    let object_type = object_type.clone();
                    drop(connections);
                    client.get_object_source(database, schema, name, object_type).await?
                }
                PoolKind::Rqlite(client) => {
                    return db::rqlite_driver::object_source(client, name, &object_type).await;
                }
                PoolKind::Turso(client) => {
                    return db::turso_driver::object_source(client, name, &object_type).await;
                }
                PoolKind::ClickHouse(client) if matches!(object_type, db::ObjectSourceKind::View) => {
                    let result = db::clickhouse_driver::execute_query(
                        client,
                        database,
                        &format!("SHOW CREATE TABLE {}", mysql_ident(name)),
                    )
                    .await?;
                    first_string_cell(result)?
                }
                PoolKind::CloudflareD1(client) => {
                    return db::cloudflare_d1_driver::object_source(client, name, &object_type).await;
                }
                _ => return Err("Object source is not supported for this database type".to_string()),
            }
        }
    };

    let editable = if matches!(object_type, db::ObjectSourceKind::Trigger)
        && db_config.as_ref().is_some_and(|config| {
            matches!(
                config.db_type,
                DatabaseType::Postgres
                    | DatabaseType::Redshift
                    | DatabaseType::Gaussdb
                    | DatabaseType::Kwdb
                    | DatabaseType::OpenGauss
                    | DatabaseType::Questdb
                    | DatabaseType::Kingbase
                    | DatabaseType::Highgo
                    | DatabaseType::Uxdb
                    | DatabaseType::Vastbase
            )
        }) {
        Some(false)
    } else {
        None
    };

    Ok(db::ObjectSource {
        name: name.to_string(),
        object_type,
        schema: if schema.is_empty() { None } else { Some(schema.to_string()) },
        source,
        editable,
    })
}

fn oracle_owner_filter(schema: &str) -> String {
    let schema = schema.trim();
    if schema.is_empty() {
        "USER".to_string()
    } else {
        sql_string(&schema.to_uppercase())
    }
}

pub fn oracle_list_objects_sql(schema: &str) -> String {
    format!(
        "SELECT object_name, CASE object_type WHEN 'PACKAGE BODY' THEN 'PACKAGE_BODY' ELSE object_type END AS object_type, owner \
         FROM all_objects \
         WHERE owner = {} AND object_type IN ('TABLE', 'VIEW', 'PROCEDURE', 'FUNCTION', 'PACKAGE', 'PACKAGE BODY') \
         ORDER BY CASE object_type WHEN 'TABLE' THEN 0 WHEN 'VIEW' THEN 1 WHEN 'PROCEDURE' THEN 2 WHEN 'FUNCTION' THEN 3 WHEN 'PACKAGE' THEN 4 ELSE 5 END, object_name",
        oracle_owner_filter(schema)
    )
}

async fn oracle_agent_list_objects(
    client: Arc<db::agent_driver::PooledAgentClient>,
    database: &str,
    schema: &str,
    timeout_duration: Option<Duration>,
) -> Result<Vec<db::ObjectInfo>, String> {
    let sql = oracle_list_objects_sql(schema);
    let params = agent_execute_query_params(
        &sql,
        if database.is_empty() { None } else { Some(database) },
        if schema.is_empty() { None } else { Some(schema) },
        QueryExecutionOptions { max_rows: Some(10_000), ..Default::default() },
    );
    let mut client = client.lock().await;
    let result: db::QueryResult = client.execute_query_with_timeout(params, timeout_duration).await?;
    let mut objects: Vec<db::ObjectInfo> = result
        .rows
        .into_iter()
        .filter_map(|row| {
            let name = row.first()?.as_str()?.to_string();
            let object_type = row.get(1)?.as_str()?.to_string();
            let schema = row.get(2).and_then(|value| value.as_str()).map(str::to_string);
            Some(db::ObjectInfo {
                name,
                object_type,
                schema,
                valid: None,
                signature: None,
                custom_type_kind: None,
                has_members: None,
                comment: None,
                created_at: None,
                updated_at: None,
                parent_schema: None,
                parent_name: None,
                trigger: None,
                xugu_type_members_expandable: None,
            })
        })
        .collect();
    load_oracle_table_comments_for_objects(&mut client, database, schema, &mut objects, timeout_duration).await?;
    Ok(objects)
}

async fn oracle_agent_object_source(
    client: Arc<db::agent_driver::PooledAgentClient>,
    database: &str,
    schema: &str,
    name: &str,
    object_type: &db::ObjectSourceKind,
    timeout_duration: Option<Duration>,
) -> Result<String, String> {
    let sql = oracle_object_source_sql(schema, name, object_type);
    let params = agent_execute_query_params(
        &sql,
        if database.is_empty() { None } else { Some(database) },
        if schema.is_empty() { None } else { Some(schema) },
        QueryExecutionOptions { max_rows: Some(1), ..Default::default() },
    );
    let mut client = client.lock().await;
    let result: db::QueryResult = client.execute_query_with_timeout(params, timeout_duration).await?;
    first_string_cell(result)
}

async fn oracle_agent_table_ddl(
    client: Arc<db::agent_driver::PooledAgentClient>,
    database: &str,
    schema: &str,
    table: &str,
    timeout_duration: Option<Duration>,
) -> Result<String, String> {
    let mut client = client.lock().await;
    let ddl = client.get_table_ddl::<String>(database, schema, table, timeout_duration).await?;
    match append_oracle_table_comment_ddl(&mut client, database, schema, table, &ddl, timeout_duration).await {
        Ok(ddl) => Ok(ddl),
        Err(error) => {
            log::debug!(
                "[schema][oracle:get_table_ddl:comments-fallback-failed] schema={} table={} error={}",
                schema,
                table,
                error
            );
            Ok(ddl)
        }
    }
}

async fn append_oracle_table_comment_ddl(
    client: &mut db::agent_driver::AgentDriverClient,
    database: &str,
    schema: &str,
    table: &str,
    ddl: &str,
    timeout_duration: Option<Duration>,
) -> Result<String, String> {
    let table_comment =
        oracle_table_comments_for_names(client, database, schema, &[table.to_string()], timeout_duration)
            .await?
            .into_iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(table))
            .map(|(_, comment)| comment);
    let columns =
        client.get_columns::<Vec<db::ColumnInfo>>(database, schema, table, timeout_duration).await.unwrap_or_default();
    Ok(append_oracle_comments_to_ddl(ddl, schema, table, table_comment.as_deref(), &columns))
}

fn append_oracle_comments_to_ddl(
    ddl: &str,
    schema: &str,
    table: &str,
    table_comment: Option<&str>,
    columns: &[db::ColumnInfo],
) -> String {
    let mut result = ddl.trim_end().trim_end_matches(';').to_string();
    if result.trim().is_empty() {
        return result;
    }
    result.push(';');
    let existing_ddl_upper = ddl.to_ascii_uppercase();

    let table_ref = if schema.trim().is_empty() {
        oracle_ident(table)
    } else {
        format!("{}.{}", oracle_ident(schema), oracle_ident(table))
    };

    if !existing_ddl_upper.contains("COMMENT ON TABLE") {
        if let Some(comment) = table_comment.map(str::trim).filter(|comment| !comment.is_empty()) {
            result.push_str(&format!("\nCOMMENT ON TABLE {table_ref} IS {};", sql_string(comment)));
        }
    }
    if !existing_ddl_upper.contains("COMMENT ON COLUMN") {
        for column in columns {
            if let Some(comment) = column.comment.as_deref().map(str::trim).filter(|comment| !comment.is_empty()) {
                result.push_str(&format!(
                    "\nCOMMENT ON COLUMN {table_ref}.{} IS {};",
                    oracle_ident(&column.name),
                    sql_string(comment)
                ));
            }
        }
    }
    result
}

async fn db2_agent_table_ddl(
    client: Arc<db::agent_driver::PooledAgentClient>,
    database: &str,
    schema: &str,
    table: &str,
    timeout_duration: Option<Duration>,
) -> Result<String, String> {
    let mut client = client.lock().await;
    let ddl = client.get_table_ddl::<String>(database, schema, table, timeout_duration).await?;
    match append_db2_comments_to_ddl(&mut client, database, schema, table, &ddl, timeout_duration).await {
        Ok(ddl) => Ok(ddl),
        Err(error) => {
            log::debug!(
                "[schema][db2:get_table_ddl:comments-fallback-failed] schema={} table={} error={}",
                schema,
                table,
                error
            );
            Ok(ddl)
        }
    }
}

async fn append_db2_comments_to_ddl(
    client: &mut db::agent_driver::AgentDriverClient,
    database: &str,
    schema: &str,
    table: &str,
    ddl: &str,
    timeout_duration: Option<Duration>,
) -> Result<String, String> {
    let table_comment = db2_table_comment(client, database, schema, table, timeout_duration).await;
    let column_comments = db2_column_comments(client, database, schema, table, timeout_duration).await;
    let mut columns =
        client.get_columns::<Vec<db::ColumnInfo>>(database, schema, table, timeout_duration).await.unwrap_or_default();
    if !column_comments.is_empty() {
        for column in &mut columns {
            if column.comment.as_deref().is_none_or(|c| c.trim().is_empty() || c.trim().eq_ignore_ascii_case("null")) {
                if let Some(remark) = column_comments.get(&column.name.to_uppercase()) {
                    column.comment = Some(remark.clone());
                }
            }
        }
    }
    Ok(append_oracle_comments_to_ddl(ddl, schema, table, table_comment.as_deref(), &columns))
}

async fn db2_table_comment(
    client: &mut db::agent_driver::AgentDriverClient,
    database: &str,
    schema: &str,
    table: &str,
    timeout_duration: Option<Duration>,
) -> Option<String> {
    // 优先使用原始值查询，支持 quoted/mixed-case 对象；如果查不到再 fallback 到大写
    for (schema_name, table_name) in
        [(schema.trim(), table.trim()), (&schema.trim().to_uppercase(), &table.trim().to_uppercase())]
    {
        let schema_filter = if schema_name.is_empty() { "CURRENT SCHEMA".to_string() } else { sql_string(schema_name) };
        let sql = format!(
            "SELECT REMARKS FROM SYSCAT.TABLES WHERE TABSCHEMA = {} AND TABNAME = {} AND REMARKS IS NOT NULL",
            schema_filter,
            sql_string(table_name),
        );
        if let Ok(result) = client
            .execute_query_with_timeout::<db::QueryResult>(
                agent_execute_query_params(
                    &sql,
                    if database.is_empty() { None } else { Some(database) },
                    if schema.is_empty() { None } else { Some(schema) },
                    QueryExecutionOptions { max_rows: Some(1), ..Default::default() },
                ),
                timeout_duration,
            )
            .await
        {
            if let Some(comment) =
                result.rows.first().and_then(|row| row.first()).and_then(|v| v.as_str()).map(|s| s.to_string())
            {
                return Some(comment);
            }
        }
    }
    None
}

async fn db2_column_comments(
    client: &mut db::agent_driver::AgentDriverClient,
    database: &str,
    schema: &str,
    table: &str,
    timeout_duration: Option<Duration>,
) -> HashMap<String, String> {
    // 优先使用原始值查询，支持 quoted/mixed-case 对象；如果查不到再 fallback 到大写
    let mut comments = HashMap::new();
    for (schema_name, table_name) in
        [(schema.trim(), table.trim()), (&schema.trim().to_uppercase(), &table.trim().to_uppercase())]
    {
        let schema_filter = if schema_name.is_empty() { "CURRENT SCHEMA".to_string() } else { sql_string(schema_name) };
        let sql = format!(
            "SELECT COLNAME, REMARKS FROM SYSCAT.COLUMNS WHERE TABSCHEMA = {} AND TABNAME = {} AND REMARKS IS NOT NULL",
            schema_filter,
            sql_string(table_name),
        );
        let result = match client
            .execute_query_with_timeout::<db::QueryResult>(
                agent_execute_query_params(
                    &sql,
                    if database.is_empty() { None } else { Some(database) },
                    if schema.is_empty() { None } else { Some(schema) },
                    QueryExecutionOptions { ..Default::default() },
                ),
                timeout_duration,
            )
            .await
        {
            Ok(result) => result,
            Err(_) => continue,
        };
        for row in &result.rows {
            let col_name = row.first().and_then(|v| v.as_str()).unwrap_or("").trim();
            let remark = row.get(1).and_then(|v| v.as_str()).unwrap_or("").trim();
            if !col_name.is_empty() && !remark.is_empty() {
                comments.entry(col_name.to_uppercase()).or_insert_with(|| remark.to_string());
            }
        }
        if !comments.is_empty() {
            break;
        }
    }
    comments
}

async fn postgres_object_source(
    pool: &deadpool_postgres::Pool,
    schema: &str,
    name: &str,
    object_type: &db::ObjectSourceKind,
    signature: Option<&str>,
    relation_name: Option<&str>,
    unwrap_opengauss_record: bool,
) -> Result<String, String> {
    let sql = if matches!(object_type, db::ObjectSourceKind::Trigger) {
        postgres_trigger_object_source_sql(schema, name, relation_name)
    } else if unwrap_opengauss_record {
        opengauss_object_source_sql(schema, name, object_type, signature)
    } else {
        postgres_object_source_sql(schema, name, object_type, signature)
    };
    match db::postgres::execute_query(pool, &sql).await.and_then(first_string_cell) {
        Ok(source) => Ok(source),
        Err(primary_err)
            if postgres_missing_relispopulated_error(&primary_err)
                && matches!(object_type, db::ObjectSourceKind::View | db::ObjectSourceKind::MaterializedView) =>
        {
            let fallback_sql = postgres_object_source_sql_without_relispopulated(schema, name, object_type, signature);
            db::postgres::execute_query(pool, &fallback_sql)
                .await
                .and_then(first_string_cell)
                .map_err(|fallback_err| format!("{primary_err}; relispopulated fallback failed: {fallback_err}"))
        }
        Err(primary_err)
            if unwrap_opengauss_record
                && matches!(object_type, db::ObjectSourceKind::Sequence)
                && opengauss_sequence_cache_metadata_error(&primary_err) =>
        {
            let fallback_sql = opengauss_sequence_object_source_sql(schema, name, false);
            db::postgres::execute_query(pool, &fallback_sql)
                .await
                .and_then(first_string_cell)
                .map_err(|fallback_err| format!("{primary_err}; sequence cache fallback failed: {fallback_err}"))
        }
        Err(primary_err)
            if unwrap_opengauss_record
                && matches!(object_type, db::ObjectSourceKind::Procedure | db::ObjectSourceKind::Function) =>
        {
            let mut errors = vec![primary_err];
            for (label, fallback_sql) in
                opengauss_routine_source_fallback_sqls(schema, name, object_type, signature, &errors[0])
            {
                match db::postgres::execute_query(pool, &fallback_sql).await.and_then(first_string_cell) {
                    Ok(source) => return Ok(source),
                    Err(fallback_err) => errors.push(format!("{label} fallback failed: {fallback_err}")),
                }
            }
            Err(errors.join("; "))
        }
        Err(primary_err)
            if postgres_missing_prokind_error(&primary_err)
                && matches!(object_type, db::ObjectSourceKind::Function) =>
        {
            let fallback_sql = postgres_function_object_source_sql_without_prokind(schema, name, false);
            db::postgres::execute_query(pool, &fallback_sql)
                .await
                .and_then(first_string_cell)
                .map_err(|fallback_err| format!("{primary_err}; prokind fallback failed: {fallback_err}"))
        }
        Err(primary_err) if matches!(object_type, db::ObjectSourceKind::View) => {
            let fallback_sql = postgres_view_source_fallback_sql(schema, name);
            db::postgres::execute_query(pool, &fallback_sql)
                .await
                .and_then(first_string_cell)
                .map_err(|fallback_err| format!("{primary_err}; fallback failed: {fallback_err}"))
        }
        Err(err) => Err(err),
    }
}

fn postgres_missing_prokind_error(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    lower.contains("does not exist")
        && (lower.contains("column p.prokind")
            || lower.contains("column \"p\".\"prokind\"")
            || lower.contains("column \"prokind\""))
}

fn opengauss_sequence_cache_metadata_error(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    lower.contains("pg_sequence_last_value") || lower.contains("cache_value")
}

fn postgres_missing_relispopulated_error(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    lower.contains("does not exist")
        && (lower.contains("column c.relispopulated")
            || lower.contains("column \"c\".\"relispopulated\"")
            || lower.contains("column \"relispopulated\""))
}

#[cfg(test)]
mod object_source_tests {
    use super::*;
    use crate::types::ObjectSourceKind;

    fn opengauss_functiondef_record_hex(headerlines: u32, definition: &[u8]) -> String {
        let mut bytes = Vec::with_capacity(24 + definition.len());
        bytes.extend_from_slice(&2_u32.to_be_bytes());
        bytes.extend_from_slice(&23_u32.to_be_bytes());
        bytes.extend_from_slice(&4_u32.to_be_bytes());
        bytes.extend_from_slice(&headerlines.to_be_bytes());
        bytes.extend_from_slice(&25_u32.to_be_bytes());
        bytes.extend_from_slice(&u32::try_from(definition.len()).unwrap().to_be_bytes());
        bytes.extend_from_slice(definition);
        format!("0x{}", crate::db::hex_encode(&bytes))
    }

    #[tokio::test]
    async fn reads_sqlite_object_source_from_dotted_attached_schema() {
        let pool = db::sqlite::connect_path(":memory:").await.expect("connect primary database");
        db::sqlite::attach_database(&pool, "analytics.db", ":memory:").expect("attach database");
        db::sqlite::execute_query(&pool, "CREATE VIEW \"analytics.db\".active_users AS SELECT 1 AS id")
            .await
            .expect("create attached view");

        let source = sqlite_object_source(&pool, "analytics.db", "active_users", &ObjectSourceKind::View)
            .await
            .expect("read attached view source");

        assert!(source.contains("CREATE VIEW active_users"));
    }

    #[test]
    fn builds_sqlserver_object_source_sql_for_schema_scoped_routines() {
        assert_eq!(
            sqlserver_object_source_sql("dbo", "refresh_cache", &ObjectSourceKind::Procedure),
            "SELECT m.definition FROM sys.sql_modules m JOIN sys.objects o ON o.object_id = m.object_id JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = 'dbo' AND o.name = 'refresh_cache' AND o.type IN ('P')"
        );
    }

    #[test]
    fn builds_postgres_object_source_sql_for_views_and_functions() {
        let view_sql = postgres_object_source_sql("public", "active_users", &ObjectSourceKind::View, None);

        assert!(view_sql.contains("CREATE MATERIALIZED VIEW"));
        assert!(view_sql.contains("CREATE OR REPLACE VIEW"));
        assert!(view_sql.contains("CASE WHEN c.relispopulated THEN ' WITH DATA' ELSE ' WITH NO DATA' END"));
        assert!(view_sql.contains("n.nspname = 'public'"));
        assert!(view_sql.contains("c.relname = 'active_users'"));

        assert_eq!(
            postgres_object_source_sql("public", "recalc_score", &ObjectSourceKind::Function, None),
            "SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'recalc_score' AND p.prokind = 'f' ORDER BY p.oid LIMIT 1"
        );

        assert_eq!(
            postgres_object_source_sql("public", "recalc_score", &ObjectSourceKind::Function, Some("integer, integer")),
            "SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'recalc_score' AND p.prokind = 'f' AND pg_get_function_identity_arguments(p.oid) = 'integer, integer' ORDER BY p.oid LIMIT 1"
        );
    }

    #[test]
    fn builds_postgres_object_source_sql_for_table_trigger() {
        let sql = postgres_trigger_object_source_sql("audit", "trg_orders_update", Some("orders"));

        assert!(sql.contains("pg_get_triggerdef(t.oid, true)"));
        assert!(sql.contains("n.nspname = 'audit'"));
        assert!(sql.contains("c.relname = 'orders'"));
        assert!(sql.contains("t.tgname = 'trg_orders_update'"));
        assert!(sql.contains("NOT t.tgisinternal"));
    }

    #[test]
    fn builds_postgres_object_source_sql_without_relispopulated_for_legacy_catalogs() {
        let sql = postgres_object_source_sql_without_relispopulated(
            "public",
            "active_users",
            &ObjectSourceKind::MaterializedView,
            None,
        );

        assert!(sql.contains("CREATE MATERIALIZED VIEW"));
        assert!(sql.contains("pg_get_viewdef(c.oid, 0)"));
        assert!(!sql.contains("relispopulated"));
    }

    #[test]
    fn builds_postgres_function_source_sql_without_prokind_for_legacy_catalogs() {
        let sql = postgres_function_object_source_sql_without_prokind("public", "recalc_score", false);

        assert_eq!(
            sql,
            "SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'recalc_score' AND NOT p.proisagg AND NOT p.proiswindow ORDER BY p.oid LIMIT 1"
        );
    }

    #[test]
    fn builds_opengauss_routine_source_sql_from_record_definition() {
        assert_eq!(
            opengauss_object_source_sql("public", "recalc_score", &ObjectSourceKind::Function, None),
            "SELECT (pg_get_functiondef(p.oid)).definition FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'recalc_score' AND p.prokind = 'f' ORDER BY p.oid LIMIT 1"
        );
        assert_eq!(
            opengauss_object_source_sql(
                "public",
                "refresh_cache",
                &ObjectSourceKind::Procedure,
                Some("integer"),
            ),
            "SELECT (pg_get_functiondef(p.oid)).definition FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'refresh_cache' AND p.prokind = 'p' AND pg_get_function_identity_arguments(p.oid) = 'integer' ORDER BY p.oid LIMIT 1"
        );

        assert_eq!(
            postgres_function_object_source_sql_without_prokind("public", "recalc_score", true),
            "SELECT (pg_get_functiondef(p.oid)).definition FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'recalc_score' AND NOT p.proisagg AND NOT p.proiswindow ORDER BY p.oid LIMIT 1"
        );
    }

    #[test]
    fn decodes_opengauss_binary_function_definition_record() {
        let definition = "CREATE OR REPLACE FUNCTION pg_catalog.pg_table_size(regclass)\n RETURNS bigint\n LANGUAGE internal\n STRICT NOT FENCED NOT SHIPPABLE\nAS $function$pg_table_size$function$;\n";
        let encoded = concat!(
            "0x0000000200000017000000040000000400000019000000a8",
            "435245415445204f52205245504c4143452046554e4354494f4e2070675f636174616c6f672e70675f7461626c655f73697a6528726567636c617373290a",
            "2052455455524e5320626967696e740a204c414e475541474520696e7465726e616c0a20535452494354204e4f542046454e434544204e4f5420534849505041424c450a",
            "4153202466756e6374696f6e2470675f7461626c655f73697a652466756e6374696f6e243b0a"
        );

        assert_eq!(decode_opengauss_functiondef_record(encoded).as_deref(), Some(definition));
        assert_eq!(normalize_routine_object_source(encoded.to_string()), definition);
    }

    #[test]
    fn preserves_text_and_malformed_opengauss_function_definitions() {
        let postgres =
            "CREATE OR REPLACE FUNCTION public.recalc_score() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;";
        assert_eq!(normalize_routine_object_source(postgres.to_string()), postgres);

        let ordinary_hex = "0x4352454154452046554e4354494f4e";
        assert_eq!(normalize_routine_object_source(ordinary_hex.to_string()), ordinary_hex);

        let mut truncated = opengauss_functiondef_record_hex(4, postgres.as_bytes());
        truncated.truncate(truncated.len() - 2);
        assert_eq!(normalize_routine_object_source(truncated.clone()), truncated);

        let non_routine = opengauss_functiondef_record_hex(4, b"SELECT 1");
        assert_eq!(normalize_routine_object_source(non_routine.clone()), non_routine);

        let invalid_utf8 = opengauss_functiondef_record_hex(4, &[0xff, 0xfe]);
        assert_eq!(normalize_routine_object_source(invalid_utf8.clone()), invalid_utf8);
    }

    #[test]
    fn builds_opengauss_sequence_source_without_pg_sequence_catalog() {
        let sql = opengauss_object_source_sql("public", "order_id_seq", &ObjectSourceKind::Sequence, None);

        assert!(sql.contains("information_schema.sequences"));
        assert!(sql.contains("s.sequence_schema = n.nspname"));
        assert!(sql.contains("s.sequence_name = c.relname"));
        assert!(sql.contains("c.relkind IN ('S','L','z','Z')"));
        assert!(sql.contains("CASE WHEN c.relkind IN ('L','Z') THEN 'large '"));
        assert!(sql.contains("increment by"));
        assert!(sql.contains("start with"));
        assert!(sql.contains("(pg_sequence_last_value(c.oid)).cache_value::text"));
        assert!(sql.contains("cycle;"));
        assert!(!sql.contains("pg_catalog.pg_sequence"));

        let fallback_sql = opengauss_sequence_object_source_sql("public", "order_id_seq", false);
        assert!(fallback_sql.contains("c.relkind IN ('S','L','z','Z')"));
        assert!(fallback_sql.contains("CASE WHEN c.relkind IN ('L','Z') THEN 'large '"));
        assert!(!fallback_sql.contains("pg_sequence_last_value"));
        assert!(!fallback_sql.contains("cache_value"));
    }

    #[test]
    fn detects_opengauss_sequence_cache_metadata_fallback_errors() {
        assert!(opengauss_sequence_cache_metadata_error("cannot execute pg_sequence_last_value() on a standby node"));
        assert!(opengauss_sequence_cache_metadata_error("column notation .cache_value applied to type text"));
        assert!(!opengauss_sequence_cache_metadata_error("permission denied for sequence order_id_seq"));
    }

    #[test]
    fn composes_opengauss_text_return_and_missing_prokind_fallbacks() {
        let text_return = opengauss_routine_source_fallback_sqls(
            "public",
            "recalc_score",
            &ObjectSourceKind::Function,
            None,
            "column notation .definition applied to type text",
        );
        assert_eq!(text_return.len(), 3);
        assert_eq!(text_return[0].0, "text-return");
        assert!(text_return[0].1.contains("p.prokind = 'f'"));
        assert_eq!(text_return[2].0, "text-return without prokind");
        assert!(!text_return[2].1.contains("p.prokind"));
        assert!(!text_return[2].1.contains(".definition"));

        let missing_prokind = opengauss_routine_source_fallback_sqls(
            "public",
            "recalc_score",
            &ObjectSourceKind::Function,
            None,
            "column p.prokind does not exist",
        );
        assert_eq!(missing_prokind.len(), 2);
        assert_eq!(missing_prokind[0].0, "record-return without prokind");
        assert_eq!(missing_prokind[1].0, "text-return without prokind");
    }

    #[test]
    fn keeps_legacy_materialized_viewdef_when_it_already_contains_create_statement() {
        let sql = postgres_object_source_sql("public", "active_users", &ObjectSourceKind::MaterializedView, None);

        assert!(
            sql.contains(
                "~* '^[[:space:]]*CREATE[[:space:]]+(OR[[:space:]]+REPLACE[[:space:]]+)?MATERIALIZED[[:space:]]+VIEW[[:space:]]+'"
            )
        );
        assert!(sql.contains(
            "THEN regexp_replace(pg_get_viewdef(c.oid, 0), ';[[:space:]]*$', '') ELSE format('CREATE MATERIALIZED VIEW"
        ));
    }

    #[test]
    fn detects_legacy_postgres_relispopulated_errors() {
        assert!(postgres_missing_relispopulated_error("ERROR: column c.relispopulated does not exist"));
        assert!(!postgres_missing_relispopulated_error("ERROR: relation public.relispopulated does not exist"));
    }

    #[test]
    fn detects_legacy_postgres_prokind_errors() {
        assert!(postgres_missing_prokind_error("ERROR: column p.prokind does not exist"));
        assert!(postgres_missing_prokind_error("ERROR: column \"p\".\"prokind\" does not exist"));
        assert!(!postgres_missing_prokind_error("ERROR: relation public.prokind does not exist"));
    }

    #[test]
    fn builds_postgres_view_source_sql_without_regclass_cast() {
        let sql = postgres_object_source_sql("tenant's schema", "active users", &ObjectSourceKind::View, None);

        assert!(!sql.contains("::regclass"));
        assert!(sql.contains("pg_get_viewdef(c.oid, 0)"));
        assert!(sql.contains("format('CREATE OR REPLACE VIEW %I.%I AS ', n.nspname, c.relname)"));
        assert!(sql.contains("n.nspname = 'tenant''s schema'"));
        assert!(sql.contains("c.relname = 'active users'"));
        assert!(sql.contains("c.relkind IN ('v','m')"));
    }

    #[test]
    fn builds_postgres_view_source_fallback_sql_from_pg_views() {
        assert_eq!(
            postgres_view_source_fallback_sql("tenant's schema", "active users"),
            "SELECT definition FROM pg_catalog.pg_views WHERE schemaname = 'tenant''s schema' AND viewname = 'active users' LIMIT 1"
        );
    }

    #[test]
    fn builds_oracle_object_source_sql_using_metadata_api() {
        assert_eq!(
            oracle_object_source_sql("HR", "ACTIVE_USERS", &ObjectSourceKind::View),
            "SELECT DBMS_METADATA.GET_DDL('VIEW', 'ACTIVE_USERS', 'HR') FROM DUAL"
        );
        assert_eq!(
            oracle_object_source_sql("HR", "PAYROLL", &ObjectSourceKind::PackageBody),
            "SELECT DBMS_METADATA.GET_DDL('PACKAGE_BODY', 'PAYROLL', 'HR') FROM DUAL"
        );
        assert_eq!(
            oracle_object_source_sql("", "PAYROLL", &ObjectSourceKind::Package),
            "SELECT DBMS_METADATA.GET_DDL('PACKAGE', 'PAYROLL') FROM DUAL"
        );
    }

    #[test]
    fn builds_oracle_list_objects_sql_with_packages() {
        let sql = oracle_list_objects_sql("hr");

        assert!(sql.contains("'PACKAGE'"));
        assert!(sql.contains("'PACKAGE BODY'"));
        assert!(sql.contains("CASE object_type WHEN 'PACKAGE BODY' THEN 'PACKAGE_BODY'"));
        assert!(sql.contains("owner = 'HR'"));
    }

    #[test]
    fn appends_oracle_table_and_column_comments_to_ddl() {
        let column = db::ColumnInfo {
            name: "DISPLAY\"NAME".to_string(),
            data_type: "VARCHAR2(100)".to_string(),
            is_nullable: true,
            column_default: None,
            is_primary_key: false,
            extra: None,
            comment: Some("User's display name".to_string()),
            numeric_precision: None,
            numeric_scale: None,
            character_maximum_length: None,
            enum_values: None,
            ..Default::default()
        };
        let mut ignored = column.clone();
        ignored.name = "EMPTY_COMMENT".to_string();
        ignored.comment = Some(" ".to_string());

        let ddl = append_oracle_comments_to_ddl(
            "CREATE TABLE \"HR\".\"USERS\" (\n  \"ID\" NUMBER\n);\n",
            "HR",
            "USERS",
            Some("User table"),
            &[column, ignored],
        );

        assert!(ddl.contains("CREATE TABLE \"HR\".\"USERS\""));
        assert!(ddl.contains("COMMENT ON TABLE \"HR\".\"USERS\" IS 'User table';"));
        assert!(ddl.contains("COMMENT ON COLUMN \"HR\".\"USERS\".\"DISPLAY\"\"NAME\" IS 'User''s display name';"));
        assert!(!ddl.contains("EMPTY_COMMENT\" IS"));
    }

    #[test]
    fn does_not_duplicate_existing_oracle_comment_ddl() {
        let column = db::ColumnInfo {
            name: "DISPLAY_NAME".to_string(),
            data_type: "VARCHAR2(100)".to_string(),
            is_nullable: true,
            column_default: None,
            is_primary_key: false,
            extra: None,
            comment: Some("New column comment".to_string()),
            numeric_precision: None,
            numeric_scale: None,
            character_maximum_length: None,
            enum_values: None,
            ..Default::default()
        };

        let ddl = append_oracle_comments_to_ddl(
            "CREATE TABLE \"HR\".\"USERS\" (\"ID\" NUMBER);\nCOMMENT ON TABLE \"HR\".\"USERS\" IS 'Existing';\nCOMMENT ON COLUMN \"HR\".\"USERS\".\"ID\" IS 'Existing';",
            "HR",
            "USERS",
            Some("New table comment"),
            &[column],
        );

        assert_eq!(ddl.matches("COMMENT ON TABLE").count(), 1);
        assert_eq!(ddl.matches("COMMENT ON COLUMN").count(), 1);
        assert!(!ddl.contains("New table comment"));
        assert!(!ddl.contains("New column comment"));
    }
}

#[cfg(test)]
mod ddl_tests {
    use super::*;

    fn column(name: &str, data_type: &str) -> db::ColumnInfo {
        db::ColumnInfo {
            name: name.to_string(),
            data_type: data_type.to_string(),
            is_nullable: true,
            column_default: None,
            is_primary_key: false,
            extra: None,
            comment: None,
            numeric_precision: None,
            numeric_scale: None,
            character_maximum_length: None,
            enum_values: None,
            ..Default::default()
        }
    }

    #[test]
    fn postgres_table_ddl_includes_column_comments() {
        let mut display_name = column("display_name", "text");
        display_name.comment = Some("User's display name".to_string());
        let columns = vec![display_name];

        let ddl = render_postgres_table_ddl("public", "users", &columns, &[], &[], None);

        assert!(ddl.contains("COMMENT ON COLUMN \"public\".\"users\".\"display_name\" IS 'User''s display name';"));
    }

    #[test]
    fn postgres_table_ddl_includes_table_comment() {
        let columns = vec![column("id", "integer")];

        let ddl = render_postgres_table_ddl("public", "users", &columns, &[], &[], Some("User table"));

        assert!(ddl.contains("COMMENT ON TABLE \"public\".\"users\" IS 'User table';"));
    }

    #[test]
    fn postgres_display_ddl_preserves_owner_revokes_and_grant_chain() {
        use db::postgres::{PostgresTableAccessInfo, PostgresTablePrivilegeInfo};

        let privilege =
            |grantor: &str, grantee: &str, privilege_type: &str, is_grantable: bool, column_name: Option<&str>| {
                PostgresTablePrivilegeInfo {
                    grantor: grantor.to_string(),
                    grantee: grantee.to_string(),
                    privilege_type: privilege_type.to_string(),
                    is_grantable,
                    column_name: column_name.map(str::to_string),
                }
            };
        let access = PostgresTableAccessInfo {
            owner: "table\"owner".to_string(),
            owner_default_privileges: vec!["DELETE", "INSERT", "SELECT", "UPDATE"]
                .into_iter()
                .map(str::to_string)
                .collect(),
            privileges: vec![
                privilege("table\"owner", "table\"owner", "SELECT", false, None),
                privilege("table\"owner", "z manager", "SELECT", true, None),
                privilege("table\"owner", "z manager", "SELECT", true, Some("customer_name")),
                privilege("z manager", "a delegate", "SELECT", true, None),
                privilege("a delegate", "reader role", "SELECT", false, Some("customer_name")),
                privilege("z manager", "reader role", "SELECT", false, Some("customer_name")),
                privilege("table\"owner", "PUBLIC", "INSERT", false, Some("customer_name")),
                privilege("table\"owner", "PUBLIC", "INSERT", false, Some("amount")),
            ],
        };

        let ddl = append_postgres_access_ddl(
            "CREATE TABLE \"app\".\"orders\" (\n  \"id\" bigint\n);\n".to_string(),
            "app",
            "orders",
            &access,
        );

        assert!(ddl.contains("ALTER TABLE \"app\".\"orders\" OWNER TO \"table\"\"owner\";"));
        assert!(ddl.contains("REVOKE DELETE, INSERT, UPDATE ON TABLE \"app\".\"orders\" FROM \"table\"\"owner\";"));
        assert!(ddl.contains("GRANT INSERT (\"amount\", \"customer_name\") ON TABLE \"app\".\"orders\" TO PUBLIC;"));
        assert!(ddl.contains("GRANT SELECT (\"customer_name\") ON TABLE \"app\".\"orders\" TO \"reader role\";"));

        let owner_role = ddl.find("SET ROLE \"table\"\"owner\";").unwrap();
        let manager_role = ddl.find("SET ROLE \"z manager\";").unwrap();
        let delegate_role = ddl.find("SET ROLE \"a delegate\";").unwrap();
        assert!(owner_role < manager_role && manager_role < delegate_role, "ddl: {ddl}");
        assert!(ddl[owner_role..manager_role]
            .contains("GRANT SELECT ON TABLE \"app\".\"orders\" TO \"z manager\" WITH GRANT OPTION;"));
        assert!(ddl[owner_role..manager_role].contains(
            "GRANT SELECT (\"customer_name\") ON TABLE \"app\".\"orders\" TO \"z manager\" WITH GRANT OPTION;"
        ));
        assert!(ddl[manager_role..delegate_role]
            .contains("GRANT SELECT ON TABLE \"app\".\"orders\" TO \"a delegate\" WITH GRANT OPTION;"));
        assert!(ddl[delegate_role..]
            .contains("GRANT SELECT (\"customer_name\") ON TABLE \"app\".\"orders\" TO \"reader role\";"));
    }

    #[test]
    fn postgres_display_ddl_can_revoke_all_owner_ordinary_privileges() {
        let access = db::postgres::PostgresTableAccessInfo {
            owner: "locked_owner".to_string(),
            owner_default_privileges: vec!["INSERT", "SELECT", "UPDATE"].into_iter().map(str::to_string).collect(),
            privileges: vec![],
        };

        let ddl = append_postgres_access_ddl(
            "CREATE TABLE \"app\".\"locked\" (\"id\" bigint);".to_string(),
            "app",
            "locked",
            &access,
        );

        assert!(ddl.contains("SET ROLE \"locked_owner\";"));
        assert!(ddl.contains("REVOKE INSERT, SELECT, UPDATE ON TABLE \"app\".\"locked\" FROM \"locked_owner\";"));
        assert!(ddl.ends_with("RESET ROLE;"));
    }

    #[test]
    fn postgres_table_ddl_omits_table_comment_when_empty() {
        let columns = vec![column("id", "integer")];

        let ddl = render_postgres_table_ddl("public", "users", &columns, &[], &[], Some(""));

        assert!(!ddl.contains("COMMENT ON TABLE"));
    }

    #[test]
    fn postgres_table_ddl_preserves_table_comment_whitespace() {
        let columns = vec![column("id", "integer")];

        let ddl = render_postgres_table_ddl("public", "users", &columns, &[], &[], Some("  User table  "));

        assert!(ddl.contains("COMMENT ON TABLE \"public\".\"users\" IS '  User table  ';"));
    }

    #[test]
    fn postgres_table_ddl_includes_generated_identity() {
        let mut id = column("id", "integer");
        id.is_nullable = false;
        id.is_primary_key = true;
        id.extra = Some("generated by default as identity".to_string());

        let ddl = render_postgres_table_ddl("public", "users", &[id], &[], &[], None);

        assert!(ddl.contains("\"id\" integer generated by default as identity NOT NULL"), "ddl: {ddl}");
    }

    #[test]
    fn postgres_table_ddl_includes_partition_key_for_parent_only() {
        for partition_key in [
            "RANGE (created_at)",
            "LIST (\"Tenant ID\")",
            "HASH ((lower(code)))",
            "RANGE (date_trunc('month'::text, created_at))",
        ] {
            let ddl = render_postgres_table_ddl_with_partition_info(
                "public",
                "events",
                &[column("created_at", "timestamp without time zone")],
                &[],
                &[],
                None,
                &db::postgres::PostgresTablePartitionInfo {
                    key: Some(partition_key.to_string()),
                    ..Default::default()
                },
                &db::postgres::PostgresTablePartitionLocalObjects::default(),
            );

            assert!(ddl.ends_with(&format!(") PARTITION BY {partition_key};\n")), "ddl: {ddl}");
            assert!(!ddl.contains("PARTITION OF"));
        }
    }

    #[test]
    fn postgres_table_ddl_keeps_ordinary_table_unchanged() {
        let ddl = render_postgres_table_ddl_with_partition_info(
            "public",
            "users",
            &[column("id", "integer")],
            &[],
            &[],
            None,
            &db::postgres::PostgresTablePartitionInfo::default(),
            &db::postgres::PostgresTablePartitionLocalObjects::default(),
        );

        assert!(ddl.ends_with(");\n"), "ddl: {ddl}");
        assert!(!ddl.contains("PARTITION BY"));
    }

    #[test]
    fn postgres_table_ddl_renders_partition_children_and_subpartitions() {
        let mut id = column("id", "integer");
        id.is_primary_key = true;
        let indexes = vec![db::IndexInfo {
            name: "events_payload_idx".to_string(),
            columns: vec!["payload".to_string()],
            is_unique: false,
            is_primary: false,
            filter: None,
            index_type: Some("btree".to_string()),
            included_columns: None,
            comment: None,
        }];
        let partition_info = db::postgres::PostgresTablePartitionInfo {
            is_partition: true,
            parent_schema: Some("public".to_string()),
            parent_table: Some("events".to_string()),
            bound: Some("FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')".to_string()),
            key: Some("HASH (payload)".to_string()),
        };
        let partition_local_objects = db::postgres::PostgresTablePartitionLocalObjects {
            has_primary_key: true,
            foreign_keys: BTreeSet::new(),
            indexes: BTreeSet::from(["events_payload_idx".to_string()]),
        };

        let ddl = render_postgres_table_ddl_with_partition_info(
            "public",
            "events_2026",
            &[id, column("payload", "text")],
            &indexes,
            &[],
            None,
            &partition_info,
            &partition_local_objects,
        );

        assert!(ddl.starts_with(
            "CREATE TABLE \"public\".\"events_2026\" PARTITION OF \"public\".\"events\" (\n  PRIMARY KEY (\"id\")\n)"
        ));
        assert!(ddl.contains("FOR VALUES FROM ('2026-01-01') TO ('2027-01-01') PARTITION BY HASH (payload);"));
        assert!(ddl.contains("CREATE INDEX \"events_payload_idx\""));
        assert!(!ddl.contains("\"payload\" text"));
    }

    #[test]
    fn postgres_partition_ddl_skips_inherited_constraints_and_indexes() {
        let mut id = column("id", "integer");
        id.is_primary_key = true;
        let indexes = vec![db::IndexInfo {
            name: "events_2026_pkey".to_string(),
            columns: vec!["id".to_string()],
            is_unique: true,
            is_primary: true,
            filter: None,
            index_type: Some("btree".to_string()),
            included_columns: None,
            comment: None,
        }];
        let partition_info = db::postgres::PostgresTablePartitionInfo {
            is_partition: true,
            parent_schema: Some("public".to_string()),
            parent_table: Some("events".to_string()),
            bound: Some("DEFAULT".to_string()),
            key: None,
        };

        let ddl = render_postgres_table_ddl_with_partition_info(
            "public",
            "events_default",
            &[id],
            &indexes,
            &[],
            None,
            &partition_info,
            &db::postgres::PostgresTablePartitionLocalObjects::default(),
        );

        assert_eq!(ddl, "CREATE TABLE \"public\".\"events_default\" PARTITION OF \"public\".\"events\" DEFAULT;\n");
    }

    #[test]
    fn postgres_table_ddl_keeps_composite_foreign_key_together() {
        let columns = vec![column("a", "integer"), column("b", "integer"), column("c", "integer")];
        let foreign_keys = vec![
            db::ForeignKeyInfo {
                name: "aaa_1".to_string(),
                column: "a".to_string(),
                ref_schema: Some("public".to_string()),
                ref_table: "aaa_2".to_string(),
                ref_column: "a".to_string(),
                on_update: None,
                on_delete: None,
            },
            db::ForeignKeyInfo {
                name: "aaa_1".to_string(),
                column: "b".to_string(),
                ref_schema: Some("public".to_string()),
                ref_table: "aaa_2".to_string(),
                ref_column: "b".to_string(),
                on_update: None,
                on_delete: None,
            },
            db::ForeignKeyInfo {
                name: "aaa_1".to_string(),
                column: "c".to_string(),
                ref_schema: Some("public".to_string()),
                ref_table: "aaa_2".to_string(),
                ref_column: "c".to_string(),
                on_update: None,
                on_delete: None,
            },
        ];

        let ddl = render_postgres_table_ddl("public", "aaa_1", &columns, &[], &foreign_keys, None);

        assert!(ddl.contains(
            "CONSTRAINT \"aaa_1\" FOREIGN KEY (\"a\", \"b\", \"c\") REFERENCES \"aaa_2\"(\"a\", \"b\", \"c\")"
        ));
        assert_eq!(ddl.matches("CONSTRAINT \"aaa_1\" FOREIGN KEY").count(), 1);
    }

    #[test]
    fn postgres_table_ddl_appends_trigger_definitions() {
        let ddl = append_postgres_trigger_definitions(
            render_postgres_table_ddl("public", "users", &[column("id", "integer")], &[], &[], None),
            &[r#"CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON "public"."users" FOR EACH ROW EXECUTE FUNCTION set_updated_at()"#
                .to_string()],
        );

        assert!(ddl.contains("CREATE TABLE \"public\".\"users\""));
        assert!(ddl.contains(
            "\n\nCREATE TRIGGER users_set_updated_at BEFORE UPDATE ON \"public\".\"users\" FOR EACH ROW EXECUTE FUNCTION set_updated_at();"
        ));
    }

    #[test]
    fn postgres_table_ddl_does_not_duplicate_trigger_statement_terminators() {
        let ddl = append_postgres_trigger_definitions(
            render_postgres_table_ddl("public", "users", &[column("id", "integer")], &[], &[], None),
            &[r#"CREATE TRIGGER users_audit AFTER INSERT ON "public"."users" FOR EACH ROW EXECUTE FUNCTION audit_user();"#.to_string()],
        );

        assert!(!ddl.contains("audit_user();;"), "ddl: {ddl}");
    }

    #[test]
    fn sqlserver_table_ddl_includes_column_comments() {
        let mut display_name = column("display]name", "nvarchar(100)");
        display_name.comment = Some("User's display name".to_string());
        let columns = vec![display_name];

        let ddl = render_sqlserver_table_ddl("dbo", "users", &columns, &[], &[], None);

        assert!(ddl.contains("CREATE TABLE [dbo].[users] (\n  [display]]name] nvarchar(100)\n);"));
        assert!(ddl.contains(
            "EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'User''s display name', @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'users', @level2type=N'COLUMN', @level2name=N'display]name';"
        ));
    }

    #[test]
    fn sqlserver_table_ddl_includes_table_comment() {
        let columns = vec![column("id", "int")];

        let ddl = render_sqlserver_table_ddl("dbo", "users", &columns, &[], &[], Some("User table"));

        assert!(ddl.contains(
            "EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'User table', @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'users';"
        ));
    }

    #[test]
    fn sqlserver_table_ddl_omits_table_comment_when_empty() {
        let columns = vec![column("id", "int")];

        let ddl = render_sqlserver_table_ddl("dbo", "users", &columns, &[], &[], Some(""));

        assert!(!ddl.contains("MS_Description"));
    }

    #[test]
    fn sqlserver_table_ddl_preserves_table_comment_whitespace() {
        let columns = vec![column("id", "int")];

        let ddl = render_sqlserver_table_ddl("dbo", "users", &columns, &[], &[], Some("  User table  "));

        assert!(ddl.contains("@value=N'  User table  '"));
    }

    #[test]
    fn sqlserver_table_ddl_includes_identity_clause() {
        let mut id = column("FIDS", "int");
        id.is_nullable = false;
        id.is_primary_key = true;
        id.extra = Some("identity(1,1)".to_string());

        let ddl = render_sqlserver_table_ddl("dbo", "ZHLSBS", &[id], &[], &[], None);

        assert!(ddl.contains("[FIDS] int IDENTITY(1,1) NOT NULL"), "ddl: {ddl}");
    }

    #[test]
    fn opengauss_table_ddl_uses_native_tabledef_function() {
        assert_eq!(
            opengauss_table_ddl_sql("tenant's schema", "active users"),
            "SELECT pg_get_tabledef('\"tenant''s schema\".\"active users\"')"
        );
    }

    #[test]
    fn opengauss_table_ddl_appends_trigger_definitions() {
        let ddl = append_opengauss_trigger_definitions(
            "CREATE TABLE \"public\".\"users\" (\n  \"id\" integer\n);".to_string(),
            &[r#"CREATE TRIGGER users_bi BEFORE INSERT ON "public"."users" FOR EACH ROW EXECUTE PROCEDURE fill_created_at()"#
                .to_string()],
        );

        assert!(ddl.contains("CREATE TABLE \"public\".\"users\""));
        assert!(ddl.contains(
            "\n\nCREATE TRIGGER users_bi BEFORE INSERT ON \"public\".\"users\" FOR EACH ROW EXECUTE PROCEDURE fill_created_at();"
        ));
    }

    #[test]
    fn mysql_display_ddl_gets_statement_terminator() {
        let ddl = "CREATE TABLE `users` (\n  `id` int NOT NULL\n) ENGINE=InnoDB";

        assert_eq!(
            ensure_display_ddl_terminated(ddl.to_string()),
            "CREATE TABLE `users` (\n  `id` int NOT NULL\n) ENGINE=InnoDB;"
        );
    }

    #[test]
    fn mysql_display_ddl_does_not_duplicate_existing_terminator() {
        let ddl = "CREATE TABLE `users` (`id` int);\n";

        assert_eq!(ensure_display_ddl_terminated(ddl.to_string()), ddl);
    }

    #[test]
    fn mysql_display_ddl_repairs_double_encoded_comments() {
        let ddl = "CREATE TABLE `订单` (\n  `id` bigint COMMENT 'è®¢åID',\n  `reviewed_at` datetime COMMENT 'å®¡æ ¸æ¶é´'\n) COMMENT='订单表'";

        assert_eq!(
            normalize_mysql_display_ddl(ddl.to_string()),
            "CREATE TABLE `订单` (\n  `id` bigint COMMENT '订单ID',\n  `reviewed_at` datetime COMMENT '审核时间'\n) COMMENT='订单表';"
        );
    }

    #[test]
    fn mysql_display_ddl_preserves_valid_text() {
        let ddl = "CREATE TABLE `orders` (`id` bigint COMMENT '订单ID') ENGINE=InnoDB";

        assert_eq!(
            normalize_mysql_display_ddl(ddl.to_string()),
            "CREATE TABLE `orders` (`id` bigint COMMENT '订单ID') ENGINE=InnoDB;"
        );
    }

    #[test]
    fn mysql_display_ddl_only_repairs_comment_clauses() {
        let ddl = "CREATE TABLE `comment` (\n  `comment` varchar(64) DEFAULT 'è®¢åID',\n  `kind` enum('comment', 'å®¡æ ¸æ¶é´') COMMENT 'å®¡æ ¸æ¶é´'\n) /* COMMENT 'è®¢åID' */";

        assert_eq!(
            normalize_mysql_display_ddl(ddl.to_string()),
            "CREATE TABLE `comment` (\n  `comment` varchar(64) DEFAULT 'è®¢åID',\n  `kind` enum('comment', 'å®¡æ ¸æ¶é´') COMMENT '审核时间'\n) /* COMMENT 'è®¢åID' */;"
        );
    }

    #[test]
    fn mysql_display_ddl_preserves_unterminated_literals() {
        let ddl = "CREATE TABLE `orders` (`note` varchar(64) DEFAULT 'unfinished COMMENT 'è®¢åID'";

        assert_eq!(normalize_mysql_display_ddl(ddl.to_string()), format!("{ddl};"));
    }

    struct FakeMysqlDdlExecutor {
        outcomes: std::collections::VecDeque<Result<String, MysqlDdlQueryError>>,
        executed: Vec<String>,
    }

    impl MysqlDdlQueryExecutor for FakeMysqlDdlExecutor {
        async fn execute(&mut self, sql: &str) -> Result<String, MysqlDdlQueryError> {
            self.executed.push(sql.to_string());
            self.outcomes.pop_front().expect("test outcome for DDL query")
        }
    }

    fn mysql_server_error(code: u16, message: &str) -> MysqlDdlQueryError {
        MysqlDdlQueryError::Query(mysql_async::Error::Server(mysql_async::ServerError {
            code,
            message: message.to_string(),
            state: "HY000".to_string(),
        }))
    }

    #[tokio::test]
    async fn mysql_ddl_uses_one_qualified_query_on_success() {
        let mut executor = FakeMysqlDdlExecutor {
            outcomes: [Ok("CREATE TABLE `users` (`id` int)".to_string())].into(),
            executed: Vec::new(),
        };

        let ddl = mysql_ddl_with_executor(&mut executor, "app", "users").await.unwrap();

        assert_eq!(ddl, "CREATE TABLE `users` (`id` int);");
        assert_eq!(executor.executed, ["SHOW CREATE TABLE `app`.`users`"]);
    }

    #[tokio::test]
    async fn mysql_ddl_retries_unqualified_after_no_such_table() {
        let mut executor = FakeMysqlDdlExecutor {
            outcomes: [
                Err(mysql_server_error(1146, "Table 'retail`fas.account`details' doesn't exist")),
                Ok("CREATE TABLE `account``details` (`id` int)".to_string()),
            ]
            .into(),
            executed: Vec::new(),
        };

        let ddl = mysql_ddl_with_executor(&mut executor, "retail`fas", "account`details").await.unwrap();

        assert_eq!(ddl, "CREATE TABLE `account``details` (`id` int);");
        assert_eq!(
            executor.executed,
            ["SHOW CREATE TABLE `retail``fas`.`account``details`", "SHOW CREATE TABLE `account``details`",]
        );
    }

    #[tokio::test]
    async fn mysql_ddl_preserves_qualified_error_when_fallback_fails() {
        let first_error = mysql_server_error(1146, "qualified table doesn't exist");
        let expected = first_error.to_string();
        let mut executor = FakeMysqlDdlExecutor {
            outcomes: [Err(first_error), Err(mysql_server_error(1146, "unqualified table doesn't exist"))].into(),
            executed: Vec::new(),
        };

        let error = mysql_ddl_with_executor(&mut executor, "app", "missing").await.unwrap_err();

        assert_eq!(error, expected);
        assert_eq!(executor.executed, ["SHOW CREATE TABLE `app`.`missing`", "SHOW CREATE TABLE `missing`"]);
    }

    #[tokio::test]
    async fn mysql_ddl_does_not_retry_other_server_errors() {
        let first_error = mysql_server_error(1044, "access denied");
        let expected = first_error.to_string();
        let mut executor = FakeMysqlDdlExecutor {
            outcomes: [Err(first_error), Ok("unexpected fallback".to_string())].into(),
            executed: Vec::new(),
        };

        let error = mysql_ddl_with_executor(&mut executor, "app", "users").await.unwrap_err();

        assert_eq!(error, expected);
        assert_eq!(executor.executed, ["SHOW CREATE TABLE `app`.`users`"]);
    }

    #[tokio::test]
    async fn mysql_ddl_does_not_retry_without_a_database() {
        let first_error = mysql_server_error(1146, "table doesn't exist");
        let expected = first_error.to_string();
        let mut executor = FakeMysqlDdlExecutor {
            outcomes: [Err(first_error), Ok("unexpected fallback".to_string())].into(),
            executed: Vec::new(),
        };

        let error = mysql_ddl_with_executor(&mut executor, "", "missing").await.unwrap_err();

        assert_eq!(error, expected);
        assert_eq!(executor.executed, ["SHOW CREATE TABLE `missing`"]);
    }

    #[tokio::test]
    async fn mysql_ddl_does_not_retry_result_parsing_errors() {
        let mut executor = FakeMysqlDdlExecutor {
            outcomes: [
                Err(MysqlDdlQueryError::Result("DDL not found".to_string())),
                Ok("unexpected fallback".to_string()),
            ]
            .into(),
            executed: Vec::new(),
        };

        let error = mysql_ddl_with_executor(&mut executor, "app", "users").await.unwrap_err();

        assert_eq!(error, "DDL not found");
        assert_eq!(executor.executed, ["SHOW CREATE TABLE `app`.`users`"]);
    }
}

#[derive(Debug)]
enum MysqlDdlQueryError {
    Query(mysql_async::Error),
    Result(String),
}

impl MysqlDdlQueryError {
    fn is_no_such_table(&self) -> bool {
        matches!(self, Self::Query(mysql_async::Error::Server(error)) if error.code == 1146)
    }
}

impl std::fmt::Display for MysqlDdlQueryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Query(error) => error.fmt(formatter),
            Self::Result(error) => error.fmt(formatter),
        }
    }
}

trait MysqlDdlQueryExecutor {
    async fn execute(&mut self, sql: &str) -> Result<String, MysqlDdlQueryError>;
}

struct MysqlDdlConnection<'a> {
    conn: &'a mut mysql_async::Conn,
}

impl MysqlDdlQueryExecutor for MysqlDdlConnection<'_> {
    async fn execute(&mut self, sql: &str) -> Result<String, MysqlDdlQueryError> {
        use mysql_async::prelude::*;

        let result = self.conn.query_iter(sql).await.map_err(MysqlDdlQueryError::Query)?;
        let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(MysqlDdlQueryError::Query)?;
        let row = rows.first().ok_or_else(|| MysqlDdlQueryError::Result("DDL not found".to_string()))?;
        row.get_opt::<String, usize>(1)
            .and_then(|result| result.ok())
            .or_else(|| {
                row.get_opt::<Vec<u8>, usize>(1)
                    .and_then(|result| result.ok())
                    .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
            })
            .ok_or_else(|| MysqlDdlQueryError::Result("Failed to read DDL".to_string()))
    }
}

async fn mysql_ddl_with_executor(
    executor: &mut impl MysqlDdlQueryExecutor,
    database: &str,
    table: &str,
) -> Result<String, String> {
    let sql = format!("SHOW CREATE TABLE {}", mysql_qualified_name(database, table));
    let qualified_error = match executor.execute(&sql).await {
        Ok(ddl) => return Ok(normalize_mysql_display_ddl(ddl)),
        Err(error) => error,
    };
    if database.trim().is_empty() || !qualified_error.is_no_such_table() {
        return Err(qualified_error.to_string());
    }

    // Mycat 1.x routes by the logical qualifier but forwards it unchanged to a
    // physical schema; the metadata pool has already selected the logical database.
    let fallback_sql = format!("SHOW CREATE TABLE {}", mysql_ident(table));
    match executor.execute(&fallback_sql).await {
        Ok(ddl) => Ok(normalize_mysql_display_ddl(ddl)),
        Err(_) => Err(qualified_error.to_string()),
    }
}

pub async fn mysql_ddl(pool: &db::mysql::MySqlPool, database: &str, table: &str) -> Result<String, String> {
    // Use the health-checked getter so a stale pooled connection (server closed
    // it after an idle timeout, NAT/firewall dropped the TCP state, etc.) is
    // detected and replaced before issuing the query. Without this, the first
    // DDL request after a period of inactivity could surface a low-level
    // connection error that a manual refresh would have masked.
    let mut conn = db::mysql::get_conn_with_health_check(pool).await?;
    mysql_ddl_with_executor(&mut MysqlDdlConnection { conn: &mut conn }, database, table).await
}

async fn external_driver_mysql_ddl(
    session: std::sync::Arc<crate::plugins::PluginDriverSession>,
    config: &ConnectionConfig,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<String, String> {
    let result: db::QueryResult = session
        .invoke_with_timeout(
            "executeQuery",
            serde_json::json!({
                "connection": config,
                "database": database,
                "schema": schema,
                "sql": mysql_external_driver_ddl_sql(database, schema, table),
                "maxRows": 1
            }),
            agent_metadata_timeout(Some(config)),
        )
        .await?;
    mysql_external_driver_ddl_from_query_result(result, "Create Table")
}

fn normalize_mysql_display_ddl(sql: String) -> String {
    ensure_display_ddl_terminated(repair_mysql_ddl_comments(&sql))
}

fn repair_mysql_ddl_comments(sql: &str) -> String {
    let mut repaired = String::with_capacity(sql.len());
    let mut cursor = 0;

    while let Some((comment_start, value_start, value_end)) = next_mysql_ddl_comment_literal(sql, cursor) {
        repaired.push_str(&sql[cursor..comment_start]);
        repaired.push_str(&sql[comment_start..value_start]);
        repaired.push_str(&db::mysql::fix_potential_double_encoding(&sql[value_start..value_end]));
        repaired.push('\'');
        cursor = value_end + 1;
    }

    repaired.push_str(&sql[cursor..]);
    repaired
}

fn next_mysql_ddl_comment_literal(sql: &str, from: usize) -> Option<(usize, usize, usize)> {
    let bytes = sql.as_bytes();
    let mut index = from;
    while index + 7 <= bytes.len() {
        match bytes[index] {
            b'\'' | b'"' | b'`' => {
                index = mysql_quoted_value_end(bytes, index)?;
                continue;
            }
            b'#' => {
                index = mysql_line_comment_end(bytes, index + 1);
                continue;
            }
            b'-' if bytes.get(index + 1) == Some(&b'-') => {
                index = mysql_line_comment_end(bytes, index + 2);
                continue;
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                index = mysql_block_comment_end(bytes, index + 2)?;
                continue;
            }
            _ => {}
        }

        if bytes[index..index + 7].eq_ignore_ascii_case(b"COMMENT")
            && (index == 0 || !is_mysql_identifier_byte(bytes[index - 1]))
            && (index + 7 == bytes.len() || !is_mysql_identifier_byte(bytes[index + 7]))
        {
            let comment_start = index;
            let mut quote = index + 7;
            while quote < bytes.len() && (bytes[quote].is_ascii_whitespace() || bytes[quote] == b'=') {
                quote += 1;
            }
            if bytes.get(quote) == Some(&b'\'') {
                let value_end = mysql_quoted_value_end(bytes, quote)?.saturating_sub(1);
                return Some((comment_start, quote + 1, value_end));
            }
            index += 7;
            continue;
        }
        index += 1;
    }
    None
}

fn is_mysql_identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$'
}

fn mysql_quoted_value_end(bytes: &[u8], quote: usize) -> Option<usize> {
    let delimiter = *bytes.get(quote)?;
    let mut index = quote + 1;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index = (index + 2).min(bytes.len()),
            value if value == delimiter && bytes.get(index + 1) == Some(&delimiter) => index += 2,
            value if value == delimiter => return Some(index + 1),
            _ => index += 1,
        }
    }
    None
}

fn mysql_line_comment_end(bytes: &[u8], from: usize) -> usize {
    bytes[from..].iter().position(|byte| *byte == b'\n').map_or(bytes.len(), |offset| from + offset + 1)
}

fn mysql_block_comment_end(bytes: &[u8], from: usize) -> Option<usize> {
    bytes[from..].windows(2).position(|window| window == b"*/").map(|offset| from + offset + 2)
}

fn ensure_display_ddl_terminated(sql: String) -> String {
    let trimmed = sql.trim_end();
    // SHOW CREATE TABLE returns a table definition, not a runnable script; DBX
    // displays/copies it as SQL, so include the default statement terminator.
    if trimmed.ends_with(';') {
        sql
    } else {
        format!("{trimmed};")
    }
}

pub async fn sqlite_ddl(pool: &db::sqlite::SqliteHandle, schema: &str, table: &str) -> Result<String, String> {
    let pool = pool.clone();
    let schema = schema.to_string();
    let table = table.to_string();
    tokio::task::spawn_blocking(move || {
        pool.with_connection(|conn| {
            let schema = db::sqlite::sqlite_quote_schema_ident_for_connection(conn, &schema)?;
            let sql = format!("SELECT sql FROM {}.sqlite_master WHERE type='table' AND name=?1", schema);
            conn.query_row(&sql, [table], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn pg_ddl(pool: &deadpool_postgres::Pool, schema: &str, table: &str) -> Result<String, String> {
    let (columns, indexes, fkeys, table_comment, partition_info, trigger_definitions) = tokio::try_join!(
        db::postgres::get_columns(pool, schema, table),
        db::postgres::list_indexes(pool, schema, table),
        db::postgres::list_foreign_keys(pool, schema, table),
        async { db::postgres::get_table_comment(pool, schema, table).await },
        db::postgres::get_table_partition_info(pool, schema, table),
        db::postgres::list_trigger_definitions(pool, schema, table),
    )?;
    let partition_local_objects = if partition_info.is_partition {
        db::postgres::get_table_partition_local_objects(pool, schema, table).await?
    } else {
        db::postgres::PostgresTablePartitionLocalObjects::default()
    };

    Ok(append_postgres_trigger_definitions(
        render_postgres_table_ddl_with_partition_info(
            schema,
            table,
            &columns,
            &indexes,
            &fkeys,
            table_comment.as_deref(),
            &partition_info,
            &partition_local_objects,
        ),
        &trigger_definitions,
    ))
}

async fn pg_display_ddl(pool: &deadpool_postgres::Pool, schema: &str, table: &str) -> Result<String, String> {
    let (ddl, access) = tokio::join!(pg_ddl(pool, schema, table), db::postgres::get_table_access(pool, schema, table));
    let ddl = ddl?;
    match access {
        Ok(access) => Ok(append_postgres_access_ddl(ddl, schema, table, &access)),
        Err(error) => {
            log::warn!(
                "[schema][postgres:table-access-ddl-fallback] schema={} table={} error={}",
                schema,
                table,
                error
            );
            Ok(ddl)
        }
    }
}

fn append_postgres_access_ddl(
    mut ddl: String,
    schema: &str,
    table: &str,
    access: &db::postgres::PostgresTableAccessInfo,
) -> String {
    let table_name = format!("{}.{}", pg_ident(schema), pg_ident(table));
    ddl = ddl.trim_end().to_string();
    if !ddl.ends_with(';') {
        ddl.push(';');
    }
    ddl.push_str(&format!("\n\nALTER TABLE {table_name} OWNER TO {};", pg_ident(&access.owner)));

    let owner_privileges = access
        .privileges
        .iter()
        .filter(|privilege| {
            privilege.grantor == access.owner && privilege.grantee == access.owner && privilege.column_name.is_none()
        })
        .map(|privilege| privilege.privilege_type.clone())
        .collect::<BTreeSet<_>>();
    let owner_revokes = access
        .owner_default_privileges
        .iter()
        .filter(|privilege| !owner_privileges.contains(*privilege))
        .cloned()
        .collect::<BTreeSet<_>>();
    let grants = normalized_postgres_grants(access);
    let grantor_order = postgres_grantor_order(&access.owner, !owner_revokes.is_empty(), &grants);

    // PostgreSQL records the active granting role, so each batch must run in that role's context.
    for grantor in grantor_order {
        ddl.push_str(&format!("\n\nSET ROLE {};", pg_ident(&grantor)));
        if grantor == access.owner && !owner_revokes.is_empty() {
            ddl.push_str(&format!(
                "\nREVOKE {} ON TABLE {table_name} FROM {};",
                owner_revokes.iter().cloned().collect::<Vec<_>>().join(", "),
                pg_ident(&access.owner)
            ));
        }
        append_postgres_grants_for_role(&mut ddl, &table_name, &grantor, &grants);
        ddl.push_str("\nRESET ROLE;");
    }

    ddl
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PostgresGrant {
    grantor: String,
    grantee: String,
    privilege_type: String,
    is_grantable: bool,
    column_name: Option<String>,
}

fn normalized_postgres_grants(access: &db::postgres::PostgresTableAccessInfo) -> Vec<PostgresGrant> {
    let mut grants = BTreeMap::<(String, String, String, Option<String>), bool>::new();
    for privilege in &access.privileges {
        if privilege.grantor == access.owner && privilege.grantee == access.owner && privilege.column_name.is_none() {
            continue;
        }
        *grants
            .entry((
                privilege.grantor.clone(),
                privilege.grantee.clone(),
                privilege.privilege_type.clone(),
                privilege.column_name.clone(),
            ))
            .or_default() |= privilege.is_grantable;
    }
    grants
        .into_iter()
        .map(|((grantor, grantee, privilege_type, column_name), is_grantable)| PostgresGrant {
            grantor,
            grantee,
            privilege_type,
            is_grantable,
            column_name,
        })
        .collect()
}

fn postgres_grant_scope_covers(parent: &PostgresGrant, child: &PostgresGrant) -> bool {
    if parent.privilege_type != child.privilege_type {
        return false;
    }
    match (&parent.column_name, &child.column_name) {
        (None, _) => true,
        (Some(parent), Some(child)) => parent == child,
        (Some(_), None) => false,
    }
}

fn postgres_grantor_order(owner: &str, include_owner: bool, grants: &[PostgresGrant]) -> Vec<String> {
    let mut remaining = grants.iter().map(|grant| grant.grantor.clone()).collect::<BTreeSet<_>>();
    if include_owner {
        remaining.insert(owner.to_string());
    }

    let mut dependencies = BTreeMap::<String, BTreeSet<String>>::new();
    for child in grants.iter().filter(|grant| grant.grantor != owner) {
        for parent in grants.iter().filter(|grant| {
            grant.grantee == child.grantor
                && grant.is_grantable
                && grant.grantor != child.grantor
                && postgres_grant_scope_covers(grant, child)
        }) {
            dependencies.entry(child.grantor.clone()).or_default().insert(parent.grantor.clone());
        }
    }

    let mut order = Vec::with_capacity(remaining.len());
    if remaining.remove(owner) {
        order.push(owner.to_string());
    }
    while !remaining.is_empty() {
        let ready = remaining
            .iter()
            .filter(|grantor| {
                dependencies.get(*grantor).is_none_or(|required| required.iter().all(|role| !remaining.contains(role)))
            })
            .cloned()
            .collect::<Vec<_>>();
        if ready.is_empty() {
            order.extend(remaining);
            break;
        }
        for grantor in ready {
            remaining.remove(&grantor);
            order.push(grantor);
        }
    }
    order
}

fn append_postgres_grants_for_role(ddl: &mut String, table_name: &str, grantor: &str, grants: &[PostgresGrant]) {
    let mut table_grants = BTreeMap::<(String, bool), BTreeSet<String>>::new();
    let mut column_grants = BTreeMap::<(String, bool), BTreeMap<String, BTreeSet<String>>>::new();
    for grant in grants.iter().filter(|grant| grant.grantor == grantor) {
        if let Some(column) = &grant.column_name {
            column_grants
                .entry((grant.grantee.clone(), grant.is_grantable))
                .or_default()
                .entry(grant.privilege_type.clone())
                .or_default()
                .insert(column.clone());
        } else {
            table_grants
                .entry((grant.grantee.clone(), grant.is_grantable))
                .or_default()
                .insert(grant.privilege_type.clone());
        }
    }

    for ((grantee, is_grantable), privileges) in table_grants {
        append_postgres_grant_statement(
            ddl,
            table_name,
            &grantee,
            is_grantable,
            privileges.into_iter().collect::<Vec<_>>().join(", "),
        );
    }
    for ((grantee, is_grantable), privileges) in column_grants {
        let privileges = privileges
            .into_iter()
            .map(|(privilege, columns)| {
                format!(
                    "{} ({})",
                    privilege,
                    columns.into_iter().map(|column| pg_ident(&column)).collect::<Vec<_>>().join(", ")
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        append_postgres_grant_statement(ddl, table_name, &grantee, is_grantable, privileges);
    }
}

fn append_postgres_grant_statement(
    ddl: &mut String,
    table_name: &str,
    grantee: &str,
    is_grantable: bool,
    privileges: String,
) {
    let grantee = if grantee == "PUBLIC" { grantee.to_string() } else { pg_ident(grantee) };
    let grant_option = if is_grantable { " WITH GRANT OPTION" } else { "" };
    ddl.push_str(&format!("\nGRANT {privileges} ON TABLE {table_name} TO {grantee}{grant_option};"));
}

pub async fn opengauss_table_ddl(pool: &deadpool_postgres::Pool, schema: &str, table: &str) -> Result<String, String> {
    let (ddl, trigger_definitions) = tokio::try_join!(
        async { first_string_cell(db::postgres::execute_query(pool, &opengauss_table_ddl_sql(schema, table)).await?) },
        db::postgres::list_trigger_definitions(pool, schema, table),
    )?;

    Ok(append_opengauss_trigger_definitions(ddl, &trigger_definitions))
}

pub fn opengauss_table_ddl_sql(schema: &str, table: &str) -> String {
    let qualified_name = format!("{}.{}", pg_ident(schema), pg_ident(table));
    format!("SELECT pg_get_tabledef({})", sql_string(&qualified_name))
}

fn append_postgres_trigger_definitions(mut ddl: String, trigger_definitions: &[String]) -> String {
    for definition in
        trigger_definitions.iter().map(|definition| definition.trim()).filter(|definition| !definition.is_empty())
    {
        ddl = ddl.trim_end().to_string();
        if !ddl.ends_with(';') {
            ddl.push(';');
        }
        ddl.push_str("\n\n");
        ddl.push_str(definition);
        if !definition.ends_with(';') {
            ddl.push(';');
        }
    }
    ddl
}

fn append_opengauss_trigger_definitions(mut ddl: String, trigger_definitions: &[String]) -> String {
    for definition in
        trigger_definitions.iter().map(|definition| definition.trim()).filter(|definition| !definition.is_empty())
    {
        ddl = ddl.trim_end().to_string();
        if !ddl.ends_with(';') {
            ddl.push(';');
        }
        ddl.push_str("\n\n");
        ddl.push_str(definition);
        if !definition.ends_with(';') {
            ddl.push(';');
        }
    }
    ddl
}

pub async fn cloudberry_ddl(pool: &deadpool_postgres::Pool, schema: &str, table: &str) -> Result<String, String> {
    match db::cloudberry::table_ddl(pool, schema, table).await {
        Ok(ddl) => Ok(ddl),
        Err(native_error) => {
            let base_ddl = pg_ddl(pool, schema, table).await.map_err(|fallback_error| {
                format!(
                    "Cloudberry pg_get_tabledef failed: {native_error}; PostgreSQL DDL fallback failed: {fallback_error}"
                )
            })?;
            let modifiers = db::cloudberry::table_modifiers(pool, schema, table).await.map_err(|fallback_error| {
                format!("Cloudberry pg_get_tabledef failed: {native_error}; modifier fallback failed: {fallback_error}")
            })?;
            db::cloudberry::append_table_modifiers(&base_ddl, &modifiers).map_err(|fallback_error| {
                format!(
                    "Cloudberry pg_get_tabledef failed: {native_error}; DDL rendering fallback failed: {fallback_error}"
                )
            })
        }
    }
}

pub fn render_postgres_table_ddl(
    schema: &str,
    table: &str,
    columns: &[db::ColumnInfo],
    indexes: &[db::IndexInfo],
    fkeys: &[db::ForeignKeyInfo],
    table_comment: Option<&str>,
) -> String {
    render_postgres_table_ddl_with_partition_info(
        schema,
        table,
        columns,
        indexes,
        fkeys,
        table_comment,
        &db::postgres::PostgresTablePartitionInfo::default(),
        &db::postgres::PostgresTablePartitionLocalObjects::default(),
    )
}

fn render_postgres_table_ddl_with_partition_info(
    schema: &str,
    table: &str,
    columns: &[db::ColumnInfo],
    indexes: &[db::IndexInfo],
    fkeys: &[db::ForeignKeyInfo],
    table_comment: Option<&str>,
    partition_info: &db::postgres::PostgresTablePartitionInfo,
    partition_local_objects: &db::postgres::PostgresTablePartitionLocalObjects,
) -> String {
    let table_name = format!("{}.{}", pg_ident(schema), pg_ident(table));
    let partition_parent = partition_info
        .is_partition
        .then(|| {
            Some((
                partition_info.parent_schema.as_deref()?,
                partition_info.parent_table.as_deref()?,
                partition_info.bound.as_deref()?,
            ))
        })
        .flatten();
    let is_partition = partition_parent.is_some();
    let mut definition_lines = if is_partition {
        Vec::new()
    } else {
        columns
            .iter()
            .map(|c| {
                let mut line = format!("  {} {}", pg_ident(&c.name), c.data_type);
                let generated_clause = c
                    .extra
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty() && value.to_ascii_lowercase().starts_with("generated "));
                if let Some(extra) = generated_clause {
                    line.push_str(&format!(" {extra}"));
                }
                if !c.is_nullable {
                    line.push_str(" NOT NULL");
                }
                if generated_clause.is_none() {
                    if let Some(ref def) = c.column_default {
                        line.push_str(&format!(" DEFAULT {def}"));
                    }
                }
                line
            })
            .collect::<Vec<_>>()
    };

    let pks: Vec<&str> = if !is_partition || partition_local_objects.has_primary_key {
        columns.iter().filter(|c| c.is_primary_key).map(|c| c.name.as_str()).collect()
    } else {
        Vec::new()
    };
    if !pks.is_empty() {
        definition_lines
            .push(format!("  PRIMARY KEY ({})", pks.iter().map(|key| pg_ident(key)).collect::<Vec<_>>().join(", ")));
    }
    for fk_group in group_foreign_keys_by_name(fkeys) {
        let Some(first_fk) = fk_group.first() else {
            continue;
        };
        if is_partition && !partition_local_objects.foreign_keys.contains(&first_fk.name) {
            continue;
        }
        let columns = fk_group.iter().map(|fk| pg_ident(&fk.column)).collect::<Vec<_>>().join(", ");
        let ref_columns = fk_group.iter().map(|fk| pg_ident(&fk.ref_column)).collect::<Vec<_>>().join(", ");
        definition_lines.push(format!(
            "  CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {}({})",
            pg_ident(&first_fk.name),
            columns,
            pg_ident(&first_fk.ref_table),
            ref_columns
        ));
    }

    let mut ddl = if let Some((parent_schema, parent_table, bound)) = partition_parent {
        let parent_name = format!("{}.{}", pg_ident(parent_schema), pg_ident(parent_table));
        let definitions = if definition_lines.is_empty() {
            String::new()
        } else {
            format!(" (\n{}\n)", definition_lines.join(",\n"))
        };
        format!("CREATE TABLE {table_name} PARTITION OF {parent_name}{definitions} {bound}")
    } else {
        format!("CREATE TABLE {table_name} (\n{}\n)", definition_lines.join(",\n"))
    };
    if let Some(partition_key) = partition_info.key.as_deref().filter(|key| !key.trim().is_empty()) {
        ddl.push_str(&format!(" PARTITION BY {partition_key}"));
    }
    ddl.push_str(";\n");

    if let Some(comment) = table_comment.filter(|comment| !comment.trim().is_empty()) {
        ddl.push_str(&format!("\nCOMMENT ON TABLE {table_name} IS {};", sql_string(comment)));
    }

    for col in columns {
        if let Some(comment) = col.comment.as_deref().filter(|comment| !comment.is_empty()) {
            ddl.push_str(&format!(
                "\nCOMMENT ON COLUMN {table_name}.{} IS {};",
                pg_ident(&col.name),
                sql_string(comment)
            ));
        }
    }

    for idx in indexes {
        if idx.is_primary {
            continue;
        }
        if is_partition && !partition_local_objects.indexes.contains(&idx.name) {
            continue;
        }
        let unique = if idx.is_unique { "UNIQUE " } else { "" };
        let cols = idx.columns.iter().map(|c| pg_ident(c)).collect::<Vec<_>>().join(", ");
        let using = idx.index_type.as_deref().map(|t| format!(" USING {t}")).unwrap_or_default();
        let include = idx
            .included_columns
            .as_deref()
            .filter(|c| !c.is_empty())
            .map(|cols| format!(" INCLUDE ({})", cols.iter().map(|c| pg_ident(c)).collect::<Vec<_>>().join(", ")))
            .unwrap_or_default();
        let filter = idx.filter.as_deref().map(|f| format!(" WHERE {f}")).unwrap_or_default();
        ddl.push_str(&format!(
            "\nCREATE {unique}INDEX {} ON {table_name}{using} ({cols}){include}{filter};",
            pg_ident(&idx.name)
        ));
        if let Some(ref c) = idx.comment {
            ddl.push_str(&format!(
                "\nCOMMENT ON INDEX {}.{} IS {};",
                pg_ident(schema),
                pg_ident(&idx.name),
                sql_string(c)
            ));
        }
    }
    ddl
}

fn sqlserver_identity_clause(extra: Option<&str>) -> Option<String> {
    let extra = extra?.trim();
    let lower = extra.to_ascii_lowercase();
    if !lower.starts_with("identity") {
        return None;
    }

    let rest = extra["identity".len()..].trim_start();
    if rest.is_empty() {
        return Some("IDENTITY".to_string());
    }

    let args = rest.strip_prefix('(')?;
    let end = args.find(')')?;
    Some(format!("IDENTITY({})", args[..end].trim()))
}

fn group_foreign_keys_by_name(fkeys: &[db::ForeignKeyInfo]) -> Vec<Vec<&db::ForeignKeyInfo>> {
    let mut groups: Vec<Vec<&db::ForeignKeyInfo>> = Vec::new();
    for fk in fkeys {
        if let Some(group) = groups.iter_mut().find(|group| group.first().is_some_and(|first| first.name == fk.name)) {
            group.push(fk);
        } else {
            groups.push(vec![fk]);
        }
    }
    groups
}

pub async fn build_sqlserver_ddl(
    client: &mut db::sqlserver::SqlServerClient,
    schema: &str,
    table: &str,
) -> Result<String, String> {
    let columns = db::sqlserver::get_columns(client, schema, table).await?;
    let indexes = db::sqlserver::list_indexes(client, schema, table).await?;
    let fkeys = db::sqlserver::list_foreign_keys(client, schema, table).await?;
    let table_comment = db::sqlserver::get_table_comment(client, schema, table).await?;

    Ok(render_sqlserver_table_ddl(schema, table, &columns, &indexes, &fkeys, table_comment.as_deref()))
}

pub fn render_sqlserver_table_ddl(
    schema: &str,
    table: &str,
    columns: &[db::ColumnInfo],
    indexes: &[db::IndexInfo],
    fkeys: &[db::ForeignKeyInfo],
    table_comment: Option<&str>,
) -> String {
    let table_name = format!("{}.{}", sqlserver_ident(schema), sqlserver_ident(table));
    let mut ddl = format!("CREATE TABLE {table_name} (\n");
    let col_lines: Vec<String> = columns
        .iter()
        .map(|c| {
            let mut line = format!("  {} {}", sqlserver_ident(&c.name), c.data_type);
            if let Some(identity) = sqlserver_identity_clause(c.extra.as_deref()) {
                line.push_str(&format!(" {identity}"));
            }
            if !c.is_nullable {
                line.push_str(" NOT NULL");
            }
            if let Some(ref def) = c.column_default {
                line.push_str(&format!(" DEFAULT {def}"));
            }
            line
        })
        .collect();
    ddl.push_str(&col_lines.join(",\n"));

    let pks: Vec<&str> = columns.iter().filter(|c| c.is_primary_key).map(|c| c.name.as_str()).collect();
    if !pks.is_empty() {
        ddl.push_str(&format!(
            ",\n  PRIMARY KEY ({})",
            pks.iter().map(|k| sqlserver_ident(k)).collect::<Vec<_>>().join(", ")
        ));
    }
    for fk in fkeys {
        ddl.push_str(&format!(
            ",\n  CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {}({})",
            sqlserver_ident(&fk.name),
            sqlserver_ident(&fk.column),
            sqlserver_ident(&fk.ref_table),
            sqlserver_ident(&fk.ref_column)
        ));
    }
    ddl.push_str("\n);\n");

    if let Some(comment) = table_comment.filter(|comment| !comment.trim().is_empty()) {
        ddl.push_str(&format!(
            "\nEXEC sys.sp_addextendedproperty @name=N'MS_Description', @value={}, @level0type=N'SCHEMA', @level0name={}, @level1type=N'TABLE', @level1name={};",
            sqlserver_n_string(comment),
            sqlserver_n_string(schema),
            sqlserver_n_string(table)
        ));
    }

    for column in columns {
        if let Some(comment) = column.comment.as_deref().map(str::trim).filter(|comment| !comment.is_empty()) {
            ddl.push_str(&format!(
                "\nEXEC sys.sp_addextendedproperty @name=N'MS_Description', @value={}, @level0type=N'SCHEMA', @level0name={}, @level1type=N'TABLE', @level1name={}, @level2type=N'COLUMN', @level2name={};",
                sqlserver_n_string(comment),
                sqlserver_n_string(schema),
                sqlserver_n_string(table),
                sqlserver_n_string(&column.name)
            ));
        }
    }

    for idx in indexes {
        if idx.is_primary {
            continue;
        }
        let unique = if idx.is_unique { "UNIQUE " } else { "" };
        let idx_type = idx.index_type.as_deref().map(|t| format!("{t} ")).unwrap_or_default();
        let cols = idx.columns.iter().map(|c| sqlserver_ident(c)).collect::<Vec<_>>().join(", ");
        let include = idx
            .included_columns
            .as_deref()
            .filter(|c| !c.is_empty())
            .map(|cols| {
                format!(" INCLUDE ({})", cols.iter().map(|c| sqlserver_ident(c)).collect::<Vec<_>>().join(", "))
            })
            .unwrap_or_default();
        let filter = idx.filter.as_deref().map(|f| format!(" WHERE {f}")).unwrap_or_default();
        ddl.push_str(&format!(
            "\nCREATE {unique}{idx_type}INDEX {} ON {table_name} ({cols}){include}{filter};",
            sqlserver_ident(&idx.name)
        ));
    }
    ddl
}
