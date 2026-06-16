use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tokio::sync::RwLock;

use crate::connection::{AppState, PoolKind};
use crate::db;
use crate::db::mongo_driver::MongoDocumentResult;
use crate::models::connection::DatabaseType;
use crate::object_source_sql::{build_executable_object_source_statements, EditableObjectSourceSqlInput};
use crate::query::{agent_execute_query_params, QueryExecutionOptions};
#[cfg(feature = "duckdb-bundled")]
use crate::sql::starts_with_executable_sql_keyword;
use crate::sql_dialect::{qualified_transfer_table, quote_transfer_identifier};

static CANCELLED: std::sync::LazyLock<RwLock<HashSet<String>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashSet::new()));

const MAX_TRANSFER_WRITE_SQL_BYTES: usize = 512 * 1024;
const MAX_SQLSERVER_INSERT_ROWS: usize = 1000;
const MAX_ORACLE_MERGE_ROWS: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TransferMode {
    #[default]
    Append,
    Overwrite,
    Upsert,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferRequest {
    pub transfer_id: String,
    pub source_connection_id: String,
    pub source_database: String,
    pub source_schema: String,
    pub target_connection_id: String,
    pub target_database: String,
    pub target_schema: String,
    pub tables: Vec<String>,
    pub create_table: bool,
    #[serde(default)]
    pub mode: TransferMode,
    pub batch_size: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub transfer_id: String,
    pub table: String,
    pub table_index: usize,
    pub total_tables: usize,
    pub rows_transferred: u64,
    pub total_rows: Option<u64>,
    pub status: TransferStatus,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferStatus {
    Running,
    TableDone,
    Done,
    Error,
    Cancelled,
}

pub fn quote_identifier(name: &str, db_type: &DatabaseType) -> String {
    quote_transfer_identifier(name, db_type)
}

pub fn qualified_table(table: &str, schema: &str, db_type: &DatabaseType) -> String {
    qualified_transfer_table(table, schema, db_type)
}

fn quote_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn is_simple_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first == '_' || first.is_ascii_alphabetic()) {
        return false;
    }
    chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn is_postgres_compat_transfer(source_db: &DatabaseType, target_db: &DatabaseType) -> bool {
    matches!(source_db, DatabaseType::Postgres) && matches!(target_db, DatabaseType::Postgres)
}

fn is_postgres_integer_like_type(data_type: &str) -> bool {
    let normalized = data_type.trim().to_ascii_lowercase();
    matches!(
        normalized.split(['(', ' ']).next().unwrap_or(""),
        "smallint" | "integer" | "bigint" | "int2" | "int4" | "int8"
    )
}

fn is_postgres_sequence_default(default_value: Option<&str>) -> bool {
    default_value.is_some_and(|value| value.to_ascii_lowercase().contains("nextval("))
}

fn rewrite_postgres_schema_qualified_references(input: &str, source_schema: &str, target_schema: &str) -> String {
    if source_schema.trim().is_empty() || source_schema == target_schema {
        return input.to_string();
    }

    let quoted_source = format!("{}.", quote_identifier(source_schema, &DatabaseType::Postgres));
    let quoted_target = format!("{}.", quote_identifier(target_schema, &DatabaseType::Postgres));
    let rewritten = input.replace(&quoted_source, &quoted_target);
    let unquoted_pattern =
        Regex::new(&format!(r#"(^|[^"\w]){}\."#, regex::escape(source_schema))).expect("valid postgres schema regex");
    unquoted_pattern
        .replace_all(&rewritten, |captures: &regex::Captures| format!("{}{}", &captures[1], quoted_target))
        .into_owned()
}

fn postgres_column_type_sql(
    column: &db::ColumnInfo,
    source_schema: &str,
    target_schema: &str,
    source_db: &DatabaseType,
    target_db: &DatabaseType,
) -> String {
    if is_postgres_compat_transfer(source_db, target_db) {
        let trimmed = column.data_type.trim();
        if !trimmed.is_empty() {
            return rewrite_postgres_schema_qualified_references(trimmed, source_schema, target_schema);
        }
    }
    map_column_type(&column.data_type, source_db, target_db)
}

fn postgres_default_clause(
    column: &db::ColumnInfo,
    source_schema: &str,
    target_schema: &str,
    source_db: &DatabaseType,
    target_db: &DatabaseType,
) -> Option<String> {
    if !is_postgres_compat_transfer(source_db, target_db) {
        return None;
    }
    let default_value = column.column_default.as_deref()?.trim();
    if default_value.is_empty() {
        return None;
    }
    if is_postgres_sequence_default(Some(default_value)) && is_postgres_integer_like_type(&column.data_type) {
        return Some("GENERATED BY DEFAULT AS IDENTITY".to_string());
    }
    Some(format!(
        "DEFAULT {}",
        rewrite_postgres_schema_qualified_references(default_value, source_schema, target_schema)
    ))
}

fn is_mysql_family_target(target_db: &DatabaseType) -> bool {
    matches!(
        target_db,
        DatabaseType::Mysql
            | DatabaseType::Doris
            | DatabaseType::StarRocks
            | DatabaseType::Goldendb
            | DatabaseType::Sundb
    )
}

fn is_mysql_numeric_base_type(data_type: &str) -> bool {
    let normalized = data_type.trim().to_ascii_lowercase();
    let base = normalized.split(['(', ' ']).next().unwrap_or("");
    matches!(
        base,
        "tinyint"
            | "smallint"
            | "mediumint"
            | "int"
            | "integer"
            | "bigint"
            | "decimal"
            | "numeric"
            | "float"
            | "double"
            | "real"
            | "bit"
            | "year"
    )
}

fn is_mysql_function_default(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.eq_ignore_ascii_case("NULL") {
        return true;
    }
    let upper = trimmed.to_ascii_uppercase();
    if upper == "CURRENT_TIMESTAMP" || upper.starts_with("CURRENT_TIMESTAMP(") {
        return true;
    }
    if upper == "LOCALTIME" || upper.starts_with("LOCALTIME(") {
        return true;
    }
    if upper == "LOCALTIMESTAMP" || upper.starts_with("LOCALTIMESTAMP(") {
        return true;
    }
    matches!(upper.as_str(), "CURRENT_DATE" | "CURRENT_TIME" | "NOW()" | "UTC_TIMESTAMP()" | "UUID()")
}

fn looks_like_numeric_literal(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return false;
    }
    trimmed.parse::<i64>().is_ok() || trimmed.parse::<u64>().is_ok() || trimmed.parse::<f64>().is_ok()
}

fn format_mysql_default_literal(raw: &str, data_type: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.eq_ignore_ascii_case("NULL") {
        return "NULL".to_string();
    }
    if is_mysql_function_default(trimmed) {
        return trimmed.to_string();
    }
    if trimmed.len() >= 2 && trimmed.starts_with('\'') && trimmed.ends_with('\'') {
        return trimmed.to_string();
    }
    if is_mysql_numeric_base_type(data_type) && looks_like_numeric_literal(trimmed) {
        return trimmed.to_string();
    }
    format!("'{}'", trimmed.replace('\'', "''"))
}

fn column_default_clause(
    column: &db::ColumnInfo,
    source_schema: &str,
    target_schema: &str,
    source_db: &DatabaseType,
    target_db: &DatabaseType,
) -> Option<String> {
    if is_postgres_compat_transfer(source_db, target_db) {
        return postgres_default_clause(column, source_schema, target_schema, source_db, target_db);
    }
    if is_mysql_family_target(target_db) {
        let default_value = column.column_default.as_deref()?.trim();
        if default_value.is_empty() {
            return None;
        }
        return Some(format!("DEFAULT {}", format_mysql_default_literal(default_value, &column.data_type)));
    }
    None
}

#[derive(Debug, Default, PartialEq, Eq)]
struct MysqlExtraClauses {
    auto_increment: bool,
    on_update: Option<String>,
}

fn parse_mysql_extra_clauses(extra: Option<&str>) -> MysqlExtraClauses {
    let mut result = MysqlExtraClauses::default();
    let Some(raw) = extra else {
        return result;
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return result;
    }

    let lowered = trimmed.to_ascii_lowercase();
    if lowered.contains("auto_increment") {
        result.auto_increment = true;
    }

    let pattern = Regex::new(r"(?i)\bon\s+update\s+(.+)$").expect("valid mysql on-update regex");
    if let Some(captures) = pattern.captures(trimmed) {
        let raw_expr = captures.get(1).map(|m| m.as_str()).unwrap_or("");
        let cleaned = raw_expr.trim().trim_end_matches([',', ';', ' ']).trim();
        if !cleaned.is_empty() {
            result.on_update = Some(cleaned.to_string());
        }
    }

    result
}

fn postgres_order_by_expression(columns: &[String], db_type: &DatabaseType) -> Option<String> {
    if columns.is_empty() {
        return None;
    }
    Some(columns.iter().map(|column| quote_identifier(column, db_type)).collect::<Vec<_>>().join(", "))
}

fn postgres_index_column_sql(column: &str) -> String {
    if is_simple_identifier(column) {
        quote_identifier(column, &DatabaseType::Postgres)
    } else {
        column.to_string()
    }
}

fn generate_postgres_index_ddl(indexes: &[db::IndexInfo], table: &str, schema: &str) -> Vec<String> {
    let full_table = qualified_table(table, schema, &DatabaseType::Postgres);
    let mut statements = Vec::new();
    for index in indexes.iter().filter(|index| !index.is_primary) {
        if index.name.trim().is_empty() || index.columns.is_empty() {
            continue;
        }
        let unique = if index.is_unique { "UNIQUE " } else { "" };
        let using_clause = index
            .index_type
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| format!(" USING {value}"))
            .unwrap_or_default();
        let columns =
            index.columns.iter().map(|column| postgres_index_column_sql(column)).collect::<Vec<_>>().join(", ");
        let include_clause = index
            .included_columns
            .as_ref()
            .filter(|columns| !columns.is_empty())
            .map(|columns| {
                format!(
                    " INCLUDE ({})",
                    columns
                        .iter()
                        .map(|column| quote_identifier(column, &DatabaseType::Postgres))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            })
            .unwrap_or_default();
        let filter_clause = index
            .filter
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| format!(" WHERE {value}"))
            .unwrap_or_default();
        statements.push(format!(
            "CREATE {unique}INDEX IF NOT EXISTS {} ON {full_table}{using_clause} ({columns}){include_clause}{filter_clause}",
            quote_identifier(&index.name, &DatabaseType::Postgres)
        ));
        if let Some(comment) = index.comment.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
            let qualified_index = if schema.is_empty() {
                quote_identifier(&index.name, &DatabaseType::Postgres)
            } else {
                format!(
                    "{}.{}",
                    quote_identifier(schema, &DatabaseType::Postgres),
                    quote_identifier(&index.name, &DatabaseType::Postgres)
                )
            };
            statements.push(format!("COMMENT ON INDEX {qualified_index} IS {}", quote_string_literal(comment)));
        }
    }
    statements
}

fn generate_postgres_foreign_key_ddl(foreign_keys: &[db::ForeignKeyInfo], table: &str, schema: &str) -> Vec<String> {
    let full_table = qualified_table(table, schema, &DatabaseType::Postgres);
    let mut grouped: HashMap<&str, Vec<&db::ForeignKeyInfo>> = HashMap::new();
    let mut order = Vec::new();

    for foreign_key in foreign_keys {
        if !grouped.contains_key(foreign_key.name.as_str()) {
            order.push(foreign_key.name.as_str());
        }
        grouped.entry(foreign_key.name.as_str()).or_default().push(foreign_key);
    }

    let mut statements = Vec::new();
    for name in order {
        let Some(group) = grouped.get(name) else {
            continue;
        };
        let columns = group
            .iter()
            .map(|foreign_key| quote_identifier(&foreign_key.column, &DatabaseType::Postgres))
            .collect::<Vec<_>>()
            .join(", ");
        let ref_columns = group
            .iter()
            .map(|foreign_key| quote_identifier(&foreign_key.ref_column, &DatabaseType::Postgres))
            .collect::<Vec<_>>()
            .join(", ");
        let referenced_schema = group[0].ref_schema.as_deref().unwrap_or(schema);
        let referenced_table = qualified_table(&group[0].ref_table, referenced_schema, &DatabaseType::Postgres);
        statements.push(format!(
            "ALTER TABLE {full_table} ADD CONSTRAINT {} FOREIGN KEY ({columns}) REFERENCES {referenced_table} ({ref_columns})",
            quote_identifier(name, &DatabaseType::Postgres)
        ));
    }

    statements
}

fn generate_postgres_sequence_sync_sql(columns: &[db::ColumnInfo], table: &str, schema: &str) -> Vec<String> {
    let full_table = qualified_table(table, schema, &DatabaseType::Postgres);
    columns
        .iter()
        .filter(|column| is_postgres_sequence_default(column.column_default.as_deref()))
        .map(|column| {
            let quoted_column = quote_identifier(&column.name, &DatabaseType::Postgres);
            format!(
                "SELECT setval(pg_get_serial_sequence({}, {}), GREATEST(COALESCE(MAX({quoted_column}), 0), 1), MAX({quoted_column}) IS NOT NULL) FROM {full_table}",
                quote_string_literal(&full_table),
                quote_string_literal(&column.name)
            )
        })
        .collect()
}

#[derive(Debug, Clone)]
struct PostgresTriggerSource {
    table_name: String,
    trigger_name: String,
    source: String,
}

#[derive(Debug, Clone)]
struct PostgresExtensionSource {
    extension_name: String,
}

#[derive(Debug, Clone)]
struct PostgresEnumSource {
    type_name: String,
    labels: Vec<String>,
}

#[derive(Debug, Clone)]
struct PostgresDomainSource {
    domain_name: String,
    base_type: String,
    default_value: Option<String>,
    not_null: bool,
    checks: Vec<String>,
}

#[derive(Debug, Clone)]
struct PostgresMaterializedViewSource {
    view_name: String,
    source: String,
}

fn json_string_cell(row: &[serde_json::Value], index: usize) -> Option<String> {
    row.get(index).and_then(|value| value.as_str().map(str::to_string))
}

fn result_rows_to_string_statements(rows: Vec<Vec<serde_json::Value>>) -> Vec<String> {
    rows.into_iter().filter_map(|row| json_string_cell(&row, 0)).filter(|stmt| !stmt.trim().is_empty()).collect()
}

fn ensure_sql_statement_terminated(sql: &str) -> String {
    let trimmed = sql.trim();
    if trimmed.ends_with(';') {
        trimmed.to_string()
    } else {
        format!("{trimmed};")
    }
}

fn generate_postgres_extension_ddl(extension: &PostgresExtensionSource, target_schema: &str) -> String {
    format!(
        "CREATE EXTENSION IF NOT EXISTS {} WITH SCHEMA {}",
        quote_identifier(&extension.extension_name, &DatabaseType::Postgres),
        quote_identifier(target_schema, &DatabaseType::Postgres)
    )
}

fn generate_postgres_enum_ddl(enum_type: &PostgresEnumSource, target_schema: &str) -> String {
    let labels = enum_type.labels.iter().map(|label| quote_string_literal(label)).collect::<Vec<_>>().join(", ");
    let create_sql = format!(
        "CREATE TYPE {}.{} AS ENUM ({labels})",
        quote_identifier(target_schema, &DatabaseType::Postgres),
        quote_identifier(&enum_type.type_name, &DatabaseType::Postgres)
    );
    format!(
        "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = {} AND t.typname = {}) THEN {create_sql}; END IF; END $$",
        quote_string_literal(target_schema),
        quote_string_literal(&enum_type.type_name)
    )
}

fn generate_postgres_domain_ddl(domain: &PostgresDomainSource, target_schema: &str) -> String {
    let mut create_sql = format!(
        "CREATE DOMAIN {}.{} AS {}",
        quote_identifier(target_schema, &DatabaseType::Postgres),
        quote_identifier(&domain.domain_name, &DatabaseType::Postgres),
        domain.base_type
    );
    if let Some(default_value) = domain.default_value.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        create_sql.push_str(&format!(" DEFAULT {default_value}"));
    }
    if domain.not_null {
        create_sql.push_str(" NOT NULL");
    }
    for check in &domain.checks {
        create_sql.push(' ');
        create_sql.push_str(check);
    }
    format!(
        "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = {} AND t.typname = {}) THEN {}; END IF; END $$",
        quote_string_literal(target_schema),
        quote_string_literal(&domain.domain_name),
        create_sql
    )
}

fn generate_postgres_materialized_view_ddls(view: &PostgresMaterializedViewSource, target_schema: &str) -> Vec<String> {
    let qualified_name = qualified_table(&view.view_name, target_schema, &DatabaseType::Postgres);
    vec![
        format!("DROP MATERIALIZED VIEW IF EXISTS {qualified_name}"),
        format!("CREATE MATERIALIZED VIEW {qualified_name} AS\n{}", ensure_sql_statement_terminated(&view.source)),
    ]
}

