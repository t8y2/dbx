use mongodb::{
    bson::{doc, oid::ObjectId, Bson, DateTime, Document},
    options::{ClientOptions, IndexOptions},
    Client, IndexModel,
};
use serde::{Deserialize, Serialize};

use super::with_connection_timeout;
use crate::types::IndexInfo;
use futures::TryStreamExt;
use percent_encoding::percent_decode_str;
use std::{collections::HashSet, time::Duration};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MongoDocumentResult {
    pub documents: Vec<serde_json::Value>,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MongoDropIndexesResult {
    pub dropped_names: Vec<String>,
    pub affected_rows: u64,
}

pub async fn connect(url: &str, timeout: Duration, idle_timeout: Duration) -> Result<Client, String> {
    let url = normalize_mongo_uri_direct_connection(url);
    let is_multi_host = is_multi_host_mongo_uri(&url);
    let parse_timeout = if is_multi_host { std::cmp::max(timeout * 2, Duration::from_secs(10)) } else { timeout };

    with_connection_timeout("MongoDB", parse_timeout, async {
        let mut options = ClientOptions::parse(&url).await.map_err(|e| format!("MongoDB connection failed: {e}"))?;
        options.connect_timeout = Some(timeout);
        options.server_selection_timeout =
            if is_multi_host { Some(std::cmp::max(timeout * 2, Duration::from_secs(10))) } else { Some(timeout) };
        // Close idle connections before the server-side timeout drops them,
        // preventing "Broken pipe" (os error 32) or "unexpected end of file".
        // 0 means no idle timeout (keep connections alive indefinitely).
        if idle_timeout.as_secs() > 0 {
            options.max_idle_time = Some(idle_timeout);
        }
        // For single-host connections, force direct connection to avoid replica
        // set discovery. This is essential when connecting through a TCP proxy
        // or NAT where the driver would otherwise receive internal IPs from
        // the replica set handshake and fail to connect.
        if !is_multi_host {
            options.direct_connection = Some(true);
        }
        Client::with_options(options).map_err(|e| format!("MongoDB connection failed: {e}"))
    })
    .await
}

fn normalize_mongo_uri_direct_connection(uri: &str) -> String {
    if !is_multi_host_mongo_uri(uri) || !mongo_uri_has_direct_connection_true(uri) {
        return uri.to_string();
    }

    let (before_fragment, fragment) =
        uri.split_once('#').map(|(base, fragment)| (base, Some(fragment))).unwrap_or((uri, None));
    let Some((base, query)) = before_fragment.split_once('?') else {
        return uri.to_string();
    };
    let params =
        query.split('&').filter(|part| !mongo_url_param_is_direct_connection_true(part)).collect::<Vec<_>>().join("&");

    let mut normalized = if params.is_empty() { base.to_string() } else { format!("{base}?{params}") };
    if let Some(fragment) = fragment {
        normalized.push('#');
        normalized.push_str(fragment);
    }
    normalized
}

fn is_multi_host_mongo_uri(url: &str) -> bool {
    let rest = match url.strip_prefix("mongodb://").or_else(|| url.strip_prefix("mongodb+srv://")) {
        Some(r) => r,
        None => return false,
    };
    let authority = match rest.split('/').next() {
        Some(a) => a,
        None => return false,
    };
    let host_section = match authority.rfind('@') {
        Some(idx) => &authority[idx + 1..],
        None => authority,
    };
    host_section.contains(',')
}

fn mongo_uri_has_direct_connection_true(uri: &str) -> bool {
    uri.split_once('?')
        .map(|(_, query)| {
            query.split('#').next().unwrap_or("").split('&').any(mongo_url_param_is_direct_connection_true)
        })
        .unwrap_or(false)
}

fn mongo_url_param_is_direct_connection_true(part: &str) -> bool {
    let Some((key, value)) = part.split_once('=') else {
        return false;
    };
    percent_decode_str(key).decode_utf8_lossy().eq_ignore_ascii_case("directConnection")
        && percent_decode_str(value).decode_utf8_lossy().eq_ignore_ascii_case("true")
}

pub async fn test_connection(client: &Client, timeout: Duration, database: Option<&str>) -> Result<(), String> {
    let database = database.map(str::trim).filter(|value| !value.is_empty()).unwrap_or("admin");
    let client = client.clone();
    let database = database.to_string();
    with_connection_timeout("MongoDB", timeout, async move {
        client
            .database(&database)
            .run_command(doc! { "ping": 1 })
            .await
            .map(|_| ())
            .map_err(|e| format!("MongoDB connection failed: {e}"))
    })
    .await
}

pub async fn server_version(client: &Client, database: &str) -> Result<String, String> {
    let database = database.trim();
    let database = if database.is_empty() { "admin" } else { database };
    let result = client.database(database).run_command(doc! { "buildInfo": 1 }).await.map_err(|e| e.to_string())?;
    server_version_from_build_info(&result)
}

fn server_version_from_build_info(result: &Document) -> Result<String, String> {
    result.get_str("version").map(str::to_string).map_err(|e| format!("MongoDB server version not found: {e}"))
}

pub async fn list_databases(client: &Client) -> Result<Vec<String>, String> {
    client.list_database_names().await.map_err(|e| e.to_string())
}

pub async fn list_collections(client: &Client, database: &str) -> Result<Vec<String>, String> {
    client.database(database).list_collection_names().await.map_err(|e| e.to_string())
}

pub async fn create_database(client: &Client, database: &str) -> Result<(), String> {
    let database = database.trim();
    if database.is_empty() {
        return Err("Database name is required".to_string());
    }
    client.database(database).create_collection("dbx_init").await.map_err(|e| e.to_string())
}

pub async fn drop_database(client: &Client, database: &str) -> Result<(), String> {
    let database = database.trim();
    if database.is_empty() {
        return Err("Database name is required".to_string());
    }
    client.database(database).drop().await.map_err(|e| e.to_string())
}

pub async fn drop_collection(client: &Client, database: &str, collection: &str) -> Result<(), String> {
    let database = database.trim();
    let collection = collection.trim();
    if database.is_empty() {
        return Err("Database name is required".to_string());
    }
    if collection.is_empty() {
        return Err("Collection name is required".to_string());
    }
    client.database(database).collection::<Document>(collection).drop().await.map_err(|e| e.to_string())
}

pub async fn list_indexes(client: &Client, database: &str, collection: &str) -> Result<Vec<IndexInfo>, String> {
    let col = client.database(database).collection::<Document>(collection);
    let mut cursor = col.list_indexes().await.map_err(|e| e.to_string())?;
    let mut indexes = Vec::new();
    while let Some(model) = cursor.try_next().await.map_err(|e| e.to_string())? {
        indexes.push(index_info_from_model(model));
    }
    Ok(indexes)
}

fn index_info_from_model(model: IndexModel) -> IndexInfo {
    let name = model.options.as_ref().and_then(|options| options.name.clone()).unwrap_or_else(|| {
        model.keys.iter().map(|(field, value)| format!("{field}_{value}")).collect::<Vec<_>>().join("_")
    });
    let columns = model.keys.keys().cloned().collect::<Vec<_>>();
    let index_type = if model.keys.is_empty() {
        None
    } else {
        Some(model.keys.iter().map(|(field, value)| format!("{field}: {value}")).collect::<Vec<_>>().join(", "))
    };
    let filter = model
        .options
        .as_ref()
        .and_then(|options| options.partial_filter_expression.as_ref())
        .map(|filter| bson_to_json(&Bson::Document(filter.clone())).to_string());
    IndexInfo {
        is_unique: model.options.as_ref().and_then(|options| options.unique).unwrap_or(false),
        is_primary: name == "_id_",
        name,
        columns,
        filter,
        index_type,
        included_columns: None,
        comment: None,
    }
}

pub async fn find_documents(
    client: &Client,
    database: &str,
    collection: &str,
    skip: u64,
    limit: i64,
    filter: Option<&str>,
    projection: Option<&str>,
    sort: Option<&str>,
) -> Result<MongoDocumentResult, String> {
    let col = client.database(database).collection::<Document>(collection);

    let filter_doc: Document = match filter {
        Some(f) if !f.trim().is_empty() => {
            let json: serde_json::Value = serde_json::from_str(f).map_err(|e| format!("Invalid filter JSON: {e}"))?;
            json_filter_to_document(&json)?
        }
        _ => doc! {},
    };

    let total = if filter_doc.is_empty() {
        col.estimated_document_count().await.map_err(|e| e.to_string())?
    } else {
        col.count_documents(filter_doc.clone()).await.map_err(|e| e.to_string())?
    };

    let mut find = col.find(filter_doc).skip(skip).limit(limit);
    if let Some(p) = projection {
        if !p.trim().is_empty() {
            let json: serde_json::Value =
                serde_json::from_str(p).map_err(|e| format!("Invalid projection JSON: {e}"))?;
            let projection_doc = json_object_to_document(&json).map_err(|e| format!("Invalid projection: {e}"))?;
            find = find.projection(projection_doc);
        }
    }
    if let Some(s) = sort {
        if !s.trim().is_empty() {
            let json: serde_json::Value = serde_json::from_str(s).map_err(|e| format!("Invalid sort JSON: {e}"))?;
            let sort_doc = json_object_to_document(&json).map_err(|e| format!("Invalid sort: {e}"))?;
            find = find.sort(sort_doc);
        }
    }

    let mut cursor = find.await.map_err(|e| e.to_string())?;

    let mut documents = Vec::new();
    while cursor.advance().await.map_err(|e| e.to_string())? {
        let doc = cursor.deserialize_current().map_err(|e| e.to_string())?;
        documents.push(bson_to_json(&Bson::Document(doc)));
    }

    Ok(MongoDocumentResult { documents, total })
}

/// Find MongoDB documents as relaxed Extended JSON for MongoDB transfer paths.
#[allow(clippy::too_many_arguments)]
pub async fn find_documents_extended_json(
    client: &Client,
    database: &str,
    collection: &str,
    skip: u64,
    limit: i64,
    filter: Option<&str>,
    projection: Option<&str>,
    sort: Option<&str>,
) -> Result<MongoDocumentResult, String> {
    let col = client.database(database).collection::<Document>(collection);

    let filter_doc: Document = match filter {
        Some(f) if !f.trim().is_empty() => {
            let json: serde_json::Value = serde_json::from_str(f).map_err(|e| format!("Invalid filter JSON: {e}"))?;
            json_filter_to_document(&json)?
        }
        _ => doc! {},
    };

    let total = if filter_doc.is_empty() {
        col.estimated_document_count().await.map_err(|e| e.to_string())?
    } else {
        col.count_documents(filter_doc.clone()).await.map_err(|e| e.to_string())?
    };

    let mut find = col.find(filter_doc).skip(skip).limit(limit);
    if let Some(p) = projection {
        if !p.trim().is_empty() {
            let json: serde_json::Value =
                serde_json::from_str(p).map_err(|e| format!("Invalid projection JSON: {e}"))?;
            let projection_doc = json_object_to_document(&json).map_err(|e| format!("Invalid projection: {e}"))?;
            find = find.projection(projection_doc);
        }
    }
    if let Some(s) = sort {
        if !s.trim().is_empty() {
            let json: serde_json::Value = serde_json::from_str(s).map_err(|e| format!("Invalid sort JSON: {e}"))?;
            let sort_doc = json_object_to_document(&json).map_err(|e| format!("Invalid sort: {e}"))?;
            find = find.sort(sort_doc);
        }
    }

    let mut cursor = find.await.map_err(|e| e.to_string())?;

    let mut documents = Vec::new();
    while cursor.advance().await.map_err(|e| e.to_string())? {
        let doc = cursor.deserialize_current().map_err(|e| e.to_string())?;
        documents.push(Bson::Document(doc).into_relaxed_extjson());
    }

    Ok(MongoDocumentResult { documents, total })
}

pub async fn aggregate_documents(
    client: &Client,
    database: &str,
    collection: &str,
    pipeline_json: &str,
    max_rows: Option<usize>,
) -> Result<MongoDocumentResult, String> {
    let json: serde_json::Value =
        serde_json::from_str(pipeline_json).map_err(|e| format!("Invalid pipeline JSON: {e}"))?;
    let pipeline_values = json.as_array().ok_or_else(|| "Aggregate pipeline must be a JSON array".to_string())?;
    let pipeline = pipeline_values
        .iter()
        .map(|value| json_object_to_document(value).map_err(|e| format!("Invalid pipeline stage: {e}")))
        .collect::<Result<Vec<Document>, String>>()?;
    let col = client.database(database).collection::<Document>(collection);
    let mut cursor = col.aggregate(pipeline).await.map_err(|e| e.to_string())?;
    let max_rows = max_rows.unwrap_or(100);
    let fetch_limit = max_rows.saturating_add(1);
    let mut documents = Vec::new();
    while documents.len() < fetch_limit && cursor.advance().await.map_err(|e| e.to_string())? {
        let doc = cursor.deserialize_current().map_err(|e| e.to_string())?;
        documents.push(bson_to_json(&Bson::Document(doc)));
    }
    let total = documents.len() as u64;
    if documents.len() > max_rows {
        documents.truncate(max_rows);
    }
    Ok(MongoDocumentResult { documents, total })
}

pub async fn create_index(
    client: &Client,
    database: &str,
    collection: &str,
    keys_json: &str,
    options_json: Option<&str>,
) -> Result<String, String> {
    let keys_value: serde_json::Value =
        serde_json::from_str(keys_json).map_err(|e| format!("Invalid index keys JSON: {e}"))?;
    let keys = json_object_to_document(&keys_value).map_err(|e| format!("Invalid index keys: {e}"))?;
    if keys.is_empty() {
        return Err("Index keys are required".to_string());
    }

    let options = match options_json.map(str::trim).filter(|json| !json.is_empty()) {
        Some(json) => {
            let value: serde_json::Value =
                serde_json::from_str(json).map_err(|e| format!("Invalid index options JSON: {e}"))?;
            let doc = json_object_to_document(&value).map_err(|e| format!("Invalid index options: {e}"))?;
            Some(mongodb::bson::from_document::<IndexOptions>(doc).map_err(|e| format!("Invalid index options: {e}"))?)
        }
        None => None,
    };

    let col = client.database(database).collection::<Document>(collection);
    let result =
        col.create_index(IndexModel::builder().keys(keys).options(options).build()).await.map_err(|e| e.to_string())?;
    Ok(result.index_name)
}

pub async fn drop_indexes(
    client: &Client,
    database: &str,
    collection: &str,
    indexes_json: Option<&str>,
    single: bool,
) -> Result<MongoDropIndexesResult, String> {
    let database = database.trim();
    let collection = collection.trim();
    if database.is_empty() {
        return Err("Database name is required".to_string());
    }
    if collection.is_empty() {
        return Err("Collection name is required".to_string());
    }

    let index = parse_drop_indexes_value(indexes_json, single)?;
    let before = list_indexes(client, database, collection).await?;
    client
        .database(database)
        .run_command(doc! { "dropIndexes": collection, "index": index })
        .await
        .map_err(|e| e.to_string())?;
    let after = list_indexes(client, database, collection).await?;
    let dropped_names = diff_dropped_index_names(&before, &after);
    Ok(MongoDropIndexesResult { affected_rows: dropped_names.len() as u64, dropped_names })
}

fn diff_dropped_index_names(before: &[IndexInfo], after: &[IndexInfo]) -> Vec<String> {
    let remaining = after.iter().map(|index| index.name.as_str()).collect::<HashSet<_>>();
    before.iter().filter(|index| !remaining.contains(index.name.as_str())).map(|index| index.name.clone()).collect()
}

fn parse_drop_indexes_value(indexes_json: Option<&str>, single: bool) -> Result<Bson, String> {
    match indexes_json.map(str::trim).filter(|value| !value.is_empty()) {
        Some(json) => parse_drop_indexes_json(json, single),
        None if single => Err("dropIndex requires a string index name or JSON document".to_string()),
        None => Ok(Bson::String("*".to_string())),
    }
}

fn parse_drop_indexes_json(json: &str, single: bool) -> Result<Bson, String> {
    let value: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("Invalid index JSON: {e}"))?;
    if single {
        validate_single_drop_index_value(&value)?;
    } else {
        validate_multi_drop_indexes_value(&value)?;
    }
    Ok(json_value_to_bson(&value))
}

