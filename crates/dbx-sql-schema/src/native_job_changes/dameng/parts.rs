use super::*;
use std::borrow::Cow;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum NativeJobDamengPart {
    Steps,
    Schedules,
}

impl NativeJobDamengPart {
    pub fn key(self) -> &'static str {
        match self {
            Self::Steps => "steps",
            Self::Schedules => "schedules",
        }
    }
    fn singular(self) -> &'static str {
        match self {
            Self::Steps => "STEP",
            Self::Schedules => "SCHEDULE",
        }
    }
    fn source(self, details: &NativeJobDetails) -> Result<&'static str, &'static str> {
        match (self, details.sources.get(self.key()).and_then(|source| source.source.as_deref())) {
            (Self::Steps, Some("SYSJOB.SYSJOBSTEPS")) => Ok("SYSJOB.SYSJOBSTEPS"),
            (Self::Steps, Some("SYSJOB.USER_JOBSTEPS_VIEW")) => Ok("SYSJOB.USER_JOBSTEPS_VIEW"),
            (Self::Schedules, Some("SYSJOB.SYSJOBSCHEDULES")) => Ok("SYSJOB.SYSJOBSCHEDULES"),
            (Self::Schedules, Some("SYSJOB.USER_JOBSCHEDULES_VIEW")) => Ok("SYSJOB.USER_JOBSCHEDULES_VIEW"),
            _ => Err("native_job_catalog_source_unverified"),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub enum NativeJobDamengChildAction {
    Added,
    Changed,
    Dropped,
    Renamed(String),
}

#[derive(Clone)]
pub struct NativeJobDamengChildReference {
    pub name: String,
    pub native_id: Option<String>,
}

#[derive(Clone)]
pub struct NativeJobDamengChildEffect {
    pub part: NativeJobDamengPart,
    pub action: NativeJobDamengChildAction,
    pub name: String,
    pub native_id: Option<String>,
    pub fields: NativeJobRow,
    pub acknowledged_fields: Vec<String>,
    pub references: Vec<NativeJobDamengChildReference>,
    pub requires_acknowledgement: bool,
    native_call: String,
}

pub fn native_job_dameng_child_key(part: NativeJobDamengPart, name: &str) -> String {
    format!("{}:{}", part.key(), name.to_ascii_uppercase())
}

pub fn native_job_dameng_catalog_id(value: &Value) -> Option<String> {
    let id = match value {
        Value::Number(value) => value.as_u64().filter(|value| *value > 0)?.to_string(),
        Value::String(value)
            if !value.is_empty() && !value.starts_with('0') && value.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            value.clone()
        }
        _ => return None,
    };
    Some(id)
}

pub fn native_job_dameng_child_id(row: &NativeJobRow) -> Option<String> {
    native_job_dameng_catalog_id(row.get("ID")?)
}

fn name_key(name: &str) -> String {
    name.to_ascii_uppercase()
}

pub(super) fn valid_name(name: &str) -> Result<(), &'static str> {
    if name.is_empty()
        || name.len() > 128
        || name.as_bytes()[0].is_ascii_digit()
        || !name.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'$'))
    {
        return Err("native_job_child_name_invalid");
    }
    Ok(())
}

fn row_name(row: &NativeJobRow) -> Result<&str, &'static str> {
    row.get("NAME").and_then(Value::as_str).filter(|name| !name.is_empty()).ok_or("native_job_metadata_incomplete")
}

fn links(row: &NativeJobRow, key: &str) -> Result<Option<String>, &'static str> {
    match current(row, key)? {
        Value::Null => Ok(None),
        Value::String(value) if value.is_empty() => Ok(None),
        Value::String(value) if !value.contains('\0') => Ok(Some(value.clone())),
        _ => Err("native_job_attribute_type_invalid"),
    }
}

