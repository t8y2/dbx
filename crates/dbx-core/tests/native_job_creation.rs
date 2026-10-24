#![recursion_limit = "256"]

use dbx_core::connection::AppState;
use dbx_core::schema::native_jobs::*;
use dbx_sql::native_job_changes::NativeJobSqlStep;
use dbx_types::native_jobs::*;
use serde_json::json;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

const JOB_ID: &str = "9007199254740993";

async fn setup() -> (tempfile::TempDir, Arc<AppState>, NativeJobScope) {
    setup_engine("oracle").await
}

async fn setup_engine(engine: &str) -> (tempfile::TempDir, Arc<AppState>, NativeJobScope) {
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
    let context = native_job_open_context_with(&state, "c", "", |_| {
        std::future::ready(Ok(NativeJobRuntimeIdentity { database_info: None, session_user: "Owner".into() }))
    })
    .await
    .unwrap();
    (dir, state, context.scope)
}

fn definition() -> NativeJobLegacyCreate {
    NativeJobLegacyCreate {
        what: "private_call('original');".into(),
        next_date: "2026-10-21 10:20:30".into(),
        interval: "SYSDATE + 1".into(),
        enabled: false,
        instance: 0,
        schema: "Owner".into(),
        zone: None,
    }
}

async fn preview(
    state: &AppState,
    scope: &NativeJobScope,
    definition: NativeJobLegacyCreate,
) -> Result<NativeJobPreparedPlan, &'static str> {
    native_job_prepare_request_with(
        state,
        NativeJobRequest::Create { scope: scope.clone(), definition: NativeJobCreateDefinition::Legacy(definition) },
        |_| std::future::ready(Err("preview must not query or execute a job")),
    )
    .await
}

fn receipt(phase: NativeJobLegacyPhase) -> NativeJobLegacyReceipt {
    NativeJobLegacyReceipt {
        operation_id: String::new(),
        phase,
        job_id: Some(JOB_ID.into()),
        reason: None,
        vendor_code: None,
        disposal_confirmed: None,
    }
}

struct Session {
    state: Arc<AppState>,
    definition: Option<NativeJobLegacyCreate>,
    prepared: NativeJobLegacyReceipt,
    committed: NativeJobLegacyReceipt,
    rolled_back: NativeJobLegacyReceipt,
    calls: Vec<(String, Option<String>)>,
    reads: Arc<AtomicUsize>,
    cancel_after_prepare: bool,
    invalidate_after_prepare: bool,
    readonly_after_prepare: bool,
    wrong_operation: bool,
    missing: bool,
    changed: bool,
    wrong_zone: bool,
    advanced_next_date: bool,
    fail_cleanup: bool,
    prepare_entered: Option<tokio::sync::oneshot::Sender<()>>,
    prepare_release: Option<tokio::sync::oneshot::Receiver<()>>,
    finish_entered: Option<tokio::sync::oneshot::Sender<()>>,
    finish_release: Option<tokio::sync::oneshot::Receiver<()>>,
}

impl Session {
    fn new(state: &Arc<AppState>) -> Self {
        Self {
            state: state.clone(),
            definition: None,
            prepared: receipt(NativeJobLegacyPhase::Prepared),
            committed: receipt(NativeJobLegacyPhase::Committed),
            rolled_back: receipt(NativeJobLegacyPhase::RolledBack),
            calls: Vec::new(),
            reads: Arc::new(AtomicUsize::new(0)),
            cancel_after_prepare: false,
            invalidate_after_prepare: false,
            readonly_after_prepare: false,
            wrong_operation: false,
            missing: false,
            changed: false,
            wrong_zone: false,
            advanced_next_date: false,
            fail_cleanup: false,
            prepare_entered: None,
            prepare_release: None,
            finish_entered: None,
            finish_release: None,
        }
    }
}

