//! TXT/CSV derivation for the SQL file failure log (dbx#11619).
//!
//! Execution writes the log as JSONL (see [`super::failure_log`]); both the file
//! export and the clipboard copy read it back through here, so what a user
//! copies can never drift from what they export.
//!
//! Derivation is **single-pass and synchronous**: a log can reach 200MB, so it is
//! streamed line by line straight into the destination and never buffered whole.
//! Callers on the async runtime must run this in `spawn_blocking`.
//!
//! Text is deliberately English (headers, column names, footer). The backend has
//! no locale, and these files are handed to DBAs and spreadsheets; the localized
//! wording lives in the UI around the export button.

use std::collections::HashSet;
use std::fmt;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

use dbx_formats::csv_export::{push_formula_guard, write_csv_text_row, CsvQuoteMode};
use serde::Deserialize;

/// Clipboard guard: pasting multiple megabytes of SQL into a clipboard is
/// already unhelpful, so anything larger must go through the file export.
pub const SQL_FILE_FAILURE_LOG_CLIPBOARD_MAX_BYTES: u64 = 5 * 1024 * 1024;

const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";
/// RFC4180 record separator. The shared `write_csv_text_row` helper only emits
/// the values, so the terminator is ours (the repo's result exports use LF, but
/// the failure log is spec'd as CRLF for spreadsheet tooling).
const CSV_RECORD_SEPARATOR: &[u8] = b"\r\n";
const CSV_COLUMNS: [&str; 5] = ["file", "statement_index", "error", "statement", "truncated"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SqlFileFailureLogFormat {
    Txt,
    Csv,
}

impl SqlFileFailureLogFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Txt => "txt",
            Self::Csv => "csv",
        }
    }

    /// Accepts the values used by the desktop command and the Web query string.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "txt" | "log" | "text" => Some(Self::Txt),
            "csv" => Some(Self::Csv),
            _ => None,
        }
    }
}

/// Stable identity of one failure, used by "copy selected" to name a subset.
/// `statement_index` is the global counter the UI shows (`#644`), which is what
/// makes a selection survive a re-read of the log. Serializable because both the
/// desktop command and the Web route receive it from the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileFailureLogKey {
    pub file_index: usize,
    pub statement_index: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SqlFileFailureLogDeriveSummary {
    pub records: u64,
    pub bytes: u64,
    pub sql_truncated: u64,
    pub omitted_failures: u64,
    pub log_truncated: bool,
    /// False when the run never wrote its closing summary record (cancelled, or
    /// the app stopped): the derived text then says so rather than inventing
    /// counters.
    pub run_summary_present: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SqlFileFailureLogDeriveError {
    /// The requested text exceeds the caller's cap (clipboard path).
    TooLarge {
        limit: u64,
    },
    /// A complete line in the middle of the log is not valid JSON. Exporting a
    /// silently partial list would be worse than failing.
    Corrupt {
        line: usize,
    },
    Io(String),
}

impl fmt::Display for SqlFileFailureLogDeriveError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLarge { limit } => write!(formatter, "Failure log text exceeds {limit} bytes"),
            Self::Corrupt { line } => write!(formatter, "Failure log line {line} is not valid JSON"),
            Self::Io(message) => write!(formatter, "Failure log read failed: {message}"),
        }
    }
}

pub type SqlFileFailureLogDeriveResult<T> = Result<T, SqlFileFailureLogDeriveError>;

/// Streams the derived text of `jsonl_path` into `destination`.
pub fn export_sql_file_failure_log(
    jsonl_path: &Path,
    destination: &Path,
    format: SqlFileFailureLogFormat,
    selection: Option<&HashSet<SqlFileFailureLogKey>>,
) -> SqlFileFailureLogDeriveResult<SqlFileFailureLogDeriveSummary> {
    let file =
        std::fs::File::create(destination).map_err(|error| SqlFileFailureLogDeriveError::Io(error.to_string()))?;
    let mut writer = std::io::BufWriter::new(file);
    let summary = derive_sql_file_failure_log(jsonl_path, &mut writer, format, selection, None)?;
    writer.flush().map_err(|error| SqlFileFailureLogDeriveError::Io(error.to_string()))?;
    Ok(summary)
}

