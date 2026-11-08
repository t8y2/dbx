use crate::native_jobs::NativeJobCatalogDialect;
use dbx_sql_core::value_literals::quote_string_literal;
use dbx_types::native_jobs::*;
use serde_json::Value;
use std::collections::HashSet;

mod creation;
mod dameng;
mod references;
mod transitions;
pub use creation::{native_job_scheduler_create_plan, NativeJobSchedulerSqlPlan};
pub use dameng::{
    native_job_dameng_catalog_id, native_job_dameng_child_id, native_job_dameng_child_key,
    native_job_dameng_civil_time, native_job_dameng_create_plan, native_job_dameng_date_query,
    native_job_dameng_identity_queries, native_job_dameng_legacy_time, native_job_dameng_name_queries,
    native_job_dameng_what_query, resolve_native_job_dameng_child_step, NativeJobDamengChildAction,
    NativeJobDamengChildEffect, NativeJobDamengChildReference, NativeJobDamengConfigPlan, NativeJobDamengCreatePlan,
    NativeJobDamengOperator, NativeJobDamengOperatorSelector, NativeJobDamengPart,
};
pub use references::{native_job_scheduler_reference_target, NativeJobSchedulerReferenceTarget};
pub use transitions::{
    native_job_scheduler_edit_plan, NativeJobSchedulerDefinitionEffect, NativeJobSchedulerEditPlan,
    NativeJobSchedulerReferenceBinding,
};

#[derive(Clone)]
pub enum NativeJobStepEffect {
    Created,
    Fields(Vec<NativeJobAttributeChange>),
    SchedulerDefinition(NativeJobSchedulerDefinitionEffect),
    DamengDefinition(Vec<NativeJobAttributeChange>),
    DamengLegacyInterval { expected_seconds: Option<String> },
    DamengLegacyWhat { expected: String },
    DamengLegacyNextDate { expected: String },
    DamengRenamed { old_name: String, new_name: String },
    DamengConfigurationStarted,
    DamengConfigurationCommitted,
    DamengChild(NativeJobDamengChildEffect),
    Argument(NativeJobArgumentChange, Option<crate::native_job_arguments::ArgumentExpectation>),
    Enabled(bool),
    Deleted,
    Accepted,
    Completed,
    ArgumentValidated,
    HistoryCleared,
}

// Plans contain reviewed SQL bodies and parameter values, not diagnostic material.
#[derive(Clone)]
pub struct NativeJobSqlStep {
    pub id: String,
    pub label: String,
    pub sql: String,
    pub effect: NativeJobStepEffect,
}

#[derive(Clone)]
pub struct NativeJobSqlPlan {
    pub steps: Vec<NativeJobSqlStep>,
    pub required_partitions: Vec<String>,
    pub compare_next_date: bool,
    pub dameng_configuration: Option<NativeJobDamengConfigPlan>,
}

fn text(value: &str) -> String {
    // PL/SQL accepts concatenated literals; do not cut a UTF-8 character or silently truncate a body.
    let mut chunks = Vec::new();
    let mut start = 0;
    for (index, _) in value.char_indices() {
        if index - start >= 2_000 {
            chunks.push(quote_string_literal(&value[start..index]));
            start = index;
        }
    }
    chunks.push(quote_string_literal(&value[start..]));
    chunks.join(" || ")
}

fn quoted_name(owner: &str, name: &str) -> String {
    format!("\"{}\".\"{}\"", owner.replace('"', "\"\""), name.replace('"', "\"\""))
}

fn definition(details: &NativeJobDetails) -> Result<&NativeJobRow, &'static str> {
    match &details.snapshot.definition {
        NativeJobMetadata::Available { value } => Ok(value),
        _ => Err("native_job_definition_unavailable"),
    }
}

fn string_field<'a>(row: &'a NativeJobRow, name: &str) -> Result<&'a str, &'static str> {
    row.get(name).and_then(Value::as_str).ok_or("native_job_metadata_incomplete")
}

fn target_name(
    engine: NativeJobCatalogDialect,
    target: &NativeJobRef,
    details: &NativeJobDetails,
) -> Result<String, &'static str> {
    Ok(match target {
        NativeJobRef::Scheduler { owner, name, .. } if engine != NativeJobCatalogDialect::OceanbaseOracle => {
            quoted_name(owner, name)
        }
        NativeJobRef::Scheduler { name, .. } | NativeJobRef::DamengNative { name, .. } => name.clone(),
        NativeJobRef::Legacy { .. } if engine == NativeJobCatalogDialect::Dameng => {
            string_field(definition(details)?, "NAME")?.into()
        }
        _ => return Err("native_job_kind_invalid"),
    })
}

