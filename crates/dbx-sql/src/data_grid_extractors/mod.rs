use serde_json::Value;
use std::borrow::Cow;
use std::io::{self, Write};

mod contract;
mod delimited;
mod document;
mod json;
mod raw;
mod sql;

pub use contract::*;
use delimited::{write_dsv, write_one_row};
use document::{write_html, write_markdown, write_pretty, write_xml};
use json::{write_json, write_json_lines};
use raw::write_raw;
use sql::{write_sql_in_list, write_sql_inserts, write_sql_select, write_sql_updates, write_where_clause};

const DATA_GRID_EXTRACTOR_MAX_OUTPUT_BYTES: usize = 32 * 1024 * 1024;
const DATA_GRID_EXTRACTOR_MAX_INPUT_BYTES: usize = 64 * 1024 * 1024;
const DATA_GRID_EXTRACTOR_MAX_ROWS: usize = 100_000;
const DATA_GRID_EXTRACTOR_MAX_COLUMNS: usize = 10_000;
const DATA_GRID_EXTRACTOR_MAX_CELLS: usize = 2_000_000;

struct ExtractContext<'a> {
    request: &'a DataGridExtractRequest,
    selected_columns: Vec<&'a DataGridExtractColumn>,
    selected_source_indexes: Vec<usize>,
    selected_column_info: Vec<Option<&'a crate::data_grid_sql::DataGridColumnInfo>>,
}

pub fn extract_data_grid_selection(
    request: DataGridExtractRequest,
) -> Result<DataGridExtractResult, DataGridExtractError> {
    if request.version != DATA_GRID_EXTRACTOR_CONTRACT_VERSION {
        return Err(DataGridExtractError::new(
            DataGridExtractErrorCode::UnsupportedVersion,
            format!("Unsupported data grid extractor contract version: {}", request.version),
        ));
    }
    let context = build_context(&request)?;
    let mut output = BoundedOutput::new(DATA_GRID_EXTRACTOR_MAX_OUTPUT_BYTES);
    let metadata = write_extraction(&context, &mut output);
    if output.exceeded_limit() {
        return Err(DataGridExtractError::new(
            DataGridExtractErrorCode::OutputTooLarge,
            "Extracted clipboard output exceeds 32 MiB; export the data to a file instead.",
        ));
    }
    let metadata = metadata?;
    let text = String::from_utf8(output.into_bytes()).map_err(|error| {
        DataGridExtractError::new(
            DataGridExtractErrorCode::EncodingFailed,
            format!("Extractor produced invalid UTF-8: {error}"),
        )
    })?;
    Ok(DataGridExtractResult {
        text,
        mime_type: metadata.mime_type.to_owned(),
        file_extension: metadata.file_extension.to_owned(),
        row_count: request.rows.len(),
        column_count: context.selected_columns.len(),
        omitted_columns: metadata.omitted_columns,
        warnings: metadata.warnings,
    })
}

struct BoundedOutput {
    bytes: Vec<u8>,
    max_bytes: usize,
    exceeded_limit: bool,
}

impl BoundedOutput {
    fn new(max_bytes: usize) -> Self {
        Self { bytes: Vec::new(), max_bytes, exceeded_limit: false }
    }

    fn exceeded_limit(&self) -> bool {
        self.exceeded_limit
    }

    fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }
}

impl Write for BoundedOutput {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if buffer.len() > self.max_bytes.saturating_sub(self.bytes.len()) {
            self.exceeded_limit = true;
            return Err(io::Error::other("data grid extractor output limit exceeded"));
        }
        self.bytes.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn build_context(request: &DataGridExtractRequest) -> Result<ExtractContext<'_>, DataGridExtractError> {
    validate_request_budget(request)?;
    if request.rows.is_empty() || request.selected_column_indexes.is_empty() {
        return Err(DataGridExtractError::new(
            DataGridExtractErrorCode::EmptySelection,
            "Select at least one data grid cell before extracting data.",
        ));
    }
    let mut selected_columns = Vec::with_capacity(request.selected_column_indexes.len());
    let mut unique_selected_indexes = std::collections::HashSet::with_capacity(request.selected_column_indexes.len());
    for index in &request.selected_column_indexes {
        if !unique_selected_indexes.insert(*index) {
            return Err(DataGridExtractError::new(
                DataGridExtractErrorCode::InvalidColumnIndex,
                format!("Selected column index {index} is duplicated."),
            ));
        }
        let column = request.columns.get(*index).ok_or_else(|| {
            DataGridExtractError::new(
                DataGridExtractErrorCode::InvalidColumnIndex,
                format!("Selected column index {index} is outside the extractor column list."),
            )
        })?;
        selected_columns.push(column);
    }
    let selected_source_indexes = selected_columns.iter().map(|column| column.source_index).collect::<Vec<_>>();
    for row in &request.rows {
        for column in &selected_columns {
            row.get(column.source_index).ok_or_else(|| {
                DataGridExtractError::new(
                    DataGridExtractErrorCode::InvalidColumnMapping,
                    format!("Column '{}' maps to missing row index {}.", column.display_name, column.source_index),
                )
            })?;
        }
    }
    let column_info_by_name = request
        .table_meta
        .as_ref()
        .and_then(|table_meta| table_meta.columns.as_ref())
        .map(|columns| {
            columns
                .iter()
                .map(|info| (normalized_name(info.name.as_str()).to_ascii_uppercase(), info))
                .collect::<std::collections::HashMap<_, _>>()
        })
        .unwrap_or_default();
    let selected_column_info = selected_columns
        .iter()
        .map(|column| {
            let source_name = column.source_name.as_deref().unwrap_or(&column.display_name);
            column_info_by_name.get(&normalized_name(source_name).to_ascii_uppercase()).copied()
        })
        .collect();
    Ok(ExtractContext { request, selected_columns, selected_source_indexes, selected_column_info })
}

