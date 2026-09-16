use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};

use aws_sdk_dynamodb::config::{Credentials, Region};
use aws_sdk_dynamodb::error::ProvideErrorMetadata;
use aws_sdk_dynamodb::primitives::Blob;
use aws_sdk_dynamodb::types::{AttributeValue, Delete, KeySchemaElement, KeyType, Put, Select, TransactWriteItem};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde_json::{Map, Value};
use tokio::sync::RwLock;

use crate::db::document_result::DocumentQueryResult;
use crate::models::connection::ConnectionConfig;
use crate::types::QueryResult;

const DEFAULT_REGION: &str = "us-east-1";
const MAX_PAGE_SIZE: i32 = 1000;
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const DYNAMODB_JSON_TYPE_TAG: &str = "$dbxDynamoDb";
const DYNAMODB_JSON_TYPE_VERSION: u64 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DynamoDbStatementOperation {
    Read,
    Insert,
    Put,
    Delete,
}

#[derive(Debug, PartialEq)]
struct DynamoDbStatement {
    operation: DynamoDbStatementOperation,
    table: String,
    limit: Option<i64>,
    filter: Option<Value>,
    sort: Option<Value>,
    cursor: Option<String>,
    key: Option<Value>,
    item: Option<Value>,
}

macro_rules! dynamodb_sdk_error {
    ($context:expr, $error:expr) => {{
        let error = $error;
        if let Some(service_error) = error.as_service_error() {
            format!(
                "{}: {}: {}",
                $context,
                service_error.code().unwrap_or("ServiceError"),
                service_error.message().unwrap_or("No details returned by DynamoDB")
            )
        } else {
            format!("{}: {}", $context, error)
        }
    }};
}

#[derive(Clone)]
pub struct DynamoDbClient {
    client: aws_sdk_dynamodb::Client,
    pub region: String,
    pub endpoint_url: String,
    table_cache: Arc<RwLock<HashMap<String, DynamoDbTableDescription>>>,
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

#[derive(Debug, Clone)]
struct KeySchema {
    partition_key: String,
    sort_key: Option<String>,
}

#[derive(Debug)]
struct ReadPlan {
    index_name: Option<String>,
    key_condition: Option<CompiledExpression>,
    filter: Option<CompiledExpression>,
    scan_index_forward: bool,
}

#[derive(Debug, Default)]
struct CompiledExpression {
    expression: String,
    names: HashMap<String, String>,
    values: HashMap<String, AttributeValue>,
}

struct ExpressionCompiler {
    namespace: &'static str,
    names: HashMap<String, String>,
    values: HashMap<String, AttributeValue>,
    next_name: usize,
    next_value: usize,
}

struct ConditionClause {
    expression: String,
    precedence: u8,
}

impl ExpressionCompiler {
    fn new(namespace: &'static str) -> Self {
        Self { namespace, names: HashMap::new(), values: HashMap::new(), next_name: 0, next_value: 0 }
    }

    fn path(&mut self, field: &str) -> Result<String, String> {
        let segments = field.split('.').map(str::trim).collect::<Vec<_>>();
        if segments.is_empty() || segments.iter().any(|segment| segment.is_empty()) {
            return Err(format!("Invalid DynamoDB attribute path: {field}"));
        }
        Ok(segments
            .into_iter()
            .map(|segment| {
                let token = format!("#{}n{}", self.namespace, self.next_name);
                self.next_name += 1;
                self.names.insert(token.clone(), segment.to_string());
                token
            })
            .collect::<Vec<_>>()
            .join("."))
    }

    fn value(&mut self, value: &Value) -> Result<String, String> {
        let token = format!(":{}v{}", self.namespace, self.next_value);
        self.next_value += 1;
        self.values.insert(token.clone(), json_to_attribute_value(value)?);
        Ok(token)
    }

    fn compile(mut self, value: &Value) -> Result<CompiledExpression, String> {
        let expression = self.condition(value)?;
        Ok(CompiledExpression { expression, names: self.names, values: self.values })
    }

    fn compile_key_condition(mut self, value: &Value) -> Result<CompiledExpression, String> {
        let mut clauses = Vec::new();
        for term in flatten_and_terms(value)? {
            let object = term.as_object().ok_or_else(|| "DynamoDB key condition must be an object".to_string())?;
            if object.len() != 1 {
                return Err("DynamoDB key condition terms must contain one attribute".to_string());
            }
            let (field, condition) = object.iter().next().expect("checked length");
            clauses.push(self.field_condition(field, condition)?);
        }
        if clauses.is_empty() {
            return Err("DynamoDB key condition does not contain any attributes".to_string());
        }
        Ok(CompiledExpression { expression: clauses.join(" AND "), names: self.names, values: self.values })
    }

    fn condition(&mut self, value: &Value) -> Result<String, String> {
        self.condition_clause(value).map(|clause| clause.expression)
    }

    fn condition_clause(&mut self, value: &Value) -> Result<ConditionClause, String> {
        let object = value.as_object().ok_or_else(|| "DynamoDB filter must be a JSON object".to_string())?;
        let mut clauses = Vec::new();
        for (field, condition) in object {
            match field.as_str() {
                "$index" => continue,
                "$and" | "$or" => {
                    let entries =
                        condition.as_array().ok_or_else(|| format!("{field} must be an array of filter objects"))?;
                    if entries.is_empty() {
                        continue;
                    }
                    let operator = if field == "$and" { " AND " } else { " OR " };
                    let precedence = if field == "$and" { 2 } else { 1 };
                    let nested =
                        entries.iter().map(|entry| self.condition_clause(entry)).collect::<Result<Vec<_>, _>>()?;
                    clauses.push(join_condition_clauses(nested, operator, precedence));
                }
                field if field.starts_with('$') => {
                    return Err(format!("Unsupported DynamoDB filter operator: {field}"));
                }
                _ => {
                    clauses.push(ConditionClause { expression: self.field_condition(field, condition)?, precedence: 3 })
                }
            }
        }
        if clauses.is_empty() {
            return Err("DynamoDB filter does not contain any conditions".to_string());
        }
        Ok(join_condition_clauses(clauses, " AND ", 2))
    }