fn wrap(
    engine: NativeJobCatalogDialect,
    target: &NativeJobRef,
    details: &NativeJobDetails,
    calls: &str,
) -> Result<String, &'static str> {
    if matches!(target, NativeJobRef::Scheduler { .. }) {
        let identity = match &details.native_identity {
            NativeJobMetadata::Available { value } => Some(value),
            _ if engine == NativeJobCatalogDialect::OceanbaseOracle => {
                return Err("native_job_identity_unverified");
            }
            _ => None,
        };
        return wrap_scheduler(engine, target, identity, calls);
    }
    if engine == NativeJobCatalogDialect::Dameng {
        return dameng::guarded_call(target, details, calls);
    }
    Ok(format!("BEGIN {calls} END;"))
}

fn scheduler_name(engine: NativeJobCatalogDialect, target: &NativeJobRef) -> Result<String, &'static str> {
    let NativeJobRef::Scheduler { owner, name, .. } = target else { return Err("native_job_kind_invalid") };
    Ok(if engine == NativeJobCatalogDialect::OceanbaseOracle { name.clone() } else { quoted_name(owner, name) })
}

// A missing identity is used only for a new job's preview. Apply regenerates the guard from the
// observed identity; it never substitutes text inside user bodies or accepts client-provided SQL.
fn wrap_scheduler(
    engine: NativeJobCatalogDialect,
    target: &NativeJobRef,
    identity: Option<&NativeJobRow>,
    calls: &str,
) -> Result<String, &'static str> {
    if let NativeJobRef::Scheduler { owner, name, .. } = target {
        if engine == NativeJobCatalogDialect::OceanbaseOracle {
            let id = if let Some(identity) = identity {
                let id = string_field(identity, "DBX_JOB_ID")?;
                if id.starts_with('0') || id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) {
                    return Err("native_job_identity_unverified");
                }
                id
            } else {
                ":dbx_created_job_id"
            };
            return Ok(format!("DECLARE n INTEGER; expected INTEGER; BEGIN SELECT COUNT(DISTINCT JOB), COUNT(DISTINCT CASE WHEN POWNER = {} AND JOB = {id} THEN JOB END) INTO n, expected FROM SYS.ALL_VIRTUAL_TENANT_SCHEDULER_JOB_REAL_AGENT WHERE JOB_NAME = {} AND JOB > 0; IF n <> 1 OR expected <> 1 THEN RAISE_APPLICATION_ERROR(-20001, 'DBX_JOB_TARGET_CHANGED'); END IF; {calls} END;", text(owner), text(name)));
        }
    }
    Ok(format!("BEGIN {calls} END;"))
}

fn bool_sql(value: bool) -> &'static str {
    if value {
        "TRUE"
    } else {
        "FALSE"
    }
}

