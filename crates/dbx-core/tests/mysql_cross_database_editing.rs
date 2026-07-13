use dbx_core::data_grid_sql::{
    prepare_data_grid_save, DataGridColumnInfo, DataGridSaveStatementOptions, DataGridTableMeta,
};
use dbx_core::db::ObjectSourceKind;
use dbx_core::models::connection::DatabaseType;
use dbx_core::schema::mysql_object_source_sql;
use dbx_core::sql_dialect::{
    build_count_table_sql, build_table_data_select_sql, build_table_select_sql, TableDataSelectSqlOptions,
    TableSelectSqlOptions,
};
use dbx_core::sql_editability::analyze_editable_query_editability;
use serde_json::json;

#[test]
fn mysql_cross_database_query_flow_preserves_target_database() {
    let analysis = analyze_editable_query_editability("SELECT * FROM db_9.users WHERE active = 1");
    assert!(analysis.editable, "simple cross-database mysql query should remain editable");
    let analysis = analysis.analysis.expect("editable query should include parsed analysis");
    assert_eq!(analysis.schema.as_deref(), Some("db_9"));
    assert_eq!(analysis.table_name, "users");

    let preview_sql = build_table_data_select_sql(TableDataSelectSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        schema: Some("db_9".to_string()),
        table_name: "users".to_string(),
        table_type: Some("TABLE".to_string()),
        primary_keys: vec!["id".to_string()],
        columns: vec!["id".to_string(), "name".to_string()],
        fallback_order_columns: vec![],
        order_by: Some("`id` ASC".to_string()),
        limit: Some(100),
        offset: Some(0),
        where_input: Some("active = 1".to_string()),
        include_row_id: false,
        ..Default::default()
    });
    assert!(preview_sql.contains("FROM `db_9`.`users`"), "preview SQL should stay on the referenced database");

    let export_sql = build_table_select_sql(TableSelectSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        schema: Some("db_9"),
        table_name: "users",
        columns: &["id".to_string(), "name".to_string()],
        order_columns: &["id".to_string()],
        limit: 50,
    });
    assert!(
        export_sql.contains("FROM `db_9`.`users`"),
        "table export/select SQL should stay on the referenced database"
    );

    let count_sql = build_count_table_sql(Some(DatabaseType::Mysql), Some("db_9"), "users");
    assert_eq!(count_sql, "SELECT COUNT(*) AS row_count FROM `db_9`.`users`");

    let save = prepare_data_grid_save(DataGridSaveStatementOptions {
        database_type: Some(DatabaseType::Mysql),
        table_meta: DataGridTableMeta {
            catalog: None,
            database: None,
            schema: Some("db_9".to_string()),
            table_name: "users".to_string(),
            primary_keys: vec!["id".to_string()],
            columns: Some(vec![
                DataGridColumnInfo {
                    name: "id".to_string(),
                    data_type: "INT".to_string(),
                    is_nullable: false,
                    is_primary_key: true,
                    column_default: None,
                    extra: None,
                },
                DataGridColumnInfo {
                    name: "name".to_string(),
                    data_type: "VARCHAR".to_string(),
                    is_nullable: true,
                    is_primary_key: false,
                    column_default: None,
                    extra: None,
                },
            ]),
        },
        columns: vec!["id".to_string(), "name".to_string()],
        source_columns: None,
        rows: vec![vec![json!(1), json!("before")]],
        dirty_rows: vec![(0, vec![(1, json!("after"))])],
        deleted_rows: vec![],
        new_rows: vec![],
    });

    assert_eq!(save.execution_schema.as_deref(), Some("db_9"));
    assert_eq!(save.statements.len(), 1);
    assert!(
        save.statements[0].contains("UPDATE `db_9`.`users` SET `name` = 'after'"),
        "save SQL should update the referenced database: {}",
        save.statements[0]
    );
    assert!(
        save.statements[0].contains("WHERE `id` = 1"),
        "save SQL should still target the selected row by primary key: {}",
        save.statements[0]
    );
}

#[test]
fn mysql_cross_database_show_create_and_object_source_are_qualified() {
    assert_eq!(
        mysql_object_source_sql("db_9", "users_view", &ObjectSourceKind::View),
        "SHOW CREATE VIEW `db_9`.`users_view`"
    );
    assert_eq!(
        mysql_object_source_sql("db_9", "sync_users", &ObjectSourceKind::Procedure),
        "SHOW CREATE PROCEDURE `db_9`.`sync_users`"
    );
    assert_eq!(
        mysql_object_source_sql("db_9", "score_user", &ObjectSourceKind::Function),
        "SHOW CREATE FUNCTION `db_9`.`score_user`"
    );
}
