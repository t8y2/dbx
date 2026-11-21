use std::time::Duration;

use crate::db::document_result::DocumentQueryResult;
use crate::models::connection::ConnectionConfig;
use crate::types::QueryResult;

const FEATURE_DISABLED: &str = "DynamoDB support is not included in this DBX build";

#[derive(Clone)]
pub struct DynamoDbClient {
    pub region: String,
    pub endpoint_url: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DynamoDbKeyInfo {
    pub name: String,
    pub attribute_type: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DynamoDbIndexInfo {
    pub name: String,
    pub kind: String,
    pub partition_key: DynamoDbKeyInfo,
    pub sort_key: Option<DynamoDbKeyInfo>,
    pub projection_type: String,
    pub non_key_attributes: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DynamoDbTableDescription {
    pub name: String,
    pub status: String,
    pub item_count: u64,
    pub size_bytes: u64,
    pub partition_key: DynamoDbKeyInfo,
    pub sort_key: Option<DynamoDbKeyInfo>,
    pub indexes: Vec<DynamoDbIndexInfo>,
}

pub fn connect(_config: &ConnectionConfig, _host: &str, _port: u16) -> Result<DynamoDbClient, String> {
    Err(FEATURE_DISABLED.to_string())
}

pub async fn test_connection(_client: &DynamoDbClient, _timeout: Duration) -> Result<(), String> {
    Err(FEATURE_DISABLED.to_string())
}

pub async fn execute_statement(
    _client: &DynamoDbClient,
    _source: &str,
    _max_rows: usize,
) -> Result<QueryResult, String> {
    Err(FEATURE_DISABLED.to_string())
}

pub async fn list_tables(_client: &DynamoDbClient) -> Result<Vec<String>, String> {
    Err(FEATURE_DISABLED.to_string())
}

pub async fn describe_table(_client: &DynamoDbClient, _table_name: &str) -> Result<DynamoDbTableDescription, String> {
    Err(FEATURE_DISABLED.to_string())
}

pub async fn find_items(
    _client: &DynamoDbClient,
    _table_name: &str,
    _limit: i64,
    _filter_json: Option<&str>,
    _sort_json: Option<&str>,
    _cursor: Option<&str>,
) -> Result<DocumentQueryResult, String> {
    Err(FEATURE_DISABLED.to_string())
}

pub async fn count_items(
    _client: &DynamoDbClient,
    _table_name: &str,
    _filter_json: Option<&str>,
) -> Result<u64, String> {
    Err(FEATURE_DISABLED.to_string())
}

pub async fn insert_item(_client: &DynamoDbClient, _table_name: &str, _doc_json: &str) -> Result<String, String> {
    Err(FEATURE_DISABLED.to_string())
}

pub async fn update_item(
    _client: &DynamoDbClient,
    _table_name: &str,
    _id: &str,
    _doc_json: &str,
) -> Result<u64, String> {
    Err(FEATURE_DISABLED.to_string())
}

pub async fn delete_item(_client: &DynamoDbClient, _table_name: &str, _id: &str) -> Result<u64, String> {
    Err(FEATURE_DISABLED.to_string())
}
