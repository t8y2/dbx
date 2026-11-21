use super::*;
use crate::native_jobs::{NativeJobCatalogCoverage, NativeJobCatalogQuery};
use std::collections::BTreeMap;

mod creation;
mod legacy;
pub use legacy::{native_job_dameng_civil_time, native_job_dameng_date_query, native_job_dameng_legacy_time};
mod parts;
pub use creation::{native_job_dameng_create_plan, native_job_dameng_name_queries, NativeJobDamengCreatePlan};

pub fn native_job_dameng_identity_queries(target: &NativeJobRef) -> Result<Vec<NativeJobCatalogQuery>, &'static str> {
    target.validate()?;
    let (NativeJobRef::DamengNative { job_id, .. } | NativeJobRef::Legacy { job_id, .. }) = target else {
        return Err("native_job_kind_invalid");
    };
    Ok([("SYSJOB.SYSJOBS", NativeJobCatalogCoverage::Database), ("SYSJOB.USER_JOBS_VIEW", NativeJobCatalogCoverage::CurrentUser)].into_iter().map(|(source, coverage)| NativeJobCatalogQuery {
        source, coverage, limit: 1,
        sql: format!("SELECT CAST(ID AS VARCHAR(40)) AS DBX_JOB_ID, CREATETIME AS DBX_CREATED_AT, NAME, USERNAME, SYS_FLAG FROM {source} WHERE ID = {job_id}"),
    }).collect())
}

pub fn native_job_dameng_what_query(body: &str) -> NativeJobCatalogQuery {
    NativeJobCatalogQuery {
        source: "DUAL",
        coverage: NativeJobCatalogCoverage::Accessible,
        sql: format!("SELECT CAST({} AS VARCHAR2(32767)) AS DBX_WHAT FROM DUAL", text(body)),
        limit: 1,
    }
}

pub(super) fn rename_changes(
    request: &NativeJobMutation,
    details: &NativeJobDetails,
) -> Result<Option<NativeJobSqlPlan>, &'static str> {
    let attributes = match &request.change {
        NativeJobChange::Update { attributes, .. } => attributes,
        NativeJobChange::ConfigureDameng { configuration } => &configuration.attributes,
        _ => return Ok(None),
    };
    let names = attributes
        .iter()
        .filter(|attribute| {
            attribute.name.eq_ignore_ascii_case("NAME") && attribute.change != NativeJobFieldChange::Keep
        })
        .collect::<Vec<_>>();
    if names.len() > 1 {
        return Err("native_job_duplicate_attribute");
    }
    let Some(change) = names.first() else {
        return Ok(None);
    };
    let NativeJobFieldChange::Set { value: Value::String(new_name) } = &change.change else {
        return Err("native_job_attribute_type_invalid");
    };
    // Parent Job names use the documented ASCII name domain too; catalog names remain unmodified.
    parts::valid_name(new_name).map_err(|_| "native_job_name_invalid")?;
    let old_name = target_name(NativeJobCatalogDialect::Dameng, &request.target, details)?;
    let mut base = request.clone();
    let attributes = match &mut base.change {
        NativeJobChange::Update { attributes, .. } => attributes,
        NativeJobChange::ConfigureDameng { configuration } => &mut configuration.attributes,
        _ => unreachable!(),
    };
    attributes.retain(|attribute| !attribute.name.eq_ignore_ascii_case("NAME"));
    let mut plan = match native_job_mutation_plan(NativeJobCatalogDialect::Dameng, &base, details) {
        Ok(plan) => plan,
        Err("native_job_no_changes") => NativeJobSqlPlan {
            steps: Vec::new(),
            required_partitions: vec!["definition".into()],
            compare_next_date: false,
            dameng_configuration: Some(NativeJobDamengConfigPlan { operators: Vec::new() }),
        },
        Err(reason) => return Err(reason),
    };
    if new_name == &old_name {
        return if plan.steps.is_empty() { Err("native_job_no_changes") } else { Ok(Some(plan)) };
    }
    flag(current(definition(details)?, "ENABLE")?)?;
    let at = plan
        .steps
        .iter()
        .position(|step| matches!(step.effect, NativeJobStepEffect::Enabled(true)))
        .unwrap_or(plan.steps.len());
    plan.steps.insert(
        at,
        NativeJobSqlStep {
            id: "rename".into(),
            label: "native_job_step_attribute".into(),
            sql: guarded_call(
                &request.target,
                details,
                &format!("SP_RENAME_JOB({}, {}); COMMIT;", text(&old_name), text(new_name)),
            )?,
            effect: NativeJobStepEffect::DamengRenamed { old_name, new_name: new_name.clone() },
        },
    );
    let mut rebound = details.clone();
    if let NativeJobRef::DamengNative { name, .. } = &mut rebound.snapshot.job_ref {
        *name = new_name.clone();
    }
    if let NativeJobMetadata::Available { value } = &mut rebound.snapshot.definition {
        value.insert("NAME".into(), Value::String(new_name.clone()));
    }
    for step in &mut plan.steps[at + 1..] {
        if let NativeJobStepEffect::Enabled(enabled) = step.effect {
            step.sql = guarded_call(
                &rebound.snapshot.job_ref,
                &rebound,
                &format!("SP_ENABLE_JOB({}, {});", text(new_name), u8::from(enabled)),
            )?;
        }
    }
    Ok(Some(plan))
}
pub use parts::{
    native_job_dameng_catalog_id, native_job_dameng_child_id, native_job_dameng_child_key,
    resolve_native_job_dameng_child_step, NativeJobDamengChildAction, NativeJobDamengChildEffect,
    NativeJobDamengChildReference, NativeJobDamengPart,
};

