use reqwest::Client as HttpClient;
use serde::Deserialize;
use std::time::{Duration, Instant};

use super::{http_client_builder, json_value_for_js, with_connection_timeout};
use crate::models::connection::ConnectionConfig;
use crate::types::{
    ColumnInfo, DatabaseInfo, ForeignKeyInfo, IndexInfo, ObjectSource, ObjectSourceKind, QueryResult, TableInfo,
    TriggerInfo,
};

mod import;
mod sql_guard;
mod sql_lexer;
mod sql_limits;
#[cfg(test)]
mod transfer_tests;
mod trigger;

pub(crate) use import::{build_import_insert_batches, build_streaming_import_insert_batch};
pub use sql_limits::MAX_SQL_STATEMENT_BYTES;

const CLOUDFLARE_API_BASE_URL: &str = "https://api.cloudflare.com/client/v4";

#[derive(Clone)]
pub struct CloudflareD1Client {
    http: HttpClient,
    endpoint: String,
    api_token: String,
}

impl CloudflareD1Client {
    pub fn new(account_id: &str, database_id: &str, api_token: &str, timeout: Duration) -> Result<Self, String> {
        let account_id = required_identifier(account_id, "Cloudflare Account ID")?;
        let database_id = required_identifier(database_id, "Cloudflare D1 Database ID")?;
        let endpoint = format!("{CLOUDFLARE_API_BASE_URL}/accounts/{account_id}/d1/database/{database_id}/raw");
        Self::with_endpoint(endpoint, api_token, timeout)
    }

    fn with_endpoint(endpoint: String, api_token: &str, timeout: Duration) -> Result<Self, String> {
        let api_token = required_field(api_token, "Cloudflare API Token")?;
        let http = http_client_builder(timeout)
            .build()
            .map_err(|error| format!("Failed to configure Cloudflare D1 HTTP client: {error}"))?;
        Ok(Self { http, endpoint, api_token: api_token.to_string() })
    }

    fn post_raw(&self, sql: &str) -> reqwest::RequestBuilder {
        self.http
            .post(&self.endpoint)
            .bearer_auth(&self.api_token)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .json(&serde_json::json!({ "sql": sql }))
    }
}

#[derive(Debug, Deserialize)]
struct D1ApiResponse {
    #[serde(default)]
    success: Option<bool>,
    #[serde(default)]
    errors: Vec<D1ApiError>,
    #[serde(default)]
    result: Vec<D1StatementResult>,
}

#[derive(Debug, Deserialize)]
struct D1ApiError {
    #[serde(default)]
    code: Option<u64>,
    message: String,
}

#[derive(Debug, Default, Deserialize)]
struct D1StatementResult {
    #[serde(default)]
    success: Option<bool>,
    #[serde(default)]
    results: D1RawResult,
    #[serde(default)]
    meta: D1Meta,
}

#[derive(Debug, Default, Deserialize)]
struct D1RawResult {
    #[serde(default)]
    columns: Vec<String>,
    #[serde(default)]
    rows: Vec<Vec<serde_json::Value>>,
}

#[derive(Debug, Default, Deserialize)]
struct D1Meta {
    #[serde(default)]
    changes: Option<u64>,
}

pub async fn test_connection(client: &CloudflareD1Client, timeout: Duration) -> Result<(), String> {
    with_connection_timeout("Cloudflare D1", timeout, async { send_raw(client, "SELECT 1").await.map(|_| ()) }).await
}

pub async fn connect(config: &ConnectionConfig, timeout: Duration) -> Result<CloudflareD1Client, String> {
    let client = CloudflareD1Client::new(
        &config.host,
        config.database.as_deref().unwrap_or_default(),
        &config.password,
        timeout,
    )?;
    test_connection(&client, timeout).await?;
    Ok(client)
}

pub async fn list_databases(_client: &CloudflareD1Client) -> Result<Vec<DatabaseInfo>, String> {
    Ok(vec![DatabaseInfo { name: "main".to_string() }])
}

