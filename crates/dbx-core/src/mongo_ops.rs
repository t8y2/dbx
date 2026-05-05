use crate::connection::{AppState, PoolKind};
use crate::db::mongo_driver::{self, MongoDocumentResult};
use crate::db::elasticsearch_driver;

pub async fn mongo_list_databases_core(
    state: &AppState,
    connection_id: &str,
) -> Result<Vec<String>, String> {
    let connections = state.connections.lock().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => mongo_driver::list_databases(client).await,
        PoolKind::Elasticsearch(_) => Ok(vec!["default".to_string()]),
        _ => Err("Not a MongoDB/Elasticsearch connection".to_string()),
    }
}

pub async fn mongo_list_collections_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
) -> Result<Vec<String>, String> {
    let connections = state.connections.lock().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => mongo_driver::list_collections(client, database).await,
        PoolKind::Elasticsearch(client) => elasticsearch_driver::list_indices(client).await,
        _ => Err("Not a MongoDB/Elasticsearch connection".to_string()),
    }
}

pub async fn mongo_find_documents_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    skip: u64,
    limit: i64,
) -> Result<MongoDocumentResult, String> {
    let connections = state.connections.lock().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => {
            mongo_driver::find_documents(client, database, collection, skip, limit).await
        }
        PoolKind::Elasticsearch(client) => {
            let client = client.clone();
            drop(connections);
            elasticsearch_driver::find_documents(&client, collection, skip, limit).await
        }
        _ => Err("Not a MongoDB/Elasticsearch connection".to_string()),
    }
}

pub async fn mongo_insert_document_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    doc_json: &str,
) -> Result<String, String> {
    let connections = state.connections.lock().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => {
            mongo_driver::insert_document(client, database, collection, doc_json).await
        }
        PoolKind::Elasticsearch(client) => {
            let client = client.clone();
            drop(connections);
            elasticsearch_driver::insert_document(&client, collection, doc_json).await
        }
        _ => Err("Not a MongoDB/Elasticsearch connection".to_string()),
    }
}

pub async fn mongo_update_document_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    id: &str,
    doc_json: &str,
) -> Result<u64, String> {
    let connections = state.connections.lock().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => {
            mongo_driver::update_document(client, database, collection, id, doc_json).await
        }
        PoolKind::Elasticsearch(client) => {
            let client = client.clone();
            drop(connections);
            elasticsearch_driver::update_document(&client, collection, id, doc_json).await
        }
        _ => Err("Not a MongoDB/Elasticsearch connection".to_string()),
    }
}

pub async fn mongo_delete_document_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    id: &str,
) -> Result<u64, String> {
    let connections = state.connections.lock().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => {
            mongo_driver::delete_document(client, database, collection, id).await
        }
        PoolKind::Elasticsearch(client) => {
            let client = client.clone();
            drop(connections);
            elasticsearch_driver::delete_document(&client, collection, id).await
        }
        _ => Err("Not a MongoDB/Elasticsearch connection".to_string()),
    }
}
