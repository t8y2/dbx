use super::*;
use serde_json::json;

fn col(name: &str, kind: &str) -> db::ColumnInfo {
    db::ColumnInfo { name: name.into(), data_type: kind.into(), is_nullable: true, ..Default::default() }
}

fn catalog(columns: &[db::ColumnInfo]) -> Evidence {
    serde_json::from_value(json!({
        "version":120000,"kind":"r","persistence":"p","partitioned":false,
        "inherits":false,"row_security":false,"triggers":false,"indexes":false,
        "comment":"table's comment", "keys":[],
        "columns": columns.iter().map(|c| json!({
            "name":c.name,"kind":c.data_type,"namespace":"pg_catalog","type_class":"b",
            "generated":"","identity":"","default":null,"not_null":!c.is_nullable,
            "custom_collation":false,"comment":null,"sequence":null
        })).collect::<Vec<_>>()
    }))
    .unwrap()
}

#[test]
fn native_pair_does_not_enable_compatible_engines_or_reverse_transfers() {
    assert!(is_pair(&DatabaseType::Postgres, &DatabaseType::Xugu));
    for source in [
        DatabaseType::Kingbase,
        DatabaseType::OpenGauss,
        DatabaseType::Gaussdb,
        DatabaseType::Mysql,
        DatabaseType::Xugu,
    ] {
        assert!(!is_pair(&source, &DatabaseType::Xugu));
    }
    assert!(!is_pair(&DatabaseType::Xugu, &DatabaseType::Postgres));
}

#[test]
fn native_profile_guard_rejects_compatible_profiles() {
    for profile in [None, Some("postgres"), Some("highgo"), Some("kingbase"), Some("opengauss"), Some("postgres-jdbc")]
    {
        let config: ConnectionConfig = serde_json::from_value(json!({"id":"test","name":"test","db_type":"postgres","host":"","port":5432,"username":"","password":"","driver_profile":profile})).unwrap();
        assert_eq!(profile_allowed(&config), matches!(profile, None | Some("postgres")));
    }
}

#[tokio::test]
async fn preset_filters_fail_before_connecting_instead_of_widening_the_transfer() {
    let dir = tempfile::tempdir().unwrap();
    let storage = crate::persistence::test_storage::open(&dir.path().join("test.db")).await.unwrap();
    let state = AppState::new(storage);
    let config: ConnectionConfig = serde_json::from_value(
        json!({"id":"src","name":"src","db_type":"postgres","host":"","port":5432,"username":"","password":""}),
    )
    .unwrap();
    state.configs.write().await.insert("src".into(), config);
    let request: TransferRequest=serde_json::from_value(json!({"transferId":"filter-test","sourceConnectionId":"src","sourceDatabase":"db","sourceSchema":"src","targetConnectionId":"dst","targetDatabase":"db","targetSchema":"dst","tables":["items"],"createTable":true,"batchSize":2,"tableFilters":{"items":"id<10"}})).unwrap();
    let error = preflight(&state, &request, "missing-source-pool", "missing-target-pool").await.unwrap_err();
    assert!(error.contains("does not support table filters"), "{error}");
    assert!(state.connection_pools_snapshot().await.is_empty());
}

#[test]
fn explicit_type_mapping_matrix() {
    for (source, expected) in [
        ("smallint", "SMALLINT"),
        ("integer", "INTEGER"),
        ("bigint", "BIGINT"),
        ("oid", "BIGINT"),
        ("numeric(38,6)", "NUMERIC(38,6)"),
        ("numeric(10,0)", "NUMERIC(10,0)"),
        ("real", "FLOAT"),
        ("double precision", "DOUBLE"),
        ("boolean", "BOOLEAN"),
        ("character(10)", "CHAR(10)"),
        ("character varying(100)", "VARCHAR(100)"),
        ("character varying", "CLOB"),
        ("text", "CLOB"),
        ("bytea", "BLOB"),
        ("uuid", "VARCHAR(36)"),
        ("json", "CLOB"),
        ("jsonb", "CLOB"),
        ("date", "DATE"),
        ("time(3) without time zone", "TIME(3)"),
        ("time(0) without time zone", "TIME(0)"),
        ("timestamp without time zone", "DATETIME(6)"),
        ("timestamp(2) without time zone", "DATETIME(2)"),
        ("time without time zone", "INTERVAL HOUR(2) TO SECOND(6)"),
        ("time(4) without time zone", "INTERVAL HOUR(2) TO SECOND(6)"),
        ("time(3) with time zone", "TIME(3) WITH TIME ZONE"),
        ("timestamp with time zone", "DATETIME(6) WITH TIME ZONE"),
        ("timestamp(3) with time zone", "DATETIME(3) WITH TIME ZONE"),
        ("interval year to month", "INTERVAL YEAR(8) TO MONTH"),
        ("interval month", "INTERVAL YEAR(8) TO MONTH"),
        ("interval day to second(6)", "INTERVAL DAY(6) TO SECOND(6)"),
        ("interval hour to minute", "INTERVAL DAY(6) TO SECOND(6)"),
        ("interval second(3)", "INTERVAL DAY(6) TO SECOND(6)"),
        ("bit(9)", "BIT(9)"),
        ("bit varying(17)", "VARBIT(17)"),
        ("bit varying", "VARBIT(60000)"),
        ("xml", "CLOB"),
        ("jsonpath", "CLOB"),
        ("name", "VARCHAR(64)"),
        ("xid", "BIGINT"),
    ] {
        assert_eq!(column_type(&col("value", source)).unwrap(), expected, "{source}");
    }
}

