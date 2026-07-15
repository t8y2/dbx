use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read as IoRead, Seek, SeekFrom};
use std::path::Path;

use calamine::{open_workbook_auto, Data, ExcelDateTime, Reader as CalamineReader};
use chrono::{DateTime, NaiveDate, NaiveDateTime};
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader as XmlReader;
use serde::{Deserialize, Serialize};

use crate::connection::{task_client_session_id, AppState};
use crate::models::connection::DatabaseType;
use crate::transfer::{
    execute_on_pool, generate_insert_typed, get_columns_for_transfer, qualified_table, quote_identifier,
};

pub const DEFAULT_PREVIEW_LIMIT: usize = 50;
pub const DEFAULT_BATCH_SIZE: usize = 500;
pub const CREATE_TABLE_INFERENCE_ROWS: usize = 100;
pub const MAX_NON_STREAMING_IMPORT_BYTES: u64 = 100 * 1024 * 1024;

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

struct StrictTranscodingReader<R> {
    reader: R,
    decoder: encoding_rs::Decoder,
    encoding: TableImportTextEncoding,
    pending_input: Vec<u8>,
    pending_output: Vec<u8>,
    output_offset: usize,
    reached_eof: bool,
    finished: bool,
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
        })
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
            let mut output = vec![0u8; output_capacity];
            let (result, read, written) =
                self.decoder.decode_to_utf8_without_replacement(&self.pending_input, &mut output, self.reached_eof);
            self.pending_input.drain(..read);
            output.truncate(written);
            self.pending_output = output;

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

fn auto_detect_text_encoding_from_file(path: &str) -> Result<(TableImportTextEncoding, usize), String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut prefix = [0u8; 3];
    let prefix_len = file.read(&mut prefix).map_err(|error| error.to_string())?;
    if let Some(detected) = bom_text_encoding(&prefix[..prefix_len]) {
        return Ok(detected);
    }

    for encoding in [TableImportTextEncoding::Utf8, TableImportTextEncoding::Gbk] {
        let file = File::open(path).map_err(|error| error.to_string())?;
        if reader_is_valid_for_encoding(file, encoding)? {
            return Ok((encoding, 0));
        }
    }
    Err("Could not detect text encoding; select UTF-8, GBK / GB18030, or UTF-16 manually".to_string())
}

fn resolve_text_encoding_from_file(
    path: &str,
    requested: Option<TableImportTextEncoding>,
) -> Result<(TableImportTextEncoding, usize), String> {
    let requested = requested.unwrap_or(TableImportTextEncoding::Auto);
    if requested == TableImportTextEncoding::Auto {
        return auto_detect_text_encoding_from_file(path);
    }

    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut prefix = [0u8; 3];
    let prefix_len = file.read(&mut prefix).map_err(|error| error.to_string())?;
    Ok((requested, matching_bom_len(&prefix[..prefix_len], requested)))
}

fn open_delimited_csv_reader(
    path: &str,
    source_format: TableImportSourceFormat,
    options: &TableImportParseOptions,
) -> Result<(csv::Reader<StrictTranscodingReader<File>>, DelimitedParseConfig, TableImportTextEncoding), String> {
    let config = effective_delimited_config(source_format, options)?;
    let (encoding, bom_len) = resolve_text_encoding_from_file(path, options.encoding)?;
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
    let (reader, config, encoding) = open_delimited_csv_reader(path, source_format, options)?;
    parse_csv_reader(reader, config, preview_limit, encoding)
}

fn parse_csv_reader<R: IoRead>(
    mut reader: csv::Reader<R>,
    config: DelimitedParseConfig,
    preview_limit: usize,
    effective_encoding: TableImportTextEncoding,
) -> Result<ParsedImportFile, String> {
    let mut rows = Vec::new();
    let mut total_rows = 0;
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
        total_rows += 1;
        if rows.len() >= preview_limit {
            continue;
        }
        rows.push(delimited_record_to_row(&record, columns.len(), config));
    }
    if columns.is_empty() {
        return Err("Import file has no columns in the selected row range".to_string());
    }
    if total_rows == 0 {
        return Err("Import file has no data rows in the selected row range".to_string());
    }
    Ok(ParsedImportFile { columns, rows, total_rows, effective_encoding: Some(effective_encoding) })
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

pub fn xlsx_sheet_names(path: &str) -> Result<Vec<String>, String> {
    let workbook = open_workbook_auto(path).map_err(|e| e.to_string())?;
    Ok(workbook.sheet_names().to_vec())
}

fn xml_local_name_eq(name: &[u8], expected: &[u8]) -> bool {
    name.rsplit(|byte| *byte == b':').next().is_some_and(|local| local.eq_ignore_ascii_case(expected))
}

