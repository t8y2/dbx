use dbx_core::models::connection::DatabaseType;
use dbx_core::schema_diff::{
    generate_schema_sync_sql, prepare_schema_diff, SchemaDiffPreparationOptions, TableSchemaDetail,
};
use dbx_core::types::{ColumnInfo, TableInfo};
use mysql_async::prelude::Queryable;

fn column(name: &str, data_type: &str) -> ColumnInfo {
    ColumnInfo { name: name.to_string(), data_type: data_type.to_string(), ..Default::default() }
}

fn table(name: &str) -> TableInfo {
    TableInfo {
        name: name.to_string(),
        table_type: "BASE TABLE".to_string(),
        comment: None,
        parent_schema: None,
        parent_name: None,
    }
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MYSQL_URL pointing to MySQL 8.4.2"]
async fn mysql_schema_diff_add_columns_keep_source_order() {
    let url = std::env::var("DBX_LIVE_MYSQL_URL").expect("DBX_LIVE_MYSQL_URL");
    let mut conn = mysql_async::Conn::new(mysql_async::Opts::from_url(&url).expect("valid MySQL URL"))
        .await
        .expect("connect to live MySQL");
    let version: String = conn.query_first("SELECT VERSION()").await.expect("read version").expect("version row");
    assert!(version.starts_with("8.4.2"), "expected MySQL 8.4.2, got {version}");

    conn.query_drop("DROP DATABASE IF EXISTS dbx4291_live").await.expect("drop prior live database");
    conn.query_drop("CREATE DATABASE dbx4291_live").await.expect("create live database");
    conn.query_drop("CREATE TABLE dbx4291_live.positional (`a` INT NOT NULL, `last` INT NOT NULL)")
        .await
        .expect("create target table");

    let source_columns = vec![
        column("first", "int"),
        column("a", "int"),
        column("middle", "varchar(32)"),
        column("next", "int"),
        column("last", "int"),
        column("new_tail", "int"),
    ];
    let target_columns = vec![column("a", "int"), column("last", "int")];
    let prepared = prepare_schema_diff(SchemaDiffPreparationOptions {
        source_tables: vec![table("positional")],
        target_tables: vec![table("positional")],
        source_details: vec![TableSchemaDetail {
            name: "positional".to_string(),
            columns: source_columns,
            indexes: Vec::new(),
            foreign_keys: Vec::new(),
            triggers: Vec::new(),
            ddl: None,
        }],
        target_details: vec![TableSchemaDetail {
            name: "positional".to_string(),
            columns: target_columns,
            indexes: Vec::new(),
            foreign_keys: Vec::new(),
            triggers: Vec::new(),
            ddl: None,
        }],
        database_type: DatabaseType::Mysql,
        target_schema: Some("dbx4291_live".to_string()),
        ..Default::default()
    });

    conn.query_drop(&prepared.sync_sql).await.expect("execute DBX-generated positional ALTER TABLE");
    let names: Vec<String> = conn
        .exec_map(
            "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
            ("dbx4291_live", "positional"),
            |name: String| name,
        )
        .await
        .expect("read resulting column order");
    assert_eq!(names, vec!["first", "a", "middle", "next", "last", "new_tail"]);

    let postgres_sql =
        generate_schema_sync_sql(&prepared.diffs, &[], &[], &[], &[], DatabaseType::Postgres, None, false, None, &[]);
    assert!(!postgres_sql.contains(" FIRST"), "PostgreSQL output must not contain MySQL FIRST: {postgres_sql}");
    assert!(!postgres_sql.contains(" AFTER "), "PostgreSQL output must not contain MySQL AFTER: {postgres_sql}");
}
