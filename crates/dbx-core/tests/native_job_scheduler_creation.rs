#![recursion_limit = "256"]

use dbx_core::connection::AppState;
use dbx_core::schema::native_jobs::*;
use dbx_sql::native_job_changes::{NativeJobSqlStep, NativeJobStepEffect};
use dbx_types::native_jobs::*;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

const CREATED_ID: &str = "900719925474099312345";

#[tokio::test]
async fn ob_non_microsecond_dates_reject_before_catalog_reads_or_plan_registration() {
    for named in [false, true] {
        for end in [false, true] {
            let (_dir, state, scope) = setup("oceanbase-oracle").await;
            let mut input = definition();
            input.attributes.clear();
            input.arguments.clear();
            input.start_date = Some("2032-01-01T23:54:25.123456000Z".into());
            input.end_date = Some("2032-01-02T00:04:25.987654000Z".into());
            if end {
                input.end_date = Some("2032-01-02T00:04:25.987654321Z".into());
            } else {
                input.start_date = Some("2032-01-01T23:54:25.123456789Z".into());
            }
            if named {
                input.program = Some(NativeJobObjectReference { owner: input.owner.clone(), name: "Program".into() });
                input.job_type = None;
                input.job_action = None;
                input.number_of_arguments = 0;
            }
            let result = native_job_prepare_request_with(
                &state,
                NativeJobRequest::Create {
                    scope: scope.clone(),
                    definition: NativeJobCreateDefinition::Scheduler(Box::new(input.clone())),
                },
                |_| std::future::ready(Err("unexpected_catalog_read")),
            )
            .await;
            assert_eq!(result.err(), Some("native_job_timestamp_precision_microseconds"));
            input.start_date = Some("2032-01-01T23:54:25.123456000Z".into());
            input.end_date = Some("2032-01-02T00:04:25.987654000Z".into());
            assert!(preview(&state, &scope, input, &Catalog::default()).await.is_ok());
        }
    }
}

#[tokio::test]
async fn event_creation_checks_null_condition_and_agent_and_preserves_generated_watcher_queues() {
    for (watcher, corrupt) in
        [(true, None), (true, Some("event-condition")), (false, Some("event-condition")), (false, Some("event-agent"))]
    {
        let (_dir, state, scope) = setup("oracle").await;
        let mut input = definition();
        input.event_source = Some(if watcher {
            NativeJobEventSource::FileWatcher {
                reference: NativeJobObjectReference { owner: "Owner".into(), name: "Watch.er".into() },
            }
        } else {
            NativeJobEventSource::Queue { owner: "Owner".into(), name: "Queue".into(), agent: None }
        });
        input.event_condition = None;
        let plan = preview(&state, &scope, input.clone(), &Catalog::default()).await.unwrap();
        let mut db = Session::new(&state, &input, &plan);
        db.native_watcher_queues = watcher;
        db.after_create = corrupt;
        let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
        assert_eq!(
            status.outcome,
            if corrupt.is_none() { NativeJobOperationOutcome::Verified } else { NativeJobOperationOutcome::Partial },
            "{watcher} {corrupt:?}"
        );
        assert_eq!(db.calls.iter().any(|step| step == "enable"), corrupt.is_none());
        if corrupt.is_some() {
            assert_eq!(db.calls, ["create"]);
        }
    }
}

