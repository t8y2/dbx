//! Opt-in synthetic extended-type regression. No committed connection secrets.
use dbx_core::connection::AppState;
use dbx_core::models::connection::ConnectionConfig;
use dbx_core::transfer::{execute_on_pool, execute_read_on_pool, transfer_table_with_result, TransferRequest};
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, sync::Arc};

fn config(variable: &str, id: &str) -> ConnectionConfig {
    let mut v: Value = serde_json::from_str(&std::env::var(variable).expect(variable)).unwrap();
    v["id"] = json!(id);
    v["name"] = json!(id);
    serde_json::from_value(v).unwrap()
}

#[tokio::test]
#[ignore = "requires disposable native PostgreSQL and Xugu connections"]
async fn live_postgres_xugu_extended_types() {
    let source = config("DBX_LIVE_PG_XUGU_SOURCE_CONFIG", "pg-ext-source");
    let target = config("DBX_LIVE_PG_XUGU_TARGET_CONFIG", "pg-ext-target");
    let target_schema = std::env::var("DBX_LIVE_PG_XUGU_TARGET_SCHEMA").unwrap();
    let suffix = &uuid::Uuid::new_v4().simple().to_string()[..8];
    let source_schema = format!("dbx_px_ext_{suffix}");
    let table = format!("DBX_PX_EXT_{suffix}");
    let dir = tempfile::tempdir().unwrap();
    let storage = dbx_core::persistence::test_storage::open(&dir.path().join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
        storage,
        dir.path().join("plugins"),
        PathBuf::from(std::env::var("DBX_LIVE_PG_XUGU_AGENT_DIR").unwrap()),
        env!("CARGO_PKG_VERSION"),
    ));
    {
        let mut c = state.configs.write().await;
        c.insert(source.id.clone(), source.clone());
        c.insert(target.id.clone(), target.clone());
    }
    let sp = state.get_or_create_pool(&source.id, source.database.as_deref()).await.unwrap();
    let tp = state.get_or_create_pool(&target.id, target.database.as_deref()).await.unwrap();
    if let Some(dbx_core::connection::PoolKind::Postgres(pool)) = state.pool_handle(&sp).await {
        pool.resize(1);
    }
    execute_on_pool(&state, &sp, "SET TimeZone TO 'America/New_York'").await.unwrap();
    execute_on_pool(&state, &sp, "SET DateStyle TO 'SQL, DMY'").await.unwrap();
    execute_on_pool(&state, &sp, "SET IntervalStyle TO 'iso_8601'").await.unwrap();
    execute_on_pool(&state, &sp, &format!("CREATE SCHEMA \"{source_schema}\"")).await.unwrap();
    let src = format!("\"{source_schema}\".\"{table}\"");
    let dst = format!("\"{target_schema}\".\"{table}\"");
    execute_on_pool(&state,&sp,&format!("CREATE TABLE {src}(\"id\" INTEGER PRIMARY KEY,\"t\" TIME,\"t4\" TIME(4),\"tz\" TIMESTAMPTZ(6),\"tt\" TIMETZ(3),\"b\" BIT(8),\"vb\" VARBIT(17),\"uvb\" VARBIT,\"x\" XML,\"n\" NAME,\"jp\" JSONPATH,\"xidv\" XID,\"ym\" INTERVAL YEAR TO MONTH,\"mo\" INTERVAL MONTH,\"ds\" INTERVAL DAY TO SECOND(6),\"se\" INTERVAL SECOND(6))")).await.unwrap();
    execute_on_pool(&state,&sp,&format!(r#"INSERT INTO {src} VALUES
      (1,'12:34:56.123456','01:02:03.1234','2026-03-08 01:59:59.123456-05','12:34:56.123-03:30',B'00000001',B'000101',B'','<a/>text<b/>','中文_name','$.* ? (@ > 1)','4294967295','-1 year -2 months','14 months','-2 days -3 hours -4 minutes -5.123456 seconds','0.000001 seconds'),
      (2,'24:00:00','00:00:00','2026-03-08 03:00:00.000001-04','23:59:59.999+14:59',B'11111111',B'',NULL,'<?xml version="1.0"?><a p="quote''s">\path &amp; x</a>','',NULL,'0','99999999 years 11 months','-1199999999 months','999999 days 23:59:59.999999','-0.000001 seconds'),
      (3,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
      (4,NULL,NULL,NULL,NULL,B'00000000',B'00000000000000001',CAST(repeat('01',30000) AS varbit),NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)
    "#)).await.unwrap();
    let make_request = |name: &str| -> TransferRequest {
        serde_json::from_value(json!({
        "transferId":uuid::Uuid::new_v4().to_string(),"sourceConnectionId":source.id,"sourceDatabase":source.database,"sourceSchema":source_schema,
        "targetConnectionId":target.id,"targetDatabase":target.database,"targetSchema":target_schema,"tables":[name],"createTable":true,"objects":[],
        "content":"structureAndData","mode":"append","targetTableNameCase":"preserve","targetColumnNameCase":"preserve","quoteTargetColumnNames":true,"ownershipPolicy":"preserve","batchSize":2
    })).unwrap()
    };
    let transfer = make_request(&table);
    let result = transfer_table_with_result(
        &state,
        &transfer,
        &table,
        0,
        &source.db_type,
        &target.db_type,
        &sp,
        &tp,
        &HashMap::new(),
        &mut Vec::new(),
        None,
        false,
        |_| {},
        |_| {},
    )
    .await
    .unwrap();
    assert_eq!(result.moved_rows, 4);
    let rows=execute_read_on_pool(&state,&tp,&format!(r#"SELECT CAST("t" AS VARCHAR(80)),CAST("t4" AS VARCHAR(80)),TO_CHAR("tz",'YYYY-MM-DD HH24:MI:SS.SSSSSS TZH:TZM'),CAST("tt" AS VARCHAR(80)),RTRIM(CAST("b" AS VARCHAR(80))),RTRIM(CAST("vb" AS VARCHAR(80))),LENGTH("uvb"),CAST("x" AS VARCHAR(500)),"n","jp",CAST("xidv" AS VARCHAR(80)),CAST("ym" AS VARCHAR(80)),CAST("mo" AS VARCHAR(80)),CAST("ds" AS VARCHAR(80)),CAST("se" AS VARCHAR(80)) FROM {dst} WHERE "id"=1"#)).await.unwrap().rows;
    assert_eq!(
        rows,
        vec![vec![
            json!("12:34:56.123456"),
            json!("1:02:03.1234"),
            json!("2026-03-08 06:59:59.123456 -00:00"),
            json!("12:34:56.123-03:30"),
            json!("00000001"),
            json!("000101"),
            json!(0),
            json!("<a/>text<b/>"),
            json!("中文_name"),
            execute_read_on_pool(&state, &sp, &format!("SELECT \"jp\"::text FROM {src} WHERE \"id\"=1"))
                .await
                .unwrap()
                .rows[0][0]
                .clone(),
            json!("4294967295"),
            json!("-1-2"),
            json!("1-2"),
            json!("-2 3:04:05.123456"),
            json!("0:00:00.000001")
        ]]
    );
    let edge=execute_read_on_pool(&state,&tp,&format!(r#"SELECT CAST("t" AS VARCHAR(80)),TO_CHAR("tz",'YYYY-MM-DD HH24:MI:SS.SSSSSS TZH:TZM'),CAST("x" AS VARCHAR(500)),CAST("ym" AS VARCHAR(80)),CAST("mo" AS VARCHAR(80)),CAST("ds" AS VARCHAR(80)),CAST("se" AS VARCHAR(80)) FROM {dst} WHERE "id"=2"#)).await.unwrap().rows;
    assert_eq!(
        edge,
        vec![vec![
            json!("24:00:00"),
            json!("2026-03-08 07:00:00.000001 -00:00"),
            json!("<?xml version=\"1.0\"?><a p=\"quote's\">\\path &amp; x</a>"),
            json!("99999999-11"),
            json!("-99999999-11"),
            json!("999999 23:59:59.999999"),
            json!("-0:00:00.000001")
        ]]
    );
    let nulls =
        execute_read_on_pool(&state, &tp, &format!("SELECT \"t\",\"tz\",\"b\",\"x\",\"ds\" FROM {dst} WHERE \"id\"=3"))
            .await
            .unwrap()
            .rows;
    assert!(nulls[0].iter().all(Value::is_null));
    let bits=execute_read_on_pool(&state,&tp,&format!("SELECT LENGTH(\"uvb\"),RTRIM(CAST(\"vb\" AS VARCHAR(30))),RTRIM(CAST(\"uvb\" AS VARCHAR(60000))) FROM {dst} WHERE \"id\"=4")).await.unwrap().rows;
    assert_eq!(bits[0], vec![json!(60000), json!("00000000000000001"), json!("01".repeat(30000))]);
    for (i, (kind, value, expected)) in [
        ("interval year", "2 years", "2-0"),
        ("interval day", "2 days", "2 0:00:00"),
        ("interval day to hour", "2 days 3 hours", "2 3:00:00"),
        ("interval day to minute", "2 days 3 hours 4 minutes", "2 3:04:00"),
        ("interval hour", "3 hours", "3:00:00"),
        ("interval hour to minute", "3 hours 4 minutes", "3:04:00"),
        ("interval hour to second(6)", "3 hours 4 minutes 5.123456 seconds", "3:04:05.123456"),
        ("interval minute", "4 minutes", "0:04:00"),
        ("interval minute to second(6)", "4 minutes 5.123456 seconds", "0:04:05.123456"),
    ]
    .iter()
    .enumerate()
    {
        let name = format!("{table}_Q{i}");
        let s = format!("\"{source_schema}\".\"{name}\"");
        let d = format!("\"{target_schema}\".\"{name}\"");
        execute_on_pool(&state, &sp, &format!("CREATE TABLE {s}(\"v\" {kind})")).await.unwrap();
        execute_on_pool(&state, &sp, &format!("INSERT INTO {s} VALUES('{value}')")).await.unwrap();
        let r = make_request(&name);
        let copied = transfer_table_with_result(
            &state,
            &r,
            &name,
            0,
            &source.db_type,
            &target.db_type,
            &sp,
            &tp,
            &HashMap::new(),
            &mut Vec::new(),
            None,
            false,
            |_| {},
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(copied.moved_rows, 1);
        assert_eq!(
            execute_read_on_pool(&state, &tp, &format!("SELECT CAST(\"v\" AS VARCHAR(100)) FROM {d}"))
                .await
                .unwrap()
                .rows,
            vec![vec![json!(expected)]],
            "{kind}"
        );
        execute_on_pool(&state, &tp, &format!("DROP TABLE {d}")).await.unwrap();
    }
    // Accepted domains must reject unrepresentable VALUES before clearing an
    // existing, compatible target, not merely reject incompatible metadata.
    for (i, (kind, good, bad)) in [
        ("time(3)", "'00:00:00'", "'24:00:00'"),
        ("timetz(3)", "'12:00:00+00'", "'12:00:00+15:00'"),
        ("timetz(3)", "'12:00:00+00'", "'12:00:00+00:00:01'"),
        ("timestamptz(6)", "'2026-01-01+00'", "'infinity'"),
        ("timestamptz(6)", "'2026-01-01+00'", "'0001-01-01 00:00:00+14:00'"),
        ("interval day to second(6)", "'1 day'", "'1 day -1 hour'"),
        ("interval hour", "'1 hour'", "'25 hours'"),
        ("interval day", "'1 day'", "'1000000 days'"),
        ("interval year to month", "'1 month'", "'100000000 years'"),
        ("varbit", "B'0'", "CAST(repeat('1',60001) AS varbit)"),
        ("name", "'valid'", "'trailing '"),
    ]
    .iter()
    .enumerate()
    {
        let name = format!("{table}_V{i}");
        let s = format!("\"{source_schema}\".\"{name}\"");
        let d = format!("\"{target_schema}\".\"{name}\"");
        execute_on_pool(&state, &sp, &format!("CREATE TABLE {s}(\"id\" INTEGER PRIMARY KEY,\"v\" {kind})"))
            .await
            .unwrap();
        execute_on_pool(&state, &sp, &format!("INSERT INTO {s} VALUES(1,{good})")).await.unwrap();
        let mut r = make_request(&name);
        let copy = transfer_table_with_result(
            &state,
            &r,
            &name,
            0,
            &source.db_type,
            &target.db_type,
            &sp,
            &tp,
            &HashMap::new(),
            &mut Vec::new(),
            None,
            false,
            |_| {},
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(copy.moved_rows, 1);
        execute_on_pool(&state, &sp, &format!("INSERT INTO {s} VALUES(2,{bad})")).await.unwrap();
        r.mode = dbx_core::transfer::TransferMode::Overwrite;
        let error = transfer_table_with_result(
            &state,
            &r,
            &name,
            0,
            &source.db_type,
            &target.db_type,
            &sp,
            &tp,
            &HashMap::new(),
            &mut Vec::new(),
            None,
            false,
            |_| {},
            |_| {},
        )
        .await
        .expect_err(bad);
        assert!(error.contains("target has not been modified"), "{kind}: {error}");
        assert_eq!(
            execute_read_on_pool(&state, &tp, &format!("SELECT \"id\" FROM {d}")).await.unwrap().rows,
            vec![vec![json!(1)]],
            "{kind}"
        );
        execute_on_pool(&state, &tp, &format!("DROP TABLE {d}")).await.unwrap();
    }
    // Existing target capacity must be known and compatible before overwrite.
    for (i, (kind, target_kind, sentinel)) in [
        ("timestamptz(6)", "DATETIME(3) WITH TIME ZONE", "'2020-01-01 00:00:00+00:00'"),
        ("timetz(3)", "TIME(2) WITH TIME ZONE", "'12:00:00+00:00'"),
        ("time", "INTERVAL HOUR(2) TO SECOND(3)", "INTERVAL '12:00:00' HOUR(2) TO SECOND(3)"),
        ("bit(8)", "BIT(9)", "B'000000001'"),
        ("varbit(17)", "VARBIT(8)", "B'00000001'"),
        ("interval day to second(6)", "INTERVAL DAY(5) TO SECOND(6)", "INTERVAL '1 00:00:00' DAY(5) TO SECOND(6)"),
        ("interval year to month", "INTERVAL YEAR(7) TO MONTH", "INTERVAL '1-0' YEAR(7) TO MONTH"),
        ("xml", "XML", "'<r/>'"),
    ]
    .iter()
    .enumerate()
    {
        let name = format!("{table}_C{i}");
        let s = format!("\"{source_schema}\".\"{name}\"");
        let d = format!("\"{target_schema}\".\"{name}\"");
        execute_on_pool(&state, &sp, &format!("CREATE TABLE {s}(\"id\" INTEGER,\"v\" {kind})")).await.unwrap();
        execute_on_pool(&state, &tp, &format!("CREATE TABLE {d}(\"id\" INTEGER,\"v\" {target_kind})")).await.unwrap();
        execute_on_pool(&state, &tp, &format!("INSERT INTO {d} VALUES(987,{sentinel})")).await.unwrap();
        let mut r = make_request(&name);
        r.mode = dbx_core::transfer::TransferMode::Overwrite;
        let failure = transfer_table_with_result(
            &state,
            &r,
            &name,
            0,
            &source.db_type,
            &target.db_type,
            &sp,
            &tp,
            &HashMap::new(),
            &mut Vec::new(),
            None,
            false,
            |_| {},
            |_| {},
        )
        .await
        .expect_err(target_kind);
        assert!(failure.contains("Xugu column"), "{failure}");
        assert_eq!(
            execute_read_on_pool(&state, &tp, &format!("SELECT \"id\" FROM {d}")).await.unwrap().rows,
            vec![vec![json!(987)]],
            "{target_kind}"
        );
        execute_on_pool(&state, &tp, &format!("DROP TABLE {d}")).await.unwrap();
    }
    // All reference-document exclusions get individual live metadata checks.
    for (i, kind) in [
        "numeric",
        "numeric(39,0)",
        "timetz",
        "interval",
        "money",
        "inet",
        "cidr",
        "macaddr",
        "macaddr8",
        "tsvector",
        "tsquery",
        "pg_lsn",
        "int4range",
        "int8range",
        "numrange",
        "daterange",
        "tsrange",
        "tstzrange",
        "integer[]",
        "bit(60001)",
        "varbit(60001)",
        "smallserial",
        "geometry(Point,4326)",
        "geography(Point,4326)",
    ]
    .iter()
    .enumerate()
    {
        let name = format!("{table}_R{i}");
        let s = format!("\"{source_schema}\".\"{name}\"");
        let d = format!("\"{target_schema}\".\"{name}\"");
        execute_on_pool(&state, &sp, &format!("CREATE TABLE {s}(\"v\" {kind})")).await.unwrap();
        execute_on_pool(&state, &tp, &format!("CREATE TABLE {d}(\"v\" INTEGER)")).await.unwrap();
        execute_on_pool(&state, &tp, &format!("INSERT INTO {d} VALUES(987)")).await.unwrap();
        let mut r = make_request(&name);
        r.mode = dbx_core::transfer::TransferMode::Overwrite;
        let error = transfer_table_with_result(
            &state,
            &r,
            &name,
            0,
            &source.db_type,
            &target.db_type,
            &sp,
            &tp,
            &HashMap::new(),
            &mut Vec::new(),
            None,
            false,
            |_| {},
            |_| {},
        )
        .await
        .expect_err(kind);
        assert!(!error.is_empty());
        assert_eq!(
            execute_read_on_pool(&state, &tp, &format!("SELECT \"v\" FROM {d}")).await.unwrap().rows,
            vec![vec![json!(987)]],
            "{kind}"
        );
        execute_on_pool(&state, &tp, &format!("DROP TABLE {d}")).await.unwrap();
    }
    execute_on_pool(&state, &tp, &format!("DROP TABLE {dst}")).await.unwrap();
    execute_on_pool(&state, &sp, &format!("DROP SCHEMA \"{source_schema}\" CASCADE")).await.unwrap();
}
