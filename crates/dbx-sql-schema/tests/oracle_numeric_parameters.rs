use dbx_sql_schema::table_structure_sql::{
    build_create_table_sql, build_single_column_alter_sql, build_table_structure_change_sql,
    SingleColumnAlterSqlOptions, TableStructureSqlOptions,
};

fn numeric_parameters_survive_create_and_add_column(database_type: &str) {
    let options: TableStructureSqlOptions = serde_json::from_value(serde_json::json!({
        "databaseType": database_type, "schema": "APP", "tableName": "NUMERIC_COLUMNS",
        "columns": [
            {"id": "new:f", "name": "F", "dataType": "FLOAT(63)", "isNullable": true},
            {"id": "new:n", "name": "N", "dataType": "NUMBER(*,-2)", "isNullable": true}
        ]
    }))
    .unwrap();
    for result in [build_create_table_sql(options.clone()), build_table_structure_change_sql(options)] {
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        let sql = result.statements.join("\n");
        assert!(sql.contains("FLOAT(63)"), "{database_type}: {sql}");
        assert!(sql.contains("NUMBER(*,-2)"), "{database_type}: {sql}");
    }
}

#[test]
fn oracle_numeric_parameters() {
    numeric_parameters_survive_create_and_add_column("oracle");
}

#[test]
fn oceanbase_oracle_numeric_parameters() {
    numeric_parameters_survive_create_and_add_column("oceanbase-oracle");
}

#[test]
fn oracle_float_parameters_survive_both_modify_entry_points() {
    for database_type in ["oracle", "oceanbase-oracle"] {
        let column = serde_json::json!({
            "id": "existing:F", "name": "F", "dataType": "FLOAT(63)", "isNullable": false,
            "original": {"name": "F", "data_type": "FLOAT(63)", "is_nullable": true, "column_default": null}
        });
        let table: TableStructureSqlOptions = serde_json::from_value(serde_json::json!({
            "databaseType": database_type, "schema": "APP", "tableName": "NUMERIC_COLUMNS", "columns": [column.clone()]
        }))
        .unwrap();
        let single: SingleColumnAlterSqlOptions = serde_json::from_value(serde_json::json!({
            "databaseType": database_type, "schema": "APP", "tableName": "NUMERIC_COLUMNS", "column": column
        }))
        .unwrap();
        for result in [build_table_structure_change_sql(table), build_single_column_alter_sql(single)] {
            assert!(result.warnings.is_empty(), "{:?}", result.warnings);
            assert!(
                result.statements.iter().any(|sql| sql.contains("FLOAT(63)") && sql.contains("NOT NULL")),
                "{:?}",
                result.statements
            );
        }
    }
}

#[test]
fn oracle_comment_only_does_not_modify_numeric_types() {
    for database_type in ["oracle", "oceanbase-oracle"] {
        for data_type in ["FLOAT(63)", "NUMBER(*,-2)", "NUMBER(12,0)", "FLOAT", "NUMBER"] {
            let options: TableStructureSqlOptions = serde_json::from_value(serde_json::json!({
                "databaseType": database_type, "schema": "APP", "tableName": "NUMERIC_COLUMNS",
                "columns": [{"id": "existing:F", "name": "F", "dataType": data_type, "isNullable": true, "comment": "new comment",
                    "original": {"name": "F", "data_type": data_type, "is_nullable": true, "column_default": null}}]
            })).unwrap();
            let result = build_table_structure_change_sql(options);
            assert!(result.warnings.is_empty(), "{:?}", result.warnings);
            assert_eq!(result.statements.len(), 1, "{:?}", result.statements);
            assert!(result.statements[0].starts_with("COMMENT ON COLUMN"));
        }
    }
}

#[test]
fn oracle_explicit_invalid_float_parameters_are_not_silently_dropped() {
    for database_type in ["oracle", "oceanbase-oracle"] {
        for data_type in ["FLOAT(10,2)", "FLOAT(127)", "FLOAT", "float(63)", "BINARY_FLOAT", "NUMBER(*,-2)"] {
            let options: TableStructureSqlOptions = serde_json::from_value(serde_json::json!({
                "databaseType": database_type, "tableName": "NUMERIC_COLUMNS",
                "columns": [{"id": "new:F", "name": "F", "dataType": data_type, "isNullable": true}]
            }))
            .unwrap();
            let result = build_create_table_sql(options);
            assert!(result.warnings.is_empty(), "{:?}", result.warnings);
            assert!(result.statements.join("\n").contains(data_type), "{:?}", result.statements);
        }
    }
}

#[test]
fn other_oracle_like_databases_keep_existing_float_normalization() {
    for database_type in ["iris", "yashandb", "xugu", "dameng", "oscar"] {
        let options: TableStructureSqlOptions = serde_json::from_value(serde_json::json!({
            "databaseType": database_type, "tableName": "NUMERIC_COLUMNS",
            "columns": [{"id": "new:F", "name": "F", "dataType": "FLOAT(63)", "isNullable": true}]
        }))
        .unwrap();
        for result in [build_create_table_sql(options.clone()), build_table_structure_change_sql(options)] {
            assert!(result.warnings.is_empty(), "{database_type}: {:?}", result.warnings);
            let sql = result.statements.join("\n");
            assert!(sql.contains("FLOAT"), "{database_type}: {sql}");
            assert!(!sql.contains("FLOAT(63)"), "{database_type}: {sql}");
        }
    }
}