#[test]
fn unsupported_types_and_lossy_domains_never_fall_back_to_source_spelling() {
    for kind in [
        "numeric",
        "numeric(39,0)",
        "numeric(3,-2)",
        "numeric(3,5)",
        "time with time zone",
        "time(6) with time zone",
        "interval",
        "character varying(60001)",
        "integer[]",
        "bit(60001)",
        "bit varying(60001)",
        "inet",
        "cidr",
        "macaddr",
        "macaddr8",
        "xid8",
        "tsvector",
        "tsquery",
        "pg_lsn",
        "numrange",
        "daterange",
        "tsrange",
        "tstzrange",
        "int8range",
        "int4multirange",
        "money",
        "point",
        "lseg",
        "box",
        "geometry(Point,4326)",
        "geography(Point,4326)",
        "int4range",
        "vector(3)",
        "my_enum",
    ] {
        assert!(column_type(&col("value", kind)).is_err(), "{kind}");
    }
}

#[test]
fn extended_capacity_and_projected_values_fail_closed() {
    for (source, target, ok) in [
        ("bit(8)", "BIT(8)", true),
        ("bit(8)", "BIT(9)", false),
        ("bit varying(9)", "VARBIT(8)", false),
        ("bit varying(9)", "VARBIT(10)", true),
        ("time", "INTERVAL HOUR(2) TO SECOND(6)", true),
        ("time", "INTERVAL HOUR(2) TO SECOND(3)", false),
        ("timestamp with time zone", "DATETIME(6) WITH TIME ZONE", true),
        ("timestamp with time zone", "DATETIME(3) WITH TIME ZONE", false),
        ("timestamp with time zone", "DATETIME(6)", false),
        ("xml", "CLOB", true),
        ("xml", "XML", false),
        ("interval year to month", "INTERVAL YEAR(8) TO MONTH", true),
        ("interval year to month", "INTERVAL YEAR(7) TO MONTH", false),
    ] {
        assert_eq!(validate_target(&[col("v", source)], &[col("v", target)]).is_ok(), ok, "{source} -> {target}");
    }
    for (kind, good, bad) in [
        ("time", "23:59:59.999999", "25:00:00"),
        ("time", "24:00:00.000000", "24:00:00.000001"),
        ("bit(8)", "00000001", "101"),
        ("bit varying(8)", "", "000000001"),
        ("interval year to month", "-99999999-11", "100000000-0"),
        ("interval day to second(6)", "-999999 23:59:59.999999", "1 -01:00:00"),
        ("timestamp with time zone", "2026-01-01 12:34:56.123456 +00:00", "2026-01-01 12:34:56"),
    ] {
        assert!(validate_rows(&[col("v", kind)], &[vec![json!(good)]]).is_ok(), "{kind}: {good}");
        assert!(validate_rows(&[col("v", kind)], &[vec![json!(bad)]]).is_err(), "{kind}: {bad}");
    }
}

#[test]
fn catalog_identity_completeness_and_unsupported_features_fail_closed() {
    let columns = [col("value", "integer")];
    for field in ["partitioned", "inherits", "row_security", "triggers", "indexes"] {
        let mut evidence = catalog(&columns);
        match field {
            "partitioned" => evidence.partitioned = true,
            "inherits" => evidence.inherits = true,
            "row_security" => evidence.row_security = true,
            "triggers" => evidence.triggers = true,
            _ => evidence.indexes = true,
        }
        assert!(prepare(&evidence, &columns, "dst", "table").is_err(), "{field}");
    }
    let mut evidence = catalog(&columns);
    evidence.columns[0].name = "other".into();
    assert!(prepare(&evidence, &columns, "dst", "table").is_err());
    assert!(prepare(&catalog(&[]), &[], "dst", "table").is_err());
    for namespace in ["public", "custom"] {
        let mut evidence = catalog(&columns);
        evidence.columns[0].namespace = namespace.into();
        assert!(prepare(&evidence, &columns, "dst", "table").is_err());
    }
    for class in ["d", "e", "c"] {
        let mut evidence = catalog(&columns);
        evidence.columns[0].type_class = class.into();
        assert!(prepare(&evidence, &columns, "dst", "table").is_err());
    }
}

