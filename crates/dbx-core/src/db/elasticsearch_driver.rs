use reqwest::Client as HttpClient;
use serde::Deserialize;

use super::{connection_timeout, with_connection_timeout};
use crate::db::mongo_driver::MongoDocumentResult;

pub struct EsClient {
    http: HttpClient,
    base_url: String,
    auth: Option<(String, String)>,
}

impl EsClient {
    pub fn new(url: &str, username: Option<&str>, password: Option<&str>, accept_invalid_certs: bool) -> Self {
        let auth = match (username, password) {
            (Some(u), Some(p)) if !u.is_empty() => Some((u.to_string(), p.to_string())),
            _ => None,
        };
        let http = HttpClient::builder()
            .connect_timeout(connection_timeout())
            .danger_accept_invalid_certs(accept_invalid_certs)
            .build()
            .unwrap_or_else(|_| HttpClient::new());
        Self { http, base_url: url.trim_end_matches('/').to_string(), auth }
    }

    fn get(&self, path: &str) -> reqwest::RequestBuilder {
        let req = self.http.get(format!("{}{}", self.base_url, path));
        self.with_auth(req)
    }

    fn post(&self, path: &str) -> reqwest::RequestBuilder {
        let req = self.http.post(format!("{}{}", self.base_url, path));
        self.with_auth(req)
    }

    fn put(&self, path: &str) -> reqwest::RequestBuilder {
        let req = self.http.put(format!("{}{}", self.base_url, path));
        self.with_auth(req)
    }

    fn delete(&self, path: &str) -> reqwest::RequestBuilder {
        let req = self.http.delete(format!("{}{}", self.base_url, path));
        self.with_auth(req)
    }

    fn with_auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if let Some((ref user, ref pass)) = self.auth {
            req.basic_auth(user, Some(pass))
        } else {
            req
        }
    }
}

impl Clone for EsClient {
    fn clone(&self) -> Self {
        Self { http: self.http.clone(), base_url: self.base_url.clone(), auth: self.auth.clone() }
    }
}

pub async fn test_connection(client: &EsClient) -> Result<(), String> {
    let resp = with_connection_timeout("Elasticsearch", async {
        client.get("/").send().await.map_err(|e| format!("Elasticsearch connection failed: {e}"))
    })
    .await?;
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Elasticsearch error: {body}"));
    }
    Ok(())
}

#[derive(Deserialize)]
struct CatIndex {
    index: String,
}

pub async fn list_indices(client: &EsClient) -> Result<Vec<String>, String> {
    let resp = client
        .get("/_cat/indices?format=json&h=index")
        .send()
        .await
        .map_err(|e| format!("Elasticsearch request failed: {e}"))?;
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Elasticsearch error: {body}"));
    }
    let indices: Vec<CatIndex> = resp.json().await.map_err(|e| format!("Elasticsearch parse error: {e}"))?;
    let mut names: Vec<String> = indices.into_iter().filter(|i| !i.index.starts_with('.')).map(|i| i.index).collect();
    names.sort();
    Ok(names)
}

#[derive(Deserialize)]
struct SearchResponse {
    hits: SearchHits,
}

#[derive(Deserialize)]
struct SearchHits {
    total: HitsTotal,
    hits: Vec<SearchHit>,
}

#[derive(Deserialize)]
struct HitsTotal {
    value: u64,
}

#[derive(Deserialize)]
struct SearchHit {
    #[serde(rename = "_id")]
    id: String,
    #[serde(rename = "_source")]
    source: serde_json::Value,
}

pub async fn find_documents(
    client: &EsClient,
    index: &str,
    skip: u64,
    limit: i64,
) -> Result<MongoDocumentResult, String> {
    let body = serde_json::json!({
        "from": skip,
        "size": limit,
        "sort": ["_doc"],
    });

    let path = format!("/{}/_search", index);
    let resp = client.post(&path).json(&body).send().await.map_err(|e| format!("Elasticsearch request failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Elasticsearch error: {body}"));
    }

    let result: SearchResponse = resp.json().await.map_err(|e| format!("Elasticsearch parse error: {e}"))?;

    let documents: Vec<serde_json::Value> = result
        .hits
        .hits
        .into_iter()
        .map(|hit| {
            let mut doc = match hit.source {
                serde_json::Value::Object(map) => map,
                _ => serde_json::Map::new(),
            };
            doc.insert("_id".to_string(), serde_json::Value::String(hit.id));
            serde_json::Value::Object(doc)
        })
        .collect();

    Ok(MongoDocumentResult { documents, total: result.hits.total.value })
}

