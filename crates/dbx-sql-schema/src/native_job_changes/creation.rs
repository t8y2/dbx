use super::*;

#[derive(Clone)]
pub struct NativeJobSchedulerSqlPlan {
    pub target: NativeJobRef,
    pub steps: Vec<NativeJobSqlStep>,
}

fn nonempty(value: &str) -> Result<(), &'static str> {
    if value.is_empty() || value.contains('\0') {
        Err("native_job_request_invalid")
    } else {
        Ok(())
    }
}

fn reference_name(
    engine: NativeJobCatalogDialect,
    reference: &NativeJobObjectReference,
) -> Result<String, &'static str> {
    nonempty(&reference.owner)?;
    nonempty(&reference.name)?;
    Ok(if engine == NativeJobCatalogDialect::OceanbaseOracle {
        reference.name.clone()
    } else {
        quoted_name(&reference.owner, &reference.name)
    })
}

/// Input-only validation precedes disabled creation. Extra attributes/arguments precede the optional
/// final ENABLE. None is a preview-only generation; apply supplies the identity read after CREATE.
pub fn native_job_scheduler_create_plan(
    engine: NativeJobCatalogDialect,
    scope: &NativeJobScope,
    definition: &NativeJobSchedulerCreate,
    identity: Option<&NativeJobRow>,
) -> Result<NativeJobSchedulerSqlPlan, &'static str> {
    let target = NativeJobRef::Scheduler {
        scope: scope.clone(),
        owner: definition.owner.clone(),
        name: definition.name.clone(),
    };
    target.validate()?;
    if engine == NativeJobCatalogDialect::OceanbaseOracle {
        if definition.schedule.is_some() {
            return Err("native_job_schedule_mapping_unverified");
        }
        if definition.credential_name.is_some() || definition.destination_name.is_some() {
            return Err("native_job_reference_not_supported");
        }
        if definition.job_type.as_deref().is_some_and(|kind| {
            !kind.eq_ignore_ascii_case("STORED_PROCEDURE") && !kind.eq_ignore_ascii_case("PLSQL_BLOCK")
        }) {
            return Err("native_job_type_not_supported");
        }
    }
    let package = scheduler_package(engine);
    let mut parameters = vec![format!("job_name => {}", text(&scheduler_name(engine, &target)?))];
    if let Some(program) = &definition.program {
        if definition.job_type.is_some() || definition.job_action.is_some() || definition.number_of_arguments != 0 {
            return Err("native_job_program_conflicts_with_inline_definition");
        }
        parameters.push(format!("program_name => {}", text(&reference_name(engine, program)?)));
    } else {
        let job_type = definition.job_type.as_deref().ok_or("native_job_type_required")?;
        let action = definition.job_action.as_deref().ok_or("native_job_action_required")?;
        nonempty(job_type)?;
        nonempty(action)?;
        if definition.number_of_arguments > 255
            || (job_type.eq_ignore_ascii_case("PLSQL_BLOCK") && definition.number_of_arguments != 0)
        {
            return Err("native_job_argument_count_invalid");
        }
        parameters.push(format!("job_type => {}", text(job_type)));
        parameters.push(format!("job_action => {}", text(action)));
        parameters.push(format!(
            "{} => {}",
            if engine == NativeJobCatalogDialect::OceanbaseOracle {
                "number_of_argument"
            } else {
                "number_of_arguments"
            },
            definition.number_of_arguments
        ));
    }
    if let Some(style) = &definition.job_style {
        if definition.program.is_none() {
            return Err("native_job_style_requires_program");
        }
        if definition.event_source.is_some() {
            return Err("native_job_style_not_applicable_to_event");
        }
        nonempty(style)?;
        parameters.push(format!("job_style => {}", text(style)));
    }
    if let Some(schedule) = &definition.schedule {
        if definition.start_date.is_some()
            || definition.end_date.is_some()
            || definition.repeat_interval.is_some()
            || definition.event_condition.is_some()
            || definition.event_source.is_some()
        {
            return Err("native_job_schedule_conflicts_with_inline_definition");
        }
        parameters.push(format!("schedule_name => {}", text(&reference_name(engine, schedule)?)));
    } else {
        if let Some(date) = &definition.start_date {
            parameters.push(format!("start_date => {}", create_timestamp(engine, date)?));
        }
        if let Some(date) = &definition.end_date {
            parameters.push(format!("end_date => {}", create_timestamp(engine, date)?));
        }
        if let Some(event) = &definition.event_source {
            if engine != NativeJobCatalogDialect::Oracle {
                return Err("native_job_event_mapping_unverified");
            }
            if definition.repeat_interval.is_some() {
                return Err("native_job_event_conflicts_with_calendar");
            }
            let queue = match event {
                NativeJobEventSource::Queue { owner, name, agent } => {
                    let mut queue =
                        reference_name(engine, &NativeJobObjectReference { owner: owner.clone(), name: name.clone() })?;
                    if let Some(agent) = agent {
                        nonempty(agent)?;
                        queue.push_str(&format!(",\"{}\"", agent.replace('"', "\"\"")));
                    }
                    queue
                }
                NativeJobEventSource::FileWatcher { reference } => reference_name(engine, reference)?,
            };
            parameters.push(format!("queue_spec => {}", text(&queue)));
            if let Some(condition) = &definition.event_condition {
                parameters.push(format!("event_condition => {}", text(condition)));
            } else if definition.program.is_some() {
                parameters.push("event_condition => NULL".into());
            }
            if definition.program.is_some() {
                if definition.start_date.is_none() {
                    parameters.push("start_date => NULL".into());
                }
                if definition.end_date.is_none() {
                    parameters.push("end_date => NULL".into());
                }
            }
        } else {
            if definition.event_condition.is_some() {
                return Err("native_job_event_queue_required");
            }
            if let Some(repeat) = &definition.repeat_interval {
                parameters.push(format!("repeat_interval => {}", text(repeat)));
            }
        }
    }
    for (key, value) in [
        ("job_class", &definition.job_class),
        ("comments", &definition.comments),
        ("credential_name", &definition.credential_name),
        ("destination_name", &definition.destination_name),
    ] {
        if let Some(value) = value {
            if value.contains('\0') {
                return Err("native_job_request_invalid");
            }
            parameters.push(format!("{key} => {}", text(value)));
        }
    }
    parameters.push("enabled => FALSE".into());
    parameters.push(format!("auto_drop => {}", bool_sql(definition.auto_drop)));
    let create = NativeJobSqlStep {
        id: "create".into(),
        label: "native_job_step_create_disabled".into(),
        sql: format!("BEGIN {package}.CREATE_JOB({}); END;", parameters.join(", ")),
        effect: NativeJobStepEffect::Created,
    };
    // Creation inputs each have one owner. Advanced settings cannot silently override a base field
    // or activate a job before all configuration has been verified.
    for attribute in &definition.attributes {
        if matches!(
            attribute.name.to_ascii_uppercase().as_str(),
            "JOB_TYPE"
                | "JOB_ACTION"
                | "NUMBER_OF_ARGUMENTS"
                | "PROGRAM_NAME"
                | "SCHEDULE_NAME"
                | "START_DATE"
                | "END_DATE"
                | "REPEAT_INTERVAL"
                | "AUTO_DROP"
                | "COMMENTS"
                | "JOB_CLASS"
                | "ENABLED"
                | "CREDENTIAL_NAME"
                | "DESTINATION_NAME"
        ) {
            return Err("native_job_duplicate_attribute");
        }
    }
    let mut configured = NativeJobSqlPlan {
        steps: Vec::new(),
        required_partitions: Vec::new(),
        compare_next_date: false,
        dameng_configuration: None,
    };
    scheduler_attribute_steps(engine, &target, identity, None, &definition.attributes, &mut configured)?;
    let mut positions = HashSet::new();
    for argument in &definition.arguments {
        if engine == NativeJobCatalogDialect::Oracle {
            crate::native_job_arguments::validate_lightweight_argument(
                definition.job_style.as_deref(),
                &argument.value,
            )?;
        }
        if argument.position == 0
            || !positions.insert(argument.position)
            || (definition.program.is_none() && argument.position > definition.number_of_arguments)
        {
            return Err("native_job_argument_position_invalid");
        }
        if matches!(argument.value, NativeJobArgumentValue::Unset | NativeJobArgumentValue::Inherit) {
            continue;
        }
        configured.steps.push(scheduler_argument_step(
            engine,
            &target,
            identity,
            &NativeJobArgumentChange { position: argument.position, value: argument.value.clone() },
            &argument.data_type,
        )?);
    }
    if definition.enabled {
        let name = text(&scheduler_name(engine, &target)?);
        configured.steps.push(NativeJobSqlStep {
            id: "enable".into(),
            label: "native_job_step_enable".into(),
            sql: wrap_scheduler(engine, &target, identity, &format!("{package}.ENABLE({name});"))?,
            effect: NativeJobStepEffect::Enabled(true),
        });
    }
    let mut steps = scheduler_argument_validation_steps(
        engine,
        definition.arguments.iter().map(|argument| (argument.position, &argument.value)),
    )?;
    steps.push(create);
    steps.extend(configured.steps);
    Ok(NativeJobSchedulerSqlPlan { target, steps })
}

fn create_timestamp(engine: NativeJobCatalogDialect, value: &str) -> Result<String, &'static str> {
    let timestamp = scheduler_timestamp(value)?;
    if engine == NativeJobCatalogDialect::OceanbaseOracle
        && value.split_once('.').is_some_and(|(_, fraction)| {
            fraction.bytes().take_while(u8::is_ascii_digit).skip(6).any(|digit| digit != b'0')
        })
    {
        return Err("native_job_timestamp_precision_microseconds");
    }
    Ok(if engine == NativeJobCatalogDialect::OceanbaseOracle {
        format!("CAST({timestamp} AT TIME ZONE SESSIONTIMEZONE AS TIMESTAMP(9))")
    } else {
        timestamp
    })
}
