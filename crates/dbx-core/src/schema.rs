use crate::connection::{AppState, MysqlMode, PoolKind};
use crate::db;
use crate::models::connection::{ConnectionConfig, DatabaseType};
use std::future::Future;

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

macro_rules! try_agent {
    ($connections:expr, $pool_key:expr, $method:ident $(, $arg:expr)*) => {
        if let Some(client) = extract_pool!(&$connections, $pool_key, Agent) {
            drop($connections);
            let mut client = client.lock().await;
            return client.$method($($arg),*).await;
        }
    };
}

pub fn duckdb_query_tables(con: &duckdb::Connection) -> Result<Vec<db::TableInfo>, String> {
    duckdb_query_tables_in_database(con, "main", "main")
}

pub fn duckdb_query_tables_in_database(
    con: &duckdb::Connection,
    database: &str,
    schema: &str,
) -> Result<Vec<db::TableInfo>, String> {
    duckdb_query_tables_in_database_with_attached(con, database, schema, &[])
}

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

pub fn duckdb_attach_database(con: &duckdb::Connection, name: &str, path: &str) -> Result<(), String> {
    let name = name.trim();
    let path = path.trim();
    if name.is_empty() || path.is_empty() {
        return Err("DuckDB attached database name and path are required".to_string());
    }
    let sql = format!("ATTACH {} AS {}", duckdb_quote_string(path), duckdb_quote_ident(name));
    con.execute_batch(&sql).map_err(|e| e.to_string())
}

pub fn duckdb_list_databases(con: &duckdb::Connection) -> Result<Vec<db::DatabaseInfo>, String> {
    duckdb_list_databases_with_attached(con, &[])
}

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

pub fn duckdb_list_schemas(con: &duckdb::Connection, database: &str) -> Result<Vec<String>, String> {
    duckdb_list_schemas_with_attached(con, database, &[])
}

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

fn duckdb_catalog_name(con: &duckdb::Connection, database: &str, attached_names: &[String]) -> Result<String, String> {
    if database.trim().is_empty() || database == "main" {
        return duckdb_primary_catalog(con, attached_names);
    }
    Ok(database.to_string())
}

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

fn duckdb_current_database(con: &duckdb::Connection) -> Result<String, String> {
    con.query_row("SELECT current_database()", [], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())
}

fn duckdb_quote_ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn duckdb_quote_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

pub fn duckdb_query_columns(con: &duckdb::Connection, table: &str) -> Result<Vec<db::ColumnInfo>, String> {
    duckdb_query_columns_in_database(con, "main", "main", table)
}

