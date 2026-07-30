use std::collections::{HashMap, HashSet};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::connection::AppState;
use crate::data_grid_sql::{format_grid_sql_literal as format_data_grid_sql_literal, DataGridColumnInfo};
use crate::models::connection::DatabaseType;
use crate::query::{execute_sql_statement_with_options, QueryExecutionOptions};
use crate::schema::get_columns_core;
use crate::sql_dialect::{
    build_count_table_sql, firebird_rows_clause, pagination_strategy, qualified_table_name, quote_table_identifier,
    PaginationContext, TablePaginationStrategy,
};
use crate::transfer::{generate_comment_ddl, generate_create_table_ddl};

const DATA_SYNC_INSERT_BATCH_SIZE: usize = 500;
const DATA_SYNC_CONDITION_BATCH_SIZE: usize = 200;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub degradation_threshold: Option<DegradationThreshold>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sampling_strategy: Option<SamplingStrategy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enable_checksum: Option<bool>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub degradation_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sampling_rate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence_score: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification_method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_checksums: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_checksums: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum DegradationLevel {
    Full,
    Sample,
    SkipWithRisk,
}

impl std::fmt::Display for DegradationLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DegradationLevel::Full => write!(f, "full"),
            DegradationLevel::Sample => write!(f, "sample"),
            DegradationLevel::SkipWithRisk => write!(f, "skip_with_risk"),
        }
    }
}

