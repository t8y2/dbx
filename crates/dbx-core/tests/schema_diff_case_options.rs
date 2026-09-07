use dbx_core::models::connection::DatabaseType;
use dbx_core::schema_diff::TableSchemaDetail;
use dbx_core::schema_diff::{prepare_schema_diff, SchemaDiffPreparationOptions, SchemaDiffTableMapping};
use dbx_core::types::{ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo};

fn table(name: &str) -> TableInfo {
    TableInfo {
        name: name.to_string(),
        table_type: "BASE TABLE".to_string(),
        comment: None,
        parent_schema: None,
        parent_name: None,
    }
}

fn column(name: &str, data_type: &str) -> ColumnInfo {
    ColumnInfo { name: name.to_string(), data_type: data_type.to_string(), ..Default::default() }
}

fn index(name: &str, columns: &[&str]) -> IndexInfo {
    IndexInfo {
        name: name.to_string(),
        columns: columns.iter().map(|column| (*column).to_string()).collect(),
        is_unique: false,
        is_primary: false,
        filter: None,
        index_type: None,
        included_columns: None,
        comment: None,
        key_is_expression: Vec::new(),
        column_opclasses: Vec::new(),
        constraint_backed: false,
    }
}

fn foreign_key(name: &str, column: &str, ref_table: &str, ref_column: &str) -> ForeignKeyInfo {
    ForeignKeyInfo {
        name: name.to_string(),
        column: column.to_string(),
        ref_schema: None,
        ref_table: ref_table.to_string(),
        ref_column: ref_column.to_string(),
        on_update: None,
        on_delete: None,
    }
}

fn detail(
    name: &str,
    columns: Vec<ColumnInfo>,
    indexes: Vec<IndexInfo>,
    foreign_keys: Vec<ForeignKeyInfo>,
) -> TableSchemaDetail {
    TableSchemaDetail { name: name.to_string(), columns, indexes, foreign_keys, triggers: Vec::new(), ddl: None }
}

fn options(
    source_tables: Vec<TableInfo>,
    target_tables: Vec<TableInfo>,
    source_details: Vec<TableSchemaDetail>,
    target_details: Vec<TableSchemaDetail>,
) -> SchemaDiffPreparationOptions {
    SchemaDiffPreparationOptions {
        source_tables,
        target_tables,
        source_details,
        target_details,
        database_type: DatabaseType::Postgres,
        ..Default::default()
    }
}

#[test]
fn keeps_case_sensitive_matching_by_default() {
    let result = prepare_schema_diff(options(
        vec![table("USER")],
        vec![table("user")],
        vec![detail("USER", vec![column("ID", "int")], Vec::new(), Vec::new())],
        vec![detail("user", vec![column("id", "int")], Vec::new(), Vec::new())],
    ));

    assert_eq!(result.diffs.len(), 2);
    assert!(result.diffs.iter().any(|diff| diff.diff_type == "added" && diff.name == "USER"));
    assert!(result.diffs.iter().any(|diff| diff.diff_type == "removed" && diff.name == "user"));
}

#[test]
fn matches_table_column_index_and_foreign_key_references_case_insensitively() {
    let mut options = options(
        vec![table("USER_INFO"), table("USER_ACCESS")],
        vec![table("user_info"), table("user_access")],
        vec![
            detail("USER_INFO", vec![column("ID", "int")], Vec::new(), Vec::new()),
            detail(
                "USER_ACCESS",
                vec![column("USER_ID", "int")],
                vec![index("idx_user_id", &["USER_ID"])],
                vec![foreign_key("fk_user_info", "USER_ID", "USER_INFO", "ID")],
            ),
        ],
        vec![
            detail("user_info", vec![column("id", "int")], Vec::new(), Vec::new()),
            detail(
                "user_access",
                vec![column("user_id", "int")],
                vec![index("idx_user_id", &["user_id"])],
                vec![foreign_key("fk_user_info", "user_id", "user_info", "id")],
            ),
        ],
    );
    options.ignore_table_name_case = true;
    options.ignore_column_name_case = true;

    let result = prepare_schema_diff(options);

    assert!(
        result.diffs.is_empty(),
        "case-only table, column, index, and foreign-key references should not diff: {result:?}"
    );
}

#[test]
fn keeps_table_and_column_case_options_independent() {
    let base = || {
        options(
            vec![table("USER")],
            vec![table("user")],
            vec![detail("USER", vec![column("ID", "int")], Vec::new(), Vec::new())],
            vec![detail("user", vec![column("id", "int")], Vec::new(), Vec::new())],
        )
    };

    let mut table_only = base();
    table_only.ignore_table_name_case = true;
    let table_only_result = prepare_schema_diff(table_only);
    assert_eq!(table_only_result.diffs.len(), 1);
    assert_eq!(table_only_result.diffs[0].diff_type, "modified");
    assert_eq!(table_only_result.diffs[0].columns.as_ref().unwrap().len(), 2);

    let mut column_only = base();
    column_only.ignore_column_name_case = true;
    let column_only_result = prepare_schema_diff(column_only);
    assert_eq!(column_only_result.diffs.len(), 2);
    assert!(column_only_result.diffs.iter().all(|diff| diff.diff_type == "added" || diff.diff_type == "removed"));
}

