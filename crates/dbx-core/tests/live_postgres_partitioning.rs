//! Live declarative-partitioning tests.
//!
//! Point `DBX_LIVE_POSTGRES_*` at a PostgreSQL server, or at a KingbaseES
//! server (same wire protocol and `pg_partitioned_table` catalog) — all tests
//! pass against KingbaseES V009R001C010. openGauss-based engines use a
//! different `pg_partition` catalog and are not covered here.

use std::time::Duration;

use dbx_core::db::postgres;
use dbx_core::types::{PgPartitionBound, PgPartitionKind};

/// Percent-encodes the URL userinfo characters that would otherwise be read
/// as delimiters (`@`, `:`, `/`, `#`, `%`). Live fixtures commonly use
/// passwords like `test@123`.
fn encode_url_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '@' => encoded.push_str("%40"),
            ':' => encoded.push_str("%3A"),
            '/' => encoded.push_str("%2F"),
            '#' => encoded.push_str("%23"),
            '%' => encoded.push_str("%25"),
            _ => encoded.push(ch),
        }
    }
    encoded
}

fn live_postgres_url() -> String {
    let host = std::env::var("DBX_LIVE_POSTGRES_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_POSTGRES_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(5432);
    let user =
        encode_url_component(&std::env::var("DBX_LIVE_POSTGRES_USER").unwrap_or_else(|_| "postgres".to_string()));
    let password = encode_url_component(&std::env::var("DBX_LIVE_POSTGRES_PASSWORD").unwrap_or_default());
    let database = std::env::var("DBX_LIVE_POSTGRES_DATABASE").unwrap_or_else(|_| "postgres".to_string());
    format!("postgresql://{user}:{password}@{host}:{port}/{database}")
}

fn fixture_statements(schema: &str) -> Vec<String> {
    vec![
        format!("CREATE SCHEMA \"{schema}\""),
        // RANGE with a default partition.
        format!("CREATE TABLE \"{schema}\".sales (id integer, sold_on date) PARTITION BY RANGE (sold_on)"),
        format!(
            "CREATE TABLE \"{schema}\".sales_2024 PARTITION OF \"{schema}\".sales \
             FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')"
        ),
        format!("CREATE TABLE \"{schema}\".sales_default PARTITION OF \"{schema}\".sales DEFAULT"),
        // LIST.
        format!("CREATE TABLE \"{schema}\".events (region text) PARTITION BY LIST (region)"),
        format!("CREATE TABLE \"{schema}\".events_a PARTITION OF \"{schema}\".events FOR VALUES IN ('a', 'b')"),
        // HASH.
        format!("CREATE TABLE \"{schema}\".h (id integer) PARTITION BY HASH (id)"),
        format!("CREATE TABLE \"{schema}\".h0 PARTITION OF \"{schema}\".h FOR VALUES WITH (MODULUS 2, REMAINDER 0)"),
        format!("CREATE TABLE \"{schema}\".h1 PARTITION OF \"{schema}\".h FOR VALUES WITH (MODULUS 2, REMAINDER 1)"),
        // Multi-column RANGE.
        format!("CREATE TABLE \"{schema}\".multi (a text, b text) PARTITION BY RANGE (a, b)"),
        format!(
            "CREATE TABLE \"{schema}\".multi_1 PARTITION OF \"{schema}\".multi \
             FOR VALUES FROM ('a', 'a') TO ('b', 'b')"
        ),
        // Expression RANGE key (must be IMMUTABLE).
        format!("CREATE TABLE \"{schema}\".exp (v integer) PARTITION BY RANGE (abs(v))"),
        format!("CREATE TABLE \"{schema}\".exp_neg PARTITION OF \"{schema}\".exp FOR VALUES FROM (MINVALUE) TO (0)"),
        // Plain, non-partitioned table.
        format!("CREATE TABLE \"{schema}\".plain (id integer)"),
    ]
}

/// Live PostgreSQL: `get_table_partitioning` must report strategy, key columns,
/// nested children, bounds, and the default partition for every supported
/// partitioning shape, and must report a plain table as unpartitioned.
#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_HOST/PORT/USER/PASSWORD/DATABASE pointing at a writable PostgreSQL database"]
async fn live_postgres_partitioning_is_structured() {
    let pool = postgres::connect(&live_postgres_url(), Duration::from_secs(10)).await.expect("connect PostgreSQL");
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let schema = format!("dbx_part_{}", &suffix[..8]);
    let cleanup = vec![format!("DROP SCHEMA IF EXISTS \"{schema}\" CASCADE")];
    let _ = postgres::execute_batch(&pool, &cleanup).await;
    postgres::execute_batch(&pool, &fixture_statements(&schema)).await.expect("create live partition fixture");

    // RANGE + default partition.
    let sales = postgres::get_table_partitioning(&pool, &schema, "sales").await.expect("read sales partitioning");
    assert!(sales.is_partitioned);
    assert!(!sales.is_partition);
    assert_eq!(sales.strategy, Some(PgPartitionKind::Range));
    assert_eq!(sales.key_columns, vec!["sold_on".to_string()]);
    assert_eq!(sales.default_partition.as_deref(), Some("sales_default"));
    assert_eq!(sales.partitions.len(), 2);
    let sales_2024 = sales.partitions.iter().find(|node| node.name == "sales_2024").expect("sales_2024 present");
    assert!(sales_2024.is_leaf);
    // The literal text is whatever the server renders: PostgreSQL 14 emits
    // `'2024-01-01'`, KingbaseES emits `'2024-01-01 00:00:00'`. Assert the shape
    // and the date prefix instead of an exact string so both pass.
    match sales_2024.bound.as_ref() {
        Some(PgPartitionBound::Range { from, to }) => {
            assert_eq!(from.len(), 1);
            assert_eq!(to.len(), 1);
            assert!(from[0].starts_with("'2024-01-01"), "unexpected from: {from:?}");
            assert!(to[0].starts_with("'2025-01-01"), "unexpected to: {to:?}");
        }
        other => panic!("expected a range bound, got {other:?}"),
    }

    // LIST.
    let events = postgres::get_table_partitioning(&pool, &schema, "events").await.expect("read events partitioning");
    assert_eq!(events.strategy, Some(PgPartitionKind::List));
    assert_eq!(
        events.partitions[0].bound,
        Some(PgPartitionBound::List { values: vec!["'a'".to_string(), "'b'".to_string()] })
    );

    // HASH.
    let hash = postgres::get_table_partitioning(&pool, &schema, "h").await.expect("read hash partitioning");
    assert_eq!(hash.strategy, Some(PgPartitionKind::Hash));
    let h0 = hash.partitions.iter().find(|node| node.name == "h0").expect("h0 present");
    assert_eq!(h0.bound, Some(PgPartitionBound::Hash { modulus: 2, remainder: 0 }));
    assert_eq!(h0.strategy, None);

    // Multi-column RANGE.
    let multi = postgres::get_table_partitioning(&pool, &schema, "multi").await.expect("read multi partitioning");
    assert_eq!(multi.key_columns, vec!["a".to_string(), "b".to_string()]);
    assert_eq!(
        multi.partitions[0].bound,
        Some(PgPartitionBound::Range {
            from: vec!["'a'".to_string(), "'a'".to_string()],
            to: vec!["'b'".to_string(), "'b'".to_string()]
        })
    );

    // Expression RANGE key: no plain columns, expression text captured.
    let exp = postgres::get_table_partitioning(&pool, &schema, "exp").await.expect("read exp partitioning");
    assert!(exp.key_columns.is_empty());
    assert_eq!(exp.key_expression.as_deref(), Some("abs(v)"));
    assert_eq!(
        exp.partitions[0].bound,
        Some(PgPartitionBound::Range { from: vec!["MINVALUE".to_string()], to: vec!["0".to_string()] })
    );

    // A member partition reports its parent and own bound (and no descendants).
    let child = postgres::get_table_partitioning(&pool, &schema, "sales_2024").await.expect("read child partitioning");
    assert!(child.is_partition);
    assert!(!child.is_partitioned);
    assert_eq!(child.parent.as_deref(), Some(format!("{schema}.sales").as_str()));
    assert!(child.partitions.is_empty());
    assert!(child.own_bound.is_some());

    // A plain table is not partitioning at all.
    let plain = postgres::get_table_partitioning(&pool, &schema, "plain").await.expect("read plain table");
    assert!(!plain.is_partitioned && !plain.is_partition && plain.partitions.is_empty());

    postgres::execute_batch(&pool, &cleanup).await.expect("cleanup live partition schema");
}

/// Live PostgreSQL: a two-level hierarchy (partitioned partition) must be
/// reported as nested children, not flattened.
#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_HOST/PORT/USER/PASSWORD/DATABASE pointing at a writable PostgreSQL database"]
async fn live_postgres_partitioning_nests_subpartitions() {
    let pool = postgres::connect(&live_postgres_url(), Duration::from_secs(10)).await.expect("connect PostgreSQL");
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let schema = format!("dbx_partn_{}", &suffix[..8]);
    let cleanup = vec![format!("DROP SCHEMA IF EXISTS \"{schema}\" CASCADE")];
    let _ = postgres::execute_batch(&pool, &cleanup).await;
    let statements = vec![
        format!("CREATE SCHEMA \"{schema}\""),
        format!("CREATE TABLE \"{schema}\".logs (ts date, region text) PARTITION BY RANGE (ts)"),
        format!(
            "CREATE TABLE \"{schema}\".logs_2024 PARTITION OF \"{schema}\".logs \
             FOR VALUES FROM ('2024-01-01') TO ('2025-01-01') PARTITION BY LIST (region)"
        ),
        format!("CREATE TABLE \"{schema}\".logs_2024_us PARTITION OF \"{schema}\".logs_2024 FOR VALUES IN ('us')"),
    ];
    postgres::execute_batch(&pool, &statements).await.expect("create nested partition fixture");

    let logs = postgres::get_table_partitioning(&pool, &schema, "logs").await.expect("read logs partitioning");
    assert_eq!(logs.strategy, Some(PgPartitionKind::Range));
    assert_eq!(logs.partitions.len(), 1);
    let child = &logs.partitions[0];
    assert_eq!(child.name, "logs_2024");
    assert_eq!(child.strategy, Some(PgPartitionKind::List));
    assert!(!child.is_leaf);
    assert_eq!(child.children.len(), 1);
    assert_eq!(child.children[0].name, "logs_2024_us");

    postgres::execute_batch(&pool, &cleanup).await.expect("cleanup nested partition schema");
}

/// Live PostgreSQL: the generated partition maintenance DDL must actually run.
/// Covers create (with a bound), detach, and drop end to end.
#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_HOST/PORT/USER/PASSWORD/DATABASE pointing at a writable PostgreSQL database"]
async fn live_postgres_partition_operations_execute() {
    use dbx_core::table_structure_sql::{
        build_table_partition_operation_sql, TablePartitionBoundDraft, TablePartitionOperation,
        TablePartitionOperationKind, TablePartitionSqlOptions,
    };

    let pool = postgres::connect(&live_postgres_url(), Duration::from_secs(10)).await.expect("connect PostgreSQL");
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let schema = format!("dbx_partop_{}", &suffix[..8]);
    let cleanup = vec![format!("DROP SCHEMA IF EXISTS \"{schema}\" CASCADE")];
    let _ = postgres::execute_batch(&pool, &cleanup).await;
    postgres::execute_batch(
        &pool,
        &[
            format!("CREATE SCHEMA \"{schema}\""),
            format!("CREATE TABLE \"{schema}\".sales (id integer, sold_on date) PARTITION BY RANGE (sold_on)"),
        ],
    )
    .await
    .expect("create partitioned parent");

    let operation = |kind: TablePartitionOperationKind, name: &str, bound: Option<TablePartitionBoundDraft>| {
        TablePartitionOperation {
            id: format!("op:{name}"),
            kind,
            parent_schema: String::new(),
            parent_table: String::new(),
            schema: String::new(),
            name: name.to_string(),
            bound,
            concurrently: false,
        }
    };

    let create = build_table_partition_operation_sql(TablePartitionSqlOptions {
        database_type: Some(dbx_core::models::connection::DatabaseType::Postgres),
        driver_profile: None,
        schema: Some(schema.clone()),
        table_name: "sales".to_string(),
        operations: vec![operation(
            TablePartitionOperationKind::Create,
            "sales_2025",
            Some(TablePartitionBoundDraft::Range {
                from: vec!["'2025-01-01'".to_string()],
                to: vec!["'2026-01-01'".to_string()],
            }),
        )],
    });
    assert!(create.warnings.is_empty(), "{:?}", create.warnings);
    postgres::execute_batch(&pool, &create.statements).await.expect("execute create partition");

    let partitioning = postgres::get_table_partitioning(&pool, &schema, "sales").await.expect("read partitioning");
    assert!(partitioning.partitions.iter().any(|node| node.name == "sales_2025"));
    assert!(partitioning.server_version_num.is_some());

    // Detach + drop: the partition must disappear from the parent's tree.
    let detach = build_table_partition_operation_sql(TablePartitionSqlOptions {
        database_type: Some(dbx_core::models::connection::DatabaseType::Postgres),
        driver_profile: None,
        schema: Some(schema.clone()),
        table_name: "sales".to_string(),
        operations: vec![
            operation(TablePartitionOperationKind::Detach, "sales_2025", None),
            operation(TablePartitionOperationKind::Drop, "sales_2025", None),
        ],
    });
    assert!(detach.warnings.is_empty(), "{:?}", detach.warnings);
    postgres::execute_batch(&pool, &detach.statements).await.expect("execute detach + drop");
    let after = postgres::get_table_partitioning(&pool, &schema, "sales").await.expect("read partitioning after drop");
    assert!(!after.partitions.iter().any(|node| node.name == "sales_2025"));

    postgres::execute_batch(&pool, &cleanup).await.expect("cleanup live partition-op schema");
}

/// Live PostgreSQL: a table created through the create-mode partitioning
/// builder must be a real partitioned parent that accepts partitions.
#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_HOST/PORT/USER/PASSWORD/DATABASE pointing at a writable PostgreSQL database"]
async fn live_postgres_create_partitioned_table_executes() {
    use dbx_core::models::connection::DatabaseType;
    use dbx_core::table_structure_sql::{
        build_create_partitioned_table_sql, build_table_partition_operation_sql, EditableStructureColumn,
        TablePartitionBoundDraft, TablePartitionDefinition, TablePartitionOperation, TablePartitionOperationKind,
        TablePartitionSqlOptions, TableStructureSqlOptions,
    };
    use dbx_core::types::PgPartitionKind;

    let pool = postgres::connect(&live_postgres_url(), Duration::from_secs(10)).await.expect("connect PostgreSQL");
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let schema = format!("dbx_partnew_{}", &suffix[..8]);
    let cleanup = vec![format!("DROP SCHEMA IF EXISTS \"{schema}\" CASCADE")];
    let _ = postgres::execute_batch(&pool, &cleanup).await;
    postgres::execute_batch(&pool, &[format!("CREATE SCHEMA \"{schema}\"")]).await.expect("create schema");

    let column = |name: &str, data_type: &str| EditableStructureColumn {
        id: name.to_string(),
        name: name.to_string(),
        data_type: data_type.to_string(),
        is_nullable: false,
        default_value: String::new(),
        comment: String::new(),
        is_primary_key: false,
        extra: None,
        original: None,
        original_position: None,
        marked_for_drop: false,
        character_set: String::new(),
        collation: String::new(),
    };
    let options = TableStructureSqlOptions {
        database_type: Some(DatabaseType::Postgres),
        driver_profile: None,
        schema: Some(schema.clone()),
        table_name: "sales".to_string(),
        columns: vec![column("sold_on", "date"), column("amount", "numeric")],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
        mysql_engine: None,
        partitioned: false,
        is_gaussdb_m_mode: false,
        table_collation: None,
    };
    let create = build_create_partitioned_table_sql(
        options,
        TablePartitionDefinition {
            kind: PgPartitionKind::Range,
            columns: vec!["sold_on".to_string()],
            expression: String::new(),
        },
    );
    assert!(create.warnings.is_empty(), "{:?}", create.warnings);
    postgres::execute_batch(&pool, &create.statements).await.expect("execute CREATE TABLE ... PARTITION BY");

    let add = build_table_partition_operation_sql(TablePartitionSqlOptions {
        database_type: Some(DatabaseType::Postgres),
        driver_profile: None,
        schema: Some(schema.clone()),
        table_name: "sales".to_string(),
        operations: vec![TablePartitionOperation {
            id: "op:1".to_string(),
            kind: TablePartitionOperationKind::Create,
            parent_schema: String::new(),
            parent_table: String::new(),
            schema: String::new(),
            name: "sales_2025".to_string(),
            bound: Some(TablePartitionBoundDraft::Range {
                from: vec!["'2025-01-01'".to_string()],
                to: vec!["'2026-01-01'".to_string()],
            }),
            concurrently: false,
        }],
    });
    postgres::execute_batch(&pool, &add.statements).await.expect("execute add partition");

    let partitioning = postgres::get_table_partitioning(&pool, &schema, "sales").await.expect("read partitioning");
    assert!(partitioning.is_partitioned);
    assert_eq!(partitioning.key_columns, vec!["sold_on".to_string()]);
    assert!(partitioning.partitions.iter().any(|node| node.name == "sales_2025"));

    postgres::execute_batch(&pool, &cleanup).await.expect("cleanup create-partitioned schema");
}
