//! Auth endpoints: form login, first-run setup, session check, password change, logout.

use std::sync::Arc;

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use dbx_auth::provider::form_requires_username;
use dbx_auth::{AuthError, LoginMode, ProviderInfo};
use serde::{Deserialize, Serialize};

use crate::auth::cookies::{clear_session_cookie, extract_session_token, session_cookie, session_token_from_headers};
use crate::captcha::CAPTCHA_TTL;
use crate::state::WebState;

const LOCAL_PROVIDER_ID: &str = dbx_auth::providers::local::LOCAL_PROVIDER_ID;

/// Default admin username for first-run setup when none is provided (matches the legacy migration).
pub const LOCAL_ADMIN_SETUP_USERNAME: &str = "admin";

#[derive(Deserialize)]
pub struct LoginRequest {
    /// Required when the form provider needs a username; single-local-account deployments may omit it
    /// (compatible with the legacy password-only request body).
    #[serde(default)]
    pub username: Option<String>,
    pub password: String,
    /// Form-provider routing. When omitted and exactly one form provider is enabled, that one is used.
    #[serde(default)]
    pub provider: Option<String>,
    /// Challenge id returned by `GET /auth/captcha`. Optional at the type level
    /// so `auth::setup` can reuse this body; `auth::login` rejects a missing or
    /// stale pair with `captcha_invalid`.
    #[serde(default)]
    pub captcha_id: Option<String>,
    #[serde(default)]
    pub captcha_code: Option<String>,
}

#[derive(Serialize)]
pub struct CaptchaResponse {
    pub id: String,
    /// `data:image/png;base64,...` so the client needs no second request and
    /// the challenge cannot be cached by an intermediary.
    pub image: String,
    pub expires_in: u64,
}

#[derive(Deserialize)]
pub struct ChangePasswordRequest {
    pub old_password: String,
    pub new_password: String,
}

#[derive(Serialize)]
pub struct AuthCheckResponse {
    pub authenticated: bool,
    pub required: bool,
    pub setup_required: bool,
    /// Providers available on the login page (including SSO buttons).
    pub providers: Vec<ProviderInfo>,
    /// Current identity when authenticated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<dbx_auth::SessionUserSummary>,
}

/// Login-page provider descriptions; `requires_username` factors in the local account count.
pub(crate) async fn provider_infos(state: &WebState) -> Vec<ProviderInfo> {
    let providers = state.auth_registry.list();
    let local_count = if providers.iter().any(|provider| provider.kind() == dbx_auth::AuthProviderKind::Local) {
        state
            .auth_users
            .list_users()
            .await
            .map(|users| {
                users
                    .iter()
                    .filter(|user| user.provider_id == LOCAL_PROVIDER_ID && user.password_hash.is_some())
                    .count()
            })
            .unwrap_or(0)
    } else {
        0
    };
    providers
        .iter()
        .map(|provider| {
            let mode = provider.login_mode();
            ProviderInfo {
                id: provider.id().to_string(),
                kind: provider.kind(),
                label: provider.label().to_string(),
                mode: mode.as_str(),
                requires_username: matches!(mode, LoginMode::Form) && form_requires_username(provider.kind(), local_count),
            }
        })
        .collect()
}

/// Issue a login challenge. Unauthenticated by design (it is the pre-login
/// handshake), but bounded: `CaptchaStore` caps pending entries and expires
/// them, so this endpoint cannot be turned into a memory sink.
pub async fn captcha(State(state): State<Arc<WebState>>) -> Response {
    // `auto` only asks for a challenge once an attempt has failed, and `off`
    // never does, so the form decides from this response whether to show the
    // field at all.
    let failed_attempts = state.login_rate_limit.total_failures().await;
    let mode = *state.captcha_mode.read().await;
    if !mode.requires_challenge(failed_attempts) {
        return StatusCode::NO_CONTENT.into_response();
    }
    let (id, png) = state.captchas.issue();
    let image = format!("data:image/png;base64,{}", BASE64.encode(&png));
    (
        StatusCode::OK,
        [("cache-control", "no-store")],
        Json(CaptchaResponse { id, image, expires_in: CAPTCHA_TTL.as_secs() }),
    )
        .into_response()
}

