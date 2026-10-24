use dbx_sql_schema::native_job_changes::{
    native_job_dameng_civil_time, native_job_dameng_identity_queries, native_job_dameng_legacy_time,
    native_job_dameng_what_query, native_job_mutation_plan, NativeJobStepEffect,
};
use dbx_types::native_jobs::*;
use serde_json::json;

fn details(enabled: bool) -> NativeJobDetails {
    serde_json::from_value(json!({
        "snapshot":{"ref":{"kind":"dameng-native","scope":{"connectionId":"c","database":"","contextId":"ctx"},"jobId":"41","name":"Job_1"},"revision":"baseline",
            "definition":{"status":"available","value":{"ID":41,"DBX_JOB_ID":"41","NAME":"Job_1","USERNAME":"Owner","CREATETIME":"creation","ENABLE":enabled,"ENABLE_EMAIL":1,"EMAIL_OPERID":7,"EMAIL_TYPE":2,"ENABLE_NETSEND":0,"NETSEND_OPERID":-1,"NETSEND_TYPE":1,"DESCRIBE":"old","VALID":"Y","EP_SEQNO":0,"RAFT_NAME":null}},
            "arguments":{"status":"available","value":[]}},
        "nativeIdentity":{"status":"available","value":{"DBX_JOB_ID":"41","DBX_CREATED_AT":"creation"}},
        "consistency":{"status":"available","value":null},"parameterMetadata":{"status":"unsupported","reason":"not_applicable"},
        "steps":{"status":"denied","reason":"not_readable"},"schedules":{"status":"denied","reason":"not_readable"},
        "running":{"status":"unknown","reason":"not_readable"},"history":{"status":"empty"},
        "sources":{"definition":{"source":"SYSJOB.USER_JOBS_VIEW","coverage":"current_user"}}
    })).unwrap()
}

fn mutation(details: &NativeJobDetails, attributes: serde_json::Value) -> NativeJobMutation {
    NativeJobMutation {
        target: details.snapshot.job_ref.clone(),
        baseline: "baseline".into(),
        change: NativeJobChange::Update {
            final_enabled: None,
            argument_target: None,
            attributes: serde_json::from_value(attributes).unwrap(),
            arguments: Vec::new(),
        },
    }
}

fn legacy_details(enabled: bool) -> NativeJobDetails {
    let mut details = details(enabled);
    details.snapshot.job_ref =
        NativeJobRef::Legacy { scope: details.snapshot.job_ref.scope().clone(), job_id: "41".into() };
    details.legacy_definition = Some(NativeJobMetadata::Available {
        value: serde_json::from_value(
            json!({"DBX_JOB_ID":"41", "WHAT":"work();", "NEXT_DATE":"native date", "INTERVAL":"86400", "INSTANCE":1}),
        )
        .unwrap(),
    });
    details
}

#[test]
fn legacy_body_edit_freezes_the_original_definition_and_keeps_final_activation_last() {
    let mut before = legacy_details(true);
    before.steps = NativeJobMetadata::Empty;
    before.schedules = NativeJobMetadata::Empty;
    let plan = native_job_mutation_plan(
        NativeJobEngine::Dameng,
        &mutation(&before, json!([{"name":"WHAT","change":{"kind":"set","value":"BEGIN work('O''ne'); END;  "}}])),
        &before,
    )
    .unwrap();
    assert!(plan.required_partitions.iter().any(|part| part == "legacyDefinition"));
    let body = plan.steps.iter().position(|step| step.sql.contains("BEGIN work(''O''''ne''); END;  ")).unwrap();
    assert!(plan.steps[body].sql.contains("ID = 41 AND NAME = 'Job_1' AND CREATETIME = 'creation'"));
    assert!(plan.steps[body].sql.contains("COMMIT;"));
    assert!(matches!(plan.steps.last().unwrap().effect, NativeJobStepEffect::Enabled(true)));
    assert!(body < plan.steps.len() - 1);
}

