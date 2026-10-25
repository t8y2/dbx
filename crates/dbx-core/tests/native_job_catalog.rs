use dbx_core::schema::native_jobs::{read_native_job_catalog_part_with, NativeJobCatalogFailure};
use dbx_sql::native_jobs::{NativeJobCatalogDialect, NativeJobCatalogPart, NativeJobCatalogQuery};
use dbx_types::native_jobs::{NativeJobMetadata, NativeJobRef, NativeJobScope};
use serde_json::{json, Value};
use std::collections::VecDeque;

fn target() -> NativeJobRef {
    NativeJobRef::Scheduler {
        scope: NativeJobScope { connection_id: "connection".into(), database: "".into(), context_id: "context".into() },
        owner: "Owner".into(),
        name: "Job".into(),
    }
}

fn result(columns: &[&str], rows: Value) -> Value {
    json!({ "columns": columns, "rows": rows, "affected_rows": 0, "execution_time_ms": 1 })
}

fn no_query(_: NativeJobCatalogQuery) -> std::future::Ready<Result<Value, NativeJobCatalogFailure>> {
    panic!("must not query")
}

#[tokio::test]
async fn catalog_fallback_requires_visibility_failure_not_an_empty_result() {
    let mut calls = Vec::new();
    let section = read_native_job_catalog_part_with(
        NativeJobCatalogDialect::Oracle,
        &target(),
        NativeJobCatalogPart::Definition,
        |query| {
            calls.push(query.source);
            std::future::ready(Ok(result(&["OWNER", "JOB_NAME"], json!([]))))
        },
    )
    .await
    .unwrap();
    assert!(matches!(section.data, NativeJobMetadata::Empty));
    assert_eq!(calls, ["SYS.DBA_SCHEDULER_JOBS"]);
    assert_eq!(section.source, Some("SYS.DBA_SCHEDULER_JOBS"));
}

#[tokio::test]
async fn owned_fallback_preserves_values_and_reports_the_limited_source() {
    let mut responses = VecDeque::from([
        Err(NativeJobCatalogFailure::sql(NativeJobCatalogDialect::Oracle, Some(1031), None)),
        Err(NativeJobCatalogFailure::sql(NativeJobCatalogDialect::Oracle, Some(942), None)),
        Ok(result(
            &["DBX_OWNER", "JOB_NAME", "JOB_ACTION", "JOB_CLASS", "END_DATE"],
            json!([["Owner", "Job", "BEGIN work; END;", "custom_class", null]]),
        )),
    ]);
    let section = read_native_job_catalog_part_with(
        NativeJobCatalogDialect::Oracle,
        &target(),
        NativeJobCatalogPart::Definition,
        |_| std::future::ready(responses.pop_front().unwrap()),
    )
    .await
    .unwrap();
    assert_eq!(section.source, Some("SYS.USER_SCHEDULER_JOBS"));
    assert_eq!(section.failures.len(), 2);
    let NativeJobMetadata::Available { value } = section.data else { panic!("definition unavailable") };
    assert_eq!(value[0]["JOB_ACTION"], "BEGIN work; END;");
    assert_eq!(value[0]["JOB_CLASS"], "custom_class");
    assert_eq!(value[0]["END_DATE"], Value::Null);
}

#[tokio::test]
async fn unclassified_sql_errors_are_not_retried_as_catalog_absence() {
    let mut calls = 0;
    let section = read_native_job_catalog_part_with(
        NativeJobCatalogDialect::Oracle,
        &target(),
        NativeJobCatalogPart::Definition,
        |_| {
            calls += 1;
            std::future::ready(Err(NativeJobCatalogFailure::sql(NativeJobCatalogDialect::Oracle, Some(600), None)))
        },
    )
    .await
    .unwrap();
    assert_eq!(calls, 1);
    assert!(
        matches!(section.data, NativeJobMetadata::Error { reason } if reason == "native_job_catalog_query_failed:600")
    );
}