fn xml_attr_value(reader: &XmlReader<&[u8]>, element: &BytesStart<'_>, key: &[u8]) -> Option<String> {
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

fn parse_xlsx_style_temporal_kinds(styles_xml: &str) -> Vec<Option<XlsxTemporalKind>> {
    let mut reader = XmlReader::from_str(styles_xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut custom_formats = HashMap::<u16, XlsxTemporalKind>::new();
    let mut style_kinds = Vec::new();
    let mut in_cell_xfs = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(element)) | Ok(Event::Empty(element))
                if xml_local_name_eq(element.name().as_ref(), b"numFmt") =>
            {
                let id = xml_attr_value(&reader, &element, b"numFmtId").and_then(|value| value.parse::<u16>().ok());
                let format_code = xml_attr_value(&reader, &element, b"formatCode");
                if let (Some(id), Some(format_code)) = (id, format_code) {
                    if let Some(kind) = xlsx_temporal_kind_from_format_code(&format_code) {
                        custom_formats.insert(id, kind);
                    }
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
                let kind = xml_attr_value(&reader, &element, b"numFmtId")
                    .and_then(|value| value.parse::<u16>().ok())
                    .and_then(|id| custom_formats.get(&id).copied().or_else(|| xlsx_builtin_temporal_kind(id)));
                style_kinds.push(kind);
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    style_kinds
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

fn parse_xlsx_sheet_temporal_kinds(
    sheet_xml: &str,
    style_kinds: &[Option<XlsxTemporalKind>],
) -> HashMap<(usize, usize), XlsxTemporalKind> {
    let mut reader = XmlReader::from_str(sheet_xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut kinds = HashMap::new();
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
                let Some(kind) = style_kinds.get(style_id).copied().flatten() else {
                    buf.clear();
                    continue;
                };
                if let Some(position) =
                    xml_attr_value(&reader, &element, b"r").and_then(|reference| xlsx_cell_ref_position(&reference))
                {
                    kinds.insert(position, kind);
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    kinds
}

fn read_xlsx_zip_text(zip: &mut zip::ZipArchive<File>, path: &str) -> Result<String, String> {
    let mut file = zip.by_name(path).map_err(|err| err.to_string())?;
    let mut content = String::new();
    file.read_to_string(&mut content).map_err(|err| err.to_string())?;
    Ok(content)
}

fn xlsx_temporal_cell_kinds(path: &str, sheet_name: &str) -> Result<HashMap<(usize, usize), XlsxTemporalKind>, String> {
    let file = File::open(path).map_err(|err| err.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|err| err.to_string())?;
    let styles_xml = read_xlsx_zip_text(&mut zip, "xl/styles.xml").unwrap_or_default();
    let style_kinds = parse_xlsx_style_temporal_kinds(&styles_xml);
    if style_kinds.is_empty() {
        return Ok(HashMap::new());
    }

    let workbook_xml = read_xlsx_zip_text(&mut zip, "xl/workbook.xml")?;
    let rels_xml = read_xlsx_zip_text(&mut zip, "xl/_rels/workbook.xml.rels").unwrap_or_default();
    let Some(sheet_path) = xlsx_sheet_path_for_name(&workbook_xml, &rels_xml, sheet_name) else {
        return Ok(HashMap::new());
    };
    let sheet_xml = read_xlsx_zip_text(&mut zip, &sheet_path)?;
    Ok(parse_xlsx_sheet_temporal_kinds(&sheet_xml, &style_kinds))
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
    let temporal_cell_kinds = xlsx_temporal_cell_kinds(path, &sheet_name).unwrap_or_default();
    let range = workbook.worksheet_range(&sheet_name).map_err(|e| e.to_string())?;
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
                        &xlsx_cell_label_with_temporal_kind(cell, temporal_cell_kinds.get(&cell_position).copied()),
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
        for index in 0..columns.len() {
            let cell_position = (range_start_row + row_number, range_start_column + index + 1);
            row.push(
                source_row
                    .get(index)
                    .map(|cell| {
                        xlsx_cell_value_with_temporal_kind(cell, temporal_cell_kinds.get(&cell_position).copied())
                    })
                    .unwrap_or(serde_json::Value::Null),
            );
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

fn supports_multi_row_insert_values(db_type: &DatabaseType) -> bool {
    !matches!(db_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle | DatabaseType::Iris)
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
    if *db_type == DatabaseType::CloudflareD1 {
        return crate::db::cloudflare_d1::build_import_insert_batches(
            &data.rows,
            &data.columns,
            mappings,
            target_column_types,
            table,
            schema,
            batch_size.clamp(1, 100),
        );
    }
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
    // Drivers without multi-row VALUES support still benefit from the agent
    // batching the generated single-row statements during execution.
    let batch_size = if supports_multi_row_insert_values(db_type) { batch_size.max(1) } else { 1 };
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

        let mut streaming_options = request.parse_options.clone();
        if streaming_options.encoding.unwrap_or(TableImportTextEncoding::Auto) == TableImportTextEncoding::Auto {
            streaming_options.encoding = parsed.effective_encoding;
        }
        let (mut reader, config, _) =
            match open_delimited_csv_reader(&request.file_path, source_format, &streaming_options) {
                Ok(result) => result,
                Err(error) => {
                    return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, error));
                }
            };
        let (columns, first_record) = match delimited_columns_and_first_record(&mut reader, config) {
            Ok(result) => result,
            Err(error) => return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, error)),
        };
        let effective_batch_size = match db_type {
            DatabaseType::Oracle | DatabaseType::OceanbaseOracle => 1,
            DatabaseType::CloudflareD1 => batch_size.clamp(1, 100),
            _ => batch_size.max(1),
        };
        let mut rows_imported = 0;
        let mut pending_rows: Vec<Vec<serde_json::Value>> = Vec::with_capacity(effective_batch_size);

        if let Some(record) = first_record {
            pending_rows.push(delimited_record_to_row(&record, columns.len(), config));
        }

        let mut source_row_number = config.row_range.data_start_row;
        for record in reader.records() {
            source_row_number += 1;
            if config.row_range.last_data_row.is_some_and(|last| source_row_number > last) {
                break;
            }
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
    use std::io::{Cursor, Write};

    fn write_xlsx_test_entry<W: Write + std::io::Seek>(zip: &mut zip::ZipWriter<W>, path: &str, content: &str) {
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        zip.start_file(path, options).unwrap();
        zip.write_all(content.as_bytes()).unwrap();
    }

    fn build_temporal_test_xlsx(date1904: bool, cells: &[(&str, usize, f64)]) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(cursor);
        let workbook_pr = if date1904 { r#"<workbookPr date1904="1"/>"# } else { "" };
        let mut rows = std::collections::BTreeMap::<usize, String>::new();
        for (reference, style_id, value) in cells {
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
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="4">
    <numFmt numFmtId="164" formatCode="yyyy-mm-dd"/>
    <numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm:ss"/>
    <numFmt numFmtId="166" formatCode="hh:mm:ss"/>
    <numFmt numFmtId="167" formatCode="[h]:mm:ss"/>
  </numFmts>
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="5">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>"#,
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
        assert_eq!(preview.rows[0], vec![serde_json::json!("1"), serde_json::json!("北京")]);
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
    fn parses_excel_temporal_styles_before_type_inference() {
        let path = std::env::temp_dir().join(format!("dbx-table-import-temporal-{}.xlsx", uuid::Uuid::new_v4()));
        std::fs::write(
            &path,
            build_temporal_test_xlsx(false, &[("A1", 1, 45996.0), ("B1", 2, 45996.0), ("C1", 3, 0.5), ("D1", 4, 1.5)]),
        )
        .unwrap();
        let options = TableImportParseOptions { has_header: Some(false), ..TableImportParseOptions::default() };

        let parsed = parse_xlsx_file_with_options(&path.to_string_lossy(), &options, 10).unwrap();

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
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn parses_excel_temporal_styles_with_1904_date_system() {
        let path = std::env::temp_dir().join(format!("dbx-table-import-temporal-1904-{}.xlsx", uuid::Uuid::new_v4()));
        std::fs::write(&path, build_temporal_test_xlsx(true, &[("A1", 1, 1.0)])).unwrap();
        let options = TableImportParseOptions { has_header: Some(false), ..TableImportParseOptions::default() };

        let parsed = parse_xlsx_file_with_options(&path.to_string_lossy(), &options, 10).unwrap();

        assert_eq!(parsed.rows, vec![vec![serde_json::json!("1904-01-02")]]);
        assert_eq!(infer_value_type(&parsed.rows[0][0]), Some(ImportInferredType::Date));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn parses_excel_temporal_styles_from_non_a1_used_range() {
        let path = std::env::temp_dir().join(format!("dbx-table-import-temporal-offset-{}.xlsx", uuid::Uuid::new_v4()));
        std::fs::write(&path, build_temporal_test_xlsx(false, &[("C3", 1, 45996.0), ("D3", 2, 45996.0)])).unwrap();
        let options = TableImportParseOptions { has_header: Some(false), ..TableImportParseOptions::default() };

        let parsed = parse_xlsx_file_with_options(&path.to_string_lossy(), &options, 10).unwrap();

        assert_eq!(parsed.columns, vec!["column_1", "column_2"]);
        assert_eq!(parsed.rows, vec![vec![serde_json::json!("2025-12-05"), serde_json::json!("2025-12-05 00:00:00")]]);
        assert_eq!(infer_value_type(&parsed.rows[0][0]), Some(ImportInferredType::Date));
        assert_eq!(infer_value_type(&parsed.rows[0][1]), Some(ImportInferredType::Timestamp));
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

        assert_eq!(parsed.columns, vec!["id", "name"]);
        assert_eq!(parsed.total_rows, 2);
        assert_eq!(parsed.rows[0], vec![serde_json::json!(1.0), serde_json::json!("Ada")]);
        assert_eq!(parsed.rows[1], vec![serde_json::json!(2.0), serde_json::json!("Grace")]);
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
    fn multi_row_insert_values_support_matches_database_dialects() {
        assert!(!supports_multi_row_insert_values(&DatabaseType::Oracle));
        assert!(!supports_multi_row_insert_values(&DatabaseType::OceanbaseOracle));
        assert!(!supports_multi_row_insert_values(&DatabaseType::Iris));
        assert!(supports_multi_row_insert_values(&DatabaseType::Postgres));
        assert!(supports_multi_row_insert_values(&DatabaseType::Mysql));
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
            effective_encoding: None,
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
