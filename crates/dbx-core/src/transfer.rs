use std::collections::HashSet;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::connection::{AppState, PoolKind};
use crate::db;
use crate::models::connection::DatabaseType;

static CANCELLED: std::sync::LazyLock<RwLock<HashSet<String>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashSet::new()));

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferRequest {
    pub transfer_id: String,
    pub source_connection_id: String,
    pub source_database: String,
    pub source_schema: String,
    pub target_connection_id: String,
    pub target_database: String,
    pub target_schema: String,
    pub tables: Vec<String>,
    pub create_table: bool,
    pub truncate_before: bool,
    pub batch_size: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub transfer_id: String,
    pub table: String,
    pub table_index: usize,
    pub total_tables: usize,
    pub rows_transferred: u64,
    pub total_rows: Option<u64>,
    pub status: TransferStatus,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferStatus {
    Running,
    TableDone,
    Done,
    Error,
    Cancelled,
}

pub fn quote_identifier(name: &str, db_type: &DatabaseType) -> String {
    match db_type {
        DatabaseType::Mysql | DatabaseType::ClickHouse | DatabaseType::Doris | DatabaseType::StarRocks => format!("`{}`", name.replace('`', "``")),
        DatabaseType::SqlServer => format!("[{}]", name.replace(']', "]]")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

pub fn qualified_table(table: &str, schema: &str, db_type: &DatabaseType) -> String {
    let qt = quote_identifier(table, db_type);
    if schema.is_empty() {
        qt
    } else {
        format!("{}.{}", quote_identifier(schema, db_type), qt)
    }
}

pub fn escape_value(val: &serde_json::Value, db_type: &DatabaseType) -> String {
    match val {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::Bool(b) => match db_type {
            DatabaseType::Mysql | DatabaseType::Sqlite | DatabaseType::DuckDb | DatabaseType::Doris | DatabaseType::StarRocks => {
                if *b { "1".to_string() } else { "0".to_string() }
            }
            _ => if *b { "TRUE".to_string() } else { "FALSE".to_string() },
        },
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => {
            format!("'{}'", s.replace('\'', "''"))
        }
        _ => {
            let s = val.to_string();
            format!("'{}'", s.replace('\'', "''"))
        }
    }
}

pub fn map_column_type(source_type: &str, _source_db: &DatabaseType, target_db: &DatabaseType) -> String {
    let t = source_type.to_lowercase();
    let base = t.split('(').next().unwrap_or(&t).trim();

    match base {
        "int" | "integer" | "int4" | "mediumint" => match target_db {
            DatabaseType::Postgres => "INTEGER".into(),
            DatabaseType::Mysql => "INT".into(),
            DatabaseType::SqlServer => "INT".into(),
            _ => "INTEGER".into(),
        },
        "bigint" | "int8" => "BIGINT".into(),
        "smallint" | "int2" => "SMALLINT".into(),
        "tinyint" => match target_db {
            DatabaseType::Postgres => "SMALLINT".into(),
            _ => "TINYINT".into(),
        },
        "serial" | "bigserial" | "smallserial" => match target_db {
            DatabaseType::Postgres => source_type.to_uppercase(),
            DatabaseType::Mysql => "BIGINT AUTO_INCREMENT".into(),
            _ => "INTEGER".into(),
        },
        "float" | "float4" | "real" => match target_db {
            DatabaseType::Postgres => "REAL".into(),
            _ => "FLOAT".into(),
        },
        "double" | "double precision" | "float8" => match target_db {
            DatabaseType::Postgres => "DOUBLE PRECISION".into(),
            _ => "DOUBLE".into(),
        },
        "decimal" | "numeric" | "number" => {
            if t.contains('(') {
                match target_db {
                    DatabaseType::Mysql | DatabaseType::Postgres | DatabaseType::SqlServer | DatabaseType::Oracle => {
                        format!("DECIMAL{}", &t[t.find('(').unwrap()..])
                    }
                    _ => "NUMERIC".into(),
                }
            } else {
                "NUMERIC".into()
            }
        }
        "varchar" | "nvarchar" | "character varying" | "varchar2" => {
            if t.contains('(') {
                let len_part = &t[t.find('(').unwrap()..];
                match target_db {
                    DatabaseType::Postgres => format!("VARCHAR{len_part}"),
                    DatabaseType::Mysql => format!("VARCHAR{len_part}"),
                    DatabaseType::SqlServer => format!("NVARCHAR{len_part}"),
                    _ => format!("VARCHAR{len_part}"),
                }
            } else {
                "VARCHAR(255)".into()
            }
        }
        "char" | "nchar" | "character" => {
            if t.contains('(') {
                let len_part = &t[t.find('(').unwrap()..];
                format!("CHAR{len_part}")
            } else {
                "CHAR(1)".into()
            }
        }
        "text" | "longtext" | "mediumtext" | "tinytext" | "clob" | "ntext" => "TEXT".into(),
        "bool" | "boolean" => match target_db {
            DatabaseType::Mysql => "TINYINT(1)".into(),
            DatabaseType::SqlServer => "BIT".into(),
            _ => "BOOLEAN".into(),
        },
        "date" => "DATE".into(),
        "time" => "TIME".into(),
        "datetime" => match target_db {
            DatabaseType::Postgres => "TIMESTAMP".into(),
            _ => "DATETIME".into(),
        },
        "timestamp" | "timestamptz" | "timestamp with time zone"
        | "timestamp without time zone" => match target_db {
            DatabaseType::Mysql => "DATETIME".into(),
            DatabaseType::SqlServer => "DATETIME2".into(),
            _ => "TIMESTAMP".into(),
        },
        "blob" | "longblob" | "mediumblob" | "tinyblob" | "binary" | "varbinary" | "image" => {
            match target_db {
                DatabaseType::Postgres => "BYTEA".into(),
                DatabaseType::Mysql => "BLOB".into(),
                DatabaseType::SqlServer => "VARBINARY(MAX)".into(),
                _ => "BLOB".into(),
            }
        }
        "bytea" => match target_db {
            DatabaseType::Postgres => "BYTEA".into(),
            DatabaseType::Mysql => "BLOB".into(),
            _ => "BLOB".into(),
        },
        "json" | "jsonb" => match target_db {
            DatabaseType::Postgres => "JSONB".into(),
            DatabaseType::Mysql => "JSON".into(),
            _ => "TEXT".into(),
        },
        "uuid" => match target_db {
            DatabaseType::Postgres => "UUID".into(),
            _ => "VARCHAR(36)".into(),
        },
        "bit" => match target_db {
            DatabaseType::Postgres => "BOOLEAN".into(),
            _ => "BIT".into(),
        },
        _ => "TEXT".into(),
    }
}

pub fn generate_create_table_ddl(
    columns: &[db::ColumnInfo],
    table: &str,
    schema: &str,
    target_db: &DatabaseType,
    source_db: &DatabaseType,
) -> String {
    let full_table = qualified_table(table, schema, target_db);

    let col_lines: Vec<String> = columns
        .iter()
        .map(|c| {
            let mapped_type = map_column_type(&c.data_type, source_db, target_db);
            let mut line = format!("  {} {}", quote_identifier(&c.name, target_db), mapped_type);
            if !c.is_nullable {
                line.push_str(" NOT NULL");
            }
            line
        })
        .collect();

    let pks: Vec<String> = columns
        .iter()
        .filter(|c| c.is_primary_key)
        .map(|c| quote_identifier(&c.name, target_db))
        .collect();

    let mut ddl = match target_db {
        DatabaseType::SqlServer => format!("IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = '{table}')\n"),
        _ => String::new(),
    };

    let create_prefix = match target_db {
        DatabaseType::SqlServer => "CREATE TABLE",
        _ => "CREATE TABLE IF NOT EXISTS",
    };

    ddl.push_str(&format!("{create_prefix} {full_table} (\n"));
    ddl.push_str(&col_lines.join(",\n"));

    if !pks.is_empty() {
        ddl.push_str(&format!(",\n  PRIMARY KEY ({})", pks.join(", ")));
    }

    ddl.push_str("\n)");

    if matches!(target_db, DatabaseType::ClickHouse) {
        ddl.push_str(" ENGINE = MergeTree() ORDER BY tuple()");
    }

    ddl
}

pub fn generate_insert(
    columns: &[String],
    rows: &[Vec<serde_json::Value>],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
) -> String {
    if rows.is_empty() {
        return String::new();
    }

    let full_table = qualified_table(table, schema, db_type);
    let col_list = columns
        .iter()
        .map(|c| quote_identifier(c, db_type))
        .collect::<Vec<_>>()
        .join(", ");

    let value_rows: Vec<String> = rows
        .iter()
        .map(|row| {
            let vals: Vec<String> = row.iter().map(|v| escape_value(v, db_type)).collect();
            format!("({})", vals.join(", "))
        })
        .collect();

    format!("INSERT INTO {full_table} ({col_list}) VALUES\n{}", value_rows.join(",\n"))
}

pub fn pagination_sql(
    columns: &[String],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    offset: u64,
    limit: usize,
) -> String {
    let full_table = qualified_table(table, schema, db_type);
    let col_list = columns
        .iter()
        .map(|c| quote_identifier(c, db_type))
        .collect::<Vec<_>>()
        .join(", ");

    match db_type {
        DatabaseType::SqlServer | DatabaseType::Oracle => {
            format!(
                "SELECT {col_list} FROM {full_table} ORDER BY (SELECT NULL) OFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY"
            )
        }
        _ => {
            format!("SELECT {col_list} FROM {full_table} LIMIT {limit} OFFSET {offset}")
        }
    }
}

pub fn count_sql(table: &str, schema: &str, db_type: &DatabaseType) -> String {
    let full_table = qualified_table(table, schema, db_type);
    format!("SELECT COUNT(*) FROM {full_table}")
}

pub async fn execute_on_pool(
    state: &AppState,
    pool_key: &str,
    sql: &str,
) -> Result<db::QueryResult, String> {
    let connections = state.connections.lock().await;
    let pool = connections.get(pool_key).ok_or("Connection not found")?;

    match pool {
        PoolKind::Mysql(p, bare) => {
            let p = p.clone();
            let bare = *bare;
            drop(connections);
            db::mysql::execute_query(&p, sql, bare).await
        }
        PoolKind::Postgres(p) => {
            let p = p.clone();
            drop(connections);
            db::postgres::execute_query(&p, sql).await
        }
        PoolKind::Sqlite(p) => {
            let p = p.clone();
            drop(connections);
            db::sqlite::execute_query(&p, sql).await
        }
        PoolKind::ClickHouse(client) => {
            let client = client.clone();
            let database = pool_key.split(':').nth(1).unwrap_or("default").to_string();
            drop(connections);
            db::clickhouse_driver::execute_query(&client, &database, sql).await
        }
        PoolKind::SqlServer(client) => {
            let client = client.clone();
            drop(connections);
            let mut client = client.lock().await;
            db::sqlserver::execute_query(&mut client, sql).await
        }
        PoolKind::Oracle(client) => {
            let client = client.clone();
            drop(connections);
            let client = client.lock().await;
            db::oracle_driver::execute_query(&*client, sql).await
        }
        PoolKind::DuckDb(con) => {
            let con = con.clone();
            let sql = sql.to_string();
            drop(connections);
            tokio::task::spawn_blocking(move || {
                let con = con.lock().map_err(|e| e.to_string())?;
                let start = std::time::Instant::now();
                let trimmed = sql.trim().to_uppercase();
                if trimmed.starts_with("SELECT") || trimmed.starts_with("SHOW")
                    || trimmed.starts_with("DESCRIBE") || trimmed.starts_with("WITH")
                    || trimmed.starts_with("PRAGMA")
                {
                    let mut stmt = con.prepare(&sql).map_err(|e| e.to_string())?;
                    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
                    let stmt_ref = rows.as_ref().ok_or("DuckDB statement unavailable")?;
                    let col_count = stmt_ref.column_count();
                    let columns: Vec<String> = (0..col_count)
                        .map(|i| stmt_ref.column_name(i).map(|s| s.to_string()).unwrap_or_else(|_| "?".to_string()))
                        .collect();
                    let mut result_rows = Vec::new();
                    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                        let vals: Vec<serde_json::Value> = (0..col_count).map(|i| {
                            row.get::<_, String>(i).map(serde_json::Value::String)
                                .or_else(|_| row.get::<_, i64>(i).map(|v| serde_json::Value::Number(v.into())))
                                .or_else(|_| row.get::<_, f64>(i).map(|v| {
                                    serde_json::Number::from_f64(v).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
                                }))
                                .or_else(|_| row.get::<_, bool>(i).map(serde_json::Value::Bool))
                                .unwrap_or(serde_json::Value::Null)
                        }).collect();
                        result_rows.push(vals);
                    }
                    Ok(db::QueryResult { columns, rows: result_rows, affected_rows: 0, execution_time_ms: start.elapsed().as_millis(), truncated: false })
                } else {
                    let affected = con.execute(&sql, []).map_err(|e| e.to_string())?;
                    Ok(db::QueryResult { columns: vec![], rows: vec![], affected_rows: affected as u64, execution_time_ms: start.elapsed().as_millis(), truncated: false })
                }
            })
            .await
            .map_err(|e| e.to_string())?
        }
        _ => Err("Unsupported database type for transfer".to_string()),
    }
}

pub async fn get_db_type(state: &AppState, connection_id: &str) -> Result<DatabaseType, String> {
    let configs = state.configs.lock().await;
    configs
        .get(connection_id)
        .map(|c| c.db_type.clone())
        .ok_or_else(|| format!("Connection config not found: {connection_id}"))
}

pub async fn get_columns_for_transfer(
    state: &AppState,
    pool_key: &str,
    _connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<db::ColumnInfo>, String> {
    let connections = state.connections.lock().await;

    if let Some(PoolKind::DuckDb(con)) = connections.get(pool_key) {
        let con = con.clone();
        drop(connections);
        let table = table.to_string();
        return tokio::task::spawn_blocking(move || {
            let con = con.lock().map_err(|e| e.to_string())?;
            let mut stmt = con.prepare(
                "SELECT column_name, data_type, is_nullable, column_default
                 FROM information_schema.columns
                 WHERE table_schema = 'main' AND table_name = ?
                 ORDER BY ordinal_position"
            ).map_err(|e| e.to_string())?;
            let rows = stmt.query_map([&table], |row| {
                Ok(db::ColumnInfo {
                    name: row.get::<_, String>(0)?,
                    data_type: row.get::<_, String>(1)?,
                    is_nullable: row.get::<_, String>(2).unwrap_or_default() == "YES",
                    column_default: row.get::<_, Option<String>>(3)?,
                    is_primary_key: false,
                    extra: None,
                    comment: None,
                    numeric_precision: None,
                    numeric_scale: None,
                    character_maximum_length: None,
                })
            }).map_err(|e| e.to_string())?;
            Ok(rows.filter_map(|r| r.ok()).collect())
        }).await.map_err(|e| e.to_string())?;
    }

    if let Some(PoolKind::ClickHouse(client)) = connections.get(pool_key) {
        let client = client.clone();
        let database = database.to_string();
        let table = table.to_string();
        drop(connections);
        return db::clickhouse_driver::get_columns(&client, &database, &table).await;
    }
    if let Some(PoolKind::SqlServer(client)) = connections.get(pool_key) {
        let client = client.clone();
        let schema = schema.to_string();
        let table = table.to_string();
        drop(connections);
        let mut client = client.lock().await;
        return db::sqlserver::get_columns(&mut client, &schema, &table).await;
    }
    if let Some(PoolKind::Oracle(client)) = connections.get(pool_key) {
        let client = client.clone();
        let schema = schema.to_string();
        let table = table.to_string();
        drop(connections);
        let client = client.lock().await;
        return db::oracle_driver::get_columns(&*client, &schema, &table).await;
    }

    let pool = connections.get(pool_key).ok_or("Pool not found")?;
    let schema = schema.to_string();
    let table = table.to_string();
    match pool {
        PoolKind::Mysql(p, _) => {
            let p = p.clone();
            drop(connections);
            db::mysql::get_columns(&p, &schema, &table).await
        }
        PoolKind::Postgres(p) => {
            let p = p.clone();
            drop(connections);
            db::postgres::get_columns(&p, &schema, &table).await
        }
        PoolKind::Sqlite(p) => {
            let p = p.clone();
            drop(connections);
            db::sqlite::get_columns(&p, &schema, &table).await
        }
        _ => Err("Unsupported database type".to_string()),
    }
}

pub async fn is_cancelled(transfer_id: &str) -> bool {
    CANCELLED.read().await.contains(transfer_id)
}

pub async fn set_cancelled(transfer_id: &str) {
    CANCELLED.write().await.insert(transfer_id.to_string());
}

pub async fn clear_cancelled(transfer_id: &str) {
    CANCELLED.write().await.remove(transfer_id);
}

/// Transfer a single table. Returns rows transferred.
/// `progress_callback` is invoked for progress updates.
pub async fn transfer_table<F>(
    state: &AppState,
    request: &TransferRequest,
    table: &str,
    table_index: usize,
    source_db_type: &DatabaseType,
    target_db_type: &DatabaseType,
    source_pool_key: &str,
    target_pool_key: &str,
    mut progress_callback: F,
) -> Result<u64, String>
where
    F: FnMut(TransferProgress),
{
    let total_tables = request.tables.len();

    // Get source columns (deduplicate by name)
    let columns = {
        let raw = get_columns_for_transfer(
            state, source_pool_key, &request.source_connection_id,
            &request.source_database, &request.source_schema, table,
        ).await?;
        let mut seen = std::collections::HashSet::new();
        raw.into_iter().filter(|c| seen.insert(c.name.clone())).collect::<Vec<_>>()
    };

    if columns.is_empty() {
        return Err(format!("No columns found for table {table}"));
    }

    let col_names: Vec<String> = columns.iter().map(|c| c.name.clone()).collect();
    log::info!("[transfer] {} has {} columns, counting rows...", table, columns.len());

    // Count source rows
    let total_rows = {
        let sql = count_sql(table, &request.source_schema, source_db_type);
        match execute_on_pool(state, source_pool_key, &sql).await {
            Ok(result) => result.rows.first()
                .and_then(|r| r.first())
                .and_then(|v| match v {
                    serde_json::Value::Number(n) => n.as_u64(),
                    serde_json::Value::String(s) => s.parse::<u64>().ok(),
                    _ => None,
                }),
            Err(e) => {
                log::warn!("[transfer] count failed for {}: {}", table, e);
                None
            }
        }
    };
    log::info!("[transfer] {} total_rows={:?}", table, total_rows);

    // Create table on target if requested
    if request.create_table {
        let ddl = generate_create_table_ddl(&columns, table, &request.target_schema, target_db_type, source_db_type);
        log::info!("[transfer] creating target table: {}", &ddl[..ddl.len().min(200)]);
        if let Err(e) = execute_on_pool(state, target_pool_key, &ddl).await {
            let err_lower = e.to_lowercase();
            if !err_lower.contains("already exists") && !err_lower.contains("there is already") {
                return Err(format!("Failed to create table: {e}"));
            }
        }
    }

    // Truncate target if requested
    if request.truncate_before {
        let full_table = qualified_table(table, &request.target_schema, target_db_type);
        let truncate_sql = match target_db_type {
            DatabaseType::Sqlite | DatabaseType::DuckDb => format!("DELETE FROM {full_table}"),
            _ => format!("TRUNCATE TABLE {full_table}"),
        };
        execute_on_pool(state, target_pool_key, &truncate_sql).await
            .map_err(|e| format!("Failed to truncate: {e}"))?;
    }

    // Transfer data in batches
    let batch_size = if request.batch_size == 0 { 1000 } else { request.batch_size };
    let mut offset: u64 = 0;
    let mut total_transferred: u64 = 0;

    loop {
        if is_cancelled(&request.transfer_id).await {
            return Err("Cancelled".to_string());
        }

        let sql = pagination_sql(&col_names, table, &request.source_schema, source_db_type, offset, batch_size);
        let result = execute_on_pool(state, source_pool_key, &sql).await?;
        let row_count = result.rows.len();

        if row_count == 0 {
            break;
        }

        let insert_sql = generate_insert(&col_names, &result.rows, table, &request.target_schema, target_db_type);
        if !insert_sql.is_empty() {
            execute_on_pool(state, target_pool_key, &insert_sql).await
                .map_err(|e| format!("Insert failed at offset {offset}: {e}"))?;
        }

        total_transferred += row_count as u64;
        log::info!("[transfer] {} batch +{} rows (total {})", table, row_count, total_transferred);
        offset += row_count as u64;

        progress_callback(TransferProgress {
            transfer_id: request.transfer_id.clone(),
            table: table.to_string(),
            table_index,
            total_tables,
            rows_transferred: total_transferred,
            total_rows,
            status: TransferStatus::Running,
            error: None,
        });

        if row_count < batch_size {
            break;
        }
    }

    Ok(total_transferred)
}
