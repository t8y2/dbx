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

#[derive(Clone)]
struct Catalog {
    definition: NativeJobRow,
    args: Vec<NativeJobRow>,
    count: usize,
    metadata_position: Option<usize>,
    reference_changed: bool,
    extra_references: Vec<(NativeJobReferenceKind, NativeJobMetadata<Vec<NativeJobRow>>)>,
    first_type: &'static str,
}

impl Catalog {
    fn new() -> Self {
        let mut catalog = Self { definition: serde_json::from_value(json!({"OWNER":"Owner","JOB_NAME":"Job","PROGRAM_OWNER":"Owner","PROGRAM_NAME":"P1","JOB_TYPE":null,"JOB_ACTION":null,"NUMBER_OF_ARGUMENTS":null,"ENABLED":true,"COMMENTS":"keep","AUTO_DROP":false,"SCHEDULE_OWNER":null,"SCHEDULE_NAME":null,"SCHEDULE_TYPE":"CALENDAR","REPEAT_INTERVAL":"FREQ=DAILY","START_DATE":"2030-01-01T00:00:00+08:00","END_DATE":null,"JOB_STYLE":"REGULAR"})).unwrap(), args: vec![argument(1, "old"), argument(2, "retained")], count: 2, metadata_position: None, reference_changed: false, extra_references: Vec::new(), first_type: "VARCHAR2" };
        catalog.definition.extend(serde_json::from_value::<NativeJobRow>(json!({"FLAGS":0,"EVENT_RULE":null,"NUMBER_OF_DESTINATIONS":null,"EVENT_CONDITION":null,"EVENT_QUEUE_OWNER":null,"EVENT_QUEUE_NAME":null,"EVENT_QUEUE_AGENT":null,"FILE_WATCHER_OWNER":null,"FILE_WATCHER_NAME":null,"DESTINATION_OWNER":null,"DESTINATION":null})).unwrap());
        catalog
    }
    fn program(&self, name: &str) -> NativeJobRow {
        serde_json::from_value(json!({"DBX_OWNER":"Owner","DBX_NAME":name,"PROGRAM_NAME":name,"PROGRAM_TYPE":"STORED_PROCEDURE","PROGRAM_ACTION":if self.reference_changed && name == "P2" { "external_proc" } else { "proc" },"NUMBER_OF_ARGUMENTS":if name == "P1" { 2 } else { self.count },"ENABLED":true})).unwrap()
    }
    fn program_args(&self, name: &str) -> Vec<NativeJobRow> {
        (1..=if name == "P1" { 2 } else { self.count }).map(|position| serde_json::from_value(json!({"DBX_OWNER":"Owner","DBX_NAME":name,"PROGRAM_NAME":name,"ARGUMENT_POSITION":position,"ARGUMENT_NAME":format!("{name}_{position}"),"ARGUMENT_TYPE":if position == 1 { self.first_type } else { "VARCHAR2" },"DBX_ANYDATA_PRESENT":0,"DEFAULT_VALUE":"default","METADATA_ATTRIBUTE":if name == "P2" && self.metadata_position == Some(position) { json!("EVENT_MESSAGE") } else { Value::Null },"OUT_ARGUMENT":false})).unwrap()).collect()
    }
}

fn argument(position: usize, value: &str) -> NativeJobRow {
    serde_json::from_value(json!({"OWNER":"Owner","JOB_NAME":"Job","ARGUMENT_POSITION":position,"ARGUMENT_NAME":format!("old_{position}"),"ARGUMENT_TYPE":"VARCHAR2","DBX_ANYDATA_PRESENT":0,"VALUE":value,"OUT_ARGUMENT":false,"DBX_ANYDATA_TYPE":null,"DBX_ANYDATA_IS_NULL":null})).unwrap()
}

fn result(rows: Vec<NativeJobRow>) -> Value {
    let columns: Vec<_> = if rows.is_empty() {
        vec!["OWNER".into(), "JOB_NAME".into()]
    } else {
        rows.iter().flat_map(|row| row.keys().cloned()).collect::<std::collections::BTreeSet<_>>().into_iter().collect()
    };
    let values: Vec<Vec<Value>> = rows
        .iter()
        .map(|row| columns.iter().map(|key| row.get(key).cloned().unwrap_or(Value::Null)).collect())
        .collect();
    json!({"columns":columns,"rows":values,"affected_rows":0,"execution_time_ms":0})
}

async fn read(state: &AppState, target: &NativeJobRef, catalog: &Catalog) -> NativeJobDetails {
    native_job_read_with(state, target, |query| {
        let name = if query.sql.contains("'P2'") { "P2" } else { "P1" };
        let rows = if query.sql.contains("AS DBX_JOB_ID") {
            vec![serde_json::from_value(json!({"DBX_JOB_ID":"42","DBX_CREATED_AT":"creation"})).unwrap()]
        } else if query.source.ends_with("SCHEDULER_PROGRAM_ARGS") {
            catalog.program_args(name)
        } else if query.source.ends_with("SCHEDULER_PROGRAMS") {
            vec![catalog.program(name)]
        } else if query.source.ends_with("SCHEDULER_JOB_ARGS") {
            catalog.args.clone()
        } else if query.source.ends_with("SCHEDULER_JOBS") {
            vec![catalog.definition.clone()]
        } else {
            vec![]
        };
        std::future::ready(Ok(result(rows)))
    })
    .await
    .unwrap()
}

fn references(catalog: &Catalog, request: &NativeJobReferenceListRequest) -> NativeJobReferenceCatalog {
    let name = request.name.as_deref().unwrap();
    let objects = if let Some((_, value)) = catalog.extra_references.iter().find(|(kind, _)| *kind == request.kind) {
        value.clone()
    } else if request.kind == NativeJobReferenceKind::ProgramArguments {
        NativeJobMetadata::Available { value: catalog.program_args(name) }
    } else {
        assert_eq!(request.kind, NativeJobReferenceKind::Program);
        NativeJobMetadata::Available { value: vec![catalog.program(name)] }
    };
    NativeJobReferenceCatalog {
        objects,
        source: NativeJobCatalogSource {
            source: Some("fixture".into()),
            coverage: Some(NativeJobCatalogCoverage::Accessible),
        },
        offset: 0,
        limit: request.limit,
    }
}

async fn setup() -> (tempfile::TempDir, Arc<AppState>, NativeJobRef) {
    setup_for("oracle").await
}

async fn setup_for(engine: &str) -> (tempfile::TempDir, Arc<AppState>, NativeJobRef) {
    let dir = tempfile::tempdir().unwrap();
    let storage = dbx_core::persistence::test_storage::open(&dir.path().join("state.db")).await.unwrap();
    let state = Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
        storage,
        dir.path().join("plugins"),
        dir.path().join("agents"),
        "0.0.0",
    ));
    state.configs.write().await.insert("c".into(), serde_json::from_value(json!({"id":"c","name":"test","db_type":engine,"host":"127.0.0.1","port":1,"username":"Owner","password":""})).unwrap());
    let context = native_job_open_context_with(&state, "c", "", |_| {
        std::future::ready(Ok(NativeJobRuntimeIdentity { database_info: None, session_user: "Owner".into() }))
    })
    .await
    .unwrap();
    (dir, state, NativeJobRef::Scheduler { scope: context.scope, owner: "Owner".into(), name: "Job".into() })
}