#[derive(Clone)]
pub enum NativeJobDamengOperatorSelector {
    Unassigned,
    Id(i64),
    Name(String),
}

#[derive(Clone)]
pub struct NativeJobDamengOperator {
    pub column: &'static str,
    pub selector: NativeJobDamengOperatorSelector,
}

#[derive(Clone)]
pub struct NativeJobDamengConfigPlan {
    pub operators: Vec<NativeJobDamengOperator>,
}

impl NativeJobDamengConfigPlan {
    /// Resolve only this definition's references before pausing or changing the native job.
    pub fn operator_query(&self) -> Option<NativeJobCatalogQuery> {
        let selectors = self
            .operators
            .iter()
            .map(|operator| {
                (
                    operator.column,
                    match &operator.selector {
                        NativeJobDamengOperatorSelector::Unassigned => None,
                        NativeJobDamengOperatorSelector::Id(id) => Some(format!("ID = {id}")),
                        NativeJobDamengOperatorSelector::Name(name) => {
                            Some(format!("UPPER(NAME) = UPPER({})", text(name)))
                        }
                    },
                )
            })
            .collect::<Vec<_>>();
        let predicates = selectors.iter().filter_map(|(_, predicate)| predicate.as_deref()).collect::<Vec<_>>();
        let matches = selectors
            .iter()
            .map(|(column, predicate)| match predicate {
                Some(predicate) => format!("CASE WHEN {predicate} THEN 1 ELSE 0 END AS DBX_MATCH_{column}"),
                None => format!("0 AS DBX_MATCH_{column}"),
            })
            .collect::<Vec<_>>()
            .join(", ");
        (!predicates.is_empty()).then(|| NativeJobCatalogQuery {
            source: "SYSJOB.SYSOPERATORS",
            coverage: NativeJobCatalogCoverage::Database,
            sql: format!(
                "SELECT CAST(ID AS VARCHAR(40)) AS DBX_OPERATOR_ID, NAME, {matches} FROM SYSJOB.SYSOPERATORS WHERE {} ORDER BY ID",
                predicates.join(" OR ")
            ),
            limit: 4,
        })
    }
}