fn validate_single_drop_index_value(value: &serde_json::Value) -> Result<(), String> {
    match value {
        serde_json::Value::String(name) => {
            if name.trim().is_empty() {
                Err("Index name is required".to_string())
            } else if name == "*" {
                Err(r#"dropIndex does not accept "*"; use dropIndexes() or dropIndexes("*") instead"#.to_string())
            } else {
                Ok(())
            }
        }
        serde_json::Value::Object(doc) if doc.is_empty() => Err("Index specification is required".to_string()),
        serde_json::Value::Object(_) => Ok(()),
        serde_json::Value::Array(_) => {
            Err("dropIndex only accepts a string index name or JSON document; arrays are not supported".to_string())
        }
        _ => Err("dropIndex only accepts a string index name or JSON document".to_string()),
    }
}

fn validate_multi_drop_indexes_value(value: &serde_json::Value) -> Result<(), String> {
    match value {
        serde_json::Value::String(name) => {
            if name.trim().is_empty() {
                Err("Index name is required".to_string())
            } else {
                Ok(())
            }
        }
        serde_json::Value::Object(doc) if doc.is_empty() => Err("Index specification is required".to_string()),
        serde_json::Value::Object(_) => Ok(()),
        serde_json::Value::Array(items) if items.is_empty() => {
            Err("dropIndexes only accepts non-empty string arrays".to_string())
        }
        serde_json::Value::Array(items) => {
            if items.iter().all(|item| matches!(item, serde_json::Value::String(name) if !name.trim().is_empty())) {
                Ok(())
            } else {
                Err("dropIndexes only accepts arrays of string index names".to_string())
            }
        }
        _ => Err("dropIndexes only accepts a string index name, JSON document, or string array".to_string()),
    }
}

pub async fn insert_document(
    client: &Client,
    database: &str,
    collection: &str,
    doc_json: &str,
) -> Result<String, String> {
    let value: serde_json::Value = serde_json::from_str(doc_json).map_err(|e| format!("Invalid JSON: {e}"))?;
    let doc = json_object_to_document(&value).map_err(|e| format!("Invalid document: {e}"))?;
    let col = client.database(database).collection::<Document>(collection);
    let result = col.insert_one(doc).await.map_err(|e| e.to_string())?;
    Ok(format!("{}", result.inserted_id))
}

pub async fn insert_documents(
    client: &Client,
    database: &str,
    collection: &str,
    docs_json: &str,
) -> Result<u64, String> {
    let json: serde_json::Value = serde_json::from_str(docs_json).map_err(|e| format!("Invalid JSON: {e}"))?;
    let docs = match json {
        serde_json::Value::Array(values) => values
            .into_iter()
            .map(|value| json_object_to_document(&value).map_err(|e| format!("Invalid document: {e}")))
            .collect::<Result<Vec<Document>, String>>()?,
        value => vec![json_object_to_document(&value).map_err(|e| format!("Invalid document: {e}"))?],
    };
    if docs.is_empty() {
        return Ok(0);
    }
    let col = client.database(database).collection::<Document>(collection);
    let result = col.insert_many(docs).await.map_err(|e| e.to_string())?;
    Ok(result.inserted_ids.len() as u64)
}

pub async fn insert_documents_extended_json(
    client: &Client,
    database: &str,
    collection: &str,
    docs_json: &str,
) -> Result<u64, String> {
    let json: serde_json::Value = serde_json::from_str(docs_json).map_err(|e| format!("Invalid JSON: {e}"))?;
    let docs = match json {
        serde_json::Value::Array(values) => values
            .into_iter()
            .map(|value| json_object_to_document_extended_json(&value).map_err(|e| format!("Invalid document: {e}")))
            .collect::<Result<Vec<Document>, String>>()?,
        value => vec![json_object_to_document_extended_json(&value).map_err(|e| format!("Invalid document: {e}"))?],
    };
    if docs.is_empty() {
        return Ok(0);
    }
    let col = client.database(database).collection::<Document>(collection);
    let result = col.insert_many(docs).await.map_err(|e| e.to_string())?;
    Ok(result.inserted_ids.len() as u64)
}

pub async fn update_document(
    client: &Client,
    database: &str,
    collection: &str,
    id: &str,
    doc_json: &str,
) -> Result<u64, String> {
    let value: serde_json::Value = serde_json::from_str(doc_json).map_err(|e| format!("Invalid JSON: {e}"))?;
    let col = client.database(database).collection::<Document>(collection);
    let update_doc = json_object_to_document(&value).map_err(|e| format!("Invalid document: {e}"))?;
    if is_update_operator_document(&update_doc) {
        for filter in document_id_filters(id) {
            let result = col.update_one(filter, update_doc.clone()).await.map_err(|e| e.to_string())?;
            if result.matched_count > 0 {
                return Ok(result.modified_count);
            }
        }
        return Ok(0);
    }

    for filter in document_id_filters(id) {
        let current = col.find_one(filter.clone()).await.map_err(|e| e.to_string())?;
        let mut new_doc = json_object_to_document_preserving_existing(&value, current.as_ref())
            .map_err(|e| format!("Invalid document: {e}"))?;
        new_doc.remove("_id");
        let result = col.replace_one(filter, new_doc.clone()).await.map_err(|e| e.to_string())?;
        if result.matched_count > 0 {
            return Ok(result.modified_count);
        }
    }
    Ok(0)
}

fn is_update_operator_document(doc: &Document) -> bool {
    !doc.is_empty() && doc.keys().all(|key| key.starts_with('$'))
}

pub async fn update_documents(
    client: &Client,
    database: &str,
    collection: &str,
    filter_json: &str,
    update_json: &str,
    many: bool,
) -> Result<u64, String> {
    let filter_value: serde_json::Value =
        serde_json::from_str(filter_json).map_err(|e| format!("Invalid filter JSON: {e}"))?;
    let update_value: serde_json::Value =
        serde_json::from_str(update_json).map_err(|e| format!("Invalid update JSON: {e}"))?;
    let filter = json_filter_to_document(&filter_value).map_err(|e| format!("Invalid filter: {e}"))?;
    let update = json_object_to_document(&update_value).map_err(|e| format!("Invalid update: {e}"))?;
    let col = client.database(database).collection::<Document>(collection);
    let result = if many {
        col.update_many(filter, update).await.map_err(|e| e.to_string())?
    } else {
        col.update_one(filter, update).await.map_err(|e| e.to_string())?
    };
    Ok(result.modified_count)
}

pub async fn delete_document(client: &Client, database: &str, collection: &str, id: &str) -> Result<u64, String> {
    let col = client.database(database).collection::<Document>(collection);
    for filter in document_id_filters(id) {
        let result = col.delete_one(filter).await.map_err(|e| e.to_string())?;
        if result.deleted_count > 0 {
            return Ok(result.deleted_count);
        }
    }
    Ok(0)
}

fn document_id_filters(id: &str) -> Vec<Document> {
    let string_filter = doc! { "_id": Bson::String(id.to_string()) };
    match ObjectId::parse_str(id) {
        Ok(oid) => vec![doc! { "_id": Bson::ObjectId(oid) }, string_filter],
        Err(_) => vec![string_filter],
    }
}

pub async fn delete_documents(
    client: &Client,
    database: &str,
    collection: &str,
    filter_json: &str,
    many: bool,
) -> Result<u64, String> {
    let filter_value: serde_json::Value =
        serde_json::from_str(filter_json).map_err(|e| format!("Invalid filter JSON: {e}"))?;
    let filter = json_filter_to_document(&filter_value).map_err(|e| format!("Invalid filter: {e}"))?;
    let col = client.database(database).collection::<Document>(collection);
    let result = if many {
        col.delete_many(filter).await.map_err(|e| e.to_string())?
    } else {
        col.delete_one(filter).await.map_err(|e| e.to_string())?
    };
    Ok(result.deleted_count)
}

fn bson_to_json(bson: &Bson) -> serde_json::Value {
    match bson {
        Bson::Double(v) => serde_json::json!(v),
        Bson::String(v) => serde_json::Value::String(v.clone()),
        Bson::Boolean(v) => serde_json::Value::Bool(*v),
        Bson::Null => serde_json::Value::Null,
        Bson::Int32(v) => serde_json::json!(v),
        Bson::Int64(v) => super::safe_i64_to_json(*v),
        Bson::ObjectId(oid) => serde_json::Value::String(oid.to_hex()),
        Bson::DateTime(dt) => serde_json::Value::String(format!(
            "ISODate(\"{}\")",
            dt.try_to_rfc3339_string().unwrap_or_else(|_| dt.to_string())
        )),
        Bson::Array(arr) => serde_json::Value::Array(arr.iter().map(bson_to_json).collect()),
        Bson::Document(doc) => {
            let mut map = serde_json::Map::new();
            for (k, v) in doc {
                map.insert(k.clone(), bson_to_json(v));
            }
            serde_json::Value::Object(map)
        }
        _ => serde_json::Value::String(format!("{bson}")),
    }
}

/// Convert a `serde_json::Value` (JSON object) to a BSON `Document`,
/// handling MongoDB extended JSON conventions such as `{"$oid":"..."}`.
pub fn json_object_to_document(value: &serde_json::Value) -> Result<Document, String> {
    match json_value_to_bson(value) {
        Bson::Document(doc) => Ok(doc),
        other => Err(format!("Expected a JSON object, got {other:?}")),
    }
}

fn json_object_to_document_extended_json(value: &serde_json::Value) -> Result<Document, String> {
    match Bson::try_from(value.clone()).map_err(|e| e.to_string())? {
        Bson::Document(doc) => Ok(doc),
        other => Err(format!("Expected a JSON object, got {other:?}")),
    }
}

fn json_object_to_document_preserving_existing(
    value: &serde_json::Value,
    existing: Option<&Document>,
) -> Result<Document, String> {
    match (value, existing) {
        (serde_json::Value::Object(obj), Some(existing)) => Ok(obj
            .iter()
            .map(|(key, value)| {
                let bson = existing
                    .get(key)
                    .map(|existing_bson| json_value_to_bson_preserving_existing(value, existing_bson))
                    .unwrap_or_else(|| json_value_to_bson(value));
                (key.clone(), bson)
            })
            .collect()),
        _ => json_object_to_document(value),
    }
}

pub fn json_filter_to_document(value: &serde_json::Value) -> Result<Document, String> {
    match json_filter_value_to_bson(value, None) {
        Bson::Document(doc) => Ok(doc),
        other => Err(format!("Expected a JSON object, got {other:?}")),
    }
}

fn json_value_to_bson_preserving_existing(value: &serde_json::Value, existing: &Bson) -> Bson {
    if &bson_to_json(existing) == value {
        return existing.clone();
    }

    match (value, existing) {
        (serde_json::Value::Array(values), Bson::Array(existing_values)) => Bson::Array(
            values
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    existing_values
                        .get(index)
                        .map(|existing_item| json_value_to_bson_preserving_existing(item, existing_item))
                        .unwrap_or_else(|| json_value_to_bson(item))
                })
                .collect(),
        ),
        (serde_json::Value::Object(obj), Bson::Document(existing_doc)) => Bson::Document(
            obj.iter()
                .map(|(key, item)| {
                    let bson = existing_doc
                        .get(key)
                        .map(|existing_item| json_value_to_bson_preserving_existing(item, existing_item))
                        .unwrap_or_else(|| json_value_to_bson(item));
                    (key.clone(), bson)
                })
                .collect(),
        ),
        _ => json_value_to_bson(value),
    }
}

