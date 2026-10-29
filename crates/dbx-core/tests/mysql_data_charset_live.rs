//! Read-only integration over the accepted issue #12458 fixture.
//!
//! Set DBX_LIVE_MYSQL_DATA_CHARSET_URL to a SELECT-only MySQL URL whose database
//! contains legacy_text(id, legacy_text, normal_utf8, raw_blob). This test never
//! creates or mutates database objects; other codec samples are SELECT literals.
//! cargo test -p dbx-core --no-default-features --features sqlite-bundled \
//!   --test mysql_data_charset_live -- --ignored --nocapture
use dbx_core::connection::AppState;
use dbx_core::models::connection::ConnectionConfig;
use dbx_core::query::{
    begin_manual_transaction, execute_in_manual_transaction, execute_in_manual_transaction_with_options,
    execute_multi_core_with_options_for_client, execute_sql_statement, rollback_manual_transaction,
    stream_rows_in_manual_transaction, ManualTransactionExecutionOptions, QueryExecutionOptions,
};
use dbx_core::query_result_export::{export_query_result_core, QueryResultExportRequest};
use dbx_core::table_export::{export_table_data_core, TableExportRequest};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;

fn config(opts: &mysql_async::Opts, id: &str, codec: Option<&str>) -> ConnectionConfig {
    serde_json::from_value(json!({
        "id":id, "name":id, "db_type":"mysql", "host":opts.ip_or_hostname(), "port":opts.tcp_port(),
        "username":opts.user().unwrap_or(""), "password":opts.pass().unwrap_or(""), "database":opts.db_name(),
        "url_params":codec.map(|codec| format!("dataCharset={codec}")), "keepalive_interval_secs":0,
        "connect_timeout_secs":5, "query_timeout_secs":30
    }))
    .unwrap()
}

fn assert_export(path: &Path, format: &str, expected: &str, rows: usize) {
    match format {
        "csv" => {
            let text = std::fs::read_to_string(path).unwrap();
            assert!(text.contains(expected), "CSV must contain interpreted text");
            assert_eq!(text.lines().count(), rows + 1);
            let mut reader = csv::Reader::from_path(path).unwrap();
            let column = reader.headers().unwrap().iter().position(|header| header == "legacy_text").unwrap();
            let values = reader.records().map(Result::unwrap).collect::<Vec<_>>();
            assert_eq!(&values[0][column], expected, "CSV must contain the complete value, not a prefix");
        }
        "json" => {
            let value: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            assert_eq!(value.as_array().unwrap().len(), rows);
            assert_eq!(value[0]["legacy_text"], expected);
        }
        "xlsx" => {
            let data = dbx_core::table_import::parse_xlsx_file(path.to_str().unwrap(), 100).unwrap();
            assert_eq!(data.total_rows, rows);
            let index = data.columns.iter().position(|column| column == "legacy_text").unwrap();
            assert_eq!(data.rows[0][index], expected);
        }
        _ => unreachable!(),
    }
}

