use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Read as IoRead, Seek, SeekFrom, Write as IoWrite};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};

use calamine::{
    open_workbook_auto, CellType, Data, DataRef, ExcelDateTime, Range, Reader as CalamineReader,
    ReaderRef as CalamineReaderRef,
};
use chrono::{DateTime, NaiveDate, NaiveDateTime};
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader as XmlReader;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::connection::{task_client_session_id, AppState, PoolKind};
use crate::models::connection::DatabaseType;
use crate::transfer::{
    execute_on_pool, generate_insert_typed, generate_insert_typed_sql_batches, get_columns_for_transfer,
    qualified_table, quote_identifier,
};

pub const DEFAULT_PREVIEW_LIMIT: usize = 50;
pub const DEFAULT_BATCH_SIZE: usize = 500;
pub const CREATE_TABLE_INFERENCE_ROWS: usize = 100;
pub const MAX_NON_STREAMING_IMPORT_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_LEGACY_XLS_IMPORT_BYTES: u64 = 50 * 1024 * 1024;
const IMPORT_PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
// Keep preview parsing bounded even when an XLSX dimension declares a huge sparse range.
const MAX_FAST_PREVIEW_CELLS: usize = 100_000;
// Shared strings stay in memory for small workbooks and spill to an indexed temp file for large ones.
const MAX_IN_MEMORY_XLSX_SHARED_STRINGS_BYTES: u64 = 8 * 1024 * 1024;
const MAX_XLSX_SHARED_STRINGS_BYTES: u64 = 1024 * 1024 * 1024;
const XLSX_SHARED_STRING_CACHE_ENTRIES: usize = 4096;
const XLSX_SHARED_STRING_CACHE_BYTES: usize = 8 * 1024 * 1024;
// INSERT ALL has a practical statement-size limit on Oracle, even when the requested batch is larger.
const MAX_ORACLE_IMPORT_BATCH_ROWS: usize = 500;

pub fn table_import_client_session_id(import_id: &str) -> String {
    task_client_session_id("table-import", import_id)
}

#[derive(Debug, Clone)]
pub struct ParsedImportFile {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub total_rows: usize,
    pub effective_encoding: Option<TableImportTextEncoding>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportSqlBatch {
    pub sql: String,
    pub row_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CompiledImportPlan {
    mapped_source_indexes: Vec<usize>,
    target_columns: Vec<String>,
    column_types: Vec<Option<String>>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TableImportTextEncoding {
    Auto,
    Utf8,
    Gbk,
    Utf16Le,
    Utf16Be,
}

impl TableImportTextEncoding {
    fn encoding(self) -> Option<&'static encoding_rs::Encoding> {
        match self {
            TableImportTextEncoding::Auto => None,
            TableImportTextEncoding::Utf8 => Some(encoding_rs::UTF_8),
            TableImportTextEncoding::Gbk => Some(encoding_rs::GBK),
            TableImportTextEncoding::Utf16Le => Some(encoding_rs::UTF_16LE),
            TableImportTextEncoding::Utf16Be => Some(encoding_rs::UTF_16BE),
        }
    }

    fn label(self) -> &'static str {
        match self {
            TableImportTextEncoding::Auto => "auto",
            TableImportTextEncoding::Utf8 => "UTF-8",
            TableImportTextEncoding::Gbk => "GBK / GB18030",
            TableImportTextEncoding::Utf16Le => "UTF-16 LE",
            TableImportTextEncoding::Utf16Be => "UTF-16 BE",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableImportParseOptions {
    pub delimiter: Option<String>,
    pub encoding: Option<TableImportTextEncoding>,
    pub has_header: Option<bool>,
    pub title_row: Option<usize>,
    pub data_start_row: Option<usize>,
    pub last_data_row: Option<usize>,
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
            encoding: Some(TableImportTextEncoding::Auto),
            has_header: None,
            title_row: None,
            data_start_row: None,
            last_data_row: None,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_time_format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prepared_source: Option<TableImportPreparedSource>,
    #[serde(default)]
    pub retain_source: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableImportPreparedSource {
    pub fingerprint: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub total_rows: usize,
    #[serde(default = "default_true")]
    pub total_rows_exact: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_encoding: Option<TableImportTextEncoding>,
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
    pub total_rows_exact: bool,
    pub source_fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_encoding: Option<TableImportTextEncoding>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sheets: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableImportSummary {
    pub import_id: String,
    pub rows_imported: usize,
    pub total_rows: usize,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableImportProgress {
    pub import_id: String,
    pub status: TableImportStatus,
    pub phase: TableImportPhase,
    pub rows_imported: usize,
    pub total_rows: usize,
    pub total_rows_exact: bool,
    pub bytes_read: u64,
    pub total_bytes: u64,
    pub elapsed_ms: u128,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TableImportStatus {
    Running,
    Done,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TableImportPhase {
    Preparing,
    DetectingEncoding,
    Reading,
    Writing,
    Finalizing,
    Done,
}

const fn default_true() -> bool {
    true
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
    pub trim_values: bool,
    pub empty_string_as_null: bool,
    pub row_range: ImportRowRange,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportRowRange {
    pub title_row: Option<usize>,
    pub data_start_row: usize,
    pub last_data_row: Option<usize>,
}

pub fn effective_import_row_range(options: &TableImportParseOptions) -> Result<ImportRowRange, String> {
    let title_row = match options.title_row {
        Some(0) => None,
        Some(row) => Some(row),
        None if options.has_header.unwrap_or(true) => Some(1),
        None => None,
    };
    let data_start_row = options.data_start_row.unwrap_or_else(|| title_row.map_or(1, |row| row + 1));
    let last_data_row = options.last_data_row.filter(|row| *row > 0);
    if data_start_row == 0 {
        return Err("Data start row must be at least 1".to_string());
    }
    if title_row.is_some_and(|row| row >= data_start_row) {
        return Err("Title row must be before the data start row".to_string());
    }
    if last_data_row.is_some_and(|last| last < data_start_row) {
        return Err("Last data row must be 0 or not less than the data start row".to_string());
    }
    Ok(ImportRowRange { title_row, data_start_row, last_data_row })
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
        trim_values: options.trim_values.unwrap_or(false),
        empty_string_as_null: options.empty_string_as_null.unwrap_or(true),
        row_range: effective_import_row_range(options)?,
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
        DelimitedParseConfig {
            delimiter: b',',
            trim_values: false,
            empty_string_as_null: true,
            row_range: ImportRowRange { title_row: Some(1), data_start_row: 2, last_data_row: None },
        },
    )
}

const IMPORT_ENCODING_READ_CHUNK_BYTES: usize = 16 * 1024;

// Decodes incrementally and rejects malformed input instead of silently inserting replacement characters.
struct StrictTranscodingReader<R> {
    reader: R,
    decoder: encoding_rs::Decoder,
    encoding: TableImportTextEncoding,
    pending_input: Vec<u8>,
    pending_output: Vec<u8>,
    output_offset: usize,
    reached_eof: bool,
    finished: bool,
    source_bytes_read: u64,
}

impl<R: IoRead> StrictTranscodingReader<R> {
    fn new(reader: R, encoding: TableImportTextEncoding) -> Result<Self, String> {
        let decoder = encoding
            .encoding()
            .ok_or_else(|| "Automatic text encoding must be resolved before decoding".to_string())?
            .new_decoder_without_bom_handling();
        Ok(Self {
            reader,
            decoder,
            encoding,
            pending_input: Vec::with_capacity(IMPORT_ENCODING_READ_CHUNK_BYTES),
            pending_output: Vec::new(),
            output_offset: 0,
            reached_eof: false,
            finished: false,
            source_bytes_read: 0,
        })
    }

    fn source_bytes_read(&self) -> u64 {
        self.source_bytes_read
    }

    fn invalid_data_error(&self) -> std::io::Error {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Invalid byte sequence for {} encoding", self.encoding.label()),
        )
    }
}

impl<R: IoRead> IoRead for StrictTranscodingReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }

        loop {
            if self.output_offset < self.pending_output.len() {
                let available = &self.pending_output[self.output_offset..];
                let copied = available.len().min(buffer.len());
                buffer[..copied].copy_from_slice(&available[..copied]);
                self.output_offset += copied;
                if self.output_offset == self.pending_output.len() {
                    self.pending_output.clear();
                    self.output_offset = 0;
                }
                return Ok(copied);
            }
            if self.finished {
                return Ok(0);
            }

            if self.pending_input.is_empty() && !self.reached_eof {
                let mut input = [0u8; IMPORT_ENCODING_READ_CHUNK_BYTES];
                let read = self.reader.read(&mut input)?;
                self.source_bytes_read = self.source_bytes_read.saturating_add(read as u64);
                if read == 0 {
                    self.reached_eof = true;
                } else {
                    self.pending_input.extend_from_slice(&input[..read]);
                }
            }

            let output_capacity = self
                .decoder
                .max_utf8_buffer_length_without_replacement(self.pending_input.len())
                .unwrap_or(self.pending_input.len().saturating_mul(3).saturating_add(4))
                .max(4);
            self.pending_output.resize(output_capacity, 0);
            let (result, read, written) = self.decoder.decode_to_utf8_without_replacement(
                &self.pending_input,
                &mut self.pending_output,
                self.reached_eof,
            );
            self.pending_input.drain(..read);
            self.pending_output.truncate(written);

            match result {
                encoding_rs::DecoderResult::Malformed(_, _) => return Err(self.invalid_data_error()),
                encoding_rs::DecoderResult::InputEmpty if self.reached_eof => self.finished = true,
                encoding_rs::DecoderResult::InputEmpty | encoding_rs::DecoderResult::OutputFull => {}
            }
        }
    }
}

fn bom_text_encoding(bytes: &[u8]) -> Option<(TableImportTextEncoding, usize)> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        Some((TableImportTextEncoding::Utf8, 3))
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        Some((TableImportTextEncoding::Utf16Le, 2))
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        Some((TableImportTextEncoding::Utf16Be, 2))
    } else {
        None
    }
}

fn matching_bom_len(bytes: &[u8], encoding: TableImportTextEncoding) -> usize {
    bom_text_encoding(bytes).filter(|(bom_encoding, _)| *bom_encoding == encoding).map(|(_, len)| len).unwrap_or(0)
}

fn reader_is_valid_for_encoding<R: IoRead>(reader: R, encoding: TableImportTextEncoding) -> Result<bool, String> {
    let mut reader = StrictTranscodingReader::new(reader, encoding)?;
    match std::io::copy(&mut reader, &mut std::io::sink()) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::InvalidData => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn validate_text_encoding_from_file_with_progress(
    path: &str,
    encoding: TableImportTextEncoding,
    bom_len: usize,
    mut on_progress: impl FnMut(u64),
) -> Result<(), String> {
    let total_bytes = std::fs::metadata(path).map(|metadata| metadata.len()).unwrap_or_default();
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(bom_len as u64)).map_err(|error| error.to_string())?;
    let mut reader = StrictTranscodingReader::new(file, encoding)?;
    let mut buffer = [0u8; IMPORT_ENCODING_READ_CHUNK_BYTES];
    let mut last_reported = None;
    loop {
        let read = reader.read(&mut buffer).map_err(|error| error.to_string())?;
        let bytes_read = (bom_len as u64).saturating_add(reader.source_bytes_read()).min(total_bytes);
        if last_reported != Some(bytes_read) {
            on_progress(bytes_read);
            last_reported = Some(bytes_read);
        }
        if read == 0 {
            break;
        }
    }
    if total_bytes > 0 && last_reported != Some(total_bytes) {
        on_progress(total_bytes);
    }
    Ok(())
}

fn auto_detect_text_encoding_from_bytes(bytes: &[u8]) -> Result<(TableImportTextEncoding, usize), String> {
    if let Some(detected) = bom_text_encoding(bytes) {
        return Ok(detected);
    }
    for encoding in [TableImportTextEncoding::Utf8, TableImportTextEncoding::Gbk] {
        if reader_is_valid_for_encoding(std::io::Cursor::new(bytes), encoding)? {
            return Ok((encoding, 0));
        }
    }
    Err("Could not detect text encoding; select UTF-8, GBK / GB18030, or UTF-16 manually".to_string())
}

fn resolve_text_encoding_from_bytes(
    bytes: &[u8],
    requested: Option<TableImportTextEncoding>,
) -> Result<(TableImportTextEncoding, usize), String> {
    let requested = requested.unwrap_or(TableImportTextEncoding::Auto);
    if requested == TableImportTextEncoding::Auto {
        auto_detect_text_encoding_from_bytes(bytes)
    } else {
        Ok((requested, matching_bom_len(bytes, requested)))
    }
}

struct EncodingValidationState {
    decoder: encoding_rs::Decoder,
    pending: Vec<u8>,
    output: Vec<u8>,
    valid: bool,
}

impl EncodingValidationState {
    fn new(encoding: &'static encoding_rs::Encoding) -> Self {
        Self {
            decoder: encoding.new_decoder_without_bom_handling(),
            pending: Vec::new(),
            output: Vec::new(),
            valid: true,
        }
    }

    fn push(&mut self, input: &[u8], last: bool) {
        if !self.valid {
            return;
        }
        self.pending.extend_from_slice(input);
        loop {
            let output_capacity = self
                .decoder
                .max_utf8_buffer_length_without_replacement(self.pending.len())
                .unwrap_or(self.pending.len().saturating_mul(3).saturating_add(4))
                .max(4);
            self.output.resize(output_capacity, 0);
            let (result, read, _) =
                self.decoder.decode_to_utf8_without_replacement(&self.pending, &mut self.output, last);
            self.pending.drain(..read);
            match result {
                encoding_rs::DecoderResult::Malformed(_, _) => {
                    self.valid = false;
                    self.pending.clear();
                    return;
                }
                encoding_rs::DecoderResult::InputEmpty => return,
                encoding_rs::DecoderResult::OutputFull if read == 0 => {
                    self.valid = false;
                    self.pending.clear();
                    return;
                }
                encoding_rs::DecoderResult::OutputFull => {}
            }
        }
    }
}

fn auto_detect_text_encoding_from_file_with_progress(
    path: &str,
    mut on_progress: impl FnMut(u64),
) -> Result<(TableImportTextEncoding, usize), String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut prefix = [0u8; 3];
    let prefix_len = file.read(&mut prefix).map_err(|error| error.to_string())?;
    if let Some((detected, bom_len)) = bom_text_encoding(&prefix[..prefix_len]) {
        validate_text_encoding_from_file_with_progress(path, detected, bom_len, &mut on_progress)?;
        return Ok((detected, bom_len));
    }

    file.seek(SeekFrom::Start(0)).map_err(|error| error.to_string())?;
    // Validate both candidates incrementally so auto-detection does not load the file into memory.
    let mut utf8 = EncodingValidationState::new(encoding_rs::UTF_8);
    let mut gbk = EncodingValidationState::new(encoding_rs::GBK);
    let mut bytes_read = 0u64;
    let mut input = [0u8; IMPORT_ENCODING_READ_CHUNK_BYTES];
    loop {
        let read = file.read(&mut input).map_err(|error| error.to_string())?;
        if read == 0 {
            utf8.push(&[], true);
            gbk.push(&[], true);
            break;
        }
        utf8.push(&input[..read], false);
        gbk.push(&input[..read], false);
        bytes_read = bytes_read.saturating_add(read as u64);
        on_progress(bytes_read);
    }
    if utf8.valid {
        return Ok((TableImportTextEncoding::Utf8, 0));
    }
    if gbk.valid {
        return Ok((TableImportTextEncoding::Gbk, 0));
    }
    Err("Could not detect text encoding; select UTF-8, GBK / GB18030, or UTF-16 manually".to_string())
}

fn resolve_text_encoding_from_file_with_progress(
    path: &str,
    requested: Option<TableImportTextEncoding>,
    on_progress: impl FnMut(u64),
) -> Result<(TableImportTextEncoding, usize), String> {
    let requested = requested.unwrap_or(TableImportTextEncoding::Auto);
    if requested == TableImportTextEncoding::Auto {
        return auto_detect_text_encoding_from_file_with_progress(path, on_progress);
    }

    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut prefix = [0u8; 3];
    let prefix_len = file.read(&mut prefix).map_err(|error| error.to_string())?;
    Ok((requested, matching_bom_len(&prefix[..prefix_len], requested)))
}

fn resolve_and_validate_text_encoding_from_file(
    path: &str,
    requested: Option<TableImportTextEncoding>,
    mut on_progress: impl FnMut(u64),
) -> Result<(TableImportTextEncoding, usize), String> {
    let requested = requested.unwrap_or(TableImportTextEncoding::Auto);
    let (encoding, bom_len) = if requested == TableImportTextEncoding::Auto {
        auto_detect_text_encoding_from_file_with_progress(path, &mut on_progress)?
    } else {
        let mut file = File::open(path).map_err(|error| error.to_string())?;
        let mut prefix = [0u8; 3];
        let prefix_len = file.read(&mut prefix).map_err(|error| error.to_string())?;
        let bom_len = matching_bom_len(&prefix[..prefix_len], requested);
        validate_text_encoding_from_file_with_progress(path, requested, bom_len, on_progress)?;
        (requested, bom_len)
    };
    Ok((encoding, bom_len))
}

fn open_delimited_csv_reader_with_progress(
    path: &str,
    source_format: TableImportSourceFormat,
    options: &TableImportParseOptions,
    on_encoding_progress: impl FnMut(u64),
) -> Result<(csv::Reader<StrictTranscodingReader<File>>, DelimitedParseConfig, TableImportTextEncoding), String> {
    let config = effective_delimited_config(source_format, options)?;
    let (encoding, bom_len) =
        resolve_text_encoding_from_file_with_progress(path, options.encoding, on_encoding_progress)?;
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(bom_len as u64)).map_err(|error| error.to_string())?;
    let transcoded = StrictTranscodingReader::new(file, encoding)?;
    let reader =
        csv::ReaderBuilder::new().delimiter(config.delimiter).has_headers(false).flexible(true).from_reader(transcoded);
    Ok((reader, config, encoding))
}

pub fn parse_delimited_reader<R: std::io::Read>(
    reader: R,
    config: DelimitedParseConfig,
    preview_limit: usize,
) -> Result<ParsedImportFile, String> {
    parse_decoded_delimited_reader(reader, config, preview_limit, TableImportTextEncoding::Utf8)
}

fn parse_decoded_delimited_reader<R: IoRead>(
    reader: R,
    config: DelimitedParseConfig,
    preview_limit: usize,
    effective_encoding: TableImportTextEncoding,
) -> Result<ParsedImportFile, String> {
    let reader =
        csv::ReaderBuilder::new().delimiter(config.delimiter).has_headers(false).flexible(true).from_reader(reader);
    parse_csv_reader(reader, config, preview_limit, effective_encoding)
}

pub fn parse_delimited_bytes_with_options(
    bytes: &[u8],
    source_format: TableImportSourceFormat,
    options: &TableImportParseOptions,
    preview_limit: usize,
) -> Result<ParsedImportFile, String> {
    let (encoding, bom_len) = resolve_text_encoding_from_bytes(bytes, options.encoding)?;
    let reader = StrictTranscodingReader::new(std::io::Cursor::new(&bytes[bom_len..]), encoding)?;
    parse_decoded_delimited_reader(reader, effective_delimited_config(source_format, options)?, preview_limit, encoding)
}

pub fn parse_delimited_file_with_options(
    path: &str,
    source_format: TableImportSourceFormat,
    options: &TableImportParseOptions,
    preview_limit: usize,
) -> Result<ParsedImportFile, String> {
    if options.encoding.unwrap_or(TableImportTextEncoding::Auto) == TableImportTextEncoding::Auto {
        let mut file = File::open(path).map_err(|error| error.to_string())?;
        let mut prefix = [0u8; 3];
        let prefix_len = file.read(&mut prefix).map_err(|error| error.to_string())?;
        if let Some((encoding, _)) = bom_text_encoding(&prefix[..prefix_len]) {
            let mut explicit_options = options.clone();
            explicit_options.encoding = Some(encoding);
            let (reader, config, encoding) =
                open_delimited_csv_reader_with_progress(path, source_format, &explicit_options, |_| {})?;
            return parse_csv_reader(reader, config, preview_limit, encoding);
        }

        for encoding in [TableImportTextEncoding::Utf8, TableImportTextEncoding::Gbk] {
            let mut explicit_options = options.clone();
            explicit_options.encoding = Some(encoding);
            let (reader, config, encoding) =
                open_delimited_csv_reader_with_progress(path, source_format, &explicit_options, |_| {})?;
            match parse_csv_reader(reader, config, preview_limit, encoding) {
                Ok(parsed) => return Ok(parsed),
                Err(error) if error.starts_with("Invalid byte sequence for ") => continue,
                Err(error) => return Err(error),
            }
        }
        return Err("Could not detect text encoding; select UTF-8, GBK / GB18030, or UTF-16 manually".to_string());
    }

    let (reader, config, encoding) = open_delimited_csv_reader_with_progress(path, source_format, options, |_| {})?;
    parse_csv_reader(reader, config, preview_limit, encoding)
}

fn parse_csv_reader<R: IoRead>(
    mut reader: csv::Reader<R>,
    config: DelimitedParseConfig,
    preview_limit: usize,
    effective_encoding: TableImportTextEncoding,
) -> Result<ParsedImportFile, String> {
    parse_csv_reader_inner(&mut reader, config, preview_limit, effective_encoding, true)
}

fn parse_csv_reader_bounded<R: IoRead>(
    mut reader: csv::Reader<R>,
    config: DelimitedParseConfig,
    preview_limit: usize,
    effective_encoding: TableImportTextEncoding,
) -> Result<ParsedImportFile, String> {
    parse_csv_reader_inner(&mut reader, config, preview_limit.max(1), effective_encoding, false)
}

fn parse_csv_reader_inner<R: IoRead>(
    reader: &mut csv::Reader<R>,
    config: DelimitedParseConfig,
    preview_limit: usize,
    effective_encoding: TableImportTextEncoding,
    count_all_rows: bool,
) -> Result<ParsedImportFile, String> {
    let mut rows = Vec::new();
    let mut total_rows = 0;
    let mut columns = Vec::new();
    let mut record = csv::StringRecord::new();
    let mut index = 0usize;
    while reader.read_record(&mut record).map_err(|e| e.to_string())? {
        index += 1;
        let row_number = index;
        if config.row_range.title_row == Some(row_number) {
            columns = record
                .iter()
                .enumerate()
                .map(|(index, header)| normalize_header(header.trim_start_matches('\u{feff}'), index))
                .collect();
            continue;
        }
        if row_number < config.row_range.data_start_row {
            continue;
        }
        if config.row_range.last_data_row.is_some_and(|last| row_number > last) {
            break;
        }
        if columns.is_empty() {
            columns = (0..record.len()).map(|index| format!("column_{}", index + 1)).collect();
        }
        total_rows += 1;
        if rows.len() < preview_limit {
            rows.push(delimited_record_to_row(&record, columns.len(), config));
        }
        if !count_all_rows && rows.len() >= preview_limit {
            break;
        }
    }
    if columns.is_empty() {
        return Err("Import file has no columns in the selected row range".to_string());
    }
    if total_rows == 0 {
        return Err("Import file has no data rows in the selected row range".to_string());
    }
    Ok(ParsedImportFile { columns, rows, total_rows, effective_encoding: Some(effective_encoding) })
}

fn parse_delimited_preview_file_with_options(
    path: &str,
    source_format: TableImportSourceFormat,
    options: &TableImportParseOptions,
    preview_limit: usize,
) -> Result<ParsedImportFile, String> {
    if options.encoding.unwrap_or(TableImportTextEncoding::Auto) == TableImportTextEncoding::Auto {
        let mut file = File::open(path).map_err(|error| error.to_string())?;
        let mut prefix = [0u8; 3];
        let prefix_len = file.read(&mut prefix).map_err(|error| error.to_string())?;
        if let Some((encoding, _)) = bom_text_encoding(&prefix[..prefix_len]) {
            let mut explicit_options = options.clone();
            explicit_options.encoding = Some(encoding);
            let (reader, config, encoding) =
                open_delimited_csv_reader_with_progress(path, source_format, &explicit_options, |_| {})?;
            return parse_csv_reader_bounded(reader, config, preview_limit, encoding);
        }

        for encoding in [TableImportTextEncoding::Utf8, TableImportTextEncoding::Gbk] {
            let mut explicit_options = options.clone();
            explicit_options.encoding = Some(encoding);
            let (reader, config, encoding) =
                open_delimited_csv_reader_with_progress(path, source_format, &explicit_options, |_| {})?;
            match parse_csv_reader_bounded(reader, config, preview_limit, encoding) {
                Ok(parsed) => return Ok(parsed),
                Err(error) if error.starts_with("Invalid byte sequence for ") => continue,
                Err(error) => return Err(error),
            }
        }
        return Err("Could not detect text encoding; select UTF-8, GBK / GB18030, or UTF-16 manually".to_string());
    }

    let (reader, config, encoding) = open_delimited_csv_reader_with_progress(path, source_format, options, |_| {})?;
    parse_csv_reader_bounded(reader, config, preview_limit, encoding)
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
        return Ok(ParsedImportFile { columns, rows, total_rows: items.len(), effective_encoding: None });
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
        return Ok(ParsedImportFile { columns, rows, total_rows: items.len(), effective_encoding: None });
    }

    Err("JSON rows must all be objects or all be arrays; mixed row shapes are not supported".to_string())
}

