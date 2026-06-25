use crate::connection::{connection_url_for_endpoint, database_connection_config, AppState, MysqlMode, PoolKind};
use crate::db;
use crate::models::connection::{ConnectionConfig, DatabaseType};
use crate::query::{agent_execute_query_params, should_discard_pool_after_error, QueryExecutionOptions};
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

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

macro_rules! try_sqlserver {
    ($connections:expr, $pool_key:expr, $method:ident $(, $arg:expr)*) => {
        if let Some(client) = extract_pool!(&$connections, $pool_key, SqlServer) {
            drop($connections);
            let mut client = client.lock().await;
            return db::sqlserver::$method(&mut client $(, $arg)*).await;
        }
    };
}

#[cfg(feature = "duckdb-bundled")]
pub fn duckdb_query_tables(con: &duckdb::Connection) -> Result<Vec<db::TableInfo>, String> {
    duckdb_query_tables_in_database(con, "main", "main")
}

#[cfg(feature = "duckdb-bundled")]
pub fn duckdb_query_tables_in_database(
    con: &duckdb::Connection,
    database: &str,
    schema: &str,
) -> Result<Vec<db::TableInfo>, String> {
    duckdb_query_tables_in_database_with_attached(con, database, schema, &[])
}

#[cfg(feature = "duckdb-bundled")]
pub fn duckdb_query_tables_in_database_with_attached(
    con: &duckdb::Connection,
    database: &str,
    schema: &str,
    attached_names: &[String],
) -> Result<Vec<db::TableInfo>, String> {
    let database = duckdb_catalog_name(con, database, attached_names)?;
    let mut stmt = con.prepare(
        "SELECT table_name, table_type FROM information_schema.tables WHERE table_catalog = ? AND table_schema = ? ORDER BY table_name"
    ).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map((database.as_str(), schema), |row| {
            Ok(db::TableInfo {
                name: row.get::<_, String>(0)?,
                table_type: row.get::<_, String>(1)?,
                comment: None,
                parent_schema: None,
                parent_name: None,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[cfg(feature = "duckdb-bundled")]
pub fn duckdb_attach_database(con: &duckdb::Connection, name: &str, path: &str) -> Result<(), String> {
    let name = name.trim();
    let path = path.trim();
    if name.is_empty() || path.is_empty() {
        return Err("DuckDB attached database name and path are required".to_string());
    }
    let sql = format!("ATTACH {} AS {}", duckdb_quote_string(path), duckdb_quote_ident(name));
    con.execute_batch(&sql).map_err(|e| e.to_string())
}

#[cfg(feature = "duckdb-bundled")]
pub fn duckdb_list_databases(con: &duckdb::Connection) -> Result<Vec<db::DatabaseInfo>, String> {
    duckdb_list_databases_with_attached(con, &[])
}

#[cfg(feature = "duckdb-bundled")]
pub fn duckdb_list_databases_with_attached(
    con: &duckdb::Connection,
    attached_names: &[String],
) -> Result<Vec<db::DatabaseInfo>, String> {
    let primary = duckdb_primary_catalog(con, attached_names)?;
    let mut stmt = con.prepare("SHOW DATABASES").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let name = row.get::<_, String>(0)?;
            Ok(db::DatabaseInfo { name: if name == primary { "main".to_string() } else { name } })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|row| row.ok()).collect())
}

#[cfg(feature = "duckdb-bundled")]
pub fn duckdb_list_schemas(con: &duckdb::Connection, database: &str) -> Result<Vec<String>, String> {
    duckdb_list_schemas_with_attached(con, database, &[])
}

#[cfg(feature = "duckdb-bundled")]
pub fn duckdb_list_schemas_with_attached(
    con: &duckdb::Connection,
    database: &str,
    attached_names: &[String],
) -> Result<Vec<String>, String> {
    let database = duckdb_catalog_name(con, database, attached_names)?;
    let mut stmt = con
        .prepare(
            "SELECT schema_name FROM information_schema.schemata WHERE catalog_name = ? AND schema_name NOT IN ('information_schema', 'pg_catalog') ORDER BY schema_name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([database.as_str()], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[cfg(feature = "duckdb-bundled")]
fn duckdb_catalog_name(con: &duckdb::Connection, database: &str, attached_names: &[String]) -> Result<String, String> {
    if database.trim().is_empty() || database == "main" {
        return duckdb_primary_catalog(con, attached_names);
    }
    Ok(database.to_string())
}

#[cfg(feature = "duckdb-bundled")]
pub fn duckdb_primary_catalog(con: &duckdb::Connection, attached_names: &[String]) -> Result<String, String> {
    if attached_names.is_empty() {
        return duckdb_current_database(con);
    }
    let attached: std::collections::HashSet<String> = attached_names.iter().map(|name| name.to_lowercase()).collect();
    let mut stmt = con.prepare("SHOW DATABASES").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
    for row in rows {
        let name = row.map_err(|e| e.to_string())?;
        if !attached.contains(&name.to_lowercase()) {
            return Ok(name);
        }
    }
    duckdb_current_database(con)
}

#[cfg(feature = "duckdb-bundled")]
fn duckdb_current_database(con: &duckdb::Connection) -> Result<String, String> {
    con.query_row("SELECT current_database()", [], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())
}

#[cfg(feature = "duckdb-bundled")]
fn duckdb_quote_ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

#[cfg(feature = "duckdb-bundled")]
fn duckdb_quote_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(feature = "duckdb-bundled")]
pub fn duckdb_query_columns(con: &duckdb::Connection, table: &str) -> Result<Vec<db::ColumnInfo>, String> {
    duckdb_query_columns_in_database(con, "main", "main", table)
}

#[cfg(feature = "duckdb-bundled")]
pub fn duckdb_query_columns_in_database(
    con: &duckdb::Connection,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<db::ColumnInfo>, String> {
    duckdb_query_columns_in_database_with_attached(con, database, schema, table, &[])
}

#[cfg(feature = "duckdb-bundled")]
pub fn duckdb_query_columns_in_database_with_attached(
    con: &duckdb::Connection,
    database: &str,
    schema: &str,
    table: &str,
    attached_names: &[String],
) -> Result<Vec<db::ColumnInfo>, String> {
    let database = duckdb_catalog_name(con, database, attached_names)?;
    let mut pk_stmt = con
        .prepare(
            "SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
          AND tc.table_name = kcu.table_name
         WHERE tc.constraint_type = 'PRIMARY KEY'
           AND tc.table_catalog = ?
           AND tc.table_schema = ?
           AND tc.table_name = ?
         ORDER BY kcu.ordinal_position",
        )
        .map_err(|e| e.to_string())?;
    let pk_rows = pk_stmt
        .query_map((database.as_str(), schema, table), |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let primary_keys: std::collections::HashSet<String> = pk_rows.filter_map(|r| r.ok()).collect();

    let mut stmt = con
        .prepare(
            "SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_catalog = ? AND table_schema = ? AND table_name = ?
         ORDER BY ordinal_position",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map((database.as_str(), schema, table), |row| {
            let name = row.get::<_, String>(0)?;
            Ok(db::ColumnInfo {
                is_primary_key: primary_keys.contains(&name),
                name,
                data_type: row.get::<_, String>(1)?,
                is_nullable: row.get::<_, String>(2).unwrap_or_default() == "YES",
                column_default: row.get::<_, Option<String>>(3)?,
                extra: None,
                comment: None,
                numeric_precision: None,
                numeric_scale: None,
                character_maximum_length: None,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[cfg(feature = "duckdb-bundled")]
pub fn duckdb_completion_assistant_search(
    con: &duckdb::Connection,
    request: &db::CompletionAssistantRequest,
    attached_names: &[String],
) -> Result<db::CompletionAssistantResponse, String> {
    let limit = request.max_results.unwrap_or(100).clamp(1, 1000);
    let kinds = if request.object_kinds.is_empty() {
        vec![db::CompletionAssistantObjectKind::Table, db::CompletionAssistantObjectKind::View]
    } else {
        request.object_kinds.clone()
    };
    let mut candidates = Vec::new();

    if kinds.iter().any(|kind| matches!(kind, db::CompletionAssistantObjectKind::Schema)) {
        candidates.extend(duckdb_completion_schemas(con, request, attached_names, limit)?);
        if candidates.len() >= limit {
            return Ok(db::CompletionAssistantResponse { candidates, incomplete: true, fallback_used: false });
        }
    }

    if kinds.iter().any(db::CompletionAssistantObjectKind::is_table_like) {
        candidates.extend(duckdb_completion_tables(con, request, &kinds, attached_names, limit - candidates.len())?);
        if candidates.len() >= limit {
            return Ok(db::CompletionAssistantResponse { candidates, incomplete: true, fallback_used: false });
        }
    }

    if kinds.iter().any(|kind| matches!(kind, db::CompletionAssistantObjectKind::Column)) {
        candidates.extend(duckdb_completion_columns(con, request, attached_names, limit - candidates.len())?);
        if candidates.len() >= limit {
            return Ok(db::CompletionAssistantResponse { candidates, incomplete: true, fallback_used: false });
        }
    }

    Ok(db::CompletionAssistantResponse { candidates, incomplete: false, fallback_used: false })
}

#[cfg(feature = "duckdb-bundled")]
fn duckdb_completion_schemas(
    con: &duckdb::Connection,
    request: &db::CompletionAssistantRequest,
    attached_names: &[String],
    limit: usize,
) -> Result<Vec<db::CompletionAssistantCandidate>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let database = duckdb_catalog_name(con, &request.database, attached_names)?;
    let pattern = duckdb_completion_like_pattern(request);
    let mut stmt = con
        .prepare(
            "SELECT schema_name
             FROM information_schema.schemata
             WHERE catalog_name = ?
               AND schema_name NOT IN ('information_schema', 'pg_catalog')
               AND lower(schema_name) LIKE lower(?) ESCAPE '\\'
             ORDER BY schema_name
             LIMIT ?",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map((database.as_str(), pattern.as_str(), limit as i64), |row| {
            let schema = row.get::<_, String>(0)?;
            Ok(db::CompletionAssistantCandidate {
                name: schema.clone(),
                kind: db::CompletionAssistantCandidateKind::Schema,
                database: Some(request.database.clone()),
                schema: Some(schema),
                parent_schema: None,
                parent_name: None,
                comment: None,
                data_type: None,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|row| row.ok()).collect())
}

#[cfg(feature = "duckdb-bundled")]
fn duckdb_completion_tables(
    con: &duckdb::Connection,
    request: &db::CompletionAssistantRequest,
    kinds: &[db::CompletionAssistantObjectKind],
    attached_names: &[String],
    limit: usize,
) -> Result<Vec<db::CompletionAssistantCandidate>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let database = duckdb_catalog_name(con, &request.database, attached_names)?;
    let schema = request.parent_schema.as_deref().or(request.schema.as_deref()).unwrap_or("main");
    let include_tables = kinds.iter().any(|kind| matches!(kind, db::CompletionAssistantObjectKind::Table));
    let include_views = kinds.iter().any(|kind| matches!(kind, db::CompletionAssistantObjectKind::View));
    let pattern = duckdb_completion_like_pattern(request);
    let mut stmt = con
        .prepare(
            "SELECT table_name, table_type
             FROM information_schema.tables
             WHERE table_catalog = ?
               AND table_schema = ?
               AND ((? AND table_type = 'BASE TABLE') OR (? AND table_type = 'VIEW'))
               AND lower(table_name) LIKE lower(?) ESCAPE '\\'
             ORDER BY table_name
             LIMIT ?",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map((database.as_str(), schema, include_tables, include_views, pattern.as_str(), limit as i64), |row| {
            let table_type = row.get::<_, String>(1)?;
            Ok(db::CompletionAssistantCandidate {
                name: row.get(0)?,
                kind: if table_type.eq_ignore_ascii_case("VIEW") {
                    db::CompletionAssistantCandidateKind::View
                } else {
                    db::CompletionAssistantCandidateKind::Table
                },
                database: Some(request.database.clone()),
                schema: Some(schema.to_string()),
                parent_schema: None,
                parent_name: None,
                comment: None,
                data_type: None,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|row| row.ok()).collect())
}

#[cfg(feature = "duckdb-bundled")]
fn duckdb_completion_columns(
    con: &duckdb::Connection,
    request: &db::CompletionAssistantRequest,
    attached_names: &[String],
    limit: usize,
) -> Result<Vec<db::CompletionAssistantCandidate>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let Some(table) = request.parent_name.as_deref().filter(|table| !table.trim().is_empty()) else {
        return Ok(Vec::new());
    };
    let database = duckdb_catalog_name(con, &request.database, attached_names)?;
    let schema = request.parent_schema.as_deref().or(request.schema.as_deref()).unwrap_or("main");
    let pattern = duckdb_completion_like_pattern(request);
    let mut stmt = con
        .prepare(
            "SELECT column_name, data_type
             FROM information_schema.columns
             WHERE table_catalog = ?
               AND table_schema = ?
               AND table_name = ?
               AND lower(column_name) LIKE lower(?) ESCAPE '\\'
             ORDER BY ordinal_position
             LIMIT ?",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map((database.as_str(), schema, table, pattern.as_str(), limit as i64), |row| {
            Ok(db::CompletionAssistantCandidate {
                name: row.get(0)?,
                kind: db::CompletionAssistantCandidateKind::Column,
                database: Some(request.database.clone()),
                schema: Some(schema.to_string()),
                parent_schema: Some(schema.to_string()),
                parent_name: Some(table.to_string()),
                comment: None,
                data_type: Some(row.get(1)?),
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|row| row.ok()).collect())
}

#[cfg(feature = "duckdb-bundled")]
fn duckdb_completion_like_pattern(request: &db::CompletionAssistantRequest) -> String {
    let mask = request.mask.trim().trim_matches('%');
    let escaped = mask.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    match request.match_mode.as_ref().unwrap_or(&db::CompletionAssistantMatchMode::Prefix) {
        db::CompletionAssistantMatchMode::Prefix => format!("{escaped}%"),
        db::CompletionAssistantMatchMode::Contains => format!("%{escaped}%"),
    }
}

#[cfg(feature = "duckdb-bundled")]
async fn duckdb_attached_database_names(state: &AppState, connection_id: &str) -> Vec<String> {
    state
        .configs
        .read()
        .await
        .get(connection_id)
        .map(|config| config.attached_databases.iter().map(|database| database.name.clone()).collect())
        .unwrap_or_default()
}

fn clickhouse_metadata_database<'a>(database: &'a str, schema: &'a str) -> &'a str {
    if database.is_empty() {
        schema
    } else {
        database
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

async fn list_databases_once(state: &AppState, connection_id: &str) -> Result<Vec<db::DatabaseInfo>, String> {
    log::info!("[list_databases] connection_id={connection_id}");
    let db_config = connection_config(state, connection_id).await;
    {
        let connections = state.connections.read().await;
        #[cfg(feature = "duckdb-bundled")]
        if extract_pool!(&connections, connection_id, ExternalTabular).is_some() {
            return Ok(vec![db::DatabaseInfo { name: "main".to_string() }]);
        }
        if let Some(PoolKind::ExternalDriver { config, session, .. }) = connections.get(connection_id) {
            let config = config.clone();
            let session = session.clone();
            drop(connections);
            return session
                .invoke::<Vec<db::DatabaseInfo>>("listDatabases", serde_json::json!({ "connection": config.as_ref() }))
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
        try_sqlserver!(connections, connection_id, list_databases);
        if let Some(client) = extract_pool!(&connections, connection_id, Agent) {
            let is_mongo =
                state.configs.read().await.get(connection_id).is_some_and(|c| c.db_type == DatabaseType::MongoDb);
            if is_mongo {
                drop(connections);
                let dbs = crate::mongo_ops::mongo_list_databases_core(state, connection_id).await?;
                return Ok(dbs.into_iter().map(|name| db::DatabaseInfo { name }).collect());
            }
            drop(connections);
            let mut client = client.lock().await;
            return client.list_databases(agent_metadata_timeout(db_config.as_ref())).await;
        }
    }

    #[cfg(feature = "duckdb-bundled")]
    let duckdb_attached_names = duckdb_attached_database_names(state, connection_id).await;
    let db_config = connection_config(state, connection_id).await;
    let connections = state.connections.read().await;
    let pool = connections.get(connection_id).ok_or("Connection not found")?;

    match pool {
        PoolKind::Mysql(p, _) if db_config.as_ref().is_some_and(is_doris_family_config) => {
            db::mysql::list_databases_show(p)
                .await
                .map(|databases| filter_mysql_system_databases_for_config(databases, db_config.as_ref()))
        }
        PoolKind::Mysql(p, mode) => dispatch_mysql!(p, mode, db::mysql::list_databases, db::ob_oracle::list_databases),
        PoolKind::Postgres(p) => db::postgres::list_databases(p).await,
        PoolKind::Sqlite(p) => db::sqlite::list_databases(p).await,
        PoolKind::Rqlite(client) => db::rqlite_driver::list_databases(client).await,
        #[cfg(feature = "duckdb-bundled")]
        PoolKind::DuckDb(con) => {
            let con = con.lock().map_err(|e| e.to_string())?;
            duckdb_list_databases_with_attached(&con, &duckdb_attached_names)
        }
        _ => Ok(vec![]),
    }
}

pub async fn list_schemas_core(state: &AppState, connection_id: &str, database: &str) -> Result<Vec<String>, String> {
    retry_metadata_connection(state, connection_id, Some(database), || {
        list_schemas_once(state, connection_id, database)
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
    let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
    {
        let connections = state.connections.read().await;
        if let Some(PoolKind::Postgres(pool)) = connections.get(&pool_key) {
            return db::postgres::list_schema_infos(pool).await;
        }
    }

    let schemas = list_schemas_once(state, connection_id, database).await?;
    Ok(schemas.into_iter().map(|name| db::SchemaInfo { name, comment: None }).collect())
}

async fn list_schemas_once(state: &AppState, connection_id: &str, database: &str) -> Result<Vec<String>, String> {
    let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
    let db_config = connection_config(state, connection_id).await;

    {
        let connections = state.connections.read().await;
        if let Some(PoolKind::ExternalDriver { config, session, .. }) = connections.get(&pool_key) {
            let config = config.clone();
            let session = session.clone();
            drop(connections);
            return session
                .invoke::<Vec<String>>(
                    "listSchemas",
                    serde_json::json!({ "connection": config.as_ref(), "database": database }),
                )
                .await;
        }
        try_sqlserver!(connections, &pool_key, list_schemas);
        if let Some(client) = extract_pool!(&connections, &pool_key, Agent) {
            let fallback_config = db_config.clone();
            drop(connections);
            let mut client = client.lock().await;
            match client.list_schemas::<Vec<String>>(database, agent_metadata_timeout(db_config.as_ref())).await {
                Ok(schemas) if !schemas.is_empty() => return Ok(schemas),
                Ok(schemas) => {
                    if let Some(config) = fallback_config.as_ref() {
                        match native_postgres_metadata_pool(state, connection_id, database, config).await {
                            Ok(Some(pool)) => return db::postgres::list_schemas(&pool).await,
                            Ok(None) => return Ok(schemas),
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
                    return Ok(schemas);
                }
                Err(agent_error) => {
                    if let Some(config) = fallback_config.as_ref() {
                        if let Some(pool) =
                            native_postgres_metadata_pool(state, connection_id, database, config).await?
                        {
                            return db::postgres::list_schemas(&pool).await.map_err(|fallback_error| {
                                format!("{agent_error}\n\nNative PostgreSQL metadata fallback failed: {fallback_error}")
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
        PoolKind::Postgres(p) => db::postgres::list_schemas(p).await,
        #[cfg(feature = "duckdb-bundled")]
        PoolKind::DuckDb(con) => {
            let duckdb_attached_names = duckdb_attached_database_names(state, connection_id).await;
            let con = con.lock().map_err(|e| e.to_string())?;
            duckdb_list_schemas_with_attached(&con, database, &duckdb_attached_names)
        }
        _ => Ok(vec![]),
    }
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
) -> Result<Vec<db::TableInfo>, String> {
    retry_metadata_connection(state, connection_id, Some(database), || {
        list_tables_once(state, connection_id, database, schema, filter, limit, offset, object_types)
    })
    .await
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

    retry_metadata_connection(state, connection_id, Some(database), || async {
        let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
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
                                QueryExecutionOptions {
                                    max_rows: Some(1),
                                    fetch_size: None,
                                    page_size: None,
                                    result_session_id: None,
                                    client_session_id: None,
                                    timeout_secs: None,
                                    execution_id: None,
                                },
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
                db::mysql::get_table_comment(p, schema, table).await
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

fn oracle_table_comment_from_query_result(result: db::QueryResult) -> Result<Option<String>, String> {
    Ok(result
        .rows
        .first()
        .and_then(|row| row.iter().find_map(|value| value.as_str().map(str::to_string)))
        .filter(|value| !value.trim().is_empty()))
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
) -> Result<Vec<db::TableInfo>, String> {
    let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
    #[cfg(feature = "duckdb-bundled")]
    let duckdb_attached_names = duckdb_attached_database_names(state, connection_id).await;
    let db_config = connection_config(state, connection_id).await;

    {
        let connections = state.connections.read().await;
        #[cfg(feature = "duckdb-bundled")]
        if let Some(ext_pool) = extract_pool!(&connections, &pool_key, ExternalTabular) {
            drop(connections);
            let cache = ext_pool.cache.clone();
            return tokio::task::spawn_blocking(move || {
                let con = cache.lock().map_err(|e| e.to_string())?;
                duckdb_query_tables(&con)
            })
            .await
            .map_err(|e| e.to_string())?
            .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types));
        }
        if let Some(PoolKind::ExternalDriver { config, session, .. }) = connections.get(&pool_key) {
            let config = config.clone();
            let session = session.clone();
            drop(connections);
            if uses_presto_like_information_schema_tables(&config.db_type) {
                return external_driver_presto_like_tables(session, config.as_ref(), database, schema)
                    .await
                    .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types));
            }
            return session
                .invoke::<Vec<db::TableInfo>>(
                    "listTables",
                    serde_json::json!({ "connection": config.as_ref(), "database": database, "schema": schema }),
                )
                .await
                .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types));
        }
        #[cfg(feature = "duckdb-bundled")]
        if let Some(con) = extract_pool!(&connections, &pool_key, DuckDb) {
            drop(connections);
            let con = con.lock().map_err(|e| e.to_string())?;
            return duckdb_query_tables_in_database_with_attached(&con, database, schema, &duckdb_attached_names)
                .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types));
        }
        if let Some(client) = extract_pool!(&connections, &pool_key, ClickHouse) {
            drop(connections);
            return db::clickhouse_driver::list_tables(&client, clickhouse_metadata_database(database, schema))
                .await
                .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types));
        }
        if let Some(client) = extract_pool!(&connections, &pool_key, InfluxDb) {
            drop(connections);
            return db::influxdb_driver::list_tables(&client, database)
                .await
                .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types));
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
                .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types));
            }
        }
        if object_types.is_some() {
            if let Some(client) = extract_pool!(&connections, &pool_key, SqlServer) {
                drop(connections);
                let mut client = client.lock().await;
                return db::sqlserver::list_tables(&mut client, schema, filter, None, None)
                    .await
                    .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types));
            }
        }
        try_sqlserver!(connections, &pool_key, list_tables, schema, filter, limit, offset);
        if let Some(client) = extract_pool!(&connections, &pool_key, Agent) {
            let fallback_config = db_config.clone();
            drop(connections);
            let mut client = client.lock().await;
            match client
                .list_tables::<Vec<db::TableInfo>>(database, schema, agent_metadata_timeout(db_config.as_ref()))
                .await
            {
                Ok(tables) if !tables.is_empty() => {
                    return Ok(filter_table_infos(tables, filter, limit, offset, object_types))
                }
                Ok(tables) => {
                    if let Some(config) = fallback_config.as_ref() {
                        match native_postgres_metadata_pool(state, connection_id, database, config).await {
                            Ok(Some(pool)) => {
                                return if object_types.is_some() {
                                    db::postgres::list_tables_filtered(&pool, schema, filter, None, None)
                                        .await
                                        .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types))
                                } else {
                                    db::postgres::list_tables_filtered(&pool, schema, filter, limit, offset).await
                                };
                            }
                            Ok(None) => return Ok(filter_table_infos(tables, filter, limit, offset, object_types)),
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
                    return Ok(filter_table_infos(tables, filter, limit, offset, object_types));
                }
                Err(agent_error) => {
                    if let Some(config) = fallback_config.as_ref() {
                        if let Some(pool) =
                            native_postgres_metadata_pool(state, connection_id, database, config).await?
                        {
                            let result = if object_types.is_some() {
                                db::postgres::list_tables_filtered(&pool, schema, filter, None, None)
                                    .await
                                    .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types))
                            } else {
                                db::postgres::list_tables_filtered(&pool, schema, filter, limit, offset).await
                            };
                            return result.map_err(|fallback_error| {
                                format!("{agent_error}\n\nNative PostgreSQL metadata fallback failed: {fallback_error}")
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
        PoolKind::Mysql(p, _) if db_config.as_ref().is_some_and(is_doris_family_config) => {
            db::mysql::list_tables_show(p, database)
                .await
                .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types))
        }
        PoolKind::Mysql(p, mode) => {
            dispatch_mysql!(p, mode, db::mysql::list_tables, db::ob_oracle::list_tables, schema)
                .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types))
        }
        PoolKind::Postgres(p) if db_config.as_ref().is_some_and(is_questdb_config) => {
            db::questdb::list_tables(p, schema)
                .await
                .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types))
        }
        PoolKind::Postgres(p) => {
            if object_types.is_some() {
                db::postgres::list_tables_filtered(p, schema, filter, None, None)
                    .await
                    .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types))
            } else {
                db::postgres::list_tables_filtered(p, schema, filter, limit, offset).await
            }
        }
        PoolKind::Sqlite(p) => db::sqlite::list_tables(p, schema)
            .await
            .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types)),
        PoolKind::Rqlite(client) => db::rqlite_driver::list_tables(client, schema)
            .await
            .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types)),
        PoolKind::MongoDb(client) => db::mongo_driver::list_collections(client, database)
            .await
            .map(|names| collection_names_to_tables(names, "COLLECTION"))
            .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types)),
        PoolKind::Elasticsearch(client) => db::elasticsearch_driver::list_indices(client)
            .await
            .map(|names| collection_names_to_tables(names, "INDEX"))
            .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types)),
        PoolKind::VectorDb(client) => db::vector_driver::list_collections(client)
            .await
            .map(|names| collection_names_to_tables(names, "COLLECTION"))
            .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types)),
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

