use super::*;
use dbx_sql::native_job_changes::{
    native_job_dameng_catalog_id, native_job_dameng_child_id, NativeJobDamengChildAction, NativeJobDamengChildEffect,
    NativeJobDamengPart,
};

fn same_name(left: &str, right: &str) -> bool {
    left == right || (left.is_ascii() && right.is_ascii() && left.eq_ignore_ascii_case(right))
}

fn rows(details: &NativeJobDetails, part: NativeJobDamengPart) -> Option<&[NativeJobRow]> {
    match if part == NativeJobDamengPart::Steps { &details.steps } else { &details.schedules } {
        NativeJobMetadata::Available { value } => Some(value),
        NativeJobMetadata::Empty => Some(&[]),
        _ => None,
    }
}

fn job_id(details: &NativeJobDetails) -> Option<&str> {
    match &details.snapshot.job_ref {
        NativeJobRef::DamengNative { job_id, .. } | NativeJobRef::Legacy { job_id, .. } => Some(job_id),
        _ => None,
    }
}

fn indexed<'a>(rows: &'a [NativeJobRow], job: &str) -> Option<(Vec<String>, BTreeMap<String, &'a NativeJobRow>)> {
    let mut order = Vec::new();
    let mut result = BTreeMap::new();
    let mut names = HashSet::new();
    for row in rows {
        let id = native_job_dameng_child_id(row)?;
        let name = row.get("NAME")?.as_str()?;
        let parent = row.get("JOBID")?;
        if native_job_dameng_catalog_id(parent).as_deref() != Some(job)
            || !names.insert(name.to_ascii_uppercase())
            || result.insert(id.clone(), row).is_some()
        {
            return None;
        }
        order.push(id);
    }
    Some((order, result))
}

fn no_target(value: &Value) -> bool {
    value.is_null() || value.as_str() == Some("")
}

fn field_matches(key: &str, actual: Option<&Value>, expected: &Value) -> bool {
    if matches!(key, "SUCC_NEXT_STEP" | "FAIL_NEXT_STEP") {
        return actual.is_some_and(|actual| {
            (no_target(actual) && no_target(expected))
                || actual.as_str().zip(expected.as_str()).is_some_and(|(actual, expected)| same_name(actual, expected))
        });
    }
    values::field_matches(key, actual, expected)
}

fn readable_native_value(key: &str, value: Option<&Value>) -> bool {
    let Some(value) = value.and_then(Value::as_str).filter(|value| !value.is_empty()) else { return false };
    match key {
        "STARTTIME" | "ENDTIME" => chrono::NaiveTime::parse_from_str(value, "%H:%M:%S%.f").is_ok(),
        "DURING_START_DATE" | "DURING_END_DATE" => {
            chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
                || chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.f").is_ok()
        }
        "COMMAND" => true,
        _ => false,
    }
}

fn row_preserved(
    before: &NativeJobRow,
    after: &NativeJobRow,
    effect: &NativeJobDamengChildEffect,
    selected: bool,
) -> bool {
    let ignored = |key: &str| {
        (selected
            && (effect.fields.contains_key(key)
                || effect.acknowledged_fields.iter().any(|field| field == key)
                || (key == "NAME" && matches!(effect.action, NativeJobDamengChildAction::Renamed(_)))))
            || (effect.part == NativeJobDamengPart::Schedules && matches!(key, "VALID" | "SCHNAME" | "TRIGNAME"))
            || (effect.part == NativeJobDamengPart::Steps
                && key == "SEQNO"
                && matches!(effect.action, NativeJobDamengChildAction::Added | NativeJobDamengChildAction::Dropped))
    };
    let allowed_rename = |key: &str, old: &Value, new: &Value| {
        if effect.part != NativeJobDamengPart::Steps || !matches!(key, "SUCC_NEXT_STEP" | "FAIL_NEXT_STEP") {
            return false;
        }
        let NativeJobDamengChildAction::Renamed(name) = &effect.action else { return false };
        old.as_str().is_some_and(|old| same_name(old, &effect.name))
            && new.as_str().is_some_and(|new| same_name(new, name))
    };
    before.iter().all(|(key, value)| {
        ignored(key) || after.get(key).is_some_and(|actual| actual == value || allowed_rename(key, value, actual))
    }) && after.keys().all(|key| ignored(key) || before.contains_key(key))
}

