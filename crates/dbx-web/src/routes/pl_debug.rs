//! HTTP boundary for the same Core debugger used by desktop commands.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use dbx_core::query::pl_debug::{
    self, PlDebugAccess, PlDebugCompile, PlDebugCompileRef, PlDebugInspect, PlDebugMutationPermit,
    PlDebugMutationScope, PlDebugOperation, PlDebugRead, PlDebugReceipt, PlDebugSessionRef, PlDebugStart,
};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::{auth, error::AppError, state::WebState};

pub fn router() -> Router<Arc<WebState>> {
    Router::new()
        .route("/pl-debug/bootstrap", post(bootstrap))
        .route("/pl-debug/inspect", post(inspect))
        .route("/pl-debug/compile", post(compile))
        .route("/pl-debug/compile-status", post(compile_status))
        .route("/pl-debug/list", post(list))
        .route("/pl-debug/start", post(start))
        .route("/pl-debug/status", post(status))
        .route("/pl-debug/heartbeat", post(heartbeat))
        .route("/pl-debug/operation", post(operation))
        .route("/pl-debug/operate", post(operate))
        .route("/pl-debug/read", post(read))
}

async fn access(state: &WebState, headers: &HeaderMap) -> Result<PlDebugAccess, AppError> {
    validated_access(&*state.sessions.read().await, headers)
}

fn validated_access(
    sessions: &std::collections::HashSet<String>,
    headers: &HeaderMap,
) -> Result<PlDebugAccess, AppError> {
    let token = auth::session_token_from_headers(headers)
        .ok_or_else(|| AppError::forbidden("PL debug browser session is not available"))?;
    if !sessions.contains(&token) {
        return Err(AppError::forbidden("PL debug browser session is not available"));
    }
    // The existing middleware owns credential scope. In password-disabled mode
    // it stays None; the browser token only isolates debugger access.
    PlDebugAccess::web(token).map_err(AppError::from)
}

pub(crate) async fn claim_mutation<'a>(
    state: &'a WebState,
    headers: &HeaderMap,
    scope: PlDebugMutationScope,
) -> Result<PlDebugMutationPermit<'a>, AppError> {
    let sessions = state.sessions.read().await;
    let access = auth::session_token_from_headers(headers)
        .filter(|token| sessions.contains(token))
        .map(PlDebugAccess::web)
        .transpose()?;
    pl_debug::pl_debug_claim_mutation_core(&state.app, access.as_ref(), scope).map_err(AppError::forbidden)
}