fn json_value_to_bson(value: &serde_json::Value) -> Bson {
    match value {
        serde_json::Value::Null => Bson::Null,
        serde_json::Value::Bool(b) => Bson::Boolean(*b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Bson::Int64(i)
            } else if let Some(f) = n.as_f64() {
                Bson::Double(f)
            } else {
                Bson::Null
            }
        }
        serde_json::Value::String(s) => {
            parse_mongo_shell_date(s).map(Bson::DateTime).unwrap_or_else(|| Bson::String(s.clone()))
        }
        serde_json::Value::Array(arr) => Bson::Array(arr.iter().map(json_value_to_bson).collect()),
        serde_json::Value::Object(obj) => {
            // Extended JSON: {"$oid":"..."} → BSON ObjectId
            if obj.len() == 1 {
                if let Some(serde_json::Value::String(hex)) = obj.get("$oid") {
                    if let Ok(oid) = ObjectId::parse_str(hex) {
                        return Bson::ObjectId(oid);
                    }
                }
                if let Some(date) = parse_extended_json_date(obj) {
                    return Bson::DateTime(date);
                }
            }
            let doc: Document = obj.iter().map(|(k, v)| (k.clone(), json_value_to_bson(v))).collect();
            Bson::Document(doc)
        }
    }
}