fn mutation(initial: &NativeJobDetails, count: usize) -> NativeJobMutation {
    serde_json::from_value(json!({"action":"update","target":initial.snapshot.job_ref,"baseline":initial.snapshot.revision,"finalEnabled":true,"attributes":[{"name":"PROGRAM_NAME","change":{"kind":"set","value":{"owner":"Owner","name":"P2"}}}],"arguments":[],"argumentTarget":{"program":{"owner":"Owner","name":"P2"},"arguments":(1..=count).map(|position| json!({"position":position,"dataType":"VARCHAR2","value":if position==1 { json!({"kind":"value","value":"new"}) } else { json!({"kind":"inherit"}) }})).collect::<Vec<_>>()}})).unwrap()
}

async fn prepare(state: &AppState, target: &NativeJobRef, catalog: &Catalog) -> NativeJobPreparedPlan {
    let initial = read(state, target, catalog).await;
    native_job_prepare_with_references(
        state,
        mutation(&initial, catalog.count),
        |target| async move { Ok(read(state, &target, catalog).await) },
        |request| std::future::ready(Ok(references(catalog, &request))),
    )
    .await
    .unwrap()
}

struct Session {
    state: Arc<AppState>,
    catalog: Catalog,
    clear_native: bool,
    calls: Vec<String>,
    operation: String,
    cancel_after: Option<&'static str>,
    reject: Option<&'static str>,
    unknown: Option<&'static str>,
    poison: Option<&'static str>,
    changed_reference_at_end: bool,
    dependency_reads: usize,
    finish_calls: Arc<AtomicUsize>,
    after_definition: NativeJobRow,
    member_change_at: Option<usize>,
    reverse_members: bool,
}

impl Session {
    fn new(state: &Arc<AppState>, catalog: Catalog, plan: &NativeJobPreparedPlan) -> Self {
        Self {
            state: state.clone(),
            catalog,
            clear_native: false,
            calls: vec![],
            operation: plan.operation_id.clone(),
            cancel_after: None,
            reject: None,
            unknown: None,
            poison: None,
            changed_reference_at_end: false,
            dependency_reads: 0,
            finish_calls: Arc::new(AtomicUsize::new(0)),
            after_definition: NativeJobRow::new(),
            member_change_at: None,
            reverse_members: false,
        }
    }
}

#[async_trait::async_trait]
impl NativeJobMutationSession for Session {
    async fn read(&mut self, target: &NativeJobRef) -> Result<NativeJobDetails, &'static str> {
        Ok(read(&self.state, target, &self.catalog).await)
    }
    async fn read_reference(
        &mut self,
        request: NativeJobReferenceListRequest,
    ) -> Result<NativeJobReferenceCatalog, &'static str> {
        self.dependency_reads += 1;
        let mut catalog = self.catalog.clone();
        if self.changed_reference_at_end && self.dependency_reads > 2 {
            catalog.reference_changed = true;
        }
        let mut reference = references(&catalog, &request);
        if request.kind == NativeJobReferenceKind::DestinationGroupMembers {
            if let NativeJobMetadata::Available { value } = &mut reference.objects {
                if self.member_change_at.is_some_and(|at| self.dependency_reads >= at) {
                    value[0].insert("MEMBER_NAME".into(), json!("OtherCredential@Database.1"));
                }
                if self.reverse_members {
                    value.reverse();
                }
            }
        }
        Ok(reference)
    }
    async fn execute(&mut self, step: &NativeJobSqlStep) -> NativeJobStepReceipt {
        self.calls.push(step.id.clone());
        if self.reject == Some(step.id.as_str()) {
            return NativeJobStepReceipt {
                outcome: NativeJobDispatchOutcome::NotStarted,
                reason: Some("native denied".into()),
                vendor_code: Some(1031),
            };
        }
        match &step.effect {
            NativeJobStepEffect::ArgumentValidated => {}
            NativeJobStepEffect::Enabled(enabled) => {
                self.catalog.definition.insert("ENABLED".into(), json!(enabled));
            }
            NativeJobStepEffect::SchedulerDefinition(effect) => {
                for column in &effect.columns {
                    self.catalog.definition.insert(
                        column.name.clone(),
                        match &column.change {
                            NativeJobFieldChange::Set { value } => value.clone(),
                            _ => Value::Null,
                        },
                    );
                }
                if self.clear_native {
                    self.catalog.args.clear();
                }
                if self.poison == Some("definition") {
                    self.catalog.args = vec![argument(1, "external")];
                }
                if self.poison == Some("untouched") {
                    self.catalog.definition.insert("COMMENTS".into(), json!("external"));
                }
                self.catalog.definition.extend(self.after_definition.clone());
            }
            NativeJobStepEffect::Argument(change, expected) => {
                self.catalog.args.retain(|row| row["ARGUMENT_POSITION"] != json!(change.position));
                if let Some(expected) = expected {
                    let mut row = argument(change.position, "");
                    row.insert("VALUE".into(), Value::Null);
                    let canonical = json!({"typeName":expected.scalar_type.fixed_name().unwrap_or("fixture-native-type"),"isNull":expected.value.is_none(),"value":expected.value});
                    row.insert("DBX_ANYDATA_PRESENT".into(), json!(1));
                    row.insert("DBX_ANYDATA_CODEC".into(), json!(expected.scalar_type.token()));
                    row.insert("DBX_ANYDATA_CONSTRUCTOR_TYPE".into(), canonical["typeName"].clone());
                    row.insert(
                        "DBX_ANYDATA_TYPE".into(),
                        if self.poison == Some("wrong-null-type") {
                            json!("SYS.NUMBER")
                        } else {
                            canonical["typeName"].clone()
                        },
                    );
                    row.insert(
                        "DBX_ANYDATA_IS_NULL".into(),
                        if self.poison == Some("null-evidence") { Value::Null } else { canonical["isNull"].clone() },
                    );
                    row.insert("DBX_ANYDATA_TEXT".into(), canonical["value"].clone());
                    if self.poison == Some("number-rounding") {
                        row.insert("DBX_ANYDATA_TEXT".into(), json!("9007199254740992"));
                    }
                    if self.poison.is_none() {
                        assert!(
                            expected.matches(&dbx_sql::native_job_arguments::decode_argument(&row, false)),
                            "database fixture projection must represent the setter type: {:?}",
                            expected.scalar_type
                        );
                    }
                    self.catalog.args.push(row);
                } else if let NativeJobArgumentValue::Value { value } = &change.value {
                    self.catalog.args.push(argument(change.position, value.as_str().unwrap()));
                }
            }
            _ => panic!("unexpected transition step"),
        }
        if self.poison == Some("generated") {
            self.catalog.definition.insert("FLAGS".into(), json!(self.calls.len()));
            self.catalog.definition.insert("EVENT_RULE".into(), json!(format!("native-rule:{}", self.calls.len())));
            self.catalog.definition.insert("NUMBER_OF_DESTINATIONS".into(), json!(self.calls.len().to_string()));
        }
        if self.poison == Some("watcher-queue") && !self.catalog.definition["FILE_WATCHER_NAME"].is_null() {
            self.catalog.definition.insert("EVENT_QUEUE_OWNER".into(), json!("SYS"));
            self.catalog
                .definition
                .insert("EVENT_QUEUE_NAME".into(), json!(format!("NATIVE_QUEUE_{}", self.calls.len())));
            self.catalog.definition.insert("EVENT_QUEUE_AGENT".into(), json!("NATIVE_AGENT"));
        }
        if self.poison == Some("missing-count") {
            self.catalog.definition.remove("NUMBER_OF_DESTINATIONS");
        }
        if self.cancel_after == Some(step.id.as_str()) {
            native_job_cancel(&self.state, &self.operation);
        }
        NativeJobStepReceipt {
            outcome: if self.unknown == Some(step.id.as_str()) {
                NativeJobDispatchOutcome::Unknown
            } else {
                NativeJobDispatchOutcome::Applied
            },
            reason: None,
            vendor_code: None,
        }
    }
    async fn finish(&mut self) -> Result<(), &'static str> {
        self.finish_calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

