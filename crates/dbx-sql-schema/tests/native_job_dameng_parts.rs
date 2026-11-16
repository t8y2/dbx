use dbx_sql_schema::native_job_changes::{
    native_job_dameng_child_key, native_job_mutation_plan, resolve_native_job_dameng_child_step, NativeJobDamengPart,
};
use dbx_types::native_jobs::*;
use serde_json::json;

fn details() -> NativeJobDetails {
    serde_json::from_value(json!({
        "snapshot":{"ref":{"kind":"dameng-native","scope":{"connectionId":"c","database":"","contextId":"ctx"},"jobId":"41","name":"Job_1"},"revision":"baseline",
            "definition":{"status":"available","value":{"ID":41,"DBX_JOB_ID":"41","NAME":"Job_1","USERNAME":"Owner","CREATETIME":"creation","ENABLE":true,"ENABLE_EMAIL":1,"EMAIL_OPERID":7,"EMAIL_TYPE":2,"ENABLE_NETSEND":0,"NETSEND_OPERID":-1,"NETSEND_TYPE":1,"DESCRIBE":"kept","VALID":"Y","EP_SEQNO":0,"RAFT_NAME":null}},
            "arguments":{"status":"available","value":[]}},
        "nativeIdentity":{"status":"available","value":{"DBX_JOB_ID":"41","DBX_CREATED_AT":"creation"}},"consistency":{"status":"available","value":null},"parameterMetadata":{"status":"unsupported","reason":"not_applicable"},
        "steps":{"status":"available","value":[
            {"ID":11,"NAME":"backup","JOBID":41,"SEQNO":1,"TYPE":6,"DBNAME":"DB","COMMAND":"native generated backup command","SUCC_ACTION":3,"FAIL_ACTION":1,"RETRY_ATTEMPTS":2,"RETRY_INTERVAL":1,"OUTPUT_FILE_PATH":null,"APPEND_FLAG":0,"SUCC_NEXT_STEP":"sql","FAIL_NEXT_STEP":null,"DESCRIBE":"keep backup"},
            {"ID":12,"NAME":"sql","JOBID":41,"SEQNO":2,"TYPE":0,"DBNAME":"DB","COMMAND":"SELECT 1;","SUCC_ACTION":1,"FAIL_ACTION":1,"RETRY_ATTEMPTS":0,"RETRY_INTERVAL":0,"OUTPUT_FILE_PATH":null,"APPEND_FLAG":0,"SUCC_NEXT_STEP":null,"FAIL_NEXT_STEP":null,"DESCRIBE":"old sql"}
        ]},
        "schedules":{"status":"available","value":[
            {"ID":21,"NAME":"daily","JOBID":41,"ENABLE":1,"TYPE":1,"FREQ_INTERVAL":1,"FREQ_SUB_INTERVAL":0,"FREQ_MINUTE_INTERVAL":5,"STARTTIME":"23:00:00","ENDTIME":"01:00:00","DURING_START_DATE":"2026-10-21","DURING_END_DATE":"2026-12-31","SCHNAME":"sch1","TRIGNAME":"trig1","VALID":"Y","DESCRIBE":"keep daily"},
            {"ID":22,"NAME":"weekly","JOBID":41,"ENABLE":0,"TYPE":2,"FREQ_INTERVAL":2,"FREQ_SUB_INTERVAL":68,"FREQ_MINUTE_INTERVAL":0,"STARTTIME":"09:00:00","ENDTIME":null,"DURING_START_DATE":"2026-10-21","DURING_END_DATE":null,"SCHNAME":"sch2","TRIGNAME":"trig2","VALID":"Y","DESCRIBE":"keep weekly"}
        ]},
        "running":{"status":"unknown","reason":"not_readable"},"history":{"status":"empty"},
        "sources":{"identity":{"source":"SYSJOB.USER_JOBS_VIEW","coverage":"current_user"},"definition":{"source":"SYSJOB.USER_JOBS_VIEW","coverage":"current_user"},"steps":{"source":"SYSJOB.USER_JOBSTEPS_VIEW","coverage":"current_user"},"schedules":{"source":"SYSJOB.USER_JOBSCHEDULES_VIEW","coverage":"current_user"}}
    })).unwrap()
}

fn request(data: &NativeJobDetails, configuration: serde_json::Value) -> NativeJobMutation {
    NativeJobMutation {
        target: data.snapshot.job_ref.clone(),
        baseline: data.snapshot.revision.clone(),
        change: NativeJobChange::ConfigureDameng { configuration: serde_json::from_value(configuration).unwrap() },
    }
}