fn integer(value: &Value) -> Result<i64, &'static str> {
    value.as_i64().or_else(|| value.as_str()?.parse().ok()).ok_or("native_job_attribute_type_invalid")
}

fn flag(value: &Value) -> Result<bool, &'static str> {
    match value {
        Value::Bool(value) => Ok(*value),
        _ => match integer(value)? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err("native_job_attribute_value_invalid"),
        },
    }
}

fn scalar(value: &Value) -> Result<String, &'static str> {
    match value {
        Value::Null => Ok("NULL".into()),
        Value::String(value) if !value.contains('\0') => Ok(text(value)),
        _ => Err("native_job_attribute_type_invalid"),
    }
}

fn current<'a>(row: &'a NativeJobRow, key: &str) -> Result<&'a Value, &'static str> {
    row.get(key).ok_or("native_job_metadata_incomplete")
}

fn desired(
    row: &NativeJobRow,
    changes: &BTreeMap<String, NativeJobFieldChange>,
    key: &str,
) -> Result<Value, &'static str> {
    match changes.get(key) {
        Some(NativeJobFieldChange::Set { value }) => Ok(value.clone()),
        Some(NativeJobFieldChange::Clear) => Ok(Value::Null),
        _ => Ok(current(row, key)?.clone()),
    }
}

fn operator(
    row: &NativeJobRow,
    changes: &BTreeMap<String, NativeJobFieldChange>,
    input: &str,
    column: &'static str,
) -> Result<NativeJobDamengOperator, &'static str> {
    let selector = match changes.get(input) {
        Some(NativeJobFieldChange::Clear) => NativeJobDamengOperatorSelector::Unassigned,
        Some(NativeJobFieldChange::Set { value: Value::String(name) }) if !name.is_empty() && !name.contains('\0') => {
            NativeJobDamengOperatorSelector::Name(name.clone())
        }
        Some(NativeJobFieldChange::Set { .. }) => return Err("native_job_attribute_type_invalid"),
        _ => match current(row, column)? {
            Value::Null => NativeJobDamengOperatorSelector::Unassigned,
            value => {
                let id = integer(value)?;
                if id > 0 {
                    NativeJobDamengOperatorSelector::Id(id)
                } else {
                    NativeJobDamengOperatorSelector::Unassigned
                }
            }
        },
    };
    Ok(NativeJobDamengOperator { column, selector })
}

fn operator_sql(operator: &NativeJobDamengOperator, variable: &str) -> (String, String) {
    let predicate = match &operator.selector {
        NativeJobDamengOperatorSelector::Unassigned => return (String::new(), "NULL".into()),
        NativeJobDamengOperatorSelector::Id(id) => format!("ID = {id}"),
        NativeJobDamengOperatorSelector::Name(name) => format!("UPPER(NAME) = UPPER({})", text(name)),
    };
    (format!("SELECT NAME INTO {variable} FROM SYSJOB.SYSOPERATORS WHERE {predicate}; "), variable.into())
}

pub(super) fn guarded_call(
    target: &NativeJobRef,
    details: &NativeJobDetails,
    calls: &str,
) -> Result<String, &'static str> {
    let name = target_name(NativeJobCatalogDialect::Dameng, target, details)?;
    let id = match target {
        NativeJobRef::DamengNative { job_id, .. } | NativeJobRef::Legacy { job_id, .. } => job_id,
        _ => return Err("native_job_kind_invalid"),
    };
    let source = match details
        .sources
        .get("identity")
        .and_then(|source| source.source.as_deref())
        .or_else(|| details.sources.get("definition").and_then(|source| source.source.as_deref()))
    {
        Some("SYSJOB.SYSJOBS") => "SYSJOB.SYSJOBS",
        Some("SYSJOB.USER_JOBS_VIEW") => "SYSJOB.USER_JOBS_VIEW",
        _ => return Err("native_job_catalog_source_unverified"),
    };
    let NativeJobMetadata::Available { value: identity } = &details.native_identity else {
        return Err("native_job_identity_unverified");
    };
    if identity.get("DBX_JOB_ID").and_then(Value::as_str) != Some(id) {
        return Err("native_job_identity_unverified");
    }
    let created = string_field(identity, "DBX_CREATED_AT")?;
    Ok(format!("DECLARE dbx_target_count INT; dbx_target_changed EXCEPTION; dbx_email_operator VARCHAR(128); dbx_netsend_operator VARCHAR(128); BEGIN SELECT COUNT(*) INTO dbx_target_count FROM {source} WHERE ID = {id} AND NAME = {} AND CREATETIME = {}; IF dbx_target_count <> 1 THEN RAISE dbx_target_changed; END IF; {calls} END;", text(&name), text(created)))
}

