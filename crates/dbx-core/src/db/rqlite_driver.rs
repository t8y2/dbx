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
pub struct RqliteClient {
    http: HttpClient,
    base_url: String,
    query_params: String,
    auth: Option<(String, String)>,
}

impl RqliteClient {
    pub fn new(
        url: &str,
        url_params: Option<&str>,
        username: &str,
        password: &str,
        tls_enabled: bool,
        timeout: Duration,
    ) -> Result<Self, String> {
        let mut builder = http_client_builder(timeout);
        if rqlite_accept_invalid_certs(tls_enabled, url_params) {
            builder = builder.danger_accept_invalid_certs(true);
        }
        let http = builder.build().map_err(|e| format!("Failed to configure rqlite HTTP client: {e}"))?;
        let auth = if username.trim().is_empty() { None } else { Some((username.to_string(), password.to_string())) };
        Ok(Self {
            http,
            base_url: url.trim_end_matches('/').split('?').next().unwrap_or(url).to_string(),
            query_params: normalize_rqlite_url_params(url_params),
            auth,
        })
    }

    fn post_json(&self, path: &str, sql: &str) -> reqwest::RequestBuilder {
        let req = self.http.post(self.endpoint(path)).json(&[sql]);
        self.with_auth(req)
    }

    fn with_auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if let Some((ref user, ref pass)) = self.auth {
            req.basic_auth(user, Some(pass))
        } else {
            req
        }
    }

    fn endpoint(&self, path: &str) -> String {
        if self.query_params.is_empty() {
            format!("{}{}", self.base_url, path)
        } else {
            format!("{}{}?{}", self.base_url, path, self.query_params)
        }
    }
}

#[derive(Debug, Deserialize)]
struct RqliteResponse {
    results: Vec<RqliteResult>,
}

#[derive(Debug, Deserialize)]
struct RqliteResult {
    #[serde(default)]
    columns: Vec<String>,
    #[serde(default)]
    values: Vec<Vec<serde_json::Value>>,
    #[serde(default)]
    rows_affected: Option<u64>,
    #[serde(default)]
    error: Option<String>,
}

enum RqliteEndpoint {
    Query,
    Execute,
}

impl RqliteEndpoint {
    fn path(&self) -> &'static str {
        match self {
            Self::Query => "/db/query",
            Self::Execute => "/db/execute",
        }
    }
}

pub async fn test_connection(client: &RqliteClient, timeout: Duration) -> Result<(), String> {
    with_connection_timeout("rqlite", timeout, async { query_one(client, "SELECT 1").await.map(|_| ()) }).await
}

pub async fn list_databases(_client: &RqliteClient) -> Result<Vec<DatabaseInfo>, String> {
    Ok(vec![DatabaseInfo { name: "main".to_string() }])
}

pub async fn list_tables(client: &RqliteClient, _schema: &str) -> Result<Vec<TableInfo>, String> {
    let result = query_one(
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

pub async fn get_columns(client: &RqliteClient, _schema: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    let result = query_one(client, &format!("PRAGMA table_info({})", sqlite_ident(table))).await?;
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
        })
        .collect())
}

pub async fn list_indexes(client: &RqliteClient, _schema: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
    let result = query_one(client, &format!("PRAGMA index_list({})", sqlite_ident(table))).await?;
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
        let column_result = query_one(client, &format!("PRAGMA index_info({})", sqlite_ident(&name))).await?;
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
    client: &RqliteClient,
    _schema: &str,
    table: &str,
) -> Result<Vec<ForeignKeyInfo>, String> {
    let result = query_one(client, &format!("PRAGMA foreign_key_list({})", sqlite_ident(table))).await?;
    Ok(result
        .values
        .into_iter()
        .map(|row| ForeignKeyInfo {
            name: format!("fk_{}", value_by_column(&result.columns, &row, "id").unwrap_or_else(|| "0".to_string())),
            column: value_by_column(&result.columns, &row, "from").unwrap_or_default(),
            ref_schema: None,
            ref_table: value_by_column(&result.columns, &row, "table").unwrap_or_default(),
            ref_column: value_by_column(&result.columns, &row, "to").unwrap_or_default(),
        })
        .collect())
}

pub async fn list_triggers(client: &RqliteClient, _schema: &str, table: &str) -> Result<Vec<TriggerInfo>, String> {
    let result = query_one(
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
            }
        })
        .collect())
}