#[tokio::test]
async fn transport_failure_does_not_probe_other_sources() {
    let mut calls = 0;
    let section = read_native_job_catalog_part_with(
        NativeJobCatalogDialect::Oracle,
        &target(),
        NativeJobCatalogPart::Definition,
        |_| {
            calls += 1;
            std::future::ready(Err(NativeJobCatalogFailure::Timeout))
        },
    )
    .await
    .unwrap();
    assert_eq!(calls, 1);
    assert!(matches!(section.data, NativeJobMetadata::Error { reason } if reason == "native_job_catalog_timeout"));
}

#[tokio::test]
async fn execution_error_rows_are_not_a_successful_catalog_read() {
    let mut calls = 0;
    let section = read_native_job_catalog_part_with(
        NativeJobCatalogDialect::Oracle,
        &target(),
        NativeJobCatalogPart::Definition,
        |_| {
            calls += 1;
            let mut failed = result(&["Error"], json!([["sensitive SQL and argument value ORA-00942"]]));
            failed["execution_error"] = json!(true);
            std::future::ready(Ok(failed))
        },
    )
    .await
    .unwrap();
    assert_eq!(calls, 1);
    assert!(matches!(section.data, NativeJobMetadata::Error { reason } if reason == "native_job_catalog_query_failed"));
    // Native diagnostics, unlike arbitrary error text, can justify a visibility fallback.
    let mut failure = result(&[], json!([]));
    failure["execution_error"] = json!(true);
    failure["error"] = json!({ "diagnostics": { "category": "sql", "vendorCode": 1031 } });
    let mut responses = VecDeque::from([failure, result(&["OWNER", "JOB_NAME"], json!([["Owner", "Job"]]))]);
    let section = read_native_job_catalog_part_with(
        NativeJobCatalogDialect::Oracle,
        &target(),
        NativeJobCatalogPart::Definition,
        |_| std::future::ready(Ok(responses.pop_front().unwrap())),
    )
    .await
    .unwrap();
    assert!(matches!(section.data, NativeJobMetadata::Available { .. }));
    assert_eq!(section.failures.len(), 1);
}

#[tokio::test]
async fn jdbc_native_diagnostics_keep_connection_timeout_and_cancel_failures_out_of_visibility_fallback() {
    for (category, reason) in [
        ("connection", "native_job_catalog_transport_failed"),
        ("timeout", "native_job_catalog_timeout"),
        ("canceled", "native_job_catalog_canceled"),
    ] {
        let mut calls = 0;
        let section = read_native_job_catalog_part_with(
            NativeJobCatalogDialect::Oracle,
            &target(),
            NativeJobCatalogPart::Definition,
            |_| {
                calls += 1;
                std::future::ready(Ok(
                    json!({"execution_error":true,"error":{"diagnostics":{"category":category,"vendorCode":942}}}),
                ))
            },
        )
        .await
        .unwrap();
        assert_eq!(calls, 1);
        assert!(matches!(section.data, NativeJobMetadata::Error { reason: actual } if actual == reason));
    }
}

#[tokio::test]
async fn invalid_shape_duplicate_columns_and_a_different_target_cannot_become_a_baseline() {
    for response in [
        result(&["OWNER", "owner", "JOB_NAME"], json!([["Owner", "other", "Job"]])),
        result(&["OWNER", "JOB_NAME"], json!([["Owner"]])),
        result(&["OWNER", "JOB_NAME"], json!([["another-owner", "Job"]])),
        result(&["OWNER", "JOB_NAME"], json!([["Owner", "another-job"]])),
        result(&["OWNER", "JOB_NAME"], json!([["Owner", "Job"], ["Owner", "Job"]])),
        json!({}),
    ] {
        let mut calls = 0;
        let section = read_native_job_catalog_part_with(
            NativeJobCatalogDialect::Oracle,
            &target(),
            NativeJobCatalogPart::Definition,
            |_| {
                calls += 1;
                std::future::ready(Ok(response.clone()))
            },
        )
        .await
        .unwrap();
        assert!(matches!(section.data, NativeJobMetadata::Error { .. }));
        assert_eq!(calls, 1);
    }
}