async fn setup(engine: &str) -> (tempfile::TempDir, Arc<AppState>, NativeJobScope) {
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

fn definition() -> NativeJobSchedulerCreate {
    serde_json::from_value(json!({"owner":"Owner","name":"Job's, Exact","jobType":"STORED_PROCEDURE","jobAction":"private_proc","numberOfArguments":1,"enabled":true,"autoDrop":false,
        "attributes":[{"name":"JOB_PRIORITY","change":{"kind":"set","value":4}}],
        "arguments":[{"position":1,"dataType":"VARCHAR2","value":{"kind":"value","value":"private argument"}}]
    })).unwrap()
}

#[derive(Clone, Default)]
struct Catalog {
    row: Option<NativeJobRow>,
    arguments: Vec<NativeJobRow>,
    generation: String,
}

fn created(input: &NativeJobSchedulerCreate) -> Catalog {
    let mut row: NativeJobRow = serde_json::from_value(json!({"OWNER":input.owner,"JOB_NAME":input.name,"JOB_TYPE":input.job_type,"JOB_ACTION":input.job_action,"NUMBER_OF_ARGUMENTS":input.number_of_arguments,"ENABLED":false,"AUTO_DROP":input.auto_drop,"JOB_PRIORITY":3,"COMMENTS":input.comments})).unwrap();
    row.extend(serde_json::from_value::<NativeJobRow>(json!({"EVENT_CONDITION":null,"EVENT_QUEUE_OWNER":null,"EVENT_QUEUE_NAME":null,"EVENT_QUEUE_AGENT":null,"FILE_WATCHER_OWNER":null,"FILE_WATCHER_NAME":null,"NUMBER_OF_DESTINATIONS":null})).unwrap());
    if let Some(program) = &input.program {
        row.insert("PROGRAM_OWNER".into(), json!(program.owner));
        row.insert("PROGRAM_NAME".into(), json!(program.name));
    }
    if let Some(schedule) = &input.schedule {
        row.insert("SCHEDULE_OWNER".into(), json!(schedule.owner));
        row.insert("SCHEDULE_NAME".into(), json!(schedule.name));
    }
    if let Some(date) = &input.start_date {
        row.insert("START_DATE".into(), json!(date));
    }
    if let Some(date) = &input.end_date {
        row.insert("END_DATE".into(), json!(date));
    }
    if let Some(repeat) = &input.repeat_interval {
        row.insert("REPEAT_INTERVAL".into(), json!(repeat));
    }
    if let Some(source) = &input.event_source {
        row.extend(serde_json::from_value::<NativeJobRow>(json!({"EVENT_CONDITION":input.event_condition,"EVENT_QUEUE_OWNER":null,"EVENT_QUEUE_NAME":null,"EVENT_QUEUE_AGENT":null,"FILE_WATCHER_OWNER":null,"FILE_WATCHER_NAME":null,"NUMBER_OF_DESTINATIONS":null})).unwrap());
        match source {
            NativeJobEventSource::Queue { owner, name, agent } => {
                row.insert("EVENT_QUEUE_OWNER".into(), json!(owner));
                row.insert("EVENT_QUEUE_NAME".into(), json!(name));
                row.insert("EVENT_QUEUE_AGENT".into(), json!(agent));
            }
            NativeJobEventSource::FileWatcher { reference } => {
                row.insert("FILE_WATCHER_OWNER".into(), json!(reference.owner));
                row.insert("FILE_WATCHER_NAME".into(), json!(reference.name));
            }
        }
    }
    Catalog { row: Some(row), arguments: Vec::new(), generation: CREATED_ID.into() }
}

async fn read_catalog(state: &AppState, target: &NativeJobRef, catalog: &Catalog) -> NativeJobDetails {
    let catalog = catalog.clone();
    native_job_read_with(state, target, move |query| {
        let rows = if query.sql.contains("AS DBX_JOB_ID") {
            catalog
                .row
                .as_ref()
                .map(|_| {
                    NativeJobRow::from([
                        ("DBX_JOB_ID".into(), json!(catalog.generation)),
                        ("DBX_CREATED_AT".into(), json!("creation")),
                    ])
                })
                .into_iter()
                .collect::<Vec<_>>()
        } else if query.source.ends_with("SCHEDULER_JOBS") {
            catalog.row.clone().into_iter().collect()
        } else if query.source.ends_with("SCHEDULER_JOB_ARGS") {
            catalog.arguments.clone()
        } else {
            Vec::new()
        };
        // A real zero-row JDBC result still carries its projected columns. An empty column list
        // is an invalid response, not evidence that the selected native job is absent.
        let columns: Vec<String> = rows.first().map(|row| row.keys().cloned().collect()).unwrap_or_else(|| {
            if query.sql.contains("AS DBX_JOB_ID") {
                vec!["DBX_JOB_ID".into(), "DBX_CREATED_AT".into()]
            } else {
                vec!["OWNER".into(), "JOB_NAME".into()]
            }
        });
        let values: Vec<Vec<Value>> =
            rows.iter().map(|row| columns.iter().map(|key| row[key].clone()).collect()).collect();
        let raw = json!({"columns":columns,"rows":values,"affected_rows":0,"execution_time_ms":0});
        serde_json::from_value::<dbx_types::types::QueryResult>(raw.clone())
            .expect("database fixture must implement the real QueryResult wire schema");
        std::future::ready(Ok(raw))
    })
    .await
    .unwrap()
}

async fn preview(
    state: &AppState,
    scope: &NativeJobScope,
    input: NativeJobSchedulerCreate,
    catalog: &Catalog,
) -> Result<NativeJobPreparedPlan, &'static str> {
    native_job_prepare_request_with(
        state,
        NativeJobRequest::Create {
            scope: scope.clone(),
            definition: NativeJobCreateDefinition::Scheduler(Box::new(input)),
        },
        |target| async move { Ok(read_catalog(state, &target, catalog).await) },
    )
    .await
}