pub(super) fn metadata_changes(
    request: &NativeJobMutation,
    details: &NativeJobDetails,
    attributes: &[NativeJobAttributeChange],
    plan: &mut NativeJobSqlPlan,
) -> Result<(), &'static str> {
    if !matches!(request.target, NativeJobRef::Legacy { .. }) {
        return native_metadata_changes(request, details, attributes, plan);
    }
    let interval = attributes
        .iter()
        .filter(|attribute| {
            attribute.name.eq_ignore_ascii_case("INTERVAL") && attribute.change != NativeJobFieldChange::Keep
        })
        .collect::<Vec<_>>();
    if interval.len() > 1 {
        return Err("native_job_duplicate_attribute");
    }
    let what = attributes
        .iter()
        .filter(|attribute| {
            attribute.name.eq_ignore_ascii_case("WHAT") && attribute.change != NativeJobFieldChange::Keep
        })
        .collect::<Vec<_>>();
    if what.len() > 1 {
        return Err("native_job_duplicate_attribute");
    }
    let dates = attributes
        .iter()
        .filter(|attribute| {
            attribute.name.eq_ignore_ascii_case("NEXT_DATE") && attribute.change != NativeJobFieldChange::Keep
        })
        .collect::<Vec<_>>();
    if dates.len() > 1 {
        return Err("native_job_duplicate_attribute");
    }
    if interval.is_empty() && what.is_empty() && dates.is_empty() {
        return native_metadata_changes(request, details, attributes, plan);
    }
    let Some(NativeJobMetadata::Available { value: legacy }) = &details.legacy_definition else {
        return Err("native_job_legacy_definition_unavailable");
    };
    for column in ["WHAT", "NEXT_DATE", "INTERVAL", "INSTANCE"] {
        current(legacy, column)?;
    }
    let legacy_value = |attribute: &&NativeJobAttributeChange| -> Result<String, &'static str> {
        let NativeJobFieldChange::Set { value: Value::String(input) } = &attribute.change else {
            return Err("native_job_attribute_type_invalid");
        };
        if input.is_empty() || input.contains('\0') {
            return Err("native_job_attribute_value_invalid");
        }
        Ok(input.clone())
    };
    let body = what.first().map(legacy_value).transpose()?;
    let interval = interval.first().map(legacy_value).transpose()?;
    let date =
        dates.first().map(legacy_value).transpose()?.map(|value| native_job_dameng_civil_time(&value)).transpose()?;
    if date.is_some() {
        native_job_dameng_legacy_time(legacy)?;
        plan.compare_next_date = true;
    }
    let native = attributes
        .iter()
        .filter(|attribute| {
            !["INTERVAL", "WHAT", "NEXT_DATE"].iter().any(|name| attribute.name.eq_ignore_ascii_case(name))
        })
        .cloned()
        .collect::<Vec<_>>();
    native_metadata_changes(request, details, &native, plan)?;
    let name = target_name(NativeJobCatalogDialect::Dameng, &request.target, details)?;
    let guard = |calls: &str| guarded_call(&request.target, details, calls);
    if plan.steps.is_empty() {
        plan.steps.push(NativeJobSqlStep {
            id: "pause".into(),
            label: "native_job_step_pause_scheduling".into(),
            sql: guard(&format!("SP_ENABLE_JOB({}, 0);", text(&name)))?,
            effect: NativeJobStepEffect::Enabled(false),
        });
        if flag(current(definition(details)?, "ENABLE")?)? {
            plan.steps.push(NativeJobSqlStep {
                id: "enable".into(),
                label: "native_job_step_enable".into(),
                sql: guard(&format!("SP_ENABLE_JOB({}, 1);", text(&name)))?,
                effect: NativeJobStepEffect::Enabled(true),
            });
        }
        plan.required_partitions.push("definition".into());
        plan.dameng_configuration = Some(NativeJobDamengConfigPlan { operators: Vec::new() });
    }
    let NativeJobRef::Legacy { job_id, .. } = &request.target else { unreachable!() };
    let at = plan
        .steps
        .iter()
        .position(|step| matches!(step.effect, NativeJobStepEffect::Enabled(true)))
        .unwrap_or(plan.steps.len());
    let mut setters = Vec::new();
    if let Some(body) = body {
        setters.push(NativeJobSqlStep {
            id: "legacy_what".into(),
            label: "native_job_step_attribute".into(),
            sql: guard(&format!("DECLARE dbx_what VARCHAR2(32767); BEGIN dbx_what := {}; DBMS_JOB.WHAT({job_id}, dbx_what); COMMIT; END;", text(&body)))?,
            effect: NativeJobStepEffect::DamengLegacyWhat { expected: body },
        });
    }
    if let Some(input) = interval {
        let digits = input.trim_start_matches('0');
        let expected_seconds =
            (!digits.is_empty() && input.bytes().all(|byte| byte.is_ascii_digit())).then(|| digits.to_string());
        let expression =
            expected_seconds.as_ref().map_or_else(|| input.clone(), |seconds| format!("SYSDATE+{seconds}/86400"));
        setters.push(NativeJobSqlStep {
            id: "legacy_interval".into(),
            label: "native_job_step_attribute".into(),
            sql: guard(&format!("DBMS_JOB.\"INTERVAL\"({job_id}, {}); COMMIT;", text(&expression)))?,
            effect: NativeJobStepEffect::DamengLegacyInterval { expected_seconds },
        });
    }
    if let Some(expected) = date {
        setters.push(NativeJobSqlStep {
            id: "legacy_next_date".into(),
            label: "native_job_step_attribute".into(),
            sql: guard(&format!(
                "DBMS_JOB.NEXT_DATE({job_id}, CAST(TIMESTAMP {} AS DATETIME(6))); COMMIT;",
                text(&expected)
            ))?,
            effect: NativeJobStepEffect::DamengLegacyNextDate { expected },
        });
    }
    plan.steps.splice(at..at, setters);
    plan.required_partitions.extend(["legacyDefinition", "steps", "schedules"].map(str::to_string));
    Ok(())
}

