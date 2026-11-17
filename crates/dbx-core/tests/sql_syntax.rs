use dbx_core::sql_syntax::{analyze_sql_editor, analyze_sql_syntax, SqlSyntaxDiagnostic};

#[test]
fn public_api_returns_structured_serializable_diagnostics() {
    let diagnostics = analyze_sql_syntax("SELECT * FROM users WHERE active = AND id = 1;", Some("postgres"));
    assert_eq!(diagnostics.len(), 1);
    let diagnostic = &diagnostics[0];
    assert_eq!(diagnostic.severity, "error");
    assert_eq!(diagnostic.found.as_deref(), Some("AND"));
    assert!(diagnostic.expected.iter().any(|value| value.contains("expression")));
    assert!(diagnostic.span.start_column > 1);

    let json = serde_json::to_value(diagnostic).expect("diagnostic serializes");
    assert_eq!(json["severity"], "error");
    assert_eq!(json["found"], "AND");
    assert!(json["span"]["start_line"].is_number());
    assert!(json["span"]["end_column"].is_number());
}

#[test]
fn public_api_preserves_statement_recovery_and_valid_dialect_gaps() {
    let diagnostics =
        analyze_sql_syntax("SELECT a FROM t WHERE a = AND a = 1;\nSELECT * FROM x WHERE );", Some("postgres"));
    assert_eq!(diagnostics.len(), 2);
    assert_eq!(diagnostics[0].span.start_line, 1);
    assert_eq!(diagnostics[1].span.start_line, 2);

    let valid = analyze_sql_syntax("DROP INDEX CONCURRENTLY IF EXISTS orders_idx;", Some("postgres"));
    assert_eq!(valid, Vec::<SqlSyntaxDiagnostic>::new());
}

#[test]
fn editor_api_returns_references_and_syntax_from_one_statement_analysis() {
    let valid = analyze_sql_editor("SELECT u.id FROM users u", Some("postgres"));
    assert_eq!(valid.references.expect("references").tables[0].name, "users");
    assert!(valid.parser_error.is_none());
    assert!(valid.syntax.is_empty());

    let invalid = analyze_sql_editor("SELECT * FROM users WHERE active = AND id = 1", Some("postgres"));
    assert!(invalid.references.is_none());
    assert!(invalid.parser_error.is_some());
    assert_eq!(invalid.syntax.len(), 1);
    let json = serde_json::to_value(invalid).expect("editor analysis serializes");
    assert!(json["parserError"].is_string());
    assert!(json["references"].is_null());
}