struct Session {
    state: Arc<AppState>,
    input: NativeJobSchedulerCreate,
    catalog: Catalog,
    calls: Vec<String>,
    sql: Vec<String>,
    operation_id: String,
    after_create: Option<&'static str>,
    unknown_step: Option<&'static str>,
    reject_step: Option<&'static str>,
    replace_at_read: usize,
    stop_at_read: Option<(usize, &'static str)>,
    wire_values: NativeJobRow,
    reads: usize,
    fail_cleanup: bool,
    read_events: Arc<AtomicUsize>,
    finish_entered: Option<tokio::sync::oneshot::Sender<Catalog>>,
    finish_release: Option<tokio::sync::oneshot::Receiver<()>>,
    native_watcher_queues: bool,
}

impl Session {
    fn new(state: &Arc<AppState>, input: &NativeJobSchedulerCreate, plan: &NativeJobPreparedPlan) -> Self {
        Self {
            state: state.clone(),
            input: input.clone(),
            catalog: Catalog::default(),
            calls: Vec::new(),
            sql: Vec::new(),
            operation_id: plan.operation_id.clone(),
            after_create: None,
            unknown_step: None,
            reject_step: None,
            replace_at_read: 0,
            stop_at_read: None,
            wire_values: NativeJobRow::new(),
            reads: 0,
            fail_cleanup: false,
            read_events: Arc::new(AtomicUsize::new(0)),
            finish_entered: None,
            finish_release: None,
            native_watcher_queues: false,
        }
    }
}

#[async_trait::async_trait]
impl NativeJobMutationSession for Session {
    async fn read(&mut self, target: &NativeJobRef) -> Result<NativeJobDetails, &'static str> {
        self.reads += 1;
        self.read_events.fetch_add(1, Ordering::SeqCst);
        if self.reads == self.replace_at_read {
            self.catalog.generation = "900719925474099312346".into();
        }
        let details = read_catalog(&self.state, target, &self.catalog).await;
        if let Some((at, reason)) = self.stop_at_read {
            if self.reads == at {
                if reason == "cancel" {
                    native_job_cancel(&self.state, &self.operation_id);
                } else {
                    self.state.configs.write().await.get_mut("c").unwrap().read_only = true;
                }
            }
        }
        Ok(details)
    }
    async fn execute(&mut self, step: &NativeJobSqlStep) -> NativeJobStepReceipt {
        self.calls.push(step.id.clone());
        self.sql.push(step.sql.clone());
        if self.reject_step == Some(step.id.as_str()) {
            return NativeJobStepReceipt {
                outcome: NativeJobDispatchOutcome::NotStarted,
                reason: Some("native_job_permission_denied".into()),
                vendor_code: Some(1031),
            };
        }
        match &step.effect {
            NativeJobStepEffect::Created => {
                self.catalog = created(&self.input);
                match self.after_create {
                    Some("cancel") => {
                        native_job_cancel(&self.state, &self.operation_id);
                    }
                    Some("readonly") => {
                        self.state.configs.write().await.get_mut("c").unwrap().read_only = true;
                    }
                    Some("changed") => {
                        self.catalog.row.as_mut().unwrap().insert("JOB_ACTION".into(), json!("external_proc"));
                    }
                    Some("offset") => {
                        self.catalog.row.as_mut().unwrap().insert("START_DATE".into(), json!("2030-01-01T02:20:30Z"));
                    }
                    Some("event-condition") => {
                        self.catalog
                            .row
                            .as_mut()
                            .unwrap()
                            .insert("EVENT_CONDITION".into(), json!("external condition"));
                    }
                    Some("event-agent") => {
                        self.catalog.row.as_mut().unwrap().insert("EVENT_QUEUE_AGENT".into(), json!("ExternalAgent"));
                    }
                    _ => {}
                }
            }
            NativeJobStepEffect::Fields(changes)
            | NativeJobStepEffect::SchedulerDefinition(
                dbx_sql::native_job_changes::NativeJobSchedulerDefinitionEffect { columns: changes, .. },
            ) => {
                for change in changes {
                    let value = match &change.change {
                        NativeJobFieldChange::Set { value } => value.clone(),
                        NativeJobFieldChange::Clear => Value::Null,
                        NativeJobFieldChange::Keep => continue,
                    };
                    let value = self.wire_values.get(&change.name).cloned().unwrap_or(value);
                    self.catalog.row.as_mut().unwrap().insert(change.name.clone(), value);
                }
            }
            NativeJobStepEffect::ArgumentValidated => {}
            NativeJobStepEffect::Argument(change, expected) => {
                let value = match &change.value {
                    NativeJobArgumentValue::Value { value } => value.clone(),
                    _ => Value::Null,
                };
                let mut row: NativeJobRow = serde_json::from_value(json!({"OWNER":self.input.owner,"JOB_NAME":self.input.name,"ARGUMENT_POSITION":change.position,"ARGUMENT_TYPE":"VARCHAR2","VALUE":value,"OUT_ARGUMENT":false,"DBX_ANYDATA_PRESENT":0})).unwrap();
                if let Some(expected) = expected {
                    let canonical = json!({"typeName":expected.scalar_type.fixed_name().unwrap_or("fixture-native-type"),"isNull":expected.value.is_none(),"value":expected.value});
                    row.insert("VALUE".into(), Value::Null);
                    row.insert("DBX_ANYDATA_PRESENT".into(), json!(1));
                    row.insert("DBX_ANYDATA_TYPE".into(), canonical["typeName"].clone());
                    row.insert("DBX_ANYDATA_CODEC".into(), json!(expected.scalar_type.token()));
                    row.insert("DBX_ANYDATA_CONSTRUCTOR_TYPE".into(), canonical["typeName"].clone());
                    row.insert("DBX_ANYDATA_IS_NULL".into(), canonical["isNull"].clone());
                    row.insert("DBX_ANYDATA_TEXT".into(), canonical["value"].clone());
                }
                self.catalog.arguments.push(row);
            }
            NativeJobStepEffect::Enabled(enabled) => {
                self.catalog.row.as_mut().unwrap().insert("ENABLED".into(), json!(enabled));
            }
            _ => panic!("unexpected scheduler creation step"),
        }
        if self.native_watcher_queues {
            self.catalog.row.as_mut().unwrap().insert("EVENT_QUEUE_OWNER".into(), json!("SYS"));
            self.catalog
                .row
                .as_mut()
                .unwrap()
                .insert("EVENT_QUEUE_NAME".into(), json!(format!("NATIVE_QUEUE_{}", self.calls.len())));
            self.catalog.row.as_mut().unwrap().insert("EVENT_QUEUE_AGENT".into(), json!("NATIVE_AGENT"));
        }
        NativeJobStepReceipt {
            outcome: if self.unknown_step == Some(step.id.as_str()) {
                NativeJobDispatchOutcome::Unknown
            } else {
                NativeJobDispatchOutcome::Applied
            },
            reason: None,
            vendor_code: None,
        }
    }
    async fn finish(&mut self) -> Result<(), &'static str> {
        if let Some(entered) = self.finish_entered.take() {
            entered.send(self.catalog.clone()).ok().unwrap();
        }
        if let Some(release) = self.finish_release.take() {
            release.await.unwrap();
        }
        if self.fail_cleanup {
            Err("unconfirmed native close")
        } else {
            Ok(())
        }
    }
}

