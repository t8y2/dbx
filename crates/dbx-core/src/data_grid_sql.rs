use chrono::{Local, NaiveDateTime};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

#[path = "data_grid_neo4j_sql.rs"]
mod data_grid_neo4j_sql;
use data_grid_neo4j_sql::{build_neo4j_data_grid_rollback_statements, build_neo4j_data_grid_save_statements};

#[path = "data_grid_tdengine_sql.rs"]
mod data_grid_tdengine_sql;
use data_grid_tdengine_sql::{
    build_tdengine_data_grid_rollback_statements, build_tdengine_data_grid_save_statements,
    validate_tdengine_existing_rows, validate_tdengine_inserted_rows,
};

use crate::models::connection::DatabaseType;
use crate::sql_dialect::{
    firebird_rows_clause, quote_table_identifier, table_pagination_strategy, uses_oracle_row_id,
    uses_single_row_insert_statements, TablePaginationStrategy,
};
use crate::transfer::{format_ch_array_sql_literal, format_pg_array_sql_literal};

const DBX_ROWID_COLUMN: &str = "__DBX_ROWID";
pub(crate) const DBX_NEO4J_ELEMENT_ID_COLUMN: &str = "__DBX_ELEMENT_ID";
pub(crate) const DBX_TDENGINE_TBNAME_COLUMN: &str = "tbname";
const DATA_GRID_COLUMN_DISTINCT_VALUES_DEFAULT_LIMIT: usize = 1000;
const DATA_GRID_COLUMN_DISTINCT_VALUES_MAX_LIMIT: usize = 1000;
const MYSQL_DATA_GRID_BATCH_MAX_ROWS: usize = 500;
const MYSQL_DATA_GRID_BATCH_TARGET_SQL_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataGridTableMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog: Option<String>,
    /// Doris / StarRocks multi-catalog: the database under the external
    /// catalog, used as the middle segment of the 3-part qualified name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identifier_quote: Option<String>,
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
    pub column_types: Option<Vec<Option<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_columns: Option<Vec<Option<String>>>,
    #[serde(default)]
    pub rows: Vec<Vec<Value>>,
    #[serde(default)]
    pub exclude_primary_keys: bool,
    #[serde(default)]
    pub insert_mode: DataGridCopyInsertMode,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DataGridCopyInsertMode {
    #[default]
    Merged,
    RowByRow,
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
    In,
    NotIn,
    Between,
    NotBetween,
}

