use percent_encoding::percent_decode_str;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, LoadExtensionGuard, OpenFlags};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use super::file_validator::validate_file_path;
use crate::sql::starts_with_executable_sql_keyword;
use crate::types::{ColumnInfo, DatabaseInfo, ForeignKeyInfo, IndexInfo, QueryResult, TableInfo, TriggerInfo};

#[derive(Clone)]
pub struct SqliteHandle {
    conn: Arc<Mutex<Connection>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqliteExtensionSpec {
    pub path: String,
    pub entry_point: Option<String>,
}

impl SqliteHandle {
    pub fn with_connection<T, F>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce(&mut Connection) -> Result<T, String>,
    {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        f(&mut conn)
    }
}

pub async fn connect_path(path: &str) -> Result<SqliteHandle, String> {
    connect_path_with_options(path, false, Vec::new()).await
}

pub async fn connect_path_with_extensions(
    path: &str,
    extensions: Vec<SqliteExtensionSpec>,
) -> Result<SqliteHandle, String> {
    connect_path_with_options(path, false, extensions).await
}

pub async fn connect_path_create_if_missing(path: &str) -> Result<SqliteHandle, String> {
    connect_path_with_options(path, true, Vec::new()).await
}

async fn connect_path_with_options(
    path: &str,
    create_if_missing: bool,
    extensions: Vec<SqliteExtensionSpec>,
) -> Result<SqliteHandle, String> {
    let path = path.to_string();
    tokio::task::spawn_blocking(move || open_sqlite_handle(&path, create_if_missing, extensions))
        .await
        .map_err(|e| e.to_string())?
}

fn open_sqlite_handle(
    path: &str,
    create_if_missing: bool,
    extensions: Vec<SqliteExtensionSpec>,
) -> Result<SqliteHandle, String> {
    let is_memory = is_memory_database_path(path);
    if !is_memory && !create_if_missing {
        validate_file_path(path, is_network_path)?;
    }

    if !is_memory && create_if_missing {
        ensure_parent_dir(path)?;
    }

    let conn = if is_memory {
        Connection::open_in_memory().map_err(|e| format!("SQLite connection failed: {e}"))?
    } else {
        let mut flags = OpenFlags::SQLITE_OPEN_READ_WRITE;
        if create_if_missing {
            flags |= OpenFlags::SQLITE_OPEN_CREATE;
        }
        if is_network_path(path) {
            flags |= OpenFlags::SQLITE_OPEN_URI;
            Connection::open_with_flags(format!("file:{}?vfs=unix-nolock", path), flags)
                .map_err(|e| format!("SQLite connection failed: {e}"))?
        } else {
            Connection::open_with_flags(path, flags).map_err(|e| format!("SQLite connection failed: {e}"))?
        }
    };

    conn.busy_timeout(std::time::Duration::from_secs(10)).map_err(|e| e.to_string())?;
    load_sqlite_extensions(&conn, &extensions)?;

    Ok(SqliteHandle { conn: Arc::new(Mutex::new(conn)) })
}

fn load_sqlite_extensions(conn: &Connection, extensions: &[SqliteExtensionSpec]) -> Result<(), String> {
    if extensions.is_empty() {
        return Ok(());
    }

    // Extension loading is enabled only for the trusted paths from the connection config.
    let _guard =
        unsafe { LoadExtensionGuard::new(conn) }.map_err(|e| format!("SQLite extension loading failed: {e}"))?;
    for extension in extensions {
        unsafe { conn.load_extension(&extension.path, extension.entry_point.as_deref()) }
            .map_err(|e| format!("SQLite extension load failed ({}): {e}", extension.path))?;
    }
    Ok(())
}

pub fn sqlite_extension_specs_from_url_params(params: Option<&str>) -> Vec<SqliteExtensionSpec> {
    params
        .unwrap_or("")
        .trim()
        .trim_start_matches('?')
        .split('&')
        .filter_map(|part| {
            let (raw_key, raw_value) = part.split_once('=').unwrap_or((part, ""));
            let key = decode_url_param(raw_key);
            if key != "sqlite_extension" && key != "sqlite_extensions" {
                return None;
            }
            Some(decode_url_param(raw_value))
        })
        .flat_map(|value| value.lines().filter_map(parse_sqlite_extension_spec).collect::<Vec<_>>())
        .collect()
}

fn parse_sqlite_extension_spec(value: &str) -> Option<SqliteExtensionSpec> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let (path, entry_point) = match value.rsplit_once('|') {
        Some((path, entry_point)) if !path.trim().is_empty() && !entry_point.trim().is_empty() => {
            (path.trim(), Some(entry_point.trim().to_string()))
        }
        _ => (value, None),
    };
    Some(SqliteExtensionSpec { path: path.to_string(), entry_point })
}