#[tokio::test]
async fn scheduler_preview_uses_real_absence_and_preserves_named_target_without_writing() {
    let (_dir, state, scope) = setup("oracle").await;
    let input = definition();
    let plan = preview(&state, &scope, input.clone(), &Catalog::default()).await.unwrap();
    assert_eq!(
        plan.steps.iter().map(|step| step.id.as_str()).collect::<Vec<_>>(),
        ["create", "attributes", "argument:1", "enable"]
    );
    assert!(
        matches!(&plan.target, Some(NativeJobRef::Scheduler { owner, name, .. }) if owner == "Owner" && name == "Job's, Exact")
    );
    assert!(plan.steps[0].sql.contains("enabled => FALSE"));
    assert_eq!(
        preview(&state, &scope, input.clone(), &created(&input)).await.err(),
        Some("native_job_creation_target_not_absent")
    );
}

#[tokio::test]
async fn invalid_typed_character_input_is_not_allowed_to_create_a_partial_job() {
    let (_dir, state, scope) = setup("oracle").await;
    let mut input = definition();
    input.arguments[0].value = NativeJobArgumentValue::Value {
        value: json!({"$dbx":"oracle-anydata-v1","scalarType":"nvarchar2","value":"keep original creation draft"}),
    };
    let plan = preview(&state, &scope, input.clone(), &Catalog::default()).await.unwrap();
    assert_eq!(plan.steps[0].id, "validate-argument:1");
    let mut db = Session::new(&state, &input, &plan);
    db.reject_step = Some("validate-argument:1");
    let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
    assert_eq!(status.outcome, NativeJobOperationOutcome::NotApplied);
    assert_eq!(db.calls, ["validate-argument:1"]);
    assert!(db.catalog.row.is_none());
}

