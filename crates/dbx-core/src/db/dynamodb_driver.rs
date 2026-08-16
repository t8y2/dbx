use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use aws_sdk_dynamodb::config::{Credentials, Region};
use aws_sdk_dynamodb::error::ProvideErrorMetadata;
use aws_sdk_dynamodb::primitives::Blob;
use aws_sdk_dynamodb::types::{AttributeValue, KeySchemaElement, KeyType, Select};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde_json::{Map, Value};
use tokio::sync::RwLock;

use crate::db::document_result::DocumentQueryResult;
use crate::models::connection::ConnectionConfig;

const DEFAULT_REGION: &str = "us-east-1";
const MAX_PAGE_SIZE: i32 = 1000;
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

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
    pub ttl_attribute: Option<String>,
    pub ttl_status: Option<String>,
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
        let Some(operators) = condition.as_object().filter(|object| object.keys().any(|key| key.starts_with('$')))
        else {
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
        indexes.push(DynamoDbIndexInfo {
            name: index.index_name().unwrap_or_default().to_string(),
            kind: "global".to_string(),
            partition_key: index_partition,
            sort_key: index_sort,
        });
    }
    for index in table.local_secondary_indexes() {
        let (index_partition, index_sort) = key_info(index.key_schema(), &attribute_types)?;
        indexes.push(DynamoDbIndexInfo {
            name: index.index_name().unwrap_or_default().to_string(),
            kind: "local".to_string(),
            partition_key: index_partition,
            sort_key: index_sort,
        });
    }
    indexes.sort_by_key(|index| index.name.to_lowercase());

    let ttl = client.client.describe_time_to_live().table_name(table_name).send().await.ok();
    let ttl_description = ttl.as_ref().and_then(|output| output.time_to_live_description());
    let description = DynamoDbTableDescription {
        name: table.table_name().unwrap_or(table_name).to_string(),
        status: table.table_status().map(|status| status.as_str().to_string()).unwrap_or_default(),
        item_count: table.item_count().unwrap_or_default().max(0) as u64,
        size_bytes: table.table_size_bytes().unwrap_or_default().max(0) as u64,
        partition_key,
        sort_key,
        indexes,
        ttl_attribute: ttl_description.and_then(|ttl| ttl.attribute_name()).map(str::to_string),
        ttl_status: ttl_description.and_then(|ttl| ttl.time_to_live_status()).map(|status| status.as_str().to_string()),
    };
    client.table_cache.write().await.insert(table_name.to_string(), description.clone());
    Ok(description)
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
    if let Some(object) = value.as_object() {
        if object.keys().any(|key| key.starts_with('$')) {
            return (object.len() == 1).then(|| object.get("$eq")).flatten();
        }
    }
    Some(value)
}

fn is_sort_key_condition(term: &Value, field: &str) -> bool {
    let Some(value) = term.as_object().and_then(|object| object.get(field)) else {
        return false;
    };
    let Some(object) = value.as_object() else {
        return true;
    };
    !object.keys().any(|key| key.starts_with('$'))
        || (object.len() == 1
            && object.keys().all(|key| {
                matches!(key.as_str(), "$eq" | "$gt" | "$gte" | "$lt" | "$lte" | "$between" | "$beginsWith")
            }))
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
    let table = describe_table(client, table_name).await?;
    let mut item = json_document_to_item(doc_json)?;
    ensure_item_keys(&table, &mut item, None)?;
    client
        .client
        .put_item()
        .table_name(table_name)
        .set_item(Some(item.clone()))
        .condition_expression("attribute_not_exists(#pk)")
        .expression_attribute_names("#pk", &table.partition_key.name)
        .send()
        .await
        .map_err(|error| dynamodb_sdk_error!("Failed to put DynamoDB item", error))?;
    encode_identity(&table, &item)
}

