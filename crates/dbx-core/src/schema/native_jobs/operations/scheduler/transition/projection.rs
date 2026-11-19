use super::*;
use crate::schema::native_jobs::details::file_watcher_reference_present as watcher;

const EVENT_COLUMNS: &[&str] = &[
    "EVENT_CONDITION",
    "EVENT_QUEUE_OWNER",
    "EVENT_QUEUE_NAME",
    "EVENT_QUEUE_AGENT",
    "FILE_WATCHER_OWNER",
    "FILE_WATCHER_NAME",
];
const QUEUE_COLUMNS: &[&str] = &["EVENT_QUEUE_OWNER", "EVENT_QUEUE_NAME", "EVENT_QUEUE_AGENT"];

#[derive(Clone)]
enum EventProjection {
    Preserve,
    None,
    Queue(NativeJobRow),
    Watcher(NativeJobRow),
    Named { fields: NativeJobRow, watcher: bool },
}

pub(in crate::schema::native_jobs::operations::scheduler) struct OracleSchedulerProjection {
    before: EventProjection,
    target: EventProjection,
}

fn event_fields(row: &NativeJobRow) -> Result<NativeJobRow, &'static str> {
    EVENT_COLUMNS
        .iter()
        .map(|name| {
            let value = row.get(*name).ok_or("native_job_event_projection_unavailable")?;
            if !value.is_null() && !value.is_string() {
                return Err("native_job_event_projection_invalid");
            }
            Ok(((*name).to_string(), value.clone()))
        })
        .collect()
}

fn observations(row: &NativeJobRow) -> Result<(), &'static str> {
    match row.get("NUMBER_OF_DESTINATIONS") {
        None => return Err("native_job_destination_observation_unavailable"),
        Some(Value::Null) => {}
        Some(value) if values::integral(value).is_some_and(|count| count >= 0) => {}
        _ => return Err("native_job_destination_observation_invalid"),
    }
    if row.get("EVENT_RULE").is_some_and(|value| !value.is_null() && !value.is_string()) {
        return Err("native_job_event_projection_invalid");
    }
    Ok(())
}

impl EventProjection {
    fn generated(&self) -> &[&str] {
        match self {
            Self::Watcher(_) => QUEUE_COLUMNS,
            Self::Named { .. } => EVENT_COLUMNS,
            _ => &[],
        }
    }

    fn matches(&self, row: &NativeJobRow) -> Result<bool, &'static str> {
        if matches!(self, Self::Preserve) {
            return Ok(true);
        }
        let actual = event_fields(row)?;
        Ok(match self {
            Self::None => actual.values().all(Value::is_null),
            Self::Queue(expected) => actual == *expected,
            Self::Watcher(expected) => EVENT_COLUMNS
                .iter()
                .filter(|name| !QUEUE_COLUMNS.contains(name))
                .all(|name| actual.get(*name) == expected.get(*name)),
            Self::Named { fields, watcher } => EVENT_COLUMNS
                .iter()
                .filter(|name| !*watcher || !QUEUE_COLUMNS.contains(name))
                .all(|name| actual.get(*name).is_some_and(|value| value.is_null() || Some(value) == fields.get(*name))),
            Self::Preserve => unreachable!(),
        })
    }
}

impl OracleSchedulerProjection {
    pub(in crate::schema::native_jobs::operations::scheduler) fn for_create(
        definition: &NativeJobSchedulerCreate,
    ) -> Option<Self> {
        let mut fields = EVENT_COLUMNS.iter().map(|name| ((*name).to_string(), Value::Null)).collect::<NativeJobRow>();
        fields.insert("EVENT_CONDITION".into(), definition.event_condition.clone().map_or(Value::Null, Value::String));
        let target = match definition.event_source.as_ref()? {
            NativeJobEventSource::Queue { owner, name, agent } => {
                fields.insert("EVENT_QUEUE_OWNER".into(), Value::String(owner.clone()));
                fields.insert("EVENT_QUEUE_NAME".into(), Value::String(name.clone()));
                fields.insert("EVENT_QUEUE_AGENT".into(), agent.clone().map_or(Value::Null, Value::String));
                EventProjection::Queue(fields)
            }
            NativeJobEventSource::FileWatcher { reference } => {
                fields.insert("FILE_WATCHER_OWNER".into(), Value::String(reference.owner.clone()));
                fields.insert("FILE_WATCHER_NAME".into(), Value::String(reference.name.clone()));
                EventProjection::Watcher(fields)
            }
        };
        Some(Self { before: target.clone(), target })
    }

