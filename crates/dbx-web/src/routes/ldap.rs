use axum::{extract::State, Json};
use serde::Deserialize;
use std::sync::Arc;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Debug, Deserialize)]
pub struct LdapSearchRequest {
    pub connection_id: String,
    pub base_dn: String,
    #[serde(default = "default_scope")]
    pub scope: String,
    #[serde(default = "default_filter")]
    pub filter: String,
    #[serde(default)]
    pub attributes: Option<Vec<String>>,
    #[serde(default)]
    pub size_limit: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct LdapListChildrenRequest {
    pub connection_id: String,
    pub base_dn: String,
    #[serde(default)]
    pub size_limit: Option<i32>,
}

fn default_scope() -> String {
    "sub".to_string()
}

fn default_filter() -> String {
    "(objectClass=*)".to_string()
}

/// Clamp the caller-supplied size limit to a bounded range so a single
/// request can never pull an unbounded result set. Mirrors the hard cap in
/// the driver (`MAX_LDAP_SEARCH_SIZE`).
fn clamp_size_limit(limit: Option<i32>) -> Option<i32> {
    limit.map(|n| n.clamp(1, 100))
}

pub async fn search(
    State(state): State<Arc<WebState>>,
    Json(request): Json<LdapSearchRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::ldap_ops::ldap_search_core(
        &state.app,
        &request.connection_id,
        &request.base_dn,
        &request.scope,
        &request.filter,
        request.attributes.as_deref(),
        clamp_size_limit(request.size_limit),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

/// Children of a base DN (`scope = one`, `filter = (objectClass=*)`) used by
/// the sidebar tree-builder. Mirrors the existing `ldap_search` request
/// shape so the frontend can drop it in without code changes.
pub async fn list_children(
    State(state): State<Arc<WebState>>,
    Json(request): Json<LdapListChildrenRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::ldap_ops::ldap_list_children_core(
        &state.app,
        &request.connection_id,
        &request.base_dn,
        clamp_size_limit(request.size_limit),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}
