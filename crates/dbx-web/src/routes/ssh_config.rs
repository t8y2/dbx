use axum::Json;
use dbx_core::ssh_config::{self, SshConfigHostEntry};

use crate::error::AppError;

pub async fn list_ssh_config_hosts() -> Result<Json<Vec<SshConfigHostEntry>>, AppError> {
    Ok(Json(ssh_config::list_hosts().map_err(AppError::internal)?))
}