    pub(super) fn bind(
        edit: &NativeJobSchedulerEditPlan,
        original: &NativeJobDetails,
        dependencies: &[BoundReference],
    ) -> Result<Self, &'static str> {
        let original = row(original).ok_or("native_job_definition_unavailable")?;
        observations(original)?;
        let before = if watcher(original) {
            EventProjection::Watcher(event_fields(original)?)
        } else {
            EventProjection::Preserve
        };
        let target = if !edit.event_changed {
            if watcher(original) {
                EventProjection::Watcher(event_fields(original)?)
            } else {
                EventProjection::Preserve
            }
        } else if let Some(reference) = edit.references.iter().find(|binding| binding.attribute == "SCHEDULE_NAME") {
            if reference.target.kind == NativeJobReferenceKind::Schedule {
                let source = dependencies
                    .iter()
                    .find(|bound| {
                        bound.request.kind == NativeJobReferenceKind::Schedule
                            && bound.request.schema.as_deref() == Some(&reference.target.reference.owner)
                            && bound.request.name.as_deref() == Some(&reference.target.reference.name)
                    })
                    .and_then(|bound| bound.rows.first())
                    .ok_or("native_job_event_projection_unavailable")?;
                let fields = event_fields(source)?;
                let kind = source
                    .get("SCHEDULE_TYPE")
                    .and_then(Value::as_str)
                    .ok_or("native_job_event_projection_unavailable")?;
                if kind != "EVENT" && fields.values().any(|value| !value.is_null()) {
                    return Err("native_job_event_projection_invalid");
                }
                EventProjection::Named { watcher: watcher(source), fields }
            } else {
                EventProjection::None
            }
        } else if watcher(&edit.definition) {
            EventProjection::Watcher(event_fields(&edit.definition)?)
        } else if edit.definition.get("SCHEDULE_TYPE").and_then(Value::as_str) == Some("EVENT") {
            EventProjection::Queue(event_fields(&edit.definition)?)
        } else {
            EventProjection::None
        };
        Ok(Self { before, target })
    }

    fn source(&self, target_applied: bool) -> &EventProjection {
        if target_applied {
            &self.target
        } else {
            &self.before
        }
    }

    pub(super) fn validate(&self, details: &NativeJobDetails) -> Result<(), &'static str> {
        observations(row(details).ok_or("native_job_definition_unavailable")?)
    }

    pub(in crate::schema::native_jobs::operations::scheduler) fn verify(
        &self,
        before: &NativeJobDetails,
        after: &NativeJobDetails,
        effect: &NativeJobStepEffect,
        target_applied: bool,
        user: &str,
    ) -> Result<bool, &'static str> {
        self.validate(after)?;
        let source = self.source(target_applied);
        let mut effect = effect.clone();
        if let NativeJobStepEffect::SchedulerDefinition(effect) = &mut effect {
            effect.columns.retain(|column| !source.generated().contains(&column.name.as_str()));
        }
        Ok(verify_effect_with_extra(before, after, &effect, user, NativeJobEngine::Oracle, source.generated())
            && source.matches(row(after).ok_or("native_job_definition_unavailable")?)?)
    }

    pub(in crate::schema::native_jobs::operations::scheduler) fn preserved(
        &self,
        before: &NativeJobDetails,
        after: &NativeJobDetails,
        target_applied: bool,
    ) -> Result<bool, &'static str> {
        self.validate(after)?;
        let source = self.source(target_applied);
        Ok(preserved_definition_with_extra(
            before,
            after,
            &NativeJobStepEffect::Completed,
            source.generated(),
            NativeJobEngine::Oracle,
        ) && source.matches(row(after).ok_or("native_job_definition_unavailable")?)?)
    }
}
