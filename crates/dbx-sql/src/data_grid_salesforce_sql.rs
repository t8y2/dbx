use serde_json::{Map, Value};

use super::*;
use crate::models::connection::DatabaseType;

/// Header line emitted before every JSON body. The driver's
/// `parse_salesforce_statement` matches this case-insensitively.
const SALESFORCE_DML_HEADER: &str = "DBX SALESFORCE DML";

/// Build the save statements for a Salesforce grid save. Order matches the
/// generic SQL builder: updates, deletes, inserts (see `build_data_grid_save_statements`).
///
/// Each statement is a `DBX SALESFORCE DML` pseudo-command carrying a JSON
/// body. The driver routes them to the appropriate REST endpoint.
pub(super) fn build_salesforce_data_grid_save_statements(options: &DataGridSaveStatementOptions) -> Vec<String> {
    let object = &options.table_meta.table_name;
    let columns = resolve_salesforce_columns(options);
    let column_info = options.table_meta.columns.as_deref().unwrap_or(&[]);
    let id_column_index = find_salesforce_id_column_index(&columns, &options.table_meta.primary_keys);
    let mut statements = Vec::new();

    // 1. Updates (dirty_rows): one statement per dirty row, fields = only the changed columns.
    for (row_index, changes) in &options.dirty_rows {
        let Some(row) = options.rows.get(*row_index) else { continue };
        let Some(id_index) = id_column_index else { continue };
        let Some(id_value) = row.get(id_index).and_then(Value::as_str).filter(|s| !s.is_empty()) else {
            continue;
        };

        let mut fields = Map::new();
        for (column_index, value) in changes {
            let Some(field_name) = columns.get(*column_index).and_then(|c| c.as_deref()) else { continue };
            // Id is the identity, never a write target.
            if field_name.eq_ignore_ascii_case("Id") {
                continue;
            }
            // Skip columns marked non-updateable in the describe metadata.
            if !salesforce_column_is_updateable(column_info_for(column_info, field_name)) {
                continue;
            }
            fields.insert(field_name.to_string(), value.clone());
        }
        if fields.is_empty() {
            continue;
        }

        let body = serde_json::json!({
            "op": "update",
            "object": object,
            "id": id_value,
            "fields": fields
        });
        statements.push(format!("{SALESFORCE_DML_HEADER}\n{body}"));
    }

    // 2. Deletes (deleted_rows): one statement per deleted row index.
    for row_index in &options.deleted_rows {
        let Some(row) = options.rows.get(*row_index) else { continue };
        let Some(id_index) = id_column_index else { continue };
        let Some(id_value) = row.get(id_index).and_then(Value::as_str).filter(|s| !s.is_empty()) else {
            continue;
        };

        let body = serde_json::json!({
            "op": "delete",
            "object": object,
            "id": id_value
        });
        statements.push(format!("{SALESFORCE_DML_HEADER}\n{body}"));
    }

    // 3. Inserts (new_rows): one statement per new row, skipping null and empty-string cells.
    for row in &options.new_rows {
        let mut fields = Map::new();
        for (index, field_name) in columns.iter().enumerate() {
            let Some(field_name) = field_name.as_deref() else { continue };
            // Id is server-generated for inserts; never send it.
            if field_name.eq_ignore_ascii_case("Id") {
                continue;
            }
            // Skip columns marked non-createable in the describe metadata.
            if !salesforce_column_is_createable(column_info_for(column_info, field_name)) {
                continue;
            }
            let value = row.get(index).unwrap_or(&Value::Null);
            // Untouched cells must not be sent.
            if value.is_null() {
                continue;
            }
            if value.is_string() && value.as_str().unwrap_or("").is_empty() {
                continue;
            }
            fields.insert(field_name.to_string(), value.clone());
        }
        if fields.is_empty() {
            continue;
        }

        let body = serde_json::json!({
            "op": "insert",
            "object": object,
            "fields": fields
        });
        statements.push(format!("{SALESFORCE_DML_HEADER}\n{body}"));
    }

    statements
}

/// Salesforce REST has no transactions — rollback statements are always empty.
pub(super) fn build_salesforce_data_grid_rollback_statements(_options: &DataGridSaveStatementOptions) -> Vec<String> {
    Vec::new()
}

