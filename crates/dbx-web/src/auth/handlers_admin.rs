//! Admin auth APIs: provider configuration, local user management, active sessions.
//!
//! Every endpoint requires authentication with the admin role (the `AuthContext` is injected by
//! auth_middleware; this module only checks the role — demo-mode blocking of mutating endpoints lives in demo.rs).

use std::sync::Arc;

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHasher};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use dbx_auth::{AuthUserRecord, UserRole};
use serde::{Deserialize, Serialize};

use crate::auth::middleware::AuthContext;
use crate::auth::providers::{
    assemble_registry, build_provider, delete_db_provider, list_providers_for_admin, save_db_provider, ProviderConfigEntry,
};
use crate::state::WebState;

fn forbidden(message: &str) -> Response {
    (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": message }))).into_response()
}

fn require_admin(context: &AuthContext) -> Result<(), Response> {
    if context.role == UserRole::Admin {
        Ok(())
    } else {
        Err(forbidden("admin_required"))
    }
}

// ---------- Providers ----------

#[derive(Serialize)]
pub struct ProviderListResponse {
    pub providers: Vec<crate::auth::providers::AssembledProvider>,
}

/// GET /auth/admin/providers
pub async fn list_providers(State(state): State<Arc<WebState>>, context: axum::Extension<AuthContext>) -> Response {
    if let Err(response) = require_admin(&context.0) {
        return response;
    }
    match list_providers_for_admin(&state).await {
        Ok(providers) => (StatusCode::OK, Json(ProviderListResponse { providers })).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": error }))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct SaveProvidersRequest {
    /// Full set of DB-managed providers (env entries reject writes and are ignored by id).
    pub providers: Vec<ProviderConfigEntry>,
}

/// PUT /auth/admin/providers — replaces the whole DB-managed provider set and hot-reassembles.
pub async fn save_providers(
    State(state): State<Arc<WebState>>,
    context: axum::Extension<AuthContext>,
    Json(body): Json<SaveProvidersRequest>,
) -> Response {
    if let Err(response) = require_admin(&context.0) {
        return response;
    }
    let env_ids: std::collections::HashSet<String> =
        match crate::auth::providers::env_provider_entries() {
            Ok(entries) => entries.into_iter().map(|entry| entry.id).collect(),
            Err(error) => {
                return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": error }))).into_response();
            }
        };

    let mut seen = std::collections::HashSet::new();
    for entry in &body.providers {
        if entry.id.trim().is_empty() || !seen.insert(entry.id.clone()) {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": format!("invalid or duplicate provider id {}", entry.id) })),
            )
                .into_response();
        }
        if env_ids.contains(&entry.id) {
            continue; // env entries are read-only; silently ignore the write
        }
        if let Err(error) = save_db_provider(&state, entry).await {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("save provider {}: {error}", entry.id) })),
            )
                .into_response();
        }
    }
    // Remove existing DB entries absent from this request.
    match state.app.storage.list_auth_providers().await {
        Ok(existing) => {
            for row in existing {
                if !seen.contains(&row.id) {
                    if let Err(error) = delete_db_provider(&state, &row.id).await {
                        log::error!("Failed to delete auth provider {}: {error}", row.id);
                    }
                }
            }
        }
        Err(error) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": error }))).into_response();
        }
    }

    if let Err(error) = assemble_registry(&state).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": error }))).into_response();
    }
    (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
}

#[derive(Deserialize)]
pub struct TestProviderRequest {
    pub kind: String,
    pub config: serde_json::Value,
}

/// POST /auth/admin/providers/test — connectivity test before saving (nothing persisted).
pub async fn test_provider(
    State(state): State<Arc<WebState>>,
    context: axum::Extension<AuthContext>,
    Json(body): Json<TestProviderRequest>,
) -> Response {
    if let Err(response) = require_admin(&context.0) {
        return response;
    }
    let entry = ProviderConfigEntry { id: "test".to_string(), kind: body.kind, label: None, config: body.config, enabled: true, sort_order: 0 };
    match build_provider(&entry, &state.app, false).await {
        Ok(Some(provider)) => match provider.test().await {
            Ok(()) => (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response(),
            Err(error) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": error.to_string() }))).into_response(),
        },
        Ok(None) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "unsupported_kind" }))).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": error }))).into_response(),
    }
}

// ---------- Users ----------

#[derive(Serialize)]
pub struct AdminUserView {
    pub id: String,
    pub username: String,
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub role: String,
    pub provider_id: String,
    pub disabled: bool,
    pub has_password: bool,
    pub created_at: i64,
}

fn user_view(user: &AuthUserRecord) -> AdminUserView {
    AdminUserView {
        id: user.id.clone(),
        username: user.username.clone(),
        display_name: user.display_name.clone(),
        email: user.email.clone(),
        role: user.role.as_str().to_string(),
        provider_id: user.provider_id.clone(),
        disabled: user.disabled,
        has_password: user.password_hash.is_some(),
        created_at: user.created_at,
    }
}

/// GET /auth/admin/users
pub async fn list_users(State(state): State<Arc<WebState>>, context: axum::Extension<AuthContext>) -> Response {
    if let Err(response) = require_admin(&context.0) {
        return response;
    }
    match state.auth_users.list_users().await {
        Ok(users) => {
            let mut views: Vec<AdminUserView> = users.iter().map(user_view).collect();
            views.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.username.cmp(&b.username)));
            (StatusCode::OK, Json(serde_json::json!({ "users": views }))).into_response()
        }
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": error }))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct CreateUserRequest {
    pub username: String,
    pub password: String,
    #[serde(default = "default_role_member")]
    pub role: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
}

