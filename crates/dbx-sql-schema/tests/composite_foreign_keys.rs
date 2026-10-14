use dbx_sql_schema::models::connection::DatabaseType;
use dbx_sql_schema::schema_diff::{
    diff_foreign_keys, generate_schema_sync_sql, prepare_schema_diff, SchemaDiffPreparation,
    SchemaDiffPreparationOptions, TableDiff, TableSchemaDetail,
};
use dbx_sql_schema::types::{ColumnInfo, ForeignKeyInfo, TableInfo};

fn fk(name: &str, column: &str, ref_column: &str) -> ForeignKeyInfo {
    ForeignKeyInfo {
        name: name.into(),
        column: column.into(),
        ref_schema: Some("external".into()),
        ref_table: "parent".into(),
        ref_column: ref_column.into(),
        on_delete: Some("RESTRICT".into()),
        on_update: Some("CASCADE".into()),
    }
}

fn composite() -> Vec<ForeignKeyInfo> {
    // Deliberately not alphabetical; ordering must preserve these column pairs.
    vec![fk("child_parent", "tenant", "scope"), fk("child_parent", "item", "code")]
}

fn options(source: Vec<ForeignKeyInfo>, target: Vec<ForeignKeyInfo>) -> SchemaDiffPreparationOptions {
    let table = TableInfo {
        name: "child".into(),
        table_type: "BASE TABLE".into(),
        valid: None,
        comment: None,
        parent_schema: None,
        parent_name: None,
    };
    let detail = |foreign_keys| TableSchemaDetail {
        name: "child".into(),
        columns: ["tenant", "item"]
            .into_iter()
            .map(|name| ColumnInfo { name: name.into(), data_type: "int".into(), ..Default::default() })
            .collect(),
        indexes: vec![],
        foreign_keys,
        triggers: vec![],
        ddl: None,
    };
    SchemaDiffPreparationOptions {
        source_tables: vec![table.clone()],
        target_tables: vec![table],
        source_details: vec![detail(source)],
        target_details: vec![detail(target)],
        database_type: DatabaseType::Mysql,
        target_schema: Some("destination".into()),
        enable_rollback: true,
        ..Default::default()
    }
}

fn prepare(source: Vec<ForeignKeyInfo>, target: Vec<ForeignKeyInfo>) -> SchemaDiffPreparation {
    prepare_schema_diff(options(source, target))
}

#[test]
fn composite_self_compare_has_no_diff_or_sync_sql() {
    let rows = composite();
    assert!(diff_foreign_keys(&rows, &rows).is_empty());
    let result = prepare(rows.clone(), rows);
    assert!(result.diffs.is_empty(), "{:?}", result.diffs);
    assert!(result.sync_sql.trim().is_empty(), "{}", result.sync_sql);
}

#[test]
fn independent_constraint_order_does_not_change_comparison() {
    let mut source = composite();
    source.insert(1, fk("single", "owner", "id"));
    let mut target = composite();
    target.push(fk("single", "owner", "id"));
    assert!(diff_foreign_keys(&source, &target).is_empty());
}

#[test]
fn unnamed_foreign_keys_keep_each_reference_and_detect_changes() {
    let source =
        vec![fk("", "tenant", "scope"), ForeignKeyInfo { ref_table: "projects".into(), ..fk("", "item", "code") }];
    for field in ["column", "ref_column", "ref_table", "ref_schema", "on_delete", "on_update"] {
        let mut target = source.clone();
        let row = &mut target[1];
        match field {
            "column" => row.column = "old_item".into(),
            "ref_column" => row.ref_column = "old_code".into(),
            "ref_table" => row.ref_table = "archived_projects".into(),
            "ref_schema" => row.ref_schema = Some("archive".into()),
            "on_delete" => row.on_delete = Some("CASCADE".into()),
            "on_update" => row.on_update = Some("RESTRICT".into()),
            _ => unreachable!(),
        }
        let result = prepare(source.clone(), target.clone());
        let changes = result.diffs[0].foreign_keys.as_ref().unwrap();
        // Without a constraint identity, preserve the unmatched records rather than
        // guessing that rows describe the same constraint or a compound key.
        assert_eq!(changes.len(), 2, "{field}: {changes:?}");
        assert_eq!(changes[0].diff_type, "added");
        assert_eq!(changes[0].source.as_ref().unwrap().column, source[1].column);
        assert_eq!(changes[0].source.as_ref().unwrap().ref_table, source[1].ref_table);
        assert_eq!(changes[1].diff_type, "removed");
        assert_eq!(changes[1].target.as_ref().unwrap().column, target[1].column);
        assert_eq!(changes[1].target.as_ref().unwrap().ref_table, target[1].ref_table);
    }
}

