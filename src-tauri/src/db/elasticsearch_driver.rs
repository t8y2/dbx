use reqwest::Client as HttpClient;
use serde::Deserialize;

use super::mongo_driver::MongoDocumentResult;

pub struct EsClient {
    http: HttpClient,
    base_url: String,
    auth: Option<(String, String)>,
}

impl EsClient {
    pub fn new(url: &str, username: Option<&str>, password: Option<&str>) -> Self {
        let auth = match (username, password) {
            (Some(u), Some(p)) if !u.is_empty() => Some((u.to_string(), p.to_string())),
            _ => None,
        };
        Self {
            http: HttpClient::new(),
            base_url: url.trim_end_matches('/').to_string(),
            auth,
        }
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
        Self {
            http: self.http.clone(),
            base_url: self.base_url.clone(),
            auth: self.auth.clone(),
        }
    }
}

pub async fn test_connection(client: &EsClient) -> Result<(), String> {
    let resp = client.get("/")
        .send()
        .await
        .map_err(|e| format!("Elasticsearch connection failed: {e}"))?;
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
    let resp = client.get("/_cat/indices?format=json&h=index")
        .send()
        .await
        .map_err(|e| format!("Elasticsearch request failed: {e}"))?;
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Elasticsearch error: {body}"));
    }
    let indices: Vec<CatIndex> = resp.json().await.map_err(|e| format!("Elasticsearch parse error: {e}"))?;
    let mut names: Vec<String> = indices
        .into_iter()
        .filter(|i| !i.index.starts_with('.'))
        .map(|i| i.index)
        .collect();
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
    let resp = client.post(&path)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Elasticsearch request failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Elasticsearch error: {body}"));
    }

    let result: SearchResponse = resp.json().await
        .map_err(|e| format!("Elasticsearch parse error: {e}"))?;

    let documents: Vec<serde_json::Value> = result.hits.hits.into_iter().map(|hit| {
        let mut doc = match hit.source {
            serde_json::Value::Object(map) => map,
            _ => serde_json::Map::new(),
        };
        doc.insert("_id".to_string(), serde_json::Value::String(hit.id));
        serde_json::Value::Object(doc)
    }).collect();

    Ok(MongoDocumentResult {
        documents,
        total: result.hits.total.value,
    })
}

pub async fn insert_document(
    client: &EsClient,
    index: &str,
    doc_json: &str,
) -> Result<String, String> {
    let doc: serde_json::Value = serde_json::from_str(doc_json)
        .map_err(|e| format!("Invalid JSON: {e}"))?;

    let path = format!("/{}/_doc?refresh=true", index);
    let resp = client.post(&path)
        .json(&doc)
        .send()
        .await
        .map_err(|e| format!("Elasticsearch request failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Elasticsearch error: {body}"));
    }

    let result: serde_json::Value = resp.json().await
        .map_err(|e| format!("Elasticsearch parse error: {e}"))?;
    Ok(result["_id"].as_str().unwrap_or("").to_string())
}

pub async fn update_document(
    client: &EsClient,
    index: &str,
    id: &str,
    doc_json: &str,
) -> Result<u64, String> {
    let doc: serde_json::Value = serde_json::from_str(doc_json)
        .map_err(|e| format!("Invalid JSON: {e}"))?;

    let path = format!("/{}/_doc/{}?refresh=true", index, id);
    let resp = client.put(&path)
        .json(&doc)
        .send()
        .await
        .map_err(|e| format!("Elasticsearch request failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Elasticsearch error: {body}"));
    }

    Ok(1)
}

pub async fn delete_document(
    client: &EsClient,
    index: &str,
    id: &str,
) -> Result<u64, String> {
    let path = format!("/{}/_doc/{}?refresh=true", index, id);
    let resp = client.delete(&path)
        .send()
        .await
        .map_err(|e| format!("Elasticsearch request failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Elasticsearch error: {body}"));
    }

    Ok(1)
}
