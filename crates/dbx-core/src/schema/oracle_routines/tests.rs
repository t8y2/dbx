use super::*;
use serde_json::json;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Mutex,
};

const BODY: &str = "FUNCTION \"Quoted.Func\" RETURN VARCHAR2 IS BEGIN RETURN 'a  b'; END";

struct PackageCatalog {
    inner: FakeCatalog,
    fail_body: bool,
    change_spec_during_body: bool,
    spec_changed: AtomicBool,
}

impl PackageCatalog {
    fn new() -> Self {
        Self {
            inner: FakeCatalog {
                objects: vec![
                    object_row(12, "Pkg.With.Dot", "PACKAGE"),
                    object_row(13, "Pkg.With.Dot", "PACKAGE BODY"),
                ],
                ..Default::default()
            },
            fail_body: false,
            change_spec_during_body: false,
            spec_changed: AtomicBool::new(false),
        }
    }

    fn body(kind: &db::ObjectSourceKind) -> String {
        format!("{} \"Pkg.With.Dot\" AS END;", kind_name(kind))
    }
}

#[async_trait::async_trait]
impl RoutineCatalog for PackageCatalog {
    async fn query(&self, sql: &str) -> Result<CatalogReply, String> {
        if sql.contains("SOURCE_ROWS") {
            self.inner.queries.lock().unwrap().push(sql.into());
            let kind = if sql.contains("TYPE = 'PACKAGE BODY'") {
                db::ObjectSourceKind::PackageBody
            } else {
                db::ObjectSourceKind::Package
            };
            let body = Self::body(&kind);
            return Ok(reply(
                &["SOURCE_ROWS", "FIRST_LINE", "LAST_LINE", "SOURCE_CHARS", "HEAD_TRIM", "TAIL_TRIM", "SOURCE_HEAD"],
                vec![vec![
                    json!(1),
                    json!(1),
                    json!(1),
                    json!(body.chars().count()),
                    json!(0),
                    json!(0),
                    json!(kind_name(&kind)),
                ]],
                &json!({}),
            ));
        }
        self.inner.query(sql).await
    }

    async fn source(&self, identity: &RoutineIdentity) -> Result<SourceReply, String> {
        if self.fail_body && identity.kind == db::ObjectSourceKind::PackageBody {
            return Err("body source permission denied".into());
        }
        self.inner.source_calls.fetch_add(1, Ordering::SeqCst);
        if self.change_spec_during_body && identity.kind == db::ObjectSourceKind::PackageBody {
            self.spec_changed.store(true, Ordering::SeqCst);
        }
        let mut body = Self::body(&identity.kind);
        if self.change_spec_during_body
            && identity.kind == db::ObjectSourceKind::Package
            && self.spec_changed.load(Ordering::SeqCst)
        {
            body = body.replace("AS END;", "AS c CONSTANT NUMBER := 2; END;");
        }
        Ok(serde_json::from_value(json!({"name":identity.name,"schema":identity.owner,"object_type":identity.kind,"source":format!("CREATE OR REPLACE {body}"),"source_origin":"oceanbase-dictionary"})).unwrap())
    }
}

#[tokio::test]
async fn same_second_specification_change_during_body_read_does_not_make_a_mixed_pair_complete() {
    let catalog = PackageCatalog { change_spec_during_body: true, ..PackageCatalog::new() };
    let options = RoutineReadOptions {
        object_kinds: Some(vec![db::ObjectSourceKind::Package, db::ObjectSourceKind::PackageBody]),
        ..Default::default()
    };
    let snapshot =
        collect_snapshot_with_options(&catalog, endpoint(), SourceOrigin::OceanBaseDictionary, &options).await;
    assert_eq!(snapshot.state, RoutineReadState::Partial);
    assert!(snapshot.enumeration_complete, "the catalog IDs and second-resolution DDL times did not change");
    let specification =
        snapshot.objects.iter().find(|object| object.version.identity.kind == db::ObjectSourceKind::Package).unwrap();
    assert!(!specification.source_complete);
    assert!(specification.source.as_ref().unwrap().ends_with("AS END;"), "retain the original text for review");
    assert!(specification.issues.iter().any(|issue| issue.message.contains("changed")));
}