pub fn native_job_legacy_create_preview(
    engine: NativeJobCatalogDialect,
    definition: &NativeJobLegacyCreate,
) -> Result<Vec<NativeJobStepPreview>, &'static str> {
    if !matches!(engine, NativeJobCatalogDialect::Oracle | NativeJobCatalogDialect::OceanbaseOracle) {
        return Err("native_job_legacy_protocol_unavailable");
    }
    if definition.what.trim().is_empty()
        || definition.what.contains('\0')
        || definition.interval.contains('\0')
        || definition.schema.contains('\0')
        || match engine {
            NativeJobCatalogDialect::Oracle => {
                !(0..=i64::from(i32::MAX)).contains(&definition.instance) || definition.zone.is_some()
            }
            NativeJobCatalogDialect::OceanbaseOracle => {
                definition.instance != 0
                    || definition.zone.as_ref().is_some_and(|zone| zone.is_empty() || zone.contains('\0'))
            }
            _ => unreachable!(),
        }
    {
        return Err("native_job_request_invalid");
    }
    let schema = if definition.schema.is_empty() {
        String::new()
    } else {
        format!("ALTER SESSION SET CURRENT_SCHEMA = \"{}\";\n", definition.schema.replace('"', "\"\""))
    };
    let read = "SELECT TO_CHAR(JOB) AS DBX_JOB_ID, WHAT, TO_CHAR(NEXT_DATE, 'YYYY-MM-DD HH24:MI:SS') AS NEXT_DATE, INTERVAL, BROKEN, INSTANCE, LOG_USER, PRIV_USER, SCHEMA_USER FROM SYS.USER_JOBS WHERE JOB = TO_NUMBER(:dbx_job_id);";
    let placement = if engine == NativeJobCatalogDialect::OceanbaseOracle {
        format!("zone => {}", definition.zone.as_deref().map(text).unwrap_or_else(|| "NULL".into()))
    } else {
        format!("instance => {}", definition.instance)
    };
    let restore_date = if engine == NativeJobCatalogDialect::OceanbaseOracle {
        format!(
            "BEGIN SYS.DBMS_JOB.NEXT_DATE(TO_NUMBER(:dbx_job_id), TO_DATE({}, 'YYYY-MM-DD HH24:MI:SS')); END;\n",
            text(&definition.next_date)
        )
    } else {
        String::new()
    };
    Ok(vec![
        NativeJobStepPreview {
            id: "legacy_prepare".into(), label: "native_job_step_legacy_prepare".into(),
            sql: format!("{schema}DECLARE native_id BINARY_INTEGER; BEGIN SYS.DBMS_JOB.SUBMIT(job => native_id, what => {}, next_date => TO_DATE({}, 'YYYY-MM-DD HH24:MI:SS'), interval => {}, no_parse => FALSE, {placement}, force => FALSE); :dbx_job_id := TO_CHAR(native_id); END;\nBEGIN SYS.DBMS_JOB.BROKEN(TO_NUMBER(:dbx_job_id), {}, TO_DATE({}, 'YYYY-MM-DD HH24:MI:SS')); END;\n{restore_date}{read}",
                text(&definition.what), text(&definition.next_date), text(&definition.interval),
                bool_sql(!definition.enabled), text(&definition.next_date)),
        },
        NativeJobStepPreview { id: "legacy_commit".into(), label: "native_job_step_legacy_commit".into(), sql: "COMMIT;".into() },
        NativeJobStepPreview { id: "legacy_readback".into(), label: "native_job_step_legacy_readback".into(), sql: read.into() },
    ])
}

fn scheduler_package(engine: NativeJobCatalogDialect) -> &'static str {
    match engine {
        NativeJobCatalogDialect::Oracle | NativeJobCatalogDialect::OceanbaseOracle => "SYS.DBMS_SCHEDULER",
        NativeJobCatalogDialect::Dameng => "DBMS_SCHEDULER",
    }
}