fn native_metadata_changes(
    request: &NativeJobMutation,
    details: &NativeJobDetails,
    attributes: &[NativeJobAttributeChange],
    plan: &mut NativeJobSqlPlan,
) -> Result<(), &'static str> {
    let row = definition(details)?;
    let name = target_name(NativeJobCatalogDialect::Dameng, &request.target, details)?;
    let changes = metadata_patches(attributes)?;
    if changes.is_empty() {
        return Ok(());
    }
    let enabled = flag(&desired(row, &changes, "ENABLE")?)?;
    let basic = changes.keys().any(|key| !matches!(key.as_str(), "ENABLE" | "EP_SEQNO" | "RAFT_NAME"));
    let mut configuration = NativeJobDamengConfigPlan { operators: Vec::new() };
    let guard = |calls: &str| guarded_call(&request.target, details, calls);
    let mut steps = vec![NativeJobSqlStep {
        id: "pause".into(),
        label: "native_job_step_pause_scheduling".into(),
        sql: guard(&format!("SP_ENABLE_JOB({}, 0);", text(&name)))?,
        effect: NativeJobStepEffect::Enabled(false),
    }];
    if basic {
        let (calls, fields, operators) = basic_definition(row, &changes, &name, "SP_ALTER_JOB")?;
        steps.push(NativeJobSqlStep {
            id: "definition".into(),
            label: "native_job_step_definition".into(),
            sql: guard(&calls)?,
            effect: NativeJobStepEffect::DamengDefinition(fields),
        });
        configuration.operators = operators;
    }
    steps.push(NativeJobSqlStep {
        id: "config_start".into(),
        label: "native_job_step_config_start".into(),
        sql: guard(&format!("SP_JOB_CONFIG_START({});", text(&name)))?,
        effect: NativeJobStepEffect::DamengConfigurationStarted,
    });
    for key in ["EP_SEQNO", "RAFT_NAME"] {
        if !changes.contains_key(key) {
            continue;
        }
        current(row, key)?;
        let value = desired(row, &changes, key)?;
        steps.push(NativeJobSqlStep {
            id: format!("attribute:{key}"),
            label: "native_job_step_attribute".into(),
            sql: guard(&node_call(&name, key, &value)?)?,
            effect: NativeJobStepEffect::Fields(vec![NativeJobAttributeChange {
                name: key.into(),
                change: NativeJobFieldChange::Set { value },
            }]),
        });
    }
    steps.push(NativeJobSqlStep {
        id: "config_commit".into(),
        label: "native_job_step_config_commit".into(),
        sql: guard(&format!("SP_JOB_CONFIG_COMMIT({});", text(&name)))?,
        effect: NativeJobStepEffect::DamengConfigurationCommitted,
    });
    if enabled {
        steps.push(NativeJobSqlStep {
            id: "enable".into(),
            label: "native_job_step_enable".into(),
            sql: guard(&format!("SP_ENABLE_JOB({}, 1);", text(&name)))?,
            effect: NativeJobStepEffect::Enabled(true),
        });
    }
    plan.steps = steps;
    plan.required_partitions.push("definition".into());
    plan.dameng_configuration = Some(configuration);
    Ok(())
}

