use futures::TryStreamExt;
use rust_decimal::Decimal;
use std::time::Instant;
use tiberius::{AuthMethod, Client, ColumnData, Config, FromSql, QueryItem, QueryStream};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use super::{connection_timeout, CONNECTION_TIMEOUT_SECS};
use crate::query::MAX_ROWS;
use crate::sql::starts_with_executable_sql_keyword;
use crate::types::{ColumnInfo, DatabaseInfo, ForeignKeyInfo, IndexInfo, QueryResult, TableInfo, TriggerInfo};

pub type SqlServerClient = Client<Compat<TcpStream>>;
const SIMPLE_QUERY_MODULE_KEYWORDS: &[&str] = &["FUNCTION", "PROC", "PROCEDURE", "TRIGGER", "VIEW"];

fn query_result_row_limit(max_rows: Option<usize>) -> usize {
    max_rows.unwrap_or(MAX_ROWS).max(1)
}

pub async fn connect(
    host: &str,
    port: u16,
    user: &str,
    pass: &str,
    database: Option<&str>,
) -> Result<SqlServerClient, String> {
    match try_connect(host, port, user, pass, database, true).await {
        Ok(client) => Ok(client),
        Err(_) => try_connect(host, port, user, pass, database, false).await,
    }
}

async fn try_connect(
    host: &str,
    port: u16,
    user: &str,
    pass: &str,
    database: Option<&str>,
    use_encryption: bool,
) -> Result<SqlServerClient, String> {
    let mut config = Config::new();
    config.host(host);
    config.port(port);
    config.authentication(AuthMethod::sql_server(user, pass));
    if let Some(db) = database {
        config.database(db);
    }
    config.trust_cert();
    if !use_encryption {
        config.encryption(tiberius::EncryptionLevel::NotSupported);
    }

    let tcp = tokio::time::timeout(connection_timeout(), TcpStream::connect(config.get_addr()))
        .await
        .map_err(|_| format!("SQL Server connection timed out ({CONNECTION_TIMEOUT_SECS}s)"))?
        .map_err(|e| format!("SQL Server connection failed: {e}"))?;
    tokio::time::timeout(connection_timeout(), Client::connect(config, tcp.compat_write()))
        .await
        .map_err(|_| format!("SQL Server handshake timed out ({CONNECTION_TIMEOUT_SECS}s)"))?
        .map_err(|e| format!("SQL Server connection failed: {e}"))
}

fn row_to_json(row: &tiberius::Row) -> Vec<serde_json::Value> {
    row.cells().map(|(_, cell)| sqlserver_cell_to_json(cell)).collect()
}

fn columns_from_metadata(metadata: &tiberius::ResultMetadata) -> Vec<String> {
    metadata.columns().iter().map(|c| c.name().to_string()).collect()
}

async fn collect_first_result_limited(
    mut stream: QueryStream<'_>,
    start: Instant,
    max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    let row_limit = query_result_row_limit(max_rows);
    let mut columns: Vec<String> = vec![];
    let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut truncated = false;

    while let Some(item) = stream.try_next().await.map_err(|e| e.to_string())? {
        match item {
            QueryItem::Metadata(metadata) if metadata.result_index() == 0 => {
                columns = columns_from_metadata(&metadata);
            }
            QueryItem::Metadata(_) => {}
            QueryItem::Row(row) if row.result_index() == 0 => {
                if rows.len() < row_limit {
                    rows.push(row_to_json(&row));
                } else {
                    truncated = true;
                }
            }
            QueryItem::Row(_) => {}
        }
    }

    Ok(QueryResult {
        columns,
        rows,
        affected_rows: 0,
        execution_time_ms: start.elapsed().as_millis(),
        truncated,
        session_id: None,
        has_more: false,
    })
}

struct SqlServerResultSet {
    columns: Vec<String>,
    rows: Vec<Vec<serde_json::Value>>,
    truncated: bool,
}