#[test]
fn editing_one_sql_step_preserves_other_steps_schedules_and_notifications() {
    let data = details();
    let change = request(
        &data,
        json!({"steps":[{"kind":"update","name":"sql","attributes":[
            {"name":"COMMAND_INPUT","change":{"kind":"set","value":"BEGIN work('private'); END;"}},
            {"name":"RETRY_ATTEMPTS","change":{"kind":"set","value":3}}
        ]}]}),
    );
    let plan = native_job_mutation_plan(NativeJobEngine::Dameng, &change, &data).unwrap();
    let sql = plan.steps.iter().map(|step| step.sql.as_str()).collect::<Vec<_>>().join("\n");
    assert!(sql.contains(
        "SP_ALTER_JOB_STEP_EX('Job_1', 'sql', 0, 'BEGIN work(''private''); END;', 1, 1, 3, 0, NULL, 0, 'old sql')"
    ));
    assert!(!sql.contains("native generated backup command"));
    assert!(!sql.contains("SP_ALTER_JOB("));
    assert!(!sql.contains("SP_ALTER_JOB_SCHEDULE"));
    assert_eq!(plan.required_partitions, ["definition", "steps"]);
    assert_eq!(plan.steps.last().unwrap().id, "enable");
}

#[test]
fn new_steps_are_all_added_before_forward_dependencies_are_linked() {
    let data = details();
    let change = request(
        &data,
        json!({"steps":[
            {"kind":"add","name":"new_a","attributes":[{"name":"COMMAND_INPUT","change":{"kind":"set","value":"SELECT 2;"}},{"name":"SUCC_ACTION","change":{"kind":"set","value":3}},{"name":"SUCC_NEXT_STEP","change":{"kind":"set","value":"new_b"}}]},
            {"kind":"add","name":"new_b","attributes":[{"name":"COMMAND_INPUT","change":{"kind":"set","value":"SELECT 3;"}}]}
        ]}),
    );
    let plan = native_job_mutation_plan(NativeJobEngine::Dameng, &change, &data).unwrap();
    let statements = plan.steps.iter().map(|step| step.sql.as_str()).collect::<Vec<_>>();
    let added = statements.iter().rposition(|sql| sql.contains("SP_ADD_JOB_STEP_EX")).unwrap();
    let linked = statements.iter().position(|sql| sql.contains("SP_JOB_STEP_SET_NEXT_STEP")).unwrap();
    assert!(added < linked);
    assert!(statements[linked].contains("'new_a', 'new_b', NULL"));
    assert!(statements[linked].contains(":dbx_created_step_id"));
}

#[test]
fn generated_backup_commands_need_explicit_native_input_only_when_altering_the_step_definition() {
    let data = details();
    let config = json!({"steps":[{"kind":"update","name":"backup","attributes":[{"name":"DESCRIBE","change":{"kind":"set","value":"new"}}]}]});
    assert_eq!(
        native_job_mutation_plan(NativeJobEngine::Dameng, &request(&data, config), &data).err(),
        Some("native_job_step_command_input_required")
    );
    let config = json!({"steps":[{"kind":"update","name":"backup","attributes":[
        {"name":"DESCRIBE","change":{"kind":"set","value":"new"}},
        {"name":"COMMAND_INPUT","change":{"kind":"set","value":"01000000E:\\backups"}}
    ]}]});
    let plan = native_job_mutation_plan(NativeJobEngine::Dameng, &request(&data, config), &data).unwrap();
    assert!(plan.steps.iter().any(|step| step.sql.contains("'01000000E:\\backups'")));
    let config = json!({"steps":[{"kind":"update","name":"backup","attributes":[{"name":"FAIL_NEXT_STEP","change":{"kind":"clear"}}]}]});
    assert!(native_job_mutation_plan(NativeJobEngine::Dameng, &request(&data, config), &data).is_ok());
}

