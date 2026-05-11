use std::time::Instant;

use odbc_api::{buffers::TextRowSet, ConnectionOptions, Cursor, ResultSetMetadata};

use crate::sql::starts_with_executable_sql_keyword;
use crate::types::{ColumnInfo, DatabaseInfo, ForeignKeyInfo, IndexInfo, QueryResult, TableInfo, TriggerInfo};

use super::CONNECTION_TIMEOUT_SECS;

pub struct DmClient {
    conn: odbc_api::Connection<'static>,
}

unsafe impl Send for DmClient {}

impl DmClient {
    pub fn query_rows(&self, sql: &str) -> Result<Vec<Vec<String>>, String> {
        match self.conn.execute(sql, (), None).map_err(|e| e.to_string())? {
            Some(cursor) => read_cursor(cursor),
            None => Ok(vec![]),
        }
    }

    fn query_single_column(&self, sql: &str) -> Result<Vec<String>, String> {
        Ok(self.query_rows(sql)?.into_iter().filter_map(|r| r.into_iter().next()).collect())
    }
}

fn read_cursor(cursor: impl Cursor) -> Result<Vec<Vec<String>>, String> {
    let mut cursor = cursor;
    let col_count = cursor.num_result_cols().map_err(|e| e.to_string())? as u16;
    let buffer = TextRowSet::for_cursor(1000, &mut cursor, Some(8192)).map_err(|e| e.to_string())?;
    let mut row_cursor = cursor.bind_buffer(buffer).map_err(|e| e.to_string())?;
    let mut rows = Vec::new();
    while let Some(batch) = row_cursor.fetch().map_err(|e| e.to_string())? {
        for row_idx in 0..batch.num_rows() {
            let vals: Vec<String> = (0..col_count as usize)
                .map(|col| {
                    batch.at(col, row_idx).and_then(|bytes| std::str::from_utf8(bytes).ok()).unwrap_or("").to_string()
                })
                .collect();
            rows.push(vals);
        }
    }
    Ok(rows)
}

pub async fn connect(host: &str, port: u16, database: &str, user: &str, pass: &str) -> Result<DmClient, String> {
    let conn_str = format!(
        "Driver={{DM8 ODBC DRIVER}};Server={host};TCP_PORT={port};DATABASE={db};UID={user};PWD={pass}",
        host = host,
        port = port,
        db = database,
        user = user,
        pass = pass,
    );

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(CONNECTION_TIMEOUT_SECS),
        tokio::task::spawn_blocking(move || {
            super::ODBC_ENV.connect_with_connection_string(&conn_str, ConnectionOptions::default())
                .map_err(|e| {
                    let msg = e.to_string();
                    if msg.contains("Data source name not found") || msg.contains("Can't open lib") {
                        format!(
                            "DM8 ODBC driver not found. Please install the DM8 ODBC driver \
                             and register it in odbcinst.ini (Linux/macOS) or the ODBC Data Source Administrator (Windows). \
                             Original error: {msg}"
                        )
                    } else {
                        format!("DM connection failed: {msg}")
                    }
                })
                .map(|conn| DmClient { conn })
        }),
    )
    .await
    .map_err(|_| format!("DM connection timed out ({CONNECTION_TIMEOUT_SECS}s)"))?
    .map_err(|e| format!("DM connection task failed: {e}"))?;

    result
}

pub fn list_databases(client: &DmClient) -> Result<Vec<DatabaseInfo>, String> {
    let rows = client.query_single_column(
        "SELECT USERNAME FROM ALL_USERS \
         WHERE USERNAME NOT IN (\
           'SYS','SYSDBA','SYSAUDITOR','SYSSSO','CTISYS',\
           'SYS_DBA','_SYS_STATISTICS','SYS_PHM'\
         ) ORDER BY USERNAME",
    )?;
    Ok(rows.into_iter().map(|name| DatabaseInfo { name }).collect())
}

pub fn list_schemas(client: &DmClient) -> Result<Vec<String>, String> {
    let dbs = list_databases(client)?;
    Ok(dbs.into_iter().map(|d| d.name).collect())
}

pub fn list_tables(client: &DmClient, schema: &str) -> Result<Vec<TableInfo>, String> {
    let s = schema.replace('\'', "''");
    let sql = format!(
        "SELECT TABLE_NAME, 'TABLE' AS TABLE_TYPE FROM ALL_TABLES WHERE OWNER = '{s}' \
         UNION ALL \
         SELECT VIEW_NAME, 'VIEW' FROM ALL_VIEWS WHERE OWNER = '{s}' \
         ORDER BY 1"
    );
    let rows = client.query_rows(&sql)?;
    Ok(rows
        .into_iter()
        .map(|r| TableInfo {
            name: r.first().cloned().unwrap_or_default(),
            table_type: r.get(1).cloned().unwrap_or_else(|| "TABLE".to_string()),
            comment: None,
        })
        .collect())
}

