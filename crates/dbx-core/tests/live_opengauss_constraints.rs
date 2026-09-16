//! Live integration coverage for OpenGauss structured constraints.
//!
//! Run with a writable OpenGauss database:
//!   DBX_TEST_OPENGAUSS_HOST=127.0.0.1 \
//!   DBX_TEST_OPENGAUSS_PORT=5432 \
//!   DBX_TEST_OPENGAUSS_USER=test \
//!   DBX_TEST_OPENGAUSS_PASSWORD=secret \
//!   DBX_TEST_OPENGAUSS_DATABASE=postgres \
//!   cargo test -p dbx-core --test live_opengauss_constraints -- --ignored --nocapture

use std::time::Duration;

use dbx_core::db::postgres;
use dbx_core::types::ConstraintInfo;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};

fn find_constraint<'a>(constraints: &'a [ConstraintInfo], name: &str) -> &'a ConstraintInfo {
    constraints
        .iter()
        .find(|constraint| constraint.name == name)
        .unwrap_or_else(|| panic!("expected constraint {name} in {constraints:?}"))
}

fn opengauss_url() -> String {
    let host = std::env::var("DBX_TEST_OPENGAUSS_HOST").expect("DBX_TEST_OPENGAUSS_HOST not set");
    let port = std::env::var("DBX_TEST_OPENGAUSS_PORT").expect("DBX_TEST_OPENGAUSS_PORT not set");
    let user = std::env::var("DBX_TEST_OPENGAUSS_USER").expect("DBX_TEST_OPENGAUSS_USER not set");
    let password = std::env::var("DBX_TEST_OPENGAUSS_PASSWORD").expect("DBX_TEST_OPENGAUSS_PASSWORD not set");
    let database = std::env::var("DBX_TEST_OPENGAUSS_DATABASE").unwrap_or_else(|_| "postgres".to_string());
    let params = std::env::var("DBX_TEST_OPENGAUSS_URL_PARAMS").unwrap_or_else(|_| "sslmode=disable".to_string());
    let user = utf8_percent_encode(&user, NON_ALPHANUMERIC);
    let password = utf8_percent_encode(&password, NON_ALPHANUMERIC);
    format!("postgresql://{user}:{password}@{host}:{port}/{database}?{params}")
}

#[tokio::test]
#[ignore = "requires a writable OpenGauss instance via DBX_TEST_OPENGAUSS_* variables"]
async fn opengauss_constraints_report_structural_metadata() {
    let pool = postgres::connect(&opengauss_url(), Duration::from_secs(10)).await.expect("connect OpenGauss");
    let schema = format!("dbx_og_constraints_{}", std::process::id());
    let schema_ident = format!("\"{}\"", schema.replace('"', "\"\""));
    let _ = postgres::execute_query(&pool, &format!("DROP SCHEMA IF EXISTS {schema_ident} CASCADE")).await;

    let setup = [
        format!("CREATE SCHEMA {schema_ident}"),
        format!(
            "CREATE TABLE {schema_ident}.parent (a bigint NOT NULL, b bigint NOT NULL, CONSTRAINT parent_pk PRIMARY KEY (a, b))"
        ),
        format!(
            "CREATE TABLE {schema_ident}.child (\
             id bigint PRIMARY KEY,\
             parent_a bigint,\
             parent_b bigint,\
             code text NOT NULL,\
             amount integer,\
             CONSTRAINT child_parent_fk FOREIGN KEY (parent_a, parent_b) REFERENCES {schema_ident}.parent (a, b) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,\
             CONSTRAINT child_code_unique UNIQUE (code),\
             CONSTRAINT child_amount_check CHECK (amount > 0)\
             )"
        ),
    ];
    postgres::execute_batch(&pool, &setup).await.expect("create OpenGauss constraint fixtures");

    let constraints =
        postgres::list_opengauss_constraints(&pool, &schema, "child").await.expect("list OpenGauss constraints");

    let primary = find_constraint(&constraints, "child_pkey");
    assert_eq!(primary.constraint_type, "PRIMARY KEY");
    assert_eq!(primary.columns, vec!["id"]);
    assert!(primary.enabled);
    assert!(primary.valid);

    let foreign_key = find_constraint(&constraints, "child_parent_fk");
    assert_eq!(foreign_key.constraint_type, "FOREIGN KEY");
    assert_eq!(foreign_key.columns, vec!["parent_a", "parent_b"]);
    assert_eq!(foreign_key.ref_schema.as_deref(), Some(schema.as_str()));
    assert_eq!(foreign_key.ref_table.as_deref(), Some("parent"));
    assert_eq!(foreign_key.ref_columns, vec!["a", "b"]);
    assert_eq!(foreign_key.on_delete.as_deref(), Some("CASCADE"));
    assert_eq!(foreign_key.on_update.as_deref(), Some("NO ACTION"));
    assert_eq!(foreign_key.match_type.as_deref(), Some("SIMPLE"));
    assert!(foreign_key.deferrable);
    assert!(foreign_key.initially_deferred);

    let unique = find_constraint(&constraints, "child_code_unique");
    assert_eq!(unique.constraint_type, "UNIQUE");
    assert_eq!(unique.columns, vec!["code"]);

    let check = find_constraint(&constraints, "child_amount_check");
    assert_eq!(check.constraint_type, "CHECK");
    assert_eq!(check.columns, vec!["amount"]);
    assert!(check.definition.contains("amount"));

    let parent = postgres::list_opengauss_constraints(&pool, &schema, "parent")
        .await
        .expect("list OpenGauss parent constraints");
    assert_eq!(find_constraint(&parent, "parent_pk").columns, vec!["a", "b"]);

    let _ = postgres::execute_query(&pool, &format!("DROP SCHEMA IF EXISTS {schema_ident} CASCADE")).await;
}
