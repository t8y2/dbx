use dbx_sql_schema::native_job_changes::{native_job_scheduler_edit_plan, NativeJobStepEffect};
use dbx_types::native_jobs::*;
use serde_json::{json, Value};

fn details() -> NativeJobDetails {
    serde_json::from_value(json!({
        "snapshot":{"ref":{"kind":"scheduler","owner":"Owner","name":"Job's,Exact","scope":{"connectionId":"c","database":"","contextId":"ctx"}},"revision":"baseline",
        "definition":{"status":"available","value":{"OWNER":"Owner","JOB_NAME":"Job's,Exact","PROGRAM_OWNER":"Old.Owner","PROGRAM_NAME":"Old.Program","JOB_TYPE":null,"JOB_ACTION":null,"NUMBER_OF_ARGUMENTS":null,"SCHEDULE_OWNER":null,"SCHEDULE_NAME":null,"SCHEDULE_TYPE":"CALENDAR","START_DATE":"2030-01-01T00:00:00+08:00","END_DATE":null,"REPEAT_INTERVAL":"FREQ=DAILY","ENABLED":"TRUE","COMMENTS":"untouched","CREDENTIAL_OWNER":null,"CREDENTIAL_NAME":null,"CONNECT_CREDENTIAL_OWNER":null,"CONNECT_CREDENTIAL_NAME":null,"DESTINATION_OWNER":null,"DESTINATION":null,"JOB_STYLE":"REGULAR","EVENT_CONDITION":null,"EVENT_QUEUE_OWNER":null,"EVENT_QUEUE_NAME":null,"EVENT_QUEUE_AGENT":null,"FILE_WATCHER_OWNER":null,"FILE_WATCHER_NAME":null}},
        "arguments":{"status":"available","value":[]}},
        "nativeIdentity":{"status":"available","value":{"DBX_JOB_ID":"42","DBX_CREATED_AT":"creation"}},"consistency":{"status":"available","value":null},"parameterMetadata":{"status":"empty"},"steps":{"status":"empty"},"schedules":{"status":"empty"},"running":{"status":"empty"},"history":{"status":"empty"},"sources":{}
    })).unwrap()
}

fn request(details: &NativeJobDetails, attributes: Value, argument_target: Value) -> NativeJobMutation {
    serde_json::from_value(json!({"target":details.snapshot.job_ref,"baseline":"baseline","action":"update","attributes":attributes,"arguments":[],"argumentTarget":argument_target})).unwrap()
}

#[test]
fn dameng_named_schedule_replacement_does_not_clear_oracle_inline_or_event_fields() {
    let mut data = details();
    let NativeJobMetadata::Available { value } = &mut data.snapshot.definition else { unreachable!() };
    value.insert("SCHEDULE_OWNER".into(), json!("Old.Owner"));
    value.insert("SCHEDULE_NAME".into(), json!("Old.Schedule"));
    value.insert("SCHEDULE_TYPE".into(), json!("NAMED"));
    let mutation = request(
        &data,
        json!([{"name":"SCHEDULE_NAME","change":{"kind":"set","value":{"owner":"New.Owner","name":"New.Schedule"}}}]),
        Value::Null,
    );
    let plan = native_job_scheduler_edit_plan(NativeJobEngine::Dameng, &mutation, &data).unwrap();
    let sql = plan.sql.steps.iter().map(|step| step.sql.as_str()).collect::<Vec<_>>().join("\n");
    assert!(sql.contains("'schedule_name'"));
    for attribute in ["'event_spec'", "'start_date'", "'end_date'", "'repeat_interval'"] {
        assert!(!sql.contains(attribute), "unexpected Oracle clear: {attribute}");
    }
}

