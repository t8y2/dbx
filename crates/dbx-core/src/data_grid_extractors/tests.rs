use super::*;
use crate::data_grid_sql::{DataGridColumnInfo, DataGridTableMeta};
use crate::models::connection::DatabaseType;
use serde_json::json;

fn column(name: &str, source_index: usize) -> DataGridExtractColumn {
    DataGridExtractColumn { display_name: name.to_string(), source_name: Some(name.to_string()), source_index }
}

fn request(extractor: DataGridExtractorId) -> DataGridExtractRequest {
    DataGridExtractRequest {
        version: DATA_GRID_EXTRACTOR_CONTRACT_VERSION,
        extractor,
        database_type: Some(DatabaseType::Postgres),
        table_meta: None,
        columns: vec![column("id", 0), column("name", 1)],
        selected_column_indexes: vec![0, 1],
        rows: vec![vec![json!(1), json!("Ada")], vec![json!(2), json!("Grace, Hopper")]],
        selection_kind: DataGridSelectionKind::Cells,
        options: DataGridExtractorOptions::default(),
    }
}

#[test]
fn partially_deserialized_options_use_the_canonical_defaults() {
    let options = serde_json::from_value::<DataGridExtractorOptions>(json!({
        "dsv": { "columnSeparator": ";" },
        "sql": { "skipGeneratedColumns": false },
        "json": {}
    }))
    .expect("deserialize partial extractor options");

    assert_eq!(options.dsv.column_separator, ";");
    assert_eq!(options.dsv.row_separator, "\n");
    assert_eq!(options.dsv.null_text, "NULL");
    assert_eq!(options.dsv.quote, '"');
    assert_eq!(options.dsv.quote_policy, DataGridQuotePolicy::Minimal);
    assert!(!options.dsv.include_column_header);
    assert!(!options.dsv.include_row_header);
    assert!(options.sql.skip_computed_columns);
    assert!(!options.sql.skip_generated_columns);
    assert_eq!(options.sql.insert_mode, crate::data_grid_sql::DataGridCopyInsertMode::Merged);
    assert!(!options.sql.exclude_primary_keys_from_insert);
    assert!(options.json.pretty);
}

#[test]
fn extracts_csv_with_minimal_standard_quoting() {
    let result = extract_data_grid_selection(request(DataGridExtractorId::Csv)).expect("CSV extraction");
    assert_eq!(result.text, "1,Ada\n2,\"Grace, Hopper\"");
}

#[test]
fn csv_distinguishes_null_from_null_string() {
    let mut request = request(DataGridExtractorId::Csv);
    request.rows = vec![vec![json!(1), Value::Null], vec![json!(2), json!("NULL")]];
    let result = extract_data_grid_selection(request).expect("CSV extraction");
    // NULL emits the bare sentinel; the literal string "NULL" is force-quoted.
    assert_eq!(result.text, "1,NULL\n2,\"NULL\"");
}

#[test]
fn csv_keeps_null_unquoted_under_always_quote() {
    let mut request = request(DataGridExtractorId::Csv);
    request.rows = vec![vec![json!(1), Value::Null], vec![json!(2), json!("NULL")]];
    request.options.dsv.quote_policy = DataGridQuotePolicy::Always;
    let result = extract_data_grid_selection(request).expect("CSV extraction");
    // NULL stays bare even under Always; the string is quoted, so they differ.
    assert_eq!(result.text, "\"1\",NULL\n\"2\",\"NULL\"");
}

#[test]
fn csv_null_and_sentinel_collapse_under_never_quote() {
    let mut request = request(DataGridExtractorId::Csv);
    request.rows = vec![vec![json!(1), Value::Null], vec![json!(2), json!("NULL")]];
    request.options.dsv.quote_policy = DataGridQuotePolicy::Never;
    let result = extract_data_grid_selection(request).expect("CSV extraction");
    // Under Never quoting, NULL and the string "NULL" are inherently indistinguishable.
    assert_eq!(result.text, "1,NULL\n2,NULL");
}

#[test]
fn csv_empty_null_text_distinguishes_empty_string() {
    let mut request = request(DataGridExtractorId::Csv);
    request.rows = vec![vec![json!(1), Value::Null], vec![json!(2), json!("")]];
    request.options.dsv.null_text = String::new();
    let result = extract_data_grid_selection(request).expect("CSV extraction");
    // NULL -> bare empty; the empty string is force-quoted.
    assert_eq!(result.text, "1,\n2,\"\"");
}

