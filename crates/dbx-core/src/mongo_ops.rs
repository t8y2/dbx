use crate::connection::{AppState, PoolKind};
use crate::db::mongo_driver::{self, MongoCollectionStatsResult, MongoDocumentResult, MongoDropIndexesResult};
use crate::document_ops::CollectionInfo;

async fn ensure_document_pool(state: &AppState, connection_id: &str) -> Result<(), String> {
    state.get_or_create_pool(connection_id, None).await.map(|_| ())
}

pub async fn mongo_list_databases_core(state: &AppState, connection_id: &str) -> Result<Vec<String>, String> {
    crate::document_ops::list_databases_core(state, connection_id).await
}

pub async fn mongo_list_collections_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
) -> Result<Vec<CollectionInfo>, String> {
    crate::document_ops::list_collections_core(state, connection_id, database).await
}

pub async fn mongo_create_database_core(state: &AppState, connection_id: &str, database: &str) -> Result<(), String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => mongo_driver::create_database(client, database).await,
        PoolKind::Agent(_) => Err("MongoDB legacy agent does not support create database".to_string()),
        _ => Err("Not a MongoDB connection".to_string()),
    }
}

pub async fn mongo_drop_database_core(state: &AppState, connection_id: &str, database: &str) -> Result<(), String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => mongo_driver::drop_database(client, database).await,
        PoolKind::Agent(_) => Err("MongoDB legacy agent does not support drop database".to_string()),
        _ => Err("Not a MongoDB connection".to_string()),
    }
}

pub async fn mongo_drop_collection_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
) -> Result<(), String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => mongo_driver::drop_collection(client, database, collection).await,
        PoolKind::Agent(client) => {
            let mut client = client.lock().await;
            let _: serde_json::Value = client
                .mongo_drop_collection(serde_json::json!({
                    "database": database,
                    "collection": collection,
                }))
                .await?;
            Ok(())
        }
        _ => Err("Not a MongoDB connection".to_string()),
    }
}

pub async fn mongo_server_version_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
) -> Result<String, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => mongo_driver::server_version(client, database).await,
        PoolKind::Agent(client) => {
            let mut client = client.lock().await;
            client.mongo_server_version(database).await
        }
        _ => Err("Not a MongoDB connection".to_string()),
    }
}

pub async fn mongo_collection_stats_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    scale: Option<serde_json::Number>,
) -> Result<MongoCollectionStatsResult, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => mongo_driver::collection_stats(client, database, collection, scale).await,
        PoolKind::Agent(_) => Err("MongoDB legacy agent does not support collection stats helpers".to_string()),
        _ => Err("Not a MongoDB connection".to_string()),
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn mongo_find_documents_core(
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
    crate::document_ops::find_documents_core(
        state,
        connection_id,
        database,
        collection,
        skip,
        limit,
        filter,
        projection,
        sort,
    )
    .await
}

/// Read MongoDB documents as relaxed Extended JSON for MongoDB transfer paths.
#[allow(clippy::too_many_arguments)]
pub async fn mongo_find_documents_extended_json_core(
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
            mongo_driver::find_documents_extended_json(
                client, database, collection, skip, limit, filter, projection, sort,
            )
            .await
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
            match client.mongo_find_documents_extended_json(params.clone()).await {
                Ok(result) => Ok(result),
                Err(error) if is_unknown_agent_method_error(&error, "find_documents_extended_json") => {
                    client.mongo_find_documents(params).await
                }
                Err(error) => Err(error),
            }
        }
        _ => Err("Not a MongoDB connection".to_string()),
    }
}

fn is_unknown_agent_method_error(error: &str, method: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains(method) && (lower.contains("unknown method") || lower.contains("method not found"))
}

pub async fn mongo_aggregate_documents_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    pipeline_json: &str,
    max_rows: Option<usize>,
) -> Result<MongoDocumentResult, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => {
            mongo_driver::aggregate_documents(client, database, collection, pipeline_json, max_rows).await
        }
        PoolKind::Agent(_) => Err("MongoDB legacy agent does not support aggregate".to_string()),
        _ => Err("Not a MongoDB connection".to_string()),
    }
}

