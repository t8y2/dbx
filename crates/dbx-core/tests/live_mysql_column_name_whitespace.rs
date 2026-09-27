use dbx_core::db::mysql;
use dbx_core::models::connection::DatabaseType;
use dbx_core::table_structure_sql::{
    build_table_structure_change_sql, ColumnExtra, ColumnInfo as StructureColumnInfo, EditableStructureColumn,
    TableStructureSqlOptions,
};
use dbx_core::types::ColumnInfo;
use mysql_async::prelude::Queryable;

fn column_names(columns: &[ColumnInfo]) -> Vec<String> {
    columns.iter().map(|column| column.name.clone()).collect()
}

fn editable_column(column: &ColumnInfo, index: usize) -> EditableStructureColumn {
    EditableStructureColumn {
        id: format!("existing:{}", column.name),
        name: column.name.clone(),
        data_type: column.data_type.clone(),
        is_nullable: column.is_nullable,
        default_value: column.column_default.clone().unwrap_or_default(),
        comment: column.comment.clone().unwrap_or_default(),
        is_primary_key: column.is_primary_key,
        extra: Some(ColumnExtra::default()),
        original: Some(StructureColumnInfo {
            name: column.name.clone(),
            data_type: column.data_type.clone(),
            is_nullable: column.is_nullable,
            column_default: column.column_default.clone(),
            is_primary_key: column.is_primary_key,
            extra: column.extra.clone(),
            comment: column.comment.clone(),
            character_set: column.character_set.clone(),
            collation: column.collation.clone(),
        }),
        original_position: Some(index),
        marked_for_drop: false,
        character_set: column.character_set.clone().unwrap_or_default(),
        collation: column.collation.clone().unwrap_or_default(),
    }
}

fn change_options(table_name: &str, columns: Vec<EditableStructureColumn>) -> TableStructureSqlOptions {
    TableStructureSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        driver_profile: None,
        schema: None,
        table_name: table_name.to_string(),
        columns,
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
        mysql_engine: None,
        partitioned: false,
        is_gaussdb_m_mode: false,
        table_collation: None,
    }
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MYSQL_COLUMN_NAME_URL and DBX_LIVE_MYSQL_COLUMN_NAME_DATABASE"]
async fn live_mysql_column_metadata_keeps_leading_spaces_in_column_names() {
    let url = std::env::var("DBX_LIVE_MYSQL_COLUMN_NAME_URL").expect("DBX_LIVE_MYSQL_COLUMN_NAME_URL");
    let database = std::env::var("DBX_LIVE_MYSQL_COLUMN_NAME_DATABASE").expect("DBX_LIVE_MYSQL_COLUMN_NAME_DATABASE");
    let table = format!("dbx_column_space_{}", uuid::Uuid::new_v4().simple());
    let pool = mysql::connect(&url, std::time::Duration::from_secs(10)).await.unwrap();
    let mut conn = mysql::get_conn_with_health_check(&pool).await.unwrap();

    // MySQL keeps leading spaces inside a backtick-quoted identifier, so the metadata reader
    // must not collapse them: the structure editor builds follow-up ALTER statements from
    // these names, and a trimmed name no longer matches a column that really exists.
    conn.query_drop(format!("CREATE TABLE `{table}` (`id` INT, `  content1` VARCHAR(64))")).await.unwrap();

    let expected = vec!["id".to_string(), "  content1".to_string()];
    let columns = mysql::get_columns(&pool, &database, &table).await.unwrap();
    assert_eq!(column_names(&columns), expected, "information_schema path");

    let show_columns = mysql::get_columns_show(&pool, &database, &table).await.unwrap();
    assert_eq!(column_names(&show_columns), expected, "SHOW COLUMNS fallback path");

    let mut drafts =
        columns.iter().enumerate().map(|(index, column)| editable_column(column, index)).collect::<Vec<_>>();
    drafts.iter_mut().find(|column| column.name == "  content1").unwrap().comment = "leading space".to_string();
    let change = build_table_structure_change_sql(change_options(&table, drafts));
    assert_eq!(change.warnings, Vec::<String>::new());
    assert_eq!(change.statements.len(), 1, "statements: {:?}", change.statements);
    assert!(change.statements[0].contains("  content1"), "statements: {:?}", change.statements);
    conn.query_drop(&change.statements[0]).await.unwrap();

    let after_edit = mysql::get_columns(&pool, &database, &table).await.unwrap();
    assert_eq!(column_names(&after_edit), expected, "after MODIFY COLUMN");

    conn.query_drop(format!("DROP TABLE `{table}`")).await.unwrap();
    drop(conn);
    pool.disconnect().await.unwrap();
}
