use dbx_drivers::db::sqlserver::{self, SqlServerStreamItem};
use dbx_drivers::models::connection::DatabaseType;
use dbx_sql_data::data_grid_sql::format_grid_sql_literal;
use serde_json::Value;
use std::time::Duration;

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD for a remote SQL Server"]
async fn live_sqlserver_issue_9984_real_round_trip() {
    let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").expect("DBX_LIVE_SQLSERVER_HOST");
    let port = std::env::var("DBX_LIVE_SQLSERVER_PORT").expect("DBX_LIVE_SQLSERVER_PORT").parse().unwrap();
    let user = std::env::var("DBX_LIVE_SQLSERVER_USER").expect("DBX_LIVE_SQLSERVER_USER");
    let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");
    let database = std::env::var("DBX_LIVE_SQLSERVER_DATABASE").unwrap_or_else(|_| "tempdb".to_string());
    let mut client = sqlserver::connect_with_port_explicit(
        &host,
        port,
        true,
        &user,
        &password,
        Some(&database),
        Duration::from_secs(15),
    )
    .await
    .expect("connect to remote SQL Server");
    let version = sqlserver::execute_query(&mut client, "SELECT @@VERSION AS server_version").await.unwrap();
    println!("Server version: {}", version.rows[0][0]);

    client
        .simple_query("CREATE TABLE #dbx_issue_9984_real (id int NOT NULL, WDZ real, SDZ float(24))")
        .await
        .unwrap()
        .into_results()
        .await
        .unwrap();
    let values = [
        ("18.2", 18.2_f32),
        ("18.3", 18.3),
        ("59.3", 59.3),
        ("4.6", 4.6),
        ("-18.2", -18.2),
        ("-59.3", -59.3),
        ("18.5", 18.5),
        ("0", 0.0),
        ("1e-20", 1.0e-20),
        ("1e20", 1.0e20),
        ("1.2345678", 1.2345678),
    ];
    for (index, (literal, _)) in values.iter().enumerate() {
        client
            .execute(format!("INSERT INTO #dbx_issue_9984_real VALUES ({index}, {literal}, {literal})"), &[])
            .await
            .unwrap();
    }
    client.execute("INSERT INTO #dbx_issue_9984_real VALUES (99, NULL, NULL)", &[]).await.unwrap();

    let raw_sql = "SELECT id, WDZ, SDZ FROM #dbx_issue_9984_real ORDER BY id";
    let raw = client.query(raw_sql, &[]).await.unwrap().into_first_result().await.unwrap();
    assert_eq!(raw.len(), values.len() + 1);
    for (row, (_, expected)) in raw.iter().zip(&values) {
        assert_eq!(row.get::<f32, _>(1).unwrap().to_bits(), expected.to_bits());
        assert_eq!(row.get::<f32, _>(2).unwrap().to_bits(), expected.to_bits());
    }
    println!(
        "Raw f32 widened to f64: {:?}",
        raw.iter().take(4).map(|row| f64::from(row.get::<f32, _>(1).unwrap())).collect::<Vec<_>>()
    );

    let select = "SELECT id, WDZ, SDZ, \
        CAST(18.200000762939453 AS float(53)) AS double_value, \
        CAST(1.2345678901234567 AS float) AS default_float, \
        CAST(18.200 AS decimal(10, 3)) AS decimal_value, \
        CAST(1234567890123456789012345678.9012345678 AS numeric(38, 10)) AS numeric_value, \
        CAST(7 AS tinyint) AS tiny_value, CAST(9223372036854775807 AS bigint) AS big_value, \
        CAST('18.200000762939453' AS nvarchar(30)) AS text_value, \
        CAST(NULL AS float) AS null_float \
        FROM #dbx_issue_9984_real ORDER BY id";
    let result = sqlserver::execute_query(&mut client, select).await.unwrap();
    assert_eq!(result.rows.len(), values.len() + 1);
    assert_eq!(&result.column_types[1..3], &["float4", "float4"]);
    for (row, (_, expected)) in result.rows.iter().zip(&values) {
        for converted in &row[1..3] {
            assert!(converted.is_number());
            assert_eq!(converted.to_string(), serde_json::to_string(expected).unwrap());
            assert_eq!((converted.as_f64().unwrap() as f32).to_bits(), expected.to_bits());
        }
        assert_eq!(row[3], serde_json::json!(18.200000762939453_f64));
        assert_eq!(row[4], serde_json::json!(1.2345678901234567_f64));
        assert_eq!(row[5], serde_json::json!("18.200"));
        assert_eq!(row[6], serde_json::json!("1234567890123456789012345678.9012345678"));
        assert_eq!(row[7], serde_json::json!(7));
        assert_eq!(row[8], serde_json::json!("9223372036854775807"));
        assert_eq!(row[9], serde_json::json!("18.200000762939453"));
        assert_eq!(row[10], Value::Null);
    }
    assert_eq!(&result.rows.last().unwrap()[1..3], &[Value::Null, Value::Null]);
    println!("Converted reported rows: {}", serde_json::to_string(&result.rows[..4]).unwrap());

    let batches = sqlserver::execute_batch(&mut client, &format!("{select}; {select}")).await.unwrap();
    let row_sets: Vec<_> = batches.iter().filter(|batch| !batch.columns.is_empty()).collect();
    assert_eq!(row_sets.len(), 2);
    for batch in row_sets {
        assert_eq!(batch.rows, result.rows);
    }
    let simple_batches = sqlserver::execute_simple_batch_with_max_rows(&mut client, select, None).await.unwrap();
    assert_eq!(simple_batches.iter().find(|batch| !batch.columns.is_empty()).unwrap().rows, result.rows);

    let mut streamed_rows = Vec::new();
    let summary = sqlserver::stream_first_result_set(&mut client, select, None, None, |item| {
        match item {
            SqlServerStreamItem::Columns { columns, column_types } => {
                assert_eq!(columns, result.columns);
                assert_eq!(column_types, result.column_types);
            }
            SqlServerStreamItem::Row(row) => streamed_rows.push(row.to_vec()),
        }
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(streamed_rows, result.rows);
    assert_eq!(summary.rows_exported, result.rows.len() as u64);
    let serialized = serde_json::to_string(&streamed_rows).unwrap();
    assert_eq!(serde_json::from_str::<Vec<Vec<Value>>>(&serialized).unwrap(), result.rows);

    for row in &result.rows[..values.len()] {
        let wdz = format_grid_sql_literal(&row[1], Some(DatabaseType::SqlServer), None);
        let sdz = format_grid_sql_literal(&row[2], Some(DatabaseType::SqlServer), None);
        let update = format!("UPDATE #dbx_issue_9984_real SET WDZ = {wdz}, SDZ = {sdz} WHERE id = {}", row[0]);
        assert_eq!(sqlserver::execute_query(&mut client, &update).await.unwrap().affected_rows, 1);
    }
    let reread = client.query(raw_sql, &[]).await.unwrap().into_first_result().await.unwrap();
    assert_eq!(reread.len(), raw.len());
    for (before, after) in raw.iter().zip(&reread) {
        for column in [1, 2] {
            assert_eq!(before.get::<f32, _>(column).map(f32::to_bits), after.get::<f32, _>(column).map(f32::to_bits));
        }
    }
    assert!(sqlserver::execute_query(&mut client, "SELECT CAST('not-a-number' AS real)").await.is_err());
    let recovered = sqlserver::execute_query(&mut client, select).await.unwrap();
    assert_eq!(recovered.rows, result.rows);
    println!(
        "Verified query, RPC batch, simple batch, stream export, JSON, numeric SQL write-back, and error recovery"
    );
}