pub fn parse_json_bytes(bytes: &[u8], preview_limit: usize) -> Result<ParsedImportFile, String> {
    parse_json_bytes_with_options(bytes, &TableImportParseOptions::default(), preview_limit)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum XlsxTemporalKind {
    Date,
    Time,
    DateTime,
    Duration,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct XlsxCellStyle {
    temporal_kind: Option<XlsxTemporalKind>,
    number_format: Option<Arc<str>>,
}

fn format_chrono_duration_hms(duration: chrono::Duration, wrap_to_day: bool) -> String {
    let mut millis = duration.num_milliseconds();
    let negative = millis < 0;
    if negative {
        millis = -millis;
    }

    const DAY_MILLIS: i64 = 24 * 60 * 60 * 1000;
    if wrap_to_day {
        millis %= DAY_MILLIS;
    }

    let hours = millis / (60 * 60 * 1000);
    let minutes = (millis / (60 * 1000)) % 60;
    let seconds = (millis / 1000) % 60;
    let sub_millis = millis % 1000;
    let sign = if negative { "-" } else { "" };
    if sub_millis == 0 {
        format!("{sign}{hours:02}:{minutes:02}:{seconds:02}")
    } else {
        let fraction = format!("{sub_millis:03}").trim_end_matches('0').to_string();
        format!("{sign}{hours:02}:{minutes:02}:{seconds:02}.{fraction}")
    }
}

fn xlsx_datetime_label(value: &ExcelDateTime, temporal_kind: Option<XlsxTemporalKind>) -> String {
    if matches!(temporal_kind, Some(XlsxTemporalKind::Duration)) || value.is_duration() {
        return value
            .as_duration()
            .map(|duration| format_chrono_duration_hms(duration, false))
            .unwrap_or_else(|| value.to_string());
    }

    if matches!(temporal_kind, Some(XlsxTemporalKind::Time)) {
        return value
            .as_duration()
            .map(|duration| format_chrono_duration_hms(duration, true))
            .unwrap_or_else(|| value.to_string());
    }

    let Some(datetime) = value.as_datetime() else {
        return value.to_string();
    };

    match temporal_kind {
        Some(XlsxTemporalKind::Date) => datetime.format("%Y-%m-%d").to_string(),
        Some(XlsxTemporalKind::DateTime) => datetime.format("%Y-%m-%d %H:%M:%S%.f").to_string(),
        None => {
            if (0.0..1.0).contains(&value.as_f64()) {
                value.to_string()
            } else {
                datetime.format("%Y-%m-%d %H:%M:%S%.f").to_string()
            }
        }
        Some(XlsxTemporalKind::Time) | Some(XlsxTemporalKind::Duration) => unreachable!("handled above"),
    }
}

fn xlsx_cell_value_with_temporal_kind(cell: &Data, temporal_kind: Option<XlsxTemporalKind>) -> serde_json::Value {
    match cell {
        Data::Empty => serde_json::Value::Null,
        Data::String(s) => csv_value(s),
        Data::Float(n) => {
            serde_json::Number::from_f64(*n).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
        }
        Data::Int(n) => serde_json::Value::Number((*n).into()),
        Data::Bool(v) => serde_json::Value::Bool(*v),
        Data::DateTime(v) => serde_json::Value::String(xlsx_datetime_label(v, temporal_kind)),
        Data::DateTimeIso(v) => serde_json::Value::String(v.clone()),
        Data::DurationIso(v) => serde_json::Value::String(v.clone()),
        Data::Error(v) => serde_json::Value::String(v.to_string()),
    }
}

fn xlsx_numeric_display_text(value: f64, style: Option<&XlsxCellStyle>) -> String {
    style
        .and_then(|style| style.number_format.as_deref())
        .and_then(|format_code| {
            let format = ssfmt::NumberFormat::parse(format_code).ok()?;
            let mut options = ssfmt::FormatOptions::default();
            let lcid = format.sections().iter().flat_map(|section| &section.parts).find_map(|part| match part {
                ssfmt::ast::FormatPart::Locale(locale) => locale.lcid,
                _ => None,
            });
            // ssfmt 0.1 only provides en-US locale data; preserve the German separators explicitly.
            if lcid == Some(0x0407) {
                options.locale.decimal_separator = ',';
                options.locale.thousands_separator = '.';
            }
            Some(format.format(value, &options))
        })
        .unwrap_or_else(|| value.to_string())
}

fn xlsx_cell_text_value(cell: &Data, style: Option<&XlsxCellStyle>) -> Option<String> {
    if style.and_then(|style| style.temporal_kind).is_some() {
        return None;
    }
    match cell {
        Data::Float(value) if value.is_finite() => Some(xlsx_numeric_display_text(*value, style)),
        Data::Int(value) => Some(xlsx_numeric_display_text(*value as f64, style)),
        _ => None,
    }
}

pub fn xlsx_cell_value(cell: &Data) -> serde_json::Value {
    xlsx_cell_value_with_temporal_kind(cell, None)
}

fn xlsx_cell_label_with_temporal_kind(cell: &Data, temporal_kind: Option<XlsxTemporalKind>) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Float(n) => n.to_string(),
        Data::Int(n) => n.to_string(),
        Data::Bool(v) => v.to_string(),
        Data::DateTime(v) => xlsx_datetime_label(v, temporal_kind),
        Data::DateTimeIso(v) => v.clone(),
        Data::DurationIso(v) => v.clone(),
        Data::Error(v) => v.to_string(),
    }
}

pub fn xlsx_cell_label(cell: &Data) -> String {
    xlsx_cell_label_with_temporal_kind(cell, None)
}

fn xlsx_cell_ref_value_with_temporal_kind(
    cell: &DataRef<'_>,
    temporal_kind: Option<XlsxTemporalKind>,
) -> serde_json::Value {
    match cell {
        DataRef::Empty => serde_json::Value::Null,
        DataRef::String(s) => csv_value(s),
        DataRef::SharedString(s) => csv_value(s),
        DataRef::Float(n) => {
            serde_json::Number::from_f64(*n).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
        }
        DataRef::Int(n) => serde_json::Value::Number((*n).into()),
        DataRef::Bool(v) => serde_json::Value::Bool(*v),
        DataRef::DateTime(v) => serde_json::Value::String(xlsx_datetime_label(v, temporal_kind)),
        DataRef::DateTimeIso(v) => serde_json::Value::String(v.clone()),
        DataRef::DurationIso(v) => serde_json::Value::String(v.clone()),
        DataRef::Error(v) => serde_json::Value::String(v.to_string()),
    }
}

fn xlsx_cell_ref_label_with_temporal_kind(cell: &DataRef<'_>, temporal_kind: Option<XlsxTemporalKind>) -> String {
    match cell {
        DataRef::Empty => String::new(),
        DataRef::String(s) => s.clone(),
        DataRef::SharedString(s) => (*s).to_string(),
        DataRef::Float(n) => n.to_string(),
        DataRef::Int(n) => n.to_string(),
        DataRef::Bool(v) => v.to_string(),
        DataRef::DateTime(v) => xlsx_datetime_label(v, temporal_kind),
        DataRef::DateTimeIso(v) => v.clone(),
        DataRef::DurationIso(v) => v.clone(),
        DataRef::Error(v) => v.to_string(),
    }
}

pub fn xlsx_sheet_names(path: &str) -> Result<Vec<String>, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
    let workbook_xml = read_xlsx_zip_text(&mut zip, "xl/workbook.xml")?;
    Ok(xlsx_workbook_sheet_refs(&workbook_xml).into_iter().map(|(name, _)| name).collect())
}

fn xml_local_name_eq(name: &[u8], expected: &[u8]) -> bool {
    name.rsplit(|byte| *byte == b':').next().is_some_and(|local| local.eq_ignore_ascii_case(expected))
}

fn xml_attr_value<R>(reader: &XmlReader<R>, element: &BytesStart<'_>, key: &[u8]) -> Option<String> {
    element.attributes().flatten().find_map(|attr| {
        if xml_local_name_eq(attr.key.as_ref(), key) {
            attr.decode_and_unescape_value(reader.decoder()).ok().map(|value| value.into_owned())
        } else {
            None
        }
    })
}

fn xlsx_builtin_temporal_kind(num_fmt_id: u16) -> Option<XlsxTemporalKind> {
    match num_fmt_id {
        14..=17 => Some(XlsxTemporalKind::Date),
        18..=21 | 45 | 47 => Some(XlsxTemporalKind::Time),
        22 => Some(XlsxTemporalKind::DateTime),
        46 => Some(XlsxTemporalKind::Duration),
        _ => None,
    }
}

fn xlsx_temporal_kind_from_format_code(format_code: &str) -> Option<XlsxTemporalKind> {
    let mut normalized = String::new();
    let mut chars = format_code.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => {
                for quoted in chars.by_ref() {
                    if quoted == '"' {
                        break;
                    }
                }
            }
            '\\' | '_' | '*' => {
                let _ = chars.next();
            }
            ';' => break,
            '[' => {
                let mut bracket = String::new();
                for bracket_ch in chars.by_ref() {
                    if bracket_ch == ']' {
                        break;
                    }
                    bracket.push(bracket_ch);
                }
                let bracket = bracket.trim().to_ascii_lowercase();
                if matches!(bracket.as_str(), "h" | "hh" | "m" | "mm" | "s" | "ss") {
                    return Some(XlsxTemporalKind::Duration);
                }
            }
            _ => normalized.push(ch.to_ascii_lowercase()),
        }
    }

    let has_time = normalized.contains('h')
        || normalized.contains('s')
        || normalized.contains("am/pm")
        || normalized.contains("a/p");
    let has_month = normalized.contains('m');
    let has_date = normalized.contains('y') || normalized.contains('d') || (has_month && !has_time);
    match (has_date, has_time) {
        (true, true) => Some(XlsxTemporalKind::DateTime),
        (true, false) => Some(XlsxTemporalKind::Date),
        (false, true) => Some(XlsxTemporalKind::Time),
        (false, false) => None,
    }
}

fn parse_xlsx_styles(styles_xml: &str) -> Vec<XlsxCellStyle> {
    let mut reader = XmlReader::from_str(styles_xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut custom_formats = HashMap::<u16, String>::new();
    let mut styles = Vec::new();
    let mut in_cell_xfs = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(element)) | Ok(Event::Empty(element))
                if xml_local_name_eq(element.name().as_ref(), b"numFmt") =>
            {
                let id = xml_attr_value(&reader, &element, b"numFmtId").and_then(|value| value.parse::<u16>().ok());
                let format_code = xml_attr_value(&reader, &element, b"formatCode");
                if let (Some(id), Some(format_code)) = (id, format_code) {
                    custom_formats.insert(id, format_code);
                }
            }
            Ok(Event::Start(element)) if xml_local_name_eq(element.name().as_ref(), b"cellXfs") => {
                in_cell_xfs = true;
            }
            Ok(Event::End(element)) if xml_local_name_eq(element.name().as_ref(), b"cellXfs") => {
                in_cell_xfs = false;
            }
            Ok(Event::Start(element)) | Ok(Event::Empty(element))
                if in_cell_xfs && xml_local_name_eq(element.name().as_ref(), b"xf") =>
            {
                let num_fmt_id =
                    xml_attr_value(&reader, &element, b"numFmtId").and_then(|value| value.parse::<u16>().ok());
                let custom_format_code = num_fmt_id.and_then(|id| custom_formats.get(&id).map(String::as_str));
                let temporal_kind = num_fmt_id.and_then(|id| {
                    custom_formats
                        .get(&id)
                        .and_then(|code| xlsx_temporal_kind_from_format_code(code))
                        .or_else(|| xlsx_builtin_temporal_kind(id))
                });
                styles.push(XlsxCellStyle {
                    temporal_kind,
                    number_format: if temporal_kind.is_none() {
                        custom_format_code
                            .or_else(|| num_fmt_id.and_then(|id| ssfmt::format_code_from_id(id as u32)))
                            .map(Arc::<str>::from)
                    } else {
                        None
                    },
                });
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    styles
}

fn xlsx_workbook_sheet_refs(workbook_xml: &str) -> Vec<(String, Option<String>)> {
    let mut reader = XmlReader::from_str(workbook_xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut sheets = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(element)) | Ok(Event::Empty(element))
                if xml_local_name_eq(element.name().as_ref(), b"sheet") =>
            {
                if let Some(name) = xml_attr_value(&reader, &element, b"name") {
                    sheets.push((name, xml_attr_value(&reader, &element, b"id")));
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    sheets
}

fn xlsx_workbook_relationship_targets(rels_xml: &str) -> HashMap<String, String> {
    let mut reader = XmlReader::from_str(rels_xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut targets = HashMap::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(element)) | Ok(Event::Empty(element))
                if xml_local_name_eq(element.name().as_ref(), b"Relationship") =>
            {
                if let (Some(id), Some(target)) =
                    (xml_attr_value(&reader, &element, b"Id"), xml_attr_value(&reader, &element, b"Target"))
                {
                    targets.insert(id, target);
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    targets
}

fn xlsx_relationship_target_path(base_dir: &str, target: &str) -> String {
    if target.starts_with('/') {
        return target.trim_start_matches('/').to_string();
    }

    let mut parts = base_dir.split('/').filter(|part| !part.is_empty()).collect::<Vec<_>>();
    for part in target.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    parts.join("/")
}

fn xlsx_sheet_path_for_name(workbook_xml: &str, rels_xml: &str, sheet_name: &str) -> Option<String> {
    let sheets = xlsx_workbook_sheet_refs(workbook_xml);
    let (index, (_, rel_id)) = sheets.iter().enumerate().find(|(_, (name, _))| name == sheet_name)?;
    let rel_targets = xlsx_workbook_relationship_targets(rels_xml);
    rel_id
        .as_ref()
        .and_then(|id| rel_targets.get(id))
        .map(|target| xlsx_relationship_target_path("xl", target))
        .or_else(|| Some(format!("xl/worksheets/sheet{}.xml", index + 1)))
}

fn xlsx_workbook_uses_1904_date_system(workbook_xml: &str) -> bool {
    let mut reader = XmlReader::from_str(workbook_xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(element)) | Ok(Event::Empty(element))
                if xml_local_name_eq(element.name().as_ref(), b"workbookPr") =>
            {
                return xml_attr_value(&reader, &element, b"date1904")
                    .is_some_and(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true"));
            }
            Ok(Event::Eof) | Err(_) => return false,
            _ => {}
        }
        buf.clear();
    }
}

fn xlsx_cell_ref_position(reference: &str) -> Option<(usize, usize)> {
    let mut column = 0usize;
    let mut row = 0usize;
    let mut saw_column = false;
    let mut saw_row = false;
    for ch in reference.chars() {
        if ch == '$' {
            continue;
        }
        if ch.is_ascii_alphabetic() && !saw_row {
            saw_column = true;
            column = column * 26 + (ch.to_ascii_uppercase() as u8 - b'A' + 1) as usize;
        } else if ch.is_ascii_digit() {
            saw_row = true;
            row = row * 10 + ch.to_digit(10)? as usize;
        } else {
            return None;
        }
    }
    (saw_column && saw_row).then_some((row, column))
}

fn parse_xlsx_sheet_cell_styles<R: BufRead>(
    source: R,
    styles: &[XlsxCellStyle],
    text_columns: &HashSet<usize>,
) -> Result<HashMap<(usize, usize), XlsxCellStyle>, String> {
    let mut reader = XmlReader::from_reader(source);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut cell_styles = HashMap::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(element)) | Ok(Event::Empty(element))
                if xml_local_name_eq(element.name().as_ref(), b"c") =>
            {
                let Some(style_id) =
                    xml_attr_value(&reader, &element, b"s").and_then(|value| value.parse::<usize>().ok())
                else {
                    buf.clear();
                    continue;
                };
                let Some(style) = styles.get(style_id) else {
                    buf.clear();
                    continue;
                };
                if let Some(position) =
                    xml_attr_value(&reader, &element, b"r").and_then(|reference| xlsx_cell_ref_position(&reference))
                {
                    if style.temporal_kind.is_some() || text_columns.contains(&position.1) {
                        cell_styles.insert(position, style.clone());
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(error.to_string()),
            _ => {}
        }
        buf.clear();
    }
    Ok(cell_styles)
}

fn read_xlsx_zip_text(zip: &mut zip::ZipArchive<File>, path: &str) -> Result<String, String> {
    let mut file = zip.by_name(path).map_err(|err| err.to_string())?;
    let mut content = String::new();
    file.read_to_string(&mut content).map_err(|err| err.to_string())?;
    Ok(content)
}

#[derive(Debug, Default)]
struct XlsxPreviewRawCell {
    cell_type: Option<String>,
    style_id: Option<usize>,
    value: String,
    inline_value: String,
}

fn xlsx_dimension_bounds(reference: &str) -> Option<((usize, usize), (usize, usize))> {
    let mut parts = reference.split(':');
    let start = xlsx_cell_ref_position(parts.next()?)?;
    let end = parts.next().and_then(xlsx_cell_ref_position).unwrap_or(start);
    Some((start, end))
}

fn read_xlsx_shared_strings(
    zip: &mut zip::ZipArchive<File>,
    needed: &HashSet<usize>,
) -> Result<HashMap<usize, String>, String> {
    if needed.is_empty() {
        return Ok(HashMap::new());
    }
    let max_needed = needed.iter().copied().max().unwrap_or_default();
    let file = zip.by_name("xl/sharedStrings.xml").map_err(|error| error.to_string())?;
    let mut reader = XmlReader::from_reader(BufReader::new(file));
    reader.config_mut().trim_text(false);
    let mut buf = Vec::new();
    let mut index = 0usize;
    let mut in_item = false;
    let mut in_text = false;
    let mut phonetic_depth = 0usize;
    let mut current = String::new();
    let mut strings = HashMap::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(element)) if xml_local_name_eq(element.name().as_ref(), b"si") => {
                in_item = true;
                current.clear();
            }
            Ok(Event::Start(element)) if in_item && xml_local_name_eq(element.name().as_ref(), b"t") => {
                in_text = phonetic_depth == 0;
            }
            Ok(Event::Start(element)) if in_item && xml_local_name_eq(element.name().as_ref(), b"rPh") => {
                phonetic_depth = phonetic_depth.saturating_add(1);
            }
            Ok(Event::Text(text)) if in_item && in_text => {
                current.push_str(&text.unescape().map_err(|error| error.to_string())?);
            }
            Ok(Event::End(element)) if xml_local_name_eq(element.name().as_ref(), b"t") => {
                in_text = false;
            }
            Ok(Event::End(element)) if in_item && xml_local_name_eq(element.name().as_ref(), b"rPh") => {
                phonetic_depth = phonetic_depth.saturating_sub(1);
            }
            Ok(Event::End(element)) if xml_local_name_eq(element.name().as_ref(), b"si") => {
                if needed.contains(&index) {
                    strings.insert(index, current.clone());
                }
                if index >= max_needed && strings.len() == needed.len() {
                    break;
                }
                index += 1;
                in_item = false;
                phonetic_depth = 0;
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(error.to_string()),
            _ => {}
        }
        buf.clear();
    }
    Ok(strings)
}

struct XlsxDiskSharedStrings {
    file: File,
    index: File,
    count: usize,
    cache: HashMap<usize, String>,
    cache_bytes: usize,
}

enum XlsxSharedStrings {
    Memory(Vec<String>),
    Disk(XlsxDiskSharedStrings),
}

impl XlsxSharedStrings {
    fn push(&mut self, value: &str) -> Result<(), String> {
        match self {
            Self::Memory(strings) => strings.push(value.to_string()),
            Self::Disk(store) => {
                let offset = store.file.stream_position().map_err(|error| error.to_string())?;
                let len = u32::try_from(value.len()).map_err(|_| "Excel shared string is too large".to_string())?;
                store.file.write_all(value.as_bytes()).map_err(|error| error.to_string())?;
                store.index.write_all(&offset.to_le_bytes()).map_err(|error| error.to_string())?;
                store.index.write_all(&len.to_le_bytes()).map_err(|error| error.to_string())?;
                store.count = store.count.saturating_add(1);
            }
        }
        Ok(())
    }

    fn get(&mut self, index: usize) -> Result<Option<String>, String> {
        match self {
            Self::Memory(strings) => Ok(strings.get(index).cloned()),
            Self::Disk(store) => {
                if let Some(value) = store.cache.get(&index) {
                    return Ok(Some(value.clone()));
                }
                if index >= store.count {
                    return Ok(None);
                }
                let index_offset = (index as u64).saturating_mul(12);
                store.index.seek(SeekFrom::Start(index_offset)).map_err(|error| error.to_string())?;
                let mut offset_bytes = [0u8; 8];
                let mut len_bytes = [0u8; 4];
                store.index.read_exact(&mut offset_bytes).map_err(|error| error.to_string())?;
                store.index.read_exact(&mut len_bytes).map_err(|error| error.to_string())?;
                let offset = u64::from_le_bytes(offset_bytes);
                let len = u32::from_le_bytes(len_bytes);
                store.file.seek(SeekFrom::Start(offset)).map_err(|error| error.to_string())?;
                let mut bytes = vec![0; len as usize];
                store.file.read_exact(&mut bytes).map_err(|error| error.to_string())?;
                let value = String::from_utf8(bytes).map_err(|error| error.to_string())?;
                // This cache is opportunistic; clearing it wholesale keeps lookup simple while
                // enforcing both the entry-count and byte-size bounds.
                if store.cache.len() >= XLSX_SHARED_STRING_CACHE_ENTRIES
                    || store.cache_bytes.saturating_add(value.len()) > XLSX_SHARED_STRING_CACHE_BYTES
                {
                    store.cache.clear();
                    store.cache_bytes = 0;
                }
                if value.len() <= XLSX_SHARED_STRING_CACHE_BYTES {
                    store.cache_bytes = store.cache_bytes.saturating_add(value.len());
                    store.cache.insert(index, value.clone());
                }
                Ok(Some(value))
            }
        }
    }

    #[cfg(test)]
    fn disk_files(&self) -> Option<(&File, &File)> {
        match self {
            Self::Memory(_) => None,
            Self::Disk(store) => Some((&store.file, &store.index)),
        }
    }
}

fn create_xlsx_spill_file() -> std::io::Result<File> {
    let file = tempfile::tempfile()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

fn open_xlsx_shared_strings(zip: &mut zip::ZipArchive<File>, memory_limit: u64) -> Result<XlsxSharedStrings, String> {
    let uncompressed_size = match zip.by_name("xl/sharedStrings.xml") {
        Ok(file) => file.size(),
        Err(zip::result::ZipError::FileNotFound) => return Ok(XlsxSharedStrings::Memory(Vec::new())),
        Err(error) => return Err(error.to_string()),
    };
    if uncompressed_size > MAX_XLSX_SHARED_STRINGS_BYTES {
        return Err(format!(
            "Excel shared strings are too large: {uncompressed_size} bytes (max {MAX_XLSX_SHARED_STRINGS_BYTES} bytes)"
        ));
    }
    // A fixed-width offset/length index lets cell parsing seek individual strings without
    // retaining the entire sharedStrings.xml payload in RAM.
    let mut strings = if uncompressed_size <= memory_limit {
        XlsxSharedStrings::Memory(Vec::new())
    } else {
        // Anonymous temporary files are owner-only on Unix and are removed by the OS when
        // their last handles close, including after abnormal process termination.
        let file = create_xlsx_spill_file().map_err(|error| error.to_string())?;
        let index = create_xlsx_spill_file().map_err(|error| error.to_string())?;
        XlsxSharedStrings::Disk(XlsxDiskSharedStrings { file, index, count: 0, cache: HashMap::new(), cache_bytes: 0 })
    };

    let file = zip.by_name("xl/sharedStrings.xml").map_err(|error| error.to_string())?;
    let mut reader = XmlReader::from_reader(BufReader::new(file));
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    let mut in_item = false;
    let mut in_text = false;
    let mut phonetic_depth = 0usize;
    let mut current = String::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(element)) if xml_local_name_eq(element.name().as_ref(), b"si") => {
                in_item = true;
                current.clear();
            }
            Ok(Event::Start(element)) if in_item && xml_local_name_eq(element.name().as_ref(), b"t") => {
                in_text = phonetic_depth == 0;
            }
            Ok(Event::Start(element)) if in_item && xml_local_name_eq(element.name().as_ref(), b"rPh") => {
                phonetic_depth = phonetic_depth.saturating_add(1);
            }
            Ok(Event::Text(text)) if in_item && in_text => {
                current.push_str(&text.unescape().map_err(|error| error.to_string())?);
            }
            Ok(Event::End(element)) if xml_local_name_eq(element.name().as_ref(), b"t") => {
                in_text = false;
            }
            Ok(Event::End(element)) if in_item && xml_local_name_eq(element.name().as_ref(), b"rPh") => {
                phonetic_depth = phonetic_depth.saturating_sub(1);
            }
            Ok(Event::End(element)) if xml_local_name_eq(element.name().as_ref(), b"si") => {
                strings.push(&current)?;
                in_item = false;
                phonetic_depth = 0;
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(error.to_string()),
            _ => {}
        }
        buffer.clear();
    }
    if let XlsxSharedStrings::Disk(store) = &mut strings {
        store.file.flush().map_err(|error| error.to_string())?;
        store.index.flush().map_err(|error| error.to_string())?;
    }
    Ok(strings)
}

fn xlsx_preview_cell_value(
    cell: &XlsxPreviewRawCell,
    shared_strings: &HashMap<usize, String>,
    styles: &[XlsxCellStyle],
    date_1904: bool,
) -> serde_json::Value {
    let cell_type = cell.cell_type.as_deref().unwrap_or_default();
    match cell_type {
        "s" => cell
            .value
            .parse::<usize>()
            .ok()
            .and_then(|index| shared_strings.get(&index))
            .map_or(serde_json::Value::Null, |value| csv_value(value)),
        "inlineStr" => csv_value(&cell.inline_value),
        "str" | "d" | "e" => csv_value(&cell.value),
        "b" => serde_json::Value::Bool(matches!(cell.value.trim(), "1" | "true" | "TRUE")),
        _ => {
            let Some(number) = cell.value.trim().parse::<f64>().ok() else {
                return if cell.value.is_empty() { serde_json::Value::Null } else { csv_value(&cell.value) };
            };
            let temporal_kind = cell.style_id.and_then(|style| styles.get(style)?.temporal_kind);
            if let Some(kind) = temporal_kind {
                let date_type = if kind == XlsxTemporalKind::Duration {
                    calamine::ExcelDateTimeType::TimeDelta
                } else {
                    calamine::ExcelDateTimeType::DateTime
                };
                let value = ExcelDateTime::new(number, date_type, date_1904);
                return serde_json::Value::String(xlsx_datetime_label(&value, Some(kind)));
            }
            serde_json::Number::from_f64(number).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
        }
    }
}

fn xlsx_preview_cell_label(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(value) => value.clone(),
        serde_json::Value::Bool(value) => value.to_string(),
        serde_json::Value::Number(value) => value.to_string(),
        value => value.to_string(),
    }
}