fn validate_request_budget(request: &DataGridExtractRequest) -> Result<(), DataGridExtractError> {
    if request.rows.len() > DATA_GRID_EXTRACTOR_MAX_ROWS
        || request.columns.len() > DATA_GRID_EXTRACTOR_MAX_COLUMNS
        || request.selected_column_indexes.len() > DATA_GRID_EXTRACTOR_MAX_COLUMNS
    {
        return Err(input_too_large_error());
    }

    let mut cell_count = 0usize;
    let mut estimated_bytes = request
        .columns
        .iter()
        .fold(0usize, |size, column| {
            size.saturating_add(column.display_name.len())
                .saturating_add(column.source_name.as_deref().map_or(0, str::len))
        })
        .saturating_add(request.options.dsv.column_separator.len())
        .saturating_add(request.options.dsv.row_separator.len())
        .saturating_add(request.options.dsv.null_text.len())
        .saturating_add(estimated_table_meta_bytes(request.table_meta.as_ref()));
    if estimated_bytes > DATA_GRID_EXTRACTOR_MAX_INPUT_BYTES {
        return Err(input_too_large_error());
    }
    for row in &request.rows {
        cell_count = cell_count.saturating_add(row.len());
        if cell_count > DATA_GRID_EXTRACTOR_MAX_CELLS {
            return Err(input_too_large_error());
        }
        for value in row {
            estimated_bytes = estimated_bytes.saturating_add(estimated_value_bytes(value));
            if estimated_bytes > DATA_GRID_EXTRACTOR_MAX_INPUT_BYTES {
                return Err(input_too_large_error());
            }
        }
    }
    Ok(())
}

fn estimated_table_meta_bytes(table_meta: Option<&crate::data_grid_sql::DataGridTableMeta>) -> usize {
    let Some(table_meta) = table_meta else {
        return 0;
    };
    let mut size = table_meta
        .table_name
        .len()
        .saturating_add(table_meta.catalog.as_deref().map_or(0, str::len))
        .saturating_add(table_meta.database.as_deref().map_or(0, str::len))
        .saturating_add(table_meta.schema.as_deref().map_or(0, str::len));
    for primary_key in &table_meta.primary_keys {
        size = size.saturating_add(primary_key.len());
    }
    for column in table_meta.columns.as_deref().unwrap_or_default() {
        size = size
            .saturating_add(column.name.len())
            .saturating_add(column.data_type.len())
            .saturating_add(column.column_default.as_deref().map_or(0, str::len))
            .saturating_add(column.extra.as_deref().map_or(0, str::len));
    }
    size
}

fn estimated_value_bytes(value: &Value) -> usize {
    match value {
        Value::Null => 4,
        Value::Bool(_) => 5,
        Value::Number(_) => 32,
        Value::String(value) => value.len(),
        Value::Array(values) => values
            .iter()
            .fold(2usize, |size, value| size.saturating_add(1).saturating_add(estimated_value_bytes(value))),
        Value::Object(values) => values.iter().fold(2usize, |size, (key, value)| {
            size.saturating_add(key.len()).saturating_add(2).saturating_add(estimated_value_bytes(value))
        }),
    }
}

fn input_too_large_error() -> DataGridExtractError {
    DataGridExtractError::new(
        DataGridExtractErrorCode::InputTooLarge,
        "Selected data is too large for clipboard extraction; export the data to a file instead.",
    )
}

struct WriteMetadata {
    mime_type: &'static str,
    file_extension: &'static str,
    omitted_columns: Vec<String>,
    warnings: Vec<DataGridExtractWarning>,
}

