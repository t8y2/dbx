use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3ConnectionRequest {
    pub connection_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3CreateBucketRequest {
    pub connection_id: String,
    pub bucket: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3CopyObjectRequest {
    pub connection_id: String,
    pub source_bucket: String,
    pub source_key: String,
    pub destination_bucket: String,
    pub destination_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3ListObjectsRequest {
    pub connection_id: String,
    pub bucket: String,
    pub prefix: String,
    pub delimiter: Option<String>,
    pub max_keys: usize,
    pub continuation_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3ObjectRequest {
    pub connection_id: String,
    pub bucket: String,
    pub key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3PreviewObjectRequest {
    pub connection_id: String,
    pub bucket: String,
    pub key: String,
    pub max_bytes: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3UploadObjectRequest {
    pub connection_id: String,
    pub bucket: String,
    pub key: String,
    pub payload_base64: String,
    pub content_type: Option<String>,
}

pub async fn list_buckets(
    State(state): State<Arc<WebState>>,
    Json(req): Json<S3ConnectionRequest>,
) -> Result<Json<Vec<dbx_core::s3::S3Bucket>>, AppError> {
    Ok(Json(dbx_core::s3::s3_list_buckets_core(&state.app, &req.connection_id).await.map_err(AppError::from)?))
}

pub async fn create_bucket(
    State(state): State<Arc<WebState>>,
    Json(req): Json<S3CreateBucketRequest>,
) -> Result<Json<()>, AppError> {
    dbx_core::s3::s3_create_bucket_core(&state.app, &req.connection_id, &req.bucket).await.map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn delete_bucket(
    State(state): State<Arc<WebState>>,
    Json(req): Json<S3CreateBucketRequest>,
) -> Result<Json<()>, AppError> {
    dbx_core::s3::s3_delete_bucket_core(&state.app, &req.connection_id, &req.bucket).await.map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn list_objects(
    State(state): State<Arc<WebState>>,
    Json(req): Json<S3ListObjectsRequest>,
) -> Result<Json<dbx_core::s3::S3ListObjectsResponse>, AppError> {
    Ok(Json(
        dbx_core::s3::s3_list_objects_core(
            &state.app,
            &req.connection_id,
            &req.bucket,
            &req.prefix,
            req.delimiter.as_deref(),
            req.max_keys,
            req.continuation_token.as_deref(),
        )
        .await
        .map_err(AppError::from)?,
    ))
}

pub async fn head_object(
    State(state): State<Arc<WebState>>,
    Json(req): Json<S3ObjectRequest>,
) -> Result<Json<dbx_core::s3::S3ObjectHead>, AppError> {
    Ok(Json(
        dbx_core::s3::s3_head_object_core(&state.app, &req.connection_id, &req.bucket, &req.key)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn preview_object(
    State(state): State<Arc<WebState>>,
    Json(req): Json<S3PreviewObjectRequest>,
) -> Result<Json<dbx_core::s3::S3ObjectPreview>, AppError> {
    Ok(Json(
        dbx_core::s3::s3_preview_object_core(&state.app, &req.connection_id, &req.bucket, &req.key, req.max_bytes)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn download_object(
    State(state): State<Arc<WebState>>,
    Json(req): Json<S3ObjectRequest>,
) -> Result<Json<Vec<u8>>, AppError> {
    Ok(Json(
        dbx_core::s3::s3_download_object_core(&state.app, &req.connection_id, &req.bucket, &req.key)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn upload_object(
    State(state): State<Arc<WebState>>,
    Json(req): Json<S3UploadObjectRequest>,
) -> Result<Json<()>, AppError> {
    dbx_core::s3::s3_upload_object_core(
        &state.app,
        &req.connection_id,
        &req.bucket,
        &req.key,
        &req.payload_base64,
        req.content_type.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn delete_object(
    State(state): State<Arc<WebState>>,
    Json(req): Json<S3ObjectRequest>,
) -> Result<Json<()>, AppError> {
    dbx_core::s3::s3_delete_object_core(&state.app, &req.connection_id, &req.bucket, &req.key)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn copy_object(
    State(state): State<Arc<WebState>>,
    Json(req): Json<S3CopyObjectRequest>,
) -> Result<Json<()>, AppError> {
    dbx_core::s3::s3_copy_object_core(
        &state.app,
        &req.connection_id,
        &req.source_bucket,
        &req.source_key,
        &req.destination_bucket,
        &req.destination_key,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn move_object(
    State(state): State<Arc<WebState>>,
    Json(req): Json<S3CopyObjectRequest>,
) -> Result<Json<()>, AppError> {
    dbx_core::s3::s3_move_object_core(
        &state.app,
        &req.connection_id,
        &req.source_bucket,
        &req.source_key,
        &req.destination_bucket,
        &req.destination_key,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(()))
}