pub async fn insert_document(client: &EsClient, index: &str, doc_json: &str) -> Result<String, String> {
    let doc: serde_json::Value = serde_json::from_str(doc_json).map_err(|e| format!("Invalid JSON: {e}"))?;

    let path = format!("/{}/_doc?refresh=true", index);
    let resp = client.post(&path).json(&doc).send().await.map_err(|e| format!("Elasticsearch request failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Elasticsearch error: {body}"));
    }

    let result: serde_json::Value = resp.json().await.map_err(|e| format!("Elasticsearch parse error: {e}"))?;
    Ok(result["_id"].as_str().unwrap_or("").to_string())
}

pub async fn update_document(client: &EsClient, index: &str, id: &str, doc_json: &str) -> Result<u64, String> {
    let doc: serde_json::Value = serde_json::from_str(doc_json).map_err(|e| format!("Invalid JSON: {e}"))?;

    let path = format!("/{}/_doc/{}?refresh=true", index, id);
    let resp = client.put(&path).json(&doc).send().await.map_err(|e| format!("Elasticsearch request failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Elasticsearch error: {body}"));
    }

    Ok(1)
}

pub async fn delete_document(client: &EsClient, index: &str, id: &str) -> Result<u64, String> {
    let path = format!("/{}/_doc/{}?refresh=true", index, id);
    let resp = client.delete(&path).send().await.map_err(|e| format!("Elasticsearch request failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Elasticsearch error: {body}"));
    }

    Ok(1)
}

pub async fn execute_rest_query(client: &EsClient, input: &str) -> Result<crate::types::QueryResult, String> {
    let start = std::time::Instant::now();
    let input = input.trim();

    let (method, rest) = input.split_once(char::is_whitespace).ok_or("Invalid query: expected METHOD /path")?;
    let method = method.to_uppercase();

    let (path, body) = if let Some(pos) = rest.find('\n') {
        let p = rest[..pos].trim();
        let b = rest[pos + 1..].trim();
        (p, if b.is_empty() { None } else { Some(b) })
    } else {
        (rest.trim(), None)
    };

    let path = if path.starts_with('/') { path.to_string() } else { format!("/{path}") };

    let resp = match method.as_str() {
        "GET" => {
            let req = client.get(&path);
            if let Some(b) = body {
                let json: serde_json::Value = serde_json::from_str(b).map_err(|e| format!("Invalid JSON body: {e}"))?;
                req.json(&json).send().await
            } else {
                req.send().await
            }
        }
        "POST" => {
            let req = client.post(&path);
            if let Some(b) = body {
                let json: serde_json::Value = serde_json::from_str(b).map_err(|e| format!("Invalid JSON body: {e}"))?;
                req.json(&json).send().await
            } else {
                req.send().await
            }
        }
        "PUT" => {
            let req = client.put(&path);
            if let Some(b) = body {
                let json: serde_json::Value = serde_json::from_str(b).map_err(|e| format!("Invalid JSON body: {e}"))?;
                req.json(&json).send().await
            } else {
                req.send().await
            }
        }
        "DELETE" => client.delete(&path).send().await,
        _ => return Err(format!("Unsupported HTTP method: {method}. Use GET, POST, PUT, or DELETE.")),
    }
    .map_err(|e| format!("Elasticsearch request failed: {e}"))?;

    let status = resp.status().as_u16();
    let body: serde_json::Value = resp.json().await.unwrap_or_else(|_| serde_json::Value::Null);

    if let Some(hits) = body.pointer("/hits/hits").and_then(|v| v.as_array()).filter(|h| !h.is_empty()) {
        let mut all_keys = Vec::<String>::new();
        let docs: Vec<serde_json::Map<String, serde_json::Value>> = hits
            .iter()
            .map(|hit| {
                let mut row = serde_json::Map::new();
                row.insert("_id".to_string(), hit.get("_id").cloned().unwrap_or(serde_json::Value::Null));
                if let Some(source) = hit.get("_source").and_then(|s| s.as_object()) {
                    for (k, v) in source {
                        row.insert(k.clone(), v.clone());
                    }
                }
                for k in row.keys() {
                    if !all_keys.contains(k) {
                        all_keys.push(k.clone());
                    }
                }
                row
            })
            .collect();

        let rows: Vec<Vec<serde_json::Value>> = docs
            .iter()
            .map(|doc| {
                all_keys
                    .iter()
                    .map(|k| {
                        doc.get(k)
                            .map(|v| match v {
                                serde_json::Value::String(s) => serde_json::Value::String(s.clone()),
                                other => serde_json::Value::String(other.to_string()),
                            })
                            .unwrap_or(serde_json::Value::Null)
                    })
                    .collect()
            })
            .collect();

        let total = body.pointer("/hits/total/value").and_then(|v| v.as_u64()).unwrap_or(rows.len() as u64);

        Ok(crate::types::QueryResult {
            columns: all_keys,
            rows,
            affected_rows: total,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        })
    } else if let Some(aggs) = body.get("aggregations").or_else(|| body.get("aggs")).and_then(|v| v.as_object()) {
        let (columns, rows) = parse_aggregations(aggs);
        if !columns.is_empty() {
            let row_count = rows.len() as u64;
            Ok(crate::types::QueryResult {
                columns,
                rows,
                affected_rows: row_count,
                execution_time_ms: start.elapsed().as_millis(),
                truncated: false,
                session_id: None,
                has_more: false,
            })
        } else {
            let pretty = serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string());
            Ok(crate::types::QueryResult {
                columns: vec!["status".to_string(), "response".to_string()],
                rows: vec![vec![serde_json::Value::Number(status.into()), serde_json::Value::String(pretty)]],
                affected_rows: 0,
                execution_time_ms: start.elapsed().as_millis(),
                truncated: false,
                session_id: None,
                has_more: false,
            })
        }
    } else {
        let pretty = serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string());
        Ok(crate::types::QueryResult {
            columns: vec!["status".to_string(), "response".to_string()],
            rows: vec![vec![serde_json::Value::Number(status.into()), serde_json::Value::String(pretty)]],
            affected_rows: 0,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        })
    }
}

