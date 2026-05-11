use log;
use rust_oracle::{Config, Connection};
use std::time::Instant;

use super::{connection_timeout, CONNECTION_TIMEOUT_SECS};
use crate::sql::starts_with_executable_sql_keyword;
use crate::types::{ColumnInfo, DatabaseInfo, ForeignKeyInfo, IndexInfo, QueryResult, TableInfo, TriggerInfo};

pub type OracleClient = Connection;
const ORACLE_QUERY_LIMIT: usize = crate::query::MAX_ROWS + 1;

fn quote_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

pub async fn connect(
    host: &str,
    port: u16,
    service: &str,
    user: &str,
    pass: &str,
    sysdba: bool,
) -> Result<OracleClient, String> {
    let config = Config::new(host, port, service, user, pass).with_statement_cache_size(0).sysdba_flag(sysdba);
    let conn = tokio::time::timeout(connection_timeout(), Connection::connect_with_config(config))
        .await
        .map_err(|_| format!("Oracle connection timed out ({CONNECTION_TIMEOUT_SECS}s)"))?
        .map_err(|e| format!("Oracle connection failed: {e}"))?;

    Ok(conn)
}

fn value_to_json(val: &rust_oracle::Value) -> serde_json::Value {
    match val {
        rust_oracle::Value::Null => serde_json::Value::Null,
        rust_oracle::Value::String(s) => serde_json::Value::String(s.clone()),
        rust_oracle::Value::Integer(n) => serde_json::Value::Number((*n).into()),
        rust_oracle::Value::Float(f) => {
            serde_json::Number::from_f64(*f).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
        }
        rust_oracle::Value::Date(d) => serde_json::Value::String(format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
            d.year, d.month, d.day, d.hour, d.minute, d.second
        )),
        rust_oracle::Value::Timestamp(ts) => {
            let base = format!(
                "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
                ts.year, ts.month, ts.day, ts.hour, ts.minute, ts.second
            );
            let value = if ts.microsecond > 0 { format!("{base}.{:06}", ts.microsecond) } else { base };
            serde_json::Value::String(value)
        }
        rust_oracle::Value::Boolean(b) => serde_json::Value::Bool(*b),
        rust_oracle::Value::Json(v) => v.clone(),
        _ => serde_json::Value::String(format!("{val:?}")),
    }
}

pub async fn list_databases(conn: &OracleClient) -> Result<Vec<DatabaseInfo>, String> {
    let result = conn
        .query(
            "WITH schema_names AS ( \
               SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS owner FROM DUAL \
               UNION \
               SELECT DISTINCT owner FROM all_tables \
               UNION \
               SELECT DISTINCT owner FROM all_views \
             ) \
             SELECT owner \
             FROM schema_names \
             WHERE owner IS NOT NULL \
               AND owner NOT IN (\
                 'SYS','SYSTEM','SYSMAN','DBSNMP','SYSBACKUP','SYSDG','SYSKM','OUTLN',\
                 'AUDSYS','LBACSYS','DVF','DVSYS','APPQOSSYS','CTXSYS','MDSYS','MDDATA',\
                 'ORDSYS','ORDDATA','ORDPLUGINS','XDB','ANONYMOUS','DIP','EXFSYS',\
                 'GSMADMIN_INTERNAL','GSMCATUSER','GSMUSER','OJVMSYS','OLAPSYS',\
                 'ORACLE_OCM','SI_INFORMTN_SCHEMA','WMSYS','XS$NULL','DBSFWUSER',\
                 'REMOTE_SCHEDULER_AGENT','PDBADMIN','DGPDB_INT','OPS$ORACLE',\
                 'GGSYS','FLOWS_FILES','APEX_PUBLIC_USER'\
               ) \
               AND owner NOT LIKE 'APEX_%' \
               AND owner NOT LIKE 'FLOWS_%' \
               AND owner NOT LIKE '%$%' \
             ORDER BY CASE \
               WHEN owner = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') THEN 0 \
               WHEN owner = SYS_CONTEXT('USERENV', 'SESSION_USER') THEN 1 \
               ELSE 2 \
             END, owner",
            &[],
        )
        .await
        .map_err(|e| {
            log::error!("[oracle] list_databases failed: {e}");
            e.to_string()
        })?;

    Ok(result.rows.iter().map(|row| DatabaseInfo { name: row.get_string(0).unwrap_or("").to_string() }).collect())
}