fn patches(
    attributes: &[NativeJobAttributeChange],
    part: NativeJobDamengPart,
) -> Result<BTreeMap<String, NativeJobFieldChange>, &'static str> {
    let allowed: &[&str] = match part {
        NativeJobDamengPart::Steps => &[
            "NAME",
            "TYPE",
            "COMMAND_INPUT",
            "SUCC_ACTION",
            "FAIL_ACTION",
            "RETRY_ATTEMPTS",
            "RETRY_INTERVAL",
            "OUTPUT_FILE_PATH",
            "APPEND_FLAG",
            "DESCRIBE",
            "SUCC_NEXT_STEP",
            "FAIL_NEXT_STEP",
        ],
        NativeJobDamengPart::Schedules => &[
            "NAME",
            "ENABLE",
            "TYPE",
            "FREQ_INTERVAL",
            "FREQ_SUB_INTERVAL",
            "FREQ_MINUTE_INTERVAL",
            "STARTTIME",
            "ENDTIME",
            "DURING_START_DATE",
            "DURING_END_DATE",
            "DESCRIBE",
        ],
    };
    let mut result = BTreeMap::new();
    for attribute in attributes.iter().filter(|attribute| attribute.change != NativeJobFieldChange::Keep) {
        let key = attribute.name.to_ascii_uppercase();
        if !allowed.contains(&key.as_str()) {
            return Err("native_job_attribute_not_editable");
        }
        if result.insert(key, attribute.change.clone()).is_some() {
            return Err("native_job_duplicate_attribute");
        }
    }
    Ok(result)
}

fn defaults(part: NativeJobDamengPart, name: &str) -> NativeJobRow {
    let value = match part {
        NativeJobDamengPart::Steps => {
            serde_json::json!({"NAME":name,"TYPE":0,"SUCC_ACTION":1,"FAIL_ACTION":1,"RETRY_ATTEMPTS":0,"RETRY_INTERVAL":0,"OUTPUT_FILE_PATH":null,"APPEND_FLAG":0,"DESCRIBE":null,"SUCC_NEXT_STEP":null,"FAIL_NEXT_STEP":null})
        }
        NativeJobDamengPart::Schedules => {
            serde_json::json!({"NAME":name,"ENABLE":1,"TYPE":1,"FREQ_INTERVAL":1,"FREQ_SUB_INTERVAL":0,"FREQ_MINUTE_INTERVAL":0,"STARTTIME":"00:00:00","ENDTIME":null,"DURING_START_DATE":"CURDATE","DURING_END_DATE":null,"DESCRIBE":null})
        }
    };
    serde_json::from_value(value).expect("native child defaults")
}

struct Entry<'a> {
    original: Option<&'a NativeJobRow>,
    original_name: String,
    name: String,
    id: Option<String>,
    row: Cow<'a, NativeJobRow>,
    patch: BTreeMap<String, NativeJobFieldChange>,
    added: bool,
    dropped: bool,
}

fn entries<'a>(
    part: NativeJobDamengPart,
    details: &'a NativeJobDetails,
    changes: &[NativeJobDamengChildChange],
    target: &NativeJobRef,
) -> Result<Vec<Entry<'a>>, &'static str> {
    let data = match part {
        NativeJobDamengPart::Steps => &details.steps,
        NativeJobDamengPart::Schedules => &details.schedules,
    };
    let rows = match data {
        NativeJobMetadata::Available { value } => value.as_slice(),
        NativeJobMetadata::Empty => &[],
        _ => return Err("native_job_metadata_incomplete"),
    };
    part.source(details)?;
    let parent = match target {
        NativeJobRef::DamengNative { job_id, .. } | NativeJobRef::Legacy { job_id, .. } => job_id,
        _ => return Err("native_job_kind_invalid"),
    };
    let mut names = HashSet::new();
    let mut ids = HashSet::new();
    let mut result = Vec::new();
    for row in rows {
        let name = row_name(row)?;
        let id = native_job_dameng_child_id(row).ok_or("native_job_child_identity_unverified")?;
        if row.get("JOBID").and_then(native_job_dameng_catalog_id).as_ref() != Some(parent) {
            return Err("native_job_child_identity_unverified");
        }
        if !names.insert(name_key(name)) || !ids.insert(id.clone()) {
            return Err("native_job_child_identity_ambiguous");
        }
        result.push(Entry {
            original: Some(row),
            original_name: name.into(),
            name: name.into(),
            id: Some(id),
            row: Cow::Borrowed(row),
            patch: BTreeMap::new(),
            added: false,
            dropped: false,
        });
    }
    apply_changes(part, result, changes)
}

