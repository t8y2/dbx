//! Structured StarRocks partitions: values are quoted data, never user-supplied SQL.
use super::create_options::*;
use super::dialect::StructureDialect;
use super::types::EditableStructureColumn;
use super::util::{quote_ident, quote_string};
use std::collections::HashSet;

fn ident(value: &str) -> String {
    quote_ident(StructureDialect::Mysql, value)
}
fn literal(value: &str) -> String {
    quote_string(&value.replace('\\', "\\\\"))
}
fn tuple(values: &[String]) -> String {
    values.iter().map(|value| literal(value)).collect::<Vec<_>>().join(", ")
}
fn base(column: &EditableStructureColumn) -> String {
    column.data_type.split('(').next().unwrap_or("").trim().to_ascii_lowercase()
}
fn integer(data_type: &str) -> bool {
    matches!(data_type, "tinyint" | "smallint" | "int" | "integer" | "bigint" | "largeint")
}
fn range_type(data_type: &str) -> bool {
    integer(data_type) || matches!(data_type, "date" | "datetime")
}
fn value_type(data_type: &str) -> bool {
    range_type(data_type) || matches!(data_type, "boolean" | "char" | "varchar" | "string")
}

fn validate_columns<'a>(
    ids: &[String],
    columns: &[&'a EditableStructureColumn],
    range: bool,
    warnings: &mut Vec<String>,
) -> Vec<&'a EditableStructureColumn> {
    let mut seen = HashSet::new();
    let has_pk = columns.iter().any(|column| column.is_primary_key);
    let mut selected = Vec::new();
    if ids.is_empty() {
        warnings.push("Select at least one StarRocks partition column.".into());
    }
    for id in ids {
        if !seen.insert(id) {
            warnings.push("Partition columns must not repeat.".into());
        }
        match columns.iter().find(|column| &column.id == id) {
            None => warnings.push("A partition column was removed. Select an existing column.".into()),
            Some(column) => {
                if if range { !range_type(&base(column)) } else { !value_type(&base(column)) } {
                    warnings
                        .push(format!("Column '{}' has an unsupported type for this partition strategy.", column.name));
                }
                if has_pk && !column.is_primary_key {
                    warnings.push("StarRocks partition columns must be included in the primary key. Review uniqueness before changing the primary key.".into());
                }
                selected.push(*column);
            }
        }
    }
    selected
}

fn validate_values(values: &[String], columns: &[&EditableStructureColumn], warnings: &mut Vec<String>) {
    if values.len() != columns.len() {
        warnings.push("Each partition value tuple must contain one value for each selected column.".into());
        return;
    }
    for (value, column) in values.iter().zip(columns) {
        let data_type = base(column);
        let valid = if integer(&data_type) {
            value.parse::<i128>().is_ok()
        } else if data_type == "boolean" {
            matches!(value.to_ascii_lowercase().as_str(), "true" | "false" | "0" | "1")
        } else if matches!(data_type.as_str(), "date" | "datetime") {
            !value.trim().is_empty()
        } else {
            !value.contains('\0')
        };
        if !valid {
            warnings.push(format!(
                "Invalid partition value for column '{}'. Enter a {} value without SQL quotes.",
                column.name, data_type
            ));
        }
    }
}