async fn bootstrap(State(state): State<Arc<WebState>>, headers: HeaderMap) -> Result<Response, AppError> {
    if !state.password_disabled {
        access(&state, &headers).await?;
        return Ok(Json(pl_debug::pl_debug_bootstrap_core(&state.app)).into_response());
    }
    let supplied = auth::session_token_from_headers(&headers);
    let mut sessions = state.sessions.write().await;
    if supplied.as_ref().is_some_and(|token| sessions.contains(token)) {
        return Ok(Json(pl_debug::pl_debug_bootstrap_core(&state.app)).into_response());
    }
    let token = Uuid::new_v4().to_string();
    sessions.insert(token.clone());
    drop(sessions);
    let cookie = auth::session_cookie(&state, &token);
    Ok((StatusCode::OK, [("set-cookie", cookie)], Json(pl_debug::pl_debug_bootstrap_core(&state.app))).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListRequest {
    server_epoch: Uuid,
    connection_id: String,
}

async fn list(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(request): Json<ListRequest>,
) -> Result<Json<Vec<Value>>, AppError> {
    let owner = access(&state, &headers).await?;
    Ok(Json(pl_debug::pl_debug_list_core(&state.app, &owner, request.server_epoch, &request.connection_id)?))
}

async fn inspect(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(request): Json<PlDebugInspect>,
) -> Result<Json<Value>, AppError> {
    let owner = access(&state, &headers).await?;
    let result = match pl_debug::pl_debug_prepare_inspection_core(&state.app, &request).await? {
        Some(admission) => {
            let sessions = state.sessions.read().await;
            let owner = validated_access(&sessions, &headers)?;
            let submission = pl_debug::pl_debug_submit_inspection_core(&state.app, &owner, admission)?;
            drop(sessions);
            submission.wait().await
        }
        None => pl_debug::pl_debug_inspect_core(&state.app, &owner, request).await,
    };
    access(&state, &headers).await?;
    Ok(Json(result?))
}

async fn start(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(request): Json<PlDebugStart>,
) -> Result<Json<PlDebugReceipt>, AppError> {
    // Registration and revocation share this short boundary. No RPC is awaited
    // while holding the auth lock, and logout cannot miss a just-accepted start.
    let sessions = state.sessions.read().await;
    let owner = validated_access(&sessions, &headers)?;
    Ok(Json(
        pl_debug::pl_debug_start_submission_core(&state.app, &owner, request)
            .map_err(|error| AppError::from(error.into_backend_error()))?,
    ))
}

async fn compile(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(request): Json<PlDebugCompile>,
) -> Result<Json<Value>, AppError> {
    let owner = access(&state, &headers).await?;
    let admission = pl_debug::pl_debug_prepare_compile_core(&state.app, &owner, request)
        .await
        .map_err(|error| AppError::from(error.into_backend_error()))?;
    submit_prepared_compilation(&state, &headers, admission).await
}

async fn submit_prepared_compilation(
    state: &WebState,
    headers: &HeaderMap,
    admission: pl_debug::PlDebugCompileAdmission,
) -> Result<Json<Value>, AppError> {
    let sessions = state.sessions.read().await;
    let owner = validated_access(&sessions, headers)?;
    Ok(Json(
        pl_debug::pl_debug_submit_compile_core(&state.app, &owner, admission)
            .map_err(|error| AppError::from(error.into_backend_error()))?,
    ))
}

async fn compile_status(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(reference): Json<PlDebugCompileRef>,
) -> Result<Json<Value>, AppError> {
    let sessions = state.sessions.read().await;
    let owner = validated_access(&sessions, &headers)?;
    Ok(Json(pl_debug::pl_debug_compile_status_core(&state.app, &owner, reference)?))
}

#[derive(Deserialize)]
struct StatusRequest {
    reference: PlDebugSessionRef,
    #[serde(default)]
    refresh: bool,
}

async fn status(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(request): Json<StatusRequest>,
) -> Result<Json<Value>, AppError> {
    let owner = access(&state, &headers).await?;
    Ok(Json(pl_debug::pl_debug_status_core(&state.app, &owner, &request.reference, request.refresh).await?))
}

async fn heartbeat(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(reference): Json<PlDebugSessionRef>,
) -> Result<Json<Value>, AppError> {
    let owner = access(&state, &headers).await?;
    Ok(Json(pl_debug::pl_debug_heartbeat_core(&state.app, &owner, &reference).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OperationRequest {
    reference: PlDebugSessionRef,
    operation_id: String,
}

async fn operation(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(request): Json<OperationRequest>,
) -> Result<Json<PlDebugReceipt>, AppError> {
    let owner = access(&state, &headers).await?;
    Ok(Json(pl_debug::pl_debug_operation_core(&state.app, &owner, &request.reference, &request.operation_id)?))
}

async fn operate(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(request): Json<PlDebugOperation>,
) -> Result<Json<PlDebugReceipt>, AppError> {
    let owner = access(&state, &headers).await?;
    Ok(Json(
        pl_debug::pl_debug_operate_submission_core(&state.app, &owner, request)
            .await
            .map_err(|error| AppError::from(error.into_backend_error()))?,
    ))
}

async fn read(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(request): Json<PlDebugRead>,
) -> Result<Json<Value>, AppError> {
    let owner = access(&state, &headers).await?;
    Ok(Json(pl_debug::pl_debug_read_core(&state.app, &owner, request).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{middleware, routing::get};
    use serde_json::json;

    struct TestServer {
        address: std::net::SocketAddr,
        task: tokio::task::JoinHandle<()>,
    }
    impl TestServer {
        async fn post(&self, path: &str, cookie: Option<&str>, body: Value) -> reqwest::Response {
            let mut request = reqwest::Client::new().post(format!("http://{}{path}", self.address)).json(&body);
            if let Some(cookie) = cookie {
                request = request.header("cookie", cookie);
            }
            request.send().await.unwrap()
        }
    }
    impl Drop for TestServer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn fixture(disabled: bool) -> (tempfile::TempDir, Arc<WebState>, TestServer) {
        let directory = tempfile::tempdir().unwrap();
        let storage = dbx_core::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
        let app = Arc::new(dbx_core::connection::AppState::new_with_plugin_and_agent_dir_and_app_version(
            storage,
            directory.path().join("plugins"),
            directory.path().join("agents"),
            "test",
        ));
        let mut state = WebState::for_tests(app, directory.path().to_path_buf());
        state.password_disabled = disabled;
        if !disabled {
            *state.password_hash.get_mut() = Some("configured".into());
        }
        let state = Arc::new(state);
        let routes = router()
            .route("/auth/logout", post(auth::logout))
            .route("/auth/change-password", post(auth::change_password))
            .route("/connection/disconnect", post(crate::routes::connection::disconnect_db))
            .route("/connection/connect", post(crate::routes::connection::connect_db))
            .route("/connection/final-proxy-port", post(crate::routes::connection::connection_final_proxy_port))
            .route("/connection/save", post(crate::routes::connection::save_connections))
            .route("/connection/list", get(crate::routes::connection::load_connections))
            .route("/connection/mcp/remove", post(crate::routes::connection::mcp_remove_connection))
            .route("/connection/mcp/add", post(crate::routes::connection::mcp_add_connection))
            .route("/connection/mcp/duplicate", post(crate::routes::connection::mcp_duplicate_connection))
            .route("/connection/write-unlock", post(crate::routes::connection::unlock_connection_writes))
            .route("/connection/write-unlock/lock", post(crate::routes::connection::lock_connection_writes))
            .route("/connection/write-unlock/state", post(crate::routes::connection::connection_write_unlock_state))
            .route("/tunnel-profiles/save", post(crate::routes::tunnel_profiles::save_tunnel_profiles))
            .route("/agents/runtime/stop", post(crate::routes::agents::stop_driver_runtime))
            .route("/agents/runtime/restart", post(crate::routes::agents::restart_driver_runtime))
            .route("/agents/java-runtime", post(crate::routes::agents::set_agent_java_runtime_config))
            .layer(middleware::from_fn_with_state(state.clone(), auth::auth_middleware))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, routes).await.unwrap() });
        (directory, state, TestServer { address, task })
    }

    #[tokio::test]
    async fn password_disabled_bootstrap_issues_and_reuses_a_server_browser_token() {
        let (_directory, state, routes) = fixture(true).await;
        let first = routes.post("/pl-debug/bootstrap", Some("dbx_session=untrusted"), serde_json::json!({})).await;
        assert_eq!(first.status(), StatusCode::OK);
        let cookie = first.headers()["set-cookie"].to_str().unwrap().to_string();
        assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Lax"));
        let token = cookie.split(';').next().unwrap();
        assert_ne!(token, "dbx_session=untrusted");
        assert_eq!(state.sessions.read().await.len(), 1);
        let bootstrap: Value = first.json().await.unwrap();
        let list_body = serde_json::json!({"serverEpoch":bootstrap["serverEpoch"],"connectionId":"conn"});
        let denied = routes.post("/pl-debug/list", Some("dbx_session=untrusted"), list_body.clone()).await;
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
        let denied_inspect = routes
            .post(
                "/pl-debug/inspect",
                Some("dbx_session=untrusted"),
                serde_json::json!({
                    "connectionId":"conn", "database":"APP", "clientSessionId":"editor"
                }),
            )
            .await;
        assert_eq!(denied_inspect.status(), StatusCode::FORBIDDEN);
        let reused = routes.post("/pl-debug/bootstrap", Some(token), serde_json::json!({})).await;
        assert!(reused.headers().get("set-cookie").is_none());
        assert_eq!(state.sessions.read().await.len(), 1);
        let allowed = routes.post("/pl-debug/list", Some(token), list_body.clone()).await;
        assert_eq!(allowed.status(), StatusCode::OK);
        state.sessions.write().await.clear();
        let revoked = routes.post("/pl-debug/list", Some(token), list_body).await;
        assert_eq!(revoked.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn password_enabled_bootstrap_requires_existing_authenticated_session() {
        let (_directory, state, routes) = fixture(false).await;
        let denied = routes.post("/pl-debug/bootstrap", None, serde_json::json!({})).await;
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
        assert!(state.sessions.read().await.is_empty());
        state.sessions.write().await.insert("validated-login".into());
        let allowed =
            routes.post("/pl-debug/bootstrap", Some("dbx_session=validated-login"), serde_json::json!({})).await;
        assert_eq!(allowed.status(), StatusCode::OK);
        assert!(allowed.headers().get("set-cookie").is_none());
        assert_eq!(state.sessions.read().await.len(), 1);
    }

    async fn configure_agent(state: &WebState, routes: &TestServer) {
        let driver = state.app.agent_manager.driver_dir("oracle");
        std::fs::create_dir_all(&driver).unwrap();
        std::fs::write(driver.join("agent.py"), r#"import json, os, pathlib, sys, threading, time
root=pathlib.Path(__file__).parent
snapshot={'state':'paused','stopRevision':1,'executionStopped':False,'executionOutcome':'pending','releaseState':'open','transactionOutcome':'pending','targetDispatched':True}
compile_receipt={}
threading.Timer(30,lambda:os._exit(9)).start()
def event(method):
    with open(root/'events','a',encoding='utf-8') as f: f.write(json.dumps({'method':method,'scope':os.environ.get('DBX_PL_DEBUG_RUNTIME_SCOPE')})+'\n')
print(json.dumps({'ready':True}),flush=True)
for line in sys.stdin:
    req=json.loads(line); method=req['method']; event(method)
    if method=='handshake': result={'protocolVersion':2,'agentProtocolVersion':2,'capabilities':['multi_session','structured_error_v1'],'plDebug':{'contractVersion':1,'helperObjects':False}}
    elif method=='open_session':
        scope={'anonymous-secret':'default','first-secret':'first','second-secret':'second'}.get(req['params'].get('password'),'wrong')
        event('credential_'+scope); result={'ok':True}
    elif method=='pl_debug_inspect':
        while (root/'delay-inspect').exists() and not (root/'inspect-gate').exists(): time.sleep(0.01)
        result={'capabilities':{'canAttemptStart':True,'startVerified':False},'targetPreview':{'state':'available','candidates':[]}}
        if (req['params'].get('target') or {}).get('metadataPreparation')=='debug_compile':
            result['compilePreview']={'schema':'APP','objectName':'P','objectType':'PROCEDURE','sql':'ALTER PROCEDURE "APP"."P" COMPILE DEBUG REUSE SETTINGS','reusesSettings':True,'sources':[],'canCompile':True,'state':'available'}
    elif method=='pl_debug_compile':
        compile_receipt={'operationId':req['params']['operationId'],'dispatched':True,'ddlState':'executed','finished':True,'readback':{'status':'INVALID','diagnosticsComplete':True,'diagnostics':[{'text':'fixture diagnostic'}]}}
        while (root/'delay-compile').exists() and not (root/'compile-gate').exists(): time.sleep(0.01)
        result=compile_receipt
    elif method=='pl_debug_compile_status': result=compile_receipt
    elif method=='close_session': result={'ok':True}
    elif method=='pl_debug_start': snapshot['debugId']=req['params']['operationId']; result=snapshot
    elif method=='pl_debug_close':
        while (root/'delay-close').exists() and not (root/'close-gate').exists(): time.sleep(0.01)
        snapshot.update(state='ended',executionStopped=True,executionOutcome='cancelled',releaseState='released',transactionOutcome='rolled_back'); result=True
    elif method=='pl_debug_get_log': result={**snapshot,'output':'private output','outputComplete':True}
    else: result=snapshot
    print(json.dumps({'jsonrpc':'2.0','id':req['id'],'result':result}),flush=True)
    if method=='shutdown': os._exit(0)
"#).unwrap();
        std::fs::write(
            state.app.agent_manager.driver_launch_config_path("oracle"),
            serde_json::json!({
                "command":if cfg!(windows) {"python"} else {"python3"},
                "args":["{driver_dir}/agent.py"],"working_dir":"{driver_dir}"
            })
            .to_string(),
        )
        .unwrap();
        let config = serde_json::from_value(serde_json::json!({
            "id":"conn","name":"Debug fixture","db_type":"oracle","host":"127.0.0.1",
            "port":routes.address.port(),"username":"fixture","password":"","database":"xe","save_password":false
        }))
        .unwrap();
        state.app.configs.write().await.insert("conn".into(), config);
        state.app.session_credentials.set("", "conn", "anonymous-secret");
        for owner in ["first", "second"] {
            state.app.session_credentials.set(owner, "conn", &format!("{owner}-secret"));
        }
    }

    fn events(state: &WebState, method: &str) -> usize {
        std::fs::read_to_string(state.app.agent_manager.driver_dir("oracle").join("events"))
            .unwrap_or_default()
            .lines()
            .filter(|line| serde_json::from_str::<Value>(line).unwrap()["method"] == method)
            .count()
    }

    async fn wait_events(state: &WebState, method: &str, count: usize) {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while events(state, method) < count {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("expected {count} {method} events, got {}", events(state, method)));
    }

    async fn start_session(state: &WebState, routes: &TestServer, owner: &str) -> Value {
        start_session_at(state, routes, owner, "conn").await
    }

    async fn start_session_at(state: &WebState, routes: &TestServer, owner: &str, connection_id: &str) -> Value {
        state.sessions.write().await.insert(owner.into());
        let cookie = format!("dbx_session={owner}");
        let bootstrap: Value =
            routes.post("/pl-debug/bootstrap", Some(&cookie), serde_json::json!({})).await.json().await.unwrap();
        let started = routes
            .post(
                "/pl-debug/start",
                Some(&cookie),
                serde_json::json!({
                    "serverEpoch":bootstrap["serverEpoch"],"operationId":format!("start-{owner}"),"connectionId":connection_id,
                    "database":"APP","clientSessionId":"editor","target":{"source":"BEGIN NULL; END;"},
                    "riskAccepted":true,"productionConfirmed":false
                }),
            )
            .await;
        assert_eq!(started.status(), StatusCode::OK);
        let receipt: Value = started.json().await.unwrap();
        let reference = serde_json::json!({"serverEpoch":bootstrap["serverEpoch"],"sessionId":receipt["sessionId"],
            "connectionId":connection_id,"clientSessionId":"editor"});
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let status: Value = routes
                    .post("/pl-debug/status", Some(&cookie), serde_json::json!({"reference":reference}))
                    .await
                    .json()
                    .await
                    .unwrap();
                if status["state"] == "paused" {
                    break;
                }
                assert_ne!(status["state"], "ended", "{status}");
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        reference
    }

    #[tokio::test]
    async fn admission_http_distinguishes_new_rejections_from_owner_and_epoch_failures() {
        let (_directory, state, routes) = fixture(false).await;
        configure_agent(&state, &routes).await;
        state.sessions.write().await.extend(["first".into(), "second".into()]);
        let cookie = Some("dbx_session=first");
        let bootstrap: Value = routes.post("/pl-debug/bootstrap", cookie, json!({})).await.json().await.unwrap();
        let rejected_start: Value = routes
            .post(
                "/pl-debug/start",
                cookie,
                json!({
                    "serverEpoch":bootstrap["serverEpoch"],"operationId":"stale-preview","connectionId":"conn",
                    "database":"APP","clientSessionId":"editor","target":{"source":"BEGIN NULL; END;"},
                    "riskAccepted":true,"productionConfirmed":false,"expectedConnectionRevision":"stale"
                }),
            )
            .await
            .json()
            .await
            .unwrap();
        let starts_before = events(&state, "pl_debug_start");
        let reference = start_session(&state, &routes, "first").await;
        let status: Value =
            routes.post("/pl-debug/status", cookie, json!({"reference":reference})).await.json().await.unwrap();
        let mut request = reference.clone();
        let object = request.as_object_mut().unwrap();
        object.insert("operationId".into(), json!("stale-control"));
        object.insert("generation".into(), status["generation"].clone());
        object.insert("expectedRevision".into(), json!(status["revision"].as_u64().unwrap() + 1));
        object.insert("action".into(), json!("step_over"));
        let stale: Value = routes.post("/pl-debug/operate", cookie, request.clone()).await.json().await.unwrap();
        request["expectedRevision"] = status["revision"].clone();
        state.app.configs.write().await.get_mut("conn").unwrap().read_only = true;
        let protected: Value = routes.post("/pl-debug/operate", cookie, request.clone()).await.json().await.unwrap();
        let foreign: Value =
            routes.post("/pl-debug/operate", Some("dbx_session=second"), request.clone()).await.json().await.unwrap();
        request["serverEpoch"] = json!(Uuid::new_v4());
        let epoch: Value = routes.post("/pl-debug/operate", cookie, request).await.json().await.unwrap();
        let controls = events(&state, "pl_debug_step_over");
        state.app.shutdown(std::time::Duration::from_secs(1)).await;
        for rejection in [rejected_start, stale, protected] {
            assert_eq!(rejection["code"], "DBX-PLDEBUG-1001", "{rejection}");
            assert_eq!(rejection["operationOutcome"], "not_started");
            assert_eq!(rejection["origin"], json!({"subsystem":"backend","adapter":"legacy"}));
        }
        for unresolved in [foreign, epoch] {
            assert_ne!(unresolved["code"], "DBX-PLDEBUG-1001");
            assert_eq!(unresolved["operationOutcome"], "unknown");
        }
        assert_eq!(starts_before, 0);
        assert_eq!(controls, 0);
    }

    #[tokio::test]
    async fn profile_save_protects_original_sources_after_runtime_configuration_replacement_or_removal() {
        let mut outcomes = Vec::new();
        for (disabled, cookie) in
            [(false, Some("dbx_session=second")), (true, Some("dbx_session=second")), (true, None)]
        {
            for remove_config in [false, true] {
                let (_directory, state, routes) = fixture(disabled).await;
                configure_agent(&state, &routes).await;
                let profile: dbx_core::models::connection::TransportLayerConfig =
                    serde_json::from_value(serde_json::json!({
                        "type":"proxy","id":"shared","name":"Shared","enabled":true,"proxy_type":"socks5",
                        "host":"127.0.0.1","port":65000,"username":"","password":"original-secret"
                    }))
                    .unwrap();
                state.app.storage.save_tunnel_profiles(std::slice::from_ref(&profile)).await.unwrap();
                let mut reference = serde_json::to_value(&profile).unwrap();
                reference["id"] = serde_json::json!("reference");
                reference["profile_id"] = serde_json::json!("shared");
                state.app.configs.write().await.get_mut("conn").unwrap().transport_layers =
                    vec![serde_json::from_value(reference).unwrap()];
                start_session(&state, &routes, "first").await;
                state.sessions.write().await.insert("second".into());
                if remove_config {
                    state.app.configs.write().await.remove("conn");
                } else {
                    state.app.configs.write().await.get_mut("conn").unwrap().transport_layers.clear();
                }
                let mut changed = serde_json::to_value(&profile).unwrap();
                changed["password"] = serde_json::json!("changed-secret");
                let response =
                    routes.post("/tunnel-profiles/save", cookie, serde_json::json!({"profiles":[changed]})).await;
                let unchanged = state.app.storage.load_tunnel_profiles().await.unwrap() == vec![profile];
                let closes = events(&state, "pl_debug_close");
                state.app.shutdown(std::time::Duration::from_secs(1)).await;
                outcomes.push((disabled, cookie.is_some(), remove_config, response.status(), unchanged, closes));
            }
        }
        assert!(
            outcomes.iter().all(|(_, _, _, status, unchanged, closes)| {
                *status == StatusCode::FORBIDDEN && *unchanged && *closes == 0
            }),
            "{outcomes:?}"
        );
    }

    #[tokio::test]
    async fn profile_save_cannot_delete_another_owners_orphan_or_extra_secret_rows() {
        let mut outcomes = Vec::new();
        for (disabled, cookie) in
            [(false, Some("dbx_session=second")), (true, Some("dbx_session=second")), (true, None)]
        {
            for orphan in [false, true] {
                let (_directory, state, routes) = fixture(disabled).await;
                configure_agent(&state, &routes).await;
                let profile: dbx_core::models::connection::TransportLayerConfig =
                    serde_json::from_value(serde_json::json!({
                        "type":"proxy","id":"shared","name":"Shared","host":"127.0.0.1","port":65000
                    }))
                    .unwrap();
                state.app.storage.save_tunnel_profiles(std::slice::from_ref(&profile)).await.unwrap();
                let mut layer = serde_json::to_value(&profile).unwrap();
                layer["profile_id"] = serde_json::json!("shared");
                layer["id"] = serde_json::json!("reference");
                state.app.configs.write().await.get_mut("conn").unwrap().transport_layers =
                    vec![serde_json::from_value(layer).unwrap()];
                start_session(&state, &routes, "first").await;
                state.sessions.write().await.insert("second".into());
                if orphan {
                    state.app.storage.save_tunnel_profiles(&[]).await.unwrap();
                }
                state.app.storage.set_secret("tunnel_profile.shared", "extra", "retained-secret").await.unwrap();
                let before = state.app.storage.load_tunnel_profiles_readonly().await.unwrap();
                let response =
                    routes.post("/tunnel-profiles/save", cookie, serde_json::json!({"profiles":before})).await;
                let retained = state.app.storage.get_secret("tunnel_profile.shared", "extra").await.unwrap();
                let unchanged = state.app.storage.load_tunnel_profiles_readonly().await.unwrap() == before;
                let closes = events(&state, "pl_debug_close");
                state.app.shutdown(std::time::Duration::from_secs(1)).await;
                outcomes.push((
                    disabled,
                    cookie.is_some(),
                    orphan,
                    response.status(),
                    retained.is_some(),
                    unchanged,
                    closes,
                ));
            }
        }
        assert!(
            outcomes.iter().all(|(_, _, _, status, retained, unchanged, closes)| {
                *status == StatusCode::FORBIDDEN && *retained && *unchanged && *closes == 0
            }),
            "{outcomes:?}"
        );
    }

    #[tokio::test]
    async fn profile_save_reauthorizes_raw_only_changes_after_waiting_for_original_cleanup() {
        let (_directory, state, routes) = fixture(false).await;
        configure_agent(&state, &routes).await;
        let profiles = ["shared", "other"].map(|id| {
            serde_json::from_value::<dbx_core::models::connection::TransportLayerConfig>(serde_json::json!({
                "type":"proxy","id":id,"host":"127.0.0.1","port":65000
            }))
            .unwrap()
        });
        state.app.storage.save_tunnel_profiles(&profiles).await.unwrap();
        let original = state.app.configs.read().await["conn"].clone();
        for (id, profile) in ["conn", "other"].into_iter().zip(&profiles) {
            let mut config = original.clone();
            config.id = id.into();
            let mut layer = serde_json::to_value(profile).unwrap();
            layer["profile_id"] = serde_json::json!(profile.id());
            layer["id"] = serde_json::json!("reference");
            config.transport_layers = vec![serde_json::from_value(layer).unwrap()];
            state.app.configs.write().await.insert(id.into(), config);
        }
        state.app.session_credentials.set("second", "other", "second-secret");
        start_session(&state, &routes, "first").await;
        let second = start_session_at(&state, &routes, "second", "other").await;
        let driver = state.app.agent_manager.driver_dir("oracle");
        std::fs::write(driver.join("delay-close"), "ready").unwrap();
        let mut changed = serde_json::to_value(&profiles).unwrap();
        changed[0]["password"] = serde_json::json!("changed-secret");
        let address = routes.address;
        let save = tokio::spawn(async move {
            reqwest::Client::new()
                .post(format!("http://{address}/tunnel-profiles/save"))
                .header("cookie", "dbx_session=first")
                .json(&serde_json::json!({"profiles":changed}))
                .send()
                .await
                .unwrap()
        });
        wait_events(&state, "pl_debug_close", 1).await;
        state.app.storage.set_secret("tunnel_profile.other", "extra", "other-retained-secret").await.unwrap();
        std::fs::write(driver.join("close-gate"), "ready").unwrap();
        let response = save.await.unwrap();
        let saved = state.app.storage.load_tunnel_profiles_readonly().await.unwrap();
        let extra = state.app.storage.get_secret("tunnel_profile.other", "extra").await.unwrap();
        let status: Value = routes
            .post("/pl-debug/status", Some("dbx_session=second"), serde_json::json!({"reference":second}))
            .await
            .json()
            .await
            .unwrap();
        let closes = events(&state, "pl_debug_close");
        state.app.shutdown(std::time::Duration::from_secs(1)).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(saved, profiles);
        assert!(extra.is_some());
        assert_eq!(status["state"], "paused");
        assert_eq!(closes, 1);
    }

    #[tokio::test]
    async fn profile_save_replans_before_restoring_references_after_a_concurrent_target_change() {
        let (_directory, state, routes) = fixture(false).await;
        configure_agent(&state, &routes).await;
        let profiles = ["shared", "other"].map(|id| {
            serde_json::from_value::<dbx_core::models::connection::TransportLayerConfig>(serde_json::json!({
                "type":"proxy","id":id,"host":"127.0.0.1","port":65000,"password":"original-secret"
            }))
            .unwrap()
        });
        state.app.storage.save_tunnel_profiles(&profiles).await.unwrap();
        let mut layer = serde_json::to_value(&profiles[0]).unwrap();
        layer["id"] = serde_json::json!("reference");
        layer["profile_id"] = serde_json::json!("shared");
        state.app.configs.write().await.get_mut("conn").unwrap().transport_layers =
            vec![serde_json::from_value(layer).unwrap()];
        start_session(&state, &routes, "first").await;
        let driver = state.app.agent_manager.driver_dir("oracle");
        std::fs::write(driver.join("delay-close"), "ready").unwrap();
        let mut changed = serde_json::to_value(&profiles[0]).unwrap();
        changed["password"] = serde_json::json!("replacement-secret");
        let other = crate::credentials::redact_tunnel(profiles[1].clone());
        let address = routes.address;
        let save = tokio::spawn(async move {
            reqwest::Client::new()
                .post(format!("http://{address}/tunnel-profiles/save"))
                .header("cookie", "dbx_session=first")
                .json(&serde_json::json!({"profiles":[changed,other]}))
                .send()
                .await
                .unwrap()
        });
        wait_events(&state, "pl_debug_close", 1).await;
        let mut concurrent = serde_json::to_value(&profiles).unwrap();
        concurrent[1]["host"] = serde_json::json!("127.0.0.2");
        let concurrent: Vec<dbx_core::models::connection::TransportLayerConfig> =
            serde_json::from_value(concurrent).unwrap();
        state.app.storage.save_tunnel_profiles(&concurrent).await.unwrap();
        std::fs::write(driver.join("close-gate"), "ready").unwrap();
        let response = save.await.unwrap();
        let status = response.status();
        let error: Value = response.json().await.unwrap();
        let stored = state.app.storage.load_tunnel_profiles_readonly().await.unwrap();
        let closes = events(&state, "pl_debug_close");
        state.app.shutdown(std::time::Duration::from_secs(1)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{error}");
        assert_eq!(stored, concurrent);
        assert_eq!(closes, 1);
    }

    #[tokio::test]
    async fn profile_save_preserves_unrelated_and_display_changes_but_cleans_up_its_owners_source() {
        let (_directory, state, routes) = fixture(false).await;
        configure_agent(&state, &routes).await;
        let profile: dbx_core::models::connection::TransportLayerConfig = serde_json::from_value(serde_json::json!({
            "type":"proxy","id":"shared","name":"Shared","enabled":true,"proxy_type":"socks5",
            "host":"127.0.0.1","port":65000,"username":"","password":"original-secret"
        }))
        .unwrap();
        let mut other = serde_json::to_value(&profile).unwrap();
        other["id"] = serde_json::json!("other");
        state
            .app
            .storage
            .save_tunnel_profiles(&[profile.clone(), serde_json::from_value(other.clone()).unwrap()])
            .await
            .unwrap();
        let mut reference = serde_json::to_value(&profile).unwrap();
        reference["id"] = serde_json::json!("reference");
        reference["profile_id"] = serde_json::json!("shared");
        state.app.configs.write().await.get_mut("conn").unwrap().transport_layers =
            vec![serde_json::from_value(reference).unwrap()];
        start_session(&state, &routes, "first").await;
        state.sessions.write().await.insert("second".into());
        let mut renamed = serde_json::to_value(&profile).unwrap();
        renamed["name"] = serde_json::json!("Renamed");
        renamed["enabled"] = serde_json::json!(false);
        other["password"] = serde_json::json!("other-changed");
        let allowed = routes
            .post("/tunnel-profiles/save", Some("dbx_session=second"), serde_json::json!({"profiles":[renamed,other]}))
            .await;
        let allowed_status = allowed.status();
        let closes_after_unrelated = events(&state, "pl_debug_close");
        let saved = state.app.storage.load_tunnel_profiles_readonly().await.unwrap();
        let mut cleared = saved.clone();
        cleared.iter_mut().find(|profile| profile.id() == "shared").unwrap().scrub_secrets();
        let changed = routes
            .post("/tunnel-profiles/save", Some("dbx_session=first"), serde_json::json!({"profiles":cleared}))
            .await;
        let changed_status = changed.status();
        let closes_after_own_change = events(&state, "pl_debug_close");
        let final_profiles = state.app.storage.load_tunnel_profiles_readonly().await.unwrap();
        state.app.shutdown(std::time::Duration::from_secs(1)).await;
        assert_eq!(allowed_status, StatusCode::OK);
        assert_eq!(closes_after_unrelated, 0);
        assert_eq!(changed_status, StatusCode::OK);
        assert_eq!(closes_after_own_change, 1);
        assert_eq!(final_profiles, cleared);
    }

    #[tokio::test]
    async fn final_proxy_port_rejects_foreign_configuration_changes_before_any_effect() {
        let mut outcomes = Vec::new();
        for (disabled, cookie) in
            [(false, Some("dbx_session=second")), (true, Some("dbx_session=second")), (true, None)]
        {
            let (_directory, state, routes) = fixture(disabled).await;
            configure_agent(&state, &routes).await;
            start_session(&state, &routes, "first").await;
            state.sessions.write().await.insert("second".into());
            let original = state.app.configs.read().await.get("conn").unwrap().clone();
            let mut replacement = serde_json::to_value(&original).unwrap();
            replacement["host"] = serde_json::json!("127.0.0.2");
            replacement["transport_layers"] = serde_json::json!([{
                "type":"proxy","id":"proxy","name":"Proxy","enabled":true,"proxy_type":"socks5",
                "host":"127.0.0.1","port":65000,"username":"","password":"","profile_id":""
            }]);
            let response =
                routes.post("/connection/final-proxy-port", cookie, serde_json::json!({"config":replacement})).await;
            let unchanged = state.app.configs.read().await.get("conn") == Some(&original);
            let closes = events(&state, "pl_debug_close");
            let proxy_started = state.app.proxy_tunnels.local_port("conn:transport:0").await.is_some();
            let credentials = state.app.session_credentials.get("", "conn");
            state.app.shutdown(std::time::Duration::from_secs(1)).await;
            outcomes.push((
                disabled,
                cookie.is_some(),
                response.status(),
                unchanged,
                closes,
                proxy_started,
                credentials,
            ));
        }
        assert!(
            outcomes.iter().all(|(_, _, status, unchanged, closes, proxy_started, credentials)| {
                *status == StatusCode::FORBIDDEN
                    && *unchanged
                    && *closes == 0
                    && !*proxy_started
                    && credentials.as_deref() == Some("anonymous-secret")
            }),
            "{outcomes:?}"
        );
    }

    #[tokio::test]
    async fn final_proxy_port_reuses_an_unchanged_connection_without_closing_another_owners_debugger() {
        for (disabled, cookie) in
            [(false, Some("dbx_session=second")), (true, Some("dbx_session=second")), (true, None)]
        {
            let (_directory, state, routes) = fixture(disabled).await;
            configure_agent(&state, &routes).await;
            state.sessions.write().await.insert("first".into());
            state.sessions.write().await.insert("second".into());
            let mut config = serde_json::to_value(state.app.configs.read().await.get("conn").unwrap()).unwrap();
            config["transport_layers"] = serde_json::json!([{
                "type":"proxy","id":"proxy","name":"Proxy","enabled":true,"proxy_type":"socks5",
                "host":"127.0.0.1","port":65000,"username":"","password":"","profile_id":""
            }]);
            let initial = routes
                .post("/connection/final-proxy-port", Some("dbx_session=first"), serde_json::json!({"config":config}))
                .await;
            assert_eq!(initial.status(), StatusCode::OK);
            let port: u16 = initial.json().await.unwrap();
            start_session(&state, &routes, "first").await;
            let response =
                routes.post("/connection/final-proxy-port", cookie, serde_json::json!({"config":config})).await;
            let status = response.status();
            let reused: Value = response.json().await.unwrap();
            let closes = events(&state, "pl_debug_close");
            let still_listening = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok();
            state.app.shutdown(std::time::Duration::from_secs(1)).await;
            assert_eq!(status, StatusCode::OK, "{reused}");
            assert_eq!(reused, port);
            assert_eq!(closes, 0);
            assert!(still_listening);
        }
    }

    #[tokio::test]
    async fn final_proxy_port_owner_can_change_its_connection_after_original_debug_cleanup() {
        for disabled in [false, true] {
            let (_directory, state, routes) = fixture(disabled).await;
            configure_agent(&state, &routes).await;
            start_session(&state, &routes, "first").await;
            let mut config = serde_json::to_value(state.app.configs.read().await.get("conn").unwrap()).unwrap();
            config["transport_layers"] = serde_json::json!([{
                "type":"proxy","id":"proxy","name":"Proxy","enabled":true,"proxy_type":"socks5",
                "host":"127.0.0.1","port":65000,"username":"","password":"","profile_id":""
            }]);
            let response = routes
                .post("/connection/final-proxy-port", Some("dbx_session=first"), serde_json::json!({"config":config}))
                .await;
            let status = response.status();
            let port: Value = response.json().await.unwrap();
            let closes = events(&state, "pl_debug_close");
            let configured = state.app.configs.read().await.get("conn").unwrap().has_effective_transport_layers();
            state.app.shutdown(std::time::Duration::from_secs(1)).await;
            assert_eq!(status, StatusCode::OK, "{port}");
            assert!(port.as_u64().is_some_and(|port| port > 0));
            assert_eq!(closes, 1);
            assert!(configured);
        }
    }

    #[tokio::test]
    async fn mcp_creation_cannot_take_another_browsers_runtime_only_debug_connection() {
        let mut outcomes = Vec::new();
        for (disabled, cookie) in
            [(false, Some("dbx_session=second")), (true, Some("dbx_session=second")), (true, None)]
        {
            for path in ["/connection/mcp/add", "/connection/mcp/duplicate"] {
                let (_directory, state, routes) = fixture(disabled).await;
                configure_agent(&state, &routes).await;
                let original = state.app.configs.read().await.get("conn").unwrap().clone();
                let mut source = original.clone();
                source.id = "source".into();
                source.name = "Source fixture".into();
                state.app.storage.save_connections(&[source]).await.unwrap();
                state
                    .app
                    .storage
                    .save_mcp_global_policy(&dbx_core::storage::McpGlobalPolicy {
                        read_only: false,
                        allowed_connection_ids: None,
                        ..Default::default()
                    })
                    .await
                    .unwrap();
                start_session(&state, &routes, "first").await;
                state.sessions.write().await.insert("second".into());
                let before = serde_json::to_value(state.app.storage.load_connections().await.unwrap()).unwrap();
                let body = if path == "/connection/mcp/add" {
                    let mut replacement = original.clone();
                    replacement.host = "127.0.0.2".into();
                    serde_json::json!({"config":replacement})
                } else {
                    serde_json::json!({"sourceId":"source","copyId":"conn","copyName":"Copied debug fixture"})
                };
                let response = routes.post(path, cookie, body).await;
                let after = serde_json::to_value(state.app.storage.load_connections().await.unwrap()).unwrap();
                let unchanged_runtime = state.app.configs.read().await.get("conn") == Some(&original);
                outcomes.push((
                    path,
                    disabled,
                    cookie.is_some(),
                    response.status(),
                    before == after,
                    unchanged_runtime,
                    events(&state, "pl_debug_close"),
                ));
                state.app.shutdown(std::time::Duration::from_secs(1)).await;
            }
        }
        assert!(
            outcomes.iter().all(|(_, _, _, status, stored, runtime, closes)| *status == StatusCode::FORBIDDEN
                && *stored
                && *runtime
                && *closes == 0),
            "{outcomes:?}"
        );
    }

    #[tokio::test]
    async fn mcp_creation_preserves_own_cleanup_unrelated_targets_and_transaction_rejections() {
        let mut outcomes = Vec::new();
        for path in ["/connection/mcp/add", "/connection/mcp/duplicate"] {
            for scenario in ["own", "unrelated", "read-only"] {
                let (_directory, state, routes) = fixture(false).await;
                configure_agent(&state, &routes).await;
                let original = state.app.configs.read().await.get("conn").unwrap().clone();
                let mut source = original.clone();
                source.id = "source".into();
                source.name = "Source fixture".into();
                state.app.storage.save_connections(&[source]).await.unwrap();
                state
                    .app
                    .storage
                    .save_mcp_global_policy(&dbx_core::storage::McpGlobalPolicy {
                        read_only: scenario == "read-only",
                        allowed_connection_ids: None,
                        ..Default::default()
                    })
                    .await
                    .unwrap();
                start_session(&state, &routes, "first").await;
                state.sessions.write().await.insert("second".into());
                let target = if scenario == "unrelated" { "unrelated" } else { "conn" };
                let body = if path == "/connection/mcp/add" {
                    let mut replacement = original.clone();
                    replacement.id = target.into();
                    replacement.name = "New fixture".into();
                    replacement.host = "127.0.0.2".into();
                    serde_json::json!({"config":replacement})
                } else {
                    serde_json::json!({"sourceId":"source","copyId":target,"copyName":"Copied fixture"})
                };
                let cookie = if scenario == "unrelated" { "dbx_session=second" } else { "dbx_session=first" };
                let response = routes.post(path, Some(cookie), body).await;
                let status = response.status();
                let stored = state.app.storage.load_connections().await.unwrap();
                let runtime = state.app.configs.read().await;
                let valid = if scenario == "read-only" {
                    let error: Value = response.json().await.unwrap();
                    !status.is_success()
                        && error.to_string().contains("MCP_READ_ONLY:")
                        && stored.len() == 1
                        && runtime.get("conn") == Some(&original)
                        && events(&state, "pl_debug_close") == 0
                } else {
                    status == StatusCode::OK
                        && stored.iter().any(|config| config.id == target)
                        && runtime.contains_key(target)
                        && events(&state, "pl_debug_close") == usize::from(scenario == "own")
                        && (scenario == "own" || runtime.get("conn") == Some(&original))
                };
                drop(runtime);
                outcomes.push((path, scenario, status, valid));
                state.app.shutdown(std::time::Duration::from_secs(1)).await;
            }
        }
        assert!(outcomes.iter().all(|(_, _, _, valid)| *valid), "{outcomes:?}");
    }

    #[tokio::test]
    async fn write_unlock_mutations_only_protect_debuggers_sharing_the_actual_credential_scope() {
        let mut outcomes = Vec::new();
        for (disabled, cookie) in
            [(false, Some("dbx_session=second")), (true, Some("dbx_session=second")), (true, None)]
        {
            for path in ["/connection/write-unlock", "/connection/write-unlock/lock"] {
                let (_directory, state, routes) = fixture(disabled).await;
                configure_agent(&state, &routes).await;
                state.app.configs.write().await.get_mut("conn").unwrap().read_only = true;
                state.sessions.write().await.insert("first".into());
                let first_cookie = Some("dbx_session=first");
                let unlocked = routes
                    .post(
                        "/connection/write-unlock",
                        first_cookie,
                        serde_json::json!({"connectionId":"conn","durationSecs":60}),
                    )
                    .await;
                assert_eq!(unlocked.status(), StatusCode::OK);
                start_session(&state, &routes, "first").await;
                state.sessions.write().await.insert("second".into());
                let response =
                    routes.post(path, cookie, serde_json::json!({"connectionId":"conn","durationSecs":300})).await;
                let remaining: Value = routes
                    .post("/connection/write-unlock/state", first_cookie, serde_json::json!({"connectionId":"conn"}))
                    .await
                    .json()
                    .await
                    .unwrap();
                let closes = events(&state, "pl_debug_close");
                state.app.shutdown(std::time::Duration::from_secs(1)).await;
                outcomes.push((
                    path,
                    disabled,
                    cookie.is_some(),
                    response.status(),
                    remaining["remainingMs"].as_u64().unwrap(),
                    closes,
                ));
            }
        }
        assert!(
            outcomes.iter().all(|(_, disabled, _, status, remaining, closes)| {
                *status == if *disabled { StatusCode::FORBIDDEN } else { StatusCode::OK }
                    && *remaining > 0
                    && *remaining <= 60_000
                    && *closes == 0
            }),
            "{outcomes:?}"
        );
    }

    #[tokio::test]
    async fn write_unlock_owner_can_change_own_window_without_closing_the_debugger() {
        for disabled in [false, true] {
            let (_directory, state, routes) = fixture(disabled).await;
            configure_agent(&state, &routes).await;
            start_session(&state, &routes, "first").await;
            let cookie = Some("dbx_session=first");
            let unlocked = routes
                .post("/connection/write-unlock", cookie, serde_json::json!({"connectionId":"conn","durationSecs":300}))
                .await;
            assert_eq!(unlocked.status(), StatusCode::OK);
            let locked =
                routes.post("/connection/write-unlock/lock", cookie, serde_json::json!({"connectionId":"conn"})).await;
            let remaining: Value = routes
                .post("/connection/write-unlock/state", cookie, serde_json::json!({"connectionId":"conn"}))
                .await
                .json()
                .await
                .unwrap();
            let closes = events(&state, "pl_debug_close");
            state.app.shutdown(std::time::Duration::from_secs(1)).await;
            assert_eq!(locked.status(), StatusCode::OK);
            assert_eq!(remaining["remainingMs"], 0);
            assert_eq!(closes, 0);
        }
    }

    #[tokio::test]
    async fn configuration_save_keeps_password_disabled_browser_credentials_in_the_original_empty_scope() {
        let (_directory, state, routes) = fixture(true).await;
        configure_agent(&state, &routes).await;
        state.sessions.write().await.insert("first".into());
        let mut config = state.app.configs.read().await.get("conn").unwrap().clone();
        config.password = "first-secret".into();
        let saved = routes
            .post(
                "/connection/save",
                Some("dbx_session=first"),
                serde_json::json!({"configs":[config],"removedIds":[]}),
            )
            .await;
        let original_scope_updated = state.app.session_credentials.get("", "conn").as_deref() == Some("first-secret");
        start_session(&state, &routes, "first").await;
        let opened_with_new_credential = events(&state, "credential_first");
        state.app.shutdown(std::time::Duration::from_secs(1)).await;
        assert_eq!(saved.status(), StatusCode::OK);
        assert!(original_scope_updated, "the debug browser cookie changed the existing anonymous credential scope");
        assert_eq!(opened_with_new_credential, 1);
    }

    #[tokio::test]
    async fn configuration_save_reauthorizes_new_affected_connections_after_debug_cleanup_before_writing() {
        let (_directory, state, routes) = fixture(true).await;
        configure_agent(&state, &routes).await;
        let original = state.app.configs.read().await.get("conn").unwrap().clone().canonicalized();
        let mut other = original.clone();
        other.id = "other".into();
        other.name = "Other debug fixture".into();
        state.app.configs.write().await.insert("conn".into(), original.clone());
        state.app.configs.write().await.insert("other".into(), other.clone());
        state.app.session_credentials.set("", "other", "anonymous-secret");
        state.app.storage.save_connections(&[original.clone(), other.clone()]).await.unwrap();
        let first = start_session(&state, &routes, "first").await;
        let second = start_session_at(&state, &routes, "second", "other").await;
        let before = serde_json::to_value(state.app.storage.load_connections().await.unwrap()).unwrap();
        let driver = state.app.agent_manager.driver_dir("oracle");
        std::fs::write(driver.join("delay-close"), "ready").unwrap();
        let mut changed = original.clone();
        changed.host = "127.0.0.2".into();
        let address = routes.address;
        let save = tokio::spawn(async move {
            reqwest::Client::new()
                .post(format!("http://{address}/connection/save"))
                .header("cookie", "dbx_session=first")
                .json(&serde_json::json!({"configs":[changed,other],"removedIds":[]}))
                .send()
                .await
                .unwrap()
        });
        wait_events(&state, "pl_debug_close", 1).await;
        state.app.configs.write().await.get_mut("other").unwrap().host = "127.0.0.3".into();
        std::fs::write(driver.join("close-gate"), "ready").unwrap();
        let response = tokio::time::timeout(std::time::Duration::from_secs(10), save).await.unwrap().unwrap();
        let after = serde_json::to_value(state.app.storage.load_connections().await.unwrap()).unwrap();
        let second_status: Value = routes
            .post("/pl-debug/status", Some("dbx_session=second"), serde_json::json!({"reference":second}))
            .await
            .json()
            .await
            .unwrap();
        let first_status: Value = routes
            .post("/pl-debug/status", Some("dbx_session=first"), serde_json::json!({"reference":first}))
            .await
            .json()
            .await
            .unwrap();
        let closes = events(&state, "pl_debug_close");
        state.app.shutdown(std::time::Duration::from_secs(1)).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(before, after);
        assert_eq!(second_status["state"], "paused");
        assert_eq!(first_status["state"], "ended");
        assert_eq!(closes, 1);
    }

    #[tokio::test]
    async fn configuration_load_rereads_persisted_connections_after_cleanup_without_rolling_back_another_save() {
        let (_directory, state, routes) = fixture(true).await;
        configure_agent(&state, &routes).await;
        let original = state.app.configs.read().await.get("conn").unwrap().clone().canonicalized();
        state.app.configs.write().await.insert("conn".into(), original.clone());
        let mut persisted = original.clone();
        persisted.host = "127.0.0.2".into();
        state.app.storage.save_connections(&[persisted]).await.unwrap();
        start_session(&state, &routes, "first").await;
        state.sessions.write().await.insert("second".into());
        let driver = state.app.agent_manager.driver_dir("oracle");
        std::fs::write(driver.join("delay-close"), "ready").unwrap();
        let address = routes.address;
        let load = tokio::spawn(async move {
            reqwest::Client::new()
                .get(format!("http://{address}/connection/list"))
                .header("cookie", "dbx_session=first")
                .send()
                .await
                .unwrap()
        });
        wait_events(&state, "pl_debug_close", 1).await;
        let mut other = original.clone();
        other.id = "other".into();
        let saved = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            routes.post(
                "/connection/save",
                Some("dbx_session=second"),
                serde_json::json!({"configs":[other],"removedIds":[]}),
            ),
        )
        .await;
        std::fs::write(driver.join("close-gate"), "ready").unwrap();
        let loaded = tokio::time::timeout(std::time::Duration::from_secs(10), load).await.unwrap().unwrap();
        let status = loaded.status();
        let configs: Value = loaded.json().await.unwrap();
        let retained = state.app.configs.read().await.contains_key("other");
        state.app.shutdown(std::time::Duration::from_secs(1)).await;
        assert_eq!(saved.unwrap().status(), StatusCode::OK, "saving an unrelated delta waited on another debugger");
        assert_eq!(status, StatusCode::OK);
        assert!(retained);
        assert!(configs.as_array().unwrap().iter().any(|config| config["id"] == "other"));
    }

    #[tokio::test]
    async fn configuration_load_and_save_with_no_effect_on_a_debugger_do_not_require_its_owner() {
        let (_directory, state, routes) = fixture(true).await;
        configure_agent(&state, &routes).await;
        let original = state.app.configs.read().await.get("conn").unwrap().clone().canonicalized();
        state.app.configs.write().await.insert("conn".into(), original.clone());
        state.app.storage.save_connections(std::slice::from_ref(&original)).await.unwrap();
        let reference = start_session(&state, &routes, "first").await;
        state.sessions.write().await.insert("second".into());
        let saved = routes
            .post(
                "/connection/save",
                Some("dbx_session=second"),
                serde_json::json!({"configs":[original],"removedIds":[]}),
            )
            .await;
        let loaded =
            reqwest::Client::new().get(format!("http://{}/connection/list", routes.address)).send().await.unwrap();
        let status: Value = routes
            .post("/pl-debug/status", Some("dbx_session=first"), serde_json::json!({"reference":reference}))
            .await
            .json()
            .await
            .unwrap();
        let closes = events(&state, "pl_debug_close");
        state.app.shutdown(std::time::Duration::from_secs(1)).await;
        assert_eq!(saved.status(), StatusCode::OK);
        assert_eq!(loaded.status(), StatusCode::OK);
        assert_eq!(status["state"], "paused");
        assert_eq!(closes, 0);
    }

    #[tokio::test]
    async fn ordinary_configuration_changes_cannot_replace_another_browsers_debug_connection() {
        let mut outcomes = Vec::new();
        for (disabled, cookie) in
            [(false, Some("dbx_session=second")), (true, Some("dbx_session=second")), (true, None)]
        {
            for path in ["/connection/connect", "/connection/save", "/connection/list", "/connection/mcp/remove"] {
                let (_directory, state, routes) = fixture(disabled).await;
                configure_agent(&state, &routes).await;
                let original = state.app.configs.read().await.get("conn").unwrap().clone();
                let mut changed = original.clone();
                changed.host = "127.0.0.2".into();
                let stored = if path == "/connection/list" { changed.clone() } else { original.clone() };
                state.app.storage.save_connections(&[stored]).await.unwrap();
                start_session(&state, &routes, "first").await;
                state.sessions.write().await.insert("second".into());
                let before = serde_json::to_value(state.app.storage.load_connections().await.unwrap()).unwrap();
                let response = if path == "/connection/list" {
                    let mut request = reqwest::Client::new().get(format!("http://{}{path}", routes.address));
                    if let Some(cookie) = cookie {
                        request = request.header("cookie", cookie);
                    }
                    request.send().await.unwrap()
                } else {
                    let body = match path {
                        "/connection/connect" => serde_json::json!({"config":changed,"clientAttempt":42}),
                        "/connection/save" => {
                            let mut added = original.clone();
                            added.id = "unrelated".into();
                            serde_json::json!({"configs":[added,changed],"removedIds":[]})
                        }
                        _ => serde_json::json!({"connectionId":"conn"}),
                    };
                    routes.post(path, cookie, body).await
                };
                let after = serde_json::to_value(state.app.storage.load_connections().await.unwrap()).unwrap();
                let unchanged_runtime = state.app.configs.read().await.get("conn").is_some_and(|config| {
                    serde_json::to_value(config).unwrap() == serde_json::to_value(&original).unwrap()
                });
                outcomes.push((
                    path,
                    disabled,
                    cookie.is_some(),
                    response.status(),
                    before == after,
                    unchanged_runtime,
                    events(&state, "pl_debug_close"),
                ));
                state.app.shutdown(std::time::Duration::from_secs(1)).await;
            }
        }
        for (path, disabled, cookie, status, storage_unchanged, runtime_unchanged, closes) in outcomes {
            assert_eq!(status, StatusCode::FORBIDDEN, "{path} disabled={disabled} cookie={cookie}; storage unchanged={storage_unchanged}; runtime unchanged={runtime_unchanged}; close={closes}");
            assert!(storage_unchanged && runtime_unchanged);
            assert_eq!(closes, 0);
        }
    }

    #[tokio::test]
    async fn ordinary_disconnect_cannot_close_another_browser_debugger() {
        let mut outcomes = Vec::new();
        for (disabled, cookie) in
            [(false, Some("dbx_session=second")), (true, Some("dbx_session=second")), (true, None)]
        {
            let (_directory, state, routes) = fixture(disabled).await;
            configure_agent(&state, &routes).await;
            let reference = start_session(&state, &routes, "first").await;
            state.sessions.write().await.insert("second".into());
            let response =
                routes.post("/connection/disconnect", cookie, serde_json::json!({"connectionId":"conn"})).await;
            let status: Value = routes
                .post("/pl-debug/status", Some("dbx_session=first"), serde_json::json!({"reference":reference}))
                .await
                .json()
                .await
                .unwrap();
            outcomes.push((
                disabled,
                cookie.is_some(),
                response.status(),
                events(&state, "pl_debug_close"),
                status["state"].clone(),
            ));
            if disabled {
                assert_eq!(
                    routes
                        .post("/connection/disconnect", None, serde_json::json!({"connectionId":"unrelated"}))
                        .await
                        .status(),
                    StatusCode::OK,
                );
            }
            let own = routes
                .post("/connection/disconnect", Some("dbx_session=first"), serde_json::json!({"connectionId":"conn"}))
                .await;
            state.app.shutdown(std::time::Duration::from_secs(1)).await;
            assert_eq!(own.status(), StatusCode::OK);
            assert_eq!(events(&state, "pl_debug_close"), 1);
        }
        for (disabled, cookie, status, closes, debug_state) in outcomes {
            assert_eq!(
                status,
                StatusCode::FORBIDDEN,
                "disconnect disabled={disabled} cookie={cookie}; close events={closes}; debugger={debug_state}"
            );
            assert_eq!(closes, 0);
            assert_eq!(debug_state, "paused");
        }
    }

    #[tokio::test]
    async fn ordinary_runtime_operations_cannot_stop_another_browser_debugger() {
        let mut outcomes = Vec::new();
        for (path, body) in [
            ("/agents/runtime/stop", serde_json::json!({"runtimeId":"agent-runtime:oracle:0"})),
            ("/agents/runtime/restart", serde_json::json!({"runtimeId":"agent-runtime:oracle:0"})),
            ("/agents/java-runtime", serde_json::json!({"config":{"mode":"managed"}})),
        ] {
            let (_directory, state, routes) = fixture(true).await;
            configure_agent(&state, &routes).await;
            start_session(&state, &routes, "first").await;
            state.sessions.write().await.insert("second".into());
            let before = state.app.agent_manager.connection_runtimes.lock().await.len();
            assert_eq!(before, 1);
            let response = routes.post(path, Some("dbx_session=second"), body.clone()).await;
            outcomes.push((
                path,
                response.status(),
                state.app.agent_manager.connection_runtimes.lock().await.len(),
                events(&state, "pl_debug_close"),
            ));
            assert_eq!(routes.post(path, None, body.clone()).await.status(), StatusCode::FORBIDDEN);
            assert_eq!(state.app.agent_manager.connection_runtimes.lock().await.len(), 1);
            assert_eq!(
                routes
                    .post(
                        "/agents/runtime/stop",
                        Some("dbx_session=second"),
                        serde_json::json!({"runtimeId":"agent-runtime:oceanbase-oracle:0"})
                    )
                    .await
                    .status(),
                StatusCode::OK,
            );
            assert_eq!(state.app.agent_manager.connection_runtimes.lock().await.len(), 1);
            let own = routes.post(path, Some("dbx_session=first"), body).await;
            state.app.shutdown(std::time::Duration::from_secs(1)).await;
            assert_eq!(own.status(), StatusCode::OK);
            assert_eq!(events(&state, "pl_debug_close"), 1);
        }
        for (path, status, runtimes, closes) in outcomes {
            assert_eq!(status, StatusCode::FORBIDDEN, "{path} retained runtimes={runtimes}; close events={closes}");
            assert_eq!(runtimes, 1);
            assert_eq!(closes, 0);
        }
    }

    #[tokio::test]
    async fn browser_ownership_refresh_and_logout_use_the_original_core_session() {
        for disabled in [true, false] {
            let (_directory, state, routes) = fixture(disabled).await;
            configure_agent(&state, &routes).await;
            let reference = start_session(&state, &routes, "first").await;
            let other = start_session(&state, &routes, "second").await;
            assert_eq!(events(&state, "credential_wrong"), 0);
            assert_eq!(events(&state, "credential_default"), if disabled { 2 } else { 0 });
            assert_eq!(events(&state, "credential_first"), if disabled { 0 } else { 1 });
            assert_eq!(events(&state, "credential_second"), if disabled { 0 } else { 1 });
            let bootstrap: Value = routes
                .post("/pl-debug/bootstrap", Some("dbx_session=first"), serde_json::json!({}))
                .await
                .json()
                .await
                .unwrap();
            let list: Value = routes
                .post(
                    "/pl-debug/list",
                    Some("dbx_session=first"),
                    serde_json::json!({
                        "serverEpoch":bootstrap["serverEpoch"],"connectionId":"conn"
                    }),
                )
                .await
                .json()
                .await
                .unwrap();
            assert_eq!(list.as_array().unwrap().len(), 1);
            assert_eq!(list[0]["sessionId"], reference["sessionId"]);
            assert_eq!(list[0]["clientSessionId"], reference["clientSessionId"]);
            assert_eq!(list[0]["startOperationId"], "start-first");
            assert_eq!(list[0]["recovery"]["version"], 1);
            assert_eq!(list[0]["recovery"]["operations"], serde_json::json!([]));
            // Discovery restores the original client identity; it does not authorize
            // a new client to control that session using only its public session ID.
            let mut wrong_client = reference.clone();
            wrong_client["clientSessionId"] = serde_json::json!("replacement-editor");
            let denied = routes
                .post("/pl-debug/status", Some("dbx_session=first"), serde_json::json!({"reference":wrong_client}))
                .await;
            assert!(!denied.status().is_success(), "same-owner replacement client was accepted");
            let recovered: Value = routes
                .post("/pl-debug/status", Some("dbx_session=first"), serde_json::json!({"reference":reference}))
                .await
                .json()
                .await
                .unwrap();
            assert_eq!(recovered["sessionId"], reference["sessionId"]);
            assert_eq!(recovered["state"], "paused");
            assert_eq!(events(&state, "pl_debug_start"), 2);
            for (path, body) in [
                ("status", serde_json::json!({"reference":reference,"refresh":true})),
                ("heartbeat", reference.clone()),
                ("operation", serde_json::json!({"reference":reference,"operationId":"start-first"})),
                (
                    "read",
                    serde_json::json!({"serverEpoch":reference["serverEpoch"],"sessionId":reference["sessionId"],
                    "connectionId":"conn","clientSessionId":"editor","generation":1,"stopRevision":1,"kind":"log"}),
                ),
                (
                    "operate",
                    serde_json::json!({"serverEpoch":reference["serverEpoch"],"sessionId":reference["sessionId"],
                    "connectionId":"conn","clientSessionId":"editor","generation":1,"expectedRevision":2,"operationId":"steal-close","action":"close"}),
                ),
            ] {
                let response = routes.post(&format!("/pl-debug/{path}"), Some("dbx_session=second"), body).await;
                assert!(!response.status().is_success(), "cross-owner {path} was accepted");
            }
            assert_eq!(events(&state, "pl_debug_close"), 0);
            assert_eq!(
                routes.post("/auth/logout", Some("dbx_session=first"), serde_json::json!({})).await.status(),
                StatusCode::OK
            );
            wait_events(&state, "shutdown", 1).await;
            assert_eq!(events(&state, "pl_debug_close"), 1);
            let denied = routes.post("/pl-debug/heartbeat", Some("dbx_session=first"), reference).await;
            assert!(!denied.status().is_success());
            let status: Value = routes
                .post("/pl-debug/status", Some("dbx_session=second"), serde_json::json!({"reference":other}))
                .await
                .json()
                .await
                .unwrap();
            assert_eq!(status["state"], "paused");
            routes.post("/auth/logout", Some("dbx_session=second"), serde_json::json!({})).await;
            wait_events(&state, "shutdown", 2).await;
        }
    }

    #[tokio::test]
    async fn password_rotation_cleans_revoked_debuggers_but_keeps_the_current_owner() {
        use argon2::password_hash::{rand_core::OsRng, SaltString};
        use argon2::{Argon2, PasswordHasher};
        let (_directory, state, routes) = fixture(false).await;
        configure_agent(&state, &routes).await;
        *state.password_hash.write().await =
            Some(Argon2::default().hash_password(b"old", &SaltString::generate(&mut OsRng)).unwrap().to_string());
        let reference = start_session(&state, &routes, "first").await;
        start_session(&state, &routes, "second").await;
        let changed = routes
            .post(
                "/auth/change-password",
                Some("dbx_session=first"),
                serde_json::json!({"old_password":"old","new_password":"new"}),
            )
            .await;
        assert_eq!(changed.status(), StatusCode::OK);
        wait_events(&state, "shutdown", 1).await;
        assert_eq!(events(&state, "pl_debug_close"), 1);
        assert!(state.sessions.read().await.contains("first"));
        assert!(!state.sessions.read().await.contains("second"));
        let status: Value = routes
            .post("/pl-debug/status", Some("dbx_session=first"), serde_json::json!({"reference":reference}))
            .await
            .json()
            .await
            .unwrap();
        assert_eq!(status["state"], "paused");
        routes.post("/auth/logout", Some("dbx_session=first"), serde_json::json!({})).await;
        wait_events(&state, "shutdown", 2).await;
    }

    fn registered_inspection_body() -> Value {
        json!({
            "connectionId":"conn","database":"APP","clientSessionId":"typed-preview",
            "target":{"schema":"APP","objectType":"PROCEDURE","objectName":"P","metadataPreparation":"type_only"}
        })
    }

    async fn compilation_body(routes: &TestServer, owner: &str) -> Value {
        let cookie = format!("dbx_session={owner}");
        let bootstrap: Value = routes.post("/pl-debug/bootstrap", Some(&cookie), json!({})).await.json().await.unwrap();
        let mut inspection = registered_inspection_body();
        inspection["target"]["metadataPreparation"] = json!("debug_compile");
        let response = routes.post("/pl-debug/inspect", Some(&cookie), inspection.clone()).await;
        assert_eq!(response.status(), StatusCode::OK);
        let preview: Value = response.json().await.unwrap();
        json!({"serverEpoch":bootstrap["serverEpoch"],"operationId":"compile-original","connectionId":"conn",
            "database":"APP","clientSessionId":"compile-client","target":inspection["target"],
            "preview":preview["compilePreview"],"expectedConnectionRevision":preview["connectionRevision"],
            "confirmed":true,"productionConfirmed":false})
    }

    fn compile_reference(body: &Value) -> Value {
        json!({"serverEpoch":body["serverEpoch"],"operationId":body["operationId"],
            "connectionId":body["connectionId"],"clientSessionId":body["clientSessionId"]})
    }

    #[tokio::test]
    async fn compilation_http_preserves_cookie_credentials_original_receipt_and_client_ownership() {
        for disabled in [true, false] {
            let (_directory, state, routes) = fixture(disabled).await;
            configure_agent(&state, &routes).await;
            state.sessions.write().await.extend(["first".into(), "second".into()]);
            let body = compilation_body(&routes, "first").await;
            let accepted = routes.post("/pl-debug/compile", Some("dbx_session=first"), body.clone()).await;
            assert_eq!(accepted.status(), StatusCode::OK);
            let reference = compile_reference(&body);
            let result = tokio::time::timeout(std::time::Duration::from_secs(10), async {
                loop {
                    let response =
                        routes.post("/pl-debug/compile-status", Some("dbx_session=first"), reference.clone()).await;
                    assert_eq!(response.status(), StatusCode::OK);
                    let value: Value = response.json().await.unwrap();
                    if value["finished"] == true {
                        break value;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            assert_eq!(result["ddlState"], "executed");
            assert_eq!(result["releaseState"], "released");
            assert_eq!(result["result"]["readback"]["status"], "INVALID");
            let duplicate: Value =
                routes.post("/pl-debug/compile", Some("dbx_session=first"), body.clone()).await.json().await.unwrap();
            assert_eq!(duplicate, result);
            let denied = routes.post("/pl-debug/compile-status", Some("dbx_session=second"), reference.clone()).await;
            assert!(!denied.status().is_success());
            let mut wrong_client = reference.clone();
            wrong_client["clientSessionId"] = json!("another-client");
            assert!(!routes
                .post("/pl-debug/compile-status", Some("dbx_session=first"), wrong_client)
                .await
                .status()
                .is_success());
            assert_eq!(
                routes.post("/pl-debug/compile", Some("dbx_session=untrusted"), body.clone()).await.status(),
                if disabled { StatusCode::FORBIDDEN } else { StatusCode::UNAUTHORIZED }
            );
            let mut changed = body;
            changed["preview"]["sql"] = json!("different SQL");
            assert!(!routes.post("/pl-debug/compile", Some("dbx_session=first"), changed).await.status().is_success());
            assert_eq!(events(&state, "pl_debug_compile"), 1);
            assert_eq!(events(&state, "open_session"), 2);
            assert_eq!(events(&state, "credential_wrong"), 0);
            assert_eq!(events(&state, "credential_default"), if disabled { 2 } else { 0 });
            assert_eq!(events(&state, "credential_first"), if disabled { 0 } else { 2 });
        }
    }

    #[tokio::test]
    async fn compilation_http_rechecks_logout_after_async_preparation_before_registration() {
        for disabled in [true, false] {
            let (_directory, state, routes) = fixture(disabled).await;
            configure_agent(&state, &routes).await;
            state.sessions.write().await.insert("first".into());
            let body = compilation_body(&routes, "first").await;
            let mut headers = HeaderMap::new();
            headers.insert("cookie", "dbx_session=first".parse().unwrap());
            let owner = access(&state, &headers).await.unwrap();
            let admission =
                pl_debug::pl_debug_prepare_compile_core(&state.app, &owner, serde_json::from_value(body).unwrap())
                    .await
                    .unwrap();
            assert_eq!(
                routes.post("/auth/logout", Some("dbx_session=first"), json!({})).await.status(),
                StatusCode::OK
            );
            let denied = submit_prepared_compilation(&state, &headers, admission).await.unwrap_err();
            assert_eq!(denied.into_response().status(), StatusCode::FORBIDDEN);
            assert_eq!(events(&state, "pl_debug_compile"), 0);
            assert_eq!(events(&state, "open_session"), 1);
        }
    }

    #[tokio::test]
    async fn compilation_http_readonly_rejection_is_authoritative_not_started() {
        let (_directory, state, routes) = fixture(true).await;
        configure_agent(&state, &routes).await;
        state.sessions.write().await.insert("first".into());
        let body = compilation_body(&routes, "first").await;
        state.app.configs.write().await.get_mut("conn").unwrap().read_only = true;
        let response = routes.post("/pl-debug/compile", Some("dbx_session=first"), body).await;
        assert!(!response.status().is_success());
        let error: Value = response.json().await.unwrap();
        assert_eq!(error["operationOutcome"], "not_started");
        assert_eq!(events(&state, "pl_debug_compile"), 0);
        assert_eq!(events(&state, "open_session"), 1);
    }

    #[tokio::test]
    async fn registered_inspection_http_uses_the_existing_cookie_and_credential_scopes() {
        for disabled in [true, false] {
            let (_directory, state, routes) = fixture(disabled).await;
            configure_agent(&state, &routes).await;
            state.sessions.write().await.insert("first".into());
            let bootstrap: Value =
                routes.post("/pl-debug/bootstrap", Some("dbx_session=first"), json!({})).await.json().await.unwrap();
            let response =
                routes.post("/pl-debug/inspect", Some("dbx_session=first"), registered_inspection_body()).await;
            assert_eq!(response.status(), StatusCode::OK);
            let result: Value = response.json().await.unwrap();
            assert_eq!(result["targetPreview"]["state"], "available");
            assert!(result["connectionRevision"].is_string());
            assert_eq!(events(&state, "credential_wrong"), 0);
            assert_eq!(events(&state, "credential_default"), usize::from(disabled));
            assert_eq!(events(&state, "credential_first"), usize::from(!disabled));
            assert_eq!(events(&state, "open_session"), 1);
            assert_eq!(events(&state, "pl_debug_inspect"), 1);
            assert_eq!(events(&state, "close_session"), 1);
            assert_eq!(events(&state, "shutdown"), 1);
            assert_eq!(events(&state, "pl_debug_start"), 0);
            assert!(state.app.agent_manager.connection_runtimes.lock().await.is_empty());
            let list: Value = routes
                .post(
                    "/pl-debug/list",
                    Some("dbx_session=first"),
                    json!({"serverEpoch":bootstrap["serverEpoch"],"connectionId":"conn"}),
                )
                .await
                .json()
                .await
                .unwrap();
            assert_eq!(list, json!([]));
            let denied =
                routes.post("/pl-debug/inspect", Some("dbx_session=untrusted"), registered_inspection_body()).await;
            assert!(!denied.status().is_success());
            assert_eq!(events(&state, "pl_debug_inspect"), 1);
        }
    }

    #[tokio::test]
    async fn registered_inspection_logout_revokes_inflight_preview_without_closing_another_owner() {
        for disabled in [true, false] {
            let (_directory, state, routes) = fixture(disabled).await;
            configure_agent(&state, &routes).await;
            let second = start_session(&state, &routes, "second").await;
            state.sessions.write().await.insert("first".into());
            let driver = state.app.agent_manager.driver_dir("oracle");
            std::fs::write(driver.join("delay-inspect"), b"1").unwrap();
            let address = routes.address;
            let pending = tokio::spawn(async move {
                reqwest::Client::new()
                    .post(format!("http://{address}/pl-debug/inspect"))
                    .header("cookie", "dbx_session=first")
                    .json(&registered_inspection_body())
                    .send()
                    .await
                    .unwrap()
            });
            wait_events(&state, "pl_debug_inspect", 1).await;
            assert_eq!(
                routes.post("/auth/logout", Some("dbx_session=first"), json!({})).await.status(),
                StatusCode::OK
            );
            assert!(!pending.is_finished());
            let other = routes.post("/pl-debug/status", Some("dbx_session=second"), json!({"reference":second})).await;
            assert_eq!(other.status(), StatusCode::OK);
            assert_eq!(other.json::<Value>().await.unwrap()["state"], "paused");
            assert_eq!(events(&state, "pl_debug_close"), 0);
            std::fs::write(driver.join("inspect-gate"), b"1").unwrap();
            assert_eq!(pending.await.unwrap().status(), StatusCode::FORBIDDEN);
            wait_events(&state, "shutdown", 1).await;
            assert_eq!(events(&state, "close_session"), 1);
            assert_eq!(events(&state, "pl_debug_inspect"), 1);
            assert_eq!(events(&state, "pl_debug_start"), 1);
            routes.post("/auth/logout", Some("dbx_session=second"), json!({})).await;
            wait_events(&state, "shutdown", 2).await;
        }
    }
}
