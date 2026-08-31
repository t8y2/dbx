use crate::connection::{AppState, PoolKind};
use crate::db::agent_driver::mongo_document_id_params;
use crate::db::document_result::DocumentQueryResult;
use crate::db::{dynamodb_driver, easysearch_driver, elasticsearch_driver, mongo_driver, vector_driver};

pub use crate::db::vector_driver::CollectionInfo;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoGridFsFileInfo {
    pub id: String,
    pub filename: Option<String>,
    pub length: i64,
    pub chunk_size: i32,
    pub upload_date: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub md5: Option<String>,
    pub content_type: Option<String>,
    pub aliases: Option<Vec<String>>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoGridFsBucketInfo {
    pub name: String,
    pub file_count: u64,
    pub total_bytes: i64,
}

/// 侧边栏「查看索引 Mapping / 索引配置 / 索引统计」请求的只读元数据端点。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ElasticsearchIndexMetadataKind {
    Mapping,
    Settings,
    Stats,
}

fn cmp_names(left: &str, right: &str) -> std::cmp::Ordering {
    let left_lower = left.to_lowercase();
    let right_lower = right.to_lowercase();
    left_lower.cmp(&right_lower).then_with(|| left.cmp(right))
}

fn sort_names(mut names: Vec<String>) -> Vec<String> {
    names.sort_by(|left, right| cmp_names(left, right));
    names
}

async fn ensure_document_pool(state: &AppState, connection_id: &str) -> Result<(), String> {
    state.get_or_create_pool(connection_id, None).await.map(|_| ())
}

pub async fn list_databases_core(state: &AppState, connection_id: &str) -> Result<Vec<String>, String> {
    ensure_document_pool(state, connection_id).await?;
    let fallback_database = configured_mongo_database(state, connection_id).await;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => match mongo_driver::list_databases(client).await {
            Ok(databases) => Ok(sort_names(databases)),
            Err(error) if mongo_list_databases_unauthorized(&error) => {
                fallback_mongo_database(&error, fallback_database)
            }
            Err(error) => Err(error),
        },
        PoolKind::DynamoDb(client) => Ok(vec![client.region.clone()]),
        PoolKind::Elasticsearch(_) => Ok(vec!["default".to_string()]),
        PoolKind::Easysearch(_) => Ok(vec!["default".to_string()]),
        PoolKind::Meilisearch(_) => Ok(vec!["default".to_string()]),
        PoolKind::VectorDb(client) => vector_driver::list_databases(client).await,
        PoolKind::Agent(client) => {
            let mut client = client.lock().await;
            match client.mongo_list_databases::<Vec<serde_json::Value>>().await {
                Ok(result) => {
                    Ok(sort_names(result.iter().filter_map(|v| v.get("name")?.as_str().map(String::from)).collect()))
                }
                Err(error) if mongo_list_databases_unauthorized(&error) => {
                    fallback_mongo_database(&error, fallback_database)
                }
                Err(error) => Err(error),
            }
        }
        _ => Err("Not a MongoDB/Elasticsearch/vector connection".to_string()),
    }
}

async fn configured_mongo_database(state: &AppState, connection_id: &str) -> Option<String> {
    let configs = state.configs.read().await;
    configs.get(connection_id).and_then(|config| config.effective_database().map(str::to_string))
}

fn fallback_mongo_database(error: &str, fallback_database: Option<String>) -> Result<Vec<String>, String> {
    fallback_database.map(|database| vec![database]).ok_or_else(|| error.to_string())
}

fn mongo_list_databases_unauthorized(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("not authorized") && lower.contains("listdatabases")
}

fn mongo_collection_info(name: String, kind: mongo_driver::MongoCollectionKind) -> CollectionInfo {
    CollectionInfo { name: name.clone(), id: name, kind: Some(kind.as_str().to_string()), ..Default::default() }
}

fn sort_mongo_collection_specs(
    mut specs: Vec<mongo_driver::MongoCollectionSpec>,
) -> Vec<mongo_driver::MongoCollectionSpec> {
    specs.sort_by(|left, right| cmp_names(&left.name, &right.name));
    specs
}

/// Decode both generations of the Legacy Agent response. Existing installed
/// Agents return names, while current Agents opt into `name` + `kind` specs.
fn mongo_collection_specs_from_agent_response(
    value: serde_json::Value,
) -> Result<Vec<mongo_driver::MongoCollectionSpec>, String> {
    let values =
        value.as_array().ok_or_else(|| "Invalid MongoDB legacy collection list: expected an array".to_string())?;

    values
        .iter()
        .map(|value| match value {
            serde_json::Value::String(name) => Ok(mongo_driver::MongoCollectionSpec {
                name: name.clone(),
                kind: mongo_driver::MongoCollectionKind::Collection,
            }),
            serde_json::Value::Object(spec) => {
                let name = spec
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| "Invalid MongoDB legacy collection spec: name is required".to_string())?;
                let kind = spec.get("kind").or_else(|| spec.get("type")).and_then(serde_json::Value::as_str);
                Ok(mongo_driver::MongoCollectionSpec {
                    name: name.to_string(),
                    kind: mongo_driver::MongoCollectionKind::from_metadata_kind(kind),
                })
            }
            _ => Err("Invalid MongoDB legacy collection list entry".to_string()),
        })
        .collect()
}