    fn field_condition(&mut self, field: &str, condition: &Value) -> Result<String, String> {
        let path = self.path(field)?;
        let Some(operators) = filter_operator_object(condition) else {
            let value = self.value(condition)?;
            return Ok(format!("{path} = {value}"));
        };

        let mut clauses = Vec::new();
        for (operator, operand) in operators {
            let clause = match operator.as_str() {
                "$eq" => format!("{path} = {}", self.value(operand)?),
                "$ne" => format!("{path} <> {}", self.value(operand)?),
                "$gt" => format!("{path} > {}", self.value(operand)?),
                "$gte" => format!("{path} >= {}", self.value(operand)?),
                "$lt" => format!("{path} < {}", self.value(operand)?),
                "$lte" => format!("{path} <= {}", self.value(operand)?),
                "$contains" => format!("contains({path}, {})", self.value(operand)?),
                "$notContains" => format!("NOT contains({path}, {})", self.value(operand)?),
                "$beginsWith" => format!("begins_with({path}, {})", self.value(operand)?),
                "$exists" => {
                    if operand.as_bool().unwrap_or(false) {
                        format!("attribute_exists({path})")
                    } else {
                        format!("attribute_not_exists({path})")
                    }
                }
                "$between" => {
                    let values = operand
                        .as_array()
                        .filter(|values| values.len() == 2)
                        .ok_or_else(|| format!("DynamoDB $between for {field} must contain exactly two values"))?;
                    format!("{path} BETWEEN {} AND {}", self.value(&values[0])?, self.value(&values[1])?)
                }
                "$in" => {
                    let values = operand
                        .as_array()
                        .filter(|values| !values.is_empty())
                        .ok_or_else(|| format!("DynamoDB $in for {field} must contain at least one value"))?;
                    let tokens = values.iter().map(|value| self.value(value)).collect::<Result<Vec<_>, _>>()?;
                    format!("{path} IN ({})", tokens.join(", "))
                }
                "$regex" => {
                    let text = operand
                        .as_str()
                        .ok_or_else(|| format!("DynamoDB contains filter for {field} must be a string"))?;
                    format!("contains({path}, {})", self.value(&Value::String(text.to_string()))?)
                }
                "$options" => continue,
                "$not" => {
                    let nested = operand
                        .as_object()
                        .and_then(|object| object.get("$regex"))
                        .and_then(Value::as_str)
                        .ok_or_else(|| format!("Unsupported DynamoDB $not condition for {field}"))?;
                    format!("NOT contains({path}, {})", self.value(&Value::String(nested.to_string()))?)
                }
                other => return Err(format!("Unsupported DynamoDB filter operator: {other}")),
            };
            clauses.push(clause);
        }
        if clauses.is_empty() {
            return Err(format!("DynamoDB filter for {field} does not contain a condition"));
        }
        Ok(clauses.join(" AND "))
    }
}

fn join_condition_clauses(clauses: Vec<ConditionClause>, operator: &str, precedence: u8) -> ConditionClause {
    if clauses.len() == 1 {
        return clauses.into_iter().next().expect("checked length");
    }
    let expression = clauses
        .into_iter()
        .map(
            |clause| {
                if clause.precedence < precedence {
                    format!("({})", clause.expression)
                } else {
                    clause.expression
                }
            },
        )
        .collect::<Vec<_>>()
        .join(operator);
    ConditionClause { expression, precedence }
}

pub fn endpoint_url(config: &ConnectionConfig, host: &str, port: u16) -> String {
    let scheme = if config.ssl { "https" } else { "http" };
    format!("{scheme}://{host}:{port}")
}

pub fn region(config: &ConnectionConfig) -> String {
    config.database.as_deref().map(str::trim).filter(|value| !value.is_empty()).unwrap_or(DEFAULT_REGION).to_string()
}

pub fn connect(config: &ConnectionConfig, host: &str, port: u16) -> Result<DynamoDbClient, String> {
    let region = region(config);
    let endpoint_url = endpoint_url(config, host, port);
    let access_key = config.username.trim();
    let secret_key = config.password.trim();
    if access_key.is_empty() {
        return Err("DynamoDB Access Key ID is required".to_string());
    }
    if secret_key.is_empty() {
        return Err("DynamoDB Secret Access Key is required".to_string());
    }
    let session_token = config.connection_string.as_deref().map(str::trim).filter(|value| !value.is_empty());
    let credentials = Credentials::new(access_key, secret_key, session_token.map(str::to_string), None, "dbx");
    let sdk_config = aws_sdk_dynamodb::config::Builder::new()
        .behavior_version_latest()
        .region(Region::new(region.clone()))
        .credentials_provider(credentials)
        .endpoint_url(endpoint_url.clone())
        .build();
    Ok(DynamoDbClient {
        client: aws_sdk_dynamodb::Client::from_conf(sdk_config),
        region,
        endpoint_url,
        table_cache: Arc::new(RwLock::new(HashMap::new())),
    })
}

pub async fn test_connection(client: &DynamoDbClient, timeout: Duration) -> Result<(), String> {
    tokio::time::timeout(timeout, client.client.list_tables().limit(1).send())
        .await
        .map_err(|_| format!("DynamoDB connection timed out ({}s)", timeout.as_secs()))?
        .map(|_| ())
        .map_err(|error| dynamodb_sdk_error!("DynamoDB connection failed", error))
}

pub async fn execute_statement(client: &DynamoDbClient, source: &str, max_rows: usize) -> Result<QueryResult, String> {
    let started = Instant::now();
    let statement = parse_dynamodb_statement(source)?;
    match statement.operation {
        DynamoDbStatementOperation::Read => {
            let requested_limit = statement.limit.unwrap_or(max_rows.max(1).min(MAX_PAGE_SIZE as usize) as i64);
            let effective_limit = requested_limit.min(max_rows.max(1).min(i64::MAX as usize) as i64);
            let filter =
                statement.filter.as_ref().map(serde_json::to_string).transpose().map_err(|error| error.to_string())?;
            let sort =
                statement.sort.as_ref().map(serde_json::to_string).transpose().map_err(|error| error.to_string())?;
            let result = find_items(
                client,
                &statement.table,
                effective_limit,
                filter.as_deref(),
                sort.as_deref(),
                statement.cursor.as_deref(),
            )
            .await?;
            Ok(document_query_result(result, started))
        }
        DynamoDbStatementOperation::Insert => {
            let key = serde_json::to_string(statement.key.as_ref().expect("validated DynamoDB insert key"))
                .map_err(|error| error.to_string())?;
            let item = serde_json::to_string(statement.item.as_ref().expect("validated DynamoDB insert item"))
                .map_err(|error| error.to_string())?;
            insert_item_with_expected_identity(client, &statement.table, &item, Some(&key)).await?;
            Ok(affected_query_result(1, started))
        }
        DynamoDbStatementOperation::Put => {
            let key = serde_json::to_string(statement.key.as_ref().expect("validated DynamoDB put key"))
                .map_err(|error| error.to_string())?;
            let item = serde_json::to_string(statement.item.as_ref().expect("validated DynamoDB put item"))
                .map_err(|error| error.to_string())?;
            let affected = update_item(client, &statement.table, &key, &item).await?;
            Ok(affected_query_result(affected, started))
        }
        DynamoDbStatementOperation::Delete => {
            let key = serde_json::to_string(statement.key.as_ref().expect("validated DynamoDB delete key"))
                .map_err(|error| error.to_string())?;
            let affected = delete_item(client, &statement.table, &key).await?;
            Ok(affected_query_result(affected, started))
        }
    }
}

fn parse_dynamodb_statement(source: &str) -> Result<DynamoDbStatement, String> {
    let mut lines = source.lines();
    let header = lines
        .find(|line| !line.trim().is_empty())
        .map(str::trim)
        .ok_or_else(|| "DynamoDB statement is empty".to_string())?;
    let operation = match header.to_ascii_uppercase().as_str() {
        "DBX DYNAMODB SCAN" | "DBX DYNAMODB QUERY / SCAN" => DynamoDbStatementOperation::Read,
        "DBX DYNAMODB INSERT ITEM" => DynamoDbStatementOperation::Insert,
        "DBX DYNAMODB PUT ITEM" => DynamoDbStatementOperation::Put,
        "DBX DYNAMODB DELETE ITEM" => DynamoDbStatementOperation::Delete,
        _ => {
            return Err(
                "Unsupported DynamoDB statement. Use a DBX DYNAMODB SCAN, QUERY / SCAN, INSERT ITEM, PUT ITEM, or DELETE ITEM statement."
                    .to_string(),
            )
        }
    };

    let mut fields = HashMap::new();
    let mut current_name: Option<String> = None;
    let mut current_value = String::new();
    for line in lines {
        if let Some((name, value)) = dynamodb_statement_field(line) {
            finish_dynamodb_statement_field(&mut fields, current_name.take(), &mut current_value)?;
            current_name = Some(name.to_string());
            current_value.push_str(value.trim_start());
        } else if current_name.is_some() {
            if !current_value.is_empty() {
                current_value.push('\n');
            }
            current_value.push_str(line);
        } else if !line.trim().is_empty() {
            return Err(format!("Invalid DynamoDB statement line: {line}"));
        }
    }
    finish_dynamodb_statement_field(&mut fields, current_name.take(), &mut current_value)?;

    let table = take_dynamodb_string_field(&mut fields, "table", true)?.expect("required table field");
    let limit = take_dynamodb_integer_field(&mut fields, "limit")?;
    if limit.is_some_and(|value| value <= 0) {
        return Err("DynamoDB statement limit must be greater than zero".to_string());
    }
    let filter = take_dynamodb_object_field(&mut fields, "filter")?;
    let sort = take_dynamodb_object_field(&mut fields, "sort")?;
    let cursor = take_dynamodb_string_field(&mut fields, "cursor", false)?;
    let key = take_dynamodb_object_field(&mut fields, "key")?;
    let item = take_dynamodb_object_field(&mut fields, "item")?;
    if !fields.is_empty() {
        return Err(format!("Unsupported DynamoDB statement field: {}", fields.keys().next().unwrap()));
    }

    match operation {
        DynamoDbStatementOperation::Read => {
            if key.is_some() || item.is_some() {
                return Err("DynamoDB read statements do not accept key or item fields".to_string());
            }
        }
        DynamoDbStatementOperation::Insert | DynamoDbStatementOperation::Put => {
            if key.is_none() || item.is_none() {
                return Err("DynamoDB INSERT ITEM and PUT ITEM statements require key and item fields".to_string());
            }
            if limit.is_some() || filter.is_some() || sort.is_some() || cursor.is_some() {
                return Err("DynamoDB item write statements accept only table, key, and item fields".to_string());
            }
        }
        DynamoDbStatementOperation::Delete => {
            if key.is_none() {
                return Err("DynamoDB DELETE ITEM statements require a key field".to_string());
            }
            if item.is_some() || limit.is_some() || filter.is_some() || sort.is_some() || cursor.is_some() {
                return Err("DynamoDB DELETE ITEM statements accept only table and key fields".to_string());
            }
        }
    }

    Ok(DynamoDbStatement { operation, table, limit, filter, sort, cursor, key, item })
}

fn dynamodb_statement_field(line: &str) -> Option<(&str, &str)> {
    if line.chars().next().is_some_and(char::is_whitespace) {
        return None;
    }
    let (name, value) = line.split_once(':')?;
    let name = name.trim();
    matches!(name, "table" | "limit" | "filter" | "sort" | "cursor" | "key" | "item").then_some((name, value))
}

fn finish_dynamodb_statement_field(
    fields: &mut HashMap<String, String>,
    name: Option<String>,
    value: &mut String,
) -> Result<(), String> {
    let Some(name) = name else {
        return Ok(());
    };
    let value = std::mem::take(value).trim().to_string();
    if value.is_empty() {
        return Err(format!("DynamoDB statement field {name} cannot be empty"));
    }
    if fields.insert(name.clone(), value).is_some() {
        return Err(format!("Duplicate DynamoDB statement field: {name}"));
    }
    Ok(())
}

fn take_dynamodb_string_field(
    fields: &mut HashMap<String, String>,
    name: &str,
    required: bool,
) -> Result<Option<String>, String> {
    let Some(raw) = fields.remove(name) else {
        return if required { Err(format!("DynamoDB statement requires a {name} field")) } else { Ok(None) };
    };
    let value: Value = serde_json::from_str(&raw).map_err(|error| format!("Invalid DynamoDB {name} value: {error}"))?;
    let value = value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("DynamoDB statement field {name} must be a non-empty JSON string"))?;
    Ok(Some(value.to_string()))
}

fn take_dynamodb_integer_field(fields: &mut HashMap<String, String>, name: &str) -> Result<Option<i64>, String> {
    fields
        .remove(name)
        .map(|raw| raw.parse::<i64>().map_err(|error| format!("Invalid DynamoDB {name} value: {error}")))
        .transpose()
}

fn take_dynamodb_object_field(fields: &mut HashMap<String, String>, name: &str) -> Result<Option<Value>, String> {
    let Some(raw) = fields.remove(name) else {
        return Ok(None);
    };
    let value: Value = serde_json::from_str(&raw).map_err(|error| format!("Invalid DynamoDB {name} JSON: {error}"))?;
    if !value.is_object() {
        return Err(format!("DynamoDB statement field {name} must be a JSON object"));
    }
    Ok(Some(value))
}

fn document_query_result(result: DocumentQueryResult, started: Instant) -> QueryResult {
    let truncated = result.next_cursor.is_some();
    let documents = result.documents;
    let mut column_names = BTreeSet::new();
    for document in &documents {
        if let Some(object) = document.as_object() {
            column_names.extend(object.keys().cloned());
        } else {
            column_names.insert("value".to_string());
        }
    }
    let columns = column_names.into_iter().collect::<Vec<_>>();
    let rows = documents
        .into_iter()
        .map(|document| {
            columns
                .iter()
                .map(|column| {
                    document
                        .as_object()
                        .and_then(|object| object.get(column))
                        .cloned()
                        .or_else(|| (column == "value").then(|| document.clone()))
                        .unwrap_or(Value::Null)
                })
                .collect()
        })
        .collect();
    QueryResult {
        columns,
        column_types: Vec::new(),
        column_sortables: Vec::new(),
        spatial_columns: Vec::new(),
        spatial_values: Vec::new(),
        rows,
        affected_rows: 0,
        execution_time_ms: started.elapsed().as_millis(),
        truncated,
        session_id: None,
        has_more: false,
        elasticsearch_raw_body: None,
        messages: Vec::new(),
    }
}