fn write_extraction(
    context: &ExtractContext<'_>,
    output: &mut dyn Write,
) -> Result<WriteMetadata, DataGridExtractError> {
    let extractor = context.request.extractor;
    match extractor {
        DataGridExtractorId::Raw => {
            if context.request.rows.len() != 1 || context.selected_source_indexes.len() != 1 {
                return Err(DataGridExtractError::new(
                    DataGridExtractErrorCode::InvalidRawSelection,
                    "The raw extractor supports exactly one selected cell.",
                ));
            }
            write_raw(context, output)?;
            Ok(text_metadata("text/plain", "txt"))
        }
        DataGridExtractorId::Tsv | DataGridExtractorId::TsvWithHeaders => {
            let options = DataGridDsvOptions {
                column_separator: "\t".to_string(),
                include_column_header: extractor == DataGridExtractorId::TsvWithHeaders,
                ..context.request.options.dsv.clone()
            };
            write_dsv(context, output, &options)?;
            Ok(text_metadata("text/tab-separated-values", "tsv"))
        }
        DataGridExtractorId::Csv | DataGridExtractorId::CsvWithHeaders => {
            let options = DataGridDsvOptions {
                column_separator: ",".to_string(),
                include_column_header: extractor == DataGridExtractorId::CsvWithHeaders,
                ..context.request.options.dsv.clone()
            };
            write_dsv(context, output, &options)?;
            Ok(text_metadata("text/csv", "csv"))
        }
        DataGridExtractorId::PipeSeparated => {
            let options =
                DataGridDsvOptions { column_separator: "|".to_string(), ..context.request.options.dsv.clone() };
            write_dsv(context, output, &options)?;
            Ok(text_metadata("text/plain", "txt"))
        }
        DataGridExtractorId::Dsv => {
            write_dsv(context, output, &context.request.options.dsv)?;
            Ok(text_metadata("text/plain", "txt"))
        }
        DataGridExtractorId::OneRow => {
            write_one_row(context, output)?;
            Ok(text_metadata("text/csv", "csv"))
        }
        DataGridExtractorId::Json => {
            let warnings = write_json(context, output)?;
            Ok(WriteMetadata {
                mime_type: "application/json",
                file_extension: "json",
                omitted_columns: Vec::new(),
                warnings,
            })
        }
        DataGridExtractorId::JsonLines => {
            let warnings = write_json_lines(context, output)?;
            Ok(WriteMetadata {
                mime_type: "application/x-ndjson",
                file_extension: "jsonl",
                omitted_columns: Vec::new(),
                warnings,
            })
        }
        DataGridExtractorId::SqlInList => {
            write_sql_in_list(context, output)?;
            Ok(text_metadata("application/sql", "sql"))
        }
        DataGridExtractorId::SqlInserts => write_sql_inserts(context, output),
        DataGridExtractorId::SqlUpdates => write_sql_updates(context, output),
        DataGridExtractorId::SqlSelect => {
            write_sql_select(context, output)?;
            Ok(text_metadata("application/sql", "sql"))
        }
        DataGridExtractorId::WhereClause => {
            write_where_clause(context, output)?;
            Ok(text_metadata("application/sql", "sql"))
        }
        DataGridExtractorId::Markdown => {
            write_markdown(context, output)?;
            Ok(text_metadata("text/markdown", "md"))
        }
        DataGridExtractorId::Html => {
            write_html(context, output)?;
            Ok(text_metadata("text/html", "html"))
        }
        DataGridExtractorId::Xml => {
            write_xml(context, output)?;
            Ok(text_metadata("application/xml", "xml"))
        }
        DataGridExtractorId::Pretty => {
            write_pretty(context, output)?;
            Ok(text_metadata("text/plain", "txt"))
        }
    }
}

fn text_metadata(mime_type: &'static str, extension: &'static str) -> WriteMetadata {
    WriteMetadata { mime_type, file_extension: extension, omitted_columns: Vec::new(), warnings: Vec::new() }
}

fn normalized_name_eq(left: &str, right: &str) -> bool {
    normalized_name(left).eq_ignore_ascii_case(normalized_name(right))
}

fn normalized_name(name: &str) -> &str {
    name.trim_matches(|character| matches!(character, '`' | '"' | '[' | ']'))
}

fn value_text(value: &Value) -> Cow<'_, str> {
    match value {
        Value::Null => Cow::Borrowed("NULL"),
        Value::String(value) => Cow::Borrowed(value),
        Value::Bool(value) => Cow::Owned(value.to_string()),
        Value::Number(value) => Cow::Owned(value.to_string()),
        Value::Array(_) | Value::Object(_) => Cow::Owned(value.to_string()),
    }
}

fn write_bytes(output: &mut dyn Write, bytes: &[u8]) -> Result<(), DataGridExtractError> {
    output.write_all(bytes).map_err(|error| {
        DataGridExtractError::new(
            DataGridExtractErrorCode::EncodingFailed,
            format!("Failed to write extractor output: {error}"),
        )
    })
}

#[cfg(test)]
mod tests;
