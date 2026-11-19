use crate::{error::AppError, state::WebState};
use axum::{
    body::Body,
    extract::{Path, State},
    http::header,
    response::Response,
    Json,
};
use dbx_core::scheduled_backup::{BackupCommand, BackupService};
use std::{path::PathBuf, sync::Arc};
use tokio_util::io::ReaderStream;

pub fn service(state: &WebState) -> Result<BackupService, String> {
    let root = std::env::var_os("DBX_BACKUP_ROOT").map(PathBuf::from).unwrap_or_else(|| state.data_dir.join("backups"));
    let root = root.canonicalize().map_err(|e| format!("Cannot resolve the server backup root: {e}"))?;
    Ok(BackupService::new(state.app.clone(), &state.data_dir, Some(root)))
}

pub async fn command(
    State(state): State<Arc<WebState>>,
    Json(command): Json<BackupCommand>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(service(&state)?.command(command).await?))
}

pub async fn download(
    State(state): State<Arc<WebState>>,
    Path((id, index)): Path<(String, usize)>,
) -> Result<Response, AppError> {
    let path = service(&state)?.file(&id, index).await?;
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let disposition = super::export_download::attachment_content_disposition(&name);
    let file = tokio::fs::File::open(&path).await.map_err(|e| AppError::from(e.to_string()))?;
    Response::builder()
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_DISPOSITION, disposition)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from_stream(ReaderStream::new(file)))
        .map_err(|e| AppError::from(e.to_string()))
}

pub async fn prepare_restore(
    State(state): State<Arc<WebState>>,
    Path((id, index)): Path<(String, usize)>,
) -> Result<Json<serde_json::Value>, AppError> {
    let source = service(&state)?.file(&id, index).await?;
    Ok(Json(super::sql_file::prepare_backup_preview(&state, source).await?))
}