pub async fn list_tables(client: &CloudflareD1Client, _schema: &str) -> Result<Vec<TableInfo>, String> {
    let result = query_inner(
        client,
        "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> '_cf_KV' ORDER BY name",
    )
    .await?;
    Ok(result
        .rows
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

pub async fn get_columns(client: &CloudflareD1Client, _schema: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    // table_info omits generated columns; table_xinfo exposes them and marks
    // virtual/stored generated columns with hidden values 2 and 3.
    let result = query_inner(client, &format!("PRAGMA table_xinfo({})", sqlite_ident(table))).await?;
    Ok(result
        .rows
        .into_iter()
        .map(|row| {
            let hidden = value_by_column(&result.columns, &row, "hidden")
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(0);
            ColumnInfo {
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
                extra: match hidden {
                    2 => Some("generated always as virtual".to_string()),
                    3 => Some("generated always as stored".to_string()),
                    _ => None,
                },
                comment: None,
                numeric_precision: None,
                numeric_scale: None,
                character_maximum_length: None,
                enum_values: None,
                ..Default::default()
            }
        })
        .collect())
}

pub async fn list_indexes(client: &CloudflareD1Client, _schema: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
    let result = query_inner(client, &format!("PRAGMA index_list({})", sqlite_ident(table))).await?;
    let mut indexes = Vec::new();
    for row in result.rows {
        let name = value_by_column(&result.columns, &row, "name").unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let is_unique =
            value_by_column(&result.columns, &row, "unique").and_then(|value| value.parse::<i64>().ok()).unwrap_or(0)
                != 0;
        let origin = value_by_column(&result.columns, &row, "origin").unwrap_or_default();
        let column_result = query_inner(client, &format!("PRAGMA index_info({})", sqlite_ident(&name))).await?;
        let columns =
            column_result.rows.iter().filter_map(|row| value_by_column(&column_result.columns, row, "name")).collect();
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
    client: &CloudflareD1Client,
    _schema: &str,
    table: &str,
) -> Result<Vec<ForeignKeyInfo>, String> {
    let result = query_inner(client, &format!("PRAGMA foreign_key_list({})", sqlite_ident(table))).await?;
    Ok(result
        .rows
        .into_iter()
        .map(|row| ForeignKeyInfo {
            name: format!("fk_{}", value_by_column(&result.columns, &row, "id").unwrap_or_else(|| "0".to_string())),
            column: value_by_column(&result.columns, &row, "from").unwrap_or_default(),
            ref_schema: None,
            ref_table: value_by_column(&result.columns, &row, "table").unwrap_or_default(),
            ref_column: value_by_column(&result.columns, &row, "to").unwrap_or_default(),
            on_update: value_by_column(&result.columns, &row, "on_update"),
            on_delete: value_by_column(&result.columns, &row, "on_delete"),
        })
        .collect())
}

pub async fn list_triggers(
    client: &CloudflareD1Client,
    _schema: &str,
    table: &str,
) -> Result<Vec<TriggerInfo>, String> {
    let result = query_inner(
        client,
        &format!(
            "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = {} ORDER BY name",
            sqlite_string(table)
        ),
    )
    .await?;
    Ok(result
        .rows
        .into_iter()
        .map(|row| {
            let statement = value_as_string(row.get(1));
            let metadata = trigger::metadata_from_sql(statement.as_deref().unwrap_or_default());
            TriggerInfo {
                name: value_as_string(row.first()).unwrap_or_default(),
                event: metadata.event.to_string(),
                timing: metadata.timing.to_string(),
                statement,
            }
        })
        .collect())
}

pub async fn table_ddl(client: &CloudflareD1Client, table: &str) -> Result<String, String> {
    first_string_cell(
        query_inner(
            client,
            &format!("SELECT sql FROM sqlite_master WHERE type='table' AND name={}", sqlite_string(table)),
        )
        .await?,
    )
}

pub async fn object_source(
    client: &CloudflareD1Client,
    name: &str,
    object_type: &ObjectSourceKind,
) -> Result<ObjectSource, String> {
    let kind = match object_type {
        ObjectSourceKind::View => "view",
        _ => return Err("Object source is not supported for this Cloudflare D1 object type".to_string()),
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

pub async fn execute_query_with_max_rows(
    client: &CloudflareD1Client,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    let sql = sql.trim();
    if sql.is_empty() {
        return Ok(empty_query_result(start.elapsed().as_millis()));
    }
    sql_guard::validate_sql(sql)?;
    sql_limits::validate_statement_sizes(sql)?;
    let mut statements = send_raw(client, sql).await?;
    let affected_rows: u64 = statements.iter().filter_map(|statement| statement.meta.changes).sum();
    let display = statements.pop().unwrap_or_default();
    Ok(query_result(display.results, affected_rows, start.elapsed().as_millis(), max_rows))
}

async fn query_inner(client: &CloudflareD1Client, sql: &str) -> Result<D1RawResult, String> {
    send_raw(client, sql)
        .await?
        .into_iter()
        .next()
        .map(|statement| statement.results)
        .ok_or_else(|| "Cloudflare D1 returned no result".to_string())
}

async fn send_raw(client: &CloudflareD1Client, sql: &str) -> Result<Vec<D1StatementResult>, String> {
    let response =
        client.post_raw(sql).send().await.map_err(|error| format!("Cloudflare D1 request failed: {error}"))?;
    let status = response.status();
    let body = response.text().await.map_err(|error| format!("Cloudflare D1 response read failed: {error}"))?;
    let parsed: D1ApiResponse = serde_json::from_str(&body)
        .map_err(|error| format!("Cloudflare D1 response parse failed: {error}; body: {}", response_excerpt(&body)))?;
    if !status.is_success() || parsed.success == Some(false) {
        return Err(format_d1_error(status.as_u16(), &parsed.errors, &body));
    }
    if parsed.result.iter().any(|result| result.success == Some(false)) {
        return Err(format_d1_error(status.as_u16(), &parsed.errors, &body));
    }
    if parsed.result.is_empty() {
        return Err("Cloudflare D1 returned no statement results".to_string());
    }
    Ok(parsed.result)
}

fn query_result(
    mut result: D1RawResult,
    affected_rows: u64,
    execution_time_ms: u128,
    max_rows: Option<usize>,
) -> QueryResult {
    result.rows = result.rows.into_iter().map(|row| row.into_iter().map(json_value_for_js).collect()).collect();
    let row_limit = max_rows.unwrap_or(crate::query::MAX_ROWS).max(1);
    let truncated = result.rows.len() > row_limit;
    if truncated {
        result.rows.truncate(row_limit);
    }
    QueryResult {
        columns: result.columns,
        column_types: Vec::new(),
        column_sortables: vec![],
        rows: result.rows,
        affected_rows,
        execution_time_ms,
        truncated,
        session_id: None,
        has_more: false,
    }
}

fn empty_query_result(execution_time_ms: u128) -> QueryResult {
    query_result(D1RawResult::default(), 0, execution_time_ms, None)
}

fn format_d1_error(status: u16, errors: &[D1ApiError], body: &str) -> String {
    let details = errors
        .iter()
        .map(|error| match error.code {
            Some(code) => format!("{} ({code})", error.message),
            None => error.message.clone(),
        })
        .collect::<Vec<_>>()
        .join("; ");
    if details.is_empty() {
        format!("Cloudflare D1 API error ({status}): {}", response_excerpt(body))
    } else {
        format!("Cloudflare D1 API error ({status}): {details}")
    }
}

fn response_excerpt(body: &str) -> String {
    const MAX_CHARS: usize = 1_000;
    let mut excerpt = body.chars().take(MAX_CHARS).collect::<String>();
    if body.chars().count() > MAX_CHARS {
        excerpt.push('…');
    }
    excerpt
}

fn required_field<'a>(value: &'a str, label: &str) -> Result<&'a str, String> {
    let value = value.trim();
    if value.is_empty() {
        Err(format!("{label} is required"))
    } else {
        Ok(value)
    }
}

fn required_identifier<'a>(value: &'a str, label: &str) -> Result<&'a str, String> {
    let value = required_field(value, label)?;
    if value.chars().all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_') {
        Ok(value)
    } else {
        Err(format!("{label} contains invalid characters"))
    }
}