#[test]
fn names_comments_keys_nullability_and_literal_defaults_are_preserved() {
    let mut column = col("Odd\"Name", "character varying(20)");
    column.is_nullable = false;
    let columns = [column];
    let mut evidence = catalog(&columns);
    evidence.columns[0].default = Some("'O''Brien\\file'::character varying".into());
    evidence.columns[0].comment = Some("column's comment".into());
    evidence.keys.push(Key {
        name: "PrimaryKey".into(),
        kind: "p".into(),
        columns: vec!["Odd\"Name".into()],
        deferrable: false,
        validated: true,
        nulls_not_distinct: false,
        plain_index: true,
    });
    let ddl = prepare(&evidence, &columns, "DstSchema", "MixedTable").unwrap().ddl;
    assert!(ddl.contains("CREATE TABLE \"DstSchema\".\"MixedTable\""));
    assert!(ddl.contains("\"Odd\"\"Name\" VARCHAR(20) DEFAULT 'O''Brien\\file' NOT NULL"));
    assert!(ddl.contains("CONSTRAINT \"PrimaryKey\" PRIMARY KEY (\"Odd\"\"Name\")"));
    assert!(ddl.contains("COMMENT ON COLUMN \"DstSchema\".\"MixedTable\".\"Odd\"\"Name\" IS 'column''s comment'"));
}

#[test]
fn foreign_checks_deferrable_and_nulls_not_distinct_constraints_are_rejected() {
    let columns = [col("id", "integer")];
    for (kind, deferred, validated, nulls) in [
        ("f", false, true, false),
        ("c", false, true, false),
        ("x", false, true, false),
        ("u", true, true, false),
        ("u", false, false, false),
        ("u", false, true, true),
    ] {
        let mut evidence = catalog(&columns);
        evidence.keys.push(Key {
            name: "test_key".into(),
            kind: kind.into(),
            columns: vec!["id".into()],
            deferrable: deferred,
            validated,
            nulls_not_distinct: nulls,
            plain_index: true,
        });
        assert!(prepare(&evidence, &columns, "dst", "table").is_err());
    }
}

#[test]
fn serial_and_by_default_identity_keep_start_and_positive_or_negative_step() {
    let columns = [col("id", "integer")];
    for (start, step, min, max) in [(100, 5, 1, i32::MAX), (-10, -3, i32::MIN, -1)] {
        let mut evidence = catalog(&columns);
        evidence.columns[0].sequence = Some(Sequence {
            reference: "src.items_id_seq".into(),
            start: start.to_string(),
            increment: step.to_string(),
            min: min.to_string(),
            max: max.to_string(),
            cycle: false,
        });
        evidence.columns[0].identity = "d".into();
        assert!(prepare(&evidence, &columns, "dst", "table")
            .unwrap()
            .ddl
            .contains(&format!("IDENTITY({start},{step})")));
        evidence.columns[0].identity = "a".into();
        assert!(prepare(&evidence, &columns, "dst", "table").is_err());
        evidence.columns[0].identity = "".into();
        evidence.columns[0].default = Some("nextval('src.items_id_seq'::regclass)".into());
        assert!(prepare(&evidence, &columns, "dst", "table").is_ok());
        for default in [
            None,
            Some("42"),
            Some("nextval('src.other_seq'::regclass)"),
            Some("nextval('src.items_id_seq'::regclass) + 1"),
        ] {
            evidence.columns[0].default = default.map(str::to_string);
            assert!(prepare(&evidence, &columns, "dst", "table").is_err());
        }
        evidence.columns[0].default = Some("nextval('src.items_id_seq'::regclass)".into());
        evidence.columns[0].sequence.as_mut().unwrap().cycle = true;
        assert!(prepare(&evidence, &columns, "dst", "table").is_err());
    }
}

#[test]
fn defaults_do_not_silently_drop_expressions_or_sequences() {
    assert_eq!(literal_default("B'00000001'::bit(8)", &col("v", "bit(8)")).unwrap(), "B'00000001'");
    assert_eq!(literal_default("(-12)", &col("v", "integer")).unwrap(), "-12");
    assert_eq!(literal_default("true", &col("v", "boolean")).unwrap(), "TRUE");
    for default in ["now()", "nextval('public.seq'::regclass)", "1+2", "(SELECT 1)", "'1.9'::numeric(2,1)"] {
        assert!(literal_default(default, &col("v", "integer")).is_err(), "{default}");
    }
    assert!(literal_default("'text '", &col("v", "character varying(20)")).is_err());
    assert!(literal_default(r"'\x00ff'::bytea", &col("v", "bytea")).is_err());
    assert_eq!(literal_default("NULL::bytea", &col("v", "bytea")).unwrap(), "NULL");
}