pub async fn table_ddl(client: &RqliteClient, table: &str) -> Result<String, String> {
    first_string_cell(
        query_one(
            client,
            &format!("SELECT sql FROM sqlite_master WHERE type='table' AND name={}", sqlite_string(table)),
        )
        .await?,
    )
}

pub async fn object_source(
    client: &RqliteClient,
    name: &str,
    object_type: &ObjectSourceKind,
) -> Result<ObjectSource, String> {
    let kind = match object_type {
        ObjectSourceKind::View => "view",
        _ => return Err("Object source is not supported for this rqlite object type".to_string()),
    };
    let source = first_string_cell(
        query_one(
            client,
            &format!(
                "SELECT sql FROM sqlite_master WHERE type={} AND name={}",
                sqlite_string(kind),
                sqlite_string(name)
            ),
        )
        .await?,
    )?;
    Ok(ObjectSource { name: name.to_string(), object_type: object_type.clone(), schema: None, source })
}

pub async fn execute_query(client: &RqliteClient, sql: &str) -> Result<QueryResult, String> {
    execute_query_with_max_rows(client, sql, None).await
}

pub async fn execute_query_with_max_rows(
    client: &RqliteClient,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    if starts_with_executable_sql_keyword(sql, &["SELECT", "PRAGMA", "EXPLAIN", "WITH"]) {
        let result = query_one(client, sql).await?;
        Ok(query_result_from_rqlite_result(result, start.elapsed().as_millis(), max_rows))
    } else {
        let result = execute_one(client, sql).await?;
        let affected_rows = result.rows_affected.unwrap_or(0);
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
    }
}

async fn query_one(client: &RqliteClient, sql: &str) -> Result<RqliteResult, String> {
    request_one(client, RqliteEndpoint::Query, sql).await
}

async fn execute_one(client: &RqliteClient, sql: &str) -> Result<RqliteResult, String> {
    request_one(client, RqliteEndpoint::Execute, sql).await
}

async fn request_one(client: &RqliteClient, endpoint: RqliteEndpoint, sql: &str) -> Result<RqliteResult, String> {
    let resp =
        client.post_json(endpoint.path(), sql).send().await.map_err(|e| format!("rqlite request failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("rqlite response read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("rqlite error ({status}): {body}"));
    }
    let response: RqliteResponse =
        serde_json::from_str(&body).map_err(|e| format!("rqlite parse error: {e}; body: {body}"))?;
    let result = response.results.into_iter().next().ok_or_else(|| "rqlite returned no result".to_string())?;
    if let Some(error) = result.error.as_ref().filter(|error| !error.is_empty()) {
        return Err(format!("rqlite error: {error}"));
    }
    Ok(result)
}

fn query_result_from_rqlite_result(
    mut result: RqliteResult,
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

fn first_string_cell(result: RqliteResult) -> Result<String, String> {
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

fn normalize_rqlite_url_params(params: Option<&str>) -> String {
    params
        .unwrap_or("")
        .trim()
        .trim_start_matches('?')
        .split('&')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("&")
}

fn rqlite_accept_invalid_certs(tls_enabled: bool, url_params: Option<&str>) -> bool {
    tls_enabled
        && url_params
            .unwrap_or("")
            .trim()
            .trim_start_matches('?')
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .any(|(key, value)| {
                matches!(key.trim().to_ascii_lowercase().as_str(), "insecure" | "tls_insecure" | "accept_invalid_certs")
                    && matches!(value.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes" | "on")
            })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_query_result_and_truncates_probe_rows() {
        let result = RqliteResult {
            columns: vec!["id".to_string(), "name".to_string()],
            values: vec![
                vec![serde_json::json!(1), serde_json::json!("Ada")],
                vec![serde_json::json!(2), serde_json::json!("Linus")],
            ],
            rows_affected: None,
            error: None,
        };

        let result = query_result_from_rqlite_result(result, 8, Some(1));

        assert_eq!(result.columns, vec!["id", "name"]);
        assert_eq!(result.rows, vec![vec![serde_json::json!(1), serde_json::json!("Ada")]]);
        assert_eq!(result.execution_time_ms, 8);
        assert!(result.truncated);
    }

    #[test]
    fn maps_column_values_by_name() {
        let columns = vec!["name".to_string(), "notnull".to_string(), "pk".to_string()];
        let row = vec![serde_json::json!("id"), serde_json::json!(1), serde_json::json!(1)];

        assert_eq!(value_by_column(&columns, &row, "NAME").as_deref(), Some("id"));
        assert_eq!(value_by_column(&columns, &row, "notnull").as_deref(), Some("1"));
    }
}