pub fn native_job_mutation_plan(
    engine: NativeJobCatalogDialect,
    request: &NativeJobMutation,
    details: &NativeJobDetails,
) -> Result<NativeJobSqlPlan, &'static str> {
    request.target.validate()?;
    if details.snapshot.job_ref != request.target {
        return Err("native_job_identity_mismatch");
    }
    let scheduler = matches!(request.target, NativeJobRef::Scheduler { .. });
    if engine == NativeJobCatalogDialect::Dameng && !scheduler {
        if let Some(plan) = dameng::rename_changes(request, details)? {
            return Ok(plan);
        }
    }
    if matches!(
        &request.change,
        NativeJobChange::Update { final_enabled: Some(_), .. }
            | NativeJobChange::Update { argument_target: Some(_), .. }
    ) {
        return Err(if scheduler {
            "native_job_scheduler_transition_required"
        } else {
            "native_job_final_enabled_not_applicable"
        });
    }
    let package = scheduler_package(engine);
    let dm = engine == NativeJobCatalogDialect::Dameng && !scheduler;
    let mut plan = NativeJobSqlPlan {
        steps: Vec::new(),
        required_partitions: Vec::new(),
        compare_next_date: false,
        dameng_configuration: None,
    };
    match &request.change {
        NativeJobChange::ConfigureDameng { configuration }
            if dm && matches!(request.target, NativeJobRef::DamengNative { .. }) =>
        {
            dameng::configuration_changes(request, details, configuration, &mut plan)?;
        }
        NativeJobChange::Update { attributes, arguments, .. } if scheduler => {
            scheduler_changes(engine, request, details, attributes, arguments, &mut plan)?;
        }
        NativeJobChange::Update { attributes, arguments, .. } if !dm => {
            if !arguments.is_empty() {
                return Err("native_job_arguments_not_applicable");
            }
            legacy_changes(engine, request, attributes, &mut plan)?;
        }
        NativeJobChange::Update { attributes, arguments, .. } => {
            if !arguments.is_empty() {
                return Err("native_job_arguments_not_applicable");
            }
            dameng::metadata_changes(request, details, attributes, &mut plan)?;
        }
        action => {
            let name = if scheduler || dm { Some(text(&target_name(engine, &request.target, details)?)) } else { None };
            let id = match &request.target {
                NativeJobRef::Legacy { job_id, .. } | NativeJobRef::DamengNative { job_id, .. } => job_id.as_str(),
                _ => "",
            };
            let (label, calls, effect) = match action {
                NativeJobChange::Enable | NativeJobChange::Disable => {
                    let enabled = matches!(action, NativeJobChange::Enable);
                    let label = if enabled { "enable" } else { "disable" };
                    let call = if scheduler {
                        format!("{package}.{}({});", if enabled { "ENABLE" } else { "DISABLE" }, name.as_ref().unwrap())
                    } else if dm {
                        format!("SP_ENABLE_JOB({}, {});", name.as_ref().unwrap(), if enabled { 1 } else { 0 })
                    } else {
                        // Read the current date in this call; OB BROKEN(TRUE) ignores its date argument.
                        let source = match details.sources.get("definition").and_then(|source| source.source.as_deref())
                        {
                            Some("SYS.DBA_JOBS") => "SYS.DBA_JOBS",
                            _ => "SYS.USER_JOBS",
                        };
                        let restore_date = if engine == NativeJobCatalogDialect::OceanbaseOracle {
                            format!(" SYS.DBMS_JOB.NEXT_DATE({id}, next_at);")
                        } else {
                            String::new()
                        };
                        format!("DECLARE next_at DATE; BEGIN SELECT NEXT_DATE INTO next_at FROM {source} WHERE JOB = {id}; SYS.DBMS_JOB.BROKEN({id}, {}, next_at);{restore_date} COMMIT; END;", bool_sql(!enabled))
                    };
                    (label, call, NativeJobStepEffect::Enabled(enabled))
                }
                NativeJobChange::Run => {
                    let calls = if scheduler {
                        format!(
                            "{package}.RUN_JOB(job_name => {}, {} => FALSE);",
                            name.as_ref().unwrap(),
                            if engine == NativeJobCatalogDialect::OceanbaseOracle {
                                "force"
                            } else {
                                "use_current_session"
                            }
                        )
                    } else if dm {
                        format!("SP_DBMS_JOB_RUN_ASYNC({id});")
                    } else {
                        format!("SYS.DBMS_JOB.RUN({id}, FALSE);")
                    };
                    (
                        "run",
                        calls,
                        if !scheduler && !dm { NativeJobStepEffect::Completed } else { NativeJobStepEffect::Accepted },
                    )
                }
                NativeJobChange::Stop { force } => {
                    if *force && engine != NativeJobCatalogDialect::Oracle {
                        return Err("native_job_force_stop_not_supported");
                    }
                    let calls = if scheduler {
                        format!(
                            "{package}.STOP_JOB(job_name => {}, force => {});",
                            name.as_ref().unwrap(),
                            bool_sql(*force)
                        )
                    } else if dm {
                        format!("SP_STOP_RUNNING_JOB({id});")
                    } else {
                        return Err("native_job_dbms_job_has_no_stop");
                    };
                    ("stop", calls, NativeJobStepEffect::Accepted)
                }
                NativeJobChange::Drop { force } => {
                    let calls = if scheduler {
                        format!(
                            "{package}.DROP_JOB(job_name => {}, force => {});",
                            name.as_ref().unwrap(),
                            bool_sql(*force)
                        )
                    } else if dm {
                        if *force {
                            return Err("native_job_force_drop_not_applicable");
                        }
                        format!("SP_DROP_JOB({});", name.as_ref().unwrap())
                    } else {
                        if *force {
                            return Err("native_job_force_drop_not_applicable");
                        }
                        format!("SYS.DBMS_JOB.REMOVE({id}); COMMIT;")
                    };
                    ("drop", calls, NativeJobStepEffect::Deleted)
                }
                NativeJobChange::ClearHistory if dm => (
                    "clear_history",
                    format!("SP_JOB_CLEAR_HISTORIES({});", name.as_ref().unwrap()),
                    NativeJobStepEffect::HistoryCleared,
                ),
                _ => return Err("native_job_action_not_applicable"),
            };
            let sql = wrap(engine, &request.target, details, &calls)?;
            plan.steps.push(NativeJobSqlStep {
                id: label.into(),
                label: format!("native_job_step_{label}"),
                sql,
                effect,
            });
            plan.required_partitions.push("definition".into());
        }
    }
    if plan.steps.is_empty() {
        return Err("native_job_no_changes");
    }
    Ok(plan)
}

