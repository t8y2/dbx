use dbx_sql_schema::native_job_changes::{
    native_job_legacy_create_preview, native_job_mutation_plan, NativeJobStepEffect,
};
use dbx_types::native_jobs::*;
use serde_json::json;

fn details() -> NativeJobDetails {
    serde_json::from_value(json!({
        "snapshot": { "ref": {"kind":"scheduler", "owner":"Owner", "name":"Job", "scope":{"connectionId":"c","database":"","contextId":"ctx"}}, "revision":"baseline",
            "definition":{"status":"available","value":{"OWNER":"Owner","JOB_NAME":"Job","JOB_ACTION":"kept","COMMENTS":"old","AUTO_DROP":"FALSE","ENABLED":"FALSE"}},
            "arguments":{"status":"available","value":[{"position":1,"dataType":"VARCHAR2","value":{"kind":"value","value":"old"},"editable":true},{"position":2,"dataType":"OBJECT","value":{"kind":"opaque","value":{"unparsed":true}},"editable":false}]} },
        "nativeIdentity":{"status":"available","value":{"DBX_JOB_ID":"9007199254740993","DBX_CREATED_AT":"creation"}},"consistency":{"status":"available","value":null},
        "parameterMetadata":{"status":"empty"},"steps":{"status":"empty"},"schedules":{"status":"empty"},"running":{"status":"unknown","reason":"not visible"},"history":{"status":"empty"},"sources":{}
    })).unwrap()
}

fn request(details: &NativeJobDetails, change: NativeJobChange) -> NativeJobMutation {
    NativeJobMutation { target: details.snapshot.job_ref.clone(), baseline: "baseline".into(), change }
}

#[test]
fn legacy_creation_preview_keeps_initial_state_before_commit_and_does_not_guess_an_id() {
    let mut definition = NativeJobLegacyCreate {
        what: "my_proc('private');".into(),
        next_date: "2026-10-21 10:20:30".into(),
        interval: "NULL".into(),
        enabled: false,
        instance: 0,
        schema: "Ow\"ner".into(),
        zone: None,
    };
    let steps = native_job_legacy_create_preview(NativeJobEngine::Oracle, &definition).unwrap();
    assert_eq!(steps.len(), 3);
    assert!(steps[0].sql.starts_with("ALTER SESSION SET CURRENT_SCHEMA = \"Ow\"\"ner\";"));
    assert!(steps[0].sql.contains("what => 'my_proc(''private'');'"));
    assert!(steps[0].sql.contains("BROKEN(TO_NUMBER(:dbx_job_id), TRUE, TO_DATE('2026-10-21 10:20:30'"));
    assert!(!steps[0].sql.contains("DBMS_JOB.NEXT_DATE"));
    assert!(!steps[0].sql.contains("COMMIT"));
    assert_eq!(steps[1].sql, "COMMIT;");
    assert!(steps[2].sql.contains("JOB = TO_NUMBER(:dbx_job_id)"));
    definition.instance = -1;
    assert!(native_job_legacy_create_preview(NativeJobEngine::Oracle, &definition).is_err());
    definition.instance = 0;
    definition.zone = Some("zone1".into());
    assert!(native_job_legacy_create_preview(NativeJobEngine::Oracle, &definition).is_err());
}

