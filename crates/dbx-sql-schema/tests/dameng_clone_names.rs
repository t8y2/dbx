use dbx_sql_schema::db_admin_sql::{build_copy_table_data_sql, CopyTableDataSqlOptions};
use dbx_sql_schema::table_structure_sql::{build_create_table_sql, TableStructureSqlOptions};

#[test]
fn dameng_clone_create_and_data_copy_preserve_the_same_target_name() {
    for name in ["data_source_copy", "DATA_SOURCE_COPY", "Data_Source_copy", "data\"source_copy", "数据源_副本"] {
        let quoted_target = format!("\"APP\".\"{}\"", name.replace('"', "\"\""));
        let create: TableStructureSqlOptions = serde_json::from_value(serde_json::json!({
            "databaseType": "dameng", "schema": "APP", "tableName": name,
            "columns": [{"id": "new:id", "name": "id", "dataType": "INT", "isNullable": false}]
        }))
        .unwrap();
        let result = build_create_table_sql(create);
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        assert!(
            result.statements[0].starts_with(&format!("CREATE TABLE {quoted_target} (")),
            "{:?}",
            result.statements
        );

        for normalize_new_target_name in [false, true] {
            for identity_insert in [false, true] {
                let copy: CopyTableDataSqlOptions = serde_json::from_value(serde_json::json!({
                    "databaseType": "dameng", "schema": "APP", "sourceName": "data_source", "targetName": name,
                    "columns": ["id"], "normalizeNewTargetName": normalize_new_target_name,
                    "damengIdentityInsert": identity_insert
                }))
                .unwrap();
                let sql = build_copy_table_data_sql(copy);
                let insert =
                    format!("INSERT INTO {quoted_target} (\"id\") SELECT \"id\" FROM \"APP\".\"data_source\";");
                if identity_insert {
                    assert_eq!(sql, format!("SET IDENTITY_INSERT {quoted_target} ON;\n{insert}\nSET IDENTITY_INSERT {quoted_target} OFF;"));
                } else {
                    assert_eq!(sql, insert);
                }
            }
        }
    }
}
