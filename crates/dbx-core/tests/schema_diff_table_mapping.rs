use dbx_core::models::connection::DatabaseType;
use dbx_core::schema_diff::{
    prepare_schema_diff, SchemaDiffPreparationOptions, SchemaDiffTableMapping, TableSchemaDetail,
};
use dbx_core::types::{ColumnInfo, TableInfo};

fn table(name: &str) -> TableInfo {
    TableInfo {
        name: name.to_string(),
        table_type: "TABLE".to_string(),
        comment: None,
        parent_schema: None,
        parent_name: None,
    }
}

fn column(name: &str, data_type: &str) -> ColumnInfo {
    ColumnInfo {
        name: name.to_string(),
        data_type: data_type.to_string(),
        resolved_schema: None,
        is_nullable: false,
        column_default: None,
        is_primary_key: false,
        is_unique: false,
        extra: None,
        comment: None,
        numeric_precision: None,
        numeric_scale: None,
        character_maximum_length: None,
        enum_values: None,
        character_set: None,
        collation: None,
    }
}

#[test]
fn manual_table_mapping_compares_source_and_target_details_and_targets_physical_table() {
    let prepared = prepare_schema_diff(SchemaDiffPreparationOptions {
        source_tables: vec![table("charge_records")],
        target_tables: vec![table("charge_record")],
        source_details: vec![TableSchemaDetail {
            name: "charge_records".to_string(),
            columns: vec![column("amount", "decimal(12,2)")],
            indexes: vec![],
            foreign_keys: vec![],
            triggers: vec![],
            ddl: Some("CREATE TABLE charge_records (amount decimal(12,2));".to_string()),
        }],
        target_details: vec![TableSchemaDetail {
            name: "charge_record".to_string(),
            columns: vec![column("amount", "decimal(10,2)")],
            indexes: vec![],
            foreign_keys: vec![],
            triggers: vec![],
            ddl: Some("CREATE TABLE charge_record (amount decimal(10,2));".to_string()),
        }],
        database_type: DatabaseType::Mysql,
        table_mappings: vec![SchemaDiffTableMapping {
            source_table: "charge_records".to_string(),
            target_table: "charge_record".to_string(),
        }],
        ..Default::default()
    });

    assert_eq!(prepared.diffs.len(), 1);
    let diff = &prepared.diffs[0];
    assert_eq!(diff.diff_type, "modified");
    assert_eq!(diff.name, "charge_records");
    assert_eq!(diff.target_name.as_deref(), Some("charge_record"));
    assert!(diff.columns.as_ref().is_some_and(|columns| columns.iter().any(|column| column.name == "amount")));
    assert!(prepared.sync_sql.contains("ALTER TABLE `charge_record`"), "{}", prepared.sync_sql);
    assert!(!prepared.sync_sql.contains("ALTER TABLE `charge_records`"), "{}", prepared.sync_sql);
}