#[tokio::test]
async fn complete_configuration_and_native_generation_are_verified_before_activation_without_replay() {
    let (_dir, state, scope) = setup("oracle").await;
    let input = definition();
    let plan = preview(&state, &scope, input.clone(), &Catalog::default()).await.unwrap();
    let mut db = Session::new(&state, &input, &plan);
    let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
    assert_eq!(status.outcome, NativeJobOperationOutcome::Verified);
    assert_eq!(status.observed_identity.as_ref().unwrap()["DBX_JOB_ID"], json!(CREATED_ID));
    assert_eq!(db.calls, ["create", "attributes", "argument:1", "enable"]);
    assert!(status.steps.iter().all(|step| step.state == NativeJobStepState::Applied));
    let mut unused = Session::new(&state, &input, &plan);
    assert_eq!(
        native_job_apply_with(&state, &plan.plan_id, &mut unused).await.unwrap().operation_id,
        status.operation_id
    );
    assert!(unused.calls.is_empty());
    assert_eq!(unused.reads, 0);
}

#[tokio::test]
async fn unknown_create_receipt_does_not_adopt_or_activate_an_appearing_object() {
    let (_dir, state, scope) = setup("oracle").await;
    let input = definition();
    let plan = preview(&state, &scope, input.clone(), &Catalog::default()).await.unwrap();
    let mut db = Session::new(&state, &input, &plan);
    db.unknown_step = Some("create");
    let result = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
    assert_eq!(result.outcome, NativeJobOperationOutcome::Unknown);
    assert_eq!(result.reason.as_deref(), Some("native_job_creation_outcome_unknown"));
    assert_eq!(db.calls, ["create"]);
    assert_eq!(result.observed_identity.unwrap()["DBX_JOB_ID"], json!(CREATED_ID));
    assert_eq!(db.catalog.row.unwrap()["ENABLED"], json!(false));
}