#[tokio::test]
async fn typed_body_selection_reads_the_pair_without_adding_a_specification_selection() {
    let catalog = PackageCatalog::new();
    let selected = RoutineSelection { name: "Pkg.With.Dot".into(), kind: db::ObjectSourceKind::PackageBody };
    let options = RoutineReadOptions {
        object_kinds: Some(vec![db::ObjectSourceKind::PackageBody]),
        selected_objects: Some(vec![selected.clone()]),
        ..Default::default()
    };
    options.validate().unwrap();
    let snapshot =
        collect_snapshot_with_options(&catalog, endpoint(), SourceOrigin::OceanBaseDictionary, &options).await;
    assert_eq!(snapshot.state, RoutineReadState::Complete);
    assert_eq!(snapshot.objects.len(), 2);
    assert_eq!(snapshot.objects[0].version.identity.kind, db::ObjectSourceKind::Package);
    assert_eq!(snapshot.objects[1].version.identity.kind, db::ObjectSourceKind::PackageBody);
    assert!(snapshot.objects.iter().all(|object| object.source_complete && object.dependencies_complete));
    assert!(snapshot.objects.iter().all(|object| object.source_origin == Some(SourceOrigin::OceanBaseDictionary)));
    assert_eq!(serde_json::to_value(&snapshot).unwrap()["objects"][0]["sourceOrigin"], "oceanbase-dictionary");
    assert_eq!(catalog.inner.source_calls.load(Ordering::SeqCst), 4);
    assert_eq!(options.selected_objects, Some(vec![selected]));
    assert!(catalog
        .inner
        .queries
        .lock()
        .unwrap()
        .iter()
        .filter(|sql| sql.contains("OBJECT_ID >"))
        .all(|sql| sql.contains("'PACKAGE BODY'") && sql.contains("'PACKAGE'")));
}

#[tokio::test]
async fn typed_standalone_selection_enriches_the_other_kind_as_read_only_conflict_evidence() {
    let catalog = FakeCatalog::default();
    let selected = RoutineSelection { name: "Quoted.Func".into(), kind: db::ObjectSourceKind::Procedure };
    let options = RoutineReadOptions { selected_objects: Some(vec![selected.clone()]), ..Default::default() };
    options.validate().unwrap();
    let snapshot =
        collect_snapshot_with_options(&catalog, endpoint(), SourceOrigin::OceanBaseDictionary, &options).await;
    assert_eq!(snapshot.state, RoutineReadState::Complete);
    assert_eq!(snapshot.objects[0].version.identity.kind, db::ObjectSourceKind::Function);
    assert!(snapshot.objects[0].source_complete);
    assert_eq!(options.selected_objects, Some(vec![selected]));
}

#[tokio::test]
async fn a_failed_body_read_retains_both_exact_objects_without_inventing_absence() {
    let catalog = PackageCatalog { fail_body: true, ..PackageCatalog::new() };
    let options = RoutineReadOptions {
        object_kinds: Some(vec![db::ObjectSourceKind::Package, db::ObjectSourceKind::PackageBody]),
        ..Default::default()
    };
    let snapshot =
        collect_snapshot_with_options(&catalog, endpoint(), SourceOrigin::OceanBaseDictionary, &options).await;
    assert_eq!(snapshot.state, RoutineReadState::Partial);
    assert!(snapshot.enumeration_complete);
    assert_eq!(snapshot.objects.len(), 2);
    assert!(snapshot.objects[0].source_complete);
    assert!(!snapshot.objects[1].source_complete);
    assert!(!snapshot.objects[1].issues.is_empty());
}