fn legacy_changes(
    engine: NativeJobCatalogDialect,
    request: &NativeJobMutation,
    attributes: &[NativeJobAttributeChange],
    plan: &mut NativeJobSqlPlan,
) -> Result<(), &'static str> {
    let NativeJobRef::Legacy { job_id, .. } = &request.target else {
        return Err("native_job_kind_invalid");
    };
    let mut calls = String::new();
    let mut changed = Vec::new();
    let mut seen = HashSet::new();
    for attribute in attributes.iter().filter(|attribute| attribute.change != NativeJobFieldChange::Keep) {
        let name = attribute.name.to_ascii_uppercase();
        if !seen.insert(name.clone()) {
            return Err("native_job_duplicate_attribute");
        }
        if name == "ZONE" && engine == NativeJobCatalogDialect::OceanbaseOracle {
            let zone = match &attribute.change {
                NativeJobFieldChange::Set { value: Value::String(value) }
                    if !value.is_empty() && !value.contains('\0') =>
                {
                    text(value)
                }
                NativeJobFieldChange::Clear => "NULL".into(),
                _ => return Err("native_job_attribute_type_invalid"),
            };
            calls.push_str(&format!("SYS.DBMS_JOB.ZONE(job => {job_id}, zone => {zone}, force => FALSE);"));
            // The native view calls this VARCHAR2/NULL column INSTANCE; keep that raw projection.
            changed.push(NativeJobAttributeChange { name: "INSTANCE".into(), change: attribute.change.clone() });
            continue;
        }
        let value = match &attribute.change {
            NativeJobFieldChange::Set { value } => value,
            _ => return Err("native_job_legacy_clear_requires_value"),
        };
        let sql = match name.as_str() {
            "WHAT" | "INTERVAL" => {
                let value = value.as_str().ok_or("native_job_attribute_type_invalid")?;
                format!("SYS.DBMS_JOB.{}({job_id}, {});", name, text(value))
            }
            "NEXT_DATE" => {
                plan.compare_next_date = true;
                format!(
                    "SYS.DBMS_JOB.NEXT_DATE({job_id}, TO_DATE({}, 'YYYY-MM-DD HH24:MI:SS'));",
                    text(value.as_str().ok_or("native_job_attribute_type_invalid")?)
                )
            }
            "INSTANCE" if engine == NativeJobCatalogDialect::Oracle => {
                format!(
                    "SYS.DBMS_JOB.INSTANCE({job_id}, {});",
                    value.as_u64().ok_or("native_job_attribute_type_invalid")?
                )
            }
            _ => return Err("native_job_attribute_not_editable"),
        };
        calls.push_str(&sql);
        changed.push(NativeJobAttributeChange { name, change: attribute.change.clone() });
    }
    if !changed.is_empty() {
        plan.required_partitions.push("definition".into());
        plan.steps.push(NativeJobSqlStep {
            id: "definition".into(),
            label: "native_job_step_definition".into(),
            sql: format!("BEGIN {calls} COMMIT; END;"),
            effect: NativeJobStepEffect::Fields(changed),
        });
    }
    Ok(())
}

fn scheduler_changes(
    engine: NativeJobCatalogDialect,
    request: &NativeJobMutation,
    details: &NativeJobDetails,
    attributes: &[NativeJobAttributeChange],
    arguments: &[NativeJobArgumentChange],
    plan: &mut NativeJobSqlPlan,
) -> Result<(), &'static str> {
    let before = definition(details)?;
    let identity = match &details.native_identity {
        NativeJobMetadata::Available { value } => Some(value),
        _ if engine == NativeJobCatalogDialect::OceanbaseOracle => return Err("native_job_identity_unverified"),
        _ => None,
    };
    scheduler_attribute_steps(engine, &request.target, identity, Some(before), attributes, plan)?;
    let original = match &details.snapshot.arguments {
        NativeJobMetadata::Available { value } => value,
        _ if arguments.is_empty() => return Ok(()),
        _ => return Err("native_job_arguments_unavailable"),
    };
    let mut positions = HashSet::new();
    if !arguments.is_empty() && !plan.required_partitions.iter().any(|part| part == "definition") {
        plan.required_partitions.push("definition".into());
    }
    for change in arguments {
        if engine == NativeJobCatalogDialect::Oracle {
            crate::native_job_arguments::validate_lightweight_argument(
                before.get("JOB_STYLE").and_then(Value::as_str),
                &change.value,
            )?;
        }
        if change.position == 0 || !positions.insert(change.position) {
            return Err("native_job_argument_position_invalid");
        }
        let argument = original
            .iter()
            .find(|argument| argument.position == change.position)
            .ok_or("native_job_argument_missing")?;
        if !argument.editable || matches!(change.value, NativeJobArgumentValue::Opaque { .. }) {
            return Err("native_job_argument_not_editable");
        }
        plan.required_partitions.push(format!("argument:{}", change.position));
        plan.steps.push(scheduler_argument_step(engine, &request.target, identity, change, &argument.data_type)?);
    }
    Ok(())
}