fn rewrite_postgres_routine_schema(source: &str, target_schema: &str) -> Option<String> {
    let re = Regex::new(
        r#"(?is)^(\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(?:FUNCTION|PROCEDURE)\s+)((?:"(?:""|[^"])+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"(?:""|[^"])+"|[A-Za-z_][\w$]*))?)"#,
    )
    .ok()?;
    let captures = re.captures(source)?;
    let full = captures.get(0)?;
    let prefix = captures.get(1)?.as_str();
    let existing_name = captures.get(2)?.as_str();
    let name_re = Regex::new(r#""(?:""|[^"])+"|[A-Za-z_][\w$]*"#).ok()?;
    let parts = name_re
        .find_iter(existing_name)
        .map(|part| part.as_str().trim().trim_matches('"').replace("\"\"", "\""))
        .collect::<Vec<_>>();
    let name = parts.last()?;
    let replacement = format!(
        "{}.{}",
        quote_identifier(target_schema, &DatabaseType::Postgres),
        quote_identifier(name, &DatabaseType::Postgres)
    );
    Some(format!("{}{}{}{}", &source[..full.start()], prefix, replacement, &source[full.end()..]))
}

fn rewrite_postgres_trigger_table_schema(
    source: &str,
    source_schema: &str,
    table_name: &str,
    target_schema: &str,
) -> String {
    let qualified_target_table = qualified_table(table_name, target_schema, &DatabaseType::Postgres);
    let candidate_patterns = [
        format!(
            " ON {}.{} ",
            quote_identifier(source_schema, &DatabaseType::Postgres),
            quote_identifier(table_name, &DatabaseType::Postgres)
        ),
        format!(" ON {source_schema}.{table_name} "),
        format!(" ON {} ", quote_identifier(table_name, &DatabaseType::Postgres)),
        format!(" ON {table_name} "),
    ];
    for pattern in candidate_patterns {
        if source.contains(&pattern) {
            return source.replacen(&pattern, &format!(" ON {qualified_target_table} "), 1);
        }
    }
    source.to_string()
}

pub fn escape_value(val: &serde_json::Value, db_type: &DatabaseType) -> String {
    escape_value_typed(val, db_type, None)
}

pub fn escape_value_typed(val: &serde_json::Value, db_type: &DatabaseType, column_type: Option<&str>) -> String {
    match val {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::Bool(b) => match db_type {
            DatabaseType::Mysql
            | DatabaseType::Sqlite
            | DatabaseType::DuckDb
            | DatabaseType::Doris
            | DatabaseType::StarRocks => {
                if *b {
                    if column_type.is_some_and(is_mysql_bit_type) {
                        "b'1'".to_string()
                    } else {
                        "1".to_string()
                    }
                } else {
                    if column_type.is_some_and(is_mysql_bit_type) {
                        "b'0'".to_string()
                    } else {
                        "0".to_string()
                    }
                }
            }
            _ => {
                if *b {
                    "TRUE".to_string()
                } else {
                    "FALSE".to_string()
                }
            }
        },
        serde_json::Value::Number(n) => match db_type {
            DatabaseType::Mysql | DatabaseType::Doris | DatabaseType::StarRocks => {
                if column_type.is_some_and(is_mysql_bit_type) {
                    format!("b'{}'", n)
                } else {
                    n.to_string()
                }
            }
            _ => n.to_string(),
        },
        serde_json::Value::String(s) => {
            let escaped = format_literal_string(s, db_type, column_type).replace('\\', "\\\\").replace('\'', "''");
            match db_type {
                DatabaseType::Mysql | DatabaseType::Doris | DatabaseType::StarRocks
                    if column_type.is_some_and(is_mysql_bit_type) =>
                {
                    format!("b'{escaped}'")
                }
                _ => format!("'{escaped}'"),
            }
        }
        serde_json::Value::Array(arr) => match db_type {
            DatabaseType::ClickHouse | DatabaseType::Databend => format_ch_array_sql_literal(arr),
            _ => format_pg_array_sql_literal(arr),
        },
        _ => {
            let s = val.to_string();
            format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''"))
        }
    }
}

fn is_mysql_bit_type(column_type: &str) -> bool {
    let trimmed = column_type.trim();
    let lower = trimmed.to_ascii_lowercase();
    lower == "bit" || lower.starts_with("bit(") || lower.starts_with("bit ")
}

pub fn format_pg_array_sql_literal(arr: &[serde_json::Value]) -> String {
    if arr.is_empty() {
        return "'{}'".to_string();
    }
    let elements: Vec<String> = arr.iter().map(format_pg_array_element).collect();
    let inner = format!("{{{}}}", elements.join(","));
    format!("'{}'", inner.replace('\\', "\\\\").replace('\'', "''"))
}

fn format_pg_array_element(val: &serde_json::Value) -> String {
    match val {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::Array(arr) => {
            if arr.is_empty() {
                return "{}".to_string();
            }
            let elements: Vec<String> = arr.iter().map(format_pg_array_element).collect();
            format!("{{{}}}", elements.join(","))
        }
        serde_json::Value::String(s) => {
            let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
            format!("\"{}\"", escaped)
        }
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => {
            if *b {
                "true".to_string()
            } else {
                "false".to_string()
            }
        }
        serde_json::Value::Object(o) => {
            let json = serde_json::to_string(o).unwrap_or_default();
            let escaped = json.replace('\\', "\\\\").replace('"', "\\\"");
            format!("\"{}\"", escaped)
        }
    }
}

pub fn format_ch_array_sql_literal(arr: &[serde_json::Value]) -> String {
    if arr.is_empty() {
        return "[]".to_string();
    }
    let elements: Vec<String> = arr.iter().map(format_ch_array_element).collect();
    format!("[{}]", elements.join(","))
}

fn format_ch_array_element(val: &serde_json::Value) -> String {
    match val {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::Array(arr) => {
            if arr.is_empty() {
                return "[]".to_string();
            }
            let elements: Vec<String> = arr.iter().map(format_ch_array_element).collect();
            format!("[{}]", elements.join(","))
        }
        serde_json::Value::String(s) => {
            let escaped = s.replace('\\', "\\\\").replace('\'', "''");
            format!("'{}'", escaped)
        }
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => {
            if *b {
                "true".to_string()
            } else {
                "false".to_string()
            }
        }
        serde_json::Value::Object(o) => {
            let json = serde_json::to_string(o).unwrap_or_default();
            format!("'{}'", json.replace('\\', "\\\\").replace('\'', "''"))
        }
    }
}

fn format_literal_string(value: &str, db_type: &DatabaseType, column_type: Option<&str>) -> String {
    if is_mysql_datetime_literal_database(db_type) && column_type.map(is_temporal_column_type).unwrap_or(true) {
        normalize_mysql_temporal_literal(value, column_type).unwrap_or_else(|| value.to_string())
    } else {
        value.to_string()
    }
}

fn is_mysql_datetime_literal_database(db_type: &DatabaseType) -> bool {
    matches!(
        db_type,
        DatabaseType::Mysql
            | DatabaseType::Doris
            | DatabaseType::StarRocks
            | DatabaseType::Goldendb
            | DatabaseType::Sundb
    )
}

fn normalize_mysql_temporal_literal(value: &str, column_type: Option<&str>) -> Option<String> {
    let bytes = value.as_bytes();
    if bytes.len() < 20 || !is_mysql_datetime_base(bytes) {
        return None;
    }

    let rest = &value[19..];
    let (fraction, offset) = if let Some(after_dot) = rest.strip_prefix('.') {
        let digit_count = after_dot.bytes().take_while(|b| b.is_ascii_digit()).count();
        if digit_count == 0 {
            return None;
        }
        let fraction_len = 1 + digit_count;
        (&rest[..fraction_len.min(7)], &rest[fraction_len..])
    } else {
        ("", rest)
    };

    if !is_timezone_suffix(offset) {
        return None;
    }

    match temporal_column_kind(column_type) {
        Some("date") => Some(value[..10].to_string()),
        Some("time") => Some(format!("{}{}", &value[11..19], fraction)),
        _ => Some(format!("{} {}{}", &value[..10], &value[11..19], fraction)),
    }
}

fn is_temporal_column_type(column_type: &str) -> bool {
    temporal_column_kind(Some(column_type)).is_some()
}

fn temporal_column_kind(column_type: Option<&str>) -> Option<&'static str> {
    let base = column_type?.trim().to_ascii_lowercase();
    let base = base.split(['(', ':', ' ']).next().unwrap_or("");
    match base {
        "date" => Some("date"),
        "time" => Some("time"),
        "datetime" | "timestamp" => Some("datetime"),
        _ => None,
    }
}

fn is_mysql_datetime_base(bytes: &[u8]) -> bool {
    matches!(
        bytes,
        [
            y0,
            y1,
            y2,
            y3,
            b'-',
            m0,
            m1,
            b'-',
            d0,
            d1,
            sep,
            h0,
            h1,
            b':',
            min0,
            min1,
            b':',
            s0,
            s1,
            ..
        ] if y0.is_ascii_digit()
            && y1.is_ascii_digit()
            && y2.is_ascii_digit()
            && y3.is_ascii_digit()
            && m0.is_ascii_digit()
            && m1.is_ascii_digit()
            && d0.is_ascii_digit()
            && d1.is_ascii_digit()
            && (*sep == b'T' || *sep == b' ')
            && h0.is_ascii_digit()
            && h1.is_ascii_digit()
            && min0.is_ascii_digit()
            && min1.is_ascii_digit()
            && s0.is_ascii_digit()
            && s1.is_ascii_digit()
    )
}

fn is_timezone_suffix(value: &str) -> bool {
    if value.eq_ignore_ascii_case("z") {
        return true;
    }
    let bytes = value.as_bytes();
    matches!(
        bytes,
        [sign, h0, h1, b':', m0, m1]
            if (*sign == b'+' || *sign == b'-')
                && h0.is_ascii_digit()
                && h1.is_ascii_digit()
                && m0.is_ascii_digit()
                && m1.is_ascii_digit()
    )
}

pub fn map_column_type(source_type: &str, _source_db: &DatabaseType, target_db: &DatabaseType) -> String {
    if _source_db == target_db {
        return source_type.to_string();
    }
    let t = source_type.to_lowercase();
    let mut base = t.split('(').next().unwrap_or(&t).trim();
    // Extract basic type, `bigint unsigned` -> `bigint`
    base = base.split(' ').next().unwrap_or(base).trim();

    if matches!(target_db, DatabaseType::Hive) {
        return match base {
            "tinyint" => "TINYINT".into(),
            "smallint" | "int2" => "SMALLINT".into(),
            "int" | "integer" | "int4" | "mediumint" | "serial" | "smallserial" => "INT".into(),
            "bigint" | "int8" | "bigserial" => "BIGINT".into(),
            "float" | "float4" | "real" => "FLOAT".into(),
            "double" | "double precision" | "float8" => "DOUBLE".into(),
            "decimal" | "numeric" | "number" => {
                if let Some(index) = t.find('(') {
                    format!("DECIMAL{}", &t[index..])
                } else {
                    "DECIMAL".into()
                }
            }
            "bool" | "boolean" | "bit" => "BOOLEAN".into(),
            "date" => "DATE".into(),
            "datetime" | "timestamp" | "timestamptz" | "timestamp with time zone" | "timestamp without time zone" => {
                "TIMESTAMP".into()
            }
            "binary" | "varbinary" | "blob" | "tinyblob" | "mediumblob" | "longblob" | "bytea" | "image" => {
                "BINARY".into()
            }
            _ => "STRING".into(),
        };
    }

    match base {
        "int" | "integer" | "int4" | "mediumint" => match target_db {
            DatabaseType::Postgres => "INTEGER".into(),
            DatabaseType::Mysql => "INT".into(),
            DatabaseType::SqlServer => "INT".into(),
            _ => "INTEGER".into(),
        },
        "bigint" | "int8" => "BIGINT".into(),
        "smallint" | "int2" => "SMALLINT".into(),
        "tinyint" => match target_db {
            DatabaseType::Postgres => "SMALLINT".into(),
            _ => "TINYINT".into(),
        },
        "serial" | "bigserial" | "smallserial" => match target_db {
            DatabaseType::Postgres => source_type.to_uppercase(),
            DatabaseType::Mysql => "BIGINT AUTO_INCREMENT".into(),
            _ => "INTEGER".into(),
        },
        "float" | "float4" | "real" => match target_db {
            DatabaseType::Postgres => "REAL".into(),
            _ => "FLOAT".into(),
        },
        "double" | "double precision" | "float8" => match target_db {
            DatabaseType::Postgres => "DOUBLE PRECISION".into(),
            _ => "DOUBLE".into(),
        },
        "decimal" | "numeric" | "number" => {
            if t.contains('(') {
                match target_db {
                    DatabaseType::Mysql | DatabaseType::Postgres | DatabaseType::SqlServer | DatabaseType::Oracle => {
                        format!("DECIMAL{}", &t[t.find('(').unwrap()..])
                    }
                    _ => "NUMERIC".into(),
                }
            } else {
                "NUMERIC".into()
            }
        }
        "varchar" | "nvarchar" | "character varying" | "varchar2" => {
            if t.contains('(') {
                let len_part = &t[t.find('(').unwrap()..];
                match target_db {
                    DatabaseType::Postgres => format!("VARCHAR{len_part}"),
                    DatabaseType::Mysql => format!("VARCHAR{len_part}"),
                    DatabaseType::SqlServer => format!("NVARCHAR{len_part}"),
                    _ => format!("VARCHAR{len_part}"),
                }
            } else {
                "VARCHAR(255)".into()
            }
        }
        "char" | "nchar" | "character" => {
            if t.contains('(') {
                let len_part = &t[t.find('(').unwrap()..];
                format!("CHAR{len_part}")
            } else {
                "CHAR(1)".into()
            }
        }
        "longtext" => match target_db {
            DatabaseType::Mysql => "LONGTEXT".into(),
            _ => "TEXT".into(),
        },
        "mediumtext" => match target_db {
            DatabaseType::Mysql => "MEDIUMTEXT".into(),
            _ => "TEXT".into(),
        },
        "text" | "tinytext" | "clob" | "ntext" => "TEXT".into(),
        "bool" | "boolean" => match target_db {
            DatabaseType::Mysql => "TINYINT(1)".into(),
            DatabaseType::SqlServer => "BIT".into(),
            _ => "BOOLEAN".into(),
        },
        "date" => "DATE".into(),
        "time" => "TIME".into(),
        "datetime" => match target_db {
            DatabaseType::Postgres => "TIMESTAMP".into(),
            _ => "DATETIME".into(),
        },
        "timestamp" | "timestamptz" | "timestamp with time zone" | "timestamp without time zone" => match target_db {
            DatabaseType::Mysql => "DATETIME".into(),
            DatabaseType::SqlServer => "DATETIME2".into(),
            _ => "TIMESTAMP".into(),
        },
        "longblob" => match target_db {
            DatabaseType::Mysql => "LONGBLOB".into(),
            DatabaseType::Postgres => "BYTEA".into(),
            DatabaseType::SqlServer => "VARBINARY(MAX)".into(),
            _ => "BLOB".into(),
        },
        "mediumblob" => match target_db {
            DatabaseType::Mysql => "MEDIUMBLOB".into(),
            DatabaseType::Postgres => "BYTEA".into(),
            DatabaseType::SqlServer => "VARBINARY(MAX)".into(),
            _ => "BLOB".into(),
        },
        "blob" | "tinyblob" | "binary" | "varbinary" | "image" => match target_db {
            DatabaseType::Postgres => "BYTEA".into(),
            DatabaseType::Mysql => "BLOB".into(),
            DatabaseType::SqlServer => "VARBINARY(MAX)".into(),
            _ => "BLOB".into(),
        },
        "bytea" => match target_db {
            DatabaseType::Postgres => "BYTEA".into(),
            DatabaseType::Mysql => "BLOB".into(),
            _ => "BLOB".into(),
        },
        "json" | "jsonb" => match target_db {
            DatabaseType::Postgres => "JSONB".into(),
            DatabaseType::Mysql => "JSON".into(),
            _ => "TEXT".into(),
        },
        "uuid" => match target_db {
            DatabaseType::Postgres => "UUID".into(),
            _ => "VARCHAR(36)".into(),
        },
        "bit" => match target_db {
            DatabaseType::Postgres => "BOOLEAN".into(),
            _ => "BIT".into(),
        },
        _ => "TEXT".into(),
    }
}

fn mysql_type_needs_key_prefix(mapped_type: &str) -> bool {
    let base = mapped_type.split('(').next().unwrap_or(mapped_type).trim().to_ascii_lowercase();
    matches!(
        base.as_str(),
        "text" | "tinytext" | "mediumtext" | "longtext" | "blob" | "tinyblob" | "mediumblob" | "longblob"
    )
}

fn parse_mysql_row_error(error: &str) -> Option<u64> {
    let error = error.trim();
    let at_row = error.rsplit("at row ").next()?;
    at_row.trim().parse::<u64>().ok()
}

pub fn generate_create_table_ddl(
    columns: &[db::ColumnInfo],
    table: &str,
    source_schema: &str,
    schema: &str,
    target_db: &DatabaseType,
    source_db: &DatabaseType,
    table_comment: Option<&str>,
) -> String {
    let full_table = qualified_table(table, schema, target_db);

    let is_mysql_family = matches!(
        target_db,
        DatabaseType::Mysql
            | DatabaseType::Doris
            | DatabaseType::StarRocks
            | DatabaseType::Goldendb
            | DatabaseType::Sundb
    );

    let mut col_lines = Vec::with_capacity(columns.len());
    for c in columns {
        col_lines.push({
            let mapped_type = postgres_column_type_sql(c, source_schema, schema, source_db, target_db);
            let mut line = format!("  {} {}", quote_identifier(&c.name, target_db), mapped_type);
            if let Some(default_clause) = column_default_clause(c, source_schema, schema, source_db, target_db) {
                line.push(' ');
                line.push_str(&default_clause);
            }
            if !c.is_nullable && !matches!(target_db, DatabaseType::Hive) {
                line.push_str(" NOT NULL");
            }
            if is_mysql_family {
                let extra_clauses = parse_mysql_extra_clauses(c.extra.as_deref());
                if extra_clauses.auto_increment {
                    line.push_str(" AUTO_INCREMENT");
                }
                if let Some(on_update_expr) = extra_clauses.on_update {
                    line.push_str(&format!(" ON UPDATE {on_update_expr}"));
                }
                if let Some(ref comment) = c.comment {
                    let trimmed = comment.trim();
                    if !trimmed.is_empty() {
                        line.push_str(&format!(" COMMENT '{}'", trimmed.replace('\'', "''")));
                    }
                }
            }
            line
        });
    }

    let mut pks = Vec::with_capacity(columns.iter().filter(|c| c.is_primary_key).count());
    if !matches!(target_db, DatabaseType::Hive) {
        for c in columns {
            if c.is_primary_key {
                let qname = quote_identifier(&c.name, target_db);
                if is_mysql_family {
                    let mapped = map_column_type(&c.data_type, source_db, target_db);
                    if mysql_type_needs_key_prefix(&mapped) {
                        pks.push(format!("{qname}(255)"));
                        continue;
                    }
                }
                pks.push(qname);
            }
        }
    }

    let mut ddl = match target_db {
        DatabaseType::SqlServer => {
            format!("IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = '{table}')\n")
        }
        _ => String::new(),
    };

    let create_prefix = match target_db {
        DatabaseType::SqlServer => "CREATE TABLE",
        _ => "CREATE TABLE IF NOT EXISTS",
    };

    ddl.push_str(&format!("{create_prefix} {full_table} (\n"));
    ddl.push_str(&col_lines.join(",\n"));

    if !pks.is_empty() {
        ddl.push_str(&format!(",\n  PRIMARY KEY ({})", pks.join(", ")));
    }

    ddl.push_str("\n)");

    if is_mysql_family {
        if let Some(comment) = table_comment {
            let trimmed = comment.trim();
            if !trimmed.is_empty() {
                ddl.push_str(&format!(" COMMENT='{}'", trimmed.replace('\'', "''")));
            }
        }
    }

    if matches!(target_db, DatabaseType::ClickHouse) {
        ddl.push_str(" ENGINE = MergeTree() ORDER BY tuple()");
    }

    ddl
}

