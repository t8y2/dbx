//! Run with DBX_LIVE_MYSQL_URL pointing to a disposable MySQL 8 instance.
//! Creates a database, compares a mysqldump-shaped schema file with the
//! database it came from, and drops only the database this test creates.
use std::time::Duration;

use dbx_core::db::mysql;
use dbx_core::models::connection::DatabaseType;
use dbx_core::schema_diff::{
    parse_mysql_schema_sql_file, prepare_schema_diff, SchemaDiffPreparation, SchemaDiffPreparationOptions,
    SchemaDiffSqlFileSnapshot, TableSchemaDetail,
};
use dbx_core::types::TableInfo;
use mysql_async::prelude::Queryable;

const DDL: &[&str] = &[
    "CREATE TABLE parents (
        id bigint unsigned NOT NULL AUTO_INCREMENT,
        code char(8) NOT NULL,
        note varchar(40) DEFAULT (concat('it''s','/','a\\b')),
        paren int DEFAULT (1+1),
        created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        code_upper varchar(8) GENERATED ALWAYS AS (upper(code)) STORED,
        PRIMARY KEY (id),
        UNIQUE KEY uk_parents_code (code),
        KEY idx_parents_created (created_at DESC),
        FULLTEXT KEY ft_parents_note (note)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='parent rows'",
    "CREATE TABLE children (
        id bigint unsigned NOT NULL AUTO_INCREMENT,
        parent_id bigint unsigned NOT NULL,
        status enum('a','b') NOT NULL DEFAULT 'a',
        uuid_default char(36) DEFAULT (uuid()),
        amount decimal(10,2) NOT NULL DEFAULT '0.00',
        PRIMARY KEY (id),
        KEY idx_children_status_amount (status,amount),
        CONSTRAINT fk_children_parent FOREIGN KEY (parent_id) REFERENCES parents (id) ON DELETE CASCADE ON UPDATE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
];

async fn live_details(pool: &mysql::MySqlPool, database: &str, tables: &[TableInfo]) -> Vec<TableSchemaDetail> {
    let mut details = Vec::new();
    for table in tables {
        details.push(TableSchemaDetail {
            name: table.name.clone(),
            columns: mysql::get_columns(pool, database, &table.name).await.expect("columns"),
            indexes: mysql::list_indexes(pool, database, &table.name).await.expect("indexes"),
            foreign_keys: mysql::list_foreign_keys(pool, database, &table.name).await.expect("foreign keys"),
            triggers: mysql::list_triggers(pool, database, &table.name).await.expect("triggers"),
            ddl: Some(mysql::show_create_table_ddl(pool, database, &table.name).await.expect("ddl")),
        });
    }
    details
}

fn schema_file(details: &[TableSchemaDetail]) -> String {
    let mut sql = String::new();
    for detail in details {
        let ddl = detail.ddl.as_deref().expect("create table ddl");
        sql.push_str(&format!("DROP TABLE IF EXISTS {};\n", detail.name));
        sql.push_str(ddl.trim_end());
        sql.push_str(";\n\n");
    }
    sql
}

fn compare(
    snapshot: &SchemaDiffSqlFileSnapshot,
    database: &str,
    target_tables: Vec<TableInfo>,
    target_details: Vec<TableSchemaDetail>,
) -> SchemaDiffPreparation {
    prepare_schema_diff(SchemaDiffPreparationOptions {
        source_tables: snapshot.tables.clone(),
        target_tables,
        source_details: snapshot.details.clone(),
        target_details,
        database_type: DatabaseType::Mysql,
        target_schema: Some(database.to_string()),
        ..Default::default()
    })
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MYSQL_URL on a disposable MySQL 8 instance"]
async fn schema_file_from_the_same_database_reports_no_diff() {
    let url = std::env::var("DBX_LIVE_MYSQL_URL").expect("set DBX_LIVE_MYSQL_URL to a disposable instance");
    let database = format!("dbx_schema_file_{}", uuid::Uuid::new_v4().simple());
    let pool = mysql::connect(&url, Duration::from_secs(10)).await.expect("connect live MySQL");
    let mut conn = pool.get_conn().await.expect("checkout connection");

    conn.query_drop(format!("CREATE DATABASE {database}")).await.expect("create database");
    for statement in DDL {
        conn.query_drop(format!("USE {database}")).await.expect("use database");
        conn.query_drop(*statement).await.expect("create fixture table");
    }

    let tables = mysql::list_tables(&pool, &database).await.expect("list tables");
    let details = live_details(&pool, &database, &tables).await;
    let sql = schema_file(&details);
    let snapshot = parse_mysql_schema_sql_file(&sql, Some(&database));
    assert!(snapshot.warnings.is_empty(), "unexpected parse warnings: {:?}", snapshot.warnings);
    assert_eq!(snapshot.tables.len(), tables.len(), "every table in the file is parsed");

    let prepared = compare(&snapshot, &database, tables.clone(), details.clone());
    assert!(
        prepared.sync_sql.trim().is_empty(),
        "a schema file compared with the database it came from must produce no SQL, got:\n{}",
        prepared.sync_sql
    );
    assert!(prepared.function_diffs.is_empty(), "routines must stay out of a file compare");

    conn.query_drop(format!("ALTER TABLE {database}.children ADD COLUMN drifted int NULL"))
        .await
        .expect("add drifted column");
    let drifted_tables = mysql::list_tables(&pool, &database).await.expect("list tables after drift");
    let drifted_details = live_details(&pool, &database, &drifted_tables).await;
    let drifted = compare(&snapshot, &database, drifted_tables, drifted_details);
    let lowered = drifted.sync_sql.to_lowercase();
    assert!(
        lowered.contains("drop column") && lowered.contains("drifted"),
        "a real drift must drop the extra column, got:\n{}",
        drifted.sync_sql
    );

    conn.query_drop(format!("DROP DATABASE {database}")).await.expect("drop database");
}
