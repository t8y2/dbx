use dbx_sql_schema::native_jobs::native_job_reference_queries;
use dbx_types::native_jobs::*;

fn request(kind: NativeJobReferenceKind) -> NativeJobReferenceListRequest {
    NativeJobReferenceListRequest {
        scope: NativeJobScope { connection_id: "c".into(), database: String::new(), context_id: "context".into() },
        kind,
        schema: None,
        name: None,
        filter: String::new(),
        offset: 0,
        limit: 100,
    }
}

#[test]
fn references_have_exact_owner_name_components_and_current_user_sources_do_not_require_owner_columns() {
    let mut input = request(NativeJobReferenceKind::Program);
    input.schema = Some("Own.er\"One".into());
    input.name = Some("Prog,One's".into());
    let queries = native_job_reference_queries(NativeJobEngine::Oracle, &input).unwrap();
    assert_eq!(queries.len(), 3);
    assert!(queries[0].sql.contains("J.OWNER = 'Own.er\"One'"));
    assert!(queries[0].sql.contains("J.PROGRAM_NAME = 'Prog,One''s'"));
    assert!(queries[2].sql.contains("USER AS DBX_OWNER"));
    assert!(!queries[2].sql.contains("J.OWNER"));
}

#[test]
fn reference_search_is_paged_and_literal_wildcards_cannot_expand_it() {
    let mut input = request(NativeJobReferenceKind::Schedule);
    input.filter = "10%_!".into();
    input.offset = 100;
    let queries = native_job_reference_queries(NativeJobEngine::OceanbaseOracle, &input).unwrap();
    assert_eq!(queries.len(), 2);
    assert!(queries[0].sql.contains("%10!%!_!!%"));
    assert!(queries[0].sql.contains("DBX_ROW_NUM > 100 AND DBX_ROW_NUM <= 201"));
    input.name = Some("Schedule".into());
    assert!(native_job_reference_queries(NativeJobEngine::Oracle, &input).is_err());
}

#[test]
fn program_arguments_require_an_exact_program_and_credentials_do_not_project_login_data() {
    let mut input = request(NativeJobReferenceKind::ProgramArguments);
    assert!(native_job_reference_queries(NativeJobEngine::Oracle, &input).is_err());
    input.schema = Some("Owner".into());
    input.name = Some("Program".into());
    input.limit = 10_000;
    let queries = native_job_reference_queries(NativeJobEngine::Oracle, &input).unwrap();
    assert_eq!(queries[0].source, "SYS.DBA_SCHEDULER_PROGRAM_ARGS");
    assert!(queries[0].sql.contains("J.ARGUMENT_POSITION"));
    for query in &queries {
        assert!(query.sql.contains("J.DEFAULT_ANYDATA_VALUE.GetTypeName()"));
        assert!(query
            .sql
            .contains("TO_CHAR(J.DEFAULT_ANYDATA_VALUE.AccessNumber(), 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,''')"));
        assert!(query.sql.contains("AS DBX_ANYDATA_PRESENT"));
        assert!(query.sql.contains("AS DBX_ANYDATA_IS_NULL"));
        assert!(!query.sql.contains("J.ANYDATA_VALUE"));
    }
    for query in native_job_reference_queries(NativeJobEngine::Dameng, &input).unwrap() {
        assert!(!query.sql.contains("GetTypeName()"));
    }
    let credentials =
        native_job_reference_queries(NativeJobEngine::Oracle, &request(NativeJobReferenceKind::Credential)).unwrap();
    assert_eq!(credentials[0].source, "SYS.DBA_CREDENTIALS");
    assert!(!credentials[0].sql.contains("J.*"));
    assert!(!credentials[0].sql.contains("USERNAME"));
}

