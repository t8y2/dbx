use dbx_core::data_compare::{DataCompareFromTablesPreparation, DataComparePreparation, DataCompareResult};
use dbx_core::models::connection::DatabaseType;
use dbx_core::schema_diff::{
    generate_schema_sync_sql, prepare_schema_diff, SchemaDiffPreparation, SchemaDiffPreparationOptions, TableDiff,
    TableSchemaDetail,
};
use dbx_core::sql_risk::{classify_sql_risk, SqlRisk};
use dbx_core::types::{ColumnInfo, TableInfo};

// ============================================================================
// 12.1 — SchemaDiffPreparation backward-compatibility regression tests
// ============================================================================

fn basic_table_info(name: &str) -> TableInfo {
    TableInfo {
        name: name.to_string(),
        table_type: "BASE TABLE".to_string(),
        comment: None,
        parent_schema: None,
        parent_name: None,
    }
}

fn col(name: &str, data_type: &str) -> ColumnInfo {
    ColumnInfo {
        name: name.to_string(),
        data_type: data_type.to_string(),
        is_nullable: false,
        column_default: None,
        is_primary_key: false,
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

fn detail(name: &str, columns: Vec<ColumnInfo>) -> TableSchemaDetail {
    TableSchemaDetail {
        name: name.to_string(),
        columns,
        indexes: vec![],
        foreign_keys: vec![],
        triggers: vec![],
        ddl: None,
    }
}

/// Verify that new optional fields in SchemaDiffPreparation are well-formed
/// when using basic (non-enhanced) options, ensuring backward compatibility
/// for existing callers that only use the original fields.
#[test]
fn schema_diff_preparation_new_fields_defaults_backward_compatible() {
    let options = SchemaDiffPreparationOptions {
        source_tables: vec![basic_table_info("users")],
        target_tables: vec![basic_table_info("users")],
        source_details: vec![detail("users", vec![col("name", "varchar(64)")])],
        target_details: vec![detail("users", vec![col("name", "varchar(128)")])],
        database_type: DatabaseType::Postgres,
        ..Default::default()
    };

    let result = prepare_schema_diff(options);

    // Original required fields must be present
    assert!(!result.diffs.is_empty(), "diffs should be non-empty");
    assert!(!result.sync_sql.is_empty(), "sync_sql should be non-empty");

    // New optional fields from Phase 4+ must have sensible defaults
    assert!(result.rollback_sync_sql.is_none(), "rollback_sync_sql should default to None");
    assert!(result.rename_candidates.is_empty(), "rename_candidates should default to empty");
    assert!(result.rollback_graph.is_none(), "rollback_graph should default to None");
    assert!(result.compatibility_warnings.is_empty(), "compatibility_warnings should default to empty");
    assert!(result.permission_diffs.is_empty(), "permission_diffs should default to empty");
    assert!(result.permission_sync_sql.is_none(), "permission_sync_sql should default to None");

    // dependency_graph is always built by prepare_schema_diff regardless of options
    // (it's used internally for topological ordering)
    assert!(result.dependency_graph.is_some(), "dependency_graph should be present (always built for ordering)");
}

/// Verify that SchemaDiffPreparation serializes to JSON with backward-compatible
/// field names (camelCase) and optional fields skipped when None/empty.
#[test]
fn schema_diff_preparation_json_serialization_skips_optional_fields() {
    let options = SchemaDiffPreparationOptions {
        source_tables: vec![basic_table_info("users")],
        target_tables: vec![basic_table_info("users")],
        source_details: vec![detail("users", vec![col("name", "varchar(64)")])],
        target_details: vec![detail("users", vec![col("name", "varchar(128)")])],
        database_type: DatabaseType::Postgres,
        ..Default::default()
    };

    let result = prepare_schema_diff(options);
    let json = serde_json::to_value(&result).expect("Serialization should succeed");

    // Original fields must be present
    assert!(json.get("diffs").is_some(), "diffs must be present");
    assert!(json.get("syncSql").is_some(), "syncSql must be present");

    // New optional fields should NOT appear when None/empty
    assert!(json.get("rollbackSyncSql").is_none(), "rollbackSyncSql should be absent");
    assert!(json.get("renameCandidates").is_none(), "renameCandidates should be absent");
    assert!(json.get("rollbackGraph").is_none(), "rollbackGraph should be absent");
    assert!(json.get("compatibilityWarnings").is_none(), "compatibilityWarnings should be absent");
    assert!(json.get("permissionDiffs").is_none(), "permissionDiffs should be absent");
    assert!(json.get("permissionSyncSql").is_none(), "permissionSyncSql should be absent");

    // dependency_graph is always populated by prepare_schema_diff
    assert!(json.get("dependencyGraph").is_some(), "dependencyGraph is always built by prepare_schema_diff");
}

/// Verify that an old-format JSON (without new fields) can be deserialized
/// into SchemaDiffPreparation with defaults.
#[test]
fn schema_diff_preparation_deserializes_old_format_with_defaults() {
    let old_json = serde_json::json!({
        "diffs": [],
        "syncSql": "SELECT 1"
    });

    let result: SchemaDiffPreparation = serde_json::from_value(old_json).expect("Old-format JSON should deserialize");

    assert!(result.diffs.is_empty());
    assert_eq!(result.sync_sql, "SELECT 1");
    assert!(result.rollback_sync_sql.is_none());
    assert!(result.rename_candidates.is_empty());
    assert!(result.dependency_graph.is_none());
}

/// Verify that generate_schema_sync_sql output is invariant under default options
/// — i.e., callers that don't pass rollback/rename/permission options still get
/// identical SQL output.
#[test]
fn generate_schema_sync_sql_output_invariant() {
    let diffs = vec![TableDiff {
        diff_type: "added".to_string(),
        object_type: None,
        name: "users".to_string(),
        columns: Some(vec![]),
        indexes: None,
        foreign_keys: None,
        triggers: None,
        ddl: Some("CREATE TABLE users (id INT)".to_string()),
        target_ddl: None,
        source_table_comment: None,
        target_table_comment: None,
        sync_sql: None,
    }];

    let sql = generate_schema_sync_sql(&diffs, &[], &[], &[], &[], DatabaseType::Postgres, None, false, None, &[]);
    assert!(sql.contains("CREATE TABLE"), "SQL should contain CREATE TABLE");
    assert!(sql.contains("users"), "SQL should contain table name");
}

/// Verify that with all enhancement flags off, the output of
/// prepare_schema_diff matches the same as if they didn't exist.
#[test]
fn prepare_schema_diff_with_default_options_matches_basic_diff() {
    let options = SchemaDiffPreparationOptions {
        source_tables: vec![basic_table_info("orders")],
        target_tables: vec![basic_table_info("orders")],
        source_details: vec![detail("orders", vec![col("id", "int"), col("status", "varchar(16)")])],
        target_details: vec![detail("orders", vec![col("id", "int"), col("status", "varchar(32)")])],
        database_type: DatabaseType::Postgres,
        ..Default::default()
    };

    let result = prepare_schema_diff(options);
    assert!(!result.diffs.is_empty());
    assert_eq!(result.diffs.len(), 1);
    assert_eq!(result.diffs[0].diff_type, "modified");
    assert!(!result.sync_sql.is_empty());
}

// ============================================================================
// 12.1 — SqlRisk backward-compatibility regression tests
// ============================================================================

/// Verify that SqlRisk::ReadOnly classification is unchanged
#[test]
fn sql_risk_readonly_classification_invariant() {
    assert_eq!(classify_sql_risk("SELECT * FROM users", "postgres").unwrap(), SqlRisk::ReadOnly);
    assert_eq!(classify_sql_risk("SELECT id, name FROM users WHERE id = 1", "mysql").unwrap(), SqlRisk::ReadOnly);
    assert_eq!(classify_sql_risk("SHOW TABLES", "mysql").unwrap(), SqlRisk::ReadOnly);
    assert_eq!(classify_sql_risk("DESCRIBE users", "mysql").unwrap(), SqlRisk::ReadOnly);
    assert_eq!(classify_sql_risk("EXPLAIN SELECT * FROM users", "postgres").unwrap(), SqlRisk::ReadOnly);
    assert_eq!(classify_sql_risk("WITH cte AS (SELECT 1) SELECT * FROM cte", "postgres").unwrap(), SqlRisk::ReadOnly);
}

/// Verify that SqlRisk::Write classification is unchanged
#[test]
fn sql_risk_write_classification_invariant() {
    assert_eq!(classify_sql_risk("INSERT INTO users VALUES (1)", "postgres").unwrap(), SqlRisk::Write);
    assert_eq!(classify_sql_risk("UPDATE users SET name = 'x'", "postgres").unwrap(), SqlRisk::Write);
    assert_eq!(classify_sql_risk("DELETE FROM users WHERE id = 1", "postgres").unwrap(), SqlRisk::Write);
}

/// Verify that SqlRisk::Ddl classification is unchanged
#[test]
fn sql_risk_ddl_classification_invariant() {
    assert_eq!(classify_sql_risk("CREATE TABLE users (id INT)", "postgres").unwrap(), SqlRisk::Ddl);
    assert_eq!(classify_sql_risk("DROP TABLE users", "postgres").unwrap(), SqlRisk::Ddl);
    assert_eq!(classify_sql_risk("ALTER TABLE users ADD COLUMN age INT", "postgres").unwrap(), SqlRisk::Ddl);
    assert_eq!(classify_sql_risk("TRUNCATE TABLE users", "postgres").unwrap(), SqlRisk::Ddl);
}

/// Verify that multi-statement returns highest risk (unchanged)
#[test]
fn sql_risk_multi_statement_invariant() {
    assert_eq!(classify_sql_risk("SELECT 1; INSERT INTO users VALUES (1)", "postgres").unwrap(), SqlRisk::Write);
    assert_eq!(classify_sql_risk("SELECT 1; CREATE TABLE t (id INT)", "postgres").unwrap(), SqlRisk::Ddl);
}

// ============================================================================
// 12.1 — DataCompare result format compatibility tests
// ============================================================================

/// Verify that DataCompareFromTablesPreparation serializes with backward-compatible
/// field names and new optional fields are skipped when None.
#[test]
fn data_compare_from_tables_preparation_optional_fields_default() {
    let prep = DataCompareFromTablesPreparation {
        result: DataCompareResult { added: vec![], removed: vec![], modified: vec![] },
        sync_statements: vec![],
        sync_sql: String::new(),
        pre_sync_statements: vec![],
        source_row_count: 0,
        target_row_count: 0,
        source_truncated: false,
        target_truncated: false,
        degradation_level: None,
        sampling_rate: None,
        confidence_score: None,
        verification_method: None,
        source_checksums: None,
        target_checksums: None,
    };

    let json = serde_json::to_value(&prep).expect("Serialization should succeed");

    // Core fields must be present
    assert!(json.get("result").is_some(), "result must be present");
    assert!(json.get("syncSql").is_some(), "syncSql must be present");

    // New optional fields should be absent when None
    assert!(json.get("degradationLevel").is_none(), "degradationLevel should be absent");
    assert!(json.get("samplingRate").is_none(), "samplingRate should be absent");
    assert!(json.get("confidenceScore").is_none(), "confidenceScore should be absent");
    assert!(json.get("verificationMethod").is_none(), "verificationMethod should be absent");
    assert!(json.get("sourceChecksums").is_none(), "sourceChecksums should be absent");
    assert!(json.get("targetChecksums").is_none(), "targetChecksums should be absent");
}

/// Verify that an old-format JSON can be deserialized into DataCompareFromTablesPreparation
#[test]
fn data_compare_from_tables_preparation_deserializes_old_format() {
    let old_json = serde_json::json!({
        "result": { "added": [], "removed": [], "modified": [] },
        "syncStatements": [],
        "syncSql": "",
        "preSyncStatements": [],
        "sourceRowCount": 100,
        "targetRowCount": 100,
        "sourceTruncated": false,
        "targetTruncated": false
    });

    let prep: DataCompareFromTablesPreparation =
        serde_json::from_value(old_json).expect("Old-format JSON should deserialize");

    assert_eq!(prep.source_row_count, 100);
    assert_eq!(prep.target_row_count, 100);
    assert!(prep.degradation_level.is_none());
    assert!(prep.sampling_rate.is_none());
    assert!(prep.confidence_score.is_none());
}

/// Verify that DataComparePreparation (the original struct) remains unchanged
#[test]
fn data_compare_preparation_format_stable() {
    let prep = DataComparePreparation {
        result: DataCompareResult { added: vec![], removed: vec![], modified: vec![] },
        sync_statements: vec!["INSERT INTO t VALUES (1)".to_string()],
        sync_sql: "INSERT INTO t VALUES (1)".to_string(),
    };

    let json = serde_json::to_value(&prep).expect("Serialization should succeed");
    assert_eq!(json["syncStatements"][0], "INSERT INTO t VALUES (1)");
    assert_eq!(json["syncSql"], "INSERT INTO t VALUES (1)");
    assert!(json.get("result").is_some());
}