fn push_sqlserver_result_set(results: &mut Vec<QueryResult>, result: Option<SqlServerResultSet>, start: Instant) {
    if let Some(result) = result {
        if result.rows.is_empty() {
            return;
        }
        results.push(QueryResult {
            columns: result.columns,
            rows: result.rows,
            affected_rows: 0,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: result.truncated,
            session_id: None,
            has_more: false,
        });
    }
}

async fn collect_result_sets_limited(
    mut stream: QueryStream<'_>,
    start: Instant,
    max_rows: Option<usize>,
) -> Result<Vec<QueryResult>, String> {
    let row_limit = query_result_row_limit(max_rows);
    let mut results = Vec::new();
    let mut current: Option<SqlServerResultSet> = None;

    while let Some(item) = stream.try_next().await.map_err(|e| e.to_string())? {
        match item {
            QueryItem::Metadata(metadata) => {
                push_sqlserver_result_set(&mut results, current.take(), start);
                current = Some(SqlServerResultSet {
                    columns: columns_from_metadata(&metadata),
                    rows: Vec::new(),
                    truncated: false,
                });
            }
            QueryItem::Row(row) => {
                let result = current.get_or_insert_with(|| SqlServerResultSet {
                    columns: row.columns().iter().map(|c| c.name().to_string()).collect(),
                    rows: Vec::new(),
                    truncated: false,
                });
                if result.rows.len() < row_limit {
                    result.rows.push(row_to_json(&row));
                } else {
                    result.truncated = true;
                }
            }
        }
    }

    push_sqlserver_result_set(&mut results, current, start);
    Ok(results)
}

fn sqlserver_cell_to_json(cell: &ColumnData<'static>) -> serde_json::Value {
    if let Ok(Some(v)) = <&str as FromSql>::from_sql(cell) {
        return serde_json::Value::String(v.to_string());
    }
    if let Ok(Some(v)) = <chrono::NaiveDateTime as FromSql>::from_sql(cell) {
        return serde_json::Value::String(v.to_string());
    }
    if let Ok(Some(v)) = <chrono::NaiveDate as FromSql>::from_sql(cell) {
        return serde_json::Value::String(v.to_string());
    }
    if let Ok(Some(v)) = <chrono::NaiveTime as FromSql>::from_sql(cell) {
        return serde_json::Value::String(v.to_string());
    }
    if let Ok(Some(v)) = <chrono::DateTime<chrono::FixedOffset> as FromSql>::from_sql(cell) {
        return serde_json::Value::String(v.to_rfc3339());
    }
    if let Ok(Some(v)) = <Decimal as FromSql>::from_sql(cell) {
        return serde_json::Value::String(v.to_string());
    }
    if let Ok(Some(v)) = <u8 as FromSql>::from_sql(cell) {
        return serde_json::Value::Number(v.into());
    }
    if let Ok(Some(v)) = <i16 as FromSql>::from_sql(cell) {
        return serde_json::Value::Number(v.into());
    }
    if let Ok(Some(v)) = <i32 as FromSql>::from_sql(cell) {
        return serde_json::Value::Number(v.into());
    }
    if let Ok(Some(v)) = <i64 as FromSql>::from_sql(cell) {
        return super::safe_i64_to_json(v);
    }
    if let Ok(Some(v)) = <f32 as FromSql>::from_sql(cell) {
        return serde_json::Number::from_f64(v as f64)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null);
    }
    if let Ok(Some(v)) = <f64 as FromSql>::from_sql(cell) {
        return serde_json::Number::from_f64(v).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null);
    }
    if let Ok(Some(v)) = <bool as FromSql>::from_sql(cell) {
        return serde_json::Value::Bool(v);
    }
    if let Ok(Some(v)) = <uuid::Uuid as FromSql>::from_sql(cell) {
        return serde_json::Value::String(v.to_string());
    }
    if let Ok(Some(v)) = <Vec<u8> as tiberius::FromSqlOwned>::from_sql_owned(cell.clone()) {
        return serde_json::Value::String(format!("0x{}", hex_encode(&v)));
    }
    serde_json::Value::Null
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