pub fn duckdb_query_columns_in_database(
    con: &duckdb::Connection,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<db::ColumnInfo>, String> {
    duckdb_query_columns_in_database_with_attached(con, database, schema, table, &[])
}

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

pub async fn list_databases_core(state: &AppState, connection_id: &str) -> Result<Vec<db::DatabaseInfo>, String> {
    retry_metadata_connection(state, connection_id, None, || list_databases_once(state, connection_id)).await
}

async fn list_databases_once(state: &AppState, connection_id: &str) -> Result<Vec<db::DatabaseInfo>, String> {
    log::info!("[list_databases] connection_id={connection_id}");
    {
        let connections = state.connections.read().await;
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
            return client.list_databases().await;
        }
    }

    let duckdb_attached_names = duckdb_attached_database_names(state, connection_id).await;
    let connections = state.connections.read().await;
    let pool = connections.get(connection_id).ok_or("Connection not found")?;

    match pool {
        PoolKind::Mysql(p, mode) => dispatch_mysql!(p, mode, db::mysql::list_databases, db::ob_oracle::list_databases),
        PoolKind::Postgres(p) => db::postgres::list_databases(p).await,
        PoolKind::Sqlite(p) => db::sqlite::list_databases(p).await,
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

async fn list_schemas_once(state: &AppState, connection_id: &str, database: &str) -> Result<Vec<String>, String> {
    let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;

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
        try_agent!(connections, &pool_key, list_schemas, database);
    }

    let connections = state.connections.read().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;

    match pool {
        PoolKind::Postgres(p) => db::postgres::list_schemas(p).await,
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
) -> Result<Vec<db::TableInfo>, String> {
    retry_metadata_connection(state, connection_id, Some(database), || {
        list_tables_once(state, connection_id, database, schema, filter, limit)
    })
    .await
}

async fn list_tables_once(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    filter: Option<&str>,
    limit: Option<usize>,
) -> Result<Vec<db::TableInfo>, String> {
    let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
    let duckdb_attached_names = duckdb_attached_database_names(state, connection_id).await;

    {
        let connections = state.connections.read().await;
        if let Some(ext_pool) = extract_pool!(&connections, &pool_key, ExternalTabular) {
            drop(connections);
            let cache = ext_pool.cache.clone();
            return tokio::task::spawn_blocking(move || {
                let con = cache.lock().map_err(|e| e.to_string())?;
                duckdb_query_tables(&con)
            })
            .await
            .map_err(|e| e.to_string())?;
        }
        if let Some(PoolKind::ExternalDriver { config, session, .. }) = connections.get(&pool_key) {
            let config = config.clone();
            let session = session.clone();
            drop(connections);
            return session
                .invoke::<Vec<db::TableInfo>>(
                    "listTables",
                    serde_json::json!({ "connection": config.as_ref(), "database": database, "schema": schema }),
                )
                .await;
        }
        if let Some(con) = extract_pool!(&connections, &pool_key, DuckDb) {
            drop(connections);
            let con = con.lock().map_err(|e| e.to_string())?;
            return duckdb_query_tables_in_database_with_attached(&con, database, schema, &duckdb_attached_names);
        }
        if let Some(client) = extract_pool!(&connections, &pool_key, ClickHouse) {
            drop(connections);
            return db::clickhouse_driver::list_tables(&client, clickhouse_metadata_database(database, schema)).await;
        }
        try_sqlserver!(connections, &pool_key, list_tables, schema, filter, limit);
        try_agent!(connections, &pool_key, list_tables, database, schema);
    }

    let connections = state.connections.read().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;

    match pool {
        PoolKind::Mysql(p, mode) => {
            dispatch_mysql!(p, mode, db::mysql::list_tables, db::ob_oracle::list_tables, schema)
                .map(|tables| filter_table_infos(tables, filter, limit))
        }
        PoolKind::Postgres(p) => {
            db::postgres::list_tables(p, schema).await.map(|tables| filter_table_infos(tables, filter, limit))
        }
        PoolKind::Sqlite(p) => {
            db::sqlite::list_tables(p, schema).await.map(|tables| filter_table_infos(tables, filter, limit))
        }
        PoolKind::MongoDb(client) => db::mongo_driver::list_collections(client, database)
            .await
            .map(|names| collection_names_to_tables(names, "COLLECTION"))
            .map(|tables| filter_table_infos(tables, filter, limit)),
        PoolKind::Elasticsearch(client) => db::elasticsearch_driver::list_indices(client)
            .await
            .map(|names| collection_names_to_tables(names, "INDEX"))
            .map(|tables| filter_table_infos(tables, filter, limit)),
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

fn filter_table_infos(tables: Vec<db::TableInfo>, filter: Option<&str>, limit: Option<usize>) -> Vec<db::TableInfo> {
    let filter = filter.unwrap_or("").to_lowercase();
    let limit = limit.unwrap_or(usize::MAX);
    tables
        .into_iter()
        .filter(|table| filter.is_empty() || table.name.to_lowercase().contains(&filter))
        .take(limit)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        clickhouse_metadata_database, duckdb_attach_database, duckdb_list_databases, duckdb_query_tables_in_database,
    };

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

    #[test]
    fn clickhouse_metadata_uses_schema_when_database_is_empty() {
        assert_eq!(clickhouse_metadata_database("", "testdb"), "testdb");
        assert_eq!(clickhouse_metadata_database("testdb", ""), "testdb");
        assert_eq!(clickhouse_metadata_database("default", "testdb"), "default");
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

async fn list_objects_once(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
) -> Result<Vec<db::ObjectInfo>, String> {
    let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;

    {
        let connections = state.connections.read().await;
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
            return session
                .invoke::<Vec<db::ObjectInfo>>(
                    "listObjects",
                    serde_json::json!({ "connection": config.as_ref(), "database": database, "schema": schema }),
                )
                .await;
        }
        try_sqlserver!(connections, &pool_key, list_objects, schema);
        try_agent!(connections, &pool_key, list_objects, database, schema);
    }

    let connections = state.connections.read().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;

    match pool {
        PoolKind::Mysql(p, mode) => {
            // Note: mysql and ob_oracle take different second args (database vs schema)
            if *mode == MysqlMode::OceanBaseOracle {
                db::ob_oracle::list_objects(p, schema).await
            } else {
                db::mysql::list_objects(p, database).await
            }
        }
        PoolKind::Postgres(p) => db::postgres::list_objects(p, schema).await,
        _ => {
            drop(connections);
            Ok(list_tables_core(state, connection_id, database, schema, None, None)
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
    let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
    let duckdb_attached_names = duckdb_attached_database_names(state, connection_id).await;

    {
        let connections = state.connections.read().await;
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
            return session
                .invoke::<Vec<db::ColumnInfo>>(
                    "getColumns",
                    serde_json::json!({
                        "connection": config.as_ref(),
                        "database": database,
                        "schema": schema,
                        "table": table,
                    }),
                )
                .await;
        }
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
                .await;
        }
        try_sqlserver!(connections, &pool_key, get_columns, schema, table);
        try_agent!(connections, &pool_key, get_columns, database, schema, table);
    }

    let connections = state.connections.read().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;

    match pool {
        PoolKind::Mysql(p, mode) => {
            dispatch_mysql!(p, mode, db::mysql::get_columns, db::ob_oracle::get_columns, database, table)
        }
        PoolKind::Postgres(p) => db::postgres::get_columns(p, schema, table).await,
        PoolKind::Sqlite(p) => db::sqlite::get_columns(p, schema, table).await,
        _ => Ok(vec![]),
    }
}

pub async fn list_indexes_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<db::IndexInfo>, String> {
    let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;

    {
        let connections = state.connections.read().await;
        try_sqlserver!(connections, &pool_key, list_indexes, schema, table);
        try_agent!(connections, &pool_key, list_indexes, database, schema, table);
    }

    let connections = state.connections.read().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;

    match pool {
        PoolKind::Mysql(p, mode) => {
            dispatch_mysql!(p, mode, db::mysql::list_indexes, db::ob_oracle::list_indexes, schema, table)
        }
        PoolKind::Postgres(p) => db::postgres::list_indexes(p, schema, table).await,
        PoolKind::Sqlite(p) => db::sqlite::list_indexes(p, schema, table).await,
        _ => Ok(vec![]),
    }
}

pub async fn list_foreign_keys_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<db::ForeignKeyInfo>, String> {
    let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;

    {
        let connections = state.connections.read().await;
        try_sqlserver!(connections, &pool_key, list_foreign_keys, schema, table);
        try_agent!(connections, &pool_key, list_foreign_keys, database, schema, table);
    }

    let connections = state.connections.read().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;

    match pool {
        PoolKind::Mysql(p, mode) => {
            dispatch_mysql!(p, mode, db::mysql::list_foreign_keys, db::ob_oracle::list_foreign_keys, schema, table)
        }
        PoolKind::Postgres(p) => db::postgres::list_foreign_keys(p, schema, table).await,
        PoolKind::Sqlite(p) => db::sqlite::list_foreign_keys(p, schema, table).await,
        _ => Ok(vec![]),
    }
}

pub async fn list_triggers_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<db::TriggerInfo>, String> {
    let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;

    {
        let connections = state.connections.read().await;
        try_sqlserver!(connections, &pool_key, list_triggers, schema, table);
        try_agent!(connections, &pool_key, list_triggers, database, schema, table);
    }

    let connections = state.connections.read().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;

    match pool {
        PoolKind::Mysql(p, mode) => {
            dispatch_mysql!(p, mode, db::mysql::list_triggers, db::ob_oracle::list_triggers, schema, table)
        }
        PoolKind::Postgres(p) => db::postgres::list_triggers(p, schema, table).await,
        PoolKind::Sqlite(p) => db::sqlite::list_triggers(p, schema, table).await,
        _ => Ok(vec![]),
    }
}

pub async fn get_table_ddl_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<String, String> {
    let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;

    {
        let connections = state.connections.read().await;
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
        try_agent!(connections, &pool_key, get_table_ddl, database, schema, table);
    }

    let connections = state.connections.read().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;
    let db_config = connection_config(state, connection_id).await;

    match pool {
        PoolKind::Mysql(p, _) => mysql_ddl(p, table).await,
        PoolKind::Postgres(p) if db_config.as_ref().is_some_and(is_opengauss_family_config) => {
            match opengauss_table_ddl(p, schema, table).await {
                Ok(ddl) => Ok(ddl),
                Err(_) => pg_ddl(p, schema, table).await,
            }
        }
        PoolKind::Postgres(p) => pg_ddl(p, schema, table).await,
        PoolKind::Sqlite(p) => sqlite_ddl(p, table).await,
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

fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn pg_ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn mysql_ident(value: &str) -> String {
    format!("`{}`", value.replace('`', "``"))
}

fn sqlite_object_type(kind: &db::ObjectSourceKind) -> &'static str {
    match kind {
        db::ObjectSourceKind::View => "view",
        db::ObjectSourceKind::Procedure | db::ObjectSourceKind::Function => "routine",
    }
}

fn sqlserver_object_type_filter(kind: &db::ObjectSourceKind) -> &'static str {
    match kind {
        db::ObjectSourceKind::View => "'V'",
        db::ObjectSourceKind::Procedure => "'P'",
        db::ObjectSourceKind::Function => "'FN','IF','TF','FS','FT'",
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
        db::ObjectSourceKind::View => {
            format!(
                "SELECT pg_get_viewdef(c.oid, 0) \
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
    }
}

pub fn oracle_object_source_sql(schema: &str, name: &str, kind: &db::ObjectSourceKind) -> String {
    let object_type = match kind {
        db::ObjectSourceKind::View => "VIEW",
        db::ObjectSourceKind::Procedure => "PROCEDURE",
        db::ObjectSourceKind::Function => "FUNCTION",
    };
    format!(
        "SELECT DBMS_METADATA.GET_DDL({}, {}, {}) FROM DUAL",
        sql_string(object_type),
        sql_string(name),
        sql_string(schema)
    )
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
    let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
    let source = {
        let connections = state.connections.read().await;
        if let Some(client) = extract_pool!(&connections, &pool_key, SqlServer) {
            drop(connections);
            let mut client = client.lock().await;
            first_string_cell(
                db::sqlserver::execute_query(&mut client, &sqlserver_object_source_sql(schema, name, &object_type))
                    .await?,
            )?
        } else if let Some(client) = extract_pool!(&connections, &pool_key, Agent) {
            drop(connections);
            let mut client = client.lock().await;
            let result: db::ObjectSource = client.get_object_source(database, schema, name, &object_type).await?;
            return Ok(result);
        } else {
            match connections.get(&pool_key).ok_or("Pool not found")? {
                PoolKind::Mysql(pool, _) => mysql_object_source(pool, name, &object_type).await?,
                PoolKind::Postgres(pool) => postgres_object_source(pool, schema, name, &object_type).await?,
                PoolKind::Sqlite(pool) => first_string_cell(
                    db::sqlite::execute_query(pool, &sqlite_object_source_sql(name, &object_type)).await?,
                )?,
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
            "SELECT pg_get_viewdef(c.oid, 0) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'active_users' AND c.relkind IN ('v','m') ORDER BY c.oid LIMIT 1"
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

fn render_postgres_table_ddl(
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

    let mut ddl = format!("CREATE TABLE [{schema}].[{table}] (\n");
    let col_lines: Vec<String> = columns
        .iter()
        .map(|c| {
            let mut line = format!("  [{}] {}", c.name, c.data_type);
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
            pks.iter().map(|k| format!("[{k}]")).collect::<Vec<_>>().join(", ")
        ));
    }
    for fk in &fkeys {
        ddl.push_str(&format!(
            ",\n  CONSTRAINT [{}] FOREIGN KEY ([{}]) REFERENCES [{}]([{}])",
            fk.name, fk.column, fk.ref_table, fk.ref_column
        ));
    }
    ddl.push_str("\n);\n");

    for idx in &indexes {
        if idx.is_primary {
            continue;
        }
        let unique = if idx.is_unique { "UNIQUE " } else { "" };
        let idx_type = idx.index_type.as_deref().map(|t| format!("{t} ")).unwrap_or_default();
        let cols = idx.columns.iter().map(|c| format!("[{c}]")).collect::<Vec<_>>().join(", ");
        let include = idx
            .included_columns
            .as_deref()
            .filter(|c| !c.is_empty())
            .map(|cols| format!(" INCLUDE ({})", cols.iter().map(|c| format!("[{c}]")).collect::<Vec<_>>().join(", ")))
            .unwrap_or_default();
        let filter = idx.filter.as_deref().map(|f| format!(" WHERE {f}")).unwrap_or_default();
        ddl.push_str(&format!(
            "\nCREATE {unique}{idx_type}INDEX [{}] ON [{schema}].[{table}] ({cols}){include}{filter};",
            idx.name
        ));
    }
    Ok(ddl)
}
