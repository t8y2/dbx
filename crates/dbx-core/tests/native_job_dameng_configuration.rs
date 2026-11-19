#![recursion_limit = "256"]

use dbx_core::connection::AppState;
use dbx_core::schema::native_jobs::*;
use dbx_sql::native_job_changes::{
    NativeJobDamengChildAction, NativeJobDamengPart, NativeJobSqlStep, NativeJobStepEffect,
};
use dbx_sql::native_jobs::NativeJobCatalogQuery;
use dbx_types::native_jobs::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

#[derive(Clone)]
struct Database {
    name: String,
    exists: bool,
    enabled: bool,
    description: &'static str,
    valid: &'static str,
    created: &'static str,
    ep_seqno: i32,
    email_operator: i32,
    unreadable_parts: bool,
    steps: Vec<NativeJobRow>,
    schedules: Vec<NativeJobRow>,
    owner: &'static str,
    system_definition: bool,
    system_parts: bool,
    legacy: Option<NativeJobRow>,
    legacy_denied: bool,
}

impl Default for Database {
    fn default() -> Self {
        Self {
            name: "Job_1".into(),
            exists: true,
            enabled: true,
            description: "old",
            valid: "Y",
            created: "creation",
            ep_seqno: 0,
            email_operator: 7,
            unreadable_parts: false,
            steps: serde_json::from_value(json!([
                {"ID":11,"JOBID":41,"NAME":"backup","SEQNO":1,"TYPE":6,"DBNAME":"DB","COMMAND":"native generated backup command","SUCC_ACTION":3,"FAIL_ACTION":1,"RETRY_ATTEMPTS":2,"RETRY_INTERVAL":1,"OUTPUT_FILE_PATH":null,"APPEND_FLAG":0,"SUCC_NEXT_STEP":"sql","FAIL_NEXT_STEP":null,"DESCRIBE":"keep backup"},
                {"ID":12,"JOBID":41,"NAME":"sql","SEQNO":2,"TYPE":0,"DBNAME":"DB","COMMAND":"BEGIN NULL; END;","SUCC_ACTION":1,"FAIL_ACTION":1,"RETRY_ATTEMPTS":0,"RETRY_INTERVAL":0,"OUTPUT_FILE_PATH":null,"APPEND_FLAG":0,"SUCC_NEXT_STEP":null,"FAIL_NEXT_STEP":null,"DESCRIBE":"keep sql"}
            ])).unwrap(),
            schedules: serde_json::from_value(json!([
                {"ID":21,"JOBID":41,"NAME":"daily","TYPE":1,"ENABLE":1,"FREQ_INTERVAL":1,"FREQ_SUB_INTERVAL":0,"FREQ_MINUTE_INTERVAL":5,"STARTTIME":"23:00:00","ENDTIME":"01:00:00","DURING_START_DATE":"2026-10-21","DURING_END_DATE":"2026-12-31","DESCRIBE":"keep daily","VALID":"Y","SCHNAME":"sch1","TRIGNAME":"trig1"},
                {"ID":22,"JOBID":41,"NAME":"weekly","TYPE":2,"ENABLE":0,"FREQ_INTERVAL":3,"FREQ_SUB_INTERVAL":68,"FREQ_MINUTE_INTERVAL":0,"STARTTIME":"09:00:00","ENDTIME":null,"DURING_START_DATE":"2026-10-21","DURING_END_DATE":null,"DESCRIBE":"keep weekly","VALID":"Y","SCHNAME":"sch2","TRIGNAME":"trig2"}
            ])).unwrap(),
            owner: "Owner", system_definition: false, system_parts: false, legacy: None, legacy_denied: false,
        }
    }
}

fn result(columns: &[&str], rows: Value) -> Value {
    json!({"columns":columns,"rows":rows,"affected_rows":0,"execution_time_ms":0})
}

fn part_result(rows: &[NativeJobRow]) -> Value {
    let columns = rows
        .iter()
        .flat_map(|row| row.keys().cloned())
        .chain(std::iter::once("ID".into()))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let values = rows
        .iter()
        .map(|row| columns.iter().map(|key| row.get(key).cloned().unwrap_or(Value::Null)).collect::<Vec<_>>())
        .collect::<Vec<_>>();
    json!({"columns":columns,"rows":values,"affected_rows":0,"execution_time_ms":0})
}

fn catalog(query: NativeJobCatalogQuery, data: &Database) -> Result<Value, NativeJobCatalogFailure> {
    if matches!(query.source, "SYSJOB.DBA_JOBS" | "SYSJOB.USER_JOBS") {
        if data.legacy_denied {
            return Err(NativeJobCatalogFailure::Denied(Some(-5515)));
        }
        return Ok(part_result(&data.legacy.clone().into_iter().collect::<Vec<_>>()));
    }
    if (query.source == "SYSJOB.SYSJOBS" && !data.system_definition)
        || (matches!(query.source, "SYSJOB.SYSJOBSTEPS" | "SYSJOB.SYSJOBSCHEDULES") && !data.system_parts)
    {
        return Err(NativeJobCatalogFailure::Denied(Some(-5515)));
    }
    if matches!(query.source, "SYSJOB.SYSJOBS" | "SYSJOB.USER_JOBS_VIEW") {
        if !data.exists {
            return Ok(result(&["DBX_JOB_ID", "NAME", "USERNAME"], json!([])));
        }
        if query.sql.contains("UPPER(NAME) = UPPER(") {
            let matches = query.sql.contains(&format!("UPPER('{}')", data.name.replace('\'', "''")));
            return Ok(result(
                &["DBX_JOB_ID", "NAME", "USERNAME"],
                if matches { json!([["41", data.name, data.owner]]) } else { json!([]) },
            ));
        }
        if query.sql.contains("AS DBX_CREATED_AT, NAME") {
            return Ok(result(
                &["DBX_JOB_ID", "DBX_CREATED_AT", "NAME", "USERNAME", "SYS_FLAG"],
                json!([["41", data.created, data.name, data.owner, if data.legacy.is_some() { 2 } else { 0 }]]),
            ));
        }
        return Ok(if query.sql.contains("AS DBX_CREATED_AT") {
            result(&["DBX_JOB_ID", "DBX_CREATED_AT"], json!([["41", data.created]]))
        } else {
            result(
                &[
                    "ID",
                    "DBX_JOB_ID",
                    "NAME",
                    "USERNAME",
                    "CREATETIME",
                    "MODIFYTIME",
                    "ENABLE",
                    "ENABLE_EMAIL",
                    "EMAIL_OPERID",
                    "EMAIL_TYPE",
                    "ENABLE_NETSEND",
                    "NETSEND_OPERID",
                    "NETSEND_TYPE",
                    "DESCRIBE",
                    "VALID",
                    "SYS_FLAG",
                    "EP_SEQNO",
                    "RAFT_NAME",
                ],
                json!([[
                    41,
                    "41",
                    data.name,
                    data.owner,
                    data.created,
                    "modified",
                    i32::from(data.enabled),
                    1,
                    data.email_operator,
                    2,
                    0,
                    -1,
                    1,
                    data.description,
                    data.valid,
                    if data.legacy.is_some() { 2 } else { 0 },
                    data.ep_seqno,
                    null
                ]]),
            )
        });
    }
    if data.unreadable_parts && query.source != "SYSJOB.SYSOPERATORS" {
        return Err(NativeJobCatalogFailure::Denied(Some(-5515)));
    }
    match query.source {
        "SYSJOB.SYSJOBSTEPS" | "SYSJOB.USER_JOBSTEPS_VIEW" => {
            Ok(part_result(if query.source == "SYSJOB.USER_JOBSTEPS_VIEW" && data.owner != "Owner" {
                &[]
            } else {
                &data.steps
            }))
        }
        "SYSJOB.SYSJOBSCHEDULES" | "SYSJOB.USER_JOBSCHEDULES_VIEW" => {
            Ok(part_result(if query.source == "SYSJOB.USER_JOBSCHEDULES_VIEW" && data.owner != "Owner" {
                &[]
            } else {
                &data.schedules
            }))
        }
        _ => Err(NativeJobCatalogFailure::Unavailable(Some(-2106))),
    }
}

async fn read(state: &AppState, target: &NativeJobRef, data: &Database) -> NativeJobDetails {
    native_job_read_with(state, target, |query| std::future::ready(catalog(query, data))).await.unwrap()
}

async fn setup(data: &Database) -> (tempfile::TempDir, Arc<AppState>, NativeJobRef) {
    let dir = tempfile::tempdir().unwrap();
    let storage = dbx_core::persistence::test_storage::open(&dir.path().join("state.db")).await.unwrap();
    let state = Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
        storage,
        dir.path().join("plugins"),
        dir.path().join("agents"),
        "0.0.0",
    ));
    state.configs.write().await.insert(
        "c".into(),
        serde_json::from_value(json!({
            "id":"c","name":"test","db_type":"dameng","host":"127.0.0.1","port":1,"username":"Owner","password":""
        }))
        .unwrap(),
    );
    let context = native_job_open_context_with(&state, "c", "", |_| {
        std::future::ready(Ok(NativeJobRuntimeIdentity { database_info: None, session_user: "Owner".into() }))
    })
    .await
    .unwrap();
    let target = NativeJobRef::DamengNative { scope: context.scope, job_id: "41".into(), name: "Job_1".into() };
    let _ = read(&state, &target, data).await;
    (dir, state, target)
}

async fn prepare(state: &AppState, target: &NativeJobRef, data: &Database, attributes: Value) -> NativeJobPreparedPlan {
    let initial = read(state, target, data).await;
    native_job_prepare_with(
        state,
        NativeJobMutation {
            target: target.clone(),
            baseline: initial.snapshot.revision,
            change: NativeJobChange::Update {
                final_enabled: None,
                argument_target: None,
                attributes: serde_json::from_value(attributes).unwrap(),
                arguments: vec![],
            },
        },
        |target| async move { Ok(read(state, &target, data).await) },
    )
    .await
    .unwrap()
}