pub(crate) fn mongo_gridfs_bucket_names(names: &[String]) -> Vec<String> {
    use std::collections::BTreeSet;

    let name_set: BTreeSet<&str> = names.iter().map(String::as_str).collect();
    let bucket_names: Vec<String> = names
        .iter()
        .filter_map(|name| name.strip_suffix(".files"))
        .filter(|prefix| name_set.contains(format!("{prefix}.chunks").as_str()))
        .map(str::to_string)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();

    sort_names(bucket_names)
}

fn mongo_bucket_infos(names: &[String]) -> Vec<CollectionInfo> {
    mongo_gridfs_bucket_names(names)
        .into_iter()
        .map(|bucket_name| CollectionInfo {
            name: bucket_name.clone(),
            id: format!("bucket:{bucket_name}"),
            kind: Some("bucket".to_string()),
            bucket_name: Some(bucket_name),
            ..Default::default()
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GridFsBucketSortField {
    Name,
    FileCount,
    TotalBytes,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct GridFsBucketSort {
    field: GridFsBucketSortField,
    descending: bool,
}

fn parse_gridfs_bucket_sort(sort: Option<&str>) -> Result<GridFsBucketSort, String> {
    let Some(raw) = sort.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(GridFsBucketSort { field: GridFsBucketSortField::Name, descending: false });
    };

    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("Invalid GridFS bucket sort JSON: {e}"))?;
    let object = value.as_object().ok_or_else(|| "GridFS bucket sort must be a JSON object".to_string())?;
    if object.len() != 1 {
        return Err("GridFS bucket sort must contain exactly one field".to_string());
    }

    let (field_name, direction) = object.iter().next().expect("checked len");
    let field = match field_name.as_str() {
        "name" => GridFsBucketSortField::Name,
        "fileCount" => GridFsBucketSortField::FileCount,
        "totalBytes" => GridFsBucketSortField::TotalBytes,
        _ => return Err(format!("Unsupported GridFS bucket sort field: {field_name}")),
    };
    let descending = match direction {
        serde_json::Value::Number(value) if value.as_i64() == Some(-1) => true,
        serde_json::Value::Number(value) if value.as_i64() == Some(1) => false,
        serde_json::Value::String(value) if value.eq_ignore_ascii_case("desc") || value == "-1" => true,
        serde_json::Value::String(value) if value.eq_ignore_ascii_case("asc") || value == "1" => false,
        _ => return Err("GridFS bucket sort direction must be 1, -1, 'asc', or 'desc'".to_string()),
    };

    Ok(GridFsBucketSort { field, descending })
}

fn filter_and_sort_gridfs_bucket_infos(
    mut buckets: Vec<MongoGridFsBucketInfo>,
    filter: Option<&str>,
    sort: Option<&str>,
) -> Result<Vec<MongoGridFsBucketInfo>, String> {
    if let Some(filter_text) = filter.map(str::trim).filter(|value| !value.is_empty()) {
        let needle = filter_text.to_lowercase();
        buckets.retain(|bucket| bucket.name.to_lowercase().contains(&needle));
    }

    let sort = parse_gridfs_bucket_sort(sort)?;
    buckets.sort_by(|left, right| {
        let name_cmp =
            left.name.to_lowercase().cmp(&right.name.to_lowercase()).then_with(|| left.name.cmp(&right.name));
        let ordering = match sort.field {
            GridFsBucketSortField::Name => name_cmp,
            GridFsBucketSortField::FileCount => left.file_count.cmp(&right.file_count).then_with(|| name_cmp),
            GridFsBucketSortField::TotalBytes => left.total_bytes.cmp(&right.total_bytes).then_with(|| name_cmp),
        };
        if sort.descending {
            ordering.reverse()
        } else {
            ordering
        }
    });

    Ok(buckets)
}

pub async fn list_collections_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
) -> Result<Vec<CollectionInfo>, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => {
            let specs = sort_mongo_collection_specs(mongo_driver::list_collection_specs(client, database).await?);
            let names: Vec<String> = specs.iter().map(|spec| spec.name.clone()).collect();
            let mut infos = mongo_bucket_infos(&names);
            infos.extend(specs.into_iter().map(|spec| mongo_collection_info(spec.name, spec.kind)));
            Ok(infos)
        }
        PoolKind::DynamoDb(client) => {
            let client = client.clone();
            drop(connections);
            let names = dynamodb_driver::list_tables(&client).await?;
            Ok(names
                .into_iter()
                .map(|name| CollectionInfo {
                    id: name.clone(),
                    name,
                    kind: Some("table".to_string()),
                    ..Default::default()
                })
                .collect())
        }
        PoolKind::Elasticsearch(client) => {
            let names = sort_names(elasticsearch_driver::list_indices(client).await?);
            Ok(names.into_iter().map(|n| CollectionInfo { name: n.clone(), id: n, ..Default::default() }).collect())
        }
        PoolKind::Easysearch(client) => {
            let names = sort_names(easysearch_driver::list_indices(client).await?);
            Ok(names.into_iter().map(|n| CollectionInfo { name: n.clone(), id: n, ..Default::default() }).collect())
        }
        PoolKind::Meilisearch(client) => {
            let names = sort_names(crate::db::meilisearch_driver::list_indexes(client).await?);
            Ok(names.into_iter().map(|n| CollectionInfo { name: n.clone(), id: n, ..Default::default() }).collect())
        }
        PoolKind::VectorDb(client) => vector_driver::list_collections_with_db(client, database).await,
        PoolKind::Agent(client) => {
            let mut client = client.lock().await;
            let specs = sort_mongo_collection_specs(mongo_collection_specs_from_agent_response(
                client.mongo_list_collection_specs(database).await?,
            )?);
            let names: Vec<String> = specs.iter().map(|spec| spec.name.clone()).collect();
            let mut infos = mongo_bucket_infos(&names);
            infos.extend(specs.into_iter().map(|spec| mongo_collection_info(spec.name, spec.kind)));
            Ok(infos)
        }
        _ => Err("Not a MongoDB/Elasticsearch/vector connection".to_string()),
    }
}