pub async fn list_schemas(conn: &OracleClient) -> Result<Vec<String>, String> {
    let dbs = list_databases(conn).await?;
    Ok(dbs.into_iter().map(|d| d.name).collect())
}

pub async fn list_tables(conn: &OracleClient, schema: &str) -> Result<Vec<TableInfo>, String> {
    let s = quote_literal(schema);
    let sql = format!(
        "SELECT o.OBJECT_NAME, \
         CASE o.OBJECT_TYPE WHEN 'VIEW' THEN 'VIEW' ELSE 'TABLE' END AS TABLE_TYPE, \
         c.COMMENTS \
         FROM ALL_OBJECTS o \
         LEFT JOIN ALL_TAB_COMMENTS c ON c.OWNER = o.OWNER AND c.TABLE_NAME = o.OBJECT_NAME \
         WHERE o.OWNER = {s} AND o.OBJECT_TYPE IN ('TABLE','VIEW') \
         ORDER BY o.OBJECT_NAME"
    );
    log::debug!("[oracle] list_tables: schema={schema}, sql={sql}");
    let result = conn.query(&sql, &[]).await.map_err(|e| {
        log::error!("[oracle] list_tables failed: {e}");
        e.to_string()
    })?;
    Ok(result
        .rows
        .iter()
        .map(|row| TableInfo {
            name: row.get_string(0).unwrap_or("").to_string(),
            table_type: row.get_string(1).unwrap_or("TABLE").to_string(),
            comment: row.get_string(2).filter(|s| !s.is_empty()).map(|s| s.to_string()),
        })
        .collect())
}

pub async fn list_objects(conn: &OracleClient, schema: &str) -> Result<Vec<crate::types::ObjectInfo>, String> {
    let s = quote_literal(schema);
    let sql = format!(
        "SELECT o.OBJECT_NAME, \
         CASE o.OBJECT_TYPE \
           WHEN 'TABLE' THEN 'TABLE' \
           WHEN 'VIEW' THEN 'VIEW' \
           WHEN 'PROCEDURE' THEN 'PROCEDURE' \
           WHEN 'FUNCTION' THEN 'FUNCTION' \
           ELSE o.OBJECT_TYPE \
         END AS OBJECT_TYPE, \
         c.COMMENTS \
         FROM ALL_OBJECTS o \
         LEFT JOIN ALL_TAB_COMMENTS c ON c.OWNER = o.OWNER AND c.TABLE_NAME = o.OBJECT_NAME \
         WHERE o.OWNER = {s} \
           AND o.OBJECT_TYPE IN ('TABLE','VIEW','PROCEDURE','FUNCTION') \
           AND o.OBJECT_NAME NOT LIKE 'BIN$%' \
         ORDER BY CASE o.OBJECT_TYPE \
           WHEN 'TABLE' THEN 0 \
           WHEN 'VIEW' THEN 1 \
           WHEN 'PROCEDURE' THEN 2 \
           WHEN 'FUNCTION' THEN 3 \
           ELSE 4 \
         END, o.OBJECT_NAME"
    );
    let result = conn.query(&sql, &[]).await.map_err(|e| e.to_string())?;
    Ok(result
        .rows
        .iter()
        .map(|row| crate::types::ObjectInfo {
            name: row.get_string(0).unwrap_or("").to_string(),
            object_type: row.get_string(1).unwrap_or("TABLE").to_string(),
            schema: Some(schema.to_string()),
            comment: row.get_string(2).filter(|s| !s.is_empty()).map(|s| s.to_string()),
        })
        .collect())
}

