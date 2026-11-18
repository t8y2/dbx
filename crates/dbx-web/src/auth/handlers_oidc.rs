//! OIDC authorize / callback endpoints (unauthenticated bootstrap routes, `auth/oidc/*` prefix).
//!
//! Flow: `GET /auth/oidc/{id}/authorize` → redirect to the IdP (the provider generates and stores
//! state/PKCE/nonce internally) → IdP calls `GET /auth/oidc/{id}/callback` → validation
//! → session created (cookie) → redirect back to `next`.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;
use dbx_auth::{AuthError, CallbackParams, LoginMode};
use serde::Deserialize;

use crate::state::WebState;

const LOCAL_PROVIDER_ID: &str = dbx_auth::providers::local::LOCAL_PROVIDER_ID;

#[derive(Deserialize)]
pub struct AuthorizeQuery {
    #[serde(default)]
    pub next: Option<String>,
}

/// Redirect-target allowlist: only in-site absolute paths, preventing open redirects.
fn safe_redirect_target(next: Option<&str>, base_path: &str) -> String {
    let base = if base_path.is_empty() || base_path == "/" { "" } else { base_path.trim_end_matches('/') };
    match next {
        Some(next) if next.starts_with('/') && !next.starts_with("//") && !next.contains('\\') && !next.contains('\r') && !next.contains('\n') => {
            format!("{base}{next}")
        }
        _ => {
            if base.is_empty() {
                "/".to_string()
            } else {
                base.to_string()
            }
        }
    }
}

/// redirect_uri derivation: provider config `public_url` > `DBX_PUBLIC_URL` >
/// request-header derivation (x-forwarded-proto + Host). Proxy deployments should configure one of the former explicitly.
pub(crate) fn public_origin(provider_public_url: Option<&str>, headers: &HeaderMap) -> String {
    if let Some(url) = provider_public_url.filter(|value| !value.trim().is_empty()) {
        return url.trim().trim_end_matches('/').to_string();
    }
    if let Ok(env_url) = std::env::var("DBX_PUBLIC_URL") {
        if !env_url.trim().is_empty() {
            return env_url.trim().trim_end_matches('/').to_string();
        }
    }
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("http");
    let host = headers
        .get("host")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .unwrap_or("127.0.0.1");
    format!("{scheme}://{host}")
}

fn callback_uri(state: &WebState, provider_id: &str, provider_public_url: Option<&str>, headers: &HeaderMap) -> String {
    let origin = public_origin(provider_public_url, headers);
    let base = if state.public_base_path == "/" { "" } else { state.public_base_path.trim_end_matches('/') };
    format!("{origin}{base}/api/auth/oidc/{provider_id}/callback")
}

/// AuthError → stable error code for the callback redirect (translated by the frontend's backend-errors map).
fn error_code(error: &AuthError) -> &'static str {
    match error {
        AuthError::InvalidCredentials => "invalid_credentials",
        AuthError::UserDisabled => "user_disabled",
        AuthError::RateLimited { .. } => "rate_limited",
        AuthError::UsernameRequired | AuthError::Configuration(_) | AuthError::Unsupported => "oidc_misconfigured",
        AuthError::ProviderUnavailable(_) => "oidc_unavailable",
        AuthError::BadIdentity(_) | AuthError::Internal(_) => "oidc_failed",
    }
}

fn login_redirect_with_error(state: &WebState, code: &str) -> Response {
    let base = if state.public_base_path.is_empty() || state.public_base_path == "/" {
        ""
    } else {
        state.public_base_path.trim_end_matches('/')
    };
    Redirect::to(&format!("{base}/login?error={code}")).into_response()
}

/// GET /auth/oidc/{provider_id}/authorize
pub async fn authorize(
    State(state): State<Arc<WebState>>,
    Path(provider_id): Path<String>,
    Query(query): Query<AuthorizeQuery>,
    headers: HeaderMap,
) -> Response {
    let Some(provider) = state.auth_registry.get(&provider_id) else {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "invalid_provider" }))).into_response();
    };
    if provider.login_mode() != LoginMode::Redirect {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "invalid_provider" }))).into_response();
    }
    let redirect_uri = callback_uri(&state, &provider_id, provider.public_url(), &headers);
    match provider.begin_redirect(&redirect_uri, query.next.as_deref()).await {
        Ok(init) => Redirect::to(&init.authorization_url).into_response(),
        Err(error) => {
            log::error!("OIDC authorize for {provider_id} failed: {error}");
            login_redirect_with_error(&state, error_code(&error))
        }
    }
}

/// GET /auth/oidc/{provider_id}/callback
pub async fn callback(
    State(state): State<Arc<WebState>>,
    Path(provider_id): Path<String>,
    Query(query): Query<CallbackParams>,
    headers: HeaderMap,
) -> Response {
    let Some(provider) = state.auth_registry.get(&provider_id) else {
        return login_redirect_with_error(&state, "invalid_provider");
    };
    let redirect_uri = callback_uri(&state, &provider_id, provider.public_url(), &headers);
    let outcome = match provider.complete_redirect(&query, &redirect_uri).await {
        Ok(outcome) => outcome,
        Err(error) => {
            log::error!("OIDC callback for {provider_id} failed: {error}");
            return login_redirect_with_error(&state, error_code(&error));
        }
    };

    // JIT provisioning + disabled check (same semantics as form login).
    let user = if outcome.identity.provider_id == LOCAL_PROVIDER_ID {
        state.auth_users.get_user_by_id(&outcome.identity.subject).await
    } else {
        state.auth_users.get_or_provision(&outcome.identity).await.map(Some)
    };
    let user = match user {
        Ok(Some(user)) if user.disabled => return login_redirect_with_error(&state, "user_disabled"),
        Ok(Some(user)) => user,
        Ok(None) => return login_redirect_with_error(&state, "invalid_credentials"),
        Err(error) => {
            log::error!("OIDC provisioning for {provider_id} failed: {error}");
            return login_redirect_with_error(&state, "oidc_failed");
        }
    };

    let record = state.sessions.create(&user).await;
    let cookie = crate::auth::cookies::session_cookie(&state, &record.token);
    let target = safe_redirect_target(outcome.next.as_deref(), &state.public_base_path);
    (
        StatusCode::FOUND,
        [("set-cookie", cookie.as_str()), ("cache-control", "no-store")],
        Redirect::to(&target).into_response(),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::safe_redirect_target;

    #[test]
    fn only_site_absolute_paths_pass_through() {
        assert_eq!(safe_redirect_target(Some("/connections"), "/"), "/connections");
        assert_eq!(safe_redirect_target(Some("/dbx/x?y=1"), "/dbx"), "/dbx/dbx/x?y=1");
        assert_eq!(safe_redirect_target(Some("//evil.example"), "/"), "/");
        assert_eq!(safe_redirect_target(Some("https://evil.example"), "/"), "/");
        assert_eq!(safe_redirect_target(Some(r"/a\b"), "/"), "/");
        assert_eq!(safe_redirect_target(None, "/"), "/");
        assert_eq!(safe_redirect_target(None, "/dbx"), "/dbx");
    }
}