async fn read_definition(
    state: &AppState,
    target: &NativeJobRef,
    definition: &NativeJobLegacyCreate,
    missing: bool,
    changed: bool,
    advanced: bool,
) -> NativeJobDetails {
    let oceanbase =
        state.configs.read().await["c"].db_type == dbx_core::models::connection::DatabaseType::OceanbaseOracle;
    let instance = if oceanbase { json!(definition.zone) } else { json!(definition.instance) };
    native_job_read_with(state, target, |query| {
        let generation = query.sql.starts_with("SELECT TO_CHAR(J.JOB)");
        let mut raw = if generation {
            json!({"columns":["DBX_JOB_ID"],"rows":if missing { json!([]) } else { json!([[JOB_ID]]) }})
        } else if query.source.ends_with("_JOBS") {
            json!({"columns":["DBX_JOB_ID","WHAT","NEXT_DATE","INTERVAL","BROKEN","INSTANCE","LOG_USER","PRIV_USER","SCHEMA_USER"],
                "rows":if missing { json!([]) } else { json!([[JOB_ID,if changed { "external_call();" } else { &definition.what },
                    if advanced { "2026-10-22T10:20:30" } else { "2026-10-21T10:20:30.000" }, definition.interval,
                    if definition.enabled { "N" } else { "Y" }, instance,"Owner","Owner",definition.schema]]) }})
        } else { json!({"columns":["JOB"],"rows":[]}) };
        raw["affected_rows"] = json!(0);
        raw["execution_time_ms"] = json!(0);
        std::future::ready(Ok(raw))
    }).await.unwrap()
}

#[async_trait::async_trait]
impl NativeJobMutationSession for Session {
    async fn read(&mut self, target: &NativeJobRef) -> Result<NativeJobDetails, &'static str> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let NativeJobRef::Legacy { job_id, .. } = target else {
            panic!("new legacy Job must not use a Scheduler name")
        };
        assert_eq!(job_id, JOB_ID);
        let mut definition = self.definition.as_ref().unwrap().clone();
        if self.wrong_zone {
            definition.zone = Some("another-zone".into());
        }
        Ok(read_definition(&self.state, target, &definition, self.missing, self.changed, self.advanced_next_date).await)
    }
    async fn execute(&mut self, _step: &NativeJobSqlStep) -> NativeJobStepReceipt {
        self.calls.push(("execute".into(), None));
        self.definition.as_mut().unwrap().enabled = true;
        NativeJobStepReceipt { outcome: NativeJobDispatchOutcome::Applied, reason: None, vendor_code: None }
    }
    async fn prepare_legacy(&mut self, id: &str, definition: &NativeJobLegacyCreate) -> NativeJobLegacyReceipt {
        self.calls.push(("prepare".into(), None));
        self.definition = Some(definition.clone());
        assert!(native_job_status(&self.state, id).target.is_none());
        if let Some(entered) = self.prepare_entered.take() {
            entered.send(()).unwrap();
        }
        if let Some(release) = self.prepare_release.take() {
            release.await.unwrap();
        }
        if self.cancel_after_prepare {
            native_job_cancel(&self.state, id);
        }
        if self.invalidate_after_prepare {
            self.state.invalidate_connection_lifecycle("c");
        }
        if self.readonly_after_prepare {
            self.state.configs.write().await.get_mut("c").unwrap().read_only = true;
        }
        let mut prepared = self.prepared.clone();
        prepared.operation_id = if self.wrong_operation { "another operation".into() } else { id.into() };
        prepared
    }
    async fn finish_legacy(&mut self, id: &str, job_id: Option<&str>, commit: bool) -> NativeJobLegacyReceipt {
        self.calls.push((if commit { "commit".into() } else { "rollback".into() }, job_id.map(str::to_string)));
        if commit {
            assert_eq!(job_id, Some(JOB_ID));
            let NativeJobRef::Legacy { job_id: recorded, .. } = native_job_status(&self.state, id).target.unwrap()
            else {
                panic!("OUT identity must be persisted before COMMIT")
            };
            assert_eq!(recorded, JOB_ID);
        }
        let mut receipt = if commit { self.committed.clone() } else { self.rolled_back.clone() };
        receipt.operation_id = id.into();
        receipt
    }
    async fn finish(&mut self) -> Result<(), &'static str> {
        if let Some(entered) = self.finish_entered.take() {
            entered.send(()).unwrap();
        }
        if let Some(release) = self.finish_release.take() {
            release.await.unwrap();
        }
        if self.fail_cleanup {
            Err("close response lost")
        } else {
            Ok(())
        }
    }
}