fn apply_changes<'a>(
    part: NativeJobDamengPart,
    mut result: Vec<Entry<'a>>,
    changes: &[NativeJobDamengChildChange],
) -> Result<Vec<Entry<'a>>, &'static str> {
    let names = result.iter().map(|entry| name_key(&entry.original_name)).collect::<HashSet<_>>();
    let original_indices = result
        .iter()
        .enumerate()
        .map(|(index, entry)| (name_key(&entry.original_name), index))
        .collect::<BTreeMap<_, _>>();
    let mut changed = HashSet::new();
    for change in changes {
        let (name, attributes, add, drop) = match change {
            NativeJobDamengChildChange::Add { name, attributes } => (name, attributes.as_slice(), true, false),
            NativeJobDamengChildChange::Update { name, attributes } => (name, attributes.as_slice(), false, false),
            NativeJobDamengChildChange::Drop { name } => (name, &[][..], false, true),
        };
        if name.is_empty() || name.contains('\0') {
            return Err("native_job_child_name_invalid");
        }
        if !changed.insert(name_key(name)) {
            return Err("native_job_duplicate_child_change");
        }
        let patch = patches(attributes, part)?;
        if add {
            valid_name(name)?;
            if patch.contains_key("NAME") {
                return Err("native_job_duplicate_attribute");
            }
            // A drop/add of the same native name is a replacement, not a lossless edit.
            if names.contains(&name_key(name)) {
                return Err("native_job_child_name_collision");
            }
            result.push(Entry {
                original: None,
                original_name: name.clone(),
                name: name.clone(),
                id: None,
                row: Cow::Owned(defaults(part, name)),
                patch,
                added: true,
                dropped: false,
            });
        } else {
            let index = *original_indices.get(&name_key(name)).ok_or("native_job_child_missing")?;
            let entry = &mut result[index];
            if part == NativeJobDamengPart::Schedules && integer(current(&entry.row, "TYPE")?)? == 9 {
                return Err("native_job_legacy_schedule_requires_dbms_job");
            }
            entry.patch = patch;
            entry.dropped = drop;
        }
    }
    for entry in &mut result {
        if entry.dropped {
            continue;
        }
        for (key, change) in &entry.patch {
            if matches!(key.as_str(), "NAME" | "COMMAND_INPUT") {
                continue;
            }
            let value = match change {
                NativeJobFieldChange::Set { value } => value.clone(),
                NativeJobFieldChange::Clear => Value::Null,
                NativeJobFieldChange::Keep => unreachable!(),
            };
            entry.row.to_mut().insert(key.clone(), value);
        }
        if let Some(change) = entry.patch.get("NAME") {
            let NativeJobFieldChange::Set { value: Value::String(name) } = change else {
                return Err("native_job_child_name_invalid");
            };
            valid_name(name)?;
            if name_key(name) == name_key(&entry.name) {
                return Err("native_job_child_name_case_unchanged");
            }
            entry.name = name.clone();
        }
    }
    let mut final_names = HashSet::new();
    for entry in result.iter().filter(|entry| !entry.dropped) {
        if !final_names.insert(name_key(&entry.name)) {
            return Err("native_job_child_name_collision");
        }
    }
    Ok(result)
}

