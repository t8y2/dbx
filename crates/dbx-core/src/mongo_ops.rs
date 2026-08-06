use crate::connection::{AppState, PoolKind};
use crate::db::agent_driver::AgentCapability;
use crate::db::mongo_driver::{
    self, MongoCollectionStatsResult, MongoDocumentResult, MongoDropIndexFailure, MongoDropIndexesResult,
};
use crate::document_ops::CollectionInfo;
use crate::mongo_shell::MongoCommand;
use crate::types::QueryResult;

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
    mongo_driver::validate_mongo_namespace_name(database, "Database")?;
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => mongo_driver::drop_database(client, database).await,
        PoolKind::Agent(client) => {
            let mut client = client.lock().await;
            if !client.supports_capability(AgentCapability::MongoDropDatabase) {
                return Err(
                    "MongoDB Legacy Agent does not support drop database; upgrade or reinstall the MongoDB Legacy driver"
                        .to_string(),
                );
            }
            let _: serde_json::Value = client.mongo_drop_database(serde_json::json!({ "database": database })).await?;
            Ok(())
        }
        _ => Err("Not a MongoDB connection".to_string()),
    }
}

pub async fn mongo_drop_collection_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
) -> Result<(), String> {
    mongo_driver::validate_mongo_namespace_name(database, "Database")?;
    mongo_driver::validate_mongo_namespace_name(collection, "Collection")?;
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

pub async fn mongo_rename_collection_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    new_name: &str,
) -> Result<(), String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => mongo_driver::rename_collection(client, database, collection, new_name).await,
        PoolKind::Agent(_) => Err("MongoDB legacy agent does not support rename collection".to_string()),
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
    collation: Option<&str>,
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
        collation,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn mongo_find_documents_without_total_core(
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
) -> Result<MongoDocumentResult, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => {
            mongo_driver::find_documents_without_total(
                client, database, collection, skip, limit, filter, projection, sort, collation,
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
            if let Some(collation) = collation {
                params["collation"] = serde_json::json!(collation);
            }
            client.mongo_find_documents(params).await
        }
        _ => Err("Not a MongoDB connection".to_string()),
    }
}

pub async fn mongo_find_one_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    filter: Option<&str>,
    projection: Option<&str>,
    options: Option<&str>,
) -> Result<MongoDocumentResult, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => {
            mongo_driver::find_one(client, database, collection, filter, projection, options).await
        }
        PoolKind::Agent(client) => {
            let mut client = client.lock().await;
            client
                .mongo_find_one(serde_json::json!({
                    "database": database,
                    "collection": collection,
                    "filter": filter,
                    "projection": projection,
                    "options": options,
                }))
                .await
        }
        _ => Err("Not a MongoDB connection".to_string()),
    }
}

pub async fn mongo_count_documents_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    filter: Option<&str>,
    mode: Option<&str>,
) -> Result<u64, String> {
    let accurate = mode != Some("legacy");
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => {
            mongo_driver::count_documents(client, database, collection, filter, accurate).await
        }
        PoolKind::Agent(client) => {
            let mut client = client.lock().await;
            let params = serde_json::json!({
                "database": database,
                "collection": collection,
                "filter": filter,
                "accurate": accurate,
            });
            match client.mongo_count_documents(params.clone()).await {
                Ok(total) => Ok(total),
                Err(error) if is_unknown_agent_method_error(&error, "count_documents") => {
                    let result: MongoDocumentResult = client
                        .mongo_find_documents(serde_json::json!({
                            "database": database,
                            "collection": collection,
                            "skip": 0,
                            "limit": 1,
                            "filter": filter,
                        }))
                        .await?;
                    Ok(result.total)
                }
                Err(error) => Err(error),
            }
        }
        _ => Err("Not a MongoDB connection".to_string()),
    }
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
                client, database, collection, skip, limit, filter, projection, sort, None,
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
    options_json: Option<&str>,
) -> Result<MongoDocumentResult, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => {
            mongo_driver::aggregate_documents(client, database, collection, pipeline_json, max_rows, options_json).await
        }
        PoolKind::Agent(_) => Err("MongoDB legacy agent does not support aggregate".to_string()),
        _ => Err("Not a MongoDB connection".to_string()),
    }
}