pub async fn list_databases(client: &mut SqlServerClient) -> Result<Vec<DatabaseInfo>, String> {
    let stream = client
        .query(
            "SELECT name \
             FROM sys.databases \
             WHERE database_id > 4 \
               AND state = 0 \
             ORDER BY name",
            &[],
        )
        .await
        .map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows.iter().map(|row| DatabaseInfo { name: row.get::<&str, _>(0).unwrap_or("").to_string() }).collect())
}

pub async fn list_schemas(client: &mut SqlServerClient) -> Result<Vec<String>, String> {
    let stream = client
        .query(
            "SELECT s.name \
         FROM sys.schemas s \
         WHERE s.name NOT IN ('guest','INFORMATION_SCHEMA','sys') \
           AND EXISTS ( \
             SELECT 1 FROM sys.objects o \
             WHERE o.schema_id = s.schema_id \
               AND o.type IN ('U','V') \
               AND o.is_ms_shipped = 0 \
           ) \
         ORDER BY CASE WHEN s.name = 'dbo' THEN 0 ELSE 1 END, s.name",
            &[],
        )
        .await
        .map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows.iter().map(|row| row.get::<&str, _>(0).unwrap_or("").to_string()).collect())
}

pub async fn list_tables(
    client: &mut SqlServerClient,
    schema: &str,
    filter: Option<&str>,
    limit: Option<usize>,
) -> Result<Vec<TableInfo>, String> {
    let top = limit.map(|value| format!("TOP ({}) ", value.min(1000))).unwrap_or_default();
    let filter_clause = filter
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!(" AND o.name LIKE '%{}%' ESCAPE '\\' ", escape_like_literal(value.trim())))
        .unwrap_or_default();
    let sql = format!(
        "SELECT {top}o.name, CASE WHEN o.type = 'V' THEN 'VIEW' ELSE 'BASE TABLE' END \
         FROM sys.objects o \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         WHERE s.name = '{}' \
           AND o.type IN ('U','V') \
           AND o.is_ms_shipped = 0 \
           {filter_clause}\
         ORDER BY o.name",
        schema.replace('\'', "''")
    );
    let stream = client.query(&*sql, &[]).await.map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|row| TableInfo {
            name: row.get::<&str, _>(0).unwrap_or("").to_string(),
            table_type: row.get::<&str, _>(1).unwrap_or("BASE TABLE").to_string(),
            comment: None,
        })
        .collect())
}

fn escape_like_literal(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "''").replace('%', "\\%").replace('_', "\\_").replace('[', "\\[")
}

pub async fn list_objects(client: &mut SqlServerClient, schema: &str) -> Result<Vec<crate::types::ObjectInfo>, String> {
    let sql = format!(
        "SELECT o.name, \
         CASE o.type \
           WHEN 'U' THEN 'TABLE' \
           WHEN 'V' THEN 'VIEW' \
           WHEN 'P' THEN 'PROCEDURE' \
           WHEN 'FN' THEN 'FUNCTION' \
           WHEN 'IF' THEN 'FUNCTION' \
           WHEN 'TF' THEN 'FUNCTION' \
           WHEN 'FS' THEN 'FUNCTION' \
           WHEN 'FT' THEN 'FUNCTION' \
           ELSE o.type_desc \
         END AS object_type \
         FROM sys.objects o \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         WHERE s.name = '{}' \
           AND o.type IN ('U','V','P','FN','IF','TF','FS','FT') \
           AND o.is_ms_shipped = 0 \
         ORDER BY CASE o.type \
           WHEN 'U' THEN 0 \
           WHEN 'V' THEN 1 \
           WHEN 'P' THEN 2 \
           ELSE 3 \
         END, o.name",
        schema.replace('\'', "''")
    );
    let stream = client.query(&*sql, &[]).await.map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|row| crate::types::ObjectInfo {
            name: row.get::<&str, _>(0).unwrap_or("").to_string(),
            object_type: row.get::<&str, _>(1).unwrap_or("TABLE").to_string(),
            schema: Some(schema.to_string()),
            comment: None,
        })
        .collect())
}