#[test]
fn one_row_distinguishes_null_from_null_string() {
    let mut request = request(DataGridExtractorId::OneRow);
    request.rows = vec![vec![json!(1), Value::Null], vec![json!(2), json!("NULL")]];
    let result = extract_data_grid_selection(request).expect("one-row extraction");
    assert_eq!(result.text, "1,NULL,2,\"NULL\"");
}

#[test]
fn extracts_one_row_as_a_single_csv_record() {
    let result = extract_data_grid_selection(request(DataGridExtractorId::OneRow)).expect("One-row extraction");
    assert_eq!(result.text, "1,Ada,2,\"Grace, Hopper\"");
}

#[test]
fn extracts_all_remaining_text_table_formats() {
    let cases = [
        (DataGridExtractorId::Tsv, "1\tAda\n2\tGrace, Hopper"),
        (DataGridExtractorId::TsvWithHeaders, "id\tname\n1\tAda\n2\tGrace, Hopper"),
        (DataGridExtractorId::CsvWithHeaders, "id,name\n1,Ada\n2,\"Grace, Hopper\""),
        (DataGridExtractorId::PipeSeparated, "1|Ada\n2|Grace, Hopper"),
        (
            DataGridExtractorId::Markdown,
            "| id | name |\n| --- | --- |\n| 1 | Ada |\n| 2 | Grace, Hopper |",
        ),
        (
            DataGridExtractorId::Pretty,
            "+----+---------------+\n| id | name          |\n+----+---------------+\n| 1  | Ada           |\n| 2  | Grace, Hopper |\n+----+---------------+\n",
        ),
    ];

    for (extractor, expected) in cases {
        let result = extract_data_grid_selection(request(extractor)).expect("text table extraction");
        assert_eq!(result.text, expected, "unexpected output for {extractor:?}");
        assert_eq!(result.row_count, 2);
        assert_eq!(result.column_count, 2);
    }
}

#[test]
fn pretty_output_uses_terminal_width_for_cjk_and_emoji() {
    let mut request = request(DataGridExtractorId::Pretty);
    request.columns = vec![column("标签", 0), column("name", 1)];
    request.rows = vec![vec![json!("中文"), json!("🙂")]];

    let result = extract_data_grid_selection(request).expect("Unicode pretty extraction");

    assert_eq!(
        result.text,
        "+------+------+
| 标签 | name |
+------+------+
| 中文 | 🙂   |
+------+------+
"
    );
}

#[test]
fn one_row_honors_standard_csv_quote_configuration() {
    let mut request = request(DataGridExtractorId::OneRow);
    request.options.dsv.quote_policy = DataGridQuotePolicy::Always;
    request.options.dsv.quote = '\'';

    let result = extract_data_grid_selection(request).expect("configured One-row extraction");

    assert_eq!(result.text, "'1','Ada','2','Grace, Hopper'");
}

#[test]
fn extracts_multi_column_sql_in_as_row_value_tuples() {
    let result = extract_data_grid_selection(request(DataGridExtractorId::SqlInList)).expect("SQL IN extraction");
    assert_eq!(result.text, "((1, 'Ada'), (2, 'Grace, Hopper'))");
}

#[test]
fn preserves_duplicate_json_columns_without_overwriting_values() {
    let mut request = request(DataGridExtractorId::Json);
    request.columns[1].display_name = "id".to_string();
    let result = extract_data_grid_selection(request).expect("JSON extraction");
    assert!(result.text.contains("\"id_2\""));
    assert_eq!(result.warnings.len(), 1);
}

#[test]
fn avoids_collisions_between_generated_and_existing_json_column_suffixes() {
    let mut request = request(DataGridExtractorId::Json);
    request.columns = vec![column("id", 0), column("id", 1), column("id_2", 2)];
    request.selected_column_indexes = vec![0, 1, 2];
    request.rows = vec![vec![json!(1), json!(2), json!(3)]];

    let result = extract_data_grid_selection(request).expect("JSON extraction");
    let rows = serde_json::from_str::<Value>(&result.text).expect("valid JSON output");

    assert_eq!(rows, json!([{"id": 1, "id_3": 2, "id_2": 3}]));
    assert_eq!(result.warnings.len(), 1);
}

