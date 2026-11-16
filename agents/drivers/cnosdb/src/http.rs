use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use reqwest::{Client, StatusCode};
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::config::Endpoint;
use crate::model::QueryResult;

#[derive(Clone)]
pub struct CnosHttpClient {
    client: Client,
    endpoint: Endpoint,
}

impl CnosHttpClient {
    pub fn new(endpoint: Endpoint) -> Result<Self> {
        let client = Client::builder()
            .timeout(Duration::from_secs(endpoint.connect_timeout_secs.max(15)))
            .connect_timeout(Duration::from_secs(endpoint.connect_timeout_secs.max(5).min(60)))
            .build()
            .context("failed to build CnosDB HTTP client")?;
        Ok(Self { client, endpoint })
    }

    pub fn set_database(&mut self, database: &str) {
        let database = database.trim();
        if !database.is_empty() {
            self.endpoint.database = database.to_string();
        }
    }

    pub async fn execute_sql(
        &self,
        sql: &str,
        database: Option<&str>,
        timeout_secs: u64,
        token: &CancellationToken,
    ) -> Result<QueryResult> {
        let database = database
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(self.endpoint.database.as_str());
        let url = sql_url(&self.endpoint, database)?;
        let request = self
            .client
            .post(url)
            .basic_auth(&self.endpoint.username, Some(&self.endpoint.password))
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(sql.to_string());
        let request = if timeout_secs > 0 {
            request.timeout(Duration::from_secs(timeout_secs))
        } else {
            request
        };

        let response = tokio::select! {
            _ = token.cancelled() => bail!("CnosDB request cancelled"),
            response = request.send() => response.context("CnosDB HTTP request failed")?,
        };

        let status = response.status();
        let body = tokio::select! {
            _ = token.cancelled() => bail!("CnosDB request cancelled"),
            body = response.text() => body.context("failed to read CnosDB response body")?,
        };

        if !status.is_success() {
            bail!("{}", format_http_error(status, &body));
        }
        parse_sql_response(&body)
    }
}

fn sql_url(endpoint: &Endpoint, database: &str) -> Result<Url> {
    let mut url = Url::parse(&endpoint.base_url).context("invalid CnosDB base URL")?;
    url.set_path("/api/v1/sql");
    {
        let mut query = url.query_pairs_mut();
        query.clear();
        query.append_pair("db", database);
        query.append_pair("tenant", &endpoint.tenant);
        query.append_pair("pretty", "true");
    }
    Ok(url)
}

fn format_http_error(status: StatusCode, body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return format!("CnosDB HTTP {status}");
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        if let Some(message) = value.get("error_message").and_then(Value::as_str) {
            return message.to_string();
        }
        if let Some(message) = value.get("error").and_then(Value::as_str) {
            return message.to_string();
        }
    }
    format!("CnosDB HTTP {status}: {trimmed}")
}

pub fn parse_sql_response(body: &str) -> Result<QueryResult> {
    let trimmed = body.trim();
    if trimmed.is_empty() || trimmed == "{}" || trimmed == "null" {
        return Ok(QueryResult::default());
    }

    let value: Value = serde_json::from_str(trimmed).with_context(|| {
        format!("failed to parse CnosDB JSON response: {}", truncate(trimmed, 240))
    })?;

    if let Some(message) = value.get("error_message").and_then(Value::as_str) {
        bail!("{message}");
    }
    if let Some(message) = value.get("error").and_then(Value::as_str) {
        bail!("{message}");
    }

    if let Some(rows) = value.as_array() {
        if let Some(affected) = affected_rows_only(rows) {
            return Ok(QueryResult {
                affected_rows: affected,
                ..QueryResult::default()
            });
        }
        return rows_from_objects(rows);
    }

    if let (Some(columns), Some(rows)) = (value.get("columns"), value.get("rows")) {
        return rows_from_columns_and_rows(columns, rows);
    }

    if value.as_object().is_some() {
        return rows_from_objects(std::slice::from_ref(&value));
    }

    Err(anyhow!("unsupported CnosDB SQL response shape: {}", truncate(trimmed, 240)))
}