fn legacy_database() -> Database {
    Database { legacy: Some(serde_json::from_value(json!({"DBX_JOB_ID":"41", "JOB":41, "WHAT":"work();  ", "NEXT_DATE":"native date", "NEXT_SEC":"native second", "INTERVAL":"86400", "INSTANCE":1})).unwrap()), ..Database::default() }
}

#[tokio::test]
async fn legacy_control_freezes_only_the_independent_definition_observed_in_its_original_baseline() {
    for (original_denied, prepare_denied, after, stop) in [
        (false, false, "changed", false),
        (false, false, "denied", false),
        (true, true, "denied", false),
        (true, false, "changed", false),
        (false, false, "changed", true),
        (false, false, "denied", true),
        (false, false, "natural-date", false),
    ] {
        let mut original = legacy_database();
        original.legacy_denied = original_denied;
        let (_dir, state, native) = setup(&original).await;
        let target = NativeJobRef::Legacy { scope: native.scope().clone(), job_id: "41".into() };
        let initial = read(&state, &target, &original).await;
        let mut current = original.clone();
        current.legacy_denied = prepare_denied;
        let plan = native_job_prepare_with(
            &state,
            NativeJobMutation {
                target: target.clone(),
                baseline: initial.snapshot.revision,
                change: if stop { NativeJobChange::Stop { force: false } } else { NativeJobChange::Run },
            },
            |target| {
                let state = &state;
                let current = &current;
                async move { Ok(read(state, &target, current).await) }
            },
        )
        .await
        .unwrap();
        match after {
            "changed" => {
                current.legacy.as_mut().unwrap().insert("WHAT".into(), json!("externally changed();"));
            }
            "denied" => current.legacy_denied = true,
            "natural-date" => {
                current.legacy.as_mut().unwrap().insert("NEXT_DATE".into(), json!("naturally advanced"));
            }
            _ => unreachable!(),
        }
        let mut session = Session::new(&state, current);
        session.leased = true;
        let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
        if !original_denied && !stop && after != "natural-date" {
            assert_eq!(status.outcome, NativeJobOperationOutcome::NotApplied);
            assert!(session.writes().is_empty());
            assert_eq!(
                status.reason.as_deref(),
                Some(if after == "denied" {
                    "native_job_metadata_incomplete"
                } else {
                    "native_job_definition_changed"
                })
            );
        } else {
            assert_eq!(status.outcome, NativeJobOperationOutcome::Accepted);
            assert_eq!(session.writes(), vec![if stop { "stop" } else { "run" }]);
        }
    }
}

#[tokio::test]
async fn native_and_legacy_job_rename_preserve_activation_and_publish_only_the_verified_target() {
    for (legacy, enabled) in [(false, true), (false, false), (true, true)] {
        let mut data = if legacy { legacy_database() } else { Database::default() };
        data.enabled = enabled;
        let (_dir, state, original) = setup(&data).await;
        let target = if legacy {
            NativeJobRef::Legacy { scope: original.scope().clone(), job_id: "41".into() }
        } else {
            original
        };
        let attributes = json!([{"name":"NAME","change":{"kind":"set","value":"Renamed_Job"}}]);
        let plan = if legacy {
            prepare(&state, &target, &data, attributes).await
        } else {
            prepare_configuration(&state, &target, &data, json!({"attributes":attributes})).await
        };
        let mut session = Session::new(&state, data);
        let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
        assert_eq!(status.outcome, NativeJobOperationOutcome::Verified);
        assert_eq!(session.writes(), ["rename"]);
        assert_eq!(session.data.enabled, enabled);
        assert_eq!(status.observed_identity.as_ref().unwrap()["NAME"], json!("Renamed_Job"));
        let next = status.target.as_ref().unwrap();
        assert!(
            matches!(next, NativeJobRef::Legacy { job_id, .. } if legacy && job_id == "41")
                || matches!(next, NativeJobRef::DamengNative { job_id, name, .. } if !legacy && job_id == "41" && name == "Renamed_Job")
        );
        let current = read(&state, next, &session.data).await;
        assert!(matches!(current.snapshot.definition, NativeJobMetadata::Available { .. }));
        assert!(plan.steps[0].sql.contains("SP_RENAME_JOB('Job_1',"));
    }
}

#[tokio::test]
async fn mixed_job_rename_rebinds_final_enable_and_retains_the_effective_target_after_activation_failure() {
    for legacy in [false, true] {
        for fail_enable in [false, true] {
            let data = if legacy { legacy_database() } else { Database::default() };
            let (_dir, state, original) = setup(&data).await;
            let target = if legacy {
                NativeJobRef::Legacy { scope: original.scope().clone(), job_id: "41".into() }
            } else {
                original
            };
            let plan = prepare(&state, &target, &data, json!([{"name":"NAME","change":{"kind":"set","value":"Renamed_Job"}}, {"name":"DESCRIBE","change":{"kind":"set","value":"new"}}])).await;
            let mut session = Session::new(&state, data);
            if fail_enable {
                session.receipts.insert("enable".into(), NativeJobDispatchOutcome::NotStarted);
            }
            let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
            assert_eq!(
                status.outcome,
                if fail_enable { NativeJobOperationOutcome::Partial } else { NativeJobOperationOutcome::Verified }
            );
            assert_eq!(session.writes(), ["pause", "definition", "config_start", "config_commit", "rename", "enable"]);
            assert!(session.sent_steps.last().unwrap().sql.contains("SP_ENABLE_JOB('Renamed_Job', 1)"));
            assert!(session.sent_steps.last().unwrap().sql.contains("NAME = 'Renamed_Job'"));
            assert_eq!(status.observed_identity.as_ref().unwrap()["NAME"], json!("Renamed_Job"));
            assert_eq!(session.data.enabled, !fail_enable);
        }
    }
}

#[tokio::test]
async fn rename_commit_unknown_does_not_follow_same_session_state_or_replay() {
    let data = Database::default();
    let (_dir, state, target) = setup(&data).await;
    let plan =
        prepare(&state, &target, &data, json!([{"name":"NAME","change":{"kind":"set","value":"Renamed_Job"}}])).await;
    let mut session = Session::new(&state, data);
    session.receipts.insert("rename".into(), NativeJobDispatchOutcome::Unknown);
    let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
    assert_eq!(status.outcome, NativeJobOperationOutcome::Unknown);
    assert_eq!(status.target.as_ref(), Some(&target));
    assert!(status.observed_identity.is_none());
    assert_eq!(session.data.name, "Renamed_Job");
    let calls = session.calls.clone();
    assert_eq!(
        native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap().outcome,
        NativeJobOperationOutcome::Unknown
    );
    assert_eq!(session.calls, calls);
}

#[tokio::test]
async fn rename_conflict_and_incomplete_configuration_block_before_dispatch() {
    for issue in ["conflict", "pending"] {
        let mut data = Database::default();
        if issue == "pending" {
            data.valid = "N";
        }
        let (_dir, state, target) = setup(&data).await;
        let plan =
            prepare(&state, &target, &data, json!([{"name":"NAME","change":{"kind":"set","value":"Renamed_Job"}}]))
                .await;
        let mut session = Session::new(&state, data);
        session.rename_conflict = issue == "conflict";
        let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
        assert_eq!(status.outcome, NativeJobOperationOutcome::NotApplied);
        assert!(session.writes().is_empty());
    }
}

#[tokio::test]
async fn rename_replacement_third_name_and_preservation_changes_never_complete_as_verified() {
    for difference in ["generation", "third-name", "description", "schedule"] {
        let data = Database::default();
        let (_dir, state, target) = setup(&data).await;
        let plan =
            prepare(&state, &target, &data, json!([{"name":"NAME","change":{"kind":"set","value":"Renamed_Job"}}]))
                .await;
        let mut session = Session::new(&state, data);
        session.rename_side_effect = Some(difference);
        let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
        assert_eq!(status.outcome, NativeJobOperationOutcome::Partial, "{difference}");
        assert_eq!(session.writes(), ["rename"]);
        if matches!(difference, "generation" | "third-name") {
            assert!(status.observed_identity.is_none());
        }
    }
}

#[tokio::test]
async fn legacy_body_edit_requires_an_exact_committed_readback_before_activation() {
    let data = legacy_database();
    let (_dir, state, native) = setup(&data).await;
    let target = NativeJobRef::Legacy { scope: native.scope().clone(), job_id: "41".into() };
    let body = "BEGIN work('O''ne'); END;  ";
    let plan = prepare(&state, &target, &data, json!([{"name":"WHAT","change":{"kind":"set","value":body}}])).await;
    let mut session = Session::new(&state, data);
    session.what_construction = Some(body.into());
    let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
    assert_eq!(status.outcome, NativeJobOperationOutcome::Verified);
    assert_eq!(session.writes(), ["pause", "legacy_what", "enable"]);
    assert_eq!(session.data.legacy.as_ref().unwrap()["WHAT"], json!(body));
    assert!(session.data.enabled);
}

#[tokio::test]
async fn legacy_body_construction_must_be_lossless_and_unknown_commit_cannot_enable_or_replay() {
    for construction in [None, Some("truncated"), Some("BEGIN 你好('\\'); END;  ")] {
        let data = legacy_database();
        let (_dir, state, native) = setup(&data).await;
        let target = NativeJobRef::Legacy { scope: native.scope().clone(), job_id: "41".into() };
        let body = "BEGIN 你好('\\'); END;  ";
        let plan = prepare(&state, &target, &data, json!([{"name":"WHAT","change":{"kind":"set","value":body}}])).await;
        let mut session = Session::new(&state, data);
        session.what_construction = construction.map(str::to_string);
        session.receipts.insert("legacy_what".into(), NativeJobDispatchOutcome::Unknown);
        let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
        if construction == Some(body) {
            assert_eq!(status.outcome, NativeJobOperationOutcome::Unknown);
            assert_eq!(session.writes(), ["pause", "legacy_what"]);
            assert!(!session.data.enabled);
        } else {
            assert_eq!(status.outcome, NativeJobOperationOutcome::NotApplied);
            assert!(session.writes().is_empty());
        }
        let calls = session.calls.clone();
        assert_eq!(native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap().outcome, status.outcome);
        assert_eq!(session.calls, calls);
    }
}

