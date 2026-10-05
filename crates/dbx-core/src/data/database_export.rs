use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::io::{BufRead, BufWriter, Write};
use std::pin::Pin;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

use flate2::write::GzEncoder;
use flate2::Compression;

use crate::connection::task_client_session_id;
use crate::models::connection::DatabaseType;
use crate::mysql_ddl_normalize::DdlNormalizeOptions;
use crate::object_source_sql::build_export_object_source_sql;
use crate::sql::{SqlParsingOptions, SqlStatementSplitter};
use crate::sql_dialect::{qualified_table_name, uses_single_row_insert_statements};
use crate::transfer::{
    format_ch_array_sql_literal, format_pg_array_sql_literal, format_postgres_vector_sql_literal,
    is_identity_column_extra, is_mysql_generated_column_extra, is_postgres_generated_always_identity_extra,
    is_postgres_vector_type, keyset_pagination_sql_with_identifier_quote, quote_identifier,
    quote_postgres_string_literal, wrap_dameng_identity_insert_sql_for_table,
};
use crate::types::{ObjectSourceKind, SpatialColumn, SqlExportColumnSelection};

static EXPORT_CANCELLED: std::sync::LazyLock<RwLock<HashSet<String>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashSet::new()));

const EXPORT_CANCELLED_ERROR: &str = "Export cancelled";
const EXPORT_CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// MySQL scripts written by the exporter are always UTF-8: values are decoded off the
/// wire and reformatted into Rust strings before they are written, so the file encoding
/// never follows the connection charset. Declaring that encoding in the script keeps the
/// importing client's default out of the decoding decision -- a `latin1` `mysql` CLI (a
/// docker entrypoint initializing a container, for example) would otherwise re-encode
/// every non-ASCII value into mojibake (#10242). `mysqldump` writes the same statement
/// for the same reason.
const MYSQL_EXPORT_CHARSET_STATEMENT: &str = "SET NAMES utf8mb4;";

pub fn database_export_client_session_id(export_id: &str) -> String {
    task_client_session_id("database-export", export_id)
}

async fn database_export_query_options(
    state: &crate::connection::AppState,
    connection_id: &str,
    client_session_id: &str,
    max_rows: Option<usize>,
) -> crate::query::QueryExecutionOptions {
    let timeout_secs =
        state.configs.read().await.get(connection_id).map(|config| config.effective_query_timeout_secs()).unwrap_or(0);
    database_export_query_options_for_timeout(timeout_secs, client_session_id, max_rows)
}

fn database_export_query_options_for_timeout(
    timeout_secs: u64,
    client_session_id: &str,
    max_rows: Option<usize>,
) -> crate::query::QueryExecutionOptions {
    crate::query::QueryExecutionOptions {
        max_rows,
        timeout_secs: Some(timeout_secs),
        client_session_id: Some(client_session_id.to_string()),
        ..Default::default()
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseExportOutputCompression {
    #[default]
    None,
    Gzip,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SqlInsertMode {
    #[default]
    Batch,
    Single,
}

impl SqlInsertMode {
    pub(crate) const fn flush_each_row(self) -> bool {
        matches!(self, Self::Single)
    }

    pub(crate) const fn batch_size(self, default: usize) -> usize {
        if self.flush_each_row() || default == 0 {
            1
        } else {
            default
        }
    }
}

/// SQL dialect used to render exported INSERT statements.
///
/// `Source` preserves the database-specific output used by existing exports.
/// `Standard` emits portable SQL scalar literals and ANSI-delimited
/// identifiers while retaining the source database type for metadata rules
/// such as generated-column and synthetic-column omission.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SqlInsertDialect {
    #[default]
    Source,
    Standard,
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
    /// Include a MySQL `CREATE DATABASE IF NOT EXISTS` and `USE` preamble.
    /// The option is intentionally opt-in because it needs CREATE privileges
    /// when importing into a new server.
    #[serde(default)]
    pub include_create_database: bool,
    #[serde(default)]
    pub drop_table_if_exists: bool,
    /// Drop the table-level `AUTO_INCREMENT=N` clause from exported MySQL DDL,
    /// so the script can initialize a fresh database without pinning a sequence
    /// position. No-op for non-MySQL databases. Defaults to `false` (preserve).
    #[serde(default)]
    pub omit_auto_increment: bool,
    /// Decode JSON-style `\uXXXX` Unicode escapes back into literal characters
    /// in exported string literals, so values an application deliberately
    /// ASCII-escaped before storing (e.g. to keep Vietnamese text safe in a
    /// non-Unicode TEXT column) read as the original language directly in the
    /// `.sql` file. Opt-in; defaults to `false` to preserve the exact stored
    /// bytes on export/import round-trips.
    #[serde(default)]
    pub preserve_original_language: bool,
    #[serde(default)]
    pub fail_on_error: bool,
    /// Refuse to truncate an existing destination. Scheduled backups enable
    /// this because user-defined templates may resolve to a previous file.
    #[serde(default)]
    pub prevent_overwrite: bool,
    #[serde(default)]
    pub output_compression: DatabaseExportOutputCompression,
    #[serde(default)]
    pub insert_dialect: SqlInsertDialect,
    #[serde(default)]
    pub insert_mode: SqlInsertMode,
    #[serde(default)]
    pub snapshot_session_id: Option<String>,
    pub batch_size: usize,
    /// When set, the export is packaged as a `.zip` archive containing
    /// multiple `part-N.sql` entries (plus a `manifest.json`), each capped
    /// at this many megabytes, instead of one unbounded `.sql`/`.sql.gz`
    /// file. Mutually exclusive with `output_compression` -- a zip archive
    /// is its own compressed container.
    #[serde(default)]
    pub split_max_mb: Option<u32>,
}

enum DatabaseExportWriter {
    Plain(BufWriter<std::fs::File>),
    Gzip(Box<GzEncoder<BufWriter<std::fs::File>>>),
    SplitZip(Box<crate::export_split_zip::SplitZipExportWriter>),
}

impl DatabaseExportWriter {
    fn write_sql_unit(&mut self, unit: &[u8]) -> std::io::Result<()> {
        match self {
            Self::Plain(writer) => writer.write_all(unit),
            Self::Gzip(writer) => writer.write_all(unit),
            Self::SplitZip(writer) => writer.write_sql_unit(unit),
        }
    }
}

impl Write for DatabaseExportWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        match self {
            Self::Plain(writer) => writer.write(buffer),
            Self::Gzip(writer) => writer.write(buffer),
            Self::SplitZip(writer) => writer.write(buffer),
        }
    }

    fn write_fmt(&mut self, fmt: std::fmt::Arguments<'_>) -> std::io::Result<()> {
        let mut unit = String::new();
        std::fmt::write(&mut unit, fmt).map_err(|_| std::io::Error::other("Failed to format SQL export unit"))?;
        self.write_sql_unit(unit.as_bytes())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Self::Plain(writer) => writer.flush(),
            Self::Gzip(writer) => writer.flush(),
            Self::SplitZip(writer) => writer.flush(),
        }
    }
}

impl DatabaseExportWriter {
    fn finish(self, source_file_name: &str) -> Result<(), String> {
        match self {
            Self::Plain(mut writer) => {
                writer.flush().map_err(|error| format!("Failed to finalize export file: {error}"))
            }
            Self::Gzip(writer) => writer
                .finish()
                .and_then(|mut output| output.flush())
                .map_err(|error| format!("Failed to finalize export file: {error}")),
            Self::SplitZip(writer) => writer.finish(source_file_name),
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
struct DatabaseExportObjectCounts {
    tables: usize,
    views: usize,
    sequences: usize,
    extensions: usize,
    enums: usize,
    procedures: usize,
    functions: usize,
    triggers: usize,
    events: usize,
}

fn exports_database_tables(request: &DatabaseExportRequest) -> bool {
    request.include_structure || request.include_data
}

fn exports_database_routines(request: &DatabaseExportRequest) -> bool {
    // Routine export is schema-wide, so an explicit table selection must not
    // add unrelated procedures or functions to either execution or progress.
    exports_schema_wide_objects(request)
}

/// Schema-wide objects (routines, triggers, events) are exported as a whole. An explicit
/// table selection must not add unrelated objects to either execution or progress.
fn exports_schema_wide_objects(request: &DatabaseExportRequest) -> bool {
    request.include_objects && request.selected_tables.is_empty()
}

/// MySQL lists triggers and events as schema-wide objects (see
/// `crates/dbx-driver-mysql/src/mysql.rs`), which is what the export writes out. Other
/// engines either report triggers per table (PostgreSQL) or not at all, so their export
/// stays unchanged.
fn exports_mysql_trigger_objects(db_type: DatabaseType) -> bool {
    matches!(db_type, DatabaseType::Mysql)
}

fn database_export_total_objects(request: &DatabaseExportRequest, counts: &DatabaseExportObjectCounts) -> usize {
    let mut total = 0;
    if exports_database_tables(request) {
        total += counts.tables;
    }
    if request.include_structure {
        total += counts.sequences + counts.extensions + counts.enums;
    }
    if request.include_objects {
        total += counts.views;
    }
    if exports_database_routines(request) {
        total += counts.procedures + counts.functions;
    }
    if exports_schema_wide_objects(request) {
        total += counts.triggers + counts.events;
    }
    total
}

fn mysql_sql_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "''"))
}

fn mysql_view_dependencies_sql(database: &str) -> String {
    let database = mysql_sql_string_literal(database);
    format!(
        "SELECT VIEW_NAME, TABLE_NAME FROM information_schema.VIEW_TABLE_USAGE \
         WHERE VIEW_SCHEMA = {database} AND TABLE_SCHEMA = {database} \
         ORDER BY VIEW_NAME, TABLE_NAME"
    )
}

fn mysql_view_dependencies_from_rows(rows: &[Vec<Value>]) -> Vec<(String, String)> {
    rows.iter()
        .filter_map(|row| {
            let view_name = row.first()?.as_str()?.trim();
            let referenced_name = row.get(1)?.as_str()?.trim();
            (!view_name.is_empty() && !referenced_name.is_empty())
                .then(|| (view_name.to_string(), referenced_name.to_string()))
        })
        .collect()
}

async fn list_mysql_export_view_dependencies(
    state: &crate::connection::AppState,
    connection_id: &str,
    database: &str,
    client_session_id: &str,
) -> Result<Vec<(String, String)>, String> {
    let options = database_export_query_options(state, connection_id, client_session_id, Some(usize::MAX)).await;
    let result = crate::query::execute_sql_statement_with_options(
        state,
        connection_id,
        database,
        &mysql_view_dependencies_sql(database),
        None,
        None,
        options,
    )
    .await?;
    Ok(mysql_view_dependencies_from_rows(&result.rows))
}

fn sort_export_views_by_dependencies<'a>(
    views: &[&'a crate::types::TableInfo],
    dependencies: &[(String, String)],
) -> Vec<&'a crate::types::TableInfo> {
    let names = views.iter().map(|view| view.name.clone()).collect::<Vec<_>>();
    let sorted_names = crate::transfer::sort_table_names_by_dependencies(&names, dependencies, true);
    let views_by_name = views.iter().map(|view| (view.name.as_str(), *view)).collect::<HashMap<_, _>>();
    sorted_names.iter().filter_map(|name| views_by_name.get(name.as_str()).copied()).collect()
}

fn mysql_database_export_preamble(database: &str, charset: Option<&str>, collation: Option<&str>) -> String {
    let database = quote_identifier(database, &DatabaseType::Mysql);
    let charset = charset.map(str::trim).filter(|value| !value.is_empty());
    let collation = collation.map(str::trim).filter(|value| !value.is_empty());
    let options = match charset {
        Some(charset) => match collation {
            Some(collation) => format!(" CHARACTER SET {charset} COLLATE {collation}"),
            None => format!(" CHARACTER SET {charset}"),
        },
        None => String::new(),
    };
    format!("CREATE DATABASE IF NOT EXISTS {database}{options};\nUSE {database};\n")
}

async fn mysql_database_export_preamble_for_request(
    state: &crate::connection::AppState,
    request: &DatabaseExportRequest,
    client_session_id: &str,
) -> String {
    let metadata_sql = format!(
        "SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = {}",
        mysql_sql_string_literal(&request.database)
    );
    let options = database_export_query_options(state, &request.connection_id, client_session_id, Some(1)).await;
    let metadata = crate::query::execute_sql_statement_with_options(
        state,
        &request.connection_id,
        &request.database,
        &metadata_sql,
        None,
        None,
        options,
    )
    .await
    .ok()
    .and_then(|result| {
        result.rows.first().map(|row| {
            (
                row.first().and_then(Value::as_str).map(str::to_string),
                row.get(1).and_then(Value::as_str).map(str::to_string),
            )
        })
    });

    match metadata {
        Some((charset, collation)) => {
            mysql_database_export_preamble(&request.database, charset.as_deref(), collation.as_deref())
        }
        None => mysql_database_export_preamble(&request.database, None, None),
    }
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
    /// True while listing schema / prefetching table metadata — before objects are written.
    #[serde(default)]
    pub preparing: bool,
    /// Per-object failures written into the file as `-- ERROR` comments in
    /// lenient mode. Strict mode fails the whole export instead, so this stays
    /// zero. Without it a partially failed export reports plain success and
    /// the errors are only discoverable by opening the file (#8184).
    #[serde(default)]
    pub error_count: u64,
    /// First lenient failure, so completion surfaces can show what went wrong
    /// without opening the exported file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_summary: Option<String>,
}

/// Collects lenient per-object export failures for the terminal progress.
#[derive(Default)]
struct LenientExportErrors {
    count: usize,
    first: Option<String>,
}

