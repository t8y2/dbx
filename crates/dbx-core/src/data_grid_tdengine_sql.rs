use serde_json::Value;

use super::*;
use crate::models::connection::DatabaseType;

pub(super) fn build_tdengine_data_grid_save_statements(options: &DataGridSaveStatementOptions) -> Vec<String> {
    let save_columns = effective_columns(options);
    let mut statements = Vec::new();
    let can_overwrite_existing_rows = save_columns
        .iter()
        .any(|column| column.as_deref().is_some_and(|column| column.eq_ignore_ascii_case(DBX_TDENGINE_TBNAME_COLUMN)));

    if can_overwrite_existing_rows {
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
            if let Some(statement) = build_tdengine_insert_statement(options, &save_columns, &after_row) {
                statements.push(statement);
            }
        }
    }

    for row in &options.new_rows {
        if let Some(statement) = build_tdengine_insert_statement(options, &save_columns, row) {
            statements.push(statement);
        }
    }

    statements
}

fn build_tdengine_insert_statement(
    options: &DataGridSaveStatementOptions,
    save_columns: &[Option<String>],
    row: &[Value],
) -> Option<String> {
    let tbname = tdengine_tbname_value(save_columns, row);
    let table = qualified_table_name(
        Some(DatabaseType::Tdengine),
        options.table_meta.schema.as_deref(),
        &options.table_meta.table_name,
    );
    let tag_columns = tdengine_tag_columns(options.table_meta.columns.as_deref());
    let insert_pairs: Vec<(&str, &Value)> = save_columns
        .iter()
        .enumerate()
        .filter_map(|(index, column)| Some((column.as_deref()?, row.get(index).unwrap_or(&Value::Null))))
        .filter(|(_, value)| !value.is_null())
        .filter(|(column, _)| {
            tdengine_can_insert_column(column, &options.table_meta.table_name, tbname.as_deref(), &tag_columns)
        })
        .collect();
    if insert_pairs.is_empty() {
        return None;
    }
    let columns = insert_pairs
        .iter()
        .map(|(column, _)| quote_ident(Some(DatabaseType::Tdengine), column))
        .collect::<Vec<_>>()
        .join(", ");
    let values = insert_pairs
        .iter()
        .map(|(_, value)| format_grid_sql_literal(value, Some(DatabaseType::Tdengine), None))
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!("INSERT INTO {table} ({columns}) VALUES ({values});"))
}

fn tdengine_tbname_value(save_columns: &[Option<String>], row: &[Value]) -> Option<String> {
    let index = save_columns.iter().position(|column| {
        column.as_deref().is_some_and(|column| column.eq_ignore_ascii_case(DBX_TDENGINE_TBNAME_COLUMN))
    })?;
    let value = row.get(index)?;
    if value.is_null() {
        None
    } else if let Some(value) = value.as_str() {
        Some(value.to_string())
    } else {
        Some(value.to_string())
    }
}

fn tdengine_can_insert_column(column: &str, table_name: &str, tbname: Option<&str>, tag_columns: &[String]) -> bool {
    let normalized = column.to_ascii_lowercase();
    let target_is_child_table = tbname.is_none_or(|tbname| tbname == table_name);
    if !target_is_child_table {
        return true;
    }
    if normalized == DBX_TDENGINE_TBNAME_COLUMN {
        return false;
    }
    !tag_columns.iter().any(|tag| tag == &normalized)
}

fn tdengine_tag_columns(columns: Option<&[DataGridColumnInfo]>) -> Vec<String> {
    columns
        .unwrap_or(&[])
        .iter()
        .filter(|column| column.extra.as_deref().unwrap_or("").to_ascii_lowercase().contains("tag"))
        .map(|column| column.name.to_ascii_lowercase())
        .collect()
}