pub fn get_columns(client: &DmClient, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    let s = schema.replace('\'', "''");
    let t = table.replace('\'', "''");

    let pk_rows = client.query_single_column(&format!(
        "SELECT cols.COLUMN_NAME FROM ALL_CONS_COLUMNS cols \
         JOIN ALL_CONSTRAINTS cons ON cols.CONSTRAINT_NAME = cons.CONSTRAINT_NAME AND cols.OWNER = cons.OWNER \
         WHERE cons.CONSTRAINT_TYPE = 'P' AND cons.OWNER = '{s}' AND cons.TABLE_NAME = '{t}'"
    ))?;
    let pk_names: std::collections::HashSet<String> = pk_rows.into_iter().collect();

    let col_rows = client.query_rows(&format!(
        "SELECT COLUMN_NAME, DATA_TYPE, NULLABLE, DATA_PRECISION, DATA_SCALE, DATA_LENGTH, CHAR_LENGTH \
         FROM ALL_TAB_COLUMNS \
         WHERE OWNER = '{s}' AND TABLE_NAME = '{t}' \
         ORDER BY COLUMN_ID"
    ))?;

    Ok(col_rows
        .into_iter()
        .map(|r| {
            let name = r.first().cloned().unwrap_or_default();
            let base = r.get(1).cloned().unwrap_or_default();
            let num_prec = r.get(3).and_then(|v| v.parse::<i32>().ok());
            let num_scale = r.get(4).and_then(|v| v.parse::<i32>().ok());
            let data_len = r.get(5).and_then(|v| v.parse::<i32>().ok());
            let char_len = r.get(6).and_then(|v| v.parse::<i32>().ok());
            let data_type = match base.to_uppercase().as_str() {
                "VARCHAR2" | "NVARCHAR2" | "VARCHAR" | "CHAR" | "NCHAR" => {
                    let len = char_len.or(data_len);
                    match len {
                        Some(n) => format!("{base}({n})"),
                        None => base,
                    }
                }
                "NUMBER" | "NUMERIC" | "DECIMAL" => match (num_prec, num_scale) {
                    (Some(p), Some(s)) if s > 0 => format!("{base}({p},{s})"),
                    (Some(p), _) if p > 0 => format!("{base}({p})"),
                    _ => base,
                },
                "RAW" => match data_len {
                    Some(n) => format!("RAW({n})"),
                    None => "RAW".to_string(),
                },
                _ => base,
            };
            ColumnInfo {
                is_primary_key: pk_names.contains(&name),
                name,
                data_type,
                is_nullable: r.get(2).map(|v| v == "Y").unwrap_or(false),
                column_default: None,
                extra: None,
                comment: None,
                numeric_precision: num_prec,
                numeric_scale: num_scale,
                character_maximum_length: char_len,
            }
        })
        .collect())
}

pub fn list_indexes(client: &DmClient, schema: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
    let s = schema.replace('\'', "''");
    let t = table.replace('\'', "''");
    let sql = format!(
        "SELECT i.INDEX_NAME, \
         LISTAGG(ic.COLUMN_NAME, ',') WITHIN GROUP (ORDER BY ic.COLUMN_POSITION) AS COLUMNS, \
         i.UNIQUENESS, \
         CASE WHEN c.CONSTRAINT_TYPE = 'P' THEN 1 ELSE 0 END AS IS_PK, \
         i.INDEX_TYPE \
         FROM ALL_INDEXES i \
         JOIN ALL_IND_COLUMNS ic ON i.INDEX_NAME = ic.INDEX_NAME AND i.OWNER = ic.INDEX_OWNER AND i.TABLE_OWNER = ic.TABLE_OWNER \
         LEFT JOIN ALL_CONSTRAINTS c ON i.INDEX_NAME = c.INDEX_NAME AND i.TABLE_OWNER = c.OWNER \
           AND c.CONSTRAINT_TYPE = 'P' \
         WHERE i.TABLE_OWNER = '{s}' AND i.TABLE_NAME = '{t}' \
         GROUP BY i.INDEX_NAME, i.UNIQUENESS, c.CONSTRAINT_TYPE, i.INDEX_TYPE \
         ORDER BY i.INDEX_NAME"
    );
    let rows = client.query_rows(&sql)?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let cols_str = r.get(1).cloned().unwrap_or_default();
            IndexInfo {
                name: r.first().cloned().unwrap_or_default(),
                columns: cols_str.split(',').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect(),
                is_unique: r.get(2).map(|v| v == "UNIQUE").unwrap_or(false),
                is_primary: r.get(3).map(|v| v == "1").unwrap_or(false),
                filter: None,
                index_type: r.get(4).cloned(),
                included_columns: None,
                comment: None,
            }
        })
        .collect())
}

