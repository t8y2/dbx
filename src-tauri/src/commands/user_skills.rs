//! Tauri command layer for user-level SKILL.md skills (prd 09-21-public-skill-loader).
//!
//! The discovery, path-boundary and frontmatter logic lives in
//! [`dbx_core::skills`] because the AI agent loop needs exactly the same rules
//! (prd 09-30-skill-listing-use-skill). This module is only the transport
//! adapter: it keeps the command names, parameter names and camelCase JSON
//! shapes the frontend already depends on, and offloads the blocking
//! filesystem work off the async runtime.

use dbx_core::skills::{self, UserSkillsListResult, UserSkillsReadResult};

/// Lists skill metadata for both roots. The default root is always scanned;
/// the custom root only when it is enabled in Settings. An absent root yields
/// an empty listing rather than an error.
#[tauri::command]
pub async fn list_user_skills(
    custom_root_enabled: bool,
    custom_root: Option<String>,
) -> Result<UserSkillsListResult, String> {
    tauri::async_runtime::spawn_blocking(move || skills::list_skills(custom_root_enabled, custom_root.as_deref()))
        .await
        .map_err(|error| error.to_string())
}

/// Reads the currently selected skills by id. Every id is resolved only
/// through re-derivation over a fresh scan of the owning root, so a deleted,
/// moved, or root-escaping skill fails instead of silently resolving to a
/// stale path.
#[tauri::command]
pub async fn read_user_skills(
    ids: Vec<String>,
    custom_root_enabled: bool,
    custom_root: Option<String>,
) -> Result<UserSkillsReadResult, String> {
    tauri::async_runtime::spawn_blocking(move || skills::read_skills(&ids, custom_root_enabled, custom_root.as_deref()))
        .await
        .map_err(|error| error.to_string())
}