#[tokio::test]
async fn legacy_next_date_freezes_the_old_date_and_requires_exact_readback_after_activation() {
    for scenario in
        ["success", "construct-loss", "changed", "last-prewrite-change", "unknown", "advanced", "pause-date-drift"]
    {
        let mut data = legacy_database();
        data.legacy.as_mut().unwrap().insert("NEXT_DATE".into(), json!("2032-01-02 03:04:05"));
        data.legacy.as_mut().unwrap().insert("NEXT_SEC".into(), json!("03:04:05"));
        let (_dir, state, native) = setup(&data).await;
        let target = NativeJobRef::Legacy { scope: native.scope().clone(), job_id: "41".into() };
        let plan = prepare(
            &state,
            &target,
            &data,
            json!([{"name":"NEXT_DATE","change":{"kind":"set","value":"2032-02-03T04:05:06.123456000"}}]),
        )
        .await;
        let mut session = Session::new(&state, data);
        session.date_construction = Some(
            if scenario == "construct-loss" { "2032-02-03 04:05:06.123455" } else { " 2032-02-03 04:05:06.123456" }
                .into(),
        );
        session.date_change_on_read = match scenario {
            "changed" => Some(1),
            "last-prewrite-change" => Some(2),
            _ => None,
        };
        session.advance_on_enable = scenario == "advanced";
        session.date_change_on_pause = scenario == "pause-date-drift";
        if scenario == "unknown" {
            session.receipts.insert("legacy_next_date".into(), NativeJobDispatchOutcome::Unknown);
        }
        let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
        match scenario {
            "success" => assert_eq!(status.outcome, NativeJobOperationOutcome::Verified),
            "advanced" => assert_eq!(status.outcome, NativeJobOperationOutcome::Partial),
            "pause-date-drift" => {
                assert_eq!(status.outcome, NativeJobOperationOutcome::Partial);
                assert_eq!(session.writes(), ["pause"]);
            }
            "unknown" => {
                assert_eq!(status.outcome, NativeJobOperationOutcome::Unknown);
                assert_eq!(session.writes(), ["pause", "legacy_next_date"]);
                assert!(!session.data.enabled);
            }
            _ => {
                assert_eq!(status.outcome, NativeJobOperationOutcome::NotApplied, "{scenario}");
                assert!(session.writes().is_empty(), "{scenario}");
            }
        }
    }
}

#[tokio::test]
async fn legacy_mixed_body_and_date_preflight_failure_never_pauses_the_job() {
    let mut data = legacy_database();
    data.legacy.as_mut().unwrap().insert("NEXT_DATE".into(), json!("2032-01-02 03:04:05"));
    data.legacy.as_mut().unwrap().insert("NEXT_SEC".into(), json!("03:04:05"));
    let (_dir, state, native) = setup(&data).await;
    let target = NativeJobRef::Legacy { scope: native.scope().clone(), job_id: "41".into() };
    let plan = prepare(
        &state,
        &target,
        &data,
        json!([
            {"name":"WHAT","change":{"kind":"set","value":"new();  "}},
            {"name":"NEXT_DATE","change":{"kind":"set","value":"2032-02-03 04:05:06"}}
        ]),
    )
    .await;
    let mut session = Session::new(&state, data);
    session.what_construction = Some("new();  ".into());
    let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
    assert_eq!(status.outcome, NativeJobOperationOutcome::NotApplied);
    assert!(session.writes().is_empty());
    assert!(session.data.enabled);
}

#[tokio::test]
async fn legacy_interval_uses_the_owned_driver_and_preserves_custom_acceptance_after_enable() {
    for (input, expected) in [
        ("900719925474099312345", NativeJobOperationOutcome::Verified),
        ("SYSDATE+custom_next()", NativeJobOperationOutcome::Accepted),
    ] {
        let data = legacy_database();
        let (_dir, state, native) = setup(&data).await;
        let target = NativeJobRef::Legacy { scope: native.scope().clone(), job_id: "41".into() };
        let plan =
            prepare(&state, &target, &data, json!([{"name":"INTERVAL","change":{"kind":"set","value":input}}])).await;
        let mut session = Session::new(&state, data);
        let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
        assert_eq!(status.outcome, expected);
        assert_eq!(session.writes(), ["pause", "legacy_interval", "enable"]);
        assert!(session.data.enabled);
        assert_eq!(
            status.steps[1].state,
            if expected == NativeJobOperationOutcome::Accepted {
                NativeJobStepState::Accepted
            } else {
                NativeJobStepState::Applied
            }
        );
        assert_eq!(status.steps[2].state, NativeJobStepState::Applied);
        let calls = session.calls.clone();
        assert_eq!(native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap().outcome, expected);
        assert_eq!(session.calls, calls);
    }
}

#[tokio::test]
async fn legacy_interval_commit_unknown_is_not_promoted_by_same_session_values_or_replayed() {
    let data = legacy_database();
    let (_dir, state, native) = setup(&data).await;
    let target = NativeJobRef::Legacy { scope: native.scope().clone(), job_id: "41".into() };
    let plan = prepare(&state, &target, &data, json!([{"name":"INTERVAL","change":{"kind":"set","value":"60"}}])).await;
    let mut session = Session::new(&state, data);
    session.receipts.insert("legacy_interval".into(), NativeJobDispatchOutcome::Unknown);
    let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
    assert_eq!(status.outcome, NativeJobOperationOutcome::Unknown);
    assert_eq!(session.writes(), ["pause", "legacy_interval"]);
    assert_eq!(session.data.legacy.as_ref().unwrap()["INTERVAL"], json!("60"));
    assert!(!session.data.enabled);
    let calls = session.calls.clone();
    assert_eq!(
        native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap().outcome,
        NativeJobOperationOutcome::Unknown
    );
    assert_eq!(session.calls, calls);
}

#[tokio::test]
async fn legacy_custom_interval_stays_accepted_after_native_configuration_and_cleanup_must_succeed() {
    for cleanup_unknown in [false, true] {
        let data = legacy_database();
        let (_dir, state, native) = setup(&data).await;
        let target = NativeJobRef::Legacy { scope: native.scope().clone(), job_id: "41".into() };
        let plan = prepare(&state, &target, &data, json!([{"name":"DESCRIBE","change":{"kind":"set","value":"new"}}, {"name":"INTERVAL","change":{"kind":"set","value":"SYSDATE+custom_next()"}}])).await;
        let mut session = Session::new(&state, data);
        session.cleanup_unknown = cleanup_unknown;
        let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
        assert_eq!(
            session.writes(),
            ["pause", "definition", "config_start", "config_commit", "legacy_interval", "enable"]
        );
        assert_eq!(
            status.outcome,
            if cleanup_unknown { NativeJobOperationOutcome::Unknown } else { NativeJobOperationOutcome::Accepted }
        );
        assert_eq!(status.steps[4].state, NativeJobStepState::Accepted);
        assert!(session.data.enabled);
    }
}

#[tokio::test]
async fn legacy_interval_preservation_differences_stop_before_final_activation() {
    for difference in ["date", "body", "seconds", "schedule", "enable"] {
        let data = legacy_database();
        let (_dir, state, native) = setup(&data).await;
        let target = NativeJobRef::Legacy { scope: native.scope().clone(), job_id: "41".into() };
        let plan =
            prepare(&state, &target, &data, json!([{"name":"INTERVAL","change":{"kind":"set","value":"60"}}])).await;
        let mut session = Session::new(&state, data);
        session.interval_side_effect = Some(difference);
        let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
        assert_eq!(status.outcome, NativeJobOperationOutcome::Partial, "{difference}");
        assert_eq!(session.writes(), ["pause", "legacy_interval"], "{difference}");
    }
}

#[tokio::test]
async fn legacy_interval_checks_its_own_baseline_and_adjacent_body_changes() {
    for at in [1, 4] {
        let data = legacy_database();
        let (_dir, state, native) = setup(&data).await;
        let target = NativeJobRef::Legacy { scope: native.scope().clone(), job_id: "41".into() };
        let plan =
            prepare(&state, &target, &data, json!([{"name":"INTERVAL","change":{"kind":"set","value":"60"}}])).await;
        let mut session = Session::new(&state, data);
        session.legacy_change_on_read = Some(at);
        let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
        assert_eq!(
            status.outcome,
            if at == 1 { NativeJobOperationOutcome::NotApplied } else { NativeJobOperationOutcome::Partial }
        );
        assert_eq!(session.writes(), if at == 1 { vec![] } else { vec!["pause"] });
    }
}

#[tokio::test]
async fn legacy_interval_only_cannot_bypass_an_unknown_configuration_close() {
    let data = legacy_database();
    let (_dir, state, native) = setup(&data).await;
    let target = NativeJobRef::Legacy { scope: native.scope().clone(), job_id: "41".into() };
    let first =
        prepare(&state, &target, &data, json!([{"name":"DESCRIBE","change":{"kind":"set","value":"new"}}])).await;
    let mut session = Session::new(&state, data);
    session.receipts.insert("config_commit".into(), NativeJobDispatchOutcome::Unknown);
    assert_eq!(
        native_job_apply_with(&state, &first.plan_id, &mut session).await.unwrap().outcome,
        NativeJobOperationOutcome::Unknown
    );
    let interval =
        prepare(&state, &target, &session.data, json!([{"name":"INTERVAL","change":{"kind":"set","value":"60"}}]))
            .await;
    let mut next = Session::new(&state, session.data.clone());
    let status = native_job_apply_with(&state, &interval.plan_id, &mut next).await.unwrap();
    assert_eq!(status.outcome, NativeJobOperationOutcome::NotApplied);
    assert_eq!(status.reason.as_deref(), Some("native_job_configuration_preview_required"));
    assert!(next.writes().is_empty());
}