fn metadata_patches(
    attributes: &[NativeJobAttributeChange],
) -> Result<BTreeMap<String, NativeJobFieldChange>, &'static str> {
    let mut changes = BTreeMap::new();
    for attribute in attributes.iter().filter(|attribute| attribute.change != NativeJobFieldChange::Keep) {
        let key = attribute.name.to_ascii_uppercase();
        if !matches!(
            key.as_str(),
            "ENABLE"
                | "DESCRIBE"
                | "ENABLE_EMAIL"
                | "EMAIL_OPERATOR_NAME"
                | "EMAIL_TYPE"
                | "ENABLE_NETSEND"
                | "NETSEND_OPERATOR_NAME"
                | "NETSEND_TYPE"
                | "EP_SEQNO"
                | "RAFT_NAME"
        ) {
            return Err("native_job_attribute_not_editable");
        }
        if changes.insert(key, attribute.change.clone()).is_some() {
            return Err("native_job_duplicate_attribute");
        }
    }
    Ok(changes)
}

fn basic_definition(
    row: &NativeJobRow,
    changes: &BTreeMap<String, NativeJobFieldChange>,
    name: &str,
    procedure: &str,
) -> Result<(String, Vec<NativeJobAttributeChange>, Vec<NativeJobDamengOperator>), &'static str> {
    let email = flag(&desired(row, changes, "ENABLE_EMAIL")?)?;
    let netsend = flag(&desired(row, changes, "ENABLE_NETSEND")?)?;
    let email_type = desired(row, changes, "EMAIL_TYPE")?;
    let netsend_type = desired(row, changes, "NETSEND_TYPE")?;
    if !(0..=2).contains(&integer(&email_type)?) || !(0..=2).contains(&integer(&netsend_type)?) {
        return Err("native_job_attribute_value_invalid");
    }
    let email_operator = operator(row, changes, "EMAIL_OPERATOR_NAME", "EMAIL_OPERID")?;
    let netsend_operator = operator(row, changes, "NETSEND_OPERATOR_NAME", "NETSEND_OPERID")?;
    if (email && matches!(email_operator.selector, NativeJobDamengOperatorSelector::Unassigned))
        || (netsend && matches!(netsend_operator.selector, NativeJobDamengOperatorSelector::Unassigned))
    {
        return Err("native_job_notification_operator_required");
    }
    let description = desired(row, changes, "DESCRIBE")?;
    let (email_lookup, email_name) = operator_sql(&email_operator, "dbx_email_operator");
    let (netsend_lookup, netsend_name) = operator_sql(&netsend_operator, "dbx_netsend_operator");
    let calls = format!(
        "{email_lookup}{netsend_lookup}{procedure}({}, 0, {}, {email_name}, {}, {}, {netsend_name}, {}, {});",
        text(name),
        u8::from(email),
        integer(&email_type)?,
        u8::from(netsend),
        integer(&netsend_type)?,
        scalar(&description)?
    );
    let fields = [
        ("ENABLE_EMAIL", Value::Bool(email)),
        ("EMAIL_TYPE", email_type),
        ("ENABLE_NETSEND", Value::Bool(netsend)),
        ("NETSEND_TYPE", netsend_type),
        ("DESCRIBE", description),
    ]
    .into_iter()
    .map(|(name, value)| NativeJobAttributeChange { name: name.into(), change: NativeJobFieldChange::Set { value } })
    .collect();
    Ok((calls, fields, vec![email_operator, netsend_operator]))
}