pub(super) fn validate(
    settings: &StarRocksCreateOptions,
    columns: &[&EditableStructureColumn],
    version: Option<(u32, u32, u32)>,
    warnings: &mut Vec<String>,
) {
    let at_least = |minimum| version.is_some_and(|value| value >= minimum);
    if settings.time_partition.is_some() && settings.partition.is_some() {
        warnings.push("Choose only one StarRocks partition strategy.".into());
    }
    if let Some(time) = &settings.time_partition {
        if !at_least((3, 1, 0)) {
            warnings.push("Time partitioning requires a confirmed server version of 3.1 or newer. Reconnect to refresh the version.".into());
        }
        let mut ids = vec![time.column_id.clone()];
        ids.extend(time.additional_column_ids.clone());
        let selected = validate_columns(&ids, columns, false, warnings);
        if let Some(column) = selected.first() {
            let data_type = base(column);
            if !matches!(data_type.as_str(), "date" | "datetime") {
                warnings.push("Time partition columns must use date or datetime.".into());
            }
            if (time.interval.is_some() || matches!(time.granularity, StarRocksTimeGranularity::Hour))
                && data_type != "datetime"
            {
                warnings.push("Hourly partitions and time_slice require a datetime column.".into());
            }
        }
        if time.interval.is_some_and(|interval| interval == 0 || interval > i32::MAX as u32) {
            warnings.push("Time partition interval must be a positive integer.".into());
        }
        if !time.additional_column_ids.is_empty() && !at_least((3, 4, 0)) {
            warnings.push("Mixed time and dimension partitions require StarRocks 3.4 or newer.".into());
        }
    }
    let Some(partition) = &settings.partition else {
        return;
    };
    let (ids, range) = match partition {
        StarRocksPartitionOptions::Values { column_ids } => (column_ids, false),
        StarRocksPartitionOptions::Range { column_ids, .. } => (column_ids, true),
        StarRocksPartitionOptions::List { column_ids, .. } => (column_ids, false),
    };
    if !range && !at_least((3, 1, 1)) {
        warnings.push("List and automatic value partitions require a confirmed StarRocks version of 3.1.1 or newer in this editor.".into());
    }
    let selected = validate_columns(ids, columns, range, warnings);
    let mut names = HashSet::new();
    let mut check_name = |name: &str, warnings: &mut Vec<String>| {
        if name.trim().is_empty() || name.contains('\0') || !names.insert(name.to_ascii_lowercase()) {
            warnings.push("Partition names must be non-empty and unique.".into());
        }
    };
    match partition {
        StarRocksPartitionOptions::Values { .. } => {}
        StarRocksPartitionOptions::Range { partitions, .. } => {
            if partitions.is_empty() {
                warnings.push("Add at least one range partition.".into());
            }
            for partition in partitions {
                check_name(&partition.name, warnings);
                validate_values(&partition.lower, &selected, warnings);
                validate_values(&partition.upper, &selected, warnings);
                if partition.lower == partition.upper {
                    warnings.push("A range partition's lower and upper bounds must differ.".into());
                }
            }
        }
        StarRocksPartitionOptions::List { partitions, .. } => {
            if partitions.is_empty() {
                warnings.push("Add at least one list partition.".into());
            }
            let mut tuples = HashSet::new();
            for partition in partitions {
                check_name(&partition.name, warnings);
                if partition.values.is_empty() {
                    warnings.push("Each list partition needs at least one value tuple.".into());
                }
                for values in &partition.values {
                    validate_values(values, &selected, warnings);
                    if !tuples.insert(values) {
                        warnings.push("List partition value tuples must not overlap or repeat.".into());
                    }
                }
            }
        }
    }
}

pub(super) fn render(settings: &StarRocksCreateOptions, columns: &[&EditableStructureColumn]) -> String {
    let name = |id: &String| {
        columns.iter().find(|column| &column.id == id).map(|column| ident(&column.name)).unwrap_or_default()
    };
    let names = |ids: &[String]| ids.iter().map(name).collect::<Vec<_>>().join(", ");
    if let Some(time) = &settings.time_partition {
        let expression = match time.interval {
            Some(interval) => {
                format!("time_slice({}, INTERVAL {interval} {})", name(&time.column_id), time.granularity.sql())
            }
            None => format!("date_trunc('{}', {})", time.granularity.sql(), name(&time.column_id)),
        };
        let extra = if time.additional_column_ids.is_empty() {
            String::new()
        } else {
            format!(", {}", names(&time.additional_column_ids))
        };
        return format!(" PARTITION BY {expression}{extra}");
    }
    match &settings.partition {
        None => String::new(),
        Some(StarRocksPartitionOptions::Values { column_ids }) => format!(" PARTITION BY ({})", names(column_ids)),
        Some(StarRocksPartitionOptions::Range { column_ids, partitions }) => {
            let definitions = partitions
                .iter()
                .map(|p| format!("PARTITION {} VALUES [({}), ({}))", ident(&p.name), tuple(&p.lower), tuple(&p.upper)))
                .collect::<Vec<_>>()
                .join(",\n  ");
            format!(" PARTITION BY RANGE ({}) (\n  {definitions}\n)", names(column_ids))
        }
        Some(StarRocksPartitionOptions::List { column_ids, partitions }) => {
            let definitions = partitions
                .iter()
                .map(|p| {
                    let values = p
                        .values
                        .iter()
                        .map(
                            |values| if column_ids.len() == 1 { tuple(values) } else { format!("({})", tuple(values)) },
                        )
                        .collect::<Vec<_>>()
                        .join(", ");
                    format!("PARTITION {} VALUES IN ({values})", ident(&p.name))
                })
                .collect::<Vec<_>>()
                .join(",\n  ");
            format!(" PARTITION BY LIST ({}) (\n  {definitions}\n)", names(column_ids))
        }
    }
}
