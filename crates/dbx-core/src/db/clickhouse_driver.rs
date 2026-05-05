use reqwest::Client as HttpClient;
use serde::Deserialize;
use std::time::Instant;

use crate::types::{ColumnInfo, DatabaseInfo, QueryResult, TableInfo};

pub struct ChClient {
    http: HttpClient,
    base_url: String,
    username: Option<String>,
    password: Option<String>,
}

impl ChClient {
    pub fn new(url: &str, username: Option<String>, password: Option<String>) -> Self {
        Self {
            http: HttpClient::new(),
            base_url: url.trim_end_matches('/').to_string(),
            username,
            password,
        }
    }
}

impl Clone for ChClient {
    fn clone(&self) -> Self {
        Self {
            http: self.http.clone(),
            base_url: self.base_url.clone(),
            username: self.username.clone(),
            password: self.password.clone(),
        }
    }
}

#[derive(Deserialize)]
struct ChJsonResult {
    meta: Vec<ChColumn>,
    data: Vec<Vec<serde_json::Value>>,
    #[serde(default)]
    #[allow(dead_code)]
    rows: usize,
}

#[derive(Deserialize)]
struct ChColumn {
    name: String,
    #[serde(rename = "type")]
    _type: String,
}

fn build_request(client: &ChClient, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    match (&client.username, &client.password) {
        (Some(u), Some(p)) if !u.is_empty() => req.basic_auth(u, Some(p)),
        (Some(u), None) if !u.is_empty() => req.basic_auth(u, None::<&str>),
        _ => req,
    }
}

async fn ch_query(client: &ChClient, sql: &str, database: Option<&str>) -> Result<ChJsonResult, String> {
    let mut url = format!("{}/?default_format=JSONCompact", client.base_url);
    if let Some(db) = database {
        url.push_str(&format!("&database={}", db));
    }
    let req = build_request(client, client.http.post(&url).body(sql.to_string()));
    let resp = req
        .send()
        .await
        .map_err(|e| format!("ClickHouse request failed: {e}"))?;
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("ClickHouse error: {body}"));
    }
    resp.json::<ChJsonResult>().await.map_err(|e| format!("ClickHouse parse error: {e}"))
}

pub async fn test_connection(client: &ChClient) -> Result<(), String> {
    let url = format!("{}/ping", client.base_url);
    let req = build_request(client, client.http.get(&url));
    req.send().await
        .map_err(|e| format!("ClickHouse connection failed: {e}"))?;
    Ok(())
}

pub async fn list_databases(client: &ChClient) -> Result<Vec<DatabaseInfo>, String> {
    let result = ch_query(client, "SELECT name FROM system.databases ORDER BY name", None).await?;
    Ok(result.data.iter().map(|row| {
        DatabaseInfo { name: row[0].as_str().unwrap_or("").to_string() }
    }).collect())
}

pub async fn list_tables(client: &ChClient, database: &str) -> Result<Vec<TableInfo>, String> {
    let sql = format!(
        "SELECT name, engine FROM system.tables WHERE database = '{}' ORDER BY name",
        database.replace('\'', "\\'")
    );
    let result = ch_query(client, &sql, Some(database)).await?;
    Ok(result.data.iter().map(|row| {
        let engine = row.get(1).and_then(|v| v.as_str()).unwrap_or("");
        let table_type = if engine.contains("View") { "VIEW" } else { "BASE TABLE" };
        TableInfo {
            name: row[0].as_str().unwrap_or("").to_string(),
            table_type: table_type.to_string(),
        }
    }).collect())
}

pub async fn get_columns(client: &ChClient, database: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    let sql = format!(
        "SELECT name, type, default_kind, default_expression, is_in_primary_key \
         FROM system.columns WHERE database = '{}' AND table = '{}' ORDER BY position",
        database.replace('\'', "\\'"),
        table.replace('\'', "\\'")
    );
    let result = ch_query(client, &sql, Some(database)).await?;
    Ok(result.data.iter().map(|row| {
        let data_type = row.get(1).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let is_nullable = data_type.starts_with("Nullable");
        let is_pk = row.get(4).and_then(|v| v.as_u64()).unwrap_or(0) == 1;
        let default_kind = row.get(2).and_then(|v| v.as_str()).unwrap_or("");
        let default_expr = row.get(3).and_then(|v| v.as_str()).unwrap_or("");
        let column_default = if default_kind.is_empty() { None } else { Some(default_expr.to_string()) };
        ColumnInfo {
            name: row[0].as_str().unwrap_or("").to_string(),
            data_type,
            is_nullable,
            column_default,
            is_primary_key: is_pk,
            extra: None, comment: None,
            numeric_precision: None,
            numeric_scale: None,
            character_maximum_length: None,
        }
    }).collect())
}

pub async fn execute_query(client: &ChClient, database: &str, sql: &str) -> Result<QueryResult, String> {
    let start = Instant::now();
    let trimmed = sql.trim().to_uppercase();

    if trimmed.starts_with("SELECT")
        || trimmed.starts_with("SHOW")
        || trimmed.starts_with("DESCRIBE")
        || trimmed.starts_with("EXPLAIN")
        || trimmed.starts_with("WITH")
    {
        let result = ch_query(client, sql, Some(database)).await?;
        let columns: Vec<String> = result.meta.iter().map(|c| c.name.clone()).collect();
        Ok(QueryResult {
            columns,
            rows: result.data,
            affected_rows: 0,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
        })
    } else {
        let url = format!("{}/?default_format=JSONCompact&database={}", client.base_url, database);
        let req = build_request(client, client.http.post(&url).body(sql.to_string()));
        let resp = req
            .send()
            .await
            .map_err(|e| format!("ClickHouse request failed: {e}"))?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("ClickHouse error: {body}"));
        }
        Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            affected_rows: 0,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
        })
    }
}