#[tokio::test]
async fn legacy_interval_requires_complete_child_coverage_without_restricting_native_only_edits() {
    for owner in ["Owner", "Other"] {
        let mut data = legacy_database();
        data.owner = owner;
        data.system_definition = true;
        if owner == "Owner" {
            data.steps.clear();
            data.schedules.clear();
        }
        let (_dir, state, native) = setup(&data).await;
        let target = NativeJobRef::Legacy { scope: native.scope().clone(), job_id: "41".into() };
        let plan =
            prepare(&state, &target, &data, json!([{"name":"INTERVAL","change":{"kind":"set","value":"60"}}])).await;
        let mut session = Session::new(&state, data.clone());
        let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
        assert_eq!(
            status.outcome,
            if owner == "Owner" { NativeJobOperationOutcome::Verified } else { NativeJobOperationOutcome::NotApplied }
        );
        if owner == "Other" {
            assert!(session.writes().is_empty());
            assert_eq!(status.reason.as_deref(), Some("native_job_legacy_coverage_incomplete"));
            let ordinary =
                prepare(&state, &target, &data, json!([{"name":"DESCRIBE","change":{"kind":"set","value":"new"}}]))
                    .await;
            let mut native_only = Session::new(&state, data);
            assert_eq!(
                native_job_apply_with(&state, &ordinary.plan_id, &mut native_only).await.unwrap().outcome,
                NativeJobOperationOutcome::Verified
            );
        }
    }
}

struct Session {
    state: Arc<AppState>,
    data: Database,
    leased: bool,
    calls: Vec<String>,
    receipts: BTreeMap<String, NativeJobDispatchOutcome>,
    read_count: usize,
    cancel_on_read: Option<(usize, String)>,
    cancel_on_step: Option<(String, String)>,
    readonly_on_read: Option<usize>,
    replace_on_read: Option<usize>,
    operator_denied: bool,
    cleanup_unknown: bool,
    leave_protocol_fields_unchanged: bool,
    wrong_operator: bool,
    sent_steps: Vec<NativeJobSqlStep>,
    replace_child_on_read: Option<(usize, String)>,
    tamper_unrelated: bool,
    hide_parts_after_drop: bool,
    interval_side_effect: Option<&'static str>,
    legacy_change_on_read: Option<usize>,
    rename_conflict: bool,
    rename_side_effect: Option<&'static str>,
    what_construction: Option<String>,
    date_construction: Option<String>,
    date_change_on_read: Option<usize>,
    advance_on_enable: bool,
    date_change_on_pause: bool,
}

impl Session {
    fn new(state: &Arc<AppState>, data: Database) -> Self {
        Self {
            state: state.clone(),
            data,
            leased: false,
            calls: vec![],
            receipts: BTreeMap::new(),
            read_count: 0,
            cancel_on_read: None,
            cancel_on_step: None,
            readonly_on_read: None,
            replace_on_read: None,
            operator_denied: false,
            cleanup_unknown: false,
            leave_protocol_fields_unchanged: false,
            wrong_operator: false,
            sent_steps: vec![],
            replace_child_on_read: None,
            tamper_unrelated: false,
            hide_parts_after_drop: false,
            interval_side_effect: None,
            legacy_change_on_read: None,
            rename_conflict: false,
            rename_side_effect: None,
            what_construction: None,
            date_construction: None,
            date_change_on_read: None,
            advance_on_enable: false,
            date_change_on_pause: false,
        }
    }
    fn writes(&self) -> Vec<&str> {
        self.calls.iter().filter_map(|call| call.strip_prefix("write:")).collect()
    }
}

#[async_trait::async_trait]
impl NativeJobMutationSession for Session {
    async fn begin_configure(&mut self, _: &str) -> Result<(), &'static str> {
        assert!(!self.leased);
        self.leased = true;
        self.calls.push("lease".into());
        Ok(())
    }
    async fn read(&mut self, target: &NativeJobRef) -> Result<NativeJobDetails, &'static str> {
        if !self.leased {
            return Err("fixture_configuration_read_requires_owned_physical_session");
        }
        self.read_count += 1;
        self.calls.push("read".into());
        if self.date_change_on_read == Some(self.read_count) {
            self.data.legacy.as_mut().unwrap().insert("NEXT_DATE".into(), json!("2032-01-03 03:04:05"));
        }
        if self.legacy_change_on_read == Some(self.read_count) {
            self.data.legacy.as_mut().unwrap().insert("WHAT".into(), json!("external_change();"));
        }
        if self.replace_on_read == Some(self.read_count) {
            self.data.created = "replacement";
        }
        if let Some((at, name)) = &self.replace_child_on_read {
            if *at == self.read_count {
                self.data
                    .steps
                    .iter_mut()
                    .find(|row| row["NAME"].as_str() == Some(name))
                    .unwrap()
                    .insert("ID".into(), json!(999));
            }
        }
        let details = read(&self.state, target, &self.data).await;
        if let Some((count, id)) = &self.cancel_on_read {
            if *count == self.read_count {
                native_job_cancel(&self.state, id);
            }
        }
        if self.readonly_on_read == Some(self.read_count) {
            self.state.configs.write().await.get_mut("c").unwrap().read_only = true;
        }
        Ok(details)
    }
    async fn query(&mut self, query: NativeJobCatalogQuery) -> Result<Value, NativeJobCatalogFailure> {
        assert!(self.leased);
        if query.source == "DUAL" {
            self.calls.push("what_construct".into());
            return Ok(result(
                &["DBX_WHAT", "DBX_NEXT_DATE"],
                json!([[self.what_construction, self.date_construction]]),
            ));
        }
        if matches!(query.source, "SYSJOB.SYSJOBS" | "SYSJOB.USER_JOBS_VIEW") {
            self.calls.push("lookup".into());
            if self.rename_conflict && query.sql.contains("UPPER(NAME) = UPPER(") {
                return Ok(result(&["DBX_JOB_ID", "NAME", "USERNAME"], json!([["99", "Renamed_Job", "Owner"]])));
            }
            return catalog(query, &self.data);
        }
        assert_eq!(query.source, "SYSJOB.SYSOPERATORS");
        self.calls.push("operators".into());
        if self.operator_denied {
            return Err(NativeJobCatalogFailure::Denied(Some(-5515)));
        }
        Ok(result(
            &["DBX_OPERATOR_ID", "NAME", "DBX_MATCH_EMAIL_OPERID", "DBX_MATCH_NETSEND_OPERID"],
            json!([["7", "OnCall", 1, 0]]),
        ))
    }
    async fn execute(&mut self, step: &NativeJobSqlStep) -> NativeJobStepReceipt {
        assert!(self.leased);
        self.calls.push(format!("write:{}", step.id));
        self.sent_steps.push(step.clone());
        let outcome = self.receipts.get(&step.id).copied().unwrap_or(NativeJobDispatchOutcome::Applied);
        if outcome != NativeJobDispatchOutcome::NotStarted {
            match step.id.as_str() {
                "create" => {
                    self.data.exists = true;
                    self.data.enabled = false;
                    self.data.description = "new";
                    self.data.valid = "N";
                }
                "pause" => {
                    self.data.enabled = false;
                    if self.date_change_on_pause {
                        self.data.legacy.as_mut().unwrap().insert("NEXT_DATE".into(), json!("2033-01-02 03:04:05"));
                    }
                }
                "definition" => {
                    self.data.description = "new";
                    if self.wrong_operator {
                        self.data.email_operator = 99;
                    }
                }
                "config_start" if !self.leave_protocol_fields_unchanged => self.data.valid = "N",
                "config_commit" if !self.leave_protocol_fields_unchanged => self.data.valid = "Y",
                "attribute:EP_SEQNO" => self.data.ep_seqno = 2,
                "enable" => {
                    self.data.enabled = true;
                    if self.advance_on_enable {
                        self.data
                            .legacy
                            .as_mut()
                            .unwrap()
                            .insert("NEXT_DATE".into(), json!("2033-02-03 04:05:06.123456"));
                    }
                }
                "rename" => {
                    let NativeJobStepEffect::DamengRenamed { new_name, .. } = &step.effect else { unreachable!() };
                    self.data.name = new_name.clone();
                    match self.rename_side_effect {
                        Some("generation") => self.data.created = "replacement",
                        Some("third-name") => self.data.name = "Third Name".into(),
                        Some("description") => self.data.description = "external description",
                        Some("schedule") => {
                            self.data.schedules[0].insert("ID".into(), json!(999));
                        }
                        _ => {}
                    }
                }
                "legacy_what" => {
                    let NativeJobStepEffect::DamengLegacyWhat { expected } = &step.effect else { unreachable!() };
                    self.data.legacy.as_mut().unwrap().insert("WHAT".into(), json!(expected));
                }
                "legacy_next_date" => {
                    let NativeJobStepEffect::DamengLegacyNextDate { expected } = &step.effect else { unreachable!() };
                    self.data.legacy.as_mut().unwrap().insert("NEXT_DATE".into(), json!(expected));
                    self.data.legacy.as_mut().unwrap().insert("NEXT_SEC".into(), json!("04:05:06"));
                }
                "legacy_interval" => {
                    let NativeJobStepEffect::DamengLegacyInterval { expected_seconds } = &step.effect else {
                        unreachable!()
                    };
                    self.data
                        .legacy
                        .as_mut()
                        .unwrap()
                        .insert("INTERVAL".into(), json!(expected_seconds.as_deref().unwrap_or("12345")));
                    match self.interval_side_effect {
                        Some("date") => {
                            self.data.legacy.as_mut().unwrap().insert("NEXT_DATE".into(), json!("changed date"));
                        }
                        Some("body") => {
                            self.data.legacy.as_mut().unwrap().insert("WHAT".into(), json!("changed();"));
                        }
                        Some("seconds") => {
                            self.data.legacy.as_mut().unwrap().insert("INTERVAL".into(), json!("999"));
                        }
                        Some("schedule") => {
                            self.data.schedules[0].insert("ID".into(), json!(999));
                        }
                        Some("enable") => self.data.enabled = true,
                        _ => {}
                    }
                }
                _ => {}
            }
            if let NativeJobStepEffect::DamengChild(child) = &step.effect {
                let rows = if child.part == NativeJobDamengPart::Steps {
                    &mut self.data.steps
                } else {
                    &mut self.data.schedules
                };
                match &child.action {
                    NativeJobDamengChildAction::Added => {
                        let id = 100 + rows.len();
                        let mut row: NativeJobRow =
                            serde_json::from_value(json!({"ID":id,"JOBID":41,"NAME":child.name})).unwrap();
                        if child.part == NativeJobDamengPart::Steps {
                            row.extend(serde_json::from_value::<NativeJobRow>(json!({"SEQNO":rows.len()+1,"DBNAME":"DB","SUCC_NEXT_STEP":null,"FAIL_NEXT_STEP":null})).unwrap());
                        } else {
                            row.extend(
                                serde_json::from_value::<NativeJobRow>(
                                    json!({"SCHNAME":"generated","TRIGNAME":"generated","VALID":"N"}),
                                )
                                .unwrap(),
                            );
                        }
                        row.extend(child.fields.clone());
                        for key in &child.acknowledged_fields {
                            row.insert(
                                key.clone(),
                                json!(if key == "COMMAND" {
                                    "native generated replacement command"
                                } else {
                                    "2026-10-21"
                                }),
                            );
                        }
                        rows.push(row);
                    }
                    NativeJobDamengChildAction::Changed => {
                        let row = rows
                            .iter_mut()
                            .find(|row| row["NAME"].as_str().is_some_and(|name| name.eq_ignore_ascii_case(&child.name)))
                            .unwrap();
                        row.extend(child.fields.clone());
                        for key in &child.acknowledged_fields {
                            row.insert(
                                key.clone(),
                                json!(if key == "COMMAND" {
                                    "native generated replacement command"
                                } else {
                                    "2026-10-21"
                                }),
                            );
                        }
                    }
                    NativeJobDamengChildAction::Renamed(name) => {
                        rows.iter_mut()
                            .find(|row| row["NAME"].as_str() == Some(&child.name))
                            .unwrap()
                            .insert("NAME".into(), json!(name));
                        // This fixture leaves old references unchanged, requiring the explicit link step.
                    }
                    NativeJobDamengChildAction::Dropped => {
                        rows.retain(|row| row["NAME"].as_str() != Some(&child.name));
                        if child.part == NativeJobDamengPart::Steps {
                            for (index, row) in rows.iter_mut().enumerate() {
                                row.insert("SEQNO".into(), json!(index + 1));
                            }
                        }
                        if self.hide_parts_after_drop {
                            self.data.system_parts = false;
                        }
                    }
                }
                if self.tamper_unrelated && child.part == NativeJobDamengPart::Steps {
                    self.data.schedules[0].insert("DESCRIBE".into(), json!("external edit"));
                }
            }
        }
        if let Some((at, id)) = &self.cancel_on_step {
            if at == &step.id {
                native_job_cancel(&self.state, id);
            }
        }
        NativeJobStepReceipt { outcome, reason: None, vendor_code: None }
    }
    async fn finish(&mut self) -> Result<(), &'static str> {
        self.calls.push("close".into());
        self.leased = false;
        if self.cleanup_unknown {
            Err("fixture_dispose_unknown")
        } else {
            Ok(())
        }
    }
}