#[test]
fn builds_updates_with_hidden_primary_keys_and_selected_columns() {
    let mut request = request(DataGridExtractorId::SqlUpdates);
    request.table_meta = Some(DataGridTableMeta {
        catalog: None,
        database: None,
        schema: Some("public".to_string()),
        table_name: "users".to_string(),
        primary_keys: vec!["id".to_string()],
        columns: Some(vec![
            DataGridColumnInfo {
                name: "id".to_string(),
                data_type: "int".to_string(),
                is_nullable: false,
                is_primary_key: true,
                column_default: None,
                extra: None,
            },
            DataGridColumnInfo {
                name: "name".to_string(),
                data_type: "varchar".to_string(),
                is_nullable: false,
                is_primary_key: false,
                column_default: None,
                extra: None,
            },
        ]),
    });
    request.selected_column_indexes = vec![1];
    let result = extract_data_grid_selection(request).expect("SQL Updates extraction");
    assert_eq!(
        result.text,
        "UPDATE \"public\".\"users\" SET \"name\" = 'Ada' WHERE \"id\" = 1;\nUPDATE \"public\".\"users\" SET \"name\" = 'Grace, Hopper' WHERE \"id\" = 2;"
    );
}

#[test]
fn sql_update_computed_column_option_matches_the_frontend_capability() {
    let mut request = request(DataGridExtractorId::SqlUpdates);
    request.columns[1].display_name = "search_text".to_string();
    request.columns[1].source_name = Some("search_text".to_string());
    request.selected_column_indexes = vec![1];
    request.table_meta = Some(DataGridTableMeta {
        catalog: None,
        database: None,
        schema: None,
        table_name: "users".to_string(),
        primary_keys: vec!["id".to_string()],
        columns: Some(vec![
            DataGridColumnInfo {
                name: "id".to_string(),
                data_type: "int".to_string(),
                is_nullable: false,
                is_primary_key: true,
                column_default: None,
                extra: None,
            },
            DataGridColumnInfo {
                name: "search_text".to_string(),
                data_type: "text".to_string(),
                is_nullable: true,
                is_primary_key: false,
                column_default: None,
                extra: Some("GENERATED ALWAYS AS".to_string()),
            },
        ]),
    });

    let skipped = extract_data_grid_selection(request.clone()).expect_err("computed UPDATE is skipped by default");
    assert_eq!(skipped.code, DataGridExtractErrorCode::NoWritableColumns);

    request.options.sql.skip_computed_columns = false;
    let included = extract_data_grid_selection(request).expect("explicit computed UPDATE extraction");
    assert!(included.text.contains("SET \"search_text\" ="));
}

#[test]
fn rejects_null_primary_keys_fail_fast() {
    let mut request = request(DataGridExtractorId::SqlUpdates);
    request.rows[0][0] = Value::Null;
    request.selected_column_indexes = vec![1];
    request.table_meta = Some(DataGridTableMeta {
        catalog: None,
        database: None,
        schema: None,
        table_name: "users".to_string(),
        primary_keys: vec!["id".to_string()],
        columns: None,
    });
    let error = extract_data_grid_selection(request).expect_err("NULL primary key must fail");
    assert_eq!(error.code, DataGridExtractErrorCode::NullPrimaryKey);
}

#[test]
fn extracts_custom_dsv_with_headers_nulls_and_standard_escaping() {
    let mut request = request(DataGridExtractorId::Dsv);
    request.rows[0][0] = Value::Null;
    request.rows[0][1] = json!("Ada;Lovelace");
    request.options.dsv = DataGridDsvOptions {
        column_separator: ";".to_string(),
        include_column_header: true,
        ..DataGridDsvOptions::default()
    };
    let result = extract_data_grid_selection(request).expect("custom DSV extraction");
    assert_eq!(result.text, "id;name\nNULL;\"Ada;Lovelace\"\n2;Grace, Hopper");
}

#[test]
fn custom_dsv_honors_row_headers_and_quote_policy() {
    let mut request = request(DataGridExtractorId::Dsv);
    request.options.dsv = DataGridDsvOptions {
        column_separator: ";".to_string(),
        include_row_header: true,
        quote_policy: DataGridQuotePolicy::Always,
        ..DataGridDsvOptions::default()
    };

    let result = extract_data_grid_selection(request).expect("configured DSV extraction");

    assert_eq!(result.text, "\"1\";\"1\";\"Ada\"\n\"2\";\"2\";\"Grace, Hopper\"");
}