#[test]
fn dameng_inline_reference_changes_do_not_assume_an_unproven_null_transition() {
    let mut data = details();
    let NativeJobMetadata::Available { value } = &mut data.snapshot.definition else { unreachable!() };
    value.insert("PROGRAM_OWNER".into(), Value::Null);
    value.insert("PROGRAM_NAME".into(), Value::Null);
    value.insert("JOB_TYPE".into(), json!("STORED_PROCEDURE"));
    value.insert("JOB_ACTION".into(), json!("proc"));
    value.insert("NUMBER_OF_ARGUMENTS".into(), json!(0));
    let reference = json!({"owner":"New.Owner","name":"New.Program"});
    let mutation = request(
        &data,
        json!([{"name":"PROGRAM_NAME","change":{"kind":"set","value":reference}}]),
        json!({"program":reference,"arguments":[]}),
    );
    assert!(matches!(
        native_job_scheduler_edit_plan(NativeJobEngine::Dameng, &mutation, &data),
        Err("native_job_reference_attach_mapping_unverified")
    ));
}

#[test]
fn dameng_parameter_reset_is_not_serialized_as_an_oracle_package_call() {
    let data = details();
    for value in [NativeJobArgumentValue::Unset, NativeJobArgumentValue::Inherit] {
        let change = NativeJobArgumentChange { position: 1, value };
        assert!(matches!(
            dbx_sql_schema::native_job_changes::scheduler_argument_step(
                NativeJobEngine::Dameng,
                &data.snapshot.job_ref,
                None,
                &change,
                "VARCHAR2"
            ),
            Err("native_job_argument_reset_mapping_unverified")
        ));
    }
}

#[test]
fn dameng_full_inheritance_target_is_a_postcondition_not_a_fabricated_reset() {
    let mut data = details();
    let target = json!({"program":{"owner":"Old.Owner","name":"Old.Program"},"arguments":[{"position":1,"dataType":"VARCHAR2","value":{"kind":"inherit"}}]});
    for metadata in [NativeJobMetadata::Empty, NativeJobMetadata::Available { value: vec![] }] {
        data.parameter_metadata = metadata;
        let plan =
            native_job_scheduler_edit_plan(NativeJobEngine::Dameng, &request(&data, json!([]), target.clone()), &data)
                .unwrap();
        assert!(!plan.sql.steps.iter().any(|step| step.sql.contains("RESET_JOB_ARGUMENT_VALUE")));
        assert!(plan.argument_target.is_some());
    }
    data.parameter_metadata =
        NativeJobMetadata::Available { value: vec![serde_json::from_value(json!({"ARGUMENT_POSITION":1})).unwrap()] };
    assert!(matches!(
        native_job_scheduler_edit_plan(NativeJobEngine::Dameng, &request(&data, json!([]), target), &data),
        Err("native_job_argument_reset_mapping_unverified")
    ));
    let changed = json!({"owner":"New.Owner","name":"New.Program"});
    let plan = native_job_scheduler_edit_plan(
        NativeJobEngine::Dameng,
        &request(
            &data,
            json!([{"name":"PROGRAM_NAME","change":{"kind":"set","value":changed}}]),
            json!({"program":changed,"arguments":[{"position":1,"dataType":"VARCHAR2","value":{"kind":"inherit"}}]}),
        ),
        &data,
    )
    .unwrap();
    assert!(!plan.sql.steps.iter().any(|step| step.sql.contains("RESET_JOB_ARGUMENT_VALUE")));
}

#[test]
fn typed_number_uses_anydata_but_legacy_strings_keep_the_string_setter() {
    use dbx_sql_schema::native_job_changes::scheduler_argument_step;
    use dbx_sql_schema::native_jobs::NativeJobCatalogDialect;
    let data = details();
    let number = json!({"$dbx":"oracle-anydata-v1","typeName":"SYS.NUMBER","value":"9007199254740993.123"});
    let change = NativeJobArgumentChange { position: 1, value: NativeJobArgumentValue::Value { value: number } };
    let step =
        scheduler_argument_step(NativeJobCatalogDialect::Oracle, &data.snapshot.job_ref, None, &change, "NUMBER")
            .unwrap();
    assert!(step.sql.contains("SET_JOB_ANYDATA_VALUE"));
    assert!(step.sql.contains("SYS.ANYDATA.ConvertNumber(9.007199254740993123E15)"));
    let NativeJobStepEffect::Argument(expected, _) = step.effect else { panic!("argument effect required") };
    assert_eq!(serde_json::to_value(expected.value).unwrap()["value"]["value"], "9.007199254740993123E15");
    let legacy = NativeJobArgumentChange {
        position: 1,
        value: NativeJobArgumentValue::Value { value: json!("9007199254740993.123") },
    };
    let step =
        scheduler_argument_step(NativeJobCatalogDialect::Oracle, &data.snapshot.job_ref, None, &legacy, "NUMBER")
            .unwrap();
    assert!(step.sql.contains("SET_JOB_ARGUMENT_VALUE"));
    assert!(!step.sql.contains("ConvertNumber"));
    for dialect in [NativeJobCatalogDialect::Dameng, NativeJobCatalogDialect::OceanbaseOracle] {
        assert!(scheduler_argument_step(dialect, &data.snapshot.job_ref, None, &change, "NUMBER").is_err());
    }
}