fn parse_xlsx_preview_file_with_options(
    path: &str,
    options: &TableImportParseOptions,
    preview_limit: usize,
) -> Result<(ParsedImportFile, Vec<String>), String> {
    // Read worksheet XML directly so preview can stop after the requested rows instead of
    // materializing the workbook's complete cell range.
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
    let workbook_xml = read_xlsx_zip_text(&mut zip, "xl/workbook.xml")?;
    let rels_xml = read_xlsx_zip_text(&mut zip, "xl/_rels/workbook.xml.rels").unwrap_or_default();
    let sheet_refs = xlsx_workbook_sheet_refs(&workbook_xml);
    let sheets = sheet_refs.iter().map(|(name, _)| name.clone()).collect::<Vec<_>>();
    let sheet_name = if let Some(name) = options.sheet_name.as_ref().filter(|name| !name.trim().is_empty()) {
        if !sheets.iter().any(|sheet| sheet == name) {
            return Err(format!("Workbook sheet not found: {name}"));
        }
        name.clone()
    } else if let Some(index) = options.sheet_index {
        sheets.get(index).cloned().ok_or_else(|| format!("Workbook sheet index out of range: {index}"))?
    } else {
        sheets.first().cloned().ok_or_else(|| "Workbook has no sheets".to_string())?
    };
    let sheet_path = xlsx_sheet_path_for_name(&workbook_xml, &rels_xml, &sheet_name)
        .ok_or_else(|| format!("Workbook sheet not found: {sheet_name}"))?;
    let styles_xml = read_xlsx_zip_text(&mut zip, "xl/styles.xml").unwrap_or_default();
    let styles = parse_xlsx_styles(&styles_xml);
    let date_1904 = xlsx_workbook_uses_1904_date_system(&workbook_xml);
    let row_range = effective_import_row_range(options)?;
    let preview_limit = preview_limit.max(1);
    let preview_last_row = row_range.data_start_row.saturating_add(preview_limit.saturating_sub(1));
    let requested_last_row = row_range.last_data_row.map_or(preview_last_row, |last| last.min(preview_last_row));
    let max_relative_row = requested_last_row.max(row_range.title_row.unwrap_or_default());

    let mut dimension = None;
    let mut raw_cells = HashMap::<(usize, usize), XlsxPreviewRawCell>::new();
    let mut observed_min_row = usize::MAX;
    let mut observed_min_column = usize::MAX;
    let mut observed_max_column = 0usize;
    let mut observed_max_row = 0usize;
    {
        let sheet = zip.by_name(&sheet_path).map_err(|error| error.to_string())?;
        let mut reader = XmlReader::from_reader(BufReader::new(sheet));
        reader.config_mut().trim_text(false);
        let mut buf = Vec::new();
        let mut current_position = None;
        let mut current_cell = XlsxPreviewRawCell::default();
        let mut current_row = 0usize;
        let mut current_column = 0usize;
        let mut in_value = false;
        let mut in_inline_text = false;
        let mut inline_phonetic_depth = 0usize;
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(element)) | Ok(Event::Empty(element))
                    if xml_local_name_eq(element.name().as_ref(), b"dimension") =>
                {
                    dimension = xml_attr_value(&reader, &element, b"ref").as_deref().and_then(xlsx_dimension_bounds);
                }
                Ok(Event::Start(element)) if xml_local_name_eq(element.name().as_ref(), b"row") => {
                    current_row = xml_attr_value(&reader, &element, b"r")
                        .and_then(|value| value.parse::<usize>().ok())
                        .filter(|row| *row > 0)
                        .unwrap_or_else(|| current_row.saturating_add(1).max(1));
                    current_column = 0;
                    if observed_min_row != usize::MAX {
                        let max_absolute_row = observed_min_row.saturating_add(max_relative_row.saturating_sub(1));
                        if current_row > max_absolute_row {
                            break;
                        }
                    }
                    observed_max_row = observed_max_row.max(current_row);
                }
                Ok(Event::Empty(element)) if xml_local_name_eq(element.name().as_ref(), b"c") => {
                    let position = xml_attr_value(&reader, &element, b"r")
                        .as_deref()
                        .and_then(xlsx_cell_ref_position)
                        .unwrap_or_else(|| (current_row.max(1), current_column.saturating_add(1).max(1)));
                    current_row = position.0;
                    current_column = position.1;
                    observed_min_row = observed_min_row.min(position.0);
                    observed_min_column = observed_min_column.min(position.1);
                    observed_max_row = observed_max_row.max(position.0);
                    observed_max_column = observed_max_column.max(position.1);
                }
                Ok(Event::Empty(element)) if xml_local_name_eq(element.name().as_ref(), b"c") => continue,
                Ok(Event::Start(element)) if xml_local_name_eq(element.name().as_ref(), b"c") => {
                    let position = xml_attr_value(&reader, &element, b"r")
                        .as_deref()
                        .and_then(xlsx_cell_ref_position)
                        .unwrap_or_else(|| (current_row.max(1), current_column.saturating_add(1).max(1)));
                    current_row = position.0;
                    current_column = position.1;
                    current_position = Some(position);
                    current_cell = XlsxPreviewRawCell {
                        cell_type: xml_attr_value(&reader, &element, b"t"),
                        style_id: xml_attr_value(&reader, &element, b"s").and_then(|value| value.parse::<usize>().ok()),
                        ..XlsxPreviewRawCell::default()
                    };
                }
                Ok(Event::Start(element)) if xml_local_name_eq(element.name().as_ref(), b"v") => {
                    in_value = true;
                }
                Ok(Event::Start(element)) if xml_local_name_eq(element.name().as_ref(), b"t") => {
                    in_inline_text = inline_phonetic_depth == 0;
                }
                Ok(Event::Start(element)) if xml_local_name_eq(element.name().as_ref(), b"rPh") => {
                    inline_phonetic_depth = inline_phonetic_depth.saturating_add(1);
                }
                Ok(Event::Text(text)) if in_value => {
                    current_cell.value.push_str(&text.unescape().map_err(|error| error.to_string())?);
                }
                Ok(Event::Text(text)) if in_inline_text => {
                    current_cell.inline_value.push_str(&text.unescape().map_err(|error| error.to_string())?);
                }
                Ok(Event::End(element)) if xml_local_name_eq(element.name().as_ref(), b"v") => {
                    in_value = false;
                }
                Ok(Event::End(element)) if xml_local_name_eq(element.name().as_ref(), b"t") => {
                    in_inline_text = false;
                }
                Ok(Event::End(element)) if xml_local_name_eq(element.name().as_ref(), b"rPh") => {
                    inline_phonetic_depth = inline_phonetic_depth.saturating_sub(1);
                }
                Ok(Event::End(element)) if xml_local_name_eq(element.name().as_ref(), b"c") => {
                    if let Some((row, column)) = current_position.take() {
                        observed_min_row = observed_min_row.min(row);
                        observed_min_column = observed_min_column.min(column);
                        observed_max_column = observed_max_column.max(column);
                        observed_max_row = observed_max_row.max(row);
                        let relative_row = row.saturating_sub(observed_min_row).saturating_add(1);
                        if relative_row == row_range.title_row.unwrap_or_default()
                            || (relative_row >= row_range.data_start_row && relative_row <= requested_last_row)
                        {
                            raw_cells.insert((row, column), std::mem::take(&mut current_cell));
                        }
                    }
                    inline_phonetic_depth = 0;
                    in_inline_text = false;
                }
                Ok(Event::Eof) => break,
                Err(error) => return Err(error.to_string()),
                _ => {}
            }
            buf.clear();
        }
    }

    let needed_shared_strings = raw_cells
        .values()
        .filter(|cell| cell.cell_type.as_deref() == Some("s"))
        .filter_map(|cell| cell.value.parse::<usize>().ok())
        .collect::<HashSet<_>>();
    let shared_strings = read_xlsx_shared_strings(&mut zip, &needed_shared_strings)?;
    if observed_min_row == usize::MAX || observed_min_column == usize::MAX {
        return Err("Import file has no data rows in the selected row range".to_string());
    }
    let start_row = observed_min_row;
    let start_column = observed_min_column;
    let observed_end_column = observed_max_column.max(start_column);
    let observed_column_count = observed_end_column.saturating_sub(start_column).saturating_add(1);
    let preview_row_count = requested_last_row
        .saturating_sub(row_range.data_start_row)
        .saturating_add(1)
        .saturating_add(usize::from(row_range.title_row.is_some()));
    if observed_column_count.saturating_mul(preview_row_count) > MAX_FAST_PREVIEW_CELLS {
        return Err(format!(
            "Excel preview grid is too large: {} columns across {} preview rows exceed the {} cell limit",
            observed_column_count, preview_row_count, MAX_FAST_PREVIEW_CELLS
        ));
    }
    let dimension_end_column = dimension
        .filter(|((dimension_start_row, dimension_start_column), _)| {
            *dimension_start_row == start_row && *dimension_start_column == start_column
        })
        .map(|(_, (_, end_column))| end_column)
        .filter(|end_column| {
            end_column.saturating_sub(start_column).saturating_add(1).saturating_mul(preview_row_count)
                <= MAX_FAST_PREVIEW_CELLS
        });
    let end_column = dimension_end_column.unwrap_or(observed_end_column).max(observed_end_column);
    let column_count = end_column.saturating_sub(start_column).saturating_add(1);
    let mut columns = if let Some(title_row) = row_range.title_row {
        let absolute_title_row = start_row.saturating_add(title_row.saturating_sub(1));
        (0..column_count)
            .map(|index| {
                let column = start_column + index;
                let value = raw_cells
                    .get(&(absolute_title_row, column))
                    .map(|cell| xlsx_preview_cell_value(cell, &shared_strings, &styles, date_1904))
                    .unwrap_or(serde_json::Value::Null);
                normalize_header(&xlsx_preview_cell_label(&value), index)
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    if columns.is_empty() {
        columns = (0..column_count).map(|index| format!("column_{}", index + 1)).collect();
    }
    if columns.is_empty() {
        return Err("Import file has no columns in the selected row range".to_string());
    }

    let observed_end_relative = observed_max_row.saturating_sub(start_row).saturating_add(1);
    let last_preview_row = requested_last_row.min(observed_end_relative);
    if last_preview_row < row_range.data_start_row {
        return Err("Import file has no data rows in the selected row range".to_string());
    }
    let rows = (row_range.data_start_row..=last_preview_row)
        .map(|relative_row| {
            let absolute_row = start_row + relative_row - 1;
            (0..columns.len())
                .map(|index| {
                    raw_cells
                        .get(&(absolute_row, start_column + index))
                        .map(|cell| xlsx_preview_cell_value(cell, &shared_strings, &styles, date_1904))
                        .unwrap_or(serde_json::Value::Null)
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    if rows.is_empty() {
        return Err("Import file has no data rows in the selected row range".to_string());
    }
    Ok((ParsedImportFile { columns, total_rows: rows.len(), rows, effective_encoding: None }, sheets))
}

fn xlsx_cell_styles(
    path: &str,
    sheet_name: &str,
    text_columns: &HashSet<usize>,
) -> Result<HashMap<(usize, usize), XlsxCellStyle>, String> {
    let file = File::open(path).map_err(|err| err.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|err| err.to_string())?;
    let styles_xml = read_xlsx_zip_text(&mut zip, "xl/styles.xml").unwrap_or_default();
    let styles = parse_xlsx_styles(&styles_xml);
    if styles.is_empty() {
        return Ok(HashMap::new());
    }

    let workbook_xml = read_xlsx_zip_text(&mut zip, "xl/workbook.xml")?;
    let rels_xml = read_xlsx_zip_text(&mut zip, "xl/_rels/workbook.xml.rels").unwrap_or_default();
    let Some(sheet_path) = xlsx_sheet_path_for_name(&workbook_xml, &rels_xml, sheet_name) else {
        return Ok(HashMap::new());
    };
    let sheet = zip.by_name(&sheet_path).map_err(|error| error.to_string())?;
    parse_xlsx_sheet_cell_styles(BufReader::new(sheet), &styles, text_columns)
}

fn is_legacy_xls_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("xls"))
}

fn xlsx_style_selection_columns<T, Label>(range: &Range<T>, row_range: ImportRowRange, cell_label: Label) -> Vec<String>
where
    T: CellType,
    Label: Fn(&T, Option<XlsxTemporalKind>) -> String,
{
    for (index, source_row) in range.rows().enumerate() {
        let row_number = index + 1;
        if row_range.title_row == Some(row_number) {
            return source_row
                .iter()
                .enumerate()
                .map(|(index, cell)| normalize_header(&cell_label(cell, None), index))
                .collect();
        }
        let row_is_within_range = match row_range.last_data_row {
            Some(last) => row_number <= last,
            None => true,
        };
        if row_number >= row_range.data_start_row && row_is_within_range {
            return (0..source_row.len()).map(|index| format!("column_{}", index + 1)).collect();
        }
    }
    Vec::new()
}

pub fn parse_xlsx_file_with_options(
    path: &str,
    options: &TableImportParseOptions,
    preview_limit: usize,
) -> Result<ParsedImportFile, String> {
    parse_xlsx_file_with_options_and_text_columns(path, options, preview_limit, &HashSet::new())
}

fn parse_xlsx_file_with_options_and_text_columns(
    path: &str,
    options: &TableImportParseOptions,
    preview_limit: usize,
    text_source_columns: &HashSet<String>,
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
    let extension = Path::new(path).extension().and_then(|extension| extension.to_str()).unwrap_or_default();
    let legacy_xls = is_legacy_xls_path(path);
    if extension.eq_ignore_ascii_case("xlsx") || extension.eq_ignore_ascii_case("xlsm") {
        let range = workbook.worksheet_range_ref(&sheet_name).map_err(|e| e.to_string())?;
        let row_range = effective_import_row_range(options)?;
        let style_selection_columns =
            xlsx_style_selection_columns(&range, row_range, xlsx_cell_ref_label_with_temporal_kind);
        let text_worksheet_columns = style_selection_columns
            .iter()
            .enumerate()
            .filter_map(|(index, column)| {
                text_source_columns
                    .contains(column)
                    .then_some(range.start().map_or(index + 1, |(_, start)| start as usize + index + 1))
            })
            .collect::<HashSet<_>>();
        let cell_styles =
            if legacy_xls { HashMap::new() } else { xlsx_cell_styles(path, &sheet_name, &text_worksheet_columns)? };
        return parse_xlsx_range(
            &range,
            options,
            preview_limit,
            &cell_styles,
            text_source_columns,
            legacy_xls,
            xlsx_cell_ref_label_with_temporal_kind,
            xlsx_cell_ref_value_with_temporal_kind,
            xlsx_cell_ref_text_value,
            xlsx_cell_ref_is_numeric,
        );
    }

    let range = workbook.worksheet_range(&sheet_name).map_err(|e| e.to_string())?;
    let row_range = effective_import_row_range(options)?;
    let style_selection_columns = xlsx_style_selection_columns(&range, row_range, xlsx_cell_label_with_temporal_kind);
    let text_worksheet_columns = style_selection_columns
        .iter()
        .enumerate()
        .filter_map(|(index, column)| {
            text_source_columns
                .contains(column)
                .then_some(range.start().map_or(index + 1, |(_, start)| start as usize + index + 1))
        })
        .collect::<HashSet<_>>();
    let cell_styles =
        if legacy_xls { HashMap::new() } else { xlsx_cell_styles(path, &sheet_name, &text_worksheet_columns)? };
    parse_xlsx_range(
        &range,
        options,
        preview_limit,
        &cell_styles,
        text_source_columns,
        legacy_xls,
        xlsx_cell_label_with_temporal_kind,
        xlsx_cell_value_with_temporal_kind,
        xlsx_cell_text_value,
        xlsx_cell_is_numeric,
    )
}

#[derive(Debug)]
enum XlsxStreamMessage {
    Header(Vec<String>),
    Rows(Vec<Vec<serde_json::Value>>),
    Progress(u64),
    Done,
}

fn xlsx_stream_cell_value(
    cell: &XlsxPreviewRawCell,
    shared_strings: &mut XlsxSharedStrings,
    styles: &[XlsxCellStyle],
    date_1904: bool,
    format_as_text: bool,
) -> Result<serde_json::Value, String> {
    if format_as_text && cell.cell_type.as_deref().unwrap_or_default().is_empty() {
        if let Ok(number) = cell.value.trim().parse::<f64>() {
            let style = cell.style_id.and_then(|style| styles.get(style));
            if style.and_then(|style| style.temporal_kind).is_none() {
                return Ok(serde_json::Value::String(xlsx_numeric_display_text(number, style)));
            }
        }
    }
    if cell.cell_type.as_deref() != Some("s") {
        return Ok(xlsx_preview_cell_value(cell, &HashMap::new(), styles, date_1904));
    }
    let Some(index) = cell.value.parse::<usize>().ok() else {
        return Ok(serde_json::Value::Null);
    };
    Ok(shared_strings.get(index)?.map_or(serde_json::Value::Null, |value| csv_value(&value)))
}

fn xlsx_cell_ref_text_value(cell: &DataRef<'_>, style: Option<&XlsxCellStyle>) -> Option<String> {
    if style.and_then(|style| style.temporal_kind).is_some() {
        return None;
    }
    match cell {
        DataRef::Float(value) if value.is_finite() => Some(xlsx_numeric_display_text(*value, style)),
        DataRef::Int(value) => Some(xlsx_numeric_display_text(*value as f64, style)),
        _ => None,
    }
}

fn xlsx_cell_ref_is_numeric(cell: &DataRef<'_>) -> bool {
    matches!(cell, DataRef::Float(_) | DataRef::Int(_))
}

fn xlsx_cell_is_numeric(cell: &Data) -> bool {
    matches!(cell, Data::Float(_) | Data::Int(_))
}

struct XlsxStreamRowsState {
    sender: tokio::sync::mpsc::Sender<Result<XlsxStreamMessage, String>>,
    row_range: ImportRowRange,
    dimension: Option<((usize, usize), (usize, usize))>,
    start_row: Option<usize>,
    start_column: usize,
    declared_column_count: Option<usize>,
    columns: Vec<String>,
    header_sent: bool,
    pending_rows: Vec<Vec<serde_json::Value>>,
    rows_seen: usize,
    current_row: Option<usize>,
    current_values: Vec<serde_json::Value>,
    batch_size: usize,
}

impl XlsxStreamRowsState {
    fn new(
        sender: tokio::sync::mpsc::Sender<Result<XlsxStreamMessage, String>>,
        row_range: ImportRowRange,
        dimension: Option<((usize, usize), (usize, usize))>,
        expected_columns: Option<Vec<String>>,
        batch_size: usize,
    ) -> Self {
        let batch_size = batch_size.max(1);
        Self {
            sender,
            row_range,
            dimension,
            start_row: None,
            start_column: 0,
            declared_column_count: None,
            columns: expected_columns.unwrap_or_default(),
            header_sent: false,
            pending_rows: Vec::with_capacity(batch_size),
            rows_seen: 0,
            current_row: None,
            current_values: Vec::new(),
            batch_size,
        }
    }

    fn initialize_range(&mut self, first_row: usize, first_column: usize) {
        if self.start_row.is_some() {
            return;
        }
        let expected_column_count = (!self.columns.is_empty()).then_some(self.columns.len());
        let dimension = self.dimension.filter(|((start_row, start_column), (end_row, end_column))| {
            let column_count = end_column.saturating_sub(*start_column).saturating_add(1);
            let row_count = end_row.saturating_sub(*start_row).saturating_add(1);
            *start_row == first_row
                && *start_column == first_column
                && column_count <= MAX_FAST_PREVIEW_CELLS
                && expected_column_count
                    .map_or(column_count.saturating_mul(row_count) <= MAX_FAST_PREVIEW_CELLS, |expected| {
                        expected == column_count
                    })
        });
        self.start_row = Some(first_row);
        self.start_column = first_column;
        self.declared_column_count = dimension
            .map(|((_, start_column), (_, end_column))| end_column.saturating_sub(start_column).saturating_add(1));
    }

    fn selected_range_finished(&self, absolute_row: usize) -> bool {
        let Some(start_row) = self.start_row else {
            return false;
        };
        self.row_range.last_data_row.is_some_and(|last| absolute_row > start_row.saturating_add(last.saturating_sub(1)))
    }

    fn is_text_source_column(
        &mut self,
        absolute_row: usize,
        absolute_column: usize,
        text_source_columns: &HashSet<String>,
    ) -> bool {
        self.initialize_range(absolute_row, absolute_column);
        absolute_column
            .checked_sub(self.start_column)
            .and_then(|offset| self.columns.get(offset))
            .is_some_and(|column| text_source_columns.contains(column))
    }

    fn push_cell(
        &mut self,
        absolute_row: usize,
        absolute_column: usize,
        value: serde_json::Value,
        progress: u64,
    ) -> Result<(), String> {
        self.initialize_range(absolute_row, absolute_column);
        if self.current_row != Some(absolute_row) {
            self.flush_current_row(progress)?;
            self.current_row = Some(absolute_row);
        }
        let column_offset = absolute_column.checked_sub(self.start_column).ok_or_else(|| {
            format!("Excel row {absolute_row} contains a cell before the detected import range start column")
        })?;
        if column_offset >= MAX_FAST_PREVIEW_CELLS {
            return Err(format!("Excel import column {} exceeds the safety limit", column_offset + 1));
        }
        if column_offset >= self.current_values.len() {
            self.current_values.resize(column_offset + 1, serde_json::Value::Null);
        }
        self.current_values[column_offset] = value;
        Ok(())
    }

    fn flush_current_row(&mut self, progress: u64) -> Result<(), String> {
        let Some(absolute_row) = self.current_row.take() else {
            return Ok(());
        };
        let values = std::mem::take(&mut self.current_values);
        self.flush_row(absolute_row, values, progress)
    }

    fn flush_row(
        &mut self,
        absolute_row: usize,
        mut values: Vec<serde_json::Value>,
        progress: u64,
    ) -> Result<(), String> {
        let relative_row = absolute_row.saturating_sub(self.start_row.unwrap_or(absolute_row)).saturating_add(1);
        if self.row_range.title_row == Some(relative_row) {
            if self.columns.is_empty() {
                let column_count = self.declared_column_count.unwrap_or(values.len()).max(values.len());
                values.resize(column_count, serde_json::Value::Null);
                self.columns = values
                    .iter()
                    .enumerate()
                    .map(|(index, value)| normalize_header(&xlsx_preview_cell_label(value), index))
                    .collect();
            }
            return Ok(());
        }
        if relative_row < self.row_range.data_start_row
            || self.row_range.last_data_row.is_some_and(|last| relative_row > last)
        {
            return Ok(());
        }
        if self.columns.is_empty() {
            let column_count = self.declared_column_count.unwrap_or(values.len()).max(values.len());
            self.columns = (0..column_count).map(|index| format!("column_{}", index + 1)).collect();
        }
        if !self.header_sent {
            self.sender
                .blocking_send(Ok(XlsxStreamMessage::Header(self.columns.clone())))
                .map_err(|_| "Excel import consumer closed before the stream started".to_string())?;
            self.header_sent = true;
        }
        if values.len() > self.columns.len() && values[self.columns.len()..].iter().any(|value| !value.is_null()) {
            return Err(format!(
                "Excel row {absolute_row} contains data beyond the {} columns confirmed by the preview",
                self.columns.len()
            ));
        }
        values.resize(self.columns.len(), serde_json::Value::Null);
        values.truncate(self.columns.len());
        self.pending_rows.push(values);
        self.rows_seen = self.rows_seen.saturating_add(1);
        if self.pending_rows.len() >= self.batch_size {
            self.emit_rows(progress)?;
        }
        Ok(())
    }

    fn emit_rows(&mut self, progress: u64) -> Result<(), String> {
        if self.pending_rows.is_empty() {
            return Ok(());
        }
        self.sender
            .blocking_send(Ok(XlsxStreamMessage::Rows(std::mem::take(&mut self.pending_rows))))
            .map_err(|_| "Excel import consumer closed before the stream finished".to_string())?;
        self.sender
            .blocking_send(Ok(XlsxStreamMessage::Progress(progress)))
            .map_err(|_| "Excel import consumer closed before the stream finished".to_string())?;
        self.pending_rows = Vec::with_capacity(self.batch_size);
        Ok(())
    }

    fn finish(mut self, progress: u64) -> Result<(), String> {
        self.flush_current_row(progress)?;
        self.emit_rows(progress)?;
        if !self.header_sent || self.rows_seen == 0 {
            return Err("Import file has no data rows in the selected row range".to_string());
        }
        self.sender
            .blocking_send(Ok(XlsxStreamMessage::Done))
            .map_err(|_| "Excel import consumer closed before the stream finished".to_string())
    }
}

fn stream_xlsx_rows_to_channel(
    path: &str,
    options: &TableImportParseOptions,
    batch_size: usize,
    expected_columns: Option<Vec<String>>,
    text_source_columns: HashSet<String>,
    scan_full_worksheet: bool,
    sender: tokio::sync::mpsc::Sender<Result<XlsxStreamMessage, String>>,
) -> Result<(), String> {
    // This producer runs on a blocking thread and communicates in bounded batches. The small
    // channel capacity applies backpressure when database writes are slower than XML parsing.
    let total_bytes = std::fs::metadata(path).map(|metadata| metadata.len()).unwrap_or_default();
    let mut zip = zip::ZipArchive::new(File::open(path).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    let workbook_xml = read_xlsx_zip_text(&mut zip, "xl/workbook.xml")?;
    let rels_xml = read_xlsx_zip_text(&mut zip, "xl/_rels/workbook.xml.rels").unwrap_or_default();
    let sheet_refs = xlsx_workbook_sheet_refs(&workbook_xml);
    let sheet_names = sheet_refs.iter().map(|(name, _)| name.clone()).collect::<Vec<_>>();
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
    let styles_xml = read_xlsx_zip_text(&mut zip, "xl/styles.xml").unwrap_or_default();
    let styles = parse_xlsx_styles(&styles_xml);
    let date_1904 = xlsx_workbook_uses_1904_date_system(&workbook_xml);
    let sheet_path = xlsx_sheet_path_for_name(&workbook_xml, &rels_xml, &sheet_name)
        .ok_or_else(|| format!("Workbook sheet not found: {sheet_name}"))?;
    let mut shared_strings = open_xlsx_shared_strings(&mut zip, MAX_IN_MEMORY_XLSX_SHARED_STRINGS_BYTES)?;
    let row_range = effective_import_row_range(options)?;
    let sheet = zip.by_name(&sheet_path).map_err(|error| error.to_string())?;
    let uncompressed_sheet_bytes = sheet.size().max(1);
    let mut reader = XmlReader::from_reader(BufReader::new(sheet));
    reader.config_mut().trim_text(false);
    let mut rows = XlsxStreamRowsState::new(sender, row_range, None, expected_columns, batch_size);
    let mut buffer = Vec::new();
    let mut current_row = 0usize;
    let mut current_column = 0usize;
    let mut current_position = None;
    let mut current_cell = XlsxPreviewRawCell::default();
    let mut in_value = false;
    let mut in_inline_text = false;
    let mut inline_phonetic_depth = 0usize;
    loop {
        // Convert the uncompressed worksheet offset into an approximate archive-byte offset so
        // progress remains monotonic without scanning the ZIP twice.
        let progress = reader
            .buffer_position()
            .saturating_mul(total_bytes)
            .checked_div(uncompressed_sheet_bytes)
            .unwrap_or_default()
            .min(total_bytes);
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(element)) | Ok(Event::Empty(element))
                if xml_local_name_eq(element.name().as_ref(), b"dimension") =>
            {
                rows.dimension = xml_attr_value(&reader, &element, b"ref").as_deref().and_then(xlsx_dimension_bounds);
            }
            Ok(Event::Start(element)) if xml_local_name_eq(element.name().as_ref(), b"row") => {
                current_row = xml_attr_value(&reader, &element, b"r")
                    .and_then(|value| value.parse::<usize>().ok())
                    .filter(|row| *row > 0)
                    .unwrap_or_else(|| current_row.saturating_add(1).max(1));
                current_column = 0;
                if !scan_full_worksheet && rows.selected_range_finished(current_row) {
                    break;
                }
            }
            Ok(Event::Empty(element)) if xml_local_name_eq(element.name().as_ref(), b"c") => {
                let position = xml_attr_value(&reader, &element, b"r")
                    .as_deref()
                    .and_then(xlsx_cell_ref_position)
                    .unwrap_or_else(|| (current_row.max(1), current_column.saturating_add(1).max(1)));
                current_row = position.0;
                current_column = position.1;
                rows.push_cell(position.0, position.1, serde_json::Value::Null, progress)?;
            }
            Ok(Event::Start(element)) if xml_local_name_eq(element.name().as_ref(), b"c") => {
                let position = xml_attr_value(&reader, &element, b"r")
                    .as_deref()
                    .and_then(xlsx_cell_ref_position)
                    .unwrap_or_else(|| (current_row.max(1), current_column.saturating_add(1).max(1)));
                current_row = position.0;
                current_column = position.1;
                current_position = Some(position);
                current_cell = XlsxPreviewRawCell {
                    cell_type: xml_attr_value(&reader, &element, b"t"),
                    style_id: xml_attr_value(&reader, &element, b"s").and_then(|value| value.parse::<usize>().ok()),
                    ..XlsxPreviewRawCell::default()
                };
            }
            Ok(Event::Start(element)) if xml_local_name_eq(element.name().as_ref(), b"v") => in_value = true,
            Ok(Event::Start(element)) if xml_local_name_eq(element.name().as_ref(), b"t") => {
                in_inline_text = inline_phonetic_depth == 0;
            }
            Ok(Event::Start(element)) if xml_local_name_eq(element.name().as_ref(), b"rPh") => {
                inline_phonetic_depth = inline_phonetic_depth.saturating_add(1);
            }
            Ok(Event::Text(text)) if in_value => {
                current_cell.value.push_str(&text.unescape().map_err(|error| error.to_string())?);
            }
            Ok(Event::Text(text)) if in_inline_text => {
                current_cell.inline_value.push_str(&text.unescape().map_err(|error| error.to_string())?);
            }
            Ok(Event::End(element)) if xml_local_name_eq(element.name().as_ref(), b"v") => in_value = false,
            Ok(Event::End(element)) if xml_local_name_eq(element.name().as_ref(), b"t") => in_inline_text = false,
            Ok(Event::End(element)) if xml_local_name_eq(element.name().as_ref(), b"rPh") => {
                inline_phonetic_depth = inline_phonetic_depth.saturating_sub(1);
            }
            Ok(Event::End(element)) if xml_local_name_eq(element.name().as_ref(), b"c") => {
                if let Some((row, column)) = current_position.take() {
                    let format_as_text = rows.is_text_source_column(row, column, &text_source_columns);
                    let value =
                        xlsx_stream_cell_value(&current_cell, &mut shared_strings, &styles, date_1904, format_as_text)?;
                    rows.push_cell(row, column, value, progress)?;
                    current_cell = XlsxPreviewRawCell::default();
                }
                inline_phonetic_depth = 0;
                in_inline_text = false;
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(error.to_string()),
            _ => {}
        }
        buffer.clear();
    }
    rows.finish(total_bytes)
}

async fn validate_xlsx_worksheet_for_import(
    path: String,
    options: TableImportParseOptions,
    expected_columns: Option<Vec<String>>,
    text_source_columns: HashSet<String>,
) -> Result<(), String> {
    // Drain bounded row batches without writing. Full-sheet mode keeps parsing through the
    // worksheet EOF even when the selected import range ends earlier.
    let (sender, mut receiver) = tokio::sync::mpsc::channel::<Result<XlsxStreamMessage, String>>(2);
    let validation = tokio::task::spawn_blocking(move || {
        stream_xlsx_rows_to_channel(
            &path,
            &options,
            DEFAULT_BATCH_SIZE,
            expected_columns,
            text_source_columns,
            true,
            sender,
        )
    });

    while let Some(message) = receiver.recv().await {
        if let Err(error) = message {
            drop(receiver);
            let _ = validation.await;
            return Err(error);
        }
    }

    validation.await.map_err(|error| error.to_string())?
}

fn parse_xlsx_range<T, Label, Value, TextValue, IsNumeric>(
    range: &Range<T>,
    options: &TableImportParseOptions,
    preview_limit: usize,
    cell_styles: &HashMap<(usize, usize), XlsxCellStyle>,
    text_source_columns: &HashSet<String>,
    legacy_xls: bool,
    cell_label: Label,
    cell_value: Value,
    cell_text_value: TextValue,
    is_numeric: IsNumeric,
) -> Result<ParsedImportFile, String>
where
    T: CellType,
    Label: Fn(&T, Option<XlsxTemporalKind>) -> String,
    Value: Fn(&T, Option<XlsxTemporalKind>) -> serde_json::Value,
    TextValue: Fn(&T, Option<&XlsxCellStyle>) -> Option<String>,
    IsNumeric: Fn(&T) -> bool,
{
    let (range_start_row, range_start_column) =
        range.start().map(|(row, column)| (row as usize, column as usize)).unwrap_or_default();
    let row_range = effective_import_row_range(options)?;
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    let mut total_rows = 0;
    for (index, source_row) in range.rows().enumerate() {
        let row_number = index + 1;
        if row_range.title_row == Some(row_number) {
            columns = source_row
                .iter()
                .enumerate()
                .map(|(index, cell)| {
                    // Calamine rows are relative to the used range, while XLSX style coordinates are worksheet-absolute.
                    let cell_position = (range_start_row + row_number, range_start_column + index + 1);
                    normalize_header(
                        &cell_label(cell, cell_styles.get(&cell_position).and_then(|style| style.temporal_kind)),
                        index,
                    )
                })
                .collect();
            continue;
        }
        if row_number < row_range.data_start_row {
            continue;
        }
        if row_range.last_data_row.is_some_and(|last| row_number > last) {
            break;
        }
        if columns.is_empty() {
            columns = (0..source_row.len()).map(|index| format!("column_{}", index + 1)).collect();
        }
        total_rows += 1;
        if rows.len() >= preview_limit {
            continue;
        }
        let mut row = Vec::with_capacity(columns.len());
        for (index, column) in columns.iter().enumerate() {
            let cell_position = (range_start_row + row_number, range_start_column + index + 1);
            let style = cell_styles.get(&cell_position);
            let value = source_row
                .get(index)
                .map(|cell| {
                    if text_source_columns.contains(column) {
                        if legacy_xls && is_numeric(cell) {
                            return Err(format!(
                                "Legacy .xls files cannot preserve numeric display formatting for text target column '{column}'. Save the workbook as .xlsx or map this source column to a numeric target."
                            ));
                        }
                        if let Some(text) = cell_text_value(cell, style) {
                            return Ok(serde_json::Value::String(text));
                        }
                    }
                    Ok(cell_value(cell, style.and_then(|style| style.temporal_kind)))
                })
                .transpose()?
                .unwrap_or(serde_json::Value::Null);
            row.push(value);
        }
        rows.push(row);
    }
    if columns.is_empty() {
        return Err("Import file has no columns in the selected row range".to_string());
    }
    if total_rows == 0 {
        return Err("Import file has no data rows in the selected row range".to_string());
    }
    Ok(ParsedImportFile { columns, rows, total_rows, effective_encoding: None })
}

pub fn parse_xlsx_file(path: &str, preview_limit: usize) -> Result<ParsedImportFile, String> {
    parse_xlsx_file_with_options(path, &TableImportParseOptions::default(), preview_limit)
}

fn ensure_non_streaming_file_size(path: &str, format: TableImportSourceFormat) -> Result<(), String> {
    if format.is_delimited() {
        return Ok(());
    }
    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let extension = Path::new(path).extension().and_then(|extension| extension.to_str()).unwrap_or_default();
    let max_bytes = if format == TableImportSourceFormat::Excel && extension.eq_ignore_ascii_case("xls") {
        MAX_LEGACY_XLS_IMPORT_BYTES
    } else {
        MAX_NON_STREAMING_IMPORT_BYTES
    };
    if metadata.len() > max_bytes {
        return Err(format!(
            "File too large for {} import: {} bytes (max {} bytes)",
            format.label(),
            metadata.len(),
            max_bytes
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
    parse_import_file_with_options_and_text_columns(path, source_format, options, preview_limit, HashSet::new()).await
}

async fn parse_import_file_with_options_and_text_columns(
    path: &str,
    source_format: Option<TableImportSourceFormat>,
    options: &TableImportParseOptions,
    preview_limit: usize,
    text_source_columns: HashSet<String>,
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
            tokio::task::spawn_blocking(move || {
                parse_xlsx_file_with_options_and_text_columns(&path, &options, preview_limit, &text_source_columns)
            })
            .await
            .map_err(|e| e.to_string())?
        }
    }
}

async fn parse_import_preview_file_with_options(
    path: &str,
    format: TableImportSourceFormat,
    options: &TableImportParseOptions,
    preview_limit: usize,
) -> Result<(ParsedImportFile, bool, Vec<String>), String> {
    if format.is_delimited() {
        let path = path.to_string();
        let options = options.clone();
        let parsed = tokio::task::spawn_blocking(move || {
            parse_delimited_preview_file_with_options(&path, format, &options, preview_limit)
        })
        .await
        .map_err(|e| e.to_string())??;
        return Ok((parsed, false, Vec::new()));
    }

    ensure_non_streaming_file_size(path, format)?;
    let extension = Path::new(path).extension().and_then(|extension| extension.to_str()).unwrap_or_default();
    if format == TableImportSourceFormat::Excel
        && (extension.eq_ignore_ascii_case("xlsx") || extension.eq_ignore_ascii_case("xlsm"))
    {
        let path = path.to_string();
        let options = options.clone();
        let (parsed, sheets) =
            tokio::task::spawn_blocking(move || parse_xlsx_preview_file_with_options(&path, &options, preview_limit))
                .await
                .map_err(|e| e.to_string())??;
        return Ok((parsed, false, sheets));
    }

    let parsed = parse_import_file_with_options(path, Some(format), options, preview_limit).await?;
    let sheets = if format == TableImportSourceFormat::Excel {
        let path = path.to_string();
        tokio::task::spawn_blocking(move || xlsx_sheet_names(&path)).await.map_err(|e| e.to_string())??
    } else {
        Vec::new()
    };
    Ok((parsed, true, sheets))
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

fn compile_import_plan(
    columns: &[String],
    mappings: &[TableImportColumnMapping],
    target_column_types: &[(String, String)],
) -> Result<CompiledImportPlan, String> {
    let mapped = mapping_indexes_for_columns(columns, mappings)?;
    let mapped_source_indexes = mapped.iter().map(|(source_index, _)| *source_index).collect::<Vec<_>>();
    let target_columns = mapped.into_iter().map(|(_, target)| target).collect::<Vec<_>>();
    let column_types = target_columns
        .iter()
        .map(|column| {
            target_column_types
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case(column))
                .map(|(_, data_type)| data_type.clone())
        })
        .collect::<Vec<_>>();
    Ok(CompiledImportPlan { mapped_source_indexes, target_columns, column_types })
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
    build_import_insert_batch_from_rows_with_format(
        rows,
        columns,
        mappings,
        target_column_types,
        table,
        schema,
        db_type,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn build_import_insert_batch_from_rows_with_format(
    rows: &[Vec<serde_json::Value>],
    columns: &[String],
    mappings: &[TableImportColumnMapping],
    target_column_types: &[(String, String)],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    date_time_format: Option<&str>,
) -> Result<Option<ImportSqlBatch>, String> {
    if rows.is_empty() {
        return Ok(None);
    }
    if *db_type == DatabaseType::CloudflareD1 {
        return crate::db::cloudflare_d1::build_streaming_import_insert_batch(
            rows,
            columns,
            mappings,
            target_column_types,
            table,
            schema,
            rows.len(),
        );
    }
    let plan = compile_import_plan(columns, mappings, target_column_types)?;
    build_import_insert_batch_with_plan(rows, &plan, table, schema, db_type, date_time_format)
}

fn build_import_insert_batch_with_plan(
    rows: &[Vec<serde_json::Value>],
    plan: &CompiledImportPlan,
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    date_time_format: Option<&str>,
) -> Result<Option<ImportSqlBatch>, String> {
    if rows.is_empty() {
        return Ok(None);
    }
    let mapped_rows = map_import_rows_with_plan(rows, plan, db_type, date_time_format);
    let sql = generate_insert_typed(&plan.target_columns, &plan.column_types, &mapped_rows, table, schema, db_type);
    Ok((!sql.trim().is_empty()).then_some(ImportSqlBatch { sql, row_count: rows.len() }))
}

fn build_import_insert_batches_with_plan(
    rows: &[Vec<serde_json::Value>],
    plan: &CompiledImportPlan,
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    date_time_format: Option<&str>,
) -> Vec<ImportSqlBatch> {
    if rows.is_empty() {
        return Vec::new();
    }
    let mapped_rows = map_import_rows_with_plan(rows, plan, db_type, date_time_format);
    generate_insert_typed_sql_batches(
        &plan.target_columns,
        &plan.column_types,
        &mapped_rows,
        table,
        schema,
        db_type,
        rows.len(),
    )
    .into_iter()
    .map(|(sql, row_count)| ImportSqlBatch { sql, row_count })
    .collect()
}

fn map_import_rows_with_plan(
    rows: &[Vec<serde_json::Value>],
    plan: &CompiledImportPlan,
    db_type: &DatabaseType,
    date_time_format: Option<&str>,
) -> Vec<Vec<serde_json::Value>> {
    rows.iter()
        .map(|row| {
            plan.mapped_source_indexes
                .iter()
                .enumerate()
                .map(|(target_index, source_index)| {
                    let value = row.get(*source_index).cloned().unwrap_or(serde_json::Value::Null);
                    normalize_import_value(
                        &value,
                        plan.column_types.get(target_index).and_then(|data_type| data_type.as_deref()),
                        db_type,
                        date_time_format,
                    )
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>()
}

#[allow(clippy::too_many_arguments)]
fn build_import_execution_batches(
    rows: &[Vec<serde_json::Value>],
    plan: Option<&CompiledImportPlan>,
    columns: &[String],
    mappings: &[TableImportColumnMapping],
    target_column_types: &[(String, String)],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    date_time_format: Option<&str>,
) -> Result<Vec<ImportSqlBatch>, String> {
    if let Some(plan) = plan {
        return Ok(build_import_insert_batches_with_plan(rows, plan, table, schema, db_type, date_time_format));
    }
    if *db_type == DatabaseType::CloudflareD1 {
        return crate::db::cloudflare_d1::build_import_insert_batches(
            rows,
            columns,
            mappings,
            target_column_types,
            table,
            schema,
            rows.len().max(1),
        );
    }
    let plan = compile_import_plan(columns, mappings, target_column_types)?;
    Ok(build_import_insert_batches_with_plan(rows, &plan, table, schema, db_type, date_time_format))
}

fn effective_import_batch_size(db_type: &DatabaseType, requested: usize) -> usize {
    // Some backends impose stricter limits than the UI batch setting; clamp here so every
    // import path, including streaming producers, uses the same safe value.
    let max_rows = match db_type {
        DatabaseType::Oracle => MAX_ORACLE_IMPORT_BATCH_ROWS,
        DatabaseType::OceanbaseOracle | DatabaseType::Iris => 1,
        DatabaseType::CloudflareD1 => 100,
        _ => usize::MAX,
    };
    requested.max(1).min(max_rows)
}

fn normalize_import_temporal_value(
    value: &serde_json::Value,
    data_type: Option<&str>,
    db_type: &DatabaseType,
    date_time_format: Option<&str>,
) -> serde_json::Value {
    let oracle_date_time = matches!(db_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle)
        && data_type.is_some_and(|data_type| data_type.trim().eq_ignore_ascii_case("date"));
    crate::temporal_format::normalize_temporal_import_value(
        value,
        if oracle_date_time { Some("datetime") } else { data_type },
        date_time_format,
    )
}

fn is_textual_import_target_type(data_type: &str) -> bool {
    let mut lower = data_type.trim().trim_matches('"').to_ascii_lowercase();
    loop {
        let unwrapped = ["nullable", "lowcardinality"].iter().find_map(|wrapper| {
            lower
                .strip_prefix(&format!("{wrapper}("))
                .and_then(|inner| inner.strip_suffix(')'))
                .map(|inner| inner.trim().to_string())
        });
        match unwrapped {
            Some(inner) => lower = inner,
            None => break,
        }
    }
    if lower == "long raw" || lower.starts_with("long raw(") {
        return false;
    }
    let base = lower.split(['(', ':', ' ']).next().unwrap_or("").trim();
    matches!(
        base,
        "char"
            | "character"
            | "varchar"
            | "varchar2"
            | "nvarchar"
            | "nvarchar2"
            | "nchar"
            | "string"
            | "fixedstring"
            | "sysname"
            | "long"
            | "text"
            | "tinytext"
            | "mediumtext"
            | "longtext"
            | "ntext"
            | "clob"
            | "nclob"
            | "enum"
            | "set"
    ) || lower.starts_with("character varying")
}

fn textual_source_columns_for_import(
    mappings: &[TableImportColumnMapping],
    target_column_types: &[(String, String)],
) -> HashSet<String> {
    mappings
        .iter()
        .filter(|mapping| {
            target_column_types
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case(&mapping.target_column))
                .map(|(_, data_type)| data_type.as_str())
                .or(mapping.target_data_type.as_deref())
                .is_some_and(is_textual_import_target_type)
        })
        .map(|mapping| mapping.source_column.clone())
        .collect()
}

fn normalize_import_value(
    value: &serde_json::Value,
    data_type: Option<&str>,
    db_type: &DatabaseType,
    date_time_format: Option<&str>,
) -> serde_json::Value {
    normalize_import_temporal_value(value, data_type, db_type, date_time_format)
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
    build_import_insert_batches_with_format(
        data,
        mappings,
        target_column_types,
        table,
        schema,
        db_type,
        batch_size,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn build_import_insert_batches_with_format(
    data: &ParsedImportFile,
    mappings: &[TableImportColumnMapping],
    target_column_types: &[(String, String)],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    batch_size: usize,
    date_time_format: Option<&str>,
) -> Result<Vec<ImportSqlBatch>, String> {
    if *db_type == DatabaseType::CloudflareD1 {
        return crate::db::cloudflare_d1::build_import_insert_batches(
            &data.rows,
            &data.columns,
            mappings,
            target_column_types,
            table,
            schema,
            effective_import_batch_size(db_type, batch_size),
        );
    }
    let plan = compile_import_plan(&data.columns, mappings, target_column_types)?;
    let batch_size = effective_import_batch_size(db_type, batch_size);
    let mut batches = Vec::new();
    for rows in data.rows.chunks(batch_size) {
        batches.extend(build_import_insert_batches_with_plan(rows, &plan, table, schema, db_type, date_time_format));
    }
    Ok(batches)
}

pub fn truncate_sql(table: &str, schema: &str, db_type: &DatabaseType) -> String {
    let full_table = qualified_table(table, schema, db_type);
    match db_type {
        DatabaseType::Sqlite | DatabaseType::CloudflareD1 => format!("DELETE FROM {full_table}"),
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
        DatabaseType::Sqlite | DatabaseType::Rqlite | DatabaseType::Turso | DatabaseType::CloudflareD1 => "INTEGER",
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
        DatabaseType::Sqlite | DatabaseType::Rqlite | DatabaseType::Turso | DatabaseType::CloudflareD1 => "REAL",
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
        DatabaseType::Sqlite | DatabaseType::Rqlite | DatabaseType::Turso | DatabaseType::CloudflareD1 => "INTEGER",
        DatabaseType::Oracle | DatabaseType::OceanbaseOracle | DatabaseType::Dameng => "NUMBER(1)",
        DatabaseType::ClickHouse => "UInt8",
        _ => "BOOLEAN",
    }
}

fn date_data_type(db_type: &DatabaseType) -> &'static str {
    match db_type {
        DatabaseType::Sqlite | DatabaseType::Rqlite | DatabaseType::Turso | DatabaseType::CloudflareD1 => "TEXT",
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
        DatabaseType::Sqlite | DatabaseType::Rqlite | DatabaseType::Turso | DatabaseType::CloudflareD1 => "TEXT",
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

fn import_progress(
    import_id: &str,
    status: TableImportStatus,
    rows_imported: usize,
    total_rows: usize,
    started_at: Instant,
    error: Option<String>,
) -> TableImportProgress {
    let phase = match status {
        TableImportStatus::Running => TableImportPhase::Writing,
        TableImportStatus::Done | TableImportStatus::Error | TableImportStatus::Cancelled => TableImportPhase::Done,
    };
    import_progress_with_details(import_id, status, phase, rows_imported, total_rows, true, 0, 0, started_at, error)
}

#[allow(clippy::too_many_arguments)]
fn import_progress_with_details(
    import_id: &str,
    status: TableImportStatus,
    phase: TableImportPhase,
    rows_imported: usize,
    total_rows: usize,
    total_rows_exact: bool,
    bytes_read: u64,
    total_bytes: u64,
    started_at: Instant,
    error: Option<String>,
) -> TableImportProgress {
    TableImportProgress {
        import_id: import_id.to_string(),
        status,
        phase,
        rows_imported,
        total_rows,
        total_rows_exact,
        bytes_read,
        total_bytes,
        elapsed_ms: started_at.elapsed().as_millis(),
        error,
    }
}

fn import_summary(import_id: &str, rows_imported: usize, total_rows: usize, started_at: Instant) -> TableImportSummary {
    TableImportSummary {
        import_id: import_id.to_string(),
        rows_imported,
        total_rows,
        elapsed_ms: started_at.elapsed().as_millis(),
    }
}

async fn execute_import_statement(
    state: &AppState,
    pool_key: &str,
    sql: &str,
    db_write_ms: &mut u128,
    statement_count: &mut usize,
) -> Result<crate::db::QueryResult, String> {
    let started_at = Instant::now();
    let result = execute_on_pool(state, pool_key, sql).await;
    *db_write_ms += started_at.elapsed().as_millis();
    *statement_count += 1;
    result
}

fn postgres_copy_text_value(value: &serde_json::Value) -> Result<String, String> {
    let raw = match value {
        serde_json::Value::Null => return Ok("\\N".to_string()),
        serde_json::Value::Bool(value) => value.to_string(),
        serde_json::Value::Number(value) => value.to_string(),
        serde_json::Value::String(value) => value.clone(),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
            return Err("PostgreSQL COPY fast path does not support structured values".to_string())
        }
    };
    if raw.contains('\0') {
        return Err("PostgreSQL COPY text format does not support NUL bytes".to_string());
    }
    let mut escaped = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            '\\' => escaped.push_str("\\\\"),
            '\t' => escaped.push_str("\\t"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\u{0008}' => escaped.push_str("\\b"),
            '\u{000C}' => escaped.push_str("\\f"),
            '\u{000B}' => escaped.push_str("\\v"),
            _ => escaped.push(ch),
        }
    }
    Ok(escaped)
}

fn postgres_copy_compatible_column_type(data_type: Option<&str>) -> bool {
    let Some(data_type) = data_type else {
        return true;
    };
    let base = data_type.trim().to_ascii_lowercase();
    !base.starts_with("bytea") && !base.starts_with("bit") && !base.starts_with("varbit")
}

fn build_postgres_copy_text_batch(
    rows: &[Vec<serde_json::Value>],
    plan: &CompiledImportPlan,
    table: &str,
    schema: &str,
    date_time_format: Option<&str>,
) -> Result<(String, Vec<u8>), String> {
    let mapped_rows = map_import_rows_with_plan(rows, plan, &DatabaseType::Postgres, date_time_format);
    let mut data = String::new();
    for row in mapped_rows {
        for (index, value) in row.iter().enumerate() {
            if index > 0 {
                data.push('\t');
            }
            data.push_str(&postgres_copy_text_value(value)?);
        }
        data.push('\n');
    }
    let table = qualified_table(table, schema, &DatabaseType::Postgres);
    let columns = plan
        .target_columns
        .iter()
        .map(|column| quote_identifier(column, &DatabaseType::Postgres))
        .collect::<Vec<_>>()
        .join(", ");
    Ok((format!("COPY {table} ({columns}) FROM STDIN WITH (FORMAT text)"), data.into_bytes()))
}

async fn execute_postgres_copy_batch(
    state: &AppState,
    pool_key: &str,
    sql: &str,
    data: &[u8],
    db_write_ms: &mut u128,
    statement_count: &mut usize,
) -> Result<(), String> {
    let pool = {
        let connections = state.connections.read().await;
        match connections.get(pool_key) {
            Some(PoolKind::Postgres(pool)) => pool.clone(),
            _ => return Err("PostgreSQL pool not found for COPY import".to_string()),
        }
    };
    let started_at = Instant::now();
    let result = crate::db::postgres::copy_in(&pool, sql, data).await;
    *db_write_ms += started_at.elapsed().as_millis();
    *statement_count += 1;
    result
}

fn postgres_copy_eligibility_sql(table: &str, schema: &str) -> String {
    let table = table.replace('\'', "''");
    let schema_filter = if schema.trim().is_empty() {
        "n.nspname = current_schema()".to_string()
    } else {
        format!("n.nspname = '{}'", schema.replace('\'', "''"))
    };
    format!(
        "SELECT NOT c.relrowsecurity AND NOT c.relhasrules AS copy_eligible \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE {schema_filter} AND c.relname = '{table}' AND c.relkind IN ('r', 'p') \
         LIMIT 1"
    )
}

async fn postgres_copy_fast_path_eligible(state: &AppState, pool_key: &str, table: &str, schema: &str) -> bool {
    let sql = postgres_copy_eligibility_sql(table, schema);
    match execute_on_pool(state, pool_key, &sql).await {
        Ok(result) => result.rows.first().and_then(|row| row.first()).is_some_and(|value| match value {
            serde_json::Value::Bool(value) => *value,
            serde_json::Value::String(value) => {
                matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "t" | "true")
            }
            serde_json::Value::Number(value) => value.as_u64() == Some(1),
            _ => false,
        }),
        Err(error) => {
            log::debug!("PostgreSQL COPY eligibility check failed; using INSERT fallback: {error}");
            false
        }
    }
}

#[derive(Debug)]
struct ImportRowsBatchError {
    rows_imported: usize,
    message: String,
}

impl ImportRowsBatchError {
    fn before_write(message: impl Into<String>) -> Self {
        Self { rows_imported: 0, message: message.into() }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ImportBatchExecutionPolicy {
    transactional: bool,
    include_truncate: bool,
    allow_postgres_copy: bool,
}

fn supports_transactional_import_truncate(db_type: &DatabaseType) -> bool {
    matches!(
        db_type,
        DatabaseType::Postgres
            | DatabaseType::Kingbase
            | DatabaseType::Sqlite
            | DatabaseType::CloudflareD1
            | DatabaseType::SqlServer
    )
}

fn supports_import_batch_transactions(db_type: &DatabaseType) -> bool {
    // These native drivers do not expose a transaction spanning separate requests.
    // Agent-backed JDBC drivers perform their own supportsTransactions check.
    !matches!(db_type, DatabaseType::ClickHouse | DatabaseType::Rqlite | DatabaseType::Turso)
}

fn import_batch_execution_policy(
    mode: &TableImportMode,
    pending_truncate: bool,
    db_type: &DatabaseType,
) -> ImportBatchExecutionPolicy {
    let transactional = matches!(mode, TableImportMode::Truncate) && supports_import_batch_transactions(db_type);
    let include_truncate = transactional && pending_truncate;
    ImportBatchExecutionPolicy {
        transactional,
        include_truncate,
        allow_postgres_copy: *db_type == DatabaseType::Postgres && !include_truncate,
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute_import_transaction(
    state: &AppState,
    pool_key: &str,
    connection_id: &str,
    database: &str,
    schema: &str,
    statements: &[String],
    db_write_ms: &mut u128,
    statement_count: &mut usize,
) -> Result<crate::db::QueryResult, String> {
    let started_at = Instant::now();
    let result = crate::query::execute_statements_in_transaction_on_pool(
        state,
        pool_key,
        connection_id,
        database,
        statements,
        (!schema.trim().is_empty()).then_some(schema),
    )
    .await;
    *db_write_ms += started_at.elapsed().as_millis();
    *statement_count += statements.len();
    result
}

#[allow(clippy::too_many_arguments)]
async fn execute_import_rows_batch(
    state: &AppState,
    pool_key: &str,
    connection_id: &str,
    database: &str,
    rows: &[Vec<serde_json::Value>],
    plan: Option<&CompiledImportPlan>,
    columns: &[String],
    mappings: &[TableImportColumnMapping],
    target_column_types: &[(String, String)],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    mode: &TableImportMode,
    pending_truncate: bool,
    allow_postgres_copy: bool,
    date_time_format: Option<&str>,
    db_write_ms: &mut u128,
    statement_count: &mut usize,
) -> Result<usize, ImportRowsBatchError> {
    let execution_policy = import_batch_execution_policy(mode, pending_truncate, db_type);
    // COPY is used only for plain scalar PostgreSQL rows and ordinary tables. Any unsupported
    // value or table feature falls through to the portable INSERT generator below.
    if allow_postgres_copy
        && execution_policy.allow_postgres_copy
        && *db_type == DatabaseType::Postgres
        && !rows
            .iter()
            .flatten()
            .any(|value| matches!(value, serde_json::Value::Array(_) | serde_json::Value::Object(_)))
    {
        if let Some(plan) = plan {
            if plan.column_types.iter().all(|data_type| postgres_copy_compatible_column_type(data_type.as_deref())) {
                let (copy_sql, copy_data) = build_postgres_copy_text_batch(rows, plan, table, schema, date_time_format)
                    .map_err(ImportRowsBatchError::before_write)?;
                execute_postgres_copy_batch(state, pool_key, &copy_sql, &copy_data, db_write_ms, statement_count)
                    .await
                    .map_err(ImportRowsBatchError::before_write)?;
                return Ok(rows.len());
            }
        }
    }
    let batches = build_import_execution_batches(
        rows,
        plan,
        columns,
        mappings,
        target_column_types,
        table,
        schema,
        db_type,
        date_time_format,
    )
    .map_err(ImportRowsBatchError::before_write)?;
    if execution_policy.transactional {
        let mut statements = Vec::with_capacity(batches.len() + usize::from(execution_policy.include_truncate));
        if execution_policy.include_truncate {
            statements.push(truncate_sql(table, schema, db_type));
        }
        statements.extend(batches.into_iter().map(|batch| batch.sql));
        execute_import_transaction(
            state,
            pool_key,
            connection_id,
            database,
            schema,
            &statements,
            db_write_ms,
            statement_count,
        )
        .await
        .map_err(ImportRowsBatchError::before_write)?;
        return Ok(rows.len());
    }
    let mut rows_imported = 0usize;
    for batch in batches {
        if let Err(error) = execute_import_statement(state, pool_key, &batch.sql, db_write_ms, statement_count).await {
            return Err(ImportRowsBatchError { rows_imported, message: error });
        }
        rows_imported = rows_imported.saturating_add(batch.row_count);
    }
    Ok(rows_imported)
}

fn log_import_metrics(
    request: &TableImportRequest,
    source_format: TableImportSourceFormat,
    rows_imported: usize,
    started_at: Instant,
    db_write_ms: u128,
    statement_count: usize,
) {
    let elapsed_ms = started_at.elapsed().as_millis();
    let non_db_ms = elapsed_ms.saturating_sub(db_write_ms);
    let rows_per_second =
        if elapsed_ms == 0 { rows_imported as f64 } else { rows_imported as f64 * 1000.0 / elapsed_ms as f64 };
    log::info!(
        "[table-import:done] import_id={} format={} rows={} elapsed_ms={} db_write_ms={} non_db_ms={} statements={} rows_per_second={:.1}",
        request.import_id,
        source_format.label(),
        rows_imported,
        elapsed_ms,
        db_write_ms,
        non_db_ms,
        statement_count,
        rows_per_second,
    );
}

fn emit_import_error<F>(
    progress_callback: &mut F,
    request: &TableImportRequest,
    rows_imported: usize,
    total_rows: usize,
    started_at: Instant,
    error: impl AsRef<str>,
) -> String
where
    F: FnMut(TableImportProgress),
{
    let message = import_error_message(request, rows_imported, error);
    progress_callback(import_progress(
        &request.import_id,
        TableImportStatus::Error,
        rows_imported,
        total_rows,
        started_at,
        Some(message.clone()),
    ));
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
    let mut columns = Vec::new();
    for (index, record) in reader.records().enumerate() {
        let record = record.map_err(|e| e.to_string())?;
        let row_number = index + 1;
        if config.row_range.title_row == Some(row_number) {
            columns = record
                .iter()
                .enumerate()
                .map(|(index, header)| normalize_header(header.trim_start_matches('\u{feff}'), index))
                .collect();
            continue;
        }
        if row_number < config.row_range.data_start_row {
            continue;
        }
        if config.row_range.last_data_row.is_some_and(|last| row_number > last) {
            break;
        }
        if columns.is_empty() {
            columns = (0..record.len()).map(|index| format!("column_{}", index + 1)).collect();
        }
        if columns.is_empty() {
            return Err("Import file has no columns".to_string());
        }
        return Ok((columns, Some(record)));
    }
    Err("Import file has no data rows in the selected row range".to_string())
}

#[derive(Debug)]
enum DelimitedStreamMessage {
    Header(Vec<String>),
    Rows { rows: Vec<Vec<serde_json::Value>>, bytes_read: u64 },
    Done,
}

fn stream_delimited_rows_to_channel(
    path: &str,
    source_format: TableImportSourceFormat,
    options: &TableImportParseOptions,
    batch_size: usize,
    sender: tokio::sync::mpsc::Sender<Result<DelimitedStreamMessage, String>>,
) -> Result<(), String> {
    // Keep CSV parsing off the async executor while the bounded channel prevents unbounded
    // accumulation when the database consumer is under load.
    let (mut reader, config, _) = open_delimited_csv_reader_with_progress(path, source_format, options, |_| {})?;
    let (columns, first_record) = delimited_columns_and_first_record(&mut reader, config)?;
    sender
        .blocking_send(Ok(DelimitedStreamMessage::Header(columns.clone())))
        .map_err(|_| "Delimited import consumer closed before the stream started".to_string())?;

    let batch_size = batch_size.max(1);
    let mut pending_rows = Vec::with_capacity(batch_size);
    let mut next_record = first_record;
    let mut source_row_number = config.row_range.data_start_row.saturating_sub(1);
    loop {
        let record = if let Some(record) = next_record.take() {
            record
        } else {
            let mut record = csv::StringRecord::new();
            if !reader.read_record(&mut record).map_err(|error| error.to_string())? {
                break;
            }
            record
        };
        source_row_number = source_row_number.saturating_add(1);
        if config.row_range.last_data_row.is_some_and(|last| source_row_number > last) {
            break;
        }
        pending_rows.push(delimited_record_to_row(&record, columns.len(), config));
        if pending_rows.len() >= batch_size {
            sender
                .blocking_send(Ok(DelimitedStreamMessage::Rows {
                    rows: std::mem::take(&mut pending_rows),
                    bytes_read: reader.get_ref().source_bytes_read(),
                }))
                .map_err(|_| "Delimited import consumer closed before the stream finished".to_string())?;
            pending_rows = Vec::with_capacity(batch_size);
        }
    }
    if !pending_rows.is_empty() {
        sender
            .blocking_send(Ok(DelimitedStreamMessage::Rows {
                rows: pending_rows,
                bytes_read: reader.get_ref().source_bytes_read(),
            }))
            .map_err(|_| "Delimited import consumer closed before the stream finished".to_string())?;
    }
    sender
        .blocking_send(Ok(DelimitedStreamMessage::Done))
        .map_err(|_| "Delimited import consumer closed before the stream finished".to_string())?;
    Ok(())
}

fn import_source_fingerprint(
    path: &str,
    format: TableImportSourceFormat,
    options: &TableImportParseOptions,
) -> Result<String, String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let canonical_path = std::fs::canonicalize(path).unwrap_or_else(|_| Path::new(path).to_path_buf());
    let mut hasher = Sha256::new();
    hasher.update(canonical_path.to_string_lossy().as_bytes());
    hasher.update(metadata.len().to_le_bytes());
    hasher.update(modified_nanos.to_le_bytes());
    hasher.update(format.label().as_bytes());
    hasher.update(serde_json::to_vec(options).map_err(|error| error.to_string())?);
    Ok(format!("{:x}", hasher.finalize()))
}

fn validated_prepared_import_source(
    request: &TableImportRequest,
    format: TableImportSourceFormat,
) -> Option<ParsedImportFile> {
    let prepared = request.prepared_source.as_ref()?;
    if prepared.columns.is_empty() || prepared.total_rows == 0 {
        return None;
    }
    // Preview rows are reusable only while the source metadata and all parse options still match.
    let fingerprint = import_source_fingerprint(&request.file_path, format, &request.parse_options).ok()?;
    if fingerprint != prepared.fingerprint {
        return None;
    }
    Some(ParsedImportFile {
        columns: prepared.columns.clone(),
        rows: prepared.rows.clone(),
        total_rows: prepared.total_rows,
        effective_encoding: prepared.effective_encoding,
    })
}

pub async fn preview_table_import_file_with_request(
    request: TableImportPreviewRequest,
) -> Result<TableImportPreview, String> {
    let format = effective_source_format(&request.file_path, request.source_format)?;
    let (parsed, total_rows_exact, sheets) = parse_import_preview_file_with_options(
        &request.file_path,
        format,
        &request.parse_options,
        request.preview_limit.unwrap_or(DEFAULT_PREVIEW_LIMIT),
    )
    .await?;
    let metadata = tokio::fs::metadata(&request.file_path).await.map_err(|e| e.to_string())?;
    let source_fingerprint = import_source_fingerprint(&request.file_path, format, &request.parse_options)?;
    let file_name = Path::new(&request.file_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&request.file_path)
        .to_string();
    Ok(TableImportPreview {
        file_name,
        file_path: request.file_path,
        source_ref: request.source_ref,
        file_type: format.label().to_string(),
        size_bytes: metadata.len(),
        columns: parsed.columns,
        rows: parsed.rows,
        total_rows: parsed.total_rows,
        total_rows_exact,
        source_fingerprint,
        effective_encoding: parsed.effective_encoding,
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
    let started_at = Instant::now();
    let mut db_write_ms = 0u128;
    let mut statement_count = 0usize;
    let batch_size = if request.batch_size == 0 { DEFAULT_BATCH_SIZE } else { request.batch_size };
    let source_format = match effective_source_format(&request.file_path, request.source_format) {
        Ok(format) => format,
        Err(error) => {
            return Err(emit_import_error(&mut progress_callback, request, 0, 0, started_at, error));
        }
    };

    if let Err(error) = tokio::fs::metadata(&request.file_path).await {
        return Err(emit_import_error(
            &mut progress_callback,
            request,
            0,
            0,
            started_at,
            format!("Import source is no longer available: {error}"),
        ));
    }
    let prepared_source = validated_prepared_import_source(request, source_format);
    let prepared_source_total_exact =
        prepared_source.is_some() && request.prepared_source.as_ref().is_some_and(|prepared| prepared.total_rows_exact);

    // Validate the entire text source before writing so a malformed tail cannot leave partial batches behind.
    let validated_text_encoding = if source_format.is_delimited() {
        let total_bytes = tokio::fs::metadata(&request.file_path).await.map(|metadata| metadata.len()).unwrap_or(0);
        progress_callback(import_progress_with_details(
            &request.import_id,
            TableImportStatus::Running,
            TableImportPhase::DetectingEncoding,
            0,
            0,
            false,
            0,
            total_bytes,
            started_at,
            None,
        ));
        let mut last_encoding_progress_emit = Instant::now() - IMPORT_PROGRESS_INTERVAL;
        let path = request.file_path.clone();
        let requested_encoding = request.parse_options.encoding;
        let (encoding_progress_sender, mut encoding_progress_receiver) = tokio::sync::mpsc::channel(16);
        let validation = tokio::task::spawn_blocking(move || {
            let mut last_progress_send = Instant::now() - IMPORT_PROGRESS_INTERVAL;
            resolve_and_validate_text_encoding_from_file(&path, requested_encoding, |bytes_read| {
                if last_progress_send.elapsed() >= IMPORT_PROGRESS_INTERVAL
                    || (total_bytes > 0 && bytes_read >= total_bytes)
                {
                    let _ = encoding_progress_sender.blocking_send(bytes_read);
                    last_progress_send = Instant::now();
                }
            })
        });
        while let Some(bytes_read) = encoding_progress_receiver.recv().await {
            if last_encoding_progress_emit.elapsed() >= IMPORT_PROGRESS_INTERVAL
                || (total_bytes > 0 && bytes_read >= total_bytes)
            {
                progress_callback(import_progress_with_details(
                    &request.import_id,
                    TableImportStatus::Running,
                    TableImportPhase::DetectingEncoding,
                    0,
                    0,
                    false,
                    bytes_read.min(total_bytes),
                    total_bytes,
                    started_at,
                    None,
                ));
                last_encoding_progress_emit = Instant::now();
            }
        }
        let validation = match validation.await {
            Ok(validation) => validation,
            Err(error) => {
                return Err(emit_import_error(&mut progress_callback, request, 0, 0, started_at, error.to_string()));
            }
        };
        match validation {
            Ok(resolved) => Some(resolved),
            Err(error) => {
                return Err(emit_import_error(&mut progress_callback, request, 0, 0, started_at, error));
            }
        }
    } else {
        None
    };
    let mut import_parse_options = request.parse_options.clone();
    if let Some((encoding, _)) = validated_text_encoding {
        import_parse_options.encoding = Some(encoding);
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
                started_at,
                "Cannot truncate a table that is being created by the import",
            ));
        }
        let required_sample_rows = if prepared_source_total_exact {
            prepared_source
                .as_ref()
                .map(|prepared| prepared.total_rows.min(CREATE_TABLE_INFERENCE_ROWS))
                .unwrap_or(CREATE_TABLE_INFERENCE_ROWS)
        } else {
            CREATE_TABLE_INFERENCE_ROWS
        };
        let parsed = if let Some(prepared) =
            prepared_source.as_ref().filter(|prepared| prepared.rows.len() >= required_sample_rows).cloned()
        {
            prepared
        } else {
            match parse_import_preview_file_with_options(
                &request.file_path,
                source_format,
                &import_parse_options,
                CREATE_TABLE_INFERENCE_ROWS,
            )
            .await
            {
                Ok((parsed, _, _)) => parsed,
                Err(error) => {
                    return Err(emit_import_error(&mut progress_callback, request, 0, 0, started_at, error));
                }
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
                return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, started_at, error));
            }
        };
        // The table must be created before streaming rows so existing import batching
        // can reuse the same INSERT path and database-specific value escaping.
        if let Err(error) =
            execute_import_statement(state, pool_key, &plan.sql, &mut db_write_ms, &mut statement_count).await
        {
            return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, started_at, error));
        }
        created_column_types =
            Some(plan.columns.iter().map(|column| (column.name.clone(), column.data_type.clone())).collect());
        create_table_sample = Some(parsed);
    }

    if source_format.is_delimited() {
        let parsed = if let Some(parsed) = create_table_sample.clone().or_else(|| prepared_source.clone()) {
            parsed
        } else {
            match parse_import_preview_file_with_options(&request.file_path, source_format, &import_parse_options, 1)
                .await
            {
                Ok((parsed, _, _)) => parsed,
                Err(error) => {
                    return Err(emit_import_error(&mut progress_callback, request, 0, 0, started_at, error));
                }
            }
        };
        let known_total_rows = prepared_source_total_exact.then_some(parsed.total_rows);
        let progress_total_rows = known_total_rows.unwrap_or_default();
        let total_rows = progress_total_rows;
        let total_rows_exact = known_total_rows.is_some();
        if let Err(error) = mapping_indexes_for_columns(&parsed.columns, &request.mappings) {
            return Err(emit_import_error(&mut progress_callback, request, 0, progress_total_rows, started_at, error));
        }

        let total_bytes = tokio::fs::metadata(&request.file_path).await.map(|metadata| metadata.len()).unwrap_or(0);

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
        let (resolved_encoding, _) =
            validated_text_encoding.ok_or_else(|| "Delimited import encoding was not validated".to_string())?;
        let mut streaming_options = import_parse_options.clone();
        streaming_options.encoding = Some(resolved_encoding);
        progress_callback(import_progress_with_details(
            &request.import_id,
            TableImportStatus::Running,
            TableImportPhase::Reading,
            0,
            progress_total_rows,
            known_total_rows.is_some(),
            0,
            total_bytes,
            started_at,
            None,
        ));
        let effective_batch_size = effective_import_batch_size(db_type, batch_size);
        let (sender, mut receiver) = tokio::sync::mpsc::channel::<Result<DelimitedStreamMessage, String>>(2);
        let path = request.file_path.clone();
        let producer_options = streaming_options.clone();
        let producer = tokio::task::spawn_blocking(move || {
            stream_delimited_rows_to_channel(&path, source_format, &producer_options, effective_batch_size, sender)
        });
        let columns = match receiver.recv().await {
            Some(Ok(DelimitedStreamMessage::Header(columns))) => columns,
            Some(Ok(_)) => {
                drop(receiver);
                let _ = producer.await;
                return Err(emit_import_error(
                    &mut progress_callback,
                    request,
                    0,
                    total_rows,
                    started_at,
                    "Delimited stream did not provide a header before data rows",
                ));
            }
            Some(Err(error)) => {
                let _ = producer.await;
                return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, started_at, error));
            }
            None => {
                let error = producer
                    .await
                    .map_err(|error| error.to_string())?
                    .err()
                    .unwrap_or_else(|| "Delimited stream ended before providing a header".to_string());
                return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, started_at, error));
            }
        };
        if columns.is_empty() {
            drop(receiver);
            let _ = producer.await;
            return Err(emit_import_error(
                &mut progress_callback,
                request,
                0,
                total_rows,
                started_at,
                "Import file has no columns in the selected row range",
            ));
        }
        if let Err(error) = mapping_indexes_for_columns(&columns, &request.mappings) {
            drop(receiver);
            let _ = producer.await;
            return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, started_at, error));
        }
        let compiled_plan = if *db_type == DatabaseType::CloudflareD1 {
            None
        } else {
            match compile_import_plan(&columns, &request.mappings, &target_column_types) {
                Ok(plan) => Some(plan),
                Err(error) => {
                    drop(receiver);
                    let _ = producer.await;
                    return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, started_at, error));
                }
            }
        };
        let allow_postgres_copy = *db_type == DatabaseType::Postgres
            && postgres_copy_fast_path_eligible(state, pool_key, &request.table, &request.schema).await;
        let mut pending_truncate =
            matches!(request.mode, TableImportMode::Truncate) && supports_transactional_import_truncate(db_type);
        if matches!(request.mode, TableImportMode::Truncate) && !pending_truncate {
            let sql = truncate_sql(&request.table, &request.schema, db_type);
            if let Err(error) =
                execute_import_statement(state, pool_key, &sql, &mut db_write_ms, &mut statement_count).await
            {
                drop(receiver);
                let _ = producer.await;
                return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, started_at, error));
            }
        }
        let mut rows_imported = 0usize;
        let mut last_bytes_read = 0u64;
        let mut last_progress_emit = Instant::now();
        loop {
            let message = match receiver.recv().await {
                Some(message) => message,
                None => break,
            };
            match message {
                Ok(DelimitedStreamMessage::Header(_)) => {}
                Ok(DelimitedStreamMessage::Rows { rows, bytes_read }) => {
                    last_bytes_read = last_bytes_read.max(bytes_read);
                    if is_cancelled(&request.import_id).await {
                        drop(receiver);
                        let _ = producer.await;
                        progress_callback(import_progress_with_details(
                            &request.import_id,
                            TableImportStatus::Cancelled,
                            TableImportPhase::Done,
                            rows_imported,
                            total_rows,
                            total_rows_exact,
                            last_bytes_read.min(total_bytes),
                            total_bytes,
                            started_at,
                            None,
                        ));
                        return Err("Import cancelled".to_string());
                    }
                    let row_count = match execute_import_rows_batch(
                        state,
                        pool_key,
                        &request.connection_id,
                        &request.database,
                        &rows,
                        compiled_plan.as_ref(),
                        &columns,
                        &request.mappings,
                        &target_column_types,
                        &request.table,
                        &request.schema,
                        db_type,
                        &request.mode,
                        pending_truncate,
                        allow_postgres_copy,
                        request.date_time_format.as_deref(),
                        &mut db_write_ms,
                        &mut statement_count,
                    )
                    .await
                    {
                        Ok(row_count) => row_count,
                        Err(error) => {
                            drop(receiver);
                            let _ = producer.await;
                            rows_imported = rows_imported.saturating_add(error.rows_imported);
                            return Err(emit_import_error(
                                &mut progress_callback,
                                request,
                                rows_imported,
                                total_rows,
                                started_at,
                                error.message,
                            ));
                        }
                    };
                    rows_imported = rows_imported.saturating_add(row_count);
                    pending_truncate = false;
                    if let Some(known_total_rows) = known_total_rows {
                        rows_imported = rows_imported.min(known_total_rows);
                    }
                    if last_progress_emit.elapsed() >= IMPORT_PROGRESS_INTERVAL {
                        progress_callback(import_progress_with_details(
                            &request.import_id,
                            TableImportStatus::Running,
                            TableImportPhase::Writing,
                            rows_imported,
                            total_rows,
                            total_rows_exact,
                            last_bytes_read.min(total_bytes),
                            total_bytes,
                            started_at,
                            None,
                        ));
                        last_progress_emit = Instant::now();
                    }
                }
                Ok(DelimitedStreamMessage::Done) => break,
                Err(error) => {
                    drop(receiver);
                    let _ = producer.await;
                    return Err(emit_import_error(
                        &mut progress_callback,
                        request,
                        rows_imported,
                        total_rows,
                        started_at,
                        error,
                    ));
                }
            }
        }
        match producer.await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                return Err(emit_import_error(
                    &mut progress_callback,
                    request,
                    rows_imported,
                    total_rows,
                    started_at,
                    error,
                ));
            }
            Err(error) => {
                return Err(emit_import_error(
                    &mut progress_callback,
                    request,
                    rows_imported,
                    total_rows,
                    started_at,
                    error.to_string(),
                ));
            }
        }

        progress_callback(import_progress_with_details(
            &request.import_id,
            TableImportStatus::Done,
            TableImportPhase::Done,
            rows_imported,
            rows_imported,
            true,
            total_bytes,
            total_bytes,
            started_at,
            None,
        ));
        log_import_metrics(request, source_format, rows_imported, started_at, db_write_ms, statement_count);

        return Ok(import_summary(&request.import_id, rows_imported, rows_imported, started_at));
    }

    let extension =
        Path::new(&request.file_path).extension().and_then(|extension| extension.to_str()).unwrap_or_default();
    if source_format == TableImportSourceFormat::Excel
        && (extension.eq_ignore_ascii_case("xlsx") || extension.eq_ignore_ascii_case("xlsm"))
    {
        let total_bytes = tokio::fs::metadata(&request.file_path).await.map(|metadata| metadata.len()).unwrap_or(0);
        progress_callback(import_progress_with_details(
            &request.import_id,
            TableImportStatus::Running,
            TableImportPhase::Reading,
            0,
            0,
            false,
            0,
            total_bytes,
            started_at,
            None,
        ));
        let effective_batch_size = effective_import_batch_size(db_type, batch_size);
        let expected_columns = if let Some(source) = create_table_sample.as_ref().or(prepared_source.as_ref()) {
            Some(source.columns.clone())
        } else {
            match parse_import_preview_file_with_options(&request.file_path, source_format, &import_parse_options, 1)
                .await
            {
                Ok((parsed, _, _)) => Some(parsed.columns),
                Err(error) => {
                    return Err(emit_import_error(&mut progress_callback, request, 0, 0, started_at, error));
                }
            }
        };
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
        let text_source_columns = textual_source_columns_for_import(&request.mappings, &target_column_types);
        // No truncate, INSERT, or COPY may run until the selected worksheet parses to EOF.
        if let Err(error) = validate_xlsx_worksheet_for_import(
            request.file_path.clone(),
            request.parse_options.clone(),
            expected_columns.clone(),
            text_source_columns.clone(),
        )
        .await
        {
            return Err(emit_import_error(&mut progress_callback, request, 0, 0, started_at, error));
        }
        // Full-sheet validation can take long enough for the user to cancel. Recheck before
        // starting the producer or executing a non-transactional truncate.
        if is_cancelled(&request.import_id).await {
            progress_callback(import_progress_with_details(
                &request.import_id,
                TableImportStatus::Cancelled,
                TableImportPhase::Done,
                0,
                0,
                false,
                total_bytes,
                total_bytes,
                started_at,
                None,
            ));
            return Err("Import cancelled".to_string());
        }
        let (sender, mut receiver) = tokio::sync::mpsc::channel::<Result<XlsxStreamMessage, String>>(2);
        let path = request.file_path.clone();
        let options = request.parse_options.clone();
        let producer = tokio::task::spawn_blocking(move || {
            stream_xlsx_rows_to_channel(
                &path,
                &options,
                effective_batch_size,
                expected_columns,
                text_source_columns,
                false,
                sender,
            )
        });
        let columns = match receiver.recv().await {
            Some(Ok(XlsxStreamMessage::Header(columns))) => columns,
            Some(Ok(_)) => {
                drop(receiver);
                let _ = producer.await;
                return Err(emit_import_error(
                    &mut progress_callback,
                    request,
                    0,
                    0,
                    started_at,
                    "Excel stream did not provide a header before data rows",
                ));
            }
            Some(Err(error)) => {
                let _ = producer.await;
                return Err(emit_import_error(&mut progress_callback, request, 0, 0, started_at, error));
            }
            None => {
                let error = producer
                    .await
                    .map_err(|error| error.to_string())?
                    .err()
                    .unwrap_or_else(|| "Excel stream ended before providing a header".to_string());
                return Err(emit_import_error(&mut progress_callback, request, 0, 0, started_at, error));
            }
        };
        if columns.is_empty() {
            drop(receiver);
            let _ = producer.await;
            return Err(emit_import_error(
                &mut progress_callback,
                request,
                0,
                0,
                started_at,
                "Import file has no columns in the selected row range",
            ));
        }
        if let Err(error) = mapping_indexes_for_columns(&columns, &request.mappings) {
            drop(receiver);
            let _ = producer.await;
            return Err(emit_import_error(&mut progress_callback, request, 0, 0, started_at, error));
        }
        let compiled_plan = if *db_type == DatabaseType::CloudflareD1 {
            None
        } else {
            match compile_import_plan(&columns, &request.mappings, &target_column_types) {
                Ok(plan) => Some(plan),
                Err(error) => {
                    drop(receiver);
                    let _ = producer.await;
                    return Err(emit_import_error(&mut progress_callback, request, 0, 0, started_at, error));
                }
            }
        };
        let allow_postgres_copy = *db_type == DatabaseType::Postgres
            && postgres_copy_fast_path_eligible(state, pool_key, &request.table, &request.schema).await;
        let mut pending_truncate =
            matches!(request.mode, TableImportMode::Truncate) && supports_transactional_import_truncate(db_type);
        if matches!(request.mode, TableImportMode::Truncate) && !pending_truncate {
            let sql = truncate_sql(&request.table, &request.schema, db_type);
            if let Err(error) =
                execute_import_statement(state, pool_key, &sql, &mut db_write_ms, &mut statement_count).await
            {
                drop(receiver);
                let _ = producer.await;
                return Err(emit_import_error(&mut progress_callback, request, 0, 0, started_at, error));
            }
        }
        let mut rows_imported = 0usize;
        loop {
            let message = match receiver.recv().await {
                Some(message) => message,
                None => break,
            };
            match message {
                Ok(XlsxStreamMessage::Header(_)) => {}
                Ok(XlsxStreamMessage::Rows(rows)) => {
                    if is_cancelled(&request.import_id).await {
                        drop(receiver);
                        let _ = producer.await;
                        progress_callback(import_progress_with_details(
                            &request.import_id,
                            TableImportStatus::Cancelled,
                            TableImportPhase::Done,
                            rows_imported,
                            0,
                            false,
                            0,
                            total_bytes,
                            started_at,
                            None,
                        ));
                        return Err("Import cancelled".to_string());
                    }
                    let row_count = match execute_import_rows_batch(
                        state,
                        pool_key,
                        &request.connection_id,
                        &request.database,
                        &rows,
                        compiled_plan.as_ref(),
                        &columns,
                        &request.mappings,
                        &target_column_types,
                        &request.table,
                        &request.schema,
                        db_type,
                        &request.mode,
                        pending_truncate,
                        allow_postgres_copy,
                        request.date_time_format.as_deref(),
                        &mut db_write_ms,
                        &mut statement_count,
                    )
                    .await
                    {
                        Ok(row_count) => row_count,
                        Err(error) => {
                            drop(receiver);
                            let _ = producer.await;
                            rows_imported = rows_imported.saturating_add(error.rows_imported);
                            return Err(emit_import_error(
                                &mut progress_callback,
                                request,
                                rows_imported,
                                0,
                                started_at,
                                error.message,
                            ));
                        }
                    };
                    rows_imported = rows_imported.saturating_add(row_count);
                    pending_truncate = false;
                    progress_callback(import_progress_with_details(
                        &request.import_id,
                        TableImportStatus::Running,
                        TableImportPhase::Writing,
                        rows_imported,
                        0,
                        false,
                        0,
                        total_bytes,
                        started_at,
                        None,
                    ));
                }
                Ok(XlsxStreamMessage::Progress(bytes_read)) => {
                    progress_callback(import_progress_with_details(
                        &request.import_id,
                        TableImportStatus::Running,
                        TableImportPhase::Writing,
                        rows_imported,
                        0,
                        false,
                        bytes_read.min(total_bytes),
                        total_bytes,
                        started_at,
                        None,
                    ));
                }
                Ok(XlsxStreamMessage::Done) => break,
                Err(error) => {
                    drop(receiver);
                    let _ = producer.await;
                    return Err(emit_import_error(
                        &mut progress_callback,
                        request,
                        rows_imported,
                        0,
                        started_at,
                        error,
                    ));
                }
            }
        }
        match producer.await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                return Err(emit_import_error(&mut progress_callback, request, rows_imported, 0, started_at, error));
            }
            Err(error) => {
                return Err(emit_import_error(
                    &mut progress_callback,
                    request,
                    rows_imported,
                    0,
                    started_at,
                    error.to_string(),
                ));
            }
        }
        progress_callback(import_progress_with_details(
            &request.import_id,
            TableImportStatus::Done,
            TableImportPhase::Done,
            rows_imported,
            rows_imported,
            true,
            total_bytes,
            total_bytes,
            started_at,
            None,
        ));
        log_import_metrics(request, source_format, rows_imported, started_at, db_write_ms, statement_count);
        return Ok(import_summary(&request.import_id, rows_imported, rows_imported, started_at));
    }

    let total_bytes = tokio::fs::metadata(&request.file_path).await.map(|metadata| metadata.len()).unwrap_or(0);
    progress_callback(import_progress_with_details(
        &request.import_id,
        TableImportStatus::Running,
        TableImportPhase::Reading,
        0,
        0,
        false,
        0,
        total_bytes,
        started_at,
        None,
    ));
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
    let text_source_columns = textual_source_columns_for_import(&request.mappings, &target_column_types);
    let parsed = match parse_import_file_with_options_and_text_columns(
        &request.file_path,
        Some(source_format),
        &import_parse_options,
        usize::MAX,
        text_source_columns,
    )
    .await
    {
        Ok(parsed) => parsed,
        Err(error) => {
            return Err(emit_import_error(&mut progress_callback, request, 0, 0, started_at, error));
        }
    };

    let total_rows = parsed.total_rows;
    if let Err(error) = mapping_indexes(&parsed, &request.mappings) {
        return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, started_at, error));
    }
    progress_callback(import_progress_with_details(
        &request.import_id,
        TableImportStatus::Running,
        TableImportPhase::Writing,
        0,
        total_rows,
        true,
        total_bytes,
        total_bytes,
        started_at,
        None,
    ));
    let mut last_progress_emit = Instant::now();

    let effective_batch_size = effective_import_batch_size(db_type, batch_size);
    let compiled_plan = if *db_type == DatabaseType::CloudflareD1 {
        None
    } else {
        match compile_import_plan(&parsed.columns, &request.mappings, &target_column_types) {
            Ok(plan) => Some(plan),
            Err(error) => {
                return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, started_at, error));
            }
        }
    };
    let allow_postgres_copy = *db_type == DatabaseType::Postgres
        && postgres_copy_fast_path_eligible(state, pool_key, &request.table, &request.schema).await;

    let mut pending_truncate =
        matches!(request.mode, TableImportMode::Truncate) && supports_transactional_import_truncate(db_type);
    if matches!(request.mode, TableImportMode::Truncate) && !pending_truncate {
        let sql = truncate_sql(&request.table, &request.schema, db_type);
        if let Err(error) =
            execute_import_statement(state, pool_key, &sql, &mut db_write_ms, &mut statement_count).await
        {
            return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, started_at, error));
        }
    }

    let mut rows_imported = 0;
    for rows in parsed.rows.chunks(effective_batch_size) {
        if is_cancelled(&request.import_id).await {
            progress_callback(import_progress(
                &request.import_id,
                TableImportStatus::Cancelled,
                rows_imported,
                total_rows,
                started_at,
                None,
            ));
            return Err("Import cancelled".to_string());
        }

        let row_count = match execute_import_rows_batch(
            state,
            pool_key,
            &request.connection_id,
            &request.database,
            rows,
            compiled_plan.as_ref(),
            &parsed.columns,
            &request.mappings,
            &target_column_types,
            &request.table,
            &request.schema,
            db_type,
            &request.mode,
            pending_truncate,
            allow_postgres_copy,
            request.date_time_format.as_deref(),
            &mut db_write_ms,
            &mut statement_count,
        )
        .await
        {
            Ok(row_count) => row_count,
            Err(error) => {
                rows_imported = (rows_imported + error.rows_imported).min(total_rows);
                return Err(emit_import_error(
                    &mut progress_callback,
                    request,
                    rows_imported,
                    total_rows,
                    started_at,
                    error.message,
                ));
            }
        };
        rows_imported = (rows_imported + row_count).min(total_rows);
        pending_truncate = false;
        if last_progress_emit.elapsed() >= IMPORT_PROGRESS_INTERVAL {
            progress_callback(import_progress(
                &request.import_id,
                TableImportStatus::Running,
                rows_imported,
                total_rows,
                started_at,
                None,
            ));
            last_progress_emit = Instant::now();
        }
    }

    progress_callback(import_progress(
        &request.import_id,
        TableImportStatus::Done,
        rows_imported,
        total_rows,
        started_at,
        None,
    ));
    log_import_metrics(request, source_format, rows_imported, started_at, db_write_ms, statement_count);

    Ok(import_summary(&request.import_id, rows_imported, total_rows, started_at))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::connection::{ConnectionConfig, DatabaseType};
    use crate::storage::Storage;
    use crate::xlsx_export::{build_xlsx_workbook_multi, XlsxWorksheetData};
    use std::io::{Cursor, Write};

    fn xlsx_named_spill_files() -> std::collections::HashSet<std::path::PathBuf> {
        std::fs::read_dir(std::env::temp_dir())
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("dbx-xlsx-shared-"))
            .map(|entry| entry.path())
            .collect()
    }

    #[test]
    fn table_import_progress_and_summary_report_elapsed_ms() {
        let started_at = std::time::Instant::now() - std::time::Duration::from_millis(25);

        let progress = import_progress("import-1", TableImportStatus::Running, 10, 20, started_at, None);
        let summary = import_summary("import-1", 20, 20, started_at);
        let progress_json = serde_json::to_value(&progress).unwrap();
        let summary_json = serde_json::to_value(&summary).unwrap();

        assert!(progress.elapsed_ms >= 25);
        assert!(summary.elapsed_ms >= progress.elapsed_ms);
        assert_eq!(progress_json["elapsedMs"], serde_json::json!(progress.elapsed_ms));
        assert_eq!(summary_json["elapsedMs"], serde_json::json!(summary.elapsed_ms));
        assert_eq!(progress_json["phase"], serde_json::json!("writing"));
        assert_eq!(progress_json["totalRowsExact"], serde_json::json!(true));
    }

    #[test]
    fn compiled_import_plan_reuses_source_indexes_and_target_types() {
        let columns = vec!["name".to_string(), "id".to_string()];
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

        let plan = compile_import_plan(
            &columns,
            &mappings,
            &[("DISPLAY_NAME".to_string(), "VARCHAR(255)".to_string()), ("user_id".to_string(), "BIGINT".to_string())],
        )
        .unwrap();

        assert_eq!(plan.mapped_source_indexes, vec![1, 0]);
        assert_eq!(plan.target_columns, vec!["user_id", "display_name"]);
        assert_eq!(plan.column_types, vec![Some("BIGINT".to_string()), Some("VARCHAR(255)".to_string())]);
    }

    #[test]
    fn prepared_import_source_is_reused_only_while_fingerprint_matches() {
        let legacy_prepared: TableImportPreparedSource = serde_json::from_value(serde_json::json!({
            "fingerprint": "legacy",
            "columns": ["id"],
            "rows": [[1]],
            "totalRows": 1
        }))
        .unwrap();
        assert!(legacy_prepared.total_rows_exact);

        let path = std::env::temp_dir().join(format!("dbx-table-import-prepared-{}.csv", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"id,name\n1,Ada\n").unwrap();
        let file_path = path.to_string_lossy().to_string();
        let parse_options = TableImportParseOptions::default();
        let fingerprint = import_source_fingerprint(&file_path, TableImportSourceFormat::Csv, &parse_options).unwrap();
        let request = TableImportRequest {
            import_id: "import-1".to_string(),
            connection_id: "connection-1".to_string(),
            database: "db".to_string(),
            schema: "public".to_string(),
            table: "users".to_string(),
            file_path: file_path.clone(),
            source_ref: None,
            source_format: Some(TableImportSourceFormat::Csv),
            parse_options,
            mappings: vec![],
            mode: TableImportMode::Append,
            create_table: false,
            batch_size: 500,
            date_time_format: None,
            prepared_source: Some(TableImportPreparedSource {
                fingerprint,
                columns: vec!["id".to_string(), "name".to_string()],
                rows: vec![vec![serde_json::json!(1), serde_json::json!("Ada")]],
                total_rows: 1,
                total_rows_exact: true,
                effective_encoding: Some(TableImportTextEncoding::Utf8),
            }),
            retain_source: false,
        };

        let prepared = validated_prepared_import_source(&request, TableImportSourceFormat::Csv).unwrap();
        assert_eq!(prepared.total_rows, 1);
        assert_eq!(prepared.columns, vec!["id", "name"]);

        std::fs::write(&path, b"id,name\n1,Ada\n2,Grace\n").unwrap();
        assert!(validated_prepared_import_source(&request, TableImportSourceFormat::Csv).is_none());
        let _ = std::fs::remove_file(path);
    }

    fn write_xlsx_test_entry<W: Write + std::io::Seek>(zip: &mut zip::ZipWriter<W>, path: &str, content: &str) {
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        zip.start_file(path, options).unwrap();
        zip.write_all(content.as_bytes()).unwrap();
    }

    fn build_styled_test_xlsx<S: AsRef<str>>(date1904: bool, cells: &[(S, usize, f64)]) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(cursor);
        let workbook_pr = if date1904 { r#"<workbookPr date1904="1"/>"# } else { "" };
        let mut rows = std::collections::BTreeMap::<usize, String>::new();
        for (reference, style_id, value) in cells {
            let reference = reference.as_ref();
            let (row, _) = xlsx_cell_ref_position(reference).expect("valid XLSX cell reference");
            rows.entry(row).or_default().push_str(&format!(r#"<c r="{reference}" s="{style_id}"><v>{value}</v></c>"#));
        }
        let rows_xml =
            rows.into_iter().map(|(row, cells)| format!(r#"<row r="{row}">{cells}</row>"#)).collect::<String>();

        write_xlsx_test_entry(
            &mut zip,
            "[Content_Types].xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>"#,
        );
        write_xlsx_test_entry(
            &mut zip,
            "_rels/.rels",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#,
        );
        write_xlsx_test_entry(
            &mut zip,
            "xl/workbook.xml",
            &format!(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  {workbook_pr}
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>"#
            ),
        );
        write_xlsx_test_entry(
            &mut zip,
            "xl/_rels/workbook.xml.rels",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"#,
        );
        write_xlsx_test_entry(
            &mut zip,
            "xl/styles.xml",
            r##"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="12">
    <numFmt numFmtId="164" formatCode="yyyy-mm-dd"/>
    <numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm:ss"/>
    <numFmt numFmtId="166" formatCode="hh:mm:ss"/>
    <numFmt numFmtId="167" formatCode="[h]:mm:ss"/>
    <numFmt numFmtId="168" formatCode="0.0"/>
    <numFmt numFmtId="169" formatCode="0.00"/>
    <numFmt numFmtId="170" formatCode="00000"/>
    <numFmt numFmtId="171" formatCode="#,##0.00"/>
    <numFmt numFmtId="172" formatCode="0.00E+00"/>
    <numFmt numFmtId="173" formatCode="0.0%"/>
    <numFmt numFmtId="174" formatCode="[$€-407]#,##0.00"/>
    <numFmt numFmtId="175" formatCode="[$-409]#,##0.00"/>
  </numFmts>
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="13">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="168" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="169" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="170" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="171" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="172" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="173" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="174" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="175" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>"##,
        );
        write_xlsx_test_entry(
            &mut zip,
            "xl/worksheets/sheet1.xml",
            &format!(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>{rows_xml}</sheetData>
</worksheet>"#
            ),
        );

        zip.finish().unwrap().into_inner()
    }

    fn build_preview_test_xlsx(sheet_xml: &str, shared_strings_xml: Option<&str>) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(cursor);
        write_xlsx_test_entry(
            &mut zip,
            "[Content_Types].xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>"#,
        );
        write_xlsx_test_entry(
            &mut zip,
            "_rels/.rels",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#,
        );
        write_xlsx_test_entry(
            &mut zip,
            "xl/workbook.xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>"#,
        );
        write_xlsx_test_entry(
            &mut zip,
            "xl/_rels/workbook.xml.rels",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>"#,
        );
        write_xlsx_test_entry(
            &mut zip,
            "xl/styles.xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cellXfs count="1"><xf numFmtId="0"/></cellXfs>
</styleSheet>"#,
        );
        if let Some(shared_strings_xml) = shared_strings_xml {
            write_xlsx_test_entry(&mut zip, "xl/sharedStrings.xml", shared_strings_xml);
        }
        write_xlsx_test_entry(&mut zip, "xl/worksheets/sheet1.xml", sheet_xml);
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn retains_only_temporal_and_text_target_xlsx_styles() {
        let styles = vec![
            XlsxCellStyle { temporal_kind: None, number_format: Some(Arc::from("0.00")) },
            XlsxCellStyle { temporal_kind: Some(XlsxTemporalKind::Date), number_format: None },
        ];
        let sheet = r#"<worksheet><sheetData><row r="1">
            <c r="A1" s="0"><v>10</v></c>
            <c r="B1" s="0"><v>20</v></c>
            <c r="C1" s="1"><v>45996</v></c>
        </row></sheetData></worksheet>"#;

        let retained =
            parse_xlsx_sheet_cell_styles(Cursor::new(sheet.as_bytes()), &styles, &HashSet::from([2])).unwrap();

        assert_eq!(retained.len(), 2);
        assert!(!retained.contains_key(&(1, 1)));
        assert_eq!(retained.get(&(1, 2)).and_then(|style| style.number_format.as_deref()), Some("0.00"));
        assert_eq!(retained.get(&(1, 3)).and_then(|style| style.temporal_kind), Some(XlsxTemporalKind::Date));
    }

    #[test]
    fn legacy_xls_rejects_numeric_to_text_without_affecting_numeric_targets() {
        let path = std::env::temp_dir().join(format!("dbx-table-import-formatted-{}.xls", uuid::Uuid::new_v4()));
        std::fs::write(&path, include_bytes!("../tests/fixtures/issue3683-formatted-numbers.xls")).unwrap();
        let options = TableImportParseOptions { has_header: Some(false), ..TableImportParseOptions::default() };

        let numeric =
            parse_xlsx_file_with_options_and_text_columns(&path.to_string_lossy(), &options, 10, &HashSet::new())
                .unwrap();
        let values = numeric.rows[0].iter().map(|value| value.as_f64()).collect::<Vec<_>>();
        assert_eq!(values, vec![Some(10.0), Some(42.0), Some(0.125), Some(1234.5), Some(99.5)]);

        for column in 1..=4 {
            let source_column = format!("column_{column}");
            let error = parse_xlsx_file_with_options_and_text_columns(
                &path.to_string_lossy(),
                &options,
                10,
                &HashSet::from([source_column.clone()]),
            )
            .unwrap_err();
            assert!(error.contains("Legacy .xls"), "{error}");
            assert!(error.contains(&source_column), "{error}");
            assert!(error.contains("Save the workbook as .xlsx"), "{error}");
        }
        let _ = std::fs::remove_file(path);
    }

    #[cfg(target_os = "linux")]
    fn linux_process_rss_kib(pid: u32) -> Option<u64> {
        let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
        status
            .lines()
            .find_map(|line| line.strip_prefix("VmRSS:")?.split_ascii_whitespace().next()?.parse::<u64>().ok())
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn xlsx_style_rss_helper() {
        let Ok(sheet_path) = std::env::var("DBX_XLSX_STYLE_RSS_PATH") else {
            return;
        };
        let ready_path = std::env::var("DBX_XLSX_STYLE_RSS_READY").unwrap();
        let go_path = std::env::var("DBX_XLSX_STYLE_RSS_GO").unwrap();
        std::fs::write(&ready_path, b"ready").unwrap();
        while !Path::new(&go_path).exists() {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }

        let styles = [XlsxCellStyle { temporal_kind: None, number_format: Some(Arc::from("0.00")) }];
        let sheet = BufReader::new(File::open(sheet_path).unwrap());
        let retained = parse_xlsx_sheet_cell_styles(sheet, &styles, &HashSet::new()).unwrap();
        assert!(retained.is_empty());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn streaming_xlsx_style_scan_keeps_peak_rss_bounded() {
        const ROWS: usize = 120_000;
        const COLUMNS: usize = 8;
        const MAX_RSS_GROWTH_KIB: u64 = 48 * 1024;

        let suffix = uuid::Uuid::new_v4();
        let sheet_path = std::env::temp_dir().join(format!("dbx-xlsx-style-rss-{suffix}.xml"));
        let ready_path = std::env::temp_dir().join(format!("dbx-xlsx-style-rss-{suffix}.ready"));
        let go_path = std::env::temp_dir().join(format!("dbx-xlsx-style-rss-{suffix}.go"));
        let mut sheet = std::io::BufWriter::new(File::create(&sheet_path).unwrap());
        write!(sheet, "<worksheet><sheetData>").unwrap();
        for row in 1..=ROWS {
            write!(sheet, "<row r=\"{row}\">").unwrap();
            for column in 0..COLUMNS {
                let column_name = (b'A' + column as u8) as char;
                write!(sheet, "<c r=\"{column_name}{row}\" s=\"0\"><v>{row}</v></c>").unwrap();
            }
            write!(sheet, "</row>").unwrap();
        }
        write!(sheet, "</sheetData></worksheet>").unwrap();
        sheet.flush().unwrap();

        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "table_import::tests::xlsx_style_rss_helper", "--nocapture"])
            .env("DBX_XLSX_STYLE_RSS_PATH", &sheet_path)
            .env("DBX_XLSX_STYLE_RSS_READY", &ready_path)
            .env("DBX_XLSX_STYLE_RSS_GO", &go_path)
            .spawn()
            .unwrap();
        for _ in 0..10_000 {
            if ready_path.exists() {
                break;
            }
            assert!(child.try_wait().unwrap().is_none(), "RSS helper exited before becoming ready");
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        assert!(ready_path.exists(), "RSS helper did not become ready");
        let baseline_rss = linux_process_rss_kib(child.id()).expect("helper RSS before scan");
        std::fs::write(&go_path, b"go").unwrap();
        let mut peak_rss = baseline_rss;
        let status = loop {
            if let Some(rss) = linux_process_rss_kib(child.id()) {
                peak_rss = peak_rss.max(rss);
            }
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        };

        let _ = std::fs::remove_file(&sheet_path);
        let _ = std::fs::remove_file(&ready_path);
        let _ = std::fs::remove_file(&go_path);
        assert!(status.success());
        assert!(
            peak_rss.saturating_sub(baseline_rss) <= MAX_RSS_GROWTH_KIB,
            "streaming style scan RSS grew by {} KiB (baseline {baseline_rss} KiB, peak {peak_rss} KiB)",
            peak_rss.saturating_sub(baseline_rss)
        );
    }

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
    fn auto_detects_and_parses_gbk_csv() {
        let (bytes, _, had_errors) = encoding_rs::GBK.encode("id,name\n1,中文\n2,上海\n");
        assert!(!had_errors);

        let parsed = parse_delimited_bytes_with_options(
            bytes.as_ref(),
            TableImportSourceFormat::Csv,
            &TableImportParseOptions::default(),
            10,
        )
        .unwrap();

        assert_eq!(parsed.effective_encoding, Some(TableImportTextEncoding::Gbk));
        assert_eq!(parsed.columns, vec!["id", "name"]);
        assert_eq!(parsed.rows[0], vec![serde_json::json!("1"), serde_json::json!("中文")]);
        assert_eq!(parsed.rows[1], vec![serde_json::json!("2"), serde_json::json!("上海")]);
    }

    #[test]
    fn file_encoding_detection_validates_utf8_and_gbk_in_one_monotonic_scan() {
        let path = std::env::temp_dir().join(format!("dbx-table-import-encoding-{}.csv", uuid::Uuid::new_v4()));
        let bytes = b"id,name\n1,\xD6\xD0\n";
        std::fs::write(&path, bytes).unwrap();
        let mut progress = Vec::new();

        let (encoding, bom_len) =
            auto_detect_text_encoding_from_file_with_progress(&path.to_string_lossy(), |bytes_read| {
                progress.push(bytes_read)
            })
            .unwrap();

        assert_eq!(encoding, TableImportTextEncoding::Gbk);
        assert_eq!(bom_len, 0);
        assert_eq!(progress.last().copied(), Some(bytes.len() as u64));
        assert!(progress.windows(2).all(|window| window[0] <= window[1]));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn explicit_encoding_validation_rejects_invalid_tail_before_import() {
        let path = std::env::temp_dir().join(format!("dbx-table-import-invalid-tail-{}.csv", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"id\n1\n\xFF").unwrap();

        let error = validate_text_encoding_from_file_with_progress(
            &path.to_string_lossy(),
            TableImportTextEncoding::Utf8,
            0,
            |_| {},
        )
        .unwrap_err();

        assert!(error.contains("Invalid byte sequence for UTF-8"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn bom_encoding_detection_reports_the_file_as_fully_detected() {
        let path = std::env::temp_dir().join(format!("dbx-table-import-bom-progress-{}.csv", uuid::Uuid::new_v4()));
        let bytes = b"\xEF\xBB\xBFid,name\n1,Ada\n";
        std::fs::write(&path, bytes).unwrap();
        let mut progress = Vec::new();

        let (encoding, bom_len) =
            auto_detect_text_encoding_from_file_with_progress(&path.to_string_lossy(), |bytes_read| {
                progress.push(bytes_read)
            })
            .unwrap();

        assert_eq!(encoding, TableImportTextEncoding::Utf8);
        assert_eq!(bom_len, 3);
        assert_eq!(progress, vec![bytes.len() as u64]);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn explicit_utf8_rejects_gbk_csv_without_replacing_data() {
        let (bytes, _, had_errors) = encoding_rs::GBK.encode("id,name\n1,中文\n");
        assert!(!had_errors);
        let options = TableImportParseOptions {
            encoding: Some(TableImportTextEncoding::Utf8),
            ..TableImportParseOptions::default()
        };

        let error =
            parse_delimited_bytes_with_options(bytes.as_ref(), TableImportSourceFormat::Csv, &options, 10).unwrap_err();

        assert!(error.contains("Invalid byte sequence for UTF-8 encoding"), "{error}");
    }

    #[test]
    fn gbk_option_decodes_gb18030_four_byte_characters() {
        let (bytes, _, had_errors) = encoding_rs::GB18030.encode("id,name\n1,😀\n");
        assert!(!had_errors);

        let parsed = parse_delimited_bytes_with_options(
            bytes.as_ref(),
            TableImportSourceFormat::Csv,
            &TableImportParseOptions::default(),
            10,
        )
        .unwrap();

        assert_eq!(parsed.effective_encoding, Some(TableImportTextEncoding::Gbk));
        assert_eq!(parsed.rows[0], vec![serde_json::json!("1"), serde_json::json!("😀")]);
    }

    #[test]
    fn auto_detects_utf16le_bom_csv() {
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "id,name\n1,中文\n".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }

        let parsed = parse_delimited_bytes_with_options(
            &bytes,
            TableImportSourceFormat::Csv,
            &TableImportParseOptions::default(),
            10,
        )
        .unwrap();

        assert_eq!(parsed.effective_encoding, Some(TableImportTextEncoding::Utf16Le));
        assert_eq!(parsed.rows[0], vec![serde_json::json!("1"), serde_json::json!("中文")]);
    }

    #[test]
    fn auto_detects_utf16be_bom_csv() {
        let mut bytes = vec![0xFE, 0xFF];
        for unit in "id,name\n1,中文\n".encode_utf16() {
            bytes.extend_from_slice(&unit.to_be_bytes());
        }

        let parsed = parse_delimited_bytes_with_options(
            &bytes,
            TableImportSourceFormat::Csv,
            &TableImportParseOptions::default(),
            10,
        )
        .unwrap();

        assert_eq!(parsed.effective_encoding, Some(TableImportTextEncoding::Utf16Be));
        assert_eq!(parsed.columns, vec!["id", "name"]);
        assert_eq!(parsed.rows[0], vec![serde_json::json!("1"), serde_json::json!("中文")]);
    }

    #[test]
    fn explicit_utf16le_parses_csv_without_bom() {
        let bytes = "id,name\n1,中文\n".encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>();
        let options = TableImportParseOptions {
            encoding: Some(TableImportTextEncoding::Utf16Le),
            ..TableImportParseOptions::default()
        };

        let parsed = parse_delimited_bytes_with_options(&bytes, TableImportSourceFormat::Csv, &options, 10).unwrap();

        assert_eq!(parsed.effective_encoding, Some(TableImportTextEncoding::Utf16Le));
        assert_eq!(parsed.columns, vec!["id", "name"]);
        assert_eq!(parsed.rows[0], vec![serde_json::json!("1"), serde_json::json!("中文")]);
    }

    #[test]
    fn gbk_decoder_preserves_multibyte_character_across_read_chunks() {
        let ascii_prefix = "a".repeat(IMPORT_ENCODING_READ_CHUNK_BYTES - "name\n".len() - 1);
        let csv = format!("name\n{ascii_prefix}中\n");
        let (bytes, _, had_errors) = encoding_rs::GBK.encode(&csv);
        assert!(!had_errors);
        let options = TableImportParseOptions {
            encoding: Some(TableImportTextEncoding::Gbk),
            ..TableImportParseOptions::default()
        };

        let parsed =
            parse_delimited_bytes_with_options(bytes.as_ref(), TableImportSourceFormat::Csv, &options, 10).unwrap();

        assert_eq!(parsed.rows[0][0], serde_json::json!(format!("{ascii_prefix}中")));
    }

    #[tokio::test]
    async fn preview_reads_real_gbk_file_and_reports_detected_encoding() {
        let path = std::env::temp_dir().join(format!("dbx-table-import-gbk-{}.csv", uuid::Uuid::new_v4()));
        let (bytes, _, had_errors) = encoding_rs::GBK.encode("编号,城市\n1,北京\n2,上海\n");
        assert!(!had_errors);
        std::fs::write(&path, bytes.as_ref()).unwrap();

        let preview = preview_table_import_file_with_request(TableImportPreviewRequest {
            file_path: path.to_string_lossy().to_string(),
            source_ref: None,
            source_format: Some(TableImportSourceFormat::Csv),
            parse_options: TableImportParseOptions::default(),
            preview_limit: Some(10),
        })
        .await
        .unwrap();
        let _ = std::fs::remove_file(path);

        assert_eq!(preview.effective_encoding, Some(TableImportTextEncoding::Gbk));
        assert_eq!(preview.columns, vec!["编号", "城市"]);
        assert_eq!(preview.total_rows, 2);
        assert!(!preview.total_rows_exact);
        assert_eq!(preview.rows[0], vec![serde_json::json!("1"), serde_json::json!("北京")]);
    }

    #[test]
    fn bounded_csv_preview_does_not_parse_the_tail() {
        let reader = csv::ReaderBuilder::new()
            .has_headers(false)
            .flexible(true)
            .from_reader(&b"id,name\n1,Ada\n\"unterminated"[..]);
        let config =
            effective_delimited_config(TableImportSourceFormat::Csv, &TableImportParseOptions::default()).unwrap();

        let preview = parse_csv_reader_bounded(reader, config, 1, TableImportTextEncoding::Utf8).unwrap();

        assert_eq!(preview.columns, vec!["id", "name"]);
        assert_eq!(preview.rows, vec![vec![serde_json::json!("1"), serde_json::json!("Ada")]]);
        assert_eq!(preview.total_rows, 1);
    }

    #[test]
    fn streams_delimited_rows_in_batches_and_preserves_selected_range() {
        let path = std::env::temp_dir().join(format!("dbx-table-import-stream-{}.csv", uuid::Uuid::new_v4()));
        let bytes = b"report,ignored\nid,name\nnotes,ignored\n1,Ada\n2,Grace\n3,Linus\nsummary,3\n";
        std::fs::write(&path, bytes).unwrap();
        let options = TableImportParseOptions {
            encoding: Some(TableImportTextEncoding::Utf8),
            title_row: Some(2),
            data_start_row: Some(4),
            last_data_row: Some(6),
            ..TableImportParseOptions::default()
        };
        let (sender, mut receiver) = tokio::sync::mpsc::channel(16);

        stream_delimited_rows_to_channel(&path.to_string_lossy(), TableImportSourceFormat::Csv, &options, 2, sender)
            .unwrap();

        let messages =
            std::iter::from_fn(|| receiver.blocking_recv()).map(|message| message.unwrap()).collect::<Vec<_>>();
        assert!(
            matches!(messages.first(), Some(DelimitedStreamMessage::Header(columns)) if columns == &vec!["id".to_string(), "name".to_string()])
        );
        assert!(matches!(messages.last(), Some(DelimitedStreamMessage::Done)));
        let batches = messages
            .iter()
            .filter_map(|message| match message {
                DelimitedStreamMessage::Rows { rows, .. } => Some(rows),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(batches.len(), 2);
        assert_eq!(
            batches[0],
            &vec![
                vec![serde_json::json!("1"), serde_json::json!("Ada")],
                vec![serde_json::json!("2"), serde_json::json!("Grace")],
            ]
        );
        assert_eq!(batches[1], &vec![vec![serde_json::json!("3"), serde_json::json!("Linus")]]);
        let bytes_read = messages
            .iter()
            .filter_map(|message| match message {
                DelimitedStreamMessage::Rows { bytes_read, .. } => Some(*bytes_read),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert!(bytes_read.windows(2).all(|window| window[0] <= window[1]));
        assert!(bytes_read.last().copied().unwrap_or_default() <= bytes.len() as u64);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn legacy_xls_uses_a_stricter_non_streaming_file_limit() {
        let path = std::env::temp_dir().join(format!("dbx-table-import-limit-{}.xls", uuid::Uuid::new_v4()));
        let file = File::create(&path).unwrap();
        file.set_len(MAX_LEGACY_XLS_IMPORT_BYTES + 1).unwrap();
        drop(file);

        let error =
            ensure_non_streaming_file_size(&path.to_string_lossy(), TableImportSourceFormat::Excel).unwrap_err();

        assert!(error.contains(&MAX_LEGACY_XLS_IMPORT_BYTES.to_string()));
        ensure_non_streaming_file_size(&path.to_string_lossy(), TableImportSourceFormat::Json).unwrap();
        let _ = std::fs::remove_file(path);
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
    fn parses_delimited_text_with_custom_title_and_data_rows() {
        let options = TableImportParseOptions {
            title_row: Some(2),
            data_start_row: Some(4),
            last_data_row: Some(5),
            ..TableImportParseOptions::default()
        };
        let parsed = parse_delimited_bytes_with_options(
            b"report,ignored\nid,name\nnotes,ignored\n1,Ada\n2,Grace\nsummary,2\n",
            TableImportSourceFormat::Csv,
            &options,
            10,
        )
        .unwrap();

        assert_eq!(parsed.columns, vec!["id", "name"]);
        assert_eq!(parsed.total_rows, 2);
        assert_eq!(parsed.rows[0], vec![serde_json::json!("1"), serde_json::json!("Ada")]);
        assert_eq!(parsed.rows[1], vec![serde_json::json!("2"), serde_json::json!("Grace")]);
    }

    #[test]
    fn rejects_title_row_inside_data_range() {
        let options = TableImportParseOptions {
            title_row: Some(2),
            data_start_row: Some(1),
            last_data_row: Some(3),
            ..TableImportParseOptions::default()
        };

        assert!(effective_import_row_range(&options).unwrap_err().contains("before the data start row"));
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
                column_types: vec![],
                rows: vec![vec![serde_json::json!(1)]],
            },
            XlsxWorksheetData {
                sheet_name: Some("Second".to_string()),
                columns: vec!["name".to_string()],
                column_types: vec![],
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
        assert_eq!(
            mapping_indexes(
                &parsed,
                &[TableImportColumnMapping {
                    source_column: "name".to_string(),
                    target_column: "display_name".to_string(),
                    target_data_type: None,
                }],
            )
            .unwrap(),
            vec![(0, "display_name".to_string())]
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn fast_excel_preview_reads_only_requested_rows_and_reuses_sheet_metadata() {
        let path = std::env::temp_dir().join(format!("dbx-table-import-preview-{}.xlsx", uuid::Uuid::new_v4()));
        let workbook = build_xlsx_workbook_multi(&[
            XlsxWorksheetData {
                sheet_name: Some("First".to_string()),
                columns: vec!["id".to_string()],
                column_types: vec![],
                rows: vec![vec![serde_json::json!(1)]],
            },
            XlsxWorksheetData {
                sheet_name: Some("Second".to_string()),
                columns: vec!["name".to_string()],
                column_types: vec![],
                rows: vec![vec![serde_json::json!("Ada")], vec![serde_json::json!("Grace")]],
            },
        ])
        .unwrap();
        std::fs::write(&path, workbook).unwrap();
        let options =
            TableImportParseOptions { sheet_name: Some("Second".to_string()), ..TableImportParseOptions::default() };

        let (preview, sheets) = parse_xlsx_preview_file_with_options(&path.to_string_lossy(), &options, 1).unwrap();

        assert_eq!(sheets, vec!["First", "Second"]);
        assert_eq!(preview.columns, vec!["name"]);
        assert_eq!(preview.rows, vec![vec![serde_json::json!("Ada")]]);
        assert_eq!(preview.total_rows, 1);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn xlsx_shared_strings_use_disk_index_above_memory_limit() {
        let path = std::env::temp_dir().join(format!("dbx-table-import-shared-index-{}.xlsx", uuid::Uuid::new_v4()));
        let sheet_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:A2"/>
  <sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c></row></sheetData>
</worksheet>"#;
        let shared_strings_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">
  <si><t>name</t></si><si><r><t>Ada</t></r><rPh sb="0" eb="3"><t>ignored</t></rPh></si>
</sst>"#;
        std::fs::write(&path, build_preview_test_xlsx(sheet_xml, Some(shared_strings_xml))).unwrap();
        let mut zip = zip::ZipArchive::new(File::open(&path).unwrap()).unwrap();

        let mut strings = open_xlsx_shared_strings(&mut zip, 0).unwrap();
        assert!(strings.disk_files().is_some(), "disk-backed shared strings");
        assert_eq!(strings.get(0).unwrap().as_deref(), Some("name"));
        assert_eq!(strings.get(1).unwrap().as_deref(), Some("Ada"));
        drop(strings);
        drop(zip);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn xlsx_disk_shared_strings_do_not_leave_named_spill_files() {
        let path =
            std::env::temp_dir().join(format!("dbx-table-import-shared-anonymous-{}.xlsx", uuid::Uuid::new_v4()));
        let sheet_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:A1"/>
  <sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData>
</worksheet>"#;
        let shared_strings_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1">
  <si><t>sensitive-value</t></si>
</sst>"#;
        std::fs::write(&path, build_preview_test_xlsx(sheet_xml, Some(shared_strings_xml))).unwrap();
        let mut zip = zip::ZipArchive::new(File::open(&path).unwrap()).unwrap();
        let before = xlsx_named_spill_files();

        let strings = open_xlsx_shared_strings(&mut zip, 0).unwrap();
        let named_spill_files: Vec<_> = xlsx_named_spill_files().difference(&before).cloned().collect();

        drop(strings);
        drop(zip);
        let _ = std::fs::remove_file(path);
        let remaining_spill_files: Vec<_> = xlsx_named_spill_files().difference(&before).cloned().collect();
        assert!(
            named_spill_files.is_empty(),
            "disk-backed shared strings created named spill files: {named_spill_files:?}"
        );
        assert!(
            remaining_spill_files.is_empty(),
            "disk-backed shared strings left named spill files: {remaining_spill_files:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn xlsx_disk_shared_strings_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let path = std::env::temp_dir().join(format!("dbx-table-import-shared-perms-{}.xlsx", uuid::Uuid::new_v4()));
        let sheet_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:A2"/>
  <sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c></row></sheetData>
</worksheet>"#;
        let shared_strings_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">
  <si><t>name</t></si><si><t>Ada</t></si>
</sst>"#;
        std::fs::write(&path, build_preview_test_xlsx(sheet_xml, Some(shared_strings_xml))).unwrap();
        let mut zip = zip::ZipArchive::new(File::open(&path).unwrap()).unwrap();

        let strings = open_xlsx_shared_strings(&mut zip, 0).unwrap();
        let (data_file, index_file) = strings.disk_files().expect("disk-backed shared strings");

        // Both spill files must be readable and writable only by the owner so other local
        // users cannot read sensitive shared-string content while an import is in flight.
        for spill_file in [data_file, index_file] {
            let mode = spill_file.metadata().unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "unexpected shared-string spill-file mode: {mode:o}");
        }

        drop(strings);
        drop(zip);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn xlsx_disk_shared_strings_are_cleaned_up_after_parse_failure() {
        let path = std::env::temp_dir().join(format!("dbx-table-import-shared-fail-{}.xlsx", uuid::Uuid::new_v4()));
        let sheet_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:A1"/>
  <sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData>
</worksheet>"#;
        // Malformed XML: the reader spills the first string to disk, then errors on the
        // broken markup, so the temp files must still be removed on the error path.
        let shared_strings_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">
  <si><t>name</t></si><si><t>Ada</t></si> <<< broken"#;
        std::fs::write(&path, build_preview_test_xlsx(sheet_xml, Some(shared_strings_xml))).unwrap();
        let mut zip = zip::ZipArchive::new(File::open(&path).unwrap()).unwrap();

        let before = xlsx_named_spill_files();
        let result = open_xlsx_shared_strings(&mut zip, 0);
        assert!(result.is_err(), "expected malformed shared strings to fail parsing");
        let leaked: Vec<_> = xlsx_named_spill_files().difference(&before).cloned().collect();
        assert!(leaked.is_empty(), "spill files leaked after parse failure: {leaked:?}");

        drop(zip);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn streaming_excel_rows_avoid_materializing_the_full_range() {
        let path = std::env::temp_dir().join(format!("dbx-table-import-stream-{}.xlsx", uuid::Uuid::new_v4()));
        let workbook = build_xlsx_workbook_multi(&[XlsxWorksheetData {
            sheet_name: Some("Rows".to_string()),
            columns: vec!["id".to_string(), "name".to_string()],
            column_types: vec![],
            rows: vec![
                vec![serde_json::json!(1), serde_json::json!("Ada")],
                vec![serde_json::json!(2), serde_json::json!("Grace")],
            ],
        }])
        .unwrap();
        std::fs::write(&path, workbook).unwrap();
        let (sender, mut receiver) = tokio::sync::mpsc::channel(16);

        stream_xlsx_rows_to_channel(
            &path.to_string_lossy(),
            &TableImportParseOptions::default(),
            1,
            None,
            HashSet::new(),
            false,
            sender,
        )
        .unwrap();

        let mut messages = Vec::new();
        while let Some(message) = receiver.blocking_recv() {
            messages.push(message.unwrap());
        }
        assert!(
            matches!(messages.first(), Some(XlsxStreamMessage::Header(columns)) if columns == &vec!["id".to_string(), "name".to_string()])
        );
        let streamed_rows = messages
            .into_iter()
            .filter_map(|message| match message {
                XlsxStreamMessage::Rows(rows) => Some(rows),
                _ => None,
            })
            .flatten()
            .collect::<Vec<_>>();
        assert_eq!(streamed_rows.len(), 2);
        assert_eq!(streamed_rows[0], vec![serde_json::json!(1.0), serde_json::json!("Ada")]);
        assert_eq!(streamed_rows[1], vec![serde_json::json!(2.0), serde_json::json!("Grace")]);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn truncate_xlsx_with_malformed_tail_preserves_existing_rows() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open(&dir.path().join("storage.db")).await.unwrap();
        let state = AppState::new(storage);
        let connection_id = "xlsx-truncate-tail";
        let pool_key = format!("{connection_id}:session:import");
        let database_path = dir.path().join("target.db");
        let sqlite = crate::db::sqlite::connect_path_create_if_missing(database_path.to_str().unwrap()).await.unwrap();
        crate::db::sqlite::execute_query(
            &sqlite,
            "CREATE TABLE items (id INTEGER, name TEXT); INSERT INTO items VALUES (999, 'old')",
        )
        .await
        .unwrap();
        state.connections.write().await.insert(pool_key.clone(), PoolKind::Sqlite(sqlite.clone()));
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": connection_id,
            "name": "XLSX truncate tail test",
            "db_type": "sqlite",
            "host": "",
            "port": 0,
            "username": "",
            "password": "",
            "database": database_path.to_string_lossy()
        }))
        .unwrap();
        state.configs.write().await.insert(connection_id.to_string(), config);

        let sheet_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:B4"/>
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>name</t></is></c></row>
    <row r="2"><c r="A2"><v>1</v></c><c r="B2" t="inlineStr"><is><t>Ada</t></is></c></row>
    <row r="3"><c r="A3"><v>2</v></c><c r="B3" t="inlineStr"><is><t>Grace</t></is></c></row>
    <row r="4"><c r="A4"><v>3</v></c><c r="B4" t="inlineStr"><is><t>Linus</t></is></c></row>
  </broken>
</worksheet>"#;
        let xlsx_path = dir.path().join("malformed-tail.xlsx");
        std::fs::write(&xlsx_path, build_preview_test_xlsx(sheet_xml, None)).unwrap();
        let request = TableImportRequest {
            import_id: "malformed-tail".to_string(),
            connection_id: connection_id.to_string(),
            database: String::new(),
            schema: String::new(),
            table: "items".to_string(),
            file_path: xlsx_path.to_string_lossy().to_string(),
            source_ref: None,
            source_format: Some(TableImportSourceFormat::Excel),
            parse_options: TableImportParseOptions::default(),
            mappings: vec![
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
            ],
            mode: TableImportMode::Truncate,
            create_table: false,
            batch_size: 1,
            date_time_format: None,
            prepared_source: None,
            retain_source: false,
        };

        let error = import_table_file_core(
            &state,
            &request,
            &DatabaseType::Sqlite,
            &pool_key,
            |_| Box::pin(async { false }),
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(!error.is_empty());

        let rows =
            crate::db::sqlite::execute_query(&sqlite, "SELECT id, name FROM items ORDER BY id").await.unwrap().rows;
        assert_eq!(rows, vec![vec![serde_json::json!(999), serde_json::json!("old")]]);
    }

    #[tokio::test]
    async fn cancelling_xlsx_after_validation_prevents_non_transactional_truncate() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open(&dir.path().join("storage.db")).await.unwrap();
        let state = AppState::new(storage);
        let connection_id = "cancel-xlsx-after-validation";
        let pool_key = format!("{connection_id}:session:import");
        let database_path = dir.path().join("target.db");
        let sqlite = crate::db::sqlite::connect_path_create_if_missing(database_path.to_str().unwrap()).await.unwrap();
        crate::db::sqlite::execute_query(
            &sqlite,
            "CREATE TABLE items (id INTEGER, name TEXT); INSERT INTO items VALUES (999, 'old')",
        )
        .await
        .unwrap();
        state.connections.write().await.insert(pool_key.clone(), PoolKind::Sqlite(sqlite.clone()));
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": connection_id,
            "name": "Cancel XLSX validation test",
            "db_type": "sqlite",
            "host": "",
            "port": 0,
            "username": "",
            "password": "",
            "database": database_path.to_string_lossy()
        }))
        .unwrap();
        state.configs.write().await.insert(connection_id.to_string(), config);

        let sheet_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>name</t></is></c></row>
    <row r="2"><c r="A2"><v>1</v></c><c r="B2" t="inlineStr"><is><t>Ada</t></is></c></row>
  </sheetData>
</worksheet>"#;
        let xlsx_path = dir.path().join("cancel-after-validation.xlsx");
        std::fs::write(&xlsx_path, build_preview_test_xlsx(sheet_xml, None)).unwrap();
        let request = TableImportRequest {
            import_id: "cancel-xlsx-after-validation".to_string(),
            connection_id: connection_id.to_string(),
            database: String::new(),
            schema: String::new(),
            table: "items".to_string(),
            file_path: xlsx_path.to_string_lossy().to_string(),
            source_ref: None,
            source_format: Some(TableImportSourceFormat::Excel),
            parse_options: TableImportParseOptions::default(),
            mappings: vec![
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
            ],
            mode: TableImportMode::Truncate,
            create_table: false,
            batch_size: 1,
            date_time_format: None,
            prepared_source: None,
            retain_source: false,
        };

        let error = import_table_file_core(
            &state,
            &request,
            &DatabaseType::Mysql,
            &pool_key,
            |_| Box::pin(async { true }),
            |_| {},
        )
        .await
        .unwrap_err();
        assert_eq!(error, "Import cancelled");

        let rows = crate::db::sqlite::execute_query(&sqlite, "SELECT id, name FROM items").await.unwrap().rows;
        assert_eq!(rows, vec![vec![serde_json::json!(999), serde_json::json!("old")]]);
    }

    #[tokio::test]
    async fn cancelling_before_first_truncate_batch_preserves_existing_rows() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open(&dir.path().join("storage.db")).await.unwrap();
        let state = AppState::new(storage);
        let connection_id = "cancel-truncate-first-batch";
        let pool_key = format!("{connection_id}:session:import");
        let database_path = dir.path().join("target.db");
        let sqlite = crate::db::sqlite::connect_path_create_if_missing(database_path.to_str().unwrap()).await.unwrap();
        crate::db::sqlite::execute_query(
            &sqlite,
            "CREATE TABLE items (id INTEGER, name TEXT); INSERT INTO items VALUES (999, 'old')",
        )
        .await
        .unwrap();
        state.connections.write().await.insert(pool_key.clone(), PoolKind::Sqlite(sqlite.clone()));
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": connection_id,
            "name": "Cancel truncate first batch test",
            "db_type": "sqlite",
            "host": "",
            "port": 0,
            "username": "",
            "password": "",
            "database": database_path.to_string_lossy()
        }))
        .unwrap();
        state.configs.write().await.insert(connection_id.to_string(), config);
        let csv_path = dir.path().join("rows.csv");
        std::fs::write(&csv_path, b"id,name\n1,Ada\n2,Grace\n").unwrap();
        let request = TableImportRequest {
            import_id: "cancel-before-first-batch".to_string(),
            connection_id: connection_id.to_string(),
            database: String::new(),
            schema: String::new(),
            table: "items".to_string(),
            file_path: csv_path.to_string_lossy().to_string(),
            source_ref: None,
            source_format: Some(TableImportSourceFormat::Csv),
            parse_options: TableImportParseOptions::default(),
            mappings: vec![
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
            ],
            mode: TableImportMode::Truncate,
            create_table: false,
            batch_size: 1,
            date_time_format: None,
            prepared_source: None,
            retain_source: false,
        };

        let error = import_table_file_core(
            &state,
            &request,
            &DatabaseType::Sqlite,
            &pool_key,
            |_| Box::pin(async { true }),
            |_| {},
        )
        .await
        .unwrap_err();
        assert_eq!(error, "Import cancelled");

        let rows = crate::db::sqlite::execute_query(&sqlite, "SELECT id, name FROM items").await.unwrap().rows;
        assert_eq!(rows, vec![vec![serde_json::json!(999), serde_json::json!("old")]]);
    }

    #[test]
    fn streaming_excel_rows_preserve_offset_ranges_and_temporal_styles() {
        let path = std::env::temp_dir().join(format!("dbx-table-import-stream-offset-{}.xlsx", uuid::Uuid::new_v4()));
        std::fs::write(&path, build_styled_test_xlsx(false, &[("C3", 1, 45996.0), ("D3", 2, 45996.0)])).unwrap();
        let options = TableImportParseOptions { has_header: Some(false), ..TableImportParseOptions::default() };
        let (sender, mut receiver) = tokio::sync::mpsc::channel(16);

        stream_xlsx_rows_to_channel(
            &path.to_string_lossy(),
            &options,
            500,
            Some(vec!["column_1".to_string(), "column_2".to_string()]),
            HashSet::new(),
            false,
            sender,
        )
        .unwrap();

        let mut streamed_rows = Vec::new();
        while let Some(message) = receiver.blocking_recv() {
            if let XlsxStreamMessage::Rows(rows) = message.unwrap() {
                streamed_rows.extend(rows);
            }
        }
        assert_eq!(
            streamed_rows,
            vec![vec![serde_json::json!("2025-12-05"), serde_json::json!("2025-12-05 00:00:00")]]
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn streaming_excel_rows_preserve_numeric_display_text_for_text_targets() {
        let path = std::env::temp_dir().join(format!("dbx-table-import-stream-format-{}.xlsx", uuid::Uuid::new_v4()));
        std::fs::write(&path, build_styled_test_xlsx(false, &[("A1", 5, 10.0)])).unwrap();
        let options = TableImportParseOptions { has_header: Some(false), ..TableImportParseOptions::default() };
        let (sender, mut receiver) = tokio::sync::mpsc::channel(16);

        stream_xlsx_rows_to_channel(
            &path.to_string_lossy(),
            &options,
            500,
            Some(vec!["column_1".to_string()]),
            HashSet::from(["column_1".to_string()]),
            false,
            sender,
        )
        .unwrap();

        let mut streamed_rows = Vec::new();
        while let Some(message) = receiver.blocking_recv() {
            if let XlsxStreamMessage::Rows(rows) = message.unwrap() {
                streamed_rows.extend(rows);
            }
        }
        assert_eq!(streamed_rows, vec![vec![serde_json::json!("10.0")]]);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn streaming_excel_rows_preserve_custom_title_and_data_range() {
        let path = std::env::temp_dir().join(format!("dbx-table-import-stream-range-{}.xlsx", uuid::Uuid::new_v4()));
        let workbook = build_xlsx_workbook_multi(&[XlsxWorksheetData {
            sheet_name: Some("Rows".to_string()),
            columns: vec!["report".to_string(), "ignored".to_string()],
            column_types: vec![],
            rows: vec![
                vec![serde_json::json!("id"), serde_json::json!("name")],
                vec![serde_json::json!(1), serde_json::json!("Ada")],
                vec![serde_json::json!(2), serde_json::json!("Grace")],
                vec![serde_json::json!("summary"), serde_json::json!(2)],
            ],
        }])
        .unwrap();
        std::fs::write(&path, workbook).unwrap();
        let options = TableImportParseOptions {
            title_row: Some(2),
            data_start_row: Some(3),
            last_data_row: Some(4),
            ..TableImportParseOptions::default()
        };
        let (sender, mut receiver) = tokio::sync::mpsc::channel(16);

        stream_xlsx_rows_to_channel(&path.to_string_lossy(), &options, 500, None, HashSet::new(), false, sender)
            .unwrap();

        let mut columns = Vec::new();
        let mut streamed_rows = Vec::new();
        while let Some(message) = receiver.blocking_recv() {
            match message.unwrap() {
                XlsxStreamMessage::Header(header) => columns = header,
                XlsxStreamMessage::Rows(rows) => streamed_rows.extend(rows),
                _ => {}
            }
        }
        assert_eq!(columns, vec!["id", "name"]);
        assert_eq!(
            streamed_rows,
            vec![
                vec![serde_json::json!(1.0), serde_json::json!("Ada")],
                vec![serde_json::json!(2.0), serde_json::json!("Grace")],
            ]
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn streaming_excel_rows_reject_data_beyond_preview_columns() {
        let path = std::env::temp_dir().join(format!("dbx-table-import-stream-wide-{}.xlsx", uuid::Uuid::new_v4()));
        let sheet_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:B2"/>
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c></row>
    <row r="2"><c r="A2"><v>7</v></c><c r="B2" t="inlineStr"><is><t>unexpected</t></is></c></row>
  </sheetData>
</worksheet>"#;
        std::fs::write(&path, build_preview_test_xlsx(sheet_xml, None)).unwrap();
        let (sender, _receiver) = tokio::sync::mpsc::channel(16);

        let error = stream_xlsx_rows_to_channel(
            &path.to_string_lossy(),
            &TableImportParseOptions::default(),
            500,
            Some(vec!["id".to_string()]),
            HashSet::new(),
            false,
            sender,
        )
        .unwrap_err();

        assert!(error.contains("beyond the 1 columns confirmed by the preview"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn streaming_excel_rows_accept_sparse_empty_cells() {
        let path = std::env::temp_dir().join(format!("dbx-table-import-stream-sparse-{}.xlsx", uuid::Uuid::new_v4()));
        let sheet_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:C2"/>
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1"/><c r="C1" t="inlineStr"><is><t>name</t></is></c></row>
    <row r="2"><c r="A2"><v>7</v></c><c r="B2"/><c r="C2" t="inlineStr"><is><t>Ada</t></is></c></row>
  </sheetData>
</worksheet>"#;
        std::fs::write(&path, build_preview_test_xlsx(sheet_xml, None)).unwrap();
        let (sender, mut receiver) = tokio::sync::mpsc::channel(16);

        stream_xlsx_rows_to_channel(
            &path.to_string_lossy(),
            &TableImportParseOptions::default(),
            500,
            None,
            HashSet::new(),
            false,
            sender,
        )
        .unwrap();

        let mut streamed_rows = Vec::new();
        while let Some(message) = receiver.blocking_recv() {
            if let XlsxStreamMessage::Rows(rows) = message.unwrap() {
                streamed_rows.extend(rows);
            }
        }
        assert_eq!(
            streamed_rows,
            vec![vec![serde_json::json!(7.0), serde_json::Value::Null, serde_json::json!("Ada")]]
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn fast_excel_preview_matches_calamine_when_row_and_cell_references_are_omitted() {
        let path =
            std::env::temp_dir().join(format!("dbx-table-import-preview-implicit-{}.xlsx", uuid::Uuid::new_v4()));
        let sheet_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:B2"/>
  <sheetData>
    <row><c t="inlineStr"><is><t>id</t></is></c><c t="inlineStr"><is><t>name</t></is></c></row>
    <row><c><v>7</v></c><c t="inlineStr"><is><t>Ada</t></is></c></row>
  </sheetData>
</worksheet>"#;
        std::fs::write(&path, build_preview_test_xlsx(sheet_xml, None)).unwrap();

        let parsed =
            parse_xlsx_file_with_options(&path.to_string_lossy(), &TableImportParseOptions::default(), 10).unwrap();
        let (preview, _) =
            parse_xlsx_preview_file_with_options(&path.to_string_lossy(), &TableImportParseOptions::default(), 10)
                .unwrap();

        assert_eq!(preview.columns, parsed.columns);
        assert_eq!(preview.rows, parsed.rows);
        assert_eq!(preview.rows, vec![vec![serde_json::json!(7.0), serde_json::json!("Ada")]]);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn fast_excel_preview_advances_past_empty_cells_with_implicit_references() {
        let path =
            std::env::temp_dir().join(format!("dbx-table-import-preview-empty-cell-{}.xlsx", uuid::Uuid::new_v4()));
        let sheet_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:C2"/>
  <sheetData>
    <row><c t="inlineStr"><is><t>id</t></is></c><c/><c t="inlineStr"><is><t>name</t></is></c></row>
    <row><c><v>7</v></c><c/><c t="inlineStr"><is><t>Ada</t></is></c></row>
  </sheetData>
</worksheet>"#;
        std::fs::write(&path, build_preview_test_xlsx(sheet_xml, None)).unwrap();

        let parsed =
            parse_xlsx_file_with_options(&path.to_string_lossy(), &TableImportParseOptions::default(), 10).unwrap();
        let (preview, _) =
            parse_xlsx_preview_file_with_options(&path.to_string_lossy(), &TableImportParseOptions::default(), 10)
                .unwrap();

        assert_eq!(preview.columns, parsed.columns);
        assert_eq!(preview.rows, parsed.rows);
        assert_eq!(preview.columns, vec!["id", "column_2", "name"]);
        assert_eq!(preview.rows, vec![vec![serde_json::json!(7.0), serde_json::Value::Null, serde_json::json!("Ada")]]);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn fast_excel_preview_excludes_phonetic_runs_from_shared_and_inline_strings() {
        let path =
            std::env::temp_dir().join(format!("dbx-table-import-preview-phonetic-{}.xlsx", uuid::Uuid::new_v4()));
        let sheet_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:B2"/>
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>inline</t></is></c></row>
    <row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="inlineStr"><is><r><t>大阪</t></r><rPh sb="0" eb="2"><t>おおさか</t></rPh></is></c></row>
  </sheetData>
</worksheet>"#;
        let shared_strings_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">
  <si><t>shared</t></si>
  <si><r><t>東京</t></r><rPh sb="0" eb="2"><t>とうきょう</t></rPh></si>
</sst>"#;
        std::fs::write(&path, build_preview_test_xlsx(sheet_xml, Some(shared_strings_xml))).unwrap();

        let parsed =
            parse_xlsx_file_with_options(&path.to_string_lossy(), &TableImportParseOptions::default(), 10).unwrap();
        let (preview, _) =
            parse_xlsx_preview_file_with_options(&path.to_string_lossy(), &TableImportParseOptions::default(), 10)
                .unwrap();

        assert_eq!(preview.rows, parsed.rows);
        assert_eq!(preview.rows, vec![vec![serde_json::json!("東京"), serde_json::json!("大阪")]]);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn fast_excel_preview_ignores_stale_and_overwide_dimensions() {
        let path =
            std::env::temp_dir().join(format!("dbx-table-import-preview-dimension-{}.xlsx", uuid::Uuid::new_v4()));
        let sheet_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:XFD1048576"/>
  <sheetData>
    <row r="100"><c r="A100" t="inlineStr"><is><t>id</t></is></c><c r="B100" t="inlineStr"><is><t>name</t></is></c></row>
    <row r="101"><c r="A101"><v>8</v></c><c r="B101" t="inlineStr"><is><t>Grace</t></is></c></row>
  </sheetData>
</worksheet>"#;
        std::fs::write(&path, build_preview_test_xlsx(sheet_xml, None)).unwrap();

        let parsed =
            parse_xlsx_file_with_options(&path.to_string_lossy(), &TableImportParseOptions::default(), 10).unwrap();
        let (preview, _) =
            parse_xlsx_preview_file_with_options(&path.to_string_lossy(), &TableImportParseOptions::default(), 10)
                .unwrap();

        assert_eq!(preview.columns, parsed.columns);
        assert_eq!(preview.rows, parsed.rows);
        assert_eq!(preview.columns, vec!["id", "name"]);
        assert_eq!(preview.rows, vec![vec![serde_json::json!(8.0), serde_json::json!("Grace")]]);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn formats_unclassified_excel_datetimes_conservatively() {
        let date_cell = Data::DateTime(ExcelDateTime::new(45996.0, calamine::ExcelDateTimeType::DateTime, false));
        let time_cell = Data::DateTime(ExcelDateTime::new(0.5, calamine::ExcelDateTimeType::DateTime, false));
        let duration_cell = Data::DateTime(ExcelDateTime::new(2.5, calamine::ExcelDateTimeType::TimeDelta, false));

        let date_value = xlsx_cell_value(&date_cell);
        let time_value = xlsx_cell_value(&time_cell);

        assert_eq!(date_value, serde_json::json!("2025-12-05 00:00:00"));
        assert_eq!(time_value, serde_json::json!("0.5"));
        assert_eq!(xlsx_cell_value(&duration_cell), serde_json::json!("60:00:00"));
        assert_eq!(infer_value_type(&date_value), Some(ImportInferredType::Timestamp));
        assert_eq!(infer_value_type(&time_value), Some(ImportInferredType::Decimal));
    }

    #[test]
    fn renders_common_excel_numeric_display_formats() {
        let display = |value, format_code: &str| {
            xlsx_numeric_display_text(
                value,
                Some(&XlsxCellStyle { temporal_kind: None, number_format: Some(Arc::from(format_code)) }),
            )
        };

        assert_eq!(display(42.0, "00000"), "00042");
        assert_eq!(display(1234.5, "#,##0.00"), "1,234.50");
        assert_eq!(display(1234.0, "0.00E+00"), "1.23E+03");
        assert_eq!(display(0.125, "0.0%"), "12.5%");
        assert_eq!(display(1234.5, "[$€-407]#,##0.00"), "€1.234,50");
        assert_eq!(display(1234.5, "[$-407]#,##0.00"), "1.234,50");
        assert_eq!(display(1234.5, "[$-409]#,##0.00"), "1,234.50");
        assert_eq!(display(12.5, "["), "12.5");
    }

    #[test]
    fn formats_only_excel_columns_mapped_to_text_targets() {
        let path = std::env::temp_dir().join(format!("dbx-table-import-display-formats-{}.xlsx", uuid::Uuid::new_v4()));
        std::fs::write(
            &path,
            build_styled_test_xlsx(
                false,
                &[
                    ("A1", 7, 42.0),
                    ("B1", 8, 1234.5),
                    ("C1", 9, 1234.0),
                    ("D1", 10, 0.125),
                    ("E1", 11, 1234.5),
                    ("F1", 12, 1234.5),
                    ("G1", 6, 10.0),
                ],
            ),
        )
        .unwrap();
        let options = TableImportParseOptions { has_header: Some(false), ..TableImportParseOptions::default() };
        let text_source_columns = (1..=6).map(|index| format!("column_{index}")).collect::<HashSet<_>>();

        let parsed =
            parse_xlsx_file_with_options_and_text_columns(&path.to_string_lossy(), &options, 10, &text_source_columns)
                .unwrap();

        assert_eq!(
            parsed.rows[0],
            vec![
                serde_json::json!("00042"),
                serde_json::json!("1,234.50"),
                serde_json::json!("1.23E+03"),
                serde_json::json!("12.5%"),
                serde_json::json!("€1.234,50"),
                serde_json::json!("1,234.50"),
                serde_json::json!(10.0),
            ]
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn recognizes_supported_textual_import_target_types() {
        for data_type in [
            "FixedString(32)",
            "Nullable(FixedString(32))",
            "LowCardinality(String)",
            "sysname",
            "LONG",
            "LONG VARCHAR",
        ] {
            assert!(is_textual_import_target_type(data_type), "{data_type}");
        }
        for data_type in ["LONG RAW", "BIGINT", "Nullable(Float64)"] {
            assert!(!is_textual_import_target_type(data_type), "{data_type}");
        }
    }

    #[test]
    fn mysql_varchar_import_uses_excel_numeric_display_text() {
        let path = std::env::temp_dir().join(format!("dbx-table-import-number-format-{}.xlsx", uuid::Uuid::new_v4()));
        std::fs::write(
            &path,
            build_styled_test_xlsx(false, &[("A1", 0, 10_401_029_008.0), ("A2", 5, 10.0), ("A3", 6, 10.0)]),
        )
        .unwrap();
        let options = TableImportParseOptions { has_header: Some(false), ..TableImportParseOptions::default() };
        let numeric_data = parse_xlsx_file_with_options(&path.to_string_lossy(), &options, 10).unwrap();
        let data = parse_xlsx_file_with_options_and_text_columns(
            &path.to_string_lossy(),
            &options,
            10,
            &HashSet::from(["column_1".to_string()]),
        )
        .unwrap();

        assert_eq!(
            data.rows,
            vec![
                vec![serde_json::json!("10401029008")],
                vec![serde_json::json!("10.0")],
                vec![serde_json::json!("10.00")],
            ]
        );
        assert!(numeric_data.rows.iter().all(|row| row[0].as_f64().is_some()));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn borrowed_excel_cells_preserve_owned_cell_conversion_semantics() {
        let shared_string = DataRef::SharedString("Ada");
        let number = DataRef::Float(42.5);
        let date = DataRef::DateTime(ExcelDateTime::new(45996.0, calamine::ExcelDateTimeType::DateTime, false));

        assert_eq!(xlsx_cell_ref_label_with_temporal_kind(&shared_string, None), "Ada");
        assert_eq!(xlsx_cell_ref_value_with_temporal_kind(&shared_string, None), serde_json::json!("Ada"));
        assert_eq!(xlsx_cell_ref_value_with_temporal_kind(&number, None), serde_json::json!(42.5));
        assert_eq!(
            xlsx_cell_ref_value_with_temporal_kind(&date, Some(XlsxTemporalKind::Date)),
            serde_json::json!("2025-12-05")
        );
    }

    #[test]
    fn parses_excel_temporal_styles_before_type_inference() {
        let path = std::env::temp_dir().join(format!("dbx-table-import-temporal-{}.xlsx", uuid::Uuid::new_v4()));
        std::fs::write(
            &path,
            build_styled_test_xlsx(false, &[("A1", 1, 45996.0), ("B1", 2, 45996.0), ("C1", 3, 0.5), ("D1", 4, 1.5)]),
        )
        .unwrap();
        let options = TableImportParseOptions { has_header: Some(false), ..TableImportParseOptions::default() };

        let parsed = parse_xlsx_file_with_options(&path.to_string_lossy(), &options, 10).unwrap();
        let (preview, _) = parse_xlsx_preview_file_with_options(&path.to_string_lossy(), &options, 10).unwrap();

        assert_eq!(parsed.columns, vec!["column_1", "column_2", "column_3", "column_4"]);
        assert_eq!(
            parsed.rows,
            vec![vec![
                serde_json::json!("2025-12-05"),
                serde_json::json!("2025-12-05 00:00:00"),
                serde_json::json!("12:00:00"),
                serde_json::json!("36:00:00"),
            ]]
        );
        assert_eq!(infer_value_type(&parsed.rows[0][0]), Some(ImportInferredType::Date));
        assert_eq!(infer_value_type(&parsed.rows[0][1]), Some(ImportInferredType::Timestamp));
        assert_eq!(infer_value_type(&parsed.rows[0][2]), Some(ImportInferredType::Text));
        assert_eq!(infer_value_type(&parsed.rows[0][3]), Some(ImportInferredType::Text));
        assert_eq!(preview.rows, parsed.rows);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn parses_excel_temporal_styles_with_1904_date_system() {
        let path = std::env::temp_dir().join(format!("dbx-table-import-temporal-1904-{}.xlsx", uuid::Uuid::new_v4()));
        std::fs::write(&path, build_styled_test_xlsx(true, &[("A1", 1, 1.0)])).unwrap();
        let options = TableImportParseOptions { has_header: Some(false), ..TableImportParseOptions::default() };

        let parsed = parse_xlsx_file_with_options(&path.to_string_lossy(), &options, 10).unwrap();

        assert_eq!(parsed.rows, vec![vec![serde_json::json!("1904-01-02")]]);
        assert_eq!(infer_value_type(&parsed.rows[0][0]), Some(ImportInferredType::Date));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn parses_excel_temporal_styles_from_non_a1_used_range() {
        let path = std::env::temp_dir().join(format!("dbx-table-import-temporal-offset-{}.xlsx", uuid::Uuid::new_v4()));
        std::fs::write(&path, build_styled_test_xlsx(false, &[("C3", 1, 45996.0), ("D3", 2, 45996.0)])).unwrap();
        let options = TableImportParseOptions { has_header: Some(false), ..TableImportParseOptions::default() };

        let parsed = parse_xlsx_file_with_options(&path.to_string_lossy(), &options, 10).unwrap();
        let (preview, _) = parse_xlsx_preview_file_with_options(&path.to_string_lossy(), &options, 10).unwrap();

        assert_eq!(parsed.columns, vec!["column_1", "column_2"]);
        assert_eq!(parsed.rows, vec![vec![serde_json::json!("2025-12-05"), serde_json::json!("2025-12-05 00:00:00")]]);
        assert_eq!(infer_value_type(&parsed.rows[0][0]), Some(ImportInferredType::Date));
        assert_eq!(infer_value_type(&parsed.rows[0][1]), Some(ImportInferredType::Timestamp));
        assert_eq!(preview.rows, parsed.rows);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn parses_excel_with_custom_title_and_data_rows() {
        let path = std::env::temp_dir().join(format!("dbx-table-import-rows-{}.xlsx", uuid::Uuid::new_v4()));
        let workbook = build_xlsx_workbook_multi(&[XlsxWorksheetData {
            sheet_name: Some("Rows".to_string()),
            columns: vec!["report".to_string(), "ignored".to_string()],
            column_types: vec![],
            rows: vec![
                vec![serde_json::json!("id"), serde_json::json!("name")],
                vec![serde_json::json!(1), serde_json::json!("Ada")],
                vec![serde_json::json!(2), serde_json::json!("Grace")],
                vec![serde_json::json!("summary"), serde_json::json!(2)],
            ],
        }])
        .unwrap();
        std::fs::write(&path, workbook).unwrap();
        let options = TableImportParseOptions {
            title_row: Some(2),
            data_start_row: Some(3),
            last_data_row: Some(4),
            ..TableImportParseOptions::default()
        };
        let parsed = parse_xlsx_file_with_options(&path.to_string_lossy(), &options, 10).unwrap();
        let (preview, _) = parse_xlsx_preview_file_with_options(&path.to_string_lossy(), &options, 10).unwrap();

        assert_eq!(parsed.columns, vec!["id", "name"]);
        assert_eq!(parsed.total_rows, 2);
        assert_eq!(parsed.rows[0], vec![serde_json::json!(1.0), serde_json::json!("Ada")]);
        assert_eq!(parsed.rows[1], vec![serde_json::json!(2.0), serde_json::json!("Grace")]);
        assert_eq!(preview.rows, parsed.rows);
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
            effective_encoding: None,
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
        let data = ParsedImportFile {
            columns: vec!["id".to_string()],
            rows: vec![vec![serde_json::json!(1)]],
            total_rows: 1,
            effective_encoding: None,
        };
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
            effective_encoding: None,
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
            effective_encoding: None,
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
            effective_encoding: None,
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
            effective_encoding: None,
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
    fn iris_import_uses_single_row_values_statements() {
        let mappings = vec![TableImportColumnMapping {
            source_column: "id".to_string(),
            target_column: "id".to_string(),
            target_data_type: None,
        }];
        let data = ParsedImportFile {
            columns: vec!["id".to_string()],
            rows: vec![vec![serde_json::json!(1)], vec![serde_json::json!(2)]],
            total_rows: 2,
            effective_encoding: None,
        };

        let batches =
            build_import_insert_batches(&data, &mappings, &[], "items", "SQLUSER", &DatabaseType::Iris, 100).unwrap();

        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].sql, "INSERT INTO \"SQLUSER\".\"items\" (\"id\") VALUES\n(1)");
        assert_eq!(batches[0].row_count, 1);
        assert_eq!(batches[1].sql, "INSERT INTO \"SQLUSER\".\"items\" (\"id\") VALUES\n(2)");
        assert_eq!(batches[1].row_count, 1);
    }

    #[test]
    fn import_batch_row_limits_match_database_dialects() {
        assert_eq!(effective_import_batch_size(&DatabaseType::Oracle, 1000), 500);
        assert_eq!(effective_import_batch_size(&DatabaseType::OceanbaseOracle, 1000), 1);
        assert_eq!(effective_import_batch_size(&DatabaseType::Iris, 1000), 1);
        assert_eq!(effective_import_batch_size(&DatabaseType::CloudflareD1, 1000), 100);
        assert_eq!(effective_import_batch_size(&DatabaseType::Postgres, 1000), 1000);
        assert_eq!(effective_import_batch_size(&DatabaseType::Mysql, 1000), 1000);
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

    #[test]
    fn postgres_copy_text_batch_preserves_nulls_and_control_characters() {
        let plan = CompiledImportPlan {
            mapped_source_indexes: vec![0, 1],
            target_columns: vec!["id".to_string(), "payload".to_string()],
            column_types: vec![Some("integer".to_string()), Some("text".to_string())],
        };
        let (sql, data) = build_postgres_copy_text_batch(
            &[
                vec![serde_json::json!(1), serde_json::json!("a\\b\tline\nnext\u{000B}")],
                vec![serde_json::Value::Null, serde_json::json!("\\N")],
            ],
            &plan,
            "items",
            "public",
            None,
        )
        .unwrap();

        assert_eq!(sql, "COPY \"public\".\"items\" (\"id\", \"payload\") FROM STDIN WITH (FORMAT text)");
        assert_eq!(String::from_utf8(data).unwrap(), "1\ta\\\\b\\tline\\nnext\\v\n\\N\t\\\\N\n");
    }

    #[test]
    fn postgres_copy_eligibility_requires_plain_table_without_rls_or_rules() {
        assert_eq!(
            postgres_copy_eligibility_sql("items", "public"),
            "SELECT NOT c.relrowsecurity AND NOT c.relhasrules AS copy_eligible FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'items' AND c.relkind IN ('r', 'p') LIMIT 1"
        );
        assert!(postgres_copy_eligibility_sql("items", "").contains("n.nspname = current_schema()"));
    }

    #[test]
    fn postgres_truncate_first_batch_uses_transaction_without_copy() {
        let policy = import_batch_execution_policy(&TableImportMode::Truncate, true, &DatabaseType::Postgres);

        assert!(policy.transactional);
        assert!(policy.include_truncate);
        assert!(!policy.allow_postgres_copy);
    }

    #[test]
    fn postgres_truncate_later_batches_are_transactional_and_allow_copy() {
        let policy = import_batch_execution_policy(&TableImportMode::Truncate, false, &DatabaseType::Postgres);

        assert!(policy.transactional);
        assert!(!policy.include_truncate);
        assert!(policy.allow_postgres_copy);
    }

    #[test]
    fn append_batches_keep_the_existing_independent_execution_path() {
        let policy = import_batch_execution_policy(&TableImportMode::Append, true, &DatabaseType::Postgres);

        assert!(!policy.transactional);
        assert!(!policy.include_truncate);
        assert!(policy.allow_postgres_copy);
    }

    #[test]
    fn truncate_keeps_native_non_transactional_drivers_on_the_existing_path() {
        let policy = import_batch_execution_policy(&TableImportMode::Truncate, false, &DatabaseType::ClickHouse);

        assert!(!policy.transactional);
        assert!(!policy.include_truncate);
        assert!(!policy.allow_postgres_copy);
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
    fn oracle_import_insert_batches_use_insert_all() {
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
            effective_encoding: None,
        };

        let batches =
            build_import_insert_batches(&data, &mappings, &[], "users", "HR", &DatabaseType::Oracle, 500).unwrap();

        assert_eq!(batches, vec![ImportSqlBatch {
            sql: "INSERT ALL\nINTO \"HR\".\"users\" (\"id\", \"name\") VALUES (1, 'Ada')\nINTO \"HR\".\"users\" (\"id\", \"name\") VALUES (2, 'Grace')\nINTO \"HR\".\"users\" (\"id\", \"name\") VALUES (3, NULL)\nSELECT 1 FROM dual".to_string(),
            row_count: 3,
        }]);
    }

    #[test]
    fn import_insert_batches_split_long_rows_by_sql_size() {
        let mappings = vec![TableImportColumnMapping {
            source_column: "payload".to_string(),
            target_column: "payload".to_string(),
            target_data_type: None,
        }];
        let data = ParsedImportFile {
            columns: vec!["payload".to_string()],
            rows: (0..4).map(|index| vec![serde_json::json!(format!("{index}{}", "x".repeat(180 * 1024)))]).collect(),
            total_rows: 4,
            effective_encoding: None,
        };

        let batches =
            build_import_insert_batches(&data, &mappings, &[], "events", "public", &DatabaseType::Postgres, 500)
                .unwrap();

        assert!(batches.len() > 1);
        assert_eq!(batches.iter().map(|batch| batch.row_count).sum::<usize>(), 4);
        assert!(batches.iter().all(|batch| batch.sql.len() <= 512 * 1024));
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
            effective_encoding: None,
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
    fn import_insert_batches_normalize_oracle_unpadded_slash_dates() {
        let mappings = vec![TableImportColumnMapping {
            source_column: "created_at".to_string(),
            target_column: "created_at".to_string(),
            target_data_type: None,
        }];
        let data = ParsedImportFile {
            columns: vec!["created_at".to_string()],
            rows: vec![vec![serde_json::json!("2024/2/25 13:02:15")]],
            total_rows: 1,
            effective_encoding: None,
        };

        let batches = build_import_insert_batches(
            &data,
            &mappings,
            &[("created_at".to_string(), "DATE".to_string())],
            "events",
            "APP",
            &DatabaseType::Oracle,
            500,
        )
        .unwrap();

        assert_eq!(
            batches[0].sql,
            "INSERT INTO \"APP\".\"events\" (\"created_at\") VALUES\n(TO_DATE('2024-02-25 13:02:15', 'YYYY-MM-DD HH24:MI:SS'))"
        );
    }

    #[test]
    fn import_insert_batch_normalizes_oracle_date_and_timestamp_columns() {
        let mappings = vec![
            TableImportColumnMapping {
                source_column: "event_id".to_string(),
                target_column: "EVENT_ID".to_string(),
                target_data_type: None,
            },
            TableImportColumnMapping {
                source_column: "created_at".to_string(),
                target_column: "CREATED_AT".to_string(),
                target_data_type: None,
            },
            TableImportColumnMapping {
                source_column: "updated_at".to_string(),
                target_column: "UPDATED_AT".to_string(),
                target_data_type: None,
            },
        ];
        let rows = vec![vec![
            serde_json::json!(1),
            serde_json::json!("2024/2/25 13:02:15"),
            serde_json::json!("2024/2/25 14:03:16"),
        ]];

        let batch = build_import_insert_batch_from_rows_with_format(
            &rows,
            &["event_id".to_string(), "created_at".to_string(), "updated_at".to_string()],
            &mappings,
            &[
                ("EVENT_ID".to_string(), "NUMBER".to_string()),
                ("CREATED_AT".to_string(), "DATE".to_string()),
                ("UPDATED_AT".to_string(), "TIMESTAMP(6)".to_string()),
            ],
            "EVENTS",
            "APP",
            &DatabaseType::Oracle,
            Some("YYYY/M/D HH:mm:ss"),
        )
        .unwrap()
        .unwrap();

        assert_eq!(
            batch.sql,
            "INSERT INTO \"APP\".\"EVENTS\" (\"EVENT_ID\", \"CREATED_AT\", \"UPDATED_AT\") VALUES\n(1, TO_DATE('2024-02-25 13:02:15', 'YYYY-MM-DD HH24:MI:SS'), TO_TIMESTAMP('2024-02-25 14:03:16', 'YYYY-MM-DD HH24:MI:SS'))"
        );
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
            effective_encoding: None,
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