#[tokio::test]
async fn cancellation_or_readonly_after_create_leaves_known_disabled_partial_configuration() {
    for reason in ["cancel", "readonly"] {
        let (_dir, state, scope) = setup("oracle").await;
        let input = definition();
        let plan = preview(&state, &scope, input.clone(), &Catalog::default()).await.unwrap();
        let mut db = Session::new(&state, &input, &plan);
        db.after_create = Some(reason);
        let result = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
        assert_eq!(result.outcome, NativeJobOperationOutcome::Partial);
        assert_eq!(db.calls, ["create"]);
        assert_eq!(db.catalog.row.unwrap()["ENABLED"], json!(false));
    }
}

#[tokio::test]
async fn cancellation_or_readonly_during_preflight_read_prevents_the_next_configuration_call() {
    for reason in ["cancel", "readonly"] {
        let (_dir, state, scope) = setup("oracle").await;
        let input = definition();
        let plan = preview(&state, &scope, input.clone(), &Catalog::default()).await.unwrap();
        let mut db = Session::new(&state, &input, &plan);
        // Read 1 confirms absence, 2 observes CREATE, and 3 checks before attributes.
        db.stop_at_read = Some((3, reason));
        let result = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
        assert_eq!(result.outcome, NativeJobOperationOutcome::Partial);
        assert_eq!(db.calls, ["create"], "{reason} must be rechecked after the awaited read");
        assert_eq!(result.steps[1].state, NativeJobStepState::Skipped);
        assert_eq!(db.catalog.row.unwrap()["ENABLED"], json!(false));
    }
}

#[tokio::test]
async fn native_numeric_interval_and_timestamp_wire_formats_do_not_make_applied_fields_partial() {
    check_native_field_values(None, NativeJobOperationOutcome::Verified).await;
    for (field, wrong) in [
        ("JOB_PRIORITY", "4.0001"),
        ("MAX_RUN_DURATION", "+000000000 01:02:03.400001"),
        ("END_DATE", "2031-01-01 10:20:30.000000 +00:00"),
    ] {
        check_native_field_values(Some((field, wrong)), NativeJobOperationOutcome::Partial).await;
    }
}

async fn check_native_field_values(wrong: Option<(&str, &str)>, outcome: NativeJobOperationOutcome) {
    let (_dir, state, scope) = setup("oracle").await;
    let input = definition();
    let mut catalog = created(&input);
    catalog.row.as_mut().unwrap().insert("END_DATE".into(), Value::Null);
    catalog.row.as_mut().unwrap().insert("MAX_RUN_DURATION".into(), Value::Null);
    let target = NativeJobRef::Scheduler { scope, owner: input.owner.clone(), name: input.name.clone() };
    let before = read_catalog(&state, &target, &catalog).await;
    let mutation = NativeJobMutation {
        target,
        baseline: before.snapshot.revision,
        change: NativeJobChange::Update {
            final_enabled: None,
            argument_target: None,
            attributes: serde_json::from_value(json!([
                {"name":"JOB_PRIORITY","change":{"kind":"set","value":4}},
                {"name":"MAX_RUN_DURATION","change":{"kind":"set","value":"0 01:02:03.4"}},
                {"name":"END_DATE","change":{"kind":"set","value":"2031-01-01T10:20:30+08:00"}}
            ]))
            .unwrap(),
            arguments: Vec::new(),
        },
    };
    let prepare_state = state.clone();
    let plan = native_job_prepare_with(&state, mutation, |target| async move {
        Ok(read_catalog(&prepare_state, &target, &catalog).await)
    })
    .await
    .unwrap();
    let mut db = Session::new(&state, &input, &plan);
    db.catalog = created(&input);
    db.catalog.row.as_mut().unwrap().insert("END_DATE".into(), Value::Null);
    db.catalog.row.as_mut().unwrap().insert("MAX_RUN_DURATION".into(), Value::Null);
    db.wire_values = serde_json::from_value(json!({
        "JOB_PRIORITY":"4.0000",
        "MAX_RUN_DURATION":"+000000000 01:02:03.400000",
        "END_DATE":"2031-01-01 02:20:30.000000 +00:00"
    }))
    .unwrap();
    if let Some((field, wrong)) = wrong {
        db.wire_values.insert(field.into(), json!(wrong));
    }
    let result = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
    assert_eq!(result.outcome, outcome, "wire override {wrong:?}");
    assert_eq!(db.calls, ["attributes"]);
}