#[test]
fn legacy_inventory_remains_procedure_function_only_and_new_selections_are_explicit() {
    let options = RoutineReadOptions::default();
    options.validate().unwrap();
    let sql = inventory_sql("Owner.Mixed", false, 0, &options.inventory_kinds());
    assert!(sql.contains("IN ('PROCEDURE', 'FUNCTION')"));
    assert!(!sql.contains("'PACKAGE'"));
    let package = vec![db::ObjectSourceKind::Package];
    assert!(RoutineReadOptions {
        object_kinds: Some(package),
        selected_routines: Some(vec!["Pkg.With.Dot".into()]),
        ..Default::default()
    }
    .validate()
    .is_err());
    assert!(RoutineReadOptions { object_kinds: Some(vec![db::ObjectSourceKind::View]), ..Default::default() }
        .validate()
        .is_err());
    assert!(RoutineReadOptions {
        selected_objects: Some(vec![RoutineSelection { name: "P".into(), kind: db::ObjectSourceKind::Package }]),
        ..Default::default()
    }
    .validate()
    .is_err());
    let decoded: RoutineReadOptions = serde_json::from_value(json!({"objectKinds":["PACKAGE","PACKAGE_BODY"],"selectedObjects":[{"name":"Pkg.With.Dot","kind":"PACKAGE_BODY"}]})).unwrap();
    decoded.validate().unwrap();
    assert_eq!(decoded.selected_objects.unwrap()[0].kind, db::ObjectSourceKind::PackageBody);
}

#[tokio::test]
async fn package_source_checks_the_reported_metadata_origin_and_exact_metadata_kind() {
    for (kind, keyword, metadata_kind) in [
        (db::ObjectSourceKind::Package, "PACKAGE", "PACKAGE_SPEC"),
        (db::ObjectSourceKind::PackageBody, "PACKAGE BODY", "PACKAGE_BODY"),
    ] {
        let source = format!("CREATE OR REPLACE {keyword} \"P\" AS c CONSTANT VARCHAR2(10) := q'[中文😀]'; END;");
        let catalog = FakeCatalog { length: source.chars().count() as u64, ..Default::default() };
        let identity = RoutineIdentity { owner: "Owner.Mixed".into(), name: "P".into(), kind };
        let reply: SourceReply = serde_json::from_value(json!({"name":"P","schema":"Owner.Mixed","object_type":identity.kind,"source":source,"source_origin":"oracle-metadata"})).unwrap();
        let result = check_source(&catalog, &endpoint(), &identity, &reply, SourceOrigin::OceanBaseDictionary).await;
        assert!(result.is_ok(), "metadata fallback must use its own source evidence: {result:?}");
        assert!(catalog.queries.lock().unwrap().iter().any(|sql| sql.contains(&format!("GET_DDL('{metadata_kind}'"))));
    }
}

#[tokio::test]
async fn package_source_without_actual_origin_cannot_be_marked_complete() {
    let body = "PACKAGE \"P\" AS END;";
    let catalog = FakeCatalog { length: body.chars().count() as u64, ..Default::default() };
    let identity =
        RoutineIdentity { owner: "Owner.Mixed".into(), name: "P".into(), kind: db::ObjectSourceKind::Package };
    let reply: SourceReply = serde_json::from_value(
        json!({"name":"P","schema":"Owner.Mixed","object_type":"PACKAGE","source":format!("CREATE OR REPLACE {body}")}),
    )
    .unwrap();
    assert!(check_source(&catalog, &endpoint(), &identity, &reply, SourceOrigin::OceanBaseDictionary).await.is_err());
}

struct FakeCatalog {
    login: String,
    objects: Vec<Vec<Value>>,
    source: String,
    source_flags: Value,
    query_flags: Value,
    flag_stage: &'static str,
    source_error: bool,
    source_mismatch: bool,
    source_changes: bool,
    inventory_changes: bool,
    fail_second_page: bool,
    deny_dba: bool,
    length: u64,
    source_calls: AtomicUsize,
    inventory_calls: AtomicUsize,
    queries: Mutex<Vec<String>>,
}

impl Default for FakeCatalog {
    fn default() -> Self {
        Self {
            login: "Owner.Mixed".into(),
            objects: vec![object_row(1, "Quoted.Func", "FUNCTION")],
            source: format!("CREATE OR REPLACE {BODY}"),
            source_flags: json!({}),
            query_flags: json!({}),
            flag_stage: "",
            source_error: false,
            source_mismatch: false,
            source_changes: false,
            inventory_changes: false,
            fail_second_page: false,
            deny_dba: false,
            length: BODY.chars().count() as u64,
            source_calls: AtomicUsize::new(0),
            inventory_calls: AtomicUsize::new(0),
            queries: Mutex::new(Vec::new()),
        }
    }
}

