use dbx_sql_schema::table_structure_sql::{
    build_mysql_table_charset_change_sql, MysqlTableCharsetChange, TableStructureSqlOptions,
};

fn mysql_options() -> TableStructureSqlOptions {
    serde_json::from_value(serde_json::json!({
        "databaseType": "mysql",
        "schema": "app",
        "tableName": "users",
        "columns": []
    }))
    .expect("valid MySQL table options")
}

#[test]
fn mysql_table_charset_change_alters_defaults_without_rebuilding_the_table() {
    let result = build_mysql_table_charset_change_sql(
        &mysql_options(),
        MysqlTableCharsetChange { charset: "utf8mb4".to_string(), collation: Some("utf8mb4_0900_ai_ci".to_string()) },
    );

    assert!(result.warnings.is_empty());
    assert_eq!(
        result.statements,
        vec!["ALTER TABLE `users` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"]
    );
    assert!(!result.statements.iter().any(|sql| sql.contains("CREATE TABLE")));
    assert!(!result.statements.iter().any(|sql| sql.contains("CONVERT TO")));
}

#[test]
fn mysql_table_charset_change_requires_native_mysql() {
    let mut options = mysql_options();
    options.database_type = Some(dbx_sql_schema::models::connection::DatabaseType::Postgres);

    let result = build_mysql_table_charset_change_sql(
        &options,
        MysqlTableCharsetChange { charset: "utf8mb4".to_string(), collation: None },
    );

    assert!(result.statements.is_empty());
    assert_eq!(
        result.warnings,
        vec!["Changing the table character set is supported only for native MySQL connections."]
    );
}
