use serde_json::Value;
use std::time::{Duration, Instant};

use super::document_result::DocumentQueryResult;
use super::elasticsearch_driver::{self, EsClient};
use crate::db::ColumnInfo;
use crate::types::QueryResult;

#[derive(Clone)]
pub struct EasysearchClient {
    inner: EsClient,
}

impl EasysearchClient {
    pub fn from_config(
        url: &str,
        username: Option<&str>,
        password: Option<&str>,
        tls_enabled: bool,
        url_params: Option<&str>,
        external_config: Option<&Value>,
        timeout: Duration,
    ) -> Self {
        Self {
            inner: EsClient::from_config(url, username, password, tls_enabled, url_params, external_config, timeout),
        }
    }
}

fn easysearch_error(error: String) -> String {
    error.replace("Elasticsearch", "Easysearch")
}

fn parse_sql_response(body: &Value, start: Instant) -> Option<QueryResult> {
    elasticsearch_driver::parse_tabular_sql_response(body, start, "schema", "datarows", Some("total"))
        .or_else(|| elasticsearch_driver::parse_tabular_sql_response(body, start, "columns", "rows", Some("total")))
}

pub async fn test_connection(client: &mut EasysearchClient, timeout: Duration) -> Result<(), String> {
    elasticsearch_driver::test_connection(&mut client.inner, timeout).await.map_err(easysearch_error)
}

pub async fn list_indices(client: &EasysearchClient) -> Result<Vec<String>, String> {
    elasticsearch_driver::list_indices(&client.inner).await.map_err(easysearch_error)
}

pub async fn get_columns(client: &EasysearchClient, index: &str) -> Result<Vec<ColumnInfo>, String> {
    elasticsearch_driver::get_columns(&client.inner, index).await.map_err(easysearch_error)
}

pub async fn find_documents(
    client: &EasysearchClient,
    index: &str,
    skip: u64,
    limit: i64,
    filter: Option<&str>,
    sort: Option<&str>,
) -> Result<DocumentQueryResult, String> {
    elasticsearch_driver::find_documents(&client.inner, index, skip, limit, filter, sort)
        .await
        .map_err(easysearch_error)
}

pub async fn count_documents(client: &EasysearchClient, index: &str, filter: Option<&str>) -> Result<u64, String> {
    elasticsearch_driver::count_documents(&client.inner, index, filter).await.map_err(easysearch_error)
}

pub async fn insert_document(
    client: &EasysearchClient,
    index: &str,
    doc_json: &str,
    routing: Option<&str>,
) -> Result<String, String> {
    elasticsearch_driver::insert_document(&client.inner, index, doc_json, routing).await.map_err(easysearch_error)
}

pub async fn update_document(
    client: &EasysearchClient,
    index: &str,
    id: &str,
    doc_json: &str,
    routing: Option<&str>,
) -> Result<u64, String> {
    elasticsearch_driver::update_document(&client.inner, index, id, doc_json, routing).await.map_err(easysearch_error)
}

pub async fn delete_document(
    client: &EasysearchClient,
    index: &str,
    id: &str,
    document_type: Option<&str>,
    routing: Option<&str>,
) -> Result<u64, String> {
    elasticsearch_driver::delete_document(&client.inner, index, id, document_type, routing)
        .await
        .map_err(easysearch_error)
}

pub async fn execute_rest_query(client: &EasysearchClient, input: &str) -> Result<QueryResult, String> {
    elasticsearch_driver::execute_rest_query_with_sql_parser(&client.inner, input, parse_sql_response)
        .await
        .map_err(easysearch_error)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn parses_easysearch_sql_response() {
        let result = super::parse_sql_response(
            &json!({
                "schema": [
                    { "name": "title", "type": "keyword" },
                    { "name": "price", "type": "integer" }
                ],
                "datarows": [["gamma", 30], ["beta", 20]],
                "total": 3,
                "size": 2,
                "status": 200
            }),
            std::time::Instant::now(),
        )
        .unwrap();

        assert_eq!(result.columns, vec!["title", "price"]);
        assert_eq!(result.rows, vec![vec![json!("gamma"), json!(30)], vec![json!("beta"), json!(20)]]);
        assert_eq!(result.affected_rows, 3);
    }

    #[test]
    fn accepts_elasticsearch_compatible_sql_response() {
        let result = super::parse_sql_response(
            &json!({
                "columns": [{ "name": "title", "type": "keyword" }],
                "rows": [["gamma"]]
            }),
            std::time::Instant::now(),
        )
        .unwrap();

        assert_eq!(result.columns, vec!["title"]);
        assert_eq!(result.rows, vec![vec![json!("gamma")]]);
        assert_eq!(result.affected_rows, 1);
    }
}
