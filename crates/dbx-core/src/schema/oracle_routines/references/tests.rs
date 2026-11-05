use super::*;
use dbx_sql::object_source_sql::{analyze_oracle_routine_draft, EditableObjectSourceSqlInput, OracleDraftParameter};
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone)]
struct Entry {
    owner: &'static str,
    name: &'static str,
    kind: &'static str,
    columns: Vec<&'static str>,
    synonym: Option<(&'static str, &'static str, Option<&'static str>)>,
    member: Option<&'static str>,
    function: bool,
    parameters: Vec<(&'static str, bool)>,
    grant: bool,
}

impl Entry {
    fn object(owner: &'static str, name: &'static str, kind: &'static str) -> Self {
        Self {
            owner,
            name,
            kind,
            columns: vec!["N"],
            synonym: None,
            member: None,
            function: kind == "FUNCTION",
            parameters: Vec::new(),
            grant: false,
        }
    }
}

#[derive(Default)]
struct Catalog {
    entries: Vec<Entry>,
    dba_denied: bool,
    incomplete_columns: bool,
    changed: AtomicBool,
    specifications: BTreeMap<(String, String), String>,
    source_changed: AtomicBool,
}

fn value_after(sql: &str, field: &str) -> String {
    sql.split(&format!("{field} = '")).nth(1).unwrap_or("").split('\'').next().unwrap_or("").into()
}
fn reply(columns: &[&str], rows: Vec<Vec<Value>>) -> CatalogReply {
    serde_json::from_value(json!({"columns":columns,"rows":rows})).unwrap()
}
fn page(columns: &[&str], mut rows: Vec<Vec<Value>>) -> CatalogReply {
    let mut columns = columns.to_vec();
    columns.push("RN");
    for (index, row) in rows.iter_mut().enumerate() {
        row.push(json!(index + 1));
    }
    reply(&columns, rows)
}

#[test]
fn confirmation_proofs_preserve_catalog_number_precision_and_cell_types_across_javascript() {
    let id = json!(9_007_199_254_740_993u64);
    let encoded = lossless_catalog_value(&id);
    assert_eq!(encoded, json!(["number", "9007199254740993"]));
    assert_ne!(encoded, lossless_catalog_value(&json!("9007199254740993")));
    assert_ne!(encoded, lossless_catalog_value(&json!(["number", "9007199254740993"])));
    let nested = lossless_catalog_value(&json!({"objectId":[18_446_744_073_709_551_615u64]}));
    assert_eq!(nested, json!(["object", {"objectId":["array", [["number","18446744073709551615"]]]}]));
    let proof = CatalogReadProof::Query {
        sql: "SELECT OBJECT_ID FROM ALL_OBJECTS".into(),
        columns: vec!["OBJECT_ID".into()],
        rows: vec![vec![id]],
    };
    assert_eq!(proof.manifest_value()["Query"]["rows"][0][0], encoded);
}

#[async_trait::async_trait]
impl RoutineCatalog for Catalog {
    async fn source(&self, identity: &RoutineIdentity) -> Result<SourceReply, String> {
        assert_eq!(
            identity.kind,
            db::ObjectSourceKind::Package,
            "Resolution must never read or invoke a package implementation"
        );
        let source = self
            .specifications
            .get(&(identity.owner.clone(), identity.name.clone()))
            .expect("Only explicit strict package references may fetch a specification");
        let source = if self.source_changed.load(Ordering::SeqCst) {
            source.replace("g NUMBER := 1", "g NUMBER := 2")
        } else {
            source.clone()
        };
        Ok(serde_json::from_value(json!({ "name": identity.name, "schema": identity.owner, "object_type": "PACKAGE", "source": source, "source_origin": "oceanbase-dictionary" })).unwrap())
    }
    async fn query(&self, sql: &str) -> Result<CatalogReply, String> {
        if sql.contains("LOGIN_OWNER") {
            return Ok(reply(&["LOGIN_OWNER"], vec![vec![json!("OWNER")]]));
        }
        if sql.contains("DBA_OBJECTS") && self.dba_denied {
            return Err("ORA-00942: dictionary unavailable".into());
        }
        let owner = value_after(sql, "OWNER");
        if sql.contains("SOURCE_CHARS") {
            let name = value_after(sql, "NAME");
            let source = &self.specifications[&(owner.clone(), name)];
            return Ok(reply(
                &["SOURCE_ROWS", "FIRST_LINE", "LAST_LINE", "SOURCE_CHARS", "HEAD_TRIM", "TAIL_TRIM", "SOURCE_HEAD"],
                vec![vec![
                    json!(1),
                    json!(1),
                    json!(1),
                    json!(source.chars().count()),
                    json!(0),
                    json!(0),
                    json!("CREATE PACKAGE"),
                ]],
            ));
        }
        let name = value_after(sql, "OBJECT_NAME");
        if sql.contains("ALL_OBJECTS") || sql.contains("DBA_OBJECTS") {
            let rows = self
                .entries
                .iter()
                .enumerate()
                .filter(|(_, entry)| entry.owner == owner && entry.name == name)
                .map(|(index, entry)| {
                    vec![
                        json!(entry.owner),
                        json!(entry.name),
                        json!(entry.kind),
                        json!(index + 1),
                        json!(if self.changed.load(Ordering::SeqCst) { "INVALID" } else { "VALID" }),
                        json!("2026-10-21T00:00:00"),
                    ]
                })
                .collect();
            return Ok(reply(&["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID", "STATUS", "LAST_DDL_TIME"], rows));
        }
        if sql.contains("ALL_SYNONYMS") {
            let name = value_after(sql, "SYNONYM_NAME");
            return Ok(reply(
                &["OWNER", "SYNONYM_NAME", "TABLE_OWNER", "TABLE_NAME", "DB_LINK"],
                self.entries
                    .iter()
                    .filter(|entry| entry.owner == owner && entry.name == name)
                    .filter_map(|entry| {
                        entry.synonym.map(|(target_owner, target_name, link)| {
                            vec![json!(owner), json!(name), json!(target_owner), json!(target_name), json!(link)]
                        })
                    })
                    .collect(),
            ));
        }
        if sql.contains("ALL_TAB_COLUMNS") {
            let name = value_after(sql, "TABLE_NAME");
            let rows = self
                .entries
                .iter()
                .find(|entry| entry.owner == owner && entry.name == name)
                .map(|entry| {
                    entry.columns.iter().enumerate().map(|(index, name)| vec![json!(index + 1), json!(name)]).collect()
                })
                .unwrap_or_default();
            let mut result = page(&["COLUMN_ID", "COLUMN_NAME"], rows);
            result.flags.truncated = self.incomplete_columns;
            return Ok(result);
        }
        if sql.contains("ALL_TAB_PRIVS") {
            let owner = value_after(sql, "TABLE_SCHEMA");
            let name = value_after(sql, "TABLE_NAME");
            let entry = self.entries.iter().find(|entry| entry.owner == owner && entry.name == name);
            return Ok(page(
                &["GRANTEE", "PRIVILEGE"],
                entry
                    .filter(|entry| entry.grant)
                    .map(|entry| {
                        vec![vec![json!("OWNER"), json!(if entry.kind == "TABLE" { "SELECT" } else { "EXECUTE" })]]
                    })
                    .unwrap_or_default(),
            ));
        }
        if sql.contains("SYS_PRIVS") {
            return Ok(page(&["PRIVILEGE"], Vec::new()));
        }
        if sql.contains("ALL_PROCEDURES") || sql.contains("ALL_ARGUMENTS") {
            let id =
                sql.split("OBJECT_ID = ").nth(1).unwrap().split_whitespace().next().unwrap().parse::<usize>().unwrap();
            let entry = &self.entries[id - 1];
            if sql.contains("ALL_PROCEDURES") {
                let member = value_after(sql, "PROCEDURE_NAME");
                return Ok(page(
                    &["OBJECT_ID", "SUBPROGRAM_ID"],
                    if entry.member.unwrap_or("") == member { vec![vec![json!(id), json!(1)]] } else { Vec::new() },
                ));
            }
            let mut rows = Vec::new();
            if entry.function {
                rows.push(vec![
                    json!(0),
                    json!(1),
                    json!("OUT"),
                    json!("NUMBER"),
                    Value::Null,
                    Value::Null,
                    Value::Null,
                    json!("N"),
                ]);
            }
            for (index, (mode, default)) in entry.parameters.iter().enumerate() {
                rows.push(vec![
                    json!(index + 1),
                    json!(rows.len() + 1),
                    json!(mode),
                    json!("NUMBER"),
                    Value::Null,
                    Value::Null,
                    Value::Null,
                    json!(if *default { "Y" } else { "N" }),
                ]);
            }
            return Ok(page(
                &[
                    "POSITION",
                    "SEQUENCE",
                    "IN_OUT",
                    "DATA_TYPE",
                    "TYPE_OWNER",
                    "TYPE_NAME",
                    "TYPE_SUBNAME",
                    "DEFAULTED",
                ],
                rows,
            ));
        }
        panic!("Unexpected metadata query: {sql}")
    }
}

fn endpoint() -> RoutineEndpoint {
    RoutineEndpoint {
        connection_id: "target".into(),
        database: "tenant".into(),
        schema: "OWNER".into(),
        database_type: DatabaseType::OceanbaseOracle,
        generation: 1,
    }
}
fn draft(name: &str, body: &str) -> SelectedFinalDraft {
    let identity = RoutineIdentity { owner: "OWNER".into(), name: name.into(), kind: db::ObjectSourceKind::Function };
    let analysis = analyze_oracle_routine_draft(EditableObjectSourceSqlInput {
        database_type: endpoint().database_type,
        object_type: identity.kind.clone(),
        schema: Some(identity.owner.clone()),
        name: identity.name.clone(),
        source: format!("CREATE FUNCTION \"OWNER\".\"{name}\" RETURN NUMBER AS {body}"),
    });
    assert!(analysis.complete, "{:?}", analysis.issues);
    SelectedFinalDraft { identity, analysis: Some(analysis) }
}

fn package_draft(source: &str) -> SelectedFinalDraft {
    let identity = RoutineIdentity { owner: "OWNER".into(), name: "PKG".into(), kind: db::ObjectSourceKind::Package };
    let analysis = analyze_oracle_routine_draft(EditableObjectSourceSqlInput {
        database_type: endpoint().database_type,
        object_type: identity.kind.clone(),
        schema: Some(identity.owner.clone()),
        name: identity.name.clone(),
        source: source.into(),
    });
    assert!(analysis.complete, "{:?}", analysis.issues);
    SelectedFinalDraft { identity, analysis: Some(analysis) }
}

fn table_dependent_body(column: &str) -> SelectedFinalDraft {
    package_body(&format!(
        "FUNCTION f RETURN NUMBER IS n NUMBER; BEGIN SELECT a.{column} INTO n FROM TARGET_REL a; RETURN n; END f;"
    ))
}

fn package_body(body: &str) -> SelectedFinalDraft {
    let specification = "CREATE PACKAGE \"OWNER\".PKG AS FUNCTION f RETURN NUMBER; END PKG;";
    let input = EditableObjectSourceSqlInput {
        database_type: endpoint().database_type,
        object_type: db::ObjectSourceKind::Package,
        schema: Some("OWNER".into()),
        name: "PKG".into(),
        source: specification.into(),
    };
    let analysis = dbx_sql::object_source_sql::analyze_oracle_package_body_draft(
        EditableObjectSourceSqlInput {
            object_type: db::ObjectSourceKind::PackageBody,
            source: format!("CREATE PACKAGE BODY \"OWNER\".PKG AS {body} END PKG;"),
            ..input.clone()
        },
        input,
    );
    assert!(analysis.complete, "{:?}", analysis.issues);
    SelectedFinalDraft {
        identity: RoutineIdentity {
            owner: "OWNER".into(),
            name: "PKG".into(),
            kind: db::ObjectSourceKind::PackageBody,
        },
        analysis: Some(analysis),
    }
}

#[tokio::test]
async fn table_proofs_carry_server_generated_reference_provenance_and_exact_ranges() {
    let selected = vec![table_dependent_body("TARGET_N")];
    let tables = vec![PlannedRelation {
        owner: "OWNER".into(),
        name: "TARGET_REL".into(),
        columns: BTreeSet::from(["TARGET_N".into()]),
    }];
    let pending = resolve_draft_with_tables(&Catalog::default(), &endpoint(), &selected, 0, &tables).await;
    let mut entry = Entry::object("OWNER", "TARGET_REL", "TABLE");
    entry.columns = vec!["TARGET_N"];
    let catalog = Catalog { entries: vec![entry], ..Default::default() };
    let actual = resolve_draft(&catalog, &endpoint(), &selected, 0).await;
    assert!(actual.issues.is_empty(), "{:?}", actual.issues);
    assert_eq!(pending.proof_groups.len(), actual.proof_groups.len());
    assert_eq!(
        reference_proof_manifest(&pending.proof_groups, &pending.proofs, &tables),
        reference_proof_manifest(&actual.proof_groups, &actual.proofs, &tables),
        "Only the precisely registered pending relation changes catalog source"
    );
    assert_ne!(
        reference_proof_manifest(&actual.proof_groups, &actual.proofs, &tables),
        reference_proof_manifest(&actual.proof_groups, &actual.proofs, &[]),
        "Ordinary relation namespace and column proofs must remain in the frozen manifest"
    );
    let mut table_groups = 0;
    for (before, after) in pending.proof_groups.iter().zip(&actual.proof_groups) {
        assert_eq!(serde_json::to_value(&before.purpose).unwrap(), serde_json::to_value(&after.purpose).unwrap());
        if let ReferenceProofPurpose::Reference { reference, resolved: Some(resolved), query: Some(query), index } =
            &after.purpose
        {
            if reference.role == OracleDraftReferenceRole::Relation {
                table_groups += 1;
                assert_eq!(resolved.owner, "OWNER");
                assert_eq!(resolved.name, "TARGET_REL");
                assert_eq!(resolved.kind, "TABLE");
                assert_eq!(query.relation_reference, *index);
                assert_eq!(before.start, before.end, "Pending tables have no invented catalog proofs");
                assert!(after.end > after.start, "The real table contributes its own namespace and column reads");
            }
        }
    }
    assert_eq!(table_groups, 1);
    for result in [&pending, &actual] {
        let mut covered = 0;
        for group in &result.proof_groups {
            assert_eq!(group.start, covered);
            assert!(group.end >= group.start && group.end <= result.proofs.len());
            covered = group.end;
        }
        assert_eq!(covered, result.proofs.len(), "Every real query/source proof has exactly one provenance");
    }
}

#[tokio::test]
async fn planned_table_columns_bind_without_fabricating_catalog_rows() {
    let selected = vec![table_dependent_body("TARGET_N")];
    let tables = vec![PlannedRelation {
        owner: "OWNER".into(),
        name: "TARGET_REL".into(),
        columns: BTreeSet::from(["TARGET_N".into()]),
    }];
    let result = resolve_draft_with_tables(&Catalog::default(), &endpoint(), &selected, 0, &tables).await;
    assert!(result.issues.is_empty(), "{:?}", result.issues);
    assert_eq!(result.references.len(), 1);
    assert_eq!(result.references[0].name, "TARGET_REL");
    assert_eq!(result.planned_table_dependencies, BTreeSet::from([0]));
    assert_eq!(
        result.proofs.len(),
        1,
        "Only the real login query is observed; a planned relation is not a fake catalog query"
    );
    let old_name = vec![table_dependent_body("SOURCE_N")];
    let rejected = resolve_draft_with_tables(&Catalog::default(), &endpoint(), &old_name, 0, &tables).await;
    assert!(rejected.issues.iter().any(|issue| issue.message.contains("column")));
    let public = Catalog { entries: vec![Entry::object("PUBLIC", "TARGET_REL", "TABLE")], ..Default::default() };
    let result = resolve_draft_with_tables(&public, &endpoint(), &selected, 0, &tables).await;
    assert!(result.issues.is_empty(), "The planned local table must precede any PUBLIC object");
    assert_eq!(result.references[0].owner, "OWNER");
}

#[tokio::test]
async fn pending_relations_do_not_bypass_external_resolution_or_become_callable() {
    let tables = vec![PlannedRelation {
        owner: "OWNER".into(),
        name: "TARGET_REL".into(),
        columns: BTreeSet::from(["TARGET_N".into()]),
    }];
    let callable = vec![package_body("FUNCTION f RETURN NUMBER IS BEGIN RETURN TARGET_REL(); END f;")];
    let result = resolve_draft_with_tables(&Catalog::default(), &endpoint(), &callable, 0, &tables).await;
    assert!(result.issues.iter().any(|issue| issue.message.contains("planned table")));
    let missing = vec![package_body("FUNCTION f RETURN NUMBER IS n NUMBER; BEGIN SELECT a.TARGET_N INTO n FROM TARGET_REL a; RETURN MISSING_HELPER(); END f;")];
    let result = resolve_draft_with_tables(&Catalog::default(), &endpoint(), &missing, 0, &tables).await;
    assert_eq!(result.planned_table_dependencies, BTreeSet::from([0]));
    assert!(!result.issues.is_empty());
    for invalid in [
        vec![PlannedRelation {
            owner: "OTHER".into(),
            name: "TARGET_REL".into(),
            columns: BTreeSet::from(["TARGET_N".into()]),
        }],
        vec![PlannedRelation { owner: "OWNER".into(), name: "TARGET_REL".into(), columns: BTreeSet::new() }],
        vec![PlannedRelation {
            owner: "OWNER".into(),
            name: "PKG".into(),
            columns: BTreeSet::from(["TARGET_N".into()]),
        }],
    ] {
        let result = resolve_draft_with_tables(&Catalog::default(), &endpoint(), &missing, 0, &invalid).await;
        assert!(result.issues.iter().any(|issue| issue.code == "pending-table-scope"));
    }
    let ordinary = vec![draft("CALLER", "BEGIN RETURN 1; END;")];
    assert!(resolve_draft_with_tables(&Catalog::default(), &endpoint(), &ordinary, 0, &tables)
        .await
        .issues
        .iter()
        .any(|issue| issue.code == "pending-table-scope"));
    assert!(resolve_draft(&Catalog::default(), &endpoint(), &ordinary, 0).await.issues.is_empty());
}

#[tokio::test]
async fn selected_package_calls_bind_to_final_public_specification_not_body_or_old_dictionary() {
    let specification = package_draft(
        "CREATE PACKAGE \"OWNER\".PKG AS n NUMBER; e EXCEPTION; FUNCTION f(p NUMBER DEFAULT 2) RETURN NUMBER; END PKG;",
    );
    let deleted_body = SelectedFinalDraft {
        identity: RoutineIdentity {
            owner: "OWNER".into(),
            name: "PKG".into(),
            kind: db::ObjectSourceKind::PackageBody,
        },
        analysis: None,
    };
    let selected = vec![deleted_body, draft("CALLER", "BEGIN RETURN \"OWNER\".PKG.f(); END;"), specification];
    let catalog = Catalog::default();
    let result = resolve_draft(&catalog, &endpoint(), &selected, 1).await;
    assert!(result.issues.is_empty(), "{:?}", result.issues);
    assert_eq!(result.references[0].kind, "PACKAGE");
    assert_eq!(result.references[0].member.as_deref(), Some("F"));
    assert_eq!(result.selected_dependencies, BTreeSet::from([2]));
    let mut missing = selected.clone();
    missing[2] = package_draft("CREATE PACKAGE \"OWNER\".PKG AS n NUMBER; END PKG;");
    assert!(!resolve_draft(&catalog, &endpoint(), &missing, 1).await.issues.is_empty());
}

#[tokio::test]
async fn selected_package_scalar_value_is_not_mistaken_for_a_function_signature() {
    let selected = vec![
        draft("CALLER", "BEGIN RETURN \"OWNER\".PKG.n; END;"),
        package_draft("CREATE PACKAGE \"OWNER\".PKG AS n NUMBER; END PKG;"),
    ];
    let result = resolve_draft(&Catalog::default(), &endpoint(), &selected, 0).await;
    assert!(result.issues.is_empty(), "{:?}", result.issues);
    assert_eq!(result.references[0].member.as_deref(), Some("N"));
}

#[tokio::test]
async fn unselected_package_contract_uses_complete_specification_and_rechecks_same_length_changes() {
    let mut entry = Entry::object("OTHER", "P", "PACKAGE");
    entry.grant = true;
    entry.member = Some("F");
    entry.function = true;
    let catalog = Catalog {
        entries: vec![entry],
        specifications: BTreeMap::from([(
            ("OTHER".into(), "P".into()),
            "CREATE PACKAGE \"OTHER\".P AS g NUMBER := 1; FUNCTION f RETURN NUMBER; END P;".into(),
        )]),
        ..Default::default()
    };
    let selected = vec![package_draft("CREATE PACKAGE \"OWNER\".PKG AS n NUMBER := OTHER.P.f(); END PKG;")];
    let result = resolve_draft(&catalog, &endpoint(), &selected, 0).await;
    assert!(result.issues.is_empty(), "{:?}", result.issues);
    let proof = result.proofs.iter().find(|proof| matches!(proof, CatalogReadProof::Source { .. })).unwrap();
    proof.verify(&catalog).await.unwrap();
    let frozen = reference_proof_manifest(&result.proof_groups, &result.proofs, &[]);
    catalog.source_changed.store(true, Ordering::SeqCst);
    assert!(proof.verify(&catalog).await.unwrap_err().contains("specification"));
    let compatible_change = resolve_draft(&catalog, &endpoint(), &selected, 0).await;
    assert!(compatible_change.issues.is_empty(), "The changed specification still has the same usable member");
    assert_ne!(
        frozen,
        reference_proof_manifest(&compatible_change.proof_groups, &compatible_change.proofs, &[]),
        "Reanalysis success must not silently replace a complete external source proof"
    );
    let missing = Catalog {
        specifications: BTreeMap::from([(
            ("OTHER".into(), "P".into()),
            "CREATE PACKAGE \"OTHER\".P AS g NUMBER := 1; END P;".into(),
        )]),
        ..catalog
    };
    assert!(!resolve_draft(&missing, &endpoint(), &selected, 0).await.issues.is_empty());
}

#[tokio::test]
async fn package_body_depends_on_final_spec_and_resolves_external_exception_role() {
    let spec = EditableObjectSourceSqlInput {
        database_type: endpoint().database_type,
        object_type: db::ObjectSourceKind::Package,
        schema: Some("OWNER".into()),
        name: "PKG".into(),
        source: "CREATE PACKAGE \"OWNER\".PKG AS PROCEDURE run; END PKG;".into(),
    };
    let analysis = dbx_sql::object_source_sql::analyze_oracle_package_body_draft(EditableObjectSourceSqlInput {
        object_type: db::ObjectSourceKind::PackageBody, source: "CREATE PACKAGE BODY \"OWNER\".PKG AS PROCEDURE run IS BEGIN NULL; EXCEPTION WHEN OTHER.P.e THEN RAISE OTHER.P.e; END run; END PKG;".into(), ..spec.clone()
    }, spec.clone());
    assert!(analysis.complete, "{:?}", analysis.issues);
    let body = SelectedFinalDraft {
        identity: RoutineIdentity {
            owner: "OWNER".into(),
            name: "PKG".into(),
            kind: db::ObjectSourceKind::PackageBody,
        },
        analysis: Some(analysis),
    };
    let selected = vec![body, package_draft(&spec.source)];
    let mut external = Entry::object("OTHER", "P", "PACKAGE");
    external.grant = true;
    let catalog = Catalog {
        entries: vec![external],
        specifications: BTreeMap::from([(
            ("OTHER".into(), "P".into()),
            "CREATE PACKAGE \"OTHER\".P AS e EXCEPTION; END P;".into(),
        )]),
        ..Default::default()
    };
    let result = resolve_draft(&catalog, &endpoint(), &selected, 0).await;
    assert!(result.issues.is_empty(), "{:?}", result.issues);
    assert_eq!(result.selected_dependencies, BTreeSet::from([1]));
    assert_eq!(result.references.len(), 2);
    assert!(result.references.iter().all(|reference| reference.member.as_deref() == Some("E")));
    assert_eq!(result.proofs.iter().filter(|proof| matches!(proof, CatalogReadProof::Source { .. })).count(), 1);
}

#[tokio::test]
async fn package_sql_columns_precede_member_roles_and_expired_locals_but_do_not_hide_missing_bindings() {
    let spec = EditableObjectSourceSqlInput { database_type: endpoint().database_type, object_type: db::ObjectSourceKind::Package,
        schema: Some("OWNER".into()), name: "PKG".into(), source: "CREATE PACKAGE \"OWNER\".PKG AS PROCEDURE run; FUNCTION f(x NUMBER) RETURN NUMBER; e EXCEPTION; v NUMBER; END PKG;".into() };
    let analysis = dbx_sql::object_source_sql::analyze_oracle_package_body_draft(EditableObjectSourceSqlInput {
        object_type: db::ObjectSourceKind::PackageBody,
        source: "CREATE PACKAGE BODY \"OWNER\".PKG AS FUNCTION f(x NUMBER) RETURN NUMBER IS BEGIN RETURN x; END f; PROCEDURE run IS n NUMBER; BEGIN DECLARE retired NUMBER; BEGIN NULL; END; SELECT f,e,v,retired INTO n,n,n,n FROM T; END run; END PKG;".into(), ..spec.clone()
    }, spec.clone());
    assert!(analysis.complete, "{:?}", analysis.issues);
    let selected = vec![
        SelectedFinalDraft {
            identity: RoutineIdentity {
                owner: "OWNER".into(),
                name: "PKG".into(),
                kind: db::ObjectSourceKind::PackageBody,
            },
            analysis: Some(analysis),
        },
        package_draft(&spec.source),
    ];
    for missing in [None, Some("F"), Some("E"), Some("RETIRED"), Some("V")] {
        let mut table = Entry::object("OWNER", "T", "TABLE");
        table.columns = ["F", "E", "V", "RETIRED"].into_iter().filter(|column| Some(*column) != missing).collect();
        let catalog =
            Catalog { entries: vec![table, Entry::object("OWNER", "RETIRED", "FUNCTION")], ..Default::default() };
        let result = resolve_draft(&catalog, &endpoint(), &selected, 0).await;
        if missing.is_none() || missing == Some("V") {
            assert!(result.issues.is_empty(), "{missing:?}: {:?}", result.issues);
            assert_eq!(result.references.len(), 1);
        } else {
            assert!(!result.issues.is_empty(), "incorrect fallback for {missing:?}");
        }
    }
}

#[tokio::test]
async fn final_selected_signatures_resolve_zero_argument_values_before_creation_and_self_recursion_is_not_a_cycle() {
    let selected = vec![draft("Caller", "BEGIN RETURN \"Callee\"; END;"), draft("Callee", "BEGIN RETURN 1; END;")];
    let result = resolve_draft(&Catalog::default(), &endpoint(), &selected, 0).await;
    assert!(result.issues.is_empty(), "{:?}", result.issues);
    assert_eq!(result.selected_dependencies, BTreeSet::from([1]));
    let selected = vec![draft("Self", "BEGIN RETURN \"Self\"; END;")];
    let result = resolve_draft(&Catalog::default(), &endpoint(), &selected, 0).await;
    assert!(result.issues.is_empty());
    assert!(result.selected_dependencies.is_empty());
}

#[tokio::test]
async fn final_parameter_defaults_and_out_positions_are_checked_not_only_required_count() {
    let mut callee = draft("Callee", "BEGIN RETURN 1; END;");
    let parameter = |name: &str, mode: &str, has_default| OracleDraftParameter {
        name: dbx_sql::object_source_sql::OracleDraftName { value: name.into(), quoted: false },
        mode: mode.into(),
        data_type: "NUMBER".into(),
        has_default,
        default_expression: None,
    };
    callee.analysis.as_mut().unwrap().parameters = vec![parameter("A", "OUT", false), parameter("B", "IN", true)];
    let selected = vec![draft("Caller", "BEGIN RETURN \"Callee\"(1); END;"), callee.clone()];
    let failed = resolve_draft(&Catalog::default(), &endpoint(), &selected, 0).await;
    assert!(failed.issues[0].message.contains("writable"));
    let selected = vec![draft("Caller", "n NUMBER; BEGIN RETURN \"Callee\"(n); END;"), callee];
    assert!(resolve_draft(&Catalog::default(), &endpoint(), &selected, 0).await.issues.is_empty());
}

#[tokio::test]
async fn sql_columns_bind_before_local_or_selected_function_names_and_aliases_do_not_become_calls() {
    let catalog = Catalog { entries: vec![Entry::object("OWNER", "Base.Table", "TABLE")], ..Default::default() };
    let selected = vec![
        draft(
            "Caller",
            "n NUMBER; BEGIN SELECT a.n INTO n FROM \"OWNER\".\"Base.Table\" a WHERE n = 1; RETURN n; END;",
        ),
        draft("N", "BEGIN RETURN 1; END;"),
    ];
    let result = resolve_draft(&catalog, &endpoint(), &selected, 0).await;
    assert!(result.issues.is_empty(), "{:?}", result.issues);
    assert!(result.selected_dependencies.is_empty());
    assert_eq!(result.references.len(), 1);
    let bad = vec![draft("Caller", "n NUMBER; BEGIN SELECT a.missing INTO n FROM \"Base.Table\" a; RETURN n; END;")];
    assert!(resolve_draft(&catalog, &endpoint(), &bad, 0).await.issues[0].message.contains("column"));
    let incomplete = Catalog { incomplete_columns: true, ..catalog };
    assert!(!resolve_draft(&incomplete, &endpoint(), &selected, 0).await.issues.is_empty());
}

#[tokio::test]
async fn review_regression_sql_scalar_binding_does_not_hide_calls_or_compound_references() {
    let catalog = Catalog { entries: vec![Entry::object("OWNER", "Base.Table", "TABLE")], ..Default::default() };
    for expression in ["f()", "f.member", "f.member()"] {
        let selected = vec![draft(
            "Caller",
            &format!("f NUMBER := 1; n NUMBER; BEGIN SELECT {expression} INTO n FROM \"Base.Table\"; RETURN n; END;"),
        )];
        let result = resolve_draft(&catalog, &endpoint(), &selected, 0).await;
        assert!(!result.issues.is_empty(), "SQL scalar {expression} was accepted as a call/compound reference");
        assert!(result.issues[0].column > 1);
    }
    let selected =
        vec![draft("Caller", "f NUMBER := 1; n NUMBER; BEGIN SELECT f INTO n FROM \"Base.Table\"; RETURN n; END;")];
    let result = resolve_draft(&catalog, &endpoint(), &selected, 0).await;
    assert!(result.issues.is_empty(), "{:?}", result.issues);
    assert!(result.selected_dependencies.is_empty());
}

#[tokio::test]
async fn two_part_package_schema_ambiguity_is_positioned_and_three_part_member_can_continue() {
    let mut package = Entry::object("OWNER", "PKG", "PACKAGE");
    package.member = Some("F");
    package.function = true;
    let mut external = Entry::object("PKG", "F", "FUNCTION");
    external.grant = true;
    let catalog = Catalog { entries: vec![package, external], ..Default::default() };
    let ambiguous = vec![draft("Caller", "BEGIN RETURN pkg.f; END;")];
    let result = resolve_draft(&catalog, &endpoint(), &ambiguous, 0).await;
    assert!(result.issues[0].message.contains("competing"));
    assert!(result.issues[0].column > 1);
    let explicit = vec![draft("Caller", "BEGIN RETURN \"OWNER\".pkg.f; END;")];
    let result = resolve_draft(&catalog, &endpoint(), &explicit, 0).await;
    assert!(result.issues.is_empty(), "{:?}", result.issues);
    assert_eq!(result.references[0].member.as_deref(), Some("F"));
}

#[tokio::test]
async fn private_then_public_synonyms_preserve_precedence_and_remote_cycles_are_blocked() {
    let mut private = Entry::object("OWNER", "S", "SYNONYM");
    private.synonym = Some(("OWNER", "F", None));
    let mut public = Entry::object("PUBLIC", "S", "SYNONYM");
    public.synonym = Some(("OWNER", "Other", None));
    let catalog = Catalog {
        entries: vec![
            private,
            public,
            Entry::object("OWNER", "F", "FUNCTION"),
            Entry::object("OWNER", "Other", "FUNCTION"),
        ],
        ..Default::default()
    };
    let selected = vec![draft("Caller", "BEGIN RETURN s; END;")];
    let result = resolve_draft(&catalog, &endpoint(), &selected, 0).await;
    assert!(result.issues.is_empty());
    assert_eq!(result.references[0].name, "F");
    let mut public_only = Catalog { entries: catalog.entries[1..].to_vec(), ..Default::default() };
    assert_eq!(resolve_draft(&public_only, &endpoint(), &selected, 0).await.references[0].name, "Other");
    public_only.entries[0].synonym = Some(("OWNER", "S", Some("REMOTE")));
    assert!(resolve_draft(&public_only, &endpoint(), &selected, 0).await.issues[0].message.contains("database-link"));
    public_only.entries[0].synonym = Some(("PUBLIC", "S", None));
    assert!(resolve_draft(&public_only, &endpoint(), &selected, 0).await.issues[0].message.contains("cycle"));
}

#[tokio::test]
async fn cross_owner_invisible_namespace_is_unknown_and_role_only_access_is_not_a_direct_grant() {
    let selected = vec![draft("Caller", "BEGIN RETURN other.f; END;")];
    let hidden = Catalog { dba_denied: true, ..Default::default() };
    assert!(resolve_draft(&hidden, &endpoint(), &selected, 0).await.issues[0].message.contains("ORA-00942"));
    let mut catalog = Catalog { entries: vec![Entry::object("OTHER", "F", "FUNCTION")], ..Default::default() };
    assert!(resolve_draft(&catalog, &endpoint(), &selected, 0).await.issues[0].message.contains("privilege"));
    catalog.entries[0].grant = true;
    assert!(resolve_draft(&catalog, &endpoint(), &selected, 0).await.issues.is_empty());
}

#[tokio::test]
async fn dbms_sql_is_blocked_after_synonym_resolution_but_ordinary_strings_are_not_references() {
    let mut alias = Entry::object("OWNER", "ALIAS", "SYNONYM");
    alias.synonym = Some(("OWNER", "DBMS_SQL", None));
    let mut package = Entry::object("OWNER", "DBMS_SQL", "PACKAGE");
    package.member = Some("EXECUTE");
    package.function = true;
    let catalog = Catalog { entries: vec![alias, package], ..Default::default() };
    let selected = vec![draft("Caller", "BEGIN RETURN alias.execute(1); END;")];
    assert!(resolve_draft(&catalog, &endpoint(), &selected, 0).await.issues[0].message.contains("DBMS_SQL"));
    let selected = vec![draft("Caller", "BEGIN RETURN 'EXECUTE IMMEDIATE DBMS_SQL'; END;")];
    assert!(resolve_draft(&catalog, &endpoint(), &selected, 0).await.issues.is_empty());
}

#[tokio::test]
async fn selected_deletion_is_unavailable_and_external_evidence_is_rechecked_before_dispatch() {
    let catalog = Catalog { entries: vec![Entry::object("OWNER", "F", "FUNCTION")], ..Default::default() };
    let selected = vec![draft("Caller", "BEGIN RETURN f; END;")];
    let result = resolve_draft(&catalog, &endpoint(), &selected, 0).await;
    assert!(result.issues.is_empty());
    for proof in &result.proofs {
        proof.verify(&catalog).await.unwrap();
    }
    catalog.changed.store(true, Ordering::SeqCst);
    assert!(result
        .proofs
        .iter()
        .any(|proof| matches!(proof, CatalogReadProof::Query { sql, .. } if sql.contains("ALL_OBJECTS"))));
    let proof = result
        .proofs
        .iter()
        .find(|proof| matches!(proof, CatalogReadProof::Query { sql, .. } if sql.contains("ALL_OBJECTS")))
        .unwrap();
    assert!(proof.verify(&catalog).await.is_err());
    let mut deleted = draft("F", "BEGIN RETURN 1; END;");
    deleted.analysis = None;
    let result = resolve_draft(&Catalog::default(), &endpoint(), &[selected[0].clone(), deleted], 0).await;
    assert!(result.issues[0].message.contains("deletion"));
}

#[tokio::test]
async fn dictionary_in_out_arguments_accept_only_writable_scalars() {
    let mut external = Entry::object("OWNER", "F", "FUNCTION");
    external.parameters = vec![("IN/OUT", false)];
    let catalog = Catalog { entries: vec![external], ..Default::default() };
    let selected = vec![draft("Caller", "n NUMBER; BEGIN RETURN f(n); END;")];
    assert!(resolve_draft(&catalog, &endpoint(), &selected, 0).await.issues.is_empty());
    let selected = vec![draft("Caller", "BEGIN RETURN f(1); END;")];
    assert!(resolve_draft(&catalog, &endpoint(), &selected, 0).await.issues[0].message.contains("writable"));
}
