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

const MAX_INTENT_BYTES: usize = 16 * 1024 * 1024;
const INTENT_TTL: std::time::Duration = std::time::Duration::from_secs(300);

pub struct Workbench {
    base_url: String,
    entries: std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, serde_json::Value, usize)>>,
}

impl Workbench {
    pub fn new(base_url: String) -> Self {
        Self { base_url, entries: Default::default() }
    }

    fn insert(&self, intent: serde_json::Value) -> Result<String, String> {
        let size = serde_json::to_vec(&intent).map_err(|e| e.to_string())?.len();
        let mut entries = self.entries.lock().map_err(|_| "Workbench cache is unavailable")?;
        entries.retain(|_, (created, _, _)| created.elapsed() < INTENT_TTL);
        if size > MAX_INTENT_BYTES || entries.values().map(|entry| entry.2).sum::<usize>() + size > MAX_INTENT_BYTES {
            return Err(
                "Workbench result cache is full; the query was executed and must not be retried just to display it"
                    .into(),
            );
        }
        let id = uuid::Uuid::new_v4().to_string();
        entries.insert(id.clone(), (std::time::Instant::now(), intent, size));
        Ok(format!("{}?codex_intent={id}", self.base_url))
    }

    fn get(&self, id: &str) -> Option<serde_json::Value> {
        uuid::Uuid::parse_str(id).ok()?;
        let mut entries = self.entries.lock().ok()?;
        entries.retain(|_, (created, _, _)| created.elapsed() < INTENT_TTL);
        entries.get(id).map(|entry| entry.1.clone())
    }
}

impl dbx_mcp::backend::WorkbenchPublisher for Workbench {
    fn publish(&self, intent: serde_json::Value) -> Result<String, String> {
        self.insert(intent)
    }
}

pub async fn intent(
    State(state): State<Arc<WebState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    match state.codex_workbench.as_ref().and_then(|workbench| workbench.get(&id)) {
        Some(intent) => ([(axum::http::header::CACHE_CONTROL, "no-store")], Json(intent)).into_response(),
        None => (StatusCode::NOT_FOUND, "Workbench link expired or unavailable").into_response(),
    }
}

fn browser_request_allowed(workbench: &Workbench, headers: &axum::http::HeaderMap) -> bool {
    let origin = workbench.base_url.trim_end_matches('/');
    let host = origin.trim_start_matches("http://");
    headers.get(axum::http::header::HOST).and_then(|value| value.to_str().ok()) == Some(host)
        && headers.get(axum::http::header::ORIGIN).is_none_or(|value| value.to_str().ok() == Some(origin))
}

