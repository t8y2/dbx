use super::*;
use std::collections::BTreeMap;

#[derive(Clone)]
pub struct NativeJobSchedulerReferenceBinding {
    pub attribute: String,
    pub target: NativeJobSchedulerReferenceTarget,
}

#[derive(Clone)]
pub struct NativeJobSchedulerDefinitionEffect {
    pub columns: Vec<NativeJobAttributeChange>,
    pub references: Vec<NativeJobSchedulerReferenceBinding>,
}

#[derive(Clone)]
pub struct NativeJobSchedulerEditPlan {
    pub sql: NativeJobSqlPlan,
    pub transition: bool,
    pub context_changed: bool,
    pub references: Vec<NativeJobSchedulerReferenceBinding>,
    pub definition: NativeJobRow,
    pub argument_target: Option<NativeJobArgumentTarget>,
    pub final_enabled: bool,
    pub event_changed: bool,
}

fn enabled(value: Option<&Value>) -> Option<bool> {
    match value? {
        Value::Bool(value) => Some(*value),
        Value::String(value) if value.eq_ignore_ascii_case("true") || value == "1" => Some(true),
        Value::String(value) if value.eq_ignore_ascii_case("false") || value == "0" => Some(false),
        Value::Number(value) if value.as_i64() == Some(1) => Some(true),
        Value::Number(value) if value.as_i64() == Some(0) => Some(false),
        _ => None,
    }
}

fn native_reference(
    row: &NativeJobRow,
    slot: &str,
    owner: &str,
    job_type: &str,
) -> Result<Option<NativeJobSchedulerReferenceTarget>, &'static str> {
    if slot == "JOB_ACTION" {
        return native_job_scheduler_reference_target(slot, row.get(slot).unwrap_or(&Value::Null), owner, job_type);
    }
    let (owner_column, name_column) = match slot {
        "PROGRAM_NAME" => ("PROGRAM_OWNER", "PROGRAM_NAME"),
        "SCHEDULE_NAME" => ("SCHEDULE_OWNER", "SCHEDULE_NAME"),
        "CREDENTIAL_NAME" => ("CREDENTIAL_OWNER", "CREDENTIAL_NAME"),
        "CONNECT_CREDENTIAL_NAME" => ("CONNECT_CREDENTIAL_OWNER", "CONNECT_CREDENTIAL_NAME"),
        "DESTINATION_NAME" => ("DESTINATION_OWNER", "DESTINATION"),
        _ => return Ok(None),
    };
    let Some(name) = row.get(name_column).filter(|value| !value.is_null()) else { return Ok(None) };
    let name = name.as_str().filter(|name| !name.is_empty()).ok_or("native_job_reference_identity_unavailable")?;
    let owner = row
        .get(owner_column)
        .and_then(Value::as_str)
        .filter(|owner| !owner.is_empty())
        .ok_or("native_job_reference_identity_unavailable")?;
    let kind = match (slot, row.get("SCHEDULE_TYPE").and_then(Value::as_str)) {
        ("SCHEDULE_NAME", Some("WINDOW")) => Some("window"),
        ("SCHEDULE_NAME", Some("WINDOW_GROUP")) => Some("window-group"),
        _ => None,
    };
    let mut value = serde_json::json!({"owner":owner,"name":name});
    if let Some(kind) = kind {
        value["kind"] = Value::String(kind.into());
    }
    native_job_scheduler_reference_target(slot, &value, owner, job_type)
}

fn changed(name: &str, value: Value) -> NativeJobAttributeChange {
    NativeJobAttributeChange {
        name: name.into(),
        change: if value.is_null() { NativeJobFieldChange::Clear } else { NativeJobFieldChange::Set { value } },
    }
}

fn patch_value(change: &NativeJobFieldChange) -> Value {
    match change {
        NativeJobFieldChange::Set { value } => value.clone(),
        _ => Value::Null,
    }
}

