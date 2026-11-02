use dbx_sql_schema::native_job_changes::{native_job_scheduler_create_plan, NativeJobStepEffect};
use dbx_types::native_jobs::*;
use serde_json::json;

fn scope() -> NativeJobScope {
    NativeJobScope { connection_id: "c".into(), database: "".into(), context_id: "ctx".into() }
}

fn definition() -> NativeJobSchedulerCreate {
    serde_json::from_value(json!({"owner":"Ow\"ner", "name":" Job,'Exact ", "jobType":"STORED_PROCEDURE", "jobAction":"private_call", "numberOfArguments":2, "enabled":true, "autoDrop":false})).unwrap()
}

#[test]
fn only_ob_explicit_create_dates_convert_to_the_executing_session_before_naive_parameters() {
    for engine in [NativeJobEngine::Oracle, NativeJobEngine::OceanbaseOracle, NativeJobEngine::Dameng] {
        for named in [false, true] {
            let mut input = definition();
            input.enabled = false;
            input.start_date = Some("2026-10-21T16:54:25.656000000Z".into());
            input.end_date = Some("2026-10-22T01:02:03.123456000-03:30".into());
            if named {
                input.program = Some(NativeJobObjectReference { owner: input.owner.clone(), name: "Program".into() });
                input.job_type = None;
                input.job_action = None;
                input.number_of_arguments = 0;
            }
            let plan = native_job_scheduler_create_plan(engine, &scope(), &input, None).unwrap();
            let sql = &plan.steps[0].sql;
            for (parameter, value) in [
                ("start_date", "2026-10-21 16:54:25.656000000 +00:00"),
                ("end_date", "2026-10-22 01:02:03.123456000 -03:30"),
            ] {
                let typed = format!("TO_TIMESTAMP_TZ('{value}', 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM')");
                let expected = if engine == NativeJobEngine::OceanbaseOracle {
                    format!("CAST({typed} AT TIME ZONE SESSIONTIMEZONE AS TIMESTAMP(9))")
                } else {
                    typed
                };
                assert!(sql.contains(&format!("{parameter} => {expected}")), "{sql}");
            }
            assert!(!sql.contains("ALTER SESSION"));
            input.start_date = None;
            input.end_date = None;
            let omitted = native_job_scheduler_create_plan(engine, &scope(), &input, None).unwrap();
            assert!(!omitted.steps[0].sql.contains("AT TIME ZONE"));
            assert!(!omitted.steps[0].sql.contains("start_date =>"));
            input.start_date = Some("2026-10-21 16:54:25".into());
            assert!(native_job_scheduler_create_plan(engine, &scope(), &input, None).is_err());
        }
    }
}

#[test]
fn ob_create_rejects_only_non_microsecond_aligned_dates_before_returning_either_overload() {
    for named in [false, true] {
        for end in [false, true] {
            for fraction in ["123456789", "987654321", "999999999", "123456001", "12345601", "1234561", "000000001"] {
                let mut input = definition();
                input.start_date = Some("2032-01-01T23:54:25.123456000Z".into());
                input.end_date = Some("2032-01-02T00:04:25.987654000Z".into());
                let date = Some(format!("2032-01-02T00:04:25.{fraction}Z"));
                if end {
                    input.end_date = date;
                } else {
                    input.start_date = date;
                }
                if named {
                    input.program =
                        Some(NativeJobObjectReference { owner: input.owner.clone(), name: "Program".into() });
                    input.job_type = None;
                    input.job_action = None;
                    input.number_of_arguments = 0;
                }
                assert_eq!(
                    native_job_scheduler_create_plan(NativeJobEngine::OceanbaseOracle, &scope(), &input, None).err(),
                    Some("native_job_timestamp_precision_microseconds")
                );
                for engine in [NativeJobEngine::Oracle, NativeJobEngine::Dameng] {
                    assert!(native_job_scheduler_create_plan(engine, &scope(), &input, None).is_ok());
                }
            }
        }
        for value in [
            "2032-01-01T23:54:25Z",
            "2032-01-01T23:54:25.1Z",
            "2032-01-01T23:54:25.123456Z",
            "2032-01-01T23:54:25.123456000Z",
        ] {
            let mut input = definition();
            input.start_date = Some(value.into());
            input.end_date = Some("2032-01-02T00:04:25.987654000Z".into());
            if named {
                input.program = Some(NativeJobObjectReference { owner: input.owner.clone(), name: "Program".into() });
                input.job_type = None;
                input.job_action = None;
                input.number_of_arguments = 0;
            }
            assert!(native_job_scheduler_create_plan(NativeJobEngine::OceanbaseOracle, &scope(), &input, None).is_ok());
        }
    }
}

