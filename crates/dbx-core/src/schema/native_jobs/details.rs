use super::*;
use dbx_types::native_jobs::{
    NativeJobArgument, NativeJobArgumentValue, NativeJobCatalogSource, NativeJobDetails, NativeJobEngine,
    NativeJobReferenceKind, NativeJobReferenceListRequest, NativeJobRow, NativeJobSnapshot,
};

pub(super) fn map_metadata<T, U>(data: NativeJobMetadata<T>, map: impl FnOnce(T) -> U) -> NativeJobMetadata<U> {
    match data {
        NativeJobMetadata::Available { value } => NativeJobMetadata::Available { value: map(value) },
        NativeJobMetadata::Truncated { value, limit } => NativeJobMetadata::Truncated { value: map(value), limit },
        NativeJobMetadata::Empty => NativeJobMetadata::Empty,
        NativeJobMetadata::Denied { reason } => NativeJobMetadata::Denied { reason },
        NativeJobMetadata::Unsupported { reason } => NativeJobMetadata::Unsupported { reason },
        NativeJobMetadata::Error { reason } => NativeJobMetadata::Error { reason },
        NativeJobMetadata::Unknown { reason } => NativeJobMetadata::Unknown { reason },
    }
}

pub(super) fn integer(value: Option<&Value>) -> Option<i64> {
    value.and_then(|value| value.as_i64().or_else(|| value.as_str()?.parse().ok()))
}

pub(super) fn boolean(value: Option<&Value>) -> Option<bool> {
    match value? {
        Value::Bool(value) => Some(*value),
        Value::Number(number) if number.as_i64() == Some(1) => Some(true),
        Value::Number(number) if number.as_i64() == Some(0) => Some(false),
        Value::String(value) if value.eq_ignore_ascii_case("true") || value == "1" => Some(true),
        Value::String(value) if value.eq_ignore_ascii_case("false") || value == "0" => Some(false),
        _ => None,
    }
}

/// Oracle documents these as generated observations, not user-owned Job definition inputs.
/// Keep their raw values in details; only semantic comparison excludes them.
pub(super) fn generated_definition_column(
    engine: NativeJobEngine,
    target: &NativeJobRef,
    row: &NativeJobRow,
    name: &str,
) -> bool {
    engine == NativeJobEngine::Oracle
        && matches!(target, NativeJobRef::Scheduler { .. })
        && (matches!(name, "FLAGS" | "EVENT_RULE" | "NUMBER_OF_DESTINATIONS")
            || (file_watcher_reference_present(row)
                && matches!(name, "EVENT_QUEUE_OWNER" | "EVENT_QUEUE_NAME" | "EVENT_QUEUE_AGENT")))
}

pub(super) fn file_watcher_reference_present(row: &NativeJobRow) -> bool {
    ["FILE_WATCHER_OWNER", "FILE_WATCHER_NAME"]
        .iter()
        .all(|name| row.get(*name).and_then(Value::as_str).is_some_and(|value| !value.is_empty()))
}