/// Generate COMMENT ON COLUMN / ALTER TABLE COMMENT COLUMN / COMMENT ON TABLE
/// statements for databases that don't support inline comments in CREATE TABLE.
/// MySQL family uses inline syntax (handled in generate_create_table_ddl).
pub fn generate_comment_ddl(
    columns: &[db::ColumnInfo],
    table: &str,
    schema: &str,
    target_db: &DatabaseType,
    table_comment: Option<&str>,
) -> Vec<String> {
    if !matches!(target_db, DatabaseType::Postgres | DatabaseType::Oracle | DatabaseType::ClickHouse) {
        return Vec::new();
    }

    let full_table = qualified_table(table, schema, target_db);
    let mut statements = Vec::new();

    // Table-level comment first (PostgreSQL/Oracle only; ClickHouse doesn't support COMMENT ON TABLE)
    if matches!(target_db, DatabaseType::Postgres | DatabaseType::Oracle) {
        if let Some(comment) = table_comment {
            let trimmed = comment.trim();
            if !trimmed.is_empty() {
                let escaped = trimmed.replace('\'', "''");
                statements.push(format!("COMMENT ON TABLE {full_table} IS '{escaped}'"));
            }
        }
    }

    for c in columns {
        if let Some(ref comment) = c.comment {
            let trimmed = comment.trim();
            if trimmed.is_empty() {
                continue;
            }
            let escaped = trimmed.replace('\'', "''");
            let qcol = quote_identifier(&c.name, target_db);

            match target_db {
                DatabaseType::Postgres | DatabaseType::Oracle => {
                    statements.push(format!("COMMENT ON COLUMN {full_table}.{qcol} IS '{escaped}'"));
                }
                DatabaseType::ClickHouse => {
                    statements.push(format!("ALTER TABLE {full_table} COMMENT COLUMN {qcol} '{escaped}'"));
                }
                _ => {}
            }
        }
    }

    statements
}

pub fn generate_insert(
    columns: &[String],
    rows: &[Vec<serde_json::Value>],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
) -> String {
    generate_insert_typed(columns, &vec![None; columns.len()], rows, table, schema, db_type)
}

pub fn generate_insert_typed(
    columns: &[String],
    column_types: &[Option<String>],
    rows: &[Vec<serde_json::Value>],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
) -> String {
    if rows.is_empty() {
        return String::new();
    }

    let full_table = qualified_table(table, schema, db_type);
    let col_list = columns.iter().map(|c| quote_identifier(c, db_type)).collect::<Vec<_>>().join(", ");

    let value_rows = value_rows_sql(rows, column_types, db_type);

    format!("INSERT INTO {full_table} ({col_list}) VALUES\n{}", value_rows.join(",\n"))
}

fn value_rows_sql(
    rows: &[Vec<serde_json::Value>],
    column_types: &[Option<String>],
    db_type: &DatabaseType,
) -> Vec<String> {
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let mut vals = Vec::with_capacity(row.len());
        for (index, v) in row.iter().enumerate() {
            vals.push(escape_value_typed(v, db_type, column_types.get(index).and_then(|value| value.as_deref())));
        }
        out.push(format!("({})", vals.join(", ")));
    }
    out
}

pub fn generate_upsert(
    columns: &[String],
    rows: &[Vec<serde_json::Value>],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    pk_columns: &[String],
) -> String {
    generate_upsert_typed(columns, &vec![None; columns.len()], rows, table, schema, db_type, pk_columns)
}