pub async fn list_gridfs_files_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    bucket: &str,
    filter: Option<&str>,
    sort: Option<&str>,
) -> Result<Vec<MongoGridFsFileInfo>, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => mongo_driver::list_gridfs_files(client, database, bucket, filter, sort).await,
        PoolKind::Agent(_) => Err("MongoDB legacy agent does not support GridFS file browsing".to_string()),
        _ => Err("Not a MongoDB connection".to_string()),
    }
}

pub async fn list_gridfs_buckets_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    filter: Option<&str>,
    sort: Option<&str>,
) -> Result<Vec<MongoGridFsBucketInfo>, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => {
            let names = sort_names(mongo_driver::list_collections(client, database).await?);
            let bucket_names = mongo_gridfs_bucket_names(&names);
            let mut buckets = Vec::with_capacity(bucket_names.len());
            for bucket_name in bucket_names {
                buckets.push(mongo_driver::gridfs_bucket_summary(client, database, &bucket_name).await?);
            }
            filter_and_sort_gridfs_bucket_infos(buckets, filter, sort)
        }
        PoolKind::Agent(_) => Err("MongoDB legacy agent does not support GridFS bucket browsing".to_string()),
        _ => Err("Not a MongoDB connection".to_string()),
    }
}

pub async fn create_gridfs_bucket_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    bucket: &str,
) -> Result<(), String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => mongo_driver::create_gridfs_bucket(client, database, bucket).await,
        PoolKind::Agent(_) => Err("MongoDB legacy agent does not support GridFS bucket creation".to_string()),
        _ => Err("Not a MongoDB connection".to_string()),
    }
}

pub async fn delete_gridfs_bucket_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    bucket: &str,
) -> Result<(), String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => mongo_driver::delete_gridfs_bucket(client, database, bucket).await,
        PoolKind::Agent(_) => Err("MongoDB legacy agent does not support GridFS bucket deletion".to_string()),
        _ => Err("Not a MongoDB connection".to_string()),
    }
}

pub async fn download_gridfs_file_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    bucket: &str,
    file_id: &str,
) -> Result<Vec<u8>, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => mongo_driver::download_gridfs_file(client, database, bucket, file_id).await,
        PoolKind::Agent(_) => Err("MongoDB legacy agent does not support GridFS download".to_string()),
        _ => Err("Not a MongoDB connection".to_string()),
    }
}

pub async fn upload_gridfs_file_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    bucket: &str,
    file_name: &str,
    data: &[u8],
    content_type: Option<&str>,
) -> Result<String, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => {
            mongo_driver::upload_gridfs_file(client, database, bucket, file_name, data, content_type).await
        }
        PoolKind::Agent(_) => Err("MongoDB legacy agent does not support GridFS uploads".to_string()),
        _ => Err("Not a MongoDB connection".to_string()),
    }
}

