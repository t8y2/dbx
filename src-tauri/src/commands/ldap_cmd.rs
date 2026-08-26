use std::sync::Arc;

use serde_json::Value;
use tauri::State;

use crate::commands::connection::AppState;
use dbx_core::ldap_ops::{ldap_list_children_core, ldap_search_core};

/// Clamp the caller-supplied size limit to a bounded range so a single request
/// can never pull an unbounded result set. Mirrors the web route and the hard
/// cap in the driver (`MAX_LDAP_SEARCH_SIZE`).
fn clamp_size_limit(limit: Option<i32>) -> Option<i32> {
    limit.map(|n| n.clamp(1, 100))
}

#[tauri::command]
pub async fn ldap_search(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    base_dn: String,
    scope: Option<String>,
    filter: Option<String>,
    attributes: Option<Vec<String>>,
    size_limit: Option<i32>,
) -> Result<Value, String> {
    ldap_search_core(
        &state,
        &connection_id,
        &base_dn,
        scope.as_deref().unwrap_or("sub"),
        filter.as_deref().unwrap_or("(objectClass=*)"),
        attributes.as_deref(),
        clamp_size_limit(size_limit),
    )
    .await
}

#[tauri::command]
pub async fn ldap_list_children(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    base_dn: String,
    size_limit: Option<i32>,
) -> Result<Value, String> {
    ldap_list_children_core(&state, &connection_id, &base_dn, clamp_size_limit(size_limit)).await
}
