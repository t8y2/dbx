use std::path::{Component, Path as FilePath, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Multipart, Path, State},
    response::Sse,
    Json,
};
use dbx_core::{
    mongodb_dump::{
        self, MongoDatabaseDumpProgress, MongoDatabaseDumpRequest, MongoDatabaseRestoreRequest, MongoDumpFormat,
        MongoRestoreSourceRequest,
    },
    transfer,
};
use serde::Deserialize;
use tokio::io::AsyncWriteExt;

use super::export_download::export_download_filename;
use crate::{
    error::AppError,
    sse::{TransferProgressChannel, TransferReplayEventKind},
    state::{WebExportFile, WebState},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogRequest {
    connection_id: String,
    database: String,
}

pub async fn catalog(
    State(state): State<Arc<WebState>>,
    Json(request): Json<CatalogRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let catalog = mongodb_dump::inspect_mongodb_database_dump(&state.app, &request.connection_id, &request.database)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(catalog).map_err(|e| AppError::from(e.to_string()))?))
}

fn upload_path(root: &FilePath, filename: &str) -> Result<PathBuf, AppError> {
    let path = FilePath::new(filename);
    if filename.is_empty()
        || filename.contains(['\\', ':', '\0'])
        || path.components().any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(AppError::from("Invalid dump upload path".to_string()));
    }
    if path.components().count() > 4 {
        return Err(AppError::from("Dump directory nesting is too deep".to_string()));
    }
    Ok(root.join(path))
}

pub async fn prepare_source(
    State(state): State<Arc<WebState>>,
    multipart: Multipart,
) -> Result<Json<serde_json::Value>, AppError> {
    receive_source(state, multipart, false).await
}

pub async fn upload_restore_source(
    State(state): State<Arc<WebState>>,
    multipart: Multipart,
) -> Result<Json<serde_json::Value>, AppError> {
    receive_source(state, multipart, true).await
}

pub async fn upload_limit() -> Json<usize> {
    Json(crate::web_body_limit_bytes())
}

async fn field_text(mut field: axum::extract::multipart::Field<'_>, limit: usize) -> Result<String, AppError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = field.chunk().await.map_err(|e| AppError::bad_request(e.to_string()))? {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(AppError::bad_request("Dump metadata field is too large"));
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|e| AppError::bad_request(e.to_string()))
}

