use std::future::Future;
use std::sync::Arc;

use axum::extract::{Multipart, State};
use axum::Json;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

async fn run_cancellable<T, F>(state: &Arc<WebState>, execution_id: Option<String>, future: F) -> Result<T, AppError>
where
    F: Future<Output = Result<T, String>>,
{
    let registered = execution_id
        .as_ref()
        .filter(|id| !id.trim().is_empty())
        .map(|id| state.app.running_queries.register(id.clone()));
    if let Some(query) = registered.as_ref() {
        let token = query.token();
        tokio::select! {
            biased;
            _ = token.cancelled() => Err(AppError::from(dbx_core::query::canceled_error())),
            result = future => result.map_err(AppError::from),
        }
    } else {
        future.await.map_err(AppError::from)
    }
}

async fn ensure_writable(
    app: &dbx_core::connection::AppState,
    connection_id: &str,
    action: &str,
) -> Result<(), AppError> {
    if let Some(name) = dbx_core::query::connection_readonly_name(app, connection_id).await {
        return Err(AppError::from(format!(
            "Read-only mode: connection '{}' has read-only protection enabled. {} blocked.",
            name, action
        )));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentListDatabasesRequest {
    pub connection_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentListCollectionsRequest {
    pub connection_id: String,
    pub database: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentFindRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub skip: Option<u64>,
    pub limit: Option<i64>,
    pub filter: Option<String>,
    pub projection: Option<String>,
    pub sort: Option<String>,
    pub execution_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElasticsearchCountDocumentsRequest {
    pub connection_id: String,
    pub index: String,
    pub filter: Option<String>,
    pub execution_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentInsertRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub doc_json: String,
    pub routing: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentUpdateRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub id: String,
    pub doc_json: String,
    pub routing: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentDeleteRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub id: String,
    pub routing: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridFsBucketRequest {
    pub connection_id: String,
    pub database: String,
    pub bucket: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridFsFileListRequest {
    pub connection_id: String,
    pub database: String,
    pub bucket: String,
    pub filter: Option<String>,
    pub sort: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridFsBucketListRequest {
    pub connection_id: String,
    pub database: String,
    pub filter: Option<String>,
    pub sort: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridFsDownloadRequest {
    pub connection_id: String,
    pub database: String,
    pub bucket: String,
    pub file_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridFsFileDeleteRequest {
    pub connection_id: String,
    pub database: String,
    pub bucket: String,
    pub file_id: String,
}

pub async fn list_databases(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DocumentListDatabasesRequest>,
) -> Result<Json<Vec<String>>, AppError> {
    let result =
        dbx_core::document_ops::list_databases_core(&state.app, &req.connection_id).await.map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn list_collections(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DocumentListCollectionsRequest>,
) -> Result<Json<Vec<dbx_core::document_ops::CollectionInfo>>, AppError> {
    let result = dbx_core::document_ops::list_collections_core(&state.app, &req.connection_id, &req.database)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn find_documents(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DocumentFindRequest>,
) -> Result<Json<dbx_core::db::document_result::DocumentQueryResult>, AppError> {
    let result = run_cancellable(
        &state,
        req.execution_id,
        dbx_core::document_ops::find_documents_core(
            &state.app,
            &req.connection_id,
            &req.database,
            &req.collection,
            req.skip.unwrap_or(0),
            req.limit.unwrap_or(50),
            req.filter.as_deref(),
            req.projection.as_deref(),
            req.sort.as_deref(),
        ),
    )
    .await?;
    Ok(Json(result))
}

pub async fn elasticsearch_count_documents(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ElasticsearchCountDocumentsRequest>,
) -> Result<Json<u64>, AppError> {
    let result = run_cancellable(
        &state,
        req.execution_id,
        dbx_core::document_ops::count_elasticsearch_documents_core(
            &state.app,
            &req.connection_id,
            &req.index,
            req.filter.as_deref(),
        ),
    )
    .await?;
    Ok(Json(result))
}

pub async fn insert_document(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DocumentInsertRequest>,
) -> Result<Json<String>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Insert").await?;
    let result = dbx_core::document_ops::insert_document_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.collection,
        &req.doc_json,
        req.routing.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn update_document(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DocumentUpdateRequest>,
) -> Result<Json<u64>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Update").await?;
    let result = dbx_core::document_ops::update_document_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.collection,
        &req.id,
        &req.doc_json,
        req.routing.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn delete_document(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DocumentDeleteRequest>,
) -> Result<Json<u64>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete").await?;
    let result = dbx_core::document_ops::delete_document_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.collection,
        &req.id,
        req.routing.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn list_gridfs_files(
    State(state): State<Arc<WebState>>,
    Json(req): Json<GridFsFileListRequest>,
) -> Result<Json<Vec<dbx_core::document_ops::MongoGridFsFileInfo>>, AppError> {
    let result = dbx_core::document_ops::list_gridfs_files_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.bucket,
        req.filter.as_deref(),
        req.sort.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn list_gridfs_buckets(
    State(state): State<Arc<WebState>>,
    Json(req): Json<GridFsBucketListRequest>,
) -> Result<Json<Vec<dbx_core::document_ops::MongoGridFsBucketInfo>>, AppError> {
    let result = dbx_core::document_ops::list_gridfs_buckets_core(
        &state.app,
        &req.connection_id,
        &req.database,
        req.filter.as_deref(),
        req.sort.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn create_gridfs_bucket(
    State(state): State<Arc<WebState>>,
    Json(req): Json<GridFsBucketRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Create GridFS bucket").await?;
    dbx_core::document_ops::create_gridfs_bucket_core(&state.app, &req.connection_id, &req.database, &req.bucket)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn delete_gridfs_bucket(
    State(state): State<Arc<WebState>>,
    Json(req): Json<GridFsBucketRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete GridFS bucket").await?;
    dbx_core::document_ops::delete_gridfs_bucket_core(&state.app, &req.connection_id, &req.database, &req.bucket)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn download_gridfs_file(
    State(state): State<Arc<WebState>>,
    Json(req): Json<GridFsDownloadRequest>,
) -> Result<Json<Vec<u8>>, AppError> {
    let result = dbx_core::document_ops::download_gridfs_file_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.bucket,
        &req.file_id,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn upload_gridfs_file(
    State(state): State<Arc<WebState>>,
    mut multipart: Multipart,
) -> Result<Json<String>, AppError> {
    let mut connection_id: Option<String> = None;
    let mut database: Option<String> = None;
    let mut bucket: Option<String> = None;
    let mut file_name: Option<String> = None;
    let mut content_type: Option<String> = None;
    let mut file_bytes: Option<Vec<u8>> = None;

    while let Some(field) = multipart.next_field().await.map_err(|e| AppError::from(e.to_string()))? {
        let name = field.name().unwrap_or_default().to_string();
        match name.as_str() {
            "connectionId" => connection_id = Some(field.text().await.map_err(|e| AppError::from(e.to_string()))?),
            "database" => database = Some(field.text().await.map_err(|e| AppError::from(e.to_string()))?),
            "bucket" => bucket = Some(field.text().await.map_err(|e| AppError::from(e.to_string()))?),
            "fileName" => file_name = Some(field.text().await.map_err(|e| AppError::from(e.to_string()))?),
            "contentType" => content_type = Some(field.text().await.map_err(|e| AppError::from(e.to_string()))?),
            "file" => {
                if file_name.is_none() {
                    file_name = field.file_name().map(str::to_string);
                }
                if content_type.is_none() {
                    content_type = field.content_type().map(str::to_string);
                }
                file_bytes = Some(field.bytes().await.map_err(|e| AppError::from(e.to_string()))?.to_vec());
            }
            _ => {
                let _ = field.bytes().await;
            }
        }
    }

    let connection_id = connection_id.ok_or_else(|| AppError::from("Missing connectionId".to_string()))?;
    let database = database.ok_or_else(|| AppError::from("Missing database".to_string()))?;
    let bucket = bucket.ok_or_else(|| AppError::from("Missing bucket".to_string()))?;
    let file_name = file_name.ok_or_else(|| AppError::from("Missing fileName".to_string()))?;
    let file_bytes = file_bytes.ok_or_else(|| AppError::from("No file uploaded".to_string()))?;

    ensure_writable(&state.app, &connection_id, "Upload GridFS file").await?;
    let result = dbx_core::document_ops::upload_gridfs_file_core(
        &state.app,
        &connection_id,
        &database,
        &bucket,
        &file_name,
        &file_bytes,
        content_type.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn delete_gridfs_file(
    State(state): State<Arc<WebState>>,
    Json(req): Json<GridFsFileDeleteRequest>,
) -> Result<Json<()>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete GridFS file").await?;
    dbx_core::document_ops::delete_gridfs_file_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.bucket,
        &req.file_id,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(()))
}