pub async fn mongo_distinct_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    field: &str,
    filter: Option<&str>,
) -> Result<MongoDocumentResult, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => mongo_driver::distinct(client, database, collection, field, filter).await,
        // The legacy agent protocol has no distinct method and no read that could stand in for it.
        PoolKind::Agent(_) => Err("MongoDB legacy agent does not support distinct".to_string()),
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
    // The Legacy Agent receives the original JSON, so validate the shared
    // createIndexes contract before selecting a driver implementation.
    mongo_driver::validate_mongo_namespace_name(database, "Database")?;
    mongo_driver::validate_mongo_namespace_name(collection, "Collection")?;
    mongo_driver::validate_create_index_request(keys_json, options_json)?;
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
            result
                .get("name")
                .and_then(serde_json::Value::as_str)
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .ok_or_else(|| "MongoDB legacy agent returned no created index name".to_string())
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
    mongo_driver::validate_mongo_namespace_name(database, "Database")?;
    mongo_driver::validate_mongo_namespace_name(collection, "Collection")?;
    let serial_names = mongo_driver::serial_drop_index_names(indexes_json, single)?;
    if let Some(names) = serial_names {
        let requires_serial_fallback = match mongo_server_version_core(state, connection_id, database).await {
            Ok(version) => mongo_driver::mongo_server_requires_serial_drop_indexes(&version),
            Err(error) => {
                log::warn!(
                    "[mongo][drop-indexes] server version unavailable; preserving array command semantics: {error}"
                );
                false
            }
        };
        if requires_serial_fallback {
            let mut dropped_names = Vec::new();
            let mut failures = Vec::new();
            for name in names {
                let index_json = serde_json::to_string(&name).map_err(|error| error.to_string())?;
                match mongo_drop_indexes_once_core(state, connection_id, database, collection, Some(&index_json), true)
                    .await
                {
                    Ok(result) => {
                        dropped_names.extend(result.dropped_names);
                        failures.extend(result.failures);
                    }
                    Err(message) => failures.push(MongoDropIndexFailure { name, message }),
                }
            }
            return Ok(MongoDropIndexesResult { affected_rows: dropped_names.len() as u64, dropped_names, failures });
        }
    }

    mongo_drop_indexes_once_core(state, connection_id, database, collection, indexes_json, single).await
}

async fn mongo_drop_indexes_once_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    indexes_json: Option<&str>,
    single: bool,
) -> Result<MongoDropIndexesResult, String> {
    // Apply the same argument and default-index protection before dispatching
    // to Native MongoDB or the Legacy Agent.
    mongo_driver::validate_drop_indexes_request(indexes_json, single)?;
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
    crate::document_ops::insert_document_core(state, connection_id, database, collection, doc_json, None).await
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
    options_json: Option<&str>,
) -> Result<u64, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => {
            mongo_driver::update_documents(client, database, collection, filter_json, update_json, many, options_json)
                .await
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
                    "options_json": options_json,
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

pub async fn mongo_find_one_and_update_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    filter_json: &str,
    update_json: &str,
    options_json: Option<&str>,
) -> Result<MongoDocumentResult, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => {
            mongo_driver::find_one_and_update(client, database, collection, filter_json, update_json, options_json)
                .await
        }
        PoolKind::Agent(_) => Err("MongoDB legacy agent does not support findOneAndUpdate".to_string()),
        _ => Err("Not a MongoDB connection".to_string()),
    }
}