fn scheduler_attribute_steps(
    engine: NativeJobCatalogDialect,
    target: &NativeJobRef,
    identity: Option<&NativeJobRow>,
    before: Option<&NativeJobRow>,
    attributes: &[NativeJobAttributeChange],
    plan: &mut NativeJobSqlPlan,
) -> Result<(), &'static str> {
    let name = text(&scheduler_name(engine, target)?);
    let package = scheduler_package(engine);
    let mut seen = HashSet::new();
    let mut batch = Vec::new();
    let mut changes = Vec::new();
    for attribute in attributes.iter().filter(|attribute| attribute.change != NativeJobFieldChange::Keep) {
        let key = attribute.name.to_ascii_uppercase();
        if !seen.insert(key.clone()) {
            return Err("native_job_duplicate_attribute");
        }
        // DM exposes Oracle compatibility columns whose values have no scheduling effect.
        if engine == NativeJobCatalogDialect::Dameng
            && !matches!(
                key.as_str(),
                "AUTO_DROP"
                    | "JOB_TYPE"
                    | "JOB_ACTION"
                    | "NUMBER_OF_ARGUMENTS"
                    | "START_DATE"
                    | "END_DATE"
                    | "REPEAT_INTERVAL"
                    | "PROGRAM_NAME"
                    | "SCHEDULE_NAME"
                    | "COMMENTS"
                    | "MAX_RUN_DURATION"
            )
        {
            return Err("native_job_attribute_not_editable");
        }
        // The OB adapter follows the V4.2.5 setter contract, not CREATE_JOB's broader inputs.
        if engine == NativeJobCatalogDialect::OceanbaseOracle
            && !matches!(key.as_str(), "JOB_CLASS" | "MAX_FAILURES" | "MAX_RUN_DURATION" | "INSTANCE_ID")
        {
            return Err("native_job_attribute_not_editable");
        }
        let kind = match key.as_str() {
            "INSTANCE_ID" if engine == NativeJobCatalogDialect::OceanbaseOracle => "text",
            "AUTO_DROP"
            | "RESTARTABLE"
            | "STOP_ON_WINDOW_CLOSE"
            | "STORE_OUTPUT"
            | "ALLOW_RUNS_IN_RESTRICTED_MODE"
            | "INSTANCE_STICKINESS"
            | "FOLLOW_DEFAULT_TIMEZONE" => "boolean",
            "NUMBER_OF_ARGUMENTS"
            | "JOB_PRIORITY"
            | "MAX_RUNS"
            | "MAX_FAILURES"
            | "RAISE_EVENTS"
            | "INSTANCE_ID"
            | "JOB_WEIGHT" => "number",
            "START_DATE" | "END_DATE" => "timestamp",
            "SCHEDULE_LIMIT" | "MAX_RUN_DURATION" => "interval",
            "JOB_ACTION"
            | "JOB_TYPE"
            | "COMMENTS"
            | "REPEAT_INTERVAL"
            | "JOB_CLASS"
            | "CONNECT_CREDENTIAL_NAME"
            | "CREDENTIAL_NAME"
            | "DESTINATION"
            | "DESTINATION_NAME"
            | "PROGRAM_NAME"
            | "SCHEDULE_NAME" => "text",
            "LOGGING_LEVEL" if engine == NativeJobCatalogDialect::Oracle => "logging",
            _ => return Err("native_job_attribute_not_editable"),
        };
        // A missing field is not an empty attribute; keep it available for correction rather than overwrite it.
        if before.is_some_and(|before| !before.contains_key(&key)) {
            return Err("native_job_metadata_incomplete");
        }
        let value = match &attribute.change {
            NativeJobFieldChange::Set { value } => value,
            NativeJobFieldChange::Clear => &Value::Null,
            NativeJobFieldChange::Keep => unreachable!(),
        };
        if key == "DESTINATION"
            && !value.is_null()
            && !value.as_str().is_some_and(|value| !value.is_empty() && !value.contains('\0'))
        {
            return Err("native_job_attribute_value_invalid");
        }
        let value_sql = match (kind, value) {
            (_, Value::Null) if engine == NativeJobCatalogDialect::OceanbaseOracle => {
                return Err("native_job_attribute_null_unsupported");
            }
            (_, Value::Null) => None,
            ("boolean", Value::Bool(value)) => Some(bool_sql(*value).into()),
            ("number", Value::Number(value)) if value.as_u64().is_some() => Some(value.to_string()),
            ("text", Value::String(value)) => Some(text(value)),
            ("logging", Value::String(value)) => Some(match value.as_str() {
                "OFF" => "SYS.DBMS_SCHEDULER.LOGGING_OFF".into(),
                "RUNS" => "SYS.DBMS_SCHEDULER.LOGGING_RUNS".into(),
                "FAILED RUNS" => "SYS.DBMS_SCHEDULER.LOGGING_FAILED_RUNS".into(),
                "FULL" => "SYS.DBMS_SCHEDULER.LOGGING_FULL".into(),
                _ => return Err("native_job_attribute_value_invalid"),
            }),
            ("timestamp", Value::String(value)) => Some(scheduler_timestamp(value)?),
            ("interval", Value::String(value)) if engine == NativeJobCatalogDialect::OceanbaseOracle => {
                Some(text(&ob_duration_seconds(value)?.to_string()))
            }
            ("interval", Value::String(value)) => Some(format!("TO_DSINTERVAL({})", text(value))),
            _ => return Err("native_job_attribute_type_invalid"),
        };
        let attr = text(&key.to_ascii_lowercase());
        let calls = match &value_sql {
            Some(value) => format!("{package}.SET_ATTRIBUTE(name => {name}, attribute => {attr}, value => {value});"),
            None if engine == NativeJobCatalogDialect::Oracle => {
                format!("{package}.SET_ATTRIBUTE_NULL(name => {name}, attribute => {attr});")
            }
            None => format!(
                "{package}.SET_ATTRIBUTE(name => {name}, attribute => {attr}, value => CAST(NULL AS VARCHAR2(4000)));"
            ),
        };
        let changed = NativeJobAttributeChange { name: key.clone(), change: attribute.change.clone() };
        if engine == NativeJobCatalogDialect::Oracle
            && key != "DESTINATION"
            && value.as_str().is_none_or(|value| value.len() <= 4_000)
        {
            batch.push(match value_sql {
                Some(value) => format!("SYS.JOBATTR({name}, {attr}, {value})"),
                None => format!("SYS.JOBATTR({name}, {attr})"),
            });
            changes.push(changed);
        } else {
            plan.steps.push(NativeJobSqlStep {
                id: format!("attribute:{key}"),
                label: "native_job_step_attribute".into(),
                sql: wrap_scheduler(engine, target, identity, &calls)?,
                effect: NativeJobStepEffect::Fields(vec![changed]),
            });
        }
    }
    if !batch.is_empty() {
        plan.steps.insert(
            0,
            NativeJobSqlStep {
                id: "attributes".into(),
                label: "native_job_step_attributes".into(),
                sql: format!(
                    "BEGIN SYS.DBMS_SCHEDULER.SET_JOB_ATTRIBUTES(SYS.JOBATTR_ARRAY({}), 'TRANSACTIONAL'); END;",
                    batch.join(", ")
                ),
                effect: NativeJobStepEffect::Fields(changes),
            },
        );
    }
    if !attributes.is_empty() {
        plan.required_partitions.push("definition".into());
    }
    Ok(())
}