#[test]
fn unnamed_foreign_keys_compare_as_unordered_rows_alongside_named_composites() {
    let mut source = composite();
    source.push(fk("", "owner", "id"));
    source.push(ForeignKeyInfo { ref_table: "projects".into(), ..fk("", "project", "id") });
    let mut target = source[..2].to_vec();
    target.extend(source[2..].iter().rev().cloned());
    let result = prepare(source, target);
    assert!(result.diffs.is_empty(), "{:?}", result.diffs);
    assert!(result.sync_sql.is_empty());
}

#[test]
fn unnamed_foreign_key_matching_preserves_multiplicity() {
    let row = fk("", "owner", "id");
    let double = vec![row.clone(), row.clone()];
    assert!(diff_foreign_keys(&double, &double).is_empty());
    let added = diff_foreign_keys(&double, std::slice::from_ref(&row));
    assert_eq!(added.len(), 1);
    assert_eq!(added[0].diff_type, "added");
    let removed = diff_foreign_keys(std::slice::from_ref(&row), &double);
    assert_eq!(removed.len(), 1);
    assert_eq!(removed[0].diff_type, "removed");
}

#[test]
fn unnamed_foreign_keys_on_the_same_column_do_not_hide_different_parents() {
    let source =
        vec![fk("", "owner", "id"), ForeignKeyInfo { ref_table: "other_parent".into(), ..fk("", "owner", "id") }];
    let added = diff_foreign_keys(&source, &[]);
    assert_eq!(added.len(), 2);
    assert_eq!(added[0].source.as_ref().unwrap().ref_table, "parent");
    assert_eq!(added[1].source.as_ref().unwrap().ref_table, "other_parent");
    assert!(added.iter().all(|diff| diff.source.as_ref().unwrap().column == "owner"));
    let mut target = source.clone();
    target[1].ref_table = "third_parent".into();
    assert_eq!(diff_foreign_keys(&source, &target).len(), 2);
}

#[test]
fn unnamed_foreign_keys_respect_existing_case_and_action_options() {
    let source = vec![fk("", "Owner", "Id")];
    let mut target = source.clone();
    target[0].column = "owner".into();
    target[0].ref_column = "id".into();
    target[0].ref_table = "PARENT".into();
    target[0].on_delete = Some(" restrict ".into());
    let mut input = options(source, target);
    assert!(!prepare_schema_diff(input.clone()).diffs.is_empty());
    input.ignore_table_name_case = true;
    input.ignore_column_name_case = true;
    assert!(prepare_schema_diff(input).diffs.is_empty());
}

#[test]
fn added_composite_emits_one_complete_constraint() {
    let result = prepare(composite(), vec![]);
    assert_eq!(result.diffs[0].foreign_keys.as_ref().unwrap().len(), 1);
    assert_eq!(result.sync_sql.matches("ADD CONSTRAINT").count(), 1, "{}", result.sync_sql);
    assert!(
        result.sync_sql.contains("FOREIGN KEY (`tenant`, `item`) REFERENCES `external`.`parent` (`scope`, `code`)"),
        "{}",
        result.sync_sql
    );
}

#[test]
fn removed_composite_emits_one_drop_and_complete_rollback() {
    let result = prepare(vec![], composite());
    assert_eq!(result.diffs[0].foreign_keys.as_ref().unwrap().len(), 1);
    assert_eq!(result.sync_sql.matches("DROP FOREIGN KEY").count(), 1);
    let rollback = result.rollback_sync_sql.as_deref().unwrap();
    assert!(rollback.contains("FOREIGN KEY (`tenant`, `item`)"), "{rollback}");
    assert!(rollback.contains("(`scope`, `code`)"), "{rollback}");
}

#[test]
fn changed_pair_emits_complete_source_and_target_constraints() {
    let mut target = composite();
    target[1].ref_column = "old_code".into();
    let result = prepare(composite(), target);
    let fks = result.diffs[0].foreign_keys.as_ref().unwrap();
    assert_eq!(fks.len(), 1);
    assert_eq!(fks[0].diff_type, "modified");
    assert_eq!(result.sync_sql.matches("DROP FOREIGN KEY").count(), 1);
    assert_eq!(result.sync_sql.matches("ADD CONSTRAINT").count(), 1);
    assert!(result.sync_sql.contains("(`scope`, `code`)"), "{}", result.sync_sql);
    assert!(result.rollback_sync_sql.as_deref().unwrap().contains("(`scope`, `old_code`)"));
}

#[test]
fn swapped_references_cannot_be_hidden_by_sorting_columns_separately() {
    let mut target = composite();
    target[0].ref_column = "code".into();
    target[1].ref_column = "scope".into();
    let diffs = diff_foreign_keys(&composite(), &target);
    assert_eq!(diffs.len(), 1);
    assert!(diffs[0].changes.iter().any(|change| change.starts_with("ref column:")));
}