fn affected_query_result(affected_rows: u64, started: Instant) -> QueryResult {
    QueryResult {
        columns: Vec::new(),
        column_types: Vec::new(),
        column_sortables: Vec::new(),
        spatial_columns: Vec::new(),
        spatial_values: Vec::new(),
        rows: Vec::new(),
        affected_rows,
        execution_time_ms: started.elapsed().as_millis(),
        truncated: false,
        session_id: None,
        has_more: false,
        elasticsearch_raw_body: None,
        messages: Vec::new(),
    }
}

pub async fn list_tables(client: &DynamoDbClient) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    let mut start = None;
    loop {
        let output = client
            .client
            .list_tables()
            .set_exclusive_start_table_name(start)
            .send()
            .await
            .map_err(|error| dynamodb_sdk_error!("Failed to list DynamoDB tables", error))?;
        names.extend(output.table_names().iter().cloned());
        start = output.last_evaluated_table_name().map(str::to_string);
        if start.is_none() {
            break;
        }
    }
    names.sort_by_key(|name| name.to_lowercase());
    Ok(names)
}

pub async fn describe_table(client: &DynamoDbClient, table_name: &str) -> Result<DynamoDbTableDescription, String> {
    if let Some(cached) = client.table_cache.read().await.get(table_name).cloned() {
        return Ok(cached);
    }
    let output = client
        .client
        .describe_table()
        .table_name(table_name)
        .send()
        .await
        .map_err(|error| dynamodb_sdk_error!(format!("Failed to describe DynamoDB table {table_name}"), error))?;
    let table = output.table().ok_or_else(|| format!("DynamoDB did not return metadata for table {table_name}"))?;
    let attribute_types = table
        .attribute_definitions()
        .iter()
        .map(|attribute| (attribute.attribute_name().to_string(), attribute.attribute_type().as_str().to_string()))
        .collect::<HashMap<_, _>>();
    let (partition_key, sort_key) = key_info(table.key_schema(), &attribute_types)?;
    let mut indexes = Vec::new();
    for index in table.global_secondary_indexes() {
        let (index_partition, index_sort) = key_info(index.key_schema(), &attribute_types)?;
        let (projection_type, non_key_attributes) = index_projection(index.projection());
        indexes.push(DynamoDbIndexInfo {
            name: index.index_name().unwrap_or_default().to_string(),
            kind: "global".to_string(),
            partition_key: index_partition,
            sort_key: index_sort,
            projection_type,
            non_key_attributes,
        });
    }
    for index in table.local_secondary_indexes() {
        let (index_partition, index_sort) = key_info(index.key_schema(), &attribute_types)?;
        let (projection_type, non_key_attributes) = index_projection(index.projection());
        indexes.push(DynamoDbIndexInfo {
            name: index.index_name().unwrap_or_default().to_string(),
            kind: "local".to_string(),
            partition_key: index_partition,
            sort_key: index_sort,
            projection_type,
            non_key_attributes,
        });
    }
    indexes.sort_by_key(|index| index.name.to_lowercase());

    let description = DynamoDbTableDescription {
        name: table.table_name().unwrap_or(table_name).to_string(),
        status: table.table_status().map(|status| status.as_str().to_string()).unwrap_or_default(),
        item_count: table.item_count().unwrap_or_default().max(0) as u64,
        size_bytes: table.table_size_bytes().unwrap_or_default().max(0) as u64,
        partition_key,
        sort_key,
        indexes,
    };
    client.table_cache.write().await.insert(table_name.to_string(), description.clone());
    Ok(description)
}

fn index_projection(projection: Option<&aws_sdk_dynamodb::types::Projection>) -> (String, Vec<String>) {
    let projection_type = projection
        .and_then(|projection| projection.projection_type())
        .map(|projection_type| projection_type.as_str().to_string())
        .unwrap_or_else(|| "UNKNOWN".to_string());
    let non_key_attributes = projection.map(|projection| projection.non_key_attributes().to_vec()).unwrap_or_default();
    (projection_type, non_key_attributes)
}

fn key_info(
    schema: &[KeySchemaElement],
    attribute_types: &HashMap<String, String>,
) -> Result<(DynamoDbKeyInfo, Option<DynamoDbKeyInfo>), String> {
    let key = |key_type: &KeyType| {
        schema.iter().find(|element| element.key_type() == key_type).map(|element| DynamoDbKeyInfo {
            name: element.attribute_name().to_string(),
            attribute_type: attribute_types.get(element.attribute_name()).cloned().unwrap_or_default(),
        })
    };
    let partition_key = key(&KeyType::Hash).ok_or_else(|| "DynamoDB table has no partition key".to_string())?;
    Ok((partition_key, key(&KeyType::Range)))
}

pub async fn find_items(
    client: &DynamoDbClient,
    table_name: &str,
    limit: i64,
    filter_json: Option<&str>,
    sort_json: Option<&str>,
    cursor: Option<&str>,
) -> Result<DocumentQueryResult, String> {
    let table = describe_table(client, table_name).await?;
    let filter_value = parse_filter(filter_json)?;
    let plan = build_read_plan(&table, filter_value.as_ref(), sort_json)?;
    let requested = limit.clamp(1, MAX_PAGE_SIZE as i64) as usize;
    let mut next_key = cursor.map(decode_cursor).transpose()?;
    let mut items = Vec::with_capacity(requested);

    while items.len() < requested {
        // DynamoDB applies Limit before FilterExpression. Limiting each request
        // to the remaining result capacity keeps LastEvaluatedKey aligned with
        // the last item that this page is allowed to expose.
        let request_limit = (requested - items.len()).clamp(1, MAX_PAGE_SIZE as usize) as i32;
        let page = read_page(client, table_name, &plan, request_limit, next_key.take()).await?;
        items.extend(page.items);
        next_key = page.last_evaluated_key;
        if next_key.is_none() || page.evaluated_count == 0 {
            break;
        }
    }
    let key_names = [Some(table.partition_key.name.as_str()), table.sort_key.as_ref().map(|key| key.name.as_str())]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let documents = items.into_iter().map(|item| item_to_document(item, &key_names)).collect::<Result<Vec<_>, _>>()?;
    let next_cursor = next_key.as_ref().map(encode_cursor).transpose()?;
    Ok(DocumentQueryResult {
        total: documents.len() as u64 + u64::from(next_cursor.is_some()),
        documents,
        raw_documents: None,
        extended_documents: None,
        total_is_exact: next_cursor.is_none() && cursor.is_none(),
        next_cursor,
    })
}

struct ReadPage {
    items: Vec<HashMap<String, AttributeValue>>,
    last_evaluated_key: Option<HashMap<String, AttributeValue>>,
    evaluated_count: i32,
}

async fn read_page(
    client: &DynamoDbClient,
    table_name: &str,
    plan: &ReadPlan,
    limit: i32,
    cursor: Option<HashMap<String, AttributeValue>>,
) -> Result<ReadPage, String> {
    if let Some(key_condition) = &plan.key_condition {
        let mut names = key_condition.names.clone();
        let mut values = key_condition.values.clone();
        if let Some(filter) = &plan.filter {
            names.extend(filter.names.clone());
            values.extend(filter.values.clone());
        }
        let output = client
            .client
            .query()
            .table_name(table_name)
            .set_index_name(plan.index_name.clone())
            .key_condition_expression(&key_condition.expression)
            .set_filter_expression(plan.filter.as_ref().map(|filter| filter.expression.clone()))
            .set_expression_attribute_names((!names.is_empty()).then_some(names))
            .set_expression_attribute_values((!values.is_empty()).then_some(values))
            .set_exclusive_start_key(cursor)
            .scan_index_forward(plan.scan_index_forward)
            .limit(limit)
            .send()
            .await
            .map_err(|error| dynamodb_sdk_error!("DynamoDB Query failed", error))?;
        Ok(ReadPage {
            items: output.items().to_vec(),
            last_evaluated_key: output.last_evaluated_key().cloned(),
            evaluated_count: output.scanned_count(),
        })
    } else {
        let output = client
            .client
            .scan()
            .table_name(table_name)
            .set_index_name(plan.index_name.clone())
            .set_filter_expression(plan.filter.as_ref().map(|filter| filter.expression.clone()))
            .set_expression_attribute_names(
                plan.filter.as_ref().and_then(|filter| (!filter.names.is_empty()).then_some(filter.names.clone())),
            )
            .set_expression_attribute_values(
                plan.filter.as_ref().and_then(|filter| (!filter.values.is_empty()).then_some(filter.values.clone())),
            )
            .set_exclusive_start_key(cursor)
            .limit(limit)
            .send()
            .await
            .map_err(|error| dynamodb_sdk_error!("DynamoDB Scan failed", error))?;
        Ok(ReadPage {
            items: output.items().to_vec(),
            last_evaluated_key: output.last_evaluated_key().cloned(),
            evaluated_count: output.scanned_count(),
        })
    }
}

pub async fn count_items(client: &DynamoDbClient, table_name: &str, filter_json: Option<&str>) -> Result<u64, String> {
    let table = describe_table(client, table_name).await?;
    let filter = parse_filter(filter_json)?;
    let plan = build_read_plan(&table, filter.as_ref(), None)?;
    let mut cursor = None;
    let mut count = 0_u64;
    loop {
        if let Some(key_condition) = &plan.key_condition {
            let mut names = key_condition.names.clone();
            let mut values = key_condition.values.clone();
            if let Some(filter) = &plan.filter {
                names.extend(filter.names.clone());
                values.extend(filter.values.clone());
            }
            let output = client
                .client
                .query()
                .table_name(table_name)
                .set_index_name(plan.index_name.clone())
                .key_condition_expression(&key_condition.expression)
                .set_filter_expression(plan.filter.as_ref().map(|filter| filter.expression.clone()))
                .set_expression_attribute_names((!names.is_empty()).then_some(names))
                .set_expression_attribute_values((!values.is_empty()).then_some(values))
                .set_exclusive_start_key(cursor.take())
                .select(Select::Count)
                .send()
                .await
                .map_err(|error| dynamodb_sdk_error!("DynamoDB count Query failed", error))?;
            count += output.count().max(0) as u64;
            cursor = output.last_evaluated_key().cloned();
        } else {
            let output = client
                .client
                .scan()
                .table_name(table_name)
                .set_index_name(plan.index_name.clone())
                .set_filter_expression(plan.filter.as_ref().map(|filter| filter.expression.clone()))
                .set_expression_attribute_names(
                    plan.filter.as_ref().and_then(|filter| (!filter.names.is_empty()).then_some(filter.names.clone())),
                )
                .set_expression_attribute_values(
                    plan.filter
                        .as_ref()
                        .and_then(|filter| (!filter.values.is_empty()).then_some(filter.values.clone())),
                )
                .set_exclusive_start_key(cursor.take())
                .select(Select::Count)
                .send()
                .await
                .map_err(|error| dynamodb_sdk_error!("DynamoDB count Scan failed", error))?;
            count += output.count().max(0) as u64;
            cursor = output.last_evaluated_key().cloned();
        }
        if cursor.is_none() {
            return Ok(count);
        }
    }
}

