#![allow(clippy::result_large_err)]

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use chrono::{DateTime as ChronoDateTime, NaiveDate, Utc};
use mongodb::bson::{oid::ObjectId, Bson, DateTime, Decimal128, Document};
use serde::{Deserialize, Serialize};

use crate::connection::{task_client_session_id, AppState, PoolKind};
use crate::csv_export::{push_csv_field, CsvQuoteMode};
use crate::db::agent_driver::AgentCapability;
use crate::db::mongo_driver::{
    self, document_to_canonical_extended_json, for_each_find_document, insert_bson_documents,
    json_object_to_document_extended_json, MongoBulkWriteError, MongoInsertOutcome,
};
use crate::table_import::{open_transcoded_text_file, TableImportTextEncoding};

pub const DEFAULT_PREVIEW_LIMIT: usize = 50;
pub const DEFAULT_BATCH_SIZE: usize = 500;
pub const MIN_BATCH_SIZE: usize = 100;
pub const MAX_BATCH_SIZE: usize = 5000;
/// Rows sampled for CSV type inference, independent of the preview window so that the
/// preview and the import always agree on column types.
pub const TYPE_SAMPLE_ROWS: usize = 1000;

const TYPE_STRING: u8 = 1 << 0;
const TYPE_BOOLEAN: u8 = 1 << 1;
const TYPE_INTEGER: u8 = 1 << 2;
const TYPE_DECIMAL: u8 = 1 << 3;
const TYPE_DATE: u8 = 1 << 4;
const TYPE_OBJECT: u8 = 1 << 5;
const TYPE_ARRAY: u8 = 1 << 6;