#[test]
fn typed_char_null_survives_delta_and_program_conversion_without_becoming_varchar_null() {
    let mut data = details();
    let value = json!({"kind":"value","value":{"$dbx":"oracle-anydata-v1","scalarType":"char","value":null}});
    data.snapshot.arguments = serde_json::from_value(
        json!({"status":"available","value":[{"position":1,"dataType":"VARCHAR2","value":value,"editable":true}]}),
    )
    .unwrap();
    let mut delta = request(&data, json!([]), Value::Null);
    let NativeJobChange::Update { arguments, .. } = &mut delta.change else { unreachable!() };
    arguments.push(serde_json::from_value(json!({"position":1,"value":value})).unwrap());
    let plan = native_job_scheduler_edit_plan(NativeJobEngine::Oracle, &delta, &data).unwrap();
    let step = plan.sql.steps.iter().find(|step| matches!(step.effect, NativeJobStepEffect::Argument(..))).unwrap();
    assert!(step.sql.contains("ConvertChar(CAST(NULL AS CHAR(1)))"));
    assert!(!step.sql.contains("l_anydata := SYS.ANYDATA.ConvertVarchar2"));
    let transition = request(
        &data,
        json!([{"name":"PROGRAM_NAME","change":{"kind":"set","value":{"owner":"Other","name":"Target"}}}]),
        json!({"program":{"owner":"Other","name":"Target"},"arguments":[{"position":1,"dataType":"VARCHAR2","value":value}]}),
    );
    let plan = native_job_scheduler_edit_plan(NativeJobEngine::Oracle, &transition, &data).unwrap();
    let NativeJobStepEffect::ArgumentValidated = plan.sql.steps[0].effect else {
        panic!("preflight must precede pause")
    };
    assert!(plan.sql.steps.iter().any(|step| matches!(step.effect, NativeJobStepEffect::Argument(..))
        && step.sql.contains("ConvertChar(CAST(NULL AS CHAR(1)))")));
}

#[test]
fn lightweight_arguments_are_rejected_before_delta_or_transition_can_pause() {
    let mut data = details();
    let NativeJobMetadata::Available { value } = &mut data.snapshot.definition else { unreachable!() };
    value.insert("JOB_STYLE".into(), json!("LIGHTWEIGHT"));
    data.snapshot.arguments = serde_json::from_value(json!({"status":"available","value":[{"position":1,"dataType":"NUMBER","value":{"kind":"unset"},"editable":true}]})).unwrap();
    for value in [
        json!({"kind":"null"}),
        json!({"kind":"value","value":""}),
        json!({"kind":"value","value":{"$dbx":"oracle-anydata-v1","typeName":"SYS.NUMBER","value":"1"}}),
    ] {
        let mut delta = request(&data, json!([]), Value::Null);
        let NativeJobChange::Update { arguments, .. } = &mut delta.change else { unreachable!() };
        arguments.push(serde_json::from_value(json!({"position":1,"value":value})).unwrap());
        assert!(matches!(
            dbx_sql_schema::native_job_changes::native_job_mutation_plan(NativeJobEngine::Oracle, &delta, &data),
            Err("native_job_lightweight_anydata_unsupported")
        ));
        let transition = request(
            &data,
            json!([]),
            json!({"program":{"owner":"Old.Owner","name":"Old.Program"},"arguments":[{"position":1,"dataType":"NUMBER","value":value}]}),
        );
        assert!(matches!(
            native_job_scheduler_edit_plan(NativeJobEngine::Oracle, &transition, &data),
            Err("native_job_lightweight_anydata_unsupported")
        ));
    }
}