/// Resolves the form provider to use for this login.
fn resolve_form_provider(state: &WebState, requested: Option<&str>) -> Result<std::sync::Arc<dyn dbx_auth::AuthProvider>, (StatusCode, serde_json::Value)> {
    let form_providers: Vec<_> = state
        .auth_registry
        .list()
        .into_iter()
        .filter(|provider| matches!(provider.login_mode(), LoginMode::Form))
        .collect();
    if form_providers.is_empty() {
        // No form-based auth at all (equivalent to the legacy "no password configured").
        return Err((StatusCode::FORBIDDEN, serde_json::json!({"error": "setup_required"})));
    }
    match requested.filter(|value| !value.trim().is_empty()) {
        Some(id) => form_providers.into_iter().find(|provider| provider.id() == id).ok_or_else(|| {
            (StatusCode::BAD_REQUEST, serde_json::json!({"error": "invalid_provider"}))
        }),
        None => match form_providers.len() {
            1 => Ok(form_providers.into_iter().next().expect("len checked")),
            _ => Err((StatusCode::BAD_REQUEST, serde_json::json!({"error": "provider_required"}))),
        },
    }
}

fn auth_error_response(error: AuthError) -> Response {
    let (status, body): (StatusCode, serde_json::Value) = match error {
        AuthError::InvalidCredentials => (StatusCode::UNAUTHORIZED, serde_json::json!({"error": "invalid_credentials"})),
        AuthError::UserDisabled => (StatusCode::FORBIDDEN, serde_json::json!({"error": "user_disabled"})),
        AuthError::RateLimited { retry_after_secs } => (
            StatusCode::TOO_MANY_REQUESTS,
            // Keep the legacy lockout wording; the frontend translates it via `auth.rateLimited`.
            serde_json::json!({"error": format!("Please try again in {retry_after_secs}s")}),
        ),
        AuthError::UsernameRequired => (StatusCode::BAD_REQUEST, serde_json::json!({"error": "username_required"})),
        AuthError::Configuration(message) => (StatusCode::INTERNAL_SERVER_ERROR, serde_json::json!({"error": message})),
        AuthError::ProviderUnavailable(message) => (StatusCode::BAD_GATEWAY, serde_json::json!({"error": message})),
        AuthError::Unsupported => (StatusCode::BAD_REQUEST, serde_json::json!({"error": "unsupported_provider"})),
        AuthError::BadIdentity(message) => (StatusCode::BAD_GATEWAY, serde_json::json!({"error": message})),
        AuthError::Internal(message) => (StatusCode::INTERNAL_SERVER_ERROR, serde_json::json!({"error": message})),
    };
    (status, Json(body)).into_response()
}

pub async fn login(State(state): State<Arc<WebState>>, Json(body): Json<LoginRequest>) -> Response {
    let provider = match resolve_form_provider(&state, body.provider.as_deref()) {
        Ok(provider) => provider,
        Err((status, body)) => return (status, Json(body)).into_response(),
    };

    // Rate-limit key: provider + username (an empty username is the legacy single-account path;
    // the key then matches the legacy global counter).
    let username_key = body.username.as_deref().unwrap_or("").trim().to_string();

    // Check rate limit
    if let Err(retry_after) = state.login_rate_limit.check_locked(provider.id(), &username_key).await {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error": format!("Please try again in {retry_after}s")})),
        )
            .into_response();
    }

    // Captcha gate, when the configured mode demands one. It runs before the
    // rate-limit bookkeeping and the argon2 verification on purpose: a wrong or
    // missing challenge must not consume the password lockout budget (otherwise
    // five bogus captchas would lock the administrator out), and a bot must not
    // be able to spend our hashing CPU without solving an image first. `verify`
    // consumes the challenge either way, so the same image can never be
    // replayed.
    let failed_attempts = state.login_rate_limit.failures_for(provider.id(), &username_key).await;
    if state.captcha_mode.read().await.requires_challenge(failed_attempts) {
        let captcha_ok = state
            .captchas
            .verify(body.captcha_id.as_deref().unwrap_or_default(), body.captcha_code.as_deref().unwrap_or_default());
        if !captcha_ok {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "captcha_invalid"}))).into_response();
        }
    }

    let identity = match provider.authenticate(&dbx_auth::FormCredentials { username: body.username.clone(), password: body.password.clone() }).await {
        Ok(identity) => identity,
        Err(AuthError::InvalidCredentials) => {
            state.login_rate_limit.record_failure(provider.id(), &username_key).await;
            return auth_error_response(AuthError::InvalidCredentials);
        }
        Err(error) => return auth_error_response(error),
    };

    // Resolve/provision the user record: local accounts defer to the database; external providers JIT-provision on first login.
    let user = if identity.provider_id == LOCAL_PROVIDER_ID {
        state.auth_users.get_user_by_id(&identity.subject).await
    } else {
        state.auth_users.get_or_provision(&identity).await.map(Some)
    };
    let user = match user {
        Ok(Some(user)) if user.disabled => return auth_error_response(AuthError::UserDisabled),
        Ok(Some(user)) => user,
        Ok(None) => return auth_error_response(AuthError::InvalidCredentials),
        Err(error) => return auth_error_response(AuthError::Internal(error)),
    };

    // Success — reset rate limit
    state.login_rate_limit.reset(provider.id(), &username_key).await;

    let record = state.sessions.create(&user).await;
    let cookie = session_cookie(&state, &record.token);
    (
        StatusCode::OK,
        [("set-cookie", cookie.as_str())],
        Json(serde_json::json!({"ok": true, "user": record.user_summary()})),
    )
        .into_response()
}

