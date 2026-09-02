use std::sync::Arc;

use tauri::State;

use crate::commands::connection::AppState;

#[tauri::command]
pub async fn s3_list_buckets(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Vec<dbx_core::s3::S3Bucket>, String> {
    dbx_core::s3::s3_list_buckets_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn s3_create_bucket(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    bucket: String,
) -> Result<(), String> {
    dbx_core::s3::s3_create_bucket_core(&state, &connection_id, &bucket).await
}

#[tauri::command]
pub async fn s3_delete_bucket(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    bucket: String,
) -> Result<(), String> {
    dbx_core::s3::s3_delete_bucket_core(&state, &connection_id, &bucket).await
}

#[tauri::command]
pub async fn s3_list_objects(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    bucket: String,
    prefix: String,
    delimiter: Option<String>,
    max_keys: usize,
    continuation_token: Option<String>,
) -> Result<dbx_core::s3::S3ListObjectsResponse, String> {
    dbx_core::s3::s3_list_objects_core(
        &state,
        &connection_id,
        &bucket,
        &prefix,
        delimiter.as_deref(),
        max_keys,
        continuation_token.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn s3_head_object(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    bucket: String,
    key: String,
) -> Result<dbx_core::s3::S3ObjectHead, String> {
    dbx_core::s3::s3_head_object_core(&state, &connection_id, &bucket, &key).await
}

#[tauri::command]
pub async fn s3_preview_object(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    bucket: String,
    key: String,
    max_bytes: usize,
) -> Result<dbx_core::s3::S3ObjectPreview, String> {
    dbx_core::s3::s3_preview_object_core(&state, &connection_id, &bucket, &key, max_bytes).await
}

#[tauri::command]
pub async fn s3_download_object(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    bucket: String,
    key: String,
) -> Result<Vec<u8>, String> {
    dbx_core::s3::s3_download_object_core(&state, &connection_id, &bucket, &key).await
}

#[tauri::command]
pub async fn s3_upload_object(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    bucket: String,
    key: String,
    payload_base64: String,
    content_type: Option<String>,
) -> Result<(), String> {
    dbx_core::s3::s3_upload_object_core(&state, &connection_id, &bucket, &key, &payload_base64, content_type.as_deref())
        .await
}

#[tauri::command]
pub async fn s3_delete_object(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    bucket: String,
    key: String,
) -> Result<(), String> {
    dbx_core::s3::s3_delete_object_core(&state, &connection_id, &bucket, &key).await
}

#[tauri::command]
pub async fn s3_copy_object(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    source_bucket: String,
    source_key: String,
    destination_bucket: String,
    destination_key: String,
) -> Result<(), String> {
    dbx_core::s3::s3_copy_object_core(
        &state,
        &connection_id,
        &source_bucket,
        &source_key,
        &destination_bucket,
        &destination_key,
    )
    .await
}

#[tauri::command]
pub async fn s3_move_object(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    source_bucket: String,
    source_key: String,
    destination_bucket: String,
    destination_key: String,
) -> Result<(), String> {
    dbx_core::s3::s3_move_object_core(
        &state,
        &connection_id,
        &source_bucket,
        &source_key,
        &destination_bucket,
        &destination_key,
    )
    .await
}
