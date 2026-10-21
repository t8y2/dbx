use std::time::Duration;

use dbx_core::db::postgres;
use dbx_core::models::connection::DatabaseType;
use dbx_core::schema_diff::{prepare_schema_diff, SchemaDiffPreparationOptions};

fn postgres_url() -> String {
    let host = std::env::var("DBX_LIVE_POSTGRES_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_POSTGRES_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(5432);
    let user = std::env::var("DBX_LIVE_POSTGRES_USER").unwrap_or_else(|_| "postgres".to_string());
    let password = std::env::var("DBX_LIVE_POSTGRES_PASSWORD").unwrap_or_default();
    let database = std::env::var("DBX_LIVE_POSTGRES_DATABASE").unwrap_or_else(|_| "postgres".to_string());
    format!("postgres://{user}:{password}@{host}:{port}/{database}")
}

const PROCEDURE_BODY: &str = "(IN a integer) LANGUAGE plpgsql AS $$ BEGIN RAISE NOTICE '%', a; END $$";
const FUNCTION_BODY: &str = "(a integer) RETURNS integer LANGUAGE sql AS $$ SELECT a + 1 $$";

fn routine_options(
    source: Vec<dbx_core::types::FunctionInfo>,
    target: Vec<dbx_core::types::FunctionInfo>,
    target_schema: &str,
) -> SchemaDiffPreparationOptions {
    SchemaDiffPreparationOptions {
        source_functions: source,
        target_functions: target,
        database_type: DatabaseType::Postgres,
        target_schema: Some(target_schema.to_string()),
        ..Default::default()
    }
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a PostgreSQL 11+ database where roles can be created"]
async fn routines_in_differently_named_schemas_compare_equal() {
    let pool = postgres::connect(&postgres_url(), Duration::from_secs(10)).await.expect("connect to PostgreSQL");
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let suffix = &suffix[..8];
    let source_schema = format!("dbx_eval_11981_src_{suffix}");
    // Mixed case forces pg_get_functiondef to quote the schema name.
    let target_schema = format!("DBX_Eval_11981_Tgt_{suffix}");
    let source_owner = format!("dbx_eval_11981_a_{suffix}");
    let target_owner = format!("dbx_eval_11981_b_{suffix}");
    let source = format!("\"{source_schema}\"");
    let target = format!("\"{target_schema}\"");

    let client = pool.get().await.expect("checkout setup connection");
    client
        .batch_execute(&format!(
            "CREATE ROLE {source_owner}; CREATE ROLE {target_owner}; \
             CREATE SCHEMA {source}; CREATE SCHEMA {target}; \
             CREATE PROCEDURE {source}.p1{PROCEDURE_BODY}; CREATE PROCEDURE {target}.p1{PROCEDURE_BODY}; \
             CREATE FUNCTION {source}.f1{FUNCTION_BODY}; CREATE FUNCTION {target}.f1{FUNCTION_BODY}; \
             ALTER PROCEDURE {source}.p1(integer) OWNER TO {source_owner}; \
             ALTER PROCEDURE {target}.p1(integer) OWNER TO {target_owner}; \
             ALTER FUNCTION {source}.f1(integer) OWNER TO {source_owner}; \
             ALTER FUNCTION {target}.f1(integer) OWNER TO {target_owner};"
        ))
        .await
        .expect("create routines");

    let source_functions = postgres::list_functions(&pool, &source_schema).await.unwrap();
    let identical = prepare_schema_diff(routine_options(
        source_functions.clone(),
        postgres::list_functions(&pool, &target_schema).await.unwrap(),
        &target_schema,
    ));
    println!("identical routines: {:#?}", identical.function_diffs);

    client
        .batch_execute(&format!(
            "CREATE OR REPLACE PROCEDURE {target}.p1(IN a integer) LANGUAGE plpgsql \
             AS $$ BEGIN RAISE NOTICE 'changed %', a; END $$;"
        ))
        .await
        .expect("change target procedure body");
    let changed = prepare_schema_diff(routine_options(
        source_functions.clone(),
        postgres::list_functions(&pool, &target_schema).await.unwrap(),
        &target_schema,
    ));
    println!("changed procedure: {:#?}\nsync SQL:\n{}", changed.function_diffs, changed.sync_sql);
    let applied = client.batch_execute(&changed.sync_sql).await;
    let resynced = prepare_schema_diff(routine_options(
        source_functions,
        postgres::list_functions(&pool, &target_schema).await.unwrap(),
        &target_schema,
    ));
    println!("after applying sync SQL: {:#?}", resynced.function_diffs);

    client
        .batch_execute(&format!(
            "DROP SCHEMA {source} CASCADE; DROP SCHEMA {target} CASCADE; \
             DROP ROLE {source_owner}; DROP ROLE {target_owner};"
        ))
        .await
        .expect("drop test objects");

    assert!(identical.function_diffs.is_empty(), "identical routines must not differ: {:?}", identical.function_diffs);
    let changed_names: Vec<_> =
        changed.function_diffs.iter().map(|diff| (diff.name.as_str(), diff.diff_type.as_str())).collect();
    assert_eq!(changed_names, [("p1", "modified")]);
    applied.expect("execute DBX-generated routine sync SQL");
    assert!(resynced.function_diffs.is_empty(), "synced routines must not differ: {:?}", resynced.function_diffs);
}