pub async fn browser_gate(
    State(workbench): State<Arc<Workbench>>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    if !browser_request_allowed(&workbench, request.headers()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(request).await
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct StopRequest {
    instance_id: String,
    #[serde(default)]
    confirm_interrupt: bool,
}

pub fn control_router(
    handle: &RuntimeHandle,
    token: &str,
    app: Arc<dbx_core::connection::AppState>,
    shutdown: tokio_util::sync::CancellationToken,
) -> Result<Router, String> {
    let host = handle.base_url.as_str().trim_start_matches("http://").trim_end_matches('/').to_string();
    let auth = HttpAuth::new_with_hosts(Some(token.into()), vec![host], Vec::<String>::new(), false)?;
    let instance_id = handle.instance_id.clone();
    let handle = handle.clone();
    let status_app = app.clone();
    Ok(Router::new()
        .route("/_codex/status", get(move || {
            let handle = handle.clone();
            let app = status_app.clone();
            async move {
                let mut status = serde_json::to_value(handle).expect("runtime handle");
                status["tracked_tasks"] = serde_json::json!(app.running_queries.diagnostics().active_execution_ids.len());
                status["active_mcp_sessions"] = serde_json::Value::Null;
                status["activity_tracking"] = serde_json::json!("incomplete");
                status["stop_requires_confirmation"] = serde_json::json!(true);
                Json(status)
            }
        }))
        .route("/_codex/stop", axum::routing::post(move |Json(request): Json<StopRequest>| {
            let app = app.clone();
            let shutdown = shutdown.clone();
            let instance_id = instance_id.clone();
            async move {
                if request.instance_id != instance_id {
                    return (StatusCode::CONFLICT, Json(serde_json::json!({"error":"Runtime instance changed; shutdown refused"}))).into_response();
                }
                // shortcut: imports, backups and plugin/MCP sessions lack one shared activity registry; require explicit interruption approval until they do.
                if !request.confirm_interrupt {
                    return (StatusCode::CONFLICT, Json(serde_json::json!({
                        "error":"Cannot prove the shared workbench is idle. Confirm interruption of all clients, writes, imports and backups before stopping.",
                        "tracked_tasks": app.running_queries.diagnostics().active_execution_ids.len(),
                        "active_mcp_sessions":null, "activity_tracking":"incomplete", "stopping":false,
                    }))).into_response();
                }
                shutdown.cancel();
                (StatusCode::ACCEPTED, Json(serde_json::json!({"stopping":true,"data_preserved":true}))).into_response()
            }
        }))
        .layer(axum::extract::DefaultBodyLimit::max(4096))
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

    #[test]
    fn browser_rejects_dns_rebinding_and_foreign_origins() {
        let workbench = Workbench::new("http://127.0.0.1:1234/".into());
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("host", "evil.example:1234".parse().unwrap());
        assert!(!browser_request_allowed(&workbench, &headers));
        headers.insert("host", "127.0.0.1:1234".parse().unwrap());
        assert!(browser_request_allowed(&workbench, &headers));
        headers.insert("origin", "https://evil.example".parse().unwrap());
        assert!(!browser_request_allowed(&workbench, &headers));
        headers.insert("origin", "http://127.0.0.1:1234".parse().unwrap());
        assert!(browser_request_allowed(&workbench, &headers));
        headers.insert("origin", "null".parse().unwrap());
        assert!(!browser_request_allowed(&workbench, &headers));
    }

    #[test]
    fn intents_expire_and_keep_data_out_of_urls() {
        let workbench = Workbench::new("http://127.0.0.1:1234/".into());
        let secret =
            serde_json::json!({"kind":"result", "sql":"SELECT private_value", "results":[{"rows":[["private cell"]]}]});
        let url = workbench.insert(secret.clone()).unwrap();
        assert!(!url.contains("private"));
        let id = url.split("codex_intent=").nth(1).unwrap();
        assert_eq!(workbench.get(id), Some(secret.clone()));
        assert_eq!(workbench.get(id), Some(secret));
        assert_eq!(workbench.get("bad-id"), None);
        workbench.entries.lock().unwrap().get_mut(id).unwrap().0 =
            std::time::Instant::now() - std::time::Duration::from_secs(301);
        assert_eq!(workbench.get(id), None);
    }

    #[test]
    fn oversized_intent_does_not_remove_previous_result() {
        let workbench = Workbench::new("http://127.0.0.1:1234/".into());
        let url = workbench.insert(serde_json::json!({"kind":"table"})).unwrap();
        assert!(workbench.insert(serde_json::json!("x".repeat(MAX_INTENT_BYTES))).is_err());
        assert!(workbench.get(url.split("codex_intent=").nth(1).unwrap()).is_some());
    }

    #[tokio::test]
    async fn stop_requires_explicit_interrupt_confirmation_and_keeps_data() {
        let directory = tempfile::tempdir().unwrap();
        let data = directory.path().join("dbx.db");
        let storage = dbx_core::persistence::test_storage::open_unmigrated(&data).await.unwrap();
        let app_state = Arc::new(dbx_core::connection::AppState::new(storage));
        let active = app_state.running_queries.register("active-write".into());
        let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let mut lease = ServiceLease::acquire(&directory.path().join("runtime")).await.unwrap();
        let handle = lease.handle();
        let token = lease.token().unwrap();
        let shutdown = tokio_util::sync::CancellationToken::new();
        let router = control_router(&handle, &token, app_state.clone(), shutdown.clone()).unwrap();
        let listener = lease.take_listener().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let url = handle.base_url.join("_codex/stop").unwrap();
        let client = reqwest::Client::new();
        assert_eq!(
            client
                .post(url.clone())
                .json(&serde_json::json!({"confirm_interrupt":true,"instance_id":handle.instance_id}))
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        let denied = client
            .post(url.clone())
            .bearer_auth(&token)
            .json(&serde_json::json!({"instance_id":handle.instance_id}))
            .send()
            .await
            .unwrap();
        assert_eq!(denied.status(), 409);
        assert_eq!(denied.json::<serde_json::Value>().await.unwrap()["tracked_tasks"], 1);
        assert!(!shutdown.is_cancelled());
        let wrong_instance = client
            .post(url.clone())
            .bearer_auth(&token)
            .json(&serde_json::json!({"confirm_interrupt":true,"instance_id":"old-instance"}))
            .send()
            .await
            .unwrap();
        assert_eq!(wrong_instance.status(), 409);
        assert!(!shutdown.is_cancelled());
        let stopped = client
            .post(url)
            .bearer_auth(&token)
            .json(&serde_json::json!({"confirm_interrupt":true,"instance_id":handle.instance_id}))
            .send()
            .await
            .unwrap();
        assert_eq!(stopped.status(), 202);
        assert!(shutdown.is_cancelled());
        assert!(data.is_file());
        drop(active);
        server.abort();
    }

    #[tokio::test]
    async fn intent_results_require_browser_login_and_are_not_consumed() {
        let directory = tempfile::tempdir().unwrap();
        let storage =
            dbx_core::persistence::test_storage::open_unmigrated(&directory.path().join("dbx.db")).await.unwrap();
        let mut state =
            WebState::for_tests(Arc::new(dbx_core::connection::AppState::new(storage)), directory.path().to_path_buf());
        let workbench = Arc::new(Workbench::new("http://127.0.0.1/".into()));
        let payload =
            serde_json::json!({"kind":"result", "sql":"SELECT secret", "results":[{"rows":[["original cell"]]}]});
        let url = workbench.insert(payload.clone()).unwrap();
        let id = url.split("codex_intent=").nth(1).unwrap();
        state.codex_workbench = Some(workbench);
        *state.password_hash.write().await = Some("configured".into());
        state.sessions.write().await.insert("browser-session".into());
        let state = Arc::new(state);
        let router = Router::new()
            .route("/api/codex/intents/{id}", get(intent))
            .layer(middleware::from_fn_with_state(state.clone(), setup_gate))
            .layer(middleware::from_fn_with_state(state.clone(), crate::auth::auth_middleware))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/api/codex/intents/{id}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::new();
        assert_eq!(client.get(&url).send().await.unwrap().status(), 401);
        assert_eq!(client.get(&url).bearer_auth("private-mcp-token").send().await.unwrap().status(), 401);
        for _ in 0..2 {
            let response = client.get(&url).header("Cookie", "dbx_session=browser-session").send().await.unwrap();
            assert_eq!(response.status(), 200);
            assert_eq!(response.headers()["cache-control"], "no-store");
            assert_eq!(response.json::<serde_json::Value>().await.unwrap(), payload);
        }
        state.migration_ready.store(false, Ordering::Release);
        assert_eq!(
            client.get(&url).header("Cookie", "dbx_session=browser-session").send().await.unwrap().status(),
            423
        );
        server.abort();
    }

    #[tokio::test]
    async fn status_requires_bearer_and_rejects_foreign_hosts_and_origins() {
        let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let mut lease = ServiceLease::acquire(&directory.path().join("data")).await.unwrap();
        let handle = lease.handle();
        let token = lease.token().unwrap();
        let storage =
            dbx_core::persistence::test_storage::open_unmigrated(&directory.path().join("dbx.db")).await.unwrap();
        let app_state = Arc::new(dbx_core::connection::AppState::new(storage));
        let app = control_router(&handle, &token, app_state, tokio_util::sync::CancellationToken::new()).unwrap();
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