pub async fn delete_gridfs_file_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    bucket: &str,
    file_id: &str,
) -> Result<(), String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => mongo_driver::delete_gridfs_file(client, database, bucket, file_id).await,
        PoolKind::Agent(_) => Err("MongoDB legacy agent does not support GridFS file deletion".to_string()),
        _ => Err("Not a MongoDB connection".to_string()),
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn find_documents_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    skip: u64,
    limit: i64,
    filter: Option<&str>,
    projection: Option<&str>,
    sort: Option<&str>,
    collation: Option<&str>,
    cursor: Option<&str>,
    cursor_pagination: bool,
) -> Result<DocumentQueryResult, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => {
            // Document browser responses must retain BSON type metadata so nested filters
            // can round-trip ObjectId, Date, and int64 values through Extended JSON.
            mongo_driver::find_documents_extended_json(
                client, database, collection, skip, limit, filter, projection, sort, collation,
            )
            .await
        }
        PoolKind::DynamoDb(client) => {
            let client = client.clone();
            drop(connections);
            let _ = (database, skip, projection, collation);
            dynamodb_driver::find_items(&client, collection, limit, filter, sort, cursor).await
        }
        PoolKind::Elasticsearch(client) => {
            let client = client.clone();
            drop(connections);
            if cursor_pagination {
                elasticsearch_driver::find_documents_with_cursor(&client, collection, limit, filter, sort, cursor).await
            } else {
                elasticsearch_driver::find_documents(&client, collection, skip, limit, filter, sort).await
            }
        }
        PoolKind::Easysearch(client) => {
            let client = client.clone();
            drop(connections);
            if cursor_pagination {
                easysearch_driver::find_documents_with_cursor(&client, collection, limit, filter, sort, cursor).await
            } else {
                easysearch_driver::find_documents(&client, collection, skip, limit, filter, sort).await
            }
        }
        PoolKind::Meilisearch(client) => {
            let client = client.clone();
            drop(connections);
            crate::db::meilisearch_driver::find_documents(&client, collection, skip, limit, filter, sort).await
        }
        PoolKind::VectorDb(client) => {
            let client = client.clone();
            drop(connections);
            let _ = (filter, sort);
            vector_driver::find_documents(&client, database, collection, skip, limit).await
        }
        PoolKind::Agent(client) => {
            let mut client = client.lock().await;
            let mut params = serde_json::json!({
                "database": database,
                "collection": collection,
                "skip": skip,
                "limit": limit,
                "filter": filter,
                "sort": sort,
            });
            if let Some(projection) = projection {
                params["projection"] = serde_json::json!(projection);
            }
            if let Some(collation) = collation {
                params["collation"] = serde_json::json!(collation);
            }
            match client.mongo_find_documents_extended_json(params.clone()).await {
                Ok(result) => Ok(result),
                Err(error) if is_unknown_agent_method_error(&error, "find_documents_extended_json") => {
                    client.mongo_find_documents(params).await
                }
                Err(error) => Err(error),
            }
        }
        _ => Err("Not a MongoDB/Elasticsearch/vector connection".to_string()),
    }
}

pub async fn count_document_store_documents_core(
    state: &AppState,
    connection_id: &str,
    collection: &str,
    filter: Option<&str>,
) -> Result<u64, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::DynamoDb(client) => {
            let client = client.clone();
            drop(connections);
            dynamodb_driver::count_items(&client, collection, filter).await
        }
        PoolKind::Elasticsearch(client) => {
            let client = client.clone();
            drop(connections);
            elasticsearch_driver::count_documents(&client, collection, filter).await
        }
        PoolKind::Easysearch(client) => {
            let client = client.clone();
            drop(connections);
            easysearch_driver::count_documents(&client, collection, filter).await
        }
        _ => Err("Document count is not supported for this connection".to_string()),
    }
}

pub async fn describe_dynamodb_table_core(
    state: &AppState,
    connection_id: &str,
    table: &str,
) -> Result<dynamodb_driver::DynamoDbTableDescription, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::DynamoDb(client) => {
            let client = client.clone();
            drop(connections);
            dynamodb_driver::describe_table(&client, table).await
        }
        _ => Err("Not a DynamoDB connection".to_string()),
    }
}

pub async fn count_elasticsearch_documents_core(
    state: &AppState,
    connection_id: &str,
    index: &str,
    filter: Option<&str>,
) -> Result<u64, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Elasticsearch(client) => {
            let client = client.clone();
            drop(connections);
            elasticsearch_driver::count_documents(&client, index, filter).await
        }
        PoolKind::Easysearch(client) => {
            let client = client.clone();
            drop(connections);
            easysearch_driver::count_documents(&client, index, filter).await
        }
        _ => Err("Not an Elasticsearch connection".to_string()),
    }
}

/// Elasticsearch/Easysearch 索引的只读元数据端点。`kind` 选择 `_mapping`
/// （字段映射）、`_settings`（索引配置）或 `_stats`（索引统计）。
pub async fn elasticsearch_get_index_metadata_core(
    state: &AppState,
    connection_id: &str,
    index: &str,
    kind: ElasticsearchIndexMetadataKind,
) -> Result<serde_json::Value, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Elasticsearch(client) => {
            let client = client.clone();
            drop(connections);
            match kind {
                ElasticsearchIndexMetadataKind::Mapping => {
                    elasticsearch_driver::get_index_mapping(&client, index).await
                }
                ElasticsearchIndexMetadataKind::Settings => {
                    elasticsearch_driver::get_index_settings(&client, index).await
                }
                ElasticsearchIndexMetadataKind::Stats => elasticsearch_driver::get_index_stats(&client, index).await,
            }
        }
        PoolKind::Easysearch(client) => {
            let client = client.clone();
            drop(connections);
            match kind {
                ElasticsearchIndexMetadataKind::Mapping => easysearch_driver::get_index_mapping(&client, index).await,
                ElasticsearchIndexMetadataKind::Settings => easysearch_driver::get_index_settings(&client, index).await,
                ElasticsearchIndexMetadataKind::Stats => easysearch_driver::get_index_stats(&client, index).await,
            }
        }
        _ => Err("Not an Elasticsearch connection".to_string()),
    }
}