fn default_role_member() -> String {
    "member".to_string()
}

/// POST /auth/admin/users — creates a local user.
pub async fn create_user(
    State(state): State<Arc<WebState>>,
    context: axum::Extension<AuthContext>,
    Json(body): Json<CreateUserRequest>,
) -> Response {
    if let Err(response) = require_admin(&context.0) {
        return response;
    }
    let username = body.username.trim();
    if username.is_empty() || body.password.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "username_and_password_required" }))).into_response();
    }
    let Some(role) = UserRole::parse(&body.role) else {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "invalid_role" }))).into_response();
    };
    let salt = SaltString::generate(&mut OsRng);
    let hash = match Argon2::default().hash_password(body.password.as_bytes(), &salt) {
        Ok(hash) => hash.to_string(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let mut user = dbx_auth::new_local_user(username, Some(hash), role);
    user.display_name = body.display_name.filter(|value| !value.is_empty());
    user.email = body.email.filter(|value| !value.is_empty());
    match state.auth_users.create_user(user).await {
        Ok(created) => (StatusCode::OK, Json(serde_json::json!({ "user": user_view(&created) }))).into_response(),
        Err(error) if error.contains("UNIQUE") => {
            (StatusCode::CONFLICT, Json(serde_json::json!({ "error": "username_exists" }))).into_response()
        }
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": error }))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct UpdateUserRequest {
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub disabled: Option<bool>,
    /// Admin reset of a local user's password.
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub display_name: Option<Option<String>>,
    #[serde(default)]
    pub email: Option<Option<String>>,
}

/// Revokes all sessions of a user (called after disable/delete/password reset).
async fn revoke_user_sessions(state: &WebState, user_id: &str) {
    for token in state.sessions.revoke_user(user_id).await {
        dbx_core::query::pl_debug::pl_debug_revoke_web_owner_core(&state.app, &token);
        state.app.session_credentials.clear_owner(&token);
    }
}

/// PATCH /auth/admin/users/{id}
pub async fn update_user(
    State(state): State<Arc<WebState>>,
    context: axum::Extension<AuthContext>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<UpdateUserRequest>,
) -> Response {
    if let Err(response) = require_admin(&context.0) {
        return response;
    }
    let mut user = match state.auth_users.get_user_by_id(&id).await {
        Ok(Some(user)) => user,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(error) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": error }))).into_response(),
    };

    if let Some(role) = body.role.as_deref() {
        match UserRole::parse(role) {
            Some(role) => user.role = role,
            None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "invalid_role" }))).into_response(),
        }
    }
    if let Some(disabled) = body.disabled {
        user.disabled = disabled;
    }
    if let Some(display_name) = body.display_name.clone() {
        user.display_name = display_name.filter(|value| !value.is_empty());
    }
    if let Some(email) = body.email.clone() {
        user.email = email.filter(|value| !value.is_empty());
    }
    if let Some(password) = body.password.as_deref().filter(|value| !value.is_empty()) {
        if user.password_hash.is_none() {
            // External-provider users have no local password to reset.
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "external_user_password" }))).into_response();
        }
        let salt = SaltString::generate(&mut OsRng);
        match Argon2::default().hash_password(password.as_bytes(), &salt) {
            Ok(hash) => user.password_hash = Some(hash.to_string()),
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    }
    user.updated_at = dbx_auth::unix_now();
    if let Err(error) = state.auth_users.update_user(user).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": error }))).into_response();
    }
    // Disabling or resetting the password kicks the user's sessions.
    if body.disabled == Some(true) || body.password.is_some() {
        revoke_user_sessions(&state, &id).await;
    }
    (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
}

/// DELETE /auth/admin/users/{id}
pub async fn delete_user(
    State(state): State<Arc<WebState>>,
    context: axum::Extension<AuthContext>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    if let Err(response) = require_admin(&context.0) {
        return response;
    }
    match state.auth_users.get_user_by_id(&id).await {
        Ok(Some(user)) if user.id == context.0.user_id => {
            return (StatusCode::CONFLICT, Json(serde_json::json!({ "error": "cannot_delete_self" }))).into_response();
        }
        Ok(Some(_)) => {}
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(error) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": error }))).into_response(),
    }
    if let Err(error) = state.auth_users.delete_user(&id).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": error }))).into_response();
    }
    revoke_user_sessions(&state, &id).await;
    (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
}

// ---------- Sessions ----------

/// GET /auth/admin/sessions — active session list (never includes the tokens themselves).
pub async fn list_sessions(State(state): State<Arc<WebState>>, context: axum::Extension<AuthContext>) -> Response {
    if let Err(response) = require_admin(&context.0) {
        return response;
    }
    let sessions = state.sessions.list().await;
    let views: Vec<serde_json::Value> = sessions
        .iter()
        .map(|record| {
            serde_json::json!({
                "username": record.username,
                "role": record.role.as_str(),
                "provider_id": record.provider_id,
                "idle_secs": record.last_seen.elapsed().as_secs(),
                "age_secs": record.created_at.elapsed().as_secs(),
            })
        })
        .collect();
    (StatusCode::OK, Json(serde_json::json!({ "sessions": views }))).into_response()
}