#[test]
fn ob_legacy_creation_uses_nullable_zone_and_keeps_the_initial_state_before_commit() {
    let mut definition = NativeJobLegacyCreate {
        what: "my_proc();".into(),
        next_date: "2026-10-21 10:20:30".into(),
        interval: "NULL".into(),
        enabled: false,
        instance: 0,
        schema: "Owner".into(),
        zone: Some("zone's name".into()),
    };
    let steps = native_job_legacy_create_preview(NativeJobEngine::OceanbaseOracle, &definition).unwrap();
    assert_eq!(steps.len(), 3);
    assert!(steps[0].sql.contains("zone => 'zone''s name', force => FALSE"));
    assert!(!steps[0].sql.contains("instance =>"));
    assert!(!steps[0].sql.contains("COMMIT"));
    assert!(steps[0].sql.contains("BROKEN(TO_NUMBER(:dbx_job_id), TRUE"));
    let broken = steps[0].sql.find("DBMS_JOB.BROKEN").unwrap();
    let restore_date =
        steps[0].sql.find("DBMS_JOB.NEXT_DATE(TO_NUMBER(:dbx_job_id), TO_DATE('2026-10-21 10:20:30'").unwrap();
    let read = steps[0].sql.find("SELECT TO_CHAR(JOB)").unwrap();
    assert!(broken < restore_date && restore_date < read);
    assert!(steps[0].sql.contains("BROKEN, INSTANCE, LOG_USER, PRIV_USER, SCHEMA_USER"));
    definition.zone = None;
    assert!(native_job_legacy_create_preview(NativeJobEngine::OceanbaseOracle, &definition).unwrap()[0]
        .sql
        .contains("zone => NULL"));
    definition.instance = 2;
    assert!(native_job_legacy_create_preview(NativeJobEngine::OceanbaseOracle, &definition).is_err());
}

#[test]
fn ob_legacy_zone_patch_preserves_raw_instance_projection_and_accepts_explicit_clear() {
    let mut data = details();
    data.snapshot.job_ref = NativeJobRef::Legacy { scope: data.snapshot.job_ref.scope().clone(), job_id: "41".into() };
    for change in [NativeJobFieldChange::Set { value: json!("zone1") }, NativeJobFieldChange::Clear] {
        let update = NativeJobChange::Update {
            final_enabled: None,
            argument_target: None,
            attributes: vec![NativeJobAttributeChange { name: "ZONE".into(), change: change.clone() }],
            arguments: vec![],
        };
        let plan = native_job_mutation_plan(NativeJobEngine::OceanbaseOracle, &request(&data, update), &data).unwrap();
        assert_eq!(plan.steps.len(), 1);
        let value = if change == NativeJobFieldChange::Clear { "NULL" } else { "'zone1'" };
        assert!(plan.steps[0].sql.contains(&format!("DBMS_JOB.ZONE(job => 41, zone => {value}, force => FALSE)")));
        assert!(!plan.steps[0].sql.contains("DBMS_JOB.CHANGE"));
        assert!(
            matches!(&plan.steps[0].effect, NativeJobStepEffect::Fields(fields) if fields.len()==1 && fields[0].name=="INSTANCE" && fields[0].change==change)
        );
    }
}

#[test]
fn legacy_broken_uses_the_successful_definition_source_instead_of_imposing_user_visibility() {
    let mut data = details();
    data.snapshot.job_ref = NativeJobRef::Legacy { scope: data.snapshot.job_ref.scope().clone(), job_id: "41".into() };
    data.sources.insert(
        "definition".into(),
        NativeJobCatalogSource {
            source: Some("SYS.DBA_JOBS".into()),
            coverage: Some(NativeJobCatalogCoverage::Database),
        },
    );
    for engine in [NativeJobEngine::Oracle, NativeJobEngine::OceanbaseOracle] {
        for change in [NativeJobChange::Enable, NativeJobChange::Disable] {
            let plan = native_job_mutation_plan(engine, &request(&data, change), &data).unwrap();
            let sql = &plan.steps[0].sql;
            assert!(sql.contains("FROM SYS.DBA_JOBS WHERE JOB = 41"));
            assert!(!sql.contains("SYS.USER_JOBS"));
            if engine == NativeJobEngine::OceanbaseOracle {
                assert!(sql.contains("next_at); SYS.DBMS_JOB.NEXT_DATE(41, next_at); COMMIT;"));
            } else {
                assert!(!sql.contains("DBMS_JOB.NEXT_DATE"));
            }
        }
    }
}