#[test]
fn local_reference_table_schema_and_action_changes_are_detected() {
    for field in ["column", "ref_column", "ref_table", "ref_schema", "on_delete", "on_update", "name"] {
        let mut target = composite();
        for row in &mut target {
            match field {
                "column" => row.column.push_str("_old"),
                "ref_column" => row.ref_column.push_str("_old"),
                "ref_table" => row.ref_table = "other_parent".into(),
                "ref_schema" => row.ref_schema = Some("other_schema".into()),
                "on_delete" => row.on_delete = Some("CASCADE".into()),
                "on_update" => row.on_update = Some("RESTRICT".into()),
                "name" => row.name = "renamed_constraint".into(),
                _ => unreachable!(),
            }
        }
        assert!(!diff_foreign_keys(&composite(), &target).is_empty(), "missed {field}");
        assert!(prepare(composite(), target).sync_sql.contains("FOREIGN KEY"), "missed {field}");
    }
}

#[test]
fn same_constraint_names_in_different_tables_stay_separate() {
    let mut input = options(composite(), composite());
    let mut table = input.source_tables[0].clone();
    table.name = "another_child".into();
    input.source_tables.push(table.clone());
    input.target_tables.push(table);
    let mut detail = input.source_details[0].clone();
    detail.name = "another_child".into();
    detail.foreign_keys = vec![fk("child_parent", "tenant", "scope")];
    input.source_details.push(detail.clone());
    input.target_details.push(detail);
    assert!(prepare_schema_diff(input).diffs.is_empty());
}

#[test]
fn empty_and_single_column_constraints_keep_existing_behavior() {
    assert!(diff_foreign_keys(&[], &[]).is_empty());
    let rows = vec![fk("single", "owner", "id")];
    assert!(diff_foreign_keys(&rows, &rows).is_empty());
    let result = prepare(rows, vec![]);
    assert_eq!(result.sync_sql.matches("ADD CONSTRAINT").count(), 1);
    assert!(result.sync_sql.contains("FOREIGN KEY (`owner`) REFERENCES `external`.`parent` (`id`)"));
}

#[test]
fn identifiers_with_commas_quotes_and_case_are_preserved() {
    let rows = vec![fk("punctuation", "Tenant,Name", "Scope,Name"), fk("punctuation", "item`id", "code`id")];
    let sql = prepare(rows.clone(), vec![]).sync_sql;
    assert!(sql.contains("FOREIGN KEY (`Tenant,Name`, `item``id`)"), "{sql}");
    assert!(sql.contains("(`Scope,Name`, `code``id`)"), "{sql}");
    let mut target = rows.clone();
    target[0].column = "tenant,name".into();
    assert!(!diff_foreign_keys(&rows, &target).is_empty());
}

#[test]
fn new_table_composite_ddl_quotes_each_column_for_supported_dialects() {
    for db_type in [DatabaseType::Mysql, DatabaseType::Postgres, DatabaseType::SqlServer, DatabaseType::Sqlite] {
        let mut input = options(composite(), vec![]);
        input.database_type = db_type;
        input.target_tables.clear();
        input.target_details.clear();
        let result = prepare_schema_diff(input);
        assert_eq!(result.diffs[0].foreign_keys.as_ref().unwrap().len(), 1, "{db_type:?}");
        let expected = match db_type {
            DatabaseType::Mysql => "FOREIGN KEY (`tenant`, `item`)",
            DatabaseType::SqlServer => "FOREIGN KEY ([tenant], [item])",
            _ => "FOREIGN KEY (\"tenant\", \"item\")",
        };
        assert!(result.sync_sql.contains(expected), "{db_type:?}: {}", result.sync_sql);
    }
}

#[test]
fn equivalent_compared_databases_keep_existing_namespace_mapping() {
    let mut input = options(composite(), composite());
    let mut parent = input.source_tables[0].clone();
    parent.name = "parent".into();
    input.source_tables.push(parent.clone());
    input.target_tables.push(parent);
    for row in &mut input.source_details[0].foreign_keys {
        row.ref_schema = Some("source_db".into());
    }
    for row in &mut input.target_details[0].foreign_keys {
        row.ref_schema = Some("destination".into());
    }
    assert!(prepare_schema_diff(input).diffs.is_empty());
}

#[test]
fn serialized_diffs_regenerate_the_complete_constraint() {
    let result = prepare(composite(), vec![]);
    let diffs: Vec<TableDiff> = serde_json::from_value(serde_json::to_value(&result.diffs).unwrap()).unwrap();
    let sql = generate_schema_sync_sql(
        &diffs,
        &[],
        &[],
        &[],
        &[],
        DatabaseType::Mysql,
        Some("destination"),
        false,
        None,
        &[],
    );
    assert_eq!(sql.matches("ADD CONSTRAINT").count(), 1, "{sql}");
    assert!(sql.contains("FOREIGN KEY (`tenant`, `item`) REFERENCES `external`.`parent` (`scope`, `code`)"), "{sql}");
}