#[tokio::test]
async fn preview_has_an_explicit_scope_but_no_invented_out_id_or_database_side_effects() {
    let (_dir, state, scope) = setup().await;
    let mut request = definition();
    request.schema.clear();
    let plan = preview(&state, &scope, request).await.unwrap();
    assert!(plan.target.is_none());
    assert_eq!(plan.scope, scope);
    assert_eq!(plan.steps.len(), 3);
    assert!(plan.steps[0].sql.contains("CURRENT_SCHEMA = \"Owner\""));
    assert!(plan.steps[0].sql.contains(":dbx_job_id"));
    assert!(plan.steps[0].sql.contains("DBMS_JOB.BROKEN"));
    for date in ["2026-02-30 10:20:30", "0000-01-01 10:20:30"] {
        let mut invalid = definition();
        invalid.next_date = date.into();
        assert_eq!(preview(&state, &scope, invalid).await.err(), Some("native_job_date_invalid"));
    }
    let mut forged = scope;
    forged.context_id = "forged".into();
    assert_eq!(preview(&state, &forged, definition()).await.err(), Some("native_job_context_expired"));
}

#[tokio::test]
async fn a_real_out_id_is_recorded_before_commit_and_duplicate_apply_never_submits_again() {
    let (_dir, state, scope) = setup().await;
    let plan = preview(&state, &scope, definition()).await.unwrap();
    let mut db = Session::new(&state);
    let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
    assert_eq!(status.outcome, NativeJobOperationOutcome::Verified);
    assert_eq!(db.calls, [("prepare".into(), None), ("commit".into(), Some(JOB_ID.into()))]);
    assert_eq!(db.reads.load(Ordering::SeqCst), 1);
    assert!(status.steps.iter().all(|step| step.state == NativeJobStepState::Applied));
    let mut unused = Session::new(&state);
    let again = native_job_apply_with(&state, &plan.plan_id, &mut unused).await.unwrap();
    assert_eq!(again.operation_id, status.operation_id);
    assert_eq!(again.target, status.target);
    assert!(unused.calls.is_empty());
}

#[tokio::test]
async fn ob_creation_records_out_before_commit_and_verifies_nullable_native_zone() {
    for zone in [None, Some("zone1".to_string())] {
        for enabled in [false, true] {
            let (_dir, state, scope) = setup_engine("oceanbase-oracle").await;
            let mut input = definition();
            input.zone = zone.clone();
            input.enabled = enabled;
            let plan = preview(&state, &scope, input).await.unwrap();
            assert!(plan.target.is_none());
            assert!(plan.steps[0].sql.contains("zone =>"));
            let mut db = Session::new(&state);
            db.advanced_next_date = enabled;
            let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
            assert_eq!(status.outcome, NativeJobOperationOutcome::Verified);
            assert_eq!(db.calls, [("prepare".into(), None), ("commit".into(), Some(JOB_ID.into()))]);
            let mut unused = Session::new(&state);
            native_job_apply_with(&state, &plan.plan_id, &mut unused).await.unwrap();
            assert!(unused.calls.is_empty());
        }
    }
}

#[tokio::test]
async fn ob_wrong_zone_is_not_verified_and_cancellation_after_out_never_commits() {
    for canceled in [false, true] {
        let (_dir, state, scope) = setup_engine("oceanbase-oracle").await;
        let mut input = definition();
        input.zone = Some("zone1".into());
        let plan = preview(&state, &scope, input).await.unwrap();
        let mut db = Session::new(&state);
        db.wrong_zone = !canceled;
        db.cancel_after_prepare = canceled;
        let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
        assert_eq!(
            status.outcome,
            if canceled { NativeJobOperationOutcome::NotApplied } else { NativeJobOperationOutcome::Partial }
        );
        assert_eq!(db.calls[1].0, if canceled { "rollback" } else { "commit" });
    }
}

#[tokio::test]
async fn readonly_and_cancel_before_dispatch_do_not_submit_and_the_existing_unlock_remains_usable() {
    let (_dir, state, scope) = setup().await;
    let plan = preview(&state, &scope, definition()).await.unwrap();
    state.configs.write().await.get_mut("c").unwrap().read_only = true;
    let mut db = Session::new(&state);
    assert_eq!(
        native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap().outcome,
        NativeJobOperationOutcome::NotApplied
    );
    assert!(db.calls.is_empty());
    state.write_unlock_windows.unlock("c", 60).await.unwrap();
    let allowed = preview(&state, &scope, definition()).await.unwrap();
    assert_eq!(
        native_job_apply_with(&state, &allowed.plan_id, &mut db).await.unwrap().outcome,
        NativeJobOperationOutcome::Verified
    );
    let canceled = preview(&state, &scope, definition()).await.unwrap();
    native_job_cancel(&state, &canceled.operation_id);
    let mut unused = Session::new(&state);
    assert_eq!(
        native_job_apply_with(&state, &canceled.plan_id, &mut unused).await.unwrap().outcome,
        NativeJobOperationOutcome::NotApplied
    );
    assert!(unused.calls.is_empty());
}