pub async fn get_columns(conn: &OracleClient, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    log::debug!("[oracle] get_columns: schema={schema}, table={table}");
    let s = quote_literal(schema);
    let t = quote_literal(table);

    let col_result = conn
        .query(
            &format!(
                "SELECT c.COLUMN_NAME, c.DATA_TYPE, c.NULLABLE, c.DATA_PRECISION, c.DATA_SCALE, c.DATA_LENGTH, \
                        c.CHAR_LENGTH, cc.COMMENTS, CASE WHEN pk.COLUMN_NAME IS NULL THEN 0 ELSE 1 END AS IS_PK \
                 FROM ALL_TAB_COLUMNS c \
                 LEFT JOIN ALL_COL_COMMENTS cc ON cc.OWNER = c.OWNER AND cc.TABLE_NAME = c.TABLE_NAME AND cc.COLUMN_NAME = c.COLUMN_NAME \
                 LEFT JOIN ( \
                   SELECT cols.COLUMN_NAME \
                   FROM ALL_CONS_COLUMNS cols \
                   JOIN ALL_CONSTRAINTS cons ON cols.CONSTRAINT_NAME = cons.CONSTRAINT_NAME AND cols.OWNER = cons.OWNER \
                   WHERE cons.CONSTRAINT_TYPE = 'P' AND cons.OWNER = {s} AND cons.TABLE_NAME = {t} \
                 ) pk ON pk.COLUMN_NAME = c.COLUMN_NAME \
                 WHERE c.OWNER = {s} AND c.TABLE_NAME = {t} \
                 ORDER BY c.COLUMN_ID"
            ),
            &[],
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(col_result
        .rows
        .iter()
        .map(|row| {
            let name = row.get_string(0).unwrap_or("").to_string();
            let base = row.get_string(1).unwrap_or("").to_string();
            let data_len = row.get_i64(5).map(|v| v as i32);
            let char_len = row.get_i64(6).map(|v| v as i32);
            let num_prec = row.get_i64(3).map(|v| v as i32);
            let num_scale = row.get_i64(4).map(|v| v as i32);
            let data_type = match base.to_uppercase().as_str() {
                "VARCHAR2" | "NVARCHAR2" | "CHAR" | "NCHAR" => {
                    let len = char_len.or(data_len);
                    match len {
                        Some(n) => format!("{base}({n})"),
                        None => base,
                    }
                }
                "NUMBER" => match (num_prec, num_scale) {
                    (Some(p), Some(s)) if s > 0 => format!("NUMBER({p},{s})"),
                    (Some(p), _) if p > 0 => format!("NUMBER({p})"),
                    _ => "NUMBER".to_string(),
                },
                "RAW" => match data_len {
                    Some(n) => format!("RAW({n})"),
                    None => "RAW".to_string(),
                },
                _ => base,
            };
            ColumnInfo {
                is_primary_key: row.get_i64(8).unwrap_or(0) == 1,
                name,
                data_type,
                is_nullable: row.get_string(2).unwrap_or("N") == "Y",
                column_default: None,
                extra: None,
                comment: row.get_string(7).filter(|s| !s.is_empty()).map(|s| s.to_string()),
                numeric_precision: num_prec,
                numeric_scale: num_scale,
                character_maximum_length: char_len,
            }
        })
        .collect())
}

pub async fn get_table_comment(conn: &OracleClient, schema: &str, table: &str) -> Result<Option<String>, String> {
    let s = quote_literal(schema);
    let t = quote_literal(table);
    let result = conn
        .query(&format!("SELECT COMMENTS FROM ALL_TAB_COMMENTS WHERE OWNER = {s} AND TABLE_NAME = {t}"), &[])
        .await
        .map_err(|e| e.to_string())?;
    Ok(result.rows.first().and_then(|row| row.get_string(0)).filter(|s| !s.is_empty()).map(|s| s.to_string()))
}

pub async fn list_indexes(conn: &OracleClient, schema: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
    let sql = format!(
        "SELECT i.INDEX_NAME, \
         LISTAGG(ic.COLUMN_NAME, ',') WITHIN GROUP (ORDER BY ic.COLUMN_POSITION) AS columns, \
         i.UNIQUENESS, \
         CASE WHEN c.CONSTRAINT_TYPE = 'P' THEN 1 ELSE 0 END AS IS_PK, \
         i.INDEX_TYPE \
         FROM ALL_INDEXES i \
         JOIN ALL_IND_COLUMNS ic ON i.INDEX_NAME = ic.INDEX_NAME AND i.OWNER = ic.INDEX_OWNER AND i.TABLE_OWNER = ic.TABLE_OWNER \
         LEFT JOIN ALL_CONSTRAINTS c ON i.INDEX_NAME = c.INDEX_NAME AND i.TABLE_OWNER = c.OWNER \
           AND c.CONSTRAINT_TYPE = 'P' \
         WHERE i.TABLE_OWNER = '{s}' AND i.TABLE_NAME = '{t}' \
         GROUP BY i.INDEX_NAME, i.UNIQUENESS, c.CONSTRAINT_TYPE, i.INDEX_TYPE \
         ORDER BY i.INDEX_NAME",
        s = schema.replace('\'', "''"), t = table.replace('\'', "''")
    );
    let result = conn.query(&sql, &[]).await.map_err(|e| e.to_string())?;
    Ok(result
        .rows
        .iter()
        .map(|row| {
            let cols_str = row.get_string(1).unwrap_or("");
            IndexInfo {
                name: row.get_string(0).unwrap_or("").to_string(),
                columns: cols_str.split(',').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect(),
                is_unique: row.get_string(2).unwrap_or("") == "UNIQUE",
                is_primary: row.get_i64(3).unwrap_or(0) == 1,
                filter: None,
                index_type: row.get_string(4).map(|s| s.to_string()),
                included_columns: None,
                comment: None,
            }
        })
        .collect())
}

pub async fn list_foreign_keys(conn: &OracleClient, schema: &str, table: &str) -> Result<Vec<ForeignKeyInfo>, String> {
    let sql = format!(
        "SELECT c.CONSTRAINT_NAME, cc.COLUMN_NAME, rc.TABLE_NAME, rcc.COLUMN_NAME \
         FROM ALL_CONSTRAINTS c \
         JOIN ALL_CONS_COLUMNS cc ON c.CONSTRAINT_NAME = cc.CONSTRAINT_NAME AND c.OWNER = cc.OWNER \
         JOIN ALL_CONSTRAINTS rc ON c.R_CONSTRAINT_NAME = rc.CONSTRAINT_NAME AND c.R_OWNER = rc.OWNER \
         JOIN ALL_CONS_COLUMNS rcc ON rc.CONSTRAINT_NAME = rcc.CONSTRAINT_NAME AND rc.OWNER = rcc.OWNER \
         WHERE c.CONSTRAINT_TYPE = 'R' AND c.OWNER = '{s}' AND c.TABLE_NAME = '{t}' \
         ORDER BY c.CONSTRAINT_NAME",
        s = schema.replace('\'', "''"),
        t = table.replace('\'', "''")
    );
    let result = conn.query(&sql, &[]).await.map_err(|e| e.to_string())?;
    Ok(result
        .rows
        .iter()
        .map(|row| ForeignKeyInfo {
            name: row.get_string(0).unwrap_or("").to_string(),
            column: row.get_string(1).unwrap_or("").to_string(),
            ref_table: row.get_string(2).unwrap_or("").to_string(),
            ref_column: row.get_string(3).unwrap_or("").to_string(),
        })
        .collect())
}

pub async fn list_triggers(conn: &OracleClient, schema: &str, table: &str) -> Result<Vec<TriggerInfo>, String> {
    let sql = format!(
        "SELECT TRIGGER_NAME, TRIGGERING_EVENT, TRIGGER_TYPE \
         FROM ALL_TRIGGERS \
         WHERE OWNER = '{s}' AND TABLE_NAME = '{t}' \
         ORDER BY TRIGGER_NAME",
        s = schema.replace('\'', "''"),
        t = table.replace('\'', "''")
    );
    let result = conn.query(&sql, &[]).await.map_err(|e| e.to_string())?;
    Ok(result
        .rows
        .iter()
        .map(|row| TriggerInfo {
            name: row.get_string(0).unwrap_or("").to_string(),
            event: row.get_string(1).unwrap_or("").to_string(),
            timing: row.get_string(2).unwrap_or("").to_string(),
        })
        .collect())
}

pub async fn execute_query_with_schema(conn: &OracleClient, schema: &str, sql: &str) -> Result<QueryResult, String> {
    let set_schema = format!("ALTER SESSION SET CURRENT_SCHEMA = \"{}\"", schema);
    log::info!("[oracle][set-schema:start] schema={schema}");
    conn.execute(&set_schema, &[]).await.map_err(|e| {
        log::error!("[oracle] set current_schema failed: {e}");
        e.to_string()
    })?;
    log::info!("[oracle][set-schema:done] schema={schema}");
    execute_query(conn, sql).await
}

pub async fn execute_query(conn: &OracleClient, sql: &str) -> Result<QueryResult, String> {
    let start = Instant::now();
    let sql = sql.trim().trim_end_matches(';');
    let explicit_limit = explicit_select_row_limit(sql);
    log::info!("[oracle][execute:start] explicit_limit={:?} sql={}", explicit_limit, sql);

    // Rewrite FETCH FIRST N ROWS ONLY → ROWNUM for Oracle 11g compatibility.
    let sql = rewrite_fetch_first(sql);
    log::info!("[oracle][execute:rewritten] sql={}", sql.as_ref());

    if starts_with_executable_sql_keyword(sql.as_ref(), &["SELECT", "WITH", "SHOW", "DESCRIBE", "EXPLAIN"]) {
        let capped_sql = cap_select_rows(sql.as_ref());
        let query_limit = explicit_limit.unwrap_or(ORACLE_QUERY_LIMIT).min(ORACLE_QUERY_LIMIT);
        log::info!(
            "[oracle][query_with_limit:start] query_limit={} fetch_size=500 sql={}",
            query_limit,
            capped_sql.as_ref()
        );
        let result = conn.query_with_limit(capped_sql.as_ref(), &[], query_limit, 500).await.map_err(|e| {
            log::error!("[oracle] execute_query SELECT failed: {e}");
            e.to_string()
        })?;
        log::info!(
            "[oracle][query_with_limit:done] column_count={} row_count={} has_more_rows={} elapsed_ms={}",
            result.columns.len(),
            result.rows.len(),
            result.has_more_rows,
            start.elapsed().as_millis()
        );
        let columns: Vec<String> = result.columns.iter().map(|c| c.name.clone()).collect();
        let mut rows: Vec<Vec<serde_json::Value>> = result
            .rows
            .iter()
            .map(|row| {
                (0..columns.len())
                    .map(|i| row.get(i).map(|v| value_to_json(v)).unwrap_or(serde_json::Value::Null))
                    .collect()
            })
            .collect();
        let truncated = rows.len() > crate::query::MAX_ROWS || result.has_more_rows;
        if rows.len() > crate::query::MAX_ROWS {
            rows.truncate(crate::query::MAX_ROWS);
        }

        log::info!(
            "[oracle][execute:done] column_count={} row_count={} truncated={} elapsed_ms={}",
            columns.len(),
            rows.len(),
            truncated,
            start.elapsed().as_millis()
        );
        Ok(QueryResult { columns, rows, affected_rows: 0, execution_time_ms: start.elapsed().as_millis(), truncated })
    } else {
        log::info!("[oracle][execute-non-select:start] sql={}", sql.as_ref());
        match conn.execute(sql.as_ref(), &[]).await {
            Ok(result) => {
                let _ = conn.commit().await;
                log::info!(
                    "[oracle][execute-non-select:done] affected_rows={} elapsed_ms={}",
                    result.rows_affected,
                    start.elapsed().as_millis()
                );
                Ok(QueryResult {
                    columns: vec![],
                    rows: vec![],
                    affected_rows: result.rows_affected,
                    execution_time_ms: start.elapsed().as_millis(),
                    truncated: false,
                })
            }
            Err(e) => {
                let msg = e.to_string();
                log::error!("[oracle][execute-non-select:error] {msg}");
                if msg.contains("Server rejected") || msg.contains("closed the connection") {
                    Err(format!("Operation failed (connection closed). Original driver error: {msg}"))
                } else {
                    Err(msg)
                }
            }
        }
    }
}

fn cap_select_rows(sql: &str) -> std::borrow::Cow<'_, str> {
    if !starts_with_executable_sql_keyword(sql, &["SELECT", "WITH"]) || has_for_update_clause(sql) {
        return std::borrow::Cow::Borrowed(sql);
    }

    std::borrow::Cow::Owned(format!("SELECT * FROM ({sql}) WHERE ROWNUM <= {ORACLE_QUERY_LIMIT}"))
}