fn effect(
    part: NativeJobDamengPart,
    entry: &Entry<'_>,
    action: NativeJobDamengChildAction,
    fields: NativeJobRow,
    call: String,
) -> NativeJobDamengChildEffect {
    let requires_acknowledgement = action == NativeJobDamengChildAction::Added;
    NativeJobDamengChildEffect {
        part,
        action,
        name: entry.name.clone(),
        native_id: entry.id.clone(),
        fields,
        acknowledged_fields: Vec::new(),
        references: Vec::new(),
        requires_acknowledgement,
        native_call: call,
    }
}

struct ChildPlanContext<'a> {
    job: &'a str,
    existing: Option<(&'a NativeJobRef, &'a NativeJobDetails)>,
}

fn make_step(
    context: &ChildPlanContext<'_>,
    effect: NativeJobDamengChildEffect,
    index: usize,
) -> Result<NativeJobSqlStep, &'static str> {
    let action = match effect.action {
        NativeJobDamengChildAction::Added => "add",
        NativeJobDamengChildAction::Dropped => "drop",
        NativeJobDamengChildAction::Renamed(_) => "rename",
        NativeJobDamengChildAction::Changed => "edit",
    };
    let id = format!("{}:{action}:{index}", effect.part.key());
    let sql = match context.existing {
        Some((target, details)) => render_child_call(target, details, &effect)?,
        // Preview for an absent job. Apply rebuilds guards from its acknowledged native identity.
        None => format!("BEGIN {} END;", effect.native_call),
    };
    Ok(NativeJobSqlStep {
        id,
        label: format!("native_job_step_{}_{}", effect.part.key(), action),
        sql,
        effect: NativeJobStepEffect::DamengChild(effect),
    })
}

fn rename_steps(
    part: NativeJobDamengPart,
    entries: &[Entry<'_>],
    context: &ChildPlanContext<'_>,
    output: &mut Vec<NativeJobSqlStep>,
) -> Result<(), &'static str> {
    let job = context.job;
    let mut current =
        entries.iter().filter(|entry| !entry.added).map(|entry| name_key(&entry.original_name)).collect::<HashSet<_>>();
    let mut remaining = entries
        .iter()
        .filter(|entry| !entry.added && !entry.dropped && entry.name != entry.original_name)
        .collect::<Vec<_>>();
    while !remaining.is_empty() {
        let index = remaining
            .iter()
            .position(|entry| !current.contains(&name_key(&entry.name)))
            .ok_or("native_job_child_rename_requires_correction")?;
        let entry = remaining.remove(index);
        if part == NativeJobDamengPart::Schedules && job.len() + entry.name.len() >= 253 {
            return Err("native_job_child_name_invalid");
        }
        let call = format!(
            "SP_RENAME_JOB_{}({}, {}, {});",
            part.singular(),
            text(job),
            text(&entry.original_name),
            text(&entry.name)
        );
        let mut change =
            effect(part, entry, NativeJobDamengChildAction::Renamed(entry.name.clone()), NativeJobRow::new(), call);
        change.name = entry.original_name.clone();
        output.push(make_step(context, change, output.len())?);
        current.remove(&name_key(&entry.original_name));
        current.insert(name_key(&entry.name));
    }
    Ok(())
}