/// 清空索引数据：删除全部文档，保留 mapping、settings 与别名。
pub async fn elasticsearch_delete_all_documents_core(
    state: &AppState,
    connection_id: &str,
    index: &str,
) -> Result<elasticsearch_driver::ElasticsearchDeleteByQueryResult, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Elasticsearch(client) => {
            let client = client.clone();
            drop(connections);
            elasticsearch_driver::delete_all_documents(&client, index).await
        }
        PoolKind::Easysearch(client) => {
            let client = client.clone();
            drop(connections);
            easysearch_driver::delete_all_documents(&client, index).await
        }
        _ => Err("Not an Elasticsearch connection".to_string()),
    }
}

fn is_unknown_agent_method_error(error: &str, method: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains(method) && (lower.contains("unknown method") || lower.contains("method not found"))
}

pub async fn insert_document_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    doc_json: &str,
    routing: Option<&str>,
) -> Result<String, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => mongo_driver::insert_document(client, database, collection, doc_json).await,
        PoolKind::DynamoDb(client) => {
            let client = client.clone();
            drop(connections);
            dynamodb_driver::insert_item(&client, collection, doc_json).await
        }
        PoolKind::Elasticsearch(client) => {
            let client = client.clone();
            drop(connections);
            elasticsearch_driver::insert_document(&client, collection, doc_json, routing).await
        }
        PoolKind::Easysearch(client) => {
            let client = client.clone();
            drop(connections);
            easysearch_driver::insert_document(&client, collection, doc_json, routing).await
        }
        PoolKind::Meilisearch(client) => {
            let client = client.clone();
            drop(connections);
            crate::db::meilisearch_driver::insert_document(&client, collection, doc_json).await
        }
        PoolKind::Agent(client) => {
            let mut client = client.lock().await;
            let result: serde_json::Value = client
                .mongo_insert_document(serde_json::json!({
                    "database": database,
                    "collection": collection,
                    "doc_json": doc_json,
                }))
                .await?;
            Ok(result.get("inserted_id").and_then(|v| v.as_str()).unwrap_or("").to_string())
        }
        _ => Err("Not a MongoDB/Elasticsearch connection".to_string()),
    }
}

pub async fn insert_document_preserving_bson_types_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    doc_json: &str,
    routing: Option<&str>,
) -> Result<String, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => {
            mongo_driver::insert_document_extended_json(client, database, collection, doc_json).await
        }
        _ => {
            drop(connections);
            insert_document_core(state, connection_id, database, collection, doc_json, routing).await
        }
    }
}

pub async fn update_document_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    id: &str,
    doc_json: &str,
    routing: Option<&str>,
) -> Result<u64, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => mongo_driver::update_document(client, database, collection, id, doc_json).await,
        PoolKind::DynamoDb(client) => {
            let client = client.clone();
            drop(connections);
            dynamodb_driver::update_item(&client, collection, id, doc_json).await
        }
        PoolKind::Elasticsearch(client) => {
            let client = client.clone();
            drop(connections);
            // Elasticsearch requires the same custom routing value for writes
            // as was used to index the document.
            elasticsearch_driver::update_document(&client, collection, id, doc_json, routing).await
        }
        PoolKind::Easysearch(client) => {
            let client = client.clone();
            drop(connections);
            easysearch_driver::update_document(&client, collection, id, doc_json, routing).await
        }
        PoolKind::Meilisearch(client) => {
            let client = client.clone();
            drop(connections);
            crate::db::meilisearch_driver::update_document(&client, collection, id, doc_json).await
        }
        PoolKind::Agent(client) => {
            let mut client = client.lock().await;
            let result: serde_json::Value = client
                .mongo_update_document(serde_json::json!({
                    "database": database,
                    "collection": collection,
                    "id": id,
                    "doc_json": doc_json,
                }))
                .await?;
            Ok(result.get("modified_count").and_then(|v| v.as_u64()).unwrap_or(0))
        }
        _ => Err("Not a MongoDB/Elasticsearch connection".to_string()),
    }
}

pub async fn delete_document_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    id: &str,
    routing: Option<&str>,
) -> Result<u64, String> {
    delete_document_core_with_type(state, connection_id, database, collection, id, routing, None).await
}

pub async fn delete_document_core_with_type(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    id: &str,
    routing: Option<&str>,
    document_type: Option<&str>,
) -> Result<u64, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => mongo_driver::delete_document(client, database, collection, id).await,
        PoolKind::DynamoDb(client) => {
            let client = client.clone();
            drop(connections);
            dynamodb_driver::delete_item(&client, collection, id).await
        }
        PoolKind::Elasticsearch(client) => {
            let client = client.clone();
            drop(connections);
            // Elasticsearch requires the same custom routing value for writes
            // as was used to index the document.
            elasticsearch_driver::delete_document(&client, collection, id, document_type, routing).await
        }
        PoolKind::Easysearch(client) => {
            let client = client.clone();
            drop(connections);
            easysearch_driver::delete_document(&client, collection, id, document_type, routing).await
        }
        PoolKind::Meilisearch(client) => {
            let client = client.clone();
            drop(connections);
            crate::db::meilisearch_driver::delete_document(&client, collection, id).await
        }
        PoolKind::Agent(client) => {
            let mut client = client.lock().await;
            let result: serde_json::Value =
                client.mongo_delete_document(mongo_document_id_params(database, collection, id)).await?;
            Ok(result.get("deleted_count").and_then(|v| v.as_u64()).unwrap_or(0))
        }
        _ => Err("Not a MongoDB/Elasticsearch connection".to_string()),
    }
}