fn parse_mongo_shell_date(value: &str) -> Option<DateTime> {
    let trimmed = value.trim();
    if let Some(inner) = trimmed.strip_prefix("ISODate(").or_else(|| trimmed.strip_prefix("new Date(")) {
        let inner = inner.strip_suffix(')')?.trim();
        let quoted = inner
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .or_else(|| inner.strip_prefix('\'').and_then(|value| value.strip_suffix('\'')))?;
        return DateTime::parse_rfc3339_str(quoted).ok();
    }
    parse_legacy_mongo_date_display(trimmed)
}

fn parse_legacy_mongo_date_display(value: &str) -> Option<DateTime> {
    let (date, time) = value.split_once(' ').or_else(|| value.split_once('T'))?;
    if date.len() != 10 || time.len() < 8 || time.len() > 12 {
        return None;
    }
    if !date
        .chars()
        .enumerate()
        .all(|(index, ch)| matches!(index, 4 | 7) && ch == '-' || !matches!(index, 4 | 7) && ch.is_ascii_digit())
    {
        return None;
    }
    let (seconds, millis) = time.split_once('.').unwrap_or((time, "000"));
    if seconds.len() != 8 || millis.is_empty() || millis.len() > 3 {
        return None;
    }
    if !seconds
        .chars()
        .enumerate()
        .all(|(index, ch)| matches!(index, 2 | 5) && ch == ':' || !matches!(index, 2 | 5) && ch.is_ascii_digit())
    {
        return None;
    }
    if !millis.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    DateTime::parse_rfc3339_str(format!("{date}T{seconds}.{}Z", format!("{millis:0<3}"))).ok()
}