fn supports_data_grid_context_filter_mode(
    database_type: Option<DatabaseType>,
    mode: DataGridContextFilterMode,
) -> bool {
    !matches!(
        (database_type, mode),
        (
            Some(DatabaseType::InfluxDb | DatabaseType::Cassandra | DatabaseType::Jdbc),
            DataGridContextFilterMode::In
                | DataGridContextFilterMode::NotIn
                | DataGridContextFilterMode::Between
                | DataGridContextFilterMode::NotBetween
        )
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataGridContextFilterConditionOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identifier_quote: Option<String>,
    pub column_name: String,
    pub mode: DataGridContextFilterMode,
    pub value: Value,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub values: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_value: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column_info: Option<DataGridColumnInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataGridColumnValueFilterConditionOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identifier_quote: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identifier_quote: Option<String>,
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
    pub identifier_quote: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
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
    pub identifier_quote: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog: Option<String>,
    /// Doris / StarRocks multi-catalog: the database under the external
    /// catalog, used as the middle segment of the 3-part qualified name when
    /// `schema` is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
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
    let primary_key_indexes: Vec<Option<usize>> = primary_keys
        .iter()
        .map(|primary_key| find_column_index(options.database_type, &save_columns, primary_key))
        .collect();
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

    let table = data_grid_qualified_table_name(
        options.database_type,
        options.table_meta.catalog.as_deref(),
        options.table_meta.schema.as_deref(),
        options.table_meta.database.as_deref(),
        &options.table_meta.table_name,
        None,
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
                    data_grid_identifier(options.database_type, column, None),
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
                    None,
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

    if insert_columns.is_empty() || options.rows.is_empty() {
        return None;
    }

    let table = options.table_meta.as_ref().map_or_else(
        || "table_name".to_string(),
        |meta| {
            crate::sql_dialect::qualified_table_name_with_catalog(
                options.database_type,
                meta.catalog.as_deref(),
                meta.schema.as_deref(),
                meta.database.as_deref(),
                &meta.table_name,
            )
        },
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
                        format_grid_copy_insert_sql_literal(
                            row.get(*index).unwrap_or(&Value::Null),
                            options.database_type,
                            copy_column_info(
                                column_info,
                                column,
                                options
                                    .column_types
                                    .as_deref()
                                    .and_then(|types| types.get(*index))
                                    .and_then(|value| value.as_deref()),
                            )
                            .as_ref(),
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
        .collect::<Vec<_>>();
    if options.insert_mode == DataGridCopyInsertMode::RowByRow
        || options.database_type.is_some_and(uses_single_row_insert_statements)
    {
        return Some(
            value_rows
                .iter()
                .map(|values| format!("INSERT INTO {table} ({columns}) VALUES {values};"))
                .collect::<Vec<_>>()
                .join("\n"),
        );
    }
    Some(format!(
        "INSERT INTO {table} ({columns}) VALUES{}{};",
        if value_rows.len() == 1 { " " } else { "\n" },
        value_rows.join(",\n")
    ))
}

pub fn build_data_grid_context_filter_condition(options: DataGridContextFilterConditionOptions) -> Option<String> {
    if !supports_data_grid_context_filter_mode(options.database_type, options.mode) {
        return None;
    }

    let column = column_filter_ref(options.database_type, &options.column_name, options.identifier_quote.as_deref());
    let like_column = column_like_filter_ref(
        options.database_type,
        &options.column_name,
        options.column_info.as_ref(),
        options.identifier_quote.as_deref(),
    );
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
        DataGridContextFilterMode::In => build_data_grid_context_membership_filter_condition(
            &column,
            &options.values,
            options.database_type,
            options.column_info.as_ref(),
            false,
        ),
        DataGridContextFilterMode::NotIn => build_data_grid_context_membership_filter_condition(
            &column,
            &options.values,
            options.database_type,
            options.column_info.as_ref(),
            true,
        ),
        DataGridContextFilterMode::Between => build_data_grid_context_range_filter_condition(
            &column,
            value,
            options.end_value.as_ref(),
            options.database_type,
            options.column_info.as_ref(),
            false,
        ),
        DataGridContextFilterMode::NotBetween => build_data_grid_context_range_filter_condition(
            &column,
            value,
            options.end_value.as_ref(),
            options.database_type,
            options.column_info.as_ref(),
            true,
        ),
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

fn build_data_grid_context_membership_filter_condition(
    column: &str,
    values: &[Value],
    database_type: Option<DatabaseType>,
    column_info: Option<&DataGridColumnInfo>,
    negated: bool,
) -> Option<String> {
    if values.is_empty() {
        return None;
    }

    let mut has_null = false;
    let mut literals = Vec::new();
    let mut seen_literals = HashSet::new();
    for value in values {
        if value.is_null() {
            has_null = true;
            continue;
        }
        let literal = format_grid_sql_literal(value, database_type, column_info);
        if seen_literals.insert(literal.clone()) {
            literals.push(literal);
        }
    }

    let membership = build_membership_predicate(column, &literals, database_type, negated);

    if negated {
        return match membership {
            Some(membership) => Some(format!("({column} IS NOT NULL AND {membership})")),
            None if has_null => Some(format!("{column} IS NOT NULL")),
            None => None,
        };
    }

    match membership {
        Some(membership) if has_null => Some(format!("({column} IS NULL OR {membership})")),
        Some(membership) => Some(membership),
        None if has_null => Some(format!("{column} IS NULL")),
        None => None,
    }
}

fn build_membership_predicate(
    column: &str,
    literals: &[String],
    database_type: Option<DatabaseType>,
    negated: bool,
) -> Option<String> {
    if literals.is_empty() {
        return None;
    }
    if database_type == Some(DatabaseType::Neo4j) {
        let predicate = format!("{column} IN [{}]", literals.join(", "));
        return Some(if negated { format!("NOT ({predicate})") } else { predicate });
    }

    let operator = if negated { "NOT IN" } else { "IN" };
    if database_type != Some(DatabaseType::Oracle) || literals.len() <= 1000 {
        return Some(format!("{column} {operator} ({})", literals.join(", ")));
    }

    // Oracle limits each IN expression to 1000 values; preserve NOT IN semantics
    // by joining its chunks with AND instead of OR.
    let joiner = if negated { " AND " } else { " OR " };
    let chunks =
        literals.chunks(1000).map(|chunk| format!("{column} {operator} ({})", chunk.join(", "))).collect::<Vec<_>>();
    Some(format!("({})", chunks.join(joiner)))
}

fn build_data_grid_context_range_filter_condition(
    column: &str,
    start_value: &Value,
    end_value: Option<&Value>,
    database_type: Option<DatabaseType>,
    column_info: Option<&DataGridColumnInfo>,
    negated: bool,
) -> Option<String> {
    let end_value = end_value?;
    if start_value.is_null() || end_value.is_null() {
        return None;
    }
    let start = format_grid_sql_literal(start_value, database_type, column_info);
    let end = format_grid_sql_literal(end_value, database_type, column_info);
    if database_type == Some(DatabaseType::Neo4j) {
        return if negated {
            Some(format!("({column} < {start} OR {column} > {end})"))
        } else {
            Some(format!("({column} >= {start} AND {column} <= {end})"))
        };
    }
    let operator = if negated { "NOT BETWEEN" } else { "BETWEEN" };
    Some(format!("{column} {operator} {start} AND {end}"))
}

pub fn build_data_grid_column_value_filter_condition(
    options: DataGridColumnValueFilterConditionOptions,
) -> Option<String> {
    let text = options.raw_value.trim();
    if text.is_empty() {
        return None;
    }
    let column = column_filter_ref(options.database_type, &options.column_name, options.identifier_quote.as_deref());
    if text.eq_ignore_ascii_case("null") {
        return Some(format!("{column} IS NULL"));
    }
    let value = parse_typed_filter_value(text, options.database_type, options.column_info.as_ref());
    Some(format!("{column} = {}", format_grid_sql_literal(&value, options.database_type, options.column_info.as_ref())))
}

pub fn build_data_grid_column_values_filter_condition(
    options: DataGridColumnValuesFilterConditionOptions,
) -> Option<String> {
    if options.values.is_empty() {
        return None;
    }

    let column = column_filter_ref(options.database_type, &options.column_name, options.identifier_quote.as_deref());
    let mut has_null = false;
    let mut literals = Vec::new();
    let mut seen_literals = HashSet::new();
    for value in &options.values {
        if value.is_null() {
            has_null = true;
            continue;
        }
        let literal = format_grid_sql_literal(value, options.database_type, options.column_info.as_ref());
        if seen_literals.insert(literal.clone()) {
            literals.push(literal);
        }
    }

    let mut predicates = Vec::new();
    if has_null {
        predicates.push(format!("{column} IS NULL"));
    }
    if literals.len() == 1 {
        predicates.push(format!("{column} = {}", literals[0]));
    } else if let Some(membership) = build_membership_predicate(&column, &literals, options.database_type, false) {
        predicates.push(membership);
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
    let table = data_grid_qualified_table_name(
        options.database_type,
        options.catalog.as_deref(),
        options.schema.as_deref(),
        options.database.as_deref(),
        &options.table_name,
        options.identifier_quote.as_deref(),
    );
    let column = column_filter_ref(options.database_type, &options.column_name, options.identifier_quote.as_deref());
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
        TablePaginationStrategy::FirebirdRows => {
            let rows = firebird_rows_clause(limit, 0);
            format!("SELECT {select_list}{from_clause} {rows}")
        }
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
    let table = if options.database_type == Some(DatabaseType::Kingbase) {
        crate::sql_dialect::table_data_qualified_table_name(
            options.database_type,
            options.schema.as_deref(),
            &options.table_name,
            options.identifier_quote.as_deref(),
        )
    } else {
        crate::sql_dialect::qualified_table_name_with_catalog(
            options.database_type,
            options.catalog.as_deref(),
            options.schema.as_deref(),
            options.database.as_deref(),
            &options.table_name,
        )
    };
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
        let column =
            column_filter_ref(options.database_type, &options.column_name, options.identifier_quote.as_deref());
        let value = parse_typed_filter_value(search, options.database_type, options.column_info.as_ref());
        return Some(format!(
            "{column} = {}",
            format_grid_sql_literal(&value, options.database_type, options.column_info.as_ref())
        ));
    }
    let column = column_like_filter_ref(
        options.database_type,
        &options.column_name,
        options.column_info.as_ref(),
        options.identifier_quote.as_deref(),
    );
    let pattern = Value::String(format!("%{search}%"));
    Some(format!("{column} LIKE {}", format_grid_sql_literal(&pattern, options.database_type, None)))
}

fn build_neo4j_data_grid_column_distinct_values_sql(options: &DataGridColumnDistinctValuesSqlOptions) -> String {
    let limit = data_grid_column_distinct_values_limit(options.limit);
    let label = quote_ident(Some(DatabaseType::Neo4j), &options.table_name);
    let column = column_filter_ref(Some(DatabaseType::Neo4j), &options.column_name, None);
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
    if let Some(error) = validate_tdengine_inserted_rows(options) {
        return Some(error);
    }
    if let Some(error) = validate_inserted_primary_keys(options) {
        return Some(error);
    }
    if let Some(error) = validate_tdengine_existing_rows(options) {
        return Some(error);
    }
    if let Some(error) = validate_existing_row_primary_keys(options) {
        return Some(error);
    }
    if let Some(error) = validate_oracle_keyless_lob_predicate(options) {
        return Some(error);
    }

    let save_columns = effective_columns(options);
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
            let source_column = save_columns.get(*column_index).and_then(|column| column.as_deref());
            if is_null_write_to_not_null_column(options.database_type, &not_null_columns, source_column, value) {
                return Some(null_write_error(source_column.unwrap_or_default()));
            }
        }
    }

    // MySQL BEFORE INSERT triggers can populate omitted NOT NULL columns. New-row NULL values are
    // omitted from the generated INSERT, so let MySQL apply triggers or report missing required fields.
    if options.database_type != Some(DatabaseType::Mysql) {
        for row in &options.new_rows {
            for column_index in 0..options.columns.len() {
                let source_column = save_columns.get(column_index).and_then(|column| column.as_deref());
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
    }

    None
}

fn validate_existing_row_primary_keys(options: &DataGridSaveStatementOptions) -> Option<String> {
    let primary_keys = &options.table_meta.primary_keys;
    if primary_keys.is_empty() || (options.dirty_rows.is_empty() && options.deleted_rows.is_empty()) {
        return None;
    }

    let save_columns = effective_columns(options);
    let primary_key_indexes: Vec<Option<usize>> = primary_keys
        .iter()
        .map(|primary_key| find_column_index(options.database_type, &save_columns, primary_key))
        .collect();
    let missing_primary_keys = primary_keys
        .iter()
        .zip(&primary_key_indexes)
        .filter_map(|(primary_key, index)| index.is_none().then_some(primary_key.as_str()))
        .collect::<Vec<_>>();
    if !missing_primary_keys.is_empty() {
        return Some(format!(
            "Cannot safely update or delete rows because the query result does not include every primary key column (missing: {}). Refresh or rerun the query before saving.",
            missing_primary_keys.join(", ")
        ));
    }

    let primary_key_indexes = primary_key_indexes.into_iter().flatten().collect::<Vec<_>>();
    for row_index in
        options.dirty_rows.iter().map(|(row_index, _)| *row_index).chain(options.deleted_rows.iter().copied())
    {
        let Some(row) = options.rows.get(row_index) else {
            continue;
        };
        if let Some((primary_key, _)) =
            primary_keys.iter().zip(&primary_key_indexes).find(|(_, index)| row.get(**index).is_none_or(Value::is_null))
        {
            return Some(format!(
                "Cannot safely update or delete rows because primary key column \"{primary_key}\" has no value in the query result. Refresh or rerun the query before saving."
            ));
        }
    }

    None
}

fn validate_oracle_keyless_lob_predicate(options: &DataGridSaveStatementOptions) -> Option<String> {
    if !uses_oracle_row_id(options.database_type)
        || !options.table_meta.primary_keys.is_empty()
        || (options.dirty_rows.is_empty() && options.deleted_rows.is_empty())
    {
        return None;
    }
    let has_lob_column =
        options.table_meta.columns.as_deref().unwrap_or(&[]).iter().any(|column| is_oracle_lob_type(&column.data_type));
    if !has_lob_column {
        return None;
    }

    // LOB equality is unsupported in Oracle-compatible SQL. Refuse unsafe
    // keyless writes instead of dropping LOB predicates and risking extra rows.
    Some("Cannot safely update or delete this Oracle-compatible row because the table has LOB columns but no primary key or ROWID identifier.".to_string())
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
    let primary_key_indexes: Vec<Option<usize>> = primary_keys
        .iter()
        .map(|primary_key| find_column_index(options.database_type, &save_columns, primary_key))
        .collect();
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
    let table = data_grid_qualified_table_name(
        options.database_type,
        options.table_meta.catalog.as_deref(),
        options.table_meta.schema.as_deref(),
        options.table_meta.database.as_deref(),
        &options.table_meta.table_name,
        options.identifier_quote.as_deref(),
    );
    let mut statements = Vec::new();
    let primary_key_set: Vec<String> =
        options.table_meta.primary_keys.iter().map(|primary_key| normalize_column_name(primary_key)).collect();

    let batch_mysql_writes = supports_mysql_data_grid_batch(options);
    let mut update_sets: Option<String> = None;
    let mut update_predicates = Vec::new();
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
                    data_grid_identifier(options.database_type, column, options.identifier_quote.as_deref()),
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
            options.identifier_quote.as_deref(),
        );
        if batch_mysql_writes {
            if update_sets.as_deref().is_some_and(|current| current != sets) {
                let current_sets = update_sets.take().unwrap_or_default();
                push_mysql_predicate_batches(
                    &mut statements,
                    &format!("UPDATE {table} SET {current_sets} WHERE "),
                    std::mem::take(&mut update_predicates),
                );
            }
            update_sets = Some(sets);
            update_predicates.push(where_clause);
        } else {
            statements.push(data_grid_statement(
                options.database_type,
                data_grid_update_sql(options.database_type, &table, &sets, &where_clause),
            ));
        }
    }
    if let Some(sets) = update_sets {
        push_mysql_predicate_batches(&mut statements, &format!("UPDATE {table} SET {sets} WHERE "), update_predicates);
    }

    let mut delete_predicates = Vec::new();
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
            options.identifier_quote.as_deref(),
        );
        if batch_mysql_writes {
            delete_predicates.push(where_clause);
        } else {
            statements.push(data_grid_statement(
                options.database_type,
                data_grid_delete_sql(options.database_type, &table, &where_clause),
            ));
        }
    }
    if !delete_predicates.is_empty() {
        push_mysql_predicate_batches(&mut statements, &format!("DELETE FROM {table} WHERE "), delete_predicates);
    }

    for row in &options.new_rows {
        if options.database_type == Some(DatabaseType::Hive) {
            if let Some(statement) = build_hive_values_insert(options, &table, &save_columns, row, true, true) {
                statements.push(data_grid_statement(options.database_type, statement));
            }
            continue;
        }
        let insert_pairs: Vec<(&str, &Value)> = save_columns
            .iter()
            .enumerate()
            .filter_map(|(index, column)| Some((column.as_deref()?, row.get(index).unwrap_or(&Value::Null))))
            .filter(|(column, value)| {
                let column_info = column_info_for(column_info, column);
                // Empty generated values must be omitted so the database can apply AUTO_INCREMENT/IDENTITY semantics.
                !column_info.is_some_and(is_auto_generated_column) || !grid_value_is_empty(value)
            })
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
            if options.database_type == Some(DatabaseType::Mysql) {
                statements
                    .push(data_grid_statement(options.database_type, format!("INSERT INTO {table} () VALUES ()")));
            }
            continue;
        }
        let columns = insert_pairs
            .iter()
            .map(|(column, _)| data_grid_identifier(options.database_type, column, options.identifier_quote.as_deref()))
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
    if options.database_type == Some(DatabaseType::Tdengine) {
        return build_tdengine_data_grid_rollback_statements(options);
    }
    if options.database_type == Some(DatabaseType::ClickHouse) {
        return Vec::new();
    }

    let save_columns = effective_columns(options);
    let column_info = options.table_meta.columns.as_deref().unwrap_or(&[]);
    let table = data_grid_qualified_table_name(
        options.database_type,
        options.table_meta.catalog.as_deref(),
        options.table_meta.schema.as_deref(),
        options.table_meta.database.as_deref(),
        &options.table_meta.table_name,
        options.identifier_quote.as_deref(),
    );
    let mut statements = Vec::new();

    for row in &options.new_rows {
        let where_clause = if options.database_type == Some(DatabaseType::Mysql) {
            build_mysql_insert_rollback_where(options, &save_columns, row, column_info)
        } else {
            let where_clause = build_save_row_where(
                options.database_type,
                &save_columns,
                row,
                column_info,
                options.identifier_quote.as_deref(),
            );
            (!where_clause.is_empty()).then_some(where_clause)
        };
        if let Some(where_clause) = where_clause {
            statements
                .push(data_grid_statement(options.database_type, format!("DELETE FROM {table} WHERE {where_clause}")));
        }
    }

    let batch_mysql_writes = supports_mysql_data_grid_batch(options);
    let mut deleted_insert_columns: Option<String> = None;
    let mut deleted_insert_values = Vec::new();
    for row_index in &options.deleted_rows {
        let Some(row) = options.rows.get(*row_index) else {
            continue;
        };
        if options.database_type == Some(DatabaseType::Hive) {
            if let Some(statement) = build_hive_values_insert(options, &table, &save_columns, row, false, false) {
                statements.push(data_grid_statement(options.database_type, statement));
            }
            continue;
        }
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
            .map(|(column, _)| data_grid_identifier(options.database_type, column, options.identifier_quote.as_deref()))
            .collect::<Vec<_>>()
            .join(", ");
        let values = insert_pairs
            .iter()
            .map(|(column, value)| {
                format_grid_sql_literal(value, options.database_type, column_info_for(column_info, column))
            })
            .collect::<Vec<_>>()
            .join(", ");
        if batch_mysql_writes {
            if deleted_insert_columns.as_deref().is_some_and(|current| current != columns) {
                let current_columns = deleted_insert_columns.take().unwrap_or_default();
                push_mysql_values_insert_batches(
                    &mut statements,
                    &table,
                    &current_columns,
                    std::mem::take(&mut deleted_insert_values),
                );
            }
            deleted_insert_columns = Some(columns);
            deleted_insert_values.push(format!("({values})"));
        } else {
            statements.push(data_grid_statement(
                options.database_type,
                format!("INSERT INTO {table} ({columns}) VALUES ({values})"),
            ));
        }
    }
    if let Some(columns) = deleted_insert_columns {
        push_mysql_values_insert_batches(&mut statements, &table, &columns, deleted_insert_values);
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
                    data_grid_identifier(options.database_type, column, options.identifier_quote.as_deref()),
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
            options.identifier_quote.as_deref(),
        )];
        predicates.extend(writable_changes.iter().map(|((_, value), column)| {
            build_save_column_predicate(
                options.database_type,
                column,
                value,
                column_info_for(column_info, column),
                true,
                options.identifier_quote.as_deref(),
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

fn supports_mysql_data_grid_batch(options: &DataGridSaveStatementOptions) -> bool {
    // Keyless rows use full-row predicates, which are too wide and ambiguous to combine safely.
    options.database_type == Some(DatabaseType::Mysql) && !options.table_meta.primary_keys.is_empty()
}

fn push_mysql_predicate_batches(statements: &mut Vec<String>, prefix: &str, predicates: Vec<String>) {
    push_mysql_joined_batches(statements, prefix, predicates, " OR ", true);
}

fn push_mysql_values_insert_batches(
    statements: &mut Vec<String>,
    table: &str,
    columns: &str,
    value_tuples: Vec<String>,
) {
    push_mysql_joined_batches(
        statements,
        &format!("INSERT INTO {table} ({columns}) VALUES "),
        value_tuples,
        ", ",
        false,
    );
}

fn push_mysql_joined_batches(
    statements: &mut Vec<String>,
    prefix: &str,
    parts: Vec<String>,
    separator: &str,
    wrap_multiple_parts: bool,
) {
    let mut batch = Vec::new();
    for part in parts {
        let next_len = joined_batch_sql_len(prefix, &batch, &part, separator, wrap_multiple_parts);
        if !batch.is_empty()
            && (batch.len() >= MYSQL_DATA_GRID_BATCH_MAX_ROWS || next_len > MYSQL_DATA_GRID_BATCH_TARGET_SQL_BYTES)
        {
            push_mysql_joined_batch_statement(
                statements,
                prefix,
                std::mem::take(&mut batch),
                separator,
                wrap_multiple_parts,
            );
        }
        batch.push(part);
    }
    if !batch.is_empty() {
        push_mysql_joined_batch_statement(statements, prefix, batch, separator, wrap_multiple_parts);
    }
}

fn joined_batch_sql_len(
    prefix: &str,
    current: &[String],
    next: &str,
    separator: &str,
    wrap_multiple_parts: bool,
) -> usize {
    let part_bytes = |part: &str| part.len() + usize::from(wrap_multiple_parts) * 2;
    if current.is_empty() {
        return prefix.len() + next.len() + 1;
    }
    let current_bytes = if current.len() == 1 && wrap_multiple_parts {
        current[0].len()
    } else {
        current.iter().map(|part| part_bytes(part)).sum::<usize>() + separator.len() * current.len().saturating_sub(1)
    };
    let existing_adjustment = if current.len() == 1 && wrap_multiple_parts { 2 } else { 0 };
    prefix.len() + current_bytes + existing_adjustment + separator.len() + part_bytes(next) + 1
}

fn push_mysql_joined_batch_statement(
    statements: &mut Vec<String>,
    prefix: &str,
    parts: Vec<String>,
    separator: &str,
    wrap_multiple_parts: bool,
) {
    let body = if parts.len() == 1 || !wrap_multiple_parts {
        parts.join(separator)
    } else {
        parts.into_iter().map(|part| format!("({part})")).collect::<Vec<_>>().join(separator)
    };
    statements.push(format!("{prefix}{body};"));
}

fn build_mysql_insert_rollback_where(
    options: &DataGridSaveStatementOptions,
    columns: &[Option<String>],
    row: &[Value],
    column_info: &[DataGridColumnInfo],
) -> Option<String> {
    if options.table_meta.primary_keys.is_empty() {
        return None;
    }

    for primary_key in &options.table_meta.primary_keys {
        let index = columns.iter().position(|column| column.as_deref() == Some(primary_key.as_str()))?;
        let value = row.get(index).unwrap_or(&Value::Null);
        let info = column_info_for(column_info, primary_key);
        if value.is_null()
            || empty_string_saves_as_null(value, info)
            || info.is_some_and(is_auto_generated_column)
            || info.is_some_and(|column| is_non_identity_generated_column(Some(column)))
        {
            // Generated or trigger-populated keys are unknown until after INSERT.
            // Do not emit a rollback predicate that cannot match the inserted row.
            return None;
        }
    }

    Some(build_primary_key_where(
        options.database_type,
        &options.table_meta.primary_keys,
        columns,
        row,
        column_info,
        options.identifier_quote.as_deref(),
    ))
}

pub(crate) fn effective_columns(options: &DataGridSaveStatementOptions) -> Vec<Option<String>> {
    let columns = match &options.source_columns {
        Some(source_columns) if source_columns.len() == options.columns.len() => source_columns.clone(),
        _ => options.columns.iter().map(|column| Some(column.clone())).collect(),
    };
    if options.database_type != Some(DatabaseType::Hive) {
        return columns;
    }
    columns
        .into_iter()
        .map(|column| column.map(|column| resolve_hive_target_column(&options.table_meta, &column)))
        .collect()
}

fn resolve_hive_target_column(table_meta: &DataGridTableMeta, result_column: &str) -> String {
    let Some(columns) = table_meta.columns.as_deref() else {
        return result_column.to_string();
    };
    if let Some(column) = unique_column_info_match(columns, result_column) {
        return column.name.clone();
    }
    let Some(unqualified) = last_qualified_identifier_component(result_column) else {
        return result_column.to_string();
    };
    // Hive JDBC may expose SELECT * labels as `table.column`. Resolve them through
    // target metadata, while exact matching above preserves real dotted column names.
    unique_column_info_match(columns, &unqualified)
        .map_or_else(|| result_column.to_string(), |column| column.name.clone())
}

fn unique_column_info_match<'a>(columns: &'a [DataGridColumnInfo], name: &str) -> Option<&'a DataGridColumnInfo> {
    if let Some(column) = columns.iter().find(|column| column.name == name) {
        return Some(column);
    }
    let normalized = normalize_column_name(name);
    let mut matches = columns.iter().filter(|column| normalize_column_name(&column.name) == normalized);
    let first = matches.next()?;
    matches.next().is_none().then_some(first)
}

fn last_qualified_identifier_component(name: &str) -> Option<String> {
    let mut quote = None;
    let mut component_start = 0;
    let mut last_component = None;
    let chars = name.char_indices().collect::<Vec<_>>();
    let mut index = 0;
    while index < chars.len() {
        let (byte_index, ch) = chars[index];
        if let Some(end_quote) = quote {
            if ch == end_quote {
                if chars.get(index + 1).is_some_and(|(_, next)| *next == end_quote) {
                    index += 2;
                    continue;
                }
                quote = None;
            }
        } else {
            match ch {
                '`' | '"' => quote = Some(ch),
                '[' => quote = Some(']'),
                '.' => {
                    let component = name[component_start..byte_index].trim();
                    if component.is_empty() {
                        return None;
                    }
                    last_component = Some(component);
                    component_start = byte_index + ch.len_utf8();
                }
                _ => {}
            }
        }
        index += 1;
    }
    if quote.is_some() || last_component.is_none() {
        return None;
    }
    unquote_identifier_component(name[component_start..].trim())
}

fn unquote_identifier_component(component: &str) -> Option<String> {
    if component.is_empty() {
        return None;
    }
    for (open, close) in [('`', '`'), ('"', '"'), ('[', ']')] {
        if component.starts_with(open) || component.ends_with(close) {
            let inner = component.strip_prefix(open)?.strip_suffix(close)?;
            let escaped = format!("{close}{close}");
            return Some(inner.replace(&escaped, &close.to_string()));
        }
    }
    Some(component.to_string())
}

fn build_hive_values_insert(
    options: &DataGridSaveStatementOptions,
    table: &str,
    save_columns: &[Option<String>],
    row: &[Value],
    save_literals: bool,
    skip_all_null: bool,
) -> Option<String> {
    let metadata_columns = options.table_meta.columns.as_deref().unwrap_or(&[]);
    let target_columns = if metadata_columns.is_empty() {
        save_columns.iter().filter_map(|column| column.as_deref()).collect::<Vec<_>>()
    } else {
        metadata_columns.iter().map(|column| column.name.as_str()).collect::<Vec<_>>()
    };
    if target_columns.is_empty() {
        return None;
    }
    let values = target_columns
        .iter()
        .map(|column| {
            let value = find_column_index(Some(DatabaseType::Hive), save_columns, column)
                .and_then(|index| row.get(index))
                .unwrap_or(&Value::Null);
            (column, value)
        })
        .collect::<Vec<_>>();
    if skip_all_null && values.iter().all(|(_, value)| value.is_null()) {
        return None;
    }
    let values = values
        .into_iter()
        .map(|(column, value)| {
            let info = column_info_for(metadata_columns, column);
            if save_literals {
                format_grid_save_sql_literal(value, options.database_type, info)
            } else {
                format_grid_sql_literal(value, options.database_type, info)
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!("INSERT INTO TABLE {table} VALUES ({values})"))
}

fn effective_copy_columns(source_columns: Option<&[Option<String>]>, columns: &[String]) -> Vec<Option<String>> {
    match source_columns {
        Some(source_columns) if source_columns.len() == columns.len() => source_columns.to_vec(),
        _ => columns.iter().map(|column| Some(column.clone())).collect(),
    }
}

fn copy_column_info(
    column_info: &[DataGridColumnInfo],
    column: &str,
    fallback_type: Option<&str>,
) -> Option<DataGridColumnInfo> {
    if let Some(info) = column_info_for(column_info, column) {
        return Some(info.clone());
    }
    fallback_type.map(|data_type| DataGridColumnInfo {
        name: column.to_string(),
        data_type: data_type.to_string(),
        is_nullable: true,
        is_primary_key: false,
        column_default: None,
        extra: None,
    })
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

fn format_grid_copy_insert_sql_literal(
    value: &Value,
    database_type: Option<DatabaseType>,
    column_info: Option<&DataGridColumnInfo>,
) -> String {
    if is_oracle_temporal_literal_database(database_type) {
        if let Some(text) = value.as_str() {
            if let Some(literal) =
                format_oracle_temporal_literal(text, column_info.map(|column| column.data_type.as_str()))
            {
                return literal;
            }
        }
    }
    format_grid_sql_literal(value, database_type, column_info)
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
        if is_bit_literal_column(database_type, column_info) {
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
    if is_mysql_binary_literal_column(database_type, column_info) {
        if let Some(literal) = format_mysql_binary_literal_text(&text) {
            // DBX result values expose binary columns as prefixed hex; keep them
            // as MySQL hex literals so copied INSERT/UPDATE SQL round-trips bytes.
            return literal;
        }
    }
    if column_info.map(|column| is_numeric_type(&column.data_type)).unwrap_or(false) && is_numeric_literal(&text) {
        // BigDecimal/BigInteger cells cross JSON-RPC as strings so browsers cannot round them.
        return text;
    }
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
    if database_type == Some(DatabaseType::Postgres) && literal_text.contains('\\') {
        // Escape strings have stable backslash semantics regardless of the
        // session's standard_conforming_strings setting.
        let escaped_text = literal_text.replace('\\', "\\\\").replace('\'', "''");
        return format!("E'{escaped_text}'");
    }
    if database_type == Some(DatabaseType::SqlServer) {
        return format_sqlserver_unicode_literal(&literal_text);
    }
    let escaped_text = if database_type == Some(DatabaseType::Neo4j) {
        literal_text.replace('\\', "\\\\").replace('\'', "\\'")
    } else if is_sqlite_literal_database(database_type) {
        // SQLite-family engines do not treat backslash as a string-literal
        // escape character, so only the quote delimiter needs escaping.
        literal_text.replace('\'', "''")
    } else {
        literal_text.replace('\\', "\\\\").replace('\'', "''")
    };
    let escaped = format!("'{escaped_text}'");
    escaped
}

fn format_sqlserver_unicode_literal(text: &str) -> String {
    let mut parts = Vec::new();
    let mut segment = String::new();

    for ch in text.chars() {
        let line_break = match ch {
            '\r' => Some(13),
            '\n' => Some(10),
            _ => None,
        };
        if let Some(codepoint) = line_break {
            if !segment.is_empty() {
                parts.push(format!("N'{}'", segment.replace('\'', "''")));
                segment.clear();
            }
            // Keep physical newlines out of generated SQL so a preceding
            // backslash cannot be consumed as a line-continuation marker.
            parts.push(format!("NCHAR({codepoint})"));
        } else {
            segment.push(ch);
        }
    }

    if !segment.is_empty() {
        parts.push(format!("N'{}'", segment.replace('\'', "''")));
    }
    if parts.is_empty() {
        "N''".to_string()
    } else {
        parts.join(" + ")
    }
}

fn is_sqlite_literal_database(database_type: Option<DatabaseType>) -> bool {
    matches!(
        database_type,
        Some(DatabaseType::Sqlite | DatabaseType::Rqlite | DatabaseType::Turso | DatabaseType::CloudflareD1)
    )
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
    let parts = regex_like_oracle_temporal(text)?;
    let fraction = parts.fraction.as_deref().unwrap_or_default();
    let datetime = format!("{} {}{}", parts.date, parts.time, fraction);
    match kind {
        OracleTemporalKind::Date if oracle_temporal_parts_are_midnight(&parts) => {
            Some(format!("DATE '{}'", parts.date))
        }
        OracleTemporalKind::Date => Some(format!("TO_DATE('{} {}', 'YYYY-MM-DD HH24:MI:SS')", parts.date, parts.time)),
        OracleTemporalKind::Timestamp => {
            let mask = oracle_timestamp_format_mask(datetime.contains('.'));
            Some(format!("TO_TIMESTAMP('{datetime}', '{mask}')"))
        }
        OracleTemporalKind::TimestampWithTimeZone => {
            if parts.zone.is_empty() {
                let mask = oracle_timestamp_format_mask(datetime.contains('.'));
                return Some(format!("TO_TIMESTAMP('{datetime}', '{mask}')"));
            }
            let zone = oracle_timezone_suffix(&parts.zone);
            let mask = oracle_timestamp_format_mask(datetime.contains('.'));
            Some(format!("TO_TIMESTAMP_TZ('{datetime} {zone}', '{mask} TZH:TZM')"))
        }
    }
}

fn oracle_temporal_parts_are_midnight(parts: &Rfc3339Parts) -> bool {
    parts.time == "00:00:00"
        && parts
            .fraction
            .as_deref()
            .map(|fraction| fraction.trim_start_matches('.').chars().all(|ch| ch == '0'))
            .unwrap_or(true)
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

fn regex_like_oracle_temporal(text: &str) -> Option<Rfc3339Parts> {
    if let Some(parts) = regex_like_rfc3339(text) {
        return Some(parts);
    }
    regex_like_local_datetime(text)
}

fn regex_like_local_datetime(text: &str) -> Option<Rfc3339Parts> {
    let bytes = text.as_bytes();
    if bytes.len() < 10 || bytes.get(4) != Some(&b'-') || bytes.get(7) != Some(&b'-') {
        return None;
    }
    let date = &text[0..10];
    if bytes.len() == 10 {
        return Some(Rfc3339Parts {
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
    Some(Rfc3339Parts { date: date.to_string(), time: time.to_string(), fraction, zone: String::new() })
}

fn is_mysql_bit_literal_column(database_type: Option<DatabaseType>, column_info: Option<&DataGridColumnInfo>) -> bool {
    is_mysql_datetime_literal_database(database_type)
        && column_info.map(|column| is_bit_column_type(&column.data_type)).unwrap_or(false)
}

fn is_bit_literal_column(database_type: Option<DatabaseType>, column_info: Option<&DataGridColumnInfo>) -> bool {
    database_type != Some(DatabaseType::Postgres)
        && column_info.map(|column| is_bit_column_type(&column.data_type)).unwrap_or(false)
}

fn is_bit_column_type(data_type: &str) -> bool {
    let lower = data_type.to_ascii_lowercase();
    lower.split(|ch: char| !ch.is_ascii_alphanumeric()).any(|token| {
        // SQL Server/tiberius reports nullable BIT result columns as `bitn`.
        // They still need numeric 0/1 literals in generated UPDATE SQL.
        matches!(token, "bit" | "bitn")
    })
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

fn is_mysql_binary_literal_column(
    database_type: Option<DatabaseType>,
    column_info: Option<&DataGridColumnInfo>,
) -> bool {
    database_type == Some(DatabaseType::Mysql)
        && column_info.map(|column| is_mysql_binary_column_type(&column.data_type)).unwrap_or(false)
}

fn is_mysql_binary_column_type(data_type: &str) -> bool {
    let lower = data_type.trim().to_ascii_lowercase();
    let base = lower.split(['(', ':', ' ']).next().unwrap_or("").trim();
    matches!(base, "binary" | "varbinary" | "blob" | "tinyblob" | "mediumblob" | "longblob")
}

fn format_mysql_binary_literal_text(text: &str) -> Option<String> {
    let trimmed = text.trim();
    let hex = trimmed.strip_prefix("0x")?;
    if hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        Some(if hex.is_empty() { "X''".to_string() } else { trimmed.to_string() })
    } else {
        None
    }
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
    if is_boolean_type(&data_type, None) && text.eq_ignore_ascii_case("true") {
        return Some(Value::Bool(true));
    }
    if is_boolean_type(&data_type, None) && text.eq_ignore_ascii_case("false") {
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
    identifier_quote: Option<&str>,
) -> String {
    if primary_keys.is_empty() && uses_keyless_row_predicate(database_type) {
        return build_row_where(database_type, columns, row, column_info, identifier_quote);
    }
    primary_keys
        .iter()
        .map(|primary_key| {
            let value = row
                .get(find_column_index(database_type, columns, primary_key).unwrap_or(usize::MAX))
                .unwrap_or(&Value::Null);
            build_column_predicate(
                database_type,
                primary_key,
                value,
                column_info_for(column_info, primary_key),
                false,
                identifier_quote,
            )
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn build_row_where(
    database_type: Option<DatabaseType>,
    columns: &[Option<String>],
    row: &[Value],
    column_info: &[DataGridColumnInfo],
    identifier_quote: Option<&str>,
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
                identifier_quote,
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
    identifier_quote: Option<&str>,
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
                identifier_quote,
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
    identifier_quote: Option<&str>,
) -> String {
    let ident = predicate_ident(database_type, column, identifier_quote);
    if value.is_null() {
        format!("{ident} IS NULL")
    } else if use_binary_text_comparison && uses_mysql_binary_text_predicate(database_type, value, column_info) {
        format!("BINARY {ident} = {}", format_grid_sql_literal(value, database_type, column_info))
    } else {
        let literal = format_grid_sql_literal(value, database_type, column_info);
        format!("{ident} = {}", mysql_json_predicate_literal(literal, database_type, column_info))
    }
}

fn build_save_column_predicate(
    database_type: Option<DatabaseType>,
    column: &str,
    value: &Value,
    column_info: Option<&DataGridColumnInfo>,
    use_binary_text_comparison: bool,
    identifier_quote: Option<&str>,
) -> String {
    let ident = predicate_ident(database_type, column, identifier_quote);
    if value.is_null() || empty_string_saves_as_null(value, column_info) {
        format!("{ident} IS NULL")
    } else if use_binary_text_comparison && uses_mysql_binary_text_predicate(database_type, value, column_info) {
        format!("BINARY {ident} = {}", format_grid_save_sql_literal(value, database_type, column_info))
    } else {
        let literal = format_grid_save_sql_literal(value, database_type, column_info);
        format!("{ident} = {}", mysql_json_predicate_literal(literal, database_type, column_info))
    }
}

fn mysql_json_predicate_literal(
    literal: String,
    database_type: Option<DatabaseType>,
    column_info: Option<&DataGridColumnInfo>,
) -> String {
    if database_type == Some(DatabaseType::Mysql)
        && column_info.is_some_and(|column| column.data_type.trim().eq_ignore_ascii_case("json"))
    {
        format!("CAST({literal} AS JSON)")
    } else {
        literal
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

fn is_oracle_lob_type(data_type: &str) -> bool {
    let lower = data_type.trim().trim_matches('"').to_ascii_lowercase();
    let base = lower.split(['(', ':', ' ']).next().unwrap_or("");
    matches!(base, "blob" | "clob" | "nclob" | "bfile" | "lob")
        || lower.starts_with("binary large object")
        || lower.starts_with("character large object")
}

fn is_oracle_row_id(database_type: Option<DatabaseType>, name: Option<&str>) -> bool {
    uses_oracle_row_id(database_type) && name.is_some_and(|name| name.eq_ignore_ascii_case(DBX_ROWID_COLUMN))
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

fn grid_value_is_empty(value: &Value) -> bool {
    value.is_null() || value.as_str().is_some_and(str::is_empty)
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

fn find_column_index(database_type: Option<DatabaseType>, columns: &[Option<String>], target: &str) -> Option<usize> {
    if let Some(index) = columns.iter().position(|column| column.as_deref() == Some(target)) {
        return Some(index);
    }
    // PostgreSQL can have distinct `id` and quoted `"ID"` columns. Only
    // dialects whose result metadata is known to drift in case may fall back,
    // and even then a case-only match must be unique.
    if !matches!(
        database_type,
        Some(DatabaseType::Goldendb | DatabaseType::Kingbase | DatabaseType::Tdengine | DatabaseType::Hive)
    ) {
        return None;
    }
    let normalized_target = normalize_column_name(target);
    let mut matches = columns.iter().enumerate().filter_map(|(index, column)| {
        (column.as_deref().map(normalize_column_name).unwrap_or_default() == normalized_target).then_some(index)
    });
    let first = matches.next()?;
    matches.next().is_none().then_some(first)
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

fn predicate_ident(database_type: Option<DatabaseType>, name: &str, identifier_quote: Option<&str>) -> String {
    if is_oracle_row_id(database_type, Some(name)) {
        "ROWIDTOCHAR(ROWID)".to_string()
    } else {
        data_grid_identifier(database_type, name, identifier_quote)
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

fn data_grid_identifier(database_type: Option<DatabaseType>, name: &str, identifier_quote: Option<&str>) -> String {
    crate::sql_dialect::quote_table_data_identifier(database_type, name, identifier_quote)
}

fn data_grid_qualified_table_name(
    database_type: Option<DatabaseType>,
    catalog: Option<&str>,
    schema: Option<&str>,
    database: Option<&str>,
    table_name: &str,
    identifier_quote: Option<&str>,
) -> String {
    if database_type == Some(DatabaseType::Kingbase) {
        crate::sql_dialect::table_data_qualified_table_name(database_type, schema, table_name, identifier_quote)
    } else {
        crate::sql_dialect::qualified_table_name_with_catalog(database_type, catalog, schema, database, table_name)
    }
}

fn column_filter_ref(database_type: Option<DatabaseType>, column_name: &str, identifier_quote: Option<&str>) -> String {
    let quoted = data_grid_identifier(database_type, column_name, identifier_quote);
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
    identifier_quote: Option<&str>,
) -> String {
    let column = column_filter_ref(database_type, column_name, identifier_quote);
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

fn parse_typed_filter_value(
    text: &str,
    database_type: Option<DatabaseType>,
    column_info: Option<&DataGridColumnInfo>,
) -> Value {
    let unquoted = unwrap_matching_quotes(text);
    let data_type = column_info.map(|column| column.data_type.to_ascii_lowercase()).unwrap_or_default();
    if is_boolean_type(&data_type, database_type) && unquoted.eq_ignore_ascii_case("true") {
        return Value::Bool(true);
    }
    if is_boolean_type(&data_type, database_type) && unquoted.eq_ignore_ascii_case("false") {
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

fn is_boolean_type(data_type: &str, database_type: Option<DatabaseType>) -> bool {
    let lower = data_type.to_ascii_lowercase();
    lower.split(|ch: char| !ch.is_ascii_alphanumeric()).any(|token| {
        matches!(token, "bool" | "boolean")
            || (matches!(token, "bit" | "bitn") && database_type != Some(DatabaseType::Postgres))
    })
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
                | DatabaseType::CloudflareD1
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
                | DatabaseType::Oscar
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

    fn mysql_people_save_options(row_count: usize) -> DataGridSaveStatementOptions {
        DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Mysql),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("app".to_string()),
                table_name: "people".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: Some(vec![column("id", "bigint", false, None), column("status", "varchar(32)", true, None)]),
            },
            columns: vec!["id".to_string(), "status".to_string()],
            source_columns: None,
            rows: (1..=row_count).map(|id| vec![json!(id), json!("active")]).collect(),
            dirty_rows: vec![],
            deleted_rows: vec![],
            new_rows: vec![],
        }
    }

    #[test]
    fn builds_copy_update_statements() {
        let statements = build_data_grid_copy_update_statements(DataGridCopyUpdateStatementOptions {
            database_type: Some(DatabaseType::Postgres),
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
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
                catalog: None,
                database: None,
                schema: None,
                table_name: "users".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: None,
            }),
            columns: vec!["id".to_string(), "login_name".to_string(), "display_name".to_string()],
            column_types: None,
            source_columns: None,
            rows: vec![vec![json!(1), json!("ada"), json!("Ada")], vec![json!(2), json!("linus"), json!("Linus")]],
            exclude_primary_keys: true,
            insert_mode: DataGridCopyInsertMode::Merged,
        });
        assert_eq!(
            statement.as_deref(),
            Some("INSERT INTO `users` (`login_name`, `display_name`) VALUES\n('ada', 'Ada'),\n('linus', 'Linus');")
        );
    }

    #[test]
    fn builds_copy_insert_without_primary_keys_when_primary_keys_are_hidden() {
        let statement = build_data_grid_copy_insert_statement(DataGridCopyInsertStatementOptions {
            database_type: Some(DatabaseType::Mysql),
            table_meta: Some(DataGridTableMeta {
                catalog: None,
                database: None,
                schema: None,
                table_name: "users".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: None,
            }),
            columns: vec!["login_name".to_string(), "display_name".to_string()],
            column_types: None,
            source_columns: None,
            rows: vec![vec![json!("ada"), json!("Ada")]],
            exclude_primary_keys: true,
            insert_mode: DataGridCopyInsertMode::Merged,
        });

        assert_eq!(
            statement.as_deref(),
            Some("INSERT INTO `users` (`login_name`, `display_name`) VALUES ('ada', 'Ada');")
        );
    }

    #[test]
    fn builds_copy_insert_statement_row_by_row() {
        let statement = build_data_grid_copy_insert_statement(DataGridCopyInsertStatementOptions {
            database_type: Some(DatabaseType::Mysql),
            table_meta: Some(DataGridTableMeta {
                catalog: None,
                database: None,
                schema: None,
                table_name: "users".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: None,
            }),
            columns: vec!["id".to_string(), "login_name".to_string(), "display_name".to_string()],
            column_types: None,
            source_columns: None,
            rows: vec![vec![json!(1), json!("ada"), json!("Ada")], vec![json!(2), json!("linus"), json!("Linus")]],
            exclude_primary_keys: false,
            insert_mode: DataGridCopyInsertMode::RowByRow,
        });
        assert_eq!(
            statement.as_deref(),
            Some(
                "INSERT INTO `users` (`id`, `login_name`, `display_name`) VALUES (1, 'ada', 'Ada');\nINSERT INTO `users` (`id`, `login_name`, `display_name`) VALUES (2, 'linus', 'Linus');"
            )
        );
    }

    #[test]
    fn oracle_copy_insert_statement_uses_one_statement_per_row() {
        let statement = build_data_grid_copy_insert_statement(DataGridCopyInsertStatementOptions {
            database_type: Some(DatabaseType::Oracle),
            table_meta: Some(DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("APP".to_string()),
                table_name: "USERS".to_string(),
                primary_keys: vec!["ID".to_string()],
                columns: None,
            }),
            columns: vec!["ID".to_string(), "NAME".to_string()],
            column_types: None,
            source_columns: None,
            rows: vec![vec![json!(1), json!("Ada")], vec![json!(2), json!("Linus")]],
            exclude_primary_keys: false,
            insert_mode: DataGridCopyInsertMode::Merged,
        });

        assert_eq!(
            statement.as_deref(),
            Some("INSERT INTO \"APP\".\"USERS\" (\"ID\", \"NAME\") VALUES (1, 'Ada');\nINSERT INTO \"APP\".\"USERS\" (\"ID\", \"NAME\") VALUES (2, 'Linus');")
        );
    }

    #[test]
    fn mysql_copy_statements_preserve_blob_hex_literals() {
        let table_meta = DataGridTableMeta {
            catalog: None,
            database: None,
            schema: None,
            table_name: "reports".to_string(),
            primary_keys: vec!["id".to_string()],
            columns: Some(vec![column("id", "int", false, None), column("payload", "MEDIUMBLOB", true, None)]),
        };
        let columns = vec!["id".to_string(), "payload".to_string()];
        let rows = vec![vec![json!(1), json!("0x0001abff")], vec![json!(2), json!("0x")]];

        let insert = build_data_grid_copy_insert_statement(DataGridCopyInsertStatementOptions {
            database_type: Some(DatabaseType::Mysql),
            table_meta: Some(table_meta.clone()),
            columns: columns.clone(),
            column_types: None,
            source_columns: None,
            rows: rows.clone(),
            exclude_primary_keys: false,
            insert_mode: DataGridCopyInsertMode::Merged,
        });
        assert_eq!(
            insert.as_deref(),
            Some("INSERT INTO `reports` (`id`, `payload`) VALUES\n(1, 0x0001abff),\n(2, X'');")
        );

        let updates = build_data_grid_copy_update_statements(DataGridCopyUpdateStatementOptions {
            database_type: Some(DatabaseType::Mysql),
            table_meta,
            columns,
            source_columns: None,
            rows,
        });
        assert_eq!(
            updates,
            vec![
                "UPDATE `reports` SET `payload` = 0x0001abff WHERE `id` = 1;",
                "UPDATE `reports` SET `payload` = X'' WHERE `id` = 2;"
            ]
        );
    }

    #[test]
    fn mysql_text_columns_keep_prefixed_hex_strings_quoted() {
        assert_eq!(
            format_grid_sql_literal(
                &json!("0x0001abff"),
                Some(DatabaseType::Mysql),
                Some(&column("note", "varchar(64)", true, None)),
            ),
            "'0x0001abff'"
        );
        assert_eq!(
            format_grid_sql_literal(
                &json!("0xnothex"),
                Some(DatabaseType::Mysql),
                Some(&column("payload", "blob", true, None)),
            ),
            "'0xnothex'"
        );
    }

    #[test]
    fn builds_copy_insert_statement_omits_postgres_tsvector_columns() {
        let statement = build_data_grid_copy_insert_statement(DataGridCopyInsertStatementOptions {
            database_type: Some(DatabaseType::Postgres),
            table_meta: Some(DataGridTableMeta {
                catalog: None,
                database: None,
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
            column_types: None,
            source_columns: None,
            rows: vec![vec![json!(1), json!("Hello"), json!("'hello':1A")]],
            exclude_primary_keys: false,
            insert_mode: DataGridCopyInsertMode::Merged,
        });

        assert_eq!(
            statement.as_deref(),
            Some("INSERT INTO \"public\".\"articles\" (\"id\", \"title\") VALUES (1, 'Hello');")
        );
    }

    #[test]
    fn oracle_copy_insert_uses_result_column_types_for_date_literals() {
        let statement = build_data_grid_copy_insert_statement(DataGridCopyInsertStatementOptions {
            database_type: Some(DatabaseType::Oracle),
            table_meta: None,
            columns: vec!["ID".to_string(), "CREATED_ON".to_string(), "RAW_TEXT".to_string()],
            column_types: Some(vec![
                Some("NUMBER".to_string()),
                Some("DATE".to_string()),
                Some("VARCHAR2".to_string()),
            ]),
            source_columns: None,
            rows: vec![vec![json!(1), json!("2022-08-25T09:58:43Z"), json!("2022-08-25T09:58:43Z")]],
            exclude_primary_keys: false,
            insert_mode: DataGridCopyInsertMode::Merged,
        });

        assert_eq!(
            statement.as_deref(),
            Some("INSERT INTO table_name (\"ID\", \"CREATED_ON\", \"RAW_TEXT\") VALUES (1, TO_DATE('2022-08-25 09:58:43', 'YYYY-MM-DD HH24:MI:SS'), '2022-08-25T09:58:43Z');")
        );
    }

    #[test]
    fn builds_filter_conditions() {
        assert_eq!(
            build_data_grid_context_filter_condition(DataGridContextFilterConditionOptions {
                database_type: Some(DatabaseType::Kingbase),
                identifier_quote: Some("`".to_string()),
                column_name: "file_name".to_string(),
                mode: DataGridContextFilterMode::Equals,
                value: json!("34-B-0048"),
                values: Vec::new(),
                end_value: None,
                column_info: Some(column("file_name", "varchar", false, None)),
            })
            .as_deref(),
            Some("`file_name` = '34-B-0048'")
        );
        assert_eq!(
            build_data_grid_column_value_filter_condition(DataGridColumnValueFilterConditionOptions {
                database_type: Some(DatabaseType::Kingbase),
                identifier_quote: Some("`".to_string()),
                column_name: "file_name".to_string(),
                column_info: Some(column("file_name", "varchar", false, None)),
                raw_value: "34-B-0048".to_string(),
            })
            .as_deref(),
            Some("`file_name` = '34-B-0048'")
        );
        assert_eq!(
            build_data_grid_column_value_filter_condition(DataGridColumnValueFilterConditionOptions {
                database_type: Some(DatabaseType::Mysql),
                identifier_quote: None,
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
                identifier_quote: None,
                column_name: "status".to_string(),
                mode: DataGridContextFilterMode::Like,
                value: json!("active"),
                values: Vec::new(),
                end_value: None,
                column_info: Some(column("status", "varchar", true, None)),
            })
            .as_deref(),
            Some("\"status\" LIKE '%active%'")
        );
        assert_eq!(
            build_data_grid_context_filter_condition(DataGridContextFilterConditionOptions {
                database_type: Some(DatabaseType::Postgres),
                identifier_quote: None,
                column_name: "update_date".to_string(),
                mode: DataGridContextFilterMode::Like,
                value: json!("128"),
                values: Vec::new(),
                end_value: None,
                column_info: Some(column("update_date", "bigint", false, None)),
            })
            .as_deref(),
            Some("\"update_date\"::text LIKE '%128%'")
        );
        assert_eq!(
            build_data_grid_context_filter_condition(DataGridContextFilterConditionOptions {
                database_type: Some(DatabaseType::Postgres),
                identifier_quote: None,
                column_name: "created_at".to_string(),
                mode: DataGridContextFilterMode::NotLike,
                value: json!("2026"),
                values: Vec::new(),
                end_value: None,
                column_info: Some(column("created_at", "timestamp without time zone", false, None)),
            })
            .as_deref(),
            Some("\"created_at\"::text NOT LIKE '%2026%'")
        );
        assert_eq!(
            build_data_grid_column_value_filter_condition(DataGridColumnValueFilterConditionOptions {
                database_type: Some(DatabaseType::SqlServer),
                identifier_quote: None,
                column_name: "active".to_string(),
                column_info: Some(column("active", "bitn", false, None)),
                raw_value: "false".to_string(),
            })
            .as_deref(),
            Some("[active] = 0")
        );
    }

    #[test]
    fn builds_membership_and_range_context_filter_conditions() {
        assert_eq!(
            build_data_grid_context_filter_condition(DataGridContextFilterConditionOptions {
                database_type: Some(DatabaseType::Mysql),
                identifier_quote: None,
                column_name: "id".to_string(),
                mode: DataGridContextFilterMode::In,
                value: Value::Null,
                values: vec![json!(42), json!(99)],
                end_value: None,
                column_info: Some(column("id", "int", false, None)),
            })
            .as_deref(),
            Some("`id` IN (42, 99)")
        );
        assert_eq!(
            build_data_grid_context_filter_condition(DataGridContextFilterConditionOptions {
                database_type: Some(DatabaseType::Postgres),
                identifier_quote: None,
                column_name: "status".to_string(),
                mode: DataGridContextFilterMode::In,
                value: Value::Null,
                values: vec![Value::Null, json!("active"), json!("pending"), json!("active")],
                end_value: None,
                column_info: Some(column("status", "varchar", true, None)),
            })
            .as_deref(),
            Some("(\"status\" IS NULL OR \"status\" IN ('active', 'pending'))")
        );
        assert_eq!(
            build_data_grid_context_filter_condition(DataGridContextFilterConditionOptions {
                database_type: Some(DatabaseType::Postgres),
                identifier_quote: None,
                column_name: "status".to_string(),
                mode: DataGridContextFilterMode::NotIn,
                value: Value::Null,
                values: vec![Value::Null, json!("active"), json!("pending")],
                end_value: None,
                column_info: Some(column("status", "varchar", true, None)),
            })
            .as_deref(),
            Some("(\"status\" IS NOT NULL AND \"status\" NOT IN ('active', 'pending'))")
        );
        assert_eq!(
            build_data_grid_context_filter_condition(DataGridContextFilterConditionOptions {
                database_type: Some(DatabaseType::Neo4j),
                identifier_quote: None,
                column_name: "name".to_string(),
                mode: DataGridContextFilterMode::In,
                value: Value::Null,
                values: vec![json!("O'Reilly"), json!(r"C:\temp")],
                end_value: None,
                column_info: Some(column("name", "string", false, None)),
            })
            .as_deref(),
            Some(r#"n.`name` IN ['O\'Reilly', 'C:\\temp']"#)
        );
        assert_eq!(
            build_data_grid_context_filter_condition(DataGridContextFilterConditionOptions {
                database_type: Some(DatabaseType::SqlServer),
                identifier_quote: None,
                column_name: "score".to_string(),
                mode: DataGridContextFilterMode::Between,
                value: json!(10),
                values: Vec::new(),
                end_value: Some(json!(20)),
                column_info: Some(column("score", "int", false, None)),
            })
            .as_deref(),
            Some("[score] BETWEEN 10 AND 20")
        );
        assert_eq!(
            build_data_grid_context_filter_condition(DataGridContextFilterConditionOptions {
                database_type: Some(DatabaseType::SqlServer),
                identifier_quote: None,
                column_name: "score".to_string(),
                mode: DataGridContextFilterMode::NotBetween,
                value: json!(10),
                values: Vec::new(),
                end_value: Some(json!(20)),
                column_info: Some(column("score", "int", false, None)),
            })
            .as_deref(),
            Some("[score] NOT BETWEEN 10 AND 20")
        );
    }

    #[test]
    fn builds_neo4j_membership_and_range_context_filter_conditions() {
        assert_eq!(
            build_data_grid_context_filter_condition(DataGridContextFilterConditionOptions {
                database_type: Some(DatabaseType::Neo4j),
                identifier_quote: None,
                column_name: "score".to_string(),
                mode: DataGridContextFilterMode::In,
                value: Value::Null,
                values: vec![json!(10), json!(20)],
                end_value: None,
                column_info: Some(column("score", "integer", false, None)),
            })
            .as_deref(),
            Some("n.`score` IN [10, 20]")
        );
        assert_eq!(
            build_data_grid_context_filter_condition(DataGridContextFilterConditionOptions {
                database_type: Some(DatabaseType::Neo4j),
                identifier_quote: None,
                column_name: "score".to_string(),
                mode: DataGridContextFilterMode::NotIn,
                value: Value::Null,
                values: vec![json!(10), json!(20)],
                end_value: None,
                column_info: Some(column("score", "integer", false, None)),
            })
            .as_deref(),
            Some("(n.`score` IS NOT NULL AND NOT (n.`score` IN [10, 20]))")
        );
        assert_eq!(
            build_data_grid_context_filter_condition(DataGridContextFilterConditionOptions {
                database_type: Some(DatabaseType::Neo4j),
                identifier_quote: None,
                column_name: "score".to_string(),
                mode: DataGridContextFilterMode::Between,
                value: json!(10),
                values: Vec::new(),
                end_value: Some(json!(20)),
                column_info: Some(column("score", "integer", false, None)),
            })
            .as_deref(),
            Some("(n.`score` >= 10 AND n.`score` <= 20)")
        );
        assert_eq!(
            build_data_grid_context_filter_condition(DataGridContextFilterConditionOptions {
                database_type: Some(DatabaseType::Neo4j),
                identifier_quote: None,
                column_name: "score".to_string(),
                mode: DataGridContextFilterMode::NotBetween,
                value: json!(10),
                values: Vec::new(),
                end_value: Some(json!(20)),
                column_info: Some(column("score", "integer", false, None)),
            })
            .as_deref(),
            Some("(n.`score` < 10 OR n.`score` > 20)")
        );
    }

    #[test]
    fn does_not_emit_membership_or_range_filters_for_unsupported_dialects() {
        for database_type in [DatabaseType::InfluxDb, DatabaseType::Cassandra, DatabaseType::Jdbc] {
            for mode in [
                DataGridContextFilterMode::In,
                DataGridContextFilterMode::NotIn,
                DataGridContextFilterMode::Between,
                DataGridContextFilterMode::NotBetween,
            ] {
                let (value, values, end_value) = match mode {
                    DataGridContextFilterMode::In | DataGridContextFilterMode::NotIn => {
                        (Value::Null, vec![json!(10), json!(20)], None)
                    }
                    DataGridContextFilterMode::Between | DataGridContextFilterMode::NotBetween => {
                        (json!(10), Vec::new(), Some(json!(20)))
                    }
                    _ => unreachable!("only membership and range modes are tested"),
                };

                assert_eq!(
                    build_data_grid_context_filter_condition(DataGridContextFilterConditionOptions {
                        database_type: Some(database_type),
                        identifier_quote: None,
                        column_name: "score".to_string(),
                        mode,
                        value,
                        values,
                        end_value,
                        column_info: Some(column("score", "int", false, None)),
                    }),
                    None,
                    "{database_type:?} must not emit {mode:?}"
                );
            }
        }
    }

    #[test]
    fn context_membership_and_range_filters_require_complete_values() {
        let column_info = Some(column("score", "int", false, None));
        assert_eq!(
            build_data_grid_context_filter_condition(DataGridContextFilterConditionOptions {
                database_type: Some(DatabaseType::Mysql),
                identifier_quote: None,
                column_name: "score".to_string(),
                mode: DataGridContextFilterMode::In,
                value: Value::Null,
                values: Vec::new(),
                end_value: None,
                column_info: column_info.clone(),
            }),
            None
        );
        assert_eq!(
            build_data_grid_context_filter_condition(DataGridContextFilterConditionOptions {
                database_type: Some(DatabaseType::Mysql),
                identifier_quote: None,
                column_name: "score".to_string(),
                mode: DataGridContextFilterMode::Between,
                value: json!(10),
                values: Vec::new(),
                end_value: None,
                column_info: column_info.clone(),
            }),
            None
        );
        assert_eq!(
            build_data_grid_context_filter_condition(DataGridContextFilterConditionOptions {
                database_type: Some(DatabaseType::Mysql),
                identifier_quote: None,
                column_name: "score".to_string(),
                mode: DataGridContextFilterMode::Between,
                value: Value::Null,
                values: Vec::new(),
                end_value: Some(json!(20)),
                column_info: column_info.clone(),
            }),
            None
        );
        assert_eq!(
            build_data_grid_context_filter_condition(DataGridContextFilterConditionOptions {
                database_type: Some(DatabaseType::Mysql),
                identifier_quote: None,
                column_name: "score".to_string(),
                mode: DataGridContextFilterMode::NotBetween,
                value: json!(10),
                values: Vec::new(),
                end_value: Some(Value::Null),
                column_info,
            }),
            None
        );
    }

    #[test]
    fn context_filter_options_default_new_fields_when_deserializing_old_requests() {
        let options: DataGridContextFilterConditionOptions = serde_json::from_value(json!({
            "databaseType": "mysql",
            "columnName": "id",
            "mode": "equals",
            "value": 42,
        }))
        .unwrap();

        assert!(options.values.is_empty());
        assert_eq!(options.end_value, None);
    }

    #[test]
    fn builds_multi_value_filter_conditions() {
        assert_eq!(
            build_data_grid_column_values_filter_condition(DataGridColumnValuesFilterConditionOptions {
                database_type: Some(DatabaseType::Postgres),
                identifier_quote: None,
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
                identifier_quote: None,
                column_name: "id".to_string(),
                column_info: Some(column("id", "int", false, None)),
                values: vec![json!(42)],
            })
            .as_deref(),
            Some("`id` = 42")
        );
    }

    #[test]
    fn chunks_large_oracle_membership_filters_with_correct_boolean_operator() {
        let values = (0..=1000).map(|value| json!(value)).collect::<Vec<_>>();
        let in_condition = build_data_grid_context_filter_condition(DataGridContextFilterConditionOptions {
            database_type: Some(DatabaseType::Oracle),
            identifier_quote: None,
            column_name: "id".to_string(),
            mode: DataGridContextFilterMode::In,
            value: Value::Null,
            values: values.clone(),
            end_value: None,
            column_info: Some(column("id", "number", false, None)),
        })
        .unwrap();
        assert_eq!(in_condition.matches("\"id\" IN (").count(), 2);
        assert!(in_condition.contains(") OR \"id\" IN ("));

        let not_in_condition = build_data_grid_context_filter_condition(DataGridContextFilterConditionOptions {
            database_type: Some(DatabaseType::Oracle),
            identifier_quote: None,
            column_name: "id".to_string(),
            mode: DataGridContextFilterMode::NotIn,
            value: Value::Null,
            values,
            end_value: None,
            column_info: Some(column("id", "number", false, None)),
        })
        .unwrap();
        assert_eq!(not_in_condition.matches("\"id\" NOT IN (").count(), 2);
        assert!(not_in_condition.contains(") AND \"id\" NOT IN ("));
    }

    #[test]
    fn keeps_postgres_bit_strings_out_of_boolean_literal_handling() {
        let bit = column("flags", "bit(3)", false, None);
        let varying = column("flags", "bit varying", false, None);

        assert_eq!(parse_typed_filter_value("true", Some(DatabaseType::Postgres), Some(&bit)), json!("true"));
        assert_eq!(parse_typed_filter_value("false", Some(DatabaseType::Postgres), Some(&varying)), json!("false"));
        assert_eq!(
            build_data_grid_column_value_filter_condition(DataGridColumnValueFilterConditionOptions {
                database_type: Some(DatabaseType::Postgres),
                identifier_quote: None,
                column_name: "flags".to_string(),
                column_info: Some(bit),
                raw_value: "true".to_string(),
            })
            .as_deref(),
            Some("\"flags\" = 'true'")
        );
        assert_eq!(
            format_grid_sql_literal(
                &json!(true),
                Some(DatabaseType::SqlServer),
                Some(&column("flag", "bit", false, None))
            ),
            "1"
        );
    }

    #[test]
    fn builds_column_distinct_values_sql() {
        assert_eq!(
            build_data_grid_column_distinct_values_sql(DataGridColumnDistinctValuesSqlOptions {
                database_type: Some(DatabaseType::Postgres),
                identifier_quote: None,
                catalog: None,
                database: None,
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
                identifier_quote: None,
                catalog: None,
                database: None,
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
                identifier_quote: None,
                catalog: None,
                database: None,
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
                identifier_quote: None,
                catalog: None,
                database: None,
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
        assert_eq!(
            build_data_grid_column_distinct_values_sql(DataGridColumnDistinctValuesSqlOptions {
                database_type: Some(DatabaseType::Firebird),
                identifier_quote: None,
                catalog: None,
                database: None,
                schema: None,
                table_name: "USERS".to_string(),
                column_name: "STATUS".to_string(),
                column_info: Some(column("STATUS", "varchar(32)", true, None)),
                where_input: Some("WHERE DELETED_AT IS NULL".to_string()),
                search_value: None,
                limit: Some(25),
                include_counts: false,
            }),
            "SELECT \"STATUS\" AS dbx_value FROM \"USERS\" WHERE (DELETED_AT IS NULL) GROUP BY \"STATUS\" ORDER BY dbx_value ROWS 25"
        );
        // Doris / StarRocks external-catalog tables are addressed with a 3-part name.
        assert_eq!(
            build_data_grid_column_distinct_values_sql(DataGridColumnDistinctValuesSqlOptions {
                database_type: Some(DatabaseType::Doris),
                identifier_quote: None,
                catalog: Some("iceberg_catalog".to_string()),
                database: None,
                schema: Some("sales".to_string()),
                table_name: "orders".to_string(),
                column_name: "status".to_string(),
                column_info: Some(column("status", "varchar", true, None)),
                where_input: None,
                search_value: None,
                limit: Some(10),
                include_counts: false,
            }),
            "SELECT `status` AS dbx_value FROM `iceberg_catalog`.`sales`.`orders` GROUP BY `status` ORDER BY dbx_value LIMIT 10"
        );
        assert_eq!(
            build_data_grid_column_distinct_values_sql(DataGridColumnDistinctValuesSqlOptions {
                database_type: Some(DatabaseType::StarRocks),
                identifier_quote: None,
                catalog: Some("hive_catalog".to_string()),
                database: None,
                schema: None,
                table_name: "orders".to_string(),
                column_name: "status".to_string(),
                column_info: Some(column("status", "varchar", true, None)),
                where_input: None,
                search_value: None,
                limit: Some(10),
                include_counts: true,
            }),
            "SELECT `status` AS dbx_value, COUNT(*) AS dbx_count FROM `hive_catalog`.`orders` GROUP BY `status` ORDER BY dbx_count DESC, dbx_value LIMIT 10"
        );
        // The built-in `internal` catalog is never prefixed.
        assert_eq!(
            build_data_grid_column_distinct_values_sql(DataGridColumnDistinctValuesSqlOptions {
                database_type: Some(DatabaseType::Doris),
                identifier_quote: None,
                catalog: Some("internal".to_string()),
                database: None,
                schema: None,
                table_name: "orders".to_string(),
                column_name: "status".to_string(),
                column_info: Some(column("status", "varchar", true, None)),
                where_input: None,
                search_value: None,
                limit: Some(10),
                include_counts: false,
            }),
            "SELECT `status` AS dbx_value FROM `orders` GROUP BY `status` ORDER BY dbx_value LIMIT 10"
        );
    }

    #[test]
    fn builds_grid_count_sql() {
        assert_eq!(
            build_data_grid_count_sql(DataGridCountSqlOptions {
                database_type: Some(DatabaseType::Postgres),
                identifier_quote: None,
                catalog: None,
                database: None,
                schema: Some("public".to_string()),
                table_name: "users".to_string(),
                where_input: Some("WHERE active = true;".to_string()),
            }),
            "SELECT COUNT(*) AS cnt FROM \"public\".\"users\" WHERE (active = true)"
        );
        assert_eq!(
            build_data_grid_count_sql(DataGridCountSqlOptions {
                database_type: Some(DatabaseType::Doris),
                identifier_quote: None,
                catalog: Some("iceberg_catalog".to_string()),
                database: None,
                schema: Some("sales".to_string()),
                table_name: "orders".to_string(),
                where_input: Some("WHERE active = true;".to_string()),
            }),
            "SELECT COUNT(*) AS cnt FROM `iceberg_catalog`.`sales`.`orders` WHERE (active = true)"
        );
        // catalog + database (schema absent) → 3-part `catalog.database.table`
        assert_eq!(
            build_data_grid_count_sql(DataGridCountSqlOptions {
                database_type: Some(DatabaseType::Doris),
                identifier_quote: None,
                catalog: Some("iceberg_catalog".to_string()),
                database: Some("sales".to_string()),
                schema: None,
                table_name: "orders".to_string(),
                where_input: Some("WHERE active = true;".to_string()),
            }),
            "SELECT COUNT(*) AS cnt FROM `iceberg_catalog`.`sales`.`orders` WHERE (active = true)"
        );
        assert_eq!(
            build_data_grid_count_sql(DataGridCountSqlOptions {
                database_type: Some(DatabaseType::StarRocks),
                identifier_quote: None,
                catalog: Some("hive_catalog".to_string()),
                database: None,
                schema: None,
                table_name: "orders".to_string(),
                where_input: None,
            }),
            "SELECT COUNT(*) AS cnt FROM `hive_catalog`.`orders`"
        );
        assert_eq!(
            build_data_grid_count_sql(DataGridCountSqlOptions {
                database_type: Some(DatabaseType::Kingbase),
                identifier_quote: Some("`".to_string()),
                catalog: None,
                database: None,
                schema: Some("cqbq_ls".to_string()),
                table_name: "ANALYZE".to_string(),
                where_input: None,
            }),
            "SELECT COUNT(*) AS cnt FROM `cqbq_ls`.`ANALYZE`"
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
    fn prepares_hive_insert_from_qualified_result_labels() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Hive),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("ai_test".to_string()),
                table_name: "t1".to_string(),
                primary_keys: vec![],
                columns: Some(vec![
                    column("id", "int", false, None),
                    column("name", "string", true, None),
                    column("amount", "double", true, None),
                    column("create_time", "string", true, None),
                ]),
            },
            columns: vec![
                "t1.id".to_string(),
                "t1.name".to_string(),
                "t1.amount".to_string(),
                "t1.create_time".to_string(),
            ],
            source_columns: None,
            rows: vec![],
            dirty_rows: vec![],
            deleted_rows: vec![],
            new_rows: vec![vec![json!(4), Value::Null, Value::Null, Value::Null]],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(result.statements, vec!["INSERT INTO TABLE `ai_test`.`t1` VALUES (4, NULL, NULL, NULL);"]);
        assert_eq!(
            result.rollback_statements,
            vec!["DELETE FROM `ai_test`.`t1` WHERE `id` = 4 AND `name` IS NULL AND `amount` IS NULL AND `create_time` IS NULL;"]
        );
    }

    #[test]
    fn resolves_quoted_hive_source_columns_for_updates_and_primary_keys() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Hive),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("default".to_string()),
                table_name: "users".to_string(),
                primary_keys: vec!["ID".to_string()],
                columns: Some(vec![column("id", "int", false, None), column("name", "string", true, None)]),
            },
            columns: vec!["identifier".to_string(), "display_name".to_string()],
            source_columns: Some(vec![Some("`u`.`id`".to_string()), Some("`u`.`name`".to_string())]),
            rows: vec![vec![json!(1), json!("Ada")], vec![json!(2), json!("Grace")]],
            dirty_rows: vec![(0, vec![(1, json!("Ada Lovelace"))])],
            deleted_rows: vec![1],
            new_rows: vec![],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(
            result.statements,
            vec![
                "UPDATE `default`.`users` SET `name` = 'Ada Lovelace' WHERE `ID` = 1;",
                "DELETE FROM `default`.`users` WHERE `ID` = 2;",
            ]
        );
        assert_eq!(
            result.rollback_statements,
            vec![
                "INSERT INTO TABLE `default`.`users` VALUES (2, 'Grace');",
                "UPDATE `default`.`users` SET `name` = 'Ada' WHERE `ID` = 1 AND `name` = 'Ada Lovelace';",
            ]
        );
    }

    #[test]
    fn preserves_real_dotted_hive_columns_and_other_dialects() {
        let hive_options = DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Hive),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("default".to_string()),
                table_name: "events".to_string(),
                primary_keys: vec![],
                columns: Some(vec![column("payload.id", "int", true, None), column("name", "string", true, None)]),
            },
            columns: vec!["payload.id".to_string(), "events.name".to_string()],
            source_columns: None,
            rows: vec![],
            dirty_rows: vec![],
            deleted_rows: vec![],
            new_rows: vec![vec![json!(7), json!("created")]],
        };
        assert_eq!(effective_columns(&hive_options), vec![Some("payload.id".to_string()), Some("name".to_string())]);
        assert!(prepare_data_grid_save(hive_options).rollback_statements[0].contains("`payload.id` = 7"));

        let postgres_options = DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Postgres),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("public".to_string()),
                table_name: "events".to_string(),
                primary_keys: vec![],
                columns: Some(vec![column("id", "integer", true, None)]),
            },
            columns: vec!["events.id".to_string()],
            source_columns: None,
            rows: vec![],
            dirty_rows: vec![],
            deleted_rows: vec![],
            new_rows: vec![],
        };
        assert_eq!(effective_columns(&postgres_options), vec![Some("events.id".to_string())]);
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
        assert_eq!(
            format_grid_sql_literal(&json!("2026-05-12 00:00:00.123456"), Some(DatabaseType::Mysql), None),
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
                &json!("2026-06-29 10:11:12.123456"),
                Some(DatabaseType::SqlServer),
                Some(&datetime2)
            ),
            "N'2026-06-29 10:11:12.1234560'"
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
    fn formats_oracle_temporal_literals_from_editor_values_without_nls_parsing() {
        let timestamp = column("created_at", "TIMESTAMP(6)", true, None);
        let date = column("event_day", "DATE", true, None);

        assert_eq!(
            format_grid_sql_literal(&json!("2022-08-25 09:58:43"), Some(DatabaseType::Oracle), Some(&timestamp)),
            "TO_TIMESTAMP('2022-08-25 09:58:43', 'YYYY-MM-DD HH24:MI:SS')"
        );
        assert_eq!(
            format_grid_sql_literal(&json!("2022-08-25 09:58:43.123456"), Some(DatabaseType::Oracle), Some(&timestamp)),
            "TO_TIMESTAMP('2022-08-25 09:58:43.123456', 'YYYY-MM-DD HH24:MI:SS.FF')"
        );
        assert_eq!(
            format_grid_sql_literal(&json!("2022-08-25 09:58:43.654321"), Some(DatabaseType::Oracle), Some(&timestamp)),
            "TO_TIMESTAMP('2022-08-25 09:58:43.654321', 'YYYY-MM-DD HH24:MI:SS.FF')"
        );
        assert_eq!(
            format_grid_sql_literal(&json!("2022-08-25 09:58:43"), Some(DatabaseType::Oracle), Some(&date)),
            "TO_DATE('2022-08-25 09:58:43', 'YYYY-MM-DD HH24:MI:SS')"
        );
        assert_eq!(
            format_grid_sql_literal(&json!("2022-08-25"), Some(DatabaseType::Oracle), Some(&date)),
            "DATE '2022-08-25'"
        );
        assert_eq!(
            format_grid_sql_literal(&json!("2022-08-25T00:00:00Z"), Some(DatabaseType::Oracle), Some(&date)),
            "DATE '2022-08-25'"
        );
    }

    #[test]
    fn formats_numeric_string_literals_for_numeric_columns_without_quotes() {
        let number = column("amount", "NUMBER(20,0)", true, None);
        let text = column("code", "VARCHAR2(32)", true, None);

        assert_eq!(
            format_grid_sql_literal(&json!("12345678901234567890"), Some(DatabaseType::Oracle), Some(&number)),
            "12345678901234567890"
        );
        assert_eq!(
            format_grid_sql_literal(&json!("12345678901234567890"), Some(DatabaseType::Oracle), Some(&text)),
            "'12345678901234567890'"
        );
        assert_eq!(
            format_grid_sql_literal(&json!("123-not-a-number"), Some(DatabaseType::Oracle), Some(&number)),
            "'123-not-a-number'"
        );
    }

    #[test]
    fn prepares_sqlserver_bigint_update_from_numeric_string() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::SqlServer),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("dbo".to_string()),
                table_name: "users".to_string(),
                primary_keys: vec!["Id".to_string()],
                columns: Some(vec![column("Id", "int", false, None), column("UserId", "bigint", true, None)]),
            },
            columns: vec!["Id".to_string(), "UserId".to_string()],
            source_columns: None,
            rows: vec![vec![json!(1), json!(142189065666650_i64)]],
            dirty_rows: vec![(0, vec![(1, json!("144847503924137986"))])],
            deleted_rows: vec![],
            new_rows: vec![],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(result.statements, vec!["UPDATE [dbo].[users] SET [UserId] = 144847503924137986 WHERE [Id] = 1;"]);
    }

    #[test]
    fn prepares_kingbase_update_when_source_primary_key_case_differs() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Kingbase),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("ltcins_qd_db".to_string()),
                table_name: "KG07".to_string(),
                primary_keys: vec!["CKG023".to_string()],
                columns: Some(vec![
                    column("CKG023", "varchar", false, None),
                    column("CKG096", "character", true, None),
                ]),
            },
            columns: vec!["ckg023".to_string(), "CKG096".to_string()],
            source_columns: Some(vec![Some("ckg023".to_string()), Some("CKG096".to_string())]),
            rows: vec![vec![json!("2026071511071859"), json!("03")]],
            dirty_rows: vec![(0, vec![(1, json!("02"))])],
            deleted_rows: vec![],
            new_rows: vec![],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(
            result.statements,
            vec![r#"UPDATE "ltcins_qd_db"."KG07" SET "CKG096" = '02' WHERE "CKG023" = '2026071511071859';"#]
        );
        assert_eq!(
            result.rollback_statements,
            vec![
                r#"UPDATE "ltcins_qd_db"."KG07" SET "CKG096" = '03' WHERE "CKG023" = '2026071511071859' AND "CKG096" = '02';"#
            ]
        );
    }

    #[test]
    fn rejects_existing_row_save_when_primary_key_is_missing() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Kingbase),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("ltcins_qd_db".to_string()),
                table_name: "KG07".to_string(),
                primary_keys: vec!["CKG023".to_string()],
                columns: Some(vec![
                    column("CKG023", "varchar", false, None),
                    column("CKG096", "character", true, None),
                ]),
            },
            columns: vec!["CKG096".to_string()],
            source_columns: Some(vec![Some("CKG096".to_string())]),
            rows: vec![vec![json!("03")]],
            dirty_rows: vec![(0, vec![(0, json!("02"))])],
            deleted_rows: vec![],
            new_rows: vec![],
        });

        assert_eq!(
            result.validation_error.as_deref(),
            Some(
                "Cannot safely update or delete rows because the query result does not include every primary key column (missing: CKG023). Refresh or rerun the query before saving."
            )
        );
        assert!(result.statements.is_empty());
        assert!(result.rollback_statements.is_empty());
    }

    #[test]
    fn rejects_existing_row_save_when_primary_key_value_is_null() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Kingbase),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("ltcins_qd_db".to_string()),
                table_name: "KG07".to_string(),
                primary_keys: vec!["CKG023".to_string()],
                columns: Some(vec![
                    column("CKG023", "varchar", false, None),
                    column("CKG096", "character", true, None),
                ]),
            },
            columns: vec!["CKG023".to_string(), "CKG096".to_string()],
            source_columns: None,
            rows: vec![vec![Value::Null, json!("03")]],
            dirty_rows: vec![(0, vec![(1, json!("02"))])],
            deleted_rows: vec![],
            new_rows: vec![],
        });

        assert_eq!(
            result.validation_error.as_deref(),
            Some(
                "Cannot safely update or delete rows because primary key column \"CKG023\" has no value in the query result. Refresh or rerun the query before saving."
            )
        );
        assert!(result.statements.is_empty());
        assert!(result.rollback_statements.is_empty());
    }

    #[test]
    fn kingbase_column_index_prefers_exact_case_and_rejects_ambiguous_fallback() {
        let columns = vec![Some("ckg023".to_string()), Some("CKG023".to_string())];

        assert_eq!(find_column_index(Some(DatabaseType::Kingbase), &columns, "CKG023"), Some(1));
        assert_eq!(find_column_index(Some(DatabaseType::Kingbase), &columns[..1], "CKG023"), Some(0));
        assert_eq!(
            find_column_index(
                Some(DatabaseType::Kingbase),
                &[Some("ckg023".to_string()), Some("Ckg023".to_string())],
                "CKG023"
            ),
            None
        );
    }

    #[test]
    fn goldendb_column_index_prefers_exact_case_and_rejects_ambiguous_fallback() {
        let columns = vec![Some("id".to_string()), Some("ID".to_string())];

        assert_eq!(find_column_index(Some(DatabaseType::Goldendb), &columns, "ID"), Some(1));
        assert_eq!(find_column_index(Some(DatabaseType::Goldendb), &columns[..1], "ID"), Some(0));
        assert_eq!(
            find_column_index(Some(DatabaseType::Goldendb), &[Some("id".to_string()), Some("Id".to_string())], "ID"),
            None
        );
    }

    #[test]
    fn goldendb_save_uses_unique_case_insensitive_primary_key_for_update_and_delete() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Goldendb),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("app".to_string()),
                table_name: "people".to_string(),
                primary_keys: vec!["ID".to_string()],
                columns: Some(vec![column("ID", "bigint", false, None), column("name", "varchar", true, None)]),
            },
            columns: vec!["id".to_string(), "name".to_string()],
            source_columns: Some(vec![Some("id".to_string()), Some("name".to_string())]),
            rows: vec![vec![json!(1), json!("Ada")], vec![json!(2), json!("Grace")]],
            dirty_rows: vec![(0, vec![(1, json!("Ada Lovelace"))])],
            deleted_rows: vec![1],
            new_rows: vec![],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(
            result.statements,
            vec![
                "UPDATE `app`.`people` SET `name` = 'Ada Lovelace' WHERE `ID` = 1;",
                "DELETE FROM `app`.`people` WHERE `ID` = 2;",
            ]
        );
    }

    #[test]
    fn goldendb_save_supports_composite_primary_keys_with_unique_case_insensitive_matches() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Goldendb),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("app".to_string()),
                table_name: "members".to_string(),
                primary_keys: vec!["TENANT_ID".to_string(), "USER_ID".to_string()],
                columns: Some(vec![
                    column("TENANT_ID", "bigint", false, None),
                    column("USER_ID", "bigint", false, None),
                    column("name", "varchar", true, None),
                ]),
            },
            columns: vec!["tenant_id".to_string(), "user_id".to_string(), "name".to_string()],
            source_columns: Some(vec![
                Some("tenant_id".to_string()),
                Some("user_id".to_string()),
                Some("name".to_string()),
            ]),
            rows: vec![vec![json!(10), json!(1), json!("Ada")], vec![json!(10), json!(2), json!("Grace")]],
            dirty_rows: vec![(0, vec![(2, json!("Ada Lovelace"))])],
            deleted_rows: vec![1],
            new_rows: vec![],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(
            result.statements,
            vec![
                "UPDATE `app`.`members` SET `name` = 'Ada Lovelace' WHERE `TENANT_ID` = 10 AND `USER_ID` = 1;",
                "DELETE FROM `app`.`members` WHERE `TENANT_ID` = 10 AND `USER_ID` = 2;",
            ]
        );
    }

    #[test]
    fn rejects_goldendb_save_when_case_insensitive_primary_key_match_is_ambiguous() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Goldendb),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("app".to_string()),
                table_name: "people".to_string(),
                primary_keys: vec!["ID".to_string()],
                columns: Some(vec![column("ID", "bigint", false, None), column("name", "varchar", true, None)]),
            },
            columns: vec!["id".to_string(), "Id".to_string(), "name".to_string()],
            source_columns: Some(vec![Some("id".to_string()), Some("Id".to_string()), Some("name".to_string())]),
            rows: vec![vec![json!(1), json!(2), json!("Ada")]],
            dirty_rows: vec![(0, vec![(2, json!("Grace"))])],
            deleted_rows: vec![0],
            new_rows: vec![],
        });

        assert!(result.validation_error.as_deref().is_some_and(|error| error.contains("missing: ID")));
        assert!(result.statements.is_empty());
        assert!(result.rollback_statements.is_empty());
    }

    #[test]
    fn rejects_goldendb_save_when_primary_key_column_is_truly_missing() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Goldendb),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("app".to_string()),
                table_name: "people".to_string(),
                primary_keys: vec!["ID".to_string()],
                columns: Some(vec![column("ID", "bigint", false, None), column("name", "varchar", true, None)]),
            },
            columns: vec!["tenant_id".to_string(), "name".to_string()],
            source_columns: Some(vec![Some("tenant_id".to_string()), Some("name".to_string())]),
            rows: vec![vec![json!(10), json!("Ada")]],
            dirty_rows: vec![(0, vec![(1, json!("Grace"))])],
            deleted_rows: vec![0],
            new_rows: vec![],
        });

        assert!(result.validation_error.as_deref().is_some_and(|error| error.contains("missing: ID")));
        assert!(result.statements.is_empty());
        assert!(result.rollback_statements.is_empty());
    }

    #[test]
    fn rejects_postgres_save_when_only_case_different_column_is_returned() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Postgres),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("public".to_string()),
                table_name: "case_keys".to_string(),
                primary_keys: vec!["ID".to_string()],
                columns: Some(vec![
                    column("id", "integer", false, None),
                    column("ID", "integer", false, None),
                    column("name", "text", true, None),
                ]),
            },
            columns: vec!["id".to_string(), "name".to_string()],
            source_columns: Some(vec![Some("id".to_string()), Some("name".to_string())]),
            rows: vec![vec![json!(1), json!("Ada")]],
            dirty_rows: vec![(0, vec![(1, json!("Grace"))])],
            deleted_rows: vec![0],
            new_rows: vec![],
        });

        assert_eq!(
            result.validation_error.as_deref(),
            Some(
                "Cannot safely update or delete rows because the query result does not include every primary key column (missing: ID). Refresh or rerun the query before saving."
            )
        );
        assert!(result.statements.is_empty());
        assert!(result.rollback_statements.is_empty());
    }

    #[test]
    fn rejects_kingbase_save_when_case_only_primary_key_match_is_ambiguous() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Kingbase),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("public".to_string()),
                table_name: "case_keys".to_string(),
                primary_keys: vec!["CKG023".to_string()],
                columns: Some(vec![column("CKG023", "varchar", false, None), column("name", "varchar", true, None)]),
            },
            columns: vec!["ckg023".to_string(), "Ckg023".to_string(), "name".to_string()],
            source_columns: Some(vec![
                Some("ckg023".to_string()),
                Some("Ckg023".to_string()),
                Some("name".to_string()),
            ]),
            rows: vec![vec![json!("first"), json!("second"), json!("Ada")]],
            dirty_rows: vec![(0, vec![(2, json!("Grace"))])],
            deleted_rows: vec![],
            new_rows: vec![],
        });

        assert!(result.validation_error.as_deref().is_some_and(|error| error.contains("missing: CKG023")));
        assert!(result.statements.is_empty());
        assert!(result.rollback_statements.is_empty());
    }

    #[test]
    fn kingbase_mysql_compat_save_uses_connection_identifier_quote() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Kingbase),
            identifier_quote: Some("`".to_string()),
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("gc".to_string()),
                table_name: "docfileinfo".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: Some(vec![column("id", "integer", false, None), column("file_name", "varchar", false, None)]),
            },
            columns: vec!["id".to_string(), "file_name".to_string()],
            source_columns: None,
            rows: vec![vec![json!(1), json!("old")]],
            dirty_rows: vec![(0, vec![(1, json!("34-B-0048"))])],
            deleted_rows: vec![],
            new_rows: vec![],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(result.statements, vec!["UPDATE `gc`.`docfileinfo` SET `file_name` = '34-B-0048' WHERE `id` = 1;"]);
        assert!(result
            .rollback_statements
            .iter()
            .all(|statement| statement.contains("`gc`.`docfileinfo`") && !statement.contains('"')));
    }

    #[test]
    fn postgres_save_uses_exact_quoted_primary_key_for_update_delete_and_rollback() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Postgres),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("public".to_string()),
                table_name: "case_keys".to_string(),
                primary_keys: vec!["ID".to_string()],
                columns: Some(vec![
                    column("id", "integer", false, None),
                    column("ID", "integer", false, None),
                    column("name", "text", true, None),
                ]),
            },
            columns: vec!["id".to_string(), "ID".to_string(), "name".to_string()],
            source_columns: Some(vec![Some("id".to_string()), Some("ID".to_string()), Some("name".to_string())]),
            rows: vec![vec![json!(1), json!(101), json!("Ada")], vec![json!(2), json!(202), json!("Grace")]],
            dirty_rows: vec![(0, vec![(2, json!("Ada Lovelace"))])],
            deleted_rows: vec![1],
            new_rows: vec![],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(
            result.statements,
            vec![
                r#"UPDATE "public"."case_keys" SET "name" = 'Ada Lovelace' WHERE "ID" = 101;"#,
                r#"DELETE FROM "public"."case_keys" WHERE "ID" = 202;"#,
            ]
        );
        assert!(result.rollback_statements.iter().all(|statement| !statement.contains(r#"WHERE "ID" = 1 AND"#)));
        assert!(result.rollback_statements.iter().any(|statement| statement.contains(r#"WHERE "ID" = 101"#)));
    }

    #[test]
    fn prepares_oracle_timestamp_insert_from_iso_grid_value() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Oracle),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
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
    fn prepares_oceanbase_oracle_lob_deletes_with_synthetic_rowid() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::OceanbaseOracle),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("APP".to_string()),
                table_name: "DATA_REPORT_SUB_TASK".to_string(),
                primary_keys: vec![DBX_ROWID_COLUMN.to_string()],
                columns: Some(vec![
                    column(DBX_ROWID_COLUMN, "VARCHAR2", false, None),
                    column("ID", "VARCHAR2(100)", false, None),
                    column("SMC_RESPONSE", "CLOB", true, None),
                    column("RAW_PAYLOAD", "BLOB", true, None),
                    column("ARCHIVE_VALUE", "LOB", true, None),
                ]),
            },
            columns: vec![
                DBX_ROWID_COLUMN.to_string(),
                "ID".to_string(),
                "SMC_RESPONSE".to_string(),
                "RAW_PAYLOAD".to_string(),
                "ARCHIVE_VALUE".to_string(),
            ],
            source_columns: None,
            rows: vec![
                vec![json!("*AAABk1AAEAAAAAgAAA"), json!("task-1"), json!("response"), json!("0011"), json!("archive")],
                vec![json!("*AAABk1AAEAAAAAgAAB"), json!("task-2"), Value::Null, Value::Null, Value::Null],
            ],
            dirty_rows: vec![],
            deleted_rows: vec![0, 1],
            new_rows: vec![],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(
            result.statements,
            vec![
                "DELETE FROM \"APP\".\"DATA_REPORT_SUB_TASK\" WHERE ROWIDTOCHAR(ROWID) = '*AAABk1AAEAAAAAgAAA';",
                "DELETE FROM \"APP\".\"DATA_REPORT_SUB_TASK\" WHERE ROWIDTOCHAR(ROWID) = '*AAABk1AAEAAAAAgAAB';",
            ]
        );
    }

    #[test]
    fn prepares_oceanbase_oracle_lob_delete_with_declared_primary_key() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::OceanbaseOracle),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("APP".to_string()),
                table_name: "DOCUMENTS".to_string(),
                primary_keys: vec!["ID".to_string()],
                columns: Some(vec![
                    column("ID", "NUMBER", false, None),
                    column("TITLE", "VARCHAR2(100)", false, None),
                    column("BODY", "CLOB", true, None),
                    column("CONTENT", "BLOB", true, None),
                ]),
            },
            columns: vec!["ID".to_string(), "TITLE".to_string(), "BODY".to_string(), "CONTENT".to_string()],
            source_columns: None,
            rows: vec![vec![json!(42), json!("report"), json!("body"), Value::Null]],
            dirty_rows: vec![],
            deleted_rows: vec![0],
            new_rows: vec![],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(result.statements, vec!["DELETE FROM \"APP\".\"DOCUMENTS\" WHERE \"ID\" = 42;"]);
    }

    #[test]
    fn rejects_oceanbase_oracle_keyless_lob_writes_without_rowid() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::OceanbaseOracle),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("APP".to_string()),
                table_name: "DOCUMENTS".to_string(),
                primary_keys: vec![],
                columns: Some(vec![column("TITLE", "VARCHAR2(100)", false, None), column("BODY", "CLOB", true, None)]),
            },
            columns: vec!["TITLE".to_string(), "BODY".to_string()],
            source_columns: None,
            rows: vec![vec![json!("duplicate title"), json!("unique body")]],
            dirty_rows: vec![],
            deleted_rows: vec![0],
            new_rows: vec![],
        });

        assert_eq!(
            result.validation_error.as_deref(),
            Some("Cannot safely update or delete this Oracle-compatible row because the table has LOB columns but no primary key or ROWID identifier.")
        );
        assert!(result.statements.is_empty());
        assert!(result.rollback_statements.is_empty());
    }

    #[test]
    fn preserves_oceanbase_oracle_keyless_predicates_for_comparable_columns() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::OceanbaseOracle),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("APP".to_string()),
                table_name: "TASK_STATUS".to_string(),
                primary_keys: vec![],
                columns: Some(vec![
                    column("TASK_NAME", "VARCHAR2(100)", false, None),
                    column("STATUS", "VARCHAR2(16)", true, None),
                ]),
            },
            columns: vec!["TASK_NAME".to_string(), "STATUS".to_string()],
            source_columns: None,
            rows: vec![vec![json!("task-1"), json!("RUNNING")], vec![json!("task-2"), Value::Null]],
            dirty_rows: vec![],
            deleted_rows: vec![0, 1],
            new_rows: vec![],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(
            result.statements,
            vec![
                "DELETE FROM \"APP\".\"TASK_STATUS\" WHERE \"TASK_NAME\" = 'task-1' AND \"STATUS\" = 'RUNNING';",
                "DELETE FROM \"APP\".\"TASK_STATUS\" WHERE \"TASK_NAME\" = 'task-2' AND \"STATUS\" IS NULL;",
            ]
        );
    }

    #[test]
    fn batches_mysql_updates_with_identical_values() {
        let mut options = mysql_people_save_options(3);
        options.dirty_rows =
            vec![(0, vec![(1, Value::Null)]), (1, vec![(1, Value::Null)]), (2, vec![(1, Value::Null)])];

        let result = prepare_data_grid_save(options);

        assert_eq!(result.validation_error, None);
        assert_eq!(
            result.statements,
            vec!["UPDATE `app`.`people` SET `status` = NULL WHERE (`id` = 1) OR (`id` = 2) OR (`id` = 3);"]
        );
        assert_eq!(result.rollback_statements.len(), 3);
    }

    #[test]
    fn preserves_mysql_update_order_across_different_values() {
        let mut options = mysql_people_save_options(3);
        options.dirty_rows =
            vec![(0, vec![(1, Value::Null)]), (1, vec![(1, json!("archived"))]), (2, vec![(1, Value::Null)])];

        let result = prepare_data_grid_save(options);

        assert_eq!(
            result.statements,
            vec![
                "UPDATE `app`.`people` SET `status` = NULL WHERE `id` = 1;",
                "UPDATE `app`.`people` SET `status` = 'archived' WHERE `id` = 2;",
                "UPDATE `app`.`people` SET `status` = NULL WHERE `id` = 3;",
            ]
        );
    }

    #[test]
    fn batches_mysql_deletes_and_deleted_row_rollbacks() {
        let mut options = mysql_people_save_options(3);
        options.deleted_rows = vec![0, 1, 2];

        let result = prepare_data_grid_save(options);

        assert_eq!(result.validation_error, None);
        assert_eq!(result.statements, vec!["DELETE FROM `app`.`people` WHERE (`id` = 1) OR (`id` = 2) OR (`id` = 3);"]);
        assert_eq!(
            result.rollback_statements,
            vec!["INSERT INTO `app`.`people` (`id`, `status`) VALUES (1, 'active'), (2, 'active'), (3, 'active');"]
        );
    }

    #[test]
    fn chunks_large_mysql_data_grid_batches() {
        let mut options = mysql_people_save_options(MYSQL_DATA_GRID_BATCH_MAX_ROWS + 1);
        options.deleted_rows = (0..options.rows.len()).collect();

        let result = prepare_data_grid_save(options);

        assert_eq!(result.statements.len(), 2);
        assert!(result.statements[0].contains("(`id` = 500)"));
        assert_eq!(result.statements[1], "DELETE FROM `app`.`people` WHERE `id` = 501;");
        assert_eq!(result.rollback_statements.len(), 2);
        assert!(result.rollback_statements[0].contains("(500, 'active')"));
        assert_eq!(
            result.rollback_statements[1],
            "INSERT INTO `app`.`people` (`id`, `status`) VALUES (501, 'active');"
        );
    }

    #[test]
    fn mysql_data_grid_batch_respects_target_sql_size() {
        let mut options = mysql_people_save_options(2);
        options.rows[0][0] = json!("a".repeat(MYSQL_DATA_GRID_BATCH_TARGET_SQL_BYTES / 2));
        options.rows[1][0] = json!("b".repeat(MYSQL_DATA_GRID_BATCH_TARGET_SQL_BYTES / 2));
        options.deleted_rows = vec![0, 1];

        let result = prepare_data_grid_save(options);

        assert_eq!(result.statements.len(), 2);
        assert!(result.statements.iter().all(|statement| statement.len() <= MYSQL_DATA_GRID_BATCH_TARGET_SQL_BYTES));
    }

    #[test]
    fn keeps_keyless_mysql_writes_row_by_row() {
        let mut options = mysql_people_save_options(2);
        options.table_meta.primary_keys.clear();
        options.deleted_rows = vec![0, 1];

        let result = prepare_data_grid_save(options);

        assert_eq!(result.statements.len(), 2);
        assert_eq!(result.rollback_statements.len(), 2);
        assert!(result.statements.iter().all(|statement| !statement.contains(" OR ")));
    }

    #[test]
    fn casts_keyless_mysql_json_row_predicates() {
        let options = DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Mysql),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("app".to_string()),
                table_name: "documents".to_string(),
                primary_keys: vec![],
                columns: Some(vec![column("payload", "JSON", false, None), column("note", "varchar(32)", true, None)]),
            },
            columns: vec!["payload".to_string(), "note".to_string()],
            source_columns: None,
            rows: vec![vec![json!(r#"{"name":"before"}"#), json!("row-a")]],
            dirty_rows: vec![(0, vec![(0, json!(r#"{"name":"after"}"#))])],
            deleted_rows: vec![],
            new_rows: vec![],
        };

        let update = prepare_data_grid_save(options.clone());
        assert_eq!(update.validation_error, None);
        assert_eq!(
            update.statements,
            vec![
                r#"UPDATE `app`.`documents` SET `payload` = '{"name":"after"}' WHERE `payload` = CAST('{"name":"before"}' AS JSON) AND BINARY `note` = 'row-a';"#
            ]
        );
        assert_eq!(
            update.rollback_statements,
            vec![
                r#"UPDATE `app`.`documents` SET `payload` = '{"name":"before"}' WHERE `payload` = CAST('{"name":"after"}' AS JSON) AND BINARY `note` = 'row-a' AND `payload` = CAST('{"name":"after"}' AS JSON);"#
            ]
        );

        let delete = prepare_data_grid_save(DataGridSaveStatementOptions {
            dirty_rows: vec![],
            deleted_rows: vec![0],
            ..options
        });
        assert_eq!(delete.validation_error, None);
        assert_eq!(
            delete.statements,
            vec![
                r#"DELETE FROM `app`.`documents` WHERE `payload` = CAST('{"name":"before"}' AS JSON) AND BINARY `note` = 'row-a';"#
            ]
        );
        assert_eq!(
            delete.rollback_statements,
            vec![r#"INSERT INTO `app`.`documents` (`payload`, `note`) VALUES ('{"name":"before"}', 'row-a');"#]
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
    fn postgres_literals_use_escape_strings_for_stable_backslash_semantics() {
        let value = json!(r#"{"json_raw":"{\"foo\":1,\"bar\":\"sometext\"}"}"#);
        assert_eq!(
            format_grid_sql_literal(&value, Some(DatabaseType::Postgres), None),
            r#"E'{"json_raw":"{\\"foo\\":1,\\"bar\\":\\"sometext\\"}"}'"#
        );
        assert_eq!(format_grid_sql_literal(&json!("it's"), Some(DatabaseType::Postgres), None), "'it''s'");
    }

    #[test]
    fn sqlite_family_literals_do_not_double_escape_backslashes() {
        let value = json!(r#"{"json_raw":"{\"foo\":1,\"bar\":\"sometext\"}"}"#);
        for database_type in
            [DatabaseType::Sqlite, DatabaseType::Rqlite, DatabaseType::Turso, DatabaseType::CloudflareD1]
        {
            assert_eq!(
                format_grid_sql_literal(&value, Some(database_type), None),
                r#"'{"json_raw":"{\"foo\":1,\"bar\":\"sometext\"}"}'"#
            );
            assert_eq!(format_grid_sql_literal(&json!("it's"), Some(database_type), None), "'it''s'");
        }
    }

    #[test]
    fn sqlserver_literals_do_not_double_escape_backslashes() {
        assert_eq!(format_grid_sql_literal(&json!(r".\SQL2016"), Some(DatabaseType::SqlServer), None), r"N'.\SQL2016'");
        assert_eq!(
            format_grid_sql_literal(&json!(r".\SQL2016's"), Some(DatabaseType::SqlServer), None),
            r"N'.\SQL2016''s'"
        );
    }

    #[test]
    fn sqlserver_literals_preserve_backslashes_before_line_breaks() {
        assert_eq!(
            format_grid_sql_literal(&json!("line1\\\nline2"), Some(DatabaseType::SqlServer), None),
            r"N'line1\' + NCHAR(10) + N'line2'"
        );
        assert_eq!(
            format_grid_sql_literal(&json!("line1\\\r\nline2"), Some(DatabaseType::SqlServer), None),
            r"N'line1\' + NCHAR(13) + NCHAR(10) + N'line2'"
        );
    }

    #[test]
    fn prepares_sqlserver_updates_without_doubling_backslashes() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::SqlServer),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("dbo".to_string()),
                table_name: "dbx_issue_4181".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: Some(vec![column("id", "int", false, None), column("value", "nvarchar(100)", true, None)]),
            },
            columns: vec!["id".to_string(), "value".to_string()],
            source_columns: None,
            rows: vec![vec![json!(1), json!("initial")]],
            dirty_rows: vec![(0, vec![(1, json!(r".\SQL2016"))])],
            deleted_rows: vec![],
            new_rows: vec![],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(
            result.statements,
            vec![r"UPDATE [dbo].[dbx_issue_4181] SET [value] = N'.\SQL2016' WHERE [id] = 1;"]
        );
    }

    #[test]
    fn mysql_and_neo4j_literals_keep_doubling_backslashes() {
        // MySQL (default sql_mode, without NO_BACKSLASH_ESCAPES) and Neo4j do treat
        // backslash as an escape character, so this behavior must be preserved.
        assert_eq!(format_grid_sql_literal(&json!(r"a\b"), Some(DatabaseType::Mysql), None), r"'a\\b'");
        assert_eq!(format_grid_sql_literal(&json!(r"a\b"), Some(DatabaseType::Neo4j), None), r"'a\\b'");
    }

    #[test]
    fn prepares_sqlserver_bitn_updates_with_numeric_literals() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::SqlServer),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("dbo".to_string()),
                table_name: "flags".to_string(),
                primary_keys: vec![],
                columns: Some(vec![column("id", "int", false, None), column("active", "bitn", false, None)]),
            },
            columns: vec!["id".to_string(), "active".to_string()],
            source_columns: None,
            rows: vec![vec![json!(1), json!(false)]],
            dirty_rows: vec![(0, vec![(1, json!(true))])],
            deleted_rows: vec![],
            new_rows: vec![],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(result.statements, vec!["UPDATE [dbo].[flags] SET [active] = 1 WHERE [id] = 1 AND [active] = 0;"]);
        assert_eq!(
            result.rollback_statements,
            vec!["UPDATE [dbo].[flags] SET [active] = 0 WHERE [id] = 1 AND [active] = 1 AND [active] = 1;"]
        );
        for sql in result.statements.iter().chain(result.rollback_statements.iter()) {
            assert!(!sql.contains("TRUE"));
            assert!(!sql.contains("FALSE"));
        }
    }

    #[test]
    fn saves_empty_nullable_mysql_numeric_cell_as_null() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Mysql),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
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
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
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
    fn preserves_mysql_text_cell_line_breaks() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Mysql),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: None,
                table_name: "employees".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: Some(vec![column("id", "int(11)", false, None), column("name", "varchar(50)", true, None)]),
            },
            columns: vec!["id".to_string(), "name".to_string()],
            source_columns: None,
            rows: vec![vec![json!(2), json!("Ada")]],
            dirty_rows: vec![(0, vec![(1, json!("111\n222"))])],
            deleted_rows: vec![],
            new_rows: vec![],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(result.statements, vec!["UPDATE `employees` SET `name` = '111\n222' WHERE `id` = 2;"]);
        assert_eq!(
            result.rollback_statements,
            vec!["UPDATE `employees` SET `name` = 'Ada' WHERE `id` = 2 AND BINARY `name` = '111\n222';"]
        );
    }

    #[test]
    fn prepares_sqlserver_save_statements() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::SqlServer),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
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
    fn prepares_tdengine_child_table_delete_from_stable_row() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Tdengine),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("dbx_tdengine_demo".to_string()),
                table_name: "meters".to_string(),
                primary_keys: vec![DBX_TDENGINE_TBNAME_COLUMN.to_string(), "ts".to_string()],
                columns: Some(vec![column("ts", "TIMESTAMP", false, None), column("voltage", "FLOAT", true, None)]),
            },
            columns: vec![DBX_TDENGINE_TBNAME_COLUMN.to_string(), "ts".to_string(), "voltage".to_string()],
            source_columns: None,
            rows: vec![vec![json!("codex_delete_verify"), json!("2026-07-10T13:59:00.456+08:00"), json!(221.5)]],
            dirty_rows: vec![],
            deleted_rows: vec![0],
            new_rows: vec![],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(
            result.statements,
            vec!["DELETE FROM `dbx_tdengine_demo`.`codex_delete_verify` WHERE `ts` = '2026-07-10T13:59:00.456+08:00';"]
        );
        assert_eq!(
            result.rollback_statements,
            vec!["INSERT INTO `dbx_tdengine_demo`.`meters` (`tbname`, `ts`, `voltage`) VALUES ('codex_delete_verify', '2026-07-10T13:59:00.456+08:00', 221.5);"]
        );
    }

    #[test]
    fn rejects_tdengine_composite_key_delete_from_same_timestamp_stable_rows() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Tdengine),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("dbx_tdengine_demo".to_string()),
                table_name: "meters".to_string(),
                primary_keys: vec![DBX_TDENGINE_TBNAME_COLUMN.to_string(), "ts".to_string(), "seq".to_string()],
                columns: Some(vec![
                    column("ts", "TIMESTAMP", false, None),
                    column("seq", "INT", false, Some("COMPOSITE KEY")),
                    column("voltage", "FLOAT", true, None),
                ]),
            },
            columns: vec![
                DBX_TDENGINE_TBNAME_COLUMN.to_string(),
                "ts".to_string(),
                "seq".to_string(),
                "voltage".to_string(),
            ],
            source_columns: None,
            rows: vec![
                vec![json!("device_a"), json!("2026-07-10T13:59:00.456+08:00"), json!(1), json!(221.5)],
                vec![json!("device_a"), json!("2026-07-10T13:59:00.456+08:00"), json!(2), json!(222.5)],
            ],
            dirty_rows: vec![],
            deleted_rows: vec![1],
            new_rows: vec![],
        });

        assert_eq!(
            result.validation_error,
            Some("TDengine tables with composite keys do not support row deletion.".to_string())
        );
        assert!(result.statements.is_empty());
        assert!(result.rollback_statements.is_empty());
    }

    #[test]
    fn prepares_tdengine_delete_from_direct_child_table_row() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Tdengine),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("dbx_tdengine_demo".to_string()),
                table_name: "codex_grid_accept_20260710".to_string(),
                primary_keys: vec!["ts".to_string()],
                columns: Some(vec![column("ts", "TIMESTAMP", false, None), column("voltage", "FLOAT", true, None)]),
            },
            columns: vec!["ts".to_string(), "voltage".to_string()],
            source_columns: None,
            rows: vec![vec![json!("2026-07-10T16:00:00.111+08:00"), json!(220.1)]],
            dirty_rows: vec![],
            deleted_rows: vec![0],
            new_rows: vec![],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(
            result.statements,
            vec!["DELETE FROM `dbx_tdengine_demo`.`codex_grid_accept_20260710` WHERE `ts` = '2026-07-10T16:00:00.111+08:00';"]
        );
        assert_eq!(
            result.rollback_statements,
            vec!["INSERT INTO `dbx_tdengine_demo`.`codex_grid_accept_20260710` (`ts`, `voltage`) VALUES ('2026-07-10T16:00:00.111+08:00', 220.1);"]
        );
    }

    #[test]
    fn prepares_tdengine_overwrite_for_direct_child_table_row() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Tdengine),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("dbx_tdengine_demo".to_string()),
                table_name: "codex_grid_update_verify_20260710".to_string(),
                primary_keys: vec!["ts".to_string()],
                columns: Some(vec![
                    column("ts", "TIMESTAMP", false, None),
                    column("voltage", "FLOAT", true, None),
                    column("current", "FLOAT", true, None),
                ]),
            },
            columns: vec!["ts".to_string(), "voltage".to_string(), "current".to_string()],
            source_columns: None,
            rows: vec![vec![json!("2026-07-10T16:30:00.444+08:00"), json!(220.0), json!(1.0)]],
            dirty_rows: vec![(0, vec![(1, json!(229.9))])],
            deleted_rows: vec![],
            new_rows: vec![],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(
            result.statements,
            vec!["INSERT INTO `dbx_tdengine_demo`.`codex_grid_update_verify_20260710` (`ts`, `voltage`, `current`) VALUES ('2026-07-10T16:30:00.444+08:00', 229.9, 1.0);"]
        );
        assert_eq!(
            result.rollback_statements,
            vec!["INSERT INTO `dbx_tdengine_demo`.`codex_grid_update_verify_20260710` (`ts`, `voltage`, `current`) VALUES ('2026-07-10T16:30:00.444+08:00', 220.0, 1.0);"]
        );
    }

    #[test]
    fn prepares_tdengine_composite_key_overwrite_and_rollback_for_same_timestamp_child_rows() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Tdengine),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("dbx_tdengine_demo".to_string()),
                table_name: "device_a".to_string(),
                primary_keys: vec!["ts".to_string(), "seq".to_string()],
                columns: Some(vec![
                    column("ts", "TIMESTAMP", false, None),
                    column("seq", "INT", false, Some("COMPOSITE KEY")),
                    column("voltage", "FLOAT", true, None),
                ]),
            },
            columns: vec!["ts".to_string(), "seq".to_string(), "voltage".to_string()],
            source_columns: None,
            rows: vec![
                vec![json!("2026-07-10T16:30:00.444+08:00"), json!(1), json!(220.0)],
                vec![json!("2026-07-10T16:30:00.444+08:00"), json!(2), json!(221.0)],
            ],
            dirty_rows: vec![(1, vec![(2, json!(229.9))])],
            deleted_rows: vec![],
            new_rows: vec![],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(
            result.statements,
            vec!["INSERT INTO `dbx_tdengine_demo`.`device_a` (`ts`, `seq`, `voltage`) VALUES ('2026-07-10T16:30:00.444+08:00', 2, 229.9);"]
        );
        assert_eq!(
            result.rollback_statements,
            vec!["INSERT INTO `dbx_tdengine_demo`.`device_a` (`ts`, `seq`, `voltage`) VALUES ('2026-07-10T16:30:00.444+08:00', 2, 221.0);"]
        );
    }

    #[test]
    fn prepares_tdengine_stable_insert_with_child_table_identity() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Tdengine),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("dbx_tdengine_demo".to_string()),
                table_name: "issue_3121_devices".to_string(),
                primary_keys: vec![DBX_TDENGINE_TBNAME_COLUMN.to_string(), "ts".to_string()],
                columns: Some(vec![
                    column("ts", "TIMESTAMP", false, None),
                    column("reading", "FLOAT", true, None),
                    column("site", "VARCHAR", true, Some("TAG")),
                ]),
            },
            columns: vec![
                DBX_TDENGINE_TBNAME_COLUMN.to_string(),
                "ts".to_string(),
                "reading".to_string(),
                "site".to_string(),
            ],
            source_columns: None,
            rows: vec![],
            dirty_rows: vec![],
            deleted_rows: vec![],
            new_rows: vec![vec![
                json!("codex_issue3121_insert_verify"),
                json!("2026-07-10T17:48:51.000+08:00"),
                json!(1.0),
                json!("codex-lab"),
            ]],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(
            result.statements,
            vec!["INSERT INTO `dbx_tdengine_demo`.`issue_3121_devices` (`tbname`, `ts`, `reading`, `site`) VALUES ('codex_issue3121_insert_verify', '2026-07-10T17:48:51.000+08:00', 1.0, 'codex-lab');"]
        );
        assert_eq!(
            result.rollback_statements,
            vec!["DELETE FROM `dbx_tdengine_demo`.`codex_issue3121_insert_verify` WHERE `ts` = '2026-07-10T17:48:51.000+08:00';"]
        );
    }

    #[test]
    fn skips_tdengine_composite_key_insert_rollback_for_same_timestamp_rows() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Tdengine),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("dbx_tdengine_demo".to_string()),
                table_name: "meters".to_string(),
                primary_keys: vec![DBX_TDENGINE_TBNAME_COLUMN.to_string(), "ts".to_string(), "seq".to_string()],
                columns: Some(vec![
                    column("ts", "TIMESTAMP", false, None),
                    column("seq", "INT", false, Some("COMPOSITE KEY")),
                    column("voltage", "FLOAT", true, None),
                ]),
            },
            columns: vec![
                DBX_TDENGINE_TBNAME_COLUMN.to_string(),
                "ts".to_string(),
                "seq".to_string(),
                "voltage".to_string(),
            ],
            source_columns: None,
            rows: vec![],
            dirty_rows: vec![],
            deleted_rows: vec![],
            new_rows: vec![
                vec![json!("device_a"), json!("2026-07-10T17:48:51.000+08:00"), json!(1), json!(221.0)],
                vec![json!("device_a"), json!("2026-07-10T17:48:51.000+08:00"), json!(2), json!(222.0)],
            ],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(
            result.statements,
            vec![
                "INSERT INTO `dbx_tdengine_demo`.`meters` (`tbname`, `ts`, `seq`, `voltage`) VALUES ('device_a', '2026-07-10T17:48:51.000+08:00', 1, 221.0);",
                "INSERT INTO `dbx_tdengine_demo`.`meters` (`tbname`, `ts`, `seq`, `voltage`) VALUES ('device_a', '2026-07-10T17:48:51.000+08:00', 2, 222.0);",
            ]
        );
        assert!(result.rollback_statements.is_empty());
    }

    #[test]
    fn rejects_tdengine_stable_insert_without_child_table_identity() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Tdengine),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("dbx_tdengine_demo".to_string()),
                table_name: "issue_3121_devices".to_string(),
                primary_keys: vec![DBX_TDENGINE_TBNAME_COLUMN.to_string(), "ts".to_string()],
                columns: Some(vec![column("ts", "TIMESTAMP", false, None), column("reading", "FLOAT", true, None)]),
            },
            columns: vec![DBX_TDENGINE_TBNAME_COLUMN.to_string(), "ts".to_string(), "reading".to_string()],
            source_columns: None,
            rows: vec![],
            dirty_rows: vec![],
            deleted_rows: vec![],
            new_rows: vec![vec![Value::Null, json!("2026-07-10T17:48:51.000+08:00"), json!(1.0)]],
        });

        assert_eq!(
            result.validation_error,
            Some("TDengine STABLE inserts require a child table name (tbname).".to_string())
        );
        assert!(result.statements.is_empty());
        assert!(result.rollback_statements.is_empty());
    }

    #[test]
    fn rejects_tdengine_delete_without_child_table_identity() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Tdengine),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("dbx_tdengine_demo".to_string()),
                table_name: "meters".to_string(),
                primary_keys: vec![DBX_TDENGINE_TBNAME_COLUMN.to_string(), "ts".to_string()],
                columns: Some(vec![column("ts", "TIMESTAMP", false, None)]),
            },
            columns: vec!["ts".to_string()],
            source_columns: None,
            rows: vec![vec![json!("2026-07-10T13:59:00.456+08:00")]],
            dirty_rows: vec![],
            deleted_rows: vec![0],
            new_rows: vec![],
        });

        assert_eq!(
            result.validation_error,
            Some("TDengine row editing requires all row identifier columns in the result.".to_string())
        );
        assert!(result.statements.is_empty());
    }

    #[test]
    fn rejects_tdengine_existing_row_edit_when_composite_key_is_missing() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Tdengine),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("dbx_tdengine_demo".to_string()),
                table_name: "device_a".to_string(),
                primary_keys: vec!["ts".to_string(), "seq".to_string()],
                columns: Some(vec![
                    column("ts", "TIMESTAMP", false, None),
                    column("seq", "INT", false, Some("COMPOSITE KEY")),
                    column("voltage", "FLOAT", true, None),
                ]),
            },
            columns: vec!["ts".to_string(), "voltage".to_string()],
            source_columns: None,
            rows: vec![vec![json!("2026-07-10T16:30:00.444+08:00"), json!(220.0)]],
            dirty_rows: vec![(0, vec![(1, json!(229.9))])],
            deleted_rows: vec![],
            new_rows: vec![],
        });

        assert_eq!(
            result.validation_error,
            Some("TDengine row editing requires all row identifier columns in the result.".to_string())
        );
        assert!(result.statements.is_empty());
        assert!(result.rollback_statements.is_empty());
    }

    #[test]
    fn rejects_tdengine_existing_row_identity_changes() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Tdengine),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("dbx_tdengine_demo".to_string()),
                table_name: "device_a".to_string(),
                primary_keys: vec!["ts".to_string(), "seq".to_string()],
                columns: Some(vec![
                    column("ts", "TIMESTAMP", false, None),
                    column("seq", "INT", false, Some("COMPOSITE KEY")),
                    column("voltage", "FLOAT", true, None),
                ]),
            },
            columns: vec!["ts".to_string(), "seq".to_string(), "voltage".to_string()],
            source_columns: None,
            rows: vec![vec![json!("2026-07-10T16:30:00.444+08:00"), json!(2), json!(220.0)]],
            dirty_rows: vec![(0, vec![(1, json!(3))])],
            deleted_rows: vec![],
            new_rows: vec![],
        });

        assert_eq!(result.validation_error, Some("TDengine row identifier columns cannot be edited.".to_string()));
        assert!(result.statements.is_empty());
        assert!(result.rollback_statements.is_empty());
    }

    #[test]
    fn prepares_databend_save_statements() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Databend),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
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
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
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
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
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
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
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
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
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
                catalog: None,
                database: None,
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
    fn doris_external_catalog_save_and_copy_statements_use_catalog_scope() {
        let table_meta = DataGridTableMeta {
            catalog: Some("iceberg_catalog".to_string()),
            database: None,
            schema: Some("sales".to_string()),
            table_name: "orders".to_string(),
            primary_keys: vec!["id".to_string()],
            columns: Some(vec![column("id", "bigint", false, None), column("status", "varchar", true, None)]),
        };

        let copy_updates = build_data_grid_copy_update_statements(DataGridCopyUpdateStatementOptions {
            database_type: Some(DatabaseType::Doris),
            table_meta: table_meta.clone(),
            columns: vec!["id".to_string(), "status".to_string()],
            source_columns: None,
            rows: vec![vec![json!(1), json!("paid")]],
        });
        assert_eq!(
            copy_updates,
            vec!["UPDATE `iceberg_catalog`.`sales`.`orders` SET `status` = 'paid' WHERE `id` = 1;"]
        );

        let copy_insert = build_data_grid_copy_insert_statement(DataGridCopyInsertStatementOptions {
            database_type: Some(DatabaseType::Doris),
            table_meta: Some(table_meta.clone()),
            columns: vec!["id".to_string(), "status".to_string()],
            column_types: None,
            source_columns: None,
            rows: vec![vec![json!(2), json!("new")]],
            exclude_primary_keys: false,
            insert_mode: DataGridCopyInsertMode::Merged,
        });
        assert_eq!(
            copy_insert.as_deref(),
            Some("INSERT INTO `iceberg_catalog`.`sales`.`orders` (`id`, `status`) VALUES (2, 'new');")
        );

        let save = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Doris),
            identifier_quote: None,
            table_meta,
            columns: vec!["id".to_string(), "status".to_string()],
            source_columns: None,
            rows: vec![vec![json!(1), json!("pending")], vec![json!(3), json!("cancelled")]],
            dirty_rows: vec![(0, vec![(1, json!("paid"))])],
            deleted_rows: vec![1],
            new_rows: vec![vec![json!(4), json!("new")]],
        });
        assert_eq!(
            save.statements,
            vec![
                "UPDATE `iceberg_catalog`.`sales`.`orders` SET `status` = 'paid' WHERE `id` = 1;",
                "DELETE FROM `iceberg_catalog`.`sales`.`orders` WHERE `id` = 3;",
                "INSERT INTO `iceberg_catalog`.`sales`.`orders` (`id`, `status`) VALUES (4, 'new');",
            ]
        );
        assert!(save.validation_error.is_none());
    }

    #[test]
    fn prepares_databend_keyless_save_statements_with_row_predicate() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Databend),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
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
    fn prepares_oscar_keyless_save_statements_with_schema_qualified_row_predicate() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Oscar),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("SYSDBA".to_string()),
                table_name: "PEOPLE".to_string(),
                primary_keys: vec![],
                columns: Some(vec![column("ID", "INTEGER", true, None), column("NAME", "VARCHAR", true, None)]),
            },
            columns: vec!["ID".to_string(), "NAME".to_string()],
            source_columns: None,
            rows: vec![vec![json!(1), json!("Ada")]],
            dirty_rows: vec![(0, vec![(1, json!("Linus"))])],
            deleted_rows: vec![0],
            new_rows: vec![],
        });

        assert_eq!(
            result.statements,
            vec![
                "UPDATE \"SYSDBA\".\"PEOPLE\" SET \"NAME\" = 'Linus' WHERE \"ID\" = 1 AND \"NAME\" = 'Ada';",
                "DELETE FROM \"SYSDBA\".\"PEOPLE\" WHERE \"ID\" = 1 AND \"NAME\" = 'Ada';",
            ]
        );
    }

    #[test]
    fn skips_expression_only_source_columns() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Postgres),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
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
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
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
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
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
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
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
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
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
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
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
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
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
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
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
    fn prepare_data_grid_save_omits_empty_mysql_auto_increment_value() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Mysql),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("app".to_string()),
                table_name: "users".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: Some(vec![
                    pk_column("id", "BIGINT", false, Some("auto_increment")),
                    column("name", "VARCHAR", false, None),
                ]),
            },
            columns: vec!["id".to_string(), "name".to_string()],
            source_columns: None,
            rows: vec![],
            dirty_rows: vec![],
            deleted_rows: vec![],
            new_rows: vec![vec![json!(""), json!("Ada")]],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(result.statements, vec!["INSERT INTO `app`.`users` (`name`) VALUES ('Ada');"]);
    }

    #[test]
    fn prepare_data_grid_save_omits_mysql_not_null_column_for_before_insert_trigger() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Mysql),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("app".to_string()),
                table_name: "events".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: Some(vec![
                    pk_column("id", "BIGINT", false, Some("auto_increment")),
                    column("trigger_value", "VARCHAR(64)", false, None),
                    column("payload", "VARCHAR(64)", false, None),
                ]),
            },
            columns: vec!["id".to_string(), "trigger_value".to_string(), "payload".to_string()],
            source_columns: None,
            rows: vec![],
            dirty_rows: vec![],
            deleted_rows: vec![],
            new_rows: vec![vec![Value::Null, Value::Null, json!("created")]],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(result.statements, vec!["INSERT INTO `app`.`events` (`payload`) VALUES ('created');"]);
        assert!(result.rollback_statements.is_empty());
    }

    #[test]
    fn prepare_data_grid_save_uses_mysql_default_row_insert_for_trigger_only_rows() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Mysql),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("app".to_string()),
                table_name: "trigger_only".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: Some(vec![
                    pk_column("id", "BIGINT", false, Some("auto_increment")),
                    column("required_value", "VARCHAR(64)", false, None),
                ]),
            },
            columns: vec!["id".to_string(), "required_value".to_string()],
            source_columns: None,
            rows: vec![],
            dirty_rows: vec![],
            deleted_rows: vec![],
            new_rows: vec![vec![Value::Null, Value::Null]],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(result.statements, vec!["INSERT INTO `app`.`trigger_only` () VALUES ();"]);
        assert!(result.rollback_statements.is_empty());
    }

    #[test]
    fn prepare_data_grid_save_uses_known_mysql_primary_key_for_trigger_rollback() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Mysql),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("app".to_string()),
                table_name: "events".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: Some(vec![
                    pk_column("id", "BIGINT", false, None),
                    column("trigger_value", "VARCHAR(64)", false, None),
                    column("payload", "VARCHAR(64)", false, None),
                ]),
            },
            columns: vec!["id".to_string(), "trigger_value".to_string(), "payload".to_string()],
            source_columns: None,
            rows: vec![],
            dirty_rows: vec![],
            deleted_rows: vec![],
            new_rows: vec![vec![json!(7), Value::Null, json!("created")]],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(result.statements, vec!["INSERT INTO `app`.`events` (`id`, `payload`) VALUES (7, 'created');"]);
        assert_eq!(result.rollback_statements, vec!["DELETE FROM `app`.`events` WHERE `id` = 7;"]);
    }

    #[test]
    fn prepare_data_grid_save_still_rejects_mysql_null_update() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Mysql),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("app".to_string()),
                table_name: "events".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: Some(vec![
                    pk_column("id", "BIGINT", false, Some("auto_increment")),
                    column("trigger_value", "VARCHAR(64)", false, None),
                ]),
            },
            columns: vec!["id".to_string(), "trigger_value".to_string()],
            source_columns: None,
            rows: vec![vec![json!(1), json!("existing")]],
            dirty_rows: vec![(0, vec![(1, Value::Null)])],
            deleted_rows: vec![],
            new_rows: vec![],
        });

        assert_eq!(result.validation_error, Some(r#"Column "trigger_value" does not allow NULL."#.to_string()));
        assert!(result.statements.is_empty());
    }

    #[test]
    fn prepare_data_grid_save_omits_empty_kingbase_sqlserver_identity_value() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Kingbase),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("dbo".to_string()),
                table_name: "orders".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: Some(vec![
                    pk_column("id", "int", false, Some("identity(1,1)")),
                    column("name", "varchar", false, None),
                ]),
            },
            columns: vec!["id".to_string(), "name".to_string()],
            source_columns: None,
            rows: vec![],
            dirty_rows: vec![],
            deleted_rows: vec![],
            new_rows: vec![vec![Value::Null, json!("Ada")]],
        });

        assert_eq!(result.validation_error, None);
        assert_eq!(result.statements, vec![r#"INSERT INTO "dbo"."orders" ("name") VALUES ('Ada');"#]);
    }

    #[test]
    fn prepare_data_grid_save_still_validates_other_not_null_columns_in_sqlite() {
        let result = prepare_data_grid_save(DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Sqlite),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
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