fn has_for_update_clause(sql: &str) -> bool {
    sql.to_uppercase().contains(" FOR UPDATE")
}

fn explicit_select_row_limit(sql: &str) -> Option<usize> {
    fetch_first_row_limit(sql).or_else(|| rownum_row_limit(sql))
}

fn fetch_first_row_limit(sql: &str) -> Option<usize> {
    let upper = sql.to_uppercase();
    let fetch_pos = upper.find("FETCH FIRST").or_else(|| upper.find("FETCH NEXT"))?;
    let after_fetch = &upper[fetch_pos..];
    let end = after_fetch.find("ROWS ONLY")?;
    let keyword_len = if after_fetch.starts_with("FETCH FIRST") { 11 } else { 10 };
    sql[fetch_pos + keyword_len..fetch_pos + end].trim().parse::<usize>().ok()
}

fn rownum_row_limit(sql: &str) -> Option<usize> {
    let upper = sql.to_uppercase();
    let mut rest = upper.as_str();
    let mut best: Option<usize> = None;

    while let Some(pos) = rest.find("ROWNUM") {
        rest = &rest[pos + "ROWNUM".len()..];
        let trimmed = rest.trim_start();
        let value_start = if let Some(after) = trimmed.strip_prefix("<=") {
            after.trim_start()
        } else if let Some(after) = trimmed.strip_prefix('<') {
            if let Some(n) = parse_leading_usize(after.trim_start()) {
                let exclusive = n.saturating_sub(1);
                best = Some(best.map_or(exclusive, |current| current.min(exclusive)));
            }
            continue;
        } else {
            continue;
        };

        if let Some(n) = parse_leading_usize(value_start) {
            best = Some(best.map_or(n, |current| current.min(n)));
        }
    }

    best
}

