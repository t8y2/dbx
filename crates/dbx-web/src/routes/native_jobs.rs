use crate::error::AppError;
use crate::state::WebState;
use axum::extract::State;
use axum::Json;
use dbx_core::native_jobs::{
    NativeJobContext, NativeJobDetails, NativeJobList, NativeJobListRequest, NativeJobOperationStatus,
    NativeJobPreparedPlan, NativeJobRef, NativeJobReferenceCatalog, NativeJobReferenceListRequest, NativeJobRequest,
};
use dbx_core::schema::native_jobs as jobs;
use serde::Deserialize;
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextRequest {
    connection_id: String,
    database: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyRequest {
    plan_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationRequest {
    operation_id: String,
    #[serde(default)]
    observe: bool,
}

pub async fn open_context(
    State(state): State<Arc<WebState>>,
    Json(request): Json<ContextRequest>,
) -> Result<Json<NativeJobContext>, AppError> {
    jobs::native_job_open_context_core(&state.app, &request.connection_id, &request.database)
        .await
        .map(Json)
        .map_err(AppError::from)
}
pub async fn list(
    State(state): State<Arc<WebState>>,
    Json(request): Json<NativeJobListRequest>,
) -> Result<Json<NativeJobList>, AppError> {
    jobs::native_job_list_core(&state.app, &request).await.map(Json).map_err(AppError::from)
}
pub async fn references(
    State(state): State<Arc<WebState>>,
    Json(request): Json<NativeJobReferenceListRequest>,
) -> Result<Json<NativeJobReferenceCatalog>, AppError> {
    jobs::native_job_references_core(&state.app, &request).await.map(Json).map_err(AppError::from)
}
pub async fn read(
    State(state): State<Arc<WebState>>,
    Json(target): Json<NativeJobRef>,
) -> Result<Json<NativeJobDetails>, AppError> {
    jobs::native_job_read_core(&state.app, &target).await.map(Json).map_err(AppError::from)
}
pub async fn prepare(
    State(state): State<Arc<WebState>>,
    Json(mutation): Json<NativeJobRequest>,
) -> Result<Json<NativeJobPreparedPlan>, AppError> {
    jobs::native_job_prepare_core(&state.app, mutation).await.map(Json).map_err(AppError::from)
}
pub async fn apply(
    State(state): State<Arc<WebState>>,
    Json(request): Json<ApplyRequest>,
) -> Result<Json<NativeJobOperationStatus>, AppError> {
    jobs::native_job_apply_core(state.app.clone(), &request.plan_id).map(Json).map_err(AppError::from)
}
pub async fn status(
    State(state): State<Arc<WebState>>,
    Json(request): Json<OperationRequest>,
) -> Json<NativeJobOperationStatus> {
    Json(jobs::native_job_status_observed_core(&state.app, &request.operation_id, request.observe).await)
}
pub async fn cancel(
    State(state): State<Arc<WebState>>,
    Json(request): Json<OperationRequest>,
) -> Json<NativeJobOperationStatus> {
    Json(jobs::native_job_cancel(&state.app, &request.operation_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use dbx_core::connection::AppState;
    use dbx_core::native_jobs::{NativeJobOperationOutcome, NativeJobScope};

    async fn setup() -> (tempfile::TempDir, Arc<WebState>) {
        let dir = tempfile::tempdir().unwrap();
        let storage = dbx_core::persistence::test_storage::open(&dir.path().join("state.db")).await.unwrap();
        let app = Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
            storage,
            dir.path().join("plugins"),
            dir.path().join("agents"),
            "0.0.0",
        ));
        let state = Arc::new(WebState::for_tests(app, dir.path().into()));
        (dir, state)
    }

    #[tokio::test]
    async fn apply_cannot_replace_server_prepared_content_with_client_sql() {
        let (_dir, state) = setup().await;
        let request: ApplyRequest =
            serde_json::from_value(serde_json::json!({"planId":"missing-plan", "sql":"sensitive client SQL"})).unwrap();
        let error = apply(State(state), Json(request)).await.err().unwrap();
        assert_eq!(error.message, "native_job_preview_stale");
    }

    #[tokio::test]
    async fn lost_records_remain_unknown_through_status_and_cancel_routes() {
        let (_dir, state) = setup().await;
        let request = || OperationRequest { operation_id: "missing-operation".into(), observe: false };
        let Json(status) = status(State(state.clone()), Json(request())).await;
        let Json(canceled) = cancel(State(state), Json(request())).await;
        assert_eq!(status.outcome, NativeJobOperationOutcome::Unknown);
        assert_eq!(canceled.outcome, NativeJobOperationOutcome::Unknown);
        assert!(canceled.target.is_none());
    }

    #[tokio::test]
    async fn invalid_target_scope_is_rejected_by_the_real_core_read_before_driver_access() {
        let (_dir, state) = setup().await;
        let target = NativeJobRef::Legacy {
            scope: NativeJobScope { connection_id: "c".into(), database: "".into(), context_id: "".into() },
            job_id: "9007199254740993".into(),
        };
        let error = read(State(state), Json(target)).await.err().unwrap();
        assert_eq!(error.message, "native_job_identity_invalid");
    }

    #[tokio::test]
    async fn reference_catalog_scope_is_rejected_before_driver_access() {
        let (_dir, state) = setup().await;
        let request = serde_json::from_value(serde_json::json!({
            "scope": {"connectionId":"c", "database":"", "contextId":""}, "kind":"program"
        }))
        .unwrap();
        let error = references(State(state), Json(request)).await.err().unwrap();
        assert_eq!(error.message, "native_job_identity_invalid");
    }

    #[tokio::test]
    async fn legacy_create_preview_keeps_core_scope_and_ignores_a_client_invented_id() {
        let (_dir, state) = setup().await;
        state.app.configs.write().await.insert(
            "c".into(),
            serde_json::from_value(serde_json::json!({
                "id":"c","name":"test","db_type":"oracle","host":"127.0.0.1","port":1,"username":"Owner","password":"",
            }))
            .unwrap(),
        );
        let context = jobs::native_job_open_context_with(&state.app, "c", "", |_| {
            std::future::ready(Ok(jobs::NativeJobRuntimeIdentity { database_info: None, session_user: "Owner".into() }))
        })
        .await
        .unwrap();
        let request = serde_json::from_value(serde_json::json!({
            "action":"create", "scope":context.scope,
            "target":{"kind":"legacy","scope":context.scope,"jobId":"9007199254740993"},
            "definition":{"kind":"legacy","what":"private_call();","nextDate":"2026-10-21 10:20:30","interval":"NULL","enabled":false},
        })).unwrap();
        let Json(preview) = prepare(State(state.clone()), Json(request)).await.unwrap();
        assert!(preview.target.is_none());
        assert_eq!(preview.scope, context.scope);
        assert_eq!(
            jobs::native_job_status(&state.app, &preview.operation_id).state,
            dbx_core::native_jobs::NativeJobOperationState::Prepared
        );
    }
}
