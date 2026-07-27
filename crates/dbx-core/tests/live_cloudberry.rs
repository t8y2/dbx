use std::time::Duration;

use dbx_core::{db, schema};

#[tokio::test]
#[ignore = "requires DBX_TEST_CLOUDBERRY_URL pointing at a writable Apache Cloudberry database"]
async fn cloudberry_metadata_and_ddl_round_trip() {
    let url = std::env::var("DBX_TEST_CLOUDBERRY_URL").expect("DBX_TEST_CLOUDBERRY_URL");
    let pool = db::postgres::connect(&url, Duration::from_secs(10)).await.expect("connect Cloudberry");
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source_schema = format!("dbx_cb_source_{suffix}");
    let target_schema = format!("dbx_cb_target_{suffix}");
    let source_ident = quote_ident(&source_schema);
    let target_ident = quote_ident(&target_schema);

    db::postgres::execute_batch(
        &pool,
        &[
            format!("CREATE SCHEMA {source_ident}"),
            format!("CREATE SCHEMA {target_ident}"),
            format!(
                "CREATE TABLE {source_ident}.hash_events (tenant_id integer, payload text) \
                 DISTRIBUTED BY (tenant_id)"
            ),
            format!(
                "CREATE TABLE {source_ident}.random_events (id integer, payload text) \
                 DISTRIBUTED RANDOMLY"
            ),
            format!(
                "CREATE TABLE {source_ident}.replicated_dimensions (id integer, name text) \
                 DISTRIBUTED REPLICATED"
            ),
            format!(
                "CREATE TABLE {source_ident}.column_metrics (metric text, value numeric(18,4)) \
                 USING ao_column WITH (compresstype=zstd, compresslevel=3) DISTRIBUTED BY (metric)"
            ),
            format!(
                "CREATE TABLE {source_ident}.partitioned_events \
                 (event_date date, tenant_id integer) PARTITION BY RANGE (event_date) \
                 DISTRIBUTED BY (tenant_id)"
            ),
            format!(
                "CREATE READABLE EXTERNAL TABLE {source_ident}.external_events (id integer, payload text) \
                 LOCATION ('file://cdw/tmp/dbx-cloudberry-live-test.csv') \
                 FORMAT 'CSV' (DELIMITER ',')"
            ),
        ],
    )
    .await
    .expect("create Cloudberry fixtures");

    let exercise = async {
        let tables = db::cloudberry::list_tables_filtered(&pool, &source_schema, None, None, None).await?;
        let external = tables.iter().find(|table| table.name == "external_events").ok_or("missing external table")?;
        assert_eq!(external.table_type, "EXTERNAL TABLE");

        let cases = [
            ("hash_events", "DISTRIBUTED BY (\"tenant_id\")"),
            ("random_events", "DISTRIBUTED RANDOMLY"),
            ("replicated_dimensions", "DISTRIBUTED REPLICATED"),
            ("column_metrics", "USING \"ao_column\""),
            ("partitioned_events", "PARTITION BY RANGE (event_date)"),
            ("external_events", "CREATE FOREIGN TABLE"),
        ];
        for (table, expected) in cases {
            let ddl = schema::cloudberry_ddl(&pool, &source_schema, table).await?;
            assert!(ddl.contains(expected), "{table} DDL did not contain {expected}: {ddl}");
            if table == "external_events" {
                assert!(ddl.contains("SERVER \"gp_exttable_server\""), "external DDL: {ddl}");
                assert!(ddl.contains("\"location_uris\" 'file://cdw/tmp/dbx-cloudberry-live-test.csv'"));
            }
            let target_ddl = ddl.replace(&source_ident, &target_ident);
            db::postgres::execute_query(&pool, &target_ddl).await?;
        }
        Ok::<_, String>(())
    }
    .await;

    db::postgres::execute_batch(
        &pool,
        &[format!("DROP SCHEMA {target_ident} CASCADE"), format!("DROP SCHEMA {source_ident} CASCADE")],
    )
    .await
    .expect("drop Cloudberry fixtures");
    exercise.expect("validate Cloudberry metadata and DDL");
}

fn quote_ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