async fn receive_source(
    state: Arc<WebState>,
    mut multipart: Multipart,
    acquiring: bool,
) -> Result<Json<serde_json::Value>, AppError> {
    let tmp = state.data_dir.join("tmp");
    tokio::fs::create_dir_all(&tmp).await.map_err(|e| AppError::from(e.to_string()))?;
    let upload =
        tempfile::Builder::new().prefix("mongo-upload-").tempdir_in(&tmp).map_err(|e| AppError::from(e.to_string()))?;
    let mut format = None;
    let mut gzip = false;
    let mut paths = Vec::new();
    let mut bytes = 0usize;
    let mut manifest: Option<Vec<mongodb_dump::MongoDumpFile>> = None;
    let mut request: Option<MongoDatabaseRestoreRequest> = None;
    let mut expected_upload = std::collections::HashMap::<String, u64>::new();
    while let Some(mut field) = multipart.next_field().await.map_err(|e| AppError::from(e.to_string()))? {
        match field.name().unwrap_or("") {
            "file" => {
                if paths.len() >= 100_000 {
                    return Err(AppError::from("Too many dump files".to_string()));
                }
                let filename =
                    field.file_name().ok_or_else(|| AppError::from("Missing dump filename".to_string()))?.to_string();
                if format.is_none() {
                    return Err(AppError::bad_request("Dump format must precede files"));
                }
                if !acquiring
                    && format == Some(MongoDumpFormat::Directory)
                    && !filename.ends_with(".metadata.json")
                    && !filename.ends_with(".metadata.json.gz")
                {
                    return Err(AppError::bad_request(
                        "Directory preview accepts metadata only; upload BSON after confirmation",
                    ));
                }
                if acquiring && request.is_none() {
                    return Err(AppError::bad_request("Restore plan must precede files"));
                }
                let expected_size = if acquiring {
                    Some(
                        expected_upload
                            .remove(&filename)
                            .ok_or_else(|| AppError::bad_request("File is not in the selected restore plan"))?,
                    )
                } else {
                    None
                };
                let mut file_bytes = 0u64;
                let path = upload_path(upload.path(), &filename)?;
                tokio::fs::create_dir_all(path.parent().unwrap()).await.map_err(|e| AppError::from(e.to_string()))?;
                let mut output = tokio::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&path)
                    .await
                    .map_err(|e| AppError::from(e.to_string()))?;
                while let Some(chunk) = field.chunk().await.map_err(|e| AppError::from(e.to_string()))? {
                    if let Some(request) = &request {
                        if transfer::is_cancelled(&request.task_id).await {
                            return Err(AppError::bad_request("MongoDB dump/restore cancelled"));
                        }
                    }
                    bytes = bytes.saturating_add(chunk.len());
                    file_bytes = file_bytes.saturating_add(chunk.len() as u64);
                    if expected_size.is_some_and(|size| file_bytes > size) {
                        return Err(AppError::bad_request("File size changed after preview"));
                    }
                    let limit = if !acquiring && format == Some(MongoDumpFormat::Directory) {
                        32 * 1024 * 1024
                    } else {
                        crate::web_body_limit_bytes()
                    };
                    if bytes > limit {
                        let mut error =
                            AppError::from(format!("Dump upload exceeds the configured {} byte limit", limit));
                        error.status = axum::http::StatusCode::PAYLOAD_TOO_LARGE;
                        return Err(error);
                    }
                    output.write_all(&chunk).await.map_err(|e| AppError::from(e.to_string()))?;
                }
                output.flush().await.map_err(|e| AppError::from(e.to_string()))?;
                if expected_size.is_some_and(|size| file_bytes != size) {
                    return Err(AppError::bad_request("File size changed after preview"));
                }
                paths.push((filename, path));
            }
            "format" => {
                let value = field_text(field, 32).await?;
                format = Some(
                    serde_json::from_value::<MongoDumpFormat>(serde_json::Value::String(value))
                        .map_err(|e| AppError::from(e.to_string()))?,
                );
            }
            "gzip" => {
                let value = field_text(field, 16).await?;
                gzip = value.parse::<bool>().map_err(|_| AppError::from("Invalid gzip option".to_string()))?;
            }
            "manifest" if !acquiring => {
                let value = field_text(field, 16 * 1024 * 1024).await?;
                manifest = Some(serde_json::from_str(&value).map_err(|e| AppError::bad_request(e.to_string()))?);
            }
            "request" if acquiring => {
                let value = field_text(field, 1024 * 1024).await?;
                if request.is_some() {
                    return Err(AppError::bad_request("Duplicate restore plan"));
                }
                request = Some(serde_json::from_str(&value).map_err(|e| AppError::bad_request(e.to_string()))?);
                expected_upload = mongodb_dump::mongodb_restore_upload_files(request.as_ref().unwrap())
                    .map_err(AppError::from)?
                    .into_iter()
                    .map(|f| (f.path, f.size_bytes))
                    .collect();
            }
            _ => return Err(AppError::from("Unexpected dump upload field".to_string())),
        }
    }
    let format = format.ok_or_else(|| AppError::from("Dump format is required".to_string()))?;
    if paths.is_empty() && manifest.is_none() {
        return Err(AppError::from("No dump files uploaded".to_string()));
    }
    if acquiring {
        if !expected_upload.is_empty() {
            return Err(AppError::bad_request("Selected restore files are missing"));
        }
        let request = request.ok_or_else(|| AppError::bad_request("Missing restore plan"))?;
        if transfer::is_cancelled(&request.task_id).await {
            return Err(AppError::bad_request("MongoDB dump/restore cancelled"));
        }
        let preview = mongodb_dump::attach_mongodb_restore_upload(&request, upload).await.map_err(AppError::from)?;
        return Ok(Json(serde_json::to_value(preview).map_err(|e| AppError::from(e.to_string()))?));
    }
    if format == MongoDumpFormat::Directory {
        let manifest = manifest.ok_or_else(|| AppError::bad_request("Directory preview requires a file manifest"))?;
        let expected = manifest
            .iter()
            .filter(|f| f.path.ends_with(".metadata.json") || f.path.ends_with(".metadata.json.gz"))
            .collect::<Vec<_>>();
        if expected.len() != paths.len()
            || paths.iter().any(|(name, path)| {
                !expected
                    .iter()
                    .any(|f| f.path == *name && std::fs::metadata(path).is_ok_and(|m| m.len() == f.size_bytes))
            })
        {
            return Err(AppError::bad_request("Uploaded metadata does not match the file manifest"));
        }
        let preview =
            mongodb_dump::prepare_mongodb_directory_catalog(upload, manifest, gzip).await.map_err(AppError::from)?;
        return Ok(Json(serde_json::to_value(preview).map_err(|e| AppError::from(e.to_string()))?));
    }
    let path = match format {
        MongoDumpFormat::Archive if paths.len() == 1 => paths[0].1.clone(),
        MongoDumpFormat::Archive => return Err(AppError::from("Archive restore accepts one file".to_string())),
        MongoDumpFormat::Directory => {
            if paths.iter().any(|(name, _)| FilePath::new(name).components().count() < 2) {
                return Err(AppError::from("Directory uploads require database-relative paths".to_string()));
            }
            upload.path().to_owned()
        }
    };
    let preview = mongodb_dump::prepare_owned_mongodb_restore_source(
        MongoRestoreSourceRequest { path: path.to_string_lossy().into_owned(), format, gzip },
        upload,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(preview).map_err(|e| AppError::from(e.to_string()))?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRef {
    source_ref: String,
}
pub async fn release_source(Json(request): Json<SourceRef>) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "released": mongodb_dump::release_mongodb_restore_source(&request.source_ref) }))
}

