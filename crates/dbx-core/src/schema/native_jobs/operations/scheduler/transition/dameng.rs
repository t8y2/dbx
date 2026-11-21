use super::*;

pub(super) struct DamengNamedProjection {
    slots: Vec<NativeJobSchedulerReferenceBinding>,
}

impl DamengNamedProjection {
    pub(super) fn bind(
        edit: &NativeJobSchedulerEditPlan,
        original: &NativeJobDetails,
        dependencies: &[BoundReference],
    ) -> Result<Self, &'static str> {
        let before = row(original).ok_or("native_job_definition_unavailable")?;
        let mut slots = Vec::new();
        for binding in &edit.references {
            let (owner, name, fields) = match binding.attribute.as_str() {
                "PROGRAM_NAME" => {
                    ("PROGRAM_OWNER", "PROGRAM_NAME", &["PROGRAM_TYPE", "PROGRAM_ACTION", "NUMBER_OF_ARGUMENTS"][..])
                }
                "SCHEDULE_NAME" => (
                    "SCHEDULE_OWNER",
                    "SCHEDULE_NAME",
                    &["SCHEDULE_TYPE", "START_DATE", "REPEAT_INTERVAL", "END_DATE"][..],
                ),
                _ => continue,
            };
            if before.get(owner).and_then(Value::as_str) == Some(&binding.target.reference.owner)
                && before.get(name).and_then(Value::as_str) == Some(&binding.target.reference.name)
            {
                continue;
            }
            if ![owner, name]
                .iter()
                .all(|key| before.get(*key).and_then(Value::as_str).is_some_and(|value| !value.is_empty()))
            {
                return Err("native_job_reference_attach_mapping_unverified");
            }
            let definition = dependencies
                .iter()
                .find(|bound| {
                    bound.request.kind == binding.target.kind
                        && bound.request.schema.as_deref() == Some(&binding.target.reference.owner)
                        && bound.request.name.as_deref() == Some(&binding.target.reference.name)
                })
                .and_then(|bound| bound.rows.first())
                .ok_or("native_job_reference_unavailable")?;
            if fields.iter().any(|field| !definition.contains_key(*field)) {
                return Err("native_job_reference_definition_unavailable");
            }
            if binding.attribute == "PROGRAM_NAME" {
                if definition.get("PROGRAM_TYPE").and_then(Value::as_str).is_none()
                    || definition.get("PROGRAM_ACTION").and_then(Value::as_str).is_none()
                    || crate::schema::native_jobs::details::integer(definition.get("NUMBER_OF_ARGUMENTS"))
                        .is_none_or(|count| count < 0)
                {
                    return Err("native_job_reference_definition_unavailable");
                }
            } else if !matches!(definition.get("SCHEDULE_TYPE").and_then(Value::as_str), Some("ONCE" | "CALENDAR"))
                || ["START_DATE", "REPEAT_INTERVAL", "END_DATE"]
                    .iter()
                    .any(|field| definition.get(*field).is_none_or(|value| !value.is_null() && !value.is_string()))
            {
                return Err("native_job_reference_definition_unavailable");
            }
            slots.push(binding.clone());
        }
        Ok(Self { slots })
    }

    pub(super) fn advance(&self, active: &HashSet<String>, effect: &NativeJobStepEffect) -> HashSet<String> {
        let mut next = active.clone();
        if let NativeJobStepEffect::SchedulerDefinition(effect) = effect {
            for binding in &effect.references {
                if self.slots.iter().any(|slot| slot.attribute == binding.attribute && slot.target == binding.target) {
                    next.insert(binding.attribute.clone());
                }
            }
        }
        next
    }

    fn columns(&self, active: &HashSet<String>, details: &NativeJobDetails) -> Option<Vec<&'static str>> {
        let row = row(details)?;
        let mut columns = Vec::new();
        for slot in self.slots.iter().filter(|slot| active.contains(&slot.attribute)) {
            let owner = if slot.attribute == "PROGRAM_NAME" { "PROGRAM_OWNER" } else { "SCHEDULE_OWNER" };
            if row.get(owner).and_then(Value::as_str) != Some(&slot.target.reference.owner)
                || row.get(&slot.attribute).and_then(Value::as_str) != Some(&slot.target.reference.name)
            {
                return None;
            }
            columns.extend(if slot.attribute == "PROGRAM_NAME" {
                &["JOB_TYPE", "JOB_ACTION", "NUMBER_OF_ARGUMENTS"][..]
            } else {
                &["SCHEDULE_TYPE", "START_DATE", "REPEAT_INTERVAL", "END_DATE"][..]
            });
        }
        Some(columns)
    }

    pub(super) fn complete(&self, active: &HashSet<String>) -> bool {
        self.slots.iter().all(|slot| active.contains(&slot.attribute))
    }

    pub(super) fn verify(
        &self,
        before: &NativeJobDetails,
        after: &NativeJobDetails,
        effect: &NativeJobStepEffect,
        active: &HashSet<String>,
        user: &str,
    ) -> bool {
        self.columns(active, after).is_some_and(|columns| {
            verify_effect_with_extra(before, after, effect, user, NativeJobEngine::Dameng, &columns)
        })
    }

    pub(super) fn preserved(
        &self,
        before: &NativeJobDetails,
        after: &NativeJobDetails,
        active: &HashSet<String>,
    ) -> bool {
        self.columns(active, after).is_some_and(|columns| {
            preserved_definition_with_extra(
                before,
                after,
                &NativeJobStepEffect::Completed,
                &columns,
                NativeJobEngine::Dameng,
            )
        })
    }
}