pub async fn mongo_create_index_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    keys_json: &str,
    options_json: Option<&str>,
) -> Result<String, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => {
            mongo_driver::create_index(client, database, collection, keys_json, options_json).await
        }
        PoolKind::Agent(client) => {
            let mut client = client.lock().await;
            let result: serde_json::Value = client
                .mongo_create_index(serde_json::json!({
                    "database": database,
                    "collection": collection,
                    "keys_json": keys_json,
                    "options_json": options_json,
                }))
                .await?;
            Ok(result.get("name").and_then(|value| value.as_str()).unwrap_or("").to_string())
        }
        _ => Err("Not a MongoDB connection".to_string()),
    }
}

pub async fn mongo_drop_indexes_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    indexes_json: Option<&str>,
    single: bool,
) -> Result<MongoDropIndexesResult, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => {
            mongo_driver::drop_indexes(client, database, collection, indexes_json, single).await
        }
        PoolKind::Agent(client) => {
            let mut client = client.lock().await;
            client
                .mongo_drop_indexes(serde_json::json!({
                    "database": database,
                    "collection": collection,
                    "indexes_json": indexes_json,
                    "single": single,
                }))
                .await
        }
        _ => Err("Not a MongoDB connection".to_string()),
    }
}

pub async fn mongo_insert_document_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    doc_json: &str,
) -> Result<String, String> {
    crate::document_ops::insert_document_core(state, connection_id, database, collection, doc_json).await
}

pub async fn mongo_insert_documents_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    docs_json: &str,
) -> Result<u64, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => mongo_driver::insert_documents(client, database, collection, docs_json).await,
        PoolKind::Agent(_) => Err("MongoDB legacy agent does not support bulk insertMany/insertOne writes".to_string()),
        _ => Err("Not a MongoDB connection".to_string()),
    }
}

pub async fn mongo_insert_documents_extended_json_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    docs_json: &str,
) -> Result<u64, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => {
            mongo_driver::insert_documents_extended_json(client, database, collection, docs_json).await
        }
        PoolKind::Agent(_) => Err("MongoDB legacy agent does not support bulk insertMany/insertOne writes".to_string()),
        _ => Err("Not a MongoDB connection".to_string()),
    }
}

pub async fn mongo_update_document_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    id: &str,
    doc_json: &str,
    routing: Option<&str>,
) -> Result<u64, String> {
    crate::document_ops::update_document_core(state, connection_id, database, collection, id, doc_json, routing).await
}

pub async fn mongo_update_documents_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    filter_json: &str,
    update_json: &str,
    many: bool,
) -> Result<u64, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => {
            mongo_driver::update_documents(client, database, collection, filter_json, update_json, many).await
        }
        PoolKind::Agent(client) => {
            let mut client = client.lock().await;
            let result: serde_json::Value = client
                .mongo_update_documents(serde_json::json!({
                    "database": database,
                    "collection": collection,
                    "filter_json": filter_json,
                    "update_json": update_json,
                    "many": many,
                }))
                .await?;
            Ok(result.get("modified_count").and_then(|v| v.as_u64()).unwrap_or(0))
        }
        _ => Err("Not a MongoDB connection".to_string()),
    }
}

pub async fn mongo_delete_document_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    id: &str,
    routing: Option<&str>,
) -> Result<u64, String> {
    crate::document_ops::delete_document_core(state, connection_id, database, collection, id, routing).await
}

pub async fn mongo_delete_documents_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    filter_json: &str,
    many: bool,
) -> Result<u64, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => {
            mongo_driver::delete_documents(client, database, collection, filter_json, many).await
        }
        PoolKind::Agent(client) => {
            let mut client = client.lock().await;
            let result: serde_json::Value = client
                .mongo_delete_documents(serde_json::json!({
                    "database": database,
                    "collection": collection,
                    "filter_json": filter_json,
                    "many": many,
                }))
                .await?;
            Ok(result.get("deleted_count").and_then(|v| v.as_u64()).unwrap_or(0))
        }
        _ => Err("Not a MongoDB connection".to_string()),
    }
}