pub fn list_foreign_keys(client: &DmClient, schema: &str, table: &str) -> Result<Vec<ForeignKeyInfo>, String> {
    let s = schema.replace('\'', "''");
    let t = table.replace('\'', "''");
    let sql = format!(
        "SELECT c.CONSTRAINT_NAME, cc.COLUMN_NAME, rc.TABLE_NAME, rcc.COLUMN_NAME \
         FROM ALL_CONSTRAINTS c \
         JOIN ALL_CONS_COLUMNS cc ON c.CONSTRAINT_NAME = cc.CONSTRAINT_NAME AND c.OWNER = cc.OWNER \
         JOIN ALL_CONSTRAINTS rc ON c.R_CONSTRAINT_NAME = rc.CONSTRAINT_NAME AND c.R_OWNER = rc.OWNER \
         JOIN ALL_CONS_COLUMNS rcc ON rc.CONSTRAINT_NAME = rcc.CONSTRAINT_NAME AND rc.OWNER = rcc.OWNER \
         WHERE c.CONSTRAINT_TYPE = 'R' AND c.OWNER = '{s}' AND c.TABLE_NAME = '{t}' \
         ORDER BY c.CONSTRAINT_NAME"
    );
    let rows = client.query_rows(&sql)?;
    Ok(rows
        .into_iter()
        .map(|r| ForeignKeyInfo {
            name: r.first().cloned().unwrap_or_default(),
            column: r.get(1).cloned().unwrap_or_default(),
            ref_table: r.get(2).cloned().unwrap_or_default(),
            ref_column: r.get(3).cloned().unwrap_or_default(),
        })
        .collect())
}

pub fn list_triggers(client: &DmClient, schema: &str, table: &str) -> Result<Vec<TriggerInfo>, String> {
    let s = schema.replace('\'', "''");
    let t = table.replace('\'', "''");
    let sql = format!(
        "SELECT TRIGGER_NAME, TRIGGERING_EVENT, TRIGGER_TYPE \
         FROM ALL_TRIGGERS \
         WHERE OWNER = '{s}' AND TABLE_NAME = '{t}' \
         ORDER BY TRIGGER_NAME"
    );
    let rows = client.query_rows(&sql)?;
    Ok(rows
        .into_iter()
        .map(|r| TriggerInfo {
            name: r.first().cloned().unwrap_or_default(),
            event: r.get(1).cloned().unwrap_or_default(),
            timing: r.get(2).cloned().unwrap_or_default(),
        })
        .collect())
}

pub fn execute_query_with_schema_sync(client: &DmClient, schema: &str, sql: &str) -> Result<QueryResult, String> {
    let set_schema = format!("SET SCHEMA \"{}\"", schema);
    client.conn.execute(&set_schema, (), None).map_err(|e| {
        log::error!("[dameng] set schema failed: {e}");
        e.to_string()
    })?;
    execute_query_sync(client, sql)
}

pub fn execute_query_sync(client: &DmClient, sql: &str) -> Result<QueryResult, String> {
    let start = Instant::now();
    let sql = sql.trim().trim_end_matches(';');

    if starts_with_executable_sql_keyword(sql, &["SELECT", "WITH", "SHOW", "DESCRIBE", "EXPLAIN"]) {
        match client.conn.execute(sql, (), None).map_err(|e| e.to_string())? {
            Some(mut cursor) => {
                let col_count = cursor.num_result_cols().map_err(|e| e.to_string())? as u16;
                let columns: Vec<String> = (1..=col_count)
                    .map(|i| cursor.col_name(i).map_err(|e| e.to_string()).unwrap_or_else(|_| format!("col{i}")))
                    .collect();

                let buffer = TextRowSet::for_cursor(1000, &mut cursor, Some(8192)).map_err(|e| e.to_string())?;
                let mut row_cursor = cursor.bind_buffer(buffer).map_err(|e| e.to_string())?;

                let mut rows = Vec::new();
                while let Some(batch) = row_cursor.fetch().map_err(|e| e.to_string())? {
                    for row_idx in 0..batch.num_rows() {
                        let vals: Vec<serde_json::Value> = (0..col_count as usize)
                            .map(|col| {
                                batch
                                    .at(col, row_idx)
                                    .and_then(|bytes| std::str::from_utf8(bytes).ok())
                                    .map(|s| serde_json::Value::String(s.to_string()))
                                    .unwrap_or(serde_json::Value::Null)
                            })
                            .collect();
                        rows.push(vals);
                        if rows.len() >= crate::query::MAX_ROWS {
                            break;
                        }
                    }
                    if rows.len() >= crate::query::MAX_ROWS {
                        break;
                    }
                }

                let truncated = rows.len() >= crate::query::MAX_ROWS;
                Ok(QueryResult {
                    columns,
                    rows,
                    affected_rows: 0,
                    execution_time_ms: start.elapsed().as_millis(),
                    truncated,
                })
            }
            None => Ok(QueryResult {
                columns: vec![],
                rows: vec![],
                affected_rows: 0,
                execution_time_ms: start.elapsed().as_millis(),
                truncated: false,
            }),
        }
    } else {
        match client.conn.execute(sql, (), None) {
            Ok(Some(_cursor)) => Ok(QueryResult {
                columns: vec![],
                rows: vec![],
                affected_rows: 0,
                execution_time_ms: start.elapsed().as_millis(),
                truncated: false,
            }),
            Ok(None) => Ok(QueryResult {
                columns: vec![],
                rows: vec![],
                affected_rows: 0,
                execution_time_ms: start.elapsed().as_millis(),
                truncated: false,
            }),
            Err(e) => Err(e.to_string()),
        }
    }
}