pub async fn update_item(client: &DynamoDbClient, table_name: &str, id: &str, doc_json: &str) -> Result<u64, String> {
    let table = describe_table(client, table_name).await?;
    let key = decode_identity_for_table(&table, id)?;
    let mut item = json_document_to_item(doc_json)?;
    ensure_item_keys(&table, &mut item, Some(&key))?;
    client
        .client
        .put_item()
        .table_name(table_name)
        .set_item(Some(item))
        .condition_expression("attribute_exists(#pk)")
        .expression_attribute_names("#pk", &table.partition_key.name)
        .send()
        .await
        .map_err(|error| dynamodb_sdk_error!("Failed to replace DynamoDB item", error))?;
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

fn ensure_item_keys(
    table: &DynamoDbTableDescription,
    item: &mut HashMap<String, AttributeValue>,
    identity: Option<&HashMap<String, AttributeValue>>,
) -> Result<(), String> {
    for key in [Some(&table.partition_key), table.sort_key.as_ref()].into_iter().flatten() {
        if let Some(identity_value) = identity.and_then(|identity| identity.get(&key.name)) {
            if let Some(item_value) = item.get(&key.name) {
                if item_value != identity_value {
                    return Err(format!("DynamoDB key attribute {} does not match the item identity", key.name));
                }
            }
            item.insert(key.name.clone(), identity_value.clone());
        }
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
    let mut checked = identity.clone();
    ensure_item_keys(table, &mut checked, Some(&identity))?;
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
            _ => Ok(serde_json::json!({ "$number": value })),
        },
        AttributeValue::B(value) => Ok(serde_json::json!({ "$binary": BASE64_STANDARD.encode(value.as_ref()) })),
        AttributeValue::Bool(value) => Ok(Value::Bool(*value)),
        AttributeValue::Null(_) => Ok(Value::Null),
        AttributeValue::L(values) => {
            values.iter().map(attribute_value_to_json).collect::<Result<Vec<_>, _>>().map(Value::Array)
        }
        AttributeValue::M(values) => attribute_map_to_json(values).map(Value::Object),
        AttributeValue::Ss(values) => Ok(serde_json::json!({ "$stringSet": values })),
        AttributeValue::Ns(values) => Ok(serde_json::json!({ "$numberSet": values })),
        AttributeValue::Bs(values) => Ok(serde_json::json!({
            "$binarySet": values.iter().map(|value| BASE64_STANDARD.encode(value.as_ref())).collect::<Vec<_>>()
        })),
        _ => Err("Unsupported DynamoDB attribute type returned by the SDK".to_string()),
    }
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
            if object.len() == 1 {
                if let Some(value) = object.get("$number").and_then(Value::as_str) {
                    validate_number(value)?;
                    return Ok(AttributeValue::N(value.to_string()));
                }
                if let Some(value) = object.get("$binary").and_then(Value::as_str) {
                    return BASE64_STANDARD
                        .decode(value)
                        .map(|bytes| AttributeValue::B(Blob::new(bytes)))
                        .map_err(|error| format!("Invalid DynamoDB $binary value: {error}"));
                }
                if let Some(values) = object.get("$stringSet").and_then(Value::as_array) {
                    let values = values
                        .iter()
                        .map(|value| {
                            value
                                .as_str()
                                .map(str::to_string)
                                .ok_or_else(|| "$stringSet values must be strings".to_string())
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    if values.is_empty() {
                        return Err("DynamoDB string sets cannot be empty".to_string());
                    }
                    return Ok(AttributeValue::Ss(values));
                }
                if let Some(values) = object.get("$numberSet").and_then(Value::as_array) {
                    let values = values
                        .iter()
                        .map(|value| {
                            let value =
                                value.as_str().ok_or_else(|| "$numberSet values must be strings".to_string())?;
                            validate_number(value)?;
                            Ok(value.to_string())
                        })
                        .collect::<Result<Vec<_>, String>>()?;
                    if values.is_empty() {
                        return Err("DynamoDB number sets cannot be empty".to_string());
                    }
                    return Ok(AttributeValue::Ns(values));
                }
                if let Some(values) = object.get("$binarySet").and_then(Value::as_array) {
                    let values = values
                        .iter()
                        .map(|value| {
                            let value =
                                value.as_str().ok_or_else(|| "$binarySet values must be strings".to_string())?;
                            BASE64_STANDARD
                                .decode(value)
                                .map(Blob::new)
                                .map_err(|error| format!("Invalid DynamoDB $binarySet value: {error}"))
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    if values.is_empty() {
                        return Err("DynamoDB binary sets cannot be empty".to_string());
                    }
                    return Ok(AttributeValue::Bs(values));
                }
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
            }],
            ttl_attribute: None,
            ttl_status: None,
        }
    }

    #[test]
    fn preserves_dynamodb_specific_json_types() {
        let value = serde_json::json!({
            "tags": { "$stringSet": ["one", "two"] },
            "payload": { "$binary": "aGVsbG8=" },
            "large": { "$number": "123456789012345678901234567890" }
        });
        let attribute = json_to_attribute_value(&value).unwrap();
        let round_trip = attribute_value_to_json(&attribute).unwrap();
        assert_eq!(round_trip, value);
    }

    #[test]
    fn wraps_integers_that_javascript_cannot_represent_exactly() {
        let value = attribute_value_to_json(&AttributeValue::N("9007199254740993".to_string())).unwrap();
        assert_eq!(value, serde_json::json!({ "$number": "9007199254740993" }));
        assert_eq!(json_to_attribute_value(&value).unwrap(), AttributeValue::N("9007199254740993".to_string()));
    }

    #[test]
    fn wraps_decimals_that_exceed_javascript_precision() {
        let precise = attribute_value_to_json(&AttributeValue::N("1.234567890123456789".to_string())).unwrap();
        assert_eq!(precise, serde_json::json!({ "$number": "1.234567890123456789" }));

        let ordinary = attribute_value_to_json(&AttributeValue::N("1234.5678".to_string())).unwrap();
        assert_eq!(ordinary, serde_json::json!(1234.5678));
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
