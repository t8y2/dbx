use rust_decimal::Decimal;
use tiberius::{AuthMethod, Client, Config};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};
use std::time::Instant;

use super::{ColumnInfo, DatabaseInfo, ForeignKeyInfo, IndexInfo, QueryResult, TableInfo, TriggerInfo};

pub type SqlServerClient = Client<Compat<TcpStream>>;

pub async fn connect(host: &str, port: u16, user: &str, pass: &str, database: Option<&str>) -> Result<SqlServerClient, String> {
    match try_connect(host, port, user, pass, database, true).await {
        Ok(client) => Ok(client),
        Err(_) => try_connect(host, port, user, pass, database, false).await,
    }
}

async fn try_connect(host: &str, port: u16, user: &str, pass: &str, database: Option<&str>, use_encryption: bool) -> Result<SqlServerClient, String> {
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

    let tcp = TcpStream::connect(config.get_addr())
        .await
        .map_err(|e| format!("SQL Server connection failed: {e}"))?;
    Client::connect(config, tcp.compat_write())
        .await
        .map_err(|e| format!("SQL Server connection failed: {e}"))
}

fn row_to_json(row: &tiberius::Row) -> Vec<serde_json::Value> {
    (0..row.len()).map(|i| {
        if let Some(v) = row.try_get::<&str, _>(i).ok().flatten() {
            serde_json::Value::String(v.to_string())
        } else if let Some(v) = row.try_get::<Decimal, _>(i).ok().flatten() {
            serde_json::Value::String(v.to_string())
        } else if let Some(v) = row.try_get::<i32, _>(i).ok().flatten() {
            serde_json::Value::Number(v.into())
        } else if let Some(v) = row.try_get::<i64, _>(i).ok().flatten() {
            serde_json::Value::Number(v.into())
        } else if let Some(v) = row.try_get::<f64, _>(i).ok().flatten() {
            serde_json::Number::from_f64(v).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
        } else if let Some(v) = row.try_get::<bool, _>(i).ok().flatten() {
            serde_json::Value::Bool(v)
        } else {
            serde_json::Value::Null
        }
    }).collect()
}

pub async fn list_databases(client: &mut SqlServerClient) -> Result<Vec<DatabaseInfo>, String> {
    let stream = client.query("SELECT name FROM sys.databases ORDER BY name", &[])
        .await.map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows.iter().map(|row| {
        DatabaseInfo { name: row.get::<&str, _>(0).unwrap_or("").to_string() }
    }).collect())
}

pub async fn list_schemas(client: &mut SqlServerClient) -> Result<Vec<String>, String> {
    let stream = client.query(
        "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA \
         WHERE SCHEMA_NAME NOT IN ('guest','INFORMATION_SCHEMA','sys') \
         ORDER BY SCHEMA_NAME",
        &[],
    ).await.map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows.iter().map(|row| {
        row.get::<&str, _>(0).unwrap_or("").to_string()
    }).collect())
}

pub async fn list_tables(client: &mut SqlServerClient, schema: &str) -> Result<Vec<TableInfo>, String> {
    let sql = format!(
        "SELECT TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = '{}' ORDER BY TABLE_NAME",
        schema.replace('\'', "''")
    );
    let stream = client.query(&*sql, &[]).await.map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows.iter().map(|row| {
        TableInfo {
            name: row.get::<&str, _>(0).unwrap_or("").to_string(),
            table_type: row.get::<&str, _>(1).unwrap_or("BASE TABLE").to_string(),
        }
    }).collect())
}

pub async fn get_columns(client: &mut SqlServerClient, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    let sql = format!(
        "SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT, \
         CASE WHEN kcu.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PK, \
         c.NUMERIC_PRECISION, c.NUMERIC_SCALE \
         FROM INFORMATION_SCHEMA.COLUMNS c \
         LEFT JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu \
           ON c.TABLE_SCHEMA = kcu.TABLE_SCHEMA AND c.TABLE_NAME = kcu.TABLE_NAME AND c.COLUMN_NAME = kcu.COLUMN_NAME \
           AND kcu.CONSTRAINT_NAME IN (SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE CONSTRAINT_TYPE = 'PRIMARY KEY' AND TABLE_SCHEMA = '{s}' AND TABLE_NAME = '{t}') \
         WHERE c.TABLE_SCHEMA = '{s}' AND c.TABLE_NAME = '{t}' \
         ORDER BY c.ORDINAL_POSITION",
        s = schema.replace('\'', "''"), t = table.replace('\'', "''")
    );
    let stream = client.query(&*sql, &[]).await.map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows.iter().map(|row| {
        ColumnInfo {
            name: row.get::<&str, _>(0).unwrap_or("").to_string(),
            data_type: row.get::<&str, _>(1).unwrap_or("").to_string(),
            is_nullable: row.get::<&str, _>(2).unwrap_or("NO") == "YES",
            column_default: row.get::<&str, _>(3).map(|s| s.to_string()),
            is_primary_key: row.get::<i32, _>(4).unwrap_or(0) == 1,
            extra: None, comment: None,
            numeric_precision: row.get::<i32, _>(5),
            numeric_scale: row.get::<i32, _>(6),
        }
    }).collect())
}