#[test]
fn legacy_body_mixed_edits_keep_configuration_and_activation_order_and_reject_read_semantics() {
    let before = legacy_details(true);
    let plan = native_job_mutation_plan(
        NativeJobEngine::Dameng,
        &mutation(
            &before,
            json!([
                {"name":"NAME","change":{"kind":"set","value":"Renamed_Job"}},
                {"name":"INTERVAL","change":{"kind":"set","value":"60"}},
                {"name":"WHAT","change":{"kind":"set","value":"新正文('\\');  "}},
                {"name":"DESCRIBE","change":{"kind":"set","value":"new"}}
            ]),
        ),
        &before,
    )
    .unwrap();
    assert_eq!(
        plan.steps.iter().map(|step| step.id.as_str()).collect::<Vec<_>>(),
        ["pause", "definition", "config_start", "config_commit", "legacy_what", "legacy_interval", "rename", "enable"]
    );
    assert!(
        matches!(&plan.steps[4].effect, NativeJobStepEffect::DamengLegacyWhat { expected } if expected == "新正文('\\');  ")
    );
    for value in [json!(""), json!("a\u{0000}b"), json!(null), json!(42)] {
        assert!(native_job_mutation_plan(
            NativeJobEngine::Dameng,
            &mutation(&before, json!([{"name":"WHAT","change":{"kind":"set","value":value}}])),
            &before
        )
        .is_err());
    }
    assert!(native_job_mutation_plan(
        NativeJobEngine::Dameng,
        &mutation(&before, json!([{"name":"WHAT","change":{"kind":"clear"}}])),
        &before
    )
    .is_err());
}

#[test]
fn legacy_next_date_uses_an_explicit_civil_datetime_and_binds_the_original_date() {
    let mut before = legacy_details(false);
    if let Some(NativeJobMetadata::Available { value }) = &mut before.legacy_definition {
        value.insert("NEXT_DATE".into(), json!("2032-01-02 03:04:05"));
        value.insert("NEXT_SEC".into(), json!("03:04:05"));
    }
    let plan = native_job_mutation_plan(
        NativeJobEngine::Dameng,
        &mutation(
            &before,
            json!([{"name":"NEXT_DATE","change":{"kind":"set","value":"2032-02-03T04:05:06.123456000"}}]),
        ),
        &before,
    )
    .unwrap();
    assert!(plan.compare_next_date);
    assert_eq!(plan.steps.iter().map(|step| step.id.as_str()).collect::<Vec<_>>(), ["pause", "legacy_next_date"]);
    assert!(plan.steps[1].sql.contains("CAST(TIMESTAMP '2032-02-03 04:05:06.123456' AS DATETIME(6))"));
    assert!(plan.steps[1].sql.contains("DBMS_JOB.NEXT_DATE(41,"));
    for input in ["2032-02-03T04:05:06Z", "2032-02-03 04:05:06.123456001", "SYSDATE+1", "02/03/2032 04:05:06"] {
        assert!(native_job_mutation_plan(
            NativeJobEngine::Dameng,
            &mutation(&before, json!([{"name":"NEXT_DATE","change":{"kind":"set","value":input}}])),
            &before
        )
        .is_err());
    }
}