#[tokio::test]
async fn dameng_program_effective_definition_allows_only_its_own_mirror_changes() {
    for changed in ["JOB_ACTION", "SCHEDULE_TYPE", "COMMENTS"] {
        let (_dir, state, target) = setup_for("dameng").await;
        let catalog = Catalog::new();
        let plan = prepare(&state, &target, &catalog).await;
        assert!(!plan.steps.iter().any(|step| step.id == "argument:2"));
        let mut db = Session::new(&state, catalog, &plan);
        db.clear_native = true;
        db.after_definition.insert(changed.into(), json!("native mirror"));
        let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
        assert_eq!(
            status.outcome,
            if changed == "JOB_ACTION" {
                NativeJobOperationOutcome::Verified
            } else {
                NativeJobOperationOutcome::Partial
            },
            "{changed}"
        );
        assert_eq!(db.calls.iter().any(|id| id == "enable"), changed == "JOB_ACTION");
    }
}

#[tokio::test]
async fn dameng_schedule_projection_does_not_relax_program_or_activation_checks() {
    for changed in ["SCHEDULE_TYPE", "JOB_ACTION", "ENABLED"] {
        let (_dir, state, target) = setup_for("dameng").await;
        let mut catalog = Catalog::new();
        catalog.definition.insert("SCHEDULE_OWNER".into(), json!("Owner"));
        catalog.definition.insert("SCHEDULE_NAME".into(), json!("S1"));
        catalog.extra_references.push((NativeJobReferenceKind::Schedule, NativeJobMetadata::Available {
            value: vec![serde_json::from_value(json!({"DBX_OWNER":"Owner","DBX_NAME":"S2","SCHEDULE_TYPE":"ONCE","START_DATE":"2031-01-01","REPEAT_INTERVAL":null,"END_DATE":null})).unwrap()],
        }));
        let initial = read(&state, &target, &catalog).await;
        let mutation = serde_json::from_value(json!({"action":"update","target":target,"baseline":initial.snapshot.revision,"finalEnabled":true,"attributes":[{"name":"SCHEDULE_NAME","change":{"kind":"set","value":{"owner":"Owner","name":"S2"}}}],"arguments":[]})).unwrap();
        let plan = native_job_prepare_with_references(
            &state,
            mutation,
            |target| {
                let catalog = &catalog;
                let state = &state;
                async move { Ok(read(state, &target, catalog).await) }
            },
            |request| std::future::ready(Ok(references(&catalog, &request))),
        )
        .await
        .unwrap();
        let mut db = Session::new(&state, catalog, &plan);
        db.after_definition
            .insert(changed.into(), if changed == "ENABLED" { json!(true) } else { json!("native mirror") });
        let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
        assert_eq!(
            status.outcome,
            if changed == "SCHEDULE_TYPE" {
                NativeJobOperationOutcome::Verified
            } else {
                NativeJobOperationOutcome::Partial
            },
            "{changed}"
        );
    }
}

#[tokio::test]
async fn dameng_two_slot_plan_does_not_activate_the_second_projection_early() {
    let (_dir, state, target) = setup_for("dameng").await;
    let mut catalog = Catalog::new();
    catalog.definition.insert("SCHEDULE_OWNER".into(), json!("Owner"));
    catalog.definition.insert("SCHEDULE_NAME".into(), json!("S1"));
    catalog.extra_references.push((NativeJobReferenceKind::Schedule, NativeJobMetadata::Available {
        value: vec![serde_json::from_value(json!({"DBX_OWNER":"Owner","DBX_NAME":"S2","SCHEDULE_TYPE":"ONCE","START_DATE":"2031-01-01","REPEAT_INTERVAL":null,"END_DATE":null})).unwrap()],
    }));
    let initial = read(&state, &target, &catalog).await;
    let mut mutation = mutation(&initial, catalog.count);
    let NativeJobChange::Update { attributes, .. } = &mut mutation.change else { unreachable!() };
    attributes.push(NativeJobAttributeChange {
        name: "SCHEDULE_NAME".into(),
        change: NativeJobFieldChange::Set { value: json!({"owner":"Owner","name":"S2"}) },
    });
    let plan = native_job_prepare_with_references(
        &state,
        mutation,
        |target| {
            let catalog = &catalog;
            let state = &state;
            async move { Ok(read(state, &target, catalog).await) }
        },
        |request| std::future::ready(Ok(references(&catalog, &request))),
    )
    .await
    .unwrap();
    let mut db = Session::new(&state, catalog, &plan);
    db.clear_native = true;
    db.after_definition.insert("SCHEDULE_TYPE".into(), json!("changed before schedule setter"));
    let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
    assert_eq!(status.outcome, NativeJobOperationOutcome::Partial);
    assert!(!db.calls.iter().any(|id| id == "enable" || id == "attribute:SCHEDULE_NAME"));
}

#[tokio::test]
async fn dameng_inherit_residual_stops_immediately_after_the_program_setter() {
    let (_dir, state, target) = setup_for("dameng").await;
    let catalog = Catalog::new();
    let plan = prepare(&state, &target, &catalog).await;
    let mut db = Session::new(&state, catalog, &plan);
    let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
    assert_eq!(status.outcome, NativeJobOperationOutcome::Partial);
    assert!(!db.calls.iter().any(|id| id.starts_with("argument:") || id == "enable"));
    assert_eq!(db.catalog.definition["PROGRAM_NAME"], json!("P2"));
    assert_eq!(db.catalog.definition["ENABLED"], json!(false));
}

#[tokio::test]
async fn native_clear_and_native_preserve_both_reconcile_the_full_target_before_enabling() {
    for clear_native in [false, true] {
        let (_dir, state, target) = setup().await;
        let catalog = Catalog::new();
        let plan = prepare(&state, &target, &catalog).await;
        let mut db = Session::new(&state, catalog, &plan);
        db.clear_native = clear_native;
        let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
        assert_eq!(status.outcome, NativeJobOperationOutcome::Verified);
        assert_eq!(db.calls.last().map(String::as_str), Some("enable"));
        assert_eq!(db.catalog.args.len(), 1);
        assert_eq!(db.catalog.args[0]["VALUE"], json!("new"));
        assert_eq!(db.calls.iter().any(|id| id == "argument:2"), !clear_native);
        assert_eq!(db.finish_calls.load(Ordering::SeqCst), 1);
        let calls = db.calls.len();
        native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
        assert_eq!(db.calls.len(), calls);
    }
}

