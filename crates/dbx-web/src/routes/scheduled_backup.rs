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
    // 触达连接的备份命令（Run/Save/Preview/Migrate）按其 config.connection_id 做
    // 连接可见范围校验；纯调度管理命令（Snapshot/Cancel/Rename/DeleteRuns/File）
    // 不触达连接。Run 仅带 schedule_id（config=None）时连接藏在已存计划内，
    // handler 层无法解析，依赖 backup.restore 权限门兑底（见 T4 交付报告遗留）。
    for connection_id in backup_command_connection_ids(&command) {
        crate::access_gate::ensure_web_connection_scope(&state, connection_id).await?;
    }
    Ok(Json(service(&state)?.command(command).await?))
}

fn backup_command_connection_ids(command: &BackupCommand) -> Vec<&str> {
    match command {
        BackupCommand::Run { request } => {
            request.config.as_ref().map(|config| vec![config.connection_id.as_str()]).unwrap_or_default()
        }
        BackupCommand::Save { schedule } | BackupCommand::Preview { schedule } => {
            vec![schedule.config.connection_id.as_str()]
        }
        BackupCommand::Migrate { migration } => {
            migration.schedules.iter().map(|schedule| schedule.config.connection_id.as_str()).collect()
        }
        _ => Vec::new(),
    }
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
