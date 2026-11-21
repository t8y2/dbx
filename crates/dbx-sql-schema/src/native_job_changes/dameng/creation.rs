use super::*;

#[derive(Clone)]
pub struct NativeJobDamengCreatePlan {
    pub steps: Vec<NativeJobSqlStep>,
    pub configuration: NativeJobDamengConfigPlan,
    pub definition_fields: Vec<NativeJobAttributeChange>,
    pub remaining: NativeJobDamengConfiguration,
}

/// Name lookup is only for absence checks and an acknowledged CREATE receipt, never OUT-ID guessing.
pub fn native_job_dameng_name_queries(name: &str) -> Result<Vec<NativeJobCatalogQuery>, &'static str> {
    parts::valid_name(name).map_err(|_| "native_job_name_invalid")?;
    Ok([
        ("SYSJOB.SYSJOBS", NativeJobCatalogCoverage::Database),
        ("SYSJOB.USER_JOBS_VIEW", NativeJobCatalogCoverage::CurrentUser),
    ]
    .into_iter()
    .map(|(source, coverage)| NativeJobCatalogQuery {
        source,
        coverage,
        sql: format!(
            "SELECT CAST(ID AS VARCHAR(40)) AS DBX_JOB_ID, NAME, USERNAME FROM {source} WHERE UPPER(NAME) = UPPER({})",
            text(name)
        ),
        limit: 1,
    })
    .collect())
}

/// No fabricated target or generation enters the preview. Apply rebuilds configuration guards after
/// the disabled CREATE is acknowledged and its exact native identity is read on the owned session.
pub fn native_job_dameng_create_plan(
    definition: &NativeJobDamengCreate,
) -> Result<NativeJobDamengCreatePlan, &'static str> {
    parts::valid_name(&definition.name).map_err(|_| "native_job_name_invalid")?;
    let changes = metadata_patches(&definition.configuration.attributes)?;
    if changes.contains_key("ENABLE") {
        return Err("native_job_duplicate_attribute");
    }
    let defaults: NativeJobRow = serde_json::from_value(serde_json::json!({
        "ENABLE_EMAIL":0, "EMAIL_OPERID":-1, "EMAIL_TYPE":0,
        "ENABLE_NETSEND":0, "NETSEND_OPERID":-1, "NETSEND_TYPE":0, "DESCRIBE":""
    }))
    .expect("native job creation defaults");
    let (call, definition_fields, operators) =
        basic_definition(&defaults, &changes, &definition.name, "SP_CREATE_JOB")?;
    let mut steps = vec![NativeJobSqlStep {
        id: "create".into(),
        label: "native_job_step_create_disabled".into(),
        sql: format!("DECLARE dbx_email_operator VARCHAR(128); dbx_netsend_operator VARCHAR(128); BEGIN {call} END;"),
        effect: NativeJobStepEffect::Created,
    }];
    let mut push = |id: &str, label: &str, call: String, effect| {
        steps.push(NativeJobSqlStep { id: id.into(), label: label.into(), sql: format!("BEGIN {call} END;"), effect })
    };
    push(
        "pause",
        "native_job_step_pause_scheduling",
        format!("SP_ENABLE_JOB({}, 0);", text(&definition.name)),
        NativeJobStepEffect::Enabled(false),
    );
    push(
        "config_start",
        "native_job_step_config_start",
        format!("SP_JOB_CONFIG_START({});", text(&definition.name)),
        NativeJobStepEffect::DamengConfigurationStarted,
    );
    let mut remaining = NativeJobDamengConfiguration {
        attributes: vec![NativeJobAttributeChange {
            name: "ENABLE".into(),
            change: NativeJobFieldChange::Set { value: Value::Bool(definition.enabled) },
        }],
        steps: definition.configuration.steps.clone(),
        schedules: definition.configuration.schedules.clone(),
    };
    for key in ["EP_SEQNO", "RAFT_NAME"] {
        let Some(change) = changes.get(key) else { continue };
        let value = match change {
            NativeJobFieldChange::Set { value } => value.clone(),
            NativeJobFieldChange::Clear => Value::Null,
            NativeJobFieldChange::Keep => unreachable!(),
        };
        let attribute =
            NativeJobAttributeChange { name: key.into(), change: NativeJobFieldChange::Set { value: value.clone() } };
        push(
            &format!("attribute:{key}"),
            "native_job_step_attribute",
            node_call(&definition.name, key, &value)?,
            NativeJobStepEffect::Fields(vec![attribute.clone()]),
        );
        remaining.attributes.push(attribute);
    }
    steps.extend(parts::new_part_steps(NativeJobDamengPart::Steps, &definition.configuration.steps, &definition.name)?);
    steps.extend(parts::new_part_steps(
        NativeJobDamengPart::Schedules,
        &definition.configuration.schedules,
        &definition.name,
    )?);
    steps.push(NativeJobSqlStep {
        id: "config_commit".into(),
        label: "native_job_step_config_commit".into(),
        sql: format!("BEGIN SP_JOB_CONFIG_COMMIT({}); END;", text(&definition.name)),
        effect: NativeJobStepEffect::DamengConfigurationCommitted,
    });
    if definition.enabled {
        steps.push(NativeJobSqlStep {
            id: "enable".into(),
            label: "native_job_step_enable".into(),
            sql: format!("BEGIN SP_ENABLE_JOB({}, 1); END;", text(&definition.name)),
            effect: NativeJobStepEffect::Enabled(true),
        });
    }
    Ok(NativeJobDamengCreatePlan {
        steps,
        configuration: NativeJobDamengConfigPlan { operators },
        definition_fields,
        remaining,
    })
}