pub fn generate_upsert_typed(
    columns: &[String],
    column_types: &[Option<String>],
    rows: &[Vec<serde_json::Value>],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    pk_columns: &[String],
) -> String {
    if rows.is_empty() || pk_columns.is_empty() {
        return String::new();
    }

    let full_table = qualified_table(table, schema, db_type);
    let col_list = columns.iter().map(|c| quote_identifier(c, db_type)).collect::<Vec<_>>().join(", ");

    let value_rows = value_rows_sql(rows, column_types, db_type);

    let mut non_pk_columns = Vec::with_capacity(columns.len().saturating_sub(pk_columns.len()));
    for c in columns {
        if !pk_columns.contains(c) {
            non_pk_columns.push(c);
        }
    }

    match db_type {
        DatabaseType::Postgres | DatabaseType::Sqlite | DatabaseType::DuckDb => {
            let pk_list = pk_columns.iter().map(|c| quote_identifier(c, db_type)).collect::<Vec<_>>().join(", ");
            let mut sql = format!("INSERT INTO {full_table} ({col_list}) VALUES\n{}", value_rows.join(",\n"));
            if non_pk_columns.is_empty() {
                sql.push_str(&format!("\nON CONFLICT ({pk_list}) DO NOTHING"));
            } else {
                let update_set = non_pk_columns
                    .iter()
                    .map(|c| {
                        let qc = quote_identifier(c, db_type);
                        format!("{qc} = EXCLUDED.{qc}")
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                sql.push_str(&format!("\nON CONFLICT ({pk_list}) DO UPDATE SET {update_set}"));
            }
            sql
        }
        DatabaseType::Mysql | DatabaseType::Doris | DatabaseType::StarRocks => {
            let mut sql = format!("INSERT INTO {full_table} ({col_list}) VALUES\n{}", value_rows.join(",\n"));
            if non_pk_columns.is_empty() {
                sql.push_str("\nON DUPLICATE KEY UPDATE ");
                let first_pk = quote_identifier(&pk_columns[0], db_type);
                sql.push_str(&format!("{first_pk} = {first_pk}"));
            } else {
                let update_set = non_pk_columns
                    .iter()
                    .map(|c| {
                        let qc = quote_identifier(c, db_type);
                        format!("{qc} = VALUES({qc})")
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                sql.push_str(&format!("\nON DUPLICATE KEY UPDATE {update_set}"));
            }
            sql
        }
        DatabaseType::SqlServer => {
            let src_col_list = columns.iter().map(|c| quote_identifier(c, db_type)).collect::<Vec<_>>().join(", ");
            let on_clause = pk_columns
                .iter()
                .map(|c| {
                    let qc = quote_identifier(c, db_type);
                    format!("target.{qc} = src.{qc}")
                })
                .collect::<Vec<_>>()
                .join(" AND ");

            let mut sql = format!(
                "MERGE INTO {full_table} AS target USING (VALUES\n{}\n) AS src ({src_col_list}) ON {on_clause}",
                value_rows.join(",\n")
            );

            if !non_pk_columns.is_empty() {
                let update_set = non_pk_columns
                    .iter()
                    .map(|c| {
                        let qc = quote_identifier(c, db_type);
                        format!("target.{qc} = src.{qc}")
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                sql.push_str(&format!("\nWHEN MATCHED THEN UPDATE SET {update_set}"));
            }

            let insert_cols = columns.iter().map(|c| quote_identifier(c, db_type)).collect::<Vec<_>>().join(", ");
            let insert_vals =
                columns.iter().map(|c| format!("src.{}", quote_identifier(c, db_type))).collect::<Vec<_>>().join(", ");
            sql.push_str(&format!("\nWHEN NOT MATCHED THEN INSERT ({insert_cols}) VALUES ({insert_vals});"));
            sql
        }
        DatabaseType::Oracle => {
            let mut using_rows = Vec::with_capacity(rows.len());
            for row in rows {
                let mut vals = Vec::with_capacity(row.len().min(columns.len()));
                for (index, (v, c)) in row.iter().zip(columns.iter()).enumerate() {
                    vals.push(format!(
                        "{} AS {}",
                        escape_value_typed(v, db_type, column_types.get(index).and_then(|value| value.as_deref())),
                        quote_identifier(c, db_type)
                    ));
                }
                using_rows.push(format!("SELECT {} FROM dual", vals.join(", ")));
            }

            let on_clause = pk_columns
                .iter()
                .map(|c| {
                    let qc = quote_identifier(c, db_type);
                    format!("t.{qc} = s.{qc}")
                })
                .collect::<Vec<_>>()
                .join(" AND ");

            let mut sql =
                format!("MERGE INTO {full_table} t USING ({}) s ON ({on_clause})", using_rows.join(" UNION ALL "));

            if !non_pk_columns.is_empty() {
                let update_set = non_pk_columns
                    .iter()
                    .map(|c| {
                        let qc = quote_identifier(c, db_type);
                        format!("t.{qc} = s.{qc}")
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                sql.push_str(&format!("\nWHEN MATCHED THEN UPDATE SET {update_set}"));
            }

            let insert_cols = columns.iter().map(|c| quote_identifier(c, db_type)).collect::<Vec<_>>().join(", ");
            let insert_vals =
                columns.iter().map(|c| format!("s.{}", quote_identifier(c, db_type))).collect::<Vec<_>>().join(", ");
            sql.push_str(&format!("\nWHEN NOT MATCHED THEN INSERT ({insert_cols}) VALUES ({insert_vals})"));
            sql
        }
        _ => generate_insert_typed(columns, column_types, rows, table, schema, db_type),
    }
}

fn max_transfer_write_rows(db_type: &DatabaseType, mode: &TransferMode) -> usize {
    match (db_type, mode) {
        (DatabaseType::SqlServer, TransferMode::Append | TransferMode::Overwrite) => MAX_SQLSERVER_INSERT_ROWS,
        (DatabaseType::Hive, _) => 500,
        (DatabaseType::Oracle, TransferMode::Upsert) => MAX_ORACLE_MERGE_ROWS,
        _ => usize::MAX,
    }
}

#[allow(clippy::too_many_arguments)]
fn generate_transfer_write_sql(
    mode: &TransferMode,
    columns: &[String],
    column_types: &[Option<String>],
    rows: &[Vec<serde_json::Value>],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    pk_columns: &[String],
) -> String {
    match mode {
        TransferMode::Upsert => generate_upsert_typed(columns, column_types, rows, table, schema, db_type, pk_columns),
        _ => generate_insert_typed(columns, column_types, rows, table, schema, db_type),
    }
}

#[allow(clippy::too_many_arguments)]
fn generate_transfer_write_sql_batches(
    mode: &TransferMode,
    columns: &[String],
    column_types: &[Option<String>],
    rows: &[Vec<serde_json::Value>],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    pk_columns: &[String],
) -> Vec<String> {
    if rows.is_empty() {
        return Vec::new();
    }

    let max_rows = max_transfer_write_rows(db_type, mode);
    let mut statements = Vec::new();
    let mut start = 0;

    while start < rows.len() {
        let mut end = start + 1;
        let mut accepted = generate_transfer_write_sql(
            mode,
            columns,
            column_types,
            &rows[start..end],
            table,
            schema,
            db_type,
            pk_columns,
        );

        while end < rows.len() && end - start < max_rows {
            let candidate = generate_transfer_write_sql(
                mode,
                columns,
                column_types,
                &rows[start..=end],
                table,
                schema,
                db_type,
                pk_columns,
            );
            if candidate.len() > MAX_TRANSFER_WRITE_SQL_BYTES && !accepted.is_empty() {
                break;
            }
            accepted = candidate;
            end += 1;
        }

        if !accepted.is_empty() {
            statements.push(accepted);
        }
        start = end;
    }

    statements
}

pub fn pagination_sql(
    columns: &[String],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    offset: u64,
    limit: usize,
) -> String {
    let full_table = qualified_table(table, schema, db_type);
    let col_list = columns.iter().map(|c| quote_identifier(c, db_type)).collect::<Vec<_>>().join(", ");

    match db_type {
        DatabaseType::SqlServer | DatabaseType::Oracle => {
            format!(
                "SELECT {col_list} FROM {full_table} ORDER BY (SELECT NULL) OFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY"
            )
        }
        DatabaseType::Questdb => {
            let upper_bound = offset + limit as u64;
            format!("SELECT {col_list} FROM {full_table} LIMIT {offset}, {upper_bound}")
        }
        _ => {
            format!("SELECT {col_list} FROM {full_table} LIMIT {limit} OFFSET {offset}")
        }
    }
}

pub fn pagination_sql_with_order(
    columns: &[String],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    offset: u64,
    limit: usize,
    order_by_columns: &[String],
) -> String {
    let full_table = qualified_table(table, schema, db_type);
    let col_list = columns.iter().map(|c| quote_identifier(c, db_type)).collect::<Vec<_>>().join(", ");
    let order_expression = postgres_order_by_expression(order_by_columns, db_type);

    match db_type {
        DatabaseType::SqlServer | DatabaseType::Oracle => {
            let order_by = order_expression.unwrap_or_else(|| "(SELECT NULL)".to_string());
            format!(
                "SELECT {col_list} FROM {full_table} ORDER BY {order_by} OFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY"
            )
        }
        DatabaseType::Questdb => {
            let upper_bound = offset + limit as u64;
            let order_by = order_expression.map(|value| format!(" ORDER BY {value}")).unwrap_or_default();
            format!("SELECT {col_list} FROM {full_table}{order_by} LIMIT {offset}, {upper_bound}")
        }
        _ => {
            let order_by = order_expression.map(|value| format!(" ORDER BY {value}")).unwrap_or_default();
            format!("SELECT {col_list} FROM {full_table}{order_by} LIMIT {limit} OFFSET {offset}")
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn pagination_sql_with_filter_order(
    columns: &[String],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    offset: u64,
    limit: usize,
    where_input: Option<&str>,
    order_by: Option<&str>,
    default_order_columns: &[String],
) -> String {
    let full_table = qualified_table(table, schema, db_type);
    let col_list = columns.iter().map(|c| quote_identifier(c, db_type)).collect::<Vec<_>>().join(", ");
    let predicate = crate::sql_dialect::normalize_where_input(where_input);
    let where_clause = if predicate.is_empty() { String::new() } else { format!(" WHERE ({predicate})") };
    let order_expression = order_by
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| postgres_order_by_expression(default_order_columns, db_type));

    match db_type {
        DatabaseType::SqlServer | DatabaseType::Oracle => {
            let order_by = order_expression.unwrap_or_else(|| "(SELECT NULL)".to_string());
            format!(
                "SELECT {col_list} FROM {full_table}{where_clause} ORDER BY {order_by} OFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY"
            )
        }
        DatabaseType::Questdb => {
            let upper_bound = offset + limit as u64;
            let order_by = order_expression.map(|value| format!(" ORDER BY {value}")).unwrap_or_default();
            format!("SELECT {col_list} FROM {full_table}{where_clause}{order_by} LIMIT {offset}, {upper_bound}")
        }
        _ => {
            let order_by = order_expression.map(|value| format!(" ORDER BY {value}")).unwrap_or_default();
            format!("SELECT {col_list} FROM {full_table}{where_clause}{order_by} LIMIT {limit} OFFSET {offset}")
        }
    }
}

pub fn count_sql(table: &str, schema: &str, db_type: &DatabaseType) -> String {
    count_sql_with_where(table, schema, db_type, None)
}

pub fn count_sql_with_where(table: &str, schema: &str, db_type: &DatabaseType, where_input: Option<&str>) -> String {
    let full_table = qualified_table(table, schema, db_type);
    let predicate = crate::sql_dialect::normalize_where_input(where_input);
    let where_clause = if predicate.is_empty() { String::new() } else { format!(" WHERE ({predicate})") };
    format!("SELECT COUNT(*) FROM {full_table}{where_clause}")
}

pub fn keyset_pagination_sql(
    columns: &[String],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    primary_keys: &[String],
    last_pk_values: &[serde_json::Value],
    limit: usize,
) -> String {
    let full_table = qualified_table(table, schema, db_type);
    let col_list = columns.iter().map(|c| quote_identifier(c, db_type)).collect::<Vec<_>>().join(", ");
    let order =
        primary_keys.iter().map(|pk| format!("{} ASC", quote_identifier(pk, db_type))).collect::<Vec<_>>().join(", ");

    let where_clause = keyset_where_clause(primary_keys, last_pk_values, db_type);

    match db_type {
        DatabaseType::SqlServer | DatabaseType::Oracle => {
            format!(
                "SELECT {col_list} FROM {full_table}{where_clause} ORDER BY {order} OFFSET 0 ROWS FETCH NEXT {limit} ROWS ONLY"
            )
        }
        _ => {
            format!("SELECT {col_list} FROM {full_table}{where_clause} ORDER BY {order} LIMIT {limit}")
        }
    }
}

fn keyset_where_clause(
    primary_keys: &[String],
    last_pk_values: &[serde_json::Value],
    db_type: &DatabaseType,
) -> String {
    if primary_keys.is_empty() || last_pk_values.is_empty() {
        return String::new();
    }

    let quoted_keys = primary_keys.iter().map(|pk| quote_identifier(pk, db_type)).collect::<Vec<_>>();
    let literals = last_pk_values.iter().map(|v| value_to_sql_literal(v, db_type)).collect::<Vec<_>>();
    let comparison_count = quoted_keys.len().min(literals.len());
    if comparison_count == 0 {
        return String::new();
    }

    let mut clauses = Vec::with_capacity(comparison_count);
    for index in 0..comparison_count {
        let mut parts = Vec::with_capacity(index + 1);
        for prefix_index in 0..index {
            parts.push(format!("{} = {}", quoted_keys[prefix_index], literals[prefix_index]));
        }
        parts.push(format!("{} > {}", quoted_keys[index], literals[index]));
        if parts.len() == 1 {
            clauses.push(parts.remove(0));
        } else {
            clauses.push(format!("({})", parts.join(" AND ")));
        }
    }

    if clauses.len() == 1 {
        format!(" WHERE {}", clauses[0])
    } else {
        format!(" WHERE ({})", clauses.join(" OR "))
    }
}

fn value_to_sql_literal(value: &serde_json::Value, _db_type: &DatabaseType) -> String {
    match value {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::Bool(b) => {
            if *b {
                "TRUE".to_string()
            } else {
                "FALSE".to_string()
            }
        }
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => quote_string_literal(s),
        _ => quote_string_literal(&value.to_string()),
    }
}

fn is_mongodb_transfer_type(db_type: &DatabaseType) -> bool {
    matches!(db_type, DatabaseType::MongoDb)
}

fn mongo_transfer_document_fields(documents: &[serde_json::Value]) -> Vec<String> {
    let mut fields = Vec::new();
    let mut seen = HashSet::new();
    for document in documents {
        let Some(object) = document.as_object() else {
            continue;
        };
        for key in object.keys() {
            if seen.insert(key.clone()) {
                fields.push(key.clone());
            }
        }
    }
    fields
}

fn mongo_documents_to_rows(documents: &[serde_json::Value], columns: &[String]) -> Vec<Vec<serde_json::Value>> {
    documents
        .iter()
        .map(|document| {
            let object = document.as_object();
            columns
                .iter()
                .map(|column| object.and_then(|values| values.get(column)).cloned().unwrap_or(serde_json::Value::Null))
                .collect()
        })
        .collect()
}

fn sql_rows_to_mongo_documents(columns: &[String], rows: &[Vec<serde_json::Value>]) -> Vec<serde_json::Value> {
    rows.iter()
        .map(|row| {
            let mut document = serde_json::Map::new();
            for (index, column) in columns.iter().enumerate() {
                document.insert(column.clone(), row.get(index).cloned().unwrap_or(serde_json::Value::Null));
            }
            serde_json::Value::Object(document)
        })
        .collect()
}

async fn find_mongo_documents_for_transfer(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    offset: u64,
    batch_size: usize,
) -> Result<MongoDocumentResult, String> {
    crate::mongo_ops::mongo_find_documents_core(
        state,
        connection_id,
        database,
        collection,
        offset,
        batch_size as i64,
        None,
        Some(r#"{"_id":1}"#),
    )
    .await
}

async fn insert_mongo_documents_for_transfer(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    documents: &[serde_json::Value],
) -> Result<u64, String> {
    if documents.is_empty() {
        return Ok(0);
    }
    let docs_json = serde_json::to_string(documents).map_err(|e| format!("Failed to encode MongoDB documents: {e}"))?;
    match crate::mongo_ops::mongo_insert_documents_core(state, connection_id, database, collection, &docs_json).await {
        Ok(count) => Ok(count),
        Err(error) if error.to_ascii_lowercase().contains("legacy agent") => {
            let mut inserted = 0;
            for document in documents {
                let doc_json =
                    serde_json::to_string(document).map_err(|e| format!("Failed to encode MongoDB document: {e}"))?;
                crate::mongo_ops::mongo_insert_document_core(state, connection_id, database, collection, &doc_json)
                    .await?;
                inserted += 1;
            }
            Ok(inserted)
        }
        Err(error) => Err(error),
    }
}

async fn overwrite_mongo_collection_for_transfer(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
) -> Result<(), String> {
    crate::mongo_ops::mongo_delete_documents_core(state, connection_id, database, collection, "{}", true)
        .await
        .map(|_| ())
}

fn mongo_value_column_type(value: Option<&serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::Bool(_)) => "boolean".to_string(),
        Some(serde_json::Value::Number(number)) if number.is_i64() || number.is_u64() => "bigint".to_string(),
        Some(serde_json::Value::Number(_)) => "double".to_string(),
        Some(serde_json::Value::Array(_) | serde_json::Value::Object(_)) => "json".to_string(),
        _ => "text".to_string(),
    }
}

fn mongo_columns_from_documents(documents: &[serde_json::Value]) -> Vec<db::ColumnInfo> {
    mongo_transfer_document_fields(documents)
        .into_iter()
        .map(|name| {
            let sample =
                documents.iter().filter_map(|document| document.as_object()?.get(&name)).find(|value| !value.is_null());
            db::ColumnInfo {
                name,
                data_type: mongo_value_column_type(sample),
                is_nullable: true,
                column_default: None,
                is_primary_key: false,
                extra: None,
                comment: None,
                numeric_precision: None,
                numeric_scale: None,
                character_maximum_length: None,
            }
        })
        .collect()
}

pub async fn execute_on_pool(state: &AppState, pool_key: &str, sql: &str) -> Result<db::QueryResult, String> {
    execute_on_pool_with_max_rows(state, pool_key, sql, None).await
}

pub async fn execute_on_pool_with_max_rows(
    state: &AppState,
    pool_key: &str,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<db::QueryResult, String> {
    // Read-only check: block transfer operations in readonly mode
    crate::query::check_read_only_for_connection(state, pool_key, sql).await?;
    let connections = state.connections.read().await;
    let pool = connections.get(pool_key).ok_or("Connection not found")?;

    match pool {
        PoolKind::Mysql(p, mode) => {
            let p = p.clone();
            let bare = *mode == crate::connection::MysqlMode::Bare;
            drop(connections);
            db::mysql::execute_query_with_max_rows(&p, sql, bare, max_rows, Default::default()).await
        }
        PoolKind::Postgres(p) => {
            let p = p.clone();
            drop(connections);
            db::postgres::execute_query_with_max_rows(&p, sql, max_rows).await
        }
        PoolKind::Sqlite(p) => {
            let p = p.clone();
            drop(connections);
            db::sqlite::execute_query_with_max_rows(&p, sql, max_rows).await
        }
        PoolKind::ClickHouse(client) => {
            let client = client.clone();
            let database = database_from_pool_key(pool_key).unwrap_or("default").to_string();
            drop(connections);
            db::clickhouse_driver::execute_query_with_max_rows(&client, &database, sql, max_rows).await
        }
        PoolKind::SqlServer(client) => {
            let client = client.clone();
            drop(connections);
            let mut client = client.lock().await;
            db::sqlserver::execute_query_with_max_rows(&mut client, sql, max_rows).await
        }
        PoolKind::Agent(client) => {
            let client = client.clone();
            let database = database_from_pool_key(pool_key).map(str::to_string);
            let sql = sql.to_string();
            drop(connections);
            let mut client = client.lock().await;
            let params = agent_execute_query_params(
                &sql,
                database.as_deref(),
                None,
                QueryExecutionOptions { max_rows, fetch_size: max_rows, ..QueryExecutionOptions::default() },
            );
            client.execute_query(params).await
        }
        #[cfg(feature = "duckdb-bundled")]
        PoolKind::DuckDb(con) => {
            let con = con.clone();
            let sql = sql.to_string();
            drop(connections);
            tokio::task::spawn_blocking(move || {
                let con = con.lock().map_err(|e| e.to_string())?;
                if max_rows.is_some()
                    && starts_with_executable_sql_keyword(&sql, &["SELECT", "SHOW", "DESCRIBE", "WITH", "PRAGMA"])
                {
                    return crate::query::duckdb_execute_with_max_rows(&con, &sql, max_rows);
                }
                let start = std::time::Instant::now();
                if starts_with_executable_sql_keyword(&sql, &["SELECT", "SHOW", "DESCRIBE", "WITH", "PRAGMA"]) {
                    let mut stmt = con.prepare(&sql).map_err(|e| e.to_string())?;
                    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
                    let stmt_ref = rows.as_ref().ok_or("DuckDB statement unavailable")?;
                    let col_count = stmt_ref.column_count();
                    let columns: Vec<String> = (0..col_count)
                        .map(|i| stmt_ref.column_name(i).map(|s| s.to_string()).unwrap_or_else(|_| "?".to_string()))
                        .collect();
                    let mut result_rows = Vec::new();
                    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                        let vals: Vec<serde_json::Value> = (0..col_count)
                            .map(|i| {
                                row.get::<_, String>(i)
                                    .map(serde_json::Value::String)
                                    .or_else(|_| row.get::<_, i64>(i).map(|v| serde_json::Value::Number(v.into())))
                                    .or_else(|_| {
                                        row.get::<_, f64>(i).map(|v| {
                                            serde_json::Number::from_f64(v)
                                                .map(serde_json::Value::Number)
                                                .unwrap_or(serde_json::Value::Null)
                                        })
                                    })
                                    .or_else(|_| row.get::<_, bool>(i).map(serde_json::Value::Bool))
                                    .unwrap_or(serde_json::Value::Null)
                            })
                            .collect();
                        result_rows.push(vals);
                    }
                    Ok(db::QueryResult {
                        columns,
                        column_types: Vec::new(),
                        column_sortables: vec![],
                        rows: result_rows,
                        affected_rows: 0,
                        execution_time_ms: start.elapsed().as_millis(),
                        truncated: false,
                        session_id: None,
                        has_more: false,
                    })
                } else {
                    let affected = con.execute(&sql, []).map_err(|e| e.to_string())?;
                    Ok(db::QueryResult {
                        columns: vec![],
                        column_types: Vec::new(),
                        column_sortables: vec![],
                        rows: vec![],
                        affected_rows: affected as u64,
                        execution_time_ms: start.elapsed().as_millis(),
                        truncated: false,
                        session_id: None,
                        has_more: false,
                    })
                }
            })
            .await
            .map_err(|e| e.to_string())?
        }
        #[cfg(feature = "duckdb-bundled")]
        PoolKind::ExternalTabular(ext_pool) => {
            let con = ext_pool.cache.clone();
            let sql = sql.to_string();
            drop(connections);
            tokio::task::spawn_blocking(move || {
                let con = con.lock().map_err(|e| e.to_string())?;
                crate::query::duckdb_execute_with_max_rows(&con, &sql, max_rows)
            })
            .await
            .map_err(|e| e.to_string())?
        }
        _ => Err("Unsupported database type for transfer".to_string()),
    }
}

fn database_from_pool_key(pool_key: &str) -> Option<&str> {
    pool_key
        .split_once(":session:")
        .map(|(base, _)| base)
        .unwrap_or(pool_key)
        .split_once(':')
        .map(|(_, database)| database)
        .filter(|database| !database.is_empty())
}

pub async fn get_db_type(state: &AppState, connection_id: &str) -> Result<DatabaseType, String> {
    let configs = state.configs.read().await;
    configs.get(connection_id).map(|c| c.db_type).ok_or_else(|| format!("Connection config not found: {connection_id}"))
}

pub async fn get_columns_for_transfer(
    state: &AppState,
    pool_key: &str,
    _connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<db::ColumnInfo>, String> {
    let connections = state.connections.read().await;

    #[cfg(feature = "duckdb-bundled")]
    if let Some(PoolKind::DuckDb(con)) = connections.get(pool_key) {
        let con = con.clone();
        drop(connections);
        let table = table.to_string();
        let schema = schema.to_string();
        return tokio::task::spawn_blocking(move || {
            let con = con.lock().map_err(|e| e.to_string())?;
            crate::schema::duckdb_query_columns_in_database(&con, "main", &schema, &table)
        })
        .await
        .map_err(|e| e.to_string())?;
    }

    #[cfg(feature = "duckdb-bundled")]
    if let Some(PoolKind::ExternalTabular(ext_pool)) = connections.get(pool_key) {
        let con = ext_pool.cache.clone();
        drop(connections);
        let table = table.to_string();
        let schema = schema.to_string();
        return tokio::task::spawn_blocking(move || {
            let con = con.lock().map_err(|e| e.to_string())?;
            crate::schema::duckdb_query_columns_in_database(&con, "main", &schema, &table)
        })
        .await
        .map_err(|e| e.to_string())?;
    }

    if let Some(PoolKind::ClickHouse(client)) = connections.get(pool_key) {
        let client = client.clone();
        let database = database.to_string();
        let table = table.to_string();
        drop(connections);
        return db::clickhouse_driver::get_columns(&client, &database, &table).await;
    }
    if let Some(PoolKind::SqlServer(client)) = connections.get(pool_key) {
        let client = client.clone();
        let schema = schema.to_string();
        let table = table.to_string();
        drop(connections);
        let mut client = client.lock().await;
        return db::sqlserver::get_columns(&mut client, &schema, &table).await;
    }
    if let Some(PoolKind::InfluxDb(client)) = connections.get(pool_key) {
        let client = client.clone();
        let database = database.to_string();
        let table = table.to_string();
        drop(connections);
        return db::influxdb_driver::get_columns(&client, &database, &table).await;
    }
    if let Some(PoolKind::Agent(client)) = connections.get(pool_key) {
        let client = client.clone();
        let database = database.to_string();
        let schema = schema.to_string();
        let table = table.to_string();
        drop(connections);
        let mut client = client.lock().await;
        return client.get_columns(&database, &schema, &table).await;
    }
    let pool = connections.get(pool_key).ok_or("Pool not found")?;
    let schema = schema.to_string();
    let table = table.to_string();
    match pool {
        PoolKind::Mysql(p, _) => {
            let p = p.clone();
            drop(connections);
            db::mysql::get_columns(&p, &schema, &table).await
        }
        PoolKind::Postgres(p) => {
            let p = p.clone();
            drop(connections);
            db::postgres::get_columns(&p, &schema, &table).await
        }
        PoolKind::Sqlite(p) => {
            let p = p.clone();
            drop(connections);
            db::sqlite::get_columns(&p, &schema, &table).await
        }
        _ => Err("Unsupported database type".to_string()),
    }
}

async fn get_postgres_indexes_for_transfer(
    state: &AppState,
    pool_key: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<db::IndexInfo>, String> {
    let connections = state.connections.read().await;
    let Some(PoolKind::Postgres(pool)) = connections.get(pool_key) else {
        return Err("PostgreSQL pool not found".to_string());
    };
    let pool = pool.clone();
    drop(connections);
    db::postgres::list_indexes(&pool, schema, table).await
}

async fn get_postgres_foreign_keys_for_transfer(
    state: &AppState,
    pool_key: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<db::ForeignKeyInfo>, String> {
    let connections = state.connections.read().await;
    let Some(PoolKind::Postgres(pool)) = connections.get(pool_key) else {
        return Err("PostgreSQL pool not found".to_string());
    };
    let pool = pool.clone();
    drop(connections);
    db::postgres::list_foreign_keys(&pool, schema, table).await
}

async fn get_postgres_schema_object_sources_for_transfer(
    state: &AppState,
    pool_key: &str,
    schema: &str,
) -> Result<Vec<db::ObjectSource>, String> {
    let views_sql = format!(
        "SELECT c.relname, pg_get_viewdef(c.oid, true) \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = {} AND c.relkind = 'v' \
         ORDER BY c.relname",
        quote_string_literal(schema)
    );
    let routines_sql = format!(
        "SELECT p.proname, CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, pg_get_functiondef(p.oid) \
         FROM pg_catalog.pg_proc p \
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
         WHERE n.nspname = {} AND p.prokind IN ('p', 'f') \
         ORDER BY CASE p.prokind WHEN 'p' THEN 0 ELSE 1 END, p.proname, p.oid",
        quote_string_literal(schema)
    );

    let mut sources = Vec::new();
    for row in execute_on_pool(state, pool_key, &views_sql).await?.rows {
        let Some(name) = json_string_cell(&row, 0) else {
            continue;
        };
        let Some(source) = json_string_cell(&row, 1) else {
            continue;
        };
        sources.push(db::ObjectSource {
            name,
            object_type: db::ObjectSourceKind::View,
            schema: Some(schema.to_string()),
            source,
        });
    }
    for row in execute_on_pool(state, pool_key, &routines_sql).await?.rows {
        let Some(name) = json_string_cell(&row, 0) else {
            continue;
        };
        let kind = match json_string_cell(&row, 1).as_deref() {
            Some("PROCEDURE") => db::ObjectSourceKind::Procedure,
            _ => db::ObjectSourceKind::Function,
        };
        let Some(source) = json_string_cell(&row, 2) else {
            continue;
        };
        sources.push(db::ObjectSource { name, object_type: kind, schema: Some(schema.to_string()), source });
    }

    Ok(sources)
}

async fn get_postgres_materialized_view_sources_for_transfer(
    state: &AppState,
    pool_key: &str,
    schema: &str,
) -> Result<Vec<PostgresMaterializedViewSource>, String> {
    let sql = format!(
        "SELECT c.relname, pg_get_viewdef(c.oid, true) \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = {} AND c.relkind = 'm' \
         ORDER BY c.relname",
        quote_string_literal(schema)
    );
    let rows = execute_on_pool(state, pool_key, &sql).await?.rows;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            Some(PostgresMaterializedViewSource {
                view_name: json_string_cell(&row, 0)?,
                source: json_string_cell(&row, 1)?,
            })
        })
        .collect())
}

async fn get_postgres_trigger_sources_for_transfer(
    state: &AppState,
    pool_key: &str,
    schema: &str,
    tables: &[String],
) -> Result<Vec<PostgresTriggerSource>, String> {
    if tables.is_empty() {
        return Ok(Vec::new());
    }
    let table_list = tables.iter().map(|table| quote_string_literal(table)).collect::<Vec<_>>().join(", ");
    let sql = format!(
        "SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid, true) \
         FROM pg_catalog.pg_trigger t \
         JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = {} AND NOT t.tgisinternal AND c.relname IN ({table_list}) \
         ORDER BY c.relname, t.tgname",
        quote_string_literal(schema)
    );
    let rows = execute_on_pool(state, pool_key, &sql).await?.rows;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            Some(PostgresTriggerSource {
                table_name: json_string_cell(&row, 0)?,
                trigger_name: json_string_cell(&row, 1)?,
                source: json_string_cell(&row, 2)?,
            })
        })
        .collect())
}

async fn get_postgres_extension_sources_for_transfer(
    state: &AppState,
    pool_key: &str,
    schema: &str,
) -> Result<Vec<PostgresExtensionSource>, String> {
    let sql = format!(
        "SELECT e.extname \
         FROM pg_extension e \
         JOIN pg_namespace n ON n.oid = e.extnamespace \
         WHERE n.nspname = {} \
         ORDER BY e.extname",
        quote_string_literal(schema)
    );
    let rows = execute_on_pool(state, pool_key, &sql).await?.rows;
    Ok(rows
        .into_iter()
        .filter_map(|row| json_string_cell(&row, 0).map(|extension_name| PostgresExtensionSource { extension_name }))
        .collect())
}

async fn get_postgres_enum_sources_for_transfer(
    state: &AppState,
    pool_key: &str,
    schema: &str,
) -> Result<Vec<PostgresEnumSource>, String> {
    let sql = format!(
        "SELECT t.typname, COALESCE(array_to_json(array_agg(e.enumlabel ORDER BY e.enumsortorder))::text, '[]') \
         FROM pg_type t \
         JOIN pg_namespace n ON n.oid = t.typnamespace \
         LEFT JOIN pg_enum e ON e.enumtypid = t.oid \
         WHERE n.nspname = {} AND t.typtype = 'e' \
         GROUP BY t.typname \
         ORDER BY t.typname",
        quote_string_literal(schema)
    );
    let rows = execute_on_pool(state, pool_key, &sql).await?.rows;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let type_name = json_string_cell(&row, 0)?;
            let labels_json = json_string_cell(&row, 1)?;
            let labels = serde_json::from_str::<Vec<String>>(&labels_json).ok()?;
            Some(PostgresEnumSource { type_name, labels })
        })
        .collect())
}

async fn get_postgres_domain_sources_for_transfer(
    state: &AppState,
    pool_key: &str,
    schema: &str,
) -> Result<Vec<PostgresDomainSource>, String> {
    let sql = format!(
        "SELECT t.typname, \
                pg_catalog.format_type(t.typbasetype, t.typtypmod), \
                NULLIF(t.typdefault, ''), \
                t.typnotnull, \
                COALESCE(( \
                    SELECT array_to_json(array_agg(pg_get_constraintdef(c.oid, true) ORDER BY c.conname))::text \
                    FROM pg_constraint c \
                    WHERE c.contypid = t.oid AND c.contype = 'c' \
                ), '[]') \
         FROM pg_type t \
         JOIN pg_namespace n ON n.oid = t.typnamespace \
         WHERE n.nspname = {} AND t.typtype = 'd' \
         ORDER BY t.typname",
        quote_string_literal(schema)
    );
    let rows = execute_on_pool(state, pool_key, &sql).await?.rows;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let domain_name = json_string_cell(&row, 0)?;
            let base_type = json_string_cell(&row, 1)?;
            let default_value = json_string_cell(&row, 2);
            let not_null = row.get(3).and_then(|value| value.as_bool()).unwrap_or(false);
            let checks = json_string_cell(&row, 4)
                .and_then(|json| serde_json::from_str::<Vec<String>>(&json).ok())
                .unwrap_or_default();
            Some(PostgresDomainSource { domain_name, base_type, default_value, not_null, checks })
        })
        .collect())
}

