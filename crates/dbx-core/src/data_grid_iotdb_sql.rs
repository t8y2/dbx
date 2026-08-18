use serde_json::Value;
use std::collections::HashSet;

use super::*;
use crate::models::connection::DatabaseType;

pub(super) fn uses_iotdb_table_model_save(options: &DataGridSaveStatementOptions) -> bool {
    options.database_type == Some(DatabaseType::Iotdb) && !options.table_meta.primary_keys.is_empty()
}

pub(super) fn build_iotdb_data_grid_save_statements(options: &DataGridSaveStatementOptions) -> Vec<String> {
    let save_columns = effective_columns(options);
    let mut statements = Vec::new();

    for (row_index, changes) in &options.dirty_rows {
        let Some(row) = options.rows.get(*row_index) else {
            continue;
        };
        if let Some(statement) = build_iotdb_changed_row_insert(options, &save_columns, row, changes, true) {
            statements.push(statement);
        }
    }

    for row_index in &options.deleted_rows {
        let Some(row) = options.rows.get(*row_index) else {
            continue;
        };
        if let Some(statement) = build_iotdb_delete_statement(options, &save_columns, row) {
            statements.push(statement);
        }
    }

    for row in &options.new_rows {
        if let Some(statement) = build_iotdb_full_row_insert(options, &save_columns, row) {
            statements.push(statement);
        }
    }

    statements
}

pub(super) fn build_iotdb_data_grid_rollback_statements(options: &DataGridSaveStatementOptions) -> Vec<String> {
    let save_columns = effective_columns(options);
    let mut statements = Vec::new();

    for row in &options.new_rows {
        if let Some(statement) = build_iotdb_delete_statement(options, &save_columns, row) {
            statements.push(statement);
        }
    }

    for row_index in &options.deleted_rows {
        let Some(row) = options.rows.get(*row_index) else {
            continue;
        };
        if let Some(statement) = build_iotdb_full_row_insert(options, &save_columns, row) {
            statements.push(statement);
        }
    }

    for (row_index, changes) in &options.dirty_rows {
        let Some(row) = options.rows.get(*row_index) else {
            continue;
        };
        let requires_full_restore = changes.iter().any(|(column_index, _)| {
            let value = row.get(*column_index).unwrap_or(&Value::Null);
            let column = save_columns.get(*column_index).and_then(Option::as_deref);
            value.is_null()
                || column.is_some_and(|column| {
                    empty_string_saves_as_null(value, column_info_for(iotdb_column_info(options), column))
                })
        });
        if requires_full_restore {
            if let Some(statement) = build_iotdb_delete_statement(options, &save_columns, row) {
                statements.push(statement);
            }
            if let Some(statement) = build_iotdb_full_row_insert(options, &save_columns, row) {
                statements.push(statement);
            }
        } else if let Some(statement) = build_iotdb_changed_row_insert(options, &save_columns, row, changes, false) {
            statements.push(statement);
        }
    }

    statements
}

pub(super) fn validate_iotdb_existing_rows(options: &DataGridSaveStatementOptions) -> Option<String> {
    if !uses_iotdb_table_model_save(options) || options.dirty_rows.is_empty() {
        return None;
    }

    let save_columns = effective_columns(options);
    let primary_keys =
        options.table_meta.primary_keys.iter().map(|column| normalize_column_name(column)).collect::<HashSet<_>>();
    for (_, changes) in &options.dirty_rows {
        for (column_index, value) in changes {
            let Some(column) = save_columns.get(*column_index).and_then(Option::as_deref) else {
                continue;
            };
            if primary_keys.contains(&normalize_column_name(column)) {
                return Some("IoTDB row identifier columns (time and TAG) cannot be edited.".to_string());
            }
            if value.is_null() || empty_string_saves_as_null(value, column_info_for(iotdb_column_info(options), column))
            {
                return Some(
                    "IoTDB Table model cannot clear a FIELD or ATTRIBUTE value without deleting the row. Enter a non-NULL value or delete the row instead."
                        .to_string(),
                );
            }
        }
    }
    None
}

fn build_iotdb_changed_row_insert(
    options: &DataGridSaveStatementOptions,
    save_columns: &[Option<String>],
    row: &[Value],
    changes: &[(usize, Value)],
    use_changed_values: bool,
) -> Option<String> {
    let changed_indexes = changes.iter().map(|(index, _)| *index).collect::<HashSet<_>>();
    let primary_keys =
        options.table_meta.primary_keys.iter().map(|column| normalize_column_name(column)).collect::<HashSet<_>>();
    let insert_pairs = save_columns
        .iter()
        .enumerate()
        .filter_map(|(index, column)| {
            let column = column.as_deref()?;
            let is_primary_key = primary_keys.contains(&normalize_column_name(column));
            if !is_primary_key && !changed_indexes.contains(&index) {
                return None;
            }
            let value = if use_changed_values && !is_primary_key {
                changes.iter().find(|(changed_index, _)| *changed_index == index).map(|(_, value)| value)?
            } else {
                row.get(index).unwrap_or(&Value::Null)
            };
            Some((column, value))
        })
        .collect::<Vec<_>>();
    build_iotdb_insert_statement(options, insert_pairs)
}