#[tokio::test]
async fn cancellation_lifecycle_and_readonly_changes_after_out_trigger_owned_rollback_not_commit() {
    for reason in ["cancel", "lifecycle", "readonly"] {
        let (_dir, state, scope) = setup().await;
        let plan = preview(&state, &scope, definition()).await.unwrap();
        let mut db = Session::new(&state);
        db.cancel_after_prepare = reason == "cancel";
        db.invalidate_after_prepare = reason == "lifecycle";
        db.readonly_after_prepare = reason == "readonly";
        assert_eq!(
            native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap().outcome,
            NativeJobOperationOutcome::NotApplied
        );
        assert_eq!(db.calls, [("prepare".into(), None), ("rollback".into(), Some(JOB_ID.into()))]);
        assert_eq!(db.reads.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn lost_prepare_response_rolls_back_by_operation_id_and_does_not_guess_an_id() {
    for rollback in [NativeJobLegacyPhase::RolledBack, NativeJobLegacyPhase::Unknown] {
        let (_dir, state, scope) = setup().await;
        let plan = preview(&state, &scope, definition()).await.unwrap();
        let mut db = Session::new(&state);
        db.prepared.phase = NativeJobLegacyPhase::Unknown;
        db.prepared.job_id = None;
        db.rolled_back.phase = rollback;
        let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
        assert_eq!(
            status.outcome,
            if rollback == NativeJobLegacyPhase::RolledBack {
                NativeJobOperationOutcome::NotApplied
            } else {
                NativeJobOperationOutcome::Unknown
            }
        );
        assert!(status.target.is_none());
        assert_eq!(db.calls, [("prepare".into(), None), ("rollback".into(), None)]);
    }
}

#[tokio::test]
async fn absent_invalid_or_mismatched_out_receipts_cannot_authorize_commit() {
    for id in [None, Some("0"), Some("01"), Some("1e3"), Some("1 OR 1=1"), Some(JOB_ID)] {
        let (_dir, state, scope) = setup().await;
        let plan = preview(&state, &scope, definition()).await.unwrap();
        let mut db = Session::new(&state);
        db.prepared.job_id = id.map(str::to_string);
        db.wrong_operation = id == Some(JOB_ID);
        let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
        assert_eq!(status.outcome, NativeJobOperationOutcome::NotApplied);
        assert!(status.target.is_none());
        assert_eq!(db.calls, [("prepare".into(), None), ("rollback".into(), None)]);
    }
}

#[tokio::test]
async fn native_failure_keeps_safe_diagnostics_and_a_confirmed_rollback_is_not_repeated() {
    let (_dir, state, scope) = setup().await;
    let plan = preview(&state, &scope, definition()).await.unwrap();
    let mut db = Session::new(&state);
    db.prepared.phase = NativeJobLegacyPhase::RolledBack;
    db.prepared.vendor_code = Some(27486);
    db.prepared.reason = Some("private body and arguments".into());
    let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
    assert_eq!(status.outcome, NativeJobOperationOutcome::NotApplied);
    assert_eq!(status.steps[0].vendor_code, Some(27486));
    assert_eq!(status.steps[0].reason.as_deref(), Some("native_job_legacy_protocol_error"));
    assert_eq!(db.calls.len(), 1);
}

#[tokio::test]
async fn commit_response_loss_is_resolved_only_by_exact_id_readback_without_native_replay() {
    for visible in [true, false] {
        let (_dir, state, scope) = setup().await;
        let plan = preview(&state, &scope, definition()).await.unwrap();
        let mut db = Session::new(&state);
        db.committed.phase = NativeJobLegacyPhase::Unknown;
        db.committed.job_id = None;
        db.missing = !visible;
        let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
        assert_eq!(
            status.outcome,
            if visible { NativeJobOperationOutcome::Verified } else { NativeJobOperationOutcome::Unknown }
        );
        assert_eq!(db.calls, [("prepare".into(), None), ("commit".into(), Some(JOB_ID.into()))]);
        assert_eq!(db.reads.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn enabled_jobs_may_advance_next_date_but_definition_changes_are_not_hidden() {
    for (enabled, changed, expected) in [
        (true, false, NativeJobOperationOutcome::Verified),
        (false, false, NativeJobOperationOutcome::Partial),
        (true, true, NativeJobOperationOutcome::Partial),
    ] {
        let (_dir, state, scope) = setup().await;
        let mut definition = definition();
        definition.enabled = enabled;
        let plan = preview(&state, &scope, definition).await.unwrap();
        let mut db = Session::new(&state);
        db.advanced_next_date = true;
        db.changed = changed;
        assert_eq!(native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap().outcome, expected);
        assert_eq!(db.calls.len(), 2);
    }
}

#[tokio::test]
async fn interrupted_creation_remains_unknown_and_cannot_be_reapplied() {
    let (_dir, state, scope) = setup().await;
    let plan = preview(&state, &scope, definition()).await.unwrap();
    let mut db = Session::new(&state);
    let (entered, mut waiting) = tokio::sync::oneshot::channel();
    let (_release, blocked) = tokio::sync::oneshot::channel();
    db.prepare_entered = Some(entered);
    db.prepare_release = Some(blocked);
    let mut applying = Box::pin(native_job_apply_with(&state, &plan.plan_id, &mut db));
    tokio::select! { result = &mut applying => { panic!("native call unexpectedly completed: {}", result.is_ok()); }, _ = &mut waiting => {} }
    drop(applying);
    assert_eq!(native_job_status(&state, &plan.operation_id).outcome, NativeJobOperationOutcome::Unknown);
    let mut unused = Session::new(&state);
    assert_eq!(
        native_job_apply_with(&state, &plan.plan_id, &mut unused).await.unwrap().outcome,
        NativeJobOperationOutcome::Unknown
    );
    assert!(unused.calls.is_empty());
}

#[tokio::test]
async fn an_unconfirmed_cleanup_cannot_be_reported_as_verified_creation() {
    let (_dir, state, scope) = setup().await;
    let plan = preview(&state, &scope, definition()).await.unwrap();
    let mut db = Session::new(&state);
    db.fail_cleanup = true;
    let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
    assert_eq!(status.outcome, NativeJobOperationOutcome::Unknown);
    assert_eq!(status.reason.as_deref(), Some("native_job_session_cleanup_unknown"));
    assert_eq!(db.calls.len(), 2);
}

#[tokio::test]
async fn the_new_out_identity_remains_locked_through_physical_session_cleanup() {
    let (_dir, state, scope) = setup().await;
    let plan = preview(&state, &scope, definition()).await.unwrap();
    let mut creator = Session::new(&state);
    let (entered, mut closing) = tokio::sync::oneshot::channel();
    let (release, wait) = tokio::sync::oneshot::channel();
    creator.finish_entered = Some(entered);
    creator.finish_release = Some(wait);
    let mut creating = Box::pin(native_job_apply_with(&state, &plan.plan_id, &mut creator));
    tokio::select! { result = &mut creating => { panic!("cleanup unexpectedly completed: {}", result.is_ok()); }, _ = &mut closing => {} }
    let target = native_job_status(&state, &plan.operation_id).target.unwrap();
    let before = read_definition(&state, &target, &definition(), false, false, false).await;
    let update = native_job_prepare_with(
        &state,
        NativeJobMutation {
            target: target.clone(),
            baseline: before.snapshot.revision,
            change: NativeJobChange::Enable,
        },
        |target| {
            let state = state.clone();
            async move { Ok(read_definition(&state, &target, &definition(), false, false, false).await) }
        },
    )
    .await
    .unwrap();
    let mut editor = Session::new(&state);
    editor.definition = Some(definition());
    let reads = editor.reads.clone();
    let mut editing = Box::pin(native_job_apply_with(&state, &update.plan_id, &mut editor));
    let ready = std::future::poll_fn(|cx| {
        use std::future::Future;
        std::task::Poll::Ready(match editing.as_mut().poll(cx) {
            std::task::Poll::Ready(result) => Some(result),
            std::task::Poll::Pending => None,
        })
    })
    .await;
    let while_closing = reads.load(Ordering::SeqCst);
    release.send(()).unwrap();
    creating.await.unwrap();
    match ready {
        Some(result) => {
            result.unwrap();
        }
        None => {
            editing.await.unwrap();
        }
    }
    assert_eq!(while_closing, 0, "an edit must not pass a creation's unconfirmed cleanup");
}