fn first_string_cell(result: D1RawResult) -> Result<String, String> {
    result
        .rows
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

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn validates_required_connection_fields() {
        let timeout = Duration::from_secs(1);
        assert!(CloudflareD1Client::new("", "database", "token", timeout).err().unwrap().contains("Account ID"));
        assert!(CloudflareD1Client::new("account", "", "token", timeout).err().unwrap().contains("Database ID"));
        assert!(CloudflareD1Client::new("account", "database", "", timeout).err().unwrap().contains("API Token"));
        assert!(CloudflareD1Client::new("account/path", "database", "token", timeout)
            .err()
            .unwrap()
            .contains("invalid characters"));
    }

    #[test]
    fn parses_raw_api_response() {
        let response: D1ApiResponse = serde_json::from_value(serde_json::json!({
            "success": true,
            "errors": [],
            "result": [{
                "success": true,
                "results": { "columns": ["id", "name"], "rows": [[1, "Ada"]] },
                "meta": { "changes": 0 }
            }]
        }))
        .unwrap();
        assert_eq!(response.success, Some(true));
        assert_eq!(response.result[0].results.columns, ["id", "name"]);
        assert_eq!(response.result[0].results.rows[0], [serde_json::json!(1), serde_json::json!("Ada")]);
    }

    #[test]
    fn converts_and_truncates_query_result() {
        let raw = D1RawResult {
            columns: vec!["id".to_string()],
            rows: vec![vec![serde_json::json!(1)], vec![serde_json::json!(2)]],
        };
        let result = query_result(raw, 0, 5, Some(1));
        assert_eq!(result.rows, vec![vec![serde_json::json!(1)]]);
        assert!(result.truncated);
    }

    #[test]
    fn limits_error_response_excerpts() {
        let excerpt = response_excerpt(&"x".repeat(1_100));
        assert_eq!(excerpt.chars().count(), 1_001);
        assert!(excerpt.ends_with('…'));
    }

    #[tokio::test]
    async fn sends_bearer_authenticated_raw_query_and_maps_response() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert!(request.starts_with("POST /raw HTTP/1.1"));
            assert!(request.to_ascii_lowercase().contains("authorization: bearer test-token"));
            assert!(request.contains("\"sql\":\"SELECT 1\""));

            let body = r#"{"success":true,"errors":[],"result":[{"success":true,"results":{"columns":["1"],"rows":[[1]]},"meta":{"changes":0}}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });

        let client =
            CloudflareD1Client::with_endpoint(format!("http://{address}/raw"), "test-token", Duration::from_secs(2))
                .unwrap();
        let result = execute_query_with_max_rows(&client, "SELECT 1", None).await.unwrap();
        assert_eq!(result.columns, ["1"]);
        assert_eq!(result.rows, vec![vec![serde_json::json!(1)]]);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn lists_tables_and_views_from_sqlite_master() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert!(request.contains("sqlite_master"));
            assert!(request.contains("name <> '_cf_KV'"));
            assert!(!request.contains("d1_%"));

            let body = r#"{"success":true,"errors":[],"result":[{"success":true,"results":{"columns":["name","type"],"rows":[["users","table"],["active_users","view"]]},"meta":{"changes":0}}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });

        let client =
            CloudflareD1Client::with_endpoint(format!("http://{address}/raw"), "test-token", Duration::from_secs(2))
                .unwrap();
        let tables = list_tables(&client, "main").await.unwrap();
        assert_eq!(tables.len(), 2);
        assert_eq!(tables[0].name, "users");
        assert_eq!(tables[0].table_type, "BASE TABLE");
        assert_eq!(tables[1].name, "active_users");
        assert_eq!(tables[1].table_type, "VIEW");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn lists_generated_columns_from_table_xinfo() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert!(request.contains("PRAGMA table_xinfo"));

            let body = r#"{"success":true,"errors":[],"result":[{"success":true,"results":{"columns":["cid","name","type","notnull","dflt_value","pk","hidden"],"rows":[[0,"price","INTEGER",1,null,0,0],[1,"tax","INTEGER",0,null,0,2],[2,"total","INTEGER",0,null,0,3]]},"meta":{"changes":0}}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });

        let client =
            CloudflareD1Client::with_endpoint(format!("http://{address}/raw"), "test-token", Duration::from_secs(2))
                .unwrap();
        let columns = get_columns(&client, "main", "orders").await.unwrap();
        assert_eq!(columns.len(), 3);
        assert_eq!(columns[0].extra, None);
        assert_eq!(columns[1].extra.as_deref(), Some("generated always as virtual"));
        assert_eq!(columns[2].extra.as_deref(), Some("generated always as stored"));
        server.await.unwrap();
    }

    #[test]
    fn rejects_oversized_statements_but_allows_large_multi_statement_batches() {
        let oversized = format!("SELECT '{}'", "x".repeat(MAX_SQL_STATEMENT_BYTES));
        let error = sql_limits::validate_statement_sizes(&oversized).unwrap_err();
        assert!(error.contains("statement 1"));
        assert!(error.contains("100000 bytes"));

        let first = format!("SELECT '{}'", "a".repeat(60_000));
        let second = format!("SELECT '{}'", "b".repeat(60_000));
        assert!(sql_limits::validate_statement_sizes(&format!("{first}; {second}")).is_ok());

        let trigger = format!(
            "CREATE TRIGGER audit AFTER INSERT ON users BEGIN INSERT INTO logs VALUES ('{}'); INSERT INTO logs VALUES ('{}'); END",
            "a".repeat(60_000),
            "b".repeat(60_000)
        );
        assert!(sql_limits::validate_statement_sizes(&trigger).is_err());
    }

    async fn read_http_request(socket: &mut tokio::net::TcpStream) -> String {
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 2048];
        loop {
            let read = socket.read(&mut buffer).await.unwrap();
            if read == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..read]);
            let Some(header_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") else {
                continue;
            };
            let headers = String::from_utf8_lossy(&bytes[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| line.split_once(':').filter(|(name, _)| name.eq_ignore_ascii_case("content-length")))
                .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            if bytes.len() >= header_end + 4 + content_length {
                break;
            }
        }
        String::from_utf8(bytes).unwrap()
    }
}
