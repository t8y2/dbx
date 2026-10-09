use super::*;
use crate::data::transfer;
use serde_json::json;

fn column(name: &str, data_type: &str) -> crate::db::ColumnInfo {
    crate::db::ColumnInfo {
        name: name.to_string(),
        data_type: data_type.to_string(),
        is_nullable: true,
        ..Default::default()
    }
}

fn request() -> TransferRequest {
    serde_json::from_value(json!({
        "transferId": "db2-transfer", "sourceConnectionId": "source",
        "sourceDatabase": "source", "sourceSchema": "public",
        "targetConnectionId": "target", "targetDatabase": "SAMPLE", "targetSchema": "APP",
        "tables": ["EVENTS"], "createTable": true, "content": "structureAndData",
        "mode": "append", "batchSize": 1000
    }))
    .unwrap()
}

#[test]
fn db2_transfer_maps_common_cross_database_types() {
    for (source, source_type, expected) in [
        (DatabaseType::Mysql, "tinyint(1)", "SMALLINT"),
        (DatabaseType::Mysql, "smallint unsigned", "INTEGER"),
        (DatabaseType::Mysql, "int unsigned", "BIGINT"),
        (DatabaseType::Mysql, "bigint unsigned", "DECIMAL(20,0)"),
        (DatabaseType::Mysql, "decimal(20,4) unsigned", "DECIMAL(20,4)"),
        (DatabaseType::Mysql, "datetime", "TIMESTAMP"),
        (DatabaseType::SqlServer, "datetime2(7)", "TIMESTAMP(7)"),
        (DatabaseType::SqlServer, "nvarchar(max)", "CLOB"),
        (DatabaseType::SqlServer, "bit", "BOOLEAN"),
        (DatabaseType::Postgres, "bigserial", "BIGINT"),
        (DatabaseType::Postgres, "numeric", "CLOB"),
        (DatabaseType::Postgres, "numeric(38,8)", "CLOB"),
        (DatabaseType::Postgres, "varchar(65535)", "CLOB"),
        (DatabaseType::Postgres, "varchar(64)", "VARCHAR(64)"),
        (DatabaseType::Postgres, "varchar", "CLOB"),
        (DatabaseType::Postgres, "character varying(64)", "VARCHAR(64)"),
        (DatabaseType::H2, "character large object", "CLOB"),
        (DatabaseType::H2, "binary varying(128)", "BLOB"),
        (DatabaseType::Postgres, "text", "CLOB"),
        (DatabaseType::Postgres, "jsonb", "CLOB"),
        (DatabaseType::Postgres, "bytea", "BLOB"),
        (DatabaseType::Postgres, "uuid", "VARCHAR(36)"),
        (DatabaseType::Postgres, "varbit(2048)", "CLOB"),
        (DatabaseType::Sqlite, "tinyint", "BIGINT"),
    ] {
        assert_eq!(transfer::map_column_type(source_type, &source, &DatabaseType::Db2), expected, "{source_type}");
    }
    assert_eq!(transfer::map_column_type("DECIMAL(20,4)", &DatabaseType::Db2, &DatabaseType::Db2), "DECIMAL(20,4)");
    assert_eq!(transfer::map_column_type("tinyint", &DatabaseType::Mysql, &DatabaseType::Postgres), "SMALLINT");
}

#[test]
fn db2_transfer_creates_schema_qualified_tables_with_primary_keys() {
    let columns = [
        crate::db::ColumnInfo { is_nullable: false, is_primary_key: true, ..column("ID", "bigint") },
        column("BODY", "text"),
        column("CREATED_AT", "datetime"),
    ];
    let sql = transfer::generate_create_table_ddl(
        &columns,
        "EVENTS",
        "source",
        "APP",
        &DatabaseType::Db2,
        &DatabaseType::Mysql,
        None,
        None,
    );
    assert_eq!(
        sql,
        "CREATE TABLE \"APP\".\"EVENTS\" (\n  \"ID\" BIGINT NOT NULL,\n  \"BODY\" CLOB,\n  \"CREATED_AT\" TIMESTAMP,\n  PRIMARY KEY (\"ID\")\n)"
    );
}

#[test]
fn db2_transfer_uses_a_single_agent_cursor_instead_of_limit_offset() {
    assert!(transfer::uses_agent_transfer_cursor(&DatabaseType::Db2));
    assert!(transfer::uses_agent_transfer_cursor(&DatabaseType::Impala));
    assert!(!transfer::uses_agent_transfer_cursor(&DatabaseType::Postgres));
    let sql = transfer::transfer_cursor_sql(
        &["ID".to_string(), "BODY".to_string()],
        "EVENTS",
        "APP",
        &DatabaseType::Db2,
        None,
    );
    assert_eq!(sql, "SELECT \"ID\", \"BODY\" FROM \"APP\".\"EVENTS\"");
}

#[test]
fn db2_transfer_rewrites_reused_ddl_without_changing_literals_or_comments() {
    let sql = r#"CREATE TABLE "SOURCE"."EVENTS" (
    "ID" INTEGER NOT NULL PRIMARY KEY,
    "NOTE" VARCHAR(80) DEFAULT '"SOURCE"."EVENTS"',
    "part""SOURCE"".value" INTEGER
);
COMMENT ON TABLE "SOURCE"."EVENTS" IS 'source table';
-- keep "SOURCE"."EVENTS" in comments"#;
    let rewritten = transfer::rewrite_transfer_source_table_ddl(
        sql,
        "SOURCE",
        "TARGET",
        &DatabaseType::Db2,
        &DatabaseType::Db2,
        "EVENTS",
        "EVENTS",
    )
    .unwrap();
    assert!(rewritten.starts_with("CREATE TABLE \"TARGET\".\"EVENTS\""));
    assert!(rewritten.contains("COMMENT ON TABLE \"TARGET\".\"EVENTS\""));
    assert!(rewritten.contains("DEFAULT '\"SOURCE\".\"EVENTS\"'"));
    assert!(rewritten.contains("\"part\"\"SOURCE\"\".value\""));
    assert!(rewritten.contains("-- keep \"SOURCE\".\"EVENTS\" in comments"));
}