fn build_iotdb_full_row_insert(
    options: &DataGridSaveStatementOptions,
    save_columns: &[Option<String>],
    row: &[Value],
) -> Option<String> {
    let insert_pairs = save_columns
        .iter()
        .enumerate()
        .filter_map(|(index, column)| Some((column.as_deref()?, row.get(index).unwrap_or(&Value::Null))))
        .filter(|(_, value)| !value.is_null())
        .collect::<Vec<_>>();
    build_iotdb_insert_statement(options, insert_pairs)
}

fn build_iotdb_insert_statement(
    options: &DataGridSaveStatementOptions,
    insert_pairs: Vec<(&str, &Value)>,
) -> Option<String> {
    if insert_pairs.is_empty() {
        return None;
    }
    let columns = insert_pairs
        .iter()
        .map(|(column, _)| data_grid_identifier(Some(DatabaseType::Iotdb), column, options.identifier_quote.as_deref()))
        .collect::<Vec<_>>()
        .join(", ");
    let values = insert_pairs
        .iter()
        .map(|(column, value)| {
            format_grid_save_sql_literal(
                value,
                Some(DatabaseType::Iotdb),
                column_info_for(iotdb_column_info(options), column),
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    Some(data_grid_statement(
        Some(DatabaseType::Iotdb),
        format!("INSERT INTO {} ({columns}) VALUES ({values})", iotdb_table(options)),
    ))
}

fn build_iotdb_delete_statement(
    options: &DataGridSaveStatementOptions,
    save_columns: &[Option<String>],
    row: &[Value],
) -> Option<String> {
    let where_clause = build_primary_key_where(
        Some(DatabaseType::Iotdb),
        &options.table_meta.primary_keys,
        save_columns,
        row,
        iotdb_column_info(options),
        options.identifier_quote.as_deref(),
    );
    if where_clause.is_empty() {
        return None;
    }
    Some(data_grid_statement(
        Some(DatabaseType::Iotdb),
        data_grid_delete_sql(Some(DatabaseType::Iotdb), &iotdb_table(options), &where_clause),
    ))
}

fn iotdb_table(options: &DataGridSaveStatementOptions) -> String {
    data_grid_qualified_table_name(
        Some(DatabaseType::Iotdb),
        options.table_meta.catalog.as_deref(),
        options.table_meta.schema.as_deref(),
        options.table_meta.database.as_deref(),
        &options.table_meta.table_name,
        options.identifier_quote.as_deref(),
    )
}

fn iotdb_column_info(options: &DataGridSaveStatementOptions) -> &[DataGridColumnInfo] {
    options.table_meta.columns.as_deref().unwrap_or(&[])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn column(name: &str, data_type: &str, nullable: bool, category: &str) -> DataGridColumnInfo {
        DataGridColumnInfo {
            name: name.to_string(),
            data_type: data_type.to_string(),
            is_nullable: nullable,
            is_primary_key: matches!(category, "TIME" | "TAG"),
            column_default: None,
            extra: Some(category.to_string()),
        }
    }

    fn table_options() -> DataGridSaveStatementOptions {
        DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Iotdb),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                catalog: None,
                database: None,
                schema: Some("dbx_edit_preview".to_string()),
                table_name: "events".to_string(),
                primary_keys: vec!["time".to_string(), "device".to_string()],
                columns: Some(vec![
                    column("time", "TIMESTAMP", false, "TIME"),
                    column("device", "STRING", false, "TAG"),
                    column("event_time", "TIMESTAMP", true, "FIELD"),
                    column("temperature", "DOUBLE", true, "FIELD"),
                ]),
            },
            columns: vec![
                "time".to_string(),
                "device".to_string(),
                "event_time".to_string(),
                "temperature".to_string(),
            ],
            source_columns: None,
            rows: vec![vec![json!("1786954706123"), json!("sensor-a"), json!("1786954706123"), json!(23.5)]],
            dirty_rows: Vec::new(),
            deleted_rows: Vec::new(),
            new_rows: Vec::new(),
        }
    }

    #[test]
    fn prepares_iotdb_timestamp_field_overwrite_and_rollback() {
        let mut options = table_options();
        options.dirty_rows = vec![(0, vec![(2, json!("2026-08-17 17:18:27.123"))])];

        let result = prepare_data_grid_save(options);

        assert_eq!(result.validation_error, None);
        assert_eq!(
            result.statements,
            vec!["INSERT INTO dbx_edit_preview.events (time, device, event_time) VALUES (1786954706123, 'sensor-a', '2026-08-17 17:18:27.123');"]
        );
        assert_eq!(
            result.rollback_statements,
            vec!["INSERT INTO dbx_edit_preview.events (time, device, event_time) VALUES (1786954706123, 'sensor-a', 1786954706123);"]
        );
    }

    #[test]
    fn prepares_iotdb_only_with_changed_fields() {
        let mut options = table_options();
        options.dirty_rows = vec![(0, vec![(2, json!("1786958307123")), (3, json!(24.75))])];

        let result = prepare_data_grid_save(options);

        assert_eq!(
            result.statements,
            vec!["INSERT INTO dbx_edit_preview.events (time, device, event_time, temperature) VALUES (1786954706123, 'sensor-a', 1786958307123, 24.75);"]
        );
        assert_eq!(
            result.rollback_statements,
            vec!["INSERT INTO dbx_edit_preview.events (time, device, event_time, temperature) VALUES (1786954706123, 'sensor-a', 1786954706123, 23.5);"]
        );
    }

    #[test]
    fn prepares_iotdb_insert_delete_and_rollback() {
        let mut options = table_options();
        options.deleted_rows = vec![0];
        options.new_rows = vec![vec![json!("1786961906789"), json!("sensor-b"), json!("1786961906789"), json!(22.75)]];

        let result = prepare_data_grid_save(options);

        assert_eq!(
            result.statements,
            vec![
                "DELETE FROM dbx_edit_preview.events WHERE time = 1786954706123 AND device = 'sensor-a';",
                "INSERT INTO dbx_edit_preview.events (time, device, event_time, temperature) VALUES (1786961906789, 'sensor-b', 1786961906789, 22.75);",
            ]
        );
        assert_eq!(
            result.rollback_statements,
            vec![
                "DELETE FROM dbx_edit_preview.events WHERE time = 1786961906789 AND device = 'sensor-b';",
                "INSERT INTO dbx_edit_preview.events (time, device, event_time, temperature) VALUES (1786954706123, 'sensor-a', 1786954706123, 23.5);",
            ]
        );
    }

    #[test]
    fn rejects_iotdb_row_identifier_edits() {
        let mut options = table_options();
        options.dirty_rows = vec![(0, vec![(1, json!("sensor-b"))])];

        let result = prepare_data_grid_save(options);

        assert_eq!(
            result.validation_error,
            Some("IoTDB row identifier columns (time and TAG) cannot be edited.".to_string())
        );
        assert!(result.statements.is_empty());
        assert!(result.rollback_statements.is_empty());
    }

    #[test]
    fn rejects_iotdb_null_field_edits_that_insert_cannot_clear() {
        let mut options = table_options();
        options.dirty_rows = vec![(0, vec![(2, Value::Null)])];

        let result = prepare_data_grid_save(options);

        assert_eq!(
            result.validation_error,
            Some(
                "IoTDB Table model cannot clear a FIELD or ATTRIBUTE value without deleting the row. Enter a non-NULL value or delete the row instead."
                    .to_string()
            )
        );
        assert!(result.statements.is_empty());
    }

    #[test]
    fn restores_iotdb_original_null_with_delete_and_full_row_insert() {
        let mut options = table_options();
        options.rows[0][2] = Value::Null;
        options.dirty_rows = vec![(0, vec![(2, json!("1786958307123"))])];

        let result = prepare_data_grid_save(options);

        assert_eq!(
            result.statements,
            vec!["INSERT INTO dbx_edit_preview.events (time, device, event_time) VALUES (1786954706123, 'sensor-a', 1786958307123);"]
        );
        assert_eq!(
            result.rollback_statements,
            vec![
                "DELETE FROM dbx_edit_preview.events WHERE time = 1786954706123 AND device = 'sensor-a';",
                "INSERT INTO dbx_edit_preview.events (time, device, temperature) VALUES (1786954706123, 'sensor-a', 23.5);",
            ]
        );
    }

    #[test]
    fn preserves_timestamp_precision_strings_as_unquoted_integer_literals() {
        for (original, changed) in [
            ("1786954706123", "1786958307123"),
            ("1786954706123456", "1786958307123456"),
            ("1786954706123456789", "1786958307123456789"),
        ] {
            let mut options = table_options();
            options.rows[0][0] = json!(original);
            options.rows[0][2] = json!(original);
            options.dirty_rows = vec![(0, vec![(2, json!(changed))])];

            let result = prepare_data_grid_save(options);

            assert_eq!(
                result.statements,
                vec![format!(
                    "INSERT INTO dbx_edit_preview.events (time, device, event_time) VALUES ({original}, 'sensor-a', {changed});"
                )]
            );
            assert_eq!(
                result.rollback_statements,
                vec![format!(
                    "INSERT INTO dbx_edit_preview.events (time, device, event_time) VALUES ({original}, 'sensor-a', {original});"
                )]
            );
        }
    }

    #[test]
    fn keeps_iotdb_tree_model_on_the_existing_sql_path() {
        let mut options = table_options();
        options.table_meta.primary_keys.clear();
        options.table_meta.schema = Some("root.dbx".to_string());
        options.table_meta.table_name = "d1".to_string();

        assert!(!uses_iotdb_table_model_save(&options));
    }
}