pub async fn get_columns(client: &mut SqlServerClient, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    let sql = sqlserver_columns_sql(schema, table);
    let stream = client.query(&*sql, &[]).await.map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|row| {
            let base = row.get::<&str, _>(1).unwrap_or("").to_string();
            let max_len = row
                .try_get::<i32, _>(7)
                .ok()
                .flatten()
                .or_else(|| row.try_get::<i16, _>(7).ok().flatten().map(|v| v as i32));
            let dt_prec = row
                .try_get::<i32, _>(8)
                .ok()
                .flatten()
                .or_else(|| row.try_get::<i16, _>(8).ok().flatten().map(|v| v as i32));
            let num_prec = row
                .try_get::<i32, _>(5)
                .ok()
                .flatten()
                .or_else(|| row.try_get::<i16, _>(5).ok().flatten().map(|v| v as i32));
            let num_scale = row
                .try_get::<i32, _>(6)
                .ok()
                .flatten()
                .or_else(|| row.try_get::<i16, _>(6).ok().flatten().map(|v| v as i32));
            let data_type = match base.to_lowercase().as_str() {
                "varchar" => match max_len {
                    Some(-1) => "varchar(max)".to_string(),
                    Some(n) => format!("varchar({n})"),
                    None => "varchar".to_string(),
                },
                "nvarchar" => match max_len {
                    Some(-1) => "nvarchar(max)".to_string(),
                    Some(n) => format!("nvarchar({n})"),
                    None => "nvarchar".to_string(),
                },
                "varbinary" => match max_len {
                    Some(-1) => "varbinary(max)".to_string(),
                    Some(n) if n > 0 => format!("varbinary({n})"),
                    _ => "varbinary".to_string(),
                },
                "char" | "nchar" | "binary" => match max_len {
                    Some(n) if n > 0 => format!("{base}({n})"),
                    _ => base,
                },
                "decimal" | "numeric" => match (num_prec, num_scale) {
                    (Some(p), Some(s)) => format!("{base}({p},{s})"),
                    _ => base,
                },
                "datetime2" | "datetimeoffset" | "time" => match dt_prec {
                    Some(p) => format!("{base}({p})"),
                    _ => base,
                },
                _ => base,
            };
            ColumnInfo {
                name: row.get::<&str, _>(0).unwrap_or("").to_string(),
                data_type,
                is_nullable: row.get::<&str, _>(2).unwrap_or("NO") == "YES",
                column_default: row.get::<&str, _>(3).map(|s| s.to_string()),
                is_primary_key: row.get::<i32, _>(4).unwrap_or(0) == 1,
                extra: None,
                comment: None,
                numeric_precision: num_prec,
                numeric_scale: num_scale,
                character_maximum_length: max_len,
            }
        })
        .collect())
}

fn sqlserver_columns_sql(schema: &str, table: &str) -> String {
    format!(
        "SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT, \
         CASE WHEN kcu.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PK, \
         c.NUMERIC_PRECISION, c.NUMERIC_SCALE, c.CHARACTER_MAXIMUM_LENGTH, c.DATETIME_PRECISION \
         FROM INFORMATION_SCHEMA.COLUMNS c \
         LEFT JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu \
           ON c.TABLE_SCHEMA = kcu.TABLE_SCHEMA AND c.TABLE_NAME = kcu.TABLE_NAME AND c.COLUMN_NAME = kcu.COLUMN_NAME \
           AND kcu.CONSTRAINT_NAME IN (SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE CONSTRAINT_TYPE = 'PRIMARY KEY' AND TABLE_SCHEMA = '{s}' AND TABLE_NAME = '{t}') \
         WHERE c.TABLE_SCHEMA = '{s}' AND c.TABLE_NAME = '{t}' \
         ORDER BY c.ORDINAL_POSITION",
        s = schema.replace('\'', "''"), t = table.replace('\'', "''")
    )
}

