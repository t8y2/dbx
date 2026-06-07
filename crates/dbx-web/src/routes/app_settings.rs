use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePinnedTreeNodeIdsRequest {
    pub ids: Vec<String>,
}

pub async fn load_pinned_tree_node_ids(State(state): State<Arc<WebState>>) -> Result<Json<Vec<String>>, AppError> {
    let ids = state.app.storage.load_pinned_tree_node_ids().await.map_err(AppError)?;
    Ok(Json(ids))
}

pub async fn save_pinned_tree_node_ids(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SavePinnedTreeNodeIdsRequest>,
) -> Result<Json<()>, AppError> {
    state.app.storage.save_pinned_tree_node_ids(&body.ids).await.map_err(AppError)?;
    Ok(Json(()))
}