fn description_change() -> Value {
    json!([{"name":"DESCRIBE","change":{"kind":"set","value":"new"}}])
}

async fn prepare_control(
    state: &AppState,
    target: &NativeJobRef,
    data: &Database,
    change: NativeJobChange,
) -> NativeJobPreparedPlan {
    let before = read(state, target, data).await;
    native_job_prepare_with(
        state,
        NativeJobMutation { target: target.clone(), baseline: before.snapshot.revision, change },
        |target| async move { Ok(read(state, &target, data).await) },
    )
    .await
    .unwrap()
}

async fn prepare_configuration(
    state: &AppState,
    target: &NativeJobRef,
    data: &Database,
    configuration: Value,
) -> NativeJobPreparedPlan {
    prepare_control(
        state,
        target,
        data,
        NativeJobChange::ConfigureDameng { configuration: serde_json::from_value(configuration).unwrap() },
    )
    .await
}

#[tokio::test]
async fn metadata_edit_uses_one_owned_session_and_preserves_notifications_steps_and_schedules() {
    let data = Database::default();
    let (_dir, state, target) = setup(&data).await;
    let plan = prepare(&state, &target, &data, description_change()).await;
    let mut session = Session::new(&state, data);
    let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
    assert!(
        status.outcome == NativeJobOperationOutcome::Verified,
        "configuration must complete on its owned connection"
    );
    assert_eq!(session.calls.first().map(String::as_str), Some("lease"));
    assert_eq!(session.calls.last().map(String::as_str), Some("close"));
    assert_eq!(session.writes(), ["pause", "definition", "config_start", "config_commit", "enable"]);
    assert!(
        session.calls.iter().position(|call| call == "operators").unwrap()
            < session.calls.iter().position(|call| call == "write:pause").unwrap()
    );
    assert!(session.data.enabled);
    assert_eq!(session.data.email_operator, 7);
}

#[tokio::test]
async fn missing_operator_privilege_blocks_only_the_dependent_edit_before_any_pause() {
    let data = Database::default();
    let (_dir, state, target) = setup(&data).await;
    let plan = prepare(&state, &target, &data, description_change()).await;
    let mut session = Session::new(&state, data.clone());
    session.operator_denied = true;
    let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
    assert!(status.outcome == NativeJobOperationOutcome::NotApplied);
    assert_eq!(status.reason.as_deref(), Some("native_job_notification_operator_unverified"));
    assert!(session.writes().is_empty());
    let data = Database { enabled: false, unreadable_parts: true, ..data };
    let plan = prepare(&state, &target, &data, json!([{"name":"EP_SEQNO","change":{"kind":"set","value":2}}])).await;
    let mut session = Session::new(&state, data);
    session.operator_denied = true;
    let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
    assert!(status.outcome == NativeJobOperationOutcome::Verified);
    assert_eq!(session.writes(), ["pause", "config_start", "attribute:EP_SEQNO", "config_commit"]);
    assert!(!session.calls.iter().any(|call| call == "operators"));
}

#[tokio::test]
async fn cancellation_or_readonly_arriving_during_preflight_never_dispatches_a_native_write() {
    for readonly in [false, true] {
        let data = Database::default();
        let (_dir, state, target) = setup(&data).await;
        let plan = prepare(&state, &target, &data, description_change()).await;
        let mut session = Session::new(&state, data);
        if readonly {
            session.readonly_on_read = Some(1);
        } else {
            session.cancel_on_read = Some((1, plan.operation_id.clone()));
        }
        let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
        assert!(status.outcome == NativeJobOperationOutcome::NotApplied);
        assert!(session.writes().is_empty());
        assert_eq!(session.calls.last().map(String::as_str), Some("close"));
    }
}

#[tokio::test]
async fn lost_start_or_commit_receipt_stays_unknown_even_when_definition_fields_match() {
    for stage in ["config_start", "config_commit"] {
        let data = Database::default();
        let (_dir, state, target) = setup(&data).await;
        let plan = prepare(&state, &target, &data, description_change()).await;
        let mut session = Session::new(&state, data);
        session.receipts.insert(stage.into(), NativeJobDispatchOutcome::Unknown);
        session.leave_protocol_fields_unchanged = true;
        let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
        assert!(status.outcome == NativeJobOperationOutcome::Unknown);
        assert_eq!(session.writes().last().copied(), Some(stage));
        assert!(!session.data.enabled);
        assert!(status.steps.iter().any(|step| step.id == stage && step.state == NativeJobStepState::Unknown));
        let count = session.calls.len();
        native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
        assert_eq!(session.calls.len(), count, "repeated apply must not replay the configuration");
    }
}

#[tokio::test]
async fn cancellation_after_start_closes_without_automatic_commit_or_activation() {
    let data = Database::default();
    let (_dir, state, target) = setup(&data).await;
    let plan = prepare(&state, &target, &data, description_change()).await;
    let mut session = Session::new(&state, data);
    session.cancel_on_step = Some(("config_start".into(), plan.operation_id.clone()));
    let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
    assert!(status.outcome == NativeJobOperationOutcome::Partial);
    assert_eq!(session.writes(), ["pause", "definition", "config_start"]);
    assert!(!session.data.enabled);
    assert_eq!(session.data.valid, "N");
}

#[tokio::test]
async fn ordinary_metadata_lost_receipt_can_be_resolved_by_exact_readback() {
    let data = Database::default();
    let (_dir, state, target) = setup(&data).await;
    let plan = prepare(&state, &target, &data, description_change()).await;
    let mut session = Session::new(&state, data);
    session.receipts.insert("definition".into(), NativeJobDispatchOutcome::Unknown);
    let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
    assert!(status.outcome == NativeJobOperationOutcome::Verified);
    assert_eq!(session.writes().iter().filter(|stage| **stage == "definition").count(), 1);
}

#[tokio::test]
async fn wrong_native_operator_or_replaced_generation_stops_the_remaining_configuration() {
    for replaced in [false, true] {
        let data = Database::default();
        let (_dir, state, target) = setup(&data).await;
        let plan = prepare(&state, &target, &data, description_change()).await;
        let mut session = Session::new(&state, data);
        if replaced {
            session.replace_on_read = Some(2);
        } else {
            session.wrong_operator = true;
        }
        let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
        assert!(status.outcome != NativeJobOperationOutcome::Verified);
        assert!(!session.writes().contains(&"config_start"));
        assert!(!session.writes().contains(&"enable"));
    }
}

