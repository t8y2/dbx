use dbx_sql_schema::native_jobs::{
    native_job_catalog_queries, native_job_definition_queries, native_job_list_queries, NativeJobCatalogDialect,
    NativeJobCatalogPart,
};
use dbx_types::native_jobs::{NativeJobKind, NativeJobRef, NativeJobScope};

fn scheduler(owner: &str, name: &str) -> NativeJobRef {
    NativeJobRef::Scheduler {
        scope: NativeJobScope {
            connection_id: "connection".to_string(),
            database: "database".to_string(),
            context_id: "backend-context".to_string(),
        },
        owner: owner.to_string(),
        name: name.to_string(),
    }
}

#[test]
fn dm_legacy_definition_is_an_independent_exact_id_partition() {
    let target = NativeJobRef::Legacy {
        scope: scheduler("Owner", "Job").scope().clone(),
        job_id: "900719925474099312345".into(),
    };
    let native = native_job_definition_queries(NativeJobCatalogDialect::Dameng, &target).unwrap();
    assert_eq!(native[0].source, "SYSJOB.SYSJOBS");
    assert!(native[0].sql.contains("J.SYS_FLAG = 2"));
    let legacy =
        native_job_catalog_queries(NativeJobCatalogDialect::Dameng, &target, NativeJobCatalogPart::NativeAttributes)
            .unwrap();
    assert_eq!(legacy.len(), 2);
    assert_eq!(legacy[0].source, "SYSJOB.DBA_JOBS");
    assert_eq!(legacy[1].source, "SYSJOB.USER_JOBS");
    for query in legacy {
        assert_eq!(
            query.sql,
            format!(
                "SELECT J.*, CAST(J.JOB AS VARCHAR(40)) AS DBX_JOB_ID FROM {} J WHERE J.JOB = 900719925474099312345",
                query.source
            )
        );
        assert_eq!(query.limit, 1);
        assert!(!query.sql.contains("JOIN"));
        assert!(!query.sql.contains("TO_TIMESTAMP"));
    }
    let native_target =
        NativeJobRef::DamengNative { scope: target.scope().clone(), job_id: "41".into(), name: "Job".into() };
    assert!(native_job_catalog_queries(
        NativeJobCatalogDialect::Dameng,
        &native_target,
        NativeJobCatalogPart::NativeAttributes
    )
    .unwrap()
    .is_empty());
}

#[test]
fn selected_scheduler_reads_preserve_exact_owner_and_name_as_literals() {
    let target = scheduler("Owner.With.Dot", "J'ob,Two");
    let queries = native_job_definition_queries(NativeJobCatalogDialect::OceanbaseOracle, &target).unwrap();
    assert_eq!(queries.len(), 2);
    assert_eq!(queries[0].source, "SYS.DBA_SCHEDULER_JOBS");
    assert_eq!(
        queries[0].sql,
        "SELECT J.* FROM SYS.DBA_SCHEDULER_JOBS J WHERE J.OWNER = 'Owner.With.Dot' AND J.JOB_NAME = 'J''ob,Two'"
    );
    assert_eq!(queries[1].source, "SYS.USER_SCHEDULER_JOBS");
    assert_eq!(queries[1].sql, "SELECT J.*, USER AS DBX_OWNER FROM SYS.USER_SCHEDULER_JOBS J WHERE USER = 'Owner.With.Dot' AND J.JOB_NAME = 'J''ob,Two'");
}

#[test]
fn own_scheduler_sections_do_not_require_the_omitted_owner_column() {
    let target = scheduler("Owner", "Job");
    for part in [NativeJobCatalogPart::Arguments, NativeJobCatalogPart::Running, NativeJobCatalogPart::History] {
        let queries = native_job_catalog_queries(NativeJobCatalogDialect::Oracle, &target, part).unwrap();
        assert_eq!(queries.len(), 3);
        let own = queries.last().unwrap();
        assert!(own.sql.contains("USER AS DBX_OWNER"));
        assert!(own.sql.contains("WHERE USER = 'Owner' AND J.JOB_NAME = 'Job'"));
        assert!(!own.sql.contains("J.OWNER"));
    }
}