fn parse_extended_json_date(obj: &serde_json::Map<String, serde_json::Value>) -> Option<DateTime> {
    match obj.get("$date")? {
        serde_json::Value::String(value) => DateTime::parse_rfc3339_str(value).ok(),
        serde_json::Value::Number(value) => value.as_i64().map(DateTime::from_millis),
        serde_json::Value::Object(inner) if inner.len() == 1 => match inner.get("$numberLong") {
            Some(serde_json::Value::String(value)) => value.parse::<i64>().ok().map(DateTime::from_millis),
            Some(serde_json::Value::Number(value)) => value.as_i64().map(DateTime::from_millis),
            _ => None,
        },
        _ => None,
    }
}

fn json_filter_value_to_bson(value: &serde_json::Value, field_name: Option<&str>) -> Bson {
    if field_name == Some("_id") {
        if let Some(id) = value.as_str() {
            return id_equality_bson(id);
        }
    }

    match value {
        serde_json::Value::Array(arr) => {
            Bson::Array(arr.iter().map(|item| json_filter_value_to_bson(item, None)).collect())
        }
        serde_json::Value::Object(obj) => {
            if obj.len() == 1 {
                if let Some(serde_json::Value::String(hex)) = obj.get("$oid") {
                    if let Ok(oid) = ObjectId::parse_str(hex) {
                        return Bson::ObjectId(oid);
                    }
                }
            }

            if field_name == Some("_id") && obj.keys().all(|key| key.starts_with('$')) {
                let mut doc = Document::new();
                for (key, item) in obj {
                    match key.as_str() {
                        "$eq" => {
                            if let Some(id) = item.as_str() {
                                doc.insert("$in", object_id_string_variants(id));
                            } else {
                                doc.insert(key, json_filter_value_to_bson(item, None));
                            }
                        }
                        "$ne" => {
                            if let Some(id) = item.as_str() {
                                doc.insert("$nin", object_id_string_variants(id));
                            } else {
                                doc.insert(key, json_filter_value_to_bson(item, None));
                            }
                        }
                        "$in" | "$nin" => {
                            if let Some(items) = item.as_array() {
                                doc.insert(key, expand_object_id_string_array(items));
                            } else {
                                doc.insert(key, json_filter_value_to_bson(item, None));
                            }
                        }
                        _ => {
                            doc.insert(key, json_filter_value_to_bson(item, None));
                        }
                    }
                }
                return Bson::Document(doc);
            }

            let doc: Document = obj.iter().map(|(k, v)| (k.clone(), json_filter_value_to_bson(v, Some(k)))).collect();
            Bson::Document(doc)
        }
        _ => json_value_to_bson(value),
    }
}

