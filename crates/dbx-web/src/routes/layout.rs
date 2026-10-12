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
    // 非 admin Web 会话按 scope 过滤（与 load_connections 的连接过滤同语义）：
    // 不可见连接条目移除，过滤后无可见后代且自身未被勾选的分组整个裁剪，
    // groups 元数据同步收缩——分组结构不再泄露给受限用户。桌面直连与
    // DBX_DISABLE_PASSWORD（无用户上下文）维持原行为。
    let layout = match crate::request_context::current_request_user() {
        Some(user) if !user.is_admin => crate::access_gate::filter_sidebar_layout_for_scope(
            layout.unwrap_or(serde_json::json!(null)),
            &user.permissions,
        ),
        _ => layout.unwrap_or(serde_json::json!(null)),
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
