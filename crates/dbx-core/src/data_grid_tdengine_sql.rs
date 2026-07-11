use serde_json::Value;

use super::*;
use crate::models::connection::DatabaseType;

pub(super) fn build_tdengine_data_grid_save_statements(options: &DataGridSaveStatementOptions) -> Vec<String> {
    let save_columns = effective_columns(options);
    let mut statements = Vec::new();
    let has_tbname = save_columns
        .iter()
        .any(|column| column.as_deref().is_some_and(|column| column.eq_ignore_ascii_case(DBX_TDENGINE_TBNAME_COLUMN)));
    let requires_tbname = options
        .table_meta
        .primary_keys
        .iter()
        .any(|primary_key| primary_key.eq_ignore_ascii_case(DBX_TDENGINE_TBNAME_COLUMN));

    if has_tbname || !requires_tbname {
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

    for row_index in &options.deleted_rows {
        let Some(row) = options.rows.get(*row_index) else {
            continue;
        };
        if let Some(statement) = build_tdengine_delete_statement(options, &save_columns, row) {
            statements.push(statement);
        }
    }

    for row in &options.new_rows {
        if let Some(statement) = build_tdengine_insert_statement(options, &save_columns, row) {
            statements.push(statement);
        }
    }

    statements
}

pub(super) fn build_tdengine_data_grid_rollback_statements(options: &DataGridSaveStatementOptions) -> Vec<String> {
    if has_tdengine_composite_primary_key(options) && !options.new_rows.is_empty() {
        return Vec::new();
    }

    let save_columns = effective_columns(options);
    let mut statements = Vec::new();

    for row in &options.new_rows {
        if let Some(statement) = build_tdengine_delete_statement(options, &save_columns, row) {
            statements.push(statement);
        }
    }

    for row_index in &options.deleted_rows {
        let Some(row) = options.rows.get(*row_index) else {
            continue;
        };
        if let Some(statement) = build_tdengine_insert_statement(options, &save_columns, row) {
            statements.push(statement);
        }
    }

    for (row_index, _) in &options.dirty_rows {
        let Some(row) = options.rows.get(*row_index) else {
            continue;
        };
        if let Some(statement) = build_tdengine_insert_statement(options, &save_columns, row) {
            statements.push(statement);
        }
    }

    statements
}

pub(super) fn validate_tdengine_inserted_rows(options: &DataGridSaveStatementOptions) -> Option<String> {
    if options.database_type != Some(DatabaseType::Tdengine) || options.new_rows.is_empty() {
        return None;
    }

    let requires_tbname = options
        .table_meta
        .primary_keys
        .iter()
        .any(|primary_key| primary_key.eq_ignore_ascii_case(DBX_TDENGINE_TBNAME_COLUMN));
    if !requires_tbname {
        return None;
    }

    let save_columns = effective_columns(options);
    if options
        .new_rows
        .iter()
        .any(|row| tdengine_tbname_value(&save_columns, row).is_none_or(|tbname| tbname.trim().is_empty()))
    {
        return Some(tdengine_insert_identity_error());
    }

    None
}

pub(super) fn validate_tdengine_existing_rows(options: &DataGridSaveStatementOptions) -> Option<String> {
    if options.database_type != Some(DatabaseType::Tdengine)
        || (options.deleted_rows.is_empty() && options.dirty_rows.is_empty())
    {
        return None;
    }

    if has_tdengine_composite_primary_key(options) && !options.deleted_rows.is_empty() {
        return Some(tdengine_composite_key_delete_error());
    }

    let save_columns = effective_columns(options);
    let primary_keys = tdengine_row_primary_keys(options);
    let requires_tbname = options
        .table_meta
        .primary_keys
        .iter()
        .any(|primary_key| primary_key.eq_ignore_ascii_case(DBX_TDENGINE_TBNAME_COLUMN));
    if (requires_tbname
        && !save_columns.iter().any(|column| {
            column.as_deref().is_some_and(|column| column.eq_ignore_ascii_case(DBX_TDENGINE_TBNAME_COLUMN))
        }))
        || primary_keys.is_empty()
        || primary_keys.iter().any(|primary_key| find_column_index(&save_columns, primary_key).is_none())
    {
        return Some(tdengine_row_identity_error());
    }

    if options.dirty_rows.iter().any(|(_, changes)| {
        changes.iter().any(|(column_index, _)| {
            save_columns.get(*column_index).and_then(Option::as_deref).is_some_and(|column| {
                options.table_meta.primary_keys.iter().any(|primary_key| primary_key.eq_ignore_ascii_case(column))
            })
        })
    }) {
        return Some(tdengine_row_identity_readonly_error());
    }

    for row_index in
        options.deleted_rows.iter().copied().chain(options.dirty_rows.iter().map(|(row_index, _)| *row_index))
    {
        let Some(row) = options.rows.get(row_index) else {
            return Some(tdengine_row_identity_error());
        };
        if (requires_tbname && tdengine_tbname_value(&save_columns, row).is_none_or(|tbname| tbname.trim().is_empty()))
            || primary_keys.iter().any(|primary_key| {
                find_column_index(&save_columns, primary_key)
                    .and_then(|index| row.get(index))
                    .is_none_or(Value::is_null)
            })
        {
            return Some(tdengine_row_identity_error());
        }
    }

    None
}

fn build_tdengine_delete_statement(
    options: &DataGridSaveStatementOptions,
    save_columns: &[Option<String>],
    row: &[Value],
) -> Option<String> {
    if has_tdengine_composite_primary_key(options) {
        return None;
    }

    let table_name = tdengine_tbname_value(save_columns, row).unwrap_or_else(|| options.table_meta.table_name.clone());
    let primary_keys = tdengine_row_primary_keys(options);
    let where_clause = build_primary_key_where(
        Some(DatabaseType::Tdengine),
        &primary_keys,
        save_columns,
        row,
        options.table_meta.columns.as_deref().unwrap_or(&[]),
    );
    if where_clause.is_empty() {
        return None;
    }
    let table = qualified_table_name(Some(DatabaseType::Tdengine), options.table_meta.schema.as_deref(), &table_name);
    Some(data_grid_statement(
        Some(DatabaseType::Tdengine),
        data_grid_delete_sql(Some(DatabaseType::Tdengine), &table, &where_clause),
    ))
}

fn tdengine_row_primary_keys(options: &DataGridSaveStatementOptions) -> Vec<String> {
    options
        .table_meta
        .primary_keys
        .iter()
        .filter(|primary_key| !primary_key.eq_ignore_ascii_case(DBX_TDENGINE_TBNAME_COLUMN))
        .cloned()
        .collect()
}

fn has_tdengine_composite_primary_key(options: &DataGridSaveStatementOptions) -> bool {
    tdengine_row_primary_keys(options).len() > 1
}

fn tdengine_row_identity_error() -> String {
    "TDengine row editing requires all row identifier columns in the result.".to_string()
}

fn tdengine_row_identity_readonly_error() -> String {
    "TDengine row identifier columns cannot be edited.".to_string()
}

fn tdengine_composite_key_delete_error() -> String {
    "TDengine tables with composite keys do not support row deletion.".to_string()
}

fn tdengine_insert_identity_error() -> String {
    "TDengine STABLE inserts require a child table name (tbname).".to_string()
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
