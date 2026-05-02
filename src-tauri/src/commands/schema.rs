use std::sync::Arc;
use tauri::State;

use crate::commands::connection::{AppState, PoolKind};
use crate::db;

fn duckdb_query_tables(con: &duckdb::Connection) -> Result<Vec<db::TableInfo>, String> {
    let mut stmt = con.prepare(
        "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        Ok(db::TableInfo {
            name: row.get::<_, String>(0)?,
            table_type: row.get::<_, String>(1)?,
        })
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

fn duckdb_query_columns(con: &duckdb::Connection, table: &str) -> Result<Vec<db::ColumnInfo>, String> {
    let mut pk_stmt = con.prepare(
        "SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
          AND tc.table_name = kcu.table_name
         WHERE tc.constraint_type = 'PRIMARY KEY'
           AND tc.table_schema = 'main'
           AND tc.table_name = ?
         ORDER BY kcu.ordinal_position"
    ).map_err(|e| e.to_string())?;
    let pk_rows = pk_stmt.query_map([table], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let primary_keys: std::collections::HashSet<String> = pk_rows.filter_map(|r| r.ok()).collect();

    let mut stmt = con.prepare(
        "SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = 'main' AND table_name = ?
         ORDER BY ordinal_position"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([table], |row| {
        let name = row.get::<_, String>(0)?;
        Ok(db::ColumnInfo {
            is_primary_key: primary_keys.contains(&name),
            name,
            data_type: row.get::<_, String>(1)?,
            is_nullable: row.get::<_, String>(2).unwrap_or_default() == "YES",
            column_default: row.get::<_, Option<String>>(3)?,
            extra: None, comment: None,
            numeric_precision: None,
            numeric_scale: None,
        })
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

fn extract_duckdb(connections: &std::collections::HashMap<String, PoolKind>, key: &str) -> Option<std::sync::Arc<std::sync::Mutex<duckdb::Connection>>> {
    match connections.get(key)? {
        PoolKind::DuckDb(con) => Some(con.clone()),
        _ => None,
    }
}

fn extract_sqlserver(connections: &std::collections::HashMap<String, PoolKind>, key: &str) -> Option<std::sync::Arc<tokio::sync::Mutex<db::sqlserver::SqlServerClient>>> {
    match connections.get(key)? {
        PoolKind::SqlServer(client) => Some(client.clone()),
        _ => None,
    }
}

fn extract_clickhouse(connections: &std::collections::HashMap<String, PoolKind>, key: &str) -> Option<db::clickhouse_driver::ChClient> {
    match connections.get(key)? {
        PoolKind::ClickHouse(client) => Some(client.clone()),
        _ => None,
    }
}

fn extract_oracle(connections: &std::collections::HashMap<String, PoolKind>, key: &str) -> Option<std::sync::Arc<tokio::sync::Mutex<db::oracle_driver::OracleClient>>> {
    match connections.get(key)? {
        PoolKind::Oracle(client) => Some(client.clone()),
        _ => None,
    }
}

#[tauri::command]
pub async fn list_databases(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Vec<db::DatabaseInfo>, String> {
    {
        let connections = state.connections.lock().await;
        if let Some(client) = extract_clickhouse(&connections, &connection_id) {
            drop(connections);
            return db::clickhouse_driver::list_databases(&client).await;
        }
        if let Some(client) = extract_sqlserver(&connections, &connection_id) {
            drop(connections);
            let mut client = client.lock().await;
            return db::sqlserver::list_databases(&mut client).await;
        }
        if let Some(client) = extract_oracle(&connections, &connection_id) {
            drop(connections);
            let client = client.lock().await;
            return db::oracle_driver::list_databases(&*client).await;
        }
    }

    let connections = state.connections.lock().await;
    let pool = connections.get(&connection_id).ok_or("Connection not found")?;

    match pool {
        PoolKind::Mysql(p) => db::mysql::list_databases(p).await,
        PoolKind::Postgres(p) => db::postgres::list_databases(p).await,
        PoolKind::Sqlite(p) => db::sqlite::list_databases(p).await,
        PoolKind::DuckDb(_) => Ok(vec![db::DatabaseInfo { name: "main".to_string() }]),
        _ => Ok(vec![]),
    }
}

#[tauri::command]
pub async fn list_schemas(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
) -> Result<Vec<String>, String> {
    let pool_key = state.get_or_create_pool(&connection_id, Some(&database)).await?;

    {
        let connections = state.connections.lock().await;
        if let Some(client) = extract_sqlserver(&connections, &pool_key) {
            drop(connections);
            let mut client = client.lock().await;
            return db::sqlserver::list_schemas(&mut client).await;
        }
        if let Some(client) = extract_oracle(&connections, &pool_key) {
            drop(connections);
            let client = client.lock().await;
            return db::oracle_driver::list_schemas(&*client).await;
        }
    }

    let connections = state.connections.lock().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;

    match pool {
        PoolKind::Postgres(p) => db::postgres::list_schemas(p).await,
        _ => Ok(vec![]),
    }
}

#[tauri::command]
pub async fn list_tables(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
) -> Result<Vec<db::TableInfo>, String> {
    let pool_key = state.get_or_create_pool(&connection_id, Some(&database)).await?;

    {
        let connections = state.connections.lock().await;
        if let Some(con) = extract_duckdb(&connections, &pool_key) {
            drop(connections);
            let con = con.lock().map_err(|e| e.to_string())?;
            return duckdb_query_tables(&con);
        }
        if let Some(client) = extract_clickhouse(&connections, &pool_key) {
            drop(connections);
            return db::clickhouse_driver::list_tables(&client, &database).await;
        }
        if let Some(client) = extract_sqlserver(&connections, &pool_key) {
            drop(connections);
            let mut client = client.lock().await;
            return db::sqlserver::list_tables(&mut client, &schema).await;
        }
        if let Some(client) = extract_oracle(&connections, &pool_key) {
            drop(connections);
            let client = client.lock().await;
            return db::oracle_driver::list_tables(&*client, &schema).await;
        }
    }

    let connections = state.connections.lock().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;

    match pool {
        PoolKind::Mysql(p) => db::mysql::list_tables(p, &schema).await,
        PoolKind::Postgres(p) => db::postgres::list_tables(p, &schema).await,
        PoolKind::Sqlite(p) => db::sqlite::list_tables(p, &schema).await,
        _ => Ok(vec![]),
    }
}

#[tauri::command]
pub async fn get_columns(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
) -> Result<Vec<db::ColumnInfo>, String> {
    let pool_key = state.get_or_create_pool(&connection_id, Some(&database)).await?;

    {
        let connections = state.connections.lock().await;
        if let Some(con) = extract_duckdb(&connections, &pool_key) {
            drop(connections);
            let con = con.lock().map_err(|e| e.to_string())?;
            return duckdb_query_columns(&con, &table);
        }
        if let Some(client) = extract_clickhouse(&connections, &pool_key) {
            drop(connections);
            return db::clickhouse_driver::get_columns(&client, &database, &table).await;
        }
        if let Some(client) = extract_sqlserver(&connections, &pool_key) {
            drop(connections);
            let mut client = client.lock().await;
            return db::sqlserver::get_columns(&mut client, &schema, &table).await;
        }
        if let Some(client) = extract_oracle(&connections, &pool_key) {
            drop(connections);
            let client = client.lock().await;
            return db::oracle_driver::get_columns(&*client, &schema, &table).await;
        }
    }

    let connections = state.connections.lock().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;

    match pool {
        PoolKind::Mysql(p) => db::mysql::get_columns(p, &schema, &table).await,
        PoolKind::Postgres(p) => db::postgres::get_columns(p, &schema, &table).await,
        PoolKind::Sqlite(p) => db::sqlite::get_columns(p, &schema, &table).await,
        _ => Ok(vec![]),
    }
}

#[tauri::command]
pub async fn list_indexes(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
) -> Result<Vec<db::IndexInfo>, String> {
    let pool_key = state.get_or_create_pool(&connection_id, Some(&database)).await?;

    {
        let connections = state.connections.lock().await;
        if let Some(client) = extract_sqlserver(&connections, &pool_key) {
            drop(connections);
            let mut client = client.lock().await;
            return db::sqlserver::list_indexes(&mut client, &schema, &table).await;
        }
        if let Some(client) = extract_oracle(&connections, &pool_key) {
            drop(connections);
            let client = client.lock().await;
            return db::oracle_driver::list_indexes(&*client, &schema, &table).await;
        }
    }

    let connections = state.connections.lock().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;

    match pool {
        PoolKind::Mysql(p) => db::mysql::list_indexes(p, &schema, &table).await,
        PoolKind::Postgres(p) => db::postgres::list_indexes(p, &schema, &table).await,
        PoolKind::Sqlite(p) => db::sqlite::list_indexes(p, &schema, &table).await,
        _ => Ok(vec![]),
    }
}

#[tauri::command]
pub async fn list_foreign_keys(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
) -> Result<Vec<db::ForeignKeyInfo>, String> {
    let pool_key = state.get_or_create_pool(&connection_id, Some(&database)).await?;

    {
        let connections = state.connections.lock().await;
        if let Some(client) = extract_sqlserver(&connections, &pool_key) {
            drop(connections);
            let mut client = client.lock().await;
            return db::sqlserver::list_foreign_keys(&mut client, &schema, &table).await;
        }
        if let Some(client) = extract_oracle(&connections, &pool_key) {
            drop(connections);
            let client = client.lock().await;
            return db::oracle_driver::list_foreign_keys(&*client, &schema, &table).await;
        }
    }

    let connections = state.connections.lock().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;

    match pool {
        PoolKind::Mysql(p) => db::mysql::list_foreign_keys(p, &schema, &table).await,
        PoolKind::Postgres(p) => db::postgres::list_foreign_keys(p, &schema, &table).await,
        PoolKind::Sqlite(p) => db::sqlite::list_foreign_keys(p, &schema, &table).await,
        _ => Ok(vec![]),
    }
}

#[tauri::command]
pub async fn list_triggers(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
) -> Result<Vec<db::TriggerInfo>, String> {
    let pool_key = state.get_or_create_pool(&connection_id, Some(&database)).await?;

    {
        let connections = state.connections.lock().await;
        if let Some(client) = extract_sqlserver(&connections, &pool_key) {
            drop(connections);
            let mut client = client.lock().await;
            return db::sqlserver::list_triggers(&mut client, &schema, &table).await;
        }
        if let Some(client) = extract_oracle(&connections, &pool_key) {
            drop(connections);
            let client = client.lock().await;
            return db::oracle_driver::list_triggers(&*client, &schema, &table).await;
        }
    }

    let connections = state.connections.lock().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;

    match pool {
        PoolKind::Mysql(p) => db::mysql::list_triggers(p, &schema, &table).await,
        PoolKind::Postgres(p) => db::postgres::list_triggers(p, &schema, &table).await,
        PoolKind::Sqlite(p) => db::sqlite::list_triggers(p, &schema, &table).await,
        _ => Ok(vec![]),
    }
}

#[tauri::command]
pub async fn get_table_ddl(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
) -> Result<String, String> {
    let pool_key = state.get_or_create_pool(&connection_id, Some(&database)).await?;

    {
        let connections = state.connections.lock().await;
        if let Some(con) = extract_duckdb(&connections, &pool_key) {
            drop(connections);
            let tbl = table.replace('\'', "''");
            let con = con.lock().map_err(|e| e.to_string())?;
            let mut stmt = con.prepare(&format!("SELECT sql FROM duckdb_tables() WHERE table_name = '{tbl}'"))
                .map_err(|e| e.to_string())?;
            let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
            if let Some(row) = rows.next().map_err(|e| e.to_string())? {
                return row.get::<_, String>(0).map_err(|e| e.to_string());
            }
            return Err("Table not found".to_string());
        }
        if let Some(client) = extract_clickhouse(&connections, &pool_key) {
            drop(connections);
            let result = db::clickhouse_driver::execute_query(&client, &database, &format!("SHOW CREATE TABLE `{table}`")).await?;
            return result.rows.first()
                .and_then(|r| r.first())
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .ok_or_else(|| "Table not found".to_string());
        }
        if let Some(client) = extract_sqlserver(&connections, &pool_key) {
            drop(connections);
            let mut client = client.lock().await;
            return build_sqlserver_ddl(&mut client, &schema, &table).await;
        }
        if let Some(client) = extract_oracle(&connections, &pool_key) {
            drop(connections);
            let client = client.lock().await;
            return build_oracle_ddl(&*client, &schema, &table).await;
        }
    }

    let connections = state.connections.lock().await;
    let pool = connections.get(&pool_key).ok_or("Pool not found")?;

    match pool {
        PoolKind::Mysql(p) => mysql_ddl(p, &table).await,
        PoolKind::Postgres(p) => pg_ddl(p, &schema, &table).await,
        PoolKind::Sqlite(p) => sqlite_ddl(p, &table).await,
        _ => Err("DDL not supported for this database type".to_string()),
    }
}

async fn mysql_ddl(pool: &sqlx::mysql::MySqlPool, table: &str) -> Result<String, String> {
    use sqlx::Row;
    let row: sqlx::mysql::MySqlRow = sqlx::query(&format!("SHOW CREATE TABLE `{}`", table.replace('`', "``")))
        .fetch_one(pool).await.map_err(|e| e.to_string())?;
    row.try_get::<String, _>(1)
        .or_else(|_| row.try_get::<Vec<u8>, _>(1).map(|b| String::from_utf8_lossy(&b).to_string()))
        .map_err(|e| e.to_string())
}

async fn sqlite_ddl(pool: &sqlx::sqlite::SqlitePool, table: &str) -> Result<String, String> {
    use sqlx::Row;
    let row: sqlx::sqlite::SqliteRow = sqlx::query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
        .bind(table)
        .fetch_one(pool).await.map_err(|e| e.to_string())?;
    row.try_get::<String, _>(0).map_err(|e| e.to_string())
}

async fn pg_ddl(pool: &sqlx::postgres::PgPool, schema: &str, table: &str) -> Result<String, String> {
    let columns = db::postgres::get_columns(pool, schema, table).await?;
    let indexes = db::postgres::list_indexes(pool, schema, table).await?;
    let fkeys = db::postgres::list_foreign_keys(pool, schema, table).await?;

    let mut ddl = format!("CREATE TABLE \"{schema}\".\"{table}\" (\n");
    let col_lines: Vec<String> = columns.iter().map(|c| {
        let mut line = format!("  \"{}\" {}", c.name, c.data_type);
        if !c.is_nullable { line.push_str(" NOT NULL"); }
        if let Some(ref def) = c.column_default { line.push_str(&format!(" DEFAULT {def}")); }
        line
    }).collect();
    ddl.push_str(&col_lines.join(",\n"));

    let pks: Vec<&str> = columns.iter().filter(|c| c.is_primary_key).map(|c| c.name.as_str()).collect();
    if !pks.is_empty() {
        ddl.push_str(&format!(",\n  PRIMARY KEY ({})", pks.iter().map(|k| format!("\"{k}\"")).collect::<Vec<_>>().join(", ")));
    }
    for fk in &fkeys {
        ddl.push_str(&format!(",\n  CONSTRAINT \"{}\" FOREIGN KEY (\"{}\") REFERENCES \"{}\"(\"{}\")", fk.name, fk.column, fk.ref_table, fk.ref_column));
    }
    ddl.push_str("\n);\n");

    for idx in &indexes {
        if idx.is_primary { continue; }
        let unique = if idx.is_unique { "UNIQUE " } else { "" };
        let cols = idx.columns.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", ");
        ddl.push_str(&format!("\nCREATE {unique}INDEX \"{}\" ON \"{schema}\".\"{table}\" ({cols});", idx.name));
    }
    Ok(ddl)
}

async fn build_sqlserver_ddl(client: &mut db::sqlserver::SqlServerClient, schema: &str, table: &str) -> Result<String, String> {
    let columns = db::sqlserver::get_columns(client, schema, table).await?;
    let indexes = db::sqlserver::list_indexes(client, schema, table).await?;
    let fkeys = db::sqlserver::list_foreign_keys(client, schema, table).await?;

    let mut ddl = format!("CREATE TABLE [{schema}].[{table}] (\n");
    let col_lines: Vec<String> = columns.iter().map(|c| {
        let mut line = format!("  [{}] {}", c.name, c.data_type);
        if !c.is_nullable { line.push_str(" NOT NULL"); }
        if let Some(ref def) = c.column_default { line.push_str(&format!(" DEFAULT {def}")); }
        line
    }).collect();
    ddl.push_str(&col_lines.join(",\n"));

    let pks: Vec<&str> = columns.iter().filter(|c| c.is_primary_key).map(|c| c.name.as_str()).collect();
    if !pks.is_empty() {
        ddl.push_str(&format!(",\n  PRIMARY KEY ({})", pks.iter().map(|k| format!("[{k}]")).collect::<Vec<_>>().join(", ")));
    }
    for fk in &fkeys {
        ddl.push_str(&format!(",\n  CONSTRAINT [{}] FOREIGN KEY ([{}]) REFERENCES [{}]([{}])", fk.name, fk.column, fk.ref_table, fk.ref_column));
    }
    ddl.push_str("\n);\n");

    for idx in &indexes {
        if idx.is_primary { continue; }
        let unique = if idx.is_unique { "UNIQUE " } else { "" };
        let cols = idx.columns.iter().map(|c| format!("[{c}]")).collect::<Vec<_>>().join(", ");
        ddl.push_str(&format!("\nCREATE {unique}INDEX [{}] ON [{schema}].[{table}] ({cols});", idx.name));
    }
    Ok(ddl)
}

async fn build_oracle_ddl(client: &db::oracle_driver::OracleClient, schema: &str, table: &str) -> Result<String, String> {
    let columns = db::oracle_driver::get_columns(client, schema, table).await?;
    let indexes = db::oracle_driver::list_indexes(client, schema, table).await?;
    let fkeys = db::oracle_driver::list_foreign_keys(client, schema, table).await?;

    let mut ddl = format!("CREATE TABLE \"{schema}\".\"{table}\" (\n");
    let col_lines: Vec<String> = columns.iter().map(|c| {
        let mut line = format!("  \"{}\" {}", c.name, c.data_type);
        if !c.is_nullable { line.push_str(" NOT NULL"); }
        if let Some(ref def) = c.column_default { line.push_str(&format!(" DEFAULT {def}")); }
        line
    }).collect();
    ddl.push_str(&col_lines.join(",\n"));

    let pks: Vec<&str> = columns.iter().filter(|c| c.is_primary_key).map(|c| c.name.as_str()).collect();
    if !pks.is_empty() {
        ddl.push_str(&format!(",\n  PRIMARY KEY ({})", pks.iter().map(|k| format!("\"{k}\"")).collect::<Vec<_>>().join(", ")));
    }
    for fk in &fkeys {
        ddl.push_str(&format!(",\n  CONSTRAINT \"{}\" FOREIGN KEY (\"{}\") REFERENCES \"{}\"(\"{}\")", fk.name, fk.column, fk.ref_table, fk.ref_column));
    }
    ddl.push_str("\n);\n");

    for idx in &indexes {
        if idx.is_primary { continue; }
        let unique = if idx.is_unique { "UNIQUE " } else { "" };
        let cols = idx.columns.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", ");
        ddl.push_str(&format!("\nCREATE {unique}INDEX \"{}\" ON \"{schema}\".\"{table}\" ({cols});", idx.name));
    }
    Ok(ddl)
}