pub async fn list_indexes(client: &mut SqlServerClient, schema: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
    let sql = sqlserver_indexes_sql(schema, table);
    let stream = client.query(&*sql, &[]).await.map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|row| {
            let cols_str = row.get::<&str, _>(1).unwrap_or("");
            let inc_str = row.get::<&str, _>(5).unwrap_or("");
            IndexInfo {
                name: row.get::<&str, _>(0).unwrap_or("").to_string(),
                columns: cols_str.split(',').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect(),
                is_unique: row.get::<bool, _>(2).unwrap_or(false),
                is_primary: row.get::<bool, _>(3).unwrap_or(false),
                filter: row.get::<&str, _>(6).map(|s| s.to_string()),
                index_type: row.get::<&str, _>(4).map(|s| s.to_string()),
                included_columns: if inc_str.is_empty() {
                    None
                } else {
                    Some(inc_str.split(',').map(|s| s.to_string()).collect())
                },
                comment: None,
            }
        })
        .collect())
}

fn sqlserver_indexes_sql(schema: &str, table: &str) -> String {
    format!(
        "SELECT i.name, \
         STUFF((SELECT ',' + c2.name \
                FROM sys.index_columns ic2 \
                JOIN sys.columns c2 ON ic2.object_id = c2.object_id AND ic2.column_id = c2.column_id \
                WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id AND ic2.is_included_column = 0 \
                ORDER BY ic2.key_ordinal \
                FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, '') AS columns, \
         i.is_unique, i.is_primary_key, i.type_desc, \
         STUFF((SELECT ',' + c3.name \
                FROM sys.index_columns ic3 \
                JOIN sys.columns c3 ON ic3.object_id = c3.object_id AND ic3.column_id = c3.column_id \
                WHERE ic3.object_id = i.object_id AND ic3.index_id = i.index_id AND ic3.is_included_column = 1 \
                ORDER BY ic3.index_column_id \
                FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, '') AS included_cols, \
         i.filter_definition \
         FROM sys.indexes i \
         WHERE i.object_id = OBJECT_ID('{s}.{t}') AND i.name IS NOT NULL \
         ORDER BY i.name",
        s = schema.replace('\'', "''"),
        t = table.replace('\'', "''")
    )
}

pub async fn list_foreign_keys(
    client: &mut SqlServerClient,
    schema: &str,
    table: &str,
) -> Result<Vec<ForeignKeyInfo>, String> {
    let sql = format!(
        "SELECT fk.name, c.name, rt.name, rc.name \
         FROM sys.foreign_keys fk \
         JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id \
         JOIN sys.columns c ON fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id \
         JOIN sys.tables rt ON fkc.referenced_object_id = rt.object_id \
         JOIN sys.columns rc ON fkc.referenced_object_id = rc.object_id AND fkc.referenced_column_id = rc.column_id \
         WHERE fk.parent_object_id = OBJECT_ID('{s}.{t}') \
         ORDER BY fk.name",
        s = schema.replace('\'', "''"),
        t = table.replace('\'', "''")
    );
    let stream = client.query(&*sql, &[]).await.map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|row| ForeignKeyInfo {
            name: row.get::<&str, _>(0).unwrap_or("").to_string(),
            column: row.get::<&str, _>(1).unwrap_or("").to_string(),
            ref_table: row.get::<&str, _>(2).unwrap_or("").to_string(),
            ref_column: row.get::<&str, _>(3).unwrap_or("").to_string(),
        })
        .collect())
}

