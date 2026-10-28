use super::*;
use crate::pl_debug_channel::PlDebugAgentChannel;

const TEST_TIMEOUT: Duration = Duration::from_secs(3);

struct Fixture {
    directory: tempfile::TempDir,
    runtime: Arc<AgentRuntimeClient>,
    channel: PlDebugAgentChannel,
}

fn debug_agent_launch(mode: &str) -> (tempfile::TempDir, AgentLaunchSpec) {
    let directory = tempfile::tempdir().unwrap();
    let script = directory.path().join("debug-agent.py");
    std::fs::write(
        &script,
        r#"import json, os, pathlib, sys, time
root = pathlib.Path(sys.argv[1]); mode = sys.argv[2]
pending = []; methods = []; cancel_count = 0; opens = 0
def reply(req, result):
    print(json.dumps({'jsonrpc':'2.0', 'id':req['id'], 'result':result}), flush=True)
print(json.dumps({'ready':True}), flush=True)
handshake = json.loads(sys.stdin.readline())
contract = {'protocolVersion':2,'agentProtocolVersion':2,'capabilities':['multi_session','structured_error_v1']}
if mode == 'native': contract['plDebug'] = {'contractVersion':1,'helperObjects':False}
if mode == 'helper': contract['plDebug'] = {'contractVersion':1,'helperObjects':True}
if mode == 'future': contract['plDebug'] = {'contractVersion':2,'helperObjects':False}
reply(handshake, contract)
if mode == 'blocked':
    while not (root/'read-gate').exists(): time.sleep(0.01)
for line in sys.stdin:
    req = json.loads(line); method = req['method']; params = req.get('params', {})
    methods.append(params.get('operationId', method))
    if method == 'pl_debug_resume' or method == 'pl_debug_hold':
        pending.append(req); (root/'started').write_text(str(len(pending)))
    elif method == 'open_session':
        opens += 1
        if mode != 'open_pending': reply(req, {'ok':True})
    elif method == 'pl_debug_abort':
        reply(req, {'aborted':True})
        for original in pending: reply(original, {'cancelled':True})
        pending = []
    elif method == 'cancel_session':
        cancel_count += 1; reply(req, {'ok':True})
        for original in pending: reply(original, {'genericCancelled':True})
        pending = []
    elif method == 'pl_debug_get_stack':
        print(json.dumps({'jsonrpc':'2.0','id':req['id'],'error':{'code':-1,'message':'stack resource error',
          'data':{'contractVersion':1,'category':'resource','retryable':False,'sessionDisposition':'keep',
          'stage':'execute','operationOutcome':'unknown','agentSessionId':params['agentSessionId'],
          'sqlState':'HY001','vendorCode':600}}}), flush=True)
    elif method == 'shutdown':
        reply(req, {'ok':True})
        if mode == 'shutdown_delay': time.sleep(3)
        break
    else:
        reply(req, {'running':bool(pending),'pending':len(pending),'genericCancels':cancel_count,
          'opens':opens,'agentSessionId':params.get('agentSessionId'),'methods':methods,'pid':os.getpid()})
"#,
    )
    .unwrap();
    let python = if cfg!(windows) { "python" } else { "python3" };
    let launch = AgentLaunchSpec::new(python).with_args([
        script.to_string_lossy().to_string(),
        directory.path().to_string_lossy().to_string(),
        mode.to_string(),
    ]);
    (directory, launch)
}

impl Fixture {
    async fn spawn(mode: &str) -> Self {
        let (directory, launch) = debug_agent_launch(mode);
        let runtime = AgentRuntimeClient::spawn(launch, "test").await.unwrap();
        Self::assemble(directory, runtime)
    }

    /// The plain `AgentRuntimeClient::spawn` path leaves `startup_exit` unset,
    /// so exit confirmation only exists on the startup-observed production
    /// path; exit-confirmation tests must spawn through it.
    async fn spawn_observed(mode: &str) -> Self {
        let (directory, launch) = debug_agent_launch(mode);
        let (startup, _cleanup) = crate::startup_cleanup::StartupCleanup::new_pair();
        let runtime =
            AgentRuntimeClient::spawn_before_observed(launch, "test", Instant::now() + TEST_TIMEOUT, &startup)
                .await
                .unwrap();
        Self::assemble(directory, runtime)
    }

