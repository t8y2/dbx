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

#[async_trait::async_trait]
impl RoutineCatalog for Catalog {
    async fn source(&self, _: &RoutineIdentity) -> Result<SourceReply, String> {
        panic!("Draft resolution must not execute or fetch an implementation body")
    }
    async fn query(&self, sql: &str) -> Result<CatalogReply, String> {
        if sql.contains("LOGIN_OWNER") {
            return Ok(reply(&["LOGIN_OWNER"], vec![vec![json!("OWNER")]]));
        }
        if sql.contains("DBA_OBJECTS") && self.dba_denied {
            return Err("ORA-00942: dictionary unavailable".into());
        }
        let owner = value_after(sql, "OWNER");
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
    assert!(result.proofs.iter().any(|proof| proof.sql.contains("ALL_OBJECTS")));
    let proof = result.proofs.iter().find(|proof| proof.sql.contains("ALL_OBJECTS")).unwrap();
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