pub async fn mongo_find_one_and_replace_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    filter_json: &str,
    replacement_json: &str,
    options_json: Option<&str>,
) -> Result<MongoDocumentResult, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => {
            mongo_driver::find_one_and_replace(
                client,
                database,
                collection,
                filter_json,
                replacement_json,
                options_json,
            )
            .await
        }
        PoolKind::Agent(_) => Err("MongoDB legacy agent does not support findOneAndReplace".to_string()),
        _ => Err("Not a MongoDB connection".to_string()),
    }
}

pub async fn mongo_find_one_and_delete_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    filter_json: &str,
    options_json: Option<&str>,
) -> Result<MongoDocumentResult, String> {
    ensure_document_pool(state, connection_id).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id).ok_or("Not found")? {
        PoolKind::MongoDb(client) => {
            mongo_driver::find_one_and_delete(client, database, collection, filter_json, options_json).await
        }
        PoolKind::Agent(_) => Err("MongoDB legacy agent does not support findOneAndDelete".to_string()),
        _ => Err("Not a MongoDB connection".to_string()),
    }
}

pub async fn execute_mongo_command_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    command: &MongoCommand,
    max_rows: usize,
) -> Result<QueryResult, String> {
    use serde_json::Value;

    match command {
        MongoCommand::Version => mongo_server_version_core(state, connection_id, database)
            .await
            .map(|version| scalar_query_result("version", Value::String(version))),
        MongoCommand::Use { database } => Ok(scalar_query_result("database", Value::String(database.clone()))),
        MongoCommand::Find { collection, filter, projection, sort, collation, skip, limit } => {
            let limit = bounded_mongo_find_limit(*limit, max_rows);
            let result = mongo_find_documents_without_total_core(
                state,
                connection_id,
                database,
                collection,
                *skip,
                limit,
                Some(filter),
                projection.as_deref(),
                sort.as_deref(),
                collation.as_deref(),
            )
            .await?;
            Ok(mongo_documents_query_result(result.documents))
        }
        MongoCommand::FindOne { collection, filter, projection, options } => {
            let result = mongo_find_one_core(
                state,
                connection_id,
                database,
                collection,
                Some(filter),
                projection.as_deref(),
                options.as_deref(),
            )
            .await?;
            Ok(mongo_documents_query_result(result.documents))
        }
        MongoCommand::Count { collection, filter, accurate } => {
            let mode = if *accurate { "accurate" } else { "legacy" };
            let total =
                mongo_count_documents_core(state, connection_id, database, collection, Some(filter), Some(mode))
                    .await?;
            Ok(scalar_query_result("count", Value::from(total)))
        }
        MongoCommand::Aggregate { collection, pipeline, options } => {
            let result = mongo_aggregate_documents_core(
                state,
                connection_id,
                database,
                collection,
                pipeline,
                Some(max_rows),
                options.as_deref(),
            )
            .await?;
            Ok(mongo_documents_query_result(result.documents))
        }
        MongoCommand::Distinct { collection, field, filter } => {
            let result =
                mongo_distinct_core(state, connection_id, database, collection, field, filter.as_deref()).await?;
            Ok(mongo_documents_query_result(limit_mongo_documents(result, max_rows).documents))
        }
        MongoCommand::GetIndexes { collection } => {
            let result = mongo_aggregate_documents_core(
                state,
                connection_id,
                database,
                collection,
                r#"[{"$indexStats":{}}]"#,
                Some(max_rows),
                None,
            )
            .await?;
            Ok(mongo_documents_query_result(result.documents))
        }
        MongoCommand::CollectionStats { collection, metric, scale } => {
            let stats = mongo_collection_stats_core(state, connection_id, database, collection, scale.clone()).await?;
            let value = serde_json::to_value(stats).map_err(|error| error.to_string())?;
            if metric == "stats" {
                Ok(mongo_documents_query_result(vec![value]))
            } else {
                let key = match metric.as_str() {
                    "dataSize" => "size",
                    "storageSize" => "storageSize",
                    "totalIndexSize" => "totalIndexSize",
                    _ => metric,
                };
                Ok(scalar_query_result(metric, value.get(key).cloned().unwrap_or(Value::Null)))
            }
        }
        MongoCommand::Insert { collection, documents } => {
            let affected = mongo_insert_documents_core(state, connection_id, database, collection, documents).await?;
            Ok(affected_query_result(affected))
        }
        MongoCommand::Update { collection, filter, update, options, many } => {
            let affected = mongo_update_documents_core(
                state,
                connection_id,
                database,
                collection,
                filter,
                update,
                *many,
                options.as_deref(),
            )
            .await?;
            Ok(affected_query_result(affected))
        }
        MongoCommand::Delete { collection, filter, many } => {
            let affected =
                mongo_delete_documents_core(state, connection_id, database, collection, filter, *many).await?;
            Ok(affected_query_result(affected))
        }
        MongoCommand::CreateIndex { collection, keys, options } => {
            let name =
                mongo_create_index_core(state, connection_id, database, collection, keys, options.as_deref()).await?;
            Ok(scalar_query_result("name", Value::String(name)))
        }
        MongoCommand::DropIndexes { collection, indexes, single } => {
            let result =
                mongo_drop_indexes_core(state, connection_id, database, collection, indexes.as_deref(), *single)
                    .await?;
            Ok(mongo_drop_indexes_query_result(
                result.dropped_names,
                result.failures.into_iter().map(|failure| (failure.name, failure.message)).collect(),
                result.affected_rows,
            ))
        }
        MongoCommand::DropCollection { collection } => {
            mongo_drop_collection_core(state, connection_id, database, collection).await?;
            Ok(affected_query_result(1))
        }
        MongoCommand::FindOneAndUpdate { collection, filter, update, options } => {
            let result = mongo_find_one_and_update_core(
                state,
                connection_id,
                database,
                collection,
                filter,
                update,
                options.as_deref(),
            )
            .await?;
            Ok(mongo_documents_query_result(result.documents))
        }
        MongoCommand::FindOneAndReplace { collection, filter, replacement, options } => {
            let result = mongo_find_one_and_replace_core(
                state,
                connection_id,
                database,
                collection,
                filter,
                replacement,
                options.as_deref(),
            )
            .await?;
            Ok(mongo_documents_query_result(result.documents))
        }
        MongoCommand::FindOneAndDelete { collection, filter, options } => {
            let result =
                mongo_find_one_and_delete_core(state, connection_id, database, collection, filter, options.as_deref())
                    .await?;
            Ok(mongo_documents_query_result(result.documents))
        }
    }
}