#[tokio::test]
async fn a_reduced_count_retires_old_positions_while_the_old_program_is_still_active() {
    let (_dir, state, target) = setup().await;
    let mut catalog = Catalog::new();
    catalog.count = 1;
    let plan = prepare(&state, &target, &catalog).await;
    assert_eq!(plan.steps[1].id, "retire-argument:2");
    let mut db = Session::new(&state, catalog, &plan);
    assert_eq!(
        native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap().outcome,
        NativeJobOperationOutcome::Verified
    );
    let retiring = db.calls.iter().position(|id| id == "retire-argument:2").unwrap();
    let definition = db.calls.iter().position(|id| id == "attributes").unwrap();
    assert!(retiring < definition);
}

#[tokio::test]
async fn cancellation_rejection_and_conflicting_readback_never_enable_a_partial_conversion() {
    for failure in ["cancel", "reject", "definition", "untouched"] {
        let (_dir, state, target) = setup().await;
        let catalog = Catalog::new();
        let plan = prepare(&state, &target, &catalog).await;
        let mut db = Session::new(&state, catalog, &plan);
        match failure {
            "cancel" => db.cancel_after = Some("attributes"),
            "reject" => db.reject = Some("argument:1"),
            _ => db.poison = Some(failure),
        }
        let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
        assert_eq!(status.outcome, NativeJobOperationOutcome::Partial, "{failure}");
        assert!(!db.calls.iter().any(|id| id == "enable"));
        assert_eq!(db.catalog.definition["ENABLED"], json!(false));
    }
}

#[tokio::test]
async fn changed_target_metadata_fails_before_dispatch_or_final_activation() {
    for at_end in [false, true] {
        let (_dir, state, target) = setup().await;
        let catalog = Catalog::new();
        let plan = prepare(&state, &target, &catalog).await;
        let mut db = Session::new(&state, catalog, &plan);
        if at_end {
            db.changed_reference_at_end = true;
        } else {
            db.catalog.reference_changed = true;
        }
        let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
        assert_eq!(
            status.outcome,
            if at_end { NativeJobOperationOutcome::Partial } else { NativeJobOperationOutcome::NotApplied }
        );
        assert!(!db.calls.iter().any(|id| id == "enable"));
        if !at_end {
            assert!(db.calls.is_empty());
        }
    }
}

#[tokio::test]
async fn a_verified_lost_definition_receipt_is_not_resent_and_new_preview_only_reconciles_remaining_values() {
    let (_dir, state, target) = setup().await;
    let catalog = Catalog::new();
    let plan = prepare(&state, &target, &catalog).await;
    let mut db = Session::new(&state, catalog, &plan);
    db.unknown = Some("attributes");
    db.cancel_after = Some("attributes");
    assert_eq!(
        native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap().outcome,
        NativeJobOperationOutcome::Partial
    );
    let original = read(&state, &target, &db.catalog).await;
    let mut next = mutation(&original, 2);
    if let NativeJobChange::Update { attributes, .. } = &mut next.change {
        attributes.clear();
    }
    let state_ref = state.as_ref();
    let catalog_ref = &db.catalog;
    let repaired = native_job_prepare_with_references(
        &state,
        next,
        |target| async move { Ok(read(state_ref, &target, catalog_ref).await) },
        |request| std::future::ready(Ok(references(&db.catalog, &request))),
    )
    .await
    .unwrap();
    assert!(!repaired.steps.iter().any(|step| step.id == "attributes"));
    let mut resumed = Session::new(&state, db.catalog, &repaired);
    assert_eq!(
        native_job_apply_with(&state, &repaired.plan_id, &mut resumed).await.unwrap().outcome,
        NativeJobOperationOutcome::Verified
    );
    assert!(!resumed.calls.iter().any(|id| id == "pause" || id == "attributes"));
}

#[tokio::test]
async fn ordinary_edits_still_call_the_original_fnonce_reader_once_without_new_reference_reads() {
    let (_dir, state, target) = setup().await;
    let catalog = Catalog::new();
    let initial = read(&state, &target, &catalog).await;
    let mutation = serde_json::from_value(json!({"target":target,"baseline":initial.snapshot.revision,"action":"update","attributes":[{"name":"COMMENTS","change":{"kind":"set","value":"new"}}],"arguments":[]})).unwrap();
    let reads = AtomicUsize::new(0);
    let state_ref = state.as_ref();
    let catalog_ref = &catalog;
    let plan = native_job_prepare_with_references(
        &state,
        mutation,
        |target| {
            reads.fetch_add(1, Ordering::SeqCst);
            async move { Ok(read(state_ref, &target, catalog_ref).await) }
        },
        |_| -> std::future::Ready<Result<NativeJobReferenceCatalog, &'static str>> {
            panic!("ordinary edit read a reference")
        },
    )
    .await
    .unwrap();
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    assert_eq!(plan.steps.len(), 1);
}

#[tokio::test]
async fn inline_to_program_and_back_use_independent_complete_argument_contexts() {
    let (_dir, state, target) = setup().await;
    let mut catalog = Catalog::new();
    catalog.definition.extend(serde_json::from_value::<NativeJobRow>(json!({"PROGRAM_OWNER":null,"PROGRAM_NAME":null,"JOB_TYPE":"STORED_PROCEDURE","JOB_ACTION":"inline_proc","NUMBER_OF_ARGUMENTS":2})).unwrap());
    let plan = prepare(&state, &target, &catalog).await;
    let mut db = Session::new(&state, catalog, &plan);
    assert_eq!(
        native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap().outcome,
        NativeJobOperationOutcome::Verified
    );
    let initial = read(&state, &target, &db.catalog).await;
    let mutation = serde_json::from_value(json!({"action":"update","target":target,"baseline":initial.snapshot.revision,"finalEnabled":false,"attributes":[{"name":"PROGRAM_NAME","change":{"kind":"clear"}},{"name":"JOB_TYPE","change":{"kind":"set","value":"STORED_PROCEDURE"}},{"name":"JOB_ACTION","change":{"kind":"set","value":"new_inline"}},{"name":"NUMBER_OF_ARGUMENTS","change":{"kind":"set","value":1}}],"arguments":[],"argumentTarget":{"program":null,"arguments":[{"position":1,"dataType":"VARCHAR2","value":{"kind":"value","value":"inline only"}}]}})).unwrap();
    let state_ref = state.as_ref();
    let catalog_ref = &db.catalog;
    let plan = native_job_prepare_with_references(
        &state,
        mutation,
        |target| async move { Ok(read(state_ref, &target, catalog_ref).await) },
        |_| -> std::future::Ready<Result<NativeJobReferenceCatalog, &'static str>> {
            panic!("inline target read an unrelated reference")
        },
    )
    .await
    .unwrap();
    let mut db = Session::new(&state, db.catalog, &plan);
    assert_eq!(
        native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap().outcome,
        NativeJobOperationOutcome::Verified
    );
    assert_eq!(db.catalog.definition["PROGRAM_NAME"], Value::Null);
    assert_eq!(db.catalog.definition["JOB_ACTION"], json!("new_inline"));
    assert_eq!(db.catalog.definition["ENABLED"], json!(false));
    assert_eq!(db.catalog.args[0]["VALUE"], json!("inline only"));
}