pub async fn save_meilisearch_document_batch_core(
    state: &AppState,
    connection_id: &str,
    collection: &str,
    updates: &[crate::db::meilisearch_driver::MeilisearchDocumentUpdate],
    delete_ids: &[String],
    inserts: &[String],
) -> Result<u64, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Meilisearch(client) => {
            let client = client.clone();
            drop(connections);
            crate::db::meilisearch_driver::save_document_batch(&client, collection, updates, delete_ids, inserts).await
        }
        _ => Err("Not a Meilisearch connection".to_string()),
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn meilisearch_search_documents_core(
    state: &AppState,
    connection_id: &str,
    index: &str,
    q: Option<&str>,
    filter: Option<&str>,
    sort: Option<&str>,
    limit: u64,
    offset: u64,
    hybrid_embedder: Option<&str>,
    hybrid_semantic_ratio: Option<f64>,
    show_ranking_score: bool,
    ranking_score_threshold: Option<f64>,
) -> Result<crate::db::meilisearch_driver::MeilisearchSearchResult, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Meilisearch(client) => {
            let client = client.clone();
            drop(connections);
            let hybrid = hybrid_embedder.map(|embedder| crate::db::meilisearch_driver::MeilisearchHybrid {
                embedder: embedder.to_string(),
                semantic_ratio: hybrid_semantic_ratio.unwrap_or(0.5),
            });
            crate::db::meilisearch_driver::search_documents(
                &client,
                index,
                q,
                filter,
                sort,
                limit,
                offset,
                hybrid.as_ref(),
                show_ranking_score,
                ranking_score_threshold,
            )
            .await
        }
        _ => Err("Not a Meilisearch connection".to_string()),
    }
}

pub async fn meilisearch_fetch_document_page_core(
    state: &AppState,
    connection_id: &str,
    index: &str,
    filter: Option<&str>,
    sort: Option<&str>,
    limit: u64,
    offset: u64,
) -> Result<crate::db::meilisearch_driver::MeilisearchDocumentPage, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Meilisearch(client) => {
            let client = client.clone();
            drop(connections);
            crate::db::meilisearch_driver::fetch_document_page(&client, index, offset, limit, filter, sort).await
        }
        _ => Err("Not a Meilisearch connection".to_string()),
    }
}

pub async fn meilisearch_get_index_settings_core(
    state: &AppState,
    connection_id: &str,
    index: &str,
) -> Result<serde_json::Value, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Meilisearch(client) => {
            let client = client.clone();
            drop(connections);
            crate::db::meilisearch_driver::get_index_settings(&client, index).await
        }
        _ => Err("Not a Meilisearch connection".to_string()),
    }
}

pub async fn meilisearch_get_document_core(
    state: &AppState,
    connection_id: &str,
    index: &str,
    id: &str,
) -> Result<String, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Meilisearch(client) => {
            let client = client.clone();
            drop(connections);
            crate::db::meilisearch_driver::get_document(&client, index, id).await
        }
        _ => Err("Not a Meilisearch connection".to_string()),
    }
}

pub async fn meilisearch_update_index_settings_core(
    state: &AppState,
    connection_id: &str,
    index: &str,
    settings: &serde_json::Value,
) -> Result<(), String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Meilisearch(client) => {
            let client = client.clone();
            drop(connections);
            crate::db::meilisearch_driver::update_index_settings(&client, index, settings).await
        }
        _ => Err("Not a Meilisearch connection".to_string()),
    }
}

pub async fn meilisearch_get_index_stats_core(
    state: &AppState,
    connection_id: &str,
    index: &str,
) -> Result<serde_json::Value, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Meilisearch(client) => {
            let client = client.clone();
            drop(connections);
            crate::db::meilisearch_driver::get_index_stats(&client, index).await
        }
        _ => Err("Not a Meilisearch connection".to_string()),
    }
}

pub async fn meilisearch_get_index_overview_core(
    state: &AppState,
    connection_id: &str,
    index: &str,
) -> Result<crate::db::meilisearch_driver::MeilisearchIndexOverview, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Meilisearch(client) => {
            let client = client.clone();
            drop(connections);
            crate::db::meilisearch_driver::get_index_overview(&client, index).await
        }
        _ => Err("Not a Meilisearch connection".to_string()),
    }
}

pub async fn meilisearch_delete_index_core(state: &AppState, connection_id: &str, index: &str) -> Result<(), String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Meilisearch(client) => {
            let client = client.clone();
            drop(connections);
            crate::db::meilisearch_driver::delete_index(&client, index).await
        }
        _ => Err("Not a Meilisearch connection".to_string()),
    }
}