pub async fn list_triggers(
    client: &mut SqlServerClient,
    schema: &str,
    table: &str,
) -> Result<Vec<TriggerInfo>, String> {
    let sql = format!(
        "SELECT t.name, te.type_desc, CASE WHEN t.is_instead_of_trigger = 1 THEN 'INSTEAD OF' ELSE 'AFTER' END \
         FROM sys.triggers t \
         JOIN sys.trigger_events te ON t.object_id = te.object_id \
         WHERE t.parent_id = OBJECT_ID('{s}.{t}') \
         ORDER BY t.name",
        s = schema.replace('\'', "''"),
        t = table.replace('\'', "''")
    );
    let stream = client.query(&*sql, &[]).await.map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|row| TriggerInfo {
            name: row.get::<&str, _>(0).unwrap_or("").to_string(),
            event: row.get::<&str, _>(1).unwrap_or("").to_string(),
            timing: row.get::<&str, _>(2).unwrap_or("AFTER").to_string(),
        })
        .collect())
}

pub async fn execute_query(client: &mut SqlServerClient, sql: &str) -> Result<QueryResult, String> {
    execute_query_with_max_rows(client, sql, None).await
}

pub async fn execute_query_with_max_rows(
    client: &mut SqlServerClient,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    let start = Instant::now();

    if starts_with_executable_sql_keyword(sql, &["SELECT", "EXEC", "WITH", "TABLE"]) {
        let stream = client.query(sql, &[]).await.map_err(|e| e.to_string())?;
        collect_first_result_limited(stream, start, max_rows).await
    } else if requires_simple_query_batch(sql) || is_transaction_control(sql) {
        let stream = client.simple_query(sql).await.map_err(|e| e.to_string())?;
        let _ = collect_result_sets_limited(stream, start, max_rows).await?;
        Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            affected_rows: 0,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        })
    } else {
        let result = client.execute(sql, &[]).await.map_err(|e| e.to_string())?;
        Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            affected_rows: result.rows_affected().iter().sum::<u64>(),
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        })
    }
}

pub async fn execute_batch(client: &mut SqlServerClient, sql: &str) -> Result<Vec<QueryResult>, String> {
    execute_batch_with_max_rows(client, sql, None).await
}

pub async fn execute_batch_with_max_rows(
    client: &mut SqlServerClient,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<Vec<QueryResult>, String> {
    let start = Instant::now();
    let stream = client.simple_query(sql).await.map_err(|e| e.to_string())?;
    let mut results = collect_result_sets_limited(stream, start, max_rows).await?;

    if results.is_empty() {
        results.push(QueryResult {
            columns: vec![],
            rows: vec![],
            affected_rows: 0,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        });
    }

    Ok(results)
}

fn is_transaction_control(sql: &str) -> bool {
    let tokens = first_sql_tokens(sql, 2);
    if tokens.is_empty() {
        return false;
    }
    let first = &tokens[0];
    if first.eq_ignore_ascii_case("COMMIT") || first.eq_ignore_ascii_case("ROLLBACK") {
        return true;
    }
    if first.eq_ignore_ascii_case("BEGIN") {
        return tokens
            .get(1)
            .map_or(false, |t| t.eq_ignore_ascii_case("TRANSACTION") || t.eq_ignore_ascii_case("TRAN"));
    }
    false
}

fn requires_simple_query_batch(sql: &str) -> bool {
    let tokens = first_sql_tokens(sql, 4);
    if tokens.len() >= 4
        && tokens[0].eq_ignore_ascii_case("CREATE")
        && tokens[1].eq_ignore_ascii_case("OR")
        && tokens[2].eq_ignore_ascii_case("ALTER")
    {
        return SIMPLE_QUERY_MODULE_KEYWORDS.iter().any(|keyword| tokens[3].eq_ignore_ascii_case(keyword));
    }

    if tokens.len() >= 2 && (tokens[0].eq_ignore_ascii_case("CREATE") || tokens[0].eq_ignore_ascii_case("ALTER")) {
        return SIMPLE_QUERY_MODULE_KEYWORDS.iter().any(|keyword| tokens[1].eq_ignore_ascii_case(keyword));
    }

    false
}

fn first_sql_tokens(sql: &str, limit: usize) -> Vec<String> {
    let bytes = sql.as_bytes();
    let mut tokens = Vec::new();
    let mut i = 0;

    while i < bytes.len() && tokens.len() < limit {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }

        if i + 1 < bytes.len() && bytes[i] == b'-' && bytes[i + 1] == b'-' {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }

        if i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            continue;
        }

        let start = i;
        while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
            i += 1;
        }

        if i > start {
            tokens.push(sql[start..i].to_string());
        } else {
            i += 1;
        }
    }

    tokens
}

