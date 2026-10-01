use super::{render_sqlserver_table_ddl_details, SqlServerDdlDetails};
use crate::db::{sqlserver::SqlServerTemporalTableMetadata, ColumnInfo};
use std::collections::HashMap;

fn metadata() -> SqlServerTemporalTableMetadata {
    SqlServerTemporalTableMetadata {
        temporal_type: 2,
        start_column: Some("ValidFrom".into()),
        end_column: Some("ValidTo".into()),
        history_schema: Some("History".into()),
        history_table: Some("Versions".into()),
        parent_schema: None,
        parent_table: None,
        retention_period: None,
        retention_unit: None,
    }
}

fn render(temporal: &SqlServerTemporalTableMetadata) -> String {
    let columns = [
        ColumnInfo { name: "id".into(), data_type: "int".into(), is_primary_key: true, ..Default::default() },
        ColumnInfo { name: "ValidFrom".into(), data_type: "datetime2(7)".into(), ..Default::default() },
        ColumnInfo { name: "ValidTo".into(), data_type: "datetime2(7)".into(), ..Default::default() },
    ];
    let generated = HashMap::from([
        ("ValidFrom".into(), "GENERATED ALWAYS AS ROW START HIDDEN".into()),
        ("ValidTo".into(), "GENERATED ALWAYS AS ROW END".into()),
    ]);
    render_sqlserver_table_ddl_details(
        "dbo",
        "Current",
        &columns,
        &[],
        &[],
        None,
        SqlServerDdlDetails { generated_clauses: Some(&generated), temporal: Some(temporal), ..Default::default() },
    )
}

#[test]
fn current_temporal_ddl_keeps_period_generation_visibility_and_history_identity() {
    let ddl = render(&metadata());
    assert!(ddl.contains("[ValidFrom] datetime2(7) GENERATED ALWAYS AS ROW START HIDDEN NOT NULL"));
    assert!(ddl.contains("[ValidTo] datetime2(7) GENERATED ALWAYS AS ROW END NOT NULL"));
    assert!(ddl.contains("PERIOD FOR SYSTEM_TIME ([ValidFrom], [ValidTo])"));
    assert!(ddl.contains("WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = [History].[Versions]))"));
}

#[test]
fn disabled_versioning_keeps_the_period_without_reenabling_history() {
    let mut temporal = metadata();
    temporal.temporal_type = 0;
    temporal.history_schema = None;
    temporal.history_table = None;
    let ddl = render(&temporal);
    assert!(ddl.contains("PERIOD FOR SYSTEM_TIME ([ValidFrom], [ValidTo])"));
    assert!(!ddl.contains("SYSTEM_VERSIONING"));
}

#[test]
fn history_retention_is_explicit_only_for_finite_periods() {
    let mut temporal = metadata();
    temporal.retention_period = Some(6);
    temporal.retention_unit = Some("MONTH".into());
    assert!(render(&temporal).contains("HISTORY_RETENTION_PERIOD = 6 MONTH"));
    temporal.retention_period = Some(-1);
    temporal.retention_unit = Some("INFINITE".into());
    assert!(!render(&temporal).contains("HISTORY_RETENTION_PERIOD"));
}

#[test]
fn qualified_history_identifiers_escape_brackets() {
    let mut temporal = metadata();
    temporal.history_schema = Some("His]t".into());
    temporal.history_table = Some("V]ersions".into());
    assert!(render(&temporal).contains("HISTORY_TABLE = [His]]t].[V]]ersions]"));
}

#[test]
fn history_relationship_comment_cannot_turn_identifier_newlines_into_sql() {
    let temporal = SqlServerTemporalTableMetadata {
        temporal_type: 1,
        start_column: None,
        end_column: None,
        history_schema: None,
        history_table: None,
        parent_schema: Some("dbo".into()),
        parent_table: Some("Current\nDROP TABLE victim;--".into()),
        retention_period: None,
        retention_unit: None,
    };
    let ddl = render_sqlserver_table_ddl_details(
        "History",
        "Versions",
        &[ColumnInfo { name: "id".into(), data_type: "int".into(), ..Default::default() }],
        &[],
        &[],
        None,
        SqlServerDdlDetails { temporal: Some(&temporal), ..Default::default() },
    );
    assert!(ddl.starts_with("-- History table for [dbo].[Current\\nDROP TABLE victim;--]\nCREATE TABLE"));
    let statements = sqlparser::parser::Parser::parse_sql(&sqlparser::dialect::MsSqlDialect {}, &ddl).unwrap();
    assert_eq!(statements.len(), 1);
}