fn parse_filter(filter_json: Option<&str>) -> Result<Option<Value>, String> {
    let Some(filter_json) = filter_json.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let value: Value =
        serde_json::from_str(filter_json).map_err(|error| format!("Invalid DynamoDB filter JSON: {error}"))?;
    if !value.is_object() {
        return Err("DynamoDB filter must be a JSON object".to_string());
    }
    Ok(Some(value))
}

fn build_read_plan(
    table: &DynamoDbTableDescription,
    filter: Option<&Value>,
    sort_json: Option<&str>,
) -> Result<ReadPlan, String> {
    let index_name = filter
        .and_then(Value::as_object)
        .and_then(|object| object.get("$index"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string);
    let schema = selected_key_schema(table, index_name.as_deref())?;
    let (key_filter, residual_filter) =
        filter.map(|filter| split_key_filter(filter, &schema)).transpose()?.unwrap_or_default();
    let key_condition =
        key_filter.as_ref().map(|filter| ExpressionCompiler::new("k").compile_key_condition(filter)).transpose()?;
    let filter = residual_filter.as_ref().map(|filter| ExpressionCompiler::new("f").compile(filter)).transpose()?;
    let scan_index_forward = parse_scan_index_forward(sort_json, schema.sort_key.as_deref())?;
    if key_condition.is_none() && sort_json.map(str::trim).is_some_and(|sort| !sort.is_empty() && sort != "{}") {
        return Err(
            "DynamoDB Scan does not support sorting; add an equality filter for the selected partition key".to_string()
        );
    }
    Ok(ReadPlan { index_name, key_condition, filter, scan_index_forward })
}

fn selected_key_schema(table: &DynamoDbTableDescription, index_name: Option<&str>) -> Result<KeySchema, String> {
    if let Some(index_name) = index_name {
        let index = table
            .indexes
            .iter()
            .find(|index| index.name == index_name)
            .ok_or_else(|| format!("DynamoDB index not found: {index_name}"))?;
        return Ok(KeySchema {
            partition_key: index.partition_key.name.clone(),
            sort_key: index.sort_key.as_ref().map(|key| key.name.clone()),
        });
    }
    Ok(KeySchema {
        partition_key: table.partition_key.name.clone(),
        sort_key: table.sort_key.as_ref().map(|key| key.name.clone()),
    })
}

fn split_key_filter(filter: &Value, schema: &KeySchema) -> Result<(Option<Value>, Option<Value>), String> {
    let mut terms = flatten_and_terms(filter)?;
    let partition_index = terms.iter().position(|term| equality_value(term, &schema.partition_key).is_some());
    let Some(partition_index) = partition_index else {
        return Ok((None, non_empty_and_filter(terms)));
    };
    let partition_term = terms.remove(partition_index);
    let mut key_terms = vec![partition_term];
    if let Some(sort_key) = &schema.sort_key {
        if let Some(index) = terms.iter().position(|term| is_sort_key_condition(term, sort_key)) {
            key_terms.push(terms.remove(index));
        }
    }
    Ok((non_empty_and_filter(key_terms), non_empty_and_filter(terms)))
}

fn flatten_and_terms(filter: &Value) -> Result<Vec<Value>, String> {
    let object = filter.as_object().ok_or_else(|| "DynamoDB filter must be a JSON object".to_string())?;
    let mut terms = Vec::new();
    for (key, value) in object {
        if key == "$index" {
            continue;
        }
        if key == "$and" {
            let nested = value.as_array().ok_or_else(|| "DynamoDB $and must be an array".to_string())?;
            for entry in nested {
                terms.extend(flatten_and_terms(entry)?);
            }
            continue;
        }
        if key == "$or" {
            return Ok(vec![filter.clone()]);
        }
        terms.push(Value::Object(Map::from_iter([(key.clone(), value.clone())])));
    }
    Ok(terms)
}

fn non_empty_and_filter(terms: Vec<Value>) -> Option<Value> {
    match terms.len() {
        0 => None,
        1 => terms.into_iter().next(),
        _ => Some(serde_json::json!({ "$and": terms })),
    }
}

fn equality_value<'a>(term: &'a Value, field: &str) -> Option<&'a Value> {
    let value = term.as_object()?.get(field)?;
    if let Some(object) = filter_operator_object(value) {
        return (object.len() == 1).then(|| object.get("$eq")).flatten();
    }
    Some(value)
}

fn is_sort_key_condition(term: &Value, field: &str) -> bool {
    let Some(value) = term.as_object().and_then(|object| object.get(field)) else {
        return false;
    };
    let Some(object) = filter_operator_object(value) else {
        return true;
    };
    object.len() == 1
        && object
            .keys()
            .all(|key| matches!(key.as_str(), "$eq" | "$gt" | "$gte" | "$lt" | "$lte" | "$between" | "$beginsWith"))
}

fn filter_operator_object(value: &Value) -> Option<&Map<String, Value>> {
    let object = value.as_object()?;
    object.keys().any(|key| is_filter_operator(key)).then_some(object)
}

fn is_filter_operator(value: &str) -> bool {
    matches!(
        value,
        "$eq"
            | "$ne"
            | "$gt"
            | "$gte"
            | "$lt"
            | "$lte"
            | "$contains"
            | "$notContains"
            | "$beginsWith"
            | "$exists"
            | "$between"
            | "$in"
            | "$regex"
            | "$options"
            | "$not"
    )
}

fn parse_scan_index_forward(sort_json: Option<&str>, sort_key: Option<&str>) -> Result<bool, String> {
    let Some(sort_json) = sort_json.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(true);
    };
    let sort: Value =
        serde_json::from_str(sort_json).map_err(|error| format!("Invalid DynamoDB sort JSON: {error}"))?;
    let object = sort.as_object().ok_or_else(|| "DynamoDB sort must be a JSON object".to_string())?;
    if object.is_empty() {
        return Ok(true);
    }
    if object.len() != 1 {
        return Err("DynamoDB Query can sort by only one sort key".to_string());
    }
    let (field, direction) = object.iter().next().expect("checked length");
    if sort_key != Some(field.as_str()) {
        return Err(format!("DynamoDB Query can sort only by its sort key ({})", sort_key.unwrap_or("none")));
    }
    match direction.as_i64() {
        Some(1) => Ok(true),
        Some(-1) => Ok(false),
        _ => Err("DynamoDB sort direction must be 1 or -1".to_string()),
    }
}

pub async fn insert_item(client: &DynamoDbClient, table_name: &str, doc_json: &str) -> Result<String, String> {
    insert_item_with_expected_identity(client, table_name, doc_json, None).await
}

async fn insert_item_with_expected_identity(
    client: &DynamoDbClient,
    table_name: &str,
    doc_json: &str,
    expected_identity: Option<&str>,
) -> Result<String, String> {
    let table = describe_table(client, table_name).await?;
    let item = json_document_to_item(doc_json)?;
    validate_item_keys(&table, &item)?;
    let identity = encode_identity(&table, &item)?;
    if let Some(expected_identity) = expected_identity {
        let expected: Value = serde_json::from_str(expected_identity)
            .map_err(|error| format!("Invalid DynamoDB item identity: {error}"))?;
        let actual: Value = serde_json::from_str(&identity).map_err(|error| error.to_string())?;
        if expected != actual {
            return Err(format!(
                "DynamoDB key does not match the item key attributes (expected {expected}, received {actual})"
            ));
        }
    }
    client
        .client
        .put_item()
        .table_name(table_name)
        .set_item(Some(item.clone()))
        .condition_expression("attribute_not_exists(#pk)")
        .expression_attribute_names("#pk", &table.partition_key.name)
        .send()
        .await
        .map_err(|error| {
            if error
                .as_service_error()
                .and_then(|service_error| service_error.code())
                .is_some_and(|code| code == "ConditionalCheckFailedException")
            {
                format!(
                    "DynamoDB item already exists for key {identity}. Change the partition/sort key, or edit the existing item instead."
                )
            } else {
                dynamodb_sdk_error!("Failed to put DynamoDB item", error)
            }
        })?;
    Ok(identity)
}

pub async fn update_item(client: &DynamoDbClient, table_name: &str, id: &str, doc_json: &str) -> Result<u64, String> {
    let table = describe_table(client, table_name).await?;
    let old_key = decode_identity_for_table(&table, id)?;
    let item = json_document_to_item(doc_json)?;
    validate_item_keys(&table, &item)?;
    let new_key = item_key(&table, &item)?;

    if old_key == new_key {
        client
            .client
            .put_item()
            .table_name(table_name)
            .set_item(Some(item))
            .condition_expression("attribute_exists(#pk)")
            .expression_attribute_names("#pk", &table.partition_key.name)
            .send()
            .await
            .map_err(|error| {
                if error
                    .as_service_error()
                    .and_then(|service_error| service_error.code())
                    .is_some_and(|code| code == "ConditionalCheckFailedException")
                {
                    format!("DynamoDB item no longer exists for key {id}. Refresh the table and try again.")
                } else {
                    dynamodb_sdk_error!("Failed to replace DynamoDB item", error)
                }
            })?;
        return Ok(1);
    }

    let new_identity = encode_identity(&table, &item)?;
    let put = Put::builder()
        .table_name(table_name)
        .set_item(Some(item))
        .condition_expression("attribute_not_exists(#pk)")
        .expression_attribute_names("#pk", &table.partition_key.name)
        .build()
        .map_err(|error| format!("Failed to build DynamoDB key migration put: {error}"))?;
    let delete = Delete::builder()
        .table_name(table_name)
        .set_key(Some(old_key))
        .condition_expression("attribute_exists(#pk)")
        .expression_attribute_names("#pk", &table.partition_key.name)
        .build()
        .map_err(|error| format!("Failed to build DynamoDB key migration delete: {error}"))?;

    client
        .client
        .transact_write_items()
        .transact_items(TransactWriteItem::builder().put(put).build())
        .transact_items(TransactWriteItem::builder().delete(delete).build())
        .send()
        .await
        .map_err(|error| {
            if let Some(
                aws_sdk_dynamodb::operation::transact_write_items::TransactWriteItemsError::TransactionCanceledException(
                    cancelled,
                ),
            ) = error.as_service_error()
            {
                let reasons = cancelled.cancellation_reasons();
                if reasons.first().and_then(|reason| reason.code()) == Some("ConditionalCheckFailed") {
                    return format!(
                        "DynamoDB item already exists for target key {new_identity}. The original item was not changed."
                    );
                }
                if reasons.get(1).and_then(|reason| reason.code()) == Some("ConditionalCheckFailed") {
                    return format!(
                        "DynamoDB item no longer exists for source key {id}. No new item was created; refresh the table and try again."
                    );
                }
            }
            dynamodb_sdk_error!("Failed to migrate DynamoDB item key atomically", error)
        })?;
    Ok(1)
}

