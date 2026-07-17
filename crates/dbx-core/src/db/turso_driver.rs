use reqwest::Client as HttpClient;
use serde::Deserialize;
use std::time::{Duration, Instant};

use super::{http_client_builder, with_connection_timeout};
use crate::sql::starts_with_executable_sql_keyword;
use crate::types::{
    ColumnInfo, DatabaseInfo, ForeignKeyInfo, IndexInfo, ObjectSource, ObjectSourceKind, QueryResult, TableInfo,
    TriggerInfo,
};

#[derive(Clone)]
pub struct TursoClient {
    http: HttpClient,
    base_url: String,
    auth_token: String,
}

impl TursoClient {
    pub fn new(url: &str, auth_token: &str, tls_enabled: bool, timeout: Duration) -> Result<Self, String> {
        let mut builder = http_client_builder(timeout);
        if turso_accept_invalid_certs(tls_enabled) {
            builder = builder.danger_accept_invalid_certs(true);
        }
        let http = builder.build().map_err(|e| format!("Failed to configure Turso HTTP client: {e}"))?;
        Ok(Self { http, base_url: url.trim_end_matches('/').to_string(), auth_token: auth_token.to_string() })
    }

    fn post_pipeline(&self, sql: &str) -> reqwest::RequestBuilder {
        let requests = vec![serde_json::json!({
            "type": "execute",
            "stmt": { "sql": sql }
        })];
        self.post_pipeline_requests(&requests)
    }

    fn post_pipeline_batch(&self, statements: &[&str]) -> reqwest::RequestBuilder {
        let requests: Vec<_> = statements
            .iter()
            .map(|sql| {
                serde_json::json!({
                    "type": "execute",
                    "stmt": { "sql": sql }
                })
            })
            .collect();
        self.post_pipeline_requests(&requests)
    }

    fn post_pipeline_requests(&self, requests: &[serde_json::Value]) -> reqwest::RequestBuilder {
        self.http
            .post(format!("{}/v2/pipeline", self.base_url))
            .header("Authorization", format!("Bearer {}", self.auth_token))
            .json(&serde_json::json!({ "requests": requests }))
    }
}

/// Turso libSQL HTTP API response types

