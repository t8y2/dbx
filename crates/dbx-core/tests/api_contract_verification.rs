// ============================================================================
// 12.4 — CLI/Tauri/dbx-web API Contract Verification
//
// These tests verify that public API types maintain backward-compatible
// serialization contracts (field names, optional field handling) and
// that function signatures haven't changed.
// ============================================================================

use dbx_core::data_compare::{DataComparePreparation, DataCompareSyncPlan};
use dbx_core::models::connection::DatabaseType;
use dbx_core::schema_diff::{prepare_schema_diff, SchemaDiffPreparation, SchemaDiffPreparationOptions};
use dbx_core::sql_risk::{classify_sql_risk, SqlRisk};
use dbx_core::types::{ColumnInfo, TableInfo};

// ============================================================================
// Compile-time checks: core function signatures compile
// ============================================================================

/// Verify prepare_schema_diff accepts SchemaDiffPreparationOptions and returns SchemaDiffPreparation
#[test]
fn prepare_schema_diff_function_signature() {
    let options = SchemaDiffPreparationOptions {
        source_tables: vec![TableInfo {
            name: "t".to_string(),
            table_type: "TABLE".to_string(),
            comment: None,
            parent_schema: None,
            parent_name: None,
        }],
        target_tables: vec![TableInfo {
            name: "t".to_string(),
            table_type: "TABLE".to_string(),
            comment: None,
            parent_schema: None,
            parent_name: None,
        }],
        source_details: vec![],
        target_details: vec![],
        source_functions: vec![],
        target_functions: vec![],
        source_sequences: vec![],
        target_sequences: vec![],
        source_rules: vec![],
        target_rules: vec![],
        source_owners: vec![],
        target_owners: vec![],
        database_type: DatabaseType::Postgres,
        target_schema: None,
        ignore_comments: false,
        cascade_delete: false,
        compare_column_order: false,
        detect_renames: false,
        detect_table_renames: false,
        rename_threshold: 0.5,
        enable_rollback: false,
        batch_patterns: vec![],
        source_dialect: None,
        target_dialect: None,
        compatibility_threshold: 0.5,
        source_permissions: vec![],
        target_permissions: vec![],
        shard_strategy: None,
        resource_constraint: None,
        field_mappings: vec![],
    };
    let _result: SchemaDiffPreparation = prepare_schema_diff(options);
}

/// Verify generate_schema_sync_sql accepts all arg types
#[test]
fn generate_schema_sync_sql_function_signature() {
    let _sql = dbx_core::schema_diff::generate_schema_sync_sql(
        &[],
        &[],
        &[],
        &[],
        &[],
        DatabaseType::Postgres,
        None,
        false,
        None,
        &[],
    );
}

/// Verify classify_sql_risk function signature
#[test]
fn classify_sql_risk_function_signature() {
    let _risk: SqlRisk = classify_sql_risk("SELECT 1", "postgres").unwrap();
}

// ============================================================================
// Serialization contract: field naming conventions
// ============================================================================

/// SchemaDiffPreparation fields use camelCase in JSON
#[test]
fn schema_diff_preparation_field_names() {
    let result = prepare_schema_diff(SchemaDiffPreparationOptions {
        source_tables: vec![TableInfo {
            name: "t".to_string(),
            table_type: "TABLE".to_string(),
            comment: None,
            parent_schema: None,
            parent_name: None,
        }],
        target_tables: vec![TableInfo {
            name: "t".to_string(),
            table_type: "TABLE".to_string(),
            comment: None,
            parent_schema: None,
            parent_name: None,
        }],
        source_details: vec![],
        target_details: vec![],
        source_functions: vec![],
        target_functions: vec![],
        source_sequences: vec![],
        target_sequences: vec![],
        source_rules: vec![],
        target_rules: vec![],
        source_owners: vec![],
        target_owners: vec![],
        database_type: DatabaseType::Postgres,
        target_schema: None,
        ignore_comments: false,
        cascade_delete: false,
        compare_column_order: false,
        detect_renames: false,
        detect_table_renames: false,
        rename_threshold: 0.5,
        enable_rollback: false,
        batch_patterns: vec![],
        source_dialect: None,
        target_dialect: None,
        compatibility_threshold: 0.5,
        source_permissions: vec![],
        target_permissions: vec![],
        shard_strategy: None,
        resource_constraint: None,
        field_mappings: vec![],
    });

    let json = serde_json::to_value(&result).unwrap();
    let obj = json.as_object().unwrap();
    let keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();

    // All keys must be camelCase (no underscores)
    for key in &keys {
        assert!(!key.contains('_'), "Key '{}' should be camelCase, not snake_case", key);
    }

    // Core fields must be present
    assert!(keys.contains(&"diffs"), "diffs field must be present");
    assert!(keys.contains(&"syncSql"), "syncSql field must be present");
}

/// DataComparePreparation fields use camelCase
#[test]
fn data_compare_preparation_field_names() {
    use dbx_core::data_compare::{DataCompareResult, DataCompareRow};
    use serde_json::Value;

    let prep = DataComparePreparation {
        result: DataCompareResult {
            added: vec![DataCompareRow {
                key: "1".to_string(),
                key_values: [("id".to_string(), Value::Number(1.into()))].into(),
                values: [("name".to_string(), Value::String("Alice".to_string()))].into(),
            }],
            removed: vec![],
            modified: vec![],
        },
        sync_statements: vec!["INSERT INTO t VALUES (1)".to_string()],
        sync_sql: "INSERT INTO t VALUES (1)".to_string(),
    };

    let json = serde_json::to_value(&prep).unwrap();
    let obj = json.as_object().unwrap();
    for key in obj.keys() {
        assert!(!key.contains('_'), "Key '{}' should be camelCase", key);
    }
    assert!(obj.contains_key("result"), "result must be present");
}