#[test]
fn oceanbase_placeholder_argument_views_do_not_authorize_an_empty_argument_list() {
    let mut input = request(NativeJobReferenceKind::ProgramArguments);
    input.schema = Some("Another Owner".into());
    input.name = Some("Program".into());
    let queries = native_job_reference_queries(NativeJobEngine::OceanbaseOracle, &input).unwrap();
    assert!(queries.is_empty());
    let target = NativeJobRef::Scheduler { scope: input.scope, owner: "Owner".into(), name: "Job".into() };
    assert!(dbx_sql_schema::native_jobs::native_job_catalog_queries(
        NativeJobEngine::OceanbaseOracle,
        &target,
        dbx_sql_schema::native_jobs::NativeJobCatalogPart::Arguments,
    )
    .unwrap()
    .is_empty());
    assert!(native_job_reference_queries(NativeJobEngine::Dameng, &request(NativeJobReferenceKind::Chain))
        .unwrap()
        .is_empty());
}

#[test]
fn oceanbase_programs_use_the_documented_native_singular_view_not_oracle_names() {
    let input = request(NativeJobReferenceKind::Program);
    let queries = native_job_reference_queries(NativeJobEngine::OceanbaseOracle, &input).unwrap();
    assert_eq!(queries.len(), 1);
    assert_eq!(queries[0].source, "SYS.DBA_SCHEDULER_PROGRAM");
    assert_eq!(queries[0].coverage, NativeJobCatalogCoverage::Database);
    assert!(queries[0].sql.contains("J.OWNER AS DBX_OWNER"));
    assert!(queries[0].sql.contains("J.PROGRAM_NAME AS DBX_NAME"));
    assert!(!queries[0].sql.contains("SCHEDULER_PROGRAMS"));
}

#[test]
fn oracle_reference_categories_keep_their_native_sources_names_and_group_filters() {
    for (kind, source, name_column, group_filter, count) in [
        ("window", "SYS.DBA_SCHEDULER_WINDOWS", "WINDOW_NAME", None, 2),
        ("window-group", "SYS.DBA_SCHEDULER_GROUPS", "GROUP_NAME", Some("J.GROUP_TYPE = 'WINDOW'"), 3),
        ("file-watcher", "SYS.DBA_SCHEDULER_FILE_WATCHERS", "FILE_WATCHER_NAME", None, 3),
        (
            "destination-group",
            "SYS.DBA_SCHEDULER_GROUPS",
            "GROUP_NAME",
            Some("J.GROUP_TYPE IN ('DB_DEST', 'EXTERNAL_DEST')"),
            3,
        ),
    ] {
        let mut input = request(serde_json::from_value(serde_json::json!(kind)).unwrap());
        input.schema = Some("Own.er".into());
        input.name = Some("Exact,Name's".into());
        let queries = native_job_reference_queries(NativeJobEngine::Oracle, &input).unwrap();
        assert_eq!(queries.len(), count);
        assert_eq!(queries[0].source, source);
        assert!(queries[0].sql.contains("J.OWNER = 'Own.er'"));
        assert!(queries[0].sql.contains(&format!("J.{name_column} = 'Exact,Name''s'")));
        if let Some(filter) = group_filter {
            assert!(queries.iter().all(|query| query.sql.contains(filter)));
        }
        if count == 3 {
            assert!(queries[2].sql.contains("USER AS DBX_OWNER"));
            assert!(!queries[2].sql.contains("J.OWNER"));
        }
        for engine in [NativeJobEngine::OceanbaseOracle, NativeJobEngine::Dameng] {
            assert!(native_job_reference_queries(engine, &input).unwrap().is_empty());
        }
    }
}

#[test]
fn oracle_unified_destination_view_is_reused_without_reading_connection_details() {
    let queries =
        native_job_reference_queries(NativeJobEngine::Oracle, &request(NativeJobReferenceKind::Destination)).unwrap();
    assert_eq!(queries.len(), 3);
    assert_eq!(queries[0].source, "SYS.DBA_SCHEDULER_DESTS");
    assert!(!queries[0].sql.contains("SCHEDULER_DB_DESTS"));
    assert!(!queries[0].sql.contains("CONNECT_INFO"));
}
