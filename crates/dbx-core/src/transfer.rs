use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tokio::sync::RwLock;

use crate::connection::{config_for_pool_key, AppState, PoolKind};
use crate::db;
use crate::db::mongo_driver::MongoDocumentResult;
use crate::models::connection::DatabaseType;
use crate::object_source_sql::{build_executable_object_source_statements, EditableObjectSourceSqlInput};
use crate::query::{agent_execute_query_params, pool_error_action, PoolErrorAction, QueryExecutionOptions};
use crate::sql::split_sql_statements;
#[cfg(feature = "duckdb-bundled")]
use crate::sql::starts_with_executable_sql_keyword;
use crate::sql_dialect::{qualified_transfer_table, quote_transfer_identifier};

static CANCELLED: std::sync::LazyLock<RwLock<HashSet<String>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashSet::new()));

const MAX_TRANSFER_WRITE_SQL_BYTES: usize = 512 * 1024;
const MAX_SQLSERVER_INSERT_ROWS: usize = 1000;
const MAX_ORACLE_INSERT_ALL_ROWS: usize = 500;
const MAX_ORACLE_MERGE_ROWS: usize = 500;
const TRANSFER_TARGET_TABLE_LOOKUP_LIMIT: usize = 1000;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TransferMode {
    #[default]
    Append,
    Overwrite,
    Upsert,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TransferTableNameCase {
    #[default]
    Preserve,
    Lower,
    Upper,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TransferOwnershipPolicy {
    #[default]
    Preserve,
    Skip,
    ReassignMissing,
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
    #[serde(default)]
    pub target_table_name_case: TransferTableNameCase,
    #[serde(default)]
    pub ownership_policy: TransferOwnershipPolicy,
    pub batch_size: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferOwnershipPreview {
    pub missing_owners: Vec<String>,
    pub target_owner: String,
}

impl TransferRequest {
    pub fn target_table_name(&self, source_table: &str) -> String {
        match self.target_table_name_case {
            TransferTableNameCase::Preserve => source_table.to_string(),
            TransferTableNameCase::Lower => source_table.to_lowercase(),
            TransferTableNameCase::Upper => source_table.to_uppercase(),
        }
    }
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
    pub terminal: bool,
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

pub fn validate_transfer_target_table_names(request: &TransferRequest) -> Result<(), String> {
    let mut targets: HashMap<String, String> = HashMap::new();
    for source_table in &request.tables {
        let target_table = request.target_table_name(source_table);
        if let Some(first_source) = targets.insert(target_table.clone(), source_table.clone()) {
            return Err(format!(
                "Target table name collision after case conversion: '{first_source}' and '{source_table}' both map to '{target_table}'"
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedTransferTargetTable {
    name: String,
    preexisting: bool,
}

fn json_scalar_to_string(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(value) => Some(value.clone()),
        serde_json::Value::Number(value) => Some(value.to_string()),
        serde_json::Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

fn mysql_lower_case_table_names_from_result(result: &db::QueryResult) -> Option<u8> {
    let row = result.rows.first()?;
    row.get(1).or_else(|| row.first()).and_then(json_scalar_to_string)?.trim().parse::<u8>().ok()
}

async fn target_table_lookup_is_case_insensitive(
    state: &AppState,
    target_pool_key: &str,
    target_db_type: &DatabaseType,
) -> bool {
    if !matches!(target_db_type, DatabaseType::Mysql) {
        return false;
    }

    let result = match execute_on_pool(state, target_pool_key, "SHOW VARIABLES LIKE 'lower_case_table_names'").await {
        Ok(result) => result,
        Err(error) => {
            log::debug!("[transfer] failed to read MySQL lower_case_table_names: {error}");
            return false;
        }
    };

    // MySQL lower_case_table_names=1/2 means table lookup is case-insensitive.
    // Prefer the metadata name so generated INSERT/TRUNCATE SQL keeps the target
    // table's declared case instead of the source-derived request case.
    mysql_lower_case_table_names_from_result(&result).is_some_and(|value| value != 0)
}

fn existing_transfer_target_table_name(
    requested_name: &str,
    tables: &[db::TableInfo],
    allow_case_insensitive_match: bool,
) -> Option<String> {
    if let Some(table) = tables.iter().find(|table| table.name == requested_name) {
        return Some(table.name.clone());
    }
    if !allow_case_insensitive_match {
        return None;
    }
    tables.iter().find(|table| table.name.eq_ignore_ascii_case(requested_name)).map(|table| table.name.clone())
}

async fn resolve_transfer_target_table_name(
    state: &AppState,
    request: &TransferRequest,
    source_table: &str,
    target_pool_key: &str,
    target_db_type: &DatabaseType,
) -> ResolvedTransferTargetTable {
    let requested_name = request.target_table_name(source_table);
    if is_mongodb_transfer_type(target_db_type) {
        return ResolvedTransferTargetTable { name: requested_name, preexisting: false };
    }

    let allow_case_insensitive_match =
        target_table_lookup_is_case_insensitive(state, target_pool_key, target_db_type).await;
    let tables = crate::schema::list_tables_core(
        state,
        &request.target_connection_id,
        &request.target_database,
        &request.target_schema,
        Some(&requested_name),
        Some(TRANSFER_TARGET_TABLE_LOOKUP_LIMIT),
        None,
        None,
    )
    .await
    .unwrap_or_else(|error| {
        log::debug!("[transfer] failed to resolve target table metadata for {requested_name}: {error}");
        Vec::new()
    });

    if let Some(existing_name) =
        existing_transfer_target_table_name(&requested_name, &tables, allow_case_insensitive_match)
    {
        ResolvedTransferTargetTable { name: existing_name, preexisting: true }
    } else {
        ResolvedTransferTargetTable { name: requested_name, preexisting: false }
    }
}

fn quote_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn postgres_schema_exists_sql(schema: &str) -> String {
    format!("SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = {} LIMIT 1", quote_string_literal(schema))
}

fn query_result_has_rows(result: &db::QueryResult) -> bool {
    !result.rows.is_empty()
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
    is_postgres_transfer_dialect(source_db) && is_postgres_transfer_dialect(target_db)
}

fn is_postgres_transfer_dialect(db_type: &DatabaseType) -> bool {
    // KingbaseES supports the PostgreSQL DDL, type, and ON CONFLICT paths used by transfer;
    // other PG-wire databases stay opt-in until their transfer behavior is verified.
    matches!(db_type, DatabaseType::Postgres | DatabaseType::Kingbase)
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

fn is_postgres_generated_extra(extra: Option<&str>) -> bool {
    extra.is_some_and(|value| value.trim().to_ascii_lowercase().starts_with("generated "))
}

fn is_postgres_identity_extra(extra: Option<&str>) -> bool {
    extra.is_some_and(|value| {
        let normalized = value.trim().to_ascii_lowercase();
        normalized.starts_with("generated ") && normalized.contains(" identity")
    })
}

pub(crate) fn is_identity_column_extra(extra: Option<&str>) -> bool {
    extra.is_some_and(|value| {
        let normalized = value.trim().to_ascii_lowercase();
        normalized.contains("identity") || normalized.contains("auto_increment") || normalized.contains("autoincrement")
    })
}

pub(crate) fn selected_columns_include_identity_extras(columns: &[String], column_extras: &[Option<String>]) -> bool {
    columns
        .iter()
        .enumerate()
        .any(|(index, _)| is_identity_column_extra(column_extras.get(index).and_then(|extra| extra.as_deref())))
}

fn selected_columns_include_identity_columns(columns: &[String], all_columns: &[db::ColumnInfo]) -> bool {
    all_columns.iter().any(|column| {
        is_identity_column_extra(column.extra.as_deref())
            && columns.iter().any(|name| name.eq_ignore_ascii_case(&column.name))
    })
}

fn is_sqlserver_rowversion_type(data_type: &str) -> bool {
    let normalized = data_type.trim().to_ascii_lowercase();
    matches!(normalized.split(['(', ' ', '\t', '\n']).next().unwrap_or(""), "timestamp" | "rowversion")
}

fn is_sqlserver_non_insertable_transfer_column(
    column: &db::ColumnInfo,
    source_db_type: &DatabaseType,
    target_db_type: &DatabaseType,
) -> bool {
    matches!((source_db_type, target_db_type), (DatabaseType::SqlServer, DatabaseType::SqlServer))
        && is_sqlserver_rowversion_type(&column.data_type)
}

fn writable_transfer_columns(
    columns: &[db::ColumnInfo],
    source_db_type: &DatabaseType,
    target_db_type: &DatabaseType,
) -> Vec<db::ColumnInfo> {
    columns
        .iter()
        .filter(|column| !is_sqlserver_non_insertable_transfer_column(column, source_db_type, target_db_type))
        .cloned()
        .collect()
}

fn dameng_identity_insert_statement(table: &str, schema: &str, enabled: bool) -> String {
    let full_table = qualified_table(table, schema, &DatabaseType::Dameng);
    format!("SET IDENTITY_INSERT {full_table} {}", if enabled { "ON" } else { "OFF" })
}

pub(crate) fn wrap_dameng_identity_insert_sql(insert_sql: &str, table: &str, schema: &str) -> String {
    let full_table = qualified_table(table, schema, &DatabaseType::Dameng);
    wrap_dameng_identity_insert_sql_for_table(insert_sql, &full_table)
}

pub(crate) fn wrap_dameng_identity_insert_sql_for_table(insert_sql: &str, full_table: &str) -> String {
    let trimmed = insert_sql.trim().trim_end_matches(';').trim();
    format!(
        "{};\n{};\n{};",
        format!("SET IDENTITY_INSERT {full_table} ON"),
        trimmed,
        format!("SET IDENTITY_INSERT {full_table} OFF")
    )
}

async fn execute_transfer_write_statement(
    state: &AppState,
    target_pool_key: &str,
    sql: &str,
    target_db_type: &DatabaseType,
    table: &str,
    schema: &str,
    needs_identity_insert: bool,
) -> Result<(), String> {
    if !needs_identity_insert || !matches!(target_db_type, DatabaseType::Dameng) {
        execute_on_pool(state, target_pool_key, sql).await?;
        return Ok(());
    }

    let enable_sql = dameng_identity_insert_statement(table, schema, true);
    let disable_sql = dameng_identity_insert_statement(table, schema, false);
    execute_on_pool(state, target_pool_key, &enable_sql)
        .await
        .map_err(|e| format!("Failed to enable Dameng IDENTITY_INSERT for {table}: {e}"))?;
    let write_result = execute_on_pool(state, target_pool_key, sql).await;
    let disable_result = execute_on_pool(state, target_pool_key, &disable_sql).await;

    match (write_result, disable_result) {
        (Ok(_), Ok(_)) => Ok(()),
        (Err(write_error), Ok(_)) => Err(write_error),
        (Ok(_), Err(disable_error)) => {
            Err(format!("Failed to disable Dameng IDENTITY_INSERT for {table}: {disable_error}"))
        }
        (Err(write_error), Err(disable_error)) => {
            Err(format!("{write_error}; also failed to disable Dameng IDENTITY_INSERT for {table}: {disable_error}"))
        }
    }
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
    if let Some(mapped_type) = clickhouse_temporal_column_type(column, source_db, target_db) {
        return mapped_type;
    }
    if is_postgres_compat_transfer(source_db, target_db) {
        let trimmed = column.data_type.trim();
        if !trimmed.is_empty() {
            return rewrite_postgres_schema_qualified_references(trimmed, source_schema, target_schema);
        }
    }
    map_column_type(&column.data_type, source_db, target_db)
}

fn clickhouse_temporal_column_type(
    column: &db::ColumnInfo,
    source_db: &DatabaseType,
    target_db: &DatabaseType,
) -> Option<String> {
    if !matches!(target_db, DatabaseType::ClickHouse) || source_db == target_db {
        return None;
    }

    let source_type = column.data_type.trim();
    let lower = source_type.to_ascii_lowercase();
    let base = lower.split(['(', ' ', '\t', '\n']).next().unwrap_or("").trim();
    if !matches!(base, "datetime" | "timestamp" | "timestamptz") {
        return None;
    }

    let scale = clickhouse_datetime64_scale(column);
    // ClickHouse DateTime stores whole seconds, and older versions reject
    // fractional timestamp strings such as Dameng's TIMESTAMP(6) output.
    Some(format!("DateTime64({scale})"))
}

fn clickhouse_datetime64_scale(column: &db::ColumnInfo) -> u8 {
    let scale = parse_temporal_type_scale(&column.data_type).or(column.numeric_scale).unwrap_or(6);
    scale.clamp(0, 9) as u8
}

fn parse_temporal_type_scale(source_type: &str) -> Option<i32> {
    let start = source_type.find('(')? + 1;
    let rest = &source_type[start..];
    let digits = rest.bytes().take_while(|byte| byte.is_ascii_digit()).collect::<Vec<_>>();
    if digits.is_empty() {
        return None;
    }
    std::str::from_utf8(&digits).ok()?.parse::<i32>().ok()
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
    if is_postgres_generated_extra(column.extra.as_deref()) {
        if let Some(extra) = column.extra.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
            return Some(extra.to_string());
        }
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

/// QuestDB is not included. It only uses the PGWire protocol. SQL DDL syntax is not compatible.
fn is_postgres_family_target(target_db: &DatabaseType) -> bool {
    matches!(
        target_db,
        DatabaseType::Postgres
            | DatabaseType::Gaussdb
            | DatabaseType::OpenGauss
            | DatabaseType::Redshift
            | DatabaseType::Kingbase
            | DatabaseType::Highgo
            | DatabaseType::Kwdb
            | DatabaseType::Vastbase
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
    trimmed.parse::<i64>().is_ok()
        || trimmed.parse::<u64>().is_ok()
        || trimmed.parse::<f64>().is_ok_and(|value| value.is_finite())
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

fn oracle_rownum_page_sql(col_list: &str, base_sql: String, offset: u64, limit: usize) -> String {
    if offset == 0 {
        return format!("SELECT {col_list} FROM ({base_sql}) WHERE ROWNUM <= {limit}");
    }
    let end = offset + limit as u64;
    format!(
        "SELECT {col_list} FROM (SELECT dbx_inner.*, ROWNUM AS \"__dbx_row_num\" FROM ({base_sql}) dbx_inner WHERE ROWNUM <= {end}) WHERE \"__dbx_row_num\" > {offset}"
    )
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

fn generate_postgres_foreign_key_ddl(
    foreign_keys: &[db::ForeignKeyInfo],
    table: &str,
    source_schema: &str,
    target_schema: &str,
) -> Vec<String> {
    let full_table = qualified_table(table, target_schema, &DatabaseType::Postgres);
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
        let referenced_schema = match group[0].ref_schema.as_deref() {
            Some(ref_schema) if ref_schema == source_schema => target_schema,
            Some(ref_schema) => ref_schema,
            None => target_schema,
        };
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
        .filter(|column| {
            is_postgres_sequence_default(column.column_default.as_deref())
                || is_postgres_identity_extra(column.extra.as_deref())
        })
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
struct PostgresOwnedSequence {
    name: String,
    owner_table: String,
    owner_column: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PostgresSequenceSnapshot {
    name: String,
    owner_table: Option<String>,
    owner_column: Option<String>,
}

fn postgres_sequence_qualified_name(schema: &str, sequence_name: &str) -> String {
    if schema.trim().is_empty() {
        quote_identifier(sequence_name, &DatabaseType::Postgres)
    } else {
        format!(
            "{}.{}",
            quote_identifier(schema, &DatabaseType::Postgres),
            quote_identifier(sequence_name, &DatabaseType::Postgres)
        )
    }
}

/// Reuse an existing target sequence only when it is already bound to the same
/// target table column; otherwise the later `OWNED BY` rebind would silently
/// change unrelated objects.
fn validate_existing_postgres_sequence(
    sequence: &PostgresOwnedSequence,
    existing: Option<&PostgresSequenceSnapshot>,
    schema: &str,
) -> Result<bool, String> {
    let Some(existing) = existing else {
        return Ok(true);
    };

    let owner_matches = match (existing.owner_table.as_deref(), existing.owner_column.as_deref()) {
        (None, None) => true,
        (Some(owner_table), Some(owner_column)) => {
            owner_table == sequence.owner_table && owner_column == sequence.owner_column
        }
        _ => false,
    };

    if owner_matches {
        return Ok(false);
    }

    Err(format!(
        "PostgreSQL sequence {} already exists with incompatible ownership",
        postgres_sequence_qualified_name(schema, &sequence.name)
    ))
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

#[derive(Debug, Clone)]
struct PostgresOwnershipStatement {
    sql_prefix: String,
    owner: String,
}

fn json_string_cell(row: &[serde_json::Value], index: usize) -> Option<String> {
    row.get(index).and_then(|value| value.as_str().map(str::to_string))
}

fn result_rows_to_string_statements(rows: Vec<Vec<serde_json::Value>>) -> Vec<String> {
    rows.into_iter().filter_map(|row| json_string_cell(&row, 0)).filter(|stmt| !stmt.trim().is_empty()).collect()
}

fn result_rows_to_postgres_ownership_statements(rows: Vec<Vec<serde_json::Value>>) -> Vec<PostgresOwnershipStatement> {
    rows.into_iter()
        .filter_map(|row| {
            let sql_prefix = json_string_cell(&row, 0)?;
            let owner = json_string_cell(&row, 1)?;
            if sql_prefix.trim().is_empty() || owner.trim().is_empty() {
                None
            } else {
                Some(PostgresOwnershipStatement { sql_prefix, owner })
            }
        })
        .collect()
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

fn rewrite_postgres_routine_schema(source: &str, source_schema: &str, target_schema: &str) -> Option<String> {
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
    let rewritten = format!("{}{}{}{}", &source[..full.start()], prefix, replacement, &source[full.end()..]);
    Some(rewrite_postgres_schema_qualified_references(&rewritten, source_schema, target_schema))
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
            let rewritten = source.replacen(&pattern, &format!(" ON {qualified_target_table} "), 1);
            return rewrite_postgres_schema_qualified_references(&rewritten, source_schema, target_schema);
        }
    }
    rewrite_postgres_schema_qualified_references(source, source_schema, target_schema)
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
            | DatabaseType::CloudflareD1
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
            DatabaseType::SqlServer => {
                if *b {
                    "1".to_string()
                } else {
                    "0".to_string()
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
            if let Some(binary_literal) = format_postgres_binary_sql_literal(s, db_type, column_type) {
                return binary_literal;
            }
            if let Some(binary_literal) = format_mysql_binary_sql_literal(s, db_type, column_type) {
                return binary_literal;
            }
            if let Some(numeric_literal) = format_mysql_numeric_string_literal(s, db_type, column_type) {
                return numeric_literal;
            }
            if let Some(date_literal) = format_oracle_date_sql_literal(s, db_type, column_type) {
                return date_literal;
            }

            let literal = format_literal_string(s, db_type, column_type);
            let escaped = if is_postgres_family_target(db_type) {
                literal.replace('\'', "''")
            } else {
                literal.replace('\\', "\\\\").replace('\'', "''")
            };
            match db_type {
                DatabaseType::Mysql | DatabaseType::Doris | DatabaseType::StarRocks
                    if column_type.is_some_and(is_mysql_bit_type) =>
                {
                    format!("b'{escaped}'")
                }
                DatabaseType::SqlServer => format!("N'{escaped}'"),
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

fn is_mysql_numeric_string_literal_database(db_type: &DatabaseType) -> bool {
    matches!(
        db_type,
        DatabaseType::Mysql
            | DatabaseType::Doris
            | DatabaseType::StarRocks
            | DatabaseType::Goldendb
            | DatabaseType::Sundb
    )
}

fn is_mysql_non_bit_numeric_type(column_type: &str) -> bool {
    is_mysql_numeric_base_type(column_type) && !is_mysql_bit_type(column_type)
}

fn format_mysql_numeric_string_literal(
    value: &str,
    db_type: &DatabaseType,
    column_type: Option<&str>,
) -> Option<String> {
    if !is_mysql_numeric_string_literal_database(db_type) || !column_type.is_some_and(is_mysql_non_bit_numeric_type) {
        return None;
    }
    let trimmed = value.trim();
    if looks_like_numeric_literal(trimmed) {
        Some(trimmed.to_string())
    } else {
        None
    }
}

fn is_binary_transfer_column_type(column_type: &str) -> bool {
    let lower = column_type.trim().to_ascii_lowercase();
    let base = lower.split(['(', ' ', '\t', '\n']).next().unwrap_or("");
    matches!(base, "binary" | "varbinary" | "blob" | "tinyblob" | "mediumblob" | "longblob" | "bytea" | "image")
}

fn format_postgres_binary_sql_literal(
    value: &str,
    db_type: &DatabaseType,
    column_type: Option<&str>,
) -> Option<String> {
    if !matches!(db_type, DatabaseType::Postgres) || !column_type.is_some_and(is_binary_transfer_column_type) {
        return None;
    }

    let hex = value.strip_prefix("0x").or_else(|| value.strip_prefix("0X"))?;
    if hex.len() % 2 != 0 || !hex.as_bytes().iter().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }

    Some(format!("decode('{hex}', 'hex')"))
}

fn format_mysql_binary_sql_literal(value: &str, db_type: &DatabaseType, column_type: Option<&str>) -> Option<String> {
    if !matches!(db_type, DatabaseType::Mysql) || !column_type.is_some_and(is_binary_transfer_column_type) {
        return None;
    }

    let trimmed = value.trim();
    let hex = trimmed.strip_prefix("0x").or_else(|| trimmed.strip_prefix("0X"))?;
    if hex.as_bytes().iter().all(|byte| byte.is_ascii_hexdigit()) {
        Some(if hex.is_empty() { "X''".to_string() } else { format!("0x{hex}") })
    } else {
        None
    }
}

fn format_oracle_date_sql_literal(value: &str, db_type: &DatabaseType, column_type: Option<&str>) -> Option<String> {
    if !matches!(db_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle) {
        return None;
    }
    if temporal_column_kind(column_type) != Some("date") {
        return None;
    }
    let parts = oracle_export_date_parts(value)?;
    Some(format_oracle_date_sql_literal_parts(&parts))
}

struct OracleExportDateParts<'a> {
    date: &'a str,
    time: &'a str,
    fraction: Option<&'a str>,
}

fn format_oracle_date_sql_literal_parts(parts: &OracleExportDateParts<'_>) -> String {
    if oracle_export_date_parts_are_midnight(parts) {
        format!("DATE '{}'", parts.date)
    } else {
        format!("TO_DATE('{} {}', 'YYYY-MM-DD HH24:MI:SS')", parts.date, parts.time)
    }
}

fn oracle_export_date_parts_are_midnight(parts: &OracleExportDateParts<'_>) -> bool {
    parts.time == "00:00:00"
        && parts.fraction.map(|fraction| fraction.trim_start_matches('.').chars().all(|ch| ch == '0')).unwrap_or(true)
}

fn oracle_export_date_parts(value: &str) -> Option<OracleExportDateParts<'_>> {
    let bytes = value.as_bytes();
    if bytes.len() < 10 || bytes.get(4) != Some(&b'-') || bytes.get(7) != Some(&b'-') {
        return None;
    }
    let date = &value[..10];
    if !date.as_bytes().iter().enumerate().all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit()) {
        return None;
    }
    if bytes.len() == 10 {
        return Some(OracleExportDateParts { date, time: "00:00:00", fraction: None });
    }
    let separator = *bytes.get(10)?;
    if separator != b'T' && separator != b' ' {
        return None;
    }
    if bytes.len() < 19 || bytes.get(13) != Some(&b':') || bytes.get(16) != Some(&b':') {
        return None;
    }
    let time = &value[11..19];
    if !time.as_bytes().iter().enumerate().all(|(index, byte)| matches!(index, 2 | 5) || byte.is_ascii_digit()) {
        return None;
    }
    let rest = &value[19..];
    if rest.is_empty() || is_timezone_suffix(rest) {
        return Some(OracleExportDateParts { date, time, fraction: None });
    }
    if let Some(after_dot) = rest.strip_prefix('.') {
        let digit_count = after_dot.bytes().take_while(|byte| byte.is_ascii_digit()).count();
        if digit_count == 0 {
            return None;
        }
        let zone = &after_dot[digit_count..];
        if zone.is_empty() || is_timezone_suffix(zone) {
            return Some(OracleExportDateParts { date, time, fraction: Some(&value[19..19 + 1 + digit_count]) });
        }
    }
    None
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
    if *db_type == DatabaseType::SqlServer {
        crate::sqlserver_temporal::normalize_sqlserver_temporal_literal(value, column_type)
            .unwrap_or_else(|| value.to_string())
    } else if is_mysql_datetime_literal_database(db_type) && column_type.map(is_temporal_column_type).unwrap_or(true) {
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
            target_db if is_postgres_transfer_dialect(target_db) => "INTEGER".into(),
            DatabaseType::Mysql => "INT".into(),
            DatabaseType::SqlServer => "INT".into(),
            _ => "INTEGER".into(),
        },
        "bigint" | "int8" => "BIGINT".into(),
        "smallint" | "int2" => "SMALLINT".into(),
        "tinyint" => match target_db {
            target_db if is_postgres_transfer_dialect(target_db) => "SMALLINT".into(),
            _ => "TINYINT".into(),
        },
        "serial" | "bigserial" | "smallserial" => match target_db {
            target_db if is_postgres_transfer_dialect(target_db) => source_type.to_uppercase(),
            DatabaseType::Mysql => "BIGINT AUTO_INCREMENT".into(),
            _ => "INTEGER".into(),
        },
        "float" | "float4" | "real" => match target_db {
            target_db if is_postgres_transfer_dialect(target_db) => "REAL".into(),
            _ => "FLOAT".into(),
        },
        "double" | "double precision" | "float8" => match target_db {
            target_db if is_postgres_transfer_dialect(target_db) => "DOUBLE PRECISION".into(),
            _ => "DOUBLE".into(),
        },
        "decimal" | "numeric" | "number" => {
            if t.contains('(') {
                match target_db {
                    DatabaseType::Mysql | DatabaseType::SqlServer | DatabaseType::Oracle => {
                        format!("DECIMAL{}", &t[t.find('(').unwrap()..])
                    }
                    target_db if is_postgres_transfer_dialect(target_db) => {
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
                    target_db if is_postgres_transfer_dialect(target_db) => format!("VARCHAR{len_part}"),
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
            target_db if is_postgres_transfer_dialect(target_db) => "TIMESTAMP".into(),
            DatabaseType::ClickHouse => "DateTime64(6)".into(),
            _ => "DATETIME".into(),
        },
        "timestamp" | "timestamptz" | "timestamp with time zone" | "timestamp without time zone" => match target_db {
            DatabaseType::Mysql => "DATETIME".into(),
            DatabaseType::SqlServer => "DATETIME2".into(),
            DatabaseType::ClickHouse => "DateTime64(6)".into(),
            _ => "TIMESTAMP".into(),
        },
        "longblob" => match target_db {
            DatabaseType::Mysql => "LONGBLOB".into(),
            target_db if is_postgres_transfer_dialect(target_db) => "BYTEA".into(),
            DatabaseType::SqlServer => "VARBINARY(MAX)".into(),
            _ => "BLOB".into(),
        },
        "mediumblob" => match target_db {
            DatabaseType::Mysql => "MEDIUMBLOB".into(),
            target_db if is_postgres_transfer_dialect(target_db) => "BYTEA".into(),
            DatabaseType::SqlServer => "VARBINARY(MAX)".into(),
            _ => "BLOB".into(),
        },
        "blob" | "tinyblob" | "binary" | "varbinary" | "image" => match target_db {
            target_db if is_postgres_transfer_dialect(target_db) => "BYTEA".into(),
            DatabaseType::Mysql => "BLOB".into(),
            DatabaseType::SqlServer => "VARBINARY(MAX)".into(),
            _ => "BLOB".into(),
        },
        "bytea" => match target_db {
            target_db if is_postgres_transfer_dialect(target_db) => "BYTEA".into(),
            DatabaseType::Mysql => "BLOB".into(),
            _ => "BLOB".into(),
        },
        "json" | "jsonb" => match target_db {
            target_db if is_postgres_transfer_dialect(target_db) => "JSONB".into(),
            DatabaseType::Mysql => "JSON".into(),
            _ => "TEXT".into(),
        },
        "uuid" => match target_db {
            target_db if is_postgres_transfer_dialect(target_db) => "UUID".into(),
            _ => "VARCHAR(36)".into(),
        },
        "bit" => match target_db {
            target_db if is_postgres_transfer_dialect(target_db) => "BOOLEAN".into(),
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

    // ClickHouse: PRIMARY KEY must be a prefix of ORDER BY; skip inline PK
    // and encode it in the ENGINE clause below instead.
    if !pks.is_empty() && !matches!(target_db, DatabaseType::ClickHouse) {
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
        if pks.is_empty() {
            ddl.push_str(" ENGINE = MergeTree() ORDER BY tuple()");
        } else {
            ddl.push_str(&format!(" ENGINE = MergeTree() ORDER BY ({})", pks.join(", ")));
        }
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
    if matches!(db_type, DatabaseType::Oracle) && rows.len() > 1 {
        // Oracle 11g does not accept comma-separated multi-row VALUES lists.
        let into_rows = value_rows
            .iter()
            .map(|values| format!("INTO {full_table} ({col_list}) VALUES {values}"))
            .collect::<Vec<_>>()
            .join("\n");
        return format!("INSERT ALL\n{into_rows}\nSELECT 1 FROM dual");
    }

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
        db_type
            if is_postgres_transfer_dialect(db_type)
                || matches!(db_type, DatabaseType::Sqlite | DatabaseType::CloudflareD1 | DatabaseType::DuckDb) =>
        {
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
        (DatabaseType::Oracle, TransferMode::Append | TransferMode::Overwrite) => MAX_ORACLE_INSERT_ALL_ROWS,
        (DatabaseType::Oracle, TransferMode::Upsert) => MAX_ORACLE_MERGE_ROWS,
        _ => usize::MAX,
    }
}

fn can_reuse_source_table_ddl(
    source_db_type: &DatabaseType,
    target_db_type: &DatabaseType,
    preserves_target_table_name: bool,
) -> bool {
    preserves_target_table_name
        && !matches!(target_db_type, DatabaseType::ClickHouse)
        && (source_db_type == target_db_type
            || (is_mysql_family_target(source_db_type) && is_mysql_family_target(target_db_type))
            || (is_postgres_family_target(source_db_type) && is_postgres_family_target(target_db_type)))
}

fn rewrite_transfer_source_table_ddl(
    sql: &str,
    source_schema: &str,
    target_schema: &str,
    source_db_type: &DatabaseType,
    target_db_type: &DatabaseType,
) -> String {
    if is_postgres_family_target(source_db_type) && is_postgres_family_target(target_db_type) {
        rewrite_postgres_schema_qualified_references(sql, source_schema, target_schema)
    } else {
        sql.to_string()
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
    let max_sql_bytes = match db_type {
        DatabaseType::CloudflareD1 => crate::db::cloudflare_d1::MAX_SQL_STATEMENT_BYTES,
        _ => MAX_TRANSFER_WRITE_SQL_BYTES,
    };
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
            if candidate.len() > max_sql_bytes && !accepted.is_empty() {
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
        DatabaseType::Oracle => {
            let base_sql = format!("SELECT {col_list} FROM {full_table}");
            oracle_rownum_page_sql(&col_list, base_sql, offset, limit)
        }
        DatabaseType::SqlServer | DatabaseType::Dameng => {
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
        DatabaseType::Oracle => {
            let order_by = order_expression.map(|value| format!(" ORDER BY {value}")).unwrap_or_default();
            let base_sql = format!("SELECT {col_list} FROM {full_table}{order_by}");
            oracle_rownum_page_sql(&col_list, base_sql, offset, limit)
        }
        DatabaseType::SqlServer | DatabaseType::Dameng => {
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
        DatabaseType::Oracle => {
            let order_by = order_expression.map(|value| format!(" ORDER BY {value}")).unwrap_or_default();
            let base_sql = format!("SELECT {col_list} FROM {full_table}{where_clause}{order_by}");
            oracle_rownum_page_sql(&col_list, base_sql, offset, limit)
        }
        DatabaseType::SqlServer | DatabaseType::Dameng => {
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
        DatabaseType::Oracle => {
            let base_sql = format!("SELECT {col_list} FROM {full_table}{where_clause} ORDER BY {order}");
            oracle_rownum_page_sql(&col_list, base_sql, 0, limit)
        }
        DatabaseType::SqlServer | DatabaseType::Dameng => {
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

async fn find_mongo_documents_extended_json(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
    offset: u64,
    batch_size: usize,
) -> Result<MongoDocumentResult, String> {
    crate::mongo_ops::mongo_find_documents_extended_json_core(
        state,
        connection_id,
        database,
        collection,
        offset,
        batch_size as i64,
        None,
        None,
        Some(r#"{"_id":1}"#),
    )
    .await
}

async fn find_mongo_documents_for_rows(
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

async fn insert_mongo_documents_extended_json_for_transfer(
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
    match crate::mongo_ops::mongo_insert_documents_extended_json_core(
        state,
        connection_id,
        database,
        collection,
        &docs_json,
    )
    .await
    {
        Ok(count) => Ok(count),
        Err(error) if error.to_ascii_lowercase().contains("legacy agent") => {
            insert_mongo_documents_for_transfer(state, connection_id, database, collection, documents).await
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
                enum_values: None,
                ..Default::default()
            }
        })
        .collect()
}

pub async fn execute_on_pool(state: &AppState, pool_key: &str, sql: &str) -> Result<db::QueryResult, String> {
    execute_on_pool_with_options(state, pool_key, sql, None, TransferExecutionSafety::WriteNoReplay).await
}

pub async fn execute_read_on_pool(state: &AppState, pool_key: &str, sql: &str) -> Result<db::QueryResult, String> {
    execute_read_on_pool_with_max_rows(state, pool_key, sql, None).await
}

pub async fn execute_read_on_pool_with_max_rows(
    state: &AppState,
    pool_key: &str,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<db::QueryResult, String> {
    execute_on_pool_with_options(state, pool_key, sql, max_rows, TransferExecutionSafety::ReadOnlyRetryable).await
}

async fn execute_transfer_ddl_on_pool(
    state: &AppState,
    pool_key: &str,
    sql: &str,
    db_type: &DatabaseType,
) -> Result<(), String> {
    for statement in transfer_ddl_statements(sql, db_type) {
        execute_on_pool(state, pool_key, &statement).await?;
    }
    Ok(())
}

fn transfer_table_already_exists_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("already exists")
        || lower.contains("there is already")
        || lower.contains("duplicate_table")
        || lower.contains("42p07")
        || error.contains("已经存在")
        || error.contains("已存在")
}

fn transfer_create_table_created(result: Result<(), String>, error_prefix: &str) -> Result<bool, String> {
    match result {
        Ok(_) => Ok(true),
        Err(e) if transfer_table_already_exists_error(&e) => Ok(false),
        Err(e) => Err(format!("{error_prefix}: {e}")),
    }
}

fn transfer_ddl_statements(sql: &str, db_type: &DatabaseType) -> Vec<String> {
    if is_postgres_transfer_dialect(db_type) {
        let statements = split_sql_statements(sql);
        if statements.is_empty() {
            vec![sql.trim().to_string()]
        } else {
            statements
                .into_iter()
                .map(|statement| sanitize_postgres_transfer_ddl_statement(&statement))
                .filter(|statement| !is_postgres_post_table_index_statement(statement))
                .collect()
        }
    } else {
        vec![sql.to_string()]
    }
}

fn sanitize_postgres_transfer_ddl_statement(statement: &str) -> String {
    if !statement.trim_start().to_ascii_uppercase().starts_with("CREATE TABLE ") {
        return statement.to_string();
    }

    let mut lines: Vec<String> = Vec::new();
    for line in statement.lines() {
        if line.to_ascii_uppercase().contains(" FOREIGN KEY ") {
            if let Some(previous) = lines.last_mut() {
                let trimmed_len = previous.trim_end_matches(char::is_whitespace).len();
                if previous[..trimmed_len].ends_with(',') {
                    previous.truncate(trimmed_len - 1);
                }
            }
            continue;
        }
        lines.push(line.to_string());
    }
    lines.join("\n")
}

fn is_postgres_post_table_index_statement(statement: &str) -> bool {
    let normalized = statement.trim_start().to_ascii_uppercase();
    normalized.starts_with("CREATE INDEX ")
        || normalized.starts_with("CREATE UNIQUE INDEX ")
        || normalized.starts_with("COMMENT ON INDEX ")
}

pub async fn execute_on_pool_with_max_rows(
    state: &AppState,
    pool_key: &str,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<db::QueryResult, String> {
    execute_on_pool_with_options(state, pool_key, sql, max_rows, TransferExecutionSafety::WriteNoReplay).await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TransferExecutionSafety {
    ReadOnlyRetryable,
    WriteNoReplay,
}

fn transfer_pool_error_action(
    safety: TransferExecutionSafety,
    db_type: Option<DatabaseType>,
    err: &str,
) -> PoolErrorAction {
    match (safety, pool_error_action(db_type, err)) {
        (TransferExecutionSafety::WriteNoReplay, PoolErrorAction::ReconnectAndRetry) => PoolErrorAction::Discard,
        (_, action) => action,
    }
}

async fn transfer_pool_context(
    state: &AppState,
    pool_key: &str,
) -> (Option<String>, Option<String>, Option<DatabaseType>) {
    let configs = state.configs.read().await;
    let config = config_for_pool_key(pool_key, &configs);
    (
        config.map(|config| config.id.clone()),
        database_from_pool_key(pool_key).map(str::to_string),
        config.map(|config| config.db_type),
    )
}

fn client_session_id_from_pool_key(pool_key: &str) -> Option<&str> {
    pool_key.split_once(":session:").map(|(_, session)| session).filter(|session| !session.is_empty())
}

async fn execute_on_pool_with_options(
    state: &AppState,
    pool_key: &str,
    sql: &str,
    max_rows: Option<usize>,
    safety: TransferExecutionSafety,
) -> Result<db::QueryResult, String> {
    let (connection_id, database, db_type) = transfer_pool_context(state, pool_key).await;
    let client_session_id = client_session_id_from_pool_key(pool_key).map(str::to_string);
    let mut current_pool_key = pool_key.to_string();

    for attempt in 0..2 {
        let result = execute_on_pool_once(state, &current_pool_key, sql, max_rows).await;
        let Some(error) = result.as_ref().err() else {
            return result;
        };

        match transfer_pool_error_action(safety, db_type, error) {
            PoolErrorAction::Keep => return result,
            PoolErrorAction::Discard => {
                state.remove_pool_by_key(&current_pool_key).await;
                return result;
            }
            PoolErrorAction::ReconnectAndRetry if attempt == 0 => {
                let Some(connection_id) = connection_id.as_deref() else {
                    state.remove_pool_by_key(&current_pool_key).await;
                    return result;
                };
                current_pool_key = state
                    .reconnect_pool_for_session(connection_id, database.as_deref(), client_session_id.as_deref())
                    .await?;
            }
            PoolErrorAction::ReconnectAndRetry => {
                state.remove_pool_by_key(&current_pool_key).await;
                return result;
            }
        }
    }

    unreachable!("transfer pool execution retry loop runs at most twice")
}

async fn execute_on_pool_once(
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
            let result = db::sqlserver::execute_query_with_max_rows(&mut client, sql, max_rows).await;
            drop(client);
            result
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
        return client.get_columns(&database, &schema, &table, None).await;
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

async fn get_postgres_owned_sequences_for_transfer(
    state: &AppState,
    pool_key: &str,
    schema: &str,
    tables: &[String],
) -> Result<Vec<PostgresOwnedSequence>, String> {
    if tables.is_empty() {
        return Ok(Vec::new());
    }

    let pool = {
        let connections = state.connections.read().await;
        match connections.get(pool_key) {
            Some(PoolKind::Postgres(pool)) => pool.clone(),
            _ => return Ok(Vec::new()),
        }
    };
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let rows = client
        .query(
            "SELECT c.relname, \
              t.relname, \
              a.attname \
             FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             LEFT JOIN pg_sequence s ON s.seqrelid = c.oid \
             JOIN pg_depend d ON d.classid = 'pg_class'::regclass \
               AND d.objid = c.oid \
               AND d.refclassid = 'pg_class'::regclass \
               AND d.deptype IN ('a', 'i') \
             JOIN pg_class t ON t.oid = d.refobjid \
             JOIN pg_namespace tn ON tn.oid = t.relnamespace AND tn.nspname = n.nspname \
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid \
             WHERE c.relkind = 'S' AND n.nspname = $1 \
             ORDER BY t.relname, c.relname",
            &[&schema],
        )
        .await
        .map_err(|e| e.to_string())?;

    let selected: HashSet<&str> = tables.iter().map(String::as_str).collect();
    Ok(rows
        .iter()
        .filter_map(|row| {
            let owner_table = row.get::<_, String>(1);
            if !selected.contains(owner_table.as_str()) {
                return None;
            }
            Some(PostgresOwnedSequence {
                name: row.get::<_, String>(0),
                owner_table,
                owner_column: row.get::<_, String>(2),
            })
        })
        .collect())
}

async fn get_postgres_sequence_snapshots_for_transfer(
    state: &AppState,
    pool_key: &str,
    schema: &str,
) -> Result<Vec<PostgresSequenceSnapshot>, String> {
    let pool = {
        let connections = state.connections.read().await;
        match connections.get(pool_key) {
            Some(PoolKind::Postgres(pool)) => pool.clone(),
            _ => return Ok(Vec::new()),
        }
    };
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let rows = client
        .query(
            "SELECT c.relname, \
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
             LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid \
             WHERE c.relkind = 'S' AND n.nspname = $1 \
             ORDER BY c.relname",
            &[&schema],
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| PostgresSequenceSnapshot {
            name: row.get::<_, String>(0),
            owner_table: row.get::<_, Option<String>>(1),
            owner_column: row.get::<_, Option<String>>(2),
        })
        .collect())
}

/// Create owned PostgreSQL sequences before executing reused table DDL because
/// serial defaults still reference `nextval('...')` in `CREATE TABLE`.
async fn prepare_postgres_owned_sequences_for_transfer(
    state: &AppState,
    request: &TransferRequest,
    table: &str,
    target_table: &str,
    source_pool_key: &str,
    target_pool_key: &str,
    pg_compat_transfer: bool,
    preserves_target_table_name: bool,
    target_table_preexisting: bool,
) -> Result<Vec<PostgresOwnedSequence>, String> {
    if !(request.create_table && pg_compat_transfer && preserves_target_table_name && !target_table_preexisting) {
        return Ok(Vec::new());
    }

    let owned_sequences =
        get_postgres_owned_sequences_for_transfer(state, source_pool_key, &request.source_schema, &[table.to_string()])
            .await?;
    if owned_sequences.is_empty() {
        return Ok(Vec::new());
    }

    let existing_sequences =
        get_postgres_sequence_snapshots_for_transfer(state, target_pool_key, &request.target_schema)
            .await?
            .into_iter()
            .map(|sequence| (sequence.name.clone(), sequence))
            .collect::<HashMap<_, _>>();

    for sequence in &owned_sequences {
        let should_create = validate_existing_postgres_sequence(
            sequence,
            existing_sequences.get(&sequence.name),
            &request.target_schema,
        )?;
        if should_create {
            let create_sql = format!(
                "CREATE SEQUENCE IF NOT EXISTS {}",
                postgres_sequence_qualified_name(&request.target_schema, &sequence.name)
            );
            execute_on_pool(state, target_pool_key, &create_sql)
                .await
                .map_err(|e| format!("Failed to create PostgreSQL sequence for {target_table}: {e}"))?;
        }
    }

    Ok(owned_sequences)
}

/// Bind created or reused sequences after the table exists so
/// `pg_get_serial_sequence(...)` can find them during later sequence sync.
async fn bind_postgres_owned_sequences_for_transfer(
    state: &AppState,
    request: &TransferRequest,
    target_table: &str,
    target_pool_key: &str,
    owned_sequences: &[PostgresOwnedSequence],
) -> Result<(), String> {
    for sequence in owned_sequences {
        let owner_sql = format!(
            "ALTER SEQUENCE {} OWNED BY {}.{}",
            postgres_sequence_qualified_name(&request.target_schema, &sequence.name),
            qualified_table(&sequence.owner_table, &request.target_schema, &DatabaseType::Postgres),
            quote_identifier(&sequence.owner_column, &DatabaseType::Postgres)
        );
        execute_on_pool(state, target_pool_key, &owner_sql)
            .await
            .map_err(|e| format!("Failed to bind PostgreSQL sequence for {target_table}: {e}"))?;
    }
    Ok(())
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
            editable: None,
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
        sources.push(db::ObjectSource {
            name,
            object_type: kind,
            schema: Some(schema.to_string()),
            source,
            editable: None,
        });
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
) -> Result<Vec<PostgresOwnershipStatement>, String> {
    let table_list = tables.iter().map(|table| quote_string_literal(table)).collect::<Vec<_>>().join(", ");
    let table_filter = if tables.is_empty() { "FALSE".to_string() } else { format!("c.relname IN ({table_list})") };
    let sql = format!(
        "WITH relation_owners AS ( \
             SELECT CASE c.relkind \
                      WHEN 'm' THEN format('ALTER MATERIALIZED VIEW %I.%I OWNER TO ', {target_schema}, c.relname) \
                      WHEN 'v' THEN format('ALTER VIEW %I.%I OWNER TO ', {target_schema}, c.relname) \
                      WHEN 'f' THEN format('ALTER FOREIGN TABLE %I.%I OWNER TO ', {target_schema}, c.relname) \
                      WHEN 'S' THEN format('ALTER SEQUENCE %I.%I OWNER TO ', {target_schema}, c.relname) \
                      ELSE format('ALTER TABLE %I.%I OWNER TO ', {target_schema}, c.relname) \
                    END AS stmt_prefix, \
                    pg_get_userbyid(c.relowner) AS owner_name \
             FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = {source_schema} AND (c.relkind IN ('v','m') OR ({table_filter} AND c.relkind IN ('r','p','f','S'))) \
         ), \
         routine_owners AS ( \
             SELECT format('ALTER %s %I.%I(%s) OWNER TO ', \
                           CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, \
                           {target_schema}, p.proname, pg_get_function_identity_arguments(p.oid)) AS stmt_prefix, \
                    pg_get_userbyid(p.proowner) AS owner_name \
             FROM pg_catalog.pg_proc p \
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
             WHERE n.nspname = {source_schema} AND p.prokind IN ('p','f') \
         ), \
         type_owners AS ( \
             SELECT format('ALTER %s %I.%I OWNER TO ', \
                           CASE t.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, \
                           {target_schema}, t.typname) AS stmt_prefix, \
                    pg_get_userbyid(t.typowner) AS owner_name \
             FROM pg_catalog.pg_type t \
             JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace \
             WHERE n.nspname = {source_schema} AND t.typtype IN ('e','d') \
         ) \
         SELECT stmt_prefix, owner_name FROM ( \
             SELECT format('ALTER SCHEMA %I OWNER TO ', {target_schema}) AS stmt_prefix, \
                    pg_get_userbyid(n.nspowner) AS owner_name \
             FROM pg_catalog.pg_namespace n WHERE n.nspname = {source_schema} \
             UNION ALL SELECT stmt_prefix, owner_name FROM relation_owners \
             UNION ALL SELECT stmt_prefix, owner_name FROM routine_owners \
             UNION ALL SELECT stmt_prefix, owner_name FROM type_owners \
         ) statements \
         WHERE stmt_prefix IS NOT NULL AND owner_name IS NOT NULL",
        source_schema = quote_string_literal(source_schema),
        target_schema = quote_string_literal(target_schema),
        table_filter = table_filter,
    );
    Ok(result_rows_to_postgres_ownership_statements(execute_on_pool(state, pool_key, &sql).await?.rows))
}

fn distinct_postgres_ownership_roles(statements: &[PostgresOwnershipStatement]) -> Vec<String> {
    let mut roles = statements.iter().map(|statement| statement.owner.clone()).collect::<Vec<_>>();
    roles.sort();
    roles.dedup();
    roles
}

async fn get_postgres_current_user(state: &AppState, target_pool_key: &str) -> Result<String, String> {
    let rows = execute_on_pool(state, target_pool_key, "SELECT current_user").await?.rows;
    rows.first()
        .and_then(|row| json_string_cell(row, 0))
        .filter(|user| !user.trim().is_empty())
        .ok_or_else(|| "Failed to read target PostgreSQL current user".to_string())
}

async fn get_existing_postgres_roles(
    state: &AppState,
    target_pool_key: &str,
    roles: &[String],
) -> Result<HashSet<String>, String> {
    if roles.is_empty() {
        return Ok(HashSet::new());
    }
    let role_list = roles.iter().map(|role| quote_string_literal(role)).collect::<Vec<_>>().join(", ");
    let sql = format!("SELECT rolname FROM pg_catalog.pg_roles WHERE rolname IN ({role_list})");
    let rows = execute_on_pool(state, target_pool_key, &sql).await?.rows;
    Ok(rows.into_iter().filter_map(|row| json_string_cell(&row, 0)).collect())
}

fn build_postgres_ownership_statement(statement: &PostgresOwnershipStatement, owner: &str) -> String {
    format!("{}{}", statement.sql_prefix, quote_identifier(owner, &DatabaseType::Postgres))
}

pub async fn preview_transfer_ownership(
    state: &AppState,
    request: &TransferRequest,
    source_db_type: &DatabaseType,
    target_db_type: &DatabaseType,
    source_pool_key: &str,
    target_pool_key: &str,
) -> Result<TransferOwnershipPreview, String> {
    if !request.create_table || !is_postgres_compat_transfer(source_db_type, target_db_type) {
        return Ok(TransferOwnershipPreview { missing_owners: Vec::new(), target_owner: String::new() });
    }

    let statements = get_postgres_ownership_statements_for_transfer(
        state,
        source_pool_key,
        &request.source_schema,
        &request.target_schema,
        &request.tables,
    )
    .await?;
    let roles = distinct_postgres_ownership_roles(&statements);
    let existing_roles = get_existing_postgres_roles(state, target_pool_key, &roles).await?;
    let missing_owners = roles.into_iter().filter(|role| !existing_roles.contains(role)).collect::<Vec<_>>();
    let target_owner = if missing_owners.is_empty() {
        String::new()
    } else {
        get_postgres_current_user(state, target_pool_key).await?
    };

    Ok(TransferOwnershipPreview { missing_owners, target_owner })
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
                 string_agg(privilege_type, ', ' ORDER BY privilege_type), \
                 CASE WHEN relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, \
                 {target_schema}, relname, \
                 CASE WHEN grantee = 0 THEN 'PUBLIC' ELSE quote_ident(rolname) END, \
                 CASE WHEN bool_or(is_grantable) THEN ' WITH GRANT OPTION' ELSE '' END \
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
                 string_agg(privilege_type, ', ' ORDER BY privilege_type), \
                 CASE WHEN prokind = 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, \
                 {target_schema}, proname, identity_args, \
                 CASE WHEN grantee = 0 THEN 'PUBLIC' ELSE quote_ident(rolname) END, \
                 CASE WHEN bool_or(is_grantable) THEN ' WITH GRANT OPTION' ELSE '' END \
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

/// Sort table names by foreign key dependency.
///
/// When `parents_first` is true (data transfer / SQL export), referenced (parent)
/// tables come before referencing (child) tables so inserts don't violate FK
/// constraints.
///
/// When `parents_first` is false (batch drop), referencing (child) tables come
/// first so they are dropped before the tables they reference.
///
/// Uses Kahn's algorithm for topological sort; tables involved in cycles keep
/// their original relative order after all cycle-free tables.
pub async fn sort_tables_by_fk_dependency(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    tables: &[String],
    parents_first: bool,
) -> Result<Vec<String>, String> {
    if tables.len() <= 1 {
        return Ok(tables.to_vec());
    }

    let table_set: HashSet<&str> = tables.iter().map(|t| t.as_str()).collect();

    // Gather FK relationships for every table.
    let mut dependency_map: HashMap<String, Vec<String>> = HashMap::new();
    for table in tables {
        let fks = crate::schema::list_foreign_keys_core(state, connection_id, database, schema, table).await?;
        let deps: Vec<String> = fks
            .iter()
            .map(|fk| fk.ref_table.clone())
            .filter(|ref_table| table_set.contains(ref_table.as_str()))
            .collect();
        dependency_map.insert(table.clone(), deps);
    }

    // Build in-degree and dependents graph.
    // parents_first=true:  edge ref_table → table     (parent before child)
    // parents_first=false: edge table → ref_table      (child before parent)
    let mut in_degree: HashMap<&str, usize> = HashMap::new();
    let mut dependents: HashMap<&str, Vec<&str>> = HashMap::new();

    for table in tables {
        in_degree.entry(table.as_str()).or_insert(0);
    }
    for table in tables {
        if let Some(deps) = dependency_map.get(table) {
            for ref_table in deps {
                if parents_first {
                    // FK-bearing table depends on ref_table — parent comes first.
                    *in_degree.entry(table.as_str()).or_insert(0) += 1;
                    dependents.entry(ref_table.as_str()).or_default().push(table.as_str());
                } else {
                    // ref_table depends on FK-bearing table — child comes first.
                    *in_degree.entry(ref_table.as_str()).or_insert(0) += 1;
                    dependents.entry(table.as_str()).or_default().push(ref_table.as_str());
                }
            }
        }
    }

    // Kahn's algorithm.
    let mut queue: std::collections::VecDeque<&str> =
        in_degree.iter().filter(|(_, &deg)| deg == 0).map(|(&table, _)| table).collect();

    let mut sorted: Vec<String> = Vec::new();
    while let Some(table) = queue.pop_front() {
        sorted.push(table.to_string());
        if let Some(deps) = dependents.get(table) {
            for &dependent in deps {
                let deg = in_degree.get_mut(dependent).unwrap();
                *deg -= 1;
                if *deg == 0 {
                    queue.push_back(dependent);
                }
            }
        }
    }

    // Append any tables left behind by cycles in their original order.
    if sorted.len() < tables.len() {
        let sorted_set: HashSet<&str> = sorted.iter().map(|s| s.as_str()).collect();
        let mut remaining: Vec<String> = Vec::new();
        for table in tables {
            if !sorted_set.contains(table.as_str()) {
                remaining.push(table.clone());
            }
        }
        sorted.extend(remaining);
    }

    Ok(sorted)
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
    let ResolvedTransferTargetTable { name: target_table, preexisting: target_table_preexisting } =
        resolve_transfer_target_table_name(state, request, table, target_pool_key, target_db_type).await;
    let batch_size = if request.batch_size == 0 { 1000 } else { request.batch_size };
    let mut offset: u64 = 0;
    let mut total_transferred: u64 = 0;
    let mut total_rows = None;

    if request.mode == TransferMode::Upsert {
        log::warn!("[transfer] MongoDB upsert is not supported yet, falling back to append");
    }

    if is_mongodb_transfer_type(target_db_type) && request.mode == TransferMode::Overwrite {
        overwrite_mongo_collection_for_transfer(
            state,
            &request.target_connection_id,
            &request.target_database,
            &target_table,
        )
        .await
        .map_err(|e| format!("Failed to clear MongoDB collection '{target_table}': {e}"))?;
    }

    let mut sql_target_column_names: Vec<String> = Vec::new();
    let mut sql_target_column_types: Vec<Option<String>> = Vec::new();
    let mut sql_target_prepared = false;

    loop {
        if is_cancelled(&request.transfer_id).await {
            return Err("Cancelled".to_string());
        }

        let documents = if is_mongodb_transfer_type(source_db_type) {
            let result = if is_mongodb_transfer_type(target_db_type) {
                find_mongo_documents_extended_json(
                    state,
                    &request.source_connection_id,
                    &request.source_database,
                    table,
                    offset,
                    batch_size,
                )
                .await?
            } else {
                find_mongo_documents_for_rows(
                    state,
                    &request.source_connection_id,
                    &request.source_database,
                    table,
                    offset,
                    batch_size,
                )
                .await?
            };
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
            if is_mongodb_transfer_type(source_db_type) {
                insert_mongo_documents_extended_json_for_transfer(
                    state,
                    &request.target_connection_id,
                    &request.target_database,
                    &target_table,
                    &documents,
                )
                .await
            } else {
                insert_mongo_documents_for_transfer(
                    state,
                    &request.target_connection_id,
                    &request.target_database,
                    &target_table,
                    &documents,
                )
                .await
            }
            .map_err(|e| format!("Insert failed for MongoDB collection '{target_table}' at offset {offset}: {e}"))?;
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
                        enum_values: None,
                        ..Default::default()
                    });
                }
                sql_target_column_names = sql_target_columns.iter().map(|column| column.name.clone()).collect();
                sql_target_column_types =
                    sql_target_columns.iter().map(|column| Some(column.data_type.clone())).collect();

                if request.create_table {
                    if !target_table_preexisting {
                        let ddl = generate_create_table_ddl(
                            &sql_target_columns,
                            &target_table,
                            &request.source_schema,
                            &request.target_schema,
                            target_db_type,
                            source_db_type,
                            None,
                        );
                        let target_table_created = transfer_create_table_created(
                            execute_on_pool(state, target_pool_key, &ddl).await.map(|_| ()),
                            &format!("Failed to create table from MongoDB collection '{table}'"),
                        )?;
                        if target_table_created {
                            for stmt in generate_comment_ddl(
                                &sql_target_columns,
                                &target_table,
                                &request.target_schema,
                                target_db_type,
                                None,
                            ) {
                                if let Err(e) = execute_on_pool(state, target_pool_key, &stmt).await {
                                    log::warn!(
                                        "[transfer] failed to set MongoDB transfer column comment for {}: {}",
                                        target_table,
                                        e
                                    );
                                }
                            }
                        }
                    } else {
                        log::info!(
                            "[transfer] target table {} already exists, skipping create-table DDL",
                            target_table
                        );
                    }
                }

                if request.mode == TransferMode::Overwrite {
                    let full_table = qualified_table(&target_table, &request.target_schema, target_db_type);
                    let truncate_sql = match target_db_type {
                        DatabaseType::Sqlite | DatabaseType::CloudflareD1 | DatabaseType::DuckDb => {
                            format!("DELETE FROM {full_table}")
                        }
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
                &target_table,
                &request.target_schema,
                target_db_type,
                &[],
            );
            for (statement_index, batch_sql) in write_statements.iter().enumerate() {
                execute_on_pool(state, target_pool_key, batch_sql).await.map_err(|e| {
                    format!(
                        "Insert failed for MongoDB collection '{target_table}' at offset {offset}, chunk {} of {}: {e}",
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
            terminal: false,
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
    let ResolvedTransferTargetTable { name: target_table, preexisting: mut target_table_preexisting } =
        resolve_transfer_target_table_name(state, request, table, target_pool_key, target_db_type).await;
    let preserves_target_table_name = target_table == table;

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

    let writable_columns = writable_transfer_columns(&columns, source_db_type, target_db_type);
    if writable_columns.is_empty() {
        return Err(format!("No writable columns found for table {table}"));
    }

    let col_names: Vec<String> = writable_columns.iter().map(|c| c.name.clone()).collect();
    let col_types: Vec<Option<String>> = writable_columns.iter().map(|c| Some(c.data_type.clone())).collect();
    let primary_key_columns: Vec<String> =
        writable_columns.iter().filter(|c| c.is_primary_key).map(|c| c.name.clone()).collect();
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
        None,
    )
    .await
    .unwrap_or_default()
    .into_iter()
    .next()
    .and_then(|t| t.comment);

    let source_indexes =
        if request.create_table && pg_compat_transfer && preserves_target_table_name && !target_table_preexisting {
            get_postgres_indexes_for_transfer(state, source_pool_key, &request.source_schema, table).await?
        } else {
            Vec::new()
        };
    let source_foreign_keys =
        if request.create_table && pg_compat_transfer && preserves_target_table_name && !target_table_preexisting {
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
        if is_postgres_transfer_dialect(target_db_type) && !request.target_schema.trim().is_empty() {
            let create_schema_sql =
                format!("CREATE SCHEMA IF NOT EXISTS {}", quote_identifier(&request.target_schema, target_db_type));
            execute_on_pool(state, target_pool_key, &create_schema_sql)
                .await
                .map_err(|e| format!("Failed to ensure schema exists: {e}"))?;
        }
        if target_table_preexisting {
            log::info!("[transfer] target table {} already exists, skipping create-table DDL", target_table);
        } else {
            let owned_sequences = prepare_postgres_owned_sequences_for_transfer(
                state,
                request,
                table,
                &target_table,
                source_pool_key,
                target_pool_key,
                pg_compat_transfer,
                preserves_target_table_name,
                target_table_preexisting,
            )
            .await?;
            let can_reuse_source_ddl =
                can_reuse_source_table_ddl(source_db_type, target_db_type, preserves_target_table_name);
            let ddl = if can_reuse_source_ddl {
                let source_ddl = crate::schema::get_table_ddl_core(
                    &state,
                    &request.source_connection_id,
                    &request.source_database,
                    &request.source_schema,
                    table,
                    None,
                )
                .await
                .unwrap_or_else(|_| {
                    generate_create_table_ddl(
                        &columns,
                        &target_table,
                        &request.source_schema,
                        &request.target_schema,
                        target_db_type,
                        source_db_type,
                        table_comment.as_deref(),
                    )
                });
                rewrite_transfer_source_table_ddl(
                    &source_ddl,
                    &request.source_schema,
                    &request.target_schema,
                    source_db_type,
                    target_db_type,
                )
            } else {
                generate_create_table_ddl(
                    &columns,
                    &target_table,
                    &request.source_schema,
                    &request.target_schema,
                    target_db_type,
                    source_db_type,
                    table_comment.as_deref(),
                )
            };
            log::info!("[transfer] creating target table: {}", ddl.chars().take(200).collect::<String>());
            let target_table_created = transfer_create_table_created(
                execute_transfer_ddl_on_pool(state, target_pool_key, &ddl, target_db_type).await,
                "Failed to create table",
            )?;
            if target_table_created {
                let comment_stmts = generate_comment_ddl(
                    &columns,
                    &target_table,
                    &request.target_schema,
                    target_db_type,
                    table_comment.as_deref(),
                );
                for stmt in &comment_stmts {
                    if let Err(e) = execute_on_pool(state, target_pool_key, stmt).await {
                        log::warn!("[transfer] failed to set column comment for {}: {}", target_table, e);
                    }
                }
                bind_postgres_owned_sequences_for_transfer(
                    state,
                    request,
                    &target_table,
                    target_pool_key,
                    &owned_sequences,
                )
                .await?;
            } else {
                // DDL may report the table already exists even when metadata
                // lookup missed it (case/schema differences or localized errors).
                target_table_preexisting = true;
            }
        }
    }

    // Truncate target if overwrite mode
    if request.mode == TransferMode::Overwrite {
        let full_table = qualified_table(&target_table, &request.target_schema, target_db_type);
        let truncate_sql = match target_db_type {
            DatabaseType::Sqlite | DatabaseType::CloudflareD1 | DatabaseType::DuckDb => {
                format!("DELETE FROM {full_table}")
            }
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
                &target_table,
            )
            .await
            .unwrap_or_default();
            let pks: Vec<String> = target_columns
                .iter()
                .filter(|c| c.is_primary_key && col_names.iter().any(|name| name.eq_ignore_ascii_case(&c.name)))
                .map(|c| c.name.clone())
                .collect();
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

    let writes_dameng_identity_columns = if matches!(target_db_type, DatabaseType::Dameng) {
        let target_columns = get_columns_for_transfer(
            state,
            target_pool_key,
            &request.target_connection_id,
            &request.target_database,
            &request.target_schema,
            &target_table,
        )
        .await
        .unwrap_or_default();
        selected_columns_include_identity_columns(&col_names, &target_columns)
    } else {
        false
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
            &target_table,
            &request.target_schema,
            target_db_type,
            &pk_columns,
        );
        for (statement_index, batch_sql) in write_statements.iter().enumerate() {
            execute_transfer_write_statement(
                state,
                target_pool_key,
                batch_sql,
                target_db_type,
                &target_table,
                &request.target_schema,
                writes_dameng_identity_columns,
            )
            .await
            .map_err(|e| {
                let absolute_row = parse_mysql_row_error(&e).map(|row| offset + row);
                match absolute_row {
                    Some(row) => format!(
                        "Insert failed for table '{target_table}' at row {row} (chunk {} of {}): {e}",
                        statement_index + 1,
                        write_statements.len()
                    ),
                    None => format!(
                        "Insert failed for table '{target_table}' at offset {offset}, chunk {} of {}: {e}",
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
            terminal: false,
        });

        if row_count < batch_size {
            break;
        }
    }

    if pg_compat_transfer {
        for statement in generate_postgres_sequence_sync_sql(&columns, &target_table, &request.target_schema) {
            execute_on_pool(state, target_pool_key, &statement)
                .await
                .map_err(|e| format!("Failed to sync PostgreSQL sequence for {target_table}: {e}"))?;
        }
    }

    if request.create_table && pg_compat_transfer && preserves_target_table_name && !target_table_preexisting {
        for statement in generate_postgres_index_ddl(&source_indexes, &target_table, &request.target_schema) {
            execute_on_pool(state, target_pool_key, &statement)
                .await
                .map_err(|e| format!("Failed to create PostgreSQL index for {target_table}: {e}"))?;
        }
        for statement in generate_postgres_foreign_key_ddl(
            &source_foreign_keys,
            &target_table,
            &request.source_schema,
            &request.target_schema,
        ) {
            execute_on_pool(state, target_pool_key, &statement)
                .await
                .map_err(|e| format!("Failed to create PostgreSQL foreign key for {target_table}: {e}"))?;
        }
    }

    Ok(total_transferred)
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
        let schema_exists =
            execute_on_pool(state, target_pool_key, &postgres_schema_exists_sql(&request.target_schema))
                .await
                .map_err(|e| format!("Failed to check PostgreSQL target schema: {e}"))?;
        if !query_result_has_rows(&schema_exists) {
            // CREATE SCHEMA requires database-level CREATE privilege even with
            // IF NOT EXISTS, so only issue it after confirming the schema is absent.
            let create_schema_sql =
                format!("CREATE SCHEMA {}", quote_identifier(&request.target_schema, &DatabaseType::Postgres));
            execute_on_pool(state, target_pool_key, &create_schema_sql)
                .await
                .map_err(|e| format!("Failed to create PostgreSQL target schema: {e}"))?;
        }
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
            terminal: false,
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
            terminal: false,
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
            terminal: false,
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
    let ownership_statements = if matches!(request.ownership_policy, TransferOwnershipPolicy::Skip) {
        Vec::new()
    } else {
        get_postgres_ownership_statements_for_transfer(
            state,
            source_pool_key,
            &request.source_schema,
            &request.target_schema,
            &request.tables,
        )
        .await?
    };
    let ownership_existing_roles = if matches!(request.ownership_policy, TransferOwnershipPolicy::ReassignMissing) {
        let roles = distinct_postgres_ownership_roles(&ownership_statements);
        get_existing_postgres_roles(state, target_pool_key, &roles).await?
    } else {
        HashSet::new()
    };
    let ownership_target_user = if matches!(request.ownership_policy, TransferOwnershipPolicy::ReassignMissing)
        && !ownership_statements.is_empty()
    {
        Some(get_postgres_current_user(state, target_pool_key).await?)
    } else {
        None
    };
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
            terminal: false,
        });

        let rewritten_source = match object.object_type {
            db::ObjectSourceKind::View | db::ObjectSourceKind::MaterializedView => object.source.clone(),
            db::ObjectSourceKind::Procedure | db::ObjectSourceKind::Function => {
                rewrite_postgres_routine_schema(&object.source, &request.source_schema, &request.target_schema)
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
                terminal: false,
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
            terminal: false,
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
            terminal: false,
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
            terminal: false,
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
            terminal: false,
        });
        let ownership_owner = if matches!(request.ownership_policy, TransferOwnershipPolicy::ReassignMissing)
            && !ownership_existing_roles.contains(&statement.owner)
        {
            ownership_target_user
                .as_deref()
                .ok_or_else(|| "Failed to read target PostgreSQL current user".to_string())?
        } else {
            &statement.owner
        };
        let ownership_sql = build_postgres_ownership_statement(&statement, ownership_owner);
        execute_on_pool(state, target_pool_key, &ownership_sql)
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
            terminal: false,
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
            agent_java_options: Vec::new(),
            host: ":memory:".to_string(),
            port: 0,
            username: String::new(),
            password: String::new(),
            database: None,
            visible_databases: None,
            visible_schemas: None,
            attached_databases: Vec::new(),
            init_script: None,
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
            redis_scan_page_size: None,
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: false,
            is_production: false,
            production_databases: vec![],
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
            enum_values: None,
            ..Default::default()
        }
    }

    fn test_table(name: &str) -> db::TableInfo {
        db::TableInfo {
            name: name.to_string(),
            table_type: "TABLE".to_string(),
            comment: None,
            parent_schema: None,
            parent_name: None,
        }
    }

    fn test_query_result(rows: Vec<Vec<serde_json::Value>>) -> db::QueryResult {
        db::QueryResult {
            columns: Vec::new(),
            column_types: Vec::new(),
            column_sortables: Vec::new(),
            rows,
            affected_rows: 0,
            execution_time_ms: 0,
            truncated: false,
            session_id: None,
            has_more: false,
        }
    }

    #[test]
    fn postgres_schema_exists_query_escapes_schema_name() {
        assert_eq!(
            postgres_schema_exists_sql("team's data"),
            "SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'team''s data' LIMIT 1"
        );
    }

    #[test]
    fn postgres_schema_exists_depends_on_returned_rows() {
        assert!(!query_result_has_rows(&test_query_result(Vec::new())));
        assert!(query_result_has_rows(&test_query_result(vec![vec![serde_json::json!(1)]])));
    }

    fn test_transfer_request(tables: Vec<&str>) -> TransferRequest {
        TransferRequest {
            transfer_id: "transfer-1".to_string(),
            source_connection_id: "source".to_string(),
            source_database: "source_db".to_string(),
            source_schema: "source_schema".to_string(),
            target_connection_id: "target".to_string(),
            target_database: "target_db".to_string(),
            target_schema: "target_schema".to_string(),
            tables: tables.into_iter().map(str::to_string).collect(),
            create_table: true,
            mode: TransferMode::Append,
            target_table_name_case: TransferTableNameCase::Preserve,
            ownership_policy: TransferOwnershipPolicy::Preserve,
            batch_size: 1000,
        }
    }

    #[test]
    fn transfer_request_defaults_preserve_table_name_case() {
        let request: TransferRequest = serde_json::from_value(json!({
            "transferId": "transfer-1",
            "sourceConnectionId": "source",
            "sourceDatabase": "source_db",
            "sourceSchema": "source_schema",
            "targetConnectionId": "target",
            "targetDatabase": "target_db",
            "targetSchema": "target_schema",
            "tables": ["ORDERS"],
            "createTable": true,
            "mode": "append",
            "batchSize": 1000
        }))
        .unwrap();

        assert_eq!(request.target_table_name_case, TransferTableNameCase::Preserve);
        assert_eq!(request.target_table_name("ORDERS"), "ORDERS");
    }

    #[test]
    fn transfer_existing_target_table_name_prefers_exact_case() {
        let tables = vec![test_table("orders"), test_table("Orders")];

        assert_eq!(existing_transfer_target_table_name("Orders", &tables, true), Some("Orders".to_string()));
    }

    #[test]
    fn transfer_existing_target_table_name_respects_case_sensitive_targets() {
        let tables = vec![test_table("Orders")];

        assert_eq!(existing_transfer_target_table_name("orders", &tables, false), None);
        assert_eq!(existing_transfer_target_table_name("orders", &tables, true), Some("Orders".to_string()));
    }

    #[test]
    fn transfer_existing_target_table_name_ignores_contains_matches() {
        let tables = vec![test_table("archived_orders"), test_table("orders_backup")];

        assert_eq!(existing_transfer_target_table_name("orders", &tables, true), None);
    }

    #[test]
    fn parses_mysql_lower_case_table_names_values() {
        let string_result = test_query_result(vec![vec![json!("lower_case_table_names"), json!("2")]]);
        let numeric_result = test_query_result(vec![vec![json!("lower_case_table_names"), json!(1)]]);
        let empty_result = test_query_result(Vec::new());

        assert_eq!(mysql_lower_case_table_names_from_result(&string_result), Some(2));
        assert_eq!(mysql_lower_case_table_names_from_result(&numeric_result), Some(1));
        assert_eq!(mysql_lower_case_table_names_from_result(&empty_result), None);
    }

    #[test]
    fn transfer_table_name_case_transforms_target_names() {
        let mut request = test_transfer_request(vec!["ORDERS"]);
        request.target_table_name_case = TransferTableNameCase::Lower;
        assert_eq!(request.target_table_name("ORDERS"), "orders");

        request.target_table_name_case = TransferTableNameCase::Upper;
        assert_eq!(request.target_table_name("orders"), "ORDERS");
    }

    #[test]
    fn transfer_table_name_case_detects_target_collisions() {
        let mut request = test_transfer_request(vec!["ORDERS", "orders"]);
        request.target_table_name_case = TransferTableNameCase::Lower;

        let error = validate_transfer_target_table_names(&request).unwrap_err();
        assert!(error.contains("both map to 'orders'"));
    }

    #[test]
    fn detects_identity_extras_for_selected_columns() {
        assert!(selected_columns_include_identity_extras(
            &[String::from("id"), String::from("name")],
            &[Some(String::from("identity")), None],
        ));
        assert!(selected_columns_include_identity_extras(
            &[String::from("id")],
            &[Some(String::from("auto_increment"))],
        ));
        assert!(!selected_columns_include_identity_extras(
            &[String::from("name")],
            &[None, Some(String::from("identity"))],
        ));
    }

    #[test]
    fn detects_selected_identity_columns_from_target_metadata() {
        let target_columns = vec![
            db::ColumnInfo { extra: Some("identity".to_string()), ..test_column("ID", "INT") },
            test_column("NAME", "VARCHAR(20)"),
        ];

        assert!(selected_columns_include_identity_columns(&[String::from("id")], &target_columns));
        assert!(!selected_columns_include_identity_columns(&[String::from("name")], &target_columns));
    }

    #[test]
    fn sqlserver_writable_transfer_columns_skip_rowversion_types() {
        let columns = vec![
            test_column("id", "int"),
            test_column("TimeSpan", "timestamp"),
            test_column("rv", "ROWVERSION"),
            test_column("name", "nvarchar(64)"),
        ];

        let writable = writable_transfer_columns(&columns, &DatabaseType::SqlServer, &DatabaseType::SqlServer);

        assert_eq!(writable.iter().map(|column| column.name.as_str()).collect::<Vec<_>>(), vec!["id", "name"]);
    }

    #[test]
    fn non_sqlserver_target_writable_transfer_columns_keep_timestamp_type() {
        let columns = vec![test_column("id", "int"), test_column("updated_at", "timestamp")];

        let writable = writable_transfer_columns(&columns, &DatabaseType::Postgres, &DatabaseType::Postgres);
        assert_eq!(writable.iter().map(|column| column.name.as_str()).collect::<Vec<_>>(), vec!["id", "updated_at"]);
    }

    #[test]
    fn sqlserver_target_keeps_timestamp_from_other_source_databases() {
        let columns = vec![test_column("id", "int"), test_column("updated_at", "timestamp")];

        let writable = writable_transfer_columns(&columns, &DatabaseType::Postgres, &DatabaseType::SqlServer);

        assert_eq!(writable.iter().map(|column| column.name.as_str()).collect::<Vec<_>>(), vec!["id", "updated_at"]);
    }

    #[test]
    fn dameng_identity_insert_wrapper_quotes_schema_and_table() {
        let sql = wrap_dameng_identity_insert_sql(
            "INSERT INTO \"SYSDBA\".\"USERS\" (\"ID\") VALUES\n(1);",
            "USERS",
            "SYSDBA",
        );

        assert_eq!(
            sql,
            "SET IDENTITY_INSERT \"SYSDBA\".\"USERS\" ON;\nINSERT INTO \"SYSDBA\".\"USERS\" (\"ID\") VALUES\n(1);\nSET IDENTITY_INSERT \"SYSDBA\".\"USERS\" OFF;"
        );
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
    fn postgres_transfer_ddl_splits_reused_multi_statement_table_ddl() {
        let ddl =
            "CREATE TABLE \"public\".\"items\" (\"id\" integer);\nCOMMENT ON TABLE \"public\".\"items\" IS 'items';";

        let statements = transfer_ddl_statements(ddl, &DatabaseType::Postgres);

        assert_eq!(
            statements,
            vec![
                "CREATE TABLE \"public\".\"items\" (\"id\" integer)".to_string(),
                "COMMENT ON TABLE \"public\".\"items\" IS 'items'".to_string(),
            ]
        );
    }

    #[test]
    fn postgres_transfer_ddl_skips_reused_index_statements() {
        let ddl = "CREATE TABLE \"public\".\"items\" (\"id\" integer);\n\
                   CREATE INDEX \"items_lower_idx\" ON \"public\".\"items\" USING btree (\"lower(name)\");\n\
                   COMMENT ON INDEX \"public\".\"items_lower_idx\" IS 'lookup';";

        let statements = transfer_ddl_statements(ddl, &DatabaseType::Postgres);

        assert_eq!(statements, vec!["CREATE TABLE \"public\".\"items\" (\"id\" integer)".to_string()]);
    }

    #[test]
    fn postgres_transfer_ddl_removes_inline_foreign_keys_from_reused_table_ddl() {
        let ddl = "CREATE TABLE \"public\".\"audit_logs\" (\n  \"id\" integer,\n  \"user_id\" integer,\n  CONSTRAINT \"audit_logs_user_id_fkey\" FOREIGN KEY (\"user_id\") REFERENCES \"users\"(\"id\")\n);";

        let statements = transfer_ddl_statements(ddl, &DatabaseType::Postgres);

        assert_eq!(
            statements,
            vec!["CREATE TABLE \"public\".\"audit_logs\" (\n  \"id\" integer,\n  \"user_id\" integer\n)".to_string()]
        );
    }

    #[test]
    fn transfer_create_table_result_treats_existing_table_as_preexisting() {
        assert_eq!(
            transfer_create_table_created(
                Err("ERROR: relation \"items\" already exists (SQLSTATE 42P07)".to_string()),
                "create"
            )
            .unwrap(),
            false
        );
        assert_eq!(
            transfer_create_table_created(Err("错误: 关系 \"items\" 已经存在".to_string()), "create").unwrap(),
            false
        );
        assert_eq!(transfer_create_table_created(Ok(()), "create").unwrap(), true);
        assert_eq!(
            transfer_create_table_created(Err("permission denied for schema public".to_string()), "create")
                .unwrap_err(),
            "create: permission denied for schema public"
        );
    }

    #[test]
    fn non_postgres_transfer_ddl_keeps_statement_text_intact() {
        let ddl = "CREATE TABLE `items` (`id` int);\nALTER TABLE `items` COMMENT = 'items';";

        assert_eq!(transfer_ddl_statements(ddl, &DatabaseType::Mysql), vec![ddl.to_string()]);
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
    fn clickhouse_create_table_with_pk_uses_order_by_pk() {
        let cols = vec![
            db::ColumnInfo { is_primary_key: true, is_nullable: false, ..test_column("id", "UInt64") },
            db::ColumnInfo { ..test_column("name", "String") },
        ];

        let ddl = generate_create_table_ddl(
            &cols,
            "logs",
            "",
            "",
            &DatabaseType::ClickHouse,
            &DatabaseType::ClickHouse,
            None,
        );

        // Must include ENGINE with ORDER BY using the PK columns
        assert!(ddl.contains("ENGINE = MergeTree() ORDER BY (`id`)"));
        // Must NOT have a separate PRIMARY KEY clause (ORDER BY serves that role)
        assert!(!ddl.contains("PRIMARY KEY"));
    }

    #[test]
    fn clickhouse_create_table_without_pk_uses_order_by_tuple() {
        let cols = vec![db::ColumnInfo { ..test_column("message", "String") }];

        let ddl = generate_create_table_ddl(
            &cols,
            "logs",
            "",
            "",
            &DatabaseType::ClickHouse,
            &DatabaseType::ClickHouse,
            None,
        );

        assert!(ddl.contains("ENGINE = MergeTree() ORDER BY tuple()"));
        assert!(!ddl.contains("PRIMARY KEY"));
    }

    #[test]
    fn clickhouse_transfer_maps_fractional_timestamp_to_datetime64() {
        let cols = vec![db::ColumnInfo { numeric_scale: Some(6), ..test_column("created_at", "TIMESTAMP") }];

        let ddl = generate_create_table_ddl(
            &cols,
            "events",
            "SYSDBA",
            "",
            &DatabaseType::ClickHouse,
            &DatabaseType::Dameng,
            None,
        );

        assert!(ddl.contains("`created_at` DateTime64(6)"), "ddl: {ddl}");
    }

    #[test]
    fn clickhouse_transfer_uses_datetime64_fallback_for_timestamp_types() {
        assert_eq!(map_column_type("datetime", &DatabaseType::Dameng, &DatabaseType::ClickHouse), "DateTime64(6)");
        assert_eq!(map_column_type("timestamp", &DatabaseType::Dameng, &DatabaseType::ClickHouse), "DateTime64(6)");
    }

    #[test]
    fn transfer_reuses_source_table_ddl_only_when_target_shape_matches() {
        assert!(!can_reuse_source_table_ddl(&DatabaseType::ClickHouse, &DatabaseType::ClickHouse, true));
        assert!(can_reuse_source_table_ddl(&DatabaseType::Postgres, &DatabaseType::Postgres, true));
        assert!(!can_reuse_source_table_ddl(&DatabaseType::Postgres, &DatabaseType::Postgres, false));
    }

    #[test]
    fn postgres_transfer_reused_table_ddl_rewrites_target_schema() {
        let ddl =
            "CREATE TABLE \"src\".\"items\" (\"id\" integer);\nCOMMENT ON COLUMN \"src\".\"items\".\"id\" IS 'id';";

        let rewritten =
            rewrite_transfer_source_table_ddl(ddl, "src", "dst", &DatabaseType::Postgres, &DatabaseType::Postgres);

        assert!(rewritten.contains("CREATE TABLE \"dst\".\"items\""));
        assert!(rewritten.contains("COMMENT ON COLUMN \"dst\".\"items\".\"id\""));
        assert!(!rewritten.contains("\"src\".\"items\""));
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
    fn dameng_export_pagination_uses_offset_fetch() {
        let sql = pagination_sql(
            &[String::from("id"), String::from("name")],
            "users",
            "SYSDBA",
            &DatabaseType::Dameng,
            500,
            100,
        );

        assert_eq!(
            sql,
            "SELECT \"id\", \"name\" FROM \"SYSDBA\".\"users\" ORDER BY (SELECT NULL) OFFSET 500 ROWS FETCH NEXT 100 ROWS ONLY"
        );
        assert!(!sql.contains(" LIMIT "));
    }

    #[test]
    fn dameng_ordered_pagination_uses_offset_fetch() {
        let sql = pagination_sql_with_order(
            &[String::from("id"), String::from("name")],
            "users",
            "SYSDBA",
            &DatabaseType::Dameng,
            200,
            100,
            &[String::from("id")],
        );

        assert_eq!(
            sql,
            "SELECT \"id\", \"name\" FROM \"SYSDBA\".\"users\" ORDER BY \"id\" OFFSET 200 ROWS FETCH NEXT 100 ROWS ONLY"
        );
        assert!(!sql.contains(" LIMIT "));
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
    fn dameng_filtered_pagination_preserves_where_and_order() {
        let sql = pagination_sql_with_filter_order(
            &[String::from("id"), String::from("status")],
            "users",
            "SYSDBA",
            &DatabaseType::Dameng,
            10_000,
            2_000,
            Some("WHERE status = 'active'"),
            Some("\"id\" DESC"),
            &[String::from("id")],
        );

        assert_eq!(
            sql,
            "SELECT \"id\", \"status\" FROM \"SYSDBA\".\"users\" WHERE (status = 'active') ORDER BY \"id\" DESC OFFSET 10000 ROWS FETCH NEXT 2000 ROWS ONLY"
        );
        assert!(!sql.contains(" LIMIT "));
    }

    #[test]
    fn oracle_filtered_pagination_uses_rownum_for_legacy_compatibility() {
        let sql = pagination_sql_with_filter_order(
            &[String::from("id"), String::from("status")],
            "users",
            "APP",
            &DatabaseType::Oracle,
            10_000,
            2_000,
            Some("WHERE status = 'active'"),
            Some("\"id\" DESC"),
            &[String::from("id")],
        );

        assert_eq!(
            sql,
            "SELECT \"id\", \"status\" FROM (SELECT dbx_inner.*, ROWNUM AS \"__dbx_row_num\" FROM (SELECT \"id\", \"status\" FROM \"APP\".\"users\" WHERE (status = 'active') ORDER BY \"id\" DESC) dbx_inner WHERE ROWNUM <= 12000) WHERE \"__dbx_row_num\" > 10000"
        );
        assert!(!sql.contains("OFFSET"));
        assert!(!sql.contains("FETCH NEXT"));
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
    fn dameng_keyset_pagination_includes_offset_fetch() {
        let sql = keyset_pagination_sql(
            &[String::from("id"), String::from("name")],
            "users",
            "SYSDBA",
            &DatabaseType::Dameng,
            &[String::from("id")],
            &[json!(25)],
            100,
        );

        assert_eq!(
            sql,
            "SELECT \"id\", \"name\" FROM \"SYSDBA\".\"users\" WHERE \"id\" > 25 ORDER BY \"id\" ASC OFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY"
        );
        assert!(!sql.contains(" LIMIT "));
    }

    #[test]
    fn oracle_keyset_pagination_uses_rownum_for_legacy_compatibility() {
        let sql = keyset_pagination_sql(
            &[String::from("id"), String::from("name")],
            "users",
            "APP",
            &DatabaseType::Oracle,
            &[String::from("id")],
            &[json!(25)],
            100,
        );

        assert_eq!(
            sql,
            "SELECT \"id\", \"name\" FROM (SELECT \"id\", \"name\" FROM \"APP\".\"users\" WHERE \"id\" > 25 ORDER BY \"id\" ASC) WHERE ROWNUM <= 100"
        );
        assert!(!sql.contains("OFFSET"));
        assert!(!sql.contains("FETCH NEXT"));
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
        let foreign_key_sql = generate_postgres_foreign_key_ddl(&foreign_keys, "orders", "public", "archive");

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
                "ALTER TABLE \"archive\".\"orders\" ADD CONSTRAINT \"orders_user_id_fkey\" FOREIGN KEY (\"user_id\", \"tenant_id\") REFERENCES \"archive\".\"users\" (\"id\", \"tenant_id\")".to_string()
            ]
        );
    }

    #[test]
    fn postgres_sequence_sync_sql_uses_table_max_values() {
        let sql = generate_postgres_sequence_sync_sql(
            &[
                db::ColumnInfo {
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
                    enum_values: None,
                    ..Default::default()
                },
                db::ColumnInfo {
                    name: "identity_id".to_string(),
                    data_type: "integer".to_string(),
                    is_nullable: false,
                    column_default: None,
                    is_primary_key: false,
                    extra: Some("generated by default as identity".to_string()),
                    comment: None,
                    numeric_precision: None,
                    numeric_scale: None,
                    character_maximum_length: None,
                    enum_values: None,
                    ..Default::default()
                },
                db::ColumnInfo {
                    name: "computed_id".to_string(),
                    data_type: "integer".to_string(),
                    is_nullable: false,
                    column_default: None,
                    is_primary_key: false,
                    extra: Some("generated always as (identity_id + 1) stored".to_string()),
                    comment: None,
                    numeric_precision: None,
                    numeric_scale: None,
                    character_maximum_length: None,
                    enum_values: None,
                    ..Default::default()
                },
            ],
            "users",
            "public",
        );

        assert_eq!(
            sql,
            vec![
                "SELECT setval(pg_get_serial_sequence('\"public\".\"users\"', 'id'), GREATEST(COALESCE(MAX(\"id\"), 0), 1), MAX(\"id\") IS NOT NULL) FROM \"public\".\"users\"".to_string(),
                "SELECT setval(pg_get_serial_sequence('\"public\".\"users\"', 'identity_id'), GREATEST(COALESCE(MAX(\"identity_id\"), 0), 1), MAX(\"identity_id\") IS NOT NULL) FROM \"public\".\"users\"".to_string()
            ]
        );
    }

    #[test]
    fn postgres_transfer_owned_sequence_ddl_uses_precreate_and_post_bind_steps() {
        let sequence = PostgresOwnedSequence {
            name: "it_quick_entry_id_seq".to_string(),
            owner_table: "it_quick_entry".to_string(),
            owner_column: "id".to_string(),
        };
        let create_sql =
            format!("CREATE SEQUENCE IF NOT EXISTS {}", postgres_sequence_qualified_name("public", &sequence.name));
        let owner_sql = format!(
            "ALTER SEQUENCE {} OWNED BY {}.{}",
            postgres_sequence_qualified_name("public", &sequence.name),
            qualified_table(&sequence.owner_table, "public", &DatabaseType::Postgres),
            quote_identifier(&sequence.owner_column, &DatabaseType::Postgres)
        );

        assert_eq!(create_sql, "CREATE SEQUENCE IF NOT EXISTS \"public\".\"it_quick_entry_id_seq\"".to_string());
        assert_eq!(
            owner_sql,
            "ALTER SEQUENCE \"public\".\"it_quick_entry_id_seq\" OWNED BY \"public\".\"it_quick_entry\".\"id\""
                .to_string()
        );
    }

    #[test]
    fn postgres_owned_sequence_state_detects_conflicting_existing_sequence() {
        let source = PostgresOwnedSequence {
            name: "it_quick_entry_id_seq".to_string(),
            owner_table: "it_quick_entry".to_string(),
            owner_column: "id".to_string(),
        };

        let conflicting = PostgresSequenceSnapshot {
            name: "it_quick_entry_id_seq".to_string(),
            owner_table: Some("other_table".to_string()),
            owner_column: Some("id".to_string()),
        };

        let error = validate_existing_postgres_sequence(&source, Some(&conflicting), "archive").unwrap_err();

        assert!(error.contains("\"archive\".\"it_quick_entry_id_seq\""));
        assert!(error.contains("already exists with incompatible ownership"));
    }

    #[test]
    fn postgres_transfer_reused_table_ddl_preserves_serial_sequence_dependencies() {
        let columns = vec![
            db::ColumnInfo {
                name: "id".to_string(),
                data_type: "integer".to_string(),
                is_nullable: false,
                column_default: Some("nextval('public.it_quick_entry_id_seq'::regclass)".to_string()),
                is_primary_key: true,
                extra: None,
                comment: None,
                numeric_precision: None,
                numeric_scale: None,
                character_maximum_length: None,
                enum_values: None,
                ..Default::default()
            },
            db::ColumnInfo {
                name: "name".to_string(),
                data_type: "text".to_string(),
                is_nullable: false,
                column_default: None,
                is_primary_key: false,
                extra: None,
                comment: None,
                numeric_precision: None,
                numeric_scale: None,
                character_maximum_length: None,
                enum_values: None,
                ..Default::default()
            },
        ];
        let source_ddl = crate::schema::render_postgres_table_ddl("public", "it_quick_entry", &columns, &[], &[], None);
        let rewritten = rewrite_transfer_source_table_ddl(
            &source_ddl,
            "public",
            "archive",
            &DatabaseType::Postgres,
            &DatabaseType::Postgres,
        );
        let sequence = PostgresOwnedSequence {
            name: "it_quick_entry_id_seq".to_string(),
            owner_table: "it_quick_entry".to_string(),
            owner_column: "id".to_string(),
        };
        let create_sql =
            format!("CREATE SEQUENCE IF NOT EXISTS {}", postgres_sequence_qualified_name("archive", &sequence.name));
        let owner_sql = format!(
            "ALTER SEQUENCE {} OWNED BY {}.{}",
            postgres_sequence_qualified_name("archive", &sequence.name),
            qualified_table(&sequence.owner_table, "archive", &DatabaseType::Postgres),
            quote_identifier(&sequence.owner_column, &DatabaseType::Postgres)
        );
        let sequence_sync_sql = generate_postgres_sequence_sync_sql(&columns, "it_quick_entry", "archive");

        assert!(source_ddl.starts_with("CREATE TABLE \"public\".\"it_quick_entry\""));
        assert!(!source_ddl.contains("CREATE SEQUENCE"));
        assert!(rewritten.contains("CREATE TABLE \"archive\".\"it_quick_entry\""));
        assert!(rewritten.contains("nextval('\"archive\".it_quick_entry_id_seq'::regclass)"));
        assert_eq!(create_sql, "CREATE SEQUENCE IF NOT EXISTS \"archive\".\"it_quick_entry_id_seq\"".to_string());
        assert_eq!(
            owner_sql,
            "ALTER SEQUENCE \"archive\".\"it_quick_entry_id_seq\" OWNED BY \"archive\".\"it_quick_entry\".\"id\""
                .to_string()
        );
        assert_eq!(
            sequence_sync_sql,
            vec![
                "SELECT setval(pg_get_serial_sequence('\"archive\".\"it_quick_entry\"', 'id'), GREATEST(COALESCE(MAX(\"id\"), 0), 1), MAX(\"id\") IS NOT NULL) FROM \"archive\".\"it_quick_entry\"".to_string()
            ]
        );
    }

    #[test]
    fn postgres_routine_schema_rewrite_targets_destination_schema() {
        let rewritten = rewrite_postgres_routine_schema(
            "CREATE OR REPLACE FUNCTION public.bump_counter(id integer)\nRETURNS integer\nLANGUAGE plpgsql\nAS $$ BEGIN INSERT INTO public.audit_logs(user_id) VALUES (id); RETURN id + 1; END; $$",
            "public",
            "archive",
        )
        .unwrap();

        assert!(rewritten.starts_with("CREATE OR REPLACE FUNCTION \"archive\".\"bump_counter\"("));
        assert!(rewritten.contains("INSERT INTO \"archive\".audit_logs"));
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
        assert!(rewritten.contains("EXECUTE FUNCTION \"archive\".bump_counter()"));
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
    fn oracle_insert_uses_date_literals_for_date_columns() {
        let sql = generate_insert_typed(
            &[String::from("id"), String::from("created_on"), String::from("created_at"), String::from("raw_text")],
            &[
                Some(String::from("NUMBER")),
                Some(String::from("DATE")),
                Some(String::from("TIMESTAMP(6)")),
                Some(String::from("VARCHAR2(64)")),
            ],
            &[vec![
                json!(1),
                json!("2022-08-25T09:58:43Z"),
                json!("2022-08-25T09:58:43Z"),
                json!("2022-08-25T09:58:43Z"),
            ]],
            "events",
            "APP",
            &DatabaseType::Oracle,
        );

        assert_eq!(
            sql,
            "INSERT INTO \"APP\".\"events\" (\"id\", \"created_on\", \"created_at\", \"raw_text\") VALUES\n(1, TO_DATE('2022-08-25 09:58:43', 'YYYY-MM-DD HH24:MI:SS'), '2022-08-25T09:58:43Z', '2022-08-25T09:58:43Z')"
        );
        assert_eq!(
            escape_value_typed(&json!("2022-08-25T00:00:00Z"), &DatabaseType::Oracle, Some("DATE")),
            "DATE '2022-08-25'"
        );
    }

    #[test]
    fn mysql_insert_formats_numeric_strings_from_numeric_columns_as_numeric_literals() {
        let sql = generate_insert_typed(
            &[
                String::from("id"),
                String::from("amount"),
                String::from("quantity"),
                String::from("text_id"),
                String::from("bad_number"),
                String::from("missing"),
            ],
            &[
                Some(String::from("bigint(20)")),
                Some(String::from("decimal(10,2)")),
                Some(String::from("int unsigned")),
                Some(String::from("varchar(64)")),
                Some(String::from("bigint(20)")),
                Some(String::from("bigint(20)")),
            ],
            &[vec![
                json!("1234567890123"),
                json!("12.34"),
                json!("42"),
                json!("123"),
                json!("not-a-number"),
                serde_json::Value::Null,
            ]],
            "orders",
            "",
            &DatabaseType::Mysql,
        );

        assert_eq!(
            sql,
            "INSERT INTO `orders` (`id`, `amount`, `quantity`, `text_id`, `bad_number`, `missing`) VALUES\n(1234567890123, 12.34, 42, '123', 'not-a-number', NULL)"
        );
    }

    #[test]
    fn mysql_upsert_formats_numeric_strings_from_numeric_columns_as_numeric_literals() {
        let sql = generate_upsert_typed(
            &[String::from("id"), String::from("amount")],
            &[Some(String::from("bigint(20)")), Some(String::from("decimal(10,2)"))],
            &[vec![json!("1234567890123"), json!("12.34")]],
            "orders",
            "",
            &DatabaseType::Mysql,
            &[String::from("id")],
        );

        assert_eq!(
            sql,
            "INSERT INTO `orders` (`id`, `amount`) VALUES\n(1234567890123, 12.34)\nON DUPLICATE KEY UPDATE `amount` = VALUES(`amount`)"
        );
    }

    #[test]
    fn sqlserver_insert_prefixes_string_literals_as_unicode() {
        let sql = generate_insert_typed(
            &[String::from("name"), String::from("note")],
            &[Some(String::from("nvarchar(100)")), Some(String::from("varchar(100)"))],
            &[vec![json!("Tiếng Việt"), json!("O'Brien")]],
            "customers",
            "dbo",
            &DatabaseType::SqlServer,
        );

        assert_eq!(sql, "INSERT INTO [dbo].[customers] ([name], [note]) VALUES\n(N'Tiếng Việt', N'O''Brien')");
    }

    #[test]
    fn sqlserver_insert_formats_datetime_literals_with_supported_precision() {
        let sql = generate_insert_typed(
            &[String::from("id"), String::from("date1"), String::from("date2"), String::from("note")],
            &[
                Some(String::from("int")),
                Some(String::from("datetime")),
                Some(String::from("datetime2(7)")),
                Some(String::from("nvarchar(100)")),
            ],
            &[vec![
                json!(1),
                json!("2026-06-29 10:11:12.896666666"),
                json!("2026-06-29T10:11:12.8966666Z"),
                json!("2026-06-29 10:11:12.896666666"),
            ]],
            "test",
            "dbo",
            &DatabaseType::SqlServer,
        );

        assert_eq!(
            sql,
            "INSERT INTO [dbo].[test] ([id], [date1], [date2], [note]) VALUES\n(1, N'2026-06-29 10:11:12.897', N'2026-06-29 10:11:12.8966666', N'2026-06-29 10:11:12.896666666')"
        );
    }

    #[test]
    fn sqlserver_insert_formats_bit_booleans_as_numeric_literals() {
        let sql = generate_insert_typed(
            &[String::from("enabled"), String::from("deleted")],
            &[Some(String::from("bit")), Some(String::from("BIT"))],
            &[vec![json!(true), json!(false)]],
            "flags",
            "dbo",
            &DatabaseType::SqlServer,
        );

        assert_eq!(sql, "INSERT INTO [dbo].[flags] ([enabled], [deleted]) VALUES\n(1, 0)");
    }

    #[test]
    fn sqlserver_upsert_formats_bit_booleans_as_numeric_literals() {
        let sql = generate_upsert_typed(
            &[String::from("id"), String::from("enabled")],
            &[Some(String::from("int")), Some(String::from("bit"))],
            &[vec![json!(1), json!(true)]],
            "flags",
            "dbo",
            &DatabaseType::SqlServer,
            &[String::from("id")],
        );

        assert!(sql.contains("USING (VALUES\n(1, 1)\n)"));
        assert!(!sql.contains("TRUE"));
        assert!(!sql.contains("FALSE"));
    }

    #[test]
    fn postgres_insert_preserves_json_escape_sequences() {
        let sql = generate_insert_typed(
            &[String::from("payload")],
            &[Some(String::from("jsonb"))],
            &[vec![json!(r#"{"message":"hello\nworld"}"#)]],
            "events",
            "public",
            &DatabaseType::Postgres,
        );

        assert_eq!(
            sql,
            r#"INSERT INTO "public"."events" ("payload") VALUES
('{"message":"hello\nworld"}')"#
        );
    }

    #[test]
    fn postgres_insert_preserves_text_backslashes() {
        let sql = generate_insert_typed(
            &[String::from("path")],
            &[Some(String::from("text"))],
            &[vec![json!(r#"C:\tmp\file.txt"#)]],
            "files",
            "public",
            &DatabaseType::Postgres,
        );

        assert_eq!(
            sql,
            r#"INSERT INTO "public"."files" ("path") VALUES
('C:\tmp\file.txt')"#
        );
    }

    #[test]
    fn postgres_insert_formats_bytea_prefixed_hex_as_binary_literal() {
        let sql = generate_insert_typed(
            &[String::from("id"), String::from("payload"), String::from("note")],
            &[Some(String::from("integer")), Some(String::from("BYTEA")), Some(String::from("text"))],
            &[vec![json!(1), json!("0x48656c6c6f"), json!("0x48656c6c6f")]],
            "files",
            "public",
            &DatabaseType::Postgres,
        );

        assert_eq!(
            sql,
            r#"INSERT INTO "public"."files" ("id", "payload", "note") VALUES
(1, decode('48656c6c6f', 'hex'), '0x48656c6c6f')"#
        );
    }

    #[test]
    fn mysql_insert_formats_blob_prefixed_hex_as_binary_literal() {
        let sql = generate_insert_typed(
            &[String::from("id"), String::from("payload"), String::from("empty_blob"), String::from("note")],
            &[
                Some(String::from("int")),
                Some(String::from("MEDIUMBLOB")),
                Some(String::from("blob")),
                Some(String::from("varchar(64)")),
            ],
            &[vec![json!(1), json!("0x0001ABff"), json!("0X"), json!("0x0001ABff")]],
            "files",
            "",
            &DatabaseType::Mysql,
        );

        assert_eq!(
            sql,
            r#"INSERT INTO `files` (`id`, `payload`, `empty_blob`, `note`) VALUES
(1, 0x0001ABff, X'', '0x0001ABff')"#
        );
    }

    #[test]
    fn mysql_insert_keeps_invalid_blob_hex_as_string_literal() {
        let sql = generate_insert_typed(
            &[String::from("id"), String::from("payload")],
            &[Some(String::from("int")), Some(String::from("mediumblob"))],
            &[vec![json!(1), json!("0xnothex")]],
            "files",
            "",
            &DatabaseType::Mysql,
        );

        assert_eq!(
            sql,
            r#"INSERT INTO `files` (`id`, `payload`) VALUES
(1, '0xnothex')"#
        );
    }

    #[test]
    fn mysql_insert_keeps_backslash_escape_style() {
        let sql = generate_insert_typed(
            &[String::from("path")],
            &[Some(String::from("varchar(255)"))],
            &[vec![json!(r#"C:\tmp\file.txt"#)]],
            "files",
            "",
            &DatabaseType::Mysql,
        );

        assert_eq!(
            sql,
            r#"INSERT INTO `files` (`path`) VALUES
('C:\\tmp\\file.txt')"#
        );
    }

    #[test]
    fn oracle_single_row_insert_keeps_values_shape() {
        let sql = generate_insert_typed(
            &[String::from("id"), String::from("name")],
            &[Some(String::from("number")), Some(String::from("varchar2(64)"))],
            &[vec![json!(1), json!("Ada")]],
            "INSTR_CATEGORY",
            "APP",
            &DatabaseType::Oracle,
        );

        assert_eq!(
            sql,
            r#"INSERT INTO "APP"."INSTR_CATEGORY" ("id", "name") VALUES
(1, 'Ada')"#
        );
    }

    #[test]
    fn oracle_multi_row_insert_uses_insert_all() {
        let sql = generate_insert_typed(
            &[String::from("id"), String::from("name")],
            &[Some(String::from("number")), Some(String::from("varchar2(64)"))],
            &[vec![json!(1), json!("Ada")], vec![json!(2), json!("O'Brien")]],
            "INSTR_CATEGORY",
            "APP",
            &DatabaseType::Oracle,
        );

        assert_eq!(
            sql,
            r#"INSERT ALL
INTO "APP"."INSTR_CATEGORY" ("id", "name") VALUES (1, 'Ada')
INTO "APP"."INSTR_CATEGORY" ("id", "name") VALUES (2, 'O''Brien')
SELECT 1 FROM dual"#
        );
    }

    #[test]
    fn oracle_transfer_write_batches_limit_insert_all_rows() {
        let rows = (0..(MAX_ORACLE_INSERT_ALL_ROWS + 1)).map(|index| vec![json!(index)]).collect::<Vec<_>>();
        let statements = generate_transfer_write_sql_batches(
            &TransferMode::Append,
            &[String::from("id")],
            &[Some(String::from("number"))],
            &rows,
            "INSTR_CATEGORY",
            "APP",
            &DatabaseType::Oracle,
            &[],
        );

        assert_eq!(statements.len(), 2);
        assert_eq!(statements[0].matches("\nINTO ").count(), MAX_ORACLE_INSERT_ALL_ROWS);
        assert!(statements[0].starts_with("INSERT ALL\nINTO "));
        assert!(statements[0].ends_with("SELECT 1 FROM dual"));
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
        let con = Arc::new(crate::db::duckdb_driver::DuckDbConnection::new(con));
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
    fn transfer_read_retry_policy_retries_connection_errors() {
        assert_eq!(
            transfer_pool_error_action(
                TransferExecutionSafety::ReadOnlyRetryable,
                Some(DatabaseType::Postgres),
                "connection reset by peer"
            ),
            PoolErrorAction::ReconnectAndRetry
        );
    }

    #[test]
    fn transfer_write_retry_policy_discards_without_replaying_batch() {
        assert_eq!(
            transfer_pool_error_action(
                TransferExecutionSafety::WriteNoReplay,
                Some(DatabaseType::Postgres),
                "connection reset by peer"
            ),
            PoolErrorAction::Discard
        );
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

    #[test]
    fn postgres_create_table_preserves_identity_from_column_extra() {
        let cols = vec![db::ColumnInfo {
            data_type: "integer".to_string(),
            extra: Some("generated by default as identity".to_string()),
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

        assert!(ddl.contains("\"id\" integer generated by default as identity NOT NULL"), "ddl: {ddl}");
    }

    #[test]
    fn kingbase_transfer_uses_postgres_compatible_types() {
        assert_eq!(map_column_type("jsonb", &DatabaseType::Postgres, &DatabaseType::Kingbase), "JSONB");
        assert_eq!(map_column_type("bytea", &DatabaseType::Postgres, &DatabaseType::Kingbase), "BYTEA");
        assert_eq!(map_column_type("uuid", &DatabaseType::Postgres, &DatabaseType::Kingbase), "UUID");
        assert_eq!(map_column_type("serial", &DatabaseType::Postgres, &DatabaseType::Kingbase), "SERIAL");
    }

    #[test]
    fn kingbase_create_table_preserves_postgres_defaults() {
        let cols = vec![db::ColumnInfo {
            data_type: "integer".to_string(),
            column_default: Some("nextval('source.items_id_seq'::regclass)".to_string()),
            is_primary_key: true,
            is_nullable: false,
            ..test_column("id", "integer")
        }];

        let ddl = generate_create_table_ddl(
            &cols,
            "items",
            "source",
            "target",
            &DatabaseType::Kingbase,
            &DatabaseType::Postgres,
            None,
        );

        assert!(ddl.contains("GENERATED BY DEFAULT AS IDENTITY"), "ddl: {ddl}");
    }

    #[test]
    fn kingbase_upsert_uses_on_conflict() {
        let sql = generate_upsert_typed(
            &[String::from("id"), String::from("name")],
            &[Some(String::from("integer")), Some(String::from("text"))],
            &[vec![json!(1), json!("updated")]],
            "items",
            "public",
            &DatabaseType::Kingbase,
            &[String::from("id")],
        );

        assert!(sql.contains("ON CONFLICT (\"id\") DO UPDATE SET \"name\" = EXCLUDED.\"name\""), "sql: {sql}");
    }

    #[test]
    fn kingbase_reused_ddl_uses_postgres_statement_sanitization() {
        let ddl = r#"CREATE TABLE public.items (id integer PRIMARY KEY);
CREATE INDEX items_name_idx ON public.items (id);"#;

        let statements = transfer_ddl_statements(ddl, &DatabaseType::Kingbase);

        assert_eq!(statements.len(), 1);
        assert!(statements[0].starts_with("CREATE TABLE"));
    }
}
