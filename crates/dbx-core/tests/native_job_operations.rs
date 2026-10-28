#![recursion_limit = "256"]

use dbx_core::connection::AppState;
use dbx_core::schema::native_jobs::*;
use dbx_core::session_credentials::with_credential_owner;
use dbx_sql::native_job_changes::NativeJobSqlStep;
use dbx_sql::native_jobs::NativeJobCatalogQuery;
use dbx_types::native_jobs::*;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

async fn setup(engine: &str) -> (tempfile::TempDir, Arc<AppState>, NativeJobRef) {
    let dir = tempfile::tempdir().unwrap();
    let storage = dbx_core::persistence::test_storage::open(&dir.path().join("state.db")).await.unwrap();
    let state = Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
        storage,
        dir.path().join("plugins"),
        dir.path().join("agents"),
        "0.0.0",
    ));
    let config = serde_json::from_value(
        json!({"id":"c","name":"test","db_type":engine,"host":"127.0.0.1","port":1,"username":"Owner","password":""}),
    )
    .unwrap();
    state.configs.write().await.insert("c".into(), config);
    let ctx = native_job_open_context_with(&state, "c", "", |_| {
        std::future::ready(Ok(NativeJobRuntimeIdentity { database_info: None, session_user: "Owner".into() }))
    })
    .await
    .unwrap();
    let job = NativeJobRef::Scheduler { scope: ctx.scope, owner: "Owner".into(), name: "Job".into() };
    (dir, state, job)
}

#[derive(Clone)]
struct DbState {
    enabled: bool,
    comments: &'static str,
    action: &'static str,
    duration: &'static str,
    zone: Option<&'static str>,
    id: &'static str,
    deny_arguments: bool,
}
impl Default for DbState {
    fn default() -> Self {
        Self {
            enabled: false,
            comments: "old",
            action: "PROC",
            duration: "+000 00:01:00",
            zone: Some("zone1"),
            id: "41",
            deny_arguments: false,
        }
    }
}

fn result(columns: &[&str], rows: Value) -> Value {
    json!({"columns":columns,"rows":rows,"affected_rows":0,"execution_time_ms":0})
}
fn query(query: NativeJobCatalogQuery, data: &DbState) -> Result<Value, NativeJobCatalogFailure> {
    if query.source.ends_with("JOB_ARGS") && data.deny_arguments {
        return Err(NativeJobCatalogFailure::Denied(Some(942)));
    }
    if query.sql.starts_with("SELECT TO_CHAR(J.JOB) AS DBX_JOB_ID FROM") {
        return Ok(result(&["DBX_JOB_ID"], json!([[data.id]])));
    }
    if matches!(query.source, "SYS.DBA_JOBS" | "SYS.USER_JOBS") {
        return Ok(result(
            &[
                "DBX_JOB_ID",
                "WHAT",
                "INTERVAL",
                "NEXT_DATE",
                "BROKEN",
                "INSTANCE",
                "LOG_USER",
                "PRIV_USER",
                "SCHEMA_USER",
            ],
            json!([[
                data.id,
                data.action,
                "SYSDATE+1",
                "2030-01-01 00:00:00",
                if data.enabled { "N" } else { "Y" },
                data.zone,
                "Owner",
                "Owner",
                "Owner"
            ]]),
        ));
    }
    if query.source.ends_with("_OBJECTS") || query.source.contains("VIRTUAL_TENANT") {
        return Ok(result(&["DBX_JOB_ID", "DBX_CREATED_AT"], json!([[data.id, "creation"]])));
    }
    if query.source.ends_with("SCHEDULER_JOBS") {
        return Ok(result(
            &[
                "OWNER",
                "JOB_NAME",
                "JOB_TYPE",
                "JOB_ACTION",
                "COMMENTS",
                "ENABLED",
                "NUMBER_OF_ARGUMENTS",
                "MAX_RUN_DURATION",
                "INSTANCE_ID",
            ],
            json!([[
                "Owner",
                "Job",
                "STORED_PROCEDURE",
                data.action,
                data.comments,
                if data.enabled { "TRUE" } else { "FALSE" },
                0,
                data.duration,
                "RANDOM"
            ]]),
        ));
    }
    Ok(result(&["JOB_NAME"], json!([])))
}
async fn read(state: &AppState, job: &NativeJobRef, data: DbState) -> NativeJobDetails {
    native_job_read_with(state, job, |q| std::future::ready(query(q, &data))).await.unwrap()
}
async fn prepare(state: &AppState, job: &NativeJobRef, change: NativeJobChange) -> NativeJobPreparedPlan {
    let initial = read(state, job, DbState::default()).await;
    native_job_prepare_with(
        state,
        NativeJobMutation { target: job.clone(), baseline: initial.snapshot.revision, change },
        |target| async move { Ok(read(state, &target, DbState::default()).await) },
    )
    .await
    .unwrap()
}

