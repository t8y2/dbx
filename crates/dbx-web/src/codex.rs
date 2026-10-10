use crate::state::WebState;
use axum::{
    extract::State,
    http::{Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use dbx_codex::runtime::RuntimeHandle;
use dbx_mcp::{http_auth::authorize_request, HttpAuth};
use std::sync::{atomic::Ordering, Arc};

pub fn control_router(handle: &RuntimeHandle, token: &str) -> Result<Router, String> {
    let host = handle.base_url.as_str().trim_start_matches("http://").trim_end_matches('/').to_string();
    let auth = HttpAuth::new_with_hosts(Some(token.into()), vec![host], Vec::<String>::new(), false)?;
    let handle = handle.clone();
    Ok(Router::new()
        .route(
            "/_codex/status",
            get(move || {
                let handle = handle.clone();
                async move { Json(handle) }
            }),
        )
        .layer(middleware::from_fn_with_state(auth, authorize_request)))
}

pub async fn setup_gate(
    State(state): State<Arc<WebState>>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    if !state.migration_ready.load(Ordering::Acquire) || state.password_hash.read().await.is_none() {
        return (
            StatusCode::LOCKED,
            Json(serde_json::json!({"error": "Complete migration and password setup in the Codex workbench first"})),
        )
            .into_response();
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use dbx_codex::runtime::ServiceLease;

    #[tokio::test]
    async fn status_requires_bearer_and_rejects_foreign_hosts_and_origins() {
        let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let mut lease = ServiceLease::acquire(&directory.path().join("data")).await.unwrap();
        let handle = lease.handle();
        let token = lease.token().unwrap();
        let app = control_router(&handle, &token).unwrap();
        let listener = lease.take_listener().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let url = handle.base_url.join("_codex/status").unwrap();
        assert_eq!(client.get(url.clone()).send().await.unwrap().status(), 401);
        assert_eq!(client.get(url.clone()).bearer_auth("wrong-token").send().await.unwrap().status(), 401);
        assert_eq!(
            client.get(url.clone()).bearer_auth(&token).header("Host", "evil.example").send().await.unwrap().status(),
            403
        );
        assert_eq!(
            client
                .get(url.clone())
                .bearer_auth(&token)
                .header("Origin", "https://evil.example")
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        let response = client.get(url).bearer_auth(&token).send().await.unwrap();
        assert_eq!(response.status(), 200);
        let body = response.text().await.unwrap();
        assert!(!body.contains(&token));
        assert_eq!(serde_json::from_str::<dbx_codex::runtime::RuntimeHandle>(&body).unwrap(), handle);
        server.abort();
    }
    #[tokio::test]
    async fn mcp_stays_locked_until_password_setup_even_after_migration() {
        use axum::{middleware, routing::post, Router};
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        let directory = tempfile::tempdir().unwrap();
        let storage =
            dbx_core::persistence::test_storage::open_unmigrated(&directory.path().join("dbx.db")).await.unwrap();
        let app = Arc::new(dbx_core::connection::AppState::new(storage));
        let mut state = crate::state::WebState::for_tests(app, directory.path().to_path_buf());
        state.migration_ready = Arc::new(AtomicBool::new(true));
        let state = Arc::new(state);
        let router = Router::new()
            .route("/mcp", post(|| async { "ready" }))
            .layer(middleware::from_fn_with_state(state.clone(), setup_gate));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::new();
        assert_eq!(client.post(&url).send().await.unwrap().status(), 423);
        *state.password_hash.write().await = Some("configured".into());
        assert_eq!(client.post(&url).send().await.unwrap().status(), 200);
        state.migration_ready.store(false, Ordering::Release);
        assert_eq!(client.post(&url).send().await.unwrap().status(), 423);
        server.abort();
    }
}
