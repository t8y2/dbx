//! SELECT-only MySQL regression. Run with DBX_LIVE_MYSQL_DATA_CHARSET_URL set
//! to a MySQL URL (prefer a SELECT-only account), then `cargo test -p
//! dbx-driver-mysql --test mysql_data_charset_live -- --ignored --nocapture`.
use dbx_driver_mysql::mysql::{self, MySqlQueryDialect, MySqlQueryStreamItem};
use mysql_async::prelude::Queryable;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

#[tokio::test]
#[ignore = "requires DBX_LIVE_MYSQL_DATA_CHARSET_URL and additive issue12458 long-key fixtures; SELECT only"]
async fn mysql_data_charset_original_keys_and_server_previews() {
    let url = std::env::var("DBX_LIVE_MYSQL_DATA_CHARSET_URL").expect("set DBX_LIVE_MYSQL_DATA_CHARSET_URL");
    let separator = if url.contains('?') { '&' } else { '?' };
    let pool = mysql::connect(&format!("{url}{separator}dataCharset=GBK"), Duration::from_secs(10)).await.unwrap();
    let mut conn = mysql::get_conn_with_health_check(&pool).await.unwrap();
    let dialect = MySqlQueryDialect::default();
    let sql = "SELECT legacy_key, part, LEFT(legacy_text,2) AS legacy_text, CONCAT('T:1:',LENGTH(legacy_text)) AS __DBX_LARGE_VALUE_BYTES_T_2 FROM legacy_long_keys WHERE legacy_key=CONVERT(_binary 0xD6D0CEC4 USING latin1) ORDER BY part";
    for bare in [false, true] {
        let result = mysql::execute_query_on_conn_with_limits_with_data_charset(
            &mut conn,
            sql,
            bare,
            Some(10),
            Some(32 * 1024),
            &[],
            dialect,
            None,
            pool.data_charset(),
        )
        .await
        .unwrap();
        assert_eq!(result.result.rows.len(), 2);
        assert_eq!(result.result.rows[0][0], "中文");
        assert_eq!(result.result.rows[0][2], "çÍ", "server preview carrier must reach core untouched");
        assert_eq!(result.result.raw_key_cells.len(), 4, "both original compound key cells per row");
        for row in 0..2 {
            let key = result
                .result
                .raw_key_cells
                .iter()
                .find(|cell| cell.row_index == row && cell.column_index == 0)
                .unwrap();
            assert_eq!(key.value, "ÖÐÎÄ");
            assert!(result.result.raw_key_cells.iter().any(|cell| cell.row_index == row && cell.column_index == 1));
        }
        let collisions = "SELECT legacy_key, LEFT(legacy_text,2) AS legacy_text, CONCAT('T:1:',LENGTH(legacy_text)) AS __DBX_LARGE_VALUE_BYTES_T_1 FROM legacy_key_collisions ORDER BY HEX(legacy_key)";
        let collision_result = mysql::execute_query_on_conn_with_limits_with_data_charset(
            &mut conn,
            collisions,
            bare,
            Some(10),
            Some(32 * 1024),
            &[],
            dialect,
            None,
            pool.data_charset(),
        )
        .await
        .unwrap();
        assert_eq!(collision_result.result.rows[0][0], collision_result.result.rows[1][0]);
        assert_eq!(collision_result.result.raw_key_cells.len(), 2);
        assert_ne!(collision_result.result.raw_key_cells[0].value, collision_result.result.raw_key_cells[1].value);
        let query = "SELECT legacy_key, part FROM legacy_long_keys ORDER BY legacy_key, part";
        let bounded = mysql::execute_query_on_conn_with_limits_with_data_charset(
            &mut conn,
            query,
            bare,
            Some(10),
            Some(230),
            &[],
            dialect,
            None,
            pool.data_charset(),
        )
        .await
        .unwrap();
        assert!(bounded.result.truncated);
        assert!(!bounded.result.rows.is_empty());
        assert_eq!(bounded.result.raw_key_cells.len(), bounded.result.rows.len() * 2);
        assert!(bounded.result.raw_key_cells.iter().all(|cell| cell.row_index < bounded.result.rows.len()));
        let error = mysql::execute_query_on_conn_with_limits_with_data_charset(
            &mut conn,
            query,
            bare,
            Some(10),
            Some(1),
            &[],
            dialect,
            None,
            pool.data_charset(),
        )
        .await
        .unwrap_err();
        assert!(error.contains("byte budget"));
    }
    drop(conn);
    pool.disconnect().await.unwrap();
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MYSQL_DATA_CHARSET_URL; executes only SELECT statements"]
async fn mysql_data_charset_real_engine_read_paths() {
    let url = std::env::var("DBX_LIVE_MYSQL_DATA_CHARSET_URL").expect("set DBX_LIVE_MYSQL_DATA_CHARSET_URL");
    let dialect = MySqlQueryDialect::default();
    for (codec, hex, expected) in [
        ("GBK", "e7cdb7d7b2cabae7", "缤纷彩虹"),
        ("GB18030", "d6d0cec49439fc36", "中文😀"),
        ("BIG5", "c163c5e9a4a4a4e5", "繁體中文"),
    ] {
        let separator = if url.contains('?') { '&' } else { '?' };
        let configured = format!("{url}{separator}dataCharset={codec}");
        let pool = mysql::connect(&configured, Duration::from_secs(10)).await.unwrap();
        let sql = format!("SELECT CONVERT(_binary 0x{hex} USING latin1) AS legacy_text, CONVERT(_binary 0xe4b8ade69687 USING utf8mb4) AS normal_text, _binary 0x{hex} AS raw_blob, NULL AS null_value, 'ASCII' AS ascii_value");
        for bare in [false, true] {
            let result = mysql::execute_query_with_max_rows(&pool, &sql, bare, None, dialect).await.unwrap();
            assert_eq!(result.rows[0][0], expected, "{codec} bare={bare}");
            assert_eq!(result.rows[0][1], "中文");
            assert_eq!(result.rows[0][2], format!("0x{hex}"));
            assert!(result.rows[0][3].is_null());
            assert_eq!(result.rows[0][4], "ASCII");
            let mut conn = mysql::get_conn_with_health_check(&pool).await.unwrap();
            let mut streamed = Vec::new();
            mysql::stream_query_result_on_conn_with_data_charset(
                &mut conn,
                &sql,
                bare,
                None,
                dialect,
                &AtomicBool::new(false),
                false,
                pool.data_charset(),
                |item| {
                    if let MySqlQueryStreamItem::Row(row) = item {
                        streamed.push(row);
                    }
                    Ok(())
                },
            )
            .await
            .unwrap();
            assert_eq!(streamed, result.rows, "stream {codec} bare={bare}");
            let long_sql = format!("SELECT REPEAT(CONVERT(_binary 0x{hex} USING latin1), 10000) AS long_text");
            let full = mysql::execute_query_on_conn_with_limits_with_data_charset(
                &mut conn,
                &long_sql,
                bare,
                Some(1),
                None,
                &[],
                dialect,
                None,
                pool.data_charset(),
            )
            .await
            .unwrap();
            assert_eq!(full.result.rows[0][0], expected.repeat(10000));
            let preview = mysql::execute_query_on_conn_with_limits_with_data_charset(
                &mut conn,
                &long_sql,
                bare,
                Some(1),
                Some(1024),
                &[],
                dialect,
                None,
                pool.data_charset(),
            )
            .await
            .unwrap();
            let text = preview.result.rows[0][0].as_str().unwrap();
            assert!(text.ends_with("..."));
            assert!(text.len() <= 1027);
            assert!(full.result.rows[0][0].as_str().unwrap().starts_with(text.strip_suffix("...").unwrap()));
            assert_eq!(preview.large_value_cells.len(), 1);
            let carrier_size: u64 = conn
                .query_first(format!(
                    "SELECT OCTET_LENGTH(CONVERT(CONVERT(_binary 0x{hex} USING latin1) USING utf8mb4)) * 10000"
                ))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(preview.large_value_cells[0].original_bytes, carrier_size as usize);
        }
        let mut conn = mysql::get_conn_with_health_check(&pool).await.unwrap();
        let session: (String, String, String) = conn
            .query_first("SELECT @@character_set_client, @@character_set_connection, @@character_set_results")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(session, ("utf8mb4".into(), "utf8mb4".into(), "utf8mb4".into()));
        let multi = format!("{sql}; {sql}");
        let results = mysql::execute_query_results_on_conn_with_limits_with_data_charset(
            &mut conn,
            &multi,
            true,
            None,
            None,
            &[],
            dialect,
            None,
            pool.data_charset(),
        )
        .await
        .unwrap();
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|result| result.result.rows[0][0] == expected));
        drop(conn);
        pool.disconnect().await.unwrap();
    }
}