pub async fn setup(State(state): State<Arc<WebState>>, Json(body): Json<LoginRequest>) -> Response {
    if state.password_disabled {
        return StatusCode::FORBIDDEN.into_response();
    }

    // Only allow setup when no user account exists at all.
    let user_count = state.auth_users.count_users().await.unwrap_or(0);
    if user_count > 0 {
        return StatusCode::FORBIDDEN.into_response();
    }

    if body.password.is_empty() {
        return StatusCode::BAD_REQUEST.into_response();
    }

    let username = body.username.as_deref().map(str::trim).filter(|value| !value.is_empty()).unwrap_or(LOCAL_ADMIN_SETUP_USERNAME);

    let salt = SaltString::generate(&mut OsRng);
    let hash = match Argon2::default().hash_password(body.password.as_bytes(), &salt) {
        Ok(hash) => hash.to_string(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    if let Err(error) = state.app.storage.upsert_local_admin_password(username, &hash).await {
        log::error!("Failed to persist initial admin user: {error}");
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    if state.migration_ready.load(std::sync::atomic::Ordering::Acquire) {
        if let Err(error) = state.web_mcp.reload(&state.app.storage, true).await {
            log::error!("Web MCP remained disabled after password setup: {error}");
        }
    }

    // Auto-login: create session for the freshly created admin.
    let user = match state.auth_users.get_user_by_login(LOCAL_PROVIDER_ID, username).await {
        Ok(Some(user)) => user,
        Ok(None) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        Err(error) => {
            log::error!("Failed to load initial admin user: {error}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let record = state.sessions.create(&user).await;
    let cookie = session_cookie(&state, &record.token);
    (
        StatusCode::OK,
        [("set-cookie", cookie.as_str())],
        Json(serde_json::json!({"ok": true, "user": record.user_summary()})),
    )
        .into_response()
}

/// GET /auth/providers — provider list for the login page (unauthenticated;
/// same source as the `providers` field of `auth/check`).
pub async fn providers(State(state): State<Arc<WebState>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "providers": provider_infos(&state).await }))
}

pub async fn check(State(state): State<Arc<WebState>>, req: Request<axum::body::Body>) -> Json<AuthCheckResponse> {
    let providers = provider_infos(&state).await;
    if state.password_disabled {
        return Json(AuthCheckResponse { authenticated: true, required: false, setup_required: false, providers, user: None });
    }
    let has_users = state.auth_users.count_users().await.unwrap_or(0) > 0;
    // Pure-SSO deployments (no local users but external providers exist) must not enter the setup wizard.
    let has_external = state
        .auth_registry
        .list()
        .iter()
        .any(|provider| provider.kind() != dbx_auth::AuthProviderKind::Local);
    if !has_users && !has_external {
        return Json(AuthCheckResponse { authenticated: false, required: false, setup_required: true, providers, user: None });
    }
    let session = match extract_session_token(&req) {
        Some(token) => state.sessions.get(&token).await,
        None => None,
    };
    Json(AuthCheckResponse {
        authenticated: session.is_some(),
        required: true,
        setup_required: false,
        providers,
        user: session.map(|record| record.user_summary()),
    })
}

pub async fn change_password(
    State(state): State<Arc<WebState>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<ChangePasswordRequest>,
) -> Response {
    // Session-bound: this endpoint must not be an unauthenticated password
    // oracle. After a successful change it revokes every OTHER session so a
    // stolen old cookie cannot survive a credential rotation.
    let current_token = match session_token_from_headers(&headers) {
        Some(token) => token,
        None => return StatusCode::UNAUTHORIZED.into_response(),
    };
    let record = match state.sessions.get(&current_token).await {
        Some(record) => record,
        None => return StatusCode::UNAUTHORIZED.into_response(),
    };

    if body.new_password.is_empty() {
        return StatusCode::BAD_REQUEST.into_response();
    }

    let user = match state.auth_users.get_user_by_id(&record.user_id).await {
        Ok(Some(user)) => user,
        Ok(None) => return StatusCode::UNAUTHORIZED.into_response(),
        Err(error) => {
            log::error!("Failed to load user for password change: {error}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    // Only local accounts carry a changeable password; external-provider passwords live at the IdP.
    let Some(hash) = user.password_hash.clone() else {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "external_user_password"}))).into_response();
    };

    let parsed_hash = match PasswordHash::new(&hash) {
        Ok(parsed) => parsed,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if Argon2::default().verify_password(body.old_password.as_bytes(), &parsed_hash).is_err() {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    let salt = SaltString::generate(&mut OsRng);
    let new_hash = match Argon2::default().hash_password(body.new_password.as_bytes(), &salt) {
        Ok(hash) => hash.to_string(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    let mut updated = user;
    updated.password_hash = Some(new_hash);
    updated.updated_at = dbx_auth::unix_now();
    if let Err(error) = state.auth_users.update_user(updated).await {
        log::error!("Failed to persist password change: {error}");
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    // Rotation revokes the caller's other sessions only — a multi-user rotation
    // must not kick unrelated users out (the legacy single-admin semantics revoked
    // every session because there was only one user).
    for sibling in state.sessions.revoke_user_except(&record.user_id, &current_token).await {
        dbx_core::query::pl_debug::pl_debug_revoke_web_owner_core(&state.app, &sibling);
        state.app.session_credentials.clear_owner(&sibling);
    }

    (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
}

pub async fn logout(State(state): State<Arc<WebState>>, req: Request<axum::body::Body>) -> Response {
    let mut logout_url: Option<String> = None;
    if let Some(token) = extract_session_token(&req) {
        let removed = state.sessions.remove(&token).await;
        if let Some(record) = removed {
            dbx_core::query::pl_debug::pl_debug_revoke_web_owner_core(&state.app, &token);
            // Proxy-sourced logouts record a grace period so the proxy SSO does not instantly re-login.
            for provider in state.auth_registry.list() {
                provider.on_logout(&record.username).await;
            }
            // RP-initiated logout: redirect providers hand the browser to the IdP's end-session
            // endpoint, otherwise the IdP's own session silently re-issues a code on the next
            // authorize round-trip (the app looks like it never logged out).
            if let Some(provider) = state.auth_registry.get(&record.provider_id) {
                let origin = super::handlers_oidc::public_origin(provider.public_url(), req.headers());
                let base = if state.public_base_path.is_empty() || state.public_base_path == "/" {
                    ""
                } else {
                    state.public_base_path.trim_end_matches('/')
                };
                logout_url = provider.end_session_url(&format!("{origin}{base}/login")).await;
            }
        }
        // Logout only clears the current session's temporary passwords; other sessions and desktop credentials are untouched.
        state.app.session_credentials.clear_owner(&token);
    }
    let cookie = clear_session_cookie(&state);
    let mut body = serde_json::json!({"ok": true});
    if let Some(url) = logout_url {
        body["logout_url"] = serde_json::Value::String(url);
    }
    (StatusCode::OK, [("set-cookie", cookie.as_str())], Json(body)).into_response()
}
