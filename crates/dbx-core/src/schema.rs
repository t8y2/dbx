use crate::connection::{connection_url_for_endpoint, database_connection_config, AppState, MysqlMode, PoolKind};
use crate::db;
use crate::models::connection::{ConnectionConfig, DatabaseType};
use crate::query::{agent_execute_query_params, should_discard_pool_after_error, QueryExecutionOptions};
use std::collections::HashMap;
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

const ORACLE_TABLE_COMMENT_BATCH_SIZE: usize = 500;

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
                enum_values: None,
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
    let pool_key = state.get_or_create_pool(connection_id, None).await?;
    let connections = state.connections.read().await;
    if let Some(PoolKind::Mysql(p, _)) = connections.get(&pool_key) {
        return db::mysql::list_doris_catalogs(p).await;
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
    let pool_key = state.get_or_create_pool(connection_id, None).await?;
    let db_config = connection_config(state, connection_id).await;
    let connections = state.connections.read().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;
    let PoolKind::Mysql(p, _) = pool else {
        return Ok(vec![]);
    };
    let databases = db::mysql::list_databases_show_from(p, catalog).await;
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
    if catalog == "internal" {
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
) -> Result<Vec<db::TableInfo>, String> {
    let pool_key = state.get_or_create_pool(connection_id, None).await?;
    let connections = state.connections.read().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;
    let PoolKind::Mysql(p, _) = pool else {
        return Ok(vec![]);
    };
    db::mysql::list_tables_show_from(p, catalog, database)
        .await
        .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types))
}

/// Columns of an external catalog table via `SHOW COLUMNS FROM <catalog>.<db>.<table>`.
pub async fn get_doris_catalog_columns_core(
    state: &AppState,
    connection_id: &str,
    catalog: &str,
    database: &str,
    table: &str,
) -> Result<Vec<db::ColumnInfo>, String> {
    let pool_key = state.get_or_create_pool(connection_id, None).await?;
    let connections = state.connections.read().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;
    let PoolKind::Mysql(p, _) = pool else {
        return Ok(vec![]);
    };
    db::mysql::get_columns_show_from(p, catalog, database, table).await.map(deduplicate_column_infos)
}

/// DDL for an external catalog table via `SHOW CREATE TABLE <catalog>.<db>.<table>`.
pub async fn get_doris_catalog_table_ddl_core(
    state: &AppState,
    connection_id: &str,
    catalog: &str,
    database: &str,
    table: &str,
) -> Result<String, String> {
    let pool_key = state.get_or_create_pool(connection_id, None).await?;
    let connections = state.connections.read().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;
    let PoolKind::Mysql(p, _) = pool else {
        return Err("DDL not supported for this connection".to_string());
    };
    db::mysql::show_create_table_ddl_from(p, catalog, database, table).await
}