#[test]
fn a_program_switch_is_paused_and_checks_native_columns_not_a_json_name() {
    let data = details();
    let target = json!({"owner":"New.Owner","name":"P,'\"Q"});
    let mutation = request(
        &data,
        json!([{"name":"PROGRAM_NAME","change":{"kind":"set","value":target}}]),
        json!({"program":target,"arguments":[]}),
    );
    let plan = native_job_scheduler_edit_plan(NativeJobEngine::Oracle, &mutation, &data).unwrap();
    assert!(plan.transition);
    assert!(plan.final_enabled);
    assert_eq!(plan.sql.steps[0].id, "pause");
    let definition = &plan.sql.steps[1];
    assert!(definition.sql.contains("SET_JOB_ATTRIBUTES"));
    assert!(definition.sql.contains("TRANSACTIONAL"));
    assert!(definition.sql.contains("\"New.Owner\".\"P,''\"\"Q\""));
    assert!(!definition.sql.contains("CREATE_JOB"));
    let NativeJobStepEffect::SchedulerDefinition(effect) = &definition.effect else {
        panic!("native projection missing")
    };
    assert!(effect.columns.iter().any(|column| column.name == "PROGRAM_OWNER"
        && column.change == NativeJobFieldChange::Set { value: json!("New.Owner") }));
    for column in ["JOB_TYPE", "JOB_ACTION", "NUMBER_OF_ARGUMENTS"] {
        assert!(effect
            .columns
            .iter()
            .any(|change| change.name == column && change.change == NativeJobFieldChange::Clear));
    }
    assert_eq!(plan.sql.steps.last().unwrap().id, "enable");
}

#[test]
fn inline_conversion_clears_the_reference_in_the_same_definition_batch() {
    let data = details();
    let mutation = request(
        &data,
        json!([
            {"name":"PROGRAM_NAME","change":{"kind":"clear"}},
            {"name":"JOB_TYPE","change":{"kind":"set","value":"STORED_PROCEDURE"}},
            {"name":"JOB_ACTION","change":{"kind":"set","value":"proc_new"}},
            {"name":"NUMBER_OF_ARGUMENTS","change":{"kind":"set","value":2}}
        ]),
        json!({"program":null,"arguments":[{"position":1,"dataType":"VARCHAR2","value":{"kind":"unset"}},{"position":2,"dataType":"NUMBER","value":{"kind":"null"}}]}),
    );
    let plan = native_job_scheduler_edit_plan(NativeJobEngine::Oracle, &mutation, &data).unwrap();
    assert!(plan.context_changed);
    let definition = &plan.sql.steps[1];
    assert!(definition.sql.contains("'program_name')"));
    assert!(definition.sql.contains("'job_type', 'STORED_PROCEDURE'"));
    assert!(definition.sql.contains("'number_of_arguments', 2"));
    assert!(plan.sql.steps.iter().any(|step| step.sql.contains("ConvertNumber(CAST(NULL AS NUMBER))")));
}

#[test]
fn an_identical_structured_reference_does_not_add_new_read_or_pause_requirements() {
    let data = details();
    let mutation = request(
        &data,
        json!([
            {"name":"PROGRAM_NAME","change":{"kind":"set","value":{"owner":"Old.Owner","name":"Old.Program"}}},
            {"name":"COMMENTS","change":{"kind":"set","value":"new"}}
        ]),
        Value::Null,
    );
    let plan = native_job_scheduler_edit_plan(NativeJobEngine::Oracle, &mutation, &data).unwrap();
    assert!(!plan.transition);
    assert!(plan.references.is_empty());
    assert_eq!(plan.sql.steps.len(), 1);
    assert!(!plan.sql.steps[0].sql.contains("DISABLE"));
}