#[test]
fn extracts_json_lines_as_one_object_per_record() {
    let result = extract_data_grid_selection(request(DataGridExtractorId::JsonLines)).expect("JSON Lines extraction");
    assert_eq!(result.text.lines().count(), 2);
    let first_row =
        serde_json::from_str::<Value>(result.text.lines().next().unwrap_or_default()).expect("first JSON Lines record");
    assert_eq!(first_row, json!({"id": 1, "name": "Ada"}));
}

#[test]
fn extracts_compact_json_when_pretty_printing_is_disabled() {
    let mut request = request(DataGridExtractorId::Json);
    request.options.json.pretty = false;

    let result = extract_data_grid_selection(request).expect("compact JSON extraction");

    assert_eq!(result.text, "[{\"id\":1,\"name\":\"Ada\"},{\"id\":2,\"name\":\"Grace, Hopper\"}]");
}

#[test]
fn builds_null_safe_where_clause_predicates() {
    let mut request = request(DataGridExtractorId::WhereClause);
    request.selected_column_indexes = vec![1];
    request.rows = vec![vec![json!(1), Value::Null]];
    let result = extract_data_grid_selection(request).expect("WHERE extraction");
    assert_eq!(result.text, "\"name\" IS NULL");
}

#[test]
fn where_clause_applies_mysql_json_cast() {
    // WHERE must reuse the UPDATE predicate builder so MySQL JSON columns get
    // CAST(... AS JSON) instead of a raw string literal.
    let mut request = request(DataGridExtractorId::WhereClause);
    request.database_type = Some(DatabaseType::Mysql);
    request.selected_column_indexes = vec![1];
    request.rows = vec![vec![json!(1), json!("{\"k\":1}")]];
    request.table_meta = Some(DataGridTableMeta {
        catalog: None,
        database: None,
        schema: None,
        table_name: "t".to_string(),
        primary_keys: vec!["id".to_string()],
        columns: Some(vec![
            DataGridColumnInfo {
                name: "id".to_string(),
                data_type: "int".to_string(),
                is_nullable: false,
                is_primary_key: true,
                column_default: None,
                extra: None,
            },
            DataGridColumnInfo {
                name: "name".to_string(),
                data_type: "json".to_string(),
                is_nullable: true,
                is_primary_key: false,
                column_default: None,
                extra: None,
            },
        ]),
    });
    let result = extract_data_grid_selection(request).expect("WHERE extraction");
    assert!(
        result.text.contains("CAST(") && result.text.contains(" AS JSON)"),
        "expected MySQL JSON CAST predicate, got: {}",
        result.text
    );
}

#[test]
fn where_clause_rejects_unsupported_nosql_databases() {
    for database_type in [DatabaseType::MongoDb, DatabaseType::Neo4j, DatabaseType::Tdengine] {
        let mut request = request(DataGridExtractorId::WhereClause);
        request.database_type = Some(database_type);
        let error = extract_data_grid_selection(request).expect_err("WHERE must reject NoSQL");
        assert_eq!(error.code, DataGridExtractErrorCode::UnsupportedDatabase, "{database_type:?}");
    }
}

#[test]
fn build_data_grid_copy_update_statements_returns_empty_for_mongodb() {
    use crate::data_grid_sql::{build_data_grid_copy_update_statements, DataGridCopyUpdateStatementOptions};
    let options = DataGridCopyUpdateStatementOptions {
        database_type: Some(DatabaseType::MongoDb),
        table_meta: DataGridTableMeta {
            catalog: None,
            database: None,
            schema: None,
            table_name: "t".to_string(),
            primary_keys: vec!["id".to_string()],
            columns: None,
        },
        columns: vec!["id".to_string()],
        source_columns: Some(vec![Some("id".to_string())]),
        rows: vec![vec![json!(1)]],
    };
    assert!(build_data_grid_copy_update_statements(options).is_empty());
}