/// Builds the text for the clipboard, refusing anything over `max_bytes`.
pub fn sql_file_failure_log_text(
    jsonl_path: &Path,
    format: SqlFileFailureLogFormat,
    selection: Option<&HashSet<SqlFileFailureLogKey>>,
    max_bytes: u64,
) -> SqlFileFailureLogDeriveResult<String> {
    let mut buffer: Vec<u8> = Vec::new();
    derive_sql_file_failure_log(jsonl_path, &mut buffer, format, selection, Some(max_bytes))?;
    let text = String::from_utf8(buffer).map_err(|error| SqlFileFailureLogDeriveError::Io(error.to_string()))?;
    Ok(text)
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum LogLine {
    #[serde(rename = "meta")]
    Meta(MetaLine),
    #[serde(rename = "failure")]
    Failure(FailureLine),
    #[serde(rename = "summary")]
    Summary(SummaryLine),
    /// Forward compatibility: a future record type must not break today's reader.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetaLine {
    execution_id: String,
    connection_id: String,
    #[serde(default)]
    connection_name: Option<String>,
    database: String,
    #[serde(default)]
    schema: Option<String>,
    started_at_ms: i64,
    #[serde(default)]
    files: Vec<MetaFile>,
    max_statement_bytes: usize,
    max_total_bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetaFile {
    index: usize,
    name: String,
    path: String,
    #[serde(default)]
    size_bytes: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FailureLine {
    file_index: usize,
    #[serde(default)]
    file_name: Option<String>,
    file_statement_index: usize,
    statement_index: usize,
    sql: String,
    #[serde(default)]
    sql_truncated: bool,
    error: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SummaryLine {
    success_count: usize,
    failure_count: usize,
    affected_rows: u64,
    elapsed_ms: u64,
    failed_statements_logged: u64,
    omitted_failures: u64,
    truncated_statements: u64,
    log_truncated: bool,
    cancelled: bool,
    log_status: String,
    #[serde(default)]
    log_status_reason: Option<String>,
}

/// Wraps every write so byte counting and the optional cap live in one place.
struct CountingWriter<'a> {
    destination: &'a mut dyn Write,
    bytes: u64,
    cap: Option<u64>,
}

impl CountingWriter<'_> {
    fn write_all(&mut self, bytes: &[u8]) -> SqlFileFailureLogDeriveResult<()> {
        if let Some(cap) = self.cap {
            if self.bytes + bytes.len() as u64 > cap {
                return Err(SqlFileFailureLogDeriveError::TooLarge { limit: cap });
            }
        }
        self.destination.write_all(bytes).map_err(|error| SqlFileFailureLogDeriveError::Io(error.to_string()))?;
        self.bytes += bytes.len() as u64;
        Ok(())
    }
}

fn derive_sql_file_failure_log(
    jsonl_path: &Path,
    destination: &mut dyn Write,
    format: SqlFileFailureLogFormat,
    selection: Option<&HashSet<SqlFileFailureLogKey>>,
    cap: Option<u64>,
) -> SqlFileFailureLogDeriveResult<SqlFileFailureLogDeriveSummary> {
    let file = std::fs::File::open(jsonl_path).map_err(|error| SqlFileFailureLogDeriveError::Io(error.to_string()))?;
    let mut reader = BufReader::new(file);
    let mut writer = CountingWriter { destination, bytes: 0, cap };
    let mut summary = SqlFileFailureLogDeriveSummary::default();

    if format == SqlFileFailureLogFormat::Csv {
        write_csv_header(&mut writer)?;
    }

    let mut buffer = String::new();
    let mut line_number = 0usize;
    loop {
        buffer.clear();
        let read =
            reader.read_line(&mut buffer).map_err(|error| SqlFileFailureLogDeriveError::Io(error.to_string()))?;
        if read == 0 {
            break;
        }
        line_number += 1;
        let text = buffer.trim_end_matches(['\n', '\r']);
        if text.trim().is_empty() {
            continue;
        }
        let parsed: LogLine = match serde_json::from_str(text) {
            Ok(parsed) => parsed,
            // A line with no terminator is the record the running execution is
            // still writing; it is the only line allowed to be unparsable.
            Err(_) if !buffer.ends_with('\n') => break,
            Err(_) => return Err(SqlFileFailureLogDeriveError::Corrupt { line: line_number }),
        };
        write_log_record(&mut writer, &mut summary, parsed, format, selection)?;
    }

    if format == SqlFileFailureLogFormat::Txt && !summary.run_summary_present {
        write_missing_run_summary_notice(&mut writer)?;
    }
    summary.bytes = writer.bytes;
    Ok(summary)
}

fn write_csv_header(writer: &mut CountingWriter<'_>) -> SqlFileFailureLogDeriveResult<()> {
    writer.write_all(UTF8_BOM)?;
    let mut row = Vec::new();
    write_csv_text_row(&mut row, CSV_COLUMNS.map(str::to_string), CsvQuoteMode::Necessary)
        .map_err(SqlFileFailureLogDeriveError::Io)?;
    writer.write_all(&row)?;
    writer.write_all(CSV_RECORD_SEPARATOR)
}

fn write_missing_run_summary_notice(writer: &mut CountingWriter<'_>) -> SqlFileFailureLogDeriveResult<()> {
    writer.write_all(
        b"\n---\nRun summary: not recorded (the execution was cancelled or DBX stopped before it finished).\n",
    )
}

/// Applies one parsed log record: `meta` prints the TXT header, `failure` prints a
/// record (unless the caller selected a subset), `summary` closes the TXT footer.
fn write_log_record(
    writer: &mut CountingWriter<'_>,
    summary: &mut SqlFileFailureLogDeriveSummary,
    record: LogLine,
    format: SqlFileFailureLogFormat,
    selection: Option<&HashSet<SqlFileFailureLogKey>>,
) -> SqlFileFailureLogDeriveResult<()> {
    match record {
        LogLine::Meta(meta) => {
            if format == SqlFileFailureLogFormat::Txt {
                write_txt_header(writer, &meta)?;
            }
        }
        LogLine::Failure(failure) => {
            if let Some(selection) = selection {
                let key =
                    SqlFileFailureLogKey { file_index: failure.file_index, statement_index: failure.statement_index };
                if !selection.contains(&key) {
                    return Ok(());
                }
            }
            if failure.sql_truncated {
                summary.sql_truncated += 1;
            }
            summary.records += 1;
            match format {
                SqlFileFailureLogFormat::Txt => write_txt_failure(writer, &failure)?,
                SqlFileFailureLogFormat::Csv => write_csv_failure(writer, &failure)?,
            }
        }
        LogLine::Summary(run) => {
            summary.run_summary_present = true;
            summary.omitted_failures = run.omitted_failures;
            summary.log_truncated = run.log_truncated;
            if format == SqlFileFailureLogFormat::Txt {
                write_txt_footer(writer, &run)?;
            }
        }
        LogLine::Unknown => {}
    }
    Ok(())
}

fn write_txt_header(writer: &mut CountingWriter<'_>, meta: &MetaLine) -> SqlFileFailureLogDeriveResult<()> {
    let mut text = String::new();
    text.push_str("DBX SQL file execution failure log\n");
    text.push_str(&format!("execution: {}\n", meta.execution_id));
    match meta.connection_name.as_deref() {
        Some(name) => text.push_str(&format!("connection: {name} ({})\n", meta.connection_id)),
        None => text.push_str(&format!("connection: {}\n", meta.connection_id)),
    }
    match meta.schema.as_deref() {
        Some(schema) => text.push_str(&format!("database: {} / schema: {schema}\n", meta.database)),
        None => text.push_str(&format!("database: {}\n", meta.database)),
    }
    text.push_str(&format!("started: {}\n", format_timestamp(meta.started_at_ms)));
    text.push_str(&format!(
        "limits: statement {} bytes, log {} bytes\n",
        meta.max_statement_bytes, meta.max_total_bytes
    ));
    text.push_str("files:\n");
    for file in &meta.files {
        match file.size_bytes {
            Some(size) => text.push_str(&format!("  [{}] {}  {}  {} bytes\n", file.index, file.name, file.path, size)),
            None => text.push_str(&format!("  [{}] {}  {}\n", file.index, file.name, file.path)),
        }
    }
    writer.write_all(text.as_bytes())
}

fn write_txt_failure(writer: &mut CountingWriter<'_>, failure: &FailureLine) -> SqlFileFailureLogDeriveResult<()> {
    let mut text = String::new();
    text.push_str("\n---\n");
    match failure.file_name.as_deref() {
        Some(name) => text.push_str(&format!(
            "#{}  {}  (statement #{} in file)\n",
            failure.statement_index, name, failure.file_statement_index
        )),
        None => text.push_str(&format!(
            "#{}  (statement #{} in file {})\n",
            failure.statement_index, failure.file_statement_index, failure.file_index
        )),
    }
    text.push_str(&failure.sql);
    if !failure.sql.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&format!("error: {}\n", failure.error));
    if failure.sql_truncated {
        text.push_str("[statement text truncated at the per-statement limit]\n");
    }
    writer.write_all(text.as_bytes())
}

fn write_csv_failure(writer: &mut CountingWriter<'_>, failure: &FailureLine) -> SqlFileFailureLogDeriveResult<()> {
    let file = failure.file_name.clone().unwrap_or_else(|| format!("file[{}]", failure.file_index));
    let values = [
        file,
        failure.statement_index.to_string(),
        neutralize_csv_formula_text(&failure.error),
        neutralize_csv_formula_text(&failure.sql),
        if failure.sql_truncated { "yes" } else { "no" }.to_string(),
    ];
    // Buffered per row: the shared helper quotes/escapes, while counting and the
    // clipboard cap stay in `CountingWriter`.
    let mut row = Vec::new();
    write_csv_text_row(&mut row, values, CsvQuoteMode::Necessary).map_err(SqlFileFailureLogDeriveError::Io)?;
    writer.write_all(&row)?;
    writer.write_all(CSV_RECORD_SEPARATOR)
}

/// The error and statement columns come from the imported dump file and the
/// server's failure text; the CSV targets spreadsheet tooling, so both get the
/// same formula neutralization as the result CSV export.
fn neutralize_csv_formula_text(value: &str) -> String {
    let mut guarded = String::new();
    push_formula_guard(&mut guarded, value);
    guarded.push_str(value);
    guarded
}

fn write_txt_footer(writer: &mut CountingWriter<'_>, run: &SummaryLine) -> SqlFileFailureLogDeriveResult<()> {
    let mut text = String::new();
    text.push_str("\n---\n");
    text.push_str(&format!(
        "Run summary: {} succeeded, {} failed, {} rows affected, {} ms\n",
        run.success_count, run.failure_count, run.affected_rows, run.elapsed_ms
    ));
    text.push_str(&format!("failures logged: {}\n", run.failed_statements_logged));
    if run.omitted_failures > 0 || run.truncated_statements > 0 || run.log_truncated {
        text.push_str(&format!(
            "truncation: {} statement(s) truncated, {} failure(s) not logged, log truncated: {}\n",
            run.truncated_statements,
            run.omitted_failures,
            if run.log_truncated { "yes" } else { "no" }
        ));
    }
    text.push_str(&format!(
        "log status: {}{}\n",
        run.log_status,
        run.log_status_reason.as_deref().map(|reason| format!(" ({reason})")).unwrap_or_default()
    ));
    if run.cancelled {
        text.push_str("the execution was cancelled\n");
    }
    writer.write_all(text.as_bytes())
}

fn format_timestamp(timestamp_ms: i64) -> String {
    match chrono::DateTime::from_timestamp_millis(timestamp_ms) {
        Some(value) => value.format("%Y-%m-%d %H:%M:%S UTC").to_string(),
        None => timestamp_ms.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_log(dir: &Path, body: &str) -> std::path::PathBuf {
        let path = dir.join("exec-1.jsonl");
        std::fs::write(&path, body).unwrap();
        path
    }

    fn meta_line() -> String {
        serde_json::json!({
            "type": "meta",
            "executionId": "exec-1",
            "connectionId": "conn-1",
            "connectionName": "MySQL",
            "database": "shop",
            "startedAtMs": 1_760_000_000_000_i64,
            "files": [{ "index": 0, "name": "a.sql", "path": "/tmp/a.sql", "sizeBytes": 10 }],
            "maxStatementBytes": 262_144,
            "maxTotalBytes": 209_715_200_u64
        })
        .to_string()
    }

    fn failure_line(statement_index: usize, sql: &str, error: &str) -> String {
        serde_json::json!({
            "type": "failure",
            "fileIndex": 0,
            "fileName": "a.sql",
            "fileStatementIndex": statement_index,
            "statementIndex": statement_index,
            "sql": sql,
            "sqlTruncated": false,
            "error": error,
            "recordedAtMs": 1_760_000_000_100_i64
        })
        .to_string()
    }

    fn summary_line(omitted: u64, truncated: u64, log_truncated: bool) -> String {
        serde_json::json!({
            "type": "summary",
            "successCount": 6,
            "failureCount": 2,
            "affectedRows": 4,
            "elapsedMs": 1200,
            "failedStatementsLogged": 2,
            "omittedFailures": omitted,
            "truncatedStatements": truncated,
            "logTruncated": log_truncated,
            "cancelled": false,
            "logStatus": "available",
            "finishedAtMs": 1_760_000_001_200_i64
        })
        .to_string()
    }

    fn derive_text(path: &Path, format: SqlFileFailureLogFormat) -> String {
        sql_file_failure_log_text(path, format, None, SQL_FILE_FAILURE_LOG_CLIPBOARD_MAX_BYTES).unwrap()
    }

    #[test]
    fn txt_export_renders_meta_failures_and_run_summary() {
        let dir = tempfile::tempdir().unwrap();
        let log = write_log(
            dir.path(),
            &format!(
                "{}\n{}\n{}\n{}\n",
                meta_line(),
                failure_line(644, "INSERT INTO t VALUES (1);", "ORA-12899: value too large"),
                failure_line(645, "INSERT INTO t VALUES (2);", "ORA-12899: value too large"),
                summary_line(0, 0, false)
            ),
        );

        let text = derive_text(&log, SqlFileFailureLogFormat::Txt);

        assert!(text.contains("DBX SQL file execution failure log"));
        assert!(text.contains("connection: MySQL (conn-1)"));
        assert!(text.contains("database: shop"));
        assert!(text.contains("[0] a.sql  /tmp/a.sql  10 bytes"));
        assert!(text.contains("#644  a.sql  (statement #644 in file)"));
        assert!(text.contains("INSERT INTO t VALUES (1);"));
        assert!(text.contains("error: ORA-12899: value too large"));
        assert!(text.contains("Run summary: 6 succeeded, 2 failed, 4 rows affected, 1200 ms"));
        assert!(!text.contains("truncation:"));
    }

    #[test]
    fn csv_export_writes_bom_crlf_and_rfc4180_quoting() {
        let dir = tempfile::tempdir().unwrap();
        let sql = "INSERT INTO t (a, b) VALUES ('x, y', \"quoted\");\nSELECT '中文';";
        let log = write_log(
            dir.path(),
            &format!("{}\n{}\n{}\n", meta_line(), failure_line(7, sql, "duplicate key"), summary_line(0, 0, false)),
        );

        let text = derive_text(&log, SqlFileFailureLogFormat::Csv);

        assert!(text.starts_with("\u{feff}file,statement_index,error,statement,truncated\r\n"));
        assert!(text.ends_with("\r\n"), "every CSV record must end with CRLF");
        // Comma, quote and newline force quoting; the embedded quote is doubled
        // and the SQL text itself stays byte-for-byte what the user wrote.
        assert!(text.contains("\"INSERT INTO t (a, b) VALUES ('x, y', \"\"quoted\"\");\nSELECT '中文';\""));
        // The meta and summary records are not spreadsheet rows.
        assert!(!text.contains("executionId"));
    }

    #[test]
    fn csv_export_neutralizes_formula_text_from_the_dump() {
        let dir = tempfile::tempdir().unwrap();
        // Both free-text columns come from untrusted dump content; spreadsheet
        // tooling must never re-evaluate them as formulas on open.
        let log = write_log(
            dir.path(),
            &format!(
                "{}\n{}\n{}\n",
                meta_line(),
                failure_line(3, "=WEBSERVICE(\"http://evil\")", "=SUM(1)+cmd|' /C calc'!A0"),
                summary_line(0, 1, true)
            ),
        );

        let text = derive_text(&log, SqlFileFailureLogFormat::Csv);

        assert!(text.contains("'=WEBSERVICE"), "statement column must carry the formula guard");
        assert!(text.contains("'=SUM(1)+cmd"), "error column must carry the formula guard");
    }

    #[test]
    fn selection_filters_records_and_keeps_their_order() {
        let dir = tempfile::tempdir().unwrap();
        let log = write_log(
            dir.path(),
            &format!(
                "{}\n{}\n{}\n{}\n",
                meta_line(),
                failure_line(1, "SELECT 1;", "e1"),
                failure_line(2, "SELECT 2;", "e2"),
                failure_line(3, "SELECT 3;", "e3")
            ),
        );
        let selection: HashSet<SqlFileFailureLogKey> = [
            SqlFileFailureLogKey { file_index: 0, statement_index: 3 },
            SqlFileFailureLogKey { file_index: 0, statement_index: 1 },
        ]
        .into_iter()
        .collect();

        let text = sql_file_failure_log_text(&log, SqlFileFailureLogFormat::Txt, Some(&selection), u64::MAX).unwrap();

        assert!(text.contains("SELECT 1;") && text.contains("SELECT 3;"));
        assert!(!text.contains("SELECT 2;"));
        assert!(text.find("SELECT 1;").unwrap() < text.find("SELECT 3;").unwrap());
    }

    #[test]
    fn a_partially_written_trailing_record_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let log = write_log(
            dir.path(),
            &format!("{}\n{}\n{}", meta_line(), failure_line(1, "SELECT 1;", "e1"), "{\"type\":\"fail"),
        );

        let text = derive_text(&log, SqlFileFailureLogFormat::Txt);

        assert!(text.contains("SELECT 1;"));
        // The half-written record must not leak into the export in any form.
        assert!(!text.contains("{\"type\":\"fail"));
    }

    #[test]
    fn a_corrupt_complete_line_is_reported_instead_of_silently_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let log = write_log(
            dir.path(),
            &format!(
                "{}\n{}\nnot json\n{}\n",
                meta_line(),
                failure_line(1, "SELECT 1;", "e1"),
                summary_line(0, 0, false)
            ),
        );

        let error = sql_file_failure_log_text(&log, SqlFileFailureLogFormat::Txt, None, u64::MAX).unwrap_err();
        assert_eq!(error, SqlFileFailureLogDeriveError::Corrupt { line: 3 });
    }

    #[test]
    fn a_missing_run_summary_is_stated_instead_of_invented() {
        let dir = tempfile::tempdir().unwrap();
        // Cancelled execution: the log stops after the failures.
        let log = write_log(dir.path(), &format!("{}\n{}\n", meta_line(), failure_line(1, "SELECT 1;", "e1")));

        let text = derive_text(&log, SqlFileFailureLogFormat::Txt);

        assert!(text.contains("Run summary: not recorded"));
        assert!(!text.contains("Run summary: 0 succeeded"));
    }

    #[test]
    fn truncation_and_omissions_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        let log = write_log(
            dir.path(),
            &format!("{}\n{}\n{}\n", meta_line(), failure_line(1, "SELECT 1;", "e1"), summary_line(9, 2, true)),
        );

        let text = derive_text(&log, SqlFileFailureLogFormat::Txt);

        assert!(text.contains("truncation: 2 statement(s) truncated, 9 failure(s) not logged, log truncated: yes"));
    }

    #[test]
    fn clipboard_text_is_refused_over_the_byte_cap() {
        let dir = tempfile::tempdir().unwrap();
        let log =
            write_log(dir.path(), &format!("{}\n{}\n", meta_line(), failure_line(1, &"SELECT 1;".repeat(200), "e1")));

        let error = sql_file_failure_log_text(&log, SqlFileFailureLogFormat::Txt, None, 256).unwrap_err();
        assert_eq!(error, SqlFileFailureLogDeriveError::TooLarge { limit: 256 });
    }

    #[test]
    fn file_export_streams_to_the_destination_and_reports_counts() {
        let dir = tempfile::tempdir().unwrap();
        let log = write_log(
            dir.path(),
            &format!("{}\n{}\n{}\n", meta_line(), failure_line(1, "SELECT 1;", "e1"), summary_line(0, 0, false)),
        );
        let destination = dir.path().join("export.csv");

        let summary = export_sql_file_failure_log(&log, &destination, SqlFileFailureLogFormat::Csv, None).unwrap();

        assert_eq!(summary.records, 1);
        assert!(summary.run_summary_present);
        assert_eq!(summary.bytes, std::fs::metadata(&destination).unwrap().len());
        assert!(std::fs::read_to_string(&destination).unwrap().contains("SELECT 1;"));
    }
}
