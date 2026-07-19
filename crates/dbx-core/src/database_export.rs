use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::io::Write;
use std::sync::RwLock;

use crate::connection::task_client_session_id;
use crate::models::connection::DatabaseType;
use crate::object_source_sql::build_export_object_source_sql;
use crate::sql_dialect::{qualified_table_name, quote_table_identifier, uses_single_row_insert_statements};
use crate::transfer::{
    format_ch_array_sql_literal, format_pg_array_sql_literal, is_identity_column_extra, quote_identifier,
    selected_columns_include_identity_extras, wrap_dameng_identity_insert_sql,
    wrap_dameng_identity_insert_sql_for_table,
};

static EXPORT_CANCELLED: std::sync::LazyLock<RwLock<HashSet<String>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashSet::new()));

pub fn database_export_client_session_id(export_id: &str) -> String {
    task_client_session_id("database-export", export_id)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseExportRequest {
    pub export_id: String,
    pub connection_id: String,
    pub database: String,
    pub schema: String,
    pub file_path: String,
    #[serde(default)]
    pub selected_tables: Vec<String>,
    #[serde(default)]
    pub excluded_tables: Vec<String>,
    pub include_structure: bool,
    pub include_data: bool,
    pub include_objects: bool,
    #[serde(default)]
    pub drop_table_if_exists: bool,
    #[serde(default)]
    pub fail_on_error: bool,
    #[serde(default)]
    pub snapshot_session_id: Option<String>,
    pub batch_size: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseBackupSnapshot {
    pub session_id: String,
    pub schemas: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub export_id: String,
    pub current_object: String,
    pub object_index: usize,
    pub total_objects: usize,
    pub rows_exported: u64,
    pub total_rows: Option<u64>,
    pub status: ExportStatus,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ExportStatus {
    Running,
    Writing,
    Done,
    Error,
    Cancelled,
}

pub const DATABASE_EXPORT_ROW_LIMIT: usize = 10_000;
pub const DATABASE_EXPORT_PAGE_SIZE: usize = 500;
pub const DATABASE_EXPORT_INSERT_BATCH_SIZE: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
struct PostgresExportSequence {
    name: String,
    data_type: String,
    start_value: String,
    min_value: String,
    max_value: String,
    increment: String,
    cycle: bool,
    cache_value: String,
    last_value: Option<String>,
    owner_table: Option<String>,
    owner_column: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PostgresExportExtension {
    name: String,
    schema: String,
}

#[derive(Debug, Default)]
struct PostgresExtensionMembers {
    relation_names: HashSet<String>,
    function_keys: HashSet<(String, String)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedTableSql {
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qualified_table_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ddl: Option<String>,
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub column_types: Vec<Option<String>>,
    #[serde(default)]
    pub column_extras: Vec<Option<String>>,
    #[serde(default)]
    pub rows: Vec<Vec<Value>>,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildExportInsertStatementsOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qualified_table_name: Option<String>,
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub column_types: Vec<Option<String>>,
    #[serde(default)]
    pub column_extras: Vec<Option<String>>,
    #[serde(default)]
    pub rows: Vec<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_size: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildExportSqlInsertOptions {
    #[serde(flatten)]
    pub insert: BuildExportInsertStatementsOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDatabaseSqlExportOptions {
    pub database_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exported_at: Option<String>,
    #[serde(default)]
    pub tables: Vec<ExportedTableSql>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_limit_per_table: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub insert_batch_size: Option<usize>,
    /// Optional connection info for FK-aware table ordering.
    /// When set, the caller should sort tables by dependency before passing them
    /// to `build_database_sql_export`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
}

pub fn format_export_sql_literal(value: &Value) -> String {
    format_export_sql_literal_for_database(value, None)
}

fn format_export_sql_literal_for_database(value: &Value, database_type: Option<DatabaseType>) -> String {
    if value.is_null() {
        return "NULL".to_string();
    }
    if let Some(number) = value.as_number() {
        return number.to_string();
    }
    if let Some(value) = value.as_bool() {
        if database_type == Some(DatabaseType::Dameng) {
            return if value { "1" } else { "0" }.to_string();
        }
        return if value { "TRUE" } else { "FALSE" }.to_string();
    }
    if let Some(arr) = value.as_array() {
        return format_pg_array_sql_literal(arr);
    }
    let text = value.as_str().map_or_else(|| value.to_string(), ToString::to_string);
    quote_export_sql_string_for_database(&text, database_type)
}

fn format_export_sql_literal_typed(
    value: &Value,
    database_type: Option<DatabaseType>,
    column_type: Option<&str>,
) -> String {
    if is_postgres_json_export_column(database_type, column_type) {
        return format_postgres_json_export_literal(value);
    }
    if is_postgres_vector_export_column(database_type, column_type) {
        return format_postgres_vector_export_literal(value);
    }
    if matches!(database_type, Some(DatabaseType::Mysql)) && column_type.is_some_and(is_mysql_bit_type) {
        return format_mysql_bit_literal(value);
    }
    if is_mysql_compatible_export_literal_target(database_type) {
        if column_type.is_some_and(is_mysql_binary_export_type) {
            if let Some(literal) = format_mysql_binary_export_literal(value) {
                return literal;
            }
        }
        if column_type.is_some_and(is_export_numeric_type) {
            if let Some(literal) = format_export_numeric_literal(value) {
                return literal;
            }
        }
    }
    if let Some(arr) = value.as_array() {
        if matches!(database_type, Some(DatabaseType::ClickHouse) | Some(DatabaseType::Databend)) {
            return format_ch_array_sql_literal(arr);
        }
    }
    if let Some(literal) = format_oracle_export_date_literal(value, database_type, column_type) {
        return literal;
    }
    if let Some(literal) = format_export_temporal_literal(value, database_type, column_type) {
        return literal;
    }
    format_export_sql_literal_for_database(value, database_type)
}

fn format_postgres_json_export_literal(value: &Value) -> String {
    if value.is_null() {
        return "NULL".to_string();
    }
    let text = value.as_str().map_or_else(|| value.to_string(), ToString::to_string);
    // PostgreSQL standard strings keep backslashes literal; JSON text needs its
    // own escape sequences, so only SQL-escape the surrounding string delimiter.
    postgres_string_literal(&text)
}

fn format_postgres_vector_export_literal(value: &Value) -> String {
    if value.is_null() {
        return "NULL".to_string();
    }
    let text = match value {
        // pgvector vector/halfvec are scalar extension types whose importable
        // literal grammar uses square brackets, unlike PostgreSQL arrays.
        Value::Array(arr) => format_postgres_vector_export_text(arr),
        Value::String(text) => text.to_string(),
        _ => value.to_string(),
    };
    postgres_string_literal(&text)
}

fn format_postgres_vector_export_text(arr: &[Value]) -> String {
    let elements = arr.iter().map(format_postgres_vector_export_element).collect::<Vec<_>>();
    format!("[{}]", elements.join(","))
}

fn format_postgres_vector_export_element(value: &Value) -> String {
    match value {
        Value::String(text) => text.trim().to_string(),
        Value::Number(number) => number.to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Null => "NULL".to_string(),
        _ => value.to_string(),
    }
}

fn quote_export_sql_string(text: &str) -> String {
    format!("'{}'", text.replace('\\', "\\\\").replace('\'', "''"))
}

fn quote_export_sql_string_for_database(text: &str, database_type: Option<DatabaseType>) -> String {
    if is_mysql_compatible_export_literal_target(database_type) {
        quote_mysql_compatible_export_sql_string(text)
    } else {
        quote_export_sql_string(text)
    }
}

fn quote_mysql_compatible_export_sql_string(text: &str) -> String {
    format!("'{}'", escape_mysql_compatible_export_sql_string(text))
}

fn escape_mysql_compatible_export_sql_string(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            // MySQL-family dumps should keep control characters out of the
            // physical script layout while relying on the dialect's escapes.
            '\0' => escaped.push_str("\\0"),
            '\x08' => escaped.push_str("\\b"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            '\x0c' => escaped.push_str("\\f"),
            '\x1a' => escaped.push_str("\\Z"),
            '\\' => escaped.push_str("\\\\"),
            '\'' => escaped.push_str("''"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

fn is_mysql_compatible_export_literal_target(database_type: Option<DatabaseType>) -> bool {
    matches!(
        database_type,
        Some(DatabaseType::Mysql | DatabaseType::Doris | DatabaseType::StarRocks | DatabaseType::Goldendb)
    )
}

fn format_oracle_export_date_literal(
    value: &Value,
    database_type: Option<DatabaseType>,
    column_type: Option<&str>,
) -> Option<String> {
    if !matches!(database_type, Some(DatabaseType::Oracle | DatabaseType::OceanbaseOracle)) {
        return None;
    }
    if export_temporal_column_kind(database_type, column_type?)? != ExportTemporalKind::DateTime {
        return None;
    }
    let lower = column_type?.trim().trim_matches('"').to_ascii_lowercase();
    let base = lower.split(['(', ' ', '\t', '\n']).next().unwrap_or("");
    if base != "date" {
        return None;
    }
    let parts = parse_export_date_parts(value.as_str()?)?;
    Some(format_oracle_export_date_parts_literal(&parts))
}

fn format_oracle_export_date_parts_literal(parts: &ExportRfc3339Parts) -> String {
    if export_temporal_parts_are_midnight(parts) {
        format!("DATE '{}'", parts.date)
    } else {
        format!("TO_DATE('{} {}', 'YYYY-MM-DD HH24:MI:SS')", parts.date, parts.time)
    }
}

fn export_temporal_parts_are_midnight(parts: &ExportRfc3339Parts) -> bool {
    parts.time == "00:00:00"
        && parts
            .fraction
            .as_deref()
            .map(|fraction| fraction.trim_start_matches('.').chars().all(|ch| ch == '0'))
            .unwrap_or(true)
}

fn format_export_temporal_literal(
    value: &Value,
    database_type: Option<DatabaseType>,
    column_type: Option<&str>,
) -> Option<String> {
    let text = value.as_str()?;
    let column_type = column_type?;
    if database_type == Some(DatabaseType::SqlServer) {
        return crate::sqlserver_temporal::normalize_sqlserver_temporal_literal(text, Some(column_type))
            .map(|text| quote_export_sql_string(&text));
    }
    let kind = export_temporal_column_kind(database_type, column_type)?;
    format_rfc3339_export_temporal_text(text, kind, database_type).map(|text| quote_export_sql_string(&text))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExportTemporalKind {
    Date,
    Time,
    DateTime,
    DateTimeWithTimeZone,
}

fn export_temporal_column_kind(database_type: Option<DatabaseType>, column_type: &str) -> Option<ExportTemporalKind> {
    let lower = column_type.trim().trim_matches('"').to_ascii_lowercase();
    let base = lower.split(['(', ' ', '\t', '\n']).next().unwrap_or("");
    match base {
        "date" if matches!(database_type, Some(DatabaseType::Oracle | DatabaseType::OceanbaseOracle)) => {
            Some(ExportTemporalKind::DateTime)
        }
        "date" => Some(ExportTemporalKind::Date),
        "time" => Some(ExportTemporalKind::Time),
        "datetime" | "datetime2" | "smalldatetime" | "datetime64" => Some(ExportTemporalKind::DateTime),
        "datetimeoffset" | "timestamptz" => Some(ExportTemporalKind::DateTimeWithTimeZone),
        _ if lower.starts_with("timestamp")
            && (lower.contains("with time zone") || lower.contains("with local time zone")) =>
        {
            Some(ExportTemporalKind::DateTimeWithTimeZone)
        }
        _ if lower.starts_with("timestamp") => Some(ExportTemporalKind::DateTime),
        _ => None,
    }
}

fn format_rfc3339_export_temporal_text(
    text: &str,
    kind: ExportTemporalKind,
    database_type: Option<DatabaseType>,
) -> Option<String> {
    let parts = parse_export_rfc3339_parts(text)?;
    let fraction = normalize_export_fraction(parts.fraction.as_deref(), database_type);
    match kind {
        ExportTemporalKind::Date => Some(parts.date),
        ExportTemporalKind::Time => Some(format!("{}{fraction}", parts.time)),
        ExportTemporalKind::DateTime => Some(format!("{} {}{fraction}", parts.date, parts.time)),
        ExportTemporalKind::DateTimeWithTimeZone => {
            Some(format!("{} {}{fraction}{}", parts.date, parts.time, normalize_export_timezone(&parts.zone)))
        }
    }
}

struct ExportRfc3339Parts {
    date: String,
    time: String,
    fraction: Option<String>,
    zone: String,
}

fn parse_export_date_parts(text: &str) -> Option<ExportRfc3339Parts> {
    parse_export_rfc3339_parts(text).or_else(|| parse_export_local_temporal_parts(text))
}

fn parse_export_local_temporal_parts(text: &str) -> Option<ExportRfc3339Parts> {
    let bytes = text.as_bytes();
    if bytes.len() < 10 || bytes.get(4) != Some(&b'-') || bytes.get(7) != Some(&b'-') {
        return None;
    }
    let date = &text[0..10];
    if !date.as_bytes().iter().enumerate().all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit()) {
        return None;
    }
    if bytes.len() == 10 {
        return Some(ExportRfc3339Parts {
            date: date.to_string(),
            time: "00:00:00".to_string(),
            fraction: None,
            zone: String::new(),
        });
    }
    let separator = *bytes.get(10)?;
    if separator != b'T' && separator != b' ' {
        return None;
    }
    if bytes.len() < 19 || bytes.get(13) != Some(&b':') || bytes.get(16) != Some(&b':') {
        return None;
    }
    let time = &text[11..19];
    if !time.as_bytes().iter().enumerate().all(|(index, byte)| matches!(index, 2 | 5) || byte.is_ascii_digit()) {
        return None;
    }
    let rest = &text[19..];
    let fraction = if let Some(rest) = rest.strip_prefix('.') {
        let digit_count = rest.chars().take_while(|ch| ch.is_ascii_digit()).count();
        if digit_count == 0 || digit_count > 9 || digit_count != rest.len() {
            return None;
        }
        Some(format!(".{}", &rest[..digit_count]))
    } else if rest.is_empty() {
        None
    } else {
        return None;
    };
    Some(ExportRfc3339Parts { date: date.to_string(), time: time.to_string(), fraction, zone: String::new() })
}

fn parse_export_rfc3339_parts(text: &str) -> Option<ExportRfc3339Parts> {
    let bytes = text.as_bytes();
    if bytes.len() < 20 || bytes.get(4) != Some(&b'-') || bytes.get(7) != Some(&b'-') {
        return None;
    }
    let separator = *bytes.get(10)?;
    if separator != b'T' && separator != b' ' {
        return None;
    }
    if bytes.get(13) != Some(&b':') || bytes.get(16) != Some(&b':') {
        return None;
    }
    let date = &text[0..10];
    let time = &text[11..19];
    let rest = &text[19..];
    let (fraction, zone) = if let Some(rest) = rest.strip_prefix('.') {
        let digit_count = rest.chars().take_while(|ch| ch.is_ascii_digit()).count();
        if digit_count == 0 || digit_count > 9 {
            return None;
        }
        (Some(format!(".{}", &rest[..digit_count])), &rest[digit_count..])
    } else {
        (None, rest)
    };
    if zone.eq_ignore_ascii_case("z") || is_export_timezone_offset(zone) {
        Some(ExportRfc3339Parts { date: date.to_string(), time: time.to_string(), fraction, zone: zone.to_string() })
    } else {
        None
    }
}

fn normalize_export_fraction(fraction: Option<&str>, database_type: Option<DatabaseType>) -> String {
    match fraction {
        Some(fraction) if database_type == Some(DatabaseType::Mysql) && fraction.len() > 7 => fraction[..7].to_string(),
        Some(fraction) => fraction.to_string(),
        None => String::new(),
    }
}

fn normalize_export_timezone(zone: &str) -> String {
    if zone.eq_ignore_ascii_case("z") {
        "+00:00".to_string()
    } else {
        zone.to_string()
    }
}

fn is_export_timezone_offset(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 6
        && matches!(bytes[0], b'+' | b'-')
        && bytes[3] == b':'
        && bytes[1].is_ascii_digit()
        && bytes[2].is_ascii_digit()
        && bytes[4].is_ascii_digit()
        && bytes[5].is_ascii_digit()
}

fn is_mysql_bit_type(column_type: &str) -> bool {
    let trimmed = column_type.trim();
    let lower = trimmed.to_ascii_lowercase();
    lower == "bit" || lower.starts_with("bit(") || lower.starts_with("bit ")
}

fn format_mysql_bit_literal(value: &Value) -> String {
    match value {
        Value::Null => "NULL".to_string(),
        Value::Bool(value) => {
            if *value {
                "b'1'".to_string()
            } else {
                "b'0'".to_string()
            }
        }
        Value::Number(value) => {
            let s = value.to_string();
            if s == "0" || s == "1" {
                format!("b'{s}'")
            } else {
                s
            }
        }
        Value::String(value) => {
            let trimmed = value.trim();
            if trimmed.eq_ignore_ascii_case("true") {
                return "b'1'".to_string();
            }
            if trimmed.eq_ignore_ascii_case("false") {
                return "b'0'".to_string();
            }
            if trimmed == "0" || trimmed == "1" {
                return format!("b'{trimmed}'");
            }
            if !trimmed.is_empty() && trimmed.bytes().all(|byte| byte == b'0' || byte == b'1') {
                return format!("b'{trimmed}'");
            }
            format!("b'{}'", escape_mysql_compatible_export_sql_string(value))
        }
        other => format_export_sql_literal(other),
    }
}

fn is_mysql_binary_export_type(column_type: &str) -> bool {
    let lower = column_type.trim().to_ascii_lowercase();
    let base = lower.split(['(', ':', ' ', '\t', '\n']).next().unwrap_or("").trim();
    matches!(base, "binary" | "varbinary" | "blob" | "tinyblob" | "mediumblob" | "longblob")
}

fn format_mysql_binary_export_literal(value: &Value) -> Option<String> {
    match value {
        Value::Null => Some("NULL".to_string()),
        Value::String(text) => format_mysql_binary_export_literal_text(text),
        _ => None,
    }
}

fn format_mysql_binary_export_literal_text(text: &str) -> Option<String> {
    let trimmed = text.trim();
    let hex = trimmed.strip_prefix("0x").or_else(|| trimmed.strip_prefix("0X"))?;
    if hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        // DBX exposes MySQL binary cells as 0x-prefixed hex text. Keep it as a
        // MySQL hex literal so exported INSERT statements round-trip bytes.
        Some(if hex.is_empty() { "X''".to_string() } else { format!("0x{hex}") })
    } else {
        None
    }
}

fn is_export_numeric_type(column_type: &str) -> bool {
    let lower = column_type.to_ascii_lowercase();
    [
        "int",
        "integer",
        "bigint",
        "smallint",
        "tinyint",
        "mediumint",
        "serial",
        "number",
        "numeric",
        "decimal",
        "dec",
        "fixed",
        "float",
        "double",
        "real",
    ]
    .iter()
    .any(|part| lower.split(|ch: char| !ch.is_ascii_alphanumeric()).any(|token| token == *part))
}

fn format_export_numeric_literal(value: &Value) -> Option<String> {
    match value {
        Value::Number(number) => Some(number.to_string()),
        Value::String(text) if is_export_numeric_literal(text) => Some(text.to_string()),
        _ => None,
    }
}

fn is_export_numeric_literal(text: &str) -> bool {
    if text.trim() != text || text.is_empty() {
        return false;
    }
    text.parse::<f64>().is_ok_and(f64::is_finite)
        && text.chars().all(|ch| ch.is_ascii_digit() || matches!(ch, '+' | '-' | '.' | 'e' | 'E'))
        && text.chars().any(|ch| ch.is_ascii_digit())
}

pub fn build_export_insert_statements(options: BuildExportInsertStatementsOptions) -> Result<Vec<String>, String> {
    if options.columns.is_empty() || options.rows.is_empty() {
        return Ok(Vec::new());
    }

    let table = export_qualified_table_name(
        options.database_type,
        options.schema.as_deref(),
        options.table_name.as_deref(),
        options.qualified_table_name.as_deref(),
    )?;
    let insert_columns = options
        .columns
        .iter()
        .enumerate()
        .filter(|(index, column)| {
            !is_internal_export_column(options.database_type, column)
                && !is_postgres_tsvector_export_column(
                    options.database_type,
                    options.column_types.get(*index).and_then(|value| value.as_deref()),
                )
        })
        .collect::<Vec<_>>();
    if insert_columns.is_empty() {
        return Ok(Vec::new());
    }
    let batch_size = if options.database_type.is_some_and(uses_single_row_insert_statements) {
        1
    } else {
        options.batch_size.unwrap_or(DATABASE_EXPORT_INSERT_BATCH_SIZE).max(1)
    };
    let columns = insert_columns
        .iter()
        .map(|(_, column)| quote_table_identifier(options.database_type, column))
        .collect::<Vec<_>>()
        .join(", ");
    let mut statements = Vec::new();
    let needs_dameng_identity_insert = options.database_type == Some(DatabaseType::Dameng)
        && insert_columns.iter().any(|(index, _)| {
            is_identity_column_extra(options.column_extras.get(*index).and_then(|value| value.as_deref()))
        });

    for rows in options.rows.chunks(batch_size) {
        let values = rows
            .iter()
            .map(|row| {
                let values = insert_columns
                    .iter()
                    .map(|(index, _)| {
                        let value = row.get(*index).unwrap_or(&Value::Null);
                        format_export_sql_literal_typed(
                            value,
                            options.database_type,
                            options.column_types.get(*index).and_then(|value| value.as_deref()),
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("({values})")
            })
            .collect::<Vec<_>>()
            .join(", ");
        let insert_sql = format!("INSERT INTO {table} ({columns}) VALUES {values};");
        if needs_dameng_identity_insert {
            statements.push(wrap_dameng_identity_insert_sql_for_table(&insert_sql, &table));
        } else {
            statements.push(insert_sql);
        }
    }

    Ok(statements)
}

pub(crate) fn is_internal_export_column(database_type: Option<DatabaseType>, column: &str) -> bool {
    // Oracle-compatible ROWID is injected only to identify editable rows. It
    // is not a physical table column and must never propagate into exports.
    crate::sql_dialect::uses_oracle_row_id(database_type)
        && column.eq_ignore_ascii_case(crate::sql_dialect::DBX_ROWID_COLUMN)
}

fn is_postgres_tsvector_export_column(database_type: Option<DatabaseType>, column_type: Option<&str>) -> bool {
    database_type == Some(DatabaseType::Postgres)
        && column_type
            .map(|column_type| {
                let normalized = column_type.trim().trim_matches('"').to_ascii_lowercase();
                normalized == "tsvector" || normalized.ends_with(".tsvector")
            })
            .unwrap_or(false)
}

fn is_postgres_json_export_column(database_type: Option<DatabaseType>, column_type: Option<&str>) -> bool {
    database_type == Some(DatabaseType::Postgres)
        && column_type
            .map(|column_type| {
                let normalized = column_type.trim().trim_matches('"').to_ascii_lowercase();
                matches!(normalized.as_str(), "json" | "jsonb")
                    || normalized.ends_with(".json")
                    || normalized.ends_with(".jsonb")
            })
            .unwrap_or(false)
}

fn is_postgres_vector_export_column(database_type: Option<DatabaseType>, column_type: Option<&str>) -> bool {
    database_type == Some(DatabaseType::Postgres)
        && column_type
            .map(|column_type| {
                let normalized = column_type.trim().trim_matches('"').to_ascii_lowercase();
                let base = normalized.split(['(', ' ', '\t', '\n']).next().unwrap_or("").trim_matches('"');
                matches!(base, "vector" | "halfvec") || base.ends_with(".vector") || base.ends_with(".halfvec")
            })
            .unwrap_or(false)
}

pub fn build_export_sql_insert(options: BuildExportSqlInsertOptions) -> Result<String, String> {
    build_export_insert_statements(options.insert).map(|statements| statements.join("\n"))
}

pub fn build_database_sql_export(options: BuildDatabaseSqlExportOptions) -> Result<String, String> {
    let exported_at = options.exported_at.unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
    let row_limit = options.row_limit_per_table.unwrap_or(DATABASE_EXPORT_ROW_LIMIT);
    let insert_batch_size = options.insert_batch_size.unwrap_or(DATABASE_EXPORT_INSERT_BATCH_SIZE);
    let mut lines = vec![
        "-- DBX database export".to_string(),
        format!("-- Database: {}", options.database_name),
        format!("-- Exported at: {exported_at}"),
        format!("-- Row limit per table: {row_limit}"),
        String::new(),
    ];

    for table in options.tables {
        if let Some(ddl) = table.ddl.as_ref().map(|ddl| ddl.trim()).filter(|ddl| !ddl.is_empty()) {
            let ddl = normalize_export_table_ddl(ddl, table.database_type);
            lines.push(format!("-- Structure for {}", table.display_name));
            lines.push(format!("{};", ddl.trim_end_matches(';')));
            lines.push(String::new());
        }

        lines.push(format!("-- Data for {}", table.display_name));
        if table.truncated {
            lines.push(format!("-- Exported rows: {} (truncated at {row_limit})", table.rows.len()));
        } else {
            lines.push(format!("-- Exported rows: {}", table.rows.len()));
        }

        let inserts = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: table.database_type,
            schema: table.schema,
            table_name: table.table_name,
            qualified_table_name: table.qualified_table_name,
            columns: table.columns,
            column_types: table.column_types,
            column_extras: table.column_extras,
            rows: table.rows,
            batch_size: Some(insert_batch_size),
        })?;
        if inserts.is_empty() {
            lines.push("-- No rows".to_string());
        } else {
            lines.extend(inserts);
        }
        lines.push(String::new());
    }

    Ok(lines.join("\n"))
}

fn export_qualified_table_name(
    database_type: Option<DatabaseType>,
    schema: Option<&str>,
    table_name: Option<&str>,
    qualified_name: Option<&str>,
) -> Result<String, String> {
    if let Some(name) = qualified_name.filter(|name| !name.trim().is_empty()) {
        return Ok(name.to_string());
    }
    let table_name = table_name
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| "tableName is required when qualifiedTableName is not provided".to_string())?;
    Ok(qualified_table_name(database_type, schema, table_name))
}

fn normalize_export_table_ddl(ddl: &str, database_type: Option<DatabaseType>) -> String {
    if database_type != Some(DatabaseType::Mysql) {
        return ddl.to_string();
    }

    static LEGACY_MYSQL_ROW_FORMAT_RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)\bROW_FORMAT\s*=\s*(COMPACT|REDUNDANT)\b").unwrap());

    LEGACY_MYSQL_ROW_FORMAT_RE.replace_all(ddl, "ROW_FORMAT=DYNAMIC").into_owned()
}

fn postgres_sequence_qualified_name(schema: &str, sequence_name: &str) -> String {
    let db_type = DatabaseType::Postgres;
    if schema.trim().is_empty() {
        quote_identifier(sequence_name, &db_type)
    } else {
        format!("{}.{}", quote_identifier(schema, &db_type), quote_identifier(sequence_name, &db_type))
    }
}

fn postgres_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn generate_postgres_sequence_create_ddl(sequence: &PostgresExportSequence, schema: &str) -> String {
    let qualified_name = postgres_sequence_qualified_name(schema, &sequence.name);
    let cycle = if sequence.cycle { "CYCLE" } else { "NO CYCLE" };
    format!(
        "CREATE SEQUENCE IF NOT EXISTS {qualified_name}\n  AS {data_type}\n  START WITH {start_value}\n  INCREMENT BY {increment}\n  MINVALUE {min_value}\n  MAXVALUE {max_value}\n  CACHE {cache_value}\n  {cycle}",
        data_type = sequence.data_type,
        start_value = sequence.start_value,
        increment = sequence.increment,
        min_value = sequence.min_value,
        max_value = sequence.max_value,
        cache_value = sequence.cache_value,
    )
}

fn generate_postgres_sequence_owner_ddl(sequence: &PostgresExportSequence, schema: &str) -> Option<String> {
    let owner_table = sequence.owner_table.as_deref()?;
    let owner_column = sequence.owner_column.as_deref()?;
    Some(format!(
        "ALTER SEQUENCE {} OWNED BY {}.{}",
        postgres_sequence_qualified_name(schema, &sequence.name),
        crate::transfer::qualified_table(owner_table, schema, &DatabaseType::Postgres),
        quote_identifier(owner_column, &DatabaseType::Postgres)
    ))
}

fn generate_postgres_sequence_setval_sql(sequence: &PostgresExportSequence, schema: &str) -> Option<String> {
    let last_value = sequence.last_value.as_deref()?.trim();
    if last_value.is_empty() {
        return None;
    }

    let sequence_literal = postgres_string_literal(&postgres_sequence_qualified_name(schema, &sequence.name));
    match (sequence.owner_table.as_deref(), sequence.owner_column.as_deref()) {
        (Some(owner_table), Some(owner_column)) => {
            let owner_table = crate::transfer::qualified_table(owner_table, schema, &DatabaseType::Postgres);
            let owner_column = quote_identifier(owner_column, &DatabaseType::Postgres);
            Some(format!(
                "SELECT setval({sequence_literal}, GREATEST(COALESCE(MAX({owner_column}), {last_value}), {last_value}), true) FROM {owner_table}"
            ))
        }
        _ => Some(format!("SELECT setval({sequence_literal}, {last_value}, true)")),
    }
}

fn generate_postgres_extension_ddl(extension: &PostgresExportExtension) -> String {
    // Match pg_dump: omit VERSION so the target installation selects its
    // default compatible version, while preserving the source schema.
    format!(
        "CREATE EXTENSION IF NOT EXISTS {} WITH SCHEMA {};",
        quote_identifier(&extension.name, &DatabaseType::Postgres),
        quote_identifier(&extension.schema, &DatabaseType::Postgres)
    )
}

async fn list_postgres_extension_members(
    state: &crate::connection::AppState,
    pool_key: &str,
    schema: &str,
) -> Result<PostgresExtensionMembers, String> {
    let pool = {
        let connections = state.connections.read().await;
        match connections.get(pool_key) {
            Some(crate::connection::PoolKind::Postgres(pool)) => pool.clone(),
            _ => return Ok(PostgresExtensionMembers::default()),
        }
    };
    let mut members = PostgresExtensionMembers::default();
    for (kind, name, signature) in crate::db::postgres::list_extension_member_objects(&pool, schema).await? {
        if kind == "RELATION" {
            members.relation_names.insert(name);
        } else if kind == "FUNCTION" {
            members.function_keys.insert((name, signature));
        }
    }
    Ok(members)
}

fn is_postgres_extension_member_routine(object: &crate::types::ObjectInfo, members: &PostgresExtensionMembers) -> bool {
    members.function_keys.contains(&(object.name.clone(), object.signature.clone().unwrap_or_default()))
}

async fn list_postgres_export_sequences(
    state: &crate::connection::AppState,
    pool_key: &str,
    schema: &str,
    selected_tables: &[String],
    excluded_tables: &[String],
    include_objects: bool,
    fail_on_error: bool,
) -> Result<Vec<PostgresExportSequence>, String> {
    let pool = {
        let connections = state.connections.read().await;
        match connections.get(pool_key) {
            Some(crate::connection::PoolKind::Postgres(pool)) => pool.clone(),
            _ => return Ok(Vec::new()),
        }
    };
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let rows = client
        .query(
            "SELECT c.relname, \
              COALESCE(format_type(s.seqtypid, NULL), 'bigint'), \
              COALESCE(s.seqstart::text, '1'), \
              COALESCE(s.seqmin::text, '1'), \
              COALESCE(s.seqmax::text, '9223372036854775807'), \
              COALESCE(s.seqincrement::text, '1'), \
              COALESCE(s.seqcycle, false), \
              COALESCE(s.seqcache::text, '1'), \
              t.relname, \
              a.attname \
             FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             LEFT JOIN pg_sequence s ON s.seqrelid = c.oid \
             LEFT JOIN pg_depend d ON d.classid = 'pg_class'::regclass \
               AND d.objid = c.oid \
               AND d.refclassid = 'pg_class'::regclass \
               AND d.deptype IN ('a', 'i') \
             LEFT JOIN pg_class t ON t.oid = d.refobjid \
             LEFT JOIN pg_namespace tn ON tn.oid = t.relnamespace AND tn.nspname = n.nspname \
             LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid \
             WHERE c.relkind = 'S' AND n.nspname = $1 \
             ORDER BY c.relname",
            &[&schema],
        )
        .await
        .map_err(|e| e.to_string())?;

    let selected: HashSet<&str> = selected_tables.iter().map(String::as_str).collect();
    let excluded: HashSet<&str> = excluded_tables.iter().map(String::as_str).collect();
    let mut sequences = rows
        .iter()
        .map(|row| PostgresExportSequence {
            name: row.get::<_, String>(0),
            data_type: row.get::<_, String>(1),
            start_value: row.get::<_, String>(2),
            min_value: row.get::<_, String>(3),
            max_value: row.get::<_, String>(4),
            increment: row.get::<_, String>(5),
            cycle: row.get::<_, bool>(6),
            cache_value: row.get::<_, String>(7),
            last_value: None,
            owner_table: row.get::<_, Option<String>>(8),
            owner_column: row.get::<_, Option<String>>(9),
        })
        .filter(|sequence| {
            sequence.owner_table.as_deref().is_none_or(|owner_table| !excluded.contains(owner_table))
                && (selected.is_empty()
                    || sequence.owner_table.as_deref().is_some_and(|owner_table| selected.contains(owner_table)))
        })
        .filter(|sequence| sequence.owner_table.is_some() || (include_objects && selected.is_empty()))
        .collect::<Vec<_>>();

    if sequences.is_empty() {
        return Ok(sequences);
    }

    let last_values = client
        .query(
            "SELECT c.relname, pg_sequence_last_value(c.oid)::text \
             FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE c.relkind = 'S' AND n.nspname = $1",
            &[&schema],
        )
        .await;
    match last_values {
        Ok(rows) => {
            for row in rows {
                let name: String = row.get(0);
                let last_value: Option<String> = row.get(1);
                if let Some(sequence) = sequences.iter_mut().find(|sequence| sequence.name == name) {
                    sequence.last_value = last_value;
                }
            }
        }
        Err(error) if fail_on_error => return Err(error.to_string()),
        Err(_) => {}
    }

    Ok(sequences)
}

pub fn is_export_cancelled_now(export_id: &str) -> bool {
    EXPORT_CANCELLED.read().map(|cancelled| cancelled.contains(export_id)).unwrap_or(false)
}

pub async fn is_export_cancelled(export_id: &str) -> bool {
    is_export_cancelled_now(export_id)
}

pub async fn set_export_cancelled(export_id: &str) {
    if let Ok(mut cancelled) = EXPORT_CANCELLED.write() {
        cancelled.insert(export_id.to_string());
    }
}

pub async fn clear_export_cancelled(export_id: &str) {
    if let Ok(mut cancelled) = EXPORT_CANCELLED.write() {
        cancelled.remove(export_id);
    }
}

pub async fn begin_database_backup_snapshot_core(
    state: &crate::connection::AppState,
    connection_id: &str,
    database: &str,
) -> Result<DatabaseBackupSnapshot, String> {
    let db_type = state
        .configs
        .read()
        .await
        .get(connection_id)
        .map(|config| config.db_type)
        .ok_or_else(|| format!("Connection config not found: {connection_id}"))?;
    if !matches!(db_type, DatabaseType::Mysql | DatabaseType::Postgres) {
        return Err("Consistent database backup snapshots are only supported for MySQL and PostgreSQL".to_string());
    }

    let session_id = crate::query::begin_database_backup_snapshot(state, connection_id, database).await?;
    let schemas = if matches!(db_type, DatabaseType::Postgres) {
        const POSTGRES_BACKUP_SCHEMAS_SQL: &str = "SELECT n.nspname FROM pg_catalog.pg_namespace n \
             WHERE n.nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast') \
             AND n.nspname NOT LIKE 'pg_toast_temp_%' \
             AND n.nspname NOT LIKE 'pg_temp_%' ORDER BY n.nspname";
        let results = crate::query::execute_in_manual_transaction(
            state,
            &session_id,
            POSTGRES_BACKUP_SCHEMAS_SQL,
            database,
            None,
            Some(10_000),
        )
        .await?;
        results
            .into_iter()
            .next()
            .map(|result| {
                result
                    .rows
                    .into_iter()
                    .filter_map(|row| row.into_iter().next())
                    .filter_map(|value| value.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    } else {
        vec![database.to_string()]
    };
    if schemas.is_empty() {
        let _ = crate::query::rollback_manual_transaction(state, &session_id).await;
        return Err(format!("No schemas are available in database {database}"));
    }
    Ok(DatabaseBackupSnapshot { session_id, schemas })
}

/// 只有确认底层支持并发请求的多连接池才允许并发预取导出元数据。
/// SqlServer（Arc<Mutex> 串行客户端）、Agent/ExternalDriver（插件请求超时覆盖
/// 排队时间且超时会终止 sidecar）、SQLite/DuckDB 等单连接类型都必须回退串行。
fn concurrent_metadata_prefetch_allowed(pool_kind: Option<&crate::connection::PoolKind>) -> bool {
    matches!(
        pool_kind,
        Some(crate::connection::PoolKind::Postgres(_))
            | Some(crate::connection::PoolKind::Mysql(..))
            | Some(crate::connection::PoolKind::ClickHouse(_))
    )
}

fn record_export_error(file: &mut std::fs::File, fail_on_error: bool, message: String) -> Result<(), String> {
    if fail_on_error {
        Err(message)
    } else {
        writeln!(file, "-- ERROR {message}").map_err(|error| format!("Failed to write file: {error}"))
    }
}

fn database_export_select_sql(columns: &[String], table: &str, schema: &str, db_type: &DatabaseType) -> String {
    let columns = columns.iter().map(|column| quote_identifier(column, db_type)).collect::<Vec<_>>().join(", ");
    let table = crate::transfer::qualified_table(table, schema, db_type);
    format!("SELECT {columns} FROM {table}")
}

fn write_database_export_rows(
    file: &mut std::fs::File,
    rows: &[Vec<Value>],
    columns: &[String],
    column_types: &[Option<String>],
    column_extras: &[Option<String>],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
) -> Result<(), String> {
    let mut insert_sql = crate::transfer::generate_insert_typed(columns, column_types, rows, table, schema, db_type);
    if *db_type == DatabaseType::Dameng && selected_columns_include_identity_extras(columns, column_extras) {
        insert_sql = wrap_dameng_identity_insert_sql(&insert_sql, table, schema);
    }
    if insert_sql.is_empty() {
        return Ok(());
    }
    if insert_sql.trim_end().ends_with(';') {
        writeln!(file, "{}\n", insert_sql).map_err(|error| format!("Failed to write file: {error}"))
    } else {
        writeln!(file, "{};\n", insert_sql).map_err(|error| format!("Failed to write file: {error}"))
    }
}

pub async fn export_database_sql_core(
    state: &crate::connection::AppState,
    request: &DatabaseExportRequest,
    on_progress: impl Fn(ExportProgress) + Sync,
) -> Result<(), String> {
    // 1. Get database type
    let db_type = state
        .configs
        .read()
        .await
        .get(&request.connection_id)
        .map(|c| c.db_type)
        .ok_or_else(|| format!("Connection config not found: {}", request.connection_id))?;

    // 2. Get pool
    let client_session_id = database_export_client_session_id(&request.export_id);
    let pool_key = state
        .get_or_create_pool_for_session(&request.connection_id, Some(&request.database), Some(&client_session_id))
        .await?;

    // 3. List tables
    let all_tables = crate::schema::list_tables_core(
        state,
        &request.connection_id,
        &request.database,
        &request.schema,
        None,
        None,
        None,
        None,
    )
    .await?;
    // 4. Create file
    let mut file = std::fs::File::create(&request.file_path).map_err(|e| format!("Failed to write file: {e}"))?;

    // 5. Write header
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    writeln!(file, "-- Database export: {}", request.database).map_err(|e| format!("Failed to write file: {e}"))?;
    writeln!(file, "-- Date: {timestamp}").map_err(|e| format!("Failed to write file: {e}"))?;
    writeln!(file, "-- Generated by DBX").map_err(|e| format!("Failed to write file: {e}"))?;
    writeln!(file).map_err(|e| format!("Failed to write file: {e}"))?;

    // 6. For MySQL: disable foreign key checks
    if matches!(db_type, DatabaseType::Mysql) {
        writeln!(file, "SET FOREIGN_KEY_CHECKS = 0;\n").map_err(|e| format!("Failed to write file: {e}"))?;
    }

    // 7. Separate tables and views
    let postgres_extension_members =
        if matches!(db_type, DatabaseType::Postgres) && (request.include_structure || request.include_objects) {
            match list_postgres_extension_members(state, &pool_key, &request.schema).await {
                Ok(members) => members,
                Err(e) => {
                    record_export_error(&mut file, request.fail_on_error, format!("reading extension members: {e}"))?;
                    PostgresExtensionMembers::default()
                }
            }
        } else {
            PostgresExtensionMembers::default()
        };
    let postgres_extensions = if request.include_structure && matches!(db_type, DatabaseType::Postgres) {
        match crate::schema::list_extensions_core(state, &request.connection_id, &request.database, &request.schema)
            .await
        {
            Ok(extensions) => extensions
                .into_iter()
                .map(|extension| PostgresExportExtension {
                    name: extension.name,
                    schema: extension.schema.unwrap_or_else(|| request.schema.clone()),
                })
                .collect(),
            Err(e) => {
                record_export_error(&mut file, request.fail_on_error, format!("exporting extensions: {e}"))?;
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };
    let all_tables = filter_export_table_infos(all_tables, &request.selected_tables, &request.excluded_tables)
        .into_iter()
        .filter(|table| !postgres_extension_members.relation_names.contains(&table.name))
        .collect::<Vec<_>>();
    let mut tables: Vec<_> = all_tables.iter().filter(|t| !t.table_type.contains("VIEW")).collect();
    let views: Vec<_> = all_tables.iter().filter(|t| t.table_type.contains("VIEW")).collect();
    let postgres_sequences = if request.include_structure && matches!(db_type, DatabaseType::Postgres) {
        match list_postgres_export_sequences(
            state,
            &pool_key,
            &request.schema,
            &request.selected_tables,
            &request.excluded_tables,
            request.include_objects,
            request.fail_on_error,
        )
        .await
        {
            Ok(sequences) => sequences,
            Err(e) => {
                record_export_error(&mut file, request.fail_on_error, format!("exporting sequences: {e}"))?;
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };

    // Sort tables by foreign key dependency so referenced (parent) tables are
    // exported before referencing (child) tables.
    if tables.len() > 1 {
        let table_names: Vec<String> = tables.iter().map(|t| t.name.clone()).collect();
        match crate::transfer::sort_tables_by_fk_dependency(
            state,
            &request.connection_id,
            &request.database,
            &request.schema,
            &table_names,
            true,
        )
        .await
        {
            Ok(sorted_names) => {
                tables.sort_by_key(|t| sorted_names.iter().position(|n| n == &t.name).unwrap_or(usize::MAX));
            }
            Err(error) if request.fail_on_error => {
                return Err(format!("Failed to resolve table dependency order: {error}"));
            }
            Err(_) => {}
        }
    }

    // 8. Calculate total objects
    let mut total_objects = tables.len() + views.len() + postgres_sequences.len() + postgres_extensions.len();

    // We'll add procedures/functions count later if include_objects
    let mut procedures: Vec<crate::types::ObjectInfo> = Vec::new();
    let mut functions: Vec<crate::types::ObjectInfo> = Vec::new();

    if request.include_objects && request.selected_tables.is_empty() {
        match crate::schema::list_objects_core(
            state,
            &request.connection_id,
            &request.database,
            &request.schema,
            None,
            None,
            None,
            None,
        )
        .await
        {
            Ok(objects) => {
                for obj in &objects {
                    let ot = obj.object_type.to_uppercase();
                    if is_postgres_extension_member_routine(obj, &postgres_extension_members) {
                        continue;
                    }
                    if ot.contains("PROCEDURE") {
                        procedures.push(obj.clone());
                    } else if ot.contains("FUNCTION") {
                        functions.push(obj.clone());
                    }
                }
            }
            Err(error) if request.fail_on_error => return Err(format!("Failed to list database objects: {error}")),
            Err(_) => {}
        }
        total_objects += procedures.len() + functions.len();
    }

    let mut object_index: usize = 0;

    // Export tables
    let batch_size = if request.batch_size == 0 { 1000 } else { request.batch_size };

    for extension in &postgres_extensions {
        if is_export_cancelled(&request.export_id).await {
            return Err("Export cancelled".to_string());
        }
        on_progress(ExportProgress {
            export_id: request.export_id.clone(),
            current_object: extension.name.clone(),
            object_index,
            total_objects,
            rows_exported: 0,
            total_rows: None,
            status: ExportStatus::Running,
            error: None,
        });
        writeln!(file, "{}\n", generate_postgres_extension_ddl(extension))
            .map_err(|e| format!("Failed to write file: {e}"))?;
        object_index += 1;
    }

    for sequence in postgres_sequences.iter().filter(|sequence| sequence.owner_table.is_none()) {
        if is_export_cancelled(&request.export_id).await {
            return Err("Export cancelled".to_string());
        }

        on_progress(ExportProgress {
            export_id: request.export_id.clone(),
            current_object: sequence.name.clone(),
            object_index,
            total_objects,
            rows_exported: 0,
            total_rows: None,
            status: ExportStatus::Running,
            error: None,
        });

        writeln!(file, "{};\n", generate_postgres_sequence_create_ddl(sequence, &request.schema))
            .map_err(|e| format!("Failed to write file: {e}"))?;
        object_index += 1;
    }

    // 预取各表的 DDL 与列元数据：逐表串行往返在多表数据库上是整库导出耗时的
    // 主要来源（每表 1-2 次网络往返 × 表数）。有界并发预取后，下方写出循环仍按
    // 原顺序消费，文件内容与逐表查询完全一致。
    struct PrefetchedTableMetadata {
        ddl: Option<Result<String, String>>,
        columns: Option<Result<Vec<crate::db::ColumnInfo>, String>>,
    }
    const EXPORT_METADATA_PREFETCH_CONCURRENCY: usize = 8;
    let mut prefetched_table_metadata: Vec<Option<PrefetchedTableMetadata>> = Vec::new();
    prefetched_table_metadata.resize_with(tables.len(), || None);
    // 防护门按「实际连接池种类」放行，而非数据库类型的能力标记：只有确认底层
    // 支持并发请求的多连接池（Postgres/MySQL/ClickHouse）才启用并发预取。反例：
    // 原生 SQL Server 是 Arc<Mutex<..>> 串行客户端；Agent/外部 JDBC（含 SQL Server
    // legacy profile、PrestoSQL 等路由结果）的插件请求超时覆盖排队时间且超时会
    // 终止 sidecar；SQLite/DuckDB 等为单连接。被挡住的场景预取 Vec 保持全 None，
    // 写出循环内的 None 回退路径即原有的逐表串行直查行为。
    let concurrent_prefetch_is_safe =
        match state.get_or_create_pool(&request.connection_id, Some(&request.database)).await {
            Ok(metadata_pool_key) => {
                concurrent_metadata_prefetch_allowed(state.connections.read().await.get(&metadata_pool_key))
            }
            // 建池失败时不预取，让写出循环的直查路径按原有方式报告错误
            Err(_) => false,
        };
    if concurrent_prefetch_is_safe
        && (request.include_structure || request.include_data)
        && !tables.is_empty()
        && !is_export_cancelled(&request.export_id).await
    {
        use futures::StreamExt;
        let prefetch_targets: Vec<(usize, String)> =
            tables.iter().enumerate().map(|(index, table_info)| (index, table_info.name.clone())).collect();
        let mut prefetch_stream =
            futures::stream::iter(prefetch_targets.into_iter().map(|(index, table_name)| async move {
                if is_export_cancelled_now(&request.export_id) {
                    return (index, PrefetchedTableMetadata { ddl: None, columns: None });
                }
                let ddl = if request.include_structure {
                    Some(
                        crate::schema::get_table_ddl_core(
                            state,
                            &request.connection_id,
                            &request.database,
                            &request.schema,
                            &table_name,
                            None,
                        )
                        .await,
                    )
                } else {
                    None
                };
                if is_export_cancelled_now(&request.export_id) {
                    return (index, PrefetchedTableMetadata { ddl, columns: None });
                }
                let columns = if request.include_data {
                    Some(
                        crate::schema::get_columns_core(
                            state,
                            &request.connection_id,
                            &request.database,
                            &request.schema,
                            &table_name,
                        )
                        .await,
                    )
                } else {
                    None
                };
                (index, PrefetchedTableMetadata { ddl, columns })
            }))
            .buffer_unordered(EXPORT_METADATA_PREFETCH_CONCURRENCY);
        while let Some((index, metadata)) = prefetch_stream.next().await {
            prefetched_table_metadata[index] = Some(metadata);
            // 取消后不再调度新的预取任务（已在途的任务随 stream 释放而中止），
            // 写出循环入口的取消检查负责最终收尾
            if is_export_cancelled_now(&request.export_id) {
                break;
            }
        }
    }

    for (table_index, table_info) in tables.iter().enumerate() {
        // Check cancellation
        if is_export_cancelled(&request.export_id).await {
            on_progress(ExportProgress {
                export_id: request.export_id.clone(),
                current_object: table_info.name.clone(),
                object_index,
                total_objects,
                rows_exported: 0,
                total_rows: None,
                status: ExportStatus::Cancelled,
                error: None,
            });
            return Ok(());
        }

        let table_name = &table_info.name;

        // Emit Running progress
        on_progress(ExportProgress {
            export_id: request.export_id.clone(),
            current_object: table_name.clone(),
            object_index,
            total_objects,
            rows_exported: 0,
            total_rows: None,
            status: ExportStatus::Running,
            error: None,
        });

        // Export structure
        if request.include_structure {
            if request.drop_table_if_exists {
                writeln!(file, "{}\n", drop_table_if_exists_sql(table_name, &request.schema, &db_type))
                    .map_err(|e| format!("Failed to write file: {e}"))?;
            }
            for sequence in postgres_sequences
                .iter()
                .filter(|sequence| sequence.owner_table.as_deref() == Some(table_name.as_str()))
            {
                on_progress(ExportProgress {
                    export_id: request.export_id.clone(),
                    current_object: sequence.name.clone(),
                    object_index,
                    total_objects,
                    rows_exported: 0,
                    total_rows: None,
                    status: ExportStatus::Running,
                    error: None,
                });

                writeln!(file, "{};\n", generate_postgres_sequence_create_ddl(sequence, &request.schema))
                    .map_err(|e| format!("Failed to write file: {e}"))?;
                object_index += 1;
            }
            let ddl_result = match prefetched_table_metadata
                .get_mut(table_index)
                .and_then(|m| m.as_mut())
                .and_then(|m| m.ddl.take())
            {
                Some(result) => result,
                None => {
                    crate::schema::get_table_ddl_core(
                        state,
                        &request.connection_id,
                        &request.database,
                        &request.schema,
                        table_name,
                        None,
                    )
                    .await
                }
            };
            match ddl_result {
                Ok(ddl) => {
                    let ddl = normalize_export_table_ddl(&ddl, Some(db_type));
                    writeln!(file, "{};\n", ddl).map_err(|e| format!("Failed to write file: {e}"))?;
                }
                Err(e) => {
                    record_export_error(
                        &mut file,
                        request.fail_on_error,
                        format!("exporting table structure {table_name}: {e}"),
                    )?;
                }
            }
        }

        // Export data
        if request.include_data {
            // Get columns
            let columns_result = match prefetched_table_metadata
                .get_mut(table_index)
                .and_then(|m| m.as_mut())
                .and_then(|m| m.columns.take())
            {
                Some(result) => result,
                None => {
                    crate::schema::get_columns_core(
                        state,
                        &request.connection_id,
                        &request.database,
                        &request.schema,
                        table_name,
                    )
                    .await
                }
            };
            let columns = match columns_result {
                Ok(cols) => cols,
                Err(e) => {
                    record_export_error(
                        &mut file,
                        request.fail_on_error,
                        format!("exporting columns for table {table_name}: {e}"),
                    )?;
                    object_index += 1;
                    continue;
                }
            };
            let col_names = columns.iter().map(|c| c.name.clone()).collect::<Vec<_>>();
            let col_types = columns.iter().map(|c| Some(c.data_type.clone())).collect::<Vec<_>>();
            let col_extras = columns.iter().map(|c| c.extra.clone()).collect::<Vec<_>>();

            if !col_names.is_empty() {
                if let Some(snapshot_session_id) = request.snapshot_session_id.as_deref() {
                    let sql = database_export_select_sql(&col_names, table_name, &request.schema, &db_type);
                    let mut rows_exported = 0_u64;
                    crate::query::stream_rows_in_manual_transaction(
                        state,
                        snapshot_session_id,
                        &sql,
                        batch_size,
                        |rows| {
                            if is_export_cancelled_now(&request.export_id) {
                                return Err("Export cancelled".to_string());
                            }
                            write_database_export_rows(
                                &mut file,
                                &rows,
                                &col_names,
                                &col_types,
                                &col_extras,
                                table_name,
                                &request.schema,
                                &db_type,
                            )?;
                            rows_exported += rows.len() as u64;
                            on_progress(ExportProgress {
                                export_id: request.export_id.clone(),
                                current_object: table_name.clone(),
                                object_index,
                                total_objects,
                                rows_exported,
                                total_rows: None,
                                status: ExportStatus::Running,
                                error: None,
                            });
                            Ok(())
                        },
                    )
                    .await?;
                } else {
                    let count_query = crate::transfer::count_sql(table_name, &request.schema, &db_type);
                    let total_rows = match crate::transfer::execute_read_on_pool(state, &pool_key, &count_query).await {
                        Ok(result) => {
                            let count = result.rows.first().and_then(|row| row.first()).and_then(|value| match value {
                                serde_json::Value::Number(number) => number.as_u64(),
                                serde_json::Value::String(text) => text.parse::<u64>().ok(),
                                _ => None,
                            });
                            if request.fail_on_error && count.is_none() {
                                return Err(format!("Failed to read row count for table {table_name}"));
                            }
                            count
                        }
                        Err(error) if request.fail_on_error => {
                            return Err(format!("Failed to read row count for table {table_name}: {error}"));
                        }
                        Err(_) => None,
                    };
                    let mut offset = 0_u64;
                    let mut rows_exported = 0_u64;

                    loop {
                        if is_export_cancelled(&request.export_id).await {
                            on_progress(ExportProgress {
                                export_id: request.export_id.clone(),
                                current_object: table_name.clone(),
                                object_index,
                                total_objects,
                                rows_exported,
                                total_rows,
                                status: ExportStatus::Cancelled,
                                error: None,
                            });
                            return Ok(());
                        }

                        let sql = crate::transfer::pagination_sql(
                            &col_names,
                            table_name,
                            &request.schema,
                            &db_type,
                            offset,
                            batch_size,
                        );
                        let result = match crate::transfer::execute_read_on_pool(state, &pool_key, &sql).await {
                            Ok(result) => result,
                            Err(error) => {
                                record_export_error(
                                    &mut file,
                                    request.fail_on_error,
                                    format!("exporting data for table {table_name}: {error}"),
                                )?;
                                break;
                            }
                        };
                        let row_count = result.rows.len();
                        if row_count == 0 {
                            break;
                        }
                        write_database_export_rows(
                            &mut file,
                            &result.rows,
                            &col_names,
                            &col_types,
                            &col_extras,
                            table_name,
                            &request.schema,
                            &db_type,
                        )?;
                        rows_exported += row_count as u64;
                        offset += row_count as u64;
                        on_progress(ExportProgress {
                            export_id: request.export_id.clone(),
                            current_object: table_name.clone(),
                            object_index,
                            total_objects,
                            rows_exported,
                            total_rows,
                            status: ExportStatus::Running,
                            error: None,
                        });
                        if row_count < batch_size {
                            break;
                        }
                    }
                }
            }
        }

        object_index += 1;
    }

    if request.include_structure && !postgres_sequences.is_empty() {
        for sequence in &postgres_sequences {
            if let Some(sql) = generate_postgres_sequence_owner_ddl(sequence, &request.schema) {
                writeln!(file, "{};\n", sql).map_err(|e| format!("Failed to write file: {e}"))?;
            }
        }
        for sequence in &postgres_sequences {
            if let Some(sql) = generate_postgres_sequence_setval_sql(sequence, &request.schema) {
                writeln!(file, "{};\n", sql).map_err(|e| format!("Failed to write file: {e}"))?;
            }
        }
    }

    // Export views (if include_objects)
    if request.include_objects {
        for view_info in &views {
            if is_export_cancelled(&request.export_id).await {
                return Err("Export cancelled".to_string());
            }

            let view_name = &view_info.name;

            on_progress(ExportProgress {
                export_id: request.export_id.clone(),
                current_object: view_name.clone(),
                object_index,
                total_objects,
                rows_exported: 0,
                total_rows: None,
                status: ExportStatus::Running,
                error: None,
            });

            match crate::schema::get_object_source_core(
                state,
                &request.connection_id,
                &request.database,
                &request.schema,
                view_name,
                crate::db::ObjectSourceKind::View,
                None,
            )
            .await
            {
                Ok(obj_source) => {
                    let source =
                        build_export_object_source_sql(db_type, crate::db::ObjectSourceKind::View, &obj_source.source);
                    if !source.is_empty() {
                        writeln!(file, "{source}\n").map_err(|e| format!("Failed to write file: {e}"))?;
                    }
                }
                Err(e) => {
                    record_export_error(&mut file, request.fail_on_error, format!("exporting view {view_name}: {e}"))?;
                }
            }

            object_index += 1;
        }

        // Export procedures
        for procedure in &procedures {
            if is_export_cancelled(&request.export_id).await {
                return Err("Export cancelled".to_string());
            }

            let proc_name = &procedure.name;

            on_progress(ExportProgress {
                export_id: request.export_id.clone(),
                current_object: proc_name.clone(),
                object_index,
                total_objects,
                rows_exported: 0,
                total_rows: None,
                status: ExportStatus::Running,
                error: None,
            });

            match crate::schema::get_object_source_core(
                state,
                &request.connection_id,
                &request.database,
                &request.schema,
                proc_name,
                crate::db::ObjectSourceKind::Procedure,
                procedure.signature.as_deref(),
            )
            .await
            {
                Ok(obj_source) => {
                    let source = build_export_object_source_sql(
                        db_type,
                        crate::db::ObjectSourceKind::Procedure,
                        &obj_source.source,
                    );
                    if !source.is_empty() {
                        writeln!(file, "{source}\n").map_err(|e| format!("Failed to write file: {e}"))?;
                    }
                }
                Err(e) => {
                    record_export_error(
                        &mut file,
                        request.fail_on_error,
                        format!("exporting procedure {proc_name}: {e}"),
                    )?;
                }
            }

            object_index += 1;
        }

        // Export functions
        for function in &functions {
            if is_export_cancelled(&request.export_id).await {
                return Err("Export cancelled".to_string());
            }

            let func_name = &function.name;

            on_progress(ExportProgress {
                export_id: request.export_id.clone(),
                current_object: func_name.clone(),
                object_index,
                total_objects,
                rows_exported: 0,
                total_rows: None,
                status: ExportStatus::Running,
                error: None,
            });

            match crate::schema::get_object_source_core(
                state,
                &request.connection_id,
                &request.database,
                &request.schema,
                func_name,
                crate::db::ObjectSourceKind::Function,
                function.signature.as_deref(),
            )
            .await
            {
                Ok(obj_source) => {
                    let source = build_export_object_source_sql(
                        db_type,
                        crate::db::ObjectSourceKind::Function,
                        &obj_source.source,
                    );
                    if !source.is_empty() {
                        writeln!(file, "{source}\n").map_err(|e| format!("Failed to write file: {e}"))?;
                    }
                }
                Err(e) => {
                    record_export_error(
                        &mut file,
                        request.fail_on_error,
                        format!("exporting function {func_name}: {e}"),
                    )?;
                }
            }

            object_index += 1;
        }
    }

    // For MySQL: re-enable foreign key checks
    if matches!(db_type, DatabaseType::Mysql) {
        writeln!(file, "SET FOREIGN_KEY_CHECKS = 1;").map_err(|e| format!("Failed to write file: {e}"))?;
    }

    // Emit Done progress
    on_progress(ExportProgress {
        export_id: request.export_id.clone(),
        current_object: String::new(),
        object_index,
        total_objects,
        rows_exported: 0,
        total_rows: None,
        status: ExportStatus::Done,
        error: None,
    });

    Ok(())
}

fn filter_export_table_infos(
    tables: Vec<crate::types::TableInfo>,
    selected_tables: &[String],
    excluded_tables: &[String],
) -> Vec<crate::types::TableInfo> {
    let selected: HashSet<&str> = selected_tables.iter().map(String::as_str).collect();
    let excluded: HashSet<&str> = excluded_tables.iter().map(String::as_str).collect();
    tables
        .into_iter()
        .filter(|table| selected.is_empty() || selected.contains(table.name.as_str()))
        .filter(|table| !excluded.contains(table.name.as_str()))
        .collect()
}

fn drop_table_if_exists_sql(table_name: &str, schema: &str, db_type: &DatabaseType) -> String {
    format!("DROP TABLE IF EXISTS {};", crate::transfer::qualified_table(table_name, schema, db_type))
}

#[cfg(test)]
mod tests {
    use super::concurrent_metadata_prefetch_allowed;
    use super::{
        build_database_sql_export, build_export_insert_statements, drop_table_if_exists_sql, filter_export_table_infos,
        format_export_sql_literal, generate_postgres_extension_ddl, generate_postgres_sequence_create_ddl,
        generate_postgres_sequence_owner_ddl, generate_postgres_sequence_setval_sql,
        is_postgres_extension_member_routine, normalize_export_table_ddl, record_export_error,
        BuildDatabaseSqlExportOptions, BuildExportInsertStatementsOptions, ExportedTableSql, PostgresExportExtension,
        PostgresExportSequence, PostgresExtensionMembers, DATABASE_EXPORT_INSERT_BATCH_SIZE, DATABASE_EXPORT_ROW_LIMIT,
    };
    use crate::models::connection::DatabaseType;
    use crate::types::{ObjectInfo, TableInfo};
    use serde_json::{json, Value};

    fn table(name: &str, table_type: &str) -> TableInfo {
        TableInfo {
            name: name.to_string(),
            table_type: table_type.to_string(),
            comment: None,
            parent_schema: None,
            parent_name: None,
        }
    }

    fn routine(name: &str, signature: &str) -> ObjectInfo {
        ObjectInfo {
            name: name.to_string(),
            object_type: "FUNCTION".to_string(),
            schema: Some("public".to_string()),
            valid: None,
            signature: Some(signature.to_string()),
            comment: None,
            created_at: None,
            updated_at: None,
            parent_schema: None,
            parent_name: None,
        }
    }

    #[test]
    fn postgres_extension_ddl_uses_target_default_version_and_source_schema() {
        let extension = PostgresExportExtension { name: "pg_trgm".to_string(), schema: "addons".to_string() };

        let ddl = generate_postgres_extension_ddl(&extension);

        assert_eq!(ddl, "CREATE EXTENSION IF NOT EXISTS \"pg_trgm\" WITH SCHEMA \"addons\";");
        assert!(!ddl.contains("VERSION"));
    }

    #[test]
    fn postgres_extension_member_filter_keeps_user_overload_with_same_name() {
        let mut members = PostgresExtensionMembers::default();
        members.function_keys.insert(("similarity".to_string(), "text, text".to_string()));

        assert!(is_postgres_extension_member_routine(&routine("similarity", "text, text"), &members));
        assert!(!is_postgres_extension_member_routine(&routine("similarity", "integer, integer"), &members));
        assert!(!is_postgres_extension_member_routine(&routine("user_similarity", "text, text"), &members));
    }

    #[test]
    fn concurrent_prefetch_only_allowed_for_multi_connection_pools() {
        use crate::connection::PoolKind;
        use std::sync::Arc;

        // ChClient::new 只构造 HTTP 客户端，不发起连接
        let clickhouse = PoolKind::ClickHouse(crate::db::clickhouse_driver::ChClient::new(
            "http://127.0.0.1:1",
            None,
            None,
            std::time::Duration::from_secs(1),
        ));
        assert!(concurrent_metadata_prefetch_allowed(Some(&clickhouse)));

        // Agent（JDBC sidecar）请求超时覆盖排队时间，必须回退串行
        let agent =
            PoolKind::Agent(Arc::new(tokio::sync::Mutex::new(crate::db::agent_driver::AgentDriverClient::test_stub())));
        assert!(!concurrent_metadata_prefetch_allowed(Some(&agent)));

        assert!(!concurrent_metadata_prefetch_allowed(None));
    }

    #[test]
    fn filters_export_tables_by_selected_names() {
        let tables = vec![table("users", "TABLE"), table("orders", "TABLE"), table("active_users", "VIEW")];

        let filtered = filter_export_table_infos(tables, &["active_users".to_string(), "users".to_string()], &[]);

        assert_eq!(filtered.iter().map(|table| table.name.as_str()).collect::<Vec<_>>(), vec!["users", "active_users"]);
    }

    #[test]
    fn keeps_all_export_tables_when_selection_is_empty() {
        let tables = vec![table("users", "TABLE"), table("orders", "TABLE")];

        let filtered = filter_export_table_infos(tables.clone(), &[], &[]);

        assert_eq!(filtered.iter().map(|table| table.name.as_str()).collect::<Vec<_>>(), vec!["users", "orders"]);
    }

    #[test]
    fn excludes_export_tables_by_name() {
        let tables = vec![table("users", "TABLE"), table("audit_log", "TABLE"), table("active_users", "VIEW")];

        let filtered = filter_export_table_infos(tables, &[], &["audit_log".to_string(), "active_users".to_string()]);

        assert_eq!(filtered.iter().map(|table| table.name.as_str()).collect::<Vec<_>>(), vec!["users"]);
    }

    #[test]
    fn exclusions_take_precedence_over_selected_tables() {
        let tables = vec![table("users", "TABLE"), table("orders", "TABLE")];

        let filtered =
            filter_export_table_infos(tables, &["users".to_string(), "orders".to_string()], &["orders".to_string()]);

        assert_eq!(filtered.iter().map(|table| table.name.as_str()).collect::<Vec<_>>(), vec!["users"]);
    }

    #[test]
    fn builds_drop_table_if_exists_with_qualified_mysql_name() {
        let sql = drop_table_if_exists_sql("users", "app", &DatabaseType::Mysql);

        assert_eq!(sql, "DROP TABLE IF EXISTS `users`;");
    }

    #[test]
    fn builds_drop_table_if_exists_without_empty_schema() {
        let sql = drop_table_if_exists_sql("users", "", &DatabaseType::Postgres);

        assert_eq!(sql, "DROP TABLE IF EXISTS \"users\";");
    }

    #[test]
    fn formats_sql_literals_for_export_inserts() {
        assert_eq!(format_export_sql_literal(&Value::Null), "NULL");
        assert_eq!(format_export_sql_literal(&json!(42)), "42");
        assert_eq!(format_export_sql_literal(&json!(true)), "TRUE");
        assert_eq!(format_export_sql_literal(&json!("O'Hara")), "'O''Hara'");
    }

    #[test]
    fn mysql_export_inserts_escape_control_characters() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Mysql),
            schema: None,
            table_name: Some("notes".to_string()),
            qualified_table_name: None,
            columns: vec!["body".to_string()],
            column_types: vec![Some("text".to_string())],
            column_extras: Vec::new(),
            rows: vec![vec![json!("line1\nline2\tcol\rend\\slash\0\x1aO'Hara")]],
            batch_size: Some(10),
        })
        .unwrap();

        assert_eq!(
            statements,
            vec!["INSERT INTO `notes` (`body`) VALUES ('line1\\nline2\\tcol\\rend\\\\slash\\0\\ZO''Hara');"]
        );
    }

    #[test]
    fn doris_export_inserts_escape_control_characters() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Doris),
            schema: Some("warehouse".to_string()),
            table_name: Some("events".to_string()),
            qualified_table_name: None,
            columns: vec!["message".to_string()],
            column_types: vec![Some("varchar(255)".to_string())],
            column_extras: Vec::new(),
            rows: vec![vec![json!("first\nsecond\tthird")]],
            batch_size: Some(10),
        })
        .unwrap();

        assert_eq!(statements, vec!["INSERT INTO `warehouse`.`events` (`message`) VALUES ('first\\nsecond\\tthird');"]);
    }

    #[test]
    fn postgres_export_inserts_keep_literal_control_characters() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Postgres),
            schema: Some("public".to_string()),
            table_name: Some("notes".to_string()),
            qualified_table_name: None,
            columns: vec!["body".to_string()],
            column_types: vec![Some("text".to_string())],
            column_extras: Vec::new(),
            rows: vec![vec![json!("line1\nline2\tend")]],
            batch_size: Some(10),
        })
        .unwrap();

        assert_eq!(statements, vec!["INSERT INTO \"public\".\"notes\" (\"body\") VALUES ('line1\nline2\tend');"]);
    }

    #[test]
    fn postgres_jsonb_export_preserves_json_escape_sequences() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Postgres),
            schema: Some("public".to_string()),
            table_name: Some("events".to_string()),
            qualified_table_name: None,
            columns: vec!["payload".to_string()],
            column_types: vec![Some("jsonb".to_string())],
            column_extras: Vec::new(),
            rows: vec![vec![json!(r#"{"text":"say \"hi\"","path":"C:\\tmp","quote":"O'Hara"}"#)]],
            batch_size: Some(10),
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![
                r#"INSERT INTO "public"."events" ("payload") VALUES ('{"text":"say \"hi\"","path":"C:\\tmp","quote":"O''Hara"}');"#
            ]
        );
    }

    #[test]
    fn postgres_vector_export_preserves_pgvector_bracket_literals() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Postgres),
            schema: Some("public".to_string()),
            table_name: Some("items".to_string()),
            qualified_table_name: None,
            columns: vec![
                "id".to_string(),
                "embedding".to_string(),
                "qualified_embedding".to_string(),
                "labels".to_string(),
            ],
            column_types: vec![
                Some("integer".to_string()),
                Some("vector(2)".to_string()),
                Some("public.vector".to_string()),
                Some("text[]".to_string()),
            ],
            column_extras: Vec::new(),
            rows: vec![vec![json!(1), json!([1.2, 3.4]), json!(["5", "6"]), json!(["x", "y"])]],
            batch_size: Some(10),
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![
                r#"INSERT INTO "public"."items" ("id", "embedding", "qualified_embedding", "labels") VALUES (1, '[1.2,3.4]', '[5,6]', '{"x","y"}');"#
            ]
        );
    }

    #[test]
    fn builds_batched_insert_statements_for_export() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Mysql),
            schema: None,
            table_name: Some("users".to_string()),
            qualified_table_name: None,
            columns: vec!["id".to_string(), "name".to_string()],
            column_types: Vec::new(),
            column_extras: Vec::new(),
            rows: vec![vec![json!(1), json!("Ada")], vec![json!(2), json!("O'Hara")], vec![json!(3), json!("Linus")]],
            batch_size: Some(2),
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![
                "INSERT INTO `users` (`id`, `name`) VALUES (1, 'Ada'), (2, 'O''Hara');",
                "INSERT INTO `users` (`id`, `name`) VALUES (3, 'Linus');",
            ]
        );
    }

    #[test]
    fn oracle_export_inserts_use_one_statement_per_row() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Oracle),
            schema: Some("APP".to_string()),
            table_name: Some("USERS".to_string()),
            qualified_table_name: None,
            columns: vec!["ID".to_string(), "NAME".to_string()],
            column_types: Vec::new(),
            column_extras: Vec::new(),
            rows: vec![vec![json!(1), json!("Ada")], vec![json!(2), json!("Linus")]],
            batch_size: Some(100),
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![
                "INSERT INTO \"APP\".\"USERS\" (\"ID\", \"NAME\") VALUES (1, 'Ada');",
                "INSERT INTO \"APP\".\"USERS\" (\"ID\", \"NAME\") VALUES (2, 'Linus');",
            ]
        );
    }

    #[test]
    fn oracle_export_omits_synthetic_rowid_from_insert_columns() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Oracle),
            schema: Some("APP".to_string()),
            table_name: Some("USERS".to_string()),
            qualified_table_name: None,
            columns: vec!["__DBX_ROWID".to_string(), "ID".to_string(), "NAME".to_string()],
            column_types: vec![Some("VARCHAR2".to_string()), Some("NUMBER".to_string()), Some("VARCHAR2".to_string())],
            column_extras: Vec::new(),
            rows: vec![vec![json!("AAAPr9AAEAAAAGfAAA"), json!(1), json!("Ada")]],
            batch_size: Some(100),
        })
        .unwrap();

        assert_eq!(statements, vec!["INSERT INTO \"APP\".\"USERS\" (\"ID\", \"NAME\") VALUES (1, 'Ada');"]);
    }

    #[test]
    fn oceanbase_oracle_export_omits_synthetic_rowid_from_insert_columns() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::OceanbaseOracle),
            schema: Some("APP".to_string()),
            table_name: Some("USERS".to_string()),
            qualified_table_name: None,
            columns: vec!["__DBX_ROWID".to_string(), "ID".to_string(), "NAME".to_string()],
            column_types: vec![Some("VARCHAR2".to_string()), Some("NUMBER".to_string()), Some("VARCHAR2".to_string())],
            column_extras: Vec::new(),
            rows: vec![vec![json!("*AAABk1AAEAAAAAgAAA"), json!(1), json!("Ada")]],
            batch_size: Some(100),
        })
        .unwrap();

        assert_eq!(statements, vec!["INSERT INTO \"APP\".\"USERS\" (\"ID\", \"NAME\") VALUES (1, 'Ada');"]);
    }

    #[test]
    fn non_oracle_export_preserves_dbx_rowid_named_column() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Mysql),
            schema: None,
            table_name: Some("users".to_string()),
            qualified_table_name: None,
            columns: vec!["__DBX_ROWID".to_string(), "name".to_string()],
            column_types: Vec::new(),
            column_extras: Vec::new(),
            rows: vec![vec![json!(7), json!("Ada")]],
            batch_size: Some(100),
        })
        .unwrap();

        assert_eq!(statements, vec!["INSERT INTO `users` (`__DBX_ROWID`, `name`) VALUES (7, 'Ada');"]);
    }

    #[test]
    fn oracle_date_columns_export_as_date_literals() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Oracle),
            schema: Some("APP".to_string()),
            table_name: Some("EVENTS".to_string()),
            qualified_table_name: None,
            columns: vec!["ID".to_string(), "CREATED_ON".to_string(), "RAW_TEXT".to_string()],
            column_types: vec![Some("NUMBER".to_string()), Some("DATE".to_string()), Some("VARCHAR2(64)".to_string())],
            column_extras: Vec::new(),
            rows: vec![
                vec![json!(1), json!("2022-08-25T09:58:43Z"), json!("2022-08-25T09:58:43Z")],
                vec![json!(2), json!("2022-08-25T00:00:00Z"), json!("2022-08-25T00:00:00Z")],
            ],
            batch_size: Some(100),
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![
                "INSERT INTO \"APP\".\"EVENTS\" (\"ID\", \"CREATED_ON\", \"RAW_TEXT\") VALUES (1, TO_DATE('2022-08-25 09:58:43', 'YYYY-MM-DD HH24:MI:SS'), '2022-08-25T09:58:43Z');",
                "INSERT INTO \"APP\".\"EVENTS\" (\"ID\", \"CREATED_ON\", \"RAW_TEXT\") VALUES (2, DATE '2022-08-25', '2022-08-25T00:00:00Z');",
            ]
        );
    }

    #[test]
    fn mysql_bit_columns_export_without_quoted_string_values() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Mysql),
            schema: None,
            table_name: Some("flags".to_string()),
            qualified_table_name: None,
            columns: vec!["enabled".to_string(), "mask".to_string(), "label".to_string()],
            column_types: vec![Some("bit(1)".to_string()), Some("BIT(4)".to_string()), Some("varchar(20)".to_string())],
            column_extras: Vec::new(),
            rows: vec![vec![json!("1"), json!("1010"), json!("1010")], vec![json!(false), json!(3), json!("off")]],
            batch_size: Some(10),
        })
        .unwrap();

        assert_eq!(
            statements,
            vec!["INSERT INTO `flags` (`enabled`, `mask`, `label`) VALUES (b'1', b'1010', '1010'), (b'0', 3, 'off');"]
        );
    }

    #[test]
    fn dameng_bit_columns_export_as_numeric_literals() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Dameng),
            schema: Some("DBX_TEST".to_string()),
            table_name: Some("FLAGS".to_string()),
            qualified_table_name: None,
            columns: vec!["ENABLED".to_string(), "DELETED".to_string(), "OPTIONAL".to_string()],
            column_types: vec![Some("BIT".to_string()), Some("bit".to_string()), Some("BIT".to_string())],
            column_extras: Vec::new(),
            rows: vec![vec![json!(true), json!(false), Value::Null]],
            batch_size: Some(10),
        })
        .unwrap();

        assert_eq!(
            statements,
            vec!["INSERT INTO \"DBX_TEST\".\"FLAGS\" (\"ENABLED\", \"DELETED\", \"OPTIONAL\") VALUES (1, 0, NULL);"]
        );
    }

    #[test]
    fn mysql_export_uses_typed_literals_for_numeric_and_blob_columns() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Mysql),
            schema: None,
            table_name: Some("t_test_01".to_string()),
            qualified_table_name: None,
            columns: vec!["id".to_string(), "f_blob".to_string(), "note".to_string()],
            column_types: vec![Some("int".to_string()), Some("blob".to_string()), Some("varchar(64)".to_string())],
            column_extras: Vec::new(),
            rows: vec![
                vec![json!("1"), json!("0x68656c6c6f"), json!("0x68656c6c6f")],
                vec![json!("2"), json!("0X"), json!("1")],
            ],
            batch_size: Some(10),
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![
                "INSERT INTO `t_test_01` (`id`, `f_blob`, `note`) VALUES (1, 0x68656c6c6f, '0x68656c6c6f'), (2, X'', '1');"
            ]
        );
    }

    #[test]
    fn temporal_columns_export_without_rfc3339_separator_or_utc_suffix() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Mysql),
            schema: None,
            table_name: Some("events".to_string()),
            qualified_table_name: None,
            columns: vec!["id".to_string(), "created_at".to_string(), "created_on".to_string(), "raw_text".to_string()],
            column_types: vec![
                Some("int".to_string()),
                Some("timestamp".to_string()),
                Some("date".to_string()),
                Some("varchar(64)".to_string()),
            ],
            column_extras: Vec::new(),
            rows: vec![vec![
                json!(1),
                json!("2026-06-12T10:11:12.123456789Z"),
                json!("2026-06-12T10:11:12Z"),
                json!("2026-06-12T10:11:12Z"),
            ]],
            batch_size: Some(10),
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![
                "INSERT INTO `events` (`id`, `created_at`, `created_on`, `raw_text`) VALUES (1, '2026-06-12 10:11:12.123456', '2026-06-12', '2026-06-12T10:11:12Z');"
            ]
        );
    }

    #[test]
    fn postgres_timestamptz_export_keeps_timezone_without_rfc3339_t_separator() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Postgres),
            schema: Some("public".to_string()),
            table_name: Some("events".to_string()),
            qualified_table_name: None,
            columns: vec!["recorded_at".to_string(), "local_at".to_string()],
            column_types: vec![
                Some("timestamp with time zone".to_string()),
                Some("timestamp without time zone".to_string()),
            ],
            column_extras: Vec::new(),
            rows: vec![vec![json!("2026-06-12T10:11:12Z"), json!("2026-06-12T18:11:12+08:00")]],
            batch_size: Some(10),
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![
                "INSERT INTO \"public\".\"events\" (\"recorded_at\", \"local_at\") VALUES ('2026-06-12 10:11:12+00:00', '2026-06-12 18:11:12');"
            ]
        );
    }

    #[test]
    fn sqlserver_rowversion_timestamp_type_is_not_treated_as_datetime() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::SqlServer),
            schema: Some("dbo".to_string()),
            table_name: Some("events".to_string()),
            qualified_table_name: None,
            columns: vec!["row_version".to_string(), "created_at".to_string()],
            column_types: vec![Some("timestamp".to_string()), Some("datetime2(3)".to_string())],
            column_extras: Vec::new(),
            rows: vec![vec![json!("2026-06-12T10:11:12Z"), json!("2026-06-12T10:11:12.1234567Z")]],
            batch_size: Some(10),
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![
                "INSERT INTO [dbo].[events] ([row_version], [created_at]) VALUES ('2026-06-12T10:11:12Z', '2026-06-12 10:11:12.123');"
            ]
        );
    }

    #[test]
    fn postgres_tsvector_columns_are_omitted_from_sql_insert_export() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Postgres),
            schema: Some("public".to_string()),
            table_name: Some("articles".to_string()),
            qualified_table_name: None,
            columns: vec!["id".to_string(), "title".to_string(), "search_vector".to_string()],
            column_types: vec![Some("integer".to_string()), Some("text".to_string()), Some("tsvector".to_string())],
            column_extras: Vec::new(),
            rows: vec![vec![json!(1), json!("Hello"), json!("'hello':1A")]],
            batch_size: Some(10),
        })
        .unwrap();

        assert_eq!(statements, vec!["INSERT INTO \"public\".\"articles\" (\"id\", \"title\") VALUES (1, 'Hello');"]);
    }

    #[test]
    fn dameng_identity_export_inserts_enable_identity_insert() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Dameng),
            schema: Some("SYSDBA".to_string()),
            table_name: Some("USERS".to_string()),
            qualified_table_name: None,
            columns: vec!["ID".to_string(), "NAME".to_string()],
            column_types: vec![Some("INT".to_string()), Some("VARCHAR(20)".to_string())],
            column_extras: vec![Some("identity".to_string()), None],
            rows: vec![vec![json!(1), json!("Ada")]],
            batch_size: Some(10),
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![
                "SET IDENTITY_INSERT \"SYSDBA\".\"USERS\" ON;\nINSERT INTO \"SYSDBA\".\"USERS\" (\"ID\", \"NAME\") VALUES (1, 'Ada');\nSET IDENTITY_INSERT \"SYSDBA\".\"USERS\" OFF;"
            ]
        );
    }

    #[test]
    fn builds_database_sql_export_with_ddl_before_data() {
        let sql = build_database_sql_export(BuildDatabaseSqlExportOptions {
            database_name: "app".to_string(),
            exported_at: Some("2026-05-02T00:00:00.000Z".to_string()),
            tables: vec![ExportedTableSql {
                display_name: "users".to_string(),
                database_type: Some(DatabaseType::Mysql),
                schema: None,
                table_name: Some("users".to_string()),
                qualified_table_name: None,
                ddl: Some("CREATE TABLE `users` (`id` int);".to_string()),
                columns: vec!["id".to_string()],
                column_types: Vec::new(),
                column_extras: Vec::new(),
                rows: vec![vec![json!(1)]],
                truncated: true,
            }],
            row_limit_per_table: Some(DATABASE_EXPORT_ROW_LIMIT),
            insert_batch_size: Some(DATABASE_EXPORT_INSERT_BATCH_SIZE),
            connection_id: None,
            database: None,
            schema: None,
        })
        .unwrap();

        assert_eq!(
            sql,
            [
                "-- DBX database export".to_string(),
                "-- Database: app".to_string(),
                "-- Exported at: 2026-05-02T00:00:00.000Z".to_string(),
                format!("-- Row limit per table: {DATABASE_EXPORT_ROW_LIMIT}"),
                String::new(),
                "-- Structure for users".to_string(),
                "CREATE TABLE `users` (`id` int);".to_string(),
                String::new(),
                "-- Data for users".to_string(),
                format!("-- Exported rows: 1 (truncated at {DATABASE_EXPORT_ROW_LIMIT})"),
                "INSERT INTO `users` (`id`) VALUES (1);".to_string(),
                String::new(),
            ]
            .join("\n")
        );
    }

    #[test]
    fn normalizes_legacy_mysql_row_format_for_export_compatibility() {
        let ddl = "CREATE TABLE `wide_table` (\n  `payload` varchar(4096) DEFAULT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8 ROW_FORMAT=COMPACT";

        let normalized = normalize_export_table_ddl(ddl, Some(DatabaseType::Mysql));

        assert_eq!(
            normalized,
            "CREATE TABLE `wide_table` (\n  `payload` varchar(4096) DEFAULT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8 ROW_FORMAT=DYNAMIC"
        );
    }

    #[test]
    fn normalizes_lowercase_redundant_mysql_row_format_for_export_compatibility() {
        let ddl = "CREATE TABLE `wide_table` (`payload` varchar(4096)) engine=InnoDB row_format = redundant";

        let normalized = normalize_export_table_ddl(ddl, Some(DatabaseType::Mysql));

        assert_eq!(normalized, "CREATE TABLE `wide_table` (`payload` varchar(4096)) engine=InnoDB ROW_FORMAT=DYNAMIC");
    }

    #[test]
    fn preserves_non_legacy_or_non_mysql_row_formats() {
        let mysql_ddl = "CREATE TABLE `ok` (`payload` text) ENGINE=InnoDB ROW_FORMAT=COMPRESSED";
        let postgres_ddl = "CREATE TABLE users (payload text) ROW_FORMAT=COMPACT";

        assert_eq!(normalize_export_table_ddl(mysql_ddl, Some(DatabaseType::Mysql)), mysql_ddl);
        assert_eq!(normalize_export_table_ddl(postgres_ddl, Some(DatabaseType::Postgres)), postgres_ddl);
    }

    fn postgres_sequence(name: &str) -> PostgresExportSequence {
        PostgresExportSequence {
            name: name.to_string(),
            data_type: "integer".to_string(),
            start_value: "1".to_string(),
            min_value: "1".to_string(),
            max_value: "2147483647".to_string(),
            increment: "1".to_string(),
            cycle: false,
            cache_value: "1".to_string(),
            last_value: Some("42".to_string()),
            owner_table: Some("permissions".to_string()),
            owner_column: Some("id".to_string()),
        }
    }

    #[test]
    fn postgres_sequence_create_ddl_is_importable_before_table_ddl() {
        let ddl = generate_postgres_sequence_create_ddl(&postgres_sequence("permissions_id_seq"), "public");

        assert_eq!(
            ddl,
            [
                "CREATE SEQUENCE IF NOT EXISTS \"public\".\"permissions_id_seq\"",
                "  AS integer",
                "  START WITH 1",
                "  INCREMENT BY 1",
                "  MINVALUE 1",
                "  MAXVALUE 2147483647",
                "  CACHE 1",
                "  NO CYCLE",
            ]
            .join("\n")
        );
    }

    #[test]
    fn postgres_sequence_owner_and_setval_sql_are_qualified() {
        let sequence = postgres_sequence("permissions_id_seq");

        assert_eq!(
            generate_postgres_sequence_owner_ddl(&sequence, "public").as_deref(),
            Some("ALTER SEQUENCE \"public\".\"permissions_id_seq\" OWNED BY \"public\".\"permissions\".\"id\"")
        );
        assert_eq!(
            generate_postgres_sequence_setval_sql(&sequence, "public").as_deref(),
            Some(
                "SELECT setval('\"public\".\"permissions_id_seq\"', GREATEST(COALESCE(MAX(\"id\"), 42), 42), true) FROM \"public\".\"permissions\""
            )
        );
    }

    #[test]
    fn strict_exports_return_object_errors_instead_of_writing_error_comments() {
        let path = std::env::temp_dir().join(format!("dbx-strict-export-{}.sql", uuid::Uuid::new_v4()));
        let mut file = std::fs::File::create(&path).unwrap();

        let result = record_export_error(&mut file, true, "exporting table users: permission denied".to_string());
        drop(file);

        assert_eq!(result.unwrap_err(), "exporting table users: permission denied");
        assert!(std::fs::read_to_string(&path).unwrap().is_empty());
        let _ = std::fs::remove_file(path);
    }
}