#[test]
fn format_grid_sql_literal_uses_numeric_bool_for_sqlserver() {
    use crate::data_grid_sql::format_grid_sql_literal;
    let column = DataGridColumnInfo {
        name: "active".to_string(),
        data_type: "tinyint".to_string(),
        is_nullable: true,
        is_primary_key: false,
        column_default: None,
        extra: None,
    };
    // SQL Server has no TRUE/FALSE literals; emit 1/0 even for non-BIT columns.
    assert_eq!(format_grid_sql_literal(&json!(true), Some(DatabaseType::SqlServer), Some(&column)), "1");
    assert_eq!(format_grid_sql_literal(&json!(false), Some(DatabaseType::SqlServer), Some(&column)), "0");
    // Other dialects still emit TRUE/FALSE for non-bit columns.
    assert_eq!(format_grid_sql_literal(&json!(true), Some(DatabaseType::Postgres), Some(&column)), "TRUE");
}

#[test]
fn escapes_html_and_preserves_xml_null_semantics() {
    let mut html_request = request(DataGridExtractorId::Html);
    html_request.rows = vec![vec![json!(1), json!("<Ada & Grace>")]];
    let html = extract_data_grid_selection(html_request).expect("HTML extraction");
    assert!(html.text.contains("&lt;Ada &amp; Grace&gt;"));

    let mut xml_request = request(DataGridExtractorId::Xml);
    xml_request.rows = vec![vec![json!(1), Value::Null]];
    let xml = extract_data_grid_selection(xml_request).expect("XML extraction");
    assert!(xml.text.contains("name=\"name\" null=\"true\""));
}

#[test]
fn sql_insert_skips_generated_and_computed_columns() {
    let mut request = request(DataGridExtractorId::SqlInserts);
    request.columns.push(column("search_text", 2));
    request.selected_column_indexes = vec![0, 1, 2];
    request.rows = vec![vec![json!(7), json!("Ada"), json!("generated")]];
    request.table_meta = Some(DataGridTableMeta {
        catalog: None,
        database: None,
        schema: None,
        table_name: "users".to_string(),
        primary_keys: vec!["id".to_string()],
        columns: Some(vec![
            DataGridColumnInfo {
                name: "id".to_string(),
                data_type: "int".to_string(),
                is_nullable: false,
                is_primary_key: true,
                column_default: None,
                extra: Some("auto_increment".to_string()),
            },
            DataGridColumnInfo {
                name: "name".to_string(),
                data_type: "varchar".to_string(),
                is_nullable: false,
                is_primary_key: false,
                column_default: None,
                extra: None,
            },
            DataGridColumnInfo {
                name: "search_text".to_string(),
                data_type: "text".to_string(),
                is_nullable: true,
                is_primary_key: false,
                column_default: None,
                extra: Some("GENERATED ALWAYS AS".to_string()),
            },
        ]),
    });
    let mut include_computed_request = request.clone();
    include_computed_request.options.sql.skip_computed_columns = false;
    let mut include_generated_request = request.clone();
    include_generated_request.options.sql.skip_generated_columns = false;

    let result = extract_data_grid_selection(request).expect("SQL INSERT extraction");
    assert!(result.text.contains("name"));
    assert!(!result.text.contains("search_text"));
    assert!(!result.text.contains("(id,"));
    assert_eq!(result.omitted_columns, vec!["id", "search_text"]);

    let included =
        extract_data_grid_selection(include_computed_request).expect("SQL INSERT extraction with computed columns");
    assert!(included.text.contains("search_text"));
    assert_eq!(included.omitted_columns, vec!["id"]);

    let included =
        extract_data_grid_selection(include_generated_request).expect("SQL INSERT extraction with generated columns");
    assert!(included.text.contains("(\"id\", \"name\")"));
    assert_eq!(included.omitted_columns, vec!["search_text"]);
}

#[test]
fn sql_insert_honors_primary_key_exclusion_and_row_by_row_mode() {
    let mut request = request(DataGridExtractorId::SqlInserts);
    request.table_meta = Some(DataGridTableMeta {
        catalog: None,
        database: None,
        schema: Some("public".to_string()),
        table_name: "users".to_string(),
        primary_keys: vec!["id".to_string()],
        columns: None,
    });
    request.options.sql.exclude_primary_keys_from_insert = true;
    request.options.sql.insert_mode = crate::data_grid_sql::DataGridCopyInsertMode::RowByRow;

    let result = extract_data_grid_selection(request).expect("row-by-row SQL INSERT extraction");

    assert_eq!(
        result.text,
        "INSERT INTO \"public\".\"users\" (\"name\") VALUES ('Ada');\nINSERT INTO \"public\".\"users\" (\"name\") VALUES ('Grace, Hopper');"
    );
    assert_eq!(result.omitted_columns, vec!["id"]);
}