fn object_row(id: u64, name: &str, kind: &str) -> Vec<Value> {
    vec![json!("Owner.Mixed"), json!(name), json!(kind), json!(id), json!("VALID"), json!("2026-10-21T08:30:00")]
}

fn reply(columns: &[&str], rows: Vec<Vec<Value>>, flags: &Value) -> CatalogReply {
    let mut value = flags.clone();
    value["columns"] = json!(columns);
    value["rows"] = json!(rows);
    serde_json::from_value(value).unwrap()
}

#[async_trait::async_trait]
impl RoutineCatalog for FakeCatalog {
    async fn query(&self, sql: &str) -> Result<CatalogReply, String> {
        self.queries.lock().unwrap().push(sql.into());
        let (stage, columns, mut rows) = if sql.contains("LOGIN_OWNER") {
            ("visibility", vec!["LOGIN_OWNER"], vec![vec![json!(self.login)]])
        } else if sql.contains("OBJECT_ID >") {
            if sql.contains("SYS.DBA_OBJECTS") && self.deny_dba {
                return Err("ORA-00942: table or view does not exist".into());
            }
            let after = sql.split("OBJECT_ID > ").nth(1).unwrap().split(' ').next().unwrap().parse::<u64>().unwrap();
            if self.fail_second_page && after > 0 {
                return Err("metadata connection lost on next page".into());
            }
            let call = self.inventory_calls.fetch_add(1, Ordering::SeqCst);
            let mut all = self.objects.clone();
            if self.inventory_changes && call > 0 {
                all.push(object_row(2, "Appeared.Proc", "PROCEDURE"));
            }
            let rows = all.into_iter().filter(|row| row[3].as_u64().unwrap() > after).take(PAGE_SIZE).collect();
            ("inventory", vec!["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID", "STATUS", "LAST_DDL_TIME"], rows)
        } else if sql.contains("SOURCE_ROWS") {
            (
                "length",
                vec!["SOURCE_ROWS", "FIRST_LINE", "LAST_LINE", "SOURCE_CHARS", "HEAD_TRIM", "TAIL_TRIM", "SOURCE_HEAD"],
                vec![vec![
                    json!(1),
                    json!(1),
                    json!(1),
                    json!(self.length),
                    json!(0),
                    json!(0),
                    json!(BODY.chars().take(18).collect::<String>()),
                ]],
            )
        } else if sql.contains("DBMS_METADATA.GET_DDL") {
            ("length", vec!["SOURCE_CHARS"], vec![vec![json!(self.length)]])
        } else if sql.contains("ALL_DEPENDENCIES") {
            (
                "dependencies",
                vec![
                    "REFERENCED_OWNER",
                    "REFERENCED_NAME",
                    "REFERENCED_TYPE",
                    "REFERENCED_LINK_NAME",
                    "DEPENDENCY_TYPE",
                    "RN",
                ],
                vec![],
            )
        } else {
            panic!("unexpected catalog query");
        };
        let empty_flags = json!({});
        let flags = if stage == self.flag_stage { &self.query_flags } else { &empty_flags };
        // A managed error can have no metadata-shaped rows; consumers must not
        // turn that response into a successful empty catalog.
        if flags.get("execution_error") == Some(&json!(true)) {
            rows.clear();
        }
        Ok(reply(&columns, rows, flags))
    }

    async fn source(&self, identity: &RoutineIdentity) -> Result<SourceReply, String> {
        let call = self.source_calls.fetch_add(1, Ordering::SeqCst);
        if self.source_error {
            return Err("source read denied".into());
        }
        let mut value = self.source_flags.clone();
        value["name"] = json!(if self.source_mismatch { "Other.Func" } else { &identity.name });
        value["schema"] = json!(identity.owner);
        value["object_type"] = json!(identity.kind);
        let text = if self.objects.len() > 1 {
            format!("CREATE OR REPLACE FUNCTION \"{}\" RETURN NUMBER IS BEGIN RETURN 1; END", identity.name)
        } else if self.source_changes && call > 0 {
            self.source.replace("a  b", "changed")
        } else {
            self.source.clone()
        };
        value["source"] = json!(text);
        Ok(serde_json::from_value(value).unwrap())
    }
}