#[test]
fn schedule_categories_and_event_spec_keep_their_real_native_contracts() {
    let data = details();
    let mutation = request(
        &data,
        json!([{"name":"SCHEDULE_NAME","change":{"kind":"set","value":{"owner":"SYS","name":"Night,Window","kind":"window"}}}]),
        Value::Null,
    );
    let plan = native_job_scheduler_edit_plan(NativeJobEngine::Oracle, &mutation, &data).unwrap();
    assert_eq!(plan.references[0].target.kind, NativeJobReferenceKind::Window);
    assert!(plan.sql.steps[1].sql.contains("'repeat_interval')"));
    let mutation = request(
        &data,
        json!([{"name":"EVENT_SPEC","change":{"kind":"set","value":{"condition":"tab.user_data.flag = 'Y'","source":{"kind":"queue","owner":"AQ.Owner","name":"Q,1","agent":"Agent.One"}}}}]),
        Value::Null,
    );
    let plan = native_job_scheduler_edit_plan(NativeJobEngine::Oracle, &mutation, &data).unwrap();
    assert!(plan.transition);
    assert!(plan.sql.steps[1]
        .sql
        .contains("'event_spec', 'tab.user_data.flag = ''Y''', '\"AQ.Owner\".\"Q,1\",\"Agent.One\"'"));
}

#[test]
fn unsupported_ob_transitions_and_incomplete_argument_intent_fail_before_a_pause_exists() {
    let data = details();
    let attrs = json!([{"name":"PROGRAM_NAME","change":{"kind":"set","value":{"owner":"New.Owner","name":"New"}}}]);
    let mutation = request(&data, attrs.clone(), Value::Null);
    assert_eq!(
        native_job_scheduler_edit_plan(NativeJobEngine::Oracle, &mutation, &data).err(),
        Some("native_job_argument_target_required")
    );
    let mutation = request(&data, attrs, json!({"program":{"owner":"New.Owner","name":"New"},"arguments":[]}));
    assert_eq!(
        native_job_scheduler_edit_plan(NativeJobEngine::OceanbaseOracle, &mutation, &data).err(),
        Some("native_job_attribute_not_editable")
    );
    let mut wrong = mutation;
    if let NativeJobChange::Update { argument_target: Some(target), .. } = &mut wrong.change {
        target.program = None;
    }
    assert_eq!(
        native_job_scheduler_edit_plan(NativeJobEngine::Oracle, &wrong, &data).err(),
        Some("native_job_argument_target_mismatch")
    );
}

#[test]
fn an_unrelated_unreadable_program_does_not_become_a_new_scalar_edit_precondition() {
    let mut data = details();
    if let NativeJobMetadata::Available { value } = &mut data.snapshot.definition {
        value.remove("PROGRAM_OWNER");
    }
    let mutation = request(&data, json!([{"name":"COMMENTS","change":{"kind":"set","value":"new"}}]), Value::Null);
    let plan = native_job_scheduler_edit_plan(NativeJobEngine::Oracle, &mutation, &data).unwrap();
    assert!(!plan.transition);
    assert!(plan.references.is_empty());
}

#[test]
fn a_numeric_driver_representation_does_not_change_the_argument_context() {
    let mut data = details();
    if let NativeJobMetadata::Available { value } = &mut data.snapshot.definition {
        value.insert("PROGRAM_OWNER".into(), Value::Null);
        value.insert("PROGRAM_NAME".into(), Value::Null);
        value.insert("JOB_TYPE".into(), json!("STORED_PROCEDURE"));
        value.insert("NUMBER_OF_ARGUMENTS".into(), json!("2"));
    }
    let mutation =
        request(&data, json!([{"name":"NUMBER_OF_ARGUMENTS","change":{"kind":"set","value":2}}]), Value::Null);
    let plan = native_job_scheduler_edit_plan(NativeJobEngine::Oracle, &mutation, &data).unwrap();
    assert!(!plan.context_changed);
}