#[test]
fn rejects_invalid_dsv_configuration() {
    let mut request = request(DataGridExtractorId::Dsv);
    request.options.dsv.column_separator.clear();
    let error = extract_data_grid_selection(request).expect_err("empty separator must fail");
    assert_eq!(error.code, DataGridExtractErrorCode::InvalidDsvConfiguration);
}

#[test]
fn rejects_ambiguous_or_oversized_dsv_configuration() {
    let mut overlapping = request(DataGridExtractorId::Dsv);
    overlapping.options.dsv.column_separator = "|".to_string();
    overlapping.options.dsv.row_separator = "||".to_string();
    assert_eq!(
        extract_data_grid_selection(overlapping).expect_err("overlapping separators must fail").code,
        DataGridExtractErrorCode::InvalidDsvConfiguration
    );

    let mut conflicting_quote = request(DataGridExtractorId::Csv);
    conflicting_quote.options.dsv.quote = ',';
    assert_eq!(
        extract_data_grid_selection(conflicting_quote).expect_err("separator quote must fail").code,
        DataGridExtractErrorCode::InvalidDsvConfiguration
    );

    let mut oversized = request(DataGridExtractorId::Dsv);
    oversized.options.dsv.column_separator = "123456789".to_string();
    assert_eq!(
        extract_data_grid_selection(oversized).expect_err("oversized separator must fail").code,
        DataGridExtractErrorCode::InvalidDsvConfiguration
    );
}

#[test]
fn extractor_contract_uses_the_frontend_camel_case_wire_shape() {
    let request = request(DataGridExtractorId::CsvWithHeaders);
    let value = serde_json::to_value(&request).expect("serialize extractor request");

    assert_eq!(value["extractor"], "csv-with-headers");
    assert_eq!(value["databaseType"], "postgres");
    assert_eq!(value["selectedColumnIndexes"], json!([0, 1]));
    assert_eq!(value["selectionKind"], "cells");
    assert_eq!(value["options"]["dsv"]["includeColumnHeader"], false);
    assert!(value.get("selected_column_indexes").is_none());

    let decoded = serde_json::from_value::<DataGridExtractRequest>(value).expect("deserialize extractor request");
    assert_eq!(decoded.extractor, DataGridExtractorId::CsvWithHeaders);
    assert_eq!(decoded.selected_column_indexes, vec![0, 1]);
}

#[test]
fn extractor_contract_requires_an_explicit_version() {
    let mut value = serde_json::to_value(request(DataGridExtractorId::Csv)).expect("serialize extractor request");
    value.as_object_mut().expect("request object").remove("version");

    let error = serde_json::from_value::<DataGridExtractRequest>(value).expect_err("missing version must fail");

    assert!(error.to_string().contains("version"));
}

#[test]
fn extractor_contract_rejects_unknown_or_misspelled_fields() {
    let mut value = serde_json::to_value(request(DataGridExtractorId::Csv)).expect("serialize extractor request");
    value["options"]["sql"]["skipComputedColumn"] = json!(false);

    let error = serde_json::from_value::<DataGridExtractRequest>(value).expect_err("unknown option must fail");

    assert!(error.to_string().contains("skipComputedColumn"));
}

#[test]
fn rejects_invalid_contract_and_column_mappings_fail_fast() {
    let mut unsupported = request(DataGridExtractorId::Csv);
    unsupported.version = 2;
    assert_eq!(
        extract_data_grid_selection(unsupported).expect_err("unsupported contract version").code,
        DataGridExtractErrorCode::UnsupportedVersion
    );

    let mut invalid_column = request(DataGridExtractorId::Csv);
    invalid_column.selected_column_indexes = vec![99];
    assert_eq!(
        extract_data_grid_selection(invalid_column).expect_err("invalid selected column").code,
        DataGridExtractErrorCode::InvalidColumnIndex
    );

    let mut duplicate_column = request(DataGridExtractorId::Csv);
    duplicate_column.selected_column_indexes = vec![0, 0];
    assert_eq!(
        extract_data_grid_selection(duplicate_column).expect_err("duplicate selected column").code,
        DataGridExtractErrorCode::InvalidColumnIndex
    );

    let mut invalid_mapping = request(DataGridExtractorId::Csv);
    invalid_mapping.columns[0].source_index = 99;
    assert_eq!(
        extract_data_grid_selection(invalid_mapping).expect_err("invalid source mapping").code,
        DataGridExtractErrorCode::InvalidColumnMapping
    );
}