impl LenientExportErrors {
    fn record(&mut self, message: String) {
        if self.first.is_none() {
            self.first = Some(message.clone());
        }
        self.count += 1;
    }
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
pub const DATABASE_EXPORT_TARGET_STATEMENT_BYTES: usize = 512 * 1024;

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
    created_by_table: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PostgresExportExtension {
    name: String,
    schema: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PostgresExportEnum {
    name: String,
    schema: String,
    labels: Vec<String>,
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
    pub identifier_quote: Option<String>,
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
    pub spatial_columns: Vec<SpatialColumn>,
    #[serde(default)]
    pub spatial_values: Vec<Vec<Option<u32>>>,
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
    pub identifier_quote: Option<String>,
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
    pub spatial_columns: Vec<SpatialColumn>,
    #[serde(default)]
    pub spatial_values: Vec<Vec<Option<u32>>>,
    #[serde(default)]
    pub rows: Vec<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_size: Option<usize>,
    /// Decode JSON-style `\uXXXX` Unicode escapes back into literal characters
    /// in exported string literals (e.g. `\u1ed0` -> `ố`). Opt-in and defaults
    /// to `false`: application code may deliberately store ASCII-escaped
    /// Unicode in a TEXT column (see `decode_unicode_escapes_for_export`), and
    /// the default export keeps that exact byte-for-byte round trip. Enable
    /// this only to make the `.sql` file itself readable in the original
    /// language. Re-importing such an export stores the decoded literal
    /// characters rather than the original ASCII-escaped form, so it is not a
    /// byte-faithful backup; any `\uXXXX`-shaped run forming a valid hex code
    /// point (e.g. `\uface`) is decoded as well, including text that merely
    /// documents such escapes.
    #[serde(default)]
    pub preserve_original_language: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildExportSqlInsertOptions {
    #[serde(flatten)]
    pub insert: BuildExportInsertStatementsOptions,
    #[serde(default)]
    pub insert_dialect: SqlInsertDialect,
    /// 生成 INSERT 时需要排除的列名（例如导出时不带主键），忽略大小写匹配。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exclude_columns: Vec<String>,
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
    #[serde(default)]
    pub insert_dialect: SqlInsertDialect,
    /// Optional connection info for FK-aware table ordering.
    /// When set, the caller should sort tables by dependency before passing them
    /// to `build_database_sql_export`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    /// Drop the table-level `AUTO_INCREMENT=N` clause from exported MySQL DDL.
    /// Defaults to `false` (preserve). See `DatabaseExportRequest::omit_auto_increment`.
    #[serde(default)]
    pub omit_auto_increment: bool,
    /// See `DatabaseExportRequest::preserve_original_language`.
    #[serde(default)]
    pub preserve_original_language: bool,
}

pub fn format_export_sql_literal(value: &Value) -> String {
    format_export_sql_literal_for_database(value, None)
}

fn format_standard_sql_literal(value: &Value) -> String {
    if value.is_null() {
        return "NULL".to_string();
    }
    if let Some(number) = value.as_number() {
        return number.to_string();
    }
    if let Some(value) = value.as_bool() {
        return if value { "TRUE" } else { "FALSE" }.to_string();
    }

    let text = value.as_str().map_or_else(|| value.to_string(), ToString::to_string);
    quote_standard_export_sql_string(&text)
}

fn format_export_sql_literal_for_database(value: &Value, database_type: Option<DatabaseType>) -> String {
    if value.is_null() {
        return "NULL".to_string();
    }
    if let Some(number) = value.as_number() {
        return number.to_string();
    }
    if let Some(value) = value.as_bool() {
        if matches!(database_type, Some(DatabaseType::Dameng) | Some(DatabaseType::SqlServer)) {
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
    sqlserver_unicode_string: bool,
) -> String {
    if is_postgres_bytea_export_column(database_type, column_type) {
        return format_postgres_bytea_export_literal(value);
    }
    if is_postgres_json_export_column(database_type, column_type) {
        return format_postgres_json_export_literal(value);
    }
    if database_type == Some(DatabaseType::Postgres) && is_postgres_vector_type(column_type) {
        return format_postgres_vector_sql_literal(value);
    }
    if matches!(database_type, Some(DatabaseType::Mysql)) && column_type.is_some_and(is_mysql_bit_type) {
        return format_mysql_bit_literal(value);
    }
    if let Some(literal) = format_mysql_spatial_export_literal(value, database_type, column_type) {
        return literal;
    }
    if let Some(literal) = format_xugu_spatial_export_literal(value, database_type, column_type) {
        return literal;
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
    if is_sqlserver_binary_export_column(database_type, column_type) {
        if let Some(literal) = format_sqlserver_binary_export_literal(value) {
            return literal;
        }
    }
    if let Some(arr) = value.as_array() {
        if matches!(database_type, Some(DatabaseType::ClickHouse) | Some(DatabaseType::Databend)) {
            return format_ch_array_sql_literal(arr);
        }
    }
    if let Some(literal) = format_oracle_export_temporal_literal(value, database_type, column_type) {
        return literal;
    }
    if let Some(literal) = format_export_temporal_literal(value, database_type, column_type) {
        return literal;
    }
    if sqlserver_unicode_string {
        if let Some(text) = value.as_str() {
            return format!("N{}", quote_standard_export_sql_string(text));
        }
    }
    format_export_sql_literal_for_database(value, database_type)
}

fn format_postgres_bytea_export_literal(value: &Value) -> String {
    if value.is_null() {
        return "NULL".to_string();
    }
    if let Some(text) = value.as_str() {
        if let Some(hex) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
            if hex.len() % 2 == 0 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return format!("decode('{hex}','hex')");
            }
        }
    }
    let text = value.as_str().map_or_else(|| value.to_string(), ToString::to_string);
    quote_postgres_string_literal(&text)
}

fn format_postgres_json_export_literal(value: &Value) -> String {
    if value.is_null() {
        return "NULL".to_string();
    }
    let text = value.as_str().map_or_else(|| value.to_string(), ToString::to_string);
    // PostgreSQL standard strings keep backslashes literal; JSON text needs its
    // own escape sequences, so only SQL-escape the surrounding string delimiter.
    quote_postgres_string_literal(&text)
}

/// Quotes a string literal for ANSI-SQL-family export targets (SQL Server,
/// SQLite, Oracle, DuckDB, and every other engine that falls through to this
/// default quoting path, plus the dialect-neutral `format_standard_sql_literal`
/// caller). These dialects do not treat backslash as an escape character --
/// only a doubled quote mark escapes an embedded `'`. Escaping backslashes
/// would corrupt any value that legitimately contains one (e.g. JSON text
/// with `\u00e9` escapes), turning `\u00e9` into `\\u00e9` on export/import
/// round-trips.
fn quote_standard_export_sql_string(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// Decodes JSON-style `\uXXXX` Unicode escapes (including surrogate pairs)
/// into their literal characters, leaving every other backslash sequence
/// untouched. Used only by the opt-in "preserve original language" export
/// option: application code (e.g. `encodeJsonValuesForDb`-style helpers) may
/// deliberately store ASCII-escaped Unicode in a TEXT column so the value
/// survives non-Unicode-aware storage; this renders that text human-readable
/// directly in the exported `.sql` file without touching the stored bytes in
/// the source database or breaking the round-trip for any other backslash
/// usage (e.g. a literal `\n`, a Windows path, or a doubled SQL quote).
fn decode_unicode_escapes_for_export(text: &str) -> String {
    if !text.contains("\\u") {
        return text.to_string();
    }
    let chars: Vec<char> = text.chars().collect();
    let mut result = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' && chars.get(i + 1) == Some(&'u') {
            if let Some(high) = parse_hex4(&chars, i + 2) {
                if (0xD800..=0xDBFF).contains(&high) {
                    // Possible surrogate pair: look for a trailing \uDC00-\uDFFF.
                    let low = if chars.get(i + 6) == Some(&'\\') && chars.get(i + 7) == Some(&'u') {
                        parse_hex4(&chars, i + 8).filter(|low| (0xDC00..=0xDFFF).contains(low))
                    } else {
                        None
                    };
                    if let Some(low) = low {
                        let combined = 0x10000u32 + ((high - 0xD800) << 10) + (low - 0xDC00);
                        if let Some(decoded) = char::from_u32(combined) {
                            result.push(decoded);
                            i += 12;
                            continue;
                        }
                    }
                    // Lone high surrogate: not representable as a char, keep as-is.
                    result.push(chars[i]);
                    i += 1;
                    continue;
                }
                if let Some(decoded) = char::from_u32(high) {
                    result.push(decoded);
                    i += 6;
                    continue;
                }
            }
        }
        result.push(chars[i]);
        i += 1;
    }
    result
}

fn parse_hex4(chars: &[char], start: usize) -> Option<u32> {
    let slice = chars.get(start..start + 4)?;
    let hex: String = slice.iter().collect();
    u32::from_str_radix(&hex, 16).ok()
}

/// SQL Server binary column types. The driver exposes their values as
/// `0x`-prefixed hex text, and T-SQL only accepts that text as an unquoted
/// binary literal: exporting it as a quoted string makes the import fail with
/// SQL Server error 257 ("Implicit conversion from data type varchar to
/// varbinary(max) is not allowed. Use the CONVERT function to run this query.").
fn is_sqlserver_binary_export_column(database_type: Option<DatabaseType>, column_type: Option<&str>) -> bool {
    if database_type != Some(DatabaseType::SqlServer) {
        return false;
    }
    column_type.is_some_and(|column_type| {
        let normalized = column_type.trim().to_ascii_lowercase();
        let base = normalized.split(['(', ' ', '\t', '\n']).next().unwrap_or("").trim();
        matches!(base, "binary" | "varbinary" | "image" | "timestamp" | "rowversion")
    })
}

/// Renders a SQL Server binary value as a T-SQL binary literal (`0x..`). Values
/// that are not `0x`-prefixed hex text keep the previous string quoting, so an
/// unexpected driver encoding is not silently reinterpreted.
fn format_sqlserver_binary_export_literal(value: &Value) -> Option<String> {
    let text = value.as_str()?.trim();
    let hex = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X"))?;
    if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("0x{hex}"))
}

fn is_sqlserver_unicode_export_type(column_type: &str) -> bool {
    let base = column_type.trim().split(|ch: char| ch == '(' || ch.is_whitespace()).next().unwrap_or("");
    ["nchar", "nvarchar", "ntext", "sysname"].iter().any(|candidate| base.eq_ignore_ascii_case(candidate))
}

fn quote_export_sql_string_for_database(text: &str, database_type: Option<DatabaseType>) -> String {
    match database_type {
        Some(DatabaseType::Dameng) => quote_dameng_export_sql_string(text),
        Some(DatabaseType::Postgres) => quote_postgres_string_literal(text),
        Some(DatabaseType::OpenGauss) => quote_standard_export_sql_string(text),
        database_type if is_mysql_compatible_export_literal_target(database_type) => {
            quote_mysql_compatible_export_sql_string(text)
        }
        // Not MySQL-wire targets, but both engines interpret backslash escape
        // sequences in string literals, so they must keep backslash escaping for
        // round-trip correctness. Neither has MySQL's `\Z`, though, so the SUB
        // byte is spelled `\x1a` (see [`SubControlEscape`]).
        Some(DatabaseType::ClickHouse | DatabaseType::Snowflake) => {
            quote_backslash_escaped_export_sql_string(text, SubControlEscape::Hex)
        }
        _ => quote_standard_export_sql_string(text),
    }
}

fn quote_dameng_export_sql_string(text: &str) -> String {
    if !text.contains('\0') {
        return quote_standard_export_sql_string(text);
    }

    let mut parts = Vec::new();
    for (index, segment) in text.split('\0').enumerate() {
        if index > 0 {
            parts.push("CHR(0)".to_string());
        }
        if !segment.is_empty() {
            parts.push(quote_standard_export_sql_string(segment));
        }
    }
    parts.join(" || ")
}

/// How a backslash-escaping dialect spells the 0x1A (SUB / Ctrl-Z) byte.
///
/// `\Z` is a MySQL-family escape. ClickHouse has no `\Z` in its escape table and
/// reads the sequence as a literal backslash followed by `Z`; Snowflake has none
/// either and drops the backslash, yielding `Z`. Both therefore corrupt a stored
/// SUB byte. Both accept the `\xhh` hexadecimal escape, which spells the byte the
/// value actually holds.
#[derive(Clone, Copy)]
enum SubControlEscape {
    /// The MySQL-family `\Z`.
    BackslashZ,
    /// `\x1a`, for dialects whose escape table has no `\Z`.
    Hex,
}

fn quote_mysql_compatible_export_sql_string(text: &str) -> String {
    quote_backslash_escaped_export_sql_string(text, SubControlEscape::BackslashZ)
}

fn quote_backslash_escaped_export_sql_string(text: &str, sub_control: SubControlEscape) -> String {
    format!("'{}'", escape_backslash_escaped_export_sql_string(text, sub_control))
}

fn escape_mysql_compatible_export_sql_string(text: &str) -> String {
    escape_backslash_escaped_export_sql_string(text, SubControlEscape::BackslashZ)
}

fn escape_backslash_escaped_export_sql_string(text: &str, sub_control: SubControlEscape) -> String {
    let mut escaped = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            // Keep control characters out of the physical script layout while
            // relying on the dialect's escapes.
            '\0' => escaped.push_str("\\0"),
            '\x08' => escaped.push_str("\\b"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            '\x0c' => escaped.push_str("\\f"),
            '\x1a' => escaped.push_str(match sub_control {
                SubControlEscape::BackslashZ => "\\Z",
                SubControlEscape::Hex => "\\x1a",
            }),
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

fn format_oracle_export_temporal_literal(
    value: &Value,
    database_type: Option<DatabaseType>,
    column_type: Option<&str>,
) -> Option<String> {
    if !matches!(database_type, Some(DatabaseType::Oracle | DatabaseType::OceanbaseOracle)) {
        return None;
    }
    let column_type = column_type?;
    let lower = column_type.trim().trim_matches('"').to_ascii_lowercase();
    let base = lower.split(['(', ' ', '\t', '\n']).next().unwrap_or("");
    let kind = match base {
        "timestampdty" => ExportTemporalKind::DateTime,
        "timestamptz_dty" => ExportTemporalKind::DateTimeWithTimeZone,
        _ => export_temporal_column_kind(database_type, column_type)?,
    };
    let parts = parse_export_date_parts(value.as_str()?)?;
    if base == "date" {
        return Some(format_oracle_export_date_parts_literal(&parts));
    }

    let fraction = parts.fraction.as_deref().unwrap_or_default();
    let datetime = format!("{} {}{fraction}", parts.date, parts.time);
    let mask = if fraction.is_empty() { "YYYY-MM-DD HH24:MI:SS" } else { "YYYY-MM-DD HH24:MI:SS.FF" };
    if kind == ExportTemporalKind::DateTimeWithTimeZone && !parts.zone.is_empty() {
        let zone = normalize_export_timezone(&parts.zone);
        return Some(format!("TO_TIMESTAMP_TZ('{datetime} {zone}', '{mask} TZH:TZM')"));
    }
    Some(format!("TO_TIMESTAMP('{datetime}', '{mask}')"))
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
            .map(|text| quote_standard_export_sql_string(&text));
    }
    let kind = export_temporal_column_kind(database_type, column_type)?;
    format_rfc3339_export_temporal_text(text, kind, database_type).map(|text| quote_standard_export_sql_string(&text))
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
    if !date.as_bytes().iter().enumerate().all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
        || !time.as_bytes().iter().enumerate().all(|(index, byte)| matches!(index, 2 | 5) || byte.is_ascii_digit())
    {
        return None;
    }
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

pub(crate) fn is_mysql_spatial_export_type(column_type: &str) -> bool {
    let base = column_type
        .trim()
        .to_ascii_lowercase()
        .split(['(', ':', ' ', '\t', '\n'])
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    matches!(
        base.as_str(),
        "geometry"
            | "point"
            | "linestring"
            | "polygon"
            | "multipoint"
            | "multilinestring"
            | "multipolygon"
            | "geometrycollection"
            | "geomcollection"
    )
}

pub(crate) fn is_xugu_spatial_export_type(column_type: &str) -> bool {
    let normalized = column_type.trim().to_ascii_lowercase();
    let base = normalized.split(['(', ':', ' ', '\t', '\n']).next().unwrap_or("").trim();
    matches!(base, "geometry" | "geography")
}

/// Xugu returns spatial values as readable WKT/EWKT text. Plain WKT is
/// accepted by the server, but it cannot carry a non-zero SRID; database
/// exports therefore select EWKT and replay it through the Xugu constructor.
/// This branch is intentionally Xugu-only so PostgreSQL/PostGIS and other
/// dialects retain their existing export behavior.
pub(crate) fn format_xugu_spatial_export_literal(
    value: &Value,
    database_type: Option<DatabaseType>,
    column_type: Option<&str>,
) -> Option<String> {
    format_xugu_spatial_export_literal_with_srid(value, database_type, column_type, None)
}

fn format_xugu_spatial_export_literal_with_srid(
    value: &Value,
    database_type: Option<DatabaseType>,
    column_type: Option<&str>,
    srid: Option<u32>,
) -> Option<String> {
    if database_type != Some(DatabaseType::Xugu) || !column_type.is_some_and(is_xugu_spatial_export_type) {
        return None;
    }
    if value.is_null() {
        return Some("NULL".to_string());
    }
    let text = value.as_str().map_or_else(|| value.to_string(), ToString::to_string);
    let trimmed = text.trim_start();
    if trimmed.len() > 5 && trimmed[..5].eq_ignore_ascii_case("SRID=") {
        return Some(format!("ST_GeomFromEWKT({})", quote_standard_export_sql_string(&text)));
    }
    if let Some(srid) = srid.filter(|srid| *srid != 0) {
        return Some(format!("ST_GeomFromEWKT({})", quote_standard_export_sql_string(&format!("SRID={srid};{text}"))));
    }
    // Xugu accepts a plain WKT string for both GEOMETRY and GEOGRAPHY. Keep
    // that form for SRID 0/legacy values rather than inventing a constructor.
    Some(quote_standard_export_sql_string(&text))
}

/// Database exports encode MySQL spatial cells as `DBX_WKB:<srid>:<hex>` while
/// reading them. Keeping this marker internal lets the normal JSON row shape
/// and all non-export query paths continue to expose readable WKT values.
pub(crate) fn format_mysql_spatial_export_literal(
    value: &Value,
    database_type: Option<DatabaseType>,
    column_type: Option<&str>,
) -> Option<String> {
    if database_type != Some(DatabaseType::Mysql) || !column_type.is_some_and(is_mysql_spatial_export_type) {
        return None;
    }
    let Value::String(value) = value else {
        return value.is_null().then(|| "NULL".to_string());
    };
    let marker = value.strip_prefix("DBX_WKB:")?;
    let (srid, hex) = marker.split_once(':')?;
    if srid.is_empty()
        || !srid.as_bytes().iter().all(u8::is_ascii_digit)
        || hex.is_empty()
        || hex.len() % 2 != 0
        || !hex.as_bytes().iter().all(u8::is_ascii_hexdigit)
    {
        return None;
    }
    let wkb = decode_mysql_spatial_export_wkb(hex)?;
    crate::db::wkb::decode_wkb_geometry(&wkb)?;
    let srid = srid.parse::<u32>().ok()?;
    Some(if srid == 0 { format!("ST_GeomFromWKB(0x{hex})") } else { format!("ST_GeomFromWKB(0x{hex}, {srid})") })
}

fn decode_mysql_spatial_export_wkb(hex: &str) -> Option<Vec<u8>> {
    fn nibble(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }

    hex.as_bytes().chunks_exact(2).map(|pair| Some((nibble(pair[0])? << 4) | nibble(pair[1])?)).collect()
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

fn export_column_type<'a>(
    column_types: &'a [Option<String>],
    index: usize,
    database_type: Option<DatabaseType>,
    spatial_columns: &HashMap<usize, Option<u32>>,
) -> Option<&'a str> {
    column_types.get(index).and_then(|value| value.as_deref()).filter(|value| !value.trim().is_empty()).or_else(|| {
        (database_type == Some(DatabaseType::Xugu) && spatial_columns.contains_key(&index)).then_some("GEOMETRY")
    })
}

fn format_export_sql_literal_typed_with_spatial(
    value: &Value,
    database_type: Option<DatabaseType>,
    column_type: Option<&str>,
    sqlserver_unicode_string: bool,
    spatial_srid: Option<u32>,
) -> String {
    if let Some(literal) = format_xugu_spatial_export_literal_with_srid(value, database_type, column_type, spatial_srid)
    {
        return literal;
    }
    format_export_sql_literal_typed(value, database_type, column_type, sqlserver_unicode_string)
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
    build_export_insert_statements_excluding_with_dialect(options, &[], SqlInsertDialect::Source)
}

/// 与 [`build_export_insert_statements`] 行为一致，但可以额外按列名排除若干列
/// （典型场景：导出 SQL 时不带主键）。列名比较忽略大小写。
///
/// 行值与空间列仍然按列在 `columns` 中的原始下标取值，所以调用方不需要自己裁剪
/// 行数据，也不会出现“列删了、值没删”导致的错位。
pub fn build_export_insert_statements_excluding(
    options: BuildExportInsertStatementsOptions,
    exclude_columns: &[String],
) -> Result<Vec<String>, String> {
    build_export_insert_statements_excluding_with_dialect(options, exclude_columns, SqlInsertDialect::Source)
}

pub(crate) fn build_export_insert_statements_excluding_with_dialect(
    options: BuildExportInsertStatementsOptions,
    exclude_columns: &[String],
    insert_dialect: SqlInsertDialect,
) -> Result<Vec<String>, String> {
    if options.columns.is_empty() || options.rows.is_empty() {
        return Ok(Vec::new());
    }
    let excluded_names: HashSet<String> =
        exclude_columns.iter().map(|column| column.trim().to_ascii_uppercase()).collect();
    let table = export_qualified_table_name(
        options.database_type,
        options.schema.as_deref(),
        options.table_name.as_deref(),
        options.qualified_table_name.as_deref(),
        options.identifier_quote.as_deref(),
        insert_dialect,
    )?;
    let spatial_columns =
        options.spatial_columns.iter().map(|column| (column.column_index, column.srid)).collect::<HashMap<_, _>>();
    let insert_columns = options
        .columns
        .iter()
        .enumerate()
        .filter_map(|(index, column)| {
            let column_type = export_column_type(&options.column_types, index, options.database_type, &spatial_columns);
            let excluded = excluded_names.contains(&column.trim().to_ascii_uppercase());
            (is_export_insert_column(
                options.database_type,
                column,
                column_type,
                options.column_extras.get(index).and_then(|value| value.as_deref()),
            ) && !excluded)
                .then(|| {
                    let sqlserver_unicode_string = options.database_type == Some(DatabaseType::SqlServer)
                        && column_type.is_some_and(is_sqlserver_unicode_export_type);
                    (index, column, sqlserver_unicode_string)
                })
        })
        .collect::<Vec<_>>();
    if insert_columns.iter().any(|(index, _, _)| {
        options
            .column_types
            .get(*index)
            .and_then(|column_type| column_type.as_deref())
            .is_some_and(crate::types::is_opaque_aggregate_state_type)
    }) {
        return Err(
            "SQL INSERT export does not support Doris aggregate-state columns; use a representation export for canonical hex bytes"
                .to_string(),
        );
    }
    if insert_columns.is_empty() {
        // Only fail when the exclusion itself removed the last insertable column;
        // emptiness caused by other omission rules (e.g. generated columns) keeps
        // the silent empty result.
        let had_insertable_without_exclusion = options.columns.iter().enumerate().any(|(index, column)| {
            let column_type = export_column_type(&options.column_types, index, options.database_type, &spatial_columns);
            is_export_insert_column(
                options.database_type,
                column,
                column_type,
                options.column_extras.get(index).and_then(|value| value.as_deref()),
            )
        });
        if had_insertable_without_exclusion {
            return Err("No insertable columns remain after excluding columns from the export.".to_string());
        }
        return Ok(Vec::new());
    }
    let batch_size = if insert_dialect == SqlInsertDialect::Source
        && options.database_type.is_some_and(uses_single_row_insert_statements)
    {
        1
    } else {
        let requested = options.batch_size.unwrap_or(DATABASE_EXPORT_INSERT_BATCH_SIZE).max(1);
        if insert_dialect == SqlInsertDialect::Source && options.database_type == Some(DatabaseType::SqlServer) {
            requested.min(1000)
        } else {
            requested
        }
    };
    let columns = insert_columns
        .iter()
        .map(|(_, column, _)| {
            if insert_dialect == SqlInsertDialect::Standard {
                crate::sql_dialect::quote_table_identifier(None, column)
            } else {
                crate::sql_dialect::quote_table_data_identifier(
                    options.database_type,
                    column,
                    options.identifier_quote.as_deref(),
                )
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let mut statements = Vec::new();
    // Dameng and SQL Server both reject explicit values for identity columns
    // unless `SET IDENTITY_INSERT <table> ON` wraps the statement (SQL Server
    // error 544), so exported INSERTs must carry the wrapper.
    let needs_identity_insert_wrapper = insert_dialect == SqlInsertDialect::Source
        && matches!(options.database_type, Some(DatabaseType::Dameng) | Some(DatabaseType::SqlServer))
        && insert_columns.iter().any(|(index, _, _)| {
            is_identity_column_extra(options.column_extras.get(*index).and_then(|value| value.as_deref()))
        });

    // Multi-row batches are written one tuple per line (issue #9814) so exported
    // `.sql` files stay readable in plain text editors. Statements that hold a
    // single tuple keep the compact `VALUES (..);` form, which also preserves
    // the "one INSERT per row" output of the single-row insert mode.
    let overriding = if options.database_type == Some(DatabaseType::Postgres)
        && insert_columns.iter().any(|(index, _, _)| {
            is_postgres_generated_always_identity_extra(
                options.column_extras.get(*index).and_then(|value| value.as_deref()),
            )
        }) {
        " OVERRIDING SYSTEM VALUE"
    } else {
        ""
    };
    let statement_head = format!("INSERT INTO {table} ({columns}){overriding} VALUES");
    let statement_prefix = format!("{statement_head} ");
    let output_database_type = if insert_dialect == SqlInsertDialect::Source { options.database_type } else { None };
    let statement_overhead_bytes = export_sql_statement_bytes(output_database_type, &statement_prefix) + 1;
    let target_statement_bytes = DATABASE_EXPORT_TARGET_STATEMENT_BYTES;
    let separator_bytes = export_sql_statement_bytes(output_database_type, ",\n");
    let mut current_values = String::new();
    let mut current_values_bytes = 0usize;
    let mut current_row_count = 0usize;

    let flush_values =
        |statements: &mut Vec<String>, values: &mut String, values_bytes: &mut usize, row_count: &mut usize| {
            if *row_count == 0 {
                return;
            }
            let mut insert_sql = String::with_capacity(statement_prefix.len() + values.len() + 1);
            insert_sql.push_str(&statement_head);
            insert_sql.push(if *row_count > 1 { '\n' } else { ' ' });
            insert_sql.push_str(values);
            insert_sql.push(';');
            if needs_identity_insert_wrapper {
                statements.push(wrap_dameng_identity_insert_sql_for_table(&insert_sql, &table));
            } else {
                statements.push(insert_sql);
            }
            values.clear();
            *values_bytes = 0;
            *row_count = 0;
        };

    for (row_index, row) in options.rows.into_iter().enumerate() {
        let mut rendered_row = String::with_capacity(insert_columns.len().saturating_mul(16).saturating_add(2));
        rendered_row.push('(');
        for (column_index, (index, _, sqlserver_unicode_string)) in insert_columns.iter().enumerate() {
            if column_index > 0 {
                rendered_row.push_str(", ");
            }
            let value = row.get(*index).unwrap_or(&Value::Null);
            let column_type =
                export_column_type(&options.column_types, *index, options.database_type, &spatial_columns);
            let spatial_srid = options
                .spatial_values
                .get(row_index)
                .and_then(|values| values.get(*index))
                .copied()
                .flatten()
                .or_else(|| spatial_columns.get(index).copied().flatten());
            let decoded_value;
            let value = if options.preserve_original_language {
                if let Some(text) = value.as_str() {
                    decoded_value = Value::String(decode_unicode_escapes_for_export(text));
                    &decoded_value
                } else {
                    value
                }
            } else {
                value
            };
            let literal = if insert_dialect == SqlInsertDialect::Standard {
                format_standard_sql_literal(value)
            } else {
                format_export_sql_literal_typed_with_spatial(
                    value,
                    options.database_type,
                    column_type,
                    *sqlserver_unicode_string,
                    spatial_srid,
                )
            };
            rendered_row.push_str(&literal);
        }
        rendered_row.push(')');
        let rendered_row_bytes = export_sql_statement_bytes(output_database_type, &rendered_row);
        let candidate_bytes = statement_overhead_bytes
            + current_values_bytes
            + if current_row_count == 0 { 0 } else { separator_bytes }
            + rendered_row_bytes;

        if current_row_count > 0 && (current_row_count >= batch_size || candidate_bytes > target_statement_bytes) {
            flush_values(&mut statements, &mut current_values, &mut current_values_bytes, &mut current_row_count);
        }
        if current_row_count > 0 {
            // A separator is only ever written once a statement holds at least
            // two tuples, so it can always use the multi-row layout.
            current_values.push_str(",\n");
            current_values_bytes += separator_bytes;
        }
        current_values.push_str(&rendered_row);
        current_values_bytes += rendered_row_bytes;
        current_row_count += 1;
    }
    flush_values(&mut statements, &mut current_values, &mut current_values_bytes, &mut current_row_count);

    Ok(statements)
}

fn export_sql_statement_bytes(database_type: Option<DatabaseType>, text: &str) -> usize {
    if database_type == Some(DatabaseType::SqlServer) {
        text.encode_utf16().count() * 2
    } else {
        text.len()
    }
}

pub(crate) fn is_internal_export_column(database_type: Option<DatabaseType>, column: &str) -> bool {
    // Synthetic ROWID is injected only to identify editable rows. It is not a
    // physical table column and must never propagate into exports.
    crate::sql_dialect::uses_synthetic_row_id(database_type)
        && column.eq_ignore_ascii_case(crate::sql_dialect::DBX_ROWID_COLUMN)
}

#[derive(Debug, Clone)]
pub(crate) struct SqlExportProjection {
    entries: Vec<(usize, usize)>,
}

impl SqlExportProjection {
    pub(crate) fn resolve(
        columns: &[String],
        selected_columns: Option<&[SqlExportColumnSelection]>,
    ) -> Result<Self, String> {
        let Some(selected_columns) = selected_columns else {
            return Ok(Self { entries: (0..columns.len()).map(|index| (index, index)).collect() });
        };
        if selected_columns.is_empty() {
            return Err("Select at least one column for SQL export.".to_string());
        }

        let mut entries = Vec::with_capacity(selected_columns.len());
        let mut used = HashSet::with_capacity(selected_columns.len());
        let mut indexes_by_name = HashMap::<&str, Vec<usize>>::new();
        for (index, name) in columns.iter().enumerate() {
            indexes_by_name.entry(name.as_str()).or_default().push(index);
        }
        for selected in selected_columns {
            let current_index = indexes_by_name
                .get(selected.name.as_str())
                .and_then(|indexes| indexes.get(selected.name_occurrence))
                .copied()
                .ok_or_else(|| format!("Selected SQL export column was not found: {}", selected.name))?;
            if !used.insert(current_index) {
                return Err(format!("SQL export column was selected more than once: {}", selected.name));
            }
            entries.push((current_index, selected.source_index));
        }
        Ok(Self { entries })
    }

    pub(crate) fn project<T: Clone + Default>(&self, values: &[T]) -> Vec<T> {
        self.entries.iter().map(|(current_index, _)| values.get(*current_index).cloned().unwrap_or_default()).collect()
    }

    pub(crate) fn project_request<T: Clone + Default>(&self, values: &[T]) -> Vec<T> {
        self.entries.iter().map(|(_, request_index)| values.get(*request_index).cloned().unwrap_or_default()).collect()
    }

    pub(crate) fn project_owned<T: Default>(&self, mut values: Vec<T>) -> Vec<T> {
        self.entries.iter().map(|(index, _)| values.get_mut(*index).map(std::mem::take).unwrap_or_default()).collect()
    }

    pub(crate) fn project_spatial_columns(&self, columns: &[SpatialColumn]) -> Vec<SpatialColumn> {
        let spatial_by_index: HashMap<_, _> = columns.iter().map(|column| (column.column_index, column)).collect();
        self.entries
            .iter()
            .enumerate()
            .filter_map(|(projected_index, (current_index, _))| {
                spatial_by_index
                    .get(current_index)
                    .map(|column| SpatialColumn { column_index: projected_index, srid: column.srid })
            })
            .collect()
    }

    pub(crate) fn project_insert_options(
        &self,
        mut options: BuildExportInsertStatementsOptions,
    ) -> BuildExportInsertStatementsOptions {
        options.columns = self.project_owned(options.columns);
        options.column_types = self.project_owned(options.column_types);
        options.column_extras = self.project_owned(options.column_extras);
        options.spatial_columns = self.project_spatial_columns(&options.spatial_columns);
        options.spatial_values = options.spatial_values.into_iter().map(|row| self.project_owned(row)).collect();
        options.rows = options.rows.into_iter().map(|row| self.project_owned(row)).collect();
        options
    }
}

#[cfg(test)]
mod sql_export_projection_tests {
    use super::*;
    use serde_json::json;

    fn selection(index: usize, name: &str, occurrence: usize) -> SqlExportColumnSelection {
        SqlExportColumnSelection { source_index: index, name: name.into(), name_occurrence: occurrence }
    }

    #[test]
    fn omitted_selection_keeps_every_column_but_empty_selection_is_rejected() {
        let columns = vec!["id".into(), "name".into()];
        let projection = SqlExportProjection::resolve(&columns, None).unwrap();
        assert_eq!(projection.project(&columns), columns);
        assert!(SqlExportProjection::resolve(&columns, Some(&[])).unwrap_err().contains("at least one"));
    }

    #[test]
    fn duplicate_names_follow_occurrence_after_reordering() {
        let columns = vec!["id".into(), "id".into(), "name".into()];
        let projection =
            SqlExportProjection::resolve(&columns, Some(&[selection(3, "id", 1), selection(2, "name", 0)])).unwrap();
        assert_eq!(projection.project(&[json!(1), json!(2), json!("Ada")]), vec![json!(2), json!("Ada")]);
        assert_eq!(projection.project_request(&[0, 1, 2, 3]), vec![3, 2]);
    }

    #[test]
    fn missing_and_repeated_column_identities_are_rejected() {
        let columns = vec!["id".into()];
        assert!(SqlExportProjection::resolve(&columns, Some(&[selection(0, "id", 1)]))
            .unwrap_err()
            .contains("not found"));
        assert!(SqlExportProjection::resolve(&columns, Some(&[selection(0, "name", 0)]))
            .unwrap_err()
            .contains("not found"));
        assert!(SqlExportProjection::resolve(&columns, Some(&[selection(0, "id", 0), selection(1, "id", 0)]))
            .unwrap_err()
            .contains("more than once"));
    }

    #[test]
    fn insert_projection_aligns_types_extras_spatial_data_and_values() {
        let columns = vec!["id".into(), "shape".into(), "blob".into(), "optional".into()];
        let projection = SqlExportProjection::resolve(
            &columns,
            Some(&[selection(2, "blob", 0), selection(1, "shape", 0), selection(3, "optional", 0)]),
        )
        .unwrap();
        let options = BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Mysql),
            identifier_quote: None,
            schema: None,
            table_name: Some("items".into()),
            qualified_table_name: None,
            columns: columns.clone(),
            column_types: vec![Some("int".into()), Some("geometry".into()), Some("blob".into()), Some("text".into())],
            column_extras: vec![Some("auto_increment".into()), None, None, None],
            spatial_columns: vec![SpatialColumn { column_index: 1, srid: Some(4326) }],
            spatial_values: vec![vec![None, Some(4326), None, None]],
            rows: vec![vec![json!(1), json!("POINT(1 2)"), json!([0, 255]), Value::Null]],
            batch_size: Some(100),
            preserve_original_language: false,
        };
        let projected = projection.project_insert_options(options);
        assert_eq!(columns, vec!["id", "shape", "blob", "optional"]);
        assert_eq!(projected.columns, vec!["blob", "shape", "optional"]);
        assert_eq!(projected.column_types, vec![Some("blob".into()), Some("geometry".into()), Some("text".into())]);
        assert_eq!(projected.column_extras, vec![None, None, None]);
        assert_eq!(projected.spatial_columns[0].column_index, 1);
        assert_eq!(projected.spatial_values, vec![vec![None, Some(4326), None]]);
        assert_eq!(projected.rows, vec![vec![json!([0, 255]), json!("POINT(1 2)"), Value::Null]]);
    }

    #[test]
    fn wide_duplicate_selection_preserves_every_position() {
        let columns = vec!["value".to_string(); 10000];
        let selected: Vec<_> = (0..columns.len()).map(|index| selection(index, "value", index)).collect();
        let projection = SqlExportProjection::resolve(&columns, Some(&selected)).unwrap();
        let values: Vec<_> = (0..columns.len()).collect();
        assert_eq!(projection.project_owned(values.clone()), values);
    }
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

fn is_export_insert_column(
    database_type: Option<DatabaseType>,
    column: &str,
    column_type: Option<&str>,
    column_extra: Option<&str>,
) -> bool {
    !is_internal_export_column(database_type, column)
        && !is_postgres_tsvector_export_column(database_type, column_type)
        && (database_type != Some(DatabaseType::Mysql) || !is_mysql_generated_column_extra(column_extra))
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

fn is_postgres_bytea_export_column(database_type: Option<DatabaseType>, column_type: Option<&str>) -> bool {
    database_type == Some(DatabaseType::Postgres)
        && column_type
            .map(|column_type| {
                let normalized = column_type.trim().trim_matches('"').to_ascii_lowercase();
                normalized == "bytea" || normalized.ends_with(".bytea")
            })
            .unwrap_or(false)
}

pub fn build_export_sql_insert(options: BuildExportSqlInsertOptions) -> Result<String, String> {
    build_export_insert_statements_excluding_with_dialect(
        options.insert,
        &options.exclude_columns,
        options.insert_dialect,
    )
    .map(|statements| statements.join("\n"))
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
            let ddl = format_export_table_ddl(
                ddl,
                table.database_type,
                DdlNormalizeOptions { omit_auto_increment: options.omit_auto_increment },
            );
            lines.push(format!("-- Structure for {}", table.display_name));
            lines.push(ddl);
            lines.push(String::new());
        }

        lines.push(format!("-- Data for {}", table.display_name));
        if table.truncated {
            lines.push(format!("-- Exported rows: {} (truncated at {row_limit})", table.rows.len()));
        } else {
            lines.push(format!("-- Exported rows: {}", table.rows.len()));
        }

        let inserts = build_export_insert_statements_excluding_with_dialect(
            BuildExportInsertStatementsOptions {
                database_type: table.database_type,
                identifier_quote: table.identifier_quote.clone(),
                schema: table.schema,
                table_name: table.table_name,
                qualified_table_name: table.qualified_table_name,
                columns: table.columns,
                column_types: table.column_types,
                column_extras: table.column_extras,
                spatial_columns: table.spatial_columns,
                spatial_values: table.spatial_values,
                rows: table.rows,
                batch_size: Some(insert_batch_size),
                preserve_original_language: options.preserve_original_language,
            },
            &[],
            options.insert_dialect,
        )?;
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
    identifier_quote: Option<&str>,
    insert_dialect: SqlInsertDialect,
) -> Result<String, String> {
    if insert_dialect == SqlInsertDialect::Standard {
        let table_name = table_name
            .filter(|name| !name.trim().is_empty())
            .ok_or_else(|| "tableName is required for Standard SQL INSERT output".to_string())?;
        let table = crate::sql_dialect::quote_table_identifier(None, table_name);
        return Ok(schema
            .map(str::trim)
            .filter(|schema| !schema.is_empty())
            .map(|schema| format!("{}.{}", crate::sql_dialect::quote_table_identifier(None, schema), table))
            .unwrap_or(table));
    }
    if let Some(name) = qualified_name.filter(|name| !name.trim().is_empty()) {
        return Ok(name.to_string());
    }
    let table_name = table_name
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| "tableName is required when qualifiedTableName is not provided".to_string())?;
    if crate::sql_dialect::uses_connection_identifier_quote(database_type, identifier_quote) {
        return Ok(crate::sql_dialect::table_data_qualified_table_name(
            database_type,
            schema,
            table_name,
            identifier_quote,
        ));
    }
    Ok(qualified_table_name(database_type, schema, table_name))
}

fn normalize_export_table_ddl(
    ddl: &str,
    database_type: Option<DatabaseType>,
    opts: crate::mysql_ddl_normalize::DdlNormalizeOptions,
) -> String {
    if database_type != Some(DatabaseType::Mysql) {
        return ddl.to_string();
    }

    crate::mysql_ddl_normalize::normalize_mysql_export_ddl(ddl, opts)
}

fn format_export_table_ddl(ddl: &str, database_type: Option<DatabaseType>, opts: DdlNormalizeOptions) -> String {
    let ddl = normalize_export_table_ddl(ddl, database_type, opts);
    let ddl = if database_type == Some(DatabaseType::OpenGauss) {
        crate::schema::normalize_opengauss_table_ddl_comments(&ddl)
    } else {
        ddl
    };
    let ddl = ddl.trim().trim_end_matches(';').trim_end();
    format!("{ddl};")
}

fn split_postgres_export_table_triggers(ddl: &str, database_type: DatabaseType) -> (String, Vec<String>) {
    if database_type != DatabaseType::Postgres {
        return (ddl.to_string(), Vec::new());
    }

    let mut table_statements = Vec::new();
    let mut trigger_statements = Vec::new();
    for range in crate::db::ddl_scan::top_level_statement_ranges(ddl) {
        let statement = ddl[range].trim();
        if statement.is_empty() {
            continue;
        }
        let mut words = statement.split_ascii_whitespace().take(3).map(str::to_ascii_uppercase);
        let first = words.next();
        let second = words.next();
        let third = words.next();
        if first.as_deref() == Some("CREATE")
            && (second.as_deref() == Some("TRIGGER")
                || (second.as_deref() == Some("CONSTRAINT") && third.as_deref() == Some("TRIGGER")))
        {
            trigger_statements.push(statement.to_string());
        } else {
            table_statements.push(statement.to_string());
        }
    }
    (table_statements.join("\n"), trigger_statements)
}

/// PostgreSQL database export: split inline `FOREIGN KEY` constraints out of a
/// relation's `CREATE TABLE` and return them as deferred
/// `ALTER TABLE ... ADD CONSTRAINT ...` statements.
///
/// Inline foreign keys tie the script's replay to table creation order. The
/// exporter sorts tables by dependency, but a foreign key cycle can never
/// satisfy that order, so a backup that inlines its foreign keys cannot be
/// restored (`ERROR: relation ... does not exist` — issue #10575). Emitting
/// the constraints after every table and row exists (pg_dump's post-data
/// position) removes the ordering requirement entirely.
fn extract_postgres_deferred_foreign_keys(ddl: &str, schema: &str, table: &str) -> (String, Vec<String>) {
    let fallback_qualified = crate::transfer::qualified_table(table, schema, &DatabaseType::Postgres, None);
    let mut statements = Vec::new();
    let mut deferred = Vec::new();
    for range in crate::db::ddl_scan::top_level_statement_ranges(ddl) {
        let statement = ddl[range].trim();
        if statement.is_empty() {
            continue;
        }
        let (stripped, removed) = crate::transfer::strip_inline_foreign_key_constraint_lines_collecting(statement);
        if !removed.is_empty() {
            // Qualify the ALTER from the statement's own relation name: whole-
            // database exports leave `schema` empty and rely on each statement
            // to carry its schema, so a mismatch here would fail the replay.
            let qualified = crate::db::ddl_scan::parse_create_table_relation(statement)
                .map(|(statement_schema, statement_table)| {
                    crate::transfer::qualified_table(&statement_table, &statement_schema, &DatabaseType::Postgres, None)
                })
                .unwrap_or_else(|| fallback_qualified.clone());
            for clause in removed {
                deferred.push(format!("ALTER TABLE {qualified} ADD {clause};"));
            }
        }
        statements.push(stripped);
    }
    (statements.join("\n"), deferred)
}

fn postgres_sequence_qualified_name(schema: &str, sequence_name: &str) -> String {
    let db_type = DatabaseType::Postgres;
    if schema.trim().is_empty() {
        quote_identifier(sequence_name, &db_type)
    } else {
        format!("{}.{}", quote_identifier(schema, &db_type), quote_identifier(sequence_name, &db_type))
    }
}

fn postgres_sequence_options(sequence: &PostgresExportSequence) -> String {
    let cycle = if sequence.cycle { "CYCLE" } else { "NO CYCLE" };
    format!(
        "  AS {data_type}\n  START WITH {start_value}\n  INCREMENT BY {increment}\n  MINVALUE {min_value}\n  MAXVALUE {max_value}\n  CACHE {cache_value}\n  {cycle}",
        data_type = sequence.data_type,
        start_value = sequence.start_value,
        increment = sequence.increment,
        min_value = sequence.min_value,
        max_value = sequence.max_value,
        cache_value = sequence.cache_value,
    )
}

fn generate_postgres_sequence_create_ddl(sequence: &PostgresExportSequence, schema: &str) -> String {
    format!(
        "CREATE SEQUENCE IF NOT EXISTS {}\n{}",
        postgres_sequence_qualified_name(schema, &sequence.name),
        postgres_sequence_options(sequence),
    )
}

fn generate_postgres_sequence_post_table_ddl(sequence: &PostgresExportSequence, schema: &str) -> Option<String> {
    let owner_table = sequence.owner_table.as_deref()?;
    let owner_column = sequence.owner_column.as_deref()?;
    let owner_table = crate::transfer::qualified_table(owner_table, schema, &DatabaseType::Postgres, None);
    if sequence.created_by_table {
        // CREATE TABLE owns the sequence. Configure that actual binding without
        // relying on its name, and quote the whole DO body (identifiers may contain dollar tags).
        let body = format!(
            "BEGIN EXECUTE 'ALTER SEQUENCE ' || pg_get_serial_sequence({}, {}) || {}; END;",
            quote_postgres_string_literal(&owner_table),
            quote_postgres_string_literal(owner_column),
            quote_postgres_string_literal(&format!(
                "\n{} RESTART WITH {}",
                postgres_sequence_options(sequence),
                sequence.start_value
            )),
        );
        return Some(format!("DO {}", quote_postgres_string_literal(&body)));
    }
    Some(format!(
        "ALTER SEQUENCE {} OWNED BY {}.{}",
        postgres_sequence_qualified_name(schema, &sequence.name),
        owner_table,
        quote_identifier(owner_column, &DatabaseType::Postgres)
    ))
}

fn generate_postgres_sequence_setval_sql(sequence: &PostgresExportSequence, schema: &str) -> Option<String> {
    let last_value = sequence.last_value.as_deref().map(str::trim).filter(|value| !value.is_empty());
    let mut sequence_literal = quote_postgres_string_literal(&postgres_sequence_qualified_name(schema, &sequence.name));
    match (sequence.owner_table.as_deref(), sequence.owner_column.as_deref()) {
        (Some(owner_table), Some(owner_column)) => {
            let owner_table = crate::transfer::qualified_table(owner_table, schema, &DatabaseType::Postgres, None);
            if sequence.created_by_table {
                sequence_literal = format!(
                    "pg_get_serial_sequence({}, {})",
                    quote_postgres_string_literal(&owner_table),
                    quote_postgres_string_literal(owner_column),
                );
            }
            if let Some(value) = last_value.filter(|_| sequence.cycle) {
                // A cycled counter may be below/above the table's extrema after wrapping.
                return Some(format!("SELECT setval({sequence_literal}, {value}, true)"));
            }
            let owner_column = quote_identifier(owner_column, &DatabaseType::Postgres);
            let descending = sequence.increment.trim().starts_with('-');
            let (aggregate, extreme, comparison) =
                if descending { ("MIN", "LEAST", "<=") } else { ("MAX", "GREATEST", ">=") };
            let fallback = last_value.unwrap_or(&sequence.start_value);
            let called = if last_value.is_some() {
                "true".to_string()
            } else {
                format!("COALESCE({aggregate}({owner_column}) {comparison} {fallback}, false)")
            };
            Some(format!(
                "SELECT setval({sequence_literal}, {extreme}(COALESCE({aggregate}({owner_column}), {fallback}), {fallback}), {called}) FROM {owner_table}"
            ))
        }
        _ => last_value.map(|value| format!("SELECT setval({sequence_literal}, {value}, true)")),
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

fn generate_postgres_enum_ddl(enum_type: &PostgresExportEnum) -> String {
    let labels =
        enum_type.labels.iter().map(|label| quote_postgres_string_literal(label)).collect::<Vec<_>>().join(", ");
    format!(
        "CREATE TYPE {}.{} AS ENUM ({});",
        quote_identifier(&enum_type.schema, &DatabaseType::Postgres),
        quote_identifier(&enum_type.name, &DatabaseType::Postgres),
        labels
    )
}

async fn list_postgres_extension_members(
    state: &crate::connection::AppState,
    pool_key: &str,
    schema: &str,
) -> Result<PostgresExtensionMembers, String> {
    let pool = {
        let pool_handle = state.pool_handle(pool_key).await;
        match pool_handle.as_ref() {
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

const POSTGRES_EXPORT_ENUMS_SQL: &str = "SELECT t.typname, \
      COALESCE(array_to_json(array_agg(e.enumlabel ORDER BY e.enumsortorder))::text, '[]') \
     FROM pg_catalog.pg_type t \
     JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace \
     LEFT JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid \
     WHERE n.nspname = $1 AND t.typtype = 'e' \
     GROUP BY t.typname \
     ORDER BY t.typname";

async fn list_postgres_export_enums(
    state: &crate::connection::AppState,
    pool_key: &str,
    schema: &str,
) -> Result<Vec<PostgresExportEnum>, String> {
    let pool = {
        let pool_handle = state.pool_handle(pool_key).await;
        match pool_handle.as_ref() {
            Some(crate::connection::PoolKind::Postgres(pool)) => pool.clone(),
            _ => return Ok(Vec::new()),
        }
    };
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let rows = client.query(POSTGRES_EXPORT_ENUMS_SQL, &[&schema]).await.map_err(|e| e.to_string())?;
    rows.into_iter()
        .map(|row| {
            let name: String = row.get(0);
            let labels_json: String = row.get(1);
            let labels = serde_json::from_str::<Vec<String>>(&labels_json)
                .map_err(|e| format!("invalid PostgreSQL enum labels for {name}: {e}"))?;
            Ok(PostgresExportEnum { name, schema: schema.to_string(), labels })
        })
        .collect()
}

fn is_postgres_extension_member_routine(object: &crate::types::ObjectInfo, members: &PostgresExtensionMembers) -> bool {
    members.function_keys.contains(&(object.name.clone(), object.signature.clone().unwrap_or_default()))
}

const POSTGRES_EXPORT_SEQUENCES_SQL: &str = "SELECT c.relname, \
      COALESCE(format_type(s.seqtypid, NULL), 'bigint'), \
      COALESCE(s.seqstart::text, '1'), \
      COALESCE(s.seqmin::text, '1'), \
      COALESCE(s.seqmax::text, '9223372036854775807'), \
      COALESCE(s.seqincrement::text, '1'), \
      COALESCE(s.seqcycle, false), \
      COALESCE(s.seqcache::text, '1'), \
      t.relname, \
      a.attname, \
      COALESCE(d.deptype = 'i', false) OR \
      COALESCE(a.atttypid IN (20, 21, 23) AND \
        pg_get_expr(ad.adbin, ad.adrelid) = format('nextval(%L::regclass)', c.oid::regclass::text), false) \
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
     LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
     WHERE c.relkind = 'S' AND n.nspname = $1 \
     ORDER BY c.relname";

/// PostgreSQL 9.x sibling of [`POSTGRES_EXPORT_SEQUENCES_SQL`]: the `pg_sequence`
/// catalog only exists from PostgreSQL 10 on, so that query aborts the whole
/// structure export with `db error` on older servers (#10079). Sequence
/// parameters are filled in per sequence by
/// [`postgres_export_sequence_parameters_legacy`] instead.
const POSTGRES_EXPORT_SEQUENCES_COMPAT_SQL: &str = "SELECT c.relname, \
      'bigint', \
      '1', \
      '1', \
      '9223372036854775807', \
      '1', \
      false, \
      '1', \
      t.relname, \
      a.attname, \
      COALESCE(a.atttypid IN (20, 21, 23) AND \
        pg_get_expr(ad.adbin, ad.adrelid) = format('nextval(%L::regclass)', c.oid::regclass::text), false) \
     FROM pg_class c \
     JOIN pg_namespace n ON n.oid = c.relnamespace \
     LEFT JOIN pg_depend d ON d.classid = 'pg_class'::regclass \
       AND d.objid = c.oid \
       AND d.refclassid = 'pg_class'::regclass \
       AND d.deptype IN ('a', 'i') \
     LEFT JOIN pg_class t ON t.oid = d.refobjid \
     LEFT JOIN pg_namespace tn ON tn.oid = t.relnamespace AND tn.nspname = n.nspname \
     LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid \
     LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
     WHERE c.relkind = 'S' AND n.nspname = $1 \
     ORDER BY c.relname";

#[derive(Debug)]
struct PostgresExportSequenceParameters {
    start_value: String,
    min_value: String,
    max_value: String,
    increment: String,
    cycle: bool,
    cache_value: String,
    last_value: Option<String>,
}

/// Pre-10 servers store sequence parameters in the sequence relation itself
/// (`SELECT ... FROM <sequence>`), which is also the only way to read a
/// sequence's current value there. `last_value` is reported only once the
/// sequence has been called, matching `pg_sequence_last_value()`'s NULL on an
/// untouched sequence.
async fn postgres_export_sequence_parameters_legacy(
    client: &deadpool_postgres::Client,
    schema: &str,
    sequence: &str,
) -> Result<Option<PostgresExportSequenceParameters>, tokio_postgres::Error> {
    let qualified = format!(
        "{}.{}",
        quote_identifier(schema, &DatabaseType::Postgres),
        quote_identifier(sequence, &DatabaseType::Postgres)
    );
    let sql = format!(
        "SELECT start_value::text, min_value::text, max_value::text, increment_by::text, is_cycled, \
         cache_value::text, CASE WHEN is_called THEN last_value::text END FROM {qualified}"
    );
    let rows = client.query(sql.as_str(), &[]).await?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    Ok(Some(PostgresExportSequenceParameters {
        start_value: row.get(0),
        min_value: row.get(1),
        max_value: row.get(2),
        increment: row.get(3),
        cycle: row.get(4),
        cache_value: row.get(5),
        last_value: row.get(6),
    }))
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
        let pool_handle = state.pool_handle(pool_key).await;
        match pool_handle.as_ref() {
            Some(crate::connection::PoolKind::Postgres(pool)) => pool.clone(),
            _ => return Ok(Vec::new()),
        }
    };
    let client = pool.get().await.map_err(|e| e.to_string())?;
    // PostgreSQL 10+ keeps sequence parameters in `pg_sequence`; older servers
    // have neither that catalog nor `pg_sequence_last_value()`, so the compat
    // tier lists sequences (and owners) without it and reads each sequence
    // relation directly afterwards.
    let (rows, legacy_parameters) = match client.query(POSTGRES_EXPORT_SEQUENCES_SQL, &[&schema]).await {
        Ok(rows) => (rows, false),
        Err(primary_error) => match client.query(POSTGRES_EXPORT_SEQUENCES_COMPAT_SQL, &[&schema]).await {
            Ok(rows) => {
                log::debug!(
                    "[postgres][database-export:sequences-compat-used] pg_sequence catalog unavailable ({}); reading sequence parameters from each sequence relation",
                    primary_error
                );
                (rows, true)
            }
            Err(_) => return Err(primary_error.to_string()),
        },
    };

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
            created_by_table: row.get::<_, bool>(10),
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

    if legacy_parameters {
        for sequence in sequences.iter_mut() {
            match postgres_export_sequence_parameters_legacy(&client, schema, &sequence.name).await {
                Ok(Some(parameters)) => {
                    sequence.start_value = parameters.start_value;
                    sequence.min_value = parameters.min_value;
                    sequence.max_value = parameters.max_value;
                    sequence.increment = parameters.increment;
                    sequence.cycle = parameters.cycle;
                    sequence.cache_value = parameters.cache_value;
                    sequence.last_value = parameters.last_value;
                }
                Ok(None) => {}
                Err(error) => log::debug!(
                    "[postgres][database-export:sequences-compat-read-failed] sequence={} schema={} error={}",
                    sequence.name,
                    schema,
                    error
                ),
            }
        }
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

/// Await one export operation while still observing the export-id cancellation
/// marker. Metadata helpers ultimately await database-driver futures that do
/// not accept a cancellation token; polling here keeps the export task
/// responsive and dropping the pending future follows the same bounded
/// prefetch cancellation behavior used below.
async fn await_export_operation<T>(
    export_id: &str,
    operation: Pin<Box<dyn Future<Output = Result<T, String>> + Send + '_>>,
) -> Result<T, String> {
    tokio::pin!(operation);
    loop {
        if is_export_cancelled_now(export_id) {
            return Err(EXPORT_CANCELLED_ERROR.to_string());
        }
        tokio::select! {
            biased;
            result = &mut operation => {
                return if is_export_cancelled_now(export_id) {
                    Err(EXPORT_CANCELLED_ERROR.to_string())
                } else {
                    result
                };
            },
            _ = tokio::time::sleep(EXPORT_CANCEL_POLL_INTERVAL) => {}
        }
    }
}

struct AbortExportTaskOnDrop(tokio::task::AbortHandle);

impl Drop for AbortExportTaskOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn get_export_table_ddl_isolated(
    state: Arc<crate::connection::AppState>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
    client_session_id: String,
) -> Result<String, String> {
    let task = tokio::spawn(async move {
        crate::schema::get_table_relation_export_ddl_core_for_session(
            &state,
            &connection_id,
            &database,
            &schema,
            &table,
            None,
            Some(&client_session_id),
        )
        .await
    });
    let _abort_on_drop = AbortExportTaskOnDrop(task.abort_handle());
    task.await.map_err(|error| format!("Database export metadata task failed: {error}"))?
}

async fn get_export_table_columns_isolated(
    state: Arc<crate::connection::AppState>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
    client_session_id: String,
) -> Result<Vec<crate::db::ColumnInfo>, String> {
    let task = tokio::spawn(async move {
        crate::schema::get_columns_core_for_session(
            &state,
            &connection_id,
            &database,
            &schema,
            &table,
            Some(&client_session_id),
        )
        .await
    });
    let _abort_on_drop = AbortExportTaskOnDrop(task.abort_handle());
    task.await.map_err(|error| format!("Database export metadata task failed: {error}"))?
}

fn snapshot_batch_cancelled(db_type: &DatabaseType, export_id: &str) -> bool {
    *db_type != DatabaseType::Postgres && is_export_cancelled_now(export_id)
}

/// Unlike metadata operations, a database row stream owns a live server query
/// and transaction cleanup. Signal its cancellation token, then keep polling
/// the future until that cleanup finishes before reporting Export cancelled.
async fn await_export_stream_operation<T, F>(
    export_id: &str,
    cancel_token: &CancellationToken,
    operation: F,
) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    tokio::pin!(operation);
    loop {
        if is_export_cancelled_now(export_id) {
            cancel_token.cancel();
            if let Err(error) = operation.await {
                if error.contains("Transaction cleanup failed") || error.contains("stream cleanup timed out") {
                    log::warn!("[database-export] cancellation cleanup was incomplete export_id={export_id}: {error}");
                }
            }
            return Err(EXPORT_CANCELLED_ERROR.to_string());
        }
        tokio::select! {
            biased;
            result = &mut operation => {
                return if is_export_cancelled_now(export_id) {
                    Err(EXPORT_CANCELLED_ERROR.to_string())
                } else {
                    result
                };
            },
            _ = tokio::time::sleep(EXPORT_CANCEL_POLL_INTERVAL) => {}
        }
    }
}

pub async fn begin_database_backup_snapshot_core(
    state: &crate::connection::AppState,
    connection_id: &str,
    database: &str,
) -> Result<DatabaseBackupSnapshot, String> {
    begin_database_backup_snapshot_core_for_export(state, connection_id, database, None).await
}

/// Opens the consistent-snapshot transaction used by a scheduled backup.
///
/// When the snapshot is being created for an export run, `export_id` keeps
/// pool checkout and transaction creation cancellable even before a child
/// database export has been created.
pub async fn begin_database_backup_snapshot_core_for_export(
    state: &crate::connection::AppState,
    connection_id: &str,
    database: &str,
    export_id: Option<&str>,
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

    let session_id = if let Some(export_id) = export_id {
        // Do not use `await_export_operation` here: if the transaction is
        // created at exactly the same time as cancellation, we still need the
        // returned session id to roll it back rather than leaking it.
        let operation = crate::query::begin_database_backup_snapshot(state, connection_id, database);
        tokio::pin!(operation);
        loop {
            if is_export_cancelled_now(export_id) {
                return Err(EXPORT_CANCELLED_ERROR.to_string());
            }
            tokio::select! {
                biased;
                result = &mut operation => {
                    let session_id = result?;
                    if is_export_cancelled_now(export_id) {
                        let _ = crate::query::rollback_manual_transaction(state, &session_id).await;
                        return Err(EXPORT_CANCELLED_ERROR.to_string());
                    }
                    break session_id;
                },
                _ = tokio::time::sleep(EXPORT_CANCEL_POLL_INTERVAL) => {}
            }
        }
    } else {
        crate::query::begin_database_backup_snapshot(state, connection_id, database).await?
    };

    let schemas_result = if matches!(db_type, DatabaseType::Postgres) {
        const POSTGRES_BACKUP_SCHEMAS_SQL: &str = "SELECT n.nspname FROM pg_catalog.pg_namespace n \
             WHERE n.nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast') \
             AND n.nspname NOT LIKE 'pg_toast_temp_%' \
             AND n.nspname NOT LIKE 'pg_temp_%' ORDER BY n.nspname";
        let operation = crate::query::execute_in_manual_transaction(
            state,
            &session_id,
            POSTGRES_BACKUP_SCHEMAS_SQL,
            database,
            None,
            Some(10_000),
        );
        let results = match export_id {
            Some(export_id) => await_export_operation(export_id, Box::pin(operation)).await,
            None => operation.await,
        }?;
        Ok(results
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
            .unwrap_or_default())
    } else {
        Ok(vec![database.to_string()])
    };
    let schemas = match schemas_result {
        Ok(schemas) => schemas,
        Err(error) => {
            let _ = crate::query::rollback_manual_transaction(state, &session_id).await;
            return Err(error);
        }
    };
    if export_id.map(is_export_cancelled_now).unwrap_or(false) {
        let _ = crate::query::rollback_manual_transaction(state, &session_id).await;
        return Err(EXPORT_CANCELLED_ERROR.to_string());
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

/// 预取实际使用的连接池能同时 checkout 出来的请求数。
///
/// 并发预取只有在池真的能同时服务多条请求时才有意义：会话级连接池
/// （PostgreSQL/MySQL 的导出会话、标签页会话）只有一个物理连接，超出容量的并发
/// 只会把请求排到同一个连接后面，排队时间一旦超过 checkout 超时，该表的元数据
/// 就会以 "DBX metadata pool is busy; please retry" 失败（issue #10018）。
fn metadata_prefetch_pool_capacity(pool: Option<&crate::connection::PoolKind>) -> usize {
    match pool {
        Some(crate::connection::PoolKind::Postgres(pool)) => pool.status().max_size,
        Some(crate::connection::PoolKind::Mysql(pool, _)) => {
            // 会话级 MySQL 池同样只有一个连接；`None` 表示驱动未暴露上限，
            // 交由 `database_export_metadata_prefetch_concurrency` 按类型收敛。
            crate::db::mysql::MySqlPoolAccess::checkout_max_connections(pool).unwrap_or(usize::MAX)
        }
        // ClickHouse 走 HTTP，不存在按物理连接排队的上限。
        Some(crate::connection::PoolKind::ClickHouse(_)) => usize::MAX,
        // 其余驱动（含串行客户端与单连接句柄）一律按单连接处理，回退逐表串行直查。
        _ => 1,
    }
}

fn database_export_metadata_prefetch_concurrency(db_type: DatabaseType) -> usize {
    // PostgreSQL exports can hold a snapshot connection while metadata and UI
    // requests share the base pool. Keep enough capacity available for normal
    // browsing instead of filling nearly the entire ten-connection pool.
    if db_type == DatabaseType::Postgres {
        4
    } else {
        8
    }
}

/// 预取的实际并发度 = 数据库类型的上限 ∩ 预取所用连接池的容量。
///
/// 池容量为 1（会话级 PostgreSQL/MySQL 池）时并发度收敛到 1；调用方只在容量
/// 大于 1 时才启用预取，因此这里返回 1 意味着走逐表串行直查的回退路径。
fn metadata_prefetch_concurrency(db_type: DatabaseType, pool_capacity: usize) -> usize {
    database_export_metadata_prefetch_concurrency(db_type).min(pool_capacity.max(1))
}

fn record_export_error<W: Write>(
    file: &mut W,
    fail_on_error: bool,
    message: String,
    lenient_errors: &mut LenientExportErrors,
) -> Result<(), String> {
    if fail_on_error {
        Err(message)
    } else {
        lenient_errors.record(message.clone());
        writeln!(file, "-- ERROR {message}").map_err(|error| format!("Failed to write file: {error}"))
    }
}

fn mysql_spatial_export_marker_expression(column: &str) -> String {
    let quoted = quote_identifier(column, &DatabaseType::Mysql);
    format!(
        "CASE WHEN {quoted} IS NULL THEN NULL ELSE CONCAT('DBX_WKB:', ST_SRID({quoted}), ':', HEX(ST_AsWKB({quoted}))) END AS {quoted}"
    )
}

fn database_export_select_list(columns: &[String], column_types: &[Option<String>], db_type: &DatabaseType) -> String {
    columns
        .iter()
        .enumerate()
        .map(|(index, column)| {
            if *db_type == DatabaseType::Mysql
                && column_types.get(index).and_then(|value| value.as_deref()).is_some_and(is_mysql_spatial_export_type)
            {
                mysql_spatial_export_marker_expression(column)
            } else if *db_type == DatabaseType::Xugu
                && column_types.get(index).and_then(|value| value.as_deref()).is_some_and(is_xugu_spatial_export_type)
            {
                let quoted = quote_identifier(column, db_type);
                format!("ST_AsEWKT({quoted}) AS {quoted}")
            } else {
                quote_identifier(column, db_type)
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

pub(crate) fn replace_database_export_select_list(
    sql: String,
    columns: &[String],
    column_types: &[Option<String>],
    db_type: &DatabaseType,
) -> String {
    let original = columns.iter().map(|column| quote_identifier(column, db_type)).collect::<Vec<_>>().join(", ");
    let replacement = database_export_select_list(columns, column_types, db_type);
    if replacement == original {
        return sql;
    }
    let prefix = format!("SELECT {original}");
    if !sql.starts_with(&prefix) {
        log::warn!(
            "Spatial database export could not replace its SELECT list; geometry columns may lose SRID metadata"
        );
        return sql;
    }
    format!("SELECT {replacement}{}", &sql[prefix.len()..])
}

fn database_export_select_sql(
    columns: &[String],
    column_types: &[Option<String>],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
) -> String {
    let columns = database_export_select_list(columns, column_types, db_type);
    let table = crate::transfer::qualified_table(table, schema, db_type, None);
    format!("SELECT {columns} FROM {table}")
}

#[cfg(test)]
fn write_database_export_rows<W: Write>(
    file: &mut W,
    rows: &[Vec<Value>],
    columns: &[String],
    column_types: &[Option<String>],
    column_extras: &[Option<String>],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    insert_dialect: SqlInsertDialect,
) -> Result<(), String> {
    write_database_export_rows_with_mode(
        file,
        rows,
        columns,
        column_types,
        column_extras,
        table,
        schema,
        db_type,
        insert_dialect,
        SqlInsertMode::default(),
        false,
    )
}

#[allow(clippy::too_many_arguments)]
fn write_database_export_rows_with_mode<W: Write>(
    file: &mut W,
    rows: &[Vec<Value>],
    columns: &[String],
    column_types: &[Option<String>],
    column_extras: &[Option<String>],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    insert_dialect: SqlInsertDialect,
    insert_mode: SqlInsertMode,
    preserve_original_language: bool,
) -> Result<(), String> {
    let insert_indices = columns
        .iter()
        .enumerate()
        .filter(|(index, column)| {
            is_export_insert_column(
                Some(*db_type),
                column,
                column_types.get(*index).and_then(|value| value.as_deref()),
                column_extras.get(*index).and_then(|value| value.as_deref()),
            )
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if insert_indices.is_empty() {
        return Ok(());
    }
    let filtered_columns;
    let filtered_column_types;
    let filtered_column_extras;
    let filtered_rows;
    let (insert_columns, insert_column_types, insert_column_extras, insert_rows) = if insert_indices.len()
        == columns.len()
    {
        (columns, column_types, column_extras, rows)
    } else {
        filtered_columns = insert_indices.iter().map(|index| columns[*index].clone()).collect::<Vec<_>>();
        filtered_column_types =
            insert_indices.iter().map(|index| column_types.get(*index).cloned().unwrap_or(None)).collect::<Vec<_>>();
        filtered_column_extras =
            insert_indices.iter().map(|index| column_extras.get(*index).cloned().unwrap_or(None)).collect::<Vec<_>>();
        filtered_rows = rows
            .iter()
            .map(|row| insert_indices.iter().map(|index| row.get(*index).cloned().unwrap_or(Value::Null)).collect())
            .collect::<Vec<Vec<Value>>>();
        (
            filtered_columns.as_slice(),
            filtered_column_types.as_slice(),
            filtered_column_extras.as_slice(),
            filtered_rows.as_slice(),
        )
    };
    // Database exports use the same table qualification as the SELECT/DDL
    // path and the legacy typed INSERT writer. In particular, MySQL uses the
    // selected database rather than a schema-qualified table name.
    let qualified_table_name = crate::transfer::qualified_table(table, schema, db_type, None);
    // Batch database exports do not currently thread a per-connection identifier
    // quote through BuildDatabaseSqlExportOptions; Kingbase MySQL-compat users
    // should fall back to the single-table export path which carries the quote.
    let statements = build_export_insert_statements_excluding_with_dialect(
        BuildExportInsertStatementsOptions {
            database_type: Some(*db_type),
            identifier_quote: None,
            schema: (!schema.is_empty()).then(|| schema.to_string()),
            table_name: Some(table.to_string()),
            qualified_table_name: Some(qualified_table_name),
            columns: insert_columns.to_vec(),
            column_types: insert_column_types.to_vec(),
            column_extras: insert_column_extras.to_vec(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: insert_rows.to_vec(),
            batch_size: Some(insert_mode.batch_size(DATABASE_EXPORT_INSERT_BATCH_SIZE)),
            preserve_original_language,
        },
        &[],
        insert_dialect,
    )?;
    for statement in statements {
        writeln!(file, "{statement}\n").map_err(|error| format!("Failed to write file: {error}"))?;
    }
    Ok(())
}

fn emit_database_export_running(
    on_progress: &(impl Fn(ExportProgress) + Sync),
    export_id: &str,
    current_object: impl Into<String>,
    object_index: usize,
    total_objects: usize,
    rows_exported: u64,
    preparing: bool,
) {
    on_progress(ExportProgress {
        export_id: export_id.to_string(),
        current_object: current_object.into(),
        object_index,
        total_objects,
        rows_exported,
        total_rows: None,
        status: ExportStatus::Running,
        error: None,
        preparing,
        error_count: 0,
        error_summary: None,
    });
}

fn emit_database_export_cancelled(
    on_progress: &(impl Fn(ExportProgress) + Sync),
    export_id: &str,
    current_object: impl Into<String>,
    object_index: usize,
    total_objects: usize,
    rows_exported: u64,
) {
    on_progress(ExportProgress {
        export_id: export_id.to_string(),
        current_object: current_object.into(),
        object_index,
        total_objects,
        rows_exported,
        total_rows: None,
        status: ExportStatus::Cancelled,
        error: None,
        preparing: false,
        error_count: 0,
        error_summary: None,
    });
}

fn export_destination_state_key(dir: &std::path::Path) -> String {
    format!("database_export_destination:{}", dir.to_string_lossy())
}

const EXPORT_DESTINATION_IDENTITY_MAGIC: &[u8; 5] = b"DBXEI";
const EXPORT_DESTINATION_IDENTITY_VERSION: u8 = 1;
const EXPORT_DESTINATION_IDENTITY_DEVICE_KIND: u8 = 1;
const EXPORT_DESTINATION_IDENTITY_VOLUME_UUID_KIND: u8 = 2;

#[derive(Clone, Debug, PartialEq, Eq)]
enum ExportDestinationIdentity {
    Device(u64),
    PersistentVolumeUuid([u8; 16]),
    LegacyDevice(u64),
}

impl ExportDestinationIdentity {
    fn encode(&self) -> Vec<u8> {
        let mut encoded = Vec::with_capacity(EXPORT_DESTINATION_IDENTITY_MAGIC.len() + 2 + 16);
        encoded.extend_from_slice(EXPORT_DESTINATION_IDENTITY_MAGIC);
        encoded.push(EXPORT_DESTINATION_IDENTITY_VERSION);
        match self {
            Self::Device(device) => {
                encoded.push(EXPORT_DESTINATION_IDENTITY_DEVICE_KIND);
                encoded.extend_from_slice(&device.to_le_bytes());
            }
            Self::PersistentVolumeUuid(uuid) => {
                encoded.push(EXPORT_DESTINATION_IDENTITY_VOLUME_UUID_KIND);
                encoded.extend_from_slice(uuid);
            }
            Self::LegacyDevice(_) => unreachable!("legacy identities are decoded for migration, never written"),
        }
        encoded
    }

    fn decode(encoded: &[u8]) -> Result<Option<Self>, String> {
        if encoded.is_empty() {
            return Ok(None);
        }
        if let Ok(bytes) = <[u8; 8]>::try_from(encoded) {
            return Ok(Some(Self::LegacyDevice(u64::from_le_bytes(bytes))));
        }
        let Some((header, payload)) = encoded.split_at_checked(EXPORT_DESTINATION_IDENTITY_MAGIC.len() + 2) else {
            return Err("Stored database export destination identity is truncated".to_string());
        };
        if &header[..EXPORT_DESTINATION_IDENTITY_MAGIC.len()] != EXPORT_DESTINATION_IDENTITY_MAGIC {
            return Err("Stored database export destination identity has an unknown format".to_string());
        }
        if header[EXPORT_DESTINATION_IDENTITY_MAGIC.len()] != EXPORT_DESTINATION_IDENTITY_VERSION {
            return Err("Stored database export destination identity uses an unsupported version".to_string());
        }
        match header[EXPORT_DESTINATION_IDENTITY_MAGIC.len() + 1] {
            EXPORT_DESTINATION_IDENTITY_DEVICE_KIND => <[u8; 8]>::try_from(payload)
                .map(|bytes| Some(Self::Device(u64::from_le_bytes(bytes))))
                .map_err(|_| "Stored database export destination device identity has an invalid length".to_string()),
            EXPORT_DESTINATION_IDENTITY_VOLUME_UUID_KIND => <[u8; 16]>::try_from(payload)
                .map(|bytes| Some(Self::PersistentVolumeUuid(bytes)))
                .map_err(|_| "Stored database export destination volume UUID has an invalid length".to_string()),
            _ => Err("Stored database export destination identity has an unknown kind".to_string()),
        }
    }

    fn matches(&self, current: &Self) -> bool {
        match (self, current) {
            (Self::Device(expected), Self::Device(actual))
            | (Self::LegacyDevice(expected), Self::Device(actual))
            | (Self::Device(expected), Self::LegacyDevice(actual))
            | (Self::LegacyDevice(expected), Self::LegacyDevice(actual)) => expected == actual,
            (Self::PersistentVolumeUuid(expected), Self::PersistentVolumeUuid(actual)) => expected == actual,
            _ => false,
        }
    }
}

/// Records the destination identity for a scheduled backup as soon as it is
/// configured, not just after its first successful export. Scheduled plans
/// live in the frontend and may not run for hours after being saved; without
/// an eager record here, a destination whose mount disappears before its
/// very first run is indistinguishable from a brand-new local folder to
/// `ensure_export_destination_dir` (both have no recorded state) and gets
/// silently recreated on the wrong filesystem. The schedule editor only
/// accepts directories selected from the filesystem, so a missing path here
/// means the destination vanished before its identity could be recorded and
/// the schedule must not be saved. See #6327.
pub async fn record_export_destination_identity(
    state: &crate::connection::AppState,
    dir: &std::path::Path,
) -> Result<(), String> {
    if !dir.is_dir() {
        return Err(format!(
            "Backup directory {} does not exist or is not a directory. Select an existing destination before saving the schedule.",
            dir.display()
        ));
    }
    let identity = export_destination_identity_for_path(dir);
    save_export_destination_identity(state, dir, identity.as_ref()).await
}

async fn save_export_destination_identity(
    state: &crate::connection::AppState,
    dir: &std::path::Path,
    identity: Option<&ExportDestinationIdentity>,
) -> Result<(), String> {
    let value = identity.map(ExportDestinationIdentity::encode).unwrap_or_default();
    state.storage.save_state(&export_destination_state_key(dir), &value, "application/octet-stream").await
}

/// Read/delete operations must not trust a replaced backup mount or create a missing directory.
pub async fn verify_export_destination_identity(
    state: &crate::connection::AppState,
    dir: &std::path::Path,
) -> Result<(), String> {
    if !dir.is_dir() {
        return Err(format!("Backup directory is unavailable: {}", dir.display()));
    }
    let recorded = state
        .storage
        .load_state(&export_destination_state_key(dir))
        .await?
        .map(|(bytes, _)| ExportDestinationIdentity::decode(&bytes))
        .transpose()?
        .flatten();
    if recorded.as_ref().is_some_and(|identity| {
        recorded_export_destination_identity_mismatch(identity, export_destination_identity_for_path(dir).as_ref())
    }) {
        return Err(format!("Backup directory now resolves to a different filesystem: {}", dir.display()));
    }
    Ok(())
}

/// Returns whether this macOS destination still has the transient, untagged
/// `st_dev` identity written by DBX versions before persistent volume UUIDs
/// were introduced. The caller must require an explicit directory selection
/// before replacing it; unattended backups must continue to fail closed.
pub async fn export_destination_identity_needs_confirmation(
    state: &crate::connection::AppState,
    dir: &std::path::Path,
) -> Result<bool, String> {
    let recorded_identity = state
        .storage
        .load_state(&export_destination_state_key(dir))
        .await?
        .map(|(bytes, _content_type)| ExportDestinationIdentity::decode(&bytes))
        .transpose()?;
    Ok(cfg!(target_os = "macos") && matches!(recorded_identity, Some(Some(ExportDestinationIdentity::LegacyDevice(_)))))
}

/// Verifies the nearest persisted destination ancestor before a new child is
/// created. Scheduled runs always create new leaf directories, so checking
/// only the leaf would otherwise bypass the configured destination's mount
/// identity protection.
async fn ensure_recorded_export_destination_ancestor(
    state: &crate::connection::AppState,
    dir: &std::path::Path,
) -> Result<(), String> {
    let mut ancestor = dir.parent();
    while let Some(candidate) = ancestor {
        let recorded_identity = state
            .storage
            .load_state(&export_destination_state_key(candidate))
            .await?
            .map(|(bytes, _content_type)| ExportDestinationIdentity::decode(&bytes))
            .transpose()?;

        if let Some(recorded_identity) = recorded_identity {
            if !candidate.is_dir() {
                return Err(format!(
                    "Backup directory {} is missing. Its parent {} was configured or previously used for exports, so dbx will not recreate a child directory automatically -- if this is on a removable or network drive, reconnect it and try again.",
                    dir.display(),
                    candidate.display()
                ));
            }
            if let Some(recorded_identity) = recorded_identity {
                let current_identity = export_destination_identity_for_path(candidate);
                if recorded_export_destination_identity_mismatch(&recorded_identity, current_identity.as_ref()) {
                    return Err(format!(
                        "Backup directory {} now resolves to a different filesystem than the configured parent {}. Refusing to create a child directory automatically -- make sure the correct removable or network drive is connected before running the backup.",
                        dir.display(),
                        candidate.display()
                    ));
                }
            }
            return Ok(());
        }
        ancestor = candidate.parent();
    }
    Ok(())
}

/// Ensures `dir` exists for an export destination, without ever silently
/// recreating a directory that previously produced a successful export (or
/// was recorded via [`record_export_destination_identity`]) and has since
/// disappeared. Auto-creating on every run is unsafe for a destination on a
/// removable or network drive: a missing mount could be recreated on the
/// local filesystem. A new directory is safe to create only after any
/// recorded parent destination has been verified. See #6327.
///
/// Returns the identity that was just verified (or recorded for a newly
/// created directory), so the caller can re-verify it against the file it
/// actually opens.
async fn ensure_export_destination_dir(
    state: &crate::connection::AppState,
    dir: &std::path::Path,
) -> Result<Option<ExportDestinationIdentity>, String> {
    let key = export_destination_state_key(dir);
    let recorded_identity = state
        .storage
        .load_state(&key)
        .await?
        .map(|(bytes, _content_type)| ExportDestinationIdentity::decode(&bytes))
        .transpose()?;

    if dir.is_dir() {
        let current_identity = export_destination_identity_for_path(dir);
        if let Some(Some(recorded_identity)) = recorded_identity.as_ref() {
            if recorded_export_destination_identity_mismatch(recorded_identity, current_identity.as_ref()) {
                return Err(format!(
                    "Backup directory {} now resolves to a different filesystem than the last \
                     successful export to this location. Refusing to write here automatically -- \
                     if this directory is on a removable or network drive, make sure the correct \
                     drive is connected before running the backup.",
                    dir.display()
                ));
            }
        }
        save_export_destination_identity(state, dir, current_identity.as_ref()).await?;
        return Ok(current_identity);
    } else {
        if recorded_identity.is_some() {
            return Err(format!(
                "Backup directory {} is missing. It was configured or previously used for exports to \
                 this location, so dbx will not recreate it automatically -- if this is on a removable \
                 or network drive, reconnect it and try again.",
                dir.display()
            ));
        }
        // A run-specific child directory is intentionally new on every
        // scheduled backup. Before creating it, still honor a recorded parent
        // destination so a missing external/NAS mount is never recreated on
        // the local filesystem merely because this child has no state yet.
        ensure_recorded_export_destination_ancestor(state, dir).await?;
        std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create backup directory: {e}"))?;
    }

    let current_identity = export_destination_identity_for_path(dir);
    save_export_destination_identity(state, dir, current_identity.as_ref()).await?;
    Ok(current_identity)
}

fn recorded_export_destination_identity_mismatch(
    recorded: &ExportDestinationIdentity,
    current: Option<&ExportDestinationIdentity>,
) -> bool {
    #[cfg(target_os = "macos")]
    if matches!(recorded, ExportDestinationIdentity::LegacyDevice(_)) {
        // Legacy macOS state contains a transient st_dev value, not a durable
        // volume identity. Even an equal number after remount cannot prove it
        // is the volume the user selected, so only an explicit record action
        // may replace it with the persistent UUID.
        return true;
    }

    export_destination_identity_mismatch(Some(recorded), current)
}

/// Whether a destination's identity, checked once via [`ensure_export_destination_dir`]
/// and then again against the file dbx actually opened, indicates the mount
/// changed in between. An unknown expected identity has nothing to compare,
/// but once an expected identity is known, failing to identify the opened
/// handle must fail closed rather than allowing an unverified write.
fn export_destination_identity_mismatch(
    expected: Option<&ExportDestinationIdentity>,
    actual: Option<&ExportDestinationIdentity>,
) -> bool {
    expected.is_some_and(|expected| actual.is_none_or(|actual| !expected.matches(actual)))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn export_destination_identity_for_path(dir: &std::path::Path) -> Option<ExportDestinationIdentity> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(dir).ok().map(|metadata| ExportDestinationIdentity::Device(metadata.dev()))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn export_destination_identity_for_file(file: &std::fs::File) -> Option<ExportDestinationIdentity> {
    use std::os::unix::fs::MetadataExt;
    file.metadata().ok().map(|metadata| ExportDestinationIdentity::Device(metadata.dev()))
}

#[cfg(target_os = "macos")]
fn export_destination_identity_for_path(dir: &std::path::Path) -> Option<ExportDestinationIdentity> {
    let directory = std::fs::File::open(dir).ok()?;
    export_destination_identity_for_file(&directory)
}

#[cfg(target_os = "macos")]
fn export_destination_identity_for_file(file: &std::fs::File) -> Option<ExportDestinationIdentity> {
    macos_export_destination::persistent_volume_uuid(file).map(ExportDestinationIdentity::PersistentVolumeUuid).or_else(
        || {
            use std::os::unix::fs::MetadataExt;
            file.metadata().ok().map(|metadata| ExportDestinationIdentity::Device(metadata.dev()))
        },
    )
}

#[cfg(windows)]
fn export_destination_identity_for_path(dir: &std::path::Path) -> Option<ExportDestinationIdentity> {
    windows_export_destination::device_id_for_path(dir).map(ExportDestinationIdentity::Device)
}

#[cfg(windows)]
fn export_destination_identity_for_file(file: &std::fs::File) -> Option<ExportDestinationIdentity> {
    windows_export_destination::device_id_for_handle(file).map(ExportDestinationIdentity::Device)
}

#[cfg(not(any(unix, windows)))]
fn export_destination_identity_for_path(_dir: &std::path::Path) -> Option<ExportDestinationIdentity> {
    None
}

#[cfg(not(any(unix, windows)))]
fn export_destination_identity_for_file(_file: &std::fs::File) -> Option<ExportDestinationIdentity> {
    None
}

#[cfg(target_os = "macos")]
mod macos_export_destination {
    use std::os::fd::AsRawFd;

    #[repr(C)]
    struct VolumeUuidBuffer {
        length: u32,
        uuid: [u8; 16],
    }

    pub(super) fn persistent_volume_uuid(file: &std::fs::File) -> Option<[u8; 16]> {
        let mut attributes = nix::libc::attrlist {
            bitmapcount: nix::libc::ATTR_BIT_MAP_COUNT,
            reserved: 0,
            commonattr: 0,
            volattr: nix::libc::ATTR_VOL_INFO | nix::libc::ATTR_VOL_UUID,
            dirattr: 0,
            fileattr: 0,
            forkattr: 0,
        };
        let mut buffer = VolumeUuidBuffer { length: 0, uuid: [0; 16] };
        let result = unsafe {
            nix::libc::fgetattrlist(
                file.as_raw_fd(),
                std::ptr::from_mut(&mut attributes).cast(),
                std::ptr::from_mut(&mut buffer).cast(),
                std::mem::size_of::<VolumeUuidBuffer>(),
                0,
            )
        };
        (result == 0 && buffer.length as usize >= std::mem::size_of::<VolumeUuidBuffer>() && buffer.uuid != [0; 16])
            .then_some(buffer.uuid)
    }
}

/// Windows has no stable `std` API for a directory or file's volume identity
/// (`MetadataExt::volume_serial_number` is still gated behind the unstable
/// `windows_by_handle` feature), so this queries `dwVolumeSerialNumber` from
/// `BY_HANDLE_FILE_INFORMATION` directly. Using the *handle* rather than
/// re-resolving the path is what makes `export_destination_identity_for_file`
/// safe to call on an already-open `File`: it reports the volume the handle
/// was actually opened against, not whatever currently sits at that path.
#[cfg(windows)]
mod windows_export_destination {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    pub(super) fn device_id_for_path(path: &Path) -> Option<u64> {
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        wide.push(0);
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return None;
        }
        let result = volume_serial_number(handle);
        unsafe { CloseHandle(handle) };
        result
    }

    pub(super) fn device_id_for_handle(file: &std::fs::File) -> Option<u64> {
        volume_serial_number(file.as_raw_handle() as HANDLE)
    }

    fn volume_serial_number(handle: HANDLE) -> Option<u64> {
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        let ok = unsafe { GetFileInformationByHandle(handle, &mut info) };
        (ok != 0).then_some(info.dwVolumeSerialNumber as u64)
    }
}

pub async fn export_database_sql_core(
    state: &Arc<crate::connection::AppState>,
    request: &DatabaseExportRequest,
    on_progress: impl Fn(ExportProgress) + Sync,
) -> Result<(), String> {
    let db_type = state
        .configs
        .read()
        .await
        .get(&request.connection_id)
        .map(|config| config.db_type)
        .ok_or_else(|| format!("Connection config not found: {}", request.connection_id))?;
    // Keep the large export state machine on the heap. Besides making the
    // caller future small, this prevents the metadata-prefetch locals from
    // exhausting the bounded stack used by test and runtime worker threads.
    let result = if matches!(db_type, DatabaseType::Postgres) && request.schema.trim().is_empty() {
        Box::pin(export_postgres_all_schemas_sql_core(state, request, &on_progress)).await
    } else {
        Box::pin(export_database_sql_core_inner(state, request, &on_progress)).await
    };
    let metadata_session_id = database_export_client_session_id(&request.export_id);
    if let Err(error) =
        state.close_metadata_session_pool(&request.connection_id, Some(&request.database), &metadata_session_id).await
    {
        log::warn!(
            "[database-export] failed to close metadata session '{}' for '{}': {error}",
            metadata_session_id,
            request.connection_id
        );
    }
    if result.as_ref().err().is_some_and(|error| error == EXPORT_CANCELLED_ERROR) {
        // Every caller (Tauri and web SSE) needs a terminal Cancelled event;
        // returning the marker as an error would leave the web EventSource
        // without a terminal event and surface cancellation as Error in Tauri.
        emit_database_export_cancelled(&on_progress, &request.export_id, String::new(), 0, 0, 0);
        Ok(())
    } else {
        result
    }
}

/// Destination directory that must exist (and stay on the same filesystem)
/// before the export file may be written there, or `None` when the file path
/// has no parent (e.g. a bare file name or the filesystem root). Shared by
/// [`create_database_export_writer`] and the all-schemas export, which
/// validates the destination up front instead of only after exporting every
/// schema to temporary files.
fn export_destination_parent_dir(file_path: &str) -> Option<&std::path::Path> {
    let parent = std::path::Path::new(file_path).parent()?;
    (!parent.as_os_str().is_empty()).then_some(parent)
}

/// Name recorded inside `manifest.json` as the logical "source file" the
/// split parts represent, e.g. `mydb.zip` -> `mydb.sql`. When splitting is
/// disabled this is unused (the writer variant never calls it).
fn export_source_file_name(file_path: &str) -> String {
    let path = std::path::Path::new(file_path);
    let stem = path.file_stem().and_then(|stem| stem.to_str()).unwrap_or("export");
    format!("{stem}.sql")
}

tokio::task_local! {
    static TRACKED_BACKUP_DESTINATION: (std::path::PathBuf, Arc<std::sync::atomic::AtomicBool>);
}

/// Tracks successful create_new separately from preparation errors and path collisions.
pub(crate) async fn track_backup_destination<F: std::future::Future>(
    path: std::path::PathBuf,
    created: Arc<std::sync::atomic::AtomicBool>,
    operation: F,
) -> F::Output {
    TRACKED_BACKUP_DESTINATION.scope((path, created), operation).await
}

async fn create_database_export_writer(
    state: &Arc<crate::connection::AppState>,
    request: &DatabaseExportRequest,
) -> Result<DatabaseExportWriter, String> {
    let mut expected_destination_identity = None;
    if let Some(parent) = export_destination_parent_dir(&request.file_path) {
        expected_destination_identity = ensure_export_destination_dir(state, parent).await?;
    }
    if let Some(max_mb) = request.split_max_mb {
        let zip_path = std::path::Path::new(&request.file_path);
        let stem = zip_path.file_stem().and_then(|stem| stem.to_str()).unwrap_or("export");
        let writer = crate::export_split_zip::SplitZipExportWriter::create_with_overwrite(
            zip_path,
            max_mb,
            stem,
            "sql",
            request.prevent_overwrite,
        )?;
        let opened_destination_identity =
            std::fs::File::open(&request.file_path).ok().as_ref().and_then(export_destination_identity_for_file);
        if export_destination_identity_mismatch(
            expected_destination_identity.as_ref(),
            opened_destination_identity.as_ref(),
        ) {
            let _ = std::fs::remove_file(&request.file_path);
            return Err(format!(
                "Backup destination for {} changed while opening the output file -- the directory now \
                 resolves to a different filesystem than the one just verified. If a removable or network \
                 drive was disconnected and reconnected, retry the backup.",
                request.file_path
            ));
        }
        return Ok(DatabaseExportWriter::SplitZip(Box::new(writer)));
    }
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(!request.prevent_overwrite)
        .create_new(request.prevent_overwrite)
        .open(&request.file_path)
        .map_err(|error| {
            if request.prevent_overwrite && error.kind() == std::io::ErrorKind::AlreadyExists {
                format!("Backup file already exists: {}", request.file_path)
            } else {
                format!("Failed to write file: {error}")
            }
        })?;
    // The directory check above and this file open are separate
    // operations: the mount can disappear and be replaced by something else
    // at the same path in between. Re-check the identity of the handle we
    // actually opened, not just the path, and refuse to keep a backup that
    // landed on the wrong filesystem. See #6327.
    if request.prevent_overwrite {
        let _ = TRACKED_BACKUP_DESTINATION.try_with(|(path, created)| {
            if path == std::path::Path::new(&request.file_path) {
                created.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        });
    }
    let opened_destination_identity = export_destination_identity_for_file(&file);
    if export_destination_identity_mismatch(
        expected_destination_identity.as_ref(),
        opened_destination_identity.as_ref(),
    ) {
        drop(file);
        let _ = std::fs::remove_file(&request.file_path);
        return Err(format!(
            "Backup destination for {} changed while opening the output file -- the directory now \
             resolves to a different filesystem than the one just verified. If a removable or network \
             drive was disconnected and reconnected, retry the backup.",
            request.file_path
        ));
    }
    Ok(match request.output_compression {
        DatabaseExportOutputCompression::None => DatabaseExportWriter::Plain(BufWriter::new(file)),
        DatabaseExportOutputCompression::Gzip => {
            DatabaseExportWriter::Gzip(Box::new(GzEncoder::new(BufWriter::new(file), Compression::default())))
        }
    })
}

fn postgres_export_schema_names(schemas: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    schemas
        .into_iter()
        .map(|schema| schema.trim().to_string())
        .filter(|schema| !schema.is_empty() && schema != "information_schema" && !schema.starts_with("pg_"))
        .filter(|schema| seen.insert(schema.clone()))
        .collect()
}

fn postgres_create_schema_sql(schema: &str) -> String {
    format!("CREATE SCHEMA IF NOT EXISTS {};", quote_identifier(schema, &DatabaseType::Postgres))
}

fn combine_schema_sql_export<W: Write>(source: &mut dyn BufRead, destination: &mut W) -> std::io::Result<()> {
    let mut splitter = SqlStatementSplitter::with_options(SqlParsingOptions::for_database_type(DatabaseType::Postgres));
    let mut chunk = String::new();
    loop {
        chunk.clear();
        let bytes_read = source.read_line(&mut chunk)?;
        if bytes_read == 0 {
            break;
        }
        for statement in splitter.push_chunk(&chunk) {
            destination.write_all(format!("{statement};\n").as_bytes())?;
        }
    }
    for statement in splitter.finish() {
        destination.write_all(format!("{statement};\n").as_bytes())?;
    }
    Ok(())
}

async fn export_postgres_all_schemas_sql_core(
    state: &Arc<crate::connection::AppState>,
    request: &DatabaseExportRequest,
    on_progress: impl Fn(ExportProgress) + Sync,
) -> Result<(), String> {
    let schemas = postgres_export_schema_names(
        crate::schema::list_schemas_core(state, &request.connection_id, &request.database).await?,
    );
    if schemas.is_empty() {
        return Err(format!("No exportable schemas found in database '{}'.", request.database));
    }

    // Validate the destination before exporting every schema to temporary
    // files: the writer below only runs after the loop, which for large
    // databases can be hours away, and a missing or unwritable destination
    // must fail fast instead. This is an early fail, not a replacement -- the
    // writer still performs its own checks when it opens the output file.
    if let Some(parent) = export_destination_parent_dir(&request.file_path) {
        ensure_export_destination_dir(state, parent).await?;
    }

    let temp_dir =
        tempfile::tempdir().map_err(|error| format!("Failed to create temporary export directory: {error}"))?;
    let result = async {
        let mut schema_outputs = Vec::with_capacity(schemas.len());
        let mut rows_exported = 0_u64;
        let mut error_count = 0_u64;
        let mut error_summary = None;

        for (schema_index, schema_name) in schemas.iter().enumerate() {
            let mut schema_request = request.clone();
            schema_request.schema = schema_name.clone();
            schema_request.file_path = temp_dir.path().join(format!("schema-{schema_index}.sql")).display().to_string();
            schema_request.output_compression = DatabaseExportOutputCompression::None;
            schema_request.split_max_mb = None;

            let terminal = Arc::new(std::sync::Mutex::new(None::<ExportProgress>));
            let terminal_for_callback = terminal.clone();
            let schema_name_for_callback = schema_name.clone();
            let completed_rows = rows_exported;
            let child_progress = |mut progress: ExportProgress| {
                if matches!(progress.status, ExportStatus::Done | ExportStatus::Cancelled) {
                    *terminal_for_callback.lock().expect("export terminal mutex poisoned") = Some(progress);
                    return;
                }
                progress.export_id = request.export_id.clone();
                progress.current_object = if progress.current_object.is_empty() {
                    schema_name_for_callback.clone()
                } else {
                    format!("{schema_name_for_callback}: {}", progress.current_object)
                };
                progress.rows_exported = completed_rows.saturating_add(progress.rows_exported);
                on_progress(progress);
            };

            Box::pin(export_database_sql_core_inner(state, &schema_request, child_progress)).await?;
            let terminal = terminal.lock().expect("export terminal mutex poisoned").clone();
            if terminal.as_ref().is_some_and(|progress| matches!(progress.status, ExportStatus::Cancelled)) {
                return Err(EXPORT_CANCELLED_ERROR.to_string());
            }
            if let Some(progress) = terminal {
                rows_exported = rows_exported.saturating_add(progress.rows_exported);
                error_count = error_count.saturating_add(progress.error_count);
                // Aggregate lenient failure summaries across schemas; keeping
                // only the first schema's summary would understate the errors
                // behind an error_count that accumulates over all schemas.
                if let Some(summary) = progress.error_summary {
                    error_summary = Some(match error_summary.take() {
                        Some(existing) => format!("{existing}; {summary}"),
                        None => summary,
                    });
                }
            }
            schema_outputs.push((schema_name.clone(), schema_request.file_path));
        }

        let mut file = create_database_export_writer(state, request).await?;
        let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
        writeln!(file, "-- Database export: {}", request.database).map_err(|e| format!("Failed to write file: {e}"))?;
        writeln!(file, "-- Date: {timestamp}").map_err(|e| format!("Failed to write file: {e}"))?;
        writeln!(file, "-- Generated by DBX").map_err(|e| format!("Failed to write file: {e}"))?;
        writeln!(file, "-- PostgreSQL schemas: {}", schemas.join(", "))
            .map_err(|e| format!("Failed to write file: {e}"))?;
        writeln!(file).map_err(|e| format!("Failed to write file: {e}"))?;
        for schema_name in &schemas {
            writeln!(file, "{}", postgres_create_schema_sql(schema_name))
                .map_err(|e| format!("Failed to write file: {e}"))?;
        }
        writeln!(file).map_err(|e| format!("Failed to write file: {e}"))?;

        for (schema_name, path) in schema_outputs {
            writeln!(file, "-- Schema export: {schema_name}").map_err(|e| format!("Failed to write file: {e}"))?;
            let mut source = std::io::BufReader::new(
                std::fs::File::open(path).map_err(|e| format!("Failed to read temporary schema export: {e}"))?,
            );
            combine_schema_sql_export(&mut source, &mut file)
                .map_err(|e| format!("Failed to combine schema export: {e}"))?;
            writeln!(file).map_err(|e| format!("Failed to write file: {e}"))?;
        }
        file.finish(&export_source_file_name(&request.file_path))?;
        on_progress(ExportProgress {
            export_id: request.export_id.clone(),
            current_object: request.database.clone(),
            object_index: schemas.len(),
            total_objects: schemas.len(),
            rows_exported,
            total_rows: None,
            status: ExportStatus::Done,
            error: None,
            preparing: false,
            error_count,
            error_summary,
        });
        Ok(())
    }
    .await;

    result
}

async fn export_database_sql_core_inner(
    state: &Arc<crate::connection::AppState>,
    request: &DatabaseExportRequest,
    on_progress: impl Fn(ExportProgress) + Sync,
) -> Result<(), String> {
    let _snapshot_keep_alive = if let Some(snapshot_session_id) = request.snapshot_session_id.as_deref() {
        Some(crate::query::keep_manual_transaction_alive(state, snapshot_session_id).await?)
    } else {
        None
    };
    let mut lenient_errors = LenientExportErrors::default();

    // Emit immediately so the UI is never blank while we list schema metadata.
    emit_database_export_running(&on_progress, &request.export_id, "", 0, 0, 0, true);

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
    let pool_key = Box::pin(state.get_or_create_pool_for_session(
        &request.connection_id,
        Some(&request.database),
        Some(&client_session_id),
    ))
    .await?;

    // 3. List tables
    let all_tables = Box::pin(crate::schema::list_tables_core(
        state,
        &request.connection_id,
        &request.database,
        &request.schema,
        None,
        None,
        None,
        None,
        None,
    ))
    .await?;
    // 4. Create file
    let mut file = create_database_export_writer(state, request).await?;

    let create_database_preamble = if request.include_create_database && matches!(db_type, DatabaseType::Mysql) {
        Some(mysql_database_export_preamble_for_request(state, request, &client_session_id).await)
    } else {
        None
    };

    // 5. Write header
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    writeln!(file, "-- Database export: {}", request.database).map_err(|e| format!("Failed to write file: {e}"))?;
    writeln!(file, "-- Date: {timestamp}").map_err(|e| format!("Failed to write file: {e}"))?;
    writeln!(file, "-- Generated by DBX").map_err(|e| format!("Failed to write file: {e}"))?;
    writeln!(file).map_err(|e| format!("Failed to write file: {e}"))?;

    // Declare the script's encoding before the first statement that can carry non-ASCII
    // text (the database name is written by the preamble right below, and table, column
    // and DEFAULT values follow).
    if matches!(db_type, DatabaseType::Mysql) {
        writeln!(file, "{MYSQL_EXPORT_CHARSET_STATEMENT}").map_err(|e| format!("Failed to write file: {e}"))?;
    }

    if let Some(preamble) = create_database_preamble {
        writeln!(file, "-- Database setup").map_err(|e| format!("Failed to write file: {e}"))?;
        writeln!(file, "{preamble}").map_err(|e| format!("Failed to write file: {e}"))?;
    }

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
                    record_export_error(
                        &mut file,
                        request.fail_on_error,
                        format!("reading extension members: {e}"),
                        &mut lenient_errors,
                    )?;
                    PostgresExtensionMembers::default()
                }
            }
        } else {
            PostgresExtensionMembers::default()
        };
    let postgres_extensions = if request.include_structure && matches!(db_type, DatabaseType::Postgres) {
        match crate::schema::list_extensions_core(
            state,
            &request.connection_id,
            &request.database,
            Some(&request.schema),
        )
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
                record_export_error(
                    &mut file,
                    request.fail_on_error,
                    format!("exporting extensions: {e}"),
                    &mut lenient_errors,
                )?;
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };
    let postgres_enums = if request.include_structure && matches!(db_type, DatabaseType::Postgres) {
        match await_export_operation(
            &request.export_id,
            Box::pin(list_postgres_export_enums(state, &pool_key, &request.schema)),
        )
        .await
        {
            Ok(enums) => enums,
            Err(e) if e == EXPORT_CANCELLED_ERROR => return Err(EXPORT_CANCELLED_ERROR.to_string()),
            Err(e) => {
                record_export_error(
                    &mut file,
                    request.fail_on_error,
                    format!("exporting enums: {e}"),
                    &mut lenient_errors,
                )?;
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
    let mut views: Vec<_> = all_tables.iter().filter(|t| t.table_type.contains("VIEW")).collect();
    if request.include_objects && db_type == DatabaseType::Mysql && views.len() > 1 {
        match list_mysql_export_view_dependencies(state, &request.connection_id, &request.database, &client_session_id)
            .await
        {
            Ok(dependencies) => views = sort_export_views_by_dependencies(&views, &dependencies),
            Err(error) => {
                log::debug!(
                    "[database-export] failed to resolve MySQL view dependencies for {}: {error}",
                    request.database
                );
            }
        }
    }
    let postgres_sequences = if request.include_structure && matches!(db_type, DatabaseType::Postgres) {
        match await_export_operation(
            &request.export_id,
            Box::pin(list_postgres_export_sequences(
                state,
                &pool_key,
                &request.schema,
                &request.selected_tables,
                &request.excluded_tables,
                request.include_objects,
                request.fail_on_error,
            )),
        )
        .await
        {
            Ok(sequences) => sequences,
            Err(e) if e == EXPORT_CANCELLED_ERROR => return Err(EXPORT_CANCELLED_ERROR.to_string()),
            Err(e) => {
                record_export_error(
                    &mut file,
                    request.fail_on_error,
                    format!("exporting sequences: {e}"),
                    &mut lenient_errors,
                )?;
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };

    // Sort tables by foreign key dependency so referenced (parent) tables are
    // exported before referencing (child) tables. MySQL exports always emit
    // `SET FOREIGN_KEY_CHECKS = 0`, so both the generated DDL and any INSERTs
    // already tolerate child-before-parent ordering; reordering away from the
    // alphabetical listing there only makes the output look shuffled to users
    // without providing any correctness benefit.
    if tables.len() > 1 && db_type != DatabaseType::Mysql {
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

    // 8. Discover optional schema-wide objects before calculating workload.
    let mut procedures: Vec<crate::types::ObjectInfo> = Vec::new();
    let mut functions: Vec<crate::types::ObjectInfo> = Vec::new();
    let mut triggers: Vec<crate::types::ObjectInfo> = Vec::new();
    let mut events: Vec<crate::types::ObjectInfo> = Vec::new();

    if exports_schema_wide_objects(request) {
        match crate::schema::list_objects_core(
            state,
            &request.connection_id,
            &request.database,
            &request.schema,
            None,
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
                    } else if exports_mysql_trigger_objects(db_type) && ot.contains("TRIGGER") {
                        triggers.push(obj.clone());
                    } else if exports_mysql_trigger_objects(db_type) && ot.contains("EVENT") {
                        events.push(obj.clone());
                    }
                }
            }
            Err(error) if request.fail_on_error => return Err(format!("Failed to list database objects: {error}")),
            Err(_) => {}
        }
    }

    // A determinate total must describe the same object categories guarded by
    // the execution branches below, not every object discovered in the schema.
    let total_objects = database_export_total_objects(
        request,
        &DatabaseExportObjectCounts {
            tables: tables.len(),
            views: views.len(),
            sequences: postgres_sequences.iter().filter(|sequence| !sequence.created_by_table).count(),
            extensions: postgres_extensions.len(),
            enums: postgres_enums.len(),
            procedures: procedures.len(),
            functions: functions.len(),
            triggers: triggers.len(),
            events: events.len(),
        },
    );

    let mut object_index: usize = 0;
    let mut total_rows_exported = 0_u64;
    let mut deferred_postgres_triggers = Vec::new();
    // PostgreSQL foreign keys collected from table DDL while writing structure,
    // emitted at the end of the file (see `extract_postgres_deferred_foreign_keys`).
    let mut deferred_postgres_foreign_keys: Vec<String> = Vec::new();
    // total_objects is known later for the write phase; preparing updates stay
    // presence-only so the UI does not show a counter that later resets.
    emit_database_export_running(&on_progress, &request.export_id, "", 0, 0, 0, true);

    let batch_size = if request.batch_size == 0 { 1000 } else { request.batch_size };

    // 预取各表的 DDL 与列元数据：逐表串行往返在多表数据库上是整库导出耗时的
    // 主要来源（每表 1-2 次网络往返 × 表数）。有界并发预取后，下方写出循环仍按
    // 原顺序消费，文件内容与逐表查询完全一致。放在写出循环之前，避免准备态与导出态来回跳。
    struct PrefetchedTableMetadata {
        ddl: Option<Result<String, String>>,
        columns: Option<Result<Vec<crate::db::ColumnInfo>, String>>,
    }
    let mut prefetched_table_metadata: Vec<Option<PrefetchedTableMetadata>> = Vec::new();
    prefetched_table_metadata.resize_with(tables.len(), || None);
    // 防护门按「实际连接池种类」放行，而非数据库类型的能力标记：只有确认底层
    // 支持并发请求的多连接池（Postgres/MySQL/ClickHouse）才启用并发预取。反例：
    // 原生 SQL Server 是 Arc<Mutex<..>> 串行客户端；Agent/外部 JDBC（含 SQL Server
    // legacy profile、PrestoSQL 等路由结果）的插件请求超时覆盖排队时间且超时会
    // 终止 sidecar；SQLite/DuckDB 等为单连接。被挡住的场景预取 Vec 保持全 None，
    // 写出循环内的 None 回退路径即原有的逐表串行直查行为。
    //
    // 这里必须检查预取**真正使用**的那个池：下面的 DDL/列元数据都带
    // `client_session_id`，走的是导出会话的元数据池，而不是基础池。PostgreSQL
    // 的会话池只有一个物理连接，若按基础池（10 连接）放行 4 路预取，每张表的
    // `pg_ddl` 还会各自并发 8 个 checkout，32 个 checkout 挤在一条连接上，队尾
    // 等待超过 checkout 超时后整张表的 DDL 就会以 "DBX metadata pool is busy;
    // please retry" 失败（issue #10018）。
    let metadata_prefetch_pool = match state
        .get_or_create_metadata_pool_for_session(
            &request.connection_id,
            Some(&request.database),
            Some(&client_session_id),
        )
        .await
    {
        Ok(metadata_pool_key) => state.pool_handle(&metadata_pool_key).await,
        // 建池失败时不预取，让写出循环的直查路径按原有方式报告错误
        Err(_) => None,
    };
    let metadata_prefetch_capacity = metadata_prefetch_pool_capacity(metadata_prefetch_pool.as_ref());
    let concurrent_prefetch_is_safe =
        metadata_prefetch_capacity > 1 && concurrent_metadata_prefetch_allowed(metadata_prefetch_pool.as_ref());
    if concurrent_prefetch_is_safe
        && exports_database_tables(request)
        && !tables.is_empty()
        && !is_export_cancelled(&request.export_id).await
    {
        use futures::StreamExt;
        let prefetch_targets: Vec<(usize, String)> =
            tables.iter().enumerate().map(|(index, table_info)| (index, table_info.name.clone())).collect();
        let mut prefetch_stream = futures::stream::iter(prefetch_targets.into_iter().map(|(index, table_name)| {
            let client_session_id = client_session_id.clone();
            Box::pin(async move {
                if is_export_cancelled_now(&request.export_id) {
                    return (index, PrefetchedTableMetadata { ddl: None, columns: None });
                }
                let ddl = if request.include_structure {
                    Some(
                        await_export_operation(
                            &request.export_id,
                            Box::pin(get_export_table_ddl_isolated(
                                state.clone(),
                                request.connection_id.clone(),
                                request.database.clone(),
                                request.schema.clone(),
                                table_name.clone(),
                                client_session_id.clone(),
                            )),
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
                        await_export_operation(
                            &request.export_id,
                            Box::pin(get_export_table_columns_isolated(
                                state.clone(),
                                request.connection_id.clone(),
                                request.database.clone(),
                                request.schema.clone(),
                                table_name.clone(),
                                client_session_id.clone(),
                            )),
                        )
                        .await,
                    )
                } else {
                    None
                };
                (index, PrefetchedTableMetadata { ddl, columns })
            })
        }))
        .buffer_unordered(metadata_prefetch_concurrency(db_type, metadata_prefetch_capacity));
        while let Some((index, metadata)) = prefetch_stream.next().await {
            if metadata
                .ddl
                .as_ref()
                .is_some_and(|result| result.as_ref().err().is_some_and(|error| error == EXPORT_CANCELLED_ERROR))
                || metadata
                    .columns
                    .as_ref()
                    .is_some_and(|result| result.as_ref().err().is_some_and(|error| error == EXPORT_CANCELLED_ERROR))
            {
                return Err(EXPORT_CANCELLED_ERROR.to_string());
            }
            prefetched_table_metadata[index] = Some(metadata);
            if let Some(table_info) = tables.get(index) {
                // Presence-only updates: no prepare counter that later resets to 0/N.
                emit_database_export_running(
                    &on_progress,
                    &request.export_id,
                    table_info.name.clone(),
                    0,
                    0,
                    total_rows_exported,
                    true,
                );
            }
            // 取消后不再调度新的预取任务（已在途的任务随 stream 释放而中止），
            // 写出循环入口的取消检查负责最终收尾
            if is_export_cancelled_now(&request.export_id) {
                break;
            }
        }
    }

    for extension in &postgres_extensions {
        if is_export_cancelled(&request.export_id).await {
            return Err("Export cancelled".to_string());
        }
        emit_database_export_running(
            &on_progress,
            &request.export_id,
            extension.name.clone(),
            object_index,
            total_objects,
            total_rows_exported,
            false,
        );
        writeln!(file, "{}\n", generate_postgres_extension_ddl(extension))
            .map_err(|e| format!("Failed to write file: {e}"))?;
        object_index += 1;
    }

    for enum_type in &postgres_enums {
        if is_export_cancelled(&request.export_id).await {
            return Err("Export cancelled".to_string());
        }
        emit_database_export_running(
            &on_progress,
            &request.export_id,
            enum_type.name.clone(),
            object_index,
            total_objects,
            total_rows_exported,
            false,
        );
        writeln!(file, "{}\n", generate_postgres_enum_ddl(enum_type))
            .map_err(|e| format!("Failed to write file: {e}"))?;
        object_index += 1;
    }

    for sequence in postgres_sequences.iter().filter(|sequence| sequence.owner_table.is_none()) {
        if is_export_cancelled(&request.export_id).await {
            return Err("Export cancelled".to_string());
        }

        emit_database_export_running(
            &on_progress,
            &request.export_id,
            sequence.name.clone(),
            object_index,
            total_objects,
            total_rows_exported,
            false,
        );

        writeln!(file, "{};\n", generate_postgres_sequence_create_ddl(sequence, &request.schema))
            .map_err(|e| format!("Failed to write file: {e}"))?;
        object_index += 1;
    }

    for (table_index, table_info) in tables.iter().enumerate().filter(|_| exports_database_tables(request)) {
        // Check cancellation
        if is_export_cancelled(&request.export_id).await {
            emit_database_export_cancelled(
                &on_progress,
                &request.export_id,
                table_info.name.clone(),
                object_index,
                total_objects,
                total_rows_exported,
            );
            return Ok(());
        }

        let table_name = &table_info.name;

        // Emit Running progress
        on_progress(ExportProgress {
            export_id: request.export_id.clone(),
            current_object: table_name.clone(),
            object_index,
            total_objects,
            rows_exported: total_rows_exported,
            total_rows: None,
            status: ExportStatus::Running,
            error: None,
            preparing: false,
            error_count: 0,
            error_summary: None,
        });

        // Export structure
        if request.include_structure {
            if request.drop_table_if_exists {
                writeln!(file, "{}\n", drop_table_if_exists_sql(table_name, &request.schema, &db_type))
                    .map_err(|e| format!("Failed to write file: {e}"))?;
            }
            for sequence in postgres_sequences.iter().filter(|sequence| {
                !sequence.created_by_table && sequence.owner_table.as_deref() == Some(table_name.as_str())
            }) {
                on_progress(ExportProgress {
                    export_id: request.export_id.clone(),
                    current_object: sequence.name.clone(),
                    object_index,
                    total_objects,
                    rows_exported: total_rows_exported,
                    total_rows: None,
                    status: ExportStatus::Running,
                    error: None,
                    preparing: false,
                    error_count: 0,
                    error_summary: None,
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
                    await_export_operation(
                        &request.export_id,
                        Box::pin(get_export_table_ddl_isolated(
                            state.clone(),
                            request.connection_id.clone(),
                            request.database.clone(),
                            request.schema.clone(),
                            table_name.clone(),
                            client_session_id.clone(),
                        )),
                    )
                    .await
                }
            };
            if ddl_result.as_ref().err().is_some_and(|error| error == EXPORT_CANCELLED_ERROR) {
                return Err(EXPORT_CANCELLED_ERROR.to_string());
            }
            match ddl_result {
                Ok(ddl) => {
                    let (ddl, triggers) = split_postgres_export_table_triggers(&ddl, db_type);
                    deferred_postgres_triggers.extend(triggers);
                    // Defer inline foreign keys so restore never has to satisfy
                    // the dependency graph's order (cycles included).
                    let ddl = if db_type == DatabaseType::Postgres {
                        let (stripped, deferred) =
                            extract_postgres_deferred_foreign_keys(&ddl, &request.schema, table_name);
                        deferred_postgres_foreign_keys.extend(deferred);
                        stripped
                    } else {
                        ddl
                    };
                    let ddl = format_export_table_ddl(
                        &ddl,
                        Some(db_type),
                        DdlNormalizeOptions { omit_auto_increment: request.omit_auto_increment },
                    );
                    writeln!(file, "{ddl}\n").map_err(|e| format!("Failed to write file: {e}"))?;
                }
                Err(e) => {
                    record_export_error(
                        &mut file,
                        request.fail_on_error,
                        format!("exporting table structure {table_name}: {e}"),
                        &mut lenient_errors,
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
                    await_export_operation(
                        &request.export_id,
                        Box::pin(get_export_table_columns_isolated(
                            state.clone(),
                            request.connection_id.clone(),
                            request.database.clone(),
                            request.schema.clone(),
                            table_name.clone(),
                            client_session_id.clone(),
                        )),
                    )
                    .await
                }
            };
            if columns_result.as_ref().err().is_some_and(|error| error == EXPORT_CANCELLED_ERROR) {
                return Err(EXPORT_CANCELLED_ERROR.to_string());
            }
            let columns = match columns_result {
                Ok(cols) => cols,
                Err(e) => {
                    record_export_error(
                        &mut file,
                        request.fail_on_error,
                        format!("exporting columns for table {table_name}: {e}"),
                        &mut lenient_errors,
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
                    let sql = database_export_select_sql(&col_names, &col_types, table_name, &request.schema, &db_type);
                    let cancel_token = CancellationToken::new();
                    await_export_stream_operation(
                        &request.export_id,
                        &cancel_token,
                        crate::query::stream_rows_in_manual_transaction_with_cancel(
                            state,
                            snapshot_session_id,
                            &sql,
                            batch_size,
                            Some(cancel_token.clone()),
                            |rows| {
                                // PostgreSQL and MySQL consume the token while waiting for rows. Retain this
                                // batch-boundary check so cancellation also wins while a batch is being written.
                                if snapshot_batch_cancelled(&db_type, &request.export_id) {
                                    return Err(EXPORT_CANCELLED_ERROR.to_string());
                                }
                                write_database_export_rows_with_mode(
                                    &mut file,
                                    &rows,
                                    &col_names,
                                    &col_types,
                                    &col_extras,
                                    table_name,
                                    &request.schema,
                                    &db_type,
                                    request.insert_dialect,
                                    request.insert_mode,
                                    request.preserve_original_language,
                                )?;
                                total_rows_exported += rows.len() as u64;
                                on_progress(ExportProgress {
                                    export_id: request.export_id.clone(),
                                    current_object: table_name.clone(),
                                    object_index,
                                    total_objects,
                                    rows_exported: total_rows_exported,
                                    total_rows: None,
                                    status: ExportStatus::Running,
                                    error: None,
                                    preparing: false,
                                    error_count: 0,
                                    error_summary: None,
                                });
                                Ok(())
                            },
                        ),
                    )
                    .await?;
                } else {
                    // Exact COUNT(*) is deliberately skipped for manual database exports. It adds a full
                    // table scan before the real read and does not improve correctness. Progress reports
                    // exported rows while total_rows remains indeterminate.
                    let total_rows = None;
                    let primary_keys = columns
                        .iter()
                        .filter(|column| column.is_primary_key)
                        .map(|column| column.name.clone())
                        .collect::<Vec<_>>();
                    let primary_key_indices = primary_keys
                        .iter()
                        .filter_map(|primary_key| col_names.iter().position(|column| column == primary_key))
                        .collect::<Vec<_>>();
                    let use_keyset = !primary_keys.is_empty() && primary_key_indices.len() == primary_keys.len();
                    let mut last_primary_key_values = Vec::new();
                    let mut offset = 0_u64;

                    loop {
                        if is_export_cancelled(&request.export_id).await {
                            emit_database_export_cancelled(
                                &on_progress,
                                &request.export_id,
                                table_name.clone(),
                                object_index,
                                total_objects,
                                total_rows_exported,
                            );
                            return Ok(());
                        }

                        let sql = if use_keyset {
                            let sql = keyset_pagination_sql_with_identifier_quote(
                                &col_names,
                                table_name,
                                &request.schema,
                                &db_type,
                                &primary_keys,
                                &last_primary_key_values,
                                batch_size,
                                None,
                            );
                            replace_database_export_select_list(sql, &col_names, &col_types, &db_type)
                        } else {
                            let sql = crate::transfer::pagination_sql(
                                &col_names,
                                table_name,
                                &request.schema,
                                &db_type,
                                offset,
                                batch_size,
                            );
                            replace_database_export_select_list(sql, &col_names, &col_types, &db_type)
                        };
                        let options = database_export_query_options(
                            state,
                            &request.connection_id,
                            &client_session_id,
                            Some(batch_size),
                        )
                        .await;
                        let result = match crate::query::execute_sql_statement_with_options(
                            state,
                            &request.connection_id,
                            &request.database,
                            &sql,
                            Some(&request.schema),
                            None,
                            options,
                        )
                        .await
                        {
                            Ok(result) => result,
                            Err(error) => {
                                record_export_error(
                                    &mut file,
                                    request.fail_on_error,
                                    format!("exporting data for table {table_name}: {error}"),
                                    &mut lenient_errors,
                                )?;
                                break;
                            }
                        };
                        let row_count = result.rows.len();
                        if row_count == 0 {
                            break;
                        }
                        write_database_export_rows_with_mode(
                            &mut file,
                            &result.rows,
                            &col_names,
                            &col_types,
                            &col_extras,
                            table_name,
                            &request.schema,
                            &db_type,
                            request.insert_dialect,
                            request.insert_mode,
                            request.preserve_original_language,
                        )?;
                        total_rows_exported += row_count as u64;
                        if use_keyset {
                            if let Some(last_row) = result.rows.last() {
                                last_primary_key_values =
                                    primary_key_indices.iter().map(|&index| last_row[index].clone()).collect();
                            }
                        } else {
                            offset += row_count as u64;
                        }
                        on_progress(ExportProgress {
                            export_id: request.export_id.clone(),
                            current_object: table_name.clone(),
                            object_index,
                            total_objects,
                            rows_exported: total_rows_exported,
                            total_rows,
                            status: ExportStatus::Running,
                            error: None,
                            preparing: false,
                            error_count: 0,
                            error_summary: None,
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
            if let Some(sql) = generate_postgres_sequence_post_table_ddl(sequence, &request.schema) {
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
                rows_exported: total_rows_exported,
                total_rows: None,
                status: ExportStatus::Running,
                error: None,
                preparing: false,
                error_count: 0,
                error_summary: None,
            });

            match crate::schema::get_object_source_core(
                state,
                &request.connection_id,
                &request.database,
                &request.schema,
                view_name,
                crate::db::ObjectSourceKind::View,
                None,
                None,
            )
            .await
            {
                Ok(obj_source) => {
                    let source = build_database_export_object_source_sql(
                        db_type,
                        &ObjectSourceKind::View,
                        view_name,
                        &obj_source.source,
                        request.drop_table_if_exists,
                    );
                    if !source.is_empty() {
                        writeln!(file, "{source}\n").map_err(|e| format!("Failed to write file: {e}"))?;
                    }
                }
                Err(e) => {
                    record_export_error(
                        &mut file,
                        request.fail_on_error,
                        format!("exporting view {view_name}: {e}"),
                        &mut lenient_errors,
                    )?;
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
                rows_exported: total_rows_exported,
                total_rows: None,
                status: ExportStatus::Running,
                error: None,
                preparing: false,
                error_count: 0,
                error_summary: None,
            });

            match crate::schema::get_object_source_core(
                state,
                &request.connection_id,
                &request.database,
                &request.schema,
                proc_name,
                crate::db::ObjectSourceKind::Procedure,
                procedure.signature.as_deref(),
                None,
            )
            .await
            {
                Ok(obj_source) => {
                    let source = build_database_export_object_source_sql(
                        db_type,
                        &ObjectSourceKind::Procedure,
                        proc_name,
                        &obj_source.source,
                        request.drop_table_if_exists,
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
                        &mut lenient_errors,
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
                rows_exported: total_rows_exported,
                total_rows: None,
                status: ExportStatus::Running,
                error: None,
                preparing: false,
                error_count: 0,
                error_summary: None,
            });

            match crate::schema::get_object_source_core(
                state,
                &request.connection_id,
                &request.database,
                &request.schema,
                func_name,
                crate::db::ObjectSourceKind::Function,
                function.signature.as_deref(),
                None,
            )
            .await
            {
                Ok(obj_source) => {
                    let source = build_database_export_object_source_sql(
                        db_type,
                        &ObjectSourceKind::Function,
                        func_name,
                        &obj_source.source,
                        request.drop_table_if_exists,
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
                        &mut lenient_errors,
                    )?;
                }
            }

            object_index += 1;
        }

        // Export triggers and events after routines: a trigger body may call a routine,
        // and an event body may call one too.
        for (trigger, object_type) in triggers
            .iter()
            .map(|t| (t, ObjectSourceKind::Trigger))
            .chain(events.iter().map(|e| (e, ObjectSourceKind::Event)))
        {
            if is_export_cancelled(&request.export_id).await {
                return Err("Export cancelled".to_string());
            }

            let object_name = &trigger.name;

            on_progress(ExportProgress {
                export_id: request.export_id.clone(),
                current_object: object_name.clone(),
                object_index,
                total_objects,
                rows_exported: total_rows_exported,
                total_rows: None,
                status: ExportStatus::Running,
                error: None,
                preparing: false,
                error_count: 0,
                error_summary: None,
            });

            let kind_label = if object_type == ObjectSourceKind::Trigger { "trigger" } else { "event" };
            match crate::schema::get_object_source_core(
                state,
                &request.connection_id,
                &request.database,
                &request.schema,
                object_name,
                object_type.clone(),
                None,
                None,
            )
            .await
            {
                Ok(obj_source) => {
                    let source = build_database_export_object_source_sql(
                        db_type,
                        &object_type,
                        object_name,
                        &obj_source.source,
                        request.drop_table_if_exists,
                    );
                    if !source.is_empty() {
                        writeln!(file, "{source}\n").map_err(|e| format!("Failed to write file: {e}"))?;
                    }
                }
                Err(e) => {
                    record_export_error(
                        &mut file,
                        request.fail_on_error,
                        format!("exporting {kind_label} {object_name}: {e}"),
                        &mut lenient_errors,
                    )?;
                }
            }

            object_index += 1;
        }
    }

    // PostgreSQL trigger definitions reference their trigger functions. The
    // table DDL builder returns both statements together, while schema-wide
    // routines are exported below the tables. Keep triggers part of table
    // structure, but write them only after routines so the resulting script
    // is executable in file order.
    for trigger in deferred_postgres_triggers {
        writeln!(file, "{trigger}\n").map_err(|e| format!("Failed to write file: {e}"))?;
    }

    // PostgreSQL foreign keys come after every table and row exists, so the
    // script replays into an empty database no matter what order (or cycle)
    // the schema's foreign key graph has (issue #10575).
    for statement in deferred_postgres_foreign_keys {
        writeln!(file, "{statement}\n").map_err(|e| format!("Failed to write file: {e}"))?;
    }

    // For MySQL: re-enable foreign key checks
    if matches!(db_type, DatabaseType::Mysql) {
        writeln!(file, "SET FOREIGN_KEY_CHECKS = 1;").map_err(|e| format!("Failed to write file: {e}"))?;
    }

    file.finish(&export_source_file_name(&request.file_path))?;

    // Emit Done progress
    on_progress(ExportProgress {
        export_id: request.export_id.clone(),
        current_object: String::new(),
        object_index,
        total_objects,
        rows_exported: total_rows_exported,
        total_rows: None,
        status: ExportStatus::Done,
        error: None,
        preparing: false,
        error_count: lenient_errors.count as u64,
        error_summary: lenient_errors.first.clone(),
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
    let cascade = if db_type == &DatabaseType::Postgres { " CASCADE" } else { "" };
    format!("DROP TABLE IF EXISTS {}{};", crate::transfer::qualified_table(table_name, schema, db_type, None), cascade)
}

fn build_database_export_object_source_sql(
    database_type: DatabaseType,
    object_type: &ObjectSourceKind,
    object_name: &str,
    source: &str,
    drop_if_exists: bool,
) -> String {
    let source = build_export_object_source_sql(database_type, object_type.clone(), source);
    if source.is_empty() || !drop_if_exists || database_type != DatabaseType::Mysql {
        return source;
    }

    let object_type = match object_type {
        ObjectSourceKind::View => "VIEW",
        ObjectSourceKind::Procedure => "PROCEDURE",
        ObjectSourceKind::Function => "FUNCTION",
        ObjectSourceKind::Trigger => "TRIGGER",
        ObjectSourceKind::Event => "EVENT",
        _ => return source,
    };
    let object_name = quote_identifier(object_name, &DatabaseType::Mysql);
    format!("DROP {object_type} IF EXISTS {object_name};\n{source}")
}

#[cfg(test)]
mod tests {
    use super::{
        await_export_operation, await_export_stream_operation, clear_export_cancelled, combine_schema_sql_export,
        concurrent_metadata_prefetch_allowed, database_export_metadata_prefetch_concurrency,
        emit_database_export_cancelled, metadata_prefetch_concurrency, metadata_prefetch_pool_capacity,
        postgres_create_schema_sql, postgres_export_schema_names, set_export_cancelled, snapshot_batch_cancelled,
        ExportStatus, EXPORT_CANCELLED_ERROR,
    };
    use super::{
        build_database_export_object_source_sql, build_database_sql_export, build_export_insert_statements,
        build_export_insert_statements_excluding, build_export_object_source_sql, build_export_sql_insert,
        create_database_export_writer, database_export_query_options_for_timeout, database_export_select_sql,
        database_export_total_objects, decode_unicode_escapes_for_export, drop_table_if_exists_sql,
        ensure_export_destination_dir, export_destination_identity_mismatch, extract_postgres_deferred_foreign_keys,
        filter_export_table_infos, format_export_sql_literal, format_export_table_ddl,
        format_mysql_spatial_export_literal, format_xugu_spatial_export_literal, generate_postgres_enum_ddl,
        generate_postgres_extension_ddl, generate_postgres_sequence_create_ddl,
        generate_postgres_sequence_post_table_ddl, generate_postgres_sequence_setval_sql,
        is_postgres_extension_member_routine, mysql_database_export_preamble, mysql_view_dependencies_from_rows,
        mysql_view_dependencies_sql, normalize_export_table_ddl, record_export_destination_identity,
        record_export_error, replace_database_export_select_list, sort_export_views_by_dependencies,
        split_postgres_export_table_triggers, write_database_export_rows, write_database_export_rows_with_mode,
        BuildDatabaseSqlExportOptions, BuildExportInsertStatementsOptions, BuildExportSqlInsertOptions,
        DatabaseExportObjectCounts, DatabaseExportRequest, DatabaseExportWriter, DdlNormalizeOptions, ExportedTableSql,
        PostgresExportEnum, PostgresExportExtension, PostgresExportSequence, PostgresExtensionMembers,
        SqlInsertDialect, SqlInsertMode, DATABASE_EXPORT_INSERT_BATCH_SIZE, DATABASE_EXPORT_ROW_LIMIT,
        POSTGRES_EXPORT_SEQUENCES_COMPAT_SQL, POSTGRES_EXPORT_SEQUENCES_SQL,
    };
    use super::{ExportProgress, LenientExportErrors};
    use crate::connection::AppState;
    use crate::models::connection::DatabaseType;
    use crate::types::SpatialColumn;
    use crate::types::{ObjectInfo, ObjectSourceKind, TableInfo};
    use serde_json::{json, Value};
    use std::io::{Read, Write};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    };
    use tokio_util::sync::CancellationToken;

    #[test]
    fn database_export_query_options_preserve_connection_timeout() {
        let options = database_export_query_options_for_timeout(7, "database-export-session", Some(500));

        assert_eq!(options.timeout_secs, Some(7));
        assert_eq!(options.max_rows, Some(500));
        assert_eq!(options.client_session_id.as_deref(), Some("database-export-session"));

        let unlimited = database_export_query_options_for_timeout(0, "database-export-session", None);
        assert_eq!(unlimited.timeout_secs, Some(0));
        assert_eq!(unlimited.max_rows, None);
    }

    #[tokio::test]
    async fn await_export_operation_drops_pending_metadata_after_cancel() {
        let export_id = format!("cancel-pending-{}", uuid::Uuid::new_v4());
        clear_export_cancelled(&export_id).await;
        let task_export_id = export_id.clone();
        let task = tokio::spawn(async move {
            await_export_operation(
                &task_export_id,
                Box::pin(async {
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                    Ok::<_, String>(())
                }),
            )
            .await
        });

        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        set_export_cancelled(&export_id).await;
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), task)
            .await
            .expect("cancellation should stop a pending metadata future")
            .expect("cancellation task should not panic");
        assert_eq!(result, Err(EXPORT_CANCELLED_ERROR.to_string()));
        clear_export_cancelled(&export_id).await;
    }

    #[tokio::test]
    async fn await_export_operation_preserves_completed_metadata() {
        let export_id = format!("complete-metadata-{}", uuid::Uuid::new_v4());
        clear_export_cancelled(&export_id).await;
        let result = await_export_operation(&export_id, Box::pin(async { Ok::<_, String>(42_u32) })).await;
        assert_eq!(result, Ok(42));
    }

    #[tokio::test]
    async fn await_export_stream_signals_cancel_and_waits_for_cleanup() {
        let export_id = format!("cancel-stream-{}", uuid::Uuid::new_v4());
        clear_export_cancelled(&export_id).await;
        let cancel_token = CancellationToken::new();
        let stream_cancel_token = cancel_token.clone();
        let cleaned = Arc::new(AtomicBool::new(false));
        let cleaned_after_cancel = cleaned.clone();
        let task_export_id = export_id.clone();
        let task = tokio::spawn(async move {
            await_export_stream_operation(&task_export_id, &cancel_token, async move {
                stream_cancel_token.cancelled().await;
                cleaned_after_cancel.store(true, Ordering::SeqCst);
                Err::<(), _>(crate::query::QUERY_CANCELED.to_string())
            })
            .await
        });

        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        set_export_cancelled(&export_id).await;
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), task)
            .await
            .expect("export stream cancellation should finish cleanup")
            .expect("cancellation task should not panic");

        assert_eq!(result, Err(EXPORT_CANCELLED_ERROR.to_string()));
        assert!(cleaned.load(Ordering::SeqCst));
        clear_export_cancelled(&export_id).await;
    }

    #[tokio::test]
    async fn await_export_stream_prioritizes_existing_cancel_over_completion() {
        let export_id = format!("cancel-ready-stream-{}", uuid::Uuid::new_v4());
        clear_export_cancelled(&export_id).await;
        set_export_cancelled(&export_id).await;
        let cancel_token = CancellationToken::new();

        let result = await_export_stream_operation(&export_id, &cancel_token, async { Ok::<_, String>(42) }).await;

        assert_eq!(result, Err(EXPORT_CANCELLED_ERROR.to_string()));
        assert!(cancel_token.is_cancelled());
        clear_export_cancelled(&export_id).await;
    }

    #[tokio::test]
    async fn await_export_stream_preserves_normal_completion() {
        let export_id = format!("complete-stream-{}", uuid::Uuid::new_v4());
        clear_export_cancelled(&export_id).await;
        let cancel_token = CancellationToken::new();

        let result = await_export_stream_operation(&export_id, &cancel_token, async { Ok::<_, String>(42) }).await;

        assert_eq!(result, Ok(42));
        assert!(!cancel_token.is_cancelled());
    }

    #[tokio::test]
    async fn non_postgres_snapshot_batches_keep_existing_cancel_check() {
        let export_id = format!("cancel-non-postgres-batch-{}", uuid::Uuid::new_v4());
        clear_export_cancelled(&export_id).await;
        set_export_cancelled(&export_id).await;

        assert!(snapshot_batch_cancelled(&DatabaseType::Mysql, &export_id));
        assert!(!snapshot_batch_cancelled(&DatabaseType::Postgres, &export_id));

        clear_export_cancelled(&export_id).await;
    }

    #[test]
    fn cancelled_progress_is_terminal_and_has_no_error() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        emit_database_export_cancelled(&|progress| sink.lock().unwrap().push(progress), "export-1", "seq", 3, 9, 17);

        let progress = events.lock().unwrap().pop().expect("cancelled progress");
        assert_eq!(progress.export_id, "export-1");
        assert_eq!(progress.current_object, "seq");
        assert_eq!(progress.object_index, 3);
        assert_eq!(progress.total_objects, 9);
        assert_eq!(progress.rows_exported, 17);
        assert!(matches!(progress.status, ExportStatus::Cancelled));
        assert!(progress.error.is_none());
        assert!(!progress.preparing);
    }

    fn table(name: &str, table_type: &str) -> TableInfo {
        TableInfo {
            name: name.to_string(),
            table_type: table_type.to_string(),
            valid: None,
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
            custom_type_kind: None,
            has_members: None,
            comment: None,
            created_at: None,
            updated_at: None,
            parent_schema: None,
            parent_name: None,
            trigger: None,
            xugu_type_members_expandable: None,
        }
    }

    fn export_request(
        include_structure: bool,
        include_data: bool,
        include_objects: bool,
        selected_tables: Vec<String>,
    ) -> DatabaseExportRequest {
        DatabaseExportRequest {
            export_id: "export-1".to_string(),
            connection_id: "connection-1".to_string(),
            database: "database-1".to_string(),
            schema: "public".to_string(),
            file_path: "export.sql".to_string(),
            selected_tables,
            excluded_tables: Vec::new(),
            include_structure,
            include_data,
            include_objects,
            include_create_database: false,
            drop_table_if_exists: false,
            omit_auto_increment: false,
            fail_on_error: false,
            prevent_overwrite: false,
            output_compression: Default::default(),
            insert_dialect: Default::default(),
            insert_mode: Default::default(),
            snapshot_session_id: None,
            batch_size: 1000,
            split_max_mb: None,
            preserve_original_language: false,
        }
    }

    #[test]
    fn database_export_request_defaults_to_source_insert_dialect_and_accepts_standard() {
        let mut payload = json!({
            "exportId": "export-1",
            "connectionId": "connection-1",
            "database": "app",
            "schema": "dbo",
            "filePath": "app.sql",
            "includeStructure": false,
            "includeData": true,
            "includeObjects": false,
            "batchSize": 1000
        });

        let legacy: DatabaseExportRequest =
            serde_json::from_value(payload.clone()).expect("deserialize legacy database export request");
        assert_eq!(legacy.insert_dialect, SqlInsertDialect::Source);

        payload["insertDialect"] = json!("standard");
        let standard: DatabaseExportRequest =
            serde_json::from_value(payload).expect("deserialize Standard SQL database export request");
        assert_eq!(standard.insert_dialect, SqlInsertDialect::Standard);
        assert_eq!(serde_json::to_value(standard).unwrap()["insertDialect"], json!("standard"));
    }

    #[test]
    fn gzip_export_writer_finishes_a_readable_stream() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup.sql.gz");
        let file = std::fs::File::create(&path).unwrap();
        let mut writer = DatabaseExportWriter::Gzip(Box::new(flate2::write::GzEncoder::new(
            std::io::BufWriter::new(file),
            flate2::Compression::default(),
        )));
        writer.write_all(b"SELECT 1;\n").unwrap();
        writer.finish("backup.sql").unwrap();

        let mut output = String::new();
        flate2::read::GzDecoder::new(std::fs::File::open(path).unwrap()).read_to_string(&mut output).unwrap();
        assert_eq!(output, "SELECT 1;\n");
    }

    #[tokio::test]
    async fn scheduled_backup_destination_tracking_grants_ownership_only_after_create_new() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tracked.sql");
        let state = Arc::new(test_app_state(directory.path()).await);
        let mut request = export_request(true, true, true, Vec::new());
        request.file_path = path.to_string_lossy().into_owned();
        request.prevent_overwrite = true;
        let created = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let writer = super::track_backup_destination(
            path.clone(),
            created.clone(),
            create_database_export_writer(&state, &request),
        )
        .await
        .unwrap();
        assert!(created.load(std::sync::atomic::Ordering::Relaxed));
        drop(writer);
        std::fs::write(&path, b"keep existing").unwrap();
        let collision = Arc::new(std::sync::atomic::AtomicBool::new(false));
        assert!(super::track_backup_destination(
            path.clone(),
            collision.clone(),
            create_database_export_writer(&state, &request)
        )
        .await
        .is_err());
        assert!(!collision.load(std::sync::atomic::Ordering::Relaxed));
        assert_eq!(std::fs::read(path).unwrap(), b"keep existing");
    }

    #[tokio::test]
    async fn backup_writer_does_not_overwrite_an_existing_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("existing.sql");
        std::fs::write(&path, b"keep me").unwrap();
        let state = Arc::new(test_app_state(directory.path()).await);
        let mut request = export_request(true, true, true, Vec::new());
        request.file_path = path.to_string_lossy().to_string();
        request.prevent_overwrite = true;

        let error = match create_database_export_writer(&state, &request).await {
            Ok(_) => panic!("existing backup should not be overwritten"),
            Err(error) => error,
        };

        assert!(error.contains("already exists"));
        assert_eq!(std::fs::read(&path).unwrap(), b"keep me");
    }

    #[test]
    fn export_progress_total_counts_only_requested_object_categories() {
        let counts = DatabaseExportObjectCounts {
            tables: 2,
            views: 1,
            sequences: 2,
            extensions: 1,
            enums: 1,
            procedures: 1,
            functions: 1,
            triggers: 2,
            events: 1,
        };

        let cases = [
            ("structure", export_request(true, false, false, Vec::new()), 6),
            ("data", export_request(false, true, false, Vec::new()), 2),
            ("objects", export_request(false, false, true, Vec::new()), 6),
            ("all", export_request(true, true, true, Vec::new()), 12),
            ("nothing", export_request(false, false, false, Vec::new()), 0),
        ];

        for (name, request, expected) in cases {
            assert_eq!(database_export_total_objects(&request, &counts), expected, "{name}");
        }
    }

    #[test]
    fn mysql_database_export_preamble_preserves_database_settings() {
        assert_eq!(
            mysql_database_export_preamble("app`db", Some("utf8mb4"), Some("utf8mb4_unicode_ci")),
            "CREATE DATABASE IF NOT EXISTS `app``db` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\nUSE `app``db`;\n"
        );
        assert_eq!(
            mysql_database_export_preamble("app", None, None),
            "CREATE DATABASE IF NOT EXISTS `app`;\nUSE `app`;\n"
        );
    }

    #[test]
    fn export_progress_total_excludes_schema_routines_for_selected_tables() {
        // Counts are already filtered to the selected table/view set before
        // workload calculation; schema-wide routines remain intentionally out.
        let counts = DatabaseExportObjectCounts {
            tables: 1,
            views: 1,
            sequences: 1,
            extensions: 1,
            enums: 1,
            procedures: 4,
            functions: 5,
            triggers: 2,
            events: 3,
        };
        let request = export_request(true, true, true, vec!["users".to_string(), "active_users".to_string()]);

        assert_eq!(database_export_total_objects(&request, &counts), 5);
    }

    #[test]
    fn mysql_database_export_drops_triggers_and_events_before_create() {
        let trigger = "CREATE DEFINER=`root`@`%` TRIGGER `trg_orders_ai` AFTER INSERT ON `orders` FOR EACH ROW INSERT INTO audit_log(msg) VALUES ('x')";
        let event =
            "CREATE DEFINER=`root`@`%` EVENT `ev_purge` ON SCHEDULE EVERY 1 DAY DO DELETE FROM audit_log WHERE id < 0";

        assert_eq!(
            build_database_export_object_source_sql(
                DatabaseType::Mysql,
                &ObjectSourceKind::Trigger,
                "trg_orders_ai",
                trigger,
                true
            ),
            format!(
                "DROP TRIGGER IF EXISTS `trg_orders_ai`;\n{}",
                build_export_object_source_sql(DatabaseType::Mysql, ObjectSourceKind::Trigger, trigger)
            )
        );
        assert_eq!(
            build_database_export_object_source_sql(
                DatabaseType::Mysql,
                &ObjectSourceKind::Event,
                "ev_purge",
                event,
                true
            ),
            format!(
                "DROP EVENT IF EXISTS `ev_purge`;\n{}",
                build_export_object_source_sql(DatabaseType::Mysql, ObjectSourceKind::Event, event)
            )
        );
        // Without `dropTableIfExists` the source is written as-is.
        assert_eq!(
            build_database_export_object_source_sql(
                DatabaseType::Mysql,
                &ObjectSourceKind::Trigger,
                "trg_orders_ai",
                trigger,
                false
            ),
            build_export_object_source_sql(DatabaseType::Mysql, ObjectSourceKind::Trigger, trigger)
        );
    }

    #[test]
    fn postgres_extension_ddl_uses_target_default_version_and_source_schema() {
        let extension = PostgresExportExtension { name: "pg_trgm".to_string(), schema: "addons".to_string() };

        let ddl = generate_postgres_extension_ddl(&extension);

        assert_eq!(ddl, "CREATE EXTENSION IF NOT EXISTS \"pg_trgm\" WITH SCHEMA \"addons\";");
        assert!(!ddl.contains("VERSION"));
    }

    #[test]
    fn postgres_enum_ddl_preserves_schema_order_and_escapes_labels() {
        let enum_type = PostgresExportEnum {
            name: "status\"type".to_string(),
            schema: "app".to_string(),
            labels: vec!["pending".to_string(), "it's\\ready".to_string(), "已完成".to_string()],
        };

        assert_eq!(
            generate_postgres_enum_ddl(&enum_type),
            "CREATE TYPE \"app\".\"status\"\"type\" AS ENUM ('pending', E'it''s\\\\ready', '已完成');"
        );
    }

    #[test]
    fn postgres_all_schema_export_filters_system_schemas_and_deduplicates() {
        assert_eq!(
            postgres_export_schema_names(vec![
                " public ".to_string(),
                "pg_catalog".to_string(),
                "information_schema".to_string(),
                "private".to_string(),
                "private".to_string(),
                "".to_string(),
            ]),
            vec!["public".to_string(), "private".to_string()]
        );
    }

    #[test]
    fn postgres_all_schema_export_creates_quoted_schema_if_missing() {
        assert_eq!(postgres_create_schema_sql("tenant\"data"), "CREATE SCHEMA IF NOT EXISTS \"tenant\"\"data\";");
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
    fn postgres_database_export_defers_table_triggers_without_splitting_function_bodies() {
        let ddl = "CREATE TABLE \"public\".\"work_log\" (\n  \"id\" bigint,\n  \"note\" text DEFAULT ';'::text\n);\n\nCREATE INDEX \"idx_work_log\" ON \"public\".\"work_log\" (\"id\");\n\nCREATE TRIGGER trg_work_log BEFORE INSERT OR UPDATE ON public.work_log FOR EACH ROW EXECUTE FUNCTION fn_work_log_update();";

        let (table_ddl, triggers) = split_postgres_export_table_triggers(ddl, DatabaseType::Postgres);

        assert!(table_ddl.contains("CREATE TABLE"));
        assert!(table_ddl.contains("DEFAULT ';'::text"));
        assert!(table_ddl.contains("CREATE INDEX"));
        assert!(!table_ddl.contains("CREATE TRIGGER"));
        assert_eq!(triggers.len(), 1);
        assert!(triggers[0].starts_with("CREATE TRIGGER trg_work_log"));
    }

    #[test]
    fn postgres_database_export_defers_constraint_triggers_only_for_postgres() {
        let ddl = "CREATE TABLE \"public\".\"items\" (\"id\" bigint);\nCREATE CONSTRAINT TRIGGER items_check AFTER INSERT ON public.items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_items();";

        let (postgres_table, postgres_triggers) = split_postgres_export_table_triggers(ddl, DatabaseType::Postgres);
        assert!(!postgres_table.contains("CREATE CONSTRAINT TRIGGER"));
        assert_eq!(postgres_triggers.len(), 1);

        let (mysql_ddl, mysql_triggers) = split_postgres_export_table_triggers(ddl, DatabaseType::Mysql);
        assert_eq!(mysql_ddl, ddl);
        assert!(mysql_triggers.is_empty());
    }

    #[test]
    fn postgres_export_defers_inline_foreign_keys_to_file_tail_statements() {
        let ddl = "CREATE TABLE \"public\".\"child_versions\" (\n  \"id\" uuid NOT NULL,\n  \"parent_id\" uuid NOT NULL,\n  CONSTRAINT \"child_versions_pkey\" PRIMARY KEY (id),\n  CONSTRAINT \"fk_child_parent\" FOREIGN KEY (\"parent_id\") REFERENCES \"public\".\"parent_entities\"(\"id\")\n);";

        let (stripped, deferred) = extract_postgres_deferred_foreign_keys(ddl, "public", "child_versions");

        assert!(!stripped.contains("FOREIGN KEY"), "stripped: {stripped}");
        // Removing the trailing foreign key must also drop the comma it left behind.
        assert!(stripped.contains("CONSTRAINT \"child_versions_pkey\" PRIMARY KEY (id)\n)"), "stripped: {stripped}");
        assert_eq!(
            deferred,
            vec![
                "ALTER TABLE \"public\".\"child_versions\" ADD CONSTRAINT \"fk_child_parent\" FOREIGN KEY (\"parent_id\") REFERENCES \"public\".\"parent_entities\"(\"id\");".to_string()
            ]
        );
    }

    #[test]
    fn postgres_export_defers_foreign_keys_and_keeps_other_constraints() {
        let ddl = "CREATE TABLE \"public\".\"assignments\" (\n  \"id\" integer NOT NULL,\n  \"owner_id\" integer NOT NULL,\n  \"reviewer_id\" integer NOT NULL,\n  CONSTRAINT \"assignments_owner_fk\" FOREIGN KEY (\"owner_id\") REFERENCES \"users\"(\"id\"),\n  CONSTRAINT \"assignments_owner_check\" CHECK (owner_id > 0),\n  CONSTRAINT \"assignments_reviewer_fk\" FOREIGN KEY (\"reviewer_id\") REFERENCES \"users\"(\"id\"),\n  CONSTRAINT \"assignments_pair_unique\" UNIQUE (\"owner_id\", \"reviewer_id\")\n);";

        let (stripped, deferred) = extract_postgres_deferred_foreign_keys(ddl, "public", "assignments");

        assert!(!stripped.contains("FOREIGN KEY"), "stripped: {stripped}");
        assert!(
            stripped.contains("CONSTRAINT \"assignments_owner_check\" CHECK (owner_id > 0),"),
            "stripped: {stripped}"
        );
        assert!(
            stripped.contains("CONSTRAINT \"assignments_pair_unique\" UNIQUE (\"owner_id\", \"reviewer_id\")"),
            "stripped: {stripped}"
        );
        assert_eq!(deferred.len(), 2);
        assert!(deferred[0]
            .starts_with("ALTER TABLE \"public\".\"assignments\" ADD CONSTRAINT \"assignments_owner_fk\" FOREIGN KEY"));
        assert!(deferred[1].starts_with(
            "ALTER TABLE \"public\".\"assignments\" ADD CONSTRAINT \"assignments_reviewer_fk\" FOREIGN KEY"
        ));
    }

    #[test]
    fn postgres_export_defers_foreign_keys_across_multiple_statements() {
        let no_foreign_keys = "CREATE TABLE \"public\".\"parent_entities\" (\n  \"id\" integer NOT NULL,\n  CONSTRAINT \"parent_entities_pkey\" PRIMARY KEY (id)\n);\nALTER TABLE ONLY \"public\".\"events_2027_h1\" ALTER COLUMN \"status\" DROP DEFAULT;";
        let (stripped, deferred) = extract_postgres_deferred_foreign_keys(no_foreign_keys, "public", "parent_entities");
        assert_eq!(stripped, no_foreign_keys);
        assert!(deferred.is_empty());

        let with_cycle = "CREATE TABLE \"public\".\"cyc_x\" (\n  \"id\" integer NOT NULL,\n  CONSTRAINT \"cyc_x_pkey\" PRIMARY KEY (id),\n  CONSTRAINT \"cyc_x_y_fk\" FOREIGN KEY (\"id\") REFERENCES \"public\".\"cyc_y\"(\"id\")\n);\nALTER TABLE ONLY \"public\".\"cyc_x\" ALTER COLUMN \"id\" DROP DEFAULT;";
        let (stripped, deferred) = extract_postgres_deferred_foreign_keys(with_cycle, "public", "cyc_x");
        assert!(!stripped.contains("cyc_x_y_fk"), "stripped: {stripped}");
        assert!(
            stripped.contains("ALTER TABLE ONLY \"public\".\"cyc_x\" ALTER COLUMN \"id\" DROP DEFAULT;"),
            "stripped: {stripped}"
        );
        assert_eq!(
            deferred,
            vec![
                "ALTER TABLE \"public\".\"cyc_x\" ADD CONSTRAINT \"cyc_x_y_fk\" FOREIGN KEY (\"id\") REFERENCES \"public\".\"cyc_y\"(\"id\");".to_string()
            ]
        );
    }

    #[test]
    fn postgres_export_deferred_foreign_keys_use_the_statement_schema() {
        // Whole-database exports leave the request schema empty; the ALTER must
        // still target the schema the CREATE TABLE statement itself carries.
        let ddl = "CREATE TABLE \"inventory\".\"orders\" (\n  \"id\" integer NOT NULL,\n  \"product_id\" integer NOT NULL,\n  CONSTRAINT \"orders_product_fk\" FOREIGN KEY (\"product_id\") REFERENCES \"inventory\".\"products\"(\"id\")\n);";

        let (stripped, deferred) = extract_postgres_deferred_foreign_keys(ddl, "", "orders");

        assert!(!stripped.contains("FOREIGN KEY"), "stripped: {stripped}");
        assert_eq!(
            deferred,
            vec![
                "ALTER TABLE \"inventory\".\"orders\" ADD CONSTRAINT \"orders_product_fk\" FOREIGN KEY (\"product_id\") REFERENCES \"inventory\".\"products\"(\"id\");".to_string()
            ]
        );
    }

    #[test]
    fn concurrent_prefetch_only_allowed_for_multi_connection_pools() {
        use crate::connection::PoolKind;

        // ChClient::new 只构造 HTTP 客户端，不发起连接
        let clickhouse = PoolKind::ClickHouse(crate::db::clickhouse_driver::ChClient::new(
            "http://127.0.0.1:1",
            None,
            None,
            std::time::Duration::from_secs(1),
        ));
        assert!(concurrent_metadata_prefetch_allowed(Some(&clickhouse)));

        // Agent（JDBC sidecar）请求超时覆盖排队时间，必须回退串行
        let agent = PoolKind::agent(crate::db::agent_driver::AgentDriverClient::test_stub());
        assert!(!concurrent_metadata_prefetch_allowed(Some(&agent)));

        assert!(!concurrent_metadata_prefetch_allowed(None));
    }

    #[test]
    fn postgres_metadata_prefetch_reserves_pool_capacity() {
        assert_eq!(database_export_metadata_prefetch_concurrency(DatabaseType::Postgres), 4);
        assert_eq!(database_export_metadata_prefetch_concurrency(DatabaseType::Mysql), 8);
    }

    #[tokio::test]
    async fn metadata_prefetch_capacity_follows_the_pool_the_prefetch_uses() {
        use crate::connection::PoolKind;

        let postgres_pool = |max_size: usize| {
            let manager = deadpool_postgres::Manager::new(tokio_postgres::Config::new(), tokio_postgres::NoTls);
            PoolKind::Postgres(
                deadpool_postgres::Pool::builder(manager)
                    .runtime(deadpool_postgres::Runtime::Tokio1)
                    .max_size(max_size)
                    .build()
                    .expect("build PostgreSQL test pool"),
            )
        };
        // 导出会话池（issue #10018）：PostgreSQL 会话池只有一条物理连接，
        // 并发预取只会把 checkout 排到同一个连接后面。
        assert_eq!(metadata_prefetch_pool_capacity(Some(&postgres_pool(1))), 1);
        // 基础池（无会话）保留多连接并发。
        assert_eq!(metadata_prefetch_pool_capacity(Some(&postgres_pool(10))), 10);

        // 会话级 MySQL 池同样单连接；非会话池按连接数放行。
        let session_mysql = PoolKind::Mysql(
            crate::db::mysql::MySqlPool::new("mysql://root@127.0.0.1:1/app", 1),
            crate::connection::MysqlMode::Bare,
        );
        assert_eq!(metadata_prefetch_pool_capacity(Some(&session_mysql)), 1);
        let shared_mysql = PoolKind::Mysql(
            crate::db::mysql::MySqlPool::new("mysql://root@127.0.0.1:1/app", 10),
            crate::connection::MysqlMode::Bare,
        );
        assert_eq!(metadata_prefetch_pool_capacity(Some(&shared_mysql)), 10);

        let clickhouse = PoolKind::ClickHouse(crate::db::clickhouse_driver::ChClient::new(
            "http://127.0.0.1:1",
            None,
            None,
            std::time::Duration::from_secs(1),
        ));
        assert_eq!(metadata_prefetch_pool_capacity(Some(&clickhouse)), usize::MAX);

        let agent = PoolKind::agent(crate::db::agent_driver::AgentDriverClient::test_stub());
        assert_eq!(metadata_prefetch_pool_capacity(Some(&agent)), 1);
        assert_eq!(metadata_prefetch_pool_capacity(None), 1);
    }

    #[test]
    fn metadata_prefetch_concurrency_never_exceeds_one_for_single_connection_pools() {
        // 会话级 PostgreSQL/MySQL 池只有一条连接：并发预取在这里没有任何收益，
        // 只会把 checkout 排到同一个连接后面并最终超时（issue #10018）。
        assert_eq!(metadata_prefetch_concurrency(DatabaseType::Postgres, 1), 1);
        assert_eq!(metadata_prefetch_concurrency(DatabaseType::Mysql, 1), 1);
        // 多连接池保留原有上限。
        assert_eq!(metadata_prefetch_concurrency(DatabaseType::Postgres, 10), 4);
        assert_eq!(metadata_prefetch_concurrency(DatabaseType::Mysql, 10), 8);
        // 池容量小于类型上限时按池容量收敛。
        assert_eq!(metadata_prefetch_concurrency(DatabaseType::Mysql, 3), 3);
        assert_eq!(metadata_prefetch_concurrency(DatabaseType::Postgres, usize::MAX), 4);
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
    fn mysql_export_orders_referenced_views_before_dependents() {
        let tables = [table("a_view", "VIEW"), table("z_view", "VIEW")];
        let views = tables.iter().collect::<Vec<_>>();
        let dependencies =
            vec![("a_view".to_string(), "z_view".to_string()), ("z_view".to_string(), "base_table".to_string())];

        let sorted = sort_export_views_by_dependencies(&views, &dependencies);

        assert_eq!(sorted.iter().map(|view| view.name.as_str()).collect::<Vec<_>>(), vec!["z_view", "a_view"]);
    }

    #[test]
    fn mysql_view_dependency_metadata_is_escaped_and_parsed() {
        let sql = mysql_view_dependencies_sql("prod'o");
        assert!(sql.contains("VIEW_SCHEMA = 'prod''o'"));
        assert!(sql.contains("TABLE_SCHEMA = 'prod''o'"));

        let rows = vec![
            vec![json!(" a_view "), json!(" z_view ")],
            vec![Value::Null, json!("ignored")],
            vec![json!(""), json!("ignored")],
        ];
        assert_eq!(mysql_view_dependencies_from_rows(&rows), vec![("a_view".to_string(), "z_view".to_string())]);
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

        assert_eq!(sql, "DROP TABLE IF EXISTS \"users\" CASCADE;");
    }

    #[test]
    fn mysql_export_adds_drop_if_exists_for_views_and_escapes_names() {
        let sql = build_database_export_object_source_sql(
            DatabaseType::Mysql,
            &ObjectSourceKind::View,
            "active`rows",
            "CREATE VIEW `active``rows` AS SELECT 1",
            true,
        );

        assert_eq!(sql, "DROP VIEW IF EXISTS `active``rows`;\nCREATE VIEW `active``rows` AS SELECT 1;");
    }

    #[test]
    fn mysql_export_adds_drop_if_exists_before_delimited_routines() {
        let procedure = build_database_export_object_source_sql(
            DatabaseType::Mysql,
            &ObjectSourceKind::Procedure,
            "refresh_cache",
            "CREATE PROCEDURE `refresh_cache`() BEGIN SELECT 1; END",
            true,
        );
        let function = build_database_export_object_source_sql(
            DatabaseType::Mysql,
            &ObjectSourceKind::Function,
            "active_count",
            "CREATE FUNCTION `active_count`() RETURNS INT RETURN 1",
            true,
        );

        assert_eq!(
            procedure,
            "DROP PROCEDURE IF EXISTS `refresh_cache`;\nDELIMITER //\nCREATE PROCEDURE `refresh_cache`() BEGIN SELECT 1; END//\nDELIMITER ;"
        );
        assert_eq!(
            function,
            "DROP FUNCTION IF EXISTS `active_count`;\nDELIMITER //\nCREATE FUNCTION `active_count`() RETURNS INT RETURN 1//\nDELIMITER ;"
        );
    }

    #[test]
    fn object_drop_option_does_not_change_disabled_or_non_mysql_exports() {
        let mysql_without_drop = build_database_export_object_source_sql(
            DatabaseType::Mysql,
            &ObjectSourceKind::View,
            "active_rows",
            "CREATE VIEW `active_rows` AS SELECT 1",
            false,
        );
        let postgres_with_drop = build_database_export_object_source_sql(
            DatabaseType::Postgres,
            &ObjectSourceKind::View,
            "active_rows",
            "CREATE VIEW active_rows AS SELECT 1",
            true,
        );

        assert_eq!(mysql_without_drop, "CREATE VIEW `active_rows` AS SELECT 1;");
        assert_eq!(postgres_with_drop, "CREATE VIEW active_rows AS SELECT 1;");
    }

    #[test]
    fn formats_sql_literals_for_export_inserts() {
        assert_eq!(format_export_sql_literal(&Value::Null), "NULL");
        assert_eq!(format_export_sql_literal(&json!(42)), "42");
        assert_eq!(format_export_sql_literal(&json!(true)), "TRUE");
        assert_eq!(format_export_sql_literal(&json!("O'Hara")), "'O''Hara'");
    }

    #[test]
    fn mysql_spatial_export_uses_wkb_constructor_and_preserves_srid() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Mysql),
            identifier_quote: None,
            schema: None,
            table_name: Some("places".to_string()),
            qualified_table_name: None,
            columns: vec!["location".to_string(), "shape".to_string()],
            column_types: vec![Some("point".to_string()), Some("geometry".to_string())],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![
                json!("DBX_WKB:4326:0101000000AE47E17A14AE5C4052B81E85EBF34240"),
                json!("DBX_WKB:0:0101000000000000000000F03F0000000000000040"),
            ]],
            batch_size: Some(10),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(
            statements,
            vec!["INSERT INTO `places` (`location`, `shape`) VALUES (ST_GeomFromWKB(0x0101000000AE47E17A14AE5C4052B81E85EBF34240, 4326), ST_GeomFromWKB(0x0101000000000000000000F03F0000000000000040));"]
        );
    }

    #[test]
    fn mysql_spatial_export_rejects_markers_for_unknown_or_nonspatial_types() {
        let marker = json!("DBX_WKB:4326:0101000000AE47E17A14AE5C4052B81E85EBF34240");
        assert!(format_mysql_spatial_export_literal(&marker, Some(DatabaseType::Mysql), None).is_none());
        assert!(format_mysql_spatial_export_literal(&marker, Some(DatabaseType::Mysql), Some("varchar")).is_none());
        assert!(format_mysql_spatial_export_literal(
            &json!("DBX_WKB:4326:0101000000"),
            Some(DatabaseType::Mysql),
            Some("geometry"),
        )
        .is_none());
    }

    #[test]
    fn mysql_spatial_export_select_normalizes_geometry_columns_to_wkb_markers() {
        let sql = database_export_select_sql(
            &["id".to_string(), "location".to_string(), "name".to_string()],
            &[Some("int".to_string()), Some("point".to_string()), Some("varchar(32)".to_string())],
            "places",
            "app",
            &DatabaseType::Mysql,
        );

        assert_eq!(
            sql,
            "SELECT `id`, CASE WHEN `location` IS NULL THEN NULL ELSE CONCAT('DBX_WKB:', ST_SRID(`location`), ':', HEX(ST_AsWKB(`location`))) END AS `location`, `name` FROM `places`"
        );
    }

    #[test]
    fn mysql_spatial_export_keeps_keyset_pagination_when_replacing_select_list() {
        let columns = vec!["id".to_string(), "location".to_string()];
        let column_types = vec![Some("bigint".to_string()), Some("geometry".to_string())];
        let sql = crate::transfer::keyset_pagination_sql_with_identifier_quote(
            &columns,
            "places",
            "app",
            &DatabaseType::Mysql,
            &["id".to_string()],
            &[json!(7)],
            1000,
            None,
        );

        let sql = replace_database_export_select_list(sql, &columns, &column_types, &DatabaseType::Mysql);

        assert!(sql.starts_with(
            "SELECT `id`, CASE WHEN `location` IS NULL THEN NULL ELSE CONCAT('DBX_WKB:', ST_SRID(`location`), ':', HEX(ST_AsWKB(`location`))) END AS `location` FROM `places`"
        ));
        assert!(sql.contains("WHERE `id` > 7"), "sql: {sql}");
        assert!(sql.contains("ORDER BY `id` ASC LIMIT 1000"), "sql: {sql}");
    }

    #[test]
    fn xugu_spatial_export_selects_ewkt_to_preserve_srid() {
        let sql = database_export_select_sql(
            &["id".to_string(), "shape".to_string(), "location".to_string(), "name".to_string()],
            &[
                Some("INTEGER".to_string()),
                Some("GEOMETRY".to_string()),
                Some("GEOGRAPHY".to_string()),
                Some("VARCHAR(32)".to_string()),
            ],
            "places",
            "app",
            &DatabaseType::Xugu,
        );

        assert_eq!(
            sql,
            "SELECT \"id\", ST_AsEWKT(\"shape\") AS \"shape\", ST_AsEWKT(\"location\") AS \"location\", \"name\" FROM \"app\".\"places\""
        );
    }

    #[test]
    fn xugu_spatial_export_replays_ewkt_and_keeps_plain_wkt_compatible() {
        assert_eq!(
            format_xugu_spatial_export_literal(
                &json!("SRID=3857;POINT(1 2)"),
                Some(DatabaseType::Xugu),
                Some("GEOMETRY"),
            ),
            Some("ST_GeomFromEWKT('SRID=3857;POINT(1 2)')".to_string())
        );
        assert_eq!(
            format_xugu_spatial_export_literal(&json!("POINT(1 2)"), Some(DatabaseType::Xugu), Some("GEOGRAPHY"),),
            Some("'POINT(1 2)'".to_string())
        );
        assert_eq!(
            format_xugu_spatial_export_literal(&Value::Null, Some(DatabaseType::Xugu), Some("GEOMETRY")),
            Some("NULL".to_string())
        );
        assert!(format_xugu_spatial_export_literal(
            &json!("SRID=3857;POINT(1 2)"),
            Some(DatabaseType::Xugu),
            Some("VARCHAR")
        )
        .is_none());
        assert!(format_xugu_spatial_export_literal(
            &json!("SRID=3857;POINT(1 2)"),
            Some(DatabaseType::Postgres),
            Some("GEOMETRY")
        )
        .is_none());
    }

    #[test]
    fn xugu_spatial_metadata_recovers_missing_type_and_cell_srid() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Xugu),
            identifier_quote: None,
            schema: Some("app".to_string()),
            table_name: Some("places".to_string()),
            qualified_table_name: None,
            columns: vec!["shape".to_string()],
            column_types: vec![None],
            column_extras: vec![None],
            spatial_columns: vec![SpatialColumn { column_index: 0, srid: Some(3857) }],
            spatial_values: vec![vec![Some(3857)]],
            rows: vec![vec![json!("POINT(1 2)")]],
            batch_size: None,
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![
                r#"INSERT INTO "app"."places" ("shape") VALUES (ST_GeomFromEWKT('SRID=3857;POINT(1 2)'));"#.to_string()
            ]
        );
    }

    #[test]
    fn database_specific_boolean_export_literals() {
        let sqlserver_statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::SqlServer),
            identifier_quote: None,
            schema: Some("dbo".to_string()),
            table_name: Some("flags".to_string()),
            qualified_table_name: None,
            columns: vec!["typed_true".to_string(), "untyped_false".to_string(), "typed_null".to_string()],
            column_types: vec![Some("bit".to_string()), None, Some("bit".to_string())],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!(true), json!(false), Value::Null]],
            batch_size: Some(10),
            preserve_original_language: false,
        })
        .unwrap();
        let postgres_statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Postgres),
            identifier_quote: None,
            schema: Some("public".to_string()),
            table_name: Some("flags".to_string()),
            qualified_table_name: None,
            columns: vec!["enabled".to_string(), "disabled".to_string(), "unknown".to_string()],
            column_types: Vec::new(),
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!(true), json!(false), Value::Null]],
            batch_size: Some(10),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(
            sqlserver_statements,
            vec!["INSERT INTO [dbo].[flags] ([typed_true], [untyped_false], [typed_null]) VALUES (1, 0, NULL);"]
        );
        assert_eq!(
            postgres_statements,
            vec![
                "INSERT INTO \"public\".\"flags\" (\"enabled\", \"disabled\", \"unknown\") VALUES (TRUE, FALSE, NULL);"
            ]
        );
    }

    #[test]
    fn ansi_export_keeps_backslashes_literal_and_doubles_quotes() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::SqlServer),
            identifier_quote: None,
            schema: None,
            table_name: Some("t".to_string()),
            qualified_table_name: None,
            columns: vec!["note".to_string()],
            column_types: vec![Some("nvarchar(255)".to_string())],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!(r"C:\new\it's")]],
            batch_size: Some(10),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(statements, vec!["INSERT INTO [t] ([note]) VALUES (N'C:\\new\\it''s');"]);
    }

    #[test]
    fn clickhouse_and_snowflake_export_escape_backslashes() {
        for database_type in [DatabaseType::ClickHouse, DatabaseType::Snowflake] {
            let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
                database_type: Some(database_type),
                identifier_quote: None,
                schema: None,
                table_name: Some("t".to_string()),
                qualified_table_name: None,
                columns: vec!["note".to_string()],
                column_types: vec![Some("String".to_string())],
                column_extras: Vec::new(),
                spatial_columns: Vec::new(),
                spatial_values: Vec::new(),
                rows: vec![vec![json!(r"C:\new\it's")]],
                batch_size: Some(10),
                preserve_original_language: false,
            })
            .unwrap();

            let expected = match database_type {
                DatabaseType::ClickHouse => r"INSERT INTO `t` (`note`) VALUES ('C:\\new\\it''s');",
                DatabaseType::Snowflake => r#"INSERT INTO "t" ("note") VALUES ('C:\\new\\it''s');"#,
                _ => unreachable!(),
            };
            assert_eq!(
                statements,
                vec![expected],
                "backslash-escaping dialect {database_type:?} must double backslashes"
            );
        }
    }

    #[test]
    fn clickhouse_and_snowflake_export_spell_the_sub_byte_as_a_hex_escape() {
        // `\Z` is a MySQL-family escape. ClickHouse reads it as a literal
        // backslash followed by `Z` (verified on the ClickHouse playground,
        // 26.10.1.448: `hex('a\Zb')` is `615C5A62`), and Snowflake drops the
        // backslash and yields `Z`. Both accept `\xhh`, which is the byte the
        // value holds (`hex('a\x1ab')` is `611A62`). Exporting `\Z` to them
        // would rewrite a stored SUB byte, so the escape has to be
        // dialect-specific.
        for database_type in [DatabaseType::ClickHouse, DatabaseType::Snowflake] {
            let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
                database_type: Some(database_type),
                identifier_quote: None,
                schema: None,
                table_name: Some("t".to_string()),
                qualified_table_name: None,
                columns: vec!["note".to_string()],
                column_types: vec![Some("String".to_string())],
                column_extras: Vec::new(),
                spatial_columns: Vec::new(),
                spatial_values: Vec::new(),
                rows: vec![vec![json!("a\x1ab")]],
                batch_size: Some(10),
                preserve_original_language: false,
            })
            .unwrap();

            let expected = match database_type {
                DatabaseType::ClickHouse => r"INSERT INTO `t` (`note`) VALUES ('a\x1ab');",
                DatabaseType::Snowflake => r#"INSERT INTO "t" ("note") VALUES ('a\x1ab');"#,
                _ => unreachable!(),
            };
            assert_eq!(statements, vec![expected], "dialect {database_type:?} must not emit the MySQL-only \\Z escape");
        }
    }

    #[test]
    fn mysql_export_still_uses_the_backslash_z_escape() {
        // MySQL has no `\xhh` escape, so the SUB byte must keep `\Z` there.
        // Guards against "fixing" the ClickHouse/Snowflake spelling everywhere.
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Mysql),
            identifier_quote: None,
            schema: None,
            table_name: Some("t".to_string()),
            qualified_table_name: None,
            columns: vec!["note".to_string()],
            column_types: vec![Some("text".to_string())],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!("a\x1ab")]],
            batch_size: Some(10),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(statements, vec![r"INSERT INTO `t` (`note`) VALUES ('a\Zb');"]);
    }

    #[test]
    fn sqlserver_export_prefixes_unicode_string_literals() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::SqlServer),
            identifier_quote: None,
            schema: Some("dbo".to_string()),
            table_name: Some("people".to_string()),
            qualified_table_name: None,
            columns: vec![
                "name".to_string(),
                "code".to_string(),
                "legacy_note".to_string(),
                "alias_name".to_string(),
                "plain_text".to_string(),
                "missing".to_string(),
            ],
            column_types: vec![
                Some("NVARCHAR(255)".to_string()),
                Some(" nchar (10) ".to_string()),
                Some("ntext".to_string()),
                Some("sysname".to_string()),
                Some("varchar(255)".to_string()),
                Some("nvarchar(20)".to_string()),
            ],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![
                json!("张'三"),
                json!("中文"),
                json!("旧文本"),
                json!("别名"),
                json!("plain"),
                Value::Null,
            ]],
            batch_size: Some(10),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![
                "INSERT INTO [dbo].[people] ([name], [code], [legacy_note], [alias_name], [plain_text], [missing]) VALUES (N'张''三', N'中文', N'旧文本', N'别名', 'plain', NULL);"
            ]
        );
    }

    #[test]
    fn sqlserver_export_keeps_binary_values_as_hex_literals() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::SqlServer),
            identifier_quote: None,
            schema: Some("dbo".to_string()),
            table_name: Some("bin_probe".to_string()),
            qualified_table_name: None,
            columns: vec!["id".to_string(), "payload".to_string(), "label".to_string(), "empty_payload".to_string()],
            column_types: vec![
                Some("int".to_string()),
                Some("varbinary(max)".to_string()),
                Some("nvarchar(50)".to_string()),
                Some("binary(8)".to_string()),
            ],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![
                vec![json!(1), json!("0x0011FFEE"), json!("中文"), json!("0x")],
                vec![json!(2), Value::Null, json!("plain"), json!("0XABcd")],
                vec![json!(3), json!("0xzz"), json!("text"), json!("not-hex")],
            ],
            batch_size: Some(10),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![
                "INSERT INTO [dbo].[bin_probe] ([id], [payload], [label], [empty_payload]) VALUES\n(1, 0x0011FFEE, N'中文', 0x),\n(2, NULL, N'plain', 0xABcd),\n(3, '0xzz', N'text', 'not-hex');"
            ]
        );
    }

    #[test]
    fn sqlserver_database_export_keeps_binary_values_as_hex_literals() {
        let sql = build_database_sql_export(BuildDatabaseSqlExportOptions {
            database_name: "dbx10411".to_string(),
            exported_at: Some("2026-09-28T00:00:00.000Z".to_string()),
            tables: vec![ExportedTableSql {
                display_name: "test.dbo.bin_probe".to_string(),
                database_type: Some(DatabaseType::SqlServer),
                identifier_quote: None,
                schema: Some("dbo".to_string()),
                table_name: Some("bin_probe".to_string()),
                qualified_table_name: None,
                ddl: None,
                columns: vec!["id".to_string(), "payload".to_string()],
                column_types: vec![Some("int".to_string()), Some("varbinary(max)".to_string())],
                column_extras: Vec::new(),
                spatial_columns: Vec::new(),
                spatial_values: Vec::new(),
                rows: vec![vec![json!(1), json!("0x0011ffee")], vec![json!(2), Value::Null]],
                truncated: false,
            }],
            row_limit_per_table: None,
            insert_batch_size: None,
            insert_dialect: SqlInsertDialect::Source,
            connection_id: None,
            database: None,
            schema: None,
            omit_auto_increment: false,
            preserve_original_language: false,
        })
        .expect("build SQL Server database export");

        assert!(sql.contains("(1, 0x0011ffee)"), "binary literal missing from export: {sql}");
        assert!(!sql.contains("'0x0011ffee'"), "binary values must not be exported as strings: {sql}");
    }

    #[test]
    fn mysql_export_inserts_escape_control_characters() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Mysql),
            identifier_quote: None,
            schema: None,
            table_name: Some("notes".to_string()),
            qualified_table_name: None,
            columns: vec!["body".to_string()],
            column_types: vec![Some("text".to_string())],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!("line1\nline2\tcol\rend\\slash\0\x1aO'Hara")]],
            batch_size: Some(10),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(
            statements,
            vec!["INSERT INTO `notes` (`body`) VALUES ('line1\\nline2\\tcol\\rend\\\\slash\\0\\ZO''Hara');"]
        );
    }

    #[test]
    fn export_insert_batches_split_on_statement_bytes() {
        let long_value = "x".repeat(300_000);
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Mysql),
            identifier_quote: None,
            schema: None,
            table_name: Some("payloads".to_string()),
            qualified_table_name: None,
            columns: vec!["payload".to_string()],
            column_types: vec![Some("longtext".to_string())],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!(long_value.clone())], vec![json!(long_value)]],
            batch_size: Some(100),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(statements.len(), 2);
        assert!(statements.iter().all(|statement| statement.matches("INSERT INTO").count() == 1));
    }

    #[test]
    fn sqlserver_export_caps_multi_row_insert_at_1000_rows() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::SqlServer),
            identifier_quote: None,
            schema: Some("dbo".to_string()),
            table_name: Some("items".to_string()),
            qualified_table_name: None,
            columns: vec!["id".to_string()],
            column_types: vec![Some("int".to_string())],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: (0..1001).map(|id| vec![json!(id)]).collect(),
            batch_size: Some(2000),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(statements.len(), 2);
        assert_eq!(statements[0].matches("),\n(").count(), 999);
        assert_eq!(statements[1].matches("),\n(").count(), 0);
    }

    #[test]
    fn doris_export_inserts_escape_control_characters() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Doris),
            identifier_quote: None,
            schema: Some("warehouse".to_string()),
            table_name: Some("events".to_string()),
            qualified_table_name: None,
            columns: vec!["message".to_string()],
            column_types: vec![Some("varchar(255)".to_string())],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!("first\nsecond\tthird")]],
            batch_size: Some(10),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(statements, vec!["INSERT INTO `warehouse`.`events` (`message`) VALUES ('first\\nsecond\\tthird');"]);
    }

    #[test]
    fn postgres_export_inserts_escape_control_characters() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Postgres),
            identifier_quote: None,
            schema: Some("public".to_string()),
            table_name: Some("notes".to_string()),
            qualified_table_name: None,
            columns: vec!["body".to_string()],
            column_types: vec![Some("text".to_string())],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!("line1\nline2\tend")]],
            batch_size: Some(10),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(statements, vec!["INSERT INTO \"public\".\"notes\" (\"body\") VALUES (E'line1\\nline2\\tend');"]);
    }

    #[test]
    fn postgres_bytea_export_decodes_valid_dbx_hex_values() {
        const ZIP_HEX: &str = "504b03041400080008007496195d00000000000000000000000009000900746573742e6a736f6e5554050001bd738d6a013100ceff7b0a2020227469746c65223a202254657374222c0a20202274657874223a202248656c6c6f2c20776f726c6421220a7d0a504b07083f90bb503600000031000000504b010214031400080008007496195d3f90bb503600000031000000090009000000000000000000b48100000000746573742e6a736f6e5554050001bd738d6a504b0506000000000100010040000000760000000000";
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Postgres),
            identifier_quote: None,
            schema: Some("public".to_string()),
            table_name: Some("attachments".to_string()),
            qualified_table_name: None,
            columns: vec![
                "zip_content".to_string(),
                "empty_content".to_string(),
                "uppercase_content".to_string(),
                "nullable_content".to_string(),
                "plain_text".to_string(),
            ],
            column_types: vec![
                Some("bytea".to_string()),
                Some("bytea".to_string()),
                Some("bytea".to_string()),
                Some("bytea".to_string()),
                Some("text".to_string()),
            ],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!(format!("0x{ZIP_HEX}")), json!("0x"), json!("0XABcd"), Value::Null, json!("0xABcd")]],
            batch_size: Some(10),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![format!(
                "INSERT INTO \"public\".\"attachments\" (\"zip_content\", \"empty_content\", \"uppercase_content\", \"nullable_content\", \"plain_text\") VALUES (decode('{ZIP_HEX}','hex'), decode('','hex'), decode('ABcd','hex'), NULL, '0xABcd');"
            )]
        );
    }

    #[test]
    fn postgres_bytea_export_quotes_invalid_or_non_string_values() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Postgres),
            identifier_quote: None,
            schema: Some("public".to_string()),
            table_name: Some("attachments".to_string()),
            qualified_table_name: None,
            columns: vec!["odd_hex".to_string(), "invalid_hex".to_string(), "unexpected_number".to_string()],
            column_types: vec![Some("bytea".to_string()), Some("bytea".to_string()), Some("bytea".to_string())],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!("0xabc"), json!("0xgg"), json!(7)]],
            batch_size: Some(10),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![
                "INSERT INTO \"public\".\"attachments\" (\"odd_hex\", \"invalid_hex\", \"unexpected_number\") VALUES ('0xabc', '0xgg', '7');"
            ]
        );
    }

    #[test]
    fn postgres_export_inserts_escape_quotes_and_backslashes_without_changing_plain_strings() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Postgres),
            identifier_quote: None,
            schema: Some("public".to_string()),
            table_name: Some("notes".to_string()),
            qualified_table_name: None,
            columns: vec!["carriage_return".to_string(), "quote".to_string(), "path".to_string(), "plain".to_string()],
            column_types: vec![
                Some("text".to_string()),
                Some("text".to_string()),
                Some("text".to_string()),
                Some("text".to_string()),
            ],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!("line1\rline2"), json!("O'Hara"), json!(r"C:\tmp"), json!("plain")]],
            batch_size: Some(10),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![
                r#"INSERT INTO "public"."notes" ("carriage_return", "quote", "path", "plain") VALUES (E'line1\rline2', 'O''Hara', E'C:\\tmp', 'plain');"#
            ]
        );
    }

    #[test]
    fn postgres_jsonb_export_preserves_json_escape_sequences() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Postgres),
            identifier_quote: None,
            schema: Some("public".to_string()),
            table_name: Some("events".to_string()),
            qualified_table_name: None,
            columns: vec!["payload".to_string()],
            column_types: vec![Some("jsonb".to_string())],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!(r#"{"text":"say \"hi\"","path":"C:\\tmp","quote":"O'Hara"}"#)]],
            batch_size: Some(10),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![
                r#"INSERT INTO "public"."events" ("payload") VALUES (E'{"text":"say \\"hi\\"","path":"C:\\\\tmp","quote":"O''Hara"}');"#
            ]
        );
    }

    #[test]
    fn opengauss_export_inserts_escape_quotes_without_doubling_backslashes() {
        let style = r#""{\"paddingTop\":\"20vh\",\"fontSize\":16}""#;
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::OpenGauss),
            identifier_quote: None,
            schema: Some("public".to_string()),
            table_name: Some("dbx_issue_json".to_string()),
            qualified_table_name: None,
            columns: vec!["comment_text".to_string(), "style".to_string()],
            column_types: vec![Some("text".to_string()), Some("json".to_string())],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!("逻辑删除标志：'0'-未删除，'1'-已删除"), json!(style)]],
            batch_size: Some(10),
            preserve_original_language: false,
        })
        .unwrap();

        let expected_style = format!("'{style}'");
        assert_eq!(
            statements,
            vec![format!(
                "INSERT INTO \"public\".\"dbx_issue_json\" (\"comment_text\", \"style\") VALUES ('逻辑删除标志：''0''-未删除，''1''-已删除', {expected_style});"
            )]
        );
    }

    #[test]
    fn postgres_export_keeps_json_escape_sequences_for_the_same_value() {
        let style = r#""{\"paddingTop\":\"20vh\",\"fontSize\":16}""#;
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Postgres),
            identifier_quote: None,
            schema: Some("public".to_string()),
            table_name: Some("dbx_issue_json".to_string()),
            qualified_table_name: None,
            columns: vec!["style".to_string()],
            column_types: vec![Some("json".to_string())],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!(style)]],
            batch_size: Some(10),
            preserve_original_language: false,
        })
        .unwrap();

        let expected_style = format!("E'{}'", style.replace('\\', "\\\\"));
        assert_eq!(
            statements,
            vec![format!("INSERT INTO \"public\".\"dbx_issue_json\" (\"style\") VALUES ({expected_style});")]
        );
    }

    #[test]
    fn postgres_vector_export_preserves_pgvector_bracket_literals() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Postgres),
            identifier_quote: None,
            schema: Some("public".to_string()),
            table_name: Some("items".to_string()),
            qualified_table_name: None,
            columns: vec![
                "id".to_string(),
                "embedding".to_string(),
                "qualified_embedding".to_string(),
                "compact_embedding".to_string(),
                "labels".to_string(),
                "embedding_history".to_string(),
            ],
            column_types: vec![
                Some("integer".to_string()),
                Some("vector(2)".to_string()),
                Some("public.vector".to_string()),
                Some("halfvec(2)".to_string()),
                Some("text[]".to_string()),
                Some("public.vector(2)[]".to_string()),
            ],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![
                json!(1),
                json!([1.2, 3.4]),
                json!(["5", "6"]),
                json!([-0.25, 4]),
                json!(["x", "y"]),
                json!([[1.2, 3.4], [5, 6]]),
            ]],
            batch_size: Some(10),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![
                r#"INSERT INTO "public"."items" ("id", "embedding", "qualified_embedding", "compact_embedding", "labels", "embedding_history") VALUES (1, '[1.2,3.4]', '[5,6]', '[-0.25,4]', '{"x","y"}', '{{1.2,3.4},{5,6}}');"#
            ]
        );
    }

    #[test]
    fn builds_batched_insert_statements_for_export() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Mysql),
            identifier_quote: None,
            schema: None,
            table_name: Some("users".to_string()),
            qualified_table_name: None,
            columns: vec!["id".to_string(), "name".to_string()],
            column_types: Vec::new(),
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!(1), json!("Ada")], vec![json!(2), json!("O'Hara")], vec![json!(3), json!("Linus")]],
            batch_size: Some(2),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![
                "INSERT INTO `users` (`id`, `name`) VALUES\n(1, 'Ada'),\n(2, 'O''Hara');",
                "INSERT INTO `users` (`id`, `name`) VALUES (3, 'Linus');",
            ]
        );
    }

    #[test]
    fn batched_insert_statements_write_each_row_on_its_own_line() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Mysql),
            identifier_quote: None,
            schema: None,
            table_name: Some("users".to_string()),
            qualified_table_name: None,
            columns: vec!["id".to_string(), "name".to_string()],
            column_types: Vec::new(),
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!(1), json!("Ada")], vec![json!(2), json!("O'Hara")], vec![json!(3), json!("Linus")]],
            batch_size: Some(10),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(
            statements,
            vec!["INSERT INTO `users` (`id`, `name`) VALUES\n(1, 'Ada'),\n(2, 'O''Hara'),\n(3, 'Linus');"]
        );
    }

    #[test]
    fn single_row_batches_keep_the_compact_insert_layout() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Mysql),
            identifier_quote: None,
            schema: None,
            table_name: Some("users".to_string()),
            qualified_table_name: None,
            columns: vec!["id".to_string(), "name".to_string()],
            column_types: Vec::new(),
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!(1), json!("Ada")], vec![json!(2), json!("Linus")]],
            batch_size: Some(1),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![
                "INSERT INTO `users` (`id`, `name`) VALUES (1, 'Ada');",
                "INSERT INTO `users` (`id`, `name`) VALUES (2, 'Linus');",
            ]
        );
    }

    #[test]
    fn decode_unicode_escapes_for_export_round_trips_vietnamese_text() {
        assert_eq!(decode_unicode_escapes_for_export("\\u1ed0ng gi\\u00f3 th\\u1eb3ng"), "Ống gió thẳng");
        // Leaves non-escape backslashes untouched (e.g. a literal path or doubled quote escape).
        assert_eq!(decode_unicode_escapes_for_export("600x200\\\" width"), "600x200\\\" width");
        // A text run with no `\u` escapes at all is returned unchanged (fast path).
        assert_eq!(decode_unicode_escapes_for_export("plain text"), "plain text");
        // Surrogate pairs decode to a single non-BMP character.
        assert_eq!(decode_unicode_escapes_for_export("\\ud83d\\ude00"), "😀");
        // A malformed/lone high surrogate is left as literal text instead of panicking or corrupting data.
        assert_eq!(decode_unicode_escapes_for_export("\\ud83dxyz"), "\\ud83dxyz");
    }

    #[test]
    fn preserve_original_language_option_decodes_unicode_escapes_in_exported_literals() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::SqlServer),
            identifier_quote: None,
            schema: None,
            table_name: Some("VersionValue".to_string()),
            qualified_table_name: None,
            columns: vec!["jsonValues".to_string()],
            column_types: Vec::new(),
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!("{\"clientBoqItemName\":\"\\u1ed0ng gi\\u00f3 th\\u1eb3ng\"}")]],
            batch_size: Some(10),
            preserve_original_language: true,
        })
        .unwrap();

        assert_eq!(
            statements,
            vec!["INSERT INTO [VersionValue] ([jsonValues]) VALUES ('{\"clientBoqItemName\":\"Ống gió thẳng\"}');"]
        );
    }

    #[test]
    fn preserve_original_language_defaults_to_false_and_keeps_ascii_escapes() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::SqlServer),
            identifier_quote: None,
            schema: None,
            table_name: Some("VersionValue".to_string()),
            qualified_table_name: None,
            columns: vec!["jsonValues".to_string()],
            column_types: Vec::new(),
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!("{\"clientBoqItemName\":\"\\u1ed0ng gi\\u00f3 th\\u1eb3ng\"}")]],
            batch_size: Some(10),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![
                "INSERT INTO [VersionValue] ([jsonValues]) VALUES ('{\"clientBoqItemName\":\"\\u1ed0ng gi\\u00f3 th\\u1eb3ng\"}');"
            ]
        );
    }

    #[test]
    fn oracle_export_inserts_use_one_statement_per_row() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Oracle),
            identifier_quote: None,
            schema: Some("APP".to_string()),
            table_name: Some("USERS".to_string()),
            qualified_table_name: None,
            columns: vec!["ID".to_string(), "NAME".to_string()],
            column_types: Vec::new(),
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!(1), json!("Ada")], vec![json!(2), json!("Linus")]],
            batch_size: Some(100),
            preserve_original_language: false,
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
            identifier_quote: None,
            schema: Some("APP".to_string()),
            table_name: Some("USERS".to_string()),
            qualified_table_name: None,
            columns: vec!["__DBX_ROWID".to_string(), "ID".to_string(), "NAME".to_string()],
            column_types: vec![Some("VARCHAR2".to_string()), Some("NUMBER".to_string()), Some("VARCHAR2".to_string())],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!("AAAPr9AAEAAAAGfAAA"), json!(1), json!("Ada")]],
            batch_size: Some(100),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(statements, vec!["INSERT INTO \"APP\".\"USERS\" (\"ID\", \"NAME\") VALUES (1, 'Ada');"]);
    }

    #[test]
    fn oceanbase_oracle_export_omits_synthetic_rowid_from_insert_columns() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::OceanbaseOracle),
            identifier_quote: None,
            schema: Some("APP".to_string()),
            table_name: Some("USERS".to_string()),
            qualified_table_name: None,
            columns: vec!["__DBX_ROWID".to_string(), "ID".to_string(), "NAME".to_string()],
            column_types: vec![Some("VARCHAR2".to_string()), Some("NUMBER".to_string()), Some("VARCHAR2".to_string())],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!("*AAABk1AAEAAAAAgAAA"), json!(1), json!("Ada")]],
            batch_size: Some(100),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(statements, vec!["INSERT INTO \"APP\".\"USERS\" (\"ID\", \"NAME\") VALUES (1, 'Ada');"]);
    }

    #[test]
    fn non_oracle_export_preserves_dbx_rowid_named_column() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Mysql),
            identifier_quote: None,
            schema: None,
            table_name: Some("users".to_string()),
            qualified_table_name: None,
            columns: vec!["__DBX_ROWID".to_string(), "name".to_string()],
            column_types: Vec::new(),
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!(7), json!("Ada")]],
            batch_size: Some(100),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(statements, vec!["INSERT INTO `users` (`__DBX_ROWID`, `name`) VALUES (7, 'Ada');"]);
    }

    #[test]
    fn oracle_date_columns_export_as_date_literals() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Oracle),
            identifier_quote: None,
            schema: Some("APP".to_string()),
            table_name: Some("EVENTS".to_string()),
            qualified_table_name: None,
            columns: vec!["ID".to_string(), "CREATED_ON".to_string(), "RAW_TEXT".to_string()],
            column_types: vec![Some("NUMBER".to_string()), Some("DATE".to_string()), Some("VARCHAR2(64)".to_string())],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![
                vec![json!(1), json!("2022-08-25T09:58:43Z"), json!("2022-08-25T09:58:43Z")],
                vec![json!(2), json!("2022-08-25T00:00:00Z"), json!("2022-08-25T00:00:00Z")],
            ],
            batch_size: Some(100),
            preserve_original_language: false,
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
    fn oracle_timestamp_columns_export_as_explicit_literals() {
        for database_type in [DatabaseType::Oracle, DatabaseType::OceanbaseOracle] {
            let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
                database_type: Some(database_type),
                identifier_quote: None,
                schema: Some("APP".to_string()),
                table_name: Some("EVENTS".to_string()),
                qualified_table_name: None,
                columns: vec![
                    "CREATED_AT".to_string(),
                    "UPDATED_AT".to_string(),
                    "RECORDED_AT".to_string(),
                    "LOCAL_RECORDED_AT".to_string(),
                    "DRIVER_CREATED_AT".to_string(),
                    "DRIVER_RECORDED_AT".to_string(),
                    "RAW_TEXT".to_string(),
                    "UNTYPED".to_string(),
                    "INVALID_AT".to_string(),
                    "SHAPED_INVALID_AT".to_string(),
                    "NULL_AT".to_string(),
                ],
                column_types: vec![
                    Some("TIMESTAMP(6)".to_string()),
                    Some("TIMESTAMP(6)".to_string()),
                    Some("TIMESTAMP(9) WITH TIME ZONE".to_string()),
                    Some("TIMESTAMP(6) WITH LOCAL TIME ZONE".to_string()),
                    Some("TimeStampDTY".to_string()),
                    Some("TimeStampTZ_DTY".to_string()),
                    Some("VARCHAR2(64)".to_string()),
                    None,
                    Some("TIMESTAMP(6)".to_string()),
                    Some("TIMESTAMP(6)".to_string()),
                    Some("TIMESTAMP".to_string()),
                ],
                column_extras: Vec::new(),
                spatial_columns: Vec::new(),
                spatial_values: Vec::new(),
                rows: vec![vec![
                    json!("2022-08-25 09:58:43.123456"),
                    json!("2022-08-26T10:59:44Z"),
                    json!("2022-08-27T11:00:45.123456789+08:00"),
                    json!("2022-08-28T12:01:46Z"),
                    json!("2022-08-29T13:02:47.123456"),
                    json!("2022-08-30T14:03:48-05:30"),
                    json!("2022-08-31T15:04:49Z"),
                    json!("2022-09-01T16:05:50Z"),
                    json!("not-a-timestamp"),
                    json!("2022-0'-25T09:58:43Z"),
                    Value::Null,
                ]],
                batch_size: Some(100),
                preserve_original_language: false,
            })
            .unwrap();

            assert_eq!(
                statements,
                vec![concat!(
                    "INSERT INTO \"APP\".\"EVENTS\" (\"CREATED_AT\", \"UPDATED_AT\", \"RECORDED_AT\", ",
                    "\"LOCAL_RECORDED_AT\", \"DRIVER_CREATED_AT\", \"DRIVER_RECORDED_AT\", \"RAW_TEXT\", ",
                    "\"UNTYPED\", \"INVALID_AT\", \"SHAPED_INVALID_AT\", \"NULL_AT\") VALUES ",
                    "(TO_TIMESTAMP('2022-08-25 09:58:43.123456', 'YYYY-MM-DD HH24:MI:SS.FF'), ",
                    "TO_TIMESTAMP('2022-08-26 10:59:44', 'YYYY-MM-DD HH24:MI:SS'), ",
                    "TO_TIMESTAMP_TZ('2022-08-27 11:00:45.123456789 +08:00', ",
                    "'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM'), ",
                    "TO_TIMESTAMP_TZ('2022-08-28 12:01:46 +00:00', 'YYYY-MM-DD HH24:MI:SS TZH:TZM'), ",
                    "TO_TIMESTAMP('2022-08-29 13:02:47.123456', 'YYYY-MM-DD HH24:MI:SS.FF'), ",
                    "TO_TIMESTAMP_TZ('2022-08-30 14:03:48 -05:30', 'YYYY-MM-DD HH24:MI:SS TZH:TZM'), ",
                    "'2022-08-31T15:04:49Z', '2022-09-01T16:05:50Z', 'not-a-timestamp', ",
                    "'2022-0''-25T09:58:43Z', NULL);"
                )]
            );
        }
    }

    #[test]
    fn non_oracle_timestamp_exports_keep_existing_literals() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Postgres),
            identifier_quote: None,
            schema: Some("public".to_string()),
            table_name: Some("events".to_string()),
            qualified_table_name: None,
            columns: vec!["created_at".to_string(), "recorded_at".to_string()],
            column_types: vec![Some("timestamp".to_string()), Some("timestamp with time zone".to_string())],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!("2022-08-25T09:58:43.123456Z"), json!("2022-08-26T10:59:44+08:00")]],
            batch_size: Some(100),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![concat!(
                "INSERT INTO \"public\".\"events\" (\"created_at\", \"recorded_at\") VALUES ",
                "('2022-08-25 09:58:43.123456', '2022-08-26 10:59:44+08:00');"
            )]
        );
    }

    #[test]
    fn mysql_bit_columns_export_without_quoted_string_values() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Mysql),
            identifier_quote: None,
            schema: None,
            table_name: Some("flags".to_string()),
            qualified_table_name: None,
            columns: vec!["enabled".to_string(), "mask".to_string(), "label".to_string()],
            column_types: vec![Some("bit(1)".to_string()), Some("BIT(4)".to_string()), Some("varchar(20)".to_string())],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!("1"), json!("1010"), json!("1010")], vec![json!(false), json!(3), json!("off")]],
            batch_size: Some(10),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![
                "INSERT INTO `flags` (`enabled`, `mask`, `label`) VALUES\n(b'1', b'1010', '1010'),\n(b'0', 3, 'off');"
            ]
        );
    }

    #[test]
    fn dameng_bit_columns_export_as_numeric_literals() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Dameng),
            identifier_quote: None,
            schema: Some("DBX_TEST".to_string()),
            table_name: Some("FLAGS".to_string()),
            qualified_table_name: None,
            columns: vec!["ENABLED".to_string(), "DELETED".to_string(), "OPTIONAL".to_string()],
            column_types: vec![Some("BIT".to_string()), Some("bit".to_string()), Some("BIT".to_string())],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!(true), json!(false), Value::Null]],
            batch_size: Some(10),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(
            statements,
            vec!["INSERT INTO \"DBX_TEST\".\"FLAGS\" (\"ENABLED\", \"DELETED\", \"OPTIONAL\") VALUES (1, 0, NULL);"]
        );
    }

    #[test]
    fn dameng_strings_export_nul_as_chr_expression() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Dameng),
            identifier_quote: None,
            schema: Some("DBX_TEST".to_string()),
            table_name: Some("NUL_VALUES".to_string()),
            qualified_table_name: None,
            columns: vec![
                "PLAIN".to_string(),
                "TRAILING".to_string(),
                "LEADING".to_string(),
                "MIDDLE".to_string(),
                "CONSECUTIVE".to_string(),
                "ONLY_NUL".to_string(),
            ],
            column_types: vec![Some("VARCHAR".to_string()); 6],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![
                json!("plain"),
                json!("eHall\0"),
                json!("\0leading"),
                json!("left\0right"),
                json!("left\0\0right"),
                json!("\0"),
            ]],
            batch_size: Some(10),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![concat!(
                "INSERT INTO \"DBX_TEST\".\"NUL_VALUES\" ",
                "(\"PLAIN\", \"TRAILING\", \"LEADING\", \"MIDDLE\", \"CONSECUTIVE\", \"ONLY_NUL\") ",
                "VALUES ('plain', 'eHall' || CHR(0), CHR(0) || 'leading', 'left' || CHR(0) || 'right', ",
                "'left' || CHR(0) || CHR(0) || 'right', CHR(0));"
            )]
        );
        assert!(!statements[0].contains('\0'));
    }

    #[test]
    fn mysql_export_uses_typed_literals_for_numeric_and_blob_columns() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Mysql),
            identifier_quote: None,
            schema: None,
            table_name: Some("t_test_01".to_string()),
            qualified_table_name: None,
            columns: vec!["id".to_string(), "f_blob".to_string(), "note".to_string()],
            column_types: vec![Some("int".to_string()), Some("blob".to_string()), Some("varchar(64)".to_string())],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![
                vec![json!("1"), json!("0x68656c6c6f"), json!("0x68656c6c6f")],
                vec![json!("2"), json!("0X"), json!("1")],
            ],
            batch_size: Some(10),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![
                "INSERT INTO `t_test_01` (`id`, `f_blob`, `note`) VALUES\n(1, 0x68656c6c6f, '0x68656c6c6f'),\n(2, X'', '1');"
            ]
        );
    }

    #[test]
    fn temporal_columns_export_without_rfc3339_separator_or_utc_suffix() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Mysql),
            identifier_quote: None,
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
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![
                json!(1),
                json!("2026-06-12T10:11:12.123456789Z"),
                json!("2026-06-12T10:11:12Z"),
                json!("2026-06-12T10:11:12Z"),
            ]],
            batch_size: Some(10),
            preserve_original_language: false,
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
            identifier_quote: None,
            schema: Some("public".to_string()),
            table_name: Some("events".to_string()),
            qualified_table_name: None,
            columns: vec!["recorded_at".to_string(), "local_at".to_string()],
            column_types: vec![
                Some("timestamp with time zone".to_string()),
                Some("timestamp without time zone".to_string()),
            ],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!("2026-06-12T10:11:12Z"), json!("2026-06-12T18:11:12+08:00")]],
            batch_size: Some(10),
            preserve_original_language: false,
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
            identifier_quote: None,
            schema: Some("dbo".to_string()),
            table_name: Some("events".to_string()),
            qualified_table_name: None,
            columns: vec!["row_version".to_string(), "created_at".to_string()],
            column_types: vec![Some("timestamp".to_string()), Some("datetime2(3)".to_string())],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!("2026-06-12T10:11:12Z"), json!("2026-06-12T10:11:12.1234567Z")]],
            batch_size: Some(10),
            preserve_original_language: false,
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
            identifier_quote: None,
            schema: Some("public".to_string()),
            table_name: Some("articles".to_string()),
            qualified_table_name: None,
            columns: vec!["id".to_string(), "title".to_string(), "search_vector".to_string()],
            column_types: vec![Some("integer".to_string()), Some("text".to_string()), Some("tsvector".to_string())],
            column_extras: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!(1), json!("Hello"), json!("'hello':1A")]],
            batch_size: Some(10),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(statements, vec!["INSERT INTO \"public\".\"articles\" (\"id\", \"title\") VALUES (1, 'Hello');"]);
    }

    #[test]
    fn sql_insert_export_omits_excluded_columns_and_keeps_values_aligned() {
        let statements = build_export_insert_statements_excluding(
            BuildExportInsertStatementsOptions {
                database_type: Some(DatabaseType::Postgres),
                identifier_quote: None,
                schema: Some("public".to_string()),
                table_name: Some("users".to_string()),
                qualified_table_name: None,
                columns: vec!["id".to_string(), "name".to_string(), "email".to_string()],
                column_types: vec![Some("integer".to_string()), Some("text".to_string()), Some("text".to_string())],
                column_extras: Vec::new(),
                spatial_columns: Vec::new(),
                spatial_values: Vec::new(),
                rows: vec![vec![json!(1), json!("Ada"), json!("ada@example.com")]],
                batch_size: Some(10),
                preserve_original_language: false,
            },
            &["id".to_string()],
        )
        .unwrap();

        assert_eq!(
            statements,
            vec!["INSERT INTO \"public\".\"users\" (\"name\", \"email\") VALUES ('Ada', 'ada@example.com');"]
        );
    }

    #[test]
    fn sql_insert_export_allows_explicitly_excluded_opaque_column() {
        let statements = build_export_insert_statements_excluding(
            BuildExportInsertStatementsOptions {
                database_type: Some(DatabaseType::Doris),
                identifier_quote: None,
                schema: None,
                table_name: Some("states".to_string()),
                qualified_table_name: None,
                columns: vec!["id".to_string(), "v2".to_string()],
                column_types: vec![Some("integer".to_string()), Some("agg_state<sum(int)>".to_string())],
                column_extras: Vec::new(),
                spatial_columns: Vec::new(),
                spatial_values: Vec::new(),
                rows: vec![vec![json!(1), json!("0x00ff")]],
                batch_size: Some(10),
                preserve_original_language: false,
            },
            &["v2".to_string()],
        )
        .unwrap();

        assert_eq!(statements, vec!["INSERT INTO `states` (`id`) VALUES (1);"]);
    }

    #[test]
    fn sql_insert_export_reports_error_when_excluding_leaves_no_columns() {
        let result = build_export_insert_statements_excluding(
            BuildExportInsertStatementsOptions {
                database_type: Some(DatabaseType::Postgres),
                identifier_quote: None,
                schema: Some("public".to_string()),
                table_name: Some("user_roles".to_string()),
                qualified_table_name: None,
                columns: vec!["user_id".to_string()],
                column_types: vec![Some("integer".to_string())],
                column_extras: Vec::new(),
                spatial_columns: Vec::new(),
                spatial_values: Vec::new(),
                rows: vec![vec![json!(1)]],
                batch_size: Some(10),
                preserve_original_language: false,
            },
            &["user_id".to_string()],
        );

        assert_eq!(
            result.expect_err("excluding every column must fail instead of writing an empty export"),
            "No insertable columns remain after excluding columns from the export."
        );
    }

    #[test]
    fn build_export_sql_insert_honors_exclude_columns_from_payload() {
        let options: BuildExportSqlInsertOptions = serde_json::from_value(json!({
            "databaseType": "postgres",
            "schema": "public",
            "tableName": "users",
            "columns": ["id", "name"],
            "columnTypes": ["integer", "text"],
            "rows": [[1, "Ada"]],
            "excludeColumns": ["id"],
            "batchSize": 10
        }))
        .expect("deserialize export insert payload");

        assert_eq!(options.insert_dialect, SqlInsertDialect::Source);

        let sql = build_export_sql_insert(options).expect("build export sql insert");

        assert_eq!(sql, "INSERT INTO \"public\".\"users\" (\"name\") VALUES ('Ada');");
    }

    #[test]
    fn standard_sql_insert_uses_ansi_identifiers_and_portable_scalar_literals() {
        let options: BuildExportSqlInsertOptions = serde_json::from_value(json!({
            "databaseType": "sqlserver",
            "identifierQuote": "[",
            "insertDialect": "standard",
            "schema": "sales\"ops",
            "tableName": "order]items",
            "columns": ["id", "select", "full\"name", "payload"],
            "columnTypes": ["int", "bit", "nvarchar(100)", "json"],
            "columnExtras": ["identity(1,1)", null, null, null],
            "rows": [
                [1, true, "C:\\tmp\\O'Hara", ["x", 2]],
                [2, false, "plain", null]
            ],
            "batchSize": 10
        }))
        .expect("deserialize Standard SQL INSERT payload");

        let sql = build_export_sql_insert(options).expect("build Standard SQL INSERT");

        assert_eq!(
            sql,
            r#"INSERT INTO "sales""ops"."order]items" ("id", "select", "full""name", "payload") VALUES
(1, TRUE, 'C:\tmp\O''Hara', '["x",2]'),
(2, FALSE, 'plain', NULL);"#
        );
        assert!(!sql.contains("IDENTITY_INSERT"));
        assert!(!sql.contains("N'"));
    }

    #[test]
    fn standard_sql_insert_keeps_requested_batch_mode_for_oracle_sources() {
        let options: BuildExportSqlInsertOptions = serde_json::from_value(json!({
            "databaseType": "oracle",
            "insertDialect": "standard",
            "schema": "APP",
            "tableName": "USERS",
            "columns": ["ID"],
            "rows": [[1], [2]],
            "batchSize": 10
        }))
        .expect("deserialize Standard SQL INSERT payload");

        let sql = build_export_sql_insert(options).expect("build Standard SQL INSERT");

        assert_eq!(sql, "INSERT INTO \"APP\".\"USERS\" (\"ID\") VALUES\n(1),\n(2);");
    }

    #[test]
    fn mysql_generated_columns_are_omitted_from_sql_inserts_but_kept_in_ddl() {
        let ddl = "CREATE TABLE `orders` (`id` bigint AUTO_INCREMENT, `quantity` int, `unit_price` decimal(10,2), `virtual_total` decimal(10,2) GENERATED ALWAYS AS ((`quantity` * `unit_price`)) VIRTUAL, `stored_total` decimal(10,2) GENERATED ALWAYS AS ((`quantity` * `unit_price`)) STORED);";
        let sql = build_database_sql_export(BuildDatabaseSqlExportOptions {
            database_name: "shop".to_string(),
            exported_at: Some("2026-07-30T00:00:00.000Z".to_string()),
            tables: vec![ExportedTableSql {
                display_name: "orders".to_string(),
                database_type: Some(DatabaseType::Mysql),
                identifier_quote: None,
                schema: None,
                table_name: Some("orders".to_string()),
                qualified_table_name: None,
                ddl: Some(ddl.to_string()),
                columns: vec![
                    "id".to_string(),
                    "quantity".to_string(),
                    "unit_price".to_string(),
                    "virtual_total".to_string(),
                    "stored_total".to_string(),
                    "created_at".to_string(),
                ],
                column_types: vec![
                    Some("bigint".to_string()),
                    Some("int".to_string()),
                    Some("decimal(10,2)".to_string()),
                    Some("decimal(10,2)".to_string()),
                    Some("decimal(10,2)".to_string()),
                    Some("timestamp".to_string()),
                ],
                column_extras: vec![
                    Some("auto_increment".to_string()),
                    None,
                    None,
                    Some("VIRTUAL GENERATED".to_string()),
                    Some("stored generated".to_string()),
                    Some("DEFAULT_GENERATED".to_string()),
                ],
                spatial_columns: Vec::new(),
                spatial_values: Vec::new(),
                rows: vec![vec![json!(7), json!(2), json!(3.5), json!(7.0), json!(7.0), json!("2026-07-30 08:00:00")]],
                truncated: false,
            }],
            row_limit_per_table: Some(DATABASE_EXPORT_ROW_LIMIT),
            insert_batch_size: Some(DATABASE_EXPORT_INSERT_BATCH_SIZE),
            insert_dialect: SqlInsertDialect::Source,
            connection_id: None,
            database: None,
            schema: None,
            omit_auto_increment: false,
            preserve_original_language: false,
        })
        .unwrap();

        assert!(sql.contains(ddl));
        assert!(sql.contains(
            "INSERT INTO `orders` (`id`, `quantity`, `unit_price`, `created_at`) VALUES (7, 2, 3.5, '2026-07-30 08:00:00');"
        ));
        assert!(!sql.contains("INSERT INTO `orders` (`id`, `quantity`, `unit_price`, `virtual_total`"));
    }

    #[test]
    fn mysql_database_export_file_rows_omit_generated_columns() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("orders.sql");
        let mut file = std::fs::File::create(&path).unwrap();

        write_database_export_rows(
            &mut file,
            &[vec![json!(7), json!(2), json!(7.0), json!("2026-07-30 08:00:00")]],
            &["id".to_string(), "quantity".to_string(), "virtual_total".to_string(), "created_at".to_string()],
            &[
                Some("bigint".to_string()),
                Some("int".to_string()),
                Some("decimal(10,2)".to_string()),
                Some("timestamp".to_string()),
            ],
            &[
                Some("auto_increment".to_string()),
                None,
                Some("VIRTUAL GENERATED".to_string()),
                Some("DEFAULT_GENERATED".to_string()),
            ],
            "orders",
            "shop",
            &DatabaseType::Mysql,
            SqlInsertDialect::Source,
        )
        .unwrap();
        drop(file);

        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            "INSERT INTO `orders` (`id`, `quantity`, `created_at`) VALUES (7, 2, '2026-07-30 08:00:00');\n\n"
        );
    }

    #[test]
    fn database_row_writer_forwards_the_standard_insert_dialect() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sql");
        let mut file = std::fs::File::create(&path).unwrap();

        write_database_export_rows(
            &mut file,
            &[vec![json!(true), json!(r"C:\exports\O'Hara")]],
            &["enabled".to_string(), "path".to_string()],
            &[Some("bit".to_string()), Some("nvarchar(255)".to_string())],
            &[None, None],
            "event]log",
            "dbo",
            &DatabaseType::SqlServer,
            SqlInsertDialect::Standard,
        )
        .unwrap();
        drop(file);

        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            "INSERT INTO \"dbo\".\"event]log\" (\"enabled\", \"path\") VALUES (TRUE, 'C:\\exports\\O''Hara');\n\n"
        );
    }

    #[test]
    fn database_row_writer_supports_one_insert_statement_per_row() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("users.sql");
        let mut file = std::fs::File::create(&path).unwrap();

        write_database_export_rows_with_mode(
            &mut file,
            &[vec![json!(1), json!("Ada")], vec![json!(2), json!("Linus")]],
            &["id".to_string(), "name".to_string()],
            &[Some("int".to_string()), Some("varchar(32)".to_string())],
            &[None, None],
            "users",
            "app",
            &DatabaseType::Mysql,
            SqlInsertDialect::Source,
            SqlInsertMode::Single,
            false,
        )
        .unwrap();
        drop(file);

        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            "INSERT INTO `users` (`id`, `name`) VALUES (1, 'Ada');\n\nINSERT INTO `users` (`id`, `name`) VALUES (2, 'Linus');\n\n"
        );
    }

    #[test]
    fn split_zip_export_writer_splits_across_insert_batches_into_valid_sql() {
        let directory = tempfile::tempdir().unwrap();
        let zip_path = directory.path().join("orders.zip");
        let mut writer = crate::export_split_zip::SplitZipExportWriter::create(
            &zip_path,
            crate::export_split_zip::MIN_SPLIT_PART_MAX_MB,
            "orders",
            "sql",
        )
        .unwrap();

        // Each call is one full INSERT batch statement, exactly like the real
        // write_database_export_rows call sites -- the writer must only cut
        // between these calls, never inside one.
        let long_value = "x".repeat(200_000);
        for row_index in 0..20 {
            write_database_export_rows(
                &mut writer,
                &[vec![json!(row_index), json!(long_value.clone())]],
                &["id".to_string(), "payload".to_string()],
                &[Some("bigint".to_string()), Some("text".to_string())],
                &[None, None],
                "orders",
                "shop",
                &DatabaseType::Postgres,
                SqlInsertDialect::Source,
            )
            .unwrap();
        }
        writer.finish("orders.sql").unwrap();

        let file = std::fs::File::open(&zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut sql_parts = Vec::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            if !entry.name().ends_with(".sql") {
                continue;
            }
            let mut contents = String::new();
            entry.read_to_string(&mut contents).unwrap();
            sql_parts.push((entry.name().to_string(), contents));
        }
        sql_parts.sort_by(|a, b| a.0.cmp(&b.0));

        assert!(
            sql_parts.len() > 1,
            "expected the large export to be split into multiple parts, got {}",
            sql_parts.len()
        );
        for (name, contents) in &sql_parts {
            assert!(!contents.is_empty(), "{name} must not be empty");
            // Every non-blank line must be a syntactically complete INSERT
            // statement -- proof that no cut landed inside one.
            for line in contents.lines().filter(|line| !line.trim().is_empty()) {
                assert!(
                    line.trim_start().starts_with("INSERT INTO") && line.trim_end().ends_with(';'),
                    "{name} has a malformed line from a mid-statement cut: {line}"
                );
            }
        }
        // Reassembling every part in order must reproduce all 20 rows.
        let combined: String = sql_parts.iter().map(|(_, contents)| contents.as_str()).collect();
        assert_eq!(combined.matches("INSERT INTO").count(), 20);
    }

    #[test]
    fn split_zip_export_writer_keeps_an_oversized_create_table_ddl_whole_before_the_next_unit() {
        // Exercises the "SQL unit, not just INSERT" contract: a CREATE TABLE
        // DDL statement, an INSERT, and a SQL Server-style multi-statement
        // routine body must each land in exactly one part, never split at an
        // arbitrary byte offset inside one, even when writeln! formats the
        // unit from several interpolated arguments (real call sites do this,
        // e.g. `writeln!(file, "{source}\n")` for exported routine bodies).
        let directory = tempfile::tempdir().unwrap();
        let zip_path = directory.path().join("schema.zip");
        let mut writer = crate::export_split_zip::SplitZipExportWriter::create(
            &zip_path,
            crate::export_split_zip::MIN_SPLIT_PART_MAX_MB,
            "schema",
            "sql",
        )
        .unwrap();

        let table_name = "dbo.orders";
        // part_max_bytes for MIN_SPLIT_PART_MAX_MB is 1 MiB. Make the CREATE
        // TABLE unit alone exceed that -- it stays whole as the oversized-unit
        // exception, but the *next* unit must then rotate into a new part.
        let columns = (0..100_000).map(|index| format!("col_{index} INT")).collect::<Vec<_>>().join(", ");
        let create_table_ddl = format!("CREATE TABLE {table_name} ({columns});");
        // A SQL Server routine body: multiple statements inside one BEGIN/END
        // block plus a batch-separator comment, matching what
        // build_export_object_source_sql emits for a procedure/trigger --
        // the writer must never cut between the inner statements.
        let procedure_source = "CREATE PROCEDURE dbo.recalc_totals AS\nBEGIN\n  UPDATE dbo.orders SET total = total + 1;\n  INSERT INTO dbo.audit_log (message) VALUES ('recalculated');\nEND".to_string();
        let go_batch_separator = "GO";
        let insert = "INSERT INTO dbo.orders (id) VALUES (1);".to_string();

        writeln!(writer, "{create_table_ddl}").unwrap();
        writeln!(writer, "{procedure_source}").unwrap();
        writeln!(writer, "{go_batch_separator}").unwrap();
        writeln!(writer, "{insert}").unwrap();
        writer.finish("schema.sql").unwrap();

        let file = std::fs::File::open(&zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut sql_parts = Vec::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            if !entry.name().ends_with(".sql") {
                continue;
            }
            let mut contents = String::new();
            entry.read_to_string(&mut contents).unwrap();
            sql_parts.push((entry.name().to_string(), contents));
        }
        sql_parts.sort_by(|a, b| a.0.cmp(&b.0));

        assert!(sql_parts.len() >= 2, "the oversized CREATE TABLE alone must rotate before later units");

        let combined: String = sql_parts.iter().map(|(_, contents)| contents.as_str()).collect();
        assert_eq!(
            combined,
            format!("{create_table_ddl}\n{procedure_source}\n{go_batch_separator}\n{insert}\n"),
            "reassembling every part must reproduce the original stream byte for byte"
        );

        // Every unit must be found intact inside exactly one part -- proof
        // that none of them was fragmented across a rotation boundary.
        for unit in [create_table_ddl.as_str(), procedure_source.as_str(), go_batch_separator, insert.as_str()] {
            let containing_parts = sql_parts.iter().filter(|(_, contents)| contents.contains(unit)).count();
            assert_eq!(containing_parts, 1, "unit must appear whole in exactly one part: {unit:?}");
        }
    }

    #[test]
    fn all_schemas_combine_keeps_split_part_boundaries_statement_safe() {
        // Mirror of the per-schema temporary files that
        // `export_postgres_all_schemas_sql_core` combines: whole SQL
        // statements, one per line, each newline-terminated.
        let directory = tempfile::tempdir().unwrap();
        let schema_path = directory.path().join("schema-0.sql");
        let long_value = "x".repeat(200_000);
        let mut schema_sql = String::new();
        for row_index in 0..20 {
            schema_sql.push_str(&format!("INSERT INTO orders VALUES ({row_index}, '{long_value}');\n"));
        }
        std::fs::write(&schema_path, &schema_sql).unwrap();

        let zip_path = directory.path().join("combined.zip");
        let mut writer = crate::export_split_zip::SplitZipExportWriter::create(
            &zip_path,
            crate::export_split_zip::MIN_SPLIT_PART_MAX_MB,
            "combined",
            "sql",
        )
        .unwrap();
        let mut source = std::io::BufReader::new(std::fs::File::open(&schema_path).unwrap());
        combine_schema_sql_export(&mut source, &mut writer).unwrap();
        writer.finish("combined.sql").unwrap();

        let file = std::fs::File::open(&zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut sql_parts = Vec::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            if !entry.name().ends_with(".sql") {
                continue;
            }
            let mut contents = String::new();
            entry.read_to_string(&mut contents).unwrap();
            sql_parts.push((entry.name().to_string(), contents));
        }
        sql_parts.sort_by(|a, b| a.0.cmp(&b.0));

        assert!(
            sql_parts.len() > 1,
            "expected the combined export to be split into multiple parts, got {}",
            sql_parts.len()
        );
        for (name, contents) in &sql_parts {
            assert!(!contents.is_empty(), "{name} must not be empty");
            // Every non-blank line must be a complete statement -- proof that
            // the copy never cut inside one.
            for line in contents.lines().filter(|line| !line.trim().is_empty()) {
                assert!(
                    line.trim_start().starts_with("INSERT INTO") && line.trim_end().ends_with(';'),
                    "{name} has a malformed line from a mid-statement cut: {line:?}"
                );
            }
        }
        // Reassembling the parts in order must reproduce the temporary file
        // byte for byte: the line-by-line copy adds, drops, and alters
        // nothing, including the trailing newline.
        let combined: String = sql_parts.iter().map(|(_, contents)| contents.as_str()).collect();
        assert_eq!(combined, schema_sql);
        assert_eq!(combined.matches("INSERT INTO").count(), 20);
    }

    #[test]
    fn postgres_identity_export_preserves_explicit_values_in_each_batch() {
        for (extra, overrides) in [
            (Some("generated always as identity (start with 1 increment by 1)"), true),
            (Some(" GENERATED\tALWAYS  AS IDENTITY "), true),
            (Some("generated by default as identity"), false),
            (Some("serial"), false),
            (None, false),
        ] {
            for dialect in ["source", "standard"] {
                for (batch_size, tuples) in [
                    (1, vec!["(1, 'Ada');", "(2, 'Grace');", "(3, 'Hopper');"]),
                    (2, vec!["(1, 'Ada'),\n(2, 'Grace');", "(3, 'Hopper');"]),
                    (10, vec!["(1, 'Ada'),\n(2, 'Grace'),\n(3, 'Hopper');"]),
                ] {
                    let options = serde_json::from_value(json!({
                        "databaseType": "postgres", "schema": "public", "tableName": "users",
                        "columns": ["id", "name"], "columnTypes": ["integer", "text"],
                        "columnExtras": [extra, null], "rows": [[1, "Ada"], [2, "Grace"], [3, "Hopper"]],
                        "batchSize": batch_size, "insertDialect": dialect
                    }))
                    .unwrap();
                    let sql = build_export_sql_insert(options).unwrap();
                    let overriding = if overrides { " OVERRIDING SYSTEM VALUE" } else { "" };
                    let head = format!("INSERT INTO \"public\".\"users\" (\"id\", \"name\"){overriding} VALUES");
                    let expected = tuples
                        .iter()
                        .map(|tuple| format!("{head}{}{tuple}", if tuple.contains('\n') { "\n" } else { " " }))
                        .collect::<Vec<_>>()
                        .join("\n");
                    assert_eq!(sql, expected, "extra={extra:?}, dialect={dialect}, batch={batch_size}");
                }
            }
        }
    }

    #[test]
    fn postgres_identity_export_does_not_override_excluded_identity_columns() {
        let options = serde_json::from_value(json!({
            "databaseType": "postgres", "schema": "public", "tableName": "users",
            "columns": ["id", "name"], "columnExtras": ["generated always as identity", null],
            "rows": [[42, "Ada"]], "excludeColumns": ["ID"]
        }))
        .unwrap();
        assert_eq!(
            build_export_sql_insert(options).unwrap(),
            "INSERT INTO \"public\".\"users\" (\"name\") VALUES ('Ada');"
        );
    }

    #[test]
    fn dameng_identity_export_inserts_enable_identity_insert() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Dameng),
            identifier_quote: None,
            schema: Some("SYSDBA".to_string()),
            table_name: Some("USERS".to_string()),
            qualified_table_name: None,
            columns: vec!["ID".to_string(), "NAME".to_string()],
            column_types: vec![Some("INT".to_string()), Some("VARCHAR(20)".to_string())],
            column_extras: vec![Some("identity".to_string()), None],
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!(1), json!("Ada")]],
            batch_size: Some(10),
            preserve_original_language: false,
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
    fn sqlserver_identity_export_inserts_enable_identity_insert() {
        // The SQL Server column metadata reports `identity(seed,increment)`;
        // explicit values for such columns are rejected with error 544 unless
        // the INSERT is wrapped in SET IDENTITY_INSERT.
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::SqlServer),
            identifier_quote: None,
            schema: Some("dbo".to_string()),
            table_name: Some("events".to_string()),
            qualified_table_name: None,
            columns: vec!["id".to_string(), "name".to_string()],
            column_types: vec![Some("int".to_string()), Some("nvarchar(50)".to_string())],
            column_extras: vec![Some("identity(1,1)".to_string()), None],
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!(1), json!("Ada")]],
            batch_size: Some(10),
            preserve_original_language: false,
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![
                "SET IDENTITY_INSERT [dbo].[events] ON;\nINSERT INTO [dbo].[events] ([id], [name]) VALUES (1, N'Ada');\nSET IDENTITY_INSERT [dbo].[events] OFF;"
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
                identifier_quote: None,
                schema: None,
                table_name: Some("users".to_string()),
                qualified_table_name: None,
                ddl: Some("CREATE TABLE `users` (`id` int);".to_string()),
                columns: vec!["id".to_string()],
                column_types: Vec::new(),
                column_extras: Vec::new(),
                spatial_columns: Vec::new(),
                spatial_values: Vec::new(),
                rows: vec![vec![json!(1)]],
                truncated: true,
            }],
            row_limit_per_table: Some(DATABASE_EXPORT_ROW_LIMIT),
            insert_batch_size: Some(DATABASE_EXPORT_INSERT_BATCH_SIZE),
            insert_dialect: SqlInsertDialect::Source,
            connection_id: None,
            database: None,
            schema: None,
            omit_auto_increment: false,
            preserve_original_language: false,
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
    fn opengauss_export_escapes_single_quotes_in_comment_ddl() {
        let ddl = concat!(
            "CREATE TABLE \"public\".\"dbx_issue_comment\" (\"flag\" varchar(8));\n",
            "COMMENT ON COLUMN \"public\".\"dbx_issue_comment\".\"flag\" IS '逻辑删除标志：'0'-未删除，'1'-已删除';"
        );

        assert_eq!(
            format_export_table_ddl(ddl, Some(DatabaseType::OpenGauss), DdlNormalizeOptions::default()),
            concat!(
                "CREATE TABLE \"public\".\"dbx_issue_comment\" (\"flag\" varchar(8));\n",
                "COMMENT ON COLUMN \"public\".\"dbx_issue_comment\".\"flag\" IS '逻辑删除标志：''0''-未删除，''1''-已删除';"
            )
        );
    }

    #[test]
    fn opengauss_export_leaves_other_literals_and_valid_comments_unchanged() {
        let ddl = concat!(
            "CREATE TABLE \"public\".\"notes\" (\"body\" text DEFAULT 'O''Hara');\n",
            "COMMENT ON COLUMN \"public\".\"notes\".\"body\" IS 'owner''s note';"
        );

        assert_eq!(format_export_table_ddl(ddl, Some(DatabaseType::OpenGauss), DdlNormalizeOptions::default()), ddl);
    }

    #[test]
    fn table_ddl_export_has_one_statement_terminator() {
        let ddl = "CREATE TABLE `users` (`id` int);;\n";

        assert_eq!(
            format_export_table_ddl(ddl, Some(DatabaseType::Mysql), DdlNormalizeOptions::default()),
            "CREATE TABLE `users` (`id` int);"
        );
        assert_eq!(
            format_export_table_ddl(
                "CREATE TABLE users (id int)",
                Some(DatabaseType::Postgres),
                DdlNormalizeOptions::default(),
            ),
            "CREATE TABLE users (id int);"
        );
    }

    #[test]
    fn omitted_auto_increment_preserves_mysql_line_comment_boundaries() {
        let options = DdlNormalizeOptions { omit_auto_increment: true };

        assert_eq!(
            format_export_table_ddl(
                "CREATE TABLE `users` (`id` int) ENGINE=InnoDB -- keep this comment\nAUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4",
                Some(DatabaseType::Mysql),
                options,
            ),
            "CREATE TABLE `users` (`id` int) ENGINE=InnoDB -- keep this comment\n DEFAULT CHARSET=utf8mb4;"
        );
        assert_eq!(
            format_export_table_ddl(
                "CREATE TABLE `users` (`id` int) ENGINE=InnoDB # keep this comment\r\nAUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4",
                Some(DatabaseType::Mysql),
                options,
            ),
            "CREATE TABLE `users` (`id` int) ENGINE=InnoDB # keep this comment\r\n DEFAULT CHARSET=utf8mb4;"
        );
    }

    #[test]
    fn omitted_auto_increment_consumes_only_horizontal_separator_whitespace() {
        let options = DdlNormalizeOptions { omit_auto_increment: true };

        for separator in [" ", "\t"] {
            let ddl = format!(
                "CREATE TABLE `users` (`id` int) ENGINE=InnoDB{separator}AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4"
            );
            assert_eq!(
                format_export_table_ddl(&ddl, Some(DatabaseType::Mysql), options),
                "CREATE TABLE `users` (`id` int) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;"
            );
        }
    }

    #[test]
    fn normalizes_legacy_mysql_row_format_for_export_compatibility() {
        let ddl = "CREATE TABLE `wide_table` (\n  `payload` varchar(4096) DEFAULT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8 ROW_FORMAT=COMPACT";

        let normalized = normalize_export_table_ddl(ddl, Some(DatabaseType::Mysql), DdlNormalizeOptions::default());

        assert_eq!(
            normalized,
            "CREATE TABLE `wide_table` (\n  `payload` varchar(4096) DEFAULT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8 ROW_FORMAT=DYNAMIC"
        );
    }

    #[test]
    fn normalizes_lowercase_redundant_mysql_row_format_for_export_compatibility() {
        let ddl = "CREATE TABLE `wide_table` (`payload` varchar(4096)) engine=InnoDB row_format = redundant";

        let normalized = normalize_export_table_ddl(ddl, Some(DatabaseType::Mysql), DdlNormalizeOptions::default());

        assert_eq!(normalized, "CREATE TABLE `wide_table` (`payload` varchar(4096)) engine=InnoDB ROW_FORMAT=DYNAMIC");
    }

    #[test]
    fn preserves_non_legacy_or_non_mysql_row_formats() {
        let mysql_ddl = "CREATE TABLE `ok` (`payload` text) ENGINE=InnoDB ROW_FORMAT=COMPRESSED";
        let postgres_ddl = "CREATE TABLE users (payload text) ROW_FORMAT=COMPACT";

        assert_eq!(
            normalize_export_table_ddl(mysql_ddl, Some(DatabaseType::Mysql), DdlNormalizeOptions::default()),
            mysql_ddl
        );
        assert_eq!(
            normalize_export_table_ddl(postgres_ddl, Some(DatabaseType::Postgres), DdlNormalizeOptions::default()),
            postgres_ddl
        );
    }

    #[test]
    fn postgres_export_sequence_sql_tiers_skip_pg10_only_catalogs() {
        // PostgreSQL 10 added `pg_sequence`; PostgreSQL 9.x rejects the whole
        // query, which used to abort the structure export (#10079).
        assert!(POSTGRES_EXPORT_SEQUENCES_SQL.contains("pg_sequence"));
        assert!(!POSTGRES_EXPORT_SEQUENCES_COMPAT_SQL.contains("pg_sequence"));
        assert!(!POSTGRES_EXPORT_SEQUENCES_COMPAT_SQL.contains("pg_sequence_last_value"));

        // Both tiers must describe the same eleven columns in the same order so
        // the row decoding below stays identical.
        for sql in [POSTGRES_EXPORT_SEQUENCES_SQL, POSTGRES_EXPORT_SEQUENCES_COMPAT_SQL] {
            for fragment in [
                "SELECT c.relname",
                "'bigint'",
                "t.relname",
                "a.attname",
                "WHERE c.relkind = 'S' AND n.nspname = $1",
                "ORDER BY c.relname",
            ] {
                assert!(sql.contains(fragment), "missing {fragment} in {sql}");
            }
        }
        // The compat tier substitutes literals for the pg_sequence columns.
        for fallback in ["'1'", "'9223372036854775807'", "false"] {
            assert!(POSTGRES_EXPORT_SEQUENCES_COMPAT_SQL.contains(fallback));
        }
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
            created_by_table: false,
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
            generate_postgres_sequence_post_table_ddl(&sequence, "public").as_deref(),
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
    fn postgres_table_generated_sequence_restores_the_table_bound_sequence() {
        let mut sequence = postgres_sequence("renamed_identity_sequence");
        sequence.created_by_table = true;
        let ddl = generate_postgres_sequence_post_table_ddl(&sequence, "public").unwrap();
        assert!(ddl.starts_with("DO "));
        assert!(ddl.contains("ALTER SEQUENCE "));
        assert!(!ddl.contains("OWNED BY"));
        assert_eq!(
            generate_postgres_sequence_setval_sql(&sequence, "public").as_deref(),
            Some("SELECT setval(pg_get_serial_sequence('\"public\".\"permissions\"', 'id'), GREATEST(COALESCE(MAX(\"id\"), 42), 42), true) FROM \"public\".\"permissions\"")
        );
    }

    #[test]
    fn strict_exports_return_object_errors_instead_of_writing_error_comments() {
        let path = std::env::temp_dir().join(format!("dbx-strict-export-{}.sql", uuid::Uuid::new_v4()));
        let mut file = std::fs::File::create(&path).unwrap();

        let mut lenient_errors = LenientExportErrors::default();
        let result = record_export_error(
            &mut file,
            true,
            "exporting table users: permission denied".to_string(),
            &mut lenient_errors,
        );
        drop(file);

        assert_eq!(result.unwrap_err(), "exporting table users: permission denied");
        assert_eq!(lenient_errors.count, 0);
        assert!(std::fs::read_to_string(&path).unwrap().is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn lenient_export_errors_track_count_and_first_failure_for_terminal_progress() {
        let path = std::env::temp_dir().join(format!("dbx-lenient-export-{}.sql", uuid::Uuid::new_v4()));
        let mut file = std::fs::File::create(&path).unwrap();

        let mut lenient_errors = LenientExportErrors::default();
        record_export_error(
            &mut file,
            false,
            "exporting table orders: RPC call timed out".to_string(),
            &mut lenient_errors,
        )
        .unwrap();
        record_export_error(
            &mut file,
            false,
            "exporting view active_users: RPC call timed out".to_string(),
            &mut lenient_errors,
        )
        .unwrap();
        drop(file);

        // The terminal Done progress must carry enough information to warn
        // instead of reporting plain success (#8184).
        assert_eq!(lenient_errors.count, 2);
        assert_eq!(lenient_errors.first.as_deref(), Some("exporting table orders: RPC call timed out"));
        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.contains("-- ERROR exporting table orders: RPC call timed out"));
        assert!(contents.contains("-- ERROR exporting view active_users: RPC call timed out"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn export_progress_deserializes_events_without_lenient_error_fields() {
        // Progress events persisted by older versions lack errorCount /
        // errorSummary; they must keep deserializing with zeroed defaults.
        let legacy = serde_json::from_value::<ExportProgress>(serde_json::json!({
            "exportId": "export-1",
            "currentObject": "users",
            "objectIndex": 3,
            "totalObjects": 10,
            "rowsExported": 120,
            "totalRows": null,
            "status": "Done",
            "error": null
        }))
        .unwrap();

        assert_eq!(legacy.error_count, 0);
        assert_eq!(legacy.error_summary, None);
    }

    async fn test_app_state(scratch_dir: &std::path::Path) -> AppState {
        let storage = crate::persistence::test_storage::open(&scratch_dir.join("storage.db")).await.unwrap();
        AppState::new_with_plugin_and_agent_dir_and_app_version(
            storage,
            scratch_dir.join("plugins"),
            scratch_dir.join("agents"),
            env!("CARGO_PKG_VERSION"),
        )
    }

    // Regression tests for #6327: create_dir_all on every export run is unsafe
    // when the destination is on a removable/network drive, because a mount
    // that is temporarily gone at write time would be silently recreated on
    // the local root filesystem, and the backup would "succeed" while writing
    // to the wrong disk.

    #[tokio::test]
    async fn ensure_export_destination_dir_creates_a_never_before_seen_local_directory() {
        let scratch = std::env::temp_dir().join(format!("dbx-export-dest-new-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&scratch).unwrap();
        let state = test_app_state(&scratch).await;

        let destination = scratch.join("backups").join("mydb");
        assert!(!destination.exists());

        ensure_export_destination_dir(&state, &destination)
            .await
            .expect("first-time local directory should be created");
        assert!(destination.is_dir());

        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[tokio::test]
    async fn ensure_export_destination_dir_refuses_to_recreate_a_destination_that_disappeared() {
        let scratch = std::env::temp_dir().join(format!("dbx-export-dest-vanished-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&scratch).unwrap();
        let state = test_app_state(&scratch).await;

        // Simulates a previously configured, already-used backup destination
        // (e.g. on an external or network drive) by successfully exporting to
        // it once first.
        let destination = scratch.join("mounted-drive").join("mydb");
        ensure_export_destination_dir(&state, &destination).await.expect("initial export should create the directory");
        assert!(destination.is_dir());

        // Simulates the mount disappearing (unplugged drive, unmounted share,
        // etc.) before the next run.
        std::fs::remove_dir_all(scratch.join("mounted-drive")).unwrap();
        assert!(!destination.exists());

        let result = ensure_export_destination_dir(&state, &destination).await;

        assert!(result.is_err(), "a destination that existed before should not be silently recreated");
        assert!(!destination.exists(), "the backup directory must not be resurrected on the wrong filesystem");

        let _ = std::fs::remove_dir_all(&scratch);
    }

    // Regression test for review feedback on #6327: `ensure_export_destination_dir`
    // only remembered a destination *after* a successful export, so a mount
    // that was present when a schedule was configured but vanished before its
    // very first run looked identical to a brand-new local folder (no
    // recorded state either way) and got silently recreated on the local
    // disk. `record_export_destination_identity` closes that gap by letting
    // the schedule-configuration flow record the destination eagerly.
    #[tokio::test]
    async fn record_export_destination_identity_protects_a_mount_that_vanishes_before_its_first_run() {
        let scratch = std::env::temp_dir().join(format!("dbx-export-dest-eager-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&scratch).unwrap();
        let state = test_app_state(&scratch).await;

        // Simulates the user picking an already-mounted external/network
        // drive in the schedule editor and saving the schedule -- the
        // directory exists at configuration time, but no export has run yet.
        let destination = scratch.join("mounted-drive").join("mydb");
        std::fs::create_dir_all(&destination).unwrap();
        record_export_destination_identity(&state, &destination)
            .await
            .expect("configuring the schedule should succeed");

        // The mount disappears before the scheduler ever runs this schedule
        // for the first time.
        std::fs::remove_dir_all(scratch.join("mounted-drive")).unwrap();
        assert!(!destination.exists());

        let result = ensure_export_destination_dir(&state, &destination).await;

        assert!(result.is_err(), "a mount that was recorded at configuration time must not be silently recreated");
        assert!(!destination.exists(), "the backup directory must not be resurrected on the wrong filesystem");

        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[tokio::test]
    async fn ensure_export_destination_dir_refuses_a_new_child_when_its_recorded_parent_is_missing() {
        let scratch = std::env::temp_dir().join(format!("dbx-export-dest-child-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&scratch).unwrap();
        let state = test_app_state(&scratch).await;

        let destination = scratch.join("mounted-drive").join("backups");
        std::fs::create_dir_all(&destination).unwrap();
        record_export_destination_identity(&state, &destination)
            .await
            .expect("the configured root should be recorded before scheduled runs begin");

        std::fs::remove_dir_all(scratch.join("mounted-drive")).unwrap();
        let run_directory = destination.join("dbx-backup__nightly__20260908-220000__12345678");

        let result = ensure_export_destination_dir(&state, &run_directory).await;

        assert!(result.is_err(), "a unique run directory must not recreate a missing configured parent");
        assert!(!run_directory.exists(), "the run directory must not be created on the local filesystem");

        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[tokio::test]
    async fn record_export_destination_identity_rejects_a_directory_that_disappeared_before_save() {
        let scratch = std::env::temp_dir().join(format!("dbx-export-dest-eager-new-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&scratch).unwrap();
        let state = test_app_state(&scratch).await;

        // The schedule editor only accepts an existing directory. If that
        // directory disappears before the save request reaches the backend,
        // the schedule must not be persisted without a recorded identity.
        let destination = scratch.join("backups").join("mydb");
        assert!(!destination.exists());
        let error = record_export_destination_identity(&state, &destination)
            .await
            .expect_err("a missing scheduled destination must be rejected");

        assert!(error.contains("does not exist or is not a directory"));
        assert!(!destination.exists());

        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[cfg(any(unix, windows))]
    #[tokio::test]
    async fn ensure_export_destination_dir_refuses_a_changed_recorded_identity() {
        let scratch = std::env::temp_dir().join(format!("dbx-export-dest-changed-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&scratch).unwrap();
        let state = test_app_state(&scratch).await;
        let destination = scratch.join("backups");
        std::fs::create_dir_all(&destination).unwrap();

        let current = super::export_destination_identity_for_path(&destination)
            .expect("the platform should identify a local export destination");
        let different = match current {
            super::ExportDestinationIdentity::Device(device) => {
                super::ExportDestinationIdentity::Device(device.wrapping_add(1))
            }
            super::ExportDestinationIdentity::PersistentVolumeUuid(mut uuid) => {
                uuid[0] ^= 0xff;
                super::ExportDestinationIdentity::PersistentVolumeUuid(uuid)
            }
            super::ExportDestinationIdentity::LegacyDevice(_) => {
                unreachable!("freshly resolved identities are never legacy values")
            }
        };
        state
            .storage
            .save_state(
                &super::export_destination_state_key(&destination),
                &different.encode(),
                "application/octet-stream",
            )
            .await
            .unwrap();

        let error = ensure_export_destination_dir(&state, &destination)
            .await
            .expect_err("an unattended export must reject a changed persistent destination identity");

        assert!(error.contains("different filesystem"));
        let _ = std::fs::remove_dir_all(&scratch);
    }

    // Regression test for review feedback on #6327: the directory identity
    // check and the later `File::create` are separate operations, so the
    // mount can disappear and be replaced by something else at the same path
    // in between. `export_destination_identity_mismatch` is the comparison
    // `export_database_sql_core` runs against the handle it actually opened;
    // exercised directly here since reproducing a real cross-filesystem swap
    // mid-write is not something a portable unit test can simulate.
    #[test]
    fn export_destination_identity_mismatch_detects_a_changed_device() {
        let device_one = super::ExportDestinationIdentity::Device(1);
        let same_device = super::ExportDestinationIdentity::Device(1);
        let device_two = super::ExportDestinationIdentity::Device(2);
        assert!(export_destination_identity_mismatch(Some(&device_one), Some(&device_two)));
        assert!(!export_destination_identity_mismatch(Some(&device_one), Some(&same_device)));
        assert!(
            !export_destination_identity_mismatch(None, Some(&device_two)),
            "an unknown expected device has nothing to compare against"
        );
        assert!(
            export_destination_identity_mismatch(Some(&device_one), None),
            "an opened file with unknown identity must not bypass a known expected device"
        );
        assert!(!export_destination_identity_mismatch(None, None));
    }

    #[test]
    fn export_destination_identity_encoding_distinguishes_legacy_devices_and_volume_uuids() {
        let device = super::ExportDestinationIdentity::Device(42);
        let uuid = super::ExportDestinationIdentity::PersistentVolumeUuid([7; 16]);

        assert_eq!(
            super::ExportDestinationIdentity::decode(&device.encode()).unwrap(),
            Some(device),
            "new device identities should use the tagged format"
        );
        assert_eq!(
            super::ExportDestinationIdentity::decode(&uuid.encode()).unwrap(),
            Some(uuid),
            "persistent UUID identities should round trip"
        );
        assert_eq!(
            super::ExportDestinationIdentity::decode(&42_u64.to_le_bytes()).unwrap(),
            Some(super::ExportDestinationIdentity::LegacyDevice(42)),
            "existing untagged state must remain recognizable as legacy data"
        );
        assert!(super::ExportDestinationIdentity::decode(b"invalid").is_err());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn explicitly_recording_a_macos_destination_replaces_legacy_device_state() {
        use std::os::unix::fs::MetadataExt;

        let scratch = std::env::temp_dir().join(format!("dbx-export-dest-macos-migration-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&scratch).unwrap();
        let state = test_app_state(&scratch).await;
        let destination = scratch.join("backups");
        std::fs::create_dir_all(&destination).unwrap();

        state
            .storage
            .save_state(
                &super::export_destination_state_key(&destination),
                &std::fs::metadata(&destination).unwrap().dev().to_le_bytes(),
                "application/octet-stream",
            )
            .await
            .unwrap();
        assert!(
            super::export_destination_identity_needs_confirmation(&state, &destination).await.unwrap(),
            "legacy macOS destination state should require explicit confirmation"
        );
        assert!(
            ensure_export_destination_dir(&state, &destination).await.is_err(),
            "an unattended export must not silently replace legacy identity state, even when st_dev still matches"
        );

        record_export_destination_identity(&state, &destination)
            .await
            .expect("explicitly confirming the destination should replace legacy state");
        assert!(
            !super::export_destination_identity_needs_confirmation(&state, &destination).await.unwrap(),
            "persistent volume identity should not require another confirmation"
        );
        ensure_export_destination_dir(&state, &destination)
            .await
            .expect("the confirmed persistent volume identity should match");

        let (encoded, _) =
            state.storage.load_state(&super::export_destination_state_key(&destination)).await.unwrap().unwrap();
        assert!(matches!(
            super::ExportDestinationIdentity::decode(&encoded).unwrap(),
            Some(super::ExportDestinationIdentity::PersistentVolumeUuid(_))
        ));

        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn export_destination_identity_for_path_and_open_file_agree_on_macos() {
        let scratch = std::env::temp_dir().join(format!("dbx-export-dest-macos-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&scratch).unwrap();

        let dir_identity = super::export_destination_identity_for_path(&scratch);
        assert!(
            matches!(dir_identity, Some(super::ExportDestinationIdentity::PersistentVolumeUuid(_))),
            "a local macOS directory should report its persistent volume UUID"
        );

        let file_path = scratch.join("probe.txt");
        let file = std::fs::File::create(&file_path).unwrap();
        let file_identity = super::export_destination_identity_for_file(&file);
        drop(file);

        assert_eq!(
            dir_identity, file_identity,
            "an open file and its parent directory must resolve to the same volume"
        );

        let _ = std::fs::remove_dir_all(&scratch);
    }

    // Regression test for review feedback on #6327: the non-Unix path used
    // to report no device identity at all, so replacing a Windows drive or
    // mount at the same path went undetected. This only runs on native
    // Windows (this repo's CI has no Windows job that executes `cargo test`,
    // only `cargo check`, so it is exercised locally by Windows contributors
    // and by the compile-check itself).
    #[cfg(windows)]
    #[test]
    fn export_destination_device_id_for_path_and_open_file_agree_on_windows() {
        let scratch = std::env::temp_dir().join(format!("dbx-export-dest-win-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&scratch).unwrap();

        let dir_dev = super::export_destination_identity_for_path(&scratch);
        assert!(dir_dev.is_some(), "a real local directory should report a volume serial number");

        let file_path = scratch.join("probe.txt");
        let file = std::fs::File::create(&file_path).unwrap();
        let file_dev = super::export_destination_identity_for_file(&file);
        drop(file);

        assert_eq!(dir_dev, file_dev, "a file and its parent directory must resolve to the same volume");

        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[test]
    fn kingbase_mysql_compat_export_insert_uses_backtick_identifiers() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Kingbase),
            identifier_quote: Some("`".to_string()),
            schema: Some("audit-schema".to_string()),
            table_name: Some("events".to_string()),
            qualified_table_name: None,
            columns: vec!["id".to_string(), "event_type".to_string()],
            column_types: vec![None, None],
            column_extras: vec![None, None],
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows: vec![vec![json!(1), json!("login")]],
            batch_size: Some(100),
            preserve_original_language: false,
        })
        .unwrap();
        assert_eq!(statements, vec!["INSERT INTO `audit-schema`.`events` (`id`, `event_type`) VALUES (1, 'login');"]);
    }
}
