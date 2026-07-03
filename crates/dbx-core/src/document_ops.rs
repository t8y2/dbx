use crate::connection::{AppState, PoolKind};
use crate::db::agent_driver::mongo_document_id_params;
use crate::db::mongo_driver::MongoDocumentResult;
use crate::db::{elasticsearch_driver, mongo_driver, vector_driver};

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

fn sort_names(mut names: Vec<String>) -> Vec<String> {
    names.sort_by(|left, right| {
        let left_lower = left.to_lowercase();
        let right_lower = right.to_lowercase();
        left_lower.cmp(&right_lower).then_with(|| left.cmp(right))
    });
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
        PoolKind::Elasticsearch(_) | PoolKind::VectorDb(_) => Ok(vec!["default".to_string()]),
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

fn mongo_collection_info(name: String) -> CollectionInfo {
    CollectionInfo {
        name: name.clone(),
        id: name,
        dimension: None,
        kind: Some("collection".to_string()),
        bucket_name: None,
    }
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
            dimension: None,
            kind: Some("bucket".to_string()),
            bucket_name: Some(bucket_name),
        })
        .collect()
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
            let names = sort_names(mongo_driver::list_collections(client, database).await?);
            let mut infos = mongo_bucket_infos(&names);
            infos.extend(names.into_iter().map(mongo_collection_info));
            Ok(infos)
        }
        PoolKind::Elasticsearch(client) => {
            let names = sort_names(elasticsearch_driver::list_indices(client).await?);
            Ok(names
                .into_iter()
                .map(|n| CollectionInfo { name: n.clone(), id: n, dimension: None, kind: None, bucket_name: None })
                .collect())
        }
        PoolKind::VectorDb(client) => vector_driver::list_collections_with_db(&client, database).await,
        PoolKind::Agent(client) => {
            let mut client = client.lock().await;
            let names = sort_names(client.mongo_list_collections(database).await?);
            let mut infos = mongo_bucket_infos(&names);
            infos.extend(names.into_iter().map(mongo_collection_info));
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
) -> Result<Vec<MongoGridFsFileInfo>, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => mongo_driver::list_gridfs_files(client, database, bucket).await,
        PoolKind::Agent(_) => Err("MongoDB legacy agent does not support GridFS file browsing".to_string()),
        _ => Err("Not a MongoDB connection".to_string()),
    }
}

pub async fn list_gridfs_buckets_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
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
            Ok(buckets)
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
) -> Result<MongoDocumentResult, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => {
            mongo_driver::find_documents(client, database, collection, skip, limit, filter, projection, sort).await
        }
        PoolKind::Elasticsearch(client) => {
            let client = client.clone();
            drop(connections);
            elasticsearch_driver::find_documents(&client, collection, skip, limit, filter, sort).await
        }
        PoolKind::VectorDb(client) => {
            let client = client.clone();
            drop(connections);
            let _ = (database, filter, sort);
            vector_driver::find_documents(&client, collection, skip, limit).await
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
            client.mongo_find_documents(params).await
        }
        _ => Err("Not a MongoDB/Elasticsearch/vector connection".to_string()),
    }
}

pub async fn insert_document_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    doc_json: &str,
) -> Result<String, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => mongo_driver::insert_document(client, database, collection, doc_json).await,
        PoolKind::Elasticsearch(client) => {
            let client = client.clone();
            drop(connections);
            elasticsearch_driver::insert_document(&client, collection, doc_json).await
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
        PoolKind::Elasticsearch(client) => {
            let client = client.clone();
            drop(connections);
            // Elasticsearch requires the same custom routing value for writes
            // as was used to index the document.
            elasticsearch_driver::update_document(&client, collection, id, doc_json, routing).await
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
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => mongo_driver::delete_document(client, database, collection, id).await,
        PoolKind::Elasticsearch(client) => {
            let client = client.clone();
            drop(connections);
            // Elasticsearch requires the same custom routing value for writes
            // as was used to index the document.
            elasticsearch_driver::delete_document(&client, collection, id, routing).await
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

#[cfg(test)]
mod tests {
    use super::{fallback_mongo_database, mongo_gridfs_bucket_names, mongo_list_databases_unauthorized, sort_names};

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
}