fn step_definition(entry: &Entry<'_>, job: &str) -> Result<(NativeJobRow, Vec<String>, String), &'static str> {
    let row = &entry.row;
    let kind = integer(current(row, "TYPE")?)?;
    if !(0..=6).contains(&kind) {
        return Err("native_job_attribute_value_invalid");
    }
    let command = match entry.patch.get("COMMAND_INPUT") {
        Some(NativeJobFieldChange::Set { value: Value::String(value) }) if !value.contains('\0') => {
            Value::String(value.clone())
        }
        Some(NativeJobFieldChange::Clear) => Value::Null,
        Some(_) => return Err("native_job_attribute_type_invalid"),
        None if kind == 0
            && entry.original.is_some_and(|row| row.get("TYPE").and_then(|value| integer(value).ok()) == Some(0)) =>
        {
            current(row, "COMMAND")?.clone()
        }
        None if matches!(kind, 2 | 3) => Value::Null,
        None => return Err("native_job_step_command_input_required"),
    };
    if matches!(kind, 2 | 3) && command.as_str().is_some_and(|value| !value.is_empty()) {
        return Err("native_job_step_command_not_applicable");
    }
    if !matches!(kind, 2 | 3) && !command.as_str().is_some_and(|value| !value.trim().is_empty()) {
        return Err("native_job_step_command_input_required");
    }
    if kind != 0 && command.as_str().is_some_and(|value| value.chars().count() > 3_600) {
        return Err("native_job_attribute_value_invalid");
    }
    let mut fields = NativeJobRow::new();
    for (key, min, max) in [
        ("TYPE", 0, 6),
        ("SUCC_ACTION", 0, 3),
        ("FAIL_ACTION", 0, 3),
        ("RETRY_ATTEMPTS", 0, 99_999),
        ("RETRY_INTERVAL", 0, i64::from(i32::MAX)),
    ] {
        let value = integer(current(row, key)?)?;
        if !(min..=max).contains(&value) {
            return Err("native_job_attribute_value_invalid");
        }
        fields.insert(key.into(), serde_json::json!(value));
    }
    let append = flag(current(row, "APPEND_FLAG")?)?;
    fields.insert("APPEND_FLAG".into(), Value::Bool(append));
    for key in ["OUTPUT_FILE_PATH", "DESCRIBE"] {
        scalar(current(row, key)?)?;
        fields.insert(key.into(), current(row, key)?.clone());
    }
    if kind == 0 {
        fields.insert("COMMAND".into(), command.clone());
    }
    let call = format!(
        "SP_{}_JOB_STEP_EX({}, {}, {kind}, {}, {}, {}, {}, {}, {}, {}, {});",
        if entry.added { "ADD" } else { "ALTER" },
        text(job),
        text(&entry.name),
        scalar(&command)?,
        fields["SUCC_ACTION"],
        fields["FAIL_ACTION"],
        fields["RETRY_ATTEMPTS"],
        fields["RETRY_INTERVAL"],
        scalar(&fields["OUTPUT_FILE_PATH"])?,
        u8::from(append),
        scalar(&fields["DESCRIBE"])?
    );
    Ok((fields, if kind == 0 { vec![] } else { vec!["COMMAND".into()] }, call))
}

fn calendar_sql(value: &Value, key: &str) -> Result<(String, bool), &'static str> {
    if let Some(value) = value.as_str() {
        if ((key == "DURING_START_DATE" || key == "DURING_END_DATE") && value.eq_ignore_ascii_case("CURDATE"))
            || ((key == "STARTTIME" || key == "ENDTIME") && value.eq_ignore_ascii_case("CURTIME"))
        {
            return Ok((value.to_ascii_uppercase(), true));
        }
    }
    Ok((scalar(value)?, false))
}