/// Best-effort index listing for an external catalog table (derived from DDL).
pub async fn list_doris_catalog_indexes_core(
    state: &AppState,
    connection_id: &str,
    catalog: &str,
    database: &str,
    table: &str,
) -> Result<Vec<db::IndexInfo>, String> {
    let pool_key = state.get_or_create_pool(connection_id, None).await?;
    let connections = state.connections.read().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;
    let PoolKind::Mysql(p, _) = pool else {
        return Ok(vec![]);
    };
    db::mysql::list_doris_catalog_indexes(p, catalog, database, table).await
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
    if catalog.is_empty() || catalog == "internal" {
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
        #[cfg(feature = "duckdb-bundled")]
        if extract_pool!(&connections, connection_id, ExternalTabular).is_some() {
            return Ok(vec![db::DatabaseInfo { name: "main".to_string() }]);
        }
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
        #[cfg(feature = "duckdb-bundled")]
        PoolKind::DuckDbWorker(client) => {
            let client = client.clone();
            drop(connections);
            client.list_databases().await
        }
        _ => Ok(vec![]),
    }
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
    let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
    {
        let connections = state.connections.read().await;
        if let Some(PoolKind::Postgres(pool)) = connections.get(&pool_key) {
            return db::postgres::list_schema_infos(pool).await;
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
        let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
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
    let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
    let db_config = connection_config(state, connection_id).await;
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
                                return db::postgres::list_schemas(&pool).await.map(|schemas| {
                                    filter_visible_schema_names(schemas, visible_schema_filter.as_deref())
                                })
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
                            return db::postgres::list_schemas(&pool)
                                .await
                                .map(|schemas| filter_visible_schema_names(schemas, visible_schema_filter.as_deref()))
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
        PoolKind::Mysql(p, mode) if *mode == MysqlMode::OceanBaseOracle => db::ob_oracle::list_schemas(p)
            .await
            .map(|schemas| filter_visible_schema_names(schemas, visible_schema_filter.as_deref())),
        PoolKind::Postgres(p) => db::postgres::list_schemas(p)
            .await
            .map(|schemas| filter_visible_schema_names(schemas, visible_schema_filter.as_deref())),
        #[cfg(feature = "duckdb-bundled")]
        PoolKind::DuckDb(con) => {
            let duckdb_attached_names = duckdb_attached_database_names(state, connection_id).await;
            let con = con.lock().map_err(|e| e.to_string())?;
            duckdb_list_schemas_with_attached(&con, database, &duckdb_attached_names)
                .map(|schemas| filter_visible_schema_names(schemas, visible_schema_filter.as_deref()))
        }
        #[cfg(feature = "duckdb-bundled")]
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
) -> Result<Vec<db::TableInfo>, String> {
    retry_metadata_connection(state, connection_id, Some(database), || {
        list_tables_once(state, connection_id, database, schema, filter, limit, offset, object_types)
    })
    .await
}

/// List vector database collections, returning structured info (name, id, dimension).
/// Only works for PoolKind::VectorDb connections; returns an error for other types.
pub async fn list_vector_collections_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
) -> Result<Vec<db::vector_driver::CollectionInfo>, String> {
    let pool_key =
        state.get_or_create_pool(connection_id, if database.is_empty() { None } else { Some(database) }).await?;
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
    let pool_key =
        state.get_or_create_pool(connection_id, if database.is_empty() { None } else { Some(database) }).await?;
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
                                QueryExecutionOptions { max_rows: Some(1), ..Default::default() },
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

fn oracle_table_comments_from_query_result(result: db::QueryResult) -> HashMap<String, String> {
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
    format!(
        "SELECT c.COLUMN_NAME, c.DATA_TYPE, c.NULLABLE, c.DATA_DEFAULT, \
         c.DATA_LENGTH, c.DATA_PRECISION, c.DATA_SCALE, c.COLUMN_ID, \
         CASE WHEN cc.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PK, \
         cm.COMMENTS \
         FROM ALL_TAB_COLUMNS c \
         LEFT JOIN ( \
           SELECT cols.OWNER, cols.TABLE_NAME, cols.COLUMN_NAME \
           FROM ALL_CONS_COLUMNS cols \
           JOIN ALL_CONSTRAINTS con \
             ON con.CONSTRAINT_NAME = cols.CONSTRAINT_NAME \
            AND con.OWNER = cols.OWNER \
            AND con.CONSTRAINT_TYPE = 'P' \
         ) cc ON cc.OWNER = c.OWNER AND cc.TABLE_NAME = c.TABLE_NAME AND cc.COLUMN_NAME = c.COLUMN_NAME \
         LEFT JOIN ALL_COL_COMMENTS cm \
           ON cm.OWNER = c.OWNER AND cm.TABLE_NAME = c.TABLE_NAME AND cm.COLUMN_NAME = c.COLUMN_NAME \
         WHERE c.OWNER = {} AND c.TABLE_NAME = {} \
         ORDER BY c.COLUMN_ID",
        oracle_owner_filter(schema),
        sql_string(table),
    )
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
    let normalized = value.to_ascii_uppercase().replace(' ', "_").replace('-', "_");
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

fn apply_oracle_table_comments(tables: &mut [db::TableInfo], comments: &HashMap<String, String>) {
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
        comments.extend(oracle_table_comments_from_query_result(result));
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
    apply_oracle_table_comments(tables, &comments);
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
    client: Arc<tokio::sync::Mutex<db::agent_driver::AgentDriverClient>>,
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
        match oracle_agent_object_statistics_query(&mut client, database, schema, &sql, timeout_duration).await {
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

async fn oracle_agent_object_statistics_query(
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
                return external_driver_presto_like_tables(
                    session,
                    config.as_ref(),
                    database,
                    schema,
                    filter,
                    limit,
                    offset,
                )
                .await
                .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types));
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
                .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types));
        }
        #[cfg(feature = "duckdb-bundled")]
        if let Some(con) = extract_pool!(&connections, &pool_key, DuckDb) {
            drop(connections);
            let con = con.lock().map_err(|e| e.to_string())?;
            return duckdb_query_tables_in_database_with_attached(&con, database, schema, &duckdb_attached_names)
                .map(|tables| filter_table_infos(tables, filter, limit, offset, object_types));
        }
        #[cfg(feature = "duckdb-bundled")]
        if let Some(client) = extract_pool!(&connections, &pool_key, DuckDbWorker) {
            let database = database.to_string();
            let schema = schema.to_string();
            drop(connections);
            return client
                .list_tables(database, schema)
                .await
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
            let is_oracle = db_config.as_ref().is_some_and(|config| config.db_type == DatabaseType::Oracle);
            let use_oracle_agent_paging = db_config.as_ref().is_some_and(is_default_oracle_agent_config);
            let filter_locally_after_oracle_comments =
                is_oracle && filter.is_some_and(|filter| !filter.trim().is_empty());
            let timeout_duration = agent_metadata_timeout(db_config.as_ref());
            let fallback_config = db_config.clone();
            drop(connections);
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
                    let final_offset = if filter_locally_after_oracle_comments {
                        offset
                    } else if oracle_agent_paging_likely_applied(use_oracle_agent_paging, limit, tables.len()) {
                        Some(0)
                    } else {
                        offset
                    };
                    let tables = filter_table_infos(tables, filter, limit, final_offset, object_types);
                    return Ok(tables);
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
            if *mode == MysqlMode::OceanBaseOracle {
                let tables = db::ob_oracle::list_tables(p, schema).await?;
                Ok(filter_table_infos(tables, filter, limit, offset, object_types))
            } else {
                db::mysql::list_tables_filtered(
                    p,
                    mysql_table_metadata_catalog(database, schema),
                    filter,
                    limit,
                    offset,
                    object_types,
                )
                .await
                .map(|tables| filter_table_infos(tables, None, None, None, object_types))
            }
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
            .map(|infos| collection_names_to_tables(infos.into_iter().map(|i| i.name).collect(), "COLLECTION"))
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
    let filter = filter.unwrap_or("");
    let limit = limit.unwrap_or(usize::MAX);
    let offset = offset.unwrap_or(0);
    tables
        .into_iter()
        .filter(|table| metadata_name_or_comment_matches(&table.name, table.comment.as_deref(), filter))
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
        .map(|tables| filter_table_infos(tables, filter, None, None, object_types))?;
    Ok(tables
        .into_iter()
        .map(|table| db::ObjectInfo {
            name: table.name,
            object_type: table.table_type,
            schema: Some(schema.to_string()),
            signature: None,
            comment: table.comment,
            created_at: None,
            updated_at: None,
            parent_schema: table.parent_schema,
            parent_name: table.parent_name,
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
        clickhouse_metadata_database, deduplicate_column_infos, filter_mysql_system_databases_for_config,
        filter_object_infos, filter_table_infos, filter_visible_schema_names,
        is_agent_postgres_metadata_fallback_config, is_retryable_metadata_error, mysql_object_source_sql,
        mysql_table_metadata_catalog, normalize_information_schema_table_type, oracle_columns_from_query_result,
        oracle_columns_sql, oracle_object_statistics_dba_segments_sql, oracle_object_statistics_from_query_result,
        oracle_object_statistics_rows_only_sql, oracle_object_statistics_sql,
        oracle_object_statistics_user_segments_sql, oracle_table_comment_from_query_result, oracle_table_comment_sql,
        oracle_table_comments_from_query_result, oracle_table_comments_sql, presto_like_columns_from_query_result,
        presto_like_information_schema_columns_sql, presto_like_information_schema_tables_sql,
        presto_like_tables_from_query_result, visible_schema_filter,
    };
    #[cfg(feature = "duckdb-bundled")]
    use super::{
        duckdb_attach_database, duckdb_completion_assistant_search, duckdb_list_databases,
        duckdb_query_tables_in_database,
    };
    use crate::models::connection::{ConnectionConfig, DatabaseType};
    use std::collections::HashMap;

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
            agent_java_options: Vec::new(),
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
    fn mysql_table_child_metadata_prefers_schema_when_present() {
        assert_eq!(mysql_table_metadata_catalog("app_db", ""), "app_db");
        assert_eq!(mysql_table_metadata_catalog("app_db", "tenant_db"), "tenant_db");
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
    fn metadata_retry_recovers_missing_pool_only_as_transient_state() {
        assert!(is_retryable_metadata_error("Pool not found"));
        assert!(is_retryable_metadata_error("connection reset by peer"));
        assert!(is_retryable_metadata_error("Agent RPC error (-1): dm.jdbc.driver.DMException: 网络通信异常"));
        assert!(!is_retryable_metadata_error("Unknown column 'email' in 'field list'"));
        assert!(!is_retryable_metadata_error("Access denied for user"));
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
    fn oracle_agent_paging_detection_avoids_double_offset_only_when_page_sized() {
        assert!(super::oracle_agent_paging_likely_applied(true, Some(500), 500));
        assert!(super::oracle_agent_paging_likely_applied(true, Some(500), 120));
        assert!(!super::oracle_agent_paging_likely_applied(true, Some(500), 501));
        assert!(!super::oracle_agent_paging_likely_applied(false, Some(500), 120));
        assert!(!super::oracle_agent_paging_likely_applied(true, None, 120));
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

    fn test_object_info(name: &str, object_type: &str) -> super::db::ObjectInfo {
        super::db::ObjectInfo {
            name: name.to_string(),
            object_type: object_type.to_string(),
            schema: Some("app".to_string()),
            signature: None,
            comment: None,
            created_at: None,
            updated_at: None,
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
    fn filter_table_infos_matches_fuzzy_subsequences() {
        let tables = vec![test_table_info("system_user"), test_table_info("user_order"), test_table_info("alpha")];

        let system_user = filter_table_infos(tables.clone(), Some("sysu"), None, None, None);
        assert_eq!(system_user.into_iter().map(|table| table.name).collect::<Vec<_>>(), vec!["system_user"]);

        let user_order = filter_table_infos(tables, Some("uo"), None, None, None);
        assert_eq!(user_order.into_iter().map(|table| table.name).collect::<Vec<_>>(), vec!["user_order"]);
    }

    #[test]
    fn filter_table_infos_matches_comments() {
        let mut orders = test_table_info("orders");
        orders.comment = Some("sales archive".to_string());
        let mut profile = test_table_info("profile");
        profile.comment = Some("customer account data".to_string());
        let tables = vec![orders, profile, test_table_info("logs")];

        let filtered = filter_table_infos(tables, Some("account"), None, None, None);

        assert_eq!(filtered.into_iter().map(|table| table.name).collect::<Vec<_>>(), vec!["profile"]);
    }

    #[test]
    fn filter_table_infos_skips_fuzzy_for_single_character_filters() {
        let tables = vec![test_table_info("orders"), test_table_info("user_order")];

        let filtered = filter_table_infos(tables, Some("u"), None, None, None);

        assert_eq!(filtered.into_iter().map(|table| table.name).collect::<Vec<_>>(), vec!["user_order"]);
    }

    #[test]
    fn filter_table_infos_keeps_special_filter_characters_literal() {
        let tables = vec![test_table_info("user_%"), test_table_info("user_account"), test_table_info("userXpercent")];

        let filtered = filter_table_infos(tables, Some("user_%"), None, None, None);

        assert_eq!(filtered.into_iter().map(|table| table.name).collect::<Vec<_>>(), vec!["user_%"]);
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
            "Agent RPC error (-1): unknown method: completion_assistant_search_v1"
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
    fn oracle_table_comments_from_query_result_maps_non_blank_comments() {
        let result = db::QueryResult {
            columns: vec!["TABLE_NAME".to_string(), "COMMENTS".to_string()],
            column_types: Vec::new(),
            column_sortables: Vec::new(),
            rows: vec![
                vec![serde_json::json!("ORDERS"), serde_json::json!("Orders table")],
                vec![serde_json::json!("PRODUCTS"), serde_json::json!(" ")],
            ],
            affected_rows: 0,
            execution_time_ms: 0,
            truncated: false,
            session_id: None,
            has_more: false,
        };

        let comments = oracle_table_comments_from_query_result(result);
        assert_eq!(comments.get("ORDERS").map(String::as_str), Some("Orders table"));
        assert!(!comments.contains_key("PRODUCTS"));
    }

    #[test]
    fn oracle_columns_sql_uses_exact_table_name_for_quoted_lowercase_tables() {
        let sql = oracle_columns_sql("DBX_TEST", "test");

        assert!(sql.contains("ALL_TAB_COLUMNS"));
        assert!(sql.contains("ALL_COL_COMMENTS"));
        assert!(sql.contains("c.OWNER = 'DBX_TEST'"));
        assert!(sql.contains("c.TABLE_NAME = 'test'"));
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
    fn apply_oracle_table_comments_only_fills_missing_table_comments() {
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

        super::apply_oracle_table_comments(&mut tables, &comments);

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
                signature: None,
                comment: None,
                created_at: None,
                updated_at: None,
                parent_schema: None,
                parent_name: None,
            },
            super::db::ObjectInfo {
                name: "ORDERS_VIEW".to_string(),
                object_type: "VIEW".to_string(),
                schema: Some("DBX_TEST".to_string()),
                signature: None,
                comment: None,
                created_at: None,
                updated_at: None,
                parent_schema: None,
                parent_name: None,
            },
            super::db::ObjectInfo {
                name: "REFRESH_ORDERS".to_string(),
                object_type: "PROCEDURE".to_string(),
                schema: Some("DBX_TEST".to_string()),
                signature: None,
                comment: None,
                created_at: None,
                updated_at: None,
                parent_schema: None,
                parent_name: None,
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
    retry_metadata_connection(state, connection_id, Some(database), || async {
        let objects = list_objects_once(state, connection_id, database, schema, filter, limit, offset, object_types)
            .await
            .map(|objects| {
                let final_offset = if oracle_agent_paging_likely_applied(use_oracle_agent_paging, limit, objects.len())
                {
                    Some(0)
                } else {
                    offset
                };
                filter_object_infos(objects, filter, limit, final_offset, object_types)
            })?;
        Ok(objects)
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

async fn list_objects_once(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    filter: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
    object_types: Option<&[String]>,
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
                        signature: None,
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
                return external_driver_presto_like_objects(
                    session,
                    config.as_ref(),
                    database,
                    schema,
                    filter,
                    object_types,
                )
                .await;
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
                .await;
        }
        try_sqlserver!(connections, &pool_key, list_objects, schema);
        if let Some(client) = extract_pool!(&connections, &pool_key, Agent) {
            let is_oracle = db_config.as_ref().is_some_and(|config| config.db_type == DatabaseType::Oracle);
            let use_oracle_agent_paging = db_config.as_ref().is_some_and(is_default_oracle_agent_config);
            let filter_locally_after_oracle_comments =
                is_oracle && filter.is_some_and(|filter| !filter.trim().is_empty());
            let timeout_duration = agent_metadata_timeout(db_config.as_ref());
            let fallback_config = db_config.clone();
            drop(connections);
            if is_oracle && !use_oracle_agent_paging {
                return oracle_agent_list_objects(client, database, schema, timeout_duration).await;
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
                    return Ok(objects);
                }
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
                    signature: None,
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
            let objects = list_objects_once(state, connection_id, database, schema, None, None, None, None).await?;
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
        Err(error) if is_retryable_metadata_error(&error) => {
            state.reconnect_pool(connection_id, database).await?;
            operation().await
        }
        _ => result,
    }
}

fn is_retryable_metadata_error(error: &str) -> bool {
    error == "Pool not found" || crate::query::is_connection_error(error)
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
                if uses_presto_like_information_schema_tables(&config.db_type) {
                    return external_driver_presto_like_columns(session, config.as_ref(), database, schema, table).await;
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
                if columns.is_empty() && config.db_type == DatabaseType::Oracle {
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
            #[cfg(feature = "duckdb-bundled")]
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
                            if config.db_type == DatabaseType::Oracle {
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
                if *mode == MysqlMode::OceanBaseOracle {
                    db::ob_oracle::list_indexes(p, schema, table).await
                } else if db_config.as_ref().is_some_and(is_doris_family_config) {
                    db::mysql::list_doris_family_indexes(p, mysql_table_metadata_catalog(database, schema), table).await
                } else {
                    db::mysql::list_indexes(p, mysql_table_metadata_catalog(database, schema), table).await
                }
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
                if *mode == MysqlMode::OceanBaseOracle {
                    db::ob_oracle::list_foreign_keys(p, schema, table).await
                } else {
                    db::mysql::list_foreign_keys(p, mysql_table_metadata_catalog(database, schema), table).await
                }
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
                if *mode == MysqlMode::OceanBaseOracle {
                    db::ob_oracle::list_triggers(p, schema, table).await
                } else {
                    db::mysql::list_triggers(p, mysql_table_metadata_catalog(database, schema), table).await
                }
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

pub async fn list_extensions_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
) -> Result<Vec<db::ExtensionInfo>, String> {
    retry_metadata_connection(state, connection_id, Some(database), || async {
        let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
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
        let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
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
    if matches!(object_type, Some(db::ObjectSourceKind::MaterializedView)) {
        let source = get_object_source_core(
            state,
            connection_id,
            database,
            schema,
            table,
            db::ObjectSourceKind::MaterializedView,
        )
        .await?;
        return Ok(source.source);
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

fn is_default_oracle_agent_config(config: &ConnectionConfig) -> bool {
    // Only the default go-oracle agent handles filtered/paged metadata; legacy profiles keep Rust fallback paging.
    matches!(config.db_type, DatabaseType::Oracle)
        && !matches!(config.driver_profile.as_deref(), Some("oracle-legacy" | "oracle-10g"))
}

fn oracle_agent_paging_likely_applied(enabled: bool, limit: Option<usize>, returned_len: usize) -> bool {
    enabled && limit.is_some_and(|limit| returned_len <= limit)
}

fn is_doris_family_config(config: &ConnectionConfig) -> bool {
    matches!(config.db_type, DatabaseType::Doris | DatabaseType::StarRocks | DatabaseType::ManticoreSearch)
        || matches!(config.driver_profile.as_deref(), Some("doris" | "selectdb" | "starrocks" | "manticoresearch"))
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
    postgres_object_source_sql_inner(schema, name, kind, true)
}

fn postgres_object_source_sql_without_relispopulated(schema: &str, name: &str, kind: &db::ObjectSourceKind) -> String {
    postgres_object_source_sql_inner(schema, name, kind, false)
}

fn postgres_function_object_source_sql_without_prokind(schema: &str, name: &str) -> String {
    format!(
        "SELECT pg_get_functiondef(p.oid) \
         FROM pg_proc p \
         JOIN pg_namespace n ON n.oid = p.pronamespace \
         WHERE n.nspname = {} AND p.proname = {} AND NOT p.proisagg AND NOT p.proiswindow \
         ORDER BY p.oid LIMIT 1",
        sql_string(schema),
        sql_string(name)
    )
}

fn postgres_object_source_sql_inner(
    schema: &str,
    name: &str,
    kind: &db::ObjectSourceKind,
    include_relispopulated: bool,
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

pub fn mysql_object_source_sql(database: &str, name: &str, kind: &db::ObjectSourceKind) -> String {
    let qualified_name = mysql_qualified_name(database, name);
    match kind {
        db::ObjectSourceKind::View => format!("SHOW CREATE VIEW {qualified_name}"),
        db::ObjectSourceKind::Procedure => format!("SHOW CREATE PROCEDURE {qualified_name}"),
        db::ObjectSourceKind::Function => format!("SHOW CREATE FUNCTION {qualified_name}"),
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
    database: &str,
    name: &str,
    kind: &db::ObjectSourceKind,
) -> Result<String, String> {
    use mysql_async::prelude::*;
    let sql = mysql_object_source_sql(database, name, kind);
    let mut conn = db::mysql::get_conn_with_timeout(pool, db::connection_timeout()).await?;
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
        editable: None,
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
                signature: None,
                comment: None,
                created_at: None,
                updated_at: None,
                parent_schema: None,
                parent_name: None,
            })
        })
        .collect();
    load_oracle_table_comments_for_objects(&mut client, database, schema, &mut objects, timeout_duration).await?;
    Ok(objects)
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

async fn oracle_agent_table_ddl(
    client: Arc<tokio::sync::Mutex<db::agent_driver::AgentDriverClient>>,
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
    client: Arc<tokio::sync::Mutex<db::agent_driver::AgentDriverClient>>,
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
) -> Result<String, String> {
    let sql = postgres_object_source_sql(schema, name, object_type);
    match db::postgres::execute_query(pool, &sql).await.and_then(first_string_cell) {
        Ok(source) => Ok(source),
        Err(primary_err)
            if postgres_missing_relispopulated_error(&primary_err)
                && matches!(object_type, db::ObjectSourceKind::View | db::ObjectSourceKind::MaterializedView) =>
        {
            let fallback_sql = postgres_object_source_sql_without_relispopulated(schema, name, object_type);
            db::postgres::execute_query(pool, &fallback_sql)
                .await
                .and_then(first_string_cell)
                .map_err(|fallback_err| format!("{primary_err}; relispopulated fallback failed: {fallback_err}"))
        }
        Err(primary_err)
            if postgres_missing_prokind_error(&primary_err)
                && matches!(object_type, db::ObjectSourceKind::Function) =>
        {
            let fallback_sql = postgres_function_object_source_sql_without_prokind(schema, name);
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

    #[test]
    fn builds_sqlserver_object_source_sql_for_schema_scoped_routines() {
        assert_eq!(
            sqlserver_object_source_sql("dbo", "refresh_cache", &ObjectSourceKind::Procedure),
            "SELECT m.definition FROM sys.sql_modules m JOIN sys.objects o ON o.object_id = m.object_id JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = 'dbo' AND o.name = 'refresh_cache' AND o.type IN ('P')"
        );
    }

    #[test]
    fn builds_postgres_object_source_sql_for_views_and_functions() {
        let view_sql = postgres_object_source_sql("public", "active_users", &ObjectSourceKind::View);

        assert!(view_sql.contains("CREATE MATERIALIZED VIEW"));
        assert!(view_sql.contains("CREATE OR REPLACE VIEW"));
        assert!(view_sql.contains("CASE WHEN c.relispopulated THEN ' WITH DATA' ELSE ' WITH NO DATA' END"));
        assert!(view_sql.contains("n.nspname = 'public'"));
        assert!(view_sql.contains("c.relname = 'active_users'"));

        assert_eq!(
            postgres_object_source_sql("public", "recalc_score", &ObjectSourceKind::Function),
            "SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'recalc_score' AND p.prokind = 'f' ORDER BY p.oid LIMIT 1"
        );
    }

    #[test]
    fn builds_postgres_object_source_sql_without_relispopulated_for_legacy_catalogs() {
        let sql = postgres_object_source_sql_without_relispopulated(
            "public",
            "active_users",
            &ObjectSourceKind::MaterializedView,
        );

        assert!(sql.contains("CREATE MATERIALIZED VIEW"));
        assert!(sql.contains("pg_get_viewdef(c.oid, 0)"));
        assert!(!sql.contains("relispopulated"));
    }

    #[test]
    fn builds_postgres_function_source_sql_without_prokind_for_legacy_catalogs() {
        let sql = postgres_function_object_source_sql_without_prokind("public", "recalc_score");

        assert_eq!(
            sql,
            "SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'recalc_score' AND NOT p.proisagg AND NOT p.proiswindow ORDER BY p.oid LIMIT 1"
        );
    }

    #[test]
    fn keeps_legacy_materialized_viewdef_when_it_already_contains_create_statement() {
        let sql = postgres_object_source_sql("public", "active_users", &ObjectSourceKind::MaterializedView);

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
    fn postgres_table_ddl_includes_generated_identity() {
        let mut id = column("id", "integer");
        id.is_nullable = false;
        id.is_primary_key = true;
        id.extra = Some("generated by default as identity".to_string());

        let ddl = render_postgres_table_ddl("public", "users", &[id], &[], &[]);

        assert!(ddl.contains("\"id\" integer generated by default as identity NOT NULL"), "ddl: {ddl}");
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

        let ddl = render_postgres_table_ddl("public", "aaa_1", &columns, &[], &foreign_keys);

        assert!(ddl.contains(
            "CONSTRAINT \"aaa_1\" FOREIGN KEY (\"a\", \"b\", \"c\") REFERENCES \"aaa_2\"(\"a\", \"b\", \"c\")"
        ));
        assert_eq!(ddl.matches("CONSTRAINT \"aaa_1\" FOREIGN KEY").count(), 1);
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
    fn sqlserver_table_ddl_includes_identity_clause() {
        let mut id = column("FIDS", "int");
        id.is_nullable = false;
        id.is_primary_key = true;
        id.extra = Some("identity(1,1)".to_string());

        let ddl = render_sqlserver_table_ddl("dbo", "ZHLSBS", &[id], &[], &[]);

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
}

pub async fn mysql_ddl(pool: &db::mysql::MySqlPool, database: &str, table: &str) -> Result<String, String> {
    use mysql_async::prelude::*;
    let sql = format!("SHOW CREATE TABLE {}", mysql_qualified_name(database, table));
    // Use the health-checked getter so a stale pooled connection (server closed
    // it after an idle timeout, NAT/firewall dropped the TCP state, etc.) is
    // detected and replaced before issuing the query. Without this, the first
    // DDL request after a period of inactivity could surface a low-level
    // connection error that a manual refresh would have masked.
    let mut conn = db::mysql::get_conn_with_health_check(pool).await?;
    let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;
    let row = rows.first().ok_or("DDL not found")?;
    let ddl = row
        .get_opt::<String, usize>(1)
        .and_then(|result| result.ok())
        .or_else(|| {
            row.get_opt::<Vec<u8>, usize>(1)
                .and_then(|result| result.ok())
                .map(|b| String::from_utf8_lossy(&b).to_string())
        })
        .ok_or_else(|| "Failed to read DDL".to_string())?;
    Ok(ensure_display_ddl_terminated(ddl))
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
        .collect();
    ddl.push_str(&col_lines.join(",\n"));

    let pks: Vec<&str> = columns.iter().filter(|c| c.is_primary_key).map(|c| c.name.as_str()).collect();
    if !pks.is_empty() {
        ddl.push_str(&format!(",\n  PRIMARY KEY ({})", pks.iter().map(|k| pg_ident(k)).collect::<Vec<_>>().join(", ")));
    }
    for fk_group in group_foreign_keys_by_name(fkeys) {
        let Some(first_fk) = fk_group.first() else {
            continue;
        };
        let columns = fk_group.iter().map(|fk| pg_ident(&fk.column)).collect::<Vec<_>>().join(", ");
        let ref_columns = fk_group.iter().map(|fk| pg_ident(&fk.ref_column)).collect::<Vec<_>>().join(", ");
        ddl.push_str(&format!(
            ",\n  CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {}({})",
            pg_ident(&first_fk.name),
            columns,
            pg_ident(&first_fk.ref_table),
            ref_columns
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
