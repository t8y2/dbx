use dbx_core::models::connection::DatabaseType;
use dbx_core::schema_diff::{prepare_schema_diff, RollbackGraph, SchemaDiffPreparationOptions, TableSchemaDetail};
use dbx_core::types::{ColumnInfo, TableInfo};

fn table(name: &str) -> TableInfo {
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

// ============================================================================
// 12.3 — Bidirectional Diff E2E Tests
// ============================================================================

/// Create scenario: source (desired) has [id, name, email], target (current) has [id, name]
/// Forward: ADD column email → Rollback: DROP column email
#[test]
fn bidirectional_diff_add_rollback_identity() {
    let options = SchemaDiffPreparationOptions {
        source_tables: vec![table("users")],
        target_tables: vec![table("users")],
        source_details: vec![detail(
            "users",
            vec![col("id", "int"), col("name", "varchar(64)"), col("email", "varchar(128)")],
        )],
        target_details: vec![detail("users", vec![col("id", "int"), col("name", "varchar(64)")])],
        database_type: DatabaseType::Postgres,
        enable_rollback: true,
        ..Default::default()
    };

    let result = prepare_schema_diff(options);

    assert!(!result.diffs.is_empty(), "Should detect new column in source");
    assert!(result.rollback_sync_sql.is_some(), "Rollback SQL should be generated");

    let forward_sql = &result.sync_sql;
    let rollback_sql = result.rollback_sync_sql.as_ref().unwrap();

    // Forward should ADD column to target, rollback should DROP column
    assert!(forward_sql.contains("ADD"), "Forward SQL should contain ADD");
    assert!(rollback_sql.contains("DROP"), "Rollback SQL should contain DROP");
}

/// Delete scenario: source (desired) has [id], target (current) has [id, name, status]
/// Forward: DROP column name, status → Rollback: ADD column name, status
#[test]
fn bidirectional_diff_delete_rollback_identity() {
    let options = SchemaDiffPreparationOptions {
        source_tables: vec![table("users")],
        target_tables: vec![table("users")],
        source_details: vec![detail("users", vec![col("id", "int")])],
        target_details: vec![detail(
            "users",
            vec![col("id", "int"), col("name", "varchar(64)"), col("status", "varchar(16)")],
        )],
        database_type: DatabaseType::Postgres,
        enable_rollback: true,
        ..Default::default()
    };

    let result = prepare_schema_diff(options);

    assert!(!result.diffs.is_empty(), "Should detect extra columns in target");
    assert!(result.rollback_sync_sql.is_some(), "Rollback SQL should be generated");

    let forward_sql = &result.sync_sql;
    let rollback_sql = result.rollback_sync_sql.as_ref().unwrap();

    // Forward should contain DROP for removed columns
    assert!(forward_sql.contains("DROP"), "Forward SQL should contain DROP");
    assert!(!rollback_sql.is_empty(), "Rollback SQL should not be empty");
}

/// Modify scenario: source (desired) has varchar(64), target (current) has varchar(128)
/// Forward: ALTER column type → Rollback: ALTER column back
#[test]
fn bidirectional_diff_modify_rollback_identity() {
    let options = SchemaDiffPreparationOptions {
        source_tables: vec![table("users")],
        target_tables: vec![table("users")],
        source_details: vec![detail("users", vec![col("name", "varchar(64)")])],
        target_details: vec![detail("users", vec![col("name", "varchar(128)")])],
        database_type: DatabaseType::Postgres,
        enable_rollback: true,
        ..Default::default()
    };

    let result = prepare_schema_diff(options);

    assert!(!result.diffs.is_empty(), "Should detect modified column");
    assert_eq!(result.diffs[0].diff_type, "modified");

    // Should have rollback SQL
    assert!(result.rollback_sync_sql.is_some(), "Rollback SQL should be generated");
}

/// RollbackGraph consistency: forward ∘ rollback = identity
#[test]
fn rollback_graph_consistency() {
    let options = SchemaDiffPreparationOptions {
        source_tables: vec![table("users")],
        target_tables: vec![table("users")],
        source_details: vec![detail("users", vec![col("id", "int"), col("name", "varchar(64)")])],
        target_details: vec![detail(
            "users",
            vec![col("id", "int"), col("name", "varchar(64)"), col("email", "varchar(128)")],
        )],
        database_type: DatabaseType::Postgres,
        enable_rollback: true,
        ..Default::default()
    };

    let result = prepare_schema_diff(options);

    assert!(result.rollback_graph.is_some(), "RollbackGraph should be generated");
    let graph = result.rollback_graph.as_ref().unwrap();
    assert!(graph.is_consistent, "RollbackGraph should be consistent");
    assert!(graph.consistency_issues.is_empty(), "RollbackGraph should have no consistency issues");
}

/// RollbackGraph forward + rollback roundtrip: verify rollback_nodes are generated
#[test]
fn rollback_graph_generates_rollback_nodes() {
    let options = SchemaDiffPreparationOptions {
        source_tables: vec![table("users")],
        target_tables: vec![table("users")],
        source_details: vec![detail("users", vec![col("id", "int"), col("status", "varchar(16)")])],
        target_details: vec![detail("users", vec![col("id", "int"), col("status", "varchar(32)")])],
        database_type: DatabaseType::Postgres,
        enable_rollback: true,
        ..Default::default()
    };

    let result = prepare_schema_diff(options);
    assert!(result.rollback_graph.is_some());

    let graph = result.rollback_graph.as_ref().unwrap();
    assert!(!graph.rollback_nodes.is_empty(), "rollback_nodes should be non-empty");
    assert!(graph.is_consistent, "RollbackGraph should be consistent");
}

/// Multiple table E2E: modify one table, add/remove columns in others
#[test]
fn bidirectional_diff_multi_table_e2e() {
    let options = SchemaDiffPreparationOptions {
        source_tables: vec![table("orders"), table("items"), table("archive")],
        target_tables: vec![table("orders"), table("items"), table("archive")],
        source_details: vec![
            // desired: orders with larger decimal + status column added
            detail("orders", vec![col("id", "int"), col("total", "decimal(12,2)"), col("status", "varchar(16)")]),
            // desired: items with larger name
            detail("items", vec![col("id", "int"), col("name", "varchar(128)")]),
            // desired: archive with only id
            detail("archive", vec![col("id", "int")]),
        ],
        target_details: vec![
            // current: orders with smaller decimal, no status
            detail("orders", vec![col("id", "int"), col("total", "decimal(10,2)")]),
            // current: items with smaller name
            detail("items", vec![col("id", "int"), col("name", "varchar(64)")]),
            // current: archive with extra column
            detail("archive", vec![col("id", "int"), col("data", "text")]),
        ],
        database_type: DatabaseType::Postgres,
        enable_rollback: true,
        ..Default::default()
    };

    let result = prepare_schema_diff(options);

    assert!(!result.diffs.is_empty(), "Should detect differences across multiple tables");
    assert!(result.rollback_sync_sql.is_some(), "Rollback SQL should be generated");

    let forward_sql = &result.sync_sql;
    let rollback_sql = result.rollback_sync_sql.as_ref().unwrap();

    assert!(!forward_sql.is_empty(), "Forward SQL should be non-empty");
    assert!(!rollback_sql.is_empty(), "Rollback SQL should be non-empty");

    // Forward and rollback should be different
    assert_ne!(forward_sql, rollback_sql, "Forward and rollback SQL should differ");
}

/// Rename detection: verify rename candidates are populated with matching column structures
#[test]
fn bidirectional_diff_with_rename_detection() {
    let options = SchemaDiffPreparationOptions {
        source_tables: vec![table("users")],
        target_tables: vec![table("user_profiles")],
        source_details: vec![detail("users", vec![col("id", "int"), col("name", "varchar(64)")])],
        target_details: vec![detail("user_profiles", vec![col("id", "int"), col("name", "varchar(64)")])],
        database_type: DatabaseType::Postgres,
        detect_renames: true,
        detect_table_renames: true,
        rename_threshold: 0.5,
        ..Default::default()
    };

    let result = prepare_schema_diff(options);

    // With identical column structure, rename should at least produce diffs
    assert!(!result.diffs.is_empty(), "Should detect difference between differently-named tables");

    // With identical column structures and table rename detection on, candidates must be populated
    assert!(
        !result.rename_candidates.is_empty(),
        "Rename candidates should be detected for identical column structures"
    );
    assert!(result.rename_candidates[0].score > 0.0, "Rename score should be positive");
}

/// RollbackGraph validate_consistency directly
#[test]
fn rollback_graph_direct_consistency_check() {
    use dbx_core::schema_diff::DependencyGraph;

    let forward_diff = dbx_core::schema_diff::TableDiff {
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
    };

    let dep_graph =
        DependencyGraph { nodes: std::collections::HashMap::new(), topological_order: vec!["users".to_string()] };

    let mut graph = RollbackGraph::from_forward_diffs(&[forward_diff], &[], &dep_graph);
    graph.validate_consistency();
    assert!(graph.is_consistent, "Simple add should produce consistent rollback graph");
    assert!(graph.consistency_issues.is_empty());
}
