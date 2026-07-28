use super::{
    write_bytes, DataGridExtractColumn, DataGridExtractError, DataGridExtractErrorCode, DataGridExtractWarning,
    DataGridExtractWarningCode, ExtractContext,
};
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Serialize, Serializer};
use std::io::Write;

pub(super) fn write_json(
    context: &ExtractContext<'_>,
    output: &mut dyn Write,
) -> Result<Vec<DataGridExtractWarning>, DataGridExtractError> {
    let (names, warnings) = unique_json_names(&context.selected_columns);
    let rows =
        JsonRows { names: &names, source_indexes: &context.selected_source_indexes, rows: &context.request.rows };
    let result = if context.request.options.json.pretty {
        serde_json::to_writer_pretty(output, &rows)
    } else {
        serde_json::to_writer(output, &rows)
    };
    result.map_err(|error| {
        DataGridExtractError::new(
            DataGridExtractErrorCode::EncodingFailed,
            format!("Failed to encode JSON extractor output: {error}"),
        )
    })?;
    Ok(warnings)
}

pub(super) fn write_json_lines(
    context: &ExtractContext<'_>,
    output: &mut dyn Write,
) -> Result<Vec<DataGridExtractWarning>, DataGridExtractError> {
    let (names, warnings) = unique_json_names(&context.selected_columns);
    for (index, row) in context.request.rows.iter().enumerate() {
        if index > 0 {
            write_bytes(output, b"\n")?;
        }
        serde_json::to_writer(
            &mut *output,
            &JsonRow { names: &names, source_indexes: &context.selected_source_indexes, values: row },
        )
        .map_err(|error| {
            DataGridExtractError::new(
                DataGridExtractErrorCode::EncodingFailed,
                format!("Failed to encode JSON Lines extractor output: {error}"),
            )
        })?;
    }
    Ok(warnings)
}

struct JsonRows<'a, 'value> {
    names: &'a [String],
    source_indexes: &'a [usize],
    rows: &'value [Vec<serde_json::Value>],
}

impl Serialize for JsonRows<'_, '_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut sequence = serializer.serialize_seq(Some(self.rows.len()))?;
        for row in self.rows {
            sequence.serialize_element(&JsonRow {
                names: self.names,
                source_indexes: self.source_indexes,
                values: row,
            })?;
        }
        sequence.end()
    }
}

struct JsonRow<'a, 'value> {
    names: &'a [String],
    source_indexes: &'a [usize],
    values: &'value [serde_json::Value],
}

impl Serialize for JsonRow<'_, '_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(Some(self.names.len()))?;
        for (name, source_index) in self.names.iter().zip(self.source_indexes) {
            map.serialize_entry(name, &self.values[*source_index])?;
        }
        map.end()
    }
}

fn unique_json_names(columns: &[&DataGridExtractColumn]) -> (Vec<String>, Vec<DataGridExtractWarning>) {
    let reserved = columns.iter().map(|column| column.display_name.as_str()).collect::<std::collections::HashSet<_>>();
    let mut emitted = std::collections::HashSet::<String>::new();
    let mut suffixes = std::collections::HashMap::<String, usize>::new();
    let mut duplicate = false;
    let names = columns
        .iter()
        .map(|column| {
            let base = column.display_name.clone();
            if emitted.insert(base.clone()) {
                return base;
            }
            duplicate = true;
            let suffix = suffixes.entry(base.clone()).or_insert(2);
            loop {
                let candidate = format!("{base}_{suffix}");
                *suffix += 1;
                if !reserved.contains(candidate.as_str()) && emitted.insert(candidate.clone()) {
                    return candidate;
                }
            }
        })
        .collect();
    let warnings = if duplicate {
        vec![DataGridExtractWarning {
            code: DataGridExtractWarningCode::DuplicateJsonColumnNames,
            message: "Duplicate JSON column names were suffixed to prevent data loss.".to_string(),
        }]
    } else {
        Vec::new()
    };
    (names, warnings)
}