fn inline_schedule_kind(before: &NativeJobRow, patches: &BTreeMap<String, NativeJobFieldChange>) -> &'static str {
    let value =
        |name: &str| patches.get(name).map(patch_value).or_else(|| before.get(name).cloned()).unwrap_or(Value::Null);
    if !value("EVENT_SPEC").is_null() {
        return "EVENT";
    }
    if !patches.contains_key("EVENT_SPEC")
        && before.get("SCHEDULE_TYPE").and_then(Value::as_str) == Some("EVENT")
        && !patches.get("REPEAT_INTERVAL").is_some_and(|change| !patch_value(change).is_null())
    {
        return "EVENT";
    }
    if let Some(repeat) = value("REPEAT_INTERVAL").as_str() {
        if !repeat.is_empty() {
            return if repeat.trim_start().to_ascii_uppercase().starts_with("FREQ") { "CALENDAR" } else { "PLSQL" };
        }
    }
    if value("START_DATE").is_null() {
        "IMMEDIATE"
    } else {
        "ONCE"
    }
}

fn project_reference(slot: &str, target: Option<&NativeJobSchedulerReferenceTarget>) -> Vec<NativeJobAttributeChange> {
    let (owner_column, name_column) = match slot {
        "PROGRAM_NAME" => ("PROGRAM_OWNER", "PROGRAM_NAME"),
        "SCHEDULE_NAME" => ("SCHEDULE_OWNER", "SCHEDULE_NAME"),
        "CREDENTIAL_NAME" => ("CREDENTIAL_OWNER", "CREDENTIAL_NAME"),
        "CONNECT_CREDENTIAL_NAME" => ("CONNECT_CREDENTIAL_OWNER", "CONNECT_CREDENTIAL_NAME"),
        "DESTINATION_NAME" => ("DESTINATION_OWNER", "DESTINATION"),
        _ => return Vec::new(),
    };
    vec![
        changed(owner_column, target.map_or(Value::Null, |target| Value::String(target.reference.owner.clone()))),
        changed(name_column, target.map_or(Value::Null, |target| Value::String(target.reference.name.clone()))),
    ]
}