#[test]
fn legacy_civil_time_keeps_microseconds_and_rejects_ambiguous_or_conflicting_catalog_values() {
    for (input, expected) in [
        ("2032-02-03 04:05:06", "2032-02-03 04:05:06.000000"),
        ("2032-02-03T04:05:06.1", "2032-02-03 04:05:06.100000"),
        ("2032-02-03 04:05:06.123456000", "2032-02-03 04:05:06.123456"),
    ] {
        assert_eq!(native_job_dameng_civil_time(input).unwrap(), expected);
        let row = serde_json::from_value(json!({"NEXT_DATE":input, "NEXT_SEC":"04:05:06"})).unwrap();
        assert_eq!(native_job_dameng_legacy_time(&row).unwrap(), expected);
    }
    for row in [
        json!({"NEXT_DATE":"2032-02-03 04:05:06", "NEXT_SEC":"04:05:07"}),
        json!({"NEXT_DATE":"2032-02-03 04:05:06", "NEXT_SEC":"14706"}),
        json!({"NEXT_DATE":"2032-02-03 04:05:06", "NEXT_SEC":"04:05:06.1"}),
        json!({"NEXT_DATE":"2032-02-03 04:05:06", "NEXT_SEC":"24:00:00"}),
        json!({"NEXT_DATE":"native date", "NEXT_SEC":"04:05:06"}),
        json!({"NEXT_DATE":null, "NEXT_SEC":"04:05:06"}),
        json!({"NEXT_DATE":"2032-02-03 04:05:06"}),
    ] {
        assert!(native_job_dameng_legacy_time(&serde_json::from_value(row).unwrap()).is_err());
    }
    let row = serde_json::from_value(json!({"NEXT_DATE":"2032-02-03", "NEXT_SEC":"04:05:06"})).unwrap();
    assert_eq!(native_job_dameng_legacy_time(&row).unwrap(), "2032-02-03 04:05:06.000000");
    let row = serde_json::from_value(json!({"NEXT_DATE":"2032-02-03", "NEXT_SEC":"23:59:59"})).unwrap();
    assert_eq!(native_job_dameng_legacy_time(&row).unwrap(), "2032-02-03 23:59:59.000000");
}

#[test]
fn legacy_body_capacity_is_checked_by_native_construction_without_client_truncation() {
    let before = legacy_details(false);
    for body in ["a".repeat(32767), "汉".repeat(32768), "begin work('\\'); end;  ".into()] {
        let plan = native_job_mutation_plan(
            NativeJobEngine::Dameng,
            &mutation(&before, json!([{"name":"WHAT","change":{"kind":"set","value":body}}])),
            &before,
        )
        .unwrap();
        assert!(
            matches!(&plan.steps[1].effect, NativeJobStepEffect::DamengLegacyWhat { expected } if expected == &body)
        );
        let query = native_job_dameng_what_query(&body);
        assert!(query.sql.ends_with("AS VARCHAR2(32767)) AS DBX_WHAT FROM DUAL"));
        assert!(!query.sql.contains("SUBSTR("));
    }
}

#[test]
fn job_rename_is_committed_without_an_invented_configuration_or_activation_change() {
    for before in [details(true), details(false), legacy_details(true)] {
        let plan = native_job_mutation_plan(
            NativeJobEngine::Dameng,
            &mutation(&before, json!([{"name":"NAME","change":{"kind":"set","value":"Renamed_Job"}}])),
            &before,
        )
        .unwrap();
        assert_eq!(plan.steps.len(), 1);
        assert_eq!(plan.steps[0].id, "rename");
        assert!(plan.steps[0].sql.contains("SP_RENAME_JOB('Job_1', 'Renamed_Job'); COMMIT;"));
        assert!(!plan.steps[0].sql.contains("SP_ENABLE_JOB"));
        assert!(!plan.steps[0].sql.contains("SP_JOB_CONFIG_START"));
        assert!(
            matches!(&plan.steps[0].effect, NativeJobStepEffect::DamengRenamed { old_name, new_name } if old_name == "Job_1" && new_name == "Renamed_Job")
        );
        let queries = native_job_dameng_identity_queries(&before.snapshot.job_ref).unwrap();
        assert_eq!(queries.len(), 2);
        for query in queries {
            assert!(query.sql.ends_with("WHERE ID = 41"));
            assert!(query.sql.contains("CREATETIME AS DBX_CREATED_AT, NAME, USERNAME, SYS_FLAG"));
            assert!(!query.sql.contains("NAME ="));
        }
    }
}