pub async fn delete_item(client: &DynamoDbClient, table_name: &str, id: &str) -> Result<u64, String> {
    let table = describe_table(client, table_name).await?;
    let key = decode_identity_for_table(&table, id)?;
    client
        .client
        .delete_item()
        .table_name(table_name)
        .set_key(Some(key))
        .send()
        .await
        .map_err(|error| dynamodb_sdk_error!("Failed to delete DynamoDB item", error))?;
    Ok(1)
}

fn json_document_to_item(doc_json: &str) -> Result<HashMap<String, AttributeValue>, String> {
    let mut value: Value =
        serde_json::from_str(doc_json).map_err(|error| format!("Invalid DynamoDB item JSON: {error}"))?;
    let object = value.as_object_mut().ok_or_else(|| "DynamoDB item must be a JSON object".to_string())?;
    object.remove("_id");
    object.iter().map(|(key, value)| Ok((key.clone(), json_to_attribute_value(value)?))).collect()
}

fn validate_item_keys(table: &DynamoDbTableDescription, item: &HashMap<String, AttributeValue>) -> Result<(), String> {
    for key in [Some(&table.partition_key), table.sort_key.as_ref()].into_iter().flatten() {
        if !item.contains_key(&key.name) {
            return Err(format!("DynamoDB item requires key attribute: {}", key.name));
        }
        let value = item.get(&key.name).expect("checked above");
        let actual_type = match value {
            AttributeValue::S(_) => "S",
            AttributeValue::N(_) => "N",
            AttributeValue::B(_) => "B",
            _ => "non-scalar",
        };
        if actual_type != key.attribute_type {
            return Err(format!(
                "DynamoDB key attribute {} must use type {} (received {actual_type})",
                key.name, key.attribute_type
            ));
        }
    }
    Ok(())
}

fn item_key(
    table: &DynamoDbTableDescription,
    item: &HashMap<String, AttributeValue>,
) -> Result<HashMap<String, AttributeValue>, String> {
    [Some(&table.partition_key), table.sort_key.as_ref()]
        .into_iter()
        .flatten()
        .map(|key| {
            let value =
                item.get(&key.name).ok_or_else(|| format!("DynamoDB item requires key attribute: {}", key.name))?;
            Ok((key.name.clone(), value.clone()))
        })
        .collect()
}

fn encode_identity(table: &DynamoDbTableDescription, item: &HashMap<String, AttributeValue>) -> Result<String, String> {
    let mut key = HashMap::new();
    for key_info in [Some(&table.partition_key), table.sort_key.as_ref()].into_iter().flatten() {
        let value = item
            .get(&key_info.name)
            .ok_or_else(|| format!("DynamoDB item requires key attribute: {}", key_info.name))?;
        key.insert(key_info.name.clone(), value.clone());
    }
    let display = attribute_map_to_json(&key)?;
    serde_json::to_string(&display).map_err(|error| error.to_string())
}

fn decode_identity(id: &str) -> Result<HashMap<String, AttributeValue>, String> {
    let value: Value = serde_json::from_str(id).map_err(|error| format!("Invalid DynamoDB item identity: {error}"))?;
    let object = value.as_object().ok_or_else(|| "DynamoDB item identity must be a JSON object".to_string())?;
    object.iter().map(|(key, value)| Ok((key.clone(), json_to_attribute_value(value)?))).collect()
}

fn decode_identity_for_table(
    table: &DynamoDbTableDescription,
    id: &str,
) -> Result<HashMap<String, AttributeValue>, String> {
    let identity = decode_identity(id)?;
    let expected = [Some(&table.partition_key), table.sort_key.as_ref()].into_iter().flatten().collect::<Vec<_>>();
    if identity.len() != expected.len() || expected.iter().any(|key| !identity.contains_key(&key.name)) {
        return Err(format!(
            "DynamoDB item identity must contain exactly these key attributes: {}",
            expected.iter().map(|key| key.name.as_str()).collect::<Vec<_>>().join(", ")
        ));
    }
    validate_item_keys(table, &identity)?;
    Ok(identity)
}

fn item_to_document(item: HashMap<String, AttributeValue>, key_names: &[&str]) -> Result<Value, String> {
    let mut object = attribute_map_to_json(&item)?;
    let identity = key_names
        .iter()
        .map(|key| {
            let value = item.get(*key).ok_or_else(|| format!("DynamoDB item is missing key attribute: {key}"))?;
            Ok(((*key).to_string(), attribute_value_to_json(value)?))
        })
        .collect::<Result<Map<String, Value>, String>>()?;
    object.insert("_id".to_string(), Value::Object(identity));
    Ok(Value::Object(object))
}

fn attribute_map_to_json(values: &HashMap<String, AttributeValue>) -> Result<Map<String, Value>, String> {
    values.iter().map(|(key, value)| Ok((key.clone(), attribute_value_to_json(value)?))).collect()
}

fn attribute_value_to_json(value: &AttributeValue) -> Result<Value, String> {
    match value {
        AttributeValue::S(value) => Ok(Value::String(value.clone())),
        AttributeValue::N(value) => match serde_json::from_str::<serde_json::Number>(value) {
            Ok(number) if number.to_string() == *value && dynamodb_number_is_javascript_safe(&number) => {
                Ok(Value::Number(number))
            }
            _ => Ok(dynamodb_extended_json("number", Value::String(value.clone()))),
        },
        AttributeValue::B(value) => {
            Ok(dynamodb_extended_json("binary", Value::String(BASE64_STANDARD.encode(value.as_ref()))))
        }
        AttributeValue::Bool(value) => Ok(Value::Bool(*value)),
        AttributeValue::Null(_) => Ok(Value::Null),
        AttributeValue::L(values) => {
            values.iter().map(attribute_value_to_json).collect::<Result<Vec<_>, _>>().map(Value::Array)
        }
        AttributeValue::M(values) => {
            let object = attribute_map_to_json(values)?;
            if dynamodb_extended_json_parts(&object).is_some() {
                Ok(dynamodb_extended_json("map", Value::Object(object)))
            } else {
                Ok(Value::Object(object))
            }
        }
        AttributeValue::Ss(values) => {
            Ok(dynamodb_extended_json("stringSet", Value::Array(values.iter().cloned().map(Value::String).collect())))
        }
        AttributeValue::Ns(values) => {
            Ok(dynamodb_extended_json("numberSet", Value::Array(values.iter().cloned().map(Value::String).collect())))
        }
        AttributeValue::Bs(values) => Ok(dynamodb_extended_json(
            "binarySet",
            Value::Array(values.iter().map(|value| Value::String(BASE64_STANDARD.encode(value.as_ref()))).collect()),
        )),
        _ => Err("Unsupported DynamoDB attribute type returned by the SDK".to_string()),
    }
}

fn dynamodb_extended_json(attribute_type: &str, value: Value) -> Value {
    serde_json::json!({
        (DYNAMODB_JSON_TYPE_TAG): {
            "version": DYNAMODB_JSON_TYPE_VERSION,
            "type": attribute_type,
            "value": value,
        }
    })
}

fn dynamodb_extended_json_parts(object: &Map<String, Value>) -> Option<(&str, &Value)> {
    if object.len() != 1 {
        return None;
    }
    let tagged = object.get(DYNAMODB_JSON_TYPE_TAG)?.as_object()?;
    if tagged.len() != 3 || tagged.get("version").and_then(Value::as_u64) != Some(DYNAMODB_JSON_TYPE_VERSION) {
        return None;
    }
    Some((tagged.get("type")?.as_str()?, tagged.get("value")?))
}

fn dynamodb_number_is_javascript_safe(number: &serde_json::Number) -> bool {
    if let Some(value) = number.as_u64() {
        return value <= MAX_JAVASCRIPT_SAFE_INTEGER;
    }
    if let Some(value) = number.as_i64() {
        return value.unsigned_abs() <= MAX_JAVASCRIPT_SAFE_INTEGER;
    }
    let value = number.to_string();
    number.as_f64().is_some_and(f64::is_finite) && decimal_significant_digits(&value) <= 15
}

fn decimal_significant_digits(value: &str) -> usize {
    let mantissa = value.trim_start_matches(['+', '-']).split(['e', 'E']).next().unwrap_or(value);
    let digits = mantissa.chars().filter(|character| character.is_ascii_digit()).collect::<String>();
    let significant = digits.trim_start_matches('0').trim_end_matches('0').len();
    significant.max(1)
}