#[tokio::test]
async fn target_metadata_arguments_are_retired_in_the_old_context_not_user_overridden() {
    let (_dir, state, target) = setup().await;
    let mut catalog = Catalog::new();
    catalog.metadata_position = Some(2);
    let plan = prepare(&state, &target, &catalog).await;
    assert!(plan.steps.iter().any(|step| step.id == "retire-argument:2"));
    let mut db = Session::new(&state, catalog, &plan);
    assert_eq!(
        native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap().outcome,
        NativeJobOperationOutcome::Verified
    );
    assert!(!db.calls.iter().any(|step| step == "argument:2"));
}

#[tokio::test]
async fn an_unresettable_residual_requires_an_explicit_original_context_preview() {
    let (_dir, state, target) = setup().await;
    let mut catalog = Catalog::new();
    catalog.count = 1;
    catalog.definition.insert("PROGRAM_NAME".into(), json!("P2"));
    let initial = read(&state, &target, &catalog).await;
    let state_ref = state.as_ref();
    let catalog_ref = &catalog;
    let result = native_job_prepare_with_references(
        &state,
        mutation(&initial, 1),
        |target| async move { Ok(read(state_ref, &target, catalog_ref).await) },
        |request| std::future::ready(Ok(references(&catalog, &request))),
    )
    .await;
    assert_eq!(result.err(), Some("native_job_argument_retirement_requires_original_context"));
}

#[tokio::test]
async fn explicit_null_needs_native_typed_null_evidence_not_the_retained_client_value() {
    for poison in [Some("null-evidence"), Some("wrong-null-type"), None] {
        let known = poison.is_none();
        let (_dir, state, target) = setup().await;
        let catalog = Catalog::new();
        let initial = read(&state, &target, &catalog).await;
        let mut mutation = mutation(&initial, 2);
        if let NativeJobChange::Update { argument_target: Some(target), .. } = &mut mutation.change {
            target.arguments[0].value = NativeJobArgumentValue::Null;
            target.arguments[0].data_type = "NUMBER".into();
        }
        let state_ref = state.as_ref();
        let catalog_ref = &catalog;
        let plan = native_job_prepare_with_references(
            &state,
            mutation,
            |target| async move { Ok(read(state_ref, &target, catalog_ref).await) },
            |request| std::future::ready(Ok(references(&catalog, &request))),
        )
        .await
        .unwrap();
        let argument = plan.steps.iter().find(|step| step.id == "argument:1").unwrap();
        assert!(argument.sql.contains("ConvertVarchar2"), "the bound Program type must replace the stale caller type");
        let mut db = Session::new(&state, catalog, &plan);
        db.poison = poison;
        let result = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
        assert_eq!(
            result.outcome,
            if known { NativeJobOperationOutcome::Verified } else { NativeJobOperationOutcome::Partial }
        );
        assert_eq!(db.calls.iter().any(|step| step == "enable"), known);
    }
}

#[tokio::test]
async fn number_conversion_uses_the_anydata_setter_and_compares_exactly_without_replaying_satisfied_values() {
    for mode in ["write", "satisfied", "rounded"] {
        let (_dir, state, target) = setup().await;
        let mut catalog = Catalog::new();
        catalog.first_type = "NUMBER";
        if mode == "satisfied" {
            catalog.args[0].extend(serde_json::from_value::<NativeJobRow>(json!({"DBX_ANYDATA_PRESENT":1,"DBX_ANYDATA_TYPE":"SYS.NUMBER","DBX_ANYDATA_IS_NULL":0,"DBX_ANYDATA_TEXT":"9.007199254740993123e15","ANYDATA_VALUE":"locator","VALUE":"wrong fallback"})).unwrap());
        }
        let initial = read(&state, &target, &catalog).await;
        let mut request = mutation(&initial, 2);
        let NativeJobChange::Update { argument_target: Some(arguments), .. } = &mut request.change else {
            unreachable!()
        };
        arguments.arguments[0].value = NativeJobArgumentValue::Value {
            value: json!({"$dbx":"oracle-anydata-v1","typeName":"SYS.NUMBER","value":"9007199254740993.123"}),
        };
        let state_ref = state.as_ref();
        let catalog_ref = &catalog;
        let plan = native_job_prepare_with_references(
            &state,
            request,
            |target| async move { Ok(read(state_ref, &target, catalog_ref).await) },
            |request| std::future::ready(Ok(references(&catalog, &request))),
        )
        .await
        .unwrap();
        assert!(plan.steps.iter().find(|step| step.id == "argument:1").unwrap().sql.contains("SET_JOB_ANYDATA_VALUE"));
        let mut db = Session::new(&state, catalog, &plan);
        if mode == "rounded" {
            db.poison = Some("number-rounding");
        }
        let result = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
        assert_eq!(
            result.outcome,
            if mode == "rounded" { NativeJobOperationOutcome::Partial } else { NativeJobOperationOutcome::Verified },
            "{mode}: reason={:?}, calls={:?}",
            result.reason,
            db.calls
        );
        assert_eq!(db.calls.iter().any(|step| step == "argument:1"), mode != "satisfied", "{mode}");
        assert_eq!(db.calls.iter().any(|step| step == "enable"), mode != "rounded", "{mode}");
    }
}

#[tokio::test]
async fn a_later_character_validation_failure_or_cancel_never_pauses_or_converts_the_enabled_job() {
    for stop in ["reject-second", "cancel-first", "unknown-first"] {
        let (_dir, state, target) = setup().await;
        let mut catalog = Catalog::new();
        catalog.first_type = "NVARCHAR2";
        let initial = read(&state, &target, &catalog).await;
        let mut request = mutation(&initial, 2);
        let NativeJobChange::Update { argument_target: Some(arguments), .. } = &mut request.change else {
            unreachable!()
        };
        for (index, argument) in arguments.arguments.iter_mut().enumerate() {
            argument.value = NativeJobArgumentValue::Value {
                value: json!({"$dbx":"oracle-anydata-v1","scalarType":if index == 0 { "nvarchar2" } else { "varchar2" },"value":"must be checked before pause"}),
            };
        }
        let state_ref = state.as_ref();
        let catalog_ref = &catalog;
        let plan = native_job_prepare_with_references(
            &state,
            request,
            |target| async move { Ok(read(state_ref, &target, catalog_ref).await) },
            |request| std::future::ready(Ok(references(&catalog, &request))),
        )
        .await
        .unwrap();
        assert_eq!(plan.steps[0].id, "validate-argument:1");
        assert_eq!(plan.steps[1].id, "validate-argument:2");
        let mut db = Session::new(&state, catalog, &plan);
        match stop {
            "reject-second" => db.reject = Some("validate-argument:2"),
            "cancel-first" => db.cancel_after = Some("validate-argument:1"),
            _ => db.unknown = Some("validate-argument:1"),
        }
        let result = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
        assert_eq!(result.outcome, NativeJobOperationOutcome::NotApplied, "{stop}");
        assert!(db.calls.iter().all(|step| step.starts_with("validate-argument:")), "{stop}");
        assert_eq!(db.catalog.definition["ENABLED"], json!(true));
        assert_eq!(db.catalog.definition["PROGRAM_NAME"], json!("P1"));
        assert_eq!(db.catalog.args[0]["VALUE"], json!("old"));
    }
}