#[test]
fn rename_follows_confirmed_configuration_and_previews_the_new_name_for_final_enable() {
    let before = details(true);
    let plan = native_job_mutation_plan(NativeJobEngine::Dameng, &mutation(&before, json!([{"name":"NAME","change":{"kind":"set","value":"Renamed_Job"}}, {"name":"DESCRIBE","change":{"kind":"set","value":"new"}}])), &before).unwrap();
    assert_eq!(
        plan.steps.iter().map(|step| step.id.as_str()).collect::<Vec<_>>(),
        ["pause", "definition", "config_start", "config_commit", "rename", "enable"]
    );
    assert!(plan.steps.last().unwrap().sql.contains("NAME = 'Renamed_Job'"));
    assert!(plan.steps.last().unwrap().sql.contains("SP_ENABLE_JOB('Renamed_Job', 1)"));
    assert_eq!(native_job_mutation_plan(NativeJobEngine::Dameng, &mutation(&before, json!([{"name":"NAME","change":{"kind":"set","value":"a"}}, {"name":"name","change":{"kind":"set","value":"b"}}])), &before).err(), Some("native_job_duplicate_attribute"));
}

#[test]
fn rename_validates_new_names_without_revalidating_catalog_names() {
    let before = details(false);
    for name in ["", "New' Job", "1Job", "新作业", &"a".repeat(129)] {
        assert_eq!(
            native_job_mutation_plan(
                NativeJobEngine::Dameng,
                &mutation(&before, json!([{"name":"NAME","change":{"kind":"set","value":name}}])),
                &before
            )
            .err(),
            Some("native_job_name_invalid")
        );
    }
    let mut old = before;
    if let NativeJobRef::DamengNative { name, .. } = &mut old.snapshot.job_ref {
        *name = "Old' Job".into();
    }
    if let NativeJobMetadata::Available { value } = &mut old.snapshot.definition {
        value.insert("NAME".into(), json!("Old' Job"));
    }
    let plan = native_job_mutation_plan(
        NativeJobEngine::Dameng,
        &mutation(&old, json!([{"name":"NAME","change":{"kind":"set","value":"New_Job"}}])),
        &old,
    )
    .unwrap();
    assert!(plan.steps[0].sql.contains("SP_RENAME_JOB('Old'' Job', 'New_Job'); COMMIT;"));
}

#[test]
fn legacy_interval_uses_one_guarded_commit_after_configuration_before_activation() {
    let before = legacy_details(true);
    for (attributes, expected_ids) in [
        (
            json!([{"name":"INTERVAL","change":{"kind":"set","value":"000900719925474099312345"}}]),
            vec!["pause", "legacy_interval", "enable"],
        ),
        (
            json!([{"name":"DESCRIBE","change":{"kind":"set","value":"new"}}, {"name":"INTERVAL","change":{"kind":"set","value":"900719925474099312345"}}]),
            vec!["pause", "definition", "config_start", "config_commit", "legacy_interval", "enable"],
        ),
    ] {
        let plan = native_job_mutation_plan(NativeJobEngine::Dameng, &mutation(&before, attributes), &before).unwrap();
        assert_eq!(plan.steps.iter().map(|step| step.id.as_str()).collect::<Vec<_>>(), expected_ids);
        let step = plan.steps.iter().find(|step| step.id == "legacy_interval").unwrap();
        assert!(step.sql.contains("DBMS_JOB.\"INTERVAL\"(41, 'SYSDATE+900719925474099312345/86400'); COMMIT;"));
        assert!(step.sql.contains("ID = 41 AND NAME = 'Job_1' AND CREATETIME = 'creation'"));
        assert!(
            matches!(&step.effect, NativeJobStepEffect::DamengLegacyInterval { expected_seconds: Some(value) } if value == "900719925474099312345")
        );
        assert!(plan.required_partitions.iter().any(|part| part == "legacyDefinition"));
        assert!(plan.required_partitions.iter().any(|part| part == "steps"));
        assert!(plan.required_partitions.iter().any(|part| part == "schedules"));
    }
}

