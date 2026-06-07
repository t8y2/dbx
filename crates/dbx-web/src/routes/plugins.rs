use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use dbx_core::plugins::InstalledPlugin;

use crate::error::AppError;
use crate::state::WebState;

pub async fn list_plugins(State(state): State<Arc<WebState>>) -> Result<Json<Vec<InstalledPlugin>>, AppError> {
    state.app.plugins.list_installed().map(Json).map_err(AppError)
}