#[derive(Deserialize)]
pub struct DumpWrapper {
    request: MongoDatabaseDumpRequest,
}
#[derive(Deserialize)]
pub struct RestoreWrapper {
    request: MongoDatabaseRestoreRequest,
}

enum Task {
    Dump(MongoDatabaseDumpRequest, WebExportFile),
    Restore(MongoDatabaseRestoreRequest),
}

async fn start_task(state: Arc<WebState>, task: Task) -> Result<Json<serde_json::Value>, AppError> {
    let id = match &task {
        Task::Dump(request, _) => &request.task_id,
        Task::Restore(request) => &request.task_id,
    }
    .clone();
    let key = format!("mongo-database:{id}");
    let channel = Arc::new(TransferProgressChannel::new());
    {
        let mut channels = state.transfer_progress_channels.write().await;
        if channels.contains_key(&key) {
            return Err(AppError::from("Database dump/restore task already exists".to_string()));
        }
        channels.insert(key.clone(), channel.clone());
    }
    let task_id = id.clone();
    dbx_core::export_runtime::spawn_export_task(async move {
        let mut latest = MongoDatabaseDumpProgress::initial(&task_id);
        let mut callback = |progress: MongoDatabaseDumpProgress| {
            latest = progress;
            if latest.status == "running" {
                if let Ok(json) = serde_json::to_string(&latest) {
                    channel.send(json, TransferReplayEventKind::Progress);
                }
            }
        };
        let result = match task {
            Task::Dump(request, file) => {
                let result = mongodb_dump::dump_mongodb_database(
                    &state.app,
                    &request,
                    |id| {
                        let id = id.to_string();
                        Box::pin(async move { transfer::is_cancelled(&id).await })
                    },
                    &mut callback,
                )
                .await;
                if result.is_ok() {
                    state.export_files.write().await.insert(task_id.clone(), file);
                }
                result
            }
            Task::Restore(request) => {
                mongodb_dump::restore_mongodb_database(
                    &state.app,
                    &request,
                    |id| {
                        let id = id.to_string();
                        Box::pin(async move { transfer::is_cancelled(&id).await })
                    },
                    &mut callback,
                )
                .await
            }
        };
        if let Err(error) = result {
            latest.error_message = Some(error);
            if latest.status == "running" {
                latest.status = "error".into();
                latest.phase = "done".into();
            }
        }
        if let Ok(json) = serde_json::to_string(&latest) {
            channel.send(json, TransferReplayEventKind::Terminal);
        }
        transfer::clear_cancelled(&task_id).await;
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(60)).await;
            state.transfer_progress_channels.write().await.remove(&key);
        });
    });
    Ok(Json(serde_json::json!({ "taskId": id })))
}

pub async fn start_dump(
    State(state): State<Arc<WebState>>,
    Json(body): Json<DumpWrapper>,
) -> Result<Json<serde_json::Value>, AppError> {
    let mut request = body.request;
    if request.format != MongoDumpFormat::Archive {
        return Err(AppError::from("Web database exports use MongoDB archive format".to_string()));
    }
    let tmp = state.data_dir.join("tmp");
    tokio::fs::create_dir_all(&tmp).await.map_err(|e| AppError::from(e.to_string()))?;
    let ext = if request.gzip { "archive.gz" } else { "archive" };
    let filename = export_download_filename(&request.file_path, &request.database, ext);
    request.file_path =
        tmp.join(format!("mongo_database_{}.{ext}", uuid::Uuid::new_v4())).to_string_lossy().into_owned();
    let file = WebExportFile { file_path: request.file_path.clone(), download_filename: filename, format: ext.into() };
    start_task(state, Task::Dump(request, file)).await
}

pub async fn start_restore(
    State(state): State<Arc<WebState>>,
    Json(body): Json<RestoreWrapper>,
) -> Result<Json<serde_json::Value>, AppError> {
    start_task(state, Task::Restore(body.request)).await
}

pub async fn progress(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
) -> Result<Sse<impl futures::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>>, AppError> {
    let channel = state
        .transfer_progress_channels
        .read()
        .await
        .get(&format!("mongo-database:{id}"))
        .cloned()
        .ok_or_else(|| AppError::from("Database task not found".to_string()))?;
    Ok(crate::sse::sse_from_transfer_channel(channel))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelRequest {
    task_id: String,
}
pub async fn cancel(Json(request): Json<CancelRequest>) -> Json<serde_json::Value> {
    transfer::set_cancelled(&request.task_id).await;
    Json(serde_json::json!({ "cancelled": true }))
}