fn endpoint() -> RoutineEndpoint {
    RoutineEndpoint {
        connection_id: "test-source".into(),
        database: "tenant".into(),
        schema: "Owner.Mixed".into(),
        database_type: DatabaseType::OceanbaseOracle,
        generation: 7,
    }
}

async fn collect(catalog: &FakeCatalog) -> RoutineSnapshot {
    collect_snapshot(catalog, endpoint(), SourceOrigin::OceanBaseDictionary).await
}

#[tokio::test]
async fn explicit_selection_enriches_only_exact_names_and_retains_complete_paged_inventory() {
    let name = "lower.Dot,Name";
    let source = format!("CREATE OR REPLACE FUNCTION \"{name}\" RETURN NUMBER IS BEGIN RETURN 1; END");
    let mut objects = (1..=600).map(|id| object_row(id, &format!("Other{id}"), "FUNCTION")).collect::<Vec<_>>();
    objects.push(object_row(601, name, "FUNCTION"));
    let catalog = FakeCatalog { objects, length: source.encode_utf16().count() as u64, ..Default::default() };
    let snapshot =
        collect_selected_snapshot(&catalog, endpoint(), SourceOrigin::OracleMetadata, Some(&[name.into()])).await;
    assert!(snapshot.enumeration_complete);
    assert_eq!(snapshot.objects.len(), 601);
    assert_eq!(catalog.inventory_calls.load(Ordering::SeqCst), 6);
    assert_eq!(catalog.source_calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        snapshot.objects.iter().filter(|object| object.source_complete && object.dependencies_complete).count(),
        1
    );
    let selected = snapshot.objects.iter().find(|object| object.version.identity.name == name).unwrap();
    assert_eq!(selected.source.as_deref(), Some(source.as_str()));
    let queries = catalog.queries.lock().unwrap();
    assert_eq!(queries.iter().filter(|sql| sql.contains("DBMS_METADATA.GET_DDL")).count(), 1);
    assert_eq!(queries.iter().filter(|sql| sql.contains("ALL_DEPENDENCIES")).count(), 1);
    assert_eq!(snapshot.state, RoutineReadState::Partial);
}

#[tokio::test]
async fn empty_or_absent_selection_keeps_inventory_without_reading_definitions() {
    for names in [Vec::new(), vec!["quoted.func".into()], vec!["Missing".into()]] {
        let catalog = FakeCatalog::default();
        let snapshot =
            collect_selected_snapshot(&catalog, endpoint(), SourceOrigin::OceanBaseDictionary, Some(&names)).await;
        assert!(snapshot.enumeration_complete);
        assert_eq!(snapshot.objects.len(), 1);
        assert_eq!(snapshot.objects[0].version.identity.name, "Quoted.Func");
        assert!(!snapshot.objects[0].source_complete);
        assert_eq!(catalog.source_calls.load(Ordering::SeqCst), 0);
        assert_eq!(catalog.queries.lock().unwrap().len(), 3);
    }
}

#[tokio::test]
async fn scoped_reads_do_not_turn_failed_inventory_pagination_into_absence() {
    let catalog = FakeCatalog {
        objects: (1..=PAGE_SIZE as u64).map(|id| object_row(id, &format!("Other{id}"), "PROCEDURE")).collect(),
        fail_second_page: true,
        ..Default::default()
    };
    let snapshot =
        collect_selected_snapshot(&catalog, endpoint(), SourceOrigin::OceanBaseDictionary, Some(&["Missing".into()]))
            .await;
    assert!(!snapshot.enumeration_complete);
    assert_eq!(snapshot.objects.len(), PAGE_SIZE);
    assert_eq!(catalog.source_calls.load(Ordering::SeqCst), 0);
    assert_eq!(snapshot.state, RoutineReadState::Partial);
}