/// Compile definitions and conditional argument candidates, not a second execution language.
/// Core binds the referenced metadata and decides which already-previewed SET/RESETs are needed.
pub fn native_job_scheduler_edit_plan(
    engine: NativeJobCatalogDialect,
    request: &NativeJobMutation,
    details: &NativeJobDetails,
) -> Result<NativeJobSchedulerEditPlan, &'static str> {
    let NativeJobRef::Scheduler { owner, .. } = &request.target else { return Err("native_job_not_scheduler") };
    request.target.validate()?;
    if details.snapshot.job_ref != request.target {
        return Err("native_job_identity_mismatch");
    }
    let NativeJobChange::Update { attributes, arguments, argument_target, final_enabled } = &request.change else {
        return Err("native_job_action_not_applicable");
    };
    if argument_target.is_some() && !arguments.is_empty() {
        return Err("native_job_argument_contract_conflict");
    }
    let before = definition(details)?;
    if engine == NativeJobCatalogDialect::Oracle {
        let style = before.get("JOB_STYLE").and_then(Value::as_str);
        for value in arguments
            .iter()
            .map(|argument| &argument.value)
            .chain(argument_target.iter().flat_map(|target| target.arguments.iter().map(|argument| &argument.value)))
        {
            crate::native_job_arguments::validate_lightweight_argument(style, value)?;
        }
    }
    let mut patches = BTreeMap::new();
    for attribute in attributes.iter().filter(|attribute| attribute.change != NativeJobFieldChange::Keep) {
        let key = attribute.name.to_ascii_uppercase();
        if patches.insert(key, attribute.change.clone()).is_some() {
            return Err("native_job_duplicate_attribute");
        }
    }
    if patches.contains_key("DESTINATION") && patches.contains_key("DESTINATION_NAME") {
        return Err("native_job_destination_contract_conflict");
    }
    let old_type = before.get("JOB_TYPE").and_then(Value::as_str).unwrap_or("");
    let job_type = patches
        .get("JOB_TYPE")
        .and_then(|change| match change {
            NativeJobFieldChange::Set { value } => value.as_str(),
            _ => None,
        })
        .unwrap_or(old_type)
        .to_ascii_uppercase();
    let mut normalized = Vec::new();
    let mut references = Vec::new();
    let mut reference_projections = BTreeMap::new();
    let mut reference_changed = false;
    let mut program_changed = false;
    for (slot, change) in &patches {
        if slot == "DESTINATION" {
            if engine != NativeJobCatalogDialect::Oracle {
                return Err("native_job_attribute_not_editable");
            }
            let value = patch_value(change);
            if !before.contains_key("DESTINATION") || !before.contains_key("DESTINATION_OWNER") {
                return Err("native_job_metadata_incomplete");
            }
            if before.get("DESTINATION_OWNER") == Some(&Value::Null) && before.get("DESTINATION") == Some(&value) {
                continue;
            }
            reference_changed = true;
            normalized.push(changed(slot, value.clone()));
            reference_projections
                .insert(slot.clone(), vec![changed("DESTINATION_OWNER", Value::Null), changed("DESTINATION", value)]);
            continue;
        }
        let reference_slot = matches!(
            slot.as_str(),
            "PROGRAM_NAME" | "SCHEDULE_NAME" | "CREDENTIAL_NAME" | "CONNECT_CREDENTIAL_NAME" | "DESTINATION_NAME"
        ) || (slot == "JOB_ACTION" && job_type == "CHAIN");
        if !reference_slot {
            normalized.push(NativeJobAttributeChange { name: slot.clone(), change: change.clone() });
            continue;
        }
        let target = native_job_scheduler_reference_target(slot, &patch_value(change), owner, &job_type)?;
        let old_host = slot == "DESTINATION_NAME"
            && before.get("DESTINATION_OWNER") == Some(&Value::Null)
            && before.get("DESTINATION").is_some_and(|value| !value.is_null());
        let previous = if old_host { None } else { native_reference(before, slot, owner, old_type)? };
        if previous == target && !old_host {
            continue;
        }
        if engine == NativeJobCatalogDialect::Dameng && matches!(slot.as_str(), "PROGRAM_NAME" | "SCHEDULE_NAME") {
            if previous.is_none() {
                return Err("native_job_reference_attach_mapping_unverified");
            }
            if target.is_none() {
                return Err("native_job_reference_detach_mapping_unverified");
            }
        }
        if old_host && target.is_none() {
            return Err("native_job_legacy_destination_clear_mapping_unverified");
        }
        reference_changed = true;
        program_changed |= slot == "PROGRAM_NAME";
        let native_value = target
            .as_ref()
            .map_or(Value::Null, |target| Value::String(quoted_name(&target.reference.owner, &target.reference.name)));
        normalized.push(changed(slot, native_value));
        let mut projections = project_reference(slot, target.as_ref());
        if slot == "JOB_ACTION" {
            projections.push(changed(
                "JOB_ACTION",
                target.as_ref().map_or(Value::Null, |target| {
                    Value::String(quoted_name(&target.reference.owner, &target.reference.name))
                }),
            ));
        }
        if slot == "SCHEDULE_NAME" && engine != NativeJobCatalogDialect::Dameng {
            projections.push(changed(
                "SCHEDULE_TYPE",
                Value::String(
                    match target.as_ref().map(|target| target.kind) {
                        Some(NativeJobReferenceKind::Window) => "WINDOW",
                        Some(NativeJobReferenceKind::WindowGroup) => "WINDOW_GROUP",
                        Some(_) => "NAMED",
                        None => inline_schedule_kind(before, &patches),
                    }
                    .into(),
                ),
            ));
        }
        if let Some(target) = target {
            references.push(NativeJobSchedulerReferenceBinding { attribute: slot.clone(), target });
        }
        reference_projections.insert(slot.clone(), projections);
    }
    let context_changed = program_changed
        || patches.get("JOB_TYPE").is_some_and(|change| {
            !patch_value(change).as_str().is_some_and(|value| value.eq_ignore_ascii_case(old_type))
        })
        || patches.get("NUMBER_OF_ARGUMENTS").is_some_and(|change| {
            let previous = before
                .get("NUMBER_OF_ARGUMENTS")
                .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()));
            previous.is_none() || previous != patch_value(change).as_u64()
        });
    if engine == NativeJobCatalogDialect::OceanbaseOracle
        && (reference_changed || context_changed || patches.contains_key("EVENT_SPEC"))
    {
        return Err("native_job_attribute_not_editable");
    }
    if context_changed && argument_target.is_none() {
        return Err("native_job_argument_target_required");
    }
    let inline_schedule_changed =
        ["START_DATE", "END_DATE", "REPEAT_INTERVAL"].iter().any(|key| patches.contains_key(*key));
    let transition = reference_changed
        || context_changed
        || argument_target.is_some()
        || patches.contains_key("EVENT_SPEC")
        || (engine == NativeJobCatalogDialect::Oracle && inline_schedule_changed);
    if !transition {
        let ordinary = NativeJobMutation {
            target: request.target.clone(),
            baseline: request.baseline.clone(),
            change: NativeJobChange::Update {
                final_enabled: None,
                argument_target: None,
                attributes: normalized,
                arguments: arguments.clone(),
            },
        };
        let mut sql = match native_job_mutation_plan(engine, &ordinary, details) {
            Ok(sql) => sql,
            Err("native_job_no_changes") if final_enabled.is_some() => NativeJobSqlPlan {
                steps: Vec::new(),
                required_partitions: vec!["definition".into()],
                compare_next_date: false,
                dameng_configuration: None,
            },
            Err(reason) => return Err(reason),
        };
        let mut definition = before.clone();
        if let Some(enabled) = final_enabled {
            for step in &mut sql.steps {
                if let NativeJobStepEffect::Fields(changes) = &step.effect {
                    for change in changes {
                        definition.insert(change.name.clone(), patch_value(&change.change));
                    }
                    step.effect = NativeJobStepEffect::SchedulerDefinition(NativeJobSchedulerDefinitionEffect {
                        columns: changes.clone(),
                        references: Vec::new(),
                    });
                }
            }
            activation_steps(engine, &request.target, details, &mut sql, *enabled)?;
        }
        return Ok(NativeJobSchedulerEditPlan {
            sql,
            transition: final_enabled.is_some(),
            context_changed: false,
            references: Vec::new(),
            definition,
            argument_target: None,
            final_enabled: final_enabled.unwrap_or(false),
            event_changed: false,
        });
    }
    let final_program = if let Some(change) = patches.get("PROGRAM_NAME") {
        native_job_scheduler_reference_target("PROGRAM_NAME", &patch_value(change), owner, &job_type)?
    } else if context_changed || argument_target.is_some() {
        native_reference(before, "PROGRAM_NAME", owner, old_type)?
    } else {
        None
    };
    let has_program = if program_changed {
        final_program.is_some()
    } else {
        before.get("PROGRAM_NAME").and_then(Value::as_str).is_some_and(|name| !name.is_empty())
    };
    if has_program
        && !program_changed
        && ["JOB_TYPE", "JOB_ACTION", "NUMBER_OF_ARGUMENTS"].iter().any(|key| patches.contains_key(*key))
    {
        return Err("native_job_program_conflicts_with_inline_definition");
    }
    if engine == NativeJobCatalogDialect::Dameng && program_changed && final_program.is_none() {
        return Err("native_job_reference_detach_mapping_unverified");
    }
    if let Some(target) = argument_target {
        if target.program != final_program.as_ref().map(|target| target.reference.clone()) {
            return Err("native_job_argument_target_mismatch");
        }
        if let Some(program) = &final_program {
            if !references.iter().any(|reference| reference.attribute == "PROGRAM_NAME") {
                references.push(NativeJobSchedulerReferenceBinding {
                    attribute: "PROGRAM_NAME".into(),
                    target: program.clone(),
                });
            }
        }
    }
    let final_enabled =
        final_enabled.or_else(|| enabled(before.get("ENABLED"))).ok_or("native_job_enabled_state_unavailable")?;
    let event_changed = reference_projections.contains_key("SCHEDULE_NAME")
        || patches.contains_key("EVENT_SPEC")
        || inline_schedule_changed;
    let mut force = |key: &str, value: Value| {
        normalized.retain(|attribute| attribute.name != key);
        normalized.push(changed(key, value));
    };
    if program_changed {
        if final_program.is_some() {
            if engine == NativeJobCatalogDialect::Oracle {
                for key in ["JOB_TYPE", "JOB_ACTION", "NUMBER_OF_ARGUMENTS"] {
                    force(key, Value::Null);
                }
            }
        } else {
            for key in ["JOB_TYPE", "JOB_ACTION", "NUMBER_OF_ARGUMENTS"] {
                if !patches
                    .get(key)
                    .is_some_and(|change| matches!(change, NativeJobFieldChange::Set { value } if !value.is_null()))
                {
                    return Err("native_job_inline_definition_required");
                }
            }
        }
    }
    if engine != NativeJobCatalogDialect::Dameng
        && patches.contains_key("SCHEDULE_NAME")
        && reference_projections.contains_key("SCHEDULE_NAME")
    {
        let named = references.iter().any(|reference| reference.attribute == "SCHEDULE_NAME");
        if named {
            for key in ["START_DATE", "END_DATE", "REPEAT_INTERVAL", "EVENT_SPEC"] {
                force(key, Value::Null);
            }
        } else if !patches.contains_key("EVENT_SPEC") {
            force("EVENT_SPEC", Value::Null);
        }
    }
    if patches.get("EVENT_SPEC").is_some_and(|change| !patch_value(change).is_null()) {
        if engine != NativeJobCatalogDialect::Oracle {
            return Err("native_job_event_mapping_unverified");
        }
        if final_program.is_some() && patches.contains_key("JOB_TYPE") {
            return Err("native_job_program_conflicts_with_inline_definition");
        }
        force("REPEAT_INTERVAL", Value::Null);
        if !reference_projections.contains_key("SCHEDULE_NAME") {
            force("SCHEDULE_NAME", Value::Null);
            let mut columns = project_reference("SCHEDULE_NAME", None);
            columns.push(changed("SCHEDULE_TYPE", Value::String("EVENT".into())));
            reference_projections.insert("SCHEDULE_NAME".into(), columns);
        }
    }
    if engine == NativeJobCatalogDialect::Oracle
        && patches.get("REPEAT_INTERVAL").is_some_and(|change| !patch_value(change).is_null())
        && before.get("SCHEDULE_TYPE").and_then(Value::as_str) == Some("EVENT")
        && !patches.contains_key("EVENT_SPEC")
    {
        force("EVENT_SPEC", Value::Null);
    }
    let final_schedule_named = if let Some(change) = patches.get("SCHEDULE_NAME") {
        !patch_value(change).is_null()
    } else {
        before.get("SCHEDULE_NAME").is_some_and(|value| !value.is_null())
    };
    if inline_schedule_changed && final_schedule_named && !reference_projections.contains_key("SCHEDULE_NAME") {
        return Err("native_job_schedule_conflicts_with_inline_definition");
    }
    let mut definition = before.clone();
    let mut columns_by_attribute = BTreeMap::new();
    let mut ordinary_attributes = Vec::new();
    let mut event = None;
    for attribute in normalized {
        let mut columns = reference_projections.remove(&attribute.name).unwrap_or_else(|| vec![attribute.clone()]);
        if attribute.name == "EVENT_SPEC" {
            let value = patch_value(&attribute.change);
            let mut columns = [
                "EVENT_CONDITION",
                "EVENT_QUEUE_OWNER",
                "EVENT_QUEUE_NAME",
                "EVENT_QUEUE_AGENT",
                "FILE_WATCHER_OWNER",
                "FILE_WATCHER_NAME",
            ]
            .into_iter()
            .map(|key| changed(key, Value::Null))
            .collect::<Vec<_>>();
            let (condition, queue) = if value.is_null() {
                (Value::Null, Value::Null)
            } else {
                let source: NativeJobEventSource =
                    serde_json::from_value(value.get("source").cloned().ok_or("native_job_event_queue_required")?)
                        .map_err(|_| "native_job_event_queue_required")?;
                let condition = value.get("condition").cloned().unwrap_or(Value::Null);
                if !condition.is_null() && !condition.is_string() {
                    return Err("native_job_attribute_type_invalid");
                }
                columns[0] = changed("EVENT_CONDITION", condition.clone());
                let queue = match source {
                    NativeJobEventSource::Queue { owner, name, agent } => {
                        if owner.is_empty()
                            || name.is_empty()
                            || owner.contains('\0')
                            || name.contains('\0')
                            || agent.as_ref().is_some_and(|agent| agent.is_empty() || agent.contains('\0'))
                        {
                            return Err("native_job_reference_input_invalid");
                        }
                        columns[1] = changed("EVENT_QUEUE_OWNER", Value::String(owner.clone()));
                        columns[2] = changed("EVENT_QUEUE_NAME", Value::String(name.clone()));
                        columns[3] = changed("EVENT_QUEUE_AGENT", agent.clone().map_or(Value::Null, Value::String));
                        let mut queue = quoted_name(&owner, &name);
                        if let Some(agent) = agent {
                            queue.push_str(&format!(",\"{}\"", agent.replace('"', "\"\"")));
                        }
                        queue
                    }
                    NativeJobEventSource::FileWatcher { reference } => {
                        if reference.owner.is_empty()
                            || reference.name.is_empty()
                            || reference.owner.contains('\0')
                            || reference.name.contains('\0')
                        {
                            return Err("native_job_reference_input_invalid");
                        }
                        columns[4] = changed("FILE_WATCHER_OWNER", Value::String(reference.owner.clone()));
                        columns[5] = changed("FILE_WATCHER_NAME", Value::String(reference.name.clone()));
                        let queue = quoted_name(&reference.owner, &reference.name);
                        references.push(NativeJobSchedulerReferenceBinding {
                            attribute: "EVENT_SPEC".into(),
                            target: NativeJobSchedulerReferenceTarget {
                                kind: NativeJobReferenceKind::FileWatcher,
                                reference,
                            },
                        });
                        queue
                    }
                };
                (condition, Value::String(queue))
            };
            for column in &columns {
                definition.insert(column.name.clone(), patch_value(&column.change));
            }
            if !final_schedule_named {
                let kind = if value.is_null() { inline_schedule_kind(before, &patches) } else { "EVENT" };
                definition.insert("SCHEDULE_TYPE".into(), Value::String(kind.into()));
                columns.push(changed("SCHEDULE_TYPE", Value::String(kind.into())));
            }
            event = Some((condition, queue, columns));
            continue;
        }
        if engine == NativeJobCatalogDialect::Oracle
            && inline_schedule_changed
            && !final_schedule_named
            && matches!(attribute.name.as_str(), "START_DATE" | "END_DATE" | "REPEAT_INTERVAL")
        {
            columns.push(changed("SCHEDULE_TYPE", Value::String(inline_schedule_kind(before, &patches).into())));
        }
        for column in &columns {
            definition.insert(column.name.clone(), patch_value(&column.change));
        }
        columns_by_attribute.insert(attribute.name.clone(), columns);
        ordinary_attributes.push(attribute);
    }
    if !has_program && (context_changed || argument_target.is_some()) {
        let count = definition
            .get("NUMBER_OF_ARGUMENTS")
            .and_then(Value::as_u64)
            .filter(|count| *count <= 255)
            .ok_or("native_job_argument_count_invalid")?;
        if matches!(job_type.as_str(), "PLSQL_BLOCK" | "CHAIN") && count != 0 {
            return Err("native_job_argument_count_invalid");
        }
        if let Some(target) = argument_target {
            if target.arguments.len() != count as usize {
                return Err("native_job_argument_target_incomplete");
            }
        }
    }
    let identity = match &details.native_identity {
        NativeJobMetadata::Available { value } => Some(value),
        _ => return Err("native_job_identity_unverified"),
    };
    let mut sql = NativeJobSqlPlan {
        steps: Vec::new(),
        required_partitions: vec!["definition".into()],
        compare_next_date: false,
        dameng_configuration: None,
    };
    // No caller-supplied SQL and no broad field exemption: each native projection is explicit.
    scheduler_attribute_steps(engine, &request.target, identity, None, &ordinary_attributes, &mut sql)?;
    for step in &mut sql.steps {
        let NativeJobStepEffect::Fields(changes) = &step.effect else { continue };
        let columns = changes
            .iter()
            .flat_map(|change| columns_by_attribute.get(&change.name).cloned().unwrap_or_default())
            .collect();
        let changed_slots: HashSet<_> = changes.iter().map(|change| change.name.as_str()).collect();
        step.effect = NativeJobStepEffect::SchedulerDefinition(NativeJobSchedulerDefinitionEffect {
            columns,
            references: references
                .iter()
                .filter(|reference| changed_slots.contains(reference.attribute.as_str()))
                .cloned()
                .collect(),
        });
    }
    if let Some((condition, queue, columns)) = event {
        let value = |value: &Value| value.as_str().map(text).unwrap_or_else(|| "CAST(NULL AS VARCHAR2(4000))".into());
        let name = text(&scheduler_name(engine, &request.target)?);
        let constructor = if condition.is_null() && queue.is_null() {
            format!("SYS.JOBATTR({name}, 'event_spec')")
        } else {
            format!("SYS.JOBATTR({name}, 'event_spec', {}, {})", value(&condition), value(&queue))
        };
        if let Some(step) = sql.steps.iter_mut().find(|step| step.id == "attributes") {
            step.sql = step.sql.replacen("SYS.JOBATTR_ARRAY(", &format!("SYS.JOBATTR_ARRAY({constructor}, "), 1);
            let NativeJobStepEffect::SchedulerDefinition(effect) = &mut step.effect else { unreachable!() };
            effect.columns.extend(columns);
        } else {
            sql.steps.insert(0, NativeJobSqlStep { id: "attributes".into(), label: "native_job_step_attributes".into(), sql: format!("BEGIN SYS.DBMS_SCHEDULER.SET_JOB_ATTRIBUTES(SYS.JOBATTR_ARRAY({constructor}), 'TRANSACTIONAL'); END;"), effect: NativeJobStepEffect::SchedulerDefinition(NativeJobSchedulerDefinitionEffect { columns, references: Vec::new() }) });
        }
    }
    activation_steps(engine, &request.target, details, &mut sql, false)?;
    if let Some(target) = argument_target {
        sql.required_partitions.push("argument-inventory".into());
        let mut positions = HashSet::new();
        for argument in &target.arguments {
            if argument.position == 0
                || !positions.insert(argument.position)
                || argument.position > target.arguments.len()
            {
                return Err("native_job_argument_target_incomplete");
            }
            if engine == NativeJobCatalogDialect::Dameng
                && matches!(argument.value, NativeJobArgumentValue::Unset | NativeJobArgumentValue::Inherit)
            {
                if !program_changed {
                    let inventory = match &details.parameter_metadata {
                        NativeJobMetadata::Available { value } => value.as_slice(),
                        NativeJobMetadata::Empty => &[],
                        _ => return Err("native_job_arguments_unavailable"),
                    };
                    for row in inventory {
                        let position = row
                            .get("ARGUMENT_POSITION")
                            .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
                            .filter(|position| *position > 0)
                            .ok_or("native_job_arguments_invalid")?;
                        if position == argument.position as u64 {
                            return Err("native_job_argument_reset_mapping_unverified");
                        }
                    }
                }
                continue;
            }
            sql.steps.push(scheduler_argument_step(
                engine,
                &request.target,
                identity,
                &NativeJobArgumentChange { position: argument.position, value: argument.value.clone() },
                &argument.data_type,
            )?);
        }
    } else {
        // Reference-only changes retain the original delta semantics for unchanged argument contexts.
        let mut delta = NativeJobSqlPlan {
            steps: Vec::new(),
            required_partitions: Vec::new(),
            compare_next_date: false,
            dameng_configuration: None,
        };
        scheduler_changes(engine, request, details, &[], arguments, &mut delta)?;
        sql.steps.extend(delta.steps);
        sql.required_partitions.extend(delta.required_partitions);
    }
    if final_enabled {
        let name = text(&scheduler_name(engine, &request.target)?);
        let package = scheduler_package(engine);
        sql.steps.push(NativeJobSqlStep {
            id: "enable".into(),
            label: "native_job_step_enable".into(),
            sql: wrap_scheduler(engine, &request.target, identity, &format!("{package}.ENABLE({name});"))?,
            effect: NativeJobStepEffect::Enabled(true),
        });
    }
    let validations = if let Some(target) = argument_target {
        scheduler_argument_validation_steps(
            engine,
            target.arguments.iter().map(|argument| (argument.position, &argument.value)),
        )?
    } else {
        scheduler_argument_validation_steps(
            engine,
            arguments.iter().map(|argument| (argument.position, &argument.value)),
        )?
    };
    sql.steps.splice(0..0, validations);
    Ok(NativeJobSchedulerEditPlan {
        sql,
        transition,
        context_changed,
        references,
        definition,
        argument_target: argument_target.clone(),
        final_enabled,
        event_changed,
    })
}

fn activation_steps(
    engine: NativeJobCatalogDialect,
    target: &NativeJobRef,
    details: &NativeJobDetails,
    sql: &mut NativeJobSqlPlan,
    final_enabled: bool,
) -> Result<(), &'static str> {
    let name = text(&scheduler_name(engine, target)?);
    let package = scheduler_package(engine);
    sql.steps.insert(
        0,
        NativeJobSqlStep {
            id: "pause".into(),
            label: "native_job_step_disable".into(),
            sql: wrap(engine, target, details, &format!("{package}.DISABLE({name});"))?,
            effect: NativeJobStepEffect::Enabled(false),
        },
    );
    if final_enabled {
        sql.steps.push(NativeJobSqlStep {
            id: "enable".into(),
            label: "native_job_step_enable".into(),
            sql: wrap(engine, target, details, &format!("{package}.ENABLE({name});"))?,
            effect: NativeJobStepEffect::Enabled(true),
        });
    }
    Ok(())
}