fn bounded_mongo_find_limit(command_limit: i64, max_rows: usize) -> i64 {
    let max_rows = max_rows.max(1).min(i64::MAX as usize) as i64;
    if command_limit == 0 {
        return max_rows;
    }
    command_limit.saturating_abs().min(max_rows).max(1)
}

fn limit_mongo_documents(mut result: MongoDocumentResult, max_rows: usize) -> MongoDocumentResult {
    let max_rows = max_rows.max(1);
    result.documents.truncate(max_rows);
    if let Some(raw_documents) = result.raw_documents.as_mut() {
        raw_documents.truncate(max_rows);
    }
    if let Some(extended_documents) = result.extended_documents.as_mut() {
        extended_documents.truncate(max_rows);
    }
    result
}

fn query_result(columns: Vec<String>, rows: Vec<Vec<serde_json::Value>>, affected_rows: u64) -> QueryResult {
    QueryResult {
        columns,
        column_types: Vec::new(),
        column_sortables: Vec::new(),
        spatial_columns: Vec::new(),
        spatial_values: Vec::new(),
        rows,
        affected_rows,
        execution_time_ms: 0,
        truncated: false,
        session_id: None,
        has_more: false,
        elasticsearch_raw_body: None,
    }
}

fn scalar_query_result(column: impl Into<String>, value: serde_json::Value) -> QueryResult {
    query_result(vec![column.into()], vec![vec![value]], 0)
}

