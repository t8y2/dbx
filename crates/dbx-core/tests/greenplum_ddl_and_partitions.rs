use std::collections::HashMap;
use std::time::Duration;

use dbx_core::models::connection::{ConnectionConfig, DatabaseConnectionInfo, DatabaseType};
use dbx_core::{db, schema};

fn make_config(db_type: &str, driver_profile: Option<&str>, product_version: Option<&str>) -> ConnectionConfig {
    let mut config: ConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": "gp-test",
        "name": "gp-test",
        "db_type": db_type,
        "host": "127.0.0.1",
        "port": 5432,
        "username": "postgres",
        "password": "",
    }))
    .expect("deserialize ConnectionConfig");
    config.driver_profile = driver_profile.map(str::to_string);
    config.database_info = product_version
        .map(|version| DatabaseConnectionInfo { product_version: Some(version.to_string()), ..Default::default() });
    config
}

fn pg_config(driver_profile: Option<&str>, product_version: Option<&str>) -> ConnectionConfig {
    make_config("postgres", driver_profile, product_version)
}

#[test]
fn config_routing_guards_isolate_non_greenplum_profiles_and_known_plain_postgres() {
    let unknown_pg = pg_config(None, None);
    assert!(db::greenplum::is_candidate_postgres_config(&unknown_pg));
    assert!(!db::greenplum::is_known_non_greenplum_config(&unknown_pg));

    let explicit_pg_with_gp6 = pg_config(
        Some("postgres"),
        Some("PostgreSQL 9.4.26 (Greenplum Database 6.26.1 build commit:abc123) on x86_64"),
    );
    assert!(db::greenplum::is_candidate_postgres_config(&explicit_pg_with_gp6));
    assert!(!db::greenplum::is_known_non_greenplum_config(&explicit_pg_with_gp6));

    let known_plain_pg = pg_config(Some("postgres"), Some("PostgreSQL 16.4 on x86_64-pc-linux-gnu"));
    assert!(db::greenplum::is_known_non_greenplum_config(&known_plain_pg));

    let known_cloudberry_under_pg = pg_config(Some("postgres"), Some("PostgreSQL 14.4 (Apache Cloudberry 1.5.0)"));
    assert!(db::greenplum::is_known_non_greenplum_config(&known_cloudberry_under_pg));

    let cloudberry_profile = pg_config(Some("cloudberry"), None);
    assert!(!db::greenplum::is_candidate_postgres_config(&cloudberry_profile));
    assert!(db::greenplum::is_known_non_greenplum_config(&cloudberry_profile));

    let opentenbase_profile = pg_config(Some("opentenbase"), None);
    assert!(db::greenplum::is_known_non_greenplum_config(&opentenbase_profile));

    let future_gp_profile = pg_config(Some("greenplum"), Some("PostgreSQL 16.4"));
    assert!(db::greenplum::is_config(&future_gp_profile));
    assert!(db::greenplum::is_candidate_postgres_config(&future_gp_profile));
    assert!(!db::greenplum::is_known_non_greenplum_config(&future_gp_profile));

    let mysql = make_config("mysql", None, None);
    assert_eq!(mysql.db_type, DatabaseType::Mysql);
    assert!(db::greenplum::is_known_non_greenplum_config(&mysql));
}

#[test]
fn gp6_child_partition_strips_inherits_even_when_default_mentions_inherits_text() {
    let ddl = "CREATE TABLE \"public\".\"t_1_prt_p1\" (\n  \"id\" int,\n  \"note\" text DEFAULT 'see INHERITS (docs);'\n) INHERITS (\"public\".\"t\");\n\nCREATE INDEX \"idx_t_p1\" ON \"public\".\"t_1_prt_p1\" (\"id\");\n";
    let rendered = db::greenplum::apply_table_modifiers(
        ddl,
        &db::greenplum::TableModifiers {
            reloptions: vec!["appendonly=true".to_string(), "oids=false".to_string()],
            distribution_clause: Some("DISTRIBUTED BY (id)".to_string()),
            gp6_child_partition: Some(db::greenplum::Gp6ChildPartitionHeader {
                parent_schema: "public".to_string(),
                parent_table: "t".to_string(),
                rule_definition: "PARTITION p1 START (1) END (100)".to_string(),
            }),
            ..Default::default()
        },
    )
    .expect("render GP6 child partition DDL");

    assert!(rendered.contains("DEFAULT 'see INHERITS (docs);'"));
    assert!(!rendered.contains(") INHERITS (\"public\".\"t\")"));
    assert!(rendered.contains("DISTRIBUTED BY (id);\n\nCREATE INDEX \"idx_t_p1\""));
}