#[tokio::test]
async fn changed_or_recreated_native_object_cannot_receive_the_remaining_configuration() {
    for change in ["definition", "generation"] {
        let (_dir, state, scope) = setup("oracle").await;
        let input = definition();
        let plan = preview(&state, &scope, input.clone(), &Catalog::default()).await.unwrap();
        let mut db = Session::new(&state, &input, &plan);
        if change == "definition" {
            db.after_create = Some("changed");
        } else {
            db.replace_at_read = 3;
        }
        let result = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
        assert_eq!(result.outcome, NativeJobOperationOutcome::Partial);
        assert_eq!(db.calls, ["create"]);
        assert_eq!(db.catalog.row.unwrap()["ENABLED"], json!(false));
    }
}

#[tokio::test]
async fn an_existing_object_at_apply_is_not_overwritten_and_rejected_create_is_not_partial() {
    let (_dir, state, scope) = setup("oracle").await;
    let input = definition();
    let plan = preview(&state, &scope, input.clone(), &Catalog::default()).await.unwrap();
    let mut db = Session::new(&state, &input, &plan);
    db.catalog = created(&input);
    assert_eq!(
        native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap().outcome,
        NativeJobOperationOutcome::NotApplied
    );
    assert!(db.calls.is_empty());
    let plan = preview(&state, &scope, input.clone(), &Catalog::default()).await.unwrap();
    let mut db = Session::new(&state, &input, &plan);
    db.reject_step = Some("create");
    let result = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
    assert_eq!(result.outcome, NativeJobOperationOutcome::NotApplied);
    assert_eq!(result.steps[0].vendor_code, Some(1031));
    assert!(db.catalog.row.is_none());
}

#[tokio::test]
async fn a_lost_configuration_receipt_can_be_resolved_by_exact_generation_and_field_readback() {
    let (_dir, state, scope) = setup("oracle").await;
    let input = definition();
    let plan = preview(&state, &scope, input.clone(), &Catalog::default()).await.unwrap();
    let mut db = Session::new(&state, &input, &plan);
    db.unknown_step = Some("attributes");
    assert_eq!(
        native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap().outcome,
        NativeJobOperationOutcome::Verified
    );
    assert_eq!(db.calls, ["create", "attributes", "argument:1", "enable"]);
}

#[tokio::test]
async fn disabled_creation_keeps_explicit_time_zone_and_does_not_require_activation() {
    let (_dir, state, scope) = setup("oracle").await;
    let mut input = definition();
    input.enabled = false;
    input.attributes.clear();
    input.arguments.clear();
    input.start_date = Some("2030-01-01T10:20:30+08:00".into());
    let plan = preview(&state, &scope, input.clone(), &Catalog::default()).await.unwrap();
    let mut db = Session::new(&state, &input, &plan);
    db.after_create = Some("offset");
    assert_eq!(
        native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap().outcome,
        NativeJobOperationOutcome::Verified
    );
    assert_eq!(db.calls, ["create"]);
}

