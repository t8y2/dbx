use dbx_core::db::mysql;
use dbx_core::models::connection::DatabaseType;
use dbx_core::table_structure_sql::{
    build_table_structure_change_sql, ColumnExtra, ColumnInfo as StructureColumnInfo, EditableStructureColumn,
    TableStructureSqlOptions,
};
use dbx_core::types::ColumnInfo;
use mysql_async::prelude::Queryable;

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
    }
}

fn generated_extra(columns: &[ColumnInfo]) -> &str {
    columns
        .iter()
        .find(|column| column.name == "total")
        .and_then(|column| column.extra.as_deref())
        .expect("generated column metadata")
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MYSQL_GENERATED_URL and DBX_LIVE_MYSQL_GENERATED_DATABASE"]
async fn live_mysql_generated_column_metadata_and_alter_preserve_expression() {
    let url = std::env::var("DBX_LIVE_MYSQL_GENERATED_URL").expect("DBX_LIVE_MYSQL_GENERATED_URL");
    let database = std::env::var("DBX_LIVE_MYSQL_GENERATED_DATABASE").expect("DBX_LIVE_MYSQL_GENERATED_DATABASE");
    let table = format!("dbx_generated_{}", uuid::Uuid::new_v4().simple());
    let pool = mysql::connect(&url, std::time::Duration::from_secs(10)).await.unwrap();
    let mut conn = mysql::get_conn_with_health_check(&pool).await.unwrap();
    conn.query_drop(format!(
        "CREATE TABLE `{table}` (\
         `price` DECIMAL(10,2) NOT NULL, \
         `quantity` INT NOT NULL, \
         `total` DECIMAL(12,2) GENERATED ALWAYS AS (`price` * `quantity`) STORED, \
         `status` VARCHAR(50) NULL)"
    ))
    .await
    .unwrap();

    let columns = mysql::get_columns(&pool, &database, &table).await.unwrap();
    let extra = generated_extra(&columns);
    assert!(extra.starts_with("GENERATED ALWAYS AS ("), "extra: {extra}");
    assert!(extra.contains("`price` * `quantity`"), "extra: {extra}");
    assert!(extra.ends_with(" STORED"), "extra: {extra}");

    let mut drafts =
        columns.iter().enumerate().map(|(index, column)| editable_column(column, index)).collect::<Vec<_>>();
    drafts.iter_mut().find(|column| column.name == "status").unwrap().comment = "状态1".to_string();
    let status_change = build_table_structure_change_sql(change_options(&table, drafts));
    assert_eq!(status_change.warnings, Vec::<String>::new());
    assert_eq!(status_change.statements.len(), 1, "statements: {:?}", status_change.statements);
    assert!(status_change.statements[0].contains("MODIFY COLUMN `status`"));
    assert!(!status_change.statements[0].contains("`total`"));
    conn.query_drop(&status_change.statements[0]).await.unwrap();

    let columns = mysql::get_columns(&pool, &database, &table).await.unwrap();
    let mut drafts =
        columns.iter().enumerate().map(|(index, column)| editable_column(column, index)).collect::<Vec<_>>();
    drafts.iter_mut().find(|column| column.name == "total").unwrap().data_type = "decimal(14,2)".to_string();
    let generated_change = build_table_structure_change_sql(change_options(&table, drafts));
    assert_eq!(generated_change.warnings, Vec::<String>::new());
    assert_eq!(generated_change.statements.len(), 1, "statements: {:?}", generated_change.statements);
    assert!(generated_change.statements[0].contains("GENERATED ALWAYS AS ("));
    assert!(generated_change.statements[0].contains("`price` * `quantity`"));
    assert!(generated_change.statements[0].contains(") STORED"));
    conn.query_drop(&generated_change.statements[0]).await.unwrap();

    let columns = mysql::get_columns(&pool, &database, &table).await.unwrap();
    assert_eq!(columns.iter().find(|column| column.name == "total").unwrap().data_type, "decimal(14,2)");
    assert!(generated_extra(&columns).contains("`price` * `quantity`"));

    conn.query_drop(format!("DROP TABLE `{table}`")).await.unwrap();
    drop(conn);
    pool.disconnect().await.unwrap();
}