#[tokio::test]
#[ignore = "requires SELECT-only issue12458 legacy_long_keys and legacy_key_collisions fixtures"]
async fn mysql_data_charset_core_pending_previews_and_original_key_collisions() {
    let url = std::env::var("DBX_LIVE_MYSQL_DATA_CHARSET_URL").expect("set SELECT-only fixture URL");
    let opts = mysql_async::Opts::from_url(&url).unwrap();
    let database = opts.db_name().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let storage = dbx_core::persistence::test_storage::open(&directory.path().join("state.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    for (id, codec) in [("default", None), ("GBK", Some("GBK"))] {
        state.configs.write().await.insert(id.into(), config(&opts, id, codec));
    }
    let stored_sql =
        "SELECT legacy_key,part,HEX(legacy_text),HEX(raw_blob) FROM legacy_long_keys ORDER BY legacy_key,part";
    let before = execute_sql_statement(&state, "default", database, stored_sql, None, None).await.unwrap().rows;
    let preview_sql = "SELECT LEFT(legacy_text,4) AS legacy_text, CONCAT('T:3:',LENGTH(legacy_text)) AS __DBX_LARGE_VALUE_BYTES_T_0, legacy_key, part FROM legacy_long_keys WHERE legacy_key=CONVERT(_binary 0xD6D0CEC4 USING latin1) ORDER BY part";
    for batch in [false, true] {
        let sql = if batch { format!("{preview_sql};{preview_sql}") } else { preview_sql.into() };
        let results = execute_multi_core_with_options_for_client(
            &state,
            "GBK",
            database,
            &sql,
            None,
            None,
            QueryExecutionOptions {
                table_data_preview: true,
                result_key_columns: vec!["legacy_key".into(), "part".into()],
                ..Default::default()
            },
        )
        .await
        .unwrap();
        for result in results {
            assert!(!result.execution_error);
            assert_eq!(result.result.rows.len(), 2);
            assert_eq!(result.large_value_cells.len(), 2);
            assert!(result.large_value_cells.iter().all(|cell| cell.pending_decode == Some(true)));
            assert_eq!(result.large_value_cells[0].original_bytes, 96000);
            assert_eq!(result.large_value_cells[1].original_bytes, 96001);
            assert_eq!(result.result.rows[0][0], "");
            assert_eq!(result.result.rows[0][1], "中文");
            assert_eq!(result.result.raw_key_cells.len(), 4);
            let key =
                result.result.raw_key_cells.iter().find(|cell| cell.row_index == 0 && cell.column_index == 1).unwrap();
            assert_eq!(key.value, "ÖÐÎÄ", "raw key must survive marker-column removal");
        }
    }
    let default_preview = execute_multi_core_with_options_for_client(
        &state,
        "default",
        database,
        preview_sql,
        None,
        None,
        QueryExecutionOptions { table_data_preview: true, ..Default::default() },
    )
    .await
    .unwrap();
    assert_eq!(default_preview[0].result.rows[0][0], "çÍ·...");
    assert!(default_preview[0].large_value_cells.iter().all(|cell| cell.pending_decode.is_none()));
    assert!(default_preview[0].result.raw_key_cells.is_empty());

    let full_sql = "SELECT legacy_key, part, legacy_text FROM legacy_long_keys WHERE legacy_key=CONVERT(_binary 0xD6D0CEC4 USING latin1) ORDER BY part";
    let full = execute_sql_statement(&state, "GBK", database, full_sql, None, None).await.unwrap();
    assert_eq!(full.rows[0][2], "缤纷彩虹".repeat(12000));
    assert_eq!(
        full.rows[1][2],
        format!("{}\u{81}", "çÍ·×²Êºç".repeat(12000)),
        "unseen invalid suffix must preserve the whole carrier"
    );
    assert_eq!(full.raw_key_cells.len(), 4);
    let collision = execute_sql_statement(
        &state,
        "GBK",
        database,
        "SELECT legacy_key,legacy_text FROM legacy_key_collisions ORDER BY legacy_key",
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(collision.rows.len(), 2);
    assert!(collision.rows.iter().all(|row| row[0] == "中文"));
    assert_eq!(collision.raw_key_cells.len(), 2);
    assert_ne!(collision.raw_key_cells[0].value, collision.raw_key_cells[1].value);
    assert_ne!(collision.rows[0][1], collision.rows[1][1]);

    let transaction = begin_manual_transaction(&state, "GBK", database, None, None).await.unwrap();
    let preview = execute_in_manual_transaction_with_options(
        &state,
        &transaction,
        preview_sql,
        database,
        None,
        ManualTransactionExecutionOptions { table_data_preview: true, ..Default::default() },
    )
    .await
    .unwrap();
    assert_eq!(preview[0].large_value_cells.len(), 2);
    assert!(preview[0].large_value_cells.iter().all(|cell| cell.pending_decode == Some(true)));
    assert_eq!(preview[0].result.raw_key_cells.len(), 4);
    let txn_full = execute_in_manual_transaction(&state, &transaction, full_sql, database, None, None).await.unwrap();
    assert_eq!(txn_full[0].rows, full.rows);
    assert_eq!(txn_full[0].raw_key_cells, full.raw_key_cells);
    for (row_index, part) in [(0, 1), (1, 2)] {
        let sql = format!("SELECT legacy_text FROM legacy_long_keys WHERE legacy_key=CONVERT(_binary 0xD6D0CEC4 USING latin1) AND part={part}");
        let expected = full.rows[row_index][2].as_str().unwrap();
        for format in ["csv", "json", "xlsx"] {
            for in_transaction in [false, true] {
                let destination = directory.path().join(format!("long-{part}-{in_transaction}.{format}"));
                let request: QueryResultExportRequest = serde_json::from_value(json!({
                    "exportId":format!("long-{part}-{format}-{in_transaction}"), "connectionId":"GBK",
                    "database":database, "sql":sql, "queryBaseSql":sql, "databaseType":"mysql",
                    "filePath":destination, "format":format, "pageSize":1,
                    "clientSessionId":format!("long-export-{part}-{format}-{in_transaction}"),
                    "txnSessionId":in_transaction.then_some(transaction.as_str())
                }))
                .unwrap();
                export_query_result_core(&state, &request, None, |_| {}).await.unwrap();
                assert_export(&destination, format, expected, 1);
            }
        }
    }
    rollback_manual_transaction(&state, &transaction).await.unwrap();

    for (codec, hex, expected) in [
        ("GBK", "e7cdb7d7b2cabae7", "缤纷彩虹"),
        ("GB18030", "d6d0cec49439fc36", "中文😀"),
        ("BIG5", "c163c5e9a4a4a4e5", "繁體中文"),
    ] {
        if codec != "GBK" {
            state.configs.write().await.insert(codec.into(), config(&opts, codec, Some(codec)));
        }
        for (limit, pending) in [(3, true), (100, false)] {
            let sql = format!("SELECT LEFT(CONVERT(_binary 0x{hex} USING latin1),{}) AS v, 'T:{limit}:8' AS __DBX_LARGE_VALUE_BYTES_T_0", limit + 1);
            let result = execute_multi_core_with_options_for_client(
                &state,
                codec,
                database,
                &sql,
                None,
                None,
                QueryExecutionOptions { table_data_preview: true, ..Default::default() },
            )
            .await
            .unwrap();
            if pending {
                assert_eq!(result[0].large_value_cells[0].pending_decode, Some(true));
            } else {
                assert!(result[0].large_value_cells.is_empty());
                assert_eq!(result[0].result.rows[0][0], expected);
            }
        }
    }
    let after = execute_sql_statement(&state, "default", database, stored_sql, None, None).await.unwrap().rows;
    assert_eq!(before, after);
    for id in ["default", "GBK", "GB18030", "BIG5"] {
        state.remove_connection_pools(id).await;
    }
    println!("server LEFT pending/complete, 3 codecs, invalid suffix, composite/raw colliding keys, single/batch/manual, default and HEX passed");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MYSQL_DATA_CHARSET_URL and the read-only issue12458 legacy_text fixture"]
async fn mysql_data_charset_core_query_transactions_and_display_exports() {
    let url = std::env::var("DBX_LIVE_MYSQL_DATA_CHARSET_URL").expect("set SELECT-only fixture URL");
    let opts = mysql_async::Opts::from_url(&url).expect("valid fixture URL");
    let database = opts.db_name().expect("fixture URL database");
    let directory = tempfile::tempdir().unwrap();
    let storage = dbx_core::persistence::test_storage::open(&directory.path().join("state.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    state.configs.write().await.insert("default".into(), config(&opts, "default", None));
    let stored_sql = "SELECT id, HEX(legacy_text), HEX(normal_utf8), HEX(raw_blob) FROM legacy_text ORDER BY id";
    let before = execute_sql_statement(&state, "default", database, stored_sql, None, None).await.unwrap().rows;
    assert_eq!(before.len(), 4, "use the accepted four-row fixture");
    let default_before = execute_sql_statement(
        &state,
        "default",
        database,
        "SELECT legacy_text, normal_utf8 FROM legacy_text WHERE id=1",
        None,
        None,
    )
    .await
    .unwrap()
    .rows;
    assert_ne!(default_before[0][0], "缤纷彩虹");
    assert_eq!(default_before[0][1], "缤纷彩虹");

    for (codec, hex, expected) in [
        ("GBK", "e7cdb7d7b2cabae7", "缤纷彩虹"),
        ("GB18030", "d6d0cec49439fc36", "中文😀"),
        ("BIG5", "c163c5e9a4a4a4e5", "繁體中文"),
    ] {
        state.configs.write().await.insert(codec.into(), config(&opts, codec, Some(codec)));
        let sql = format!("SELECT CONVERT(_binary 0x{hex} USING latin1) AS legacy_text, '中文' AS normal_text, _binary 0x{hex} AS raw_blob, NULL AS nullable, 'ASCII' AS ascii_text");
        let result = execute_sql_statement(&state, codec, database, &sql, None, None).await.unwrap();
        assert_eq!(result.rows[0][0], expected, "single raw-connection core path {codec}");
        assert_eq!(result.rows[0][1], "中文");
        assert_eq!(result.rows[0][2], format!("0x{hex}"));
        assert!(result.rows[0][3].is_null());
        assert_eq!(result.rows[0][4], "ASCII");
        let batch = execute_multi_core_with_options_for_client(
            &state,
            codec,
            database,
            &format!("{sql}; {sql}"),
            None,
            None,
            QueryExecutionOptions { client_session_id: Some(format!("legacy-tab-{codec}")), ..Default::default() },
        )
        .await
        .unwrap();
        assert_eq!(batch.len(), 2);
        assert!(batch.iter().all(|part| !part.execution_error && part.result.rows[0][0] == expected));

        let long_sql = format!("SELECT REPEAT(CONVERT(_binary 0x{hex} USING latin1),10000) AS legacy_text");
        let full = execute_sql_statement(&state, codec, database, &long_sql, None, None).await.unwrap();
        assert_eq!(full.rows[0][0], expected.repeat(10000), "complete-value read {codec}");

        let transaction = begin_manual_transaction(&state, codec, database, None, None).await.unwrap();
        let transaction_result =
            execute_in_manual_transaction(&state, &transaction, &sql, database, None, None).await.unwrap();
        assert_eq!(transaction_result[0].rows, result.rows, "manual direct converter {codec}");
        let mut streamed = Vec::new();
        stream_rows_in_manual_transaction(&state, &transaction, &sql, 1, |rows| {
            streamed.extend(rows);
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(streamed, result.rows, "manual transaction stream converter {codec}");

        for format in ["csv", "json", "xlsx"] {
            for in_transaction in [false, true] {
                let destination = directory.path().join(format!("{codec}-{in_transaction}.{format}"));
                let request: QueryResultExportRequest = serde_json::from_value(json!({
                    "exportId":format!("export-{codec}-{format}-{in_transaction}"), "connectionId":codec,
                    "database":database, "sql":sql, "queryBaseSql":sql, "databaseType":"mysql",
                    "filePath":destination, "format":format, "pageSize":1,
                    "clientSessionId":format!("export-tab-{codec}-{format}-{in_transaction}"),
                    "txnSessionId":in_transaction.then_some(transaction.as_str())
                }))
                .unwrap();
                export_query_result_core(&state, &request, None, |_| {}).await.unwrap();
                assert_export(&destination, format, expected, 1);
            }
        }
        rollback_manual_transaction(&state, &transaction).await.unwrap();
        let session = execute_sql_statement(
            &state,
            codec,
            database,
            "SELECT @@character_set_client, @@character_set_connection, @@character_set_results",
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(session.rows[0], vec![json!("utf8mb4"); 3]);
        println!("{codec}: single/batch/full/manual/stream and CSV/JSON/XLSX passed");
    }

    let browse = execute_sql_statement(
        &state,
        "GBK",
        database,
        "SELECT id, legacy_text, normal_utf8, raw_blob FROM legacy_text ORDER BY id",
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(browse.rows.len(), 4);
    assert_eq!(browse.rows[0][1], "缤纷彩虹");
    assert_eq!(browse.rows[1][1], "恶毒三角");
    for format in ["csv", "json", "xlsx"] {
        let destination = directory.path().join(format!("table.{format}"));
        let request: TableExportRequest = serde_json::from_value(json!({
            "exportId":format!("table-{format}"), "connectionId":"GBK", "database":database, "schema":database,
            "tableName":"legacy_text", "filePath":destination, "format":format, "orderBy":"id", "batchSize":2
        }))
        .unwrap();
        export_table_data_core(&state, &request, |_| {}).await.unwrap();
        assert_export(&destination, format, "缤纷彩虹", 4);
    }

    let after = execute_sql_statement(&state, "default", database, stored_sql, None, None).await.unwrap().rows;
    assert_eq!(before, after, "SELECT-only validation must leave all original stored bytes unchanged");
    let default_after = execute_sql_statement(
        &state,
        "default",
        database,
        "SELECT legacy_text, normal_utf8 FROM legacy_text WHERE id=1",
        None,
        None,
    )
    .await
    .unwrap()
    .rows;
    assert_eq!(default_before, default_after, "opt-in must not affect the ordinary pool");
    for id in ["default", "GBK", "GB18030", "BIG5"] {
        state.remove_connection_pools(id).await;
    }
    println!("table CSV/JSON/XLSX and fixture HEX/default controls passed; no database writes performed");
}