#[tokio::test]
async fn generated_observations_do_not_become_user_definition_conflicts_at_any_transition_phase() {
    let (_dir, state, target) = setup().await;
    let catalog = Catalog::new();
    let plan = prepare(&state, &target, &catalog).await;
    let mut db = Session::new(&state, catalog, &plan);
    db.catalog.definition.insert("FLAGS".into(), json!(500));
    db.catalog.definition.insert("EVENT_RULE".into(), json!("new-native-rule"));
    db.catalog.definition.insert("NUMBER_OF_DESTINATIONS".into(), json!("7"));
    db.poison = Some("generated");
    let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
    assert_eq!(status.outcome, NativeJobOperationOutcome::Verified);
    assert!(db.calls.iter().any(|step| step == "argument:1"));
    assert_eq!(db.calls.last().map(String::as_str), Some("enable"));
}

async fn prepare_attributes(
    state: &AppState,
    target: &NativeJobRef,
    catalog: &Catalog,
    attributes: Value,
) -> Result<NativeJobPreparedPlan, &'static str> {
    let initial = read(state, target, catalog).await;
    let mutation = serde_json::from_value(json!({"action":"update","target":target,"baseline":initial.snapshot.revision,"finalEnabled":true,"attributes":attributes,"arguments":[]})).unwrap();
    native_job_prepare_with_references(
        state,
        mutation,
        |target| async move { Ok(read(state, &target, catalog).await) },
        |request| std::future::ready(Ok(references(catalog, &request))),
    )
    .await
}

fn file_watcher(catalog: &mut Catalog) {
    catalog.extra_references.push((NativeJobReferenceKind::FileWatcher, NativeJobMetadata::Available {
        value: vec![serde_json::from_value(json!({"DBX_OWNER":"Owner","DBX_NAME":"Watch.er","ENABLED":true,"DIRECTORY_PATH":"/drop","FILE_NAME":"*.csv"})).unwrap()],
    }));
}

fn event_fields(condition: Value, watcher: bool) -> NativeJobRow {
    serde_json::from_value(json!({"EVENT_CONDITION":condition,"EVENT_QUEUE_OWNER":if watcher { Value::Null } else { json!("Owner") },"EVENT_QUEUE_NAME":if watcher { Value::Null } else { json!("Queue") },"EVENT_QUEUE_AGENT":if watcher { Value::Null } else { json!("Agent") },"FILE_WATCHER_OWNER":if watcher { json!("Owner") } else { Value::Null },"FILE_WATCHER_NAME":if watcher { json!("Watch.er") } else { Value::Null }})).unwrap()
}

#[tokio::test]
async fn destination_count_null_and_integral_representations_are_observations_not_a_formula() {
    for count in [Value::Null, json!(0), json!(3), json!("7")] {
        let (_dir, state, target) = setup().await;
        let mut catalog = Catalog::new();
        catalog.definition.insert("NUMBER_OF_DESTINATIONS".into(), count.clone());
        let plan = prepare(&state, &target, &catalog).await;
        let mut db = Session::new(&state, catalog, &plan);
        db.after_definition.insert("NUMBER_OF_DESTINATIONS".into(), json!(99));
        let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
        assert_eq!(status.outcome, NativeJobOperationOutcome::Verified, "{count}");
    }
}

#[tokio::test]
async fn missing_negative_and_fractional_destination_observations_never_enable_or_hide_lost_receipts() {
    for (count, unknown) in [(None, false), (Some(json!(-1)), false), (Some(json!(1.5)), false), (None, true)] {
        let (_dir, state, target) = setup().await;
        let catalog = Catalog::new();
        let plan = prepare(&state, &target, &catalog).await;
        let mut db = Session::new(&state, catalog, &plan);
        if let Some(count) = count {
            db.after_definition.insert("NUMBER_OF_DESTINATIONS".into(), count);
        } else {
            db.poison = Some("missing-count");
        }
        if unknown {
            db.unknown = Some("pause");
        }
        let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
        assert_eq!(
            status.outcome,
            if unknown { NativeJobOperationOutcome::Unknown } else { NativeJobOperationOutcome::Partial }
        );
        assert!(!db.calls.iter().any(|step| step == "enable"));
    }
}

#[tokio::test]
async fn unrelated_and_unknown_definition_columns_remain_strict_during_reference_changes() {
    for field in ["COMMENTS", "NLS_ENV", "FUTURE_NATIVE_COLUMN"] {
        let (_dir, state, target) = setup().await;
        let catalog = Catalog::new();
        let plan = prepare(&state, &target, &catalog).await;
        let mut db = Session::new(&state, catalog, &plan);
        db.after_definition.insert(field.into(), json!("external"));
        let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
        assert_eq!(status.outcome, NativeJobOperationOutcome::Partial, "{field}");
        assert!(!db.calls.iter().any(|step| step == "enable"));
    }
}

#[tokio::test]
async fn watcher_generated_queues_are_checked_through_definition_arguments_and_final_activation() {
    let (_dir, state, target) = setup().await;
    let mut catalog = Catalog::new();
    file_watcher(&mut catalog);
    let initial = read(&state, &target, &catalog).await;
    let mut change = mutation(&initial, 2);
    if let NativeJobChange::Update { attributes, .. } = &mut change.change {
        attributes.push(serde_json::from_value(json!({"name":"EVENT_SPEC","change":{"kind":"set","value":{"condition":null,"source":{"kind":"file-watcher","reference":{"owner":"Owner","name":"Watch.er"}}}}})).unwrap());
    }
    let state_ref = state.as_ref();
    let catalog_ref = &catalog;
    let plan = native_job_prepare_with_references(
        &state,
        change,
        |target| async move { Ok(read(state_ref, &target, catalog_ref).await) },
        |request| std::future::ready(Ok(references(&catalog, &request))),
    )
    .await
    .unwrap();
    let mut db = Session::new(&state, catalog, &plan);
    db.poison = Some("watcher-queue");
    assert_eq!(
        native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap().outcome,
        NativeJobOperationOutcome::Verified
    );
    assert!(db.calls.iter().any(|step| step == "argument:1"));
    assert_eq!(db.calls.last().map(String::as_str), Some("enable"));
    assert!(!db.catalog.definition["EVENT_QUEUE_NAME"].is_null());
    assert!(db.catalog.definition["EVENT_CONDITION"].is_null());
}