#[tokio::test]
async fn selected_rows_keep_unsafe_integers_exact_and_mark_incomplete_reads() {
    let mut response = result(&["OWNER", "JOB_NAME", "INTERNAL_ID"], json!([["Owner", "Job", 9007199254740993_u64]]));
    response["has_more"] = json!(true);
    let section = read_native_job_catalog_part_with(
        NativeJobCatalogDialect::Oracle,
        &target(),
        NativeJobCatalogPart::Definition,
        |_| std::future::ready(Ok(response.clone())),
    )
    .await
    .unwrap();
    let NativeJobMetadata::Truncated { value, limit } = section.data else { panic!("incomplete read lost") };
    assert_eq!(limit, 1);
    assert_eq!(value[0]["INTERNAL_ID"], "9007199254740993");
}

#[tokio::test]
async fn legacy_id_is_a_string_and_does_not_relabel_its_three_users_as_owner() {
    let target = NativeJobRef::Legacy { scope: target().scope().clone(), job_id: "9007199254740993".into() };
    let response = result(
        &["DBX_JOB_ID", "LOG_USER", "PRIV_USER", "SCHEMA_USER"],
        json!([["9007199254740993", "login", "privileges", "parse_schema"]]),
    );
    let section = read_native_job_catalog_part_with(
        NativeJobCatalogDialect::Oracle,
        &target,
        NativeJobCatalogPart::Definition,
        |_| std::future::ready(Ok(response.clone())),
    )
    .await
    .unwrap();
    let NativeJobMetadata::Available { value } = section.data else { panic!("legacy unavailable") };
    assert_eq!(value[0]["LOG_USER"], "login");
    assert_eq!(value[0]["PRIV_USER"], "privileges");
    assert_eq!(value[0]["SCHEMA_USER"], "parse_schema");
    assert!(!value[0].contains_key("OWNER"));
}

#[tokio::test]
async fn invalid_identity_never_reaches_the_database_and_missing_history_is_not_faked() {
    let invalid = NativeJobRef::Legacy { scope: target().scope().clone(), job_id: "1;COMMIT".into() };
    let result = read_native_job_catalog_part_with(
        NativeJobCatalogDialect::Oracle,
        &invalid,
        NativeJobCatalogPart::Definition,
        no_query,
    )
    .await;
    assert!(result.is_err());
    let valid = NativeJobRef::Legacy { scope: target().scope().clone(), job_id: "1".into() };
    let section = read_native_job_catalog_part_with(
        NativeJobCatalogDialect::Oracle,
        &valid,
        NativeJobCatalogPart::History,
        no_query,
    )
    .await
    .unwrap();
    assert!(matches!(section.data, NativeJobMetadata::Unsupported { .. }));
}

#[tokio::test]
async fn generation_requires_a_real_positive_string_key_and_the_selected_legacy_id() {
    for response in [
        result(&["DBX_JOB_ID", "DBX_CREATED_AT"], json!([["0", "2026-10-20 20:00:00.000001"]])),
        result(&["DBX_JOB_ID", "DBX_CREATED_AT"], json!([[9007199254740993_u64, "2026-10-20 20:00:00.000001"]])),
        result(&["DBX_JOB_ID", "DBX_CREATED_AT"], json!([["123", null]])),
    ] {
        let section = read_native_job_catalog_part_with(
            NativeJobCatalogDialect::OceanbaseOracle,
            &target(),
            NativeJobCatalogPart::Generation,
            |_| std::future::ready(Ok(response.clone())),
        )
        .await
        .unwrap();
        assert!(matches!(section.data, NativeJobMetadata::Error { .. }));
    }
    let legacy = NativeJobRef::Legacy { scope: target().scope().clone(), job_id: "123".into() };
    let section = read_native_job_catalog_part_with(
        NativeJobCatalogDialect::Oracle,
        &legacy,
        NativeJobCatalogPart::Generation,
        |_| std::future::ready(Ok(result(&["DBX_JOB_ID"], json!([["124"]])))),
    )
    .await
    .unwrap();
    assert!(matches!(section.data, NativeJobMetadata::Error { .. }));
}