fn schedule_definition(entry: &Entry<'_>, job: &str) -> Result<(NativeJobRow, Vec<String>, String), &'static str> {
    let row = &entry.row;
    let kind = integer(current(row, "TYPE")?)?;
    if kind == 9 {
        return Err("native_job_legacy_schedule_requires_dbms_job");
    }
    if !(0..=8).contains(&kind) {
        return Err("native_job_attribute_value_invalid");
    }
    let interval = integer(current(row, "FREQ_INTERVAL")?)?;
    let sub = integer(current(row, "FREQ_SUB_INTERVAL")?)?;
    let minute = integer(current(row, "FREQ_MINUTE_INTERVAL")?)?;
    if interval < 0
        || interval > i64::from(i32::MAX)
        || sub < 0
        || sub > i64::from(i32::MAX)
        || !(0..=1439).contains(&minute)
        || (kind > 0 && interval == 0)
        || (kind == 1 && interval > 100)
        || (kind == 2 && !(1..=127).contains(&sub))
        || (kind == 3 && !(1..=31).contains(&sub))
        || ((4..=8).contains(&kind) && !(1..=7).contains(&sub))
    {
        return Err("native_job_attribute_value_invalid");
    }
    for key in if kind == 0 { &["DURING_START_DATE"][..] } else { &["STARTTIME", "DURING_START_DATE"][..] } {
        if !current(row, key)?.as_str().is_some_and(|value| !value.is_empty()) {
            return Err("native_job_attribute_value_invalid");
        }
    }
    let enabled = flag(current(row, "ENABLE")?)?;
    let mut fields: NativeJobRow = serde_json::from_value(serde_json::json!({"ENABLE":enabled,"TYPE":kind,"FREQ_INTERVAL":interval,"FREQ_SUB_INTERVAL":sub,"FREQ_MINUTE_INTERVAL":minute})).expect("native schedule fields");
    let mut acknowledged = Vec::new();
    let mut dates = Vec::new();
    for key in ["STARTTIME", "ENDTIME", "DURING_START_DATE", "DURING_END_DATE"] {
        let value = current(row, key)?;
        let (sql, dynamic) = calendar_sql(value, key)?;
        if dynamic {
            acknowledged.push(key.into());
        } else {
            fields.insert(key.into(), value.clone());
        }
        dates.push(sql);
    }
    fields.insert("DESCRIBE".into(), current(row, "DESCRIBE")?.clone());
    let call = format!(
        "SP_{}_JOB_SCHEDULE({}, {}, {}, {kind}, {interval}, {sub}, {minute}, {}, {}, {}, {}, {});",
        if entry.added { "ADD" } else { "ALTER" },
        text(job),
        text(&entry.name),
        u8::from(enabled),
        dates[0],
        dates[1],
        dates[2],
        dates[3],
        scalar(&fields["DESCRIBE"])?
    );
    Ok((fields, acknowledged, call))
}

pub(super) fn part_steps(
    part: NativeJobDamengPart,
    changes: &[NativeJobDamengChildChange],
    target: &NativeJobRef,
    details: &NativeJobDetails,
) -> Result<Vec<NativeJobSqlStep>, &'static str> {
    if changes.is_empty() {
        return Ok(Vec::new());
    }
    let entries = entries(part, details, changes, target)?;
    let job = target_name(NativeJobCatalogDialect::Dameng, target, details)?;
    plan_entries(part, entries, &ChildPlanContext { job: &job, existing: Some((target, details)) })
}

pub(super) fn new_part_steps(
    part: NativeJobDamengPart,
    changes: &[NativeJobDamengChildChange],
    job: &str,
) -> Result<Vec<NativeJobSqlStep>, &'static str> {
    if changes.iter().any(|change| !matches!(change, NativeJobDamengChildChange::Add { .. })) {
        return Err("native_job_creation_children_must_be_new");
    }
    let entries = apply_changes(part, Vec::new(), changes)?;
    plan_entries(part, entries, &ChildPlanContext { job, existing: None })
}