async fn get_postgres_policy_statements_for_transfer(
    state: &AppState,
    pool_key: &str,
    source_schema: &str,
    target_schema: &str,
    tables: &[String],
) -> Result<Vec<String>, String> {
    if tables.is_empty() {
        return Ok(Vec::new());
    }
    let table_list = tables.iter().map(|table| quote_string_literal(table)).collect::<Vec<_>>().join(", ");
    let sql = format!(
        "WITH selected_tables AS ( \
             SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity \
             FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = {source_schema} AND c.relkind IN ('r','p') AND c.relname IN ({table_list}) \
         ), \
         policy_rows AS ( \
             SELECT t.relname, t.relrowsecurity, t.relforcerowsecurity, p.polname, p.polpermissive, p.polcmd, \
                    COALESCE((SELECT string_agg(CASE WHEN role_oid = 0 THEN 'PUBLIC' ELSE quote_ident(r.rolname) END, ', ' ORDER BY CASE WHEN role_oid = 0 THEN '' ELSE r.rolname END) \
                              FROM unnest(p.polroles) AS role_oid LEFT JOIN pg_roles r ON r.oid = role_oid), '') AS role_list, \
                    pg_get_expr(p.polqual, p.polrelid) AS using_expr, \
                    pg_get_expr(p.polwithcheck, p.polrelid) AS with_check_expr \
             FROM selected_tables t \
             JOIN pg_catalog.pg_policy p ON p.polrelid = t.oid \
         ) \
         SELECT stmt FROM ( \
             SELECT format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', {target_schema}, relname) AS stmt, relname, 0 AS sort_order \
             FROM selected_tables WHERE relrowsecurity \
             UNION ALL \
             SELECT format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', {target_schema}, relname) AS stmt, relname, 1 AS sort_order \
             FROM selected_tables WHERE relforcerowsecurity \
             UNION ALL \
             SELECT format('DROP POLICY IF EXISTS %I ON %I.%I', polname, {target_schema}, relname) AS stmt, relname, 2 AS sort_order \
             FROM policy_rows \
             UNION ALL \
             SELECT format( \
                 'CREATE POLICY %I ON %I.%I AS %s FOR %s%s%s%s', \
                 polname, {target_schema}, relname, \
                 CASE WHEN polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END, \
                 CASE polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END, \
                 CASE WHEN role_list <> '' THEN ' TO ' || role_list ELSE '' END, \
                 CASE WHEN using_expr IS NOT NULL THEN ' USING (' || using_expr || ')' ELSE '' END, \
                 CASE WHEN with_check_expr IS NOT NULL THEN ' WITH CHECK (' || with_check_expr || ')' ELSE '' END \
             ) AS stmt, relname, 3 AS sort_order \
             FROM policy_rows \
         ) statements \
         ORDER BY relname, sort_order, stmt",
        source_schema = quote_string_literal(source_schema),
        target_schema = quote_string_literal(target_schema),
    );
    Ok(result_rows_to_string_statements(execute_on_pool(state, pool_key, &sql).await?.rows))
}

async fn get_postgres_ownership_statements_for_transfer(
    state: &AppState,
    pool_key: &str,
    source_schema: &str,
    target_schema: &str,
    tables: &[String],
) -> Result<Vec<String>, String> {
    let table_list = tables.iter().map(|table| quote_string_literal(table)).collect::<Vec<_>>().join(", ");
    let table_filter = if tables.is_empty() { "FALSE".to_string() } else { format!("c.relname IN ({table_list})") };
    let sql = format!(
        "WITH relation_owners AS ( \
             SELECT CASE c.relkind \
                      WHEN 'm' THEN format('ALTER MATERIALIZED VIEW %I.%I OWNER TO %I', {target_schema}, c.relname, pg_get_userbyid(c.relowner)) \
                      WHEN 'v' THEN format('ALTER VIEW %I.%I OWNER TO %I', {target_schema}, c.relname, pg_get_userbyid(c.relowner)) \
                      WHEN 'f' THEN format('ALTER FOREIGN TABLE %I.%I OWNER TO %I', {target_schema}, c.relname, pg_get_userbyid(c.relowner)) \
                      WHEN 'S' THEN format('ALTER SEQUENCE %I.%I OWNER TO %I', {target_schema}, c.relname, pg_get_userbyid(c.relowner)) \
                      ELSE format('ALTER TABLE %I.%I OWNER TO %I', {target_schema}, c.relname, pg_get_userbyid(c.relowner)) \
                    END AS stmt \
             FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = {source_schema} AND (c.relkind IN ('v','m') OR ({table_filter} AND c.relkind IN ('r','p','f','S'))) \
         ), \
         routine_owners AS ( \
             SELECT format('ALTER %s %I.%I(%s) OWNER TO %I', \
                           CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, \
                           {target_schema}, p.proname, pg_get_function_identity_arguments(p.oid), pg_get_userbyid(p.proowner)) AS stmt \
             FROM pg_catalog.pg_proc p \
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
             WHERE n.nspname = {source_schema} AND p.prokind IN ('p','f') \
         ), \
         type_owners AS ( \
             SELECT format('ALTER %s %I.%I OWNER TO %I', \
                           CASE t.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, \
                           {target_schema}, t.typname, pg_get_userbyid(t.typowner)) AS stmt \
             FROM pg_catalog.pg_type t \
             JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace \
             WHERE n.nspname = {source_schema} AND t.typtype IN ('e','d') \
         ) \
         SELECT stmt FROM ( \
             SELECT format('ALTER SCHEMA %I OWNER TO %I', {target_schema}, pg_get_userbyid(n.nspowner)) AS stmt \
             FROM pg_catalog.pg_namespace n WHERE n.nspname = {source_schema} \
             UNION ALL SELECT stmt FROM relation_owners \
             UNION ALL SELECT stmt FROM routine_owners \
             UNION ALL SELECT stmt FROM type_owners \
         ) statements",
        source_schema = quote_string_literal(source_schema),
        target_schema = quote_string_literal(target_schema),
        table_filter = table_filter,
    );
    Ok(result_rows_to_string_statements(execute_on_pool(state, pool_key, &sql).await?.rows))
}

async fn get_postgres_grant_statements_for_transfer(
    state: &AppState,
    pool_key: &str,
    source_schema: &str,
    target_schema: &str,
    tables: &[String],
) -> Result<Vec<String>, String> {
    let table_list = tables.iter().map(|table| quote_string_literal(table)).collect::<Vec<_>>().join(", ");
    let table_filter = if tables.is_empty() { "FALSE".to_string() } else { format!("c.relname IN ({table_list})") };
    let sql = format!(
        "WITH schema_grants AS ( \
             SELECT format( \
                 'GRANT %s ON SCHEMA %I TO %s%s', \
                 string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type), \
                 {target_schema}, \
                 CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(grantee.rolname) END, \
                 CASE WHEN bool_or(a.is_grantable) THEN ' WITH GRANT OPTION' ELSE '' END \
             ) AS stmt \
             FROM pg_catalog.pg_namespace n \
             JOIN LATERAL aclexplode(n.nspacl) a ON true \
             LEFT JOIN pg_roles grantee ON grantee.oid = a.grantee \
             WHERE n.nspname = {source_schema} \
             GROUP BY a.grantee, grantee.rolname \
         ), \
         relation_grants AS ( \
             SELECT format( \
                 'GRANT %s ON %s %I.%I TO %s%s', \
                 string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type), \
                 CASE WHEN relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, \
                 {target_schema}, relname, \
                 CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(grantee.rolname) END, \
                 CASE WHEN bool_or(a.is_grantable) THEN ' WITH GRANT OPTION' ELSE '' END \
             ) AS stmt \
             FROM ( \
                 SELECT c.relname, c.relkind, a.grantee, a.privilege_type, a.is_grantable, grantee.rolname \
                 FROM pg_catalog.pg_class c \
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 JOIN LATERAL aclexplode(c.relacl) a ON true \
                 LEFT JOIN pg_roles grantee ON grantee.oid = a.grantee \
                 WHERE n.nspname = {source_schema} AND (c.relkind IN ('v','m') OR ({table_filter} AND c.relkind IN ('r','p','f','S'))) \
             ) rels \
             GROUP BY relname, relkind, grantee, rolname \
         ), \
         routine_grants AS ( \
             SELECT format( \
                 'GRANT %s ON %s %I.%I(%s) TO %s%s', \
                 string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type), \
                 CASE WHEN prokind = 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, \
                 {target_schema}, proname, identity_args, \
                 CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(grantee.rolname) END, \
                 CASE WHEN bool_or(a.is_grantable) THEN ' WITH GRANT OPTION' ELSE '' END \
             ) AS stmt \
             FROM ( \
                 SELECT p.proname, p.prokind, pg_get_function_identity_arguments(p.oid) AS identity_args, a.grantee, a.privilege_type, a.is_grantable, grantee.rolname \
                 FROM pg_catalog.pg_proc p \
                 JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
                 JOIN LATERAL aclexplode(p.proacl) a ON true \
                 LEFT JOIN pg_roles grantee ON grantee.oid = a.grantee \
                 WHERE n.nspname = {source_schema} AND p.prokind IN ('p','f') \
             ) routines \
             GROUP BY proname, prokind, identity_args, grantee, rolname \
         ) \
         SELECT stmt FROM ( \
             SELECT stmt FROM schema_grants \
             UNION ALL SELECT stmt FROM relation_grants \
             UNION ALL SELECT stmt FROM routine_grants \
         ) statements \
         WHERE stmt IS NOT NULL",
        source_schema = quote_string_literal(source_schema),
        target_schema = quote_string_literal(target_schema),
        table_filter = table_filter,
    );
    Ok(result_rows_to_string_statements(execute_on_pool(state, pool_key, &sql).await?.rows))
}

pub async fn is_cancelled(transfer_id: &str) -> bool {
    CANCELLED.read().await.contains(transfer_id)
}

pub async fn set_cancelled(transfer_id: &str) {
    CANCELLED.write().await.insert(transfer_id.to_string());
}

pub async fn clear_cancelled(transfer_id: &str) {
    CANCELLED.write().await.remove(transfer_id);
}

#[allow(clippy::too_many_arguments)]
async fn transfer_mongodb_table<F>(
    state: &AppState,
    request: &TransferRequest,
    table: &str,
    table_index: usize,
    source_db_type: &DatabaseType,
    target_db_type: &DatabaseType,
    source_pool_key: &str,
    target_pool_key: &str,
    mut progress_callback: F,
) -> Result<u64, String>
where
    F: FnMut(TransferProgress),
{
    let total_tables = request.tables.len();
    let batch_size = if request.batch_size == 0 { 1000 } else { request.batch_size };
    let mut offset: u64 = 0;
    let mut total_transferred: u64 = 0;
    let mut total_rows = None;

    if request.mode == TransferMode::Upsert {
        log::warn!("[transfer] MongoDB upsert is not supported yet, falling back to append");
    }

    if is_mongodb_transfer_type(target_db_type) && request.mode == TransferMode::Overwrite {
        overwrite_mongo_collection_for_transfer(state, &request.target_connection_id, &request.target_database, table)
            .await
            .map_err(|e| format!("Failed to clear MongoDB collection '{table}': {e}"))?;
    }

    let mut sql_target_column_names: Vec<String> = Vec::new();
    let mut sql_target_column_types: Vec<Option<String>> = Vec::new();
    let mut sql_target_prepared = false;

    loop {
        if is_cancelled(&request.transfer_id).await {
            return Err("Cancelled".to_string());
        }

        let documents = if is_mongodb_transfer_type(source_db_type) {
            let result = find_mongo_documents_for_transfer(
                state,
                &request.source_connection_id,
                &request.source_database,
                table,
                offset,
                batch_size,
            )
            .await?;
            total_rows = Some(result.total);
            result.documents
        } else {
            let columns = get_columns_for_transfer(
                state,
                source_pool_key,
                &request.source_connection_id,
                &request.source_database,
                &request.source_schema,
                table,
            )
            .await?;
            let col_names = columns.iter().map(|column| column.name.clone()).collect::<Vec<_>>();
            let primary_key_columns = columns
                .iter()
                .filter(|column| column.is_primary_key)
                .map(|column| column.name.clone())
                .collect::<Vec<_>>();
            let sql = pagination_sql_with_order(
                &col_names,
                table,
                &request.source_schema,
                source_db_type,
                offset,
                batch_size,
                &primary_key_columns,
            );
            let result = execute_on_pool(state, source_pool_key, &sql).await?;
            sql_rows_to_mongo_documents(&col_names, &result.rows)
        };

        let row_count = documents.len();
        if row_count == 0 {
            break;
        }

        if is_mongodb_transfer_type(target_db_type) {
            insert_mongo_documents_for_transfer(
                state,
                &request.target_connection_id,
                &request.target_database,
                table,
                &documents,
            )
            .await
            .map_err(|e| format!("Insert failed for MongoDB collection '{table}' at offset {offset}: {e}"))?;
        } else {
            if !sql_target_prepared {
                let mut sql_target_columns = mongo_columns_from_documents(&documents);
                if sql_target_columns.is_empty() {
                    sql_target_columns.push(db::ColumnInfo {
                        name: "document".to_string(),
                        data_type: "json".to_string(),
                        is_nullable: true,
                        column_default: None,
                        is_primary_key: false,
                        extra: None,
                        comment: None,
                        numeric_precision: None,
                        numeric_scale: None,
                        character_maximum_length: None,
                    });
                }
                sql_target_column_names = sql_target_columns.iter().map(|column| column.name.clone()).collect();
                sql_target_column_types =
                    sql_target_columns.iter().map(|column| Some(column.data_type.clone())).collect();

                if request.create_table {
                    let ddl = generate_create_table_ddl(
                        &sql_target_columns,
                        table,
                        &request.source_schema,
                        &request.target_schema,
                        target_db_type,
                        source_db_type,
                        None,
                    );
                    let table_exists = match execute_on_pool(state, target_pool_key, &ddl).await {
                        Ok(_) => true,
                        Err(e) => {
                            let err_lower = e.to_lowercase();
                            if err_lower.contains("already exists") || err_lower.contains("there is already") {
                                true
                            } else {
                                return Err(format!("Failed to create table from MongoDB collection '{table}': {e}"));
                            }
                        }
                    };
                    if table_exists {
                        for stmt in generate_comment_ddl(
                            &sql_target_columns,
                            table,
                            &request.target_schema,
                            target_db_type,
                            None,
                        ) {
                            if let Err(e) = execute_on_pool(state, target_pool_key, &stmt).await {
                                log::warn!(
                                    "[transfer] failed to set MongoDB transfer column comment for {}: {}",
                                    table,
                                    e
                                );
                            }
                        }
                    }
                }

                if request.mode == TransferMode::Overwrite {
                    let full_table = qualified_table(table, &request.target_schema, target_db_type);
                    let truncate_sql = match target_db_type {
                        DatabaseType::Sqlite | DatabaseType::DuckDb => format!("DELETE FROM {full_table}"),
                        _ => format!("TRUNCATE TABLE {full_table}"),
                    };
                    execute_on_pool(state, target_pool_key, &truncate_sql)
                        .await
                        .map_err(|e| format!("Failed to truncate MongoDB transfer target table: {e}"))?;
                }

                sql_target_prepared = true;
            }

            let rows = if sql_target_column_names.len() == 1 && sql_target_column_names[0] == "document" {
                documents.iter().map(|document| vec![document.clone()]).collect::<Vec<_>>()
            } else {
                mongo_documents_to_rows(&documents, &sql_target_column_names)
            };
            let write_statements = generate_transfer_write_sql_batches(
                &TransferMode::Append,
                &sql_target_column_names,
                &sql_target_column_types,
                &rows,
                table,
                &request.target_schema,
                target_db_type,
                &[],
            );
            for (statement_index, batch_sql) in write_statements.iter().enumerate() {
                execute_on_pool(state, target_pool_key, batch_sql).await.map_err(|e| {
                    format!(
                        "Insert failed for MongoDB collection '{table}' at offset {offset}, chunk {} of {}: {e}",
                        statement_index + 1,
                        write_statements.len()
                    )
                })?;
            }
        }

        total_transferred += row_count as u64;
        offset += row_count as u64;

        progress_callback(TransferProgress {
            transfer_id: request.transfer_id.clone(),
            table: table.to_string(),
            table_index,
            total_tables,
            rows_transferred: total_transferred,
            total_rows,
            status: TransferStatus::Running,
            error: None,
        });

        if row_count < batch_size {
            break;
        }
    }

    Ok(total_transferred)
}