fn decode_url_param(value: &str) -> String {
    percent_decode_str(&value.replace('+', " ")).decode_utf8_lossy().into_owned()
}

fn ensure_parent_dir(path: &str) -> Result<(), String> {
    if let Some(parent) = Path::new(path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn is_network_path(path: &str) -> bool {
    path.starts_with("\\\\") || path.starts_with("//") || path.contains("wsl.localhost") || path.contains("wsl$")
}

pub fn is_memory_database_path(path: &str) -> bool {
    path.trim().eq_ignore_ascii_case(":memory:")
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn connect_path_supports_memory_database_across_statements() {
        let pool = connect_path(":memory:").await.expect("connect in-memory SQLite");

        execute_query(&pool, "CREATE TABLE memory_probe (id INTEGER PRIMARY KEY, name TEXT);")
            .await
            .expect("create table");
        execute_query(&pool, "INSERT INTO memory_probe (name) VALUES ('Ada');").await.expect("insert row");
        let result = execute_query(&pool, "SELECT name FROM memory_probe WHERE id = 1;").await.expect("select row");

        assert_eq!(result.rows[0][0], serde_json::json!("Ada"));
    }

    #[test]
    fn sqlite_extension_specs_parse_repeated_and_multiline_url_params() {
        let params = "cache=shared&sqlite_extension=%2Fopt%2Fregexp.dylib&sqlite_extensions=%2Fopt%2Ftext.dylib%7Csqlite3_text_init%0A%2Fopt%2Fcrypto.dylib";

        assert_eq!(
            sqlite_extension_specs_from_url_params(Some(params)),
            vec![
                SqliteExtensionSpec { path: "/opt/regexp.dylib".to_string(), entry_point: None },
                SqliteExtensionSpec {
                    path: "/opt/text.dylib".to_string(),
                    entry_point: Some("sqlite3_text_init".to_string()),
                },
                SqliteExtensionSpec { path: "/opt/crypto.dylib".to_string(), entry_point: None },
            ],
        );
    }

    #[test]
    fn sqlite_extension_specs_ignore_empty_values() {
        assert!(sqlite_extension_specs_from_url_params(Some("sqlite_extension=&sqlite_extensions=%0A")).is_empty());
    }

    #[test]
    fn normalize_if_to_iif_basic() {
        assert_eq!(normalize_sqlite_sql("SELECT if(1, 'a', 'b')"), "SELECT IIF(1, 'a', 'b')");
        assert_eq!(normalize_sqlite_sql("SELECT if(1, if(0, 'x', 'y'), 'b')"), "SELECT IIF(1, IIF(0, 'x', 'y'), 'b')");
    }

    #[test]
    fn normalize_substring_to_substr() {
        assert_eq!(normalize_sqlite_sql("SELECT substring(name, 1, 3) FROM t"), "SELECT substr(name, 1, 3) FROM t");
        assert_eq!(normalize_sqlite_sql("SELECT substring(name, 2) FROM t"), "SELECT substr(name, 2) FROM t");
    }

    #[test]
    fn normalize_preserves_string_literals() {
        let sql = "SELECT 'if(1,2,3)' AS literal, 'substring(x,1,2)', if(1, 'ok', 'no')";
        let normalized = normalize_sqlite_sql(sql);
        assert_eq!(normalized, "SELECT 'if(1,2,3)' AS literal, 'substring(x,1,2)', IIF(1, 'ok', 'no')");
    }

    #[test]
    fn normalize_preserves_line_comments() {
        let sql = "-- if(1,2,3) is a comment\nSELECT if(1, 'x', 'y')";
        let normalized = normalize_sqlite_sql(sql);
        assert_eq!(normalized, "-- if(1,2,3) is a comment\nSELECT IIF(1, 'x', 'y')");
    }

    #[test]
    fn normalize_preserves_block_comments() {
        let sql = "/* if(1,2,3) */ SELECT if(1, 'x', 'y')";
        let normalized = normalize_sqlite_sql(sql);
        assert_eq!(normalized, "/* if(1,2,3) */ SELECT IIF(1, 'x', 'y')");
    }

    #[test]
    fn normalize_does_not_match_inside_words() {
        let sql = "SELECT difference, stiff, ifsubstring FROM t";
        let normalized = normalize_sqlite_sql(sql);
        assert_eq!(normalized, sql);
    }

    #[test]
    fn normalize_if_with_spaces_before_paren() {
        assert_eq!(normalize_sqlite_sql("SELECT if  (1, 'a', 'b')"), "SELECT IIF  (1, 'a', 'b')");
    }

    #[tokio::test]
    async fn view_with_if_function_works_after_normalization() {
        let pool = connect_path(":memory:").await.expect("connect in-memory SQLite");

        execute_query(&pool, "CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1), (2), (3);")
            .await
            .expect("create and populate table");

        execute_query(&pool, "CREATE VIEW v AS SELECT x, IIF(x > 1, 'big', 'small') AS label FROM t")
            .await
            .expect("create view");

        let result = execute_query(&pool, "SELECT * FROM v ORDER BY x").await.expect("query view");

        assert_eq!(result.rows.len(), 3);
        assert_eq!(result.rows[0][1], serde_json::json!("small"));
        assert_eq!(result.rows[1][1], serde_json::json!("big"));
    }

    #[tokio::test]
    async fn if_rewrite_works_in_direct_query() {
        let pool = connect_path(":memory:").await.expect("connect in-memory SQLite");

        let result = execute_query(&pool, "SELECT if(1 = 1, 'yes', 'no') AS answer")
            .await
            .expect("if() should be rewritten to IIF()");

        assert_eq!(result.rows[0][0], serde_json::json!("yes"));
    }

    #[tokio::test]
    async fn bundled_sqlite_math_functions_are_available() {
        let pool = connect_path(":memory:").await.expect("connect in-memory SQLite");

        let floor_result =
            execute_query(&pool, "WITH test(x) AS (VALUES (1.1), (1.2), (1.3)) SELECT FLOOR(x) FROM test")
                .await
                .expect("FLOOR() should be available");

        assert_eq!(floor_result.rows.len(), 3);
        for row in floor_result.rows {
            assert_eq!(row[0].as_f64(), Some(1.0));
        }

        let result = execute_query(&pool, "SELECT ACOS(1.0), ACOSH(1.0), ASIN(0.0), CEIL(1.2), PI()")
            .await
            .expect("SQLite math functions should be available");

        assert_eq!(result.rows[0][0].as_f64(), Some(0.0));
        assert_eq!(result.rows[0][1].as_f64(), Some(0.0));
        assert_eq!(result.rows[0][2].as_f64(), Some(0.0));
        assert_eq!(result.rows[0][3].as_f64(), Some(2.0));
        let pi = result.rows[0][4].as_f64().expect("PI() returns a real value");
        assert!((std::f64::consts::PI - pi).abs() < 0.00001);
    }

    #[tokio::test]
    async fn substring_rewrite_works_in_direct_query() {
        let pool = connect_path(":memory:").await.expect("connect in-memory SQLite");

        execute_query(&pool, "CREATE TABLE t (name TEXT); INSERT INTO t VALUES ('hello');").await.expect("setup");

        let result = execute_query(&pool, "SELECT substring(name, 1, 2) AS s FROM t")
            .await
            .expect("substring() should be rewritten to substr()");

        assert_eq!(result.rows[0][0], serde_json::json!("he"));
    }

    #[tokio::test]
    async fn both_rewrites_combined() {
        let pool = connect_path(":memory:").await.expect("connect in-memory SQLite");

        execute_query(&pool, "CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1), (2);").await.expect("setup");

        let result = execute_query(&pool, "SELECT substring(if(x > 1, 'big', 'small'), 1, 1) AS s FROM t ORDER BY x")
            .await
            .expect("combined rewrite");

        assert_eq!(result.rows[0][0], serde_json::json!("s"));
        assert_eq!(result.rows[1][0], serde_json::json!("b"));
    }
}

pub async fn list_databases(_pool: &SqliteHandle) -> Result<Vec<DatabaseInfo>, String> {
    Ok(vec![DatabaseInfo { name: "main".to_string() }])
}

pub async fn list_tables(pool: &SqliteHandle, _schema: &str) -> Result<Vec<TableInfo>, String> {
    let pool = pool.clone();
    tokio::task::spawn_blocking(move || {
        pool.with_connection(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT name, type FROM sqlite_master \
                     WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    let table_type: String = row.get(1)?;
                    Ok(TableInfo {
                        name: row.get(0)?,
                        table_type: if table_type == "view" { "VIEW".to_string() } else { "BASE TABLE".to_string() },
                        comment: None,
                        parent_schema: None,
                        parent_name: None,
                    })
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn get_columns(pool: &SqliteHandle, _schema: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    let pool = pool.clone();
    let table = table.to_string();
    tokio::task::spawn_blocking(move || {
        let sql = format!("PRAGMA table_info(\"{}\")", table.replace('"', "\"\""));
        pool.with_connection(|conn| {
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(ColumnInfo {
                        name: row.get("name")?,
                        data_type: row.get("type")?,
                        is_nullable: row.get::<_, i32>("notnull")? == 0,
                        column_default: row.get("dflt_value")?,
                        is_primary_key: row.get::<_, i32>("pk")? > 0,
                        extra: None,
                        comment: None,
                        numeric_precision: None,
                        numeric_scale: None,
                        character_maximum_length: None,
                    })
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn list_indexes(pool: &SqliteHandle, _schema: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
    let pool = pool.clone();
    let table = table.to_string();
    tokio::task::spawn_blocking(move || {
        let safe_table = table.replace('"', "\"\"");
        pool.with_connection(|conn| {
            let mut stmt = conn.prepare(&format!("PRAGMA index_list(\"{safe_table}\")")).map_err(|e| e.to_string())?;
            let idx_rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>("name")?,
                        row.get::<_, i32>("unique")? != 0,
                        row.get::<_, String>("origin")?,
                    ))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;

            let mut indexes = Vec::new();
            for (name, is_unique, origin) in idx_rows {
                let safe_name = name.replace('"', "\"\"");
                let mut col_stmt =
                    conn.prepare(&format!("PRAGMA index_info(\"{safe_name}\")")).map_err(|e| e.to_string())?;
                let columns = col_stmt
                    .query_map([], |row| row.get::<_, String>("name"))
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;

                indexes.push(IndexInfo {
                    name,
                    columns,
                    is_unique,
                    is_primary: origin == "pk",
                    filter: None,
                    index_type: None,
                    included_columns: None,
                    comment: None,
                });
            }
            Ok(indexes)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn list_foreign_keys(pool: &SqliteHandle, _schema: &str, table: &str) -> Result<Vec<ForeignKeyInfo>, String> {
    let pool = pool.clone();
    let table = table.to_string();
    tokio::task::spawn_blocking(move || {
        let sql = format!("PRAGMA foreign_key_list(\"{}\")", table.replace('"', "\"\""));
        pool.with_connection(|conn| {
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(ForeignKeyInfo {
                        name: format!("fk_{}", row.get::<_, i32>("id")?),
                        column: row.get("from")?,
                        ref_schema: None,
                        ref_table: row.get("table")?,
                        ref_column: row.get("to")?,
                    })
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn list_triggers(pool: &SqliteHandle, _schema: &str, table: &str) -> Result<Vec<TriggerInfo>, String> {
    let pool = pool.clone();
    let table = table.to_string();
    tokio::task::spawn_blocking(move || {
        pool.with_connection(|conn| {
            let mut stmt = conn
                .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([table], |row| {
                    let sql_text: Option<String> = row.get("sql")?;
                    let upper = sql_text.unwrap_or_default().to_uppercase();
                    let timing = if upper.contains("BEFORE") {
                        "BEFORE"
                    } else if upper.contains("AFTER") {
                        "AFTER"
                    } else {
                        "INSTEAD OF"
                    };
                    let event = if upper.contains("INSERT") {
                        "INSERT"
                    } else if upper.contains("UPDATE") {
                        "UPDATE"
                    } else {
                        "DELETE"
                    };
                    Ok(TriggerInfo { name: row.get("name")?, event: event.to_string(), timing: timing.to_string() })
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn execute_query(pool: &SqliteHandle, sql: &str) -> Result<QueryResult, String> {
    execute_query_with_max_rows(pool, sql, None).await
}

fn query_result_row_limit(max_rows: Option<usize>) -> usize {
    max_rows.unwrap_or(crate::query::MAX_ROWS).max(1)
}

const SQLITE_FUNCTION_ALIASES: &[(&str, &str)] = &[("if", "IIF"), ("substring", "substr")];

fn normalize_sqlite_sql(sql: &str) -> String {
    let mut result = String::with_capacity(sql.len());
    let chars: Vec<char> = sql.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        if i + 1 < len && chars[i] == '-' && chars[i + 1] == '-' {
            while i < len && chars[i] != '\n' {
                result.push(chars[i]);
                i += 1;
            }
            continue;
        }

        if i + 1 < len && chars[i] == '/' && chars[i + 1] == '*' {
            while i + 1 < len && !(chars[i] == '*' && chars[i + 1] == '/') {
                result.push(chars[i]);
                i += 1;
            }
            if i + 1 < len {
                result.push(chars[i]);
                result.push(chars[i + 1]);
                i += 2;
            }
            continue;
        }

        if chars[i] == '\'' {
            result.push(chars[i]);
            i += 1;
            while i < len {
                if chars[i] == '\'' {
                    result.push('\'');
                    i += 1;
                    if i < len && chars[i] == '\'' {
                        result.push('\'');
                        i += 1;
                    } else {
                        break;
                    }
                } else {
                    result.push(chars[i]);
                    i += 1;
                }
            }
            continue;
        }

        let prev = if i == 0 { '\0' } else { chars[i - 1] };
        let boundary = !prev.is_alphanumeric() && prev != '_' && prev != '.';

        if boundary {
            let remaining: String = chars[i..].iter().collect();
            let remaining_lower = remaining.to_lowercase();

            let mut matched = false;
            for (source, replacement) in SQLITE_FUNCTION_ALIASES {
                if remaining_lower.starts_with(*source) && chars.get(i + source.len()) != Some(&'_') {
                    let mut j = i + source.len();
                    while j < len && chars[j].is_whitespace() {
                        j += 1;
                    }
                    if j < len && chars[j] == '(' {
                        let whitespace: String = chars[i + source.len()..j].iter().collect();
                        result.push_str(replacement);
                        result.push_str(&whitespace);
                        i = j;
                        matched = true;
                        break;
                    }
                }
            }
            if matched {
                continue;
            }
        }

        result.push(chars[i]);
        i += 1;
    }

    result
}

pub async fn execute_query_with_max_rows(
    pool: &SqliteHandle,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    let pool = pool.clone();
    let sql = normalize_sqlite_sql(sql);
    tokio::task::spawn_blocking(move || execute_query_blocking(&pool, &sql, max_rows))
        .await
        .map_err(|e| e.to_string())?
}

fn execute_query_blocking(pool: &SqliteHandle, sql: &str, max_rows: Option<usize>) -> Result<QueryResult, String> {
    let start = Instant::now();
    let row_limit = query_result_row_limit(max_rows);

    pool.with_connection(|conn| {
        if starts_with_executable_sql_keyword(sql, &["SELECT", "PRAGMA", "EXPLAIN", "WITH"]) {
            let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
            let columns = stmt.column_names().iter().map(|name| name.to_string()).collect::<Vec<_>>();
            let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
            let mut result_rows = Vec::new();

            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let mut values = Vec::with_capacity(columns.len());
                for i in 0..columns.len() {
                    values.push(value_ref_to_json(row.get_ref(i).map_err(|e| e.to_string())?));
                }
                result_rows.push(values);
                if result_rows.len() > row_limit {
                    break;
                }
            }

            let truncated = result_rows.len() > row_limit;
            if truncated {
                result_rows.truncate(row_limit);
            }

            Ok(QueryResult {
                columns,
                rows: result_rows,
                affected_rows: 0,
                execution_time_ms: start.elapsed().as_millis(),
                truncated,
                session_id: None,
                has_more: false,
            })
        } else {
            conn.execute_batch(sql).map_err(|e| e.to_string())?;
            Ok(QueryResult {
                columns: vec![],
                rows: vec![],
                affected_rows: conn.changes(),
                execution_time_ms: start.elapsed().as_millis(),
                truncated: false,
                session_id: None,
                has_more: false,
            })
        }
    })
}

fn value_ref_to_json(value: ValueRef<'_>) -> serde_json::Value {
    match value {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(v) => super::safe_i64_to_json(v),
        ValueRef::Real(v) => {
            serde_json::Number::from_f64(v).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
        }
        ValueRef::Text(v) => serde_json::Value::String(String::from_utf8_lossy(v).to_string()),
        ValueRef::Blob(v) => super::binary_value_to_json(v),
    }
}