fn plan_entries(
    part: NativeJobDamengPart,
    mut entries: Vec<Entry<'_>>,
    context: &ChildPlanContext<'_>,
) -> Result<Vec<NativeJobSqlStep>, &'static str> {
    let job = context.job;
    let renames = entries
        .iter()
        .filter(|entry| !entry.added && !entry.dropped)
        .map(|entry| (name_key(&entry.original_name), entry.name.clone()))
        .collect::<BTreeMap<_, _>>();
    // Retarget existing references by original identity once, not by cascading text replacements.
    if part == NativeJobDamengPart::Steps {
        for entry in entries.iter_mut().filter(|entry| !entry.added && !entry.dropped) {
            for key in ["SUCC_NEXT_STEP", "FAIL_NEXT_STEP"] {
                if entry.patch.contains_key(key) {
                    continue;
                }
                if let Some(old) = links(&entry.row, key)? {
                    if let Some(new) = renames.get(&name_key(&old)).filter(|new| **new != old) {
                        entry.row.to_mut().insert(key.into(), Value::String(new.clone()));
                    }
                }
            }
        }
        let survivors =
            entries.iter().filter(|entry| !entry.dropped).map(|entry| name_key(&entry.name)).collect::<HashSet<_>>();
        for entry in entries.iter().filter(|entry| !entry.dropped) {
            for (action, next) in [("SUCC_ACTION", "SUCC_NEXT_STEP"), ("FAIL_ACTION", "FAIL_NEXT_STEP")] {
                let value = links(&entry.row, next)?;
                if integer(current(&entry.row, action)?)? >= 2
                    && value.as_deref().is_some_and(|name| !survivors.contains(&name_key(name)))
                {
                    return Err("native_job_step_dependency_requires_correction");
                }
                if entry.patch.contains_key(next)
                    && value.as_deref().is_some_and(|name| !survivors.contains(&name_key(name)))
                {
                    return Err("native_job_step_dependency_requires_correction");
                }
            }
        }
    }
    let mut output = Vec::new();
    rename_steps(part, &entries, context, &mut output)?;
    for entry in entries.iter().filter(|entry| !entry.dropped) {
        if part == NativeJobDamengPart::Schedules && job.len() + entry.name.len() > 253 {
            return Err("native_job_child_name_invalid");
        }
        let definition_changed = entry.added
            || entry.patch.keys().any(|key| match part {
                NativeJobDamengPart::Steps => !matches!(key.as_str(), "NAME" | "SUCC_NEXT_STEP" | "FAIL_NEXT_STEP"),
                NativeJobDamengPart::Schedules => key != "NAME",
            });
        if !definition_changed {
            continue;
        }
        let (fields, acknowledged, call) = match part {
            NativeJobDamengPart::Steps => step_definition(entry, job)?,
            NativeJobDamengPart::Schedules => schedule_definition(entry, job)?,
        };
        let mut change = effect(
            part,
            entry,
            if entry.added { NativeJobDamengChildAction::Added } else { NativeJobDamengChildAction::Changed },
            fields,
            call,
        );
        change.requires_acknowledgement |= !acknowledged.is_empty();
        change.acknowledged_fields = acknowledged;
        output.push(make_step(context, change, output.len())?);
    }
    if part == NativeJobDamengPart::Steps {
        let references = entries
            .iter()
            .filter(|entry| !entry.dropped)
            .map(|entry| {
                (
                    name_key(&entry.name),
                    NativeJobDamengChildReference { name: entry.name.clone(), native_id: entry.id.clone() },
                )
            })
            .collect::<BTreeMap<_, _>>();
        for entry in &entries {
            let mut wanted = NativeJobRow::new();
            let mut reference_names = Vec::new();
            let mut changed = entry.added;
            for key in ["SUCC_NEXT_STEP", "FAIL_NEXT_STEP"] {
                let next = if entry.dropped { None } else { links(&entry.row, key)? };
                let original = entry.original.map(|row| links(row, key)).transpose()?.flatten();
                changed |= entry.patch.contains_key(key) || next != original;
                if let Some(name) = &next {
                    reference_names.push(name.clone());
                }
                wanted.insert(key.into(), next.map_or(Value::Null, Value::String));
            }
            if !changed {
                continue;
            }
            if entry.added
                && reference_names.is_empty()
                && !entry.patch.keys().any(|key| matches!(key.as_str(), "SUCC_NEXT_STEP" | "FAIL_NEXT_STEP"))
            {
                continue;
            }
            let call = format!(
                "SP_JOB_STEP_SET_NEXT_STEP({}, {}, {}, {});",
                text(job),
                text(&entry.name),
                scalar(&wanted["SUCC_NEXT_STEP"])?,
                scalar(&wanted["FAIL_NEXT_STEP"])?
            );
            let mut change = effect(part, entry, NativeJobDamengChildAction::Changed, wanted, call);
            for name in reference_names {
                change.references.push(
                    references
                        .get(&name_key(&name))
                        .cloned()
                        .ok_or("native_job_step_dependency_requires_correction")?,
                );
            }
            output.push(make_step(context, change, output.len())?);
        }
    }
    for entry in entries.iter().filter(|entry| entry.dropped) {
        let call = format!("SP_DROP_JOB_{}({}, {});", part.singular(), text(job), text(&entry.name));
        output.push(make_step(
            context,
            effect(part, entry, NativeJobDamengChildAction::Dropped, NativeJobRow::new(), call),
            output.len(),
        )?);
    }
    Ok(output)
}

