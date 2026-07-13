use std::time::Duration;

use dbx_core::data_grid_sql::{
    build_data_grid_copy_insert_statement, DataGridColumnInfo, DataGridCopyInsertMode,
    DataGridCopyInsertStatementOptions, DataGridTableMeta,
};
use dbx_core::database_export::{build_export_insert_statements, BuildExportInsertStatementsOptions};
use dbx_core::db::postgres;
use dbx_core::models::connection::DatabaseType;

fn grid_column(column: &dbx_core::types::ColumnInfo) -> DataGridColumnInfo {
    DataGridColumnInfo {
        name: column.name.clone(),
        data_type: column.data_type.clone(),
        is_nullable: column.is_nullable,
        is_primary_key: column.is_primary_key,
        column_default: column.column_default.clone(),
        extra: column.extra.clone(),
    }
}

#[tokio::test]
#[ignore = "requires DBX_TEST_POSTGRES_URL pointing at a writable PostgreSQL database"]
async fn postgres_tsvector_generated_columns_are_readable_and_omitted_from_inserts() {
    let url = std::env::var("DBX_TEST_POSTGRES_URL").expect("DBX_TEST_POSTGRES_URL");
    let pool = postgres::connect(&url, Duration::from_secs(5)).await.expect("connect postgres");
    let schema = format!("dbx_tsvector_{}", std::process::id());
    let schema_ident = format!("\"{}\"", schema.replace('"', "\"\""));
    let table = format!("{schema_ident}.articles");

    let _ = postgres::execute_query(&pool, &format!("DROP SCHEMA IF EXISTS {schema_ident} CASCADE")).await;
    postgres::execute_query(&pool, &format!("CREATE SCHEMA {schema_ident}")).await.expect("create schema");
    postgres::execute_query(
        &pool,
        &format!(
            "CREATE TABLE {table} (\
             id integer PRIMARY KEY,\
             title text NOT NULL,\
             body text NOT NULL,\
             search_vector tsvector GENERATED ALWAYS AS \
             (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(body, ''))) STORED\
             )"
        ),
    )
    .await
    .expect("create table");
    postgres::execute_query(&pool, &format!("INSERT INTO {table} (id, title, body) VALUES (1, 'Hello', 'World')"))
        .await
        .expect("insert row");

    let result =
        postgres::execute_query(&pool, &format!("SELECT id, title, body, search_vector FROM {table} ORDER BY id"))
            .await
            .expect("select row");
    assert_eq!(result.column_types, vec!["int4", "text", "text", "tsvector"]);
    assert_eq!(result.rows[0][3].as_str(), Some("'hello':1 'world':2"));

    let columns = postgres::get_columns(&pool, &schema, "articles").await.expect("get columns");
    let search_vector = columns.iter().find(|column| column.name == "search_vector").expect("search_vector column");
    assert_eq!(search_vector.column_default, None);
    assert!(search_vector.extra.as_deref().unwrap_or_default().contains("generated always as"));

    let table_meta = DataGridTableMeta {
        catalog: None,
        database: None,
        schema: Some(schema.clone()),
        table_name: "articles".to_string(),
        primary_keys: vec!["id".to_string()],
        columns: Some(columns.iter().map(grid_column).collect()),
    };
    let copy_insert = build_data_grid_copy_insert_statement(DataGridCopyInsertStatementOptions {
        database_type: Some(DatabaseType::Postgres),
        table_meta: Some(table_meta),
        columns: result.columns.clone(),
        column_types: None,
        source_columns: None,
        rows: result.rows.clone(),
        exclude_primary_keys: false,
        insert_mode: DataGridCopyInsertMode::Merged,
    })
    .expect("copy insert");
    assert!(copy_insert.contains("\"id\", \"title\", \"body\""));
    assert!(!copy_insert.contains("search_vector"));

    let export_insert = build_export_insert_statements(BuildExportInsertStatementsOptions {
        database_type: Some(DatabaseType::Postgres),
        schema: Some(schema.clone()),
        table_name: Some("articles".to_string()),
        qualified_table_name: None,
        columns: result.columns.clone(),
        column_types: result.column_types.iter().map(|value| Some(value.clone())).collect(),
        column_extras: Vec::new(),
        rows: result.rows.clone(),
        batch_size: Some(10),
    })
    .expect("export insert")
    .join("\n");
    assert!(export_insert.contains("\"id\", \"title\", \"body\""));
    assert!(!export_insert.contains("search_vector"));

    postgres::execute_query(&pool, &format!("DROP SCHEMA IF EXISTS {schema_ident} CASCADE"))
        .await
        .expect("drop schema");
}