#[test]
fn db2_transfer_writes_multiple_rows_without_changing_backslashes_or_binary_values() {
    let sql = transfer::generate_insert_typed(
        &["PATH".to_string(), "PAYLOAD".to_string()],
        &[Some("CLOB".to_string()), Some("BLOB".to_string())],
        &[vec![json!(r"C:\data\O'Brien"), json!("0x00ff")], vec![json!("中文"), json!("0x")]],
        "EVENTS",
        "APP",
        &DatabaseType::Db2,
        None,
    );
    assert_eq!(sql, "INSERT INTO \"APP\".\"EVENTS\" (\"PATH\", \"PAYLOAD\") VALUES\n('C:\\data\\O''Brien', BX'00ff'),\n('中文', BX'')");
    assert_eq!(transfer::escape_value_typed(&json!("0xFF"), &DatabaseType::Db2, Some("VARCHAR(20)")), "'0xFF'");
    assert_eq!(transfer::escape_value_typed(&json!(true), &DatabaseType::Db2, Some("BOOLEAN")), "TRUE");
    assert_eq!(transfer::escape_value(&json!(null), &DatabaseType::Db2), "NULL");
}

#[test]
fn db2_transfer_preserves_json_and_splits_large_lob_literals() {
    let numeric_text = "12345678901234567890123456789012.123456";
    let numeric: serde_json::Value = serde_json::from_str(numeric_text).unwrap();
    assert_eq!(
        transfer::escape_value_typed(&numeric, &DatabaseType::Db2, Some("NUMERIC(38,6)")),
        quote_string_literal(numeric_text)
    );
    assert_eq!(transfer::escape_value_typed(&json!(123), &DatabaseType::Db2, Some("INTEGER")), "123");
    let value = json!({ "path": r"C:\data", "values": [1, 2] });
    assert_eq!(transfer::escape_value(&value, &DatabaseType::Db2), quote_string_literal(&value.to_string()));
    assert_eq!(transfer::escape_value(&json!([1, 2]), &DatabaseType::Db2), "'[1,2]'");
    let text = "中'\\".repeat(8000);
    let literal = string_literal(&text, Some("CLOB"));
    assert!(literal.starts_with("CLOB('"));
    let restored = literal
        .split(" || ")
        .map(|part| {
            let quoted = part.strip_prefix("CLOB('").unwrap().strip_suffix("')").unwrap();
            assert!(quoted.len() < 32672);
            quoted.replace("''", "'")
        })
        .collect::<String>();
    assert_eq!(restored, text);
    let binary = format!("0x{}", "ff".repeat(16000));
    assert_eq!(
        string_literal(&binary, Some("BLOB")),
        format!("BLOB(BX'{}') || BLOB(BX'{}')", "ff".repeat(8000), "ff".repeat(8000))
    );
}

#[test]
fn db2_transfer_overwrite_uses_native_truncate_without_changing_other_engines() {
    assert_eq!(
        transfer::transfer_clear_table_sql("EVENTS", "APP", &DatabaseType::Db2, None),
        "TRUNCATE TABLE \"APP\".\"EVENTS\" IMMEDIATE"
    );
    assert_eq!(
        transfer::transfer_clear_table_sql("events", "public", &DatabaseType::Postgres, None),
        "TRUNCATE TABLE \"public\".\"events\""
    );
    assert_eq!(
        transfer::transfer_clear_table_sql("events", "main", &DatabaseType::Sqlite, None),
        "DELETE FROM \"main\".\"events\""
    );
}

#[test]
fn db2_transfer_rejects_unimplemented_modes_before_writing() {
    let mut request = request();
    assert!(validate_request(&request).is_ok());
    request.mode = TransferMode::Overwrite;
    assert!(validate_request(&request).is_ok());
    request.mode = TransferMode::Upsert;
    assert!(validate_request(&request).unwrap_err().contains("does not support upsert"));
    request.content = transfer::TransferContent::StructureOnly;
    assert!(validate_request(&request).is_ok());
    request.drop_target_before_create = true;
    assert!(validate_request(&request).unwrap_err().contains("does not support rebuilding"));
}

#[test]
fn db2_transfer_checks_generated_always_columns_before_overwrite() {
    assert!(validate_generated_columns(&[]).is_ok());
    assert!(validate_generated_columns(&[vec![json!("ID")]]).unwrap_err().contains("target data has not been cleared"));
    assert_eq!(
        generated_columns_sql("APP'S", "EVENTS", &["ID".to_string(), "O'Brien".to_string()]),
        "SELECT COLNAME FROM SYSCAT.COLUMNS WHERE TABSCHEMA = 'APP''S' AND TABNAME = 'EVENTS' AND GENERATED = 'A' AND COLNAME IN ('ID', 'O''Brien')"
    );
    assert!(generated_columns_sql("", "EVENTS", &["ID".to_string()]).contains("TABSCHEMA = CURRENT SCHEMA"));
}