#[tokio::test]
async fn final_activation_failure_preserves_confirmed_configuration_and_cleanup_unknown_is_not_success() {
    for cleanup in [false, true] {
        let data = Database::default();
        let (_dir, state, target) = setup(&data).await;
        let plan = prepare(&state, &target, &data, description_change()).await;
        let mut session = Session::new(&state, data);
        if cleanup {
            session.cleanup_unknown = true;
        } else {
            session.receipts.insert("enable".into(), NativeJobDispatchOutcome::NotStarted);
        }
        let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
        assert!(
            status.outcome
                == if cleanup { NativeJobOperationOutcome::Unknown } else { NativeJobOperationOutcome::Partial }
        );
        assert!(status
            .steps
            .iter()
            .any(|step| step.id == "config_commit" && step.state == NativeJobStepState::Applied));
        if !cleanup {
            assert!(!session.data.enabled);
        }
        assert_eq!(session.data.valid, "Y");
        assert_eq!(session.writes().iter().filter(|stage| **stage == "config_start").count(), 1);
    }
}

#[tokio::test]
async fn unknown_configuration_requires_a_new_cycle_even_if_a_previous_enable_or_run_preview_still_matches() {
    for control in [NativeJobChange::Enable, NativeJobChange::Run] {
        let data = Database { enabled: false, ..Default::default() };
        let (_dir, state, target) = setup(&data).await;
        let old = prepare_control(&state, &target, &data, control).await;
        let configure =
            prepare(&state, &target, &data, json!([{"name":"ENABLE","change":{"kind":"set","value":false}}])).await;
        let mut session = Session::new(&state, data.clone());
        session.leave_protocol_fields_unchanged = true;
        session.receipts.insert("config_commit".into(), NativeJobDispatchOutcome::Unknown);
        let status = native_job_apply_with(&state, &configure.plan_id, &mut session).await.unwrap();
        assert!(status.outcome == NativeJobOperationOutcome::Unknown);
        assert_eq!(session.data.valid, "Y");
        assert_eq!(session.data.description, data.description);
        let mut unused = Session::new(&state, session.data);
        let status = native_job_apply_with(&state, &old.plan_id, &mut unused).await.unwrap();
        assert!(status.outcome == NativeJobOperationOutcome::NotApplied);
        assert_eq!(status.reason.as_deref(), Some("native_job_configuration_preview_required"));
        assert!(unused.writes().is_empty());
    }
}

#[tokio::test]
async fn new_enable_preview_finishes_unknown_configuration_in_a_new_session_without_replaying_fields() {
    let data = Database::default();
    let (_dir, state, target) = setup(&data).await;
    let first = prepare(&state, &target, &data, description_change()).await;
    let mut session = Session::new(&state, data);
    session.receipts.insert("config_commit".into(), NativeJobDispatchOutcome::Unknown);
    assert!(
        native_job_apply_with(&state, &first.plan_id, &mut session).await.unwrap().outcome
            == NativeJobOperationOutcome::Unknown
    );
    let resume = prepare_control(&state, &target, &session.data, NativeJobChange::Enable).await;
    assert_eq!(
        resume.steps.iter().map(|step| step.id.as_str()).collect::<Vec<_>>(),
        ["pause", "config_start", "config_commit", "enable"]
    );
    let mut new_session = Session::new(&state, session.data);
    let status = native_job_apply_with(&state, &resume.plan_id, &mut new_session).await.unwrap();
    assert!(status.outcome == NativeJobOperationOutcome::Verified);
    assert_eq!(new_session.writes(), ["pause", "config_start", "config_commit", "enable"]);
    assert_eq!(new_session.data.description, "new");
    assert!(native_job_status(&state, &first.operation_id).outcome == NativeJobOperationOutcome::Unknown);
    let after = prepare_control(&state, &target, &new_session.data, NativeJobChange::Enable).await;
    assert_eq!(after.steps.len(), 1, "a confirmed new cycle resolves the pending-protocol guard");
}

#[tokio::test]
async fn a_confirmed_configuration_with_failed_activation_previews_and_executes_only_the_remaining_enable() {
    let data = Database::default();
    let (_dir, state, target) = setup(&data).await;
    let first = prepare(&state, &target, &data, description_change()).await;
    let mut session = Session::new(&state, data);
    session.receipts.insert("enable".into(), NativeJobDispatchOutcome::NotStarted);
    assert!(
        native_job_apply_with(&state, &first.plan_id, &mut session).await.unwrap().outcome
            == NativeJobOperationOutcome::Partial
    );
    let resume = prepare_control(&state, &target, &session.data, NativeJobChange::Enable).await;
    assert_eq!(resume.steps.iter().map(|step| step.id.as_str()).collect::<Vec<_>>(), ["enable"]);
    let mut ordinary = Session::new(&state, session.data);
    ordinary.leased = true;
    assert!(
        native_job_apply_with(&state, &resume.plan_id, &mut ordinary).await.unwrap().outcome
            == NativeJobOperationOutcome::Verified
    );
    assert_eq!(ordinary.writes(), ["enable"]);
    assert!(!ordinary.calls.iter().any(|call| call == "lease"));
}

#[tokio::test]
async fn a_configuration_call_known_not_started_does_not_create_a_spurious_recovery_requirement() {
    let data = Database::default();
    let (_dir, state, target) = setup(&data).await;
    let first = prepare(&state, &target, &data, description_change()).await;
    let mut session = Session::new(&state, data);
    session.receipts.insert("definition".into(), NativeJobDispatchOutcome::NotStarted);
    assert!(
        native_job_apply_with(&state, &first.plan_id, &mut session).await.unwrap().outcome
            == NativeJobOperationOutcome::Partial
    );
    let resume = prepare_control(&state, &target, &session.data, NativeJobChange::Enable).await;
    assert_eq!(resume.steps.len(), 1);
}

#[tokio::test]
async fn an_observed_incomplete_native_definition_uses_start_and_commit_even_without_a_local_operation_record() {
    let data = Database { enabled: false, valid: "N", ..Default::default() };
    let (_dir, state, target) = setup(&data).await;
    let plan = prepare_control(&state, &target, &data, NativeJobChange::Enable).await;
    assert_eq!(
        plan.steps.iter().map(|step| step.id.as_str()).collect::<Vec<_>>(),
        ["pause", "config_start", "config_commit", "enable"]
    );
    let mut session = Session::new(&state, data);
    assert!(
        native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap().outcome
            == NativeJobOperationOutcome::Verified
    );
}

#[tokio::test]
async fn step_and_schedule_edits_preserve_unmodified_native_configuration_on_the_owned_session() {
    let data = Database::default();
    let (_dir, state, target) = setup(&data).await;
    let plan = prepare_configuration(
        &state,
        &target,
        &data,
        json!({
            "steps":[{"kind":"update","name":"sql","attributes":[
                {"name":"COMMAND_INPUT","change":{"kind":"set","value":"BEGIN work('private'); END;"}},
                {"name":"RETRY_ATTEMPTS","change":{"kind":"set","value":3}}
            ]}],
            "schedules":[{"kind":"update","name":"weekly","attributes":[
                {"name":"ENABLE","change":{"kind":"set","value":true}},
                {"name":"DURING_END_DATE","change":{"kind":"set","value":"2027-01-01"}}
            ]}]
        }),
    )
    .await;
    let mut session = Session::new(&state, data.clone());
    let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
    assert!(status.outcome == NativeJobOperationOutcome::Verified, "{}", serde_json::to_value(&status).unwrap());
    assert_eq!(session.data.steps[0], data.steps[0]);
    assert_eq!(session.data.schedules[0], data.schedules[0]);
    assert_eq!(session.data.steps[1]["COMMAND"], "BEGIN work('private'); END;");
    assert_eq!(session.data.steps[1]["RETRY_ATTEMPTS"], 3);
    assert_eq!(session.data.schedules[1]["ENABLE"], true);
    assert_eq!(session.data.schedules[1]["DURING_END_DATE"], "2027-01-01");
    assert_eq!(session.data.email_operator, data.email_operator);
    assert!(session.data.enabled);
    assert_eq!(session.calls.first().map(String::as_str), Some("lease"));
    assert_eq!(session.calls.last().map(String::as_str), Some("close"));
    assert!(!session.calls.iter().any(|call| call == "operators"));
}

#[tokio::test]
async fn added_steps_use_acknowledged_native_ids_for_forward_links_without_rewriting_the_body() {
    let data = Database::default();
    let (_dir, state, target) = setup(&data).await;
    let body = "BEGIN work(':dbx_created_step_id', ':dbx_created_reference_id_0'); END;";
    let plan = prepare_configuration(&state, &target, &data, json!({"steps":[
        {"kind":"add","name":"new_a","attributes":[
            {"name":"COMMAND_INPUT","change":{"kind":"set","value":body}},
            {"name":"SUCC_ACTION","change":{"kind":"set","value":3}},
            {"name":"SUCC_NEXT_STEP","change":{"kind":"set","value":"new_b"}}
        ]},
        {"kind":"add","name":"new_b","attributes":[{"name":"COMMAND_INPUT","change":{"kind":"set","value":"SELECT 3;"}}]}
    ]})).await;
    let mut session = Session::new(&state, data);
    let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
    assert!(status.outcome == NativeJobOperationOutcome::Verified, "{}", serde_json::to_value(&status).unwrap());
    let linked =
        session.sent_steps.iter().find(|step| step.sql.contains("SP_JOB_STEP_SET_NEXT_STEP('Job_1', 'new_a'")).unwrap();
    assert!(linked.sql.contains("ID = 102") && linked.sql.contains("ID = 103"));
    assert!(!linked.sql.contains(":dbx_created"));
    assert_eq!(session.data.steps[2]["COMMAND"], body);
    assert_eq!(session.data.steps[2]["SUCC_NEXT_STEP"], "new_b");
    let added = session.sent_steps.iter().rposition(|step| step.sql.contains("SP_ADD_JOB_STEP_EX")).unwrap();
    let linked = session.sent_steps.iter().position(|step| step.sql.contains("SP_JOB_STEP_SET_NEXT_STEP")).unwrap();
    assert!(added < linked);
}