fn ob_duration_seconds(value: &str) -> Result<u64, &'static str> {
    let invalid = "native_job_duration_requires_whole_seconds";
    let pattern = regex::Regex::new(r"^\+?(\d+) (\d{1,2}):(\d{2}):(\d{2})(?:\.(0{1,9}))?$").unwrap();
    let captures = pattern.captures(value.trim()).ok_or(invalid)?;
    let component = |index: usize| captures[index].parse::<u64>().map_err(|_| invalid);
    let (days, hours, minutes, seconds) = (component(1)?, component(2)?, component(3)?, component(4)?);
    if hours > 23 || minutes > 59 || seconds > 59 {
        return Err(invalid);
    }
    days.checked_mul(24)
        .and_then(|value| value.checked_add(hours))
        .and_then(|value| value.checked_mul(60))
        .and_then(|value| value.checked_add(minutes))
        .and_then(|value| value.checked_mul(60))
        .and_then(|value| value.checked_add(seconds))
        .filter(|value| *value <= i64::MAX as u64)
        .ok_or(invalid)
}

fn scheduler_timestamp(value: &str) -> Result<String, &'static str> {
    let pattern =
        regex::Regex::new(r"^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?) ?([+-]\d{2}:\d{2}|Z)$").unwrap();
    let captures = pattern.captures(value).ok_or("native_job_timestamp_requires_offset")?;
    let offset = if &captures[2] == "Z" { "+00:00" } else { &captures[2] };
    let normalized = format!("{} {offset}", captures[1].replace('T', " "));
    let format =
        if captures[1].contains('.') { "YYYY-MM-DD HH24:MI:SS.FF TZH:TZM" } else { "YYYY-MM-DD HH24:MI:SS TZH:TZM" };
    Ok(format!("TO_TIMESTAMP_TZ({}, '{}')", text(&normalized), format))
}

