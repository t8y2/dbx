use dbx_sql_schema::table_structure_sql::{
    build_create_table_sql_with_dialect_options, build_mysql_table_charset_change_sql, CreateTableDialectOptions,
    MysqlTableCharsetChange, TableStructureSqlOptions,
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

fn mysql_create_options() -> TableStructureSqlOptions {
    serde_json::from_value(serde_json::json!({
        "databaseType": "mysql",
        "driverProfile": "mysql",
        "schema": "app",
        "tableName": "users",
        "columns": [
            {"id": "id", "name": "id", "dataType": "INT", "isNullable": false, "isPrimaryKey": true},
            {"id": "name", "name": "name", "dataType": "VARCHAR(64)", "isNullable": true}
        ]
    }))
    .expect("valid MySQL create options")
}

fn create_charset_options(charset: &str, collation: Option<&str>) -> CreateTableDialectOptions {
    // Exercise the wire format used by both HTTP and Tauri clients.
    serde_json::from_value(serde_json::json!({"mysqlTableCharset": {"charset": charset, "collation": collation}}))
        .expect("valid MySQL creation dialect options")
}

#[test]
fn mysql_create_sets_selected_table_defaults_in_the_create_statement() {
    let result = build_create_table_sql_with_dialect_options(
        mysql_create_options(),
        Some("8.0.42"),
        create_charset_options("utf8mb4", Some("utf8mb4_0900_ai_ci")),
    );
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    assert_eq!(result.statements.len(), 1);
    assert!(result.statements[0].ends_with("DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"));
    assert!(!result.statements[0].contains("CONVERT TO"));
    assert!(!result.statements[0].contains("ALTER TABLE"));
}

#[test]
fn mysql_create_keeps_database_defaults_when_no_table_charset_was_selected() {
    let result =
        build_create_table_sql_with_dialect_options(mysql_create_options(), None, CreateTableDialectOptions::default());
    assert!(result.warnings.is_empty());
    assert_eq!(result.statements.len(), 1);
    assert!(!result.statements[0].contains("CHARACTER SET"));
    assert!(!result.statements[0].contains("COLLATE"));

    let selected = build_create_table_sql_with_dialect_options(
        mysql_create_options(),
        None,
        create_charset_options(" utf8mb4 ", None),
    );
    assert!(selected.warnings.is_empty());
    assert!(selected.statements[0].ends_with("DEFAULT CHARACTER SET utf8mb4;"));
}

#[test]
fn mysql_create_retains_column_overrides_engine_comment_and_foreign_keys() {
    let mut options = mysql_create_options();
    options.columns[1].character_set = "latin1".into();
    options.columns[1].collation = "latin1_bin".into();
    options.mysql_engine = Some("InnoDB".into());
    options.table_comment = Some("Customer's names".into());
    options.foreign_keys = serde_json::from_value(serde_json::json!([{
        "id": "parent", "name": "fk_parent", "column": "id", "refSchema": "app", "refTable": "parents",
        "refColumn": "id", "onUpdate": "CASCADE", "onDelete": "RESTRICT"
    }]))
    .unwrap();

    let result = build_create_table_sql_with_dialect_options(
        options,
        None,
        create_charset_options("utf8mb4", Some("utf8mb4_0900_ai_ci")),
    );
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    let create = &result.statements[0];
    assert!(create.contains("CHARACTER SET `latin1` COLLATE `latin1_bin`"));
    assert!(create.contains("ENGINE = InnoDB"));
    assert!(create.contains("DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"));
    assert!(create.contains("COMMENT = 'Customer''s names'"));
    assert!(result.statements.iter().any(|sql| sql.contains("FOREIGN KEY") && sql.contains("parents")));
    assert!(!result.statements.iter().any(|sql| sql.contains("CONVERT TO")));
}

#[test]
fn mysql_create_rejects_invalid_or_mismatched_table_charset_values_before_emitting_sql() {
    let overlong = "a".repeat(65);
    for (charset, collation) in [
        ("", None),
        ("utf8mb4; DROP TABLE users", None),
        ("utf8mb4", Some("utf8mb4_bin; DROP TABLE users")),
        ("utf8mb4", Some("latin1_bin")),
        (overlong.as_str(), None),
        ("utf8mb4", Some(overlong.as_str())),
    ] {
        let result = build_create_table_sql_with_dialect_options(
            mysql_create_options(),
            None,
            create_charset_options(charset, collation),
        );
        assert!(result.statements.is_empty(), "unexpected SQL for {charset:?}/{collation:?}: {:?}", result.statements);
        assert!(!result.warnings.is_empty());
    }
}

#[test]
fn mysql_create_table_charset_is_limited_to_native_mysql() {
    use dbx_sql_schema::models::connection::DatabaseType;
    for (database_type, profile, gaussdb_m_mode) in [
        (DatabaseType::Postgres, None, false),
        (DatabaseType::StarRocks, None, false),
        (DatabaseType::Mysql, Some("starrocks"), false),
        (DatabaseType::Mysql, Some("mariadb"), false),
        (DatabaseType::Mysql, Some("mysql"), true),
    ] {
        let mut options = mysql_create_options();
        options.database_type = Some(database_type);
        options.driver_profile = profile.map(str::to_owned);
        options.is_gaussdb_m_mode = gaussdb_m_mode;
        let result = build_create_table_sql_with_dialect_options(
            options,
            None,
            create_charset_options("utf8mb4", Some("utf8mb4_0900_ai_ci")),
        );
        assert!(result.statements.is_empty(), "unexpected SQL for {database_type:?}/{profile:?}");
        assert!(!result.warnings.is_empty());
    }
}

#[test]
fn mysql_table_charset_accepts_utf8_aliases_and_binary_collation() {
    for (charset, collation) in
        [("utf8", "utf8mb3_general_ci"), ("utf8mb3", "utf8_general_ci"), ("UTF8", "UTF8MB3_BIN"), ("binary", "binary")]
    {
        let result = build_create_table_sql_with_dialect_options(
            mysql_create_options(),
            None,
            create_charset_options(charset, Some(collation)),
        );
        assert!(result.warnings.is_empty(), "{:?}", result.warnings);
        assert!(result.statements[0].ends_with(&format!("DEFAULT CHARACTER SET {charset} COLLATE {collation};")));

        let alter = build_mysql_table_charset_change_sql(
            &mysql_options(),
            MysqlTableCharsetChange { charset: charset.to_string(), collation: Some(collation.to_string()) },
        );
        assert!(alter.warnings.is_empty(), "{:?}", alter.warnings);
        assert!(alter.statements[0].ends_with(&format!("DEFAULT CHARACTER SET {charset} COLLATE {collation};")));
    }
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