fn affected_query_result(affected_rows: u64) -> QueryResult {
    query_result(Vec::new(), Vec::new(), affected_rows)
}

fn mongo_drop_indexes_query_result(
    dropped_names: Vec<String>,
    failures: Vec<(String, String)>,
    affected_rows: u64,
) -> QueryResult {
    use serde_json::Value;

    if failures.is_empty() {
        let rows = dropped_names.into_iter().map(|name| vec![Value::String(name)]).collect::<Vec<_>>();
        return query_result(if rows.is_empty() { Vec::new() } else { vec!["name".to_string()] }, rows, affected_rows);
    }

    let mut rows = dropped_names
        .into_iter()
        .map(|name| vec![Value::String(name), Value::String("dropped".to_string()), Value::Null])
        .collect::<Vec<_>>();
    rows.extend(
        failures.into_iter().map(|(name, message)| {
            vec![Value::String(name), Value::String("failed".to_string()), Value::String(message)]
        }),
    );
    query_result(vec!["name".to_string(), "status".to_string(), "message".to_string()], rows, affected_rows)
}

fn mongo_documents_query_result(documents: Vec<serde_json::Value>) -> QueryResult {
    use serde_json::Value;

    if documents.is_empty() {
        return query_result(Vec::new(), Vec::new(), 0);
    }
    let mut columns = std::collections::BTreeSet::new();
    for document in &documents {
        if let Some(object) = document.as_object() {
            columns.extend(object.keys().cloned());
        } else {
            columns.insert("value".to_string());
        }
    }
    let columns = columns.into_iter().collect::<Vec<_>>();
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
    query_result(columns, rows, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_find_limit_never_passes_an_unbounded_zero_to_mongodb() {
        assert_eq!(bounded_mongo_find_limit(0, 50), 50);
        assert_eq!(bounded_mongo_find_limit(0, 0), 1);
        assert_eq!(bounded_mongo_find_limit(100, 7), 7);
        assert_eq!(bounded_mongo_find_limit(-100, 7), 7);
    }

    #[test]
    fn agent_document_limit_caps_distinct_values() {
        let result = MongoDocumentResult {
            documents: vec![serde_json::json!(1), serde_json::json!(2), serde_json::json!(3)],
            raw_documents: Some(vec!["1".to_string(), "2".to_string(), "3".to_string()]),
            extended_documents: Some(vec![serde_json::json!(1), serde_json::json!(2), serde_json::json!(3)]),
            total: 3,
            total_is_exact: true,
        };

        let limited = limit_mongo_documents(result, 2);
        assert_eq!(limited.documents, vec![serde_json::json!(1), serde_json::json!(2)]);
        assert_eq!(limited.raw_documents.unwrap(), vec!["1", "2"]);
        assert_eq!(limited.extended_documents.unwrap(), vec![serde_json::json!(1), serde_json::json!(2)]);
    }

    #[cfg(unix)]
    use crate::db::agent_driver::{AgentDriverClient, AgentLaunchSpec};
    #[cfg(unix)]
    use crate::models::connection::ConnectionConfig;
    #[cfg(unix)]
    use crate::storage::Storage;

    #[cfg(unix)]
    async fn legacy_mongo_state(
        expected_method: &str,
        expected_params: serde_json::Value,
        expected_result: serde_json::Value,
    ) -> (AppState, tempfile::TempDir) {
        legacy_mongo_state_with_options(
            expected_method,
            expected_params,
            expected_result,
            &[AgentCapability::MongoDropDatabase.as_str()],
            None,
            None,
        )
        .await
    }

    #[cfg(unix)]
    async fn legacy_mongo_state_with_capabilities(
        expected_method: &str,
        expected_params: serde_json::Value,
        expected_result: serde_json::Value,
        capabilities: &[&str],
    ) -> (AppState, tempfile::TempDir) {
        legacy_mongo_state_with_options(expected_method, expected_params, expected_result, capabilities, None, None)
            .await
    }

    #[cfg(unix)]
    async fn legacy_mongo_state_with_server_version(
        expected_method: &str,
        expected_params: serde_json::Value,
        expected_result: serde_json::Value,
        server_version: &str,
    ) -> (AppState, tempfile::TempDir) {
        legacy_mongo_state_with_options(
            expected_method,
            expected_params,
            expected_result,
            &[AgentCapability::MongoDropDatabase.as_str()],
            Some(server_version),
            None,
        )
        .await
    }

    #[cfg(unix)]
    async fn legacy_mongo_state_with_server_error(
        expected_method: &str,
        expected_params: serde_json::Value,
        expected_error: &str,
        server_version: &str,
    ) -> (AppState, tempfile::TempDir) {
        legacy_mongo_state_with_options(
            expected_method,
            expected_params,
            serde_json::Value::Null,
            &[AgentCapability::MongoDropDatabase.as_str()],
            Some(server_version),
            Some(expected_error),
        )
        .await
    }

    #[cfg(unix)]
    async fn legacy_mongo_state_with_options(
        expected_method: &str,
        expected_params: serde_json::Value,
        expected_result: serde_json::Value,
        capabilities: &[&str],
        server_version: Option<&str>,
        expected_error: Option<&str>,
    ) -> (AppState, tempfile::TempDir) {
        use std::io::Write;

        let directory = tempfile::tempdir().unwrap();
        let mut script = tempfile::NamedTempFile::new_in(directory.path()).unwrap();
        let expected_method = serde_json::to_string(expected_method).unwrap();
        let expected_params = serde_json::to_string(&serde_json::to_string(&expected_params).unwrap()).unwrap();
        let expected_result = serde_json::to_string(&serde_json::to_string(&expected_result).unwrap()).unwrap();
        let capabilities = serde_json::to_string(capabilities).unwrap();
        let python_optional_string = |value: Option<&str>| {
            value.map(|value| serde_json::to_string(value).unwrap()).unwrap_or_else(|| "None".to_string())
        };
        let server_version = python_optional_string(server_version);
        let expected_error = python_optional_string(expected_error);
        write!(
            script,
            r#"import json
import sys

EXPECTED_METHOD = {expected_method}
EXPECTED_PARAMS = json.loads({expected_params})
EXPECTED_RESULT = json.loads({expected_result})
CAPABILITIES = {capabilities}
SERVER_VERSION = {server_version}
EXPECTED_ERROR = {expected_error}

print(json.dumps({{"ready": True}}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    if request.get("method") == "handshake":
        result = {{"protocolVersion": 1, "agentProtocolVersion": 1, "capabilities": CAPABILITIES}}
        print(json.dumps({{"jsonrpc": "2.0", "id": request["id"], "result": result}}), flush=True)
        continue
    if request.get("method") == "validate_connection":
        print(json.dumps({{"jsonrpc": "2.0", "id": request["id"], "result": {{"ok": True}}}}), flush=True)
        continue
    if request.get("method") == "server_version" and SERVER_VERSION is not None:
        print(json.dumps({{"jsonrpc": "2.0", "id": request["id"], "result": SERVER_VERSION}}), flush=True)
        continue
    if request.get("method") != EXPECTED_METHOD or request.get("params") != EXPECTED_PARAMS:
        print(json.dumps({{"jsonrpc": "2.0", "id": request["id"], "error": {{"code": -1, "message": "unexpected MongoDB RPC"}}}}), flush=True)
        continue
    if EXPECTED_ERROR is not None:
        print(json.dumps({{"jsonrpc": "2.0", "id": request["id"], "error": {{"code": -1, "message": EXPECTED_ERROR}}}}), flush=True)
    else:
        print(json.dumps({{"jsonrpc": "2.0", "id": request["id"], "result": EXPECTED_RESULT}}), flush=True)
"#
        )
        .unwrap();
        script.flush().unwrap();
        // Keep the script available until the spawned interpreter has opened it.
        let (_, script_path) = script.keep().unwrap();

        let mut client = AgentDriverClient::spawn(
            AgentLaunchSpec::new("python3").with_args([script_path.to_string_lossy().to_string()]),
        )
        .await
        .unwrap();
        client.try_optional_handshake("test").await.unwrap();
        let storage = Storage::open(&directory.path().join("storage.db")).await.unwrap();
        let state = AppState::new(storage);
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "legacy",
            "name": "Legacy MongoDB",
            "db_type": "mongodb",
            "driver_profile": "mongodb-legacy",
            "host": "localhost",
            "port": 27017,
            "username": "",
            "password": "",
            "database": null,
        }))
        .unwrap();
        state.configs.write().await.insert("legacy".to_string(), config);
        state.connections.write().await.insert("legacy".to_string(), PoolKind::agent(client));
        (state, directory)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mongo_drop_database_routes_legacy_connections_to_the_agent() {
        let (state, _directory) = legacy_mongo_state(
            "drop_database",
            serde_json::json!({ "database": "app" }),
            serde_json::json!({ "ok": true }),
        )
        .await;

        mongo_drop_database_core(&state, "legacy", "app").await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mongo_drop_database_requires_an_explicit_legacy_agent_capability() {
        let (state, _directory) = legacy_mongo_state_with_capabilities(
            "drop_database",
            serde_json::json!({ "database": "app" }),
            serde_json::json!({ "ok": true }),
            &[],
        )
        .await;

        let error = mongo_drop_database_core(&state, "legacy", "app").await.unwrap_err();

        assert!(error.contains("upgrade or reinstall"), "{error}");
        assert!(!error.contains("Unknown method"), "{error}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mongo_drop_collection_routes_legacy_connections_to_the_agent() {
        let (state, _directory) = legacy_mongo_state(
            "drop_collection",
            serde_json::json!({
                "database": "app",
                "collection": "users",
            }),
            serde_json::json!({ "ok": true }),
        )
        .await;

        mongo_drop_collection_core(&state, "legacy", "app", "users").await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mongo_list_collections_requests_legacy_collection_types() {
        let (state, _directory) = legacy_mongo_state(
            "list_collections",
            serde_json::json!({ "database": "app", "include_types": true }),
            serde_json::json!([
                { "name": "report_view", "kind": "view" },
                { "name": "metrics", "kind": "timeseries" },
                "orders"
            ]),
        )
        .await;

        let collections = mongo_list_collections_core(&state, "legacy", "app").await.unwrap();

        assert_eq!(
            collections.into_iter().map(|collection| (collection.name, collection.kind)).collect::<Vec<_>>(),
            vec![
                ("metrics".to_string(), Some("timeseries".to_string())),
                ("orders".to_string(), Some("collection".to_string())),
                ("report_view".to_string(), Some("view".to_string())),
            ]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mongo_create_index_routes_legacy_connections_to_the_agent() {
        let keys_json = r#"{"email":1}"#;
        let options_json = r#"{"name":"email_1","unique":true}"#;
        let (state, _directory) = legacy_mongo_state(
            "create_index",
            serde_json::json!({
                "database": "app",
                "collection": "users",
                "keys_json": keys_json,
                "options_json": options_json,
            }),
            serde_json::json!({ "name": "email_1" }),
        )
        .await;

        let name =
            mongo_create_index_core(&state, "legacy", "app", "users", keys_json, Some(options_json)).await.unwrap();

        assert_eq!(name, "email_1");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mongo_create_index_requires_a_name_from_the_legacy_agent() {
        let (state, _directory) = legacy_mongo_state(
            "create_index",
            serde_json::json!({
                "database": "app",
                "collection": "users",
                "keys_json": "{\"email\":1}",
                "options_json": null,
            }),
            serde_json::json!({}),
        )
        .await;

        let error =
            mongo_create_index_core(&state, "legacy", "app", "users", r#"{"email":1}"#, None).await.unwrap_err();

        assert!(error.contains("no created index name"), "{error}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mongo_create_index_rejects_key_options_before_agent_dispatch() {
        let (state, _directory) = legacy_mongo_state("unexpected", serde_json::json!({}), serde_json::json!({})).await;

        let error =
            mongo_create_index_core(&state, "legacy", "app", "users", r#"{"email":1}"#, Some(r#"{"key":{"other":1}}"#))
                .await
                .unwrap_err();

        assert!(error.contains("cannot contain \"key\""), "{error}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mongo_create_index_rejects_an_empty_name_before_agent_dispatch() {
        let (state, _directory) = legacy_mongo_state("unexpected", serde_json::json!({}), serde_json::json!({})).await;

        let error = mongo_create_index_core(&state, "legacy", "app", "users", r#"{"email":1}"#, Some(r#"{"name":""}"#))
            .await
            .unwrap_err();

        assert!(error.contains("non-empty string"), "{error}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mongo_drop_index_routes_legacy_connections_to_the_agent() {
        let (state, _directory) = legacy_mongo_state(
            "drop_indexes",
            serde_json::json!({
                "database": "app",
                "collection": "users",
                "indexes_json": "\"email_1\"",
                "single": true,
            }),
            serde_json::json!({ "affected_rows": 1, "dropped_names": ["email_1"] }),
        )
        .await;

        let result =
            mongo_drop_indexes_core(&state, "legacy", "app", "users", Some(r#""email_1""#), true).await.unwrap();

        assert_eq!(result.dropped_names, ["email_1"]);
        assert_eq!(result.affected_rows, 1);
        assert!(result.failures.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mongo_drop_indexes_returns_partial_results_for_mongodb_34_agents() {
        let (state, _directory) = legacy_mongo_state_with_server_version(
            "drop_indexes",
            serde_json::json!({
                "database": "app",
                "collection": "users",
                "indexes_json": "\"email_1\"",
                "single": true,
            }),
            serde_json::json!({ "affected_rows": 1, "dropped_names": ["email_1"] }),
            "3.4.24",
        )
        .await;

        let result =
            mongo_drop_indexes_core(&state, "legacy", "app", "users", Some(r#"["email_1","missing_1"]"#), false)
                .await
                .unwrap();

        assert_eq!(result.dropped_names, ["email_1"]);
        assert_eq!(result.affected_rows, 1);
        assert_eq!(result.failures.len(), 1);
        assert_eq!(result.failures[0].name, "missing_1");
        assert!(result.failures[0].message.contains("unexpected MongoDB RPC"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mongo_drop_indexes_preserves_modern_agent_batch_failure_semantics() {
        let (state, _directory) = legacy_mongo_state_with_server_error(
            "drop_indexes",
            serde_json::json!({
                "database": "app",
                "collection": "users",
                "indexes_json": "[\"email_1\",\"missing_1\"]",
                "single": false,
            }),
            "index not found; no indexes dropped",
            "4.2.0",
        )
        .await;

        let error =
            mongo_drop_indexes_core(&state, "legacy", "app", "users", Some(r#"["email_1","missing_1"]"#), false)
                .await
                .unwrap_err();

        assert!(error.contains("no indexes dropped"), "{error}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mongo_drop_indexes_rejects_the_default_id_index_before_agent_dispatch() {
        let (state, _directory) = legacy_mongo_state("unexpected", serde_json::json!({}), serde_json::json!({})).await;

        let error =
            mongo_drop_indexes_core(&state, "legacy", "app", "users", Some(r#""_id_""#), true).await.unwrap_err();

        assert!(error.contains("_id_"), "{error}");
    }
}
