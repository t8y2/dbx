//! Opt-in native SQL Server 2000 compatibility acceptance; never routes through JDBC.
use dbx_driver_sqlserver as native;
use futures::FutureExt;
use std::panic::AssertUnwindSafe;
use std::time::Duration;

#[tokio::test]
#[ignore = "requires an explicit SQL Server 2000 test endpoint"]
async fn native_sqlserver_2000_connects_and_checks_manual_transaction_state() {
    let host = std::env::var("DBX_TEST_SQLSERVER_HOST").unwrap();
    let port = std::env::var("DBX_TEST_SQLSERVER_PORT").unwrap().parse().unwrap();
    let password = std::env::var("DBX_TEST_SQLSERVER_PASSWORD").unwrap();
    let connected = AssertUnwindSafe(native::connect_with_port_explicit(
        &host,
        port,
        true,
        "sa",
        &password,
        Some("dbx_manual_test"),
        Duration::from_secs(10),
    ))
    .catch_unwind()
    .await;
    let mut client = connected.expect("native TDS handshake must not panic").expect("native TDS handshake failed");
    let info = native::execute_simple_batch_with_max_rows(
        &mut client,
        "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)), @@TRANCOUNT",
        Some(1),
    )
    .await
    .unwrap();
    assert!(info[0].rows[0][0].as_str().unwrap().starts_with("8."));
    println!("Native server diagnostics: {:?}", info[0].rows);
    let rpc = client.query("SELECT @P1 AS value", &[&42i32]).await.unwrap().into_row().await.unwrap().unwrap();
    assert_eq!(rpc.get::<i32, _>(0), Some(42));
    assert_eq!(
        native::manual_transaction_status(&mut client).await.unwrap(),
        native::ManualTransactionStatus { count: 0, xact_state: None }
    );
    native::execute_simple_batch_with_max_rows(&mut client, "BEGIN TRANSACTION", Some(1)).await.unwrap();
    assert_eq!(
        native::manual_transaction_status(&mut client).await.unwrap(),
        native::ManualTransactionStatus { count: 1, xact_state: None }
    );
    native::execute_simple_batch_with_max_rows(&mut client, "ROLLBACK TRANSACTION", Some(1)).await.unwrap();
    assert_eq!(
        native::manual_transaction_status(&mut client).await.unwrap(),
        native::ManualTransactionStatus { count: 0, xact_state: None }
    );
}
#[tokio::test]
#[ignore = "requires an explicit SQL Server 2000 test endpoint"]
async fn native_sqlserver_2000_rpc_handles_long_unicode_binary_and_nulls() {
    let host = std::env::var("DBX_TEST_SQLSERVER_HOST").unwrap();
    let port = std::env::var("DBX_TEST_SQLSERVER_PORT").unwrap().parse().unwrap();
    let password = std::env::var("DBX_TEST_SQLSERVER_PASSWORD").unwrap();
    let mut client = native::connect_with_port_explicit(
        &host,
        port,
        true,
        "sa",
        &password,
        Some("dbx_manual_test"),
        Duration::from_secs(10),
    )
    .await
    .unwrap();
    for count in [1400, 4001] {
        let text = "\u{4e2d}".repeat(count);
        let row = client.query("SELECT DATALENGTH(@P1)", &[&text]).await.unwrap().into_row().await.unwrap().unwrap();
        assert_eq!(row.get::<i32, _>(0), Some((count * 2) as i32));
    }
    let binary = vec![0x5au8; 8001];
    let row =
        client.query("SELECT DATALENGTH(@P1)", &[&binary.as_slice()]).await.unwrap().into_row().await.unwrap().unwrap();
    assert_eq!(row.get::<i32, _>(0), Some(8001));
    let null_text: Option<&str> = None;
    let null_binary: Option<&[u8]> = None;
    let row = client
        .query("SELECT CASE WHEN @P1 IS NULL AND @P2 IS NULL THEN 1 ELSE 0 END", &[&null_text, &null_binary])
        .await
        .unwrap()
        .into_row()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.get::<i32, _>(0), Some(1));
    let sql = format!("/*{}*/ SELECT 7", "x".repeat(5000));
    let row = client.query(sql, &[]).await.unwrap().into_row().await.unwrap().unwrap();
    assert_eq!(row.get::<i32, _>(0), Some(7));
    let results = native::execute_simple_batch_with_max_rows(&mut client,
        "CREATE TABLE #lob (a text, b ntext, c image); INSERT INTO #lob VALUES ('abc', N'xyz', 0x0102); SELECT a,b,c FROM #lob; DROP TABLE #lob", Some(2)).await.unwrap();
    let result = results.iter().find(|result| result.columns == vec!["a", "b", "c"]).unwrap();
    assert_eq!(result.rows[0][0], serde_json::json!("abc"));
    assert_eq!(result.rows[0][1], serde_json::json!("xyz"));
    assert!(!result.rows[0][2].is_null());
}