#[test]
fn oceanbase_generation_uses_real_positive_job_identity_not_guard_rows() {
    let target = scheduler("Owner", "J'ob");
    let queries =
        native_job_catalog_queries(NativeJobCatalogDialect::OceanbaseOracle, &target, NativeJobCatalogPart::Generation)
            .unwrap();
    assert_eq!(queries.len(), 1);
    assert_eq!(queries[0].sql, "SELECT DISTINCT TO_CHAR(JOB) AS DBX_JOB_ID, TO_CHAR(GMT_CREATE, 'YYYY-MM-DD HH24:MI:SS.FF6') AS DBX_CREATED_AT FROM SYS.ALL_VIRTUAL_TENANT_SCHEDULER_JOB_REAL_AGENT WHERE POWNER = 'Owner' AND JOB_NAME = 'J''ob' AND JOB > 0");
}

#[test]
fn oceanbase_native_definition_attributes_are_identity_bound_but_separate_from_generation() {
    let target = scheduler("Owner.With.Dot", "J'ob");
    let queries = native_job_catalog_queries(
        NativeJobCatalogDialect::OceanbaseOracle,
        &target,
        NativeJobCatalogPart::NativeAttributes,
    )
    .unwrap();
    assert_eq!(queries.len(), 1);
    assert_eq!(queries[0].limit, 1);
    assert!(queries[0].sql.contains("POWNER AS DBX_OWNER, JOB_NAME, MAX_FAILURES"));
    assert!(queries[0].sql.contains("WHERE POWNER = 'Owner.With.Dot' AND JOB_NAME = 'J''ob' AND JOB > 0"));
    for dialect in [NativeJobCatalogDialect::Oracle, NativeJobCatalogDialect::Dameng] {
        assert!(native_job_catalog_queries(dialect, &target, NativeJobCatalogPart::NativeAttributes)
            .unwrap()
            .is_empty());
    }
}

#[test]
fn dameng_native_sections_keep_all_step_and_schedule_fields_and_real_runtime() {
    let target = NativeJobRef::DamengNative {
        scope: scheduler("Owner", "Job").scope().clone(),
        job_id: "9007199254740993".into(),
        name: "J'ob".into(),
    };
    let steps =
        native_job_catalog_queries(NativeJobCatalogDialect::Dameng, &target, NativeJobCatalogPart::Steps).unwrap();
    assert_eq!(
        steps[0].sql,
        "SELECT J.*, CAST(J.ID AS VARCHAR(40)) AS DBX_CHILD_ID FROM SYSJOB.SYSJOBSTEPS J WHERE J.JOBID = 9007199254740993 ORDER BY J.SEQNO, J.NAME"
    );
    assert_eq!(steps[1].source, "SYSJOB.USER_JOBSTEPS_VIEW");
    let schedules =
        native_job_catalog_queries(NativeJobCatalogDialect::Dameng, &target, NativeJobCatalogPart::Schedules).unwrap();
    assert_eq!(
        schedules[0].sql,
        "SELECT J.*, CAST(J.ID AS VARCHAR(40)) AS DBX_CHILD_ID FROM SYSJOB.SYSJOBSCHEDULES J WHERE J.JOBID = 9007199254740993 ORDER BY J.NAME"
    );
    let running =
        native_job_catalog_queries(NativeJobCatalogDialect::Dameng, &target, NativeJobCatalogPart::Running).unwrap();
    assert_eq!(running.len(), 1);
    assert_eq!(running[0].sql, "SELECT J.* FROM SYSJOB.DBA_JOBS_RUNNING J WHERE J.JOB = 9007199254740993");
}

