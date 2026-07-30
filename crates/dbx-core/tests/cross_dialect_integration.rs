use dbx_core::models::connection::DatabaseType;
use dbx_core::schema_diff::{
    generate_schema_sync_sql, prepare_schema_diff, SchemaDiffPreparationOptions, TableSchemaDetail,
};
use dbx_core::sql_dialect::descriptor::DialectKind;
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
// 12.2 — Cross-dialect full-chain integration tests
// ============================================================================

/// MySQL → PostgreSQL: diff a schema between MySQL source and PG target,
/// verify SQL output uses PostgreSQL syntax and identifiers.
#[test]
fn mysql_to_postgresql_full_chain_diff_and_sql_generation() {
    let options = SchemaDiffPreparationOptions {
        source_tables: vec![table("users")],
        target_tables: vec![table("users")],
        source_details: vec![detail(
            "users",
            vec![col("id", "int"), col("name", "varchar(64)"), col("email", "varchar(128)")],
        )],
        target_details: vec![detail(
            "users",
            vec![col("id", "serial"), col("name", "text"), col("email", "varchar(128)"), col("age", "int")],
        )],
        database_type: DatabaseType::Postgres,
        source_dialect: Some(DialectKind::Mysql),
        target_dialect: Some(DialectKind::Postgres),
        ..Default::default()
    };

    let result = prepare_schema_diff(options);

    // Should detect column type changes and an extra column in target
    assert!(!result.diffs.is_empty(), "Should detect differences between MySQL and PG schemas");

    // SQL should use PostgreSQL double-quote identifiers
    let pg_sql = &result.sync_sql;
    assert!(pg_sql.contains('"'), "PostgreSQL SQL should use double-quoted identifiers");
    assert!(!pg_sql.contains('`'), "PostgreSQL SQL should NOT use backtick identifiers");

    // Verify compatibility warnings if type differences exist
    // varchar(64) → text may or may not generate a warning depending on threshold
}

/// PostgreSQL → SQLite: diff a schema between PG source and SQLite target,
/// verify SQL output uses SQLite-compatible syntax.
#[test]
fn postgresql_to_sqlite_full_chain_diff_and_sql_generation() {
    let options = SchemaDiffPreparationOptions {
        source_tables: vec![table("products")],
        target_tables: vec![table("products")],
        source_details: vec![detail(
            "products",
            vec![col("id", "serial"), col("name", "varchar(100)"), col("price", "numeric(10,2)")],
        )],
        target_details: vec![detail(
            "products",
            vec![col("id", "integer"), col("name", "text"), col("price", "real"), col("category", "text")],
        )],
        database_type: DatabaseType::Sqlite,
        source_dialect: Some(DialectKind::Postgres),
        target_dialect: Some(DialectKind::Sqlite),
        ..Default::default()
    };

    let result = prepare_schema_diff(options);

    assert!(!result.diffs.is_empty(), "Should detect differences between PG and SQLite schemas");

    // SQLite identifiers are double-quoted or unquoted
    let sqlite_sql = &result.sync_sql;
    // SQLite uses CREATE TABLE IF NOT EXISTS etc.
    assert!(!sqlite_sql.contains("::"), "SQLite SQL should not contain PG type casts");
}

/// MySQL → SQLite: full chain cross-dialect comparison
#[test]
fn mysql_to_sqlite_cross_dialect_diff() {
    let options = SchemaDiffPreparationOptions {
        source_tables: vec![table("events")],
        target_tables: vec![table("events")],
        source_details: vec![detail(
            "events",
            vec![
                col("id", "bigint unsigned"),
                col("event_type", "enum('click','view')"),
                col("created_at", "datetime"),
            ],
        )],
        target_details: vec![detail(
            "events",
            vec![col("id", "integer"), col("event_type", "text"), col("created_at", "text"), col("source", "text")],
        )],
        database_type: DatabaseType::Sqlite,
        source_dialect: Some(DialectKind::Mysql),
        target_dialect: Some(DialectKind::Sqlite),
        ..Default::default()
    };

    let result = prepare_schema_diff(options);
    assert!(!result.diffs.is_empty(), "MySQL enum → SQLite text should be detected as a difference");
}

