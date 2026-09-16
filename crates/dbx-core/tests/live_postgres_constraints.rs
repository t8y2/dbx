//! Live integration coverage for `postgres::list_constraints` on a real
//! PostgreSQL server. These tests validate what string-matching unit tests
//! cannot: that the metadata SQL actually executes, that `name[]` column
//! arrays decode into `Vec<String>`, that composite key ordering is
//! preserved, and that `NOT VALID` / EXCLUDE constraints surface correctly.
//!
//! Gate with `#[ignore]` and a writable database, e.g.:
//!   DBX_TEST_POSTGRES_URL=postgresql://postgres@127.0.0.1:5432/postgres \
//!     cargo test -p dbx-core --no-default-features --test live_postgres_constraints -- --ignored --nocapture

use std::time::Duration;

use dbx_core::db::postgres;
use dbx_core::types::ConstraintInfo;

fn find_constraint<'a>(constraints: &'a [ConstraintInfo], name: &str) -> &'a ConstraintInfo {
    constraints
        .iter()
        .find(|c| c.name == name)
        .unwrap_or_else(|| panic!("expected constraint {name} in {constraints:?}"))
}

#[tokio::test]
#[ignore = "requires DBX_TEST_POSTGRES_URL pointing at a writable PostgreSQL database"]
async fn postgres_constraints_reports_pk_fk_unique_check_and_not_valid() {
    let url = std::env::var("DBX_TEST_POSTGRES_URL").expect("DBX_TEST_POSTGRES_URL");
    let pool = postgres::connect(&url, Duration::from_secs(5)).await.expect("connect postgres");
    let schema = format!("dbx_constraints_{}", std::process::id());
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
             amount int,\
             CONSTRAINT child_parent_fk FOREIGN KEY (parent_a, parent_b) REFERENCES {schema_ident}.parent (a, b),\
             CONSTRAINT child_code_unique UNIQUE (code),\
             CONSTRAINT child_code_check CHECK (length(code) > 0)\n             )"
        ),
        // NOT VALID is only honored via ALTER TABLE ADD CONSTRAINT; the
        // CREATE TABLE form is validated by PostgreSQL 14 (convalidated=true).
        format!(
            "ALTER TABLE {schema_ident}.child ADD CONSTRAINT child_amount_check_not_valid CHECK (amount > 0) NOT VALID"
        ),
    ];
    postgres::execute_batch(&pool, &setup).await.expect("create parent/child tables");

    let child = postgres::list_constraints(&pool, &schema, "child").await.expect("list child constraints");

    // PRIMARY KEY
    let pk = find_constraint(&child, "child_pkey");
    assert_eq!(pk.constraint_type, "PRIMARY KEY");
    assert_eq!(pk.columns, vec!["id"]);
    assert!(pk.valid);
    assert!(pk.enabled);
    assert_eq!(pk.ref_table, None);

    // FOREIGN KEY: composite referencing columns must keep order (a, b)
    let fk = find_constraint(&child, "child_parent_fk");
    assert_eq!(fk.constraint_type, "FOREIGN KEY");
    assert_eq!(fk.columns, vec!["parent_a", "parent_b"]);
    assert_eq!(fk.ref_table.as_deref(), Some("parent"));
    assert_eq!(fk.ref_schema.as_deref(), Some(schema.as_str()));
    assert_eq!(fk.ref_columns, vec!["a", "b"]);
    assert_eq!(fk.on_update.as_deref(), Some("NO ACTION"));
    assert_eq!(fk.on_delete.as_deref(), Some("NO ACTION"));
    assert_eq!(fk.match_type.as_deref(), Some("SIMPLE"));
    assert!(fk.valid);

    // UNIQUE
    let unique = find_constraint(&child, "child_code_unique");
    assert_eq!(unique.constraint_type, "UNIQUE");
    assert_eq!(unique.columns, vec!["code"]);

    // CHECK: definition is populated
    let check = find_constraint(&child, "child_code_check");
    assert_eq!(check.constraint_type, "CHECK");
    assert_eq!(check.columns, vec!["code"]);
    assert!(check.definition.contains("length(code) > 0"));

    // NOT VALID CHECK surfaces valid=false
    let not_valid = find_constraint(&child, "child_amount_check_not_valid");
    assert_eq!(not_valid.constraint_type, "CHECK");
    assert!(!not_valid.valid, "NOT VALID constraint must report valid=false");
    assert!(not_valid.enabled);

    // Composite primary key keeps declared column order (a, b), not b, a
    let parent = postgres::list_constraints(&pool, &schema, "parent").await.expect("list parent constraints");
    let parent_pk = find_constraint(&parent, "parent_pk");
    assert_eq!(parent_pk.constraint_type, "PRIMARY KEY");
    assert_eq!(parent_pk.columns, vec!["a", "b"]);

    let _ = postgres::execute_query(&pool, &format!("DROP SCHEMA IF EXISTS {schema_ident} CASCADE")).await;
}

#[tokio::test]
#[ignore = "requires DBX_TEST_POSTGRES_URL pointing at a writable PostgreSQL database"]
async fn postgres_constraints_reports_exclude_constraints() {
    let url = std::env::var("DBX_TEST_POSTGRES_URL").expect("DBX_TEST_POSTGRES_URL");
    let pool = postgres::connect(&url, Duration::from_secs(5)).await.expect("connect postgres");
    let schema = format!("dbx_constraints_excl_{}", std::process::id());
    let schema_ident = format!("\"{}\"", schema.replace('"', "\"\""));
    let _ = postgres::execute_query(&pool, &format!("DROP SCHEMA IF EXISTS {schema_ident} CASCADE")).await;

    let setup = [
        format!("CREATE SCHEMA {schema_ident}"),
        format!(
            "CREATE TABLE {schema_ident}.rooms (\
             id bigint PRIMARY KEY,\
             during tstzrange,\
             CONSTRAINT room_no_overlap EXCLUDE USING gist (during WITH &&)\
             )"
        ),
    ];
    postgres::execute_batch(&pool, &setup).await.expect("create rooms table");

    let constraints = postgres::list_constraints(&pool, &schema, "rooms").await.expect("list rooms constraints");
    let exclude = find_constraint(&constraints, "room_no_overlap");
    assert_eq!(exclude.constraint_type, "EXCLUDE");
    assert_eq!(exclude.columns, vec!["during"]);
    assert!(exclude.definition.contains("EXCLUDE"));
    assert!(exclude.valid);

    let _ = postgres::execute_query(&pool, &format!("DROP SCHEMA IF EXISTS {schema_ident} CASCADE")).await;
}