#[test]
fn detaching_a_named_schedule_checks_immediate_and_once_as_different_native_projections() {
    for (start, expected) in [(Value::Null, "IMMEDIATE"), (json!("2030-01-01T00:00:00+08:00"), "ONCE")] {
        let mut data = details();
        if let NativeJobMetadata::Available { value } = &mut data.snapshot.definition {
            value.insert("SCHEDULE_OWNER".into(), json!("Owner"));
            value.insert("SCHEDULE_NAME".into(), json!("Calendar"));
            value.insert("SCHEDULE_TYPE".into(), json!("NAMED"));
            value.insert("START_DATE".into(), Value::Null);
            value.insert("REPEAT_INTERVAL".into(), Value::Null);
        }
        let mutation = request(
            &data,
            json!([{"name":"SCHEDULE_NAME","change":{"kind":"clear"}},{"name":"START_DATE","change":{"kind":"set","value":start}}]),
            Value::Null,
        );
        let plan = native_job_scheduler_edit_plan(NativeJobEngine::Oracle, &mutation, &data).unwrap();
        assert_eq!(plan.definition["SCHEDULE_TYPE"], json!(expected));
    }
}

#[test]
fn typed_null_projection_uses_guarded_anydata_access_only_in_native_oracle() {
    let data = details();
    let queries = dbx_sql_schema::native_jobs::native_job_catalog_queries(
        NativeJobEngine::Oracle,
        &data.snapshot.job_ref,
        dbx_sql_schema::native_jobs::NativeJobCatalogPart::Arguments,
    )
    .unwrap();
    assert_eq!(queries.len(), 3);
    for query in queries {
        assert!(query.sql.contains("CASE WHEN J.ANYDATA_VALUE IS NOT NULL THEN"));
        assert!(query.sql.contains("GetTypeName()"));
        assert!(query
            .sql
            .contains("WHEN 'number' THEN CASE WHEN J.ANYDATA_VALUE.AccessNumber() IS NULL THEN 1 ELSE 0 END"));
        assert!(query.sql.contains("ELSE NULL END END AS DBX_ANYDATA_IS_NULL"));
        assert!(query.sql.contains("THEN 1 ELSE 0 END AS DBX_ANYDATA_PRESENT"));
        assert!(query.sql.contains("TO_CHAR(J.ANYDATA_VALUE.AccessNumber(), 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,''')"));
        assert!(query.sql.contains("AS DBX_ANYDATA_TEXT"));
    }
    for query in dbx_sql_schema::native_jobs::native_job_catalog_queries(
        NativeJobEngine::Dameng,
        &data.snapshot.job_ref,
        dbx_sql_schema::native_jobs::NativeJobCatalogPart::Arguments,
    )
    .unwrap()
    {
        assert!(!query.sql.contains("ANYDATA_VALUE"));
    }
}

#[test]
fn an_inline_schedule_change_carries_its_native_schedule_type_and_pause() {
    let data = details();
    let mutation = request(&data, json!([{"name":"REPEAT_INTERVAL","change":{"kind":"clear"}}]), Value::Null);
    let plan = native_job_scheduler_edit_plan(NativeJobEngine::Oracle, &mutation, &data).unwrap();
    assert!(plan.transition);
    assert_eq!(plan.sql.steps[0].id, "pause");
    assert_eq!(plan.definition["SCHEDULE_TYPE"], json!("ONCE"));
}

#[test]
fn an_old_host_destination_is_not_tokenized_or_treated_as_a_named_target() {
    let mut data = details();
    if let NativeJobMetadata::Available { value } = &mut data.snapshot.definition {
        value.insert("DESTINATION_OWNER".into(), Value::Null);
        value.insert("DESTINATION".into(), json!("host.example:15000"));
    }
    let mutation = request(
        &data,
        json!([{"name":"DESTINATION_NAME","change":{"kind":"set","value":{"owner":"Remote.Owner","name":"Remote.DB"}}}]),
        Value::Null,
    );
    let plan = native_job_scheduler_edit_plan(NativeJobEngine::Oracle, &mutation, &data).unwrap();
    assert_eq!(plan.definition["DESTINATION_OWNER"], json!("Remote.Owner"));
    assert_eq!(plan.definition["DESTINATION"], json!("Remote.DB"));
    assert_eq!(plan.references.len(), 1);
}

