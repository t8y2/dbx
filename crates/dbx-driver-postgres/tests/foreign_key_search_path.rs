//! Behavioural coverage for `list_foreign_keys` schema resolution. The
//! frontend keeps unqualified PostgreSQL sources schema-less so they follow
//! the connection's search_path (queryStore's `useCurrentPostgresSchema`);
//! these tests pin the driver to that contract against a live database.
//!
//! Run against the disposable database with `DBX_TEST_POSTGRES_URL` set.

use dbx_driver_postgres::{connect_with_max_connections, list_foreign_keys};
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use std::time::Duration;

/// Rebind the connection's startup search_path via libpq `options`, matching
/// how a user's session would resolve unqualified names.
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

fn fk_summary(rows: &[dbx_driver_postgres::types::ForeignKeyInfo]) -> Vec<String> {
    rows.iter()
        .map(|fk| format!("{}.{} -> {}", fk.ref_schema.clone().unwrap_or_default(), fk.ref_table, fk.ref_column))
        .collect()
}

#[tokio::test]
#[ignore = "requires DBX_TEST_POSTGRES_URL pointing at a writable disposable PostgreSQL database"]
async fn list_foreign_keys_resolves_unqualified_tables_through_the_search_path() {
    let url = std::env::var("DBX_TEST_POSTGRES_URL").expect("DBX_TEST_POSTGRES_URL");
    let timeout = Duration::from_secs(10);
    let admin_pool = connect_with_max_connections(&url, timeout, 1).await.expect("connect fixture database");
    let admin = admin_pool.get().await.expect("checkout fixture connection");
    let suffix = uuid::Uuid::new_v4().simple();
    let schema_a = format!("dbx_fk_a_{suffix}");
    let schema_b = format!("dbx_fk_b_{suffix}");
    // `public` holds same-named tables with their own FKs: resolving there by
    // default (the old hard "public" fallback) must never win over the
    // search_path, and same-named tables elsewhere must not shadow it either.
    let result: Result<(), String> = async {
        admin
            .batch_execute(&format!(
                "CREATE SCHEMA \"{schema_a}\"; CREATE SCHEMA \"{schema_b}\"; \
                 CREATE TABLE {schema_a}.parent (id int PRIMARY KEY); \
                 CREATE TABLE {schema_a}.child (id int PRIMARY KEY, parent_id int NOT NULL REFERENCES {schema_a}.parent (id)); \
                 CREATE TABLE {schema_a}.orphan (id int PRIMARY KEY, parent_id int NOT NULL REFERENCES {schema_a}.parent (id)); \
                 CREATE TABLE {schema_b}.child (id int PRIMARY KEY); \
                 CREATE TABLE public.parent (id int PRIMARY KEY); \
                 CREATE TABLE public.child (id int PRIMARY KEY, parent_id int NOT NULL REFERENCES public.parent (id));"
            ))
            .await
            .map_err(|error| error.to_string())?;

        // The search_path-first table owns the answer: schema_b.child exists and
        // has no FKs, so an unqualified lookup must return nothing — not the
        // FKs of the same-named public.child, and not an error either.
        let pool = connect_with_max_connections(&search_path_url(&url, &schema_b), timeout, 1).await?;
        let rows = list_foreign_keys(&pool, "", "child").await?;
        if !rows.is_empty() {
            return Err(format!("search_path-first table has no FKs; got {:?}", fk_summary(&rows)));
        }

        // Same session, but the table only exists outside the search_path: the
        // current_schema() fallback names a schema that does not hold the
        // table, so the answer is empty — never public's same-named FKs.
        let rows = list_foreign_keys(&pool, "", "orphan").await?;
        if !rows.is_empty() {
            return Err(format!("table outside the search_path must resolve to nothing; got {:?}", fk_summary(&rows)));
        }

        // First schema on the path that holds the table wins: schema_a.child's
        // FK is returned, not public's same-named pair.
        let pool = connect_with_max_connections(&search_path_url(&url, &schema_a), timeout, 1).await?;
        let rows = list_foreign_keys(&pool, "", "child").await?;
        let summary = fk_summary(&rows);
        if summary != [format!("{schema_a}.parent.id")] {
            return Err(format!("expected the search-path table's own FK; got {summary:?}"));
        }

        // Path order decides between two schemas that both hold the table: the
        // first match (schema_b.child, no FKs) is taken — the same rule
        // PostgreSQL applies to an unqualified SELECT.
        let pool = connect_with_max_connections(&search_path_url(&url, &format!("{schema_b},{schema_a}")), timeout, 1).await?;
        let rows = list_foreign_keys(&pool, "", "child").await?;
        if !rows.is_empty() {
            return Err(format!("first search-path match has no FKs; got {:?}", fk_summary(&rows)));
        }
        let pool = connect_with_max_connections(&search_path_url(&url, &format!("{schema_a},{schema_b}")), timeout, 1).await?;
        let rows = list_foreign_keys(&pool, "", "child").await?;
        if fk_summary(&rows) != [format!("{schema_a}.parent.id")] {
            return Err(format!("reversed path must flip the winner; got {:?}", fk_summary(&rows)));
        }

        // Qualified lookups stay exact-schema regardless of the session path.
        let pool = connect_with_max_connections(&search_path_url(&url, &schema_b), timeout, 1).await?;
        let rows = list_foreign_keys(&pool, &schema_b, "child").await?;
        if !rows.is_empty() {
            return Err(format!("qualified schema_b.child has no FKs; got {:?}", fk_summary(&rows)));
        }
        let rows = list_foreign_keys(&pool, &schema_a, "child").await?;
        if fk_summary(&rows) != [format!("{schema_a}.parent.id")] {
            return Err(format!("qualified schema_a.child FK missing; got {:?}", fk_summary(&rows)));
        }
        Ok(())
    }
    .await;
    // Collect errors before asserting so fixtures are removed on regressions.
    let cleanup = admin
        .batch_execute(&format!(
            "DROP SCHEMA IF EXISTS \"{schema_a}\" CASCADE; DROP SCHEMA IF EXISTS \"{schema_b}\" CASCADE; \
             DROP TABLE IF EXISTS public.child; DROP TABLE IF EXISTS public.parent;"
        ))
        .await;
    assert!(cleanup.is_ok(), "fixture cleanup failed: {cleanup:?}");
    assert!(result.is_ok(), "search-path FK resolution regression: {result:?}");
}