#[tokio::test]
async fn queue_and_watcher_conversions_require_exact_raw_condition_and_source_identity() {
    for (watcher_target, corrupt) in
        [(true, None), (false, None), (true, Some("condition")), (true, Some("watcher")), (false, Some("agent"))]
    {
        let (_dir, state, target) = setup().await;
        let mut catalog = Catalog::new();
        catalog.definition.extend(event_fields(json!("old condition"), !watcher_target));
        catalog.definition.insert("SCHEDULE_TYPE".into(), json!("EVENT"));
        catalog.definition.insert("REPEAT_INTERVAL".into(), Value::Null);
        file_watcher(&mut catalog);
        let source = if watcher_target {
            json!({"kind":"file-watcher","reference":{"owner":"Owner","name":"Watch.er"}})
        } else {
            json!({"kind":"queue","owner":"Owner","name":"Queue","agent":"Agent"})
        };
        let plan = prepare_attributes(
            &state,
            &target,
            &catalog,
            json!([{"name":"EVENT_SPEC","change":{"kind":"set","value":{"condition":" x = 1 ","source":source}}}]),
        )
        .await
        .unwrap();
        let mut db = Session::new(&state, catalog, &plan);
        if let Some(corrupt) = corrupt {
            let (column, value) = match corrupt {
                "condition" => ("EVENT_CONDITION", json!("x = 1")),
                "watcher" => ("FILE_WATCHER_NAME", json!("Watch")),
                _ => ("EVENT_QUEUE_AGENT", Value::Null),
            };
            db.after_definition.insert(column.into(), value);
        }
        let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
        assert_eq!(
            status.outcome,
            if corrupt.is_none() { NativeJobOperationOutcome::Verified } else { NativeJobOperationOutcome::Partial },
            "{watcher_target} {corrupt:?}"
        );
        assert_eq!(db.calls.iter().any(|step| step == "enable"), corrupt.is_none());
    }
}

#[tokio::test]
async fn named_event_schedule_accepts_null_materialization_but_never_a_different_nonnull_condition() {
    for (watcher, wrong, materialized) in
        [(false, false, false), (false, false, true), (false, true, true), (true, false, true), (true, true, true)]
    {
        let (_dir, state, target) = setup().await;
        let mut catalog = Catalog::new();
        let source_fields = event_fields(json!(" x = 1 "), watcher);
        let mut schedule = source_fields.clone();
        schedule.extend(
            serde_json::from_value::<NativeJobRow>(
                json!({"DBX_OWNER":"Owner","DBX_NAME":"Schedule","SCHEDULE_TYPE":"EVENT"}),
            )
            .unwrap(),
        );
        catalog
            .extra_references
            .push((NativeJobReferenceKind::Schedule, NativeJobMetadata::Available { value: vec![schedule] }));
        let plan = prepare_attributes(
            &state,
            &target,
            &catalog,
            json!([{"name":"SCHEDULE_NAME","change":{"kind":"set","value":{"owner":"Owner","name":"Schedule"}}}]),
        )
        .await
        .unwrap();
        let mut db = Session::new(&state, catalog, &plan);
        if materialized {
            db.after_definition = source_fields;
        }
        if watcher {
            db.poison = Some("watcher-queue");
        }
        if wrong {
            db.after_definition.insert("EVENT_CONDITION".into(), json!("x = 1"));
        }
        let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
        assert_eq!(
            status.outcome,
            if wrong { NativeJobOperationOutcome::Partial } else { NativeJobOperationOutcome::Verified },
            "{watcher} {wrong} {materialized}"
        );
        assert_eq!(db.calls.iter().any(|step| step == "enable"), !wrong);
    }
}

fn destination_group(catalog: &mut Catalog, members: NativeJobMetadata<Vec<NativeJobRow>>) {
    // An inline definition avoids reading an unrelated Program for group compatibility.
    catalog.definition.extend(serde_json::from_value::<NativeJobRow>(json!({"PROGRAM_OWNER":null,"PROGRAM_NAME":null,"JOB_TYPE":"STORED_PROCEDURE","JOB_ACTION":"proc","NUMBER_OF_ARGUMENTS":0})).unwrap());
    catalog.args.clear();
    catalog.extra_references.push((
        NativeJobReferenceKind::DestinationGroup,
        NativeJobMetadata::Available {
            value: vec![
                serde_json::from_value(json!({"DBX_OWNER":"Owner","DBX_NAME":"Group","GROUP_TYPE":"DB_DEST"})).unwrap()
            ],
        },
    ));
    catalog.extra_references.push((NativeJobReferenceKind::DestinationGroupMembers, members));
}

fn members() -> Vec<NativeJobRow> {
    ["Credential@Database.1", "Database.2"]
        .iter()
        .map(|name| serde_json::from_value(json!({"DBX_OWNER":"Owner","DBX_NAME":"Group","MEMBER_NAME":name})).unwrap())
        .collect()
}

fn destination_change() -> Value {
    json!([{"name":"DESTINATION_NAME","change":{"kind":"set","value":{"owner":"Owner","name":"Group","kind":"destination-group"}}}])
}

#[tokio::test]
async fn destination_group_member_order_is_irrelevant_but_same_count_credential_changes_stop_before_definition_or_enable(
) {
    for changed_at in [None, Some(3), Some(5)] {
        let (_dir, state, target) = setup().await;
        let mut catalog = Catalog::new();
        destination_group(&mut catalog, NativeJobMetadata::Available { value: members() });
        let plan = prepare_attributes(&state, &target, &catalog, destination_change()).await.unwrap();
        let mut db = Session::new(&state, catalog, &plan);
        db.reverse_members = true;
        db.member_change_at = changed_at;
        let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
        assert_eq!(
            status.outcome,
            if changed_at.is_none() { NativeJobOperationOutcome::Verified } else { NativeJobOperationOutcome::Partial }
        );
        assert_eq!(db.calls.iter().any(|step| step == "attributes"), changed_at != Some(3));
        assert_eq!(db.calls.iter().any(|step| step == "enable"), changed_at.is_none());
    }
}

#[tokio::test]
async fn empty_destination_members_are_known_empty_while_denied_truncated_duplicate_and_wrong_identity_block() {
    for case in ["empty", "denied", "truncated", "duplicate", "identity"] {
        let (_dir, state, target) = setup().await;
        let mut catalog = Catalog::new();
        let mut value = members();
        let metadata = match case {
            "empty" => NativeJobMetadata::Empty,
            "denied" => NativeJobMetadata::Denied { reason: "denied".into() },
            "truncated" => NativeJobMetadata::Truncated { value, limit: 1 },
            "duplicate" => {
                value.push(value[0].clone());
                NativeJobMetadata::Available { value }
            }
            _ => {
                value[0].insert("DBX_NAME".into(), json!("AnotherGroup"));
                NativeJobMetadata::Available { value }
            }
        };
        destination_group(&mut catalog, metadata);
        let result = prepare_attributes(&state, &target, &catalog, destination_change()).await;
        if case == "empty" {
            let plan = result.unwrap();
            let mut db = Session::new(&state, catalog, &plan);
            assert_eq!(
                native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap().outcome,
                NativeJobOperationOutcome::Verified
            );
        } else {
            assert!(result.is_err(), "{case}");
        }
    }
}