#[test]
fn all_typed_character_inputs_are_validated_before_disabled_creation() {
    let mut input = definition();
    input.arguments = vec![NativeJobCreateArgument {
        position: 1,
        data_type: "NVARCHAR2".into(),
        value: NativeJobArgumentValue::Value {
            value: json!({"$dbx":"oracle-anydata-v1","scalarType":"nvarchar2","value":"中文\\😀 "}),
        },
    }];
    let plan = native_job_scheduler_create_plan(NativeJobEngine::Oracle, &scope(), &input, None).unwrap();
    assert_eq!(plan.steps[0].id, "validate-argument:1");
    assert!(matches!(plan.steps[0].effect, NativeJobStepEffect::ArgumentValidated));
    assert!(!plan.steps[0].sql.contains("DBMS_SCHEDULER"));
    assert_eq!(plan.steps[1].id, "create");
    let setter = plan.steps.iter().find(|step| step.id == "argument:1").unwrap();
    assert!(setter.sql.contains("UNISTR('\\4E2D\\6587\\\\\\D83D\\DE00\\0020')"));
    assert!(setter.sql.contains("STRING_TO_RAW"));
    assert!(
        setter.sql.find("native_job_argument_character_loss").unwrap()
            < setter.sql.find("SET_JOB_ANYDATA_VALUE").unwrap()
    );
}

#[test]
fn lightweight_creation_rejects_anydata_before_returning_a_create_plan() {
    let mut input = definition();
    input.job_type = None;
    input.job_action = None;
    input.number_of_arguments = 0;
    input.program = Some(NativeJobObjectReference { owner: "Owner".into(), name: "Program".into() });
    input.job_style = Some("LIGHTWEIGHT".into());
    for value in [
        NativeJobArgumentValue::Null,
        NativeJobArgumentValue::Value { value: json!("") },
        NativeJobArgumentValue::Value {
            value: json!({"$dbx":"oracle-anydata-v1","typeName":"SYS.NUMBER","value":"1"}),
        },
    ] {
        input.arguments = vec![NativeJobCreateArgument { position: 1, data_type: "NUMBER".into(), value }];
        assert!(matches!(
            native_job_scheduler_create_plan(NativeJobEngine::Oracle, &scope(), &input, None),
            Err("native_job_lightweight_anydata_unsupported")
        ));
    }
    input.arguments[0].value = NativeJobArgumentValue::Value { value: json!("123") };
    let plan = native_job_scheduler_create_plan(NativeJobEngine::Oracle, &scope(), &input, None).unwrap();
    assert!(plan.steps.iter().any(|step| step.sql.contains("SET_JOB_ARGUMENT_VALUE")));
    assert!(plan.steps.iter().all(|step| !step.sql.contains("SET_JOB_ANYDATA_VALUE")));
}

#[test]
fn initial_creation_is_disabled_and_complete_configuration_precedes_activation() {
    let mut input = definition();
    input.start_date = Some("2030-01-01T10:20:30.123+08:00".into());
    input.repeat_interval = Some("FREQ=DAILY;BYHOUR=8".into());
    input.comments = Some("owner's comment".into());
    input.attributes = vec![NativeJobAttributeChange {
        name: "LOGGING_LEVEL".into(),
        change: NativeJobFieldChange::Set { value: json!("FULL") },
    }];
    input.arguments = vec![NativeJobCreateArgument {
        position: 1,
        data_type: "VARCHAR2".into(),
        value: NativeJobArgumentValue::Value { value: json!("value's text") },
    }];
    let plan = native_job_scheduler_create_plan(NativeJobEngine::Oracle, &scope(), &input, None).unwrap();
    assert_eq!(
        plan.steps.iter().map(|step| step.id.as_str()).collect::<Vec<_>>(),
        ["create", "attributes", "argument:1", "enable"]
    );
    assert!(matches!(plan.steps[0].effect, NativeJobStepEffect::Created));
    let sql = &plan.steps[0].sql;
    assert!(sql.contains("job_name => '\"Ow\"\"ner\".\" Job,''Exact \"'"));
    assert!(sql.contains("enabled => FALSE"));
    assert!(sql.contains("auto_drop => FALSE"));
    assert!(sql.contains("TO_TIMESTAMP_TZ('2030-01-01 10:20:30.123 +08:00', 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM')"));
    assert!(sql.contains("comments => 'owner''s comment'"));
    assert!(plan.steps[1].sql.contains("LOGGING_FULL"));
    assert!(plan.steps[2].sql.contains("argument_value => 'value''s text'"));
    assert!(matches!(plan.steps.last().unwrap().effect, NativeJobStepEffect::Enabled(true)));
    assert!(plan.steps.iter().all(|step| !step.sql.contains("RUN_JOB") && !step.sql.contains("DROP_JOB")));
}