#[test]
fn legacy_custom_interval_is_not_evaluated_or_mistaken_for_a_fixed_period() {
    let before = legacy_details(false);
    for expression in ["0", "0.5", "SYSDATE + custom_next('O''ne')"] {
        let plan = native_job_mutation_plan(
            NativeJobEngine::Dameng,
            &mutation(&before, json!([{"name":"INTERVAL","change":{"kind":"set","value":expression}}])),
            &before,
        )
        .unwrap();
        assert_eq!(plan.steps.len(), 2);
        assert!(matches!(plan.steps[1].effect, NativeJobStepEffect::DamengLegacyInterval { expected_seconds: None }));
        assert!(
            !plan.steps[1].sql.contains("SELECT")
                || plan.steps[1].sql.contains("SELECT COUNT(*) INTO dbx_target_count")
        );
        assert!(!plan.steps[1].sql.contains("EXECUTE IMMEDIATE"));
    }
    let denied = NativeJobDetails {
        legacy_definition: Some(NativeJobMetadata::Denied { reason: "denied".into() }),
        ..before.clone()
    };
    assert_eq!(
        native_job_mutation_plan(
            NativeJobEngine::Dameng,
            &mutation(&denied, json!([{"name":"INTERVAL","change":{"kind":"set","value":"1"}}])),
            &denied
        )
        .err(),
        Some("native_job_legacy_definition_unavailable")
    );
    assert_eq!(native_job_mutation_plan(NativeJobEngine::Dameng, &mutation(&before, json!([{"name":"INTERVAL","change":{"kind":"set","value":"1"}}, {"name":"interval","change":{"kind":"set","value":"2"}}])), &before).err(), Some("native_job_duplicate_attribute"));
    assert!(native_job_mutation_plan(
        NativeJobEngine::Dameng,
        &mutation(&denied, json!([{"name":"DESCRIBE","change":{"kind":"set","value":"native-only"}}])),
        &denied
    )
    .is_ok());
}

#[test]
fn a_basic_edit_preserves_notifications_and_uses_a_disabled_configuration_cycle() {
    let before = details(true);
    let request = mutation(&before, json!([{"name":"DESCRIBE","change":{"kind":"set","value":"new's description"}}]));
    let plan = native_job_mutation_plan(NativeJobEngine::Dameng, &request, &before).unwrap();
    assert_eq!(
        plan.steps.iter().map(|step| step.id.as_str()).collect::<Vec<_>>(),
        ["pause", "definition", "config_start", "config_commit", "enable"]
    );
    assert!(plan.steps[0].sql.contains("SP_ENABLE_JOB('Job_1', 0)"));
    assert!(plan.steps[1]
        .sql
        .contains("SP_ALTER_JOB('Job_1', 0, 1, dbx_email_operator, 2, 0, NULL, 1, 'new''s description')"));
    assert!(plan.steps[1].sql.contains("FROM SYSJOB.SYSOPERATORS WHERE ID = 7"));
    assert!(plan.steps.iter().all(|step| step.sql.contains("SYSJOB.USER_JOBS_VIEW")
        && step.sql.contains("ID = 41")
        && step.sql.contains("CREATETIME = 'creation'")));
    assert_eq!(plan.required_partitions, ["definition"]);
    assert!(!plan
        .steps
        .iter()
        .any(|step| step.sql.contains("DROP_JOB") || step.sql.contains("CREATE_JOB") || step.sql.contains("ROLLBACK")));
}

#[test]
fn disabled_and_node_only_edits_do_not_require_unrelated_operator_or_step_access() {
    let before = details(false);
    let request = mutation(&before, json!([{"name":"EP_SEQNO","change":{"kind":"set","value":2}}]));
    let plan = native_job_mutation_plan(NativeJobEngine::Dameng, &request, &before).unwrap();
    assert_eq!(
        plan.steps.iter().map(|step| step.id.as_str()).collect::<Vec<_>>(),
        ["pause", "config_start", "attribute:EP_SEQNO", "config_commit"]
    );
    assert!(plan.steps[2].sql.contains("SP_JOB_SET_EP_SEQNO('Job_1', 2)"));
    assert!(!plan.steps.iter().any(|step| step.sql.contains("SYSOPERATORS")
        || step.sql.contains("SP_ALTER_JOB")
        || step.sql.contains("COMMIT;")));
}