// ============================================================================
// 12.2 — Same-dialect consistency: diff should be empty when schemas match
// ============================================================================

#[test]
fn identical_mysql_schemas_produce_no_diff() {
    let options = SchemaDiffPreparationOptions {
        source_tables: vec![table("users")],
        target_tables: vec![table("users")],
        source_details: vec![detail("users", vec![col("id", "int"), col("name", "varchar(64)")])],
        target_details: vec![detail("users", vec![col("id", "int"), col("name", "varchar(64)")])],
        database_type: DatabaseType::Mysql,
        ..Default::default()
    };

    let result = prepare_schema_diff(options);
    assert!(result.diffs.is_empty(), "Identical schemas should produce no diffs");
    assert!(result.sync_sql.is_empty(), "Identical schemas should produce no SQL");
}

#[test]
fn identical_postgres_schemas_produce_no_diff() {
    let options = SchemaDiffPreparationOptions {
        source_tables: vec![table("users")],
        target_tables: vec![table("users")],
        source_details: vec![detail("users", vec![col("id", "int"), col("name", "text")])],
        target_details: vec![detail("users", vec![col("id", "int"), col("name", "text")])],
        database_type: DatabaseType::Postgres,
        ..Default::default()
    };

    let result = prepare_schema_diff(options);
    assert!(result.diffs.is_empty(), "Identical schemas should produce no diffs");
}

// ============================================================================
// 12.2 — Cross-dialect generate_schema_sync_sql verification
// ============================================================================

#[test]
fn generate_schema_sync_sql_mysql_output_format() {
    let diffs = vec![dbx_core::schema_diff::TableDiff {
        diff_type: "added".to_string(),
        object_type: None,
        name: "users".to_string(),
        columns: Some(vec![]),
        indexes: None,
        foreign_keys: None,
        triggers: None,
        ddl: Some("CREATE TABLE `users` (`id` INT NOT NULL, `name` VARCHAR(64) NOT NULL)".to_string()),
        target_ddl: None,
        source_table_comment: None,
        target_table_comment: None,
        sync_sql: None,
    }];

    let sql = generate_schema_sync_sql(&diffs, &[], &[], &[], &[], DatabaseType::Mysql, None, false, None, &[]);

    assert!(sql.contains("CREATE TABLE"), "MySQL SQL should contain CREATE TABLE");
    assert!(sql.contains('`'), "MySQL SQL should use backtick identifiers");
}

#[test]
fn generate_schema_sync_sql_postgres_output_format() {
    let diffs = vec![dbx_core::schema_diff::TableDiff {
        diff_type: "added".to_string(),
        object_type: None,
        name: "users".to_string(),
        columns: Some(vec![]),
        indexes: None,
        foreign_keys: None,
        triggers: None,
        ddl: Some("CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)".to_string()),
        target_ddl: None,
        source_table_comment: None,
        target_table_comment: None,
        sync_sql: None,
    }];

    let sql = generate_schema_sync_sql(&diffs, &[], &[], &[], &[], DatabaseType::Postgres, None, false, None, &[]);
    assert!(sql.contains("CREATE TABLE"), "PostgreSQL SQL should contain CREATE TABLE");
    assert!(sql.contains("SERIAL"), "PostgreSQL SQL should use SERIAL type");
}

#[test]
fn generate_schema_sync_sql_sqlite_output_format() {
    let diffs = vec![dbx_core::schema_diff::TableDiff {
        diff_type: "added".to_string(),
        object_type: None,
        name: "users".to_string(),
        columns: Some(vec![]),
        indexes: None,
        foreign_keys: None,
        triggers: None,
        ddl: Some("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)".to_string()),
        target_ddl: None,
        source_table_comment: None,
        target_table_comment: None,
        sync_sql: None,
    }];

    let sql = generate_schema_sync_sql(&diffs, &[], &[], &[], &[], DatabaseType::Sqlite, None, false, None, &[]);
    assert!(sql.contains("CREATE TABLE"), "SQLite SQL should contain CREATE TABLE");
}