#[test]
fn wire_projection_casts_after_native_keyset_order_and_preserves_ctid_cursor() {
    let columns = [col("id", "bigint"), col("payload", "bytea")];
    let sql = "SELECT \"id\", \"payload\" FROM \"src\".\"table\" WHERE \"id\">9 ORDER BY \"id\" LIMIT 2";
    let projected = project_page(sql, &columns, &["id".into()]).unwrap();
    assert!(projected.contains(&format!("FROM ({sql}) AS dbx_pg_source ORDER BY dbx_pg_source.\"id\"")));
    assert!(projected.contains("dbx_pg_source.\"id\"::text AS \"id\""));
    assert!(projected.contains("'0x'||pg_catalog.encode(dbx_pg_source.\"payload\",'hex')"));
    let ctid_sql = format!(
        "SELECT \"id\", \"payload\", ctid::text AS {POSTGRES_CTID_ALIAS} FROM \"src\".\"table\" ORDER BY ctid LIMIT 2"
    );
    let projected = project_page(&ctid_sql, &columns, &[]).unwrap();
    assert!(projected.ends_with(&format!("ORDER BY dbx_pg_source.{POSTGRES_CTID_ALIAS}::tid")));
    assert!(project_page("SELECT dangerous()", &columns, &[]).is_err());
}

#[test]
fn row_validation_distinguishes_null_empty_and_unsupported_values() {
    for value in [json!(null), json!(""), json!("quote's \\path\n中文 ")] {
        assert!(validate_rows(&[col("v", "text")], &[vec![value]]).is_ok());
    }
    for (kind, value) in [
        ("text", "emoji 😀"),
        ("text", "zero\0byte"),
        ("character varying(20)", "trailing "),
        ("real", "NaN"),
        ("double precision", "Infinity"),
        ("numeric(20,2)", "-Infinity"),
        ("date", "infinity"),
        ("timestamp without time zone", "2026-01-01 00:00:00 BC"),
        ("time(3) without time zone", "24:00:00"),
    ] {
        assert!(validate_rows(&[col("v", kind)], &[vec![json!(value)]]).is_err(), "{kind}: {value}");
    }
    assert!(validate_rows(&[col("v", "bigint")], &[vec![json!(1)]]).is_err());
    assert!(validate_rows(&[col("v", "bigint")], &[vec![]]).is_err());
    assert!(
        validate_rows(&[col("v", "timestamp without time zone")], &[vec![json!("2026-02-03 04:05:06.123456")]]).is_ok()
    );
}

#[test]
fn target_capacity_and_required_columns_checked_before_overwrite() {
    let source = [col("v", "numeric(38,6)")];
    let target = [col("v", "NUMERIC(38,6)")];
    assert!(validate_target(&source, &target).is_ok());
    for kind in ["NUMERIC(38,5)", "NUMERIC(37,6)", "VARCHAR(80)"] {
        assert!(validate_target(&source, &[col("v", kind)]).is_err());
    }
    assert!(validate_target(&[col("v", "text")], &[col("v", "VARCHAR(60000)")]).is_err());
    assert!(validate_target(&[col("v", "jsonb")], &[col("v", "JSON")]).is_err());
    assert!(validate_target(&[col("v", "jsonb")], &[col("v", "CLOB")]).is_ok());
    assert!(validate_target(&[col("v", "time(3) without time zone")], &[col("v", "TIME(2)")]).is_err());
    let mut required = col("missing", "INTEGER");
    required.is_nullable = false;
    assert!(validate_target(&source, &[target[0].clone(), required]).is_err());
}

#[test]
fn writes_retain_exact_numeric_text_binary_and_backslashes() {
    let rows = vec![vec![
        json!("9223372036854775807"),
        json!("12345678901234567890123456789012.123456"),
        json!("quote's \\file\n"),
        json!("0x00ff"),
        json!(null),
    ]];
    let types = ["BIGINT", "NUMERIC(38,6)", "CLOB", "BLOB", "JSON"].map(|v| Some(v.into()));
    let names = ["big", "decimal", "text", "bin", "json"].map(str::to_string);
    let sql = mysql_xugu::write_batches(
        &names,
        &types,
        &rows,
        "table",
        "dst",
        None,
        SqlBatchLimits::for_database(&DatabaseType::Xugu, 500),
        true,
    )
    .unwrap()
    .join("\n");
    assert!(sql.contains("9223372036854775807"));
    assert!(sql.contains("12345678901234567890123456789012.123456"));
    assert!(sql.contains("'quote''s \\file\n'"));
    assert!(sql.contains("00ff"));
    assert!(sql.contains("NULL"));
}