impl TryFrom<&str> for DegradationLevel {
    type Error = String;
    fn try_from(s: &str) -> Result<Self, Self::Error> {
        match s {
            "full" => Ok(DegradationLevel::Full),
            "sample" => Ok(DegradationLevel::Sample),
            "skip_with_risk" => Ok(DegradationLevel::SkipWithRisk),
            _ => Err(format!("Unknown degradation level: {s}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum SamplingStrategy {
    Random,
    ExtremeValues,
    Hybrid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DegradationThreshold {
    pub full_compare_max_rows: u64,
    pub sample_max_rows: u64,
    pub sample_size: usize,
    pub extreme_sample_count: usize,
}

impl Default for DegradationThreshold {
    fn default() -> Self {
        Self {
            full_compare_max_rows: 100_000,
            sample_max_rows: 10_000_000,
            sample_size: 10_000,
            extreme_sample_count: 500,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyDataOptions {
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub degradation_threshold: Option<DegradationThreshold>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sampling_strategy: Option<SamplingStrategy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enable_checksum: Option<bool>,
}

/// Result of a full verification pass including statistical metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyDataResult {
    pub preparation: DataCompareFromTablesPreparation,
    pub degradation_level: DegradationLevel,
    pub sampling_rate: f64,
    pub confidence_score: f64,
    pub row_count_match: bool,
    pub checksums_match: Option<bool>,
    pub verification_method: String,
}

pub fn prepare_data_compare(options: DataComparePreparationOptions) -> Result<DataComparePreparation, String> {
    let DataComparePreparationOptions {
        table_name,
        schema,
        columns,
        key_columns,
        column_info,
        source_rows,
        target_rows,
        database_type,
    } = options;
    let result = compare_data_rows(CompareDataRowsOptions {
        columns: columns.clone(),
        key_columns: key_columns.clone(),
        source_rows,
        target_rows,
    })?;
    let sync_plan = build_data_compare_sync_plan_from_refs(&[DataCompareSyncPlanTableRef {
        table_name: &table_name,
        schema: schema.as_deref(),
        columns: &columns,
        key_columns: &key_columns,
        column_info: &column_info,
        diff: &result,
        database_type,
        pre_sync_statements: &[],
    }]);
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

    let threshold = options.degradation_threshold.clone().unwrap_or_default();
    let degradation_level = should_degrade(source_row_count, target_row_count, &threshold);
    let sampling_strategy = options.sampling_strategy.clone().unwrap_or(SamplingStrategy::Hybrid);
    let enable_checksum = options.enable_checksum.unwrap_or(true);

    let (source_rows, target_rows, sampling_rate, verification_method) = match &degradation_level {
        DegradationLevel::Full => {
            let (src, tgt) = tokio::try_join!(
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
            (src, tgt, 1.0, "full_compare".to_string())
        }
        DegradationLevel::Sample => {
            let (src, tgt) = tokio::try_join!(
                fetch_sampled_compare_rows(
                    state,
                    &options.source_connection_id,
                    &options.source_database,
                    &options.source_schema,
                    &options.source_table,
                    &options.columns,
                    &options.key_columns,
                    source_database_type,
                    &sampling_strategy,
                    threshold.sample_size,
                ),
                fetch_sampled_compare_rows(
                    state,
                    &options.target_connection_id,
                    &options.target_database,
                    &options.target_schema,
                    &options.target_table,
                    &options.columns,
                    &options.key_columns,
                    target_database_type,
                    &sampling_strategy,
                    threshold.sample_size,
                )
            )?;
            let max_count = source_row_count.max(target_row_count);
            let sample_rate = if max_count > 0 { threshold.sample_size as f64 / max_count as f64 } else { 1.0 };
            let method = "sampled".to_string();
            (src, tgt, sample_rate.min(1.0), method)
        }
        DegradationLevel::SkipWithRisk => (Vec::new(), Vec::new(), 0.0, "skipped".to_string()),
    };

    let target_columns = get_columns_core(
        state,
        &options.target_connection_id,
        &options.target_database,
        &options.target_schema,
        &options.target_table,
    )
    .await?;

    let source_checksums = if enable_checksum && !source_rows.is_empty() {
        Some(compute_column_checksums(&options.columns, &source_rows))
    } else {
        None
    };
    let target_checksums = if enable_checksum && !target_rows.is_empty() {
        Some(compute_column_checksums(&options.columns, &target_rows))
    } else {
        None
    };

    let row_count_match = source_row_count == target_row_count;
    let confidence_score =
        compute_confidence(sampling_rate, &degradation_level, row_count_match, source_row_count, target_row_count);

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
        degradation_level: Some(degradation_level.to_string()),
        sampling_rate: Some(sampling_rate),
        confidence_score: Some(confidence_score),
        verification_method: Some(verification_method),
        source_checksums,
        target_checksums,
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

    let column_info = source_columns.iter().cloned().map(data_grid_column_info).collect::<Vec<_>>();
    let sync_plan = build_data_compare_sync_plan_from_refs(&[DataCompareSyncPlanTableRef {
        table_name: &options.target_table,
        schema: Some(&options.target_schema),
        columns: &column_names,
        key_columns: &options.key_columns,
        column_info: &column_info,
        diff: &result,
        database_type: Some(target_database_type),
        pre_sync_statements: &pre_sync_statements,
    }]);

    Ok(DataCompareFromTablesPreparation {
        result,
        sync_statements: sync_plan.sync_statements,
        sync_sql: sync_plan.sync_sql,
        pre_sync_statements,
        source_row_count,
        target_row_count: 0,
        source_truncated: false,
        target_truncated: false,
        degradation_level: Some("full".to_string()),
        sampling_rate: Some(1.0),
        confidence_score: Some(1.0),
        verification_method: Some("missing_target_full".to_string()),
        source_checksums: None,
        target_checksums: None,
    })
}

pub fn build_data_compare_sync_plan(options: DataCompareSyncPlanOptions) -> DataCompareSyncPlan {
    let tables = options
        .tables
        .iter()
        .map(|table| DataCompareSyncPlanTableRef {
            table_name: &table.table_name,
            schema: table.schema.as_deref(),
            columns: &table.columns,
            key_columns: &table.key_columns,
            column_info: &table.column_info,
            diff: &table.diff,
            database_type: table.database_type,
            pre_sync_statements: &table.pre_sync_statements,
        })
        .collect::<Vec<_>>();
    build_data_compare_sync_plan_from_refs(&tables)
}

#[derive(Debug, Clone, Copy)]
struct DataCompareSyncPlanTableRef<'a> {
    table_name: &'a str,
    schema: Option<&'a str>,
    columns: &'a [String],
    key_columns: &'a [String],
    column_info: &'a [DataGridColumnInfo],
    diff: &'a DataCompareResult,
    database_type: Option<DatabaseType>,
    pre_sync_statements: &'a [String],
}

fn build_data_compare_sync_plan_from_refs(tables: &[DataCompareSyncPlanTableRef<'_>]) -> DataCompareSyncPlan {
    let mut sync_statements = Vec::new();
    let mut insert_count = 0;
    let mut update_count = 0;
    let mut delete_count = 0;

    for table in tables {
        insert_count += table.diff.added.len();
        update_count += table.diff.modified.iter().filter(|row| has_writable_changes(row, table.column_info)).count();
        delete_count += table.diff.removed.len();
        sync_statements.extend(table.pre_sync_statements.iter().cloned());
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
        .into_iter()
        .enumerate()
        .map(|(index, row)| {
            let values = row_object_owned(columns, row);
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

    let column_indexes = column_index_map(&options.columns);
    let (source, source_order) =
        collect_compare_rows(&options.columns, &options.key_columns, &column_indexes, options.source_rows, "source")?;
    let (target, target_order) =
        collect_compare_rows(&options.columns, &options.key_columns, &column_indexes, options.target_rows, "target")?;
    let key_columns: HashSet<&str> = options.key_columns.iter().map(String::as_str).collect();

    let mut added = Vec::new();
    let mut modified = Vec::new();

    for key in &source_order {
        let source_values = source.get(key).expect("source key should exist");
        let Some(target_values) = target.get(key) else {
            added.push(DataCompareRow {
                key: key.clone(),
                key_values: key_values_for_row(source_values, &options.key_columns, &column_indexes),
                values: row_object(&options.columns, source_values),
            });
            continue;
        };

        let changes = options
            .columns
            .iter()
            .filter(|column| !key_columns.contains(column.as_str()))
            .filter_map(|column| {
                let index = column_indexes.get(column.as_str()).copied()?;
                let source_value = row_value(source_values, index);
                let target_value = row_value(target_values, index);
                (source_value != target_value).then(|| DataCompareChangedCell {
                    column: column.clone(),
                    source: source_value.clone(),
                    target: target_value.clone(),
                })
            })
            .collect::<Vec<_>>();

        if !changes.is_empty() {
            modified.push(DataCompareModifiedRow {
                key: key.clone(),
                key_values: key_values_for_row(source_values, &options.key_columns, &column_indexes),
                source_values: row_object(&options.columns, source_values),
                target_values: row_object(&options.columns, target_values),
                changes,
            });
        }
    }

    let mut removed = Vec::new();
    for key in &target_order {
        if let Some(target_values) = target.get(key).filter(|_| !source.contains_key(key)) {
            removed.push(DataCompareRow {
                key: key.clone(),
                key_values: key_values_for_row(target_values, &options.key_columns, &column_indexes),
                values: row_object(&options.columns, target_values),
            });
        }
    }

    Ok(DataCompareResult { added, removed, modified })
}

static NULL_VALUE: Value = Value::Null;

type CompareRowValues = Vec<Value>;
type CompareRowMap = HashMap<String, CompareRowValues>;

fn column_index_map(columns: &[String]) -> HashMap<&str, usize> {
    let mut indexes = HashMap::with_capacity(columns.len());
    for (index, column) in columns.iter().enumerate() {
        indexes.insert(column.as_str(), index);
    }
    indexes
}

fn collect_compare_rows(
    columns: &[String],
    key_columns: &[String],
    column_indexes: &HashMap<&str, usize>,
    rows: Vec<Vec<Value>>,
    label: &str,
) -> Result<(CompareRowMap, Vec<String>), String> {
    let mut items = HashMap::with_capacity(rows.len());
    let mut order = Vec::with_capacity(rows.len());

    for row in rows {
        let key = key_for_row(&row, key_columns, column_indexes);
        if items.contains_key(&key) {
            return Err(format!("Duplicate {label} key: {key}"));
        }
        order.push(key.clone());
        items.insert(key, normalize_row_len(row, columns.len()));
    }

    Ok((items, order))
}

#[derive(Debug, Clone, Copy)]
struct GenerateDataSyncSqlOptions<'a> {
    table_name: &'a str,
    schema: Option<&'a str>,
    columns: &'a [String],
    key_columns: &'a [String],
    column_info: &'a [DataGridColumnInfo],
    diff: &'a DataCompareResult,
    database_type: Option<DatabaseType>,
}

fn row_object(columns: &[String], row: &[Value]) -> HashMap<String, Value> {
    columns
        .iter()
        .enumerate()
        .map(|(index, column)| (column.clone(), row.get(index).cloned().unwrap_or(Value::Null)))
        .collect()
}

fn row_object_owned(columns: &[String], row: Vec<Value>) -> HashMap<String, Value> {
    let mut values = HashMap::with_capacity(columns.len());
    let mut row_values = row.into_iter();
    for column in columns {
        values.insert(column.clone(), row_values.next().unwrap_or(Value::Null));
    }
    values
}

fn key_for(row: &HashMap<String, Value>, key_columns: &[String]) -> String {
    key_columns.iter().map(|column| json_stringify(&value_for(row, column))).collect::<Vec<_>>().join("\u{001f}")
}

fn key_for_row(row: &[Value], key_columns: &[String], column_indexes: &HashMap<&str, usize>) -> String {
    key_columns
        .iter()
        .map(|column| {
            column_indexes
                .get(column.as_str())
                .map(|index| json_stringify(row_value(row, *index)))
                .unwrap_or_else(|| json_stringify(&NULL_VALUE))
        })
        .collect::<Vec<_>>()
        .join("\u{001f}")
}

fn key_values(row: &HashMap<String, Value>, key_columns: &[String]) -> HashMap<String, Value> {
    key_columns.iter().map(|column| (column.clone(), value_for(row, column))).collect()
}

fn key_values_for_row(
    row: &[Value],
    key_columns: &[String],
    column_indexes: &HashMap<&str, usize>,
) -> HashMap<String, Value> {
    key_columns
        .iter()
        .map(|column| {
            let value =
                column_indexes.get(column.as_str()).map(|index| row_value(row, *index).clone()).unwrap_or(Value::Null);
            (column.clone(), value)
        })
        .collect()
}

fn value_for(row: &HashMap<String, Value>, column: &str) -> Value {
    row.get(column).cloned().unwrap_or(Value::Null)
}

fn row_value(row: &[Value], index: usize) -> &Value {
    row.get(index).unwrap_or(&NULL_VALUE)
}

fn normalize_row_len(mut row: Vec<Value>, column_len: usize) -> Vec<Value> {
    if row.len() < column_len {
        row.resize(column_len, Value::Null);
    }
    row
}

fn json_stringify(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

fn generate_data_sync_statements(options: &GenerateDataSyncSqlOptions<'_>) -> Vec<String> {
    let table = qualified_table_name(options.database_type, options.schema, options.table_name);
    let column_info = options.column_info;
    let added = generate_insert_sync_statements(options, &table, column_info);
    let modified = generate_update_sync_statements(options, &table, column_info);
    let removed = generate_delete_sync_statements(options, &table, column_info);

    let mut statements = Vec::with_capacity(added.len() + modified.len() + removed.len());
    statements.extend(added);
    statements.extend(modified);
    statements.extend(removed);
    statements
}

fn generate_insert_sync_statements(
    options: &GenerateDataSyncSqlOptions<'_>,
    table: &str,
    column_info: &[DataGridColumnInfo],
) -> Vec<String> {
    let writable_columns = options
        .columns
        .iter()
        .filter(|column| !is_non_identity_generated_column(column_info_for(column_info, column)))
        .collect::<Vec<_>>();
    let columns = writable_columns
        .iter()
        .map(|column| quote_table_identifier(options.database_type, column))
        .collect::<Vec<_>>()
        .join(", ");
    if writable_columns.is_empty() {
        return options.diff.added.par_iter().map(|_| format!("INSERT INTO {table} DEFAULT VALUES;")).collect();
    }
    options
        .diff
        .added
        .par_chunks(DATA_SYNC_INSERT_BATCH_SIZE)
        .map(|chunk| {
            let values = chunk
                .iter()
                .map(|row| {
                    let row_values = writable_columns
                        .iter()
                        .map(|column| {
                            format_grid_sql_literal(
                                row.values.get(*column).unwrap_or(&Value::Null),
                                options.database_type,
                                column_info_for(column_info, column),
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(", ");
                    format!("({row_values})")
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!("INSERT INTO {table} ({columns}) VALUES {values};")
        })
        .collect()
}

fn generate_update_sync_statements(
    options: &GenerateDataSyncSqlOptions<'_>,
    table: &str,
    column_info: &[DataGridColumnInfo],
) -> Vec<String> {
    let writable_rows =
        options.diff.modified.iter().filter(|row| has_writable_changes(row, column_info)).collect::<Vec<_>>();
    writable_rows
        .par_chunks(DATA_SYNC_CONDITION_BATCH_SIZE)
        .flat_map_iter(|chunk| {
            if chunk.len() == 1 {
                return vec![generate_single_update_statement(options, table, column_info, chunk[0])];
            }
            let changed_columns = options
                .columns
                .iter()
                .filter(|column| !is_non_identity_generated_column(column_info_for(column_info, column)))
                .filter(|column| chunk.iter().any(|row| row.changes.iter().any(|change| change.column == **column)))
                .collect::<Vec<_>>();
            if changed_columns.is_empty() {
                return Vec::new();
            }
            let assignments = changed_columns
                .iter()
                .map(|column| {
                    let quoted_column = quote_table_identifier(options.database_type, column);
                    let cases = chunk
                        .iter()
                        .filter_map(|row| {
                            let change = row.changes.iter().find(|change| change.column == **column)?;
                            Some(format!(
                                "WHEN {} THEN {}",
                                where_by_key(&row.key_values, options.key_columns, options.database_type, column_info),
                                format_grid_sql_literal(
                                    &change.source,
                                    options.database_type,
                                    column_info_for(column_info, column),
                                )
                            ))
                        })
                        .collect::<Vec<_>>()
                        .join(" ");
                    format!("{quoted_column} = CASE {cases} ELSE {quoted_column} END")
                })
                .collect::<Vec<_>>()
                .join(", ");
            let where_clause = chunk
                .iter()
                .map(|row| {
                    format!(
                        "({})",
                        where_by_key(&row.key_values, options.key_columns, options.database_type, column_info)
                    )
                })
                .collect::<Vec<_>>()
                .join(" OR ");
            vec![format!("UPDATE {table} SET {assignments} WHERE {where_clause};")]
        })
        .collect()
}

fn generate_single_update_statement(
    options: &GenerateDataSyncSqlOptions<'_>,
    table: &str,
    column_info: &[DataGridColumnInfo],
    row: &DataCompareModifiedRow,
) -> String {
    let assignments = row
        .changes
        .iter()
        .filter(|change| !is_non_identity_generated_column(column_info_for(column_info, &change.column)))
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
        where_by_key(&row.key_values, options.key_columns, options.database_type, column_info)
    )
}

fn generate_delete_sync_statements(
    options: &GenerateDataSyncSqlOptions<'_>,
    table: &str,
    column_info: &[DataGridColumnInfo],
) -> Vec<String> {
    options
        .diff
        .removed
        .par_chunks(DATA_SYNC_CONDITION_BATCH_SIZE)
        .map(|chunk| {
            if chunk.len() == 1 {
                return format!(
                    "DELETE FROM {table} WHERE {};",
                    where_by_key(&chunk[0].key_values, options.key_columns, options.database_type, column_info)
                );
            }
            let where_clause = chunk
                .iter()
                .map(|row| {
                    format!(
                        "({})",
                        where_by_key(&row.key_values, options.key_columns, options.database_type, column_info)
                    )
                })
                .collect::<Vec<_>>()
                .join(" OR ");
            format!("DELETE FROM {table} WHERE {where_clause};")
        })
        .collect()
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

    match pagination_strategy(Some(database_type), PaginationContext::BoundedRead) {
        TablePaginationStrategy::Db2FetchFirst | TablePaginationStrategy::FetchFirst => {
            let offset_sql = if offset > 0 { format!(" OFFSET {offset} ROWS") } else { String::new() };
            format!("SELECT {select_columns} FROM {table}{order_by}{offset_sql} FETCH FIRST {row_limit} ROWS ONLY")
        }
        TablePaginationStrategy::Rownum => build_rownum_data_compare_select_sql(
            database_type,
            &table,
            &select_columns,
            &order_by,
            columns,
            row_limit,
            offset,
        ),
        TablePaginationStrategy::SqlServerTop => {
            if offset == 0 {
                return format!("SELECT TOP ({row_limit}) {select_columns} FROM {table}{order_by}");
            }
            let page_alias = quote_table_identifier(Some(DatabaseType::SqlServer), "dbx_page");
            let row_number_alias = quote_table_identifier(Some(DatabaseType::SqlServer), "__dbx_row_num");
            let end = offset + row_limit;
            format!(
                "WITH {page_alias} AS (SELECT {select_columns}, ROW_NUMBER() OVER (ORDER BY {order_expression}) AS {row_number_alias} FROM {table}) SELECT {select_columns} FROM {page_alias} WHERE {row_number_alias} > {offset} AND {row_number_alias} <= {end} ORDER BY {row_number_alias}"
            )
        }
        TablePaginationStrategy::IrisTop => format!("SELECT TOP {row_limit} {select_columns} FROM {table}{order_by}"),
        TablePaginationStrategy::InformixFirst => {
            let row_limit_clause =
                if offset > 0 { format!("SKIP {offset} FIRST {row_limit}") } else { format!("FIRST {row_limit}") };
            format!("SELECT {row_limit_clause} {select_columns} FROM {table}{order_by}")
        }
        TablePaginationStrategy::FirebirdRows => {
            let rows = firebird_rows_clause(row_limit, offset);
            format!("SELECT {select_columns} FROM {table}{order_by} {rows}")
        }
        TablePaginationStrategy::AgentMaxRows => format!("SELECT {select_columns} FROM {table}{order_by};"),
        TablePaginationStrategy::Unbounded => format!("SELECT {select_columns} FROM {table}{order_by}"),
        TablePaginationStrategy::QuestDbLimit => {
            if offset > 0 {
                let upper_bound = offset + row_limit;
                format!("SELECT {select_columns} FROM {table}{order_by} LIMIT {offset}, {upper_bound}")
            } else {
                format!("SELECT {select_columns} FROM {table}{order_by} LIMIT {row_limit}")
            }
        }
        TablePaginationStrategy::LimitOffset => {
            let offset_sql = if offset > 0 { format!(" OFFSET {offset}") } else { String::new() };
            format!("SELECT {select_columns} FROM {table}{order_by} LIMIT {row_limit}{offset_sql};")
        }
    }
}

fn build_rownum_data_compare_select_sql(
    database_type: DatabaseType,
    table: &str,
    select_columns: &str,
    order_by: &str,
    columns: &[String],
    row_limit: usize,
    offset: usize,
) -> String {
    let base = format!("SELECT {select_columns} FROM {table}{order_by}");
    if offset == 0 {
        return format!("SELECT {select_columns} FROM ({base}) WHERE ROWNUM <= {row_limit}");
    }

    let row_number_alias = quote_table_identifier(Some(database_type), "__dbx_row_num");
    let end = offset + row_limit;
    let outer_columns = if columns.is_empty() {
        "*".to_string()
    } else {
        columns.iter().map(|column| quote_table_identifier(Some(database_type), column)).collect::<Vec<_>>().join(", ")
    };
    format!(
        "SELECT {outer_columns} FROM (SELECT dbx_inner.*, ROWNUM AS {row_number_alias} FROM ({base}) dbx_inner WHERE ROWNUM <= {end}) WHERE {row_number_alias} > {offset}"
    )
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

fn is_non_identity_generated_column(column_info: Option<&DataGridColumnInfo>) -> bool {
    let extra = column_info.and_then(|column| column.extra.as_deref()).unwrap_or("").to_ascii_lowercase();
    // Keep this aligned with data_grid_sql: identity also says "generated always" but remains explicitly writable.
    extra.contains("generated always as") && !extra.contains("identity")
}

fn has_writable_changes(row: &DataCompareModifiedRow, column_info: &[DataGridColumnInfo]) -> bool {
    row.changes.iter().any(|change| !is_non_identity_generated_column(column_info_for(column_info, &change.column)))
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

fn should_degrade(source_row_count: u64, target_row_count: u64, threshold: &DegradationThreshold) -> DegradationLevel {
    let max_count = source_row_count.max(target_row_count);
    if max_count <= threshold.full_compare_max_rows {
        DegradationLevel::Full
    } else if max_count <= threshold.sample_max_rows {
        DegradationLevel::Sample
    } else {
        DegradationLevel::SkipWithRisk
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DegradationEvent {
    pub source_row_count: u64,
    pub target_row_count: u64,
    pub decided_level: String,
    pub sample_rate: f64,
    pub confidence: f64,
    pub auto_decision: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DegradationChain {
    pub threshold: DegradationThreshold,
    pub events: Vec<DegradationEvent>,
    pub auto_upgrade_enabled: bool,
    pub auto_downgrade_enabled: bool,
}

impl DegradationChain {
    pub fn new(threshold: DegradationThreshold) -> Self {
        Self { threshold, events: Vec::new(), auto_upgrade_enabled: true, auto_downgrade_enabled: true }
    }

    pub fn decide(
        &mut self,
        source_row_count: u64,
        target_row_count: u64,
        metrics: Option<&crate::risk_metrics::DegradationMetrics>,
    ) -> DegradationLevel {
        let max_count = source_row_count.max(target_row_count);
        let new_level = if max_count <= self.threshold.full_compare_max_rows {
            DegradationLevel::Full
        } else if max_count <= self.threshold.sample_max_rows {
            DegradationLevel::Sample
        } else {
            DegradationLevel::SkipWithRisk
        };

        let (sample_rate, confidence) = match &new_level {
            DegradationLevel::Full => (1.0, 1.0),
            DegradationLevel::Sample => {
                let rate = self.threshold.sample_size as f64 / max_count as f64;
                let conf = 0.95 * rate;
                (rate, conf.clamp(0.5, 0.95))
            }
            DegradationLevel::SkipWithRisk => (0.0, 0.0),
        };

        if self.auto_upgrade_enabled {
            if let Some(last) = self.events.last() {
                let auto_upgrade = matches!(
                    (last.decided_level.as_str(), &new_level),
                    ("skip_with_risk", DegradationLevel::Sample) | ("sample", DegradationLevel::Full)
                );
                if auto_upgrade {
                    if let Some(m) = metrics {
                        m.record_auto_upgrade();
                    }
                }
            }
        }

        if self.auto_downgrade_enabled {
            if let Some(last) = self.events.last() {
                let auto_downgrade = matches!(
                    (last.decided_level.as_str(), &new_level),
                    ("full", DegradationLevel::Sample | DegradationLevel::SkipWithRisk)
                        | ("sample", DegradationLevel::SkipWithRisk)
                );
                if auto_downgrade {
                    if let Some(m) = metrics {
                        m.record_auto_downgrade();
                    }
                }
            }
        }

        if let Some(m) = metrics {
            m.record_degradation(&new_level.to_string(), sample_rate, confidence);
        }

        let auto_decision = if new_level == DegradationLevel::Full {
            "auto".to_string()
        } else if new_level == DegradationLevel::Sample {
            "auto_degraded".to_string()
        } else {
            "auto_skipped".to_string()
        };

        self.events.push(DegradationEvent {
            source_row_count,
            target_row_count,
            decided_level: new_level.to_string(),
            sample_rate,
            confidence,
            auto_decision,
            timestamp: chrono::Utc::now().to_rfc3339(),
        });

        new_level
    }

    pub fn event_count(&self) -> usize {
        self.events.len()
    }

    pub fn last_event(&self) -> Option<&DegradationEvent> {
        self.events.last()
    }
}

impl Default for DegradationChain {
    fn default() -> Self {
        Self::new(DegradationThreshold::default())
    }
}

fn build_sampling_select_sql(
    database_type: DatabaseType,
    schema: &str,
    table_name: &str,
    columns: &[String],
    key_columns: &[String],
    strategy: &SamplingStrategy,
    sample_size: usize,
) -> String {
    let table = qualified_table_name(Some(database_type), Some(schema), table_name);
    let select_columns = if columns.is_empty() {
        "*".to_string()
    } else {
        columns.iter().map(|column| quote_table_identifier(Some(database_type), column)).collect::<Vec<_>>().join(", ")
    };

    match strategy {
        SamplingStrategy::Random => match database_type {
            DatabaseType::Postgres | DatabaseType::Redshift | DatabaseType::DuckDb | DatabaseType::Databricks => {
                format!("SELECT {select_columns} FROM {table} TABLESAMPLE SYSTEM (1) LIMIT {sample_size}")
            }
            DatabaseType::SqlServer => {
                format!("SELECT TOP ({sample_size}) {select_columns} FROM {table} TABLESAMPLE ({sample_size} ROWS)")
            }
            DatabaseType::Mysql | DatabaseType::Doris | DatabaseType::StarRocks | DatabaseType::Goldendb => {
                format!("SELECT {select_columns} FROM {table} ORDER BY RAND() LIMIT {sample_size}")
            }
            DatabaseType::Sqlite | DatabaseType::Rqlite | DatabaseType::Turso => {
                format!("SELECT {select_columns} FROM {table} ORDER BY RANDOM() LIMIT {sample_size}")
            }
            DatabaseType::ClickHouse => {
                format!("SELECT {select_columns} FROM {table} ORDER BY rand() LIMIT {sample_size}")
            }
            DatabaseType::Oracle | DatabaseType::OceanbaseOracle | DatabaseType::Dameng => {
                format!("SELECT {select_columns} FROM (SELECT {select_columns} FROM {table} ORDER BY DBMS_RANDOM.VALUE) WHERE ROWNUM <= {sample_size}")
            }
            DatabaseType::Iris => {
                format!("SELECT TOP {sample_size} {select_columns} FROM {table} ORDER BY RAND()")
            }
            DatabaseType::Questdb => {
                format!("SELECT {select_columns} FROM {table} ORDER BY RAND() LIMIT {sample_size}")
            }
            DatabaseType::Informix => {
                format!("SELECT FIRST {sample_size} {select_columns} FROM {table} ORDER BY RAND()")
            }
            _ => {
                if key_columns.is_empty() {
                    format!("SELECT {select_columns} FROM {table} LIMIT {sample_size}")
                } else {
                    let order_by = key_columns
                        .iter()
                        .map(|column| format!("{} ASC", quote_table_identifier(Some(database_type), column)))
                        .collect::<Vec<_>>()
                        .join(", ");
                    format!("SELECT {select_columns} FROM {table} ORDER BY {order_by} LIMIT {sample_size}")
                }
            }
        },
        SamplingStrategy::ExtremeValues => {
            if key_columns.is_empty() {
                return format!("SELECT {select_columns} FROM {table} LIMIT {sample_size}");
            }
            let order_keys = key_columns
                .iter()
                .map(|column| format!("{} ASC", quote_table_identifier(Some(database_type), column)))
                .collect::<Vec<_>>();
            let asc_order = order_keys.join(", ");
            let desc_order = key_columns
                .iter()
                .map(|column| format!("{} DESC", quote_table_identifier(Some(database_type), column)))
                .collect::<Vec<_>>()
                .join(", ");

            let head_count = sample_size / 2;
            let tail_count = sample_size - head_count;

            format!(
                "SELECT {select_columns} FROM ( \
                 (SELECT {select_columns} FROM {table} ORDER BY {asc_order} LIMIT {head_count}) \
                 UNION ALL \
                 (SELECT {select_columns} FROM {table} ORDER BY {desc_order} LIMIT {tail_count}) \
                 ) AS _extreme_sample"
            )
        }
        SamplingStrategy::Hybrid => {
            if key_columns.is_empty() {
                return format!("SELECT {select_columns} FROM {table} LIMIT {sample_size}");
            }
            let order_keys = key_columns
                .iter()
                .map(|column| format!("{} ASC", quote_table_identifier(Some(database_type), column)))
                .collect::<Vec<_>>();
            let asc_order = order_keys.join(", ");
            let desc_order = key_columns
                .iter()
                .map(|column| format!("{} DESC", quote_table_identifier(Some(database_type), column)))
                .collect::<Vec<_>>()
                .join(", ");

            let random_count = sample_size / 2;
            let head_count = (sample_size - random_count) / 2;
            let tail_count = sample_size - random_count - head_count;

            let random_part = match database_type {
                DatabaseType::Postgres | DatabaseType::Redshift | DatabaseType::DuckDb | DatabaseType::Databricks => {
                    format!("(SELECT {select_columns} FROM {table} TABLESAMPLE SYSTEM (1) LIMIT {random_count})")
                }
                DatabaseType::SqlServer => {
                    format!(
                        "(SELECT TOP ({random_count}) {select_columns} FROM {table} TABLESAMPLE ({random_count} ROWS))"
                    )
                }
                DatabaseType::Mysql | DatabaseType::Doris | DatabaseType::StarRocks | DatabaseType::Goldendb => {
                    format!("(SELECT {select_columns} FROM {table} ORDER BY RAND() LIMIT {random_count})")
                }
                DatabaseType::Sqlite | DatabaseType::Rqlite | DatabaseType::Turso => {
                    format!("(SELECT {select_columns} FROM {table} ORDER BY RANDOM() LIMIT {random_count})")
                }
                DatabaseType::ClickHouse => {
                    format!("(SELECT {select_columns} FROM {table} ORDER BY rand() LIMIT {random_count})")
                }
                DatabaseType::Oracle | DatabaseType::OceanbaseOracle | DatabaseType::Dameng => {
                    format!("(SELECT {select_columns} FROM (SELECT {select_columns} FROM {table} ORDER BY DBMS_RANDOM.VALUE) WHERE ROWNUM <= {random_count})")
                }
                DatabaseType::Iris => {
                    format!("(SELECT TOP {random_count} {select_columns} FROM {table} ORDER BY RAND())")
                }
                DatabaseType::Questdb => {
                    format!("(SELECT {select_columns} FROM {table} ORDER BY RAND() LIMIT {random_count})")
                }
                DatabaseType::Informix => {
                    format!("(SELECT FIRST {random_count} {select_columns} FROM {table} ORDER BY RAND())")
                }
                _ => {
                    format!("(SELECT {select_columns} FROM {table} LIMIT {random_count})")
                }
            };

            format!(
                "SELECT {select_columns} FROM ( \
                 {random_part} \
                 UNION ALL \
                 (SELECT {select_columns} FROM {table} ORDER BY {asc_order} LIMIT {head_count}) \
                 UNION ALL \
                 (SELECT {select_columns} FROM {table} ORDER BY {desc_order} LIMIT {tail_count}) \
                 ) AS _hybrid_sample"
            )
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn fetch_sampled_compare_rows(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table_name: &str,
    columns: &[String],
    key_columns: &[String],
    database_type: DatabaseType,
    strategy: &SamplingStrategy,
    sample_size: usize,
) -> Result<Vec<Vec<Value>>, String> {
    if sample_size == 0 {
        return Ok(Vec::new());
    }

    let sql = build_sampling_select_sql(database_type, schema, table_name, columns, key_columns, strategy, sample_size);

    let result = execute_sql_statement_with_options(
        state,
        connection_id,
        database,
        &sql,
        Some(schema),
        None,
        QueryExecutionOptions { max_rows: Some(sample_size), ..Default::default() },
    )
    .await?;

    Ok(result.rows)
}

fn compute_column_checksums(columns: &[String], rows: &[Vec<Value>]) -> HashMap<String, String> {
    let mut column_hashers: HashMap<String, Sha256> = columns.iter().map(|col| (col.clone(), Sha256::new())).collect();

    let column_indexes = column_index_map(columns);

    for row in rows {
        for (column_name, index) in &column_indexes {
            if let Some(hasher) = column_hashers.get_mut(*column_name) {
                let value_str = json_stringify(row_value(row, *index));
                hasher.update(value_str.as_bytes());
                hasher.update(b"\n");
            }
        }
    }

    column_hashers
        .into_iter()
        .map(|(name, hasher)| {
            let hash = format!("{:x}", hasher.finalize());
            (name, hash)
        })
        .collect()
}

fn compute_confidence(
    sampling_rate: f64,
    degradation_level: &DegradationLevel,
    row_count_match: bool,
    source_row_count: u64,
    target_row_count: u64,
) -> f64 {
    match degradation_level {
        DegradationLevel::Full => {
            if row_count_match {
                1.0
            } else {
                0.99
            }
        }
        DegradationLevel::Sample => {
            let count_ratio =
                source_row_count.min(target_row_count) as f64 / source_row_count.max(target_row_count).max(1) as f64;
            let base = if row_count_match { 0.95 } else { 0.85 };
            let adjusted = base * sampling_rate * count_ratio.sqrt();
            adjusted.clamp(0.5, 0.95)
        }
        DegradationLevel::SkipWithRisk => 0.0,
    }
}

pub async fn verify_data(state: &AppState, options: VerifyDataOptions) -> Result<VerifyDataResult, String> {
    let degradation_threshold = options.degradation_threshold.unwrap_or_default();
    let sampling_strategy = options.sampling_strategy.unwrap_or(SamplingStrategy::Hybrid);
    let enable_checksum = options.enable_checksum.unwrap_or(true);

    let from_tables_options = DataCompareFromTablesOptions {
        source_connection_id: options.source_connection_id,
        source_database: options.source_database,
        source_schema: options.source_schema,
        source_table: options.source_table,
        target_connection_id: options.target_connection_id,
        target_database: options.target_database,
        target_schema: options.target_schema,
        target_table: options.target_table,
        columns: options.columns,
        key_columns: options.key_columns,
        fetch_batch_size: options.fetch_batch_size,
        degradation_threshold: Some(degradation_threshold),
        sampling_strategy: Some(sampling_strategy),
        enable_checksum: Some(enable_checksum),
    };

    let preparation = prepare_data_compare_from_tables(state, from_tables_options).await?;

    let degradation_level = preparation
        .degradation_level
        .as_deref()
        .and_then(|s| DegradationLevel::try_from(s).ok())
        .unwrap_or(DegradationLevel::SkipWithRisk);
    let sampling_rate = preparation.sampling_rate.unwrap_or(1.0);
    let confidence_score = preparation.confidence_score.unwrap_or(0.0);
    let row_count_match = preparation.source_row_count == preparation.target_row_count;

    let checksums_match = match (&preparation.source_checksums, &preparation.target_checksums) {
        (Some(src), Some(tgt)) => Some(src == tgt),
        _ => None,
    };
    let verification_method = preparation.verification_method.clone().unwrap_or_else(|| "unknown".to_string());

    Ok(VerifyDataResult {
        preparation,
        degradation_level,
        sampling_rate,
        confidence_score,
        row_count_match,
        checksums_match,
        verification_method,
    })
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

    fn data_compare_column_with_extra(name: &str, data_type: &str, extra: &str) -> DataGridColumnInfo {
        DataGridColumnInfo { extra: Some(extra.to_string()), ..data_compare_column(name, data_type) }
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
    fn postgres_sync_omits_generated_columns_but_keeps_identity_columns() {
        let preparation = prepare_data_compare(DataComparePreparationOptions {
            table_name: "generated_column_sync_test".to_string(),
            schema: Some("public".to_string()),
            columns: vec!["id".to_string(), "quantity".to_string(), "total_price".to_string()],
            key_columns: vec!["id".to_string()],
            column_info: vec![
                data_compare_column_with_extra("id", "bigint", "generated always as identity"),
                data_compare_column("quantity", "integer"),
                data_compare_column_with_extra(
                    "total_price",
                    "numeric(12,2)",
                    "generated always as (quantity * 3.50) stored",
                ),
            ],
            source_rows: vec![vec![json!(1), json!(2), json!(7.0)], vec![json!(2), json!(3), json!(10.5)]],
            target_rows: vec![vec![json!(2), json!(1), json!(3.5)]],
            database_type: Some(DatabaseType::Postgres),
        })
        .expect("data compare preparation should succeed");

        assert_eq!(
            preparation.sync_sql,
            [
                "INSERT INTO \"public\".\"generated_column_sync_test\" (\"id\", \"quantity\") VALUES (1, 2);",
                "UPDATE \"public\".\"generated_column_sync_test\" SET \"quantity\" = 3 WHERE \"id\" = 2;",
            ]
            .join("\n")
        );
    }

    #[test]
    fn inserts_default_values_when_all_compared_columns_are_generated() {
        let plan = build_data_compare_sync_plan(DataCompareSyncPlanOptions {
            tables: vec![DataCompareSyncPlanTableOptions {
                table_name: "generated_only_projection".to_string(),
                schema: Some("public".to_string()),
                columns: vec!["computed_value".to_string()],
                key_columns: Vec::new(),
                column_info: vec![data_compare_column_with_extra(
                    "computed_value",
                    "integer",
                    "generated always as (base_value + 1) stored",
                )],
                diff: DataCompareResult {
                    added: vec![
                        DataCompareRow {
                            key: "0".to_string(),
                            key_values: HashMap::new(),
                            values: HashMap::from([(String::from("computed_value"), json!(2))]),
                        },
                        DataCompareRow {
                            key: "1".to_string(),
                            key_values: HashMap::new(),
                            values: HashMap::from([(String::from("computed_value"), json!(3))]),
                        },
                    ],
                    removed: Vec::new(),
                    modified: Vec::new(),
                },
                database_type: Some(DatabaseType::Postgres),
                pre_sync_statements: Vec::new(),
            }],
        });

        assert_eq!(plan.insert_count, 2);
        assert_eq!(plan.statement_count, 2);
        assert_eq!(
            plan.sync_statements,
            vec![
                "INSERT INTO \"public\".\"generated_only_projection\" DEFAULT VALUES;",
                "INSERT INTO \"public\".\"generated_only_projection\" DEFAULT VALUES;",
            ]
        );
    }

    #[test]
    fn generated_only_changes_do_not_create_updates_or_increment_counts() {
        let plan = build_data_compare_sync_plan(DataCompareSyncPlanOptions {
            tables: vec![DataCompareSyncPlanTableOptions {
                table_name: "generated_column_sync_test".to_string(),
                schema: Some("public".to_string()),
                columns: vec!["id".to_string(), "total_price".to_string()],
                key_columns: vec!["id".to_string()],
                column_info: vec![
                    data_compare_column("id", "bigint"),
                    data_compare_column_with_extra(
                        "total_price",
                        "numeric(12,2)",
                        "generated always as (quantity * unit_price) stored",
                    ),
                ],
                diff: DataCompareResult {
                    added: Vec::new(),
                    removed: Vec::new(),
                    modified: vec![DataCompareModifiedRow {
                        key: "1".to_string(),
                        key_values: HashMap::from([(String::from("id"), json!(1))]),
                        source_values: HashMap::new(),
                        target_values: HashMap::new(),
                        changes: vec![DataCompareChangedCell {
                            column: "total_price".to_string(),
                            source: json!(7.0),
                            target: json!(8.0),
                        }],
                    }],
                },
                database_type: Some(DatabaseType::Postgres),
                pre_sync_statements: Vec::new(),
            }],
        });

        assert_eq!(plan.update_count, 0);
        assert_eq!(plan.statement_count, 0);
        assert!(plan.sync_sql.is_empty());
    }

    #[test]
    fn generated_only_changes_do_not_enter_batch_update_where_clauses() {
        let mut modified = (1..=200)
            .map(|id| DataCompareModifiedRow {
                key: id.to_string(),
                key_values: HashMap::from([(String::from("id"), json!(id))]),
                source_values: HashMap::new(),
                target_values: HashMap::new(),
                changes: vec![DataCompareChangedCell {
                    column: "quantity".to_string(),
                    source: json!(id + 1),
                    target: json!(id),
                }],
            })
            .collect::<Vec<_>>();
        modified.push(DataCompareModifiedRow {
            key: "999".to_string(),
            key_values: HashMap::from([(String::from("id"), json!(999))]),
            source_values: HashMap::new(),
            target_values: HashMap::new(),
            changes: vec![DataCompareChangedCell {
                column: "total_price".to_string(),
                source: json!(7.0),
                target: json!(8.0),
            }],
        });
        let plan = build_data_compare_sync_plan(DataCompareSyncPlanOptions {
            tables: vec![DataCompareSyncPlanTableOptions {
                table_name: "generated_column_sync_test".to_string(),
                schema: Some("public".to_string()),
                columns: vec!["id".to_string(), "quantity".to_string(), "total_price".to_string()],
                key_columns: vec!["id".to_string()],
                column_info: vec![
                    data_compare_column("id", "bigint"),
                    data_compare_column("quantity", "integer"),
                    data_compare_column_with_extra(
                        "total_price",
                        "numeric(12,2)",
                        "generated always as (quantity * unit_price) stored",
                    ),
                ],
                diff: DataCompareResult { added: Vec::new(), removed: Vec::new(), modified },
                database_type: Some(DatabaseType::Postgres),
                pre_sync_statements: Vec::new(),
            }],
        });

        assert_eq!(plan.update_count, 200);
        assert_eq!(plan.statement_count, 1);
        assert!(!plan.sync_sql.contains("\"id\" = 999"));
        assert!(!plan.sync_sql.contains("\"total_price\""));
    }

    #[test]
    fn sync_keeps_legacy_writes_when_column_metadata_is_missing() {
        let preparation = prepare_data_compare(DataComparePreparationOptions {
            table_name: "generated_column_sync_test".to_string(),
            schema: Some("public".to_string()),
            columns: vec!["id".to_string(), "total_price".to_string()],
            key_columns: vec!["id".to_string()],
            column_info: Vec::new(),
            source_rows: vec![vec![json!(1), json!(7.0)], vec![json!(2), json!(10.5)]],
            target_rows: vec![vec![json!(2), json!(9.0)]],
            database_type: Some(DatabaseType::Postgres),
        })
        .expect("data compare preparation should succeed");

        assert!(preparation.sync_sql.contains("(\"id\", \"total_price\") VALUES (1, 7.0)"));
        assert!(preparation.sync_sql.contains("SET \"total_price\" = 10.5 WHERE \"id\" = 2"));
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
    fn batches_added_rows_into_multi_value_insert_statements() {
        let plan = build_data_compare_sync_plan(DataCompareSyncPlanOptions {
            tables: vec![DataCompareSyncPlanTableOptions {
                table_name: "users".to_string(),
                schema: Some("public".to_string()),
                columns: vec!["id".to_string(), "name".to_string()],
                key_columns: vec!["id".to_string()],
                column_info: Vec::new(),
                diff: DataCompareResult {
                    added: vec![
                        DataCompareRow {
                            key: "1".to_string(),
                            key_values: HashMap::from([(String::from("id"), json!(1))]),
                            values: HashMap::from([
                                (String::from("id"), json!(1)),
                                (String::from("name"), json!("Ada")),
                            ]),
                        },
                        DataCompareRow {
                            key: "2".to_string(),
                            key_values: HashMap::from([(String::from("id"), json!(2))]),
                            values: HashMap::from([
                                (String::from("id"), json!(2)),
                                (String::from("name"), json!("Bob")),
                            ]),
                        },
                    ],
                    removed: Vec::new(),
                    modified: Vec::new(),
                },
                database_type: Some(DatabaseType::Postgres),
                pre_sync_statements: Vec::new(),
            }],
        });

        assert_eq!(plan.insert_count, 2);
        assert_eq!(plan.statement_count, 1);
        assert_eq!(plan.sync_sql, "INSERT INTO \"public\".\"users\" (\"id\", \"name\") VALUES (1, 'Ada'), (2, 'Bob');");
    }

    #[test]
    fn batches_modified_rows_into_case_update_statements() {
        let plan = build_data_compare_sync_plan(DataCompareSyncPlanOptions {
            tables: vec![DataCompareSyncPlanTableOptions {
                table_name: "users".to_string(),
                schema: None,
                columns: vec!["id".to_string(), "name".to_string(), "active".to_string()],
                key_columns: vec!["id".to_string()],
                column_info: Vec::new(),
                diff: DataCompareResult {
                    added: Vec::new(),
                    removed: Vec::new(),
                    modified: vec![
                        DataCompareModifiedRow {
                            key: "1".to_string(),
                            key_values: HashMap::from([(String::from("id"), json!(1))]),
                            source_values: HashMap::new(),
                            target_values: HashMap::new(),
                            changes: vec![DataCompareChangedCell {
                                column: "name".to_string(),
                                source: json!("Ada"),
                                target: json!("Ada old"),
                            }],
                        },
                        DataCompareModifiedRow {
                            key: "2".to_string(),
                            key_values: HashMap::from([(String::from("id"), json!(2))]),
                            source_values: HashMap::new(),
                            target_values: HashMap::new(),
                            changes: vec![
                                DataCompareChangedCell {
                                    column: "name".to_string(),
                                    source: json!("Bob"),
                                    target: json!("Bob old"),
                                },
                                DataCompareChangedCell {
                                    column: "active".to_string(),
                                    source: json!(false),
                                    target: json!(true),
                                },
                            ],
                        },
                    ],
                },
                database_type: Some(DatabaseType::Mysql),
                pre_sync_statements: Vec::new(),
            }],
        });

        assert_eq!(plan.update_count, 2);
        assert_eq!(plan.statement_count, 1);
        assert_eq!(
            plan.sync_sql,
            "UPDATE `users` SET `name` = CASE WHEN `id` = 1 THEN 'Ada' WHEN `id` = 2 THEN 'Bob' ELSE `name` END, `active` = CASE WHEN `id` = 2 THEN FALSE ELSE `active` END WHERE (`id` = 1) OR (`id` = 2);"
        );
    }

    #[test]
    fn batches_removed_rows_into_or_delete_statements() {
        let plan = build_data_compare_sync_plan(DataCompareSyncPlanOptions {
            tables: vec![DataCompareSyncPlanTableOptions {
                table_name: "users".to_string(),
                schema: Some("public".to_string()),
                columns: vec!["id".to_string(), "name".to_string()],
                key_columns: vec!["id".to_string()],
                column_info: Vec::new(),
                diff: DataCompareResult {
                    added: Vec::new(),
                    removed: vec![
                        DataCompareRow {
                            key: "1".to_string(),
                            key_values: HashMap::from([(String::from("id"), json!(1))]),
                            values: HashMap::new(),
                        },
                        DataCompareRow {
                            key: "2".to_string(),
                            key_values: HashMap::from([(String::from("id"), json!(2))]),
                            values: HashMap::new(),
                        },
                    ],
                    modified: Vec::new(),
                },
                database_type: Some(DatabaseType::Postgres),
                pre_sync_statements: Vec::new(),
            }],
        });

        assert_eq!(plan.delete_count, 2);
        assert_eq!(plan.statement_count, 1);
        assert_eq!(plan.sync_sql, "DELETE FROM \"public\".\"users\" WHERE (\"id\" = 1) OR (\"id\" = 2);");
    }

    #[test]
    fn borrowed_sync_plan_builder_matches_owned_plan() {
        let columns = vec!["id".to_string(), "name".to_string()];
        let key_columns = vec!["id".to_string()];
        let column_info = Vec::new();
        let pre_sync_statements = vec!["CREATE TABLE \"public\".\"users\" (\"id\" integer);".to_string()];
        let diff = DataCompareResult {
            added: vec![DataCompareRow {
                key: "1".to_string(),
                key_values: HashMap::from([(String::from("id"), json!(1))]),
                values: HashMap::from([(String::from("id"), json!(1)), (String::from("name"), json!("Ada"))]),
            }],
            removed: vec![DataCompareRow {
                key: "3".to_string(),
                key_values: HashMap::from([(String::from("id"), json!(3))]),
                values: HashMap::from([(String::from("id"), json!(3)), (String::from("name"), json!("Cara"))]),
            }],
            modified: vec![DataCompareModifiedRow {
                key: "2".to_string(),
                key_values: HashMap::from([(String::from("id"), json!(2))]),
                source_values: HashMap::from([(String::from("id"), json!(2)), (String::from("name"), json!("Bob"))]),
                target_values: HashMap::from([(String::from("id"), json!(2)), (String::from("name"), json!("Bobby"))]),
                changes: vec![DataCompareChangedCell {
                    column: "name".to_string(),
                    source: json!("Bob"),
                    target: json!("Bobby"),
                }],
            }],
        };

        let owned_plan = build_data_compare_sync_plan(DataCompareSyncPlanOptions {
            tables: vec![DataCompareSyncPlanTableOptions {
                table_name: "users".to_string(),
                schema: Some("public".to_string()),
                columns: columns.clone(),
                key_columns: key_columns.clone(),
                column_info: column_info.clone(),
                diff: diff.clone(),
                database_type: Some(DatabaseType::Postgres),
                pre_sync_statements: pre_sync_statements.clone(),
            }],
        });
        let borrowed_plan = build_data_compare_sync_plan_from_refs(&[DataCompareSyncPlanTableRef {
            table_name: "users",
            schema: Some("public"),
            columns: &columns,
            key_columns: &key_columns,
            column_info: &column_info,
            diff: &diff,
            database_type: Some(DatabaseType::Postgres),
            pre_sync_statements: &pre_sync_statements,
        }]);

        assert_eq!(borrowed_plan.insert_count, owned_plan.insert_count);
        assert_eq!(borrowed_plan.update_count, owned_plan.update_count);
        assert_eq!(borrowed_plan.delete_count, owned_plan.delete_count);
        assert_eq!(borrowed_plan.statement_count, owned_plan.statement_count);
        assert_eq!(borrowed_plan.sync_statements, owned_plan.sync_statements);
        assert_eq!(borrowed_plan.sync_sql, owned_plan.sync_sql);
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
    fn missing_target_plan_omits_generated_columns_from_followup_insert() {
        let plan = build_data_compare_sync_plan(DataCompareSyncPlanOptions {
            tables: vec![DataCompareSyncPlanTableOptions {
                table_name: "generated_column_sync_test".to_string(),
                schema: Some("public".to_string()),
                columns: vec!["id".to_string(), "quantity".to_string(), "total_price".to_string()],
                key_columns: Vec::new(),
                column_info: vec![
                    data_compare_column("id", "bigint"),
                    data_compare_column("quantity", "integer"),
                    data_compare_column_with_extra(
                        "total_price",
                        "numeric(12,2)",
                        "generated always as (quantity * unit_price) stored",
                    ),
                ],
                diff: DataCompareResult {
                    added: vec![DataCompareRow {
                        key: "0".to_string(),
                        key_values: HashMap::new(),
                        values: HashMap::from([
                            (String::from("id"), json!(1)),
                            (String::from("quantity"), json!(2)),
                            (String::from("total_price"), json!(7.0)),
                        ]),
                    }],
                    removed: Vec::new(),
                    modified: Vec::new(),
                },
                database_type: Some(DatabaseType::Postgres),
                pre_sync_statements: vec![
                    "CREATE TABLE \"public\".\"generated_column_sync_test\" (\"id\" bigint);".to_string()
                ],
            }],
        });

        assert_eq!(plan.insert_count, 1);
        assert_eq!(plan.statement_count, 2);
        assert!(plan.sync_sql.starts_with("CREATE TABLE"));
        assert!(plan.sync_sql.contains("(\"id\", \"quantity\") VALUES (1, 2)"));
        assert!(!plan.sync_sql.contains("\"total_price\") VALUES"));
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
    fn builds_backend_table_select_sql_for_firebird_rows_syntax() {
        assert_eq!(
            build_data_compare_select_sql(
                DatabaseType::Firebird,
                "ignored",
                "USERS",
                &["ID".to_string(), "NAME".to_string()],
                &["ID".to_string()],
                25,
                50,
            ),
            "SELECT \"ID\", \"NAME\" FROM \"USERS\" ORDER BY \"ID\" ASC ROWS 51 TO 75"
        );
    }

    #[test]
    fn builds_backend_table_select_sql_for_oceanbase_oracle_rownum_pages() {
        assert_eq!(
            build_data_compare_select_sql(
                DatabaseType::OceanbaseOracle,
                "APP",
                "EVENTS",
                &["ID".to_string(), "NAME".to_string()],
                &["ID".to_string()],
                25,
                0,
            ),
            "SELECT \"ID\", \"NAME\" FROM (SELECT \"ID\", \"NAME\" FROM \"APP\".\"EVENTS\" ORDER BY \"ID\" ASC) WHERE ROWNUM <= 25"
        );
        assert_eq!(
            build_data_compare_select_sql(
                DatabaseType::OceanbaseOracle,
                "APP",
                "EVENTS",
                &["ID".to_string(), "NAME".to_string()],
                &["ID".to_string()],
                25,
                50,
            ),
            "SELECT \"ID\", \"NAME\" FROM (SELECT dbx_inner.*, ROWNUM AS \"__dbx_row_num\" FROM (SELECT \"ID\", \"NAME\" FROM \"APP\".\"EVENTS\" ORDER BY \"ID\" ASC) dbx_inner WHERE ROWNUM <= 75) WHERE \"__dbx_row_num\" > 50"
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

    #[test]
    fn degradation_chain_full_for_small_table() {
        let threshold = DegradationThreshold::default();
        let mut chain = DegradationChain::new(threshold);
        let level = chain.decide(1000, 1000, None);
        assert_eq!(level, DegradationLevel::Full);
        assert_eq!(chain.event_count(), 1);
        let last = chain.last_event().unwrap();
        assert_eq!(last.decided_level, "full");
        assert!((last.sample_rate - 1.0).abs() < f64::EPSILON);
        assert!((last.confidence - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn degradation_chain_sample_for_large_table() {
        let threshold = DegradationThreshold::default();
        let mut chain = DegradationChain::new(threshold);
        let level = chain.decide(500_000, 500_000, None);
        assert_eq!(level, DegradationLevel::Sample);
        let last = chain.last_event().unwrap();
        assert_eq!(last.decided_level, "sample");
        assert!(last.sample_rate < 1.0);
        assert!(last.confidence >= 0.5);
    }

    #[test]
    fn degradation_chain_skip_for_huge_table() {
        let threshold = DegradationThreshold::default();
        let mut chain = DegradationChain::new(threshold);
        let level = chain.decide(20_000_000, 20_000_000, None);
        assert_eq!(level, DegradationLevel::SkipWithRisk);
        let last = chain.last_event().unwrap();
        assert_eq!(last.decided_level, "skip_with_risk");
        assert!((last.sample_rate - 0.0).abs() < f64::EPSILON);
        assert!((last.confidence - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn degradation_chain_records_multiple_events() {
        let threshold = DegradationThreshold::default();
        let mut chain = DegradationChain::new(threshold);
        chain.decide(1000, 1000, None);
        chain.decide(500_000, 500_000, None);
        chain.decide(20_000_000, 20_000_000, None);
        assert_eq!(chain.event_count(), 3);
    }

    #[test]
    fn degradation_chain_with_metrics_integration() {
        let threshold = DegradationThreshold::default();
        let mut chain = DegradationChain::new(threshold);
        let metrics = crate::risk_metrics::DegradationMetrics::new();

        chain.decide(1000, 1000, Some(&metrics));
        chain.decide(500_000, 500_000, Some(&metrics));
        chain.decide(20_000_000, 20_000_000, Some(&metrics));

        let snapshot = metrics.snapshot();
        let total = snapshot.iter().find(|e| e.name == "dbx_degradation_total").unwrap();
        assert_eq!(total.value, crate::risk_metrics::MetricValue::Counter(3));
    }

    #[test]
    fn degradation_chain_auto_chain_detection() {
        let threshold = DegradationThreshold::default();
        let mut chain = DegradationChain::new(threshold);
        let metrics = crate::risk_metrics::DegradationMetrics::new();

        chain.decide(20_000_000, 20_000_000, Some(&metrics));
        chain.decide(500_000, 500_000, Some(&metrics));

        let snapshot = metrics.snapshot();
        let up = snapshot.iter().find(|e| e.name == "dbx_auto_upgrade_total").unwrap();
        assert_eq!(up.value, crate::risk_metrics::MetricValue::Counter(1));
    }
}