#[tokio::test]
async fn unknown_add_or_generated_command_receipt_never_adopts_matching_catalog_fields_or_replays() {
    for configuration in [
        json!({"steps":[{"kind":"add","name":"new_step","attributes":[{"name":"COMMAND_INPUT","change":{"kind":"set","value":"SELECT 2;"}}]}]}),
        json!({"steps":[{"kind":"update","name":"backup","attributes":[{"name":"COMMAND_INPUT","change":{"kind":"set","value":"01000000E:\\backups"}}]}]}),
        json!({"schedules":[{"kind":"add","name":"new_schedule"}]}),
    ] {
        let data = Database::default();
        let (_dir, state, target) = setup(&data).await;
        let plan = prepare_configuration(&state, &target, &data, configuration).await;
        let child = plan
            .steps
            .iter()
            .find(|step| step.id.starts_with("steps:") || step.id.starts_with("schedules:"))
            .unwrap()
            .id
            .clone();
        let mut session = Session::new(&state, data);
        session.receipts.insert(child.clone(), NativeJobDispatchOutcome::Unknown);
        let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
        assert!(status.outcome == NativeJobOperationOutcome::Unknown);
        assert_eq!(session.writes().last().copied(), Some(child.as_str()));
        assert!(!session.data.enabled);
        assert!(!session.writes().contains(&"config_commit"));
        let count = session.sent_steps.len();
        native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
        assert_eq!(session.sent_steps.len(), count);
    }
}

#[tokio::test]
async fn unknown_sql_step_receipt_is_resolved_by_exact_identity_and_complete_readback() {
    let data = Database::default();
    let (_dir, state, target) = setup(&data).await;
    let plan = prepare_configuration(&state, &target, &data, json!({"steps":[{"kind":"update","name":"sql","attributes":[{"name":"RETRY_INTERVAL","change":{"kind":"set","value":10}}]}]})).await;
    let child = plan.steps.iter().find(|step| step.id.starts_with("steps:")).unwrap().id.clone();
    let mut session = Session::new(&state, data);
    session.receipts.insert(child.clone(), NativeJobDispatchOutcome::Unknown);
    let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
    assert!(status.outcome == NativeJobOperationOutcome::Verified);
    assert_eq!(session.writes().iter().filter(|id| **id == child).count(), 1);
    assert_eq!(session.data.steps[1]["RETRY_INTERVAL"], 10);
}

#[tokio::test]
async fn cancellation_after_a_child_edit_preserves_it_and_new_preview_applies_only_the_remaining_changes() {
    let data = Database::default();
    let (_dir, state, target) = setup(&data).await;
    let plan = prepare_configuration(&state, &target, &data, json!({
        "steps":[{"kind":"update","name":"sql","attributes":[{"name":"RETRY_INTERVAL","change":{"kind":"set","value":10}}]}],
        "schedules":[{"kind":"drop","name":"weekly"}]
    })).await;
    let child = plan.steps.iter().find(|step| step.id.starts_with("steps:")).unwrap().id.clone();
    let mut session = Session::new(&state, data);
    session.cancel_on_step = Some((child.clone(), plan.operation_id.clone()));
    let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
    assert!(status.outcome == NativeJobOperationOutcome::Partial);
    assert_eq!(session.data.steps[1]["RETRY_INTERVAL"], 10);
    assert_eq!(session.data.schedules.len(), 2);
    assert!(!session.data.enabled);
    assert_eq!(session.writes().last().copied(), Some(child.as_str()));
    let resume = prepare_configuration(
        &state,
        &target,
        &session.data,
        json!({
            "attributes":[{"name":"ENABLE","change":{"kind":"set","value":true}}],
            "schedules":[{"kind":"drop","name":"weekly"}]
        }),
    )
    .await;
    assert!(!resume.steps.iter().any(|step| step.id.starts_with("steps:")));
    let mut next = Session::new(&state, session.data);
    let status = native_job_apply_with(&state, &resume.plan_id, &mut next).await.unwrap();
    assert!(status.outcome == NativeJobOperationOutcome::Verified);
    assert_eq!(next.data.steps[1]["RETRY_INTERVAL"], 10);
    assert_eq!(next.data.schedules.len(), 1);
    assert!(next.data.enabled);
}

#[tokio::test]
async fn renaming_a_step_keeps_identity_and_explicitly_repairs_references_not_updated_by_the_database() {
    let data = Database::default();
    let (_dir, state, target) = setup(&data).await;
    let plan = prepare_configuration(&state, &target, &data, json!({"steps":[{"kind":"update","name":"sql","attributes":[{"name":"NAME","change":{"kind":"set","value":"renamed"}}]}]})).await;
    let mut session = Session::new(&state, data);
    let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
    assert!(status.outcome == NativeJobOperationOutcome::Verified);
    assert_eq!(session.data.steps[1]["ID"], 12);
    assert_eq!(session.data.steps[1]["NAME"], "renamed");
    assert_eq!(session.data.steps[0]["SUCC_NEXT_STEP"], "renamed");
    assert!(session
        .sent_steps
        .iter()
        .any(|step| step.sql.contains("SP_JOB_STEP_SET_NEXT_STEP('Job_1', 'backup', 'renamed', NULL)")));
}

#[tokio::test]
async fn referenced_steps_are_dropped_only_after_link_correction_and_surviving_order_is_preserved() {
    let data = Database::default();
    let (_dir, state, target) = setup(&data).await;
    let plan = prepare_configuration(&state, &target, &data, json!({"steps":[
        {"kind":"drop","name":"backup"},
        {"kind":"add","name":"last_step","attributes":[{"name":"COMMAND_INPUT","change":{"kind":"set","value":"SELECT 2;"}}]}
    ]})).await;
    let mut session = Session::new(&state, data);
    let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
    assert!(status.outcome == NativeJobOperationOutcome::Verified, "{}", serde_json::to_value(&status).unwrap());
    assert_eq!(
        session.data.steps.iter().map(|row| row["NAME"].as_str().unwrap()).collect::<Vec<_>>(),
        ["sql", "last_step"]
    );
    assert_eq!(session.data.steps[0]["SEQNO"], 1);
    let cleared = session
        .sent_steps
        .iter()
        .position(|step| step.sql.contains("SP_JOB_STEP_SET_NEXT_STEP('Job_1', 'backup', NULL, NULL)"))
        .unwrap();
    let dropped =
        session.sent_steps.iter().position(|step| step.sql.contains("SP_DROP_JOB_STEP('Job_1', 'backup')")).unwrap();
    assert!(cleared < dropped);
}

#[tokio::test]
async fn external_child_replacement_before_a_forward_link_stops_without_linking_the_replacement() {
    let data = Database::default();
    let (_dir, state, target) = setup(&data).await;
    let plan = prepare_configuration(
        &state,
        &target,
        &data,
        json!({"steps":[
            {"kind":"update","name":"sql","attributes":[{"name":"NAME","change":{"kind":"set","value":"renamed"}}]}
        ]}),
    )
    .await;
    let mut session = Session::new(&state, data);
    // initial + (pre/post pause) + (pre/post START) + (pre/post rename) + link preflight
    session.replace_child_on_read = Some((8, "renamed".into()));
    let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
    assert!(status.outcome == NativeJobOperationOutcome::Partial);
    assert_eq!(status.reason.as_deref(), Some("native_job_definition_changed"));
    assert!(!session.sent_steps.iter().any(|step| step.sql.contains("SP_JOB_STEP_SET_NEXT_STEP")));
    assert!(!session.writes().contains(&"config_commit"));
}

#[tokio::test]
async fn unrelated_catalog_mutation_after_a_step_edit_prevents_configuration_commit_and_activation() {
    let data = Database::default();
    let (_dir, state, target) = setup(&data).await;
    let plan = prepare_configuration(&state, &target, &data, json!({"steps":[{"kind":"update","name":"sql","attributes":[{"name":"RETRY_INTERVAL","change":{"kind":"set","value":10}}]}]})).await;
    let mut session = Session::new(&state, data);
    session.tamper_unrelated = true;
    let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
    assert!(status.outcome == NativeJobOperationOutcome::Partial);
    assert!(!session.writes().contains(&"config_commit"));
    assert!(!session.data.enabled);
}

#[tokio::test]
async fn loss_of_global_child_visibility_does_not_prove_another_owners_step_was_deleted() {
    let data = Database { owner:"Other", system_definition:true, system_parts:true, schedules:vec![], steps:vec![
        serde_json::from_value(json!({"ID":12,"JOBID":41,"NAME":"sql","SEQNO":1,"TYPE":0,"DBNAME":"DB","COMMAND":"SELECT 1;","SUCC_ACTION":1,"FAIL_ACTION":1,"RETRY_ATTEMPTS":0,"RETRY_INTERVAL":0,"OUTPUT_FILE_PATH":null,"APPEND_FLAG":0,"SUCC_NEXT_STEP":null,"FAIL_NEXT_STEP":null,"DESCRIBE":null})).unwrap()
    ], ..Default::default() };
    let (_dir, state, target) = setup(&data).await;
    let plan = prepare_configuration(&state, &target, &data, json!({"steps":[{"kind":"drop","name":"sql"}]})).await;
    let child = plan.steps.iter().find(|step| step.id.starts_with("steps:")).unwrap().id.clone();
    let mut session = Session::new(&state, data);
    session.hide_parts_after_drop = true;
    session.receipts.insert(child, NativeJobDispatchOutcome::Unknown);
    let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
    assert!(status.outcome == NativeJobOperationOutcome::Unknown);
    assert!(!session.writes().contains(&"config_commit"));
    assert!(!session.data.enabled);
}