#[test]
fn named_program_and_schedule_overloads_do_not_send_conflicting_inline_fields() {
    for engine in [NativeJobEngine::Oracle, NativeJobEngine::Dameng] {
        for use_program in [false, true] {
            for use_schedule in [false, true] {
                let mut input = definition();
                input.enabled = false;
                if use_program {
                    input.job_type = None;
                    input.job_action = None;
                    input.number_of_arguments = 0;
                    input.program =
                        Some(NativeJobObjectReference { owner: "Other.Owner".into(), name: "Program\"Name".into() });
                    input.job_style = Some("REGULAR".into());
                }
                if use_schedule {
                    input.schedule =
                        Some(NativeJobObjectReference { owner: "CalendarOwner".into(), name: "Calendar.Name".into() });
                }
                let plan = native_job_scheduler_create_plan(engine, &scope(), &input, None).unwrap();
                let sql = &plan.steps[0].sql;
                assert_eq!(plan.steps.len(), 1);
                assert_eq!(sql.contains("program_name =>"), use_program);
                assert_eq!(sql.contains("job_action =>"), !use_program);
                assert_eq!(sql.contains("number_of_arguments =>"), !use_program);
                assert_eq!(sql.contains("schedule_name =>"), use_schedule);
                if use_program {
                    assert!(sql.contains("'\"Other.Owner\".\"Program\"\"Name\"'"));
                }
                if use_schedule {
                    assert!(!sql.contains("repeat_interval =>") && !sql.contains("start_date =>"));
                }
            }
        }
    }
}

#[test]
fn ob_uses_its_singular_parameter_and_literal_job_name_and_resolves_only_its_own_guard() {
    let mut input = definition();
    input.job_action = Some("private_call(':dbx_created_job_id')".into());
    let preview = native_job_scheduler_create_plan(NativeJobEngine::OceanbaseOracle, &scope(), &input, None).unwrap();
    assert!(preview.steps[0].sql.contains("job_name => ' Job,''Exact '"));
    assert!(preview.steps[0].sql.contains("number_of_argument => 2"));
    assert!(!preview.steps[0].sql.contains("number_of_arguments =>"));
    assert!(preview.steps.last().unwrap().sql.contains("JOB = :dbx_created_job_id"));
    let identity = NativeJobRow::from([("DBX_JOB_ID".into(), json!("900719925474099312345"))]);
    let applied =
        native_job_scheduler_create_plan(NativeJobEngine::OceanbaseOracle, &scope(), &input, Some(&identity)).unwrap();
    assert!(applied.steps.last().unwrap().sql.contains("JOB = 900719925474099312345"));
    assert!(!applied.steps.last().unwrap().sql.contains(":dbx_created_job_id"));
    assert_eq!(applied.steps[0].sql, preview.steps[0].sql, "the native body is never changed by guard binding");
}

#[test]
fn creation_preserves_unset_and_inherited_arguments_and_uses_typed_null_without_activating() {
    let mut input = definition();
    input.enabled = false;
    input.number_of_arguments = 3;
    input.arguments = vec![
        NativeJobCreateArgument { position: 1, data_type: "VARCHAR2".into(), value: NativeJobArgumentValue::Unset },
        NativeJobCreateArgument { position: 2, data_type: "VARCHAR2".into(), value: NativeJobArgumentValue::Inherit },
        NativeJobCreateArgument { position: 3, data_type: "NUMBER".into(), value: NativeJobArgumentValue::Null },
    ];
    let plan = native_job_scheduler_create_plan(NativeJobEngine::Oracle, &scope(), &input, None).unwrap();
    assert_eq!(plan.steps.len(), 2);
    assert!(plan.steps[1].sql.contains("argument_position => 3"));
    assert!(plan.steps[1].sql.contains("ConvertNumber(CAST(NULL AS NUMBER))"));
    assert!(!plan.steps[1].sql.contains("RESET_JOB_ARGUMENT_VALUE"));
}