#[test]
fn dropping_a_referenced_step_requires_a_correction_and_applies_it_before_the_drop() {
    let data = details();
    let config = json!({"steps":[{"kind":"drop","name":"sql"}]});
    assert_eq!(
        native_job_mutation_plan(NativeJobEngine::Dameng, &request(&data, config), &data).err(),
        Some("native_job_step_dependency_requires_correction")
    );
    let config = json!({"steps":[{"kind":"drop","name":"sql"},{"kind":"update","name":"backup","attributes":[{"name":"SUCC_NEXT_STEP","change":{"kind":"clear"}}]}]});
    let plan = native_job_mutation_plan(NativeJobEngine::Dameng, &request(&data, config), &data).unwrap();
    let linked = plan.steps.iter().position(|step| step.sql.contains("SP_JOB_STEP_SET_NEXT_STEP")).unwrap();
    let dropped = plan.steps.iter().position(|step| step.sql.contains("SP_DROP_JOB_STEP")).unwrap();
    assert!(linked < dropped);
    assert!(plan.steps[dropped].sql.contains("ID = 12"));
}

#[test]
fn renaming_a_step_preserves_its_native_id_and_retargets_existing_dependencies_explicitly() {
    let data = details();
    let config = json!({"steps":[{"kind":"update","name":"sql","attributes":[{"name":"NAME","change":{"kind":"set","value":"renamed"}}]}]});
    let plan = native_job_mutation_plan(NativeJobEngine::Dameng, &request(&data, config), &data).unwrap();
    let renamed = plan.steps.iter().position(|step| step.sql.contains("SP_RENAME_JOB_STEP")).unwrap();
    let links = plan
        .steps
        .iter()
        .position(|step| step.sql.contains("SP_JOB_STEP_SET_NEXT_STEP('Job_1', 'backup', 'renamed', NULL)"))
        .unwrap();
    assert!(renamed < links);
    assert!(plan.steps[renamed].sql.contains("ID = 12"));
    assert!(!plan
        .steps
        .iter()
        .any(|step| step.sql.contains("SP_DROP_JOB_STEP") || step.sql.contains("SP_ALTER_JOB_STEP")));
}

#[test]
fn schedules_keep_full_native_options_and_clear_only_requested_values() {
    let data = details();
    let config = json!({"schedules":[{"kind":"update","name":"weekly","attributes":[{"name":"ENABLE","change":{"kind":"set","value":true}},{"name":"DURING_END_DATE","change":{"kind":"clear"}}]}]});
    let plan = native_job_mutation_plan(NativeJobEngine::Dameng, &request(&data, config), &data).unwrap();
    assert!(plan.steps.iter().any(|step| step.sql.contains(
        "SP_ALTER_JOB_SCHEDULE('Job_1', 'weekly', 1, 2, 2, 68, 0, '09:00:00', NULL, '2026-10-21', NULL, 'keep weekly')"
    )));
    assert_eq!(plan.required_partitions, ["definition", "schedules"]);
    assert!(!plan.steps.iter().any(|step| step.sql.contains("SP_ALTER_JOB_STEP") || step.sql.contains("'keep daily'")));
}

#[test]
fn a_denied_unrelated_partition_does_not_block_a_valid_schedule_edit() {
    let mut data = details();
    data.steps = NativeJobMetadata::Denied { reason: "not_readable".into() };
    let config = json!({"schedules":[{"kind":"drop","name":"weekly"}]});
    assert!(native_job_mutation_plan(NativeJobEngine::Dameng, &request(&data, config), &data).is_ok());
    data.schedules = NativeJobMetadata::Truncated { value: vec![], limit: 1 };
    let config = json!({"schedules":[{"kind":"drop","name":"weekly"}]});
    assert_eq!(
        native_job_mutation_plan(NativeJobEngine::Dameng, &request(&data, config), &data).err(),
        Some("native_job_metadata_incomplete")
    );
}

#[test]
fn changing_a_generated_step_to_sql_needs_original_input_and_never_reuses_generated_command() {
    let data = details();
    let config = json!({"steps":[{"kind":"update","name":"backup","attributes":[{"name":"TYPE","change":{"kind":"set","value":0}}]}]});
    assert_eq!(
        native_job_mutation_plan(NativeJobEngine::Dameng, &request(&data, config), &data).err(),
        Some("native_job_step_command_input_required")
    );
    let config = json!({"steps":[{"kind":"update","name":"backup","attributes":[
        {"name":"TYPE","change":{"kind":"set","value":0}},
        {"name":"COMMAND_INPUT","change":{"kind":"set","value":"SELECT 2;"}}
    ]}]});
    let plan = native_job_mutation_plan(NativeJobEngine::Dameng, &request(&data, config), &data).unwrap();
    assert!(plan.steps.iter().any(|step| step.sql.contains("SP_ALTER_JOB_STEP_EX('Job_1', 'backup', 0, 'SELECT 2;'")));
    assert!(!plan.steps.iter().any(|step| step.sql.contains("native generated backup command")));
}