#[cfg(test)]
mod tests {
    use super::{requires_simple_query_batch, sqlserver_cell_to_json, sqlserver_columns_sql, sqlserver_indexes_sql};
    use chrono::NaiveDate;
    use tiberius::{ColumnData, IntoSql};

    #[test]
    fn sqlserver_module_definitions_require_simple_query_batch() {
        assert!(requires_simple_query_batch("CREATE FUNCTION dbo.fn_demo() RETURNS INT AS BEGIN RETURN 1; END;"));
        assert!(requires_simple_query_batch("ALTER PROCEDURE dbo.usp_demo AS SELECT 1;"));
        assert!(requires_simple_query_batch("CREATE OR ALTER VIEW dbo.vw_demo AS SELECT 1 AS id;"));
        assert!(requires_simple_query_batch(
            "-- comment\nALTER TRIGGER dbo.tr_demo ON dbo.t AFTER INSERT AS SELECT 1;"
        ));
    }

    #[test]
    fn sqlserver_regular_ddl_can_use_execute() {
        assert!(!requires_simple_query_batch("ALTER TABLE dbo.t ADD name NVARCHAR(20);"));
        assert!(!requires_simple_query_batch("CREATE TABLE dbo.t(id INT);"));
        assert!(!requires_simple_query_batch("UPDATE dbo.t SET id = 1;"));
    }

    #[test]
    fn sqlserver_user_query_paths_do_not_collect_full_results_before_limiting() {
        let source = include_str!("sqlserver.rs");
        let execute_query = source.split("pub async fn execute_query").nth(1).unwrap();
        let execute_query = execute_query.split("pub async fn execute_batch").next().unwrap();
        assert!(!execute_query.contains("into_first_result"));

        let execute_batch = source.split("pub async fn execute_batch").nth(1).unwrap();
        let execute_batch = execute_batch.split("#[cfg(test)]").next().unwrap();
        assert!(!execute_batch.contains("into_results"));
    }

    #[test]
    fn sqlserver_index_metadata_sql_avoids_string_agg_for_older_compatibility_levels() {
        let sql = sqlserver_indexes_sql("dbo", "DF_Rule");

        assert!(!sql.contains("STRING_AGG"));
        assert!(sql.contains("FOR XML PATH"));
        assert!(sql.contains("OBJECT_ID('dbo.DF_Rule')"));
    }

    #[test]
    fn sqlserver_metadata_sql_escapes_literals() {
        let columns_sql = sqlserver_columns_sql("d'bo", "t'able");
        let indexes_sql = sqlserver_indexes_sql("d'bo", "t'able");

        assert!(columns_sql.contains("TABLE_SCHEMA = 'd''bo'"));
        assert!(columns_sql.contains("TABLE_NAME = 't''able'"));
        assert!(indexes_sql.contains("OBJECT_ID('d''bo.t''able')"));
    }

    #[test]
    fn sqlserver_tinyint_cells_are_json_numbers() {
        assert_eq!(sqlserver_cell_to_json(&ColumnData::U8(Some(7))), serde_json::json!(7));
    }

    #[test]
    fn sqlserver_datetime2_cells_are_json_strings() {
        let datetime = NaiveDate::from_ymd_opt(2026, 5, 13).unwrap().and_hms_milli_opt(9, 8, 7, 123).unwrap();
        let cell: ColumnData<'static> = datetime.into_sql();

        assert_eq!(sqlserver_cell_to_json(&cell), serde_json::json!("2026-05-13 09:08:07.123"));
    }
}