/// Validate that the Salesforce sObject has a resolvable Id column. Called
/// from `validate_data_grid_save` before the builder runs.
pub(super) fn validate_salesforce_id_column(options: &DataGridSaveStatementOptions) -> Option<String> {
    if options.database_type != Some(DatabaseType::Salesforce) {
        return None;
    }
    // Only validate when there are updates, deletes, or inserts that would
    // need an Id (updates/deletes need it from existing rows; inserts don't
    // strictly need it, but the grid always has an Id column from the query).
    if options.dirty_rows.is_empty() && options.deleted_rows.is_empty() && options.new_rows.is_empty() {
        return None;
    }
    let columns = resolve_salesforce_columns(options);
    if find_salesforce_id_column_index(&columns, &options.table_meta.primary_keys).is_none() {
        return Some(format!(
            "Cannot save Salesforce {}: no Id column found. The grid must include the record Id to enable editing.",
            options.table_meta.table_name
        ));
    }
    None
}

/// Resolve the field name for each display column: `source_columns[i]` when
/// present, else `columns[i]`.
fn resolve_salesforce_columns(options: &DataGridSaveStatementOptions) -> Vec<Option<String>> {
    match &options.source_columns {
        Some(source_columns) if source_columns.len() == options.columns.len() => source_columns.clone(),
        _ => options.columns.iter().map(|column| Some(column.clone())).collect(),
    }
}

/// Locate the Id column by matching `table_meta.primary_keys` (case-insensitive)
/// against the resolved field names.
fn find_salesforce_id_column_index(columns: &[Option<String>], primary_keys: &[String]) -> Option<usize> {
    // Try primary keys first (case-insensitive).
    for pk in primary_keys {
        let pk_upper = pk.to_ascii_uppercase();
        if let Some(index) =
            columns.iter().position(|col| col.as_deref().is_some_and(|name| name.to_ascii_uppercase() == pk_upper))
        {
            return Some(index);
        }
    }
    // Fallback: look for a column literally named "Id" (case-insensitive).
    columns.iter().position(|col| col.as_deref().is_some_and(|name| name.eq_ignore_ascii_case("Id")))
}

/// Whether a column should be included in update payloads. Returns `true`
/// unless the column's `extra` metadata explicitly marks `updateable: false`.
/// Missing or unparseable `extra` → treat as writable (fail-open; Salesforce
/// enforces the real rules server-side).
fn salesforce_column_is_updateable(info: Option<&DataGridColumnInfo>) -> bool {
    salesforce_extra_flag(info, "updateable").unwrap_or(true)
}

/// Whether a column should be included in insert payloads. Returns `true`
/// unless the column's `extra` metadata explicitly marks `createable: false`.
fn salesforce_column_is_createable(info: Option<&DataGridColumnInfo>) -> bool {
    salesforce_extra_flag(info, "createable").unwrap_or(true)
}