#[test]
fn gp7_tree_modifiers_skip_non_table_statements_and_preserve_quoted_identifiers() {
    let ddl = "CREATE TABLE \"sales\".\"order\"\"items\" (\n  \"id\" bigint\n) PARTITION BY RANGE (id);\n\nCOMMENT ON TABLE \"sales\".\"order\"\"items\" IS 'header;comment';\n\nCREATE TABLE \"sales\".\"order\"\"items_p1\" PARTITION OF \"sales\".\"order\"\"items\" FOR VALUES FROM (1) TO (100);\n";
    let mut mods = HashMap::new();
    mods.insert(
        ("sales".to_string(), "order\"items".to_string()),
        db::greenplum::TableModifiers {
            distribution_clause: Some("DISTRIBUTED BY (id)".to_string()),
            ..Default::default()
        },
    );
    mods.insert(
        ("sales".to_string(), "order\"items_p1".to_string()),
        db::greenplum::TableModifiers {
            access_method: Some("ao_row".to_string()),
            reloptions: vec!["compresstype=zstd".to_string()],
            distribution_clause: Some("DISTRIBUTED BY (id)".to_string()),
            ..Default::default()
        },
    );

    let rendered = db::greenplum::apply_tree_table_modifiers(ddl, &mods).expect("render GP7 tree DDL");
    assert!(rendered.contains("PARTITION BY RANGE (id)\nDISTRIBUTED BY (id);"));
    assert!(rendered.contains("COMMENT ON TABLE \"sales\".\"order\"\"items\" IS 'header;comment';"));
    assert!(rendered.contains(
        "FOR VALUES FROM (1) TO (100)\nUSING \"ao_row\"\nWITH (\n  compresstype=zstd\n)\nDISTRIBUTED BY (id);"
    ));
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_GREENPLUM_URL pointing at a writable Greenplum 6.x or 7.x database"]
async fn live_greenplum_metadata_partitions_and_ddl_round_trip() {
    let url = std::env::var("DBX_LIVE_GREENPLUM_URL").expect("DBX_LIVE_GREENPLUM_URL");
    let pool = db::postgres::connect(&url, Duration::from_secs(10)).await.expect("connect Greenplum");
    let caps = db::greenplum::probe_capabilities(&pool).await.expect("probe Greenplum capabilities");
    assert!(caps.is_greenplum, "target server did not identify as Greenplum: {}", caps.server_version);

    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source_schema = format!("dbx_gp_src_{suffix}");
    let target_schema = format!("dbx_gp_dst_{suffix}");
    let source_ident = quote_ident(&source_schema);
    let target_ident = quote_ident(&target_schema);

    let setup_statements = if caps.is_classic_gp6() {
        vec![
            format!("CREATE SCHEMA {source_ident}"),
            format!("CREATE SCHEMA {target_ident}"),
            format!(
                "CREATE TABLE {source_ident}.ao_zstd_flows (fund_acc_no varchar(32) NOT NULL, amount numeric(18,2)) \
                 WITH (appendonly=true, orientation=column, compresstype=zstd, compresslevel=1) \
                 DISTRIBUTED BY (fund_acc_no)"
            ),
            format!("CREATE TABLE {source_ident}.rand_logs (id int, msg text) DISTRIBUTED RANDOMLY"),
            format!("CREATE TABLE {source_ident}.rep_dims (id int, label text) DISTRIBUTED REPLICATED"),
            format!(
                "CREATE TABLE {source_ident}.sales_part (id bigint, biz_date date, region varchar(16)) \
                 WITH (appendonly=true, compresstype=zlib, compresslevel=1) \
                 DISTRIBUTED BY (id) \
                 PARTITION BY RANGE (biz_date) \
                 SUBPARTITION BY LIST (region) \
                 SUBPARTITION TEMPLATE ( \
                   SUBPARTITION east VALUES ('SH', 'HZ'), \
                   DEFAULT SUBPARTITION other_region \
                 ) \
                 ( \
                   PARTITION p202601 START ('2026-01-01'::date) INCLUSIVE END ('2026-02-01'::date) EXCLUSIVE, \
                   DEFAULT PARTITION p_default \
                 )"
            ),
        ]
    } else {
        vec![
            format!("CREATE SCHEMA {source_ident}"),
            format!("CREATE SCHEMA {target_ident}"),
            format!(
                "CREATE TABLE {source_ident}.ao_zstd_flows (fund_acc_no varchar(32) NOT NULL, amount numeric(18,2)) \
                 USING ao_column WITH (compresstype=zstd, compresslevel=1) \
                 DISTRIBUTED BY (fund_acc_no)"
            ),
            format!("CREATE TABLE {source_ident}.rand_logs (id int, msg text) DISTRIBUTED RANDOMLY"),
            format!("CREATE TABLE {source_ident}.rep_dims (id int, label text) DISTRIBUTED REPLICATED"),
            format!(
                "CREATE TABLE {source_ident}.sales_part (id bigint, biz_date date, region varchar(16)) \
                 PARTITION BY RANGE (biz_date) DISTRIBUTED BY (id)"
            ),
            format!(
                "CREATE TABLE {source_ident}.sales_part_202601 PARTITION OF {source_ident}.sales_part \
                 FOR VALUES FROM ('2026-01-01') TO ('2026-02-01')"
            ),
        ]
    };

    db::postgres::execute_batch(&pool, &setup_statements).await.expect("create Greenplum fixtures");

    let exercise = async {
        // 1. Root-paged table listing folds partitions beneath roots.
        let paged =
            db::greenplum::list_table_roots_page_filtered(&pool, &caps, &source_schema, None, Some(10), Some(0), false)
                .await?;
        let root_names: Vec<&str> = paged.iter().filter(|t| t.parent_name.is_none()).map(|t| t.name.as_str()).collect();
        assert_eq!(root_names.len(), 4, "expected exactly 4 top-level tables, got {root_names:?}");
        assert!(
            paged.iter().any(|t| t.parent_name.as_deref() == Some("sales_part")),
            "expected child partitions attached under sales_part: {paged:?}"
        );

        // 2. Partition status and structured tree.
        let status = db::greenplum::get_table_partition_status(&pool, &caps, &source_schema, "sales_part").await?;
        assert!(status.is_partitioned_parent);
        assert!(!status.is_partition);

        let partitioning = db::greenplum::get_table_partitioning(&pool, &caps, &source_schema, "sales_part").await?;
        assert!(partitioning.is_partitioned);
        assert!(!partitioning.partitions.is_empty());
        if caps.is_classic_gp6() {
            assert!(
                partitioning.partitions.iter().any(|node| !node.children.is_empty()),
                "expected multi-level subpartitions in GP6 tree: {partitioning:?}"
            );
        }

        // 3. DDL generation + round-trip replay into target schema.
        for (table, expected_fragments) in [
            ("ao_zstd_flows", vec!["compresstype=zstd", "DISTRIBUTED BY"]),
            ("rand_logs", vec!["DISTRIBUTED RANDOMLY"]),
            ("rep_dims", vec!["DISTRIBUTED REPLICATED"]),
            ("sales_part", vec!["DISTRIBUTED BY", "PARTITION BY RANGE"]),
        ] {
            let ddl = schema::greenplum_ddl(&pool, &caps, &source_schema, table, true, false).await?;
            for fragment in expected_fragments {
                assert!(ddl.contains(fragment), "{table} DDL missing `{fragment}`:\n{ddl}");
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
    .expect("drop Greenplum fixtures");

    exercise.expect("validate live Greenplum round trip");
}

fn quote_ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
