use std::path::{Path as StdPath, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use axum::body::{Body, Bytes};
use axum::extract::{Multipart, Path, State};
use axum::http::{header, StatusCode};
use axum::response::sse::Event;
use axum::response::{Response, Sse};
use axum::Json;
use dbx_core::mongodb_import_export::{
    self, MongoExportFormat, MongoExportProgress, MongoExportRequest, MongoExportStatus, MongoImportParseOptions,
    MongoImportPhase, MongoImportPreviewRequest, MongoImportProgress, MongoImportRequest, MongoImportStatus,
};
use dbx_core::transfer;
use futures::stream::Stream;
use futures::StreamExt;
use serde::Deserialize;
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

use crate::error::AppError;
use crate::routes::export_download::{attachment_content_disposition, export_download_filename};
use crate::sse::{TransferProgressChannel, TransferReplayEventKind};
use crate::state::{WebExportFile, WebState};

const MONGO_IMPORT_PROGRESS_TTL: Duration = Duration::from_secs(30);

struct RemoveFileOnDrop(PathBuf);

impl Drop for RemoveFileOnDrop {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

struct ExportDownloadStream {
    // Fields are dropped in declaration order, so Windows closes the file before deleting it.
    chunks: ReaderStream<tokio::fs::File>,
    _cleanup: RemoveFileOnDrop,
}

impl Stream for ExportDownloadStream {
    type Item = std::io::Result<Bytes>;

    fn poll_next(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        std::pin::Pin::new(&mut self.get_mut().chunks).poll_next(cx)
    }
}

fn initial_import_progress(import_id: &str, started_at: Instant) -> MongoImportProgress {
    MongoImportProgress {
        import_id: import_id.to_string(),
        phase: MongoImportPhase::Preparing,
        status: MongoImportStatus::Running,
        rows_read: 0,
        rows_inserted: 0,
        rows_failed: 0,
        batches_committed: 0,
        total_rows: None,
        error_rows: Vec::new(),
        error_message: None,
        elapsed_ms: started_at.elapsed().as_millis(),
    }
}

fn send_import_progress(tx: &tokio::sync::watch::Sender<String>, progress: &MongoImportProgress) {
    if let Ok(json) = serde_json::to_string(progress) {
        tx.send_replace(json);
    }
}

fn schedule_import_progress_cleanup(state: Arc<WebState>, import_id: String) {
    tokio::spawn(async move {
        tokio::time::sleep(MONGO_IMPORT_PROGRESS_TTL).await;
        state.table_import_channels.write().await.remove(&import_id);
    });
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteImportWrapper {
    pub request: MongoImportRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelImportRequest {
    pub import_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewUploadedImportRequest {
    pub source_ref: String,
    pub format: mongodb_import_export::MongoImportFormat,
    #[serde(default)]
    pub parse_options: MongoImportParseOptions,
    #[serde(default)]
    pub preview_limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseImportSourceRequest {
    pub source_ref: String,
}

pub async fn preview_import(
    State(state): State<Arc<WebState>>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, AppError> {
    let tmp_dir = import_upload_dir(&state.data_dir);
    std::fs::create_dir_all(&tmp_dir).map_err(|e| AppError::from(e.to_string()))?;
    cleanup_expired_import_uploads(&tmp_dir, Duration::from_secs(24 * 60 * 60));

    let mut uploaded_file: Option<(String, PathBuf)> = None;
    let mut format = None;
    let mut parse_options = MongoImportParseOptions::default();
    let mut preview_limit: Option<usize> = None;

    loop {
        let field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(error) => {
                cleanup_pending_upload(&uploaded_file).await;
                return Err(AppError::from(error.to_string()));
            }
        };
        let name = field.name().unwrap_or_default().to_string();
        if name == "file" {
            if uploaded_file.is_some() {
                cleanup_pending_upload(&uploaded_file).await;
                return Err(AppError::from("Only one import file may be uploaded".to_string()));
            }
            let file_name = field.file_name().unwrap_or("upload.csv").to_string();
            let source_ref = uuid::Uuid::new_v4().to_string();
            let file_path = safe_uploaded_import_path(&tmp_dir, &file_name, &source_ref)?;
            if let Err(error) = write_import_upload(field, &file_path).await {
                cleanup_uploaded_import_path(&file_path).await;
                return Err(error);
            }
            uploaded_file = Some((source_ref, file_path));
        } else {
            let value = match field.text().await {
                Ok(value) => value,
                Err(error) => {
                    cleanup_pending_upload(&uploaded_file).await;
                    return Err(AppError::from(error.to_string()));
                }
            };
            match name.as_str() {
                "format" => {
                    format = match serde_json::from_value(serde_json::Value::String(value)) {
                        Ok(format) => Some(format),
                        Err(error) => {
                            cleanup_pending_upload(&uploaded_file).await;
                            return Err(AppError::from(error.to_string()));
                        }
                    };
                }
                "parseOptions" => {
                    parse_options = match serde_json::from_str(&value) {
                        Ok(parse_options) => parse_options,
                        Err(error) => {
                            cleanup_pending_upload(&uploaded_file).await;
                            return Err(AppError::from(error.to_string()));
                        }
                    };
                }
                "previewLimit" => preview_limit = value.parse::<usize>().ok(),
                _ => {}
            }
        }
    }

    if let Some((source_ref, file_path)) = uploaded_file {
        let file_path_str = file_path.to_string_lossy().to_string();
        let format = match format {
            Some(format) => format,
            None => {
                cleanup_uploaded_import_path(&file_path).await;
                return Err(AppError::from("MongoDB import format is required".to_string()));
            }
        };
        let preview = mongodb_import_export::preview_mongodb_import_file(&MongoImportPreviewRequest {
            file_path: file_path_str,
            source_ref: Some(source_ref),
            format,
            parse_options,
            preview_limit,
        });
        let preview = match preview {
            Ok(preview) => preview,
            Err(error) => {
                cleanup_uploaded_import_path(&file_path).await;
                return Err(AppError::from(error.display_message()));
            }
        };
        return serde_json::to_value(preview).map(Json).map_err(|error| AppError::from(error.to_string()));
    }

    Err(AppError::from("No file uploaded".to_string()))
}

pub async fn preview_uploaded_import(
    State(state): State<Arc<WebState>>,
    Json(request): Json<PreviewUploadedImportRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let file_path = uploaded_import_path_for_source_ref(&state.data_dir, &request.source_ref)?;
    let preview = mongodb_import_export::preview_mongodb_import_file(&MongoImportPreviewRequest {
        file_path: file_path.to_string_lossy().to_string(),
        source_ref: Some(request.source_ref),
        format: request.format,
        parse_options: request.parse_options,
        preview_limit: request.preview_limit,
    })
    .map_err(|error| AppError::from(error.display_message()))?;
    serde_json::to_value(preview).map(Json).map_err(|error| AppError::from(error.to_string()))
}

pub async fn release_import_source(
    State(state): State<Arc<WebState>>,
    Json(request): Json<ReleaseImportSourceRequest>,
) -> Json<serde_json::Value> {
    let released = match uploaded_import_path_for_source_ref(&state.data_dir, &request.source_ref) {
        Ok(file_path) => tokio::fs::remove_file(file_path).await.is_ok(),
        Err(_) => false,
    };
    Json(serde_json::json!({ "released": released }))
}

async fn write_import_upload(field: axum::extract::multipart::Field<'_>, file_path: &StdPath) -> Result<(), AppError> {
    write_import_upload_stream(field, file_path, crate::web_body_limit_bytes()).await
}

async fn write_import_upload_stream<S, E>(
    mut chunks: S,
    file_path: &StdPath,
    max_upload_bytes: usize,
) -> Result<(), AppError>
where
    S: Stream<Item = Result<Bytes, E>> + Unpin,
    E: std::fmt::Display,
{
    let mut upload = tokio::fs::File::create(file_path).await.map_err(|error| AppError::from(error.to_string()))?;
    let mut uploaded_bytes = 0usize;
    let result = async {
        while let Some(chunk) = chunks.next().await {
            let chunk = chunk.map_err(|error| AppError::from(error.to_string()))?;
            uploaded_bytes = uploaded_bytes.saturating_add(chunk.len());
            if uploaded_bytes > max_upload_bytes {
                return Err(AppError::from(format!(
                    "File too large: {uploaded_bytes} bytes received (max {max_upload_bytes} bytes)"
                )));
            }
            upload.write_all(&chunk).await.map_err(|error| AppError::from(error.to_string()))?;
        }
        upload.flush().await.map_err(|error| AppError::from(error.to_string()))
    }
    .await;
    drop(upload);
    if result.is_err() {
        cleanup_uploaded_import_path(file_path).await;
    }
    result
}

pub async fn execute_import(
    State(state): State<Arc<WebState>>,
    Json(body): Json<ExecuteImportWrapper>,
) -> Result<Json<serde_json::Value>, AppError> {
    let started_at = Instant::now();
    let mut req = body.request;
    let file_path = validated_uploaded_import_path(&state.data_dir, &req.file_path)?;
    req.file_path = file_path.to_string_lossy().to_string();

    if let Some(name) = dbx_core::query::connection_readonly_name(&state.app, &req.connection_id).await {
        cleanup_uploaded_import_source(&req.file_path).await;
        return Err(AppError::from(format!(
            "Read-only mode: connection '{name}' has read-only protection enabled. Import blocked."
        )));
    }

    let import_id = req.import_id.clone();
    let initial_progress = serde_json::to_string(&initial_import_progress(&import_id, started_at))
        .map_err(|error| AppError::from(error.to_string()))?;
    let (tx, _) = tokio::sync::watch::channel(initial_progress);
    state.table_import_channels.write().await.insert(import_id.clone(), tx.clone());

    let app = state.app.clone();
    let state_clone = state.clone();
    tokio::spawn(async move {
        let tx_clone = tx.clone();
        let result = mongodb_import_export::import_mongodb_file_core(
            &app,
            &req,
            |id| {
                let id = id.to_string();
                Box::pin(async move { transfer::is_cancelled(&id).await })
            },
            |progress| send_import_progress(&tx_clone, &progress),
        )
        .await;
        if let Err(error) = result {
            let current = tx.borrow().clone();
            if let Ok(mut progress) = serde_json::from_str::<MongoImportProgress>(&current) {
                if progress.status == MongoImportStatus::Running {
                    progress.phase = MongoImportPhase::Done;
                    progress.status = MongoImportStatus::Error;
                    progress.error_message = Some(error.display_message());
                    send_import_progress(&tx, &progress);
                }
            }
        }
        cleanup_uploaded_import_source(&req.file_path).await;
        schedule_import_progress_cleanup(state_clone, req.import_id.clone());
    });

    Ok(Json(serde_json::json!({ "importId": import_id })))
}

pub async fn import_progress(
    State(state): State<Arc<WebState>>,
    Path(import_id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, AppError> {
    let channels = state.table_import_channels.read().await;
    let tx = channels.get(&import_id).ok_or_else(|| AppError::from("Import not found".to_string()))?;
    let rx = tx.subscribe();
    drop(channels);
    Ok(crate::sse::sse_from_watch(rx))
}

pub async fn cancel_import(
    State(_state): State<Arc<WebState>>,
    Json(req): Json<CancelImportRequest>,
) -> Json<serde_json::Value> {
    transfer::set_cancelled(&req.import_id).await;
    Json(serde_json::json!({ "cancelled": true }))
}

fn import_upload_dir(data_dir: &StdPath) -> PathBuf {
    data_dir.join("tmp").join("mongo_import")
}

fn safe_uploaded_import_path(tmp_dir: &StdPath, file_name: &str, source_ref: &str) -> Result<PathBuf, AppError> {
    let base_name = file_name.rsplit(['/', '\\']).find(|part| !part.is_empty()).unwrap_or("upload.csv").trim();
    if base_name.is_empty() || base_name == "." || base_name == ".." {
        return Err(AppError::from("Invalid import file name".to_string()));
    }
    Ok(tmp_dir.join(format!("{source_ref}-{base_name}")))
}

fn validated_uploaded_import_path(data_dir: &StdPath, file_path: &str) -> Result<PathBuf, AppError> {
    let path = PathBuf::from(file_path);
    if !path.is_absolute() {
        return Err(AppError::from("Import source path must be absolute".to_string()));
    }
    let tmp_dir = import_upload_dir(data_dir).canonicalize().map_err(|e| AppError::from(e.to_string()))?;
    let canonical_path =
        path.canonicalize().map_err(|e| AppError::from(format!("Import source is no longer available: {e}")))?;
    if !canonical_path.starts_with(&tmp_dir) {
        return Err(AppError::from("Import source must be inside the uploaded MongoDB import directory".to_string()));
    }
    Ok(canonical_path)
}

fn uploaded_import_path_for_source_ref(data_dir: &StdPath, source_ref: &str) -> Result<PathBuf, AppError> {
    uuid::Uuid::parse_str(source_ref).map_err(|_| AppError::from("Invalid import source reference".to_string()))?;
    let tmp_dir = import_upload_dir(data_dir);
    let prefix = format!("{source_ref}-");
    let mut matches = std::fs::read_dir(&tmp_dir)
        .map_err(|_| AppError::from("Import source is no longer available".to_string()))?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
        .map(|entry| entry.path());
    let file_path = matches.next().ok_or_else(|| AppError::from("Import source is no longer available".to_string()))?;
    if matches.next().is_some() {
        return Err(AppError::from("Import source reference is ambiguous".to_string()));
    }
    validated_uploaded_import_path(data_dir, &file_path.to_string_lossy())
}

fn cleanup_expired_import_uploads(tmp_dir: &StdPath, max_age: Duration) {
    let Ok(entries) = std::fs::read_dir(tmp_dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if now.duration_since(modified).map(|age| age > max_age).unwrap_or(false) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

async fn cleanup_uploaded_import_source(file_path: &str) {
    let _ = tokio::fs::remove_file(file_path).await;
}

async fn cleanup_uploaded_import_path(file_path: &StdPath) {
    let _ = tokio::fs::remove_file(file_path).await;
}

async fn cleanup_pending_upload(uploaded_file: &Option<(String, PathBuf)>) {
    if let Some((_, file_path)) = uploaded_file {
        cleanup_uploaded_import_path(file_path).await;
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartExportRequest {
    pub request: MongoExportRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelExportRequest {
    pub export_id: String,
}

pub async fn start_export(
    State(state): State<Arc<WebState>>,
    Json(body): Json<StartExportRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let mut req = body.request;
    let export_id = req.export_id.clone();
    let tmp_dir = state.data_dir.join("tmp");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| AppError::from(e.to_string()))?;
    let ext = match req.format {
        MongoExportFormat::Csv => "csv",
        MongoExportFormat::Ndjson => "ndjson",
        MongoExportFormat::Bson if req.gzip => "bson.gz",
        MongoExportFormat::Bson => "bson",
    };
    let tmp_file = tmp_dir.join(format!("mongo_export_{}.{ext}", uuid::Uuid::new_v4()));
    let file_path = tmp_file.to_string_lossy().to_string();
    let download_filename = export_download_filename(&req.file_path, &req.collection, ext);
    req.file_path = file_path.clone();

    let export_file = WebExportFile { file_path, download_filename, format: ext.to_string() };
    let channel_key = format!("mongo-export:{export_id}");
    let tx = {
        let mut channels = state.transfer_progress_channels.write().await;
        let channel = Arc::new(TransferProgressChannel::new());
        channels.insert(channel_key.clone(), channel.clone());
        channel
    };

    let app = state.app.clone();
    let state_clone = state.clone();
    dbx_core::export_runtime::spawn_export_task(async move {
        let mut latest = MongoExportProgress {
            export_id: req.export_id.clone(),
            status: MongoExportStatus::Running,
            documents_read: 0,
            bytes_written: 0,
            total_documents: None,
            error_message: None,
            elapsed_ms: 0,
        };
        let result = mongodb_import_export::export_mongodb_query_core(
            &app,
            &req,
            |id| {
                let id = id.to_string();
                Box::pin(async move { transfer::is_cancelled(&id).await })
            },
            |progress| {
                latest = progress;
                if latest.status == MongoExportStatus::Running {
                    if let Ok(json) = serde_json::to_string(&latest) {
                        tx.send(json, TransferReplayEventKind::Progress);
                    }
                }
            },
        )
        .await;

        match result {
            Ok(_) => {
                // The download must exist before a terminal event can reach the browser.
                state_clone.export_files.write().await.insert(req.export_id.clone(), export_file);
            }
            Err(error) => {
                let _ = tokio::fs::remove_file(&req.file_path).await;
                if latest.status != MongoExportStatus::Cancelled {
                    latest.status = MongoExportStatus::Error;
                }
                latest.error_message = Some(error);
            }
        }
        if let Ok(json) = serde_json::to_string(&latest) {
            tx.send(json, TransferReplayEventKind::Terminal);
        }
        transfer::clear_cancelled(&req.export_id).await;

        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(30)).await;
            state_clone.transfer_progress_channels.write().await.remove(&channel_key);
        });
    });

    Ok(Json(serde_json::json!({ "exportId": export_id })))
}

pub async fn export_progress(
    State(state): State<Arc<WebState>>,
    Path(export_id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>>, AppError> {
    let channel = state
        .transfer_progress_channels
        .read()
        .await
        .get(&format!("mongo-export:{export_id}"))
        .cloned()
        .ok_or_else(|| AppError::from("Export not found".to_string()))?;
    Ok(crate::sse::sse_from_transfer_channel(channel))
}

pub async fn cancel_export(
    State(_state): State<Arc<WebState>>,
    Json(req): Json<CancelExportRequest>,
) -> Json<serde_json::Value> {
    transfer::set_cancelled(&req.export_id).await;
    Json(serde_json::json!({ "cancelled": true }))
}

pub async fn export_download(
    State(state): State<Arc<WebState>>,
    Path(export_id): Path<String>,
) -> Result<Response, AppError> {
    let export_file = state
        .export_files
        .write()
        .await
        .remove(&export_id)
        .ok_or_else(|| AppError::from("Export file not found".to_string()))?;
    export_file_response(export_file).await
}

pub(crate) async fn export_file_response(export_file: WebExportFile) -> Result<Response, AppError> {
    let file = tokio::fs::File::open(&export_file.file_path).await.map_err(|e| AppError::from(e.to_string()))?;
    let content_type = match export_file.format.as_str() {
        "csv" => "text/csv; charset=utf-8",
        "ndjson" => "application/x-ndjson; charset=utf-8",
        "bson.gz" | "archive.gz" => "application/gzip",
        "bson" => "application/bson",
        _ => "application/octet-stream",
    };
    let download = ExportDownloadStream {
        chunks: ReaderStream::new(file),
        _cleanup: RemoveFileOnDrop(PathBuf::from(&export_file.file_path)),
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_DISPOSITION, attachment_content_disposition(&export_file.download_filename))
        .body(Body::from_stream(download))
        .map_err(|error| AppError::from(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn download_keeps_file_until_body_is_consumed_or_abandoned() {
        for extension in ["bson", "bson.gz"] {
            for consume in [true, false] {
                let directory = tempfile::tempdir().unwrap();
                let path = directory.path().join(format!("records.{extension}"));
                let bytes = vec![42u8; 100_000];
                std::fs::write(&path, &bytes).unwrap();
                let response = export_file_response(WebExportFile {
                    file_path: path.to_str().unwrap().into(),
                    download_filename: format!("records.{extension}"),
                    format: extension.into(),
                })
                .await
                .unwrap_or_else(|error| panic!("{}", error.message));
                assert!(path.exists(), "download file was removed before streaming");
                assert_eq!(
                    response.headers()[header::CONTENT_TYPE],
                    if extension == "bson" { "application/bson" } else { "application/gzip" }
                );
                assert!(response.headers()[header::CONTENT_DISPOSITION]
                    .to_str()
                    .unwrap()
                    .contains(&format!("records.{extension}")));
                if consume {
                    assert_eq!(axum::body::to_bytes(response.into_body(), bytes.len()).await.unwrap(), bytes);
                } else {
                    let mut stream = response.into_body().into_data_stream();
                    assert!(!stream.next().await.unwrap().unwrap().is_empty());
                    drop(stream);
                }
                assert!(!path.exists(), "download file leaked after the response ended");
            }
        }
    }

    #[tokio::test]
    async fn export_failure_and_cancellation_are_replayed_to_late_subscribers() {
        use axum::response::IntoResponse;
        use dbx_core::{connection::AppState, storage::Storage};

        for cancelled in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let storage = Storage::open(&directory.path().join("storage.db")).await.unwrap();
            let state = Arc::new(WebState::for_tests(Arc::new(AppState::new(storage)), directory.path().into()));
            let id = uuid::Uuid::new_v4().to_string();
            let expected = if cancelled { MongoExportStatus::Cancelled } else { MongoExportStatus::Error };
            if cancelled {
                transfer::set_cancelled(&id).await;
            }
            let Json(started) = start_export(
                State(state.clone()),
                Json(StartExportRequest {
                    request: MongoExportRequest {
                        export_id: id.clone(),
                        connection_id: "missing".into(),
                        database: "test".into(),
                        collection: "empty".into(),
                        filter: None,
                        projection: None,
                        sort: None,
                        collation: None,
                        format: MongoExportFormat::Bson,
                        gzip: false,
                        include_header: false,
                        file_path: "empty.bson".into(),
                        execution_id: None,
                    },
                }),
            )
            .await
            .unwrap_or_else(|error| panic!("{}", error.message));
            assert_eq!(started["exportId"], id);
            let key = format!("mongo-export:{id}");
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let latest = state.transfer_progress_channels.read().await.get(&key).unwrap().latest();
                    if latest.is_some_and(|json| {
                        serde_json::from_str::<MongoExportProgress>(&json).unwrap().status == expected
                    }) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            assert!(!state.export_files.read().await.contains_key(&id));
            let response = export_progress(State(state.clone()), Path(id))
                .await
                .unwrap_or_else(|error| panic!("{}", error.message));
            let mut stream = response.into_response().into_body().into_data_stream();
            let chunk = tokio::time::timeout(Duration::from_secs(1), stream.next()).await.unwrap().unwrap().unwrap();
            assert!(String::from_utf8_lossy(&chunk)
                .contains(&format!("\"status\":{}", serde_json::to_string(&expected).unwrap())));
        }
    }

    #[tokio::test]
    async fn early_import_failure_finishes_progress_and_cleans_source() {
        use dbx_core::{connection::AppState, storage::Storage};

        let directory = tempfile::tempdir().unwrap();
        let storage = Storage::open(&directory.path().join("storage.db")).await.unwrap();
        let state = Arc::new(WebState::for_tests(Arc::new(AppState::new(storage)), directory.path().into()));
        let upload_dir = import_upload_dir(directory.path());
        std::fs::create_dir_all(&upload_dir).unwrap();
        let path = upload_dir.join("empty.bson");
        std::fs::write(&path, []).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let Json(started) = execute_import(
            State(state.clone()),
            Json(ExecuteImportWrapper {
                request: MongoImportRequest {
                    import_id: id.clone(),
                    connection_id: "missing".into(),
                    database: "test".into(),
                    collection: "empty".into(),
                    file_path: path.to_str().unwrap().into(),
                    source_ref: None,
                    format: mongodb_import_export::MongoImportFormat::Bson,
                    parse_options: Default::default(),
                    batch_size: 1,
                    execution_id: None,
                },
            }),
        )
        .await
        .unwrap_or_else(|error| panic!("{}", error.message));
        assert_eq!(started["importId"], id);
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let progress = state.table_import_channels.read().await.get(&id).unwrap().borrow().clone();
                let progress: MongoImportProgress = serde_json::from_str(&progress).unwrap();
                if progress.status == MongoImportStatus::Error && !path.exists() {
                    assert_eq!(progress.phase, MongoImportPhase::Done);
                    assert!(progress.error_message.unwrap().contains("Batch size"));
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }

    #[test]
    fn source_ref_rejects_path_traversal() {
        let data_dir = std::env::temp_dir().join(format!("dbx-mongo-import-data-{}", uuid::Uuid::new_v4()));
        let upload_dir = import_upload_dir(&data_dir);
        std::fs::create_dir_all(&upload_dir).unwrap();
        let source_ref = uuid::Uuid::new_v4().to_string();
        let file_path = upload_dir.join(format!("{source_ref}-users.csv"));
        std::fs::write(&file_path, b"id,name\n1,Ada\n").unwrap();

        let resolved = uploaded_import_path_for_source_ref(&data_dir, &source_ref)
            .unwrap_or_else(|error| panic!("failed to resolve uploaded source: {}", error.message));
        assert_eq!(resolved, file_path.canonicalize().unwrap());
        assert!(uploaded_import_path_for_source_ref(&data_dir, "../users.csv").is_err());
        assert!(uploaded_import_path_for_source_ref(&data_dir, &uuid::Uuid::new_v4().to_string()).is_err());
        let _ = std::fs::remove_dir_all(data_dir);
    }
}