pub async fn list_indexes(client: &mut SqlServerClient, schema: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
    let sql = format!(
        "SELECT i.name, STRING_AGG(c.name, ',') WITHIN GROUP (ORDER BY ic.key_ordinal) AS columns, \
         i.is_unique, i.is_primary_key \
         FROM sys.indexes i \
         JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id \
         JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id \
         WHERE i.object_id = OBJECT_ID('{s}.{t}') AND i.name IS NOT NULL \
         GROUP BY i.name, i.is_unique, i.is_primary_key \
         ORDER BY i.name",
        s = schema.replace('\'', "''"), t = table.replace('\'', "''")
    );
    let stream = client.query(&*sql, &[]).await.map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows.iter().map(|row| {
        let cols_str = row.get::<&str, _>(1).unwrap_or("");
        IndexInfo {
            name: row.get::<&str, _>(0).unwrap_or("").to_string(),
            columns: cols_str.split(',').map(|s| s.to_string()).collect(),
            is_unique: row.get::<bool, _>(2).unwrap_or(false),
            is_primary: row.get::<bool, _>(3).unwrap_or(false),
        }
    }).collect())
}

pub async fn list_foreign_keys(client: &mut SqlServerClient, schema: &str, table: &str) -> Result<Vec<ForeignKeyInfo>, String> {
    let sql = format!(
        "SELECT fk.name, c.name, rt.name, rc.name \
         FROM sys.foreign_keys fk \
         JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id \
         JOIN sys.columns c ON fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id \
         JOIN sys.tables rt ON fkc.referenced_object_id = rt.object_id \
         JOIN sys.columns rc ON fkc.referenced_object_id = rc.object_id AND fkc.referenced_column_id = rc.column_id \
         WHERE fk.parent_object_id = OBJECT_ID('{s}.{t}') \
         ORDER BY fk.name",
        s = schema.replace('\'', "''"), t = table.replace('\'', "''")
    );
    let stream = client.query(&*sql, &[]).await.map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows.iter().map(|row| {
        ForeignKeyInfo {
            name: row.get::<&str, _>(0).unwrap_or("").to_string(),
            column: row.get::<&str, _>(1).unwrap_or("").to_string(),
            ref_table: row.get::<&str, _>(2).unwrap_or("").to_string(),
            ref_column: row.get::<&str, _>(3).unwrap_or("").to_string(),
        }
    }).collect())
}

pub async fn list_triggers(client: &mut SqlServerClient, schema: &str, table: &str) -> Result<Vec<TriggerInfo>, String> {
    let sql = format!(
        "SELECT t.name, te.type_desc, CASE WHEN t.is_instead_of_trigger = 1 THEN 'INSTEAD OF' ELSE 'AFTER' END \
         FROM sys.triggers t \
         JOIN sys.trigger_events te ON t.object_id = te.object_id \
         WHERE t.parent_id = OBJECT_ID('{s}.{t}') \
         ORDER BY t.name",
        s = schema.replace('\'', "''"), t = table.replace('\'', "''")
    );
    let stream = client.query(&*sql, &[]).await.map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows.iter().map(|row| {
        TriggerInfo {
            name: row.get::<&str, _>(0).unwrap_or("").to_string(),
            event: row.get::<&str, _>(1).unwrap_or("").to_string(),
            timing: row.get::<&str, _>(2).unwrap_or("AFTER").to_string(),
        }
    }).collect())
}

pub async fn execute_query(client: &mut SqlServerClient, sql: &str) -> Result<QueryResult, String> {
    let start = Instant::now();
    let trimmed = sql.trim().to_uppercase();

    if trimmed.starts_with("SELECT")
        || trimmed.starts_with("EXEC")
        || trimmed.starts_with("WITH")
        || trimmed.starts_with("TABLE")
    {
        let mut stream = client.query(sql, &[]).await.map_err(|e| e.to_string())?;
        let columns_meta = stream.columns().await.map_err(|e| e.to_string())?
            .map(|cols| cols.iter().map(|c| c.name().to_string()).collect::<Vec<_>>())
            .unwrap_or_default();

        let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
        let result_rows: Vec<Vec<serde_json::Value>> = rows.iter().map(|row| row_to_json(row)).collect();

        Ok(QueryResult {
            columns: columns_meta,
            rows: result_rows,
            affected_rows: 0,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
        })
    } else {
        let result = client.execute(sql, &[]).await.map_err(|e| e.to_string())?;
        Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            affected_rows: result.rows_affected().iter().sum::<u64>(),
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
        })
    }
}