#[test]
fn types_whose_native_command_is_ignored_reject_nonempty_input_but_allow_empty_native_input() {
    let data = details();
    for kind in [2, 3] {
        let config = json!({"steps":[{"kind":"add","name":"stats","attributes":[
            {"name":"TYPE","change":{"kind":"set","value":kind}},
            {"name":"COMMAND_INPUT","change":{"kind":"set","value":"user expects this to execute"}}
        ]}]});
        assert_eq!(
            native_job_mutation_plan(NativeJobEngine::Dameng, &request(&data, config), &data).err(),
            Some("native_job_step_command_not_applicable")
        );
        let config = json!({"steps":[{"kind":"add","name":"stats","attributes":[{"name":"TYPE","change":{"kind":"set","value":kind}}]}]});
        let plan = native_job_mutation_plan(NativeJobEngine::Dameng, &request(&data, config), &data).unwrap();
        assert!(plan
            .steps
            .iter()
            .any(|step| step.sql.contains(&format!("SP_ADD_JOB_STEP_EX('Job_1', 'stats', {kind}, NULL"))));
    }
}

#[test]
fn legacy_type_nine_schedule_is_preserved_but_not_mutated_through_native_schedule_procedures() {
    let mut data = details();
    if let NativeJobMetadata::Available { value } = &mut data.schedules {
        value[0].insert("TYPE".into(), json!(9));
    }
    let config = json!({"schedules":[{"kind":"update","name":"weekly","attributes":[{"name":"ENABLE","change":{"kind":"set","value":true}}]}]});
    assert!(native_job_mutation_plan(NativeJobEngine::Dameng, &request(&data, config), &data).is_ok());
    for change in [
        json!({"kind":"drop","name":"daily"}),
        json!({"kind":"update","name":"daily","attributes":[{"name":"NAME","change":{"kind":"set","value":"legacy_alias"}}]}),
    ] {
        let config = json!({"schedules":[change]});
        assert_eq!(
            native_job_mutation_plan(NativeJobEngine::Dameng, &request(&data, config), &data).err(),
            Some("native_job_legacy_schedule_requires_dbms_job")
        );
    }
}

#[test]
fn illegal_fields_names_duplicate_edits_and_native_identity_mismatches_are_rejected_before_configuration() {
    let data = details();
    for (config, reason) in [
        (
            json!({"steps":[{"kind":"update","name":"sql","attributes":[{"name":"ID","change":{"kind":"set","value":99}}]}]}),
            "native_job_attribute_not_editable",
        ),
        (json!({"steps":[{"kind":"add","name":"sql"}]}), "native_job_child_name_collision"),
        (json!({"steps":[{"kind":"add","name":"1bad"}]}), "native_job_child_name_invalid"),
        (
            json!({"steps":[{"kind":"drop","name":"sql"},{"kind":"drop","name":"SQL"}]}),
            "native_job_duplicate_child_change",
        ),
        (
            json!({"steps":[{"kind":"update","name":"sql","attributes":[{"name":"SUCC_NEXT_STEP","change":{"kind":"set","value":"missing"}}]}]}),
            "native_job_step_dependency_requires_correction",
        ),
        (
            json!({"schedules":[{"kind":"update","name":"weekly","attributes":[{"name":"FREQ_SUB_INTERVAL","change":{"kind":"set","value":128}}]}]}),
            "native_job_attribute_value_invalid",
        ),
        (
            json!({"steps":[{"kind":"update","name":"sql","attributes":[{"name":"NAME","change":{"kind":"set","value":"backup"}}]}]}),
            "native_job_child_name_collision",
        ),
    ] {
        assert_eq!(
            native_job_mutation_plan(NativeJobEngine::Dameng, &request(&data, config), &data).err(),
            Some(reason)
        );
    }
    let mut wrong = data.clone();
    if let NativeJobMetadata::Available { value } = &mut wrong.steps {
        value[0].insert("JOBID".into(), json!(42));
    }
    let config = json!({"steps":[{"kind":"update","name":"sql","attributes":[{"name":"DESCRIBE","change":{"kind":"set","value":"changed"}}]}]});
    assert_eq!(
        native_job_mutation_plan(NativeJobEngine::Dameng, &request(&wrong, config), &wrong).err(),
        Some("native_job_child_identity_unverified")
    );
}