pub async fn meilisearch_delete_all_documents_core(
    state: &AppState,
    connection_id: &str,
    index: &str,
) -> Result<(), String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Meilisearch(client) => {
            let client = client.clone();
            drop(connections);
            crate::db::meilisearch_driver::delete_all_documents(&client, index).await
        }
        _ => Err("Not a Meilisearch connection".to_string()),
    }
}

async fn meilisearch_client_core(
    state: &AppState,
    connection_id: &str,
) -> Result<crate::db::meilisearch_driver::MeilisearchClient, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::Meilisearch(client) => Ok(client.clone()),
        _ => Err("Not a Meilisearch connection".to_string()),
    }
}

pub async fn meilisearch_get_system_overview_core(
    state: &AppState,
    connection_id: &str,
) -> Result<crate::db::meilisearch_driver::MeilisearchSystemOverview, String> {
    let client = meilisearch_client_core(state, connection_id).await?;
    Ok(crate::db::meilisearch_driver::get_system_overview(&client).await)
}

pub async fn meilisearch_list_keys_core(
    state: &AppState,
    connection_id: &str,
    offset: u64,
    limit: u64,
) -> Result<crate::db::meilisearch_driver::MeilisearchKeyPage, String> {
    let client = meilisearch_client_core(state, connection_id).await?;
    crate::db::meilisearch_driver::list_keys(&client, offset, limit).await
}

pub async fn meilisearch_get_key_core(
    state: &AppState,
    connection_id: &str,
    uid: &str,
) -> Result<crate::db::meilisearch_driver::MeilisearchKeyListItem, String> {
    let client = meilisearch_client_core(state, connection_id).await?;
    crate::db::meilisearch_driver::get_key(&client, uid).await
}

pub async fn meilisearch_create_key_core(
    state: &AppState,
    connection_id: &str,
    input: &crate::db::meilisearch_driver::MeilisearchKeyCreateInput,
) -> Result<crate::db::meilisearch_driver::MeilisearchCreatedKey, String> {
    let client = meilisearch_client_core(state, connection_id).await?;
    crate::db::meilisearch_driver::create_key(&client, input).await
}

pub async fn meilisearch_update_key_core(
    state: &AppState,
    connection_id: &str,
    uid: &str,
    input: &crate::db::meilisearch_driver::MeilisearchKeyUpdateInput,
) -> Result<crate::db::meilisearch_driver::MeilisearchKeyListItem, String> {
    let client = meilisearch_client_core(state, connection_id).await?;
    crate::db::meilisearch_driver::update_key(&client, uid, input).await
}

pub async fn meilisearch_delete_key_core(state: &AppState, connection_id: &str, uid: &str) -> Result<(), String> {
    let client = meilisearch_client_core(state, connection_id).await?;
    crate::db::meilisearch_driver::delete_key(&client, uid).await
}

pub async fn meilisearch_get_tasks_core(
    state: &AppState,
    connection_id: &str,
    selector: &crate::db::meilisearch_driver::MeilisearchTaskSelector,
    from: Option<u64>,
    limit: u64,
) -> Result<crate::db::meilisearch_driver::MeilisearchTaskPage, String> {
    let client = meilisearch_client_core(state, connection_id).await?;
    crate::db::meilisearch_driver::get_tasks(&client, selector, from, limit).await
}

pub async fn meilisearch_get_task_core(
    state: &AppState,
    connection_id: &str,
    uid: u64,
    expected_index_uid: Option<&str>,
) -> Result<crate::db::meilisearch_driver::MeilisearchTask, String> {
    let client = meilisearch_client_core(state, connection_id).await?;
    let task = crate::db::meilisearch_driver::get_task(&client, uid).await?;
    crate::db::meilisearch_driver::ensure_task_index(&task, expected_index_uid)?;
    Ok(task)
}

pub async fn meilisearch_cancel_tasks_core(
    state: &AppState,
    connection_id: &str,
    selector: &crate::db::meilisearch_driver::MeilisearchTaskSelector,
) -> Result<crate::db::meilisearch_driver::MeilisearchEnqueuedTaskSummary, String> {
    let client = meilisearch_client_core(state, connection_id).await?;
    crate::db::meilisearch_driver::cancel_tasks(&client, selector).await
}

pub async fn meilisearch_delete_tasks_core(
    state: &AppState,
    connection_id: &str,
    selector: &crate::db::meilisearch_driver::MeilisearchTaskSelector,
) -> Result<crate::db::meilisearch_driver::MeilisearchEnqueuedTaskSummary, String> {
    let client = meilisearch_client_core(state, connection_id).await?;
    crate::db::meilisearch_driver::delete_tasks(&client, selector).await
}

#[cfg(test)]
mod tests {
    use super::{
        fallback_mongo_database, filter_and_sort_gridfs_bucket_infos, mongo_collection_specs_from_agent_response,
        mongo_gridfs_bucket_names, mongo_list_databases_unauthorized, parse_gridfs_bucket_sort, sort_names,
        MongoGridFsBucketInfo,
    };
    use crate::db::mongo_driver::MongoCollectionKind;