#[test]
fn destination_group_member_inventory_is_an_exact_nonselectable_read_not_a_count_formula() {
    use dbx_sql_schema::native_jobs::native_job_reference_queries;
    let mut request: NativeJobReferenceListRequest = serde_json::from_value(json!({"scope":{"connectionId":"c","database":"","contextId":"ctx"},"kind":"destination-group-members","schema":"Owner.With.Dot","name":"Group,One","limit":10000})).unwrap();
    let queries = native_job_reference_queries(NativeJobEngine::Oracle, &request).unwrap();
    assert_eq!(queries.len(), 3);
    for query in queries {
        assert!(query.source.ends_with("SCHEDULER_GROUP_MEMBERS"));
        assert!(query.sql.contains("J.MEMBER_NAME"));
        assert!(query.sql.contains("J.GROUP_NAME = 'Group,One'"));
        assert!(!query.sql.contains("CONNECT_INFO"));
    }
    assert!(native_job_reference_queries(NativeJobEngine::Dameng, &request).unwrap().is_empty());
    request.name = None;
    assert!(native_job_reference_queries(NativeJobEngine::Oracle, &request).is_err());
}

#[test]
fn a_raw_destination_uses_its_native_slot_inside_the_controlled_transition() {
    let mut data = details();
    if let NativeJobMetadata::Available { value } = &mut data.snapshot.definition {
        value.insert("DESTINATION".into(), json!("old.host:1500"));
    }
    for change in [json!({"kind":"set","value":"Host.With.Dots:1501"}), json!({"kind":"clear"})] {
        let mutation = request(&data, json!([{"name":"DESTINATION","change":change}]), Value::Null);
        let plan = native_job_scheduler_edit_plan(NativeJobEngine::Oracle, &mutation, &data).unwrap();
        assert!(plan.transition);
        assert!(plan.references.is_empty());
        assert_eq!(plan.sql.steps.first().unwrap().id, "pause");
        assert_eq!(plan.sql.steps.last().unwrap().id, "enable");
        let step = plan.sql.steps.iter().find(|step| step.id == "attribute:DESTINATION").unwrap();
        assert!(step.sql.contains("attribute => 'destination'"));
        assert!(!step.sql.contains("'destination_name'"));
        if change["kind"] == "clear" {
            assert!(step.sql.contains("SET_ATTRIBUTE_NULL"));
            assert_eq!(plan.definition["DESTINATION"], Value::Null);
        } else {
            assert!(step.sql.contains("value => 'Host.With.Dots:1501'"));
            assert_eq!(plan.definition["DESTINATION"], json!("Host.With.Dots:1501"));
        }
        assert_eq!(plan.definition["DESTINATION_OWNER"], Value::Null);
    }
}

#[test]
fn raw_and_named_destination_intents_cannot_be_combined_or_silently_retyped() {
    let data = details();
    let mutation = request(
        &data,
        json!([
            {"name":"DESTINATION","change":{"kind":"set","value":"raw.host:1500"}},
            {"name":"DESTINATION_NAME","change":{"kind":"set","value":{"owner":"Owner","name":"Named"}}}
        ]),
        Value::Null,
    );
    assert!(matches!(
        native_job_scheduler_edit_plan(NativeJobEngine::Oracle, &mutation, &data),
        Err("native_job_destination_contract_conflict")
    ));
    for value in [json!(""), json!("host\u{0000}name"), json!({"owner":"Owner","name":"Named"})] {
        let mutation =
            request(&data, json!([{"name":"DESTINATION","change":{"kind":"set","value":value}}]), Value::Null);
        assert!(native_job_scheduler_edit_plan(NativeJobEngine::Oracle, &mutation, &data).is_err());
    }
    let mutation =
        request(&data, json!([{"name":"DESTINATION","change":{"kind":"set","value":"raw.host:1500"}}]), Value::Null);
    for engine in [NativeJobEngine::OceanbaseOracle, NativeJobEngine::Dameng] {
        assert!(native_job_scheduler_edit_plan(engine, &mutation, &data).is_err());
    }
}
