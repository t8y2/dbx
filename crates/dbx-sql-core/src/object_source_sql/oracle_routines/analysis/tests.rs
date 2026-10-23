use super::*;

fn analyze(body: &str) -> OracleRoutineDraftAnalysis {
    analyze_oracle_routine_draft(EditableObjectSourceSqlInput {
        database_type: DatabaseType::OceanbaseOracle,
        object_type: ObjectSourceKind::Function,
        schema: Some("Owner.Mixed".into()),
        name: "Mixed.Func".into(),
        source: format!("CREATE OR REPLACE FUNCTION \"Owner.Mixed\".\"Mixed.Func\" RETURN NUMBER AS {body}"),
    })
}
fn function(source: &str) -> OracleRoutineDraftAnalysis {
    analyze_oracle_routine_draft(EditableObjectSourceSqlInput {
        database_type: DatabaseType::Oracle,
        object_type: ObjectSourceKind::Function,
        schema: Some("OWNER".into()),
        name: "F".into(),
        source: source.into(),
    })
}

#[test]
fn constant_and_unicode_comment_bodies_are_fully_consumed_without_changing_the_source() {
    let comment = "-- 原文🙂 Source.Owner.f; EXECUTE IMMEDIATE\n".repeat(140);
    let input = EditableObjectSourceSqlInput { database_type: DatabaseType::OceanbaseOracle, object_type: ObjectSourceKind::Function, schema: Some("Owner.Mixed".into()), name: "Mixed.Func".into(), source: format!("CREATE OR REPLACE FUNCTION \"Owner.Mixed\".\"Mixed.Func\" RETURN VARCHAR2 AS\n{comment}BEGIN RETURN q'[Source.Owner.f;  保留🙂]'; END;") };
    let original = input.source.clone();
    let result = analyze_oracle_routine_draft(input.clone());
    assert!(result.complete, "{:?}", result.issues);
    assert!(result.references.is_empty());
    assert_eq!(input.source, original);
}

#[test]
fn scalar_parameters_locals_and_initializers_keep_scope_and_call_dependencies_separate() {
    let result = function("CREATE FUNCTION \"OWNER\".F(a IN NUMBER DEFAULT \"OWNER\".base(), b OUT NUMBER) RETURN NUMBER AUTHID DEFINER AS n NUMBER := \"OWNER\".initial(); c CONSTANT NUMBER := 1; BEGIN n := a + \"OWNER\".other(c); b := n; RETURN n; END F;");
    assert!(result.complete, "{:?}", result.issues);
    assert_eq!(result.parameters.len(), 2);
    assert!(result.parameters[0].has_default);
    assert_eq!(result.parameters[1].mode, "OUT");
    assert_eq!(
        result.references.iter().map(|reference| reference.parts.last().unwrap().value.as_str()).collect::<Vec<_>>(),
        vec!["BASE", "INITIAL", "OTHER"]
    );
    let shadowed = function("CREATE FUNCTION \"OWNER\".F(other NUMBER) RETURN NUMBER AS BEGIN RETURN other; END;");
    assert!(shadowed.complete);
    assert!(shadowed.references.is_empty());
}

#[test]
fn no_parentheses_function_values_and_package_calls_keep_exact_name_parts() {
    let result = analyze("BEGIN RETURN \"Owner.With.Dot\".\"Other.Func\" + \"OWNER\".PKG.member(1); END;");
    assert!(result.complete, "{:?}", result.issues);
    assert_eq!(result.references[0].role, OracleDraftReferenceRole::Value);
    assert_eq!(
        result.references[0].parts,
        vec![
            OracleDraftName { value: "Owner.With.Dot".into(), quoted: true },
            OracleDraftName { value: "Other.Func".into(), quoted: true }
        ]
    );
    assert_eq!(result.references[1].parts.len(), 3);
    assert_eq!(result.references[1].argument_writable, vec![false]);
}

#[test]
fn standalone_procedure_calls_include_no_argument_calls_and_writable_scalar_arguments() {
    let result = analyze_oracle_routine_draft(EditableObjectSourceSqlInput {
        database_type: DatabaseType::Oracle,
        object_type: ObjectSourceKind::Procedure,
        schema: Some("OWNER".into()),
        name: "P".into(),
        source:
            "CREATE PROCEDURE \"OWNER\".P(a IN OUT NUMBER) AS BEGIN \"OWNER\".ready; \"OWNER\".update_value(a, a+1); RETURN; END P;"
                .into(),
    });
    assert!(result.complete, "{:?}", result.issues);
    assert!(result.references.iter().all(|reference| reference.role == OracleDraftReferenceRole::Procedure));
    assert_eq!(result.references[1].argument_writable, vec![true, false]);
}