#[test]
fn scheduler_run_boolean_signatures_and_exact_single_targets_are_not_interchanged() {
    let mut data = details();
    if let NativeJobRef::Scheduler { owner, name, .. } = &mut data.snapshot.job_ref {
        *owner = "O.\"wner".into();
        *name = "J,ob's".into();
    }
    let run = request(&data, NativeJobChange::Run);
    let oracle = native_job_mutation_plan(NativeJobEngine::Oracle, &run, &data).unwrap();
    assert!(oracle.steps[0].sql.contains("use_current_session => FALSE"));
    assert!(oracle.steps[0].sql.contains("'\"O.\"\"wner\".\"J,ob''s\"'"));
    let ob = native_job_mutation_plan(NativeJobEngine::OceanbaseOracle, &run, &data).unwrap();
    assert!(ob.steps[0].sql.contains("force => FALSE"));
    assert!(!ob.steps[0].sql.contains("use_current_session"));
    assert!(ob.steps[0].sql.contains("JOB = 9007199254740993"));
    assert!(ob.steps[0].sql.contains("JOB > 0"));
}

#[test]
fn oracle_attribute_batch_is_transactional_and_does_not_recreate_or_rewrite_untouched_fields() {
    let data = details();
    let change = NativeJobChange::Update {
        final_enabled: None,
        argument_target: None,
        attributes: vec![
            NativeJobAttributeChange {
                name: "COMMENTS".into(),
                change: NativeJobFieldChange::Set { value: json!("a'b") },
            },
            NativeJobAttributeChange {
                name: "AUTO_DROP".into(),
                change: NativeJobFieldChange::Set { value: json!(false) },
            },
        ],
        arguments: vec![],
    };
    let plan = native_job_mutation_plan(NativeJobEngine::Oracle, &request(&data, change), &data).unwrap();
    assert_eq!(plan.steps.len(), 1);
    assert!(plan.steps[0].sql.contains("SET_JOB_ATTRIBUTES"));
    assert!(plan.steps[0].sql.contains("'TRANSACTIONAL'"));
    assert!(plan.steps[0].sql.contains("'a''b'"));
    assert!(!plan.steps[0].sql.contains("DROP_JOB"));
    assert!(!plan.steps[0].sql.contains("job_action"));
}

#[test]
fn the_scalar_builder_never_silently_discards_an_explicit_final_enabled_intent() {
    let mut data = details();
    for enabled in [false, true] {
        let change = NativeJobChange::Update {
            final_enabled: Some(enabled),
            argument_target: None,
            attributes: vec![NativeJobAttributeChange {
                name: "COMMENTS".into(),
                change: NativeJobFieldChange::Set { value: json!("changed") },
            }],
            arguments: vec![],
        };
        assert!(matches!(
            native_job_mutation_plan(NativeJobEngine::Oracle, &request(&data, change), &data),
            Err("native_job_scheduler_transition_required")
        ));
    }
    data.snapshot.job_ref = NativeJobRef::Legacy { scope: data.snapshot.job_ref.scope().clone(), job_id: "41".into() };
    let change = NativeJobChange::Update {
        final_enabled: Some(false),
        argument_target: None,
        attributes: vec![],
        arguments: vec![],
    };
    assert!(matches!(
        native_job_mutation_plan(NativeJobEngine::Oracle, &request(&data, change), &data),
        Err("native_job_final_enabled_not_applicable")
    ));
}

#[test]
fn unsupported_read_only_and_duplicate_field_names_cannot_become_sql() {
    let data = details();
    for names in [vec!["JOB_NAME"], vec!["COMMENTS'); COMMIT; --"], vec!["COMMENTS", "comments"]] {
        let change = NativeJobChange::Update {
            final_enabled: None,
            argument_target: None,
            attributes: names
                .into_iter()
                .map(|name| NativeJobAttributeChange {
                    name: name.into(),
                    change: NativeJobFieldChange::Set { value: json!("new") },
                })
                .collect(),
            arguments: vec![],
        };
        assert!(native_job_mutation_plan(NativeJobEngine::Oracle, &request(&data, change), &data).is_err());
    }
}