/// Keep raw partitions for lossless display. Referenced Program counts/defaults are independent
/// of inline job columns; an unreadable default or opaque ANYDATA never becomes an inferred NULL.
pub async fn read_native_job_details_with<Q, F>(
    dialect: NativeJobCatalogDialect,
    target: &NativeJobRef,
    mut query: Q,
) -> Result<NativeJobDetails, &'static str>
where
    Q: FnMut(NativeJobCatalogQuery) -> F,
    F: Future<Output = Result<Value, NativeJobCatalogFailure>>,
{
    target.validate()?;
    let before =
        read_native_job_catalog_part_with(dialect, target, NativeJobCatalogPart::Generation, &mut query).await?;
    let mut sources = BTreeMap::new();
    let mut partitions = BTreeMap::new();
    for (key, part) in [
        ("definition", NativeJobCatalogPart::Definition),
        ("arguments", NativeJobCatalogPart::Arguments),
        ("steps", NativeJobCatalogPart::Steps),
        ("schedules", NativeJobCatalogPart::Schedules),
        ("running", NativeJobCatalogPart::Running),
        ("history", NativeJobCatalogPart::History),
    ] {
        let section = read_native_job_catalog_part_with(dialect, target, part, &mut query).await?;
        sources.insert(
            key.into(),
            NativeJobCatalogSource { source: section.source.map(str::to_string), coverage: section.coverage },
        );
        partitions.insert(key, section.data);
    }
    let mut definition =
        map_metadata(partitions.remove("definition").unwrap(), |rows| rows.into_iter().next().unwrap_or_default());
    if dialect == NativeJobCatalogDialect::OceanbaseOracle && matches!(target, NativeJobRef::Scheduler { .. }) {
        let native =
            read_native_job_catalog_part_with(dialect, target, NativeJobCatalogPart::NativeAttributes, &mut query)
                .await?;
        sources.insert(
            "nativeDefinition".into(),
            NativeJobCatalogSource { source: native.source.map(str::to_string), coverage: native.coverage },
        );
        if let NativeJobMetadata::Available { value: definition } = &mut definition {
            // The public MAX_FAILURES column is a compatibility NULL, not the actual limit.
            definition.remove("MAX_FAILURES");
            if let (NativeJobMetadata::Available { value: native }, NativeJobMetadata::Available { value: identity }) =
                (&native.data, &before.data)
            {
                if let (Some(native), Some(identity)) = (native.first(), identity.first()) {
                    if native.get("DBX_JOB_ID") == identity.get("DBX_JOB_ID")
                        && native.get("DBX_CREATED_AT") == identity.get("DBX_CREATED_AT")
                        && integer(native.get("MAX_FAILURES")).is_some_and(|value| value >= 0)
                    {
                        definition.insert("MAX_FAILURES".into(), native["MAX_FAILURES"].clone());
                    }
                }
            }
        }
    }
    let legacy_definition =
        if dialect == NativeJobCatalogDialect::Dameng && matches!(target, NativeJobRef::Legacy { .. }) {
            let legacy =
                read_native_job_catalog_part_with(dialect, target, NativeJobCatalogPart::NativeAttributes, &mut query)
                    .await?;
            sources.insert(
                "legacyDefinition".into(),
                NativeJobCatalogSource { source: legacy.source.map(str::to_string), coverage: legacy.coverage },
            );
            Some(map_metadata(legacy.data, |rows| rows.into_iter().next().unwrap_or_default()))
        } else {
            None
        };
    let (program, program_arguments) = if let NativeJobMetadata::Available { value } = &definition {
        if matches!(target, NativeJobRef::Scheduler { .. }) && has_program(value) {
            let name = value["PROGRAM_NAME"].as_str().unwrap();
            if let Some(owner) = value.get("PROGRAM_OWNER").and_then(Value::as_str).filter(|owner| !owner.is_empty()) {
                let mut request = NativeJobReferenceListRequest {
                    scope: target.scope().clone(),
                    kind: NativeJobReferenceKind::Program,
                    schema: Some(owner.into()),
                    name: Some(name.into()),
                    filter: String::new(),
                    offset: 0,
                    limit: 1,
                };
                let program = super::references::read_references_with(dialect, &request, None, &mut query).await?;
                sources.insert("program".into(), program.source);
                request.kind = NativeJobReferenceKind::ProgramArguments;
                request.limit = 10_000;
                let arguments = super::references::read_references_with(dialect, &request, None, &mut query).await?;
                sources.insert("programArguments".into(), arguments.source);
                (
                    Some(map_metadata(program.objects, |rows| rows.into_iter().next().unwrap_or_default())),
                    Some(arguments.objects),
                )
            } else {
                let reason = "native_job_program_identity_unavailable".to_string();
                (
                    Some(NativeJobMetadata::Unknown { reason: reason.clone() }),
                    Some(NativeJobMetadata::Unknown { reason }),
                )
            }
        } else {
            (None, None)
        }
    } else {
        (None, None)
    };
    let after =
        read_native_job_catalog_part_with(dialect, target, NativeJobCatalogPart::Generation, &mut query).await?;
    sources.insert(
        "identity".into(),
        NativeJobCatalogSource { source: after.source.map(str::to_string), coverage: after.coverage },
    );
    let consistency = match (&before.data, &after.data) {
        (NativeJobMetadata::Available { value: before }, NativeJobMetadata::Available { value: after })
            if before == after =>
        {
            NativeJobMetadata::Available { value: () }
        }
        (NativeJobMetadata::Available { .. }, NativeJobMetadata::Available { .. }) => {
            NativeJobMetadata::Error { reason: "native_job_replaced_during_read".into() }
        }
        _ => NativeJobMetadata::Unknown { reason: "native_job_identity_unverified".into() },
    };
    let parameter_metadata = partitions.remove("arguments").unwrap();
    let arguments = parse_arguments(
        dialect,
        target,
        &definition,
        &parameter_metadata,
        program.as_ref(),
        program_arguments.as_ref(),
    );
    Ok(NativeJobDetails {
        snapshot: NativeJobSnapshot { job_ref: target.clone(), revision: String::new(), definition, arguments },
        native_identity: map_metadata(after.data, |rows| rows.into_iter().next().unwrap_or_default()),
        consistency,
        parameter_metadata,
        program,
        program_arguments,
        legacy_definition,
        steps: partitions.remove("steps").unwrap(),
        schedules: partitions.remove("schedules").unwrap(),
        running: partitions.remove("running").unwrap(),
        history: partitions.remove("history").unwrap(),
        sources,
    })
}