#[tokio::test]
async fn an_unchanged_legacy_host_remains_raw_during_program_conversion_without_destination_reads() {
    let (_dir, state, target) = setup().await;
    let mut catalog = Catalog::new();
    catalog.definition.insert("DESTINATION".into(), json!("host.with.dots:1500"));
    let plan = prepare(&state, &target, &catalog).await;
    let mut db = Session::new(&state, catalog, &plan);
    let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
    assert_eq!(status.outcome, NativeJobOperationOutcome::Verified);
    assert_eq!(db.catalog.definition["DESTINATION"], json!("host.with.dots:1500"));
    assert!(db.catalog.definition["DESTINATION_OWNER"].is_null());
}

#[tokio::test]
async fn existing_watcher_generated_queues_do_not_invalidate_the_preview_baseline() {
    let (_dir, state, target) = setup().await;
    let mut catalog = Catalog::new();
    catalog.definition.extend(event_fields(Value::Null, true));
    catalog.definition.insert("SCHEDULE_TYPE".into(), json!("EVENT"));
    catalog.definition.insert("REPEAT_INTERVAL".into(), Value::Null);
    let plan = prepare(&state, &target, &catalog).await;
    let mut db = Session::new(&state, catalog, &plan);
    db.catalog.definition.insert("EVENT_QUEUE_OWNER".into(), json!("SYS"));
    db.catalog.definition.insert("EVENT_QUEUE_NAME".into(), json!("NATIVE_REASSIGNED_QUEUE"));
    db.poison = Some("watcher-queue");
    let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
    assert_eq!(status.outcome, NativeJobOperationOutcome::Verified);
    assert_eq!(db.calls.last().map(String::as_str), Some("enable"));
}

#[tokio::test]
async fn an_independent_schedule_change_does_not_require_unreadable_old_program_arguments() {
    let (_dir, state, target) = setup().await;
    let mut catalog = Catalog::new();
    let mut schedule = event_fields(Value::Null, false);
    for value in schedule.values_mut() {
        *value = Value::Null;
    }
    schedule.extend(
        serde_json::from_value::<NativeJobRow>(
            json!({"DBX_OWNER":"Owner","DBX_NAME":"Schedule","SCHEDULE_TYPE":"CALENDAR"}),
        )
        .unwrap(),
    );
    catalog
        .extra_references
        .push((NativeJobReferenceKind::Schedule, NativeJobMetadata::Available { value: vec![schedule] }));
    let mut initial = read(&state, &target, &catalog).await;
    initial.program = Some(NativeJobMetadata::Denied { reason: "old Program unreadable".into() });
    initial.program_arguments = Some(NativeJobMetadata::Denied { reason: "old arguments unreadable".into() });
    initial.snapshot.arguments = NativeJobMetadata::Unknown { reason: "old arguments unreadable".into() };
    let change = serde_json::from_value(json!({"action":"update","target":target,"baseline":initial.snapshot.revision,"finalEnabled":true,"attributes":[{"name":"SCHEDULE_NAME","change":{"kind":"set","value":{"owner":"Owner","name":"Schedule"}}}],"arguments":[]})).unwrap();
    let plan = native_job_prepare_with_references(
        &state,
        change,
        |_| std::future::ready(Ok(initial.clone())),
        |request| {
            assert_eq!(request.kind, NativeJobReferenceKind::Schedule);
            std::future::ready(Ok(references(&catalog, &request)))
        },
    )
    .await
    .unwrap();
    let mut db = Session::new(&state, catalog, &plan);
    assert_eq!(
        native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap().outcome,
        NativeJobOperationOutcome::Verified
    );
    assert_eq!(db.catalog.definition["PROGRAM_NAME"], json!("P1"));
}

#[tokio::test]
async fn missing_named_schedule_event_columns_cannot_masquerade_as_unmaterialized_nulls() {
    let (_dir, state, target) = setup().await;
    let mut catalog = Catalog::new();
    catalog.extra_references.push((
        NativeJobReferenceKind::Schedule,
        NativeJobMetadata::Available {
            value: vec![serde_json::from_value(
                json!({"DBX_OWNER":"Owner","DBX_NAME":"Schedule","SCHEDULE_TYPE":"EVENT","EVENT_CONDITION":null}),
            )
            .unwrap()],
        },
    ));
    let result = prepare_attributes(
        &state,
        &target,
        &catalog,
        json!([{"name":"SCHEDULE_NAME","change":{"kind":"set","value":{"owner":"Owner","name":"Schedule"}}}]),
    )
    .await;
    assert_eq!(result.err(), Some("native_job_event_projection_unavailable"));
}

#[tokio::test]
async fn raw_destination_set_and_clear_preserve_exact_values_without_reference_reads() {
    for enabled in [true, false] {
        for change in [json!({"kind":"set","value":"Host.With.Dots:1501"}), json!({"kind":"clear"})] {
            let (_dir, state, target) = setup().await;
            let mut catalog = Catalog::new();
            catalog.definition.insert("ENABLED".into(), json!(enabled));
            catalog.definition.insert("DESTINATION".into(), json!("old.host:1500"));
            let initial = read(&state, &target, &catalog).await;
            let mutation = serde_json::from_value(json!({"action":"update","target":target,"baseline":initial.snapshot.revision,"attributes":[{"name":"DESTINATION","change":change}],"arguments":[]})).unwrap();
            let plan = native_job_prepare_with_references(
                &state,
                mutation,
                |target| {
                    let state = &state;
                    let catalog = &catalog;
                    async move { Ok(read(state, &target, catalog).await) }
                },
                |_| std::future::ready(Err("unexpected_destination_reference")),
            )
            .await
            .unwrap();
            let mut db = Session::new(&state, catalog, &plan);
            let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
            assert_eq!(status.outcome, NativeJobOperationOutcome::Verified);
            assert_eq!(db.dependency_reads, 0);
            assert_eq!(db.catalog.definition["DESTINATION_OWNER"], Value::Null);
            assert_eq!(db.catalog.definition["DESTINATION"], change.get("value").cloned().unwrap_or(Value::Null));
            assert_eq!(db.catalog.definition["ENABLED"], json!(enabled));
            assert_eq!(
                db.calls.first().map(String::as_str),
                Some(if enabled { "pause" } else { "attribute:DESTINATION" })
            );
            assert_eq!(db.calls.contains(&"enable".into()), enabled);
        }
    }
}

#[tokio::test]
async fn a_raw_destination_with_the_wrong_owner_or_unexpected_activation_never_reaches_final_enable() {
    for (column, value) in [("DESTINATION_OWNER", json!("UnexpectedOwner")), ("ENABLED", json!(true))] {
        let (_dir, state, target) = setup().await;
        let mut catalog = Catalog::new();
        catalog.definition.insert("DESTINATION".into(), json!("old.host:1500"));
        let plan =
            prepare_attributes(&state, &target, &catalog, json!([{"name":"DESTINATION","change":{"kind":"clear"}}]))
                .await
                .unwrap();
        let mut db = Session::new(&state, catalog, &plan);
        db.after_definition.insert(column.into(), value);
        let status = native_job_apply_with(&state, &plan.plan_id, &mut db).await.unwrap();
        assert_eq!(status.outcome, NativeJobOperationOutcome::Partial);
        assert_eq!(db.calls, ["pause", "attribute:DESTINATION"]);
        assert_eq!(db.dependency_reads, 0);
    }
}
