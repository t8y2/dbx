use std::time::Duration;

use dbx_core::db;

#[tokio::test]
#[ignore = "requires DBX_TEST_QUESTDB_URL pointing at a writable QuestDB database"]
async fn questdb_lists_tables_across_metadata_generations() {
    let url = std::env::var("DBX_TEST_QUESTDB_URL").expect("DBX_TEST_QUESTDB_URL");
    let pool = db::postgres::connect(&url, Duration::from_secs(10)).await.expect("connect QuestDB");
    let table = format!("dbx_questdb_82_{}", uuid::Uuid::new_v4().simple());

    db::postgres::execute_query(
        &pool,
        &format!("CREATE TABLE {table} (ts TIMESTAMP, value DOUBLE) TIMESTAMP(ts) PARTITION BY DAY WAL"),
    )
    .await
    .expect("create QuestDB fixture");

    let exercise = async {
        let tables = db::questdb::list_tables(&pool, "public").await?;
        let listed = tables.iter().find(|candidate| candidate.name == table).ok_or("fixture table was not listed")?;
        assert_eq!(listed.table_type, "TABLE");

        let columns = db::questdb::get_columns(&pool, "public", &table).await?;
        assert_eq!(columns.iter().map(|column| column.name.as_str()).collect::<Vec<_>>(), vec!["ts", "value"]);
        Ok::<_, String>(())
    }
    .await;

    db::postgres::execute_query(&pool, &format!("DROP TABLE {table}")).await.expect("drop QuestDB fixture");
    exercise.expect("list QuestDB table metadata");
}
