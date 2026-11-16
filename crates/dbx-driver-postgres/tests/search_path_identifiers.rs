use dbx_driver_postgres::{
    connect_with_max_connections, execute_query_with_schema, set_postgres_search_path, PostgresSearchPathContext,
};
use deadpool_postgres::Pool;
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use std::time::Duration;

fn search_path_url(url: &str, search_path: &str) -> String {
    let (base, fragment) = url.split_once('#').map_or((url, None), |(base, fragment)| (base, Some(fragment)));
    let (prefix, query) = base.split_once('?').map_or((base, None), |(prefix, query)| (prefix, Some(query)));
    let mut params = Vec::new();
    let mut options = String::new();
    for param in query.into_iter().flat_map(|query| query.split('&')).filter(|param| !param.is_empty()) {
        let (key, value) = param.split_once('=').unwrap_or((param, ""));
        if percent_decode_str(key).decode_utf8_lossy() == "options" {
            options = percent_decode_str(value).decode_utf8_lossy().into_owned();
        } else {
            params.push(param.to_string());
        }
    }
    options.push_str(&format!(" -csearch_path={search_path}"));
    params.push(format!("options={}", utf8_percent_encode(options.trim(), NON_ALPHANUMERIC)));
    let mut url = format!("{prefix}?{}", params.join("&"));
    if let Some(fragment) = fragment {
        url.push('#');
        url.push_str(fragment);
    }
    url
}

async fn check_baseline(pool: &Pool, configured: &str, backend_pid: i32) -> Result<(), String> {
    let client = pool.get().await.map_err(|error| error.to_string())?;
    let row = client
        .query_one("SELECT current_setting('search_path'), pg_backend_pid()", &[])
        .await
        .map_err(|error| error.to_string())?;
    let actual: String = row.get(0);
    if actual != configured || row.get::<_, i32>(1) != backend_pid {
        return Err(format!("connection reuse must restore startup search_path {configured:?}; got {actual:?}"));
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires DBX_TEST_POSTGRES_URL pointing at a writable disposable PostgreSQL database"]
async fn postgres_search_path_identifiers_support_queries_comments_and_connection_reuse() {
    let url = std::env::var("DBX_TEST_POSTGRES_URL").expect("DBX_TEST_POSTGRES_URL");
    let timeout = Duration::from_secs(10);
    let admin_pool = connect_with_max_connections(&url, timeout, 1).await.expect("connect fixture database");
    let admin = admin_pool.get().await.expect("checkout fixture connection");
    let suffix = uuid::Uuid::new_v4().simple();
    let selected = format!("dbx-issue-13150-{suffix}");
    let other = format!("dbx_other_{suffix}");
    let comma = format!("dbx,search\"{suffix}");
    let comma_ident = comma.replace('"', "\"\"");
    let unicode = format!("\u{2003}dbx_unicode_{suffix}\u{2003}");
    // Startup GUC values accept a bare hyphenated name, even though replaying
    // that same value verbatim in a SET statement is invalid SQL.
    let baselines = [
        format!("{selected},public"),
        format!("{selected},\"{comma_ident}\",\"$user\",public"),
        format!("{selected},{unicode},public"),
    ];
    let result: Result<(), String> = async {
        admin
            .batch_execute(&format!(
                "CREATE SCHEMA \"{selected}\"; CREATE SCHEMA \"{other}\"; CREATE SCHEMA \"{comma_ident}\"; \
                 CREATE SCHEMA \"{unicode}\";"
            ))
            .await
            .map_err(|error| error.to_string())?;
        for (index, configured) in baselines.iter().enumerate() {
            let pool = connect_with_max_connections(&search_path_url(&url, configured), timeout, 1).await?;
            let client = pool.get().await.map_err(|error| error.to_string())?;
            let backend_pid: i32 =
                client.query_one("SELECT pg_backend_pid()", &[]).await.map_err(|e| e.to_string())?.get(0);
            drop(client);
            check_baseline(&pool, configured, backend_pid).await?;

            for schema in [&selected, &other] {
                let preserved = match index {
                    0 => &selected,
                    1 => &comma,
                    _ => &unicode,
                };
                let rows = execute_query_with_schema(
                    &pool,
                    schema,
                    &format!(
                        "SELECT now() IS NOT NULL, current_schema()::text, '{preserved}' = ANY(current_schemas(false))"
                    ),
                )
                .await?;
                if rows.rows != vec![vec![serde_json::json!(true), serde_json::json!(schema), serde_json::json!(true)]]
                {
                    return Err(format!("unexpected query result for schema {schema:?}: {:?}", rows.rows));
                }
                check_baseline(&pool, configured, backend_pid).await?;

                execute_query_with_schema(
                    &pool,
                    schema,
                    &format!("COMMENT ON SCHEMA \"{selected}\" IS 'issue 13148 regression'"),
                )
                .await?;
                let comment: Option<String> = admin
                    .query_one(
                        "SELECT obj_description(oid, 'pg_namespace') FROM pg_namespace WHERE nspname = $1",
                        &[&selected],
                    )
                    .await
                    .map_err(|error| error.to_string())?
                    .get(0);
                if comment.as_deref() != Some("issue 13148 regression") {
                    return Err(format!("schema comment was not saved: {comment:?}"));
                }
                check_baseline(&pool, configured, backend_pid).await?;
            }

            if execute_query_with_schema(&pool, &other, "SELECT dbx_missing_search_path_regression()").await.is_ok() {
                return Err("the deliberately invalid query unexpectedly succeeded".to_string());
            }
            check_baseline(&pool, configured, backend_pid).await?;

            let client = pool.get().await.map_err(|error| error.to_string())?;
            client.batch_execute("BEGIN").await.map_err(|error| error.to_string())?;
            let local_result: Result<(), String> = async {
                set_postgres_search_path(&client, &other, PostgresSearchPathContext::LocalTransaction, timeout).await?;
                let actual: String = client
                    .query_one("SELECT current_schema()::text", &[])
                    .await
                    .map_err(|error| error.to_string())?
                    .get(0);
                if actual != other {
                    return Err(format!("SET LOCAL selected {actual:?} instead of {other:?}"));
                }
                Ok(())
            }
            .await;
            let rollback = client.batch_execute("ROLLBACK").await.map_err(|error| error.to_string());
            drop(client);
            local_result?;
            rollback?;
            check_baseline(&pool, configured, backend_pid).await?;
        }
        Ok(())
    }
    .await;
    // Collect errors before asserting so fixtures are removed on regressions.
    let cleanup = admin
        .batch_execute(&format!(
            "DROP SCHEMA IF EXISTS \"{selected}\" CASCADE; DROP SCHEMA IF EXISTS \"{other}\" CASCADE; \
             DROP SCHEMA IF EXISTS \"{comma_ident}\" CASCADE; DROP SCHEMA IF EXISTS \"{unicode}\" CASCADE;"
        ))
        .await;
    assert!(cleanup.is_ok(), "fixture cleanup failed: {cleanup:?}");
    assert!(result.is_ok(), "search_path regression: {result:?}");
}