pub(super) fn verify(
    before: &NativeJobDetails,
    after: &NativeJobDetails,
    effect: &NativeJobDamengChildEffect,
    user: &str,
) -> bool {
    let (Some(before_rows), Some(after_rows), Some(job)) =
        (rows(before, effect.part), rows(after, effect.part), job_id(before))
    else {
        return false;
    };
    let (Some((before_order, before_rows)), Some((after_order, after_rows))) =
        (indexed(before_rows, job), indexed(after_rows, job))
    else {
        return false;
    };
    let added = effect.action == NativeJobDamengChildAction::Added;
    let dropped = effect.action == NativeJobDamengChildAction::Dropped;
    let selected_before = effect.native_id.as_ref().and_then(|id| before_rows.get(id).copied());
    if !added
        && !selected_before.is_some_and(|row| {
            row.get("NAME").and_then(Value::as_str).is_some_and(|name| same_name(name, &effect.name))
        })
    {
        return false;
    }
    if added
        && before_rows
            .values()
            .any(|row| row.get("NAME").and_then(Value::as_str).is_some_and(|name| same_name(name, &effect.name)))
    {
        return false;
    }
    let selected_after = if added {
        let found = after_rows
            .iter()
            .filter(|(_, row)| {
                row.get("NAME").and_then(Value::as_str).is_some_and(|name| same_name(name, &effect.name))
            })
            .collect::<Vec<_>>();
        if found.len() != 1 || before_rows.contains_key(found[0].0) {
            return false;
        }
        Some((found[0].0, *found[0].1))
    } else {
        effect.native_id.as_ref().and_then(|id| after_rows.get_key_value(id).map(|(id, row)| (id, *row)))
    };
    if dropped {
        let own = super::row(before).is_some_and(|row| row.get("USERNAME").and_then(Value::as_str) == Some(user));
        let visible = after.sources.get(effect.part.key()).is_some_and(|source| {
            source.coverage == Some(NativeJobCatalogCoverage::Database)
                || (own && source.coverage == Some(NativeJobCatalogCoverage::CurrentUser))
        });
        if !visible || selected_after.is_some() || after_rows.len() + 1 != before_rows.len() {
            return false;
        }
    } else {
        let Some((_, selected)) = selected_after else { return false };
        let name = match &effect.action {
            NativeJobDamengChildAction::Renamed(name) => name,
            _ => &effect.name,
        };
        if !selected.get("NAME").and_then(Value::as_str).is_some_and(|actual| same_name(actual, name))
            || !effect.fields.iter().all(|(key, expected)| field_matches(key, selected.get(key), expected))
            || !effect.acknowledged_fields.iter().all(|key| readable_native_value(key, selected.get(key)))
        {
            return false;
        }
        if added && after_rows.len() != before_rows.len() + 1 {
            return false;
        }
        if !added && after_rows.len() != before_rows.len() {
            return false;
        }
    }
    if !before_rows.iter().all(|(id, row)| {
        if dropped && effect.native_id.as_ref() == Some(id) {
            return true;
        }
        after_rows.get(id).is_some_and(|after| row_preserved(row, after, effect, effect.native_id.as_ref() == Some(id)))
    }) {
        return false;
    }
    let kept_before =
        before_order.iter().filter(|id| !dropped || effect.native_id.as_ref() != Some(*id)).collect::<Vec<_>>();
    let kept_after = after_order.iter().filter(|id| before_rows.contains_key(*id)).collect::<Vec<_>>();
    // Native step deletion may renumber SEQNO; the surviving execution order must not change.
    effect.part != NativeJobDamengPart::Steps || kept_before == kept_after
}

pub(super) fn created_id(after: &NativeJobDetails, effect: &NativeJobDamengChildEffect) -> Option<String> {
    rows(after, effect.part)?
        .iter()
        .find(|row| row.get("NAME").and_then(Value::as_str).is_some_and(|name| same_name(name, &effect.name)))
        .and_then(native_job_dameng_child_id)
}
