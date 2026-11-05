use dbx_core::db::mysql;
use dbx_core::models::connection::DatabaseType;
use dbx_core::schema_diff::{
    generate_schema_sync_sql_plan, prepare_schema_diff, SchemaDiffPreparationOptions, TableSchemaDetail,
};
use dbx_core::sql_dialect::descriptor::DialectKind;
use dbx_core::types::{ColumnInfo, TableInfo};
use mysql_async::prelude::Queryable;

fn table(name: &str) -> TableInfo {
    TableInfo {
        name: name.to_string(),
        table_type: "BASE TABLE".to_string(),
        valid: None,
        comment: None,
        parent_schema: None,
        parent_name: None,
    }
}

fn detail(name: &str, columns: Vec<ColumnInfo>) -> TableSchemaDetail {
    TableSchemaDetail {
        name: name.to_string(),
        columns,
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        ddl: None,
    }
}

fn diff_options(source: Vec<ColumnInfo>, target: Vec<ColumnInfo>, target_schema: &str) -> SchemaDiffPreparationOptions {
    SchemaDiffPreparationOptions {
        source_tables: vec![table("t_1")],
        target_tables: vec![table("t_1")],
        source_details: vec![detail("t_1", source)],
        target_details: vec![detail("t_1", target)],
        database_type: DatabaseType::Mysql,
        target_schema: Some(target_schema.to_string()),
        ..Default::default()
    }
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MYSQL_URL pointing to MySQL 8.0+"]
async fn mysql_schema_diff_added_columns_keep_source_charset_and_collation() {
    let url = std::env::var("DBX_LIVE_MYSQL_URL").expect("DBX_LIVE_MYSQL_URL");
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source_db = format!("dbx_eval_11802_src_{}", &suffix[..8]);
    let target_db = format!("dbx_eval_11802_tgt_{}", &suffix[..8]);

    let pool = mysql::connect(&url, std::time::Duration::from_secs(10)).await.unwrap();
    let mut conn = mysql::get_conn_with_health_check(&pool).await.unwrap();
    for database in [&source_db, &target_db] {
        conn.query_drop(format!("CREATE DATABASE `{database}` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"))
            .await
            .unwrap();
    }
    conn.query_drop(format!(
        "CREATE TABLE `{source_db}`.t_1 (\
           id INT NOT NULL PRIMARY KEY, \
           name VARCHAR(64), \
           city VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci, \
           note TEXT CHARACTER SET latin1 COLLATE latin1_swedish_ci, \
           kind ENUM('a','b') CHARACTER SET utf8mb4 COLLATE utf8mb4_bin, \
           plain VARCHAR(32), \
           amount INT, \
           doc JSON)"
    ))
    .await
    .unwrap();
    conn.query_drop(format!("CREATE TABLE `{target_db}`.t_1 (id INT NOT NULL PRIMARY KEY, name VARCHAR(64))"))
        .await
        .unwrap();

    let source_columns = mysql::get_columns(&pool, &source_db, "t_1").await.unwrap();
    let target_columns = mysql::get_columns(&pool, &target_db, "t_1").await.unwrap();
    let prepared = prepare_schema_diff(diff_options(source_columns.clone(), target_columns, &target_db));
    // The schema diff dialog rebuilds the deploy script from the selected diffs, so
    // that plan is the script the user actually executes.
    let client_sql = generate_schema_sync_sql_plan(
        &prepared.diffs,
        &[],
        &[],
        &[],
        &[],
        DatabaseType::Mysql,
        Some(&target_db),
        false,
        Some(DialectKind::Mysql),
        &[],
        false,
        false,
    )
    .sync_sql;
    println!("prepared sync SQL:\n{}\nclient sync SQL:\n{client_sql}", prepared.sync_sql);

    conn.query_drop(&client_sql).await.expect("execute DBX-generated ALTER TABLE");
    let applied: Vec<(String, Option<String>, Option<String>)> = conn
        .exec_map(
            "SELECT COLUMN_NAME, CHARACTER_SET_NAME, COLLATION_NAME FROM INFORMATION_SCHEMA.COLUMNS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 't_1' ORDER BY ORDINAL_POSITION",
            (&target_db,),
            |row| row,
        )
        .await
        .unwrap();
    println!("target columns after apply: {applied:?}");

    let recompared_target = mysql::get_columns(&pool, &target_db, "t_1").await.unwrap();
    let recompared = prepare_schema_diff(diff_options(source_columns, recompared_target, &target_db));
    println!("second comparison diffs: {:?}", recompared.diffs);

    for database in [&source_db, &target_db] {
        conn.query_drop(format!("DROP DATABASE `{database}`")).await.unwrap();
    }
    drop(conn);
    pool.disconnect().await.unwrap();

    let collation_of = |name: &str| {
        applied
            .iter()
            .find(|(column, _, _)| column == name)
            .map(|(_, charset, collation)| (charset.clone(), collation.clone()))
    };
    assert_eq!(collation_of("city"), Some((Some("utf8mb4".into()), Some("utf8mb4_general_ci".into()))));
    assert_eq!(collation_of("note"), Some((Some("latin1".into()), Some("latin1_swedish_ci".into()))));
    assert_eq!(collation_of("kind"), Some((Some("utf8mb4".into()), Some("utf8mb4_bin".into()))));
    assert_eq!(collation_of("plain"), Some((Some("utf8mb4".into()), Some("utf8mb4_0900_ai_ci".into()))));
    assert_eq!(collation_of("amount"), Some((None, None)));
    assert!(recompared.diffs.is_empty(), "second comparison must be clean: {:?}", recompared.diffs);
}