/// DataCompareSyncPlan fields use camelCase
#[test]
fn data_compare_sync_plan_field_names() {
    let plan = DataCompareSyncPlan {
        insert_count: 0,
        update_count: 0,
        delete_count: 0,
        statement_count: 0,
        sync_statements: vec![],
        sync_sql: String::new(),
    };

    let json = serde_json::to_value(&plan).unwrap();
    let obj = json.as_object().unwrap();
    for key in obj.keys() {
        assert!(!key.contains('_'), "Key '{}' should be camelCase", key);
    }
}

// ============================================================================
// Type serialization roundtrip: types used in API boundaries
// ============================================================================

/// Core types must serialize/deserialize consistently
#[test]
fn core_types_serialization_roundtrip() {
    let table = TableInfo {
        name: "users".to_string(),
        table_type: "BASE TABLE".to_string(),
        comment: Some("user table".to_string()),
        parent_schema: Some("public".to_string()),
        parent_name: None,
    };
    let json = serde_json::to_value(&table).unwrap();
    let deserialized: TableInfo = serde_json::from_value(json).unwrap();
    assert_eq!(table.name, deserialized.name);
    assert_eq!(table.comment, deserialized.comment);
}

/// ColumnInfo must serialize/deserialize consistently
#[test]
fn column_info_serialization_roundtrip() {
    let col = ColumnInfo {
        name: "id".to_string(),
        data_type: "int".to_string(),
        is_nullable: false,
        column_default: None,
        is_primary_key: true,
        extra: None,
        comment: None,
        numeric_precision: Some(10),
        numeric_scale: Some(0),
        character_maximum_length: None,
        enum_values: None,
        character_set: None,
        collation: None,
    };
    let json = serde_json::to_value(&col).unwrap();
    let deserialized: ColumnInfo = serde_json::from_value(json).unwrap();
    assert_eq!(col.name, deserialized.name);
    assert_eq!(col.numeric_precision, deserialized.numeric_precision);
}

// ============================================================================
// DatabaseType serialization consistency
// ============================================================================

#[test]
fn database_type_serialization() {
    let json = serde_json::to_value(DatabaseType::Postgres).unwrap();
    assert_eq!(json, "postgres", "DatabaseType serializes using snake_case");

    let json = serde_json::to_value(DatabaseType::Mysql).unwrap();
    assert_eq!(json, "mysql", "DatabaseType serializes using snake_case");
}

// ============================================================================
// Tauri command argument compatibility: Option parameters
// ============================================================================

/// Verify that the types used as Tauri command args serialize/deserialize properly.
/// Tauri passes these as JSON from the frontend, so serde roundtrip must work.
#[test]
fn option_types_work_in_tauri_command_boundary() {
    // Simulate how Tauri passes optional params from JS frontend
    #[derive(serde::Serialize, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TauriLikeCommand {
        diffs: Vec<dbx_core::schema_diff::TableDiff>,
        function_diffs: Option<Vec<dbx_core::schema_diff::FunctionDiff>>,
        cascade_delete: Option<bool>,
        target_schema: Option<String>,
    }

    // Without optional params (frontend omitting them)
    let input = serde_json::json!({
        "diffs": [],
        "functionDiffs": null,
        "cascadeDelete": null,
        "targetSchema": null
    });
    let cmd: TauriLikeCommand = serde_json::from_value(input).unwrap();
    assert!(cmd.function_diffs.is_none());
    assert!(cmd.cascade_delete.is_none());

    // With explicit values
    let input = serde_json::json!({
        "diffs": [],
        "cascadeDelete": true
    });
    let cmd: TauriLikeCommand = serde_json::from_value(input).unwrap();
    assert_eq!(cmd.cascade_delete, Some(true));
}

// ============================================================================
// Web API request compatibility
// ============================================================================

/// Verify GenerateSchemaSyncSqlRequest contract matches the core function signature
#[test]
fn web_api_schema_sync_request_fields() {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    #[allow(dead_code)]
    struct WebApiRequest {
        diffs: Vec<dbx_core::schema_diff::TableDiff>,
        function_diffs: Option<Vec<dbx_core::schema_diff::FunctionDiff>>,
        sequence_diffs: Option<Vec<dbx_core::schema_diff::SequenceDiff>>,
        rule_diffs: Option<Vec<dbx_core::schema_diff::RuleDiff>>,
        owner_diffs: Option<Vec<dbx_core::schema_diff::OwnerDiff>>,
        database_type: DatabaseType,
        target_schema: Option<String>,
        cascade_delete: Option<bool>,
    }

    let json = serde_json::json!({
        "diffs": [],
        "databaseType": "postgres"
    });
    let req: WebApiRequest = serde_json::from_value(json).unwrap();
    assert!(req.diffs.is_empty());
    assert_eq!(req.database_type, DatabaseType::Postgres);
    assert!(req.target_schema.is_none());
    assert!(req.cascade_delete.is_none());
}

// ============================================================================
// SqlRisk enum backward compat: JSON serialization
// ============================================================================

#[test]
fn sql_risk_json_representation() {
    assert_eq!(serde_json::to_value(SqlRisk::ReadOnly).unwrap(), "ReadOnly");
    assert_eq!(serde_json::to_value(SqlRisk::Write).unwrap(), "Write");
    assert_eq!(serde_json::to_value(SqlRisk::Ddl).unwrap(), "Ddl");
    assert_eq!(serde_json::to_value(SqlRisk::Transaction).unwrap(), "Transaction");
}