fn parse_leading_usize(value: &str) -> Option<usize> {
    let digits: String = value.chars().take_while(|ch| ch.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

fn rewrite_fetch_first(sql: &str) -> std::borrow::Cow<'_, str> {
    let upper = sql.to_uppercase();
    // Match: ... [OFFSET M ROWS] FETCH FIRST|NEXT N ROWS ONLY
    let fetch_pos = upper.find("FETCH FIRST").or_else(|| upper.find("FETCH NEXT"));
    let Some(fpos) = fetch_pos else { return std::borrow::Cow::Borrowed(sql) };
    let after_fetch = &upper[fpos..];
    let Some(end) = after_fetch.find("ROWS ONLY") else { return std::borrow::Cow::Borrowed(sql) };
    let keyword_len = if after_fetch.starts_with("FETCH FIRST") { 11 } else { 10 };
    let between = sql[fpos + keyword_len..fpos + end].trim();
    let Ok(n) = between.parse::<u64>() else { return std::borrow::Cow::Borrowed(sql) };

    // Check for OFFSET M ROWS before FETCH
    let mut base = &sql[..fpos];
    let base_upper = base.to_uppercase();
    if let Some(opos) = base_upper.rfind("OFFSET ") {
        let after_offset = base_upper[opos + 7..].trim();
        if let Some(rpos) = after_offset.find(" ROWS") {
            let offset_str = after_offset[..rpos].trim();
            if let Ok(offset) = offset_str.parse::<u64>() {
                let inner = sql[..opos].trim_end();
                return std::borrow::Cow::Owned(format!(
                    "SELECT * FROM (SELECT a.*, ROWNUM rn__ FROM ({inner}) a WHERE ROWNUM <= {}) WHERE rn__ > {offset}",
                    offset + n
                ));
            }
        }
        base = sql[..opos].trim_end();
    } else {
        base = base.trim_end();
    }

    std::borrow::Cow::Owned(format!("SELECT * FROM ({base}) WHERE ROWNUM <= {n}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cap_select_rows_wraps_selects() {
        let sql = "SELECT * FROM users ORDER BY id";
        assert_eq!(cap_select_rows(sql), format!("SELECT * FROM ({sql}) WHERE ROWNUM <= {ORACLE_QUERY_LIMIT}"));
    }

    #[test]
    fn cap_select_rows_wraps_ctes() {
        let sql = "WITH recent AS (SELECT * FROM users) SELECT * FROM recent";
        assert_eq!(cap_select_rows(sql), format!("SELECT * FROM ({sql}) WHERE ROWNUM <= {ORACLE_QUERY_LIMIT}"));
    }

    #[test]
    fn cap_select_rows_keeps_for_update_queries() {
        let sql = "SELECT * FROM users FOR UPDATE";
        assert_eq!(cap_select_rows(sql), sql);
    }

    #[test]
    fn rewrite_fetch_first_to_rownum() {
        assert_eq!(
            rewrite_fetch_first("SELECT * FROM users FETCH FIRST 20 ROWS ONLY"),
            "SELECT * FROM (SELECT * FROM users) WHERE ROWNUM <= 20"
        );
    }

    #[test]
    fn explicit_select_row_limit_reads_fetch_first() {
        assert_eq!(explicit_select_row_limit("SELECT * FROM users FETCH FIRST 100 ROWS ONLY"), Some(100));
        assert_eq!(explicit_select_row_limit("SELECT * FROM users OFFSET 20 ROWS FETCH NEXT 50 ROWS ONLY"), Some(50));
    }

    #[test]
    fn explicit_select_row_limit_reads_rownum() {
        assert_eq!(explicit_select_row_limit("SELECT * FROM users WHERE ROWNUM <= 100"), Some(100));
        assert_eq!(explicit_select_row_limit("SELECT * FROM users WHERE ROWNUM < 101"), Some(100));
        assert_eq!(
            explicit_select_row_limit("SELECT * FROM (SELECT * FROM users WHERE ROWNUM <= 500) WHERE ROWNUM <= 100"),
            Some(100)
        );
    }
}
