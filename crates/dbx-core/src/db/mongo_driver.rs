use mongodb::{
    bson::{doc, oid::ObjectId, Bson, DateTime, Document},
    options::{ClientOptions, GridFsBucketOptions, IndexOptions},
    Client, Database, IndexModel,
};
use serde::{Deserialize, Serialize};

use super::with_connection_timeout;
use crate::document_ops::{MongoGridFsBucketInfo, MongoGridFsFileInfo};
use crate::types::IndexInfo;
use futures::{io::AsyncReadExt, io::AsyncWriteExt, TryStreamExt};
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MongoCollectionStatsResult {
    pub count: serde_json::Value,
    pub size: serde_json::Value,
    #[serde(rename = "avgObjSize")]
    pub avg_obj_size: serde_json::Value,
    #[serde(rename = "storageSize")]
    pub storage_size: serde_json::Value,
    #[serde(rename = "totalIndexSize")]
    pub total_index_size: serde_json::Value,
    pub nindexes: serde_json::Value,
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
    if url.get(..14).is_some_and(|scheme| scheme.eq_ignore_ascii_case("mongodb+srv://")) {
        // SRV URLs expand to a DNS seed list during driver parsing, so forcing
        // directConnection would be rejected even though the URI shows one host.
        return true;
    }
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

pub async fn collection_stats(
    client: &Client,
    database: &str,
    collection: &str,
    scale: Option<serde_json::Number>,
) -> Result<MongoCollectionStatsResult, String> {
    let database = database.trim();
    let collection = collection.trim();
    if database.is_empty() {
        return Err("Database name is required".to_string());
    }
    if collection.is_empty() {
        return Err("Collection name is required".to_string());
    }

    let result = client
        .database(database)
        .run_command(collection_stats_command_document(collection, scale.as_ref()))
        .await
        .map_err(|e| e.to_string())?;
    Ok(collection_stats_result_from_document(&result))
}

fn collection_stats_command_document(collection: &str, scale: Option<&serde_json::Number>) -> Document {
    let mut command = doc! { "collStats": collection };
    if let Some(scale) = scale {
        command.insert("scale", json_value_to_bson(&serde_json::Value::Number(scale.clone())));
    }
    command
}

fn collection_stats_result_from_document(result: &Document) -> MongoCollectionStatsResult {
    MongoCollectionStatsResult {
        count: collection_stats_field(result, "count"),
        size: collection_stats_field(result, "size"),
        avg_obj_size: collection_stats_field(result, "avgObjSize"),
        storage_size: collection_stats_field(result, "storageSize"),
        total_index_size: collection_stats_field(result, "totalIndexSize"),
        nindexes: collection_stats_field(result, "nindexes"),
    }
}

fn collection_stats_field(result: &Document, key: &str) -> serde_json::Value {
    result.get(key).map(bson_to_json).unwrap_or(serde_json::Value::Null)
}

pub async fn list_databases(client: &Client) -> Result<Vec<String>, String> {
    client.list_database_names().await.map_err(|e| e.to_string())
}

pub async fn list_collections(client: &Client, database: &str) -> Result<Vec<String>, String> {
    client.database(database).list_collection_names().await.map_err(|e| e.to_string())
}

pub async fn list_gridfs_files(
    client: &Client,
    database: &str,
    bucket: &str,
    filter: Option<&str>,
    sort: Option<&str>,
) -> Result<Vec<MongoGridFsFileInfo>, String> {
    let bucket = normalized_gridfs_bucket_name(bucket)?;
    let collection_name = format!("{bucket}.files");
    let collection = client.database(database).collection::<Document>(&collection_name);
    let filter_doc = gridfs_file_filter_document(filter)?;
    let sort_doc = gridfs_file_sort_document(sort)?;
    let mut cursor = collection.find(filter_doc).sort(sort_doc).await.map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    while cursor.advance().await.map_err(|e| e.to_string())? {
        let doc = cursor.deserialize_current().map_err(|e| e.to_string())?;
        files.push(gridfs_file_info_from_document(&doc));
    }
    Ok(files)
}

fn gridfs_file_filter_document(filter: Option<&str>) -> Result<Document, String> {
    match filter {
        Some(raw) if !raw.trim().is_empty() => {
            let json: serde_json::Value = serde_json::from_str(raw).map_err(|e| format!("Invalid filter JSON: {e}"))?;
            json_filter_to_document(&json)
        }
        _ => Ok(doc! {}),
    }
}

fn gridfs_file_sort_document(sort: Option<&str>) -> Result<Document, String> {
    match sort {
        Some(raw) if !raw.trim().is_empty() => {
            let json: serde_json::Value = serde_json::from_str(raw).map_err(|e| format!("Invalid sort JSON: {e}"))?;
            json_object_to_document(&json).map_err(|e| format!("Invalid sort: {e}"))
        }
        _ => Ok(doc! { "uploadDate": -1_i32, "_id": -1_i32 }),
    }
}

pub async fn gridfs_bucket_summary(
    client: &Client,
    database: &str,
    bucket: &str,
) -> Result<MongoGridFsBucketInfo, String> {
    let bucket = normalized_gridfs_bucket_name(bucket)?;
    let collection = client.database(database).collection::<Document>(&format!("{bucket}.files"));
    let mut cursor = collection
        .aggregate(vec![doc! {
            "$group": {
                "_id": Bson::Null,
                "fileCount": { "$sum": 1_i32 },
                "totalBytes": { "$sum": "$length" },
            }
        }])
        .await
        .map_err(|e| e.to_string())?;

    let mut file_count = 0_u64;
    let mut total_bytes = 0_i64;
    if cursor.advance().await.map_err(|e| e.to_string())? {
        let doc = cursor.deserialize_current().map_err(|e| e.to_string())?;
        file_count =
            doc.get_i64("fileCount").or_else(|_| doc.get_i32("fileCount").map(i64::from)).unwrap_or(0).max(0) as u64;
        total_bytes = doc.get_i64("totalBytes").or_else(|_| doc.get_i32("totalBytes").map(i64::from)).unwrap_or(0);
    }

    Ok(MongoGridFsBucketInfo { name: bucket, file_count, total_bytes })
}

pub async fn create_gridfs_bucket(client: &Client, database: &str, bucket: &str) -> Result<(), String> {
    let bucket = normalized_gridfs_bucket_name(bucket)?;
    let database = client.database(database);
    let files_name = format!("{bucket}.files");
    let chunks_name = format!("{bucket}.chunks");
    let existing: HashSet<String> =
        database.list_collection_names().await.map_err(|e| e.to_string())?.into_iter().collect();

    if !existing.contains(&files_name) {
        database.create_collection(&files_name).await.map_err(|e| e.to_string())?;
    }
    if !existing.contains(&chunks_name) {
        database.create_collection(&chunks_name).await.map_err(|e| e.to_string())?;
    }

    database
        .collection::<Document>(&files_name)
        .create_index(
            IndexModel::builder()
                .keys(doc! { "filename": 1_i32, "uploadDate": 1_i32 })
                .options(IndexOptions::builder().name(Some("filename_1_uploadDate_1".to_string())).build())
                .build(),
        )
        .await
        .map_err(|e| e.to_string())?;
    database
        .collection::<Document>(&chunks_name)
        .create_index(
            IndexModel::builder()
                .keys(doc! { "files_id": 1_i32, "n": 1_i32 })
                .options(IndexOptions::builder().name(Some("files_id_1_n_1".to_string())).unique(Some(true)).build())
                .build(),
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

pub async fn delete_gridfs_bucket(client: &Client, database: &str, bucket: &str) -> Result<(), String> {
    let bucket = normalized_gridfs_bucket_name(bucket)?;
    let database = client.database(database);
    drop_collection_if_exists(&database, &format!("{bucket}.files")).await?;
    drop_collection_if_exists(&database, &format!("{bucket}.chunks")).await?;
    Ok(())
}

pub async fn download_gridfs_file(
    client: &Client,
    database: &str,
    bucket: &str,
    file_id: &str,
) -> Result<Vec<u8>, String> {
    let bucket = normalized_gridfs_bucket_name(bucket)?;
    let trimmed = file_id.trim();
    if trimmed.is_empty() {
        return Err("GridFS file id is required".to_string());
    }

    let bson_id = parse_gridfs_file_id(trimmed)?;

    let files_collection = client.database(database).collection::<Document>(&format!("{bucket}.files"));
    let file_doc = files_collection
        .find_one(doc! { "_id": bson_id.clone() })
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "GridFS file not found".to_string())?;
    let bucket =
        client.database(database).gridfs_bucket(GridFsBucketOptions::builder().bucket_name(bucket.to_string()).build());
    let mut stream = bucket
        .open_download_stream(file_doc.get("_id").cloned().unwrap_or(bson_id))
        .await
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).await.map_err(|e| e.to_string())?;
    Ok(bytes)
}

pub async fn upload_gridfs_file(
    client: &Client,
    database: &str,
    bucket: &str,
    file_name: &str,
    data: &[u8],
    content_type: Option<&str>,
) -> Result<String, String> {
    let bucket = normalized_gridfs_bucket_name(bucket)?;
    let file_name = file_name.trim();
    if file_name.is_empty() {
        return Err("GridFS file name is required".to_string());
    }

    create_gridfs_bucket(client, database, &bucket).await?;

    let database_ref = client.database(database);
    let gridfs_bucket = database_ref.gridfs_bucket(GridFsBucketOptions::builder().bucket_name(bucket.clone()).build());
    let mut upload_action = gridfs_bucket.open_upload_stream(file_name);
    if let Some(content_type) = content_type.map(str::trim).filter(|value| !value.is_empty()) {
        upload_action = upload_action.metadata(doc! { "contentType": content_type });
    }
    let mut stream = upload_action.await.map_err(|e| e.to_string())?;
    let file_id = stream.id().clone();
    stream.write_all(data).await.map_err(|e| e.to_string())?;
    stream.close().await.map_err(|e| e.to_string())?;

    if let Some(content_type) = content_type.map(str::trim).filter(|value| !value.is_empty()) {
        database_ref
            .collection::<Document>(&format!("{bucket}.files"))
            .update_one(doc! { "_id": file_id.clone() }, doc! { "$set": { "contentType": content_type } })
            .await
            .map_err(|e| e.to_string())?;
    }

    Ok(gridfs_file_id_to_string(&file_id))
}

pub async fn delete_gridfs_file(client: &Client, database: &str, bucket: &str, file_id: &str) -> Result<(), String> {
    let bucket = normalized_gridfs_bucket_name(bucket)?;
    let bson_id = parse_gridfs_file_id(file_id.trim())?;
    client
        .database(database)
        .gridfs_bucket(GridFsBucketOptions::builder().bucket_name(bucket).build())
        .delete(bson_id)
        .await
        .map_err(|e| e.to_string())
}

fn gridfs_file_id_to_string(id: &Bson) -> String {
    match id {
        Bson::ObjectId(value) => value.to_hex(),
        Bson::String(value) => value.clone(),
        _ => id.clone().into_relaxed_extjson().to_string(),
    }
}

fn gridfs_upload_date_to_string(value: &DateTime) -> String {
    value.try_to_rfc3339_string().unwrap_or_else(|_| value.timestamp_millis().to_string())
}

fn gridfs_file_info_from_document(doc: &Document) -> MongoGridFsFileInfo {
    let id = gridfs_file_id_to_string(doc.get("_id").unwrap_or(&Bson::Null));
    let filename = doc.get_str("filename").ok().map(str::to_string);
    let length = doc.get_i64("length").or_else(|_| doc.get_i32("length").map(i64::from)).unwrap_or(0);
    let chunk_size =
        doc.get_i32("chunkSize").or_else(|_| doc.get_i64("chunkSize").map(|value| value as i32)).unwrap_or(0);
    let upload_date = doc.get_datetime("uploadDate").ok().map(gridfs_upload_date_to_string);
    let metadata = doc.get_document("metadata").ok().map(|value| Bson::Document(value.clone()).into_relaxed_extjson());
    let md5 = doc.get_str("md5").ok().map(str::to_string);
    let content_type = doc.get_str("contentType").ok().map(str::to_string).or_else(|| {
        doc.get_document("metadata").ok().and_then(|meta| meta.get_str("contentType").ok().map(str::to_string))
    });
    let aliases = doc.get_array("aliases").ok().and_then(|values| {
        let aliases: Vec<String> = values.iter().filter_map(|value| value.as_str().map(str::to_string)).collect();
        if aliases.is_empty() {
            None
        } else {
            Some(aliases)
        }
    });

    MongoGridFsFileInfo { id, filename, length, chunk_size, upload_date, metadata, md5, content_type, aliases }
}

fn parse_gridfs_file_id(file_id: &str) -> Result<Bson, String> {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(file_id) {
        return Bson::try_from(value).map_err(|e| format!("Invalid GridFS file id: {e}"));
    }

    if let Ok(object_id) = ObjectId::parse_str(file_id) {
        return Ok(Bson::ObjectId(object_id));
    }

    Ok(Bson::String(file_id.to_string()))
}

fn normalized_gridfs_bucket_name(bucket: &str) -> Result<String, String> {
    let bucket = bucket.trim();
    if bucket.is_empty() {
        return Err("GridFS bucket name is required".to_string());
    }
    if bucket.ends_with(".files") || bucket.ends_with(".chunks") {
        return Err("Use the GridFS bucket name without the .files or .chunks suffix".to_string());
    }
    Ok(bucket.to_string())
}

async fn drop_collection_if_exists(database: &Database, collection_name: &str) -> Result<(), String> {
    match database.collection::<Document>(collection_name).drop().await {
        Ok(()) => Ok(()),
        Err(error) if mongo_namespace_missing(&error.to_string()) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn mongo_namespace_missing(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("ns not found") || lower.contains("namespace not found")
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

pub async fn count_documents(
    client: &Client,
    database: &str,
    collection: &str,
    filter: Option<&str>,
    accurate: bool,
) -> Result<u64, String> {
    let col = client.database(database).collection::<Document>(collection);

    let filter_doc: Document = match filter {
        Some(f) if !f.trim().is_empty() => {
            let json: serde_json::Value = serde_json::from_str(f).map_err(|e| format!("Invalid filter JSON: {e}"))?;
            json_filter_to_document(&json)?
        }
        _ => doc! {},
    };

    if !accurate && filter_doc.is_empty() {
        // Legacy count() permits the metadata-backed fast path; countDocuments() must scan accurately.
        col.estimated_document_count().await.map_err(|e| e.to_string())
    } else {
        col.count_documents(filter_doc).await.map_err(|e| e.to_string())
    }
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
    options_json: Option<&str>,
) -> Result<u64, String> {
    let filter_value: serde_json::Value =
        serde_json::from_str(filter_json).map_err(|e| format!("Invalid filter JSON: {e}"))?;
    let update_value: serde_json::Value =
        serde_json::from_str(update_json).map_err(|e| format!("Invalid update JSON: {e}"))?;
    let filter = json_filter_to_document(&filter_value).map_err(|e| format!("Invalid filter: {e}"))?;
    let update = json_object_to_document(&update_value).map_err(|e| format!("Invalid update: {e}"))?;
    let array_filters = parse_update_array_filters(options_json)?;
    let col = client.database(database).collection::<Document>(collection);
    let result = if many {
        let mut action = col.update_many(filter, update);
        if let Some(filters) = array_filters {
            action = action.array_filters(filters);
        }
        action.await.map_err(|e| e.to_string())?
    } else {
        let mut action = col.update_one(filter, update);
        if let Some(filters) = array_filters {
            action = action.array_filters(filters);
        }
        action.await.map_err(|e| e.to_string())?
    };
    Ok(result.modified_count)
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MongoUpdateOptions {
    array_filters: Option<Vec<serde_json::Value>>,
}

fn parse_update_array_filters(options_json: Option<&str>) -> Result<Option<Vec<Document>>, String> {
    let Some(raw) = options_json.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    let options: MongoUpdateOptions = serde_json::from_str(raw).map_err(|e| format!("Invalid update options: {e}"))?;
    options
        .array_filters
        .map(|filters| {
            filters
                .iter()
                .map(json_filter_to_document)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("Invalid arrayFilters: {e}"))
        })
        .transpose()
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
    if let Some(string_id) = decode_string_document_id(id) {
        return vec![doc! { "_id": Bson::String(string_id) }];
    }
    if let Some(filter) = extended_json_document_id_filter(id) {
        return vec![filter];
    }
    let string_filter = doc! { "_id": Bson::String(id.to_string()) };
    match ObjectId::parse_str(id) {
        Ok(oid) => vec![doc! { "_id": Bson::ObjectId(oid) }, string_filter],
        Err(_) => vec![string_filter],
    }
}

fn decode_string_document_id(id: &str) -> Option<String> {
    id.strip_prefix("__dbx_mongo_string_id__").and_then(|payload| serde_json::from_str::<String>(payload).ok())
}

fn extended_json_document_id_filter(id: &str) -> Option<Document> {
    let trimmed = id.trim();
    if !trimmed.starts_with('{') {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(trimmed).ok()?;
    let bson = json_value_to_bson(&value);
    if matches!(bson, Bson::Document(_)) {
        return None;
    }
    Some(doc! { "_id": bson })
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
                map.insert(k.clone(), bson_document_field_to_json(k, v));
            }
            serde_json::Value::Object(map)
        }
        _ => serde_json::Value::String(format!("{bson}")),
    }
}

fn bson_document_field_to_json(key: &str, bson: &Bson) -> serde_json::Value {
    if key == "_id" {
        if let Bson::Int64(value) = bson {
            return serde_json::json!({ "$numberLong": value.to_string() });
        }
    }
    bson_to_json(bson)
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
                if let Some(value) = parse_extended_json_int64(obj) {
                    return Bson::Int64(value);
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

fn parse_extended_json_int64(obj: &serde_json::Map<String, serde_json::Value>) -> Option<i64> {
    match obj.get("$numberLong")? {
        serde_json::Value::String(value) => value.parse().ok(),
        serde_json::Value::Number(value) => value.as_i64(),
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
                if let Some(value) = parse_extended_json_int64(obj) {
                    return Bson::Int64(value);
                }
                // Extended JSON dates must be decoded in filters too, otherwise
                // {"$date": ...} reaches the server as a raw document: a bare
                // { field: {"$date": ...} } fails with "unknown operator: $date"
                // and { field: {"$gte": {"$date": ...}} } silently matches nothing.
                if let Some(date) = parse_extended_json_date(obj) {
                    return Bson::DateTime(date);
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
    fn update_options_parse_array_filters() {
        let filters = parse_update_array_filters(Some(r#"{"arrayFilters":[{"item.id":322678},{"item.active":true}]}"#))
            .unwrap()
            .unwrap();

        assert_eq!(filters, vec![doc! { "item.id": 322678_i64 }, doc! { "item.active": true }]);
    }

    #[test]
    fn update_options_reject_unsupported_fields() {
        let error = parse_update_array_filters(Some(r#"{"upsert":true}"#)).unwrap_err();

        assert!(error.starts_with("Invalid update options:"));
        assert!(error.contains("unknown field `upsert`"));
    }

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
    fn srv_uri_removes_direct_connection_true_before_driver_parse() {
        let uri = "mongodb+srv://read:pass@cluster.example.net/admin?tls=true&directConnection=true&replicaSet=rs0";

        let normalized = normalize_mongo_uri_direct_connection(uri);

        assert_eq!(normalized, "mongodb+srv://read:pass@cluster.example.net/admin?tls=true&replicaSet=rs0");
        assert!(is_multi_host_mongo_uri(&normalized));
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
        let filters = document_id_filters(&id);

        assert_eq!(filters.len(), 2);
        assert!(matches!(filters[0].get("_id"), Some(Bson::ObjectId(_))));
        assert!(matches!(filters[1].get("_id"), Some(Bson::String(value)) if value == id));
    }

    #[test]
    fn document_id_filters_use_string_only_for_non_hex_ids() {
        let id = "customer-42";
        let filters = document_id_filters(&id);

        assert_eq!(filters.len(), 1);
        assert!(matches!(filters[0].get("_id"), Some(Bson::String(value)) if value == id));
    }

    #[test]
    fn document_id_filters_preserve_extended_json_int64_ids() {
        let filters = document_id_filters(r#"{"$numberLong":"2048938405781032962"}"#);

        assert_eq!(filters.len(), 1);
        assert!(matches!(filters[0].get("_id"), Some(Bson::Int64(2_048_938_405_781_032_962))));
    }

    #[test]
    fn document_id_filters_decode_explicit_string_ids_before_extended_json() {
        let original = r#"{"$numberLong":"2048938405781032962"}"#;
        let id = format!("__dbx_mongo_string_id__{}", serde_json::to_string(original).unwrap());
        let filters = document_id_filters(&id);

        assert_eq!(filters.len(), 1);
        assert!(
            matches!(filters[0].get("_id"), Some(Bson::String(value)) if value == r####"{"$numberLong":"2048938405781032962"}"####)
        );
    }

    #[test]
    fn json_filter_to_document_preserves_extended_json_int64_values() {
        let filter = serde_json::json!({ "snowflake": { "$numberLong": "2048938405781032962" } });
        let document = json_filter_to_document(&filter).unwrap();

        assert!(matches!(document.get("snowflake"), Some(Bson::Int64(2_048_938_405_781_032_962))));
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
    fn json_filter_to_document_decodes_extended_json_dates() {
        let iso = "2025-02-25T04:57:39.965Z";
        let expected = DateTime::parse_rfc3339_str(iso).unwrap();

        // Direct equality must yield a BSON DateTime, not a raw { "$date": ... }
        // document that the server rejects with "unknown operator: $date".
        let filter = serde_json::json!({ "createdAt": { "$date": iso } });
        let doc = json_filter_to_document(&filter).unwrap();
        assert_eq!(doc.get("createdAt"), Some(&Bson::DateTime(expected)));

        // Range operands must be decoded too, otherwise $gte compares against a
        // sub-document and silently matches nothing.
        let range = serde_json::json!({ "createdAt": { "$gte": { "$date": iso } } });
        let range_doc = json_filter_to_document(&range).unwrap();
        let Some(Bson::Document(op)) = range_doc.get("createdAt") else {
            panic!("expected operator document");
        };
        assert_eq!(op.get("$gte"), Some(&Bson::DateTime(expected)));
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
    fn bson_to_json_preserves_int64_id_type_for_updates() {
        let value = bson_to_json(&Bson::Document(doc! {
            "_id": Bson::Int64(2_048_938_405_781_032_962),
            "snowflake": Bson::Int64(2_048_938_405_781_032_962),
        }));

        assert_eq!(value["_id"], serde_json::json!({ "$numberLong": "2048938405781032962" }));
        assert_eq!(value["snowflake"], serde_json::json!("2048938405781032962"));
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
    fn parse_gridfs_file_id_accepts_extended_json_object_id() {
        let id = parse_gridfs_file_id(r#"{"$oid":"507f1f77bcf86cd799439011"}"#).unwrap();

        assert!(matches!(id, Bson::ObjectId(oid) if oid.to_hex() == "507f1f77bcf86cd799439011"));
    }

    #[test]
    fn parse_gridfs_file_id_accepts_json_string_ids() {
        let id = parse_gridfs_file_id(r#""report-42""#).unwrap();

        assert!(matches!(id, Bson::String(value) if value == "report-42"));
    }

    #[test]
    fn gridfs_file_id_to_string_keeps_plain_strings_unquoted() {
        let id = gridfs_file_id_to_string(&Bson::String("report-42".to_string()));

        assert_eq!(id, "report-42");
    }

    #[test]
    fn gridfs_file_info_includes_navicat_style_metadata_fields() {
        let info = gridfs_file_info_from_document(&doc! {
            "_id": "report-42",
            "filename": "report.zip",
            "length": 128_i64,
            "chunkSize": 255_i32,
            "md5": "abc123",
            "contentType": "application/zip",
            "aliases": ["archive", "nightly"],
        });

        assert_eq!(info.id, "report-42");
        assert_eq!(info.filename.as_deref(), Some("report.zip"));
        assert_eq!(info.md5.as_deref(), Some("abc123"));
        assert_eq!(info.content_type.as_deref(), Some("application/zip"));
        assert_eq!(info.aliases, Some(vec!["archive".to_string(), "nightly".to_string()]));
    }

    #[test]
    fn gridfs_file_sort_uses_upload_date_desc_by_default() {
        assert_eq!(gridfs_file_sort_document(None).unwrap(), doc! { "uploadDate": -1_i32, "_id": -1_i32 });
    }

    #[test]
    fn gridfs_file_sort_parses_explicit_sort_json() {
        assert_eq!(gridfs_file_sort_document(Some(r#"{"filename":1}"#)).unwrap(), doc! { "filename": 1_i64 });
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
    fn collection_stats_result_reads_expected_fields() {
        let result = collection_stats_result_from_document(&doc! {
            "count": 12_i64,
            "size": 4096_i64,
            "avgObjSize": 341.3_f64,
            "storageSize": 8192_i64,
            "totalIndexSize": 2048_i64,
            "nindexes": 3_i32,
        });

        assert_eq!(
            result,
            MongoCollectionStatsResult {
                count: serde_json::json!(12),
                size: serde_json::json!(4096),
                avg_obj_size: serde_json::json!(341.3),
                storage_size: serde_json::json!(8192),
                total_index_size: serde_json::json!(2048),
                nindexes: serde_json::json!(3),
            }
        );
    }

    #[test]
    fn collection_stats_result_fills_missing_fields_with_null() {
        let result = collection_stats_result_from_document(&doc! {
            "count": 7_i32,
            "storageSize": 512_i32,
        });

        assert_eq!(result.count, serde_json::json!(7));
        assert_eq!(result.size, serde_json::Value::Null);
        assert_eq!(result.avg_obj_size, serde_json::Value::Null);
        assert_eq!(result.storage_size, serde_json::json!(512));
        assert_eq!(result.total_index_size, serde_json::Value::Null);
        assert_eq!(result.nindexes, serde_json::Value::Null);
    }

    #[test]
    fn collection_stats_command_serializes_scale() {
        let command = collection_stats_command_document("users", Some(&serde_json::Number::from(1024)));

        assert_eq!(command.get_str("collStats").unwrap(), "users");
        assert!(matches!(command.get("scale"), Some(Bson::Int64(1024))));
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