fn rows_from_objects(rows: &[Value]) -> Result<QueryResult> {
    if rows.is_empty() {
        return Ok(QueryResult::default());
    }
    let mut columns = Vec::new();
    for row in rows {
        let object = row
            .as_object()
            .ok_or_else(|| anyhow!("CnosDB JSON row must be an object"))?;
        for key in object.keys() {
            if !columns.iter().any(|column| column == key) {
                columns.push(key.clone());
            }
        }
    }
    let column_types = columns
        .iter()
        .map(|column| {
            rows.iter()
                .find_map(|row| row.get(column))
                .map(infer_type)
                .unwrap_or_else(|| "STRING".to_string())
        })
        .collect::<Vec<_>>();
    let parsed_rows = rows
        .iter()
        .map(|row| {
            let object = row.as_object().expect("checked above");
            columns
                .iter()
                .map(|column| object.get(column).cloned().unwrap_or(Value::Null))
                .collect::<Vec<_>>()
        })
        .collect();
    Ok(QueryResult {
        columns,
        column_types,
        rows: parsed_rows,
        affected_rows: 0,
        execution_time_ms: 0,
        truncated: false,
    })
}

fn rows_from_columns_and_rows(columns_value: &Value, rows_value: &Value) -> Result<QueryResult> {
    let columns = columns_value
        .as_array()
        .ok_or_else(|| anyhow!("CnosDB columns must be an array"))?
        .iter()
        .map(|value| match value {
            Value::String(text) => Ok(text.clone()),
            Value::Object(object) => object
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| anyhow!("CnosDB column object missing name")),
            other => Ok(other.to_string()),
        })
        .collect::<Result<Vec<_>>>()?;
    let rows = rows_value
        .as_array()
        .ok_or_else(|| anyhow!("CnosDB rows must be an array"))?
        .iter()
        .map(|row| match row {
            Value::Array(cells) => Ok(cells.clone()),
            Value::Object(object) => Ok(columns
                .iter()
                .map(|column| object.get(column).cloned().unwrap_or(Value::Null))
                .collect()),
            other => bail!("unsupported CnosDB row value: {other}"),
        })
        .collect::<Result<Vec<_>>>()?;
    let column_types = columns
        .iter()
        .enumerate()
        .map(|(index, _)| {
            rows.iter()
                .find_map(|row| row.get(index))
                .map(infer_type)
                .unwrap_or_else(|| "STRING".to_string())
        })
        .collect();
    Ok(QueryResult {
        columns,
        column_types,
        rows,
        affected_rows: 0,
        execution_time_ms: 0,
        truncated: false,
    })
}

fn affected_rows_only(rows: &[Value]) -> Option<i64> {
    if rows.len() != 1 {
        return None;
    }
    let object = rows[0].as_object()?;
    if object.len() != 1 || !object.contains_key("rows") {
        return None;
    }
    object.get("rows").and_then(Value::as_i64).or_else(|| {
        object
            .get("rows")
            .and_then(Value::as_u64)
            .and_then(|value| i64::try_from(value).ok())
    })
}

fn infer_type(value: &Value) -> String {
    match value {
        Value::Null => "STRING".into(),
        Value::Bool(_) => "BOOLEAN".into(),
        Value::Number(number) if number.is_f64() => "DOUBLE".into(),
        Value::Number(_) => "BIGINT".into(),
        Value::String(_) | Value::Array(_) | Value::Object(_) => "STRING".into(),
    }
}

fn truncate(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        value.to_string()
    } else {
        let shortened: String = value.chars().take(max).collect();
        format!("{shortened}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_array_of_objects() {
        let result = parse_sql_response(
            r#"[{"database_name":"public"},{"database_name":"oceanic_station"}]"#,
        )
        .unwrap();
        assert_eq!(result.columns, vec!["database_name".to_string()]);
        assert_eq!(result.rows.len(), 2);
        assert_eq!(result.rows[0][0], json!("public"));
    }

    #[test]
    fn parses_empty_ddl_response() {
        let result = parse_sql_response("").unwrap();
        assert!(result.rows.is_empty());
        assert!(result.columns.is_empty());
    }

    #[test]
    fn parses_error_object() {
        let error = parse_sql_response(r#"{"error_code":"010001","error_message":"table not found"}"#).unwrap_err();
        assert!(error.to_string().contains("table not found"));
    }

    #[test]
    fn parses_affected_rows_payload() {
        let result = parse_sql_response(r#"[{"rows":1}]"#).unwrap();
        assert_eq!(result.affected_rows, 1);
        assert!(result.columns.is_empty());
        assert!(result.rows.is_empty());
    }
}