fn has_program(definition: &NativeJobCatalogRow) -> bool {
    definition.get("PROGRAM_NAME").and_then(Value::as_str).is_some_and(|name| !name.is_empty())
}

fn argument_positions(
    rows: &[NativeJobCatalogRow],
    count: i64,
) -> Result<BTreeMap<i64, &NativeJobCatalogRow>, &'static str> {
    let mut result = BTreeMap::new();
    for row in rows {
        let position = integer(row.get("ARGUMENT_POSITION").or_else(|| row.get("ARG_POSITION")));
        let Some(position) = position.filter(|position| *position > 0 && *position <= count) else {
            return Err("native_job_arguments_invalid");
        };
        if result.insert(position, row).is_some() {
            return Err("native_job_arguments_ambiguous");
        }
    }
    Ok(result)
}

pub(super) fn program_default(
    engine: NativeJobEngine,
    row: Option<&NativeJobCatalogRow>,
    metadata: Option<&NativeJobMetadata<Vec<NativeJobCatalogRow>>>,
) -> NativeJobMetadata<NativeJobArgumentValue> {
    if let Some(row) = row {
        if engine == NativeJobEngine::Oracle {
            let storage = dbx_sql::native_job_arguments::decode_argument(row, true);
            if !matches!(storage, dbx_sql::native_job_arguments::ArgumentStorage::Opaque(_))
                || boolean(row.get("DBX_ANYDATA_PRESENT")) == Some(true)
            {
                return NativeJobMetadata::Available {
                    value: dbx_sql::native_job_arguments::editable_argument(row, true),
                };
            }
            return NativeJobMetadata::Unknown { reason: "native_job_program_default_ambiguous".into() };
        }
        if let Some(value) = row.get("DEFAULT_VALUE").filter(|value| !value.is_null()) {
            return NativeJobMetadata::Available { value: NativeJobArgumentValue::Value { value: value.clone() } };
        }
        if let Some(value) = row.get("DEFAULT_ANYDATA_VALUE").filter(|value| !value.is_null()) {
            return NativeJobMetadata::Available { value: NativeJobArgumentValue::Opaque { value: value.clone() } };
        }
        // A nullable DEFAULT_VALUE does not distinguish no default from a string NULL default.
        return NativeJobMetadata::Unknown { reason: "native_job_program_default_ambiguous".into() };
    }
    match metadata {
        Some(NativeJobMetadata::Denied { reason }) => NativeJobMetadata::Denied { reason: reason.clone() },
        Some(NativeJobMetadata::Unsupported { reason }) => NativeJobMetadata::Unsupported { reason: reason.clone() },
        Some(NativeJobMetadata::Error { reason }) => NativeJobMetadata::Error { reason: reason.clone() },
        _ => NativeJobMetadata::Unknown { reason: "native_job_program_default_unavailable".into() },
    }
}

pub(super) type SchedulerArgumentInventory = BTreeMap<usize, NativeJobCatalogRow>;

