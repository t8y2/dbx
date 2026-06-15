#[tokio::test]
#[ignore = "requires the remote DBX MySQL 5.7 smoke-test container"]
async fn live_mysql57_text_protocol_select_succeeds() {
    let url = std::env::var("DBX_LIVE_MYSQL57_URL").expect("DBX_LIVE_MYSQL57_URL");

    let pool = dbx_core::db::mysql::connect(&url, std::time::Duration::from_secs(5)).await.unwrap();
    let result = dbx_core::db::mysql::execute_query_with_max_rows(
        &pool,
        "SELECT 1 AS id, CAST('mysql57' AS CHAR) AS label",
        false,
        Some(10),
        Default::default(),
    )
    .await
    .unwrap();

    assert_eq!(result.columns, vec!["id", "label"]);
    assert_eq!(result.rows, vec![vec![serde_json::json!("1"), serde_json::json!("mysql57")]]);
}