    #[test]
    fn sorts_names_case_insensitively() {
        let sorted = sort_names(vec![
            "movies".to_string(),
            "Comments".to_string(),
            "users".to_string(),
            "embedded_movies".to_string(),
        ]);

        assert_eq!(sorted, vec!["Comments", "embedded_movies", "movies", "users"]);
    }

    #[test]
    fn detects_mongo_list_databases_unauthorized_errors() {
        assert!(mongo_list_databases_unauthorized(
            "Command failed with error 13 (Unauthorized): not authorized on admin to execute command { listDatabases: 1 }",
        ));
        assert!(!mongo_list_databases_unauthorized("not authorized to execute command { find: \"orders\" }"));
    }

    #[test]
    fn falls_back_to_configured_mongo_database() {
        assert_eq!(
            fallback_mongo_database("not authorized", Some("app".to_string())).unwrap(),
            vec!["app".to_string()],
        );
        assert_eq!(fallback_mongo_database("not authorized", None).unwrap_err(), "not authorized");
    }

    #[test]
    fn extracts_gridfs_bucket_names_from_matching_files_and_chunks_collections() {
        let buckets = mongo_gridfs_bucket_names(&[
            "orders.files".to_string(),
            "orders.chunks".to_string(),
            "reports.files".to_string(),
            "reports.chunks".to_string(),
            "reports.files".to_string(),
            "loose.files".to_string(),
        ]);

        assert_eq!(buckets, vec!["orders".to_string(), "reports".to_string()]);
    }

    #[test]
    fn decodes_legacy_collection_names_and_type_aware_specs() {
        let specs = mongo_collection_specs_from_agent_response(serde_json::json!([
            "orders",
            { "name": "report_view", "kind": "view" },
            { "name": "metrics", "kind": "timeseries" },
            { "name": "future_kind", "kind": "unknown" }
        ]))
        .unwrap();

        assert_eq!(
            specs.into_iter().map(|spec| (spec.name, spec.kind)).collect::<Vec<_>>(),
            vec![
                ("orders".to_string(), MongoCollectionKind::Collection),
                ("report_view".to_string(), MongoCollectionKind::View),
                ("metrics".to_string(), MongoCollectionKind::Timeseries),
                ("future_kind".to_string(), MongoCollectionKind::Collection),
            ]
        );
    }

    #[test]
    fn filters_gridfs_buckets_by_case_insensitive_name_match() {
        let buckets = filter_and_sort_gridfs_bucket_infos(
            vec![
                MongoGridFsBucketInfo { name: "images".to_string(), file_count: 4, total_bytes: 512 },
                MongoGridFsBucketInfo { name: "nightly-reports".to_string(), file_count: 9, total_bytes: 4096 },
                MongoGridFsBucketInfo { name: "videos".to_string(), file_count: 2, total_bytes: 8192 },
            ],
            Some("REPORT"),
            None,
        )
        .unwrap();

        assert_eq!(
            buckets.into_iter().map(|bucket| bucket.name).collect::<Vec<_>>(),
            vec!["nightly-reports".to_string()]
        );
    }

    #[test]
    fn sorts_gridfs_buckets_by_total_bytes_descending() {
        let buckets = filter_and_sort_gridfs_bucket_infos(
            vec![
                MongoGridFsBucketInfo { name: "images".to_string(), file_count: 4, total_bytes: 512 },
                MongoGridFsBucketInfo { name: "nightly-reports".to_string(), file_count: 9, total_bytes: 4096 },
                MongoGridFsBucketInfo { name: "videos".to_string(), file_count: 2, total_bytes: 8192 },
            ],
            None,
            Some(r#"{"totalBytes":-1}"#),
        )
        .unwrap();

        assert_eq!(
            buckets.into_iter().map(|bucket| bucket.name).collect::<Vec<_>>(),
            vec!["videos".to_string(), "nightly-reports".to_string(), "images".to_string()]
        );
    }

    #[test]
    fn gridfs_bucket_sort_rejects_unknown_fields() {
        let error = parse_gridfs_bucket_sort(Some(r#"{"createdAt":-1}"#)).unwrap_err();

        assert!(error.contains("Unsupported GridFS bucket sort field"));
    }

    /// The desktop and web frontends send these three literals for the index
    /// metadata menu items. A rename on either side silently breaks all three
    /// actions, so pin the wire strings here.
    #[test]
    fn elasticsearch_index_metadata_kind_matches_the_frontend_wire_strings() {
        use super::ElasticsearchIndexMetadataKind;

        for (kind, wire) in [
            (ElasticsearchIndexMetadataKind::Mapping, "mapping"),
            (ElasticsearchIndexMetadataKind::Settings, "settings"),
            (ElasticsearchIndexMetadataKind::Stats, "stats"),
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), serde_json::json!(wire));
            assert_eq!(
                serde_json::from_value::<ElasticsearchIndexMetadataKind>(serde_json::json!(wire)).unwrap(),
                kind
            );
        }
    }
}
