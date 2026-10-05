//! Scheduler HTTP API (ADR §7.1): every handler goes through
//! [`SchedulerService`] — nothing here touches the scheduler SQLite store.
//! Error codes map to the frozen HTTP statuses (ADR §7.5) and are kept
//! recoverable as the `<code>: <message>` prefix of the shared `AppError`
//! envelope detail, mirroring the Desktop `Err(String)` convention.

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use dbx_core::scheduler::{
    ResidentSession, SchedulerService, SchedulerStore, TaskArtifact, TaskDefinition, TaskError, TaskExecutorRegistry,
    TaskLogPage, TaskLogQuery, TaskRun,
};
use serde::Deserialize;
use serde_json::json;

use crate::{error::AppError, sse, state::WebState};

/// Upper bound of runs scanned for list/cursor slicing. The frozen store API
/// is `list_runs(task_id, limit)`; cursors are resolved over this bounded
/// window (ADR §7.1 keeps the route shape, A4/A8 may push it into the store).
const RUN_SCAN_LIMIT: u32 = 1000;
const RUN_DEFAULT_LIMIT: u32 = 100;
/// Log page defaults from ADR §7.3: `afterSeq=0`, `limit=500`.
const LOG_DEFAULT_LIMIT: u64 = 500;
const LOG_MAX_LIMIT: u64 = 5000;
/// Broadcast capacity of the in-process scheduler event hub (ADR §7.4).
const EVENT_CHANNEL_CAPACITY: usize = 512;

pub fn router() -> Router<Arc<WebState>> {
    Router::new()
        .route("/scheduler/tasks", get(list_tasks).post(create_task))
        .route("/scheduler/tasks/{id}", get(get_task).put(update_task).delete(delete_task))
        .route("/scheduler/tasks/{id}/run", post(run_task))
        .route("/scheduler/tasks/{id}/cancel", post(cancel_run))
        .route("/scheduler/tasks/{id}/enable", post(enable_task))
        .route("/scheduler/tasks/{id}/disable", post(disable_task))
        .route("/scheduler/runs", get(list_runs))
        .route("/scheduler/runs/{id}", get(get_run))
        .route("/scheduler/runs/{id}/logs", get(get_run_logs))
        .route("/scheduler/runs/{id}/artifacts", get(get_run_artifacts))
        .route("/scheduler/resident", get(list_resident_sessions))
        .route("/scheduler/resident/{session_id}/start", post(resident_start))
        .route("/scheduler/resident/{session_id}/stop", post(resident_stop))
        .route("/scheduler/resident/{session_id}/restart", post(resident_restart))
        .route("/scheduler/events", get(scheduler_events))
}

/// Builds the service for one request. The web layer does not own providers
/// yet (builtin/plugin executors are registered by the host worker, A4/A8),
/// so an empty registry reports `provider_not_found` until they are wired.
fn service(state: &WebState) -> SchedulerService {
    service_with(&state.data_dir, Arc::new(TaskExecutorRegistry::new()))
}

pub(crate) fn service_with(data_dir: &std::path::Path, registry: Arc<TaskExecutorRegistry>) -> SchedulerService {
    SchedulerService::new(SchedulerStore::new(data_dir), registry)
}

// ---------------------------------------------------------------------------
// Error mapping (ADR §7.5)
// ---------------------------------------------------------------------------