struct Session {
    state: Arc<AppState>,
    reads: VecDeque<DbState>,
    receipts: VecDeque<NativeJobDispatchOutcome>,
    calls: Arc<AtomicUsize>,
    read_calls: Arc<AtomicUsize>,
    finishes: Arc<AtomicUsize>,
    entered: Option<tokio::sync::oneshot::Sender<()>>,
    release: Option<tokio::sync::oneshot::Receiver<()>>,
    cancel_on_read: Option<(usize, String)>,
    invalidate_on_execute: bool,
    fail_cleanup: bool,
    finish_entered: Option<tokio::sync::oneshot::Sender<()>>,
    finish_release: Option<tokio::sync::oneshot::Receiver<()>>,
    execution_read: Option<Result<NativeJobDetails, &'static str>>,
}
impl Session {
    fn new(state: &Arc<AppState>, reads: Vec<DbState>, receipts: Vec<NativeJobDispatchOutcome>) -> Self {
        Self {
            state: state.clone(),
            reads: reads.into(),
            receipts: receipts.into(),
            calls: Arc::new(AtomicUsize::new(0)),
            read_calls: Arc::new(AtomicUsize::new(0)),
            finishes: Arc::new(AtomicUsize::new(0)),
            entered: None,
            release: None,
            cancel_on_read: None,
            invalidate_on_execute: false,
            fail_cleanup: false,
            finish_entered: None,
            finish_release: None,
            execution_read: None,
        }
    }
}
#[async_trait::async_trait]
impl NativeJobMutationSession for Session {
    async fn read_execution(&mut self, _target: &NativeJobRef) -> Result<NativeJobExecutionRead, &'static str> {
        self.execution_read
            .clone()
            .unwrap_or(Err("fixture observation unavailable"))
            .map(|details| NativeJobExecutionRead::from_details(&details))
    }
    async fn read(&mut self, target: &NativeJobRef) -> Result<NativeJobDetails, &'static str> {
        let count = self.read_calls.fetch_add(1, Ordering::SeqCst) + 1;
        let data = self.reads.pop_front().expect("unexpected database read");
        let result = read(&self.state, target, data).await;
        if let Some((at, id)) = &self.cancel_on_read {
            if count == *at {
                native_job_cancel(&self.state, id);
            }
        }
        Ok(result)
    }
    async fn execute(&mut self, _step: &NativeJobSqlStep) -> NativeJobStepReceipt {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(entered) = self.entered.take() {
            entered.send(()).unwrap();
        }
        if let Some(release) = self.release.take() {
            release.await.unwrap();
        }
        if self.invalidate_on_execute {
            self.state.invalidate_connection_lifecycle("c");
        }
        NativeJobStepReceipt {
            outcome: self.receipts.pop_front().expect("unexpected native dispatch"),
            reason: None,
            vendor_code: None,
        }
    }
    async fn finish(&mut self) -> Result<(), &'static str> {
        if let Some(entered) = self.finish_entered.take() {
            entered.send(()).unwrap();
        }
        if let Some(release) = self.finish_release.take() {
            release.await.unwrap();
        }
        self.finishes.fetch_add(1, Ordering::SeqCst);
        if self.fail_cleanup {
            Err("cleanup failed")
        } else {
            Ok(())
        }
    }
}

#[tokio::test]
async fn accepted_and_unknown_run_receipts_keep_their_outcome_when_fast_failure_is_observed() {
    for receipt in [NativeJobDispatchOutcome::Applied, NativeJobDispatchOutcome::Unknown] {
        let (_dir, state, job) = setup("oracle").await;
        let plan = prepare(&state, &job, NativeJobChange::Run).await;
        let mut observed = read(&state, &job, DbState::default()).await;
        observed.history = NativeJobMetadata::Available {
            value: vec![serde_json::from_value(
                json!({"LOG_ID":"900719925474099312345","STATUS":"FAILED","ERROR#":20001}),
            )
            .unwrap()],
        };
        let mut db = Session::new(&state, vec![DbState::default()], vec![receipt]);
        db.execution_read = Some(Ok(observed));
        let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
        assert_eq!(
            status.outcome,
            if receipt == NativeJobDispatchOutcome::Applied {
                NativeJobOperationOutcome::Accepted
            } else {
                NativeJobOperationOutcome::Unknown
            }
        );
        let observation = status.execution_observation.unwrap();
        assert_eq!(observation.association, "uncertain");
        assert_eq!(observation.candidates.len(), 1);
        assert_eq!(observation.candidates[0].native_key, "900719925474099312345");
        assert_eq!(observation.candidates[0].row["STATUS"], "FAILED");
        assert_eq!(db.read_calls.load(Ordering::SeqCst), 1);
        assert_eq!(db.finishes.load(Ordering::SeqCst), 1);
        let polled = native_job_status_observed_core(&state, &plan.operation_id, false).await;
        assert_eq!(polled.outcome, status.outcome);
        assert_eq!(polled.execution_observation.unwrap().candidates[0].native_key, "900719925474099312345");
        native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
        assert_eq!(db.calls.load(Ordering::SeqCst), 1);
        with_credential_owner(Some("other actor".into()), async {
            assert!(native_job_status_observed_core(&state, &plan.operation_id, true)
                .await
                .execution_observation
                .is_none());
        })
        .await;
    }
}