#[tokio::test]
async fn an_empty_rebased_draft_still_previews_pending_configuration_termination_without_replaying_fields() {
    for lost_commit in [false, true] {
        let data = Database { enabled: false, ..Default::default() };
        let (_dir, state, target) = setup(&data).await;
        let plan = prepare_configuration(&state, &target, &data, json!({"steps":[{"kind":"update","name":"sql","attributes":[{"name":"RETRY_INTERVAL","change":{"kind":"set","value":10}}]}]})).await;
        let child = plan.steps.iter().find(|step| step.id.starts_with("steps:")).unwrap().id.clone();
        let mut session = Session::new(&state, data);
        if lost_commit {
            session.receipts.insert("config_commit".into(), NativeJobDispatchOutcome::Unknown);
        } else {
            session.cancel_on_step = Some((child, plan.operation_id.clone()));
        }
        let first = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
        assert!(
            first.outcome
                == if lost_commit { NativeJobOperationOutcome::Unknown } else { NativeJobOperationOutcome::Partial }
        );
        assert_eq!(session.data.steps[1]["RETRY_INTERVAL"], 10);
        let resume = prepare_configuration(&state, &target, &session.data, json!({})).await;
        assert_eq!(
            resume.steps.iter().map(|step| step.id.as_str()).collect::<Vec<_>>(),
            ["pause", "config_start", "config_commit"]
        );
        let mut next = Session::new(&state, session.data);
        let status = native_job_apply_with(&state, &resume.plan_id, &mut next).await.unwrap();
        assert!(status.outcome == NativeJobOperationOutcome::Verified);
        assert!(!next.data.enabled);
        assert_eq!(next.data.steps[1]["RETRY_INTERVAL"], 10);
        let after = prepare_control(&state, &target, &next.data, NativeJobChange::Enable).await;
        assert_eq!(after.steps.len(), 1);
    }
}

#[tokio::test]
async fn unknown_link_after_an_acknowledged_add_can_be_verified_using_the_captured_child_id() {
    let data = Database::default();
    let (_dir, state, target) = setup(&data).await;
    let plan = prepare_configuration(
        &state,
        &target,
        &data,
        json!({"steps":[{"kind":"add","name":"new_step","attributes":[
            {"name":"COMMAND_INPUT","change":{"kind":"set","value":"SELECT 2;"}},
            {"name":"SUCC_ACTION","change":{"kind":"set","value":3}},
            {"name":"SUCC_NEXT_STEP","change":{"kind":"set","value":"sql"}}
        ]}]}),
    )
    .await;
    let linked = plan.steps.iter().find(|step| step.sql.contains("SP_JOB_STEP_SET_NEXT_STEP")).unwrap().id.clone();
    let mut session = Session::new(&state, data);
    session.receipts.insert(linked.clone(), NativeJobDispatchOutcome::Unknown);
    let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
    assert!(status.outcome == NativeJobOperationOutcome::Verified);
    assert_eq!(session.writes().iter().filter(|id| **id == linked).count(), 1);
}

fn absent_database() -> Database {
    Database { exists: false, steps: vec![], schedules: vec![], ..Default::default() }
}

async fn prepare_create(state: &AppState, target: &NativeJobRef, enabled: bool) -> NativeJobPreparedPlan {
    let request:NativeJobRequest = serde_json::from_value(json!({
        "action":"create", "scope":target.scope(),
        "definition":{"kind":"dameng-native", "name":"Job_1", "enabled":enabled,
            "configuration":{
                "attributes":[
                    {"name":"DESCRIBE","change":{"kind":"set","value":"new"}},
                    {"name":"ENABLE_EMAIL","change":{"kind":"set","value":true}},
                    {"name":"EMAIL_OPERATOR_NAME","change":{"kind":"set","value":"OnCall"}},
                    {"name":"EMAIL_TYPE","change":{"kind":"set","value":2}},
                    {"name":"NETSEND_TYPE","change":{"kind":"set","value":1}}
                ],
                "steps":[
                    {"kind":"add","name":"first","attributes":[
                        {"name":"COMMAND_INPUT","change":{"kind":"set","value":"SELECT 1;"}},
                        {"name":"SUCC_ACTION","change":{"kind":"set","value":3}},
                        {"name":"SUCC_NEXT_STEP","change":{"kind":"set","value":"last"}}
                    ]},
                    {"kind":"add","name":"last","attributes":[{"name":"TYPE","change":{"kind":"set","value":3}}]}
                ],
                "schedules":[{"kind":"add","name":"daily","attributes":[{"name":"DURING_START_DATE","change":{"kind":"set","value":"2026-10-21"}}]}]
            }
        }
    })).unwrap();
    native_job_prepare_request_with(state, request, |_| async {
        panic!("no invented ID may be read during creation preview")
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn native_create_uses_one_physical_session_and_activates_only_after_configuration_is_verified() {
    for enabled in [false, true] {
        let data = absent_database();
        let (_dir, state, target) = setup(&data).await;
        let plan = prepare_create(&state, &target, enabled).await;
        assert!(plan.target.is_none());
        let mut session = Session::new(&state, data);
        let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
        assert!(status.outcome == NativeJobOperationOutcome::Verified, "{:?}", status.reason);
        assert_eq!(status.target, Some(target));
        assert_eq!(session.calls.first().unwrap(), "lease");
        assert_eq!(session.calls.last().unwrap(), "close");
        assert_eq!(session.data.enabled, enabled);
        assert_eq!(session.data.valid, "Y");
        assert_eq!(session.data.steps.len(), 2);
        assert_eq!(status.created_children.len(), 3);
        assert_eq!(status.created_children[0].partition, "steps");
        assert_eq!(status.created_children[0].name, "first");
        assert_eq!(status.created_children[0].id, "100");
        assert_eq!(session.data.steps[0]["SUCC_NEXT_STEP"], "last");
        assert_eq!(session.data.schedules.len(), 1);
        let commit = session.writes().iter().position(|id| *id == "config_commit").unwrap();
        assert!(session.writes().iter().position(|id| *id == "enable").is_none_or(|enable| enable > commit));
        assert!(status.steps.iter().all(|step| step.state == NativeJobStepState::Applied));
    }
}

#[tokio::test]
async fn create_refuses_an_existing_native_name_without_altering_or_initializing_it() {
    let data = Database::default();
    let (_dir, state, target) = setup(&data).await;
    let plan = prepare_create(&state, &target, true).await;
    let mut session = Session::new(&state, data);
    let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
    assert!(status.outcome == NativeJobOperationOutcome::NotApplied);
    assert_eq!(status.reason.as_deref(), Some("native_job_creation_target_not_absent"));
    assert!(session.writes().is_empty());
    assert_eq!(session.data.description, "old");
}

#[tokio::test]
async fn lost_create_receipt_does_not_adopt_or_activate_a_same_name_job_and_duplicate_apply_does_not_recreate() {
    let data = absent_database();
    let (_dir, state, target) = setup(&data).await;
    let plan = prepare_create(&state, &target, true).await;
    let mut session = Session::new(&state, data);
    session.receipts.insert("create".into(), NativeJobDispatchOutcome::Unknown);
    let first = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
    assert!(first.outcome == NativeJobOperationOutcome::Unknown);
    assert!(first.target.is_none());
    assert_eq!(session.writes(), ["create"]);
    assert!(!session.data.enabled);
    let again = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
    assert!(again.outcome == NativeJobOperationOutcome::Unknown);
    assert_eq!(session.writes(), ["create"]);
}

#[tokio::test]
async fn cancel_after_create_keeps_the_exact_disabled_job_and_requires_fresh_configuration_before_enable() {
    let data = absent_database();
    let (_dir, state, target) = setup(&data).await;
    let plan = prepare_create(&state, &target, true).await;
    let mut session = Session::new(&state, data);
    session.cancel_on_step = Some(("create".into(), plan.operation_id.clone()));
    let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
    assert!(status.outcome == NativeJobOperationOutcome::Partial);
    assert_eq!(status.target, Some(target.clone()));
    assert_eq!(session.writes(), ["create"]);
    assert!(!session.data.enabled);
    let resume = prepare_control(&state, &target, &session.data, NativeJobChange::Enable).await;
    assert_eq!(
        resume.steps.iter().map(|step| step.id.as_str()).collect::<Vec<_>>(),
        ["pause", "config_start", "config_commit", "enable"]
    );
}

#[tokio::test]
async fn create_commit_unknown_never_enables_and_corrected_existing_job_does_not_recreate() {
    let data = absent_database();
    let (_dir, state, target) = setup(&data).await;
    let plan = prepare_create(&state, &target, true).await;
    let mut session = Session::new(&state, data);
    session.receipts.insert("config_commit".into(), NativeJobDispatchOutcome::Unknown);
    let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
    assert!(status.outcome == NativeJobOperationOutcome::Unknown);
    assert_eq!(status.target, Some(target.clone()));
    assert!(!session.data.enabled);
    assert!(!session.writes().contains(&"enable"));
    let resume = prepare_configuration(&state, &target, &session.data, json!({})).await;
    assert_eq!(
        resume.steps.iter().map(|step| step.id.as_str()).collect::<Vec<_>>(),
        ["pause", "config_start", "config_commit"]
    );
    assert!(!resume
        .steps
        .iter()
        .any(|step| step.id == "create" || step.id.starts_with("steps:") || step.id.starts_with("schedules:")));
}

#[tokio::test]
async fn creation_operator_preflight_failure_never_creates_a_job() {
    let data = absent_database();
    let (_dir, state, target) = setup(&data).await;
    let plan = prepare_create(&state, &target, true).await;
    let mut session = Session::new(&state, data);
    session.operator_denied = true;
    let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
    assert!(status.outcome == NativeJobOperationOutcome::NotApplied);
    assert!(session.writes().is_empty());
    assert!(!session.data.exists);
}

#[tokio::test]
async fn create_final_enable_failure_repreviews_only_enable_without_replaying_create_or_configuration() {
    let data = absent_database();
    let (_dir, state, target) = setup(&data).await;
    let plan = prepare_create(&state, &target, true).await;
    let mut session = Session::new(&state, data);
    session.receipts.insert("enable".into(), NativeJobDispatchOutcome::NotStarted);
    let status = native_job_apply_with(&state, &plan.plan_id, &mut session).await.unwrap();
    assert!(status.outcome == NativeJobOperationOutcome::Partial);
    assert_eq!(status.target, Some(target.clone()));
    assert!(!session.data.enabled);
    assert_eq!(session.data.valid, "Y");
    let next = prepare_control(&state, &target, &session.data, NativeJobChange::Enable).await;
    assert_eq!(next.steps.iter().map(|step| step.id.as_str()).collect::<Vec<_>>(), ["enable"]);
}