#[test]
fn event_overload_supplies_required_nulls_for_a_named_program() {
    let mut input = definition();
    input.program = Some(NativeJobObjectReference { owner: "Owner".into(), name: "Program".into() });
    input.job_type = None;
    input.job_action = None;
    input.number_of_arguments = 0;
    input.event_source = Some(NativeJobEventSource::Queue {
        owner: "QueueOwner".into(),
        name: "Events".into(),
        agent: Some("Agent".into()),
    });
    let plan = native_job_scheduler_create_plan(NativeJobEngine::Oracle, &scope(), &input, None).unwrap();
    let sql = &plan.steps[0].sql;
    assert!(sql.contains("queue_spec => '\"QueueOwner\".\"Events\",\"Agent\"'"));
    for parameter in ["start_date => NULL", "end_date => NULL", "event_condition => NULL"] {
        assert!(sql.contains(parameter));
    }
    input.job_style = Some("LIGHTWEIGHT".into());
    assert!(matches!(
        native_job_scheduler_create_plan(NativeJobEngine::Oracle, &scope(), &input, None),
        Err("native_job_style_not_applicable_to_event")
    ));
}

#[test]
fn invalid_conflicting_or_duplicate_creation_inputs_fail_before_any_plan_is_returned() {
    let original = definition();
    let mut inputs = Vec::new();
    let mut input = original.clone();
    input.program = Some(NativeJobObjectReference { owner: "Owner".into(), name: "Program".into() });
    inputs.push(input);
    let mut input = original.clone();
    input.schedule = Some(NativeJobObjectReference { owner: "Owner".into(), name: "Schedule".into() });
    input.repeat_interval = Some("FREQ=DAILY".into());
    inputs.push(input);
    let mut input = original.clone();
    input.name.clear();
    inputs.push(input);
    let mut input = original.clone();
    input.number_of_arguments = 256;
    inputs.push(input);
    let mut input = original.clone();
    input.start_date = Some("2030-01-01 00:00:00".into());
    inputs.push(input);
    let mut input = original.clone();
    input.attributes = vec![NativeJobAttributeChange {
        name: "ENABLED".into(),
        change: NativeJobFieldChange::Set { value: json!(true) },
    }];
    inputs.push(input);
    let mut input = original.clone();
    input.arguments = vec![NativeJobCreateArgument {
        position: 3,
        data_type: "VARCHAR2".into(),
        value: NativeJobArgumentValue::Null,
    }];
    inputs.push(input);
    let mut input = original;
    input.job_type = Some("PLSQL_BLOCK".into());
    inputs.push(input);
    for input in inputs {
        assert!(native_job_scheduler_create_plan(NativeJobEngine::Oracle, &scope(), &input, None).is_err());
    }
}

#[test]
fn ob_creation_enforces_its_native_argument_limit_and_rejects_unavailable_overloads() {
    let mut input = definition();
    input.number_of_arguments = 256;
    assert!(matches!(
        native_job_scheduler_create_plan(NativeJobEngine::OceanbaseOracle, &scope(), &input, None),
        Err("native_job_argument_count_invalid")
    ));
    input.number_of_arguments = 0;
    for job_type in ["CHAIN", "EXECUTABLE", "EXTERNAL_SCRIPT", "SQL_SCRIPT", "BACKUP_SCRIPT"] {
        input.job_type = Some(job_type.into());
        assert!(
            native_job_scheduler_create_plan(NativeJobEngine::OceanbaseOracle, &scope(), &input, None).is_err(),
            "{job_type}"
        );
    }
    input.job_type = Some("PLSQL_BLOCK".into());
    assert!(native_job_scheduler_create_plan(NativeJobEngine::OceanbaseOracle, &scope(), &input, None).is_ok());
    for field in ["schedule", "credential", "destination"] {
        let mut unsupported = input.clone();
        match field {
            "schedule" => {
                unsupported.schedule = Some(NativeJobObjectReference { owner: "Owner".into(), name: "Schedule".into() })
            }
            "credential" => unsupported.credential_name = Some("Credential".into()),
            _ => unsupported.destination_name = Some("Destination".into()),
        }
        assert!(
            native_job_scheduler_create_plan(NativeJobEngine::OceanbaseOracle, &scope(), &unsupported, None).is_err(),
            "{field}"
        );
    }
}