#[test]
fn sql_updates_require_table_primary_key_and_writable_columns() {
    let missing_table = request(DataGridExtractorId::SqlUpdates);
    assert_eq!(
        extract_data_grid_selection(missing_table).expect_err("missing table metadata").code,
        DataGridExtractErrorCode::MissingTableMetadata
    );

    let mut missing_primary_key = request(DataGridExtractorId::SqlUpdates);
    missing_primary_key.table_meta = Some(DataGridTableMeta {
        catalog: None,
        database: None,
        schema: None,
        table_name: "users".to_string(),
        primary_keys: Vec::new(),
        columns: None,
    });
    assert_eq!(
        extract_data_grid_selection(missing_primary_key).expect_err("missing primary key").code,
        DataGridExtractErrorCode::MissingPrimaryKey
    );

    let mut primary_key_only = request(DataGridExtractorId::SqlUpdates);
    primary_key_only.selected_column_indexes = vec![0];
    primary_key_only.table_meta = Some(DataGridTableMeta {
        catalog: None,
        database: None,
        schema: None,
        table_name: "users".to_string(),
        primary_keys: vec!["id".to_string()],
        columns: None,
    });
    assert_eq!(
        extract_data_grid_selection(primary_key_only).expect_err("primary-key-only update").code,
        DataGridExtractErrorCode::NoWritableColumns
    );
}

#[test]
fn rejects_requests_that_exceed_the_column_budget() {
    let mut request = request(DataGridExtractorId::Csv);
    request.columns =
        (0..=DATA_GRID_EXTRACTOR_MAX_COLUMNS).map(|index| column(&format!("column_{index}"), index)).collect();

    let error = extract_data_grid_selection(request).expect_err("oversized column list must fail");

    assert_eq!(error.code, DataGridExtractErrorCode::InputTooLarge);
}

#[test]
fn rejects_requests_that_exceed_the_selected_index_budget() {
    // columns list is small, but selected_column_indexes is oversized —
    // the budget must catch it before Vec::with_capacity allocates.
    let mut request = request(DataGridExtractorId::Csv);
    request.selected_column_indexes = (0..=DATA_GRID_EXTRACTOR_MAX_COLUMNS).collect();

    let error = extract_data_grid_selection(request).expect_err("oversized index list must fail");

    assert_eq!(error.code, DataGridExtractErrorCode::InputTooLarge);
}

#[test]
fn bounded_output_stops_before_allocating_past_the_limit() {
    let mut output = BoundedOutput::new(4);
    assert_eq!(output.write(b"1234").expect("bounded write"), 4);
    assert!(output.write(b"5").is_err());
    assert!(output.exceeded_limit());
    assert_eq!(output.into_bytes(), b"1234");
}

#[test]
fn rejects_requests_that_exceed_the_row_budget_before_mapping_values() {
    let mut request = request(DataGridExtractorId::Csv);
    request.rows = vec![Vec::new(); DATA_GRID_EXTRACTOR_MAX_ROWS + 1];

    let error = extract_data_grid_selection(request).expect_err("oversized request must fail");

    assert_eq!(error.code, DataGridExtractErrorCode::InputTooLarge);
}

#[test]
fn rejects_estimated_oversized_sql_before_building_the_statement() {
    let mut request = request(DataGridExtractorId::SqlInserts);
    request.columns = vec![column("payload", 0)];
    request.selected_column_indexes = vec![0];
    request.rows = vec![vec![json!("x".repeat(DATA_GRID_EXTRACTOR_MAX_OUTPUT_BYTES / 6 + 1))]];

    let error = extract_data_grid_selection(request).expect_err("oversized SQL must fail before allocation");

    assert_eq!(error.code, DataGridExtractErrorCode::OutputTooLarge);
}