#[test]
fn ignores_case_when_comparing_column_order() {
    let mut options = options(
        vec![table("orders")],
        vec![table("orders")],
        vec![detail("orders", vec![column("ID", "int"), column("NAME", "text")], Vec::new(), Vec::new())],
        vec![detail("orders", vec![column("id", "int"), column("name", "text")], Vec::new(), Vec::new())],
    );
    options.ignore_column_name_case = true;
    options.compare_column_order = true;

    assert!(prepare_schema_diff(options).diffs.is_empty());
}

#[test]
fn explicit_table_mappings_take_precedence_over_case_insensitive_matching() {
    let mut options = options(
        vec![table("source_a")],
        vec![table("SOURCE_A"), table("target_b")],
        vec![detail("source_a", vec![column("id", "int")], Vec::new(), Vec::new())],
        vec![
            detail("SOURCE_A", vec![column("id", "int")], Vec::new(), Vec::new()),
            detail("target_b", vec![column("id", "int")], Vec::new(), Vec::new()),
        ],
    );
    options.ignore_table_name_case = true;
    options.table_mappings =
        vec![SchemaDiffTableMapping { source_table: "source_a".to_string(), target_table: "target_b".to_string() }];

    let result = prepare_schema_diff(options);

    assert_eq!(result.diffs.len(), 1);
    assert_eq!(result.diffs[0].diff_type, "removed");
    assert_eq!(result.diffs[0].name, "SOURCE_A");
}

#[test]
fn exact_table_matches_take_precedence_over_case_insensitive_candidates() {
    let mut options = options(
        vec![table("foo"), table("FOO")],
        vec![table("FOO")],
        vec![detail("foo", Vec::new(), Vec::new(), Vec::new()), detail("FOO", Vec::new(), Vec::new(), Vec::new())],
        vec![detail("FOO", Vec::new(), Vec::new(), Vec::new())],
    );
    options.ignore_table_name_case = true;

    let result = prepare_schema_diff(options);

    assert_eq!(result.diffs.len(), 1);
    assert_eq!(result.diffs[0].diff_type, "added");
    assert_eq!(result.diffs[0].name, "foo");
}

#[test]
fn does_not_match_ambiguous_case_insensitive_table_candidates() {
    let mut options = options(
        vec![table("uSeR")],
        vec![table("User"), table("USER")],
        vec![detail("uSeR", Vec::new(), Vec::new(), Vec::new())],
        vec![detail("User", Vec::new(), Vec::new(), Vec::new()), detail("USER", Vec::new(), Vec::new(), Vec::new())],
    );
    options.ignore_table_name_case = true;

    let result = prepare_schema_diff(options);

    assert_eq!(result.diffs.len(), 3);
    assert!(result.diffs.iter().any(|diff| diff.diff_type == "added" && diff.name == "uSeR"));
    assert_eq!(result.diffs.iter().filter(|diff| diff.diff_type == "removed").count(), 2);
}

#[test]
fn case_only_matches_do_not_trigger_table_or_column_rename_detection() {
    let mut options = options(
        vec![table("User")],
        vec![table("user")],
        vec![detail("User", vec![column("ID", "int")], Vec::new(), Vec::new())],
        vec![detail("user", vec![column("id", "int")], Vec::new(), Vec::new())],
    );
    options.ignore_table_name_case = true;
    options.ignore_column_name_case = true;
    options.detect_renames = true;
    options.detect_table_renames = true;

    let result = prepare_schema_diff(options);

    assert!(result.diffs.is_empty());
    assert!(result.rename_candidates.is_empty());
}

#[test]
fn preserves_original_identifiers_in_case_insensitive_matches() {
    let mut options = options(
        vec![table("USER_INFO")],
        vec![table("user_info")],
        vec![detail("USER_INFO", vec![column("ID", "bigint")], Vec::new(), Vec::new())],
        vec![detail("user_info", vec![column("id", "int")], Vec::new(), Vec::new())],
    );
    options.ignore_table_name_case = true;
    options.ignore_column_name_case = true;

    let result = prepare_schema_diff(options);
    let table_diff = &result.diffs[0];
    let column_diff = &table_diff.columns.as_ref().unwrap()[0];

    assert_eq!(table_diff.name, "USER_INFO");
    assert_eq!(table_diff.target_name.as_deref(), Some("user_info"));
    assert_eq!(column_diff.name, "ID");
    assert_eq!(column_diff.source.as_ref().unwrap().name, "ID");
    assert_eq!(column_diff.target.as_ref().unwrap().name, "id");
    assert!(result.sync_sql.contains("ALTER COLUMN \"id\" TYPE bigint"));
    assert!(!result.sync_sql.contains("ALTER COLUMN \"ID\" TYPE bigint"));
}
