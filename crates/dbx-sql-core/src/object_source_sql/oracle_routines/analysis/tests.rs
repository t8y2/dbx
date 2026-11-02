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
fn a_package_specification_reports_public_scalar_exception_and_non_overloaded_signatures() {
    let result = analyze_oracle_routine_draft(EditableObjectSourceSqlInput {
        database_type: DatabaseType::OceanbaseOracle, object_type: ObjectSourceKind::Package,
        schema: Some("OWNER".into()), name: "P".into(),
        source: "CREATE PACKAGE \"OWNER\".P AUTHID DEFINER AS g NUMBER := 1; e EXCEPTION; FUNCTION f(p NUMBER DEFAULT 2) RETURN NUMBER; PROCEDURE step(p IN OUT NUMBER); END P;".into(),
    });
    assert!(result.complete, "{:?}", result.issues);
    let value = serde_json::to_value(&result).unwrap();
    assert_eq!(value["packageMembers"].as_array().unwrap().len(), 4);
    assert_eq!(value["packageMembers"][2]["parameters"][0]["name"]["value"], "P");
    assert_eq!(value["packageMembers"][2]["parameters"][0]["defaultExpression"], "2");
    assert_eq!(value["packageMembers"][3]["parameters"][0]["mode"], "IN OUT");
    assert_eq!(value["hasPackageInitialization"], true);
    assert!(result.references.is_empty());
}

#[test]
fn package_default_expressions_keep_internal_calls_out_of_schema_dependencies() {
    let result = analyze_oracle_routine_draft(EditableObjectSourceSqlInput {
        database_type: DatabaseType::OceanbaseOracle,
        object_type: ObjectSourceKind::Package,
        schema: Some("OWNER".into()),
        name: "P".into(),
        source:
            "CREATE PACKAGE \"OWNER\".P AS FUNCTION seed RETURN NUMBER; g NUMBER := seed + OWNER.external_seed(); END P;"
                .into(),
    });
    assert!(result.complete, "{:?}", result.issues);
    assert_eq!(result.references.len(), 1);
    assert_eq!(result.references[0].parts.last().unwrap().value, "EXTERNAL_SEED");
    assert_eq!(serde_json::to_value(&result).unwrap()["packageCalls"][0]["callee"]["value"], "SEED");
}

#[test]
fn package_edition_attributes_require_target_evidence_without_changing_standalone_routine_analysis() {
    for option in ["EDITIONABLE", "NONEDITIONABLE"] {
        let specification = EditableObjectSourceSqlInput {
            database_type: DatabaseType::Oracle,
            object_type: ObjectSourceKind::Package,
            schema: Some("OWNER".into()),
            name: "P".into(),
            source: "CREATE PACKAGE \"OWNER\".P AS g NUMBER := 1; END P;".into(),
        };
        let spec_source = format!("CREATE {option} PACKAGE \"OWNER\".P AS g NUMBER := 1; END P;");
        let spec = analyze_oracle_routine_draft(EditableObjectSourceSqlInput {
            source: spec_source.clone(),
            ..specification.clone()
        });
        let body_source = format!("CREATE {option} PACKAGE BODY \"OWNER\".P AS END P;");
        let body = analyze_oracle_package_body_draft(
            EditableObjectSourceSqlInput {
                object_type: ObjectSourceKind::PackageBody,
                source: body_source.clone(),
                ..specification.clone()
            },
            specification,
        );
        for (result, source) in [(spec, spec_source), (body, body_source)] {
            assert!(!result.complete);
            let issue = result
                .issues
                .iter()
                .find(|issue| issue.message.contains("edition identity and capabilities"))
                .unwrap_or_else(|| panic!("{source}: {:?}", result.issues));
            assert_eq!(issue.line, 1);
            assert_eq!(issue.column, source.find(option).unwrap() as u64 + 1);
        }
        assert!(
            function(&format!("CREATE {option} FUNCTION \"OWNER\".F RETURN NUMBER AS BEGIN RETURN 1; END;")).complete
        );
    }
}

#[test]
fn body_analysis_requires_its_final_specification_instead_of_guessing_package_bindings() {
    let result = analyze_oracle_routine_draft(EditableObjectSourceSqlInput {
        database_type: DatabaseType::OceanbaseOracle,
        object_type: ObjectSourceKind::PackageBody,
        schema: Some("OWNER".into()),
        name: "P".into(),
        source: "CREATE PACKAGE BODY \"OWNER\".P AS FUNCTION f RETURN NUMBER IS BEGIN RETURN g; END; END P;".into(),
    });
    assert!(!result.complete);
    assert!(result.issues.iter().any(|issue| issue.message.contains("final specification")));
}