#[test]
fn a_known_argument_edit_does_not_rewrite_its_opaque_neighbor_and_null_is_typed_anydata() {
    let data = details();
    for value in [NativeJobArgumentValue::Value { value: json!("new") }, NativeJobArgumentValue::Null] {
        let change = NativeJobChange::Update {
            final_enabled: None,
            argument_target: None,
            attributes: vec![],
            arguments: vec![NativeJobArgumentChange { position: 1, value }],
        };
        let plan = native_job_mutation_plan(NativeJobEngine::Oracle, &request(&data, change), &data).unwrap();
        assert_eq!(plan.steps.len(), 1);
        assert!(plan.steps[0].sql.contains("argument_position => 1"));
        assert!(!plan.steps[0].sql.contains("argument_position => 2"));
        assert!(!plan.steps[0].sql.contains("unparsed"));
        if plan.steps[0].sql.contains("NULL") {
            assert!(plan.steps[0].sql.contains("SET_JOB_ANYDATA_VALUE"));
        }
    }
    let opaque = NativeJobChange::Update {
        final_enabled: None,
        argument_target: None,
        attributes: vec![],
        arguments: vec![NativeJobArgumentChange { position: 2, value: NativeJobArgumentValue::Unset }],
    };
    assert!(native_job_mutation_plan(NativeJobEngine::Oracle, &request(&data, opaque), &data).is_err());
}

#[test]
fn legacy_enable_preserves_the_latest_next_date_and_removal_commits_in_the_same_native_call() {
    let mut data = details();
    data.snapshot.job_ref =
        NativeJobRef::Legacy { scope: data.snapshot.job_ref.scope().clone(), job_id: "9007199254740993".into() };
    let enable =
        native_job_mutation_plan(NativeJobEngine::Oracle, &request(&data, NativeJobChange::Enable), &data).unwrap();
    assert!(enable.steps[0].sql.contains("SELECT NEXT_DATE INTO next_at"));
    assert!(enable.steps[0].sql.contains("DBMS_JOB.BROKEN(9007199254740993, FALSE, next_at); COMMIT;"));
    assert!(!enable.steps[0].sql.contains("SYSDATE"));
    let drop = native_job_mutation_plan(
        NativeJobEngine::Oracle,
        &request(&data, NativeJobChange::Drop { force: false }),
        &data,
    )
    .unwrap();
    assert!(drop.steps[0].sql.contains("DBMS_JOB.REMOVE(9007199254740993); COMMIT;"));
    assert!(matches!(
        native_job_mutation_plan(
            NativeJobEngine::Oracle,
            &request(&data, NativeJobChange::Stop { force: false }),
            &data
        ),
        Err("native_job_dbms_job_has_no_stop")
    ));
}

#[test]
fn dm_native_control_keeps_large_ids_and_original_names_without_numeric_rounding() {
    let mut data = details();
    data.snapshot.job_ref = NativeJobRef::DamengNative {
        scope: data.snapshot.job_ref.scope().clone(),
        job_id: "9007199254740993".into(),
        name: "exact'job".into(),
    };
    data.sources.insert(
        "identity".into(),
        NativeJobCatalogSource {
            source: Some("SYSJOB.USER_JOBS_VIEW".into()),
            coverage: Some(NativeJobCatalogCoverage::CurrentUser),
        },
    );
    let run = native_job_mutation_plan(NativeJobEngine::Dameng, &request(&data, NativeJobChange::Run), &data).unwrap();
    assert!(run.steps[0].sql.contains("SP_DBMS_JOB_RUN_ASYNC(9007199254740993)"));
    let enable =
        native_job_mutation_plan(NativeJobEngine::Dameng, &request(&data, NativeJobChange::Enable), &data).unwrap();
    assert!(enable.steps[0].sql.contains("SP_ENABLE_JOB('exact''job', 1)"));
}