pub fn scheduler_argument_step(
    engine: NativeJobCatalogDialect,
    target: &NativeJobRef,
    identity: Option<&NativeJobRow>,
    change: &NativeJobArgumentChange,
    data_type: &str,
) -> Result<NativeJobSqlStep, &'static str> {
    let name = text(&scheduler_name(engine, target)?);
    let package = scheduler_package(engine);
    let mut expected = change.clone();
    let mut expected_storage = None;
    let calls = match &change.value {
        NativeJobArgumentValue::Unset | NativeJobArgumentValue::Inherit => {
            if engine == NativeJobCatalogDialect::Dameng {
                return Err("native_job_argument_reset_mapping_unverified");
            }
            format!("{package}.RESET_JOB_ARGUMENT_VALUE(job_name => {name}, argument_position => {});", change.position)
        }
        NativeJobArgumentValue::Value { value: Value::String(value) } if !value.is_empty() => format!(
            "{package}.SET_JOB_ARGUMENT_VALUE(job_name => {name}, argument_position => {}, argument_value => {});",
            change.position,
            text(value)
        ),
        NativeJobArgumentValue::Value { value: Value::Object(_) } if engine == NativeJobCatalogDialect::Oracle => {
            let NativeJobArgumentValue::Value { value } = &change.value else { unreachable!() };
            let setter = format!("{package}.SET_JOB_ANYDATA_VALUE(job_name => {name}, argument_position => {}, argument_value => l_anydata);", change.position);
            let (block, storage) = crate::native_job_arguments::scalar_value_block(value, Some(&setter))?;
            expected.value = storage.editable_value();
            expected_storage = Some(storage);
            block
        }
        NativeJobArgumentValue::Null | NativeJobArgumentValue::Value { value: Value::String(_) }
            if engine == NativeJobCatalogDialect::Oracle =>
        {
            let (expression, storage) = crate::native_job_arguments::null_anydata_expression(data_type)?;
            expected_storage = Some(storage);
            format!("{package}.SET_JOB_ANYDATA_VALUE(job_name => {name}, argument_position => {}, argument_value => {expression});", change.position)
        }
        NativeJobArgumentValue::Null => return Err("native_job_argument_null_mapping_unverified"),
        _ => return Err("native_job_argument_value_invalid"),
    };
    Ok(NativeJobSqlStep {
        id: format!("argument:{}", change.position),
        label: "native_job_step_argument".into(),
        sql: wrap_scheduler(engine, target, identity, &calls)?,
        effect: NativeJobStepEffect::Argument(expected, expected_storage),
    })
}

pub fn scheduler_argument_validation_steps<'a>(
    engine: NativeJobCatalogDialect,
    values: impl IntoIterator<Item = (usize, &'a NativeJobArgumentValue)>,
) -> Result<Vec<NativeJobSqlStep>, &'static str> {
    if engine != NativeJobCatalogDialect::Oracle {
        return Ok(Vec::new());
    }
    values
        .into_iter()
        .filter_map(|(position, value)| match value {
            NativeJobArgumentValue::Value { value: Value::Object(_) } => Some((position, value)),
            _ => None,
        })
        .map(|(position, value)| {
            let NativeJobArgumentValue::Value { value } = value else { unreachable!() };
            Ok(NativeJobSqlStep {
                id: format!("validate-argument:{position}"),
                label: "native_job_step_validate_arguments".into(),
                sql: crate::native_job_arguments::scalar_value_block(value, None)?.0,
                effect: NativeJobStepEffect::ArgumentValidated,
            })
        })
        .collect()
}