/// Transfer a single table. Returns rows transferred.
/// `progress_callback` is invoked for progress updates.
#[allow(clippy::too_many_arguments)]
pub async fn transfer_table<F>(
    state: &AppState,
    request: &TransferRequest,
    table: &str,
    table_index: usize,
    source_db_type: &DatabaseType,
    target_db_type: &DatabaseType,
    source_pool_key: &str,
    target_pool_key: &str,
    mut progress_callback: F,
) -> Result<u64, String>
where
    F: FnMut(TransferProgress),
{
    if is_mongodb_transfer_type(source_db_type) || is_mongodb_transfer_type(target_db_type) {
        return transfer_mongodb_table(
            state,
            request,
            table,
            table_index,
            source_db_type,
            target_db_type,
            source_pool_key,
            target_pool_key,
            progress_callback,
        )
        .await;
    }

    let total_tables = request.tables.len();
    let pg_compat_transfer = is_postgres_compat_transfer(source_db_type, target_db_type);

    // Get source columns (deduplicate by name)
    let columns = {
        let raw = get_columns_for_transfer(
            state,
            source_pool_key,
            &request.source_connection_id,
            &request.source_database,
            &request.source_schema,
            table,
        )
        .await?;
        let mut seen = std::collections::HashSet::new();
        raw.into_iter().filter(|c| seen.insert(c.name.clone())).collect::<Vec<_>>()
    };

    if columns.is_empty() {
        return Err(format!("No columns found for table {table}"));
    }

    let col_names: Vec<String> = columns.iter().map(|c| c.name.clone()).collect();
    let col_types: Vec<Option<String>> = columns.iter().map(|c| Some(c.data_type.clone())).collect();
    let primary_key_columns: Vec<String> =
        columns.iter().filter(|c| c.is_primary_key).map(|c| c.name.clone()).collect();
    log::info!("[transfer] {} has {} columns, counting rows...", table, columns.len());

    // Fetch source table comment
    let table_comment: Option<String> = crate::schema::list_tables_core(
        state,
        &request.source_connection_id,
        &request.source_database,
        &request.source_schema,
        Some(table),
        Some(1),
        None,
    )
    .await
    .unwrap_or_default()
    .into_iter()
    .next()
    .and_then(|t| t.comment);

    let target_table_preexisting = crate::schema::list_tables_core(
        state,
        &request.target_connection_id,
        &request.target_database,
        &request.target_schema,
        Some(table),
        Some(1),
        None,
    )
    .await
    .map(|tables| !tables.is_empty())
    .unwrap_or(false);

    let source_indexes = if request.create_table && pg_compat_transfer && !target_table_preexisting {
        get_postgres_indexes_for_transfer(state, source_pool_key, &request.source_schema, table).await?
    } else {
        Vec::new()
    };
    let source_foreign_keys = if request.create_table && pg_compat_transfer && !target_table_preexisting {
        get_postgres_foreign_keys_for_transfer(state, source_pool_key, &request.source_schema, table).await?
    } else {
        Vec::new()
    };

    // Count source rows
    let total_rows = {
        let sql = count_sql(table, &request.source_schema, source_db_type);
        match execute_on_pool(state, source_pool_key, &sql).await {
            Ok(result) => result.rows.first().and_then(|r| r.first()).and_then(|v| match v {
                serde_json::Value::Number(n) => n.as_u64(),
                serde_json::Value::String(s) => s.parse::<u64>().ok(),
                _ => None,
            }),
            Err(e) => {
                log::warn!("[transfer] count failed for {}: {}", table, e);
                None
            }
        }
    };
    log::info!("[transfer] {} total_rows={:?}", table, total_rows);

    // Create table on target if requested
    if request.create_table {
        if matches!(target_db_type, DatabaseType::Postgres) && !request.target_schema.trim().is_empty() {
            let create_schema_sql =
                format!("CREATE SCHEMA IF NOT EXISTS {}", quote_identifier(&request.target_schema, target_db_type));
            execute_on_pool(state, target_pool_key, &create_schema_sql)
                .await
                .map_err(|e| format!("Failed to ensure schema exists: {e}"))?;
        }
        let ddl = if is_mysql_family_target(source_db_type) && is_mysql_family_target(target_db_type) {
            query_mysql_create_table_ddl(state, source_pool_key, &request.source_schema, table).await?
        } else {
            generate_create_table_ddl(
                &columns,
                table,
                &request.source_schema,
                &request.target_schema,
                target_db_type,
                source_db_type,
                table_comment.as_deref(),
            )
        };
        log::info!("[transfer] creating target table: {}", ddl.chars().take(200).collect::<String>());
        let table_exists = match execute_on_pool(state, target_pool_key, &ddl).await {
            Ok(_) => true,
            Err(e) => {
                let err_lower = e.to_lowercase();
                if err_lower.contains("already exists") || err_lower.contains("there is already") {
                    true
                } else {
                    return Err(format!("Failed to create table: {e}"));
                }
            }
        };
        if table_exists {
            let comment_stmts =
                generate_comment_ddl(&columns, table, &request.target_schema, target_db_type, table_comment.as_deref());
            for stmt in &comment_stmts {
                if let Err(e) = execute_on_pool(state, target_pool_key, stmt).await {
                    log::warn!("[transfer] failed to set column comment for {}: {}", table, e);
                }
            }
        }
    }

    // Truncate target if overwrite mode
    if request.mode == TransferMode::Overwrite {
        let full_table = qualified_table(table, &request.target_schema, target_db_type);
        let truncate_sql = match target_db_type {
            DatabaseType::Sqlite | DatabaseType::DuckDb => format!("DELETE FROM {full_table}"),
            _ => format!("TRUNCATE TABLE {full_table}"),
        };
        execute_on_pool(state, target_pool_key, &truncate_sql).await.map_err(|e| format!("Failed to truncate: {e}"))?;
    }

    // Determine effective mode and PK columns for upsert
    let (effective_mode, pk_columns) = if request.mode == TransferMode::Upsert {
        if matches!(target_db_type, DatabaseType::ClickHouse | DatabaseType::Hive) {
            log::warn!("[transfer] upsert not supported for {:?}, falling back to append", target_db_type);
            (TransferMode::Append, vec![])
        } else {
            let target_columns = get_columns_for_transfer(
                state,
                target_pool_key,
                &request.target_connection_id,
                &request.target_database,
                &request.target_schema,
                table,
            )
            .await
            .unwrap_or_default();
            let pks: Vec<String> = target_columns.iter().filter(|c| c.is_primary_key).map(|c| c.name.clone()).collect();
            if pks.is_empty() {
                log::warn!("[transfer] table {} has no primary key, falling back to append", table);
                (TransferMode::Append, vec![])
            } else {
                (TransferMode::Upsert, pks)
            }
        }
    } else {
        (request.mode.clone(), vec![])
    };

    // Transfer data in batches
    let batch_size = if request.batch_size == 0 { 1000 } else { request.batch_size };
    let mut offset: u64 = 0;
    let mut total_transferred: u64 = 0;

    loop {
        if is_cancelled(&request.transfer_id).await {
            return Err("Cancelled".to_string());
        }

        let sql = pagination_sql_with_order(
            &col_names,
            table,
            &request.source_schema,
            source_db_type,
            offset,
            batch_size,
            &primary_key_columns,
        );
        let result = execute_on_pool(state, source_pool_key, &sql).await?;
        let row_count = result.rows.len();

        if row_count == 0 {
            break;
        }

        let write_statements = generate_transfer_write_sql_batches(
            &effective_mode,
            &col_names,
            &col_types,
            &result.rows,
            table,
            &request.target_schema,
            target_db_type,
            &pk_columns,
        );
        for (statement_index, batch_sql) in write_statements.iter().enumerate() {
            execute_on_pool(state, target_pool_key, batch_sql).await.map_err(|e| {
                let absolute_row = parse_mysql_row_error(&e).map(|row| offset + row);
                match absolute_row {
                    Some(row) => format!(
                        "Insert failed for table '{table}' at row {row} (chunk {} of {}): {e}",
                        statement_index + 1,
                        write_statements.len()
                    ),
                    None => format!(
                        "Insert failed for table '{table}' at offset {offset}, chunk {} of {}: {e}",
                        statement_index + 1,
                        write_statements.len()
                    ),
                }
            })?;
        }

        total_transferred += row_count as u64;
        log::info!("[transfer] {} batch +{} rows (total {})", table, row_count, total_transferred);
        offset += row_count as u64;

        progress_callback(TransferProgress {
            transfer_id: request.transfer_id.clone(),
            table: table.to_string(),
            table_index,
            total_tables,
            rows_transferred: total_transferred,
            total_rows,
            status: TransferStatus::Running,
            error: None,
        });

        if row_count < batch_size {
            break;
        }
    }

    if pg_compat_transfer {
        for statement in generate_postgres_sequence_sync_sql(&columns, table, &request.target_schema) {
            execute_on_pool(state, target_pool_key, &statement)
                .await
                .map_err(|e| format!("Failed to sync PostgreSQL sequence for {table}: {e}"))?;
        }
    }

    if request.create_table && pg_compat_transfer && !target_table_preexisting {
        for statement in generate_postgres_index_ddl(&source_indexes, table, &request.target_schema) {
            execute_on_pool(state, target_pool_key, &statement)
                .await
                .map_err(|e| format!("Failed to create PostgreSQL index for {table}: {e}"))?;
        }
        for statement in generate_postgres_foreign_key_ddl(&source_foreign_keys, table, &request.target_schema) {
            execute_on_pool(state, target_pool_key, &statement)
                .await
                .map_err(|e| format!("Failed to create PostgreSQL foreign key for {table}: {e}"))?;
        }
    }

    Ok(total_transferred)
}

async fn query_mysql_create_table_ddl(
    state: &AppState,
    source_pool_key: &str,
    source_schema: &str,
    table: &str,
) -> Result<String, String> {
    let sql = format!("SHOW CREATE TABLE {}", qualified_table(table, source_schema, &DatabaseType::Mysql));
    let rows = execute_on_pool(state, source_pool_key, &sql).await?.rows;
    rows.first().and_then(|row| json_string_cell(row, 1)).ok_or_else(|| format!("Failed to get MySQL DDL: {sql}"))
}

pub async fn transfer_postgres_schema_dependencies<F>(
    state: &AppState,
    request: &TransferRequest,
    source_pool_key: &str,
    target_pool_key: &str,
    mut progress_callback: F,
) -> Result<(), String>
where
    F: FnMut(TransferProgress),
{
    let source_db_type = get_db_type(state, &request.source_connection_id).await?;
    let target_db_type = get_db_type(state, &request.target_connection_id).await?;
    if !request.create_table || !is_postgres_compat_transfer(&source_db_type, &target_db_type) {
        return Ok(());
    }

    if !request.target_schema.trim().is_empty() {
        let create_schema_sql = format!(
            "CREATE SCHEMA IF NOT EXISTS {}",
            quote_identifier(&request.target_schema, &DatabaseType::Postgres)
        );
        execute_on_pool(state, target_pool_key, &create_schema_sql)
            .await
            .map_err(|e| format!("Failed to ensure PostgreSQL target schema exists: {e}"))?;
    }

    let extensions =
        get_postgres_extension_sources_for_transfer(state, source_pool_key, &request.source_schema).await?;
    let enum_types = get_postgres_enum_sources_for_transfer(state, source_pool_key, &request.source_schema).await?;
    let domains = get_postgres_domain_sources_for_transfer(state, source_pool_key, &request.source_schema).await?;
    let total_steps = extensions.len() + enum_types.len() + domains.len();
    let table_index = 0;
    let mut completed_steps = 0_u64;

    for extension in extensions {
        if is_cancelled(&request.transfer_id).await {
            return Err("Cancelled".to_string());
        }
        completed_steps += 1;
        progress_callback(TransferProgress {
            transfer_id: request.transfer_id.clone(),
            table: format!("extension: {}", extension.extension_name),
            table_index,
            total_tables: request.tables.len(),
            rows_transferred: completed_steps,
            total_rows: Some(total_steps as u64),
            status: TransferStatus::Running,
            error: None,
        });
        execute_on_pool(state, target_pool_key, &generate_postgres_extension_ddl(&extension, &request.target_schema))
            .await
            .map_err(|e| format!("Failed to create PostgreSQL extension {}: {e}", extension.extension_name))?;
    }

    for enum_type in enum_types {
        if is_cancelled(&request.transfer_id).await {
            return Err("Cancelled".to_string());
        }
        completed_steps += 1;
        progress_callback(TransferProgress {
            transfer_id: request.transfer_id.clone(),
            table: format!("enum: {}", enum_type.type_name),
            table_index,
            total_tables: request.tables.len(),
            rows_transferred: completed_steps,
            total_rows: Some(total_steps as u64),
            status: TransferStatus::Running,
            error: None,
        });
        execute_on_pool(state, target_pool_key, &generate_postgres_enum_ddl(&enum_type, &request.target_schema))
            .await
            .map_err(|e| format!("Failed to create PostgreSQL enum {}: {e}", enum_type.type_name))?;
    }

    for domain in domains {
        if is_cancelled(&request.transfer_id).await {
            return Err("Cancelled".to_string());
        }
        completed_steps += 1;
        progress_callback(TransferProgress {
            transfer_id: request.transfer_id.clone(),
            table: format!("domain: {}", domain.domain_name),
            table_index,
            total_tables: request.tables.len(),
            rows_transferred: completed_steps,
            total_rows: Some(total_steps as u64),
            status: TransferStatus::Running,
            error: None,
        });
        execute_on_pool(state, target_pool_key, &generate_postgres_domain_ddl(&domain, &request.target_schema))
            .await
            .map_err(|e| format!("Failed to create PostgreSQL domain {}: {e}", domain.domain_name))?;
    }

    Ok(())
}

