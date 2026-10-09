use super::*;

#[test]
fn legacy_encoding_url_parameters_are_local_and_strict() {
    let parsed = postgres_connection_url(
        "postgres://localhost/db?clientEncoding=GB18030&serverEncoding=ISO%2D8859%2D1&sslmode=disable&application_name=test"
    ).unwrap();
    assert_eq!(parsed.text_encoding, Some(TextEncoding(encoding_rs::GB18030)));
    assert_eq!(parsed.url, "postgres://localhost/db?sslmode=disable&application_name=test");
    for params in [
        "clientEncoding=GB18030",
        "serverEncoding=LATIN1",
        "clientEncoding=GB18030&serverEncoding=UTF8",
        "clientEncoding=garbage&serverEncoding=LATIN1",
        "clientEncoding=GB18030&clientEncoding=GBK&serverEncoding=LATIN1",
    ] {
        assert!(postgres_connection_url(&format!("postgres://localhost/db?{params}")).is_err(), "{params}");
    }
}

/// Runs against an isolated real LATIN1 PostgreSQL database. CI can opt in by
/// supplying DBX_TEST_POSTGRES_LATIN1_URL; the local verification uses the same
/// public native-driver functions as DBX's query and table-data paths.
#[tokio::test]
async fn legacy_encoding_live_read_filter_write_metadata_and_export() {
    let Ok(base) = std::env::var("DBX_TEST_POSTGRES_LATIN1_URL") else {
        return;
    };
    let sep = if base.contains('?') { '&' } else { '?' };
    let url = format!("{base}{sep}clientEncoding=GB18030&serverEncoding=ISO-8859-1");
    let pool = connect_with_max_connections(&url, Duration::from_secs(5), 1).await.unwrap();
    let client = pool.get().await.unwrap();
    client
        .batch_execute(
            "CREATE TEMP TABLE encoding_fixture(id int, value varchar(80)); INSERT INTO encoding_fixture VALUES
        (1, convert_from(decode('b4fbbcc7bfa8b7d6c6dad3a6b8b6bfeecfee','hex'),'LATIN1')),
        (2, convert_from(decode('455443bfa8','hex'),'LATIN1'));",
        )
        .await
        .unwrap();
    let raw: String = client.query_one("SELECT value FROM encoding_fixture WHERE id=2", &[]).await.unwrap().get(0);
    assert_eq!(raw, "ETC¿¨");
    let codec = EncodingClient::new(&client);
    assert!(codec.encoding.is_some());
    let value = "中文😀乗\\folder'quote";
    let row = codec
        .query_one(
            "SELECT $1::varchar(80), $2::text[], $3::jsonb, $4::bytea, $5::int",
            &[
                &value,
                &vec![Some(value), None],
                &serde_json::json!({"中文": [value, null, 42]}),
                &vec![0x81u8, 0x5c, 0xff],
                &42i32,
            ],
        )
        .await
        .unwrap();
    assert_eq!(row.try_get::<_, String>(0).unwrap(), value);
    assert_eq!(row.try_get::<_, Vec<Option<String>>>(1).unwrap(), vec![Some(value.into()), None]);
    assert_eq!(row.try_get::<_, serde_json::Value>(2).unwrap(), serde_json::json!({"中文":[value,null,42]}));
    assert_eq!(row.try_get::<_, Vec<u8>>(3).unwrap(), vec![0x81, 0x5c, 0xff]);
    assert_eq!(row.try_get::<_, i32>(4).unwrap(), 42);
    drop(client);

    let result =
        execute_query(&pool, "SELECT id,value AS 中文别名 FROM encoding_fixture WHERE value='ETC卡'").await.unwrap();
    assert_eq!(result.columns, vec!["id", "中文别名"]);
    assert_eq!(result.rows, vec![vec![serde_json::json!(2), serde_json::json!("ETC卡")]]);
    execute_query(&pool, "UPDATE encoding_fixture SET value='中文😀乗\\folder' WHERE id=2").await.unwrap();
    let result = execute_query(&pool, "SELECT value FROM encoding_fixture WHERE id=2").await.unwrap();
    assert_eq!(result.rows[0][0], "中文😀乗\\folder");

    let client = pool.get().await.unwrap();
    let raw: String = client
        .query_one("SELECT encode(convert_to(value,'LATIN1'),'hex') FROM encoding_fixture WHERE id=2", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(raw, "d6d0cec49439fc36815c5c666f6c646572");
    let result =
        execute_select_query_unnamed(&client, "SELECT value FROM encoding_fixture WHERE id=2", Instant::now(), 10)
            .await
            .unwrap();
    assert_eq!(result.rows[0][0], "中文😀乗\\folder");
    let result = execute_select_text(
        &client,
        "SELECT value FROM encoding_fixture WHERE id=2",
        Instant::now(),
        10,
        Some(vec!["varchar".into()]),
        None,
    )
    .await
    .unwrap();
    assert_eq!(result.rows[0][0], "中文😀乗\\folder");
    let result = execute_select_query(&client, "SELECT E'乗\\\\folder'", Instant::now(), 10).await.unwrap();
    assert_eq!(result.rows[0][0], "乗\\folder");
    let result =
        execute_select_query(&client, "SELECT '{\"中文\":\"乗😀\"}'::jsonb", Instant::now(), 10).await.unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(result.rows[0][0].as_str().unwrap()).unwrap(),
        serde_json::json!({"中文":"乗😀"})
    );
    drop(client);

    copy_in(
        &pool,
        "COPY encoding_fixture (id,value) FROM STDIN WITH (FORMAT text)",
        "3\t乗\\\\folder\\t中文\\n😀\n".as_bytes(),
    )
    .await
    .unwrap();
    let result = execute_query(&pool, "SELECT value FROM encoding_fixture WHERE id=3").await.unwrap();
    assert_eq!(result.rows[0][0], "乗\\folder\t中文\n😀");
    let mut exported = Vec::new();
    stream_query_rows(&pool, "SELECT value FROM encoding_fixture ORDER BY id", None, &AtomicBool::new(false), |row| {
        exported.push(row.to_vec());
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(exported.len(), 3);
    assert_eq!(exported[0][0], "贷记卡分期应付款项");

    execute_batch(
        &pool,
        &["CREATE TEMP TABLE 中文表 (中文列 varchar(80)); COMMENT ON COLUMN 中文表.中文列 IS '中文注释'".into()],
    )
    .await
    .unwrap();
    let client = pool.get().await.unwrap();
    let schema: String =
        client.query_one("SELECT nspname FROM pg_namespace WHERE oid=pg_my_temp_schema()", &[]).await.unwrap().get(0);
    drop(client);
    let columns = get_columns(&pool, &schema, "中文表").await.unwrap();
    assert_eq!(columns[0].name, "中文列");
    assert_eq!(columns[0].comment.as_deref(), Some("中文注释"));
    let error = execute_query(&pool, "SELECT 'caf'||chr(233)").await.unwrap_err();
    assert!(error.contains("Invalid gb18030 bytes"), "{error}");

    let normal = connect_with_max_connections(&base, Duration::from_secs(5), 1).await.unwrap();
    let result = execute_query(&normal, "SELECT 'caf'||chr(233),current_setting('client_encoding')").await.unwrap();
    assert_eq!(result.rows[0][0], "café");
    assert_eq!(result.rows[0][1], "UTF8");
}

#[tokio::test]
async fn legacy_encoding_live_rejects_utf8_server_and_preserves_normal_utf8() {
    let Ok(base) = std::env::var("DBX_TEST_POSTGRES_UTF8_URL") else {
        return;
    };
    let normal = connect(&base, Duration::from_secs(5)).await.unwrap();
    let result = execute_query(&normal, "SELECT '中文😀'::varchar(80)").await.unwrap();
    assert_eq!(result.rows[0][0], "中文😀");
    let sep = if base.contains('?') { '&' } else { '?' };
    let configured = format!("{base}{sep}clientEncoding=GB18030&serverEncoding=ISO-8859-1");
    let error = connect(&configured, Duration::from_secs(5)).await.unwrap_err();
    assert!(error.contains("requires a LATIN1 database; server reports UTF8"), "{error}");
}
