use std::sync::Arc;

use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::state::WebState;

#[derive(Deserialize)]
pub struct LoginRequest {
    pub password: String,
}

#[derive(Serialize)]
pub struct AuthCheckResponse {
    pub authenticated: bool,
    pub required: bool,
}

pub async fn login(
    State(state): State<Arc<WebState>>,
    Json(body): Json<LoginRequest>,
) -> Result<Response, StatusCode> {
    let password_hash = match &state.password_hash {
        Some(h) => h,
        None => {
            return Ok((
                StatusCode::OK,
                Json(serde_json::json!({"ok": true})),
            )
                .into_response());
        }
    };

    let mut hasher = Sha256::new();
    hasher.update(body.password.as_bytes());
    let hash = hex::encode(hasher.finalize());

    if hash != *password_hash {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let token = uuid::Uuid::new_v4().to_string();
    state.sessions.write().await.insert(token.clone());

    let cookie = format!("dbx_session={token}; Path=/; HttpOnly; SameSite=Lax");
    Ok((
        StatusCode::OK,
        [("set-cookie", cookie.as_str())],
        Json(serde_json::json!({"ok": true})),
    )
        .into_response())
}

pub async fn check(State(state): State<Arc<WebState>>, req: Request<axum::body::Body>) -> Json<AuthCheckResponse> {
    if state.password_hash.is_none() {
        return Json(AuthCheckResponse { authenticated: true, required: false });
    }
    let authenticated = match extract_session_token(&req) {
        Some(token) => state.sessions.read().await.contains(&token),
        None => false,
    };
    Json(AuthCheckResponse { authenticated, required: true })
}

pub async fn logout(State(state): State<Arc<WebState>>, req: Request<axum::body::Body>) -> Response {
    if let Some(token) = extract_session_token(&req) {
        state.sessions.write().await.remove(&token);
    }
    let cookie = "dbx_session=; Path=/; HttpOnly; Max-Age=0";
    (
        StatusCode::OK,
        [("set-cookie", cookie)],
        Json(serde_json::json!({"ok": true})),
    )
        .into_response()
}

fn extract_session_token<B>(req: &Request<B>) -> Option<String> {
    let cookie_header = req.headers().get("cookie")?.to_str().ok()?;
    for pair in cookie_header.split(';') {
        let pair = pair.trim();
        if let Some(value) = pair.strip_prefix("dbx_session=") {
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

pub async fn auth_middleware(
    State(state): State<Arc<WebState>>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    // No password set — allow everything
    if state.password_hash.is_none() {
        return next.run(req).await;
    }

    // Auth endpoints are always accessible
    let path = req.uri().path();
    if path.starts_with("/api/auth/") {
        return next.run(req).await;
    }

    // Non-API requests (static files) are always accessible
    if !path.starts_with("/api/") {
        return next.run(req).await;
    }

    // Check session token
    if let Some(token) = extract_session_token(&req) {
        if state.sessions.read().await.contains(&token) {
            return next.run(req).await;
        }
    }

    StatusCode::UNAUTHORIZED.into_response()
}