fn filter_table_infos(
    tables: Vec<db::TableInfo>,
    filter: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
    object_types: Option<&[String]>,
) -> Vec<db::TableInfo> {
    let filter = filter.unwrap_or("").to_lowercase();
    let limit = limit.unwrap_or(usize::MAX);
    let offset = offset.unwrap_or(0);
    tables
        .into_iter()
        .filter(|table| filter.is_empty() || table.name.to_lowercase().contains(&filter))
        .filter(|table| table_info_matches_object_types(table, object_types))
        .skip(offset)
        .take(limit)
        .collect()
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

async fn external_driver_presto_like_tables(
    session: Arc<crate::plugins::PluginDriverSession>,
    config: &ConnectionConfig,
    database: &str,
    schema: &str,
) -> Result<Vec<db::TableInfo>, String> {
    let result: db::QueryResult = session
        .invoke(
            "executeQuery",
            serde_json::json!({
                "connection": config,
                "database": database,
                "schema": schema,
                "sql": presto_like_information_schema_tables_sql(database, schema),
                "maxRows": 100000,
                "fetchSize": 1000,
                "timeoutSecs": 60
            }),
        )
        .await?;
    Ok(presto_like_tables_from_query_result(&result))
}

async fn external_driver_presto_like_objects(
    session: Arc<crate::plugins::PluginDriverSession>,
    config: &ConnectionConfig,
    database: &str,
    schema: &str,
) -> Result<Vec<db::ObjectInfo>, String> {
    let tables = external_driver_presto_like_tables(session, config, database, schema).await?;
    Ok(tables
        .into_iter()
        .map(|table| db::ObjectInfo {
            name: table.name,
            object_type: table.table_type,
            schema: Some(schema.to_string()),
            comment: table.comment,
            created_at: None,
            updated_at: None,
            parent_schema: table.parent_schema,
            parent_name: table.parent_name,
        })
        .collect())
}

fn presto_like_information_schema_tables_sql(database: &str, schema: &str) -> String {
    let source = if database.trim().is_empty() {
        "information_schema.tables".to_string()
    } else {
        format!("{}.information_schema.tables", quote_presto_like_identifier(database))
    };
    format!(
        "SELECT table_name, CASE table_type WHEN 'BASE TABLE' THEN 'TABLE' ELSE table_type END AS table_type \
         FROM {source} \
         WHERE table_schema = {} AND table_type IN ('BASE TABLE', 'VIEW') \
         ORDER BY table_type, table_name",
        sql_string_literal(schema)
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

fn query_result_cell_string(row: &[serde_json::Value], index: usize) -> Option<String> {
    let value = row.get(index)?;
    if value.is_null() {
        return None;
    }
    value.as_str().map(ToString::to_string).or_else(|| Some(value.to_string()))
}

fn normalize_information_schema_table_type(table_type: &str) -> String {
    match table_type.trim().to_ascii_uppercase().replace(' ', "_").as_str() {
        "BASE_TABLE" => "TABLE".to_string(),
        "VIEW" => "VIEW".to_string(),
        "MATERIALIZED_VIEW" => "MATERIALIZED_VIEW".to_string(),
        _ => table_type.to_string(),
    }
}

fn quote_presto_like_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn sql_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(test)]
mod tests {
    use super::db;
    use super::{
        clickhouse_metadata_database, deduplicate_column_infos, filter_mysql_system_databases_for_config,
        filter_table_infos, is_agent_postgres_metadata_fallback_config, normalize_information_schema_table_type,
        oracle_table_comment_from_query_result, oracle_table_comment_sql, presto_like_information_schema_tables_sql,
        presto_like_tables_from_query_result,
    };
    #[cfg(feature = "duckdb-bundled")]
    use super::{
        duckdb_attach_database, duckdb_completion_assistant_search, duckdb_list_databases,
        duckdb_query_tables_in_database,
    };
    use crate::models::connection::{ConnectionConfig, DatabaseType};

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
        }
    }

    fn test_connection_config(db_type: DatabaseType) -> ConnectionConfig {
        ConnectionConfig {
            id: "test".to_string(),
            name: "test".to_string(),
            db_type,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            host: "127.0.0.1".to_string(),
            port: 5432,
            username: "user".to_string(),
            password: "secret".to_string(),
            database: Some("demo".to_string()),
            visible_databases: None,
            visible_schemas: None,
            attached_databases: Vec::new(),
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

    fn test_table_info(name: &str) -> super::db::TableInfo {
        super::db::TableInfo {
            name: name.to_string(),
            table_type: "BASE TABLE".to_string(),
            comment: None,
            parent_schema: None,
            parent_name: None,
        }
    }

    fn test_database_info(name: &str) -> super::db::DatabaseInfo {
        super::db::DatabaseInfo { name: name.to_string() }
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

        let filtered = filter_table_infos(tables, Some("audit"), Some(1), Some(1), None);

        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].name, "audit_record");
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

        let filtered = filter_table_infos(tables, None, Some(1), Some(1), Some(&object_types));

        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].name, "active_users");
    }

    #[test]
    fn presto_like_information_schema_sql_uses_catalog_and_schema_without_system_jdbc() {
        let sql = presto_like_information_schema_tables_sql("hive", "sales_analytics");

        assert_eq!(
            sql,
            "SELECT table_name, CASE table_type WHEN 'BASE TABLE' THEN 'TABLE' ELSE table_type END AS table_type FROM \"hive\".information_schema.tables WHERE table_schema = 'sales_analytics' AND table_type IN ('BASE TABLE', 'VIEW') ORDER BY table_type, table_name"
        );
        assert!(!sql.contains("system.jdbc.tables"));
    }

    #[test]
    fn presto_like_information_schema_sql_escapes_identifiers_and_literals() {
        let sql = presto_like_information_schema_tables_sql("hi\"ve", "sales'analytics");

        assert!(sql.contains("\"hi\"\"ve\".information_schema.tables"));
        assert!(sql.contains("table_schema = 'sales''analytics'"));
    }

    #[test]
    fn presto_like_tables_from_query_result_normalizes_base_table_type() {
        let result = super::db::QueryResult {
            columns: vec!["table_name".to_string(), "table_type".to_string()],
            column_types: vec![],
            column_sortables: vec![],
            rows: vec![
                vec![serde_json::json!("daily_revenue"), serde_json::json!("BASE TABLE")],
                vec![serde_json::json!("revenue_view"), serde_json::json!("VIEW")],
            ],
            affected_rows: 0,
            execution_time_ms: 1,
            truncated: false,
            session_id: None,
            has_more: false,
        };

        let tables = presto_like_tables_from_query_result(&result);

        assert_eq!(tables[0].name, "daily_revenue");
        assert_eq!(tables[0].table_type, "TABLE");
        assert_eq!(tables[1].name, "revenue_view");
        assert_eq!(tables[1].table_type, "VIEW");
        assert_eq!(normalize_information_schema_table_type("MATERIALIZED VIEW"), "MATERIALIZED_VIEW");
    }

    #[cfg(feature = "duckdb-bundled")]
    #[test]
    fn duckdb_list_databases_includes_attached_database() {
        let unique = uuid::Uuid::new_v4();
        let path = std::env::temp_dir().join(format!("dbx-attached-{unique}.duckdb"));
        let _ = std::fs::remove_file(&path);
        let con = duckdb::Connection::open_in_memory().unwrap();

        duckdb_attach_database(&con, "analytics", path.to_str().unwrap()).unwrap();
        let databases = duckdb_list_databases(&con).unwrap();

        assert!(databases.iter().any(|database| database.name == "main"));
        assert!(databases.iter().any(|database| database.name == "analytics"));

        let _ = std::fs::remove_file(path);
    }

    #[cfg(feature = "duckdb-bundled")]
    #[test]
    fn duckdb_query_tables_filters_by_attached_database() {
        let unique = uuid::Uuid::new_v4();
        let path = std::env::temp_dir().join(format!("dbx-attached-tables-{unique}.duckdb"));
        let _ = std::fs::remove_file(&path);
        let con = duckdb::Connection::open_in_memory().unwrap();

        con.execute_batch("CREATE TABLE main_table(id INTEGER);").unwrap();
        duckdb_attach_database(&con, "analytics", path.to_str().unwrap()).unwrap();
        con.execute_batch("CREATE TABLE analytics.attached_table(id INTEGER);").unwrap();

        let main_tables = duckdb_query_tables_in_database(&con, "main", "main").unwrap();
        let attached_tables = duckdb_query_tables_in_database(&con, "analytics", "main").unwrap();

        assert!(main_tables.iter().any(|table| table.name == "main_table"));
        assert!(!main_tables.iter().any(|table| table.name == "attached_table"));
        assert!(attached_tables.iter().any(|table| table.name == "attached_table"));
        assert!(!attached_tables.iter().any(|table| table.name == "main_table"));

        let _ = std::fs::remove_file(path);
    }

    #[cfg(feature = "duckdb-bundled")]
    #[test]
    fn duckdb_completion_assistant_searches_catalog_metadata_with_limit() {
        let con = duckdb::Connection::open_in_memory().unwrap();
        con.execute_batch(
            "CREATE TABLE account(id INTEGER, display_name VARCHAR); CREATE VIEW account_view AS SELECT id FROM account;",
        )
        .unwrap();

        let request = db::CompletionAssistantRequest {
            connection_id: "c1".to_string(),
            database: "main".to_string(),
            schema: Some("main".to_string()),
            object_kinds: vec![db::CompletionAssistantObjectKind::Table, db::CompletionAssistantObjectKind::View],
            mask: "account".to_string(),
            case_sensitive: false,
            global_search: false,
            max_results: Some(1),
            search_in_comments: false,
            search_in_definitions: false,
            parent_schema: Some("main".to_string()),
            parent_name: None,
            match_mode: Some(db::CompletionAssistantMatchMode::Prefix),
        };

        let tables = duckdb_completion_assistant_search(&con, &request, &[]).unwrap();
        assert_eq!(tables.candidates.len(), 1);
        assert!(tables.incomplete);
        assert!(!tables.fallback_used);
        assert_eq!(tables.candidates[0].name, "account");

        let columns = duckdb_completion_assistant_search(
            &con,
            &db::CompletionAssistantRequest {
                object_kinds: vec![db::CompletionAssistantObjectKind::Column],
                mask: "name".to_string(),
                max_results: Some(10),
                parent_name: Some("account".to_string()),
                match_mode: Some(db::CompletionAssistantMatchMode::Contains),
                ..request
            },
            &[],
        )
        .unwrap();
        assert_eq!(columns.candidates.len(), 1);
        assert_eq!(columns.candidates[0].name, "display_name");
    }

    #[test]
    fn detects_unsupported_agent_completion_assistant_errors() {
        assert!(super::is_agent_completion_assistant_unsupported(
            "Agent RPC error (-1): Unknown method: completion_assistant_search_v1"
        ));
        assert!(super::is_agent_completion_assistant_unsupported(
            "Agent RPC error (-1): Completion assistant search is not supported by this agent"
        ));
        assert!(!super::is_agent_completion_assistant_unsupported("Agent RPC error (-1): Connection failed"));
    }

    #[test]
    fn clickhouse_metadata_uses_schema_when_database_is_empty() {
        assert_eq!(clickhouse_metadata_database("", "testdb"), "testdb");
        assert_eq!(clickhouse_metadata_database("testdb", ""), "testdb");
        assert_eq!(clickhouse_metadata_database("default", "testdb"), "default");
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
    fn oracle_table_comment_from_query_result_returns_optional_non_blank_comment() {
        let result = db::QueryResult {
            columns: vec!["COMMENTS".to_string()],
            column_types: Vec::new(),
            column_sortables: Vec::new(),
            rows: vec![vec![serde_json::json!("Customer table")]],
            affected_rows: 0,
            execution_time_ms: 0,
            truncated: false,
            session_id: None,
            has_more: false,
        };

        assert_eq!(oracle_table_comment_from_query_result(result).unwrap().as_deref(), Some("Customer table"));

        let empty = db::QueryResult {
            columns: vec!["COMMENTS".to_string()],
            column_types: Vec::new(),
            column_sortables: Vec::new(),
            rows: vec![vec![serde_json::json!("  ")]],
            affected_rows: 0,
            execution_time_ms: 0,
            truncated: false,
            session_id: None,
            has_more: false,
        };

        assert_eq!(oracle_table_comment_from_query_result(empty).unwrap(), None);
    }
}