#[tokio::test]
async fn observation_failure_does_not_turn_an_accepted_request_into_not_applied() {
    let (_dir, state, job) = setup("oracle").await;
    let plan = prepare(&state, &job, NativeJobChange::Run).await;
    let mut db = Session::new(&state, vec![DbState::default()], vec![NativeJobDispatchOutcome::Applied]);
    db.execution_read = Some(Err("catalog denied"));
    let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
    assert_eq!(status.outcome, NativeJobOperationOutcome::Accepted);
    assert_eq!(status.execution_observation.unwrap().association, "unavailable");
    assert_eq!(db.finishes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn native_stop_can_dispatch_beside_a_waiting_run_without_releasing_other_writers() {
    async fn poll_once<T>(future: std::pin::Pin<&mut impl std::future::Future<Output = T>>) -> Option<T> {
        let mut future = future;
        std::future::poll_fn(|cx| {
            std::task::Poll::Ready(match future.as_mut().poll(cx) {
                std::task::Poll::Ready(value) => Some(value),
                std::task::Poll::Pending => None,
            })
        })
        .await
    }
    for engine in ["oracle", "oceanbase-oracle"] {
        let (_dir, state, job) = setup(engine).await;
        let run_plan = prepare(&state, &job, NativeJobChange::Run).await;
        let stop_plan = prepare(&state, &job, NativeJobChange::Stop { force: false }).await;
        let writer_plan = prepare(
            &state,
            &job,
            NativeJobChange::Update {
                final_enabled: None,
                argument_target: None,
                attributes: vec![NativeJobAttributeChange {
                    name: "MAX_RUN_DURATION".into(),
                    change: NativeJobFieldChange::Set { value: json!("0 00:02:00") },
                }],
                arguments: vec![],
            },
        )
        .await;
        let mut run_db = Session::new(&state, vec![DbState::default()], vec![NativeJobDispatchOutcome::Applied]);
        let (run_entered, mut running) = tokio::sync::oneshot::channel();
        let (release_run, wait_run) = tokio::sync::oneshot::channel();
        run_db.entered = Some(run_entered);
        run_db.release = Some(wait_run);
        let mut run = Box::pin(native_job_apply_with(&state, &run_plan.plan_id, &mut run_db));
        tokio::select! { _ = &mut run => panic!("Run returned before its receipt"), _ = &mut running => {} }

        let mut writer_db = Session::new(
            &state,
            vec![DbState::default(), DbState { duration: "0 00:02:00", ..Default::default() }],
            vec![NativeJobDispatchOutcome::Applied],
        );
        let writer_reads = writer_db.read_calls.clone();
        let mut writer = Box::pin(native_job_apply_with(&state, &writer_plan.plan_id, &mut writer_db));
        assert!(poll_once(writer.as_mut()).await.is_none());
        let mut stop_db = Session::new(&state, vec![DbState::default()], vec![NativeJobDispatchOutcome::Applied]);
        let (release_stop, wait_stop) = tokio::sync::oneshot::channel();
        stop_db.finish_release = Some(wait_stop);
        let stop_calls = stop_db.calls.clone();
        let mut stop = Box::pin(native_job_apply_with(&state, &stop_plan.plan_id, &mut stop_db));
        assert!(poll_once(stop.as_mut()).await.is_none());
        let dispatched_beside_run = stop_calls.load(Ordering::SeqCst);
        release_run.send(()).unwrap();
        let run_result = run.await.unwrap();
        let early_writer = poll_once(writer.as_mut()).await;
        let reads_before_stop_cleanup = writer_reads.load(Ordering::SeqCst);
        release_stop.send(()).unwrap();
        let stop_result = stop.await.unwrap();
        let writer_result = match early_writer {
            Some(result) => result.unwrap(),
            None => writer.await.unwrap(),
        };
        assert_eq!(dispatched_beside_run, 1, "{engine}: Stop waited behind Run or the queued writer");
        assert_eq!(reads_before_stop_cleanup, 0, "{engine}: writer passed Stop cleanup");
        assert_eq!(run_result.outcome, NativeJobOperationOutcome::Accepted);
        assert_eq!(stop_result.outcome, NativeJobOperationOutcome::Accepted);
        assert_eq!(writer_result.outcome, NativeJobOperationOutcome::Verified);
    }
}

#[tokio::test]
async fn two_stops_remain_serial_and_do_not_rewrite_a_canceled_or_unknown_run() {
    async fn poll_once<T>(mut future: std::pin::Pin<&mut impl std::future::Future<Output = T>>) -> Option<T> {
        std::future::poll_fn(|cx| {
            std::task::Poll::Ready(match future.as_mut().poll(cx) {
                std::task::Poll::Ready(value) => Some(value),
                std::task::Poll::Pending => None,
            })
        })
        .await
    }
    for (receipt, cleanup_failed) in [
        (NativeJobDispatchOutcome::Applied, false),
        (NativeJobDispatchOutcome::Unknown, false),
        (NativeJobDispatchOutcome::Applied, true),
    ] {
        let (_dir, state, job) = setup("oceanbase-oracle").await;
        let run_plan = prepare(&state, &job, NativeJobChange::Run).await;
        let first_plan = prepare(&state, &job, NativeJobChange::Stop { force: false }).await;
        let second_plan = prepare(&state, &job, NativeJobChange::Stop { force: false }).await;
        let mut run_db = Session::new(&state, vec![DbState::default()], vec![receipt]);
        run_db.fail_cleanup = cleanup_failed;
        let (entered, mut running) = tokio::sync::oneshot::channel();
        let (release_run, wait_run) = tokio::sync::oneshot::channel();
        run_db.entered = Some(entered);
        run_db.release = Some(wait_run);
        let mut run = Box::pin(native_job_apply_with(&state, &run_plan.plan_id, &mut run_db));
        tokio::select! { _ = &mut run => panic!("Run returned before its receipt"), _ = &mut running => {} }
        assert!(native_job_cancel(&state, &run_plan.operation_id).cancel_requested);
        let mut first_db = Session::new(&state, vec![DbState::default()], vec![NativeJobDispatchOutcome::Applied]);
        let (release_first, wait_first) = tokio::sync::oneshot::channel();
        first_db.release = Some(wait_first);
        let first_calls = first_db.calls.clone();
        let mut first = Box::pin(native_job_apply_with(&state, &first_plan.plan_id, &mut first_db));
        assert!(poll_once(first.as_mut()).await.is_none());
        let mut second_db = Session::new(&state, vec![DbState::default()], vec![NativeJobDispatchOutcome::Applied]);
        let second_calls = second_db.calls.clone();
        let mut second = Box::pin(native_job_apply_with(&state, &second_plan.plan_id, &mut second_db));
        let early_second = poll_once(second.as_mut()).await;
        let serial_count = second_calls.load(Ordering::SeqCst);
        let first_count = first_calls.load(Ordering::SeqCst);
        release_first.send(()).unwrap();
        let first_result = tokio::time::timeout(std::time::Duration::from_secs(3), first)
            .await
            .expect("Stop did not dispatch beside the canceled Run")
            .unwrap();
        let second_result = match early_second {
            Some(result) => Some(result),
            None => poll_once(second.as_mut()).await,
        };
        let second_before_run_finished = second_calls.load(Ordering::SeqCst);
        release_run.send(()).unwrap();
        let run_result = run.await.unwrap();
        let second_result = match second_result {
            Some(result) => result.unwrap(),
            None => second.await.unwrap(),
        };
        assert_eq!(first_count, 1);
        assert_eq!(serial_count, 0);
        assert_eq!(second_before_run_finished, 1);
        assert_eq!(first_result.outcome, NativeJobOperationOutcome::Accepted);
        assert_eq!(second_result.outcome, NativeJobOperationOutcome::Accepted);
        assert_eq!(
            run_result.outcome,
            if receipt == NativeJobDispatchOutcome::Unknown || cleanup_failed {
                NativeJobOperationOutcome::Unknown
            } else {
                NativeJobOperationOutcome::Accepted
            }
        );
        assert!(run_result.cancel_requested);
        assert_eq!(native_job_status(&state, &run_plan.operation_id).outcome, run_result.outcome);
        let mut duplicate = Session::new(&state, vec![], vec![]);
        native_job_apply_with(&state, &second_plan.plan_id, &mut duplicate).await.unwrap();
        assert_eq!(duplicate.calls.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn stop_cannot_borrow_a_run_lock_from_another_native_generation() {
    let (_dir, state, job) = setup("oceanbase-oracle").await;
    let run_plan = prepare(&state, &job, NativeJobChange::Run).await;
    let mut run_db = Session::new(&state, vec![DbState::default()], vec![NativeJobDispatchOutcome::Applied]);
    let (entered, mut running) = tokio::sync::oneshot::channel();
    let (release_run, wait_run) = tokio::sync::oneshot::channel();
    run_db.entered = Some(entered);
    run_db.release = Some(wait_run);
    let mut run = Box::pin(native_job_apply_with(&state, &run_plan.plan_id, &mut run_db));
    tokio::select! { _ = &mut run => panic!("Run returned before its receipt"), _ = &mut running => {} }
    let replacement = DbState { id: "42", ..Default::default() };
    let fresh = read(&state, &job, replacement.clone()).await;
    let stop_plan = native_job_prepare_with(
        &state,
        NativeJobMutation {
            target: job.clone(),
            baseline: fresh.snapshot.revision,
            change: NativeJobChange::Stop { force: false },
        },
        |target| {
            let state = &state;
            let replacement = replacement.clone();
            async move { Ok(read(state, &target, replacement).await) }
        },
    )
    .await
    .unwrap();
    let mut stop_db = Session::new(&state, vec![replacement], vec![NativeJobDispatchOutcome::Applied]);
    let calls = stop_db.calls.clone();
    let mut stop = Box::pin(native_job_apply_with(&state, &stop_plan.plan_id, &mut stop_db));
    let early = std::future::poll_fn(|cx| {
        use std::future::Future;
        std::task::Poll::Ready(match stop.as_mut().poll(cx) {
            std::task::Poll::Ready(value) => Some(value),
            std::task::Poll::Pending => None,
        })
    })
    .await;
    release_run.send(()).unwrap();
    run.await.unwrap();
    let status = match early {
        Some(result) => result.unwrap(),
        None => stop.await.unwrap(),
    };
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(status.outcome, NativeJobOperationOutcome::NotApplied);
    assert_eq!(status.reason.as_deref(), Some("native_job_replaced"));
}

#[tokio::test]
async fn same_job_lock_is_held_until_the_owned_session_has_finished_cleanup() {
    let (_dir, state, job) = setup("oracle").await;
    let a = prepare(&state, &job, NativeJobChange::Run).await;
    let b = prepare(&state, &job, NativeJobChange::Run).await;
    let mut first_db = Session::new(&state, vec![DbState::default()], vec![NativeJobDispatchOutcome::Applied]);
    let mut second_db = Session::new(&state, vec![DbState::default()], vec![NativeJobDispatchOutcome::Applied]);
    let (entered, mut closing) = tokio::sync::oneshot::channel();
    let (release, wait) = tokio::sync::oneshot::channel();
    first_db.finish_entered = Some(entered);
    first_db.finish_release = Some(wait);
    let second_reads = second_db.read_calls.clone();
    let mut first = Box::pin(native_job_apply_with(&state, &a.plan_id, &mut first_db));
    tokio::select! { result = &mut first => { assert!(result.is_err()); panic!("session closed before its acknowledgement"); }, _ = &mut closing => {} }
    let mut second = Box::pin(native_job_apply_with(&state, &b.plan_id, &mut second_db));
    let second_result = std::future::poll_fn(|cx| {
        use std::future::Future;
        std::task::Poll::Ready(match second.as_mut().poll(cx) {
            std::task::Poll::Ready(result) => Some(result),
            std::task::Poll::Pending => None,
        })
    })
    .await;
    let reads_while_closing = second_reads.load(Ordering::SeqCst);
    release.send(()).unwrap();
    first.await.unwrap();
    match second_result {
        Some(result) => {
            result.unwrap();
        }
        None => {
            second.await.unwrap();
        }
    }
    assert_eq!(reads_while_closing, 0, "a second operation read the job before the first session finished cleanup");
}

#[tokio::test]
async fn stable_definition_still_allows_stop_with_unavailable_argument_metadata() {
    for engine in ["oracle", "oceanbase-oracle"] {
        let (_dir, state, job) = setup(engine).await;
        let data = DbState { deny_arguments: true, ..Default::default() };
        let initial = read(&state, &job, data.clone()).await;
        if engine == "oracle" {
            assert!(matches!(initial.parameter_metadata, NativeJobMetadata::Denied { .. }));
        } else {
            assert!(matches!(
                initial.parameter_metadata,
                NativeJobMetadata::Unknown { .. } | NativeJobMetadata::Unsupported { .. }
            ));
        }
        let plan = native_job_prepare_with(
            &state,
            NativeJobMutation {
                target: job,
                baseline: initial.snapshot.revision,
                change: NativeJobChange::Stop { force: false },
            },
            |target| {
                let state = &state;
                let data = data.clone();
                async move { Ok(read(state, &target, data).await) }
            },
        )
        .await
        .unwrap();
        let mut session = Session::new(&state, vec![data], vec![NativeJobDispatchOutcome::Applied]);
        let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
        assert_eq!(status.outcome, NativeJobOperationOutcome::Accepted);
        assert_eq!(session.calls.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn control_previews_reject_changed_bodies_before_dispatch_on_the_same_native_generation() {
    for engine in ["oracle", "oceanbase-oracle"] {
        for legacy in [false, true] {
            for change in [
                NativeJobChange::Run,
                NativeJobChange::Enable,
                NativeJobChange::Disable,
                NativeJobChange::Drop { force: false },
            ] {
                let (_dir, state, scheduler) = setup(engine).await;
                let job = if legacy {
                    NativeJobRef::Legacy { scope: scheduler.scope().clone(), job_id: "41".into() }
                } else {
                    scheduler
                };
                let plan = prepare(&state, &job, change).await;
                let changed = DbState { action: "EXTERNAL_BODY", ..Default::default() };
                let mut db =
                    Session::new(&state, vec![changed.clone(), changed], vec![NativeJobDispatchOutcome::Applied]);
                let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
                assert_eq!(db.calls.load(Ordering::SeqCst), 0, "{engine}, legacy={legacy}");
                assert_eq!(status.outcome, NativeJobOperationOutcome::NotApplied);
                assert_eq!(status.reason.as_deref(), Some("native_job_definition_changed"));
                assert_eq!(db.finishes.load(Ordering::SeqCst), 1);
            }
        }
    }
}

#[tokio::test]
async fn duplicate_confirmation_returns_the_same_operation_without_redispatch() {
    let (_dir, state, job) = setup("oracle").await;
    let plan = prepare(&state, &job, NativeJobChange::Enable).await;
    let mut db = Session::new(
        &state,
        vec![DbState::default(), DbState { enabled: true, ..Default::default() }],
        vec![NativeJobDispatchOutcome::Applied],
    );
    let first = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
    assert!(first.outcome == NativeJobOperationOutcome::Verified);
    let mut unused = Session::new(&state, vec![], vec![]);
    let second = native_job_apply_with(&state, &plan.plan_id, &mut unused).await.unwrap();
    assert_eq!(first.operation_id, second.operation_id);
    assert_eq!(db.calls.load(Ordering::SeqCst), 1);
    assert_eq!(unused.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn backend_readonly_gate_blocks_and_the_existing_unlock_allows_the_adjacent_path() {
    let (_dir, state, job) = setup("oracle").await;
    let plan = prepare(&state, &job, NativeJobChange::Enable).await;
    state.configs.write().await.get_mut("c").unwrap().read_only = true;
    let mut denied = Session::new(&state, vec![], vec![]);
    let result = native_job_apply_with(&state, &plan.plan_id, &mut denied).await.unwrap();
    assert!(result.outcome == NativeJobOperationOutcome::NotApplied);
    assert_eq!(denied.calls.load(Ordering::SeqCst), 0);
    state.write_unlock_windows.unlock("c", 60).await.unwrap();
    let new_plan = prepare(&state, &job, NativeJobChange::Enable).await;
    let mut allowed = Session::new(
        &state,
        vec![DbState::default(), DbState { enabled: true, ..Default::default() }],
        vec![NativeJobDispatchOutcome::Applied],
    );
    assert!(
        native_job_apply_with(&state, &new_plan.plan_id, &mut allowed).await.unwrap().outcome
            == NativeJobOperationOutcome::Verified
    );
}

#[tokio::test]
async fn canceling_a_prepared_plan_never_sends_a_native_statement() {
    let (_dir, state, job) = setup("oracle").await;
    let plan = prepare(&state, &job, NativeJobChange::Run).await;
    let canceled = native_job_cancel(&state, &plan.operation_id);
    assert!(canceled.outcome == NativeJobOperationOutcome::NotApplied);
    let mut unused = Session::new(&state, vec![], vec![]);
    let result = native_job_apply_with(&state, &plan.plan_id, &mut unused).await.unwrap();
    assert!(result.cancel_requested);
    assert_eq!(unused.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn cancel_after_dispatch_waits_for_the_receipt_and_is_not_native_stop_or_rollback() {
    let (_dir, state, job) = setup("oracle").await;
    let plan = prepare(&state, &job, NativeJobChange::Enable).await;
    let mut db = Session::new(
        &state,
        vec![DbState::default(), DbState { enabled: true, ..Default::default() }],
        vec![NativeJobDispatchOutcome::Applied],
    );
    let (entered, mut started) = tokio::sync::oneshot::channel();
    let (release, wait) = tokio::sync::oneshot::channel();
    db.entered = Some(entered);
    db.release = Some(wait);
    let calls = db.calls.clone();
    let mut first = Box::pin(native_job_apply_with(&state, &plan.plan_id, &mut db));
    tokio::select! {result=&mut first=>{assert!(result.is_err());panic!("dispatch ended before its receipt");},_=&mut started=>{}}
    let canceled = native_job_cancel(&state, &plan.operation_id);
    assert!(canceled.state == NativeJobOperationState::Running);
    let mut unused = Session::new(&state, vec![], vec![]);
    let duplicate = native_job_apply_with(&state, &plan.plan_id, &mut unused).await.unwrap();
    assert!(duplicate.state == NativeJobOperationState::Running);
    release.send(()).unwrap();
    let finished = first.await.unwrap();
    assert!(finished.cancel_requested);
    assert!(finished.outcome == NativeJobOperationOutcome::Verified);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(unused.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn unknown_run_response_stays_unknown_and_does_not_replay_the_business_job() {
    let (_dir, state, job) = setup("oracle").await;
    let plan = prepare(&state, &job, NativeJobChange::Run).await;
    let mut db = Session::new(&state, vec![DbState::default()], vec![NativeJobDispatchOutcome::Unknown]);
    let result = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
    assert!(result.outcome == NativeJobOperationOutcome::Unknown);
    let mut unused = Session::new(&state, vec![], vec![]);
    native_job_apply_with(&state, &plan.plan_id, &mut unused).await.unwrap();
    assert_eq!(db.calls.load(Ordering::SeqCst), 1);
    assert_eq!(unused.calls.load(Ordering::SeqCst), 0);
    assert!(native_job_status(&state, "missing-record").outcome == NativeJobOperationOutcome::Unknown);
}

#[tokio::test]
async fn asynchronous_acceptance_is_not_reported_as_a_completed_run() {
    let (_dir, state, job) = setup("oracle").await;
    let plan = prepare(&state, &job, NativeJobChange::Run).await;
    let mut db = Session::new(&state, vec![DbState::default()], vec![NativeJobDispatchOutcome::Applied]);
    assert!(
        native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap().outcome
            == NativeJobOperationOutcome::Accepted
    );
    assert_eq!(db.read_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_connection_change_before_dispatch_blocks_writes_and_one_after_dispatch_remains_unknown() {
    let (_dir, state, job) = setup("oracle").await;
    let plan = prepare(&state, &job, NativeJobChange::Enable).await;
    state.invalidate_connection_lifecycle("c");
    let mut unused = Session::new(&state, vec![], vec![]);
    assert!(
        native_job_apply_with(&state, &plan.plan_id, &mut unused).await.unwrap().outcome
            == NativeJobOperationOutcome::NotApplied
    );
    let (_dir2, state2, job2) = setup("oracle").await;
    let plan2 = prepare(&state2, &job2, NativeJobChange::Enable).await;
    let mut db = Session::new(&state2, vec![DbState::default()], vec![NativeJobDispatchOutcome::Applied]);
    db.invalidate_on_execute = true;
    assert!(
        native_job_apply_with(&state2, &plan2.plan_id, &mut db).await.unwrap().outcome
            == NativeJobOperationOutcome::Unknown
    );
    assert_eq!(db.read_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cancellation_between_attributes_preserves_partial_success_and_skips_remaining_steps() {
    let (_dir, state, job) = setup("oceanbase-oracle").await;
    let changes = NativeJobChange::Update {
        final_enabled: None,
        argument_target: None,
        attributes: vec![
            NativeJobAttributeChange {
                name: "MAX_RUN_DURATION".into(),
                change: NativeJobFieldChange::Set { value: json!("0 00:02:00") },
            },
            NativeJobAttributeChange {
                name: "INSTANCE_ID".into(),
                change: NativeJobFieldChange::Set { value: json!("zone1") },
            },
        ],
        arguments: vec![],
    };
    let plan = prepare(&state, &job, changes).await;
    assert_eq!(plan.steps.len(), 2);
    let mut db = Session::new(
        &state,
        vec![DbState::default(), DbState { duration: "+000 00:02:00", ..Default::default() }],
        vec![NativeJobDispatchOutcome::Applied],
    );
    db.cancel_on_read = Some((2, plan.operation_id.clone()));
    let result = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
    assert!(result.outcome == NativeJobOperationOutcome::Partial);
    assert!(result.steps[0].state == NativeJobStepState::Applied);
    assert!(result.steps[1].state == NativeJobStepState::Skipped);
    assert_eq!(db.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn ob_legacy_zone_edits_verify_raw_instance_without_hiding_other_definition_changes() {
    for (zone, changed) in [(None, false), (Some("zone2"), false), (Some("zone2"), true)] {
        let (_dir, state, scheduler) = setup("oceanbase-oracle").await;
        let job = NativeJobRef::Legacy { scope: scheduler.scope().clone(), job_id: "41".into() };
        let change = NativeJobChange::Update {
            final_enabled: None,
            argument_target: None,
            attributes: vec![NativeJobAttributeChange {
                name: "ZONE".into(),
                change: zone
                    .map(|zone| NativeJobFieldChange::Set { value: json!(zone) })
                    .unwrap_or(NativeJobFieldChange::Clear),
            }],
            arguments: vec![],
        };
        let plan = prepare(&state, &job, change).await;
        let after = DbState { zone, action: if changed { "EXTERNAL" } else { "PROC" }, ..Default::default() };
        let mut db = Session::new(&state, vec![DbState::default(), after], vec![NativeJobDispatchOutcome::Applied]);
        let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
        assert_eq!(
            status.outcome,
            if changed { NativeJobOperationOutcome::Partial } else { NativeJobOperationOutcome::Verified }
        );
        assert_eq!(db.calls.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn an_external_change_before_apply_is_not_overwritten_and_cleanup_failure_is_not_hidden() {
    let (_dir, state, job) = setup("oracle").await;
    let changes = NativeJobChange::Update {
        final_enabled: None,
        argument_target: None,
        attributes: vec![NativeJobAttributeChange {
            name: "COMMENTS".into(),
            change: NativeJobFieldChange::Set { value: json!("new") },
        }],
        arguments: vec![],
    };
    let plan = prepare(&state, &job, changes).await;
    let mut changed = Session::new(&state, vec![DbState { comments: "external", ..Default::default() }], vec![]);
    assert!(
        native_job_apply_with(&state, &plan.plan_id, &mut changed).await.unwrap().outcome
            == NativeJobOperationOutcome::NotApplied
    );
    assert_eq!(changed.calls.load(Ordering::SeqCst), 0);
    let plan = prepare(&state, &job, NativeJobChange::Enable).await;
    let mut db = Session::new(
        &state,
        vec![DbState::default(), DbState { enabled: true, ..Default::default() }],
        vec![NativeJobDispatchOutcome::Applied],
    );
    db.fail_cleanup = true;
    let result = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
    assert!(result.outcome == NativeJobOperationOutcome::Unknown);
    assert!(result.steps[0].state == NativeJobStepState::Applied);
}

#[tokio::test]
async fn different_operations_for_the_same_native_job_wait_before_preflight() {
    let (_dir, state, job) = setup("oracle").await;
    let first_plan = prepare(&state, &job, NativeJobChange::Enable).await;
    let second_plan = prepare(&state, &job, NativeJobChange::Disable).await;
    let mut first_db = Session::new(
        &state,
        vec![DbState::default(), DbState { enabled: true, ..Default::default() }],
        vec![NativeJobDispatchOutcome::Applied],
    );
    let mut second_db = Session::new(
        &state,
        vec![DbState { enabled: true, ..Default::default() }, DbState::default()],
        vec![NativeJobDispatchOutcome::Applied],
    );
    let (entered, mut started) = tokio::sync::oneshot::channel();
    let (release, wait) = tokio::sync::oneshot::channel();
    first_db.entered = Some(entered);
    first_db.release = Some(wait);
    let second_reads = second_db.read_calls.clone();
    let mut first = Box::pin(native_job_apply_with(&state, &first_plan.plan_id, &mut first_db));
    tokio::select! { result = &mut first => { assert!(result.is_err()); panic!("native call finished before its receipt"); }, _ = &mut started => {} }
    let mut second = Box::pin(native_job_apply_with(&state, &second_plan.plan_id, &mut second_db));
    std::future::poll_fn(|cx| {
        use std::future::Future;
        assert!(second.as_mut().poll(cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    assert_eq!(second_reads.load(Ordering::SeqCst), 0);
    release.send(()).unwrap();
    let (first, second) = tokio::join!(first, second);
    assert!(first.unwrap().outcome == NativeJobOperationOutcome::Verified);
    let second = second.unwrap();
    assert_eq!(second.outcome, NativeJobOperationOutcome::NotApplied);
    assert_eq!(second.reason.as_deref(), Some("native_job_definition_changed"));
    assert_eq!(second_db.calls.load(Ordering::SeqCst), 0);
    let enabled = DbState { enabled: true, ..Default::default() };
    let fresh = read(&state, &job, enabled.clone()).await;
    let plan = native_job_prepare_with(
        &state,
        NativeJobMutation { target: job.clone(), baseline: fresh.snapshot.revision, change: NativeJobChange::Disable },
        |target| {
            let state = &state;
            let enabled = enabled.clone();
            async move { Ok(read(state, &target, enabled).await) }
        },
    )
    .await
    .unwrap();
    let mut fresh_db = Session::new(&state, vec![enabled, DbState::default()], vec![NativeJobDispatchOutcome::Applied]);
    assert_eq!(
        native_job_apply_with(&state, &plan.plan_id, &mut fresh_db).await.unwrap().outcome,
        NativeJobOperationOutcome::Verified
    );
}

#[tokio::test]
async fn another_actor_cannot_confirm_cancel_or_read_the_prepared_operation() {
    let (_dir, state, job) = setup("oracle").await;
    let plan = prepare(&state, &job, NativeJobChange::Run).await;
    with_credential_owner(Some("another-authenticated-user".into()), async {
        let mut unused = Session::new(&state, vec![], vec![]);
        assert!(native_job_apply_with(&state, &plan.plan_id, &mut unused).await.is_err());
        let status = native_job_cancel(&state, &plan.operation_id);
        assert!(status.outcome == NativeJobOperationOutcome::Unknown);
        assert!(status.target.is_none());
    })
    .await;
    assert!(native_job_status(&state, &plan.operation_id).state == NativeJobOperationState::Prepared);
}

#[tokio::test]
async fn an_interrupted_authenticated_worker_becomes_unknown_and_cannot_be_replayed() {
    let (_dir, state, _job) = setup("oracle").await;
    let actor = Some("authenticated-owner".into());
    let (job, plan) = with_credential_owner(actor.clone(), async {
        let ctx = native_job_open_context_with(&state, "c", "", |_| {
            std::future::ready(Ok(NativeJobRuntimeIdentity { database_info: None, session_user: "Owner".into() }))
        })
        .await
        .unwrap();
        let job = NativeJobRef::Scheduler { scope: ctx.scope, owner: "Owner".into(), name: "Job".into() };
        let plan = prepare(&state, &job, NativeJobChange::Run).await;
        (job, plan)
    })
    .await;
    let mut db = Session::new(&state, vec![DbState::default()], vec![NativeJobDispatchOutcome::Applied]);
    let (entered, mut started) = tokio::sync::oneshot::channel();
    let (_release, wait) = tokio::sync::oneshot::channel();
    db.entered = Some(entered);
    db.release = Some(wait);
    let mut work =
        Box::pin(with_credential_owner(actor.clone(), native_job_apply_with(&state, &plan.plan_id, &mut db)));
    tokio::select! { result = &mut work => { assert!(result.is_err()); panic!("native call ended before interruption"); }, _ = &mut started => {} }
    drop(work);
    with_credential_owner(actor, async {
        let interrupted = native_job_status(&state, &plan.operation_id);
        assert!(interrupted.outcome == NativeJobOperationOutcome::Unknown);
        assert!(interrupted.steps[0].state == NativeJobStepState::Unknown);
        let mut unused = Session::new(&state, vec![], vec![]);
        assert!(
            native_job_apply_with(&state, &plan.plan_id, &mut unused).await.unwrap().outcome
                == NativeJobOperationOutcome::Unknown
        );
        assert_eq!(unused.calls.load(Ordering::SeqCst), 0);
    })
    .await;
    assert_eq!(db.calls.load(Ordering::SeqCst), 1);
    assert!(matches!(job, NativeJobRef::Scheduler { .. }));
}