/// Maps a scheduler error code to its frozen HTTP status. Codes outside the
/// vocabulary keep 500 via the default arm.
pub(crate) fn status_for_code(code: &str) -> axum::http::StatusCode {
    match code {
        "task_not_found" | "run_not_found" | "provider_not_found" | "session_not_found" => {
            axum::http::StatusCode::NOT_FOUND
        }
        "provider_unavailable" | "scheduler_unavailable" => axum::http::StatusCode::SERVICE_UNAVAILABLE,
        "invalid_config" | "invalid_trigger" => axum::http::StatusCode::BAD_REQUEST,
        "version_conflict" | "run_already_active" => axum::http::StatusCode::CONFLICT,
        "permission_denied" => axum::http::StatusCode::FORBIDDEN,
        _ => axum::http::StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// Converts a scheduler error into the shared `AppError` envelope with the
/// frozen status. The machine code is preserved as the `<code>: <message>`
/// prefix of the detail so clients can branch on it (Desktop parity, §7.5).
pub(crate) fn scheduler_error(error: TaskError) -> AppError {
    let message = error.to_string();
    AppError {
        message: message.clone(),
        status: status_for_code(&error.code),
        error: Box::new(dbx_core::backend_error::BackendError::from_legacy_backend(&message)),
    }
}

// ---------------------------------------------------------------------------
// Scheduler events (ADR §7.4): in-process hub, lossy by contract — clients
// rebuild state from the REST API; the background worker (A8) publishes
// engine-originated events through [`publish_event`].
// ---------------------------------------------------------------------------

fn events_hub() -> &'static tokio::sync::broadcast::Sender<String> {
    static HUB: std::sync::OnceLock<tokio::sync::broadcast::Sender<String>> = std::sync::OnceLock::new();
    HUB.get_or_init(|| tokio::sync::broadcast::channel(EVENT_CHANNEL_CAPACITY).0)
}

/// Publishes one `dbx-scheduler-event` payload (SSE). Never fails: the event
/// contract is notification-only and dropped events are acceptable.
pub fn publish_event(event: &serde_json::Value) {
    let _ = events_hub().send(event.to_string());
}

fn emit_task_changed(task_id: &str) {
    publish_event(&json!({ "type": "task-changed", "taskId": task_id }));
}

// ---------------------------------------------------------------------------
// Request payloads
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelRunRequest {
    run_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListRunsQuery {
    task_id: Option<String>,
    status: Option<String>,
    limit: Option<u32>,
    before: Option<String>,
    after: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogsQuery {
    after_seq: Option<u64>,
    limit: Option<u64>,
    level: Option<String>,
    stream: Option<String>,
}

fn status_matches(run: &TaskRun, wanted: &str) -> bool {
    serde_json::to_value(&run.status)
        .ok()
        .and_then(|value| value.as_str().map(|value| value == wanted))
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Task handlers
// ---------------------------------------------------------------------------

async fn list_tasks(State(state): State<Arc<WebState>>) -> Result<Json<Vec<TaskDefinition>>, AppError> {
    let tasks = service(&state).list_tasks().await.map_err(scheduler_error)?;
    Ok(Json(tasks))
}

async fn get_task(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
) -> Result<Json<TaskDefinition>, AppError> {
    let task = service(&state).get_task(&id).await.map_err(scheduler_error)?;
    Ok(Json(task))
}

async fn create_task(
    State(state): State<Arc<WebState>>,
    Json(mut task): Json<TaskDefinition>,
) -> Result<Json<TaskDefinition>, AppError> {
    // The schedule and timestamps are scheduler-owned; clients never set them.
    task.next_run_at = None;
    let saved = service(&state).create_task(task).await.map_err(scheduler_error)?;
    emit_task_changed(&saved.id);
    Ok(Json(saved))
}

async fn update_task(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
    Json(mut task): Json<TaskDefinition>,
) -> Result<Json<TaskDefinition>, AppError> {
    if !task.id.is_empty() && task.id != id {
        return Err(scheduler_error(TaskError::invalid_config("Path task id does not match the request body")));
    }
    task.id = id;
    let svc = service(&state);
    // Distinguish a stale save (409) from an unknown task (404): the frozen
    // store reports a missing CAS target as version_conflict.
    if svc.get_task(&task.id).await.map_err(scheduler_error).is_err() {
        return Err(scheduler_error(TaskError::new(
            dbx_core::scheduler::TaskErrorKind::NonRetryable,
            "task_not_found",
            format!("Task {} not found", task.id),
        )));
    }
    let expected_version = task.version;
    let saved = svc.update_task(task, expected_version).await.map_err(scheduler_error)?;
    emit_task_changed(&saved.id);
    Ok(Json(saved))
}

async fn delete_task(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    service(&state).delete_task(&id).await.map_err(scheduler_error)?;
    emit_task_changed(&id);
    Ok(Json(json!({ "deleted": true })))
}

async fn run_task(State(state): State<Arc<WebState>>, Path(id): Path<String>) -> Result<Json<TaskRun>, AppError> {
    let run = service(&state).run_now(&id).await.map_err(scheduler_error)?;
    publish_event(&json!({ "type": "run-created", "taskId": id, "runId": run.id, "status": run.status.as_str() }));
    Ok(Json(run))
}

async fn cancel_run(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
    Json(request): Json<CancelRunRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let svc = service(&state);
    // Task-ownership check (ADR §7.5 API security): the run must belong to
    // the addressed task; a foreign run id is indistinguishable from a
    // missing one.
    let run = svc.get_run(&request.run_id).await.map_err(scheduler_error)?;
    if run.task_id != id {
        return Err(scheduler_error(TaskError::new(
            dbx_core::scheduler::TaskErrorKind::NonRetryable,
            "run_not_found",
            format!("Run {} does not belong to task {}", request.run_id, id),
        )));
    }
    let accepted = svc.cancel_run(&request.run_id).await.map_err(scheduler_error)?;
    if accepted {
        if let Ok(latest) = svc.get_run(&request.run_id).await {
            publish_event(
                &json!({ "type": "run-state", "taskId": id, "runId": latest.id, "status": latest.status.as_str() }),
            );
        }
    }
    Ok(Json(json!({ "accepted": accepted })))
}

async fn enable_task(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
) -> Result<Json<TaskDefinition>, AppError> {
    let task = service(&state).set_enabled(&id, true).await.map_err(scheduler_error)?;
    emit_task_changed(&id);
    Ok(Json(task))
}

async fn disable_task(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
) -> Result<Json<TaskDefinition>, AppError> {
    let task = service(&state).set_enabled(&id, false).await.map_err(scheduler_error)?;
    emit_task_changed(&id);
    Ok(Json(task))
}

// ---------------------------------------------------------------------------
// Run handlers
// ---------------------------------------------------------------------------

async fn list_runs(
    State(state): State<Arc<WebState>>,
    Query(query): Query<ListRunsQuery>,
) -> Result<Json<Vec<TaskRun>>, AppError> {
    let runs = service(&state).list_runs(query.task_id.clone(), RUN_SCAN_LIMIT).await.map_err(scheduler_error)?;
    let mut matched: Vec<TaskRun> = runs
        .into_iter()
        .filter(|run| query.status.as_deref().is_none_or(|wanted| status_matches(run, wanted)))
        .collect();
    // Cursor semantics over the newest-first list: `after=<id>` returns runs
    // newer than the cursor, `before=<id>` runs older than it.
    if let Some(cursor) = query.before.as_deref().or(query.after.as_deref()) {
        let take_older = query.before.is_some();
        if let Some(position) = matched.iter().position(|run| run.id == cursor) {
            let start = if take_older { position + 1 } else { 0 };
            let end = if take_older { matched.len() } else { position };
            matched = matched[start..end].to_vec();
        } else {
            matched.clear();
        }
    }
    let limit = query.limit.unwrap_or(RUN_DEFAULT_LIMIT).clamp(1, RUN_SCAN_LIMIT) as usize;
    matched.truncate(limit);
    Ok(Json(matched))
}

async fn get_run(State(state): State<Arc<WebState>>, Path(id): Path<String>) -> Result<Json<TaskRun>, AppError> {
    let run = service(&state).get_run(&id).await.map_err(scheduler_error)?;
    Ok(Json(run))
}

async fn get_run_logs(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
    Query(query): Query<LogsQuery>,
) -> Result<Json<TaskLogPage>, AppError> {
    // Touch the run first so an unknown run id is a 404, not an empty page.
    service(&state).get_run(&id).await.map_err(scheduler_error)?;
    let page = service(&state)
        .list_logs(
            &id,
            TaskLogQuery {
                after_seq: query.after_seq,
                limit: Some(query.limit.unwrap_or(LOG_DEFAULT_LIMIT).clamp(1, LOG_MAX_LIMIT)),
                level: query.level,
                stream: query.stream,
            },
        )
        .await
        .map_err(scheduler_error)?;
    Ok(Json(page))
}

async fn get_run_artifacts(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
) -> Result<Json<Vec<TaskArtifact>>, AppError> {
    // Touch the run first so an unknown run id is a 404, not an empty list.
    service(&state).get_run(&id).await.map_err(scheduler_error)?;
    let artifacts = service(&state).list_artifacts(&id).await.map_err(scheduler_error)?;
    Ok(Json(artifacts))
}

// ---------------------------------------------------------------------------
// Resident handlers
// ---------------------------------------------------------------------------

async fn list_resident_sessions(State(state): State<Arc<WebState>>) -> Result<Json<Vec<ResidentSession>>, AppError> {
    let sessions = service(&state).list_resident_sessions().await.map_err(scheduler_error)?;
    Ok(Json(sessions))
}

async fn resident_start(
    State(state): State<Arc<WebState>>,
    Path(session_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let svc = service(&state);
    let session = resident_session(&svc, &session_id).await?;
    // The engine starts resident sessions when it dispatches a queued run of
    // a resident task, so a manual start is a manual run of that task.
    let run = svc.run_now(&session.task_id).await.map_err(scheduler_error)?;
    publish_event(&json!({ "type": "run-created", "taskId": session.task_id, "runId": run.id }));
    Ok(Json(json!({ "accepted": true, "runId": run.id })))
}

async fn resident_stop(
    State(state): State<Arc<WebState>>,
    Path(session_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let svc = service(&state);
    let task_id = resident_session(&svc, &session_id).await?.task_id;
    svc.resident_stop(&session_id).await.map_err(scheduler_error)?;
    publish_event(&json!({ "type": "resident-state", "taskId": task_id, "sessionId": session_id, "state": "stopped" }));
    Ok(Json(json!({ "accepted": true })))
}

async fn resident_restart(
    State(state): State<Arc<WebState>>,
    Path(session_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let svc = service(&state);
    let task_id = resident_session(&svc, &session_id).await?.task_id;
    let run = svc.resident_restart(&session_id).await.map_err(scheduler_error)?;
    publish_event(&json!({ "type": "resident-state", "taskId": task_id, "sessionId": session_id, "state": "stopped" }));
    publish_event(&json!({ "type": "run-created", "taskId": task_id, "runId": run.id }));
    Ok(Json(json!({ "accepted": true, "runId": run.id })))
}

async fn resident_session(svc: &SchedulerService, session_id: &str) -> Result<ResidentSession, AppError> {
    svc.list_resident_sessions()
        .await
        .map_err(scheduler_error)?
        .into_iter()
        .find(|session| session.id == session_id)
        .ok_or_else(|| {
            scheduler_error(TaskError::new(
                dbx_core::scheduler::TaskErrorKind::NonRetryable,
                "session_not_found",
                format!("Resident session {session_id} not found"),
            ))
        })
}

// ---------------------------------------------------------------------------
// Event stream (SSE)
// ---------------------------------------------------------------------------

async fn scheduler_events() -> impl IntoResponse {
    sse::sse_from_lossy_channel(events_hub().subscribe())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::WebState;
    use axum::http::StatusCode;
    use dbx_core::scheduler::{
        TaskErrorKind, TaskExecutionPolicy, TaskLogEntry, TaskLogger, TaskProviderType, TaskRunStatus, TaskTarget,
        TaskTrigger,
    };
    use std::path::Path;

    async fn test_state(data_dir: &Path) -> Arc<WebState> {
        let storage = dbx_core::persistence::test_storage::open(&data_dir.join("dbx.db")).await.unwrap();
        Arc::new(WebState::for_tests(Arc::new(dbx_core::connection::AppState::new(storage)), data_dir.to_path_buf()))
    }

    fn manual_task(name: &str) -> TaskDefinition {
        TaskDefinition {
            id: String::new(),
            name: name.to_owned(),
            provider_type: TaskProviderType::Builtin,
            provider_id: "dbx.database-backup".to_owned(),
            target: TaskTarget { connection_id: Some("conn-1".to_owned()), ..Default::default() },
            trigger: TaskTrigger::Manual,
            execution: TaskExecutionPolicy::default(),
            config_version: 1,
            config: serde_json::json!({ "databases": ["app"] }),
            enabled: true,
            created_at: String::new(),
            updated_at: String::new(),
            next_run_at: None,
            last_run_at: None,
            last_run_status: None,
            version: 1,
        }
    }

    async fn create_task_via_api(state: &Arc<WebState>, name: &str) -> TaskDefinition {
        let Json(task) = create_task(State(state.clone()), Json(manual_task(name))).await.unwrap();
        task
    }

    // -- Route registration (ADR §7.1) ----------------------------------
    //
    // axum 0.8 exposes no route introspection, so registration is verified
    // against a live server on an ephemeral port: every frozen route must
    // answer with the documented status/envelope.

    #[tokio::test]
    async fn router_serves_every_adr_route() {
        let directory = tempfile::tempdir().unwrap();
        let state = test_state(directory.path()).await;
        let app = router().with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.expect("server stopped") });
        // router() mounts under the /api nest in main.rs; standalone it
        // serves /scheduler directly.
        let base = format!("http://{addr}/scheduler");

        // Tasks CRUD.
        let created: serde_json::Value = reqwest::Client::new()
            .post(format!("{base}/tasks"))
            .json(&manual_task("served task"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let id = created["id"].as_str().unwrap().to_owned();
        assert_eq!(created["name"], "served task");

        let tasks: Vec<serde_json::Value> = reqwest::get(format!("{base}/tasks")).await.unwrap().json().await.unwrap();
        assert_eq!(tasks.len(), 1);

        let fetched: serde_json::Value =
            reqwest::get(format!("{base}/tasks/{id}")).await.unwrap().json().await.unwrap();
        assert_eq!(fetched["id"], id.as_str());

        // Runs + logs + artifacts routes.
        let run: serde_json::Value = reqwest::Client::new()
            .post(format!("{base}/tasks/{id}/run"))
            .json(&serde_json::json!({}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let run_id = run["id"].as_str().unwrap().to_owned();
        assert_eq!(run["status"], "queued");

        let runs: Vec<serde_json::Value> =
            reqwest::get(format!("{base}/runs?taskId={id}")).await.unwrap().json().await.unwrap();
        assert_eq!(runs.len(), 1);

        let page: serde_json::Value =
            reqwest::get(format!("{base}/runs/{run_id}/logs")).await.unwrap().json().await.unwrap();
        assert_eq!(page["eof"], serde_json::json!(true));

        let artifacts: Vec<serde_json::Value> =
            reqwest::get(format!("{base}/runs/{run_id}/artifacts")).await.unwrap().json().await.unwrap();
        assert!(artifacts.is_empty());

        // Enable / disable.
        for action in ["disable", "enable"] {
            let response = reqwest::Client::new()
                .post(format!("{base}/tasks/{id}/{action}"))
                .json(&serde_json::json!({}))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 200, "{action}");
        }

        // Cancel.
        let cancel: serde_json::Value = reqwest::Client::new()
            .post(format!("{base}/tasks/{id}/cancel"))
            .json(&serde_json::json!({ "runId": run_id }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(cancel["accepted"], serde_json::json!(true));

        // Resident list + SSE endpoint handshake.
        let sessions: Vec<serde_json::Value> =
            reqwest::get(format!("{base}/resident")).await.unwrap().json().await.unwrap();
        assert!(sessions.is_empty());

        let events = reqwest::get(format!("{base}/events")).await.unwrap();
        assert_eq!(events.status(), 200);
        assert!(events.headers()["content-type"].to_str().unwrap().starts_with("text/event-stream"));

        // Error envelope: unknown task id → 404 with the machine code prefix.
        let missing = reqwest::get(format!("{base}/tasks/missing")).await.unwrap();
        assert_eq!(missing.status(), 404);
        let body: serde_json::Value = missing.json().await.unwrap();
        assert_eq!(body["code"], "DBX-LEGACY-0001");
        assert_eq!(body["detail"], "task_not_found: Task missing not found");

        // Optimistic locking through the wire: stale version → 409.
        let mut stale = created.clone();
        stale["version"] = serde_json::json!(999);
        let conflict = reqwest::Client::new().put(format!("{base}/tasks/{id}")).json(&stale).send().await.unwrap();
        assert_eq!(conflict.status(), 409);
        let body: serde_json::Value = conflict.json().await.unwrap();
        assert!(body["detail"].as_str().unwrap().starts_with("version_conflict: "));

        // Delete closes the lifecycle.
        let deleted = reqwest::Client::new().delete(format!("{base}/tasks/{id}")).send().await.unwrap();
        assert_eq!(deleted.status(), 200);

        server.abort();
    }

    // -- Error mapping (ADR §7.5) ---------------------------------------

    #[test]
    fn error_codes_map_to_the_frozen_http_statuses() {
        let cases: [(&str, TaskError, StatusCode); 10] = [
            (
                "task_not_found",
                TaskError::new(TaskErrorKind::NonRetryable, "task_not_found", "x"),
                StatusCode::NOT_FOUND,
            ),
            ("run_not_found", TaskError::new(TaskErrorKind::NonRetryable, "run_not_found", "x"), StatusCode::NOT_FOUND),
            ("provider_not_found", TaskError::provider_not_found("x"), StatusCode::NOT_FOUND),
            ("provider_unavailable", TaskError::provider_unavailable("x"), StatusCode::SERVICE_UNAVAILABLE),
            ("invalid_config", TaskError::invalid_config("x"), StatusCode::BAD_REQUEST),
            ("invalid_trigger", TaskError::invalid_trigger("x"), StatusCode::BAD_REQUEST),
            ("version_conflict", TaskError::version_conflict("x"), StatusCode::CONFLICT),
            ("run_already_active", TaskError::run_already_active("x"), StatusCode::CONFLICT),
            ("permission_denied", TaskError::permission_denied("x"), StatusCode::FORBIDDEN),
            ("scheduler_unavailable", TaskError::unavailable("x"), StatusCode::SERVICE_UNAVAILABLE),
        ];
        for (code, error, expected) in cases {
            let mapped = scheduler_error(error);
            assert_eq!(mapped.status, expected, "code {code} must map to {expected}");
            assert!(mapped.message.starts_with(&format!("{code}: ")), "machine code must prefix the detail");
        }
    }

    #[tokio::test]
    async fn unknown_task_returns_404_and_missing_provider_404() {
        let directory = tempfile::tempdir().unwrap();
        let state = test_state(directory.path()).await;
        let error = get_task(State(state.clone()), Path("missing".to_owned())).await.unwrap_err();
        assert_eq!(error.status, StatusCode::NOT_FOUND);
        assert!(error.message.starts_with("task_not_found: "), "{}", error.message);

        // Empty registry: validation of any provider id reports provider_not_found.
        let task = create_task_via_api(&state, "provider check").await;
        let svc = service(&state);
        let error = svc.validate_task(&task).await.unwrap_err();
        assert_eq!(error.code, "provider_not_found");
        assert_eq!(scheduler_error(error).status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn invalid_config_and_invalid_trigger_are_bad_requests() {
        let directory = tempfile::tempdir().unwrap();
        let state = test_state(directory.path()).await;

        // configVersion must live on the definition, not inside config (ADR §2.1).
        let mut task = manual_task("embedded configVersion");
        task.config = serde_json::json!({ "configVersion": 1, "databases": ["app"] });
        let error = create_task(State(state.clone()), Json(task)).await.unwrap_err();
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert!(error.message.starts_with("invalid_config: "), "{}", error.message);

        // Unparsable cron + unknown timezone → invalid_trigger (400).
        let mut broken = manual_task("broken cron");
        broken.trigger = TaskTrigger::Cron { expression: "not a cron".to_owned(), time_zone: "UTC".to_owned() };
        let error = create_task(State(state.clone()), Json(broken)).await.unwrap_err();
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        // Unparsable triggers surface as invalid_trigger or invalid_config;
        // both are 400 per ADR §7.5.
        assert!(
            error.message.starts_with("invalid_trigger: ") || error.message.starts_with("invalid_config: "),
            "{}",
            error.message
        );
    }

    // -- Optimistic locking (ADR §7.5 version_conflict → 409) -----------

    #[tokio::test]
    async fn stale_update_returns_409_and_fresh_update_succeeds() {
        let directory = tempfile::tempdir().unwrap();
        let state = test_state(directory.path()).await;
        let saved = create_task_via_api(&state, "lock me").await;
        assert_eq!(saved.version, 1);

        // Second window saves first: version advances to 2.
        let mut winner = saved.clone();
        winner.name = "saved from window 2".to_owned();
        let Json(updated) = update_task(State(state.clone()), Path(saved.id.clone()), Json(winner)).await.unwrap();
        assert_eq!(updated.version, 2);

        // The stale save from window 1 must be rejected with 409, not overwrite.
        let mut loser = saved.clone();
        loser.name = "saved from window 1".to_owned();
        let error = update_task(State(state.clone()), Path(saved.id.clone()), Json(loser)).await.unwrap_err();
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert!(error.message.starts_with("version_conflict: "), "{}", error.message);

        let Json(current) = get_task(State(state.clone()), Path(saved.id.clone())).await.unwrap();
        assert_eq!(current.name, "saved from window 2");
        assert_eq!(current.version, 2);

        // Updating a task that does not exist is a 404 (route pre-check).
        let mut ghost = manual_task("ghost");
        ghost.id = "missing-task".to_owned();
        let error = update_task(State(state.clone()), Path("missing-task".to_owned()), Json(ghost)).await.unwrap_err();
        assert_eq!(error.status, StatusCode::NOT_FOUND);

        // Path/body id mismatch is rejected as invalid config.
        let error = update_task(State(state.clone()), Path("other".to_owned()), Json(current)).await.unwrap_err();
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
    }

    // -- Run / cancel ----------------------------------------------------

    #[tokio::test]
    async fn manual_run_enqueues_and_cancel_reports_acceptance() {
        let directory = tempfile::tempdir().unwrap();
        let state = test_state(directory.path()).await;
        let task = create_task_via_api(&state, "run me").await;

        let Json(run) = run_task(State(state.clone()), Path(task.id.clone())).await.unwrap();
        assert_eq!(run.task_id, task.id);
        assert_eq!(run.status, TaskRunStatus::Queued);
        assert_eq!(run.attempt, 1);

        // forbid concurrency + queued run → run_already_active (409).
        let error = run_task(State(state.clone()), Path(task.id.clone())).await.unwrap_err();
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert!(error.message.starts_with("run_already_active: "), "{}", error.message);

        // Cancelling with a foreign task id is a run_not_found (ownership check).
        let error = cancel_run(
            State(state.clone()),
            Path("other-task".to_owned()),
            Json(CancelRunRequest { run_id: run.id.clone() }),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::NOT_FOUND);
        assert!(error.message.starts_with("run_not_found: "), "{}", error.message);

        // Queued runs cancel immediately.
        let Json(result) =
            cancel_run(State(state.clone()), Path(task.id.clone()), Json(CancelRunRequest { run_id: run.id.clone() }))
                .await
                .unwrap();
        assert_eq!(result["accepted"], serde_json::json!(true));
        let Json(cancelled) = get_run(State(state.clone()), Path(run.id.clone())).await.unwrap();
        assert_eq!(cancelled.status, TaskRunStatus::Cancelled);

        // Cancelling again is a no-op acceptance=false, not an error.
        let Json(result) =
            cancel_run(State(state.clone()), Path(task.id.clone()), Json(CancelRunRequest { run_id: run.id.clone() }))
                .await
                .unwrap();
        assert_eq!(result["accepted"], serde_json::json!(false));

        // Unknown run → 404.
        let error = cancel_run(
            State(state.clone()),
            Path(task.id.clone()),
            Json(CancelRunRequest { run_id: "ghost".to_owned() }),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::NOT_FOUND);
        assert!(error.message.starts_with("run_not_found: "), "{}", error.message);
    }

    #[tokio::test]
    async fn runs_listing_supports_task_status_and_limit_filters() {
        let directory = tempfile::tempdir().unwrap();
        let state = test_state(directory.path()).await;
        let task = create_task_via_api(&state, "history").await;

        for _ in 0..3 {
            let Json(run) = run_task(State(state.clone()), Path(task.id.clone())).await.unwrap();
            let _ = cancel_run(State(state.clone()), Path(task.id.clone()), Json(CancelRunRequest { run_id: run.id }))
                .await
                .unwrap();
        }
        // A second task keeps its runs out of the first task's listing.
        let other = create_task_via_api(&state, "other task").await;
        let _ = run_task(State(state.clone()), Path(other.id.clone())).await.unwrap();

        let Json(all) = list_runs(
            State(state.clone()),
            Query(ListRunsQuery {
                task_id: Some(task.id.clone()),
                status: None,
                limit: None,
                before: None,
                after: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(all.len(), 3);
        assert!(all.iter().all(|run| run.task_id == task.id));

        let Json(cancelled) = list_runs(
            State(state.clone()),
            Query(ListRunsQuery {
                task_id: Some(task.id.clone()),
                status: Some("cancelled".to_owned()),
                limit: None,
                before: None,
                after: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(cancelled.len(), 3);

        let Json(queued) = list_runs(
            State(state.clone()),
            Query(ListRunsQuery {
                task_id: Some(task.id.clone()),
                status: Some("queued".to_owned()),
                limit: None,
                before: None,
                after: None,
            }),
        )
        .await
        .unwrap();
        assert!(queued.is_empty());

        let Json(limited) = list_runs(
            State(state.clone()),
            Query(ListRunsQuery {
                task_id: Some(task.id.clone()),
                status: None,
                limit: Some(2),
                before: None,
                after: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(limited.len(), 2);

        // Cursor: everything older than the newest run.
        let newest = all[0].id.clone();
        let Json(older) = list_runs(
            State(state.clone()),
            Query(ListRunsQuery {
                task_id: Some(task.id.clone()),
                status: None,
                limit: None,
                before: Some(newest.clone()),
                after: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(older.len(), 2);
        assert!(older.iter().all(|run| run.id != newest));

        // Unknown cursor yields an empty page rather than leaking everything.
        let Json(empty) = list_runs(
            State(state.clone()),
            Query(ListRunsQuery {
                task_id: Some(task.id.clone()),
                status: None,
                limit: None,
                before: None,
                after: Some("ghost".to_owned()),
            }),
        )
        .await
        .unwrap();
        assert!(empty.is_empty());
    }

    // -- Logs pagination (ADR §7.3) --------------------------------------

    #[tokio::test]
    async fn logs_support_after_seq_limit_level_and_stream_filters() {
        let directory = tempfile::tempdir().unwrap();
        let state = test_state(directory.path()).await;
        let task = create_task_via_api(&state, "logged").await;
        let Json(run) = run_task(State(state.clone()), Path(task.id.clone())).await.unwrap();

        // Seed the log the way the engine does: JSONL segments plus the
        // `task_log_index` row that resolves the run directory.
        let created = chrono::DateTime::parse_from_rfc3339(&run.created_at).unwrap().with_timezone(&chrono::Utc);
        let log_dir = dbx_core::scheduler::SchedulerStore::new(directory.path())
            .logs_root()
            .join(created.format("%Y/%m/%d").to_string())
            .join(&run.id);
        let mut logger = TaskLogger::open(log_dir.clone()).unwrap();
        for index in 0..5 {
            let stream = if index % 2 == 0 { "stdout" } else { "stderr" };
            logger.append("info", stream, &format!("line {index}")).unwrap();
        }
        let stats = logger.stats().unwrap();
        let segment_path = log_dir.join(format!("{:06}.log", stats.segment));
        dbx_core::scheduler::SchedulerStore::new(directory.path())
            .upsert_log_index(run.id.clone(), stats.segment, segment_path, stats.byte_size, stats.line_count)
            .await
            .unwrap();

        let logs = |query: LogsQuery| {
            let state = state.clone();
            let run_id = run.id.clone();
            async move { get_run_logs(State(state), Path(run_id), Query(query)).await.unwrap().0 }
        };

        let page = logs(LogsQuery { after_seq: None, limit: None, level: None, stream: None }).await;
        assert_eq!(page.entries.len(), 5);
        assert_eq!(page.next_seq, 5);
        assert!(page.eof);

        // Pagination: skip the first three entries.
        let tail = logs(LogsQuery { after_seq: Some(3), limit: None, level: None, stream: None }).await;
        assert_eq!(tail.entries.len(), 2);
        assert_eq!(tail.entries[0].seq, 4);

        // Limit truncates and reports eof=false.
        let first_two = logs(LogsQuery { after_seq: None, limit: Some(2), level: None, stream: None }).await;
        assert_eq!(first_two.entries.len(), 2);
        assert!(!first_two.eof);

        // level / stream filters.
        let stderr =
            logs(LogsQuery { after_seq: None, limit: None, level: None, stream: Some("stderr".to_owned()) }).await;
        assert_eq!(stderr.entries.len(), 2);
        assert!(stderr.entries.iter().all(|entry: &TaskLogEntry| entry.stream == "stderr"));

        // Unknown run → 404 before any log lookup.
        let error = get_run_logs(
            State(state.clone()),
            Path("ghost-run".to_owned()),
            Query(LogsQuery { after_seq: None, limit: None, level: None, stream: None }),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::NOT_FOUND);
        assert!(error.message.starts_with("run_not_found: "), "{}", error.message);
    }

    // -- Artifacts -------------------------------------------------------

    #[tokio::test]
    async fn artifacts_of_a_run_are_listed_and_unknown_runs_404() {
        let directory = tempfile::tempdir().unwrap();
        let state = test_state(directory.path()).await;
        let task = create_task_via_api(&state, "artifact").await;
        let Json(run) = run_task(State(state.clone()), Path(task.id.clone())).await.unwrap();

        let store = dbx_core::scheduler::SchedulerStore::new(directory.path());
        store
            .save_artifact(
                run.id.clone(),
                TaskArtifact {
                    name: "app.sql.gz".to_owned(),
                    uri: "/tmp/app.sql.gz".to_owned(),
                    content_type: Some("application/gzip".to_owned()),
                    size: Some(1024),
                    checksum: None,
                },
            )
            .await
            .unwrap();

        let Json(artifacts) = get_run_artifacts(State(state.clone()), Path(run.id.clone())).await.unwrap();
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0].name, "app.sql.gz");
        assert_eq!(artifacts[0].size, Some(1024));

        let error = get_run_artifacts(State(state.clone()), Path("ghost-run".to_owned())).await.unwrap_err();
        assert_eq!(error.status, StatusCode::NOT_FOUND);
        assert!(error.message.starts_with("run_not_found: "), "{}", error.message);
    }

    // -- Enable / disable / delete ---------------------------------------

    #[tokio::test]
    async fn enable_disable_and_delete_round_trip() {
        let directory = tempfile::tempdir().unwrap();
        let state = test_state(directory.path()).await;
        let task = create_task_via_api(&state, "toggle").await;
        assert!(task.enabled);

        let Json(disabled) = disable_task(State(state.clone()), Path(task.id.clone())).await.unwrap();
        assert!(!disabled.enabled);
        assert_eq!(disabled.version, task.version + 1);

        let Json(enabled) = enable_task(State(state.clone()), Path(task.id.clone())).await.unwrap();
        assert!(enabled.enabled);

        let Json(result) = delete_task(State(state.clone()), Path(task.id.clone())).await.unwrap();
        assert_eq!(result["deleted"], serde_json::json!(true));
        let error = get_task(State(state.clone()), Path(task.id.clone())).await.unwrap_err();
        assert_eq!(error.status, StatusCode::NOT_FOUND);

        let error = disable_task(State(state.clone()), Path(task.id.clone())).await.unwrap_err();
        assert_eq!(error.status, StatusCode::NOT_FOUND);
    }

    // -- Resident --------------------------------------------------------

    #[tokio::test]
    async fn resident_list_and_unknown_session_is_404() {
        let directory = tempfile::tempdir().unwrap();
        let state = test_state(directory.path()).await;

        let Json(sessions) = list_resident_sessions(State(state.clone())).await.unwrap();
        assert!(sessions.is_empty());

        for action in ["start", "stop", "restart"] {
            let error = match action {
                "start" => resident_start(State(state.clone()), Path("ghost".to_owned())).await.unwrap_err(),
                "stop" => resident_stop(State(state.clone()), Path("ghost".to_owned())).await.unwrap_err(),
                _ => resident_restart(State(state.clone()), Path("ghost".to_owned())).await.unwrap_err(),
            };
            assert_eq!(error.status, StatusCode::NOT_FOUND, "action {action}");
            assert!(error.message.starts_with("session_not_found: "), "{}", error.message);
        }
    }

    // -- Event stream ----------------------------------------------------

    #[tokio::test]
    async fn events_stream_delivers_published_payloads() {
        let directory = tempfile::tempdir().unwrap();
        let state = test_state(directory.path()).await;
        let task = create_task_via_api(&state, "evented").await;

        // Mutation handlers publish on the hub; a subscriber receives them.
        // The hub is process-global, so parallel tests may interleave their
        // events: wait (bounded) for this test's own run-created payload.
        let mut rx = events_hub().subscribe();
        let _ = run_task(State(state.clone()), Path(task.id.clone())).await.unwrap();
        let deadline = std::time::Duration::from_secs(10);
        loop {
            let event = tokio::time::timeout(deadline, rx.recv()).await.unwrap().unwrap();
            let payload: serde_json::Value = serde_json::from_str(&event).unwrap();
            if payload["type"] == "run-created" && payload["taskId"] == task.id.as_str() {
                assert!(payload["runId"].is_string());
                break;
            }
        }
    }
}