fn parse_aggregations(aggs: &serde_json::Map<String, serde_json::Value>) -> (Vec<String>, Vec<Vec<serde_json::Value>>) {
    for (_name, agg_value) in aggs {
        if let Some(buckets) = agg_value.get("buckets").and_then(|b| b.as_array()) {
            if buckets.is_empty() {
                continue;
            }
            let mut all_keys = Vec::<String>::new();
            let mut bucket_rows = Vec::new();

            for bucket in buckets {
                if let Some(obj) = bucket.as_object() {
                    let mut row = serde_json::Map::new();
                    for (k, v) in obj {
                        if let Some(sub) = v.as_object() {
                            if let Some(val) = sub.get("value") {
                                row.insert(k.clone(), val.clone());
                            } else {
                                row.insert(k.clone(), serde_json::Value::String(v.to_string()));
                            }
                        } else {
                            row.insert(k.clone(), v.clone());
                        }
                    }
                    for key in row.keys() {
                        if !all_keys.contains(key) {
                            all_keys.push(key.clone());
                        }
                    }
                    bucket_rows.push(row);
                }
            }

            let rows = bucket_rows
                .iter()
                .map(|br| {
                    all_keys
                        .iter()
                        .map(|k| {
                            br.get(k)
                                .map(|v| match v {
                                    serde_json::Value::String(s) => serde_json::Value::String(s.clone()),
                                    other => serde_json::Value::String(other.to_string()),
                                })
                                .unwrap_or(serde_json::Value::Null)
                        })
                        .collect()
                })
                .collect();

            return (all_keys, rows);
        }
    }

    let mut columns = Vec::new();
    let mut values = Vec::new();
    for (name, agg_value) in aggs {
        if let Some(obj) = agg_value.as_object() {
            if let Some(val) = obj.get("value") {
                columns.push(name.clone());
                values.push(match val {
                    serde_json::Value::String(s) => serde_json::Value::String(s.clone()),
                    other => serde_json::Value::String(other.to_string()),
                });
            }
        }
    }
    if !columns.is_empty() {
        return (columns, vec![values]);
    }

    (Vec::new(), Vec::new())
}