/// Read all native overrides before considering the active Program's argument count. A conversion
/// can leave old positions behind; those rows must remain visible to reconciliation.
pub(super) fn parse_argument_inventory(
    parameters: &NativeJobMetadata<Vec<NativeJobCatalogRow>>,
) -> NativeJobMetadata<SchedulerArgumentInventory> {
    let rows = match parameters {
        NativeJobMetadata::Available { value } => value,
        NativeJobMetadata::Empty => return NativeJobMetadata::Available { value: BTreeMap::new() },
        NativeJobMetadata::Truncated { .. } => {
            return NativeJobMetadata::Unknown { reason: "native_job_arguments_truncated".into() };
        }
        other => return map_metadata(other.clone(), |_| unreachable!()),
    };
    let mut inventory = BTreeMap::new();
    for row in rows {
        let Some(position) = integer(row.get("ARGUMENT_POSITION").or_else(|| row.get("ARG_POSITION")))
            .filter(|position| *position > 0)
            .and_then(|position| usize::try_from(position).ok())
        else {
            return NativeJobMetadata::Error { reason: "native_job_arguments_invalid".into() };
        };
        if inventory.insert(position, row.clone()).is_some() {
            return NativeJobMetadata::Error { reason: "native_job_arguments_ambiguous".into() };
        }
    }
    NativeJobMetadata::Available { value: inventory }
}

pub(super) fn inventory_value(engine: NativeJobEngine, row: &NativeJobCatalogRow) -> NativeJobArgumentValue {
    if engine == NativeJobEngine::Oracle {
        return dbx_sql::native_job_arguments::editable_argument(row, false);
    }
    if row.get("OUT_ARGUMENT").is_none_or(|value| boolean(Some(value)) == Some(false)) {
        if matches!(
            row.get("DBX_ANYDATA_TYPE").and_then(Value::as_str),
            Some(
                "SYS.VARCHAR2"
                    | "SYS.CHAR"
                    | "SYS.NUMBER"
                    | "SYS.DATE"
                    | "SYS.TIMESTAMP"
                    | "SYS.TIMESTAMP WITH TIME ZONE"
            )
        ) && boolean(row.get("DBX_ANYDATA_IS_NULL")) == Some(true)
        {
            return NativeJobArgumentValue::Null;
        }
        if let Some(value) = row.get("VALUE").filter(|value| !value.is_null()) {
            return NativeJobArgumentValue::Value { value: value.clone() };
        }
    }
    NativeJobArgumentValue::Opaque { value: serde_json::to_value(row).expect("JSON metadata") }
}