#[tokio::test]
async fn exact_quoted_identity_keeps_raw_body_and_validates_without_final_semicolon() {
    let catalog = FakeCatalog::default();
    let snapshot = collect(&catalog).await;
    assert_eq!(snapshot.state, RoutineReadState::Complete);
    assert!(snapshot.enumeration_complete);
    assert_eq!(snapshot.objects[0].version.identity.name, "Quoted.Func");
    assert_eq!(snapshot.objects[0].source.as_deref(), Some(catalog.source.as_str()));
    assert!(!snapshot.objects[0].source.as_ref().unwrap().ends_with(';'));
    assert!(snapshot.objects[0].dependencies_complete);
    assert!(!catalog.queries.lock().unwrap().iter().any(|sql| sql.contains("DBA_")));
}

#[tokio::test]
async fn failed_source_keeps_the_inventory_object_instead_of_implying_deletion() {
    let catalog = FakeCatalog { source_error: true, ..Default::default() };
    let snapshot = collect(&catalog).await;
    assert_eq!(snapshot.state, RoutineReadState::Partial);
    assert!(snapshot.enumeration_complete);
    assert_eq!(snapshot.objects.len(), 1);
    assert!(snapshot.objects[0].source.is_none());
    assert!(!snapshot.objects[0].source_complete);
    assert_eq!(snapshot.objects[0].issues[0].message, "source read denied");
}

#[tokio::test]
async fn partial_response_flags_are_not_successful_empty_results() {
    for flag in [
        json!({"execution_error":true}),
        json!({"truncated":true}),
        json!({"hasMore":true}),
        json!({"largeValueCells":[{"row_index":0}]}),
        json!({"messages":[{"severity":"ERROR","message":"denied"}]}),
    ] {
        let catalog = FakeCatalog { flag_stage: "inventory", query_flags: flag, ..Default::default() };
        let snapshot = collect(&catalog).await;
        assert_ne!(snapshot.state, RoutineReadState::Complete);
        assert!(!snapshot.enumeration_complete);
        assert!(!snapshot.issues.is_empty());
    }
}

#[tokio::test]
async fn source_flags_or_wrong_identity_keep_read_text_but_do_not_verify_it() {
    for flag in [
        json!({"executionError":true}),
        json!({"truncated":true}),
        json!({"has_more":true}),
        json!({"large_value_cells":[{}]}),
    ] {
        let catalog = FakeCatalog { source_flags: flag, ..Default::default() };
        let snapshot = collect(&catalog).await;
        assert_eq!(snapshot.objects[0].source.as_deref(), Some(catalog.source.as_str()));
        assert!(!snapshot.objects[0].source_complete);
    }
    let catalog = FakeCatalog { source_mismatch: true, ..Default::default() };
    assert!(!collect(&catalog).await.objects[0].source_complete);
}

#[tokio::test]
async fn unicode_length_uses_the_actual_source_origin_not_utf8_bytes_or_ob_utf16_units() {
    let body = BODY.replace("a  b", "中文🧪  文本");
    let catalog = FakeCatalog {
        source: format!("CREATE OR REPLACE {body}"),
        length: body.chars().count() as u64,
        ..Default::default()
    };
    assert_eq!(collect(&catalog).await.state, RoutineReadState::Complete);
    let wrong = FakeCatalog { length: body.encode_utf16().count() as u64, ..catalog };
    assert!(!collect(&wrong).await.objects[0].source_complete);
}

#[tokio::test]
async fn native_dictionary_and_jdbc_metadata_use_distinct_character_units() {
    let body = BODY.replace("a  b", "中文🧪");
    let mut ep = endpoint();
    ep.database_type = DatabaseType::Oracle;
    let native = FakeCatalog { source: body.clone(), length: body.chars().count() as u64, ..Default::default() };
    assert_eq!(
        collect_snapshot(&native, ep.clone(), SourceOrigin::OracleDictionary).await.state,
        RoutineReadState::Complete
    );
    assert!(native.queries.lock().unwrap().iter().any(|sql| sql.contains("SUM(LENGTH4(TEXT))")));
    let source = format!("CREATE OR REPLACE {body}");
    let jdbc =
        FakeCatalog { source: source.clone(), length: source.encode_utf16().count() as u64, ..Default::default() };
    assert_eq!(collect_snapshot(&jdbc, ep, SourceOrigin::OracleMetadata).await.state, RoutineReadState::Complete);
    assert!(!jdbc.queries.lock().unwrap().iter().any(|sql| sql.contains("ALL_SOURCE")));
}

