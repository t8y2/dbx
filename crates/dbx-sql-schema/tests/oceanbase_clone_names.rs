use dbx_sql_schema::table_structure_sql::{build_create_table_sql, TableStructureSqlOptions};

#[test]
fn oceanbase_clone_create_preserves_decoded_quoted_target_names() {
    for name in [" New ", "MixedCase", "A\"B", "普通表"] {
        let options: TableStructureSqlOptions = serde_json::from_value(serde_json::json!({
            "databaseType": "oceanbase-oracle", "schema": "APP", "tableName": name,
            "columns": [{"id": "new:id", "name": "ID", "dataType": "NUMBER", "isNullable": true}]
        }))
        .unwrap();
        let result = build_create_table_sql(options);
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        let expected = format!("CREATE TABLE \"APP\".\"{}\" (", name.replace('"', "\"\""));
        assert!(result.statements[0].starts_with(&expected), "{:?}", result.statements);
    }
}

#[test]
fn other_databases_keep_create_name_input_trimming() {
    for database_type in ["oracle", "postgres", "mysql"] {
        let options: TableStructureSqlOptions = serde_json::from_value(serde_json::json!({
            "databaseType": database_type, "schema": "APP", "tableName": " New ",
            "columns": [{"id": "new:id", "name": "ID", "dataType": "INT", "isNullable": true}]
        }))
        .unwrap();
        let result = build_create_table_sql(options);
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        assert!(!result.statements[0].contains(" New "), "{:?}", result.statements);
    }
}
