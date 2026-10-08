use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveLayoutRequest {
    pub layout: serde_json::Value,
}

pub async fn save_sidebar_layout(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SaveLayoutRequest>,
) -> Result<Json<()>, AppError> {
    state.app.storage.save_sidebar_layout(&body.layout).await.map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn load_sidebar_layout(State(state): State<Arc<WebState>>) -> Result<Json<serde_json::Value>, AppError> {
    let layout = state.app.storage.load_sidebar_layout().await.map_err(AppError::from)?;
    let layout = layout.unwrap_or(serde_json::json!(null));
    // T4：非 admin 用户按有效 scope 过滤——移除不可见连接条目与不再含任何
    // 可见连接（且自身未被勾选）的分组，groups 元数据同步裁剪。桌面与
    // DBX_DISABLE_PASSWORD（无用户上下文）维持原行为。
    let layout = match crate::request_context::current_request_user() {
        Some(user) if !user.is_admin => crate::access_gate::filter_sidebar_layout_for_scope(layout, &user.permissions),
        _ => layout,
    };
    Ok(Json(layout))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTableVGroupsRequest {
    pub scope_key: String,
    pub layout: serde_json::Value,
}

pub async fn save_table_vgroups(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SaveTableVGroupsRequest>,
) -> Result<Json<()>, AppError> {
    state.app.storage.save_table_vgroups(&body.scope_key, &body.layout).await.map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn load_table_vgroups(State(state): State<Arc<WebState>>) -> Result<Json<serde_json::Value>, AppError> {
    let layouts = state.app.storage.load_table_vgroups().await.map_err(AppError::from)?;
    Ok(Json(layouts))
}

pub async fn delete_table_vgroups_for_connection(
    State(state): State<Arc<WebState>>,
    axum::extract::Path(connection_id): axum::extract::Path<String>,
) -> Result<Json<()>, AppError> {
    state.app.storage.delete_table_vgroups_for_connection(&connection_id).await.map_err(AppError::from)?;
    Ok(Json(()))
}