pub async fn list_objects_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
) -> Result<Vec<db::ObjectInfo>, String> {
    retry_metadata_connection(state, connection_id, Some(database), || {
        list_objects_once(state, connection_id, database, schema)
    })
    .await
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
    retry_metadata_connection(state, connection_id, Some(database), || {
        list_completion_objects_once(state, connection_id, database, schema)
    })
    .await
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
        let pool_key = state.get_or_create_pool(&request.connection_id, Some(&request.database)).await?;
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

        #[cfg(feature = "duckdb-bundled")]
        {
            let duckdb_attached_names = duckdb_attached_database_names(state, &request.connection_id).await;
            let connections = state.connections.read().await;
            if let Some(con) = extract_pool!(&connections, &pool_key, DuckDb) {
                drop(connections);
                let con = con.lock().map_err(|e| e.to_string())?;
                return duckdb_completion_assistant_search(&con, &request, &duckdb_attached_names);
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
    error.contains("Unknown method: completion_assistant_search_v1")
        || error.contains("Method not found: completion_assistant_search_v1")
        || error.contains("method not found: completion_assistant_search_v1")
        || error.contains("Completion assistant search is not supported")
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
    let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
    let db_config = connection_config(state, connection_id).await;
    let connections = state.connections.read().await;
    try_sqlserver!(connections, &pool_key, list_object_statistics, schema);
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
        _ => Ok(vec![]),
    }
}

async fn list_objects_once(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
) -> Result<Vec<db::ObjectInfo>, String> {
    let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
    let db_config = connection_config(state, connection_id).await;

    {
        let connections = state.connections.read().await;
        #[cfg(feature = "duckdb-bundled")]
        if let Some(ext_pool) = extract_pool!(&connections, &pool_key, ExternalTabular) {
            drop(connections);
            let cache = ext_pool.cache.clone();
            return tokio::task::spawn_blocking(move || {
                let con = cache.lock().map_err(|e| e.to_string())?;
                Ok(duckdb_query_tables(&con)?
                    .into_iter()
                    .map(|table| db::ObjectInfo {
                        name: table.name,
                        object_type: table.table_type,
                        schema: None,
                        comment: table.comment,
                        created_at: None,
                        updated_at: None,
                        parent_schema: table.parent_schema,
                        parent_name: table.parent_name,
                    })
                    .collect())
            })
            .await
            .map_err(|e| e.to_string())?;
        }
        if let Some(PoolKind::ExternalDriver { config, session, .. }) = connections.get(&pool_key) {
            let config = config.clone();
            let session = session.clone();
            drop(connections);
            if uses_presto_like_information_schema_tables(&config.db_type) {
                return external_driver_presto_like_objects(session, config.as_ref(), database, schema).await;
            }
            return session
                .invoke::<Vec<db::ObjectInfo>>(
                    "listObjects",
                    serde_json::json!({ "connection": config.as_ref(), "database": database, "schema": schema }),
                )
                .await;
        }
        try_sqlserver!(connections, &pool_key, list_objects, schema);
        if let Some(client) = extract_pool!(&connections, &pool_key, Agent) {
            let is_oracle = db_config.as_ref().is_some_and(|config| config.db_type == DatabaseType::Oracle);
            let fallback_config = db_config.clone();
            drop(connections);
            if is_oracle {
                return oracle_agent_list_objects(client, database, schema, agent_metadata_timeout(db_config.as_ref()))
                    .await;
            }
            let mut client = client.lock().await;
            match client
                .list_objects::<Vec<db::ObjectInfo>>(database, schema, agent_metadata_timeout(db_config.as_ref()))
                .await
            {
                Ok(objects) if !objects.is_empty() => return Ok(objects),
                Ok(objects) => {
                    if let Some(config) = fallback_config.as_ref() {
                        match native_postgres_metadata_pool(state, connection_id, database, config).await {
                            Ok(Some(pool)) => return db::postgres::list_objects(&pool, schema).await,
                            Ok(None) => return Ok(objects),
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
                    return Ok(objects);
                }
                Err(agent_error) => {
                    if let Some(config) = fallback_config.as_ref() {
                        if let Some(pool) =
                            native_postgres_metadata_pool(state, connection_id, database, config).await?
                        {
                            return db::postgres::list_objects(&pool, schema).await.map_err(|fallback_error| {
                                format!("{agent_error}\n\nNative PostgreSQL metadata fallback failed: {fallback_error}")
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
                db::ob_oracle::list_objects(p, schema).await
            } else if db_config.as_ref().is_some_and(is_manticoresearch_config) {
                db::manticoresearch::list_objects(p, database).await
            } else if db_config.as_ref().is_some_and(is_doris_family_config) {
                db::mysql::list_table_objects_show(p, database).await
            } else {
                db::mysql::list_objects(p, database).await
            }
        }
        PoolKind::Postgres(p) if db_config.as_ref().is_some_and(is_questdb_config) => {
            db::questdb::list_objects(p, schema).await
        }
        PoolKind::Postgres(p) => db::postgres::list_objects(p, schema).await,
        _ => {
            drop(connections);
            Ok(list_tables_core(state, connection_id, database, schema, None, None, None, None)
                .await?
                .into_iter()
                .map(|table| db::ObjectInfo {
                    name: table.name,
                    object_type: table.table_type,
                    schema: if schema.is_empty() { None } else { Some(schema.to_string()) },
                    comment: table.comment,
                    created_at: None,
                    updated_at: None,
                    parent_schema: table.parent_schema,
                    parent_name: table.parent_name,
                })
                .collect())
        }
    }
}

async fn list_completion_objects_once(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
) -> Result<Vec<db::ObjectInfo>, String> {
    let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
    let db_config = connection_config(state, connection_id).await;

    let connections = state.connections.read().await;
    if let Some(PoolKind::ExternalDriver { config, session, .. }) = connections.get(&pool_key) {
        let config = config.clone();
        let session = session.clone();
        drop(connections);
        return session
            .invoke::<Vec<db::ObjectInfo>>(
                "listObjects",
                serde_json::json!({ "connection": config.as_ref(), "database": database, "schema": schema }),
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
                                return db::postgres::list_objects(&pool, schema).await.map(filter_completion_objects)
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
                            return db::postgres::list_objects(&pool, schema)
                                .await
                                .map(filter_completion_objects)
                                .map_err(|fallback_error| {
                                    format!(
                                        "{agent_error}\n\nNative PostgreSQL metadata fallback failed: {fallback_error}"
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
        PoolKind::Postgres(p) => db::postgres::list_objects(p, schema).await.map(filter_completion_objects),
        PoolKind::SqlServer(_) => {
            drop(connections);
            let objects = list_objects_once(state, connection_id, database, schema).await?;
            Ok(filter_completion_objects(objects))
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
    // Kingbase has dedicated agent metadata SQL and may carry JDBC-specific URL
    // parameters that the native PostgreSQL driver cannot parse.
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
    let (host, port) = state.connection_host_port(connection_id, &postgres_config).await?;
    let url = connection_url_for_endpoint(&postgres_config, &host, port);
    let connect_timeout = Duration::from_secs(postgres_config.effective_connect_timeout_secs());
    db::postgres::connect(&url, connect_timeout).await.map(Some)
}

async fn retry_metadata_connection<T, F, Fut>(
    state: &AppState,
    connection_id: &str,
    database: Option<&str>,
    mut operation: F,
) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, String>>,
{
    let result = operation().await;
    match result {
        Err(error) if crate::query::is_connection_error(&error) => {
            state.reconnect_pool(connection_id, database).await?;
            operation().await
        }
        _ => result,
    }
}

pub async fn get_columns_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<db::ColumnInfo>, String> {
    retry_metadata_connection(state, connection_id, Some(database), || async {
        let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
        #[cfg(feature = "duckdb-bundled")]
        let duckdb_attached_names = duckdb_attached_database_names(state, connection_id).await;
        let db_config = connection_config(state, connection_id).await;

        {
            let connections = state.connections.read().await;
            #[cfg(feature = "duckdb-bundled")]
            if let Some(ext_pool) = extract_pool!(&connections, &pool_key, ExternalTabular) {
                drop(connections);
                let cache = ext_pool.cache.clone();
                let table = table.to_string();
                return tokio::task::spawn_blocking(move || {
                    let con = cache.lock().map_err(|e| e.to_string())?;
                    duckdb_query_columns(&con, &table)
                })
                .await
                .map_err(|e| e.to_string())?;
            }
            if let Some(PoolKind::ExternalDriver { config, session, .. }) = connections.get(&pool_key) {
                let config = config.clone();
                let session = session.clone();
                drop(connections);
                let columns = session
                    .invoke::<Vec<db::ColumnInfo>>(
                        "getColumns",
                        serde_json::json!({
                            "connection": config.as_ref(),
                            "database": database,
                            "schema": schema,
                            "table": table,
                        }),
                    )
                    .await?;
                return Ok(deduplicate_column_infos(columns));
            }
            #[cfg(feature = "duckdb-bundled")]
            if let Some(con) = extract_pool!(&connections, &pool_key, DuckDb) {
                drop(connections);
                let con = con.lock().map_err(|e| e.to_string())?;
                return duckdb_query_columns_in_database_with_attached(
                    &con,
                    database,
                    schema,
                    table,
                    &duckdb_attached_names,
                );
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
                                        format!(
                                            "{agent_error}\n\nNative PostgreSQL metadata fallback failed: {fallback_error}"
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
                db::mysql::get_columns_show(p, metadata_database, table).await.map(deduplicate_column_infos)
            }
            PoolKind::Mysql(p, mode) => {
                dispatch_mysql!(p, mode, db::mysql::get_columns, db::ob_oracle::get_columns, database, table)
                    .map(deduplicate_column_infos)
            }
            PoolKind::Postgres(p) if db_config.as_ref().is_some_and(is_questdb_config) => {
                db::questdb::get_columns(p, schema, table).await.map(deduplicate_column_infos)
            }
            PoolKind::Postgres(p) => db::postgres::get_columns(p, schema, table).await.map(deduplicate_column_infos),
            PoolKind::Sqlite(p) => db::sqlite::get_columns(p, schema, table).await.map(deduplicate_column_infos),
            PoolKind::Rqlite(client) => {
                db::rqlite_driver::get_columns(client, schema, table).await.map(deduplicate_column_infos)
            }
            _ => Ok(vec![]),
        }
    })
    .await
}

fn deduplicate_column_infos(columns: Vec<db::ColumnInfo>) -> Vec<db::ColumnInfo> {
    let mut result: Vec<db::ColumnInfo> = Vec::with_capacity(columns.len());
    for column in columns {
        if let Some(existing) = result.iter_mut().find(|existing| existing.name == column.name) {
            existing.is_primary_key |= column.is_primary_key;
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
    retry_metadata_connection(state, connection_id, Some(database), || async {
        let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
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
                dispatch_mysql!(p, mode, db::mysql::list_indexes, db::ob_oracle::list_indexes, schema, table)
            }
            PoolKind::Postgres(p) if db_config.as_ref().is_some_and(is_questdb_config) => {
                db::questdb::list_indexes(p, schema, table).await
            }
            PoolKind::Postgres(p) => db::postgres::list_indexes(p, schema, table).await,
            PoolKind::Sqlite(p) => db::sqlite::list_indexes(p, schema, table).await,
            PoolKind::Rqlite(client) => db::rqlite_driver::list_indexes(client, schema, table).await,
            PoolKind::MongoDb(client) => db::mongo_driver::list_indexes(client, database, table).await,
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
    retry_metadata_connection(state, connection_id, Some(database), || async {
        let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
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
                dispatch_mysql!(p, mode, db::mysql::list_foreign_keys, db::ob_oracle::list_foreign_keys, schema, table)
            }
            PoolKind::Postgres(p) => db::postgres::list_foreign_keys(p, schema, table).await,
            PoolKind::Sqlite(p) => db::sqlite::list_foreign_keys(p, schema, table).await,
            PoolKind::Rqlite(client) => db::rqlite_driver::list_foreign_keys(client, schema, table).await,
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
        let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
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
                dispatch_mysql!(p, mode, db::mysql::list_triggers, db::ob_oracle::list_triggers, schema, table)
            }
            PoolKind::Postgres(p) => db::postgres::list_triggers(p, schema, table).await,
            PoolKind::Sqlite(p) => db::sqlite::list_triggers(p, schema, table).await,
            PoolKind::Rqlite(client) => db::rqlite_driver::list_triggers(client, schema, table).await,
            _ => Ok(vec![]),
        }
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
        let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
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
        let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
        let connections = state.connections.read().await;
        let pool = connections.get(&pool_key).ok_or("Pool not found")?;

        match pool {
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
        let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
        let connections = state.connections.read().await;
        let pool = connections.get(&pool_key).ok_or("Pool not found")?;

        match pool {
            PoolKind::Postgres(p) => db::postgres::list_rules(p, schema).await,
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
        let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
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
    if crate::sql_dialect::parse_sqlserver_linked_schema_ref(schema).is_some() {
        return Err("DDL is not supported for SQL Server linked server tables".to_string());
    }
    if matches!(object_type, Some(db::ObjectSourceKind::View)) {
        let source =
            get_object_source_core(state, connection_id, database, schema, table, db::ObjectSourceKind::View).await?;
        let database_type = connection_config(state, connection_id).await.map(|config| config.db_type);
        return Ok(crate::object_source_sql::build_view_ddl_sql(crate::object_source_sql::BuildViewDdlInput {
            database_type,
            schema: if schema.trim().is_empty() { None } else { Some(schema.to_string()) },
            name: table.to_string(),
            source: source.source,
        }));
    }

    let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
    let db_config = connection_config(state, connection_id).await;

    {
        let connections = state.connections.read().await;
        #[cfg(feature = "duckdb-bundled")]
        if let Some(con) = extract_pool!(&connections, &pool_key, DuckDb) {
            drop(connections);
            let tbl = table.replace('\'', "''");
            let con = con.lock().map_err(|e| e.to_string())?;
            let mut stmt = con
                .prepare(&format!("SELECT sql FROM duckdb_tables() WHERE table_name = '{tbl}'"))
                .map_err(|e| e.to_string())?;
            let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
            if let Some(row) = rows.next().map_err(|e| e.to_string())? {
                return row.get::<_, String>(0).map_err(|e| e.to_string());
            }
            return Err("Table not found".to_string());
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
            let mut client = client.lock().await;
            return client.get_table_ddl(database, schema, table, agent_metadata_timeout(db_config.as_ref())).await;
        }
    }

    let connections = state.connections.read().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;

    match pool {
        PoolKind::Mysql(p, _) => mysql_ddl(p, table).await,
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
        PoolKind::Postgres(p) => pg_ddl(p, schema, table).await,
        PoolKind::Sqlite(p) => sqlite_ddl(p, table).await,
        PoolKind::Rqlite(client) => db::rqlite_driver::table_ddl(client, table).await,
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

fn is_doris_family_config(config: &ConnectionConfig) -> bool {
    matches!(config.db_type, DatabaseType::Doris | DatabaseType::StarRocks | DatabaseType::ManticoreSearch)
        || matches!(config.driver_profile.as_deref(), Some("doris" | "selectdb" | "starrocks" | "manticoresearch"))
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

fn mysql_ident(value: &str) -> String {
    format!("`{}`", value.replace('`', "``"))
}

fn sqlite_object_type(kind: &db::ObjectSourceKind) -> &'static str {
    match kind {
        db::ObjectSourceKind::View | db::ObjectSourceKind::MaterializedView => "view",
        db::ObjectSourceKind::Procedure
        | db::ObjectSourceKind::Function
        | db::ObjectSourceKind::Sequence
        | db::ObjectSourceKind::Package
        | db::ObjectSourceKind::PackageBody => "routine",
    }
}

fn sqlserver_object_type_filter(kind: &db::ObjectSourceKind) -> &'static str {
    match kind {
        db::ObjectSourceKind::View => "'V'",
        db::ObjectSourceKind::Procedure => "'P'",
        db::ObjectSourceKind::Function => "'FN','IF','TF','FS','FT'",
        db::ObjectSourceKind::Sequence
        | db::ObjectSourceKind::Package
        | db::ObjectSourceKind::PackageBody
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

pub fn postgres_object_source_sql(schema: &str, name: &str, kind: &db::ObjectSourceKind) -> String {
    match kind {
        db::ObjectSourceKind::View | db::ObjectSourceKind::MaterializedView => {
            format!(
                "SELECT CASE WHEN c.relkind = 'm' THEN format('CREATE MATERIALIZED VIEW %I.%I AS ', n.nspname, c.relname) || regexp_replace(pg_get_viewdef(c.oid, 0), ';[[:space:]]*$', '') || CASE WHEN c.relispopulated THEN ' WITH DATA' ELSE ' WITH NO DATA' END \
                 ELSE format('CREATE OR REPLACE VIEW %I.%I AS ', n.nspname, c.relname) || pg_get_viewdef(c.oid, 0) \
                 END \
                 FROM pg_catalog.pg_class c \
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = {} AND c.relname = {} AND c.relkind IN ('v','m') \
                 ORDER BY c.oid LIMIT 1",
                sql_string(schema),
                sql_string(name)
            )
        }
        db::ObjectSourceKind::Procedure | db::ObjectSourceKind::Function => {
            let prokind = if matches!(kind, db::ObjectSourceKind::Procedure) { "p" } else { "f" };
            format!(
                "SELECT pg_get_functiondef(p.oid) \
                 FROM pg_proc p \
                 JOIN pg_namespace n ON n.oid = p.pronamespace \
                 WHERE n.nspname = {} AND p.proname = {} AND p.prokind = '{}' \
                 ORDER BY p.oid LIMIT 1",
                sql_string(schema),
                sql_string(name),
                prokind
            )
        }
        db::ObjectSourceKind::Sequence => {
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
        db::ObjectSourceKind::Package | db::ObjectSourceKind::PackageBody => "SELECT NULL WHERE FALSE".to_string(),
    }
}

pub fn oracle_object_source_sql(schema: &str, name: &str, kind: &db::ObjectSourceKind) -> String {
    let object_type = match kind {
        db::ObjectSourceKind::View => "VIEW",
        db::ObjectSourceKind::MaterializedView => "MATERIALIZED_VIEW",
        db::ObjectSourceKind::Procedure => "PROCEDURE",
        db::ObjectSourceKind::Function => "FUNCTION",
        db::ObjectSourceKind::Sequence => "SEQUENCE",
        db::ObjectSourceKind::Package => "PACKAGE",
        db::ObjectSourceKind::PackageBody => "PACKAGE_BODY",
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

pub fn sqlite_object_source_sql(name: &str, kind: &db::ObjectSourceKind) -> String {
    format!(
        "SELECT sql FROM sqlite_master WHERE type = {} AND name = {}",
        sql_string(sqlite_object_type(kind)),
        sql_string(name)
    )
}

pub fn mysql_object_source_sql(name: &str, kind: &db::ObjectSourceKind) -> String {
    match kind {
        db::ObjectSourceKind::View => format!("SHOW CREATE VIEW {}", mysql_ident(name)),
        db::ObjectSourceKind::Procedure => format!("SHOW CREATE PROCEDURE {}", mysql_ident(name)),
        db::ObjectSourceKind::Function => format!("SHOW CREATE FUNCTION {}", mysql_ident(name)),
        db::ObjectSourceKind::Sequence
        | db::ObjectSourceKind::Package
        | db::ObjectSourceKind::PackageBody
        | db::ObjectSourceKind::MaterializedView => String::new(),
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

async fn mysql_object_source(
    pool: &db::mysql::MySqlPool,
    name: &str,
    kind: &db::ObjectSourceKind,
) -> Result<String, String> {
    use mysql_async::prelude::*;
    let sql = mysql_object_source_sql(name, kind);
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
    let row = rows.first().ok_or("Object source not found")?;
    let index = if matches!(kind, db::ObjectSourceKind::View) { 1 } else { 2 };
    row.get_opt::<String, usize>(index)
        .and_then(|result| result.ok())
        .or_else(|| {
            row.get_opt::<Vec<u8>, usize>(index)
                .and_then(|result| result.ok())
                .map(|b| String::from_utf8_lossy(&b).to_string())
        })
        .ok_or_else(|| "Failed to read object source".to_string())
}

pub async fn get_object_source_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    name: &str,
    object_type: db::ObjectSourceKind,
) -> Result<db::ObjectSource, String> {
    retry_metadata_connection(state, connection_id, Some(database), || {
        get_object_source_once(state, connection_id, database, schema, name, object_type.clone())
    })
    .await
}

async fn get_object_source_once(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    name: &str,
    object_type: db::ObjectSourceKind,
) -> Result<db::ObjectSource, String> {
    let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
    let db_config = connection_config(state, connection_id).await;
    let source = {
        let connections = state.connections.read().await;
        if let Some(PoolKind::ExternalDriver { config, session, .. }) = connections.get(&pool_key) {
            let config = config.clone();
            let session = session.clone();
            drop(connections);
            let result: db::ObjectSource = session
                .invoke(
                    "getObjectSource",
                    serde_json::json!({
                        "connection": config.as_ref(),
                        "database": database,
                        "schema": schema,
                        "name": name,
                        "object_type": &object_type,
                    }),
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
                PoolKind::Mysql(pool, _) => mysql_object_source(pool, name, &object_type).await?,
                PoolKind::Postgres(pool) if db_config.as_ref().is_some_and(is_questdb_config) => {
                    // only view
                    db::questdb::questdb_object_source(pool, name).await?
                }
                PoolKind::Postgres(pool) => postgres_object_source(pool, schema, name, &object_type).await?,
                PoolKind::Sqlite(pool) => first_string_cell(
                    db::sqlite::execute_query(pool, &sqlite_object_source_sql(name, &object_type)).await?,
                )?,
                PoolKind::Rqlite(client) => {
                    return db::rqlite_driver::object_source(client, name, &object_type).await;
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
                _ => return Err("Object source is not supported for this database type".to_string()),
            }
        }
    };

    Ok(db::ObjectSource {
        name: name.to_string(),
        object_type,
        schema: if schema.is_empty() { None } else { Some(schema.to_string()) },
        source,
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
    client: Arc<tokio::sync::Mutex<db::agent_driver::AgentDriverClient>>,
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
    Ok(result
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
                comment: None,
                created_at: None,
                updated_at: None,
                parent_schema: None,
                parent_name: None,
            })
        })
        .collect())
}

async fn oracle_agent_object_source(
    client: Arc<tokio::sync::Mutex<db::agent_driver::AgentDriverClient>>,
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

async fn postgres_object_source(
    pool: &deadpool_postgres::Pool,
    schema: &str,
    name: &str,
    object_type: &db::ObjectSourceKind,
) -> Result<String, String> {
    let sql = postgres_object_source_sql(schema, name, object_type);
    match db::postgres::execute_query(pool, &sql).await.and_then(first_string_cell) {
        Ok(source) => Ok(source),
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

#[cfg(test)]
mod object_source_tests {
    use super::*;
    use crate::types::ObjectSourceKind;

    #[test]
    fn builds_sqlserver_object_source_sql_for_schema_scoped_routines() {
        assert_eq!(
            sqlserver_object_source_sql("dbo", "refresh_cache", &ObjectSourceKind::Procedure),
            "SELECT m.definition FROM sys.sql_modules m JOIN sys.objects o ON o.object_id = m.object_id JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = 'dbo' AND o.name = 'refresh_cache' AND o.type IN ('P')"
        );
    }

    #[test]
    fn builds_postgres_object_source_sql_for_views_and_functions() {
        assert_eq!(
            postgres_object_source_sql("public", "active_users", &ObjectSourceKind::View),
            "SELECT CASE WHEN c.relkind = 'm' THEN format('CREATE MATERIALIZED VIEW %I.%I AS ', n.nspname, c.relname) || regexp_replace(pg_get_viewdef(c.oid, 0), ';[[:space:]]*$', '') || CASE WHEN c.relispopulated THEN ' WITH DATA' ELSE ' WITH NO DATA' END ELSE format('CREATE OR REPLACE VIEW %I.%I AS ', n.nspname, c.relname) || pg_get_viewdef(c.oid, 0) END FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'active_users' AND c.relkind IN ('v','m') ORDER BY c.oid LIMIT 1"
        );
        assert_eq!(
            postgres_object_source_sql("public", "recalc_score", &ObjectSourceKind::Function),
            "SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'recalc_score' AND p.prokind = 'f' ORDER BY p.oid LIMIT 1"
        );
    }

    #[test]
    fn builds_postgres_view_source_sql_without_regclass_cast() {
        let sql = postgres_object_source_sql("tenant's schema", "active users", &ObjectSourceKind::View);

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
        }
    }

    #[test]
    fn postgres_table_ddl_includes_column_comments() {
        let mut display_name = column("display_name", "text");
        display_name.comment = Some("User's display name".to_string());
        let columns = vec![display_name];

        let ddl = render_postgres_table_ddl("public", "users", &columns, &[], &[]);

        assert!(ddl.contains("COMMENT ON COLUMN \"public\".\"users\".\"display_name\" IS 'User''s display name';"));
    }

    #[test]
    fn sqlserver_table_ddl_includes_column_comments() {
        let mut display_name = column("display]name", "nvarchar(100)");
        display_name.comment = Some("User's display name".to_string());
        let columns = vec![display_name];

        let ddl = render_sqlserver_table_ddl("dbo", "users", &columns, &[], &[]);

        assert!(ddl.contains("CREATE TABLE [dbo].[users] (\n  [display]]name] nvarchar(100)\n);"));
        assert!(ddl.contains(
            "EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'User''s display name', @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'users', @level2type=N'COLUMN', @level2name=N'display]name';"
        ));
    }

    #[test]
    fn opengauss_table_ddl_uses_native_tabledef_function() {
        assert_eq!(
            opengauss_table_ddl_sql("tenant's schema", "active users"),
            "SELECT pg_get_tabledef('\"tenant''s schema\".\"active users\"')"
        );
    }
}

pub async fn mysql_ddl(pool: &db::mysql::MySqlPool, table: &str) -> Result<String, String> {
    use mysql_async::prelude::*;
    let sql = format!("SHOW CREATE TABLE `{}`", table.replace('`', "``"));
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
    let row = rows.first().ok_or("DDL not found")?;
    row.get_opt::<String, usize>(1)
        .and_then(|result| result.ok())
        .or_else(|| {
            row.get_opt::<Vec<u8>, usize>(1)
                .and_then(|result| result.ok())
                .map(|b| String::from_utf8_lossy(&b).to_string())
        })
        .ok_or_else(|| "Failed to read DDL".to_string())
}

pub async fn sqlite_ddl(pool: &db::sqlite::SqliteHandle, table: &str) -> Result<String, String> {
    let pool = pool.clone();
    let table = table.to_string();
    tokio::task::spawn_blocking(move || {
        pool.with_connection(|conn| {
            conn.query_row("SELECT sql FROM sqlite_master WHERE type='table' AND name=?1", [table], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn opengauss_table_ddl(pool: &deadpool_postgres::Pool, schema: &str, table: &str) -> Result<String, String> {
    first_string_cell(db::postgres::execute_query(pool, &opengauss_table_ddl_sql(schema, table)).await?)
}

pub fn opengauss_table_ddl_sql(schema: &str, table: &str) -> String {
    let qualified_name = format!("{}.{}", pg_ident(schema), pg_ident(table));
    format!("SELECT pg_get_tabledef({})", sql_string(&qualified_name))
}

pub async fn pg_ddl(pool: &deadpool_postgres::Pool, schema: &str, table: &str) -> Result<String, String> {
    let (columns, indexes, fkeys) = tokio::try_join!(
        db::postgres::get_columns(pool, schema, table),
        db::postgres::list_indexes(pool, schema, table),
        db::postgres::list_foreign_keys(pool, schema, table),
    )?;

    Ok(render_postgres_table_ddl(schema, table, &columns, &indexes, &fkeys))
}

pub fn render_postgres_table_ddl(
    schema: &str,
    table: &str,
    columns: &[db::ColumnInfo],
    indexes: &[db::IndexInfo],
    fkeys: &[db::ForeignKeyInfo],
) -> String {
    let table_name = format!("{}.{}", pg_ident(schema), pg_ident(table));
    let mut ddl = format!("CREATE TABLE {table_name} (\n");
    let col_lines: Vec<String> = columns
        .iter()
        .map(|c| {
            let mut line = format!("  {} {}", pg_ident(&c.name), c.data_type);
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
        ddl.push_str(&format!(",\n  PRIMARY KEY ({})", pks.iter().map(|k| pg_ident(k)).collect::<Vec<_>>().join(", ")));
    }
    for fk in fkeys {
        ddl.push_str(&format!(
            ",\n  CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {}({})",
            pg_ident(&fk.name),
            pg_ident(&fk.column),
            pg_ident(&fk.ref_table),
            pg_ident(&fk.ref_column)
        ));
    }
    ddl.push_str("\n);\n");

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

pub async fn build_sqlserver_ddl(
    client: &mut db::sqlserver::SqlServerClient,
    schema: &str,
    table: &str,
) -> Result<String, String> {
    let columns = db::sqlserver::get_columns(client, schema, table).await?;
    let indexes = db::sqlserver::list_indexes(client, schema, table).await?;
    let fkeys = db::sqlserver::list_foreign_keys(client, schema, table).await?;

    Ok(render_sqlserver_table_ddl(schema, table, &columns, &indexes, &fkeys))
}

pub fn render_sqlserver_table_ddl(
    schema: &str,
    table: &str,
    columns: &[db::ColumnInfo],
    indexes: &[db::IndexInfo],
    fkeys: &[db::ForeignKeyInfo],
) -> String {
    let table_name = format!("{}.{}", sqlserver_ident(schema), sqlserver_ident(table));
    let mut ddl = format!("CREATE TABLE {table_name} (\n");
    let col_lines: Vec<String> = columns
        .iter()
        .map(|c| {
            let mut line = format!("  {} {}", sqlserver_ident(&c.name), c.data_type);
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