#[derive(Debug, Deserialize)]
struct TursoPipelineResponse {
    #[serde(default)]
    results: Vec<TursoPipelineResult>,
    #[serde(default)]
    #[allow(dead_code)]
    baton: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    base_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TursoPipelineResult {
    #[serde(rename = "type")]
    result_type: String,
    /// Present when result_type is "ok"
    #[serde(default)]
    response: Option<TursoResponseEnvelope>,
    /// Present when result_type is "error"
    #[serde(default)]
    error: Option<TursoError>,
}

#[derive(Debug, Deserialize)]
struct TursoResponseEnvelope {
    #[serde(rename = "type")]
    #[allow(dead_code)]
    response_type: String,
    #[serde(default)]
    result: Option<TursoResultSet>,
}

#[derive(Debug, Deserialize)]
struct TursoResultSet {
    #[serde(default)]
    cols: Vec<TursoColumn>,
    #[serde(default)]
    rows: Vec<Vec<TursoValue>>,
    #[serde(default)]
    #[allow(dead_code)]
    rows_read: Option<u64>,
    #[serde(default)]
    #[allow(dead_code)]
    rows_written: Option<u64>,
    #[serde(default)]
    affected_row_count: Option<u64>,
}

#[derive(Debug, Deserialize, Clone)]
struct TursoColumn {
    name: String,
    #[serde(default)]
    #[allow(dead_code)]
    decltype: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
struct TursoValue {
    #[serde(rename = "type", default)]
    value_type: String,
    #[serde(default)]
    value: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct TursoError {
    message: String,
    #[serde(default)]
    #[allow(dead_code)]
    code: Option<String>,
}

// ─── Public API ───────────────────────────────────────────────────────────────

pub async fn test_connection(client: &TursoClient, timeout: Duration) -> Result<(), String> {
    with_connection_timeout("turso", timeout, async { execute_inner(client, "SELECT 1").await.map(|_| ()) }).await
}

pub async fn list_databases(_client: &TursoClient) -> Result<Vec<DatabaseInfo>, String> {
    Ok(vec![DatabaseInfo { name: "main".to_string() }])
}

pub async fn list_tables(client: &TursoClient, _schema: &str) -> Result<Vec<TableInfo>, String> {
    let result = query_inner(
        client,
        "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .await?;
    Ok(result
        .values
        .into_iter()
        .map(|row| {
            let table_type = value_as_string(row.get(1)).unwrap_or_else(|| "table".to_string());
            TableInfo {
                name: value_as_string(row.first()).unwrap_or_default(),
                table_type: if table_type.eq_ignore_ascii_case("view") { "VIEW" } else { "BASE TABLE" }.to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            }
        })
        .collect())
}

pub async fn get_columns(client: &TursoClient, _schema: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    let result = query_inner(client, &format!("PRAGMA table_info({})", sqlite_ident(table))).await?;
    Ok(result
        .values
        .into_iter()
        .map(|row| ColumnInfo {
            name: value_by_column(&result.columns, &row, "name").unwrap_or_default(),
            data_type: value_by_column(&result.columns, &row, "type").unwrap_or_default(),
            is_nullable: value_by_column(&result.columns, &row, "notnull")
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(0)
                == 0,
            column_default: value_by_column(&result.columns, &row, "dflt_value"),
            is_primary_key: value_by_column(&result.columns, &row, "pk")
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(0)
                > 0,
            extra: None,
            comment: None,
            numeric_precision: None,
            numeric_scale: None,
            character_maximum_length: None,
            enum_values: None,
            ..Default::default()
        })
        .collect())
}

pub async fn list_indexes(client: &TursoClient, _schema: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
    let result = query_inner(client, &format!("PRAGMA index_list({})", sqlite_ident(table))).await?;
    let mut indexes = Vec::new();

    for row in result.values {
        let name = value_by_column(&result.columns, &row, "name").unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let is_unique =
            value_by_column(&result.columns, &row, "unique").and_then(|value| value.parse::<i64>().ok()).unwrap_or(0)
                != 0;
        let origin = value_by_column(&result.columns, &row, "origin").unwrap_or_default();
        let column_result = query_inner(client, &format!("PRAGMA index_info({})", sqlite_ident(&name))).await?;
        let columns = column_result
            .values
            .iter()
            .filter_map(|row| value_by_column(&column_result.columns, row, "name"))
            .collect();
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
}

pub async fn list_foreign_keys(
    client: &TursoClient,
    _schema: &str,
    table: &str,
) -> Result<Vec<ForeignKeyInfo>, String> {
    let result = query_inner(client, &format!("PRAGMA foreign_key_list({})", sqlite_ident(table))).await?;
    Ok(result
        .values
        .into_iter()
        .map(|row| ForeignKeyInfo {
            name: format!("fk_{}", value_by_column(&result.columns, &row, "id").unwrap_or_else(|| "0".to_string())),
            column: value_by_column(&result.columns, &row, "from").unwrap_or_default(),
            ref_schema: None,
            ref_table: value_by_column(&result.columns, &row, "table").unwrap_or_default(),
            ref_column: value_by_column(&result.columns, &row, "to").unwrap_or_default(),
            on_update: None,
            on_delete: None,
        })
        .collect())
}

pub async fn list_triggers(client: &TursoClient, _schema: &str, table: &str) -> Result<Vec<TriggerInfo>, String> {
    let result = query_inner(
        client,
        &format!(
            "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = {} ORDER BY name",
            sqlite_string(table)
        ),
    )
    .await?;
    Ok(result
        .values
        .into_iter()
        .map(|row| {
            let sql_text = value_as_string(row.get(1)).unwrap_or_default().to_uppercase();
            let timing = if sql_text.contains("BEFORE") {
                "BEFORE"
            } else if sql_text.contains("AFTER") {
                "AFTER"
            } else {
                "INSTEAD OF"
            };
            let event = if sql_text.contains("INSERT") {
                "INSERT"
            } else if sql_text.contains("UPDATE") {
                "UPDATE"
            } else {
                "DELETE"
            };
            TriggerInfo {
                name: value_as_string(row.first()).unwrap_or_default(),
                event: event.to_string(),
                timing: timing.to_string(),
                statement: value_as_string(row.get(1)),
            }
        })
        .collect())
}

pub async fn table_ddl(client: &TursoClient, table: &str) -> Result<String, String> {
    first_string_cell(
        query_inner(
            client,
            &format!("SELECT sql FROM sqlite_master WHERE type='table' AND name={}", sqlite_string(table)),
        )
        .await?,
    )
}

pub async fn object_source(
    client: &TursoClient,
    name: &str,
    object_type: &ObjectSourceKind,
) -> Result<ObjectSource, String> {
    let kind = match object_type {
        ObjectSourceKind::View => "view",
        _ => return Err("Object source is not supported for this Turso object type".to_string()),
    };
    let source = first_string_cell(
        query_inner(
            client,
            &format!(
                "SELECT sql FROM sqlite_master WHERE type={} AND name={}",
                sqlite_string(kind),
                sqlite_string(name)
            ),
        )
        .await?,
    )?;
    Ok(ObjectSource { name: name.to_string(), object_type: object_type.clone(), schema: None, source, editable: None })
}

pub async fn execute_query(client: &TursoClient, sql: &str) -> Result<QueryResult, String> {
    execute_query_with_max_rows(client, sql, None).await
}

pub async fn execute_query_with_max_rows(
    client: &TursoClient,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    let start = Instant::now();

    // Split multi-statement SQL: each statement in the pipeline is part of a
    // single implicit transaction, so BEGIN/INSERT/COMMIT must travel together.
    let statements: Vec<&str> = split_sql_statements(sql);
    let is_reader = statements.len() == 1
        && starts_with_executable_sql_keyword(statements[0], &["SELECT", "PRAGMA", "EXPLAIN", "WITH"]);

    // Single-statement transaction control: Turso pipelines are implicitly
    // auto-committed, so standalone BEGIN/COMMIT/ROLLBACK are no-ops.
    let is_tx_control = statements.len() == 1
        && starts_with_executable_sql_keyword(statements[0], &["BEGIN", "COMMIT", "ROLLBACK", "START", "END"]);

    if is_tx_control {
        return Ok(QueryResult {
            columns: vec![],
            column_types: Vec::new(),
            column_sortables: vec![],
            rows: vec![],
            affected_rows: 0,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        });
    }

    if is_reader {
        let result = query_inner(client, statements[0]).await?;
        Ok(query_result_from_turso_result(result, start.elapsed().as_millis(), max_rows))
    } else if statements.len() == 1 {
        let affected_rows = execute_inner(client, statements[0]).await?;
        Ok(QueryResult {
            columns: vec![],
            column_types: Vec::new(),
            column_sortables: vec![],
            rows: vec![],
            affected_rows,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        })
    } else {
        // Batch multiple statements into a single pipeline for transactional integrity
        let result_set = send_pipeline_batch(client, &statements).await?;
        let affected = result_set.affected_row_count.unwrap_or(0);
        Ok(QueryResult {
            columns: vec![],
            column_types: Vec::new(),
            column_sortables: vec![],
            rows: vec![],
            affected_rows: affected,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        })
    }
}

/// Split SQL text on statement boundaries (naive split on `;` that respects
/// basic quoting; sufficient for the multi-statement batching use case).
fn split_sql_statements(sql: &str) -> Vec<&str> {
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return vec![];
    }
    let mut stmts: Vec<&str> = Vec::new();
    let mut start = 0;
    let bytes = trimmed.as_bytes();
    let mut in_single = false;
    let mut in_double = false;
    for (i, &b) in bytes.iter().enumerate() {
        match b {
            b'\'' if !in_double => in_single = !in_single,
            b'"' if !in_single => in_double = !in_double,
            b';' if !in_single && !in_double => {
                let stmt = trimmed[start..i].trim();
                if !stmt.is_empty() {
                    stmts.push(stmt);
                }
                start = i + 1;
            }
            _ => {}
        }
    }
    let last = trimmed[start..].trim();
    if !last.is_empty() && last != ";" {
        stmts.push(last);
    }
    stmts
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async fn query_inner(client: &TursoClient, sql: &str) -> Result<TursoExtractedResult, String> {
    let result_set = send_pipeline_for_result_set(client, sql).await?;
    Ok(extract_result(result_set))
}

async fn execute_inner(client: &TursoClient, sql: &str) -> Result<u64, String> {
    let result_set = send_pipeline_for_result_set(client, sql).await?;
    Ok(result_set.affected_row_count.unwrap_or(0))
}

async fn send_pipeline_for_result_set(client: &TursoClient, sql: &str) -> Result<TursoResultSet, String> {
    let result = send_pipeline(client, sql).await?;
    match result {
        TursoPipelineResult { result_type, response: Some(resp), error: None } if result_type == "ok" => {
            match resp.result {
                Some(rs) => Ok(rs),
                None => Err("Turso response missing result".to_string()),
            }
        }
        TursoPipelineResult { error: Some(err), .. } => Err(format!("Turso error: {}", err.message)),
        other => Err(format!("Unexpected Turso result type: {}", other.result_type)),
    }
}

async fn send_pipeline(client: &TursoClient, sql: &str) -> Result<TursoPipelineResult, String> {
    let resp = client.post_pipeline(sql).send().await.map_err(|e| format!("Turso request failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("Turso response read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("Turso error ({}): {}", status.as_u16(), body));
    }
    let response: TursoPipelineResponse =
        serde_json::from_str(&body).map_err(|e| format!("Turso parse error: {e}; body: {body}"))?;
    response.results.into_iter().next().ok_or_else(|| "Turso returned no result".to_string())
}

async fn send_pipeline_batch(client: &TursoClient, statements: &[&str]) -> Result<TursoResultSet, String> {
    let resp = client.post_pipeline_batch(statements).send().await.map_err(|e| format!("Turso request failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("Turso response read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("Turso error ({}): {}", status.as_u16(), body));
    }
    let response: TursoPipelineResponse =
        serde_json::from_str(&body).map_err(|e| format!("Turso parse error: {e}; body: {body}"))?;

    // For batch, take the last result (COMMIT result for BEGIN/INSERT/COMMIT patterns)
    let mut last_result_set =
        TursoResultSet { cols: vec![], rows: vec![], rows_read: None, rows_written: None, affected_row_count: Some(0) };
    for result in &response.results {
        match result {
            TursoPipelineResult { result_type, error: Some(err), .. } if result_type == "error" => {
                return Err(format!("Turso error: {}", err.message));
            }
            TursoPipelineResult { response: Some(resp), .. } => {
                if let Some(rs) = &resp.result {
                    last_result_set = TursoResultSet {
                        cols: rs.cols.clone(),
                        rows: rs.rows.clone(),
                        rows_read: rs.rows_read,
                        rows_written: rs.rows_written,
                        affected_row_count: Some(
                            last_result_set.affected_row_count.unwrap_or(0) + rs.affected_row_count.unwrap_or(0),
                        ),
                    };
                }
            }
            _ => {}
        }
    }
    Ok(last_result_set)
}

/// Internal result representation with decoded columns and rows
struct TursoExtractedResult {
    columns: Vec<String>,
    values: Vec<Vec<serde_json::Value>>,
    #[allow(dead_code)]
    rows_written: Option<u64>,
}

fn extract_result(result_set: TursoResultSet) -> TursoExtractedResult {
    let columns: Vec<String> = result_set.cols.iter().map(|c| c.name.clone()).collect();
    let values: Vec<Vec<serde_json::Value>> =
        result_set.rows.into_iter().map(|row| row.into_iter().map(turso_value_to_json).collect()).collect();
    TursoExtractedResult { columns, values, rows_written: result_set.rows_written }
}

fn turso_value_to_json(v: TursoValue) -> serde_json::Value {
    match v.value {
        Some(val) => match v.value_type.as_str() {
            "integer" => val
                .as_str()
                .and_then(|s| s.parse::<i64>().ok())
                .map(serde_json::Value::from)
                .unwrap_or(serde_json::Value::Null),
            "float" => val
                .as_str()
                .and_then(|s| s.parse::<f64>().ok())
                .map(|f| serde_json::json!(f))
                .unwrap_or(serde_json::Value::Null),
            "text" => serde_json::Value::String(val.as_str().unwrap_or("").to_string()),
            "null" => serde_json::Value::Null,
            "blob" => {
                // Blobs in Turso are base64-encoded strings
                let hex = val.as_str().map(base64_to_hex).unwrap_or_else(|| val.to_string());
                serde_json::Value::String(format!("0x{}", hex))
            }
            _ => {
                // Fallback: try to use the raw value
                val
            }
        },
        None => serde_json::Value::Null,
    }
}

fn base64_to_hex(_b64: &str) -> String {
    // For blob values, we pass through as-is if not parseable
    // A full base64→hex implementation can be added later
    _b64.to_string()
}

fn query_result_from_turso_result(
    mut result: TursoExtractedResult,
    execution_time_ms: u128,
    max_rows: Option<usize>,
) -> QueryResult {
    let row_limit = max_rows.unwrap_or(crate::query::MAX_ROWS).max(1);
    let truncated = result.values.len() > row_limit;
    if truncated {
        result.values.truncate(row_limit);
    }
    QueryResult {
        columns: result.columns,
        column_types: Vec::new(),
        column_sortables: vec![],
        rows: result.values,
        affected_rows: 0,
        execution_time_ms,
        truncated,
        session_id: None,
        has_more: false,
    }
}

fn first_string_cell(result: TursoExtractedResult) -> Result<String, String> {
    result
        .values
        .first()
        .and_then(|row| row.first())
        .and_then(|value| value_as_string(Some(value)))
        .ok_or_else(|| "Object not found".to_string())
}

fn value_by_column(columns: &[String], row: &[serde_json::Value], name: &str) -> Option<String> {
    columns
        .iter()
        .position(|column| column.eq_ignore_ascii_case(name))
        .and_then(|index| row.get(index))
        .and_then(|value| value_as_string(Some(value)))
}

fn value_as_string(value: Option<&serde_json::Value>) -> Option<String> {
    match value? {
        serde_json::Value::Null => None,
        serde_json::Value::String(value) => Some(value.clone()),
        serde_json::Value::Number(value) => Some(value.to_string()),
        serde_json::Value::Bool(value) => Some(value.to_string()),
        other => Some(other.to_string()),
    }
}

fn sqlite_ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn sqlite_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn turso_accept_invalid_certs(tls_enabled: bool) -> bool {
    tls_enabled
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_query_result_and_truncates_rows() {
        let result = TursoExtractedResult {
            columns: vec!["id".to_string(), "name".to_string()],
            values: vec![
                vec![serde_json::json!(1), serde_json::json!("Ada")],
                vec![serde_json::json!(2), serde_json::json!("Linus")],
            ],
            rows_written: None,
        };

        let result = query_result_from_turso_result(result, 8, Some(1));

        assert_eq!(result.columns, vec!["id", "name"]);
        assert_eq!(result.rows, vec![vec![serde_json::json!(1), serde_json::json!("Ada")]]);
        assert_eq!(result.execution_time_ms, 8);
        assert!(result.truncated);
    }

    #[test]
    fn maps_column_values_by_name_case_insensitive() {
        let columns = vec!["name".to_string(), "notnull".to_string(), "pk".to_string()];
        let row = vec![serde_json::json!("id"), serde_json::json!(1), serde_json::json!(1)];

        assert_eq!(value_by_column(&columns, &row, "NAME").as_deref(), Some("id"));
        assert_eq!(value_by_column(&columns, &row, "notnull").as_deref(), Some("1"));
    }

    #[test]
    fn split_sql_statements_splits_on_semicolons() {
        assert_eq!(split_sql_statements("SELECT 1"), vec!["SELECT 1"]);
        assert_eq!(
            split_sql_statements("BEGIN; INSERT INTO t VALUES (1); COMMIT"),
            vec!["BEGIN", "INSERT INTO t VALUES (1)", "COMMIT"]
        );
        assert_eq!(split_sql_statements("SELECT 1;  "), vec!["SELECT 1"]);
        assert_eq!(split_sql_statements("  ;  "), Vec::<&str>::new());
        assert_eq!(split_sql_statements("SELECT 'a;b' AS x"), vec!["SELECT 'a;b' AS x"]);
        assert_eq!(split_sql_statements("SELECT \"a;b\" AS x; SELECT 2"), vec!["SELECT \"a;b\" AS x", "SELECT 2"]);
    }

    #[test]
    fn value_as_string_converts_types() {
        assert_eq!(value_as_string(Some(&serde_json::json!("hello"))), Some("hello".to_string()));
        assert_eq!(value_as_string(Some(&serde_json::json!(42))), Some("42".to_string()));
        assert_eq!(value_as_string(Some(&serde_json::json!(true))), Some("true".to_string()));
        assert_eq!(value_as_string(Some(&serde_json::json!(null))), None);
    }

    #[test]
    fn turso_value_integer_parsed() {
        let v = TursoValue { value_type: "integer".to_string(), value: Some(serde_json::json!("42")) };
        assert_eq!(turso_value_to_json(v), serde_json::json!(42));
    }

    #[test]
    fn turso_value_text_parsed() {
        let v = TursoValue { value_type: "text".to_string(), value: Some(serde_json::json!("hello")) };
        assert_eq!(turso_value_to_json(v), serde_json::json!("hello"));
    }

    #[test]
    fn turso_value_null_parsed() {
        let v = TursoValue { value_type: "null".to_string(), value: None };
        assert_eq!(turso_value_to_json(v), serde_json::Value::Null);
    }

    #[test]
    #[allow(clippy::approx_constant)]
    fn turso_value_float_parsed() {
        let v = TursoValue { value_type: "float".to_string(), value: Some(serde_json::json!("3.14")) };
        assert_eq!(turso_value_to_json(v), serde_json::json!(3.14));
    }

    #[test]
    fn extract_result_decodes_rows_and_columns() {
        let rs = TursoResultSet {
            cols: vec![
                TursoColumn { name: "id".to_string(), decltype: None },
                TursoColumn { name: "name".to_string(), decltype: None },
            ],
            rows: vec![vec![
                TursoValue { value_type: "integer".to_string(), value: Some(serde_json::json!("1")) },
                TursoValue { value_type: "text".to_string(), value: Some(serde_json::json!("Ada")) },
            ]],
            rows_read: Some(1),
            rows_written: Some(0),
            affected_row_count: Some(0),
        };

        let result = extract_result(rs);
        assert_eq!(result.columns, vec!["id", "name"]);
        assert_eq!(result.values.len(), 1);
        assert_eq!(result.values[0][0], serde_json::json!(1));
        assert_eq!(result.values[0][1], serde_json::json!("Ada"));
    }

    #[test]
    fn first_string_cell_returns_value() {
        let result = TursoExtractedResult {
            columns: vec!["sql".to_string()],
            values: vec![vec![serde_json::json!("CREATE TABLE t (id INTEGER)")]],
            rows_written: None,
        };
        assert_eq!(first_string_cell(result).unwrap(), "CREATE TABLE t (id INTEGER)");
    }

    #[test]
    fn first_string_cell_empty_returns_error() {
        let result = TursoExtractedResult { columns: vec!["sql".to_string()], values: vec![], rows_written: None };
        assert!(first_string_cell(result).is_err());
    }

    #[test]
    fn sqlite_ident_quotes_properly() {
        assert_eq!(sqlite_ident("my_table"), "\"my_table\"");
        assert_eq!(sqlite_ident("my\"table"), "\"my\"\"table\"");
    }

    #[test]
    fn sqlite_string_quotes_properly() {
        assert_eq!(sqlite_string("hello"), "'hello'");
        assert_eq!(sqlite_string("it's"), "'it''s'");
    }

    #[test]
    fn query_result_no_truncation_when_within_limit() {
        let result = TursoExtractedResult {
            columns: vec!["x".to_string()],
            values: vec![vec![serde_json::json!(1)], vec![serde_json::json!(2)]],
            rows_written: None,
        };

        let qr = query_result_from_turso_result(result, 5, Some(100));
        assert_eq!(qr.rows.len(), 2);
        assert!(!qr.truncated);
    }
}