#[test]
fn package_body_binds_public_contract_and_private_forward_calls_without_schema_dependencies() {
    let specification = EditableObjectSourceSqlInput {
        database_type: DatabaseType::OceanbaseOracle,
        object_type: ObjectSourceKind::Package,
        schema: Some("APP".into()),
        name: "P".into(),
        source: "CREATE PACKAGE APP.P AS g NUMBER := 1; FUNCTION f(p NUMBER DEFAULT 2) RETURN NUMBER; END P;".into(),
    };
    let body = EditableObjectSourceSqlInput {
        object_type: ObjectSourceKind::PackageBody,
        source: "CREATE PACKAGE BODY APP.P AS FUNCTION f(p NUMBER) RETURN NUMBER IS BEGIN RETURN helper(p) + g; END f; FUNCTION helper(x NUMBER) RETURN NUMBER IS BEGIN RETURN x; END helper; END P;".into(),
        ..specification.clone()
    };
    let result = analyze_oracle_package_body_draft(body.clone(), specification.clone());
    assert!(result.complete, "{:?}", result.issues);
    assert!(result.references.is_empty());
    assert_eq!(result.package_calls.len(), 1);
    assert_eq!(result.package_calls[0].callee.value, "HELPER");
    let public = result.package_members.iter().find(|member| member.name.value == "F").unwrap();
    assert!(public.parameters[0].has_default);
    assert!(public.defined && public.public);
    for (from, to) in [
        ("f(p NUMBER)", "f(x NUMBER)"),
        ("f(p NUMBER)", "f(p NUMBER DEFAULT 3)"),
        ("RETURN NUMBER IS", "RETURN VARCHAR2 IS"),
    ] {
        let invalid = EditableObjectSourceSqlInput { source: body.source.replacen(from, to, 1), ..body.clone() };
        assert!(!analyze_oracle_package_body_draft(invalid, specification.clone()).complete);
    }
}

#[test]
fn preserved_package_flow_body_is_fully_analyzed_with_its_final_specification() {
    let spec = EditableObjectSourceSqlInput {
        database_type: DatabaseType::OceanbaseOracle,
        object_type: ObjectSourceKind::Package,
        schema: Some("APP".into()),
        name: "PKG_FLOW".into(),
        source: "CREATE PACKAGE PKG_FLOW AS g_bias NUMBER := 1; FUNCTION score(p NUMBER) RETURN NUMBER; END PKG_FLOW;"
            .into(),
    };
    let body = EditableObjectSourceSqlInput {
        object_type: ObjectSourceKind::PackageBody,
        source: include_str!("../../../../tests/fixtures/oracle_package_flow_body.sql").into(),
        ..spec.clone()
    };
    let result = analyze_oracle_package_body_draft(body, spec);
    assert!(result.complete, "{:?}", result.issues);
    assert!(result.references.is_empty(), "{:?}", result.references);
    assert_eq!(
        result.package_calls.iter().map(|call| call.line).collect::<Vec<_>>(),
        vec![9, 13, 17, 20, 21, 23, 24, 26, 28]
    );
    assert!(result.package_calls.iter().all(|call| call.callee.value == "STEP"));
}

fn package_procedure(body: &str) -> OracleRoutineDraftAnalysis {
    let specification = EditableObjectSourceSqlInput {
        database_type: DatabaseType::OceanbaseOracle,
        object_type: ObjectSourceKind::Package,
        schema: Some("APP".into()),
        name: "P".into(),
        source: "CREATE PACKAGE APP.P AS PROCEDURE run; END P;".into(),
    };
    analyze_oracle_package_body_draft(
        EditableObjectSourceSqlInput {
            object_type: ObjectSourceKind::PackageBody,
            source: format!(
                "CREATE PACKAGE BODY APP.P AS PROCEDURE run IS n NUMBER; e EXCEPTION; BEGIN {body} END run; END P;"
            ),
            ..specification.clone()
        },
        specification,
    )
}

#[test]
fn package_control_flow_visits_every_condition_bound_branch_and_handler_without_evaluation() {
    let result = package_procedure("IF APP.a() > 0 AND NOT (n IS NULL) THEN NULL; ELSIF APP.b() = 0 THEN NULL; ELSE n := APP.c(); END IF; FOR i IN REVERSE APP.lo()..APP.hi() LOOP CONTINUE WHEN APP.skip() = i; END LOOP; WHILE APP.more() > 0 LOOP EXIT WHEN APP.stop() = 1; END LOOP; IF FALSE THEN n := APP.unreachable(); END IF; DECLARE n NUMBER := APP.initial(); e EXCEPTION; BEGIN n := APP.inner(); EXCEPTION WHEN e OR VALUE_ERROR THEN n := APP.handler(); WHEN OTHERS THEN RAISE; END; n := APP.restored(); EXCEPTION WHEN e THEN n := APP.outer_handler();");
    assert!(result.complete, "{:?}", result.issues);
    assert_eq!(
        result.references.iter().map(|reference| reference.parts.last().unwrap().value.as_str()).collect::<Vec<_>>(),
        vec![
            "A",
            "B",
            "C",
            "LO",
            "HI",
            "SKIP",
            "MORE",
            "STOP",
            "UNREACHABLE",
            "INITIAL",
            "INNER",
            "HANDLER",
            "RESTORED",
            "OUTER_HANDLER"
        ]
    );
}

