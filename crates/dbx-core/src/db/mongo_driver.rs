use mongodb::{
    bson::{doc, oid::ObjectId, Bson, Document},
    options::ClientOptions,
    Client,
};
use serde::{Deserialize, Serialize};

use super::with_connection_timeout;
use crate::types::IndexInfo;
use futures::TryStreamExt;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MongoDocumentResult {
    pub documents: Vec<serde_json::Value>,
    pub total: u64,
}

pub async fn connect(url: &str, timeout: Duration, idle_timeout: Duration) -> Result<Client, String> {
    let is_multi_host = is_multi_host_mongo_uri(url);
    let parse_timeout = if is_multi_host { std::cmp::max(timeout * 2, Duration::from_secs(10)) } else { timeout };

    with_connection_timeout("MongoDB", parse_timeout, async {
        let mut options = ClientOptions::parse(url).await.map_err(|e| format!("MongoDB connection failed: {e}"))?;
        options.connect_timeout = Some(timeout);
        options.server_selection_timeout =
            if is_multi_host { Some(std::cmp::max(timeout * 2, Duration::from_secs(10))) } else { Some(timeout) };
        // Close idle connections before the server-side timeout drops them,
        // preventing "Broken pipe" (os error 32) or "unexpected end of file".
        // 0 means no idle timeout (keep connections alive indefinitely).
        if idle_timeout.as_secs() > 0 {
            options.max_idle_time = Some(idle_timeout);
        }
        Client::with_options(options).map_err(|e| format!("MongoDB connection failed: {e}"))
    })
    .await
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

pub async fn test_connection(client: &Client, _timeout: Duration, database: Option<&str>) -> Result<(), String> {
    let database = database.map(str::trim).filter(|value| !value.is_empty()).unwrap_or("admin");
    client
        .database(database)
        .run_command(doc! { "ping": 1 })
        .await
        .map(|_| ())
        .map_err(|e| format!("MongoDB connection failed: {e}"))
}

pub async fn list_databases(client: &Client) -> Result<Vec<String>, String> {
    client.list_database_names().await.map_err(|e| e.to_string())
}

pub async fn list_collections(client: &Client, database: &str) -> Result<Vec<String>, String> {
    client.database(database).list_collection_names().await.map_err(|e| e.to_string())
}

pub async fn list_indexes(client: &Client, database: &str, collection: &str) -> Result<Vec<IndexInfo>, String> {
    let col = client.database(database).collection::<Document>(collection);
    let mut cursor = col.list_indexes().await.map_err(|e| e.to_string())?;
    let mut indexes = Vec::new();
    while let Some(model) = cursor.try_next().await.map_err(|e| e.to_string())? {
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
        indexes.push(IndexInfo {
            is_unique: model.options.as_ref().and_then(|options| options.unique).unwrap_or(false),
            is_primary: name == "_id_",
            name,
            columns,
            filter,
            index_type,
            included_columns: None,
            comment: None,
        });
    }
    Ok(indexes)
}

pub async fn find_documents(
    client: &Client,
    database: &str,
    collection: &str,
    skip: u64,
    limit: i64,
    filter: Option<&str>,
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

    let total = col.count_documents(filter_doc.clone()).await.map_err(|e| e.to_string())?;

    let mut find = col.find(filter_doc).skip(skip).limit(limit);
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
        let json = bson_to_json(&Bson::Document(doc));
        documents.push(json);
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

pub async fn insert_document(
    client: &Client,
    database: &str,
    collection: &str,
    doc_json: &str,
) -> Result<String, String> {
    let doc: Document = serde_json::from_str(doc_json).map_err(|e| format!("Invalid JSON: {e}"))?;
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

pub async fn update_document(
    client: &Client,
    database: &str,
    collection: &str,
    id: &str,
    doc_json: &str,
) -> Result<u64, String> {
    let mut new_doc: Document = serde_json::from_str(doc_json).map_err(|e| format!("Invalid JSON: {e}"))?;
    new_doc.remove("_id");
    let col = client.database(database).collection::<Document>(collection);
    for filter in document_id_filters(id) {
        let result = col.replace_one(filter, new_doc.clone()).await.map_err(|e| e.to_string())?;
        if result.matched_count > 0 {
            return Ok(result.modified_count);
        }
    }
    Ok(0)
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
        Bson::Int64(v) => serde_json::json!(v),
        Bson::ObjectId(oid) => serde_json::Value::String(oid.to_hex()),
        Bson::DateTime(dt) => serde_json::Value::String(dt.to_string()),
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

pub fn json_filter_to_document(value: &serde_json::Value) -> Result<Document, String> {
    match json_filter_value_to_bson(value, None) {
        Bson::Document(doc) => Ok(doc),
        other => Err(format!("Expected a JSON object, got {other:?}")),
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
        serde_json::Value::String(s) => Bson::String(s.clone()),
        serde_json::Value::Array(arr) => Bson::Array(arr.iter().map(json_value_to_bson).collect()),
        serde_json::Value::Object(obj) => {
            // Extended JSON: {"$oid":"..."} → BSON ObjectId
            if obj.len() == 1 {
                if let Some(serde_json::Value::String(hex)) = obj.get("$oid") {
                    if let Ok(oid) = ObjectId::parse_str(hex) {
                        return Bson::ObjectId(oid);
                    }
                }
            }
            let doc: Document = obj.iter().map(|(k, v)| (k.clone(), json_value_to_bson(v))).collect();
            Bson::Document(doc)
        }
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
}