#[tokio::test]
async fn same_second_source_replacement_is_not_a_complete_snapshot() {
    let catalog = FakeCatalog { source_changes: true, ..Default::default() };
    let snapshot = collect(&catalog).await;
    assert_eq!(snapshot.objects[0].source.as_deref(), Some(catalog.source.as_str()));
    assert!(!snapshot.objects[0].source_complete);
    assert!(snapshot.objects[0].issues.iter().any(|issue| issue.message.contains("changed")));
}

#[tokio::test]
async fn inventory_change_preserves_new_and_old_objects_without_inferring_absence() {
    let catalog = FakeCatalog { inventory_changes: true, ..Default::default() };
    let snapshot = collect(&catalog).await;
    assert!(!snapshot.enumeration_complete);
    assert_eq!(snapshot.objects.len(), 2);
    assert_eq!(snapshot.objects[1].version.identity.kind, db::ObjectSourceKind::Procedure);
    assert!(!snapshot.objects[1].source_complete);
}

#[tokio::test]
async fn other_owner_visible_subset_never_claims_complete_namespace() {
    let catalog = FakeCatalog { login: "OTHER_OWNER".into(), deny_dba: true, ..Default::default() };
    let snapshot = collect(&catalog).await;
    assert_eq!(snapshot.objects.len(), 1);
    assert!(snapshot.objects[0].source_complete);
    assert!(!snapshot.enumeration_complete);
    assert_eq!(snapshot.issues[0].code, "permission-denied");
}

#[tokio::test]
async fn inventory_pages_by_object_id_and_retains_previous_page_on_failure() {
    let objects = (1..=PAGE_SIZE as u64 + 1).map(|id| object_row(id, &format!("F{id:03}"), "FUNCTION")).collect();
    let catalog = FakeCatalog { objects, source_error: true, ..Default::default() };
    let snapshot = collect(&catalog).await;
    assert!(snapshot.enumeration_complete);
    assert_eq!(snapshot.objects.len(), PAGE_SIZE + 1);
    assert!(catalog.queries.lock().unwrap().iter().any(|sql| sql.contains("OBJECT_ID > 256")));
    let partial = FakeCatalog { fail_second_page: true, ..catalog };
    let snapshot = collect(&partial).await;
    assert!(!snapshot.enumeration_complete);
    assert_eq!(snapshot.objects.len(), PAGE_SIZE);
}

#[tokio::test]
async fn successful_empty_owner_catalog_is_distinct_from_query_error() {
    let empty = FakeCatalog { objects: vec![], ..Default::default() };
    let snapshot = collect(&empty).await;
    assert_eq!(snapshot.state, RoutineReadState::Complete);
    assert!(snapshot.enumeration_complete && snapshot.objects.is_empty());
    let denied =
        FakeCatalog { flag_stage: "inventory", query_flags: json!({"execution_error":true}), ..Default::default() };
    let snapshot = collect(&denied).await;
    assert!(!snapshot.enumeration_complete && snapshot.objects.is_empty());
    assert_ne!(snapshot.state, RoutineReadState::Complete);
}

#[tokio::test]
async fn endpoint_change_invalidates_each_definition_as_well_as_absence_inference() {
    let catalog = FakeCatalog::default();
    let mut snapshot = collect(&catalog).await;
    invalidate_snapshot_endpoint(&mut snapshot);
    assert!(!snapshot.enumeration_complete);
    assert!(!snapshot.objects[0].source_complete && !snapshot.objects[0].dependencies_complete);
    assert_eq!(snapshot.objects[0].source.as_deref(), Some(catalog.source.as_str()));
}