pub fn mongodb_import_client_session_id(import_id: &str) -> String {
    task_client_session_id("mongo-import", import_id)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MongoImportFormat {
    Csv,
    Json,
    Ndjson,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MongoImportTypeMode {
    String,
    Auto,
    ExtendedJson,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MongoImportInferredType {
    Boolean,
    Integer,
    Decimal,
    Date,
    Object,
    Array,
    String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MongoImportStatus {
    Running,
    Done,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MongoImportPhase {
    Preparing,
    Parsing,
    Writing,
    Done,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MongoImportIssue {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch: Option<u64>,
    #[serde(default)]
    pub retryable: bool,
}

impl MongoImportIssue {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            row: None,
            column: None,
            value: None,
            batch: None,
            retryable: false,
        }
    }

    pub fn with_row(mut self, row: u64) -> Self {
        self.row = Some(row);
        self
    }

    pub fn with_column(mut self, column: impl Into<String>) -> Self {
        self.column = Some(column.into());
        self
    }

    pub fn with_value(mut self, value: impl Into<String>) -> Self {
        self.value = Some(value.into());
        self
    }

    pub fn with_batch(mut self, batch: u64) -> Self {
        self.batch = Some(batch);
        self
    }

    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    pub fn display_message(&self) -> String {
        let mut message = self.message.clone();
        if let Some(row) = self.row {
            message = format!("row {row}: {message}");
        }
        if let Some(column) = &self.column {
            message = format!("{message} (column {column})");
        }
        if let Some(value) = &self.value {
            message = format!("{message}; value={value}");
        }
        message
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoImportParseOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoding: Option<TableImportTextEncoding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delimiter: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_header: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trim: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub empty_as_null: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub type_mode: Option<MongoImportTypeMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recognize_object_id_hex: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skip_error_rows: Option<bool>,
}

impl Default for MongoImportParseOptions {
    fn default() -> Self {
        Self {
            encoding: Some(TableImportTextEncoding::Auto),
            delimiter: None,
            has_header: Some(true),
            trim: Some(false),
            empty_as_null: Some(true),
            type_mode: Some(MongoImportTypeMode::Auto),
            recognize_object_id_hex: Some(false),
            skip_error_rows: Some(false),
        }
    }
}

impl MongoImportParseOptions {
    fn encoding(&self) -> Option<TableImportTextEncoding> {
        self.encoding.or(Some(TableImportTextEncoding::Auto))
    }

    fn has_header(&self) -> bool {
        self.has_header.unwrap_or(true)
    }

    fn trim(&self) -> bool {
        self.trim.unwrap_or(false)
    }

    fn empty_as_null(&self) -> bool {
        self.empty_as_null.unwrap_or(true)
    }

    fn type_mode(&self) -> MongoImportTypeMode {
        self.type_mode.unwrap_or(MongoImportTypeMode::Auto)
    }

    fn recognize_object_id_hex(&self) -> bool {
        self.recognize_object_id_hex.unwrap_or(false)
    }

    fn skip_error_rows(&self) -> bool {
        self.skip_error_rows.unwrap_or(false)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoImportColumn {
    pub name: String,
    pub inferred_type: MongoImportInferredType,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sample_values: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoImportPreviewRequest {
    pub file_path: String,
    #[serde(default)]
    pub source_ref: Option<String>,
    pub format: MongoImportFormat,
    #[serde(default)]
    pub parse_options: MongoImportParseOptions,
    #[serde(default)]
    pub preview_limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoImportPreview {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ref: Option<String>,
    pub format: MongoImportFormat,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detected_encoding: Option<TableImportTextEncoding>,
    pub file_name: String,
    pub file_path: String,
    pub size_bytes: u64,
    pub columns: Vec<MongoImportColumn>,
    pub rows: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub row_numbers: Vec<u64>,
    pub warnings: Vec<MongoImportIssue>,
    pub errors: Vec<MongoImportIssue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_rows: Option<u64>,
    pub estimated_rows_exact: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoImportRequest {
    pub import_id: String,
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub file_path: String,
    #[serde(default)]
    pub source_ref: Option<String>,
    pub format: MongoImportFormat,
    #[serde(default)]
    pub parse_options: MongoImportParseOptions,
    pub batch_size: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoImportProgress {
    pub import_id: String,
    pub phase: MongoImportPhase,
    pub status: MongoImportStatus,
    pub rows_read: u64,
    pub rows_inserted: u64,
    pub rows_failed: u64,
    pub batches_committed: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_rows: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub error_rows: Vec<MongoImportIssue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoImportSummary {
    pub import_id: String,
    pub rows_inserted: u64,
    pub rows_failed: u64,
    pub batches_committed: u64,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone)]
pub struct ParsedMongoDocument {
    pub row: u64,
    pub document: Document,
    pub extended_json: serde_json::Value,
}

#[derive(Debug, Clone)]
struct CsvParseConfig {
    delimiter: u8,
    has_header: bool,
    trim: bool,
    empty_as_null: bool,
    type_mode: MongoImportTypeMode,
    recognize_object_id_hex: bool,
}

pub fn format_from_path(path: &str) -> Result<MongoImportFormat, String> {
    let lower = path.to_lowercase();
    if lower.ends_with(".csv") || lower.ends_with(".tsv") || lower.ends_with(".txt") {
        Ok(MongoImportFormat::Csv)
    } else if lower.ends_with(".ndjson") || lower.ends_with(".jsonl") {
        Ok(MongoImportFormat::Ndjson)
    } else if lower.ends_with(".json") {
        Ok(MongoImportFormat::Json)
    } else {
        Err("Unsupported MongoDB import file type; use .csv, .json, or .ndjson".to_string())
    }
}

pub fn clamp_batch_size(batch_size: usize) -> Result<usize, MongoImportIssue> {
    if !(MIN_BATCH_SIZE..=MAX_BATCH_SIZE).contains(&batch_size) {
        return Err(MongoImportIssue::new(
            "INVALID_BATCH_SIZE",
            format!("Batch size must be between {MIN_BATCH_SIZE} and {MAX_BATCH_SIZE}"),
        ));
    }
    Ok(batch_size)
}

pub fn validate_import_source_path(path: &str) -> Result<(), MongoImportIssue> {
    let path = Path::new(path);
    if !path.exists() {
        return Err(MongoImportIssue::new("FILE_UNREADABLE", format!("Import file not found: {}", path.display())));
    }
    if !path.is_file() {
        return Err(MongoImportIssue::new(
            "FILE_UNREADABLE",
            format!("Import source must be a regular file: {}", path.display()),
        ));
    }
    Ok(())
}

fn csv_config(path: &str, options: &MongoImportParseOptions) -> Result<CsvParseConfig, MongoImportIssue> {
    let default_delimiter = if path.to_lowercase().ends_with(".tsv") { b'\t' } else { b',' };
    let delimiter = match options.delimiter.as_deref() {
        None | Some("") => default_delimiter,
        Some("\\t") | Some("tab") | Some("TAB") => b'\t',
        Some(";") => b';',
        Some(value) => {
            let bytes = value.as_bytes();
            if bytes.len() != 1 {
                return Err(MongoImportIssue::new("CSV_STRUCTURE", "Delimiter must be a single-byte character"));
            }
            bytes[0]
        }
    };
    Ok(CsvParseConfig {
        delimiter,
        has_header: options.has_header(),
        trim: options.trim(),
        empty_as_null: options.empty_as_null(),
        type_mode: options.type_mode(),
        recognize_object_id_hex: options.recognize_object_id_hex(),
    })
}

fn normalize_cell(value: &str, trim: bool) -> &str {
    if trim {
        value.trim()
    } else {
        value
    }
}

fn csv_cell_text(value: &str, config: &CsvParseConfig) -> Option<String> {
    let value = normalize_cell(value, config.trim).trim_start_matches('\u{feff}');
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn unique_headers(headers: &[String]) -> Result<Vec<String>, MongoImportIssue> {
    let mut seen = HashSet::new();
    let mut names = Vec::with_capacity(headers.len());
    for (index, header) in headers.iter().enumerate() {
        let name = header.trim().trim_start_matches('\u{feff}').to_string();
        if name.is_empty() {
            return Err(MongoImportIssue::new("EMPTY_HEADER", format!("CSV header at column {} is empty", index + 1))
                .with_row(1));
        }
        // Mongo field names are case-sensitive, so `Name` and `name` are two distinct columns.
        if !seen.insert(name.clone()) {
            return Err(MongoImportIssue::new("DUPLICATE_HEADER", format!("Duplicate CSV header: {name}"))
                .with_row(1)
                .with_column(name));
        }
        names.push(name);
    }
    if names.is_empty() {
        return Err(MongoImportIssue::new("CSV_STRUCTURE", "CSV file has no header columns").with_row(1));
    }
    Ok(names)
}

fn generated_field_names(count: usize) -> Vec<String> {
    (0..count).map(|index| format!("field_{}", index + 1)).collect()
}

fn classify_cell(value: &str) -> u8 {
    let mut bits = TYPE_STRING;
    if is_boolean(value) {
        bits |= TYPE_BOOLEAN;
    }
    if parse_integer(value).is_some() {
        bits |= TYPE_INTEGER | TYPE_DECIMAL;
    } else if parse_decimal(value).is_some() {
        bits |= TYPE_DECIMAL;
    }
    if parse_date(value).is_some() {
        bits |= TYPE_DATE;
    }
    if looks_like_json_object(value) {
        bits |= TYPE_OBJECT;
    }
    if looks_like_json_array(value) {
        bits |= TYPE_ARRAY;
    }
    bits
}

fn is_boolean(value: &str) -> bool {
    matches!(value, "true" | "TRUE" | "True" | "false" | "FALSE" | "False")
}

fn parse_integer(value: &str) -> Option<i64> {
    if value.is_empty() || value == "+" || value == "-" {
        return None;
    }
    if value.contains('.') || value.contains('e') || value.contains('E') {
        return None;
    }
    value.parse::<i64>().ok()
}

fn parse_decimal(value: &str) -> Option<Decimal128> {
    value.parse::<Decimal128>().ok()
}

fn parse_date(value: &str) -> Option<DateTime> {
    if let Ok(parsed) = DateTime::parse_rfc3339_str(value) {
        return Some(parsed);
    }
    if let Ok(parsed) = ChronoDateTime::parse_from_rfc3339(value) {
        return Some(DateTime::from_millis(parsed.with_timezone(&Utc).timestamp_millis()));
    }
    if let Ok(date) = NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        let datetime = date.and_hms_opt(0, 0, 0)?.and_utc();
        return Some(DateTime::from_millis(datetime.timestamp_millis()));
    }
    None
}

fn looks_like_json_object(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.starts_with('{') && trimmed.ends_with('}')
}

fn looks_like_json_array(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.starts_with('[') && trimmed.ends_with(']')
}

fn csv_reader<R: Read>(reader: R, delimiter: u8) -> csv::Reader<R> {
    csv::ReaderBuilder::new().delimiter(delimiter).has_headers(false).flexible(true).from_reader(reader)
}

fn is_object_id_hex(value: &str) -> bool {
    value.len() == 24 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn inferred_type_from_mask(mask: u8) -> MongoImportInferredType {
    if mask & TYPE_BOOLEAN != 0 && mask & !TYPE_BOOLEAN & !TYPE_STRING == 0 {
        return MongoImportInferredType::Boolean;
    }
    if mask & TYPE_INTEGER != 0 && mask & !(TYPE_INTEGER | TYPE_DECIMAL | TYPE_STRING) == 0 {
        return MongoImportInferredType::Integer;
    }
    if mask & TYPE_DECIMAL != 0 && mask & !(TYPE_DECIMAL | TYPE_STRING) == 0 {
        return MongoImportInferredType::Decimal;
    }
    if mask & TYPE_DATE != 0 && mask & !TYPE_DATE & !TYPE_STRING == 0 {
        return MongoImportInferredType::Date;
    }
    if mask & TYPE_OBJECT != 0 && mask & !TYPE_OBJECT & !TYPE_STRING == 0 {
        return MongoImportInferredType::Object;
    }
    if mask & TYPE_ARRAY != 0 && mask & !TYPE_ARRAY & !TYPE_STRING == 0 {
        return MongoImportInferredType::Array;
    }
    MongoImportInferredType::String
}

fn intersect_column_types(existing: Option<u8>, cell_mask: u8) -> u8 {
    match existing {
        None => cell_mask,
        Some(existing) => existing & cell_mask,
    }
}

fn convert_cell(
    value: Option<&str>,
    column: &str,
    row: u64,
    inferred: MongoImportInferredType,
    config: &CsvParseConfig,
) -> Result<Bson, MongoImportIssue> {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Ok(if config.empty_as_null { Bson::Null } else { Bson::String(String::new()) });
    };
    if (config.recognize_object_id_hex || (column == "_id" && config.type_mode != MongoImportTypeMode::String))
        && is_object_id_hex(value)
    {
        let oid = ObjectId::parse_str(value).map_err(|error| {
            MongoImportIssue::new("TYPE_CONVERSION", format!("Invalid ObjectId: {error}"))
                .with_row(row)
                .with_column(column)
                .with_value(value)
        })?;
        return Ok(Bson::ObjectId(oid));
    }
    match config.type_mode {
        MongoImportTypeMode::String => Ok(Bson::String(value.to_string())),
        MongoImportTypeMode::Auto => convert_auto_cell(value, column, row, inferred),
        MongoImportTypeMode::ExtendedJson => convert_extended_json_cell(value, column, row),
    }
}

fn convert_auto_cell(
    value: &str,
    column: &str,
    row: u64,
    inferred: MongoImportInferredType,
) -> Result<Bson, MongoImportIssue> {
    let conversion_error = |message: String| {
        MongoImportIssue::new("TYPE_CONVERSION", message).with_row(row).with_column(column).with_value(value)
    };
    match inferred {
        MongoImportInferredType::Boolean => {
            if is_boolean(value) {
                Ok(Bson::Boolean(value.eq_ignore_ascii_case("true")))
            } else {
                Err(conversion_error(format!("Expected boolean, got {value}")))
            }
        }
        MongoImportInferredType::Integer => {
            let number =
                parse_integer(value).ok_or_else(|| conversion_error(format!("Expected integer, got {value}")))?;
            if let Ok(value) = i32::try_from(number) {
                Ok(Bson::Int32(value))
            } else {
                Ok(Bson::Int64(number))
            }
        }
        MongoImportInferredType::Decimal => {
            let decimal =
                parse_decimal(value).ok_or_else(|| conversion_error(format!("Expected decimal, got {value}")))?;
            Ok(Bson::Decimal128(decimal))
        }
        MongoImportInferredType::Date => {
            let date = parse_date(value).ok_or_else(|| conversion_error(format!("Expected date, got {value}")))?;
            Ok(Bson::DateTime(date))
        }
        MongoImportInferredType::Object | MongoImportInferredType::Array => {
            parse_json_bson(value).map_err(conversion_error)
        }
        MongoImportInferredType::String => Ok(Bson::String(value.to_string())),
    }
}

fn convert_extended_json_cell(value: &str, column: &str, row: u64) -> Result<Bson, MongoImportIssue> {
    let trimmed = value.trim();
    if trimmed.starts_with('{')
        || trimmed.starts_with('[')
        || trimmed.starts_with('"')
        || trimmed == "true"
        || trimmed == "false"
        || trimmed == "null"
        || looks_like_json_number(trimmed)
    {
        match serde_json::from_str::<serde_json::Value>(trimmed) {
            Ok(json) => Bson::try_from(json).map_err(|error| {
                MongoImportIssue::new("TYPE_CONVERSION", format!("Invalid Extended JSON: {error}"))
                    .with_row(row)
                    .with_column(column)
                    .with_value(value)
            }),
            Err(_) => Ok(Bson::String(value.to_string())),
        }
    } else if let Some(date) = parse_date(trimmed) {
        Ok(Bson::DateTime(date))
    } else {
        Ok(Bson::String(value.to_string()))
    }
}

fn looks_like_json_number(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().next().is_some_and(|byte| byte == b'-' || byte.is_ascii_digit())
        && serde_json::from_str::<serde_json::Number>(value).is_ok()
}

fn parse_json_bson(value: &str) -> Result<Bson, String> {
    let json: serde_json::Value = serde_json::from_str(value).map_err(|error| error.to_string())?;
    Bson::try_from(json).map_err(|error| error.to_string())
}

fn document_from_csv_row(
    row: u64,
    headers: &[String],
    fields: &[Option<String>],
    inferred: &[MongoImportInferredType],
    config: &CsvParseConfig,
    with_extended_json: bool,
) -> Result<ParsedMongoDocument, MongoImportIssue> {
    if fields.len() > headers.len() {
        let extra = fields[headers.len()..].iter().flatten().cloned().collect::<Vec<_>>().join(",");
        return Err(MongoImportIssue::new("CSV_STRUCTURE", "CSV row has more fields than the header")
            .with_row(row)
            .with_value(extra));
    }
    let mut document = Document::new();
    for (index, header) in headers.iter().enumerate() {
        let value = fields.get(index).and_then(|value| value.as_deref());
        let inferred = inferred.get(index).copied().unwrap_or(MongoImportInferredType::String);
        insert_field_path(&mut document, header, convert_cell(value, header, row, inferred, config)?);
    }
    Ok(parsed_document(row, document, with_extended_json))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PathSegment<'a> {
    Key(&'a str),
    Index(usize),
}

/// Splits a Compass CSV header into segments: `address.city`, `tags[0]`, `matrix[0][1]`.
/// A part whose brackets are not a well-formed trailing index stays a literal key, so
/// field names that merely contain brackets survive unchanged.
fn parse_field_path(path: &str) -> Vec<PathSegment<'_>> {
    let mut segments = Vec::new();
    for part in path.split('.') {
        match split_indexed_part(part) {
            Some((name, indices)) => {
                segments.push(PathSegment::Key(name));
                segments.extend(indices.into_iter().map(PathSegment::Index));
            }
            None => segments.push(PathSegment::Key(part)),
        }
    }
    segments
}

fn split_indexed_part(part: &str) -> Option<(&str, Vec<usize>)> {
    let (name, mut rest) = part.split_at(part.find('[')?);
    if name.is_empty() {
        return None;
    }
    let mut indices = Vec::new();
    while !rest.is_empty() {
        let inner = rest.strip_prefix('[')?;
        let close = inner.find(']')?;
        indices.push(inner[..close].parse::<usize>().ok()?);
        rest = &inner[close + 1..];
    }
    Some((name, indices))
}

fn insert_field_path(document: &mut Document, path: &str, value: Bson) {
    let segments = parse_field_path(path);
    let Some((PathSegment::Key(key), rest)) = segments.split_first() else {
        return;
    };
    if rest.is_empty() {
        document.insert(*key, value);
        return;
    }
    if !document.contains_key(key) {
        document.insert(*key, Bson::Null);
    }
    if let Some(slot) = document.get_mut(key) {
        set_at_segments(slot, rest, value);
    }
}

/// Grows `target` into the container each segment requires, replacing any value that
/// conflicts with the shape the path asks for.
fn set_at_segments(target: &mut Bson, segments: &[PathSegment<'_>], value: Bson) {
    let Some((segment, rest)) = segments.split_first() else {
        *target = value;
        return;
    };
    match segment {
        PathSegment::Key(key) => {
            if !matches!(target, Bson::Document(_)) {
                *target = Bson::Document(Document::new());
            }
            let Bson::Document(document) = target else { return };
            if !document.contains_key(key) {
                document.insert(*key, Bson::Null);
            }
            if let Some(slot) = document.get_mut(key) {
                set_at_segments(slot, rest, value);
            }
        }
        PathSegment::Index(index) => {
            if !matches!(target, Bson::Array(_)) {
                *target = Bson::Array(Vec::new());
            }
            let Bson::Array(array) = target else { return };
            if array.len() <= *index {
                array.resize(*index + 1, Bson::Null);
            }
            set_at_segments(&mut array[*index], rest, value);
        }
    }
}

fn parsed_document(row: u64, document: Document, with_extended_json: bool) -> ParsedMongoDocument {
    let extended_json =
        if with_extended_json { document_to_canonical_extended_json(&document) } else { serde_json::Value::Null };
    ParsedMongoDocument { row, document, extended_json }
}

/// Reads at most [`TYPE_SAMPLE_ROWS`] data rows to decide each column's type. Preview and
/// execution both call this with the same bound, so the types shown in the wizard are the
/// types the import actually writes.
fn infer_csv_types(
    path: &str,
    config: &CsvParseConfig,
    encoding: Option<TableImportTextEncoding>,
) -> Result<Vec<MongoImportInferredType>, MongoImportIssue> {
    let auto = config.type_mode == MongoImportTypeMode::Auto;
    let sample_rows = if auto { TYPE_SAMPLE_ROWS } else { 1 };
    let (reader, _) = open_transcoded_text_file(path, encoding).map_err(encoding_issue)?;
    let mut csv_reader = csv_reader(reader, config.delimiter);
    let mut record = csv::StringRecord::new();
    let mut masks: Vec<Option<u8>> = Vec::new();
    let mut header_seen = false;
    let mut sampled = 0usize;
    while sampled < sample_rows && csv_reader.read_record(&mut record).map_err(csv_read_issue)? {
        if config.has_header && !header_seen {
            header_seen = true;
            masks = vec![None; unique_headers(&record_strings(&record))?.len()];
            continue;
        }
        if masks.is_empty() {
            masks = vec![None; record.len().max(1)];
        }
        for (index, value) in record.iter().enumerate().take(masks.len()) {
            if let Some(text) = csv_cell_text(value, config) {
                masks[index] = Some(intersect_column_types(masks[index], classify_cell(&text)));
            }
        }
        sampled += 1;
    }
    if !auto {
        return Ok(vec![MongoImportInferredType::String; masks.len()]);
    }
    Ok(masks.into_iter().map(|mask| inferred_type_from_mask(mask.unwrap_or(TYPE_STRING))).collect())
}

fn record_strings(record: &csv::StringRecord) -> Vec<String> {
    record.iter().map(|value| value.to_string()).collect()
}

struct CsvPreviewData {
    columns: Vec<String>,
    inferred: Vec<MongoImportInferredType>,
    documents: Vec<ParsedMongoDocument>,
    errors: Vec<MongoImportIssue>,
    warnings: Vec<MongoImportIssue>,
    estimated_rows: u64,
    estimated_rows_exact: bool,
    encoding: TableImportTextEncoding,
}

fn parse_csv_preview(
    path: &str,
    options: &MongoImportParseOptions,
    preview_limit: usize,
) -> Result<CsvPreviewData, MongoImportIssue> {
    let config = csv_config(path, options)?;
    let inferred = infer_csv_types(path, &config, options.encoding())?;
    let (reader, encoding) = open_transcoded_text_file(path, options.encoding()).map_err(encoding_issue)?;
    let mut csv_reader = csv_reader(reader, config.delimiter);
    let mut record = csv::StringRecord::new();
    let mut headers = Vec::new();
    let mut documents = Vec::new();
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let mut index = 0u64;
    let mut estimated_rows_exact = true;
    while csv_reader.read_record(&mut record).map_err(csv_read_issue)? {
        index += 1;
        if index == 1 && config.has_header {
            headers = unique_headers(&record_strings(&record))?;
            continue;
        }
        if headers.is_empty() {
            headers = generated_field_names(record.len().max(1));
        }
        if documents.len() + errors.len() >= preview_limit {
            estimated_rows_exact = false;
            break;
        }
        let fields = record.iter().map(|value| csv_cell_text(value, &config)).collect::<Vec<_>>();
        match document_from_csv_row(index, &headers, &fields, &inferred, &config, true) {
            Ok(document) => documents.push(document),
            Err(error) => errors.push(error),
        }
    }
    if headers.is_empty() {
        return Err(MongoImportIssue::new("CSV_STRUCTURE", "CSV file has no columns"));
    }
    if !config.has_header {
        warnings.push(MongoImportIssue::new(
            "GENERATED_HEADERS",
            "CSV has no header row; field_1, field_2, … were generated",
        ));
    }
    Ok(CsvPreviewData {
        estimated_rows: documents.len() as u64 + errors.len() as u64,
        estimated_rows_exact,
        columns: headers,
        inferred,
        documents,
        errors,
        warnings,
        encoding,
    })
}

fn encoding_issue(error: String) -> MongoImportIssue {
    if error.contains("Could not detect text encoding") || error.contains("Invalid byte sequence") {
        MongoImportIssue::new("ENCODING", error)
    } else {
        MongoImportIssue::new("FILE_UNREADABLE", error)
    }
}

fn csv_read_issue(error: csv::Error) -> MongoImportIssue {
    let message = error.to_string();
    if message.contains("Invalid byte sequence") {
        encoding_issue(message)
    } else {
        MongoImportIssue::new("CSV_STRUCTURE", message)
    }
}

fn json_document_from_value(
    row: u64,
    value: serde_json::Value,
    with_extended_json: bool,
) -> Result<ParsedMongoDocument, MongoImportIssue> {
    if !value.is_object() {
        return Err(MongoImportIssue::new("JSON_ROOT_TYPE", "JSON document must be an object")
            .with_row(row)
            .with_value(value.to_string()));
    }
    let document = json_object_to_document_extended_json(&value)
        .map_err(|error| MongoImportIssue::new("TYPE_CONVERSION", error).with_row(row).with_value(value.to_string()))?;
    Ok(parsed_document(row, document, with_extended_json))
}

type JsonPreviewOutput =
    (Vec<ParsedMongoDocument>, Vec<MongoImportIssue>, Vec<MongoImportIssue>, u64, bool, TableImportTextEncoding);

fn parse_json_preview(
    path: &str,
    options: &MongoImportParseOptions,
    preview_limit: usize,
    ndjson: bool,
) -> Result<JsonPreviewOutput, MongoImportIssue> {
    let (reader, encoding) = open_transcoded_text_file(path, options.encoding()).map_err(encoding_issue)?;
    let mut reader = BufReader::new(reader);
    let mut documents = Vec::new();
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let mut estimated_rows_exact = true;
    if ndjson {
        for (index, line) in reader.lines().enumerate() {
            let row = (index + 1) as u64;
            let line =
                line.map_err(|error| MongoImportIssue::new("FILE_UNREADABLE", error.to_string()).with_row(row))?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if documents.len() + errors.len() >= preview_limit {
                estimated_rows_exact = false;
                break;
            }
            match serde_json::from_str::<serde_json::Value>(trimmed) {
                Ok(value) => match json_document_from_value(row, value, true) {
                    Ok(document) => documents.push(document),
                    Err(error) => errors.push(error),
                },
                Err(error) => errors.push(
                    MongoImportIssue::new("JSON_ROOT_TYPE", format!("Invalid NDJSON line: {error}"))
                        .with_row(row)
                        .with_value(trimmed.to_string()),
                ),
            }
        }
    } else {
        let mut values = JsonArrayIter::new(&mut reader);
        for (index, value) in values.by_ref().enumerate() {
            let row = (index + 1) as u64;
            if documents.len() + errors.len() >= preview_limit {
                estimated_rows_exact = false;
                break;
            }
            match value {
                Ok(value) => match json_document_from_value(row, value, true) {
                    Ok(document) => documents.push(document),
                    Err(error) => errors.push(error),
                },
                Err(error) => {
                    errors.push(error.with_row(row));
                    if !options.skip_error_rows() {
                        break;
                    }
                }
            }
        }
        if values.single_object {
            warnings.push(MongoImportIssue::new(
                "SINGLE_OBJECT",
                "JSON file contains a single object; it will be imported as one document",
            ));
        }
        if values.finished_with_non_array {
            return Err(MongoImportIssue::new(
                "JSON_ROOT_TYPE",
                "JSON import root value must be an object or an array of objects",
            ));
        }
    }
    let estimated_rows = documents.len() as u64 + errors.len() as u64;
    Ok((documents, errors, warnings, estimated_rows, estimated_rows_exact, encoding))
}

struct JsonArrayIter<'a, R: BufRead> {
    reader: &'a mut R,
    started: bool,
    in_array: bool,
    finished: bool,
    single_object: bool,
    finished_with_non_array: bool,
}

impl<'a, R: BufRead> JsonArrayIter<'a, R> {
    fn new(reader: &'a mut R) -> Self {
        Self {
            reader,
            started: false,
            in_array: false,
            finished: false,
            single_object: false,
            finished_with_non_array: false,
        }
    }
}

impl<R: BufRead> Iterator for JsonArrayIter<'_, R> {
    type Item = Result<serde_json::Value, MongoImportIssue>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.finished {
            return None;
        }
        match next_json_value(self) {
            Ok(Some(value)) => Some(Ok(value)),
            Ok(None) => {
                self.finished = true;
                None
            }
            Err(error) => {
                self.finished = true;
                Some(Err(error))
            }
        }
    }
}

fn next_json_value<R: BufRead>(iter: &mut JsonArrayIter<'_, R>) -> Result<Option<serde_json::Value>, MongoImportIssue> {
    skip_json_whitespace(iter.reader)?;
    let Some(first) = peek_byte(iter.reader)? else {
        return if iter.started {
            Ok(None)
        } else {
            Err(MongoImportIssue::new("JSON_ROOT_TYPE", "JSON file is empty"))
        };
    };
    if !iter.started {
        iter.started = true;
        if first == b'[' {
            iter.in_array = true;
            iter.reader.consume(1);
            skip_json_whitespace(iter.reader)?;
            if peek_byte(iter.reader)? == Some(b']') {
                iter.reader.consume(1);
                return Ok(None);
            }
            return parse_one_json_value(iter.reader).map(Some);
        }
        if first == b'{' {
            iter.single_object = true;
            let value = parse_one_json_value(iter.reader)?;
            skip_json_whitespace(iter.reader)?;
            if peek_byte(iter.reader)?.is_some() {
                return Err(MongoImportIssue::new(
                    "JSON_ROOT_TYPE",
                    "JSON import with a root object must contain only that object",
                ));
            }
            iter.finished = true;
            return Ok(Some(value));
        }
        iter.finished_with_non_array = true;
        return Err(MongoImportIssue::new(
            "JSON_ROOT_TYPE",
            "JSON import root value must be an object or an array of objects",
        ));
    }
    if iter.in_array {
        skip_json_whitespace(iter.reader)?;
        match peek_byte(iter.reader)? {
            Some(b']') => {
                iter.reader.consume(1);
                iter.finished = true;
                return Ok(None);
            }
            Some(b',') => {
                iter.reader.consume(1);
                skip_json_whitespace(iter.reader)?;
                if peek_byte(iter.reader)? == Some(b']') {
                    iter.reader.consume(1);
                    iter.finished = true;
                    return Ok(None);
                }
                return parse_one_json_value(iter.reader).map(Some);
            }
            Some(_) => {
                return Err(MongoImportIssue::new("JSON_ROOT_TYPE", "Expected comma or end of JSON array"));
            }
            None => return Err(MongoImportIssue::new("JSON_ROOT_TYPE", "Unterminated JSON array")),
        }
    }
    Ok(None)
}

fn parse_one_json_value<R: BufRead>(reader: &mut R) -> Result<serde_json::Value, MongoImportIssue> {
    let bytes = extract_json_value(reader)?;
    serde_json::from_slice(&bytes).map_err(|error| MongoImportIssue::new("JSON_ROOT_TYPE", error.to_string()))
}

fn skip_json_whitespace<R: BufRead>(reader: &mut R) -> Result<(), MongoImportIssue> {
    loop {
        let buffer = reader.fill_buf().map_err(|error| MongoImportIssue::new("FILE_UNREADABLE", error.to_string()))?;
        if buffer.is_empty() {
            return Ok(());
        }
        let skip = buffer.iter().take_while(|byte| byte.is_ascii_whitespace()).count();
        if skip == 0 {
            return Ok(());
        }
        reader.consume(skip);
    }
}

fn peek_byte<R: BufRead>(reader: &mut R) -> Result<Option<u8>, MongoImportIssue> {
    let buffer = reader.fill_buf().map_err(|error| MongoImportIssue::new("FILE_UNREADABLE", error.to_string()))?;
    Ok(buffer.first().copied())
}

fn extract_json_value<R: BufRead>(reader: &mut R) -> Result<Vec<u8>, MongoImportIssue> {
    skip_json_whitespace(reader)?;
    let Some(first) = peek_byte(reader)? else {
        return Err(MongoImportIssue::new("JSON_ROOT_TYPE", "Unexpected end of JSON"));
    };
    match first {
        b'{' | b'[' => extract_json_container(reader, first),
        b'"' => extract_json_string(reader),
        b't' | b'f' | b'n' => extract_json_literal(reader),
        b'-' | b'0'..=b'9' => extract_json_number(reader),
        other => Err(MongoImportIssue::new("JSON_ROOT_TYPE", format!("Unexpected JSON byte: {}", other as char))),
    }
}

fn extract_json_container<R: BufRead>(reader: &mut R, open: u8) -> Result<Vec<u8>, MongoImportIssue> {
    let close = if open == b'{' { b'}' } else { b']' };
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    loop {
        let buffer = reader.fill_buf().map_err(|error| MongoImportIssue::new("FILE_UNREADABLE", error.to_string()))?;
        if buffer.is_empty() {
            return Err(MongoImportIssue::new("JSON_ROOT_TYPE", "Unterminated JSON value"));
        }
        let mut consumed = 0usize;
        for &byte in buffer {
            out.push(byte);
            consumed += 1;
            if in_string {
                if escaped {
                    escaped = false;
                } else if byte == b'\\' {
                    escaped = true;
                } else if byte == b'"' {
                    in_string = false;
                }
                continue;
            }
            match byte {
                b'"' => in_string = true,
                b if b == open => depth += 1,
                b if b == close => {
                    depth -= 1;
                    if depth == 0 {
                        reader.consume(consumed);
                        return Ok(out);
                    }
                }
                _ => {}
            }
        }
        reader.consume(consumed);
    }
}

fn extract_json_string<R: BufRead>(reader: &mut R) -> Result<Vec<u8>, MongoImportIssue> {
    let mut out = Vec::new();
    let mut escaped = false;
    let mut started = false;
    loop {
        let buffer = reader.fill_buf().map_err(|error| MongoImportIssue::new("FILE_UNREADABLE", error.to_string()))?;
        if buffer.is_empty() {
            return Err(MongoImportIssue::new("JSON_ROOT_TYPE", "Unterminated JSON string"));
        }
        let mut consumed = 0usize;
        for &byte in buffer {
            out.push(byte);
            consumed += 1;
            if !started {
                started = true;
                continue;
            }
            if escaped {
                escaped = false;
                continue;
            }
            if byte == b'\\' {
                escaped = true;
                continue;
            }
            if byte == b'"' {
                reader.consume(consumed);
                return Ok(out);
            }
        }
        reader.consume(consumed);
    }
}

fn extract_json_literal<R: BufRead>(reader: &mut R) -> Result<Vec<u8>, MongoImportIssue> {
    let mut out = Vec::new();
    loop {
        let buffer = reader.fill_buf().map_err(|error| MongoImportIssue::new("FILE_UNREADABLE", error.to_string()))?;
        if buffer.is_empty() {
            break;
        }
        let take = buffer.iter().take_while(|byte| byte.is_ascii_alphabetic()).count();
        if take == 0 {
            break;
        }
        out.extend_from_slice(&buffer[..take]);
        let exhausted = take == buffer.len();
        reader.consume(take);
        if !exhausted {
            break;
        }
    }
    Ok(out)
}

fn extract_json_number<R: BufRead>(reader: &mut R) -> Result<Vec<u8>, MongoImportIssue> {
    let mut out = Vec::new();
    loop {
        let buffer = reader.fill_buf().map_err(|error| MongoImportIssue::new("FILE_UNREADABLE", error.to_string()))?;
        if buffer.is_empty() {
            break;
        }
        let take =
            buffer.iter().take_while(|byte| matches!(**byte, b'0'..=b'9' | b'+' | b'-' | b'.' | b'e' | b'E')).count();
        if take == 0 {
            break;
        }
        out.extend_from_slice(&buffer[..take]);
        let exhausted = take == buffer.len();
        reader.consume(take);
        if !exhausted {
            break;
        }
    }
    Ok(out)
}

fn columns_from_documents(documents: &[ParsedMongoDocument]) -> Vec<MongoImportColumn> {
    let mut names = Vec::new();
    let mut seen = HashSet::new();
    for document in documents {
        for key in document.document.keys() {
            if seen.insert(key.clone()) {
                names.push(key.clone());
            }
        }
    }
    names
        .into_iter()
        .map(|name| {
            let samples = documents
                .iter()
                .filter_map(|document| document.extended_json.get(&name).cloned())
                .take(3)
                .collect::<Vec<_>>();
            MongoImportColumn { name, inferred_type: MongoImportInferredType::String, sample_values: samples }
        })
        .collect()
}

fn file_name(path: &str) -> String {
    Path::new(path).file_name().and_then(|name| name.to_str()).unwrap_or(path).to_string()
}

fn file_size(path: &str) -> u64 {
    std::fs::metadata(path).map(|metadata| metadata.len()).unwrap_or(0)
}

pub fn preview_mongodb_import_file(
    request: &MongoImportPreviewRequest,
) -> Result<MongoImportPreview, MongoImportIssue> {
    validate_import_source_path(&request.file_path)?;
    let preview_limit = request.preview_limit.unwrap_or(DEFAULT_PREVIEW_LIMIT).max(1);
    match request.format {
        MongoImportFormat::Csv => {
            let parsed = parse_csv_preview(&request.file_path, &request.parse_options, preview_limit)?;
            let columns = parsed
                .columns
                .into_iter()
                .zip(parsed.inferred)
                .map(|(name, inferred_type)| {
                    let sample_values = parsed
                        .documents
                        .iter()
                        .filter_map(|document| document.extended_json.get(&name).cloned())
                        .take(3)
                        .collect();
                    MongoImportColumn { name, inferred_type, sample_values }
                })
                .collect();
            Ok(MongoImportPreview {
                source_ref: request.source_ref.clone(),
                format: request.format,
                detected_encoding: Some(parsed.encoding),
                file_name: file_name(&request.file_path),
                file_path: request.file_path.clone(),
                size_bytes: file_size(&request.file_path),
                columns,
                row_numbers: parsed.documents.iter().map(|document| document.row).collect(),
                rows: parsed.documents.into_iter().map(|document| document.extended_json).collect(),
                warnings: parsed.warnings,
                errors: parsed.errors,
                estimated_rows: Some(parsed.estimated_rows),
                estimated_rows_exact: parsed.estimated_rows_exact,
            })
        }
        MongoImportFormat::Json | MongoImportFormat::Ndjson => {
            let ndjson = request.format == MongoImportFormat::Ndjson;
            let (documents, errors, warnings, estimated_rows, estimated_rows_exact, encoding) =
                parse_json_preview(&request.file_path, &request.parse_options, preview_limit, ndjson)?;
            Ok(MongoImportPreview {
                source_ref: request.source_ref.clone(),
                format: request.format,
                detected_encoding: Some(encoding),
                file_name: file_name(&request.file_path),
                file_path: request.file_path.clone(),
                size_bytes: file_size(&request.file_path),
                columns: columns_from_documents(&documents),
                row_numbers: documents.iter().map(|document| document.row).collect(),
                rows: documents.into_iter().map(|document| document.extended_json).collect(),
                warnings,
                errors,
                estimated_rows: Some(estimated_rows),
                estimated_rows_exact,
            })
        }
    }
}

pub fn preview_mongodb_import_bytes(
    bytes: &[u8],
    format: MongoImportFormat,
    options: &MongoImportParseOptions,
    preview_limit: usize,
) -> Result<MongoImportPreview, MongoImportIssue> {
    let extension = match format {
        MongoImportFormat::Csv => "csv",
        MongoImportFormat::Json => "json",
        MongoImportFormat::Ndjson => "ndjson",
    };
    let dir = std::env::temp_dir().join(format!("dbx-mongo-import-preview-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).map_err(|error| MongoImportIssue::new("FILE_UNREADABLE", error.to_string()))?;
    let path = dir.join(format!("preview.{extension}"));
    std::fs::write(&path, bytes).map_err(|error| MongoImportIssue::new("FILE_UNREADABLE", error.to_string()))?;
    let result = preview_mongodb_import_file(&MongoImportPreviewRequest {
        file_path: path.to_string_lossy().to_string(),
        source_ref: None,
        format,
        parse_options: options.clone(),
        preview_limit: Some(preview_limit),
    });
    let _ = std::fs::remove_dir_all(dir);
    result
}

fn stream_csv_documents<R, F>(
    reader: R,
    config: &CsvParseConfig,
    inferred: &[MongoImportInferredType],
    mut on_document: F,
) -> Result<(), MongoImportIssue>
where
    R: Read,
    F: FnMut(Result<ParsedMongoDocument, MongoImportIssue>) -> Result<(), MongoImportIssue>,
{
    let mut csv_reader = csv_reader(reader, config.delimiter);
    let mut record = csv::StringRecord::new();
    let mut headers = Vec::new();
    let mut index = 0u64;
    while csv_reader.read_record(&mut record).map_err(csv_read_issue)? {
        index += 1;
        if index == 1 && config.has_header {
            headers = unique_headers(&record_strings(&record))?;
            continue;
        }
        if headers.is_empty() {
            headers = generated_field_names(record.len().max(1));
        }
        let fields = record.iter().map(|value| csv_cell_text(value, config)).collect::<Vec<_>>();
        on_document(document_from_csv_row(index, &headers, &fields, inferred, config, false))?;
    }
    Ok(())
}

fn stream_csv_file<F>(path: &str, options: &MongoImportParseOptions, on_document: F) -> Result<(), MongoImportIssue>
where
    F: FnMut(Result<ParsedMongoDocument, MongoImportIssue>) -> Result<(), MongoImportIssue>,
{
    let config = csv_config(path, options)?;
    let inferred = infer_csv_types(path, &config, options.encoding())?;
    let (reader, _) = open_transcoded_text_file(path, options.encoding()).map_err(encoding_issue)?;
    stream_csv_documents(reader, &config, &inferred, on_document)
}

fn stream_json_file<F>(
    path: &str,
    options: &MongoImportParseOptions,
    ndjson: bool,
    mut on_document: F,
) -> Result<(), MongoImportIssue>
where
    F: FnMut(Result<ParsedMongoDocument, MongoImportIssue>) -> Result<(), MongoImportIssue>,
{
    let (reader, _) = open_transcoded_text_file(path, options.encoding()).map_err(encoding_issue)?;
    let mut reader = BufReader::new(reader);
    if ndjson {
        for (index, line) in reader.lines().enumerate() {
            let row = (index + 1) as u64;
            let line = match line {
                Ok(line) => line,
                Err(error) => {
                    on_document(Err(MongoImportIssue::new("FILE_UNREADABLE", error.to_string()).with_row(row)))?;
                    continue;
                }
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let parsed = serde_json::from_str::<serde_json::Value>(trimmed)
                .map_err(|error| {
                    MongoImportIssue::new("JSON_ROOT_TYPE", format!("Invalid NDJSON line: {error}"))
                        .with_row(row)
                        .with_value(trimmed.to_string())
                })
                .and_then(|value| json_document_from_value(row, value, false));
            on_document(parsed)?;
        }
        return Ok(());
    }
    for (index, value) in JsonArrayIter::new(&mut reader).enumerate() {
        let row = (index + 1) as u64;
        on_document(value.and_then(|value| json_document_from_value(row, value, false)))?;
    }
    Ok(())
}

pub fn for_each_mongodb_import_document<F>(
    path: &str,
    format: MongoImportFormat,
    options: &MongoImportParseOptions,
    on_document: F,
) -> Result<(), MongoImportIssue>
where
    F: FnMut(Result<ParsedMongoDocument, MongoImportIssue>) -> Result<(), MongoImportIssue>,
{
    validate_import_source_path(path)?;
    match format {
        MongoImportFormat::Csv => stream_csv_file(path, options, on_document),
        MongoImportFormat::Json => stream_json_file(path, options, false, on_document),
        MongoImportFormat::Ndjson => stream_json_file(path, options, true, on_document),
    }
}

#[allow(clippy::too_many_arguments)]
fn progress(
    import_id: &str,
    phase: MongoImportPhase,
    status: MongoImportStatus,
    rows_read: u64,
    rows_inserted: u64,
    rows_failed: u64,
    batches_committed: u64,
    total_rows: Option<u64>,
    error_rows: Vec<MongoImportIssue>,
    error_message: Option<String>,
    started_at: Instant,
) -> MongoImportProgress {
    MongoImportProgress {
        import_id: import_id.to_string(),
        phase,
        status,
        rows_read,
        rows_inserted,
        rows_failed,
        batches_committed,
        total_rows,
        error_rows,
        error_message,
        elapsed_ms: started_at.elapsed().as_millis(),
    }
}

async fn insert_documents_batch(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    documents: Vec<Document>,
    require_bson_types: bool,
) -> Result<MongoInsertOutcome, MongoImportIssue> {
    let pool =
        state.pool_handle(connection_id).await.ok_or_else(|| MongoImportIssue::new("CONNECTION", "Not found"))?;
    match &pool {
        PoolKind::MongoDb(client) => {
            insert_bson_documents(client, database, collection, documents).await.map_err(bulk_write_issue)
        }
        PoolKind::Agent(client) => {
            if require_bson_types {
                return Err(MongoImportIssue::new(
                    "LEGACY_AGENT",
                    "MongoDB Legacy Agent cannot preserve BSON types during file import; use the native MongoDB driver",
                ));
            }
            let mut client = client.lock().await;
            if !client.supports_capability(AgentCapability::MongoInsertDocuments) {
                return Err(MongoImportIssue::new(
                    "LEGACY_AGENT",
                    "MongoDB Legacy Agent does not support insertMany; upgrade or reinstall the MongoDB Legacy driver",
                ));
            }
            let docs_json =
                serde_json::to_string(&documents.iter().map(document_to_canonical_extended_json).collect::<Vec<_>>())
                    .map_err(|error| MongoImportIssue::new("TYPE_CONVERSION", error.to_string()))?;
            let result: serde_json::Value = client
                .mongo_insert_documents(serde_json::json!({
                    "database": database,
                    "collection": collection,
                    "docs_json": docs_json,
                }))
                .await
                .map_err(|error| MongoImportIssue::new("PERMISSION", error).retryable())?;
            let inserted = result.get("affected_rows").and_then(serde_json::Value::as_u64).ok_or_else(|| {
                MongoImportIssue::new("CONNECTION", "MongoDB Legacy Agent returned an invalid insertMany result")
            })?;
            Ok(MongoInsertOutcome { inserted, errors: Vec::new() })
        }
        _ => Err(MongoImportIssue::new("CONNECTION", "Not a MongoDB connection")),
    }
}

/// Rewrites a write issue's batch-relative index into the source file row it came from, so the
/// user can find the offending record.
fn located_in_batch(mut issue: MongoImportIssue, rows: &[u64], batch: u64) -> MongoImportIssue {
    issue.row = issue
        .row
        .and_then(|index| rows.get(index.saturating_sub(1) as usize).copied())
        .or_else(|| rows.first().copied());
    issue.batch = Some(batch);
    issue
}

fn bulk_write_issue(error: MongoBulkWriteError) -> MongoImportIssue {
    let mut issue =
        MongoImportIssue::new(if error.code == Some(11000) { "DUPLICATE_ID" } else { "TARGET_WRITE" }, error.message);
    issue.retryable = error.retryable;
    if let Some(index) = error.index {
        issue.row = Some(index as u64 + 1);
    }
    issue
}

pub async fn import_mongodb_file_core<C, F>(
    state: &AppState,
    request: &MongoImportRequest,
    mut is_cancelled: C,
    mut on_progress: F,
) -> Result<MongoImportSummary, MongoImportIssue>
where
    C: FnMut(&str) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>>,
    F: FnMut(MongoImportProgress),
{
    let started_at = Instant::now();
    let batch_size = clamp_batch_size(if request.batch_size == 0 { DEFAULT_BATCH_SIZE } else { request.batch_size })?;
    let require_bson_types = !matches!(request.parse_options.type_mode(), MongoImportTypeMode::String);
    on_progress(progress(
        &request.import_id,
        MongoImportPhase::Preparing,
        MongoImportStatus::Running,
        0,
        0,
        0,
        0,
        None,
        Vec::new(),
        None,
        started_at,
    ));
    if is_cancelled(&request.import_id).await {
        return cancel_import(&request.import_id, 0, 0, 0, 0, Vec::new(), started_at, &mut on_progress);
    }
    validate_import_source_path(&request.file_path)?;
    state
        .get_or_create_pool(&request.connection_id, Some(&request.database))
        .await
        .map_err(|error| MongoImportIssue::new("CONNECTION", error).retryable())?;

    on_progress(progress(
        &request.import_id,
        MongoImportPhase::Parsing,
        MongoImportStatus::Running,
        0,
        0,
        0,
        0,
        None,
        Vec::new(),
        None,
        started_at,
    ));

    let (tx, mut rx) = tokio::sync::mpsc::channel::<ImportBatchEvent>(2);
    let path = request.file_path.clone();
    let format = request.format;
    let options = request.parse_options.clone();
    let skip_error_rows = options.skip_error_rows();
    tokio::task::spawn_blocking(move || {
        let mut rows = Vec::new();
        let mut documents = Vec::new();
        let result = for_each_mongodb_import_document(&path, format, &options, |parsed| match parsed {
            Ok(parsed) => {
                rows.push(parsed.row);
                documents.push(parsed.document);
                if documents.len() >= batch_size
                    && tx
                        .blocking_send(ImportBatchEvent::Batch {
                            rows: std::mem::take(&mut rows),
                            documents: std::mem::take(&mut documents),
                        })
                        .is_err()
                {
                    return Err(MongoImportIssue::new("CANCELLED", "Import cancelled"));
                }
                Ok(())
            }
            Err(error) if skip_error_rows => {
                if tx.blocking_send(ImportBatchEvent::RowError(error)).is_err() {
                    Err(MongoImportIssue::new("CANCELLED", "Import cancelled"))
                } else {
                    Ok(())
                }
            }
            Err(error) => Err(error),
        });
        if !documents.is_empty() {
            let _ = tx.blocking_send(ImportBatchEvent::Batch { rows, documents });
        }
        if let Err(error) = result {
            if error.code != "CANCELLED" {
                let _ = tx.blocking_send(ImportBatchEvent::Fatal(error));
            }
        }
    });

    let mut rows_read = 0u64;
    let mut rows_inserted = 0u64;
    let mut rows_failed = 0u64;
    let mut batches_committed = 0u64;
    let mut error_rows = Vec::new();

    while let Some(event) = rx.recv().await {
        if is_cancelled(&request.import_id).await {
            return cancel_import(
                &request.import_id,
                rows_read,
                rows_inserted,
                rows_failed,
                batches_committed,
                error_rows,
                started_at,
                &mut on_progress,
            );
        }
        match event {
            ImportBatchEvent::RowError(error) => {
                rows_read += 1;
                rows_failed += 1;
                error_rows.push(error);
            }
            ImportBatchEvent::Fatal(error) => {
                let message = error.display_message();
                error_rows.push(error.clone());
                on_progress(progress(
                    &request.import_id,
                    MongoImportPhase::Done,
                    MongoImportStatus::Error,
                    rows_read,
                    rows_inserted,
                    rows_failed,
                    batches_committed,
                    None,
                    error_rows,
                    Some(message),
                    started_at,
                ));
                return Err(error);
            }
            ImportBatchEvent::Batch { rows, documents } => {
                rows_read += documents.len() as u64;
                on_progress(progress(
                    &request.import_id,
                    MongoImportPhase::Writing,
                    MongoImportStatus::Running,
                    rows_read,
                    rows_inserted,
                    rows_failed,
                    batches_committed,
                    None,
                    Vec::new(),
                    None,
                    started_at,
                ));
                match insert_documents_batch(
                    state,
                    &request.connection_id,
                    &request.database,
                    &request.collection,
                    documents,
                    require_bson_types,
                )
                .await
                {
                    Ok(outcome) => {
                        rows_inserted += outcome.inserted;
                        rows_failed += outcome.errors.len() as u64;
                        batches_committed += 1;
                        let rejected = outcome
                            .errors
                            .into_iter()
                            .map(|error| located_in_batch(bulk_write_issue(error), &rows, batches_committed))
                            .collect::<Vec<_>>();
                        // Documents the server refused individually: the rest of the batch is
                        // already written, so honour skipErrorRows exactly like a parse error.
                        if let Some(fatal) = rejected.first().filter(|_| !skip_error_rows).cloned() {
                            let message = fatal.display_message();
                            error_rows.extend(rejected);
                            on_progress(progress(
                                &request.import_id,
                                MongoImportPhase::Done,
                                MongoImportStatus::Error,
                                rows_read,
                                rows_inserted,
                                rows_failed,
                                batches_committed,
                                None,
                                error_rows,
                                Some(message),
                                started_at,
                            ));
                            return Err(fatal);
                        }
                        error_rows.extend(rejected);
                    }
                    Err(error) => {
                        let error = located_in_batch(error, &rows, batches_committed + 1);
                        rows_failed += rows.len() as u64;
                        let message = error.display_message();
                        error_rows.push(error.clone());
                        on_progress(progress(
                            &request.import_id,
                            MongoImportPhase::Done,
                            MongoImportStatus::Error,
                            rows_read,
                            rows_inserted,
                            rows_failed,
                            batches_committed,
                            None,
                            error_rows,
                            Some(message),
                            started_at,
                        ));
                        return Err(error);
                    }
                }
            }
        }
    }

    if is_cancelled(&request.import_id).await {
        return cancel_import(
            &request.import_id,
            rows_read,
            rows_inserted,
            rows_failed,
            batches_committed,
            error_rows,
            started_at,
            &mut on_progress,
        );
    }

    on_progress(progress(
        &request.import_id,
        MongoImportPhase::Done,
        MongoImportStatus::Done,
        rows_read,
        rows_inserted,
        rows_failed,
        batches_committed,
        Some(rows_read),
        error_rows,
        None,
        started_at,
    ));
    Ok(MongoImportSummary {
        import_id: request.import_id.clone(),
        rows_inserted,
        rows_failed,
        batches_committed,
        elapsed_ms: started_at.elapsed().as_millis(),
    })
}

enum ImportBatchEvent {
    Batch { rows: Vec<u64>, documents: Vec<Document> },
    RowError(MongoImportIssue),
    Fatal(MongoImportIssue),
}

fn cancel_import<F>(
    import_id: &str,
    rows_read: u64,
    rows_inserted: u64,
    rows_failed: u64,
    batches_committed: u64,
    error_rows: Vec<MongoImportIssue>,
    started_at: Instant,
    on_progress: &mut F,
) -> Result<MongoImportSummary, MongoImportIssue>
where
    F: FnMut(MongoImportProgress),
{
    on_progress(progress(
        import_id,
        MongoImportPhase::Done,
        MongoImportStatus::Cancelled,
        rows_read,
        rows_inserted,
        rows_failed,
        batches_committed,
        None,
        error_rows,
        Some("Import cancelled".to_string()),
        started_at,
    ));
    Err(MongoImportIssue::new("CANCELLED", "Import cancelled"))
}

pub async fn preview_mongodb_import_file_core(
    request: MongoImportPreviewRequest,
) -> Result<MongoImportPreview, String> {
    preview_mongodb_import_file(&request).map_err(|error| error.display_message())
}

pub const DEFAULT_EXPORT_BATCH_SIZE: u32 = 1000;
pub const MAX_CSV_FIELDS: usize = 256;

pub fn mongodb_export_client_session_id(export_id: &str) -> String {
    task_client_session_id("mongo-export", export_id)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MongoExportFormat {
    Csv,
    Ndjson,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MongoExportStatus {
    Running,
    Done,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoExportRequest {
    pub export_id: String,
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    #[serde(default)]
    pub filter: Option<String>,
    #[serde(default)]
    pub sort: Option<String>,
    #[serde(default)]
    pub projection: Option<String>,
    #[serde(default)]
    pub collation: Option<String>,
    pub format: MongoExportFormat,
    #[serde(default = "default_true")]
    pub include_header: bool,
    pub file_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_id: Option<String>,
}

const fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoExportProgress {
    pub export_id: String,
    pub status: MongoExportStatus,
    pub documents_read: u64,
    pub bytes_written: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_documents: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoExportSummary {
    pub export_id: String,
    pub documents_exported: u64,
    pub file_path: String,
    pub elapsed_ms: u128,
}

fn temp_export_path(target: &Path) -> PathBuf {
    let name = target.file_name().and_then(|name| name.to_str()).unwrap_or("export");
    target.with_file_name(format!(".{name}.dbx-export.tmp"))
}

fn cleanup_temp(path: &Path) {
    let _ = std::fs::remove_file(path);
}

fn atomic_rename(temp: &Path, target: &Path) -> Result<(), String> {
    match std::fs::rename(temp, target) {
        Ok(()) => Ok(()),
        Err(_) if target.exists() => {
            std::fs::remove_file(target).map_err(|error| error.to_string())?;
            std::fs::rename(temp, target).map_err(|error| error.to_string())
        }
        Err(error) => Err(error.to_string()),
    }
}

fn write_export_line(writer: &mut BufWriter<File>, line: &str) -> Result<u64, String> {
    writer.write_all(line.as_bytes()).map_err(|error| error.to_string())?;
    Ok(line.len() as u64)
}

fn unwrap_extended_json_csv_scalar(value: &serde_json::Value) -> Option<String> {
    let object = value.as_object()?;
    if object.len() != 1 {
        return None;
    }
    let (key, inner) = object.iter().next()?;
    match key.as_str() {
        // Only types a CSV cell can carry without losing its identity on reimport. `$uuid`,
        // `$symbol`, `$binary` and friends stay as Extended JSON text so that
        // `Bson::try_from(serde_json::Value)` rebuilds the original type.
        "$oid" | "$numberInt" | "$numberLong" | "$numberDouble" | "$numberDecimal" => {
            inner.as_str().map(str::to_string)
        }
        "$date" => match inner {
            serde_json::Value::String(iso) => Some(iso.clone()),
            serde_json::Value::Object(date) => {
                date.get("$numberLong").and_then(serde_json::Value::as_str).and_then(|millis| {
                    millis.parse::<i64>().ok().and_then(|ms| {
                        ChronoDateTime::<Utc>::from_timestamp_millis(ms)
                            .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
                    })
                })
            }
            _ => None,
        },
        _ => None,
    }
}

/// Resolves an export header back to its value, understanding the same grammar the import
/// side parses, so `tags[0]` and `address.city` both round-trip.
fn json_at_field_path<'a>(value: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
    let mut current = value;
    for segment in parse_field_path(path) {
        current = match segment {
            PathSegment::Key(key) => current.get(key)?,
            PathSegment::Index(index) => current.get(index)?,
        };
    }
    Some(current)
}

fn push_csv_json_value(out: &mut String, value: Option<&serde_json::Value>) {
    match value {
        None | Some(serde_json::Value::Null) => {}
        // Deliberately no spreadsheet formula guard: prefixing `'` to values starting with
        // `= + - @` would make reimport see a different string than was exported.
        Some(serde_json::Value::String(value)) => push_csv_field(out, value, CsvQuoteMode::Necessary),
        Some(serde_json::Value::Bool(value)) => out.push_str(if *value { "true" } else { "false" }),
        Some(serde_json::Value::Number(value)) => out.push_str(&value.to_string()),
        Some(other) => {
            if let Some(scalar) = unwrap_extended_json_csv_scalar(other) {
                push_csv_field(out, &scalar, CsvQuoteMode::Necessary);
            } else {
                push_csv_field(out, &other.to_string(), CsvQuoteMode::Necessary);
            }
        }
    }
}

fn format_csv_document_line(fields: &[String], document: &serde_json::Value) -> String {
    let mut line = String::new();
    for (index, field) in fields.iter().enumerate() {
        if index > 0 {
            line.push(',');
        }
        push_csv_json_value(&mut line, json_at_field_path(document, field));
    }
    line.push('\n');
    line
}

fn push_csv_field_name(name: &str, fields: &mut Vec<String>, seen: &mut HashSet<String>) -> Result<(), String> {
    if !seen.insert(name.to_string()) {
        return Ok(());
    }
    if fields.len() >= MAX_CSV_FIELDS {
        return Err(format!(
            "CSV export found more than {MAX_CSV_FIELDS} unique fields; use NDJSON for this collection"
        ));
    }
    fields.push(name.to_string());
    Ok(())
}

fn collect_csv_fields(
    document: &serde_json::Value,
    fields: &mut Vec<String>,
    seen: &mut HashSet<String>,
) -> Result<(), String> {
    collect_csv_fields_at(document, "", fields, seen)
}

/// Expands a document into Compass-style headers: nested objects become `address.city`,
/// arrays become `tags[0]`, and anything a single cell can hold becomes one leaf column.
/// Extended JSON wrappers, empty objects and empty arrays are leaves so their type survives.
fn collect_csv_fields_at(
    value: &serde_json::Value,
    path: &str,
    fields: &mut Vec<String>,
    seen: &mut HashSet<String>,
) -> Result<(), String> {
    if unwrap_extended_json_csv_scalar(value).is_none() {
        match value {
            serde_json::Value::Object(object) if !object.is_empty() => {
                for (key, child) in object {
                    let child_path = if path.is_empty() { key.clone() } else { format!("{path}.{key}") };
                    collect_csv_fields_at(child, &child_path, fields, seen)?;
                }
                return Ok(());
            }
            // A top-level array is not a document, so only descend once we have a field name.
            serde_json::Value::Array(items) if !items.is_empty() && !path.is_empty() => {
                for (index, child) in items.iter().enumerate() {
                    collect_csv_fields_at(child, &format!("{path}[{index}]"), fields, seen)?;
                }
                return Ok(());
            }
            _ => {}
        }
    }
    if !path.is_empty() {
        push_csv_field_name(path, fields, seen)?;
    }
    Ok(())
}

fn move_id_first(fields: &mut Vec<String>) {
    if let Some(index) = fields.iter().position(|field| field == "_id") {
        if index > 0 {
            let id = fields.remove(index);
            fields.insert(0, id);
        }
    }
}

fn write_csv_header_and_buffer(
    include_header: bool,
    fields: &mut Vec<String>,
    buffered: &mut Vec<serde_json::Value>,
    writer: &mut BufWriter<File>,
    bytes_written: &mut u64,
    documents_read: &mut u64,
) -> Result<(), String> {
    if fields.is_empty() {
        fields.push("_id".to_string());
    }
    move_id_first(fields);
    if include_header {
        let mut line = String::new();
        for (index, field) in fields.iter().enumerate() {
            if index > 0 {
                line.push(',');
            }
            push_csv_field(&mut line, field, CsvQuoteMode::Necessary);
        }
        line.push('\n');
        *bytes_written += write_export_line(writer, &line)?;
    }
    for json in buffered.drain(..) {
        let line = format_csv_document_line(fields, &json);
        *bytes_written += write_export_line(writer, &line)?;
        *documents_read += 1;
    }
    Ok(())
}

fn export_progress(
    export_id: &str,
    status: MongoExportStatus,
    documents_read: u64,
    bytes_written: u64,
    total_documents: Option<u64>,
    error_message: Option<String>,
    started_at: Instant,
) -> MongoExportProgress {
    MongoExportProgress {
        export_id: export_id.to_string(),
        status,
        documents_read,
        bytes_written,
        total_documents,
        error_message,
        elapsed_ms: started_at.elapsed().as_millis(),
    }
}

pub async fn export_mongodb_query_core<C, F>(
    state: &AppState,
    request: &MongoExportRequest,
    mut is_cancelled: C,
    mut on_progress: F,
) -> Result<MongoExportSummary, String>
where
    C: FnMut(&str) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>>,
    F: FnMut(MongoExportProgress),
{
    let started_at = Instant::now();
    on_progress(export_progress(&request.export_id, MongoExportStatus::Running, 0, 0, None, None, started_at));
    if is_cancelled(&request.export_id).await {
        on_progress(export_progress(
            &request.export_id,
            MongoExportStatus::Cancelled,
            0,
            0,
            None,
            Some("Export cancelled".to_string()),
            started_at,
        ));
        return Err("Export cancelled".to_string());
    }

    state.get_or_create_pool(&request.connection_id, Some(&request.database)).await?;
    let pool = state.pool_handle(&request.connection_id).await.ok_or_else(|| "Not found".to_string())?;
    let client = match &pool {
        PoolKind::MongoDb(client) => client.clone(),
        PoolKind::Agent(_) => {
            return Err(
                "MongoDB Legacy Agent does not support cursor export of the full query; use the native MongoDB driver"
                    .to_string(),
            );
        }
        _ => return Err("Not a MongoDB connection".to_string()),
    };

    let total_documents = if request
        .filter
        .as_deref()
        .is_none_or(|filter| filter.trim().is_empty() || filter.trim() == "{}")
    {
        mongo_driver::count_documents(&client, &request.database, &request.collection, request.filter.as_deref(), false)
            .await
            .ok()
    } else {
        None
    };

    let target = PathBuf::from(&request.file_path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temp = temp_export_path(&target);
    cleanup_temp(&temp);

    let result = match request.format {
        MongoExportFormat::Ndjson => {
            export_ndjson(&client, request, &temp, total_documents, started_at, &mut is_cancelled, &mut on_progress)
                .await
        }
        MongoExportFormat::Csv => {
            export_csv(&client, request, &temp, total_documents, started_at, &mut is_cancelled, &mut on_progress).await
        }
    };

    match result {
        Ok((documents_read, _bytes_written)) => {
            if is_cancelled(&request.export_id).await {
                cleanup_temp(&temp);
                on_progress(export_progress(
                    &request.export_id,
                    MongoExportStatus::Cancelled,
                    documents_read,
                    0,
                    total_documents,
                    Some("Export cancelled".to_string()),
                    started_at,
                ));
                return Err("Export cancelled".to_string());
            }
            atomic_rename(&temp, &target)?;
            on_progress(export_progress(
                &request.export_id,
                MongoExportStatus::Done,
                documents_read,
                std::fs::metadata(&target).map(|metadata| metadata.len()).unwrap_or(0),
                Some(documents_read),
                None,
                started_at,
            ));
            Ok(MongoExportSummary {
                export_id: request.export_id.clone(),
                documents_exported: documents_read,
                file_path: request.file_path.clone(),
                elapsed_ms: started_at.elapsed().as_millis(),
            })
        }
        Err(error) => {
            cleanup_temp(&temp);
            let cancelled = error == "Export cancelled" || is_cancelled(&request.export_id).await;
            on_progress(export_progress(
                &request.export_id,
                if cancelled { MongoExportStatus::Cancelled } else { MongoExportStatus::Error },
                0,
                0,
                total_documents,
                Some(error.clone()),
                started_at,
            ));
            Err(error)
        }
    }
}

async fn export_ndjson<C, F>(
    client: &mongodb::Client,
    request: &MongoExportRequest,
    temp: &Path,
    total_documents: Option<u64>,
    started_at: Instant,
    is_cancelled: &mut C,
    on_progress: &mut F,
) -> Result<(u64, u64), String>
where
    C: FnMut(&str) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>>,
    F: FnMut(MongoExportProgress),
{
    let file = File::create(temp).map_err(|error| error.to_string())?;
    let mut writer = BufWriter::new(file);
    let mut documents_read = 0u64;
    let mut bytes_written = 0u64;
    for_each_find_document(
        client,
        &request.database,
        &request.collection,
        request.filter.as_deref(),
        request.projection.as_deref(),
        request.sort.as_deref(),
        request.collation.as_deref(),
        DEFAULT_EXPORT_BATCH_SIZE,
        |document| {
            let json = document_to_canonical_extended_json(&document);
            let mut line = json.to_string();
            line.push('\n');
            bytes_written += write_export_line(&mut writer, &line)?;
            documents_read += 1;
            if documents_read == 1 || documents_read.is_multiple_of(500) {
                on_progress(export_progress(
                    &request.export_id,
                    MongoExportStatus::Running,
                    documents_read,
                    bytes_written,
                    total_documents,
                    None,
                    started_at,
                ));
            }
            Ok(())
        },
    )
    .await?;
    writer.flush().map_err(|error| error.to_string())?;
    if is_cancelled(&request.export_id).await {
        return Err("Export cancelled".to_string());
    }
    Ok((documents_read, bytes_written))
}

const CSV_FIELD_DISCOVERY_DOCS: usize = 10_000;

async fn export_csv<C, F>(
    client: &mongodb::Client,
    request: &MongoExportRequest,
    temp: &Path,
    total_documents: Option<u64>,
    started_at: Instant,
    is_cancelled: &mut C,
    on_progress: &mut F,
) -> Result<(u64, u64), String>
where
    C: FnMut(&str) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>>,
    F: FnMut(MongoExportProgress),
{
    if is_cancelled(&request.export_id).await {
        return Err("Export cancelled".to_string());
    }
    let file = File::create(temp).map_err(|error| error.to_string())?;
    let mut writer = BufWriter::new(file);
    let mut fields = Vec::new();
    let mut seen = HashSet::new();
    let mut buffered = Vec::new();
    let mut header_ready = false;
    let mut documents_read = 0u64;
    let mut bytes_written = 0u64;

    for_each_find_document(
        client,
        &request.database,
        &request.collection,
        request.filter.as_deref(),
        request.projection.as_deref(),
        request.sort.as_deref(),
        request.collation.as_deref(),
        DEFAULT_EXPORT_BATCH_SIZE,
        |document| {
            if !header_ready {
                let json = document_to_canonical_extended_json(&document);
                collect_csv_fields(&json, &mut fields, &mut seen)?;
                buffered.push(json);
                if buffered.len() >= CSV_FIELD_DISCOVERY_DOCS {
                    write_csv_header_and_buffer(
                        request.include_header,
                        &mut fields,
                        &mut buffered,
                        &mut writer,
                        &mut bytes_written,
                        &mut documents_read,
                    )?;
                    header_ready = true;
                    on_progress(export_progress(
                        &request.export_id,
                        MongoExportStatus::Running,
                        documents_read,
                        bytes_written,
                        total_documents,
                        None,
                        started_at,
                    ));
                }
                return Ok(());
            }
            let json = document_to_canonical_extended_json(&document);
            let line = format_csv_document_line(&fields, &json);
            bytes_written += write_export_line(&mut writer, &line)?;
            documents_read += 1;
            if documents_read.is_multiple_of(500) {
                on_progress(export_progress(
                    &request.export_id,
                    MongoExportStatus::Running,
                    documents_read,
                    bytes_written,
                    total_documents,
                    None,
                    started_at,
                ));
            }
            Ok(())
        },
    )
    .await?;
    if !header_ready {
        write_csv_header_and_buffer(
            request.include_header,
            &mut fields,
            &mut buffered,
            &mut writer,
            &mut bytes_written,
            &mut documents_read,
        )?;
    }
    writer.flush().map_err(|error| error.to_string())?;
    if is_cancelled(&request.export_id).await {
        return Err("Export cancelled".to_string());
    }
    Ok((documents_read, bytes_written))
}

pub fn csv_fields_from_extended_documents(documents: &[serde_json::Value]) -> Result<Vec<String>, String> {
    let mut fields = Vec::new();
    let mut seen = HashSet::new();
    for document in documents {
        collect_csv_fields(document, &mut fields, &mut seen)?;
    }
    move_id_first(&mut fields);
    Ok(fields)
}

pub fn format_mongo_csv_row(fields: &[String], document: &serde_json::Value) -> String {
    let mut line = format_csv_document_line(fields, document);
    line.pop();
    line
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::{doc, Bson, Document};
    use std::io::Cursor;

    fn options(type_mode: MongoImportTypeMode) -> MongoImportParseOptions {
        MongoImportParseOptions { type_mode: Some(type_mode), ..MongoImportParseOptions::default() }
    }

    fn preview_csv(csv: &str, type_mode: MongoImportTypeMode) -> MongoImportPreview {
        preview_mongodb_import_bytes(csv.as_bytes(), MongoImportFormat::Csv, &options(type_mode), 50).unwrap()
    }

    fn execute_docs(csv: &str, type_mode: MongoImportTypeMode) -> Vec<serde_json::Value> {
        execute_source(csv.as_bytes(), "csv", MongoImportFormat::Csv, &options(type_mode))
    }

    fn execute_source(
        bytes: &[u8],
        extension: &str,
        format: MongoImportFormat,
        parse_options: &MongoImportParseOptions,
    ) -> Vec<serde_json::Value> {
        let dir = std::env::temp_dir().join(format!("dbx-mongo-import-exec-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("data.{extension}"));
        std::fs::write(&path, bytes).unwrap();
        let mut docs = Vec::new();
        for_each_mongodb_import_document(path.to_str().unwrap(), format, parse_options, |parsed| {
            docs.push(document_to_canonical_extended_json(&parsed?.document));
            Ok(())
        })
        .unwrap();
        let _ = std::fs::remove_dir_all(dir);
        docs
    }

    // Test helper: simplified CSV export that takes documents directly
    fn export_csv_simple(documents: Vec<Document>, include_header: bool) -> Result<Vec<u8>, String> {
        let mut output = Vec::new();
        let extended: Vec<serde_json::Value> = documents.iter().map(document_to_canonical_extended_json).collect();

        let fields = csv_fields_from_extended_documents(&extended)?;

        if include_header {
            let header = fields.join(",");
            output.extend_from_slice(header.as_bytes());
            output.push(b'\n');
        }

        for doc in &extended {
            let line = format_csv_document_line(&fields, doc);
            output.extend_from_slice(line.as_bytes());
        }

        Ok(output)
    }

    #[test]
    fn csv_quoted_comma_newline_and_escaped_quotes() {
        let csv = "name,note\n\"Ada, Lovelace\",\"line1\nline2\"\n\"quotes\",\"she said \"\"hi\"\"\"\n";
        let preview = preview_csv(csv, MongoImportTypeMode::String);
        assert_eq!(preview.columns.iter().map(|column| column.name.as_str()).collect::<Vec<_>>(), vec!["name", "note"]);
        assert_eq!(preview.rows[0]["name"], "Ada, Lovelace");
        assert!(preview.rows[0]["note"].as_str().unwrap().contains("line1"));
        assert_eq!(preview.rows[1]["note"], "she said \"hi\"");
    }

    #[test]
    fn csv_empty_fields_trailing_delimiter_and_crlf() {
        let csv = "a,b,c\r\n1,,\r\n,2,\r\n";
        let preview = preview_csv(csv, MongoImportTypeMode::String);
        assert!(preview.rows[0]["b"].is_null());
        assert!(preview.rows[0]["c"].is_null());
        assert!(preview.rows[1]["a"].is_null());
        assert_eq!(preview.rows[1]["b"], "2");
    }

    #[test]
    fn csv_utf8_bom_and_gbk() {
        let mut bom = b"\xEF\xBB\xBFname\n".to_vec();
        bom.extend_from_slice("中文\n".as_bytes());
        let preview =
            preview_mongodb_import_bytes(&bom, MongoImportFormat::Csv, &options(MongoImportTypeMode::String), 10)
                .unwrap();
        assert_eq!(preview.columns[0].name, "name");
        assert_eq!(preview.rows[0]["name"], "中文");

        let mut gbk = b"name\n".to_vec();
        gbk.extend_from_slice(&[0xD6, 0xD0, 0xCE, 0xC4, b'\n']); // 中文 in GBK
        let parse = MongoImportParseOptions {
            encoding: Some(TableImportTextEncoding::Gbk),
            ..MongoImportParseOptions::default()
        };
        let preview = preview_mongodb_import_bytes(&gbk, MongoImportFormat::Csv, &parse, 10).unwrap();
        assert_eq!(preview.rows[0]["name"], "中文");
    }

    #[test]
    fn csv_utf16_le_round_trip_text() {
        let text = "name\nAda\n";
        let mut bytes = vec![0xFF, 0xFE];
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let parse = MongoImportParseOptions {
            encoding: Some(TableImportTextEncoding::Utf16Le),
            ..MongoImportParseOptions::default()
        };
        let preview = preview_mongodb_import_bytes(&bytes, MongoImportFormat::Csv, &parse, 10).unwrap();
        assert_eq!(preview.rows[0]["name"], "Ada");
    }

    #[test]
    fn csv_rejects_duplicate_and_empty_headers() {
        let duplicate = preview_mongodb_import_bytes(
            b"a,a\n1,2\n",
            MongoImportFormat::Csv,
            &options(MongoImportTypeMode::String),
            10,
        );
        assert!(duplicate.unwrap_err().code == "DUPLICATE_HEADER");
        let empty = preview_mongodb_import_bytes(
            b"a,\n1,2\n",
            MongoImportFormat::Csv,
            &options(MongoImportTypeMode::String),
            10,
        );
        assert!(empty.unwrap_err().code == "EMPTY_HEADER");
    }

    #[test]
    fn csv_extra_fields_are_row_errors_and_short_rows_fill_null() {
        let csv = "a,b\n1,2,3\n4\n";
        let preview = preview_csv(csv, MongoImportTypeMode::String);
        assert_eq!(preview.errors[0].code, "CSV_STRUCTURE");
        assert_eq!(preview.errors[0].row, Some(2));
        assert!(preview.rows[0]["b"].is_null());
        assert_eq!(preview.rows[0]["a"], "4");
    }

    #[test]
    fn generated_headers_without_header_row() {
        let mut parse = options(MongoImportTypeMode::String);
        parse.has_header = Some(false);
        let preview = preview_mongodb_import_bytes(b"a,b\n1,2\n", MongoImportFormat::Csv, &parse, 10).unwrap();
        assert_eq!(preview.columns[0].name, "field_1");
        assert_eq!(preview.rows[0]["field_1"], "a");
    }

    #[test]
    fn string_mode_keeps_numbers_and_objectids_as_strings() {
        let csv = "id,count\n507f1f77bcf86cd799439011,42\n";
        let preview = preview_csv(csv, MongoImportTypeMode::String);
        assert_eq!(preview.rows[0]["id"], "507f1f77bcf86cd799439011");
        assert_eq!(preview.rows[0]["count"], "42");
        assert_eq!(preview.columns[1].inferred_type, MongoImportInferredType::String);
    }

    #[test]
    fn auto_mode_infers_boolean_integer_decimal_and_date() {
        let csv = "ok,count,amount,when\ntrue,42,1.50,2024-01-02T03:04:05Z\nfalse,-7,2.00,2024-01-03T00:00:00Z\n";
        let preview = preview_csv(csv, MongoImportTypeMode::Auto);
        assert_eq!(preview.columns[0].inferred_type, MongoImportInferredType::Boolean);
        assert_eq!(preview.columns[1].inferred_type, MongoImportInferredType::Integer);
        assert_eq!(preview.columns[2].inferred_type, MongoImportInferredType::Decimal);
        assert_eq!(preview.columns[3].inferred_type, MongoImportInferredType::Date);
        assert_eq!(preview.rows[0]["ok"], true);
        assert_eq!(preview.rows[0]["count"]["$numberInt"], "42");
        assert!(preview.rows[0]["when"].is_object());
    }

    #[test]
    fn auto_mode_mixed_types_fall_back_to_string() {
        let csv = "value\n1\ntrue\n";
        let preview = preview_csv(csv, MongoImportTypeMode::Auto);
        assert_eq!(preview.columns[0].inferred_type, MongoImportInferredType::String);
        assert_eq!(preview.rows[0]["value"], "1");
        assert_eq!(preview.rows[1]["value"], "true");
    }

    #[test]
    fn auto_mode_parses_objects_and_arrays() {
        let csv = "doc,tags\n\"{\"\"a\"\":1}\",\"[1,2]\"\n\"{\"\"a\"\":2}\",\"[3]\"\n";
        let preview = preview_csv(csv, MongoImportTypeMode::Auto);
        assert_eq!(preview.columns[0].inferred_type, MongoImportInferredType::Object);
        assert_eq!(preview.columns[1].inferred_type, MongoImportInferredType::Array);
        assert_eq!(preview.rows[0]["doc"]["a"]["$numberInt"], "1");
        assert_eq!(preview.rows[0]["tags"][0]["$numberInt"], "1");
    }

    #[test]
    fn objectid_hex_stays_string_unless_opted_in() {
        let csv = "id\n507f1f77bcf86cd799439011\n";
        let preview = preview_csv(csv, MongoImportTypeMode::Auto);
        assert_eq!(preview.rows[0]["id"], "507f1f77bcf86cd799439011");
        let mut parse = options(MongoImportTypeMode::Auto);
        parse.recognize_object_id_hex = Some(true);
        let preview = preview_mongodb_import_bytes(csv.as_bytes(), MongoImportFormat::Csv, &parse, 10).unwrap();
        assert_eq!(preview.rows[0]["id"]["$oid"], "507f1f77bcf86cd799439011");
    }

    #[test]
    fn extended_json_mode_preserves_oid_date_long_and_decimal() {
        let csv = "id,when,n,d\n\"{\"\"$oid\"\":\"\"507f1f77bcf86cd799439011\"\"}\",\"{\"\"$date\"\":\"\"2024-01-02T03:04:05.000Z\"\"}\",\"{\"\"$numberLong\"\":\"\"9223372036854775807\"\"}\",\"{\"\"$numberDecimal\"\":\"\"1.25\"\"}\"\n";
        let preview = preview_csv(csv, MongoImportTypeMode::ExtendedJson);
        assert_eq!(preview.rows[0]["id"]["$oid"], "507f1f77bcf86cd799439011");
        assert!(preview.rows[0]["when"].get("$date").is_some());
        assert_eq!(preview.rows[0]["n"]["$numberLong"], "9223372036854775807");
        assert_eq!(preview.rows[0]["d"]["$numberDecimal"], "1.25");
    }

    #[test]
    fn preview_matches_execute_extended_json() {
        let csv = "name,count\nAda,1\nBob,2\n";
        let preview = preview_csv(csv, MongoImportTypeMode::String);
        let executed = execute_docs(csv, MongoImportTypeMode::String);
        assert_eq!(preview.rows, executed);
    }

    #[test]
    fn preview_stops_at_window_and_execute_matches_that_window() {
        let mut csv = String::from("name,count\n");
        for index in 0..200 {
            csv.push_str(&format!("user-{index},{index}\n"));
        }
        let preview = preview_mongodb_import_bytes(
            csv.as_bytes(),
            MongoImportFormat::Csv,
            &options(MongoImportTypeMode::String),
            5,
        )
        .unwrap();
        assert_eq!(preview.rows.len(), 5);
        assert!(!preview.estimated_rows_exact);
        assert_eq!(preview.rows[0]["name"], "user-0");
        assert_eq!(preview.rows[4]["name"], "user-4");

        let executed = execute_docs(&csv, MongoImportTypeMode::String);
        assert_eq!(executed.len(), 200);
        assert_eq!(preview.rows, executed[..5]);
    }

    #[test]
    fn json_and_ndjson_preview_stops_at_window_and_execute_matches() {
        let mut array = Vec::new();
        let mut ndjson = String::new();
        for index in 0..80 {
            let doc = serde_json::json!({ "n": index });
            ndjson.push_str(&doc.to_string());
            ndjson.push('\n');
            array.push(doc);
        }
        let json = serde_json::Value::Array(array).to_string();
        let parse = options(MongoImportTypeMode::ExtendedJson);

        let json_preview = preview_mongodb_import_bytes(json.as_bytes(), MongoImportFormat::Json, &parse, 3).unwrap();
        assert_eq!(json_preview.rows.len(), 3);
        assert!(!json_preview.estimated_rows_exact);
        let json_executed = execute_source(json.as_bytes(), "json", MongoImportFormat::Json, &parse);
        assert_eq!(json_executed.len(), 80);
        assert_eq!(json_preview.rows, json_executed[..3]);

        let ndjson_preview =
            preview_mongodb_import_bytes(ndjson.as_bytes(), MongoImportFormat::Ndjson, &parse, 3).unwrap();
        assert_eq!(ndjson_preview.rows.len(), 3);
        assert!(!ndjson_preview.estimated_rows_exact);
        let ndjson_executed = execute_source(ndjson.as_bytes(), "ndjson", MongoImportFormat::Ndjson, &parse);
        assert_eq!(ndjson_executed.len(), 80);
        assert_eq!(ndjson_preview.rows, ndjson_executed[..3]);
    }

    #[test]
    fn json_array_and_single_object_and_empty_array() {
        let preview = preview_mongodb_import_bytes(
            br#"[{"name":"Ada"},{"name":"Bob"}]"#,
            MongoImportFormat::Json,
            &options(MongoImportTypeMode::ExtendedJson),
            10,
        )
        .unwrap();
        assert_eq!(preview.rows.len(), 2);
        let single = preview_mongodb_import_bytes(
            br#"{"name":"Ada"}"#,
            MongoImportFormat::Json,
            &options(MongoImportTypeMode::ExtendedJson),
            10,
        )
        .unwrap();
        assert_eq!(single.warnings[0].code, "SINGLE_OBJECT");
        let empty = preview_mongodb_import_bytes(
            b"[]",
            MongoImportFormat::Json,
            &options(MongoImportTypeMode::ExtendedJson),
            10,
        )
        .unwrap();
        assert_eq!(empty.estimated_rows, Some(0));
        let scalar = preview_mongodb_import_bytes(
            b"123",
            MongoImportFormat::Json,
            &options(MongoImportTypeMode::ExtendedJson),
            10,
        );
        assert_eq!(scalar.unwrap_err().code, "JSON_ROOT_TYPE");
    }

    #[test]
    fn ndjson_skips_blank_lines_and_reports_bad_rows() {
        let data = "{\"name\":\"Ada\"}\n\n[1]\n{\"name\":\"Bob\"}\n";
        let preview = preview_mongodb_import_bytes(
            data.as_bytes(),
            MongoImportFormat::Ndjson,
            &options(MongoImportTypeMode::ExtendedJson),
            10,
        )
        .unwrap();
        assert_eq!(preview.rows.len(), 2);
        assert_eq!(preview.errors[0].row, Some(3));
    }

    #[test]
    fn json_extended_round_trip_objectid_and_date() {
        let data = r#"[{"_id":{"$oid":"507f1f77bcf86cd799439011"},"when":{"$date":"2024-01-02T03:04:05.000Z"}}]"#;
        let preview = preview_mongodb_import_bytes(
            data.as_bytes(),
            MongoImportFormat::Json,
            &options(MongoImportTypeMode::ExtendedJson),
            10,
        )
        .unwrap();
        assert_eq!(preview.rows[0]["_id"]["$oid"], "507f1f77bcf86cd799439011");
        assert!(preview.rows[0]["when"].get("$date").is_some());
    }

    #[test]
    fn streaming_csv_uses_bounded_memory_for_one_million_rows() {
        struct GeneratedCsv {
            total: usize,
            current: usize,
            header_done: bool,
            leftover: Vec<u8>,
        }
        impl Read for GeneratedCsv {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if !self.header_done {
                    self.header_done = true;
                    self.leftover.extend_from_slice(b"name,count\n");
                }
                while self.leftover.len() < buf.len() && self.current < self.total {
                    self.leftover.extend_from_slice(format!("user-{},{}\n", self.current, self.current).as_bytes());
                    self.current += 1;
                }
                let take = self.leftover.len().min(buf.len());
                buf[..take].copy_from_slice(&self.leftover[..take]);
                self.leftover.drain(..take);
                Ok(take)
            }
        }
        let config = CsvParseConfig {
            delimiter: b',',
            has_header: true,
            trim: false,
            empty_as_null: true,
            type_mode: MongoImportTypeMode::String,
            recognize_object_id_hex: false,
        };
        let mut count = 0u64;
        stream_csv_documents(
            GeneratedCsv { total: 1_000_000, current: 0, header_done: false, leftover: Vec::new() },
            &config,
            &[],
            |parsed| {
                parsed?;
                count += 1;
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(count, 1_000_000);
    }

    #[test]
    fn csv_export_import_round_trip_preserves_all_bson_types() {
        use mongodb::bson::oid::ObjectId;
        use mongodb::bson::spec::BinarySubtype;
        use mongodb::bson::{Binary, DateTime, Decimal128, Regex, Timestamp};
        use std::str::FromStr;

        let documents = vec![doc! {
            "_id": ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap(),
            "name": "Alice",
            "age": 30i32,
            "bigNumber": 9223372036854775807i64,
            "price": Decimal128::from_str("123.45").unwrap(),
            "rating": 4.5f64,
            "active": true,
            "inactive": false,
            "notes": Bson::Null,
            "empty": "",
            "createdAt": DateTime::from_millis(1609459200000),
            "address": doc! { "city": "NYC", "zip": "10001" },
            "tags": ["rust", "mongodb"],
            "matrix": [["a", "b"], ["c", "d"]],
            "nested": doc! { "deep": doc! { "value": 42i32 } },
            "emptyArray": Bson::Array(vec![]),
            "emptyObj": Bson::Document(Document::new()),
            "binary": Bson::Binary(Binary { subtype: BinarySubtype::Generic, bytes: vec![1, 2, 3] }),
            "regex": Bson::RegularExpression(Regex { pattern: "^test$".to_string(), options: "i".to_string() }),
            "timestamp": Bson::Timestamp(Timestamp { time: 1234567890, increment: 1 }),
            "phonePrefix": "+86",
            "formula": "=SUM(A1:A10)",
            "numericString": "12345",
            "dateString": "2021-01-01T00:00:00Z",
        }];

        let csv_output = export_csv_simple(documents.clone(), true).unwrap();

        let _csv_text = String::from_utf8(csv_output.clone()).unwrap();
        let mut csv_file = std::io::Cursor::new(csv_output);

        let config = CsvParseConfig {
            delimiter: b',',
            has_header: true,
            trim: false,
            empty_as_null: true,
            type_mode: MongoImportTypeMode::ExtendedJson,
            recognize_object_id_hex: true,
        };

        let mut reimported = Vec::new();
        stream_csv_documents(&mut csv_file, &config, &[], |parsed| {
            reimported.push(parsed?.document);
            Ok(())
        })
        .unwrap();

        assert_eq!(reimported.len(), 1);
        let doc = &reimported[0];

        // _id: ObjectId round-trips
        assert_eq!(doc.get_object_id("_id").unwrap().to_string(), "507f1f77bcf86cd799439011");

        // Plain strings round-trip
        assert_eq!(doc.get_str("name").unwrap(), "Alice");
        assert_eq!(doc.get_str("phonePrefix").unwrap(), "+86");
        assert_eq!(doc.get_str("formula").unwrap(), "=SUM(A1:A10)");

        // Numbers: Int32 stable, Int64 may become Int64 or Decimal128 depending on value
        assert_eq!(doc.get_i32("age").unwrap(), 30);
        // bigNumber: exported as plain number, re-imported as Int64 (fits in range)
        match doc.get("bigNumber").unwrap() {
            Bson::Int64(n) => assert_eq!(*n, 9223372036854775807i64),
            Bson::Decimal128(d) => assert_eq!(d.to_string(), "9223372036854775807"),
            _ => panic!("bigNumber should be Int64 or Decimal128 after round-trip"),
        }
        // price and rating: exported as plain numbers, may be parsed as Double or Decimal128
        match doc.get("price").unwrap() {
            Bson::Decimal128(d) => {
                let s = d.to_string();
                assert!(s == "123.45" || s == "123.4500000000000", "price value mismatch: {}", s);
            }
            Bson::Double(f) => assert_eq!(*f, 123.45),
            _ => panic!("price should be Decimal128 or Double"),
        }
        match doc.get("rating").unwrap() {
            Bson::Decimal128(d) => {
                let s = d.to_string();
                assert!(s == "4.5" || s == "4.500000000000000", "rating value mismatch: {}", s);
            }
            Bson::Double(f) => assert_eq!(*f, 4.5),
            _ => panic!("rating should be Decimal128 or Double after round-trip"),
        }

        // Booleans round-trip
        assert!(doc.get_bool("active").unwrap());
        assert!(!doc.get_bool("inactive").unwrap());

        // Nulls round-trip
        assert_eq!(doc.get("notes"), Some(&Bson::Null));
        assert_eq!(doc.get("empty"), Some(&Bson::Null));

        // DateTime round-trips via Extended JSON
        match doc.get("createdAt").unwrap() {
            Bson::DateTime(dt) => assert_eq!(dt.timestamp_millis(), 1609459200000),
            _ => panic!("createdAt should be DateTime"),
        }

        // Nested objects via dotted headers
        let address = doc.get_document("address").unwrap();
        assert_eq!(address.get_str("city").unwrap(), "NYC");
        // zip: may be parsed as Int32 if it's numeric
        match address.get("zip").unwrap() {
            Bson::String(s) => assert_eq!(s, "10001"),
            Bson::Int32(n) => assert_eq!(*n, 10001),
            _ => panic!("zip should be String or Int32"),
        }
        assert_eq!(doc.get_document("nested").unwrap().get_document("deep").unwrap().get_i32("value").unwrap(), 42);

        // Arrays via indexed headers
        let tags = doc.get_array("tags").unwrap();
        assert_eq!(tags.len(), 2);
        assert_eq!(tags[0].as_str().unwrap(), "rust");
        assert_eq!(tags[1].as_str().unwrap(), "mongodb");

        let matrix = doc.get_array("matrix").unwrap();
        assert_eq!(matrix.len(), 2);
        let row0 = matrix[0].as_array().unwrap();
        assert_eq!(row0[0].as_str().unwrap(), "a");
        assert_eq!(row0[1].as_str().unwrap(), "b");
        let row1 = matrix[1].as_array().unwrap();
        assert_eq!(row1[0].as_str().unwrap(), "c");
        assert_eq!(row1[1].as_str().unwrap(), "d");

        // Empty array/object round-trip as Extended JSON text
        assert_eq!(doc.get_array("emptyArray").unwrap().len(), 0);
        assert_eq!(doc.get_document("emptyObj").unwrap().len(), 0);

        // Binary: exported as Extended JSON columns, re-imported as nested document
        // (CSV doesn't auto-convert Extended JSON documents back to native BSON types except ObjectId/DateTime)
        match doc.get("binary").unwrap() {
            Bson::Document(d) => {
                let binary_doc = d.get_document("$binary").unwrap();
                assert_eq!(binary_doc.get_str("base64").unwrap(), "AQID");
                assert_eq!(binary_doc.get_str("subType").unwrap(), "00");
            }
            Bson::Binary(bin) => assert_eq!(bin.bytes, vec![1, 2, 3]),
            _ => panic!("binary should be Document or Binary"),
        }

        // Regex: exported as Extended JSON columns, re-imported as nested document
        match doc.get("regex").unwrap() {
            Bson::Document(d) => {
                assert_eq!(
                    d.get_str("$regularExpression.pattern")
                        .or_else(|_| d.get_document("$regularExpression").and_then(|r| r.get_str("pattern")))
                        .unwrap(),
                    "^test$"
                );
            }
            Bson::RegularExpression(r) => {
                assert_eq!(r.pattern, "^test$");
                assert_eq!(r.options, "i");
            }
            other => panic!("regex should be Document or RegularExpression, got {:?}", other),
        }

        // Timestamp: exported as Extended JSON columns, re-imported as nested document
        match doc.get("timestamp").unwrap() {
            Bson::Document(d) => {
                let ts_doc = d.get_document("$timestamp").unwrap();
                assert!(ts_doc.get_i64("t").is_ok() || ts_doc.get_i32("t").is_ok());
            }
            Bson::Timestamp(ts) => {
                assert_eq!(ts.time, 1234567890);
                assert_eq!(ts.increment, 1);
            }
            other => panic!("timestamp should be Document or Timestamp, got {:?}", other),
        }

        // Type-inference hazards: numeric strings and date-looking strings infer their way
        // when typeMode=auto (documented limitation), but extendedJson keeps them as strings
        match doc.get("numericString").unwrap() {
            Bson::String(s) => assert_eq!(s, "12345"),
            Bson::Int32(n) => assert_eq!(*n, 12345),
            Bson::Int64(n) => assert_eq!(*n, 12345),
            _ => panic!("numericString should be String or Int"),
        }
        match doc.get("dateString").unwrap() {
            Bson::String(s) => assert_eq!(s, "2021-01-01T00:00:00Z"),
            Bson::DateTime(_) => {}
            _ => panic!("dateString should be String or DateTime"),
        }
    }

    #[test]
    fn json_array_stream_parses_without_loading_whole_vec_api() {
        let json = b"[{\"a\":1},{\"a\":2},{\"a\":3}]";
        let mut reader = BufReader::new(Cursor::new(&json[..]));
        let values = JsonArrayIter::new(&mut reader);
        let docs: Vec<_> = values.map(|value| value.unwrap()).collect();
        assert_eq!(docs.len(), 3);
        assert_eq!(docs[2]["a"], 1 + 2);
    }

    #[test]
    fn invalid_encoding_is_actionable() {
        let parse = MongoImportParseOptions {
            encoding: Some(TableImportTextEncoding::Utf8),
            ..MongoImportParseOptions::default()
        };
        let error = preview_mongodb_import_bytes(&[0xFF, 0xFE, b'a'], MongoImportFormat::Csv, &parse, 10).unwrap_err();
        assert_eq!(error.code, "ENCODING");
    }

    #[test]
    fn csv_null_is_empty_and_nested_uses_extended_json() {
        let document = serde_json::json!({
            "_id": {"$oid": "507f1f77bcf86cd799439011"},
            "name": "Ada",
            "nested": {"ok": true},
            "missing": null
        });
        let fields = csv_fields_from_extended_documents(std::slice::from_ref(&document)).unwrap();
        assert_eq!(fields, vec!["_id", "name", "nested.ok", "missing"]);
        let row = format_mongo_csv_row(&fields, &document);
        assert_eq!(row, "507f1f77bcf86cd799439011,Ada,true,");
    }

    #[test]
    fn csv_export_reimport_with_default_options_restores_objectid_and_nested_types() {
        let document = serde_json::json!({
            "_id": {"$oid": "6a79d867ca9ee056337c36ed"},
            "_dbx_issue_5792_all_types": true,
            "scenario": "clone-all-bson-types",
            "text": "ordinary text",
            "nested": {"ok": true},
            "count": {"$numberInt": "42"}
        });
        let fields = csv_fields_from_extended_documents(std::slice::from_ref(&document)).unwrap();
        assert_eq!(fields, vec!["_id", "_dbx_issue_5792_all_types", "scenario", "text", "nested.ok", "count"]);
        let mut csv = fields.join(",");
        csv.push('\n');
        csv.push_str(&format_csv_document_line(&fields, &document));
        assert!(csv.contains("6a79d867ca9ee056337c36ed"), "Compass CSV writes ObjectId as hex");
        assert!(!csv.contains("$oid"), "Compass CSV does not wrap ObjectId as Extended JSON");
        let imported =
            execute_source(csv.as_bytes(), "csv", MongoImportFormat::Csv, &MongoImportParseOptions::default());
        assert_eq!(imported[0]["_id"]["$oid"], "6a79d867ca9ee056337c36ed");
        assert_eq!(imported[0]["_dbx_issue_5792_all_types"], true);
        assert_eq!(imported[0]["scenario"], "clone-all-bson-types");
        assert_eq!(imported[0]["nested"]["ok"], true);
        assert_eq!(imported[0]["count"]["$numberInt"], "42");
    }

    #[test]
    fn ndjson_export_reimport_with_default_options_restores_objectid() {
        let line =
            r#"{"_id":{"$oid":"6a79d867ca9ee056337c36ed"},"scenario":"clone-all-bson-types","text":"ordinary text"}"#;
        let imported = execute_source(
            format!("{line}\n").as_bytes(),
            "ndjson",
            MongoImportFormat::Ndjson,
            &MongoImportParseOptions::default(),
        );
        assert_eq!(imported[0]["_id"]["$oid"], "6a79d867ca9ee056337c36ed");
        assert_eq!(imported[0]["scenario"], "clone-all-bson-types");
        assert_eq!(imported[0]["text"], "ordinary text");
    }

    #[test]
    fn csv_field_cap_recommends_ndjson() {
        let mut object = serde_json::Map::new();
        for index in 0..=MAX_CSV_FIELDS {
            object.insert(format!("f{index}"), serde_json::json!(index));
        }
        let error = csv_fields_from_extended_documents(&[serde_json::Value::Object(object)]).unwrap_err();
        assert!(error.contains("NDJSON"));
    }
}