#[test]
fn ob_legacy_does_not_treat_a_zone_as_an_oracle_instance() {
    let mut data = details();
    data.snapshot.job_ref = NativeJobRef::Legacy { scope: data.snapshot.job_ref.scope().clone(), job_id: "41".into() };
    let change = NativeJobChange::Update {
        final_enabled: None,
        argument_target: None,
        attributes: vec![NativeJobAttributeChange {
            name: "INSTANCE".into(),
            change: NativeJobFieldChange::Set { value: json!(2) },
        }],
        arguments: vec![],
    };
    let change = request(&data, change);
    assert!(native_job_mutation_plan(NativeJobEngine::Oracle, &change, &data).unwrap().steps[0]
        .sql
        .contains("DBMS_JOB.INSTANCE(41, 2)"));
    assert!(matches!(
        native_job_mutation_plan(NativeJobEngine::OceanbaseOracle, &change, &data),
        Err("native_job_attribute_not_editable")
    ));
}

#[test]
fn logging_uses_a_native_constant_and_changed_timestamps_keep_their_explicit_offset() {
    let mut data = details();
    if let NativeJobMetadata::Available { value } = &mut data.snapshot.definition {
        value.insert("LOGGING_LEVEL".into(), json!("RUNS"));
        value.insert("END_DATE".into(), json!(null));
    }
    let change = NativeJobChange::Update {
        final_enabled: None,
        argument_target: None,
        attributes: vec![
            NativeJobAttributeChange {
                name: "LOGGING_LEVEL".into(),
                change: NativeJobFieldChange::Set { value: json!("FULL") },
            },
            NativeJobAttributeChange {
                name: "END_DATE".into(),
                change: NativeJobFieldChange::Set { value: json!("2030-05-01T12:13:14.123+08:00") },
            },
        ],
        arguments: vec![],
    };
    let sql = &native_job_mutation_plan(NativeJobEngine::Oracle, &request(&data, change), &data).unwrap().steps[0].sql;
    assert!(sql.contains("DBMS_SCHEDULER.LOGGING_FULL"));
    assert!(sql.contains("'2030-05-01 12:13:14.123 +08:00'"));
}

#[test]
fn dm_compatibility_only_attributes_are_not_offered_as_effective_edits() {
    let mut data = details();
    if let NativeJobMetadata::Available { value } = &mut data.snapshot.definition {
        value.insert("RESTARTABLE".into(), json!(false));
    }
    let change = NativeJobChange::Update {
        final_enabled: None,
        argument_target: None,
        attributes: vec![NativeJobAttributeChange {
            name: "RESTARTABLE".into(),
            change: NativeJobFieldChange::Set { value: json!(true) },
        }],
        arguments: vec![],
    };
    assert!(matches!(
        native_job_mutation_plan(NativeJobEngine::Dameng, &request(&data, change), &data),
        Err("native_job_attribute_not_editable")
    ));
    let change = NativeJobChange::Update {
        final_enabled: None,
        argument_target: None,
        attributes: vec![NativeJobAttributeChange {
            name: "AUTO_DROP".into(),
            change: NativeJobFieldChange::Set { value: json!(true) },
        }],
        arguments: vec![],
    };
    assert!(native_job_mutation_plan(NativeJobEngine::Dameng, &request(&data, change), &data).is_ok());
}

