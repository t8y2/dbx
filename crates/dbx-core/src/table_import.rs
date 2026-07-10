use std::collections::HashSet;
use std::fs::File;
use std::path::Path;

use calamine::{open_workbook_auto, Data, Reader};
use chrono::{DateTime, NaiveDate, NaiveDateTime};
use serde::{Deserialize, Serialize};

use crate::connection::AppState;
use crate::models::connection::DatabaseType;
use crate::transfer::{
    execute_on_pool, generate_insert_typed, get_columns_for_transfer, qualified_table, quote_identifier,
};

pub const DEFAULT_PREVIEW_LIMIT: usize = 50;
pub const DEFAULT_BATCH_SIZE: usize = 500;
pub const CREATE_TABLE_INFERENCE_ROWS: usize = 100;
pub const MAX_NON_STREAMING_IMPORT_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct ParsedImportFile {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub total_rows: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportSqlBatch {
    pub sql: String,
    pub row_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportCreateTableColumn {
    pub name: String,
    pub data_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportCreateTablePlan {
    pub sql: String,
    pub columns: Vec<ImportCreateTableColumn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableImportColumnMapping {
    pub source_column: String,
    pub target_column: String,
    #[serde(default)]
    pub target_data_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TableImportMode {
    Append,
    Truncate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TableImportSourceFormat {
    Csv,
    Tsv,
    Delimited,
    Json,
    Excel,
}

impl TableImportSourceFormat {
    pub fn label(self) -> &'static str {
        match self {
            TableImportSourceFormat::Csv => "csv",
            TableImportSourceFormat::Tsv => "tsv",
            TableImportSourceFormat::Delimited => "txt",
            TableImportSourceFormat::Json => "json",
            TableImportSourceFormat::Excel => "excel",
        }
    }

    pub fn is_delimited(self) -> bool {
        matches!(self, TableImportSourceFormat::Csv | TableImportSourceFormat::Tsv | TableImportSourceFormat::Delimited)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TableImportJsonShape {
    Auto,
    Objects,
    Arrays,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableImportParseOptions {
    pub delimiter: Option<String>,
    pub has_header: Option<bool>,
    pub trim_values: Option<bool>,
    pub empty_string_as_null: Option<bool>,
    pub sheet_name: Option<String>,
    pub sheet_index: Option<usize>,
    pub json_shape: Option<TableImportJsonShape>,
}

impl Default for TableImportParseOptions {
    fn default() -> Self {
        Self {
            delimiter: None,
            has_header: None,
            trim_values: Some(false),
            empty_string_as_null: Some(true),
            sheet_name: None,
            sheet_index: None,
            json_shape: Some(TableImportJsonShape::Auto),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableImportPreviewRequest {
    pub file_path: String,
    #[serde(default)]
    pub source_ref: Option<String>,
    #[serde(default)]
    pub source_format: Option<TableImportSourceFormat>,
    #[serde(default)]
    pub parse_options: TableImportParseOptions,
    #[serde(default)]
    pub preview_limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableImportRequest {
    pub import_id: String,
    pub connection_id: String,
    pub database: String,
    pub schema: String,
    pub table: String,
    pub file_path: String,
    #[serde(default)]
    pub source_ref: Option<String>,
    #[serde(default)]
    pub source_format: Option<TableImportSourceFormat>,
    #[serde(default)]
    pub parse_options: TableImportParseOptions,
    pub mappings: Vec<TableImportColumnMapping>,
    pub mode: TableImportMode,
    #[serde(default)]
    pub create_table: bool,
    pub batch_size: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableImportPreview {
    pub file_name: String,
    pub file_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ref: Option<String>,
    pub file_type: String,
    pub size_bytes: u64,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub total_rows: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sheets: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableImportSummary {
    pub import_id: String,
    pub rows_imported: usize,
    pub total_rows: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableImportProgress {
    pub import_id: String,
    pub status: TableImportStatus,
    pub rows_imported: usize,
    pub total_rows: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TableImportStatus {
    Running,
    Done,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportFileKind {
    Csv,
    Tsv,
    Txt,
    Json,
    Xlsx,
}

impl ImportFileKind {
    pub fn label(self) -> &'static str {
        match self {
            ImportFileKind::Csv => "csv",
            ImportFileKind::Tsv => "tsv",
            ImportFileKind::Txt => "txt",
            ImportFileKind::Json => "json",
            ImportFileKind::Xlsx => "xlsx",
        }
    }
}

pub fn import_file_kind(path: &str) -> Result<ImportFileKind, String> {
    let lower = path.to_lowercase();
    if lower.ends_with(".csv") {
        Ok(ImportFileKind::Csv)
    } else if lower.ends_with(".tsv") {
        Ok(ImportFileKind::Tsv)
    } else if lower.ends_with(".txt") {
        Ok(ImportFileKind::Txt)
    } else if lower.ends_with(".json") {
        Ok(ImportFileKind::Json)
    } else if lower.ends_with(".xlsx") || lower.ends_with(".xlsm") || lower.ends_with(".xls") {
        Ok(ImportFileKind::Xlsx)
    } else {
        Err("Unsupported import file type".to_string())
    }
}

pub fn source_format_for_path(path: &str) -> Result<TableImportSourceFormat, String> {
    Ok(match import_file_kind(path)? {
        ImportFileKind::Csv => TableImportSourceFormat::Csv,
        ImportFileKind::Tsv => TableImportSourceFormat::Tsv,
        ImportFileKind::Txt => TableImportSourceFormat::Delimited,
        ImportFileKind::Json => TableImportSourceFormat::Json,
        ImportFileKind::Xlsx => TableImportSourceFormat::Excel,
    })
}

pub fn effective_source_format(
    path: &str,
    source_format: Option<TableImportSourceFormat>,
) -> Result<TableImportSourceFormat, String> {
    source_format
        .or_else(|| source_format_for_path(path).ok())
        .ok_or_else(|| "Unsupported import file type".to_string())
}

pub fn normalize_header(value: &str, index: usize) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        format!("column_{}", index + 1)
    } else {
        trimmed.to_string()
    }
}

#[derive(Debug, Clone, Copy)]
pub struct DelimitedParseConfig {
    pub delimiter: u8,
    pub has_header: bool,
    pub trim_values: bool,
    pub empty_string_as_null: bool,
}

pub fn effective_delimited_config(
    source_format: TableImportSourceFormat,
    options: &TableImportParseOptions,
) -> Result<DelimitedParseConfig, String> {
    let default_delimiter = match source_format {
        TableImportSourceFormat::Tsv => b'\t',
        _ => b',',
    };
    let delimiter = match options.delimiter.as_deref() {
        None | Some("") => default_delimiter,
        Some("\\t") | Some("tab") | Some("TAB") => b'\t',
        Some(value) => {
            let bytes = value.as_bytes();
            if bytes.len() != 1 {
                return Err("Delimiter must be a single-byte character".to_string());
            }
            bytes[0]
        }
    };

    Ok(DelimitedParseConfig {
        delimiter,
        has_header: options.has_header.unwrap_or(true),
        trim_values: options.trim_values.unwrap_or(false),
        empty_string_as_null: options.empty_string_as_null.unwrap_or(true),
    })
}

pub fn csv_value_with_config(value: &str, config: DelimitedParseConfig) -> serde_json::Value {
    let value = if config.trim_values { value.trim() } else { value };
    if config.empty_string_as_null && value.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::Value::String(value.to_string())
    }
}

pub fn csv_value(value: &str) -> serde_json::Value {
    csv_value_with_config(
        value,
        DelimitedParseConfig { delimiter: b',', has_header: true, trim_values: false, empty_string_as_null: true },
    )
}

pub fn parse_delimited_reader<R: std::io::Read>(
    reader: R,
    config: DelimitedParseConfig,
    preview_limit: usize,
) -> Result<ParsedImportFile, String> {
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(config.delimiter)
        .has_headers(config.has_header)
        .flexible(true)
        .from_reader(reader);

    let mut rows = Vec::new();
    let mut total_rows = 0;
    let columns = if config.has_header {
        reader
            .headers()
            .map_err(|e| e.to_string())?
            .iter()
            .enumerate()
            .map(|(index, header)| normalize_header(header.trim_start_matches('\u{feff}'), index))
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };

    let mut columns = columns;
    if columns.is_empty() {
        let mut records = reader.records();
        let first_record = match records.next() {
            Some(record) => record.map_err(|e| e.to_string())?,
            None => return Err("Import file has no rows".to_string()),
        };
        columns = (0..first_record.len()).map(|index| format!("column_{}", index + 1)).collect();
        if columns.is_empty() {
            return Err("Import file has no columns".to_string());
        }
        total_rows += 1;
        if preview_limit > 0 {
            rows.push(
                (0..columns.len())
                    .map(|index| {
                        first_record
                            .get(index)
                            .map(|value| csv_value_with_config(value, config))
                            .unwrap_or(serde_json::Value::Null)
                    })
                    .collect(),
            );
        }
        for record in records {
            let record = record.map_err(|e| e.to_string())?;
            total_rows += 1;
            if rows.len() >= preview_limit {
                continue;
            }
            let mut row = Vec::with_capacity(columns.len());
            for index in 0..columns.len() {
                row.push(
                    record
                        .get(index)
                        .map(|value| csv_value_with_config(value, config))
                        .unwrap_or(serde_json::Value::Null),
                );
            }
            rows.push(row);
        }
        return Ok(ParsedImportFile { columns, rows, total_rows });
    }

    for record in reader.records() {
        let record = record.map_err(|e| e.to_string())?;
        total_rows += 1;
        if rows.len() >= preview_limit {
            continue;
        }
        let mut row = Vec::with_capacity(columns.len());
        for index in 0..columns.len() {
            row.push(
                record.get(index).map(|value| csv_value_with_config(value, config)).unwrap_or(serde_json::Value::Null),
            );
        }
        rows.push(row);
    }

    Ok(ParsedImportFile { columns, rows, total_rows })
}

pub fn parse_delimited_bytes_with_options(
    bytes: &[u8],
    source_format: TableImportSourceFormat,
    options: &TableImportParseOptions,
    preview_limit: usize,
) -> Result<ParsedImportFile, String> {
    parse_delimited_reader(
        bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes),
        effective_delimited_config(source_format, options)?,
        preview_limit,
    )
}

pub fn parse_delimited_file_with_options(
    path: &str,
    source_format: TableImportSourceFormat,
    options: &TableImportParseOptions,
    preview_limit: usize,
) -> Result<ParsedImportFile, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    parse_delimited_reader(file, effective_delimited_config(source_format, options)?, preview_limit)
}

pub fn parse_csv_bytes(bytes: &[u8], preview_limit: usize) -> Result<ParsedImportFile, String> {
    parse_delimited_bytes_with_options(
        bytes,
        TableImportSourceFormat::Csv,
        &TableImportParseOptions::default(),
        preview_limit,
    )
}

pub fn parse_delimited_bytes(bytes: &[u8], delimiter: u8, preview_limit: usize) -> Result<ParsedImportFile, String> {
    let options = TableImportParseOptions {
        delimiter: Some(if delimiter == b'\t' { "\\t".to_string() } else { (delimiter as char).to_string() }),
        ..TableImportParseOptions::default()
    };
    parse_delimited_bytes_with_options(bytes, TableImportSourceFormat::Delimited, &options, preview_limit)
}

pub fn parse_json_bytes_with_options(
    bytes: &[u8],
    options: &TableImportParseOptions,
    preview_limit: usize,
) -> Result<ParsedImportFile, String> {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let items = match value {
        serde_json::Value::Array(items) => items,
        serde_json::Value::Object(_) => vec![value],
        _ => return Err("JSON import must be an object or an array".to_string()),
    };
    if items.is_empty() {
        return Err("Import file has no rows".to_string());
    }

    let shape = options.json_shape.unwrap_or(TableImportJsonShape::Auto);
    let all_objects = items.iter().all(|item| item.is_object());
    let all_arrays = items.iter().all(|item| item.is_array());

    if shape == TableImportJsonShape::Objects && !all_objects {
        return Err("JSON import is configured for object rows, but at least one row is not an object".to_string());
    }
    if shape == TableImportJsonShape::Arrays && !all_arrays {
        return Err("JSON import is configured for array rows, but at least one row is not an array".to_string());
    }

    if all_objects {
        let mut columns = Vec::new();
        for item in &items {
            if let Some(obj) = item.as_object() {
                for key in obj.keys() {
                    if !columns.contains(key) {
                        columns.push(key.clone());
                    }
                }
            }
        }
        if columns.is_empty() {
            return Err("Import file has no columns".to_string());
        }
        let rows = items
            .iter()
            .take(preview_limit)
            .map(|item| {
                let obj = item.as_object().expect("checked object JSON row");
                columns
                    .iter()
                    .map(|column| obj.get(column).cloned().unwrap_or(serde_json::Value::Null))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        return Ok(ParsedImportFile { columns, rows, total_rows: items.len() });
    }

    if all_arrays {
        let max_cols = items.iter().filter_map(|item| item.as_array().map(|row| row.len())).max().unwrap_or(0);
        if max_cols == 0 {
            return Err("Import file has no columns".to_string());
        }
        let columns = (0..max_cols).map(|index| format!("column_{}", index + 1)).collect::<Vec<_>>();
        let rows = items
            .iter()
            .take(preview_limit)
            .map(|item| {
                let arr = item.as_array().expect("checked array JSON row");
                (0..max_cols)
                    .map(|index| arr.get(index).cloned().unwrap_or(serde_json::Value::Null))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        return Ok(ParsedImportFile { columns, rows, total_rows: items.len() });
    }

    Err("JSON rows must all be objects or all be arrays; mixed row shapes are not supported".to_string())
}

pub fn parse_json_bytes(bytes: &[u8], preview_limit: usize) -> Result<ParsedImportFile, String> {
    parse_json_bytes_with_options(bytes, &TableImportParseOptions::default(), preview_limit)
}

pub fn xlsx_cell_value(cell: &Data) -> serde_json::Value {
    match cell {
        Data::Empty => serde_json::Value::Null,
        Data::String(s) => csv_value(s),
        Data::Float(n) => {
            serde_json::Number::from_f64(*n).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
        }
        Data::Int(n) => serde_json::Value::Number((*n).into()),
        Data::Bool(v) => serde_json::Value::Bool(*v),
        Data::DateTime(v) => serde_json::Value::String(v.to_string()),
        Data::DateTimeIso(v) => serde_json::Value::String(v.clone()),
        Data::DurationIso(v) => serde_json::Value::String(v.clone()),
        Data::Error(v) => serde_json::Value::String(v.to_string()),
    }
}

pub fn xlsx_cell_label(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Float(n) => n.to_string(),
        Data::Int(n) => n.to_string(),
        Data::Bool(v) => v.to_string(),
        Data::DateTime(v) => v.to_string(),
        Data::DateTimeIso(v) => v.clone(),
        Data::DurationIso(v) => v.clone(),
        Data::Error(v) => v.to_string(),
    }
}

pub fn xlsx_sheet_names(path: &str) -> Result<Vec<String>, String> {
    let workbook = open_workbook_auto(path).map_err(|e| e.to_string())?;
    Ok(workbook.sheet_names().to_vec())
}

pub fn parse_xlsx_file_with_options(
    path: &str,
    options: &TableImportParseOptions,
    preview_limit: usize,
) -> Result<ParsedImportFile, String> {
    let mut workbook = open_workbook_auto(path).map_err(|e| e.to_string())?;
    let sheet_names = workbook.sheet_names().to_vec();
    let sheet_name = if let Some(name) = options.sheet_name.as_ref().filter(|name| !name.trim().is_empty()) {
        if !sheet_names.iter().any(|sheet| sheet == name) {
            return Err(format!("Workbook sheet not found: {name}"));
        }
        name.clone()
    } else if let Some(index) = options.sheet_index {
        sheet_names.get(index).cloned().ok_or_else(|| format!("Workbook sheet index out of range: {index}"))?
    } else {
        sheet_names.first().cloned().ok_or_else(|| "Workbook has no sheets".to_string())?
    };
    let range = workbook.worksheet_range(&sheet_name).map_err(|e| e.to_string())?;
    let mut rows_iter = range.rows();
    let has_header = options.has_header.unwrap_or(true);
    let columns = if has_header {
        let header = rows_iter.next().ok_or_else(|| "Import file has no rows".to_string())?;
        header
            .iter()
            .enumerate()
            .map(|(index, cell)| normalize_header(&xlsx_cell_label(cell), index))
            .collect::<Vec<_>>()
    } else {
        let first_row = rows_iter.next().ok_or_else(|| "Import file has no rows".to_string())?;
        let columns = (0..first_row.len()).map(|index| format!("column_{}", index + 1)).collect::<Vec<_>>();
        let mut rows = Vec::new();
        if preview_limit > 0 {
            rows.push(
                (0..columns.len())
                    .map(|index| first_row.get(index).map(xlsx_cell_value).unwrap_or(serde_json::Value::Null))
                    .collect::<Vec<_>>(),
            );
        }
        let mut total_rows = 1;
        for source_row in rows_iter {
            total_rows += 1;
            if rows.len() >= preview_limit {
                continue;
            }
            let mut row = Vec::with_capacity(columns.len());
            for index in 0..columns.len() {
                row.push(source_row.get(index).map(xlsx_cell_value).unwrap_or(serde_json::Value::Null));
            }
            rows.push(row);
        }
        return Ok(ParsedImportFile { columns, rows, total_rows });
    };
    if columns.is_empty() {
        return Err("Import file has no columns".to_string());
    }

    let mut rows = Vec::new();
    let mut total_rows = 0;
    for source_row in rows_iter {
        total_rows += 1;
        if rows.len() >= preview_limit {
            continue;
        }
        let mut row = Vec::with_capacity(columns.len());
        for index in 0..columns.len() {
            row.push(source_row.get(index).map(xlsx_cell_value).unwrap_or(serde_json::Value::Null));
        }
        rows.push(row);
    }

    Ok(ParsedImportFile { columns, rows, total_rows })
}

pub fn parse_xlsx_file(path: &str, preview_limit: usize) -> Result<ParsedImportFile, String> {
    parse_xlsx_file_with_options(path, &TableImportParseOptions::default(), preview_limit)
}

fn ensure_non_streaming_file_size(path: &str, format: TableImportSourceFormat) -> Result<(), String> {
    if format.is_delimited() {
        return Ok(());
    }
    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_NON_STREAMING_IMPORT_BYTES {
        return Err(format!(
            "File too large for {} import: {} bytes (max {} bytes)",
            format.label(),
            metadata.len(),
            MAX_NON_STREAMING_IMPORT_BYTES
        ));
    }
    Ok(())
}

pub async fn parse_import_file_with_options(
    path: &str,
    source_format: Option<TableImportSourceFormat>,
    options: &TableImportParseOptions,
    preview_limit: usize,
) -> Result<ParsedImportFile, String> {
    let format = effective_source_format(path, source_format)?;
    ensure_non_streaming_file_size(path, format)?;
    match format {
        TableImportSourceFormat::Csv | TableImportSourceFormat::Tsv | TableImportSourceFormat::Delimited => {
            let path = path.to_string();
            let options = options.clone();
            tokio::task::spawn_blocking(move || {
                parse_delimited_file_with_options(&path, format, &options, preview_limit)
            })
            .await
            .map_err(|e| e.to_string())?
        }
        TableImportSourceFormat::Json => {
            let bytes = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
            parse_json_bytes_with_options(&bytes, options, preview_limit)
        }
        TableImportSourceFormat::Excel => {
            let path = path.to_string();
            let options = options.clone();
            tokio::task::spawn_blocking(move || parse_xlsx_file_with_options(&path, &options, preview_limit))
                .await
                .map_err(|e| e.to_string())?
        }
    }
}

pub async fn parse_import_file(path: &str, preview_limit: usize) -> Result<ParsedImportFile, String> {
    parse_import_file_with_options(path, None, &TableImportParseOptions::default(), preview_limit).await
}

pub fn mapping_indexes(
    data: &ParsedImportFile,
    mappings: &[TableImportColumnMapping],
) -> Result<Vec<(usize, String)>, String> {
    mapping_indexes_for_columns(&data.columns, mappings)
}

pub fn mapping_indexes_for_columns(
    columns: &[String],
    mappings: &[TableImportColumnMapping],
) -> Result<Vec<(usize, String)>, String> {
    mapping_indexes_with_mappings(columns, mappings).map(|mapped| {
        mapped.into_iter().map(|(source_index, mapping)| (source_index, mapping.target_column.clone())).collect()
    })
}

fn mapping_indexes_with_mappings<'a>(
    columns: &[String],
    mappings: &'a [TableImportColumnMapping],
) -> Result<Vec<(usize, &'a TableImportColumnMapping)>, String> {
    if mappings.is_empty() {
        return Err("No columns mapped for import".to_string());
    }
    let mut mapped = Vec::new();
    let mut target_seen = HashSet::new();
    for mapping in mappings {
        let source_index = columns
            .iter()
            .position(|column| column == &mapping.source_column)
            .ok_or_else(|| format!("Source column not found: {}", mapping.source_column))?;
        if mapping.target_column.trim().is_empty() {
            return Err("Target column cannot be empty".to_string());
        }
        if !target_seen.insert(mapping.target_column.clone()) {
            return Err(format!("Target column mapped more than once: {}", mapping.target_column));
        }
        mapped.push((source_index, mapping));
    }
    Ok(mapped)
}

pub fn build_import_insert_batch_from_rows(
    rows: &[Vec<serde_json::Value>],
    columns: &[String],
    mappings: &[TableImportColumnMapping],
    target_column_types: &[(String, String)],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
) -> Result<Option<ImportSqlBatch>, String> {
    if rows.is_empty() {
        return Ok(None);
    }
    let mapped = mapping_indexes_for_columns(columns, mappings)?;
    let target_columns = mapped.iter().map(|(_, target)| target.clone()).collect::<Vec<_>>();
    let column_types = target_columns
        .iter()
        .map(|column| {
            target_column_types
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case(column))
                .map(|(_, data_type)| data_type.clone())
        })
        .collect::<Vec<_>>();
    let mapped_rows = rows
        .iter()
        .map(|row| {
            mapped
                .iter()
                .map(|(source_index, _)| row.get(*source_index).cloned().unwrap_or(serde_json::Value::Null))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let sql = generate_insert_typed(&target_columns, &column_types, &mapped_rows, table, schema, db_type);
    Ok((!sql.trim().is_empty()).then_some(ImportSqlBatch { sql, row_count: rows.len() }))
}

pub fn build_import_insert_batches(
    data: &ParsedImportFile,
    mappings: &[TableImportColumnMapping],
    target_column_types: &[(String, String)],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    batch_size: usize,
) -> Result<Vec<ImportSqlBatch>, String> {
    let mapped = mapping_indexes(data, mappings)?;
    let columns = mapped.iter().map(|(_, target)| target.clone()).collect::<Vec<_>>();
    let column_types = columns
        .iter()
        .map(|column| {
            target_column_types
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case(column))
                .map(|(_, data_type)| data_type.clone())
        })
        .collect::<Vec<_>>();
    let batch_size = match db_type {
        // Oracle-compatible drivers reject INSERT ... VALUES (...), (...), so
        // keep import batches executable as single-row statements.
        DatabaseType::Oracle | DatabaseType::OceanbaseOracle => 1,
        _ => batch_size.max(1),
    };
    let mut batches = Vec::new();

    for chunk in data.rows.chunks(batch_size) {
        let rows = chunk
            .iter()
            .map(|row| {
                mapped
                    .iter()
                    .map(|(source_index, _)| row.get(*source_index).cloned().unwrap_or(serde_json::Value::Null))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        let sql = generate_insert_typed(&columns, &column_types, &rows, table, schema, db_type);
        if !sql.trim().is_empty() {
            batches.push(ImportSqlBatch { sql, row_count: chunk.len() });
        }
    }

    Ok(batches)
}

pub fn truncate_sql(table: &str, schema: &str, db_type: &DatabaseType) -> String {
    let full_table = qualified_table(table, schema, db_type);
    match db_type {
        DatabaseType::Sqlite => format!("DELETE FROM {full_table}"),
        _ => format!("TRUNCATE TABLE {full_table}"),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImportInferredType {
    Boolean,
    Integer,
    Decimal,
    Date,
    Timestamp,
    Json,
    Text,
}

fn merge_inferred_type(current: Option<ImportInferredType>, next: ImportInferredType) -> ImportInferredType {
    let Some(current) = current else {
        return next;
    };
    if current == next {
        return current;
    }
    match (current, next) {
        (ImportInferredType::Text, _) | (_, ImportInferredType::Text) => ImportInferredType::Text,
        (ImportInferredType::Integer, ImportInferredType::Decimal)
        | (ImportInferredType::Decimal, ImportInferredType::Integer) => ImportInferredType::Decimal,
        (ImportInferredType::Date, ImportInferredType::Timestamp)
        | (ImportInferredType::Timestamp, ImportInferredType::Date) => ImportInferredType::Timestamp,
        _ => ImportInferredType::Text,
    }
}

fn has_numeric_leading_zero(value: &str) -> bool {
    let unsigned = value.trim_start_matches(['+', '-']);
    let bytes = unsigned.as_bytes();
    bytes.len() > 1 && bytes[0] == b'0' && bytes[1].is_ascii_digit()
}

fn is_likely_date(value: &str) -> bool {
    ["%Y-%m-%d", "%Y/%m/%d"].iter().any(|format| NaiveDate::parse_from_str(value, format).is_ok())
}

fn is_likely_timestamp(value: &str) -> bool {
    if DateTime::parse_from_rfc3339(value).is_ok() {
        return true;
    }
    ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f", "%Y/%m/%d %H:%M:%S%.f", "%Y/%m/%dT%H:%M:%S%.f"]
        .iter()
        .any(|format| NaiveDateTime::parse_from_str(value, format).is_ok())
}

fn infer_string_type(value: &str) -> ImportInferredType {
    let value = value.trim();
    if value.is_empty() {
        return ImportInferredType::Text;
    }
    if is_likely_timestamp(value) {
        return ImportInferredType::Timestamp;
    }
    if is_likely_date(value) {
        return ImportInferredType::Date;
    }
    if !has_numeric_leading_zero(value) {
        if value.parse::<i64>().is_ok() || value.parse::<u64>().is_ok() {
            return ImportInferredType::Integer;
        }
        if (value.contains('.') || value.contains('e') || value.contains('E'))
            && value.parse::<f64>().is_ok_and(|number| number.is_finite())
        {
            return ImportInferredType::Decimal;
        }
    }
    ImportInferredType::Text
}

fn infer_value_type(value: &serde_json::Value) -> Option<ImportInferredType> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::Bool(_) => Some(ImportInferredType::Boolean),
        serde_json::Value::Number(number) => {
            if number.is_i64() || number.is_u64() {
                Some(ImportInferredType::Integer)
            } else {
                Some(ImportInferredType::Decimal)
            }
        }
        serde_json::Value::String(value) => Some(infer_string_type(value)),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => Some(ImportInferredType::Json),
    }
}

fn infer_column_type(rows: &[Vec<serde_json::Value>], source_index: usize) -> ImportInferredType {
    let mut inferred = None;
    for row in rows {
        let Some(value_type) = row.get(source_index).and_then(infer_value_type) else {
            continue;
        };
        inferred = Some(merge_inferred_type(inferred, value_type));
        if inferred == Some(ImportInferredType::Text) {
            break;
        }
    }
    inferred.unwrap_or(ImportInferredType::Text)
}

fn text_data_type(db_type: &DatabaseType) -> &'static str {
    match db_type {
        DatabaseType::SqlServer => "NVARCHAR(MAX)",
        DatabaseType::Oracle | DatabaseType::OceanbaseOracle | DatabaseType::Dameng => "CLOB",
        DatabaseType::ClickHouse => "String",
        DatabaseType::Hive | DatabaseType::Trino | DatabaseType::PrestoSql | DatabaseType::Databricks => "STRING",
        _ => "TEXT",
    }
}

fn integer_data_type(db_type: &DatabaseType) -> &'static str {
    match db_type {
        DatabaseType::Sqlite | DatabaseType::Rqlite | DatabaseType::Turso => "INTEGER",
        DatabaseType::Oracle | DatabaseType::OceanbaseOracle | DatabaseType::Dameng => "NUMBER(19)",
        DatabaseType::ClickHouse => "Int64",
        _ => "BIGINT",
    }
}

fn decimal_data_type(db_type: &DatabaseType) -> &'static str {
    match db_type {
        DatabaseType::Postgres
        | DatabaseType::Gaussdb
        | DatabaseType::OpenGauss
        | DatabaseType::Redshift
        | DatabaseType::Kingbase
        | DatabaseType::Highgo
        | DatabaseType::Kwdb
        | DatabaseType::Vastbase => "DOUBLE PRECISION",
        DatabaseType::Sqlite | DatabaseType::Rqlite | DatabaseType::Turso => "REAL",
        DatabaseType::Oracle | DatabaseType::OceanbaseOracle | DatabaseType::Dameng => "BINARY_DOUBLE",
        DatabaseType::ClickHouse => "Float64",
        _ => "DOUBLE",
    }
}

fn boolean_data_type(db_type: &DatabaseType) -> &'static str {
    match db_type {
        DatabaseType::Mysql
        | DatabaseType::Doris
        | DatabaseType::StarRocks
        | DatabaseType::Goldendb
        | DatabaseType::Sundb
        | DatabaseType::Databend => "TINYINT(1)",
        DatabaseType::SqlServer => "BIT",
        DatabaseType::Sqlite | DatabaseType::Rqlite | DatabaseType::Turso => "INTEGER",
        DatabaseType::Oracle | DatabaseType::OceanbaseOracle | DatabaseType::Dameng => "NUMBER(1)",
        DatabaseType::ClickHouse => "UInt8",
        _ => "BOOLEAN",
    }
}

fn date_data_type(db_type: &DatabaseType) -> &'static str {
    match db_type {
        DatabaseType::Sqlite | DatabaseType::Rqlite | DatabaseType::Turso => "TEXT",
        DatabaseType::ClickHouse => "Date",
        _ => "DATE",
    }
}

fn timestamp_data_type(db_type: &DatabaseType) -> &'static str {
    match db_type {
        DatabaseType::Mysql
        | DatabaseType::Doris
        | DatabaseType::StarRocks
        | DatabaseType::Goldendb
        | DatabaseType::Sundb
        | DatabaseType::Databend => "DATETIME",
        DatabaseType::SqlServer => "DATETIME2",
        DatabaseType::Sqlite | DatabaseType::Rqlite | DatabaseType::Turso => "TEXT",
        DatabaseType::ClickHouse => "DateTime64",
        _ => "TIMESTAMP",
    }
}

fn json_data_type(db_type: &DatabaseType) -> &'static str {
    match db_type {
        DatabaseType::Postgres
        | DatabaseType::Gaussdb
        | DatabaseType::OpenGauss
        | DatabaseType::Kingbase
        | DatabaseType::Highgo
        | DatabaseType::Kwdb
        | DatabaseType::Vastbase => "JSONB",
        DatabaseType::Mysql | DatabaseType::Databend => "JSON",
        _ => text_data_type(db_type),
    }
}

fn import_data_type(inferred_type: ImportInferredType, db_type: &DatabaseType) -> String {
    match inferred_type {
        ImportInferredType::Boolean => boolean_data_type(db_type),
        ImportInferredType::Integer => integer_data_type(db_type),
        ImportInferredType::Decimal => decimal_data_type(db_type),
        ImportInferredType::Date => date_data_type(db_type),
        ImportInferredType::Timestamp => timestamp_data_type(db_type),
        ImportInferredType::Json => json_data_type(db_type),
        ImportInferredType::Text => text_data_type(db_type),
    }
    .to_string()
}

fn normalize_import_target_data_type(mapping: &TableImportColumnMapping) -> Result<Option<String>, String> {
    let Some(raw_data_type) = mapping.target_data_type.as_deref() else {
        return Ok(None);
    };
    let data_type = raw_data_type.trim();
    if data_type.is_empty() {
        return Err(format!("Target data type cannot be empty: {}", mapping.target_column));
    }
    validate_import_target_data_type(data_type)?;
    Ok(Some(data_type.to_string()))
}

fn validate_import_target_data_type(data_type: &str) -> Result<(), String> {
    let lowered = data_type.to_ascii_lowercase();
    if data_type.contains(';')
        || lowered.contains("--")
        || lowered.contains("/*")
        || lowered.contains("*/")
        || data_type.chars().any(char::is_control)
    {
        return Err(format!("Unsupported target data type syntax: {data_type}"));
    }

    // A user-entered type is a DDL fragment, so keep it constrained to one type
    // expression and reject separators that could add another column or clause.
    let mut paren_depth = 0usize;
    for ch in data_type.chars() {
        match ch {
            '(' => paren_depth += 1,
            ')' => {
                paren_depth = paren_depth
                    .checked_sub(1)
                    .ok_or_else(|| format!("Unsupported target data type syntax: {data_type}"))?;
            }
            ',' if paren_depth == 0 => {
                return Err(format!("Unsupported target data type syntax: {data_type}"));
            }
            _ => {}
        }
    }
    if paren_depth != 0 {
        return Err(format!("Unsupported target data type syntax: {data_type}"));
    }
    Ok(())
}

pub fn build_import_create_table_plan(
    data: &ParsedImportFile,
    mappings: &[TableImportColumnMapping],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
) -> Result<ImportCreateTablePlan, String> {
    if table.trim().is_empty() {
        return Err("Target table name is required".to_string());
    }
    let mapped = mapping_indexes_with_mappings(&data.columns, mappings)?;
    let mut columns = Vec::with_capacity(mapped.len());
    for (source_index, mapping) in mapped {
        let data_type = match normalize_import_target_data_type(mapping)? {
            Some(data_type) => data_type,
            None => {
                let inferred_type = infer_column_type(&data.rows, source_index);
                import_data_type(inferred_type, db_type)
            }
        };
        columns.push(ImportCreateTableColumn { name: mapping.target_column.clone(), data_type });
    }
    if columns.is_empty() {
        return Err("No columns mapped for import".to_string());
    }

    let full_table = qualified_table(table.trim(), schema, db_type);
    let column_sql = columns
        .iter()
        .map(|column| format!("{} {}", quote_identifier(&column.name, db_type), column.data_type))
        .collect::<Vec<_>>()
        .join(",\n  ");
    let engine_clause =
        if matches!(db_type, DatabaseType::ClickHouse) { " ENGINE = MergeTree() ORDER BY tuple()" } else { "" };
    Ok(ImportCreateTablePlan { sql: format!("CREATE TABLE {full_table} (\n  {column_sql}\n){engine_clause}"), columns })
}

fn import_error_message(request: &TableImportRequest, rows_imported: usize, error: impl AsRef<str>) -> String {
    format!("Import into table '{}' failed after {} imported rows: {}", request.table, rows_imported, error.as_ref())
}

fn emit_import_error<F>(
    progress_callback: &mut F,
    request: &TableImportRequest,
    rows_imported: usize,
    total_rows: usize,
    error: impl AsRef<str>,
) -> String
where
    F: FnMut(TableImportProgress),
{
    let message = import_error_message(request, rows_imported, error);
    progress_callback(TableImportProgress {
        import_id: request.import_id.clone(),
        status: TableImportStatus::Error,
        rows_imported,
        total_rows,
        error: Some(message.clone()),
    });
    message
}

fn delimited_record_to_row(
    record: &csv::StringRecord,
    columns_len: usize,
    config: DelimitedParseConfig,
) -> Vec<serde_json::Value> {
    (0..columns_len)
        .map(|index| {
            record.get(index).map(|value| csv_value_with_config(value, config)).unwrap_or(serde_json::Value::Null)
        })
        .collect()
}

fn delimited_columns_and_first_record<R: std::io::Read>(
    reader: &mut csv::Reader<R>,
    config: DelimitedParseConfig,
) -> Result<(Vec<String>, Option<csv::StringRecord>), String> {
    if config.has_header {
        let columns = reader
            .headers()
            .map_err(|e| e.to_string())?
            .iter()
            .enumerate()
            .map(|(index, header)| normalize_header(header.trim_start_matches('\u{feff}'), index))
            .collect::<Vec<_>>();
        if columns.is_empty() {
            return Err("Import file has no columns".to_string());
        }
        return Ok((columns, None));
    }

    let mut records = reader.records();
    let first_record =
        records.next().transpose().map_err(|e| e.to_string())?.ok_or_else(|| "Import file has no rows".to_string())?;
    let columns = (0..first_record.len()).map(|index| format!("column_{}", index + 1)).collect::<Vec<_>>();
    if columns.is_empty() {
        return Err("Import file has no columns".to_string());
    }
    Ok((columns, Some(first_record)))
}

pub async fn preview_table_import_file_with_request(
    request: TableImportPreviewRequest,
) -> Result<TableImportPreview, String> {
    let format = effective_source_format(&request.file_path, request.source_format)?;
    let parsed = parse_import_file_with_options(
        &request.file_path,
        Some(format),
        &request.parse_options,
        request.preview_limit.unwrap_or(DEFAULT_PREVIEW_LIMIT),
    )
    .await?;
    let metadata = tokio::fs::metadata(&request.file_path).await.map_err(|e| e.to_string())?;
    let file_name = Path::new(&request.file_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&request.file_path)
        .to_string();
    let sheets = if matches!(format, TableImportSourceFormat::Excel) {
        let file_path = request.file_path.clone();
        tokio::task::spawn_blocking(move || xlsx_sheet_names(&file_path))
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    Ok(TableImportPreview {
        file_name,
        file_path: request.file_path,
        source_ref: request.source_ref,
        file_type: format.label().to_string(),
        size_bytes: metadata.len(),
        columns: parsed.columns,
        rows: parsed.rows,
        total_rows: parsed.total_rows,
        sheets,
    })
}

pub async fn preview_table_import_file_core(file_path: &str) -> Result<TableImportPreview, String> {
    preview_table_import_file_with_request(TableImportPreviewRequest {
        file_path: file_path.to_string(),
        source_ref: None,
        source_format: None,
        parse_options: TableImportParseOptions::default(),
        preview_limit: Some(DEFAULT_PREVIEW_LIMIT),
    })
    .await
}

/// Core import logic. Returns (rows_imported, total_rows).
/// `progress_callback` is invoked for progress updates.
pub async fn import_table_file_core<F>(
    state: &AppState,
    request: &TableImportRequest,
    db_type: &DatabaseType,
    pool_key: &str,
    is_cancelled: impl Fn(&str) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>>,
    mut progress_callback: F,
) -> Result<TableImportSummary, String>
where
    F: FnMut(TableImportProgress),
{
    let batch_size = if request.batch_size == 0 { DEFAULT_BATCH_SIZE } else { request.batch_size };
    let source_format = match effective_source_format(&request.file_path, request.source_format) {
        Ok(format) => format,
        Err(error) => {
            return Err(emit_import_error(&mut progress_callback, request, 0, 0, error));
        }
    };

    if let Err(error) = tokio::fs::metadata(&request.file_path).await {
        return Err(emit_import_error(
            &mut progress_callback,
            request,
            0,
            0,
            format!("Import source is no longer available: {error}"),
        ));
    }

    let mut create_table_sample: Option<ParsedImportFile> = None;
    let mut created_column_types: Option<Vec<(String, String)>> = None;
    if request.create_table {
        if matches!(request.mode, TableImportMode::Truncate) {
            return Err(emit_import_error(
                &mut progress_callback,
                request,
                0,
                0,
                "Cannot truncate a table that is being created by the import",
            ));
        }
        let parsed = match parse_import_file_with_options(
            &request.file_path,
            Some(source_format),
            &request.parse_options,
            CREATE_TABLE_INFERENCE_ROWS,
        )
        .await
        {
            Ok(parsed) => parsed,
            Err(error) => {
                return Err(emit_import_error(&mut progress_callback, request, 0, 0, error));
            }
        };
        let total_rows = parsed.total_rows;
        let plan = match build_import_create_table_plan(
            &parsed,
            &request.mappings,
            &request.table,
            &request.schema,
            db_type,
        ) {
            Ok(plan) => plan,
            Err(error) => {
                return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, error));
            }
        };
        // The table must be created before streaming rows so existing import batching
        // can reuse the same INSERT path and database-specific value escaping.
        if let Err(error) = execute_on_pool(state, pool_key, &plan.sql).await {
            return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, error));
        }
        created_column_types =
            Some(plan.columns.iter().map(|column| (column.name.clone(), column.data_type.clone())).collect());
        create_table_sample = Some(parsed);
    }

    if source_format.is_delimited() {
        let parsed = if let Some(parsed) = create_table_sample.clone() {
            parsed
        } else {
            match parse_import_file_with_options(&request.file_path, Some(source_format), &request.parse_options, 0)
                .await
            {
                Ok(parsed) => parsed,
                Err(error) => {
                    return Err(emit_import_error(&mut progress_callback, request, 0, 0, error));
                }
            }
        };
        let total_rows = parsed.total_rows;
        if let Err(error) = mapping_indexes_for_columns(&parsed.columns, &request.mappings) {
            return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, error));
        }

        progress_callback(TableImportProgress {
            import_id: request.import_id.clone(),
            status: TableImportStatus::Running,
            rows_imported: 0,
            total_rows,
            error: None,
        });

        let mut target_column_types = get_columns_for_transfer(
            state,
            pool_key,
            &request.connection_id,
            &request.database,
            &request.schema,
            &request.table,
        )
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|column| (column.name, column.data_type))
        .collect::<Vec<_>>();
        if target_column_types.is_empty() {
            target_column_types = created_column_types.clone().unwrap_or_default();
        }

        if matches!(request.mode, TableImportMode::Truncate) {
            let sql = truncate_sql(&request.table, &request.schema, db_type);
            if let Err(error) = execute_on_pool(state, pool_key, &sql).await {
                return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, error));
            }
        }

        let config = match effective_delimited_config(source_format, &request.parse_options) {
            Ok(config) => config,
            Err(error) => return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, error)),
        };
        let file = match File::open(&request.file_path) {
            Ok(file) => file,
            Err(error) => {
                return Err(emit_import_error(
                    &mut progress_callback,
                    request,
                    0,
                    total_rows,
                    format!("Import source is no longer available: {error}"),
                ));
            }
        };
        let mut reader = csv::ReaderBuilder::new()
            .delimiter(config.delimiter)
            .has_headers(config.has_header)
            .flexible(true)
            .from_reader(file);
        let (columns, first_record) = match delimited_columns_and_first_record(&mut reader, config) {
            Ok(result) => result,
            Err(error) => return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, error)),
        };
        let effective_batch_size = match db_type {
            DatabaseType::Oracle | DatabaseType::OceanbaseOracle => 1,
            _ => batch_size.max(1),
        };
        let mut rows_imported = 0;
        let mut pending_rows: Vec<Vec<serde_json::Value>> = Vec::with_capacity(effective_batch_size);

        if let Some(record) = first_record {
            pending_rows.push(delimited_record_to_row(&record, columns.len(), config));
        }

        for record in reader.records() {
            if is_cancelled(&request.import_id).await {
                progress_callback(TableImportProgress {
                    import_id: request.import_id.clone(),
                    status: TableImportStatus::Cancelled,
                    rows_imported,
                    total_rows,
                    error: None,
                });
                return Err("Import cancelled".to_string());
            }

            let record = match record {
                Ok(record) => record,
                Err(error) => {
                    return Err(emit_import_error(
                        &mut progress_callback,
                        request,
                        rows_imported,
                        total_rows,
                        error.to_string(),
                    ))
                }
            };
            pending_rows.push(delimited_record_to_row(&record, columns.len(), config));

            if pending_rows.len() >= effective_batch_size {
                let batch = match build_import_insert_batch_from_rows(
                    &pending_rows,
                    &columns,
                    &request.mappings,
                    &target_column_types,
                    &request.table,
                    &request.schema,
                    db_type,
                ) {
                    Ok(Some(batch)) => batch,
                    Ok(None) => {
                        pending_rows.clear();
                        continue;
                    }
                    Err(error) => {
                        return Err(emit_import_error(
                            &mut progress_callback,
                            request,
                            rows_imported,
                            total_rows,
                            error,
                        ))
                    }
                };
                if let Err(error) = execute_on_pool(state, pool_key, &batch.sql).await {
                    return Err(emit_import_error(&mut progress_callback, request, rows_imported, total_rows, error));
                }
                rows_imported = (rows_imported + batch.row_count).min(total_rows);
                pending_rows.clear();
                progress_callback(TableImportProgress {
                    import_id: request.import_id.clone(),
                    status: TableImportStatus::Running,
                    rows_imported,
                    total_rows,
                    error: None,
                });
            }
        }

        if !pending_rows.is_empty() {
            if is_cancelled(&request.import_id).await {
                progress_callback(TableImportProgress {
                    import_id: request.import_id.clone(),
                    status: TableImportStatus::Cancelled,
                    rows_imported,
                    total_rows,
                    error: None,
                });
                return Err("Import cancelled".to_string());
            }
            let batch = match build_import_insert_batch_from_rows(
                &pending_rows,
                &columns,
                &request.mappings,
                &target_column_types,
                &request.table,
                &request.schema,
                db_type,
            ) {
                Ok(Some(batch)) => batch,
                Ok(None) => ImportSqlBatch { sql: String::new(), row_count: 0 },
                Err(error) => {
                    return Err(emit_import_error(&mut progress_callback, request, rows_imported, total_rows, error))
                }
            };
            if !batch.sql.is_empty() {
                if let Err(error) = execute_on_pool(state, pool_key, &batch.sql).await {
                    return Err(emit_import_error(&mut progress_callback, request, rows_imported, total_rows, error));
                }
                rows_imported = (rows_imported + batch.row_count).min(total_rows);
            }
        }

        progress_callback(TableImportProgress {
            import_id: request.import_id.clone(),
            status: TableImportStatus::Done,
            rows_imported,
            total_rows,
            error: None,
        });

        return Ok(TableImportSummary { import_id: request.import_id.clone(), rows_imported, total_rows });
    }

    let parsed = match parse_import_file_with_options(
        &request.file_path,
        Some(source_format),
        &request.parse_options,
        usize::MAX,
    )
    .await
    {
        Ok(parsed) => parsed,
        Err(error) => {
            return Err(emit_import_error(&mut progress_callback, request, 0, 0, error));
        }
    };

    let total_rows = parsed.total_rows;
    if let Err(error) = mapping_indexes(&parsed, &request.mappings) {
        return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, error));
    }
    progress_callback(TableImportProgress {
        import_id: request.import_id.clone(),
        status: TableImportStatus::Running,
        rows_imported: 0,
        total_rows,
        error: None,
    });

    let mut target_column_types = get_columns_for_transfer(
        state,
        pool_key,
        &request.connection_id,
        &request.database,
        &request.schema,
        &request.table,
    )
    .await
    .unwrap_or_default()
    .into_iter()
    .map(|column| (column.name, column.data_type))
    .collect::<Vec<_>>();
    if target_column_types.is_empty() {
        target_column_types = created_column_types.clone().unwrap_or_default();
    }

    let batches = match build_import_insert_batches(
        &parsed,
        &request.mappings,
        &target_column_types,
        &request.table,
        &request.schema,
        db_type,
        batch_size,
    ) {
        Ok(batches) => batches,
        Err(error) => {
            return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, error));
        }
    };

    if matches!(request.mode, TableImportMode::Truncate) {
        let sql = truncate_sql(&request.table, &request.schema, db_type);
        if let Err(error) = execute_on_pool(state, pool_key, &sql).await {
            return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, error));
        }
    }

    let mut rows_imported = 0;
    for batch in batches {
        if is_cancelled(&request.import_id).await {
            progress_callback(TableImportProgress {
                import_id: request.import_id.clone(),
                status: TableImportStatus::Cancelled,
                rows_imported,
                total_rows,
                error: None,
            });
            return Err("Import cancelled".to_string());
        }

        if let Err(error) = execute_on_pool(state, pool_key, &batch.sql).await {
            return Err(emit_import_error(&mut progress_callback, request, rows_imported, total_rows, error));
        }
        rows_imported = (rows_imported + batch.row_count).min(total_rows);
        progress_callback(TableImportProgress {
            import_id: request.import_id.clone(),
            status: TableImportStatus::Running,
            rows_imported,
            total_rows,
            error: None,
        });
    }

    progress_callback(TableImportProgress {
        import_id: request.import_id.clone(),
        status: TableImportStatus::Done,
        rows_imported,
        total_rows,
        error: None,
    });

    Ok(TableImportSummary { import_id: request.import_id.clone(), rows_imported, total_rows })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::connection::DatabaseType;
    use crate::xlsx_export::{build_xlsx_workbook_multi, XlsxWorksheetData};

    #[test]
    fn parses_csv_headers_and_preview_rows() {
        let parsed = parse_csv_bytes(b"id,name,active\n1,Ada,true\n2,,false\n", 10).unwrap();

        assert_eq!(parsed.columns, vec!["id", "name", "active"]);
        assert_eq!(parsed.total_rows, 2);
        assert_eq!(
            parsed.rows[0],
            vec![
                serde_json::Value::String("1".to_string()),
                serde_json::Value::String("Ada".to_string()),
                serde_json::Value::String("true".to_string()),
            ]
        );
        assert_eq!(
            parsed.rows[1],
            vec![
                serde_json::Value::String("2".to_string()),
                serde_json::Value::Null,
                serde_json::Value::String("false".to_string()),
            ]
        );
    }

    #[test]
    fn parses_tsv_with_tab_delimiter() {
        let parsed = parse_delimited_bytes(b"id\tname\n1\tAda\n", b'\t', 10).unwrap();

        assert_eq!(parsed.columns, vec!["id", "name"]);
        assert_eq!(parsed.total_rows, 1);
        assert_eq!(
            parsed.rows[0],
            vec![serde_json::Value::String("1".to_string()), serde_json::Value::String("Ada".to_string()),]
        );
    }

    #[test]
    fn parses_delimited_text_without_header_and_trims_values() {
        let options = TableImportParseOptions {
            delimiter: Some("|".to_string()),
            has_header: Some(false),
            trim_values: Some(true),
            empty_string_as_null: Some(true),
            ..TableImportParseOptions::default()
        };
        let parsed = parse_delimited_bytes_with_options(
            b" 1 | Ada \n 2 |   \n",
            TableImportSourceFormat::Delimited,
            &options,
            10,
        )
        .unwrap();

        assert_eq!(parsed.columns, vec!["column_1", "column_2"]);
        assert_eq!(parsed.total_rows, 2);
        assert_eq!(parsed.rows[0], vec![serde_json::json!("1"), serde_json::json!("Ada")]);
        assert_eq!(parsed.rows[1], vec![serde_json::json!("2"), serde_json::Value::Null]);
    }

    #[test]
    fn parses_json_array_objects_with_union_columns() {
        let parsed = parse_json_bytes(br#"[{"id":1,"name":"Ada"},{"id":2,"active":true}]"#, 10).unwrap();

        assert_eq!(parsed.columns, vec!["id", "name", "active"]);
        assert_eq!(parsed.total_rows, 2);
        assert_eq!(parsed.rows[0], vec![serde_json::json!(1), serde_json::json!("Ada"), serde_json::Value::Null,]);
        assert_eq!(parsed.rows[1], vec![serde_json::json!(2), serde_json::Value::Null, serde_json::json!(true),]);
    }

    #[test]
    fn parses_json_with_utf8_bom() {
        let parsed = parse_json_bytes(b"\xEF\xBB\xBF[{\"id\":1,\"name\":\"Ada\"}]", 10).unwrap();

        assert_eq!(parsed.columns, vec!["id", "name"]);
        assert_eq!(parsed.total_rows, 1);
        assert_eq!(parsed.rows[0], vec![serde_json::json!(1), serde_json::json!("Ada")]);
    }

    #[test]
    fn json_shape_option_rejects_wrong_row_shape() {
        let options = TableImportParseOptions {
            json_shape: Some(TableImportJsonShape::Objects),
            ..TableImportParseOptions::default()
        };
        let error = parse_json_bytes_with_options(br#"[["id","name"],[1,"Ada"]]"#, &options, 10).unwrap_err();

        assert!(error.contains("configured for object rows"));
    }

    #[test]
    fn parses_selected_excel_sheet() {
        let path = std::env::temp_dir().join(format!("dbx-table-import-{}.xlsx", uuid::Uuid::new_v4()));
        let workbook = build_xlsx_workbook_multi(&[
            XlsxWorksheetData {
                sheet_name: Some("First".to_string()),
                columns: vec!["id".to_string()],
                rows: vec![vec![serde_json::json!(1)]],
            },
            XlsxWorksheetData {
                sheet_name: Some("Second".to_string()),
                columns: vec!["name".to_string()],
                rows: vec![vec![serde_json::json!("Ada")]],
            },
        ])
        .unwrap();
        std::fs::write(&path, workbook).unwrap();

        let options =
            TableImportParseOptions { sheet_name: Some("Second".to_string()), ..TableImportParseOptions::default() };
        let parsed = parse_xlsx_file_with_options(&path.to_string_lossy(), &options, 10).unwrap();

        assert_eq!(xlsx_sheet_names(&path.to_string_lossy()).unwrap(), vec!["First", "Second"]);
        assert_eq!(parsed.columns, vec!["name"]);
        assert_eq!(parsed.rows, vec![vec![serde_json::json!("Ada")]]);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn builds_create_table_plan_from_import_sample() {
        let data = ParsedImportFile {
            columns: vec![
                "id".to_string(),
                "code".to_string(),
                "amount".to_string(),
                "created_at".to_string(),
                "active".to_string(),
                "payload".to_string(),
            ],
            rows: vec![
                vec![
                    serde_json::json!("1"),
                    serde_json::json!("00123"),
                    serde_json::json!("12.5"),
                    serde_json::json!("2026-07-06 12:30:45"),
                    serde_json::json!("true"),
                    serde_json::json!({ "source": "csv" }),
                ],
                vec![
                    serde_json::json!("2"),
                    serde_json::json!("00456"),
                    serde_json::json!("13.75"),
                    serde_json::json!("2026-07-07 08:15:00"),
                    serde_json::json!("false"),
                    serde_json::json!({ "source": "json" }),
                ],
            ],
            total_rows: 2,
        };
        let mappings = data
            .columns
            .iter()
            .map(|column| TableImportColumnMapping {
                source_column: column.clone(),
                target_column: column.clone(),
                target_data_type: None,
            })
            .collect::<Vec<_>>();

        let plan =
            build_import_create_table_plan(&data, &mappings, "orders", "public", &DatabaseType::Postgres).unwrap();

        assert_eq!(
            plan.sql,
            "CREATE TABLE \"public\".\"orders\" (\n  \"id\" BIGINT,\n  \"code\" TEXT,\n  \"amount\" DOUBLE PRECISION,\n  \"created_at\" TIMESTAMP,\n  \"active\" TEXT,\n  \"payload\" JSONB\n)"
        );
        assert_eq!(
            plan.columns,
            vec![
                ImportCreateTableColumn { name: "id".to_string(), data_type: "BIGINT".to_string() },
                ImportCreateTableColumn { name: "code".to_string(), data_type: "TEXT".to_string() },
                ImportCreateTableColumn { name: "amount".to_string(), data_type: "DOUBLE PRECISION".to_string() },
                ImportCreateTableColumn { name: "created_at".to_string(), data_type: "TIMESTAMP".to_string() },
                ImportCreateTableColumn { name: "active".to_string(), data_type: "TEXT".to_string() },
                ImportCreateTableColumn { name: "payload".to_string(), data_type: "JSONB".to_string() },
            ]
        );
    }

    #[test]
    fn create_table_plan_requires_target_table_name() {
        let data =
            ParsedImportFile { columns: vec!["id".to_string()], rows: vec![vec![serde_json::json!(1)]], total_rows: 1 };
        let mappings = vec![TableImportColumnMapping {
            source_column: "id".to_string(),
            target_column: "id".to_string(),
            target_data_type: None,
        }];

        let error = build_import_create_table_plan(&data, &mappings, " ", "", &DatabaseType::Mysql).unwrap_err();

        assert_eq!(error, "Target table name is required");
    }

    #[test]
    fn create_table_plan_uses_database_specific_text_type() {
        let data = ParsedImportFile {
            columns: vec!["notes".to_string()],
            rows: vec![vec![serde_json::json!("long text")]],
            total_rows: 1,
        };
        let mappings = vec![TableImportColumnMapping {
            source_column: "notes".to_string(),
            target_column: "notes".to_string(),
            target_data_type: None,
        }];

        let plan = build_import_create_table_plan(&data, &mappings, "events", "dbo", &DatabaseType::SqlServer).unwrap();

        assert_eq!(plan.sql, "CREATE TABLE [dbo].[events] (\n  [notes] NVARCHAR(MAX)\n)");
    }

    #[test]
    fn create_table_plan_uses_user_defined_column_type() {
        let data = ParsedImportFile {
            columns: vec!["code".to_string(), "amount".to_string()],
            rows: vec![vec![serde_json::json!("1001"), serde_json::json!("12.5")]],
            total_rows: 1,
        };
        let mappings = vec![
            TableImportColumnMapping {
                source_column: "code".to_string(),
                target_column: "code".to_string(),
                target_data_type: Some("VARCHAR(32)".to_string()),
            },
            TableImportColumnMapping {
                source_column: "amount".to_string(),
                target_column: "amount".to_string(),
                target_data_type: Some("DECIMAL(10,2)".to_string()),
            },
        ];

        let plan = build_import_create_table_plan(&data, &mappings, "invoice", "", &DatabaseType::Mysql).unwrap();

        assert_eq!(plan.sql, "CREATE TABLE `invoice` (\n  `code` VARCHAR(32),\n  `amount` DECIMAL(10,2)\n)");
        assert_eq!(
            plan.columns,
            vec![
                ImportCreateTableColumn { name: "code".to_string(), data_type: "VARCHAR(32)".to_string() },
                ImportCreateTableColumn { name: "amount".to_string(), data_type: "DECIMAL(10,2)".to_string() },
            ]
        );
    }

    #[test]
    fn create_table_plan_rejects_unsafe_user_defined_column_type() {
        let data = ParsedImportFile {
            columns: vec!["name".to_string()],
            rows: vec![vec![serde_json::json!("Ada")]],
            total_rows: 1,
        };
        let mappings = vec![TableImportColumnMapping {
            source_column: "name".to_string(),
            target_column: "name".to_string(),
            target_data_type: Some("TEXT, injected INT".to_string()),
        }];

        let error = build_import_create_table_plan(&data, &mappings, "users", "", &DatabaseType::Mysql).unwrap_err();

        assert!(error.contains("Unsupported target data type syntax"));
    }

    #[test]
    fn builds_import_insert_batches_from_mapped_columns() {
        let mappings = vec![
            TableImportColumnMapping {
                source_column: "id".to_string(),
                target_column: "user_id".to_string(),
                target_data_type: None,
            },
            TableImportColumnMapping {
                source_column: "name".to_string(),
                target_column: "display_name".to_string(),
                target_data_type: None,
            },
        ];
        let data = ParsedImportFile {
            columns: vec!["id".to_string(), "name".to_string(), "ignored".to_string()],
            rows: vec![
                vec![serde_json::json!(1), serde_json::json!("Ada"), serde_json::json!("x")],
                vec![serde_json::json!(2), serde_json::json!("O'Hara"), serde_json::json!("y")],
                vec![serde_json::json!(3), serde_json::Value::Null, serde_json::json!("z")],
            ],
            total_rows: 3,
        };

        let batches =
            build_import_insert_batches(&data, &mappings, &[], "users", "public", &DatabaseType::Postgres, 2).unwrap();

        assert_eq!(batches, vec![
            ImportSqlBatch {
                sql: "INSERT INTO \"public\".\"users\" (\"user_id\", \"display_name\") VALUES\n(1, 'Ada'),\n(2, 'O''Hara')".to_string(),
                row_count: 2,
            },
            ImportSqlBatch {
                sql: "INSERT INTO \"public\".\"users\" (\"user_id\", \"display_name\") VALUES\n(3, NULL)".to_string(),
                row_count: 1,
            },
        ]);
    }

    #[test]
    fn duplicate_mapping_is_rejected_before_sql_generation() {
        let columns = vec!["id".to_string(), "name".to_string()];
        let mappings = vec![
            TableImportColumnMapping {
                source_column: "id".to_string(),
                target_column: "target".to_string(),
                target_data_type: None,
            },
            TableImportColumnMapping {
                source_column: "name".to_string(),
                target_column: "target".to_string(),
                target_data_type: None,
            },
        ];

        let error = mapping_indexes_for_columns(&columns, &mappings).unwrap_err();

        assert!(error.contains("mapped more than once"));
    }

    #[test]
    fn builds_single_streaming_import_batch_from_rows() {
        let columns = vec!["id".to_string(), "name".to_string()];
        let mappings = vec![
            TableImportColumnMapping {
                source_column: "id".to_string(),
                target_column: "id".to_string(),
                target_data_type: None,
            },
            TableImportColumnMapping {
                source_column: "name".to_string(),
                target_column: "name".to_string(),
                target_data_type: None,
            },
        ];
        let rows = vec![vec![serde_json::json!(1), serde_json::json!("Ada")]];

        let batch = build_import_insert_batch_from_rows(
            &rows,
            &columns,
            &mappings,
            &[],
            "users",
            "public",
            &DatabaseType::Postgres,
        )
        .unwrap()
        .unwrap();

        assert_eq!(batch.sql, "INSERT INTO \"public\".\"users\" (\"id\", \"name\") VALUES\n(1, 'Ada')");
        assert_eq!(batch.row_count, 1);
    }

    #[tokio::test]
    async fn preview_missing_source_fails_before_parsing() {
        let path = std::env::temp_dir().join(format!("dbx-missing-import-{}.csv", uuid::Uuid::new_v4()));
        let error = preview_table_import_file_with_request(TableImportPreviewRequest {
            file_path: path.to_string_lossy().to_string(),
            source_ref: Some("missing".to_string()),
            source_format: Some(TableImportSourceFormat::Csv),
            parse_options: TableImportParseOptions::default(),
            preview_limit: Some(10),
        })
        .await
        .unwrap_err();

        assert!(error.contains("No such file") || error.contains("os error"));
    }

    #[test]
    fn oracle_import_insert_batches_use_single_row_statements() {
        let mappings = vec![
            TableImportColumnMapping {
                source_column: "id".to_string(),
                target_column: "id".to_string(),
                target_data_type: None,
            },
            TableImportColumnMapping {
                source_column: "name".to_string(),
                target_column: "name".to_string(),
                target_data_type: None,
            },
        ];
        let data = ParsedImportFile {
            columns: vec!["id".to_string(), "name".to_string()],
            rows: vec![
                vec![serde_json::json!(1), serde_json::json!("Ada")],
                vec![serde_json::json!(2), serde_json::json!("Grace")],
                vec![serde_json::json!(3), serde_json::Value::Null],
            ],
            total_rows: 3,
        };

        let batches =
            build_import_insert_batches(&data, &mappings, &[], "users", "HR", &DatabaseType::Oracle, 500).unwrap();

        assert_eq!(
            batches,
            vec![
                ImportSqlBatch {
                    sql: "INSERT INTO \"HR\".\"users\" (\"id\", \"name\") VALUES\n(1, 'Ada')".to_string(),
                    row_count: 1,
                },
                ImportSqlBatch {
                    sql: "INSERT INTO \"HR\".\"users\" (\"id\", \"name\") VALUES\n(2, 'Grace')".to_string(),
                    row_count: 1,
                },
                ImportSqlBatch {
                    sql: "INSERT INTO \"HR\".\"users\" (\"id\", \"name\") VALUES\n(3, NULL)".to_string(),
                    row_count: 1,
                },
            ]
        );
    }

    #[test]
    fn import_insert_batches_use_target_column_types_for_mysql_temporal_values() {
        let mappings = vec![
            TableImportColumnMapping {
                source_column: "start".to_string(),
                target_column: "insurance_start_time".to_string(),
                target_data_type: None,
            },
            TableImportColumnMapping {
                source_column: "raw".to_string(),
                target_column: "raw_text".to_string(),
                target_data_type: None,
            },
        ];
        let data = ParsedImportFile {
            columns: vec!["start".to_string(), "raw".to_string()],
            rows: vec![vec![
                serde_json::json!("2026-05-12T00:00:00+00:00"),
                serde_json::json!("2026-05-12T00:00:00+00:00"),
            ]],
            total_rows: 1,
        };

        let batches = build_import_insert_batches(
            &data,
            &mappings,
            &[
                ("insurance_start_time".to_string(), "datetime".to_string()),
                ("raw_text".to_string(), "varchar(64)".to_string()),
            ],
            "policies",
            "",
            &DatabaseType::Mysql,
            500,
        )
        .unwrap();

        assert_eq!(batches, vec![ImportSqlBatch {
            sql: "INSERT INTO `policies` (`insurance_start_time`, `raw_text`) VALUES\n('2026-05-12 00:00:00', '2026-05-12T00:00:00+00:00')".to_string(),
            row_count: 1,
        }]);
    }

    #[test]
    fn import_insert_batches_preserve_sqlserver_unicode_text() {
        let mappings = vec![TableImportColumnMapping {
            source_column: "name".to_string(),
            target_column: "name".to_string(),
            target_data_type: None,
        }];
        let data = ParsedImportFile {
            columns: vec!["name".to_string()],
            rows: vec![vec![serde_json::json!("Tiếng Việt")]],
            total_rows: 1,
        };

        let batches = build_import_insert_batches(
            &data,
            &mappings,
            &[("name".to_string(), "nvarchar(100)".to_string())],
            "customers",
            "dbo",
            &DatabaseType::SqlServer,
            500,
        )
        .unwrap();

        assert_eq!(
            batches,
            vec![ImportSqlBatch {
                sql: "INSERT INTO [dbo].[customers] ([name]) VALUES\n(N'Tiếng Việt')".to_string(),
                row_count: 1,
            }]
        );
    }
}