#[tokio::test]
async fn ob_creation_uses_its_actual_literal_namespace_and_binds_the_returned_generation_only() {
    let (_dir, state, scope) = setup("oceanbase-oracle").await;
    let mut input = definition();
    input.attributes.clear();
    input.arguments.clear();
    let plan = preview(&state, &scope, input.clone(), &Catalog::default()).await.unwrap();
    let mut db = Session::new(&state, &input, &plan);
    assert_eq!(
        native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap().outcome,
        NativeJobOperationOutcome::Verified
    );
    assert!(db.sql[0].contains("number_of_argument => 1"));
    assert!(db.sql[1].contains(&format!("JOB = {CREATED_ID}")));
    assert!(!db.sql[1].contains(":dbx_created_job_id"));
    input.owner = "AnotherOwner".into();
    assert_eq!(
        preview(&state, &scope, input, &Catalog::default()).await.err(),
        Some("native_job_create_owner_mapping_unverified")
    );
}

#[tokio::test]
async fn failed_final_activation_and_unknown_cleanup_do_not_repeat_creation_or_business_execution() {
    for failure in ["enable", "cleanup"] {
        let (_dir, state, scope) = setup("oracle").await;
        let input = definition();
        let plan = preview(&state, &scope, input.clone(), &Catalog::default()).await.unwrap();
        let mut db = Session::new(&state, &input, &plan);
        if failure == "enable" {
            db.reject_step = Some("enable");
        } else {
            db.fail_cleanup = true;
        }
        let result = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
        assert_eq!(
            result.outcome,
            if failure == "enable" { NativeJobOperationOutcome::Partial } else { NativeJobOperationOutcome::Unknown }
        );
        assert_eq!(db.calls.iter().filter(|id| *id == "create").count(), 1);
        assert!(!db.sql.iter().any(|sql| sql.contains("RUN_JOB") || sql.contains("DROP_JOB")));
        if failure == "enable" {
            assert_eq!(db.catalog.row.unwrap()["ENABLED"], json!(false));
        }
    }
}

#[tokio::test]
async fn name_scoped_creation_lock_covers_the_new_generation_and_physical_cleanup() {
    let (_dir, state, scope) = setup("oracle").await;
    let input = definition();
    let plan = preview(&state, &scope, input.clone(), &Catalog::default()).await.unwrap();
    let target = plan.target.clone().unwrap();
    let (entered, when_finishing) = tokio::sync::oneshot::channel();
    let (release, after_finish) = tokio::sync::oneshot::channel();
    let mut db = Session::new(&state, &input, &plan);
    db.finish_entered = Some(entered);
    db.finish_release = Some(after_finish);
    let creating_state = state.clone();
    let creation =
        tokio::spawn(async move { native_job_apply_with(&creating_state, &plan.plan_id, &mut db).await.unwrap() });
    let catalog = when_finishing.await.unwrap();
    let current = read_catalog(&state, &target, &catalog).await;
    let mutation = NativeJobMutation {
        target: target.clone(),
        baseline: current.snapshot.revision.clone(),
        change: NativeJobChange::Disable,
    };
    let prepare_state = state.clone();
    let prepare_catalog = catalog.clone();
    let following = native_job_prepare_with(&state, mutation, |target| async move {
        Ok(read_catalog(&prepare_state, &target, &prepare_catalog).await)
    })
    .await
    .unwrap();
    let mut db = Session::new(&state, &input, &following);
    db.catalog = catalog;
    let reads = db.read_events.clone();
    let (started, is_started) = tokio::sync::oneshot::channel();
    let following_state = state.clone();
    let disabling = tokio::spawn(async move {
        started.send(()).unwrap();
        native_job_apply_with(&following_state, &following.plan_id, &mut db).await.unwrap()
    });
    is_started.await.unwrap();
    tokio::task::yield_now().await;
    assert_eq!(
        reads.load(Ordering::SeqCst),
        0,
        "the new ID must not get a different lock while creation is cleaning up"
    );
    release.send(()).unwrap();
    assert_eq!(creation.await.unwrap().outcome, NativeJobOperationOutcome::Verified);
    assert_eq!(disabling.await.unwrap().outcome, NativeJobOperationOutcome::Verified);
    assert!(reads.load(Ordering::SeqCst) > 0);
}
