use crate::connection::{AppState, PoolKind};
use crate::db::agent_driver::mongo_document_id_params;
use crate::db::mongo_driver::MongoDocumentResult;
use crate::db::{elasticsearch_driver, mongo_driver, vector_driver};

pub use crate::db::vector_driver::CollectionInfo;

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
            Ok(names.into_iter().map(|n| CollectionInfo { name: n.clone(), id: n, dimension: None }).collect())
        }
        PoolKind::Elasticsearch(client) => {
            let names = sort_names(elasticsearch_driver::list_indices(client).await?);
            Ok(names.into_iter().map(|n| CollectionInfo { name: n.clone(), id: n, dimension: None }).collect())
        }
        PoolKind::VectorDb(client) => vector_driver::list_collections_with_db(&client, database).await,
        PoolKind::Agent(client) => {
            let mut client = client.lock().await;
            let names = sort_names(client.mongo_list_collections(database).await?);
            Ok(names.into_iter().map(|n| CollectionInfo { name: n.clone(), id: n, dimension: None }).collect())
        }
        _ => Err("Not a MongoDB/Elasticsearch/vector connection".to_string()),
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
    use super::{fallback_mongo_database, mongo_list_databases_unauthorized, sort_names};

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
}