#[test]
fn a_rename_chain_keeps_original_reference_identity_instead_of_cascading_text_replacements() {
    let data = details();
    let config = json!({"steps":[
        {"kind":"update","name":"sql","attributes":[{"name":"NAME","change":{"kind":"set","value":"new_sql"}}]},
        {"kind":"update","name":"backup","attributes":[{"name":"NAME","change":{"kind":"set","value":"sql"}}]}
    ]});
    let plan = native_job_mutation_plan(NativeJobEngine::Dameng, &request(&data, config), &data).unwrap();
    let renames = plan.steps.iter().filter(|step| step.sql.contains("SP_RENAME_JOB_STEP")).collect::<Vec<_>>();
    assert!(renames[0].sql.contains("'sql', 'new_sql'"));
    assert!(renames[1].sql.contains("'backup', 'sql'"));
    assert!(plan
        .steps
        .iter()
        .any(|step| step.sql.contains("SP_JOB_STEP_SET_NEXT_STEP('Job_1', 'sql', 'new_sql', NULL)")));
    let cycle = json!({"steps":[
        {"kind":"update","name":"sql","attributes":[{"name":"NAME","change":{"kind":"set","value":"backup"}}]},
        {"kind":"update","name":"backup","attributes":[{"name":"NAME","change":{"kind":"set","value":"sql"}}]}
    ]});
    assert_eq!(
        native_job_mutation_plan(NativeJobEngine::Dameng, &request(&data, cycle), &data).err(),
        Some("native_job_child_rename_requires_correction")
    );
}

#[test]
fn binding_created_ids_only_rebuilds_native_guards_and_preserves_literal_body_markers() {
    let data = details();
    let body = "SELECT ':dbx_created_step_id', ':dbx_created_reference_id_0';";
    let config = json!({"steps":[{"kind":"add","name":"new_step","attributes":[{"name":"COMMAND_INPUT","change":{"kind":"set","value":body}},{"name":"SUCC_ACTION","change":{"kind":"set","value":3}},{"name":"SUCC_NEXT_STEP","change":{"kind":"set","value":"sql"}}]}]});
    let plan = native_job_mutation_plan(NativeJobEngine::Dameng, &request(&data, config), &data).unwrap();
    let added = plan.steps.iter().find(|step| step.sql.contains("SP_ADD_JOB_STEP_EX")).unwrap();
    let resolved =
        resolve_native_job_dameng_child_step(added, &data.snapshot.job_ref, &data, &Default::default()).unwrap();
    assert_eq!(resolved.sql, added.sql);
    assert!(resolved.sql.contains("'SELECT '':dbx_created_step_id'', '':dbx_created_reference_id_0'';'"));
    let linked = plan.steps.iter().find(|step| step.sql.contains("SP_JOB_STEP_SET_NEXT_STEP")).unwrap();
    assert_eq!(
        resolve_native_job_dameng_child_step(linked, &data.snapshot.job_ref, &data, &Default::default()).err(),
        Some("native_job_child_identity_unverified")
    );
    let created =
        [(native_job_dameng_child_key(NativeJobDamengPart::Steps, "new_step"), "900719925474099312345".into())]
            .into_iter()
            .collect();
    let resolved = resolve_native_job_dameng_child_step(linked, &data.snapshot.job_ref, &data, &created).unwrap();
    assert!(resolved.sql.contains("ID = 900719925474099312345"));
    assert!(resolved.sql.contains("ID = 12"));
    assert!(!resolved.sql.contains(":dbx_created_step_id"));
}

#[test]
fn native_child_configuration_is_not_dispatched_through_another_engine_or_legacy_entry() {
    let data = details();
    let change = request(&data, json!({"steps":[{"kind":"drop","name":"backup"}]}));
    assert_eq!(
        native_job_mutation_plan(NativeJobEngine::Oracle, &change, &data).err(),
        Some("native_job_action_not_applicable")
    );
    let mut legacy = data.clone();
    legacy.snapshot.job_ref =
        NativeJobRef::Legacy { scope: data.snapshot.job_ref.scope().clone(), job_id: "41".into() };
    let change = request(&legacy, json!({"steps":[{"kind":"drop","name":"backup"}]}));
    assert_eq!(
        native_job_mutation_plan(NativeJobEngine::Dameng, &change, &legacy).err(),
        Some("native_job_action_not_applicable")
    );
}