#[test]
fn a_single_table_select_keeps_columns_and_aliases_for_target_column_binding() {
    let result = analyze("n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM \"Owner.Mixed\".\"Base.Table\"; RETURN n; END;");
    assert!(result.complete, "{:?}", result.issues);
    assert_eq!(result.references.len(), 1);
    assert_eq!(result.references[0].role, OracleDraftReferenceRole::Relation);
    let result = function("CREATE FUNCTION \"OWNER\".F(a NUMBER) RETURN NUMBER AS n NUMBER; BEGIN SELECT a, t.a INTO n, a FROM \"OWNER\".T t WHERE t.a > \"OWNER\".threshold; RETURN n; END;");
    assert!(!result.complete, "IN parameter is not writable INTO");
    let result = function("CREATE FUNCTION \"OWNER\".F(a NUMBER) RETURN NUMBER AS n NUMBER; BEGIN SELECT t.a AS selected_value INTO n FROM \"OWNER\".T t WHERE a > \"OWNER\".threshold; RETURN n; END;");
    assert!(result.complete, "{:?}", result.issues);
    assert_eq!(result.queries[0].alias.as_ref().unwrap().value, "T");
    assert!(result.references.iter().all(|reference| reference.query == Some(0)));
    assert_eq!(
        result.references.iter().find(|reference| reference.parts[0].value == "A").unwrap().local_binding,
        Some(false)
    );
    assert!(!result
        .references
        .iter()
        .any(|reference| reference.parts.iter().any(|part| part.value == "SELECTED_VALUE")));
}

#[test]
fn edited_drafts_produce_new_reference_sets_including_zero_argument_functions() {
    let old = analyze("BEGIN RETURN old_func; END;");
    let edited = analyze("BEGIN RETURN new_func(); END;");
    assert!(old.complete && edited.complete);
    assert_eq!(old.references[0].parts[0].value, "OLD_FUNC");
    assert_eq!(edited.references[0].parts[0].value, "NEW_FUNC");
    assert_eq!(edited.references[0].role, OracleDraftReferenceRole::Function);
}

#[test]
fn unsupported_scopes_dynamic_sql_and_unconsumed_clauses_are_positioned_not_ignored() {
    for body in [
        "BEGIN\nIF 1=1 THEN RETURN 1; END IF; END;",
        "FUNCTION local_f RETURN NUMBER AS BEGIN RETURN 1; END; BEGIN RETURN local_f; END;",
        "BEGIN EXECUTE IMMEDIATE 'SELECT 1 FROM DUAL'; RETURN 1; END;",
        "n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM \"OWNER\".T JOIN \"OWNER\".U ON T.ID=U.ID; RETURN n; END;",
        "BEGIN RETURN (SELECT 1 FROM DUAL); END;",
        "n \"OWNER\".T%TYPE; BEGIN RETURN 1; END;",
        "BEGIN RETURN 1; EXCEPTION WHEN OTHERS THEN RETURN 0; END;",
    ] {
        let result = analyze(body);
        assert!(!result.complete, "unsupported body was accepted: {body}");
        assert!(!result.issues.is_empty());
        assert!(result.issues[0].line >= 1 && result.issues[0].column >= 1);
    }
    assert!(
        !function("CREATE FUNCTION \"OWNER\".F RETURN NUMBER AUTHID CURRENT_USER AS BEGIN RETURN 1; END;").complete
    );
}

#[test]
fn local_calls_forward_bindings_and_bind_placeholders_cannot_hide_dependencies() {
    for source in [
        "CREATE FUNCTION \"OWNER\".F(other NUMBER) RETURN NUMBER AS BEGIN RETURN other(1); END;",
        "CREATE FUNCTION \"OWNER\".F RETURN NUMBER AS n NUMBER := n; BEGIN RETURN n; END;",
        "CREATE FUNCTION \"OWNER\".F RETURN NUMBER AS BEGIN RETURN ?; END;",
        "CREATE FUNCTION \"OWNER\".F RETURN NUMBER PARALLEL_ENABLE AS BEGIN RETURN 1; END;",
    ] {
        assert!(!function(source).complete, "{source}");
    }
}

#[test]
fn quoted_keyword_names_are_identifiers_and_unicode_reference_spans_point_to_original_tokens() {
    let result =
        analyze("\"BEGIN\" NUMBER := 1; BEGIN\n-- 🙂 注释\nRETURN \"Other.Schema\".\"Other.Func\" + \"BEGIN\"; END;");
    assert!(result.complete, "{:?}", result.issues);
    assert_eq!(result.references.len(), 1);
    assert_eq!(result.references[0].line, 3);
    assert_eq!(result.references[0].column, 8);
}

#[test]
fn extra_statements_and_wrong_identity_never_enter_a_complete_plan() {
    for source in [
        "CREATE FUNCTION \"OWNER\".F RETURN NUMBER AS BEGIN RETURN 1; END; DELETE FROM \"OWNER\".T;",
        "CREATE FUNCTION \"OWNER\".OTHER RETURN NUMBER AS BEGIN RETURN 1; END;",
        "CREATE PROCEDURE \"OWNER\".F AS BEGIN NULL; END;",
    ] {
        assert!(!function(source).complete);
    }
}
