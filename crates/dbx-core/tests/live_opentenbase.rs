use std::time::Duration;

use dbx_core::{db, schema};

#[tokio::test]
#[ignore = "requires DBX_TEST_OPENTENBASE_URL pointing at a writable OpenTenBase Coordinator"]
async fn opentenbase_metadata_and_ddl_round_trip() {
    let url = std::env::var("DBX_TEST_OPENTENBASE_URL").expect("DBX_TEST_OPENTENBASE_URL");
    let pool = db::postgres::connect(&url, Duration::from_secs(10)).await.expect("connect OpenTenBase Coordinator");
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source_schema = format!("dbx_otb_source_{suffix}");
    let target_schema = format!("dbx_otb_target_{suffix}");
    let source_ident = quote_ident(&source_schema);
    let target_ident = quote_ident(&target_schema);

    db::postgres::execute_batch(
        &pool,
        &[
            format!("CREATE SCHEMA {source_ident}"),
            format!("CREATE SCHEMA {target_ident}"),
            format!(
                "CREATE TABLE {source_ident}.shard_events \
                 (tenant_id integer, event_id bigint, payload text) \
                 DISTRIBUTE BY SHARD (tenant_id)"
            ),
            format!(
                "CREATE TABLE {source_ident}.replicated_dimensions \
                 (id integer, name text) DISTRIBUTE BY REPLICATION"
            ),
        ],
    )
    .await
    .expect("create OpenTenBase fixtures");

    let exercise = async {
        let tables = db::postgres::list_tables(&pool, &source_schema).await?;
        if !tables.iter().any(|table| table.name == "shard_events") {
            return Err("shard_events was not listed".to_string());
        }
        if !tables.iter().any(|table| table.name == "replicated_dimensions") {
            return Err("replicated_dimensions was not listed".to_string());
        }

        let cases = [
            ("shard_events", "DISTRIBUTE BY SHARD (\"tenant_id\")"),
            ("replicated_dimensions", "DISTRIBUTE BY REPLICATION"),
        ];
        for (table, expected) in cases {
            let ddl = schema::opentenbase_ddl(&pool, &source_schema, table, false).await?;
            if !ddl.contains(expected) {
                return Err(format!("{table} DDL did not contain {expected}: {ddl}"));
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
    .expect("drop OpenTenBase fixtures");
    exercise.expect("validate OpenTenBase metadata and DDL");
}

fn quote_ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
