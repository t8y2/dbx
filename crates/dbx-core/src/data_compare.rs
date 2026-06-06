use std::collections::{HashMap, HashSet};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::connection::AppState;
use crate::data_grid_sql::{format_grid_sql_literal as format_data_grid_sql_literal, DataGridColumnInfo};
use crate::models::connection::DatabaseType;
use crate::query::{execute_sql_statement_with_options, QueryExecutionOptions};
use crate::schema::get_columns_core;
use crate::sql_dialect::{build_count_table_sql, qualified_table_name, quote_table_identifier, uses_fetch_first};
use crate::transfer::{generate_comment_ddl, generate_create_table_ddl};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareDataRowsOptions {
    pub columns: Vec<String>,
    pub key_columns: Vec<String>,
    #[serde(default)]
    pub source_rows: Vec<Vec<Value>>,
    #[serde(default)]
    pub target_rows: Vec<Vec<Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataComparePreparationOptions {
    pub table_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub columns: Vec<String>,
    pub key_columns: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub column_info: Vec<DataGridColumnInfo>,
    #[serde(default)]
    pub source_rows: Vec<Vec<Value>>,
    #[serde(default)]
    pub target_rows: Vec<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataCompareFromTablesOptions {
    pub source_connection_id: String,
    pub source_database: String,
    pub source_schema: String,
    pub source_table: String,
    pub target_connection_id: String,
    pub target_database: String,
    pub target_schema: String,
    pub target_table: String,
    pub columns: Vec<String>,
    pub key_columns: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fetch_batch_size: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataCompareMissingTargetOptions {
    pub source_connection_id: String,
    pub source_database: String,
    pub source_schema: String,
    pub source_table: String,
    pub target_connection_id: String,
    pub target_database: String,
    pub target_schema: String,
    pub target_table: String,
    #[serde(default)]
    pub key_columns: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fetch_batch_size: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataCompareChangedCell {
    pub column: String,
    pub source: Value,
    pub target: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataCompareRow {
    pub key: String,
    pub key_values: HashMap<String, Value>,
    pub values: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataCompareModifiedRow {
    pub key: String,
    pub key_values: HashMap<String, Value>,
    pub source_values: HashMap<String, Value>,
    pub target_values: HashMap<String, Value>,
    pub changes: Vec<DataCompareChangedCell>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataCompareResult {
    pub added: Vec<DataCompareRow>,
    pub removed: Vec<DataCompareRow>,
    pub modified: Vec<DataCompareModifiedRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataComparePreparation {
    pub result: DataCompareResult,
    pub sync_statements: Vec<String>,
    pub sync_sql: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataCompareSyncPlanTableOptions {
    pub table_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub columns: Vec<String>,
    pub key_columns: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub column_info: Vec<DataGridColumnInfo>,
    pub diff: DataCompareResult,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pre_sync_statements: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataCompareSyncPlanOptions {
    #[serde(default)]
    pub tables: Vec<DataCompareSyncPlanTableOptions>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataCompareSyncPlan {
    pub insert_count: usize,
    pub update_count: usize,
    pub delete_count: usize,
    pub statement_count: usize,
    pub sync_statements: Vec<String>,
    pub sync_sql: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataCompareFromTablesPreparation {
    pub result: DataCompareResult,
    pub sync_statements: Vec<String>,
    pub sync_sql: String,
    #[serde(default)]
    pub pre_sync_statements: Vec<String>,
    pub source_row_count: u64,
    pub target_row_count: u64,
    pub source_truncated: bool,
    pub target_truncated: bool,
}

pub fn prepare_data_compare(options: DataComparePreparationOptions) -> Result<DataComparePreparation, String> {
    let result = compare_data_rows(CompareDataRowsOptions {
        columns: options.columns.clone(),
        key_columns: options.key_columns.clone(),
        source_rows: options.source_rows,
        target_rows: options.target_rows,
    })?;
    let sync_plan = build_data_compare_sync_plan(DataCompareSyncPlanOptions {
        tables: vec![DataCompareSyncPlanTableOptions {
            table_name: options.table_name,
            schema: options.schema,
            columns: options.columns,
            key_columns: options.key_columns,
            column_info: options.column_info,
            diff: result.clone(),
            database_type: options.database_type,
            pre_sync_statements: Vec::new(),
        }],
    });
    Ok(DataComparePreparation { result, sync_statements: sync_plan.sync_statements, sync_sql: sync_plan.sync_sql })
}

pub async fn prepare_data_compare_from_tables(
    state: &AppState,
    options: DataCompareFromTablesOptions,
) -> Result<DataCompareFromTablesPreparation, String> {
    let source_database_type = connection_database_type(state, &options.source_connection_id).await?;
    let target_database_type = connection_database_type(state, &options.target_connection_id).await?;
    let fetch_batch_size = options.fetch_batch_size.unwrap_or(1000).max(1);

    let source_count_sql =
        build_count_table_sql(Some(source_database_type), Some(&options.source_schema), &options.source_table);
    let target_count_sql =
        build_count_table_sql(Some(target_database_type), Some(&options.target_schema), &options.target_table);

    let (source_count_result, target_count_result) = tokio::try_join!(
        execute_sql_statement_with_options(
            state,
            &options.source_connection_id,
            &options.source_database,
            &source_count_sql,
            Some(&options.source_schema),
            None,
            QueryExecutionOptions { max_rows: Some(1), ..Default::default() },
        ),
        execute_sql_statement_with_options(
            state,
            &options.target_connection_id,
            &options.target_database,
            &target_count_sql,
            Some(&options.target_schema),
            None,
            QueryExecutionOptions { max_rows: Some(1), ..Default::default() },
        )
    )?;
    let source_row_count = first_count(&source_count_result.rows)?;
    let target_row_count = first_count(&target_count_result.rows)?;

    let (source_rows, target_rows) = tokio::try_join!(
        fetch_compare_rows(
            state,
            &options.source_connection_id,
            &options.source_database,
            &options.source_schema,
            &options.source_table,
            &options.columns,
            &options.key_columns,
            source_database_type,
            fetch_batch_size,
        ),
        fetch_compare_rows(
            state,
            &options.target_connection_id,
            &options.target_database,
            &options.target_schema,
            &options.target_table,
            &options.columns,
            &options.key_columns,
            target_database_type,
            fetch_batch_size,
        )
    )?;
    let target_columns = get_columns_core(
        state,
        &options.target_connection_id,
        &options.target_database,
        &options.target_schema,
        &options.target_table,
    )
    .await?;

    let preparation = prepare_data_compare(DataComparePreparationOptions {
        table_name: options.target_table,
        schema: Some(options.target_schema),
        columns: options.columns,
        key_columns: options.key_columns,
        column_info: target_columns.into_iter().map(data_grid_column_info).collect(),
        source_rows,
        target_rows,
        database_type: Some(target_database_type),
    })?;

    Ok(DataCompareFromTablesPreparation {
        result: preparation.result,
        sync_statements: preparation.sync_statements,
        sync_sql: preparation.sync_sql,
        pre_sync_statements: Vec::new(),
        source_row_count,
        target_row_count,
        source_truncated: false,
        target_truncated: false,
    })
}

pub async fn prepare_data_compare_missing_target(
    state: &AppState,
    options: DataCompareMissingTargetOptions,
) -> Result<DataCompareFromTablesPreparation, String> {
    let source_database_type = connection_database_type(state, &options.source_connection_id).await?;
    let target_database_type = connection_database_type(state, &options.target_connection_id).await?;
    let fetch_batch_size = options.fetch_batch_size.unwrap_or(1000).max(1);
    let source_columns = get_columns_core(
        state,
        &options.source_connection_id,
        &options.source_database,
        &options.source_schema,
        &options.source_table,
    )
    .await?;
    let column_names = source_columns.iter().map(|column| column.name.clone()).collect::<Vec<_>>();

    let source_count_sql =
        build_count_table_sql(Some(source_database_type), Some(&options.source_schema), &options.source_table);
    let source_count_result = execute_sql_statement_with_options(
        state,
        &options.source_connection_id,
        &options.source_database,
        &source_count_sql,
        Some(&options.source_schema),
        None,
        QueryExecutionOptions { max_rows: Some(1), ..Default::default() },
    )
    .await?;
    let source_row_count = first_count(&source_count_result.rows)?;
    let source_rows = fetch_compare_rows(
        state,
        &options.source_connection_id,
        &options.source_database,
        &options.source_schema,
        &options.source_table,
        &column_names,
        &options.key_columns,
        source_database_type,
        fetch_batch_size,
    )
    .await?;
    let result = missing_target_diff(&column_names, &options.key_columns, source_rows);
    let mut pre_sync_statements = Vec::new();
    pre_sync_statements.push(format!(
        "{};",
        generate_create_table_ddl(
            &source_columns,
            &options.target_table,
            &options.source_schema,
            &options.target_schema,
            &target_database_type,
            &source_database_type,
            None,
        )
    ));
    pre_sync_statements.extend(
        generate_comment_ddl(
            &source_columns,
            &options.target_table,
            &options.target_schema,
            &target_database_type,
            None,
        )
        .into_iter()
        .map(|statement| format!("{statement};")),
    );

    let sync_plan = build_data_compare_sync_plan(DataCompareSyncPlanOptions {
        tables: vec![DataCompareSyncPlanTableOptions {
            table_name: options.target_table,
            schema: Some(options.target_schema),
            columns: column_names,
            key_columns: options.key_columns,
            column_info: source_columns.iter().cloned().map(data_grid_column_info).collect(),
            diff: result.clone(),
            database_type: Some(target_database_type),
            pre_sync_statements: pre_sync_statements.clone(),
        }],
    });

    Ok(DataCompareFromTablesPreparation {
        result,
        sync_statements: sync_plan.sync_statements,
        sync_sql: sync_plan.sync_sql,
        pre_sync_statements,
        source_row_count,
        target_row_count: 0,
        source_truncated: false,
        target_truncated: false,
    })
}

pub fn build_data_compare_sync_plan(options: DataCompareSyncPlanOptions) -> DataCompareSyncPlan {
    let mut sync_statements = Vec::new();
    let mut insert_count = 0;
    let mut update_count = 0;
    let mut delete_count = 0;

    for table in options.tables {
        insert_count += table.diff.added.len();
        update_count += table.diff.modified.len();
        delete_count += table.diff.removed.len();
        sync_statements.extend(table.pre_sync_statements);
        sync_statements.extend(generate_data_sync_statements(&GenerateDataSyncSqlOptions {
            table_name: table.table_name,
            schema: table.schema,
            columns: table.columns,
            key_columns: table.key_columns,
            column_info: table.column_info,
            diff: table.diff,
            database_type: table.database_type,
        }));
    }

    let statement_count = sync_statements.len();
    let sync_sql = sync_statements.join("\n");
    DataCompareSyncPlan { insert_count, update_count, delete_count, statement_count, sync_statements, sync_sql }
}

fn missing_target_diff(columns: &[String], key_columns: &[String], source_rows: Vec<Vec<Value>>) -> DataCompareResult {
    let added = source_rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let values = row_object(columns, row);
            let key = if key_columns.is_empty() { index.to_string() } else { key_for(&values, key_columns) };
            DataCompareRow { key, key_values: key_values(&values, key_columns), values }
        })
        .collect();

    DataCompareResult { added, removed: Vec::new(), modified: Vec::new() }
}

pub fn compare_data_rows(options: CompareDataRowsOptions) -> Result<DataCompareResult, String> {
    if options.key_columns.is_empty() {
        return Err("At least one key column is required for data comparison".to_string());
    }

    let source_rows = parallel_compare_rows(&options.columns, &options.key_columns, &options.source_rows);
    let target_rows = parallel_compare_rows(&options.columns, &options.key_columns, &options.target_rows);
    let (source, source_order) = collect_compare_rows(source_rows, "source")?;
    let (target, target_order) = collect_compare_rows(target_rows, "target")?;
    let key_columns: HashSet<&str> = options.key_columns.iter().map(String::as_str).collect();

    let source_diffs = source_order
        .par_iter()
        .map(|key| {
            let source_values = source.get(key).expect("source key should exist");
            let Some(target_values) = target.get(key) else {
                return Some(SourceDiff::Added(DataCompareRow {
                    key: key.clone(),
                    key_values: key_values(source_values, &options.key_columns),
                    values: source_values.clone(),
                }));
            };

            let changes: Vec<DataCompareChangedCell> = options
                .columns
                .iter()
                .filter(|column| !key_columns.contains(column.as_str()))
                .filter(|column| value_for(source_values, column) != value_for(target_values, column))
                .map(|column| DataCompareChangedCell {
                    column: column.clone(),
                    source: value_for(source_values, column),
                    target: value_for(target_values, column),
                })
                .collect();

            if changes.is_empty() {
                None
            } else {
                Some(SourceDiff::Modified(DataCompareModifiedRow {
                    key: key.clone(),
                    key_values: key_values(source_values, &options.key_columns),
                    source_values: source_values.clone(),
                    target_values: target_values.clone(),
                    changes,
                }))
            }
        })
        .collect::<Vec<_>>();

    let mut added = Vec::new();
    let mut modified = Vec::new();
    for diff in source_diffs.into_iter().flatten() {
        match diff {
            SourceDiff::Added(row) => added.push(row),
            SourceDiff::Modified(row) => modified.push(row),
        }
    }

    let removed = target_order
        .par_iter()
        .map(|key| {
            target.get(key).filter(|_| !source.contains_key(key)).map(|target_values| DataCompareRow {
                key: key.clone(),
                key_values: key_values(target_values, &options.key_columns),
                values: target_values.clone(),
            })
        })
        .collect::<Vec<_>>()
        .into_iter()
        .flatten()
        .collect();

    Ok(DataCompareResult { added, removed, modified })
}

#[derive(Debug)]
struct CompareRow {
    key: String,
    values: HashMap<String, Value>,
}

#[derive(Debug)]
enum SourceDiff {
    Added(DataCompareRow),
    Modified(DataCompareModifiedRow),
}

type CompareRowValues = HashMap<String, Value>;
type CompareRowMap = HashMap<String, CompareRowValues>;

fn parallel_compare_rows(columns: &[String], key_columns: &[String], rows: &[Vec<Value>]) -> Vec<CompareRow> {
    rows.par_iter()
        .map(|row| {
            let values = row_object(columns, row);
            let key = key_for(&values, key_columns);
            CompareRow { key, values }
        })
        .collect()
}

fn collect_compare_rows(rows: Vec<CompareRow>, label: &str) -> Result<(CompareRowMap, Vec<String>), String> {
    let mut items = HashMap::with_capacity(rows.len());
    let mut order = Vec::with_capacity(rows.len());

    for row in rows {
        if items.contains_key(&row.key) {
            return Err(format!("Duplicate {label} key: {}", row.key));
        }
        order.push(row.key.clone());
        items.insert(row.key, row.values);
    }

    Ok((items, order))
}

#[derive(Debug, Clone)]
struct GenerateDataSyncSqlOptions {
    table_name: String,
    schema: Option<String>,
    columns: Vec<String>,
    key_columns: Vec<String>,
    column_info: Vec<DataGridColumnInfo>,
    diff: DataCompareResult,
    database_type: Option<DatabaseType>,
}

fn row_object(columns: &[String], row: &[Value]) -> HashMap<String, Value> {
    columns
        .iter()
        .enumerate()
        .map(|(index, column)| (column.clone(), row.get(index).cloned().unwrap_or(Value::Null)))
        .collect()
}

fn key_for(row: &HashMap<String, Value>, key_columns: &[String]) -> String {
    key_columns.iter().map(|column| json_stringify(&value_for(row, column))).collect::<Vec<_>>().join("\u{001f}")
}

fn key_values(row: &HashMap<String, Value>, key_columns: &[String]) -> HashMap<String, Value> {
    key_columns.iter().map(|column| (column.clone(), value_for(row, column))).collect()
}

fn value_for(row: &HashMap<String, Value>, column: &str) -> Value {
    row.get(column).cloned().unwrap_or(Value::Null)
}

fn json_stringify(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

fn generate_data_sync_statements(options: &GenerateDataSyncSqlOptions) -> Vec<String> {
    let table = qualified_table_name(options.database_type, options.schema.as_deref(), &options.table_name);
    let columns = options
        .columns
        .iter()
        .map(|column| quote_table_identifier(options.database_type, column))
        .collect::<Vec<_>>()
        .join(", ");
    let column_info = options.column_info.as_slice();
    let added = options
        .diff
        .added
        .par_iter()
        .map(|row| {
            let values = options
                .columns
                .iter()
                .map(|column| {
                    format_grid_sql_literal(
                        row.values.get(column).unwrap_or(&Value::Null),
                        options.database_type,
                        column_info_for(column_info, column),
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!("INSERT INTO {table} ({columns}) VALUES ({values});")
        })
        .collect::<Vec<_>>();
    let modified = options
        .diff
        .modified
        .par_iter()
        .map(|row| {
            let assignments = row
                .changes
                .iter()
                .map(|change| {
                    format!(
                        "{} = {}",
                        quote_table_identifier(options.database_type, &change.column),
                        format_grid_sql_literal(
                            &change.source,
                            options.database_type,
                            column_info_for(column_info, &change.column),
                        )
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "UPDATE {table} SET {assignments} WHERE {};",
                where_by_key(&row.key_values, &options.key_columns, options.database_type, column_info)
            )
        })
        .collect::<Vec<_>>();
    let removed = options
        .diff
        .removed
        .par_iter()
        .map(|row| {
            format!(
                "DELETE FROM {table} WHERE {};",
                where_by_key(&row.key_values, &options.key_columns, options.database_type, column_info)
            )
        })
        .collect::<Vec<_>>();

    let mut statements = Vec::with_capacity(added.len() + modified.len() + removed.len());
    statements.extend(added);
    statements.extend(modified);
    statements.extend(removed);
    statements
}

async fn connection_database_type(state: &AppState, connection_id: &str) -> Result<DatabaseType, String> {
    state
        .configs
        .read()
        .await
        .get(connection_id)
        .map(|config| config.db_type)
        .ok_or_else(|| format!("Connection config not found: {connection_id}"))
}

fn first_count(rows: &[Vec<Value>]) -> Result<u64, String> {
    let value = rows.first().and_then(|row| row.first()).ok_or_else(|| "COUNT query returned no rows".to_string())?;
    match value {
        Value::Number(number) => {
            number.as_u64().or_else(|| number.as_i64().and_then(|value| u64::try_from(value).ok()))
        }
        Value::String(text) => text.parse::<u64>().ok(),
        _ => None,
    }
    .ok_or_else(|| format!("COUNT query returned non-numeric value: {value}"))
}

fn build_data_compare_select_sql(
    database_type: DatabaseType,
    schema: &str,
    table_name: &str,
    columns: &[String],
    key_columns: &[String],
    row_limit: usize,
    offset: usize,
) -> String {
    let table = qualified_table_name(Some(database_type), Some(schema), table_name);
    let select_columns = if columns.is_empty() {
        "*".to_string()
    } else {
        columns.iter().map(|column| quote_table_identifier(Some(database_type), column)).collect::<Vec<_>>().join(", ")
    };
    let order_by = if key_columns.is_empty() {
        String::new()
    } else {
        format!(
            " ORDER BY {}",
            key_columns
                .iter()
                .map(|column| format!("{} ASC", quote_table_identifier(Some(database_type), column)))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    let order_expression = if key_columns.is_empty() {
        "(SELECT NULL)".to_string()
    } else {
        key_columns
            .iter()
            .map(|column| format!("{} ASC", quote_table_identifier(Some(database_type), column)))
            .collect::<Vec<_>>()
            .join(", ")
    };

    if uses_fetch_first(database_type) {
        let offset_sql = if offset > 0 { format!(" OFFSET {offset} ROWS") } else { String::new() };
        return format!("SELECT {select_columns} FROM {table}{order_by}{offset_sql} FETCH FIRST {row_limit} ROWS ONLY");
    }

    if database_type == DatabaseType::SqlServer {
        if offset == 0 {
            return format!("SELECT TOP ({row_limit}) {select_columns} FROM {table}{order_by}");
        }
        let page_alias = quote_table_identifier(Some(DatabaseType::SqlServer), "dbx_page");
        let row_number_alias = quote_table_identifier(Some(DatabaseType::SqlServer), "__dbx_row_num");
        let end = offset + row_limit;
        return format!(
            "WITH {page_alias} AS (SELECT {select_columns}, ROW_NUMBER() OVER (ORDER BY {order_expression}) AS {row_number_alias} FROM {table}) SELECT {select_columns} FROM {page_alias} WHERE {row_number_alias} > {offset} AND {row_number_alias} <= {end} ORDER BY {row_number_alias}"
        );
    }

    let offset_sql = if offset > 0 { format!(" OFFSET {offset}") } else { String::new() };
    format!("SELECT {select_columns} FROM {table}{order_by} LIMIT {row_limit}{offset_sql};")
}

#[allow(clippy::too_many_arguments)]
async fn fetch_compare_rows(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table_name: &str,
    columns: &[String],
    key_columns: &[String],
    database_type: DatabaseType,
    fetch_batch_size: usize,
) -> Result<Vec<Vec<Value>>, String> {
    let mut rows = Vec::new();
    let mut offset = 0usize;

    loop {
        let sql = build_data_compare_select_sql(
            database_type,
            schema,
            table_name,
            columns,
            key_columns,
            fetch_batch_size,
            offset,
        );
        let result = execute_sql_statement_with_options(
            state,
            connection_id,
            database,
            &sql,
            Some(schema),
            None,
            QueryExecutionOptions { max_rows: Some(fetch_batch_size), ..Default::default() },
        )
        .await?;
        let fetched = result.rows.len();
        if fetched == 0 {
            break;
        }
        rows.extend(result.rows);
        if fetched < fetch_batch_size {
            break;
        }
        offset += fetched;
    }

    Ok(rows)
}

fn where_by_key(
    key_values: &HashMap<String, Value>,
    key_columns: &[String],
    database_type: Option<DatabaseType>,
    column_info: &[DataGridColumnInfo],
) -> String {
    key_columns
        .iter()
        .map(|column| {
            format!(
                "{} = {}",
                quote_table_identifier(database_type, column),
                format_grid_sql_literal(
                    key_values.get(column).unwrap_or(&Value::Null),
                    database_type,
                    column_info_for(column_info, column),
                )
            )
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn format_grid_sql_literal(
    value: &Value,
    database_type: Option<DatabaseType>,
    column_info: Option<&DataGridColumnInfo>,
) -> String {
    format_data_grid_sql_literal(value, database_type, column_info)
}

fn column_info_for<'a>(columns: &'a [DataGridColumnInfo], name: &str) -> Option<&'a DataGridColumnInfo> {
    let normalized = name.to_ascii_lowercase();
    columns.iter().find(|column| column.name.to_ascii_lowercase() == normalized)
}

fn data_grid_column_info(column: crate::types::ColumnInfo) -> DataGridColumnInfo {
    DataGridColumnInfo {
        name: column.name,
        data_type: column.data_type,
        is_nullable: column.is_nullable,
        is_primary_key: column.is_primary_key,
        column_default: column.column_default,
        extra: column.extra,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::connection::DatabaseType;
    use serde_json::json;

    fn data_compare_column(name: &str, data_type: &str) -> DataGridColumnInfo {
        DataGridColumnInfo {
            name: name.to_string(),
            data_type: data_type.to_string(),
            is_nullable: true,
            is_primary_key: false,
            column_default: None,
            extra: None,
        }
    }

    #[test]
    fn compares_rows_by_primary_key_and_reports_added_removed_and_modified_rows() {
        let diff = compare_data_rows(CompareDataRowsOptions {
            columns: vec!["id".to_string(), "name".to_string(), "active".to_string()],
            key_columns: vec!["id".to_string()],
            source_rows: vec![
                vec![json!(1), json!("Ada"), json!(true)],
                vec![json!(2), json!("Bob"), json!(false)],
                vec![json!(4), json!("Dora"), json!(true)],
            ],
            target_rows: vec![
                vec![json!(1), json!("Ada"), json!(true)],
                vec![json!(2), json!("Bobby"), json!(false)],
                vec![json!(3), json!("Cara"), json!(true)],
            ],
        })
        .expect("data comparison should succeed");

        assert_eq!(
            diff.added.iter().map(|row| row.key_values.get("id").cloned()).collect::<Vec<_>>(),
            vec![Some(json!(4))]
        );
        assert_eq!(
            diff.removed.iter().map(|row| row.key_values.get("id").cloned()).collect::<Vec<_>>(),
            vec![Some(json!(3))]
        );
        assert_eq!(diff.modified[0].changes[0].column, "name");
        assert_eq!(diff.modified[0].changes[0].source, json!("Bob"));
        assert_eq!(diff.modified[0].changes[0].target, json!("Bobby"));
    }

    #[test]
    fn generates_data_synchronization_sql() {
        let preparation = prepare_data_compare(DataComparePreparationOptions {
            table_name: "users".to_string(),
            schema: Some("public".to_string()),
            columns: vec!["id".to_string(), "name".to_string(), "active".to_string()],
            key_columns: vec!["id".to_string()],
            column_info: Vec::new(),
            source_rows: vec![vec![json!(1), json!("Ada"), json!(true)], vec![json!(2), json!("Bob"), json!(false)]],
            target_rows: vec![
                vec![json!(1), json!("Ada Lovelace"), json!(true)],
                vec![json!(3), json!("Cara"), json!(true)],
            ],
            database_type: Some(DatabaseType::Postgres),
        })
        .expect("data compare preparation should succeed");

        assert_eq!(
            preparation.sync_sql,
            [
                "INSERT INTO \"public\".\"users\" (\"id\", \"name\", \"active\") VALUES (2, 'Bob', FALSE);",
                "UPDATE \"public\".\"users\" SET \"name\" = 'Ada' WHERE \"id\" = 1;",
                "DELETE FROM \"public\".\"users\" WHERE \"id\" = 3;",
            ]
            .join("\n")
        );
        assert_eq!(preparation.sync_statements.len(), 3);
    }

    #[test]
    fn generates_mysql_bit_synchronization_literals_without_string_quotes() {
        let preparation = prepare_data_compare(DataComparePreparationOptions {
            table_name: "users".to_string(),
            schema: None,
            columns: vec!["id".to_string(), "enabled".to_string(), "flags".to_string()],
            key_columns: vec!["id".to_string()],
            column_info: vec![
                data_compare_column("id", "int"),
                data_compare_column("enabled", "bit(1)"),
                data_compare_column("flags", "bit(8)"),
            ],
            source_rows: vec![vec![json!(1), json!("0"), json!("10101010")]],
            target_rows: vec![vec![json!(1), json!("1"), json!("00000001")]],
            database_type: Some(DatabaseType::Mysql),
        })
        .expect("data compare preparation should succeed");

        assert_eq!(preparation.sync_sql, "UPDATE `users` SET `enabled` = 0, `flags` = b'10101010' WHERE `id` = 1;");
    }

    #[test]
    fn builds_batch_sync_plan_from_selected_diffs() {
        let plan = build_data_compare_sync_plan(DataCompareSyncPlanOptions {
            tables: vec![DataCompareSyncPlanTableOptions {
                table_name: "users".to_string(),
                schema: Some("public".to_string()),
                columns: vec!["id".to_string(), "name".to_string()],
                key_columns: vec!["id".to_string()],
                column_info: Vec::new(),
                diff: DataCompareResult {
                    added: vec![DataCompareRow {
                        key: "1".to_string(),
                        key_values: HashMap::from([(String::from("id"), json!(1))]),
                        values: HashMap::from([(String::from("id"), json!(1)), (String::from("name"), json!("Ada"))]),
                    }],
                    removed: Vec::new(),
                    modified: vec![DataCompareModifiedRow {
                        key: "2".to_string(),
                        key_values: HashMap::from([(String::from("id"), json!(2))]),
                        source_values: HashMap::from([
                            (String::from("id"), json!(2)),
                            (String::from("name"), json!("Bob")),
                        ]),
                        target_values: HashMap::from([
                            (String::from("id"), json!(2)),
                            (String::from("name"), json!("Bobby")),
                        ]),
                        changes: vec![DataCompareChangedCell {
                            column: "name".to_string(),
                            source: json!("Bob"),
                            target: json!("Bobby"),
                        }],
                    }],
                },
                database_type: Some(DatabaseType::Postgres),
                pre_sync_statements: Vec::new(),
            }],
        });

        assert_eq!(plan.insert_count, 1);
        assert_eq!(plan.update_count, 1);
        assert_eq!(plan.delete_count, 0);
        assert_eq!(plan.statement_count, 2);
    }

    #[test]
    fn build_sync_plan_keeps_missing_target_create_table_statement() {
        let plan = build_data_compare_sync_plan(DataCompareSyncPlanOptions {
            tables: vec![DataCompareSyncPlanTableOptions {
                table_name: "users".to_string(),
                schema: Some("public".to_string()),
                columns: vec!["id".to_string(), "name".to_string()],
                key_columns: Vec::new(),
                column_info: Vec::new(),
                diff: DataCompareResult {
                    added: vec![DataCompareRow {
                        key: "0".to_string(),
                        key_values: HashMap::new(),
                        values: HashMap::from([(String::from("id"), json!(1)), (String::from("name"), json!("Ada"))]),
                    }],
                    removed: Vec::new(),
                    modified: Vec::new(),
                },
                database_type: Some(DatabaseType::Postgres),
                pre_sync_statements: vec!["CREATE TABLE \"public\".\"users\" (\"id\" integer);".to_string()],
            }],
        });

        assert_eq!(plan.insert_count, 1);
        assert_eq!(plan.statement_count, 2);
        assert!(plan.sync_sql.starts_with("CREATE TABLE"));
        assert!(plan.sync_sql.contains("INSERT INTO \"public\".\"users\""));
    }

    #[test]
    fn requires_at_least_one_key_column() {
        let err = compare_data_rows(CompareDataRowsOptions {
            columns: vec!["id".to_string()],
            key_columns: Vec::new(),
            source_rows: vec![vec![json!(1)]],
            target_rows: vec![vec![json!(1)]],
        })
        .expect_err("missing key columns should fail");

        assert!(err.contains("At least one key column"));
    }

    #[test]
    fn rejects_duplicate_row_keys() {
        let err = compare_data_rows(CompareDataRowsOptions {
            columns: vec!["id".to_string(), "name".to_string()],
            key_columns: vec!["id".to_string()],
            source_rows: vec![vec![json!(1), json!("Ada")], vec![json!(1), json!("Ada Clone")]],
            target_rows: vec![vec![json!(1), json!("Ada")]],
        })
        .expect_err("duplicate source keys should fail");

        assert!(err.contains("Duplicate source key"));
    }

    #[test]
    fn builds_backend_table_select_sql_with_explicit_columns_and_key_order() {
        assert_eq!(
            build_data_compare_select_sql(
                DatabaseType::Postgres,
                "public",
                "users",
                &["id".to_string(), "name".to_string()],
                &["id".to_string()],
                1000,
                0,
            ),
            "SELECT \"id\", \"name\" FROM \"public\".\"users\" ORDER BY \"id\" ASC LIMIT 1000;"
        );
    }

    #[test]
    fn builds_backend_table_select_sql_for_sqlserver_limit_syntax() {
        assert_eq!(
            build_data_compare_select_sql(
                DatabaseType::SqlServer,
                "dbo",
                "users",
                &["id".to_string(), "name".to_string()],
                &["id".to_string()],
                50,
                0,
            ),
            "SELECT TOP (50) [id], [name] FROM [dbo].[users] ORDER BY [id] ASC"
        );
    }

    #[test]
    fn shared_sql_dialect_helpers_build_data_compare_table_sql() {
        use crate::sql_dialect::build_count_table_sql as build_shared_count_table_sql;

        assert_eq!(
            build_shared_count_table_sql(Some(DatabaseType::Postgres), Some("public"), "users"),
            "SELECT COUNT(*) AS row_count FROM \"public\".\"users\""
        );
        assert_eq!(
            build_data_compare_select_sql(
                DatabaseType::Oracle,
                "APP",
                "EVENTS",
                &["ID".to_string(), "NAME".to_string()],
                &["ID".to_string()],
                25,
                0,
            ),
            "SELECT \"ID\", \"NAME\" FROM \"APP\".\"EVENTS\" ORDER BY \"ID\" ASC FETCH FIRST 25 ROWS ONLY"
        );
    }
}