#[test]
fn ob_unimplemented_scheduler_attributes_cannot_become_mutation_steps() {
    let mut data = details();
    for name in [
        "COMMENTS",
        "AUTO_DROP",
        "JOB_ACTION",
        "JOB_TYPE",
        "NUMBER_OF_ARGUMENTS",
        "START_DATE",
        "END_DATE",
        "REPEAT_INTERVAL",
        "PROGRAM_NAME",
        "JOB_PRIORITY",
        "MAX_RUNS",
    ] {
        if let NativeJobMetadata::Available { value } = &mut data.snapshot.definition {
            value.insert(name.into(), json!(null));
        }
        let change = NativeJobChange::Update {
            final_enabled: None,
            argument_target: None,
            attributes: vec![NativeJobAttributeChange {
                name: name.into(),
                change: NativeJobFieldChange::Set { value: json!("changed") },
            }],
            arguments: vec![],
        };
        assert!(
            matches!(
                native_job_mutation_plan(NativeJobEngine::OceanbaseOracle, &request(&data, change), &data),
                Err("native_job_attribute_not_editable")
            ),
            "{name}"
        );
    }
}

#[test]
fn ob_max_run_duration_serializes_exact_whole_seconds_instead_of_an_oracle_interval() {
    let mut data = details();
    if let NativeJobMetadata::Available { value } = &mut data.snapshot.definition {
        value.insert("MAX_RUN_DURATION".into(), json!("+000 00:00:00"));
    }
    for (value, seconds) in [("+000 00:02:00", "120"), ("1 01:02:03.000", "90123")] {
        let change = NativeJobChange::Update {
            final_enabled: None,
            argument_target: None,
            attributes: vec![NativeJobAttributeChange {
                name: "MAX_RUN_DURATION".into(),
                change: NativeJobFieldChange::Set { value: json!(value) },
            }],
            arguments: vec![],
        };
        let plan = native_job_mutation_plan(NativeJobEngine::OceanbaseOracle, &request(&data, change), &data).unwrap();
        assert!(plan.steps[0].sql.contains(&format!("value => '{seconds}'")));
        assert!(!plan.steps[0].sql.contains("TO_DSINTERVAL"));
    }
    for value in [json!("0 00:00:00.5"), json!("-0 00:02:00"), json!(null)] {
        let change = NativeJobChange::Update {
            final_enabled: None,
            argument_target: None,
            attributes: vec![NativeJobAttributeChange {
                name: "MAX_RUN_DURATION".into(),
                change: NativeJobFieldChange::Set { value },
            }],
            arguments: vec![],
        };
        assert!(native_job_mutation_plan(NativeJobEngine::OceanbaseOracle, &request(&data, change), &data).is_err());
    }
}

#[test]
fn ob_scheduler_instance_id_is_a_zone_string_not_an_oracle_instance_number() {
    let mut data = details();
    if let NativeJobMetadata::Available { value } = &mut data.snapshot.definition {
        value.insert("INSTANCE_ID".into(), json!("RANDOM"));
    }
    let change = NativeJobChange::Update {
        final_enabled: None,
        argument_target: None,
        attributes: vec![NativeJobAttributeChange {
            name: "INSTANCE_ID".into(),
            change: NativeJobFieldChange::Set { value: json!("zone's name") },
        }],
        arguments: vec![],
    };
    let plan = native_job_mutation_plan(NativeJobEngine::OceanbaseOracle, &request(&data, change), &data).unwrap();
    assert!(plan.steps[0].sql.contains("value => 'zone''s name'"));
}

#[test]
fn dm_effective_comments_and_duration_are_not_treated_as_compatibility_only() {
    let mut data = details();
    if let NativeJobMetadata::Available { value } = &mut data.snapshot.definition {
        value.insert("MAX_RUN_DURATION".into(), json!("+000 00:00:00"));
    }
    let change = NativeJobChange::Update {
        final_enabled: None,
        argument_target: None,
        attributes: vec![
            NativeJobAttributeChange {
                name: "COMMENTS".into(),
                change: NativeJobFieldChange::Set { value: json!("new") },
            },
            NativeJobAttributeChange {
                name: "MAX_RUN_DURATION".into(),
                change: NativeJobFieldChange::Set { value: json!("0 00:02:00") },
            },
        ],
        arguments: vec![],
    };
    assert!(native_job_mutation_plan(NativeJobEngine::Dameng, &request(&data, change), &data).is_ok());
}