fn json_to_attribute_value(value: &Value) -> Result<AttributeValue, String> {
    match value {
        Value::Null => Ok(AttributeValue::Null(true)),
        Value::Bool(value) => Ok(AttributeValue::Bool(*value)),
        Value::Number(value) => Ok(AttributeValue::N(value.to_string())),
        Value::String(value) => Ok(AttributeValue::S(value.clone())),
        Value::Array(values) => {
            values.iter().map(json_to_attribute_value).collect::<Result<Vec<_>, _>>().map(AttributeValue::L)
        }
        Value::Object(object) => {
            if let Some((attribute_type, value)) = dynamodb_extended_json_parts(object) {
                if attribute_type == "number" {
                    let value =
                        value.as_str().ok_or_else(|| "DynamoDB number wrapper value must be a string".to_string())?;
                    validate_number(value)?;
                    return Ok(AttributeValue::N(value.to_string()));
                }
                if attribute_type == "binary" {
                    let value =
                        value.as_str().ok_or_else(|| "DynamoDB binary wrapper value must be a string".to_string())?;
                    return BASE64_STANDARD
                        .decode(value)
                        .map(|bytes| AttributeValue::B(Blob::new(bytes)))
                        .map_err(|error| format!("Invalid DynamoDB binary wrapper value: {error}"));
                }
                if attribute_type == "stringSet" {
                    let values = value
                        .as_array()
                        .ok_or_else(|| "DynamoDB stringSet wrapper value must be an array".to_string())?;
                    let values = values
                        .iter()
                        .map(|value| {
                            value
                                .as_str()
                                .map(str::to_string)
                                .ok_or_else(|| "DynamoDB stringSet values must be strings".to_string())
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    if values.is_empty() {
                        return Err("DynamoDB string sets cannot be empty".to_string());
                    }
                    return Ok(AttributeValue::Ss(values));
                }
                if attribute_type == "numberSet" {
                    let values = value
                        .as_array()
                        .ok_or_else(|| "DynamoDB numberSet wrapper value must be an array".to_string())?;
                    let values = values
                        .iter()
                        .map(|value| {
                            let value = value
                                .as_str()
                                .ok_or_else(|| "DynamoDB numberSet values must be strings".to_string())?;
                            validate_number(value)?;
                            Ok(value.to_string())
                        })
                        .collect::<Result<Vec<_>, String>>()?;
                    if values.is_empty() {
                        return Err("DynamoDB number sets cannot be empty".to_string());
                    }
                    return Ok(AttributeValue::Ns(values));
                }
                if attribute_type == "binarySet" {
                    let values = value
                        .as_array()
                        .ok_or_else(|| "DynamoDB binarySet wrapper value must be an array".to_string())?;
                    let values = values
                        .iter()
                        .map(|value| {
                            let value = value
                                .as_str()
                                .ok_or_else(|| "DynamoDB binarySet values must be strings".to_string())?;
                            BASE64_STANDARD
                                .decode(value)
                                .map(Blob::new)
                                .map_err(|error| format!("Invalid DynamoDB binarySet value: {error}"))
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    if values.is_empty() {
                        return Err("DynamoDB binary sets cannot be empty".to_string());
                    }
                    return Ok(AttributeValue::Bs(values));
                }
                if attribute_type == "map" {
                    let values =
                        value.as_object().ok_or_else(|| "DynamoDB map wrapper value must be an object".to_string())?;
                    return values
                        .iter()
                        .map(|(key, value)| Ok((key.clone(), json_to_attribute_value(value)?)))
                        .collect::<Result<HashMap<_, _>, String>>()
                        .map(AttributeValue::M);
                }
                return Err(format!("Unsupported DynamoDB JSON wrapper type: {attribute_type}"));
            }
            object
                .iter()
                .map(|(key, value)| Ok((key.clone(), json_to_attribute_value(value)?)))
                .collect::<Result<HashMap<_, _>, String>>()
                .map(AttributeValue::M)
        }
    }
}

fn validate_number(value: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    if bytes.is_empty() {
        return Err(format!("Invalid DynamoDB number: {value}"));
    }
    let mut index = usize::from(matches!(bytes[0], b'+' | b'-'));
    let mut digits = 0_usize;
    let mut significant_digits = 0_usize;
    let mut seen_non_zero = false;
    let mut seen_dot = false;
    while index < bytes.len() {
        match bytes[index] {
            b'0'..=b'9' => {
                digits += 1;
                if bytes[index] != b'0' || seen_non_zero {
                    seen_non_zero = true;
                    significant_digits += 1;
                }
                index += 1;
            }
            b'.' if !seen_dot => {
                seen_dot = true;
                index += 1;
            }
            b'e' | b'E' => break,
            _ => return Err(format!("Invalid DynamoDB number: {value}")),
        }
    }
    if digits == 0 || significant_digits > 38 {
        return Err(format!("Invalid DynamoDB number: {value}"));
    }
    if index < bytes.len() {
        index += 1;
        if index < bytes.len() && matches!(bytes[index], b'+' | b'-') {
            index += 1;
        }
        let exponent_start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if exponent_start == index || index != bytes.len() {
            return Err(format!("Invalid DynamoDB number: {value}"));
        }
    }
    Ok(())
}

fn encode_cursor(key: &HashMap<String, AttributeValue>) -> Result<String, String> {
    let json = attribute_map_to_tagged_json(key)?;
    serde_json::to_vec(&json)
        .map(|bytes| BASE64_STANDARD.encode(bytes))
        .map_err(|error| format!("Failed to encode DynamoDB cursor: {error}"))
}

fn decode_cursor(cursor: &str) -> Result<HashMap<String, AttributeValue>, String> {
    let bytes = BASE64_STANDARD.decode(cursor).map_err(|error| format!("Invalid DynamoDB cursor: {error}"))?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|error| format!("Invalid DynamoDB cursor: {error}"))?;
    tagged_json_to_attribute_map(&value)
}

fn attribute_map_to_tagged_json(values: &HashMap<String, AttributeValue>) -> Result<Value, String> {
    values
        .iter()
        .map(|(key, value)| Ok((key.clone(), attribute_value_to_tagged_json(value)?)))
        .collect::<Result<Map<_, _>, String>>()
        .map(Value::Object)
}

fn attribute_value_to_tagged_json(value: &AttributeValue) -> Result<Value, String> {
    match value {
        AttributeValue::S(value) => Ok(serde_json::json!({ "S": value })),
        AttributeValue::N(value) => Ok(serde_json::json!({ "N": value })),
        AttributeValue::B(value) => Ok(serde_json::json!({ "B": BASE64_STANDARD.encode(value.as_ref()) })),
        _ => Err("DynamoDB cursor keys must be scalar String, Number, or Binary values".to_string()),
    }
}

fn tagged_json_to_attribute_map(value: &Value) -> Result<HashMap<String, AttributeValue>, String> {
    let object = value.as_object().ok_or_else(|| "DynamoDB cursor must contain an object".to_string())?;
    object
        .iter()
        .map(|(key, value)| {
            let tagged = value.as_object().ok_or_else(|| "Invalid DynamoDB cursor key value".to_string())?;
            let attribute = if let Some(value) = tagged.get("S").and_then(Value::as_str) {
                AttributeValue::S(value.to_string())
            } else if let Some(value) = tagged.get("N").and_then(Value::as_str) {
                AttributeValue::N(value.to_string())
            } else if let Some(value) = tagged.get("B").and_then(Value::as_str) {
                AttributeValue::B(Blob::new(
                    BASE64_STANDARD
                        .decode(value)
                        .map_err(|error| format!("Invalid DynamoDB cursor binary: {error}"))?,
                ))
            } else {
                return Err("Invalid DynamoDB cursor key type".to_string());
            };
            Ok((key.clone(), attribute))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table_description() -> DynamoDbTableDescription {
        DynamoDbTableDescription {
            name: "orders".to_string(),
            status: "ACTIVE".to_string(),
            item_count: 0,
            size_bytes: 0,
            partition_key: DynamoDbKeyInfo { name: "tenant_id".to_string(), attribute_type: "S".to_string() },
            sort_key: Some(DynamoDbKeyInfo { name: "order_id".to_string(), attribute_type: "S".to_string() }),
            indexes: vec![DynamoDbIndexInfo {
                name: "by_status".to_string(),
                kind: "global".to_string(),
                partition_key: DynamoDbKeyInfo { name: "status".to_string(), attribute_type: "S".to_string() },
                sort_key: Some(DynamoDbKeyInfo { name: "created_at".to_string(), attribute_type: "N".to_string() }),
                projection_type: "ALL".to_string(),
                non_key_attributes: Vec::new(),
            }],
        }
    }

    #[test]
    fn parses_generated_scan_statement() {
        let statement = parse_dynamodb_statement(
            r#"DBX DYNAMODB QUERY / SCAN
table: "orders"
limit: 1000
filter:
{
  "$index": "by_status",
  "status": "SHIPPED"
}
sort:
{
  "created_at": -1
}"#,
        )
        .unwrap();

        assert_eq!(statement.operation, DynamoDbStatementOperation::Read);
        assert_eq!(statement.table, "orders");
        assert_eq!(statement.limit, Some(1000));
        assert_eq!(statement.filter, Some(serde_json::json!({ "$index": "by_status", "status": "SHIPPED" })));
        assert_eq!(statement.sort, Some(serde_json::json!({ "created_at": -1 })));
    }

    #[test]
    fn parses_generated_insert_statement_with_multiline_item() {
        let statement = parse_dynamodb_statement(
            r#"DBX DYNAMODB INSERT ITEM
table: "orders"
key:
{
  "tenant_id": "tenant-04",
  "order_id": "ORD-new"
}
item:
{
  "tenant_id": "tenant-04",
  "order_id": "ORD-new",
  "tags": {
    "$dbxDynamoDb": {
      "version": 1,
      "type": "stringSet",
      "value": [
        "retail"
      ]
    }
  }
}"#,
        )
        .unwrap();

        assert_eq!(statement.operation, DynamoDbStatementOperation::Insert);
        assert_eq!(statement.key, Some(serde_json::json!({ "tenant_id": "tenant-04", "order_id": "ORD-new" })));
        assert_eq!(
            statement.item,
            Some(serde_json::json!({
                "tenant_id": "tenant-04",
                "order_id": "ORD-new",
                "tags": {
                    "$dbxDynamoDb": {
                        "version": 1,
                        "type": "stringSet",
                        "value": ["retail"]
                    }
                }
            }))
        );
    }

    #[test]
    fn rejects_write_statement_without_explicit_key() {
        let error = parse_dynamodb_statement(
            r#"DBX DYNAMODB PUT ITEM
table: "orders"
item:
{
  "tenant_id": "tenant-04",
  "order_id": "ORD-new"
}"#,
        )
        .unwrap_err();

        assert!(error.contains("require key and item fields"));
    }

    #[tokio::test]
    #[ignore = "requires DBX_DYNAMODB_ENDPOINT and an orders table with tenant_id/order_id string keys"]
    async fn live_executes_generated_statements() {
        let endpoint = std::env::var("DBX_DYNAMODB_ENDPOINT").expect("DBX_DYNAMODB_ENDPOINT is required");
        let (ssl, address) = endpoint
            .strip_prefix("https://")
            .map(|address| (true, address))
            .or_else(|| endpoint.strip_prefix("http://").map(|address| (false, address)))
            .expect("DynamoDB endpoint must start with http:// or https://");
        let (host, port) = address.rsplit_once(':').expect("DynamoDB endpoint must include a port");
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "dynamodb-live-test",
            "name": "DynamoDB live test",
            "db_type": "dynamodb",
            "host": host,
            "port": port.parse::<u16>().expect("valid DynamoDB port"),
            "username": std::env::var("DBX_DYNAMODB_ACCESS_KEY_ID").unwrap_or_else(|_| "dummy".to_string()),
            "password": std::env::var("DBX_DYNAMODB_SECRET_ACCESS_KEY").unwrap_or_else(|_| "dummy".to_string()),
            "database": std::env::var("DBX_DYNAMODB_REGION").unwrap_or_else(|_| "us-east-1".to_string()),
            "ssl": ssl
        }))
        .unwrap();
        let client = connect(&config, host, config.port).unwrap();
        test_connection(&client, Duration::from_secs(5)).await.unwrap();

        let tenant_id = "codex-live";
        let order_id = format!("ORD-{}", uuid::Uuid::new_v4());
        let key = serde_json::json!({ "tenant_id": tenant_id, "order_id": order_id });
        let item = serde_json::json!({
            "tenant_id": tenant_id,
            "order_id": order_id,
            "status": "PENDING",
            "note": "generated statement live test"
        });
        let insert = format!(
            "DBX DYNAMODB INSERT ITEM\ntable: \"orders\"\nkey:\n{}\nitem:\n{}",
            serde_json::to_string_pretty(&key).unwrap(),
            serde_json::to_string_pretty(&item).unwrap()
        );
        assert_eq!(execute_statement(&client, &insert, 1000).await.unwrap().affected_rows, 1);

        let duplicate_error = execute_statement(&client, &insert, 1000).await.unwrap_err();
        assert!(duplicate_error.contains("already exists for key"), "{duplicate_error}");

        let query = format!(
            "DBX DYNAMODB QUERY / SCAN\ntable: \"orders\"\nlimit: 10\nfilter:\n{}",
            serde_json::to_string_pretty(&key).unwrap()
        );
        let result = execute_statement(&client, &query, 1000).await.unwrap();
        assert_eq!(result.rows.len(), 1);
        let note_column = result.columns.iter().position(|column| column == "note").unwrap();
        assert_eq!(result.rows[0][note_column], Value::String("generated statement live test".to_string()));

        let updated_item = serde_json::json!({
            "tenant_id": tenant_id,
            "order_id": order_id,
            "status": "SHIPPED",
            "note": "updated through PUT ITEM"
        });
        let put = format!(
            "DBX DYNAMODB PUT ITEM\ntable: \"orders\"\nkey:\n{}\nitem:\n{}",
            serde_json::to_string_pretty(&key).unwrap(),
            serde_json::to_string_pretty(&updated_item).unwrap()
        );
        assert_eq!(execute_statement(&client, &put, 1000).await.unwrap().affected_rows, 1);
        let updated = execute_statement(&client, &query, 1000).await.unwrap();
        let note_column = updated.columns.iter().position(|column| column == "note").unwrap();
        assert_eq!(updated.rows[0][note_column], Value::String("updated through PUT ITEM".to_string()));

        let rekey_order_id = format!("ORD-{}", uuid::Uuid::new_v4());
        let rekey_key = serde_json::json!({ "tenant_id": tenant_id, "order_id": rekey_order_id });
        let rekey_item = serde_json::json!({
            "tenant_id": tenant_id,
            "order_id": rekey_order_id,
            "status": "SHIPPED",
            "note": "atomically rekeyed"
        });
        let rekey_put = format!(
            "DBX DYNAMODB PUT ITEM\ntable: \"orders\"\nkey:\n{}\nitem:\n{}",
            serde_json::to_string_pretty(&key).unwrap(),
            serde_json::to_string_pretty(&rekey_item).unwrap()
        );
        assert_eq!(execute_statement(&client, &rekey_put, 1000).await.unwrap().affected_rows, 1);
        let rekey_query = format!(
            "DBX DYNAMODB QUERY / SCAN\ntable: \"orders\"\nlimit: 10\nfilter:\n{}",
            serde_json::to_string_pretty(&rekey_key).unwrap()
        );
        assert!(execute_statement(&client, &query, 1000).await.unwrap().rows.is_empty());
        assert_eq!(execute_statement(&client, &rekey_query, 1000).await.unwrap().rows.len(), 1);

        let retry_error = execute_statement(&client, &rekey_put, 1000).await.unwrap_err();
        assert!(retry_error.contains("target key") || retry_error.contains("atomically"), "{retry_error}");
        assert!(execute_statement(&client, &query, 1000).await.unwrap().rows.is_empty());
        assert_eq!(execute_statement(&client, &rekey_query, 1000).await.unwrap().rows.len(), 1);

        let conflict_order_id = format!("ORD-{}", uuid::Uuid::new_v4());
        let conflict_key = serde_json::json!({ "tenant_id": tenant_id, "order_id": conflict_order_id });
        let conflict_item = serde_json::json!({
            "tenant_id": tenant_id,
            "order_id": conflict_order_id,
            "note": "existing target"
        });
        let conflict_insert = format!(
            "DBX DYNAMODB INSERT ITEM\ntable: \"orders\"\nkey:\n{}\nitem:\n{}",
            serde_json::to_string_pretty(&conflict_key).unwrap(),
            serde_json::to_string_pretty(&conflict_item).unwrap()
        );
        assert_eq!(execute_statement(&client, &conflict_insert, 1000).await.unwrap().affected_rows, 1);
        let conflicting_rekey = format!(
            "DBX DYNAMODB PUT ITEM\ntable: \"orders\"\nkey:\n{}\nitem:\n{}",
            serde_json::to_string_pretty(&rekey_key).unwrap(),
            serde_json::to_string_pretty(&conflict_item).unwrap()
        );
        let conflict_error = execute_statement(&client, &conflicting_rekey, 1000).await.unwrap_err();
        assert!(conflict_error.contains("target key") || conflict_error.contains("atomically"), "{conflict_error}");
        assert_eq!(execute_statement(&client, &rekey_query, 1000).await.unwrap().rows.len(), 1);

        for cleanup_key in [&rekey_key, &conflict_key] {
            let delete = format!(
                "DBX DYNAMODB DELETE ITEM\ntable: \"orders\"\nkey:\n{}",
                serde_json::to_string_pretty(cleanup_key).unwrap()
            );
            assert_eq!(execute_statement(&client, &delete, 1000).await.unwrap().affected_rows, 1);
        }
    }

    #[tokio::test]
    #[ignore = "requires DBX_DYNAMODB_ENDPOINT and permission to create a temporary table"]
    async fn live_reports_partial_projection_metadata() {
        use aws_sdk_dynamodb::types::{
            AttributeDefinition, BillingMode, GlobalSecondaryIndex, Projection, ProjectionType, ScalarAttributeType,
        };

        let endpoint = std::env::var("DBX_DYNAMODB_ENDPOINT").expect("DBX_DYNAMODB_ENDPOINT is required");
        let (ssl, address) = endpoint
            .strip_prefix("https://")
            .map(|address| (true, address))
            .or_else(|| endpoint.strip_prefix("http://").map(|address| (false, address)))
            .expect("DynamoDB endpoint must start with http:// or https://");
        let (host, port) = address.rsplit_once(':').expect("DynamoDB endpoint must include a port");
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "dynamodb-live-projection-test",
            "name": "DynamoDB live projection test",
            "db_type": "dynamodb",
            "host": host,
            "port": port.parse::<u16>().expect("valid DynamoDB port"),
            "username": std::env::var("DBX_DYNAMODB_ACCESS_KEY_ID").unwrap_or_else(|_| "dummy".to_string()),
            "password": std::env::var("DBX_DYNAMODB_SECRET_ACCESS_KEY").unwrap_or_else(|_| "dummy".to_string()),
            "database": std::env::var("DBX_DYNAMODB_REGION").unwrap_or_else(|_| "us-east-1".to_string()),
            "ssl": ssl
        }))
        .unwrap();
        let client = connect(&config, host, config.port).unwrap();
        let table_name = format!("dbx_projection_{}", uuid::Uuid::new_v4().simple());
        let attribute = |name: &str| {
            AttributeDefinition::builder().attribute_name(name).attribute_type(ScalarAttributeType::S).build().unwrap()
        };
        let key = |name: &str, key_type: KeyType| {
            KeySchemaElement::builder().attribute_name(name).key_type(key_type).build().unwrap()
        };
        let index = |name: &str, projection: Projection| {
            GlobalSecondaryIndex::builder()
                .index_name(name)
                .key_schema(key("status", KeyType::Hash))
                .key_schema(key("created_at", KeyType::Range))
                .projection(projection)
                .build()
                .unwrap()
        };

        client
            .client
            .create_table()
            .table_name(&table_name)
            .billing_mode(BillingMode::PayPerRequest)
            .attribute_definitions(attribute("tenant_id"))
            .attribute_definitions(attribute("order_id"))
            .attribute_definitions(attribute("status"))
            .attribute_definitions(attribute("created_at"))
            .key_schema(key("tenant_id", KeyType::Hash))
            .key_schema(key("order_id", KeyType::Range))
            .global_secondary_indexes(index(
                "by_status_keys",
                Projection::builder().projection_type(ProjectionType::KeysOnly).build(),
            ))
            .global_secondary_indexes(index(
                "by_status_include",
                Projection::builder().projection_type(ProjectionType::Include).non_key_attributes("note").build(),
            ))
            .send()
            .await
            .unwrap();

        let metadata = describe_table(&client, &table_name).await.unwrap();
        let keys_only = metadata.indexes.iter().find(|index| index.name == "by_status_keys").unwrap();
        let include = metadata.indexes.iter().find(|index| index.name == "by_status_include").unwrap();
        let projection_metadata = (
            keys_only.projection_type.clone(),
            keys_only.non_key_attributes.clone(),
            include.projection_type.clone(),
            include.non_key_attributes.clone(),
        );

        client.client.delete_table().table_name(&table_name).send().await.unwrap();
        assert_eq!(
            projection_metadata,
            ("KEYS_ONLY".to_string(), Vec::new(), "INCLUDE".to_string(), vec!["note".to_string()])
        );
    }

    #[tokio::test]
    #[ignore = "requires DBX_DYNAMODB_ENDPOINT and permission to create a temporary table"]
    async fn live_queries_number_and_binary_keys_from_extended_json() {
        use aws_sdk_dynamodb::types::{AttributeDefinition, BillingMode, ScalarAttributeType};

        let endpoint = std::env::var("DBX_DYNAMODB_ENDPOINT").expect("DBX_DYNAMODB_ENDPOINT is required");
        let (ssl, address) = endpoint
            .strip_prefix("https://")
            .map(|address| (true, address))
            .or_else(|| endpoint.strip_prefix("http://").map(|address| (false, address)))
            .expect("DynamoDB endpoint must start with http:// or https://");
        let (host, port) = address.rsplit_once(':').expect("DynamoDB endpoint must include a port");
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "dynamodb-live-extended-key-test",
            "name": "DynamoDB live extended key test",
            "db_type": "dynamodb",
            "host": host,
            "port": port.parse::<u16>().expect("valid DynamoDB port"),
            "username": std::env::var("DBX_DYNAMODB_ACCESS_KEY_ID").unwrap_or_else(|_| "dummy".to_string()),
            "password": std::env::var("DBX_DYNAMODB_SECRET_ACCESS_KEY").unwrap_or_else(|_| "dummy".to_string()),
            "database": std::env::var("DBX_DYNAMODB_REGION").unwrap_or_else(|_| "us-east-1".to_string()),
            "ssl": ssl
        }))
        .unwrap();
        let client = connect(&config, host, config.port).unwrap();
        let table_name = format!("dbx_extended_keys_{}", uuid::Uuid::new_v4().simple());
        let attribute = |name: &str, attribute_type: ScalarAttributeType| {
            AttributeDefinition::builder().attribute_name(name).attribute_type(attribute_type).build().unwrap()
        };
        let key = |name: &str, key_type: KeyType| {
            KeySchemaElement::builder().attribute_name(name).key_type(key_type).build().unwrap()
        };

        client
            .client
            .create_table()
            .table_name(&table_name)
            .billing_mode(BillingMode::PayPerRequest)
            .attribute_definitions(attribute("tenant_id", ScalarAttributeType::N))
            .attribute_definitions(attribute("order_id", ScalarAttributeType::B))
            .key_schema(key("tenant_id", KeyType::Hash))
            .key_schema(key("order_id", KeyType::Range))
            .send()
            .await
            .unwrap();
        client
            .client
            .put_item()
            .table_name(&table_name)
            .item("tenant_id", AttributeValue::N("9007199254740993".to_string()))
            .item("order_id", AttributeValue::B(Blob::new([0_u8, 1, 255])))
            .item("payload", AttributeValue::N("9007199254740995".to_string()))
            .send()
            .await
            .unwrap();

        let filter = serde_json::json!({
            "tenant_id": dynamodb_extended_json("number", Value::String("9007199254740993".to_string())),
            "order_id": dynamodb_extended_json("binary", Value::String(BASE64_STANDARD.encode([0_u8, 1, 255])))
        });
        let result = find_items(&client, &table_name, 10, Some(&filter.to_string()), None, None).await;
        client.client.delete_table().table_name(&table_name).send().await.unwrap();

        let result = result.unwrap();
        assert_eq!(result.documents.len(), 1);
        assert_eq!(
            result.documents[0].get("payload"),
            Some(&dynamodb_extended_json("number", Value::String("9007199254740995".to_string())))
        );
    }

    #[test]
    fn preserves_dynamodb_specific_json_types() {
        let value = serde_json::json!({
            "tags": {
                "$dbxDynamoDb": { "version": 1, "type": "stringSet", "value": ["one", "two"] }
            },
            "payload": {
                "$dbxDynamoDb": { "version": 1, "type": "binary", "value": "aGVsbG8=" }
            },
            "large": {
                "$dbxDynamoDb": {
                    "version": 1,
                    "type": "number",
                    "value": "123456789012345678901234567890"
                }
            }
        });
        let attribute = json_to_attribute_value(&value).unwrap();
        let round_trip = attribute_value_to_json(&attribute).unwrap();
        assert_eq!(round_trip, value);
    }

    #[test]
    fn wraps_integers_that_javascript_cannot_represent_exactly() {
        let value = attribute_value_to_json(&AttributeValue::N("9007199254740993".to_string())).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "$dbxDynamoDb": { "version": 1, "type": "number", "value": "9007199254740993" }
            })
        );
        assert_eq!(json_to_attribute_value(&value).unwrap(), AttributeValue::N("9007199254740993".to_string()));
    }

    #[test]
    fn wraps_decimals_that_exceed_javascript_precision() {
        let precise = attribute_value_to_json(&AttributeValue::N("1.234567890123456789".to_string())).unwrap();
        assert_eq!(
            precise,
            serde_json::json!({
                "$dbxDynamoDb": {
                    "version": 1,
                    "type": "number",
                    "value": "1.234567890123456789"
                }
            })
        );

        let ordinary = attribute_value_to_json(&AttributeValue::N("1234.5678".to_string())).unwrap();
        assert_eq!(ordinary, serde_json::json!(1234.5678));
    }

    #[test]
    fn escapes_user_maps_that_match_the_reserved_type_envelope() {
        let colliding_map = AttributeValue::M(HashMap::from([(
            DYNAMODB_JSON_TYPE_TAG.to_string(),
            AttributeValue::M(HashMap::from([
                ("version".to_string(), AttributeValue::N("1".to_string())),
                ("type".to_string(), AttributeValue::S("number".to_string())),
                ("value".to_string(), AttributeValue::S("9007199254740993".to_string())),
            ])),
        )]));

        let encoded = attribute_value_to_json(&colliding_map).unwrap();
        assert_eq!(dynamodb_extended_json_parts(encoded.as_object().unwrap()).map(|(kind, _)| kind), Some("map"));
        assert_eq!(json_to_attribute_value(&encoded).unwrap(), colliding_map);

        let legacy_single_key_map = serde_json::json!({ "$number": "9007199254740993" });
        assert_eq!(
            json_to_attribute_value(&legacy_single_key_map).unwrap(),
            AttributeValue::M(HashMap::from([(
                "$number".to_string(),
                AttributeValue::S("9007199254740993".to_string())
            )]))
        );
    }

    #[test]
    fn exposes_secondary_index_projection_metadata() {
        let projection = aws_sdk_dynamodb::types::Projection::builder()
            .projection_type(aws_sdk_dynamodb::types::ProjectionType::Include)
            .non_key_attributes("note")
            .non_key_attributes("amount")
            .build();

        assert_eq!(
            index_projection(Some(&projection)),
            ("INCLUDE".to_string(), vec!["note".to_string(), "amount".to_string()])
        );
        assert_eq!(index_projection(None), ("UNKNOWN".to_string(), Vec::new()));
    }

    #[test]
    fn builds_query_from_partition_and_sort_key_filters() {
        let filter = serde_json::json!({
            "$index": "by_status",
            "$and": [
                { "status": "PAID" },
                { "created_at": { "$gte": 100 } },
                { "amount": { "$gt": 20 } }
            ]
        });
        let plan = build_read_plan(&table_description(), Some(&filter), Some(r#"{"created_at":-1}"#)).unwrap();
        assert_eq!(plan.index_name.as_deref(), Some("by_status"));
        assert_eq!(plan.key_condition.as_ref().unwrap().expression, "#kn0 = :kv0 AND #kn1 >= :kv1");
        assert!(plan.filter.as_ref().unwrap().expression.contains('>'));
        assert!(!plan.scan_index_forward);
    }

    #[test]
    fn preserves_extended_json_values_in_filters_and_key_conditions() {
        let number = dynamodb_extended_json("number", Value::String("9007199254740993".to_string()));
        let binary = dynamodb_extended_json("binary", Value::String(BASE64_STANDARD.encode([0_u8, 1, 255])));
        let filter = serde_json::json!({
            "tenant_id": number,
            "order_id": { "$eq": binary },
            "payload": {
                "$dbxDynamoDb": {
                    "version": 1,
                    "type": "number",
                    "value": "9007199254740995"
                }
            }
        });
        let table = DynamoDbTableDescription {
            name: "events".to_string(),
            status: "ACTIVE".to_string(),
            item_count: 0,
            size_bytes: 0,
            partition_key: DynamoDbKeyInfo { name: "tenant_id".to_string(), attribute_type: "N".to_string() },
            sort_key: Some(DynamoDbKeyInfo { name: "order_id".to_string(), attribute_type: "B".to_string() }),
            indexes: Vec::new(),
        };

        let plan = build_read_plan(&table, Some(&filter), None).unwrap();
        let key_condition = plan.key_condition.unwrap();
        assert_eq!(key_condition.expression, "#kn0 = :kv0 AND #kn1 = :kv1");
        assert_eq!(key_condition.values.get(":kv0"), Some(&AttributeValue::N("9007199254740993".to_string())));
        assert_eq!(key_condition.values.get(":kv1"), Some(&AttributeValue::B(Blob::new([0_u8, 1, 255]))));
        assert_eq!(plan.filter.unwrap().values.get(":fv0"), Some(&AttributeValue::N("9007199254740995".to_string())));
    }

    #[test]
    fn falls_back_to_scan_without_partition_key_equality() {
        let filter = serde_json::json!({ "amount": { "$gt": 20 } });
        let plan = build_read_plan(&table_description(), Some(&filter), None).unwrap();
        assert!(plan.key_condition.is_none());
        assert!(plan.filter.is_some());
    }

    #[test]
    fn filter_parentheses_are_only_added_for_precedence() {
        let filter = serde_json::json!({
            "$and": [
                { "status": "PAID" },
                { "$or": [{ "active": true }, { "amount": { "$gt": 100 } }] }
            ]
        });
        let compiled = ExpressionCompiler::new("f").compile(&filter).unwrap();
        assert_eq!(compiled.expression, "#fn0 = :fv0 AND (#fn1 = :fv1 OR #fn2 > :fv2)");

        let not_contains = ExpressionCompiler::new("f")
            .compile(&serde_json::json!({ "customer": { "$notContains": "Test" } }))
            .unwrap();
        assert_eq!(not_contains.expression, "NOT contains(#fn0, :fv0)");
    }

    #[test]
    fn cursor_round_trip_preserves_scalar_key_types() {
        let key = HashMap::from([
            ("tenant_id".to_string(), AttributeValue::S("tenant-01".to_string())),
            ("order_id".to_string(), AttributeValue::N("9007199254740993".to_string())),
        ]);
        let encoded = encode_cursor(&key).unwrap();
        assert_eq!(decode_cursor(&encoded).unwrap(), key);
    }
}