fn id_equality_bson(id: &str) -> Bson {
    let variants = object_id_string_variants(id);
    if variants.len() == 1 {
        variants.into_iter().next().unwrap_or(Bson::String(id.to_string()))
    } else {
        Bson::Document(doc! { "$in": variants })
    }
}

fn object_id_string_variants(id: &str) -> Vec<Bson> {
    match ObjectId::parse_str(id) {
        Ok(oid) => vec![Bson::ObjectId(oid), Bson::String(id.to_string())],
        Err(_) => vec![Bson::String(id.to_string())],
    }
}

fn expand_object_id_string_array(items: &[serde_json::Value]) -> Bson {
    let mut values = Vec::new();
    for item in items {
        if let Some(id) = item.as_str() {
            values.extend(object_id_string_variants(id));
        } else {
            values.push(json_filter_value_to_bson(item, None));
        }
    }
    Bson::Array(values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multi_seed_uri_removes_direct_connection_true_before_driver_parse() {
        let uri =
            "mongodb://read:pass@host1:27017,host2:27017/admin?directConnection=true&replicaSet=rs0&authSource=admin";

        let normalized = normalize_mongo_uri_direct_connection(uri);

        assert_eq!(normalized, "mongodb://read:pass@host1:27017,host2:27017/admin?replicaSet=rs0&authSource=admin");
    }

    #[test]
    fn multi_seed_uri_removes_encoded_direct_connection_true_and_keeps_fragment() {
        let uri = "mongodb://host1:27017,host2:27017/admin?authSource=admin&direct%43onnection=TRUE#read";

        let normalized = normalize_mongo_uri_direct_connection(uri);

        assert_eq!(normalized, "mongodb://host1:27017,host2:27017/admin?authSource=admin#read");
    }

    #[test]
    fn single_seed_uri_keeps_direct_connection_true() {
        let uri = "mongodb://host1:27017/admin?directConnection=true&authSource=admin";

        let normalized = normalize_mongo_uri_direct_connection(uri);

        assert_eq!(normalized, uri);
    }

    #[test]
    fn multi_seed_uri_keeps_direct_connection_false() {
        let uri = "mongodb://host1:27017,host2:27017/admin?directConnection=false&replicaSet=rs0";

        let normalized = normalize_mongo_uri_direct_connection(uri);

        assert_eq!(normalized, uri);
    }

    #[test]
    fn document_id_filters_try_object_id_then_string_for_hex_ids() {
        let id = "507f1f77bcf86cd799439011";
        let filters = document_id_filters(id);

        assert_eq!(filters.len(), 2);
        assert!(matches!(filters[0].get("_id"), Some(Bson::ObjectId(_))));
        assert!(matches!(filters[1].get("_id"), Some(Bson::String(value)) if value == id));
    }

    #[test]
    fn document_id_filters_use_string_only_for_non_hex_ids() {
        let id = "customer-42";
        let filters = document_id_filters(id);

        assert_eq!(filters.len(), 1);
        assert!(matches!(filters[0].get("_id"), Some(Bson::String(value)) if value == id));
    }

    #[test]
    fn json_filter_to_document_matches_object_id_and_string_for_id_hex() {
        let id = "507f1f77bcf86cd799439011";
        let filter = serde_json::json!({ "_id": id });
        let doc = json_filter_to_document(&filter).unwrap();

        let Some(Bson::Document(id_filter)) = doc.get("_id") else {
            panic!("expected _id operator document");
        };
        let Some(Bson::Array(values)) = id_filter.get("$in") else {
            panic!("expected _id $in variants");
        };
        assert!(matches!(values.first(), Some(Bson::ObjectId(_))));
        assert!(matches!(values.get(1), Some(Bson::String(value)) if value == id));
    }

    #[test]
    fn json_filter_to_document_expands_id_operator_variants() {
        let id = "507f1f77bcf86cd799439011";
        let filter = serde_json::json!({ "$and": [{ "_id": { "$eq": id } }] });
        let doc = json_filter_to_document(&filter).unwrap();

        let Some(Bson::Array(and_items)) = doc.get("$and") else {
            panic!("expected $and array");
        };
        let Some(Bson::Document(first)) = and_items.first() else {
            panic!("expected first $and document");
        };
        let Some(Bson::Document(id_filter)) = first.get("_id") else {
            panic!("expected _id operator document");
        };
        assert!(matches!(id_filter.get("$in"), Some(Bson::Array(values)) if values.len() == 2));
    }

    #[test]
    fn json_filter_to_document_leaves_non_id_hex_strings_alone() {
        let id = "507f1f77bcf86cd799439011";
        let filter = serde_json::json!({ "owner_id": id });
        let doc = json_filter_to_document(&filter).unwrap();

        assert!(matches!(doc.get("owner_id"), Some(Bson::String(value)) if value == id));
    }

    #[test]
    fn bson_to_json_displays_date_as_mongo_isodate() {
        let date = DateTime::parse_rfc3339_str("2026-06-10T13:59:31.287Z").unwrap();
        let value = bson_to_json(&Bson::DateTime(date));

        assert_eq!(value, serde_json::json!("ISODate(\"2026-06-10T13:59:31.287Z\")"));
    }

    #[test]
    fn bson_to_json_preserves_unsafe_int64_for_js() {
        let value = bson_to_json(&Bson::Int64(2_326_645_729_978_441_729));

        assert_eq!(value, serde_json::json!("2326645729978441729"));
    }

    #[test]
    fn bson_to_json_keeps_safe_int64_as_number() {
        let value = bson_to_json(&Bson::Int64(42));

        assert_eq!(value, serde_json::json!(42));
    }

    #[test]
    fn bson_to_json_displays_object_id_as_string() {
        let oid = ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap();
        let value = bson_to_json(&Bson::ObjectId(oid));

        assert_eq!(value, serde_json::json!("507f1f77bcf86cd799439011"));
    }

    #[test]
    fn bson_to_extended_json_preserves_nested_object_ids() {
        let oid = ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap();
        let nested_oid = ObjectId::parse_str("507f191e810c19729de860ea").unwrap();
        let value = Bson::Document(doc! {
            "_id": Bson::ObjectId(oid),
            "owner": { "id": Bson::ObjectId(nested_oid) },
            "tags": [Bson::ObjectId(nested_oid)],
        })
        .into_relaxed_extjson();

        assert_eq!(
            value,
            serde_json::json!({
                "_id": { "$oid": "507f1f77bcf86cd799439011" },
                "owner": { "id": { "$oid": "507f191e810c19729de860ea" } },
                "tags": [{ "$oid": "507f191e810c19729de860ea" }],
            })
        );
    }

    #[test]
    fn index_info_from_model_maps_mongodb_index_metadata() {
        let model = IndexModel::builder()
            .keys(doc! { "tenant_id": 1, "created_at": -1 })
            .options(
                IndexOptions::builder()
                    .name("tenant_created_idx".to_string())
                    .unique(true)
                    .partial_filter_expression(doc! { "archived": false })
                    .build(),
            )
            .build();

        let index = index_info_from_model(model);

        assert_eq!(index.name, "tenant_created_idx");
        assert_eq!(index.columns, vec!["tenant_id", "created_at"]);
        assert!(index.is_unique);
        assert!(!index.is_primary);
        assert_eq!(index.index_type.as_deref(), Some("tenant_id: 1, created_at: -1"));
        assert_eq!(index.filter.as_deref(), Some("{\"archived\":false}"));
    }

    #[test]
    fn index_info_from_model_marks_default_id_index_as_primary() {
        let model = IndexModel::builder()
            .keys(doc! { "_id": 1 })
            .options(IndexOptions::builder().name("_id_".to_string()).unique(true).build())
            .build();

        let index = index_info_from_model(model);

        assert_eq!(index.columns, vec!["_id"]);
        assert!(index.is_unique);
        assert!(index.is_primary);
    }

    #[test]
    fn parse_drop_indexes_value_validates_drop_index_arguments() {
        assert!(matches!(
            parse_drop_indexes_value(Some(r#""users_email_unique""#), true),
            Ok(Bson::String(name)) if name == "users_email_unique"
        ));
        assert!(matches!(
            parse_drop_indexes_value(Some(r#"{"email":1}"#), true),
            Ok(Bson::Document(doc)) if doc.get_i64("email").ok() == Some(1)
        ));

        let wildcard = parse_drop_indexes_value(Some(r#""*""#), true).unwrap_err();
        assert!(wildcard.contains("dropIndex does not accept"));

        let array = parse_drop_indexes_value(Some(r#"["a_1"]"#), true).unwrap_err();
        assert!(array.contains("arrays are not supported"));

        let empty = parse_drop_indexes_value(None, true).unwrap_err();
        assert!(empty.contains("dropIndex requires"));
    }

    #[test]
    fn parse_drop_indexes_value_validates_drop_indexes_arguments() {
        assert!(matches!(
            parse_drop_indexes_value(None, false),
            Ok(Bson::String(name)) if name == "*"
        ));
        assert!(matches!(
            parse_drop_indexes_value(Some(r#""*""#), false),
            Ok(Bson::String(name)) if name == "*"
        ));
        assert!(matches!(
            parse_drop_indexes_value(Some(r#""users_email_unique""#), false),
            Ok(Bson::String(name)) if name == "users_email_unique"
        ));
        assert!(matches!(
            parse_drop_indexes_value(Some(r#"{"email":1}"#), false),
            Ok(Bson::Document(doc)) if doc.get_i64("email").ok() == Some(1)
        ));
        assert!(matches!(
            parse_drop_indexes_value(Some(r#"["a_1","b_1"]"#), false),
            Ok(Bson::Array(values))
                if values
                    == vec![Bson::String("a_1".to_string()), Bson::String("b_1".to_string())]
        ));

        let invalid_array = parse_drop_indexes_value(Some(r#"[{"a":1}]"#), false).unwrap_err();
        assert!(invalid_array.contains("arrays of string index names"));
    }

    #[test]
    fn diff_dropped_index_names_reports_removed_indexes() {
        let before = vec![
            IndexInfo {
                name: "_id_".to_string(),
                columns: vec!["_id".to_string()],
                is_unique: true,
                is_primary: true,
                filter: None,
                index_type: Some("_id: 1".to_string()),
                included_columns: None,
                comment: None,
            },
            IndexInfo {
                name: "users_email_unique".to_string(),
                columns: vec!["email".to_string()],
                is_unique: true,
                is_primary: false,
                filter: None,
                index_type: Some("email: 1".to_string()),
                included_columns: None,
                comment: None,
            },
            IndexInfo {
                name: "users_status_idx".to_string(),
                columns: vec!["status".to_string()],
                is_unique: false,
                is_primary: false,
                filter: None,
                index_type: Some("status: 1".to_string()),
                included_columns: None,
                comment: None,
            },
        ];
        let after = vec![before[0].clone(), before[2].clone()];

        assert_eq!(diff_dropped_index_names(&before, &after), vec!["users_email_unique".to_string()]);
    }

    #[test]
    fn json_object_to_document_parses_extended_json_date() {
        let value = serde_json::json!({
            "created_at": { "$date": "2026-06-10T13:59:31.287Z" },
            "updated_at": { "$date": { "$numberLong": "1781099971287" } }
        });
        let doc = json_object_to_document(&value).unwrap();

        assert!(matches!(doc.get("created_at"), Some(Bson::DateTime(_))));
        assert!(matches!(
            doc.get("updated_at"),
            Some(Bson::DateTime(value)) if value.timestamp_millis() == 1_781_099_971_287
        ));
    }

    #[test]
    fn json_object_to_document_parses_extended_json_object_id() {
        let value = serde_json::json!({
            "_id": { "$oid": "507f1f77bcf86cd799439011" },
        });
        let doc = json_object_to_document(&value).unwrap();

        assert!(matches!(doc.get("_id"), Some(Bson::ObjectId(oid)) if oid.to_hex() == "507f1f77bcf86cd799439011"));
    }

    #[test]
    fn json_object_to_document_extended_json_parses_official_wrappers() {
        let value = serde_json::json!({
            "_id": { "$oid": "507f1f77bcf86cd799439011" },
            "created_at": { "$date": "2026-06-10T13:59:31.287Z" },
            "count": { "$numberLong": "42" },
        });
        let doc = json_object_to_document_extended_json(&value).unwrap();

        assert!(matches!(doc.get("_id"), Some(Bson::ObjectId(oid)) if oid.to_hex() == "507f1f77bcf86cd799439011"));
        assert!(matches!(doc.get("created_at"), Some(Bson::DateTime(_))));
        assert!(matches!(doc.get("count"), Some(Bson::Int64(42))));
    }

    #[test]
    fn json_object_to_document_parses_find_projection() {
        let value = serde_json::json!({
            "title": 1,
            "_id": 0,
        });
        let doc = json_object_to_document(&value).unwrap();

        assert!(matches!(doc.get("title"), Some(Bson::Int64(1))));
        assert!(matches!(doc.get("_id"), Some(Bson::Int64(0))));
    }

    #[test]
    fn server_version_from_build_info_reads_version_field() {
        let version = server_version_from_build_info(&doc! { "version": "4.4.29" }).unwrap();

        assert_eq!(version, "4.4.29");
    }

    #[test]
    fn server_version_from_build_info_rejects_missing_version() {
        let error = server_version_from_build_info(&doc! { "ok": 1 }).unwrap_err();

        assert!(error.contains("MongoDB server version not found"));
    }

    #[test]
    fn json_object_to_document_parses_mongo_shell_isodate_strings() {
        let value = serde_json::json!({
            "created_at": "ISODate(\"2026-06-10T13:59:31.287Z\")",
            "updated_at": "new Date('2026-06-10T14:59:31.287Z')",
        });
        let doc = json_object_to_document(&value).unwrap();

        assert!(matches!(doc.get("created_at"), Some(Bson::DateTime(_))));
        assert!(matches!(doc.get("updated_at"), Some(Bson::DateTime(_))));
    }

    #[test]
    fn json_object_to_document_parses_legacy_date_display_strings() {
        let value = serde_json::json!({
            "created_at": "2025-08-14 02:25:43.718",
        });
        let doc = json_object_to_document(&value).unwrap();

        assert!(matches!(
            doc.get("created_at"),
            Some(Bson::DateTime(value)) if value.timestamp_millis() == 1_755_138_343_718
        ));
    }

    #[test]
    fn detects_update_operator_documents() {
        assert!(is_update_operator_document(&doc! { "$set": { "name": "Ada" } }));
        assert!(is_update_operator_document(&doc! { "$set": { "name": "Ada" }, "$unset": { "old": "" } }));
        assert!(!is_update_operator_document(&doc! { "name": "Ada" }));
        assert!(!is_update_operator_document(&Document::new()));
    }

    #[test]
    fn json_object_to_document_preserves_unchanged_bson_date_fields() {
        let date = DateTime::parse_rfc3339_str("2026-06-10T13:59:31.287Z").unwrap();
        let existing = doc! {
            "_id": "doc-1",
            "created_at": Bson::DateTime(date),
            "name": "before",
            "profile": {
                "last_seen": Bson::DateTime(date),
                "status": "old",
            },
        };
        let displayed = bson_to_json(&Bson::Document(existing.clone()));
        let mut edited = displayed.as_object().cloned().unwrap();
        edited.insert("name".to_string(), serde_json::json!("after"));
        if let Some(serde_json::Value::Object(profile)) = edited.get_mut("profile") {
            profile.insert("status".to_string(), serde_json::json!("new"));
        }

        let doc =
            json_object_to_document_preserving_existing(&serde_json::Value::Object(edited), Some(&existing)).unwrap();

        assert!(matches!(doc.get("created_at"), Some(Bson::DateTime(value)) if *value == date));
        let Some(Bson::Document(profile)) = doc.get("profile") else {
            panic!("expected profile document");
        };
        assert!(matches!(profile.get("last_seen"), Some(Bson::DateTime(value)) if *value == date));
        assert!(matches!(profile.get("status"), Some(Bson::String(value)) if value == "new"));
    }
}