#[test]
fn package_control_flow_rejects_incomplete_scopes_jumps_and_hidden_dynamic_sql() {
    for body in [
        "IF TRUE THEN NULL; END;",
        "LOOP NULL; END;",
        "EXIT;",
        "CONTINUE WHEN TRUE;",
        "RAISE;",
        "RAISE missing;",
        "RAISE n;",
        "IF TRUE THEN END IF;",
        "FOR i IN (SELECT n FROM t) LOOP NULL; END LOOP;",
        "FOR i IN 1..3 LOOP i := 2; END LOOP;",
        "NULL; EXCEPTION WHEN OTHERS THEN NULL; WHEN VALUE_ERROR THEN NULL;",
        "NULL; EXCEPTION WHEN e THEN EXECUTE IMMEDIATE 'SELECT 1';",
    ] {
        let result = package_procedure(body);
        assert!(!result.complete, "accepted: {body}");
        assert!(result.issues[0].line > 0 && result.issues[0].column > 0);
    }
}

#[test]
fn package_initialization_is_analyzed_but_cannot_return_a_member_result() {
    let spec = EditableObjectSourceSqlInput {
        database_type: DatabaseType::OceanbaseOracle,
        object_type: ObjectSourceKind::Package,
        schema: Some("APP".into()),
        name: "P".into(),
        source: "CREATE PACKAGE APP.P AS g NUMBER; END P;".into(),
    };
    let body = EditableObjectSourceSqlInput {
        object_type: ObjectSourceKind::PackageBody,
        source: "CREATE PACKAGE BODY APP.P AS BEGIN g := APP.seed(); END P;".into(),
        ..spec.clone()
    };
    let result = analyze_oracle_package_body_draft(body.clone(), spec.clone());
    assert!(result.complete, "{:?}", result.issues);
    assert!(result.has_package_initialization);
    assert_eq!(result.references[0].parts.last().unwrap().value, "SEED");
    let invalid = EditableObjectSourceSqlInput { source: body.source.replace("g := APP.seed()", "RETURN 1"), ..body };
    assert!(!analyze_oracle_package_body_draft(invalid, spec).complete);
}

#[test]
fn package_lexical_values_and_exceptions_restore_outer_bindings_and_reject_escaped_names() {
    let result = package_procedure("DECLARE e NUMBER; BEGIN e := 1; END; RAISE e;");
    assert!(result.complete, "{:?}", result.issues);
    for body in [
        "FOR i IN 1..3 LOOP NULL; END LOOP; n := i;",
        "DECLARE v NUMBER; BEGIN NULL; END; n := v;",
        "n := e;",
        "FOR e IN 1..3 LOOP RAISE e; END LOOP;",
    ] {
        let result = package_procedure(body);
        assert!(!result.complete, "accepted invalid lexical binding: {body}");
    }
}

#[test]
fn package_self_qualified_assignment_and_external_exception_keep_exact_binding_roles() {
    let specification = EditableObjectSourceSqlInput {
        database_type: DatabaseType::OceanbaseOracle,
        object_type: ObjectSourceKind::Package,
        schema: Some("APP".into()),
        name: "P".into(),
        source: "CREATE PACKAGE APP.P AS g NUMBER; PROCEDURE run; END P;".into(),
    };
    let body = EditableObjectSourceSqlInput { object_type: ObjectSourceKind::PackageBody,
        source: "CREATE PACKAGE BODY APP.P AS PROCEDURE run IS BEGIN P.g := APP.seed(); APP.P.g := g; EXCEPTION WHEN APP.OTHER.bad THEN RAISE APP.OTHER.bad; END run; END P;".into(), ..specification.clone() };
    let result = analyze_oracle_package_body_draft(body, specification);
    assert!(result.complete, "{:?}", result.issues);
    let roles =
        result.references.iter().map(|reference| serde_json::to_value(&reference.role).unwrap()).collect::<Vec<_>>();
    assert_eq!(
        roles,
        vec![serde_json::json!("function"), serde_json::json!("exception"), serde_json::json!("exception")]
    );
}

#[test]
fn package_sql_column_candidates_keep_exception_and_expired_local_evidence_for_target_binding() {
    let result = package_procedure("DECLARE retired NUMBER; BEGIN NULL; END; SELECT retired,e INTO n,n FROM APP.t;");
    assert!(result.complete, "{:?}", result.issues);
    let references = serde_json::to_value(&result.references).unwrap();
    assert_eq!(references[1]["outOfScopeBinding"], true);
    assert_eq!(references[2]["packageBinding"], "exception");
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
