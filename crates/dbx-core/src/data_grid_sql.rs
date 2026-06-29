use chrono::{Local, NaiveDateTime};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[path = "data_grid_neo4j_sql.rs"]
mod data_grid_neo4j_sql;
use data_grid_neo4j_sql::{build_neo4j_data_grid_rollback_statements, build_neo4j_data_grid_save_statements};

#[path = "data_grid_tdengine_sql.rs"]
mod data_grid_tdengine_sql;
use data_grid_tdengine_sql::build_tdengine_data_grid_save_statements;

use crate::models::connection::DatabaseType;
use crate::sql_dialect::{quote_table_identifier, table_pagination_strategy, TablePaginationStrategy};
use crate::transfer::{format_ch_array_sql_literal, format_pg_array_sql_literal};

const DBX_ROWID_COLUMN: &str = "__DBX_ROWID";
pub(crate) const DBX_NEO4J_ELEMENT_ID_COLUMN: &str = "__DBX_ELEMENT_ID";
pub(crate) const DBX_TDENGINE_TBNAME_COLUMN: &str = "tbname";
const DATA_GRID_COLUMN_DISTINCT_VALUES_DEFAULT_LIMIT: usize = 1000;
const DATA_GRID_COLUMN_DISTINCT_VALUES_MAX_LIMIT: usize = 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataGridTableMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub table_name: String,
    #[serde(default)]
    pub primary_keys: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub columns: Option<Vec<DataGridColumnInfo>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataGridColumnInfo {
    pub name: String,
    #[serde(default)]
    pub data_type: String,
    #[serde(default)]
    pub is_nullable: bool,
    #[serde(default)]
    pub is_primary_key: bool,
    #[serde(default)]
    pub column_default: Option<String>,
    #[serde(default)]
    pub extra: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataGridSaveStatementOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    pub table_meta: DataGridTableMeta,
    pub columns: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_columns: Option<Vec<Option<String>>>,
    #[serde(default)]
    pub rows: Vec<Vec<Value>>,
    #[serde(default)]
    pub dirty_rows: Vec<(usize, Vec<(usize, Value)>)>,
    #[serde(default)]
    pub deleted_rows: Vec<usize>,
    #[serde(default)]
    pub new_rows: Vec<Vec<Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataGridCopyUpdateStatementOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    pub table_meta: DataGridTableMeta,
    pub columns: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_columns: Option<Vec<Option<String>>>,
    #[serde(default)]
    pub rows: Vec<Vec<Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataGridCopyInsertStatementOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_meta: Option<DataGridTableMeta>,
    pub columns: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_columns: Option<Vec<Option<String>>>,
    #[serde(default)]
    pub rows: Vec<Vec<Value>>,
    #[serde(default)]
    pub exclude_primary_keys: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DataGridContextFilterMode {
    Equals,
    NotEquals,
    IsNull,
    IsNotNull,
    Like,
    NotLike,
    LessThan,
    GreaterThan,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataGridContextFilterConditionOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    pub column_name: String,
    pub mode: DataGridContextFilterMode,
    pub value: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column_info: Option<DataGridColumnInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataGridColumnValueFilterConditionOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    pub column_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column_info: Option<DataGridColumnInfo>,
    pub raw_value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataGridColumnValuesFilterConditionOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    pub column_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column_info: Option<DataGridColumnInfo>,
    #[serde(default)]
    pub values: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataGridColumnDistinctValuesSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub table_name: String,
    pub column_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column_info: Option<DataGridColumnInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub where_input: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search_value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    #[serde(default)]
    pub include_counts: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataGridCountSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub table_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub where_input: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HiveTablePropertiesSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub table_name: String,
    pub property_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataGridSavePreparation {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validation_error: Option<String>,
    pub statements: Vec<String>,
    pub rollback_statements: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_schema: Option<String>,
}

pub fn prepare_data_grid_save(options: DataGridSaveStatementOptions) -> DataGridSavePreparation {
    let validation_error = validate_data_grid_save(&options);
    if validation_error.is_some() {
        return DataGridSavePreparation {
            validation_error,
            statements: Vec::new(),
            rollback_statements: Vec::new(),
            execution_schema: data_grid_save_execution_schema(options.database_type, &options.table_meta),
        };
    }

    DataGridSavePreparation {
        validation_error: None,
        statements: build_data_grid_save_statements(&options),
        rollback_statements: build_data_grid_rollback_statements(&options),
        execution_schema: data_grid_save_execution_schema(options.database_type, &options.table_meta),
    }
}

pub fn build_data_grid_copy_update_statements(options: DataGridCopyUpdateStatementOptions) -> Vec<String> {
    if matches!(options.database_type, Some(DatabaseType::Neo4j | DatabaseType::Tdengine)) {
        return Vec::new();
    }
    let primary_keys = &options.table_meta.primary_keys;
    if primary_keys.is_empty() {
        return Vec::new();
    }

    let save_columns = effective_copy_columns(options.source_columns.as_deref(), &options.columns);
    let column_info = options.table_meta.columns.as_deref().unwrap_or(&[]);
    let primary_key_indexes: Vec<Option<usize>> =
        primary_keys.iter().map(|primary_key| find_column_index(&save_columns, primary_key)).collect();
    if primary_key_indexes.iter().any(Option::is_none) {
        return Vec::new();
    }
    let primary_key_indexes: Vec<usize> = primary_key_indexes.into_iter().flatten().collect();
    let primary_key_set: Vec<String> =
        primary_keys.iter().map(|primary_key| normalize_column_name(primary_key)).collect();
    let writable_indexes: Vec<(&str, usize)> = save_columns
        .iter()
        .enumerate()
        .filter_map(|(index, column)| Some((column.as_deref()?, index)))
        .filter(|(column, _)| !primary_key_set.contains(&normalize_column_name(column)))
        .filter(|(column, _)| !is_oracle_row_id(options.database_type, Some(column)))
        .collect();

    if writable_indexes.is_empty() {
        return Vec::new();
    }

    let table = qualified_table_name(
        options.database_type,
        options.table_meta.schema.as_deref(),
        &options.table_meta.table_name,
    );
    let mut statements = Vec::new();
    for row in &options.rows {
        if primary_key_indexes.iter().any(|index| row.get(*index).unwrap_or(&Value::Null).is_null()) {
            continue;
        }
        let sets = writable_indexes
            .iter()
            .map(|(column, index)| {
                format!(
                    "{} = {}",
                    quote_ident(options.database_type, column),
                    format_grid_sql_literal(
                        row.get(*index).unwrap_or(&Value::Null),
                        options.database_type,
                        column_info_for(column_info, column)
                    )
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        if sets.is_empty() {
            continue;
        }
        let where_clause = primary_keys
            .iter()
            .enumerate()
            .map(|(index, primary_key)| {
                build_column_predicate(
                    options.database_type,
                    primary_key,
                    row.get(primary_key_indexes[index]).unwrap_or(&Value::Null),
                    column_info_for(column_info, primary_key),
                    false,
                )
            })
            .collect::<Vec<_>>()
            .join(" AND ");
        statements.push(data_grid_statement(
            options.database_type,
            data_grid_update_sql(options.database_type, &table, &sets, &where_clause),
        ));
    }
    statements
}

pub fn build_data_grid_copy_insert_statement(options: DataGridCopyInsertStatementOptions) -> Option<String> {
    let save_columns = effective_copy_columns(options.source_columns.as_deref(), &options.columns);
    let column_info = options.table_meta.as_ref().and_then(|meta| meta.columns.as_deref()).unwrap_or(&[]);
    let primary_key_set: Vec<String> = options
        .table_meta
        .as_ref()
        .map(|meta| meta.primary_keys.iter().map(|primary_key| normalize_column_name(primary_key)).collect())
        .unwrap_or_default();
    let insertable_columns: Vec<(&str, usize)> = save_columns
        .iter()
        .enumerate()
        .filter_map(|(index, column)| Some((column.as_deref()?, index)))
        .filter(|(column, _)| {
            !is_grid_insert_omitted_column(options.database_type, column_info_for(column_info, column), Some(column))
        })
        .collect();
    let insert_columns: Vec<(&str, usize)> = insertable_columns
        .iter()
        .copied()
        .filter(|(column, _)| {
            !options.exclude_primary_keys || !primary_key_set.contains(&normalize_column_name(column))
        })
        .collect();

    if options.exclude_primary_keys && insert_columns.len() == insertable_columns.len() {
        return None;
    }
    if insert_columns.is_empty() || options.rows.is_empty() {
        return None;
    }

    let table = options.table_meta.as_ref().map_or_else(
        || "table_name".to_string(),
        |meta| qualified_table_name(options.database_type, meta.schema.as_deref(), &meta.table_name),
    );
    let columns = insert_columns
        .iter()
        .map(|(column, _)| quote_ident(options.database_type, column))
        .collect::<Vec<_>>()
        .join(", ");
    let value_rows = options
        .rows
        .iter()
        .map(|row| {
            format!(
                "({})",
                insert_columns
                    .iter()
                    .map(|(column, index)| {
                        format_grid_sql_literal(
                            row.get(*index).unwrap_or(&Value::Null),
                            options.database_type,
                            column_info_for(column_info, column),
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
        .collect::<Vec<_>>();
    Some(format!(
        "INSERT INTO {table} ({columns}) VALUES{}{};",
        if value_rows.len() == 1 { " " } else { "\n" },
        value_rows.join(",\n")
    ))
}

pub fn build_data_grid_context_filter_condition(options: DataGridContextFilterConditionOptions) -> Option<String> {
    let column = column_filter_ref(options.database_type, &options.column_name);
    let like_column = column_like_filter_ref(options.database_type, &options.column_name, options.column_info.as_ref());
    let value = &options.value;
    match options.mode {
        DataGridContextFilterMode::IsNull => Some(format!("{column} IS NULL")),
        DataGridContextFilterMode::IsNotNull => Some(format!("{column} IS NOT NULL")),
        DataGridContextFilterMode::Equals if value.is_null() => Some(format!("{column} IS NULL")),
        DataGridContextFilterMode::NotEquals if value.is_null() => Some(format!("{column} IS NOT NULL")),
        DataGridContextFilterMode::Like => Some(format!(
            "{like_column} LIKE {}",
            format_grid_sql_literal(
                &Value::String(format!("%{}%", value_to_filter_text(value))),
                options.database_type,
                None
            )
        )),
        DataGridContextFilterMode::NotLike => Some(format!(
            "{like_column} NOT LIKE {}",
            format_grid_sql_literal(
                &Value::String(format!("%{}%", value_to_filter_text(value))),
                options.database_type,
                None
            )
        )),
        DataGridContextFilterMode::LessThan => Some(format!(
            "{column} < {}",
            format_grid_sql_literal(value, options.database_type, options.column_info.as_ref())
        )),
        DataGridContextFilterMode::GreaterThan => Some(format!(
            "{column} > {}",
            format_grid_sql_literal(value, options.database_type, options.column_info.as_ref())
        )),
        DataGridContextFilterMode::Equals => Some(format!(
            "{column} = {}",
            format_grid_sql_literal(value, options.database_type, options.column_info.as_ref())
        )),
        DataGridContextFilterMode::NotEquals => Some(format!(
            "{column} <> {}",
            format_grid_sql_literal(value, options.database_type, options.column_info.as_ref())
        )),
    }
}

pub fn build_data_grid_column_value_filter_condition(
    options: DataGridColumnValueFilterConditionOptions,
) -> Option<String> {
    let text = options.raw_value.trim();
    if text.is_empty() {
        return None;
    }
    let column = column_filter_ref(options.database_type, &options.column_name);
    if text.eq_ignore_ascii_case("null") {
        return Some(format!("{column} IS NULL"));
    }
    let value = parse_typed_filter_value(text, options.column_info.as_ref());
    Some(format!("{column} = {}", format_grid_sql_literal(&value, options.database_type, options.column_info.as_ref())))
}

pub fn build_data_grid_column_values_filter_condition(
    options: DataGridColumnValuesFilterConditionOptions,
) -> Option<String> {
    if options.values.is_empty() {
        return None;
    }

    let column = column_filter_ref(options.database_type, &options.column_name);
    let mut has_null = false;
    let mut literals = Vec::new();
    for value in &options.values {
        if value.is_null() {
            has_null = true;
            continue;
        }
        let literal = format_grid_sql_literal(value, options.database_type, options.column_info.as_ref());
        if !literals.contains(&literal) {
            literals.push(literal);
        }
    }

    let mut predicates = Vec::new();
    if has_null {
        predicates.push(format!("{column} IS NULL"));
    }
    if !literals.is_empty() {
        let list = literals.join(", ");
        if literals.len() == 1 {
            predicates.push(format!("{column} = {list}"));
        } else if options.database_type == Some(DatabaseType::Neo4j) {
            predicates.push(format!("{column} IN [{list}]"));
        } else {
            predicates.push(format!("{column} IN ({list})"));
        }
    }

    match predicates.len() {
        0 => None,
        1 => predicates.into_iter().next(),
        _ => Some(format!("({})", predicates.join(" OR "))),
    }
}

pub fn build_data_grid_column_distinct_values_sql(options: DataGridColumnDistinctValuesSqlOptions) -> String {
    if options.database_type == Some(DatabaseType::Neo4j) {
        return build_neo4j_data_grid_column_distinct_values_sql(&options);
    }

    let limit = data_grid_column_distinct_values_limit(options.limit);
    let table = qualified_table_name(options.database_type, options.schema.as_deref(), &options.table_name);
    let column = column_filter_ref(options.database_type, &options.column_name);
    let mut predicates = Vec::new();
    let predicate = crate::sql_dialect::normalize_where_input(options.where_input.as_deref());
    if !predicate.is_empty() {
        predicates.push(format!("({predicate})"));
    }
    if let Some(search_predicate) = data_grid_column_distinct_values_search_predicate(&options) {
        predicates.push(search_predicate);
    }
    let where_clause =
        if predicates.is_empty() { String::new() } else { format!(" WHERE {}", predicates.join(" AND ")) };
    let select_list = if options.include_counts {
        format!("{column} AS dbx_value, COUNT(*) AS dbx_count")
    } else {
        format!("{column} AS dbx_value")
    };
    let group_by = format!(" GROUP BY {column}");
    let order_by = if options.include_counts { " ORDER BY dbx_count DESC, dbx_value" } else { " ORDER BY dbx_value" };
    let from_clause = format!(" FROM {table}{where_clause}{group_by}{order_by}");

    match table_pagination_strategy(options.database_type) {
        TablePaginationStrategy::SqlServerTop => format!("SELECT TOP ({limit}) {select_list}{from_clause}"),
        TablePaginationStrategy::IrisTop => format!("SELECT TOP {limit} {select_list}{from_clause}"),
        TablePaginationStrategy::InformixFirst => format!("SELECT FIRST {limit} {select_list}{from_clause}"),
        TablePaginationStrategy::Db2FetchFirst | TablePaginationStrategy::FetchFirst => {
            format!("SELECT {select_list}{from_clause} FETCH FIRST {limit} ROWS ONLY")
        }
        TablePaginationStrategy::Rownum => {
            let inner = format!("SELECT {select_list}{from_clause}");
            format!("SELECT * FROM ({inner}) WHERE ROWNUM <= {limit}")
        }
        TablePaginationStrategy::AgentMaxRows | TablePaginationStrategy::Unbounded => {
            format!("SELECT {select_list}{from_clause}")
        }
        TablePaginationStrategy::QuestDbLimit | TablePaginationStrategy::LimitOffset => {
            format!("SELECT {select_list}{from_clause} LIMIT {limit}")
        }
    }
}

pub fn build_data_grid_count_sql(options: DataGridCountSqlOptions) -> String {
    let table = qualified_table_name(options.database_type, options.schema.as_deref(), &options.table_name);
    let predicate = crate::sql_dialect::normalize_where_input(options.where_input.as_deref());
    let where_clause = if predicate.is_empty() { String::new() } else { format!(" WHERE ({predicate})") };
    format!("SELECT COUNT(*) AS cnt FROM {table}{where_clause}")
}

pub fn build_hive_table_properties_sql(options: HiveTablePropertiesSqlOptions) -> String {
    let table = qualified_table_name(Some(DatabaseType::Hive), options.schema.as_deref(), &options.table_name);
    let property = options.property_name.replace('\'', "''");
    format!("SHOW TBLPROPERTIES {table} ('{property}')")
}

fn data_grid_column_distinct_values_limit(limit: Option<usize>) -> usize {
    limit.unwrap_or(DATA_GRID_COLUMN_DISTINCT_VALUES_DEFAULT_LIMIT).clamp(1, DATA_GRID_COLUMN_DISTINCT_VALUES_MAX_LIMIT)
}

fn data_grid_column_distinct_values_search_predicate(
    options: &DataGridColumnDistinctValuesSqlOptions,
) -> Option<String> {
    let search = options.search_value.as_deref()?.trim();
    if search.is_empty() {
        return None;
    }
    if !options.column_info.as_ref().map(|column| is_textual_column_type(&column.data_type)).unwrap_or(true)
        && !is_postgres_like_pattern_database(options.database_type)
    {
        let column = column_filter_ref(options.database_type, &options.column_name);
        let value = parse_typed_filter_value(search, options.column_info.as_ref());
        return Some(format!(
            "{column} = {}",
            format_grid_sql_literal(&value, options.database_type, options.column_info.as_ref())
        ));
    }
    let column = column_like_filter_ref(options.database_type, &options.column_name, options.column_info.as_ref());
    let pattern = Value::String(format!("%{search}%"));
    Some(format!("{column} LIKE {}", format_grid_sql_literal(&pattern, options.database_type, None)))
}

fn build_neo4j_data_grid_column_distinct_values_sql(options: &DataGridColumnDistinctValuesSqlOptions) -> String {
    let limit = data_grid_column_distinct_values_limit(options.limit);
    let label = quote_ident(Some(DatabaseType::Neo4j), &options.table_name);
    let column = column_filter_ref(Some(DatabaseType::Neo4j), &options.column_name);
    let mut predicates = Vec::new();
    let predicate = crate::sql_dialect::normalize_where_input(options.where_input.as_deref());
    if !predicate.is_empty() {
        predicates.push(predicate);
    }
    if let Some(search) = options.search_value.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        predicates.push(format!(
            "toString({column}) CONTAINS {}",
            format_grid_sql_literal(&Value::String(search.to_string()), Some(DatabaseType::Neo4j), None)
        ));
    }
    let where_clause =
        if predicates.is_empty() { String::new() } else { format!(" WHERE {}", predicates.join(" AND ")) };
    if options.include_counts {
        format!(
            "MATCH (n:{label}){where_clause} RETURN {column} AS dbx_value, count(*) AS dbx_count ORDER BY dbx_count DESC, dbx_value LIMIT {limit}"
        )
    } else {
        format!(
            "MATCH (n:{label}){where_clause} RETURN DISTINCT {column} AS dbx_value ORDER BY dbx_value LIMIT {limit}"
        )
    }
}

fn validate_data_grid_save(options: &DataGridSaveStatementOptions) -> Option<String> {
    if let Some(error) = validate_inserted_primary_keys(options) {
        return Some(error);
    }

    let not_null_columns: Vec<String> = options
        .table_meta
        .columns
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter(|column| {
            !column.is_nullable
                && column.column_default.is_none()
                && !is_auto_generated_column(column)
                && !is_non_identity_generated_column(Some(column))
                && !is_oracle_row_id(options.database_type, Some(&column.name))
        })
        .map(|column| normalize_column_name(&column.name))
        .collect();
    if let Some(error) = validate_clickhouse_mutable_updates(options) {
        return Some(error);
    }

    if not_null_columns.is_empty() {
        return None;
    }

    for (_, changes) in &options.dirty_rows {
        for (column_index, value) in changes {
            let source_column = effective_column(options, *column_index);
            if is_null_write_to_not_null_column(options.database_type, &not_null_columns, source_column, value) {
                return Some(null_write_error(source_column.unwrap_or_default()));
            }
        }
    }

    for row in &options.new_rows {
        for column_index in 0..options.columns.len() {
            let source_column = effective_column(options, column_index);
            if is_null_write_to_not_null_column(
                options.database_type,
                &not_null_columns,
                source_column,
                row.get(column_index).unwrap_or(&Value::Null),
            ) {
                return Some(null_write_error(source_column.unwrap_or_default()));
            }
        }
    }

    None
}

fn validate_clickhouse_mutable_updates(options: &DataGridSaveStatementOptions) -> Option<String> {
    if options.database_type != Some(DatabaseType::ClickHouse) || options.dirty_rows.is_empty() {
        return None;
    }
    let save_columns = effective_columns(options);
    let column_info = options.table_meta.columns.as_deref().unwrap_or(&[]);
    let primary_key_set: Vec<String> =
        options.table_meta.primary_keys.iter().map(|primary_key| normalize_column_name(primary_key)).collect();
    let has_clickhouse_key_metadata = !primary_key_set.is_empty()
        || column_info.iter().any(|column| is_clickhouse_partition_key_column(options.database_type, Some(column)));
    if !has_clickhouse_key_metadata {
        return None;
    }

    for (_, changes) in &options.dirty_rows {
        if changes.is_empty() {
            continue;
        }
        let has_mutable_column = changes.iter().any(|(column_index, _)| {
            let Some(column) = save_columns.get(*column_index).and_then(|column| column.as_deref()) else {
                return false;
            };
            !is_grid_update_omitted_column(
                options.database_type,
                column_info_for(column_info, column),
                Some(column),
                &primary_key_set,
            )
        });
        if !has_mutable_column {
            return Some(clickhouse_no_mutable_columns_error());
        }
    }
    None
}

fn validate_inserted_primary_keys(options: &DataGridSaveStatementOptions) -> Option<String> {
    let primary_keys = &options.table_meta.primary_keys;
    if primary_keys.is_empty() || options.new_rows.is_empty() {
        return None;
    }

    let save_columns = effective_columns(options);
    let primary_key_indexes: Vec<Option<usize>> =
        primary_keys.iter().map(|primary_key| find_column_index(&save_columns, primary_key)).collect();
    if primary_key_indexes.iter().any(Option::is_none) {
        return None;
    }
    let primary_key_indexes: Vec<usize> = primary_key_indexes.into_iter().flatten().collect();

    let mut existing_keys: Vec<String> = Vec::new();
    for row in &options.rows {
        if let Some(key) = primary_key_value_key(&primary_key_indexes, row) {
            existing_keys.push(key);
        }
    }

    let mut new_keys: Vec<String> = Vec::new();
    for row in &options.new_rows {
        let Some(key) = primary_key_value_key(&primary_key_indexes, row) else {
            continue;
        };
        if existing_keys.contains(&key) || new_keys.contains(&key) {
            return Some(duplicate_primary_key_error(
                primary_keys,
                &primary_key_indexes,
                row,
                existing_keys.contains(&key),
            ));
        }
        new_keys.push(key);
    }

    None
}

fn build_data_grid_save_statements(options: &DataGridSaveStatementOptions) -> Vec<String> {
    if options.database_type == Some(DatabaseType::Neo4j) {
        return build_neo4j_data_grid_save_statements(options);
    }
    if options.database_type == Some(DatabaseType::Tdengine) {
        return build_tdengine_data_grid_save_statements(options);
    }

    let save_columns = effective_columns(options);
    let column_info = options.table_meta.columns.as_deref().unwrap_or(&[]);
    let table = qualified_table_name(
        options.database_type,
        options.table_meta.schema.as_deref(),
        &options.table_meta.table_name,
    );
    let mut statements = Vec::new();
    let primary_key_set: Vec<String> =
        options.table_meta.primary_keys.iter().map(|primary_key| normalize_column_name(primary_key)).collect();

    for (row_index, changes) in &options.dirty_rows {
        let Some(row) = options.rows.get(*row_index) else {
            continue;
        };
        let sets = changes
            .iter()
            .filter_map(|(column_index, value)| {
                let column = save_columns.get(*column_index)?.as_deref()?;
                if is_grid_update_omitted_column(
                    options.database_type,
                    column_info_for(column_info, column),
                    Some(column),
                    &primary_key_set,
                ) {
                    return None;
                }
                Some(format!(
                    "{} = {}",
                    quote_ident(options.database_type, column),
                    format_grid_save_sql_literal(value, options.database_type, column_info_for(column_info, column))
                ))
            })
            .collect::<Vec<_>>()
            .join(", ");
        if sets.is_empty() {
            continue;
        }
        let where_clause = build_primary_key_where(
            options.database_type,
            &options.table_meta.primary_keys,
            &save_columns,
            row,
            column_info,
        );
        statements.push(data_grid_statement(
            options.database_type,
            data_grid_update_sql(options.database_type, &table, &sets, &where_clause),
        ));
    }

    for row_index in &options.deleted_rows {
        let Some(row) = options.rows.get(*row_index) else {
            continue;
        };
        let where_clause = build_primary_key_where(
            options.database_type,
            &options.table_meta.primary_keys,
            &save_columns,
            row,
            column_info,
        );
        statements.push(data_grid_statement(
            options.database_type,
            data_grid_delete_sql(options.database_type, &table, &where_clause),
        ));
    }

    for row in &options.new_rows {
        let insert_pairs: Vec<(&str, &Value)> = save_columns
            .iter()
            .enumerate()
            .filter_map(|(index, column)| Some((column.as_deref()?, row.get(index).unwrap_or(&Value::Null))))
            .filter(|(column, _)| {
                !is_grid_insert_omitted_column(
                    options.database_type,
                    column_info_for(column_info, column),
                    Some(column),
                )
            })
            .filter(|(_, value)| !value.is_null())
            .collect();
        if insert_pairs.is_empty() {
            continue;
        }
        let columns = insert_pairs
            .iter()
            .map(|(column, _)| quote_ident(options.database_type, column))
            .collect::<Vec<_>>()
            .join(", ");
        let values = insert_pairs
            .iter()
            .map(|(column, value)| {
                format_grid_save_sql_literal(value, options.database_type, column_info_for(column_info, column))
            })
            .collect::<Vec<_>>()
            .join(", ");
        statements.push(data_grid_statement(
            options.database_type,
            format!("INSERT INTO {table} ({columns}) VALUES ({values})"),
        ));
    }

    statements
}

fn build_data_grid_rollback_statements(options: &DataGridSaveStatementOptions) -> Vec<String> {
    if options.database_type == Some(DatabaseType::Neo4j) {
        return build_neo4j_data_grid_rollback_statements(options);
    }
    if options.database_type == Some(DatabaseType::ClickHouse) {
        return Vec::new();
    }

    let save_columns = effective_columns(options);
    let column_info = options.table_meta.columns.as_deref().unwrap_or(&[]);
    let table = qualified_table_name(
        options.database_type,
        options.table_meta.schema.as_deref(),
        &options.table_meta.table_name,
    );
    let mut statements = Vec::new();

    for row in &options.new_rows {
        let where_clause = build_save_row_where(options.database_type, &save_columns, row, column_info);
        if !where_clause.is_empty() {
            statements
                .push(data_grid_statement(options.database_type, format!("DELETE FROM {table} WHERE {where_clause}")));
        }
    }

    for row_index in &options.deleted_rows {
        let Some(row) = options.rows.get(*row_index) else {
            continue;
        };
        let insert_pairs: Vec<(&str, &Value)> = save_columns
            .iter()
            .enumerate()
            .filter_map(|(index, column)| Some((column.as_deref()?, row.get(index).unwrap_or(&Value::Null))))
            .filter(|(column, _)| {
                !is_grid_insert_omitted_column(
                    options.database_type,
                    column_info_for(column_info, column),
                    Some(column),
                )
            })
            .collect();
        let columns = insert_pairs
            .iter()
            .map(|(column, _)| quote_ident(options.database_type, column))
            .collect::<Vec<_>>()
            .join(", ");
        let values = insert_pairs
            .iter()
            .map(|(column, value)| {
                format_grid_sql_literal(value, options.database_type, column_info_for(column_info, column))
            })
            .collect::<Vec<_>>()
            .join(", ");
        statements.push(data_grid_statement(
            options.database_type,
            format!("INSERT INTO {table} ({columns}) VALUES ({values})"),
        ));
    }

    for (row_index, changes) in &options.dirty_rows {
        let Some(row) = options.rows.get(*row_index) else {
            continue;
        };
        let mut after_row = row.clone();
        for (column_index, value) in changes {
            if *column_index < after_row.len() {
                after_row[*column_index] = value.clone();
            }
        }
        let writable_changes: Vec<(&(usize, Value), &str)> = changes
            .iter()
            .filter_map(|change @ (column_index, _)| {
                let column = save_columns.get(*column_index)?.as_deref()?;
                if is_grid_update_omitted_column(
                    options.database_type,
                    column_info_for(column_info, column),
                    Some(column),
                    &[],
                ) {
                    return None;
                }
                Some((change, column))
            })
            .collect();
        let sets = writable_changes
            .iter()
            .map(|((column_index, _), column)| {
                format!(
                    "{} = {}",
                    quote_ident(options.database_type, column),
                    format_grid_sql_literal(
                        row.get(*column_index).unwrap_or(&Value::Null),
                        options.database_type,
                        column_info_for(column_info, column)
                    )
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        if sets.is_empty() {
            continue;
        }
        let mut predicates = vec![build_primary_key_where(
            options.database_type,
            &options.table_meta.primary_keys,
            &save_columns,
            &after_row,
            column_info,
        )];
        predicates.extend(writable_changes.iter().map(|((_, value), column)| {
            build_save_column_predicate(
                options.database_type,
                column,
                value,
                column_info_for(column_info, column),
                true,
            )
        }));
        statements.push(data_grid_statement(
            options.database_type,
            format!(
                "UPDATE {table} SET {sets} WHERE {}",
                predicates.into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" AND ")
            ),
        ));
    }

    statements
}

pub(crate) fn effective_columns(options: &DataGridSaveStatementOptions) -> Vec<Option<String>> {
    match &options.source_columns {
        Some(source_columns) if source_columns.len() == options.columns.len() => source_columns.clone(),
        _ => options.columns.iter().map(|column| Some(column.clone())).collect(),
    }
}

fn effective_copy_columns(source_columns: Option<&[Option<String>]>, columns: &[String]) -> Vec<Option<String>> {
    match source_columns {
        Some(source_columns) if source_columns.len() == columns.len() => source_columns.to_vec(),
        _ => columns.iter().map(|column| Some(column.clone())).collect(),
    }
}

fn effective_column(options: &DataGridSaveStatementOptions, index: usize) -> Option<&str> {
    match &options.source_columns {
        Some(source_columns) if source_columns.len() == options.columns.len() => source_columns.get(index)?.as_deref(),
        _ => options.columns.get(index).map(String::as_str),
    }
}

fn data_grid_save_execution_schema(
    database_type: Option<DatabaseType>,
    table_meta: &DataGridTableMeta,
) -> Option<String> {
    if matches!(database_type, Some(DatabaseType::Neo4j | DatabaseType::Oracle)) {
        return None;
    }
    table_meta.schema.clone()
}

pub fn normalize_data_grid_save_error(database_type: Option<DatabaseType>, error: &str) -> String {
    if database_type == Some(DatabaseType::Hive)
        && (error.contains("Attempt to do update or delete") || error.contains("Error 10294"))
    {
        return "Hive UPDATE/DELETE are not enabled for this table or server. Add rows with INSERT, or enable ACID transactional tables in Hive before editing/deleting existing rows.".to_string();
    }
    error.to_string()
}

pub fn format_grid_sql_literal(
    value: &Value,
    database_type: Option<DatabaseType>,
    column_info: Option<&DataGridColumnInfo>,
) -> String {
    if value.is_null() {
        return "NULL".to_string();
    }
    // Boolean values on BIT columns always use numeric 0/1.
    // This covers MySQL, SQL Server, and any other database where BIT
    // is a numeric/boolean type rather than a bit-string type like
    // PostgreSQL's bit(n).
    if let Some(value) = value.as_bool() {
        if is_bit_literal_column(column_info) {
            return if value { "1" } else { "0" }.to_string();
        }
        return if value { "TRUE" } else { "FALSE" }.to_string();
    }
    if is_mysql_bit_literal_column(database_type, column_info) {
        if let Some(number) = value.as_number() {
            return number.to_string();
        }
        if let Some(text) = value.as_str().and_then(format_mysql_bit_literal_text) {
            return text;
        }
    }
    if let Some(number) = value.as_number() {
        return number.to_string();
    }
    if let Some(arr) = value.as_array() {
        if matches!(database_type, Some(DatabaseType::ClickHouse) | Some(DatabaseType::Databend)) {
            return format_ch_array_sql_literal(arr);
        }
        return format_pg_array_sql_literal(arr);
    }
    let text = value.as_str().map_or_else(|| value.to_string(), ToString::to_string);
    if database_type == Some(DatabaseType::ManticoreSearch) {
        if let Some(typed_value) = manticore_typed_attribute_value(&text, column_info) {
            return format_grid_sql_literal(&typed_value, database_type, column_info);
        }
    }
    if text.is_empty() {
        return if database_type == Some(DatabaseType::SqlServer) { "N''" } else { "''" }.to_string();
    }
    // MySQL geometry columns: wrap WKT text with ST_GeomFromText()
    if is_mysql_geometry_literal_database(database_type)
        && column_info.map(|column| is_geometry_column_type(&column.data_type)).unwrap_or(false)
    {
        let escaped = text.replace('\\', "\\\\").replace('\'', "''");
        return format!("ST_GeomFromText('{}')", escaped);
    }
    if is_oracle_temporal_literal_database(database_type) {
        if let Some(literal) =
            format_oracle_temporal_literal(&text, column_info.map(|column| column.data_type.as_str()))
        {
            return literal;
        }
    }
    let literal_text = if database_type == Some(DatabaseType::Tdengine) {
        format_tdengine_timestamp_literal_text(&text)
    } else if database_type == Some(DatabaseType::SqlServer) {
        crate::sqlserver_temporal::normalize_sqlserver_temporal_literal(
            &text,
            column_info.map(|column| column.data_type.as_str()),
        )
        .unwrap_or(text)
    } else if is_mysql_datetime_literal_database(database_type)
        && column_info.map(|column| is_temporal_column_type(&column.data_type)).unwrap_or(true)
    {
        format_mysql_temporal_literal_text(&text, column_info.map(|column| column.data_type.as_str()))
    } else {
        text
    };
    let escaped = format!("'{}'", literal_text.replace('\\', "\\\\").replace('\'', "''"));
    if database_type == Some(DatabaseType::SqlServer) {
        format!("N{escaped}")
    } else {
        escaped
    }
}

fn format_grid_save_sql_literal(
    value: &Value,
    database_type: Option<DatabaseType>,
    column_info: Option<&DataGridColumnInfo>,
) -> String {
    if empty_string_saves_as_null(value, column_info) {
        "NULL".to_string()
    } else {
        format_grid_sql_literal(value, database_type, column_info)
    }
}

fn empty_string_saves_as_null(value: &Value, column_info: Option<&DataGridColumnInfo>) -> bool {
    value.as_str() == Some("")
        && column_info.is_some_and(|column| column.is_nullable && !is_textual_column_type(&column.data_type))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OracleTemporalKind {
    Date,
    Timestamp,
    TimestampWithTimeZone,
}

fn is_oracle_temporal_literal_database(database_type: Option<DatabaseType>) -> bool {
    matches!(database_type, Some(DatabaseType::Oracle | DatabaseType::OceanbaseOracle))
}

fn format_oracle_temporal_literal(text: &str, data_type: Option<&str>) -> Option<String> {
    let kind = oracle_temporal_column_kind(data_type?)?;
    let parts = regex_like_rfc3339(text)?;
    let fraction = parts.fraction.unwrap_or_default();
    let datetime = format!("{} {}{}", parts.date, parts.time, fraction);
    match kind {
        OracleTemporalKind::Date => Some(format!("TO_DATE('{} {}', 'YYYY-MM-DD HH24:MI:SS')", parts.date, parts.time)),
        OracleTemporalKind::Timestamp => {
            let mask = oracle_timestamp_format_mask(datetime.contains('.'));
            Some(format!("TO_TIMESTAMP('{datetime}', '{mask}')"))
        }
        OracleTemporalKind::TimestampWithTimeZone => {
            let zone = oracle_timezone_suffix(&parts.zone);
            let mask = oracle_timestamp_format_mask(datetime.contains('.'));
            Some(format!("TO_TIMESTAMP_TZ('{datetime} {zone}', '{mask} TZH:TZM')"))
        }
    }
}

fn oracle_temporal_column_kind(data_type: &str) -> Option<OracleTemporalKind> {
    let lower = data_type.trim().to_ascii_lowercase();
    let base = lower.split(['(', ' ']).next().unwrap_or("");
    match base {
        "date" => Some(OracleTemporalKind::Date),
        "timestamp" if lower.contains("with time zone") || lower.contains("with local time zone") => {
            Some(OracleTemporalKind::TimestampWithTimeZone)
        }
        "timestamp" => Some(OracleTemporalKind::Timestamp),
        _ => None,
    }
}

fn oracle_timestamp_format_mask(has_fraction: bool) -> &'static str {
    if has_fraction {
        "YYYY-MM-DD HH24:MI:SS.FF"
    } else {
        "YYYY-MM-DD HH24:MI:SS"
    }
}

fn oracle_timezone_suffix(zone: &str) -> String {
    if zone.eq_ignore_ascii_case("z") {
        "+00:00".to_string()
    } else {
        zone.to_string()
    }
}

fn is_mysql_bit_literal_column(database_type: Option<DatabaseType>, column_info: Option<&DataGridColumnInfo>) -> bool {
    is_mysql_datetime_literal_database(database_type)
        && column_info.map(|column| is_bit_column_type(&column.data_type)).unwrap_or(false)
}

fn is_bit_literal_column(column_info: Option<&DataGridColumnInfo>) -> bool {
    column_info.map(|column| is_bit_column_type(&column.data_type)).unwrap_or(false)
}

fn is_bit_column_type(data_type: &str) -> bool {
    let lower = data_type.to_ascii_lowercase();
    lower.split(|ch: char| !ch.is_ascii_alphanumeric()).any(|token| token == "bit")
}

fn is_mysql_geometry_literal_database(database_type: Option<DatabaseType>) -> bool {
    matches!(
        database_type,
        Some(
            DatabaseType::Mysql
                | DatabaseType::Doris
                | DatabaseType::StarRocks
                | DatabaseType::Goldendb
                | DatabaseType::Sundb
        )
    )
}

fn is_geometry_column_type(data_type: &str) -> bool {
    let lower = data_type.to_ascii_lowercase();
    let base = lower.split('(').next().unwrap_or(&lower).trim();
    matches!(
        base,
        "geometry"
            | "point"
            | "linestring"
            | "polygon"
            | "multipoint"
            | "multilinestring"
            | "multipolygon"
            | "geometrycollection"
    )
}

fn manticore_typed_attribute_value(text: &str, column_info: Option<&DataGridColumnInfo>) -> Option<Value> {
    let data_type = column_info?.data_type.to_ascii_lowercase();
    if is_boolean_type(&data_type) && text.eq_ignore_ascii_case("true") {
        return Some(Value::Bool(true));
    }
    if is_boolean_type(&data_type) && text.eq_ignore_ascii_case("false") {
        return Some(Value::Bool(false));
    }
    if is_numeric_type(&data_type) && is_numeric_literal(text) {
        return text.parse::<serde_json::Number>().ok().map(Value::Number);
    }
    None
}

fn format_mysql_bit_literal_text(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.eq_ignore_ascii_case("true") {
        return Some("1".to_string());
    }
    if trimmed.eq_ignore_ascii_case("false") {
        return Some("0".to_string());
    }
    if trimmed.chars().all(|ch| ch.is_ascii_digit()) && !trimmed.is_empty() {
        return Some(if trimmed.len() == 1 {
            trimmed.to_string()
        } else if trimmed.chars().all(|ch| matches!(ch, '0' | '1')) {
            format!("b'{trimmed}'")
        } else {
            trimmed.to_string()
        });
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("b'") && trimmed.ends_with('\'') {
        let bits = &trimmed[2..trimmed.len() - 1];
        if !bits.is_empty() && bits.chars().all(|ch| matches!(ch, '0' | '1')) {
            return Some(format!("b'{bits}'"));
        }
    }
    None
}

fn is_mysql_datetime_literal_database(database_type: Option<DatabaseType>) -> bool {
    matches!(
        database_type,
        Some(
            DatabaseType::Mysql
                | DatabaseType::Doris
                | DatabaseType::StarRocks
                | DatabaseType::Goldendb
                | DatabaseType::Sundb
        )
    )
}

fn format_mysql_temporal_literal_text(text: &str, data_type: Option<&str>) -> String {
    let Some(captures) = regex_like_rfc3339(text) else {
        return text.to_string();
    };
    match temporal_column_kind(data_type) {
        Some("date") => captures.date,
        Some("time") => {
            format!("{}{}", captures.time, normalize_mysql_fractional_seconds(captures.fraction.as_deref()))
        }
        _ => format!(
            "{} {}{}",
            captures.date,
            captures.time,
            normalize_mysql_fractional_seconds(captures.fraction.as_deref())
        ),
    }
}

struct Rfc3339Parts {
    date: String,
    time: String,
    fraction: Option<String>,
    zone: String,
}

fn regex_like_rfc3339(text: &str) -> Option<Rfc3339Parts> {
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
    if zone == "Z" || zone == "z" || is_timezone_offset(zone) {
        Some(Rfc3339Parts { date: date.to_string(), time: time.to_string(), fraction, zone: zone.to_string() })
    } else {
        None
    }
}

fn is_timezone_offset(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 6
        && matches!(bytes[0], b'+' | b'-')
        && bytes[3] == b':'
        && bytes[1].is_ascii_digit()
        && bytes[2].is_ascii_digit()
        && bytes[4].is_ascii_digit()
        && bytes[5].is_ascii_digit()
}

fn normalize_mysql_fractional_seconds(fraction: Option<&str>) -> String {
    match fraction {
        Some(fraction) if fraction.len() > 7 => fraction[..7].to_string(),
        Some(fraction) => fraction.to_string(),
        None => String::new(),
    }
}

fn is_temporal_column_type(data_type: &str) -> bool {
    temporal_column_kind(Some(data_type)).is_some()
}

fn temporal_column_kind(data_type: Option<&str>) -> Option<&'static str> {
    let base =
        data_type.unwrap_or("").trim().to_ascii_lowercase().split(['(', ':', ' ']).next().unwrap_or("").to_string();
    match base.as_str() {
        "date" => Some("date"),
        "time" => Some("time"),
        "datetime" | "timestamp" => Some("datetime"),
        _ => None,
    }
}

fn format_tdengine_timestamp_literal_text(text: &str) -> String {
    let Some((date, time, fraction)) = parse_tdengine_timestamp(text) else {
        return text.to_string();
    };
    format!(
        "{date}T{time}{}{suffix}",
        normalize_fractional_seconds(fraction.as_deref()),
        suffix = local_timezone_offset_suffix(text)
    )
}

fn parse_tdengine_timestamp(text: &str) -> Option<(String, String, Option<String>)> {
    if text.len() < 19 {
        return None;
    }
    let bytes = text.as_bytes();
    if bytes.get(4) != Some(&b'-') || bytes.get(7) != Some(&b'-') || bytes.get(10) != Some(&b' ') {
        return None;
    }
    if bytes.get(13) != Some(&b':') || bytes.get(16) != Some(&b':') {
        return None;
    }
    let date = text[0..10].to_string();
    let time = text[11..19].to_string();
    let rest = &text[19..];
    if rest.is_empty() {
        return Some((date, time, None));
    }
    let fraction = rest.strip_prefix('.')?;
    if fraction.is_empty() || fraction.len() > 9 || !fraction.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    Some((date, time, Some(format!(".{fraction}"))))
}

fn normalize_fractional_seconds(fraction: Option<&str>) -> String {
    match fraction {
        Some(fraction) if fraction.len() >= 4 => fraction[..4].to_string(),
        Some(fraction) => format!("{fraction:0<4}"),
        None => ".000".to_string(),
    }
}

fn local_timezone_offset_suffix(text: &str) -> String {
    let naive = NaiveDateTime::parse_from_str(&text.replace(' ', "T"), "%Y-%m-%dT%H:%M:%S%.f").ok();
    let offset_minutes = naive
        .and_then(|dt| {
            let local = dt.and_local_timezone(Local).earliest()?;
            Some(local.offset().local_minus_utc() / -60)
        })
        .unwrap_or_else(|| Local::now().offset().local_minus_utc() / -60);
    let sign = if offset_minutes <= 0 { "+" } else { "-" };
    let abs = offset_minutes.abs();
    format!("{sign}{:02}:{:02}", abs / 60, abs % 60)
}

fn build_primary_key_where(
    database_type: Option<DatabaseType>,
    primary_keys: &[String],
    columns: &[Option<String>],
    row: &[Value],
    column_info: &[DataGridColumnInfo],
) -> String {
    if primary_keys.is_empty() && uses_keyless_row_predicate(database_type) {
        return build_row_where(database_type, columns, row, column_info);
    }
    primary_keys
        .iter()
        .map(|primary_key| {
            let value = row
                .get(
                    columns
                        .iter()
                        .position(|column| column.as_deref() == Some(primary_key.as_str()))
                        .unwrap_or(usize::MAX),
                )
                .unwrap_or(&Value::Null);
            build_column_predicate(database_type, primary_key, value, column_info_for(column_info, primary_key), false)
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn build_row_where(
    database_type: Option<DatabaseType>,
    columns: &[Option<String>],
    row: &[Value],
    column_info: &[DataGridColumnInfo],
) -> String {
    columns
        .iter()
        .enumerate()
        .filter_map(|(index, column)| {
            let column = column.as_deref()?;
            if is_oracle_row_id(database_type, Some(column)) {
                return None;
            }
            Some(build_column_predicate(
                database_type,
                column,
                row.get(index).unwrap_or(&Value::Null),
                column_info_for(column_info, column),
                true,
            ))
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn build_save_row_where(
    database_type: Option<DatabaseType>,
    columns: &[Option<String>],
    row: &[Value],
    column_info: &[DataGridColumnInfo],
) -> String {
    columns
        .iter()
        .enumerate()
        .filter_map(|(index, column)| {
            let column = column.as_deref()?;
            if is_oracle_row_id(database_type, Some(column)) {
                return None;
            }
            Some(build_save_column_predicate(
                database_type,
                column,
                row.get(index).unwrap_or(&Value::Null),
                column_info_for(column_info, column),
                true,
            ))
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn build_column_predicate(
    database_type: Option<DatabaseType>,
    column: &str,
    value: &Value,
    column_info: Option<&DataGridColumnInfo>,
    use_binary_text_comparison: bool,
) -> String {
    let ident = predicate_ident(database_type, column);
    if value.is_null() {
        format!("{ident} IS NULL")
    } else if use_binary_text_comparison && uses_mysql_binary_text_predicate(database_type, value, column_info) {
        format!("BINARY {ident} = {}", format_grid_sql_literal(value, database_type, column_info))
    } else {
        format!("{ident} = {}", format_grid_sql_literal(value, database_type, column_info))
    }
}

fn build_save_column_predicate(
    database_type: Option<DatabaseType>,
    column: &str,
    value: &Value,
    column_info: Option<&DataGridColumnInfo>,
    use_binary_text_comparison: bool,
) -> String {
    let ident = predicate_ident(database_type, column);
    if value.is_null() || empty_string_saves_as_null(value, column_info) {
        format!("{ident} IS NULL")
    } else if use_binary_text_comparison && uses_mysql_binary_text_predicate(database_type, value, column_info) {
        format!("BINARY {ident} = {}", format_grid_save_sql_literal(value, database_type, column_info))
    } else {
        format!("{ident} = {}", format_grid_save_sql_literal(value, database_type, column_info))
    }
}

fn data_grid_statement(database_type: Option<DatabaseType>, sql: String) -> String {
    if database_type == Some(DatabaseType::ManticoreSearch) {
        sql
    } else {
        format!("{sql};")
    }
}

fn data_grid_update_sql(database_type: Option<DatabaseType>, table: &str, sets: &str, where_clause: &str) -> String {
    if database_type == Some(DatabaseType::ClickHouse) {
        format!("ALTER TABLE {table} UPDATE {sets} WHERE {where_clause}")
    } else {
        format!("UPDATE {table} SET {sets} WHERE {where_clause}")
    }
}

fn data_grid_delete_sql(database_type: Option<DatabaseType>, table: &str, where_clause: &str) -> String {
    if database_type == Some(DatabaseType::ClickHouse) {
        format!("ALTER TABLE {table} DELETE WHERE {where_clause}")
    } else {
        format!("DELETE FROM {table} WHERE {where_clause}")
    }
}

fn uses_mysql_binary_text_predicate(
    database_type: Option<DatabaseType>,
    value: &Value,
    column_info: Option<&DataGridColumnInfo>,
) -> bool {
    database_type == Some(DatabaseType::Mysql)
        && value.is_string()
        && column_info.map(|column| is_textual_column_type(&column.data_type)).unwrap_or(false)
}

fn is_textual_column_type(data_type: &str) -> bool {
    let lower = data_type.trim().to_ascii_lowercase();
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
        || lower.starts_with("national character varying")
}

fn is_oracle_row_id(database_type: Option<DatabaseType>, name: Option<&str>) -> bool {
    database_type == Some(DatabaseType::Oracle) && name.is_some_and(|name| name.eq_ignore_ascii_case(DBX_ROWID_COLUMN))
}

pub(crate) fn is_neo4j_element_id(database_type: Option<DatabaseType>, name: Option<&str>) -> bool {
    database_type == Some(DatabaseType::Neo4j) && name == Some(DBX_NEO4J_ELEMENT_ID_COLUMN)
}

fn is_auto_generated_column(column: &DataGridColumnInfo) -> bool {
    column
        .extra
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase()
        .split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
        .any(|part| matches!(part, "auto_increment" | "autoincrement" | "identity"))
}

fn is_grid_insert_omitted_column(
    database_type: Option<DatabaseType>,
    column_info: Option<&DataGridColumnInfo>,
    name: Option<&str>,
) -> bool {
    is_oracle_row_id(database_type, name)
        || is_postgres_tsvector_column(database_type, column_info)
        || is_non_identity_generated_column(column_info)
}

fn is_grid_update_omitted_column(
    database_type: Option<DatabaseType>,
    column_info: Option<&DataGridColumnInfo>,
    name: Option<&str>,
    primary_key_set: &[String],
) -> bool {
    is_oracle_row_id(database_type, name)
        || is_clickhouse_key_column(database_type, column_info, name, primary_key_set)
        || is_non_identity_generated_column(column_info)
}

fn is_clickhouse_key_column(
    database_type: Option<DatabaseType>,
    column_info: Option<&DataGridColumnInfo>,
    name: Option<&str>,
    primary_key_set: &[String],
) -> bool {
    if database_type != Some(DatabaseType::ClickHouse) {
        return false;
    }
    column_info.is_some_and(|column| column.is_primary_key)
        || is_clickhouse_partition_key_column(database_type, column_info)
        || name.is_some_and(|name| primary_key_set.contains(&normalize_column_name(name)))
}

fn is_clickhouse_partition_key_column(
    database_type: Option<DatabaseType>,
    column_info: Option<&DataGridColumnInfo>,
) -> bool {
    database_type == Some(DatabaseType::ClickHouse)
        && column_info.and_then(|column| column.extra.as_deref()).is_some_and(|extra| {
            extra.split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_').any(|part| part == "partition_key")
        })
}

fn is_postgres_tsvector_column(database_type: Option<DatabaseType>, column_info: Option<&DataGridColumnInfo>) -> bool {
    database_type == Some(DatabaseType::Postgres)
        && column_info.map(|column| is_postgres_tsvector_type(&column.data_type)).unwrap_or(false)
}

fn is_postgres_tsvector_type(data_type: &str) -> bool {
    let normalized = data_type.trim().trim_matches('"').to_ascii_lowercase();
    normalized == "tsvector" || normalized.ends_with(".tsvector")
}

fn is_non_identity_generated_column(column_info: Option<&DataGridColumnInfo>) -> bool {
    let extra = column_info.and_then(|column| column.extra.as_deref()).unwrap_or("").to_ascii_lowercase();
    extra.contains("generated always as") && !extra.contains("identity")
}

fn is_null_write_to_not_null_column(
    database_type: Option<DatabaseType>,
    not_null_columns: &[String],
    column: Option<&str>,
    value: &Value,
) -> bool {
    let Some(column) = column else {
        return false;
    };
    if is_oracle_row_id(database_type, Some(column)) || is_neo4j_element_id(database_type, Some(column)) {
        return false;
    }
    value.is_null() && not_null_columns.iter().any(|not_null| not_null == &normalize_column_name(column))
}

fn find_column_index(columns: &[Option<String>], target: &str) -> Option<usize> {
    let normalized_target = normalize_column_name(target);
    columns
        .iter()
        .position(|column| column.as_deref().map(normalize_column_name).unwrap_or_default() == normalized_target)
}

fn primary_key_value_key(primary_key_indexes: &[usize], row: &[Value]) -> Option<String> {
    let values: Vec<Value> =
        primary_key_indexes.iter().map(|index| row.get(*index).cloned().unwrap_or(Value::Null)).collect();
    if values.iter().any(Value::is_null) {
        return None;
    }
    serde_json::to_string(&values).ok()
}

fn duplicate_primary_key_error(
    primary_keys: &[String],
    primary_key_indexes: &[usize],
    row: &[Value],
    matches_existing_row: bool,
) -> String {
    let key_summary = primary_keys
        .iter()
        .enumerate()
        .map(|(index, primary_key)| {
            format!(
                "{} = {}",
                primary_key,
                format_key_value_for_message(row.get(primary_key_indexes[index]).unwrap_or(&Value::Null))
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let source = if matches_existing_row { "the existing primary key" } else { "another new row's primary key" };
    format!("New row duplicates {source} ({key_summary}). Change the key before saving.")
}

fn format_key_value_for_message(value: &Value) -> String {
    if value.is_null() {
        return "NULL".to_string();
    }
    if let Some(value) = value.as_str() {
        return format!("\"{}\"", value.replace('"', "\\\""));
    }
    value.to_string()
}

fn normalize_column_name(name: &str) -> String {
    name.to_ascii_uppercase()
}

fn null_write_error(column: &str) -> String {
    format!("Column \"{column}\" does not allow NULL.")
}

fn clickhouse_no_mutable_columns_error() -> String {
    "ClickHouse primary or partition key columns cannot be updated. Change a non-key column before saving.".to_string()
}

fn predicate_ident(database_type: Option<DatabaseType>, name: &str) -> String {
    if is_oracle_row_id(database_type, Some(name)) {
        "ROWIDTOCHAR(ROWID)".to_string()
    } else {
        quote_ident(database_type, name)
    }
}

pub(crate) fn quote_ident(database_type: Option<DatabaseType>, name: &str) -> String {
    quote_table_identifier(database_type, name)
}

pub(crate) fn qualified_table_name(
    database_type: Option<DatabaseType>,
    schema: Option<&str>,
    table_name: &str,
) -> String {
    crate::sql_dialect::qualified_table_name(database_type, schema, table_name)
}

fn column_filter_ref(database_type: Option<DatabaseType>, column_name: &str) -> String {
    let quoted = quote_ident(database_type, column_name);
    if database_type == Some(DatabaseType::Neo4j) {
        format!("n.{quoted}")
    } else {
        quoted
    }
}

fn column_like_filter_ref(
    database_type: Option<DatabaseType>,
    column_name: &str,
    column_info: Option<&DataGridColumnInfo>,
) -> String {
    let column = column_filter_ref(database_type, column_name);
    if is_postgres_like_pattern_database(database_type)
        && column_info.map(|column_info| !is_textual_column_type(&column_info.data_type)).unwrap_or(true)
    {
        format!("{column}::text")
    } else {
        column
    }
}

fn is_postgres_like_pattern_database(database_type: Option<DatabaseType>) -> bool {
    matches!(
        database_type,
        Some(
            DatabaseType::Postgres
                | DatabaseType::Redshift
                | DatabaseType::Gaussdb
                | DatabaseType::Kwdb
                | DatabaseType::Kingbase
                | DatabaseType::Highgo
                | DatabaseType::Vastbase
                | DatabaseType::OpenGauss
        )
    )
}

fn value_to_filter_text(value: &Value) -> String {
    if let Some(value) = value.as_str() {
        value.to_string()
    } else if value.is_null() {
        String::new()
    } else {
        value.to_string()
    }
}

fn parse_typed_filter_value(text: &str, column_info: Option<&DataGridColumnInfo>) -> Value {
    let unquoted = unwrap_matching_quotes(text);
    let data_type = column_info.map(|column| column.data_type.to_ascii_lowercase()).unwrap_or_default();
    if is_boolean_type(&data_type) && unquoted.eq_ignore_ascii_case("true") {
        return Value::Bool(true);
    }
    if is_boolean_type(&data_type) && unquoted.eq_ignore_ascii_case("false") {
        return Value::Bool(false);
    }
    if (is_numeric_type(&data_type) || data_type.is_empty()) && is_numeric_literal(&unquoted) {
        if let Ok(number) = unquoted.parse::<serde_json::Number>() {
            return Value::Number(number);
        }
    }
    Value::String(unquoted)
}

fn unwrap_matching_quotes(text: &str) -> String {
    let mut chars = text.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    let Some(last) = text.chars().last() else {
        return String::new();
    };
    if text.len() >= 2 && ((first == '\'' && last == '\'') || (first == '"' && last == '"')) {
        text[1..text.len() - 1].to_string()
    } else {
        text.to_string()
    }
}

fn is_numeric_type(data_type: &str) -> bool {
    let lower = data_type.to_ascii_lowercase();
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
        "float",
        "double",
        "real",
        "money",
    ]
    .iter()
    .any(|part| lower.split(|ch: char| !ch.is_ascii_alphanumeric()).any(|token| token == *part))
}

fn is_boolean_type(data_type: &str) -> bool {
    let lower = data_type.to_ascii_lowercase();
    lower.split(|ch: char| !ch.is_ascii_alphanumeric()).any(|token| matches!(token, "bool" | "boolean" | "bit"))
}

fn is_numeric_literal(text: &str) -> bool {
    if text.trim() != text || text.is_empty() {
        return false;
    }
    text.parse::<f64>().is_ok_and(f64::is_finite)
        && text.chars().all(|ch| ch.is_ascii_digit() || matches!(ch, '+' | '-' | '.' | 'e' | 'E'))
        && text.chars().any(|ch| ch.is_ascii_digit())
}

fn uses_keyless_row_predicate(database_type: Option<DatabaseType>) -> bool {
    matches!(
        database_type,
        Some(
            DatabaseType::Mysql
                | DatabaseType::ManticoreSearch
                | DatabaseType::Postgres
                | DatabaseType::Sqlite
                | DatabaseType::Rqlite
                | DatabaseType::Turso
                | DatabaseType::DuckDb
                | DatabaseType::SqlServer
                | DatabaseType::Oracle
                | DatabaseType::Doris
                | DatabaseType::StarRocks
                | DatabaseType::Redshift
                | DatabaseType::Dameng
                | DatabaseType::Gaussdb
                | DatabaseType::Kwdb
                | DatabaseType::Kingbase
                | DatabaseType::Highgo
                | DatabaseType::Vastbase
                | DatabaseType::Goldendb
                | DatabaseType::Yashandb
                | DatabaseType::Databricks
                | DatabaseType::SapHana
                | DatabaseType::Teradata
                | DatabaseType::Vertica
                | DatabaseType::Firebird
                | DatabaseType::Exasol
                | DatabaseType::OpenGauss
                | DatabaseType::Questdb
                | DatabaseType::OceanbaseOracle
                | DatabaseType::Gbase
                | DatabaseType::Access
                | DatabaseType::H2
                | DatabaseType::Snowflake
                | DatabaseType::Db2
                | DatabaseType::Informix
                | DatabaseType::Bigquery
                | DatabaseType::Sundb
                | DatabaseType::Databend
                | DatabaseType::Hive
                | DatabaseType::Iris
        )
    )
}

pub(crate) fn column_info_for<'a>(columns: &'a [DataGridColumnInfo], name: &str) -> Option<&'a DataGridColumnInfo> {
    let normalized = normalize_column_name(name);
    columns.iter().find(|column| normalize_column_name(&column.name) == normalized)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn column(name: &str, data_type: &str, nullable: bool, extra: Option<&str>) -> DataGridColumnInfo {
        DataGridColumnInfo {
            name: name.to_string(),
            data_type: data_type.to_string(),
            is_nullable: nullable,
            is_primary_key: false,
            column_default: None,
            extra: extra.map(ToString::to_string),
        }
    }

    #[test]
    fn builds_copy_update_statements() {
        let statements = build_data_grid_copy_update_statements(DataGridCopyUpdateStatementOptions {
            database_type: Some(DatabaseType::Postgres),
            table_meta: DataGridTableMeta {
                schema: Some("public".to_string()),
                table_name: "users".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: None,
            },
            columns: vec!["id".to_string(), "name".to_string(), "status".to_string()],
            source_columns: None,
            rows: vec![vec![json!(1), json!("Ada"), json!("active")]],
        });
        assert_eq!(
            statements,
            vec!["UPDATE \"public\".\"users\" SET \"name\" = 'Ada', \"status\" = 'active' WHERE \"id\" = 1;"]
        );
    }

    #[test]
    fn builds_copy_insert_statement_without_primary_keys() {
        let statement = build_data_grid_copy_insert_statement(DataGridCopyInsertStatementOptions {
            database_type: Some(DatabaseType::Mysql),
            table_meta: Some(DataGridTableMeta {
                schema: None,
                table_name: "users".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: None,
            }),
            columns: vec!["id".to_string(), "login_name".to_string(), "display_name".to_string()],
            source_columns: None,
            rows: vec![vec![json!(1), json!("ada"), json!("Ada")], vec![json!(2), json!("linus"), json!("Linus")]],
            exclude_primary_keys: true,
        });
        assert_eq!(
            statement.as_deref(),
            Some("INSERT INTO `users` (`login_name`, `display_name`) VALUES\n('ada', 'Ada'),\n('linus', 'Linus');")
        );
    }

    #[test]
    fn builds_copy_insert_statement_omits_postgres_tsvector_columns() {
        let statement = build_data_grid_copy_insert_statement(DataGridCopyInsertStatementOptions {
            database_type: Some(DatabaseType::Postgres),
            table_meta: Some(DataGridTableMeta {
                schema: Some("public".to_string()),
                table_name: "articles".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: Some(vec![
                    column("id", "integer", false, None),
                    column("title", "text", false, None),
                    column("search_vector", "tsvector", true, None),
                ]),
            }),
            columns: vec!["id".to_string(), "title".to_string(), "search_vector".to_string()],
            source_columns: None,
            rows: vec![vec![json!(1), json!("Hello"), json!("'hello':1A")]],
            exclude_primary_keys: false,
        });

        assert_eq!(
            statement.as_deref(),
            Some("INSERT INTO \"public\".\"articles\" (\"id\", \"title\") VALUES (1, 'Hello');")
        );
    }

    #[test]
    fn builds_filter_conditions() {
        assert_eq!(
            build_data_grid_column_value_filter_condition(DataGridColumnValueFilterConditionOptions {
                database_type: Some(DatabaseType::Mysql),
                column_name: "id".to_string(),
                column_info: Some(column("id", "int", false, None)),
                raw_value: "49436".to_string(),
            })
            .as_deref(),
            Some("`id` = 49436")
        );
        assert_eq!(
            build_data_grid_context_filter_condition(DataGridContextFilterConditionOptions {
                database_type: Some(DatabaseType::Postgres),
                column_name: "status".to_string(),
                mode: DataGridContextFilterMode::Like,
                value: json!("active"),
                column_info: Some(column("status", "varchar", true, None)),
            })
            .as_deref(),
            Some("\"status\" LIKE '%active%'")
        );
        assert_eq!(
            build_data_grid_context_filter_condition(DataGridContextFilterConditionOptions {
                database_type: Some(DatabaseType::Postgres),
                column_name: "update_date".to_string(),
                mode: DataGridContextFilterMode::Like,
                value: json!("128"),
                column_info: Some(column("update_date", "bigint", false, None)),
            })
            .as_deref(),
            Some("\"update_date\"::text LIKE '%128%'")
        );
        assert_eq!(
            build_data_grid_context_filter_condition(DataGridContextFilterConditionOptions {
                database_type: Some(DatabaseType::Postgres),
                column_name: "created_at".to_string(),
                mode: DataGridContextFilterMode::NotLike,
                value: json!("2026"),
                column_info: Some(column("created_at", "timestamp without time zone", false, None)),
            })
            .as_deref(),
            Some("\"created_at\"::text NOT LIKE '%2026%'")
        );
    }

    #[test]
    fn builds_multi_value_filter_conditions() {
        assert_eq!(
            build_data_grid_column_values_filter_condition(DataGridColumnValuesFilterConditionOptions {
                database_type: Some(DatabaseType::Postgres),
                column_name: "status".to_string(),
                column_info: Some(column("status", "varchar", true, None)),
                values: vec![json!("active"), json!("pending"), Value::Null, json!("active")],
            })
            .as_deref(),
            Some("(\"status\" IS NULL OR \"status\" IN ('active', 'pending'))")
        );
        assert_eq!(
            build_data_grid_column_values_filter_condition(DataGridColumnValuesFilterConditionOptions {
                database_type: Some(DatabaseType::Mysql),
                column_name: "id".to_string(),
                column_info: Some(column("id", "int", false, None)),
                values: vec![json!(42)],
            })
            .as_deref(),
            Some("`id` = 42")
        );
    }

    #[test]
    fn builds_column_distinct_values_sql() {
        assert_eq!(
            build_data_grid_column_distinct_values_sql(DataGridColumnDistinctValuesSqlOptions {
                database_type: Some(DatabaseType::Postgres),
                schema: Some("public".to_string()),
                table_name: "users".to_string(),
                column_name: "status".to_string(),
                column_info: Some(column("status", "varchar", true, None)),
                where_input: Some("WHERE deleted_at IS NULL;".to_string()),
                search_value: Some("act".to_string()),
                limit: None,
                include_counts: true,
            }),
            "SELECT \"status\" AS dbx_value, COUNT(*) AS dbx_count FROM \"public\".\"users\" WHERE (deleted_at IS NULL) AND \"status\" LIKE '%act%' GROUP BY \"status\" ORDER BY dbx_count DESC, dbx_value LIMIT 1000"
        );
        assert_eq!(
            build_data_grid_column_distinct_values_sql(DataGridColumnDistinctValuesSqlOptions {
                database_type: Some(DatabaseType::SqlServer),
                schema: None,
                table_name: "users".to_string(),
                column_name: "status".to_string(),
                column_info: Some(column("status", "nvarchar", true, None)),
                where_input: None,
                search_value: None,
                limit: Some(25),
                include_counts: false,
            }),
            "SELECT TOP (25) [status] AS dbx_value FROM [users] GROUP BY [status] ORDER BY dbx_value"
        );
        assert_eq!(
            build_data_grid_column_distinct_values_sql(DataGridColumnDistinctValuesSqlOptions {
                database_type: Some(DatabaseType::SqlServer),
                schema: None,
                table_name: "users".to_string(),
                column_name: "id".to_string(),
                column_info: Some(column("id", "int", false, None)),
                where_input: None,
                search_value: Some("42".to_string()),
                limit: Some(25),
                include_counts: true,
            }),
            "SELECT TOP (25) [id] AS dbx_value, COUNT(*) AS dbx_count FROM [users] WHERE [id] = 42 GROUP BY [id] ORDER BY dbx_count DESC, dbx_value"
        );
        assert_eq!(
            build_data_grid_column_distinct_values_sql(DataGridColumnDistinctValuesSqlOptions {
                database_type: Some(DatabaseType::Oracle),
                schema: Some("APP".to_string()),
                table_name: "EVENTS".to_string(),
                column_name: "KIND".to_string(),
                column_info: Some(column("KIND", "VARCHAR2", true, None)),
                where_input: None,
                search_value: None,
                limit: Some(10),
                include_counts: true,
            }),
            "SELECT * FROM (SELECT \"KIND\" AS dbx_value, COUNT(*) AS dbx_count FROM \"APP\".\"EVENTS\" GROUP BY \"KIND\" ORDER BY dbx_count DESC, dbx_value) WHERE ROWNUM <= 10"
        );
    }

    #[test]
    fn builds_grid_count_sql() {
        assert_eq!(
            build_data_grid_count_sql(DataGridCountSqlOptions {
                database_type: Some(DatabaseType::Postgres),
                schema: Some("public".to_string()),
                table_name: "users".to_string(),
                where_input: Some("WHERE active = true;".to_string()),
            }),
            "SELECT COUNT(*) AS cnt FROM \"public\".\"users\" WHERE (active = true)"
        );
    }

    #[test]
    fn builds_hive_table_properties_sql() {
        assert_eq!(
            build_hive_table_properties_sql(HiveTablePropertiesSqlOptions {
                schema: Some("default".to_string()),
                table_name: "events".to_string(),
                property_name: "transactional".to_string(),
            }),
            "SHOW TBLPROPERTIES `default`.`events` ('transactional')"
        );
    }

    #[test]
    fn formats_temporal_copy_literals() {
        assert_eq!(
            format_grid_sql_literal(&json!("2026-05-12T00:00:00+00:00"), Some(DatabaseType::Mysql), None),
            "'2026-05-12 00:00:00'"
        );
        assert_eq!(
            format_grid_sql_literal(&json!("2026-05-12T00:00:00.123456Z"), Some(DatabaseType::Mysql), None),
            "'2026-05-12 00:00:00.123456'"
        );
    }

    #[test]
    fn formats_sqlserver_datetime_copy_literals_with_supported_precision() {
        let datetime = column("date1", "datetime", true, None);
        let datetime2 = column("date2", "datetime2(7)", true, None);
        let raw_text = column("note", "nvarchar(64)", true, None);

        assert_eq!(
            format_grid_sql_literal(
                &json!("2026-06-29 10:11:12.896666666"),
                Some(DatabaseType::SqlServer),
                Some(&datetime)
            ),
            "N'2026-06-29 10:11:12.897'"
        );
        assert_eq!(
            format_grid_sql_literal(
                &json!("2026-06-29 10:11:12.8966666"),
                Some(DatabaseType::SqlServer),
                Some(&datetime2)
            ),
            "N'2026-06-29 10:11:12.8966666'"
        );
        assert_eq!(
            format_grid_sql_literal(
                &json!("2026-06-29 10:11:12.896666666"),
                Some(DatabaseType::SqlServer),
                Some(&raw_text)
            ),
            "N'2026-06-29 10:11:12.896666666'"
        );
    }

    #[test]
    fn formats_oracle_temporal_literals_without_nls_parsing() {
        let timestamp = column("created_at", "TIMESTAMP(6)", true, None);
        let timestamp_tz = column("recorded_at", "TIMESTAMP(6) WITH TIME ZONE", true, None);
        let timestamp_ltz = column("local_recorded_at", "TIMESTAMP(6) WITH LOCAL TIME ZONE", true, None);
        let date = column("event_day", "DATE", true, None);
        let text = column("raw_text", "VARCHAR2(64)", true, None);

        assert_eq!(
            format_grid_sql_literal(&json!("2022-08-25T09:58:43Z"), Some(DatabaseType::Oracle), Some(&timestamp)),
            "TO_TIMESTAMP('2022-08-25 09:58:43', 'YYYY-MM-DD HH24:MI:SS')"
        );
        assert_eq!(
            format_grid_sql_literal(
                &json!("2022-08-25T09:58:43.123456+08:00"),
                Some(DatabaseType::Oracle),
                Some(&timestamp_tz)
            ),
            "TO_TIMESTAMP_TZ('2022-08-25 09:58:43.123456 +08:00', 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM')"
        );
        assert_eq!(
            format_grid_sql_literal(&json!("2022-08-25T09:58:43Z"), Some(DatabaseType::Oracle), Some(&timestamp_ltz)),
            "TO_TIMESTAMP_TZ('2022-08-25 09:58:43 +00:00', 'YYYY-MM-DD HH24:MI:SS TZH:TZM')"
        );
        assert_eq!(
            format_grid_sql_literal(&json!("2022-08-25T09:58:43Z"), Some(DatabaseType::Oracle), Some(&date)),
            "TO_DATE('2022-08-25 09:58:43', 'YYYY-MM-DD HH24:MI:SS')"
        );
        assert_eq!(
            format_grid_sql_literal(&json!("2022-08-25T09:58:43Z"), Some(DatabaseType::Oracle), Some(&text)),
            "'2022-08-25T09:58:43Z'"
        );
    }

    #[test]
    fn prepares_oracle_timestamp_insert_from_iso_grid_value() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Oracle),
            table_meta: DataGridTableMeta {
                schema: Some("APP".to_string()),
                table_name: "EVENTS".to_string(),
                primary_keys: vec!["ID".to_string()],
                columns: Some(vec![
                    column("ID", "NUMBER", false, None),
                    column("CREATED_AT", "TIMESTAMP(6)", true, None),
                ]),
            },
            columns: vec!["ID".to_string(), "CREATED_AT".to_string()],
            source_columns: None,
            rows: vec![],
            dirty_rows: vec![],
            deleted_rows: vec![],
            new_rows: vec![vec![json!(1), json!("2022-08-25T09:58:43Z")]],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(
            result.statements,
            vec![
                "INSERT INTO \"APP\".\"EVENTS\" (\"ID\", \"CREATED_AT\") VALUES (1, TO_TIMESTAMP('2022-08-25 09:58:43', 'YYYY-MM-DD HH24:MI:SS'));"
            ]
        );
    }

    #[test]
    fn formats_mysql_bit_literals_without_string_quotes() {
        let bit = column("flag", "bit(1)", true, None);
        let bit_string = column("flags", "bit(8)", true, None);

        assert_eq!(format_grid_sql_literal(&json!("0"), Some(DatabaseType::Mysql), Some(&bit)), "0");
        assert_eq!(format_grid_sql_literal(&json!("1"), Some(DatabaseType::Mysql), Some(&bit)), "1");
        assert_eq!(format_grid_sql_literal(&json!(true), Some(DatabaseType::Mysql), Some(&bit)), "1");
        assert_eq!(
            format_grid_sql_literal(&json!("10101010"), Some(DatabaseType::Mysql), Some(&bit_string)),
            "b'10101010'"
        );
        assert_eq!(format_grid_sql_literal(&json!("0"), Some(DatabaseType::Postgres), Some(&bit)), "'0'");
    }

    #[test]
    fn saves_empty_nullable_mysql_numeric_cell_as_null() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Mysql),
            table_meta: DataGridTableMeta {
                schema: None,
                table_name: "employees".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: Some(vec![column("id", "int(11)", false, None), column("age", "int(11)", true, None)]),
            },
            columns: vec!["id".to_string(), "age".to_string()],
            source_columns: None,
            rows: vec![vec![json!(2), json!(36)]],
            dirty_rows: vec![(0, vec![(1, json!(""))])],
            deleted_rows: vec![],
            new_rows: vec![],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(result.statements, vec!["UPDATE `employees` SET `age` = NULL WHERE `id` = 2;"]);
        assert_eq!(
            result.rollback_statements,
            vec!["UPDATE `employees` SET `age` = 36 WHERE `id` = 2 AND `age` IS NULL;"]
        );
    }

    #[test]
    fn keeps_empty_nullable_mysql_text_cell_as_empty_string() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Mysql),
            table_meta: DataGridTableMeta {
                schema: None,
                table_name: "employees".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: Some(vec![column("id", "int(11)", false, None), column("name", "varchar(50)", true, None)]),
            },
            columns: vec!["id".to_string(), "name".to_string()],
            source_columns: None,
            rows: vec![vec![json!(2), json!("Ada")]],
            dirty_rows: vec![(0, vec![(1, json!(""))])],
            deleted_rows: vec![],
            new_rows: vec![],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(result.statements, vec!["UPDATE `employees` SET `name` = '' WHERE `id` = 2;"]);
        assert_eq!(
            result.rollback_statements,
            vec!["UPDATE `employees` SET `name` = 'Ada' WHERE `id` = 2 AND BINARY `name` = '';"]
        );
    }

    #[test]
    fn prepares_sqlserver_save_statements() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::SqlServer),
            table_meta: DataGridTableMeta {
                schema: Some("game".to_string()),
                table_name: "player states".to_string(),
                primary_keys: vec!["role id".to_string()],
                columns: None,
            },
            columns: vec!["role id".to_string(), "state".to_string(), "updated at".to_string()],
            source_columns: None,
            rows: vec![vec![json!(42), json!("old"), json!("2026-05-03")]],
            dirty_rows: vec![(0, vec![(1, json!("ready")), (2, json!("2026-05-04"))])],
            deleted_rows: vec![0],
            new_rows: vec![vec![json!(43), json!("new"), json!("2026-05-05")]],
        });

        assert_eq!(
            result.statements,
            vec![
                "UPDATE [game].[player states] SET [state] = N'ready', [updated at] = N'2026-05-04' WHERE [role id] = 42;",
                "DELETE FROM [game].[player states] WHERE [role id] = 42;",
                "INSERT INTO [game].[player states] ([role id], [state], [updated at]) VALUES (43, N'new', N'2026-05-05');",
            ]
        );
    }

    #[test]
    fn prepares_databend_save_statements() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Databend),
            table_meta: DataGridTableMeta {
                schema: Some("default".to_string()),
                table_name: "people".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: Some(vec![column("id", "int", false, None), column("name", "string", true, None)]),
            },
            columns: vec!["id".to_string(), "name".to_string()],
            source_columns: None,
            rows: vec![vec![json!(1), json!("Ada")]],
            dirty_rows: vec![(0, vec![(1, json!("Linus"))])],
            deleted_rows: vec![0],
            new_rows: vec![vec![json!(2), json!("Grace")]],
        });

        assert_eq!(
            result.statements,
            vec![
                "UPDATE `default`.`people` SET `name` = 'Linus' WHERE `id` = 1;",
                "DELETE FROM `default`.`people` WHERE `id` = 1;",
                "INSERT INTO `default`.`people` (`id`, `name`) VALUES (2, 'Grace');",
            ]
        );
    }

    #[test]
    fn prepares_clickhouse_mutation_save_statements() {
        let mut id_column = column("id", "UInt64", false, None);
        id_column.is_primary_key = true;
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::ClickHouse),
            table_meta: DataGridTableMeta {
                schema: Some("default".to_string()),
                table_name: "people".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: Some(vec![id_column, column("name", "String", true, None)]),
            },
            columns: vec!["id".to_string(), "name".to_string()],
            source_columns: None,
            rows: vec![vec![json!(1), json!("Ada")]],
            dirty_rows: vec![(0, vec![(1, json!("Linus"))])],
            deleted_rows: vec![0],
            new_rows: vec![vec![json!(2), json!("Grace")]],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(
            result.statements,
            vec![
                "ALTER TABLE `people` UPDATE `name` = 'Linus' WHERE `id` = 1;",
                "ALTER TABLE `people` DELETE WHERE `id` = 1;",
                "INSERT INTO `people` (`id`, `name`) VALUES (2, 'Grace');",
            ]
        );
        assert!(result.rollback_statements.is_empty());
    }

    #[test]
    fn rejects_clickhouse_key_only_update() {
        let mut id_column = column("id", "UInt64", false, None);
        id_column.is_primary_key = true;
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::ClickHouse),
            table_meta: DataGridTableMeta {
                schema: Some("default".to_string()),
                table_name: "people".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: Some(vec![id_column, column("name", "String", true, None)]),
            },
            columns: vec!["id".to_string(), "name".to_string()],
            source_columns: None,
            rows: vec![vec![json!(1), json!("Ada")]],
            dirty_rows: vec![(0, vec![(0, json!(2))])],
            deleted_rows: vec![],
            new_rows: vec![],
        });

        assert_eq!(
            result.validation_error,
            Some(
                "ClickHouse primary or partition key columns cannot be updated. Change a non-key column before saving."
                    .to_string()
            )
        );
        assert!(result.statements.is_empty());
    }

    #[test]
    fn omits_clickhouse_partition_key_update_assignments() {
        let mut event_date_column = column("event_date", "Date", false, Some("partition_key"));
        event_date_column.is_primary_key = false;
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::ClickHouse),
            table_meta: DataGridTableMeta {
                schema: Some("default".to_string()),
                table_name: "events".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: Some(vec![
                    column("id", "UInt64", false, None),
                    event_date_column,
                    column("name", "String", true, None),
                ]),
            },
            columns: vec!["id".to_string(), "event_date".to_string(), "name".to_string()],
            source_columns: None,
            rows: vec![vec![json!(1), json!("2026-06-24"), json!("Ada")]],
            dirty_rows: vec![(0, vec![(1, json!("2026-06-25")), (2, json!("Linus"))])],
            deleted_rows: vec![],
            new_rows: vec![],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(result.statements, vec!["ALTER TABLE `events` UPDATE `name` = 'Linus' WHERE `id` = 1;"]);
    }

    #[test]
    fn rejects_clickhouse_partition_key_only_update() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::ClickHouse),
            table_meta: DataGridTableMeta {
                schema: Some("default".to_string()),
                table_name: "events".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: Some(vec![
                    column("id", "UInt64", false, None),
                    column("event_date", "Date", false, Some("partition_key")),
                    column("name", "String", true, None),
                ]),
            },
            columns: vec!["id".to_string(), "event_date".to_string(), "name".to_string()],
            source_columns: None,
            rows: vec![vec![json!(1), json!("2026-06-24"), json!("Ada")]],
            dirty_rows: vec![(0, vec![(1, json!("2026-06-25"))])],
            deleted_rows: vec![],
            new_rows: vec![],
        });

        assert_eq!(
            result.validation_error,
            Some(
                "ClickHouse primary or partition key columns cannot be updated. Change a non-key column before saving."
                    .to_string()
            )
        );
        assert!(result.statements.is_empty());
    }

    #[test]
    fn builds_clickhouse_copy_update_statements() {
        let statements = build_data_grid_copy_update_statements(DataGridCopyUpdateStatementOptions {
            database_type: Some(DatabaseType::ClickHouse),
            table_meta: DataGridTableMeta {
                schema: Some("default".to_string()),
                table_name: "people".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: Some(vec![column("id", "UInt64", false, None), column("name", "String", true, None)]),
            },
            columns: vec!["id".to_string(), "name".to_string()],
            source_columns: None,
            rows: vec![vec![json!(1), json!("Ada")]],
        });

        assert_eq!(statements, vec!["ALTER TABLE `people` UPDATE `name` = 'Ada' WHERE `id` = 1;"]);
    }

    #[test]
    fn prepares_databend_keyless_save_statements_with_row_predicate() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Databend),
            table_meta: DataGridTableMeta {
                schema: Some("default".to_string()),
                table_name: "people".to_string(),
                primary_keys: vec![],
                columns: Some(vec![column("id", "int", true, None), column("name", "string", true, None)]),
            },
            columns: vec!["id".to_string(), "name".to_string()],
            source_columns: None,
            rows: vec![vec![json!(1), json!("Ada")]],
            dirty_rows: vec![(0, vec![(1, json!("Linus"))])],
            deleted_rows: vec![0],
            new_rows: vec![],
        });

        assert_eq!(
            result.statements,
            vec![
                "UPDATE `default`.`people` SET `name` = 'Linus' WHERE `id` = 1 AND `name` = 'Ada';",
                "DELETE FROM `default`.`people` WHERE `id` = 1 AND `name` = 'Ada';",
            ]
        );
    }

    #[test]
    fn skips_expression_only_source_columns() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Postgres),
            table_meta: DataGridTableMeta {
                schema: Some("public".to_string()),
                table_name: "ihli_data".to_string(),
                primary_keys: vec!["iso3".to_string(), "year".to_string()],
                columns: None,
            },
            columns: vec!["iso3".to_string(), "year".to_string(), "country_name".to_string(), "score".to_string()],
            source_columns: Some(vec![
                Some("iso3".to_string()),
                Some("year".to_string()),
                Some("country_name".to_string()),
                None,
            ]),
            rows: vec![vec![json!("LUX"), json!(2007), json!("Luxembourg"), json!(50242.1)]],
            dirty_rows: vec![(0, vec![(2, json!("Luxembourg City")), (3, json!(999))])],
            deleted_rows: vec![],
            new_rows: vec![vec![json!("USA"), json!(2008), json!("United States"), json!(43000)]],
        });

        assert_eq!(
            result.statements,
            vec![
                r#"UPDATE "public"."ihli_data" SET "country_name" = 'Luxembourg City' WHERE "iso3" = 'LUX' AND "year" = 2007;"#,
                r#"INSERT INTO "public"."ihli_data" ("iso3", "year", "country_name") VALUES ('USA', 2008, 'United States');"#,
            ]
        );
    }

    #[test]
    fn formats_mysql_temporal_columns_by_target_type() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Mysql),
            table_meta: DataGridTableMeta {
                schema: None,
                table_name: "policies".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: Some(vec![
                    column("id", "int", false, None),
                    column("insurance_start_time", "datetime", true, None),
                    column("raw_text", "varchar(64)", true, None),
                    column("coverage_day", "date", true, None),
                    column("start_clock", "time", true, None),
                ]),
            },
            columns: vec![
                "id".to_string(),
                "insurance_start_time".to_string(),
                "raw_text".to_string(),
                "coverage_day".to_string(),
                "start_clock".to_string(),
            ],
            source_columns: None,
            rows: vec![vec![
                json!(1),
                json!("2026-05-12T00:00:00+00:00"),
                json!("old"),
                json!("2026-05-12T00:00:00+00:00"),
                json!("2026-05-12T09:30:45+00:00"),
            ]],
            dirty_rows: vec![(
                0,
                vec![
                    (1, json!("2026-05-12T00:00:00+00:00")),
                    (2, json!("2026-05-12T00:00:00+00:00")),
                    (3, json!("2026-05-12T00:00:00+00:00")),
                    (4, json!("2026-05-12T09:30:45+00:00")),
                ],
            )],
            deleted_rows: vec![],
            new_rows: vec![],
        });

        assert_eq!(
            result.statements,
            vec!["UPDATE `policies` SET `insurance_start_time` = '2026-05-12 00:00:00', `raw_text` = '2026-05-12T00:00:00+00:00', `coverage_day` = '2026-05-12', `start_clock` = '09:30:45' WHERE `id` = 1;"]
        );
    }

    #[test]
    fn mysql_primary_key_text_predicates_do_not_use_binary_comparison() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Mysql),
            table_meta: DataGridTableMeta {
                schema: None,
                table_name: "school".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: Some(vec![column("id", "varchar(32)", true, None), column("age", "varchar(8)", false, None)]),
            },
            columns: vec!["id".to_string(), "age".to_string()],
            source_columns: None,
            rows: vec![vec![json!("0001492305e412e88086bd582d2678e0"), json!("17")]],
            dirty_rows: vec![(0, vec![(1, json!("18"))])],
            deleted_rows: vec![],
            new_rows: vec![],
        });

        assert_eq!(
            result.statements,
            vec!["UPDATE `school` SET `age` = '18' WHERE `id` = '0001492305e412e88086bd582d2678e0';"]
        );
    }

    #[test]
    fn mysql_row_text_predicates_use_binary_comparison_for_width_sensitive_edits() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Mysql),
            table_meta: DataGridTableMeta {
                schema: None,
                table_name: "parts".to_string(),
                primary_keys: vec![],
                columns: Some(vec![column("code", "varchar(32)", true, None)]),
            },
            columns: vec!["code".to_string()],
            source_columns: None,
            rows: vec![vec![json!("S471355(0)")]],
            dirty_rows: vec![(0, vec![(0, json!("S471355（0）"))])],
            deleted_rows: vec![],
            new_rows: vec![],
        });

        assert_eq!(
            result.statements,
            vec!["UPDATE `parts` SET `code` = 'S471355（0）' WHERE BINARY `code` = 'S471355(0)';"]
        );
        assert_eq!(
            result.rollback_statements,
            vec![
                "UPDATE `parts` SET `code` = 'S471355(0)' WHERE BINARY `code` = 'S471355（0）' AND BINARY `code` = 'S471355（0）';"
            ]
        );
    }

    #[test]
    fn prepares_manticore_save_statements_without_trailing_semicolons() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::ManticoreSearch),
            table_meta: DataGridTableMeta {
                schema: None,
                table_name: "rt_products".to_string(),
                primary_keys: vec![],
                columns: Some(vec![column("id", "bigint", false, None), column("title", "text", true, None)]),
            },
            columns: vec!["id".to_string(), "title".to_string()],
            source_columns: None,
            rows: vec![vec![json!("1"), json!("old")], vec![json!("2"), json!("deleted")]],
            dirty_rows: vec![(0, vec![(1, json!("new"))])],
            deleted_rows: vec![1],
            new_rows: vec![vec![json!("3"), json!("inserted")]],
        });

        assert_eq!(
            result.statements,
            vec![
                "UPDATE `rt_products` SET `title` = 'new' WHERE `id` = 1 AND `title` = 'old'",
                "DELETE FROM `rt_products` WHERE `id` = 2 AND `title` = 'deleted'",
                "INSERT INTO `rt_products` (`id`, `title`) VALUES (3, 'inserted')",
            ]
        );
        assert!(result.rollback_statements.iter().all(|statement| !statement.ends_with(';')));
    }

    #[test]
    fn validates_duplicate_inserted_primary_keys() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Postgres),
            table_meta: DataGridTableMeta {
                schema: None,
                table_name: "education_data".to_string(),
                primary_keys: vec!["country_code".to_string(), "year".to_string()],
                columns: None,
            },
            columns: vec!["country_code".to_string(), "year".to_string(), "value".to_string()],
            source_columns: None,
            rows: vec![vec![json!("ALB"), json!(2021), json!(0.812)]],
            dirty_rows: vec![],
            deleted_rows: vec![],
            new_rows: vec![vec![json!("ALB"), json!(2021), json!(0.913)]],
        });

        assert_eq!(
            result.validation_error,
            Some(r#"New row duplicates the existing primary key (country_code = "ALB", year = 2021). Change the key before saving."#.to_string())
        );
        assert!(result.statements.is_empty());
    }

    fn pk_column(name: &str, data_type: &str, nullable: bool, extra: Option<&str>) -> DataGridColumnInfo {
        DataGridColumnInfo {
            name: name.to_string(),
            data_type: data_type.to_string(),
            is_nullable: nullable,
            is_primary_key: true,
            column_default: None,
            extra: extra.map(ToString::to_string),
        }
    }

    #[test]
    fn prepare_data_grid_save_skips_sqlite_autoincrement_pk_validation() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Sqlite),
            table_meta: DataGridTableMeta {
                schema: None,
                table_name: "OnlineLogs".to_string(),
                primary_keys: vec!["OnlineLogId".to_string()],
                columns: Some(vec![
                    pk_column("OnlineLogId", "INTEGER", false, Some("autoincrement")),
                    column("LogTime", "TEXT", false, None),
                ]),
            },
            columns: vec!["OnlineLogId".to_string(), "LogTime".to_string()],
            source_columns: None,
            rows: vec![],
            dirty_rows: vec![],
            deleted_rows: vec![],
            new_rows: vec![vec![Value::Null, json!("2026-06-12T00:00:00Z")]],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(result.statements, vec![r#"INSERT INTO "OnlineLogs" ("LogTime") VALUES ('2026-06-12T00:00:00Z');"#]);
    }

    #[test]
    fn prepare_data_grid_save_includes_explicit_sqlite_pk_value() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Sqlite),
            table_meta: DataGridTableMeta {
                schema: None,
                table_name: "OnlineLogs".to_string(),
                primary_keys: vec!["OnlineLogId".to_string()],
                columns: Some(vec![
                    pk_column("OnlineLogId", "INTEGER", false, Some("autoincrement")),
                    column("LogTime", "TEXT", false, None),
                ]),
            },
            columns: vec!["OnlineLogId".to_string(), "LogTime".to_string()],
            source_columns: None,
            rows: vec![],
            dirty_rows: vec![],
            deleted_rows: vec![],
            new_rows: vec![vec![json!(42), json!("2026-06-12T00:00:00Z")]],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(
            result.statements,
            vec![r#"INSERT INTO "OnlineLogs" ("OnlineLogId", "LogTime") VALUES (42, '2026-06-12T00:00:00Z');"#]
        );
    }

    #[test]
    fn prepare_data_grid_save_still_validates_other_not_null_columns_in_sqlite() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Sqlite),
            table_meta: DataGridTableMeta {
                schema: None,
                table_name: "OnlineLogs".to_string(),
                primary_keys: vec!["OnlineLogId".to_string()],
                columns: Some(vec![
                    pk_column("OnlineLogId", "INTEGER", false, Some("autoincrement")),
                    column("LogTime", "TEXT", false, None),
                ]),
            },
            columns: vec!["OnlineLogId".to_string(), "LogTime".to_string()],
            source_columns: None,
            rows: vec![],
            dirty_rows: vec![],
            deleted_rows: vec![],
            new_rows: vec![vec![Value::Null, Value::Null]],
        });

        assert_eq!(result.validation_error, Some(r#"Column "LogTime" does not allow NULL."#.to_string()));
        assert!(result.statements.is_empty());
    }
}