#[test]
fn requested_activation_is_last_and_not_an_intermediate_alter_parameter() {
    let before = details(false);
    let request = mutation(
        &before,
        json!([
            {"name":"ENABLE","change":{"kind":"set","value":true}},
            {"name":"EMAIL_OPERATOR_NAME","change":{"kind":"set","value":"New_Operator"}},
            {"name":"ENABLE_EMAIL","change":{"kind":"set","value":true}}
        ]),
    );
    let plan = native_job_mutation_plan(NativeJobEngine::Dameng, &request, &before).unwrap();
    assert!(plan.steps[1].sql.contains("SP_ALTER_JOB('Job_1', 0,"));
    assert!(plan.steps[1].sql.contains("'New_Operator'"));
    assert!(plan.steps.last().unwrap().sql.contains("SP_ENABLE_JOB('Job_1', 1)"));
}

#[test]
fn incomplete_or_forged_metadata_does_not_generate_a_destructive_definition() {
    let mut before = details(true);
    let NativeJobMetadata::Available { value } = &mut before.snapshot.definition else { unreachable!() };
    value.remove("EMAIL_TYPE");
    let request = mutation(&before, json!([{"name":"DESCRIBE","change":{"kind":"clear"}}]));
    assert_eq!(
        native_job_mutation_plan(NativeJobEngine::Dameng, &request, &before).err(),
        Some("native_job_metadata_incomplete")
    );
    let mut before = details(true);
    before.sources.get_mut("definition").unwrap().source = Some("untrusted_source".into());
    let request = mutation(&before, json!([{"name":"DESCRIBE","change":{"kind":"clear"}}]));
    assert_eq!(
        native_job_mutation_plan(NativeJobEngine::Dameng, &request, &before).err(),
        Some("native_job_catalog_source_unverified")
    );
}

#[test]
fn every_native_control_guards_the_same_id_name_and_creation_before_dispatch() {
    let before = details(true);
    for change in [
        NativeJobChange::Enable,
        NativeJobChange::Disable,
        NativeJobChange::Run,
        NativeJobChange::Stop { force: false },
        NativeJobChange::Drop { force: false },
        NativeJobChange::ClearHistory,
    ] {
        let request =
            NativeJobMutation { target: before.snapshot.job_ref.clone(), baseline: "baseline".into(), change };
        let plan = native_job_mutation_plan(NativeJobEngine::Dameng, &request, &before).unwrap();
        let sql = &plan.steps[0].sql;
        assert!(
            sql.contains("ID = 41 AND NAME = 'Job_1' AND CREATETIME = 'creation'"),
            "native control did not guard its generation"
        );
        assert!(sql.find("RAISE dbx_target_changed").unwrap() < sql.find("SP_").unwrap());
        assert!(!sql.contains("DROP_JOB") || plan.steps[0].id == "drop");
    }
}

#[test]
fn native_controls_refuse_unproven_generation_but_do_not_require_unrelated_definition_fields() {
    let mut before = details(true);
    before.snapshot.definition = NativeJobMetadata::Denied { reason: "definition_columns_not_readable".into() };
    before.sources.insert(
        "identity".into(),
        NativeJobCatalogSource {
            source: Some("SYSJOB.USER_JOBS_VIEW".into()),
            coverage: Some(NativeJobCatalogCoverage::CurrentUser),
        },
    );
    let request = NativeJobMutation {
        target: before.snapshot.job_ref.clone(),
        baseline: "baseline".into(),
        change: NativeJobChange::Run,
    };
    assert!(native_job_mutation_plan(NativeJobEngine::Dameng, &request, &before).is_ok());
    before.native_identity = NativeJobMetadata::Unknown { reason: "not_readable".into() };
    assert_eq!(
        native_job_mutation_plan(NativeJobEngine::Dameng, &request, &before).err(),
        Some("native_job_identity_unverified")
    );
}

#[test]
fn native_drop_does_not_silently_discard_a_requested_force_semantic() {
    let before = details(true);
    let request = NativeJobMutation {
        target: before.snapshot.job_ref.clone(),
        baseline: "baseline".into(),
        change: NativeJobChange::Drop { force: true },
    };
    assert_eq!(
        native_job_mutation_plan(NativeJobEngine::Dameng, &request, &before).err(),
        Some("native_job_force_drop_not_applicable")
    );
}