fn render_child_call(
    target: &NativeJobRef,
    details: &NativeJobDetails,
    effect: &NativeJobDamengChildEffect,
) -> Result<String, &'static str> {
    let source = effect.part.source(details)?;
    let job_id = match target {
        NativeJobRef::DamengNative { job_id, .. } | NativeJobRef::Legacy { job_id, .. } => job_id,
        _ => return Err("native_job_kind_invalid"),
    };
    let mut calls = String::new();
    let mut check = |source: &str, name: &str, id: Option<&str>, absent: bool, placeholder: &str| {
        let identity = if absent { String::new() } else { format!(" AND ID = {}", id.unwrap_or(placeholder)) };
        calls.push_str(&format!("SELECT COUNT(*) INTO dbx_target_count FROM {source} WHERE JOBID = {job_id} AND UPPER(NAME) = UPPER({}){identity}; IF dbx_target_count <> {} THEN RAISE dbx_target_changed; END IF; ", text(name), if absent { 0 } else { 1 }));
    };
    check(
        source,
        &effect.name,
        effect.native_id.as_deref(),
        effect.action == NativeJobDamengChildAction::Added,
        ":dbx_created_step_id",
    );
    if let NativeJobDamengChildAction::Renamed(name) = &effect.action {
        check(source, name, None, true, "");
    }
    for (index, reference) in effect.references.iter().enumerate() {
        check(
            source,
            &reference.name,
            reference.native_id.as_deref(),
            false,
            &format!(":dbx_created_reference_id_{index}"),
        );
    }
    calls.push_str(&effect.native_call);
    guarded_call(target, details, &calls)
}

/// Resolve only IDs captured after this operation's acknowledged adds; never replace text in a body.
pub fn resolve_native_job_dameng_child_step(
    step: &NativeJobSqlStep,
    target: &NativeJobRef,
    details: &NativeJobDetails,
    created: &BTreeMap<String, String>,
) -> Result<NativeJobSqlStep, &'static str> {
    let NativeJobStepEffect::DamengChild(effect) = &step.effect else { return Ok(step.clone()) };
    let mut effect = effect.clone();
    if effect.native_id.is_none() && effect.action != NativeJobDamengChildAction::Added {
        effect.native_id = Some(
            created
                .get(&native_job_dameng_child_key(effect.part, &effect.name))
                .cloned()
                .ok_or("native_job_child_identity_unverified")?,
        );
    }
    for reference in &mut effect.references {
        if reference.native_id.is_none() {
            reference.native_id = Some(
                created
                    .get(&native_job_dameng_child_key(NativeJobDamengPart::Steps, &reference.name))
                    .cloned()
                    .ok_or("native_job_child_identity_unverified")?,
            );
        }
    }
    let sql = render_child_call(target, details, &effect)?;
    Ok(NativeJobSqlStep {
        id: step.id.clone(),
        label: step.label.clone(),
        sql,
        effect: NativeJobStepEffect::DamengChild(effect),
    })
}