    fn assemble(directory: tempfile::TempDir, runtime: Arc<AgentRuntimeClient>) -> Self {
        runtime.increment_session_count();
        let channel = PlDebugAgentChannel::from_reserved(
            runtime.clone(),
            "fixed-debug-session".into(),
            uuid::Uuid::new_v4(),
            "fixture-runtime".into(),
        );
        Self { directory, runtime, channel }
    }

    async fn status(&self) -> Value {
        self.channel.call("pl_debug_status", serde_json::json!({}), TEST_TIMEOUT, None).await.unwrap()
    }

    async fn wait_for_started(&self, count: usize) {
        let marker = self.directory.path().join("started");
        let expected = count.to_string();
        tokio::time::timeout(TEST_TIMEOUT, async {
            while std::fs::read_to_string(&marker).ok().as_deref() != Some(expected.as_str()) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the actual child must receive the request");
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.runtime.kill();
    }
}

#[tokio::test]
async fn pl_debug_native_contract_is_opt_in_and_checked_before_opening_a_session() {
    for (mode, supported) in [("normal", false), ("helper", false), ("future", false), ("native", true)] {
        let fixture = Fixture::spawn(mode).await;
        assert_eq!(fixture.channel.supports_native_pl_debug(), supported, "{mode}");
        assert_eq!(fixture.status().await["opens"], 0, "handshake inspection must not open a database connection");
    }
}

#[tokio::test]
async fn pl_debug_inspection_close_keeps_the_fixed_session_and_method_whitelist() {
    let fixture = Fixture::spawn("normal").await;
    let rejected = fixture.channel.call::<Value>("close_session", serde_json::json!({}), TEST_TIMEOUT, None).await;
    assert!(rejected.is_err(), "generic debug calls must not gain session-management access");
    let closed = fixture.channel.close_session(TEST_TIMEOUT).await.unwrap();
    assert_eq!(closed["agentSessionId"], "fixed-debug-session");
    assert_eq!(closed["opens"], 0);
    assert_eq!(closed["methods"], serde_json::json!(["close_session"]));
}

#[tokio::test]
async fn pl_debug_status_and_abort_bypass_a_pending_continue_and_keep_the_fixed_session() {
    let fixture = Fixture::spawn("normal").await;
    let channel = fixture.channel.clone();
    let running = tokio::spawn(async move {
        channel.call::<Value>("pl_debug_resume", serde_json::json!({}), TEST_TIMEOUT, None).await
    });
    fixture.wait_for_started(1).await;
    let status: Value = fixture
        .channel
        .call("pl_debug_status", serde_json::json!({"agentSessionId":"forged"}), TEST_TIMEOUT, None)
        .await
        .unwrap();
    assert_eq!(status["running"], true);
    assert_eq!(status["agentSessionId"], "fixed-debug-session");
    assert!(!running.is_finished());
    let aborted: Value =
        fixture.channel.call("pl_debug_abort", serde_json::json!({}), TEST_TIMEOUT, None).await.unwrap();
    assert_eq!(aborted["aborted"], true);
    assert_eq!(running.await.unwrap().unwrap()["cancelled"], true);
    assert_eq!(fixture.status().await["genericCancels"], 0);
}

#[tokio::test]
async fn pl_debug_timeout_and_cancel_only_end_waiting_without_generic_cancel_or_replay() {
    for cancel in [false, true] {
        let fixture = Fixture::spawn("normal").await;
        let token = CancellationToken::new();
        let waiting_token = token.clone();
        let channel = fixture.channel.clone();
        let running = tokio::spawn(async move {
            channel
                .call::<Value>(
                    "pl_debug_resume",
                    serde_json::json!({}),
                    if cancel { TEST_TIMEOUT } else { Duration::from_millis(250) },
                    Some(waiting_token),
                )
                .await
        });
        fixture.wait_for_started(1).await;
        if cancel {
            token.cancel();
        }
        let error = running.await.unwrap().unwrap_err();
        if cancel {
            assert!(matches!(error, AgentCallError::Canceled { .. }));
        } else {
            assert!(matches!(error, AgentCallError::Timeout { .. }));
        }
        assert_eq!(error.operation_outcome(), AgentOperationOutcome::Unknown);
        assert_eq!(fixture.runtime.pending.lock().unwrap().len(), 0);
        let status = fixture.status().await;
        assert_eq!(status["running"], true);
        assert_eq!(status["pending"], 1);
        assert_eq!(status["genericCancels"], 0);
        let _: Value = fixture.channel.call("pl_debug_abort", serde_json::json!({}), TEST_TIMEOUT, None).await.unwrap();
        assert!(!fixture.runtime.is_failed());
    }
}

#[tokio::test]
async fn pl_debug_dropped_wait_removes_pending_but_keeps_the_original_target() {
    let fixture = Fixture::spawn("normal").await;
    let channel = fixture.channel.clone();
    let running = tokio::spawn(async move {
        channel.call::<Value>("pl_debug_resume", serde_json::json!({}), TEST_TIMEOUT, None).await
    });
    fixture.wait_for_started(1).await;
    running.abort();
    assert!(running.await.unwrap_err().is_cancelled());
    assert_eq!(fixture.runtime.pending.lock().unwrap().len(), 0);
    let status = fixture.status().await;
    assert_eq!(status["pending"], 1);
    assert_eq!(status["genericCancels"], 0);
    let _: Value = fixture.channel.call("pl_debug_abort", serde_json::json!({}), TEST_TIMEOUT, None).await.unwrap();
}

#[tokio::test]
async fn pl_debug_pre_cancelled_wait_and_non_debug_methods_never_dispatch() {
    let fixture = Fixture::spawn("normal").await;
    let token = CancellationToken::new();
    token.cancel();
    let error = fixture
        .channel
        .call::<Value>("pl_debug_resume", serde_json::json!({}), TEST_TIMEOUT, Some(token))
        .await
        .unwrap_err();
    assert!(matches!(error, AgentCallError::Canceled { operation_outcome: AgentOperationOutcome::NotStarted, .. }));
    assert!(fixture.channel.call::<Value>("execute_query", serde_json::json!({}), TEST_TIMEOUT, None).await.is_err());
    let status = fixture.status().await;
    assert_eq!(status["methods"], serde_json::json!(["pl_debug_status"]));
}

#[tokio::test]
async fn pl_debug_in_flight_bound_refuses_new_work_without_affecting_runtime_reads() {
    let fixture = Fixture::spawn("normal").await;
    let mut waiting = Vec::new();
    for _ in 0..PL_DEBUG_MAX_IN_FLIGHT {
        let channel = fixture.channel.clone();
        waiting.push(tokio::spawn(async move {
            channel.call::<Value>("pl_debug_hold", serde_json::json!({}), Duration::from_secs(30), None).await
        }));
    }
    fixture.wait_for_started(PL_DEBUG_MAX_IN_FLIGHT).await;
    let error =
        fixture.channel.call::<Value>("pl_debug_resume", serde_json::json!({}), TEST_TIMEOUT, None).await.unwrap_err();
    assert_eq!(error.category(), Some(AgentErrorCategory::Resource));
    assert_eq!(error.operation_outcome(), AgentOperationOutcome::NotStarted);
    let status: Value = fixture.runtime.call("counts", serde_json::json!({}), Some(TEST_TIMEOUT), None).await.unwrap();
    assert_eq!(status["pending"], PL_DEBUG_MAX_IN_FLIGHT);
    assert_eq!(status["genericCancels"], 0);
    for task in waiting {
        task.abort();
        let _ = task.await;
    }
    assert_eq!(fixture.runtime.pending.lock().unwrap().len(), 0);
}

#[tokio::test]
async fn pl_debug_blocked_pipe_has_one_deadline_and_an_independent_kill_handle() {
    let fixture = Fixture::spawn("blocked").await;
    let began = Instant::now();
    let error = fixture
        .channel
        .call::<Value>(
            "pl_debug_resume",
            serde_json::json!({"payload":" ".repeat(2 * 1024 * 1024)}),
            Duration::from_millis(150),
            None,
        )
        .await
        .unwrap_err();
    assert!(matches!(error, AgentCallError::Timeout { operation_outcome: AgentOperationOutcome::Unknown, .. }));
    assert!(began.elapsed() < Duration::from_secs(2));
    let error = fixture
        .channel
        .call::<Value>("pl_debug_status", serde_json::json!({}), Duration::from_millis(100), None)
        .await
        .unwrap_err();
    assert!(matches!(error, AgentCallError::Timeout { operation_outcome: AgentOperationOutcome::NotStarted, .. }));
    assert_eq!(fixture.runtime.pending.lock().unwrap().len(), 0);
    assert!(fixture.runtime.pl_debug_in_flight.available_permits() < PL_DEBUG_MAX_IN_FLIGHT);
    let began = Instant::now();
    fixture.channel.fail_stop();
    assert!(fixture.channel.wait_for_exit(TEST_TIMEOUT).await);
    assert!(began.elapsed() < Duration::from_secs(2));
}

#[tokio::test]
async fn pl_debug_expired_queued_request_does_not_dispatch_when_the_pipe_later_drains() {
    let fixture = Fixture::spawn("blocked").await;
    let error = fixture
        .channel
        .call::<Value>(
            "pl_debug_resume",
            serde_json::json!({"payload":" ".repeat(2 * 1024 * 1024)}),
            Duration::from_millis(150),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(error.operation_outcome(), AgentOperationOutcome::Unknown);
    let error = fixture
        .channel
        .call::<Value>(
            "pl_debug_status",
            serde_json::json!({"operationId":"expired-must-not-dispatch"}),
            Duration::from_millis(100),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(error.operation_outcome(), AgentOperationOutcome::NotStarted);
    std::fs::write(fixture.directory.path().join("read-gate"), "open").unwrap();
    let status = fixture.status().await;
    assert_eq!(status["methods"], serde_json::json!(["pl_debug_resume", "pl_debug_status"]));
    assert_eq!(status["pending"], 1);
    assert_eq!(status["genericCancels"], 0);
}

#[tokio::test]
async fn pl_debug_open_timeout_keeps_original_reservation_and_does_not_retry() {
    let fixture = Fixture::spawn("open_pending").await;
    let clone = fixture.channel.clone();
    drop(clone);
    let error = fixture.channel.open_session(serde_json::json!({}), Duration::from_millis(150)).await.unwrap_err();
    assert!(matches!(error, AgentCallError::Timeout { operation_outcome: AgentOperationOutcome::Unknown, .. }));
    assert_eq!(fixture.runtime.active_session_count(), 1);
    let status = fixture.status().await;
    assert_eq!(status["opens"], 1);
    assert_eq!(status["genericCancels"], 0);
    assert!(fixture.channel.is_available());
}

#[tokio::test]
async fn pl_debug_shutdown_ack_is_not_process_exit_and_graceful_wait_does_not_hold_child_lock() {
    let fixture = Fixture::spawn("shutdown_delay").await;
    assert_eq!(fixture.channel.request_shutdown(TEST_TIMEOUT).await.unwrap()["ok"], true);
    assert!(!fixture.channel.wait_for_exit(Duration::from_millis(2200)).await);
    assert!(fixture.runtime.child.try_lock().unwrap().try_wait().unwrap().is_none());
    assert!(fixture.channel.wait_for_exit(Duration::from_secs(2)).await);
}

#[tokio::test]
async fn pl_debug_structured_resource_error_keeps_the_original_channel() {
    let fixture = Fixture::spawn("normal").await;
    let ordinary = fixture
        .runtime
        .call_typed::<Value>(
            "pl_debug_get_stack",
            serde_json::json!({"agentSessionId":"fixed-debug-session"}),
            Some(TEST_TIMEOUT),
            None,
        )
        .await
        .unwrap_err();
    assert!(matches!(
        ordinary,
        AgentCallError::ContractViolation { reason: ContractViolationReason::InvalidCombination, .. }
    ));
    let error = fixture
        .channel
        .call::<Value>("pl_debug_get_stack", serde_json::json!({}), TEST_TIMEOUT, None)
        .await
        .unwrap_err();
    assert_eq!(error.category(), Some(AgentErrorCategory::Resource));
    assert_eq!(error.session_disposition(), Some(AgentSessionDisposition::Keep));
    assert_eq!(error.operation_outcome(), AgentOperationOutcome::Unknown);
    assert!(fixture.channel.is_available());
    assert_eq!(fixture.status().await["agentSessionId"], "fixed-debug-session");
}

#[tokio::test]
async fn pl_debug_process_exit_requires_the_child_status_not_only_a_reaper_flag() {
    let fixture = Fixture::spawn("normal").await;
    fixture.runtime.child_reaped.store(true, Ordering::Release);
    assert!(!fixture.channel.wait_for_exit(Duration::from_millis(30)).await);
    assert!(fixture.channel.is_available());
    fixture.runtime.child_reaped.store(false, Ordering::Release);
}

#[tokio::test]
async fn pl_debug_confirmed_process_exit_survives_child_lock_contention() {
    use futures::FutureExt;

    let fixture = Fixture::spawn_observed("normal").await;
    fixture.channel.fail_stop();
    assert!(fixture.channel.wait_for_exit(TEST_TIMEOUT).await);

    // Another exit observer/reaper can own the lock after exit was confirmed.
    let _child = fixture.runtime.child.lock().unwrap();
    assert_eq!(fixture.channel.wait_for_exit(Duration::ZERO).now_or_never(), Some(true));
}

#[tokio::test]
async fn pl_debug_runtime_retirement_requires_exit_and_releases_the_original_reservation_once() {
    let fixture = Fixture::spawn("normal").await;
    let manager = crate::agent_manager::AgentManager::new_with_base_dir_and_app_version(
        fixture.directory.path().join("manager"),
        "test",
    );
    assert!(!fixture.channel.retire_after_exit(&manager).await);
    assert_eq!(fixture.runtime.active_session_count(), 1);
    fixture.channel.fail_stop();
    assert!(fixture.channel.wait_for_exit(TEST_TIMEOUT).await);
    assert!(fixture.channel.retire_after_exit(&manager).await);
    assert_eq!(fixture.runtime.active_session_count(), 0);
    assert!(fixture.channel.retire_after_exit(&manager).await);
    let clone = fixture.channel.clone();
    drop(clone);
    assert_eq!(fixture.runtime.active_session_count(), 0);
}

#[test]
fn pl_debug_resource_extension_rejects_other_states_identities_and_invalid_diagnostics() {
    let original = serde_json::json!({"code":-1,"message":"stack resource error","data":{
        "contractVersion":1,"category":"resource","retryable":false,"sessionDisposition":"keep",
        "stage":"execute","operationOutcome":"unknown","agentSessionId":"debug-session","sqlState":"HY001"
    }});
    for (field, value) in [
        ("sqlState", serde_json::json!("HY000")),
        ("retryable", serde_json::json!(true)),
        ("stage", serde_json::json!("checkout")),
        ("operationOutcome", serde_json::json!("not_started")),
        ("contractVersion", serde_json::json!(2)),
        ("agentSessionId", serde_json::json!("different-session")),
        ("exceptionClass", serde_json::json!("not a class")),
    ] {
        let mut error = original.clone();
        error["data"][field] = value;
        assert!(
            matches!(
                parse_pl_debug_call_error(&error, true, Some("debug-session")),
                AgentCallError::ContractViolation { .. }
            ),
            "invalid {field} was accepted"
        );
    }
}