pub(super) fn parse_argument_layout(
    engine: NativeJobEngine,
    definition: &NativeJobMetadata<NativeJobCatalogRow>,
    program: Option<&NativeJobMetadata<NativeJobCatalogRow>>,
    program_parameters: Option<&NativeJobMetadata<Vec<NativeJobCatalogRow>>>,
) -> NativeJobMetadata<Vec<NativeJobArgument>> {
    let NativeJobMetadata::Available { value: definition } = definition else {
        return NativeJobMetadata::Unknown { reason: "native_job_argument_definition_unavailable".into() };
    };
    let program_reference = has_program(definition);
    let count_definition = if program_reference {
        match program {
            Some(NativeJobMetadata::Available { value }) => value,
            _ => return NativeJobMetadata::Unknown { reason: "native_job_program_argument_count_unavailable".into() },
        }
    } else {
        definition
    };
    let Some(count) =
        integer(count_definition.get("NUMBER_OF_ARGUMENTS")).filter(|count| *count >= 0 && *count <= 10_000)
    else {
        return NativeJobMetadata::Unknown { reason: "native_job_argument_count_unavailable".into() };
    };
    let program_rows = match program_parameters {
        Some(NativeJobMetadata::Available { value }) => match argument_positions(value, count) {
            Ok(rows) => rows,
            Err(reason) => return NativeJobMetadata::Error { reason: reason.into() },
        },
        _ => BTreeMap::new(),
    };
    let mut arguments = Vec::new();
    for position in 1..=count {
        let program_row = program_rows.get(&position).copied();
        let description = program_row;
        let name = description
            .and_then(|row| row.get("ARGUMENT_NAME").or_else(|| row.get("ARG_NAME")))
            .and_then(Value::as_str)
            .map(str::to_string);
        let data_type = description
            .and_then(|row| row.get("ARGUMENT_TYPE").or_else(|| row.get("ARG_TYPE")))
            .and_then(Value::as_str)
            .unwrap_or("UNKNOWN")
            .to_string();
        let (value, editable, reason) = if program_reference {
            (
                if program_row.is_some() {
                    NativeJobArgumentValue::Inherit
                } else {
                    NativeJobArgumentValue::Opaque { value: Value::Null }
                },
                program_row.is_some(),
                program_row.is_none().then(|| "native_job_program_defaults_unavailable".into()),
            )
        } else {
            (NativeJobArgumentValue::Unset, true, None)
        };
        let metadata_attribute = program_row
            .and_then(|row| row.get("METADATA_ATTRIBUTE"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let out_argument = program_row
            .and_then(|row| row.get("OUT_ARGUMENT"))
            .is_some_and(|value| !value.is_null() && boolean(Some(value)) != Some(false));
        let reason = if metadata_attribute.is_some() {
            Some("native_job_metadata_argument".into())
        } else if out_argument {
            Some("native_job_argument_opaque".into())
        } else {
            reason
        };
        let editable = editable && metadata_attribute.is_none() && !out_argument;
        let default_value = (program_reference && metadata_attribute.is_none())
            .then(|| program_default(engine, program_row, program_parameters));
        arguments.push(NativeJobArgument {
            position: position as usize,
            name,
            data_type,
            value,
            default_value,
            metadata_attribute,
            editable,
            reason,
        });
    }
    NativeJobMetadata::Available { value: arguments }
}

pub(super) fn project_arguments(
    engine: NativeJobEngine,
    layout: &[NativeJobArgument],
    inventory: &SchedulerArgumentInventory,
) -> NativeJobMetadata<Vec<NativeJobArgument>> {
    if inventory.keys().any(|position| *position > layout.len()) {
        return NativeJobMetadata::Error { reason: "native_job_arguments_invalid".into() };
    }
    let arguments = layout
        .iter()
        .cloned()
        .map(|mut argument| {
            if let Some(row) = inventory.get(&argument.position) {
                argument.value = inventory_value(engine, row);
                let out = row
                    .get("OUT_ARGUMENT")
                    .is_some_and(|value| !value.is_null() && boolean(Some(value)) != Some(false));
                let layout_out = argument.reason.as_deref() == Some("native_job_argument_opaque");
                argument.editable = argument.metadata_attribute.is_none()
                    && !layout_out
                    && !out
                    && !matches!(argument.value, NativeJobArgumentValue::Opaque { .. });
                argument.reason = (!argument.editable).then(|| {
                    if argument.metadata_attribute.is_some() {
                        "native_job_metadata_argument"
                    } else {
                        "native_job_argument_opaque"
                    }
                    .into()
                });
                // Program metadata describes the new context even when a native engine retained an old
                // override row. Only an unknown description falls back to the native override metadata.
                if argument.data_type == "UNKNOWN" {
                    argument.data_type = row
                        .get("ARGUMENT_TYPE")
                        .or_else(|| row.get("ARG_TYPE"))
                        .and_then(Value::as_str)
                        .unwrap_or("UNKNOWN")
                        .into();
                    argument.name = row
                        .get("ARGUMENT_NAME")
                        .or_else(|| row.get("ARG_NAME"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
            }
            argument
        })
        .collect();
    NativeJobMetadata::Available { value: arguments }
}

fn parse_arguments(
    engine: NativeJobEngine,
    target: &NativeJobRef,
    definition: &NativeJobMetadata<NativeJobCatalogRow>,
    parameters: &NativeJobMetadata<Vec<NativeJobCatalogRow>>,
    program: Option<&NativeJobMetadata<NativeJobCatalogRow>>,
    program_parameters: Option<&NativeJobMetadata<Vec<NativeJobCatalogRow>>>,
) -> NativeJobMetadata<Vec<NativeJobArgument>> {
    if !matches!(target, NativeJobRef::Scheduler { .. }) {
        return NativeJobMetadata::Available { value: Vec::new() };
    }
    let layout = parse_argument_layout(engine, definition, program, program_parameters);
    let inventory = parse_argument_inventory(parameters);
    match (layout, inventory) {
        (NativeJobMetadata::Available { value: layout }, NativeJobMetadata::Available { value: inventory }) => {
            project_arguments(engine, &layout, &inventory)
        }
        (NativeJobMetadata::Available { .. }, inventory) => map_metadata(inventory, |_| unreachable!()),
        (layout, _) => layout,
    }
}