fn node_call(name: &str, key: &str, value: &Value) -> Result<String, &'static str> {
    let (procedure, value_sql) = if key == "EP_SEQNO" {
        let value = integer(value)?;
        if !(0..=15).contains(&value) {
            return Err("native_job_attribute_value_invalid");
        }
        ("SP_JOB_SET_EP_SEQNO", value.to_string())
    } else {
        ("SP_JOB_SET_RAFT_NAME", scalar(value)?)
    };
    Ok(format!("{procedure}({}, {value_sql});", text(name)))
}

pub(super) fn configuration_changes(
    request: &NativeJobMutation,
    details: &NativeJobDetails,
    configuration: &NativeJobDamengConfiguration,
    plan: &mut NativeJobSqlPlan,
) -> Result<(), &'static str> {
    let mut children = parts::part_steps(NativeJobDamengPart::Steps, &configuration.steps, &request.target, details)?;
    let schedules =
        parts::part_steps(NativeJobDamengPart::Schedules, &configuration.schedules, &request.target, details)?;
    let has_steps = !children.is_empty();
    let has_schedules = !schedules.is_empty();
    children.extend(schedules);
    let mut attributes = configuration.attributes.clone();
    if attributes.iter().all(|attribute| attribute.change == NativeJobFieldChange::Keep) {
        if children.is_empty() {
            return Ok(());
        }
        attributes.push(NativeJobAttributeChange {
            name: "ENABLE".into(),
            change: NativeJobFieldChange::Set { value: current(definition(details)?, "ENABLE")?.clone() },
        });
    }
    metadata_changes(request, details, &attributes, plan)?;
    let commit = plan
        .steps
        .iter()
        .position(|step| matches!(step.effect, NativeJobStepEffect::DamengConfigurationCommitted))
        .expect("configuration commit");
    plan.steps.splice(commit..commit, children);
    if has_steps {
        plan.required_partitions.push("steps".into());
    }
    if has_schedules {
        plan.required_partitions.push("schedules".into());
    }
    Ok(())
}