#[test]
fn legacy_id_validation_precedes_query_building_and_keeps_log_priv_schema_distinct() {
    let scope = scheduler("Owner", "Job").scope().clone();
    let invalid = NativeJobRef::Legacy { scope: scope.clone(), job_id: "1 OR 1=1".into() };
    assert!(native_job_definition_queries(NativeJobCatalogDialect::Oracle, &invalid).is_err());
    let target = NativeJobRef::Legacy { scope, job_id: "9007199254740993".into() };
    let queries = native_job_definition_queries(NativeJobCatalogDialect::Oracle, &target).unwrap();
    assert_eq!(
        queries[0].sql,
        "SELECT J.*, TO_CHAR(J.JOB) AS DBX_JOB_ID FROM SYS.DBA_JOBS J WHERE J.JOB = 9007199254740993"
    );
    assert!(native_job_catalog_queries(NativeJobCatalogDialect::Oracle, &target, NativeJobCatalogPart::History)
        .unwrap()
        .is_empty());
}

#[test]
fn histories_are_ordered_newest_first_and_do_not_use_a_different_dialects_error_columns() {
    let target = scheduler("Owner", "Job");
    for dialect in
        [NativeJobCatalogDialect::Oracle, NativeJobCatalogDialect::OceanbaseOracle, NativeJobCatalogDialect::Dameng]
    {
        let queries = native_job_catalog_queries(dialect, &target, NativeJobCatalogPart::History).unwrap();
        assert!(queries[0].sql.ends_with("ORDER BY J.LOG_DATE DESC, J.LOG_ID DESC"));
        assert_eq!(queries[0].limit, 200);
        assert!(!queries[0].sql.contains("ERROR#"));
    }
}

#[test]
fn paged_lists_do_not_read_business_bodies_and_escape_search_metacharacters() {
    let queries = native_job_list_queries(
        NativeJobCatalogDialect::Oracle,
        NativeJobKind::Scheduler,
        Some("Owner"),
        "J%_!'ob",
        100,
        50,
    )
    .unwrap();
    let sql = &queries[0].sql;
    assert!(!sql.contains("JOB_ACTION"));
    assert!(sql.contains("J.OWNER = 'Owner'"));
    assert!(sql.contains("UPPER(J.JOB_NAME) LIKE UPPER('%J!%!_!!''ob%') ESCAPE '!'"));
    assert!(sql.contains("DBX_ROW_NUM > 100 AND DBX_ROW_NUM <= 151"));
    assert_eq!(queries[0].limit, 50);
    assert!(queries.last().unwrap().sql.contains("USER AS DBX_OWNER"));
    assert!(!queries.last().unwrap().sql.contains("J.OWNER"));
    assert!(native_job_list_queries(NativeJobCatalogDialect::Oracle, NativeJobKind::Legacy, None, "", 0, 501).is_err());
}

#[test]
fn dameng_native_list_can_identify_dbms_job_without_reading_or_duplicating_its_body() {
    let queries =
        native_job_list_queries(NativeJobCatalogDialect::Dameng, NativeJobKind::DamengNative, None, "", 0, 100)
            .unwrap();
    assert!(queries[0].sql.contains("CAST(J.ID AS VARCHAR(40)) AS DBX_JOB_ID"));
    assert!(queries[0].sql.contains("J.SYS_FLAG"));
    assert!(!queries[0].sql.contains("RUNNING"));
    let legacy =
        native_job_list_queries(NativeJobCatalogDialect::Dameng, NativeJobKind::Legacy, None, "", 0, 100).unwrap();
    assert!(legacy[0].sql.contains("J.SYS_FLAG = 2"));
}

#[test]
fn dameng_search_preserves_name_owner_and_description_matching_across_all_pages() {
    let queries = native_job_list_queries(
        NativeJobCatalogDialect::Dameng,
        NativeJobKind::DamengNative,
        Some("Owner"),
        "Ops%_'team",
        100,
        100,
    )
    .unwrap();
    for query in queries {
        assert!(query.sql.contains("J.USERNAME = 'Owner' AND (UPPER(J.NAME) LIKE"));
        assert!(query.sql.contains("OR UPPER(J.USERNAME) LIKE UPPER('%Ops!%!_''team%') ESCAPE '!'"));
        assert!(query.sql.contains("OR UPPER(J.DESCRIBE) LIKE UPPER('%Ops!%!_''team%') ESCAPE '!'"));
        assert!(query.sql.contains("DBX_ROW_NUM > 100 AND DBX_ROW_NUM <= 201"));
        assert!(!query.sql.contains("COMMAND"));
    }
}