pub async fn transfer_postgres_schema_objects<F>(
    state: &AppState,
    request: &TransferRequest,
    source_pool_key: &str,
    target_pool_key: &str,
    mut progress_callback: F,
) -> Result<(), String>
where
    F: FnMut(TransferProgress),
{
    let source_db_type = get_db_type(state, &request.source_connection_id).await?;
    let target_db_type = get_db_type(state, &request.target_connection_id).await?;
    if !request.create_table || !is_postgres_compat_transfer(&source_db_type, &target_db_type) {
        return Ok(());
    }

    let object_sources =
        get_postgres_schema_object_sources_for_transfer(state, source_pool_key, &request.source_schema).await?;
    let materialized_views =
        get_postgres_materialized_view_sources_for_transfer(state, source_pool_key, &request.source_schema).await?;
    let trigger_sources =
        get_postgres_trigger_sources_for_transfer(state, source_pool_key, &request.source_schema, &request.tables)
            .await?;
    let policy_statements = get_postgres_policy_statements_for_transfer(
        state,
        source_pool_key,
        &request.source_schema,
        &request.target_schema,
        &request.tables,
    )
    .await?;
    let ownership_statements = get_postgres_ownership_statements_for_transfer(
        state,
        source_pool_key,
        &request.source_schema,
        &request.target_schema,
        &request.tables,
    )
    .await?;
    let grant_statements = get_postgres_grant_statements_for_transfer(
        state,
        source_pool_key,
        &request.source_schema,
        &request.target_schema,
        &request.tables,
    )
    .await?;
    let materialized_view_step_count = materialized_views
        .iter()
        .map(|view| generate_postgres_materialized_view_ddls(view, &request.target_schema).len())
        .sum::<usize>();
    let trigger_step_count = trigger_sources.len() * 2;
    let total_steps = object_sources.len()
        + materialized_view_step_count
        + trigger_step_count
        + policy_statements.len()
        + ownership_statements.len()
        + grant_statements.len();
    let table_index = request.tables.len();
    let mut completed_steps = 0_u64;

    for object in object_sources {
        if is_cancelled(&request.transfer_id).await {
            return Err("Cancelled".to_string());
        }
        completed_steps += 1;
        progress_callback(TransferProgress {
            transfer_id: request.transfer_id.clone(),
            table: format!("schema object: {}", object.name),
            table_index,
            total_tables: request.tables.len(),
            rows_transferred: completed_steps,
            total_rows: Some(total_steps as u64),
            status: TransferStatus::Running,
            error: None,
        });

        let rewritten_source = match object.object_type {
            db::ObjectSourceKind::View => object.source.clone(),
            db::ObjectSourceKind::Procedure | db::ObjectSourceKind::Function => {
                rewrite_postgres_routine_schema(&object.source, &request.target_schema)
                    .unwrap_or_else(|| object.source.clone())
            }
            db::ObjectSourceKind::Sequence | db::ObjectSourceKind::Package | db::ObjectSourceKind::PackageBody => {
                object.source.clone()
            }
        };
        let statements = build_executable_object_source_statements(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Postgres,
            object_type: object.object_type.clone(),
            schema: Some(request.target_schema.clone()),
            name: object.name.clone(),
            source: rewritten_source,
        })?;
        for statement in statements {
            execute_on_pool(state, target_pool_key, &statement)
                .await
                .map_err(|e| format!("Failed to create PostgreSQL {:?} {}: {e}", object.object_type, object.name))?;
        }
    }

    for view in materialized_views {
        for statement in generate_postgres_materialized_view_ddls(&view, &request.target_schema) {
            if is_cancelled(&request.transfer_id).await {
                return Err("Cancelled".to_string());
            }
            completed_steps += 1;
            progress_callback(TransferProgress {
                transfer_id: request.transfer_id.clone(),
                table: format!("materialized view: {}", view.view_name),
                table_index,
                total_tables: request.tables.len(),
                rows_transferred: completed_steps,
                total_rows: Some(total_steps as u64),
                status: TransferStatus::Running,
                error: None,
            });
            execute_on_pool(state, target_pool_key, &statement)
                .await
                .map_err(|e| format!("Failed to create PostgreSQL materialized view {}: {e}", view.view_name))?;
        }
    }

    for trigger in trigger_sources {
        if is_cancelled(&request.transfer_id).await {
            return Err("Cancelled".to_string());
        }
        completed_steps += 1;
        progress_callback(TransferProgress {
            transfer_id: request.transfer_id.clone(),
            table: format!("trigger: {}", trigger.trigger_name),
            table_index,
            total_tables: request.tables.len(),
            rows_transferred: completed_steps,
            total_rows: Some(total_steps as u64),
            status: TransferStatus::Running,
            error: None,
        });
        let full_table = qualified_table(&trigger.table_name, &request.target_schema, &DatabaseType::Postgres);
        let drop_sql = format!(
            "DROP TRIGGER IF EXISTS {} ON {full_table}",
            quote_identifier(&trigger.trigger_name, &DatabaseType::Postgres)
        );
        execute_on_pool(state, target_pool_key, &drop_sql)
            .await
            .map_err(|e| format!("Failed to drop PostgreSQL trigger {}: {e}", trigger.trigger_name))?;
        completed_steps += 1;
        progress_callback(TransferProgress {
            transfer_id: request.transfer_id.clone(),
            table: format!("trigger: {}", trigger.trigger_name),
            table_index,
            total_tables: request.tables.len(),
            rows_transferred: completed_steps,
            total_rows: Some(total_steps as u64),
            status: TransferStatus::Running,
            error: None,
        });
        let create_sql = rewrite_postgres_trigger_table_schema(
            &ensure_sql_statement_terminated(&trigger.source),
            &request.source_schema,
            &trigger.table_name,
            &request.target_schema,
        );
        execute_on_pool(state, target_pool_key, &create_sql)
            .await
            .map_err(|e| format!("Failed to create PostgreSQL trigger {}: {e}", trigger.trigger_name))?;
    }

    for statement in policy_statements {
        if is_cancelled(&request.transfer_id).await {
            return Err("Cancelled".to_string());
        }
        completed_steps += 1;
        progress_callback(TransferProgress {
            transfer_id: request.transfer_id.clone(),
            table: "row security policies".to_string(),
            table_index,
            total_tables: request.tables.len(),
            rows_transferred: completed_steps,
            total_rows: Some(total_steps as u64),
            status: TransferStatus::Running,
            error: None,
        });
        execute_on_pool(state, target_pool_key, &statement)
            .await
            .map_err(|e| format!("Failed to apply PostgreSQL row security statement: {e}"))?;
    }

    for statement in ownership_statements {
        if is_cancelled(&request.transfer_id).await {
            return Err("Cancelled".to_string());
        }
        completed_steps += 1;
        progress_callback(TransferProgress {
            transfer_id: request.transfer_id.clone(),
            table: "ownership".to_string(),
            table_index,
            total_tables: request.tables.len(),
            rows_transferred: completed_steps,
            total_rows: Some(total_steps as u64),
            status: TransferStatus::Running,
            error: None,
        });
        execute_on_pool(state, target_pool_key, &statement)
            .await
            .map_err(|e| format!("Failed to apply PostgreSQL ownership statement: {e}"))?;
    }

    for statement in grant_statements {
        if is_cancelled(&request.transfer_id).await {
            return Err("Cancelled".to_string());
        }
        completed_steps += 1;
        progress_callback(TransferProgress {
            transfer_id: request.transfer_id.clone(),
            table: "grants".to_string(),
            table_index,
            total_tables: request.tables.len(),
            rows_transferred: completed_steps,
            total_rows: Some(total_steps as u64),
            status: TransferStatus::Running,
            error: None,
        });
        execute_on_pool(state, target_pool_key, &statement)
            .await
            .map_err(|e| format!("Failed to apply PostgreSQL grant statement: {e}"))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(feature = "duckdb-bundled")]
    use crate::connection::{AppState, PoolKind};
    #[cfg(feature = "duckdb-bundled")]
    use crate::models::connection::default_redis_key_separator;
    #[cfg(feature = "duckdb-bundled")]
    use crate::storage::Storage;
    use serde_json::json;
    #[cfg(feature = "duckdb-bundled")]
    use std::sync::Arc;

    #[cfg(feature = "duckdb-bundled")]
    fn duckdb_test_config(id: &str) -> crate::models::connection::ConnectionConfig {
        crate::models::connection::ConnectionConfig {
            id: id.to_string(),
            name: id.to_string(),
            db_type: DatabaseType::DuckDb,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            host: ":memory:".to_string(),
            port: 0,
            username: String::new(),
            password: String::new(),
            database: None,
            visible_databases: None,
            attached_databases: Vec::new(),
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: 5,
            query_timeout_secs: 30,
            idle_timeout_secs: 60,
            keepalive_interval_secs: 0,
            ssl: false,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            sysdba: false,
            oracle_connection_type: None,
            connection_string: None,
            redis_connection_mode: None,
            redis_sentinel_master: String::new(),
            redis_sentinel_nodes: String::new(),
            redis_sentinel_username: String::new(),
            redis_sentinel_password: String::new(),
            redis_sentinel_tls: false,
            redis_cluster_nodes: String::new(),
            redis_key_separator: default_redis_key_separator(),
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: false,
        }
    }

    fn test_column(name: &str, data_type: &str) -> db::ColumnInfo {
        db::ColumnInfo {
            name: name.to_string(),
            data_type: data_type.to_string(),
            is_nullable: true,
            column_default: None,
            is_primary_key: false,
            extra: None,
            comment: None,
            numeric_precision: None,
            numeric_scale: None,
            character_maximum_length: None,
        }
    }

    #[test]
    fn mysql_create_table_includes_column_comments() {
        let cols = vec![
            db::ColumnInfo { comment: Some("用户ID".to_string()), is_primary_key: true, ..test_column("id", "int") },
            db::ColumnInfo {
                comment: Some("用户姓名".to_string()),
                is_nullable: false,
                ..test_column("name", "VARCHAR(100)")
            },
            db::ColumnInfo { comment: None, ..test_column("age", "int") },
        ];

        let ddl = generate_create_table_ddl(&cols, "users", "", "", &DatabaseType::Mysql, &DatabaseType::Mysql, None);

        assert!(ddl.contains("COMMENT '用户ID'"));
        assert!(ddl.contains("COMMENT '用户姓名'"));
        assert!(!ddl.contains("`age` INT COMMENT")); // no comment for age
        assert!(ddl.contains("`name` VARCHAR(100) NOT NULL COMMENT '用户姓名'"));
        assert!(ddl.contains("PRIMARY KEY (`id`)"));
    }

    #[test]
    fn postgres_create_table_preserves_defaults_identity_and_exact_types() {
        let cols = vec![
            db::ColumnInfo {
                data_type: "integer".to_string(),
                column_default: Some("nextval('public.users_id_seq'::regclass)".to_string()),
                is_primary_key: true,
                is_nullable: false,
                ..test_column("id", "integer")
            },
            db::ColumnInfo {
                data_type: "timestamp with time zone".to_string(),
                column_default: Some("now()".to_string()),
                is_nullable: false,
                ..test_column("created_at", "timestamp with time zone")
            },
            db::ColumnInfo {
                data_type: "character varying(120)".to_string(),
                column_default: Some("'guest'::character varying".to_string()),
                ..test_column("name", "character varying(120)")
            },
        ];

        let ddl = generate_create_table_ddl(
            &cols,
            "users",
            "public",
            "public",
            &DatabaseType::Postgres,
            &DatabaseType::Postgres,
            None,
        );

        assert!(ddl.contains("\"id\" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL"));
        assert!(ddl.contains("\"created_at\" timestamp with time zone DEFAULT now() NOT NULL"));
        assert!(ddl.contains("\"name\" character varying(120) DEFAULT 'guest'::character varying"));
        assert!(ddl.contains("PRIMARY KEY (\"id\")"));
    }

    #[test]
    fn postgres_create_table_rewrites_schema_qualified_custom_types_and_defaults() {
        let cols = vec![db::ColumnInfo {
            data_type: "\"public\".\"user_status\"".to_string(),
            column_default: Some("'active'::public.user_status".to_string()),
            is_nullable: false,
            ..test_column("status", "\"public\".\"user_status\"")
        }];

        let ddl = generate_create_table_ddl(
            &cols,
            "users",
            "public",
            "archive",
            &DatabaseType::Postgres,
            &DatabaseType::Postgres,
            None,
        );

        assert!(
            ddl.contains("\"status\" \"archive\".\"user_status\" DEFAULT 'active'::\"archive\".user_status NOT NULL")
        );
    }

    #[test]
    fn mysql_create_table_includes_table_comment() {
        let cols = vec![db::ColumnInfo { is_primary_key: true, ..test_column("id", "int") }];

        let ddl = generate_create_table_ddl(
            &cols,
            "users",
            "",
            "",
            &DatabaseType::Mysql,
            &DatabaseType::Mysql,
            Some("用户表"),
        );

        assert!(ddl.contains(") COMMENT='用户表'"));
    }

    #[test]
    fn mysql_text_pk_gets_key_prefix() {
        let cols =
            vec![db::ColumnInfo { data_type: "text".to_string(), is_primary_key: true, ..test_column("id", "text") }];

        let ddl = generate_create_table_ddl(&cols, "logs", "", "", &DatabaseType::Mysql, &DatabaseType::Sqlite, None);

        assert!(ddl.contains("PRIMARY KEY (`id`(255))"));
        assert!(ddl.contains("`id` TEXT"));
    }

    #[test]
    fn mysql_int_pk_no_prefix() {
        let cols = vec![db::ColumnInfo { is_primary_key: true, ..test_column("id", "int") }];

        let ddl = generate_create_table_ddl(&cols, "users", "", "", &DatabaseType::Mysql, &DatabaseType::Sqlite, None);

        assert!(ddl.contains("PRIMARY KEY (`id`)"));
        assert!(!ddl.contains("PRIMARY KEY (`id`(255))"));
    }

    #[test]
    fn postgres_comment_ddl_generates_column_and_table_comments() {
        let cols = vec![
            db::ColumnInfo { comment: Some("主键".to_string()), ..test_column("id", "int") },
            db::ColumnInfo { comment: Some("名称".to_string()), ..test_column("name", "varchar(100)") },
        ];

        let stmts = generate_comment_ddl(&cols, "items", "public", &DatabaseType::Postgres, Some("项目表"));

        assert_eq!(stmts.len(), 3);
        assert!(stmts[0].contains("COMMENT ON TABLE \"public\".\"items\" IS '项目表'"));
        assert!(stmts[1].contains("COMMENT ON COLUMN \"public\".\"items\".\"id\" IS '主键'"));
        assert!(stmts[2].contains("COMMENT ON COLUMN \"public\".\"items\".\"name\" IS '名称'"));
    }

    #[test]
    fn clickhouse_comment_ddl_uses_alter_table() {
        let cols = vec![db::ColumnInfo { comment: Some("日志消息".to_string()), ..test_column("message", "text") }];

        let stmts = generate_comment_ddl(&cols, "logs", "", &DatabaseType::ClickHouse, None);

        assert_eq!(stmts.len(), 1);
        assert!(stmts[0].contains("ALTER TABLE `logs` COMMENT COLUMN `message` '日志消息'"));
    }

    #[test]
    fn pg_comment_ddl_skips_empty_comments() {
        let cols = vec![
            db::ColumnInfo { comment: None, ..test_column("id", "int") },
            db::ColumnInfo { comment: Some("  ".to_string()), ..test_column("name", "varchar(100)") },
        ];

        let stmts = generate_comment_ddl(&cols, "t", "", &DatabaseType::Postgres, None);

        assert!(stmts.is_empty());
    }

    #[test]
    fn non_mysql_family_no_inline_comment() {
        let cols = vec![db::ColumnInfo { comment: Some("test".to_string()), ..test_column("col", "text") }];

        // PostgreSQL target should NOT have inline COMMENT
        let ddl = generate_create_table_ddl(&cols, "t", "", "", &DatabaseType::Postgres, &DatabaseType::Postgres, None);
        assert!(!ddl.contains("COMMENT"));
    }

    #[test]
    fn hive_create_table_uses_hive_friendly_columns() {
        let cols = vec![
            db::ColumnInfo { is_primary_key: true, is_nullable: false, ..test_column("id", "bigint") },
            db::ColumnInfo { is_nullable: false, ..test_column("payload", "json") },
        ];

        let ddl = generate_create_table_ddl(
            &cols,
            "events",
            "public",
            "warehouse",
            &DatabaseType::Hive,
            &DatabaseType::Postgres,
            None,
        );

        assert!(ddl.contains("CREATE TABLE IF NOT EXISTS `warehouse`.`events`"));
        assert!(ddl.contains("`id` BIGINT"));
        assert!(ddl.contains("`payload` STRING"));
        assert!(!ddl.contains("PRIMARY KEY"));
        assert!(!ddl.contains("NOT NULL"));
    }

    #[test]
    fn hive_transfer_uses_backticks_and_hive_type_mapping() {
        assert_eq!(quote_identifier("user`events", &DatabaseType::Hive), "`user``events`");
        assert_eq!(map_column_type("jsonb", &DatabaseType::Postgres, &DatabaseType::Hive), "STRING");
        assert_eq!(
            map_column_type("timestamp with time zone", &DatabaseType::Postgres, &DatabaseType::Hive),
            "TIMESTAMP"
        );
    }

    #[test]
    fn mongo_transfer_document_fields_preserve_first_seen_order() {
        let documents = vec![json!({"b": 1}), json!({"a": 2, "c": 3}), json!({"b": 4, "d": 5})];

        assert_eq!(mongo_transfer_document_fields(&documents), vec!["b", "a", "c", "d"]);
    }

    #[test]
    fn mongo_transfer_rows_fill_missing_fields_with_null() {
        let rows = mongo_documents_to_rows(
            &[json!({"id": 1, "name": "Ada"}), json!({"id": 2})],
            &[String::from("id"), String::from("name")],
        );

        assert_eq!(rows, vec![vec![json!(1), json!("Ada")], vec![json!(2), serde_json::Value::Null]]);
    }

    #[test]
    fn sql_rows_to_mongo_documents_maps_columns_to_fields() {
        let documents = sql_rows_to_mongo_documents(
            &[String::from("id"), String::from("name"), String::from("active")],
            &[vec![json!(1), json!("Ada")], vec![json!(2), json!("Grace"), json!(true)]],
        );

        assert_eq!(
            documents,
            vec![json!({"id": 1, "name": "Ada", "active": null}), json!({"id": 2, "name": "Grace", "active": true})]
        );
    }

    #[test]
    fn postgres_pagination_uses_stable_primary_key_order() {
        let sql = pagination_sql_with_order(
            &[String::from("id"), String::from("name")],
            "users",
            "public",
            &DatabaseType::Postgres,
            200,
            100,
            &[String::from("id")],
        );

        assert_eq!(sql, "SELECT \"id\", \"name\" FROM \"public\".\"users\" ORDER BY \"id\" LIMIT 100 OFFSET 200");
    }

    #[test]
    fn questdb_pagination_uses_stable_primary_key_order() {
        let sql = pagination_sql_with_order(
            &[String::from("id"), String::from("name")],
            "users",
            "public",
            &DatabaseType::Questdb,
            200,
            100,
            &[String::from("id")],
        );

        assert_eq!(sql, "SELECT `id`, `name` FROM `users` ORDER BY `id` LIMIT 200, 300");
    }

    #[test]
    fn filtered_pagination_preserves_where_and_order() {
        let sql = pagination_sql_with_filter_order(
            &[String::from("id"), String::from("status")],
            "users",
            "public",
            &DatabaseType::SapHana,
            10_000,
            2_000,
            Some("WHERE status = 'active'"),
            Some("\"id\" DESC"),
            &[String::from("id")],
        );

        assert_eq!(
            sql,
            "SELECT \"id\", \"status\" FROM \"public\".\"users\" WHERE (status = 'active') ORDER BY \"id\" DESC LIMIT 2000 OFFSET 10000"
        );
    }

    #[test]
    fn filtered_count_preserves_where() {
        let sql = count_sql_with_where("users", "public", &DatabaseType::SapHana, Some("WHERE status = 'active'"));

        assert_eq!(sql, "SELECT COUNT(*) FROM \"public\".\"users\" WHERE (status = 'active')");
    }

    #[test]
    fn sqlserver_keyset_pagination_includes_offset_fetch() {
        let sql = keyset_pagination_sql(
            &[String::from("id"), String::from("name")],
            "users",
            "dbo",
            &DatabaseType::SqlServer,
            &[String::from("id")],
            &[],
            100,
        );

        assert_eq!(
            sql,
            "SELECT [id], [name] FROM [dbo].[users] ORDER BY [id] ASC OFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY"
        );
    }

    #[test]
    fn composite_keyset_pagination_uses_portable_lexicographic_predicate() {
        let sql = keyset_pagination_sql(
            &[String::from("tenant_id"), String::from("id"), String::from("name")],
            "users",
            "dbo",
            &DatabaseType::SqlServer,
            &[String::from("tenant_id"), String::from("id")],
            &[json!(10), json!(25)],
            100,
        );

        assert_eq!(
            sql,
            "SELECT [tenant_id], [id], [name] FROM [dbo].[users] WHERE ([tenant_id] > 10 OR ([tenant_id] = 10 AND [id] > 25)) ORDER BY [tenant_id] ASC, [id] ASC OFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY"
        );
    }

    #[test]
    fn postgres_generates_index_and_foreign_key_sql() {
        let indexes = vec![db::IndexInfo {
            name: "users_name_idx".to_string(),
            columns: vec!["lower(name)".to_string()],
            is_unique: false,
            is_primary: false,
            filter: Some("name IS NOT NULL".to_string()),
            index_type: Some("btree".to_string()),
            included_columns: Some(vec!["created_at".to_string()]),
            comment: Some("lookup index".to_string()),
        }];
        let foreign_keys = vec![
            db::ForeignKeyInfo {
                name: "orders_user_id_fkey".to_string(),
                column: "user_id".to_string(),
                ref_schema: None,
                ref_table: "users".to_string(),
                ref_column: "id".to_string(),
                on_update: None,
                on_delete: None,
            },
            db::ForeignKeyInfo {
                name: "orders_user_id_fkey".to_string(),
                column: "tenant_id".to_string(),
                ref_schema: None,
                ref_table: "users".to_string(),
                ref_column: "tenant_id".to_string(),
                on_update: None,
                on_delete: None,
            },
        ];

        let index_sql = generate_postgres_index_ddl(&indexes, "users", "public");
        let foreign_key_sql = generate_postgres_foreign_key_ddl(&foreign_keys, "orders", "public");

        assert_eq!(
            index_sql,
            vec![
                "CREATE INDEX IF NOT EXISTS \"users_name_idx\" ON \"public\".\"users\" USING btree (lower(name)) INCLUDE (\"created_at\") WHERE name IS NOT NULL".to_string(),
                "COMMENT ON INDEX \"public\".\"users_name_idx\" IS 'lookup index'".to_string(),
            ]
        );
        assert_eq!(
            foreign_key_sql,
            vec![
                "ALTER TABLE \"public\".\"orders\" ADD CONSTRAINT \"orders_user_id_fkey\" FOREIGN KEY (\"user_id\", \"tenant_id\") REFERENCES \"public\".\"users\" (\"id\", \"tenant_id\")".to_string()
            ]
        );
    }

    #[test]
    fn postgres_sequence_sync_sql_uses_table_max_values() {
        let sql = generate_postgres_sequence_sync_sql(
            &[db::ColumnInfo {
                name: "id".to_string(),
                data_type: "integer".to_string(),
                is_nullable: false,
                column_default: Some("nextval('public.users_id_seq'::regclass)".to_string()),
                is_primary_key: true,
                extra: None,
                comment: None,
                numeric_precision: None,
                numeric_scale: None,
                character_maximum_length: None,
            }],
            "users",
            "public",
        );

        assert_eq!(
            sql,
            vec![
                "SELECT setval(pg_get_serial_sequence('\"public\".\"users\"', 'id'), GREATEST(COALESCE(MAX(\"id\"), 0), 1), MAX(\"id\") IS NOT NULL) FROM \"public\".\"users\"".to_string()
            ]
        );
    }

    #[test]
    fn postgres_routine_schema_rewrite_targets_destination_schema() {
        let rewritten = rewrite_postgres_routine_schema(
            "CREATE OR REPLACE FUNCTION public.bump_counter(id integer)\nRETURNS integer\nLANGUAGE plpgsql\nAS $$ BEGIN RETURN id + 1; END; $$",
            "archive",
        )
        .unwrap();

        assert!(rewritten.starts_with("CREATE OR REPLACE FUNCTION \"archive\".\"bump_counter\"("));
    }

    #[test]
    fn postgres_trigger_schema_rewrite_targets_destination_table() {
        let rewritten = rewrite_postgres_trigger_table_schema(
            "CREATE TRIGGER bump BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.bump_counter()",
            "public",
            "users",
            "archive",
        );

        assert!(rewritten.contains(" ON \"archive\".\"users\" "));
    }

    #[test]
    fn postgres_extension_enum_and_domain_ddl_is_repeatable() {
        let extension_sql = generate_postgres_extension_ddl(
            &PostgresExtensionSource { extension_name: "pgcrypto".to_string() },
            "archive",
        );
        let enum_sql = generate_postgres_enum_ddl(
            &PostgresEnumSource {
                type_name: "status".to_string(),
                labels: vec!["pending".to_string(), "done".to_string()],
            },
            "archive",
        );
        let domain_sql = generate_postgres_domain_ddl(
            &PostgresDomainSource {
                domain_name: "email".to_string(),
                base_type: "text".to_string(),
                default_value: Some("'unknown@example.com'::text".to_string()),
                not_null: true,
                checks: vec!["CHECK ((VALUE ~* '^[^@]+@[^@]+$'::text))".to_string()],
            },
            "archive",
        );

        assert_eq!(extension_sql, "CREATE EXTENSION IF NOT EXISTS \"pgcrypto\" WITH SCHEMA \"archive\"");
        assert!(enum_sql.contains("DO $$ BEGIN IF NOT EXISTS"));
        assert!(enum_sql.contains("CREATE TYPE \"archive\".\"status\" AS ENUM ('pending', 'done')"));
        assert!(domain_sql.contains("CREATE DOMAIN \"archive\".\"email\" AS text DEFAULT 'unknown@example.com'::text NOT NULL CHECK ((VALUE ~* '^[^@]+@[^@]+$'::text))"));
    }

    #[test]
    fn postgres_materialized_view_ddls_drop_and_recreate_in_target_schema() {
        let ddls = generate_postgres_materialized_view_ddls(
            &PostgresMaterializedViewSource {
                view_name: "active_users".to_string(),
                source: "SELECT id, name FROM public.users WHERE active".to_string(),
            },
            "archive",
        );

        assert_eq!(ddls.len(), 2);
        assert_eq!(ddls[0], "DROP MATERIALIZED VIEW IF EXISTS \"archive\".\"active_users\"");
        assert_eq!(
            ddls[1],
            "CREATE MATERIALIZED VIEW \"archive\".\"active_users\" AS\nSELECT id, name FROM public.users WHERE active;"
        );
    }

    #[test]
    fn mysql_insert_normalizes_rfc3339_datetime_strings() {
        let sql = generate_insert_typed(
            &[String::from("insurance_start_time")],
            &[Some(String::from("datetime"))],
            &[vec![json!("2026-05-12T00:00:00+00:00")]],
            "policies",
            "",
            &DatabaseType::Mysql,
        );

        assert_eq!(sql, "INSERT INTO `policies` (`insurance_start_time`) VALUES\n('2026-05-12 00:00:00')");
    }

    #[test]
    fn mysql_insert_omits_database_qualified_table_name() {
        let sql = generate_insert_typed(
            &[String::from("id")],
            &[Some(String::from("int"))],
            &[vec![json!(1)]],
            "users",
            "app",
            &DatabaseType::Mysql,
        );

        assert_eq!(sql, "INSERT INTO `users` (`id`) VALUES\n(1)");
    }

    #[test]
    fn mysql_insert_uses_column_types_for_temporal_literals() {
        let sql = generate_insert_typed(
            &[String::from("dt"), String::from("raw_text"), String::from("d"), String::from("t")],
            &[
                Some(String::from("datetime")),
                Some(String::from("varchar(64)")),
                Some(String::from("date")),
                Some(String::from("time")),
            ],
            &[vec![
                json!("2026-05-12T00:00:00+00:00"),
                json!("2026-05-12T00:00:00+00:00"),
                json!("2026-05-12T00:00:00+00:00"),
                json!("2026-05-12T09:30:45+00:00"),
            ]],
            "policies",
            "",
            &DatabaseType::Mysql,
        );

        assert_eq!(
            sql,
            "INSERT INTO `policies` (`dt`, `raw_text`, `d`, `t`) VALUES\n('2026-05-12 00:00:00', '2026-05-12T00:00:00+00:00', '2026-05-12', '09:30:45')"
        );
    }

    #[test]
    fn transfer_write_sql_batches_split_large_insert_statements() {
        let rows = (0..4).map(|index| vec![json!(index), json!("x".repeat(180 * 1024))]).collect::<Vec<_>>();
        let statements = generate_transfer_write_sql_batches(
            &TransferMode::Append,
            &[String::from("id"), String::from("payload")],
            &[Some(String::from("int")), Some(String::from("text"))],
            &rows,
            "events",
            "",
            &DatabaseType::Mysql,
            &[],
        );

        assert!(statements.len() > 1);
        assert!(statements.iter().all(|sql| sql.starts_with("INSERT INTO `events`")));
    }

    #[test]
    fn transfer_write_sql_batches_keep_existing_upsert_sql_shape() {
        let statements = generate_transfer_write_sql_batches(
            &TransferMode::Upsert,
            &[String::from("id"), String::from("name")],
            &[Some(String::from("int")), Some(String::from("varchar(64)"))],
            &[vec![json!(1), json!("Ada")]],
            "users",
            "",
            &DatabaseType::Mysql,
            &[String::from("id")],
        );

        assert_eq!(statements.len(), 1);
        assert!(statements[0].contains("ON DUPLICATE KEY UPDATE"));
    }

    #[cfg(feature = "duckdb-bundled")]
    #[tokio::test]
    async fn duckdb_transfer_columns_use_requested_schema() {
        let dir = std::env::temp_dir().join(format!("dbx-transfer-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let con = duckdb::Connection::open_in_memory().unwrap();
        con.execute_batch("CREATE SCHEMA analytics; CREATE TABLE analytics.items(id INTEGER);").unwrap();

        let state = AppState::new(storage);
        let con = Arc::new(std::sync::Mutex::new(con));
        state.connections.write().await.insert("duckdb-1".to_string(), PoolKind::DuckDb(con));
        state.configs.write().await.insert("duckdb-1".to_string(), duckdb_test_config("duckdb-1"));

        let columns =
            get_columns_for_transfer(&state, "duckdb-1", "duckdb-1", "main", "analytics", "items").await.unwrap();

        assert_eq!(columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["id"]);
    }

    #[test]
    fn database_from_pool_key_handles_session_scoped_keys() {
        assert_eq!(database_from_pool_key("conn:analytics"), Some("analytics"));
        assert_eq!(database_from_pool_key("conn:analytics:session:editor-1"), Some("analytics"));
        assert_eq!(database_from_pool_key("conn"), None);
    }

    #[test]
    fn map_column_type_preserves_longtext_for_mysql_target() {
        assert_eq!(map_column_type("longtext", &DatabaseType::Mysql, &DatabaseType::Mysql), "longtext");
    }

    #[test]
    fn map_column_type_preserves_mediumtext_for_mysql_target() {
        assert_eq!(map_column_type("mediumtext", &DatabaseType::Mysql, &DatabaseType::Mysql), "mediumtext");
    }

    #[test]
    fn map_column_type_preserves_longblob_for_mysql_target() {
        assert_eq!(map_column_type("longblob", &DatabaseType::Mysql, &DatabaseType::Mysql), "longblob");
    }

    #[test]
    fn map_column_type_preserves_mediumblob_for_mysql_target() {
        assert_eq!(map_column_type("mediumblob", &DatabaseType::Mysql, &DatabaseType::Mysql), "mediumblob");
    }

    #[test]
    fn map_column_type_preserves_same_database_type() {
        assert_eq!(map_column_type("int unsigned", &DatabaseType::Mysql, &DatabaseType::Mysql), "int unsigned");
        assert_eq!(
            map_column_type("int unsigned zerofill", &DatabaseType::Mysql, &DatabaseType::Mysql),
            "int unsigned zerofill"
        );
        assert_eq!(map_column_type("bigint unsigned", &DatabaseType::Mysql, &DatabaseType::Mysql), "bigint unsigned");
        assert_eq!(
            map_column_type("bigint unsigned zerofill", &DatabaseType::Mysql, &DatabaseType::Mysql),
            "bigint unsigned zerofill"
        );
    }

    #[test]
    fn map_column_type_preserves_numeric_type_from_mysql_to_postgres() {
        assert_eq!(map_column_type("int unsigned", &DatabaseType::Mysql, &DatabaseType::Postgres), "INTEGER");
        assert_eq!(map_column_type("int unsigned zerofill", &DatabaseType::Mysql, &DatabaseType::Postgres), "INTEGER");
        assert_eq!(map_column_type("bigint unsigned", &DatabaseType::Mysql, &DatabaseType::Postgres), "BIGINT");
        assert_eq!(
            map_column_type("bigint unsigned zerofill", &DatabaseType::Mysql, &DatabaseType::Postgres),
            "BIGINT"
        );
    }

    #[test]
    fn map_column_type_longtext_falls_back_to_text_for_non_mysql_target() {
        assert_eq!(map_column_type("longtext", &DatabaseType::Mysql, &DatabaseType::Postgres), "TEXT");
    }

    #[test]
    fn map_column_type_longblob_falls_back_for_non_mysql_target() {
        assert_eq!(map_column_type("longblob", &DatabaseType::Mysql, &DatabaseType::Postgres), "BYTEA");
    }

    #[test]
    fn parse_mysql_row_error_extracts_row_number() {
        let err = "ERROR 22001 (1406): Data too long column 'content' at row 8";
        assert_eq!(parse_mysql_row_error(err), Some(8));
    }

    #[test]
    fn parse_mysql_row_error_returns_none_for_non_mysql_error() {
        assert_eq!(parse_mysql_row_error("some other error"), None);
    }

    #[test]
    fn mysql_create_table_preserves_auto_increment_primary_key() {
        let cols = vec![
            db::ColumnInfo {
                is_primary_key: true,
                is_nullable: false,
                extra: Some("auto_increment".to_string()),
                ..test_column("id", "INT")
            },
            db::ColumnInfo { is_nullable: false, ..test_column("name", "varchar(64)") },
        ];

        let ddl = generate_create_table_ddl(&cols, "users", "", "", &DatabaseType::Mysql, &DatabaseType::Mysql, None);

        assert!(ddl.contains("`id` INT NOT NULL AUTO_INCREMENT"), "ddl: {ddl}");
        assert!(ddl.contains("PRIMARY KEY (`id`)"), "ddl: {ddl}");
    }

    #[test]
    fn mysql_create_table_preserves_numeric_default_zero() {
        let cols = vec![db::ColumnInfo {
            is_nullable: false,
            column_default: Some("0".to_string()),
            ..test_column("status", "tinyint")
        }];

        let ddl = generate_create_table_ddl(&cols, "items", "", "", &DatabaseType::Mysql, &DatabaseType::Mysql, None);

        assert!(ddl.contains("DEFAULT 0"), "ddl: {ddl}");
        assert!(!ddl.contains("'0'"), "ddl should not quote numeric default: {ddl}");
    }

    #[test]
    fn mysql_create_table_quotes_string_default_with_escape() {
        let cols =
            vec![db::ColumnInfo { column_default: Some("o'clock".to_string()), ..test_column("label", "varchar(32)") }];

        let ddl = generate_create_table_ddl(&cols, "items", "", "", &DatabaseType::Mysql, &DatabaseType::Mysql, None);

        assert!(ddl.contains("DEFAULT 'o''clock'"), "ddl: {ddl}");
    }

    #[test]
    fn mysql_create_table_keeps_current_timestamp_default_and_on_update() {
        let cols = vec![db::ColumnInfo {
            is_nullable: false,
            column_default: Some("CURRENT_TIMESTAMP".to_string()),
            extra: Some("DEFAULT_GENERATED on update CURRENT_TIMESTAMP".to_string()),
            ..test_column("updated_at", "timestamp")
        }];

        let ddl = generate_create_table_ddl(&cols, "items", "", "", &DatabaseType::Mysql, &DatabaseType::Mysql, None);

        assert!(ddl.contains("DEFAULT CURRENT_TIMESTAMP"), "ddl: {ddl}");
        assert!(ddl.contains("ON UPDATE CURRENT_TIMESTAMP"), "ddl: {ddl}");
        assert!(ddl.contains("NOT NULL"), "ddl: {ddl}");
        assert!(!ddl.contains("DEFAULT_GENERATED"), "ddl should not leak DEFAULT_GENERATED: {ddl}");
    }

    #[test]
    fn mysql_create_table_keeps_current_timestamp_with_fsp() {
        let cols = vec![db::ColumnInfo {
            is_nullable: false,
            column_default: Some("CURRENT_TIMESTAMP(6)".to_string()),
            ..test_column("created_at", "timestamp(6)")
        }];

        let ddl = generate_create_table_ddl(&cols, "items", "", "", &DatabaseType::Mysql, &DatabaseType::Mysql, None);

        assert!(ddl.contains("DEFAULT CURRENT_TIMESTAMP(6)"), "ddl: {ddl}");
    }

    #[test]
    fn mysql_create_table_emits_on_update_without_default() {
        let cols = vec![db::ColumnInfo {
            is_nullable: false,
            extra: Some("on update CURRENT_TIMESTAMP(3)".to_string()),
            ..test_column("touched_at", "timestamp(3)")
        }];

        let ddl = generate_create_table_ddl(&cols, "items", "", "", &DatabaseType::Mysql, &DatabaseType::Mysql, None);

        assert!(ddl.contains("ON UPDATE CURRENT_TIMESTAMP(3)"), "ddl: {ddl}");
        assert!(!ddl.contains("DEFAULT"), "ddl should not emit DEFAULT when none was set: {ddl}");
    }

    #[test]
    fn non_mysql_target_does_not_emit_auto_increment() {
        let cols = vec![db::ColumnInfo {
            is_primary_key: true,
            is_nullable: false,
            extra: Some("auto_increment".to_string()),
            ..test_column("id", "int")
        }];

        let ddl = generate_create_table_ddl(&cols, "users", "", "", &DatabaseType::Sqlite, &DatabaseType::Mysql, None);

        assert!(!ddl.contains("AUTO_INCREMENT"), "non-mysql target should not emit AUTO_INCREMENT: {ddl}");
    }

    #[test]
    fn postgres_create_table_default_clause_unchanged() {
        let cols = vec![db::ColumnInfo {
            data_type: "integer".to_string(),
            column_default: Some("nextval('public.t_id_seq'::regclass)".to_string()),
            is_primary_key: true,
            is_nullable: false,
            ..test_column("id", "integer")
        }];

        let ddl = generate_create_table_ddl(
            &cols,
            "t",
            "public",
            "public",
            &DatabaseType::Postgres,
            &DatabaseType::Postgres,
            None,
        );

        assert!(ddl.contains("GENERATED BY DEFAULT AS IDENTITY"), "ddl: {ddl}");
    }
}