/// Read a boolean flag from the `extra` JSON string on a `DataGridColumnInfo`.
/// Returns `None` when `extra` is absent, unparseable, or lacks the key.
fn salesforce_extra_flag(info: Option<&DataGridColumnInfo>, key: &str) -> Option<bool> {
    let extra_str = info?.extra.as_deref()?;
    let extra: Value = serde_json::from_str(extra_str).ok()?;
    extra.get(key).and_then(Value::as_bool)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_options(
        columns: Vec<&str>,
        primary_keys: Vec<&str>,
        dirty_rows: Vec<(usize, Vec<(usize, Value)>)>,
        deleted_rows: Vec<usize>,
        new_rows: Vec<Vec<Value>>,
        rows: Vec<Vec<Value>>,
    ) -> DataGridSaveStatementOptions {
        DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Salesforce),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                database: None,
                catalog: None,
                schema: None,
                table_name: "Account".to_string(),
                primary_keys: primary_keys.into_iter().map(str::to_string).collect(),
                columns: None,
            },
            columns: columns.into_iter().map(str::to_string).collect(),
            source_columns: None,
            rows,
            dirty_rows,
            deleted_rows,
            new_rows,
            include_database_name: false,
        }
    }

    fn make_options_with_extra(
        columns: Vec<&str>,
        primary_keys: Vec<&str>,
        extras: Vec<Option<&str>>,
    ) -> DataGridSaveStatementOptions {
        let cols: Vec<DataGridColumnInfo> = columns
            .iter()
            .zip(extras.iter())
            .map(|(name, extra)| DataGridColumnInfo {
                name: name.to_string(),
                data_type: String::new(),
                is_nullable: true,
                is_primary_key: false,
                column_default: None,
                extra: extra.map(|s| s.to_string()),
            })
            .collect();
        DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Salesforce),
            identifier_quote: None,
            table_meta: DataGridTableMeta {
                database: None,
                catalog: None,
                schema: None,
                table_name: "Account".to_string(),
                primary_keys: primary_keys.into_iter().map(str::to_string).collect(),
                columns: Some(cols),
            },
            columns: columns.into_iter().map(str::to_string).collect(),
            source_columns: None,
            rows: Vec::new(),
            dirty_rows: Vec::new(),
            deleted_rows: Vec::new(),
            new_rows: Vec::new(),
            include_database_name: false,
        }
    }

    #[test]
    fn update_generates_dml_statement() {
        let opts = make_options(
            vec!["Id", "Name", "Industry"],
            vec!["Id"],
            vec![(0, vec![(1, Value::String("Acme".to_string()))])],
            vec![],
            vec![],
            vec![vec![
                Value::String("001xx000003DGbY".to_string()),
                Value::String("Old Name".to_string()),
                Value::String("Tech".to_string()),
            ]],
        );
        let stmts = build_salesforce_data_grid_save_statements(&opts);
        assert_eq!(stmts.len(), 1);
        assert!(stmts[0].starts_with("DBX SALESFORCE DML\n"));
        let body: Value = serde_json::from_str(stmts[0].split_once('\n').unwrap().1).unwrap();
        assert_eq!(body["op"], "update");
        assert_eq!(body["object"], "Account");
        assert_eq!(body["id"], "001xx000003DGbY");
        assert_eq!(body["fields"]["Name"], "Acme");
        // Industry was not changed → not in fields.
        assert!(body["fields"].get("Industry").is_none());
        // Id is never in fields.
        assert!(body["fields"].get("Id").is_none());
    }

    #[test]
    fn delete_generates_dml_statement() {
        let opts = make_options(
            vec!["Id", "Name"],
            vec!["Id"],
            vec![],
            vec![0],
            vec![],
            vec![vec![Value::String("001xx000003DGbY".to_string()), Value::String("Acme".to_string())]],
        );
        let stmts = build_salesforce_data_grid_save_statements(&opts);
        assert_eq!(stmts.len(), 1);
        let body: Value = serde_json::from_str(stmts[0].split_once('\n').unwrap().1).unwrap();
        assert_eq!(body["op"], "delete");
        assert_eq!(body["id"], "001xx000003DGbY");
    }

    #[test]
    fn insert_generates_dml_statement_skipping_nulls_and_empties() {
        let opts = make_options(
            vec!["Id", "Name", "Phone", "Website"],
            vec!["Id"],
            vec![],
            vec![],
            vec![vec![
                Value::Null,
                Value::String("Acme".to_string()),
                Value::String("".to_string()), // empty → skip
                Value::Null,                   // null → skip
            ]],
            vec![],
        );
        let stmts = build_salesforce_data_grid_save_statements(&opts);
        assert_eq!(stmts.len(), 1);
        let body: Value = serde_json::from_str(stmts[0].split_once('\n').unwrap().1).unwrap();
        assert_eq!(body["op"], "insert");
        assert_eq!(body["object"], "Account");
        assert_eq!(body["fields"]["Name"], "Acme");
        // Id, Phone, Website excluded.
        assert!(body["fields"].get("Id").is_none());
        assert!(body["fields"].get("Phone").is_none());
        assert!(body["fields"].get("Website").is_none());
    }

    #[test]
    fn id_excluded_from_update_fields() {
        // Even if Id appears in the changes, it must not be in the fields payload.
        let opts = make_options(
            vec!["Id", "Name"],
            vec!["Id"],
            vec![(0, vec![(0, Value::String("new-id".to_string())), (1, Value::String("Acme".to_string()))])],
            vec![],
            vec![],
            vec![vec![Value::String("001xx000003DGbY".to_string()), Value::String("Old".to_string())]],
        );
        let stmts = build_salesforce_data_grid_save_statements(&opts);
        assert_eq!(stmts.len(), 1);
        let body: Value = serde_json::from_str(stmts[0].split_once('\n').unwrap().1).unwrap();
        assert!(body["fields"].get("Id").is_none());
        assert_eq!(body["fields"]["Name"], "Acme");
    }

    #[test]
    fn updateable_false_columns_skipped_on_update() {
        let opts = make_options_with_extra(
            vec!["Id", "Name", "SystemField"],
            vec!["Id"],
            vec![
                None,
                Some(r#"{"updateable":true,"createable":true}"#),
                Some(r#"{"updateable":false,"createable":true}"#),
            ],
        );
        let mut opts = opts;
        opts.rows = vec![vec![
            Value::String("001xx000003DGbY".to_string()),
            Value::String("Old".to_string()),
            Value::String("system".to_string()),
        ]];
        opts.dirty_rows =
            vec![(0, vec![(1, Value::String("New".to_string())), (2, Value::String("changed".to_string()))])];
        let stmts = build_salesforce_data_grid_save_statements(&opts);
        assert_eq!(stmts.len(), 1);
        let body: Value = serde_json::from_str(stmts[0].split_once('\n').unwrap().1).unwrap();
        assert_eq!(body["fields"]["Name"], "New");
        assert!(body["fields"].get("SystemField").is_none());
    }

    #[test]
    fn createable_false_columns_skipped_on_insert() {
        let opts = make_options_with_extra(
            vec!["Id", "Name", "AutoField"],
            vec!["Id"],
            vec![
                None,
                Some(r#"{"updateable":true,"createable":true}"#),
                Some(r#"{"updateable":true,"createable":false}"#),
            ],
        );
        let mut opts = opts;
        opts.new_rows = vec![vec![Value::Null, Value::String("Acme".to_string()), Value::String("auto".to_string())]];
        let stmts = build_salesforce_data_grid_save_statements(&opts);
        assert_eq!(stmts.len(), 1);
        let body: Value = serde_json::from_str(stmts[0].split_once('\n').unwrap().1).unwrap();
        assert_eq!(body["fields"]["Name"], "Acme");
        assert!(body["fields"].get("AutoField").is_none());
    }

    #[test]
    fn missing_id_column_produces_validation_error() {
        let opts = make_options(
            vec!["Name", "Industry"],
            vec![], // no primary keys
            vec![(0, vec![(0, Value::String("Acme".to_string()))])],
            vec![],
            vec![],
            vec![vec![Value::String("Old".to_string()), Value::String("Tech".to_string())]],
        );
        let error = validate_salesforce_id_column(&opts);
        assert!(error.is_some());
        assert!(error.unwrap().contains("no Id column found"));
    }

    #[test]
    fn rollback_statements_are_empty() {
        let opts = make_options(vec!["Id", "Name"], vec!["Id"], vec![], vec![], vec![], vec![]);
        assert!(build_salesforce_data_grid_rollback_statements(&opts).is_empty());
    }

    #[test]
    fn statement_order_is_updates_deletes_inserts() {
        let opts = make_options(
            vec!["Id", "Name"],
            vec!["Id"],
            vec![(0, vec![(1, Value::String("Updated".to_string()))])],
            vec![1],
            vec![vec![Value::Null, Value::String("New".to_string())]],
            vec![
                vec![Value::String("id1".to_string()), Value::String("Row1".to_string())],
                vec![Value::String("id2".to_string()), Value::String("Row2".to_string())],
            ],
        );
        let stmts = build_salesforce_data_grid_save_statements(&opts);
        assert_eq!(stmts.len(), 3);
        let ops: Vec<&str> = stmts
            .iter()
            .map(|s| {
                let body: Value = serde_json::from_str(s.split_once('\n').unwrap().1).unwrap();
                // Leak to get a &'static str — fine in tests.
                Box::leak(body["op"].as_str().unwrap().to_string().into_boxed_str()) as &str
            })
            .collect();
        assert_eq!(ops, vec!["update", "delete", "insert"]);
    }

    #[test]
    fn empty_change_set_after_filtering_skips_row() {
        let opts = make_options(
            vec!["Id", "Name"],
            vec!["Id"],
            // Only change is to Id itself → filtered out → empty fields → skip.
            vec![(0, vec![(0, Value::String("new-id".to_string()))])],
            vec![],
            vec![],
            vec![vec![Value::String("001xx000003DGbY".to_string()), Value::String("Old".to_string())]],
        );
        let stmts = build_salesforce_data_grid_save_statements(&opts);
        assert!(stmts.is_empty());
    }

    #[test]
    fn non_salesforce_database_type_returns_no_validation_error() {
        let mut opts = make_options(vec!["Id"], vec!["Id"], vec![], vec![], vec![], vec![]);
        opts.database_type = Some(DatabaseType::Postgres);
        assert!(validate_salesforce_id_column(&opts).is_none());
    }
}
